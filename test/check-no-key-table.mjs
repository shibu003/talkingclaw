// PBI-034 / D-019 の本丸: **API キーが 1 つも無くても卓が立ち、最後まで打てる**。
//
// なぜこれを検査に固定するか: この部屋が「人数が足りない時に使える」ものである根拠が
// **推論を使わないこと**だから。ここが黙って壊れると（例えば進行に LLM を挟むと）、
// 鍵を持たない人には何も無い部屋になる。それは課金を迫らない設計（D-019）の土台が抜けること。
//
// ブラウザは要らない。部屋を起こして HTTP で打つ。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.MOTION_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 3340 + Math.floor(Math.random() * 12);
const HOME = mkdtempSync(join(tmpdir(), 'claw-nokey-'));
const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// **鍵を全部外して**起こす（Claude Code の資格情報も temp HOME なので見えない）
const room = spawn(process.execPath, ['src/room.ts'], {
  cwd: REPO,
  env: { ...process.env, HOME, PORT: String(PORT), ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', FISH_API_KEY: '' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let log = '';
room.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) { up = true; break; } } catch { /* まだ */ } await sleep(500); }
  if (!up) { fail('鍵ゼロでも部屋が起動する', log.slice(-300)); } else {
    ok('鍵ゼロでも部屋が起動する');
    const token = JSON.parse(readFileSync(join(HOME, '.talkingclaw', 'room.json'), 'utf8')).token;
    const post = (path, body) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': token }, body: JSON.stringify(body),
    });
    // 部屋が落ちた時に stack trace ではなく**赤い 1 行**で分かるようにする（負の対照で踏んだ）
    const say = async (text) => {
      try { await post('/chat', { text, immediate: true }); } catch (e) { fail(`「${text}」を送れる`, `部屋が落ちている: ${String(e).slice(0, 80)}`); }
      await sleep(700);
    };
    const view = async () => {
      try { return await (await post('/game', {})).json(); } catch (e) { return { error: String(e).slice(0, 80) }; }
    };

    await say('麻雀やろう');
    const opened = await view();
    if (opened.kind === 'mahjong') ok('鍵ゼロで麻雀の卓が立つ');
    else fail('鍵ゼロで麻雀の卓が立つ', JSON.stringify(opened).slice(0, 160));

    await say('配って');
    const dealt = await view();
    const seats = dealt.board?.seats?.map((s) => s.name) ?? [];
    if ((dealt.hand ?? []).length >= 13) ok(`配牌が来る（${dealt.hand.length} 枚）`);
    else fail('配牌が来る', `${(dealt.hand ?? []).length} 枚`);
    if (seats.length === 4) ok(`4 人そろう（${seats.join(' / ')}）`);
    else fail('4 人そろう', JSON.stringify(seats));
    // PBI-034 の中心: **名前のある面子**が座る（NPC2 では「人数を埋める」体験にならない）
    if (seats.length === 4 && !seats.some((n) => /^NPC/.test(n))) ok('空席に名前のあるキャラが座る');
    else fail('空席に名前のあるキャラが座る', JSON.stringify(seats));
    if (dealt.yourTurn === true) ok('自分の番になっている（打てる状態）');
    else fail('自分の番になっている', `yourTurn=${dealt.yourTurn}`);

    // 1 手打てる（進行が推論を待たない = 即座に返る）
    const tile = (dealt.hand ?? []).find((f) => f.move)?.move;
    if (!tile) { fail('切れる牌がある', JSON.stringify((dealt.hand ?? []).slice(0, 3))); } else {
      const t0 = Date.now();
      await say(tile);
      const after = await view();
      const ms = Date.now() - t0;
      if (after.kind === 'mahjong') ok(`1 手打てる（${tile} / ${ms}ms）`);
      else fail('1 手打てる', JSON.stringify(after).slice(0, 120));
      // 5 秒は「LLM を待っていない」ことの線引き（推論を挟むと 5〜20 秒かかる）。
      // 機械が混んでいると 3 秒を超えることがあるので、そこで赤くしない
      if (ms < 5000) ok(`進行が推論を待っていない（${ms}ms）`);
      else fail('進行が推論を待っていない', `${ms}ms かかった`);
    }

    // 会話をしていないので Brain は 1 度も作られない = API を呼んでいない
    if (!/anthropic|api key|authentication/i.test(log)) ok('API を呼んだ形跡が無い（ログに認証エラーが出ていない）');
    else fail('API を呼んだ形跡が無い', log.slice(-200));
    if (existsSync(join(HOME, '.talkingclaw', 'games.json'))) ok('卓の状態が保存されている（続きから遊べる）');
    else fail('卓の状態が保存されている', 'games.json が無い');
  }
} finally {
  room.kill('SIGTERM');
  await sleep(300);
  try { room.kill('SIGKILL'); } catch { /* 既に死んでいる */ }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
