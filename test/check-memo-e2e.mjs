// PBI-003 black-box e2e(holdout)。src/room.ts・src/memo.ts は読まずに、
// G1(backlog/PBI-003-memo-publish.md)と凍結契約(.kaiwa-loop/workerB-brief.md)の公開面だけから検査する。
// 検査 AC: AC-3 host-origin-reject / AC-7 adapter-channel-fix / AC-8 token-gate-order / AC-10 adapter-crash-dedupe
// 実行: node test/check-memo-e2e.mjs
// 隔離部屋を「空きポート + 一時 HOME + NO_CHLOE=1(Brain 無効)+ ROOM_TEST_HOOKS=1」で起動する。
// 稼働中の 3300/10101 には一切触れない。
//
// 負の対照(この検査自体が armed かを測る): E2E_MUTATE=no-origin|wrong-origin|no-hooks を付けて実行すると
// 公開面の env を 1 つだけ壊す。対応する検査が**赤くなるのが正しい**。どの対照がどの検査を殺すかは
// .kaiwa-loop/worker-reports/memo-e2e-holdout.md の対応表を参照。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_HOST = 'memo.example.com';
const PUBLIC_ORIGIN = 'https://memo.example.com';

const nonce = randomUUID().slice(0, 8);
const cid = (tag) => `e2e-${tag}-${randomUUID()}`; // ^[A-Za-z0-9_-]{8,64}$ に適合(45 文字)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

// 1 ブロックの失敗で全体を止めない。止めると、負の対照を当てた時に「先に落ちた検査より後ろが
// armed か」を観測できず、どの対照がどの検査を殺すかの対応表が作れない
const failures = [];
async function step(name, fn) {
  try { await fn(); } catch (err) { failures.push(name); console.error(`NG - ${name}: ${err.message}`); }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function pollUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout ${timeoutMs}ms: ${label}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// --- 隔離部屋のライフサイクル ---
const MUTATE = process.env.E2E_MUTATE ?? '';

function mutatedEnv(base) {
  const env = { ...base };
  // 壊せたことをここで確認する。壊れていない対照は「検査が効かない」という偽の結論を作る
  if (MUTATE === 'no-origin') {
    delete env.MEMO_PUBLIC_ORIGIN;
    assert.ok(!('MEMO_PUBLIC_ORIGIN' in env), '対照が適用されていない: MEMO_PUBLIC_ORIGIN が残っている');
  } else if (MUTATE === 'wrong-origin') {
    env.MEMO_PUBLIC_ORIGIN = 'https://other.example.com';
    assert.notEqual(env.MEMO_PUBLIC_ORIGIN, PUBLIC_ORIGIN, '対照が適用されていない: origin が同じ');
  } else if (MUTATE === 'no-hooks') {
    delete env.ROOM_TEST_HOOKS;
    assert.ok(!('ROOM_TEST_HOOKS' in env), '対照が適用されていない: ROOM_TEST_HOOKS が残っている');
  } else if (MUTATE) {
    throw new Error(`未知の E2E_MUTATE: ${MUTATE}(no-origin|wrong-origin|no-hooks)`);
  }
  return env;
}

function startRoom({ home, port }) {
  // 'node' の PATH 解決に頼らない(spawn の ENOENT は exit も出力も無い沈黙になる)
  const proc = spawn(process.execPath, ['src/room.ts'], {
    cwd: REPO,
    env: mutatedEnv({
      ...process.env,
      HOME: home,
      PORT: String(port),
      NO_CHLOE: '1',
      ROOM_TEST_HOOKS: '1',
      MEMO_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
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
  return { proc, exited, output: () => out };
}

async function waitHealthy(room, port, timeoutMs = 30_000) {
  let dead = false;
  room.exited.then(() => { dead = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead) throw new Error('部屋が healthy 前に終了した:\n' + room.output().slice(-2000));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) return;
    } catch { /* まだ起動中 */ }
    await sleep(200);
  }
  throw new Error(`${timeoutMs}ms 以内に /health が 200 にならない:\n` + room.output().slice(-2000));
}

async function killRoom(room) {
  if (room.proc.exitCode !== null || room.proc.signalCode !== null) return;
  room.proc.kill('SIGTERM');
  try {
    await withTimeout(room.exited, 5000, 'SIGTERM 後の exit');
  } catch {
    room.proc.kill('SIGKILL');
    await withTimeout(room.exited, 5000, 'SIGKILL 後の exit');
  }
}

async function assertPortFree(port) {
  // listen 成功 = 解放(node の listen は SO_REUSEADDR なので TIME_WAIT は妨げない)
  for (let i = 0; i < 25; i++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return;
    await sleep(200);
  }
  throw new Error(`port ${port} が解放されない`);
}

// --- HTTP(Host 偽装は fetch では不可 = forbidden header なので node:http 直叩き) ---
function rawRequest({ port, method = 'GET', path = '/', headers = {}, body = null, statusOnly = false, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout: ${method} ${path}`)));
    req.on('error', reject);
    req.on('response', (res) => {
      if (statusOnly) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, text: '' }); return; }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

const sayRaw = (port, { text, clientMessageId }, headers = {}) => rawRequest({
  port,
  method: 'POST',
  path: '/memo/api/say',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ text, clientMessageId }),
});

// --- 状態ファイル(凍結契約: HOME 隔離により全部 <tmpHome>/.talkingclaw/ 配下) ---
const statePath = (home, name) => join(home, '.talkingclaw', name);
function jsonlLines(home, name) {
  const p = statePath(home, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
}
const parsedLines = (home, name) => jsonlLines(home, name).map((l) => {
  try { return JSON.parse(l); } catch { return { __raw: l }; }
});
function tasksWithCid(home, cidValue) {
  const p = statePath(home, 'tasks.json');
  if (!existsSync(p)) return [];
  const found = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (v.clientMessageId === cidValue) { found.push(v); return; }
      Object.values(v).forEach(walk);
    }
  })(JSON.parse(readFileSync(p, 'utf8')));
  return found;
}
// X に帰属する行(相関 id が正、text 一致は保険)
const matchesX = (row, cidValue, text) =>
  row.clientMessageId === cidValue || (typeof row.text === 'string' && row.text.includes(text));

// --- 本体 ---
const home = mkdtempSync(join(tmpdir(), 'memo-e2e-home-'));
const port = await freePort();
const spawned = [];
const watchdog = setTimeout(() => {
  console.error('e2e 全体 timeout(180s)。隔離部屋を kill して失敗終了');
  for (const r of spawned) { try { r.proc.kill('SIGKILL'); } catch { /* 既に死んでいる */ } }
  process.exit(1);
}, 180_000);
watchdog.unref();

try {
  if (MUTATE) console.log(`[負の対照] E2E_MUTATE=${MUTATE} — 対応する検査が赤くなるのが正しい`);
  let room = startRoom({ home, port });
  spawned.push(room);
  await waitHealthy(room, port);
  ok('setup: 隔離部屋(空きポート + HOME 隔離 + NO_CHLOE)が /health 200');

  // step を跨いで使う値
  let token = '';
  let ledgerTurnId = '';
  const cidX = cid('ac10');
  const textX = `e2e AC-10 crash __memocrash__ ${nonce}`;
  const before = {
    memoLog: jsonlLines(home, 'memo-log.jsonl').length,
    transcript: jsonlLines(home, 'transcript.jsonl').length,
    metrics: jsonlLines(home, 'metrics.jsonl').length,
  };

  // ============ AC-3 host-origin-reject ============
  await step('AC-3 host-origin-reject', async () => {
    const spoofHost = await sayRaw(port, { text: `e2e AC-3 host spoof ${nonce}`, clientMessageId: cid('ac3a') },
      { Host: 'evil.example' });
    assert.equal(spoofHost.status, 403, `偽 Host は 403 の契約: ${spoofHost.status} ${spoofHost.text.slice(0, 200)}`);
    assert.doesNotThrow(() => JSON.parse(spoofHost.text), '403 body は JSON の契約');
    const spoofOrigin = await sayRaw(port, { text: `e2e AC-3 origin spoof ${nonce}`, clientMessageId: cid('ac3b') },
      { Host: PUBLIC_HOST, Origin: 'https://evil.example' });
    assert.equal(spoofOrigin.status, 403, `不一致 Origin は 403 の契約: ${spoofOrigin.status}`);
    await sleep(300); // 非同期 append があればここで着地させてから数える
    const after403 = {
      memoLog: jsonlLines(home, 'memo-log.jsonl').length,
      transcript: jsonlLines(home, 'transcript.jsonl').length,
      metrics: jsonlLines(home, 'metrics.jsonl').length,
    };
    assert.deepEqual(after403, before, '403 の副作用 0(memo-log / transcript / metrics の行数不変)');
    ok('AC-3 host-origin-reject: 偽 Host・不一致 Origin は 403 JSON・副作用 0');
  });

  // 対照(この検査が「常に 403」で緑にならないための陽性)+ Host の port 除去規則
  await step('AC-3 対照(陽性)', async () => {
    const legit = await sayRaw(port, { text: `e2e AC-3 legit ${nonce}`, clientMessageId: cid('ac3c') },
      { Host: PUBLIC_HOST, Origin: PUBLIC_ORIGIN });
    assert.equal(legit.status, 200, `exact Host+Origin は 200 の契約: ${legit.status} ${legit.text.slice(0, 200)}`);
    assert.ok(JSON.parse(legit.text).turnId, '200 応答に turnId');
    const legitPort = await sayRaw(port, { text: `e2e AC-3 legit with port ${nonce}`, clientMessageId: cid('ac3d') },
      { Host: `${PUBLIC_HOST}:443`, Origin: PUBLIC_ORIGIN });
    assert.equal(legitPort.status, 200, `Host の port は除去して比較する契約: ${legitPort.status}`);
    // 陽性後に memo-log が実際に増える = 行数の計数が本物のファイルに当たっている確認
    await pollUntil(() => jsonlLines(home, 'memo-log.jsonl').length > before.memoLog, 5000,
      '正当 memo 後に memo-log が増える(計数の実在確認)');
    ok('AC-3 対照: exact Host+Origin(port 付き Host 含む)は 200 + turnId・memo-log 増加を実測');
  });

  // ============ AC-7 adapter-channel-fix ============
  await step('token 取得', async () => {
    const rootPage = await rawRequest({ port, path: '/' });
    assert.equal(rootPage.status, 200, 'localhost の GET / は 200');
    const tokenMatch = rootPage.text.match(/<meta name="room-token" content="([^"]+)">/);
    assert.ok(tokenMatch && tokenMatch[1] && tokenMatch[1] !== '__ROOM_TOKEN__',
      'GET / の HTML に room token が実値で埋まる');
    token = tokenMatch[1];
    ok('setup: GET / の HTML から room token を取得(未置換の placeholder ではない)');
  });

  await step('AC-7 adapter-channel-fix', async () => {
    const chanSet = await rawRequest({
      port, method: 'POST', path: '/channel',
      headers: { 'content-type': 'application/json', 'x-room-token': token },
      body: JSON.stringify({ channel: 'chat' }),
    });
    assert.ok(chanSet.status >= 200 && chanSet.status < 300,
      `POST /channel {channel:'chat'} が通る: ${chanSet.status} ${chanSet.text.slice(0, 200)}`);

    const text7 = `e2e AC-7 channel fix ${nonce}`;
    const say7 = await sayRaw(port, { text: text7, clientMessageId: cid('ac7') });
    assert.equal(say7.status, 200, `activeChannel=chat でも memo say は 200: ${say7.status}`);
    const out7 = JSON.parse(say7.text);
    assert.ok(out7.turnId, 'say 応答に turnId');

    await pollUntil(() => jsonlLines(home, 'transcript.jsonl').some((l) => l.includes(text7)), 10_000,
      'transcript.jsonl(work)に AC-7 の text が現れる');
    await sleep(300); // chat 側への誤配線があればここまでに現れる
    assert.equal(jsonlLines(home, 'transcript-chat.jsonl').filter((l) => l.includes(text7)).length, 0,
      'transcript-chat.jsonl には現れない(chat へ入らない)');
    const turnCreated7 = parsedLines(home, 'metrics.jsonl')
      .filter((m) => m.kind === 'turn_created' && m.turnId === out7.turnId);
    assert.equal(turnCreated7.length, 1, `turn_created(turnId=${out7.turnId})は 1 行だけ`);
    assert.equal(turnCreated7[0].path, 'memo', "turn_created の path は 'memo'");
    // GET /channels は ?token= クエリを受け、active field を返す(公開面の probe で確認した既存 API 形)
    const channels = await rawRequest({ port, path: `/channels?token=${encodeURIComponent(token)}` });
    assert.equal(channels.status, 200, 'GET /channels(token 付き)は 200');
    assert.equal(JSON.parse(channels.text).active, 'chat',
      'activeChannel は chat のまま(memo 送信が奪わない)');
    ok('AC-7 adapter-channel-fix: activeChannel=chat でも memo は work のみ・metric path=memo 1 行・chat 不変');
  });

  // AC-7 の対照 — 「chat に 0 件」が空振り(vacuous truth)でないことの確認。
  // transcript-chat.jsonl が誰にも書かれない死んだ sink なら、上の 0 件は何も測っていない
  await step('AC-7 対照(chat sink が生きている)', async () => {
    const chatMarker = `e2e AC-7 chat sink liveness ${nonce}`;
    const chatPost = await rawRequest({
      port, method: 'POST', path: '/chat',
      headers: { 'content-type': 'application/json', 'x-room-token': token },
      body: JSON.stringify({ text: chatMarker, immediate: true }),
    });
    assert.equal(chatPost.status, 200, `POST /chat が通る: ${chatPost.status} ${chatPost.text.slice(0, 200)}`);
    await pollUntil(() => jsonlLines(home, 'transcript-chat.jsonl').some((l) => l.includes(chatMarker)), 10_000,
      'activeChannel=chat の発話は transcript-chat.jsonl に実際に書かれる(sink が生きている)');
    assert.equal(jsonlLines(home, 'transcript.jsonl').filter((l) => l.includes(chatMarker)).length, 0,
      'chat 発話は work transcript には入らない(2 ファイルが実際に分かれている)');
    ok('AC-7 対照: transcript-chat.jsonl は生きた sink = memo の「chat 0 件」は空振りでない');
  });

  // ============ AC-8 token-gate-order ============
  // 2 軸に分けて測る。同じ 4xx でも origin 層が断ったか token 層が断ったかは別の防御なので、
  // 拒否の有無ではなく理由(status)で照合する。実測: public Host は token の有無に関わらず origin 層が
  // 先に 403 を返すため、public Host だけでは token 層を一度も測れない
  await step('AC-8 軸1 token-gate-order', async () => {
    const localMemo = await rawRequest({ port, path: '/memo' });
    assert.equal(localMemo.status, 200, `localhost・token なしの GET /memo は 200(token gate より前): ${localMemo.status}`);
    assert.match(localMemo.headers['content-type'] ?? '', /text\/html/, '/memo は HTML');
    const localMemoLog = await rawRequest({ port, path: '/memo/api/log?after=0' });
    assert.equal(localMemoLog.status, 200, `localhost・token なしの GET /memo/api/log は 200: ${localMemoLog.status}`);
    const logBody = JSON.parse(localMemoLog.text);
    assert.ok(Array.isArray(logBody.entries) && 'cursor' in logBody, '/memo/api/log は {entries, cursor}');
    for (const p of ['/events', '/participants']) {
      const res = await rawRequest({ port, path: p, statusOnly: p === '/events' });
      assert.equal(res.status, 401, `localhost・token なしの ${p} は token 層が単独で 401: ${res.status}`);
    }
    ok('AC-8 軸1 token-gate-order: localhost・token なしで memo 2 面のみ 200・/events /participants は token 層が単独で 401');
  });

  // 軸 1 の対照 — 401/403 が「route が存在しないだけ」ではないことの確認
  await step('AC-8 対照(route 実在)', async () => {
    for (const p of ['/events', '/participants']) {
      const res = await rawRequest({ port, path: `${p}?token=${encodeURIComponent(token)}`, statusOnly: p === '/events' });
      assert.equal(res.status, 200, `対照: localhost + 有効 token の ${p} は 200(route は実在する): ${res.status}`);
    }
    ok('AC-8 対照: /events /participants は有効 token で 200 = 拒否は route 不在が理由ではない');
  });

  // 軸 2 — origin 隔離。public Host で memo 2 面だけが到達し、他は有効 token を付けても届かない
  await step('AC-8 軸2 origin 隔離', async () => {
    const pubMemo = await rawRequest({ port, path: '/memo', headers: { Host: PUBLIC_HOST } });
    assert.equal(pubMemo.status, 200, `public Host・token なしの GET /memo は 200: ${pubMemo.status}`);
    const pubMemoLog = await rawRequest({ port, path: '/memo/api/log?after=0', headers: { Host: PUBLIC_HOST } });
    assert.equal(pubMemoLog.status, 200, `public Host の GET /memo/api/log は 200: ${pubMemoLog.status}`);
    for (const p of ['/events', '/participants', '/']) {
      const noTok = await rawRequest({ port, path: p, headers: { Host: PUBLIC_HOST }, statusOnly: p === '/events' });
      assert.equal(noTok.status, 403, `public Host の ${p} は origin 層が 403: ${noTok.status}`);
      const withTok = await rawRequest({
        port, path: `${p}?token=${encodeURIComponent(token)}`, headers: { Host: PUBLIC_HOST }, statusOnly: p === '/events',
      });
      assert.equal(withTok.status, 403, `public Host は有効 token でも ${p} を 403(origin 層は token 層に依存しない): ${withTok.status}`);
    }
    const unknownMemo = await rawRequest({ port, path: '/memo/api/nope', headers: { Host: PUBLIC_HOST } });
    assert.equal(unknownMemo.status, 404, `memo 配下の未知 path は 404 の契約: ${unknownMemo.status}`);
    assert.ok(token && !pubMemo.text.includes(token), '/memo の HTML に room token 値が漏れない');
    ok('AC-8 軸2 origin 隔離: public Host は memo 2 面のみ 200・他は有効 token でも 403・未知 memo path 404・token 非漏洩');
  });

  // ============ AC-10 adapter-crash-dedupe ============
  // ① crash 注入: HTTP 応答は返らず、process が exit code 21 で死ぬ(exit イベントで待つ — 沈黙で判定しない)
  await step('AC-10 ① crash 注入', async () => {
    const crashSay = sayRaw(port, { text: textX, clientMessageId: cidX }).then(
      (r) => ({ responded: true, r }),
      () => ({ responded: false }),
    );
    const exit1 = await withTimeout(room.exited, 15_000, 'crash 注入後の exit(hook 未実装なら部屋は死なずここで timeout)');
    assert.equal(exit1.code, 21, `crash hook は exit 21 の契約: ${JSON.stringify(exit1)}`);
    const sayOutcome = await withTimeout(crashSay, 5000, 'crash say の socket 終了');
    assert.equal(sayOutcome.responded, false,
      `crash 時に HTTP 応答は返らない契約(確定行 append 前に exit): ${JSON.stringify(sayOutcome.r ?? null)}`);

    // 再起動前の状態: ledger 1 / memo 確定行 0(intent のみ)/ transcript 1 / task 1
    const ledgerX = parsedLines(home, 'memo-submit-ledger.jsonl').filter((l) => l.clientMessageId === cidX);
    assert.equal(ledgerX.length, 1, '永続台帳(memo-submit-ledger.jsonl)に X 行が 1');
    ledgerTurnId = ledgerX[0].turnId;
    assert.ok(ledgerTurnId, '台帳行に turnId がある');
    const memoRows1 = parsedLines(home, 'memo-log.jsonl').filter((l) => l.kind === 'memo' && matchesX(l, cidX, textX));
    assert.equal(memoRows1.length, 0, 'memo 確定行は 0(crash は確定行 append 前の契約)');
    const intentRows1 = parsedLines(home, 'memo-log.jsonl').filter((l) => l.kind === 'intent' && matchesX(l, cidX, textX));
    assert.equal(intentRows1.length, 1, 'intent(write-ahead)行は 1');
    assert.equal(jsonlLines(home, 'transcript.jsonl').filter((l) => l.includes(textX)).length, 1,
      'transcript(work)に該当 text 1 回(user_speech は済んでいる)');
    assert.equal(tasksWithCid(home, cidX).length, 1, 'tasks.json に clientMessageId=X の task 1 件');
    ok('AC-10 ① crash: exit 21・HTTP 応答なし・ledger 1 / memo 行 0 / transcript 1 / task 1');
  });

  // ② 同じ env で再起動 → 同 text+X を再送 → 台帳と同じ turnId・side effect は通算 1 のまま
  await step('AC-10 ② crash 跨ぎ dedupe', async () => {
    if (room.proc.exitCode === null && room.proc.signalCode === null) await killRoom(room); // ① が落ちた時の保険
    room = startRoom({ home, port });
    spawned.push(room);
    await waitHealthy(room, port);
    const preRes = await rawRequest({ port, path: '/memo/api/log?after=0' });
    assert.equal(preRes.status, 200, `再起動後の log API は 200: ${preRes.status} ${preRes.text.slice(0, 120)}`);
    const preResend = JSON.parse(preRes.text);
    assert.equal(preResend.entries.filter((e) => matchesX(e, cidX, textX)).length, 0,
      '再送前の log API に X の行は無い(確定行は書かれていない)');

    const resend = await sayRaw(port, { text: textX, clientMessageId: cidX });
    assert.equal(resend.status, 200, `再送は 200: ${resend.status} ${resend.text.slice(0, 200)}`);
    const outX = JSON.parse(resend.text);
    assert.equal(outX.turnId, ledgerTurnId, '再送は永続台帳と同じ turnId を返す(crash を跨いだ dedupe)');
    assert.ok(outX.messageId != null, '再送応答に messageId');
    // crash 跨ぎ(永続 submit 台帳ヒット)の再送も dedup:true — 裁定 17:08 の統合条件 #2 で契約に確定
    assert.equal(outX.dedup, true, `crash 跨ぎ再送は dedup:true の契約: ${resend.text.slice(0, 200)}`);

    await pollUntil(
      () => parsedLines(home, 'memo-log.jsonl').filter((l) => l.kind === 'memo' && matchesX(l, cidX, textX)).length >= 1,
      5000, '再送後に X の memo 確定行が書かれる');
    assert.equal(parsedLines(home, 'memo-log.jsonl').filter((l) => l.kind === 'memo' && matchesX(l, cidX, textX)).length, 1,
      'memo 確定行(X)は通算 1');
    assert.equal(jsonlLines(home, 'transcript.jsonl').filter((l) => l.includes(textX)).length, 1,
      'transcript の該当 text は通算 1 回(user_speech 再実行 0)');
    assert.equal(tasksWithCid(home, cidX).length, 1, 'X の task は通算 1 件(task 再実行 0)');
    assert.equal(
      parsedLines(home, 'metrics.jsonl').filter((m) => m.kind === 'turn_created' && m.turnId === ledgerTurnId).length, 1,
      'turn_created(X の turnId)は通算 1 行(Brain/turn 再実行 0)');
    const postRes = await rawRequest({ port, path: '/memo/api/log?after=0' });
    assert.equal(postRes.status, 200, `再送後の log API は 200: ${postRes.status} ${postRes.text.slice(0, 120)}`);
    assert.equal(JSON.parse(postRes.text).entries.filter((e) => matchesX(e, cidX, textX)).length, 1,
      'log API でも X は 1 件だけ');
    ok('AC-10 ② dedupe: 再起動を跨いで同 turnId・dedup 応答・side effect 各 1・再実行 0');
  });

  // ③ 同 X 別 text は 409
  await step('AC-10 ③ conflict', async () => {
    const conflict = await sayRaw(port, { text: `e2e AC-10 different text ${nonce}`, clientMessageId: cidX });
    assert.equal(conflict.status, 409, `同 id 別 text は 409 の契約: ${conflict.status}`);
    ok('AC-10 ③ conflict: 同 id 別 text は 409');
  });

  // ============ teardown: kill → exit イベント → port 解放 ============
  await step('teardown', async () => {
    await killRoom(room);
    await assertPortFree(port);
    ok('teardown: 部屋 kill → exit 確認 → port 解放');
  });

  clearTimeout(watchdog);
  if (failures.length) {
    console.error(`\nNG ${failures.length} 件: ${failures.join(' / ')}`);
    console.error(`(一時 HOME は診断用に残す: ${home})`);
    process.exitCode = 1;
  } else {
    rmSync(home, { recursive: true, force: true });
    console.log(`${passed} 検査すべて通過`);
  }
} catch (err) {
  console.error('FAIL:', err.message);
  const last = spawned.at(-1);
  if (last) console.error('--- 隔離部屋の出力(末尾)---\n' + last.output().slice(-3000));
  console.error(`(一時 HOME は診断用に残す: ${home})`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const r of spawned) {
    try { if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill('SIGKILL'); } catch { /* 既に死んでいる */ }
  }
}
