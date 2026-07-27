#!/bin/bash
# 4A-2 受入(自動分): /participants・/select 反映・interim ゲートの静的規律
# (user): チップ UI での選択切替、発話中に本応答が保留→再開、ack は即時
set -u
cd "$(dirname "$0")/.."
PORT=3317; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

J=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}')
P=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['participantId'])")

echo "[1] /participants の形と presence"
R=$(curl -s "$B/participants?token=$TOKEN")
echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
p=d['participants'][0]
assert set(p) >= {'participantId','name','presence','voice'}, p
assert p['presence'] in ('listening','active','gone')
print('ok')" >/dev/null 2>&1 && ok "shape OK" || ng "$R"

echo "[2] /select 反映"
curl -s -X POST "$B/select" -H "$H" -H "$T" -d "{\"participantId\":\"$P\"}" >/dev/null
S=$(curl -s "$B/participants?token=$TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['selected'])")
[ "$S" = "$P" ] && ok "selected=$P" || ng "selected=$S"
curl -s -X POST "$B/select" -H "$H" -H "$T" -d '{"participantId":null}' >/dev/null
S=$(curl -s "$B/participants?token=$TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['selected'])")
[ "$S" = "None" ] && ok "解除" || ng "selected=$S"

echo "[3] 静的規律: interim ゲートは通常 queue のみ(ack = playAckNow はゲート非通過)"
grep -q 'gateActive' public/room.js && ok "gateActive 実装" || ng "なし"
python3 - <<'PY' && ok "playAckNow はゲートを見ない" || ng "ack がゲートに掛かる"
src = open('public/room.js').read()
ack = src.split('function playAckNow')[1].split('\n}\n')[0]
exit(0 if 'gateActive' not in ack else 1)
PY
grep -vE '^\s*//' public/room.js | grep -qE 'innerHTML|insertAdjacentHTML' && ng "XSS 規律違反" || ok "textContent 規律維持"

echo
[ $FAIL = 0 ] && echo "4A-2 受入(自動分): ALL PASS" || echo "4A-2 受入: FAIL あり"
exit $FAIL
