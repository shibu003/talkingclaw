// 声の部屋の terminal クライアント。ブラウザを開かずに「打ち込む・聞く・見る」ができる。
// 音声入力(STT)だけはブラウザ専用(Web Speech API)なので、喋りたい時はブラウザを使う。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const STATE_DIR = join(homedir(), '.talkingclaw');
const ROOM_PATH = fileURLToPath(new URL('./room.ts', import.meta.url));
const PORT = Number(process.env.PORT ?? 3300);
const MUTE = process.env.CLI_MUTE === '1'; // 音を出したくない時

type Room = { port: number; token: string; bootId: string };
let room: Room | null = null;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  you: (s: string) => `\x1b[36m${s}\x1b[0m`,
  agent: (s: string) => `\x1b[35m${s}\x1b[0m`,
  sys: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function readRoomJson(): Room | null {
  try {
    const d = JSON.parse(readFileSync(join(STATE_DIR, 'room.json'), 'utf8'));
    return typeof d.token === 'string' ? (d as Room) : null;
  } catch {
    return null;
  }
}

async function healthy(port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const h = (await r.json()) as { app?: string; bootId?: string };
    return h.app === 'talkingclaw-room' ? (h.bootId ?? null) : null;
  } catch {
    return null;
  }
}

// mcp.ts と同じ方針: 部屋が無ければ自分で起こす(ログは room.log へ)
async function ensureRoom(): Promise<Room> {
  const rj = readRoomJson();
  if (rj && (await healthy(rj.port))) return (room = rj);
  console.log(c.dim('部屋を起動しています…(初回は音声エンジンの準備に時間がかかります)'));
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const log = openSync(join(STATE_DIR, 'room.log'), 'a');
  spawn(process.execPath, [ROOM_PATH], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, PORT: String(PORT) },
  }).unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const fresh = readRoomJson();
    if (fresh && (await healthy(fresh.port))) return (room = fresh);
  }
  throw new Error('部屋を起動できませんでした。~/.talkingclaw/room.log を確認してください');
}

const api = async (path: string, body: object): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${room!.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': room!.token },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
};

// ---- 再生(Wave 1 と同じ afplay。1 つずつ順番に鳴らす)----
let tmpDir: string | null = null;
let player: ChildProcess | null = null;
let playChain: Promise<void> = Promise.resolve();
let fileSeq = 0;

function enqueueAudio(path: string): void {
  if (MUTE) return;
  playChain = playChain
    .then(async () => {
      const res = await fetch(`http://127.0.0.1:${room!.port}${path}?token=${room!.token}`);
      if (!res.ok) return;
      tmpDir ??= await mkdtemp(join(tmpdir(), 'claw-cli-'));
      const file = join(tmpDir, `${fileSeq++}.wav`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      await new Promise<void>((resolve) => {
        const p = spawn('afplay', [file], { stdio: 'ignore' });
        player = p;
        p.on('close', () => { if (player === p) player = null; resolve(); });
        p.on('error', () => resolve());
      });
    })
    .catch(() => {});
}

function stopAudio(): void {
  playChain = Promise.resolve();
  player?.kill('SIGKILL');
  player = null;
}

// ---- 音声入力(macOS Speech。tools/claw-listen を呼ぶ)----
const LISTEN_BIN = fileURLToPath(new URL('../tools/claw-listen', import.meta.url));
const LISTEN_SRC = fileURLToPath(new URL('../tools/listen.swift', import.meta.url));
let handsfree = false;
let listening = false;
const spokenRecently: { text: string; at: number }[] = []; // エコー棄却用

function norm(t: string): string {
  return t.toLowerCase().replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/[、。!?！?\s]/g, '');
}
function bigrams(t: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
  return s;
}
function similar(a: string, b: string): number { // Dice 係数
  const [x, y] = [bigrams(a), bigrams(b)];
  if (x.size === 0 || y.size === 0) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return (2 * hit) / (x.size + y.size);
}
function isEcho(text: string): boolean {
  const n = norm(text);
  if (n.length < 2) return false;
  const now = Date.now();
  return spokenRecently.some((r) => now - r.at < 15_000 && (r.text.includes(n) || n.includes(r.text) || similar(r.text, n) >= 0.6));
}
function rememberSpoken(text: string): void {
  spokenRecently.push({ text: norm(text), at: Date.now() });
  while (spokenRecently.length > 12) spokenRecently.shift();
}

async function ensureListenBin(): Promise<boolean> {
  const { existsSync } = await import('node:fs');
  if (existsSync(LISTEN_BIN)) return true;
  console.log(c.dim('  音声入力を初めて使うのでビルドします(swiftc、10 秒ほど)…'));
  return new Promise((resolve) => {
    const p = spawn('swiftc', ['-O', LISTEN_SRC, '-o', LISTEN_BIN, '-framework', 'Speech', '-framework', 'AVFoundation'], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

// 1 発話ぶん聞き取る。聞き取れたテキスト or null
function listenOnce(maxSec = 30): Promise<string | null> {
  return new Promise((resolve) => {
    listening = true;
    const p = spawn(LISTEN_BIN, [String(maxSec)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => { listening = false; resolve(code === 0 && out.trim() ? out.trim() : null); });
    p.on('error', () => { listening = false; resolve(null); });
  });
}

// 聞き続けるループ。以前は「再生中は聞かない」で割り込みが構造的に不可能だった。
// いまは claw-listen を --continuous で 1 本だけ起動し、マイクを開いたままにする
// (エコーは Swift 側の setVoiceProcessingEnabled で消す)。
//   PARTIAL = 喋り始めた合図 → その場で読み上げを止める(割り込み)
//   FINAL   = 確定した 1 発話 → 部屋に送る
async function handsfreeLoop(): Promise<void> {
  const p = spawn(LISTEN_BIN, ['--continuous', '600'], { stdio: ['ignore', 'pipe', 'inherit'] });
  listening = true;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !handsfree) continue;

      if (line.startsWith('PARTIAL ')) {
        // 人間が声を出した時点で黙る。確定を待たない — 待つと数十秒喋り続けることになる
        if (player) { stopAudio(); console.log(c.dim('  (割り込み)')); }
        continue;
      }
      if (line.startsWith('FINAL ')) {
        const text = line.slice('FINAL '.length).trim();
        if (!text) continue;
        // エコーキャンセルを抜けてきた自分たちの声への保険
        if (isEcho(text)) { console.log(c.dim(`  (自分たちの声っぽいので無視: ${text.slice(0, 20)})`)); continue; }
        console.log(`${c.you('あなた(声)')} ${text}`);
        stopAudio();
        void api('/chat', { text }).catch(() => ({}));
      }
    }
  });
  p.on('close', () => { listening = false; });
  p.on('error', () => { listening = false; });

  while (handsfree) await new Promise((r) => setTimeout(r, 200));
  p.kill('SIGTERM');
  listening = false;
}

// ---- タイムライン購読(SSE)----
let lastId = 0;
let bootId = '';
let currentChannel = 'work';

function render(ev: Record<string, unknown>, live: boolean): void {
  const type = String(ev.type);
  const text = typeof ev.text === 'string' ? ev.text : '';
  const name = typeof ev.name === 'string' ? ev.name : '';
  const ch = typeof ev.channel === 'string' ? ev.channel : undefined;
  if ((type === 'user_speech' || type === 'agent_speech') && ch && ch !== currentChannel) return;

  if (type === 'user_speech') {
    console.log(`\n${c.you('あなた')} ${text}`);
  } else if (type === 'agent_speech') {
    const tag = ev.filler ? c.dim(`(${name})`) : c.agent(name || '?');
    console.log(`${tag} ${ev.filler ? c.dim(text) : text}`);
    if (live) {
      rememberSpoken(text);
      if (typeof ev.audio === 'string') enqueueAudio(ev.audio);
    }
  } else if (type === 'system' || type === 'presence') {
    console.log(c.sys(`  * ${name ? name + ': ' : ''}${text || type}`));
  }
}

async function subscribe(): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${room!.port}/events?token=${room!.token}&after=${lastId}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let replayBoundary = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const ev = JSON.parse(chunk.slice(6)) as Record<string, unknown>;
      if (ev.type === 'hello') {
        if (bootId && ev.bootId !== bootId) {
          console.log(c.sys('\n  * 部屋が再起動したよ。繋ぎ直すね'));
          lastId = 0;
        }
        bootId = String(ev.bootId);
        replayBoundary = Number(ev.lastId ?? 0);
        continue;
      }
      const id = Number(ev.id ?? 0);
      if (id <= lastId) continue;
      lastId = id;
      render(ev, id > replayBoundary); // 過去ログは音を鳴らさない
    }
  }
}

async function keepSubscribed(): Promise<void> {
  for (;;) {
    try {
      await subscribe();
    } catch { /* 切断 → 張り直す */ }
    await new Promise((r) => setTimeout(r, 1000));
    const fresh = readRoomJson();
    if (fresh && (await healthy(fresh.port))) room = fresh;
  }
}

// ---- コマンド ----
async function showTasks(): Promise<void> {
  const d = (await api('/tasks', {})) as { tasks?: Record<string, unknown>[]; open?: Record<string, unknown>[] };
  const rows = [...(d.tasks ?? []), ...(d.open ?? [])];
  if (rows.length === 0) return console.log(c.dim('  いまは作業なし'));
  const mark: Record<string, string> = { queued: '待機', working: '⚙ 作業中', done: '✔ 完了', failed: '✖ 失敗', interrupted: '⏸ 中断' };
  for (const t of rows.slice(0, 10)) {
    const notes = (t.notes as string[] | undefined) ?? [];
    const arts = (t.artifacts as string[] | undefined) ?? [];
    console.log(`  ${mark[String(t.status)] ?? t.status}  ${t.agentName}: ${String(t.request).slice(0, 50)}`);
    if (notes.length > 0) console.log(c.dim(`      実況: ${notes[notes.length - 1]}`));
    for (const a of arts) console.log(c.dim(`      📦 ${a}  (http://127.0.0.1:${room!.port}/files/${a}?token=…)`));
  }
}

async function showSettings(args: string[]): Promise<void> {
  const body: Record<string, string> = {};
  if (args[0] && args[1]) body[args[0]] = args[1]; // 例: /settings chatModel haiku
  const d = await api('/settings', body);
  console.log(`  作業モデル: ${d.workerModel} / effort: ${d.workerEffort || '既定'}`);
  console.log(`  会話モデル: ${d.chatModel} / effort: ${d.chatEffort || '既定'}`);
  console.log(`  Claude 設定(skills)を使う: ${d.useUserSettings ? 'はい' : 'いいえ'}`);
  console.log(c.dim(`  作業先: ${(d.projects as string[]).join(' / ')} / 外部 MCP: ${(d.externalMcp as string[]).join(', ') || 'なし'}`));
  console.log(c.dim('  変更例: /settings chatModel haiku'));
}

async function showWho(): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${room!.port}/participants?token=${room!.token}`);
  const d = (await res.json()) as { participants: { name: string; presence: string; voice: string }[]; selected: string | null };
  for (const p of d.participants) console.log(`  ${p.name}  ${c.dim(`${p.presence} / 声: ${p.voice}`)}`);
  console.log(c.dim(`  話す相手: ${d.selected ?? 'みんな(自動)'} / 部屋: ${currentChannel}`));
}

const HELP = `${c.bold('コマンド')}
  /inbox           作業係からの報告(read <id> / reply <id> <内容>)
  /tasks           作業ボード(誰が何をどこまで)
  /who             在室者
  /settings        設定表示  (/settings chatModel haiku のように変更も)
  /room chat|work  部屋を切り替え(雑談 / 作業)
  /log [n]         直近の会話ログ
  /v               マイクで 1 回話す(macOS の音声認識)
  /v on | /v off   ハンズフリー(連続で聞き取る / 止める)
  /dict [add 誤 正] 聞き間違いの補正辞書(表示 / 追加)
  /mute            再生中の音を止める
  /quit            終了(部屋は動き続ける)
それ以外の入力はそのまま部屋への発言になります。`;

async function main(): Promise<void> {
  await ensureRoom();
  console.log(c.bold(`\n声の部屋 (terminal)  ${c.dim(`bootId ${room!.bootId.slice(0, 8)} / port ${room!.port}`)}`));
  console.log(c.dim('/v でマイク入力(macOS の音声認識)。ブラウザ http://localhost:' + room!.port + ' も同じ部屋だよ'));
  console.log(c.dim('/help でコマンド一覧\n'));
  void keepSubscribed();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => { stopAudio(); rl.close(); });
  for (;;) {
    let line: string;
    try {
      line = (await rl.question('')).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === '/quit' || line === '/exit') break;
    if (line === '/help') { console.log(HELP); continue; }
    if (line === '/mute') { stopAudio(); console.log(c.dim('  止めたよ')); continue; }
    if (line.startsWith('/dict')) {
      const parts = line.split(/\s+/);
      if (parts[1] === 'add' && parts[2] && parts[3]) {
        const d = await api('/dict', { wrong: parts[2], right: parts[3] });
        console.log(c.dim(`  「${parts[2]}」→「${parts[3]}」を覚えたよ(${Object.keys((d.dictionary as object) ?? {}).length} 語)`));
      } else {
        const d = await api('/dict', {});
        const dict = (d.dictionary ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(dict).slice(0, 30)) console.log(c.dim(`  ${k} → ${v}`));
        console.log(c.dim('  追加: /dict add <誤って聞こえる語> <正しい語>'));
      }
      continue;
    }
    if (line === '/v' || line.startsWith('/v ')) {
      const arg = line.split(/\s+/)[1];
      if (!(await ensureListenBin())) { console.log(c.sys('  音声入力をビルドできませんでした(swiftc が要ります)')); continue; }
      if (arg === 'off') { handsfree = false; console.log(c.dim('  ハンズフリーを止めたよ')); continue; }
      if (arg === 'on') {
        handsfree = true;
        console.log(c.sys('  * ハンズフリー開始(話しかけてね。止める時は /v off + Enter)'));
        void handsfreeLoop();
        continue;
      }
      console.log(c.dim('  聞いてるよ…(話し終わったら自動で送るね)'));
      const text = await listenOnce(30);
      if (!text) { console.log(c.dim('  聞き取れなかった')); continue; }
      if (isEcho(text)) { console.log(c.dim('  (自分たちの声っぽいので無視)')); continue; }
      console.log(`${c.you('あなた(声)')} ${text}`);
      stopAudio();
      await api('/chat', { text }).catch(() => ({}));
      continue;
    }
    if (line === '/inbox' || line === '/報告') {
      const d = await api('/inbox', {}) as { unread?: number; threads?: Record<string, unknown>[] };
      const threads = d.threads ?? [];
      if (threads.length === 0) { console.log(c.dim('  まだ報告はないよ')); continue; }
      console.log(c.dim(`  未読 ${d.unread ?? 0} 件`));
      for (const t of threads.slice(0, 5)) {
        const r = (t.report ?? {}) as Record<string, string[] | string>;
        console.log(`  ${t.unread ? c.bold('●') : ' '} ${c.agent(String(r.headline ?? t.request))}`);
        console.log(c.dim(`     依頼: ${String(t.request).slice(0, 50)}(${String(t.at).slice(11, 16)})`));
        for (const x of (r.can as string[] ?? [])) console.log(`     ・${x}`);
        const check = (r.check as string[] ?? []);
        if (check.length > 0) { console.log(c.sys('     確かめかた:')); for (const x of check) console.log(`       ${x}`); }
        for (const p of (r.touched as string[] ?? [])) console.log(c.dim(`     📦 ${p}`));
      }
      console.log(c.dim('  既読: /inbox read <id> / 返信: /inbox reply <id> <内容>'));
      continue;
    }
    if (line.startsWith('/inbox ')) {
      const [, sub, id, ...rest] = line.split(/\s+/);
      if (sub === 'read') { await api('/inbox/read', { threadId: Number(id) }); console.log(c.dim('  既読にしたよ')); }
      else if (sub === 'reply') { await api('/inbox/reply', { threadId: Number(id), text: rest.join(' ') }); console.log(c.dim('  返信を作業係に渡したよ')); }
      continue;
    }
    if (line === '/tasks') { await showTasks().catch((e) => console.log(c.sys(`  ${e.message}`))); continue; }
    if (line === '/who') { await showWho().catch((e) => console.log(c.sys(`  ${e.message}`))); continue; }
    if (line.startsWith('/settings')) { await showSettings(line.split(/\s+/).slice(1)).catch((e) => console.log(c.sys(`  ${e.message}`))); continue; }
    if (line.startsWith('/room')) {
      const ch = line.split(/\s+/)[1] === 'chat' ? 'chat' : 'work';
      await api('/channel', { channel: ch }).catch(() => ({}));
      currentChannel = ch;
      console.log(c.sys(`  * ${ch === 'chat' ? '雑談部屋' : '作業部屋'} に移動したよ`));
      continue;
    }
    if (line.startsWith('/log')) {
      const n = Number(line.split(/\s+/)[1] ?? 20);
      const d = (await api('/transcript', { lines: Math.min(n || 20, 100) })) as { lines?: { who: string; text: string }[] };
      for (const r of d.lines ?? []) console.log(c.dim(`  ${r.who}: ${r.text}`));
      continue;
    }
    stopAudio(); // 自分が喋ったら古い読み上げは捨てる(ブラウザ側と同じ stale drop)
    const r = await api('/chat', { text: line }).catch((e: Error) => ({ error: e.message }));
    if (r.error) console.log(c.sys(`  送信できなかった: ${r.error}`));
  }

  handsfree = false;
  stopAudio();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  console.log(c.dim('\n部屋はそのまま動いてるよ。またね'));
  process.exit(0);
}

await main();
