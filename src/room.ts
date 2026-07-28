// 声の部屋 daemon(3A-1a-i: EventStore + HTTP core + token 認証 + inline TTS)。
// S8 の単一性強化・S9 の Host/Origin 検証等は 3A-1b、ページ配信は 3A-1c で拡張する。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { archiveIndexTail, archiveRead, archiveSession, markArchiveBaseline } from './archive.ts';
import { EventStore, Registry, kanaNormalize, type Channel, type RoomEvent } from './roomcore.ts';
import { Voice, splitSentences } from './voice.ts';

const PORT = Number(process.env.PORT ?? 3300);
const LISTEN_MAX_S = 48; // S2: server 内部 deadline 上限
const TEXT_MAX = 4000;
const BODY_MAX = 64 * 1024;

const store = new EventStore();
const registry = new Registry();
const voice = new Voice(config.tts);

// ---- 部屋分割(会話コンテキストの分離): 作業部屋 / 雑談部屋 ----
// 単一の EventStore は共有したまま、event に channel を付け会話の記憶(Brain)と transcript だけを隔てる。
// 「今どちらの部屋にいるか」は単一の activeChannel(部屋全体で 1 つ。/channel で切替)。
const CHANNELS = ['work', 'chat'] as const;
const ROOM_LABEL: Record<Channel, string> = { work: '作業部屋', chat: '雑談部屋' };
let activeChannel: Channel = 'work';
function isChannel(v: unknown): v is Channel {
  return v === 'work' || v === 'chat';
}

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
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { existsSync } from 'node:fs';

let engineState: 'starting' | 'ready' | 'down' = 'starting';
let engineChild: ChildProcess | null = null;
let engineSpawnedAt = 0;
const engineSpawnLog: number[] = [];
let synthFailStreak = 0;

// W9-0: 生死判定は 3 値。timeout(= 合成でビジーの可能性)と refused(= 本当に死亡)を区別する
type EngineProbe = 'ok' | 'busy' | 'refused';
async function engineProbe(): Promise<EngineProbe> {
  try {
    const r = await fetch(`${config.tts.url}/version`, { signal: AbortSignal.timeout(6000) });
    return r.ok ? 'ok' : 'busy'; // HTTP エラーでも応答はある = 生きている
  } catch (error) {
    return (error as Error).name === 'TimeoutError' ? 'busy' : 'refused';
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
  const startedAt = Date.now();
  engineChild.on('exit', (code) => {
    // 起動直後の即死(= 既に別インスタンスが port を握っている)は rate-limit から返却する
    if (Date.now() - startedAt < 10_000 && code !== 0) {
      const i = engineSpawnLog.lastIndexOf(now);
      if (i >= 0) engineSpawnLog.splice(i, 1);
      store.append({ type: 'system', from: 'room', text: '音声エンジンは既に動いてるみたい(二重起動を取り消したよ)' });
    }
  });
  console.error('AivisSpeech engine を起動中…');
}

let probeFailStreak = 0;

function enginePortOccupied(): boolean {
  const port = new URL(config.tts.url).port || '10101';
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false; // lsof が無い/該当なし → 空きとみなす
  }
}

async function engineLoop(): Promise<void> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    // 合成中は判定しない — 単一ロックでビジーなだけの生きたエンジンを殺さない(W9-0)
    if (pumping) { probeFailStreak = 0; continue; }

    const probe = await engineProbe();
    if (probe === 'ok') {
      probeFailStreak = 0;
      if (engineState !== 'ready') {
        engineState = 'ready';
        synthFailStreak = 0;
        console.error('AivisSpeech ready');
        store.append({ type: 'system', from: 'room', text: '声の準備ができたよ' });
        await onEngineReady();
      }
      continue;
    }

    probeFailStreak++;
    if (probeFailStreak < 3) continue; // 連続 3 回(≈15-20s)までは様子見

    if (probe === 'busy') {
      // 応答が遅いだけ = 生きている。原則 spawn しない。ただし 2 分超の完全無応答は wedged
      if (probeFailStreak >= 24 && Date.now() - engineSpawnedAt > 150_000) {
        console.error('AivisSpeech が長時間無応答 → 自分の子のみ再起動');
        if (engineChild && engineChild.exitCode === null) { engineChild.kill('SIGTERM'); engineChild = null; }
        probeFailStreak = 0;
        spawnEngine();
      }
      continue;
    }

    // refused でも port を誰かが握っているなら soft 扱い(起動途中 / 別アプリ)— ultraplan 精製
    if (enginePortOccupied()) { continue; }

    // 接続拒否 かつ port 空き = 本当に死んだ
    if (engineState === 'ready') {
      engineState = 'down';
      store.append({ type: 'system', from: 'room', text: '音声エンジンが落ちたみたい。しばらく文字だけで続けるね' });
    }
    if (Date.now() - engineSpawnedAt < 150_000) continue; // 起動猶予(SP5 実測 ×1.5)
    probeFailStreak = 0;
    spawnEngine();
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

// ---- UserSpeechState: 「ユーザーが今話しているか」の単一の状態源 ----
// ブラウザの STT interim 結果を /speech-state で報告させて保持する。AI 側の音声出力(TtsScheduler の
// pump / filler escalation)はこれを見て、ユーザーが話し終わるまで先に進めない。/participants で読めるので
// 画面状態を認知したい他機能からも再利用できる。client からの更新が途切れても STALE_MS で自動解除(deadlock 防止)。
let userSpeaking = false;
let userSpeakingAt = 0;
const USER_SPEAKING_STALE_MS = 4_000;
function isUserSpeaking(): boolean {
  return userSpeaking && Date.now() - userSpeakingAt < USER_SPEAKING_STALE_MS;
}
function waitUntilUserDone(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!isUserSpeaking()) return resolve();
      setTimeout(check, 200);
    };
    check();
  });
}

// ---- FillerEngine(S6): 相槌は事前合成プールのみ。動的合成は本応答だけ ----
const ACK_TEXTS = ['ん、見てみるね。', 'うん、ちょっと待ってて。', 'はーい、確認するね。'];
const ackPools = new Map<string, string[]>();
let ackRotate = 0;
const lastAckAt = new Map<string, number>(); // 実機フィードバック: 相槌の連発防止
// ナレーション(未達通知・状況報告)= まお/ノーマル固定(S6)。engineReady で合成
const NARRATION_TEXTS = {
  undelivered: '呼んだ相手は今手が離せないみたい。届いたら読んでもらうね',
  status: 'まだ作業中みたい。もう少し待ってね',
} as const;
const narrationAudio = new Map<string, string>(); // key → /audio path
const narrationPool: string[] = []; // 後方互換(未達通知 = undelivered)

function buildNarrationPool(): void {
  if (narrationAudio.size > 0) return;
  void resolveVoice('まお/ノーマル').then((speaker) => {
    if (speaker === null) return;
    for (const [key, text] of Object.entries(NARRATION_TEXTS)) {
      enqueueJob({ pid: `__narration_${key}__`, priority: 3, kind: 'ack-pool', text, speaker, channel: 'work' }); // ack-pool は事前合成のみ・channel は不使用
    }
  });
}

// 文脈 filler(target の声・事前合成)— S6
const CONTEXT_TEXTS = ['ん、いま考えてるところ。', 'ちょっと確認してるね。'];
const contextPools = new Map<string, string[]>();

function buildAckPool(pid: string, speaker: number): void {
  if (ackPools.has(pid)) return;
  ackPools.set(pid, []);
  for (const text of ACK_TEXTS) enqueueJob({ pid, priority: 3, kind: 'ack-pool', text, speaker, channel: 'work' }); // ack-pool は事前合成のみ・channel は不使用
  for (const text of CONTEXT_TEXTS) enqueueJob({ pid: `__context_${pid}__`, priority: 3, kind: 'ack-pool', text, speaker, channel: 'work' });
}

function fireAck(target: string, turnId: string | undefined, utterance = ''): void {
  const p = registry.get(target);
  const pool = ackPools.get(target) ?? [];
  if (!p || !registry.alive(p)) return; // gone の相手の声で相槌しない(偽生存の防止)
  if (p.voice.status !== 'ready' || pool.length === 0 || engineState !== 'ready') return;
  if (utterance.length <= 4) return; // 「はい」等の短い発話に相槌は不要
  if (Date.now() - (lastAckAt.get(target) ?? 0) < 8_000) return; // 連発防止
  lastAckAt.set(target, Date.now());
  ackRotate += 1 + Math.floor(Math.random() * ACK_TEXTS.length); // 機械的ローテを崩す
  const text = ACK_TEXTS[ackRotate % ACK_TEXTS.length];
  const audio = pool[ackRotate % pool.length];
  const ackEv = store.append({ type: 'agent_speech', from: target, name: p.assignedName, text, audio, filler: 'ack', turnId, channel: turnChannel(turnId) });
  metric('ack_emitted', { turnId, eventId: ackEv.id });
}

// ---- TtsScheduler(S5): participant 内 FIFO、participant 間は (priority, round-robin) ----
// stale drop: user 発話ごとに speechEpoch を進め、古い epoch の speech job は合成せず text-only で流す。
// テキストは transcript に残る(不喪失)が、遅れた読み上げで会話がズレるのを防ぐ。
let speechEpoch = 0;
type SynthJob = { pid: string; priority: 1 | 2 | 3; kind: 'speech' | 'ack-pool'; text: string; speaker?: number; turnId?: string; epoch?: number; channel: Channel };
const jobQueues = new Map<string, SynthJob[]>();
const rrOrder: string[] = [];
let pumping = false;

function enqueueJob(job: SynthJob): void {
  const q = jobQueues.get(job.pid) ?? [];
  if (job.kind === 'speech' && q.filter((j) => j.kind === 'speech').length >= 20) {
    const p = registry.get(job.pid);
    store.append({ type: 'agent_speech', from: job.pid, name: p?.assignedName, text: job.text, audio: null, turnId: job.turnId, channel: job.channel });
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
    if (job.kind === 'speech') store.append({ type: 'agent_speech', from: job.pid, name: p?.assignedName, text: job.text, audio, turnId: job.turnId, channel: job.channel });
  };
  // stale drop: 2 世代以上前の未合成分だけ捨てる。直前の返事は相槌で消さない
  // (本当の割り込みはブラウザ側の barge-in が担当する)
  if (job.kind === 'speech' && job.epoch !== undefined && job.epoch < speechEpoch - 1) return emitSpeech(null);
  if (engineState !== 'ready' || speaker === null) return emitSpeech(null); // S3: 未解決/down は即 text-only
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const wav = await voice.synthesizeWav(job.text, speaker);
      synthFailStreak = 0;
      if (!wav) return emitSpeech(null);
      const url = putAudio(wav, job.kind === 'ack-pool');
      if (job.kind === 'ack-pool') {
        if (job.pid.startsWith('__narration_')) {
          const key = job.pid.slice('__narration_'.length, -2);
          narrationAudio.set(key, url);
          if (key === 'undelivered') narrationPool.push(url);
        } else if (job.pid.startsWith('__context_')) {
          const pid = job.pid.slice('__context_'.length, -2);
          const pool = contextPools.get(pid) ?? [];
          pool.push(url);
          contextPools.set(pid, pool);
        } else ackPools.get(job.pid)?.push(url);
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
      await waitUntilUserDone(); // ユーザー発話中は AI 側の音声(本応答・filler 問わず)を先に進めない
      await runJob(job);
    }
  } finally {
    pumping = false;
  }
}

function speakSentences(from: string, name: string, text: string, turnId: string | undefined, channel: Channel): void {
  const sentences = splitSentences(text);
  sentences.forEach((sentence, i) => {
    enqueueJob({ pid: from, priority: i === 0 ? 1 : 2, kind: 'speech', text: sentence, turnId, epoch: speechEpoch, channel });
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
    if (e.type === 'user_speech' && e.turnId) { const t = turns.get(e.turnId); if (t && t.target === pid && !t.delivered) { t.delivered = true; metric('turn_delivered', { turnId: e.turnId }); } }
  }
  const stripped = events.map(({ audio, ...rest }) => rest); // S2: agent 応答から audio 除去
  return { status: 'speech', bootId: store.bootId, truncated, events: stripped, cursor: events[events.length - 1].id };
}

store.onAppend((ev) => {
  const ch = ev.channel ?? 'work';
  if (ev.type === 'user_speech') transcriptAppend(ch, 'あなた', ev.text ?? '');
  else if (ev.type === 'agent_speech' && !ev.filler && ev.text) transcriptAppend(ch, ev.name ?? ev.from, ev.text);
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

type Turn = { turnId: string; target: string; text: string; delivered: boolean; responded: boolean; noticeSent: boolean; channel: Channel };
const turns = new Map<string, Turn>();

function trackTurn(turnId: string, target: string, text: string, channel: Channel): void {
  for (const t of turns.values()) {
    if (t.target === target && !t.responded) cancelEscalation(t.turnId); // 新 turn が旧 escalation を supersede
  }
  turns.set(turnId, { turnId, target, text, delivered: false, responded: false, noticeSent: false, channel });
  if (turns.size > 200) turns.delete(turns.keys().next().value as string);
}

// turn に紐づく channel(ack/filler/未達通知/外部 participant の返信など、turn 経由で発話する箇所が参照)。
// turn が無い(turnId 'none'/未指定 = 実況等の unprompted 発話)は常に 'work' 扱い(部屋分割の既定: 雑談部屋に実況を漏らさない)
function turnChannel(turnId: string | undefined): Channel {
  const t = turnId ? turns.get(turnId) : undefined;
  return t?.channel ?? 'work';
}

// speak の turnId 省略時: 配送済み・未応答の最古 turn(無ければ最新の自分宛 turn)— S4
function attributeTurn(pid: string, explicit: string | undefined): string | undefined {
  if (explicit === 'none') return 'none';
  if (explicit) { markResponded(explicit); return explicit; }
  let latest: string | undefined;
  for (const t of turns.values()) {
    if (t.target !== pid) continue;
    latest = t.turnId;
    // 窓を閉じた turn(打切り/未達)は自動帰属から除外 — 以降の返信は明示 turnId の領分
    if (t.delivered && !t.responded && !t.noticeSent) { markResponded(t.turnId); return t.turnId; }
  }
  if (latest) markResponded(latest);
  return latest;
}

function markResponded(turnId: string): void {
  const t = turns.get(turnId);
  if (t && !t.responded) {
    t.responded = true;
    cancelEscalation(turnId);
    metric('turn_window_closed', { turnId, reason: 'responded' });
  }
}

function floorAdvance(pid: string): void {
  floorOwner = pid;
  lastResponder = pid;
}

function routeTargets(text: string): { targets: string[]; routing: RoomEvent['routing'] } {
  const head = kanaNormalize(text.slice(0, 12));
  let best: { pid: string; alias: string } | null = null;
  for (const p of registry.all()) {
    // ghost(suffix ephemeral)の gone だけ除外。本物(canonical)の gone は名指し可
    // → inbox に積まれ復帰後に再配送 + 未達通知が出る(v6.1 修正)
    if (!registry.alive(p) && p.ephemeral) continue;
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
  userSpeaking = false; // 発話がここまで届いた = この turn の「発話中」は終了(client 側 false 通知の到着順に依存しない)
  // W8-8: 許可待ち中の短い諾否はパーミッションへの返答として扱う
  if (pendingPermission) {
    const t = text.trim();
    if (PERM_YES.test(t)) {
      const ev = store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' }, channel: activeChannel });
      finishPermission(true, 'おっけー、許可したよ。続けるね。');
      return ev;
    }
    if (PERM_NO.test(t)) {
      const ev = store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' }, channel: activeChannel });
      finishPermission(false, 'わかった、それはやめておくね。');
      return ev;
    }
  }
  if (process.env.ROOM_TEST_HOOKS === '1' && text === '__askperm__') {
    void askUserPermission('テスト機能').then((ok) => store.append({ type: 'system', from: 'room', text: `perm:${ok}` }));
    return store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' }, channel: activeChannel });
  }
  speechEpoch++; // stale drop: これ以前に積まれた speech job は読み上げない
  const { targets, routing } = routeTargets(text);
  const turnId = `T${++turnSeq}`;
  const ev = store.append({ type: 'user_speech', from: 'user', text, turnId, targets, routing, channel: activeChannel });
  metric('turn_created', { turnId, method: routing?.method, targets: targets.length });
  if (targets.length === 1) {
    trackTurn(turnId, targets[0], text, activeChannel);
    fireAck(targets[0], turnId, text); // S6: t=0 相槌(単独 target のみ)
    scheduleEscalation(turnId, targets[0], 1, 3_500); // /played で前倒し、無ければ fallback
    scheduleUndeliveredNotice(turnId, targets[0]);
  }
  return ev;
}

// ---- W8-8: 音声パーミッション(allow-list 外のツールを声で許可/拒否)----
let pendingPermission: { resolve: (ok: boolean) => void; timer: NodeJS.Timeout; desc: string } | null = null;

function askUserPermission(desc: string): Promise<boolean> {
  if (pendingPermission) return Promise.resolve(false); // 同時 1 件のみ
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishPermission(false, '返事がなかったから見送ったよ。'), 60_000);
    timer.unref();
    pendingPermission = { resolve, timer, desc };
    store.append({ type: 'system', from: 'room', text: `許可待ち: ${desc}(「いいよ」/「だめ」で答えてね)` });
    if (chloePid) {
      speechEpoch++; // 直前の読み上げ待ちより優先して届ける
      enqueueJob({ pid: chloePid, priority: 1, kind: 'speech', text: `作業係が${desc}を使いたいって。許可していい?`, turnId: 'none', epoch: speechEpoch, channel: 'work' });
    }
  });
}

function finishPermission(ok: boolean, say: string): void {
  if (!pendingPermission) return;
  clearTimeout(pendingPermission.timer);
  pendingPermission.resolve(ok);
  pendingPermission = null;
  if (chloePid) enqueueJob({ pid: chloePid, priority: 1, kind: 'speech', text: say, turnId: 'none', epoch: speechEpoch, channel: 'work' });
}

const PERM_YES = /^(はい|うん|いいよ|いいですよ|おっけ|オッケー|ok|オーケー|許可|どうぞ|やって|承認)/i;
const PERM_NO = /^(だめ|ダメ|駄目|やめて|いや|嫌|不許可|禁止|no|ノー|見送)/i;

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return `コマンド実行(${String(input.command ?? '').slice(0, 50)})`;
  const m = name.match(/^mcp__([^_]+)__(.+)$/);
  if (m) return `${m[1]} の ${m[2]}`;
  return name;
}

// ---- 6B: filler escalation(S6 完全形)----
// ack →(再生終了 or fallback)→ 文脈 filler →(+5s)→ 状況報告 ×2 → 打切り(窓閉じ)
// キャンセル: 本応答 speak(markResponded)/ 同 target への新 turn / 窓閉じ
const escalations = new Map<string, NodeJS.Timeout>();
let statusRotate = 0;

function cancelEscalation(turnId: string): void {
  const t = escalations.get(turnId);
  if (t) { clearTimeout(t); escalations.delete(turnId); }
}

function scheduleEscalation(turnId: string, target: string, stage: number, delayMs: number): void {
  cancelEscalation(turnId);
  const timer = setTimeout(() => {
    escalations.delete(turnId);
    if (isUserSpeaking()) return scheduleEscalation(turnId, target, stage, 500); // ユーザーが話し続けてる間は先送り
    const t = turns.get(turnId);
    if (!t || t.responded || !t.delivered) return; // 応答済み/未配送(未達経路が担当)は終了
    const p = registry.get(target);
    if (stage === 1) {
      const pool = contextPools.get(target) ?? [];
      const ev = store.append({
        type: 'agent_speech', from: target, name: p?.assignedName,
        text: CONTEXT_TEXTS[statusRotate % CONTEXT_TEXTS.length],
        audio: pool[statusRotate % Math.max(1, pool.length)] ?? null, filler: 'context', turnId, channel: t.channel,
      });
      metric('filler_emitted', { turnId, stage, eventId: ev.id });
      scheduleEscalation(turnId, target, 2, 8_000); // /played が来れば前倒し(下の onPlayed 経由)
    } else if (stage <= 3) {
      const ev = store.append({
        type: 'agent_speech', from: 'room', name: 'ナレーション',
        text: NARRATION_TEXTS.status, audio: narrationAudio.get('status') ?? null, filler: 'status', turnId, channel: t.channel,
      });
      metric('filler_emitted', { turnId, stage, eventId: ev.id });
      if (stage < 3) scheduleEscalation(turnId, target, stage + 1, 8_000);
      else {
        store.append({ type: 'system', from: 'room', text: '返事が来たら教えるね' }); // 打切り(窓閉じ)
        metric('turn_window_closed', { turnId, reason: 'exhausted' });
        turns.get(turnId)!.noticeSent = true;
      }
    }
  }, delayMs);
  timer.unref();
  escalations.set(turnId, timer);
}

// /played で次段を前倒し(再生終了 + 5s — 相対スケジュール)
function onFillerPlayed(ev: RoomEvent): void {
  if (!ev.turnId || !ev.filler || ev.filler === 'status' && !escalations.has(ev.turnId)) return;
  const t = turns.get(ev.turnId);
  if (!t || t.responded) return;
  const stage = ev.filler === 'ack' ? 1 : ev.filler === 'context' ? 2 : 3;
  if (escalations.has(ev.turnId)) scheduleEscalation(ev.turnId, t.target, stage, 5_000);
}

// S4: routed 先に 6s 以内に配送されなければ未達通知(1 回・ナレーション)+ floor 解除
const lastNoticeAt = new Map<string, number>(); // 実機フィードバック: 通知の出過ぎ防止

function scheduleUndeliveredNotice(turnId: string, target: string): void {
  if (target === chloePid) return; // in-process は即配送
  const timer = setTimeout(() => {
    const t = turns.get(turnId);
    if (!t || t.delivered || t.noticeSent) return;
    t.noticeSent = true;
    if (Date.now() - (lastNoticeAt.get(target) ?? 0) < 60_000) return; // 同じ相手への連発防止
    lastNoticeAt.set(target, Date.now());
    store.append({
      type: 'agent_speech', from: 'room', name: 'ナレーション',
      text: '呼んだ相手は今手が離せないみたい。届いたら読んでもらうね',
      audio: narrationPool[0] ?? null, filler: 'status', turnId, channel: t.channel,
    });
    if (floorOwner === target) floorOwner = null;
  }, 12_000);
  timer.unref();
}

// ---- W10-2: ブラウザの画面状態(クロエが「今きみが見てる画面」を把握するため)----
let uiState: { preview?: string; board?: boolean; at?: string } = {};

// ---- W9-1: Bash の危険コマンド検査(自傷防止。セキュリティ境界ではない)----
function dangerousBash(command: string): boolean {
  return config.dangerousBash.some((re) => re.test(command));
}

// ---- W9-1: タスク台帳の永続化(P2: 再起動で依頼が消えないように)----
const TASKS_PATH = join(homedir(), '.talkingclaw', 'tasks.json');
function saveTasks(): void {
  try {
    mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
    const tmp = `${TASKS_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(officeTasks.slice(-50)), { mode: 0o600 });
    renameSync(tmp, TASKS_PATH);
  } catch { /* 台帳が書けなくても作業は続ける */ }
}
function loadTasks(): OfficeTask[] {
  try {
    const rows = JSON.parse(readFileSync(TASKS_PATH, 'utf8')) as OfficeTask[];
    // 前回 working のまま落ちた = worker はもういない。board が嘘をつかないよう interrupted に倒す
    return rows.map((t) => (t.status === 'working' ? { ...t, status: 'interrupted' as const } : t));
  } catch { return []; }
}

// ---- W9-2: クロエの長期記憶(daemon 再起動・Brain 再生成を跨いで残る)----
const MEMORY_PATH = join(homedir(), '.talkingclaw', 'chloe-memory.md');
const MEMORY_MAX_LINES = 100; // 肥大化対策(ultraplan 精製): 末尾 100 行だけ注入
function readMemory(): string {
  try {
    const lines = readFileSync(MEMORY_PATH, 'utf8').trim().split('\n');
    return lines.slice(-MEMORY_MAX_LINES).join('\n');
  } catch { return ''; }
}
function appendMemory(note: string): void {
  const line = `- ${new Date().toISOString().slice(0, 10)} ${note.trim().replace(/\n/g, ' ')}\n`;
  try {
    mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
    appendFileSync(MEMORY_PATH, line, { mode: 0o600 });
  } catch { /* 記憶できなくても会話は続ける */ }
}

// ---- W8-8: projects レジストリ(worker の作業先。talkingclaw 自身も登録)----
const PROJECTS_PATH = join(homedir(), '.talkingclaw', 'projects.json');
function loadProjects(): Record<string, string> {
  let user: Record<string, string> = {};
  try { user = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8')); } catch { /* 初回 */ }
  const merged = {
    workspace: config.agent.cwd,
    talkingclaw: fileURLToPath(new URL('..', import.meta.url)),
    ...user,
  };
  try { writeFileSync(PROJECTS_PATH, JSON.stringify(merged, null, 1), { mode: 0o600 }); } catch { /* */ }
  return merged;
}

// ---- W8-7: worker 設定(モデル / effort / skills / 外部 MCP)。次の task から反映 ----
const SETTINGS_PATH = join(homedir(), '.talkingclaw', 'settings.json');
type WorkerSettings = { workerModel: string; workerEffort: string; useUserSettings: boolean; chatModel: string; chatEffort: string; consultMode: boolean; autoCommit: boolean; autoPush: boolean };
function loadSettings(): WorkerSettings {
  const defaults: WorkerSettings = {
    workerModel: config.agent.model, workerEffort: '', useUserSettings: false,
    chatModel: config.model, chatEffort: '',
    consultMode: true, // 既定は相談モード: いきなり着手せず、まず進め方を相談して合意してから登録する
    autoCommit: true,  // 作業が終わったら作業先フォルダで commit まで
    autoPush: false,   // push は取り返しがつかないので、明示 ON にした時だけ
  };
  try {
    return { ...defaults, ...JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return defaults;
  }
}
let workerSettings = loadSettings();
function saveSettings(): void {
  try { writeFileSync(SETTINGS_PATH, JSON.stringify(workerSettings), { mode: 0o600 }); } catch { /* */ }
}
// 外部 MCP: ~/.talkingclaw/worker-mcp.json({ mcpServers: { name: {command, args, env?} } })
function loadWorkerMcp(): { mcpServers: Record<string, unknown>; allow: string[] } {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.talkingclaw', 'worker-mcp.json'), 'utf8'));
    const servers = (d.mcpServers ?? {}) as Record<string, unknown>;
    return { mcpServers: servers, allow: Object.keys(servers).map((n) => `mcp__${n}`) };
  } catch {
    return { mcpServers: {}, allow: [] };
  }
}

// ---- W8-2/3: office tasks(見る = board の元データ。導出 + 起票の 2 系統)----
type OfficeTask = {
  id: number; agent: string; agentName: string; request: string; project?: string;
  status: 'queued' | 'working' | 'done' | 'failed' | 'interrupted'; notes: string[]; artifacts: string[]; at: string;
};
const officeTasks: OfficeTask[] = loadTasks(); // W9-1: 台帳は再起動を跨ぐ
let taskSeq = officeTasks.reduce((m, t) => Math.max(m, t.id), 0);
const agentNotes = new Map<string, string[]>(); // 外部 agent の 'none' 実況(最新 5 件)

store.onAppend((ev) => {
  if (ev.type === 'agent_speech' && !ev.filler && ev.turnId === 'none' && ev.from !== 'room') {
    const notes = agentNotes.get(ev.from) ?? [];
    notes.push(ev.text ?? '');
    while (notes.length > 5) notes.shift();
    agentNotes.set(ev.from, notes);
  }
});

// ---- 相談モード: 依頼が来てもいきなり着手せず、まず進め方を相談して合意してから登録する ----
// 案は部屋に 1 つだけ(作業係が 1 人なので、同時に複数の相談を走らせない)。
// 合意の入口は 2 つ: クロエの confirm_plan ツールと、画面/音声からの POST /plan {action:'confirm'}。
type Plan = { summary: string; steps: string[]; project?: string; at: string };
// ponytail: 相談中の案は in-memory(daemon 再起動で消える)。まとまった案はタスク台帳に残るので、
// 永続化は「相談の途中で落ちるのが実際に困る」と分かってからでいい
let plan: Plan | null = null;
let planDelegate: ((description: string, project?: string) => OfficeTask) | null = null;

function planText(p: Plan): string {
  return p.summary + (p.steps.length > 0 ? '\n進め方:\n' + p.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '');
}
function confirmPlan(): { ok: true; taskId: number; summary: string } | { ok: false; error: string } {
  if (!plan) return { ok: false, error: 'まだ相談中の案がないよ' };
  if (!planDelegate) return { ok: false, error: '作業係の準備がまだできていないよ' };
  const p = plan;
  plan = null; // 先に空にする(二重登録防止)
  const task = planDelegate(planText(p), p.project);
  store.append({ type: 'system', from: 'room', text: `相談まとまり → 作業に登録したよ: ${p.summary.slice(0, 60)}`, channel: 'work' });
  return { ok: true, taskId: task.id, summary: p.summary };
}

// board の元データ(/tasks と /screen で共有)
function boardSnapshot(): { tasks: OfficeTask[]; open: { agent: string; agentName: string; request: string; status: string; notes: string[]; artifacts: string[] }[]; plan: Plan | null; consultMode: boolean } {
  const open = [...turns.values()]
    .filter((t) => !t.responded && !t.noticeSent && t.target !== chloePid)
    .slice(-10)
    .map((t) => ({
      agent: t.target, agentName: registry.get(t.target)?.assignedName ?? t.target,
      request: t.text, status: t.delivered ? 'working' : 'queued',
      notes: agentNotes.get(t.target) ?? [], artifacts: [],
    }));
  return { tasks: [...officeTasks].reverse().slice(0, 20), open, plan, consultMode: workerSettings.consultMode };
}

// 画面状態(/screen): 発話中/待機中の participant を、再生完了通知(/played)がまだ来ていない
// audio 付き agent_speech から近似する(ブラウザの実再生タイミングは daemon から見えないため)
function pendingSpeechSnapshot(): { participantId: string; name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const ev of store.since(Math.max(0, store.lastId - 200))) {
    if (ev.type !== 'agent_speech' || !ev.audio || playedIds.has(ev.id)) continue;
    counts.set(ev.from, (counts.get(ev.from) ?? 0) + 1);
  }
  return [...counts.entries()].map(([pid, count]) => ({ participantId: pid, name: registry.get(pid)?.assignedName ?? pid, count }));
}

// ---- 内蔵クロエ(3C): Brain を in-process participant として部屋に接続 ----
import { Brain } from './brain.ts';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

let chloePid: string | null = null;
let chloeResetWorker: (() => void) | null = null;
let chloeResetChat: (() => void) | null = null;
// W9-2: 本番は 180s(sonnet + delegate の長 turn を誤殺しない)。テストは短縮して回転を速く
// テスト時も「通常応答(context 注入込みで 20-40s)は切らず、ハングだけ捕まえる」値にする
const ASK_GUARD_MS = Number(process.env.ASK_GUARD_MS ?? (process.env.ROOM_TEST_HOOKS === '1' ? 45_000 : 180_000));
const ASK_GRACE_MS = process.env.ROOM_TEST_HOOKS === '1' ? 5_000 : 10_000;
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

  // --- W8-2: worker(実作業係)。会話 Brain とは別セッションで並行動作 ---
  mkdirSync(config.agent.cwd, { recursive: true });
  let worker: Brain | null = null;
  let workerBusy = false;
  const taskQueue: OfficeTask[] = [];

  function delegate(description: string, project?: string): OfficeTask {
    const task: OfficeTask = {
      id: ++taskSeq, agent: chloePid!, agentName: chloe.assignedName, request: description, project,
      status: 'queued', notes: [], artifacts: [], at: new Date().toISOString(),
    };
    officeTasks.push(task);
    while (officeTasks.length > 50) officeTasks.shift();
    saveTasks();
    taskQueue.push(task);
    void pumpTasks();
    return task;
  }
  planDelegate = delegate; // 相談がまとまった時の登録先(confirm_plan / POST /plan から使う)

  chloeResetChat = () => {
    for (const c of CHANNELS) {
      const cs = channelState[c];
      cs.chain = cs.chain.catch(() => {}).then(() => {
        void cs.brain.close().catch(() => {});
        cs.brain = new Brain(makeConvBrainOpts(c));
        cs.needsContext = true; // 記憶 + 直近ログを次の ask で再注入
      });
    }
    store.append({ type: 'system', from: 'room', text: `会話の設定を切り替えたよ(モデル ${workerSettings.chatModel} / 相談モード ${workerSettings.consultMode ? 'あり' : 'なし'})` });
  };

  chloeResetWorker = () => {
    if (!workerBusy && worker) { void worker.close().catch(() => {}); worker = null; }
    else if (!workerBusy) worker = null;
  };

  async function pumpTasks(): Promise<void> {
    if (workerBusy) return;
    workerBusy = true;
    try {
      while (taskQueue.length > 0) {
        const task = taskQueue.shift()!;
        task.status = 'working';
        saveTasks();
        await runTask(task);
        saveTasks();
      }
    } finally {
      workerBusy = false;
    }
  }

  let workerCwd = '';

  // ---- 作業が終わったら git に残す(相談 → 実行 → 記録 を繋ぐ)----
  // 既定はローカル commit まで。push は取り返しがつかないので ⚙ で明示 ON にした時だけ。
  // ponytail: `git add -A` は作業フォルダ全体をまとめる。同じフォルダを人や他の agent が
  // 同時に触っている時は巻き込むので、その場合は ⚙ の自動コミットを切って使う。
  const SECRET_RE = /(^|\/)(\.env|\.dev\.vars|id_rsa|[^/]*\.pem|[^/]*\.key|credentials)($|[./])/i;
  async function gitAutoCommit(task: OfficeTask, cwd: string, say: (s: string) => void): Promise<void> {
    if (!workerSettings.autoCommit) return;
    const git = async (...args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', args, { cwd, timeout: 120_000 });
      return stdout.trim();
    };
    const note = (s: string): void => {
      task.notes.push(s);
      while (task.notes.length > 20) task.notes.shift();
      store.append({ type: 'system', from: 'room', text: s, channel: 'work' });
    };
    try {
      await git('rev-parse', '--is-inside-work-tree');
    } catch { return; } // git 管理下でないフォルダは何もしない(黙って通す)
    try {
      const dirty = await git('status', '--porcelain');
      if (!dirty) return; // 変更なし = 記録することもない
      const files = dirty.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
      // .env.example のような雛形は秘密ではないので通す
      const secret = files.find((f) => SECRET_RE.test(f) && !/\.(example|sample|template)$/i.test(f));
      if (secret) { note(`秘密が混ざりそうなので commit は見送ったよ(${secret})。中身を確認してね`); return; }

      await git('add', '-A');
      const title = task.request.split('\n')[0].slice(0, 60);
      await git('commit', '-m', `${title}\n\n(声の部屋 task ${task.id})`);
      const hash = await git('rev-parse', '--short', 'HEAD');
      const head = files.slice(0, 3).join(' / ') + (files.length > 3 ? ` 他 ${files.length - 3} 件` : '');
      note(`コミットしたよ ${hash}(${head})`);

      if (!workerSettings.autoPush) return;
      try {
        await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); // upstream 無しは push しない
      } catch { note('push 先(upstream)が無いので、コミットだけにしておいたね'); return; }
      await git('push');
      const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
      note(`GitHub にも push したよ(${branch})`);
      say('コミットして push まで済ませたよ。');
    } catch (error) {
      note(`git に残せなかった: ${String(error).slice(0, 120)}`);
    }
  }

  const workerSay = (task: OfficeTask) => (sentence: string): void => {
    task.notes.push(sentence);
    while (task.notes.length > 20) task.notes.shift();
    // 実況(進捗報告)は常に作業部屋。雑談部屋にいる間は文脈に混ざらない(channel フィルタで隔離)
    enqueueJob({ pid: chloePid!, priority: 2, kind: 'speech', text: sentence, turnId: 'none', epoch: speechEpoch, channel: 'work' });
  };

  async function runTask(task: OfficeTask): Promise<void> {
    const projects = loadProjects();
    const cwd = (task.project && projects[task.project]) || config.agent.cwd;
    if (worker && workerCwd !== cwd) { void worker.close().catch(() => {}); worker = null; } // プロジェクト切替
    if (!worker) {
      workerCwd = cwd;
      const ext = loadWorkerMcp();
      const allowList = [...(config.agent.allowedTools as unknown as string[]), ...ext.allow];
      const opts = {
        systemPrompt: config.workerPrompt, model: workerSettings.workerModel,
        allowedTools: allowList,
        // W8-8/W9-1: allow-list 外は自動拒否でなく声で確認。Bash は内容が安全なら自動許可
        canUseTool: async (name: string, input: Record<string, unknown>) => {
          if (name === 'Bash' && !dangerousBash(String(input.command ?? ''))) {
            return { behavior: 'allow' as const, updatedInput: input };
          }
          const ok = await askUserPermission(describeTool(name, input));
          return ok
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: 'ユーザーが見送った。別の方法で進めるか、諦めて報告して' };
        },
        cwd, maxTurns: config.agent.maxTurns,
        ...(Object.keys(ext.mcpServers).length > 0 ? { mcpServers: ext.mcpServers } : {}),
        ...(workerSettings.useUserSettings ? { settingSources: ['user', 'project'] as ('user' | 'project')[] } : {}),
        ...(workerSettings.workerEffort ? { effort: workerSettings.workerEffort } : {}),
      };
      try {
        worker = new Brain(opts);
      } catch {
        delete (opts as Record<string, unknown>).effort; // SDK が effort 未対応でも作業は続ける
        worker = new Brain(opts);
      }
    }
    try {
      const others = officeTasks.filter((t) => t.id !== task.id && (t.status === 'queued' || t.status === 'working'));
      const brief = others.length > 0
        ? `(同じ作業場で他にも依頼が並んでる: ${others.map((t) => t.request.slice(0, 40)).join(' / ')}。同じファイルを壊し合わないよう、既存の変更を確認してから作業して)\n`
        : '';
      const askP = worker.ask(brief + task.request, workerSay(task));
      const result = await Promise.race([askP, timeoutMarker(600_000)]);
      if (result === TIMEOUT) {
        await worker.interrupt().catch(() => {});
        const grace = await Promise.race([askP.catch(() => ''), timeoutMarker(15_000)]);
        if (grace === TIMEOUT) { void worker.close().catch(() => {}); worker = null; }
        task.status = 'failed';
        store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、作業が長引きすぎたから一旦止めたよ。', audio: null, turnId: 'none', channel: 'work' });
        return;
      }
      task.status = 'done';
      const m = String(result).match(/成果物[:：]\s*(\S+)/);
      if (m) task.artifacts.push(m[1].replace(/[、。`]+$/, '').replace(/^`/, ''));
      await gitAutoCommit(task, cwd, workerSay(task)); // 出来上がりを git に残す(既定はローカル commit まで)
      // W10-4: まとめてでなく、終わったものから個別に報告する
      const head = task.request.slice(0, 24);
      enqueueJob({
        pid: chloePid!, priority: 2, kind: 'speech', turnId: 'none', epoch: speechEpoch, channel: 'work',
        text: task.artifacts.length > 0 ? `${head}、できたよ。画面に出しておくね。` : `${head}、できたよ。`,
      });
    } catch (error) {
      task.status = 'failed';
      task.notes.push(`エラー: ${(error as Error).message}`);
      store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、作業でエラーが出ちゃった。もう一回頼んでみて。', audio: null, turnId: 'none', channel: 'work' });
    }
  }

  const officeServer = createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    tools: [
      tool(
        'room_status',
        '部屋の今の状態(在室者・作業の待ち行列と進捗・ユーザーが見ている画面・声の状態)を確認する。作業状況を聞かれたら必ずこれで確認してから答えること。',
        {},
        async () => {
          const tasks = officeTasks.slice(-8).map((t, i) => ({
            request: t.request.slice(0, 60), status: t.status,
            queuePosition: t.status === 'queued' ? officeTasks.filter((x) => x.status === 'queued').indexOf(t) + 1 : undefined,
            latestNote: t.notes[t.notes.length - 1], artifacts: t.artifacts, project: t.project ?? 'workspace',
          }));
          const people = registry.all().map((p) => ({
            name: p.assignedName, presence: registry.presence(p, waiters.has(p.participantId)), voice: p.voice.status,
          }));
          return { content: [{ type: 'text', text: JSON.stringify({
            note: '作業係は 1 人だけで、タスクは 1 件ずつ順番に処理される(並行実行はしていない)。この事実に反することを言わないこと。',
            workerBusyWith: officeTasks.find((t) => t.status === 'working')?.request?.slice(0, 60) ?? null,
            consultMode: workerSettings.consultMode,
            planUnderDiscussion: plan, // 相談中の案(まだ着手していない)
            tasks, people, userScreen: uiState, engine: engineState, activeChannel,
          }, null, 1) }] };
        },
      ),
      tool(
        'remember',
        'ユーザーとの約束・好み・「今後こうして」という恒久ルールを書き留める。再起動しても思い出せる。短く 1 行で。',
        { note: z.string() },
        async ({ note }) => {
          appendMemory(note);
          return { content: [{ type: 'text', text: '覚えた。ユーザーには「覚えとくね」等と短く伝えるだけでいい。' }] };
        },
      ),
      tool(
        'propose_plan',
        '相談モードでの進め方の案。まだ着手はしない。summary は 1 行の要約、steps は具体的な手順 2〜5 個。出したらそのまま声で読み上げて「これでいい?」と確認すること。直しの要望が来たら、直した案でもう一度呼ぶ。',
        { summary: z.string(), steps: z.array(z.string()).optional(), project: z.string().optional() },
        async ({ summary, steps, project }) => {
          plan = { summary, steps: (steps ?? []).slice(0, 8), project, at: new Date().toISOString() };
          store.append({ type: 'system', from: 'room', text: `相談中の案: ${summary.slice(0, 80)}`, channel: 'work' });
          return { content: [{ type: 'text', text: `案を画面に出した。この内容を声で短く伝えて「これで進めていい?」と聞くこと。まだ作業は始まっていない。\n${planText(plan)}` }] };
        },
      ),
      tool(
        'confirm_plan',
        'ユーザーが進め方に同意したら呼ぶ。ここで初めて作業係にタスクとして登録され、着手される。同意なしに呼ばないこと。',
        {},
        async () => {
          const r = confirmPlan();
          return { content: [{ type: 'text', text: r.ok
            ? `task ${r.taskId} として登録した。ユーザーには短く「じゃあ始めるね」と伝えるだけでいい。`
            : `登録できなかった: ${r.error}。先に propose_plan で案を出すこと。` }] };
        },
      ),
      tool(
        'delegate_task',
        `開発・作成・修正などの実作業を作業係に任せる。依頼内容を具体的に 1〜2 文で渡す。project は作業先(${Object.keys(loadProjects()).join(' / ')}。省略時 workspace)。talkingclaw 自体の開発は project: "talkingclaw"。`,
        { description: z.string(), project: z.string().optional() },
        async ({ description, project }) => {
          const task = delegate(description, project);
          return { content: [{ type: 'text', text: `作業係に任せた(task ${task.id}${project ? ` / ${project}` : ''})。ユーザーには短く「やっとくね」と伝えるだけでいい。` }] };
        },
      ),
    ],
  });
  // 部屋分割: 会話 Brain は channel ごとに別インスタンス(記憶が独立 = 雑談部屋に作業の文脈が漏れない)。
  // 雑談部屋は delegate_task を使わない(雑談専用。作業依頼が来たら作業部屋に誘導する)
  // 相談モードの作法(work 部屋のみ)。ツール構成もここで切り替える:
  // 相談モード = propose_plan / confirm_plan、直行モード = delegate_task
  const CONSULT_PROMPT = `

(相談モード)作業の依頼が来ても、いきなり作業係に登録しない。まず会話で「何を・どうやって・どこまでやるか」を短く詰める。
前提が曖昧なら 1 つずつ聞く(まとめて何個も聞かない)。方向が見えたら propose_plan で案を出し、声で短く読み上げて「これで進めていい?」と確認する。
同意が取れたら confirm_plan を呼ぶ。ここで初めてタスクとして登録される。直したいと言われたら propose_plan をやり直す。同意なしに confirm_plan を呼ばないこと。
一言で済む雑談や質問には相談を挟まず普通に答えていい。`;

  function makeConvBrainOpts(channel: Channel) {
    const consulting = channel === 'work' && workerSettings.consultMode;
    const workTools = consulting
      ? ['mcp__office__propose_plan', 'mcp__office__confirm_plan']
      : ['mcp__office__delegate_task'];
    return {
      systemPrompt: config.systemPrompt + config.rooms[channel] + (consulting ? CONSULT_PROMPT : ''),
      model: workerSettings.chatModel,
      ...(workerSettings.chatEffort ? { effort: workerSettings.chatEffort } : {}),
      mcpServers: { office: officeServer } as Record<string, unknown>,
      allowedTools: channel === 'work'
        ? [...workTools, 'mcp__office__remember', 'mcp__office__room_status']
        : ['mcp__office__remember', 'mcp__office__room_status'],
      maxTurns: 8, // W9-2: delegate + remember を挟むと 4 では error_max_turns になる
      // 会話 Brain は実作業ツールを使わない。組み込みツールへの誘惑は却下 + 誘導
      canUseTool: async (name: string, input: Record<string, unknown>) => {
        if (name === 'mcp__office__remember' || name === 'mcp__office__room_status') return { behavior: 'allow' as const, updatedInput: input };
        if (channel === 'work' && workTools.includes(name)) return { behavior: 'allow' as const, updatedInput: input };
        if (name === 'mcp__office__delegate_task' && channel === 'work') {
          return { behavior: 'deny' as const, message: '相談モード中。まず propose_plan で進め方の案を出して、同意を得てから confirm_plan で登録して' };
        }
        if (name.startsWith('mcp__office__')) return { behavior: 'deny' as const, message: 'ここは雑談部屋。作業の相談・依頼は作業部屋でしてねと伝えて' };
        return { behavior: 'deny' as const, message: 'あなたは会話係。実作業はツール経由で作業係に任せること' };
      },
    };
  }

  type ChannelState = { brain: Brain; inbox: RoomEvent[]; busy: boolean; needsContext: boolean; chain: Promise<void> };
  const channelState: Record<Channel, ChannelState> = Object.fromEntries(
    CHANNELS.map((c) => [c, { brain: new Brain(makeConvBrainOpts(c)), inbox: [], busy: false, needsContext: true, chain: Promise.resolve() }]),
  ) as Record<Channel, ChannelState>; // W8-1: boot/再生成後の最初の ask に直近ログを注入(channel ごと)

  // W9-2: 記憶忘れの根治 — memory 全文 + 直近ログを Brain 生成のたびに注入する
  function contextPrefix(channel: Channel): string {
    const parts: string[] = [];
    const memo = readMemory();
    if (memo) parts.push(`(あなたが書き留めた大事なこと。必ず踏まえて)\n${memo}`);
    const rows = transcriptTail(channel, 60);
    if (rows.length > 0) parts.push(`(この部屋の直近の会話ログ。文脈の続きとして自然に振る舞って)\n${rows.map((r) => `${r.who}: ${r.text}`).join('\n')}`);
    return parts.length > 0 ? `${parts.join('\n\n')}\n---\n` : '';
  }

  const speakStreamed = (channel: Channel, turnId: string | undefined): ((sentence: string) => void) => {
    let first = true;
    return (sentence) => {
      if (first && turnId) markResponded(turnId);
      enqueueJob({ pid: chloePid!, priority: first ? 1 : 2, kind: 'speech', text: sentence, turnId, epoch: speechEpoch, channel });
      first = false;
    };
  };

  // W9-2: 同一チャンネルの ask は必ず 1 本ずつ(greeting warmup 中にユーザー発話が来て
  // Brain.ask が「前の返答を待っています」で弾かれる事故の根治)
  function askGuarded(channel: Channel, text: string, turnId: string | undefined): Promise<void> {
    const cs = channelState[channel];
    const run = cs.chain.catch(() => {}).then(() => askOnce(channel, text, turnId));
    cs.chain = run.catch(() => {}); // 後続は前の失敗を引き継がない
    return run;
  }

  // ask を見張り、interrupt → 10s 待って駄目なら Brain 再生成(S3C: default 応答者が死なない)
  async function askOnce(channel: Channel, text: string, turnId: string | undefined): Promise<void> {
    const cs = channelState[channel];
    const hang = process.env.ROOM_TEST_HOOKS === '1' && text.includes('__hang__');
    if (cs.needsContext) { text = contextPrefix(channel) + text; cs.needsContext = false; }
    const ask = hang ? new Promise<string>(() => {}) : cs.brain.ask(text, speakStreamed(channel, turnId));
    if ((await Promise.race([ask, timeoutMarker(ASK_GUARD_MS)])) !== TIMEOUT) return; // W9-2: 長 turn を誤殺しない
    console.error(`クロエ(${channel})の応答が ${ASK_GUARD_MS / 1000}s 超過 → interrupt`);
    if (!hang) await cs.brain.interrupt().catch(() => {});
    if ((await Promise.race([ask.catch(() => ''), timeoutMarker(ASK_GRACE_MS)])) !== TIMEOUT) return;
    void cs.brain.close().catch(() => {});
    cs.brain = new Brain(makeConvBrainOpts(channel));
    cs.needsContext = true; // 再生成 = 文脈喪失 → 次の ask でログ注入
    store.append({ type: 'system', from: 'room', text: 'クロエの接続を作り直したよ。少し前の話は忘れちゃったかも', channel });
    store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、ちょっと固まってた。もう一回言ってくれる?', audio: null, turnId, channel });
  }

  async function drain(channel: Channel): Promise<void> {
    const cs = channelState[channel];
    if (cs.busy) return;
    cs.busy = true;
    try {
      while (cs.inbox.length > 0) {
        const ev = cs.inbox.shift()!;
        await askGuarded(channel, ev.text ?? '', ev.turnId).catch((e: Error) => {
          // W9-2(P3): 生エラー文字列は読み上げない — 画面には残し、声は友好文に
          store.append({ type: 'system', from: 'room', text: `クロエのエラー: ${e.message}`, channel });
          store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、ちょっと考えすぎちゃった。もう一回言ってくれる?', audio: null, turnId: ev.turnId, channel });
        });
      }
    } finally {
      cs.busy = false;
    }
  }

  store.onAppend((ev) => {
    if (ev.type === 'user_speech' && ev.targets?.includes(chloePid!)) {
      if (ev.turnId) { const t = turns.get(ev.turnId); if (t) t.delivered = true; } // in-process = 即配送
      const channel = ev.channel ?? 'work';
      channelState[channel].inbox.push(ev);
      void drain(channel);
    }
  });

  // W9-1: 前回やり残しの申告(自動再開はしない — 内容が古い可能性がある)
  const pending = officeTasks.filter((t) => t.status === 'queued' || t.status === 'interrupted');
  if (pending.length > 0) {
    const what = pending.slice(-3).map((t) => t.request.slice(0, 30)).join('、');
    store.append({
      type: 'agent_speech', from: chloePid, name: chloe.assignedName, channel: 'work',
      text: `前回の作業が途中だったよ。${what}。続きやる?`, audio: null, turnId: 'none',
    });
  }

  // greeting = Brain warmup(初回コールドスタートを起動時に消化。channel ごとに 1 回)
  const GREETING: Record<Channel, string> = {
    work: '(ユーザーが声の部屋(作業部屋)に来られるようになった。あなたらしく短く一言で挨拶して)',
    chat: '(ユーザーが雑談部屋に来られるようになった。作業の話はせず、あなたらしく短く気楽に一言だけ挨拶して)',
  };
  for (const channel of CHANNELS) {
    void askGuarded(channel, GREETING[channel], undefined)
      .then(() => console.error(`クロエ(${channel}) warmup 完了`));
  }
}

if (process.env.NO_CHLOE !== '1') startChloe();

// ---- token(room.json 書込み。atomic 化・単一性は 3A-1b)----
const token = randomBytes(24).toString('hex');
const stateDir = join(homedir(), '.talkingclaw');
const playedIds = new Set<number>(); // S4: floor 集計(4A)用の再生完了記録

// W8-1: 会話ログの永続化(共有記憶の正)。user 発話 + 非 filler 本応答を追記。
// 部屋分割: channel ごとに別ファイル(work = 既存 transcript.jsonl のまま・後方互換)
const TRANSCRIPT_PATH: Record<Channel, string> = {
  work: join(homedir(), '.talkingclaw', 'transcript.jsonl'),
  chat: join(homedir(), '.talkingclaw', 'transcript-chat.jsonl'),
};
function transcriptAppend(channel: Channel, who: string, text: string): void {
  try {
    appendFileSync(TRANSCRIPT_PATH[channel], JSON.stringify({ at: new Date().toISOString(), who, text }) + '\n', { mode: 0o600 });
  } catch { /* ログ欠落は本流を止めない */ }
}
function transcriptTail(channel: Channel, lines: number): { at: string; who: string; text: string }[] {
  try {
    const all = readFileSync(TRANSCRIPT_PATH[channel], 'utf8').trim().split('\n');
    return all.slice(-lines).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// 6A: 計測(S10)。サーバ受信時刻で metrics.jsonl に統一記録
function metric(kind: string, extra: Record<string, unknown> = {}): void {
  try {
    appendFileSync(join(stateDir, 'metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, ...extra }) + '\n', { mode: 0o600 });
  } catch { /* 計測は本流を止めない */ }
}
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
  if (req.method === 'GET' && path.startsWith('/vad/')) {
    const name = path.slice('/vad/'.length);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return json(res, 404, { error: 'not found' });
    const types: Record<string, string> = { '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.js': 'text/javascript' };
    const ext = name.slice(name.lastIndexOf('.'));
    try {
      const buf = await readFile(fileURLToPath(new URL(`../public/vad/${name}`, import.meta.url)));
      res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  if (req.method === 'GET' && (path === '/files' || path.startsWith('/files/'))) {
    if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' }); // 無認証ゾーンより前に置かれているため明示検証
    const { resolve, sep } = await import('node:path');
    const root = resolve(config.agent.cwd);
    const rel = decodeURIComponent(path.slice('/files'.length)).replace(/^\/+/, '');
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) return json(res, 404, { error: 'not found' }); // traversal 拒否
    try {
      const { statSync, readdirSync } = await import('node:fs');
      const st = statSync(target);
      if (st.isDirectory()) {
        const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const items = readdirSync(target).filter((n) => !n.startsWith('.'));
        const base = path.replace(/\/$/, '');
        const links = items.map((n) => `<li><a href="${esc(`${base}/${encodeURIComponent(n)}`)}?token=${token}">${esc(n)}</a></li>`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>成果物</title><h3>${esc('/' + rel)}</h3><ul>${links}</ul>`);
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.md': 'text/plain; charset=utf-8',
      };
      const ext = target.slice(target.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': types[ext] ?? 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(await readFile(target));
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  if (req.method === 'GET' && path === '/transcript.md') {
    if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' }); // 会話ログは秘匿
    const channel = isChannel(url.searchParams.get('channel')) ? (url.searchParams.get('channel') as Channel) : 'work';
    const rows = transcriptTail(channel, Math.min(Number(url.searchParams.get('lines') ?? 500) || 500, 2000));
    const md = `# 声の部屋 会話ログ(${ROOM_LABEL[channel]})\n\n` + rows.map((r) => `- ${r.at.slice(0, 16).replace('T', ' ')} **${r.who}**: ${r.text}`).join('\n') + '\n';
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(md);
  }

  // アーカイブ: セッション単位(daemon 起動〜終了、または一定期間ごと)で保存した会話ログの一覧・参照
  if (req.method === 'GET' && path === '/archives.md') {
    if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' });
    const idx = archiveIndexTail(Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200));
    const rows = idx.map((a) =>
      `- [${a.startedAt.slice(0, 16).replace('T', ' ')} 〜 ${a.endedAt.slice(0, 16).replace('T', ' ')}]` +
      `(/archive.md?token=${token}&file=${encodeURIComponent(a.file)})(${a.source} / ${a.lines} 件 / ${a.reason})`);
    const md = '# 声の部屋 アーカイブ一覧\n\n' + (rows.length > 0 ? rows.join('\n') : '(まだアーカイブなし)') + '\n';
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(md);
  }

  if (req.method === 'GET' && path === '/archive.md') {
    if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' });
    const rows = archiveRead(url.searchParams.get('file') ?? '');
    if (!rows) return json(res, 404, { error: 'アーカイブが見つかりません' });
    const md = `# 声の部屋 アーカイブ\n\n` + rows.map((r) => `- ${r.at.slice(0, 16).replace('T', ' ')} **${r.who}**: ${r.text}`).join('\n') + '\n';
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(md);
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

  if (req.method === 'GET' && path === '/participants') {
    return json(res, 200, {
      selected: selectedPid,
      userSpeaking: isUserSpeaking(),
      channel: activeChannel,
      participants: registry.all().map((p) => ({
        participantId: p.participantId,
        name: p.assignedName,
        presence: registry.presence(p, waiters.has(p.participantId)),
        voice: p.voice.status,
      })),
    });
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

  if (path === '/settings') {
    const allowedModels = ['haiku', 'sonnet', 'opus', 'fable'];
    if (typeof body.workerModel === 'string' && allowedModels.includes(body.workerModel)) workerSettings.workerModel = body.workerModel;
    if (typeof body.workerEffort === 'string' && ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.workerEffort)) workerSettings.workerEffort = body.workerEffort;
    if (typeof body.useUserSettings === 'boolean') workerSettings.useUserSettings = body.useUserSettings;
    const beforeConsult = workerSettings.consultMode;
    if (typeof body.consultMode === 'boolean') workerSettings.consultMode = body.consultMode;
    if (typeof body.autoCommit === 'boolean') workerSettings.autoCommit = body.autoCommit;
    if (typeof body.autoPush === 'boolean') workerSettings.autoPush = body.autoPush;
    const beforeChat = `${workerSettings.chatModel}/${workerSettings.chatEffort}`;
    if (typeof body.chatModel === 'string' && allowedModels.includes(body.chatModel)) workerSettings.chatModel = body.chatModel;
    if (typeof body.chatEffort === 'string' && ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.chatEffort)) workerSettings.chatEffort = body.chatEffort;
    saveSettings();
    chloeResetWorker?.(); // 次の task から新設定(実行中の task は続行)
    if (beforeChat !== `${workerSettings.chatModel}/${workerSettings.chatEffort}` || beforeConsult !== workerSettings.consultMode) {
      chloeResetChat?.(); // 会話中でも安全なタイミングで作り直す(記憶と直近ログは再注入)。相談モードは使えるツールが変わるので作り直しが要る
    }
    const ext = loadWorkerMcp();
    return json(res, 200, { ...workerSettings, externalMcp: Object.keys(ext.mcpServers), projects: Object.keys(loadProjects()) });
  }

  if (path === '/ui-state') {
    uiState = { preview: body.preview ? String(body.preview).slice(0, 200) : undefined,
                board: body.board === true, at: new Date().toISOString() };
    return json(res, 200, { ok: true });
  }

  if (path === '/tasks') {
    return json(res, 200, boardSnapshot());
  }

  if (path === '/plan') {
    // 相談中の案の操作。画面のボタンからも、音声の合図(別機能)からもここに来る
    const action = String(body.action ?? 'get');
    if (action === 'confirm') {
      const r = confirmPlan();
      return r.ok ? json(res, 200, { ok: true, taskId: r.taskId }) : json(res, 400, { error: r.error });
    }
    if (action === 'cancel') {
      if (plan) store.append({ type: 'system', from: 'room', text: '相談中の案はいったん取り下げたよ', channel: 'work' });
      plan = null;
      return json(res, 200, { ok: true, plan: null });
    }
    return json(res, 200, { plan, consultMode: workerSettings.consultMode });
  }

  if (path === '/transcript') {
    const lines = Math.min(Number(body.lines ?? 40) || 40, 200);
    const channel = isChannel(body.channel) ? (body.channel as Channel) : 'work'; // 既定 'work': recall する外部 agent は基本作業係
    return json(res, 200, { channel, lines: transcriptTail(channel, lines) });
  }

  if (path === '/screen') {
    // W8-9: コハク(声の部屋の画面を持たない外部 agent)が今の表示状態を能動的に取得するための endpoint。
    // 在室者・誰と話しているか(routing)・発話中/待機中・作業ボード・直近ログを 1 回でまとめて返す
    return json(res, 200, {
      bootId: store.bootId,
      userSpeaking: isUserSpeaking(), // ユーザーの現在の発話状態(単一の状態源。UserSpeechState 参照)
      participants: registry.all().map((p) => ({
        participantId: p.participantId,
        name: p.assignedName,
        presence: registry.presence(p, waiters.has(p.participantId)),
        voice: p.voice.status,
      })),
      routing: {
        selected: selectedPid ? (registry.get(selectedPid)?.assignedName ?? selectedPid) : null,
        floor: floorOwner ? (registry.get(floorOwner)?.assignedName ?? floorOwner) : null,
        lastResponder: lastResponder ? (registry.get(lastResponder)?.assignedName ?? lastResponder) : null,
      },
      speaking: pendingSpeechSnapshot(),
      board: boardSnapshot(),
      recentLog: transcriptTail('work', 15),
    });
  }

  if (path === '/metrics') {
    // S10: ブラウザ計測(stt_final_delay 等)を JSONL に蓄積
    const kind = String(body.kind ?? '').slice(0, 40);
    const ms = Number(body.ms);
    if (!kind || !Number.isFinite(ms)) return json(res, 400, { error: 'kind と ms が必要です' });
    const eventId = Number.isFinite(Number(body.eventId)) ? Number(body.eventId) : undefined;
    const evRef = eventId !== undefined ? store.get(eventId) : undefined;
    appendFileSync(join(stateDir, 'metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, ms, eventId, turnId: evRef?.turnId, filler: evRef?.filler }) + '\n', { mode: 0o600 });
    return json(res, 200, { ok: true });
  }

  if (path === '/select') {
    const pid = body.participantId === null ? null : String(body.participantId ?? '');
    if (pid !== null && !registry.get(pid)) return json(res, 400, { error: '不明な participant です' });
    selectedPid = pid;
    store.append({ type: 'system', from: 'room', text: pid ? `話し相手を ${registry.get(pid)!.assignedName} にしたよ` : '話し相手の指定を外したよ' });
    return json(res, 200, { ok: true, selected: selectedPid });
  }

  if (path === '/channel') {
    // 部屋分割: 今いる部屋(作業部屋/雑談部屋)を切替。以後のデフォルト発話・クロエの記憶がこちらに切り替わる
    if (!isChannel(body.channel)) return json(res, 400, { error: '不明な部屋です(work / chat)' });
    activeChannel = body.channel;
    store.append({ type: 'system', from: 'room', text: `部屋を${ROOM_LABEL[activeChannel]}に切り替えたよ`, channel: activeChannel });
    return json(res, 200, { ok: true, channel: activeChannel });
  }

  if (path === '/speech-state') {
    // ブラウザ側の STT interim/final から「ユーザーが今話しているか」を報告させる。認証はトークンのみ(participant 不問)。
    userSpeaking = body.speaking === true;
    userSpeakingAt = Date.now();
    return json(res, 200, { ok: true, userSpeaking });
  }

  if (path === '/played') {
    // S4/S10: 再生完了通知(floor 集計は 4A で使用)
    const eventId = Number(body.eventId);
    if (!Number.isFinite(eventId)) return json(res, 400, { error: 'eventId が必要です' });
    playedIds.add(eventId);
    const ev = store.get(eventId);
    if (ev && ev.type === 'agent_speech' && !ev.filler && ev.from !== 'room') floorAdvance(ev.from); // S4: 再生完了基準
    if (ev && ev.filler) onFillerPlayed(ev); // 6B: 相対スケジュール前倒し
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
    const speakTurnId = resolvedTurn === 'none' ? undefined : resolvedTurn;
    speakSentences(p.participantId, p.assignedName, text, speakTurnId, turnChannel(speakTurnId));
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

// ---- アーカイブ: セッション単位(daemon 起動〜終了、または一定期間ごと)で会話ログを保存 ----
// 会話ログの正は transcript*.jsonl のまま(切り詰めない)。archive.ts が増分だけ複製保存する。
markArchiveBaseline(); // この起動より前の行は今回のセッションの対象外
const ARCHIVE_INTERVAL_MS = Number(process.env.ARCHIVE_INTERVAL_MS ?? 6 * 3600_000); // 既定 6h ごとに区切る
setInterval(() => archiveSession(store.bootId, 'interval'), ARCHIVE_INTERVAL_MS).unref();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    archiveSession(store.bootId, 'shutdown'); // 部屋を閉じた時点までの分を残す
    process.exit(0);
  });
}

