// PBI-002 伝言受け口の決定的検査。Brain も room も呼ばず、DI の fake だけで AC を通す。
// 実行: node test/check-memo.mjs
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createMemoHandler } from '../src/memo.ts';

const dir = mkdtempSync(join(tmpdir(), 'memo-test-'));
const logPath = join(dir, 'memo-log.jsonl');
const pagePath = new URL('../public/memo.html', import.meta.url).pathname;

function makeDeps({ submitDelay = 0 } = {}) {
  const calls = [];
  const metrics = [];
  const listeners = [];
  const deps = {
    submit: async ({ text, clientMessageId }) => {
      calls.push({ text, clientMessageId });
      if (submitDelay) await new Promise((r) => setTimeout(r, submitDelay));
      return { turnId: 'T-' + clientMessageId.slice(0, 6) };
    },
    read: { subscribe: (cb) => { listeners.push(cb); return () => {}; } },
    recordMetric: (m) => metrics.push(m),
    identity: () => 'test@example.com',
    logPath,
    pagePath,
  };
  return { deps, calls, metrics, emit: (e) => listeners.forEach((cb) => cb(e)) };
}

function serve(handler) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handled = await handler.handle(req, res, url.pathname, url.searchParams);
    if (!handled) { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
  }));
}

const say = (base, body) => fetch(base + '/memo/api/say', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

// --- AC-1: say-once ---
{
  const { deps, calls, metrics, emit } = makeDeps();
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const r = await say(base, { text: '棚卸しやっといて', clientMessageId: 'cid-ac1-0001' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.messageId >= 1 && out.turnId.startsWith('T-'));
  assert.equal(calls.length, 1);
  assert.equal(metrics.filter((m) => m.kind === 'turn_created' && m.path === 'memo').length, 1);
  const rows = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.kind), ['intent', 'memo']); // write-ahead → 確定 の順
  ok('AC-1 say-once: submit 1 回・intent+memo の 2 行・metric turn_created');

  // --- 002-F1: 同じ id を別内容で再送 → 409・副作用ゼロ ---
  const conflict = await say(base, { text: '別の内容', clientMessageId: 'cid-ac1-0001' });
  assert.equal(conflict.status, 409);
  assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
  assert.equal(calls.length, 1);
  ok('002-F1 conflict: 同 id 別内容は 409・既存 id を返さない・記録増ゼロ');

  // --- AC-3: cursor-no-dup(返答 5 件 → after で増分だけ) ---
  for (let i = 1; i <= 5; i++) emit({ kind: 'reply', text: '返答' + i, name: 'クロエ' });
  const all = await (await fetch(base + '/memo/api/log?after=0')).json();
  assert.equal(all.entries.length, 6); // memo 1 + reply 5
  const third = all.entries[2].id;
  const inc = await (await fetch(base + '/memo/api/log?after=' + third)).json();
  assert.deepEqual(inc.entries.map((e) => e.text), ['返答3', '返答4', '返答5']);
  assert.ok(inc.entries.every((e, i, a) => i === 0 || a[i - 1].id < e.id));
  ok('AC-3 cursor-no-dup: 増分・昇順・重複なし');

  // --- AC-8: correlation-end-to-end(報告に相関 id が残る) ---
  emit({ kind: 'report', text: '棚卸し終わったよ', name: 'クロエ', sourceTurnId: out.turnId, clientMessageId: 'cid-ac1-0001' });
  const withReport = await (await fetch(base + '/memo/api/log?after=0')).json();
  const report = withReport.entries.find((e) => e.kind === 'report');
  assert.equal(report.sourceTurnId, out.turnId);
  assert.equal(report.clientMessageId, 'cid-ac1-0001');
  ok('AC-8 correlation: 報告が伝言と同じ相関 id を持つ');
  close();
}

// --- AC-2: idempotent-restart(再起動後の再送は二重発注しない) ---
{
  const { deps, calls } = makeDeps();
  const h = createMemoHandler(deps); // 同じ logPath から台帳復元
  const { base, close } = await serve(h);
  const r = await say(base, { text: '棚卸しやっといて', clientMessageId: 'cid-ac1-0001' });
  const out = await r.json();
  assert.equal(r.status, 200);
  assert.equal(out.dedup, true);
  assert.equal(calls.length, 0); // 新しい fake の submit は一度も呼ばれない
  ok('AC-2 idempotent-restart: 再起動後の同 id 再送で submit 0 回');
  close();
}

// --- AC-2: idempotent-parallel(並行 2 POST は in-flight 共有) ---
{
  const { deps, calls } = makeDeps({ submitDelay: 60 });
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const [a, b] = await Promise.all([
    say(base, { text: '並行テスト', clientMessageId: 'cid-par-0001' }).then((r) => r.json()),
    say(base, { text: '並行テスト', clientMessageId: 'cid-par-0001' }).then((r) => r.json()),
  ]);
  assert.equal(a.turnId, b.turnId);
  assert.equal(a.messageId, b.messageId);
  assert.equal(calls.length, 1);
  ok('AC-2 idempotent-parallel: 並行同 id で submit 1 回・同一応答');
  close();
}

// --- AC-4: restart-restore(再起動後もタイムラインが読める) ---
{
  const { deps } = makeDeps();
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const log = await (await fetch(base + '/memo/api/log?after=0')).json();
  assert.ok(log.entries.length >= 7); // memo1 + reply5 + report1(前段の永続分)
  assert.ok(log.entries.some((e) => e.kind === 'report'));
  ok('AC-4 restart-restore: 再起動後に伝言タイムライン復元');
  close();
}

// --- AC-7: reject-invalid(不正入力は 4xx・副作用ゼロ) ---
{
  const { deps, calls, metrics } = makeDeps();
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const before = readFileSync(logPath, 'utf8').trim().split('\n').length;
  assert.equal((await say(base, { text: '   ', clientMessageId: 'cid-bad-0001' })).status, 400);
  assert.equal((await say(base, { text: 'あ'.repeat(4001), clientMessageId: 'cid-bad-0002' })).status, 400);
  assert.equal((await say(base, '{broken json')).status, 400);
  assert.equal((await say(base, { text: 'id が変', clientMessageId: 'x' })).status, 400);
  assert.equal((await say(base, { text: 'id が無い' })).status, 400);
  const after = readFileSync(logPath, 'utf8').trim().split('\n').length;
  assert.equal(before, after);
  assert.equal(calls.length, 0);
  assert.equal(metrics.length, 0);
  ok('AC-7 reject-invalid: 5 種の不正入力すべて 4xx・ログ/metric/submit 増加ゼロ');
  close();
}

// --- 送信失敗時: 502。intent(試行の証跡)だけ残り、memo 確定行は増えない(AC-5 の server 側 + 002-F1) ---
{
  const { deps } = makeDeps();
  deps.submit = async () => { throw new Error('部屋が応答しない'); };
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const countKind = (k) => readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === k).length;
  const memoBefore = countKind('memo');
  const intentBefore = countKind('intent');
  const r = await say(base, { text: '届かない伝言', clientMessageId: 'cid-dwn-0001' });
  assert.equal(r.status, 502);
  assert.equal(countKind('memo'), memoBefore);          // 確定行は増えない
  assert.equal(countKind('intent'), intentBefore + 1);  // 試行の証跡は残る(crash window の観測点)
  // 失敗した id は台帳に残らない = 復旧後の再送で受理される
  deps.submit = async () => ({ turnId: 'T-recover' });
  const retry = await say(base, { text: '届かない伝言', clientMessageId: 'cid-dwn-0001' });
  assert.equal(retry.status, 200);
  ok('AC-5(server)+002-F1: submit 失敗は 502・intent 証跡のみ・復旧後の同 id 再送は成功');
  close();
}

// --- 002-F1: crash window(intent あり・memo 無し)からの再送 — submit は再実行され memo は 1 行に確定 ---
{
  const { deps, calls } = makeDeps();
  const h = createMemoHandler(deps); // 直前 block の 'cid-dwn-0001' 成功後の状態から
  const { base, close } = await serve(h);
  // 別 id で crash window を人工再現: intent だけをログに直接積む(submit 直前で落ちた形)
  const { appendFileSync } = await import('node:fs');
  appendFileSync(logPath, JSON.stringify({ id: 9000, at: new Date().toISOString(), kind: 'intent', text: '落ちた伝言', clientMessageId: 'cid-crs-0001' }) + '\n');
  const h2 = createMemoHandler(deps);
  const { base: base2, close: close2 } = await serve(h2);
  const r = await say(base2, { text: '落ちた伝言', clientMessageId: 'cid-crs-0001' });
  assert.equal(r.status, 200);
  const memoRows = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'memo' && x.clientMessageId === 'cid-crs-0001');
  assert.equal(memoRows.length, 1); // 確定は 1 行だけ(submit 側の重複排除は room adapter の契約 = PBI-003 AC)
  ok('002-F1 crash-window: intent 残存からの再送で memo 確定は 1 行');
  close(); close2();
}

// --- G2-F1: in-flight の同 id・別 text 並行は片方 409(Promise を共有しない) ---
{
  const { deps, calls } = makeDeps({ submitDelay: 60 });
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const [a, b] = await Promise.all([
    say(base, { text: '内容A', clientMessageId: 'cid-rac-0001' }),
    new Promise((r) => setTimeout(r, 10)).then(() => say(base, { text: '内容B', clientMessageId: 'cid-rac-0001' })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '内容A');
  const memoRows = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'memo' && x.clientMessageId === 'cid-rac-0001');
  assert.equal(memoRows.length, 1);
  assert.equal(memoRows[0].text, '内容A');
  ok('G2-F1 race: in-flight 同 id 別内容は 409・submit 1 回・memo は A の 1 件');
  close();
}

// --- G2-F3: identity の HTML raw 挿入を塞ぐ(JSON リテラル + textContent) ---
{
  const { deps } = makeDeps();
  deps.identity = () => '<img src=x onerror=alert(1)>';
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const html = await (await fetch(base + '/memo')).text();
  assert.ok(!html.includes('<img src=x'), 'raw タグが HTML に入らない');
  assert.ok(html.includes('\\u003c'), '< は \\u003c として JSON リテラル内に隔離される');
  ok('G2-F3 identity-xss: raw タグ 0・JSON リテラル隔離・表示は textContent');
  close();
}

// --- G2-F4: replacement token($& 等)を含む identity でページが壊れない ---
{
  const { deps } = makeDeps();
  deps.identity = () => 'a$&b$`c';
  const h = createMemoHandler(deps);
  const { base, close } = await serve(h);
  const html = await (await fetch(base + '/memo')).text();
  assert.ok(html.includes('const MEMO_USER = "a$&b$`c";'), '$& が展開されず JSON リテラルがそのまま入る');
  assert.ok(!html.includes('"__MEMO_USER_JSON__"'), '置換対象(二重引用符形)は消えている(単引用符のフォールバック判定は残ってよい)');
  ok('G2-F4 replace-token: $& 入り identity でも script が壊れない');
  close();
}

// --- G2-F2: 相関の画面表示 — entryLabel をページから抽出して X/Z/Y シナリオを検証 ---
{
  const html = readFileSync(pagePath, 'utf8');
  const m = html.match(/\/\/ __ENTRY_LABEL_START__([\s\S]*?)\/\/ __ENTRY_LABEL_END__/);
  assert.ok(m, 'entryLabel がマーカー付きで存在する');
  const entryLabel = new Function(m[1] + '; return entryLabel;')();
  const seq = new Map();
  const seqOf = (cid, lookupOnly) => {
    if (!seq.has(cid)) { if (lookupOnly) return null; seq.set(cid, seq.size + 1); }
    return seq.get(cid);
  };
  assert.equal(entryLabel({ kind: 'memo', clientMessageId: 'X' }, seqOf), 'あなた · 伝言#1');
  assert.equal(entryLabel({ kind: 'memo', clientMessageId: 'Z' }, seqOf), 'あなた · 伝言#2');
  assert.equal(entryLabel({ kind: 'memo', clientMessageId: 'Y' }, seqOf), 'あなた · 伝言#3'); // consult 確認
  assert.equal(entryLabel({ kind: 'report', name: 'クロエ', clientMessageId: 'X' }, seqOf), 'クロエ の作業報告 → 伝言#1');
  assert.equal(entryLabel({ kind: 'report', name: 'クロエ', clientMessageId: 'Z' }, seqOf), 'クロエ の作業報告 → 伝言#2');
  // 報告は root(X/Z)にのみ帰属し、確認 Y(#3)への帰属表示は作られない
  assert.equal(entryLabel({ kind: 'report', name: 'クロエ', clientMessageId: 'unknown' }, seqOf), 'クロエ の作業報告');
  assert.ok(![...seq.keys()].includes('unknown'), '未知 id に番号を発行しない');
  assert.ok(/meta\.textContent = entryLabel/.test(html), 'render は entryLabel を textContent 経由で使う');
  ok('G2-F2 correlation-ui: 報告が root 伝言#n に帰属表示・Y へ誤帰属しない');
}

// --- AC-6 / AC-5(page): 静的検査 — innerHTML 不使用・SR フォールバック・ack まで入力保持 ---
{
  const html = readFileSync(pagePath, 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(html), 'ページは innerHTML 系を使わない');
  assert.ok(/textContent/.test(html));
  assert.ok(/SpeechRecognition/.test(html) && /hidden/.test(html), 'SR feature detect とフォールバックがある');
  assert.ok(/out\.messageId/.test(html), 'server ack(messageId)確認後にだけ入力を消す');
  ok('AC-6/AC-5(page): textContent 描画・SR フォールバック・ack 前は入力保持');
}

console.log(`\n${passed} 検査すべて通過`);
