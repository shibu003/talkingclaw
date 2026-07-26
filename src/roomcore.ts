// 部屋の純ロジック層: append-only EventStore と参加者 Registry(I/O なし)。
// 凍結仕様 S1-S3(計画 v6)の実装。takeover 等の lifecycle 完全版は 3A-1a-ii で拡張する。
import { createHash, randomUUID } from 'node:crypto';

export type FillerKind = 'ack' | 'context' | 'status';
export type RoomEvent = {
  id: number;
  at: string;
  type: 'user_speech' | 'agent_speech' | 'agent_message' | 'presence' | 'system' | 'error' | 'user_interim';
  from: string; // participantId | 'user' | 'room'
  name?: string;
  text?: string;
  audio?: string | null; // token なし相対 path。付与はブラウザ側
  filler?: FillerKind;
  turnId?: string; // 'none' = どの turn の窓も閉じない進捗発話
  targets?: string[];
  broadcast?: true;
  routing?: { method: 'name' | 'selection' | 'floor' | 'last_responder' | 'default'; matchedAlias?: string };
};

const MAX_LOG = 1000;
const AGENT_REPLAY_LIMIT = 50;

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
  voice: { requested: string; resolvedSpeaker: number | null; status: 'ready' | 'warming_up' | 'voice_unavailable' };
  ackedCursor: number;
  lastSeen: number;
};

function slugify(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 4);
  return `${ascii || 'agent'}-${hash}`;
}

export class Registry {
  #participants = new Map<string, Participant>();

  // 3A-1a-i は登録のみ(takeover / suffix / presence は 3A-1a-ii)
  join(requestedName: string, voiceRequested: string, cursor: number): Participant {
    const base = slugify(requestedName);
    let participantId = base;
    for (let n = 2; this.#participants.has(participantId); n++) participantId = `${base}-${n}`;
    const p: Participant = {
      participantId,
      sessionId: randomUUID(),
      requestedName,
      assignedName: requestedName,
      voice: { requested: voiceRequested, resolvedSpeaker: null, status: 'warming_up' },
      ackedCursor: cursor,
      lastSeen: Date.now(),
    };
    this.#participants.set(participantId, p);
    return p;
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
