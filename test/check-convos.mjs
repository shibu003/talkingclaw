// src/convos/ を通る唯一の検査(判定 001-1 で挿入)。ここが空だったので、turn.ts の route() を
// 壊しても check-ui は 11/11 のまま通っていた(judgments/001 §1)。
//
// 既存の check-git / check-artifacts のような「room.ts からテキストを切り出して評価」はしない。
// 切り出しは移送で位置を失う(それが今回の発端)。TurnPlane は依存注入なので import して
// 偽の依存を渡して呼べる。速い・移送しても壊れない。
import { TurnPlane } from '../src/convos/turn.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 部屋のアプリ状態(registry / store / cue / 在室判定)は全部注入なので、最小の偽物で足りる
function makePlane(people, chloe = 'chloe') {
  const events = [];
  const metrics = [];
  const participants = new Map(people.map((p) => [p.pid, {
    participantId: p.pid,
    assignedName: p.name ?? '',
    requestedName: p.name ?? '',
    ephemeral: p.ephemeral === true,
    alive: p.alive !== false,
    room: p.room !== false,
  }]));
  const turn = new TurnPlane({
    store: { append: (e) => { const ev = { id: events.length + 1, ...e }; events.push(ev); return ev; } },
    registry: {
      all: () => [...participants.values()],
      get: (pid) => participants.get(pid),
      alive: (p) => p.alive === true,
    },
    metric: (kind, extra) => metrics.push({ kind, ...extra }),
    userSpeech: { active: false },
    contextCue: (pid, rotate) => ({ text: `文脈 ${pid} ${rotate}`, audio: null }),
    statusCue: () => ({ text: '状況報告', audio: null }),
    undeliveredCue: () => ({ text: '未達通知', audio: null }),
    inThisRoom: (pid) => pid === chloe || (participants.get(pid)?.room === true),
    chloePid: () => chloe,
  });
  return { turn, events, metrics };
}

// 12s / 8s の実時間待ちを避けるための一時的な時間短縮。timer を作る呼び出しだけを挟む
// (Date.now() は触らない = 連発防止の 60s 判定は本物のまま)
function withFastTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms) => real(cb, Math.min(ms, 5));
  try { return fn(); } finally { globalThis.setTimeout = real; }
}

let fail = 0;
const section = async (name, body) => {
  const errs = [];
  await body((cond, msg) => { if (!cond) errs.push(msg); });
  if (errs.length > 0) { console.log(`  ❌ ${name}: ${errs.join(' / ')}`); fail = 1; } else console.log(`  ✅ ${name}`);
};

const CAST = [
  { pid: 'chloe', name: 'クロエ' },
  { pid: 'koh', name: 'コハク' },
  { pid: 'sel', name: 'セレナ' },
  { pid: 'flr', name: 'フローラ' },
  { pid: 'dead', name: 'ミナト', alive: false },
];
const NO_NAME = 'ねえ、これ直して'; // 誰の名前も含まない = 名前指定を発動させない文

await section('ルーティング優先順位 5 段(上位が不在なら下位に落ちる)', async (t) => {
  // ① 名前指定。下位(選択・floor・last_responder)が全部埋まっていても名前が勝つ
  {
    const { turn } = makePlane(CAST);
    turn.select('sel');
    turn.advanceFloor('flr');
    const r = turn.route('コハク、これ直して');
    t(r.routing.method === 'name' && r.targets.join() === 'koh', `① 名前指定が勝たない(${r.routing.method}/${r.targets})`);
    t(r.routing.matchedAlias === 'コハク', `① matchedAlias が付かない(${r.routing.matchedAlias})`);
    // 文中の言及(開始位置 >5)は呼びかけではない
    t(turn.route('あとで手が空いたらコハクに頼む').routing.method !== 'name', '① 文中の言及を呼びかけと誤判定している');
  }
  // ② UI 選択。名前が無ければ選択が floor / last_responder より先
  {
    const { turn } = makePlane(CAST);
    turn.select('sel');
    turn.advanceFloor('flr');
    const r = turn.route(NO_NAME);
    t(r.routing.method === 'selection' && r.targets.join() === 'sel', `② 選択に行かない(${r.routing.method}/${r.targets})`);
  }
  // ③ floor 保持者。選択が無い(または選択先が gone)なら floor
  {
    const { turn } = makePlane(CAST);
    turn.advanceFloor('flr');
    const r = turn.route(NO_NAME);
    t(r.routing.method === 'floor' && r.targets.join() === 'flr', `③ floor に落ちない(${r.routing.method}/${r.targets})`);
    turn.select('dead'); // gone を選択中 → floor へ落ちる(S4)
    const r2 = turn.route(NO_NAME);
    t(r2.routing.method === 'floor' && r2.targets.join() === 'flr', `③ gone の選択が解除されない(${r2.routing.method}/${r2.targets})`);
  }
  // ④ last_responder。floor が未達通知で解除されても、直前に答えた者へは流れる
  {
    const { turn } = makePlane(CAST);
    turn.advanceFloor('flr');
    turn.track('T1', 'flr', '直して', 'work'); // 配送しない = 未達
    withFastTimers(() => turn.scheduleUndeliveredNotice('T1', 'flr'));
    await sleep(30);
    t(turn.floor === null, '④ 未達通知で floor が解除されていない');
    const r = turn.route(NO_NAME);
    t(r.routing.method === 'last_responder' && r.targets.join() === 'flr', `④ last_responder に落ちない(${r.routing.method}/${r.targets})`);
  }
  // ⑤ default。何も無ければクロエ
  {
    const { turn } = makePlane(CAST);
    const r = turn.route(NO_NAME);
    t(r.routing.method === 'default' && r.targets.join() === 'chloe', `⑤ 既定がクロエでない(${r.routing.method}/${r.targets})`);
  }
});

await section('speak の自動帰属(配送済み・未応答の最古 → 無ければ最新の自分宛)', async (t) => {
  const { turn } = makePlane(CAST);
  for (const id of ['T1', 'T2', 'T3']) turn.track(id, 'koh', '直して', 'work');
  turn.markDelivered('T2', 'koh'); // T1 / T3 は未配送
  t(turn.attribute('koh', undefined) === 'T2', '未配送の turn に帰属している(配送済みだけが対象)');
  t(turn.attribute('koh', undefined) === 'T3', '配送済みが尽きたとき最新の自分宛に落ちない');
  t(turn.attribute('sel', undefined) === undefined, '自分宛が無いのに turn を掴んでいる');
  t(turn.attribute('koh', 'T1') === 'T1', '明示 turnId を返していない');
  t(turn.attribute('koh', 'none') === 'none', "'none' を素通ししていない");

  // 「最古」であること + 応答済みを再帰属しないこと
  const b = makePlane(CAST);
  for (const id of ['A1', 'A2']) { b.turn.track(id, 'koh', '直して', 'work'); b.turn.markDelivered(id, 'koh'); }
  t(b.turn.attribute('koh', undefined) === 'A1', '配送済み・未応答の最古ではなく別の turn を選んでいる');
  t(b.turn.attribute('koh', undefined) === 'A2', '応答済みの turn を二度帰属している');
});

await section('窓を閉じた turn(打切り / 未達)は自動帰属から外れる', async (t) => {
  const { turn, events, metrics } = makePlane(CAST);
  turn.track('C1', 'koh', '直して', 'work');
  turn.markDelivered('C1', 'koh');
  turn.scheduleEscalation('C1', 'koh', 3, 1); // 最終段 = 打切り(窓閉じ)
  await sleep(30);
  t(events.some((e) => e.text === '返事が来たら教えるね'), '対照: 打切りが発火していない(この検査は何も見ていない)');
  t(metrics.some((m) => m.kind === 'turn_window_closed' && m.turnId === 'C1' && m.reason === 'exhausted'), '打切りの metric が出ていない');
  turn.track('C2', 'koh', 'もう一回', 'work');
  turn.markDelivered('C2', 'koh');
  // 打切り済みの C1(より古い)ではなく C2 に帰属する。以降の C1 への返信は明示 turnId の領分
  t(turn.attribute('koh', undefined) === 'C2', '窓を閉じた turn に自動帰属している');
});

await section('新 turn が同じ相手の旧 escalation を supersede する', async (t) => {
  // 対照: supersede が無ければ文脈 filler が出る(出ないなら以下の 2 件は空証明)
  {
    const { turn, events } = makePlane(CAST);
    turn.track('T1', 'koh', '直して', 'work');
    turn.markDelivered('T1', 'koh');
    turn.scheduleEscalation('T1', 'koh', 1, 1);
    await sleep(30);
    t(events.some((e) => e.filler === 'context'), '対照: escalation が発火していない(この検査は何も見ていない)');
  }
  // 同じ相手への新 turn → 旧 escalation は止まる
  {
    const { turn, events } = makePlane(CAST);
    turn.track('T1', 'koh', '直して', 'work');
    turn.markDelivered('T1', 'koh');
    turn.scheduleEscalation('T1', 'koh', 1, 20);
    turn.track('T2', 'koh', 'こっちを先に', 'work');
    await sleep(60);
    t(!events.some((e) => e.filler === 'context'), '新 turn が同じ相手の旧 escalation を止めていない');
  }
  // 別の相手への新 turn では止まらない(全部消してしまうと相槌が死ぬ)
  {
    const { turn, events } = makePlane(CAST);
    turn.track('T1', 'koh', '直して', 'work');
    turn.markDelivered('T1', 'koh');
    turn.scheduleEscalation('T1', 'koh', 1, 20);
    turn.track('T2', 'sel', '別の話', 'work');
    await sleep(60);
    t(events.some((e) => e.filler === 'context'), '別の相手への turn が無関係な escalation を消している');
  }
});

process.exit(fail);
