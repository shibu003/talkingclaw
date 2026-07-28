// テキサスホールデムの純ロジック検査(daemon 不要)。
// 役の判定とポットの分配が壊れたらここで落とす。金が湧かないことを一番厚く見る。
import {
  newTable, startHand, act, decide, evaluate, compare, toCall, potOf, equity, cardName, handText,
} from '../src/poker.ts';

let fail = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✅ ${what}`); else { console.log(`  ❌ ${what}`); fail = 1; } };

// カードを「♠A」のような文字から作る(テストを読みやすくするため)
const R = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const card = (s) => ({ suit: '♠♥♦♣'.indexOf(s[0]), rank: R[s.slice(1)] ?? Number(s.slice(1)) });
const hand = (str) => str.split(' ').map(card);

console.log('[1] 役の判定');
{
  const cases = [
    ['♠A ♠K ♠Q ♠J ♠T ♥2 ♦3', 8, 'ロイヤルフラッシュ'],
    ['♥9 ♥8 ♥7 ♥6 ♥5 ♠A ♠K', 8, 'ストレートフラッシュ'],
    ['♠7 ♥7 ♦7 ♣7 ♠K ♥2 ♦3', 7, 'フォーカード'],
    ['♠7 ♥7 ♦7 ♣K ♠K ♥2 ♦3', 6, 'フルハウス'],
    ['♠A ♠9 ♠7 ♠4 ♠2 ♥K ♦Q', 5, 'フラッシュ'],
    ['♠5 ♥4 ♦3 ♣2 ♠A ♥K ♦9', 4, 'ストレート(5-4-3-2-A のホイール)'],
    ['♠T ♥9 ♦8 ♣7 ♠6 ♥2 ♦3', 4, 'ストレート'],
    ['♠7 ♥7 ♦7 ♣K ♠Q ♥2 ♦3', 3, 'スリーカード'],
    ['♠7 ♥7 ♦K ♣K ♠Q ♥2 ♦3', 2, 'ツーペア'],
    ['♠7 ♥7 ♦K ♣Q ♠J ♥2 ♦3', 1, 'ワンペア'],
    ['♠A ♥J ♦9 ♣7 ♠5 ♥3 ♦2', 0, 'ハイカード'],
  ];
  for (const [cards, cat, what] of cases) {
    const r = evaluate(hand(cards));
    ok(r.cat === cat, `${what}(cat ${r.cat})`);
  }
  // ホイールの一番上は 5(A ではない)
  ok(evaluate(hand('♠5 ♥4 ♦3 ♣2 ♠A ♥K ♦9')).tie[0] === 5, 'ホイールの最高札は 5');
  // 6 枚つながっていたら上の 5 枚で数える
  ok(evaluate(hand('♠9 ♥8 ♦7 ♣6 ♠5 ♥4 ♦2')).tie[0] === 9, '6 枚つながったら上から 5 枚');
}

console.log('[2] 強さくらべ(キッカーまで)');
{
  const cmp = (a, b) => compare(evaluate(hand(a)), evaluate(hand(b)));
  ok(cmp('♠A ♥A ♦K ♣Q ♠J ♥2 ♦3', '♠A ♥A ♦K ♣Q ♠9 ♥2 ♦3') > 0, 'ワンペアはキッカーで決まる');
  ok(cmp('♠K ♥K ♦2 ♣2 ♠A ♥5 ♦7', '♠Q ♥Q ♦J ♣J ♠A ♥5 ♦7') > 0, 'ツーペアは上のペアが強い方');
  ok(cmp('♠3 ♥3 ♦3 ♣2 ♠2 ♥9 ♦8', '♠2 ♥2 ♦2 ♣A ♠A ♥9 ♦8') > 0, 'フルハウスはスリーカードの方で決まる');
  ok(cmp('♠A ♠9 ♠7 ♠4 ♠2 ♥K ♦Q', '♠K ♠9 ♠7 ♠4 ♠2 ♥A ♦Q') > 0, 'フラッシュは上から比べる');
  ok(cmp('♠7 ♥7 ♦K ♣Q ♠J ♥2 ♦3', '♦7 ♣7 ♥K ♠Q ♥J ♦2 ♠3') === 0, 'スートが違うだけなら引き分け');
}

console.log('[3] 同じ seed で同じ札が配られる');
{
  const players = [{ id: 'a', name: 'あなた', human: true }, { id: 'b', name: 'クロエ', human: false }];
  const x = newTable(4242, players); startHand(x);
  const y = newTable(4242, players); startHand(y);
  ok(handText(x.seats[0].hole) === handText(y.seats[0].hole), '同じ seed なら同じ手札');
  const z = newTable(777, players); startHand(z);
  ok(handText(z.seats[0].hole) !== handText(x.seats[0].hole), '違う seed なら違う手札');
  // 近い seed で同じ配札になっていた不具合の再発防止
  const near = new Set([0, 1, 2, 999, 1000, 1001].map((s) => {
    const t = newTable(s, players); startHand(t); return handText(t.seats[0].hole) + handText(t.seats[1].hole);
  }));
  ok(near.size === 6, `近い seed でも配札が別になる(${near.size}/6 種類)`);
}

console.log('[4] ブラインドと手番');
{
  const t = newTable(9, [{ id: 'a', name: 'あ', human: true }, { id: 'b', name: 'い', human: false }, { id: 'c', name: 'う', human: false }]);
  startHand(t);
  ok(potOf(t) === 15, `SB+BB がポットに入る(${potOf(t)})`);
  ok(t.seats[t.toAct].id === 'a', `3 人ならボタンの次の次から(${t.seats[t.toAct].name})`);
  const h = newTable(9, [{ id: 'a', name: 'あ', human: true }, { id: 'b', name: 'い', human: false }]);
  startHand(h);
  ok(h.seats[h.toAct].id === h.seats[h.button].id, 'ヘッズアップはボタンが SB で先に動く');
}

console.log('[5] 反則は断る');
{
  const t = newTable(3, [{ id: 'a', name: 'あ', human: true }, { id: 'b', name: 'い', human: false }]);
  startHand(t);
  const me = t.seats[t.toAct].id;
  ok(act(t, 'zzz', 'call').ok === false, '手番じゃない席は動けない');
  ok(act(t, me, 'check').ok === false, '払うものがあるのにチェックはできない');
  ok(act(t, me, 'raise', t.bet).ok === false, '今の額と同じではレイズにならない');
  ok(act(t, me, 'raise', t.bet + 1).ok === false, '最小レイズ幅より小さいと断る');
  ok(act(t, me, 'raise', t.bet + t.minRaise).ok === true, '最小レイズ幅ちょうどは通る');
}

console.log('[6] 金が湧かない・消えない(400 手)');
{
  const players = [
    { id: 'a', name: 'あなた', human: true, style: 0.5 },
    { id: 'b', name: 'クロエ', human: false, style: 0.72 },
    { id: 'c', name: 'コハク', human: false, style: 0.3 },
    { id: 'd', name: 'まい', human: false, style: 0.55 },
  ];
  const t = newTable(2026, players, 100000, 10);
  const total = () => t.seats.reduce((n, s) => n + s.chips, 0);
  const start = total();
  let broke = 0;
  let showdowns = 0;
  for (let h = 0; h < 400; h++) {
    if (!startHand(t).ok) break;
    let guard = 0;
    while (t.street !== 'done' && guard++ < 400) {
      const during = total() + potOf(t);
      if (during !== start + t.refilled) { ok(false, `手の途中で総額がずれた(${during} ≠ ${start + t.refilled})`); broke = 1; break; }
      const d = decide(t);
      const r = act(t, t.seats[t.toAct].id, d.move, d.amount);
      if (!r.ok) { ok(false, `AI が反則した: ${d.move} ${d.amount} → ${r.error}`); broke = 1; break; }
    }
    if (broke) break;
    if (guard >= 400) { ok(false, '手が終わらない(ループ)'); broke = 1; break; }
    if (t.seats.filter((s) => !s.folded).length > 1) showdowns++;
  }
  if (!broke) {
    ok(total() === start + t.refilled, `400 手で総チップ = 元 + 補充(${total()} = ${start} + ${t.refilled})`);
    ok(showdowns > 20, `ショーダウンがちゃんと起きている(${showdowns} 回)`);
    ok(t.hands === 400, `400 手まわった(${t.hands})`);
  }
}

console.log('[7] サイドポット(短いスタックは自分が出した分までしか取れない)');
{
  const t = newTable(1, [
    { id: 'a', name: '短', human: true }, { id: 'b', name: '中', human: false }, { id: 'c', name: '長', human: false },
  ], 1000, 10);
  startHand(t);
  t.seats[0].chips = 50; t.seats[1].chips = 500; t.seats[2].chips = 5000;
  const before = t.seats.reduce((n, s) => n + s.chips, 0) + potOf(t);
  let guard = 0;
  while (t.street !== 'done' && guard++ < 200) {
    const s = t.seats[t.toAct];
    const r = act(t, s.id, 'allin');
    if (!r.ok) { act(t, s.id, toCall(t, s) > 0 ? 'call' : 'check'); }
  }
  const after = t.seats.reduce((n, s) => n + s.chips, 0);
  ok(after === before, `全員オールインでも総額が保たれる(${after} = ${before})`);
  const shortSeat = t.seats[0];
  ok((shortSeat.won ?? 0) <= shortSeat.totalIn * 3, '短いスタックは出した額 × 人数を超えて取らない');
}

console.log('[8] 勝率の見立てが常識と合う');
{
  const t = newTable(5, [{ id: 'a', name: 'あ', human: true }, { id: 'b', name: 'い', human: false }], 1000, 10);
  startHand(t);
  t.board = [];
  t.seats[0].hole = hand('♠A ♥A');
  const aa = equity(t, t.seats[0], 600);
  t.seats[0].hole = hand('♠7 ♥2');
  const junk = equity(t, t.seats[0], 600);
  ok(aa > 0.75, `AA の勝率は 8 割前後(${(aa * 100).toFixed(0)}%)`);
  ok(junk < 0.45, `72o は分が悪い(${(junk * 100).toFixed(0)}%)`);
  ok(aa > junk, 'AA は 72o より強いと判断する');
}

console.log('[9] 伏せ札は見せない');
{
  const t = newTable(8, [{ id: 'a', name: 'あなた', human: true }, { id: 'b', name: 'クロエ', human: false }], 1000, 10);
  startHand(t);
  const { describe } = await import('../src/poker.ts');
  const said = describe(t, 'a');
  const theirs = t.seats[1].hole.map(cardName);
  ok(theirs.every((c) => !said.includes(c)), '相手の手札は読み上げ文に出ない');
  ok(t.seats[0].hole.every((c) => said.includes(cardName(c))), '自分の手札は出る');
}

console.log(fail === 0 ? '\nポーカー: ALL PASS' : '\nポーカー: FAIL あり');
process.exit(fail);
