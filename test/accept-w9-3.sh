#!/bin/bash
# W9-3/W10-2/3/4 受入: room_status(誠実性・画面認知)/ 待ち行列注入 / 完了ごと報告
set -u
cd "$(dirname "$0")/.."
PORT=3337; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RP=$!
trap 'kill $RP 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[1] /ui-state を受け取り、画面状態を保持する"
R=$(curl -s -X POST "$B/ui-state" -H "$H" -H "$T" -d '{"preview":"puyo/index.html","board":true}')
echo "$R" | grep -q '"ok"' && ok "ui-state 受理" || ng "$R"

echo "[2] room_status ツールが会話 Brain に登録され、誠実性の指示がある"
grep -q "'room_status'" src/room.ts && ok "room_status 実装" || ng "未実装"
grep -q "mcp__office__room_status" src/room.ts && ok "会話 Brain に登録" || ng "未登録"
grep -q "並行実行はしていない" src/room.ts && ok "直列である事実をツール応答に明記" || ng "事実の明記なし"
grep -q "room_status で確認してから答える" src/config.ts && ok "persona に確認義務" || ng "persona 未更新"

echo "[3] W10-3: 待ち行列を worker prompt に注入(衝突回避が既定)"
grep -q "同じファイルを壊し合わないよう" src/room.ts && ok "待ち行列を注入" || ng "注入なし"
grep -q "workerCwd !== cwd" src/room.ts && ok "同一 project は worker セッション継続 / 切替時のみ再生成" || ng "セッション継続なし"

echo "[4] W10-4: 完了ごとの個別報告"
grep -q "できたよ。画面に出しておくね" src/room.ts && ok "task done で個別報告" || ng "報告なし"

echo "[5] ブラウザがプレビュー時に画面状態を送る"
grep -q "post('/ui-state'" public/room.js && ok "showPreview で送信" || ng "未送信"
grep -vE '^\s*//' public/room.js | grep -qE 'innerHTML|insertAdjacentHTML' && ng "XSS 規律違反" || ok "textContent 規律維持"

echo
[ $FAIL = 0 ] && echo "W9-3/W10 受入: ALL PASS" || echo "W9-3/W10 受入: FAIL あり"
exit $FAIL
