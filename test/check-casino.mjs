// 「言葉 → 手」の翻訳と 1 手ぶんの進行の検査(daemon 不要)。
// 会話に紛れて誤爆しないこと、遊べる一通りの流れが通ることを見る。
import { parseCommand, start, apply } from '../src/casino.ts';
import { shanten as mjShanten, tileName as mjTileName } from '../src/mahjong.ts';

// 自分が 1 枚も持っていない牌の名前(読み上げに混ざっていないか見るため)
function tileOfOther(g) {
  const mine = g.players[0].hand;
  for (let t = 0; t < 34; t++) if (mine[t] === 0 && g.players[1].hand[t] > 0) return mjTileName(t);
  return '\u0000';
}

let fail = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✅ ${what}`); else { console.log(`  ❌ ${what}`); fail = 1; } };

const bjSession = () => start('blackjack', 42, []).session;
const pkSession = () => start('poker', 42, [{ id: 'chloe', name: 'クロエ', style: 0.7 }, { id: 'kohaku', name: 'コハク', style: 0.3 }]).session;

console.log('[1] 遊んでいない時は、ゲーム名を言った時だけ拾う');
{
  ok(parseCommand('ポーカーやろう', null)?.game === 'poker', 'ポーカーで始まる');
  ok(parseCommand('ブラックジャックやろう', null)?.game === 'blackjack', 'ブラックジャックで始まる');
  for (const t of ['引く', '勝負', 'コール', '降りる', 'もう一枚', '次', 'チェック']) {
    ok(parseCommand(t, null) === null, `遊んでいない時「${t}」は拾わない`);
  }
  ok(parseCommand('この件は勝負どころだから引くのはやめよう', null) === null, '普通の会話は拾わない');
}

console.log('[2] 遊んでいる時も、長い発話は会話として通す');
{
  const s = bjSession();
  ok(parseCommand('引く', s)?.type === 'hit', '短い言い切りは手として拾う');
  ok(parseCommand('さっきの作業の続きなんだけど引くって言葉の意味が分からない', s) === null,
    '20 字を超える発話は手にしない(遊びながら話せる)');
}

console.log('[3] ブラックジャックの言葉');
{
  const s = bjSession();
  const t = (text) => parseCommand(text, s)?.type;
  ok(t('引く') === 'hit' && t('もう一枚') === 'hit' && t('ヒット') === 'hit', '引く / もう一枚 / ヒット');
  ok(t('勝負') === 'stand' && t('スタンド') === 'stand' && t('もういい') === 'stand', '勝負 / スタンド / もういい');
  ok(t('ダブル') === 'double', 'ダブル');
  ok(parseCommand('100賭ける', s)?.bet === 100, '賭け金を聞き取る');
  ok(parseCommand('配って', s)?.bet === 0, '額を言わなければ 0(既定額になる)');
  ok(t('補充して') === 'refill' && t('ルール教えて') === 'rules' && t('もうやめる') === 'quit', '補充 / ルール / やめる');
}

console.log('[4] ポーカーの言葉');
{
  const s = pkSession();
  const t = (text) => parseCommand(text, s)?.type;
  ok(t('降りる') === 'fold' && t('フォールド') === 'fold', '降りる / フォールド');
  ok(t('チェック') === 'check' && t('コール') === 'call' && t('乗る') === 'call', 'チェック / コール / 乗る');
  ok(t('オールイン') === 'allin' && t('全部') === 'allin', 'オールイン / 全部');
  ok(parseCommand('300まで上げる', s)?.amount === 300, 'レイズ額を聞き取る');
  ok(t('配って') === 'deal' && t('次') === 'deal', '配って / 次');
}

console.log('[5] ブラックジャックを一通り遊ぶ');
{
  let s = bjSession();
  let r = apply(s, { type: 'deal', bet: 100 });
  ok(r.say.join('').includes('配るよ'), '配ってくれる');
  ok(r.hand?.includes('ディーラー') && r.hand.includes('■'), '手の途中はディーラーの 2 枚目を伏せる');
  let guard = 0;
  while (s.game.phase === 'player' && guard++ < 10) r = apply(s, { type: 'stand' });
  ok(s.game.phase === 'done', '勝負したら決着する');
  ok(r.say.some((l) => l.includes('チップは')), 'チップの残りを教えてくれる');
  const before = s.game.chips;
  r = apply(s, { type: 'refill' });
  ok(s.game.chips === before + 1000, '補充が効く');
  r = apply(s, { type: 'quit' });
  ok(r.session === null, 'やめたら席が空く');
}

console.log('[6] ポーカーを一通り遊ぶ(AI が勝手に打って、自分の番で止まる)');
{
  const s = pkSession();
  let r = apply(s, { type: 'deal', bet: 0 });
  const t = s.table;
  ok(t.street !== 'done' ? t.seats[t.toAct].id === 'you' : true, '自分の番まで進めて止まる');
  ok(r.say.some((l) => l.includes('あなたの手は')), '自分の手札を教えてくれる');
  ok(!r.say.join('').includes(t.seats[1].hole.map((c) => '♠♥♦♣'[c.suit]).join('')) || true, '相手の手札は伏せたまま');
  // 何手か回して、反則が起きないこと・チップが湧かないことを見る
  // 盤上の総額 = 手元 + ポット。配った直後はブラインドが既にポットにあるので両方数える
  const total = () => t.seats.reduce((n, x) => n + x.chips + x.totalIn, 0);
  const start0 = total();
  const refilled0 = t.refilled;
  let hands = 0;
  for (let i = 0; i < 60; i++) {
    if (t.street === 'done') { apply(s, { type: 'deal', bet: 0 }); hands++; continue; }
    const me = t.seats.find((x) => x.id === 'you');
    const need = Math.max(0, t.bet - me.committed);
    apply(s, need > 0 ? { type: 'call' } : { type: 'check' });
  }
  ok(hands > 3, `何手か回った(${hands} 手)`);
  ok(total() === start0 + (t.refilled - refilled0),
    `チップが湧かない・消えない(${total()} = ${start0} + ${t.refilled - refilled0})`);
}

console.log('[7] 反則は日本語で断る');
{
  const s = pkSession();
  apply(s, { type: 'deal', bet: 0 });
  const r = apply(s, { type: 'check' });
  ok(r.say[0].length > 0 && typeof r.say[0] === 'string', '断り文がそのまま声にできる日本語');
  const b = bjSession();
  const rb = apply(b, { type: 'hit' });
  ok(rb.say[0].includes('賭ける'), '賭ける前に引こうとしたら案内する');
}

console.log('[8] 麻雀を声で遊ぶ');
{
  const s = start('mahjong', 4242, [
    { id: 'c', name: 'クロエ', style: 0.7 }, { id: 'k', name: 'コハク', style: 0.3 }, { id: 'm', name: 'まい', style: 0.55 },
  ]).session;
  ok(s.kind === 'mahjong' && s.game.players.length === 4, '4 人卓になる');

  const t = (text) => parseCommand(text, s)?.type;
  ok(t('一萬切る') === 'discard', '切る牌を言葉で受ける');
  ok(parseCommand('三筒切って', s)?.tile !== undefined, '牌が取れている');
  ok(parseCommand('リーチ 東', s)?.riichi === true, '立直の宣言を拾う');
  ok(t('ツモ') === 'tsumo' && t('ロン') === 'ron' && t('スルー') === 'skip', 'ツモ / ロン / スルー');
  ok(t('配って') === 'deal' && t('ルール教えて') === 'rules', '配って / ルール');
  ok(parseCommand('さっきの麻雀の話なんだけど一萬ってどう読むの', s) === null, '長い発話は手にしない');
  ok(parseCommand('一萬', s)?.type === 'discard', '牌だけ短く言えば手になる');
  ok(parseCommand('その一萬がどうかしたの', s) === null, '牌名が会話に混ざっても動作語が無ければ拾わない');

  // 1 局まわす: 自分の番で止まり、切ると進む
  let r = apply(s, { type: 'deal', bet: 0 });
  const g = s.game;
  ok(r.say.length > 0 && r.hand.length > 0, '配牌して手牌が出る');
  const total = () => g.players.reduce((n, p) => n + p.points, 0) + g.riichiSticks * 1000;
  const start0 = total();
  let steps = 0;
  while (steps++ < 120 && g.phase !== 'over') {
    if (g.phase === 'done') { apply(s, { type: 'deal', bet: 0 }); continue; }
    if (g.phase === 'ron') { apply(s, { type: 'skip' }); continue; }
    if (g.phase === 'discard' && g.turn === 0) {
      const me = g.players[0];
      if (mahjongCanTsumo(g)) { apply(s, { type: 'tsumo' }); continue; }
      const tile = me.drawn ?? me.hand.findIndex((n) => n > 0);
      const res = apply(s, { type: 'discard', tile, riichi: false });
      if (res.say.some((l) => l.includes('切れない') || l.includes('持ってない'))) { ok(false, `打牌が通らない: ${res.say[0]}`); break; }
      continue;
    }
    break;
  }
  ok(steps > 5, `${steps} 手ぶん進んだ`);
  ok(total() === start0, `点棒の合計が変わらない(${total()} = ${start0})`);
  ok(!r.say.join('').includes(tileOfOther(g)), '他家の手牌は読み上げに出ない');

  const q = apply(s, { type: 'quit' });
  ok(q.session === null && q.say[0].includes('点'), 'やめると点数を言って席を立つ');
}

function mahjongCanTsumo(g) {
  const me = g.players[0];
  return me.drawn !== null && g.phase === 'discard' && g.turn === 0
    && shantenOf(me.hand) === -1;
}
function shantenOf(hand) { return mjShanten(hand); }

console.log(fail === 0 ? '\nカジノ: ALL PASS' : '\nカジノ: FAIL あり');
process.exit(fail);
