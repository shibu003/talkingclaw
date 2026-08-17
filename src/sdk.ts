// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 shibu003
//
// RoomClient — a typed client for a talkingclaw room.
//
// The room daemon speaks plain HTTP + JSON on localhost. `src/mcp.ts` is one
// client of it (the one coding agents use); this is the same contract as a
// library, so anything else can join a room: another agent runtime, a test
// harness, a bot, a different UI.
//
// Apache-2.0 like the rest of the repository, and the header is explicit here
// because this file plus protocol.ts is what an independent implementation is
// written against.
//
// Zero dependencies — global fetch only.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Channel, Delivery, JoinOutcome, JoinResume, Participant, RoomEvent, RoomInfo } from './protocol.ts';

/** Where the daemon publishes its port and token. */
export const ROOM_JSON = join(homedir(), '.talkingclaw', 'room.json');

/** Long-poll ceiling the room enforces. */
export const MAX_WAIT_SECONDS = 48;

export class RoomError extends Error {
  /** 'unauthorized' | 'no_room' | 'unknown_participant' | 'http' | 'network' */
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, message: string, status = 0) {
    super(message);
    this.name = 'RoomError';
    this.kind = kind;
    this.status = status;
  }
  /** The room restarted or the token rotated — re-read room.json and retry. */
  get isRecoverable(): boolean {
    return this.kind === 'unauthorized' || this.kind === 'network' || this.status >= 500;
  }
}

export interface RoomClientOptions {
  /** Skip discovery and point at a known daemon. */
  room?: RoomInfo;
  /** Override the discovery path. Defaults to ~/.talkingclaw/room.json */
  roomJsonPath?: string;
  /** Name to request when joining. The room may hand back a suffixed one. */
  name: string;
  /** Voice id to request. The room resolves it, or reports voice_unavailable. */
  voice?: string;
  /** Per-call timeout for everything except listen. Default 10000. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** What `listen` resolves to. */
export type Heard =
  | { status: 'speech'; events: RoomEvent[]; cursor: number }
  | { status: 'no_speech' };

/**
 * A seat in a room.
 *
 * Lifecycle: `join` once, then `listen` / `speak` in a loop, `leave` at the
 * end. Heartbeats are sent automatically while joined.
 */
export class RoomClient {
  #room: RoomInfo | null;
  #roomJsonPath: string;
  #name: string;
  #voice?: string;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;

  #session: { bootId: string; participantId: string; sessionId: string; assignedName: string; cursor: number } | null = null;
  #speakSeq = 0;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomClientOptions) {
    this.#room = options.room ?? null;
    this.#roomJsonPath = options.roomJsonPath ?? ROOM_JSON;
    this.#name = options.name;
    this.#voice = options.voice;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('No fetch available; pass one in options.');
    this.#fetch = f;
  }

  /** The name the room actually gave us — may differ from the one requested. */
  get assignedName(): string | null {
    return this.#session?.assignedName ?? null;
  }

  get participantId(): string | null {
    return this.#session?.participantId ?? null;
  }

  /** Read ~/.talkingclaw/room.json. Throws if no daemon has published one. */
  discover(): RoomInfo {
    try {
      const d = JSON.parse(readFileSync(this.#roomJsonPath, 'utf8')) as RoomInfo;
      if (typeof d.port !== 'number' || typeof d.token !== 'string') throw new Error('malformed');
      this.#room = d;
      return d;
    } catch {
      throw new RoomError('no_room', `No room found at ${this.#roomJsonPath}. Start one with \`talkingclaw\`.`);
    }
  }

  /** Take a seat. Pass `resume` to reclaim the seat held before a restart. */
  async join(resume?: JoinResume): Promise<{ assignedName: string; participantId: string; mode: string }> {
    const r = await this.#post('/join', { requestedName: this.#name, voice: this.#voice, resume });
    if (typeof r.participantId !== 'string') {
      throw new RoomError('http', `join refused: ${JSON.stringify(r)}`);
    }
    this.#session = {
      bootId: String(r.bootId),
      participantId: String(r.participantId),
      sessionId: String(r.sessionId),
      assignedName: String(r.assignedName),
      cursor: Number(r.cursor ?? 0),
    };
    this.#startHeartbeat();
    return {
      assignedName: this.#session.assignedName,
      participantId: this.#session.participantId,
      mode: String(r.mode ?? 'new'),
    };
  }

  /**
   * Say something out loud.
   *
   * Carries a client sequence number, which is what makes a resend safe: the
   * room drops a duplicate rather than speaking the same line twice. Pass
   * `turnId: 'none'` for progress chatter that should not close anyone's turn.
   */
  async speak(text: string, turnId?: string): Promise<Record<string, unknown>> {
    const s = this.#requireSession();
    const clientSeq = `s${++this.#speakSeq}`;
    const send = (sess: typeof s) =>
      this.#post('/speak', { participantId: sess.participantId, sessionId: sess.sessionId, text, turnId, clientSeq });

    let r = await send(s);
    if (r.status === 'unknown_participant') {
      // The room forgot us — rejoin and resend exactly once. The same
      // clientSeq means this cannot produce two utterances.
      this.#session = null;
      await this.join();
      r = await send(this.#requireSession());
    }
    return r;
  }

  /**
   * Wait for the user to say something. Long-poll, up to 48 seconds.
   *
   * `no_speech` is not an error — it means the window closed quietly. Call
   * again to keep waiting.
   */
  async listen(waitSeconds = 45): Promise<Heard> {
    const s = this.#requireSession();
    const wait = Math.min(Math.max(1, waitSeconds), MAX_WAIT_SECONDS);
    let r = await this.#post(
      '/listen',
      { participantId: s.participantId, sessionId: s.sessionId, waitSeconds: wait, afterEventId: s.cursor },
      (wait + 8) * 1000,
    );
    if (r.status === 'unknown_participant') {
      this.#session = null;
      await this.join();
      const ns = this.#requireSession();
      r = await this.#post(
        '/listen',
        { participantId: ns.participantId, sessionId: ns.sessionId, waitSeconds: wait, afterEventId: ns.cursor },
        (wait + 8) * 1000,
      );
    }
    if (r.status === 'no_speech') return { status: 'no_speech' };
    const events = (Array.isArray(r.events) ? r.events : []) as RoomEvent[];
    const cursor = Number(r.cursor ?? this.#session?.cursor ?? 0);
    if (this.#session) this.#session.cursor = cursor;
    return { status: 'speech', events, cursor };
  }

  /** Recent room log — the shared memory between the room and the terminal. */
  async transcript(lines = 40): Promise<RoomEvent[]> {
    const r = await this.#post('/transcript', { lines });
    return (Array.isArray(r.events) ? r.events : []) as RoomEvent[];
  }

  /** Who is in the room and what they are doing. */
  async look(): Promise<Record<string, unknown>> {
    return this.#post('/look', {});
  }

  /** Give up the seat and stop heartbeating. */
  async leave(): Promise<void> {
    this.#stopHeartbeat();
    const s = this.#session;
    this.#session = null;
    if (!s) return;
    await this.#post('/leave', { participantId: s.participantId, sessionId: s.sessionId }).catch(() => {});
  }

  // -- internals ---------------------------------------------------------

  #requireSession() {
    if (!this.#session) throw new RoomError('unknown_participant', 'Not joined — call join() first.');
    return this.#session;
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      const s = this.#session;
      if (s) void this.#post('/heartbeat', { participantId: s.participantId, sessionId: s.sessionId }).catch(() => {});
    }, 60_000);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  async #post(path: string, body: object, timeoutMs = this.#timeoutMs): Promise<Record<string, unknown>> {
    const room = this.#room ?? this.discover();
    let res: Response;
    try {
      res = await this.#fetch(`http://127.0.0.1:${room.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': room.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RoomError('network', `${path}: ${(err as Error)?.message ?? String(err)}`);
    }
    if (res.status === 401) {
      // Token rotated with a daemon restart: drop it so the next call rediscovers.
      this.#room = null;
      throw new RoomError('unauthorized', `${path}: room token rejected`, 401);
    }
    if (!res.ok) throw new RoomError('http', `${path}: HTTP ${res.status}`, res.status);
    return (await res.json()) as Record<string, unknown>;
  }
}

export type { Channel, Delivery, JoinOutcome, JoinResume, Participant, RoomEvent, RoomInfo };
