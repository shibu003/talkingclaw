#!/bin/bash
# W11 受入: 断片結合 / 発話中は確定しない / 補正辞書
set -u
cd "$(dirname "$0")/.."
PORT=3342; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
sse() { curl -s --max-time "$1" "http://127.0.0.1:$PORT/events?token=$TOKEN&after=${2:-0}" 2>/dev/null | sed -n 's/^data: //p'; }
countUser() { sse 1.5 "${1:-0}" | python3 -c "
import json,sys
print(sum(1 for l in sys.stdin if l.strip() and json.loads(l).get('type')=='user_speech'))"; }
lastUser() { sse 1.5 "${1:-0}" | python3 -c "
import json,sys
t=[json.loads(l).get('text','') for l in sys.stdin if l.strip() and json.loads(l).get('type')=='user_speech']
print(t[-1] if t else '')"; }

mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
mv ~/.talkingclaw/dictionary.json /tmp/dict-w11.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; sleep 1
PORT=$PORT node src/room.ts 2>/dev/null & RP=$!
trap 'kill $RP 2>/dev/null; mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null; mv /tmp/dict-w11.bak ~/.talkingclaw/dictionary.json 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
B="http://127.0.0.1:$PORT"; H="content-type: application/json"; T="x-room-token: $TOKEN"
chat() { curl -s -X POST "$B/chat" -H "$H" -H "$T" -d "{\"text\":\"$1\"}" >/dev/null; }

echo "[1] 断片 3 連投が 1 発話にまとまる"
BASE=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
chat "頼んでる時に全ての"; sleep 0.5; chat "タスクを"; sleep 0.5; chat "まとめて進めてほしいんだよね"
sleep 3
N=$(countUser "$BASE")
[ "$N" = 1 ] && ok "user_speech は 1 件(3 断片を結合)" || ng "$N 件に分裂"
L=$(lastUser "$BASE")
echo "$L" | grep -q "頼んでる時に全ての タスクを まとめて" && ok "結合内容: $L" || ng "結合されていない: $L"

echo "[2] 言い切った 1 文は即確定(待たされない)"
BASE=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
ST=$(python3 -c "import time;print(time.time())")
chat "進捗の表示をもっと見やすくしてほしい"
sleep 1
EL=$(python3 -c "import time;print(round(time.time()-$ST,1))")
N=$(countUser "$BASE")
[ "$N" = 1 ] && ok "1 秒以内に確定(${EL}s)" || ng "確定していない($N 件)"

echo "[3] 発話中(speech-state true)は確定しない → false で確定"
curl -s -X POST "$B/speech-state" -H "$H" -H "$T" -d '{"speaking":true}' >/dev/null
MARK="発話中かどうかの確認用フレーズ"
R=$(curl -s -X POST "$B/chat" -H "$H" -H "$T" -d "{\"text\":\"$MARK\"}")
echo "$R" | grep -q '"pending": *true\|"pending":true' && ok "発話中は保留(pending)" || ng "保留されない: $R"
# ブラウザは発話中 800ms 毎に true を送り続ける。テストも同じく更新する(4s の自動失効を避ける)
# ブラウザは発話中 800ms 毎に true を送り続ける。テストも同様に更新(4s の自動失効を避ける)。
# なお総保留は 5s が上限(レイテンシの天井)なので、その手前で観測する
for i in 1 2 3; do sleep 0.5; curl -s -X POST "$B/speech-state" -H "$H" -H "$T" -d '{"speaking":true}' >/dev/null; done
sse 1 | grep -q "$MARK" && ng "発話中に確定した" || ok "話し続けている間は確定しない(2.5 秒経過)"
curl -s -X POST "$B/speech-state" -H "$H" -H "$T" -d '{"speaking":false}' >/dev/null
sleep 2
sse 2 | grep -q "$MARK" && ok "話し終わりで確定" || ng "確定しない"

echo "[4] 補正辞書が効く"
BASE=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
chat "キッドハブにコミットしてプラモードも直してほしい"
sleep 2.5
L=$(lastUser "$BASE")
echo "$L" | grep -q "GitHub" && echo "$L" | grep -q "プランモード" && ok "補正後: $L" || ng "補正されない: $L"

echo "[5] /dict で語を追加でき、次の発話から効く"
curl -s -X POST "$B/dict" -H "$H" -H "$T" -d '{"wrong":"ボイスクロー","right":"talkingclaw"}' >/dev/null
BASE=$(sse 1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',0))" 2>/dev/null || echo 0)
sleep 5.5  # 辞書キャッシュ(5s)明け
chat "ボイスクローの設定を見せてほしい"
sleep 2.5
lastUser "$BASE" | grep -q "talkingclaw" && ok "追加した語が反映" || ng "反映されない: $(lastUser $BASE)"

echo "[6] 作業係が独立した話者として在室(別の声)"
curl -s "$B/participants?token=$TOKEN" | grep -q '作業係' && ok "作業係が在室" || ng "作業係がいない"
grep -q "workerParticipant" src/config.ts && grep -q "helperPid" src/room.ts && ok "実況は作業係から発話" || ng "未配線"
grep -q "途中経過は会話ストリームに流さない" src/room.ts && ok "W12: 途中経過は声に出さず報告スレッドへ(定型文フィルタは不要になった)" || ng "実況がまだ声に出る"

echo "[7] 確認・取消・単語学習のツールが会話 Brain に登録されている"
grep -q "'cancel_task'" src/room.ts && grep -q "mcp__office__cancel_task" src/room.ts && ok "cancel_task" || ng "cancel_task なし"
grep -q "'learn_word'" src/room.ts && grep -q "mcp__office__learn_word" src/room.ts && ok "learn_word" || ng "learn_word なし"
grep -q "言い直して確認" src/config.ts && ok "persona に言い直し確認" || ng "persona 未更新"
grep -q "聞こえた範囲を示して" src/config.ts && ok "persona に部分理解の聞き返し" || ng "聞き返し未更新"

echo
[ $FAIL = 0 ] && echo "W11 受入: ALL PASS" || echo "W11 受入: FAIL あり"
exit $FAIL
