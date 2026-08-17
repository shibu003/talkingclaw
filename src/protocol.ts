// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 shibu003
//
// talkingclaw wire protocol — the shapes that cross the boundary between the
// room daemon and anything talking to it (agents over MCP, the browser room,
// third-party adapters).
//
// The whole repository is Apache-2.0; this file carries the header explicitly
// because it is the boundary other software is written against — a client, an
// adapter, or an independent room implementation starts from these shapes.
//
// Rule for this file: TYPES ONLY, no behaviour, no imports. If something needs
// node: APIs or holds state, it belongs in roomcore.ts (core), not here.

/** Filler utterances an agent emits while it is still working. */
export type FillerKind = 'ack' | 'context' | 'status';

/**
 * Conversation context split. 'work' is the working room (the default, and
 * what pre-channel clients get); 'chat' is the small-talk room. Carried on
 * user_speech / agent_speech; separates transcript storage and agent memory.
 */
export type Channel = 'work' | 'chat';

/** How the room decided which participants an utterance was aimed at. */
export type RoutingMethod = 'name' | 'selection' | 'floor' | 'last_responder' | 'default';

/** One append-only entry in the room log. Ordered by `id`, never rewritten. */
export type RoomEvent = {
  id: number;
  at: string;
  type: 'user_speech' | 'agent_speech' | 'presence' | 'system';
  /** participantId, or the literals 'user' / 'room'. */
  from: string;
  name?: string;
  text?: string;
  /** Token-less relative path; the browser is what attaches it. */
  audio?: string | null;
  filler?: FillerKind;
  /** 'none' marks progress speech that closes nobody's turn window. */
  turnId?: string;
  targets?: string[];
  broadcast?: true;
  routing?: { method: RoutingMethod; matchedAlias?: string };
  /** Absent means 'work' — kept optional for backward compatibility. */
  channel?: Channel;
  /** Attachment filenames under ~/.talkingclaw/uploads. */
  files?: string[];
};

/** Whether a voice is usable for this participant yet. */
export type VoiceStatus = 'ready' | 'warming_up' | 'voice_unavailable';

/** Liveness as reported to clients. */
export type PresenceState = 'listening' | 'active' | 'gone';

/** One agent seated in the room. */
export type Participant = {
  participantId: string;
  sessionId: string;
  requestedName: string;
  assignedName: string;
  /** A suffixed name ("コハク 2") — a temporary identity, no credential file written. */
  ephemeral: boolean;
  left: boolean;
  voice: { requested: string; resolvedSpeaker: number | null; status: VoiceStatus };
  ackedCursor: number;
  lastSeen: number;
};

/** What a client stores so it can rejoin the same seat after a restart. */
export type JoinResume = { bootId: string; participantId: string; sessionId: string };

/** Result of a join attempt. `mode` says how the name was resolved. */
export type JoinOutcome =
  | { participant: Participant; mode: 'new' | 'takeover' | 'suffix' }
  | { error: string };

/** Response shape of the agent delivery endpoint. */
export type Delivery = {
  /** The cursor had fallen out of the retained window; events were skipped. */
  expired: boolean;
  /** How many deliverable events were dropped to fit the replay limit. */
  truncated: number;
  events: RoomEvent[];
};

/** Room daemon discovery record, written to ~/.talkingclaw/room.json. */
export type RoomInfo = {
  port: number;
  token: string;
  bootId: string;
  pid: number;
  pidStartedAt?: number;
};
