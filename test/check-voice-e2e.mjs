// PBI-008「声スイッチャー」の black-box holdout 検査(worker-f)。
// src/room.ts・src/voice.ts・src/convos/*・public/* は **読まずに**、G1(backlog/PBI-008-voice-switcher.md)の
// SBE 表と公開面(HTTP・env・状態ファイル・ブラウザの実測 geometry)だけから書いている。
// 稼働中の部屋(3300)・音声エンジン(10101)には一切触れない。Fish の実 API も叩かない(fake のみ)。
//
// 実行:      node test/check-voice-e2e.mjs
// 部分実行:  ONLY=AC-1,AC-3 node test/check-voice-e2e.mjs
// 遅い検査も:VOICE_HOLDOUT_SLOW=1 node test/check-voice-e2e.mjs   (AC-2 stale = 実時間 5 分待ち)
//
// ---- 負の対照(この検査が armed かを測る)----
// E2E_MUTATE=dead-fish|no-key|other-ref|no-token|dead-engine を付けると **部屋の env を 1 つだけ壊す**。
// 対応する検査が赤くなるのが正しい。どの対照がどれを殺すかの対応表は
// .kaiwa-loop/worker-reports/voice-holdout.md。緑は「まだ壊し方を試していない」以上の意味を持たない。
//
// ---- 判定の種類 ----
// pass    : 測って通った
// FAIL    : 測って落ちた(実装の欠陥、または検査の前提崩れ)
// BLOCKED : **測れなかった**。pass ではない。exit code は非 0 のまま(未測定を緑に混ぜない)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SENTINEL = 'KEY_SENTINEL_008';                       // fake の API キー。実キーは絶対に書かない
const PREVIEW_TEXT = 'こんにちは、クロエだよ。';            // G1 §3: 試聴文は server 固定
const FREE_MODEL = 's2.1-pro-free';
const ENV_REF = 'ref-env-default';                          // PBI-007 の env 既定(FISH_REFERENCE_ID)
const XSS_TITLE = '<img src=x onerror="window.__xss1=1"><script>window.__xss2=1</script>ぶきみボイス';
const LONG_TITLE = 'ながい'.repeat(40);                     // 120 文字
const MUTATE = process.env.E2E_MUTATE ?? '';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SLOW = process.env.VOICE_HOLDOUT_SLOW === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================ 判定の台帳 ============================
const results = [];   // {name, state: 'pass'|'FAIL'|'BLOCKED', detail}
const notes = [];     // 契約への疑問・置換の申告(報告書へそのまま載せる)
let current = null;
function ok(detail = '') { results.push({ name: current, state: 'pass', detail }); console.log(`ok       - ${current}${detail ? ' : ' + detail : ''}`); }
function blocked(why) { results.push({ name: current, state: 'BLOCKED', detail: why }); console.log(`BLOCKED  - ${current} : ${why}`); }
function note(line) { notes.push(line); }

// 1 つ落ちても止めない。止めると「その後ろが armed か」を対照で観測できない
async function step(name, fn) {
  // 'AC-1' が 'AC-10'/'AC-11' まで拾わないよう、AC 指定は先頭 token の完全一致で見る。
  // setup は ONLY 指定に関わらず必ず走らせる(飛ばすと後段が token 無しで動いて意味不明な赤になる)
  const head = name.split(' ')[0];
  if (ONLY.length && !name.startsWith('setup')
      && !ONLY.some((p) => (p.startsWith('AC-') ? head === p : name.startsWith(p)))) return;
  current = name;
  const started = results.length;
  try {
    await fn();
    if (results.length === started) results.push({ name, state: 'pass', detail: '' });
  } catch (err) {
    results.push({ name, state: 'FAIL', detail: err.message });
    console.log(`FAIL     - ${name} : ${err.message}`);
  }
  current = null;
}

// ============================ 道具 ============================
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r({
  base: `http://127.0.0.1:${server.address().port}`,
  close: () => { server.closeAllConnections?.(); server.close(); },
})));

// 前の選択の pool 再構築が in-flight のまま次を測ると、古い reference を「新しい pool」と誤読する。
// 合成が quietMs の間 1 本も来ないところまで待ってから次の操作に入る。
async function waitSynthQuiet(fish, quietMs = 1800, maxMs = 25_000) {
  const t0 = Date.now();
  let last = fish.state.ttsRequests.length, stable = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(200);
    const n = fish.state.ttsRequests.length;
    if (n !== last) { last = n; stable = Date.now(); } else if (Date.now() - stable >= quietMs) return true;
  }
  return false;
}

async function pollUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`timeout ${timeoutMs}ms: ${label}`);
}

function makeWav(ms = 60) {
  const rate = 8000, dataSize = Math.round((rate * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(dataSize, 40);
  return b;
}

// ---- fake: ローカル AivisSpeech engine ----
const LOCAL_SPEAKERS = [
  { name: 'クロエ', speaker_uuid: 'uuid-chloe', styles: [{ name: 'ノーマル', id: 888753760 }] },
  { name: 'まい', speaker_uuid: 'uuid-mai', styles: [{ name: 'ノーマル', id: 888753761 }] },
  { name: 'ほのか', speaker_uuid: 'uuid-honoka', styles: [{ name: 'ノーマル', id: 888753762 }] },
];
function engineFake({ speakers = LOCAL_SPEAKERS, down = false } = {}) {
  const state = { requests: [], synth: 0, down };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    state.requests.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    if (state.down) { res.writeHead(500); return res.end('{}'); }
    if (req.url.startsWith('/version')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('"0.0.0-fake"'); }
    if (req.url.startsWith('/speakers')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(speakers)); }
    if (req.url.startsWith('/audio_query')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ speedScale: 1 })); }
    state.synth++;
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(makeWav());
  });
  return { state, ready: listen(server) };
}

// ---- fake: Fish Audio(GET /model = 候補一覧 / POST /v1/tts = 合成)----
// 45 件 = 20/20/5、重複 id・takedown・長大 title・XSS title を混ぜる(AC-1 の Given)
function buildModels() {
  const items = [];
  for (let i = 1; i <= 45; i++) {
    items.push({
      _id: `fish-${String(i).padStart(3, '0')}`,
      title: i === 3 ? XSS_TITLE : (i <= 6 && i >= 4 ? `${LONG_TITLE}-${i}` : `ホールドアウトボイス${i}`),
      languages: ['ja'], tags: [`tag${i % 5}`, 'anime'],
      task_count: 1000 - i, dmca_taken_down: false,
      // 応答に混ぜる余計な field(allowlist の検査用。ここが素通りしたら AC-3 が落ちる)
      description: `せつめい${i}`, author: { _id: 'a1', nickname: 'someone' }, secret_echo: SENTINEL,
    });
  }
  items[10] = { ...items[10], _id: items[9]._id };                        // 重複 id
  items[20] = { ...items[20], dmca_taken_down: true };                    // takedown
  items[21] = { ...items[21], title: `anime専用ボイス${22}` };            // 検索 title=anime の的
  return items;
}
const ALL_MODELS = buildModels();
const EXPECTED_IDS = (() => {
  const seen = new Set();
  for (const m of ALL_MODELS) { if (m.dmca_taken_down) continue; seen.add(m._id); }
  return seen;                                                            // 重複除去 + takedown 除外後 = 43 件
})();
// 上流は 20/20/5 で返す。**表示**は重複 id 除去 + takedown 除外の後なので件数が減る。
// G1 の「表示は 20/20/5 件で重複 id と takedown は 0 件」は同時には成立しないので、
// 「上流 20/20/5」と「表示 = 上流 − 重複 − takedown」に分けて測る(緩めではなく分解)。
const PAGE_EXPECT = (() => {
  const seen = new Set(); const out = [];
  for (let p = 0; p < 3; p++) {
    let n = 0;
    for (const m of ALL_MODELS.slice(p * 20, p * 20 + 20)) {
      if (m.dmca_taken_down || seen.has(m._id)) continue;
      seen.add(m._id); n++;
    }
    out.push(n);
  }
  return out;                                                             // [19, 19, 5]
})();

function fishFake(opts = {}) {
  const state = {
    requests: [], modelRequests: [], ttsRequests: [],
    concurrent: 0, maxConcurrent: 0, previewConcurrent: 0, maxPreviewConcurrent: 0,
    modelStatus: opts.modelStatus ?? 200, ttsStatus: opts.ttsStatus ?? 200,
    modelDelayMs: opts.modelDelayMs ?? 0, ttsHold: null, ttsHang: false, arrivals: [],
    holdMode: false, gates: [],   // holdMode 中は request ごとに門で止め、releaseGates(n) で n 本だけ通す
  };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = { __raw: raw }; }
    const rec = { path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, at: Date.now() };
    state.requests.push(rec);
    const isPreview = rec.path.includes('/tts') && body?.text === PREVIEW_TEXT;
    state.arrivals.push(isPreview ? `preview:${body?.reference_id ?? ''}` : `speech:${body?.text ?? ''}`);
    state.concurrent++; state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    if (isPreview) { state.previewConcurrent++; state.maxPreviewConcurrent = Math.max(state.maxPreviewConcurrent, state.previewConcurrent); }
    res.on('close', () => { state.concurrent--; if (isPreview) state.previewConcurrent--; });
    try {
      if (rec.path.startsWith('/model')) {
        state.modelRequests.push(rec);
        if (state.modelDelayMs) await sleep(state.modelDelayMs);
        if (state.modelStatus !== 200) {
          res.writeHead(state.modelStatus, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ message: `fake ${state.modelStatus} ${SENTINEL}`, status: state.modelStatus }));
        }
        const size = Number(rec.query.page_size ?? rec.query.pageSize ?? 20);
        const page = Number(rec.query.page_number ?? rec.query.pageNumber ?? rec.query.page ?? 1);
        let pool = ALL_MODELS;
        if (rec.query.title) pool = pool.filter((m) => String(m.title).includes(String(rec.query.title)));
        const start = (page - 1) * size;
        const slice = pool.slice(start, start + size);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ items: slice, total: pool.length, has_more: start + size < pool.length }));
      }
      // /v1/tts
      state.ttsRequests.push(rec);
      if (state.holdMode) await new Promise((r) => state.gates.push(r));
      if (state.ttsHold) await state.ttsHold;
      if (state.ttsHang) return;                                          // 無応答(client 側の timeout を測る)
      if (state.ttsStatus !== 200) {
        res.writeHead(state.ttsStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: `fake ${state.ttsStatus} ${SENTINEL}`, status: state.ttsStatus }));
      }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(makeWav());
    } catch { /* abort 済み request の後始末 */ }
  });
  return {
    state, ready: listen(server),
    releaseGates: (n = 1) => { for (let i = 0; i < n; i++) state.gates.shift()?.(); },
    releaseAll: () => { state.holdMode = false; while (state.gates.length) state.gates.shift()(); },
  };
}

// ---- 隔離部屋 ----
function mutatedEnv(base) {
  const env = { ...base };
  if (MUTATE === 'dead-fish') {
    env.FISH_API_BASE = 'http://127.0.0.1:1';
    assert.equal(env.FISH_API_BASE, 'http://127.0.0.1:1', '対照未適用: FISH_API_BASE');
  } else if (MUTATE === 'no-key') {
    delete env.FISH_API_KEY;
    assert.ok(!('FISH_API_KEY' in env), '対照未適用: FISH_API_KEY が残っている');
  } else if (MUTATE === 'other-ref') {
    env.FISH_REFERENCE_ID = 'ref-mutated';
    assert.notEqual(env.FISH_REFERENCE_ID, ENV_REF, '対照未適用: reference が同じ');
  } else if (MUTATE === 'dead-engine') {
    env.TTS_URL = 'http://127.0.0.1:1';
    assert.equal(env.TTS_URL, 'http://127.0.0.1:1', '対照未適用: TTS_URL');
  } else if (MUTATE === 'no-hooks') {
    delete env.ROOM_TEST_HOOKS;
    assert.ok(!('ROOM_TEST_HOOKS' in env), '対照未適用: ROOM_TEST_HOOKS が残っている');
  } else if (MUTATE && MUTATE !== 'no-token') {
    throw new Error(`未知の E2E_MUTATE: ${MUTATE}(dead-fish|no-key|other-ref|no-token|dead-engine|no-hooks)`);
  }
  return env;
}

const rooms = [];
function startRoom({ home, port, fishBase, engineBase, chloe = false, extraEnv = {} }) {
  const proc = spawn(process.execPath, ['src/room.ts'], {
    cwd: REPO,
    // 'node' の PATH 解決に頼らない(spawn の ENOENT は exit も出力も無い沈黙になる)
    env: mutatedEnv({
      ...process.env,
      HOME: home, PORT: String(port),
      TTS_URL: engineBase, TTS_PROVIDER: 'fish',
      FISH_API_KEY: SENTINEL, FISH_API_BASE: fishBase, FISH_REFERENCE_ID: ENV_REF,
      ROOM_TEST_HOOKS: '1',
      ...(chloe ? {} : { NO_CHLOE: '1' }),
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
    proc.on('error', (err) => { out += `\n[spawn error] ${err.message}`; resolve({ code: -1, signal: null }); });
  });
  const room = { proc, exited, port, home, output: () => out };
  rooms.push(room);
  return room;
}

async function waitHealthy(room, timeoutMs = 30_000) {
  let dead = false;
  room.exited.then(() => { dead = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead) throw new Error('部屋が healthy 前に終了した:\n' + room.output().slice(-1500));
    try { if ((await fetch(`http://127.0.0.1:${room.port}/health`, { signal: AbortSignal.timeout(900) })).status === 200) return room; } catch { /* 起動中 */ }
    await sleep(150);
  }
  throw new Error(`${timeoutMs}ms 以内に /health が 200 にならない:\n` + room.output().slice(-1500));
}

async function killRoom(room) {
  const alive = () => { try { process.kill(room.proc.pid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  room.proc.kill('SIGTERM');
  await Promise.race([room.exited, sleep(4000)]);
  // exit イベントを取り逃しても「まだ生きている」ことは pid で分かる。生存を signal 0 で確かめてから諦める
  for (let i = 0; i < 10 && alive(); i++) { try { process.kill(room.proc.pid, 'SIGKILL'); } catch { /* 既に居ない */ } await sleep(200); }
  if (alive()) console.error(`[後片付け] room pid ${room.proc.pid} を停止できていない(port ${room.port})`);
}

const tokenOf = (home) => JSON.parse(readFileSync(join(home, '.talkingclaw', 'room.json'), 'utf8')).token;

// ---- HTTP(token は GET=?token= / POST=x-room-token。probe で確認した既存 API 形)----
function tok(t) { return MUTATE === 'no-token' ? '' : t; }
async function get(port, path, token, extra = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`http://127.0.0.1:${port}${path}${sep}token=${encodeURIComponent(tok(token))}`, { headers: extra, signal: AbortSignal.timeout(15_000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: Object.fromEntries(r.headers), text: buf.toString('utf8'), buf };
}
async function post(port, path, body, token, extra = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': tok(token), ...extra },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: Object.fromEntries(r.headers), text: buf.toString('utf8'), buf };
}
const asJson = (res) => { try { return JSON.parse(res.text); } catch { return null; } };

// SSE は開きっぱなしになるので、hello の lastId だけ読んで切る
async function lastEventId(port, token) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/events?after=0&token=${encodeURIComponent(tok(token))}`, { signal: ac.signal });
    const reader = r.body.getReader();
    let buf = '';
    while (buf.length < 4000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const m = buf.match(/"lastId":(\d+)/);
      if (m) return Number(m[1]);
    }
    return -1;
  } catch { return -1; } finally { clearTimeout(timer); ac.abort(); }
}

// SSE を after から一定時間読んで data 行を配列で返す
async function readEvents(port, token, after = 0, ms = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  // buf は try の外。abort は read() の中で throw するので、try の中で parse すると
  // 読めていた分ごと捨ててしまう(実際に踏んだ)
  let buf = '';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/events?after=${after}&token=${encodeURIComponent(tok(token))}`, { signal: ac.signal });
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
    }
  } catch { /* abort = 読み終わり */ } finally { clearTimeout(timer); ac.abort(); }
  const out = [];
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try { out.push(JSON.parse(line.slice(6))); } catch { /* 途中で切れた行 */ }
  }
  return out;
}

// judge 裁定(2026-08-06 21:24)の test seam。ROOM_TEST_HOOKS=1 のときだけ、
// /chat の text が `__chloesay__ ` で始まると Brain 呼び出しだけが echo に置換される。
const CHLOESAY = '__chloesay__ ';
async function chloeSay(port, token, body) {
  const withFlag = await post(port, '/chat', { text: CHLOESAY + body, immediate: true }, token);
  if (withFlag.status < 400) return withFlag;
  return post(port, '/chat', { text: CHLOESAY + body }, token);   // immediate を受けない実装向け
}

// audioStore の件数は /audio/:id の 200 を数えて測る(event id とは別カウンタ)
async function audioCount(port, token, upto = 60) {
  let n = 0;
  for (let i = 1; i <= upto; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/audio/${i}?token=${encodeURIComponent(tok(token))}`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (r) { await r.arrayBuffer().catch(() => null); if (r.status === 200) n++; }
  }
  return n;
}

// 実装前の部屋は未知 POST path を 200 {"status":"unknown_participant"} で飲み込む(probe 実測)。
// 「route がまだ無い」を「契約どおりの応答」と読み違えないための門。
function assertRouteExists(res, path) {
  const j = asJson(res);
  assert.ok(!(res.status === 200 && j && j.status === 'unknown_participant'),
    `${path} が catch-all に飲まれている(= route 未実装)。200 {"status":"unknown_participant"}`);
}

// 一覧の id は provider 名前空間付き("fish:fish-001" / "local:888753760")で来ることがあり、
// voice.json と Fish の reference_id は生 id を持つ。**この食い違い自体は AC-8 の専用検査 1 本で赤くする**。
// 他の検査まで同じ理由で赤くすると原因が 8 個に見えるので、比較はここで正規化する。
const rawId = (id) => { const s = String(id ?? ''); const i = s.indexOf(':'); return i === -1 ? s : s.slice(i + 1); };

// ---- 状態ファイル ----
const statePath = (home, name) => join(home, '.talkingclaw', name);
function lines(home, name) {
  const p = statePath(home, name);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
}
const mode = (p) => statSync(p).mode & 0o777;

// ---- sentinel scanner(+ 陽性対照)----
const scanFor = (hay, needle = SENTINEL) => String(hay).includes(needle);
async function publicAssetsText(port, token) {
  const root = await get(port, '/', token);
  let all = root.text;
  const urls = [...root.text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).slice(0, 30);
  for (const u of new Set(urls)) {
    try { all += '\n' + (await get(port, u, token)).text; } catch { /* 取れない asset は飛ばす */ }
  }
  return all;
}

// ---- browser(playwright は project 依存に無い。実際に launch できたものだけを使う)----
async function resolvePlaywright() {
  const cands = [];
  if (process.env.PLAYWRIGHT_MODULE) cands.push(process.env.PLAYWRIGHT_MODULE);
  cands.push('playwright');
  const npx = join(homedir(), '.npm', '_npx');
  try { for (const d of readdirSync(npx)) cands.push(join(npx, d, 'node_modules', 'playwright', 'index.mjs')); } catch { /* 無ければ飛ばす */ }
  cands.push(join(homedir(), '.claude', 'skills', 'gstack', 'node_modules', 'playwright', 'index.mjs'));
  const tried = [];
  for (const c of cands) {
    try {
      const mod = await import(c);
      const b = await mod.chromium.launch();
      return { mod, browser: b, from: c };
    } catch (e) { tried.push(`${c}: ${String(e.message).split('\n')[0].slice(0, 90)}`); }
  }
  return { mod: null, browser: null, tried };
}

// ---- 候補 API の paging / 検索 / 全公開の param 名は G1 に無い。壊れた推測で赤くしないよう
//      「上流に page_number=2 を出させた variant」を実測で選ぶ(緩めではなく発見)----
async function discoverParam(port, token, fish, variants, verify) {
  const tried = [];
  for (const v of variants) {
    const before = fish.state.modelRequests.length;
    const res = await get(port, `/voice/api/candidates?${v}`, token);
    const fresh = fish.state.modelRequests.slice(before);
    if (res.status === 200 && verify(fresh, res)) return { qs: v, res, upstream: fresh };
    tried.push(`${v} → ${res.status} / upstream ${fresh.length} 件`);
  }
  throw new Error(`param が見つからない。試した: ${tried.join(' | ')}`);
}

// ============================ 本体 ============================
const watchdog = setTimeout(() => {
  console.error('全体 timeout(20 分)。隔離部屋を kill して失敗終了');
  for (const r of rooms) { try { r.proc.kill('SIGKILL'); } catch { /* 既に死んでいる */ } }
  process.exit(1);
}, 20 * 60_000);
watchdog.unref();

// uncaught / 早期 exit でも隔離部屋を残さないための同期の最後の砦
process.on('exit', () => {
  for (const r of rooms) { try { process.kill(r.proc.pid, 'SIGKILL'); } catch { /* 既に居ない */ } }
});

const tmpHomes = [];
const newHome = (tag) => { const h = mkdtempSync(join(tmpdir(), `voice-e2e-${tag}-`)); tmpHomes.push(h); return h; };

if (MUTATE) console.log(`[負の対照] E2E_MUTATE=${MUTATE} — 対応する検査が赤くなるのが正しい\n`);

try {
  // ========================================================================
  // 部屋 A: 候補一覧 / secret 境界 / 試聴の課金 / preview 隔離(NO_CHLOE)
  // ========================================================================
  const fishA = fishFake();
  const engA = engineFake();
  const fA = await fishA.ready, eA = await engA.ready;
  const homeA = newHome('a'), portA = await freePort();
  const roomA = startRoom({ home: homeA, port: portA, fishBase: fA.base, engineBase: eA.base });
  let tokenA = '';

  await step('setup A', async () => {
    await waitHealthy(roomA);
    tokenA = tokenOf(homeA);
    assert.ok(tokenA && tokenA.length >= 16, 'room.json に token が無い');
    const html = (await get(portA, '/', tokenA)).text;
    const m = html.match(/<meta name="room-token" content="([^"]+)"/);
    assert.ok(m && m[1] !== '__ROOM_TOKEN__', 'GET / の HTML に room token が実値で埋まる契約');
    ok(`port=${portA} fish=${fA.base}`);
  });

  // ---------------- AC-1 voice-candidates-contract ----------------
  await step('AC-1 candidates: 初期表示', async () => {
    const before = fishA.state.modelRequests.length;
    const res = await get(portA, '/voice/api/candidates', tokenA);
    assert.equal(res.status, 200, `候補一覧は 200 の契約: ${res.status} ${res.text.slice(0, 200)}`);
    const j = asJson(res);
    assert.ok(j, `JSON 応答の契約: ${res.text.slice(0, 200)}`);
    const items = Array.isArray(j) ? j : (j.items ?? j.candidates ?? []);
    assert.ok(Array.isArray(items) && items.length > 0, `候補が 0 件では以降の検査が空振りする: ${res.text.slice(0, 300)}`);

    const upstream = fishA.state.modelRequests.slice(before);
    assert.equal(upstream.length, 1, `初期表示の upstream は 1 本: ${upstream.length} 本`);
    const q = upstream[0].query;
    assert.equal(String(q.page_size ?? q.pageSize), '20', `既定 page_size=20: ${JSON.stringify(q)}`);
    assert.equal(String(q.page_number ?? q.pageNumber ?? q.page ?? '1'), '1', `page_number は 1-origin: ${JSON.stringify(q)}`);
    assert.equal(q.language, 'ja', `既定 language=ja: ${JSON.stringify(q)}`);
    assert.equal(q.sort_by ?? q.sortBy, 'task_count', `既定 sort_by=task_count: ${JSON.stringify(q)}`);
    const allowedQ = new Set(['title', 'language', 'tag', 'sort_by', 'sortBy', 'page_size', 'pageSize', 'page_number', 'pageNumber', 'page']);
    const extraQ = Object.keys(q).filter((k) => !allowedQ.has(k));
    assert.deepEqual(extraQ, [], `upstream へ渡す query は allowlist のみ: 余計な ${extraQ.join(',')}`);

    const fish = items.filter((c) => c.provider === 'fish');
    assert.equal(fish.length, PAGE_EXPECT[0],
      `1 ページ目の Fish 候補は「上流 20 − 重複 1」= ${PAGE_EXPECT[0]} 件: ${fish.length}`);
    const localOnes = items.filter((c) => c.provider === 'local');
    assert.ok(localOnes.length >= 1, 'ローカル話者が常時候補に出る契約');
    assert.equal(new Set(items.map((c) => `${c.provider}:${c.id}`)).size, items.length, '同一ページ内に重複 id が無い');
    assert.equal(items.filter((c) => String(c.title ?? '').length > 200).length, 0, 'title は長さ制限される契約(200 字超が出た)');
    ok(`${items.length} 件(fish 20 / local ${localOnes.length})`);
  });

  await step('AC-1 candidates: 応答 field の allowlist(AC-3 と同じ面)', async () => {
    const j = asJson(await get(portA, '/voice/api/candidates', tokenA));
    const items = Array.isArray(j) ? j : (j.items ?? j.candidates ?? []);
    const allowed = new Set(['provider', 'id', 'title', 'tags', 'languages', 'selected']);
    for (const c of items) {
      const extra = Object.keys(c).filter((k) => !allowed.has(k));
      assert.deepEqual(extra, [], `候補は allowlist した field のみ: ${JSON.stringify(c).slice(0, 200)} に ${extra.join(',')}`);
    }
    ok(`${items.length} 件すべて {provider,id,title,tags,languages,selected}`);
  });

  await step('AC-1 candidates: 次ページ 2 回 → 45 件すべてが選択導線に載る', async () => {
    const reached = new Set();
    // 直前の step が検索 / 全公開を投げているので、走査の起点は page=1 を明示する
    const first = asJson(await get(portA, '/voice/api/candidates?page=1', tokenA));
    const firstItems = (Array.isArray(first) ? first : (first.items ?? first.candidates ?? [])).filter((c) => c.provider === 'fish');
    assert.equal(firstItems.length, PAGE_EXPECT[0], `前提: page 1 が ${PAGE_EXPECT[0]} 件(検索状態を引きずっていない): ${firstItems.length} 件`);
    firstItems.forEach((c) => reached.add(rawId(c.id)));

    let pageParam = null;
    for (const page of [2, 3]) {
      const variants = [`page=${page}`, `page_number=${page}`, `pageNumber=${page}`].filter((v) => !pageParam || v.startsWith(pageParam));
      const found = await discoverParam(portA, tokenA, fishA, variants, (fresh) => fresh.length === 1
        && String(fresh[0].query.page_number ?? fresh[0].query.pageNumber ?? fresh[0].query.page) === String(page));
      pageParam = found.qs.split('=')[0];
      const j = asJson(found.res);
      const items = (Array.isArray(j) ? j : (j.items ?? j.candidates ?? [])).filter((c) => c.provider === 'fish');
      items.forEach((c) => reached.add(rawId(c.id)));
      const localCount = (Array.isArray(j) ? j : (j.items ?? j.candidates ?? [])).filter((c) => c.provider === 'local').length;
      assert.ok(localCount >= 1, `ローカル話者はページに依らず常時出る(page ${page} で 0 件)`);
      assert.equal(items.length, PAGE_EXPECT[page - 1],
        `page ${page} の表示件数(上流 ${page === 3 ? 5 : 20} − 重複 − takedown)= ${PAGE_EXPECT[page - 1]}: ${items.length}`);
      assert.equal(String(found.upstream[0].query.page_size ?? found.upstream[0].query.pageSize), '20',
        `page ${page} も page_size=20: ${JSON.stringify(found.upstream[0].query)}`);
    }
    assert.equal(reached.size, EXPECTED_IDS.size,
      `45 件すべてが選択導線に載る契約(重複 1 件・takedown 1 件を除く ${EXPECTED_IDS.size} 件)。到達 ${reached.size} 件`);
    for (const id of EXPECTED_IDS) assert.ok(reached.has(id), `到達できない候補: ${id}`);
    const takedown = ALL_MODELS.find((m) => m.dmca_taken_down)._id;
    assert.ok(!reached.has(takedown), `dmca_taken_down は 0 件の契約(${takedown} が出た)`);
    ok(`page param="${pageParam}" / 到達 ${reached.size}/${EXPECTED_IDS.size} 件・takedown 0・重複 0`);
  });

  await step('AC-1 candidates: has_more=false で追加取得を止める', async () => {
    const before = fishA.state.modelRequests.length;
    const p3 = await get(portA, '/voice/api/candidates?page=3', tokenA);
    // route が無ければ「upstream 0 本」は自明に成立する。前提を先に締める
    assert.equal(p3.status, 200, `前提: page 3 が 200 で取れている(でないと下の 0 本が空振り): ${p3.status}`);
    const j3 = asJson(p3);
    assert.ok((Array.isArray(j3) ? j3 : (j3?.items ?? j3?.candidates ?? [])).length > 0, '前提: page 3 に候補がある');
    const afterPage3 = fishA.state.modelRequests.length;
    await get(portA, '/voice/api/candidates?page=4', tokenA);
    const extra = fishA.state.modelRequests.length - afterPage3;
    assert.ok(extra === 0, `has_more=false の先(page 4)を upstream へ取りに行かない契約: ${extra} 本送っている`);
    ok(`page3 で ${afterPage3 - before} 本・page4 で 0 本`);
  });

  await step('AC-1 candidates: title 検索', async () => {
    const found = await discoverParam(portA, tokenA, fishA,
      ['title=anime', 'q=anime', 'search=anime'],
      (fresh) => fresh.length === 1 && fresh[0].query.title === 'anime');
    const j = asJson(found.res);
    const items = (Array.isArray(j) ? j : (j.items ?? j.candidates ?? [])).filter((c) => c.provider === 'fish');
    assert.ok(items.length >= 1, '検索 title=anime が 1 件以上に当たる(fake 側に的を仕込んである)');
    ok(`検索 param="${found.qs}" / ${items.length} 件`);
  });

  await step('AC-1 candidates: 「全公開」= language 制限を外す', async () => {
    const found = await discoverParam(portA, tokenA, fishA,
      ['all=1', 'language=', 'scope=all', 'allPublic=1'],
      (fresh) => fresh.length === 1 && !fresh[0].query.language);
    ok(`全公開 param="${found.qs}"(upstream に language が付かない)`);
  });

  // ---------------- AC-2 voice-list-cache-fallback ----------------
  await step('AC-2 (a) fresh cache: 2 回目の upstream は 0 本', async () => {
    await get(portA, '/voice/api/candidates', tokenA);            // 温める
    const before = fishA.state.modelRequests.length;
    const res = await get(portA, '/voice/api/candidates', tokenA);
    const after = fishA.state.modelRequests.length;
    assert.equal(res.status, 200, `fresh cache でも 200: ${res.status}`);
    assert.equal(after - before, 0, `age < 5 分は upstream 0 の契約: ${after - before} 本`);
    const j = asJson(res);
    assert.ok(!(j?.error || j?.warning), `fresh では error 0 行: ${JSON.stringify(j?.error ?? j?.warning)}`);
    ok('upstream 0 本・error 0 行');
  });

  await step('AC-2 single-flight: 並行 4 要求でも upstream 1 本', async () => {
    const fishSF = fishFake({ modelDelayMs: 600 });
    const engSF = engineFake();
    const f = await fishSF.ready, e = await engSF.ready;
    const home = newHome('sf'), port = await freePort();
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const rs = await Promise.all([0, 1, 2, 3].map(() => get(port, '/voice/api/candidates', t)));
      assert.ok(rs.every((r) => r.status === 200), `4 本とも 200: ${rs.map((r) => r.status).join(',')}`);
      assert.equal(fishSF.state.modelRequests.length, 1,
        `single-flight で upstream は 1 本の契約: ${fishSF.state.modelRequests.length} 本`);
      ok('4 並行 → upstream 1 本');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-2 (c) cache 無し + list 503 → local only + error 1 行', async () => {
    const fish503 = fishFake({ modelStatus: 503 });
    const eng = engineFake();
    const f = await fish503.ready, e = await eng.ready;
    const home = newHome('c503'), port = await freePort();
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const res = await get(port, '/voice/api/candidates', t);
      assert.ok(res.status < 500, `list 503 でも部屋は沈黙しない(2xx で local only を返す契約): ${res.status}`);
      const j = asJson(res);
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      assert.ok(items.length >= 1 && items.every((c) => c.provider === 'local'), `local only の契約: ${JSON.stringify(items).slice(0, 200)}`);
      const err = j?.error ?? j?.warning ?? j?.errors;
      assert.ok(err, 'error 1 行を添える契約(error/warning field が無い)');
      assert.ok(!scanFor(JSON.stringify(j)), `error 行に上流 body(sentinel)を混ぜない: ${JSON.stringify(j).slice(0, 200)}`);
      ok(`local ${items.length} 件 + error 1 行`);
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-2 (b) stale cache(age >= 5 分)は破棄せず stale + local', async () => {
    // 5 分の実時間を要する。TTL の env override を honor するならそれで測る
    const fishS = fishFake();
    const eng = engineFake();
    const f = await fishS.ready, e = await eng.ready;
    const home = newHome('stale'), port = await freePort();
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base, extraEnv: { VOICE_LIST_TTL_MS: '800' } });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      await get(port, '/voice/api/candidates', t);                       // fresh を作る
      await sleep(1100);
      const before = fishS.state.modelRequests.length;
      await get(port, '/voice/api/candidates', t);
      const honored = fishS.state.modelRequests.length > before;
      if (!honored && !SLOW) {
        blocked('TTL の env override(VOICE_LIST_TTL_MS)を honor せず、5 分の実待ちも未許可。VOICE_HOLDOUT_SLOW=1 で実測できる');
        return;
      }
      if (!honored) { await sleep(5 * 60_000 + 5_000); }                  // SLOW: 実時間で stale にする
      // honored の判定で 1 回再取得しており cache は fresh に戻っている。**もう一度 stale にしてから**測る
      await sleep(honored ? 1100 : 5 * 60_000 + 5_000);
      fishS.state.modelStatus = 503;                                      // 再取得先だけを落とす
      const n0 = fishS.state.modelRequests.length;
      const res = await get(port, '/voice/api/candidates', t);
      const n1 = fishS.state.modelRequests.length;
      assert.equal(n1 - n0, 1, `stale は再取得を 1 本出す契約: ${n1 - n0} 本`);
      const j = asJson(res);
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      assert.ok(items.some((c) => c.provider === 'fish'), 'stale を破棄しない契約(fish 候補が消えている)');
      assert.ok(items.some((c) => c.provider === 'local'), 'stale + local の契約(local が出ていない)');
      assert.ok(j?.error ?? j?.warning, 'error 1 行を添える契約');
      ok(`stale ${items.filter((c) => c.provider === 'fish').length} 件 + local + error 1 行`);
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  // ---------------- AC-3 voice-secret-negative(面ごとに 1 検査)----------------
  await step('AC-3 面1 拒否: 無 token / 偽 token は 401、偽 Origin は 403、Fish request 0', async () => {
    // 陽性対照 — 拒否の理由が「route が無い」ではないことを先に固める(memo holdout AC-8 で踏んだ穴)
    const alive = await get(portA, '/voice/api/candidates', tokenA);
    assert.equal(alive.status, 200, `前提: 正規の token では 200(route が無いと 401/403 が何も測っていない): ${alive.status}`);
    for (const p of ['/voice/api/preview', '/voice/api/select']) {
      const r = await post(portA, p, { candidateId: 'probe' }, tokenA);
      assertRouteExists(r, p);
    }
    const n0 = fishA.state.requests.length;
    const paths = ['/voice/api/candidates', '/voice/api/preview', '/voice/api/select'];
    for (const p of paths) {
      const g = await fetch(`http://127.0.0.1:${portA}${p}`, {
        method: p === '/voice/api/candidates' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: p === '/voice/api/candidates' ? undefined : JSON.stringify({ candidateId: 'x' }),
      });
      assert.equal(g.status, 401, `${p} に token 無しは 401 の契約: ${g.status}`);
      const bad = p === '/voice/api/candidates'
        ? await get(portA, p, 'not-a-real-token')
        : await post(portA, p, { candidateId: 'x' }, 'not-a-real-token');
      assert.equal(bad.status, 401, `${p} に偽 token は 401 の契約: ${bad.status}`);
      const origin = p === '/voice/api/candidates'
        ? await get(portA, p, tokenA, { Origin: 'https://evil.example' })
        : await post(portA, p, { candidateId: 'x' }, tokenA, { Origin: 'https://evil.example' });
      assert.equal(origin.status, 403, `${p} に不一致 Origin は 403 の契約: ${origin.status} ${origin.text.slice(0, 120)}`);
    }
    assert.equal(fishA.state.requests.length - n0, 0, `全拒否で Fish request 0 の契約: ${fishA.state.requests.length - n0} 件`);
    ok('401×6 / 403×3 / Fish 0');
  });

  await step('AC-3 面2 未知 candidateId は 404・Fish 0', async () => {
    const n0 = fishA.state.requests.length;
    for (const p of ['/voice/api/preview', '/voice/api/select']) {
      const res = await post(portA, p, { candidateId: 'fish-does-not-exist-999' }, tokenA);
      assertRouteExists(res, p);
      assert.equal(res.status, 404, `${p} の未知 id は 404 の契約: ${res.status} ${res.text.slice(0, 150)}`);
    }
    assert.equal(fishA.state.requests.length - n0, 0, `未知 id で Fish request 0 の契約: ${fishA.state.requests.length - n0} 件`);
    ok('404×2 / Fish 0');
  });

  await step('AC-3 面3 preview body は exact {candidateId} だけ(任意 text/model/URL を拒否)', async () => {
    const j = asJson(await get(portA, '/voice/api/candidates', tokenA));
    const items = Array.isArray(j) ? j : (j.items ?? j.candidates ?? []);
    const cand = items.find((c) => c.provider === 'fish');
    assert.ok(cand, '前提: fish 候補が 1 件以上ある');
    const n0 = fishA.state.ttsRequests.length;
    const res = await post(portA, '/voice/api/preview', {
      candidateId: cand.id, text: '課金させる長文'.repeat(50), model: 's2.1-pro', url: 'http://evil.example/x',
    }, tokenA);
    assertRouteExists(res, '/voice/api/preview');
    assert.ok(res.status >= 400 && res.status < 500, `余計な field を持つ preview body は 4xx で拒否する契約: ${res.status}`);
    assert.equal(fishA.state.ttsRequests.length - n0, 0, `拒否した preview で Fish request 0: ${fishA.state.ttsRequests.length - n0} 件`);
    ok(`${res.status} / Fish 0`);
  });

  await step('AC-3 面4 sentinel が 4 面(応答・log・public asset・voice.json)に 0 件', async () => {
    // 検出器の陽性対照 — scanner 自体が死んでいないことを先に測る
    assert.ok(scanFor(`prefix ${SENTINEL} suffix`), '陽性対照: scanner が sentinel を検出できていない');
    const res = await get(portA, '/voice/api/candidates', tokenA);
    assert.ok(res.text.length > 10, '前提: 走査対象の応答が空でない');
    assert.ok(!scanFor(res.text), 'sentinel が候補応答に出ている');
    assert.ok(!scanFor(JSON.stringify(res.headers)), 'sentinel が応答 header に出ている');
    // 上流 error body をそのまま返さない(fake は error body に sentinel を混ぜてある)
    const savedStatus = fishA.state.modelStatus;
    try {
      fishA.state.modelStatus = 500;
      const home = newHome('leak'), port = await freePort();
      const r2 = startRoom({ home, port, fishBase: fA.base, engineBase: eA.base });
      await waitHealthy(r2);
      const t2 = tokenOf(home);
      const errRes = await get(port, '/voice/api/candidates', t2);
      assert.notEqual(errRes.status, 404, '前提: route が有る(404 なら「上流 error を返さない」は自明で空振り)');
      assert.ok(errRes.text.length > 2, `前提: 走査対象の応答が空でない: "${errRes.text}"`);
      assert.ok(!scanFor(errRes.text), `上流 error body をそのまま返さない契約: ${errRes.text.slice(0, 200)}`);
      await killRoom(r2);
    } finally { fishA.state.modelStatus = savedStatus; }
    const assets = await publicAssetsText(portA, tokenA);
    assert.ok(assets.length > 1000, `前提: public asset の走査対象が空でない(${assets.length} byte)`);
    assert.ok(!scanFor(assets), 'sentinel が public asset に出ている');
    assert.ok(!scanFor(roomA.output()), `sentinel が server log に出ている: ${roomA.output().slice(-300)}`);
    const vj = statePath(homeA, 'voice.json');
    if (existsSync(vj)) assert.ok(!scanFor(readFileSync(vj, 'utf8')), 'sentinel が voice.json に出ている');
    ok(`応答 / header / public asset ${assets.length}B / log ${roomA.output().length}B / voice.json`);
  });

  // ---------------- AC-4 preview-budget-restart ----------------
  const candIds = { fish: [], local: [], all: [] };
  await step('setup A 候補 id の取得', async () => {
    const j = asJson(await get(portA, '/voice/api/candidates?page=1', tokenA));
    const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
    candIds.all = items;
    candIds.fish = items.filter((c) => c.provider === 'fish').map((c) => c.id);
    candIds.local = items.filter((c) => c.provider === 'local').map((c) => c.id);
    assert.ok(candIds.fish.length >= 11, `前提: 試聴の上限(10)を超えられるだけの候補がある: ${candIds.fish.length} 件`);
    ok(`fish ${candIds.fish.length} / local ${candIds.local.length}`);
  });

  await step('AC-4 固定文・format wav・model header exact', async () => {
    assert.ok(candIds.fish.length >= 11, `前提: 異なる候補が 11 件以上ある(${candIds.fish.length} 件)`);
    const n0 = fishA.state.ttsRequests.length;
    const res = await post(portA, '/voice/api/preview', { candidateId: candIds.fish[0] }, tokenA);
    assertRouteExists(res, '/voice/api/preview');
    assert.equal(res.status, 200, `試聴は 200 + ephemeral WAV の契約: ${res.status} ${res.text.slice(0, 150)}`);
    assert.ok(res.buf.subarray(0, 4).toString('latin1') === 'RIFF', `応答は WAV bytes の契約: ${res.buf.subarray(0, 16).toString('latin1')}`);
    const sent = fishA.state.ttsRequests.slice(n0);
    assert.equal(sent.length, 1, `Fish へ 1 回だけ: ${sent.length} 回`);
    assert.equal(sent[0].body.text, PREVIEW_TEXT, `試聴文は server 固定「${PREVIEW_TEXT}」: ${sent[0].body.text}`);
    assert.equal(sent[0].body.format, 'wav', `format:wav の契約: ${sent[0].body.format}`);
    assert.equal(sent[0].headers.model, FREE_MODEL, `header model exact "${FREE_MODEL}": ${sent[0].headers.model}`);
    assert.equal(rawId(sent[0].body.reference_id), rawId(candIds.fish[0]),
      `reference_id は選んだ候補(${candIds.fish[0]}): ${sent[0].body.reference_id}`);
    ok('固定文 / wav / s2.1-pro-free / reference 一致');
  });

  await step('AC-4 同一 candidate は 10 分 cache で Fish 1 回', async () => {
    const id = candIds.fish[1];
    await post(portA, '/voice/api/preview', { candidateId: id }, tokenA);
    const n0 = fishA.state.ttsRequests.length;
    const again = await post(portA, '/voice/api/preview', { candidateId: id }, tokenA);
    assert.equal(again.status, 200, `cache hit も 200 で音を返す: ${again.status}`);
    assert.equal(fishA.state.ttsRequests.length - n0, 0, `同一 candidate の 2 回目は Fish 0 の契約: ${fishA.state.ttsRequests.length - n0} 回`);
    ok('2 回目 upstream 0');
  });

  await step('AC-4 WAL は送信前に 0600 で書かれる', async () => {
    const wal = statePath(homeA, 'voice-preview.jsonl');
    assert.ok(existsSync(wal), `${wal} が無い(送信前 write-ahead の契約)`);
    assert.equal(mode(wal), 0o600, `WAL の mode は 0600: ${mode(wal).toString(8)}`);
    assert.ok(lines(homeA, 'voice-preview.jsonl').length >= 1, '前提: WAL が空でない(空なら以降が空振りする)');
    assert.ok(!scanFor(readFileSync(wal, 'utf8')), 'WAL に API キーが 0 件の契約');

    // 送信中に WAL を読む = 「送信後に書く」実装なら見えない
    let release;
    fishA.state.ttsHold = new Promise((r) => { release = r; });
    const id = candIds.fish[2];
    const before = lines(homeA, 'voice-preview.jsonl').length;
    const inflight = post(portA, '/voice/api/preview', { candidateId: id }, tokenA).catch(() => null);
    try {
      await pollUntil(() => fishA.state.ttsRequests.some((r) => rawId(r.body?.reference_id) === rawId(id)), 8000, 'preview が Fish に到達');
      const during = lines(homeA, 'voice-preview.jsonl');
      assert.ok(during.length > before, `attempt は送信「前」に記録する契約(送信中に増えていない: ${before}→${during.length})`);
      assert.ok(during.some((l) => l.includes(rawId(id))), `WAL に該当 candidate の行が無い: ${during.slice(-1)[0]}`);
    } finally { release(); fishA.state.ttsHold = null; await inflight; }
    ok(`0600 / 送信前 / ${lines(homeA, 'voice-preview.jsonl').length} 行`);
  });

  await step('AC-4 rolling 10 分 10 回 → 11 回目は 429 + retryAfterMs で Fish 0', async () => {
    const used = new Set(fishA.state.ttsRequests.filter((r) => r.body?.text === PREVIEW_TEXT).map((r) => rawId(r.body.reference_id)));
    let sent = used.size;
    let last = null, over = null;
    for (const id of candIds.fish) {
      if (used.has(rawId(id))) continue;
      const n0 = fishA.state.ttsRequests.length;
      const res = await post(portA, '/voice/api/preview', { candidateId: id }, tokenA);
      const delta = fishA.state.ttsRequests.length - n0;
      if (res.status === 429) { over = { res, delta }; break; }
      assert.equal(res.status, 200, `上限内の試聴は 200: ${res.status} ${res.text.slice(0, 120)}`);
      sent += delta; last = id;
      assert.ok(sent <= 10, `room 全体で 10 分 10 回まで。${sent} 回送っている(最後: ${last})`);
    }
    assert.ok(over, `11 回目は 429 の契約(${sent} 回送っても 429 が来ない)`);
    assert.equal(over.delta, 0, `429 のとき Fish request 0: ${over.delta} 件`);
    const j = asJson(over.res);
    assert.ok(Number.isFinite(j?.retryAfterMs), `429 は retryAfterMs を返す契約: ${over.res.text.slice(0, 150)}`);
    assert.equal(sent, 10, `上限は 10 回ちょうど: ${sent} 回`);
    ok(`10 回 → 11 回目 429(retryAfterMs=${j.retryAfterMs})`);
  });

  await step('AC-4 preview は retry 0・timeout 4s', async () => {
    const home = newHome('to'), port = await freePort();
    const fishT = fishFake(); const engT = engineFake();
    const f = await fishT.ready, e = await engT.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const id = items.find((c) => c.provider === 'fish')?.id;
      assert.ok(id, '前提: fish 候補がある');
      fishT.state.ttsHang = true;
      const t0 = Date.now();
      const res = await post(port, '/voice/api/preview', { candidateId: id }, t).catch((e2) => ({ status: 0, text: e2.message }));
      const ms = Date.now() - t0;
      assert.ok(res.status !== 200, `無応答の試聴は 200 にならない: ${res.status}`);
      assert.ok(ms >= 3000 && ms <= 9000, `T=4s で打ち切る契約(実測 ${ms}ms)`);
      assert.equal(fishT.state.ttsRequests.length, 1, `試聴は retry 0 の契約: ${fishT.state.ttsRequests.length} 回`);
      ok(`${ms}ms で終端・upstream 1 回`);
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-4 WAL に記録できなければ 503 + Fish 0', async () => {
    const home = newHome('wal'), port = await freePort();
    mkdirSync(join(home, '.talkingclaw'), { recursive: true });
    mkdirSync(join(home, '.talkingclaw', 'voice-preview.jsonl'));        // file の位置を dir で塞ぐ
    const fishW = fishFake(); const engW = engineFake();
    const f = await fishW.ready, e = await engW.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const id = items.find((c) => c.provider === 'fish')?.id;
      assert.ok(id, '前提: fish 候補がある(list は WAL と無関係に出る)');
      const n0 = fishW.state.ttsRequests.length;
      const res = await post(port, '/voice/api/preview', { candidateId: id }, t);
      assert.equal(res.status, 503, `台帳に記録できなければ 503 の契約: ${res.status} ${res.text.slice(0, 150)}`);
      assert.equal(fishW.state.ttsRequests.length - n0, 0, `503 のとき Fish request 0: ${fishW.state.ttsRequests.length - n0} 件`);
      ok('503 / Fish 0');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-4 再起動しても直前 10 分の上限が復元する', async () => {
    const home = newHome('restart'), port = await freePort();
    const fishR = fishFake(); const engR = engineFake();
    const f = await fishR.ready, e = await engR.ready;
    let room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      let t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const ids = items.filter((c) => c.provider === 'fish').map((c) => c.id);
      assert.ok(ids.length >= 11, `前提: 11 件以上の候補(${ids.length})`);
      for (let i = 0; i < 6; i++) {
        const r = await post(port, '/voice/api/preview', { candidateId: ids[i] }, t);
        assert.equal(r.status, 200, `再起動前の ${i + 1} 回目は 200: ${r.status}`);
      }
      const walBefore = lines(home, 'voice-preview.jsonl').length;
      assert.ok(walBefore >= 6, `前提: WAL に 6 件以上(${walBefore})`);
      await killRoom(room);
      room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
      await waitHealthy(room);
      t = tokenOf(home);
      // 再起動後は候補 cache が空。id を解決させるため一覧を取り直す(取らないと 404 になる)
      const j2 = asJson(await get(port, '/voice/api/candidates?page=1', t));
      const items2 = Array.isArray(j2) ? j2 : (j2?.items ?? j2?.candidates ?? []);
      const ids2 = items2.filter((c) => c.provider === 'fish').map((c) => c.id);
      assert.ok(ids2.length >= 11, `前提: 再起動後も 11 件以上(${ids2.length})`);
      let over = null, extra = 0;
      for (let i = 6; i < ids2.length; i++) {
        const r = await post(port, '/voice/api/preview', { candidateId: ids2[i] }, t);
        if (r.status === 429) { over = i; break; }
        assert.equal(r.status, 200, `再起動後の試聴は 200 か 429: ${r.status}`);
        extra++;
      }
      assert.ok(over !== null, '再起動で上限がリセットされない契約(429 が来ない = in-memory だけで数えている)');
      assert.equal(extra, 4, `残枠は 10-6=4 回の契約: ${extra} 回通った`);
      ok(`再起動前 6 + 後 4 = 10 で 429`);
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  note('AC-4 の「model 欠落/相違で fail-closed(Fish 0)」は build/config を壊す注入が要るため black-box では測れない。'
    + 'PBI-007 の check-fish-tts.mjs(変異 M1)に委譲した。本検査は正常系の header exact だけを測っている。');

  // ---------------- AC-5 preview-conversation-race(server 側)----------------
  await step('AC-5 preview は EventStore / transcript / audioStore / metrics に 0 件', async () => {
    const home = newHome('iso'), port = await freePort();
    const fishI = fishFake(); const engI = engineFake();
    const f = await fishI.ready, e = await engI.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const id = items.find((c) => c.provider === 'fish')?.id;
      assert.ok(id, '前提: fish 候補がある');

      const before = {
        ev: await lastEventId(port, t),
        transcript: lines(home, 'transcript.jsonl').length,
        metrics: lines(home, 'metrics.jsonl').length,
        audio: await audioCount(port, t),
      };
      assert.ok(before.ev >= 0, '前提: EventStore の lastId を読めている');

      const res = await post(port, '/voice/api/preview', { candidateId: id }, t);
      assert.equal(res.status, 200, `前提: 試聴が成功している(でないと「0 件」が空振り): ${res.status}`);
      await sleep(700);
      assert.equal(await lastEventId(port, t), before.ev, 'preview は EventStore に 0 件の契約');
      assert.equal(lines(home, 'transcript.jsonl').length, before.transcript, 'preview は transcript に 0 件の契約');
      assert.equal(lines(home, 'metrics.jsonl').length, before.metrics, 'preview は turn metrics に 0 件の契約');
      assert.equal(await audioCount(port, t), before.audio, 'preview は audioStore(/audio/:id)に 0 件の契約');

      // 陽性対照 — 会話なら 4 つとも増える。増えないなら上の「0 件」は空振り
      const who = asJson(await post(port, '/join', { requestedName: '対照発話', voice: 'まい/ノーマル' }, t));
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.participantId === who.participantId && x.voice === 'ready');
      }, 25_000, 'engine ready');
      await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'たいしょうはつわ。' }, t);
      await pollUntil(async () => (await lastEventId(port, t)) > before.ev, 10_000,
        '陽性対照: 会話は EventStore を増やす(増えないなら preview の「0 件」が空振り)');
      assert.ok(await audioCount(port, t) > before.audio, '陽性対照: 会話は audioStore を増やす');
      ok('event / transcript / metrics / audioStore すべて不変(陽性対照あり)');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-5 user speaking 中は試聴が拒否され Fish 0', async () => {
    const n0 = fishA.state.ttsRequests.length;
    await post(portA, '/speech-state', { speaking: true }, tokenA);
    try {
      const res = await post(portA, '/voice/api/preview', { candidateId: candIds.fish[0] }, tokenA);
      assert.ok(res.status >= 400, `user speaking 中の試聴は拒否する契約: ${res.status}`);
      assert.equal(fishA.state.ttsRequests.length - n0, 0, `拒否時 Fish 0: ${fishA.state.ttsRequests.length - n0} 件`);
      ok(`${res.status} / Fish 0`);
    } finally { await post(portA, '/speech-state', { speaking: false }, tokenA); }
  });

  await step('AC-5 preview 同時実行は 1・Fish 全体 5 以下・conversation が先に slot を得る', async () => {
    const home = newHome('slot'), port = await freePort();
    const fishS = fishFake(); const engS = engineFake();
    const f = await fishS.ready, e = await engS.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const ids = items.filter((c) => c.provider === 'fish').map((c) => c.id);
      const who = asJson(await post(port, '/join', { requestedName: '負荷', voice: 'まい/ノーマル' }, t));
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.participantId === who.participantId && x.voice === 'ready');
      }, 20_000, 'engine ready');

      let release;
      fishS.state.ttsHold = new Promise((r) => { release = r; });
      // 会話 6 文 + 試聴 2 件を同時に投げる
      const speech = post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'あ。い。う。え。お。か。' }, t).catch(() => null);
      const p1 = post(port, '/voice/api/preview', { candidateId: ids[0] }, t).catch(() => null);
      const p2 = post(port, '/voice/api/preview', { candidateId: ids[1] }, t).catch(() => null);
      await sleep(1500);
      assert.ok(fishS.state.maxConcurrent <= 5, `Fish 全体の同時実行は 5 以下: ${fishS.state.maxConcurrent}`);
      assert.ok(fishS.state.maxPreviewConcurrent <= 1, `preview 同時実行は 1: ${fishS.state.maxPreviewConcurrent}`);
      release(); fishS.state.ttsHold = null;
      await Promise.all([speech, p1, p2]);
      assert.ok(fishS.state.ttsRequests.length >= 3, `前提: 実際に合成が走った(${fishS.state.ttsRequests.length} 件)`);
      ok(`maxConcurrent=${fishS.state.maxConcurrent} / preview 同時=${fishS.state.maxPreviewConcurrent}`);

      // conversation 優先: 4 本を握ったまま preview → conversation の順で投げ、conversation が先に届く
      let release2;
      fishS.state.ttsHold = new Promise((r) => { release2 = r; });
      const hold = post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'ま。み。む。め。' }, t).catch(() => null);
      await sleep(400);
      const mark = fishS.state.arrivals.length;
      const pv = post(port, '/voice/api/preview', { candidateId: ids[2] }, t).catch(() => null);
      await sleep(120);
      const conv = post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'さいごのいちぶん。' }, t).catch(() => null);
      await sleep(1200);
      release2(); fishS.state.ttsHold = null;
      await Promise.all([hold, pv, conv]);
      const after = fishS.state.arrivals.slice(mark);
      const firstPreview = after.findIndex((a) => a.startsWith('preview:'));
      const firstConv = after.findIndex((a) => a.startsWith('speech:さいご'));
      if (firstConv === -1) {
        // judge 裁定(2026-08-06 21:57): slot 優先/予約の条項は unit 層(check-voice-switcher.mjs・変異 armed 必須)へ委譲。
        // holdout は既測の外形だけを保持する。BLOCKED にはしない(exit 非 0 の保持対象から外す)
        note('AC-5 の「待機時は conversation が preview より先に slot を得る」は **unit 層へ委譲**(judge 裁定 21:57)。'
          + 'SpeechPlane の pump が直列なので 5 slot の奪い合いを公開面から作れず、作れるのは flaky な timing race だけ。'
          + `本検査は外形(Fish 全体 <= 5・preview 同時 <= 1)を保持する。観測 arrivals=${JSON.stringify(after).slice(0, 120)}`);
        ok(`外形のみ保持(maxConcurrent=${fishS.state.maxConcurrent} / preview 同時=${fishS.state.maxPreviewConcurrent})— 優先条項は unit 層へ委譲`);
        return;
      }
      assert.ok(firstPreview === -1 || firstConv < firstPreview,
        `待機時は conversation が preview より先に slot を得る契約: ${JSON.stringify(after).slice(0, 250)}`);
      ok(`conversation が先(conv=${firstConv} / preview=${firstPreview})`);
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  // judge 裁定 21:57 の条件 5(任意)。実装が pool と preview を同じ semaphore に通す形なら、
  // 「最後の 1 slot を preview が取らない」を **不在 → 出現** の決定的観測で拾える。
  // 形が違って観測できない時は note を残して緑のまま返す(flaky な赤を作らない — 裁定の理由 1)
  await step('AC-5 任意観測: 予約 slot(pool で塞ぎ、1 本解放しても preview が来ない)', async () => {
    const home = newHome('slot2'), port = await freePort();
    const fishR = fishFake(); const engR = engineFake();
    const f = await fishR.ready, e = await engR.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base, chloe: true });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.name === 'クロエ' && x.voice === 'ready');
      }, 30_000, 'クロエの voice:ready');
      const j = asJson(await get(port, '/voice/api/candidates?page=1', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const ids = items.filter((c) => c.provider === 'fish').map((c) => c.id);
      assert.ok(ids.length >= 2, `前提: fish 候補が 2 件以上(${ids.length})`);
      await waitSynthQuiet(fishR);

      fishR.state.holdMode = true;                       // ここから合成は門で止まる
      const sel = await selectCandidate(port, t, ids[0]); // pool 再構築で slot を埋める
      assert.ok(sel.status < 300, `前提: 選択が成功: ${sel.status} ${sel.text.slice(0, 150)}`);
      const saturated = await pollUntil(() => fishR.state.gates.length >= 5, 15_000, 'pool が 5 slot を埋める')
        .then(() => true).catch(() => false);
      if (!saturated) {
        note('AC-5 の予約 slot の決定的観測(judge 裁定 21:57 条件 5・任意)は **この実装形では観測できなかった** — '
          + `pool 再構築が Fish 同時実行 5 に達しない(最大 ${fishR.state.gates.length} 本)。優先条項は裁定どおり unit 層が受け持つ。`);
        ok(`観測不能(同時 ${fishR.state.gates.length} 本止まり)— 任意項目なので緑のまま`);
        return;
      }

      const previewCount = () => fishR.state.ttsRequests.filter((r) => r.body?.text === PREVIEW_TEXT).length;
      const p0 = previewCount();
      const pv = post(port, '/voice/api/preview', { candidateId: ids[1] }, t).catch(() => null);
      await sleep(1500);
      assert.equal(previewCount(), p0, `満杯の間は preview を Fish に出さない: ${previewCount() - p0} 件`);
      fishR.releaseGates(1);                             // 1 slot 空く = 予約分だけ
      await sleep(1800);
      assert.equal(previewCount(), p0,
        `**最後の 1 slot は conversation 用に残す契約** — 1 本解放しただけで preview が入った(${previewCount() - p0} 件)`);
      fishR.releaseGates(1);                             // 2 本目 = 予約の外側が空く
      await sleep(2000);
      const came = previewCount() > p0;
      if (!came) {
        note('AC-5 予約 slot: 「1 本解放では入らない」は実測できたが、「2 本目の解放で入る」は観測できなかった'
          + '(conversation が全部捌けるまで preview を通さない、より厳しい実装形。契約は満たしている)。');
      }
      fishR.releaseAll();
      await pv;
      ok(`満杯で 0 件・1 本解放でも 0 件${came ? '・2 本目解放で到達' : '(2 本目でも来ない = より厳しい実装形)'}`);
    } finally { fishR.releaseAll(); await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-9 (b) 試聴失敗は音を出さず、通常会話の Fish cooldown を汚さない', async () => {
    const home = newHome('pvfail'), port = await freePort();
    const fishP = fishFake(); const engP = engineFake();
    const f = await fishP.ready, e = await engP.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const ids = items.filter((c) => c.provider === 'fish').map((c) => c.id);
      const who = asJson(await post(port, '/join', { requestedName: '対照', voice: 'まい/ノーマル' }, t));
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.participantId === who.participantId && x.voice === 'ready');
      }, 20_000, 'engine ready');
      // 陽性対照: 汚染前は会話が Fish に届く
      const base0 = fishP.state.ttsRequests.length;
      await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'よごれるまえ。' }, t);
      await pollUntil(() => fishP.state.ttsRequests.length > base0, 8000, '汚染前の会話が Fish に届く');

      fishP.state.ttsStatus = 404;
      const pv = await post(port, '/voice/api/preview', { candidateId: ids[0] }, t);
      assert.ok(pv.status >= 400, `試聴の 404 は非 2xx で返す契約(音を出さない): ${pv.status}`);
      assert.ok(pv.headers['content-type'] === undefined || !String(pv.headers['content-type']).startsWith('audio/'),
        `試聴失敗時にローカル音声を流さない契約(audio が返っている): ${pv.headers['content-type']}`);
      fishP.state.ttsStatus = 200;

      const n1 = fishP.state.ttsRequests.length;
      await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'よごれたあと。' }, t);
      await pollUntil(() => fishP.state.ttsRequests.length > n1, 8000,
        '試聴の 404 が通常会話の cooldown を汚していない(会話が Fish に届く)');
      ok('preview 404 → 音 0・会話は Fish 継続');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await killRoom(roomA); fA.close(); eA.close();

  // ========================================================================
  // 部屋 E: クロエ在室(cutover / provider 切替 / 永続化 / outage)
  // ========================================================================
  const fishE = fishFake(); const engE = engineFake();
  const fE = await fishE.ready, eE = await engE.ready;
  const homeE = newHome('e'), portE = await freePort();
  let roomE = startRoom({ home: homeE, port: portE, fishBase: fE.base, engineBase: eE.base, chloe: true });
  let tokenE = '', chloeId = '', workerWho = null, candE = { fish: [], local: [] };

  // 「クロエ由来の合成」= 私が /speak した文でも試聴文でもない合成(= ack/filler pool)。
  // 文言を焼き込まずに識別する。
  const myTexts = new Set();
  const chloeSynth = (fish) => fish.state.ttsRequests.filter((r) => r.body?.text !== PREVIEW_TEXT && !myTexts.has(r.body?.text));

  await step('setup E(クロエ在室・pool 合成が起きていること)', async () => {
    await waitHealthy(roomE);
    tokenE = tokenOf(homeE);
    const parts = await pollUntil(async () => {
      const p = asJson(await get(portE, '/participants', tokenE));
      return p?.participants?.some((x) => x.name === 'クロエ' && x.voice === 'ready') ? p : null;
    }, 30_000, 'クロエの voice:ready');
    chloeId = parts.participants.find((x) => x.name === 'クロエ').participantId;
    await pollUntil(() => chloeSynth(fishE).length >= 1, 20_000,
      'クロエの ack/filler pool が合成される(これが無いと AC-6/AC-7 が空振りする)');
    const j = asJson(await get(portE, '/voice/api/candidates', tokenE));
    const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
    candE.fish = items.filter((c) => c.provider === 'fish').map((c) => c.id);
    candE.local = items.filter((c) => c.provider === 'local');
    assert.ok(candE.fish.length >= 2 && candE.local.length >= 1, `前提: fish ${candE.fish.length} 件・local ${candE.local.length} 件`);
    workerWho = asJson(await post(portE, '/join', { requestedName: '作業係テスト', voice: 'まい/ノーマル' }, tokenE));
    ok(`クロエ=${chloeId} / pool 合成 ${chloeSynth(fishE).length} 件`);
  });

  // ======== test seam `__chloesay__`(judge 裁定 2026-08-06 21:24)の検査 ========
  let seamWorks = false;
  await step('seam 陽性: __chloesay__ が本番経路でクロエの turn を作る', async () => {
    const sentences = ['しーむいちぶんめ。', 'しーむにぶんめ。', 'しーむさんぶんめ。'];
    sentences.forEach((t) => myTexts.add(t));
    const cursor = await lastEventId(portE, tokenE);
    const n0 = fishE.state.ttsRequests.length;
    const m0 = lines(homeE, 'metrics.jsonl').length;
    const res = await chloeSay(portE, tokenE, sentences.join(''));
    assert.ok(res.status < 400, `seam 付き /chat は通常どおり 2xx: ${res.status} ${res.text.slice(0, 150)}`);
    const got = await pollUntil(async () => {
      const evs = await readEvents(portE, tokenE, cursor, 1500);
      const sp = evs.filter((e) => e.type === 'agent_speech' && e.name === 'クロエ');
      return sp.length ? sp : null;
    }, 25_000, 'クロエの agent_speech が出る(= __chloesay__ seam が実装されている)');
    const body = got.map((e) => e.text).join('');
    assert.ok(!body.includes('__chloesay__'), `マーカーは応答本文に出ない: ${body.slice(0, 80)}`);
    assert.ok(sentences.every((t) => body.includes(t.replace('。', ''))),
      `応答本文はマーカー後の本文と一致する契約: ${body.slice(0, 120)}`);
    assert.ok(got.every((e) => e.turnId && e.turnId !== 'none'), `turnId が実値の契約: ${got.map((e) => e.turnId).join(',')}`);
    const jobs = fishE.state.ttsRequests.slice(n0).filter((r) => sentences.includes(r.body?.text));
    assert.equal(jobs.length, 3, `1 文 = 1 job で 3 request の契約: ${jobs.length} 件`);
    const metrics = lines(homeE, 'metrics.jsonl').slice(m0).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    assert.ok(metrics.some((m) => m.kind === 'turn_created'), `metrics に turn_created: ${JSON.stringify(metrics).slice(0, 200)}`);
    const ready = metrics.filter((m) => m.kind === 'tts_ready');
    assert.ok(ready.length >= 1 && ready.every((m) => typeof m.tts === 'string'),
      `metrics の tts_ready に tts 軸: ${JSON.stringify(ready).slice(0, 200)}`);
    seamWorks = true;
    ok(`agent_speech ${got.length} 件 / job 3 件 / turnId=${got[0].turnId} / tts=${ready[0].tts}`);
  });

  await step('seam 陰性: ROOM_TEST_HOOKS 無しではマーカーを解釈しない', async () => {
    const home = newHome('nohook'), port = await freePort();
    const fishN = fishFake(); const engN = engineFake();
    const f = await fishN.ready, e = await engN.ready;
    // hooks を明示的に外した部屋(mutatedEnv の no-hooks と同じ状態を常に作る)
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base, chloe: true, extraEnv: { ROOM_TEST_HOOKS: '' } });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.name === 'クロエ' && x.voice === 'ready');
      }, 30_000, 'クロエの voice:ready');
      const marker = 'ふっくにおちるはずのほんぶん。';
      const cursor = await lastEventId(port, t);
      const n0 = fishN.state.ttsRequests.length;
      const res = await chloeSay(port, t, marker);
      assert.ok(res.status < 400, `hooks 無しでも /chat 自体は 200(通常 chat): ${res.status}`);
      await sleep(6000);
      const evs = await readEvents(port, t, cursor, 1500);
      assert.ok(evs.length > 0, '前提: SSE から event を読めている(0 件なら下の「発話 0」が空振り)');
      const spoke = evs.filter((e) => e.type === 'agent_speech' && (e.text ?? '').includes(marker.replace('。', '')));
      assert.equal(spoke.length, 0, `hooks 無しでマーカー後本文を発話しない契約: ${JSON.stringify(spoke).slice(0, 200)}`);
      const sent = fishN.state.ttsRequests.slice(n0).filter((r) => (r.body?.text ?? '').includes(marker.replace('。', '')));
      assert.equal(sent.length, 0, `hooks 無しで本文が Fish に行かない契約: ${sent.length} 件`);
      const user = evs.filter((e) => e.type === 'user_speech');
      assert.ok(user.some((e) => (e.text ?? '').includes('__chloesay__')),
        `前提: user_speech は通常どおり記録される(= /chat 自体は届いている)。届いていないなら上の 0 件は空振り: ${JSON.stringify(user).slice(0, 200)}`);
      ok('user_speech は記録・クロエ発話 0・Fish 0');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('seam memo 到達不能: hooks 有効でも memo 経由では発火しない', async () => {
    const marker = 'めもけいゆではっかしないほんぶん。';
    const cursor = await lastEventId(portE, tokenE);
    const n0 = fishE.state.ttsRequests.length;
    const before = lines(homeE, 'memo-log.jsonl').length;
    const say = await post(portE, '/memo/api/say', {
      text: CHLOESAY + marker, clientMessageId: `voice-holdout-memo-${Date.now()}`,
    }, tokenE);
    if (say.status >= 400) {
      blocked(`memo の受け口に届かないので「memo 経由で発火しない」を測れない: ${say.status} ${say.text.slice(0, 150)}`);
      return;
    }
    // 陽性対照 — memo 自体は通常どおり通っている(通っていなければ下の 0 件は空振り)
    await pollUntil(() => lines(homeE, 'memo-log.jsonl').length > before, 8000,
      '前提: memo 自体は通常どおり記録される');
    await sleep(6000);
    const evs = await readEvents(portE, tokenE, cursor, 1500);
    assert.ok(evs.length > 0, '前提: SSE から event を読めている(0 件なら下の「発話 0」が空振り)');
    const spoke = evs.filter((e) => e.type === 'agent_speech' && e.name === 'クロエ' && (e.text ?? '').includes(marker.replace('。', '')));
    assert.equal(spoke.length, 0, `memo 経由ではクロエが発話しない契約(縛り 2): ${JSON.stringify(spoke).slice(0, 200)}`);
    const sent = fishE.state.ttsRequests.slice(n0).filter((r) => (r.body?.text ?? '').includes(marker.replace('。', '')));
    assert.equal(sent.length, 0, `memo 経由の本文が Fish に行かない契約: ${sent.length} 件`);
    ok('memo は記録・クロエ発話 0・Fish 0');
  });

  // ---- select の body 形は G1 に無い。preview と同じ {candidateId} を正とし、駄目なら形を探す ----
  async function selectCandidate(port, token, id) {
    const shapes = [{ candidateId: id }, { id }, { candidateId: id, provider: 'fish' }];
    let last;
    for (const b of shapes) {
      const res = await post(port, '/voice/api/select', b, token);
      assertRouteExists(res, '/voice/api/select');
      if (res.status !== 400) return res;
      last = res;
    }
    return last;
  }

  await step('AC-8 select → voice.json が 0600・schema・key 0 件・revision 単調', async () => {
    const target = candE.fish[0];
    const res = await selectCandidate(portE, tokenE, target);
    assert.ok(res.status >= 200 && res.status < 300, `選択は 2xx の契約: ${res.status} ${res.text.slice(0, 200)}`);
    const j = asJson(res);
    assert.ok(Number.isFinite(j?.revision), `応答は現在の revision を示す契約: ${res.text.slice(0, 200)}`);
    const p = statePath(homeE, 'voice.json');
    assert.ok(existsSync(p), 'persist の成功が commit point(voice.json が無い)');
    assert.equal(mode(p), 0o600, `voice.json の mode は 0600: ${mode(p).toString(8)}`);
    const v = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(v.version, 1, `version:1 の契約: ${JSON.stringify(v).slice(0, 150)}`);
    assert.ok(Number.isFinite(v.revision), 'revision が無い');
    assert.equal(v.selection?.provider, 'fish', `selection.provider=fish: ${JSON.stringify(v.selection)}`);
    assert.equal(rawId(v.selection?.id), rawId(target), `selection.id は選んだ候補(${target}): ${JSON.stringify(v.selection)}`);
    assert.ok(!scanFor(readFileSync(p, 'utf8')), 'voice.json に API キーが 0 件の契約');
    const rev1 = v.revision;
    const res2 = await selectCandidate(portE, tokenE, candE.fish[1]);
    const v2 = JSON.parse(readFileSync(p, 'utf8'));
    assert.ok(v2.revision > rev1, `revision は単調増加: ${rev1} → ${v2.revision}`);
    assert.equal(asJson(res2)?.revision, v2.revision, '応答の revision が現在値と一致する契約');
    ok(`revision ${rev1} → ${v2.revision} / 0600 / key 0`);
  });

  // id 空間の食い違いはここ 1 本だけで赤くする(他の検査は rawId で正規化してある)
  await step('AC-8 一覧の id と voice.json / reference_id の id が同じ空間にある', async () => {
    const target = candE.fish[0];
    const res = await selectCandidate(portE, tokenE, target);   // この step の中で選び直して比べる
    assert.ok(res.status < 300, `前提: 選択が成功している: ${res.status} ${res.text.slice(0, 150)}`);
    const v = JSON.parse(readFileSync(statePath(homeE, 'voice.json'), 'utf8'));
    const sentRef = fishE.state.ttsRequests.map((r) => r.body?.reference_id).filter(Boolean).slice(-1)[0];
    assert.ok(rawId(v.selection?.id) === rawId(target), `前提: 選択自体は成立している: ${JSON.stringify(v.selection)}`);
    assert.equal(v.selection.id, target,
      `一覧が返す id(${target})と voice.json の id(${v.selection.id})が別物。`
      + 'AC-7「body の reference_id が選択した id と exact 一致」が字義どおりには成立せず、'
      + '一覧 → 選択 → 状態ファイルの往復を client が id で照合できない。'
      + `どちらかに揃える必要がある(参考: 直近の送信 reference_id=${sentRef})`);
    ok(`id 空間が一致(${target})`);
  });

  await step('AC-8 同時 select 2 件は直列化され revision が単調', async () => {
    const p = statePath(homeE, 'voice.json');
    const before = JSON.parse(readFileSync(p, 'utf8')).revision;
    const [r1, r2] = await Promise.all([
      selectCandidate(portE, tokenE, candE.fish[2]),
      selectCandidate(portE, tokenE, candE.fish[3]),
    ]);
    const revs = [asJson(r1)?.revision, asJson(r2)?.revision].filter(Number.isFinite);
    assert.equal(revs.length, 2, `同時 select は 2 件とも revision を返す: ${r1.status}/${r2.status}`);
    assert.equal(new Set(revs).size, 2, `到着順に直列化され revision が重複しない: ${revs.join(',')}`);
    const after = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(after.revision, Math.max(...revs), `file の revision は最後の select と一致: ${after.revision} vs ${Math.max(...revs)}`);
    assert.ok(after.revision > before, 'revision は単調増加');
    ok(`${before} → ${revs.join(' / ')}`);
  });

  await step('AC-6 選択 commit で旧 pool が失効し、新 pool は新しい声で作られる', async () => {
    const target = candE.fish[4];
    await waitSynthQuiet(fishE);                                 // 前の選択の pool 再構築を先に着地させる
    const seenBefore = new Set(chloeSynth(fishE).map((r) => rawId(r.body?.reference_id)));
    const mark = fishE.state.ttsRequests.length;
    const res = await selectCandidate(portE, tokenE, target);
    assert.ok(res.status < 300, `前提: 選択が成功している: ${res.status}`);
    const fresh = await pollUntil(() => {
      const rows = fishE.state.ttsRequests.slice(mark)
        .filter((r) => r.body?.text !== PREVIEW_TEXT && !myTexts.has(r.body?.text));
      return rows.length ? rows : null;
    }, 20_000, '選択後にクロエの pool が新しい声で作り直される(AC-6「new pool ができるまで旧音を流さない」の前提)');
    const refs = new Set(fresh.map((r) => rawId(r.body?.reference_id)));
    assert.deepEqual([...refs], [rawId(target)], `選択後の pool 合成は新しい reference(${target})のみ: ${[...refs].join(',')}`);
    assert.ok(!refs.has(ENV_REF), '旧 pool の声(env 既定)で作り直していない');
    ok(`旧 ${[...seenBefore].join(',')} → 新 ${target}(${fresh.length} 件)`);
  });

  await step('AC-6 作業係の provider / speaker と既存 queue は不変', async () => {
    const text = 'さぎょうがかりのこえはかわらない。';
    myTexts.add(text);
    const n0 = fishE.state.ttsRequests.length;
    await pollUntil(async () => {
      const p = asJson(await get(portE, '/participants', tokenE));
      return p?.participants?.some((x) => x.participantId === workerWho.participantId && x.voice === 'ready');
    }, 20_000, '作業係テストの voice:ready');
    await post(portE, '/speak', { participantId: workerWho.participantId, sessionId: workerWho.sessionId, text }, tokenE);
    const mine = await pollUntil(() => fishE.state.ttsRequests.slice(n0).find((r) => r.body?.text === text), 10_000,
      '他 participant の発話が Fish に届く(届かないと不変判定が空振りする)');
    assert.equal(mine.body.reference_id, ENV_REF,
      `適用対象はクロエだけ。他 participant は env 既定(${ENV_REF})のまま: ${mine.body.reference_id}`);
    ok(`他 participant reference=${mine.body.reference_id}`);
  });

  await step('AC-6 turn snapshot(turn A=old / turn B=new・mid-turn 混在 0)', async () => {
    if (!seamWorks) { blocked('__chloesay__ seam(judge 裁定 21:24)が未実装なので turn を起こせない'); return; }
    const oldRef = candE.fish[10], newRef = candE.fish[11];
    assert.ok(oldRef && newRef, `前提: 候補が 12 件以上ある(${candE.fish.length})`);
    const A = ['えーわんのぶん。', 'えーつーのぶん。', 'えーすりーのぶん。'];
    const B = ['びーわんのぶん。', 'びーつーのぶん。'];
    [...A, ...B].forEach((t) => myTexts.add(t));

    await waitSynthQuiet(fishE);
    const r0 = await selectCandidate(portE, tokenE, oldRef);
    assert.ok(r0.status < 300, `前提: old の選択が成功: ${r0.status} ${r0.text.slice(0, 150)}`);
    await waitSynthQuiet(fishE);                                   // old pool の再構築を着地させる

    // turn A を走らせ、A1 が合成中(Fish で hold)のところで new に切り替える
    let release; fishE.state.ttsHold = new Promise((r) => { release = r; });
    const mark = fishE.state.ttsRequests.length;
    const chat = await chloeSay(portE, tokenE, A.join(''));
    assert.ok(chat.status < 400, `turn A の /chat は 2xx: ${chat.status}`);
    await pollUntil(() => fishE.state.ttsRequests.slice(mark).some((r) => r.body?.text === A[0]), 20_000,
      'turn A の 1 文目が Fish に到達(= A1 合成中)');
    const r1 = await selectCandidate(portE, tokenE, newRef);
    assert.ok(r1.status < 300, `合成中でも選択は受け付ける契約(次 turn から適用): ${r1.status} ${r1.text.slice(0, 150)}`);
    release(); fishE.state.ttsHold = null;

    await pollUntil(() => A.every((t) => fishE.state.ttsRequests.some((r) => r.body?.text === t)), 25_000,
      'turn A の全 job が Fish に到達(合成中/queue 済みの turn を cancel しない契約)');
    const aRefs = new Set(A.map((t) => rawId(fishE.state.ttsRequests.find((r) => r.body?.text === t).body.reference_id)));
    assert.deepEqual([...aRefs], [rawId(oldRef)],
      `turn A の全 job が old snapshot(${oldRef})。混在: ${[...aRefs].join(',')}`);

    // turn B は new snapshot
    const markB = fishE.state.ttsRequests.length;
    const chatB = await chloeSay(portE, tokenE, B.join(''));
    assert.ok(chatB.status < 400, `turn B の /chat は 2xx: ${chatB.status}`);
    await pollUntil(() => B.every((t) => fishE.state.ttsRequests.slice(markB).some((r) => r.body?.text === t)), 25_000,
      'turn B の全 job が Fish に到達');
    const bRefs = new Set(B.map((t) => rawId(fishE.state.ttsRequests.slice(markB).find((r) => r.body?.text === t).body.reference_id)));
    assert.deepEqual([...bRefs], [rawId(newRef)],
      `turn B の全 job が new snapshot(${newRef})。混在: ${[...bRefs].join(',')}`);
    ok(`A(3 job)=${[...aRefs].join(',')} / B(2 job)=${[...bRefs].join(',')}`);
  });

  await step('AC-7 Fish → local → Fish(再起動なしで次の合成に反映)', async () => {
    const localCand = candE.local[0];
    await waitSynthQuiet(fishE);
    const localSpeakerId = rawId(localCand.id);
    // --- local を選ぶ ---
    const engBefore = engE.state.synth;
    const fishBefore = fishE.state.ttsRequests.length;
    const r1 = await selectCandidate(portE, tokenE, localCand.id);
    assert.ok(r1.status < 300, `local 候補の選択は 2xx: ${r1.status} ${r1.text.slice(0, 150)}`);
    await pollUntil(() => engE.state.synth > engBefore, 20_000,
      'local を選んだら次の合成はローカル engine に行く(pool 再構築で観測)');
    const addedFish = fishE.state.ttsRequests.slice(fishBefore).filter((r) => r.body?.text !== PREVIEW_TEXT && !myTexts.has(r.body?.text));
    assert.equal(addedFish.length, 0, `local を選んだ turn は Fish request 0 の契約: ${addedFish.length} 件`);
    const q = engE.state.requests.filter((r) => r.url.startsWith('/audio_query')).slice(-1)[0];
    assert.ok(q && q.url.includes(localSpeakerId), `指定 local speaker(${localSpeakerId})で合成する契約: ${q?.url}`);
    const v1 = JSON.parse(readFileSync(statePath(homeE, 'voice.json'), 'utf8'));
    assert.equal(v1.selection?.provider, 'local', `selection は local: ${JSON.stringify(v1.selection)}`);
    assert.equal(rawId(v1.selection?.speakerId ?? v1.selection?.id), localSpeakerId, `speakerId を保つ契約: ${JSON.stringify(v1.selection)}`);

    // --- Fish に戻す ---
    const back = candE.fish[5];
    await waitSynthQuiet(fishE);
    const mark = fishE.state.ttsRequests.length;
    const r2 = await selectCandidate(portE, tokenE, back);
    assert.ok(r2.status < 300, `Fish 候補に戻す選択は 2xx: ${r2.status}`);
    const rows = await pollUntil(() => {
      const rs = fishE.state.ttsRequests.slice(mark).filter((r) => r.body?.text !== PREVIEW_TEXT && !myTexts.has(r.body?.text));
      return rs.length ? rs : null;
    }, 20_000, 'Fish に戻したら次の合成が Fish に行く');
    assert.ok(rows.every((r) => rawId(r.body.reference_id) === rawId(back)),
      `reference_id が選択した id(${back})と一致: ${[...new Set(rows.map((r) => r.body.reference_id))].join(',')}`);
    ok(`fish → local(speaker ${localSpeakerId})→ fish(${back})`);
  });

  await step('AC-9 (d) 選択後の通常 TTS 503 → desired 保持 + local fallback + transcript は残る', async () => {
    const home = newHome('outage'), port = await freePort();
    const fishO = fishFake(); const engO = engineFake();
    const f = await fishO.ready, e = await engO.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const j = asJson(await get(port, '/voice/api/candidates', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const target = items.find((c) => c.provider === 'fish')?.id;
      const sel = await selectCandidate(port, t, target);
      assert.ok(sel.status < 300, `前提: 選択が成功: ${sel.status}`);
      const who = asJson(await post(port, '/join', { requestedName: 'ダウン検証', voice: 'まい/ノーマル' }, t));
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.participantId === who.participantId && x.voice === 'ready');
      }, 20_000, 'engine ready');
      fishO.state.ttsStatus = 503;
      const text = 'ふぃっしゅがおちているときのはつわ。';
      const tr0 = lines(home, 'transcript.jsonl').length;
      const eng0 = engO.state.synth;
      await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text }, t);
      await pollUntil(() => engO.state.synth > eng0, 15_000, 'PBI-007 の規則で local fallback して音が出る');
      await pollUntil(() => lines(home, 'transcript.jsonl').length > tr0, 8000, 'transcript に返答 text が残る(repo CLAUDE.md §2)');
      const after = JSON.parse(readFileSync(statePath(home, 'voice.json'), 'utf8'));
      assert.equal(rawId(after.selection?.id), rawId(target), `desired selection は保持する契約(${target}): ${JSON.stringify(after.selection)}`);
      const cj = asJson(await get(port, '/voice/api/candidates', t));
      const citems = Array.isArray(cj) ? cj : (cj?.items ?? cj?.candidates ?? []);
      assert.ok(citems.find((c) => rawId(c.id) === rawId(target))?.selected === true, '一覧の selected も desired のまま');
      ok('desired 保持 / local fallback / transcript 1 行');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await step('AC-8 valid file は再起動後に復元する', async () => {
    const target = candE.fish[7];
    await waitSynthQuiet(fishE);
    const sel = await selectCandidate(portE, tokenE, target);
    assert.ok(sel.status < 300, `前提: 選択が成功: ${sel.status} ${sel.text.slice(0, 150)}`);
    const revBefore = JSON.parse(readFileSync(statePath(homeE, 'voice.json'), 'utf8')).revision;
    await killRoom(roomE);
    roomE = startRoom({ home: homeE, port: portE, fishBase: fE.base, engineBase: eE.base, chloe: true });
    await waitHealthy(roomE);
    tokenE = tokenOf(homeE);
    const j = asJson(await get(portE, '/voice/api/candidates', tokenE));
    const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
    const restored = items.find((c) => c.selected === true);
    assert.ok(restored, '再起動後に選択が復元する契約(selected:true の候補が無い)');
    assert.equal(rawId(restored.id), rawId(target), `復元されたのは選んだ候補(${target}): ${restored.id}`);
    assert.equal(JSON.parse(readFileSync(statePath(homeE, 'voice.json'), 'utf8')).revision, revBefore, '再起動で revision を巻き戻さない');
    // 復元した声で実際に合成されるところまで見る
    const rows = await pollUntil(() => {
      const rs = chloeSynth(fishE);
      return rs.length ? rs.slice(-3) : null;
    }, 20_000, '再起動後もクロエの pool が合成される');
    assert.ok(rows.some((r) => rawId(r.body?.reference_id) === rawId(target)),
      `復元した選択(${target})で合成する契約: ${[...new Set(rows.map((r) => r.body?.reference_id))].join(',')}`);
    ok(`revision ${revBefore} / reference ${target}`);
  });

  await step('AC-8 persist 失敗時は non-2xx・memory も旧値のまま', async () => {
    const dir = join(homeE, '.talkingclaw');
    const before = JSON.parse(readFileSync(statePath(homeE, 'voice.json'), 'utf8'));
    chmodSync(dir, 0o500);                                                // temp write / rename を落とす
    try {
      const res = await selectCandidate(portE, tokenE, candE.fish[8]);
      assert.ok(res.status >= 400, `persist が落ちたら non-2xx の契約(画面だけ成功にしない): ${res.status} ${res.text.slice(0, 150)}`);
      const j = asJson(await get(portE, '/voice/api/candidates', tokenE));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const sel = items.find((c) => c.selected === true);
      assert.equal(rawId(sel?.id), rawId(before.selection.id), `失敗時は memory の現在選択も旧値: ${sel?.id} vs ${before.selection.id}`);
    } finally { chmodSync(dir, 0o700); }
    const after = JSON.parse(readFileSync(statePath(homeE, 'voice.json'), 'utf8'));
    assert.deepEqual(after, before, 'persist 失敗で file が壊れていない');
    ok('non-2xx / memory・file とも旧値');
  });

  await step('AC-8 secrets.env を書き換えない', async () => {
    const p = statePath(homeE, 'secrets.env');
    const content = `# holdout marker\nFISH_API_KEY=${SENTINEL}\n`;
    writeFileSync(p, content, { mode: 0o600 });
    const before = statSync(p).mtimeMs;
    await selectCandidate(portE, tokenE, candE.fish[9]);
    await sleep(400);
    assert.equal(readFileSync(p, 'utf8'), content, 'secrets.env を書き換えない契約');
    assert.equal(statSync(p).mtimeMs, before, 'secrets.env に触らない契約(mtime が動いた)');
    ok('内容・mtime とも不変');
  });

  // cooldown は部屋の状態を汚すうえ、直前の step が残した cooldown に自分が巻き込まれる。
  // **専用の部屋**で測る(step 間の汚染をゼロにする)
  await step('AC-9 (c) PBI-007 cooldown 中は Fish の選択を 503 で拒否し現在選択を変えない', async () => {
    const home = newHome('cool'), port = await freePort();
    const fishC = fishFake(); const engC = engineFake();
    const f = await fishC.ready, e = await engC.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base, chloe: true });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      await pollUntil(async () => {
        const p = asJson(await get(port, '/participants', t));
        return p?.participants?.some((x) => x.name === 'クロエ' && x.voice === 'ready');
      }, 30_000, 'クロエの voice:ready');
      const j = asJson(await get(port, '/voice/api/candidates?page=1', t));
      const items = Array.isArray(j) ? j : (j?.items ?? j?.candidates ?? []);
      const ids = items.filter((c) => c.provider === 'fish').map((c) => c.id);
      assert.ok(ids.length >= 2, `前提: fish 候補が 2 件以上(${ids.length})`);
      const seed = await selectCandidate(port, t, ids[0]);
      assert.ok(seed.status < 300, `前提: 現在選択を作れている: ${seed.status} ${seed.text.slice(0, 150)}`);
      await waitSynthQuiet(fishC);
      const beforeSel = JSON.parse(readFileSync(statePath(home, 'voice.json'), 'utf8'));

      fishC.state.ttsStatus = 401;                                        // 401 → PBI-007 では 10 分 cooldown
      const text = 'くーるだうんをおこす。';
      const n0 = fishC.state.ttsRequests.length;
      const sp = await chloeSay(port, t, text);
      assert.ok(sp.status < 400, `前提: seam 付き /chat が受理される: ${sp.status} ${sp.text.slice(0, 150)}`);
      await pollUntil(() => fishC.state.ttsRequests.slice(n0).some((r) => r.body?.text === text), 30_000,
        '前提: cooldown を起こす合成が Fish に届く(届かないと cooldown が発火せず検査が空振り)');
      await sleep(1500);
      fishC.state.ttsStatus = 200;

      // cooldown 中であることの陽性対照 — この間 Fish への通常合成は 0 件
      const n1 = fishC.state.ttsRequests.length;
      await chloeSay(port, t, 'くーるだうんちゅうのはつわ。');
      await sleep(2500);
      assert.equal(fishC.state.ttsRequests.length - n1, 0,
        `前提: cooldown 中なので Fish request 0(${fishC.state.ttsRequests.length - n1} 件送っている = cooldown 未発火)`);

      const res = await selectCandidate(port, t, ids[1]);
      assert.equal(res.status, 503, `cooldown 中の Fish 選択は 503 で拒否する契約: ${res.status} ${res.text.slice(0, 150)}`);
      const afterSel = JSON.parse(readFileSync(statePath(home, 'voice.json'), 'utf8'));
      assert.deepEqual(afterSel.selection, beforeSel.selection, '拒否時に現在の選択を変えない契約');
      assert.equal(afterSel.revision, beforeSel.revision, '拒否時に revision を進めない契約');
      ok('503 / 選択・revision とも不変(cooldown の陽性対照あり)');
    } finally { await killRoom(room); f.close(); e.close(); }
  });

  await killRoom(roomE); fE.close(); eE.close();

  // ---------------- AC-8 壊れた file / 未知 provider / 消滅 speaker ----------------
  for (const bad of [
    { tag: 'corrupt', body: '{ this is not json' },
    { tag: 'unknown-schema', body: JSON.stringify({ version: 99, selection: { provider: 'fish', id: 'x' } }) },
    { tag: 'unknown-provider', body: JSON.stringify({ version: 1, revision: 3, selection: { provider: 'martian', id: 'x' } }) },
    { tag: 'gone-speaker', body: JSON.stringify({ version: 1, revision: 3, selection: { provider: 'local', speakerId: 999999999, title: '消えた話者' } }) },
  ]) {
    await step(`AC-8 壊れた voice.json(${bad.tag})でも起動を止めず default へ fallback + 警告 1 行`, async () => {
      const home = newHome(`bad-${bad.tag}`), port = await freePort();
      mkdirSync(join(home, '.talkingclaw'), { recursive: true });
      writeFileSync(join(home, '.talkingclaw', 'voice.json'), bad.body, { mode: 0o600 });
      const fishB = fishFake(); const engB = engineFake();
      const f = await fishB.ready, e = await engB.ready;
      const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base, chloe: true });
      try {
        await waitHealthy(room);
        const t = tokenOf(home);
        const who = asJson(await post(port, '/join', { requestedName: 'フォールバック', voice: 'まい/ノーマル' }, t));
        await pollUntil(async () => {
          const p = asJson(await get(port, '/participants', t));
          return p?.participants?.some((x) => x.participantId === who.participantId && x.voice === 'ready');
        }, 25_000, 'engine ready');
        const text = `こわれた${bad.tag}のあとではつわ。`;   // 「。」は 1 つ(1 文 = 1 合成 job)
        const n0 = fishB.state.ttsRequests.length;
        await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text }, t);
        const row = await pollUntil(() => fishB.state.ttsRequests.slice(n0).find((r) => r.body?.text === text), 12_000,
          '壊れた file でも合成できる(= 現行 default へ fallback)');
        assert.equal(row.body.reference_id, ENV_REF, `PBI-007 の現行 default に落ちる契約: ${row.body.reference_id}`);
        // 文言は G1 で固定されていないので語彙は広めに取る。ただし「voice の話であること」は要求する
        const warn = room.output().split('\n').filter((l) => /voice\.json|声|voice/i.test(l)
          && /warn|警告|無視|壊|不正|invalid|ignore|fallback|既定|default|読めな|使わな/i.test(l));
        assert.ok(warn.length >= 1, `警告を 1 行出す契約。出力: ${room.output().slice(-400)}`);
        assert.equal(warn.length, 1, `警告は 1 行の契約: ${warn.length} 行(${warn.join(' / ').slice(0, 200)})`);
        ok(`fallback=${row.body.reference_id} / 警告 1 行`);
      } finally { await killRoom(room); f.close(); e.close(); }
    });
  }

  // ---------------- AC-11 voice-default-unchanged ----------------
  for (const withEnv of [true, false]) {
    await step(`AC-11 voice.json 無し × env ${withEnv ? '有' : '無'} で PBI-007 から不変`, async () => {
      const home = newHome(`def-${withEnv}`), port = await freePort();
      const fishD = fishFake(); const engD = engineFake();
      const f = await fishD.ready, e = await engD.ready;
      const room = startRoom({
        home, port, fishBase: f.base, engineBase: e.base, chloe: true,
        extraEnv: withEnv ? {} : { FISH_REFERENCE_ID: '' },
      });
      try {
        await waitHealthy(room);
        const t = tokenOf(home);
        assert.ok(!existsSync(statePath(home, 'voice.json')), '起動しただけで voice.json を作らない契約');
        const who = asJson(await post(port, '/join', { requestedName: '既定', voice: 'まい/ノーマル' }, t));
        await pollUntil(async () => {
          const p = asJson(await get(port, '/participants', t));
          return p?.participants?.some((x) => x.participantId === who.participantId && x.voice === 'ready');
        }, 25_000, 'engine ready');
        const text = `きていのはつわ-${withEnv}`;
        await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text }, t);
        const row = await pollUntil(() => fishD.state.ttsRequests.find((r) => r.body?.text === text), 12_000, '既定 provider で合成される');
        if (withEnv) assert.equal(row.body.reference_id, ENV_REF, `env 指定が有れば reference は env の値: ${row.body.reference_id}`);
        else assert.ok(!row.body.reference_id, `env 指定が無ければ reference は付かない: ${row.body.reference_id}`);
        assert.equal(row.headers.model, FREE_MODEL, `model header は PBI-007 のまま: ${row.headers.model}`);
        // 本 PBI 由来の upstream(候補一覧)は 0 件
        assert.equal(fishD.state.modelRequests.length, 0,
          `voice.json 無し・UI 未操作なら本 PBI 由来の upstream は 0 件: ${fishD.state.modelRequests.length} 件`);
        const metrics = lines(home, 'metrics.jsonl').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
        const ready = metrics.filter((m) => m.kind === 'tts_ready');
        if (ready.length) {
          assert.ok(ready.every((m) => typeof m.tts === 'string'), `metrics の tts 軸が PBI-007 のまま: ${JSON.stringify(ready[0])}`);
          assert.ok(ready.every((m) => m.path === undefined || ['room', 'memo'].includes(m.path)), 'path 軸は入力経路のまま');
        }
        ok(`reference=${row.body.reference_id ?? '(無し)'} / 候補 upstream 0 / metrics tts_ready ${ready.length} 件`);
      } finally { await killRoom(room); f.close(); e.close(); }
    });
  }

  // ---------------- AC-10 Playwright voice-panel-no-cover ----------------
  await step('AC-10 UI geometry(1440x900 / 390x844)', async () => {
    const pw = await resolvePlaywright();
    if (!pw.browser) {
      blocked(`playwright が launch できない(geometry を実測できない)。試した: ${pw.tried.slice(0, 3).join(' | ')}`
        + ' / 直し方: npx playwright install chromium、または PLAYWRIGHT_MODULE=<playwright/index.mjs> を指定');
      return;
    }
    const home = newHome('ui'), port = await freePort();
    const fishU = fishFake(); const engU = engineFake();
    const f = await fishU.ready, e = await engU.ready;
    const room = startRoom({ home, port, fishBase: f.base, engineBase: e.base });
    try {
      await waitHealthy(room);
      const t = tokenOf(home);
      const who = asJson(await post(port, '/join', { requestedName: '会話係', voice: 'まい/ノーマル' }, t));
      // 会話 40 行 + 最新は user 行
      for (let i = 0; i < 39; i++) {
        await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: `かいわ${i}ぎょうめ。` }, t);
      }
      const lastUser = `さいごのゆーざーはつげん-${Date.now()}`;
      await post(port, '/chat', { text: lastUser }, t);
      await sleep(800);

      for (const vp of [{ width: 1440, height: 900, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }]) {
        const ctx = await pw.browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        const consoleErrors = [];
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#log', { timeout: 15_000 });
        await page.waitForFunction((needle) => document.querySelector('#log')?.innerText.includes(needle), lastUser, { timeout: 15_000 })
          .catch(() => { throw new Error(`${vp.tag}: 最新の user 行が #log に出ない(会話の復元が前提)`); });

        // ---- 声 section への導線を「ユーザーが見つけられるか」で探す ----
        const CAND_MARK = 'ホールドアウトボイス1';
        const visible = async () => page.evaluate((mark) => document.body.innerText.includes(mark), CAND_MARK);
        if (!(await visible())) {
          const opened = await page.evaluate(() => {
            const hits = [];
            for (const el of document.querySelectorAll('button,[role="button"],summary,a,label,[data-panel],.nav *')) {
              const s = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.textContent ?? ''}`;
              if (/声|ボイス|voice|設定|せってい|⚙|歯車/i.test(s) && el.offsetParent !== null) hits.push(el);
            }
            window.__openers = hits;
            return hits.length;
          });
          for (let i = 0; i < Math.min(opened, 8); i++) {
            await page.evaluate((n) => window.__openers[n].click(), i).catch(() => {});
            await page.waitForTimeout(400);
            if (await visible()) break;
          }
        }
        assert.ok(await visible(),
          `${vp.tag}: 声 section への導線を画面から見つけられない(repo CLAUDE.md §1「ユーザーが操作できて初めて完成」)`);

        const m = await page.evaluate((mark) => {
          const area = (a, b) => {
            const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            return x * y;
          };
          const log = document.querySelector('#log');
          const logRect = log.getBoundingClientRect();
          // 候補行 = 候補 title を持つ最内側の要素。その祖先の scroll 容器と panel も含めて測る
          const rows = [...document.querySelectorAll('*')].filter((el) =>
            el.children.length === 0 && (el.textContent ?? '').includes(mark));
          // panel / 声 section は **CSS の position で同定しない**(markup が動くと scope ごと静かにずれ、
          // 空振りの緑になる。PBI-009 で #settings が .lane.nav → .lane.side へ移った時に実際に起きた)。
          // 構造で決める: 候補行を全部含む最小の祖先から上へ、**#log を含まない範囲**で伸ばす。
          const settingsBody = document.getElementById('settingsBody');
          let voice = rows[0];
          while (voice && voice !== document.body && !rows.every((r) => voice.contains(r))) voice = voice.parentElement;
          // 声 section = #settingsBody の直下(あれば)まで。無ければ #log を含む手前まで
          while (voice && voice.parentElement && voice.parentElement !== document.body
                 && !voice.parentElement.querySelector('#log')
                 && voice.parentElement !== settingsBody) voice = voice.parentElement;
          // panel = #log を含まない最大の祖先(= 声 section が載っている lane / パネル)
          let panel = voice;
          while (panel && panel.parentElement && panel.parentElement !== document.body
                 && !panel.parentElement.querySelector('#log')) panel = panel.parentElement;
          // list = 候補一覧の scroll 容器(voice 配下で溢れているもの)
          let list = [...(voice ? voice.querySelectorAll('*') : []), voice].find((el) => el && (() => {
            const st = getComputedStyle(el);
            return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2;
          })()) ?? null;
          const targets = [...rows, list, panel].filter((x) => x && x !== document.body);
          const overlap = targets.reduce((acc, el) => acc + area(el.getBoundingClientRect(), logRect), 0);
          const desc = (el) => !el ? '(none)' : el === document.body ? 'body'
            : `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
          const isScroller = (el) => {
            const st = getComputedStyle(el);
            return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2;
          };
          // census は **声 section 配下**(panel 配下ではない — panel には #settingsBody が同居しうる)
          const scrollers = voice && voice !== document.body
            ? [...voice.querySelectorAll('*'), voice].filter(isScroller)
            : [];
          // 声パネル配下だけを数えると、markup が動いた時に scope ごと静かにずれる。
          // **document 全体の scroller を allowlist で受ける**(新しい scroller が increment されたら赤)
          const docScrollers = [...document.querySelectorAll('*')].filter(isScroller).map((el) => ({
            desc: desc(el),
            hasCandidates: (el.textContent ?? '').includes(mark),
            isLog: el.id === 'log',
            isSettingsBody: el.id === 'settingsBody',
          }));
          const controls = voice && voice !== document.body
            ? [...voice.querySelectorAll('button,[role="button"],input,select,a')].filter((el) => el.offsetParent !== null)
            : [];
          const small = controls.map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && (r.height < 44 || r.width < 44))
            .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`);
          const longNamed = [...document.querySelectorAll('*')].filter((el) =>
            el.children.length === 0 && (el.textContent ?? '').length > 100);
          return {
            overlap,
            logH: logRect.height, vh: window.innerHeight,
            logInDom: !!log,
            hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            vOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            scrollerCount: scrollers.length,
            scrollerHasCandidates: scrollers.some((el) => (el.textContent ?? '').includes(mark)),
            panelDesc: desc(panel), voiceDesc: desc(voice), listDesc: desc(list),
            panelIsBody: !panel || panel === document.body || !voice || voice === document.body,
            controlCount: controls.length, rowCount: rows.length,
            docScrollers,
            settingsBodyInPanel: !!(panel && panel !== document.body && panel.querySelector('#settingsBody')),
            small,
            xss1: window.__xss1 ?? null, xss2: window.__xss2 ?? null,
            xssImg: document.querySelectorAll('img[src="x"]').length,
            xssLiteral: document.body.innerText.includes('onerror'),
            longNameAccessible: longNamed.every((el) => (el.getAttribute('title') ?? el.getAttribute('aria-label') ?? '').length > 0
              || (el.textContent ?? '').length > 100),
            panelBox: panel && panel !== document.body ? panel.getBoundingClientRect().toJSON() : null,
          };
        }, CAND_MARK);

        // panel が body まで遡ってしまうと scroller / 44px の検査が黙って空振りになる
        assert.ok(!m.panelIsBody,
          `${vp.tag}: 声 panel / section を同定できていない(body まで遡った)。この状態では scroller / 44px の検査が空振りする`);
        assert.ok(m.rowCount >= 3, `${vp.tag}: 前提: 候補行が 3 件以上見えている(${m.rowCount} 件)`);
        assert.ok(m.controlCount >= 2,
          `${vp.tag}: 前提: 声 section 内に操作できる control が 2 個以上ある(${m.controlCount} 個)。0 個だと 44px 検査が空振りする`);
        assert.equal(m.overlap, 0, `${vp.tag}: panel と #log の intersection area は常に 0(実測 ${Math.round(m.overlap)}px²)`);
        assert.ok(m.logInDom, `${vp.tag}: #log が DOM に残る契約`);
        assert.ok(m.logH >= m.vh * 0.35, `${vp.tag}: #log は >= 35dvh(実測 ${Math.round(m.logH)}px / ${m.vh}px = ${(m.logH / m.vh * 100).toFixed(1)}%)`);
        assert.ok(m.hOverflow <= 1, `${vp.tag}: 横 overflow 0(実測 ${m.hOverflow}px)`);
        // 「候補一覧だけが内部 scroll」= panel 内の scroller は高々 1 個、それは候補一覧、
        // かつ **panel を開いてもページ自体が縦に伸びない**(伸びると会話が押し出される)
        assert.ok(m.scrollerCount <= 1, `${vp.tag}: 声 panel 配下で内部 scroll する要素が候補一覧以外にもある(${m.scrollerCount} 個: ${m.docScrollers.map((d) => d.desc).join(', ')})`);
        if (m.scrollerCount === 1) assert.ok(m.scrollerHasCandidates, `${vp.tag}: 内部 scroll している要素が候補一覧でない`);
        // allowlist: 画面全体で溢れてよいのは 候補一覧 / #log / #settingsBody(PBI-009)だけ
        const strays = m.docScrollers.filter((d) => !d.hasCandidates && !d.isLog && !d.isSettingsBody);
        assert.deepEqual(strays.map((d) => d.desc), [],
          `${vp.tag}: allowlist(候補一覧 / #log / #settingsBody)の外に内部 scroller がある: ${strays.map((d) => d.desc).join(', ')}`);
        assert.ok(m.vOverflow <= 1, `${vp.tag}: 声 section を開いてもページ自体は縦に伸びない契約(実測 ${m.vOverflow}px)`);
        assert.deepEqual(m.small, [], `${vp.tag}: control は 44px touch target(小さいもの: ${m.small.join(',')})`);
        assert.equal(m.xss1, null, `${vp.tag}: remote title の img onerror が実行された`);
        assert.equal(m.xss2, null, `${vp.tag}: remote title の script が実行された`);
        assert.equal(m.xssImg, 0, `${vp.tag}: remote title から img 要素が生成された`);
        assert.ok(m.xssLiteral, `${vp.tag}: title は textContent で描画する契約(literal が見当たらない = 剥がされている疑い)`);
        assert.ok(m.longNameAccessible, `${vp.tag}: 長い候補名に accessible な full name が無い`);

        // 自動 open/close 0 — **どの引き金で閉じたかを名指しできるよう、3 つを別々に測る**
        const box0 = m.panelBox;
        const probePanel = () => page.evaluate((mark) => {
          const rows = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent ?? '').includes(mark));
          let panel = rows[0];
          while (panel && panel !== document.body && !rows.every((r) => panel.contains(r))) panel = panel.parentElement;
          while (panel && panel.parentElement && panel.parentElement !== document.body
                 && !panel.parentElement.querySelector('#log')) panel = panel.parentElement;
          const log = document.querySelector('#log');
          return {
            box: panel && panel !== document.body ? panel.getBoundingClientRect().toJSON() : null,
            logVisible: !!log && log.getBoundingClientRect().height > 0,
            visible: rows.length > 0,
          };
        }, CAND_MARK);

        // ① SSE 到着 + TTS 再生(agent_speech は audio 付きで届くので同じ引き金で両方が起きる)
        await post(port, '/speak', { participantId: who.participantId, sessionId: who.sessionId, text: 'えすえすいーとうちゃく。' }, t);
        await page.waitForTimeout(1500);
        const afterSse = await probePanel();
        assert.ok(afterSse.visible, `${vp.tag}: **SSE(agent_speech)到着だけ**で panel が閉じた`);
        assert.ok(afterSse.logVisible, `${vp.tag}: SSE 到着で #log が隠れた`);

        // ② 試聴エラー(上流 503)
        fishU.state.ttsStatus = 503;
        const clicked = await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /試聴|プレビュー|preview|▶/i.test(x.textContent ?? ''));
          if (b) { b.click(); return true; }
          return false;
        });
        await page.waitForTimeout(1800);
        fishU.state.ttsStatus = 200;
        const after = await probePanel();
        assert.ok(after.visible, `${vp.tag}: **試聴エラー**で panel が閉じた(試聴ボタンを押せた=${clicked})`);
        assert.ok(after.logVisible, `${vp.tag}: 試聴エラーで #log が隠れた`);
        if (box0 && after.box) {
          assert.ok(Math.abs(box0.top - after.box.top) < 2 && Math.abs(box0.height - after.box.height) < 2,
            `${vp.tag}: user click 以外で panel が動いた(${JSON.stringify(box0)} → ${JSON.stringify(after.box)})`);
        }
        assert.deepEqual(consoleErrors.filter((l) => !/favicon/i.test(l)), [], `${vp.tag}: console error 0`);
        ok(`${vp.tag}: overlap 0 / #log ${(m.logH / m.vh * 100).toFixed(0)}dvh / panel=${m.panelDesc} / list=${m.listDesc}`
          + ` / 画面全体の scroller=[${m.docScrollers.map((d) => d.desc).join(', ')}] / 44px OK / XSS 0`);
        await ctx.close();
      }
    } finally {
      await killRoom(room); f.close(); e.close();
      await pw.browser?.close();
    }
  });

  // ---------------- AC-12 real holdout(手動)----------------
  await step('AC-12 実 API holdout(ユーザー同席・手動)', async () => {
    blocked('実キー + ユーザー同席が要る手動検査。自動化しない(G1 のテスト設計どおり)。'
      + '手順: 公開日本語 2 声 + local 1 声 → 各 1 回試聴(上限内の 2 preview だけ)→ 選択 → 次 turn 発話 → 再起動。'
      + '判定: canplay 3/3 / reference_id 2/2 一致 / ユーザーが聞き分け / 再起動後に復元 / 実 request 数が voice-preview.jsonl と一致');
  });
} finally {
  for (const r of rooms) { try { await killRoom(r); } catch { /* 既に死んでいる */ } }
  const leaked = rooms.filter((r) => { try { process.kill(r.proc.pid, 0); return true; } catch { return false; } });
  if (leaked.length) console.error(`[後片付け] 停止できていない隔離部屋: ${leaked.map((r) => `${r.proc.pid}:${r.port}`).join(', ')}`);
  for (const h of tmpHomes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* 消せなくても検査結果には影響しない */ } }
  clearTimeout(watchdog);
}

// ============================ 集計 ============================
const pass = results.filter((r) => r.state === 'pass');
const fail = results.filter((r) => r.state === 'FAIL');
const blk = results.filter((r) => r.state === 'BLOCKED');
console.log('\n================ 集計 ================');
console.log(`pass ${pass.length} / FAIL ${fail.length} / BLOCKED ${blk.length}(BLOCKED は pass ではない)`);
for (const r of fail) console.log(`  FAIL    ${r.name}\n          ${r.detail}`);
for (const r of blk) console.log(`  BLOCKED ${r.name}\n          ${r.detail}`);
if (notes.length) { console.log('\n---- 契約への申告 ----'); notes.forEach((n) => console.log(`  * ${n}`)); }
if (MUTATE) console.log(`\n[負の対照] E2E_MUTATE=${MUTATE} で FAIL ${fail.length} 件。0 件なら検査が armed でない`);
process.exit(fail.length + blk.length === 0 ? 0 : 1);
