#!/bin/bash
# 3A-2 受入: TtsScheduler(interleave)/ EngineManager(down→自動復旧)/ 相槌(即時・プール)
set -u
cd "$(dirname "$0")/.."
PORT=3305
FAIL=0
ok() { echo "  ✅ $1"; }
ng() { echo "  ❌ $1"; FAIL=1; }
jqf() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

PORT=$PORT node src/room.ts 2>/tmp/room-3a2.log & ROOM_PID=$!
trap 'kill $ROOM_PID 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[0] engine ready と voice 解決を待つ(相槌プール合成込み、最大 5 分)"
J1=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"アルファ","voice":"まお/あまあま"}')
P1=$(echo "$J1" | jqf "['participantId']"); S1=$(echo "$J1" | jqf "['sessionId']")
J2=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"ベータ","voice":"コハク/ノーマル"}')
P2=$(echo "$J2" | jqf "['participantId']"); S2=$(echo "$J2" | jqf "['sessionId']")
READY=0
for i in $(seq 1 100); do
  N=$(curl -s "$B/events?token=$TOKEN&after=0" --max-time 2 | grep -c 'voice:ready' || true)
  V1=$(curl -s -X POST "$B/heartbeat" -H "$H" -H "$T" -d "{\"participantId\":\"$P1\",\"sessionId\":\"$S1\"}" | grep -c ok || true)
  # プール(3 変種 × 2 名)が揃うまで待つ: /audio が 6 個以上
  A=$(curl -s "$B/events?token=$TOKEN&after=0" --max-time 2 | grep -o '"/audio/[0-9]*"' | sort -u | wc -l | tr -d ' ')
  sleep 3
  if grep -q 'AivisSpeech ready' /tmp/room-3a2.log; then READY=1; break; fi
done
[ $READY = 1 ] && ok "engine ready" || ng "engine が ready にならない"
sleep 45  # 相槌プール 6 本の合成待ち(Intel: 1 本 4-6s)

echo "[1] 相槌: ack event が user_speech の直後 id で同期発行される(プール再生 = 合成なし)"
# 単独 target にするため ベータ を leave
curl -s -X POST "$B/leave" -H "$H" -H "$T" -d "{\"participantId\":\"$P2\",\"sessionId\":\"$S2\"}" >/dev/null
ST=$(python3 -c "import time; print(time.time())")
CHAT=$(curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"アルファ、これ見て"}')
MS=$(python3 -c "import time; print(round((time.time()-$ST)*1000))")
EID=$(echo "$CHAT" | jqf "['eventId']")
sleep 0.3
ACK=$(curl -s --max-time 1 "$B/events?token=$TOKEN&after=$((EID-1))" | python3 -c "
import json,sys
evs=[json.loads(l[6:]) for l in sys.stdin if l.startswith('data: ')]
ack=next((e for e in evs if e.get('filler')=='ack'), None)
print('yes' if ack and ack['id']==$EID+1 and ack.get('audio') else 'no')")
if [ "$ACK" = yes ] && [ "$MS" -lt 1500 ]; then ok "ack 同期発行(chat 往復 ${MS}ms)"; else ng "ack=$ACK 往復=${MS}ms"; fi

echo "[2] interleave: アルファの長文合成中にベータ(再join)の初文が割り込める"
J2=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"ベータ","voice":"コハク/ノーマル"}')
P2=$(echo "$J2" | jqf "['participantId']"); S2=$(echo "$J2" | jqf "['sessionId']")
LAST=$(curl -s "$B/health" | jqf "['bootId']" >/dev/null; curl -s "$B/events?token=$TOKEN&after=0" --max-time 2 | grep -o '"id": *[0-9]*' | tail -1 | grep -o '[0-9]*')
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P1\",\"sessionId\":\"$S1\",\"text\":\"一文目の長い説明をしているところだよ。二文目も続けて説明するね。三文目でまとめようと思っているよ。四文目は補足だよ。\"}" >/dev/null
sleep 0.3
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P2\",\"sessionId\":\"$S2\",\"text\":\"横から失礼するね。\"}" >/dev/null
# ベータの発話がアルファの 4 文全部より前に SSE に現れるか
for i in $(seq 1 60); do
  SEQ=$(curl -s "$B/events?token=$TOKEN&after=${LAST:-0}" --max-time 2 | python3 -c "
import json,sys
order=[]
for line in sys.stdin:
    line=line.strip()
    if not line.startswith('data: '): continue
    d=json.loads(line[6:])
    if d.get('type')=='agent_speech' and not d.get('filler'): order.append(d['from'])
print(','.join(order))")
  echo "$SEQ" | grep -q "$P2" && break
  sleep 2
done
POS_B=$(echo "$SEQ" | tr ',' '\n' | grep -n "$P2" | head -1 | cut -d: -f1)
COUNT_A_BEFORE=$(echo "$SEQ" | tr ',' '\n' | head -$((POS_B - 1)) | grep -c "$P1" || true)
if [ -n "$POS_B" ] && [ "$COUNT_A_BEFORE" -lt 4 ]; then ok "ベータがアルファ ${COUNT_A_BEFORE} 文の後(4 文未満)で割込み" ; else ng "順序: $SEQ"; fi

echo "[3] engine kill → text-only 継続 → 自動再 spawn → 復旧 event"
lsof -nP -iTCP:10101 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null
sleep 6  # engineLoop の検知周期
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P1\",\"sessionId\":\"$S1\",\"text\":\"エンジンが落ちてる間の発話だよ。\"}" >/dev/null
sleep 3
TXT=$(curl -s "$B/events?token=$TOKEN&after=0" --max-time 2 | grep '落ちてる間の発話' | grep -c '"audio": *null' || true)
[ "$TXT" -ge 1 ] && ok "down 中は text-only event" || ng "text-only になっていない"
grep -q '落ちたみたい' /tmp/room-3a2.log || curl -s "$B/events?token=$TOKEN&after=0" --max-time 2 | grep -q '落ちたみたい' && ok "down 通知 event" || ng "down 通知なし"
echo "  (自動再 spawn → ready まで最大 3 分待機…)"
RECOVERED=0
for i in $(seq 1 60); do
  curl -s "$B/events?token=$TOKEN&after=0" --max-time 2 | grep -q '声の準備ができたよ' && RECOVERED=1 && break
  sleep 3
done
[ $RECOVERED = 1 ] && ok "自動復旧(声の準備ができたよ)" || ng "3 分で復旧せず"

echo
[ $FAIL = 0 ] && echo "3A-2 受入: ALL PASS" || echo "3A-2 受入: FAIL あり"
exit $FAIL
