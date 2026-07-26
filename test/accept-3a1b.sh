#!/bin/bash
# 3A-1b 受入: 単一性(並行 spawn)+ Host/Origin 検証 + token 規律
set -u
cd "$(dirname "$0")/.."
PORT=3303
FAIL=0
ok() { echo "  ✅ $1"; }
ng() { echo "  ❌ $1"; FAIL=1; }

echo "[1] 並行 spawn ×3 → daemon 1 個・敗者は exit 0・stderr に token なし"
for i in 1 2 3; do PORT=$PORT node src/room.ts 2> /tmp/room-err-$i.log & done
sleep 4
N=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | wc -l | tr -d ' ')
[ "$N" = 1 ] && ok "listener 1 個" || ng "listener $N 個"
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
LOSERS=$(grep -l "既に起動" /tmp/room-err-*.log | wc -l | tr -d ' ')
[ "$LOSERS" -ge 1 ] && ok "敗者 $LOSERS 個が案内を出して退出" || ng "敗者の案内なし"
grep -q "$TOKEN" /tmp/room-err-*.log && ng "stderr に token 漏洩" || ok "stderr に token なし"

B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"

echo "[2] 生き残りの token で 401 ゼロ(join が通る)"
J=$(curl -s -X POST "$B/join" -H "$H" -H "$T" -d '{"requestedName":"テスト"}')
echo "$J" | grep -q participantId && ok "join OK(room.json は勝者の token)" || ng "$J"

echo "[3] Host 偽装 → 403"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.com" "$B/health")
[ "$C" = 403 ] && ok "Host: evil.com → 403" || ng "got $C"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: 127.0.0.1.evil.com" "$B/health")
[ "$C" = 403 ] && ok "Host: 127.0.0.1.evil.com → 403" || ng "got $C"

echo "[4] Origin 偽装 → 403 / Origin なし(curl)→ 許可"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: http://evil.com" -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"x"}')
[ "$C" = 403 ] && ok "評判の悪い Origin → 403" || ng "got $C"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: http://127.0.0.1:$PORT" -X POST "$B/chat" -H "$H" -H "$T" -d '{"text":"x"}')
[ "$C" = 200 ] && ok "自 Origin → 200" || ng "got $C"

echo "[5] セキュリティヘッダ(nosniff / no-store / X-Frame-Options)"
HD=$(curl -s -D - -o /dev/null "$B/")
echo "$HD" | grep -qi 'x-content-type-options: nosniff' && echo "$HD" | grep -qi 'cache-control: no-store' && echo "$HD" | grep -qi 'x-frame-options: DENY' && ok "全ヘッダあり" || ng "$HD"

echo "[6] room.json が atomic(tmp ファイル残骸なし)+ mode 600"
ls ~/.talkingclaw/room.json.tmp-* 2>/dev/null && ng "tmp 残骸あり" || ok "tmp 残骸なし"
M=$(stat -f '%Lp' ~/.talkingclaw/room.json)
[ "$M" = 600 ] && ok "mode 600" || ng "mode $M"

lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | xargs kill 2>/dev/null
echo
[ $FAIL = 0 ] && echo "3A-1b 受入: ALL PASS" || echo "3A-1b 受入: FAIL あり"
exit $FAIL
