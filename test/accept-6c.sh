#!/bin/bash
# 6C 受入(自動分): VAD 資産配信・CSP・barge-in 静的規律。実挙動(duck→停止)は (user)
set -u
cd "$(dirname "$0")/.."
PORT=3319; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RPID=$!
trap 'kill $RPID 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
B="http://127.0.0.1:$PORT"

echo "[1] VAD 資産の配信(認証不要・正しい content-type)"
for f in "silero_vad_v5.onnx:application/octet-stream" "vad.worklet.bundle.min.js:text/javascript" "vad-web.js:text/javascript" "ort-wasm-simd-threaded.wasm:application/wasm"; do
  name="${f%%:*}"; want="${f##*:}"
  ct=$(curl -s -o /dev/null -w '%{content_type}' "$B/vad/$name")
  echo "$ct" | grep -q "$want" && ok "$name($ct)" || ng "$name → $ct"
done
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/vad/../room.json")
[ "$C" != 200 ] && ok "path traversal 拒否($C)" || ng "traversal 通過"

echo "[2] CSP に wasm-unsafe-eval / script は self のみ"
PAGE=$(curl -s "$B/")
echo "$PAGE" | grep -q "wasm-unsafe-eval" && ok "wasm-unsafe-eval" || ng "CSP 不足"
echo "$PAGE" | grep -q '<script src="/vad/vad-web.js"></script>' && ok "vad-web 読込" || ng "script tag なし"

echo "[3] barge-in 静的規律(S11: pause + 破棄 + タスク継続)"
grep -q "currentAudio.pause()" public/room.js && grep -q "audioQueue.length = 0" public/room.js && ok "pause + 未再生破棄" || ng "S11 実装なし"
grep -q "onVADMisfire" public/room.js && ok "誤検知の復帰(duck 解除)" || ng "misfire 処理なし"
grep -vE '^\s*//' public/room.js | grep -qE 'innerHTML|insertAdjacentHTML' && ng "XSS 規律違反" || ok "textContent 規律維持"

echo
[ $FAIL = 0 ] && echo "6C 受入(自動分): ALL PASS" || echo "6C 受入: FAIL あり"
exit $FAIL
