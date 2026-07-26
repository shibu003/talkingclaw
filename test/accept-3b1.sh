#!/bin/bash
# 3B-1 受入ラッパ: room.json を退避して port 3308 で隔離実行(ALIVE_MS 短縮で gone を再現)
set -u
cd "$(dirname "$0")/.."
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :3308 2>/dev/null | xargs kill 2>/dev/null
sleep 1
ALIVE_MS=1500 PORT=3308 node test/accept-3b1.mjs
RC=$?
lsof -ti :3308 2>/dev/null | xargs kill 2>/dev/null
rm -f ~/.talkingclaw/room.json.bak
exit $RC
