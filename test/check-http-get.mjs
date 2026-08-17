// GET の口が本当に届くかを、部屋を実際に起こして確かめる検査。
//
// **なぜこれが要るか（2026-08-15 に実際に踏んだ）**:
// room.ts の要求ハンドラは途中に `if (req.method !== 'POST') return json(res, 404)` を持つ。
// この行より後ろに GET の口を書くと **必ず 404** になるが、
//   - 型検査は通る
//   - ソースを読む検査（「/persona が在るか」）も通る
//   - 単体検査（純関数）も通る
// ので、**画面で開くまで誰も気づかない**。実際 `/persona`(PBI-021) と `/avatars`(PBI-022) の
// 両方がこの形で 404 のまま commit されていた。
//
// だからここでは「在るか」ではなく「**200 が返るか**」を見る。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 3390 + Math.floor(Math.random() * 8); // 他の検査と衝突しにくい所
const HOME = mkdtempSync(join(tmpdir(), 'claw-httpget-'));
mkdirSync(join(HOME, '.talkingclaw', 'avatars'), { recursive: true });
mkdirSync(join(HOME, '.talkingclaw', 'motions'), { recursive: true });
writeFileSync(join(HOME, '.talkingclaw', 'motions', 'dummy.vrma'), 'not a real vrma');
// 実物の VRM は要らない。**名前だけ**在れば一覧の口は検査できる（15MB を検査に持ち込まない）
writeFileSync(join(HOME, '.talkingclaw', 'avatars', 'dummy.vrm'), 'not a real vrm');
// PBI-032: 体はエージェントの名前で置く = **日本語のファイル名**が普通に来る
writeFileSync(join(HOME, '.talkingclaw', 'avatars', 'コハク.vrm'), 'not a real vrm either');

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const room = spawn(process.execPath, ['src/room.ts'], {
  cwd: REPO,
  env: { ...process.env, HOME, PORT: String(PORT), NO_CHLOE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
room.stdout.on('data', (d) => { log += d; });
room.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/health')).ok) { up = true; break; } } catch { /* まだ */ }
    await sleep(500);
  }
  if (!up) { fail('部屋が起動する', log.slice(-400)); } else {
    ok('部屋が起動する');
    const token = JSON.parse(readFileSync(join(HOME, '.talkingclaw', 'room.json'), 'utf8')).token;

    // GET の口: 200 が返ること（ここが今回の本体）
    for (const [name, path] of [['/persona', '/persona'], ['/avatars', '/avatars'], ['/vocab', '/vocab'], ['/motions', '/motions']]) {
      const r = await fetch(`${base}${path}?token=${token}`);
      if (r.status === 200) ok(`GET ${name} が 200 を返す`);
      else fail(`GET ${name} が 200 を返す`, `status=${r.status}（POST 専用ゲートの後ろに書いていないか）`);
    }

    const persona = await (await fetch(`${base}/persona?token=${token}`)).json();
    if (Array.isArray(Object.keys(persona.values ?? {})) && Object.keys(persona.values ?? {}).length === 9) ok('GET /persona が 9 軸を返す');
    else fail('GET /persona が 9 軸を返す', JSON.stringify(persona).slice(0, 120));

    const av = await (await fetch(`${base}/avatars?token=${token}`)).json();
    if (av.avatars?.includes('dummy.vrm')) ok('GET /avatars が置いたファイルを返す');
    else fail('GET /avatars が置いたファイルを返す', JSON.stringify(av).slice(0, 120));

    // PBI-029: 役ごとの声。role=narrator でも 200 が返り、**選択はクロエと別**であること
    for (const [name, q] of [['クロエ', ''], ['実況', '&role=narrator']]) {
      const r = await fetch(`${base}/voice/api/candidates?token=${token}${q}`);
      if (r.status === 200) ok(`GET /voice/api/candidates(${name}) が 200`);
      else fail(`GET /voice/api/candidates(${name}) が 200`, `status=${r.status}`);
    }
    {
      const a = await (await fetch(`${base}/voice/api/candidates?token=${token}`)).json();
      const b = await (await fetch(`${base}/voice/api/candidates?token=${token}&role=narrator`)).json();
      if (a.selection === null && b.selection === null) ok('どちらの役もまだ既定の声（選択なし）');
      else fail('どちらの役もまだ既定の声', JSON.stringify({ a: a.selection, b: b.selection }));
    }

    // 日本語名の体が配られること / 在らない名前と traversal は 404（列挙 allowlist）
    for (const [q, want, what] of [
      [encodeURIComponent('コハク.vrm'), 200, '日本語のファイル名の体が配られる'],
      [encodeURIComponent('居ない.vrm'), 404, '置いていない名前は 404'],
      ['..%2F..%2Fetc%2Fpasswd', 404, '外に出ようとする名前は 404'],
    ]) {
      const r = await fetch(`${base}/avatars/${q}?token=${token}`);
      if (r.status === want) ok(what);
      else fail(what, `status=${r.status}（期待 ${want}）`);
    }

    // token 無しは 401（読み取りの口も認証の内側に在ること）
    for (const path of ['/persona', '/avatars', '/vocab']) {
      const r = await fetch(base + path);
      if (r.status === 401) ok(`token 無しの ${path} は 401`);
      else fail(`token 無しの ${path} は 401`, `status=${r.status}`);
    }

    // import map の CSP ハッシュが **配信時に計算されていて実際の中身と一致する**
    // （手書きの固定ハッシュは map を直した瞬間に静かに壊れる）
    const html = await (await fetch(base + '/')).text();
    const body = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    if (body === undefined) fail('import map が配信 HTML に在る', 'importmap が無い');
    else {
      const { createHash } = await import('node:crypto');
      const want = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
      if (csp.includes(want)) ok('CSP の import map ハッシュが中身と一致する');
      else fail('CSP の import map ハッシュが中身と一致する', `期待 ${want} / CSP=${csp.slice(0, 120)}`);
      if (!csp.includes('__IMPORTMAP_HASH__')) ok('プレースホルダが置換されている');
      else fail('プレースホルダが置換されている', '__IMPORTMAP_HASH__ が残っている');
    }

    // vendor（import map の行き先）が実際に配られる
    for (const p of ['/vendor/three/build/three.module.js', '/vendor/@pixiv/three-vrm/lib/three-vrm.module.js', '/vendor/@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js', '/avatar.js']) {
      const r = await fetch(base + p);
      if (r.status === 200) ok(`${p} が配られる`);
      else fail(`${p} が配られる`, `status=${r.status}（npm install を実行したか）`);
    }
    for (const p of ['/vendor/express/index.js', '/vendor/three/package.json']) {
      const r = await fetch(base + p);
      if (r.status === 404) ok(`${p} は配らない`);
      else fail(`${p} は配らない`, `status=${r.status}`);
    }
  }
} finally {
  room.kill('SIGTERM');
  await sleep(300);
  try { room.kill('SIGKILL'); } catch { /* 既に死んでいる */ }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
