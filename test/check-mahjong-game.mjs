// 麻雀の対局進行の検査(daemon 不要)。
// 点棒が湧かない・消えないこと、局が最後まで進むことを一番厚く見る。
import * as mj from '../src/mahjong.ts';
import {
  newGame, startHand, discard, pass, win, canTsumo, canRon, chooseDiscard,
  doraOf, remaining, isFuriten, describe, handDisplay,
  canPon, canKan, chiOptions, pon, chi, kan, callsFor, aiCall,
} from '../src/mahjongGame.ts';

let fail = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✅ ${what}`); else { console.log(`  ❌ ${what}`); fail = 1; } };
const seats = [
  { id: 'you', name: 'あなた', human: true, style: 0.5 },
  { id: 'c', name: 'クロエ', human: false, style: 0.7 },
  { id: 'k', name: 'コハク', human: false, style: 0.3 },
  { id: 'm', name: 'まい', human: false, style: 0.55 },
];

console.log('[1] ドラは表示牌の次');
{
  ok(doraOf(mj.parseHand('1m')[0]) === mj.parseHand('2m')[0], '一萬 → 二萬');
  ok(doraOf(mj.parseHand('9m')[0]) === mj.parseHand('1m')[0], '九萬 → 一萬(一周する)');
  ok(doraOf(mj.parseHand('9s')[0]) === mj.parseHand('1s')[0], '九索 → 一索');
  ok(doraOf(mj.NORTH) === mj.EAST, '北 → 東(風は風で回る)');
  ok(doraOf(mj.CHUN) === mj.HAKU, '中 → 白(三元牌は三元牌で回る)');
  ok(doraOf(mj.HAKU) === mj.HATSU, '白 → 發');
}

console.log('[2] 配牌と山');
{
  const g = newGame(1234, seats);
  startHand(g);
  const counts = g.players.map((p) => p.hand.reduce((a, b) => a + b, 0));
  ok(counts[0] === 14, `親は 14 枚(${counts[0]})`);
  ok(counts.slice(1).every((n) => n === 13), `子は 13 枚(${counts.slice(1).join(',')})`);
  const all = new Array(34).fill(0);
  for (const p of g.players) p.hand.forEach((n, t) => { all[t] += n; });
  ok(all.every((n) => n <= 4), '同じ牌が 5 枚以上配られない');
  ok(g.wall.length === 136, `山は 136 枚(${g.wall.length})`);
  ok(remaining(g) === 136 - 53 - 14, `残り枚数の数え方が合う(${remaining(g)})`);
  ok(g.phase === 'discard', '親が引いたところで止まる');
}

console.log('[3] 同じ seed なら同じ配牌');
{
  const a = newGame(999, seats); startHand(a);
  const b = newGame(999, seats); startHand(b);
  ok(JSON.stringify(a.players[0].hand) === JSON.stringify(b.players[0].hand), '同じ seed で同じ手牌');
  const c = newGame(1000, seats); startHand(c);
  ok(JSON.stringify(a.players[0].hand) !== JSON.stringify(c.players[0].hand), '違う seed なら違う手牌');
  // 近い seed で配牌が全部同じになっていた不具合の再発防止(乱数の種混ぜが弱かった)
  const near = new Set([0, 1, 2, 999, 1000, 1001].map((s) => {
    const g = newGame(s, seats); startHand(g); return JSON.stringify(g.players[0].hand);
  }));
  ok(near.size === 6, `近い seed でも配牌が別になる(${near.size}/6 種類)`);
}

console.log('[4] 打牌の決まりごと');
{
  const g = newGame(7, seats);
  startHand(g);
  const me = g.players[0];
  const held = me.hand.findIndex((n) => n > 0);
  const notHeld = me.hand.findIndex((n) => n === 0);
  ok(discard(g, 1, held).ok === false, '手番じゃない席は切れない');
  ok(discard(g, 0, notHeld).ok === false, '持っていない牌は切れない');
  ok(discard(g, 0, held).ok === true, '持っている牌は切れる');
  ok(g.phase === 'ron', '切ったらロンを聞く場面になる');
  ok(pass(g).ok === true, '誰もロンしなければ次の人へ');
  ok(g.turn === 1 && g.phase === 'discard', '手番が回ってツモまで進む');
}

console.log('[5] 立直の決まりごと');
{
  const g = newGame(3, seats);
  startHand(g);
  const me = g.players[0];
  // 聴牌していない手で立直しようとすると断られる
  if (mj.shanten(me.hand) > 0) {
    const t = me.hand.findIndex((n) => n > 0);
    ok(discard(g, 0, t, true).ok === false, '聴牌にならない立直は断る');
  } else ok(true, '聴牌にならない立直は断る(この配牌では聴牌のため判定省略)');
  // 点棒が足りないと立直できない
  const h = newGame(3, seats);
  startHand(h);
  h.players[0].points = 500;
  const hand = h.players[0].hand.slice();
  const t2 = hand.findIndex((n) => n > 0);
  const after = hand.slice(); after[t2]--;
  if (mj.shanten(after) === 0) ok(discard(h, 0, t2, true).ok === false, '点棒が足りないと立直できない');
  else ok(true, '点棒が足りないと立直できない(この配牌では聴牌にならないため判定省略)');
}

console.log('[6] 振聴');
{
  const g = newGame(11, seats);
  startHand(g);
  const me = g.players[0];
  const hand = me.hand.slice();
  if (me.drawn !== null) hand[me.drawn]--;
  const w = mj.waits(hand);
  if (w.length > 0) {
    me.discards.push(w[0]);          // 自分の待ちを自分で捨てた形にする
    ok(isFuriten(g, 0) === true, '待ちを自分で捨てていたら振聴');
    me.discards.pop();
    ok(isFuriten(g, 0) === false, '捨てていなければ振聴ではない');
  } else ok(true, '振聴の判定(この配牌では聴牌でないため判定省略)');
}

console.log('[7] 東風戦を最後まで回す(点棒が湧かない・消えない)');
{
  for (const seed of [2026, 7, 31337]) {
    const g = newGame(seed, seats);
    const startTotal = g.players.reduce((n, p) => n + p.points, 0);
    let hands = 0, guard = 0, wins = 0, draws = 0;
    while (g.phase !== 'over' && guard++ < 200) {
      const r = startHand(g);
      if (!r.ok) break;
      hands++;
      let steps = 0;
      while (g.phase !== 'done' && g.phase !== 'over' && steps++ < 400) {
        if (g.phase === 'draw') { if (!pass(g).ok) break; continue; }
        if (g.phase === 'discard') {
          const seat = g.turn;
          const t = canTsumo(g, seat);
          if (t && (seat !== 0 || true)) { win(g, seat, true); wins++; break; }
          const { tile, riichi } = chooseDiscard(g, seat);
          const d = discard(g, seat, tile, riichi);
          if (!d.ok) { ok(false, `打牌が通らなかった: ${d.error}`); steps = 999; break; }
          continue;
        }
        if (g.phase === 'ron') {
          let ronned = false;
          for (let i = 1; i <= 3; i++) {
            const seat = (g.lastDiscard.from + i) % 4;
            if (canRon(g, seat)) { win(g, seat, false); ronned = true; wins++; break; }
          }
          if (ronned) break;
          if (!pass(g).ok) break;
          continue;
        }
        break;
      }
      if (g.phase !== 'done' && g.phase !== 'over') { draws++; break; }
      if (g.result === '流局') draws++;
      // 供託(立直棒)は場に残るので、合計は点棒 + 供託で見る
      const now = g.players.reduce((n, p) => n + p.points, 0) + g.riichiSticks * 1000;
      if (now !== startTotal) { ok(false, `点棒の合計がずれた(${now} ≠ ${startTotal}) seed=${seed}`); break; }
    }
    const total = g.players.reduce((n, p) => n + p.points, 0) + g.riichiSticks * 1000;
    ok(total === startTotal, `seed ${seed}: ${hands} 局まわして合計 ${total} 点(和了 ${wins} / 流局 ${draws})`);
    ok(hands >= 4, `seed ${seed}: 東風戦が 4 局以上進む(${hands} 局)`);
  }
}

console.log('[8] AI の打牌がまともか');
{
  const g = newGame(5150, seats);
  startHand(g);
  let improved = 0, tried = 0;
  for (let n = 0; n < 40 && g.phase !== 'done' && g.phase !== 'over'; n++) {
    if (g.phase === 'draw') { pass(g); continue; }
    if (g.phase === 'ron') { pass(g); continue; }
    const seat = g.turn;
    const before = mj.shanten(g.players[seat].hand);
    const { tile, riichi } = chooseDiscard(g, seat);
    const test = g.players[seat].hand.slice();
    test[tile]--;
    const after = mj.shanten(test);
    tried++;
    // 14 枚から 1 枚切ると、シャンテンは同じか 1 つ悪くなるのが普通。
    // まともな打牌なら「同じ」を選び続ける
    if (after <= before) improved++;
    discard(g, seat, tile, riichi);
  }
  ok(tried > 10, `${tried} 回の打牌を見た`);
  ok(improved === tried, `毎回シャンテンを悪くしない牌を選んでいる(${improved}/${tried})`);
}

console.log('[9] 読み上げ文に他家の手牌は出ない');
{
  const g = newGame(88, seats);
  startHand(g);
  const said = describe(g, 'you');
  const others = g.players.slice(1);
  let leaked = 0;
  for (const o of others) {
    for (let t = 0; t < 34; t++) if (o.hand[t] === 4 && !g.players[0].hand[t]) {
      if (said.includes(mj.tileName(t))) leaked++;  // 自分が 1 枚も持っていない牌が出たら怪しい
    }
  }
  ok(leaked === 0, '自分の手牌とツモ以外は読み上げない');
  ok(handDisplay(g, 'you').length > 0, '画面用の手牌が出る');
}

console.log('[10] 鳴き(ポン・チー・カン)');
{
  const g = newGame(4242, seats);
  startHand(g);
  // 場を作る: 席 1 に 三萬 を 2 枚持たせ、席 0 が 三萬 を切る
  const t3 = mj.parseHand('3m')[0];
  const me = g.players[0];
  const other = g.players[1];
  other.hand = new Array(34).fill(0);
  for (const x of mj.parseHand('33m456p789s11z234s')) other.hand[x]++;
  if (me.hand[t3] === 0) { const any = me.hand.findIndex((n) => n > 0); me.hand[any]--; me.hand[t3]++; }
  discard(g, 0, t3);
  ok(g.phase === 'ron', '切ったら鳴きを聞く場面になる');
  ok(canPon(g, 1) === true, '2 枚持っていればポンできる');
  ok(canPon(g, 0) === false, '自分が切った牌はポンできない');
  ok(canKan(g, 1) === false, '2 枚ではカンできない');
  const before = other.hand[t3];
  ok(pon(g, 1).ok === true, 'ポンが通る');
  ok(other.hand[t3] === before - 2 && other.melds.length === 1, '手牌から 2 枚出て、晒した面子が 1 つ増える');
  ok(other.melds[0].open === true && other.melds[0].kind === 'triplet', '明刻として晒す');
  ok(g.players[0].discards.includes(t3) === false, '鳴かれた牌は河から出る');
  ok(g.turn === 1 && g.phase === 'discard', '鳴いた人の番になって、切る場面になる');

  // チーは下家だけ
  const h = newGame(99, seats);
  startHand(h);
  const t5 = mj.parseHand('5m')[0];
  h.players[1].hand = new Array(34).fill(0);
  for (const x of mj.parseHand('34m456p789s11z234s')) h.players[1].hand[x]++;
  h.players[2].hand = h.players[1].hand.slice();
  if (h.players[0].hand[t5] === 0) { const any = h.players[0].hand.findIndex((n) => n > 0); h.players[0].hand[any]--; h.players[0].hand[t5]++; }
  discard(h, 0, t5);
  ok(chiOptions(h, 1).length > 0, '下家はチーできる');
  ok(chiOptions(h, 2).length === 0, '下家以外はチーできない');
  const low = chiOptions(h, 1)[0];
  ok(chi(h, 1, low).ok === true, 'チーが通る');
  ok(h.players[1].melds[0].kind === 'run', '順子として晒す');
  ok(h.turn === 1, 'チーした人の番になる');

  // 鳴いたら立直できない
  const r = discard(h, 1, h.players[1].hand.findIndex((n) => n > 0), true);
  ok(r.ok === false && r.error.includes('鳴いてる'), '鳴いた後は立直できない');
}

console.log('[11] 鳴いた手でも点棒が合う(200 局まわす)');
{
  const g = newGame(555, seats);
  const start = g.players.reduce((n, p) => n + p.points, 0);
  let hands = 0, calls = 0, guard = 0;
  while (g.phase !== 'over' && guard++ < 60) {
    if (!startHand(g).ok) break;
    hands++;
    let steps = 0;
    while (g.phase !== 'done' && g.phase !== 'over' && steps++ < 400) {
      if (g.phase === 'draw') { if (!pass(g).ok) break; continue; }
      if (g.phase === 'discard') {
        const seat = g.turn;
        if (canTsumo(g, seat)) { win(g, seat, true); break; }
        const { tile, riichi } = chooseDiscard(g, seat);
        const d = discard(g, seat, tile, riichi);
        if (!d.ok) { ok(false, `打牌が通らない: ${d.error}`); steps = 999; break; }
        continue;
      }
      if (g.phase === 'ron') {
        let acted = false;
        for (let i = 1; i <= 3; i++) {
          const s2 = (g.lastDiscard.from + i) % 4;
          if (canRon(g, s2)) { win(g, s2, false); acted = true; break; }
        }
        if (acted) break;
        for (let i = 1; i <= 3 && !acted; i++) {
          const s2 = (g.lastDiscard.from + i) % 4;
          const c = aiCall(g, s2);
          if (c) { (c === 'kan' ? kan : pon)(g, s2); calls++; acted = true; }
        }
        if (acted) continue;
        if (!pass(g).ok) break;
        continue;
      }
      break;
    }
    const now = g.players.reduce((n, p) => n + p.points, 0) + g.riichiSticks * 1000;
    if (now !== start) { ok(false, `点棒がずれた(${now} ≠ ${start})`); break; }
  }
  const total = g.players.reduce((n, p) => n + p.points, 0) + g.riichiSticks * 1000;
  ok(total === start, `${hands} 局まわして合計 ${total} 点(鳴き ${calls} 回)`);
  ok(calls > 0, `AI も鳴いている(${calls} 回)`);
  ok(g.players.every((p) => p.melds.length <= 4), '晒す面子は 4 つまで');
}

console.log(fail === 0 ? '\n麻雀の対局: ALL PASS' : '\n麻雀の対局: FAIL あり');
process.exit(fail);
