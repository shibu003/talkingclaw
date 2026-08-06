// 会話OS / 音声平面（設計: docs/kaiwa-os-design.md §4.1, §4.3, §4.8）
//
// ここに置くのは「発話の音声側」に関わる機構だけ。テキスト平面（EventStore への append）は
// roomcore.ts が持つ。両者を分けているのが二平面発話の骨格 —
// テキストは append-only で失われないが、音声は失効しうるリースである。
//
// C1 の抽出方針: 挙動を変えない。room.ts にあった実装をそのまま移し、依存は注入する。
// 依存は一方向（convos → roomcore / voice / 注入された関数）で、room.ts を import しない。

import { type Channel, type EventStore, type Registry } from '../roomcore.ts';
import { type Voice, splitSentences } from '../voice.ts';

// ---- UserSpeechState: 「ユーザーが今話しているか」の単一の状態源（§4.8）----
// ブラウザの STT interim 結果を /speech-state で報告させて保持する。AI 側の音声出力
// （TtsScheduler の pump / filler escalation）はこれを見て、ユーザーが話し終わるまで先に進めない。
// マイクの状態は部屋のグローバル資源であり、状態源を 2 つ持たないことがこの型の存在理由。
// client からの更新が途切れても staleMs で自動解除する（更新が来なくなった時の deadlock 防止）。
export class UserSpeechState {
  #speaking = false;
  #at = 0;
  readonly #staleMs: number;

  constructor(staleMs = 4_000) {
    this.#staleMs = staleMs;
  }

  // client からの報告。戻り値は「話し中 → 話し終わり」に変わったかどうか。
  // 呼び側はこれを確定バッファの flush の起点に使う
  report(speaking: boolean): boolean {
    const ended = this.#speaking && !speaking;
    this.#speaking = speaking;
    this.#at = Date.now();
    return ended;
  }

  // 発話がテキストとして確定した = この turn の「発話中」は終了。
  // client からの false 通知の到着順に依存しないよう、確定側からも倒せるようにしている
  clear(): void {
    this.#speaking = false;
  }

  get active(): boolean {
    return this.#speaking && Date.now() - this.#at < this.#staleMs;
  }

  waitUntilDone(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.active) return resolve();
        setTimeout(check, 200);
      };
      check();
    });
  }
}

// onReady: 事前合成(ack-pool)が出来上がった時の置き場。スケジューラは置き場を知らない
// （以前は pid の文字列プレフィックスを見て判定していた — C1-①b で切った）。
type SynthJobBase = {
  pid: string;
  priority: 1 | 2 | 3;
  text: string;
  speaker?: number;
  turnId?: string;
  channel: Channel;
};
export type SynthJob =
  | (SynthJobBase & { kind: 'speech'; revision: number; onReady?: never })
  | (SynthJobBase & { kind: 'ack-pool'; revision?: never; onReady?: (url: string) => void });

// filler の 1 回分。事前合成が間に合っていなければ audio は null（テキストだけ流れる）
export type FillerCue = { text: string; audio: string | null };

export type SpeechDeps = {
  store: EventStore;
  registry: Registry;
  voice: Voice;
  putAudio: (wav: Buffer, isProtected: boolean) => string;
  // エンジンの生死は EngineManager が決める。ここは読むだけ・報告するだけ（C1-①c）
  isEngineReady: () => boolean;
  reportSynthResult: (ok: boolean) => boolean;
  resolveVoice: (requested: string) => Promise<number | null>;
  metric: (kind: string, extra?: Record<string, unknown>) => void;
  turnChannel: (turnId: string | undefined) => Channel;
  userSpeech: UserSpeechState;
};

// ---- SpeechPlane: TtsScheduler(S5) + FillerEngine(S6) ----
// 元は room.ts の別セクションだったが、合成キューと相槌プールは互いの状態を触るので
// 1 つの部品にまとめた。外から見えるのは「積む・喋らせる・相槌を撃つ・プールを作る」だけ。
//
// TtsScheduler: participant 内 FIFO、participant 間は (priority, round-robin)。
// stale drop: user 発話ごとに channel revision を進め、旧 revision の speech job は
// EventStore にも音声 queue にも出さない。既に表示済みの append-only log だけが残る。
//
// FillerEngine: 相槌は事前合成プールのみ。動的合成は本応答だけ。
export class SpeechPlane {
  // filler の状態
  static readonly ACK_TEXTS = ['ん、見てみるね。', 'うん、ちょっと待ってて。', 'はーい、確認するね。'];
  static readonly CONTEXT_TEXTS = ['ん、いま考えてるところ。', 'ちょっと確認してるね。'];
  // ナレーション(未達通知・状況報告)= まお/ノーマル固定(S6)。engineReady で合成
  static readonly NARRATION_TEXTS = {
    undelivered: '呼んだ相手は今手が離せないみたい。届いたら読んでもらうね',
    status: 'まだ作業中みたい。もう少し待ってね',
  } as const;

  #ackPools = new Map<string, string[]>();
  #ackRotate = 0;
  #lastAckAt = new Map<string, number>(); // 実機フィードバック: 相槌の連発防止
  #narrationAudio = new Map<string, string>(); // key → /audio path
  #narrationPool: string[] = []; // 後方互換(未達通知 = undelivered)
  #contextPools = new Map<string, string[]>();

  // スケジューラの状態
  #revisions = new Map<Channel, number>();
  #jobQueues = new Map<string, SynthJob[]>();
  #rrOrder: string[] = [];
  #pumping = false;

  readonly #d: SpeechDeps;

  constructor(deps: SpeechDeps) {
    this.#d = deps;
  }

  // 合成中かどうか。EngineManager が「ビジーなだけの生きたエンジンを殺さない」判定に使う
  get busy(): boolean {
    return this.#pumping;
  }

  revision(channel: Channel): number {
    return this.#revisions.get(channel) ?? 0;
  }

  // channel ごとの user 発話で世代を進める。他の部屋の音声は失効させない。
  advanceRevision(channel: Channel): number {
    const next = this.revision(channel) + 1;
    this.#revisions.set(channel, next);
    return next;
  }

  // ---- filler ----

  buildNarrationPool(): void {
    if (this.#narrationAudio.size > 0) return;
    void this.#d.resolveVoice('まお/ノーマル').then((speaker) => {
      if (speaker === null) return;
      for (const [key, text] of Object.entries(SpeechPlane.NARRATION_TEXTS)) {
        this.enqueue({
          pid: `__narration_${key}__`, priority: 3, kind: 'ack-pool', text, speaker, channel: 'work', // ack-pool は事前合成のみ・channel は不使用
          onReady: (url) => {
            this.#narrationAudio.set(key, url);
            if (key === 'undelivered') this.#narrationPool.push(url);
          },
        });
      }
    });
  }

  buildAckPool(pid: string, speaker: number): void {
    if (this.#ackPools.has(pid)) return;
    this.#ackPools.set(pid, []);
    // ack-pool は事前合成のみ・channel は不使用
    for (const text of SpeechPlane.ACK_TEXTS) {
      this.enqueue({
        pid, priority: 3, kind: 'ack-pool', text, speaker, channel: 'work',
        onReady: (url) => { this.#ackPools.get(pid)?.push(url); },
      });
    }
    for (const text of SpeechPlane.CONTEXT_TEXTS) {
      this.enqueue({
        pid: `__context_${pid}__`, priority: 3, kind: 'ack-pool', text, speaker, channel: 'work',
        onReady: (url) => {
          const pool = this.#contextPools.get(pid) ?? [];
          pool.push(url);
          this.#contextPools.set(pid, pool);
        },
      });
    }
  }

  // t=0 の相槌（LLM を経由しない。事前合成プールから即再生）
  fireAck(target: string, turnId: string | undefined, utterance = ''): void {
    const p = this.#d.registry.get(target);
    const pool = this.#ackPools.get(target) ?? [];
    if (!p || !this.#d.registry.alive(p)) return; // gone の相手の声で相槌しない(偽生存の防止)
    if (p.voice.status !== 'ready' || pool.length === 0 || !this.#d.isEngineReady()) return;
    if (utterance.length <= 4) return; // 「はい」等の短い発話に相槌は不要
    if (Date.now() - (this.#lastAckAt.get(target) ?? 0) < 8_000) return; // 連発防止
    this.#lastAckAt.set(target, Date.now());
    this.#ackRotate += 1 + Math.floor(Math.random() * SpeechPlane.ACK_TEXTS.length); // 機械的ローテを崩す
    const text = SpeechPlane.ACK_TEXTS[this.#ackRotate % SpeechPlane.ACK_TEXTS.length];
    const audio = pool[this.#ackRotate % pool.length];
    const ackEv = this.#d.store.append({
      type: 'agent_speech', from: target, name: p.assignedName, text, audio,
      filler: 'ack', turnId, channel: this.#d.turnChannel(turnId),
    });
    this.#d.metric('ack_emitted', { turnId, eventId: ackEv.id });
  }

  // escalation（②の範囲）が読む口。プールの中身を外に見せないための cue 返し
  contextCue(pid: string, rotate: number): FillerCue {
    const pool = this.#contextPools.get(pid) ?? [];
    return {
      text: SpeechPlane.CONTEXT_TEXTS[rotate % SpeechPlane.CONTEXT_TEXTS.length],
      audio: pool[rotate % Math.max(1, pool.length)] ?? null,
    };
  }

  statusCue(): FillerCue {
    return { text: SpeechPlane.NARRATION_TEXTS.status, audio: this.#narrationAudio.get('status') ?? null };
  }

  undeliveredCue(): FillerCue {
    return { text: SpeechPlane.NARRATION_TEXTS.undelivered, audio: this.#narrationPool[0] ?? null };
  }

  // ---- スケジューラ ----

  enqueue(job: SynthJob): void {
    const q = this.#jobQueues.get(job.pid) ?? [];
    if (job.kind === 'speech' && q.filter((j) => j.kind === 'speech').length >= 20) {
      if (!this.#isCurrent(job)) return;
      const p = this.#d.registry.get(job.pid);
      this.#d.store.append({
        type: 'agent_speech', from: job.pid, name: p?.assignedName, text: job.text,
        audio: null, turnId: job.turnId, channel: job.channel,
      });
      return; // per-participant 上限: 古い順でなく新規を text-only(FIFO 順序を保つ)
    }
    // priority inversion 防止: pickNext はキュー先頭しか見ないので、speech を先頭の ack-pool 群より
    // 前に差し込む(でないと再起動直後、本発話が自分のプール事前合成の後ろで数分待たされる)。
    // speech 同士の FIFO と ack-pool 同士の順序はどちらも保たれる
    const poolIdx = job.kind === 'speech' ? q.findIndex((j) => j.kind === 'ack-pool') : -1;
    if (poolIdx >= 0) q.splice(poolIdx, 0, job);
    else q.push(job);
    this.#jobQueues.set(job.pid, q);
    if (!this.#rrOrder.includes(job.pid)) this.#rrOrder.push(job.pid);
    void this.#pump();
  }

  speakSentences(from: string, name: string, text: string, turnId: string | undefined, channel: Channel): void {
    const sentences = splitSentences(text);
    sentences.forEach((sentence, i) => {
      this.enqueue({ pid: from, priority: i === 0 ? 1 : 2, kind: 'speech', text: sentence, turnId, revision: this.revision(channel), channel });
    });
  }

  #isCurrent(job: SynthJob): boolean {
    return job.kind !== 'speech' || job.revision === this.revision(job.channel);
  }

  #pickNext(): SynthJob | null {
    let best: { pid: string; prio: number } | null = null;
    for (const pid of this.#rrOrder) {
      const head = this.#jobQueues.get(pid)?.[0];
      if (!head) continue;
      if (!best || head.priority < best.prio) best = { pid, prio: head.priority };
    }
    if (!best) return null;
    this.#rrOrder.push(...this.#rrOrder.splice(this.#rrOrder.indexOf(best.pid), 1)); // 使った participant を末尾へ(round-robin)
    return this.#jobQueues.get(best.pid)!.shift()!;
  }

  async #runJob(job: SynthJob): Promise<void> {
    const p = this.#d.registry.get(job.pid);
    const speaker = job.speaker ?? p?.voice.resolvedSpeaker ?? null;
    const emitSpeech = (audio: string | null): void => {
      if (job.kind === 'speech' && this.#isCurrent(job)) {
        this.#d.store.append({
          type: 'agent_speech', from: job.pid, name: p?.assignedName, text: job.text,
          audio, turnId: job.turnId, channel: job.channel,
        });
      }
    };
    // 合成前と emit 直前の二重照合。旧 turn は text-only にもせず完全に失効させる。
    if (!this.#isCurrent(job)) return;
    if (!this.#d.isEngineReady() || speaker === null) return emitSpeech(null); // S3: 未解決/down は即 text-only
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const wav = await this.#d.voice.synthesizeWav(job.text, speaker);
        this.#d.reportSynthResult(true);
        if (!this.#isCurrent(job)) return;
        if (!wav) return emitSpeech(null);
        const url = this.#d.putAudio(wav, job.kind === 'ack-pool');
        if (job.kind === 'ack-pool') job.onReady?.(url); // 置き場はジョブを作った側が知っている
        else {
          if (!this.#isCurrent(job)) return;
          if (job.turnId && job.turnId !== 'none') this.#d.metric('tts_ready', { turnId: job.turnId, path: 'room' });
          emitSpeech(url);
        }
        return;
      } catch (error) {
        // 数えるのも倒すのも告知するのも EngineManager 側。ここは報告して結果に従うだけ
        if (this.#d.reportSynthResult(false)) return emitSpeech(null);
        if (attempt === 1) {
          console.error(`合成失敗(text-only): ${(error as Error).message}`);
          return emitSpeech(null);
        }
      }
    }
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const job = this.#pickNext();
        if (!job) break;
        await this.#d.userSpeech.waitUntilDone(); // ユーザー発話中は AI 側の音声(本応答・filler 問わず)を先に進めない
        await this.#runJob(job);
      }
    } finally {
      this.#pumping = false;
    }
  }
}
