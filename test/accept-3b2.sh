#!/bin/bash
set -u
cd "$(dirname "$0")/.."
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :3312 2>/dev/null | xargs kill 2>/dev/null
sleep 1
PORT=3312 node test/accept-3b2.mjs
RC=$?
lsof -ti :3312 2>/dev/null | xargs kill 2>/dev/null
rm -f ~/.talkingclaw/room.json.bak
exit $RC
