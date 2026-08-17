// PBI-013: 相談で合意した案 → backlog/ の G1 PBI。稼働中の部屋には触らない(一時ディレクトリだけ)。
//
// 実行: node test/check-plan-to-pbi.mjs
//
// AC-4(採番の衝突)は本物のプロセスを 4 つ並べて当てる —— 同一プロセス内で順に呼んでも
// 「読んでから書くまでの隙間」は再現しないので、wx の効き目を確かめたことにならない。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextPbiNo, pbiMarkdown, writePbi, UNDECIDED } from '../src/planpbi.ts';

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
// maintainer の個人環境にしか無いものへの依存は skip にする。落とすと、外部からの PR が
// 自分の変更と無関係な理由で必ず赤くなる(2026-08-15: CI がこれで赤かった)
const skip = (n, why) => { results.push({ n, ok: true, skipped: true }); console.log('skip    -', n, ':', why); };
const t = (n, f) => { try { f(); ok(n); } catch (e) { fail(n, e.message); } };
const eq = (a, b, why) => { if (a !== b) throw new Error(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const has = (s, needle, why) => { if (!s.includes(needle)) throw new Error(`${why}: "${needle}" が無い`); };

const TODAY = '2026-08-08';
const MOD = fileURLToPath(new URL('../src/planpbi.ts', import.meta.url));

// 既存 backlog を模した箱。3 桁と 1 桁が混ざっているのが実物と同じ条件
function fakeBacklog(names = ['PBI-001-a.md', 'PBI-020-b.md', 'PBI-4-old.md', 'README.md']) {
  const dir = mkdtempSync(join(tmpdir(), 'claw-pbi-'));
  const backlog = join(dir, 'backlog');
  mkdirSync(backlog);
  for (const n of names) writeFileSync(join(backlog, n), 'status: done\n');
  return { root: dir, backlog };
}

// ---- AC-1: G1 雛形が生成され、番号は 3 桁の max+1 ----
t('AC-1 採番は 3 桁の max+1(1 桁の PBI-4 は無視)', () => {
  const { backlog } = fakeBacklog();
  eq(nextPbiNo(backlog), 21, '次の番号');
  const file = writePbi(backlog, { summary: '帯を出す', steps: ['a', 'b'] }, TODAY);
  eq(file.startsWith('PBI-021-'), true, `生成ファイル名(${file})`);
});

t('AC-1 G1 の 5 区画が全部ある', () => {
  const md = pbiMarkdown({ summary: 's', steps: ['x'] }, '021', TODAY);
  for (const h of ['# 受入基準(SBE)', '# テスト設計', '# 不確実性と検証', '# スコープ外', 'OBSERVE:']) {
    has(md, h, 'G1 区画');
  }
  has(md, '| # | Given | When | Then |', 'SBE 表のヘッダ');
});

// ---- AC-2: 相談で決まった条件が入る / 埋まらない欄は明示 ----
t('AC-2 accept が SBE の Then になる', () => {
  const md = pbiMarkdown({ summary: 's', steps: ['手順1'], accept: ['帯が見える', '押すと止まる'] }, '021', TODAY);
  has(md, '| AC-1 |', 'AC 行');
  has(md, '帯が見える', 'accept 1 件目');
  has(md, '押すと止まる', 'accept 2 件目');
  eq(md.includes('| AC-1 | ' + UNDECIDED + ' | ' + UNDECIDED + ' | 帯が見える |'), true, '埋まらない Given/When は明示');
});

t('AC-2 accept が無ければ steps を Then に使う', () => {
  const md = pbiMarkdown({ summary: 's', steps: ['帯の DOM を足す'] }, '021', TODAY);
  has(md, '| AC-1 | ' + UNDECIDED + ' | ' + UNDECIDED + ' | 帯の DOM を足す |', 'steps 由来の AC 行');
});

t('AC-2 空雛形にしない —— 受入条件も手順も無ければ ready にせず draft', () => {
  const empty = pbiMarkdown({ summary: 's', steps: [] }, '021', TODAY);
  has(empty, 'status: draft', '条件ゼロの案は draft');
  has(pbiMarkdown({ summary: 's', steps: ['x'] }, '021', TODAY), 'status: ready', '条件ありは ready');
});

t('AC-2 表を壊す文字(| と改行)を入れられても行が割れない', () => {
  const md = pbiMarkdown({ summary: 'a|b', steps: [], accept: ['押す | 出る\n続き'] }, '021', TODAY);
  const row = md.split('\n').find((l) => l.startsWith('| AC-1 |'));
  eq(row.split('|').length, 6, `AC 行の列数(${row})`);
});

// ---- AC-3: backlog が無い project には作らない ----
t('AC-3 backlog が無ければ何も作らず null(勝手に掘らない)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nobacklog-'));
  eq(writePbi(join(dir, 'backlog'), { summary: 's', steps: ['x'] }, TODAY), null, '戻り値');
  eq(existsSync(join(dir, 'backlog')), false, 'backlog を作っていない');
});

// ---- AC-4: 採番の衝突 ----
// 「読んでから書くまでの隙間」を 3 方向から当てる:
//   (a) 先に取られている番号を避けて通るか
//   (b) 本物のプロセスを同時に走らせる(execFileSync は直列になるので spawn + await で並べる)
//   (c) 書き手が死んで残ったロックで永久に詰まらないか
t('AC-4a 先に取られている番号は避けて通る', () => {
  const { backlog } = fakeBacklog();
  writeFileSync(join(backlog, 'PBI-021-yoko.md'), 'よそが先に取った\n'); // nextPbiNo が返す番号を横取り
  writeFileSync(join(backlog, 'PBI-022-yoko.md'), 'よそが先に取った\n');
  const file = writePbi(backlog, { summary: 'z', steps: ['a'] }, TODAY);
  eq(file.startsWith('PBI-023-'), true, `避けた先(${file})`);
  eq(readFileSync(join(backlog, 'PBI-021-yoko.md'), 'utf8'), 'よそが先に取った\n', '横取り分を上書きしていない');
});

t('AC-4c 死んだ書き手のロックが残っていても詰まらない(古い分だけ外す)', () => {
  const { backlog } = fakeBacklog();
  const lock = join(backlog, '.pbi-number.lock');
  writeFileSync(lock, '99999');                       // 落ちた書き手が残した跡
  utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const file = writePbi(backlog, { summary: 'z', steps: ['a'] }, TODAY);
  eq(file.startsWith('PBI-021-'), true, `生成できた(${file})`);
  eq(existsSync(lock), false, '使い終わったロックは残らない');
  eq(readdirSync(backlog).some((f) => f.startsWith('PBI-') && f.includes('lock')), false, 'ロックが PBI として採番に混ざらない');
});

await (async () => {
  const n = 'AC-4b 並行 4 プロセス × 5 件 = 20 件、番号は全部ちがう';
  try {
    const { backlog } = fakeBacklog();
    const one = `import { writePbi } from ${JSON.stringify(MOD)};
for (let i = 0; i < 5; i++) writePbi(${JSON.stringify(backlog)}, { summary: 'x' + process.argv[1], steps: ['a'] }, '${TODAY}');`;
    // 4 つ同時に立ち上げてから待つ(execFileSync だと 1 つずつ終わってしまい、衝突が起きない)
    const kids = [0, 1, 2, 3].map((i) => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', one, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`子 ${i} が ${code} で落ちた: ${err.slice(0, 300)}`))));
    }));
    await Promise.all(kids);
    const made = readdirSync(backlog).filter((f) => /^PBI-\d{3}-x\d/.test(f));
    eq(made.length, 20, `生成数(${made.join(' ')})`);
    const nos = new Set(made.map((f) => f.slice(4, 7)));
    eq(nos.size, 20, '番号の重複なし');
    eq(Math.min(...[...nos].map(Number)), 21, '21 から始まる');
    eq(Math.max(...[...nos].map(Number)), 40, '40 で終わる(連番)');
    ok(n);
  } catch (e) { fail(n, e.message); }
})();

// ---- AC-5: newway gate が生成物を認識して実装編集を通す ----
{
  const gate = join(homedir(), '.claude', 'hooks', 'newway-gate.sh');
  const runGate = (root) => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'src', 'x.ts') } });
    try {
      execFileSync('bash', [gate], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return 0;
    } catch (e) { return e.status; }
  };
  if (!existsSync(gate)) {
    skip('AC-5 gate 接続', `${gate} が無い —— newway gate はこの repo の外(maintainer のローカル hook)なので、無い環境では検査しない`);
  } else {
    t('AC-5 生成した PBI で gate が実装編集を通す', () => {
      // 対照: ready|doing が 1 つも無い backlog は拒否される(gate が実際に効いていることの確認)
      const { root, backlog } = fakeBacklog(['PBI-001-a.md']);
      eq(runGate(root), 2, '生成前は拒否');
      const file = writePbi(backlog, { summary: 'gate', steps: [], accept: ['通る'] }, TODAY);
      has(readFileSync(join(backlog, file), 'utf8'), 'status: ready', '生成物は ready');
      eq(runGate(root), 0, '生成後は通る');
    });
  }
}

// ---- 配線: 部屋が本当にこの部品を通しているか(単体で通っても繋がっていなければ意味がない)----
t('配線 room.ts が writePbi を通して confirm の応答に note を返す', () => {
  const src = readFileSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  has(src, "import { writePbi } from './planpbi.ts'", 'import');
  has(src, 'const { pbi, note } = planPbi(p)', 'confirmPlan が呼んでいる');
  has(src, 'pbi: r.pbi, note: r.note', 'POST /plan confirm の応答');
  has(src, 'accept: z.array(z.string()).optional()', 'propose_plan の accept');
  const js = readFileSync(new URL('../public/room.js', import.meta.url), 'utf8');
  has(js, "d.note ? ' — ' + d.note", '画面に note を出す');
  has(js, 'p.accept', '案のパネルに受入条件を出す');
});

const bad = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - bad.length - skipped}/${results.length} pass${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(bad.length === 0 ? 0 : 1);
