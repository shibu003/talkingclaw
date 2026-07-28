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
    if (live && typeof ev.audio === 'string') enqueueAudio(ev.audio);
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
  /tasks           作業ボード(誰が何をどこまで)
  /who             在室者
  /settings        設定表示  (/settings chatModel haiku のように変更も)
  /room chat|work  部屋を切り替え(雑談 / 作業)
  /log [n]         直近の会話ログ
  /mute            再生中の音を止める
  /quit            終了(部屋は動き続ける)
それ以外の入力はそのまま部屋への発言になります。`;

async function main(): Promise<void> {
  await ensureRoom();
  console.log(c.bold(`\n声の部屋 (terminal)  ${c.dim(`bootId ${room!.bootId.slice(0, 8)} / port ${room!.port}`)}`));
  console.log(c.dim('喋って話したい時はブラウザ http://localhost:' + room!.port + ' を開いてね(音声認識はブラウザ専用)'));
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

  stopAudio();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  console.log(c.dim('\n部屋はそのまま動いてるよ。またね'));
  process.exit(0);
}

await main();
