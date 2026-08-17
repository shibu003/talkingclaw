#!/usr/bin/env node
// PBI-023: 記憶層の **基準線** を測る。ここでは何も導入しない(`measure-before-adopt` の Tier 0/1)。
//
// 何を測るか: 「部屋の発話から **固有名詞** を拾えるか」の再現率と適合率。
//   分母 = 凍結したラベル(`$CLAW_HOME/memory-eval/labels.tsv`。抽出器を書く前に付けたもの)
//   Tier 0 = いま手元に在る語彙だけ(dictionary.json / 在室者名 / projects.json)
//   Tier 1 = 正規表現 + ストップワード(node の標準機能だけ。依存ゼロ)
//
// **この repo は public なので、語そのものは出さない。**出力は集計値だけ。
// データとラベルは `$CLAW_HOME`(既定 ~/.talkingclaw)に置く = repo の外。
//
// 使い方:
//   node scripts/memory-baseline.mjs              # 実データで測る
//   node scripts/memory-baseline.mjs --self-check # 作り物の入力で計算の正しさだけ検算(CI 用)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.CLAW_HOME || join(homedir(), '.talkingclaw');

// ---- 指標(純関数。--self-check はここだけを検算する)-------------------------
export function score(predicted, truth) {
  const tp = [...predicted].filter((w) => truth.has(w)).length;
  const fp = predicted.size - tp;
  const fn = [...truth].filter((w) => !predicted.has(w)).length;
  const recall = truth.size ? tp / truth.size : 0;
  const precision = predicted.size ? tp / predicted.size : 0;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return { tp, fp, fn, recall, precision, f1 };
}

// ---- Tier 1 の抽出(ゼロ導入)--------------------------------------------------
// カタカナ 3 文字以上 / 英数字の語 / 漢字 2 字以上。候補を作る所は凍結時と同じ規則
const CAND = /[ァ-ヴー]{3,}|[A-Za-z][A-Za-z0-9._-]{2,}|[一-龥]{2,}/g;
// ストップワード: 会話に頻出する一般語。**ラベルを見て作ったのではなく、
// 「日本語の会話で普通に出る語」として先に挙げたもの**(ここを実データに合わせて育てると
// 検査が自分の答えを見ることになる)
export const STOP = new Set(`
一言 返事 表示 進捗 設定 確認 部屋 発話 今日 明日 前回 今回 途中 状態 完成 作業 相談 機能 追加 操作 選択 登録 更新 変更 反映
名前 必要 記憶 整理 会話 報告 判定 可能 普通 関係 状況 意識 影響 決定 採用 分担 資産 容量 精度 単語 仕組 全部 自分 気分 色使
チェック タスク コミット フレーズ スルー コール 勝負 ルール モード スキル プラン ボタン ブラウザ ターミナル テスト ファイル
デザイン ゲーム レート ページ ロード フォルダ プロセス エラー 画面 手牌 中身 思考
`.trim().split(/\s+/));

export function extractTier1(text) {
  const out = new Set();
  for (const w of text.match(CAND) ?? []) if (!STOP.has(w)) out.add(w);
  return out;
}

// ---- 読み込み ---------------------------------------------------------------
function loadUtterances() {
  const files = ['transcript.jsonl', 'transcript-chat.jsonl', 'transcript-game.jsonl']
    .map((f) => join(HOME, f))
    .concat(
      existsSync(join(HOME, 'archives'))
        ? readdirSync(join(HOME, 'archives')).filter((f) => f.endsWith('.jsonl')).map((f) => join(HOME, 'archives', f))
        : [],
    );
  const rows = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* 壊れた行は飛ばす */ }
    }
  }
  return rows.filter((r) => r.who === 'あなた' && typeof r.text === 'string');
}

function loadLabels() {
  const p = join(HOME, 'memory-eval', 'labels.tsv');
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('candidate\t')) continue;
    const [w, c, l] = line.split('\t');
    if (w) map.set(w, { count: Number(c), label: (l ?? '').trim() });
  }
  return map;
}

// Tier 0: いま手元に在る語彙だけ(新しい抽出をしない)
function tier0Vocab() {
  const vocab = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim()) vocab.add(s.trim()); };
  try {
    const d = JSON.parse(readFileSync(join(HOME, 'dictionary.json'), 'utf8'));
    for (const [k, v] of Object.entries(d)) { add(k); add(v); }
  } catch { /* 無ければ空 */ }
  try {
    const p = JSON.parse(readFileSync(join(HOME, 'projects.json'), 'utf8'));
    for (const k of Object.keys(p.projects ?? p)) add(k);
  } catch { /* 無ければ空 */ }
  for (const n of ['クロエ', 'コハク', 'マイ', 'まい', 'まお']) add(n); // 部屋に居る面々(既知)
  return vocab;
}

// ---- self-check（作り物の入力。実データが無い環境でも計算を検算できる）-------
if (process.argv.includes('--self-check')) {
  const t = (name, cond, detail = '') => {
    if (cond) console.log('ok      -', name);
    else { console.log('FAIL    -', name, detail); process.exitCode = 1; }
  };
  const s1 = score(new Set(['a', 'b', 'x']), new Set(['a', 'b', 'c']));
  t('tp/fp/fn が数えられる', s1.tp === 2 && s1.fp === 1 && s1.fn === 1, JSON.stringify(s1));
  t('再現率 = tp/正解数', Math.abs(s1.recall - 2 / 3) < 1e-9);
  t('適合率 = tp/予測数', Math.abs(s1.precision - 2 / 3) < 1e-9);
  const s2 = score(new Set(), new Set(['a']));
  t('何も予測しなければ再現率 0（0 除算で落ちない）', s2.recall === 0 && s2.precision === 0);
  const s3 = score(new Set(['a']), new Set(['a']));
  t('完全一致で 1.0', s3.recall === 1 && s3.precision === 1 && s3.f1 === 1);
  const ex = extractTier1('GitHub の talkingclaw を見て。確認して');
  t('Tier1 が固有名詞を拾う', ex.has('GitHub') && ex.has('talkingclaw'), [...ex].join(','));
  t('Tier1 がストップワードを落とす', !ex.has('確認'), [...ex].join(','));
  console.log(process.exitCode ? '\nself-check 失敗' : '\nself-check 通過');
  process.exit(process.exitCode ?? 0);
}

// ---- 実データで測る ---------------------------------------------------------
const utts = loadUtterances();
const labels = loadLabels();
const truth = new Set([...labels].filter(([, v]) => v.label === 'P').map(([w]) => w));
const noise = new Set([...labels].filter(([, v]) => v.label !== 'P').map(([w]) => w));

const lens = utts.map((u) => u.text.length).sort((a, b) => a - b);
console.log('# 材料');
console.log(`発話 ${utts.length} 件 / 日数 ${new Set(utts.map((u) => u.at.slice(0, 10))).size}`);
console.log(`長さ 中央値 ${lens[Math.floor(lens.length / 2)]} 文字 / 平均 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)} / 30 文字以上 ${lens.filter((x) => x >= 30).length}`);
console.log(`ラベル: 固有名詞 ${truth.size} / それ以外 ${noise.size}（合計 ${labels.size}）`);

// 語彙単位（この会話全体で、どの語を拾えたか）
const t0v = tier0Vocab();
const t0 = new Set([...labels.keys()].filter((w) => t0v.has(w)));
const t1 = new Set();
for (const u of utts) for (const w of extractTier1(u.text)) t1.add(w);

console.log('\n# 語彙単位（分母 = ラベル上の固有名詞 ' + truth.size + ' 語）');
for (const [name, pred] of [['Tier 0（手元の語彙のみ）', t0], ['Tier 1（正規表現+ストップワード）', t1]]) {
  const s = score(pred, truth);
  console.log(
    `${name}: 再現率 ${s.tp}/${truth.size} = ${(s.recall * 100).toFixed(1)}% / ` +
    `適合率 ${s.tp}/${pred.size} = ${(s.precision * 100).toFixed(1)}% / F1 ${(s.f1 * 100).toFixed(1)}%`,
  );
}

// Tier 1.5: **上げ方をまずゼロ導入で試す**(`measure-before-adopt` §5)。
// 再現率は Tier 1 で既に上限なので、動かせるのは適合率だけ。
// 「何日にわたって出たか」で絞る = 一度きりの一般語を落とし、繰り返し出る名前を残す
const dayOf = new Map();   // 語 → 出た日の集合
for (const u of utts) {
  const d = u.at.slice(0, 10);
  for (const w of extractTier1(u.text)) {
    if (!dayOf.has(w)) dayOf.set(w, new Set());
    dayOf.get(w).add(d);
  }
}
console.log('\n# Tier 1.5（同じ語が何日に出たかで絞る。ゼロ導入）');
for (const minDays of [1, 2, 3]) {
  const pred = new Set([...dayOf].filter(([, ds]) => ds.size >= minDays).map(([w]) => w));
  const s = score(pred, truth);
  console.log(
    `${minDays} 日以上に出た語だけ: 再現率 ${s.tp}/${truth.size} = ${(s.recall * 100).toFixed(1)}% / ` +
    `適合率 ${s.tp}/${pred.size} = ${(s.precision * 100).toFixed(1)}% / F1 ${(s.f1 * 100).toFixed(1)}%`,
  );
}
// 頻度で絞る場合も併記(日数と頻度は別の軸)
const freq = new Map();
for (const u of utts) for (const w of extractTier1(u.text)) freq.set(w, (freq.get(w) ?? 0) + 1);
for (const minN of [2, 3, 5]) {
  const pred = new Set([...freq].filter(([, n]) => n >= minN).map(([w]) => w));
  const s = score(pred, truth);
  console.log(
    `${minN} 回以上出た語だけ: 再現率 ${s.tp}/${truth.size} = ${(s.recall * 100).toFixed(1)}% / ` +
    `適合率 ${s.tp}/${pred.size} = ${(s.precision * 100).toFixed(1)}% / F1 ${(s.f1 * 100).toFixed(1)}%`,
  );
}

// Tier 1.6: 語の**字種**で絞る(これもゼロ導入)。日本語の会話で英字混じりの語は
// 製品名・道具名であることが多い、という仮説を数字で確かめる
const isLatin = (w) => /[A-Za-z]/.test(w);
const isKatakana = (w) => /^[ァ-ヴー]+$/.test(w);
const isKanji = (w) => /^[一-龥]+$/.test(w);
console.log('\n# Tier 1.6（字種で絞る。ゼロ導入）');
for (const [name, f] of [['英字を含む語だけ', isLatin], ['カタカナだけの語', isKatakana], ['漢字だけの語', isKanji]]) {
  const pred = new Set([...t1].filter(f));
  const sc = score(pred, truth);
  console.log(
    `${name}: 再現率 ${sc.tp}/${truth.size} = ${(sc.recall * 100).toFixed(1)}% / ` +
    `適合率 ${sc.tp}/${pred.size} = ${(sc.precision * 100).toFixed(1)}% / F1 ${(sc.f1 * 100).toFixed(1)}%`,
  );
}
// 英字を含む語 + 既知の語彙(Tier 0) の合わせ技
const combo = new Set([...t1].filter((w) => isLatin(w) || t0v.has(w)));
const sc = score(combo, truth);
console.log(`英字 + 手元の語彙: 再現率 ${sc.tp}/${truth.size} = ${(sc.recall * 100).toFixed(1)}% / 適合率 ${sc.tp}/${combo.size} = ${(sc.precision * 100).toFixed(1)}% / F1 ${(sc.f1 * 100).toFixed(1)}%`);

// 発話単位とセッション単位（AC-5: 5 文字の断片に文脈が無い問題を数字で見る）
const withP = utts.filter((u) => [...extractTier1(u.text)].some((w) => truth.has(w))).length;
console.log(`\n# 単位の比較`);
console.log(`固有名詞を 1 つ以上含む発話: ${withP} / ${utts.length} = ${((withP / utts.length) * 100).toFixed(1)}%`);
// セッション = 5 分以上間が空いたら切る
const SESSION_GAP_MS = 5 * 60 * 1000;
const sessions = [];
let cur = [];
let prev = 0;
for (const u of utts.slice().sort((a, b) => a.at.localeCompare(b.at))) {
  const t = Date.parse(u.at);
  if (cur.length && t - prev > SESSION_GAP_MS) { sessions.push(cur); cur = []; }
  cur.push(u); prev = t;
}
if (cur.length) sessions.push(cur);
const sessWithP = sessions.filter((s) => [...extractTier1(s.map((u) => u.text).join('。'))].some((w) => truth.has(w))).length;
const sessLens = sessions.map((s) => s.map((u) => u.text).join('。').length).sort((a, b) => a - b);
console.log(`セッション（5 分の空白で分割）: ${sessions.length} 本 / 1 本の文字数 中央値 ${sessLens[Math.floor(sessLens.length / 2)]}`);
console.log(`固有名詞を含むセッション: ${sessWithP} / ${sessions.length} = ${((sessWithP / sessions.length) * 100).toFixed(1)}%`);
