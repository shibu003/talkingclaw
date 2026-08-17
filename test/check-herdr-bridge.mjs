// PBI-014: herdr 連携(声と画面から艦隊を見る・立てる・指示を渡す・様子を読む)。
// 稼働中の部屋(3300)にも本物の herdr にも 1 リクエストも出さない —— 空きポート + 一時 HOME +
// PATH ではなく HERDR_BIN で名指しした fake herdr だけを使う。
//
// 実行: node test/check-herdr-bridge.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

// fake AivisSpeech(部屋の起動時 /version だけ受ける)。本物の 10101 には出さない
async function engineFake() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('"fake"'); }
    if (u.pathname === '/speakers') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// 本物の herdr CLI を演じる。呼ばれた argv を全部 state に残すので、
// 「送ったつもり」ではなく「本当に送ったか / 送らなかったか」を痕跡で測れる
const FAKE_SRC = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const S = process.env.FAKE_HERDR_STATE;
const st = JSON.parse(readFileSync(S, 'utf8'));
const a = process.argv.slice(2);
st.calls.push(a);
// 本物は成功なら exit 0 + stdout、失敗なら exit 1 + JSON を stderr(2026-08-08 実測)。
// fake がここを取り違えると、実装が stderr を読み落としていても検査が緑になる(実際に一度そうなった)
const done = (o) => {
  writeFileSync(S, JSON.stringify(st));
  const s = JSON.stringify(o);
  if (o.error) { process.stderr.write(s); process.exit(1); }
  process.stdout.write(s); process.exit(0);
};
if (st.mode === 'down') done({ id: 'x', error: { code: 'server_not_running', message: 'no herdr server is running' } });
const cmd = a[0] + ' ' + a[1];
const find = (p) => st.agents.find((x) => x.pane_id === p);
if (cmd === 'agent list') done({ id: 'x', result: { agents: st.agents, type: 'agent_list' } });
// 本物の pane list は agent の居ないペインも返す(agent list との違いがここ)
if (cmd === 'pane list') done({ id: 'x', result: { panes: st.panes, type: 'pane_list' } });
if (cmd === 'pane split') {
  const base = a[2];
  const pane = base.split(':')[0] + ':p' + (st.nextPane++);
  const ci = a.indexOf('--cwd');
  st.lastCwd = ci >= 0 ? a[ci + 1] : null;
  st.panes.push({ pane_id: pane, workspace_id: pane.split(':')[0] });
  done({ id: 'x', result: { pane: { pane_id: pane } } });
}
if (cmd === 'agent start') {
  // 実物は、割った直後のペインに立てようとすると一度だけ busy を返すことがある(2026-08-08 実測)
  if (st.mode === 'busy_once' && !st.busyServed) { st.busyServed = true; done({ id: 'x', error: { code: 'agent_pane_busy', message: 'a pane is busy' } }); }
  const pane = a[a.indexOf('--pane') + 1];
  const terminal = 'term_' + pane.replace(':', '_') + '_' + (st.nextTerm++);
  st.agents.push({ pane_id: pane, workspace_id: pane.split(':')[0], agent_status: 'idle', name: a[2], terminal_id: terminal,
                   cwd: st.lastCwd || '/tmp', foreground_cwd: st.lastCwd || '/tmp', terminal_title_stripped: a[2] });
  done({ id: 'x', result: { agent: { pane_id: pane, name: a[2], terminal_id: terminal }, type: 'agent_started' } });
}
if (cmd === 'agent prompt') {
  const pane = a[2];
  if (st.mode !== 'silent') { st.echo[pane] = a[3]; const g = find(pane); if (g) g.agent_status = 'working'; }
  done({ id: 'x', result: { ok: true } });
}
// read だけは JSON ではなく画面の生テキストが返る(2026-08-08 実測)。fake も同じにする
if (cmd === 'agent read') {
  writeFileSync(S, JSON.stringify(st));
  process.stdout.write((st.echo[a[2]] || '') + '\\nFAKE-SCREEN-TAIL');
  process.exit(0);
}
if (cmd === 'agent get') {
  const g = find(a[2]);
  // 起動しきっていない状態を演じる(実物は interactive_ready がしばらく立たない)
  done({ id: 'x', result: { agent: g ? { ...g, interactive_ready: st.mode !== 'not_ready' } : null } });
}
if (cmd === 'pane close') { st.agents = st.agents.filter((x) => x.pane_id !== a[2]); done({ id: 'x', result: { ok: true } }); }
done({ id: 'x', error: { code: 'unknown_command', message: cmd } });
`;

const INITIAL = () => ({
  mode: 'ok', nextPane: 7, nextTerm: 1, echo: {}, calls: [], lastCwd: null,
  // 部屋が立てたのではない = ユーザーのペイン(台帳の外)。ここへの書込みは拒まれるのが正
  agents: [
    { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'working', name: 'sub', terminal_id: 'term_u1', cwd: '/Users/x/OhJOJO', foreground_cwd: '/Users/x/OhJOJO', terminal_title_stripped: '競合調査' },
    { pane_id: 'w2:p1', workspace_id: 'w2', agent_status: 'idle', terminal_id: 'term_u2', cwd: '/Users/x/talkingclaw', foreground_cwd: '/Users/x/talkingclaw', terminal_title_stripped: '部屋の開発' },
    { pane_id: 'w2:p2', workspace_id: 'w2', agent_status: 'working', name: 'brain', terminal_id: 'term_u3', cwd: '/Users/x/talkingclaw', foreground_cwd: '/Users/x/talkingclaw', terminal_title_stripped: '設計議論' },
  ],
  // pane list は agent の居ないペインも返す。w3:p1 は素のシェル(ここに立てられるのが正)
  panes: [
    { pane_id: 'w1:p2', workspace_id: 'w1' }, { pane_id: 'w2:p1', workspace_id: 'w2' },
    { pane_id: 'w2:p2', workspace_id: 'w2' }, { pane_id: 'w3:p1', workspace_id: 'w3' },
  ],
});

async function startRoom(herdrBin, statePath) {
  const home = mkdtempSync(join(tmpdir(), 'claw-herdr-home-'));
  const engine = await engineFake();
  const port = await freePort();
  const env = { ...process.env, HOME: home, PORT: String(port), NO_CHLOE: '1',
                TTS_URL: engine.base, FISH_API_KEY: 'HERDR_FAKE_KEY', FISH_API_BASE: engine.base,
                HERDR_BIN: herdrBin, FAKE_HERDR_STATE: statePath, HERDR_READY_WAIT_MS: '1500' };
  const proc = spawn(process.execPath, ['src/room.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('部屋が起動しない:\n' + out.slice(-800)); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })).status === 200) break; } catch { /* 起動待ち */ }
    await sleep(200);
  }
  const base = `http://127.0.0.1:${port}`;
  const page = await (await fetch(base + '/')).text();
  const token = (page.match(/[0-9a-f]{48}/) ?? [])[0];
  if (!token) { proc.kill('SIGKILL'); throw new Error('前提が壊れている: ページから token を取り出せない'); }
  const call = async (path, body, withToken = true) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(withToken ? { 'x-room-token': token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { base, home, call, stop: () => { try { proc.kill('SIGTERM'); } catch { /* */ } engine.close(); } };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-herdr-fake-'));
  const bin = join(dir, 'herdr');
  const statePath = join(dir, 'state.json');
  writeFileSync(bin, FAKE_SRC);
  chmodSync(bin, 0o755);
  writeFileSync(statePath, JSON.stringify(INITIAL()));
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const setState = (patch) => writeFileSync(statePath, JSON.stringify({ ...state(), ...patch }));
  const callsOf = (...prefix) => state().calls.filter((c) => prefix.every((p, i) => c[i] === p));

  const room = await startRoom(bin, statePath);
  const { call, home } = room;
  try {
    // ---- AC-1: 一覧(声の要約 + 画面の表)----
    {
      const r = await call('/herdr', { action: 'list' });
      const f = r.body.fleet;
      const mine = f?.agents?.find((a) => a.pane === 'w2:p2');
      if (r.status === 200 && f?.agents?.length === 3 && mine?.workspace === 'w2' && mine?.status === 'working' && mine?.name === 'brain' && mine?.mine === false) {
        ok('AC-1 一覧に名前・状態・居場所(workspace / pane)が揃う');
      } else fail('AC-1 一覧', JSON.stringify(r.body).slice(0, 300));
      if (/3 人/.test(r.body.note ?? '') && /動いている/.test(r.body.note ?? '')) ok('AC-1 声で読む文に実件数が入る(盛らない)');
      else fail('AC-1 声の文', r.body.note);
      const board = await call('/tasks', {});
      if (board.body.fleet?.agents?.length === 3) ok('AC-1 作業ボード(/tasks)にも同じ艦隊が載る = 画面の表の元データ');
      else fail('AC-1 board 反映', JSON.stringify(board.body.fleet));
    }
    // token gate の内側(EP-003 の恒久注意)
    {
      const r = await call('/herdr', { action: 'list' }, false);
      if (r.status === 401 || r.status === 403) ok('token 無しでは艦隊に触れない');
      else fail('token gate', String(r.status));
    }
    // ---- AC-2: 立てる(右に分割・workspace を守る・tab は作らない)----
    {
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'start', name: 'kohaku2', workspace: 'w2', project: 'talkingclaw' });
      const st = state();
      const split = st.calls.slice(before).find((c) => c[0] === 'pane' && c[1] === 'split');
      const started = st.calls.slice(before).find((c) => c[0] === 'agent' && c[1] === 'start');
      if (r.status === 200 && split && started) ok('AC-2 立てる → pane split と agent start が実際に走る');
      else fail('AC-2 起動', JSON.stringify({ status: r.status, note: r.body.note, split, started }).slice(0, 300));
      if (split && split[3] === '--direction' && split[4] === 'right') ok('AC-2 分割は右(--direction right)');
      else fail('AC-2 分割方向', JSON.stringify(split));
      if (split && split[2].startsWith('w2:')) ok('AC-2 指定した workspace(w2)のペインを割る — w1 に誤爆しない');
      else fail('AC-2 workspace 誤爆', JSON.stringify(split));
      if (split && split.includes('--no-focus')) ok('AC-2 --no-focus(ユーザーが見ている画面を勝手に切り替えない)');
      else fail('AC-2 focus 奪取', JSON.stringify(split));
      if (split && split[split.indexOf('--cwd') + 1] === REPO + '/') ok('AC-2 project 指定が新ペインの cwd になる');
      else fail('AC-2 cwd', JSON.stringify(split));
      if (started && started[2] === 'kohaku2' && started.includes('--kind') && started.includes('claude')) ok('AC-2 名前つきで claude を起動');
      else fail('AC-2 起動引数', JSON.stringify(started));
      if (callsOf('tab').length === 0) ok('AC-2 tab は 1 度も作らない(--workspace 忘れによる誤爆経路が実装に無い)');
      else fail('AC-2 tab 作成', JSON.stringify(callsOf('tab')));
      const owned = JSON.parse(readFileSync(join(home, '.talkingclaw', 'herdr-owned.json'), 'utf8'));
      if (Object.values(owned).some((v) => v.name === 'kohaku2' && v.at)) ok('AC-2 台帳に「部屋が立てた子」として名前と時刻が残る');
      else fail('AC-2 台帳', JSON.stringify(owned));
    }
    // agent が 1 人も居ない workspace(素のシェルだけ)にも立てられる。
    // 割り先を agent list から選ぶと、ここが永久に「ペインが無い」になる
    {
      const r = await call('/herdr', { action: 'start', name: 'kohaku-w3', workspace: 'w3' });
      const split = callsOf('pane', 'split').find((c) => c[2] === 'w3:p1');
      if (r.status === 200 && split) ok('AC-2 agent の居ない workspace(素のシェル)にも立てられる');
      else fail('AC-2 素のペイン', JSON.stringify({ status: r.status, note: r.body.note ?? r.body.error }));
    }
    // 名前は CLI の positional に入るので、- で始まる名前は受け取らない
    {
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'start', name: '--kind', workspace: 'w2' });
      const touched = state().calls.slice(before).some((c) => c[0] === 'pane' && c[1] === 'split');
      if (r.status === 400 && !touched) ok('AC-2 オプションに化ける名前は受け取らない(ペインも割らない)');
      else fail('AC-2 名前の検査', JSON.stringify({ status: r.status, touched }));
    }
    // 割った直後の busy は herdr の癖(実測)。一拍おいて立て直すまでが「立てる」
    {
      setState({ mode: 'busy_once', busyServed: false });
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'start', name: 'kohaku3', workspace: 'w2' });
      const after = state().calls.slice(before);
      const starts = after.filter((c) => c[0] === 'agent' && c[1] === 'start');
      const closed = after.some((c) => c[0] === 'pane' && c[1] === 'close');
      if (r.status === 200 && starts.length === 2 && !closed) ok('AC-2 割った直後の busy は一拍おいて立て直す(ペインを捨てない)');
      else fail('AC-2 busy リトライ', JSON.stringify({ status: r.status, starts: starts.length, closed, note: r.body.note }));
      setState({ mode: 'ok' });
    }
    // ---- AC-3: 指示を渡す(台帳内。read で裏取りしてから「渡した」と言う)----
    {
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'prompt', target: 'kohaku2', text: 'PBI-014 の受入表を作って' });
      const after = state().calls.slice(before);
      const pi = after.findIndex((c) => c[0] === 'agent' && c[1] === 'prompt');
      const ri = after.findIndex((c) => c[0] === 'agent' && c[1] === 'read');
      if (r.status === 200 && pi >= 0 && after[pi][3] === 'PBI-014 の受入表を作って') ok('AC-3 指示の実文がそのまま投入される');
      else fail('AC-3 投入', JSON.stringify({ status: r.status, note: r.body.note }).slice(0, 300));
      if (ri > pi && pi >= 0) ok('AC-3 投入のあとに read が走る(裏取りしてから報告)');
      else fail('AC-3 裏取り順', JSON.stringify(after.map((c) => c.slice(0, 2))));
      if (/渡した/.test(r.body.note ?? '')) ok('AC-3 反映を確認できたら「渡した」と言う');
      else fail('AC-3 文面', r.body.note);
    }
    // 裏取りが空振りする側(silent): 送れても「渡した」と言わない
    {
      setState({ mode: 'silent' });
      const r = await call('/herdr', { action: 'prompt', target: 'kohaku2', text: '静かな依頼' });
      const sent = callsOf('agent', 'prompt').some((c) => c[3] === '静かな依頼');
      if (r.status === 200 && sent && /確認できなかった|分からない/.test(r.body.note ?? '') && !/^.*渡した(?!か)/.test(r.body.note ?? '')) {
        ok('AC-3 反映を確認できない時は「届いたか分からない」と正直に返す');
      } else fail('AC-3 未確認の扱い', JSON.stringify({ sent, note: r.body.note }));
      setState({ mode: 'ok' });
    }
    // 起動しきっていない相手に投げると、入力欄に入らず消える(実測)。送る前に止める
    {
      setState({ mode: 'not_ready' });
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'prompt', target: 'kohaku2', text: 'まだ早い依頼' });
      const sent = state().calls.slice(before).some((c) => c[0] === 'agent' && c[1] === 'prompt');
      if (r.status === 400 && /起動中/.test(r.body.error ?? '') && !sent) ok('AC-3 起動しきっていない相手には送らない(消える投入を作らない)');
      else fail('AC-3 未 ready', JSON.stringify({ status: r.status, sent, err: r.body.error }));
      setState({ mode: 'ok' });
    }
    // ---- AC-4: 様子を読む ----
    {
      const r = await call('/herdr', { action: 'read', target: 'kohaku2' });
      if (r.status === 200 && /FAKE-SCREEN-TAIL/.test(r.body.note ?? '')) ok('AC-4 相手の画面の中身が返る');
      else fail('AC-4 read', JSON.stringify(r.body).slice(0, 200));
    }
    // ---- AC-5: ユーザーのペイン(台帳外)には書かない・読むのはできる ----
    {
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'prompt', target: 'brain', text: '台帳外への指示' });
      const sent = state().calls.slice(before).some((c) => c[0] === 'agent' && c[1] === 'prompt');
      if (r.status === 400 && /部屋が立てた子じゃない/.test(r.body.error ?? r.body.note ?? '')) ok('AC-5 台帳外への指示は理由つきで断る');
      else fail('AC-5 拒否', JSON.stringify(r.body).slice(0, 200));
      if (!sent) ok('AC-5 断った時は herdr に prompt を 1 度も渡していない(痕跡で確認)');
      else fail('AC-5 送信の痕跡', '拒否したはずなのに agent prompt が走った');
      const rr = await call('/herdr', { action: 'read', target: 'brain' });
      if (rr.status === 200 && /FAKE-SCREEN-TAIL/.test(rr.body.note ?? '')) ok('AC-5 台帳外でも読むことはできる');
      else fail('AC-5 読み取り', JSON.stringify(rr.body).slice(0, 200));
    }
    // ペインを閉じると id は再利用される。台帳が pane_id だけを見ていると、
    // 後から人が開いた別の端末を「自分の子」と誤認して指示を送ってしまう
    {
      const st = state();
      const mine = st.agents.find((a) => a.name === 'kohaku2');
      setState({ agents: st.agents.map((a) => (a.name === 'kohaku2' ? { ...a, terminal_id: 'term_someone_else', name: null } : a)) });
      const before = state().calls.length;
      const r = await call('/herdr', { action: 'prompt', target: mine.pane_id, text: '再利用されたペインへの指示' });
      const sent = state().calls.slice(before).some((c) => c[0] === 'agent' && c[1] === 'prompt');
      if (r.status === 400 && !sent) ok('AC-5 ペイン id が再利用されても、中身が別なら自分の子と認めない');
      else fail('AC-5 pane 再利用', JSON.stringify({ status: r.status, sent }));
    }
    // ---- AC-6: herdr が居ない時は黙って失敗しない ----
    {
      setState({ mode: 'down' });
      const r = await call('/herdr', { action: 'list' });
      if (r.status === 400 && /サーバが動いてない/.test(r.body.error ?? '')) ok('AC-6 サーバ不在 → 理由を言葉で返す');
      else fail('AC-6 サーバ不在', JSON.stringify(r.body).slice(0, 200));
      const s = await call('/herdr', { action: 'start', name: 'zzz', workspace: 'w2' });
      if (s.status === 400 && /サーバが動いてない/.test(s.body.error ?? '')) ok('AC-6 起動しようとしても同じ理由で止まる');
      else fail('AC-6 サーバ不在 start', JSON.stringify(s.body).slice(0, 200));
      setState({ mode: 'ok' });
    }
  } finally {
    room.stop();
  }
  // CLI 自体が居ない場合(別の部屋を立てる。HERDR_BIN を名指しした時に本物へ落ちないことも兼ねる)
  {
    const gone = await startRoom(join(dir, 'no-such-herdr'), statePath);
    try {
      const before = state().calls.length;
      const r = await gone.call('/herdr', { action: 'list' });
      if (r.status === 400 && /見つからない/.test(r.body.error ?? '')) ok('AC-6 CLI 不在 → 「見つからない」と伝える');
      else fail('AC-6 CLI 不在', JSON.stringify(r.body).slice(0, 200));
      if (state().calls.length === before) ok('AC-6 HERDR_BIN を名指ししたら他の herdr へは落ちない(本物を触らない)');
      else fail('AC-6 fallback', 'fake が呼ばれた = PATH 上の herdr に落ちる余地がある');
    } finally { gone.stop(); }
  }
  // ---- 画面の導線(ユーザーがボタンで見られて初めて完成)----
  {
    const html = readFileSync(join(REPO, 'public', 'index.html'), 'utf8');
    const js = readFileSync(join(REPO, 'public', 'room.js'), 'utf8');
    if (/id="fleetBtn"/.test(html) && /id="fleetList"/.test(html)) ok('画面: 艦隊の箱と「見る」ボタンが静的に置かれている');
    else fail('画面: 導線', 'index.html に fleetBtn / fleetList が無い');
    if (/getElementById\('fleetBtn'\)\.onclick/.test(js) && /post\('\/herdr'/.test(js)) ok('画面: ボタンが /herdr を叩く');
    else fail('画面: 配線', 'room.js のボタンが /herdr に繋がっていない');
    if (/renderFleet\(d\.fleet\)/.test(js)) ok('画面: 作業ボードの更新で艦隊も描き直す');
    else fail('画面: board 反映', 'refreshBoard から renderFleet を呼んでいない');
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} ok`);
  if (bad.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
