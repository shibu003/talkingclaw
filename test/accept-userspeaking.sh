#!/bin/bash
# ユーザー発話中ブロック受入: /speech-state で userSpeaking=true の間、pump() は
# 音声出力(agent_speech の append)を先に進めない。false / staleness 失効で再開する。
set -u
cd "$(dirname "$0")/.."
PORT=3319; FAIL=0
ok() { echo "  OK $1"; }; ng() { echo "  NG $1"; FAIL=1; }
sse() { curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 TTS_URL='http://127.0.0.1:1' node src/room.ts 2>/tmp/room-userspeaking.log & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

J=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク","voice":"コハク/ノーマル"}')
P=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['participantId'])")
S=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['sessionId'])")

echo "[1] /participants に userSpeaking フィールドがある(初期 false)"
PART=$(curl -s "$B/participants?token=$TOKEN")
echo "$PART" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['userSpeaking'] is False" \
  && ok "初期 userSpeaking=false" || ng "userSpeaking フィールドなし/不正"

echo "[2] userSpeaking=true の間、speak しても音声出力(append)が先に進まない"
curl -s -X POST "$B/speech-state" -H "$H" -H "$T" -d '{"speaking":true}' >/dev/null
PART=$(curl -s "$B/participants?token=$TOKEN")
echo "$PART" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['userSpeaking'] is True" \
  && ok "userSpeaking=true 反映" || ng "true が反映されない"

BASE=$(curl -s "$B/listen" -X POST -H "$H" -H "$T" -d "{\"participantId\":\"$P\",\"sessionId\":\"$S\",\"waitSeconds\":1,\"afterEventId\":0}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cursor',0))")
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P\",\"sessionId\":\"$S\",\"text\":\"ユーザー発話中テスト\"}" >/dev/null
sleep 1.2
EV=$(sse 1 "$BASE")
echo "$EV" | grep -q "ユーザー発話中テスト" && ng "ブロックされず発話が出た" || ok "発話中はブロックされ、まだ出ていない"

echo "[3] userSpeaking=false にすると保留していた発話が流れる"
curl -s -X POST "$B/speech-state" -H "$H" -H "$T" -d '{"speaking":false}' >/dev/null
sleep 1
EV=$(sse 2 "$BASE")
echo "$EV" | grep -q "ユーザー発話中テスト" && ok "false 後に発話が流れた" || ng "false にしても流れない"

echo "[4] client からの更新が途切れても staleness(4s)で自動解除される"
BASE2=$(sse 1 "$BASE" | tail -1 | python3 -c "import json,sys
try:
  print(json.load(sys.stdin).get('id', 0))
except Exception:
  print(0)")
curl -s -X POST "$B/speech-state" -H "$H" -H "$T" -d '{"speaking":true}' >/dev/null
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P\",\"sessionId\":\"$S\",\"text\":\"失効テスト\"}" >/dev/null
sleep 1
EV=$(sse 1 "$BASE2")
echo "$EV" | grep -q "失効テスト" && ng "true のまま即座に出てしまった" || ok "true 直後はまだ保留"
sleep 4.5
EV=$(sse 2 "$BASE2")
echo "$EV" | grep -q "失効テスト" && ok "staleness 失効後に発話が流れた" || ng "4.5s 待っても流れない"

echo
[ $FAIL = 0 ] && echo "userSpeaking ブロック受入: ALL PASS" || echo "userSpeaking ブロック受入: FAIL あり"
exit $FAIL
