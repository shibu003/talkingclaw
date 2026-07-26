// 声の部屋 daemon(3A-1a-i: EventStore + HTTP core + token 認証 + inline TTS)。
// S8 の単一性強化・S9 の Host/Origin 検証等は 3A-1b、ページ配信は 3A-1c で拡張する。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import { EventStore, Registry, type RoomEvent } from './roomcore.ts';
import { Voice, splitSentences } from './voice.ts';

const PORT = Number(process.env.PORT ?? 3300);
const LISTEN_MAX_S = 48; // S2: server 内部 deadline 上限
const TEXT_MAX = 4000;
const BODY_MAX = 64 * 1024;

const store = new EventStore();
const registry = new Registry();
const voice = new Voice(config.tts);

// ---- inline TTS(3A-1a-i 版: 単一チェーンで合成→event 発行。scheduler は 3A-2)----
const audioStore = new Map<number, Buffer>();
let audioSeq = 0;
let synthChain: Promise<void> = Promise.resolve();
let engineReady = false;
void voice.ensureEngine().then(
  (v) => { engineReady = true; console.error(`AivisSpeech ready (${v})`); },
  (e) => console.error(`AivisSpeech 起動失敗: ${(e as Error).message}(text-only で継続)`),
);

function speakSentences(from: string, name: string, text: string, turnId: string | undefined): void {
  for (const sentence of splitSentences(text)) {
    synthChain = synthChain.then(async () => {
      let audio: string | null = null;
      if (engineReady) {
        try {
          const wav = await voice.synthesizeWav(sentence);
          if (wav) {
            const id = ++audioSeq;
            audioStore.set(id, wav);
            if (audioStore.size > 100) audioStore.delete(audioStore.keys().next().value as number);
            audio = `/audio/${id}`;
          }
        } catch (error) {
          console.error(`合成失敗(text-only 継続): ${(error as Error).message}`);
        }
      }
      store.append({ type: 'agent_speech', from, name, text: sentence, audio, turnId });
    });
  }
}

// ---- listen waiter(participant 毎 1 つ。新 listen が旧を no_speech 解決)----
type Waiter = { resolve: (body: object) => void; timer: NodeJS.Timeout };
const waiters = new Map<string, Waiter>();

function resolveListen(pid: string, after: number): object | null {
  const { expired, truncated, events } = store.deliverable(pid, after);
  if (expired) return { status: 'cursor_expired', bootId: store.bootId, cursor: store.oldestRetainedId - 1 };
  if (events.length === 0) return null;
  const p = registry.get(pid);
  if (p) p.ackedCursor = after; // ack = 前回配送分の確認(S1)
  const stripped = events.map(({ audio, ...rest }) => rest); // S2: agent 応答から audio 除去
  return { status: 'speech', bootId: store.bootId, truncated, events: stripped, cursor: events[events.length - 1].id };
}

store.onAppend((ev) => {
  if (!ev.targets && !ev.broadcast) return;
  for (const [pid, waiter] of waiters) {
    if (!(ev.broadcast === true || ev.targets?.includes(pid))) continue;
    const p = registry.get(pid);
    const body = resolveListen(pid, p?.ackedCursor ?? 0);
    if (body) {
      clearTimeout(waiter.timer);
      waiters.delete(pid);
      waiter.resolve(body);
    }
  }
});

// ---- user 発話(3A-1a-i の routing: default = active 全員。名前/floor は 4A)----
let turnSeq = 0;
function userSpeech(text: string): RoomEvent {
  const targets = registry.all().map((p) => p.participantId);
  return store.append({
    type: 'user_speech', from: 'user', text,
    turnId: `T${++turnSeq}`, targets, routing: { method: 'default' },
  });
}

// ---- token(room.json 書込み。atomic 化・単一性は 3A-1b)----
const token = randomBytes(24).toString('hex');
const stateDir = join(homedir(), '.talkingclaw');

function authed(req: IncomingMessage, url: URL): boolean {
  if (req.method === 'GET') return url.searchParams.get('token') === token;
  return req.headers['x-room-token'] === token;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) { req.destroy(); return null; } // S9: ストリーム中 enforce
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
}

function json(res: ServerResponse, code: number, body: object): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, { app: 'talkingclaw-room', version: '0.1.0', bootId: store.bootId, port: PORT });
  }
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('talkingclaw room(ページは 3A-1c で配信)\n');
  }
  if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' });

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', bootId: store.bootId, lastId: store.lastId })}\n\n`);
    const after = Number(url.searchParams.get('after') ?? 0);
    for (const ev of store.since(after)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const unsubscribe = store.onAppend((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000); // S1: SSE heartbeat
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
    return;
  }

  if (req.method === 'GET' && path.startsWith('/audio/')) {
    const wav = audioStore.get(Number(path.slice('/audio/'.length)));
    if (!wav) return json(res, 404, { error: 'audio が見つかりません' });
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    return res.end(wav);
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
  const body = await readJson(req);
  if (body === null) return json(res, 400, { error: 'JSON body が必要です(64KB 以内)' });

  if (path === '/join') {
    const requestedName = String(body.requestedName ?? '').trim().slice(0, 40);
    if (!requestedName) return json(res, 400, { error: 'requestedName が必要です' });
    const resume = body.resume as { bootId: string; participantId: string; sessionId: string } | undefined;
    const outcome = registry.join(requestedName, String(body.voice ?? ''), store.lastId, store.bootId, resume);
    if ('error' in outcome) return json(res, 400, { error: outcome.error });
    const { participant: p, mode } = outcome;
    if (mode === 'takeover') {
      // S3: 旧 session の pending waiter を即 unknown_participant で解決 + superseded 通知
      const w = waiters.get(p.participantId);
      if (w) {
        clearTimeout(w.timer);
        waiters.delete(p.participantId);
        w.resolve({ status: 'unknown_participant' });
      }
      store.append({ type: 'system', from: 'room', name: p.assignedName, text: `${p.assignedName} の接続が切り替わったよ` });
    }
    store.append({ type: 'presence', from: p.participantId, name: p.assignedName, text: mode === 'takeover' ? 'rejoined' : 'joined' });
    return json(res, 200, {
      bootId: store.bootId, participantId: p.participantId, sessionId: p.sessionId,
      assignedName: p.assignedName, voice: p.voice, cursor: p.ackedCursor,
    });
  }

  if (path === '/chat') {
    const text = String(body.text ?? '').trim();
    if (!text || text.length > TEXT_MAX) return json(res, 400, { error: `text が空か ${TEXT_MAX} 字超です` });
    const ev = userSpeech(text);
    return json(res, 200, { ok: true, eventId: ev.id, turnId: ev.turnId });
  }

  // 以降は participant 認証必須
  const p = registry.auth(String(body.participantId ?? ''), String(body.sessionId ?? ''));
  if (!p) return json(res, 200, { status: 'unknown_participant' });

  if (path === '/heartbeat') {
    return json(res, 200, { ok: true, bootId: store.bootId });
  }

  if (path === '/leave') {
    registry.leave(p);
    const w = waiters.get(p.participantId);
    if (w) {
      clearTimeout(w.timer);
      waiters.delete(p.participantId);
      w.resolve({ status: 'no_speech', bootId: store.bootId, cursor: p.ackedCursor });
    }
    store.append({ type: 'presence', from: p.participantId, name: p.assignedName, text: 'left' });
    return json(res, 200, { ok: true });
  }

  if (path === '/speak') {
    const text = String(body.text ?? '').trim();
    if (!text || text.length > TEXT_MAX) return json(res, 400, { error: `text が空か ${TEXT_MAX} 字超です` });
    speakSentences(p.participantId, p.assignedName, text, body.turnId ? String(body.turnId) : undefined);
    return json(res, 200, { status: engineReady ? 'ok' : 'text_only' });
  }

  if (path === '/listen') {
    const after = Number(body.afterEventId ?? p.ackedCursor);
    const waitS = Math.min(Number(body.waitSeconds ?? 45) || 45, LISTEN_MAX_S);
    const immediate = resolveListen(p.participantId, after);
    if (immediate) return json(res, 200, immediate);
    const prev = waiters.get(p.participantId);
    if (prev) { // S2: 新 listen が旧 waiter を no_speech 解決
      clearTimeout(prev.timer);
      prev.resolve({ status: 'no_speech', bootId: store.bootId, cursor: after });
    }
    p.ackedCursor = after;
    const timer = setTimeout(() => {
      waiters.delete(p.participantId);
      json(res, 200, { status: 'no_speech', bootId: store.bootId, cursor: store.lastId });
    }, waitS * 1000);
    waiters.set(p.participantId, { resolve: (b) => json(res, 200, b), timer });
    req.on('close', () => {
      const w = waiters.get(p.participantId);
      if (w && w.timer === timer) { clearTimeout(timer); waiters.delete(p.participantId); }
    });
    return;
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // S8: token の書出しは bind 成功後のみ(atomic 化は 3A-1b)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'room.json'), JSON.stringify({
    port: PORT, token, pid: process.pid, pidStartedAt: Date.now(), bootId: store.bootId,
  }), { mode: 0o600 });
  console.error(`talkingclaw room: http://127.0.0.1:${PORT}(bootId ${store.bootId.slice(0, 8)})`);
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`部屋は既に起動しています: http://127.0.0.1:${PORT}/`);
    process.exit(0); // S8: bind 敗者は正常終了
  }
  throw e;
});
