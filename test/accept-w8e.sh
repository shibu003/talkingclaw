#!/bin/bash
# W8-9 受入: コハク(外部 agent)が声の部屋の画面状態を能動的に取得できる /screen + look ツール
set -u
cd "$(dirname "$0")/.."
PORT=3325; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
# 注意: transcript.jsonl は daemon 間で共有される固定 path(port はおろか PID でも分離されない)。
# 退避しても「実機で別に動いている daemon」が同じ path に書き戻すため退避は無意味 + 実害(本物の会話を
# 一瞬 shadow する)があるので触らない。recentLog の中身依存の assertion もそのため付けない
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"コハク"}' >/dev/null
curl -s -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"コハク、聞こえる?"}' >/dev/null

echo "[1] /screen: 形状(在室者・routing・speaking・board・recentLog)"
R=$(curl -s -X POST "$B/screen" -H "$H" -H "$T" -d '{}')
echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'bootId' in d, d
assert 'userSpeaking' in d and isinstance(d['userSpeaking'], bool), d  # W8: 発話状態フラグとの統合
assert isinstance(d['participants'], list) and any(p['name']=='コハク' for p in d['participants']), d
assert set(d['routing'].keys()) == {'selected','floor','lastResponder'}, d
assert isinstance(d['speaking'], list), d
assert set(d['board'].keys()) == {'tasks','open'}, d
assert isinstance(d['recentLog'], list), d  # 中身は共有 transcript の実状態依存なので型のみ検証
print('ok')" >/dev/null 2>&1 && ok "shape ok: $(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([p["name"] for p in d["participants"]])')" || ng "$R"

echo "[2] /screen: 名指し発話で routing.selected 相当が反映される(name ルーティング確認は /tasks.open 経由)"
R2=$(curl -s -X POST "$B/screen" -H "$H" -H "$T" -d '{}')
echo "$R2" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert any(t['agentName']=='コハク' for t in d['board']['open']), d
print('ok')" >/dev/null 2>&1 && ok "board.open にコハク宛て turn" || ng "$R2"

echo "[3] /tasks は従来どおり動く(boardSnapshot 共有後の回帰確認)"
R3=$(curl -s -X POST "$B/tasks" -H "$H" -H "$T" -d '{}')
echo "$R3" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert set(d.keys()) == {'tasks','open'}, d
print('ok')" >/dev/null 2>&1 && ok "/tasks 回帰なし" || ng "$R3"

echo "[4] mcp.ts に look ツールが登録されている"
grep -q "'look'" src/mcp.ts && grep -q "api('/screen'" src/mcp.ts && ok "look ツール定義" || ng "look ツールなし"

echo
[ $FAIL = 0 ] && echo "W8-9 受入: ALL PASS" || echo "W8-9 受入: FAIL あり"
exit $FAIL
