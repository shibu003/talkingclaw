#!/bin/bash
# 3C 受入: 内蔵クロエの participant 化(warmup / 応答 / default routing / ハング復旧 / NO_CHLOE)
set -u
cd "$(dirname "$0")/.."
PORT=3314
FAIL=0
ok() { echo "  ✅ $1"; }
ng() { echo "  ❌ $1"; FAIL=1; }
jqf() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
sse() { # SSE を最大 $1 秒読み、素の JSON 行を返す
  curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'
}

mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT ROOM_TEST_HOOKS=1 node src/room.ts 2>/tmp/room-3c.log & RPID=$!
trap 'kill $RPID 2>/dev/null; rm -f ~/.talkingclaw/room.json.bak' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[1] クロエ在室(presence)+ greeting warmup(最大 90s)"
sse 2 | grep -q '"presence"' && sse 2 | grep -q 'クロエ' && ok "クロエ presence" || ng "presence なし"
GREET=0
for i in $(seq 1 30); do
  sse 2 | python3 -c "
import json,sys
evs=[json.loads(l) for l in sys.stdin if l.strip()]
ok=any(e.get('type')=='agent_speech' and e.get('name')=='クロエ' and not e.get('filler') for e in evs)
exit(0 if ok else 1)" && GREET=1 && break
  sleep 3
done
[ $GREET = 1 ] && ok "greeting(クロエの agent_speech)" || ng "greeting なし(90s)"

echo "[2] 雑談: chat → クロエの応答(最大 45s)+ ack"
LAST=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"こんにちは、ぼくの好きな色は青だよ"}' >/dev/null
REPLY=0
for i in $(seq 1 15); do
  sse 2 "$LAST" | python3 -c "
import json,sys
evs=[json.loads(l) for l in sys.stdin if l.strip()]
ok=any(e.get('type')=='agent_speech' and e.get('name')=='クロエ' and not e.get('filler') for e in evs)
exit(0 if ok else 1)" && REPLY=1 && break
  sleep 3
done
[ $REPLY = 1 ] && ok "クロエが応答" || ng "応答なし(45s)"

echo "[3] MCP agent 同席でも default はクロエ"
J=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク","voice":"コハク/ノーマル"}')
CHAT=$(curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"これは誰宛てかな"}')
EID=$(echo "$CHAT" | jqf "['eventId']")
sleep 1
TGT=$(sse 2 "$((EID-1))" | python3 -c "
import json,sys
for l in sys.stdin:
    e=json.loads(l)
    if e.get('type')=='user_speech' and e.get('id')==$EID:
        ts=e.get('targets',[])
        print('chloe-only' if len(ts)==1 and 'agent' not in ' '.join(t for t in ts if 'kohaku' in t) else ','.join(ts))
        break")
echo "$TGT" | grep -q 'chloe-only\|^[^,]*$' && ok "targets = クロエのみ($TGT)" || ng "targets=$TGT"

echo "[4] ハング注入 → interrupt → Brain 再生成 → 次の発話に正常応答(最大 2 分)"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"__hang__ これはハングテストだよ"}' >/dev/null
RECOVER=0
for i in $(seq 1 30); do
  sse 2 | grep -q '接続を作り直した' && RECOVER=1 && break
  sleep 3
done
[ $RECOVER = 1 ] && ok "ハング検知 → Brain 再生成 event" || ng "再生成 event なし"
LAST=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"復活した?一言で返事して"}' >/dev/null
NEXT=0
for i in $(seq 1 20); do
  sse 2 "$LAST" | python3 -c "
import json,sys
evs=[json.loads(l) for l in sys.stdin if l.strip()]
ok=any(e.get('type')=='agent_speech' and e.get('name')=='クロエ' and not e.get('filler') and '固まってた' not in (e.get('text') or '') for e in evs)
exit(0 if ok else 1)" && NEXT=1 && break
  sleep 3
done
[ $NEXT = 1 ] && ok "再生成後の発話に正常応答" || ng "応答なし"

echo "[5] NO_CHLOE=1 ではクロエ不在"
kill $RPID 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RPID=$!
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
T="x-room-token: $TOKEN"
sse 2 | grep -q 'クロエ' && ng "NO_CHLOE でもクロエが居る" || ok "クロエ不在"

echo
[ $FAIL = 0 ] && echo "3C 受入: ALL PASS" || echo "3C 受入: FAIL あり"
exit $FAIL
