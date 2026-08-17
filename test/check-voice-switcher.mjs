// PBI-008 声スイッチャーの決定的検査(contract / unit)。実 API も稼働中の部屋(3300)/
// engine(10101)も使わない。Fish は fake サーバへ向け、時計は差し替えて cache / 上限 /
// cooldown を実時間なしで回す。画面 geometry と e2e は別ファイル(worker-f の holdout)。
// 実行: node test/check-voice-switcher.mjs
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Voice, FISH_MODEL_FREE } from '../src/voice.ts';
import { createVoiceSwitch } from '../src/voiceswitch.ts';
import { SpeechPlane, UserSpeechState } from '../src/convos/speech.ts';

// 本物のキーは絶対に書かない。上流の error body にも同じ値を混ぜて「持ち出していないか」を測る(AC-3)
const KEY_SENTINEL = 'KEY_SENTINEL_008';
const PREVIEW_TEXT = 'こんにちは、クロエだよ。';

const captured = [];
const realError = console.error;
console.error = (...a) => { captured.push(a.map(String).join(' ')); };

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

// ---- 道具 ----
function makeWav(ms = 40) {
  const rate = 8000, dataSize = Math.round((rate * ms) / 1000) * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1'); buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections?.(); server.close(); } });
  }));
}

// fake Fish。/model(候補)と /v1/tts(合成)の両方。plan で status を差し替える
function fishFake({ items = [], hasMore = () => false, modelStatus = () => 200, ttsStatus = () => 200, onTts = null } = {}) {
  const state = { modelQueries: [], ttsBodies: [], ttsHeaders: [], modelCalls: 0, hold: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/model') {
      state.modelCalls++;
      const page = Number(url.searchParams.get('page_number') ?? 1);
      state.modelQueries.push(Object.fromEntries(url.searchParams));
      if (state.hold) await state.hold;
      const st = modelStatus(state.modelCalls);
      if (st !== 200) {
        res.writeHead(st, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: `一覧が壊れた key=${KEY_SENTINEL}`, status: st }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items: items(page), has_more: hasMore(page) }));
    }
    if (url.pathname === '/v1/tts') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      state.ttsBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      state.ttsHeaders.push({ ...req.headers });
      if (onTts) onTts(state); // 送信「時点」の外の世界を観測する(WAL の write-ahead 検査)
      const st = ttsStatus(state.ttsBodies.length);
      if (st !== 200) {
        res.writeHead(st, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: `合成が壊れた key=${KEY_SENTINEL}`, status: st }));
      }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(makeWav());
    }
    res.writeHead(404); res.end('{}');
  });
  return { state, ready: listen(server) };
}

// 45 件を 20/20/5。重複 id・長大 title・takedown を混ぜる(AC-1)
const LONG_TITLE = 'あ'.repeat(400);
function pageItems(page) {
  const base = page === 1 ? 0 : page === 2 ? 20 : 40;
  const n = page === 3 ? 5 : 20;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ _id: `m${base + i}`, title: i === 0 ? LONG_TITLE : `声 ${base + i}`, tags: ['anime', 'jp'], languages: ['ja'], other: 'これは通してはいけない' });
  }
  out.push({ _id: `m${base}`, title: '重複(落ちるはず)', tags: [], languages: [] });          // ページ内の重複 id
  out.push({ _id: `td${page}`, title: 'takedown', dmca_taken_down: true, tags: [], languages: [] }); // takedown
  return out;
}

const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;
const voiceClock = { now, sleep: async () => {}, timeoutSignal: () => AbortSignal.timeout(4000) };

function makeSwitch(fishBase, { home, localSpeakers, previewFish, cloudCooldown, conversationBusy, lastUsed, onCommit, apiKey = KEY_SENTINEL } = {}) {
  const commits = [];
  const sw = createVoiceSwitch({
    fish: { apiKey, base: fishBase },
    previewFish: previewFish ?? (async () => ({ wav: makeWav(), reason: 'ok' })),
    localSynth: async () => makeWav(),
    localSpeakers: localSpeakers ?? (async () => [{ speakerId: 888753762, title: 'まお/あまあま' }]),
    cloudCooldown: cloudCooldown ?? (() => false),
    conversationBusy: conversationBusy ?? (() => null),
    lastUsed: lastUsed ?? (() => 'fish'),
    onCommit: onCommit ?? ((sel, rev) => commits.push({ sel, rev })),
    now,
    stateDir: home,
  });
  return { sw, commits };
}

// handle() を直接叩くための最小の req/res
function call(sw, method, pathname, { search = '', body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = { method, headers: {}, [Symbol.asyncIterator]: async function* () { yield* chunks; } };
    let code = 0, headers = {}, out = [];
    const res = {
      writeHead(c, h) { code = c; headers = h ?? {}; },
      end(d) {
        if (d) out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
        const buf = Buffer.concat(out);
        const isJson = String(headers['content-type'] ?? '').includes('json');
        resolve({ code, headers, buf, body: isJson ? JSON.parse(buf.toString() || '{}') : null });
      },
    };
    sw.handle(req, res, pathname, new URLSearchParams(search)).then((handled) => {
      if (!handled) resolve({ code: 0, headers: {}, buf: Buffer.alloc(0), body: null, unhandled: true });
    });
  });
}

const tmpHome = () => mkdtempSync(join(tmpdir(), 'claw-vs-'));

// ============================================================
async function main() {
  // ---- AC-1: voice-candidates-contract ----
  {
    const fake = fishFake({ items: pageItems, hasMore: (p) => p < 3 });
    const f = await fake.ready;
    const { sw } = makeSwitch(f.base, { home: tmpHome() });
    const seen = new Set();
    const counts = [];
    for (const page of [1, 2, 3]) {
      clock.t += 6 * 60_000; // page ごとに cache を跨がせる
      const r = await call(sw, 'GET', '/voice/api/candidates', { search: `page=${page}` });
      assert.equal(r.code, 200);
      const fish = r.body.candidates.filter((c) => c.provider === 'fish');
      counts.push(fish.length);
      for (const c of fish) seen.add(c.id);
      assert.equal(r.body.hasMore, page < 3, `page ${page} の hasMore`);
    }
    assert.deepEqual(counts, [20, 20, 5], `表示件数が 20/20/5 でない: ${counts}`);
    assert.equal(seen.size, 45, `45 件すべてが選択導線に載っていない: ${seen.size}`);
    assert.ok(![...seen].some((id) => id.startsWith('td')), 'takedown が出ている');
    // upstream が受け取った query は allowlist だけ
    const allowed = new Set(['page_size', 'page_number', 'sort_by', 'language', 'title', 'tag']);
    for (const q of fake.state.modelQueries) {
      for (const k of Object.keys(q)) assert.ok(allowed.has(k), `allowlist 外の query が上流へ: ${k}`);
      assert.equal(q.page_size, '20', 'page_size が 20 でない');
      assert.equal(q.sort_by, 'task_count');
      assert.equal(q.language, 'ja');
    }
    assert.deepEqual(fake.state.modelQueries.map((q) => q.page_number), ['1', '2', '3'], 'page_number が 1-origin でない');

    // 長大 title は切られ、上流の余計な field は 1 つも通らない
    clock.t += 6 * 60_000;
    const p1 = await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const long = p1.body.candidates.find((c) => c.title.startsWith('ああ'));
    assert.ok(long.title.length <= 80, `title が切られていない: ${long.title.length}`);
    assert.deepEqual(Object.keys(long).sort(), ['id', 'languages', 'provider', 'selected', 'tags', 'title'], 'allowlist 外の field が応答に出ている');

    // 検索と「全公開」切替も allowlist のまま通る
    clock.t += 6 * 60_000;
    await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1&title=anime&all=1' });
    const last = fake.state.modelQueries.at(-1);
    assert.equal(last.title, 'anime', '検索語が渡っていない');
    assert.ok(!('language' in last), '「全公開」でも language 制限が残っている');

    // ローカル話者はどのページでも出る & ページを跨いで重複しない(id が一意)
    const locals = p1.body.candidates.filter((c) => c.provider === 'local');
    assert.equal(locals.length, 1, 'ローカル話者が出ていない');
    f.close();
    ok('AC-1 voice-candidates-contract: 20/20/5・重複と takedown 0・1-origin・allowlist・45 件全部が選べる');
  }

  // ---- AC-2: voice-list-cache-fallback ----
  {
    // (a) fresh: 2 回目は upstream 0
    const fake = fishFake({ items: pageItems, hasMore: () => false });
    const f = await fake.ready;
    const { sw } = makeSwitch(f.base, { home: tmpHome() });
    await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const before = fake.state.modelCalls;
    clock.t += 60_000; // 5 分未満
    const fresh = await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });
    assert.equal(fake.state.modelCalls, before, '(a) fresh なのに upstream を叩いた');
    assert.equal(fresh.body.error, null, '(a) fresh で error が出ている');
    assert.equal(fresh.body.stale, false);
    assert.ok(fresh.body.candidates.some((c) => c.provider === 'fish'), '(a) fresh の候補が消えた');
    f.close();

    // (b) stale(>=5 分・保持あり)で再取得先が 503 → stale + local + error 1 行
    let failing = false;
    const fake2 = fishFake({ items: pageItems, hasMore: () => false, modelStatus: () => (failing ? 503 : 200) });
    const f2 = await fake2.ready;
    const { sw: sw2 } = makeSwitch(f2.base, { home: tmpHome() });
    await call(sw2, 'GET', '/voice/api/candidates', { search: 'page=1' });
    failing = true;
    clock.t += 6 * 60_000;
    const stale = await call(sw2, 'GET', '/voice/api/candidates', { search: 'page=1' });
    assert.equal(stale.body.stale, true, '(b) stale と表示されていない');
    assert.ok(stale.body.error, '(b) error 行が出ていない');
    assert.ok(stale.body.candidates.some((c) => c.provider === 'fish'), '(b) stale の保持を捨てている');
    assert.ok(stale.body.candidates.some((c) => c.provider === 'local'), '(b) ローカルが出ていない');
    f2.close();

    // (c) cache 無しで 503 → local only + error 1 行
    const fake3 = fishFake({ items: pageItems, modelStatus: () => 503 });
    const f3 = await fake3.ready;
    const { sw: sw3 } = makeSwitch(f3.base, { home: tmpHome() });
    const none = await call(sw3, 'GET', '/voice/api/candidates', { search: 'page=1' });
    assert.equal(none.body.candidates.filter((c) => c.provider === 'fish').length, 0, '(c) Fish 候補が出ている');
    assert.ok(none.body.candidates.some((c) => c.provider === 'local'), '(c) ローカルだけでも出ていない');
    assert.ok(none.body.error, '(c) error 行が出ていない');
    f3.close();

    // single-flight: 並行 2 要求で upstream は 1 本
    const fake4 = fishFake({ items: pageItems });
    const f4 = await fake4.ready;
    let release;
    fake4.state.hold = new Promise((r) => { release = r; });
    const { sw: sw4 } = makeSwitch(f4.base, { home: tmpHome() });
    const both = Promise.all([
      call(sw4, 'GET', '/voice/api/candidates', { search: 'page=1' }),
      call(sw4, 'GET', '/voice/api/candidates', { search: 'page=1' }),
    ]);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await both;
    assert.equal(fake4.state.modelCalls, 1, `single-flight が効いていない: upstream ${fake4.state.modelCalls} 本`);
    f4.close();
    ok('AC-2 voice-list-cache-fallback: fresh 0本 / stale+local+error / local only+error / 並行でも upstream 1 本');
  }

  // ---- AC-3: voice-secret-negative ----
  {
    const fake = fishFake({ items: pageItems, modelStatus: () => 500, ttsStatus: () => 500 });
    const f = await fake.ready;
    const home = tmpHome();
    const { sw } = makeSwitch(f.base, { home });
    const listed = await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });
    // 上流 error body(sentinel 入り)をそのまま返していないか
    assert.ok(!JSON.stringify(listed.body).includes(KEY_SENTINEL), '応答に sentinel が漏れている');

    // 未知 candidateId は 404 で、Fish へは 1 リクエストも出さない
    const ttsBefore = fake.state.ttsBodies.length;
    const unknownP = await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: 'fish:not-exists' } });
    const unknownS = await call(sw, 'POST', '/voice/api/select', { body: { candidateId: 'fish:not-exists' } });
    assert.equal(unknownP.code, 404, '未知 id の preview が 404 でない');
    assert.equal(unknownS.code, 404, '未知 id の select が 404 でない');
    assert.equal(fake.state.ttsBodies.length, ttsBefore, '未知 id で Fish へ送っている');

    // body は exact {candidateId} だけ。任意の text / model / URL は拒否
    for (const bad of [
      { candidateId: 'local:888753762', text: '好きな文を読ませる' },
      { candidateId: 'local:888753762', model: 's2.1-pro' },
      { candidateId: 'local:888753762', base: 'http://evil.example' },
      { text: 'x' },
      'not json',
      [1, 2],
    ]) {
      const r = await call(sw, 'POST', '/voice/api/preview', { body: bad });
      assert.equal(r.code, 400, `exact body 検査を通り抜けた: ${JSON.stringify(bad)}`);
    }
    // 4 面それぞれで sentinel 0 件(まとめて 1 変異で測らない)
    assert.ok(!JSON.stringify(listed.headers).includes(KEY_SENTINEL), 'header に sentinel');
    assert.ok(!captured.join('\n').includes(KEY_SENTINEL), 'server log に sentinel');
    const publicAssets = ['../public/room.js', '../public/index.html']
      .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
    assert.ok(!publicAssets.includes(KEY_SENTINEL), 'public asset に sentinel');
    await call(sw, 'POST', '/voice/api/select', { body: { candidateId: 'local:888753762' } });
    assert.ok(!readFileSync(join(home, 'voice.json'), 'utf8').includes(KEY_SENTINEL), 'voice.json に sentinel');
    f.close();
    ok('AC-3 voice-secret-negative: 未知 id は 404 で Fish 0・exact body・sentinel は 4 面すべてで 0 件');
  }

  // ---- AC-4: preview-budget-restart ----
  {
    const home = tmpHome();
    // 送信「時点」で台帳に既に行があるかを見る。これが write-ahead の本体 —
    // 件数だけ数えても、送信後に書く実装(= crash 窓が開く)は同じ数になって通ってしまう
    const walAtSend = [];
    const fake = fishFake({
      items: pageItems,
      onTts: () => {
        let lines = 0;
        try { lines = readFileSync(join(home, 'voice-preview.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { lines = 0; }
        walAtSend.push(lines);
      },
    });
    const f = await fake.ready;
    const voice = new Voice({ url: 'http://127.0.0.1:1', speaker: 1, speedScale: 1.05, enginePath: '/nope', provider: 'fish', fish: { apiKey: KEY_SENTINEL, base: f.base }, clock: voiceClock });
    const { sw } = makeSwitch(f.base, { home, previewFish: (ref, text) => voice.previewFish(ref, text) });
    await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });

    // 同一 candidate は 10 分 cache → Fish 1 回だけ
    const r1 = await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: 'm0' } });
    assert.equal(r1.code, 200);
    assert.equal(r1.headers['content-type'], 'audio/wav', '試聴が WAV で返っていない');
    await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: 'm0' } });
    await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: 'm0' } });
    assert.equal(fake.state.ttsBodies.length, 1, `同一 candidate で Fish を ${fake.state.ttsBodies.length} 回叩いた`);

    // 送っている中身: server 固定文・wav・header exact
    assert.equal(fake.state.ttsBodies[0].text, PREVIEW_TEXT, 'client の text を採用している / 固定文でない');
    assert.equal(fake.state.ttsBodies[0].format, 'wav');
    assert.equal(fake.state.ttsBodies[0].reference_id, 'm0');
    assert.equal(fake.state.ttsHeaders[0].model, FISH_MODEL_FREE, 'model header が無料固定でない');

    // 異なる candidate は 10 分 10 回まで。11 回目は 429 + retryAfterMs で Fish 0
    for (let i = 1; i < 10; i++) {
      const r = await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: `m${i}` } });
      assert.equal(r.code, 200, `${i} 件目が通らない`);
    }
    assert.equal(fake.state.ttsBodies.length, 10, '上限内の Fish 回数が合わない');
    const over = await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: 'm10' } });
    assert.equal(over.code, 429, '11 回目が 429 でない');
    assert.ok(over.body.retryAfterMs > 0, 'retryAfterMs が無い');
    assert.equal(fake.state.ttsBodies.length, 10, '429 なのに Fish へ送った');

    // 台帳は送信**前**・0600。件数は実 request と一致
    const wal = join(home, 'voice-preview.jsonl');
    const lines = readFileSync(wal, 'utf8').trim().split('\n');
    assert.equal(lines.length, 10, `WAL 行数が実 request と合わない: ${lines.length}`);
    assert.equal(statSync(wal).mode & 0o777, 0o600, 'WAL の権限が 0600 でない');
    // n 回目の送信が届いた時点で台帳には既に n 行ある = 送信前に書いている
    assert.deepEqual(walAtSend, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      `台帳が送信より後に書かれている(送信時点の行数: ${walAtSend})`);

    // 再起動しても直前 10 分の上限は復元する(in-memory だけだとここで通ってしまう)
    const { sw: sw2 } = makeSwitch(f.base, { home, previewFish: (ref, text) => voice.previewFish(ref, text) });
    await call(sw2, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const afterRestart = await call(sw2, 'POST', '/voice/api/preview', { body: { candidateId: 'm11' } });
    assert.equal(afterRestart.code, 429, '再起動で上限がリセットされている');
    assert.equal(fake.state.ttsBodies.length, 10, '再起動後に Fish へ送った');

    // 10 分過ぎれば窓が空く
    clock.t += 11 * 60_000;
    const reopened = await call(sw2, 'POST', '/voice/api/preview', { body: { candidateId: 'm11' } });
    assert.equal(reopened.code, 200, '窓が空いても通らない');

    // 台帳に書けないなら 503 + Fish 0(stateDir の親をファイルにして書込みを失敗させる)
    const blocked = join(tmpHome(), 'a-file');
    writeFileSync(blocked, 'not a dir');
    const { sw: sw3 } = makeSwitch(f.base, { home: join(blocked, 'sub'), previewFish: (ref, text) => voice.previewFish(ref, text) });
    await call(sw3, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const sent = fake.state.ttsBodies.length;
    const noLedger = await call(sw3, 'POST', '/voice/api/preview', { body: { candidateId: 'm5' } });
    assert.equal(noLedger.code, 503, '台帳に書けないのに 503 でない');
    assert.equal(fake.state.ttsBodies.length, sent, '台帳に書けないのに Fish へ送った');

    // model が壊れていたら PBI-007 と同じ fail-closed(Fish 0 回)
    const broken = new Voice({ url: 'http://127.0.0.1:1', speaker: 1, speedScale: 1, enginePath: '/nope', provider: 'fish', fish: { apiKey: KEY_SENTINEL, base: f.base, model: 's2.1-pro' }, clock: voiceClock });
    const { sw: sw4 } = makeSwitch(f.base, { home: tmpHome(), previewFish: (ref, text) => broken.previewFish(ref, text) });
    await call(sw4, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const before = fake.state.ttsBodies.length;
    const failClosed = await call(sw4, 'POST', '/voice/api/preview', { body: { candidateId: 'm0' } });
    assert.notEqual(failClosed.code, 200, '課金危険なのに試聴が通った');
    assert.equal(fake.state.ttsBodies.length, before, 'model が壊れているのに Fish へ送った');
    f.close();
    ok('AC-4 preview-budget-restart: 固定文/wav/header exact・同一は 1 回・11 回目 429・WAL 先行 0600・再起動で復元・fail-closed');
  }

  // ---- AC-5(server 側): preview-conversation-race ----
  {
    const fake = fishFake({ items: pageItems });
    const f = await fake.ready;
    let busy = null;
    const { sw } = makeSwitch(f.base, { home: tmpHome(), conversationBusy: () => busy });
    await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });
    busy = '読み上げ中';
    const sentBefore = fake.state.ttsBodies.length;
    const r = await call(sw, 'POST', '/voice/api/preview', { body: { candidateId: 'm0' } });
    assert.equal(r.code, 409, '会話中なのに試聴が通った');
    assert.equal(fake.state.ttsBodies.length, sentBefore, '会話中に Fish へ送った');
    f.close();

    // 会話用の slot を必ず 1 つ残す: maxConcurrent=2 なら試聴は同時 1 本まで
    const held = [];
    const holdServer = createServer((req, res) => { held.push(res); });
    const h = await listen(holdServer);
    const voice = new Voice({ url: 'http://127.0.0.1:1', speaker: 1, speedScale: 1, enginePath: '/nope', provider: 'fish', fish: { apiKey: KEY_SENTINEL, base: h.base, maxConcurrent: 2 }, clock: { now, sleep: async () => {}, timeoutSignal: () => AbortSignal.timeout(30_000) } });
    voice.previewFish('a', 'x'); voice.previewFish('b', 'x');
    await new Promise((r2) => setTimeout(r2, 80));
    assert.equal(held.length, 1, `試聴が会話用の slot を食い潰した(同時 ${held.length} 本)`);
    for (const res of held) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(makeWav()); }
    h.close();

    // 「待機時は conversation が preview より先に slot を得る」を**順序**で測る。
    // 予約(上限 max-1)だけを見る検査では、解放時に起こす順を逆にする変異が緑で通ってしまう(実測)。
    {
      const arrivals = [], parked = [];
      const holdSrv = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { arrivals.push(JSON.parse(body).text); parked.push(res); });
      });
      const hh = await listen(holdSrv);
      const v = new Voice({
        url: 'http://127.0.0.1:1', speaker: 1, speedScale: 1, enginePath: '/nope', provider: 'fish',
        fish: { apiKey: KEY_SENTINEL, base: hh.base, maxConcurrent: 2 },
        clock: { now, sleep: async () => {}, timeoutSignal: () => AbortSignal.timeout(30_000) },
      });
      const settle = () => new Promise((r2) => setTimeout(r2, 80));
      const swallow = (p) => { p.catch(() => {}); return p; };
      swallow(v.synthesizeWav('CONV-1')); swallow(v.synthesizeWav('CONV-2')); // slot を 2 つとも埋める
      await settle();
      assert.deepEqual(arrivals, ['CONV-1', 'CONV-2'], '前提: 会話 2 本で slot が埋まっていない');
      swallow(v.previewFish('ref', 'PREVIEW'));  // 試聴の上限は 1 なので待たされる
      await settle();
      swallow(v.synthesizeWav('CONV-3'));        // 会話の上限は 2 なので待たされる
      await settle();
      assert.equal(arrivals.length, 2, `上限を超えて送っている(${arrivals})`);
      // slot をちょうど 1 つ空ける。先に起きるのは**会話**でなければならない
      const first = parked.shift();
      first.writeHead(200, { 'content-type': 'audio/wav' });
      first.end(makeWav());
      await settle();
      assert.equal(arrivals[2], 'CONV-3',
        `解放された slot を試聴が先取りした(到着順 ${JSON.stringify(arrivals)})`);
      for (const res of parked) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(makeWav()); }
      await settle();
      hh.close();
    }
    ok('AC-5 preview-conversation-race(server): 会話中は 409 で Fish 0・試聴は会話用 slot を 1 つ残す・解放時は会話が先');
  }

  // ---- AC-6 / AC-7 / AC-11: turn snapshot・provider 切替・既定の不変 ----
  {
    const fake = fishFake({ items: pageItems });
    const f = await fake.ready;
    const synth = [];
    const voice = {
      lastUsed: 'fish',
      async synthesizeWav(text, speaker, snapshot) { synth.push({ text, speaker, snapshot }); return makeWav(); },
    };
    const store = { rows: [], append(e) { const ev = { id: this.rows.length + 1, at: new Date(clock.t).toISOString(), ...e }; this.rows.push(ev); return ev; } };
    const registry = { get: (pid) => ({ assignedName: pid, voice: { status: 'ready', resolvedSpeaker: 7 } }), alive: () => true };
    let snapshotFor = () => null;
    const plane = new SpeechPlane({
      store, registry, voice, putAudio: () => '/audio/1', isEngineReady: () => true,
      reportSynthResult: () => false, resolveVoice: async () => 7, metric: () => {},
      turnChannel: () => 'work', userSpeech: new UserSpeechState(),
      voiceSnapshot: (pid) => (pid === 'chloe' ? snapshotFor() : null),
    });

    // AC-11: 選択が無い間は snapshot=null(= PBI-007 の既定挙動そのまま)
    plane.speakSentences('chloe', 'クロエ', '既定の声。', 't0', 'work');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(synth.at(-1).snapshot, null, 'voice.json 無しで既定へ割り込んでいる');

    // AC-6: turn A を queue 済みにして選択を切替え、turn B を積む
    let old = { provider: 'fish', referenceId: 'OLD' };
    snapshotFor = () => old;
    plane.speakSentences('chloe', 'クロエ', 'A1 です。A2 です。', 'tA', 'work');
    old = { provider: 'fish', referenceId: 'NEW' };          // ここで選択が変わった
    plane.speakSentences('chloe', 'クロエ', 'B1 です。', 'tB', 'work');
    plane.speakSentences('worker', '作業係', 'W1 です。', 'tW', 'work');
    await new Promise((r) => setTimeout(r, 60));
    const a = synth.filter((s) => s.text.startsWith('A'));
    const b = synth.filter((s) => s.text.startsWith('B'));
    const w = synth.filter((s) => s.text.startsWith('W'));
    assert.equal(a.length, 2, 'turn A の文が 2 つ揃っていない');
    assert.ok(a.every((s) => s.snapshot.referenceId === 'OLD'), 'turn A に新しい声が混ざった(mid-turn 混在)');
    assert.ok(b.every((s) => s.snapshot.referenceId === 'NEW'), 'turn B に切替が効いていない');
    assert.ok(w.every((s) => s.snapshot === null), '他 participant の声を変えてしまった');

    // pool invalidation: 旧プールを捨てるので、新プールが出来るまで相槌は撃たれない
    plane.buildAckPool('chloe', 7);
    await new Promise((r) => setTimeout(r, 40));
    plane.invalidatePool('chloe');
    const before = store.rows.filter((e) => e.filler === 'ack').length;
    plane.fireAck('chloe', 'tC', 'これは十分に長い発話です');
    assert.equal(store.rows.filter((e) => e.filler === 'ack').length, before, '失効させたはずの旧プールで相槌が鳴った');

    // AC-7: Fish → local → Fish。local の turn は Fish reference を持たない
    snapshotFor = () => ({ provider: 'local', speakerId: 123 });
    plane.speakSentences('chloe', 'クロエ', 'ローカルの声。', 't2', 'work');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(synth.at(-1).snapshot, { provider: 'local', speakerId: 123 }, 'local 選択が turn に載っていない');
    snapshotFor = () => ({ provider: 'fish', referenceId: 'BACK' });
    plane.speakSentences('chloe', 'クロエ', 'また Fish。', 't3', 'work');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(synth.at(-1).snapshot.referenceId, 'BACK', 'Fish へ戻せていない');
    f.close();
    ok('AC-6/7/11 voice-turn-snapshot: turn A=old / turn B=new・他 participant 不変・旧プール失効・local↔Fish 往復・既定は null');
  }

  // AC-7 の実合成側: local 選択で Fish へ 0 リクエスト / Fish 選択で reference_id が exact 一致
  {
    const fake = fishFake({ items: pageItems });
    const f = await fake.ready;
    const engine = createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/audio_query') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ speedScale: 1 })); }
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(makeWav());
    });
    const e = await listen(engine);
    const voice = new Voice({ url: e.base, speaker: 1, speedScale: 1, enginePath: '/nope', provider: 'fish', fish: { apiKey: KEY_SENTINEL, base: f.base }, clock: voiceClock });
    await voice.synthesizeWav('ローカル', 9, { provider: 'local', speakerId: 555 });
    assert.equal(fake.state.ttsBodies.length, 0, 'local 選択なのに Fish へ送った');
    assert.equal(voice.lastUsed, 'local');
    await voice.synthesizeWav('フィッシュ', 9, { provider: 'fish', referenceId: 'exact-id-008' });
    assert.equal(fake.state.ttsBodies.at(-1).reference_id, 'exact-id-008', 'reference_id が選択と一致しない');
    assert.equal(voice.lastUsed, 'fish');
    e.close(); f.close();
    ok('AC-7 voice-provider-switch(合成): local は Fish 0 回・Fish は reference_id が exact 一致');
  }

  // ---- AC-8: voice-persist-atomic ----
  {
    const fake = fishFake({ items: pageItems });
    const f = await fake.ready;
    const home = tmpHome();
    const { sw, commits } = makeSwitch(f.base, { home });
    await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });

    // 同時 select 2 件 → 直列化され revision は単調増加
    const [s1, s2] = await Promise.all([
      call(sw, 'POST', '/voice/api/select', { body: { candidateId: 'm1' } }),
      call(sw, 'POST', '/voice/api/select', { body: { candidateId: 'm2' } }),
    ]);
    assert.deepEqual([s1.body.revision, s2.body.revision].sort(), [1, 2], `revision が単調でない: ${s1.body.revision}/${s2.body.revision}`);
    const file = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    assert.equal(file.version, 1);
    assert.equal(file.revision, 2, 'file の revision が現在値でない');
    assert.equal(statSync(join(home, 'voice.json')).mode & 0o777, 0o600, 'voice.json が 0600 でない');
    assert.equal(commits.length, 2, 'commit 通知が selected の回数と合わない');
    assert.ok(!existsSync(join(home, 'voice.json.tmp')), 'temp file が残っている');

    // 再起動で復元する
    const { sw: sw2 } = makeSwitch(f.base, { home });
    assert.equal(sw2.revision, 2, '再起動で revision が復元されない');
    assert.equal(sw2.snapshot().referenceId, file.selection.id, '再起動で選択が復元されない');

    // persist が失敗したら non-2xx で旧値のまま(memory を先に publish していたらここで通る)
    const blocked = join(tmpHome(), 'a-file');
    writeFileSync(blocked, 'not a dir');
    const { sw: sw3 } = makeSwitch(f.base, { home: join(blocked, 'sub') });
    await call(sw3, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const beforeSel = JSON.stringify(sw3.selection);
    const failed = await call(sw3, 'POST', '/voice/api/select', { body: { candidateId: 'm3' } });
    assert.ok(failed.code >= 400, 'persist 失敗なのに 2xx を返した');
    assert.equal(JSON.stringify(sw3.selection), beforeSel, 'persist 失敗なのに memory の選択が変わった');

    // 壊れた file / 未知 provider / 未知 schema は起動を止めず既定へ + 警告 1 行
    for (const [name, content] of [
      ['壊れた JSON', '{ not json'],
      ['未知 provider', JSON.stringify({ version: 1, revision: 3, selection: { provider: 'martian', id: 'x' } })],
      ['未知 schema', JSON.stringify({ version: 99, revision: 3, selection: { provider: 'fish', id: 'x' } })],
    ]) {
      const h = tmpHome();
      writeFileSync(join(h, 'voice.json'), content);
      const marker = captured.length;
      const { sw: bad } = makeSwitch(f.base, { home: h });
      assert.equal(bad.selection, null, `${name} で既定へ落ちていない`);
      assert.equal(bad.snapshot(), null, `${name} で snapshot が null でない`);
      assert.equal(captured.length - marker, 1, `${name} の警告が 1 行でない`);
    }

    // 消滅したローカル話者は既定へ戻す。ただし engine 不通(一覧が空)の時は選択を保持する
    const h2 = tmpHome();
    writeFileSync(join(h2, 'voice.json'), JSON.stringify({ version: 1, revision: 5, selection: { provider: 'local', speakerId: 999, title: '消えた声' } }));
    const { sw: gone } = makeSwitch(f.base, { home: h2, localSpeakers: async () => [{ speakerId: 1, title: '別の声' }] });
    await call(gone, 'GET', '/voice/api/candidates', { search: 'page=1' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gone.selection, null, '消滅したローカル話者を掴んだままになっている');
    const { sw: down } = makeSwitch(f.base, { home: h2, localSpeakers: async () => [] });
    await call(down, 'GET', '/voice/api/candidates', { search: 'page=1' });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(down.selection, 'engine 不通なだけで選択を捨てている');
    f.close();
    ok('AC-8 voice-persist-atomic: 直列化と単調 revision・0600・再起動復元・失敗時は旧値・壊れた file は既定 + 警告 1 行');
  }

  // ---- AC-9: voice-failure-matrix ----
  {
    // (c) cooldown 中は Fish の選択を 503 で拒み、現在の選択を変えない。local は選べる
    const fake = fishFake({ items: pageItems });
    const f = await fake.ready;
    let cooling = true;
    const { sw } = makeSwitch(f.base, { home: tmpHome(), cloudCooldown: () => cooling });
    await call(sw, 'GET', '/voice/api/candidates', { search: 'page=1' });
    const before = JSON.stringify(sw.selection);
    const refused = await call(sw, 'POST', '/voice/api/select', { body: { candidateId: 'm0' } });
    assert.equal(refused.code, 503, '(c) cooldown 中の Fish 選択が 503 でない');
    assert.equal(JSON.stringify(sw.selection), before, '(c) 拒否したのに選択が変わった');
    const localOk = await call(sw, 'POST', '/voice/api/select', { body: { candidateId: 'local:888753762' } });
    assert.equal(localOk.code, 200, '(c) cooldown 中にローカルまで選べなくなっている');
    f.close();

    // (b) 試聴の 404 は「その候補だけ」。通常会話の cooldown を汚さない
    const fake2 = fishFake({ items: pageItems, ttsStatus: () => 404 });
    const f2 = await fake2.ready;
    const voice = new Voice({ url: 'http://127.0.0.1:1', speaker: 1, speedScale: 1, enginePath: '/nope', provider: 'fish', fish: { apiKey: KEY_SENTINEL, base: f2.base }, clock: voiceClock });
    const { sw: sw2 } = makeSwitch(f2.base, { home: tmpHome(), previewFish: (ref, t) => voice.previewFish(ref, t) });
    await call(sw2, 'GET', '/voice/api/candidates', { search: 'page=1' });
    assert.equal(voice.diag.cooldownUntil, 0, '前提: cooldown は 0 から始まる');
    const bad = await call(sw2, 'POST', '/voice/api/preview', { body: { candidateId: 'm0' } });
    assert.equal(bad.code, 404, '(b) 試聴の 404 が候補固有になっていない');
    assert.equal(bad.headers['content-type'], 'application/json', '(b) 失敗なのに音を返している');
    assert.equal(voice.diag.cooldownUntil, 0, '(b) 試聴の失敗で通常会話の cooldown を汚した');
    assert.equal(voice.diag.cloudFailures, 0, '(b) 試聴の失敗を通常会話の失敗として数えた');
    f2.close();
    ok('AC-9 voice-failure-matrix: (b) 試聴 404 は候補固有で cooldown を汚さない・(c) cooldown 中は Fish 選択のみ 503');
  }


  // ---- PBI-029: 役ごとの声(クロエ / 実況)は互いに干渉しない ----
  {
    const fake = fishFake({ items: pageItems, hasMore: () => false });
    const f = await fake.ready;
    const homeA = tmpHome(), homeB = tmpHome();
    const { sw: chloe } = makeSwitch(f.base, { home: homeA });
    const { sw: narrator } = makeSwitch(f.base, { home: homeB });
    const localId = 'local:888753762';
    // 候補は「一度画面に出したもの」しか選べない(未知 id は 404)。役ごとに台帳も別
    await call(chloe, 'GET', '/voice/api/candidates');
    await call(narrator, 'GET', '/voice/api/candidates');

    const r = await call(narrator, 'POST', '/voice/api/select', { body: { candidateId: localId } });
    assert.equal(r.code, 200, `実況の声を選べない: ${JSON.stringify(r.body)}`);
    assert.ok(narrator.selection, '実況側に選択が残っていない');
    assert.equal(chloe.selection, null, '実況を選んだのにクロエまで変わった');
    assert.equal(chloe.snapshot(), null, 'クロエの snapshot が汚れた');
    assert.deepEqual(narrator.snapshot(), { provider: 'local', speakerId: 888753762 }, '実況の snapshot が出ない');

    // 保存先も別（再起動しても混ざらない）
    assert.ok(existsSync(join(homeB, 'voice.json')), '実況の選択が保存されていない');
    assert.ok(!existsSync(join(homeA, 'voice.json')), 'クロエ側にファイルが作られた');

    // 逆向きも同じ
    await call(chloe, 'POST', '/voice/api/select', { body: { candidateId: localId } });
    assert.ok(chloe.selection && narrator.selection, '両方が独立に保持されない');
    f.close();
    ok('PBI-029 役ごとの声は独立(選択・snapshot・保存先)');
  }

  console.log(`\n${passed} 検査 pass`);
}

main().then(
  () => { console.error = realError; process.exit(0); },
  (e) => {
    console.error = realError;
    console.error('\n❌ 失敗:', e.message);
    console.error(e.stack?.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  },
);
