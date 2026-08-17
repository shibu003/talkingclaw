// 声の部屋 daemon(3A-1a-i: EventStore + HTTP core + token 認証 + inline TTS)。
// S8 の単一性強化・S9 の Host/Origin 検証等は 3A-1b、ページ配信は 3A-1c で拡張する。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat, mkdir as mkdirP, writeFile as writeFileP } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { archiveIndexTail, archiveRead, archiveSession, markArchiveBaseline } from './archive.ts';
import { EventStore, Registry, type Channel, type RoomEvent } from './roomcore.ts'; // kanaNormalize は Router(convos/turn.ts)へ移った
import { LatestChannel, TurnMetricClock, type ChannelRun } from './convos/channel.ts';
import { createMemoHandler } from './memo.ts';
import { attitudeLine, attitudeTone, currentPersona, observeTurn, personaSummary } from './persona.ts';
import { currentVocab, decide as vocabDecide, observeText, pendingWords, promptLine } from './vocab.ts';

// PBI-022: キャラの実体はユーザーが置く(AivisSpeech エンジンと同じ扱い。repo には入れない)。
// 置いていなければ空配列で、画面はキャラ枠を出さずに今までどおり動く
function listAvatars(): string[] {
  try {
    return readdirSync(join(homedir(), '.talkingclaw', 'avatars'))
      .filter((n) => n.toLowerCase().endsWith('.vrm'))
      .sort();
  } catch { return []; }
}

// PBI-025: 動き(.vrma)。素材もユーザーが置く(repo には入れない)
function listMotions(): string[] {
  try {
    return readdirSync(join(homedir(), '.talkingclaw', 'motions'))
      .filter((n) => n.toLowerCase().endsWith('.vrma'))
      .sort();
  } catch { return []; }
}
import { createVoiceSwitch } from './voiceswitch.ts';
import { findGuest, guestAllows, guestSummary, issueGuest, loadGuests, revokeGuest, saveGuests, type Guest } from './guests.ts';
import { hostAllowed, inviteHost, lanAddresses, originAllowed } from './net.ts';
import { SpeechPlane, UserSpeechState } from './convos/speech.ts';
import { TurnPlane } from './convos/turn.ts';
import { Voice } from './voice.ts'; // splitSentences は音声平面(convos/speech.ts)へ移った
import { HerdrBridge, type FleetView } from './herdr.ts';
import { writePbi } from './planpbi.ts';
import * as casino from './casino.ts';

const PORT = Number(process.env.PORT ?? 3300);
// PBI-036: どこまで出すか。**既定は今までどおり localhost だけ**。
// LAN に出すのは明示の opt-in（`ROOM_BIND=0.0.0.0`）—— 勝手に外へは出さない
const BIND = process.env.ROOM_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
const LAN = BIND === '0.0.0.0' ? lanAddresses() : [];
// 通してよい Host（列挙一致。**ここを緩めない**のが DNS rebinding 対策の本体）
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', ...LAN];
const LISTEN_MAX_S = 48; // S2: server 内部 deadline 上限
const TEXT_MAX = 4000;
const BODY_MAX = 64 * 1024;
const UPLOAD_MAX = 20 * 1024 * 1024; // こちらから送るファイルの上限

const store = new EventStore();
const registry = new Registry();
const voice = new Voice(config.tts);
const turnMetricClock = new TurnMetricClock();
const TURN_METRICS = new Set(['turn_created', 'stt_final', 'brain_first_token', 'tts_ready', 'play_started', 'turn_cancelled']);

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
// PBI-007: ローカル engine が落ちていても・冷えていても、クラウド合成が生きていれば声は出せる
const isEngineReady = (): boolean => engineState === 'ready' || voice.cloudReady;

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
const mic = new UserSpeechState(); // マイクの状態(§4.8)。既存の userSpeech() 関数と名前が衝突するので mic

// ---- 音声平面(会話OS §4.1/§4.3): TtsScheduler + FillerEngine ----
// 実装は src/convos/speech.ts。EngineManager は room.ts に残したまま、エンジンの生死は
// getter(isEngineReady)と報告 callback(reportSynthResult)だけを渡す(C1-①c で切った境界)。
const speech = new SpeechPlane({
  store, registry, voice, putAudio, isEngineReady, reportSynthResult, resolveVoice,
  metric, userSpeech: mic,
  // turn → channel の解決は Floor/Turn 層が持つ。下で定義される turn を実行時に読む
  turnChannel: (turnId) => turn.channelOf(turnId),
  // PBI-008 AC-6: 声の選択は役ごと。クロエは voiceSwitch、実況(作業係)は narratorSwitch。
  // どちらも選んでいなければ null = config の既定の声のまま(PBI-029 AC-6)
  voiceSnapshot: (pid) => (pid === chloePid ? voiceSwitch.snapshot()
    : pid !== null && pid === narratorPid ? narratorSwitch.snapshot() : null),
});

// ---- PBI-008: 声スイッチャー(候補・試聴・選択)----
// 実装は src/voiceswitch.ts。room 側が渡すのは「合成の口・話者一覧・会話が鳴っているか・
// commit の後始末」だけで、選択の永続化と課金の門(10 分 10 回 + WAL)は向こうが持つ。
async function localSpeakers(): Promise<{ speakerId: number; title: string }[]> {
  try {
    const r = await fetch(`${config.tts.url}/speakers`, { signal: AbortSignal.timeout(3000) });
    const speakers = (await r.json()) as { name: string; styles: { name: string; id: number }[] }[];
    return speakers.flatMap((s) => s.styles.map((st) => ({ speakerId: st.id, title: `${s.name}/${st.name}` })));
  } catch {
    return []; // engine 不通 = ローカルの声は今は出せない(Fish の候補だけ出す)
  }
}

// 会話が音を出している最中は試聴させない(AC-5: 再生 overlap 0・Fish へ 0 リクエスト)。
// 根拠は pendingSpeechSnapshot と同じ「/played がまだ来ていない audio 付き発話」。
// ただし直近 60s に絞る — 再生通知が来ないまま残った古い発話で試聴が永久に塞がらないように。
function conversationBusy(): string | null {
  if (mic.active) return 'いま話してる最中みたいだから、試聴はそのあとでね';
  const since = Date.now() - 60_000;
  for (const ev of store.since(Math.max(0, store.lastId - 200))) {
    if (ev.type !== 'agent_speech' || !ev.audio || playedIds.has(ev.id)) continue;
    if (Date.parse(ev.at) >= since) return '読み上げ中だから、終わってからにしてね';
  }
  return null;
}

const voiceSwitch = createVoiceSwitch({
  fish: { apiKey: config.tts.fish.apiKey, base: config.tts.fish.base },
  previewFish: (referenceId, text) => voice.previewFish(referenceId, text),
  localSynth: (text, speakerId) => voice.previewLocal(text, speakerId),
  localSpeakers,
  cloudCooldown: () => Date.now() < voice.diag.cooldownUntil,
  conversationBusy,
  lastUsed: () => voice.lastUsed,
  onCommit: (selection, revision) => {
    // 合成中 / 再生中の turn は cancel しない。切替は次の turn から(AC-6)。
    // 旧い声で焼いた相槌プールだけをここで失効させる(新プールが出来るまで相槌は text-only)
    if (chloePid) {
      speech.invalidatePool(chloePid);
      const resolved = registry.get(chloePid)?.voice.resolvedSpeaker;
      if (engineState === 'ready' && typeof resolved === 'number') speech.buildAckPool(chloePid, resolved);
    }
    store.append({
      type: 'system', from: 'room',
      text: `声を「${selection?.title ?? '既定'}」にしたよ。次の返事から切り替わるね`,
    });
    metric('voice_selected', { revision, provider: selection?.provider ?? 'default' });
  },
});

// PBI-029: 実況(作業係)の声。**同じ部品をもう 1 つ**置くだけ(選択の保存先だけが違う)。
// 試聴はこちらに来ない —— 課金の門(10 分 10 回)を 2 つに増やさないため、preview は常に上の本体が捌く。
const narratorSwitch = createVoiceSwitch({
  fish: { apiKey: config.tts.fish.apiKey, base: config.tts.fish.base },
  previewFish: (referenceId, text) => voice.previewFish(referenceId, text),
  localSynth: (text, speakerId) => voice.previewLocal(text, speakerId),
  localSpeakers,
  cloudCooldown: () => Date.now() < voice.diag.cooldownUntil,
  conversationBusy,
  lastUsed: () => voice.lastUsed,
  stateDir: pathMod.join(homedir(), '.talkingclaw', 'voice-narrator'),
  onCommit: (selection, revision) => {
    if (narratorPid) {
      speech.invalidatePool(narratorPid);
      const resolved = registry.get(narratorPid)?.voice.resolvedSpeaker;
      if (engineState === 'ready' && typeof resolved === 'number') speech.buildAckPool(narratorPid, resolved);
    }
    store.append({
      type: 'system', from: 'room',
      text: `実況の声を「${selection?.title ?? '既定'}」にしたよ。次の報告から切り替わるね`,
    });
    metric('voice_selected', { revision, provider: selection?.provider ?? 'default', role: 'narrator' });
  },
});

// user_speech が EventStore に入るたび channel revision を進める。全入口をここで捕まえるため、
// /chat 以外から追加された発話でも旧音声・旧 Brain callback を同じ規則で失効できる。
store.onAppend((ev) => {
  if (ev.type === 'user_speech') speech.advanceRevision(ev.channel ?? 'work');
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
    if (e.type === 'user_speech' && e.turnId) turn.markDelivered(e.turnId, pid);
  }
  const stripped = events.map(({ audio, ...rest }) => rest); // S2: agent 応答から audio 除去
  return { status: 'speech', bootId: store.bootId, truncated, events: stripped, cursor: events[events.length - 1].id };
}

store.onAppend((ev) => {
  const ch = ev.channel ?? 'work';
  if (ev.type === 'user_speech') transcriptAppend(ch, 'あなた', ev.text ?? '');
  else if (ev.type === 'agent_speech' && !ev.filler && ev.text) transcriptAppend(ch, ev.name ?? ev.from, ev.text);
  // PBI-021: 話すたびに相棒の 9 軸が育つ。相槌(filler)は観測しない(内容が無い)。
  // observeTurn は例外を外に出さない — 人格の計算で会話を止めない
  if (ev.text && (ev.type === 'user_speech' || (ev.type === 'agent_speech' && !ev.filler))) {
    observeTurn({ speaker: ev.type === 'user_speech' ? 'user' : 'agent', text: ev.text, at: ev.at, sessionId: ev.turnId });
    // PBI-024: 覚える価値のある語の候補を溜める(**勝手に覚えない**。聞いてから)
    if (ev.type === 'user_speech') observeText(ev.text, dictionaryWords());
  }
  if (ev.type === 'agent_speech' && !ev.filler && ev.audio === null && ev.from !== 'room') turn.advanceFloor(ev.from); // S4
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

// ---- Floor / Turn / escalation(会話OS §4.2/§4.3)----
// 実装は src/convos/turn.ts。在室判定(inThisRoom)と既定の宛先(chloePid)は「今どの部屋か」に
// 依存する room.ts 側の状態なので、ここに残して getter として渡す。
// filler の音声(事前合成プール)は音声平面が持つので cue 経由で受け取る(①で引いた線を跨がない)。
const turn = new TurnPlane({
  store, registry, metric, userSpeech: mic,
  contextCue: (pid, rotate) => speech.contextCue(pid, rotate),
  statusCue: () => speech.statusCue(),
  undeliveredCue: () => speech.undeliveredCue(),
  inThisRoom: (pid) => inThisRoom(pid),
  chloePid: () => chloePid,
});

// 話しかけられるのは今いる部屋にいる相手だけ(クロエはどの部屋にもいる)。
// 別の部屋にいる相手に届けたい時は、在室リストから「呼ぶ」で連れてくる
function inThisRoom(pid: string): boolean {
  if (pid === chloePid) return true;
  return (participantRoom.get(pid) ?? 'work') === activeChannel;
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
// PBI-024: 聞き間違い辞書の語は「既に知っている語」として扱う(二重に聞かない)
function dictionaryWords(): string[] {
  try {
    const d = JSON.parse(readFileSync(DICT_PATH, 'utf8')) as Record<string, string>;
    return Object.entries(d).flat().filter((x): x is string => typeof x === 'string');
  } catch { return []; }
}
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
// ---- PBI-028: 手番の声かけ（実況とは別の「あなたに向けた一言」）----
// **LLM を呼ばない**。台詞は casino.ts の固定表で、乱数ではなく回数で選ぶ(検査できる形)。
// 話すのは「手番が false → true に変わった瞬間」だけ。同じ手番のまま盤面が何度更新されても黙る。
const IDLE_TALK_MS = Number(process.env.TURN_IDLE_MS ?? 25_000);
type TurnTalk = { onTurn: boolean; said: number; idle: ReturnType<typeof setTimeout> | null };
const turnTalk = new Map<string, TurnTalk>();

function sayAsChloe(text: string, channel: Channel): void {
  if (!chloePid) return;
  const name = registry.get(chloePid)?.assignedName ?? config.character.name;
  speech.speakSentences(chloePid, name, text, turn.nextTurnId('T'), channel);
}

/** 盤面が動いた後に呼ぶ。手番になった瞬間だけ声をかけ、黙っていたら様子を伺う */
function turnTalkTick(channel: Channel): void {
  const st = turnTalk.get(channel) ?? { onTurn: false, said: 0, idle: null };
  const session = gameSessions.get(channel) ?? null;
  const view = casino.view(session);
  const now = session !== null && view.yourTurn;
  if (st.idle) { clearTimeout(st.idle); st.idle = null; }   // 盤面が動いた = 待たせていない
  if (now && !st.onTurn) {
    // 会話が最優先。ユーザーが話している最中には割り込まない(CLAUDE.md §2 / AC-7)
    // PBI-039: 言い回しは 9 軸で選ぶ（推論ゼロ）
    let tone = 0;
    try { tone = attitudeTone(currentPersona().values); } catch { /* 素のままで話す */ }
    const line = mic.active ? null : casino.turnLine(view.kind, st.said, tone);
    if (line) { sayAsChloe(line, channel); st.said += 1; }
    const timer = setTimeout(() => {
      const cur = turnTalk.get(channel);
      if (!cur?.onTurn || mic.active) return;               // もう手番じゃない / 話している最中
      if (!casino.view(gameSessions.get(channel) ?? null).yourTurn) return;
      let tone2 = 0;
      try { tone2 = attitudeTone(currentPersona().values); } catch { /* 素のまま */ }
      sayAsChloe(casino.idleLine(cur.said, tone2), channel);
      cur.idle = null;
    }, IDLE_TALK_MS);
    timer.unref?.();
    st.idle = timer;
  }
  st.onTurn = now;
  turnTalk.set(channel, st);
}

// PBI-043: **AI が考える間合い**。人が打った後、他家は 1 手ずつこの間隔で打つ。
// 一瞬で 3 人ぶん流れると「シミュレーションを見ている」感じになり、卓に着いている感じが消える
const THINK_MS = Number(process.env.TABLE_THINK_MS ?? 5000);
const thinkTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 次の 1 手を間合いを置いて進める。人の番になったら止まる */
function scheduleThink(channel: Channel): void {
  const prev = thinkTimers.get(channel);
  if (prev) clearTimeout(prev);
  const session = gameSessions.get(channel) ?? null;
  if (!session || casino.humanTurnPending(session)) { armTableIdle(channel); return; }
  const timer = setTimeout(() => {
    thinkTimers.delete(channel);
    const cur = gameSessions.get(channel) ?? null;
    if (!cur) return;
    const reply = casino.stepOnce(cur);
    if (reply) {
      if (reply.session) gameSessions.set(channel, reply.session); else gameSessions.delete(channel);
      saveGames();
      const name = registry.get(chloePid ?? '')?.assignedName ?? config.character.name;
      for (const line of reply.say) speech.speakSentences(chloePid ?? 'room', name, line, turn.nextTurnId('S'), channel);
    }
    scheduleThink(channel);   // 次の人も AI ならまた間合いを置く
  }, THINK_MS);
  timer.unref?.();
  thinkTimers.set(channel, timer);
}

// PBI-038: 手番のまま止まっている人の代わりに 1 手打つまでの時間。
// **他人を待たせない**ための仕掛けなので、1 人の卓では発火しない（考える時間は奪わない）
const TABLE_IDLE_MS = Number(process.env.TABLE_IDLE_MS ?? 60_000);
const tableIdle = new Map<string, ReturnType<typeof setTimeout>>();

/** 手番の人が止まったら面子が代打ちする。**打つたびに張り直す**（打てば消える） */
function armTableIdle(channel: Channel): void {
  const prev = tableIdle.get(channel);
  if (prev) clearTimeout(prev);
  const session = gameSessions.get(channel) ?? null;
  if (!session) return;
  const humans = casino.humanIds(session);
  if (humans.size < 2) return;                     // 1 人なら誰も待っていない(AC-3)
  const view = casino.view(session);
  if (!view.yourTurn && view.kind !== 'mahjong') return;
  const timer = setTimeout(() => {
    const cur = gameSessions.get(channel) ?? null;
    if (!cur) return;
    // 誰の番で止まっているか（人間の席だけ見る）
    for (const id of casino.humanIds(cur)) {
      const reply = casino.autoPlay(cur, id);
      if (!reply) continue;
      if (reply.session) gameSessions.set(channel, reply.session); else gameSessions.delete(channel);
      saveGames();
      const name = registry.get(chloePid ?? '')?.assignedName ?? config.character.name;
      for (const line of reply.say) speech.speakSentences(chloePid ?? 'room', name, line, turn.nextTurnId('A'), channel);
      armTableIdle(channel);                       // 次の人の番でまた見る
      return;
    }
  }, TABLE_IDLE_MS);
  timer.unref?.();
  tableIdle.set(channel, timer);
}

/** PBI-037: その部屋に居る**人間**（ホスト + 生きているゲスト）。卓の席はこの順に埋まる */
function humansIn(channel: Channel): { id: string; name: string }[] {
  const now = Date.now();
  const guests = guestFile.guests
    .filter((g) => !g.revoked && Date.parse(g.expiresAt) > now && g.channel === channel)
    .map((g) => ({ id: g.id, name: g.name }));
  return [{ id: 'you', name: 'あなた' }, ...guests].slice(0, 4);
}

function tryGame(text: string, opts: { actor?: string; channel?: Channel } = {}): number | null {
  const channel = opts.channel ?? activeChannel;
  const actor = opts.actor ?? 'you';
  const session = gameSessions.get(channel) ?? null;
  const cmd = casino.parseCommand(text, session);
  if (!cmd) return null;
  if (!session && cmd.type !== 'start') return null;
  if (!chloePid) return null; // 進行役がいない部屋では遊べない

  const reply = cmd.type === 'start'
    ? casino.start(cmd.game, (Date.now() ^ (store.lastId * 2654435761)) | 0, gameOpponents(), cmd.blind, humansIn(channel))
    // PBI-043: 人の手だけ適用する。他家は下の scheduleThink が 1 手ずつ進める
    : casino.apply(session!, cmd, actor, { stepwise: true });

  // 発話は残す(会話の記録として)。targets を空にしてあるので Brain は起こさない
  const turnId = turn.nextTurnId("G");
  const ev = store.append({
    type: 'user_speech', from: 'user', text, turnId, targets: [],
    routing: { method: 'default' }, channel: channel,
  });
  if (reply.session) gameSessions.set(channel, reply.session);
  else {
    gameSessions.delete(channel);
    const t = thinkTimers.get(channel);
    if (t) { clearTimeout(t); thinkTimers.delete(channel); }   // やめたら間合いも止める(AC-7)
  }
  saveGames();
  if (reply.hand) store.append({ type: 'system', from: 'room', text: reply.hand, channel: channel });
  // あなただけに見せる情報は system として画面に出すだけ。読み上げないし記録にも残さない
  // (進行役の発言として残すと、同じ卓にいる相手の文脈に手牌が戻ってしまう)
  for (const line of reply.show ?? []) {
    store.append({ type: 'system', from: 'room', text: line, channel: channel });
  }
  const name = registry.get(chloePid)?.assignedName ?? config.character.name;
  for (const line of reply.say) speech.speakSentences(chloePid, name, line, turnId, channel);
  turnTalkTick(channel);   // PBI-028: 手番が回ってきたら一言(実況の後)
  scheduleThink(channel);  // PBI-043: 他家は 5 秒くらい考えてから 1 手ずつ打つ(中で armTableIdle も呼ぶ)
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
  if (!looksIncomplete(text) && !mic.active) {
    pending = null;
    return userSpeech(merged); // 言い切っていて、もう話していない → 即確定
  }
  if (heldTooLong && !mic.active) {
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
    if (mic.active && Date.now() - pending.firstAt < FRAGMENT_MAX_HOLD_MS) {
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

function userSpeech(rawText: string, viaMemo?: { turnId: string }): RoomEvent {
  // PBI-003: 伝言(viaMemo)は channel=work 固定で、routing・permission・consult・turn tracking は
  // 部屋の発話と同じ経路を通す(AC-7)。部屋のマイク・添付・turn_created 計上だけが部屋起点限定。
  const channel: Channel = viaMemo ? 'work' : activeChannel;
  const text = applyDict(rawText);
  if (!viaMemo) mic.clear(); // 発話がここまで届いた = この turn の「発話中」は終了(client 側 false 通知の到着順に依存しない)
  // W8-8: 許可待ち中の短い諾否はパーミッションへの返答として扱う(伝言からも答えられる)
  if (pendingPermission) {
    const t = text.trim();
    if (PERM_YES.test(t)) {
      const ev = store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' }, channel });
      finishPermission(true, 'おっけー、許可したよ。続けるね。');
      return ev;
    }
    if (PERM_NO.test(t)) {
      const ev = store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' }, channel });
      finishPermission(false, 'わかった、それはやめておくね。');
      return ev;
    }
  }
  if (process.env.ROOM_TEST_HOOKS === '1' && text === '__askperm__') {
    void askUserPermission('テスト機能').then((ok) => store.append({ type: 'system', from: 'room', text: `perm:${ok}` }));
    return store.append({ type: 'user_speech', from: 'user', text, targets: [], routing: { method: 'default' }, channel });
  }
  const { targets, routing } = turn.route(text);
  const turnId = viaMemo?.turnId ?? turn.nextTurnId("T");
  beginTurnMetrics(turnId, viaMemo ? 'memo' : 'room');
  const ev = store.append({ type: 'user_speech', from: 'user', text, turnId, targets, routing, channel, files: !viaMemo && pendingFiles.length > 0 ? pendingFiles : undefined });
  if (!viaMemo) {
    pendingFiles = [];
    // 伝言の turn_created は memo.ts(recordMetric)が確定行の後に 1 回だけ出す — ここでも出すと二重計上
    metric('turn_created', { turnId, path: 'room', method: routing?.method, targets: targets.length });
  }
  if (targets.length === 1) {
    turn.track(turnId, targets[0], text, channel);
    speech.fireAck(targets[0], turnId, text); // S6: t=0 相槌(単独 target のみ)
    turn.scheduleEscalation(turnId, targets[0], 1, 3_500); // /played で前倒し、無ければ fallback
    turn.scheduleUndeliveredNotice(turnId, targets[0]);
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
      const revision = speech.advanceRevision('work'); // 直前の読み上げ待ちより優先して届ける
      speech.enqueue({ pid: chloePid, priority: 1, kind: 'speech', text: `作業係が${desc}を使いたいって。許可していい?`, turnId: 'none', revision, channel: 'work' });
    }
  });
}

function finishPermission(ok: boolean, say: string): void {
  if (!pendingPermission) return;
  clearTimeout(pendingPermission.timer);
  pendingPermission.resolve(ok);
  pendingPermission = null;
  if (chloePid) speech.enqueue({ pid: chloePid, priority: 1, kind: 'speech', text: say, turnId: 'none', revision: speech.revision('work'), channel: 'work' });
}

const PERM_YES = /^(はい|うん|いいよ|いいですよ|おっけ|オッケー|ok|オーケー|許可|どうぞ|やって|承認)/i;
const PERM_NO = /^(だめ|ダメ|駄目|やめて|いや|嫌|不許可|禁止|no|ノー|見送)/i;

// ---- PBI-003: 伝言(memo)の submit adapter・永続 dedupe 台帳・read 契約 ----
// 台帳は crash を跨ぐ(AC-10): 副作用(user_speech/Brain/task)より先に追記し、
// 再送は同じ turnId を返すだけで新しい実行を始めない。memo-log(memo.ts 側)が
// 確定行を書く前に落ちても、ここが同一応答を保証する。
const MEMO_LEDGER_PATH = join(homedir(), '.talkingclaw', 'memo-submit-ledger.jsonl');
const memoLedger = new Map<string, { turnId: string; text: string }>();
const memoTurnCid = new Map<string, string>(); // turnId → clientMessageId(reply/report の相関)
const convCtx = new Map<Channel, { turnId?: string }>(); // 会話 Brain が今どの turn を処理中か(delegate の相関源)
try {
  for (const line of readFileSync(MEMO_LEDGER_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { clientMessageId?: string; turnId?: string; text?: string };
      if (!r.clientMessageId || !r.turnId) continue;
      memoLedger.set(r.clientMessageId, { turnId: r.turnId, text: r.text ?? '' });
      memoTurnCid.set(r.turnId, r.clientMessageId);
    } catch { /* 壊れた行は飛ばす(残りは生かす) */ }
  }
} catch { /* 台帳無し = 初回 */ }

async function memoSubmit({ text, clientMessageId }: { text: string; clientMessageId: string }): Promise<{ turnId: string; dedup: boolean }> {
  const hit = memoLedger.get(clientMessageId);
  if (hit) {
    // crash 後の再送(memo 確定行が無い形)もここで受け、副作用ゼロで同じ turn を返す(AC-10)。
    // dedup=true = この呼び出しは user_speech / Brain / OfficeTask を作っていない(裁定 17:08)
    if (hit.text !== text) throw Object.assign(new Error('同じ clientMessageId が別の内容で使われています'), { status: 409 });
    return { turnId: hit.turnId, dedup: true };
  }
  // turnId は永続台帳に残るので、プロセス毎カウンタの nextTurnId だけだと再起動を跨いで衝突する
  // (実測: 2 プロセスとも T1 を発行し相関 map が上書きされた)。bootId を含めて一意化する
  const turnId = `${turn.nextTurnId('M')}-${store.bootId.slice(0, 8)}`;
  mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
  appendFileSync(MEMO_LEDGER_PATH, JSON.stringify({ at: new Date().toISOString(), clientMessageId, turnId, text }) + '\n', { mode: 0o600 });
  memoLedger.set(clientMessageId, { turnId, text });
  memoTurnCid.set(turnId, clientMessageId);
  userSpeech(text, { turnId }); // 既存 routing・permission・consult・turn tracking を通す(channel=work 固定)
  if (process.env.ROOM_TEST_HOOKS === '1' && text.includes('__memocrash__')) {
    // AC-10 の crash point 注入: user_speech と task は作成済み・memo 確定行と HTTP ack の前で落ちる
    officeTasks.push({
      id: ++taskSeq, agent: 'test', agentName: 'テスト', request: text, status: 'queued',
      notes: [], artifacts: [], at: new Date().toISOString(), channel: 'work',
      sourceTurnId: turnId, clientMessageId,
    });
    saveTasks();
    process.exit(21);
  }
  return { turnId, dedup: false }; // この呼び出しが user_speech / turn を新しく作った
}

// read 契約: work channel の reply(本応答)・note(実況)・report(作業報告)を
// MemoEntry の形に正規化して memo handler へ流す。report には相関 id を載せる(AC-9 の土台)
type MemoRead = { kind: 'reply' | 'note' | 'report'; text: string; name?: string; turnId?: string; sourceTurnId?: string; clientMessageId?: string };
const taskReportListeners: ((task: OfficeTask) => void)[] = [];
function memoReadSubscribe(cb: (e: MemoRead) => void): () => void {
  const offEvents = store.onAppend((ev) => {
    if (ev.type !== 'agent_speech' || ev.filler || ev.from === 'room') return;
    if ((ev.channel ?? 'work') !== 'work') return;
    const text = ev.text ?? '';
    if (!text.trim()) return;
    if (!ev.turnId || ev.turnId === 'none') cb({ kind: 'note', text, name: ev.name });
    else cb({ kind: 'reply', text, name: ev.name, turnId: ev.turnId, clientMessageId: memoTurnCid.get(ev.turnId) });
  });
  const onReport = (task: OfficeTask): void => {
    if (!task.report) return;
    const lines = [task.report.headline, ...task.report.can];
    if (task.report.check.length > 0) lines.push(`確かめかた: ${task.report.check.join(' / ')}`);
    cb({ kind: 'report', text: lines.join('\n'), name: task.agentName, sourceTurnId: task.sourceTurnId, clientMessageId: task.clientMessageId });
  };
  taskReportListeners.push(onReport);
  return () => {
    offEvents();
    const i = taskReportListeners.indexOf(onReport);
    if (i >= 0) taskReportListeners.splice(i, 1);
  };
}

// AC-3: memo path 限定の origin 規則。MEMO_PUBLIC_ORIGIN=https://<host> の exact Host/Origin だけを
// 追加許可する。部屋 UI(originOk)の規則はここでは一切緩めない。
const memoPublicOrigin = ((): URL | null => {
  const raw = process.env.MEMO_PUBLIC_ORIGIN;
  if (!raw) return null;
  try { return new URL(raw); } catch { console.error(`MEMO_PUBLIC_ORIGIN が URL として不正: ${raw}`); return null; }
})();
function memoOriginOk(req: IncomingMessage): boolean {
  if (originOk(req)) return true; // localhost は従来どおり(隔離検証・局所利用)
  if (!memoPublicOrigin) return false;
  const host = req.headers.host;
  if (!host || host.replace(/:\d+$/, '') !== memoPublicOrigin.hostname) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== memoPublicOrigin.origin) return false;
  return true;
}

const memoHandler = createMemoHandler({
  submit: memoSubmit,
  read: { subscribe: memoReadSubscribe },
  recordMetric: ({ kind, ...rest }) => metric(kind, rest),
  identity: (req) => {
    // 認証境界は Tunnel + hostname 全体の Access。このヘッダは表示用で、単独の認証根拠にしない
    const v = req.headers['cf-access-authenticated-user-email'];
    return typeof v === 'string' && v !== '' ? v : null;
  },
});

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return `コマンド実行(${String(input.command ?? '').slice(0, 50)})`;
  const m = name.match(/^mcp__([^_]+)__(.+)$/);
  if (m) return `${m[1]} の ${m[2]}`;
  return name;
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
// PBI-011: temp→rename の原子的書込み。外部の読み手(worker 起動時の loadProjects)は
// 旧か新の完全な版だけを見る — 書きかけの半端な JSON を読ませない
function saveProjects(next: Record<string, string>): void {
  const tmp = PROJECTS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
  renameSync(tmp, PROJECTS_PATH);
}
function loadProjects(): Record<string, string> {
  let user: Record<string, string> = {};
  try { user = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8')); } catch { /* 初回 */ }
  const merged = {
    workspace: config.agent.cwd,
    talkingclaw: fileURLToPath(new URL('..', import.meta.url)),
    ...user,
  };
  try { saveProjects(merged); } catch { /* 書けなくても merged で動ける */ }
  return merged;
}

// ---- PBI-012: GitHub URL から clone して作業先に登録する ----
// 認証は gh に丸投げ(keyring に入っている資格情報がそのまま効くので private repo も届く)。
// 受けるのは https の URL だけ(SSH はスコープ外)。置き場は workspace 直下に固定
const GH_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
// 登録名に使える形。clone した repo 名をそのまま名前にするので、GitHub の repo 名(`.` を含む・
// 長め)がそのまま通る幅に合わせてある。先頭は英数字に限る(`.`/`-` 始まりの紛らわしい名前を作らない)
const PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
// gh の在り処を PATH だけに頼らない —— 部屋は LaunchDaemon の薄い PATH から起動されることがあり、
// Apple Silicon の brew は /opt/homebrew に入る(herdr.ts の BIN_CANDIDATES と同じ手当て)
const GH_CANDIDATES = process.env.GH_BIN ? [process.env.GH_BIN] : ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
// 結果は覚えない —— 後から brew install した gh をすぐ拾えるし、探すのは設定パネルを開いた時と
// clone の直前だけ。在れば 1 つ目の候補で即決まる
async function ghPath(): Promise<string | null> {
  for (const bin of GH_CANDIDATES) {
    try { await execFileAsync(bin, ['--version'], { timeout: 5_000 }); return bin; } catch { /* 次の候補 */ }
  }
  return null;
}
// 認証済みかは `auth token`(ローカルの保管を読むだけ)で見る。`auth status` は API を叩くので
// パネルを開くたびに待たされる
async function ghAuthed(bin: string): Promise<boolean> {
  try { await execFileAsync(bin, ['auth', 'token'], { timeout: 5_000 }); return true; } catch { return false; }
}
const CLONE_TIMEOUT_MS = Number(process.env.CLAW_CLONE_TIMEOUT_MS ?? 15 * 60_000);
const REPO_LIST_LIMIT = 200; // ここで打ち止めたことは画面にも出す(黙って切らない)
const BROWSE_LIMIT = Number(process.env.CLAW_BROWSE_LIMIT ?? 500); // 1 フォルダに出す上限(同上)
// PBI-017: 落とされたフォルダの受け入れ。上限は「送り始める前に断る」ために使う
const INTAKE_MAX_FILES = Number(process.env.CLAW_INTAKE_MAX_FILES ?? 2000);
const INTAKE_MAX_BYTES = Number(process.env.CLAW_INTAKE_MAX_BYTES ?? 200 * 1024 * 1024);
const intakes = new Map<string, { dir: string; files: number; bytes: number; wrote: number; bytesWrote: number; at: number }>();
const cloning = new Set<string>(); // 進行中の clone 先(別タブ・リロードでは画面の disabled が共有されない)
// timeout で gh を殺すだけでは足りない —— 実際に落としているのは孫の git。プロセスグループごと畳まないと
// 「打ち切った」と言った後も裏で clone が続き、出来上がったフォルダが次回の「もう在るよ」を永久に踏む
// PBI-016: 画面から GitHub にログインする。gh の web フロー(device code)を部屋が起こして、
// 出てくる 8 桁コードを画面に渡すだけ —— トークンは gh が keyring に入れる。部屋は持たない
type GhAuth = { child: ChildProcess; code: string; url: string; out: string; done: null | { ok: boolean; why: string }; at: number };
let ghAuth: GhAuth | null = null;
function ghAuthStart(bin: string): Promise<GhAuth> {
  const child = spawn(bin, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key', '--web'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_BROWSER: 'true' }, // 部屋の側でブラウザを開かない(開くのはユーザーの画面)
  });
  const state: GhAuth = { child, code: '', url: 'https://github.com/login/device', out: '', done: null, at: Date.now() };
  const read = (d: Buffer): void => {
    state.out += d.toString();
    const m = /one-time code:\s*([A-Z0-9-]{4,20})/i.exec(state.out);
    if (m) state.code = m[1];
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.once('close', (codeNum) => {
    state.done = codeNum === 0 ? { ok: true, why: '' } : { ok: false, why: state.out.trim().slice(-400) || `gh が ${codeNum} で終わった` };
  });
  child.once('error', (e) => { state.done = { ok: false, why: e.message }; });
  ghAuth = state;
  // コードが出るまで待つ(実測 1 秒未満。出ないまま終わるなら、その理由を返す)
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (state.code || state.done || Date.now() - t0 > 10_000) { clearInterval(tick); resolve(state); }
    }, 100);
  });
}
// (execFile ではなく spawn を使うのは detached を渡すため —— execFile の型は通してくれない)
function ghClone(bin: string, repo: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['repo', 'clone', repo, dir], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; // gh の言い分はここに出る(そのまま画面に返す)
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString(); });
    const timer = setTimeout(() => {
      // pid が無い時に process.kill(-0) を撃つと自分のグループを殺す(自傷)。必ず pid を確かめてから
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL');
      reject(Object.assign(new Error('clone が長すぎた'), { killed: true }));
    }, CLONE_TIMEOUT_MS);
    child.once('error', (e) => { clearTimeout(timer); reject(e); }); // gh を起動できなかった
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`gh が ${code} で終わった`), { stderr }));
    });
  });
}

// ---- PBI-014: herdr 連携(端末の艦隊を声から見る・立てる・指示を渡す)----
// fleetView は「最後に見た艦隊」。ツールでも画面のボタンでも更新され、作業ボードの表として出る
const fleet = new HerdrBridge();
let fleetView: FleetView | null = null;
// 艦隊操作の入口は 1 つ(ツール・画面のボタンが同じここを通る)。声で読み上げる文もここで決める
async function fleetAct(a: { action: string; target?: string; text?: string; name?: string; workspace?: string; project?: string; lines?: number }): Promise<{ say: string; error?: string }> {
  if (a.action === 'list') {
    const v = await fleet.list();
    fleetView = v;
    if (v.error) return { say: `herdr を見られなかった: ${v.error}`, error: v.error };
    if (v.agents.length === 0) return { say: 'herdr に agent は 1 人も居ない。そう伝えて。' };
    const lines = v.agents.map((x) => `${x.name ?? x.pane}(${x.pane} / ${x.status}${x.mine ? ' / 部屋が立てた子' : ''}) ${x.title.slice(0, 40)}`);
    const working = v.agents.filter((x) => x.status === 'working').length;
    return { say: `画面に一覧を出した。全部で ${v.agents.length} 人、動いているのは ${working} 人。数は盛らず、このとおりに短く伝えて。\n${lines.join('\n')}` };
  }
  if (a.action === 'start') {
    const cwd = a.project ? loadProjects()[a.project] : undefined;
    if (a.project && !cwd) return { say: `${a.project} という作業先は登録されていない。そう伝えて。`, error: 'unknown project' };
    const r = await fleet.start({ name: a.name ?? a.target ?? '', workspace: a.workspace, cwd });
    if ('error' in r) return { say: `立てられなかった: ${r.error}`, error: r.error };
    fleetView = await fleet.list();
    // 初めての場所で起動した claude は「このフォルダを信頼するか」で止まる(blocked)ことがある。
    // 黙って待たせずに、見に行く必要があるかもしれないと最初に言っておく
    return { say: `${a.name ?? a.target} を ${r.pane} に立てた。画面は切り替えていない。初めての場所だと最初の確認で止まることがあるので、herdr の画面を見てあげてと伝えて。` };
  }
  if (a.action === 'prompt') {
    if (!a.target || !a.text) return { say: '誰に何を渡すかが足りない。聞き直して。', error: 'missing target/text' };
    const r = await fleet.prompt(a.target, a.text);
    if ('error' in r) return { say: `渡せなかった: ${r.error}`, error: r.error };
    fleetView = await fleet.list();
    // 送れたこと自体は失敗ではないので error にはしない。ただし裏取りできていない時は
    // 「渡した」と言わせない —— 文面で正直に分ける(AC-3)
    return r.confirmed
      ? { say: `${a.target} に渡した(今 ${r.status})。短く「渡したよ」と伝えて。` }
      : { say: `${a.target} に送ったけれど、画面に反映されたか確認できなかった。「届いたか分からない」と正直に伝えて。` };
  }
  if (a.action === 'read') {
    if (!a.target) return { say: '誰の様子を読むかが足りない。聞き直して。', error: 'missing target' };
    const r = await fleet.read(a.target, a.lines ?? 60);
    if ('error' in r) return { say: `読めなかった: ${r.error}`, error: r.error };
    return { say: `${a.target}(${r.pane})の画面。ここから要点だけ 1〜2 文で伝えて。\n${r.text.slice(-1500)}` };
  }
  return { say: 'その操作は知らない。', error: 'unknown action' };
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
  sourceTurnId?: string;                    // PBI-003: どの伝言(turn)から生まれた作業か
  clientMessageId?: string;                 // PBI-003: 伝言の相関 id(root=X 系列)
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
type Plan = { summary: string; steps: string[]; accept?: string[]; project?: string; at: string };
// ponytail: 相談中の案は in-memory(daemon 再起動で消える)。まとまった案はタスク台帳に残るので、
// 永続化は「相談の途中で落ちるのが実際に困る」と分かってからでいい
let plan: Plan | null = null;
let planDelegate: ((description: string, project?: string) => OfficeTask) | null = null;

function planText(p: Plan): string {
  return p.summary + (p.steps.length > 0 ? '\n進め方:\n' + p.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '');
}

// PBI-013: 案 → PBI。作れたら相対 path、作らなかったら理由。どちらの道でも声と画面に同じ文が出る(AC-3)。
// 採番と雛形は src/planpbi.ts(検査から直接当てるため部屋の外に出してある)
function planPbi(p: Plan): { pbi: string; note: string } {
  const name = p.project ?? 'workspace';
  const root = loadProjects()[name];
  if (!root) return { pbi: '', note: `作業先 ${name} が見つからないから PBI は作らなかったよ` };
  try {
    const file = writePbi(join(root, 'backlog'), p, new Date().toISOString().slice(0, 10));
    // 勝手に backlog/ を作らない。作らなかったことは黙らず言う(AC-3)
    if (!file) return { pbi: '', note: `${name} には backlog フォルダが無いから PBI は作らなかったよ` };
    return { pbi: `backlog/${file}`, note: `${name} の backlog/${file} に受入基準を残したよ` };
  } catch (e) {
    return { pbi: '', note: `PBI を書けなかった: ${(e as Error).message}` };
  }
}

function confirmPlan(): { ok: true; taskId: number; summary: string; pbi: string; note: string } | { ok: false; error: string } {
  if (!plan) return { ok: false, error: 'まだ相談中の案がないよ' };
  if (!planDelegate) return { ok: false, error: '作業係の準備がまだできていないよ' };
  const p = plan;
  plan = null; // 先に空にする(二重登録防止)
  // PBI を先に作る —— 作業係の依頼文に「受入基準はここ」を入れてから渡すため
  const { pbi, note } = planPbi(p);
  const task = planDelegate(planText(p) + (pbi ? `\n受入基準(G1): ${pbi} —— 着手前に読み、埋まっていない欄を確定させること。` : ''), p.project);
  store.append({ type: 'system', from: 'room', text: `相談まとまり → 作業に登録したよ: ${p.summary.slice(0, 60)}(${note})`, channel: 'work' });
  return { ok: true, taskId: task.id, summary: p.summary, pbi, note };
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
  const open = turn.openForBoard()
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
let narratorPid: string | null = null;   // PBI-029: 実況(作業係)。声はクロエと別に選べる
let chloeResetWorker: (() => void) | null = null;
let chloeResetChat: (() => void) | null = null;
let chloeReply: ((task: OfficeTask, text: string) => void) | null = null;
// W9-2: 本番は 180s(sonnet + delegate の長 turn を誤殺しない)。テストは短縮して回転を速く
// テスト時も「通常応答(context 注入込みで 20-40s)は切らず、ハングだけ捕まえる」値にする
const ASK_GUARD_MS = Number(process.env.ASK_GUARD_MS ?? (process.env.ROOM_TEST_HOOKS === '1' ? 90_000 : 180_000));
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
  narratorPid = helper?.participantId ?? null;   // PBI-029: 実況役の声を別に選ぶための宛先
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
    // PBI-003: 会話 Brain(work)の turn 処理中なら、その turn と相関させる。伝言起点なら
    // clientMessageId も引き継ぎ、最終 TaskReport が root=X 系列でページに帰属できるようにする
    const ctx = convCtx.get('work');
    const task: OfficeTask = {
      id: ++taskSeq, agent: chloePid!, agentName: chloe.assignedName, request: description, project,
      status: 'queued', notes: [], artifacts: [], at: new Date().toISOString(),
      channel: ctx ? 'work' : activeChannel,
      sourceTurnId: ctx?.turnId, clientMessageId: ctx?.turnId ? memoTurnCid.get(ctx.turnId) : undefined,
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
        pid: helperPid!, priority: 2, kind: 'speech', turnId: 'none', revision: speech.revision('work'), channel: 'work',
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
    for (const cs of channelState.values()) cs.resetBrain();
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
          pid: helperPid!, priority: 2, kind: 'speech', turnId: 'none', revision: speech.revision('work'), channel: 'work',
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
      // PBI-003: 伝言タイムラインへ最終報告を流す(相関 id 付き)。失敗しても作業は止めない
      for (const l of taskReportListeners) { try { l(task); } catch { /* memo 側の都合で本流を止めない */ } }
      const firstCan = task.report.can[0] ? `${task.report.can[0]} ` : '';
      speech.enqueue({
        pid: helperPid!, priority: 2, kind: 'speech', turnId: 'none', revision: speech.revision('work'), channel: 'work',
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
        '相談モードでの進め方の案。まだ着手はしない。summary は 1 行の要約、steps は具体的な手順 2〜5 個。accept は「何ができていたら終わりか」をユーザー目線で 1〜5 個(ここが受入基準としてそのまま backlog に残るので、会話で決まった条件だけを書く。決まっていないなら空でいい)。出したらそのまま声で読み上げて「これでいい?」と確認すること。直しの要望が来たら、直した案でもう一度呼ぶ。',
        { summary: z.string(), steps: z.array(z.string()).optional(), accept: z.array(z.string()).optional(), project: z.string().optional() },
        async ({ summary, steps, accept, project }) => {
          plan = { summary, steps: (steps ?? []).slice(0, 8), accept: (accept ?? []).slice(0, 5), project, at: new Date().toISOString() };
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
            ? `task ${r.taskId} として登録した。ユーザーには短く「じゃあ始めるね」と伝え、続けて「${r.note}」を一言で伝えること。`
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
      tool(
        'herdr',
        `端末の艦隊(herdr)を見る・立てる・指示を渡す・様子を読む。「herdr の様子見せて」= list、「claude をもう一人立てて」= start(name と workspace。workspace は w2 のような id)、「◯◯に△△やらせて」= prompt(target と text)、「◯◯どうなってる?」= read(target)。target は名前でもペイン id でもいい。指示を渡せるのは部屋が立てた子だけで、ユーザーが自分で開いたペインには送れない(読むのはできる)。start の作業先は project 名で指定する(${Object.keys(loadProjects()).join(' / ')})。`,
        {
          action: z.enum(['list', 'start', 'prompt', 'read']),
          target: z.string().optional(), text: z.string().optional(), name: z.string().optional(),
          workspace: z.string().optional(), project: z.string().optional(), lines: z.number().optional(),
        },
        async (a) => {
          const r = await fleetAct(a);
          return { content: [{ type: 'text' as const, text: r.say }] };
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
          ? [...workTools, 'mcp__office__read_inbox', 'mcp__office__mark_read', 'mcp__office__cancel_task', 'mcp__office__remember', 'mcp__office__room_status', 'mcp__office__learn_word', 'mcp__office__herdr']
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

  type ConversationInput = { text: string; turnId?: string; files?: string[]; onDone?: () => void };
  // 部屋ごとの会話 Brain。revision・最新 inbox・実行中 Brain を 1 部品で持ち、
  // 新発話時は interrupt の完了を待たず次の Brain を開始する。
  const channelState = new Map<Channel, LatestChannel<ConversationInput, Brain>>();
  function chan(channel: Channel): LatestChannel<ConversationInput, Brain> {
    let cs = channelState.get(channel);
    if (!cs) {
      cs = new LatestChannel({
        makeBrain: () => new Brain(makeConvBrainOpts(channel)),
        process: async (input, run) => {
          try {
            await askOnce(channel, input, run);
            if (run.isCurrent()) input.onDone?.();
          } catch (error) {
            if (!run.isCurrent()) return; // interrupt 後の旧 Brain の reject は画面にも声にも出さない
            const message = error instanceof Error ? error.message : String(error);
            store.append({ type: 'system', from: 'room', text: `クロエのエラー: ${message}`, channel });
            store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、ちょっと考えすぎちゃった。もう一回言ってくれる?', audio: null, turnId: input.turnId, channel });
          }
        },
        onCancel: (input) => {
          if (input.turnId) {
            turn.cancelEscalation(input.turnId);
            metric('turn_cancelled', { turnId: input.turnId, path: 'room', reason: 'new_user_speech' });
          }
        },
      });
      channelState.set(channel, cs); // 最初の ask に記憶 + 直近ログを注入
    }
    return cs;
  }

  // W9-2: 記憶忘れの根治 — memory 全文 + 直近ログを Brain 生成のたびに注入する
  function contextPrefix(channel: Channel, currentText = ''): string {
    const parts: string[] = [];
    const memo = readMemory();
    if (memo) parts.push(`(あなたが書き留めた大事なこと。必ず踏まえて)\n${memo}`);
    // PBI-024: 覚えた固有名詞。聞き取りが崩れた時の解釈のよりどころにする
    const vocabLine = promptLine(currentVocab());
    if (vocabLine) parts.push(vocabLine);
    // PBI-039: 育った 9 軸が態度に出る。初期状態（全軸 50）では**何も足さない**
    try {
      const attitude = attitudeLine(currentPersona().values);
      if (attitude) parts.push(attitude);
    } catch { /* 人格の計算で会話を止めない */ }
    const rows = transcriptTail(channel, 60);
    const latest = rows[rows.length - 1];
    if (latest?.who === 'あなた' && latest.text === currentText) rows.pop(); // 現在 prompt との二重投入を避ける
    if (rows.length > 0) parts.push(`(この部屋の直近の会話ログ。文脈の続きとして自然に振る舞って)\n${rows.map((r) => `${r.who}: ${r.text}`).join('\n')}`);
    // 遊んでいる最中なら、いまの場を教える。ユーザーの手札・手牌は brief に入れていない
    const gameBrief = casino.brief(gameSessions.get(channel) ?? null);
    if (gameBrief) parts.push(gameBrief);
    return parts.length > 0 ? `${parts.join('\n\n')}\n---\n` : '';
  }

  // test seam のマーカー(裁定 21:24)。gate は既存と同じ ROOM_TEST_HOOKS 1 枚 — 新しい env は作らない
  const CHLOESAY_MARKER = '__chloesay__ ';

  // Brain の代わりに本文をそのまま流す。切り方は brain.ts の #emitCompleteSentences と同じ
  // (句点の後ろで切って trim)。callback は speakStreamed が返す本番のものをそのまま使う。
  function echoAsChloe(body: string, emit: (sentence: string) => void, onFirstToken: () => void): Promise<string> {
    let first = true;
    for (const sentence of body.split(/(?<=[。．！？!?])/).map((s) => s.trim()).filter(Boolean)) {
      if (first) { onFirstToken(); first = false; }
      emit(sentence);
    }
    return Promise.resolve(body);
  }

  const speakStreamed = (channel: Channel, turnId: string | undefined, run: ChannelRun<Brain>): ((sentence: string) => void) => {
    let first = true;
    return (sentence) => {
      if (!run.isCurrent()) return;
      if (first && turnId) turn.markResponded(turnId);
      speech.enqueue({ pid: chloePid!, priority: first ? 1 : 2, kind: 'speech', text: sentence, turnId, revision: run.revision, channel });
      first = false;
    };
  };

  // ask を見張る。新 user_speech による中断は LatestChannel が即 detach し、ここで待たない。
  async function askOnce(channel: Channel, input: ConversationInput, run: ChannelRun<Brain>): Promise<void> {
    let text = input.text + attachmentNote(input.files);
    const hang = process.env.ROOM_TEST_HOOKS === '1' && text.includes('__hang__');
    // 裁定 2026-08-06 21:24(PBI-008 AC-6 の test seam)。hooks が立っている時だけ、
    // **Brain 呼び出しだけ**を「マーカー後の本文をそのまま返す」に置換する(echo)。
    // turn 生成・routing・文分割・job 化・revision 照合・EventStore append・metrics は本番経路のまま
    // = AC-6 が測る「turn 生成時 snapshot → 同一 turn 全 job 同一」を本番と同じ道で通す。
    // 縛り 2: memo 経由の turn では発火しない(クロエの発話 primitive を公開面から到達不能にする)。
    // 縛り 4: hooks 無効時はマーカーを解釈しない — ただの text として Brain へ渡る(分岐が消えるだけ)。
    const say = process.env.ROOM_TEST_HOOKS === '1'
      && !(input.turnId && memoTurnCid.has(input.turnId))
      && text.startsWith(CHLOESAY_MARKER)
      ? text.slice(CHLOESAY_MARKER.length) : null;
    if (run.freshBrain) text = contextPrefix(channel, input.text) + text;
    convCtx.set(channel, { turnId: input.turnId }); // PBI-003: delegate がどの turn 起点かを読む(伝言相関)
    try {
    const onFirstToken = (): void => { if (run.isCurrent() && input.turnId) metric('brain_first_token', { turnId: input.turnId, path: 'room' }); };
    const ask = hang ? new Promise<string>(() => {})
      : say !== null ? echoAsChloe(say, speakStreamed(channel, input.turnId, run), onFirstToken)
      : run.brain.ask(
        text,
        speakStreamed(channel, input.turnId, run),
        onFirstToken,
      );
    if ((await Promise.race([ask, timeoutMarker(ASK_GUARD_MS)])) !== TIMEOUT || !run.isCurrent()) return;
    console.error(`クロエ(${channel})の応答が ${ASK_GUARD_MS / 1000}s 超過 → interrupt`);
    if (!run.detach()) return;
    if (input.turnId) metric('turn_cancelled', { turnId: input.turnId, path: 'room', reason: 'brain_timeout' });
    store.append({ type: 'system', from: 'room', text: 'クロエの接続を作り直したよ。少し前の話は忘れちゃったかも', channel });
    store.append({ type: 'agent_speech', from: chloePid!, name: chloe.assignedName, text: 'ごめん、ちょっと固まってた。もう一回言ってくれる?', audio: null, turnId: input.turnId, channel });
    } finally {
      // 後続 turn が既に上書きしていたら消さない(LatestChannel は旧 askOnce の完走を待たない)
      if (convCtx.get(channel)?.turnId === input.turnId) convCtx.delete(channel);
    }
  }

  store.onAppend((ev) => {
    if (ev.type !== 'user_speech') return;
    const channel = ev.channel ?? 'work';
    const targeted = ev.targets?.includes(chloePid!) === true;
    const cs = channelState.get(channel);
    if (!targeted && !cs) return;
    if (targeted && ev.turnId) turn.markDeliveredInProcess(ev.turnId); // in-process = 即配送
    (cs ?? chan(channel)).receive(
      speech.revision(channel),
      targeted ? { text: ev.text ?? '', turnId: ev.turnId, files: ev.files } : undefined,
    );
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
  chan(activeChannel).start({
    text: greeting,
    onDone: () => console.error(`クロエ(${activeChannel}) warmup 完了`),
  });
}

if (process.env.NO_CHLOE !== '1') startChloe();

// ---- token(room.json 書込み。atomic 化・単一性は 3A-1b)----
const stateDir = join(homedir(), '.talkingclaw');
// PBI-018: 前回の token を使い回す。毎回作り直すと、**サーバを直して再起動するたびに
// 開いているタブが無効**になり「繋がらない」が起きる(0600 の room.json にどのみち置いてある)。
// 変えたい時は CLAW_NEW_TOKEN=1 で起動する
const token = (() => {
  if (process.env.CLAW_NEW_TOKEN !== '1') {
    try {
      const prev = JSON.parse(readFileSync(join(stateDir, 'room.json'), 'utf8')) as { token?: unknown };
      if (typeof prev.token === 'string' && /^[0-9a-f]{48}$/.test(prev.token)) {
        console.log('token: 前回のものを使う(変えたい時は CLAW_NEW_TOKEN=1)');
        return prev.token;
      }
    } catch { /* 初回・壊れている → 作り直す */ }
  }
  console.log('token: 新しく作った');
  return randomBytes(24).toString('hex');
})();
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

function beginTurnMetrics(turnId: string, path: 'room' | 'memo'): void {
  turnMetricClock.begin(turnId, path);
}

// 6A: 計測(S10)。turn 系はサーバの turn_created を 0ms とする単調時計へ正規化する。
function metric(kind: string, extra: Record<string, unknown> = {}, occurredAt = Date.now()): void {
  try {
    const turnId = typeof extra.turnId === 'string' ? extra.turnId : undefined;
    const timing = TURN_METRICS.has(kind) && turnId ? turnMetricClock.event(turnId, kind, occurredAt) : null;
    let normalized = extra;
    if (timing) normalized = { ...extra, path: extra.path === 'memo' ? 'memo' : timing.path, ms: timing.ms };
    // PBI-007 AC-10: どの合成で作った音かは別軸(tts)で記録する。path は入力経路の軸なので流用しない
    if (kind === 'tts_ready') normalized = { ...normalized, tts: voice.lastUsed ?? config.tts.provider };
    appendFileSync(join(stateDir, 'metrics.jsonl'), JSON.stringify({ at: new Date(occurredAt).toISOString(), kind, ...normalized }) + '\n', { mode: 0o600 });
  } catch { /* 計測は本流を止めない */ }
}
const seenSpeakSeqs = new Map<string, Set<string>>(); // S2: speak 冪等(participant 毎)

function tokenOf(req: IncomingMessage, url: URL): string {
  if (req.method === 'GET') return String(url.searchParams.get('token') ?? '');
  return String(req.headers['x-room-token'] ?? '');
}

function authed(req: IncomingMessage, url: URL): boolean {
  return tokenOf(req, url) === token;
}

// PBI-035: 誰として来たか。**ホスト = 全部 / ゲスト = 遊ぶ・話す・見るだけ / それ以外 = 401**。
// ゲストの一覧はファイルが正で、取り消しは次の要求から効く（プロセスに状態を溜めない）
let guestFile = loadGuests();
function guestOf(req: IncomingMessage, url: URL): Guest | null {
  const t = tokenOf(req, url);
  if (!t || t === token) return null;
  return findGuest(guestFile, t);
}

// S9: Host = port 除去後の完全一致(欠如は deny — DNS rebinding 対策)。
// Origin は存在時のみ自 origin 一致(curl / proxy の欠如は許可 — cross-site fetch 対策)。
function originOk(req: IncomingMessage): boolean {
  // PBI-036: LAN に出した時は**この機械の住所**も通す。それ以外の Host は今までどおり拒否
  // （欠如も拒否）。許す先を増やしても「列挙一致」という形は変えない
  return hostAllowed(req.headers.host, ALLOWED_HOSTS) && originAllowed(req.headers.origin, ALLOWED_HOSTS, PORT);
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

const server = createServer((req, res) => {
  // PBI-041: **1 つの要求の失敗で部屋を殺さない**。async ハンドラの投げは Node では
  // uncaught rejection = プロセス終了になる。実際に「卓に着いていない人が /game を見た」だけで
  // 部屋が落ちた。ここで受け止めて 500 を返し、会話と卓は生かす
  void handleRequest(req, res).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`要求の処理で落ちた(部屋は続行): ${req.method} ${req.url} — ${msg}`);
    try { if (!res.headersSent) json(res, 500, { error: '部屋の中で失敗した(部屋は動いています)' }); else res.end(); } catch { /* 返せないなら諦める */ }
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // PBI-003(AC-3/AC-8): 伝言は token gate より前に memo handler だけが処理し、origin 規則も
  // memo 限定(localhost または MEMO_PUBLIC_ORIGIN の exact Host/Origin)。部屋 UI の規則は下の originOk のまま
  if (path === '/memo' || path.startsWith('/memo/')) {
    if (!memoOriginOk(req)) return json(res, 403, { error: 'Host/Origin が不正です' });
    if (await memoHandler.handle(req, res, path, url.searchParams)) return;
    return json(res, 404, { error: 'not found' });
  }

  if (!originOk(req)) return json(res, 403, { error: 'Host/Origin が不正です' });

  // favicon はブラウザが token 無しで取りに来る。401 を返すと**画面の console が毎回赤くなり**、
  // 本物のエラーが埋もれる（PBI-040 でゲストの画面を測っていて見つけた）
  if (req.method === 'GET' && path === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'max-age=86400' });
    return res.end();
  }
  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, { app: 'talkingclaw-room', version: '0.1.0', bootId: store.bootId, port: PORT });
  }
  if (req.method === 'GET' && path === '/') {
    // S8/S9: token 配布の唯一の経路 = このページへの埋め込み(no-store)
    const raw = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
    // PBI-022: CSP は inline script を禁じているので、import map の中身の sha256 を
    // **配る時に計算して** script-src に足す。map を書き換えてもハッシュが自動で追随する
    // (手で書いた固定ハッシュは、次に誰かが map を直した瞬間に静かに壊れる)。
    // ハッシュの対象は script 要素の **テキスト内容そのまま**(前後の改行も含む)。
    // 改行を落として計算すると、値は出るのに CSP は一致せず、原因が分かりにくい形で弾かれる
    const mapBody = raw.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '';
    const mapHash = `sha256-${createHash('sha256').update(mapBody, 'utf8').digest('base64')}`;
    const html = raw
      // PBI-040(重大): **その人の token を返す**。ここでホストの token を焼き込むと、
      // ゲストの画面が「ホストとして」全部の口を叩けてしまい、PBI-035 の鍵の分離が丸ごと無効になる
      .replace('__ROOM_TOKEN__', guestOf(req, url)?.token ?? token)
      .replace('__ROOM_ROLE__', guestOf(req, url) ? 'guest' : 'host')
      .replace('__BOOT_ID__', store.bootId)
      .replace('__IMPORTMAP_HASH__', mapHash);
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

  // ---- PBI-022: キャラ(VRM)----------------------------------------------
  // avatar.js と vendor(three / three-vrm)は room.js と同じく token gate の手前。
  // 中身は第三者の公開ライブラリと自作の描画コードで、部屋の秘密を持たない。
  if (req.method === 'GET' && path === '/avatar.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(await readFile(fileURLToPath(new URL('../public/avatar.js', import.meta.url))));
  }
  // node_modules の ESM をそのまま配る(bundler を入れない代わり。import map が指す先)。
  // **許可した package の .js だけ**。`..` は URL 正規化で既に潰れているが、念のため弾く
  if (req.method === 'GET' && path.startsWith('/vendor/')) {
    const rel = path.slice('/vendor/'.length);
    const allowed = ['three/', '@pixiv/three-vrm/', '@pixiv/three-vrm-animation/'].some((p) => rel.startsWith(p));
    if (!allowed || rel.includes('..') || !rel.endsWith('.js')) return json(res, 404, { error: 'not found' });
    try {
      const buf = await readFile(fileURLToPath(new URL(`../node_modules/${rel}`, import.meta.url)));
      // 版で中身が変わらない前提の第三者ライブラリなので、ここだけキャッシュを効かせる
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: 'vendor が見つかりません(npm install を実行したか確認してください)' });
    }
  }

  if (req.method === 'GET' && path === '/room.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(await readFile(fileURLToPath(new URL('../public/room.js', import.meta.url))));
  }
  // PBI-035: ホスト token でなければゲストとして見る。ゲストは allowlist の口だけ
  const guest = authed(req, url) ? null : guestOf(req, url);
  if (!guest && !authed(req, url)) return json(res, 401, { error: 'token が必要です' });
  if (guest && !guestAllows(req.method ?? 'GET', path)) {
    metric('guest_denied', { path });   // 何を断ったかは残す(招いた人が後から見られる)
    return json(res, 403, { error: 'ゲストはこの操作をできません' });
  }

  // PBI-008: 声の操作は部屋の所有者だけが行う = originOk と token gate の**後ろ**に置く
  // (伝言 /memo が gate の前だったのとは逆。伝言は外から届く、声は部屋の持ち主の設定)。
  // 本文の読み取りは voiceswitch 側が自分でやる(下の readJson 共通経路には載せない)
  if (path.startsWith('/voice/')) {
    // PBI-029: 役ごとの振り分け。**試聴だけは常に本体**(課金の門を 1 つに保つ)
    const roleSwitch = url.searchParams.get('role') === 'narrator' && path !== '/voice/api/preview'
      ? narratorSwitch : voiceSwitch;
    if (await roleSwitch.handle(req, res, path, url.searchParams)) return;
    return json(res, 404, { error: 'not found' });
  }

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', bootId: store.bootId, lastId: store.lastId })}\n\n`);
    const after = Number(url.searchParams.get('after') ?? 0);
    // PBI-035: ゲストには**招いた部屋のイベントだけ**。ホストの作業部屋の会話は 1 行も出さない
    const visible = (ev: RoomEvent): boolean => !guest || (ev.channel ?? 'work') === guest.channel;
    for (const ev of store.since(after)) if (visible(ev)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const unsubscribe = store.onAppend((ev) => { if (visible(ev)) res.write(`data: ${JSON.stringify(ev)}\n\n`); });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000); // S1: SSE heartbeat
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
    return;
  }

  if (req.method === 'GET' && path === '/channels') {
    return json(res, 200, { active: activeChannel, rooms: rooms.map((r) => ({ channel: r.id, label: r.label })) });
  }

  if (req.method === 'GET' && path === '/participants') {
    return json(res, 200, {
      selected: turn.selected,
      userSpeaking: mic.active,
      channel: guest ? guest.channel : activeChannel,
      // PBI-040: 画面が「自分は誰か」を知るための 2 つ。**押せない物を見せない**ために使う
      role: guest ? 'guest' : 'host',
      yourName: guest ? guest.name : 'あなた',
      yourChannel: guest ? guest.channel : activeChannel,
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

  // ---- GET の口はこのゲートより **前** に置くこと ----------------------------
  // 下の `req.method !== 'POST'` で 404 になるため、後ろに書くと GET が届かない。
  // (2026-08-15: /persona と /avatars をここより後ろに書いてしまい、両方 404 だった)
  if (req.method === 'GET' && path === '/persona') {
    // PBI-021: 相棒の現在の 9 軸。token 必須(他の口と同じ)。読み取りのみ
    return json(res, 200, personaSummary());
  }
  // PBI-024: 覚えた語と、まだ聞いていない候補
  if (req.method === 'GET' && path === '/vocab') {
    return json(res, 200, { known: currentVocab().known, candidates: pendingWords() });
  }
  // PBI-025: 置いてある動き(.vrma)。無ければ空配列 = ボタンを出さない
  if (req.method === 'GET' && path === '/motions') {
    return json(res, 200, { motions: listMotions() });
  }
  if (req.method === 'GET' && path.startsWith('/motions/')) {
    const name = decodeURIComponent(path.slice('/motions/'.length));
    // **名前の形ではなく、実際に在る名前と一致するかで通す**(列挙 allowlist)。
    // 正規表現で ASCII に絞ると「コハク.vrma」のような日本語名が黙って 404 になる(PBI-032 で踏んだ)。
    // readdir の結果と完全一致でしか通らないので、`..` もパス区切りも入り込めない
    if (name.includes('/') || name.includes('\\') || !listMotions().includes(name)) return json(res, 404, { error: 'not found' });
    try {
      const buf = await readFile(join(homedir(), '.talkingclaw', 'motions', name));
      res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }
  // PBI-022: 置いてあるアバター(~/.talkingclaw/avatars/*.vrm)。無ければ空配列 = キャラ枠を出さない
  if (req.method === 'GET' && path === '/avatars') {
    return json(res, 200, { avatars: listAvatars() });
  }
  if (req.method === 'GET' && path.startsWith('/avatars/')) {
    const name = decodeURIComponent(path.slice('/avatars/'.length));
    // 同上: 名前の形ではなく**実在する名前との一致**で通す(日本語のファイル名 = agent 名を許す)
    if (name.includes('/') || name.includes('\\') || !listAvatars().includes(name)) return json(res, 404, { error: 'not found' });
    try {
      const buf = await readFile(join(homedir(), '.talkingclaw', 'avatars', name));
      res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });


  // PBI-017: 落とされたフォルダの中身を 1 ファイルずつ受ける。置き場は workspace 直下の
  // <名前>/ で、相対パスをそのまま作る。受付は intakeStart で開いてあるものだけ
  if (path === '/intake') {
    const name = String(url.searchParams.get('name') ?? '');
    const take = intakes.get(name);
    if (!take) return json(res, 409, { error: '受付が開いていないよ(先に intakeStart)' });
    // 相対パスは信用しない —— .. や絶対パスで置き場の外に書かせない(ここは信頼境界)
    const parts = String(url.searchParams.get('rel') ?? '').split('/').filter((s) => s && s !== '.' && s !== '..');
    if (parts.length === 0) return json(res, 400, { error: 'ファイルの位置が要る' });
    const dest = join(take.dir, ...parts);
    if (!dest.startsWith(take.dir + '/')) return json(res, 400, { error: '置き場の外には書けない' });
    // 申告より多く送られても止める(intakeStart の上限は申告値にしか効かない)
    if (take.wrote >= take.files) return json(res, 413, { error: `申告(${take.files} 件)より多いよ` });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > UPLOAD_MAX || take.bytesWrote + size > INTAKE_MAX_BYTES) { tooBig = true; break; }
      chunks.push(chunk as Buffer);
    }
    // 413 は**読み切ってから**返す。途中で socket を壊すと fetch 自体が失敗し、
    // 画面には理由でなく「Failed to fetch」が出る
    if (tooBig) { req.resume(); return json(res, 413, { error: '大きすぎるよ(1 ファイル 20MB / 全体 200MB まで)' }); }
    try {
      // 同期で書くと、その間ユーザーの声が止まる(browse と同じ理由)
      await mkdirP(pathMod.dirname(dest), { recursive: true, mode: 0o700 });
      await writeFileP(dest, Buffer.concat(chunks), { mode: 0o600 });
    } catch (e) {
      return json(res, 500, { error: `${parts.join('/')} を置けなかった: ${(e as Error).message}` });
    }
    take.wrote += 1;
    take.bytesWrote += size;
    return json(res, 200, { ok: true, wrote: take.wrote });
  }

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
  // PBI-024: 候補を覚える / 断る。**人が決める**(適合率は人が担保する)
  if (path === '/vocab') {
    const word = String((body as { word?: unknown }).word ?? '').trim();
    const action = String((body as { action?: unknown }).action ?? '');
    if (!word) return json(res, 400, { error: '語が空です' });
    if (action !== 'remember' && action !== 'ignore') return json(res, 400, { error: 'action は remember か ignore' });
    const v = vocabDecide(word, action);
    return json(res, 200, { ok: true, known: v.known, candidates: pendingWords() });
  }

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
    // PBI-037: **見る人ごとの盤面**。ゲストは自分の部屋の卓を、自分の手牌で見る
    const ch = guest ? (guest.channel as Channel) : activeChannel;
    return json(res, 200, casino.view(gameSessions.get(ch) ?? null, guest ? guest.id : 'you'));
  }

  if (path === '/chat') {
    const text = String(body.text ?? '').trim();
    if (!text || text.length > TEXT_MAX) return json(res, 400, { error: `text が空か ${TEXT_MAX} 字超です` });
    // PBI-035 / D-019: **ゲストの発話でホストの推論を使わない**。部屋には出るし卓は動くが、
    // agent は起こさない(targets 空 = Brain へ行かない)。連れてきた agent が答えるのは W5
    if (guest) {
      const gameEvent = tryGame(text, { actor: guest.id, channel: guest.channel as Channel });
      if (gameEvent !== null) return json(res, 200, { ok: true, eventId: gameEvent, game: true });
      const ev = store.append({
        type: 'user_speech', from: 'guest', name: guest.name, text, targets: [],
        routing: { method: 'default' }, channel: guest.channel as Channel,
      });
      return json(res, 200, { ok: true, eventId: ev.id, guest: true });
    }
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

  // PBI-011: 作業先プロジェクトの一覧・追加・登録解除。projects.json の手書きを廃止する。
  // token gate の内側なので伝言公開経路(/memo)からは見えない
  if (path === '/projects') {
    const action = String(body.action ?? 'list');
    const projects = loadProjects();
    if (action === 'add') {
      const name = String(body.name ?? '').trim();
      const raw = String(body.path ?? '').trim();
      if (!PROJECT_NAME.test(name)) return json(res, 400, { error: '名前は英数字で始めて、英数字と . - _ で 40 文字までにしてね' });
      if (projects[name]) return json(res, 409, { error: `「${name}」はもう登録されているよ` });
      const dir = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
      if (!isAbsolute(dir)) return json(res, 400, { error: '絶対パスで指定してね(例: /Users/you/myapp か ~/myapp)' });
      let st;
      try { st = statSync(dir); } catch { return json(res, 400, { error: 'そのパスは見つからないよ' }); }
      if (!st.isDirectory()) return json(res, 400, { error: 'フォルダではないみたい(ファイルは登録できないよ)' });
      saveProjects({ ...projects, [name]: dir });
      // PBI-015/017: どの入口から入ったか。drop は「落として、コピーせずその場を登録した」道
      const via = ['browse', 'drop', 'path', 'cli'].includes(String(body.via)) ? String(body.via) : 'path';
      metric('project_add', { via });
      if (via === 'drop') metric('project_intake', { mode: 'path', files: 0, bytes: 0, skipped: 0 });
      return json(res, 200, { ok: true, projects: loadProjects() });
    }
    // PBI-017: フォルダを落として持ち込む。中身は /intake で 1 ファイルずつ受け、ここで開閉する
    if (action === 'intakeStart') {
      const name = String(body.name ?? '').trim();
      const files = Number(body.files ?? 0);
      const bytes = Number(body.bytes ?? 0);
      if (!PROJECT_NAME.test(name)) return json(res, 400, { error: '名前は英数字で始めて、英数字と . - _ で 40 文字までにしてね' });
      if (projects[name]) return json(res, 409, { error: `「${name}」はもう登録されているよ` });
      if (files < 1) return json(res, 400, { error: '中身が 1 つも無いみたい(空のフォルダは置けないよ)' });
      // 送り始める前に断る(AC-5)。何が超えたかを言う
      if (files > INTAKE_MAX_FILES) return json(res, 413, { error: `ファイルが多すぎるよ(${files} 個。${INTAKE_MAX_FILES} 個まで)。大きいものは terminal で: そのフォルダに cd して npm run cli → /project add(コピーしないので規模は関係ないよ)` });
      if (bytes > INTAKE_MAX_BYTES) return json(res, 413, { error: `大きすぎるよ(${Math.round(bytes / 1e6)}MB。${Math.round(INTAKE_MAX_BYTES / 1e6)}MB まで)。大きいものは terminal で: そのフォルダに cd して npm run cli → /project add(コピーしないので規模は関係ないよ)` });
      const dir = join(config.agent.cwd, name);
      // 前回の取り込みが途中で切れた跡(空のまま登録もされていない置き場)なら、やり直させる。
      // ここを一律に断ると「端末で rm -rf」しか手が無くなり、この機能の意味が消える
      const leftover = existsSync(dir) && !projects[name] && readdirSync(dir).length === 0;
      if (existsSync(dir) && !leftover) return json(res, 409, { error: `${dir} はもう在るよ(消したり上書きはしないから、要らないなら自分で消してね)` });
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
        return json(res, 500, { error: `置き場を作れなかった: ${(e as Error).message}` });
      }
      intakes.set(name, { dir, files, bytes, wrote: 0, bytesWrote: 0, at: Date.now() });
      return json(res, 200, { ok: true, dir, resumed: leftover });
    }
    if (action === 'intakeDone') {
      const name = String(body.name ?? '');
      const take = intakes.get(name);
      if (!take) return json(res, 409, { error: '受付が開いていないよ' });
      intakes.delete(name);
      metric('project_intake', { mode: 'upload', files: take.wrote, bytes: take.bytesWrote, skipped: Number(body.skipped ?? 0) });
      if (take.wrote === 0) {
        // 1 つも置けていないなら登録しない。**自分が作った空の置き場は自分で片付ける** ——
        // 残すと次の取り込みが 409 で詰まる(中身があるものには触らない)
        try { if (readdirSync(take.dir).length === 0) rmdirSync(take.dir); } catch { /* 消せなくても続ける */ }
        return json(res, 500, { error: `${take.dir} に 1 つも置けなかった` });
      }
      try { saveProjects({ ...loadProjects(), [name]: take.dir }); } catch (e) {
        return json(res, 500, { error: `置いたけど登録だけ失敗した(${take.dir}): ${(e as Error).message}`, dir: take.dir });
      }
      return json(res, 200, { ok: true, name, dir: take.dir, wrote: take.wrote, projects: loadProjects() });
    }
    // PBI-016: 画面から GitHub にログインする(端末で gh auth login を打たせない)
    if (action === 'auth' || action === 'authPoll' || action === 'authCancel') {
      const bin = await ghPath();
      if (!bin) return json(res, 400, { error: 'gh コマンドが見つからないよ(brew install gh で入れてから、もう一度)' });
      if (action === 'authCancel') {
        if (ghAuth && !ghAuth.done) { try { ghAuth.child.kill('SIGTERM'); } catch { /* もう居ない */ } }
        metric('gh_auth', { phase: 'cancel' });
        ghAuth = null;
        return json(res, 200, { ok: true });
      }
      if (action === 'authPoll') {
        if (!ghAuth) return json(res, 200, { waiting: false, authed: await ghAuthed(bin) });
        if (!ghAuth.done) return json(res, 200, { waiting: true, code: ghAuth.code, url: ghAuth.url });
        const { ok, why } = ghAuth.done;
        ghAuth = null;
        metric('gh_auth', { phase: ok ? 'done' : 'failed' });
        // 誰として入れたかは画面に出す(ここで初めて API を 1 回だけ叩く)
        const who = ok ? await execFileAsync(bin, ['api', 'user', '--jq', '.login'], { timeout: 15_000 }).then((r) => r.stdout.trim()).catch(() => '') : '';
        return json(res, 200, { waiting: false, authed: ok, user: who, error: ok ? undefined : why });
      }
      // 二重に起こさない。まだ合言葉が出ていないなら「待っている」と答える(空の合言葉を渡さない)
      if (ghAuth && !ghAuth.done) {
        return ghAuth.code ? json(res, 200, { code: ghAuth.code, url: ghAuth.url }) : json(res, 200, { waiting: true, url: ghAuth.url });
      }
      metric('gh_auth', { phase: 'start' });
      const st = await ghAuthStart(bin);
      if (!st.code) {
        const why = st.done?.why || 'gh がコードを出さなかった';
        // 合言葉が出ないまま諦める時は、待っている gh を必ず道連れにする ——
        // ここで手を離すと二度と掴めず、15 分後に勝手に認証が通る(利用者には「失敗」と伝えた後で)
        if (!st.done) { try { st.child.kill('SIGTERM'); } catch { /* もう居ない */ } }
        ghAuth = null;
        return json(res, 502, { error: why });
      }
      return json(res, 200, { code: st.code, url: st.url });
    }
    // PBI-015: 認証済みの gh から自分の repo を一覧する(URL を手で打たせないための材料)
    if (action === 'repos') {
      const bin = await ghPath();
      if (!bin) return json(res, 400, { error: 'gh コマンドが見つからないよ(brew install gh で入れてから、もう一度)' });
      try {
        const { stdout } = await execFileAsync(bin, ['repo', 'list', '--limit', String(REPO_LIST_LIMIT), '--json', 'nameWithOwner,isPrivate,updatedAt'], { timeout: 30_000 });
        const repos = (JSON.parse(stdout) as { nameWithOwner: string; isPrivate: boolean; updatedAt: string }[])
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return json(res, 200, { repos, limit: REPO_LIST_LIMIT });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        // gh の言い分をそのまま(未認証なら「gh auth login して」がここに入る)
        return json(res, 502, { error: String(err.stderr ?? '').trim() || err.message || 'repo 一覧を取れなかった' });
      }
    }
    // PBI-015: ローカルのフォルダを辿る(絶対パスを手で打たせないための材料)。読むだけ・隠しフォルダは出さない。
    // ここは会話と同じ event loop の上なので、同期で舐めない —— node_modules や Caches のような
    // 万単位のフォルダで readdirSync + existsSync を回すと、その間ユーザーの声が止まる
    if (action === 'browse') {
      const raw = String(body.path ?? '').trim();
      const at = pathMod.resolve(raw === '' ? homedir() : raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw);
      const isDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory()).catch(() => false);
      let all;
      try { all = await readdir(at, { withFileTypes: true }); } catch (e) {
        return json(res, 400, { error: `${at} は開けなかった: ${(e as Error).message}` });
      }
      // symlink も候補に入れる(外付けや dotfiles 運用でフォルダが symlink のことがある)。実体の確認は stat で
      const cands = all.filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink()));
      const shown = cands.slice(0, BROWSE_LIMIT);
      const entries = (await Promise.all(shown.map(async (d) => {
        const p = join(at, d.name);
        return (await isDir(p)) ? { name: d.name, path: p, git: await isDir(join(p, '.git')) } : null;
      }))).filter((e) => e !== null).sort((a, b) => a.name.localeCompare(b.name));
      const up = pathMod.dirname(at);
      // more = 打ち止めで出していない数(黙って切らない)
      return json(res, 200, { at, up: up === at ? null : up, git: await isDir(join(at, '.git')), entries, home: homedir(), more: cands.length - shown.length });
    }
    // PBI-012: URL 1 本で clone → 登録まで。clone が成功して初めて登録する
    if (action === 'clone') {
      const m = GH_URL.exec(String(body.url ?? '').trim());
      if (!m) return json(res, 400, { error: 'https://github.com/owner/repo の形で入れてね' });
      const [, owner, repo] = m;
      if (!PROJECT_NAME.test(repo)) return json(res, 400, { error: `「${repo}」は登録名にできないよ(英数字で始まり、英数字と . - _ で 40 文字まで)` });
      if (projects[repo]) return json(res, 409, { error: `「${repo}」はもう登録されているよ` });
      const bin = await ghPath();
      if (!bin) return json(res, 400, { error: 'gh コマンドが見つからないよ(brew install gh で入れてから、もう一度)' });
      const dir = join(config.agent.cwd, repo);
      // AC-3: 既に在るものには触らない。上書きも削除もせず、clone する前に止める
      if (existsSync(dir)) return json(res, 409, { error: `${dir} はもう在るよ(消したり上書きはしないから、要らないなら自分で消してね)` });
      if (cloning.has(dir)) return json(res, 409, { error: `${repo} は今 clone 中だよ(終わるまで待ってね)` });
      cloning.add(dir);
      const t0 = Date.now();
      try {
        mkdirSync(config.agent.cwd, { recursive: true });
        await ghClone(bin, `${owner}/${repo}`, dir);
      } catch (e) {
        const err = e as { stderr?: string; message?: string; killed?: boolean };
        metric('project_clone', { repo: `${owner}/${repo}`, ok: false, ms: Date.now() - t0, via: ['list','cli'].includes(String(body.via)) ? String(body.via) : 'url' });
        // AC-4: gh の言い分をそのまま見せる(こちらで丸めると原因が消える)。projects.json は触っていない
        const why = String(err.stderr ?? '').trim() || err.message || 'clone に失敗した';
        return json(res, 502, {
          error: err.killed
            ? `clone が長すぎたので打ち切ったよ(${Math.round(CLONE_TIMEOUT_MS / 60_000)} 分)。${dir} に途中まで残っているかもしれないから、要らなければ消してね`
            : why,
        });
      } finally {
        cloning.delete(dir);
      }
      metric('project_clone', { repo: `${owner}/${repo}`, ok: true, ms: Date.now() - t0, via: ['list','cli'].includes(String(body.via)) ? String(body.via) : 'url' });
      // 待っている間に別の追加・登録解除が入っているので、handler 入口の写しではなく今の中身に足す
      try { saveProjects({ ...loadProjects(), [repo]: dir }); } catch (e) {
        // AC-5: clone したフォルダは消さずに残す。登録だけやり直せると分かる文言で返す
        return json(res, 500, { error: `clone はできた(${dir})けど、登録だけ失敗した: ${(e as Error).message}。上の追加フォームにこのパスを入れれば登録できるよ`, dir });
      }
      return json(res, 200, { ok: true, name: repo, dir, projects: loadProjects() });
    }
    if (action === 'remove') {
      const name = String(body.name ?? '');
      // 登録解除はレジストリから外すだけ — ディスク上のフォルダには触らない
      if (name === 'workspace' || name === 'talkingclaw') return json(res, 400, { error: 'この 2 つは部屋の土台なので外せないよ' });
      if (!projects[name]) return json(res, 404, { error: 'その名前は登録されていないよ' });
      const next = { ...projects };
      delete next[name];
      saveProjects(next);
      return json(res, 200, { ok: true, projects: loadProjects() });
    }
    // home は表示用(UI がパスの HOME 部分を ~ に縮める。切り詰めは geometry 契約違反)。
    // gh / workspace は clone フォームのため(gh が無い環境ではフォームごと使えないと伝える)
    const ghBin = await ghPath();
    return json(res, 200, {
      projects, home: homedir(), gh: ghBin !== null, workspace: config.agent.cwd,
      ghAuthed: ghBin ? await ghAuthed(ghBin) : false, // PBI-016: 未認証なら画面から連携できると出す
    });
  }

  // PBI-014: 画面から艦隊を見る・立てる・指示を渡す。声のツールと同じ fleetAct を通るので、
  // 台帳の縛り(部屋が立てた子にしか指示を送らない)は画面側からも外せない
  if (path === '/herdr') {
    const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
    const r = await fleetAct({
      action: String(body.action ?? 'list'),
      target: str(body.target), text: str(body.text), name: str(body.name),
      workspace: str(body.workspace), project: str(body.project),
      lines: body.lines === undefined ? undefined : Number(body.lines),
    });
    return json(res, r.error ? 400 : 200, { fleet: fleetView, note: r.say, ...(r.error ? { error: r.error } : {}) });
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
    // fleet は「最後に見た艦隊」。ここで毎回 herdr を叩くと board の定期更新のたびに CLI が走るので、
    // 取りに行くのは声か画面のボタンが /herdr を叩いた時だけにする
    return json(res, 200, { ...boardSnapshot(), fleet: fleetView });
  }

  if (path === '/plan') {
    // 相談中の案の操作。画面のボタンからも、音声の合図(別機能)からもここに来る
    const action = String(body.action ?? 'get');
    if (action === 'confirm') {
      const r = confirmPlan();
      return r.ok ? json(res, 200, { ok: true, taskId: r.taskId, pbi: r.pbi, note: r.note }) : json(res, 400, { error: r.error });
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
      userSpeaking: mic.active, // ユーザーの現在の発話状態(単一の状態源。UserSpeechState 参照)
      participants: registry.all().map((p) => ({
        participantId: p.participantId,
        name: p.assignedName,
        presence: registry.presence(p, waiters.has(p.participantId)),
        voice: p.voice.status,
      })),
      routing: {
        selected: turn.selected ? (registry.get(turn.selected)?.assignedName ?? turn.selected) : null,
        floor: turn.floor ? (registry.get(turn.floor)?.assignedName ?? turn.floor) : null,
        lastResponder: turn.lastResponder ? (registry.get(turn.lastResponder)?.assignedName ?? turn.lastResponder) : null,
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
    const eventId = Number.isFinite(Number(body.eventId)) ? Number(body.eventId) : undefined;
    const evRef = eventId !== undefined ? store.get(eventId) : undefined;
    const turnId = typeof body.turnId === 'string' ? body.turnId : evRef?.turnId;
    if (!kind || (!TURN_METRICS.has(kind) && !Number.isFinite(ms))) {
      return json(res, 400, { error: 'kind と ms が必要です' });
    }
    const clientAt = Number(body.clientAt);
    const occurredAt = kind === 'stt_final' && Number.isFinite(clientAt) && Math.abs(Date.now() - clientAt) < 60_000
      ? clientAt
      : Date.now();
    metric(kind, {
      ...(Number.isFinite(ms) ? { ms } : {}), eventId, turnId, filler: evRef?.filler,
      path: body.path === 'memo' ? 'memo' : 'room',
    }, occurredAt);
    return json(res, 200, { ok: true });
  }

  if (path === '/select') {
    const pid = body.participantId === null ? null : String(body.participantId ?? '');
    if (pid !== null && !registry.get(pid)) return json(res, 400, { error: '不明な participant です' });
    turn.select(pid);
    store.append({ type: 'system', from: 'room', text: pid ? `話し相手を ${registry.get(pid)!.assignedName} にしたよ` : '話し相手の指定を外したよ' });
    return json(res, 200, { ok: true, selected: turn.selected });
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

  // PBI-035: ゲストを招く / 取り消す / 一覧（**ホストだけ**。allowlist に無いのでゲストは 403）
  if (path === '/guests') {
    const action = String(body.action ?? 'list');
    if (action === 'invite') {
      const out = issueGuest(guestFile, {
        name: String(body.name ?? 'ゲスト'),
        channel: isChannel(body.channel) ? body.channel : activeChannel,
        hours: Number(body.hours ?? 12),
      });
      guestFile = out.file;
      saveGuests(guestFile);
      store.append({ type: 'system', from: 'room', text: `${out.guest.name} を招待したよ（${out.guest.channel} の部屋・${new Date(out.guest.expiresAt).toLocaleString('ja-JP')} まで）` });
      // token を返すのはこの 1 回だけ(一覧には出さない)
      // 招待リンクは**繋がる住所**で作る。LAN に出していなければ 127.0.0.1（嘘をつかない）
      const at = inviteHost(BIND, LAN);
      return json(res, 200, {
        ok: true, guest: { ...out.guest }, url: `http://${at}:${PORT}/?token=${out.guest.token}`,
        lan: BIND === '0.0.0.0', addresses: LAN,
      });
    }
    if (action === 'revoke') {
      guestFile = revokeGuest(guestFile, String(body.id ?? ''));
      saveGuests(guestFile);
      return json(res, 200, { ok: true, guests: guestSummary(guestFile) });
    }
    return json(res, 200, { guests: guestSummary(guestFile) });
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
    if (mic.report(speaking)) setTimeout(() => flushPending(), 250).unref();
    return json(res, 200, { ok: true, userSpeaking: speaking });
  }

  if (path === '/played') {
    // S4/S10: 再生完了通知(floor 集計は 4A で使用)
    const eventId = Number(body.eventId);
    if (!Number.isFinite(eventId)) return json(res, 400, { error: 'eventId が必要です' });
    playedIds.add(eventId);
    const ev = store.get(eventId);
    if (ev && ev.type === 'agent_speech' && !ev.filler && ev.from !== 'room') turn.advanceFloor(ev.from); // S4: 再生完了基準
    if (ev && ev.filler) turn.onFillerPlayed(ev); // 6B: 相対スケジュール前倒し
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
    const resolvedTurn = turn.attribute(p.participantId, body.turnId ? String(body.turnId) : undefined);
    const speakTurnId = resolvedTurn === 'none' ? undefined : resolvedTurn;
    speech.speakSentences(p.participantId, p.assignedName, text, speakTurnId, turn.channelOf(speakTurnId));
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

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, BIND, () => {
  // S8: token 生成物の書出しは bind 成功後のみ + tmp→rename の atomic(敗者は一切触れない)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = join(stateDir, `room.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify({
    port: PORT, token, pid: process.pid, pidStartedAt: Date.now(), bootId: store.bootId,
  }), { mode: 0o600 });
  renameSync(tmp, join(stateDir, 'room.json'));
  console.error(`talkingclaw room: http://127.0.0.1:${PORT}(bootId ${store.bootId.slice(0, 8)})`);
  // PBI-036: **どこまで出しているかを起動時に必ず言う**（黙って LAN に出ている状態を作らない）
  if (BIND === '0.0.0.0') {
    console.error(`警告: この部屋は LAN に出ています — ${LAN.map((a) => `http://${a}:${PORT}/`).join(' / ') || '(住所を取得できませんでした)'}`);
    console.error('  招待した人だけが入れます(ゲストの鍵)。公共の Wi-Fi では ROOM_BIND を外してください');
  }
  // 裁定 21:24 縛り 5: 検査用の口が開いていることを起動時に必ず 1 行出す(hooks 家族まとめて)。
  // 本番の LaunchDaemon plist には ROOM_TEST_HOOKS を置かないこと(PBI-003 設置作業への申し送り)
  if (process.env.ROOM_TEST_HOOKS === '1') {
    console.error('警告: ROOM_TEST_HOOKS=1 — 検査用の口(__askperm__ / __memocrash__ / __hang__ / __chloesay__)が開いています。本番では外してください');
  }
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
    // 認証待ちの gh を道連れにする(部屋が居ないのに device flow だけ回り続けるのを防ぐ)
    if (ghAuth && !ghAuth.done) { try { ghAuth.child.kill('SIGTERM'); } catch { /* もう居ない */ } }
    process.exit(0);
  });
}
