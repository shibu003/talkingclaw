#!/bin/bash
# W9 受入: W9-0(エンジン誤判定で spawn しない)/ W9-2(記憶が再起動を跨ぐ・友好エラー)
set -u
cd "$(dirname "$0")/.."
FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
sse() { curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'; }

echo "[1] W9-0: エンジンが無応答(TCP は生存)でも spawn しない"
PORT=3331
python3 -c "
import socket, threading, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 19991)); s.listen(5)
def loop():
    while True:
        try: c, _ = s.accept()   # accept するが応答しない = ビジー相当
        except OSError: break
threading.Thread(target=loop, daemon=True).start()
time.sleep(45)
" & STUB=$!
sleep 1
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null
PORT=$PORT NO_CHLOE=1 TTS_URL=http://127.0.0.1:19991 node src/room.ts 2>/tmp/w9-0.log & RP=$!
sleep 32   # probe 6s × 5 tick 相当。旧実装ならこの間に複数回 spawn していた
kill $RP 2>/dev/null; kill $STUB 2>/dev/null
mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null
N=$(grep -c "engine を起動中" /tmp/w9-0.log || true)
[ "$N" = 0 ] && ok "無応答エンジンに対する spawn 0 回" || ng "spawn $N 回(誤判定)"

echo "[2] W9-2: 記憶ファイルが再起動後の応答に反映される"
PORT=3332
cp ~/.talkingclaw/chloe-memory.md /tmp/memory.bak 2>/dev/null
# テスト隔離: 実データの残タスクがあると boot 時の申告が TTS 待ち行列を埋めて計測が濁る
mv ~/.talkingclaw/tasks.json /tmp/tasks-w9.bak 2>/dev/null
MARK="ユーザーの好きな飲み物はルイボスティー"
mkdir -p ~/.talkingclaw && printf -- "- 2026-07-28 %s\n" "$MARK" >> ~/.talkingclaw/chloe-memory.md
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null
PORT=$PORT node src/room.ts 2>/tmp/w9-2.log & RP=$!
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
sleep 3
curl -s -X POST "http://127.0.0.1:$PORT/chat" -H 'content-type: application/json' -H "x-room-token: $TOKEN" \
  -d '{"text":"わたしの好きな飲み物、覚えてる?一言で答えて"}' >/dev/null
HIT=0
for i in $(seq 1 45); do
  sse 2 | grep -q 'ルイボス' && HIT=1 && break
  sleep 3
done
[ $HIT = 1 ] && ok "起動時に注入された記憶を参照して答えた" || ng "記憶が反映されない(225s)"
kill $RP 2>/dev/null
mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null
cp /tmp/memory.bak ~/.talkingclaw/chloe-memory.md 2>/dev/null || rm -f ~/.talkingclaw/chloe-memory.md
mv /tmp/tasks-w9.bak ~/.talkingclaw/tasks.json 2>/dev/null

echo "[3] 静的: 生エラーを読み上げない / remember tool / ガード 180s"
grep -q "考えすぎちゃった" src/room.ts && ! grep -q 'text: `ごめん、エラーが出ちゃった' src/room.ts && ok "友好エラー(生エラーは system のみ)" || ng "生エラー読み上げが残存"
grep -q "'remember'" src/room.ts && grep -q "mcp__office__remember" src/room.ts && ok "remember tool" || ng "remember なし"
grep -q "180_000" src/room.ts && grep -q "ASK_GUARD_MS" src/room.ts && ok "応答ガード 180s(テスト時のみ短縮)" || ng "ガードが 60s のまま"
grep -q "enginePortOccupied" src/room.ts && ok "lsof による port 確認" || ng "port 確認なし"

echo
[ $FAIL = 0 ] && echo "W9 受入: ALL PASS" || echo "W9 受入: FAIL あり"
exit $FAIL
