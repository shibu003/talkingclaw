// ブラックジャックの純ロジック検査(daemon 不要)。
// 金の計算とカードの配り方が壊れたらここで落とす。
import {
  newGame, startHand, hit, stand, double, handValue, isBlackjack, cardName, describe, addChips, MIN_BET,
} from '../src/blackjack.ts';

let fail = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✅ ${what}`); else { console.log(`  ❌ ${what}`); fail = 1; } };

// A の数え方(これを間違えると全部おかしくなる)
{
  const c = (rank, suit = 0) => ({ rank, suit });
  ok(handValue([c(1), c(13)]).total === 21, 'A + K は 21');
  ok(handValue([c(1), c(1)]).total === 12, 'A + A は 12(片方は 1)');
  ok(handValue([c(1), c(6)]).soft === true, 'A + 6 はソフト 17');
  ok(handValue([c(1), c(6), c(10)]).total === 17, 'A6 に 10 を足したら 17(A を 1 に落とす)');
  ok(handValue([c(1), c(6), c(10)]).soft === false, '落としたらソフトではない');
  ok(handValue([c(10), c(10), c(5)]).total === 25, '25 はバースト値としてそのまま出る');
  ok(isBlackjack([c(1), c(12)]) && !isBlackjack([c(1), c(5), c(5)]), 'ブラックジャックは 2 枚の 21 だけ');
  ok(cardName(c(1, 1)) === '♥A' && cardName(c(10, 0)) === '♠10', 'カードの表記');
}

// 同じ seed なら同じ札順(= ズルしていないことを後から確かめられる)
{
  const a = newGame(12345); startHand(a, 100);
  const b = newGame(12345); startHand(b, 100);
  ok(JSON.stringify(a.player) === JSON.stringify(b.player)
    && JSON.stringify(a.dealer) === JSON.stringify(b.dealer), '同じ seed で同じ札が配られる');
  const c = newGame(999); startHand(c, 100);
  ok(JSON.stringify(a.shoe) !== JSON.stringify(c.shoe), '違う seed なら違う山になる');
  // 近い seed で同じ山になっていた不具合の再発防止(素朴な xorshift だと起きる)
  const near = new Set([0, 1, 2, 999, 1000, 1001].map((s) => JSON.stringify(newGame(s).shoe.slice(0, 10))));
  ok(near.size === 6, `近い seed でも山が別になる(${near.size}/6 種類)`);
}

// 山の中身: 6 デッキ ぴったりで、各カードが 6 枚ずつ
{
  const g = newGame(7);
  ok(g.shoe.length === 312, '6 デッキ = 312 枚');
  const counts = new Map();
  for (const c of g.shoe) counts.set(`${c.suit}-${c.rank}`, (counts.get(`${c.suit}-${c.rank}`) ?? 0) + 1);
  ok(counts.size === 52 && [...counts.values()].every((n) => n === 6), '52 種類が 6 枚ずつ');
}

// 賭け金の出し入れ(ここが狂うとチップが湧く/消える)
{
  const g = newGame(1, 500);
  startHand(g, 100);
  ok(g.chips === 400, '賭けた分はすぐ引かれる');
  const before = g.chips;
  while (g.phase === 'player') (handValue(g.player).total < 17 ? hit(g) : stand(g));
  const back = g.chips - before;
  const expect = { blackjack: 250, win: 200, push: 100, lose: 0, bust: 0 }[g.result];
  ok(back === expect, `払い戻しが結果と合う(${g.result} → ${back})`);
  ok(g.chips === 400 + expect, '手が終わった後のチップが合う');
}

// 1000 手回して、チップの増減が payout の合計とぴったり一致するか(金が湧かない)
{
  const g = newGame(2024, 100000);
  const start = g.chips;
  let sum = 0;
  let played = 0;
  for (let i = 0; i < 1000 && g.chips >= MIN_BET; i++) {
    if (!startHand(g, 100).ok) break;
    while (g.phase === 'player') {
      const v = handValue(g.player);
      if (v.total < 17) hit(g); else stand(g);
    }
    sum += g.payout;
    played++;
  }
  ok(played === 1000, `1000 手まわった(${played})`);
  ok(g.chips === start + sum, `チップの増減 = payout の合計(${g.chips - start} vs ${sum})`);
  ok(g.wins + g.losses + g.pushes === played, '勝敗の数え上げが手数と合う');
  // ハウスエッジ: ベーシックから外れた素朴戦略なので負け越すのが正しい(勝ち越すなら計算が壊れている)
  const rate = (g.chips - start) / (played * 100);
  ok(rate < 0 && rate > -0.15, `収支が現実的な範囲(${(rate * 100).toFixed(1)}%)`);
}

// ダブルは最初の 2 枚だけ / チップが足りない時は断る
{
  const g = newGame(5, 300);
  startHand(g, 100);
  if (g.phase === 'player') {
    hit(g);
    if (g.phase === 'player') ok(double(g).ok === false, '3 枚目からはダブルできない');
    else ok(true, '3 枚目からはダブルできない(引いて決着したので判定省略)');
  }
  const h = newGame(11, 100);
  startHand(h, 100);
  if (h.phase === 'player') ok(double(h).ok === false, 'チップが足りなければダブルを断る');
  else ok(true, 'チップが足りなければダブルを断る(即決着で判定省略)');
}

// ディーラーはソフト 17 で引く(H17)。17 以上で止まる
{
  let checked = 0;
  for (let seed = 0; seed < 400 && checked < 60; seed++) {
    const g = newGame(seed, 1000);
    startHand(g, 10);
    if (g.phase !== 'player') continue;
    stand(g);
    const d = handValue(g.dealer);
    if (d.total <= 21) {
      if (!(d.total >= 17 && !(d.total === 17 && d.soft))) { ok(false, `ディーラーが ${d.total}${d.soft ? '(ソフト)' : ''} で止まった`); break; }
      checked++;
    }
  }
  ok(checked > 0, `ディーラーは 17 以上(ソフト 17 は引く)で止まる(${checked} 手で確認)`);
}

// 手の途中では伏せ札を明かさない(声に出す文の検査)
{
  const g = newGame(3, 1000);
  startHand(g, 50);
  if (g.phase === 'player') {
    const said = describe(g);
    ok(said.includes('伏せ札') && !said.includes(cardName(g.dealer[1])), '手の途中はディーラーの 2 枚目を隠す');
  } else ok(true, '手の途中はディーラーの 2 枚目を隠す(即決着で判定省略)');
}

// チップ切れと補充
{
  const g = newGame(4, 5);
  ok(startHand(g, 100).ok === false, 'チップ不足では始められない');
  addChips(g, 1000);
  ok(startHand(g, 100).ok === true, '補充すれば始められる');
}

console.log(fail === 0 ? '\nブラックジャック: ALL PASS' : '\nブラックジャック: FAIL あり');
process.exit(fail);
