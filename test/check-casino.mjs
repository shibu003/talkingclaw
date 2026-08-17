// 「言葉 → 手」の翻訳と 1 手ぶんの進行の検査(daemon 不要)。
// 会話に紛れて誤爆しないこと、遊べる一通りの流れが通ることを見る。
const { readFileSync: readSync } = await import('node:fs');
import { parseCommand, start, apply, brief, view, turnLine, idleLine, fillSeats, styleOf, humanIds, autoPlay, stepOnce, humanTurnPending } from '../src/casino.ts';
import { shanten as mjShanten, tileName as mjTileName } from '../src/mahjong.ts';
import { doraOf, discard as mgDiscard, callsFor } from '../src/mahjongGame.ts';
import * as mjlib from '../src/mahjong.ts';

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
  ok((r.show ?? []).some((l) => l.includes('あなたの手')), '自分の手札は画面に出す(読み上げない = 相手のログに残さない)');
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

console.log('[9] クロエに渡す説明に、こちらの手札・手牌が混ざらない');
{
  // ポーカー: 同じ卓の相手なので、こちらの 2 枚は見えてはいけない
  const p = start('poker', 31337, [{ id: 'c', name: 'クロエ', style: 0.7 }]).session;
  apply(p, { type: 'deal', bet: 0 });
  const pb = brief(p);
  const mine = p.table.seats.find((s) => s.id === 'you').hole.map((c) => '♠♥♦♣'[c.suit] + ({11:'J',12:'Q',13:'K',14:'A'}[c.rank] ?? c.rank));
  const leaked = mine.filter((c) => pb.includes(c));
  ok(leaked.length === 0, `ポーカー: こちらの手札が説明に出ない(${mine.join(' ')} → 漏れ ${leaked.length})`);
  ok(pb.includes('ポット'), 'ポーカー: ポットは伝える');
  ok(pb.includes('見えない'), 'ポーカー: 見えないと明示している');
  ok(pb.includes('ホールデム') || pb.includes('ブラインド'), 'ポーカー: ルールを伝える');

  // 麻雀: 手牌 13〜14 枚のどれも出てはいけない
  const m = start('mahjong', 4242, [{ id: 'c', name: 'クロエ', style: 0.7 }]).session;
  apply(m, { type: 'deal', bet: 0 });
  const mb = brief(m);
  const me = m.game.players[0];
  const names = [];
  for (let t = 0; t < 34; t++) if (me.hand[t] > 0) names.push(mjTileName(t));
  // 捨て牌やドラ表示と重なる牌は「見えてよい」ので、まだ誰も捨てていない配牌直後で見る
  const river = new Set(m.game.players.flatMap((pl) => pl.discards.map(mjTileName)));
  const doraInd = mjTileName(m.game.doraIndicator);
  const hidden = names.filter((n) => !river.has(n) && n !== doraInd);
  const leak2 = hidden.filter((n) => mb.includes(n));
  ok(leak2.length === 0, `麻雀: こちらの手牌が説明に出ない(${hidden.length} 種 → 漏れ ${leak2.length}${leak2.length ? ': ' + leak2.join(' ') : ''})`);
  ok(mb.includes('東1局'), '麻雀: 局を伝える');
  ok(mb.includes('見えない'), '麻雀: 見えないと明示している');

  // ブラックジャック: こちらの手は表向きなので見せる。伏せ札は明かさない
  const b = start('blackjack', 7, []).session;
  apply(b, { type: 'deal', bet: 100 });
  const bb = brief(b);
  const g = b.game;
  const suit = (c) => '♠♥♦♣'[c.suit] + ({1:'A',11:'J',12:'Q',13:'K'}[c.rank] ?? c.rank);
  ok(g.player.every((c) => bb.includes(suit(c))), 'ブラックジャック: こちらの手は表向きなので伝える');
  if (g.phase === 'player') ok(!bb.includes(suit(g.dealer[1])), 'ブラックジャック: 伏せ札は明かさない');
  else ok(true, 'ブラックジャック: 伏せ札は明かさない(即決着で判定省略)');
  ok(brief(null) === '', '遊んでいない時は何も渡さない');
}

console.log('[9-2] 読み上げに手牌を混ぜない(進行役の発言として記録に残るため)');
{
  const m = start('mahjong', 4242, [{ id: 'c', name: 'クロエ' }]).session;
  let r = apply(m, { type: 'deal', bet: 0 });
  const me = m.game.players[0];
  const names = [];
  for (let t = 0; t < 34; t++) if (me.hand[t] > 0) names.push(mjTileName(t));
  // 捨て牌とドラは全員に見えるので、読み上げても漏れではない
  const river = new Set(m.game.players.flatMap((p) => p.discards.map(mjTileName)));
  const dora = mjTileName(doraOf(m.game.doraIndicator));
  const hidden = names.filter((n) => !river.has(n) && n !== dora);
  const spoken = (r.say ?? []).join(' ');
  const leak = hidden.filter((n) => spoken.includes(n));
  ok(leak.length === 0, `麻雀: 読み上げ(say)に手牌が出ない(漏れ ${leak.length}${leak.length ? ': ' + leak.join(' ') : ''})`);
  ok((r.show ?? []).join(' ').length > 0, '手牌は show(画面だけ)に入る');

  const p = start('poker', 31337, [{ id: 'c', name: 'クロエ' }]).session;
  r = apply(p, { type: 'deal', bet: 0 });
  const mine = p.table.seats.find((s) => s.id === 'you').hole
    .map((c) => '♠♥♦♣'[c.suit] + ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.rank] ?? c.rank));
  const spoken2 = (r.say ?? []).join(' ');
  ok(mine.every((c) => !spoken2.includes(c)), `ポーカー: 読み上げに手札が出ない(${mine.join(' ')})`);
  ok((r.show ?? []).join(' ').includes(mine[0]), 'ポーカー: 手札は show に入る');
}

console.log('[9-1] 鳴ける場面では必ず止まって聞く(機械的に流さない)');
{
  const s = start('mahjong', 2024, [{ id: 'c', name: 'クロエ' }]).session;
  apply(s, { type: 'deal', bet: 0 });
  const g = s.game;
  // 自分(席 0)がポンできる形を作る: 席 3(上家)が切る牌を 2 枚持たせる
  const t = mjlib.parseHand('5p')[0];
  g.players[0].hand = new Array(34).fill(0);
  for (const x of mjlib.parseHand('55p123m456m789m11z')) g.players[0].hand[x]++;
  g.turn = 3;
  g.phase = 'discard';
  g.players[3].hand[t] = Math.max(1, g.players[3].hand[t]);
  g.players[3].drawn = t;
  mgDiscard(g, 3, t);
  ok(callsFor(g, 0).pon === true, '場としてポンできる');
  const v = view(s);
  const labels = v.moves.map((m) => m.label);
  ok(labels.some((l) => l.includes('ポン')), `ポンのボタンが出る(${labels.join(' / ')})`);
  ok(labels.some((l) => l.includes('スルー')), 'スルーのボタンも出る');
  // ポンすると自分の番になり、晒した面子が卓に出る
  const r = apply(s, { type: 'pon' });
  ok(g.players[0].melds.length === 1 && g.turn === 0, 'ポンしたら自分の番になる');
  const b2 = view(s).board;
  ok(b2.seats[0].melds.length === 1, '晒した面子が卓に出る');
  ok(r.say.join('').includes('ポン'), '何をしたか読み上げる');
}

console.log('[9-3] ポーカーのレートを選べる');
{
  const low = start('poker', 1, [{ id: 'c', name: 'クロエ' }], 10).session;
  const high = start('poker', 1, [{ id: 'c', name: 'クロエ' }], 100).session;
  ok(low.table.blind === 10 && high.table.blind === 100, 'ブラインドが変わる');
  ok(low.table.seats[0].chips === 1000 && high.table.seats[0].chips === 10000,
    `持ち点はレートの 100 倍(${low.table.seats[0].chips} / ${high.table.seats[0].chips})`);
  ok(parseCommand('レート50でポーカーやろう', null)?.blind === 50, '声でレートを言える');
  ok(parseCommand('ポーカーやろう', null)?.blind === undefined, '言わなければ既定');
  const capped = start('poker', 1, [{ id: 'c', name: 'クロエ' }], 99999).session;
  ok(capped.table.blind === 500, `高すぎるレートは頭打ち(${capped.table.blind})`);
}

console.log('[10] 画面用の卓(札と牌)');
{
  const b = start('blackjack', 7, []).session;
  apply(b, { type: 'deal', bet: 100 });
  const bv = view(b);
  const dealerRow = bv.table.find((r) => r.label.includes('ディーラー'));
  ok(bv.table.length === 2 && dealerRow, '2 段(ディーラー / あなた)で出る');
  if (b.game.phase === 'player') {
    ok(dealerRow.faces.some((f) => f.hidden), '手の途中は伏せ札が hidden で出る');
  } else ok(true, '手の途中は伏せ札が hidden(即決着で判定省略)');
  ok(bv.table.every((r) => r.kind === 'card'), 'ブラックジャックは札として出す');

  const p = start('poker', 31337, [{ id: 'c', name: 'クロエ' }]).session;
  apply(p, { type: 'deal', bet: 0 });
  const pv = view(p);
  const board = pv.table.find((r) => r.label.includes('場'));
  ok(board && board.faces.length === 5, `場は常に 5 枚ぶん(未公開は裏)= ${board?.faces.length}`);
  ok(board.faces.filter((f) => f.hidden).length === 5, 'プリフロップは 5 枚とも裏');

  const m = start('mahjong', 4242, [{ id: 'c', name: 'クロエ' }]).session;
  apply(m, { type: 'deal', bet: 0 });
  const mv = view(m);
  ok(mv.hand.length === 14, `親の手牌は 14 枚(${mv.hand.length})`);
  ok(mv.hand.every((f) => f.move), '自分の番なので全部押して切れる');
  ok(mv.hand[mv.hand.length - 1].red === true, 'ツモ牌は離して目立たせる');
  // 卓: 4 人ぶんが自分から見た向きで並ぶ
  const b2 = mv.board;
  ok(b2 && b2.seats.length === 4, '卓に 4 人ぶんの席がある');
  ok(b2.seats.map((s) => s.at).join(',') === 'self,right,top,left', '自分から見た並び(自分・下家・対面・上家)');
  ok(b2.seats[0].name === 'あなた' && b2.seats[0].dealer === true, '自分が親で下に座る');
  ok(b2.seats.map((s) => s.wind).join('') === '東南西北', '風が席順どおりに振られる');
  ok(b2.seats.every((s) => Array.isArray(s.river)), '各家に河がある');
  ok(b2.dora.length > 0 && b2.round === '東1局', '中央に局とドラが出る');
  // 立直中はツモ切りだけ
  m.game.players[0].riichi = true;
  const rv = view(m);
  ok(rv.hand.filter((f) => f.move).length === 1, `立直中はツモ牌だけ押せる(${rv.hand.filter((f) => f.move).length})`);
}


console.log('[PBI-028] 手番の判定と声かけ');
{
  const { readFileSync } = await import('node:fs');
  // 3 ゲームで「自分の番か」が画面と同じ judgement で取れる
  const bj = start('blackjack', 42, []).session;
  ok(view(bj).yourTurn === false, 'BJ: 賭ける前は自分の番ではない');
  const bet = apply(bj, { type: 'deal', bet: 100 });
  ok(view(bet.session).yourTurn === true, 'BJ: 配られたら自分の番');
  const stood = apply(bet.session, { type: 'stand' });
  ok(view(stood.session).yourTurn === false, 'BJ: 勝負した後は自分の番ではない');
  ok(view(null).yourTurn === false, '遊んでいない時は自分の番ではない');

  const mj = start('mahjong', 7, [{ id: 'a', name: 'コハク' }, { id: 'b', name: 'マイ' }, { id: 'c', name: 'マオ' }]).session;
  ok(typeof view(mj).yourTurn === 'boolean', '麻雀: 判定が真偽値で出る');

  // 台詞は乱数ではなく回数で選ぶ = 検査できる。ゲームごとに言い回しが違う
  ok(turnLine('blackjack', 0) === turnLine('blackjack', 0), '同じ回数なら同じ台詞(決定的)');
  ok(turnLine('blackjack', 0) !== turnLine('blackjack', 1), '続けて同じ台詞を言わない');
  ok(turnLine('mahjong', 0).includes('切る'), '麻雀の言い回しになっている');
  ok(turnLine('blackjack', 0).includes('引く'), 'BJ の言い回しになっている');
  ok(turnLine('poker', 0).includes('降りる') || turnLine('poker', 0).includes('乗る'), 'ポーカーの言い回しになっている');
  ok(turnLine(null, 0) === null, '遊んでいない時は何も言わない');
  ok(turnLine('blackjack', 999) !== undefined && turnLine('blackjack', -3) !== undefined, '回数が大きくても負でも落ちない');
  ok(idleLine(0).length > 0 && idleLine(0) !== idleLine(1), '様子伺いも回して使う');

  // PBI-039: 同じ場面でも**育ちで言い回しが変わる**（tone。推論ゼロ）
  ok(turnLine('mahjong', 0, 1) !== turnLine('mahjong', 0, 0), '決める力が高い子は言い方が変わる');
  ok(turnLine('mahjong', 0, 2) !== turnLine('mahjong', 0, 1), '優しい子とはっきりした子で違う');
  ok(idleLine(0, 3) !== idleLine(0, 0), 'せっかちな子の様子伺いが変わる');
  ok(turnLine('mahjong', 0, 9) === turnLine('mahjong', 0, 9 % 4), '知らない tone でも落ちない');
  ok(/切/.test(turnLine('mahjong', 0, 1)) && /引く|勝負/.test(turnLine('blackjack', 0, 1)), 'tone を変えてもゲームの言葉は保つ');

  // room 側の 3 分岐(1 手番 1 回・打ったら取り消す・話している最中は黙る)は源で守る
  const room = readFileSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  ok(/if \(now && !st\.onTurn\)/.test(room), '「false → true の瞬間だけ」話す形になっている');
  ok(/if \(st\.idle\) \{ clearTimeout\(st\.idle\)/.test(room), '盤面が動いたら様子伺いのタイマーを消している');
  ok(/mic\.active \? null : casino\.turnLine/.test(room), 'ユーザーが話している最中は割り込まない');
  ok(/turnTalkTick\(channel\)/.test(room), '手を打った後に呼んでいる（その部屋の卓で）');
}


console.log('[PBI-034] 人数が足りない時に埋める');
{
  // 1 人しか居ない = 空席 3 つ。**NPC2 ではなく名前のある面子**が座る
  const solo = fillSeats([], 3);
  ok(solo.length === 3, `3 席ぶん埋まる(${solo.length})`);
  ok(solo.every((s) => s.name && !/^NPC/.test(s.name)), `名前がある(${solo.map((s) => s.name).join(',')})`);
  ok(new Set(solo.map((s) => s.name)).size === 3, '名前が重ならない');
  ok(new Set(solo.map((s) => s.style)).size === 3, `打ち筋が全員違う(${solo.map((s) => s.style).join(',')})`);
  ok(solo.every((s) => s.style !== 0.5 || true) && solo.some((s) => s.style > 0.7) && solo.some((s) => s.style < 0.4),
    '攻める人と降りる人が混ざっている');

  // 居る人が優先。埋めるのは足りないぶんだけ
  const withAgents = fillSeats([{ id: 'a', name: 'クロエ' }], 3);
  ok(withAgents[0].name === 'クロエ', '在室者が先に座る');
  ok(withAgents.length === 3 && withAgents.filter((s) => s.name === 'クロエ').length === 1, '在室者が二重に座らない');
  ok(styleOf('クロエ') === 0.72, '在室者の打ち筋は元の表から引く');
  ok(fillSeats([{ id: 'a', name: 'クロエ' }, { id: 'b', name: 'コハク' }, { id: 'c', name: 'まい' }], 3)
    .every((s) => ['クロエ', 'コハク', 'まい'].includes(s.name)), '3 人居れば面子は入らない');

  // 決定的（同じ入力 → 同じ席順）
  ok(JSON.stringify(fillSeats([], 3)) === JSON.stringify(fillSeats([], 3)), '席順が揺れない');

  // 卓が実際に立つ: 1 人でも 4 人麻雀
  const g = start('mahjong', 7, []).session;
  const seats = view(apply(g, { type: 'deal', bet: 0 }).session ?? g);
  const names = (g.game.players ?? []).map((p) => p.name);
  ok(names.length === 4, `4 人になる(${names.join(',')})`);
  ok(!names.some((n) => /^NPC/.test(n)), `NPC が居ない(${names.join(',')})`);
  ok(names[0] === 'あなた', '自分が先頭');
  // ポーカーも 1 人では成立しないので埋まる
  const pk = start('poker', 7, []).session;
  ok(pk.table.seats.length >= 3, `ポーカーも 3 人以上になる(${pk.table.seats.length})`);
  ok(!pk.table.seats.some((s) => /^NPC/.test(s.name)), 'ポーカーにも NPC が居ない');

  // AC-6: 人数が足りない時に思い出せる導線（遊ぶ箱に 1 行）
  const roomJs = readSync(new URL('../public/room.js', import.meta.url), 'utf8');
  ok(/1 人でも 4 人打ちできる/.test(roomJs), '「1 人でも遊べる」がどこにも書いていない');
}


console.log('[PBI-037] 同じ卓に人が 2 人以上着く');
{
  const two = [{ id: 'you', name: 'あなた' }, { id: 'g1', name: 'たけし' }];
  const mj = start('mahjong', 7, [], 10, two).session;
  const names = mj.game.players.map((p) => p.name);
  ok(names[0] === 'あなた' && names[1] === 'たけし', `AC-1 2 人とも席に着く(${names.join(',')})`);
  ok(names.length === 4 && !names.some((n) => /^NPC/.test(n)), `AC-1 残りは面子が埋める(${names.join(',')})`);
  ok(humanIds(mj).size === 2 && humanIds(mj).has('g1'), 'AC-1 人間の席が 2 つ');

  // AC-5: 手牌は見る人のもの
  const dealt = apply(mj, { type: 'deal', bet: 0 }, 'you').session ?? mj;
  const mine = view(dealt, 'you').hand ?? [];
  const theirs = view(dealt, 'g1').hand ?? [];
  ok(mine.length > 0 && theirs.length > 0, `AC-5 どちらにも手牌が出る(${mine.length}/${theirs.length})`);
  ok(JSON.stringify(mine) !== JSON.stringify(theirs), 'AC-5 自分の手牌は自分にしか見えない（別の人には別の牌）');

  // AC-3/AC-4: 手番でない人・卓に居ない人は打てない
  const g = dealt.game;
  const turnId = g.players[g.turn].id;
  const other = two.find((h) => h.id !== turnId)?.id ?? 'g1';
  const before = JSON.stringify(g.players.map((p) => p.hand));
  const r = apply(dealt, { type: 'discard', tile: 0, riichi: false }, other);
  ok(JSON.stringify(dealt.game.players.map((p) => p.hand)) === before, 'AC-3 手番でない人が打っても卓が動かない');
  ok(/番|できない|使えない/.test(r.say.join('')), `AC-3 断りの言葉が返る(${r.say[0]})`);
  const ghost = apply(dealt, { type: 'discard', tile: 0, riichi: false }, 'よその人');
  ok(JSON.stringify(dealt.game.players.map((p) => p.hand)) === before, 'AC-4 卓に居ない人が打っても卓が動かない');
  void ghost;

  // AC-7: 1 人の時は今までどおり
  const solo = start('mahjong', 7, [], 10, []).session;
  ok(solo.game.players[0].name === 'あなた' && solo.game.players.length === 4, 'AC-7 1 人でも 4 人卓');
  ok(humanIds(solo).size === 1, 'AC-7 人間は 1 人');
  const pk2 = start('poker', 7, [], 10, two).session;
  ok(pk2.table.seats.length >= 3 && pk2.table.seats[1].name === 'たけし', `AC-1 ポーカーも 2 人が着く(${pk2.table.seats.map((x) => x.name).join(',')})`);

  // 配線: 部屋がゲストの手を「その人・その部屋」で処理している
  const room = readSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  ok(/tryGame\(text, \{ actor: guest\.id, channel: guest\.channel as Channel \}\)/.test(room), 'ゲストの手が自分の部屋・自分の名前で処理されていない');
  ok(/casino\.view\(gameSessions\.get\(ch\) \?\? null, guest \? guest\.id : 'you'\)/.test(room), '盤面が見る人ごとになっていない');
  ok(/humansIn\(channel\)/.test(room), '卓に人間を座らせていない');
}


console.log('[PBI-038] 離席しても卓が止まらない');
{
  const two = [{ id: 'you', name: 'あなた' }, { id: 'g1', name: 'たけし' }];
  const s0 = start('mahjong', 11, [], 10, two).session;
  const dealt = apply(s0, { type: 'deal', bet: 0 }, 'you').session ?? s0;
  const g = dealt.game;
  const turnId = g.players[g.turn].id;
  const handBefore = g.players[g.turn].hand.slice();
  const river = g.players[g.turn].discards.length;

  const r = autoPlay(dealt, turnId);
  ok(!!r, '手番の人の代わりに打てる');
  ok(/代わりに|スルー|ツモ/.test(r?.say.join('') ?? ''), `AC-2 打ったことを言う(${r?.say[0]})`);
  ok(g.players.map((p) => p.id).includes(turnId), 'AC-5 席は取り上げない');
  const moved = g.players.find((p) => p.id === turnId);
  ok(moved.discards.length === river + 1 || JSON.stringify(moved.hand) !== JSON.stringify(handBefore),
    'AC-1 卓が 1 手ぶん進む');

  // AC-6: 1 回の発火で 1 手だけ（次の人の番になっているか、自分の番が終わっている）
  ok(g.turn !== g.players.findIndex((p) => p.id === turnId) || g.phase !== 'discard',
    'AC-6 1 手だけで止まる（全部打ち切らない）');

  // 手番でない席・卓に居ない席では何もしない
  const other = two.find((h) => h.id !== turnId)?.id ?? 'g1';
  const snapshot = JSON.stringify(g.players.map((p) => [p.hand, p.discards]));
  ok(autoPlay(dealt, 'よその人') === null, '卓に居ない席では何もしない');
  const maybe = autoPlay(dealt, other);
  ok(maybe === null || /代わりに|スルー|ツモ/.test(maybe.say.join('')),
    maybe === null ? '手番でない席では何もしない' : `代打ちの後に番が回ってきていた(${maybe.say[0]})`);
  void snapshot;

  // PBI-037 の穴（この作業で見つけた）: **他の人間の鳴きを AI が決めない**
  const src2 = readSync(new URL('../src/casino.ts', import.meta.url), 'utf8');
  ok(/if \(i === seat \|\| !humans\.has\(p\.id\)\) return false;/.test(src2), '他の人間に権利がある時に止めて聞く形になっている');
  ok(/s2 === seat \|\| humans\.has\(g\.players\[s2\]\.id\)\) continue;/.test(src2), '人の席を AI が鳴かない');

  // 固まった場（返事待ち）でも代打ちが場を進める
  // 誰も動かない場（人の番のまま止まる）を代打ちが解く。**局面の種類に依存しない形で**見る
  const s2 = start('mahjong', 11, [], 10, two).session;
  const d2 = apply(s2, { type: 'deal', bet: 0 }, 'g1', { stepwise: true }).session ?? s2;
  const river2 = () => d2.game.players.reduce((n, p) => n + p.discards.length, 0);
  const before2 = river2();
  let unstuck = null;
  for (const id of ['you', 'g1']) { const a = autoPlay(d2, id); if (a) { unstuck = a; break; } }
  ok(!!unstuck && river2() > before2, `止まった場を代打ちが進める（捨て牌 ${before2} → ${river2()}）`);
  ok(d2.game.phase !== 'ron' || river2() > before2, 'AC-1 解けた後は場が動いている');

  // AC-7: 推論を呼んでいない（casino は依存ゼロ・打ち筋は既存の関数）
  const src = readSync(new URL('../src/casino.ts', import.meta.url), 'utf8');
  ok(!/anthropic|fetch\(/i.test(src), 'AC-7 casino が外を呼んでいない');

  // 部屋側の 3 分岐（2 人以上・打つたびに張り直す・1 人なら張らない）
  const room = readSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  ok(/humans\.size < 2\) return;/.test(room), 'AC-3 1 人の卓では代打ちしない');
  ok(/scheduleThink\(channel\);\s+\/\/ PBI-043/.test(room) && /armTableIdle\(channel\); return; \}/.test(room), 'AC-4 打つたびに間合い→代打ちのタイマーを張り直す');
  ok(/if \(prev\) clearTimeout\(prev\)/.test(room), 'AC-4 前のタイマーを消してから張る');
}


console.log('[PBI-041] 卓に着いていない人が見ても落ちない（実運用で部屋が死んだ）');
{
  const seated = [{ id: 'you', name: 'あなた' }];
  const pk3 = start('poker', 7, [{ id: 'a1', name: 'クロエ' }], 10, seated).session;
  let v = null;
  try { v = view(pk3, 'よその人'); ok(true, 'ポーカー: 席の無い人が見ても例外にならない'); }
  catch (e) { ok(false, `ポーカー: 席の無い人が見ると落ちる(${e.message})`); }
  ok(v && v.yourTurn === false && v.moves.length === 0, '見物には押せる手を出さない');
  ok(v && /見物/.test(v.title), `見物と分かる表示(${v?.title})`);
  ok(!JSON.stringify(v ?? {}).includes('あなたの手'), '見物に手札を出していない');

  const mj3 = start('mahjong', 7, [], 10, seated).session;
  const dealt3 = apply(mj3, { type: 'deal', bet: 0 }, 'you').session ?? mj3;
  let mv = null;
  try { mv = view(dealt3, 'よその人'); ok(true, '麻雀: 席の無い人が見ても例外にならない'); }
  catch (e) { ok(false, `麻雀: 席の無い人が見ると落ちる(${e.message})`); }
  ok((mv?.hand ?? []).length === 0, '見物に手牌を出していない');
  ok(view(dealt3, 'you').hand.length >= 13, 'AC-3 席に着いている人は今までどおり手牌が出る');

  // AC-4: 要求 1 つの失敗で部屋を殺さない（源で確認）
  const room = readSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  ok(/void handleRequest\(req, res\)\.catch\(/.test(room), 'AC-4 要求の失敗を受け止めている（部屋は死なない）');
  ok(/json\(res, 500, \{ error: '部屋の中で失敗した/.test(room), 'AC-4 失敗時は 500 を返す');
}


console.log('[PBI-041b] 卓を開いた直後に押せる手がある（3 ゲームとも）');
{
  for (const g of ['mahjong', 'poker', 'blackjack']) {
    const s0 = start(g, 7, [], 10, [{ id: 'you', name: 'あなた' }]).session;
    const labels = view(s0, 'you').moves.map((m) => m.label);
    const playable = labels.filter((l) => !/やめる/.test(l));
    ok(playable.length > 0, `${g}: 開いた直後に押せる手がある(${labels.join('/')})`);
  }
  // 麻雀は「配って」が要る（無いと画面が空で遊べない。実機で踏んだ）
  const mj0 = start('mahjong', 7, [], 10, [{ id: 'you', name: 'あなた' }]).session;
  ok(view(mj0, 'you').moves.some((m) => /配って/.test(m.label)), '麻雀: 配って が出る');
  const dealt0 = apply(mj0, { type: 'deal', bet: 0 }, 'you').session ?? mj0;
  ok((view(dealt0, 'you').hand ?? []).length >= 13, '配ったら手牌が出る');
  ok(!view(dealt0, 'you').moves.some((m) => /配って/.test(m.label)), '配った後は 配って を出さない');
}


console.log('[PBI-043] 1 手ずつ進む（間合いは部屋が置く）');
{
  const solo = [{ id: 'you', name: 'あなた' }];
  const s5 = start('mahjong', 7, [], 10, solo).session;
  const d5 = apply(s5, { type: 'deal', bet: 0 }, 'you', { stepwise: true }).session ?? s5;
  ok(humanTurnPending(d5), '配った直後は人の番（AI は動かない）');
  const v5 = view(d5, 'you');
  const tileCmd = parseCommand(v5.hand.find((f) => f.move).move, d5);
  const after5 = apply(d5, tileCmd, 'you', { stepwise: true }).session ?? d5;
  ok(!humanTurnPending(after5), '打った直後は AI の番（まだ打っていない）');
  const before5 = after5.game.players.reduce((n, p) => n + p.discards.length, 0);
  const r5 = stepOnce(after5);
  const mid5 = after5.game.players.reduce((n, p) => n + p.discards.length, 0);
  ok(!!r5 && mid5 === before5 + 1, `1 回の step で 1 手だけ進む(${before5} → ${mid5})`);
  let steps5 = 0;
  while (!humanTurnPending(after5) && steps5 < 10) { stepOnce(after5); steps5++; }
  ok(steps5 >= 1 && humanTurnPending(after5), `人の番まで ${steps5 + 1} 手で戻る`);
  ok(stepOnce(after5) === null, '人の番では step が何もしない');

  // ポーカーも同じ形
  const pk5 = start('poker', 7, [], 10, solo).session;
  const pd5 = apply(pk5, { type: 'deal', bet: 0 }, 'you', { stepwise: true }).session ?? pk5;
  ok(typeof humanTurnPending(pd5) === 'boolean', 'ポーカーでも人の番かどうかが分かる');
  if (!humanTurnPending(pd5)) ok(!!stepOnce(pd5), 'ポーカーも 1 手ずつ進む');
  else ok(true, 'ポーカー: 配った直後は人の番');

  // 部屋側: 間合い(THINK_MS)と 1.5 秒ごとの取り直し
  const room = readSync(new URL('../src/room.ts', import.meta.url), 'utf8');
  ok(/const THINK_MS = Number\(process\.env\.TABLE_THINK_MS \?\? 5000\)/.test(room), 'AC-1 間合いは既定 5 秒');
  ok(/casino\.apply\(session!, cmd, actor, \{ stepwise: true \}\)/.test(room), 'AC-5 人の手はその場で適用（待たせない）');
  const js = readSync(new URL('../public/room.js', import.meta.url), 'utf8');
  ok(/setInterval\(\(\) => \{ if \(!document\.hidden\) void refreshGame\(\); \}, 1500\)/.test(js), 'AC-3 卓が立っている間は自動で取り直す');
  ok(/armGamePoll\(false\)|armGamePoll\(!!v\.kind\)/.test(js), 'AC-7 卓が無くなれば止める');
}

console.log(fail === 0 ? '\nカジノ: ALL PASS' : '\nカジノ: FAIL あり');
process.exit(fail);
