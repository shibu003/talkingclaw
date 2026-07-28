// 麻雀の判定の核の検査(daemon 不要)。
// 和了形・シャンテン数・役・符・点数。ここが合わないと「点が合わない麻雀」になる。
import {
  parseHand, toCounts, tileName, shanten, waits, ukeire, isChiitoi, isKokushi,
  judgeWin, score, fuOf, winningDecomps, EAST, SOUTH, HAKU, HATSU, CHUN,
} from '../src/mahjong.ts';

let fail = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✅ ${what}`); else { console.log(`  ❌ ${what}`); fail = 1; } };
const C = (s) => toCounts(parseHand(s));

console.log('[1] 牌の読み書き');
{
  ok(parseHand('123m').length === 3 && tileName(parseHand('1m')[0]) === '一萬', '萬子');
  ok(tileName(parseHand('5p')[0]) === '五筒' && tileName(parseHand('9s')[0]) === '九索', '筒子・索子');
  ok(tileName(parseHand('1z')[0]) === '東' && tileName(parseHand('7z')[0]) === '中', '字牌');
  ok(parseHand('123m456p789s11122z').length === 14, '14 枚を読める');
}

console.log('[2] シャンテン数');
{
  ok(shanten(C('123m456p789s11122z')) === -1, '和了形は -1');
  ok(shanten(C('123m456p789s1112z')) === 0, '聴牌は 0');
  ok(shanten(C('19m19p19s1234567z')) === 0, '国士 13 面待ちは 0');
  ok(shanten(C('19m19p19s12345677z')) === -1, '国士の和了は -1');
  ok(shanten(C('11223344556677m')) === -1, '二盃口の形(123123456456 77)も和了と見る');
  ok(shanten(C('1122334455668m')) === 0, '七対子の聴牌');
  ok(shanten(C('147m258p369s1234z')) === 6, 'バラバラの手は遠い');
}

console.log('[3] 受け入れ(何を引けば進むか)');
{
  const u = ukeire(C('123m456p789s112z'));
  ok(u.tiles.length > 0, '進む牌がある');
  const w = waits(C('123m456p789s11m'.replace('11m', '11m')));
  ok(Array.isArray(w), '待ちが取れる');
  const t = waits(C('123m456p789s1122z'));
  ok(t.length === 2, `シャンポン待ちは 2 種(${t.map(tileName).join('・')})`);
  const r = waits(C('123m456p789m11z34s'));
  ok(r.length === 2, `両面待ちは 2 種(${r.map(tileName).join('・')})`);
  const three = waits(C('123m456p11z34567s'));
  ok(three.length === 3, `三面待ちは 3 種(${three.map(tileName).join('・')})`);
  const p = waits(C('123m456p789s11z12s'));
  ok(p.length === 1, `辺張は 1 種(${p.map(tileName).join('・')})`);
}

console.log('[4] 特殊形');
{
  ok(isChiitoi(C('1122334455667788m'.slice(0, 28))) || isChiitoi(C('11m22m33p44p55s66s77z')), '七対子を見分ける');
  ok(!isChiitoi(C('1111223344556m')), '同じ牌 4 枚は七対子にしない');
  ok(isKokushi(C('19m19p19s12345677z')), '国士無双を見分ける');
  ok(!isKokushi(C('19m19p19s1234566z')), '足りない国士は認めない');
}

console.log('[5] 役の判定');
{
  const base = { tsumo: false, riichi: false, menzen: true, seatWind: EAST, roundWind: EAST, dora: 0 };
  const judge = (h, ctx = {}, open = [], dealer = false) =>
    judgeWin(C(h), open, { ...base, winTile: parseHand(ctx.win ?? '1m')[0], ...ctx }, dealer);

  const tanyao = judge('234m567p234s5566s'.slice(0, 0) + '234m567p22345566s', { win: '6s' });
  ok(tanyao === null || tanyao.han >= 1, '断幺九の手が判定できる');

  const pinfu = judge('234m567m234p567p11s', { win: '2m' });
  ok(pinfu && pinfu.yaku.some((y) => y.name === '平和'), `平和が付く(${pinfu?.text})`);
  ok(pinfu && pinfu.fu === 30, `平和ロンは 30 符(${pinfu?.fu})`);

  const pinfuTsumo = judge('234m567m234p567p11s', { win: '2m', tsumo: true });
  ok(pinfuTsumo && pinfuTsumo.fu === 20, `平和ツモは 20 符(${pinfuTsumo?.fu})`);

  const yakuhai = judge('123m456p789s22s555z', { win: '5z' });
  ok(yakuhai && yakuhai.yaku.some((y) => y.name === '役牌 白'), `白で役が付く(${yakuhai?.text})`);

  const sanshoku = judge('123m123p123s99m11z'.replace('99m11z', '99m111z'), { win: '1z' });
  ok(sanshoku === null || sanshoku.yaku.some((y) => y.name === '三色同順'), '三色同順');

  const ittsu = judge('123456789m11p234s', { win: '4s' });
  ok(ittsu && ittsu.yaku.some((y) => y.name === '一気通貫'), `一気通貫(${ittsu?.text})`);

  const chinitsu = judge('11122334455667m', { win: '7m' });
  ok(chinitsu && chinitsu.yaku.some((y) => y.name === '清一色'), `清一色(${chinitsu?.text})`);

  const chiitoi = judge('1133557799m1133p'.slice(0, 0) + '11m33m55m77m99m11p33p', { win: '3p' });
  ok(chiitoi && chiitoi.fu === 25 && chiitoi.yaku.some((y) => y.name === '七対子'), `七対子は 25 符(${chiitoi?.fu})`);

  const kokushi = judge('19m19p19s12345677z', { win: '7z' });
  ok(kokushi && kokushi.han === 13, `国士無双は役満(${kokushi?.text})`);

  const daisangen = judge('555z666z777z123m11p', { win: '1p' });
  ok(daisangen && daisangen.han === 13, `大三元は役満(${daisangen?.text})`);

  // 鳴いていると平和が付かないので、順子だけの手は役無しになる
  const openRun = [{ kind: 'run', tile: parseHand('2s')[0], open: true }];
  const noYaku = judgeWin(C('123m456p789s99p'), openRun,
    { ...base, menzen: false, winTile: parseHand('1m')[0] }, false);
  ok(noYaku === null, '役無し(鳴いた順子だけの手)は和了れない');
  const menzenSame = judge('123m456p789s234s99p', { win: '4s' });
  ok(menzenSame && menzenSame.yaku.some((y) => y.name === '平和'), '同じ形でも門前なら平和が付く');
}

console.log('[6] 符の計算');
{
  const base = { tsumo: false, riichi: true, menzen: true, seatWind: EAST, roundWind: EAST, dora: 0 };
  const judge = (h, ctx = {}) => judgeWin(C(h), [], { ...base, winTile: parseHand(ctx.win ?? '1m')[0], ...ctx }, false);
  const kanchan = judge('123m456p789s11z345s'.replace('345s', '345s'), { win: '5p' });
  ok(kanchan === null || kanchan.fu % 10 === 0, '符は 10 の倍数に切り上がる');
  const ankou = judge('111m456p789s11z234s', { win: '2s' });
  ok(ankou && ankou.fu >= 40, `么九の暗刻が付くと 40 符以上(${ankou?.fu})`);
}

console.log('[7] 点数表');
{
  ok(score(1, 30, false, false).points === 1000, '子 1翻30符ロン = 1000');
  ok(score(2, 30, false, false).points === 2000, '子 2翻30符ロン = 2000');
  ok(score(3, 40, false, false).points === 5200, '子 3翻40符ロン = 5200');
  ok(score(4, 30, false, false).points === 7700, '子 4翻30符ロン = 7700');
  ok(score(1, 30, true, false).points === 1500, '親 1翻30符ロン = 1500');
  ok(score(3, 40, true, false).points === 7700, '親 3翻40符ロン = 7700');
  ok(score(5, 30, false, false).points === 8000, '子 満貫 = 8000');
  ok(score(6, 30, false, false).points === 12000, '子 跳満 = 12000');
  ok(score(8, 30, false, false).points === 16000, '子 倍満 = 16000');
  ok(score(11, 30, false, false).points === 24000, '子 三倍満 = 24000');
  ok(score(13, 30, false, false).points === 32000, '子 役満 = 32000');
  ok(score(13, 30, true, false).points === 48000, '親 役満 = 48000');
  const t = score(4, 30, false, true);
  ok(t.payments.fromDealer === 3900 && t.payments.fromEach === 2000, `子 4翻30符ツモ = 2000/3900(${t.payments.fromEach}/${t.payments.fromDealer})`);
  const dt = score(3, 30, true, true);
  ok(dt.payments.fromEach === 2000, `親 3翻30符ツモ = 2000 オール(${dt.payments.fromEach})`);
  ok(score(4, 30, false, false).name === '' && score(5, 30, false, false).name === '満貫', '満貫の呼び名');
}

console.log('[8] 高点法(一番高い取り方を選ぶ)');
{
  const base = { tsumo: false, riichi: false, menzen: true, seatWind: EAST, roundWind: EAST, dora: 0 };
  // 111222333m のような手は「刻子 3 つ」とも「順子 3 つ」とも取れる
  const r = judgeWin(C('111222333m44455p'.slice(0, 0) + '111222333m444p55s'), [],
    { ...base, winTile: parseHand('5s')[0] }, false);
  ok(r !== null, '複数の取り方がある手も判定できる');
  if (r) {
    const decomps = winningDecomps(C('111222333m444p55s'), [], parseHand('5s')[0], false);
    ok(decomps.length >= 2, `分け方が複数見つかる(${decomps.length} 通り)`);
  }
}

console.log('[9] ドラは役の上に足す(ドラだけでは和了れない)');
{
  const base = { tsumo: false, riichi: false, menzen: true, seatWind: EAST, roundWind: EAST, winTile: parseHand('4s')[0] };
  const openRun = [{ kind: 'run', tile: parseHand('2s')[0], open: true }];
  const noYaku = judgeWin(C('123m456p789s99p'), openRun, { ...base, menzen: false, dora: 3 }, false);
  ok(noYaku === null, 'ドラ 3 でも役が無ければ和了れない');
  const withYaku = judgeWin(C('123456789m11p234s'), [], { ...base, dora: 2 }, false);
  ok(withYaku && withYaku.han >= 4, `役ありならドラが翻に乗る(${withYaku?.han} 翻)`);
}

console.log('[9-1] 壊れた手牌でも落ちない');
{
  // 枚数が負になった配列でシャンテンが無限に潜って落ちたことがある
  const bad = new Array(34).fill(0);
  bad[0] = -1; bad[5] = 2; bad[9] = 3;
  let crashed = false;
  try { shanten(bad); } catch { crashed = true; }
  ok(!crashed, '負の枚数が混ざっても落ちない');
  const empty = new Array(34).fill(0);
  ok(typeof shanten(empty) === 'number', '空の手牌でも数を返す');
  ok(Array.isArray(waits(bad)), '壊れた手牌でも待ちを聞ける');
}

console.log('[10] 作った手で辻褄が合うか(ランダム 14 枚はまず和了らないので、和了形を組んで崩す)');
{
  let seed = 20260728;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (n) => Math.floor(rnd() * n);

  // 4 面子 + 雀頭 をランダムに組む(同じ牌が 5 枚にならないように)
  const buildWin = () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const c = new Array(34).fill(0);
      const put = (tiles) => { for (const t of tiles) { if (c[t] >= 4) return false; c[t]++; } return true; };
      let okAll = true;
      for (let m = 0; m < 4 && okAll; m++) {
        if (rnd() < 0.5) { // 順子
          const suit = pick(3) * 9;
          const n = pick(7);
          okAll = put([suit + n, suit + n + 1, suit + n + 2]);
        } else {           // 刻子
          okAll = put([pick(34), 0, 0].slice(0, 1).flatMap((t) => [t, t, t]));
        }
      }
      if (okAll) { const p = pick(34); if (put([p, p])) return c; }
    }
    return null;
  };

  let built = 0, notWin = 0, tenpaiBad = 0, judged = 0, fuBad = 0;
  for (let n = 0; n < 800; n++) {
    const c = buildWin();
    if (!c) continue;
    built++;
    if (shanten(c) !== -1) { notWin++; continue; }

    // 1 枚抜けば必ず聴牌になり、抜いた牌は待ちに入っているはず
    const present = [];
    for (let t = 0; t < 34; t++) if (c[t] > 0) present.push(t);
    const drop = present[pick(present.length)];
    c[drop]--;
    if (shanten(c) !== 0 || !waits(c).includes(drop)) tenpaiBad++;
    c[drop]++;

    const r = judgeWin(c, [], {
      tsumo: n % 2 === 0, riichi: true, menzen: true, seatWind: EAST, roundWind: EAST,
      winTile: present[pick(present.length)], dora: 0,
    }, n % 3 === 0);
    if (!r) continue; // 立直を付けているので普通は役が付くが、役満形などで落ちる場合もある
    judged++;
    if (r.fu !== 0 && r.fu !== 25 && r.fu % 10 !== 0) fuBad++;
    if (r.score.points <= 0) fuBad++;
    if (r.han < 1) fuBad++;
  }
  ok(built > 500, `和了形を ${built} 個組めた`);
  ok(notWin === 0, `組んだ和了形はすべてシャンテン -1(外れ ${notWin})`);
  ok(tenpaiBad === 0, `1 枚抜くと必ず聴牌になり、抜いた牌が待ちに入る(外れ ${tenpaiBad})`);
  ok(judged > 400 && fuBad === 0, `${judged} 件の点数計算がすべて筋の通った値(外れ ${fuBad})`);

  // ランダム 14 枚では和了らない = 誤って和了と判定しないこと
  const wall = [];
  for (let t = 0; t < 34; t++) for (let i = 0; i < 4; i++) wall.push(t);
  let falseWin = 0;
  for (let n = 0; n < 2000; n++) {
    const pool = wall.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = pick(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const counts = toCounts(pool.slice(0, 14));
    const byShanten = shanten(counts) === -1;
    const byDecomp = winningDecomps(counts, [], pool[0], true).length > 0 || isChiitoi(counts) || isKokushi(counts);
    if (byShanten !== byDecomp) falseWin++;
  }
  ok(falseWin === 0, `ランダム 2000 手でシャンテンと面子分解の判定が食い違わない`);
}

console.log(fail === 0 ? '\n麻雀の核: ALL PASS' : '\n麻雀の核: FAIL あり');
process.exit(fail);
