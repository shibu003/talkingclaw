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
      enqueueJob({ pid: `__narration_${key}__`, priority: 3, kind: 'ack-pool', text, speaker });
    }
  });
}

// 文脈 filler(target の声・事前合成)— S6
const CONTEXT_TEXTS = ['ん、いま考えてるところ。', 'ちょっと確認してるね。'];
const contextPools = new Map<string, string[]>();

function buildAckPool(pid: string, speaker: number): void {
  if (ackPools.has(pid)) return;
  ackPools.set(pid, []);
  for (const text of ACK_TEXTS) enqueueJob({ pid, priority: 3, kind: 'ack-pool', text, speaker });
  for (const text of CONTEXT_TEXTS) enqueueJob({ pid: `__context_${pid}__`, priority: 3, kind: 'ack-pool', text, speaker });
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
  const ackEv = store.append({ type: 'agent_speech', from: target, name: p.assignedName, text, audio, filler: 'ack', turnId });
  metric('ack_emitted', { turnId, eventId: ackEv.id });
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
    if (e.type === 'user_speech' && e.turnId) { const t = turns.get(e.turnId); if (t && t.target === pid && !t.delivered) { t.delivered = true; metric('turn_delivered', { turnId: e.turnId }); } }
  }
  const stripped = events.map(({ audio, ...rest }) => rest); // S2: agent 応答から audio 除去
  return { status: 'speech', bootId: store.bootId, truncated, events: stripped, cursor: events[events.length - 1].id };
}

store.onAppend((ev) => {
  if (ev.type === 'user_speech') transcriptAppend('あなた', ev.text ?? '');
  else if (ev.type === 'agent_speech' && !ev.filler && ev.text) transcriptAppend(ev.name ?? ev.from, ev.text);
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

type Turn = { turnId: string; target: string; text: string; delivered: boolean; responded: boolean; noticeSent: boolean };
const turns = new Map<string, Turn>();

function trackTurn(turnId: string, target: string, text = ''): void {
  for (const t of turns.values()) {
    if (t.target === target && !t.responded) cancelEscalation(t.turnId); // 新 turn が旧 escalation を supersede
  }
  turns.set(turnId, { turnId, target, text, delivered: false, responded: false, noticeSent: false });
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
  // W8-8: 許可待ち中の短い諾否はパーミッションへの返答として扱う
  if (pendingPermission) {
    const t = text.trim();
    if (PERM_YES.test(t)) {
      const ev = store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' } });
      finishPermission(true, 'おっけー、許可したよ。続けるね。');
      return ev;
    }
    if (PERM_NO.test(t)) {
      const ev = store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' } });
      finishPermission(false, 'わかった、それはやめておくね。');
      return ev;
    }
  }
  if (process.env.ROOM_TEST_HOOKS === '1' && text === '__askperm__') {
    void askUserPermission('テスト機能').then((ok) => store.append({ type: 'system', from: 'room', text: `perm:${ok}` }));
    return store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' } });
  }
  speechEpoch++; // stale drop: これ以前に積まれた speech job は読み上げない
  const { targets, routing } = routeTargets(text);
  const turnId = `T${++turnSeq}`;
  const ev = store.append({ type: 'user_speech', from: 'user', text, turnId, targets, routing });
  metric('turn_created', { turnId, method: routing?.method, targets: targets.length });
  if (targets.length === 1) {
    trackTurn(turnId, targets[0], text);
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
      enqueueJob({ pid: chloePid, priority: 1, kind: 'speech', text: `作業係が${desc}を使いたいって。許可していい?`, turnId: 'none', epoch: speechEpoch });
    }
  });
}

function finishPermission(ok: boolean, say: string): void {
  if (!pendingPermission) return;
  clearTimeout(pendingPermission.timer);
  pendingPermission.resolve(ok);
  pendingPermission = null;
  if (chloePid) enqueueJob({ pid: chloePid, priority: 1, kind: 'speech', text: say, turnId: 'none', epoch: speechEpoch });
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
    const t = turns.get(turnId);
    if (!t || t.responded || !t.delivered) return; // 応答済み/未配送(未達経路が担当)は終了
    const p = registry.get(target);
    if (stage === 1) {
      const pool = contextPools.get(target) ?? [];
      const ev = store.append({
        type: 'agent_speech', from: target, name: p?.assignedName,
        text: CONTEXT_TEXTS[statusRotate % CONTEXT_TEXTS.length],
        audio: pool[statusRotate % Math.max(1, pool.length)] ?? null, filler: 'context', turnId,
      });
      metric('filler_emitted', { turnId, stage, eventId: ev.id });
      scheduleEscalation(turnId, target, 2, 8_000); // /played が来れば前倒し(下の onPlayed 経由)
    } else if (stage <= 3) {
      const ev = store.append({
        type: 'agent_speech', from: 'room', name: 'ナレーション',
        text: NARRATION_TEXTS.status, audio: narrationAudio.get('status') ?? null, filler: 'status', turnId,
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
      audio: narrationPool[0] ?? null, filler: 'status', turnId,
    });
    if (floorOwner === target) floorOwner = null;
  }, 12_000);
  timer.unref();
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
type WorkerSettings = { workerModel: string; workerEffort: string; useUserSettings: boolean };
function loadSettings(): WorkerSettings {
  try {
    return { workerModel: config.agent.model, workerEffort: '', useUserSettings: false, ...JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { workerModel: config.agent.model, workerEffort: '', useUserSettings: false };
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
  status: 'queued' | 'working' | 'done' | 'failed'; notes: string[]; artifacts: string[]; at: string;
};
const officeTasks: OfficeTask[] = [];
let taskSeq = 0;
const agentNotes = new Map<string, string[]>(); // 外部 agent の 'none' 実況(最新 5 件)

store.onAppend((ev) => {
  if (ev.type === 'agent_speech' && !ev.filler && ev.turnId === 'none' && ev.from !== 'room') {
    const notes = agentNotes.get(ev.from) ?? [];
    notes.push(ev.text ?? '');
    while (notes.length > 5) notes.shift();
    agentNotes.set(ev.from, notes);
  }
});

// ---- 内蔵クロエ(3C): Brain を in-process participant として部屋に接続 ----
import { Brain } from './brain.ts';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

let chloePid: string | null = null;
let chloeResetWorker: (() => void) | null = null;
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
    taskQueue.push(task);
    void pumpTasks();
    return task;
  }

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
        await runTask(task);
      }
    } finally {
      workerBusy = false;
    }
  }

  let workerCwd = '';

  const workerSay = (task: OfficeTask) => (sentence: string): void => {
    task.notes.push(sentence);
    while (task.notes.length > 20) task.notes.shift();
    enqueueJob({ pid: chloePid!, priority: 2, kind: 'speech', text: sentence, turnId: 'none', epoch: speechEpoch });
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
        // W8-8: allow-list 外は自動拒否でなく声でユーザーに確認する
        canUseTool: async (name: string, input: Record<string, unknown>) => {
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
      const askP = worker.ask(task.request, workerSay(task));
      const result = await Promise.race([askP, timeoutMarker(600_000)]);
      if (result === TIMEOUT) {
        await worker.interrupt().catch(() => {});
        const grace = await Promise.race([askP.catch(() => ''), timeoutMarker(15_000)]);
        if (grace === TIMEOUT) { void worker.close().catch(() => {}); worker = null; }
        task.status = 'failed';
        store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、作業が長引きすぎたから一旦止めたよ。', audio: null, turnId: 'none' });
        return;
      }
      task.status = 'done';
      const m = String(result).match(/成果物[:：]\s*(\S+)/);
      if (m) task.artifacts.push(m[1].replace(/[、。]$/, ''));
    } catch (error) {
      task.status = 'failed';
      task.notes.push(`エラー: ${(error as Error).message}`);
      store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、作業でエラーが出ちゃった。もう一回頼んでみて。', audio: null, turnId: 'none' });
    }
  }

  const officeServer = createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    tools: [
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
  const convBrainOpts = {
    systemPrompt: config.systemPrompt, model: config.model,
    mcpServers: { office: officeServer } as Record<string, unknown>,
    allowedTools: ['mcp__office__delegate_task'], maxTurns: 4,
    // 会話 Brain は実作業ツールを使わない。組み込みツールへの誘惑は却下 + 誘導
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      if (name === 'mcp__office__delegate_task') return { behavior: 'allow' as const, updatedInput: input };
      return { behavior: 'deny' as const, message: 'あなたは会話係。実作業は delegate_task ツールに依頼内容を渡して任せること' };
    },
  };

  let brain = new Brain(convBrainOpts);
  const inbox: RoomEvent[] = [];
  let busy = false;
  let needsContext = true; // W8-1: boot/再生成後の最初の ask に直近ログを注入

  function contextPrefix(): string {
    const rows = transcriptTail(30);
    if (rows.length === 0) return '';
    const log = rows.map((r) => `${r.who}: ${r.text}`).join('\n');
    return `(参考: 部屋の直近の会話ログ。文脈の続きとして自然に振る舞って)\n${log}\n---\n`;
  }

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
    if (needsContext) { text = contextPrefix() + text; needsContext = false; }
    const ask = hang ? new Promise<string>(() => {}) : brain.ask(text, speakStreamed(turnId));
    if ((await Promise.race([ask, timeoutMarker(60_000)])) !== TIMEOUT) return;
    console.error('クロエの応答が 60s 超過 → interrupt');
    if (!hang) await brain.interrupt().catch(() => {});
    if ((await Promise.race([ask.catch(() => ''), timeoutMarker(10_000)])) !== TIMEOUT) return;
    void brain.close().catch(() => {});
    brain = new Brain(convBrainOpts);
    needsContext = true; // 再生成 = 文脈喪失 → 次の ask でログ注入
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

// W8-1: 会話ログの永続化(共有記憶の正)。user 発話 + 非 filler 本応答を追記
const TRANSCRIPT = join(homedir(), '.talkingclaw', 'transcript.jsonl');
function transcriptAppend(who: string, text: string): void {
  try {
    appendFileSync(TRANSCRIPT, JSON.stringify({ at: new Date().toISOString(), who, text }) + '\n', { mode: 0o600 });
  } catch { /* ログ欠落は本流を止めない */ }
}
function transcriptTail(lines: number): { at: string; who: string; text: string }[] {
  try {
    const all = readFileSync(TRANSCRIPT, 'utf8').trim().split('\n');
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
    const rows = transcriptTail(Math.min(Number(url.searchParams.get('lines') ?? 500) || 500, 2000));
    const md = '# 声の部屋 会話ログ\n\n' + rows.map((r) => `- ${r.at.slice(0, 16).replace('T', ' ')} **${r.who}**: ${r.text}`).join('\n') + '\n';
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
    saveSettings();
    chloeResetWorker?.(); // 次の task から新設定(実行中の task は続行)
    const ext = loadWorkerMcp();
    return json(res, 200, { ...workerSettings, externalMcp: Object.keys(ext.mcpServers), projects: Object.keys(loadProjects()) });
  }

  if (path === '/tasks') {
    const open = [...turns.values()]
      .filter((t) => !t.responded && !t.noticeSent && t.target !== chloePid)
      .slice(-10)
      .map((t) => ({
        agent: t.target, agentName: registry.get(t.target)?.assignedName ?? t.target,
        request: t.text, status: t.delivered ? 'working' : 'queued',
        notes: agentNotes.get(t.target) ?? [], artifacts: [],
      }));
    return json(res, 200, { tasks: [...officeTasks].reverse().slice(0, 20), open });
  }

  if (path === '/transcript') {
    const lines = Math.min(Number(body.lines ?? 40) || 40, 200);
    return json(res, 200, { lines: transcriptTail(lines) });
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
