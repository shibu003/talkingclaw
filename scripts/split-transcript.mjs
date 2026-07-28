// 混ざった会話ログを話題ごとに仕分ける。実行: npm run split-log(下見)/ npm run split-log -- --apply
//
// 既存の transcript.jsonl(作業部屋)は消さずに残したまま、話題ごとの transcript-<id>.jsonl を作る。
// 部屋のログは channel ごとに transcript-<channel>.jsonl という約束なので、その話題の部屋ができた
// 瞬間から「入ると続きから読める」状態になる(部屋の新規作成そのものは別機能)。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE = join(homedir(), '.talkingclaw');
const APPLY = process.argv.includes('--apply');

// 話題の定義。~/.talkingclaw/topics.json があればそれを使う(id・label・words)
const DEFAULT_TOPICS = [
  { id: 'ui', label: '画面まわり', words: ['UI', '画面', 'デザイン', '見づらい', '見やす', '読みやす', 'レイアウト', '文字', '余白', 'ボタン', '色', '表示'] },
  { id: 'rooms', label: '部屋の分割・作成', words: ['部屋', 'ルーム', '一覧', '入室', '名前を', 'リネーム', 'rename', '分割', 'チャンネル'] },
  { id: 'plan', label: '相談モード', words: ['相談', 'プラン', 'プランモード', '着手', '合意', '方針', '進め方', '終わりの合図'] },
  { id: 'progress', label: '進捗表示', words: ['進捗', 'タスク', 'ボード', '帯', 'バー', 'リアルタイム', '待ち行列', '状態'] },
  { id: 'voicenav', label: '音声ナビ', words: ['音声ナビ', '遷移', '声で', '合図', '音声認識', '聞き取', '喋', '発話'] },
  { id: 'git', label: 'コミットと GitHub', words: ['コミット', 'GitHub', 'push', 'リポジトリ', 'git', 'ブランチ'] },
  { id: 'cost', label: 'コスト', words: ['コスト', '料金', '課金', '並列', '試算', '円', 'ドル', 'トークン', 'モデルを下げ'] },
];
function loadTopics() {
  try {
    const rows = JSON.parse(readFileSync(join(STATE, 'topics.json'), 'utf8'));
    return Array.isArray(rows) && rows.length > 0 ? rows : DEFAULT_TOPICS;
  } catch { return DEFAULT_TOPICS; }
}
const TOPICS = loadTopics();

function readLog(file) {
  try {
    return readFileSync(join(STATE, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// 1 行の話題を決める。話題語が無い行(相槌・短い返事)は直前の話題を引き継ぐ —
// 会話は続きものなので、行ごとに独立判定すると相槌だけ迷子になる。
function classify(rows) {
  let carry = 'other';
  return rows.map((r) => {
    const text = String(r.text ?? '');
    let best = null;
    let bestScore = 0;
    for (const t of TOPICS) {
      const score = t.words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = t.id; }
    }
    if (best) carry = best;
    return { ...r, topic: best ?? carry };
  });
}

const rows = [...readLog('transcript.jsonl'), ...readLog('transcript-chat.jsonl')]
  .sort((a, b) => String(a.at).localeCompare(String(b.at)));
if (rows.length === 0) {
  console.log('会話ログがまだ無いよ(~/.talkingclaw/transcript.jsonl)');
  process.exit(0);
}
const tagged = classify(rows);
const buckets = new Map();
for (const r of tagged) {
  if (!buckets.has(r.topic)) buckets.set(r.topic, []);
  buckets.get(r.topic).push(r);
}

const labelOf = (id) => TOPICS.find((t) => t.id === id)?.label ?? 'その他';
console.log(`# 会話ログの仕分け(全 ${rows.length} 行 / ${rows[0].at.slice(0, 10)} 〜 ${rows[rows.length - 1].at.slice(0, 10)})\n`);
console.log('| 話題 | 行数 | 割合 | 保存先 |');
console.log('| --- | --- | --- | --- |');
for (const [id, list] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
  const pct = Math.round((list.length / rows.length) * 100);
  console.log(`| ${labelOf(id)} | ${list.length} | ${pct}% | transcript-${id}.jsonl |`);
}

if (!APPLY) {
  console.log('\n下見だけ。実際に分けるなら: npm run split-log -- --apply');
  console.log('元の transcript.jsonl は消さずに残す(分けたぶんは別ファイルに複製する)');
  process.exit(0);
}

for (const [id, list] of buckets) {
  if (id === 'other') continue; // 仕分けきれなかった分は元ログに残したまま触らない
  const path = join(STATE, `transcript-${id}.jsonl`);
  const body = list.map((r) => JSON.stringify({ at: r.at, who: r.who, text: r.text })).join('\n') + '\n';
  appendFileSync(path, body, { mode: 0o600 });
}
// 部屋の作成機能が読めるよう、話題の一覧を残す(id = channel、label = 部屋の名前)
writeFileSync(join(STATE, 'topics.json'), JSON.stringify(
  TOPICS.filter((t) => buckets.has(t.id)).map((t) => ({ id: t.id, label: t.label, words: t.words })), null, 1,
), { mode: 0o600 });
console.log('\n分けたよ。元の transcript.jsonl はそのまま残してある。');
console.log('話題ごとの部屋を作ると、その部屋に入った時点で続きから読める。');
