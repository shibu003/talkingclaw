// 部屋の純ロジック層: append-only EventStore と参加者 Registry(I/O なし)。
// 凍結仕様 S1-S3(計画 v6)の実装。takeover 等の lifecycle 完全版は 3A-1a-ii で拡張する。
import { createHash, randomUUID } from 'node:crypto';

export type FillerKind = 'ack' | 'context' | 'status';
// 部屋分割(会話コンテキストの分離): 'work' = 作業部屋(既定・後方互換)、'chat' = 雑談部屋。
// user_speech / agent_speech に付与し、transcript の保存先・クロエの Brain(記憶)を隔てる。
export type Channel = 'work' | 'chat';
export type RoomEvent = {
  id: number;
  at: string;
  type: 'user_speech' | 'agent_speech' | 'presence' | 'system';
  from: string; // participantId | 'user' | 'room'
  name?: string;
  text?: string;
  audio?: string | null; // token なし相対 path。付与はブラウザ側
  filler?: FillerKind;
  turnId?: string; // 'none' = どの turn の窓も閉じない進捗発話
  targets?: string[];
  broadcast?: true;
  routing?: { method: 'name' | 'selection' | 'floor' | 'last_responder' | 'default'; matchedAlias?: string };
  channel?: Channel; // 未指定は 'work' 扱い(既存 event との後方互換)
};

const MAX_LOG = 1000;
const AGENT_REPLAY_LIMIT = 50;

// S4: 名前マッチ用の正規化(カタカナ→ひらがな + 小文字化)
export function kanaNormalize(s: string): string {
  return s.toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export class EventStore {
  readonly bootId = randomUUID();
  #log: RoomEvent[] = [];
  #seq = 0;
  #listeners = new Set<(ev: RoomEvent) => void>();

  append(e: Omit<RoomEvent, 'id' | 'at'>): RoomEvent {
    const ev = { id: ++this.#seq, at: new Date().toISOString(), ...e } as RoomEvent;
    this.#log.push(ev);
    if (this.#log.length > MAX_LOG) this.#log.splice(0, this.#log.length - MAX_LOG);
    for (const listener of this.#listeners) listener(ev);
    return ev;
  }

  onAppend(fn: (ev: RoomEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  get lastId(): number {
    return this.#seq;
  }

  get oldestRetainedId(): number {
    return this.#log.length > 0 ? this.#log[0].id : this.#seq + 1;
  }

  get(id: number): RoomEvent | undefined {
    return this.#log.find((e) => e.id === id);
  }

  // SSE replay 用(全 event)
  since(after: number): RoomEvent[] {
    return this.#log.filter((e) => e.id > after);
  }

  // agent 配送用: targets に自分 or broadcast、id > after。at-least-once(log からは消さない)。
  // cursor が prune 域なら expired を立てて保持最古から返す(S1)。直近 50 件 + 切捨て件数。
  deliverable(pid: string, after: number): { expired: boolean; truncated: number; events: RoomEvent[] } {
    const floor = this.oldestRetainedId - 1;
    const expired = after < floor;
    const from = expired ? floor : after;
    const all = this.#log.filter((e) => e.id > from && (e.broadcast === true || e.targets?.includes(pid)));
    const truncated = Math.max(0, all.length - AGENT_REPLAY_LIMIT);
    return { expired, truncated, events: all.slice(-AGENT_REPLAY_LIMIT) };
  }
}

export type Participant = {
  participantId: string;
  sessionId: string;
  requestedName: string;
  assignedName: string;
  ephemeral: boolean; // suffix 名(『コハク 2』)= 資格ファイル不書込の一時 identity
  left: boolean;
  voice: { requested: string; resolvedSpeaker: number | null; status: 'ready' | 'warming_up' | 'voice_unavailable' };
  ackedCursor: number;
  lastSeen: number;
};

export type JoinResume = { bootId: string; participantId: string; sessionId: string };
export type JoinOutcome = { participant: Participant; mode: 'new' | 'takeover' | 'suffix' } | { error: string };

// S3: alive = listen/heartbeat が ALIVE_MS 以内(既定 2.5 分)。テストは env で短縮可
const ALIVE_MS = Number(process.env.ALIVE_MS ?? 150_000);
const EVICT_MS = 24 * 3600 * 1000;
const MAX_PARTICIPANTS = 16;

function slugify(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 4);
  return `${ascii || 'agent'}-${hash}`;
}

export class Registry {
  #participants = new Map<string, Participant>();

  alive(p: Participant): boolean {
    return !p.left && Date.now() - p.lastSeen < ALIVE_MS;
  }

  presence(p: Participant, isListening: boolean): 'listening' | 'active' | 'gone' {
    if (isListening) return 'listening';
    return this.alive(p) ? 'active' : 'gone';
  }

  // S3 join 解決 5 規則: ①resume+gone→takeover ②resume+alive→拒否(fresh へ)
  // ③fresh+同名 gone→名前ベース takeover ④fresh+同名 alive→suffix ephemeral ⑤新規
  join(requestedName: string, voiceRequested: string, cursorTail: number,
       currentBootId: string, resume?: JoinResume): JoinOutcome {
    this.#evict();
    if (resume && resume.bootId === currentBootId) {
      const p = this.#participants.get(resume.participantId);
      if (p && p.sessionId === resume.sessionId && !this.alive(p)) return this.#takeover(p, voiceRequested);
      // alive(別の生きた session が保持)/ 不一致 → fresh join へ落ちる
    }
    const canonical = [...this.#participants.values()].find(
      (q) => !q.ephemeral && q.requestedName === requestedName,
    );
    if (canonical && !this.alive(canonical)) return this.#takeover(canonical, voiceRequested);
    if (this.#participants.size >= MAX_PARTICIPANTS) return { error: `部屋が満員です(上限 ${MAX_PARTICIPANTS})` };
    if (canonical) {
      let n = 2;
      let assigned = `${requestedName} ${n}`;
      while ([...this.#participants.values()].some((q) => q.assignedName === assigned)) assigned = `${requestedName} ${++n}`;
      return { participant: this.#make(requestedName, assigned, voiceRequested, cursorTail, true), mode: 'suffix' };
    }
    return { participant: this.#make(requestedName, requestedName, voiceRequested, cursorTail, false), mode: 'new' };
  }

  // takeover = participantId 維持 + sessionId ローテーション(targets/floor/ackedCursor が連続する)
  #takeover(p: Participant, voiceRequested: string): JoinOutcome {
    p.sessionId = randomUUID();
    p.lastSeen = Date.now();
    p.left = false;
    if (voiceRequested) p.voice.requested = voiceRequested;
    return { participant: p, mode: 'takeover' };
  }

  #make(requestedName: string, assignedName: string, voiceRequested: string,
        cursorTail: number, ephemeral: boolean): Participant {
    const base = slugify(requestedName);
    let participantId = base;
    for (let n = 2; this.#participants.has(participantId); n++) participantId = `${base}-${n}`;
    const p: Participant = {
      participantId, sessionId: randomUUID(), requestedName, assignedName, ephemeral, left: false,
      voice: { requested: voiceRequested, resolvedSpeaker: null, status: 'warming_up' },
      ackedCursor: cursorTail, lastSeen: Date.now(),
    };
    this.#participants.set(participantId, p);
    return p;
  }

  #evict(): void {
    const now = Date.now();
    for (const [id, p] of this.#participants) {
      if (!this.alive(p) && now - p.lastSeen > EVICT_MS) this.#participants.delete(id);
    }
  }

  leave(p: Participant): void {
    p.left = true;
  }

  auth(participantId: string, sessionId: string): Participant | null {
    const p = this.#participants.get(participantId);
    if (!p || p.sessionId !== sessionId) return null;
    p.lastSeen = Date.now();
    return p;
  }

  get(participantId: string): Participant | undefined {
    return this.#participants.get(participantId);
  }

  all(): Participant[] {
    return [...this.#participants.values()];
  }
}
