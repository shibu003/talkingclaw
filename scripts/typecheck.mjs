// 型検査。Node は .ts の型注釈を剥がして実行するだけなので、ここが唯一の型の検査点。
// 既存の型エラーは baseline として記録し、「増えた時だけ」落とす(docs/diagrams-check.sh と同じ思想)。
// 実行: npm run typecheck
import { spawnSync } from 'node:child_process';

// 2026-08-06 時点の既存エラー(2026-08-08: ファイル別に変更)。直したらこの数も下げる。
// 総数だけで見ると「casino.ts を 1 件直して room.ts に 1 件増やす」が合計 16 のまま素通りするので、
// ファイル単位で締める。表に無いファイルは 0 件が期待値
const BASELINE = { 'src/casino.ts': 9, 'src/room.ts': 7 };
const BASELINE_TOTAL = Object.values(BASELINE).reduce((a, b) => a + b, 0);

const r = spawnSync('node_modules/.bin/tsc', ['--noEmit'], { encoding: 'utf8' });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));

// tsc が動かなかった時に「0 件」で緑になるのを塞ぐ(申し送り 006)。
// tsc は型エラーがあれば exit 1 + `error TS` 行を出す。それ以外の非 0 と spawn 失敗は検査の空振り
if (r.error || (r.status !== 0 && errors.length === 0)) {
  console.error(`型検査を実行できませんでした(status=${r.status} ${r.error?.message ?? ''})。node_modules/.bin/tsc が無いか、repo root 以外から実行しています。`);
  console.error(out.trim().slice(0, 500));
  process.exit(2);
}

const byFile = {};
for (const line of errors) {
  const file = line.split('(')[0].trim();
  byFile[file] = (byFile[file] ?? 0) + 1;
}
console.log(`型エラー ${errors.length} 件(baseline ${BASELINE_TOTAL})`);
for (const [file, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${file}(baseline ${BASELINE[file] ?? 0})`);

const grown = Object.entries(byFile).filter(([file, n]) => n > (BASELINE[file] ?? 0));
if (grown.length > 0) {
  console.error('\n型エラーが増えています。増えた分を直すか、直せない理由を PBI に書いてから BASELINE を上げてください。');
  for (const [file, n] of grown) {
    console.error(`  ${file}: ${BASELINE[file] ?? 0} → ${n}`);
    for (const line of errors.filter((l) => l.startsWith(file))) console.error(`    ${line}`);
  }
  process.exit(1);
}
// ponytail: 減った時は落とさず促すだけ。強制ラチェットにしたくなったらここを exit 1 にする
for (const [file, want] of Object.entries(BASELINE)) {
  const n = byFile[file] ?? 0;
  if (n < want) console.log(`${file} は baseline より ${want - n} 件少ない → scripts/typecheck.mjs の BASELINE を ${n} に下げてください`);
}
