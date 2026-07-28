// コスト実測と並列化の試算。実行: npm run cost [-- --workers 3 --hours 1]
// 実測(~/.talkingclaw/cost.jsonl)があればそれを単価に使い、無ければ下の想定で試算する。
// 「作業係を増やす = 同じ時間で N 倍の仕事をする = N 倍払う」が基本。並列で単価は下がらない。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 公開単価($/1M tokens)。cache read は input の 1/10、cache write は 1.25 倍が目安。
// 出典: https://platform.claude.com/docs/en/about-claude/pricing(2026-07 時点)
const PRICE = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },   // 導入価格 $2/$10 は 2026-08-31 まで
  haiku: { in: 1, out: 5 },     // 参考値。正確な額は上記ページで確認
};
const CACHE_READ_RATE = 0.1;

// 実測が無い時の想定(1 タスク = 作業係 1 回の依頼〜完了)
const ASSUMED = { input: 60_000, cacheRead: 400_000, output: 25_000, minutes: 12 };

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const workers = arg('workers', 3);
const hours = arg('hours', 1);
const yen = arg('yen', 155); // 円換算レート(--yen 0 で非表示)

function loadRows() {
  try {
    return readFileSync(join(homedir(), '.talkingclaw', 'cost.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const priceOf = (model) => PRICE[Object.keys(PRICE).find((k) => (model ?? '').includes(k)) ?? 'sonnet'];
const usdOf = (r) => {
  if (typeof r.usd === 'number' && r.usd > 0) return r.usd; // SDK の実費が最優先
  const p = priceOf(r.model);
  return (r.input * p.in + r.cacheRead * p.in * CACHE_READ_RATE + r.output * p.out) / 1e6;
};
const money = (usd) => `$${usd.toFixed(2)}` + (yen ? `(約 ${Math.round(usd * yen).toLocaleString()} 円)` : '');

const rows = loadRows();
console.log('# 声の部屋 コスト試算\n');

let perTask, source;
if (rows.length > 0) {
  const total = rows.reduce((a, r) => a + usdOf(r), 0);
  const byModel = new Map();
  for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + usdOf(r));
  console.log(`## 実測(${rows.length} 回 / ${rows[0].at.slice(0, 10)} 〜 ${rows[rows.length - 1].at.slice(0, 10)})`);
  console.log(`合計 ${money(total)} / 1 回あたり平均 ${money(total / rows.length)}`);
  for (const [m, v] of byModel) console.log(`  ${m ?? '不明'}: ${money(v)}`);
  // 「作業係 1 回」= 長い方(会話の相槌より桁が大きい)を代表値にする
  const heavy = [...rows].sort((a, b) => usdOf(b) - usdOf(a)).slice(0, Math.max(1, Math.ceil(rows.length * 0.2)));
  perTask = heavy.reduce((a, r) => a + usdOf(r), 0) / heavy.length;
  const avgMin = heavy.reduce((a, r) => a + (r.ms ?? 0), 0) / heavy.length / 60000;
  source = `実測の重い方 ${heavy.length} 件の平均(1 タスク ${avgMin.toFixed(1)} 分)`;
  ASSUMED.minutes = avgMin > 0.2 ? avgMin : ASSUMED.minutes;
} else {
  const p = PRICE.sonnet;
  perTask = (ASSUMED.input * p.in + ASSUMED.cacheRead * p.in * CACHE_READ_RATE + ASSUMED.output * p.out) / 1e6;
  source = `想定(入力 ${ASSUMED.input / 1000}k + キャッシュ読み ${ASSUMED.cacheRead / 1000}k + 出力 ${ASSUMED.output / 1000}k / sonnet 標準単価)`;
  console.log('## 実測なし(まだ作業していない)');
  console.log('数回まわすと ~/.talkingclaw/cost.jsonl に実費が溜まり、以降はそれで試算する\n');
}

const perHour = 60 / ASSUMED.minutes;
console.log(`\n## 1 タスクあたり ${money(perTask)} — ${source}`);
console.log(`1 人の作業係で 1 時間あたり約 ${perHour.toFixed(1)} タスク\n`);

console.log('## 作業係を増やしたら(同じ時間にこなす量が増える = 払う額も増える)');
console.log('| 作業係 | 1 時間の処理数 | 1 時間 | ' + `${hours} 時間 | 1 日 8 時間 |`);
console.log('| --- | --- | --- | --- | --- |');
for (const n of [1, 2, 3, 5, workers].filter((v, i, a) => v > 0 && a.indexOf(v) === i).sort((a, b) => a - b)) {
  // 並列すると各自が同じ文脈を読み直すので、実測でも 1 割前後は重複読みが乗る
  const overhead = 1 + 0.1 * (n - 1);
  const h = perTask * perHour * n * overhead;
  console.log(`| ${n} 人 | ${(perHour * n).toFixed(1)} | ${money(h)} | ${money(h * hours)} | ${money(h * 8)} |`);
}

console.log(`
## 読み方
- 並列化で「1 タスクの単価」は下がらない。買っているのは待ち時間(壁時計は最大 ${workers} 倍速)
- 増える分は ①こなす量が N 倍 ②各作業係が同じファイルを読み直す重複(上表で 1 割/人 として計上)
- 会話係(クロエ)は 1 人のままなので固定費。増えるのは作業係の分だけ
- 依頼が少ない時間帯は作業係を増やしても課金は増えない(待ち行列が空なら動かない)
- 削るなら: モデルを下げる(opus → sonnet で約 5 分の 1)、相談モードで無駄な着手を減らす、
  同じプロジェクトを続けて触る(キャッシュ読みが効いて入力が 1/10 単価になる)
`);
