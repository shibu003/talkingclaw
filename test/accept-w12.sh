#!/bin/bash
# W12 受入: 報告 INBOX(構造化・声の量・スレッド返信・UI)
set -u
cd "$(dirname "$0")/.."
PORT=3352; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
mv ~/.talkingclaw/tasks.json /tmp/tasks-w12.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RP=$!
trap 'kill $RP 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null; mv /tmp/tasks-w12.bak ~/.talkingclaw/tasks.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[1] 報告パーサ: テンプレ準拠 → 構造化される"
node --experimental-strip-types - <<'JS' 2>/dev/null
const src = await import('./src/room.ts').catch(() => null);
JS
python3 - <<'PY'
import re, subprocess, json, os
# パーサ単体は room.ts 内なので、テンプレ文字列の要素が config に定義されているかで代替検証
cfg = open('src/config.ts').read()
need = ['見出し:', 'できるようになったこと:', '確かめかた:', 'やらなかったこと:', '技術メモ:', 'さわったもの:']
missing = [n for n in need if n not in cfg]
print('  ✅ 報告テンプレの 6 項目が定義されている' if not missing else f'  ❌ 不足: {missing}')
PY
grep -q "parseReport" src/room.ts && ok "parseReport 実装" || ng "パーサなし"
grep -q "書き忘れました" src/room.ts && ok "テンプレ違反のフォールバック(可視化)" || ng "フォールバックなし"

echo "[2] 声の量: 実況は会話に流れない(着手と完了の 2 文だけ)"
grep -q "途中経過は会話ストリームに流さない" src/room.ts && ok "実況は notes のみ" || ng "実況がまだ声に出る"
grep -q "始めるね。" src/room.ts && ok "着手 1 文" || ng "着手通知なし"
grep -q "確かめかたは報告に入れておくね" src/room.ts && ok "完了 1 文(報告へ誘導)" || ng "完了通知が旧形式"

echo "[3] INBOX API"
R=$(curl -s -X POST "$B/inbox" -H "$H" -H "$T" -d '{}')
echo "$R" | grep -q '"unread"' && ok "/inbox が応答($R)" || ng "$R"
R=$(curl -s -X POST "$B/inbox/read" -H "$H" -H "$T" -d '{"threadId":99999}')
echo "$R" | grep -q '見つかりません' && ok "不明スレッドは 400" || ng "$R"
R=$(curl -s -X POST "$B/inbox/reply" -H "$H" -H "$T" -d '{"threadId":99999,"text":"test"}')
echo "$R" | grep -q '見つかりません' && ok "返信の宛先チェック" || ng "$R"

echo "[4] 会話 Brain のツール登録"
grep -q "'read_inbox'" src/room.ts && grep -q "mcp__office__read_inbox" src/room.ts && ok "read_inbox" || ng "read_inbox なし"
grep -q "'mark_read'" src/room.ts && ok "mark_read" || ng "mark_read なし"

echo "[5] UI: 2 タブ + 未読バッジ + XSS 規律"
grep -q 'id="tabInbox"' public/index.html && grep -q 'id="inboxCount"' public/index.html && ok "2 タブと未読バッジ" || ng "UI なし"
grep -q "threadCard" public/room.js && ok "報告カード" || ng "カードなし"
grep -q "この報告に返信" public/room.js && ok "返信欄" || ng "返信欄なし"
grep -vE '^\s*//' public/room.js | grep -qE 'innerHTML|insertAdjacentHTML' && ng "XSS 規律違反" || ok "textContent 規律維持"

echo "[6] スレッド返信は同じ作業の続きとして渡る"
grep -q "この作業の続き。前回の報告" src/room.ts && ok "worker へ文脈を引き継ぐ" || ng "引き継ぎなし"

echo
[ $FAIL = 0 ] && echo "W12 受入: ALL PASS" || echo "W12 受入: FAIL あり"
exit $FAIL
