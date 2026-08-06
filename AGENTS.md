# talkingclaw — Codex 向け作業規約

まず `CLAUDE.md` を読み、その 5 ルールすべてに従うこと(完成の定義・会話最優先・正直・自傷しない・変更の反映)。特に:

- **port 3300(部屋)と port 10101(音声エンジン)のプロセスを止めない**
- `test/accept-*.sh` を勝手に実行しない(部屋が落ちる)
- `src/room.ts` 等サーバ側の変更は部屋の再起動が必要 — 勝手に再起動せず、ユーザーに伝える

## 並走ルール(Claude Code と同じリポジトリで作業するため)

1. **作業は別 worktree で**: `git worktree add ../talkingclaw-codex -b codex/<topic>`。main のツリーを直接編集しない
2. **main への取り込みは直列**(片方ずつ)。`git add -A` 禁止、パスを名指しして add する
3. **着手前に `.kaiwa-loop/handoffs/` の最新を読む**。着手と完了は handoff への追記か commit で宣言する(沈黙・mtime の停止を完了扱いしない)
4. **ログ・中間ファイルは `codex-` を冠する**(`run.log` のような一般名は禁止 — 相手の出力を自分の結果として読む事故になる)
5. **同じ機能を二重実装しない** — 書く前に相手の直近成果物を grep する

## 共有 skill

`~/.codex/skills/` に Claude Code の自作 skill 一式を共有済み(正本は `~/.claude/skills/`、symlink)。
コマンド(clear-prep / gowave / plantoroad)は `~/.codex/prompts/` にある。この repo で特に重要なもの:

- **safe-commit** — 並列作業中の commit 混入防止。commit 前に必ず従う
- **site-api** — web から同じ形のものを 3 件以上取る時の唯一の正本
- **data-maestro** — 取得したデータを数える・比べる・解釈する前に読む
- **gowave** — Wave(0.5〜3h の commit 可能単位)で回す時の不変ルール

注意: **commander** は `claude -p` を、**figma-kit** は Claude 側の Figma MCP ツールを前提に書かれている。
手順内のツール名が手元に無い場合は、そこだけ読み替えるか着手前にユーザーに確認する。

過去のミス台帳は `~/.claude/LESSONS.md`(索引)。行動前に該当する 1 ファイルだけ読む。
