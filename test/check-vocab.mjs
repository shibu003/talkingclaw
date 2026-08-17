// PBI-024 の検査。src/vocab.ts は依存ゼロ・純関数なので直に叩ける。
// 守るもの: 拾う / 拾わない の境目(AC-1・AC-4・AC-5)、prompt の 1 行(AC-6)、
// 保存の round-trip(AC-7)、壊れたファイル(AC-8)、そして UI の配線。
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), 'claw-vocab-'));
process.env.HOME = HOME;

const V = await import('../src/vocab.ts');

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const t = (n, f) => { try { f(); ok(n); } catch (e) { fail(n, e.message); } };
const eq = (a, b, why) => { if (a !== b) throw new Error(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const truthy = (v, why) => { if (!v) throw new Error(why); };

const empty = V.emptyVocab();

t('AC-1 固有名詞らしい語を候補にする', () => {
  const c = V.candidates('GitHub の talkingclaw を見て', empty);
  truthy(c.includes('GitHub') && c.includes('talkingclaw'), c.join(','));
});

t('AC-4 一般語だけの発話は候補 0 件', () => {
  eq(V.candidates('確認して表示して', empty).length, 0, '一般語を拾った');
  eq(V.candidates('うん', empty).length, 0, '相槌を拾った');
  eq(V.candidates('', empty).length, 0, '空文字で拾った');
});

t('AC-4c 英字の一般語・検査由来は拾わない（Tier 1.6 は英字を通すので、ここが効く）', () => {
  eq(V.candidates('hello world not found', empty).length, 0, '英語の一般語を拾った');
  eq(V.candidates('img src onerror alert', empty).length, 0, '検査由来の断片を拾った');
  eq(V.candidates('Can you hear me', empty).length, 0, '英語の平文を拾った');
  eq(V.candidates('hang__ askperm__ を試す', empty).length, 0, '検査の口を拾った');
  // 対して、本物の固有名詞は通る（この検査が「英字を全部捨てる」に退化していないこと）
  truthy(V.candidates('GitHub と MCP', empty).length === 2, '固有名詞まで落ちている');
  // 大文字small文字の違いで抜けない
  eq(V.candidates('HELLO NOT FOUND', empty).length, 0, '大文字だと抜けた');
});

t('PBI-026 カタカナの固有名詞は拾う（実測で再現率 64.3% → 92.9%）', () => {
  truthy(V.candidates('テトリスやろう', empty).includes('テトリス'), '拾えていない');
  truthy(V.candidates('ポニーテールにした', empty).includes('ポニーテール'), '拾えていない');
});

t('PBI-026 一般外来語・部屋の道具の名前は拾わない', () => {
  eq(V.candidates('プロジェクトの進捗をレポートして', empty).length, 0, '一般外来語を拾った');
  eq(V.candidates('ポーカーやろう', empty).length, 0, '部屋のゲーム名を拾った');
  eq(V.candidates('ブラックジャックのディーラー', empty).length, 0, '部屋の道具を拾った');
});

t('PBI-026 カタカナ 2 字は拾わない（短い語は雑音）', () => {
  eq(V.candidates('メモ を見て', empty).length, 0, '2 字を拾った');
});

t('AC-4b 漢字だけの語は拾わない（適合率 1.2% と実測した層）', () => {
  eq(V.candidates('今日の進捗と作業の状況', empty).length, 0, '漢字語を拾った');
});

t('麻雀の手筋は拾わない（実データの 4 割を占めていた）', () => {
  eq(V.candidates('九萬切', empty).length, 0, '手筋を拾った');
  eq(V.candidates('オールイン', empty).length, 0, 'ポーカーの行動を拾った');
});

t('AC-5 覚えた語・断った語はもう候補に出ない', () => {
  const v1 = V.rememberWord(empty, 'GitHub');
  eq(V.candidates('GitHub を見て', v1).length, 0, '覚えた語をまた聞いた');
  const v2 = V.ignoreWord(empty, 'GitHub');
  eq(V.candidates('GitHub を見て', v2).length, 0, '断った語をまた聞いた');
});

t('AC-5b 辞書に在る語も「既知」として扱う', () => {
  eq(V.candidates('talkingclaw を見て', empty, ['talkingclaw']).length, 0, '辞書の語を聞いた');
});

t('覚える / 断る は互いに打ち消す', () => {
  let v = V.rememberWord(empty, 'MCP');
  v = V.ignoreWord(v, 'MCP');
  truthy(!v.known.includes('MCP') && v.ignored.includes('MCP'), JSON.stringify(v));
  v = V.rememberWord(v, 'MCP');
  truthy(v.known.includes('MCP') && !v.ignored.includes('MCP'), JSON.stringify(v));
});

t('AC-6 prompt の 1 行（語が無ければ空文字）', () => {
  eq(V.promptLine(empty), '', '語ゼロで行を作った');
  const line = V.promptLine(V.rememberWord(empty, 'GitHub'));
  truthy(line.includes('GitHub'), line);
  truthy(line.split('\n').length === 2, '1 行の説明 + 語の行、の形になっていない');
});

t('AC-6b prompt に入る語数に上限がある', () => {
  let v = empty;
  for (let i = 0; i < 100; i++) v = V.rememberWord(v, `Word${i}`);
  const words = V.promptLine(v, 40).split('\n')[1].split(' / ');
  eq(words.length, 40, '上限が効いていない');
});

t('AC-1/AC-7 観測 → 決める → 保存 → 読み直し', () => {
  eq(homedir(), HOME, '前提: HOME が隔離されている');
  V.resetVocabCache(V.emptyVocab());
  const found = V.observeText('GitHub と MCP を見て');
  truthy(found.includes('GitHub'), found.join(','));
  truthy(V.pendingWords().includes('MCP'), '候補が溜まらない');
  V.decide('GitHub', 'remember');
  V.decide('MCP', 'ignore');
  eq(V.pendingWords().length, 0, '決めた語が候補に残っている');
  V.resetVocabCache();                       // cache を捨ててファイルから
  const back = V.currentVocab();
  truthy(back.known.includes('GitHub'), '覚えた語が残っていない');
  truthy(back.ignored.includes('MCP'), '断った語が残っていない');
});

t('AC-8 壊れた vocab.json でも空から始まる（会話は無傷）', () => {
  writeFileSync(V.vocabPath(), '{ broken');
  V.resetVocabCache();
  eq(V.currentVocab().known.length, 0, '壊れたファイルから語を作った');
});

t('AC-1 決定的（同じ入力 → 同じ候補）', () => {
  const a = V.candidates('GitHub と MCP', empty).join(',');
  const b = V.candidates('GitHub と MCP', empty).join(',');
  eq(a, b, '揺れる');
});

// ---- 配線 ----
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const roomJs = readFileSync(join(ROOT, 'public/room.js'), 'utf8');
const roomTs = readFileSync(join(ROOT, 'src/room.ts'), 'utf8');

t('AC-2/AC-3 候補が無い時は出ない場所に置いてある（会話ログを覆わない）', () => {
  truthy(html.includes('<div id="vocabBar" hidden'), '既定で hidden になっていない');
  truthy(html.indexOf('id="vocabBar"') < html.indexOf('id="composer"'), 'composer より下に在る');
  truthy(roomJs.includes('vocabBar.hidden = words.length === 0;'), '空の時に隠していない');
});

t('AC-2 ✓ と ✕ の両方の導線がある', () => {
  truthy(roomJs.includes("action: 'remember'"), '覚える導線が無い');
  truthy(roomJs.includes("action: 'ignore'"), '断る導線が無い');
});

t('サーバ: GET はゲートの手前、POST は後ろ', () => {
  const gate = roomTs.indexOf("if (req.method !== 'POST') return json(res, 404");
  const get = roomTs.indexOf("req.method === 'GET' && path === '/vocab'");
  const post = roomTs.indexOf("if (path === '/vocab') {");
  truthy(get > 0 && get < gate, 'GET /vocab がゲートより後ろ（404 になる）');
  truthy(post > gate, 'POST /vocab がゲートより前');
});

t('AC-6 prompt に実際に差し込んでいる', () => {
  truthy(roomTs.includes('promptLine(currentVocab())'), 'contextPrefix に入っていない');
});

t('AC-9 実行時依存を増やしていない', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // ブラウザにしか行かない描画系（import map で配るだけで、サーバは require しない）は数えない。
  // **列挙で持つ**（前方一致にすると「three-なんとか」を足した時に黙って通る）
  const BROWSER_ONLY = ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation'];
  const server = Object.keys(pkg.dependencies ?? {}).filter((d) => !BROWSER_ONLY.includes(d));
  eq(server.length, 3, `サーバ側の依存が ${server.length} 個: ${server.join(',')}`);
  // 除外した物が本当にブラウザ専用か（サーバのコードが import していないこと）
  const srcAll = ['src/room.ts', 'src/vocab.ts', 'src/persona.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  for (const d of BROWSER_ONLY) truthy(!srcAll.includes(`from '${d}`), `${d} をサーバが import している（除外の前提が崩れた）`);
  // vocab.ts が読んでよいのは node: 組み込みだけ（相対 import も外部 package も無い）
  const imports = [...readFileSync(join(ROOT, 'src/vocab.ts'), 'utf8').matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1]);
  truthy(imports.length > 0, 'import を 1 つも読み取れていない（検査が空振り）');
  truthy(imports.every((i) => i.startsWith('node:')), `node: 以外を import している: ${imports.join(',')}`);
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
