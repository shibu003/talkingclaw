// 声の部屋 daemon(3A-1a-i: EventStore + HTTP core + token 認証 + inline TTS)。
// S8 の単一性強化・S9 の Host/Origin 検証等は 3A-1b、ページ配信は 3A-1c で拡張する。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---- audio 置き場(相槌プールは evict 対象外)----
const audioStore = new Map<number, Buffer>();
const protectedAudio = new Set<number>();
let audioSeq = 0;

function putAudio(wav: Buffer, isProtected = false): string {
  const id = ++audioSeq;
  audioStore.set(id, wav);
  if (isProtected) protectedAudio.add(id);
  if (audioStore.size > 100) {
    for (const key of audioStore.keys()) {
      if (protectedAudio.has(key)) continue;
      audioStore.delete(key);
      break;
    }
  }
  return `/audio/${id}`;
}

// ---- EngineManager(S5): daemon が engine を保有・監視。kill は自分の子(handle 基準)のみ ----
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

let engineState: 'starting' | 'ready' | 'down' = 'starting';
let engineChild: ChildProcess | null = null;
let engineSpawnedAt = 0;
const engineSpawnLog: number[] = [];
let synthFailStreak = 0;

async function engineAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${config.tts.url}/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

function spawnEngine(): void {
  const now = Date.now();
  while (engineSpawnLog.length > 0 && now - engineSpawnLog[0] > 3600_000) engineSpawnLog.shift();
  if (engineSpawnLog.length >= 3) {
    store.append({ type: 'system', from: 'room', text: '音声エンジンの再起動が続いてる。手動で確認してあげて(engine/macOS-x64/run)' });
    return;
  }
  if (!existsSync(config.tts.enginePath)) return;
  engineSpawnLog.push(now);
  engineSpawnedAt = now;
  engineChild = spawn(config.tts.enginePath, [], {
    cwd: config.tts.enginePath.replace(/\/run$/, ''),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_TOKEN: '' },
  });
  engineChild.unref();
  console.error('AivisSpeech engine を起動中…');
}

async function engineLoop(): Promise<void> {
  for (;;) {
    const alive = await engineAlive();
    if (alive) {
      if (engineState !== 'ready') {
        engineState = 'ready';
        synthFailStreak = 0;
        console.error('AivisSpeech ready');
        store.append({ type: 'system', from: 'room', text: '声の準備ができたよ' });
        await onEngineReady();
      }
    } else if (engineState === 'ready') {
      engineState = 'down';
      store.append({ type: 'system', from: 'room', text: '音声エンジンが落ちたみたい。しばらく文字だけで続けるね' });
      spawnEngine(); // 消滅検出 → rate-limit 付き再 spawn(S5)
    } else {
      const grace = Date.now() - engineSpawnedAt < 150_000; // SP5 実測 ×1.5
      if (!grace) {
        // wedged: 自分の子(handle 基準)のみ SIGTERM → 再 spawn。他所有 engine は触らない
        if (engineChild && engineChild.exitCode === null) {
          engineChild.kill('SIGTERM');
          engineChild = null;
        }
        if (engineState === 'down' || engineState === 'starting') spawnEngine();
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
void engineLoop();

// ---- voice 解決(S3/S7: engineReady で未解決 participant を再解決)----
async function resolveVoice(requested: string): Promise<number | null> {
  try {
    const r = await fetch(`${config.tts.url}/speakers`, { signal: AbortSignal.timeout(3000) });
    const speakers = (await r.json()) as { name: string; styles: { name: string; id: number }[] }[];
    if (!requested) return config.tts.speaker;
    const [model, style] = requested.split('/');
    const sp = speakers.find((s) => s.name === model);
    const st = sp?.styles.find((x) => x.name === (style ?? 'ノーマル')) ?? sp?.styles[0];
    return st?.id ?? null;
  } catch {
    return null;
  }
}

async function onEngineReady(): Promise<void> {
  for (const p of registry.all()) {
    if (p.voice.status === 'ready') continue;
    const speaker = await resolveVoice(p.voice.requested);
    p.voice.resolvedSpeaker = speaker;
    p.voice.status = speaker === null ? 'voice_unavailable' : 'ready';
    store.append({ type: 'presence', from: p.participantId, name: p.assignedName, text: `voice:${p.voice.status}` });
    if (speaker !== null) buildAckPool(p.participantId, speaker);
  }
}

// ---- FillerEngine(S6): 相槌は事前合成プールのみ。動的合成は本応答だけ ----
const ACK_TEXTS = ['ん、見てみるね。', 'うん、ちょっと待ってて。', 'はーい、確認するね。'];
const ackPools = new Map<string, string[]>();
let ackRotate = 0;

function buildAckPool(pid: string, speaker: number): void {
  if (ackPools.has(pid)) return;
  ackPools.set(pid, []);
  for (const text of ACK_TEXTS) {
    enqueueJob({ pid, priority: 3, kind: 'ack-pool', text, speaker });
  }
}

function fireAck(target: string, turnId: string | undefined): void {
  const p = registry.get(target);
  const pool = ackPools.get(target) ?? [];
  if (!p || p.voice.status !== 'ready' || pool.length === 0 || engineState !== 'ready') return;
  const text = ACK_TEXTS[ackRotate % ACK_TEXTS.length];
  const audio = pool[ackRotate % pool.length];
  ackRotate++;
  store.append({ type: 'agent_speech', from: target, name: p.assignedName, text, audio, filler: 'ack', turnId });
}

// ---- TtsScheduler(S5): participant 内 FIFO、participant 間は (priority, round-robin) ----
type SynthJob = { pid: string; priority: 1 | 2 | 3; kind: 'speech' | 'ack-pool'; text: string; speaker?: number; turnId?: string };
const jobQueues = new Map<string, SynthJob[]>();
const rrOrder: string[] = [];
let pumping = false;

function enqueueJob(job: SynthJob): void {
  const q = jobQueues.get(job.pid) ?? [];
  if (job.kind === 'speech' && q.filter((j) => j.kind === 'speech').length >= 20) {
    const p = registry.get(job.pid);
    store.append({ type: 'agent_speech', from: job.pid, name: p?.assignedName, text: job.text, audio: null, turnId: job.turnId });
    return; // per-participant 上限: 古い順でなく新規を text-only(FIFO 順序を保つ)
  }
  q.push(job);
  jobQueues.set(job.pid, q);
  if (!rrOrder.includes(job.pid)) rrOrder.push(job.pid);
  void pump();
}

function pickNext(): SynthJob | null {
  let best: { pid: string; prio: number } | null = null;
  for (const pid of rrOrder) {
    const head = jobQueues.get(pid)?.[0];
    if (!head) continue;
    if (!best || head.priority < best.prio) best = { pid, prio: head.priority };
  }
  if (!best) return null;
  rrOrder.push(...rrOrder.splice(rrOrder.indexOf(best.pid), 1)); // 使った participant を末尾へ(round-robin)
  return jobQueues.get(best.pid)!.shift()!;
}

async function runJob(job: SynthJob): Promise<void> {
  const p = registry.get(job.pid);
  const speaker = job.speaker ?? p?.voice.resolvedSpeaker ?? null;
  const emitSpeech = (audio: string | null) => {
    if (job.kind === 'speech') store.append({ type: 'agent_speech', from: job.pid, name: p?.assignedName, text: job.text, audio, turnId: job.turnId });
  };
  if (engineState !== 'ready' || speaker === null) return emitSpeech(null); // S3: 未解決/down は即 text-only
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const wav = await voice.synthesizeWav(job.text, speaker);
      synthFailStreak = 0;
      if (!wav) return emitSpeech(null);
      const url = putAudio(wav, job.kind === 'ack-pool');
      if (job.kind === 'ack-pool') ackPools.get(job.pid)?.push(url);
      else emitSpeech(url);
      return;
    } catch (error) {
      synthFailStreak++;
      if (synthFailStreak >= 3 && engineState === 'ready') {
        engineState = 'down'; // S5 engineDown: fail-fast(15s 連鎖を断つ)
        store.append({ type: 'system', from: 'room', text: '声がうまく出せない。復旧するまで文字で続けるね' });
        return emitSpeech(null);
      }
      if (attempt === 1) {
        console.error(`合成失敗(text-only): ${(error as Error).message}`);
        return emitSpeech(null);
      }
    }
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = pickNext();
      if (!job) break;
      await runJob(job);
    }
  } finally {
    pumping = false;
  }
}

function speakSentences(from: string, name: string, text: string, turnId: string | undefined): void {
  const sentences = splitSentences(text);
  sentences.forEach((sentence, i) => {
    enqueueJob({ pid: from, priority: i === 0 ? 1 : 2, kind: 'speech', text: sentence, turnId });
  });
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
  // gone 含む全員に配送(inbox に積まれ、復帰後の listen で再配送される — S1 at-least-once)
  const targets = registry.all().map((p) => p.participantId);
  const ev = store.append({
    type: 'user_speech', from: 'user', text,
    turnId: `T${++turnSeq}`, targets, routing: { method: 'default' },
  });
  // S6: t=0 相槌。複数 target の turn は ack 無効(単独 target のみ)
  if (targets.length === 1) fireAck(targets[0], ev.turnId);
  return ev;
}

// ---- token(room.json 書込み。atomic 化・単一性は 3A-1b)----
const token = randomBytes(24).toString('hex');
const stateDir = join(homedir(), '.talkingclaw');
const playedIds = new Set<number>(); // S4: floor 集計(4A)用の再生完了記録

function authed(req: IncomingMessage, url: URL): boolean {
  if (req.method === 'GET') return url.searchParams.get('token') === token;
  return req.headers['x-room-token'] === token;
}

// S9: Host = port 除去後の完全一致(欠如は deny — DNS rebinding 対策)。
// Origin は存在時のみ自 origin 一致(curl / proxy の欠如は許可 — cross-site fetch 対策)。
function originOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  return true;
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
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (!originOk(req)) return json(res, 403, { error: 'Host/Origin が不正です' });

  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, { app: 'talkingclaw-room', version: '0.1.0', bootId: store.bootId, port: PORT });
  }
  if (req.method === 'GET' && path === '/') {
    // S8/S9: token 配布の唯一の経路 = このページへの埋め込み(no-store)
    const html = (await readFile(fileURLToPath(new URL('../public/room.html', import.meta.url)), 'utf8'))
      .replace('__ROOM_TOKEN__', token)
      .replace('__BOOT_ID__', store.bootId);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    });
    return res.end(html);
  }
  if (req.method === 'GET' && path === '/room.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(await readFile(fileURLToPath(new URL('../public/room.js', import.meta.url))));
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
    if (engineState === 'ready' && p.voice.status !== 'ready') {
      const speaker = await resolveVoice(p.voice.requested);
      p.voice.resolvedSpeaker = speaker;
      p.voice.status = speaker === null ? 'voice_unavailable' : 'ready';
      if (speaker !== null) buildAckPool(p.participantId, speaker);
    }
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

  if (path === '/metrics') {
    // S10: ブラウザ計測(stt_final_delay 等)を JSONL に蓄積
    const kind = String(body.kind ?? '').slice(0, 40);
    const ms = Number(body.ms);
    if (!kind || !Number.isFinite(ms)) return json(res, 400, { error: 'kind と ms が必要です' });
    appendFileSync(join(stateDir, 'metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, ms }) + '\n', { mode: 0o600 });
    return json(res, 200, { ok: true });
  }

  if (path === '/played') {
    // S4/S10: 再生完了通知(floor 集計は 4A で使用)
    const eventId = Number(body.eventId);
    if (!Number.isFinite(eventId)) return json(res, 400, { error: 'eventId が必要です' });
    playedIds.add(eventId);
    return json(res, 200, { ok: true });
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
    return json(res, 200, { status: engineState === 'ready' && p.voice.status === 'ready' ? 'ok' : 'text_only' });
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
  // S8: token 生成物の書出しは bind 成功後のみ + tmp→rename の atomic(敗者は一切触れない)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = join(stateDir, `room.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify({
    port: PORT, token, pid: process.pid, pidStartedAt: Date.now(), bootId: store.bootId,
  }), { mode: 0o600 });
  renameSync(tmp, join(stateDir, 'room.json'));
  console.error(`talkingclaw room: http://127.0.0.1:${PORT}(bootId ${store.bootId.slice(0, 8)})`);
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`部屋は既に起動しています: http://127.0.0.1:${PORT}/`);
    process.exit(0); // S8: bind 敗者は正常終了
  }
  throw e;
});
