// 会話OS / Floor と Turn（設計: docs/kaiwa-os-design.md §4.2, §4.3）
//
// 「誰に向けた発話か・誰が答えるか・答えが来ないときどうするか」を持つ層。
// Router（ルーティング優先順位）・Turn テーブル（応答窓の状態）・escalation（段階発火と打切り）は
// 互いの状態を触るので 1 つの部品にまとめている:
//   - 新 turn は同じ相手の旧 escalation を supersede する（track → cancel）
//   - 応答が来たら escalation を止める（markResponded → cancel）
//   - 未達通知は floor を解除する（escalation → floor）
// 分けると 3 者が互いの内部を覗く形になるため、境界はこのクラスの外側に引く。
//
// C1 の抽出方針: 挙動を変えない。依存は注入（読み取りは getter、状態変更は所有者への callback）。
// 音声の実体（相槌・filler の事前合成プール）は音声平面が持つので、ここは cue を受け取るだけ
// （①で引いた線を跨がない）。

import { type Channel, type EventStore, type Registry, type RoomEvent, kanaNormalize } from '../roomcore.ts';
import { type FillerCue, type UserSpeechState } from './speech.ts';

export type Turn = {
  turnId: string;
  target: string;
  text: string;
  delivered: boolean;
  responded: boolean;
  noticeSent: boolean;
  channel: Channel;
};

export type TurnDeps = {
  store: EventStore;
  registry: Registry;
  metric: (kind: string, extra?: Record<string, unknown>) => void;
  userSpeech: UserSpeechState;
  // filler の音声は音声平面（convos/speech.ts）が持つ。ここは文と音声の組を受け取るだけ
  contextCue: (pid: string, rotate: number) => FillerCue;
  statusCue: () => FillerCue;
  undeliveredCue: () => FillerCue;
  // 在室判定と既定の宛先は room.ts のアプリ状態（部屋の切替に依存する）ので注入 getter で読む
  inThisRoom: (pid: string) => boolean;
  chloePid: () => string | null;
};

export class TurnPlane {
  #seq = 0;
  #selectedPid: string | null = null;
  #floorOwner: string | null = null;
  #lastResponder: string | null = null;
  #turns = new Map<string, Turn>();
  // escalation
  #escalations = new Map<string, NodeJS.Timeout>();
  #statusRotate = 0;
  #lastNoticeAt = new Map<string, number>(); // 実機フィードバック: 通知の出過ぎ防止
  readonly #d: TurnDeps;

  constructor(deps: TurnDeps) {
    this.#d = deps;
  }

  // ---- Router の状態（画面と room_status が読む / /select が書く）----

  get selected(): string | null {
    return this.#selectedPid;
  }

  get floor(): string | null {
    return this.#floorOwner;
  }

  get lastResponder(): string | null {
    return this.#lastResponder;
  }

  select(pid: string | null): void {
    this.#selectedPid = pid;
  }

  // 「audio なしで応答した者へ floor が進む」(§4.2)
  advanceFloor(pid: string): void {
    this.#floorOwner = pid;
    this.#lastResponder = pid;
  }

  // ---- Turn テーブル ----

  // turnId の採番。prefix は呼び側の用途で変わる(T = user 発話、G = ゲーム)
  nextTurnId(prefix: string): string {
    return `${prefix}${++this.#seq}`;
  }

  track(turnId: string, target: string, text: string, channel: Channel): void {
    for (const t of this.#turns.values()) {
      if (t.target === target && !t.responded) this.cancelEscalation(t.turnId); // 新 turn が旧 escalation を supersede
    }
    this.#turns.set(turnId, { turnId, target, text, delivered: false, responded: false, noticeSent: false, channel });
    if (this.#turns.size > 200) this.#turns.delete(this.#turns.keys().next().value as string);
  }

  // turn に紐づく channel(ack/filler/未達通知/外部 participant の返信など、turn 経由で発話する箇所が参照)。
  // turn が無い(turnId 'none'/未指定 = 実況等の unprompted 発話)は常に 'work' 扱い
  // (部屋分割の既定: 雑談部屋に実況を漏らさない)
  channelOf(turnId: string | undefined): Channel {
    const t = turnId ? this.#turns.get(turnId) : undefined;
    return t?.channel ?? 'work';
  }

  // long-poll で実際に届いた時。target が一致していて未配送のときだけ配送とみなす
  markDelivered(turnId: string, pid: string): void {
    const t = this.#turns.get(turnId);
    if (t && t.target === pid && !t.delivered) {
      t.delivered = true;
      this.#d.metric('turn_delivered', { turnId });
    }
  }

  // in-process(クロエ)は配送の往復が無いので即配送。target 判定も metric も無い経路
  markDeliveredInProcess(turnId: string): void {
    const t = this.#turns.get(turnId);
    if (t) t.delivered = true;
  }

  // speak の turnId 省略時: 配送済み・未応答の最古 turn(無ければ最新の自分宛 turn)— S4
  attribute(pid: string, explicit: string | undefined): string | undefined {
    if (explicit === 'none') return 'none';
    if (explicit) { this.markResponded(explicit); return explicit; }
    let latest: string | undefined;
    for (const t of this.#turns.values()) {
      if (t.target !== pid) continue;
      latest = t.turnId;
      // 窓を閉じた turn(打切り/未達)は自動帰属から除外 — 以降の返信は明示 turnId の領分
      if (t.delivered && !t.responded && !t.noticeSent) { this.markResponded(t.turnId); return t.turnId; }
    }
    if (latest) this.markResponded(latest);
    return latest;
  }

  markResponded(turnId: string): void {
    const t = this.#turns.get(turnId);
    if (t && !t.responded) {
      t.responded = true;
      this.cancelEscalation(turnId);
      this.#d.metric('turn_window_closed', { turnId, reason: 'responded' });
    }
  }

  // 作業ボードに出す「まだ答えが返っていない依頼」。クロエ宛は除く(自分の作業として別に出る)
  openForBoard(): Turn[] {
    const chloe = this.#d.chloePid();
    return [...this.#turns.values()]
      .filter((t) => !t.responded && !t.noticeSent && t.target !== chloe)
      .slice(-10);
  }

  // ---- Router（優先順位: 名前 > UI 選択 > floor > last_responder > default(クロエ)）----

  route(text: string): { targets: string[]; routing: RoomEvent['routing'] } {
    const head = kanaNormalize(text.slice(0, 12));
    let best: { pid: string; alias: string } | null = null;
    for (const p of this.#d.registry.all()) {
      if (!this.#d.inThisRoom(p.participantId)) continue;
      // ghost(suffix ephemeral)の gone だけ除外。本物(canonical)の gone は名指し可
      // → inbox に積まれ復帰後に再配送 + 未達通知が出る(v6.1 修正)
      if (!this.#d.registry.alive(p) && p.ephemeral) continue;
      for (const raw of [p.assignedName, p.requestedName]) {
        const alias = kanaNormalize(raw);
        const idx = alias ? head.indexOf(alias) : -1;
        // 呼びかけ = 名前が文頭近く(開始位置 ≤5)。文中の言及(「後でコハクに頼む」等)は除外
        if (idx >= 0 && idx <= 5 && (!best || alias.length > best.alias.length)) best = { pid: p.participantId, alias: raw };
      }
    }
    if (best) return { targets: [best.pid], routing: { method: 'name', matchedAlias: best.alias } };
    const aliveTarget = (pid: string | null): boolean => {
      if (!pid) return false;
      if (!this.#d.inThisRoom(pid)) return false;           // 別の部屋にいる相手には流れない
      const p = this.#d.registry.get(pid);
      return p !== undefined && this.#d.registry.alive(p); // S4: gone は floor/last_responder から自然解除
    };
    if (aliveTarget(this.#selectedPid)) return { targets: [this.#selectedPid!], routing: { method: 'selection' } };
    if (aliveTarget(this.#floorOwner)) return { targets: [this.#floorOwner!], routing: { method: 'floor' } };
    if (aliveTarget(this.#lastResponder)) return { targets: [this.#lastResponder!], routing: { method: 'last_responder' } };
    const chloe = this.#d.chloePid();
    if (chloe && this.#d.registry.get(chloe)) return { targets: [chloe], routing: { method: 'default' } };
    return {
      targets: this.#d.registry.all().map((p) => p.participantId).filter((pid) => this.#d.inThisRoom(pid)),
      routing: { method: 'default' },
    };
  }

  // ---- escalation(S6 完全形)----
  // ack →(再生終了 or fallback)→ 文脈 filler →(+5s)→ 状況報告 ×2 → 打切り(窓閉じ)
  // キャンセル: 本応答 speak(markResponded)/ 同 target への新 turn / 窓閉じ

  cancelEscalation(turnId: string): void {
    const t = this.#escalations.get(turnId);
    if (t) { clearTimeout(t); this.#escalations.delete(turnId); }
  }

  scheduleEscalation(turnId: string, target: string, stage: number, delayMs: number): void {
    this.cancelEscalation(turnId);
    const timer = setTimeout(() => {
      this.#escalations.delete(turnId);
      if (this.#d.userSpeech.active) return this.scheduleEscalation(turnId, target, stage, 500); // ユーザーが話し続けてる間は先送り
      const t = this.#turns.get(turnId);
      if (!t || t.responded || !t.delivered) return; // 応答済み/未配送(未達経路が担当)は終了
      const p = this.#d.registry.get(target);
      if (stage === 1) {
        const cue = this.#d.contextCue(target, this.#statusRotate);
        const ev = this.#d.store.append({
          type: 'agent_speech', from: target, name: p?.assignedName,
          text: cue.text, audio: cue.audio, filler: 'context', turnId, channel: t.channel,
        });
        this.#d.metric('filler_emitted', { turnId, stage, eventId: ev.id });
        this.scheduleEscalation(turnId, target, 2, 8_000); // /played が来れば前倒し(onFillerPlayed 経由)
      } else if (stage <= 3) {
        const ev = this.#d.store.append({
          type: 'agent_speech', from: 'room', name: 'ナレーション',
          ...this.#d.statusCue(), filler: 'status', turnId, channel: t.channel,
        });
        this.#d.metric('filler_emitted', { turnId, stage, eventId: ev.id });
        if (stage < 3) this.scheduleEscalation(turnId, target, stage + 1, 8_000);
        else {
          this.#d.store.append({ type: 'system', from: 'room', text: '返事が来たら教えるね' }); // 打切り(窓閉じ)
          this.#d.metric('turn_window_closed', { turnId, reason: 'exhausted' });
          this.#turns.get(turnId)!.noticeSent = true;
        }
      }
    }, delayMs);
    timer.unref();
    this.#escalations.set(turnId, timer);
  }

  // /played で次段を前倒し(再生終了 + 5s — 相対スケジュール)
  onFillerPlayed(ev: RoomEvent): void {
    if (!ev.turnId || !ev.filler || ev.filler === 'status' && !this.#escalations.has(ev.turnId)) return;
    const t = this.#turns.get(ev.turnId);
    if (!t || t.responded) return;
    const stage = ev.filler === 'ack' ? 1 : ev.filler === 'context' ? 2 : 3;
    if (this.#escalations.has(ev.turnId)) this.scheduleEscalation(ev.turnId, t.target, stage, 5_000);
  }

  // S4: routed 先に 6s 以内に配送されなければ未達通知(1 回・ナレーション)+ floor 解除
  scheduleUndeliveredNotice(turnId: string, target: string): void {
    if (target === this.#d.chloePid()) return; // in-process は即配送
    const timer = setTimeout(() => {
      const t = this.#turns.get(turnId);
      if (!t || t.delivered || t.noticeSent) return;
      t.noticeSent = true;
      if (Date.now() - (this.#lastNoticeAt.get(target) ?? 0) < 60_000) return; // 同じ相手への連発防止
      this.#lastNoticeAt.set(target, Date.now());
      this.#d.store.append({
        type: 'agent_speech', from: 'room', name: 'ナレーション',
        ...this.#d.undeliveredCue(), filler: 'status', turnId, channel: t.channel,
      });
      if (this.#floorOwner === target) this.#floorOwner = null;
    }, 12_000);
    timer.unref();
  }
}
