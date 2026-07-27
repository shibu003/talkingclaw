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
import { EventStore, Registry, kanaNormalize, type RoomEvent } from './roomcore.ts';
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
  buildNarrationPool();
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
// ナレーション(未達通知等)= まお/ノーマル固定(S6)。engineReady で合成
const NARRATION_TEXT = '呼んだ相手は今手が離せないみたい。届いたら読んでもらうね';
const narrationPool: string[] = [];

function buildNarrationPool(): void {
  if (narrationPool.length > 0) return;
  void resolveVoice('まお/ノーマル').then((speaker) => {
    if (speaker !== null) enqueueJob({ pid: '__narration__', priority: 3, kind: 'ack-pool', text: NARRATION_TEXT, speaker });
  });
}

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
// stale drop: user 発話ごとに speechEpoch を進め、古い epoch の speech job は合成せず text-only で流す。
// テキストは transcript に残る(不喪失)が、遅れた読み上げで会話がズレるのを防ぐ。
let speechEpoch = 0;
type SynthJob = { pid: string; priority: 1 | 2 | 3; kind: 'speech' | 'ack-pool'; text: string; speaker?: number; turnId?: string; epoch?: number };
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
  if (job.kind === 'speech' && job.epoch !== speechEpoch) return emitSpeech(null); // stale drop: 新 user 発話より前の未合成分
  if (engineState !== 'ready' || speaker === null) return emitSpeech(null); // S3: 未解決/down は即 text-only
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const wav = await voice.synthesizeWav(job.text, speaker);
      synthFailStreak = 0;
      if (!wav) return emitSpeech(null);
      const url = putAudio(wav, job.kind === 'ack-pool');
      if (job.kind === 'ack-pool') {
        if (job.pid === '__narration__') narrationPool.push(url);
        else ackPools.get(job.pid)?.push(url);
      }
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
    enqueueJob({ pid: from, priority: i === 0 ? 1 : 2, kind: 'speech', text: sentence, turnId, epoch: speechEpoch });
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
  for (const e of events) {
    if (e.type === 'user_speech' && e.turnId) { const t = turns.get(e.turnId); if (t && t.target === pid) t.delivered = true; }
  }
  const stripped = events.map(({ audio, ...rest }) => rest); // S2: agent 応答から audio 除去
  return { status: 'speech', bootId: store.bootId, truncated, events: stripped, cursor: events[events.length - 1].id };
}

store.onAppend((ev) => {
  if (ev.type === 'agent_speech' && !ev.filler && ev.audio === null && ev.from !== 'room') floorAdvance(ev.from); // S4
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
// ---- Router(S4/4A-1): 名前 > UI 選択 > floor > last_responder > default(クロエ)----
let selectedPid: string | null = null;
let floorOwner: string | null = null;
let lastResponder: string | null = null;

type Turn = { turnId: string; target: string; delivered: boolean; responded: boolean; noticeSent: boolean };
const turns = new Map<string, Turn>();

function trackTurn(turnId: string, target: string): void {
  turns.set(turnId, { turnId, target, delivered: false, responded: false, noticeSent: false });
  if (turns.size > 200) turns.delete(turns.keys().next().value as string);
}

// speak の turnId 省略時: 配送済み・未応答の最古 turn(無ければ最新の自分宛 turn)— S4
function attributeTurn(pid: string, explicit: string | undefined): string | undefined {
  if (explicit === 'none') return 'none';
  if (explicit) { markResponded(explicit); return explicit; }
  let latest: string | undefined;
  for (const t of turns.values()) {
    if (t.target !== pid) continue;
    latest = t.turnId;
    if (t.delivered && !t.responded) { markResponded(t.turnId); return t.turnId; }
  }
  if (latest) markResponded(latest);
  return latest;
}

function markResponded(turnId: string): void {
  const t = turns.get(turnId);
  if (t) t.responded = true;
}

function floorAdvance(pid: string): void {
  floorOwner = pid;
  lastResponder = pid;
}

function routeTargets(text: string): { targets: string[]; routing: RoomEvent['routing'] } {
  const head = kanaNormalize(text.slice(0, 12));
  let best: { pid: string; alias: string } | null = null;
  for (const p of registry.all()) {
    if (!registry.alive(p)) continue; // gone は名前マッチ候補から除外(ghost 対策。作業中 = active はマッチ)
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
    const p = registry.get(pid);
    return p !== undefined && registry.alive(p); // S4: gone は floor/last_responder から自然解除
  };
  if (aliveTarget(selectedPid)) return { targets: [selectedPid!], routing: { method: 'selection' } };
  if (aliveTarget(floorOwner)) return { targets: [floorOwner!], routing: { method: 'floor' } };
  if (aliveTarget(lastResponder)) return { targets: [lastResponder!], routing: { method: 'last_responder' } };
  if (chloePid && registry.get(chloePid)) return { targets: [chloePid], routing: { method: 'default' } };
  return { targets: registry.all().map((p) => p.participantId), routing: { method: 'default' } };
}

function userSpeech(text: string): RoomEvent {
  speechEpoch++; // stale drop: これ以前に積まれた speech job は読み上げない
  const { targets, routing } = routeTargets(text);
  const turnId = `T${++turnSeq}`;
  const ev = store.append({ type: 'user_speech', from: 'user', text, turnId, targets, routing });
  if (targets.length === 1) {
    trackTurn(turnId, targets[0]);
    fireAck(targets[0], turnId); // S6: t=0 相槌(単独 target のみ)
    scheduleUndeliveredNotice(turnId, targets[0]);
  }
  return ev;
}

// S4: routed 先に 6s 以内に配送されなければ未達通知(1 回・ナレーション)+ floor 解除
function scheduleUndeliveredNotice(turnId: string, target: string): void {
  if (target === chloePid) return; // in-process は即配送
  const timer = setTimeout(() => {
    const t = turns.get(turnId);
    if (!t || t.delivered || t.noticeSent) return;
    t.noticeSent = true;
    store.append({
      type: 'agent_speech', from: 'room', name: 'ナレーション',
      text: '呼んだ相手は今手が離せないみたい。届いたら読んでもらうね',
      audio: narrationPool[0] ?? null, filler: 'status', turnId,
    });
    if (floorOwner === target) floorOwner = null;
  }, 6_000);
  timer.unref();
}

// ---- 内蔵クロエ(3C): Brain を in-process participant として部屋に接続 ----
import { Brain } from './brain.ts';

let chloePid: string | null = null;
const TIMEOUT = Symbol('timeout');
function timeoutMarker(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((r) => setTimeout(() => r(TIMEOUT), ms));
}

function startChloe(): void {
  const outcome = registry.join(config.character.name, '', store.lastId, store.bootId);
  if ('error' in outcome) return console.error(`クロエ参加失敗: ${outcome.error}`);
  const chloe = outcome.participant;
  chloePid = chloe.participantId;
  const keepAlive = setInterval(() => { chloe.lastSeen = Date.now(); }, 30_000); // in-process = 常時 active
  keepAlive.unref();
  store.append({ type: 'presence', from: chloePid, name: chloe.assignedName, text: 'joined' });
  if (engineState === 'ready') {
    // engineReady がクロエ join より先に発火していた場合の取りこぼし防止
    void resolveVoice('').then((speaker) => {
      if (speaker === null) return;
      chloe.voice.resolvedSpeaker = speaker;
      chloe.voice.status = 'ready';
      buildAckPool(chloePid!, speaker);
    });
  }

  let brain = new Brain({ systemPrompt: config.systemPrompt, model: config.model });
  const inbox: RoomEvent[] = [];
  let busy = false;

  const speakStreamed = (turnId: string | undefined): ((sentence: string) => void) => {
    let first = true;
    return (sentence) => {
      if (first && turnId) markResponded(turnId);
      enqueueJob({ pid: chloePid!, priority: first ? 1 : 2, kind: 'speech', text: sentence, turnId, epoch: speechEpoch });
      first = false;
    };
  };

  // ask を 60s で見張り、interrupt → 10s 待って駄目なら Brain 再生成(S3C: default 応答者が死なない)
  async function askGuarded(text: string, turnId: string | undefined): Promise<void> {
    const hang = process.env.ROOM_TEST_HOOKS === '1' && text.includes('__hang__');
    const ask = hang ? new Promise<string>(() => {}) : brain.ask(text, speakStreamed(turnId));
    if ((await Promise.race([ask, timeoutMarker(60_000)])) !== TIMEOUT) return;
    console.error('クロエの応答が 60s 超過 → interrupt');
    if (!hang) await brain.interrupt().catch(() => {});
    if ((await Promise.race([ask.catch(() => ''), timeoutMarker(10_000)])) !== TIMEOUT) return;
    void brain.close().catch(() => {});
    brain = new Brain({ systemPrompt: config.systemPrompt, model: config.model });
    store.append({ type: 'system', from: 'room', text: 'クロエの接続を作り直したよ。少し前の話は忘れちゃったかも' });
    store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、ちょっと固まってた。もう一回言ってくれる?', audio: null, turnId });
  }

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (inbox.length > 0) {
        const ev = inbox.shift()!;
        await askGuarded(ev.text ?? '', ev.turnId).catch((e: Error) => {
          store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: `ごめん、エラーが出ちゃった。${e.message}`, audio: null, turnId: ev.turnId });
        });
      }
    } finally {
      busy = false;
    }
  }

  store.onAppend((ev) => {
    if (ev.type === 'user_speech' && ev.targets?.includes(chloePid!)) {
      if (ev.turnId) { const t = turns.get(ev.turnId); if (t) t.delivered = true; } // in-process = 即配送
      inbox.push(ev);
      void drain();
    }
  });

  // greeting = Brain warmup(初回コールドスタートを起動時に消化)
  void askGuarded('(ユーザーが声の部屋に来られるようになった。あなたらしく短く一言で挨拶して)', undefined)
    .then(() => console.error('クロエ warmup 完了'));
}

if (process.env.NO_CHLOE !== '1') startChloe();

// ---- token(room.json 書込み。atomic 化・単一性は 3A-1b)----
const token = randomBytes(24).toString('hex');
const stateDir = join(homedir(), '.talkingclaw');
const playedIds = new Set<number>(); // S4: floor 集計(4A)用の再生完了記録
const seenSpeakSeqs = new Map<string, Set<string>>(); // S2: speak 冪等(participant 毎)

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
    const html = (await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8'))
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

  if (path === '/select') {
    const pid = body.participantId === null ? null : String(body.participantId ?? '');
    if (pid !== null && !registry.get(pid)) return json(res, 400, { error: '不明な participant です' });
    selectedPid = pid;
    store.append({ type: 'system', from: 'room', text: pid ? `話し相手を ${registry.get(pid)!.assignedName} にしたよ` : '話し相手の指定を外したよ' });
    return json(res, 200, { ok: true, selected: selectedPid });
  }

  if (path === '/played') {
    // S4/S10: 再生完了通知(floor 集計は 4A で使用)
    const eventId = Number(body.eventId);
    if (!Number.isFinite(eventId)) return json(res, 400, { error: 'eventId が必要です' });
    playedIds.add(eventId);
    const ev = store.get(eventId);
    if (ev && ev.type === 'agent_speech' && !ev.filler && ev.from !== 'room') floorAdvance(ev.from); // S4: 再生完了基準
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
    // S2: 冪等 — recovering 後の再試行で二重発話しない
    const clientSeq = body.clientSeq === undefined ? null : String(body.clientSeq);
    if (clientSeq !== null) {
      const seen = seenSpeakSeqs.get(p.participantId) ?? new Set<string>();
      if (seen.has(clientSeq)) return json(res, 200, { status: 'ok', deduped: true });
      seen.add(clientSeq);
      if (seen.size > 200) seen.delete(seen.values().next().value as string);
      seenSpeakSeqs.set(p.participantId, seen);
    }
    const resolvedTurn = attributeTurn(p.participantId, body.turnId ? String(body.turnId) : undefined);
    speakSentences(p.participantId, p.assignedName, text, resolvedTurn === 'none' ? undefined : resolvedTurn);
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
