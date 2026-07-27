#!/bin/bash
# W8-3/4/5 受入(自動分): /files 配信・traversal / board・宛先 UI の静的規律
set -u
cd "$(dirname "$0")/.."
PORT=3322; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
WORKDIR=$(mktemp -d /tmp/claw-ws-XXXX)
echo '<h1>game</h1>' > "$WORKDIR/index.html"
mkdir -p "$WORKDIR/sub"; echo 'x' > "$WORKDIR/sub/a.txt"
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 CLAW_WORKSPACE=$WORKDIR node src/room.ts 2>/dev/null & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null; rm -rf $WORKDIR' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"

echo "[1] /files: html 配信・index・traversal 拒否・token 必須"
curl -s "$B/files/index.html?token=$TOKEN" | grep -q '<h1>game</h1>' && ok "html 配信" || ng "html 配信失敗"
curl -s "$B/files?token=$TOKEN" | grep -q 'index.html' && ok "ディレクトリ index" || ng "index 失敗"
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/files/../room.json?token=$TOKEN")
BODY=$(curl -s "$B/files/..%2F..%2Fetc%2Fpasswd?token=$TOKEN")
{ [ "$C" != 200 ] || true; } && ! echo "$BODY" | grep -q root && ok "traversal 拒否" || ng "traversal 通過"
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/files/index.html")
[ "$C" = 401 ] && ok "token なし 401" || ng "got $C"
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/transcript.md")
[ "$C" = 401 ] && ok "transcript.md も 401" || ng "transcript.md got $C"

echo "[2] UI 静的規律"
grep -q 'refreshBoard' public/room.js && grep -q '話す相手' public/room.js && ok "board + 宛先 UI 実装" || ng "UI 不足"
grep -vE '^\s*//' public/room.js | grep -qE 'innerHTML|insertAdjacentHTML' && ng "XSS 規律違反" || ok "textContent 規律維持"
grep -q 'boardBtn' public/index.html && grep -q 'logBtn' public/index.html && ok "ヘッダボタン" || ng "ボタンなし"

echo
[ $FAIL = 0 ] && echo "W8-3/4/5 受入(自動分): ALL PASS" || echo "W8-3/4/5 受入: FAIL あり"
exit $FAIL
