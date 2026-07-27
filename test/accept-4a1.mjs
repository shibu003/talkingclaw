// 4A-1 受入: routing core + SP4(turnId 帰属)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT ?? '3316';
let fail = 0, pass = 0;
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const ng = (m) => { fail = 1; console.log(`  ❌ ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = `http://127.0.0.1:${PORT}`;
let TOKEN = '';
const api = async (p, b) => (await fetch(`${B}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': TOKEN }, body: JSON.stringify(b) })).json();

async function boot(env) {
  const d = spawn(process.execPath, ['src/room.ts'], { env: { ...process.env, PORT, ...env }, stdio: 'ignore', detached: true });
  d.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const h = await (await fetch(`${B}/health`)).json(); if (h.app === 'talkingclaw-room') break; } catch { /* */ }
  }
  TOKEN = JSON.parse(readFileSync(join(homedir(), '.talkingclaw', 'room.json'), 'utf8')).token;
}
async function kill_() {
  try { process.kill(JSON.parse(readFileSync(join(homedir(), '.talkingclaw', 'room.json'), 'utf8')).pid, 'SIGKILL'); } catch { /* */ }
  await sleep(600);
}
async function readSse(after = 0, ms = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  let acc = '';
  try {
    const res = await fetch(`${B}/events?token=${TOKEN}&after=${after}`, { signal: ctrl.signal });
    const rd = res.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { done, value } = await rd.read(); if (done) break; acc += dec.decode(value); }
  } catch { /* */ }
  clearTimeout(t);
  return acc.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}
async function chatTargets(text) {
  const c = await api('/chat', { text });
  for (let i = 0; i < 3; i++) {
    const evs = await readSse(c.eventId - 1);
    const e = evs.find((x) => x.id === c.eventId);
    if (e) return { targets: e.targets, routing: e.routing, turnId: e.turnId };
    await sleep(300);
  }
  return null;
}
async function findTurnPoll(text, tries = 25) { // 合成(4-8s)を待って agent_speech の turnId を取る
  for (let i = 0; i < tries; i++) {
    const evs = await readSse(0);
    const hit = evs.reverse().find((e) => e.type === 'agent_speech' && (e.text || '').includes(text));
    if (hit) return hit.turnId ?? null;
    await sleep(1000);
  }
  return undefined;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('== Part A: 名前/選択/floor(NO_CHLOE, ALIVE_MS=8s)==');
await kill_();
await boot({ NO_CHLOE: '1', ALIVE_MS: '8000' });
const kohaku = await api('/join', { requestedName: 'コハク' });
const mai = await api('/join', { requestedName: 'まい' });
const kohaku2 = await api('/join', { requestedName: 'コハク' }); // suffix『コハク 2』
const refresh = async () => {
  for (const a of [kohaku, mai, kohaku2]) await api('/heartbeat', { participantId: a.participantId, sessionId: a.sessionId });
};

await refresh();
let r = await chatTargets('コハク、これ見て');
eq(r.targets, [kohaku.participantId]) && r.routing.method === 'name' ? ok('1 カタカナ名指し') : ng(`1: ${JSON.stringify(r)}`);
r = await chatTargets('こはく、これ見て');
eq(r.targets, [kohaku.participantId]) ? ok('2 ひらがな(かな正規化)') : ng(`2: ${JSON.stringify(r)}`);
await refresh();
r = await chatTargets('コハク 2 はどう思う?');
eq(r.targets, [kohaku2.participantId]) ? ok('3 longest-match(コハク 2)') : ng(`3: ${JSON.stringify(r)}`);
r = await chatTargets('まいちゃん、お願い');
eq(r.targets, [mai.participantId]) ? ok('4 まい 名指し') : ng(`4: ${JSON.stringify(r)}`);
await refresh();
r = await chatTargets('ねえコハク、あれどうなった');
eq(r.targets, [kohaku.participantId]) ? ok('5 先頭 12 文字内') : ng(`5: ${JSON.stringify(r)}`);
r = await chatTargets('この件は後でコハクに頼むけど今は全体連絡だよ');
!eq(r.targets, [kohaku.participantId]) ? ok('6 先頭範囲外は名指し扱いしない') : ng(`6: ${JSON.stringify(r)}`);

await refresh();
await api('/select', { participantId: mai.participantId });
r = await chatTargets('これお願いね');
eq(r.targets, [mai.participantId]) && r.routing.method === 'selection' ? ok('7 選択中 → まい') : ng(`7: ${JSON.stringify(r)}`);
r = await chatTargets('コハク、こっちお願い');
eq(r.targets, [kohaku.participantId]) ? ok('8 名前 > 選択') : ng(`8: ${JSON.stringify(r)}`);
await api('/select', { participantId: null });

await refresh();
// floor: まい の text-only 応答(turnId:'none' + 大量 queue で text-only 化は不確実 → /played 直叩きで作る)
await api('/speak', { participantId: mai.participantId, sessionId: mai.sessionId, text: 'フロアをもらうよ。', turnId: 'none' });
let mid;
for (let i = 0; i < 25 && !mid; i++) {
  const evs = await readSse(0);
  mid = evs.find((e) => e.type === 'agent_speech' && e.from === mai.participantId && !e.filler)?.id;
  if (!mid) await sleep(1000);
}
await api('/played', { eventId: mid });
await refresh();
r = await chatTargets('いい感じだね、続けて');
eq(r.targets, [mai.participantId]) && ['floor', 'last_responder'].includes(r.routing.method) ? ok('9 floor(再生完了基準)') : ng(`9: ${JSON.stringify(r)}`);
r = await chatTargets('コハク、割り込みごめん');
eq(r.targets, [kohaku.participantId]) ? ok('10 名前 > floor') : ng(`10: ${JSON.stringify(r)}`);

// gone 化(8s 放置)→ 名前マッチ・floor から除外
await sleep(9000);
r = await chatTargets('まい、いる?');
r && eq(r.targets, [mai.participantId]) && r.routing.method === 'name'
  ? ok('11a canonical gone への名指しは inbox に積まれる(v6.1)') : ng(`11a: ${JSON.stringify(r)}`);
r = await chatTargets('今日はいい天気だね');
r && !eq(r.targets, [mai.participantId]) && !eq(r.targets, [kohaku.participantId])
  ? ok('11b gone は floor/last_responder から除外') : ng(`11b: ${JSON.stringify(r)}`);

console.log('== Part B: SP4 turnId 帰属(独立 boot・クリーン状態)==');
await kill_();
await boot({ NO_CHLOE: '1', ALIVE_MS: '60000' });
const A = await api('/join', { requestedName: 'コハク' });
const M = await api('/join', { requestedName: 'まい' });
const t1 = await api('/chat', { text: 'コハク、タスク一つ目' });
const t2 = await api('/chat', { text: 'コハク、タスク二つ目' });
await api('/listen', { participantId: A.participantId, sessionId: A.sessionId, waitSeconds: 1, afterEventId: 0 });
await api('/speak', { participantId: A.participantId, sessionId: A.sessionId, text: 'ひとつめやるね。' });
let f = await findTurnPoll('ひとつめやるね');
f === t1.turnId ? ok(`12 SP4-①: 省略 → 最古未応答(${t1.turnId})`) : ng(`12: ${f} vs ${t1.turnId}`);
await api('/speak', { participantId: A.participantId, sessionId: A.sessionId, text: 'しんちょくだけ言うね。', turnId: 'none' });
await api('/speak', { participantId: A.participantId, sessionId: A.sessionId, text: 'ふたつめも終わったよ。' });
f = await findTurnPoll('ふたつめも終わった');
f === t2.turnId ? ok("13 SP4-②③: 'none' は窓を閉じず次は T2") : ng(`13: ${f} vs ${t2.turnId}`);
const tb = await api('/chat', { text: 'まい、Bやって' });
await api('/listen', { participantId: M.participantId, sessionId: M.sessionId, waitSeconds: 1, afterEventId: 0 });
await api('/speak', { participantId: M.participantId, sessionId: M.sessionId, text: 'Bおわり。' });
f = await findTurnPoll('Bおわり');
f === tb.turnId ? ok('14 SP4-⑤: 並行依頼で帰属混線なし') : ng(`14: ${f} vs ${tb.turnId}`);

// 15 未達通知: 名指し(alive)→ listen しない → 6s
const tg = await api('/chat', { text: 'まい、これ最後ね' });
await sleep(7000);
const evs15 = await readSse(tg.eventId - 1);
evs15.some((e) => (e.text || '').includes('手が離せないみたい')) ? ok('15 未達 6s → ナレーション通知') : ng('15: 通知なし');

console.log('== Part C: クロエ在室の default ==');
await kill_();
await boot({});
await sleep(2000);
const k2 = await api('/join', { requestedName: 'コハク' });
r = await chatTargets('やっほー、元気?');
r && r.targets.length === 1 && r.targets[0] !== k2.participantId && r.routing.method === 'default'
  ? ok('16 名前なし → default クロエ') : ng(`16: ${JSON.stringify(r)}`);
r = await chatTargets('コハク、そっちはどう?');
eq(r.targets, [k2.participantId]) ? ok('17 名指しでコハク') : ng(`17: ${JSON.stringify(r)}`);
r = await chatTargets('くろえ、ありがとう');
r && r.targets.length === 1 && r.targets[0] !== k2.participantId && r.routing.method === 'name'
  ? ok('18 クロエもかな名指し可') : ng(`18: ${JSON.stringify(r)}`);

await kill_();
console.log();
console.log(`checks: ${pass}`);
console.log(fail === 0 ? '4A-1 受入: ALL PASS' : '4A-1 受入: FAIL あり');
process.exit(fail);
