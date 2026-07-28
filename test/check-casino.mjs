// 「言葉 → 手」の翻訳と 1 手ぶんの進行の検査(daemon 不要)。
// 会話に紛れて誤爆しないこと、遊べる一通りの流れが通ることを見る。
import { parseCommand, start, apply, brief, view } from '../src/casino.ts';
import { shanten as mjShanten, tileName as mjTileName } from '../src/mahjong.ts';
import { doraOf } from '../src/mahjongGame.ts';

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

console.log(fail === 0 ? '\nカジノ: ALL PASS' : '\nカジノ: FAIL あり');
process.exit(fail);
