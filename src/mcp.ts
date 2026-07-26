// MCP stdio thin proxy(3B-1: happy path)。部屋の状態は room daemon に集約し、
// この process は speak / listen を HTTP へ中継するだけ(S8 の復旧チェーン完全版は 3B-2)。
// stdout は JSON-RPC 専用 — ログは必ず console.error(stderr)。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_NAME = (process.env.AGENT_NAME ?? 'コハク').trim();
const VOICE = process.env.VOICE ?? 'コハク/ノーマル';
const DEFAULT_PORT = Number(process.env.PORT ?? 3300);
const STATE_DIR = join(homedir(), '.talkingclaw');
const ROOM_PATH = fileURLToPath(new URL('./room.ts', import.meta.url));

type RoomInfo = { port: number; token: string; bootId: string };
type Session = { bootId: string; participantId: string; sessionId: string; assignedName: string; cursor: number };

const credSlug = `${AGENT_NAME.toLowerCase().replace(/[^a-z0-9]/g, '')}-${createHash('sha256').update(AGENT_NAME).digest('hex').slice(0, 6)}`;
const credPath = join(STATE_DIR, `agent-${credSlug}.json`);

let room: RoomInfo | null = null;
let session: Session | null = null;
let triedResume = false; // resume-first はプロセス起動時のみ(S3)
let heartbeatTimer: NodeJS.Timeout | null = null;

function readRoomJson(): RoomInfo | null {
  try {
    const d = JSON.parse(readFileSync(join(STATE_DIR, 'room.json'), 'utf8'));
    if (typeof d.port === 'number' && typeof d.token === 'string') return d as RoomInfo;
  } catch { /* 不在 or 壊れ */ }
  return null;
}

async function healthOk(port: number): Promise<{ bootId: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const h = (await r.json()) as { app?: string; bootId?: string };
    return h.app === 'talkingclaw-room' && h.bootId ? { bootId: h.bootId } : null;
  } catch {
    return null;
  }
}

// S8: room.json が health を通ればそれを使い、通らなければ spawn(絶対 path・log へ)
async function ensureRoom(): Promise<RoomInfo> {
  const rj = readRoomJson();
  if (rj && (await healthOk(rj.port))) return (room = rj);
  console.error('room daemon を起動します…');
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const log = openSync(join(STATE_DIR, 'room.log'), 'a');
  const child = spawn(process.execPath, [ROOM_PATH], {
    detached: true,
    stdio: ['ignore', log, log], // stdout を継承しない(MCP stdio 汚染防止)
    env: { ...process.env, PORT: String(DEFAULT_PORT) },
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const fresh = readRoomJson();
    if (fresh && (await healthOk(fresh.port))) return (room = fresh);
  }
  throw new Error(`部屋を起動できませんでした。~/.talkingclaw/room.log を確認するか、PORT を変えて試してください`);
}

async function api(path: string, body: object): Promise<Record<string, unknown>> {
  if (!room) await ensureRoom();
  const call = async (): Promise<Response> =>
    fetch(`http://127.0.0.1:${room!.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': room!.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(53_000), // S2: server deadline 48s + 余裕
    });
  try {
    let res = await call();
    if (res.status === 401) {
      const fresh = readRoomJson(); // token ローテーション → 再読して 1 回だけ再試行
      if (fresh) { room = fresh; res = await call(); }
    }
    return (await res.json()) as Record<string, unknown>;
  } catch {
    room = null;
    await ensureRoom(); // 接続エラー → 復旧して 1 回だけ再試行(single-flight 完全版は 3B-2)
    return (await (await call()).json()) as Record<string, unknown>;
  }
}

function saveCreds(): void {
  if (!session || session.assignedName !== AGENT_NAME) return; // canonical のみ書く(S3)
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${credPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ bootId: session.bootId, participantId: session.participantId, sessionId: session.sessionId }), { mode: 0o600 });
  renameSync(tmp, credPath);
}

async function ensureJoined(): Promise<Session> {
  if (session) return session;
  let resume: { bootId: string; participantId: string; sessionId: string } | undefined;
  if (!triedResume) {
    triedResume = true;
    try { resume = JSON.parse(readFileSync(credPath, 'utf8')); } catch { /* 初回 */ }
  }
  const j = (await api('/join', { requestedName: AGENT_NAME, voice: VOICE, resume })) as Record<string, unknown>;
  if (typeof j.participantId !== 'string') throw new Error(`join 失敗: ${JSON.stringify(j)}`);
  session = {
    bootId: String(j.bootId), participantId: String(j.participantId), sessionId: String(j.sessionId),
    assignedName: String(j.assignedName), cursor: Number(j.cursor ?? 0),
  };
  saveCreds();
  console.error(`部屋に参加: ${session.assignedName}(${session.participantId})`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (session) void api('/heartbeat', { participantId: session.participantId, sessionId: session.sessionId }).catch(() => {});
  }, 60_000);
  heartbeatTimer.unref();
  return session;
}

async function rejoin(): Promise<Session> {
  session = null; // 実行中の unknown_participant → 常に fresh join(S3)
  return ensureJoined();
}

function textResult(obj: object): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] };
}

const server = new McpServer(
  { name: 'talkingclaw', version: '0.1.0' },
  {
    instructions:
      `あなたはこの MCP で「声の部屋」に参加し、ユーザーと音声で会話できる。部屋でのあなたの名前は「${AGENT_NAME}」。` +
      `基本ループ: 1) listen を呼んでユーザーの発話を待つ(no_speech なら再度 listen)。2) 発話が届いたらまず speak で短く返事し、必要な作業をする。3) 作業中も節目ごとに speak で一言実況する。4) 会話を続ける限り speak→listen を繰り返す。` +
      `speak の文体(厳守): 話し言葉のみ・1〜3 文・短く。markdown・記号・URL・コードブロックは禁止(そのまま音声合成で読み上げられる)。コードや長文は画面側の成果物に書き、speak では要点だけ話す。`,
  },
);

server.registerTool(
  'speak',
  {
    description: '声の部屋で話す。テキストはそのままアニメ声で読み上げられる(話し言葉・1〜3文・記号禁止)。',
    inputSchema: { text: z.string().max(4000), turnId: z.string().optional() },
  },
  async ({ text, turnId }) => {
    const s = await ensureJoined();
    let r = await api('/speak', { participantId: s.participantId, sessionId: s.sessionId, text, turnId });
    if (r.status === 'unknown_participant') {
      const ns = await rejoin(); // S2: 不喪失契約 — 再 join して同テキストを 1 回だけ再送
      r = await api('/speak', { participantId: ns.participantId, sessionId: ns.sessionId, text, turnId });
    }
    return textResult(r);
  },
);

server.registerTool(
  'listen',
  {
    description: 'ユーザーの発話を待つ(最大 45 秒の long-poll)。no_speech ならもう一度 listen を呼ぶこと。',
    inputSchema: { wait_seconds: z.number().min(1).max(48).optional() },
  },
  async ({ wait_seconds }) => {
    const s = await ensureJoined();
    const r = await api('/listen', {
      participantId: s.participantId, sessionId: s.sessionId,
      waitSeconds: Math.min(wait_seconds ?? 45, 48), afterEventId: s.cursor,
    });
    if (r.status === 'unknown_participant') {
      await rejoin();
      return textResult({ status: 'rejoined', note: '接続を回復した。もう一度 listen を呼んで' });
    }
    if (typeof r.cursor === 'number') s.cursor = r.cursor;
    if (r.status === 'no_speech') return textResult({ status: 'no_speech', note: '発話なし。もう一度 listen を呼んで待ち続けて' });
    return textResult(r);
  },
);

await server.connect(new StdioServerTransport());
console.error(`talkingclaw MCP proxy 起動(agent: ${AGENT_NAME} / voice: ${VOICE})`);
