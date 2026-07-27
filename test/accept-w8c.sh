#!/bin/bash
# W8-7 受入: /settings 永続化・worker への反映経路・プレビュー/設定 UI 静的規律
set -u
cd "$(dirname "$0")/.."
PORT=3323; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
mv ~/.talkingclaw/settings.json ~/.talkingclaw/settings.json.bak 2>/dev/null
cat > ~/.talkingclaw/worker-mcp.json <<'J'
{ "mcpServers": { "dummy": { "command": "echo", "args": ["x"] } } }
J
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null; mv ~/.talkingclaw/settings.json.bak ~/.talkingclaw/settings.json 2>/dev/null; rm -f ~/.talkingclaw/worker-mcp.json' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[1] /settings 往復 + 永続化 + 外部 MCP 検出"
R=$(curl -s -X POST "$B/settings" -H "$H" -H "$T" -d '{"workerModel":"opus","workerEffort":"high","useUserSettings":true}')
echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['workerModel']=='opus' and d['workerEffort']=='high' and d['useUserSettings'] is True, d
assert 'dummy' in d.get('externalMcp', []), d
print('ok')" >/dev/null 2>&1 && ok "反映 + externalMcp=dummy" || ng "$R"
grep -q '"workerModel": *"opus"\|"workerModel":"opus"' ~/.talkingclaw/settings.json && ok "settings.json 永続化" || ng "永続化なし"
R=$(curl -s -X POST "$B/settings" -H "$H" -H "$T" -d '{"workerModel":"gpt-5"}')
echo "$R" | grep -q '"workerModel": *"opus"\|"workerModel":"opus"' && ok "不正モデル拒否" || ng "$R"

echo "[2] UI 静的規律(preview iframe / 設定パネル / XSS)"
grep -q 'showPreview' public/room.js && grep -q 'renderSettings' public/room.js && ok "preview + settings 実装" || ng "UI 不足"
grep -q 'previewFrame' public/index.html && ok "iframe ドロワー" || ng "ドロワーなし"
grep -vE '^\s*//' public/room.js | grep -qE 'innerHTML|insertAdjacentHTML' && ng "XSS 規律違反" || ok "textContent 規律維持"

echo
[ $FAIL = 0 ] && echo "W8-7 受入(自動分): ALL PASS" || echo "W8-7 受入: FAIL あり"
exit $FAIL
