#!/bin/bash
# W8-8 受入: 音声パーミッション(諾/否/無関係発話)・projects・Task 解放
set -u
cd "$(dirname "$0")/.."
PORT=3324; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
sse() { curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 ROOM_TEST_HOOKS=1 node src/room.ts 2>/dev/null & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"
curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"アルファ"}' >/dev/null  # routing 用の在室者

echo "[1] 許可フロー: 要求 → 「いいよ」→ perm:true"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"__askperm__"}' >/dev/null
sleep 0.5
sse 1.5 | grep -q '許可待ち' && ok "許可待ち event" || ng "許可待ちなし"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"いいよ"}' >/dev/null
sleep 0.5
sse 1.5 | grep -q 'perm:true' && ok "「いいよ」で許可" || ng "perm:true なし"

echo "[2] 拒否フロー: 要求 → 無関係発話は素通り → 「だめ」→ perm:false"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"__askperm__"}' >/dev/null
sleep 0.3
C=$(curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"ところで今日は晴れてるね"}')
EID=$(echo "$C" | python3 -c "import json,sys; print(json.load(sys.stdin)['eventId'])")
sse 1.5 "$((EID-1))" | python3 -c "
import json,sys
evs=[json.loads(l) for l in sys.stdin if l.strip()]
e=next((x for x in evs if x.get('id')==$EID), None)
exit(0 if e and e.get('targets') != [] else 1)" && ok "無関係発話は通常 routing" || ng "横取りされた"
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"だめ"}' >/dev/null
sleep 0.5
sse 1.5 | grep -q 'perm:false' && ok "「だめ」で拒否" || ng "perm:false なし"

echo "[3] projects: /settings に talkingclaw + workspace"
R=$(curl -s -X POST "$B/settings" -H "$H" -H "$T" -d '{}')
echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'talkingclaw' in d['projects'] and 'workspace' in d['projects'], d
print('ok')" >/dev/null 2>&1 && ok "projects=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["projects"])')" || ng "$R"
python3 -c "
import json,os
p=json.load(open(os.path.expanduser('~/.talkingclaw/projects.json')))
assert p['talkingclaw'].endswith('talkingclaw/') or p['talkingclaw'].endswith('talkingclaw'), p" && ok "projects.json 自動生成" || ng "projects.json なし"

echo "[4] Task(サブエージェント)が worker allow-list に"
grep -q "'Task'" src/config.ts && ok "Task 解放" || ng "Task なし"

echo "[5] fable がモデル選択肢に"
R=$(curl -s -X POST "$B/settings" -H "$H" -H "$T" -d '{"workerModel":"fable"}')
echo "$R" | grep -q '"workerModel": *"fable"\|"workerModel":"fable"' && ok "fable 受理" || ng "$R"
curl -s -X POST "$B/settings" -H "$H" -H "$T" -d '{"workerModel":"sonnet"}' >/dev/null  # 戻す

echo
[ $FAIL = 0 ] && echo "W8-8 受入: ALL PASS" || echo "W8-8 受入: FAIL あり"
exit $FAIL
