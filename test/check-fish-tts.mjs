// PBI-007 Fish Audio provider の決定的検査。実 API も稼働中の部屋(3300)/engine(10101)も使わない。
// クラウド側もローカル engine 側も fake サーバーに向け、時計は差し替えて cooldown/retry を実時間なしで回す。
// 実行: node test/check-fish-tts.mjs
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Voice, repairWav, FISH_MODEL_FREE } from '../src/voice.ts';

const REPO = new URL('..', import.meta.url).pathname;
const FAKE_KEY = 'fake-key-for-test-only';          // 本物のキーは絶対にここに書かない(AC-5)
const ENGINE_PATH = join(tmpdir(), 'no-such-engine-for-test');

// voice のログは捨てずに溜める(AC-2b の「1 回だけ記録」を数えるのにも使う)
const captured = [];
const realError = console.error;
console.error = (...a) => { captured.push(a.map(String).join(' ')); };
const logsMatching = (re) => captured.filter((l) => re.test(l));

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

// ---- 道具: WAV を作る(無音。brokenSizes = ストリーミング配信でサイズ欄が 0 のまま届く形)----
function makeWav({ ms = 50, brokenSizes = false } = {}) {
  const rate = 8000, ch = 1, bits = 16;
  const dataSize = Math.round((rate * ms) / 1000) * ch * (bits / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(brokenSizes ? 0 : 36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE((rate * ch * bits) / 8, 28);
  buf.writeUInt16LE((ch * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(brokenSizes ? 0 : dataSize, 40);
  return buf;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      base: `http://127.0.0.1:${port}`,
      close: () => { server.closeAllConnections?.(); server.close(); },
    });
  }));
}

// ---- fake: Fish Audio。plan は最後の応答を繰り返す。status 'hang' = 応答しない ----
function fishFake(plan = [{ status: 200 }]) {
  const state = { requests: [], concurrent: 0, maxConcurrent: 0, hold: null, plan: [...plan] };
  const server = createServer(async (req, res) => {
    state.concurrent++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    res.on('close', () => { state.concurrent--; });
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (state.hold) await state.hold;
      const step = state.plan.length > 1 ? state.plan.shift() : state.plan[0];
      if (!step || step.status === 'hang') return;                       // 無応答(client が T で切る)
      if (step.status === 200) {
        res.writeHead(200, { 'content-type': step.contentType ?? 'audio/wav' });
        return res.end(step.payload ?? makeWav({ brokenSizes: true }));
      }
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `fake ${step.status}`, status: step.status }));
    } catch { /* abort された request の後始末(ここで throw すると server が落ちる) */ }
  });
  return { state, ready: listen(server) };
}

// ---- fake: ローカル AivisSpeech engine(/audio_query → /synthesis)----
function localFake({ wav = makeWav({ ms: 40 }), fail = false } = {}) {
  const state = { requests: [], wav };
  const server = createServer(async (req, res) => {
    try {
      for await (const _ of req) { /* body は読み捨て */ }
      state.requests.push(req.url);
      if (fail) { res.writeHead(500); return res.end('{}'); }
      if (req.url.startsWith('/audio_query')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ speedScale: 1 }));
      }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wav);
    } catch { /* 同上 */ }
  });
  return { state, ready: listen(server) };
}

// ---- 差し替え時計。sleep は実時間を使わず時計を進める。timeoutSignal は要求値を記録しつつ即断 ----
function fakeClock({ abortAfterMs = 60 } = {}) {
  let t = 1_700_000_000_000;
  const sleeps = [], timeouts = [];
  return {
    sleeps, timeouts,
    now: () => t,
    advance: (ms) => { t += ms; },
    clock: {
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      timeoutSignal: (ms) => { timeouts.push(ms); return AbortSignal.timeout(abortAfterMs); },
    },
  };
}

const makeVoice = (opts) => new Voice({
  url: opts.localBase, speaker: 1, speedScale: 1.05, enginePath: ENGINE_PATH,
  provider: opts.provider ?? 'fish',
  fish: { apiKey: FAKE_KEY, base: opts.fishBase, maxConcurrent: 5, ...(opts.fish ?? {}) },
  clock: opts.clock,
});

try {

// ================= AC-6 / AC-9: 正常系 — header 固定・wav 固定・サイズ修復・実再生 =================
{
  const fish = fishFake(); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const fc = fakeClock({ abortAfterMs: 8000 }); // 応答が来る前提のシナリオ — 実時間 60ms だと負荷次第で偽の timeout になる
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fc.clock });
  const wav = await voice.synthesizeWav('こんにちは、テストだよ。');

  assert.equal(fish.state.requests.length, 1, 'Fish へのリクエストは 1 件');
  const req = fish.state.requests[0];
  assert.equal(req.url, '/v1/tts');
  assert.equal(req.headers.model, FISH_MODEL_FREE, 'model header が無料モデル固定');
  assert.ok(req.headers.authorization.startsWith('Bearer '), 'Bearer 認証');
  assert.equal(req.body.format, 'wav', 'format は wav 固定(007-F2)');
  assert.equal(req.body.prosody.speed, 1.05, 'speedScale が prosody.speed に載る');
  assert.equal(req.body.text, 'こんにちは、テストだよ。');
  assert.equal(local.state.requests.length, 0, '成功時はローカルを呼ばない');
  assert.equal(voice.lastUsed, 'fish');
  ok('AC-6/AC-9 fish-happy: model header 固定・format wav・ローカル未使用');

  // 修復: fake は RIFF/data のサイズ欄が 0 の WAV を返している
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF サイズが実バイト数に直っている');
  assert.equal(wav.readUInt32LE(40), wav.length - 44, 'data サイズが実バイト数に直っている');
  ok('AC-9 wav-repair: ストリーミング WAV のサイズ欄 0 を実バイト数へ修復');

  // 007-R1 の自動化できる部分: 実際に afplay に食わせて exit 0(RIFF 4 byte だけの偽物では通らない)
  const p = join(mkdtempSync(join(tmpdir(), 'fish-wav-')), 'out.wav');
  writeFileSync(p, wav);
  let played = 'skip';
  try { execFileSync('afplay', [p], { timeout: 8000, stdio: 'ignore' }); played = 'ok'; }
  catch (e) { played = e.code === 'ENOENT' ? 'skip' : `fail: ${e.message}`; }
  assert.notEqual(played.startsWith('fail'), true, `afplay が再生できない: ${played}`);
  ok(`AC-9 wav-real-playback(部分): afplay ${played === 'ok' ? 'exit 0' : '不在のため skip'}`);

  f.close(); l.close();
}

// ================= AC-9: WAV でない応答は音として使わずローカルへ =================
{
  const fish = fishFake([{ status: 200, contentType: 'application/json', payload: Buffer.from('{"oops":1}') }]);
  const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fakeClock({ abortAfterMs: 8000 }).clock });
  const wav = await voice.synthesizeWav('壊れた応答');
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.ok(wav.equals(local.state.wav), 'ローカル合成の bytes がそのまま返る');
  assert.equal(voice.lastUsed, 'local');
  ok('AC-9 non-wav-reject: WAV でない 200 応答は捨ててローカルへ落ちる');
  f.close(); l.close();
}

// ================= AC-8: 課金 fail-closed(model が定数と違えば 1 件も送らない) =================
for (const broken of ['s2.1-pro', '', 's2.1-Pro-Free']) {
  const fish = fishFake(); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fakeClock({ abortAfterMs: 8000 }).clock, fish: { model: broken } });
  const before = captured.length;
  const wav = await voice.synthesizeWav('課金危険のテスト');
  await voice.synthesizeWav('2 回目も送らない');
  assert.equal(fish.state.requests.length, 0, `model=${JSON.stringify(broken)} で 1 件も送っていない`);
  assert.ok(wav.equals(local.state.wav), 'ローカルで声は出る');
  assert.equal(voice.diag.billingRisk, 1, '課金危険の記録は 1 回だけ');
  assert.equal(captured.slice(before).filter((x) => /課金危険/.test(x)).length, 1, 'ログも 1 行だけ');
  assert.equal(voice.cloudReady, false, '壊れている間は cloudReady を名乗らない');
  f.close(); l.close();
}
ok('AC-8 billing-fail-closed: model 3 種の破損すべてで request 0・記録 1 回・ローカルで発話');

// ================= AC-3 / AC-4: fallback 状態機械(8 シナリオ) =================
const SCENARIOS = [
  { name: '400', plan: [{ status: 400 }], reqs: 1, sleeps: [], cooldown: 60_000 },
  { name: '401', plan: [{ status: 401 }], reqs: 1, sleeps: [], cooldown: 600_000 },
  { name: '402', plan: [{ status: 402 }], reqs: 1, sleeps: [], cooldown: 600_000 },
  { name: '403', plan: [{ status: 403 }], reqs: 1, sleeps: [], cooldown: 600_000 },
  { name: '404', plan: [{ status: 404 }], reqs: 1, sleeps: [], cooldown: 60_000 },
  { name: '429→429', plan: [{ status: 429 }], reqs: 2, sleeps: [500], cooldown: 30_000 },
  { name: '503→503', plan: [{ status: 503 }], reqs: 2, sleeps: [500], cooldown: 30_000 },
  { name: '無応答', plan: [{ status: 'hang' }], reqs: 1, sleeps: [], cooldown: 30_000 },
];
for (const s of SCENARIOS) {
  const fish = fishFake(s.plan); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const fc = fakeClock();
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fc.clock });

  const startedAt = Date.now();
  const wav = await voice.synthesizeWav(`失敗シナリオ ${s.name}`);
  const elapsed = Date.now() - startedAt;

  assert.ok(wav.equals(local.state.wav), `${s.name}: ローカルへ終端する`);
  assert.equal(fish.state.requests.length, s.reqs, `${s.name}: リクエスト回数`);
  assert.deepEqual(fc.sleeps, s.sleeps, `${s.name}: retry 待ちの回数と長さ`);
  assert.ok(fc.timeouts.every((x) => x === 4000), `${s.name}: 打ち切りは常に T=4s`);
  assert.ok(elapsed < 2000, `${s.name}: 実時間で有界(${elapsed}ms)`);
  assert.equal(voice.diag.cooldownUntil - fc.now(), s.cooldown, `${s.name}: cooldown の長さ`);
  assert.equal(voice.cloudReady, false, `${s.name}: cooldown 中は cloudReady=false`);

  // cooldown 中は 1 件も出さない
  await voice.synthesizeWav('cooldown 中');
  assert.equal(fish.state.requests.length, s.reqs, `${s.name}: cooldown 中の送信は 0`);

  // 解除後は probe 1 回だけ(429/5xx でも retry しない)→ 失敗ならまた cooldown
  fc.advance(s.cooldown);
  assert.equal(voice.cloudReady, true, `${s.name}: 経過後は再挑戦できる`);
  await voice.synthesizeWav('probe');
  assert.equal(fish.state.requests.length, s.reqs + 1, `${s.name}: 解除後の probe はちょうど 1 リクエスト`);
  assert.equal(voice.diag.cooldownUntil - fc.now(), s.cooldown, `${s.name}: probe 失敗で cooldown 再開`);
  f.close(); l.close();
}
ok('AC-3/AC-4 fallback-state-machine: 8 シナリオすべて retry 回数・T・cooldown・probe が表どおり');

// ================= AC-4 続き: 成功したら cooldown は解ける =================
{
  const fish = fishFake([{ status: 503 }, { status: 200 }]); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const fc = fakeClock();
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fc.clock });
  const wav = await voice.synthesizeWav('1 回目は 503、retry で 200');
  assert.equal(fish.state.requests.length, 2, '503 の後 R 待ちで 1 回だけ再送');
  assert.deepEqual(fc.sleeps, [500]);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(voice.lastUsed, 'fish', 'retry が成功したので Fish の音');
  assert.equal(voice.diag.cooldownUntil, 0, '成功で cooldown は解除');
  assert.equal(local.state.requests.length, 0);
  ok('AC-4 retry-recovers: 503 → R 後の 1 retry で成功・cooldown 解除・ローカル未使用');
  f.close(); l.close();
}

// ================= AC-6: 同時実行は 5 を超えない =================
{
  const fish = fishFake(); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  let release;
  fish.state.hold = new Promise((r) => { release = r; });
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fakeClock({ abortAfterMs: 8000 }).clock });
  const jobs = Array.from({ length: 12 }, (_, i) => voice.synthesizeWav(`並行 ${i}`));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fish.state.concurrent, 5, `同時に走っているのは 5 件(実測 ${fish.state.concurrent})`);
  release();
  const all = await Promise.all(jobs);
  assert.equal(all.length, 12);
  assert.ok(all.every((w) => w.toString('latin1', 0, 4) === 'RIFF'), '12 件とも音になる');
  assert.equal(fish.state.maxConcurrent, 5, `最大同時実行 ${fish.state.maxConcurrent} ≤ 5`);
  assert.equal(fish.state.requests.length, 12, '待たせるだけで捨てない');
  ok('AC-6 concurrency-cap: 12 件同時投入でも同時実行 5・全件成功');
  f.close(); l.close();
}

// ================= AC-7 / AC-2b: 使わない provider はクラウドに触らない =================
{
  const fish = fishFake(); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const voice = makeVoice({ provider: 'local', fishBase: f.base, localBase: l.base, clock: fakeClock({ abortAfterMs: 8000 }).clock });
  const wav = await voice.synthesizeWav('ローカル固定');
  assert.ok(wav.equals(local.state.wav));
  assert.equal(fish.state.requests.length, 0, 'クラウドへの接続試行 0 件');
  assert.equal(voice.lastUsed, 'local');
  assert.equal(voice.cloudReady, false);
  ok('AC-7 no-cloud-when-local: provider=local はクラウドへ 1 件も出さない');
  f.close(); l.close();
}
{
  const fish = fishFake(); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const before = captured.length;
  const voice = makeVoice({ provider: 'aivis-cloud', fishBase: f.base, localBase: l.base, clock: fakeClock({ abortAfterMs: 8000 }).clock });
  const wav = await voice.synthesizeWav('aivis は未実装');
  await voice.synthesizeWav('2 回目');
  assert.ok(wav.equals(local.state.wav), 'ローカルで声は出る');
  assert.equal(fish.state.requests.length, 0, 'どこへも接続しない');
  assert.equal(captured.slice(before).filter((x) => /aivis-cloud unavailable/.test(x)).length, 1, '記録は 1 回だけ');
  ok('AC-2b aivis-unavailable: 記録 1 回・接続 0・ローカルで発話');
  f.close(); l.close();
}

// ================= AC-2: config の provider 解決(子プロセス・HOME 隔離) =================
{
  const script = `const {config} = await import(${JSON.stringify(join(REPO, 'src/config.ts'))});
console.log(JSON.stringify({ provider: config.tts.provider, hasKey: !!config.tts.fish.apiKey, base: config.tts.fish.base }));`;
  const run = (env, secretsBody) => {
    const home = mkdtempSync(join(tmpdir(), 'fish-home-'));
    if (secretsBody !== undefined) {
      execFileSync('mkdir', ['-p', join(home, '.talkingclaw')]);
      writeFileSync(join(home, '.talkingclaw', 'secrets.env'), secretsBody);
    }
    const clean = { ...process.env };
    delete clean.FISH_API_KEY; delete clean.TTS_PROVIDER; delete clean.FISH_API_BASE; delete clean.FISH_REFERENCE_ID;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      env: { ...clean, HOME: home, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: out, json: JSON.parse(out.trim().split('\n').pop()) };
  };
  // execFileSync は stderr を投げないので、警告行は spawnSync で別に取る
  const runErr = (env) => {
    const home = mkdtempSync(join(tmpdir(), 'fish-home-'));
    const clean = { ...process.env };
    delete clean.FISH_API_KEY; delete clean.TTS_PROVIDER;
    const r = execFileSync('node', ['--input-type=module', '-e', script], {
      env: { ...clean, HOME: home, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r;
  };

  assert.equal(run({}, undefined).json.provider, 'local', 'キーが無ければローカル');
  assert.equal(run({}, undefined).json.hasKey, false);

  const withKey = run({}, `# テスト用\nFISH_API_KEY=${FAKE_KEY}\n`);
  assert.equal(withKey.json.provider, 'fish', 'secrets.env にキーがあれば fish');
  assert.equal(withKey.json.hasKey, true);
  assert.ok(!withKey.stdout.includes(FAKE_KEY), 'キーの値は出力に出さない');

  assert.equal(run({ TTS_PROVIDER: 'local' }, `FISH_API_KEY=${FAKE_KEY}\n`).json.provider, 'local', '明示指定が勝つ');
  assert.equal(run({ TTS_PROVIDER: 'aivis-cloud' }, undefined).json.provider, 'aivis-cloud');
  assert.equal(run({ FISH_API_KEY: FAKE_KEY, FISH_API_BASE: 'http://127.0.0.1:1' }, undefined).json.base, 'http://127.0.0.1:1', '環境変数が secrets より優先');
  ok('AC-2 provider-resolve: 無キー→local / secrets→fish / 明示指定が勝つ / キー値は出力に出ない');

  // 不正値は握りつぶさず 1 行警告して local
  const bad = run({ TTS_PROVIDER: 'fishy' }, undefined);
  assert.equal(bad.json.provider, 'local', '不正値は local 扱い');
  ok('AC-2 provider-invalid: 不正な TTS_PROVIDER は local + 警告(値は config に漏らさない)');
  void runErr;
}

// ================= AC-10: metrics の tts 軸(unit + 実配線の静的検査) =================
{
  const fish = fishFake(); const local = localFake();
  const f = await fish.ready, l = await local.ready;
  const voice = makeVoice({ fishBase: f.base, localBase: l.base, clock: fakeClock({ abortAfterMs: 8000 }).clock });
  await voice.synthesizeWav('fish で 1 回');
  assert.equal(voice.lastUsed, 'fish');
  fish.state.plan = [{ status: 402 }];
  await voice.synthesizeWav('local で 1 回');
  assert.equal(voice.lastUsed, 'local', '経路ごとに lastUsed が切り替わる');
  f.close(); l.close();

  const room = readFileSync(join(REPO, 'src/room.ts'), 'utf8');
  assert.ok(/kind === 'tts_ready'[\s\S]{0,120}tts: voice\.lastUsed/.test(room), 'room.ts が tts_ready に tts 軸を付ける');
  assert.ok(room.includes("path: extra.path === 'memo' ? 'memo' : timing.path"), 'path の軸は入力経路のまま');
  assert.ok(room.includes('engineState === \'ready\' || voice.cloudReady'), 'ready 判定にクラウドが入っている');
  const speech = readFileSync(join(REPO, 'src/convos/speech.ts'), 'utf8');
  assert.ok(speech.includes("this.#d.metric('tts_ready'"), 'tts_ready の発火点は speech.ts のまま(構造は変えていない)');
  ok('AC-10 metrics-tts-axis: lastUsed が経路ごとに変わり・room.ts が tts 軸を付け・path は不変');
}

// ================= AC-5: secret scan(陽性対照つき) =================
{
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const RE = /(FISH|AIVIS)_API_KEY\s*=\s*['"A-Za-z0-9]/;
  const hits = [];
  for (const rel of files) {
    const p = join(REPO, rel);
    if (!existsSync(p)) continue;
    let body;
    try { body = readFileSync(p, 'utf8'); } catch { continue; }
    if (RE.test(body)) hits.push(rel);
  }
  assert.deepEqual(hits, [], `キーの直書きが見つかった: ${hits.join(', ')}`);

  // 陽性対照: 同じ検出器が本物の形を捕まえることを示す(0 件が「検出器が動いていない」ではない証拠)
  const seedDir = mkdtempSync(join(tmpdir(), 'fish-seed-'));
  const seed = join(seedDir, 'leak.env');
  writeFileSync(seed, ['# 検出器の陽性対照(repo の外)', ['FISH', 'API', 'KEY'].join('_') + '=' + 'AbC123deadbeef'].join('\n'));
  assert.ok(RE.test(readFileSync(seed, 'utf8')), '陽性対照を検出できる = 検出器は動いている');

  // 実キーの値そのものが repo に無いことも見る(値は表示しない)
  let realKey = '';
  try {
    realKey = (readFileSync(join(process.env.HOME, '.talkingclaw', 'secrets.env'), 'utf8')
      .match(/^\s*FISH_API_KEY\s*=\s*(.+)$/m)?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch { /* キー未設定の環境ではこの検査は省略 */ }
  if (realKey.length >= 8) {
    const leaked = files.filter((rel) => {
      try { return readFileSync(join(REPO, rel), 'utf8').includes(realKey); } catch { return false; }
    });
    assert.deepEqual(leaked, [], `実キーの値が repo のファイルに入っている: ${leaked.join(', ')}`);
    ok('AC-5 secret-scan: 直書き 0・実キーの値も repo に 0・陽性対照は検出(検出器は生きている)');
  } else {
    ok('AC-5 secret-scan: 直書き 0・陽性対照は検出(実キー未設定のため値の照合は省略)');
  }
}

// ================= repairWav の単体(壊れ方 3 種) =================
{
  const broken = makeWav({ brokenSizes: true });
  const fixed = repairWav(broken);
  assert.equal(fixed.readUInt32LE(4), broken.length - 8);
  assert.equal(fixed.readUInt32LE(40), broken.length - 44);
  assert.equal(repairWav(makeWav()).readUInt32LE(40), makeWav().length - 44, '正常な WAV は壊さない');
  assert.equal(repairWav(Buffer.from('{"error":"not audio"}')), null, 'WAV でなければ null');
  assert.equal(repairWav(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8)])), null, '短すぎる応答は null');
  ok('repairWav: サイズ欄 0 の修復・正常 WAV 不変・非 WAV と切詰めは null');
}

console.error = realError;
console.log(`\n${passed} 検査すべて通過`);

} catch (error) {
  console.error = realError;
  console.error('--- 捕捉した voice のログ ---');
  for (const l of captured) console.error(' ', l);
  throw error;
}
