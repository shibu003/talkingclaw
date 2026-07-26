#!/bin/bash
# 3A-1c 受入(自動化分): ページ配信 / token 埋め込み / XSS 静的規律 / metrics / played
# ブラウザ実機分((user)): daemon kill→自動復帰、マイクで stt_final_delay 計測、悪性 HTML の無害表示
set -u
cd "$(dirname "$0")/.."
PORT=3304
FAIL=0
ok() { echo "  ✅ $1"; }
ng() { echo "  ❌ $1"; FAIL=1; }

PORT=$PORT node src/room.ts & ROOM_PID=$!
trap 'kill $ROOM_PID 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[1] GET / に token・bootId が埋まり placeholder が残らない"
PAGE=$(curl -s "$B/")
echo "$PAGE" | grep -q "$TOKEN" && ok "token 埋め込み" || ng "token なし"
echo "$PAGE" | grep -q '__ROOM_TOKEN__\|__BOOT_ID__' && ng "placeholder 残留" || ok "placeholder 置換済み"
echo "$PAGE" | grep -q 'Content-Security-Policy' && ok "CSP meta あり" || ng "CSP なし"

echo "[2] /room.js 配信(無認証・nosniff)"
JS=$(curl -s -D /tmp/js-headers "$B/room.js")
echo "$JS" | grep -q 'textContent' && ok "room.js 配信" || ng "room.js 取得失敗"
grep -qi nosniff /tmp/js-headers && ok "nosniff" || ng "nosniff なし"

echo "[3] XSS 静的規律: room.js に innerHTML / insertAdjacentHTML / document.write がない"
V=$(grep -vE '^\s*//' public/room.js | grep -cE 'innerHTML|insertAdjacentHTML|document\.write' || true)
[ "$V" = 0 ] && ok "禁止 API 不使用(textContent のみ)" || ng "禁止 API $V 箇所"

echo "[4] /metrics が JSONL に記録される"
curl -s -X POST "$B/metrics" -H "$H" -H "$T" -d '{"kind":"stt_final_delay","ms":123}' >/dev/null
tail -1 ~/.talkingclaw/metrics.jsonl | grep -q '"stt_final_delay"' && ok "metrics 記録" || ng "記録なし"

echo "[5] /played が受理される"
R=$(curl -s -X POST "$B/played" -H "$H" -H "$T" -d '{"eventId":1}')
echo "$R" | grep -q '"ok"' && ok "played 受理" || ng "$R"

echo "[6] token なしで / と /health は見え、/room.js 以外の API は 401"
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/events")
[ "$C" = 401 ] && ok "/events は 401" || ng "got $C"

echo
[ $FAIL = 0 ] && echo "3A-1c 受入(自動分): ALL PASS — 実機分は user 検証" || echo "3A-1c 受入: FAIL あり"
exit $FAIL
