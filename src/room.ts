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
import { SpeechPlane, UserSpeechState } from './convos/speech.ts';
import { Voice } from './voice.ts'; // splitSentences は音声平面(convos/speech.ts)へ移った
import * as casino from './casino.ts';

const PORT = Number(process.env.PORT ?? 3300);
const LISTEN_MAX_S = 48; // S2: server 内部 deadline 上限
const TEXT_MAX = 4000;
const BODY_MAX = 64 * 1024;
const UPLOAD_MAX = 20 * 1024 * 1024; // こちらから送るファイルの上限

const store = new EventStore();
const registry = new Registry();
const voice = new Voice(config.tts);

// ---- 部屋分割(会話コンテキストの分離): 作業部屋 / 雑談部屋 ----
// 単一の EventStore は共有したまま、event に channel を付け会話の記憶(Brain)と transcript だけを隔てる。
// 「今どちらの部屋にいるか」は単一の activeChannel(部屋全体で 1 つ。/channel で切替)。
// 部屋は増やせる: 既定の 2 つに加えて、ユーザーが名前を付けて作れる(~/.talkingclaw/rooms.json に永続化)。
const ROOMS_PATH = join(homedir(), '.talkingclaw', 'rooms.json');
const DEFAULT_ROOMS: { id: Channel; label: string }[] = [
  { id: 'work', label: '作業部屋' },
  { id: 'chat', label: '雑談部屋' },
  { id: 'game', label: 'ゲーム部屋' },
];
function loadRooms(): { id: Channel; label: string }[] {
  try {
    const rows = JSON.parse(readFileSync(ROOMS_PATH, 'utf8')) as { id: string; label: string }[];
    const clean = rows.filter((r) => typeof r?.id === 'string' && typeof r?.label === 'string');
    return clean.length > 0 ? clean : DEFAULT_ROOMS;
  } catch { return DEFAULT_ROOMS; }
}
let rooms = loadRooms();
if (!rooms.some((r) => r.id === 'game')) rooms.push({ id: 'game', label: 'ゲーム部屋' }); // 遊ぶ場所は最初から用意しておく
function saveRooms(): void {
  try {
    mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
    writeFileSync(ROOMS_PATH, JSON.stringify(rooms, null, 1), { mode: 0o600 });
  } catch { /* 保存できなくても今の部屋は使える */ }
}
function roomLabel(ch: Channel): string {
  return rooms.find((r) => r.id === ch)?.label ?? ch;
}
// 表示名から id を作る(英数は slug、日本語だけの名前は room-<連番>)
function newRoomId(label: string): Channel {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  let id = base || `room-${rooms.length + 1}`;
  for (let n = 2; rooms.some((r) => r.id === id); n++) id = `${base || 'room'}-${n}`;
  return id;
}
function roomPrompt(ch: Channel): string {
  const preset = (config.rooms as Record<string, string>)[ch];
  if (preset) return preset;
  return `\n\n# 今いる部屋\nここは「${roomLabel(ch)}」の部屋。この部屋の話題に集中して、他の部屋の話は持ち込まない`;
}
let activeChannel: Channel = 'work';
// 誰がどの部屋にいるか。内蔵クロエだけはどの部屋にもいる(この map に載せない)
const participantRoom = new Map<string, Channel>();
function isChannel(v: unknown): v is Channel {
  return typeof v === 'string' && rooms.some((r) => r.id === v);
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
import * as pathMod from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { existsSync } from 'node:fs';

let engineState: 'starting' | 'ready' | 'down' = 'starting';
let engineChild: ChildProcess | null = null;
let engineSpawnedAt = 0;
const engineSpawnLog: number[] = [];
let synthFailStreak = 0;

// ---- 合成の成否報告(会話OS §4 の抽出。設計: docs/kaiwa-os-design.md)----
// スケジューラは「この 1 回の合成が通ったか」だけを報告する。連続失敗の数え方・fail-fast の
// 閾値・down への遷移・その告知は、状態を持っている側(ここ)が決める = 判定した者が告知する。
// 戻り値: この報告でエンジンを down に倒したか(true なら呼び側は retry せず即 text-only)
function reportSynthResult(ok: boolean): boolean {
  if (ok) { synthFailStreak = 0; return false; }
  synthFailStreak++;
  if (synthFailStreak >= 3 && engineState === 'ready') {
    engineState = 'down'; // S5 engineDown: fail-fast(15s 連鎖を断つ)
    store.append({ type: 'system', from: 'room', text: '声がうまく出せない。復旧するまで文字で続けるね' });
    return true;
  }
  return false;
}
// スケジューラ / filler が読むのはこれだけ。engineState を直接見せない
const isEngineReady = (): boolean => engineState === 'ready';

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
    if (speech.busy) { probeFailStreak = 0; continue; }

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
  speech.buildNarrationPool();
  for (const p of registry.all()) {
    if (p.voice.status === 'ready') continue;
    const speaker = await resolveVoice(p.voice.requested);
    p.voice.resolvedSpeaker = speaker;
    p.voice.status = speaker === null ? 'voice_unavailable' : 'ready';
    store.append({ type: 'presence', from: p.participantId, name: p.assignedName, text: `voice:${p.voice.status}` });
    if (speaker !== null) speech.buildAckPool(p.participantId, speaker);
  }
}

// ---- UserSpeechState(会話OS §4.8)----
// 実装は src/convos/speech.ts。/participants からも読めるので、画面状態を知りたい他機能も
// ここを見る(状態源を 2 つ持たない)。
const userSpeech = new UserSpeechState();

// ---- 音声平面(会話OS §4.1/§4.3): TtsScheduler + FillerEngine ----
// 実装は src/convos/speech.ts。EngineManager は room.ts に残したまま、エンジンの生死は
// getter(isEngineReady)と報告 callback(reportSynthResult)だけを渡す(C1-①c で切った境界)。
const speech = new SpeechPlane({
  store, registry, voice, putAudio, isEngineReady, reportSynthResult, resolveVoice,
  metric, turnChannel, userSpeech,
});


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

// 話しかけられるのは今いる部屋にいる相手だけ(クロエはどの部屋にもいる)。
// 別の部屋にいる相手に届けたい時は、在室リストから「呼ぶ」で連れてくる
function inThisRoom(pid: string): boolean {
  if (pid === chloePid) return true;
  return (participantRoom.get(pid) ?? 'work') === activeChannel;
}

function routeTargets(text: string): { targets: string[]; routing: RoomEvent['routing'] } {
  const head = kanaNormalize(text.slice(0, 12));
  let best: { pid: string; alias: string } | null = null;
  for (const p of registry.all()) {
    if (!inThisRoom(p.participantId)) continue;
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
    if (!inThisRoom(pid)) return false;           // 別の部屋にいる相手には流れない
    const p = registry.get(pid);
    return p !== undefined && registry.alive(p); // S4: gone は floor/last_responder から自然解除
  };
  if (aliveTarget(selectedPid)) return { targets: [selectedPid!], routing: { method: 'selection' } };
  if (aliveTarget(floorOwner)) return { targets: [floorOwner!], routing: { method: 'floor' } };
  if (aliveTarget(lastResponder)) return { targets: [lastResponder!], routing: { method: 'last_responder' } };
  if (chloePid && registry.get(chloePid)) return { targets: [chloePid], routing: { method: 'default' } };
  return { targets: registry.all().map((p) => p.participantId).filter(inThisRoom), routing: { method: 'default' } };
}

// ---- W12: 報告ブロックの解析。テンプレを守っていれば構造化、守っていなければ notes から組み立てる ----
function parseReport(raw: string, task: OfficeTask): TaskReport {
  const now = new Date().toISOString();
  const body = raw.includes('報告:') ? raw.slice(raw.lastIndexOf('報告:') + 3) : '';
  const section = (name: string): string[] => {
    const re = new RegExp(`^\\s*${name}\\s*[:：]\\s*(.*)$`, 'm');
    const m = re.exec(body);
    if (!m) return [];
    const inline = m[1].trim();
    const rest = body.slice(m.index + m[0].length).split('\n');
    const items: string[] = [];
    if (inline) items.push(inline);
    for (const line of rest) {
      const t = line.trim();
      if (!t) continue;
      if (/^[^\s-].*[:：]\s*$/.test(t) || /^(見出し|できるようになったこと|確かめかた|やらなかったこと|技術メモ|さわったもの)\s*[:：]/.test(t)) break;
      if (/^[-・*]\s*/.test(t) || /^\d+[.、)]\s*/.test(t)) items.push(t.replace(/^[-・*]\s*/, '').replace(/^\d+[.、)]\s*/, ''));
      else break;
    }
    return items.filter(Boolean);
  };

  const headline = section('見出し')[0] ?? '';
  const can = section('できるようになったこと');
  const check = section('確かめかた');
  const touched = (section('さわったもの')[0] ?? '')
    .split(/[,、]/).map((x) => x.trim().replace(/^`|`$/g, '')).filter(Boolean);

  if (headline && can.length > 0) {
    return {
      headline, can, check: check.length > 0 ? check : ['作業係が確かめかたを書き忘れました。聞き直してください'],
      skipped: section('やらなかったこと'), memo: section('技術メモ'),
      touched: touched.length > 0 ? touched : task.artifacts, at: now, template: true,
    };
  }
  // フォールバック: テンプレ違反。報告が無いより不完全でも出す(違反自体が見えるように)
  const plain = task.notes.filter((n) => !/^(skipped:|add when|成果物[:：])/.test(n.trim()));
  return {
    headline: task.request.slice(0, 40),
    can: plain.slice(0, 3),
    check: ['作業係が確かめかたを書き忘れました。聞き直してください'],
    skipped: task.notes.filter((n) => /^(skipped:|やらなかった)/.test(n.trim())),
    memo: [], touched: task.artifacts, at: now, template: false,
  };
}

// ---- W11-2: 認識テキストの補正辞書(誤変換をここで直してから部屋に流す)----
const DICT_PATH = join(homedir(), '.talkingclaw', 'dictionary.json');
let dictCache: { at: number; map: Record<string, string> } = { at: 0, map: {} };
function loadDict(): Record<string, string> {
  if (Date.now() - dictCache.at < 5_000) return dictCache.map;
  let user: Record<string, string> = {};
  try { user = JSON.parse(readFileSync(DICT_PATH, 'utf8')); } catch { /* 無ければ既定のみ */ }
  dictCache = { at: Date.now(), map: { ...config.dictionary, ...user } };
  return dictCache.map;
}
function applyDict(text: string): string {
  let out = text;
  for (const [wrong, right] of Object.entries(loadDict())) {
    if (!wrong) continue;
    out = out.split(wrong).join(right);
  }
  return out;
}
// ユーザーが覚えさせたぶんだけ(config.dictionary の既定は含まない)
function userDict(): Record<string, string> {
  try { return JSON.parse(readFileSync(DICT_PATH, 'utf8')); } catch { return {}; }
}
function saveDict(user: Record<string, string>): void {
  try {
    mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
    const tmp = `${DICT_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(user, null, 1), { mode: 0o600 });
    renameSync(tmp, DICT_PATH);
    dictCache = { at: 0, map: {} };
  } catch { /* 覚えられなくても会話は続ける */ }
}
function learnWord(wrong: string, right: string): void {
  const user = userDict();
  user[wrong] = right;
  saveDict(user);
}

// ---- W11-1: 確定バッファ — 細切れの認識結果を 1 発話にまとめてから部屋に流す ----
// 「頼んでる時に全てあの」「つけて」のような断片それぞれに返事してしまう問題への対処。
// ユーザーが話している間(userSpeaking)は確定しない = 言い終わってから考え始める。
const FRAGMENT_MAX_CHARS = 15;   // これ未満は「続きがありそう」とみなす
const FRAGMENT_WAIT_MS = 1_500;  // 続きを待つ時間(来たらリセット)
const FRAGMENT_MAX_HOLD_MS = 5_000; // 保留の上限(レイテンシの天井)
const TRAILING_PARTICLE = /(の|は|が|を|に|で|と|も|や|か|て|で|し|から|けど|ので|あの|えっと|その)$/;

type Pending = { text: string; firstAt: number; timer: NodeJS.Timeout | null };
let pending: Pending | null = null;

function looksIncomplete(text: string): boolean {
  return text.length < FRAGMENT_MAX_CHARS || TRAILING_PARTICLE.test(text);
}

// 確定待ちに積む。確定したら userSpeech を呼ぶ。戻り値は「今すぐ確定したか」
// ---- 遊び(ブラックジャック / ポーカー)----
// 判定は casino/blackjack/poker の決定的なコードが持つ。LLM は審判をしない。
// 「引く」と言ってから LLM を待つと遊べないので、会話の手前で拾って即返す。
const GAMES_PATH = pathMod.join(homedir(), '.talkingclaw', 'games.json');
const gameSessions = new Map<Channel, casino.Session>();
function loadGames(): void {
  try {
    const rows = JSON.parse(readFileSync(GAMES_PATH, 'utf8')) as Record<string, casino.Session>;
    for (const [ch, sess] of Object.entries(rows)) if (sess?.kind) gameSessions.set(ch as Channel, sess);
  } catch { /* 無ければ何もしない */ }
}
function saveGames(): void {
  try {
    mkdirSync(pathMod.join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
    const tmp = `${GAMES_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(gameSessions)), { mode: 0o600 });
    renameSync(tmp, GAMES_PATH);
  } catch (e) { console.error('遊びの状態を保存できなかった:', (e as Error).message); }
}
loadGames();

// この部屋で遊べる相手(クロエ + 同じ部屋にいる agent。作業係は誘わない)
function gameOpponents(): { id: string; name: string; style: number }[] {
  const out: { id: string; name: string; style: number }[] = [];
  for (const p of registry.all()) {
    if (p.assignedName === config.workerParticipant.name) continue;
    const room = p.participantId === chloePid ? activeChannel : (participantRoom.get(p.participantId) ?? 'work');
    if (room !== activeChannel) continue;
    out.push({ id: p.participantId, name: p.assignedName, style: casino.styleOf(p.assignedName) });
  }
  return out;
}

/** ゲームの手なら、その場で判定して読み上げまでやる。ゲームでなければ null(いつもの会話へ) */
function tryGame(text: string): number | null {
  const session = gameSessions.get(activeChannel) ?? null;
  const cmd = casino.parseCommand(text, session);
  if (!cmd) return null;
  if (!session && cmd.type !== 'start') return null;
  if (!chloePid) return null; // 進行役がいない部屋では遊べない

  const reply = cmd.type === 'start'
    ? casino.start(cmd.game, (Date.now() ^ (store.lastId * 2654435761)) | 0, gameOpponents(), cmd.blind)
    : casino.apply(session!, cmd);

  // 発話は残す(会話の記録として)。targets を空にしてあるので Brain は起こさない
  const turnId = `G${++turnSeq}`;
  const ev = store.append({
    type: 'user_speech', from: 'user', text, turnId, targets: [],
    routing: { method: 'default' }, channel: activeChannel,
  });
  if (reply.session) gameSessions.set(activeChannel, reply.session);
  else gameSessions.delete(activeChannel);
  saveGames();
  if (reply.hand) store.append({ type: 'system', from: 'room', text: reply.hand, channel: activeChannel });
  // あなただけに見せる情報は system として画面に出すだけ。読み上げないし記録にも残さない
  // (進行役の発言として残すと、同じ卓にいる相手の文脈に手牌が戻ってしまう)
  for (const line of reply.show ?? []) {
    store.append({ type: 'system', from: 'room', text: line, channel: activeChannel });
  }
  const name = registry.get(chloePid)?.assignedName ?? config.character.name;
  for (const line of reply.say) speech.speakSentences(chloePid, name, line, turnId, activeChannel);
  return ev.id;
}

// 添付(画像・ファイル)は /chat と一緒に来る。次の user_speech に載せて、Brain には実パスを渡す
let pendingFiles: string[] = [];
const uploadDir = (): string => pathMod.join(homedir(), '.talkingclaw', 'uploads');
function attachmentNote(files: string[] | undefined): string {
  if (!files || files.length === 0) return '';
  return `\n(添付ファイル。必要なら Read で開いて: ${files.map((f) => pathMod.join(uploadDir(), f)).join(', ')})`;
}

function acceptUtterance(text: string): RoomEvent | null {
  const merged = pending ? `${pending.text} ${text}` : text;
  const firstAt = pending?.firstAt ?? Date.now();
  if (pending?.timer) clearTimeout(pending.timer);

  const heldTooLong = Date.now() - firstAt >= FRAGMENT_MAX_HOLD_MS;
  if (!looksIncomplete(text) && !userSpeech.active) {
    pending = null;
    return userSpeech(merged); // 言い切っていて、もう話していない → 即確定
  }
  if (heldTooLong && !userSpeech.active) {
    pending = null;
    return userSpeech(merged);
  }
  pending = { text: merged, firstAt, timer: null };
  armPending(FRAGMENT_WAIT_MS);
  return null;
}

// 確定タイマー。まだ話している間は上限まで伸ばし続ける(伸ばす時も必ず再判定する)
function armPending(delayMs: number): void {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    if (!pending) return;
    if (userSpeech.active && Date.now() - pending.firstAt < FRAGMENT_MAX_HOLD_MS) {
      armPending(500); // まだ喋ってる → もう少し待つ
      return;
    }
    flushPending();
  }, delayMs);
  timer.unref();
  pending.timer = timer;
}

function flushPending(): void {
  if (!pending) return;
  const { text, timer } = pending;
  if (timer) clearTimeout(timer);
  pending = null;
  if (text.trim()) userSpeech(text.trim());
}

function userSpeech(rawText: string): RoomEvent {
  const text = applyDict(rawText);
  userSpeech.clear(); // 発話がここまで届いた = この turn の「発話中」は終了(client 側 false 通知の到着順に依存しない)
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
  speech.advanceEpoch(); // stale drop: これ以前に積まれた speech job は読み上げない
  const { targets, routing } = routeTargets(text);
  const turnId = `T${++turnSeq}`;
  const ev = store.append({ type: 'user_speech', from: 'user', text, turnId, targets, routing, channel: activeChannel, files: pendingFiles.length > 0 ? pendingFiles : undefined });
  pendingFiles = [];
  metric('turn_created', { turnId, method: routing?.method, targets: targets.length });
  if (targets.length === 1) {
    trackTurn(turnId, targets[0], text, activeChannel);
    speech.fireAck(targets[0], turnId, text); // S6: t=0 相槌(単独 target のみ)
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
      speech.advanceEpoch(); // 直前の読み上げ待ちより優先して届ける
      speech.enqueue({ pid: chloePid, priority: 1, kind: 'speech', text: `作業係が${desc}を使いたいって。許可していい?`, turnId: 'none', epoch: speech.epoch, channel: 'work' });
    }
  });
}

function finishPermission(ok: boolean, say: string): void {
  if (!pendingPermission) return;
  clearTimeout(pendingPermission.timer);
  pendingPermission.resolve(ok);
  pendingPermission = null;
  if (chloePid) speech.enqueue({ pid: chloePid, priority: 1, kind: 'speech', text: say, turnId: 'none', epoch: speech.epoch, channel: 'work' });
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
    if (userSpeech.active) return scheduleEscalation(turnId, target, stage, 500); // ユーザーが話し続けてる間は先送り
    const t = turns.get(turnId);
    if (!t || t.responded || !t.delivered) return; // 応答済み/未配送(未達経路が担当)は終了
    const p = registry.get(target);
    if (stage === 1) {
      const cue = speech.contextCue(target, statusRotate);
      const ev = store.append({
        type: 'agent_speech', from: target, name: p?.assignedName,
        text: cue.text, audio: cue.audio, filler: 'context', turnId, channel: t.channel,
      });
      metric('filler_emitted', { turnId, stage, eventId: ev.id });
      scheduleEscalation(turnId, target, 2, 8_000); // /played が来れば前倒し(下の onPlayed 経由)
    } else if (stage <= 3) {
      const ev = store.append({
        type: 'agent_speech', from: 'room', name: 'ナレーション',
        ...speech.statusCue(), filler: 'status', turnId, channel: t.channel,
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
      ...speech.undeliveredCue(), filler: 'status', turnId, channel: t.channel,
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
function memoryLines(): string[] {
  try { return readFileSync(MEMORY_PATH, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); }
  catch { return []; }
}
// 覚え違いを消せるようにする(声で覚えるだけで消せないと、間違いが残り続ける)
function writeMemory(lines: string[]): void {
  try {
    mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
    const tmp = `${MEMORY_PATH}.tmp`;
    writeFileSync(tmp, lines.join('\n') + (lines.length > 0 ? '\n' : ''), { mode: 0o600 });
    renameSync(tmp, MEMORY_PATH);
  } catch (e) { console.error('記憶を書き換えられなかった:', (e as Error).message); }
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
type WorkerSettings = { workerModel: string; workerEffort: string; useUserSettings: boolean; chatModel: string; chatEffort: string; consultMode: boolean; autoCommit: boolean; autoPush: boolean; workers: number };
function loadSettings(): WorkerSettings {
  const defaults: WorkerSettings = {
    workerModel: config.agent.model, workerEffort: '', useUserSettings: false,
    chatModel: config.model, chatEffort: '',
    // W25: 同時に動かす作業係の人数。既定 1 = 従来どおり 1 件ずつ。
    // 増やすとコストも人数ぶん増える(npm run cost で試算できる)ので、明示的に上げた時だけ並列になる
    workers: 1,
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
// W25: 同時に動かす作業係の人数。設定値をそのまま信じず 1〜4 に丸める
const workerCount = (): number => Math.max(1, Math.min(4, Number(workerSettings.workers) || 1));
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
  // W12: 報告 INBOX。1 タスク = 1 スレッド。報告はここに構造化して置き、会話ストリームには流さない
  report?: TaskReport;
  unread?: boolean;
  replies?: { at: string; text: string }[]; // このスレッドへの追加依頼
  channel?: Channel;                        // どの部屋で頼まれたか(報告から戻れるように)
};
type TaskReport = {
  headline: string;      // 結果を 1 行
  can: string[];         // できるようになったこと(ユーザー目線)
  check: string[];       // 確かめかた(必須)
  skipped: string[];     // やらなかったこと
  memo: string[];        // 技術メモ(読み上げない)
  touched: string[];     // さわったもの
  at: string;
  template: boolean;     // worker がテンプレを守ったか(false = フォールバック生成)
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

// >>> collectArtifacts(pure に近い: test/check-artifacts.mjs から取り出して検査する)
// 成果物の行から path を拾う。複数書かれる事があるので全部拾い、実在するものだけ board に載せる
// (存在しない path をリンクにすると開いた時 not found になる = 今回のバグ)
function collectArtifacts(result: string, cwd: string): string[] {
  const line = result.match(/成果物[:：]([^\n]+)/)?.[1];
  if (!line) return [];
  const out: string[] = [];
  for (const raw of line.split(/[,、\s]+/)) {
    const rel = raw.replace(/^[`'"(（]+/, '').replace(/[`'")）。、,.]+$/, '').trim();
    if (!rel || rel.startsWith('http')) continue;
    const found = resolveArtifact(rel, cwd);
    if (found) out.push(found);
    else console.error(`成果物が見つからないので board に載せない: ${rel}(cwd ${cwd})`);
  }
  return out;
}

// 作業係は「workspace からの相対」で書くよう指示されているが、project 作業では
// project 名を頭に付けてくる事がある(talkingclaw/src/room.ts)。両方の読み方を試す。
function resolveArtifact(rel: string, cwd: string): string | null {
  const { resolve, sep, basename } = pathMod;
  const root = resolve(cwd);
  const candidates = [rel];
  const prefix = basename(root) + '/';
  if (rel.startsWith(prefix)) candidates.push(rel.slice(prefix.length));
  for (const c of candidates) {
    const target = resolve(root, c);
    if (target !== root && !target.startsWith(root + sep)) continue; // 作業先の外は載せない
    if (existsSync(target)) return c;
  }
  return null;
}
// <<< collectArtifacts

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
let chloeReply: ((task: OfficeTask, text: string) => void) | null = null;
// W9-2: 本番は 180s(sonnet + delegate の長 turn を誤殺しない)。テストは短縮して回転を速く
// テスト時も「通常応答(context 注入込みで 20-40s)は切らず、ハングだけ捕まえる」値にする
const ASK_GUARD_MS = Number(process.env.ASK_GUARD_MS ?? (process.env.ROOM_TEST_HOOKS === '1' ? 90_000 : 180_000));
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
      speech.buildAckPool(chloePid!, speaker);
    });
  }

  // --- W11-3: 作業係を独立した話者として在室させる(実況がクロエの会話に混ざらない)---
  const helperOutcome = registry.join(config.workerParticipant.name, config.workerParticipant.voice, store.lastId, store.bootId);
  const helper = 'error' in helperOutcome ? null : helperOutcome.participant;
  const helperPid = helper?.participantId ?? chloePid;
  if (helper) {
    const keepHelper = setInterval(() => { helper.lastSeen = Date.now(); }, 30_000);
    keepHelper.unref();
    store.append({ type: 'presence', from: helper.participantId, name: helper.assignedName, text: 'joined' });
    if (engineState === 'ready') {
      void resolveVoice(config.workerParticipant.voice).then((speaker) => {
        if (speaker === null) return;
        helper.voice.resolvedSpeaker = speaker;
        helper.voice.status = 'ready';
      });
    }
  }

  // --- W8-2: worker(実作業係)。会話 Brain とは別セッションで並行動作 ---
  mkdirSync(config.agent.cwd, { recursive: true });
  // W25: 作業係のスロット。1 スロット = 1 セッション(Brain)+ その作業先。
  // 空いているスロットが queue から次を取るので、人数を増やすとそのぶん同時に進む。
  type WorkerSlot = { brain: Brain | null; cwd: string; busy: boolean };
  const slots: WorkerSlot[] = [{ brain: null, cwd: '', busy: false }];
  const taskQueue: OfficeTask[] = [];

  function delegate(description: string, project?: string): OfficeTask {
    const task: OfficeTask = {
      id: ++taskSeq, agent: chloePid!, agentName: chloe.assignedName, request: description, project,
      status: 'queued', notes: [], artifacts: [], at: new Date().toISOString(), channel: activeChannel,
    };
    officeTasks.push(task);
    while (officeTasks.length > 50) officeTasks.shift();
    saveTasks();
    taskQueue.push(task);
    void pumpTasks();
    return task;
  }
  planDelegate = delegate; // 相談がまとまった時の登録先(confirm_plan / POST /plan から使う)

  // W12: 未読が溜まったことを 1 回だけ知らせる(既読か新規報告まで再通知しない)
  let unreadNotified = 0;
  const notifyUnread = (): void => {
    const n = officeTasks.filter((t) => t.unread).length;
    if (n === 0) { unreadNotified = 0; return; }
    if (n <= unreadNotified) return;
    unreadNotified = n;
    if (n >= 2) {
      speech.enqueue({
        pid: helperPid!, priority: 2, kind: 'speech', turnId: 'none', epoch: speech.epoch, channel: 'work',
        text: `報告が ${n} 件たまってるよ。読んでほしい時は「報告読んで」って言ってね。`,
      });
    }
  };

  // W12: 報告への返信 = そのスレッドの続き(worker には前回の作業として文脈を渡す)
  chloeReply = (task, text) => {
    task.status = 'queued';
    task.notes.push(`【追加依頼】${text}`);
    taskQueue.push(task);
    saveTasks();
    void pumpTasks();
  };

  chloeResetChat = () => {
    for (const [c, cs] of channelState) {
      cs.chain = cs.chain.catch(() => {}).then(() => {
        void cs.brain.close().catch(() => {});
        cs.brain = new Brain(makeConvBrainOpts(c));
        cs.needsContext = true; // 記憶 + 直近ログを次の ask で再注入
      });
    }
    store.append({ type: 'system', from: 'room', text: `会話の設定を切り替えたよ(モデル ${workerSettings.chatModel} / 相談モード ${workerSettings.consultMode ? 'あり' : 'なし'})` });
  };

  // 設定を変えたら、空いているスロットのセッションだけ作り直す(作業中のものは触らない)
  chloeResetWorker = () => {
    for (const slot of slots) {
      if (slot.busy) continue;
      if (slot.brain) void slot.brain.close().catch(() => {});
      slot.brain = null;
    }
    void pumpTasks(); // 人数を増やした直後に、待っている依頼を配り直す
  };

  // 空きスロットに queue の先頭から配る。人数ぶん同時に走る(既定 1 人なら従来どおり直列)
  async function pumpTasks(): Promise<void> {
    while (slots.length < workerCount()) slots.push({ brain: null, cwd: '', busy: false });
    for (const slot of slots.slice(0, workerCount())) {
      if (!slot.busy && taskQueue.length > 0) void runSlot(slot);
    }
  }

  async function runSlot(slot: WorkerSlot): Promise<void> {
    slot.busy = true;
    try {
      while (taskQueue.length > 0) {
        const task = taskQueue.shift()!;
        task.status = 'working';
        saveTasks();
        speech.enqueue({
          pid: helperPid!, priority: 2, kind: 'speech', turnId: 'none', epoch: speech.epoch, channel: 'work',
          text: `${task.request.slice(0, 20)}、始めるね。`,
        });
        await runTask(task, slot);
        saveTasks();
      }
    } finally {
      slot.busy = false;
    }
  }

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
    // W12: 途中経過は会話ストリームに流さない。スレッド(notes)に溜めて INBOX で読む
  };

  async function runTask(task: OfficeTask, slot: WorkerSlot): Promise<void> {
    const projects = loadProjects();
    const cwd = (task.project && projects[task.project]) || config.agent.cwd;
    if (slot.brain && slot.cwd !== cwd) { void slot.brain.close().catch(() => {}); slot.brain = null; } // プロジェクト切替
    if (!slot.brain) {
      slot.cwd = cwd;
      const ext = loadWorkerMcp();
      const allowList = [...(config.agent.allowedTools as unknown as string[]), ...ext.allow];
      const opts = {
        systemPrompt: `${config.workerPrompt}\n${config.reportTemplate}`, model: workerSettings.workerModel,
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
        slot.brain = new Brain(opts);
      } catch {
        delete (opts as Record<string, unknown>).effort; // SDK が effort 未対応でも作業は続ける
        slot.brain = new Brain(opts);
      }
    }
    const brain = slot.brain;
    try {
      const others = officeTasks.filter((t) => t.id !== task.id && (t.status === 'queued' || t.status === 'working'));
      const brief = others.length > 0
        ? `(同じ作業場で他にも依頼が並んでる: ${others.map((t) => t.request.slice(0, 40)).join(' / ')}。同じファイルを壊し合わないよう、既存の変更を確認してから作業して)\n`
        : '';
      const followUp = (task.replies ?? []).length > 0
        ? `(この作業の続き。前回の報告: ${task.report?.headline ?? '(なし)'})\n追加の依頼: ${task.replies![task.replies!.length - 1].text}\n`
        : '';
      const askP = brain.ask(brief + followUp + task.request, workerSay(task));
      const result = await Promise.race([askP, timeoutMarker(600_000)]);
      if (result === TIMEOUT) {
        await brain.interrupt().catch(() => {});
        const grace = await Promise.race([askP.catch(() => ''), timeoutMarker(15_000)]);
        if (grace === TIMEOUT) { void brain.close().catch(() => {}); slot.brain = null; }
        task.status = 'failed';
        store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、作業が長引きすぎたから一旦止めたよ。', audio: null, turnId: 'none', channel: 'work' });
        return;
      }
      task.status = 'done';
      task.artifacts.push(...collectArtifacts(String(result), cwd));
      await gitAutoCommit(task, cwd, workerSay(task)); // 出来上がりを git に残す(既定はローカル commit まで)
      // W12: 報告本体は INBOX スレッドへ。会話に出すのは 1 文だけ
      task.report = parseReport(String(result), task);
      task.unread = true;
      saveTasks();
      notifyUnread();
      const firstCan = task.report.can[0] ? `${task.report.can[0]} ` : '';
      speech.enqueue({
        pid: helperPid!, priority: 2, kind: 'speech', turnId: 'none', epoch: speech.epoch, channel: 'work',
        text: `${task.report.headline}、できたよ。${firstCan}確かめかたは報告に入れておくね。`,
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
            note: `作業係は今 ${workerCount()} 人。同時に動くのは最大 ${workerCount()} 件で、あふれた依頼は queued のまま待つ。動いている件数も待っている件数も、下の workingNow と tasks のとおりに答えること。数を盛らない・減らさない。`,
            workerCount: workerCount(),
            workingNow: officeTasks.filter((t) => t.status === 'working').map((t) => t.request.slice(0, 60)),
            consultMode: workerSettings.consultMode,
            planUnderDiscussion: plan, // 相談中の案(まだ着手していない)
            tasks, people, userScreen: uiState, engine: engineState, activeChannel,
          }, null, 1) }] };
        },
      ),
      tool(
        'read_inbox',
        '作業係からの報告(未読)を読む。「報告読んで」「何ができた?」と聞かれたら使う。読み上げる時は見出しとできるようになったこと、確かめかたを伝える。',
        {},
        async () => {
          const threads = officeTasks.filter((t) => t.report && t.unread);
          if (threads.length === 0) return { content: [{ type: 'text' as const, text: '未読の報告はない。そう伝えて。' }] };
          const list = threads.slice(0, 3).map((t) => ({
            threadId: t.id, 依頼: t.request.slice(0, 60), 依頼時刻: t.at.slice(11, 16),
            見出し: t.report!.headline, できるようになったこと: t.report!.can,
            確かめかた: t.report!.check, やらなかったこと: t.report!.skipped,
          }));
          return { content: [{ type: 'text' as const, text: `未読 ${threads.length} 件。1 件ずつ短く伝えて、読んだら mark_read を呼ぶこと。\n${JSON.stringify(list, null, 1)}` }] };
        },
      ),
      tool(
        'mark_read',
        '報告を読み終えたら既読にする。read_inbox で伝えた分だけ呼ぶ。',
        { threadId: z.number() },
        async ({ threadId }) => {
          const t = officeTasks.find((x) => x.id === threadId);
          if (t) { t.unread = false; saveTasks(); }
          return { content: [{ type: 'text' as const, text: t ? '既読にした。' : 'そのスレッドは無い。' }] };
        },
      ),
      tool(
        'cancel_task',
        '直前に頼んだ作業を取り消す。ユーザーに「ちがう」「そうじゃない」と言われた時に使う。まだ始まっていないものだけ取り消せる。',
        { taskId: z.number().optional() },
        async ({ taskId }) => {
          const target = taskId
            ? officeTasks.find((t) => t.id === taskId)
            : [...officeTasks].reverse().find((t) => t.status === 'queued' || t.status === 'working');
          if (!target) return { content: [{ type: 'text' as const, text: '取り消せる作業が見つからない。ユーザーにそう伝えて。' }] };
          if (target.status === 'working') {
            return { content: [{ type: 'text' as const, text: `「${target.request.slice(0, 30)}」はもう始まってる。止められないので、そう正直に伝えて。` }] };
          }
          target.status = 'failed';
          target.notes.push('ユーザーの指示で取り消し');
          saveTasks();
          return { content: [{ type: 'text' as const, text: `「${target.request.slice(0, 30)}」を取り消した。短く伝えて、正しい内容を聞き直して。` }] };
        },
      ),
      tool(
        'learn_word',
        '音声認識でいつも間違って聞こえる言葉を覚える。「キッドハブは GitHub のことね」のように言われた時に使う。',
        { wrong: z.string(), right: z.string() },
        async ({ wrong, right }) => {
          learnWord(wrong, right);
          return { content: [{ type: 'text' as const, text: `「${wrong}」は「${right}」として覚えた。次から自動で直る。短く伝えて。` }] };
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
      systemPrompt: config.systemPrompt + roomPrompt(channel) + (consulting ? CONSULT_PROMPT : ''),
      model: workerSettings.chatModel,
      ...(workerSettings.chatEffort ? { effort: workerSettings.chatEffort } : {}),
      mcpServers: { office: officeServer } as Record<string, unknown>,
      allowedTools: [
        // W24: 読むだけの道具はどちらの部屋でも持たせる。
        // 「推測で答えない」と指示しておきながら調べる手段が無いのが、精度の一番の天井だった
        ...config.convReadTools,
        ...(channel === 'work'
          ? [...workTools, 'mcp__office__read_inbox', 'mcp__office__mark_read', 'mcp__office__cancel_task', 'mcp__office__remember', 'mcp__office__room_status', 'mcp__office__learn_word']
          : ['mcp__office__remember', 'mcp__office__room_status', 'mcp__office__learn_word']),
      ],
      // W9-2: delegate + remember を挟むと 4 では error_max_turns になる
      // W24: 読んでから答える分の往復が増えたので 8 → 12(必要な分しか使わない)
      maxTurns: 12,
      // 会話 Brain は「読む」までは自分でやる。書き換え(Write / Edit / Bash)は却下して作業係へ誘導
      canUseTool: async (name: string, input: Record<string, unknown>) => {
        if (config.convReadTools.includes(name)) return { behavior: 'allow' as const, updatedInput: input };
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
  // 部屋ごとの会話 Brain。増やせる部屋に合わせて、入った部屋の分だけ作る(未使用の部屋は持たない)
  const channelState = new Map<Channel, ChannelState>();
  function chan(channel: Channel): ChannelState {
    let cs = channelState.get(channel);
    if (!cs) {
      cs = { brain: new Brain(makeConvBrainOpts(channel)), inbox: [], busy: false, needsContext: true, chain: Promise.resolve() };
      channelState.set(channel, cs); // W8-1: 最初の ask に記憶 + 直近ログを注入
    }
    return cs;
  }

  // W9-2: 記憶忘れの根治 — memory 全文 + 直近ログを Brain 生成のたびに注入する
  function contextPrefix(channel: Channel): string {
    const parts: string[] = [];
    const memo = readMemory();
    if (memo) parts.push(`(あなたが書き留めた大事なこと。必ず踏まえて)\n${memo}`);
    const rows = transcriptTail(channel, 60);
    if (rows.length > 0) parts.push(`(この部屋の直近の会話ログ。文脈の続きとして自然に振る舞って)\n${rows.map((r) => `${r.who}: ${r.text}`).join('\n')}`);
    // 遊んでいる最中なら、いまの場を教える。ユーザーの手札・手牌は brief に入れていない
    const gameBrief = casino.brief(gameSessions.get(channel) ?? null);
    if (gameBrief) parts.push(gameBrief);
    return parts.length > 0 ? `${parts.join('\n\n')}\n---\n` : '';
  }

  const speakStreamed = (channel: Channel, turnId: string | undefined): ((sentence: string) => void) => {
    let first = true;
    return (sentence) => {
      if (first && turnId) markResponded(turnId);
      speech.enqueue({ pid: chloePid!, priority: first ? 1 : 2, kind: 'speech', text: sentence, turnId, epoch: speech.epoch, channel });
      first = false;
    };
  };

  // W9-2: 同一チャンネルの ask は必ず 1 本ずつ(greeting warmup 中にユーザー発話が来て
  // Brain.ask が「前の返答を待っています」で弾かれる事故の根治)
  function askGuarded(channel: Channel, text: string, turnId: string | undefined): Promise<void> {
    const cs = chan(channel);
    const run = cs.chain.catch(() => {}).then(() => askOnce(channel, text, turnId));
    cs.chain = run.catch(() => {}); // 後続は前の失敗を引き継がない
    return run;
  }

  // ask を見張り、interrupt → 10s 待って駄目なら Brain 再生成(S3C: default 応答者が死なない)
  async function askOnce(channel: Channel, text: string, turnId: string | undefined): Promise<void> {
    const cs = chan(channel);
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
    const cs = chan(channel);
    if (cs.busy) return;
    cs.busy = true;
    try {
      while (cs.inbox.length > 0) {
        const ev = cs.inbox.shift()!;
        await askGuarded(channel, (ev.text ?? '') + attachmentNote(ev.files), ev.turnId).catch((e: Error) => {
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
      chan(channel).inbox.push(ev);
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
  // 増やせる部屋の分まで温めると待ち時間もお金も増えるので、今いる部屋だけ温める
  const greeting = activeChannel === 'chat'
    ? '(ユーザーが雑談部屋に来られるようになった。作業の話はせず、あなたらしく短く気楽に一言だけ挨拶して)'
    : `(ユーザーが声の部屋(${roomLabel(activeChannel)})に来られるようになった。あなたらしく短く一言で挨拶して)`;
  void askGuarded(activeChannel, greeting, undefined)
    .then(() => console.error(`クロエ(${activeChannel}) warmup 完了`));
}

if (process.env.NO_CHLOE !== '1') startChloe();

// ---- token(room.json 書込み。atomic 化・単一性は 3A-1b)----
const token = randomBytes(24).toString('hex');
const stateDir = join(homedir(), '.talkingclaw');
const playedIds = new Set<number>(); // S4: floor 集計(4A)用の再生完了記録

// W8-1: 会話ログの永続化(共有記憶の正)。user 発話 + 非 filler 本応答を追記。
// 部屋分割: channel ごとに別ファイル(work = 既存 transcript.jsonl のまま・後方互換)
function transcriptPath(channel: Channel): string {
  // work だけ既存ファイル名のまま(後方互換)。他は transcript-<channel>.jsonl
  return join(homedir(), '.talkingclaw', channel === 'work' ? 'transcript.jsonl' : `transcript-${channel}.jsonl`);
}
function transcriptAppend(channel: Channel, who: string, text: string): void {
  try {
    appendFileSync(transcriptPath(channel), JSON.stringify({ at: new Date().toISOString(), who, text }) + '\n', { mode: 0o600 });
  } catch { /* ログ欠落は本流を止めない */ }
}
function transcriptTail(channel: Channel, lines: number): { at: string; who: string; text: string }[] {
  try {
    const all = readFileSync(transcriptPath(channel), 'utf8').trim().split('\n');
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

  // 送った添付を画面に出すための配信(uploads の中だけ。作業先には触れない)
  if (req.method === 'GET' && path.startsWith('/uploads/')) {
    if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' });
    const name = pathMod.basename(decodeURIComponent(path.slice('/uploads/'.length)));
    const target = pathMod.join(uploadDir(), name);
    try {
      const types: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf',
        '.html': 'text/html; charset=utf-8', '.json': 'application/json',
      };
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const buf = await readFile(target); // 先に読む(失敗しても header を書いていない状態で 404 に落とせる)
      res.writeHead(200, {
        'content-type': types[ext] ?? 'text/plain; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  if (req.method === 'GET' && (path === '/files' || path.startsWith('/files/'))) {
    if (!authed(req, url)) return json(res, 401, { error: 'token が必要です' }); // 無認証ゾーンより前に置かれているため明示検証
    const { resolve, sep } = await import('node:path');
    // 成果物は task の作業先(project)に出来る。既定は workspace
    const projects = loadProjects();
    const wanted = url.searchParams.get('project') ?? '';
    const root = resolve(projects[wanted] ?? config.agent.cwd);
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
    const md = `# 声の部屋 会話ログ(${roomLabel(channel)})\n\n` + rows.map((r) => `- ${r.at.slice(0, 16).replace('T', ' ')} **${r.who}**: ${r.text}`).join('\n') + '\n';
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

  if (req.method === 'GET' && path === '/channels') {
    return json(res, 200, { active: activeChannel, rooms: rooms.map((r) => ({ channel: r.id, label: r.label })) });
  }

  if (req.method === 'GET' && path === '/participants') {
    return json(res, 200, {
      selected: selectedPid,
      userSpeaking: userSpeech.active,
      channel: activeChannel,
      participants: registry.all().map((p) => ({
        participantId: p.participantId,
        name: p.assignedName,
        presence: registry.presence(p, waiters.has(p.participantId)),
        voice: p.voice.status,
        // null = どの部屋にもいる(内蔵クロエ)。それ以外は今いる部屋と比べてグレーにする
        room: p.participantId === chloePid ? null : (participantRoom.get(p.participantId) ?? 'work'),
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

  // こちらから画像・ファイルを送る。~/.talkingclaw/uploads に置き、agent には実パスで渡す
  // (作業先の git を汚さないよう、workspace や project の中には置かない)
  if (path === '/upload') {
    const raw = url.searchParams.get('name') ?? 'file';
    const safe = pathMod.basename(raw).replace(/[^\w.\-ぁ-んァ-ヶ一-龥]/gu, '_').slice(-80) || 'file';
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > UPLOAD_MAX) { req.destroy(); return json(res, 413, { error: 'ファイルが大きすぎます(20MB まで)' }); }
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return json(res, 400, { error: 'からのファイルです' });
    const dir = uploadDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${safe}`;
    writeFileSync(pathMod.join(dir, name), Buffer.concat(chunks), { mode: 0o600 });
    return json(res, 200, { ok: true, name, size });
  }

  const body = await readJson(req);
  if (body === null) return json(res, 400, { error: 'JSON body が必要です(64KB 以内)' });

  if (path === '/join') {
    const requestedName = String(body.requestedName ?? '').trim().slice(0, 40);
    if (!requestedName) return json(res, 400, { error: 'requestedName が必要です' });
    const resume = body.resume as { bootId: string; participantId: string; sessionId: string } | undefined;
    const outcome = registry.join(requestedName, String(body.voice ?? ''), store.lastId, store.bootId, resume);
    if ('error' in outcome) return json(res, 400, { error: outcome.error });
    const { participant: p, mode } = outcome;
    if (!participantRoom.has(p.participantId)) participantRoom.set(p.participantId, activeChannel); // 入ってきた相手は今いる部屋へ
    if (engineState === 'ready' && p.voice.status !== 'ready') {
      const speaker = await resolveVoice(p.voice.requested);
      p.voice.resolvedSpeaker = speaker;
      p.voice.status = speaker === null ? 'voice_unavailable' : 'ready';
      if (speaker !== null) speech.buildAckPool(p.participantId, speaker);
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

  // ゲームの今の様子(画面のボタンを組み立てるため)。ボタンは声と同じ言葉を /chat に送る
  if (path === '/game') {
    return json(res, 200, casino.view(gameSessions.get(activeChannel) ?? null));
  }

  if (path === '/chat') {
    const text = String(body.text ?? '').trim();
    if (!text || text.length > TEXT_MAX) return json(res, 400, { error: `text が空か ${TEXT_MAX} 字超です` });
    // 遊びの手は会話に流さず即判定(待たされるゲームは遊べない)
    const gameEvent = tryGame(text);
    if (gameEvent !== null) return json(res, 200, { ok: true, eventId: gameEvent, game: true });
    // 添付は次の user_speech に載せる(送信の直前に確定するので pending で持つ)
    if (Array.isArray(body.files)) {
      pendingFiles = body.files.map(String).map((f) => pathMod.basename(f)).filter(Boolean).slice(0, 8);
    }
    // W11-1: 断片は確定バッファでまとめる。immediate:true(テキスト入力など)は素通し
    const ev = body.immediate === true ? userSpeech(text) : acceptUtterance(text);
    return json(res, 200, ev ? { ok: true, eventId: ev.id, turnId: ev.turnId } : { ok: true, pending: true });
  }

  if (path === '/dict') {
    const wrong = String(body.wrong ?? '').trim();
    const right = String(body.right ?? '').trim();
    if (wrong && body.remove === true) {           // 覚え違いを消す(自分で足したものだけ)
      const user = userDict();
      delete user[wrong];
      saveDict(user);
      return json(res, 200, { ok: true, dictionary: loadDict(), user: userDict() });
    }
    if (wrong && right) learnWord(wrong, right);
    return json(res, 200, { ok: Boolean(wrong && right), dictionary: loadDict(), user: userDict() });
  }

  // クロエの記憶。声で覚えるだけでなく、間違って覚えたものを画面から消せるようにする
  if (path === '/memory') {
    const lines = memoryLines();
    if (typeof body.add === 'string' && body.add.trim()) {
      appendMemory(body.add.trim());
      return json(res, 200, { ok: true, lines: memoryLines() });
    }
    if (typeof body.remove === 'string' && body.remove) {
      writeMemory(lines.filter((l) => l !== body.remove));
      return json(res, 200, { ok: true, lines: memoryLines() });
    }
    return json(res, 200, { lines });
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
    // W25: 同時に動かす作業係の人数(1〜4)。増やすとコストも人数ぶん増える
    if (typeof body.workers === 'number' && body.workers >= 1 && body.workers <= 4) workerSettings.workers = Math.floor(body.workers);
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

  if (path === '/inbox') {
    const threads = officeTasks.filter((t) => t.report).slice(-30).reverse()
      .sort((a, b) => Number(b.unread ?? false) - Number(a.unread ?? false));
    return json(res, 200, { unread: threads.filter((t) => t.unread).length, threads });
  }

  // 台帳の手入れ(ユーザーが自分で消す・直す)。要らなくなった依頼や、
  // 言い間違いで登録された依頼を画面から片付けられるようにする。動き出したものは触らない。
  if (path === '/task') {
    const action = String(body.action ?? '');
    // 複数選択の一括操作(消す / まとめる)。まとめる = 選んだ依頼を 1 件に束ねて残りを消す
    const ids: number[] = Array.isArray(body.taskIds) ? body.taskIds.map(Number).filter(Number.isFinite) : [];
    if (ids.length > 0) {
      const picked = officeTasks.filter((x) => ids.includes(x.id));
      if (picked.length === 0) return json(res, 400, { error: 'その作業は見つかりません' });
      if (action === 'delete') {
        const running = picked.find((x) => x.status === 'working');
        if (running) return json(res, 409, { error: 'いま動いているものが混ざっています(先に取り消してね)' });
        for (const x of picked) officeTasks.splice(officeTasks.indexOf(x), 1);
        saveTasks();
        return json(res, 200, { ok: true, removed: picked.length });
      }
      if (action === 'merge') {
        const mergeable = picked.filter((x) => x.status === 'queued');
        if (mergeable.length < 2) return json(res, 409, { error: 'まだ始まっていないものを 2 件以上えらんでね' });
        const head = mergeable[0];
        head.request = mergeable.map((x) => x.request).join('\nそれと、').slice(0, TEXT_MAX);
        head.notes.push(`${mergeable.length} 件をまとめた`);
        for (const x of mergeable.slice(1)) officeTasks.splice(officeTasks.indexOf(x), 1);
        saveTasks();
        return json(res, 200, { ok: true, taskId: head.id, merged: mergeable.length });
      }
      return json(res, 400, { error: 'まとめてできるのは delete / merge です' });
    }
    const t = officeTasks.find((x) => x.id === Number(body.taskId));
    if (!t) return json(res, 400, { error: 'その作業は見つかりません' });
    if (action === 'delete') {
      if (t.status === 'working') return json(res, 409, { error: 'いま動いているので消せません(先に取り消してね)' });
      officeTasks.splice(officeTasks.indexOf(t), 1);
      saveTasks();
      return json(res, 200, { ok: true });
    }
    if (action === 'cancel') {
      if (t.status !== 'queued') return json(res, 409, { error: 'まだ始まっていないものだけ取り消せます' });
      t.status = 'failed';
      t.notes.push('ユーザーの指示で取り消し');
      saveTasks();
      return json(res, 200, { ok: true });
    }
    if (action === 'edit') {
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: '内容が空です' });
      if (t.status !== 'queued') return json(res, 409, { error: 'まだ始まっていないものだけ直せます' });
      t.request = text.slice(0, TEXT_MAX);
      saveTasks();
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'action は delete / cancel / edit です' });
  }

  if (path === '/inbox/read') {
    const t = officeTasks.find((x) => x.id === Number(body.threadId));
    if (!t) return json(res, 400, { error: 'そのスレッドは見つかりません' });
    t.unread = false;
    saveTasks();
    return json(res, 200, { ok: true });
  }

  // 報告を消す(読み終わって要らないもの)。作業の記録ごと台帳から外す
  if (path === '/inbox/delete') {
    const t = officeTasks.find((x) => x.id === Number(body.threadId));
    if (!t) return json(res, 400, { error: 'そのスレッドは見つかりません' });
    officeTasks.splice(officeTasks.indexOf(t), 1);
    saveTasks();
    return json(res, 200, { ok: true });
  }

  if (path === '/inbox/reply') {
    const t = officeTasks.find((x) => x.id === Number(body.threadId));
    const text = String(body.text ?? '').trim();
    if (!t) return json(res, 400, { error: 'そのスレッドは見つかりません' });
    if (!text) return json(res, 400, { error: '内容が空です' });
    t.replies = [...(t.replies ?? []), { at: new Date().toISOString(), text }];
    t.unread = false;
    chloeReply?.(t, text); // 同じスレッドの続きとして作業係へ
    saveTasks();
    return json(res, 200, { ok: true, threadId: t.id });
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
      userSpeaking: userSpeech.active, // ユーザーの現在の発話状態(単一の状態源。UserSpeechState 参照)
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

  if (path === '/rooms') {
    // 部屋の作成 / 名前変更。id は作る時に決まり、以後変わらない(ログの置き場所が id 基準のため)
    const action = String(body.action ?? '');
    const label = String(body.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (action === 'create') {
      if (!label) return json(res, 400, { error: '部屋の名前を入れてね' });
      if (rooms.length >= 12) return json(res, 400, { error: '部屋は 12 個までにしておこう' });
      if (rooms.some((r) => r.label === label)) return json(res, 400, { error: `「${label}」はもうあるよ` });
      const id = newRoomId(label);
      rooms.push({ id, label });
      saveRooms();
      store.append({ type: 'system', from: 'room', text: `「${label}」の部屋を作ったよ` });
      return json(res, 200, { ok: true, channel: id, label, rooms });
    }
    if (action === 'rename') {
      const target = isChannel(body.channel) ? body.channel : activeChannel;
      if (!label) return json(res, 400, { error: '新しい名前を入れてね' });
      const room = rooms.find((r) => r.id === target);
      if (!room) return json(res, 400, { error: '不明な部屋です' });
      const before = room.label;
      room.label = label;
      saveRooms();
      store.append({ type: 'system', from: 'room', text: `部屋の名前を「${before}」から「${label}」に変えたよ` });
      return json(res, 200, { ok: true, channel: target, label, rooms });
    }
    return json(res, 400, { error: 'action は create / rename' });
  }

  // 別の部屋にいる相手を、今いる部屋に呼ぶ
  if (path === '/invite') {
    const pid = String(body.participantId ?? '');
    const p = registry.get(pid);
    if (!p) return json(res, 400, { error: 'その相手は見つかりません' });
    if (pid === chloePid) return json(res, 200, { ok: true, room: null }); // クロエはどこにでもいる
    participantRoom.set(pid, activeChannel);
    store.append({ type: 'presence', from: pid, name: p.assignedName, text: `${roomLabel(activeChannel)}に来たよ`, channel: activeChannel });
    return json(res, 200, { ok: true, room: activeChannel });
  }

  if (path === '/channel') {
    // 部屋分割: 今いる部屋を切替。以後のデフォルト発話・クロエの記憶がこちらに切り替わる
    if (!isChannel(body.channel)) return json(res, 400, { error: '不明な部屋です' });
    activeChannel = body.channel;
    store.append({ type: 'system', from: 'room', text: `部屋を${roomLabel(activeChannel)}に切り替えたよ`, channel: activeChannel });
    return json(res, 200, { ok: true, channel: activeChannel });
  }

  if (path === '/speech-state') {
    // ブラウザ側の STT interim/final から「ユーザーが今話しているか」を報告させる。認証はトークンのみ(participant 不問)。
    const speaking = body.speaking === true;
    // W11-1: 話し終わった瞬間に、溜めていた断片を 1 発話として確定する
    if (userSpeech.report(speaking)) setTimeout(() => flushPending(), 250).unref();
    return json(res, 200, { ok: true, userSpeaking: speaking });
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
    speech.speakSentences(p.participantId, p.assignedName, text, speakTurnId, turnChannel(speakTurnId));
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

