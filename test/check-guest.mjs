// PBI-035: **「入れる」と「何でもできる」を分けた**ことを、部屋を実際に起こして確かめる。
//
// 守るもの: ゲストは遊ぶ・話す・見るだけ / 他の部屋の会話が 1 行も来ない /
// ゲストの発話でホストの推論を使わない / 取り消したら 401 / ホストは今までどおり。
//
// **表で確かめる** —— 口を 1 つずつ、ホストとゲストの両方で叩いて 200 / 403 を並べる。
// 「危ないものを弾く」形だと、新しい口を足した人が忘れた瞬間に穴が開くので、
// allowlist（`src/guests.ts`）の側を検査する。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import * as fsSync from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guestAllows, issueGuest, findGuest, revokeGuest, guestSummary } from '../src/guests.ts';
import { hostAllowed, originAllowed, inviteHost, lanAddresses } from '../src/net.ts';
import { connect } from 'node:net';

const REPO = process.env.MOTION_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 3320 + Math.floor(Math.random() * 12);
const HOME = mkdtempSync(join(tmpdir(), 'claw-guest-'));

// Playwright と Chrome の在り処。**この機械の私物パスを書かない**（公開 repo なので、
// 他人の環境でも同じ手順で見つかる形にする）。無ければ検査は skip する
async function resolvePlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try { return await import(c); } catch { /* 次 */ }
  }
  try {
    const { readdirSync } = await import('node:fs');
    const npx = join(homedir(), '.npm', '_npx');
    for (const d of readdirSync(npx)) {
      try { return await import(join(npx, d, 'node_modules', 'playwright', 'index.mjs')); } catch { /* 次 */ }
    }
  } catch { /* 無ければ諦める */ }
  return null;
}

function chromePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const { existsSync, readdirSync } = fsSync;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ['chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* 既定に任せる */ }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                   '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    if (existsSync(p)) return p;
  }
  return undefined;   // playwright の既定に任せる
}

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const t = (n, f) => { try { f(); ok(n); } catch (e) { fail(n, e.message); } };
const truthy = (v, why) => { if (!v) throw new Error(why); };
const eq = (a, b, why) => { if (a !== b) throw new Error(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 純関数（部屋を起こさずに allowlist そのものを見る）----
t('遊ぶ・話す・見る は通る', () => {
  for (const [m, p] of [['GET', '/'], ['GET', '/room.js'], ['GET', '/avatar.js'], ['GET', '/events'],
    ['GET', '/avatars'], ['GET', '/motions/Dance.vrma'], ['GET', '/vendor/three/build/three.module.js'],
    ['GET', '/audio/1'], ['POST', '/chat'], ['POST', '/game'], ['POST', '/played']]) {
    truthy(guestAllows(m, p), `${m} ${p} が通らない`);
  }
});

t('ホストのものは通さない（1 つずつ）', () => {
  for (const [m, p] of [['GET', '/projects'], ['GET', '/files'], ['GET', '/transcript'], ['GET', '/settings'],
    ['GET', '/memory'], ['GET', '/vocab'], ['GET', '/inbox'], ['GET', '/uploads/x.png'], ['GET', '/screen'],
    ['POST', '/voice/api/select'], ['POST', '/settings'], ['POST', '/dict'], ['POST', '/speak'],
    ['POST', '/listen'], ['POST', '/join'], ['POST', '/leave'], ['POST', '/guests'], ['POST', '/task'],
    ['POST', '/plan'], ['POST', '/upload'], ['POST', '/vocab'], ['POST', '/channel'], ['POST', '/select'],
    ['DELETE', '/files'], ['PUT', '/settings']]) {
    truthy(!guestAllows(m, p), `${m} ${p} が通ってしまう`);
  }
});

t('prefix のすり抜けが無い', () => {
  truthy(!guestAllows('GET', '/vendor/../../etc/passwd'), '.. を含む path が通る');
  truthy(!guestAllows('GET', '/projectsX'), '似た名前が通る');
  truthy(!guestAllows('GET', '/audio'), 'prefix だけの裸 path が通る');
  truthy(guestAllows('GET', '/audio/12'), '本物の audio が通らない');
});

t('発行・照合・取り消し・期限', () => {
  const now = Date.parse('2026-08-16T00:00:00Z');
  const { file, guest } = issueGuest({ guests: [] }, { name: 'ともだち', channel: 'game', hours: 2, now });
  eq(findGuest(file, guest.token, now + 3600_000)?.name, 'ともだち', '期限内で照合できない');
  eq(findGuest(file, guest.token, now + 3 * 3600_000), null, '期限切れが通る');
  eq(findGuest(file, 'でたらめ', now), null, '知らない token が通る');
  eq(findGuest(revokeGuest(file, guest.id), guest.token, now), null, '取り消しが効かない');
  truthy(!JSON.stringify(guestSummary(file)).includes(guest.token), '一覧に token が出ている');
  truthy(guest.token.length >= 20, `token が短い(${guest.token.length})`);
});

// ---- PBI-036: どこまで出すか（純関数）----
t('Host は列挙一致だけ通す（DNS rebinding 対策を緩めない）', () => {
  const allowed = ['127.0.0.1', 'localhost', '192.168.1.31'];
  truthy(hostAllowed('127.0.0.1:3300', allowed), 'localhost が通らない');
  truthy(hostAllowed('192.168.1.31:3300', allowed), 'LAN の住所が通らない');
  truthy(hostAllowed('LOCALHOST', allowed), '大文字で外れる');
  truthy(!hostAllowed(undefined, allowed), 'Host 欠如が通る');
  truthy(!hostAllowed('evil.example.com', allowed), '知らない名前が通る');
  truthy(!hostAllowed('192.168.1.310', allowed), '前方一致で通る');
  truthy(!hostAllowed('192.168.1.32', allowed), '別の住所が通る');
  truthy(!hostAllowed('127.0.0.1.evil.com', allowed), '後ろに足した名前が通る');
});

t('Origin は在る時だけ見る（curl の欠如は許す＝従来どおり）', () => {
  const allowed = ['127.0.0.1', '192.168.1.31'];
  truthy(originAllowed(undefined, allowed, 3300), 'Origin 欠如を拒否している');
  truthy(originAllowed('http://192.168.1.31:3300', allowed, 3300), 'LAN の Origin が通らない');
  truthy(!originAllowed('http://evil.example.com:3300', allowed, 3300), '知らない Origin が通る');
  truthy(!originAllowed('http://127.0.0.1:9999', allowed, 3300), '別の port が通る');
});

t('招待リンクは繋がる住所で作る（嘘をつかない）', () => {
  eq(inviteHost('127.0.0.1', ['192.168.1.31']), '127.0.0.1', 'LAN に出していないのに LAN の住所を渡した');
  eq(inviteHost('0.0.0.0', ['192.168.1.31']), '192.168.1.31', 'LAN の住所を渡せていない');
  eq(inviteHost('0.0.0.0', []), '127.0.0.1', '住所が無い時に壊れる');
});

t('lanAddresses は内部 IF を出さない', () => {
  const a = lanAddresses();
  truthy(!a.includes('127.0.0.1'), 'loopback が混ざっている');
  truthy(a.every((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)), `IPv4 以外が混ざっている: ${a.join(',')}`);
});

// ---- 部屋を起こして、ホストとゲストで同じ口を叩く ----
const room = spawn(process.execPath, ['src/room.ts'], {
  cwd: REPO, env: { ...process.env, HOME, PORT: String(PORT), NO_CHLOE: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
});
const base = `http://127.0.0.1:${PORT}`;
try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) { up = true; break; } } catch { /* まだ */ } await sleep(500); }
  if (!up) { fail('部屋が起動する', 'health が返らない'); } else {
    const host = JSON.parse(readFileSync(join(HOME, '.talkingclaw', 'room.json'), 'utf8')).token;
    const post = (tk, path, body) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': tk }, body: JSON.stringify(body ?? {}),
    });
    const get = (tk, path) => fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${tk}`);

    const invited = await (await post(host, '/guests', { action: 'invite', name: 'ともだち', channel: 'game' })).json();
    const gt = invited.guest?.token;
    if (gt) ok(`AC-1 ゲストを招ける（${invited.guest.name} / ${invited.guest.channel}）`);
    else fail('AC-1 ゲストを招ける', JSON.stringify(invited).slice(0, 120));

    // AC-2: 遊ぶ・話す・見る は通る
    for (const p of ['/', '/room.js', '/participants', '/avatars', '/motions']) {
      const r = await get(gt, p);
      if (r.status === 200) ok(`AC-2 ゲストが ${p} を見られる`);
      else fail(`AC-2 ゲストが ${p} を見られる`, `status=${r.status}`);
    }
    const chat = await post(gt, '/chat', { text: 'こんにちは', immediate: true });
    if (chat.status === 200) ok('AC-2 ゲストが話せる');
    else fail('AC-2 ゲストが話せる', `status=${chat.status}`);

    // AC-3: ホストのものは 403（実際の口で 1 つずつ）
    for (const [m, p] of [['GET', '/projects'], ['GET', '/settings'], ['GET', '/transcript'], ['GET', '/vocab'],
      ['POST', '/settings'], ['POST', '/dict'], ['POST', '/guests'], ['POST', '/channel'], ['POST', '/speak']]) {
      const r = m === 'GET' ? await get(gt, p) : await post(gt, p, {});
      if (r.status === 403) ok(`AC-3 ゲストは ${m} ${p} を叩けない`);
      else fail(`AC-3 ゲストは ${m} ${p} を叩けない`, `status=${r.status}（403 のはず）`);
    }
    // ホストは今までどおり通る（AC-8）
    // ホスト側は**読み取りの口**で確かめる（/projects や /settings は POST 専用なので GET は 404 が正しい）
    for (const p of ['/vocab', '/persona', '/participants']) {
      const r = await get(host, p);
      if (r.status === 200) ok(`AC-8 ホストは ${p} を今までどおり見られる`);
      else fail(`AC-8 ホストは ${p} を今までどおり見られる`, `status=${r.status}`);
    }

    // PBI-040(重大): **ゲストの画面にホストの token を渡していないか**
    // ここが漏れると、鍵を分けた意味が丸ごと消える（画面が「ホストとして」全部叩ける）
    const guestHtml = await (await get(gt, '/')).text();
    if (!guestHtml.includes(host)) ok('ゲストの画面にホストの token が焼かれていない');
    else fail('ゲストの画面にホストの token が焼かれていない', '**ホストの鍵が漏れている**');
    if (guestHtml.includes(gt)) ok('ゲストの画面には自分の token が入っている');
    else fail('ゲストの画面には自分の token が入っている', 'token が入っていない（画面が動かない）');
    if (/name="room-role" content="guest"/.test(guestHtml)) ok('画面が起動時に「自分はゲスト」と分かる');
    else fail('画面が起動時に「自分はゲスト」と分かる', 'meta が無い');
    const hostHtml = await (await get(host, '/')).text();
    if (hostHtml.includes(host) && /content="host"/.test(hostHtml)) ok('ホストの画面は今までどおり');
    else fail('ホストの画面は今までどおり', 'ホストの画面が壊れた');

    // AC-4: 他の部屋の会話が来ない
    await post(host, '/chat', { text: 'これは作業部屋の秘密の話', immediate: true });
    await sleep(400);
    const ac = new AbortController();
    const evres = await fetch(`${base}/events?token=${gt}&after=0`, { signal: ac.signal });
    const reader = evres.body.getReader();
    let seen = '';
    const started = Date.now();
    while (Date.now() - started < 1500) {
      const { value, done } = await Promise.race([reader.read(), sleep(600).then(() => ({ value: null, done: true }))]);
      if (done) break;
      if (value) seen += Buffer.from(value).toString('utf8');
    }
    ac.abort();
    if (!seen.includes('秘密の話')) ok('AC-4 ゲストの目に、他の部屋の会話が来ない');
    else fail('AC-4 ゲストの目に、他の部屋の会話が来ない', '作業部屋の発話が流れている');
    if (seen.includes('こんにちは') || seen.length > 0) ok('AC-4 自分の部屋のイベントは届く');
    else fail('AC-4 自分の部屋のイベントは届く', '何も届かない');

    // AC-5: ゲストの発話は agent を起こさない —— **実際に流れたイベントを見る**
    // （「ok と書くだけ」の空の検査にしない。過去に 2 回やって痛い目を見ている）
    const guestEv = seen.split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter((e) => e && e.type === 'user_speech' && e.text === 'こんにちは')[0];
    if (guestEv && guestEv.from === 'guest' && Array.isArray(guestEv.targets) && guestEv.targets.length === 0) {
      ok('AC-5 ゲストの発話は targets 空 = agent を起こさない（実イベントで確認）');
    } else {
      fail('AC-5 ゲストの発話は targets 空 = agent を起こさない', JSON.stringify(guestEv ?? '該当イベントが無い').slice(0, 160));
    }
    if (guestEv?.name === 'ともだち') ok('AC-2 ゲストの名前が発話に載る');
    else fail('AC-2 ゲストの名前が発話に載る', JSON.stringify(guestEv?.name));

    // AC-6: 取り消したら 401
    const list = await (await post(host, '/guests', { action: 'list' })).json();
    const id = list.guests?.[0]?.id;
    await post(host, '/guests', { action: 'revoke', id });
    const after = await get(gt, '/participants');
    if (after.status === 401) ok('AC-6 取り消したゲストは 401');
    else fail('AC-6 取り消したゲストは 401', `status=${after.status}`);
    if (!JSON.stringify(list).includes(gt)) ok('一覧に token を出していない');
    else fail('一覧に token を出していない', 'token が漏れている');
  }
} finally {
  room.kill('SIGTERM');
  await sleep(300);
  try { room.kill('SIGKILL'); } catch { /* 既に死んでいる */ }
}

t('AC-1 導線: 招待の UI がホストの画面に在る', () => {
  const roomJs = readFileSync(join(REPO, 'public/room.js'), 'utf8');
  truthy(/招待リンクを作る/.test(roomJs), '招待のボタンが無い（API だけでは未完成）');
  truthy(/action: 'invite'/.test(roomJs) && /action: 'revoke'/.test(roomJs), '招く / 取り消す の両方の導線が無い');
  truthy(/遊ぶ・話す・見る.*だけ/.test(roomJs), '何を渡すのかが画面に書いていない');
  truthy(!/guests.*token/.test(roomJs.replace(/d\.url/g, '')), '一覧に token を出そうとしている');
  // PBI-036: **いまどこまで出しているか**が招待の場で分かる（黙って LAN に出ている状態を作らない）
  truthy(/d\.lan/.test(roomJs) && /ROOM_BIND=0\.0\.0\.0/.test(roomJs), '公開範囲が画面に出ていない');
});

t('AC-5 配線: ゲストの発話は targets 空で入る（Brain へ行かない）', () => {
  const src = readFileSync(join(REPO, 'src/room.ts'), 'utf8');
  truthy(/if \(guest\) \{[\s\S]{0,400}targets: \[\]/.test(src), 'ゲストの発話が agent を起こす経路に乗っている');
  truthy(/guestAllows\(req\.method \?\? 'GET', path\)/.test(src), 'allowlist を通していない');
  truthy(/!guest \|\| \(ev\.channel \?\? 'work'\) === guest\.channel/.test(src), 'イベントを部屋で絞っていない');
});

// ---- PBI-040: ゲストが実際に開いた画面（Playwright。無ければ skip）----
{
  const mod = await resolvePlaywright();
  if (!mod) {
    console.log('skip    - playwright が無い（ゲストの画面は測れない）');
  } else {
    const P4 = PORT + 90;
    const HOME4 = mkdtempSync(join(tmpdir(), 'claw-gui-'));
    // 卓を開くには進行役が要る（NO_CHLOE では遊べない）。鍵は空のまま = 推論ゼロ
    const room4 = spawn(process.execPath, ['src/room.ts'], {
      cwd: REPO,
      env: { ...process.env, HOME: HOME4, PORT: String(P4), ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let browser = null;
    try {
      let up4 = false;
      for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P4}/health`)).ok) { up4 = true; break; } } catch { /* まだ */ } await sleep(500); }
      if (!up4) { fail('AC-1 画面の部屋が起動する', '起動しない'); } else {
        const h4 = JSON.parse(readFileSync(join(HOME4, '.talkingclaw', 'room.json'), 'utf8')).token;
        const inv4 = await (await fetch(`http://127.0.0.1:${P4}/guests`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': h4 },
          body: JSON.stringify({ action: 'invite', name: 'たけし', channel: 'game' }),
        })).json();
        browser = await mod.chromium.launch({ executablePath: chromePath() });
        const hostUrl = `http://127.0.0.1:${P4}/?token=${h4}`;
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        const errs = [], bad4 = [];
        page.on('pageerror', (e) => errs.push(String(e).slice(0, 100)));
        page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 100)); });
        page.on('response', (r) => { if (r.status() >= 400) bad4.push(`${r.status()} ${new URL(r.url()).pathname}`); });
        await page.goto(inv4.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);
        const seen = await page.evaluate(() => ({
          room: document.getElementById('roomBtn')?.textContent?.trim() ?? '',
          guestClass: document.body.classList.contains('guest'),
          hostBtns: ['boardBtn', 'voiceBtn', 'settingsBtn', 'personaBtn', 'attachBtn']
            .filter((id) => document.getElementById(id)?.offsetParent).length,
          games: [...document.querySelectorAll('button')].filter((b) => /ポーカー|麻雀|ブラックジャック/.test(b.textContent)).length,
          composer: !!document.querySelector('#composer textarea, #composer input'),
        }));
        if (seen.room.includes('ゲーム')) ok(`AC-1 招かれた部屋に入っている（${seen.room}）`);
        else fail('AC-1 招かれた部屋に入っている', seen.room);
        if (seen.guestClass) ok('AC-2/3 画面がゲスト用になっている（body.guest）');
        else fail('AC-2/3 画面がゲスト用になっている', 'body.guest が付いていない');
        if (seen.hostBtns === 0) ok('AC-3 ホスト専用のボタンが 1 つも出ていない');
        else fail('AC-3 ホスト専用のボタンが 1 つも出ていない', `${seen.hostBtns} 個出ている`);
        if (errs.length === 0 && bad4.length === 0) ok('AC-4 console に 401/403 が 1 件も出ない');
        else fail('AC-4 console に 401/403 が 1 件も出ない', JSON.stringify([...errs, ...bad4]).slice(0, 160));
        if (seen.games === 3) ok('AC-6 遊ぶボタンは出る（麻雀・ポーカー・BJ）');
        else fail('AC-6 遊ぶボタンは出る', `${seen.games} 個`);
        if (seen.composer) ok('AC-6 話す口がある');
        else fail('AC-6 話す口がある', '入力欄が無い');

        // ---- PBI-042: 卓モード（3 ゲームとも同じ形） ----
        const say4 = async (text) => {
          await page.evaluate((t) => {
            const el = document.querySelector('#composer textarea, #composer input');
            el.value = t;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }, text);
          await sleep(1100);
        };
        for (const [game, open] of [['麻雀', '麻雀やろう'], ['ポーカー', 'ポーカーやろう'], ['ブラックジャック', 'ブラックジャックやろう']]) {
          await say4(open);
          await say4('配って');
          await sleep(900);
          const t = await page.evaluate(() => {
            const box = (id) => { const e = document.getElementById(id); const b = e?.getBoundingClientRect(); return b ? Math.round(b.height) : -1; };
            return {
              table: document.body.classList.contains('table'),
              log: box('log'), composer: box('composer'), board: box('gameList'),
              seats: [...document.querySelectorAll('#seatBar .seat')].map((x) => x.textContent),
              turn: [...document.querySelectorAll('#seatBar .seat.turn')].length,
            };
          });
          if (t.table) ok(`AC-1/7 ${game}: 卓モードになる`);
          else fail(`AC-1/7 ${game}: 卓モードになる`, JSON.stringify(t));
          if (t.log === 0 && t.composer === 0) ok(`AC-3 ${game}: 会話 UI が出ていない`);
          else fail(`AC-3 ${game}: 会話 UI が出ていない`, `log=${t.log} composer=${t.composer}`);
          if (t.seats.length >= 2) ok(`AC-1 ${game}: 参加者の名札が ${t.seats.length} 枚（${t.seats.join(' / ')}）`);
          else fail(`AC-1 ${game}: 参加者の名札が出る`, JSON.stringify(t.seats));
          if (t.turn === 1) ok(`AC-5 ${game}: 手番の人が 1 人光っている`);
          else fail(`AC-5 ${game}: 手番の人が 1 人光っている`, `${t.turn} 人`);
          if (t.board > 300) ok(`AC-4 ${game}: 卓が大きい（${t.board}px）`);
          else fail(`AC-4 ${game}: 卓が大きい`, `${t.board}px`);
          await say4('もうやめる');
          await sleep(700);
        }
        const back = await page.evaluate(() => ({
          table: document.body.classList.contains('table'),
          log: document.getElementById('log')?.getBoundingClientRect().height ?? -1,
        }));
        if (!back.table && back.log > 0) ok('AC-6 やめたら元の画面に戻る（会話が戻る）');
        else fail('AC-6 やめたら元の画面に戻る', JSON.stringify(back));

        // ---- PBI-044: スマホ幅 × ホスト/ゲスト の 4 組で同じ形か ----
        for (const [who, url] of [['ホスト', hostUrl], ['ゲスト', inv4.url]]) {
          for (const [size, vp] of [['スマホ', { width: 390, height: 844 }], ['広い画面', { width: 1400, height: 900 }]]) {
            const pg = await browser.newPage({ viewport: vp });
            try {
              await pg.goto(url, { waitUntil: 'domcontentloaded' });
              await pg.waitForTimeout(1200);
              const type = async (t) => {
                await pg.evaluate((x) => {
                  const el = document.querySelector('#composer textarea, #composer input');
                  el.value = x;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                }, t);
                await sleep(1100);
              };
              await type('麻雀やろう');
              await type('配って');
              await sleep(1200);
              const m = await pg.evaluate(() => {
                const h = (id) => Math.round(document.getElementById(id)?.getBoundingClientRect().height ?? -1);
                const last = [...document.querySelectorAll('#gameList .gtile')].pop();
                return {
                  table: document.body.classList.contains('table'),
                  log: h('log'), composer: h('composer'), board: h('gameList'),
                  seats: document.querySelectorAll('#seatBar .seat').length,
                  handBottom: last ? Math.round(last.getBoundingClientRect().bottom) : -1,
                  vh: innerHeight,
                };
              });
              const tag = `${who} × ${size}`;
              if (m.table && m.log === 0 && m.composer === 0) ok(`AC-1/3/4 ${tag}: 卓モードで会話 UI が出ない`);
              else fail(`AC-1/3/4 ${tag}: 卓モードで会話 UI が出ない`, JSON.stringify(m));
              if (m.seats >= 2) ok(`AC-3 ${tag}: 名札が ${m.seats} 枚`);
              else fail(`AC-3 ${tag}: 名札が出る`, JSON.stringify(m));
              if (m.handBottom === -1) ok(`${tag}: まだ手牌が無い場面（判定を飛ばす）`);
              else if (m.handBottom <= m.vh) ok(`AC-2 ${tag}: 手牌が画面内（下端 ${m.handBottom} / ${m.vh}）`);
              else fail(`AC-2 ${tag}: 手牌が画面内`, `下端 ${m.handBottom} > ${m.vh}`);
              await type('もうやめる');
            } finally {
              await pg.close();
            }
          }
        }
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
      room4.kill('SIGKILL');
    }
  }
}

// ---- PBI-036: LAN に出した部屋（実際に別の住所から叩く）----
{
  const lan = lanAddresses();
  if (lan.length === 0) {
    console.log('skip    - LAN の住所が無い機械（AC-3〜5 は測れない）');
  } else {
    const P2 = PORT + 40;
    const HOME2 = mkdtempSync(join(tmpdir(), 'claw-lan-'));
    const room2 = spawn(process.execPath, ['src/room.ts'], {
      cwd: REPO, env: { ...process.env, HOME: HOME2, PORT: String(P2), NO_CHLOE: '1', ROOM_BIND: '0.0.0.0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log2 = '';
    room2.stderr.on('data', (d) => { log2 += d; });
    try {
      let up2 = false;
      for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P2}/health`)).ok) { up2 = true; break; } } catch { /* まだ */ } await sleep(500); }
      if (!up2) { fail('AC-2 LAN に出した部屋が起動する', log2.slice(-200)); } else {
        if (/LAN に出ています/.test(log2)) ok('AC-2 起動時に「どこに出ているか」を必ず言う');
        else fail('AC-2 起動時に「どこに出ているか」を必ず言う', log2.slice(-200));

        const host2 = JSON.parse(readFileSync(join(HOME2, '.talkingclaw', 'room.json'), 'utf8')).token;
        const inv = await (await fetch(`http://127.0.0.1:${P2}/guests`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': host2 },
          body: JSON.stringify({ action: 'invite', name: 'たけし', channel: 'game' }),
        })).json();
        if (inv.url?.includes(lan[0])) ok(`AC-6 招待リンクが LAN の住所で作られる（${inv.url.split('/?')[0]}）`);
        else fail('AC-6 招待リンクが LAN の住所で作られる', String(inv.url));

        const r = await fetch(`http://${lan[0]}:${P2}/participants?token=${inv.guest.token}`);
        if (r.status === 200) ok('AC-3 LAN の住所からゲストが入れる');
        else fail('AC-3 LAN の住所からゲストが入れる', `status=${r.status}`);

        // **生のソケット**で Host を偽る（fetch は host ヘッダを上書きできない）
        const raw = (headers) => new Promise((resolve) => {
          const sock = connect(P2, lan[0], () => sock.write(`GET /participants?token=${inv.guest.token} HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`));
          let buf = '';
          sock.on('data', (d) => { buf += d; });
          sock.on('close', () => resolve(buf.split('\r\n')[0]));
          sock.on('error', () => resolve('ERR'));
        });
        const fake = await raw('Host: evil.example.com\r\n');
        if (/403/.test(fake)) ok('AC-4 偽の Host は 403（DNS rebinding 対策が生きている）');
        else fail('AC-4 偽の Host は 403', fake);
        const real = await raw(`Host: ${lan[0]}:${P2}\r\n`);
        if (/200/.test(real)) ok('AC-3 本物の Host なら 200');
        else fail('AC-3 本物の Host なら 200', real);
        const noHost = await new Promise((resolve) => {
          const sock = connect(P2, lan[0], () => sock.write(`GET /participants?token=${inv.guest.token} HTTP/1.0\r\n\r\n`));
          let buf = '';
          sock.on('data', (d) => { buf += d; });
          sock.on('close', () => resolve(buf.split('\r\n')[0]));
          sock.on('error', () => resolve('ERR'));
        });
        if (/403/.test(noHost)) ok('AC-5 Host 無しは 403');
        else fail('AC-5 Host 無しは 403', noHost);
      }
    } finally {
      room2.kill('SIGKILL');
    }

    // AC-1: 既定の部屋（最初に起こしたほう）は LAN の住所では繋がらない
    const shut = await fetch(`http://${lan[0]}:${PORT}/health`).then((x) => x.status).catch(() => 'refused');
    if (shut === 'refused') ok('AC-1 既定では LAN に出ていない（LAN の住所で繋がらない）');
    else fail('AC-1 既定では LAN に出ていない', `status=${shut}`);
  }
}

// ---- PBI-037: ゲストが**自分の部屋の卓**で打つ（ホストの部屋は無傷）----
{
  const P3 = PORT + 70;
  const HOME3 = mkdtempSync(join(tmpdir(), 'claw-play-'));
  // 進行役が要るので NO_CHLOE は付けない。鍵は空（推論ゼロで卓は立つ・PBI-034）
  const room3 = spawn(process.execPath, ['src/room.ts'], {
    cwd: REPO,
    env: {
      ...process.env, HOME: HOME3, PORT: String(P3), ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      TABLE_IDLE_MS: '2500',   // PBI-038（代打ち）を実時間で測れる長さに
      TABLE_THINK_MS: '1500',  // PBI-043 の間合いを実時間で測る（既定は 5 秒）
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    let up3 = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P3}/health`)).ok) { up3 = true; break; } } catch { /* まだ */ } await sleep(500); }
    if (!up3) { fail('AC-6 卓の部屋が起動する', '起動しない'); } else {
      const host3 = JSON.parse(readFileSync(join(HOME3, '.talkingclaw', 'room.json'), 'utf8')).token;
      const call = (tk, path, body) => fetch(`http://127.0.0.1:${P3}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': tk }, body: JSON.stringify(body ?? {}),
      });
      const inv = await (await call(host3, '/guests', { action: 'invite', name: 'たけし', channel: 'game' })).json();
      const gt3 = inv.guest.token;
      await call(gt3, '/chat', { text: '麻雀やろう', immediate: true });
      await sleep(600);
      await call(gt3, '/chat', { text: '配って', immediate: true });
      await sleep(900);

      // PBI-043: **人が打った直後は AI が打っていない**（間合い 1.5 秒）→ 少し待つと 1 手ずつ進む
      {
        // AC-4: **自分の番が回ってくる**（実際に「友達の番が来なかった」ので、ここが本丸）
        let tile = null;
        const waited = Date.now();
        for (let i = 0; i < 40; i++) {
          const v = await (await call(gt3, '/game', {})).json();
          tile = (v.hand ?? []).find((f) => f.move)?.move ?? null;
          if (tile) break;
          if (i % 6 === 0) console.log(`        …待ち ${i / 2}s: 番=${(v.seats ?? []).find((x) => x.turn)?.name ?? '?'} / 手牌 ${(v.hand ?? []).length} / kind ${v.kind}`);
          await sleep(500);
        }
        if (tile) ok(`AC-4 招かれた人に順番が回ってくる（${Math.round((Date.now() - waited) / 100) / 10} 秒待ち）`);
        else fail('AC-4 招かれた人に順番が回ってくる', '20 秒待っても自分の番が来ない');
        if (!tile) { /* 測れない */ } else {
          const count = async () => {
            const v = await (await call(gt3, '/game', {})).json();
            return (v.board?.seats ?? []).reduce((n, x) => n + (x.river?.length ?? 0), 0);
          };
          const c0 = await count();
          await call(gt3, '/chat', { text: tile, immediate: true });
          await sleep(350);
          const c1 = await count();
          // **一瞬で 3 人ぶん流れない**（間合い 1.5 秒 / 代打ち 2.5 秒なので、この時点では 1〜2 手）
          if (c1 - c0 <= 2) ok(`AC-1 打った直後に卓が流れない（${c0} → ${c1}）`);
          else fail('AC-1 打った直後に卓が流れない', `${c0} → ${c1}（他家が一瞬で流れている）`);
          await sleep(2500);
          const c2 = await count();
          if (c2 > c1) ok(`AC-1/2 間合いの後に他家が打つ（${c1} → ${c2}）`);
          else fail('AC-1/2 間合いの後に他家が打つ', `${c1} → ${c2}（進んでいない）`);
        }
      }

      // PBI-038: 手番の人が黙っていても卓が進む（TABLE_IDLE_MS を短くして起こしてある）
      const beforeIdle = await (await call(gt3, '/game', {})).json();
      const riverBefore = (beforeIdle.board?.seats ?? []).reduce((n, x) => n + (x.river?.length ?? 0), 0);
      await sleep(4000);
      const afterIdle = await (await call(gt3, '/game', {})).json();
      const riverAfter = (afterIdle.board?.seats ?? []).reduce((n, x) => n + (x.river?.length ?? 0), 0);
      if (riverAfter > riverBefore) ok(`AC-1 誰も打たなくても卓が進む（捨て牌 ${riverBefore} → ${riverAfter}）`);
      else fail('AC-1 誰も打たなくても卓が進む', `捨て牌 ${riverBefore} → ${riverAfter}（止まったまま）`);

      const gview = await (await call(gt3, '/game', {})).json();
      const hview = await (await call(host3, '/game', {})).json();
      const seats = gview.board?.seats?.map((x) => x.name) ?? [];
      if (seats.includes('たけし')) ok(`AC-1 ゲストが席に着いている（${seats.join(' / ')}）`);
      else fail('AC-1 ゲストが席に着いている', JSON.stringify(seats));
      if ((gview.hand ?? []).length >= 13) ok(`AC-5 ゲストに自分の手牌が出る（${gview.hand.length} 枚）`);
      else fail('AC-5 ゲストに自分の手牌が出る', `${(gview.hand ?? []).length} 枚`);
      if (hview.kind === null) ok('AC-6 ホストの部屋の卓は動いていない（混線しない）');
      else fail('AC-6 ホストの部屋の卓は動いていない', JSON.stringify(hview.title));
    }
  } finally {
    room3.kill('SIGKILL');
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
