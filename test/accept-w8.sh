#!/bin/bash
# W8-1/2 受入: transcript 永続化・recall・クロエ二層化(実作業 + 会話並行)
set -u
cd "$(dirname "$0")/.."
PORT=3321; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
sse() { curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'; }
WORKDIR=$(mktemp -d /tmp/claw-ws-XXXX)
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
mv ~/.talkingclaw/transcript.jsonl ~/.talkingclaw/transcript.jsonl.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT CLAW_WORKSPACE=$WORKDIR node src/room.ts 2>/tmp/room-w8.log & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null; mv ~/.talkingclaw/transcript.jsonl.bak ~/.talkingclaw/transcript.jsonl 2>/dev/null; rm -rf $WORKDIR' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"
echo "[0] greeting warmup 待ち(最大 90s)"
for i in $(seq 1 30); do sse 2 | grep -q '"agent_speech"' && break; sleep 3; done
ok "warmup"

echo "[1] transcript: 発話が永続化され /transcript と /transcript.md で読める"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"ログテストの発話だよ"}' >/dev/null
sleep 2
grep -q 'ログテストの発話' ~/.talkingclaw/transcript.jsonl && ok "jsonl 追記" || ng "追記なし"
R=$(curl -s -X POST "$B/transcript" -H "$H" -H "$T" -d '{"lines":10}')
echo "$R" | grep -q 'ログテストの発話' && ok "POST /transcript" || ng "$R"
curl -s "$B/transcript.md?token=$TOKEN" | grep -q '会話ログ' && ok "md エクスポート" || ng "md 失敗"

echo "[2] 二層化: 作業依頼 → workspace にファイルが生まれ、作業中も会話が即応"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"クロエ、hello.txt というファイルを作って。中身は hello とだけ書いて"}' >/dev/null
sleep 20  # 会話 Brain が delegate するまで
LAST=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"クロエ、そういえば今日の気分はどう?一言で"}' >/dev/null
CONVOK=0
for i in $(seq 1 15); do
  sse 2 "$LAST" | python3 -c "
import json,sys
evs=[json.loads(l) for l in sys.stdin if l.strip()]
ok=any(e.get('type')=='agent_speech' and e.get('name')=='クロエ' and not e.get('filler') and e.get('turnId')!='none' for e in evs)
exit(0 if ok else 1)" && CONVOK=1 && break
  sleep 3
done
[ $CONVOK = 1 ] && ok "作業中(前後)も会話に応答" || ng "会話が返らない"
FILEOK=0
for i in $(seq 1 40); do
  find "$WORKDIR" -name 'hello.txt' 2>/dev/null | grep -q . && FILEOK=1 && break
  sleep 3
done
if [ $FILEOK = 1 ]; then
  ok "hello.txt が実在: $(find "$WORKDIR" -name hello.txt | head -1)"
  grep -qi hello $(find "$WORKDIR" -name hello.txt | head -1) && ok "中身も正しい" || ng "中身が違う"
else
  ng "ファイルが作られない(120s)"; tail -5 /tmp/room-w8.log
fi

echo "[3] /tasks に task が載り working → done"
TASKS=$(curl -s -X POST "$B/tasks" -H "$H" -H "$T" -d '{}')
echo "$TASKS" | grep -q '"request"' && ok "task 起票" || ng "$TASKS"
echo "$TASKS" | grep -q '"done"' && ok "done 遷移" || echo "  (まだ working の可能性: $(echo "$TASKS" | head -c 120))"

echo
[ $FAIL = 0 ] && echo "W8-1/2 受入: ALL PASS" || echo "W8-1/2 受入: FAIL あり"
exit $FAIL
