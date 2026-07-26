// 3B-1 受入: MCP proxy を実プロセスで起動し JSON-RPC 一巡 + stdout 純度 + 再起動再配送を検証
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT ?? '3308';
let fail = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const ng = (m) => { console.log(`  ❌ ${m}`); fail = 1; };

function startProxy() {
  const p = spawn(process.execPath, ['src/mcp.ts'], {
    env: { ...process.env, AGENT_NAME: 'コハク', VOICE: 'コハク/ノーマル', PORT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { proc: p, stdoutRaw: '', pending: new Map(), buf: '' };
  p.stdout.on('data', (d) => {
    state.stdoutRaw += d.toString();
    state.buf += d.toString();
    let idx;
    while ((idx = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, idx).trim();
      state.buf = state.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && state.pending.has(msg.id)) {
          state.pending.get(msg.id)(msg);
          state.pending.delete(msg.id);
        }
      } catch { /* 純度チェックで検出する */ }
    }
  });
  p.stderr.on('data', () => {});
  return state;
}

let rpcId = 0;
function rpc(state, method, params, timeoutMs = 60_000) {
  const id = ++rpcId;
  const msg = { jsonrpc: '2.0', id, method, params };
  state.proc.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    state.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  });
}
function notify(state, method, params) {
  state.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomJson = () => JSON.parse(readFileSync(join(homedir(), '.talkingclaw', 'room.json'), 'utf8'));
const toolJson = (r) => JSON.parse(r.result.content[0].text);

async function init(state) {
  const r = await rpc(state, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept-test', version: '0' },
  });
  notify(state, 'notifications/initialized', {});
  return r;
}

// ---- 一巡 ----
console.log('[1] initialize → instructions / tools/list');
const s1 = startProxy();
const initRes = await init(s1);
initRes.result?.instructions?.includes('声の部屋') ? ok('instructions あり') : ng('instructions なし');
const tools = await rpc(s1, 'tools/list', {});
const names = tools.result?.tools?.map((t) => t.name).sort().join(',');
names === 'listen,speak' ? ok(`tools = ${names}`) : ng(`tools = ${names}`);

console.log('[2] speak(daemon 自動 spawn 込み)→ 部屋に agent_speech');
const sp = await rpc(s1, 'tools/call', { name: 'speak', arguments: { text: 'プロキシからのテスト発話だよ。' } });
const spr = toolJson(sp);
['ok', 'text_only'].includes(spr.status) ? ok(`speak status=${spr.status}`) : ng(JSON.stringify(spr));
// SSE は終わらないストリームなので逐次読みで部分データを回収する
async function readEvents(rj, ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let acc = '';
  try {
    const res = await fetch(`http://127.0.0.1:${rj.port}/events?token=${rj.token}&after=0`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value);
    }
  } catch { /* timeout abort — acc は保持 */ }
  clearTimeout(timer);
  return acc;
}
const rj = roomJson();
let reached = false;
for (let i = 0; i < 20 && !reached; i++) { // 合成(Intel で 4-6s)+ 同一 FIFO の相槌プール分を待つ
  reached = (await readEvents(rj)).includes('プロキシからのテスト発話だよ');
  if (!reached) await sleep(1500);
}
reached ? ok('部屋に event 到達') : ng('event なし(30s 待っても)');

console.log('[3] listen(2) → no_speech + 再呼び出し hint');
const t0 = Date.now();
const li = toolJson(await rpc(s1, 'tools/call', { name: 'listen', arguments: { wait_seconds: 2 } }));
const el = Date.now() - t0;
li.status === 'no_speech' && li.note?.includes('listen') && el > 1500 && el < 4000
  ? ok(`no_speech(${el}ms)+ hint`) : ng(`${JSON.stringify(li)} ${el}ms`);

console.log('[4] listen 中の発話が届く');
const listenP = rpc(s1, 'tools/call', { name: 'listen', arguments: { wait_seconds: 15 } });
await sleep(500);
await fetch(`http://127.0.0.1:${rj.port}/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': rj.token },
  body: JSON.stringify({ text: 'コハク、聞こえる?' }),
});
const sp4 = toolJson(await listenP);
sp4.status === 'speech' && sp4.events?.some((e) => e.text === 'コハク、聞こえる?')
  ? ok('speech 受信') : ng(JSON.stringify(sp4));
sp4.events?.every((e) => !('audio' in e)) ? ok('audio field 除去済み') : ng('audio が混入');

console.log('[5] stdout 純度: 全行が JSON-RPC');
const impure = s1.stdoutRaw.split('\n').filter((l) => l.trim()).filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
impure.length === 0 ? ok('純 JSON のみ') : ng(`非 JSON 行: ${impure[0]?.slice(0, 80)}`);

console.log('[6] proxy kill → 不在中の発話 → 再起動で同 id 復帰 + 再配送');
const cred1 = readFileSync(join(homedir(), '.talkingclaw', `agent-${'コハク'.toLowerCase().replace(/[^a-z0-9]/g, '')}-${(await import('node:crypto')).createHash('sha256').update('コハク').digest('hex').slice(0, 6)}.json`), 'utf8');
const pid1 = JSON.parse(cred1).participantId;
s1.proc.kill('SIGKILL');
await sleep(500);
await fetch(`http://127.0.0.1:${rj.port}/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': rj.token },
  body: JSON.stringify({ text: '不在中のメッセージだよ' }),
});
await sleep(4000); // ALIVE_MS は本番値だが listen waiter は死んでいるので takeover 条件は resume で満たす
const s2 = startProxy();
await init(s2);
const li6 = toolJson(await rpc(s2, 'tools/call', { name: 'listen', arguments: { wait_seconds: 5 } }));
if (li6.status === 'speech' && li6.events?.some((e) => e.text === '不在中のメッセージだよ')) ok('不在中の発話が再配送された');
else if (li6.status === 'rejoined') ng('resume できず fresh join に落ちた');
else ng(JSON.stringify(li6));
const pid2 = JSON.parse(readFileSync(join(homedir(), '.talkingclaw', `agent-${'コハク'.toLowerCase().replace(/[^a-z0-9]/g, '')}-${(await import('node:crypto')).createHash('sha256').update('コハク').digest('hex').slice(0, 6)}.json`), 'utf8')).participantId;
pid1 === pid2 ? ok(`同 participantId(${pid2})`) : ng(`${pid1} → ${pid2}`);
s2.proc.kill('SIGKILL');

console.log();
console.log(fail === 0 ? '3B-1 受入: ALL PASS' : '3B-1 受入: FAIL あり');
process.exit(fail);
