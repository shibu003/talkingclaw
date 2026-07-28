// 麻雀の対局進行(I/O なし。test/check-mahjong-game.mjs から直接叩いて検査する)。
// 判定は mahjong.ts が持つ。ここは「山・配牌・ツモ・打牌・立直・ロン・流局」の段取りだけ。
//
// 決めごと(声で聞かれたらこのまま答えられるように 1 か所にまとめる):
//   東風戦 4 人 / 25000 点持ち / 赤ドラ無し / 鳴き無し(一人麻雀ではなく、
//   4 人で回すが副露は入れていない = 門前のみ)/ ドラ表示牌 1 枚 + 裏ドラ /
//   振聴あり / 流局は聴牌者で分ける / ダブロンは上家取り
//
// 鳴きを入れていない理由: 声で「ポン」「チー」を待つと、他家の打牌ごとに
// ユーザーの返事を待つことになって進まない。まず門前だけで遊べる形にする。
import * as mj from './mahjong.ts';

export type Player = {
  id: string;
  name: string;
  human: boolean;
  style: number;          // 0=ベタ降り寄り .. 1=押し寄り
  hand: mj.Counts;        // 手牌(13 or 14 枚)
  discards: mj.Tile[];    // 河
  points: number;
  riichi: boolean;
  riichiTurn: number;     // 立直した巡目(-1 = していない)
  ippatsu: boolean;
  drawn: mj.Tile | null;  // 今ツモった牌(打牌の候補)
};

export type Phase = 'idle' | 'draw' | 'discard' | 'ron' | 'done' | 'over';

export type Game = {
  seed: number;
  cursor: number;
  wall: mj.Tile[];
  drawn: number;          // 山から取った枚数
  players: Player[];
  dealer: number;         // 親の席
  turn: number;           // 手番
  round: number;          // 東 1..4
  honba: number;
  riichiSticks: number;
  doraIndicator: mj.Tile;
  uraIndicator: mj.Tile;
  phase: Phase;
  log: string[];
  lastDiscard: { tile: mj.Tile; from: number } | null;
  result?: string;
};

const WALL_KEEP = 14; // 王牌(嶺上・ドラ表示)ぶんは山から取らない

function next(g: { seed: number; cursor: number }): number {
  g.cursor++;
  return mix(g.seed, g.cursor);
}

// splitmix32 の仕上げ。近い seed(999 と 1000)でも別の並びになるまで混ぜる。
// 素朴な xorshift だと小さい seed の違いが上位ビットに届かず、配牌が同じになる
export function mix(seed: number, cursor: number): number {
  let x = (seed ^ Math.imul(cursor, 0x9e3779b9)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 0x1_0000_0000;
}

function buildWall(g: Game): void {
  const wall: mj.Tile[] = [];
  for (let t = 0; t < 34; t++) for (let i = 0; i < 4; i++) wall.push(t);
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(next(g) * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  g.wall = wall;
  g.drawn = 0;
}

/** ドラは表示牌の次の牌(9 の次は 1、中の次は東) */
export function doraOf(indicator: mj.Tile): mj.Tile {
  if (indicator >= mj.HONOR) {
    if (indicator < mj.HAKU) return indicator === mj.NORTH ? mj.EAST : indicator + 1; // 東南西北
    return indicator === mj.CHUN ? mj.HAKU : indicator + 1;                            // 白發中
  }
  const base = Math.floor(indicator / 9) * 9;
  return base + ((indicator % 9) + 1) % 9;
}

export function newGame(seed: number, players: { id: string; name: string; human: boolean; style?: number }[]): Game {
  const g: Game = {
    seed: seed | 0, cursor: 0, wall: [], drawn: 0,
    players: players.map((p) => ({
      id: p.id, name: p.name, human: p.human, style: p.style ?? 0.5,
      hand: new Array(34).fill(0), discards: [], points: 25000,
      riichi: false, riichiTurn: -1, ippatsu: false, drawn: null,
    })),
    dealer: 0, turn: 0, round: 1, honba: 0, riichiSticks: 0,
    doraIndicator: 0, uraIndicator: 0, phase: 'idle', log: [], lastDiscard: null,
  };
  buildWall(g);
  return g;
}

const seatWind = (g: Game, seat: number): mj.Tile => mj.EAST + ((seat - g.dealer + 4) % 4);

/** 1 局はじめる(配牌 → 親のツモまで) */
export function startHand(g: Game): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'idle' && g.phase !== 'done') return { ok: false, error: 'まだ局の途中だよ' };
  if (g.round > 4) return { ok: false, error: '東風戦はもう終わってるよ' };
  buildWall(g);
  g.log = [];
  g.lastDiscard = null;
  g.result = undefined;
  for (const p of g.players) {
    p.hand = new Array(34).fill(0);
    p.discards = [];
    p.riichi = false;
    p.riichiTurn = -1;
    p.ippatsu = false;
    p.drawn = null;
  }
  for (let round = 0; round < 13; round++) for (const p of g.players) p.hand[g.wall[g.drawn++]]++;
  g.doraIndicator = g.wall[g.wall.length - 5];
  g.uraIndicator = g.wall[g.wall.length - 6];
  g.turn = g.dealer;
  g.phase = 'draw';
  g.log.push(`東${g.round}局 ${g.honba}本場。親は ${g.players[g.dealer].name}。ドラは ${mj.tileName(doraOf(g.doraIndicator))}`);
  return draw(g);
}

/** 手番の人が山から 1 枚引く */
export function draw(g: Game): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'draw') return { ok: false, error: 'いまはツモる場面じゃないよ' };
  if (g.wall.length - g.drawn <= WALL_KEEP) return exhaustive(g);
  const p = g.players[g.turn];
  const t = g.wall[g.drawn++];
  p.hand[t]++;
  p.drawn = t;
  g.phase = 'discard';
  return { ok: true };
}

export function remaining(g: Game): number { return Math.max(0, g.wall.length - g.drawn - WALL_KEEP); }

function ctxOf(g: Game, seat: number, winTile: mj.Tile, tsumo: boolean): mj.Ctx {
  const p = g.players[seat];
  const dora = countDora(p.hand, doraOf(g.doraIndicator)) + (p.riichi ? countDora(p.hand, doraOf(g.uraIndicator)) : 0);
  return {
    tsumo, riichi: p.riichi, menzen: true,
    seatWind: seatWind(g, seat), roundWind: mj.EAST,
    winTile, dora, ippatsu: p.ippatsu,
    haitei: remaining(g) === 0,
  };
}
function countDora(hand: mj.Counts, dora: mj.Tile): number { return hand[dora]; }

/** ツモ和了できるか(役があるか含めて) */
export function canTsumo(g: Game, seat: number): mj.WinResult | null {
  const p = g.players[seat];
  if (p.drawn === null) return null;
  if (mj.shanten(p.hand) !== -1) return null;
  return mj.judgeWin(p.hand, [], ctxOf(g, seat, p.drawn, true), seat === g.dealer);
}

/** 振聴: 自分の待ちが自分の河にあるとロンできない */
export function isFuriten(g: Game, seat: number): boolean {
  const p = g.players[seat];
  const hand = p.hand.slice();
  if (p.drawn !== null) hand[p.drawn]--;
  const w = mj.waits(hand);
  return w.some((t) => p.discards.includes(t));
}

export function canRon(g: Game, seat: number): mj.WinResult | null {
  if (!g.lastDiscard || g.lastDiscard.from === seat) return null;
  const p = g.players[seat];
  if (isFuriten(g, seat)) return null;
  const hand = p.hand.slice();
  hand[g.lastDiscard.tile]++;
  if (mj.shanten(hand) !== -1) return null;
  return mj.judgeWin(hand, [], { ...ctxOf(g, seat, g.lastDiscard.tile, false), tsumo: false }, seat === g.dealer);
}

/** 打牌。riichi を立てるなら declareRiichi = true */
export function discard(g: Game, seat: number, tile: mj.Tile, declareRiichi = false): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'discard') return { ok: false, error: 'いまは切る場面じゃないよ' };
  if (g.turn !== seat) return { ok: false, error: `いまは ${g.players[g.turn].name} の番だよ` };
  const p = g.players[seat];
  if (p.hand[tile] === 0) return { ok: false, error: `${mj.tileName(tile)} は持ってないよ` };
  if (p.riichi && tile !== p.drawn) return { ok: false, error: '立直してるからツモ切りだけだよ' };

  if (declareRiichi) {
    if (p.riichi) return { ok: false, error: 'もう立直してるよ' };
    if (p.points < 1000) return { ok: false, error: '点棒が足りなくて立直できないよ' };
    const after = p.hand.slice();
    after[tile]--;
    if (mj.shanten(after) !== 0) return { ok: false, error: 'それだと聴牌にならないよ' };
    p.riichi = true;
    p.riichiTurn = p.discards.length;
    p.ippatsu = true;
    p.points -= 1000;
    g.riichiSticks++;
    g.log.push(`${p.name} が立直`);
  }

  p.hand[tile]--;
  p.discards.push(tile);
  p.drawn = null;
  g.lastDiscard = { tile, from: seat };
  // 一発は「立直の次の自分のツモまでに誰も鳴かず和了もしない」。ここでは他家の打牌で消す
  for (const o of g.players) if (o !== p && o.riichi) o.ippatsu = false;
  g.phase = 'ron';
  return { ok: true };
}

/** 誰もロンしなかった時に次の人へ回す */
export function pass(g: Game): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'ron') return { ok: false, error: 'いまは回す場面じゃないよ' };
  g.turn = (g.turn + 1) % 4;
  g.players[g.turn].ippatsu = g.players[g.turn].riichi && g.players[g.turn].ippatsu;
  g.phase = 'draw';
  return draw(g);
}

/** 和了の精算 */
export function win(g: Game, seat: number, tsumo: boolean): { ok: true } | { ok: false; error: string } {
  const r = tsumo ? canTsumo(g, seat) : canRon(g, seat);
  if (!r) return { ok: false, error: tsumo ? 'ツモれる形じゃないよ' : 'ロンできないよ(役無しか振聴)' };
  const p = g.players[seat];
  const dealerWin = seat === g.dealer;
  const honbaBonus = g.honba * 300;

  if (tsumo) {
    if (dealerWin) {
      const each = r.score.payments.fromEach ?? 0;
      for (let i = 0; i < 4; i++) if (i !== seat) { g.players[i].points -= each + g.honba * 100; p.points += each + g.honba * 100; }
    } else {
      const fromDealer = r.score.payments.fromDealer ?? 0;
      const fromEach = r.score.payments.fromEach ?? 0;
      for (let i = 0; i < 4; i++) {
        if (i === seat) continue;
        const pay = (i === g.dealer ? fromDealer : fromEach) + g.honba * 100;
        g.players[i].points -= pay;
        p.points += pay;
      }
    }
  } else {
    const from = g.lastDiscard!.from;
    const total = r.score.points + honbaBonus;
    g.players[from].points -= total;
    p.points += total;
  }
  p.points += g.riichiSticks * 1000;
  g.riichiSticks = 0;

  g.log.push(`${p.name} が ${tsumo ? 'ツモ' : 'ロン'}。${r.text} ${r.han}翻${r.fu > 0 ? `${r.fu}符` : ''} ${r.score.points}点${r.score.name ? `(${r.score.name})` : ''}`);
  g.result = r.text;
  finishHand(g, dealerWin);
  return { ok: true };
}

/** 流局 */
function exhaustive(g: Game): { ok: true } {
  const tenpai = g.players.map((p) => mj.shanten(p.hand) === 0 || mj.shanten(p.hand) === -1);
  const n = tenpai.filter(Boolean).length;
  if (n > 0 && n < 4) {
    const gain = Math.floor(3000 / n);
    const loss = Math.floor(3000 / (4 - n));
    g.players.forEach((p, i) => { p.points += tenpai[i] ? gain : -loss; });
  }
  g.log.push(`流局。聴牌は ${g.players.filter((_, i) => tenpai[i]).map((p) => p.name).join('・') || 'なし'}`);
  g.result = '流局';
  finishHand(g, tenpai[g.dealer]);
  return { ok: true };
}

function finishHand(g: Game, dealerKeeps: boolean): void {
  g.phase = 'done';
  if (dealerKeeps) g.honba++;
  else { g.honba = 0; g.dealer = (g.dealer + 1) % 4; g.round++; }
  if (g.round > 4 || g.players.some((p) => p.points < 0)) {
    g.phase = 'over';
    const ranked = [...g.players].sort((a, b) => b.points - a.points);
    g.log.push(`終局。${ranked.map((p, i) => `${i + 1}位 ${p.name} ${p.points}点`).join(' / ')}`);
  }
}

// ---- AI ----
/** 何を切るか。聴牌に近づく牌を残し、立直中の相手には危ない牌を避ける */
export function chooseDiscard(g: Game, seat: number): { tile: mj.Tile; riichi: boolean } {
  const p = g.players[seat];
  const danger = g.players.some((o, i) => i !== seat && o.riichi);
  let best: { tile: mj.Tile; shanten: number; ukeire: number; risk: number } | null = null;

  for (let t = 0; t < 34; t++) {
    if (p.hand[t] === 0) continue;
    if (p.riichi && t !== p.drawn) continue; // 立直中はツモ切りのみ
    p.hand[t]--;
    const sh = mj.shanten(p.hand);
    const uk = mj.ukeire(p.hand).count;
    p.hand[t]++;
    const risk = danger ? riskOf(g, seat, t) : 0;
    const cand = { tile: t, shanten: sh, ukeire: uk, risk };
    if (!best) { best = cand; continue; }
    // 危険な場面では、押し引きを style で決める(慎重なキャラは安全牌を選ぶ)
    const scoreOf = (c: typeof cand): number =>
      -c.shanten * 100 + c.ukeire * 0.5 - c.risk * (danger ? (1 - p.style) * 60 + 10 : 0);
    if (scoreOf(cand) > scoreOf(best)) best = cand;
  }
  const tile = best?.tile ?? p.drawn ?? 0;

  // 立直するか: 門前で聴牌、まだ立直していない、点棒がある
  let riichi = false;
  if (!p.riichi && p.points >= 1000) {
    const after = p.hand.slice();
    after[tile]--;
    if (mj.shanten(after) === 0 && mj.waits(after).length > 0) riichi = true;
  }
  return { tile, riichi };
}

/** その牌の危なさ(0..1)。ちゃんとした牌効率ではなく、現物と筋と字牌だけを見る素朴な目安 */
function riskOf(g: Game, seat: number, tile: mj.Tile): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    if (i === seat || !g.players[i].riichi) continue;
    const river = g.players[i].discards;
    if (river.includes(tile)) return 0;               // 現物は通る
    let r = 0.5;
    if (mj.isHonor(tile)) r = 0.25;                   // 字牌は当たりにくい
    else {
      const n = tile % 9;
      if (n === 0 || n === 8) r = 0.35;               // 端は比較的安全
      else if (n >= 3 && n <= 5) r = 0.6;             // 真ん中は危ない
      const suji = [tile - 3, tile + 3].filter((x) => Math.floor(x / 9) === Math.floor(tile / 9) && x >= 0);
      if (suji.some((x) => river.includes(x))) r -= 0.15; // 筋
    }
    worst = Math.max(worst, r);
  }
  return worst;
}

/** 場の様子を声で読み上げる文 */
export function describe(g: Game, meId: string): string {
  const seat = g.players.findIndex((p) => p.id === meId);
  const me = g.players[seat];
  if (!me) return '席が見つからないよ';
  if (g.phase === 'over') return g.log[g.log.length - 1] ?? '終局';
  if (g.phase === 'done') return `${g.log[g.log.length - 1] ?? ''} 点数は ${g.players.map((p) => `${p.name} ${p.points}`).join('、')}。次いく?`;
  const tiles: mj.Tile[] = [];
  for (let t = 0; t < 34; t++) for (let i = 0; i < me.hand[t]; i++) tiles.push(t);
  const sh = mj.shanten(me.hand);
  const state = sh === -1 ? '和了ってるよ' : sh === 0 ? `聴牌。待ちは ${mj.waits(withoutDrawn(me)).map(mj.tileName).join('・') || '無し'}` : `${sh} シャンテン`;
  const drawn = me.drawn !== null ? `ツモは ${mj.tileName(me.drawn)}。` : '';
  return `${drawn}手牌は ${mj.handText(tiles)}。${state}。残り ${remaining(g)} 枚。`;
}
function withoutDrawn(p: Player): mj.Counts {
  const h = p.hand.slice();
  if (p.drawn !== null) h[p.drawn]--;
  return h;
}

/** 手牌を画面に出す用(ツモ牌を右に離して置く) */
export function handDisplay(g: Game, meId: string): string {
  const me = g.players.find((p) => p.id === meId);
  if (!me) return '';
  const tiles: mj.Tile[] = [];
  for (let t = 0; t < 34; t++) for (let i = 0; i < me.hand[t]; i++) if (t !== me.drawn || i < me.hand[t] - 1) tiles.push(t);
  const drawn = me.drawn !== null ? `  ${mj.tileName(me.drawn)}` : '';
  return `${tiles.map(mj.tileName).join(' ')}${drawn}`;
}
