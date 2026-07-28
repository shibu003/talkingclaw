// 画面の静的チェック(daemon 不要): room.js が触る id が index.html に全部あるか。
// 並行編集で markup と script がズレると壊れるので、ここで落とす。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/room.js', import.meta.url), 'utf8');

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !ids.has(id));

let fail = 0;
if (missing.length > 0) { console.log('  ❌ index.html に無い id: ' + missing.join(', ')); fail = 1; }
else console.log(`  ✅ room.js が触る id ${used.size} 個は index.html に揃ってる`);

// パネルは同時に 1 枚だけ(openPanel 経由)= ヘッダのボタンが個別に display を触っていないこと
if (/\.style\.display\s*=/.test(js.replace(/noticeEl\.style\.display\s*=\s*'block';/g, ''))) {
  console.log('  ❌ パネルの開閉が style.display 直書きに戻ってる(openPanel に一本化して)'); fail = 1;
} else console.log('  ✅ パネル開閉は openPanel に一本化されてる');

// 進捗の帯: 件数から作る割合が壊れてないか(純関数を room.js から取り出す)
{
  const body = js.slice(js.indexOf('// >>> progressSummary'), js.indexOf('// <<< progressSummary'));
  const progressSummary = new Function(`${body}; return progressSummary;`)();
  const s = progressSummary([
    { status: 'done', notes: [] }, { status: 'done', notes: [] },
    { status: 'working', agentName: 'コハク', notes: ['テスト書いてる'] },
    { status: 'queued', notes: [] },
  ]);
  const seg = (k) => s.bar.find((b) => b.key === k)?.pct ?? 0;
  if (s.total !== 4 || seg('done') !== 50 || seg('working') !== 25 || seg('queued') !== 25) {
    console.log(`  ❌ 進捗の割合がおかしい: ${JSON.stringify(s.bar)}`); fail = 1;
  } else if (s.note !== 'コハク: テスト書いてる') {
    console.log(`  ❌ 実況の取り出しがおかしい: ${s.note}`); fail = 1;
  } else if (progressSummary([]).total !== 0 || progressSummary([]).bar.length !== 0) {
    console.log('  ❌ 作業ゼロ件で帯が出てしまう'); fail = 1;
  } else if (progressSummary([{ status: 'interrupted', notes: [] }]).bar[0].key !== 'failed') {
    console.log('  ❌ 中断(interrupted)が帯に出ない'); fail = 1;
  } else console.log('  ✅ 進捗の帯は件数どおりに出る(0 件なら出ない)');
}

// 読みやすさ: 文字と背景のコントラストが WCAG AA(4.5:1)を割ってないか
const varOf = (name) => html.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
const lum = (hex) => {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a) + 0.05, lum(b) + 0.05].sort((p, q) => q - p);
  return x / y;
};
// 本文は AAA 相当(7:1)、補助文字も 5.5:1 を下限にする(4.5 は「読める」の下限で、
// 実際に見づらいというフィードバックが出たので基準を上げた)
const pairs = [
  ['本文', varOf('text'), varOf('bg'), 7],
  ['本文(吹き出し上)', varOf('text'), varOf('surface-2'), 7],
  ['補助文字', varOf('muted'), varOf('bg'), 5.5],
  ['補助文字(パネル上)', varOf('muted'), varOf('surface'), 5.5],
  ['話者名', varOf('accent'), varOf('surface-2'), 5.5],
  ['選択チップ', varOf('accent-ink'), varOf('accent'), 5.5],
];
for (const [name, fg, bg, min] of pairs) {
  if (!fg || !bg) { console.log(`  ❌ 色の変数が見つからない: ${name}`); fail = 1; continue; }
  const r = ratio(fg, bg);
  if (r < min) { console.log(`  ❌ ${name} のコントラストが ${r.toFixed(1)}:1(${min} 未満)`); fail = 1; }
}
// 本文が小さすぎないか(和文は 16px 未満だと一気に読みづらい)
const bodyPx = Number(html.match(/--fs-body:\s*([\d.]+)px/)?.[1] ?? 0);
const smallPx = Number(html.match(/--fs-small:\s*([\d.]+)px/)?.[1] ?? 0);
if (bodyPx < 16) { console.log(`  ❌ 本文が ${bodyPx}px(16px 未満)`); fail = 1; }
if (smallPx < 13) { console.log(`  ❌ 補助文字が ${smallPx}px(13px 未満)`); fail = 1; }
if (/font-size:\s*(?:[0-9]|1[0-1])(?:\.\d+)?px/.test(html)) {
  console.log('  ❌ 12px 未満の文字が残ってる'); fail = 1;
}
if (fail === 0) console.log(`  ✅ 本文 ${bodyPx}px / 補助 ${smallPx}px、コントラストは本文 7:1・補助 5.5:1 以上`);

process.exit(fail);
