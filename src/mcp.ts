// MCP stdio thin proxy(3B-1: happy path)。部屋の状態は room daemon に集約し、
// この process は speak / listen を HTTP へ中継するだけ(S8 の復旧チェーン完全版は 3B-2)。
// stdout は JSON-RPC 専用 — ログは必ず console.error(stderr)。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync, spawn } from 'node:child_process';
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

type RoomInfo = { port: number; token: string; bootId: string; pid: number; pidStartedAt?: number };
type Session = { bootId: string; participantId: string; sessionId: string; assignedName: string; cursor: number };

const credSlug = `${AGENT_NAME.toLowerCase().replace(/[^a-z0-9]/g, '')}-${createHash('sha256').update(AGENT_NAME).digest('hex').slice(0, 6)}`;
const credPath = join(STATE_DIR, `agent-${credSlug}.json`);

let room: RoomInfo | null = null;
let session: Session | null = null;
let triedResume = false; // resume-first はプロセス起動時のみ(S3)
let heartbeatTimer: NodeJS.Timeout | null = null;
let speakSeq = 0;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function spawnDaemon(): void {
  console.error('room daemon を起動します…');
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const log = openSync(join(STATE_DIR, 'room.log'), 'a');
  const child = spawn(process.execPath, [ROOM_PATH], {
    detached: true,
    stdio: ['ignore', log, log], // stdout を継承しない(MCP stdio 汚染防止)
    env: { ...process.env, PORT: String(DEFAULT_PORT) },
  });
  child.unref();
}

// S8: wedged daemon の本人検証 — room.json の pid が本当に talkingclaw daemon か
// (ps の起動時刻 ±5s + コマンドラインに room.ts)。検証できなければ絶対に kill しない。
function verifyDaemonPid(pid: number, pidStartedAt: number): boolean {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim();
    if (!out.includes('room.ts')) return false;
    const lstart = new Date(out.slice(0, 24)).getTime();
    return Number.isFinite(lstart) && Math.abs(lstart - pidStartedAt) < 5_000;
  } catch {
    return false;
  }
}

// S8 復旧チェーン(single-flight)。呼び出し側は予算内で待ち、超過時は recovering を返す
let recovering: Promise<RoomInfo> | null = null;
function recoverRoom(): Promise<RoomInfo> {
  if (recovering) return recovering;
  recovering = (async (): Promise<RoomInfo> => {
    try {
      // 1. room.json 再読(token ローテーション対応)→ health
      let rj = readRoomJson();
      if (rj && (await healthOk(rj.port))) return (room = rj);
      // 2. wedged 判定: port は塞がっているが health が返らない → 本人検証の上で除去
      const port = rj?.port ?? DEFAULT_PORT;
      const httpAnswers = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
        .then(() => true).catch((e) => (e as Error).name === 'TimeoutError');
      if (httpAnswers && rj) {
        // HTTP が何か返る(別アプリ or 応答遅延)→ kill 禁止(S8)
        const h = await healthOk(port);
        if (!h) throw new Error(`port ${port} は別のアプリが使用中のようです。PORT 環境変数を変えて登録し直してください`);
        return (room = rj);
      }
      if (rj && !httpAnswers) {
        try {
          process.kill(rj.pid, 0); // pid 生存確認
          if (verifyDaemonPid(rj.pid, rj.pidStartedAt ?? 0)) {
            console.error(`応答しない daemon(pid ${rj.pid})を除去します`);
            await sleep(200 + Math.random() * 400); // 複数 proxy の kill 競合を散らす
            const again = readRoomJson();
            if (again && (await healthOk(again.port))) return (room = again); // 直前再確認
            process.kill(rj.pid, 'SIGTERM');
            await sleep(2000);
            try { process.kill(rj.pid, 'SIGKILL'); } catch { /* 既に死亡 */ }
          }
        } catch { /* pid 死亡 → そのまま spawn へ */ }
      }
      // 3. spawn → 20s poll
      spawnDaemon();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await sleep(500);
        const fresh = readRoomJson();
        if (fresh && (await healthOk(fresh.port))) return (room = fresh);
      }
      throw new Error('部屋を起動できませんでした。~/.talkingclaw/room.log を確認するか、PORT を変えてください');
    } finally {
      recovering = null;
    }
  })();
  return recovering;
}

async function ensureRoom(): Promise<RoomInfo> {
  if (room) return room;
  return recoverRoom();
}

class RecoveringError extends Error {}

// 生 API 呼び出し。失敗時は budget 内で復旧を待って 1 回だけ再試行(S8: 50s 保持)
async function api(path: string, body: object, budgetMs = 50_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  // listen のみ long-poll(48s + 余裕)。他は即応 API なので短く切って復旧へ回す
  const callTimeout = path === '/listen' ? 53_000 : 10_000;
  const call = async (): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${room!.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': room!.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(callTimeout),
    });
    if (res.status === 401) throw new Error('unauthorized');
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    await ensureRoom();
    return await call();
  } catch (firstError) {
    room = null;
    const remaining = budgetMs - (Date.now() - started);
    let terminal: Error | null = null;
    const outcome = await Promise.race([
      recoverRoom().then(() => 'recovered' as const).catch((e: Error) => { terminal = e; return 'failed' as const; }),
      sleep(Math.max(1000, remaining)).then(() => 'budget' as const),
    ]);
    if (outcome === 'recovered') {
      if (session && room && session.bootId !== (room as RoomInfo).bootId) session = null; // 世代交代 → fresh join(S8)
      return call();
    }
    if (outcome === 'failed' && terminal) throw terminal; // 恒久エラー(別アプリ占有等)は案内をそのまま
    throw new RecoveringError('部屋を復旧中。少し待ってからもう一度呼んで');
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
    try {
      const s = await ensureJoined();
      const clientSeq = `s${++speakSeq}`; // S2: 冪等キー(復旧後の再送で二重発話しない)
      let r = await api('/speak', { participantId: s.participantId, sessionId: s.sessionId, text, turnId, clientSeq });
      if (r.status === 'unknown_participant') {
        const ns = await rejoin(); // S2: 不喪失契約 — 再 join して同テキストを 1 回だけ再送
        r = await api('/speak', { participantId: ns.participantId, sessionId: ns.sessionId, text, turnId, clientSeq });
      }
      return textResult(r);
    } catch (error) {
      if (error instanceof RecoveringError) return textResult({ status: 'recovering', note: error.message });
      return textResult({ status: 'error', note: (error as Error).message });
    }
  },
);

server.registerTool(
  'listen',
  {
    description: 'ユーザーの発話を待つ(最大 45 秒の long-poll)。no_speech ならもう一度 listen を呼ぶこと。',
    inputSchema: { wait_seconds: z.number().min(1).max(48).optional() },
  },
  async ({ wait_seconds }) => {
    try {
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
    } catch (error) {
      if (error instanceof RecoveringError) return textResult({ status: 'recovering', note: error.message });
      return textResult({ status: 'error', note: (error as Error).message });
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`talkingclaw MCP proxy 起動(agent: ${AGENT_NAME} / voice: ${VOICE})`);
