// PBI-024: 会話に出た固有名詞を「聞いてから」覚える層。
//
// **設計の根拠は測定**（PBI-023 の G2。実データ 994 発話・固有名詞 14 語）:
//   Tier 0（手元の語彙）      再現率 21.4% / **適合率 100%**  → 確定で覚えてよい
//   Tier 1（正規表現+ストップ）再現率 100%  / 適合率 9.2%      → そのまま覚えると雑音だらけ
//   Tier 1.6（英字を含む語 +
//             手元の語彙）    再現率 78.6% / 適合率 32.4%     → **人に聞く**。適合率は人が担保する
//   頻度・日数で絞っても適合率は動かなかった（9〜11%）。弁別は「語の種類」で、そこは形態素解析器の仕事。
//   **だから Semantica は入れない**（1.5GB・139 パッケージ。再評価の条件は PBI-023 に数字で書いてある）。
//
// 依存ゼロ・純関数（保存だけが I/O）。**例外は外に出さない** —— 語彙の都合で会話を止めない。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 候補の作り方は PBI-023 の計測と**同じ規則**（測った物と出す物を揃える）
const CAND = /[ァ-ヴー]{3,}|[A-Za-z][A-Za-z0-9._-]{2,}|[一-龥]{2,}/g;

// 会話で普通に出る一般語。実データのラベルを見て作ったのではなく、
// 「日本語の会話で普通に出る語」として先に挙げたもの（検査が自分の答えを見ないように）
export const STOP = new Set(`
一言 返事 表示 進捗 設定 確認 部屋 発話 今日 明日 前回 今回 途中 状態 完成 作業 相談 機能 追加 操作 選択 登録 更新 変更 反映
名前 必要 記憶 整理 会話 報告 判定 可能 普通 関係 状況 意識 影響 決定 採用 分担 資産 容量 精度 単語 仕組 全部 自分 気分 色使
チェック タスク コミット フレーズ スルー コール 勝負 ルール モード スキル プラン ボタン ブラウザ ターミナル テスト ファイル
デザイン ゲーム レート ページ ロード フォルダ プロセス エラー 画面 手牌 中身 思考 時間 場所 意味 内容 方法 理由 問題 結果
`.trim().split(/\s+/));

// 英字の一般語・検査由来の断片。**Tier 1.6 は英字を含む語を通すので、ここが効く**。
// **英語辞書を作ろうとしない** —— 狙いは実データ(PBI-023 の 994 発話)に実際に出た雑音で、
// そこに在ったのは hello / world / not / found / spec / img / src / onerror / alert /
// you / hear / What / Can / ABC / API / rename / shutdown-line だった。
// 取りこぼしても害は小さい(**勝手に覚えず、人に聞く**設計だから)。大文字小文字は無視する
const STOP_EN = new Set(`
hello hi hey yes no not ok okay the and or but for with from this that there here what which when where why how
can could would should will just now then than too very really something anything nothing you your yours we our
they them it its is are was were be been do does did have has had get got make made see saw look looked
test testing spec found error img src alert onerror script style href http https www com net org localhost
one two three four five first next last new old good bad big small more most less least
world hear me my mine am not none never always again still only also even much many few
abc api rename shutdown-line hello.txt example.com
`.trim().split(/\s+/));

// PBI-026: カタカナの一般外来語と、部屋の道具の名前。**ラベルを見て作っていない** ——
// 「日本語の会話で普通に出る外来語」と「この部屋に元から在るもの(ゲーム名・開発語)」を先に列挙した。
// カタカナを候補に入れると再現率が 64.3% → 92.9% に上がる代わりに雑音も来るので、ここで受け止める
export const KATA_STOP = new Set(`
プロジェクト セッション プログラム レポート コンテキスト アウトプット インプット スペース ファイル フォルダ
ボタン ページ ブラウザ ターミナル コミット タスク チェック テスト デザイン ゲーム モード ルール スキル プラン
メモリ サーバ サーバー クライアント データ ユーザー ユーザ コード エラー ログ ツール メッセージ トークン
モデル キャラ アバター モーション アニメーション ダウンロード アップロード スクリーンショット
ポーカー ブラックジャック マージャン オールイン カジノ カード チップ ディーラー
`.trim().split(/\s+/));

/** 検査の口(`__hang__` `__askperm__` 等)。前後のアンダースコアで見分ける */
const TEST_HOOK = /^_{0,2}[a-z]+_{2}$|^_{2}[a-z]+/i;

/** 麻雀・ポーカーの手筋（実データの 4 割を占めていた。覚える価値が無い） */
const GAME_MOVE = /(切|打)$|^(オールイン|ポン|チー|カン|リーチ|ツモ|ロン)$/;

export type VocabFile = {
  known: string[];    // 覚えた語（新しい順）
  ignored: string[];  // 断った語（二度と聞かない）
  askedAt?: string;
};

const LIMIT_KNOWN = 200;   // prompt に入れる上限（古い順に落とす）
const LIMIT_IGNORED = 500;

export function emptyVocab(): VocabFile {
  return { known: [], ignored: [] };
}

/**
 * 発話 → 覚える価値のある語の候補（純関数・決定的）。
 * Tier 1.6 = 「英字を含む語」または「既に知っている語」。**測って選んだ規則**であって好みではない。
 */
export function candidates(text: string, vocab: VocabFile, extraKnown: Iterable<string> = []): string[] {
  const known = new Set([...vocab.known, ...extraKnown]);
  const ignored = new Set(vocab.ignored);
  const out: string[] = [];
  for (const w of (text ?? '').match(CAND) ?? []) {
    if (STOP.has(w) || STOP_EN.has(w.toLowerCase()) || GAME_MOVE.test(w) || TEST_HOOK.test(w)) continue;
    if (known.has(w) || ignored.has(w)) continue;         // AC-5: 一度片付いた語は二度と聞かない
    // 字種で絞る。**漢字だけの語は適合率 1.2% なので捨てる**（PBI-023）。
    // 英字を含む語（28.1%）と、カタカナ 3 字以上で一般外来語でないもの（PBI-026）は聞く
    const kata = /^[ァ-ヴー]{3,}$/.test(w) && !KATA_STOP.has(w);
    if (!/[A-Za-z]/.test(w) && !kata) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** prompt に入れる 1 行。語が無ければ空文字（空行を入れない）。 */
export function promptLine(vocab: VocabFile, limit = 40): string {
  const words = vocab.known.slice(0, limit);
  if (words.length === 0) return '';
  return `(この人がよく話す固有名詞。聞き取りづらい時はこの中から選んで解釈して)\n${words.join(' / ')}`;
}

export function rememberWord(vocab: VocabFile, word: string): VocabFile {
  const w = (word ?? '').trim();
  if (!w) return vocab;
  const known = [w, ...vocab.known.filter((x) => x !== w)].slice(0, LIMIT_KNOWN);
  return { ...vocab, known, ignored: vocab.ignored.filter((x) => x !== w) };
}

export function ignoreWord(vocab: VocabFile, word: string): VocabFile {
  const w = (word ?? '').trim();
  if (!w) return vocab;
  const ignored = [w, ...vocab.ignored.filter((x) => x !== w)].slice(0, LIMIT_IGNORED);
  return { ...vocab, ignored, known: vocab.known.filter((x) => x !== w) };
}

// ---- 保存（ここだけ I/O）------------------------------------------------------

export function vocabPath(): string {
  return join(homedir(), '.talkingclaw', 'vocab.json');
}

export function loadVocab(): VocabFile {
  try {
    const raw = JSON.parse(readFileSync(vocabPath(), 'utf8')) as Partial<VocabFile>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    return { known: arr(raw.known).slice(0, LIMIT_KNOWN), ignored: arr(raw.ignored).slice(0, LIMIT_IGNORED) };
  } catch {
    return emptyVocab(); // 壊れていても部屋は止めない（AC-8）
  }
}

export function saveVocab(v: VocabFile): void {
  try {
    const dir = join(homedir(), '.talkingclaw');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = vocabPath() + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...v, askedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, vocabPath()); // 途中で落ちても壊れた JSON を残さない
  } catch { /* 保存に失敗しても会話は続ける */ }
}

// ---- 部屋からの入口 -----------------------------------------------------------

let cache: VocabFile | null = null;
let pending: string[] = []; // まだ聞いていない候補（メモリだけ。再起動で消えてよい）

export function currentVocab(): VocabFile {
  if (!cache) cache = loadVocab();
  return cache;
}

export function resetVocabCache(v?: VocabFile): void {
  cache = v ?? null;
  pending = [];
}

/** 発話 1 つを見て、候補を溜める。**勝手に覚えない**（AC-1）。 */
export function observeText(text: string, extraKnown: Iterable<string> = []): string[] {
  try {
    const found = candidates(text, currentVocab(), extraKnown);
    for (const w of found) if (!pending.includes(w)) pending.push(w);
    if (pending.length > 12) pending = pending.slice(-12); // 溜めすぎない
    return found;
  } catch { return []; }
}

export function pendingWords(): string[] {
  return [...pending];
}

export function decide(word: string, action: 'remember' | 'ignore'): VocabFile {
  const v = currentVocab();
  cache = action === 'remember' ? rememberWord(v, word) : ignoreWord(v, word);
  pending = pending.filter((w) => w !== word);
  saveVocab(cache);
  return cache;
}
