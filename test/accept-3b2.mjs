// 3B-2 受入: 復旧チェーン(障害注入)
// [1] daemon kill → listen 中でも予算内で透過復旧(spawn + fresh join + 再配送)
// [2] 外来 HTTP アプリが port を占有 → kill せず案内エラー
// [3] room.json が無関係 pid を指す(pid 再利用相当)→ kill しない
// [4] speak clientSeq 冪等
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT ?? '3312';
let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const ng = (m) => { console.log(`  ❌ ${m}`); fail = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM_JSON = join(homedir(), '.talkingclaw', 'room.json');
const roomJson = () => JSON.parse(readFileSync(ROOM_JSON, 'utf8'));

function startProxy() {
  const p = spawn(process.execPath, ['src/mcp.ts'], {
    env: { ...process.env, AGENT_NAME: 'コハク', VOICE: 'コハク/ノーマル', PORT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { proc: p, pending: new Map(), buf: '' };
  p.stdout.on('data', (d) => {
    state.buf += d.toString();
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && state.pending.has(m.id)) { state.pending.get(m.id)(m); state.pending.delete(m.id); }
      } catch { /* */ }
    }
  });
  p.stderr.on('data', () => {});
  return state;
}
let rpcId = 0;
function rpc(st, method, params, timeoutMs = 70_000) {
  const id = ++rpcId;
  st.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
    st.pending.set(id, (m) => { clearTimeout(t); res(m); });
  });
}
const toolJson = (r) => JSON.parse(r.result.content[0].text);
async function init(st) {
  await rpc(st, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  st.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
}

console.log('[1] daemon kill → listen 中の透過復旧(予算 50s 内)');
const s1 = startProxy();
await init(s1);
const first = toolJson(await rpc(s1, 'tools/call', { name: 'speak', arguments: { text: '準備できたよ。' } }));
['ok', 'text_only'].includes(first.status) ? ok('初回 speak で daemon 起動') : ng(JSON.stringify(first));
const rj1 = roomJson();
const listenP = rpc(s1, 'tools/call', { name: 'listen', arguments: { wait_seconds: 40 } });
await sleep(1500);
process.kill(rj1.pid, 'SIGKILL'); // daemon 即死 → listen の fetch が落ちる
const t0 = Date.now();
const lr = toolJson(await listenP);
const recMs = Date.now() - t0;
// 透過復旧: 新 daemon が立ち fresh join、rejoined か no_speech か speech(いずれも復旧成立)で返る
['rejoined', 'no_speech', 'speech', 'recovering'].includes(lr.status) && recMs < 55_000
  ? ok(`listen が ${lr.status} で復帰(${Math.round(recMs / 1000)}s)`) : ng(`${JSON.stringify(lr)} ${recMs}ms`);
const rj2 = roomJson();
rj2.bootId !== rj1.bootId ? ok('新 daemon(bootId 交代)') : ng('daemon が交代していない');
const sp2 = toolJson(await rpc(s1, 'tools/call', { name: 'speak', arguments: { text: '復旧後の発話だよ。' } }));
['ok', 'text_only'].includes(sp2.status) ? ok('復旧後の speak 正常') : ng(JSON.stringify(sp2));
s1.proc.kill('SIGKILL');
process.kill(roomJson().pid, 'SIGKILL');
await sleep(500);

console.log('[2] 外来 HTTP アプリが port 占有 → kill せず案内');
const foreign = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not talkingclaw'); });
await new Promise((r) => foreign.listen(Number(PORT), '127.0.0.1', r));
writeFileSync(ROOM_JSON, JSON.stringify({ port: Number(PORT), token: 'stale', pid: process.pid, pidStartedAt: Date.now(), bootId: 'stale' }));
const s2 = startProxy();
await init(s2);
const r2 = await rpc(s2, 'tools/call', { name: 'speak', arguments: { text: 'テスト。' } });
const msg2 = r2.result?.content?.[0]?.text ?? JSON.stringify(r2);
foreign.listening ? ok('外来アプリは kill されていない') : ng('外来アプリが殺された');
/PORT|別のアプリ|recovering/.test(msg2) ? ok('案内/recovering を返した') : ng(msg2.slice(0, 120));
s2.proc.kill('SIGKILL');
foreign.close();
await sleep(300);

console.log('[3] room.json が無関係 pid(pid 再利用相当)+ TCP のみ占有 → kill しない');
const wedged = createTcp(() => { /* accept して無応答 = wedged */ });
await new Promise((r) => wedged.listen(Number(PORT), '127.0.0.1', r));
// 無関係プロセス(この test 自身の pid)を room.json に書く — 本人検証で弾かれるはず
writeFileSync(ROOM_JSON, JSON.stringify({ port: Number(PORT), token: 'stale', pid: process.pid, pidStartedAt: Date.now(), bootId: 'stale' }));
const s3 = startProxy();
await init(s3);
const r3 = await rpc(s3, 'tools/call', { name: 'speak', arguments: { text: 'テスト。' } });
ok(`自プロセス生存 = 本人検証で kill されず(status: ${toolJson(r3).status ?? 'err'})`); // ここまで来られた時点で kill されていない
s3.proc.kill('SIGKILL');
wedged.close();
await sleep(300);

console.log('[4] speak clientSeq 冪等(直接 API)');
// 新しい部屋を素で立てて検証
const { spawn: sp } = await import('node:child_process');
const d = sp(process.execPath, ['src/room.ts'], { env: { ...process.env, PORT }, stdio: 'ignore', detached: true });
d.unref();
await sleep(2500);
const rj4 = roomJson();
const H = { 'content-type': 'application/json', 'x-room-token': rj4.token };
const j = await (await fetch(`http://127.0.0.1:${PORT}/join`, { method: 'POST', headers: H, body: JSON.stringify({ requestedName: 'テスタ' }) })).json();
const body = { participantId: j.participantId, sessionId: j.sessionId, text: '同じ発話。', clientSeq: 'dup-1' };
await fetch(`http://127.0.0.1:${PORT}/speak`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const dup = await (await fetch(`http://127.0.0.1:${PORT}/speak`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
dup.deduped === true ? ok('重複 clientSeq は deduped') : ng(JSON.stringify(dup));
process.kill(rj4.pid, 'SIGKILL');

console.log();
console.log(fail === 0 ? '3B-2 受入: ALL PASS' : '3B-2 受入: FAIL あり');
process.exit(fail);
