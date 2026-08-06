import { readFileSync } from 'node:fs';
import { LatestChannel, TurnMetricClock } from '../src/convos/channel.ts';
import { SpeechPlane } from '../src/convos/speech.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const eventually = async (fn) => {
  for (let i = 0; i < 30; i++) {
    if (fn()) return true;
    await tick();
  }
  return false;
};

let failed = false;
const section = async (name, body) => {
  const errors = [];
  await body((condition, message) => { if (!condition) errors.push(message); });
  if (errors.length > 0) {
    failed = true;
    console.log(`  ❌ ${name}: ${errors.join(' / ')}`);
  } else {
    console.log(`  ✅ ${name}`);
  }
};

class FakeBrain {
  interruptCalls = 0;
  closeCalls = 0;
  interruptMode;

  constructor(interruptMode = 'resolve') {
    this.interruptMode = interruptMode;
  }

  interrupt() {
    this.interruptCalls++;
    if (this.interruptMode === 'hang') return new Promise(() => {});
    if (this.interruptMode === 'reject') return Promise.reject(new Error('interrupt failed'));
    return Promise.resolve();
  }

  close() {
    this.closeCalls++;
    return Promise.resolve();
  }
}

await section('AC-1/6: interrupt timeout を待たず新 turn を開始し旧 emit を落とす', async (t) => {
  const oldGate = deferred();
  const newGate = deferred();
  const brains = [];
  const started = [];
  const emitted = [];
  const cancelled = [];
  const channel = new LatestChannel({
    makeBrain: () => {
      const brain = new FakeBrain(brains.length === 0 ? 'hang' : 'resolve');
      brains.push(brain);
      return brain;
    },
    timeout: async () => {},
    onCancel: (item) => cancelled.push(item.id),
    process: async (item, run) => {
      started.push(item.id);
      await item.gate.promise;
      if (run.isCurrent()) emitted.push(item.id);
    },
  });

  channel.receive(1, { id: 'old', gate: oldGate });
  await tick();
  channel.receive(2, { id: 'new', gate: newGate });
  await tick();
  t(started.join(',') === 'old,new', `新 turn が即開始されない(${started})`);
  t(cancelled.join(',') === 'old', `旧 turn の cancel が 1 回でない(${cancelled})`);
  t(brains[0].interruptCalls === 1, `旧 Brain interrupt が呼ばれていない(${brains[0].interruptCalls})`);

  newGate.resolve();
  oldGate.resolve();
  await tick();
  await tick();
  t(emitted.join(',') === 'new', `旧 callback が emit された(${emitted})`);
  t(brains[0].closeCalls === 1, `期限後に旧 Brain が close されない(${brains[0].closeCalls})`);
});

await section('AC-3: inbox は最新 1 件、別 channel は中断しない', async (t) => {
  const asked = [];
  const dropped = [];
  const latest = new LatestChannel({
    makeBrain: () => new FakeBrain(),
    onCancel: (item) => dropped.push(item),
    process: async (item) => { asked.push(item); },
  });
  latest.receive(1, 'one');
  latest.receive(2, 'two');
  latest.receive(3, 'three');
  await tick();
  t(asked.join(',') === 'three', `FIFO の旧発話まで処理した(${asked})`);
  t(dropped.join(',') === 'one,two', `未処理の旧 inbox が cancel 扱いでない(${dropped})`);

  const gateA = deferred();
  const gateB = deferred();
  const output = [];
  const makeChannel = (name, gate) => new LatestChannel({
    makeBrain: () => new FakeBrain(),
    timeout: async () => {},
    process: async (item, run) => {
      await gate.promise;
      if (run.isCurrent()) output.push(`${name}:${item}`);
    },
  });
  const a = makeChannel('a', gateA);
  const b = makeChannel('b', gateB);
  a.receive(1, 'old');
  b.receive(1, 'keep');
  await tick();
  a.receive(2, 'new');
  await tick();
  gateB.resolve();
  await tick();
  t(output.includes('b:keep'), `別 channel が巻き込まれた(${output})`);
});

await section('AC-2: 1 世代前の TTS は合成後も EventStore に出ない', async (t) => {
  const firstWav = deferred();
  let synthCalls = 0;
  const events = [];
  const metrics = [];
  const plane = new SpeechPlane({
    store: { append: (event) => { events.push(event); return { id: events.length, at: '', ...event }; } },
    registry: {
      get: () => ({ assignedName: 'クロエ', voice: { resolvedSpeaker: 1 } }),
      alive: () => true,
    },
    voice: {
      synthesizeWav: async () => {
        synthCalls++;
        return synthCalls === 1 ? firstWav.promise : Buffer.from('wav');
      },
    },
    putAudio: () => '/audio/fake',
    isEngineReady: () => true,
    reportSynthResult: () => false,
    resolveVoice: async () => 1,
    metric: (kind, extra) => metrics.push({ kind, ...extra }),
    turnChannel: () => 'work',
    userSpeech: { waitUntilDone: async () => {} },
  });

  const oldRevision = plane.advanceRevision('work');
  plane.enqueue({ pid: 'chloe', priority: 1, kind: 'speech', text: 'old', turnId: 'T1', revision: oldRevision, channel: 'work' });
  t(await eventually(() => synthCalls === 1), '旧 job の合成が始まらない');
  const currentRevision = plane.advanceRevision('work');
  firstWav.resolve(Buffer.from('old-wav'));
  await tick();
  await tick();
  t(events.length === 0, `旧 text/audio が append された(${events.length})`);

  plane.enqueue({ pid: 'chloe', priority: 1, kind: 'speech', text: 'new', turnId: 'T2', revision: currentRevision, channel: 'work' });
  t(await eventually(() => events.length === 1), '現 revision の speech が emit されない');
  t(events[0]?.text === 'new' && events[0]?.audio === '/audio/fake', `現 job の内容が違う(${JSON.stringify(events[0])})`);
  t(metrics.some((m) => m.kind === 'tts_ready' && m.turnId === 'T2'), 'tts_ready が turnId 付きで出ない');

  plane.enqueue({ pid: 'chloe', priority: 1, kind: 'speech', text: 'chat stays', turnId: 'C1', revision: plane.revision('chat'), channel: 'chat' });
  t(await eventually(() => events.some((e) => e.turnId === 'C1')), 'work revision が chat 音声まで失効させた');
});

await section('AC-4: Web Speech final は fragment 待ちを通らず即 turn 化する', async (t) => {
  const browser = readFileSync(new URL('../public/room.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  t(browser.includes("send(finalText, { immediate: true, sttFinalAt })"), 'Web Speech final が immediate:true でない');
  t(browser.includes('if (!isReplay) stopSpeaking()'), '短い user_speech で再生停止を通らない');
  t(!browser.includes("(ev.text ?? '').length >= 8"), '旧 8 文字条件が残っている');
  t(server.includes("body.immediate === true ? userSpeech(text) : acceptUtterance(text)"), 'immediate 経路が fragment buffer を迂回しない');
  t(server.includes('setTimeout(() => flushPending(), 250)'), 'speech-state=false の 250ms fallback が無い');
  t(server.includes('turn.cancelEscalation(input.turnId)'), '旧 turn の遅延 filler が cancel されない');
  t(server.includes("kind === 'stt_final' && Number.isFinite(clientAt)"), '保持した STT final 時刻を server の記録時刻に結合していない');
});

await section('AC-5: turn metrics は path 付きで turn_created 基準の単調 ms', async (t) => {
  const clock = new TurnMetricClock();
  clock.begin('T1', 'room', 1_000);
  const rows = [
    clock.event('T1', 'turn_created', 1_000),
    clock.event('T1', 'stt_final', 1_040),
    clock.event('T1', 'brain_first_token', 1_030),
    clock.event('T1', 'tts_ready', 1_120),
  ];
  t(rows.every((row) => row?.path === 'room'), `path が統一されない(${JSON.stringify(rows)})`);
  t(rows.map((row) => row?.ms).join(',') === '0,40,40,120', `ms が単調でない(${JSON.stringify(rows)})`);
});

process.exit(failed ? 1 : 0);
