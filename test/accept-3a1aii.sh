#!/bin/bash
# 3A-1a-ii 受入: S3 lifecycle(takeover 5 規則 / heartbeat / leave / cursor 継続)
# ALIVE_MS=1500 で「gone」を 1.5 秒に短縮して検証する。
set -u
cd "$(dirname "$0")/.."
PORT=3302
FAIL=0
ok() { echo "  ✅ $1"; }
ng() { echo "  ❌ $1"; FAIL=1; }
jq() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

PORT=$PORT ALIVE_MS=1500 node src/room.ts & ROOM_PID=$!
trap 'kill $ROOM_PID 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"
BOOT=$(curl -s "$B/health" | jq "['bootId']")

echo "[1] 新規 join + heartbeat"
J1=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}')
P1=$(echo "$J1" | jq "['participantId']"); S1=$(echo "$J1" | jq "['sessionId']")
HB=$(curl -s -X POST "$B/heartbeat" -H "$H" -H "$T" -d "{\"participantId\":\"$P1\",\"sessionId\":\"$S1\"}")
echo "$HB" | grep -q '"ok"' && ok "join($P1) + heartbeat" || ng "$HB"

echo "[2] alive 同名 join → suffix ephemeral"
J2=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}')
A2=$(echo "$J2" | jq "['assignedName']"); P2=$(echo "$J2" | jq "['participantId']")
[ "$A2" = "コハク 2" ] && [ "$P2" != "$P1" ] && ok "assignedName=$A2 / 別 id" || ng "$J2"

echo "[3] 未応答 turn を積んでから gone → 名前ベース takeover で cursor 継続"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"コハク、あとで読んでね"}' >/dev/null
sleep 2  # ALIVE_MS=1500 を超過 → gone
J3=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}')
P3=$(echo "$J3" | jq "['participantId']"); S3=$(echo "$J3" | jq "['sessionId']"); C3=$(echo "$J3" | jq "['cursor']")
[ "$P3" = "$P1" ] && [ "$S3" != "$S1" ] && ok "同 participantId・新 session" || ng "$J3"
L3=$(curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$P3\",\"sessionId\":\"$S3\",\"waitSeconds\":2,\"afterEventId\":$C3}")
echo "$L3" | grep -q 'あとで読んでね' && ok "gone 中の未応答 turn が takeover 後に配送された" || ng "$L3"

echo "[4] 旧 session の speak → unknown_participant"
SP=$(curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P1\",\"sessionId\":\"$S1\",\"text\":\"遅れた返事\"}")
echo "$SP" | grep -q 'unknown_participant' && ok "旧 session 拒否" || ng "$SP"

echo "[5] resume(資格情報)takeover: gone 後に resume で同 id 復帰"
sleep 2
J5=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d "{\"requestedName\":\"コハク\",\"resume\":{\"bootId\":\"$BOOT\",\"participantId\":\"$P3\",\"sessionId\":\"$S3\"}}")
P5=$(echo "$J5" | jq "['participantId']"); S5=$(echo "$J5" | jq "['sessionId']")
[ "$P5" = "$P1" ] && [ "$S5" != "$S3" ] && ok "resume takeover 成立" || ng "$J5"

echo "[6] alive 中の resume は拒否 → suffix に落ちる"
J6=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d "{\"requestedName\":\"コハク\",\"resume\":{\"bootId\":\"$BOOT\",\"participantId\":\"$P5\",\"sessionId\":\"$S5\"}}")
A6=$(echo "$J6" | jq "['assignedName']")
echo "$A6" | grep -q 'コハク' && [ "$A6" != "コハク" ] && ok "alive 中 resume → $A6(奪えない)" || ng "$J6"

echo "[7] takeover 時に旧 waiter が即 unknown_participant"
(curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$P5\",\"sessionId\":\"$S5\",\"waitSeconds\":30,\"afterEventId\":99999}" > /tmp/l7.json) &
LP=$!
sleep 2.5  # listen は開いたままだが heartbeat なし… lastSeen は listen 到着時刻 → 1.5s 超で gone
J7=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}')
S7=$(echo "$J7" | jq "['sessionId']")
ST=$(python3 -c "import time; print(time.time())")
wait $LP
EL=$(python3 -c "import time; print(round(time.time()-$ST,2))")
grep -q 'unknown_participant' /tmp/l7.json && python3 -c "exit(0 if $EL < 2 else 1)" && ok "旧 waiter 即解決(${EL}s)" || ng "$(cat /tmp/l7.json) elapsed=${EL}s"

echo "[8] leave → 即 takeover 可能"
curl -s -X POST "$B/leave" -H "$H" -H "$T" -d "{\"participantId\":\"$P5\",\"sessionId\":\"$S7\"}" >/dev/null
J8=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}')
P8=$(echo "$J8" | jq "['participantId']")
[ "$P8" = "$P1" ] && ok "leave 直後の takeover" || ng "$J8"

echo
[ $FAIL = 0 ] && echo "3A-1a-ii 受入: ALL PASS" || echo "3A-1a-ii 受入: FAIL あり"
exit $FAIL
