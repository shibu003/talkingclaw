// PBI-013: 相談で合意した案を、対象 project の backlog/ に G1 形式の PBI として残す。
// これが無いと「話して決めた」が newway gate に伝わらず、作業係が最初の Write で拒否される。
// 部屋から切り離してあるのは、採番と雛形だけを検査から直接当てるため(test/check-plan-to-pbi.mjs)。
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PlanDraft = { summary: string; steps: string[]; accept?: string[] };

// 埋まらない欄はこう書く。それらしい文で埋めると「通ってしまう G1」が出来上がる
export const UNDECIDED = '未定 — 実装前に確定';

// 3 桁の PBI 番号だけを採番対象にする(この repo は 1 桁の PBI-1..5 と名前空間が混ざっている)
export function nextPbiNo(backlog: string): number {
  let max = 0;
  for (const f of readdirSync(backlog)) {
    const m = f.match(/^PBI-(\d{3})-/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// 受入条件は accept(クロエが相談中に詰めたもの)が第一候補。無ければ steps を Then に使う。
// どちらも無い案は「何ができたら終わりか」が決まっていない = ready にしてはいけないので draft で出す
export function pbiMarkdown(p: PlanDraft, no: string, today: string): string {
  const rows = p.accept && p.accept.length > 0 ? p.accept : p.steps;
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();
  const sbe = rows.length > 0
    ? rows.map((t, i) => `| AC-${i + 1} | ${UNDECIDED} | ${UNDECIDED} | ${cell(t)} |`).join('\n')
    : `| AC-1 | ${UNDECIDED} | ${UNDECIDED} | ${UNDECIDED} |`;
  return `---
id: PBI-${no}
epic: ${UNDECIDED}
status: ${rows.length > 0 ? 'ready' : 'draft'}(${today} 相談モードの合意から自動生成)
---

# 何を作るか
${cell(p.summary)}

# 受入基準(SBE)
| # | Given | When | Then |
|---|---|---|---|
${sbe}

# テスト設計
${UNDECIDED} —— 上の AC を機械で当てる手を着手時に書く(検査が書けない AC は AC の書き方が悪い)

# 不確実性と検証
| プロセス | 不確実性 | 検証 | 適応 |
|---|---|---|---|
| 設計 | ${UNDECIDED} | ${UNDECIDED} | ${UNDECIDED} |

# スコープ外
- ${UNDECIDED}

OBSERVE: ${UNDECIDED}

# 相談で決まった進め方
${p.steps.length > 0 ? p.steps.map((s, i) => `${i + 1}. ${cell(s)}`).join('\n') : '(手順までは詰めていない)'}
`;
}

// 番号は「ファイルを作れた者勝ち」で確定する(wx = 既にあれば失敗)。別セッションが同じ backlog へ
// 同時に書いても番号が重ならない —— 読んでから書くまでの隙間を無くす方法がこれしかない(AC-4)。
// backlog/ が無い project では null を返して何も作らない —— newway を使っていない所に台帳を生やさない(AC-3)
const LOCK = '.pbi-number.lock';   // PBI-*.md に当たらない名前(gate の glob と newway の採番から外す)
const LOCK_STALE_MS = 30_000;      // 保持は数ミリ秒。これを超えて残っていたら書き手が死んでいる
// Atomics.wait = stdlib だけで作れる同期 sleep。writePbi は confirmPlan(同期)から呼ばれる
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function writePbi(backlog: string, p: PlanDraft, today: string): string | null {
  if (!existsSync(backlog)) return null;
  // 名前に使えない文字を落として要約を 24 文字だけ載せる(あとで人が探せる方が採番の綺麗さより大事)
  const slug = p.summary.replace(/[\\/:*?"<>|\s.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'soudan';
  const lock = join(backlog, LOCK);
  // 採番は「読む → 作る」の 2 手なので、その間だけ backlog を 1 人にする。
  // O_EXCL を最終ファイル名にかけるだけでは足りない —— 名前に要約が入るので、別プロセスが
  // 同じ番号で別の名前を作れてしまう(4 プロセス × 5 件の実測で 20 件中 3 件が同番号だった)
  for (let i = 0; i < 100; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o644 });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      // 書き手が落ちた跡は片付ける。生きている相手のロックを消すと採番が壊れるので時間で見る
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch { /* 相手が先に外した */ }
      sleepSync(10);
      continue;
    }
    try {
      const id = String(nextPbiNo(backlog)).padStart(3, '0');
      const file = `PBI-${id}-${slug}.md`;
      writeFileSync(join(backlog, file), pbiMarkdown(p, id, today), { mode: 0o644 });
      return file;
    } finally {
      try { unlinkSync(lock); } catch { /* 掃除に失敗しても stale 判定が拾う */ }
    }
  }
  throw new Error(`採番ロックが空かなかった(${lock} を消すと直る)`);
}
