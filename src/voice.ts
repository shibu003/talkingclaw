import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ---- PBI-007: クラウド合成(第一候補)とローカル AivisSpeech(fallback)----
// Fish Audio の無料モデル。**この値以外は絶対に送らない** — 省略や別名を送ると有料の
// s2.1-pro に静かに切り替わる(公式仕様)ので、送信直前に不変条件を検査して落とす。
export const FISH_MODEL_FREE = 's2.1-pro-free';
export type TtsProvider = 'fish' | 'aivis-cloud' | 'local';

// fallback 状態機械の固定値(PBI-007 AC-4)。cooldown 中はクラウドへ 1 リクエストも出さない。
const CLOUD_TIMEOUT_MS = 4_000;        // T: 1 リクエストの打ち切り
const CLOUD_RETRY_DELAY_MS = 500;      // R: 429 / 5xx のときだけ 1 回だけ待って再送
const COOLDOWN_TRANSIENT_MS = 30_000;  // 429・5xx・無応答・通信断
const COOLDOWN_REQUEST_MS = 60_000;    // 400・404 など「こちらの要求が悪い」系
const COOLDOWN_AUTH_MS = 600_000;      // 401・402・403(キー / 残高 / 権限。無料枠終了もここに出る)

// 時計は差し替え可能にしておく(検査で cooldown と retry を実時間なしで回すため)
export type VoiceClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutSignal: (ms: number) => AbortSignal;
};
const REAL_CLOCK: VoiceClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};

export type FishConfig = {
  apiKey?: string;
  base?: string;
  referenceId?: string;
  maxConcurrent?: number;
  // 壊れた build / config を再現するための注入口。既定は FISH_MODEL_FREE。
  // これ以外の値だと 1 リクエストも送らずローカルへ落ちる(AC-8 fail-closed)
  model?: string;
};

// ---- PBI-008: 選択した声の snapshot ----
// turn 生成時に固定し、その turn の全 job が同じ値で合成する(AC-6: 同一返答の途中で声が混ざらない)。
// **null = 選択なし = PBI-007 の既定挙動そのまま**。AC-11「voice.json 未作成時は完全に不変」は
// この分岐で担保する — snapshot が無ければ下の合成経路は 1 行も変わらない。
export type VoiceSnapshot =
  | { provider: 'fish'; referenceId: string }
  | { provider: 'local'; speakerId: number };

// 試聴の結果。通常会話と違い「失敗したらローカルで代替」をしない(AC-9b: 別の声を
// 候補の声と誤認させないため)ので、呼び側が文字で理由を出せるように status も返す。
export type PreviewResult = { wav?: Buffer; status?: number; reason: string };

// AivisSpeech でアニメ声を合成して afplay で再生する「声」担当。
// 文単位に分割し、文 N の再生中に文 N+1 を合成するパイプラインで体感遅延を下げる。
export class Voice {
  #url: string;
  #speaker: number;
  #speedScale: number;
  #enginePath: string;
  #tmpDir: string | null = null;
  #player: ChildProcess | null = null;
  #playQueue: Promise<void> = Promise.resolve();
  #generation = 0;
  #fileSeq = 0;

  // クラウド合成の状態(PBI-007)
  #provider: TtsProvider;
  #fish: FishConfig;
  #clock: VoiceClock;
  #cooldownUntil = 0;
  #probeOnly = false;           // cooldown 明けの 1 回目は retry せず 1 リクエストだけ試す
  #inflight = 0;
  #slotWaiters: (() => void)[] = [];
  #previewWaiters: (() => void)[] = []; // PBI-008 AC-5: 会話より後ろに並ぶ試聴専用の待ち行列
  #warned = new Set<string>();
  #lastUsed: TtsProvider | null = null;
  #billingRisk = 0;
  #cloudFailures = 0;

  constructor(opts: {
    url: string; speaker: number; speedScale: number; enginePath: string;
    provider?: TtsProvider; fish?: FishConfig; clock?: VoiceClock;
  }) {
    this.#url = opts.url;
    this.#speaker = opts.speaker;
    this.#speedScale = opts.speedScale;
    this.#enginePath = opts.enginePath;
    this.#provider = opts.provider ?? 'local';
    this.#fish = opts.fish ?? {};
    this.#clock = opts.clock ?? REAL_CLOCK;
  }

  // 部屋の EngineManager が「声を出せるか」を判断するために読む。ローカル engine が
  // 落ちていても・冷えていても、クラウドが生きていれば声は出せる。
  get cloudReady(): boolean {
    return this.#provider === 'fish'
      && !!this.#fish.apiKey
      && (this.#fish.model ?? FISH_MODEL_FREE) === FISH_MODEL_FREE
      && this.#clock.now() >= this.#cooldownUntil;
  }

  // 直前の 1 合成を実際にどれで作ったか(metrics の tts 軸 = AC-10)。
  // 合成キューは直列なので、合成直後に読めばその turn の値になる。
  get lastUsed(): TtsProvider | null {
    return this.#lastUsed;
  }

  // 観測用(検査と、必要なら画面表示)。API キーは含めない
  get diag(): { provider: TtsProvider; lastUsed: TtsProvider | null; cooldownUntil: number; billingRisk: number; cloudFailures: number } {
    return {
      provider: this.#provider, lastUsed: this.#lastUsed, cooldownUntil: this.#cooldownUntil,
      billingRisk: this.#billingRisk, cloudFailures: this.#cloudFailures,
    };
  }

  // engine 疎通確認。落ちていたら同梱バイナリから自動起動して立ち上がりを待つ。
  async ensureEngine(): Promise<string> {
    const version = await this.#fetchVersion();
    if (version !== null) return version;

    if (!existsSync(this.#enginePath)) {
      throw new Error(
        `AivisSpeech Engine に接続できません (${this.#url})。` +
          `engine が見つかりません: ${this.#enginePath}\n` +
          'https://github.com/Aivis-Project/AivisSpeech-Engine/releases から macOS 版を engine/ に展開してください。',
      );
    }

    // MCP モードでは stdout が protocol 専用なのでログは stderr へ
    console.error('AivisSpeech Engine を起動しています…(音声モデルの読み込みに数十秒かかります)');
    spawn(this.#enginePath, [], {
      cwd: dirname(this.#enginePath),
      detached: true,
      stdio: 'ignore',
      // ローカルに無効な HuggingFace token があると BERT モデル取得が 401 で落ちるため、
      // 公開 repo に token を送らない設定で起動する
      env: { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_TOKEN: '' },
    }).unref();

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const v = await this.#fetchVersion();
      if (v !== null) return v;
    }
    throw new Error(
      `AivisSpeech Engine が起動しませんでした (${this.#url})。手動起動で原因を確認してください: ${this.#enginePath}`,
    );
  }

  async #fetchVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${this.#url}/version`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      return (await res.json()) as string;
    } catch {
      return null;
    }
  }

  // 1 文を WAV に合成して返す(ブラウザ再生用)。読み上げるものが無ければ null。
  // speaker を渡すと既定の声を上書きできる(agent ごとに声を変える用)。
  // snapshot を渡すと provider / 声も含めてその turn の確定値で合成する(PBI-008 AC-6)。
  async synthesizeWav(text: string, speaker?: number, snapshot: VoiceSnapshot | null = null): Promise<Buffer | null> {
    const speakable = stripForSpeech(text);
    if (!speakable) return null;
    return this.#synthesize(speakable, speaker, snapshot);
  }

  // 文をキューに積む。合成は即座に始まり、再生はキュー順。途中で stop() されたら破棄。
  enqueue(sentence: string): void {
    const gen = this.#generation;
    for (const chunk of splitSentences(stripForSpeech(sentence))) {
      const synthesis = this.#synthesize(chunk);
      // 再生キューが await する前に reject すると unhandledRejection でプロセスが落ちるため、
      // 先にハンドラを付けておく(実際のエラー処理はキュー側の catch)
      synthesis.catch(() => {});
      this.#playQueue = this.#playQueue
        .then(async () => {
          const wav = await synthesis;
          if (gen !== this.#generation) return;
          await this.#play(wav, gen);
        })
        .catch((error: unknown) => {
          // 1 文の失敗で以降のキューを殺さない(テキストは画面に出ている)
          console.error(`音声合成エラー: ${(error as Error).message}`);
        });
    }
  }

  // キューに積んだ音声の再生完了を待つ。合成/再生の失敗はここで表面化させず握る。
  async waitIdle(): Promise<void> {
    await this.#playQueue.catch(() => {});
  }

  // テキスト全体を読み上げて再生完了まで待つ。
  async speak(text: string): Promise<void> {
    this.enqueue(text);
    await this.waitIdle();
  }

  stop(): void {
    this.#generation++;
    this.#playQueue = Promise.resolve();
    if (this.#player) {
      this.#player.kill('SIGKILL');
      this.#player = null;
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    if (this.#tmpDir) await rm(this.#tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 第一候補はクラウド、駄目なら必ずローカル。ここが「部屋が沈黙しない」の本体(PBI-007 AC-3)。
  async #synthesize(text: string, speaker = this.#speaker, snapshot: VoiceSnapshot | null = null): Promise<Buffer> {
    const cloud = await this.#synthesizeCloud(text, snapshot);
    if (cloud) {
      this.#lastUsed = 'fish'; // cloud が非 null になるのは fish 経路だけ(下の分岐)
      return cloud;
    }
    // AC-7: local を選んだ turn はその話者で合成する。Fish 選択の合成失敗は
    // PBI-007 の規則どおり既定のローカル声へ落ちる(AC-9d: desired は voiceswitch 側が保持)
    const wav = await this.#synthesizeLocal(text, snapshot?.provider === 'local' ? snapshot.speakerId : speaker);
    this.#lastUsed = 'local';
    return wav;
  }

  // 戻り値 null = 「クラウドは使わない / 今は使えない」= 呼び側がローカルへ回す。
  // ここからは throw しない — クラウドの不調でローカル fallback を潰さないため。
  async #synthesizeCloud(text: string, snapshot: VoiceSnapshot | null = null): Promise<Buffer | null> {
    // snapshot 有り = この turn の声は確定済み。無い時だけ既定 provider を見る(AC-11 の不変条件)
    if (snapshot) {
      if (snapshot.provider !== 'fish') return null; // local 選択は Fish へ 1 リクエストも出さない(AC-7)
    } else {
      if (this.#provider === 'aivis-cloud') {
        // PBI-006 が入るまでは接続もしない(AC-2b: 1 回だけ記録してローカルへ)
        this.#warnOnce('aivis-cloud', 'aivis-cloud unavailable(PBI-006 未実装)。ローカル合成に切り替える');
        return null;
      }
      if (this.#provider !== 'fish') return null; // local と未知の値は全部ローカル(fail-safe)
    }
    if (!this.#fish.apiKey) {
      this.#warnOnce('fish-nokey', 'FISH_API_KEY が無いのでローカル合成を使う');
      return null;
    }
    if (this.#clock.now() < this.#cooldownUntil) return null; // cooldown 中は 1 リクエストも出さない

    const headers = this.#fishHeaders();
    if (!headers) return null; // fail-closed(AC-8)。理由と課金カウンタは #fishHeaders 側

    const referenceId = snapshot?.provider === 'fish' ? snapshot.referenceId : this.#fish.referenceId;
    const body = JSON.stringify({
      text,
      format: 'wav',        // 007-F2: putAudio / GET /audio/:id の audio/wav 契約を維持する
      latency: 'normal',
      normalize: true,
      chunk_length: 300,
      prosody: { speed: this.#speedScale, volume: 0, normalize_loudness: true },
      ...(referenceId ? { reference_id: referenceId } : {}),
    });
    const url = this.#fishUrl();
    const allowRetry = !this.#probeOnly;
    this.#probeOnly = false;

    await this.#acquireSlot(); // Fish の制限は同時実行数(Starter = 5)
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await this.#fishOnce(url, headers, body);
        if (r.wav) {
          this.#cooldownUntil = 0;
          return r.wav;
        }
        if (r.retriable && allowRetry && attempt === 0) {
          await this.#clock.sleep(CLOUD_RETRY_DELAY_MS);
          continue;
        }
        this.#cloudFailures++;
        this.#cooldownUntil = this.#clock.now() + r.cooldownMs;
        this.#probeOnly = true; // 解除後の 1 回目は probe(1 リクエストだけ)
        console.error(`Fish 合成に失敗(${r.reason})。${Math.round(r.cooldownMs / 1000)}s はローカル合成に切り替える`);
        return null;
      }
    } finally {
      this.#releaseSlot();
    }
  }

  // ---- PBI-008: 試聴(通常会話とは分ける)----
  // 分ける理由は 3 つ: retry 0 / cooldown を読みも書きもしない(AC-9b: 試聴の 404 で会話が
  // 巻き添えでローカルに落ちない)/ 失敗をローカル合成で代替しない(AC-9b: 別の声を候補の声と
  // 誤認させない)。送信前の model 検査だけは通常会話とまったく同じものを通す(AC-4 fail-closed)。
  async previewFish(referenceId: string, text: string): Promise<PreviewResult> {
    if (!this.#fish.apiKey) return { reason: 'Fish のキーが設定されていない' };
    const headers = this.#fishHeaders();
    if (!headers) return { reason: `課金危険のため送信しなかった(model が ${FISH_MODEL_FREE} ではない)` };

    const body = JSON.stringify({
      text,
      format: 'wav',
      latency: 'normal',
      normalize: true,
      chunk_length: 300,
      prosody: { speed: this.#speedScale, volume: 0, normalize_loudness: true },
      reference_id: referenceId,
    });
    await this.#acquireSlot('preview');
    try {
      const r = await this.#fishOnce(this.#fishUrl(), headers, body); // retry 0(1 回だけ)
      // cooldownUntil / probeOnly / cloudFailures には触らない = 通常会話の状態機械を汚さない
      return r.wav ? { wav: r.wav, reason: 'ok' } : { status: r.status, reason: r.reason };
    } finally {
      this.#releaseSlot();
    }
  }

  // ローカル話者の試聴。**#lastUsed(metrics の tts 軸)を動かさない** — 試聴は turn ではないので、
  // ここを synthesizeWav で済ませると turn metrics に試聴の痕跡が混ざる(AC-5「0 件」に反する)。
  async previewLocal(text: string, speaker: number): Promise<Buffer | null> {
    const speakable = stripForSpeech(text);
    if (!speakable) return null;
    return this.#synthesizeLocal(speakable, speaker);
  }

  // Fish へ実際に送る header。model の不変条件はここ 1 箇所で守る(通常会話も試聴も同じ門を通る)。
  // null = 送ってはいけない。
  #fishHeaders(): Record<string, string> | null {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#fish.apiKey}`,
      'content-type': 'application/json',
      // Fish はモデルを body ではなく header で選ぶ。欠落・別名は有料モデルへの静かな切替になる
      model: this.#fish.model ?? FISH_MODEL_FREE,
    };
    // fail-closed(AC-8): 実際に送る値そのものを検査する。違っていたら 1 リクエストも出さない
    if (headers.model !== FISH_MODEL_FREE) {
      if (this.#warnOnce('fish-model', `課金危険: Fish の model が ${JSON.stringify(headers.model)} になっている(${FISH_MODEL_FREE} 以外は有料)。リクエストを送らずローカル合成に切り替えた`)) {
        this.#billingRisk++;
      }
      return null;
    }
    return headers;
  }

  #fishUrl(): string {
    return `${(this.#fish.base ?? 'https://api.fish.audio').replace(/\/+$/, '')}/v1/tts`;
  }

  // 1 リクエストぶん。成功なら wav、失敗なら「再送してよいか」と cooldown の長さを返す
  async #fishOnce(url: string, headers: Record<string, string>, body: string): Promise<{ wav?: Buffer; retriable: boolean; cooldownMs: number; reason: string; status?: number }> {
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: this.#clock.timeoutSignal(CLOUD_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {}); // 本文は使わない(放置すると接続が浮く。上流 error body を持ち出さない = AC-3)
        const retriable = res.status === 429 || res.status >= 500;
        const cooldownMs = retriable ? COOLDOWN_TRANSIENT_MS
          : res.status === 401 || res.status === 402 || res.status === 403 ? COOLDOWN_AUTH_MS
            : COOLDOWN_REQUEST_MS;
        return { retriable, cooldownMs, reason: `HTTP ${res.status}`, status: res.status };
      }
      const wav = repairWav(Buffer.from(await res.arrayBuffer()));
      if (!wav) return { retriable: false, cooldownMs: COOLDOWN_REQUEST_MS, reason: 'WAV ではない応答' };
      return { wav, retriable: false, cooldownMs: 0, reason: 'ok' };
    } catch (error) {
      // 無応答(T で打ち切り)・通信断。retry せずローカルへ(AC-4)
      const name = (error as Error).name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      return {
        retriable: false,
        cooldownMs: COOLDOWN_TRANSIENT_MS,
        reason: timedOut ? `無応答 ${CLOUD_TIMEOUT_MS / 1000}s で打ち切り` : `通信失敗: ${(error as Error).message}`,
      };
    }
  }

  // 同時実行の上限。待たせるだけで捨てない(相槌プールの事前合成が並んでも 5 を超えない)。
  // PBI-008 AC-5: 試聴は上限を 1 つ低く見る = **会話用の slot を常に 1 つ残す**。
  async #acquireSlot(kind: 'speech' | 'preview' = 'speech'): Promise<void> {
    const max = this.#fish.maxConcurrent ?? 5;
    const limit = kind === 'preview' ? Math.max(1, max - 1) : max;
    while (this.#inflight >= limit) {
      await new Promise<void>((resolve) => (kind === 'preview' ? this.#previewWaiters : this.#slotWaiters).push(resolve));
    }
    this.#inflight++;
  }

  #releaseSlot(): void {
    this.#inflight--;
    // 待っている者がいるなら会話が先。試聴は会話の待ち行列が空いてから(AC-5)
    (this.#slotWaiters.shift() ?? this.#previewWaiters.shift())?.();
  }

  // 同じ知らせを毎ターン出さない。実際に出した時だけ true
  #warnOnce(key: string, message: string): boolean {
    if (this.#warned.has(key)) return false;
    this.#warned.add(key);
    console.error(message);
    return true;
  }

  async #synthesizeLocal(text: string, speaker = this.#speaker): Promise<Buffer> {
    // timeout 必須: 応答しない request を待ち続けると直列 pump 全体が巻き添えで停止する
    // (以降の合成が一切走らない)。abort → 呼び出し側の retry / text-only 経路へ。
    // synthesis の上限はモデル cold load 実測 83s × 1.8(短くすると初回合成を殺してフラッピングする)
    const params = new URLSearchParams({ text, speaker: String(speaker) });
    // audio_query も cold load を踏む(モデル load はここで起きる)。15s だと起動直後の
    // 初回発話が必ず abort し、3 連続で engineState='down' に倒れて「声が出せない」になる。
    // synthesis と同じ上限にする(cold load 実測 83s × 1.8)
    const queryRes = await fetch(`${this.#url}/audio_query?${params}`, { method: 'POST', signal: AbortSignal.timeout(150_000) });
    if (!queryRes.ok) throw new Error(`AivisSpeech audio_query が失敗しました (${queryRes.status})`);
    const audioQuery = (await queryRes.json()) as { speedScale: number };
    audioQuery.speedScale = this.#speedScale;

    const synthRes = await fetch(`${this.#url}/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(audioQuery),
      signal: AbortSignal.timeout(150_000),
    });
    if (!synthRes.ok) throw new Error(`AivisSpeech synthesis が失敗しました (${synthRes.status})`);
    return Buffer.from(await synthRes.arrayBuffer());
  }

  async #play(wav: Buffer, gen: number): Promise<void> {
    if (!this.#tmpDir) this.#tmpDir = await mkdtemp(join(tmpdir(), 'talkingclaw-'));
    const path = join(this.#tmpDir, `${this.#fileSeq++}.wav`);
    await writeFile(path, wav);
    if (gen !== this.#generation) return;

    await new Promise<void>((resolve) => {
      const player = spawn('afplay', [path], { stdio: 'ignore' });
      this.#player = player;
      player.on('close', () => {
        if (this.#player === player) this.#player = null;
        resolve();
      });
      player.on('error', () => resolve());
    });
  }
}

// ストリーミング配信の WAV は RIFF / data のサイズ欄が 0 のまま届くことがある(streaming TTS の
// 定番の罠。放置すると afplay や厳密なデコーダが無音・再生失敗になる)。実バイト数で書き直す。
// WAV でなければ null を返す = 呼び側がローカル合成へ回す。
export function repairWav(buf: Buffer): Buffer | null {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  const out = Buffer.from(buf);
  if (out.readUInt32LE(4) !== out.length - 8) out.writeUInt32LE(out.length - 8, 4);
  let p = 12;
  while (p + 8 <= out.length) {
    const id = out.toString('latin1', p, p + 4);
    const size = out.readUInt32LE(p + 4);
    if (id === 'data') {
      const actual = out.length - (p + 8);
      if (size === 0 || size > actual) out.writeUInt32LE(actual, p + 4);
      return out;
    }
    if (size <= 0 || p + 8 + size > out.length) return out; // これ以上チャンクを辿れない
    p += 8 + size + (size % 2); // チャンクは偶数境界
  }
  return out;
}

// 読み上げに不向きな記号・コードを落とす(persona 側でも禁止しているが防御)
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, 'コードは画面のほうを見てね。')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*#>_~|]/g, '')
    .trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。．！？!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
