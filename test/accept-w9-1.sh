#!/bin/bash
# W9-1 受入: Bash 危険コマンド検査(自傷防止)+ タスク台帳の永続化
set -u
cd "$(dirname "$0")/.."
PORT=3334; FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }

echo "[1] 危険パターン判定(config の正規表現をユニット検査)"
node - <<'JS'
const { config } = await import('./src/config.ts');
const danger = (c) => config.dangerousBash.some((re) => re.test(c));
const cases = [
  ['kill 1234', true], ['lsof -ti :3300', true], ['rm -rf build', true],
  ['git push origin main', true], ['bash test/accept-w9.sh', true],
  ['cat ~/.talkingclaw/room.json', true], ['curl 127.0.0.1:10101/version', true],
  ['npm run web', true], ['node src/room.ts', true],
  ['ls -la', false], ['git status', false], ['npm test', false],
  ['echo hello > index.html', false], ['mkdir -p puyo', false],
];
let bad = 0;
for (const [cmd, want] of cases) {
  if (danger(cmd) !== want) { console.log(`  ❌ ${cmd} → ${danger(cmd)}(期待 ${want})`); bad++; }
}
console.log(bad === 0 ? `  ✅ ${cases.length} パターン全一致(危険=声で確認 / 安全=自動許可)` : `  ❌ ${bad} 件不一致`);
process.exit(bad === 0 ? 0 : 1);
JS
[ $? = 0 ] || FAIL=1

echo "[2] Bash が allowedTools に載っていない(canUseTool に落ちる SDK 仕様の担保)"
node -e "
import('./src/config.ts').then(({config}) => {
  const has = config.agent.allowedTools.includes('Bash');
  console.log(has ? '  ❌ Bash が自動承認される' : '  ✅ Bash は allowedTools 外 → 内容検査へ');
  process.exit(has ? 1 : 0);
})" || FAIL=1
grep -q "dangerousBash(String(input.command" src/room.ts && ok "canUseTool で Bash を検査" || ng "検査が未配線"
grep -q "'Task'" src/config.ts && ok "Task は allow(サブエージェントも同 canUseTool 継承)" || ng "Task なし"

echo "[3] タスク台帳が daemon 再起動を跨ぐ + working → interrupted"
cp ~/.talkingclaw/tasks.json /tmp/tasks.bak 2>/dev/null
python3 -c "
import json, os
p = os.path.expanduser('~/.talkingclaw/tasks.json')
json.dump([{'id':1,'agent':'x','agentName':'クロエ','request':'ぷよぷよの色を派手にする','status':'working','notes':[],'artifacts':[],'at':'2026-07-28T01:00:00Z'}], open(p,'w'))
"
mv ~/.talkingclaw/room.json ~/.talkingclaw/room.json.bak 2>/dev/null
lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null
PORT=$PORT NO_CHLOE=1 node src/room.ts 2>/dev/null & RP=$!
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.talkingclaw/room.json')))['token'])")
R=$(curl -s -X POST "http://127.0.0.1:$PORT/tasks" -H 'content-type: application/json' -H "x-room-token: $TOKEN" -d '{}')
echo "$R" | grep -q 'ぷよぷよの色' && ok "再起動後も台帳に残る" || ng "台帳が消えた: $(echo $R | head -c 80)"
echo "$R" | grep -q 'interrupted' && ok "working → interrupted(board が嘘をつかない)" || ng "status が working のまま"
kill $RP 2>/dev/null
mv ~/.talkingclaw/room.json.bak ~/.talkingclaw/room.json 2>/dev/null
cp /tmp/tasks.bak ~/.talkingclaw/tasks.json 2>/dev/null || rm -f ~/.talkingclaw/tasks.json

echo
[ $FAIL = 0 ] && echo "W9-1 受入: ALL PASS" || echo "W9-1 受入: FAIL あり"
exit $FAIL
