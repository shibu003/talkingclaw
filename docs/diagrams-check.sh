#!/bin/bash
# docs/diagrams.md の再測 recipe の実行形(newway §16-7)。
# ずれ = 図が腐っている → exit 1。git commit 前に hook(newway-diagram-check.sh)が自動実行する。
# 図・コードを変えたらここの期待値も同じ commit で直す。
cd "$(dirname "$0")/.." || exit 1
fail=0
chk() { # chk <名前> <期待> <実測>
  if [ "$2" != "$3" ]; then echo "NG $1: 期待 $2 / 実測 $3"; fail=1; else echo "ok $1: $3"; fi
}
# endpoint: パターンは '/ まで含める。'/ 無しだと TurnPath の比較 path === 'memo' を拾って化ける(2026-08-06 実測)
# 51 = 46 dispatch + memo mount 1 行(PBI-003)+ voice mount 1 行(PBI-008)+ /projects(PBI-011)
#      + /herdr(PBI-014)+ /intake(PBI-017)。memo / voice の 3+3 endpoint はそれぞれの module 側で数える
#      2026-08-15: /persona(PBI-021)・/avatars・/avatars/*・/avatar.js・/vendor/*(PBI-022) で +5
#      2026-08-16: GET /vocab・POST /vocab(PBI-024) で +2、/motions・/motions/*(PBI-025) で +2、/guests(PBI-035) で +1、/favicon.ico(PBI-040) で +1
chk "endpoint(図3)" 57 "$(grep -c -e "path === '/" -e "path\.startsWith('/" src/room.ts)"
chk "memo-endpoint(図3)" 3 "$(grep -c "pathname === '" src/memo.ts)"
chk "voice-endpoint(図3)" 3 "$(grep -c "pathname === '" src/voiceswitch.ts)"
chk "import辺(図2)" 33 "$(grep -r -e "^import .*from '\./" -e "^import .*from '\.\./" src/ | grep -c import)"
chk "関数実在room(図4/5)" 3 "$(grep -c -e 'function acceptUtterance' -e 'function userSpeech' -e 'function askUserPermission' src/room.ts)"
chk "関数実在cli(図5)" 3 "$(grep -c -e 'function enqueueAudio' -e 'function stopAudio' -e 'function handsfreeLoop' src/cli.ts)"
chk "クラス実在channel(図6)" 2 "$(grep -c -e 'class LatestChannel' -e 'class TurnMetricClock' src/convos/channel.ts)"
# 図7(2026-08-16 追加): 遊ぶ時の 3 本の流れ。図に描いた関数が実在するか
chk "関数実在game(図7)" 4 "$(grep -c -e 'function turnTalkTick' -e 'export function turnLine' -e 'export function idleLine' -e 'yourTurn: boolean' src/room.ts src/casino.ts | awk -F: '{n+=$2} END{print n}')"
chk "関数実在avatar(図7)" 2 "$(grep -c -e 'export function gameMotion' -e 'export function stackOf' public/avatar.js)"
# 字種で絞る 1 行(英字 or カタカナ)が残っているか。消すと「これ覚える?」が何でも聞くようになる
chk "字種の分岐(図7)" 1 "$(grep -c 'if (!/\[A-Za-z\]/.test(w) && !kata) continue;' src/vocab.ts)"
# 図7(PBI-034): 席を埋める純関数が実在するか（消すと「1 人でも卓が立つ」が壊れる）
chk "席を埋める(図7)" 2 "$(grep -c -e 'export function fillSeats' -e 'const HOUSE' src/casino.ts)"
chk "人が複数の卓(図7)" 2 "$(grep -c -e 'export function humanIds' -e 'function actorOf' src/casino.ts)"
chk "離席の代打ち(図7)" 2 "$(( $(grep -c 'export function autoPlay' src/casino.ts) + $(grep -c 'function armTableIdle' src/room.ts) ))"
# 図8(PBI-035): ゲストの鍵。allowlist と部屋の絞り込みが在るか（消すと他人に全部見える）
chk "態度(図7)" 2 "$(grep -c -e 'export function attitudeLine' -e 'export function attitudeTone' src/persona.ts)"
chk "ゲストの鍵(図8)" 3 "$(grep -c -e 'export function guestAllows' -e 'export function findGuest' -e 'export function issueGuest' src/guests.ts)"
chk "どこまで出すか(図8)" 3 "$(grep -c -e 'export function hostAllowed' -e 'export function inviteHost' -e 'export function lanAddresses' src/net.ts)"
exit $fail
