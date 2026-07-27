#!/bin/bash
# 6A/6B 受入: escalation 連鎖(ack→context→status×2→窓閉じ)/ 応答での停止 / metrics レポート
set -u
cd "$(dirname "$0")/.."
PORT=3318; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
sse() { curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/tmp/room-6ab.log & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[0] join + プール合成待ち(ack3 + context2 + narration2 ≈ 40s)"
J=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク","voice":"コハク/ノーマル"}')
P=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['participantId'])")
S=$(echo "$J" | python3 -c "import json,sys; print(json.load(sys.stdin)['sessionId'])")
for i in $(seq 1 40); do
  N=$(sse 1.5 | grep -c '"/audio/' || true)
  [ "$N" -ge 7 ] && break; sleep 3
done
ok "プール準備(audio $N 件)"

echo "[1] 配送済み・無応答 → ack → context → status×2 → 窓閉じ(相対 fallback 経路)"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"コハク、これ調べておいて"}' >/dev/null
curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$P\",\"sessionId\":\"$S\",\"waitSeconds\":1,\"afterEventId\":0}" >/dev/null
sleep 32  # 3.5 + 8 + 8 + margin(/played なし = fallback タイマー)
EV=$(sse 2)
echo "$EV" | grep -q '"ack"' && ok "ack" || ng "ack なし"
echo "$EV" | grep -q '"context"' && ok "context filler" || ng "context なし"
ST=$(echo "$EV" | grep -c '"status"' || true)
[ "$ST" -ge 2 ] && ok "status ×$ST" || ng "status=$ST"
echo "$EV" | grep -q '返事が来たら教えるね' && ok "打切り(窓閉じ)" || ng "窓閉じなし"

echo "[2] 応答が来たら escalation 停止"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"コハク、次はこれね"}' >/dev/null
LAST=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
curl -s -X POST "$B/listen" -H "$H" -H "$T" -d "{\"participantId\":\"$P\",\"sessionId\":\"$S\",\"waitSeconds\":1,\"afterEventId\":0}" >/dev/null
curl -s -X POST "$B/speak" -H "$H" -H "$T" -d "{\"participantId\":\"$P\",\"sessionId\":\"$S\",\"text\":\"すぐやるよ。\"}" >/dev/null
sleep 14
AFTER=$(sse 2 "$LAST")
C2=$(echo "$AFTER" | grep -c '"context"' || true)
[ "$C2" = 0 ] && ok "応答後の filler なし(キャンセル)" || ng "filler が出た($C2)"

echo "[3] metrics レポートが出る"
node scripts/metrics-report.mjs 2>/dev/null | grep -q '相槌 latency' && ok "レポート出力" || ng "レポート失敗"
node scripts/metrics-report.mjs 2>/dev/null | sed 's/^/    /'

echo
[ $FAIL = 0 ] && echo "6A/6B 受入: ALL PASS" || echo "6A/6B 受入: FAIL あり"
exit $FAIL
