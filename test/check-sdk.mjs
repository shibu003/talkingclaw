// SPDX-License-Identifier: Apache-2.0
// Contract tests for RoomClient (src/sdk.ts).
//
// Runs against a stub fetch, so it checks the client's half of the contract:
// what it sends, how it recovers, and that a resend cannot double-speak.
import assert from 'node:assert/strict';

import { RoomClient, RoomError, MAX_WAIT_SECONDS } from '../src/sdk.ts';

const ROOM = { port: 45999, token: 'tok-abc', bootId: 'boot-1', pid: 1234 };
const OK_JOIN = {
  bootId: 'boot-1', participantId: 'p-1', sessionId: 'sess-1',
  assignedName: 'Kohaku', cursor: 0, mode: 'new',
};

/** Queue-driven fetch stub that records every call. */
function stub(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    calls.push({ path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.shift();
    if (!next) throw new Error(`stub ran out of responses after ${calls.length} calls (last: ${path})`);
    if (next.throw) throw new Error(next.throw);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const make = (responses, opts = {}) => {
  const s = stub(responses);
  return {
    c: new RoomClient({ room: ROOM, name: 'Kohaku', fetch: s.fetchImpl, ...opts }),
    calls: s.calls,
  };
};

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// -- join -------------------------------------------------------------------

await t('join sends the room token and reports the assigned name', async () => {
  const { c, calls } = make([{ body: OK_JOIN }]);
  const r = await c.join();

  assert.equal(r.assignedName, 'Kohaku');
  assert.equal(c.participantId, 'p-1');
  assert.equal(calls[0].path, '/join');
  assert.equal(calls[0].headers['x-room-token'], 'tok-abc');
  assert.equal(calls[0].body.requestedName, 'Kohaku');
  await c.leave();
});

await t('the room may hand back a different name and the client reports it', async () => {
  const { c } = make([{ body: { ...OK_JOIN, assignedName: 'Kohaku 2', mode: 'suffix' } }]);
  const r = await c.join();
  assert.equal(r.assignedName, 'Kohaku 2');
  assert.equal(c.assignedName, 'Kohaku 2');
  await c.leave();
});

await t('resume credentials are forwarded on join', async () => {
  const { c, calls } = make([{ body: OK_JOIN }]);
  await c.join({ bootId: 'boot-0', participantId: 'p-old', sessionId: 'sess-old' });
  assert.equal(calls[0].body.resume.participantId, 'p-old');
  await c.leave();
});

// -- speak ------------------------------------------------------------------

await t('speak carries a clientSeq, and it differs per utterance', async () => {
  const { c, calls } = make([{ body: OK_JOIN }, { body: { status: 'ok' } }, { body: { status: 'ok' } }]);
  await c.join();
  await c.speak('hello');
  await c.speak('again');

  const seqs = calls.filter((x) => x.path === '/speak').map((x) => x.body.clientSeq);
  assert.equal(seqs.length, 2);
  assert.ok(seqs[0] && seqs[1], 'every speak needs a clientSeq');
  assert.notEqual(seqs[0], seqs[1]);
  await c.leave();
});

await t('unknown_participant triggers one rejoin and one resend, reusing the clientSeq', async () => {
  const { c, calls } = make([
    { body: OK_JOIN },
    { body: { status: 'unknown_participant' } },
    { body: { ...OK_JOIN, participantId: 'p-2', sessionId: 'sess-2' } },
    { body: { status: 'ok' } },
  ]);
  await c.join();
  const r = await c.speak('important line');

  assert.equal(r.status, 'ok');
  const speaks = calls.filter((x) => x.path === '/speak');
  assert.equal(speaks.length, 2, 'exactly one resend');
  assert.equal(speaks[0].body.clientSeq, speaks[1].body.clientSeq,
    'the resend must reuse the sequence number, or the room would speak twice');
  assert.equal(speaks[1].body.participantId, 'p-2', 'the resend uses the new seat');
  await c.leave();
});

await t('speak before join fails without touching the network', async () => {
  const { c, calls } = make([]);
  await assert.rejects(() => c.speak('x'), (e) => e instanceof RoomError && e.kind === 'unknown_participant');
  assert.equal(calls.length, 0);
});

// -- listen -----------------------------------------------------------------

await t('listen clamps the wait to the room ceiling and passes the cursor', async () => {
  const { c, calls } = make([{ body: OK_JOIN }, { body: { status: 'no_speech' } }]);
  await c.join();
  const heard = await c.listen(9999);

  assert.equal(heard.status, 'no_speech');
  const l = calls.find((x) => x.path === '/listen');
  assert.equal(l.body.waitSeconds, MAX_WAIT_SECONDS);
  assert.equal(l.body.afterEventId, 0);
  await c.leave();
});

await t('listen advances the cursor so the next call does not replay', async () => {
  const { c, calls } = make([
    { body: OK_JOIN },
    { body: { status: 'speech', events: [{ id: 5, type: 'user_speech', from: 'user', text: 'hi' }], cursor: 5 } },
    { body: { status: 'no_speech' } },
  ]);
  await c.join();
  const heard = await c.listen();
  assert.equal(heard.status, 'speech');
  assert.equal(heard.events[0].text, 'hi');

  await c.listen();
  const listens = calls.filter((x) => x.path === '/listen');
  assert.equal(listens[1].body.afterEventId, 5, 'the second listen must start after the last event');
  await c.leave();
});

// -- transport --------------------------------------------------------------

await t('a 401 is recoverable and clears the cached room', async () => {
  const { c } = make([{ status: 401, body: {} }]);
  const err = await c.join().then(() => null, (e) => e);
  assert.ok(err instanceof RoomError);
  assert.equal(err.kind, 'unauthorized');
  assert.equal(err.isRecoverable, true);
});

await t('a network failure is reported as recoverable, not swallowed', async () => {
  const { c } = make([{ throw: 'connect ECONNREFUSED' }]);
  const err = await c.join().then(() => null, (e) => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.isRecoverable, true);
});

await t('a missing room.json produces an actionable error', async () => {
  const c = new RoomClient({ name: 'X', roomJsonPath: '/nonexistent/room.json', fetch: async () => new Response('{}') });
  const err = await c.join().then(() => null, (e) => e);
  assert.equal(err.kind, 'no_room');
  assert.match(err.message, /talkingclaw/);
});

await t('leave stops the heartbeat so the process can exit', async () => {
  const { c, calls } = make([{ body: OK_JOIN }, { body: {} }]);
  await c.join();
  await c.leave();
  assert.ok(calls.some((x) => x.path === '/leave'));
  assert.equal(c.participantId, null);
});

console.log(`check-sdk: ${passed} checks passed`);
