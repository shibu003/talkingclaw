#!/bin/bash
# 3A-1a-i 受入: EventStore + HTTP core(curl 一巡)。room を PORT=3301 で起動して検証する。
set -u
cd "$(dirname "$0")/.."
PORT=3301
FAIL=0
ok()   { echo "  ✅ $1"; }
ng()   { echo "  ❌ $1"; FAIL=1; }

PORT=$PORT node src/room.ts & ROOM_PID=$!
trap 'kill $ROOM_PID 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done

TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"
H="content-type: application/json"
T="x-room-token: $TOKEN"

echo "[1] token なし → 401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/chat" -H "$H" -d '{"text":"hi"}')
[ "$CODE" = 401 ] && ok "401" || ng "got $CODE"

echo "[2] join"
J=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク","voice":"コハク/ノーマル"}')
PID=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['participantId'])")
SID=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['sessionId'])")
[ -n "$PID" ] && ok "participantId=$PID" || ng "join failed: $J"

echo "[3] listen(3) が 2.5-3.5s で no_speech"
S=$(python3 -c "import time; print(time.time())")
L=$(curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$PID\",\"sessionId\":\"$SID\",\"waitSeconds\":3,\"afterEventId\":0}")
EL=$(python3 -c "import time; print(round(time.time()-$S,2))")
echo "$L" | grep -q '"no_speech"' && python3 -c "exit(0 if 2.5 <= $EL <= 3.5 else 1)" && ok "no_speech in ${EL}s" || ng "resp=$L elapsed=${EL}s"

echo "[4] listen 中に chat → speech + cursor 進行"
(curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$PID\",\"sessionId\":\"$SID\",\"waitSeconds\":10,\"afterEventId\":0}" > /tmp/l4.json) &
LP=$!
sleep 0.5
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"コハク、テスト発話だよ"}' >/dev/null
wait $LP
CUR=$(python3 -c "import json; d=json.load(open('/tmp/l4.json')); assert d['status']=='speech' and d['events'][0]['text']=='コハク、テスト発話だよ' and 'audio' not in d['events'][0]; print(d['cursor'])" 2>/dev/null)
[ -n "$CUR" ] && ok "speech 受信 cursor=$CUR(audio 除去済み)" || ng "$(cat /tmp/l4.json)"

echo "[5] afterEventId 巻戻しで再配送(at-least-once)"
L5=$(curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$PID\",\"sessionId\":\"$SID\",\"waitSeconds\":2,\"afterEventId\":0}")
echo "$L5" | grep -q 'テスト発話だよ' && ok "再配送された" || ng "$L5"

echo "[6] speak → SSE に agent_speech / audio が RIFF"
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$PID\",\"sessionId\":\"$SID\",\"text\":\"うん、聞こえてるよ。\"}" >/dev/null
AUDIO=""
for i in $(seq 1 40); do
  AUDIO=$(curl -s --max-time 2 "$B/events?token=$TOKEN&after=0" | grep -o '"/audio/[0-9]*"' | head -1 | tr -d '"')
  [ -n "$AUDIO" ] && break; sleep 1
done
if [ -n "$AUDIO" ]; then
  HEAD=$(curl -s "$B$AUDIO?token=$TOKEN" | head -c 4)
  [ "$HEAD" = "RIFF" ] && ok "SSE→$AUDIO は RIFF" || ng "audio 先頭=$HEAD"
else
  ng "agent_speech の audio が SSE に現れない(engine 未 ready なら text-only 想定)"
fi

echo "[7] 悪性 HTML 断片が text としてそのまま返る(JSON 素通し)"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"<img src=x onerror=alert(1)>"}' >/dev/null
X=$(curl -s --max-time 2 "$B/events?token=$TOKEN&after=0" | grep -c '<img src=x onerror=alert(1)>')
[ "$X" -ge 1 ] && ok "raw text のまま" || ng "見つからない"

echo
[ $FAIL = 0 ] && echo "3A-1a-i 受入: ALL PASS" || echo "3A-1a-i 受入: FAIL あり"
exit $FAIL
