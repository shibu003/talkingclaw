// 立直麻雀の判定の核(I/O なし。test/check-mahjong.mjs から直接叩いて検査する)。
//
// ここが正しくないと「点が合わない麻雀」になって遊べないので、
// 和了形・シャンテン数・役・符・点数まで決定的なコードで持つ。LLM は一切かませない。
//
// 牌の番号: 0-8=萬子 1-9 / 9-17=筒子 1-9 / 18-26=索子 1-9 / 27-33=東南西北白發中
// 手牌は「34 種類の枚数の配列」で持つ(並べ替えの手間が消えるので判定が素直になる)

export type Tile = number;
export type Counts = number[]; // length 34

export const MAN = 0, PIN = 9, SOU = 18, HONOR = 27;
export const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30, HAKU = 31, HATSU = 32, CHUN = 33;

const NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HONOR_NAME = ['東', '南', '西', '北', '白', '發', '中'];

export function tileName(t: Tile): string {
  if (t >= HONOR) return HONOR_NAME[t - HONOR];
  const suit = t < PIN ? '萬' : t < SOU ? '筒' : '索';
  return NUM[t % 9] + suit;
}
export function isHonor(t: Tile): boolean { return t >= HONOR; }
export function isTerminal(t: Tile): boolean { return !isHonor(t) && (t % 9 === 0 || t % 9 === 8); }
export function isYaochu(t: Tile): boolean { return isHonor(t) || isTerminal(t); }
export function suitOf(t: Tile): number { return t >= HONOR ? 3 : Math.floor(t / 9); }

/** "123m456p789s11z" → 牌の配列。z は 1234567 = 東南西北白發中 */
export function parseHand(s: string): Tile[] {
  const out: Tile[] = [];
  let digits: number[] = [];
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { digits.push(Number(ch)); continue; }
    const base = { m: MAN, p: PIN, s: SOU, z: HONOR }[ch as 'm' | 'p' | 's' | 'z'];
    if (base === undefined) continue;
    for (const d of digits) out.push(base === HONOR ? HONOR + d - 1 : base + d - 1);
    digits = [];
  }
  return out;
}
export function toCounts(tiles: Tile[]): Counts {
  const c = new Array(34).fill(0);
  for (const t of tiles) c[t]++;
  return c;
}
export function handText(tiles: Tile[]): string {
  return [...tiles].sort((a, b) => a - b).map(tileName).join(' ');
}

// ---- 面子 ----
export type MeldKind = 'run' | 'triplet' | 'kan' | 'pair';
export type Meld = { kind: MeldKind; tile: Tile; open: boolean }; // run は tile = 一番小さい牌
export type Decomp = { melds: Meld[]; pair: Tile; wait: 'ryanmen' | 'kanchan' | 'penchan' | 'tanki' | 'shanpon' };

/** 面前部分(counts)を 面子 + 雀頭 に分ける。分け方が複数ある手はすべて返す */
function decompose(counts: Counts): { melds: Meld[]; pair: Tile }[] {
  const results: { melds: Meld[]; pair: Tile }[] = [];
  for (let p = 0; p < 34; p++) {
    if (counts[p] < 2) continue;
    counts[p] -= 2;
    for (const melds of meldsOf(counts, 0)) results.push({ melds, pair: p });
    counts[p] += 2;
  }
  // 同じ分け方が重複しないように(順子の取り出し順で同型が出る)
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.pair + '|' + r.melds.map((m) => m.kind + m.tile).sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function meldsOf(counts: Counts, from: number): Meld[][] {
  let i = from;
  while (i < 34 && counts[i] === 0) i++;
  if (i >= 34) return [[]];
  const out: Meld[][] = [];
  if (counts[i] >= 3) {
    counts[i] -= 3;
    for (const rest of meldsOf(counts, i)) out.push([{ kind: 'triplet', tile: i, open: false }, ...rest]);
    counts[i] += 3;
  }
  if (i < HONOR && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--; counts[i + 1]--; counts[i + 2]--;
    for (const rest of meldsOf(counts, i)) out.push([{ kind: 'run', tile: i, open: false }, ...rest]);
    counts[i]++; counts[i + 1]++; counts[i + 2]++;
  }
  return out;
}

export function isChiitoi(counts: Counts): boolean {
  let pairs = 0;
  for (const n of counts) { if (n === 2) pairs++; else if (n !== 0) return false; }
  return pairs === 7;
}

const KOKUSHI_TILES = [0, 8, 9, 17, 18, 26, EAST, SOUTH, WEST, NORTH, HAKU, HATSU, CHUN];
export function isKokushi(counts: Counts): boolean {
  let pair = 0;
  for (let t = 0; t < 34; t++) {
    if (!KOKUSHI_TILES.includes(t)) { if (counts[t] > 0) return false; continue; }
    if (counts[t] === 0) return false;
    if (counts[t] === 2) pair++;
    else if (counts[t] !== 1) return false;
  }
  return pair === 1;
}

/** 和了しているか。open は鳴いた面子(counts には含めない) */
export function winningDecomps(counts: Counts, open: Meld[], winTile: Tile, tsumo: boolean): Decomp[] {
  const out: Decomp[] = [];
  for (const d of decompose(counts.slice())) {
    if (d.melds.length + open.length !== 4) continue;
    out.push({ melds: [...d.melds, ...open], pair: d.pair, wait: waitOf(d, winTile, tsumo) });
  }
  return out;
}

// 待ちの形。符と平和の判定に使う
function waitOf(d: { melds: Meld[]; pair: Tile }, winTile: Tile, _tsumo: boolean): Decomp['wait'] {
  if (d.pair === winTile) return 'tanki';
  for (const m of d.melds) {
    if (m.kind === 'triplet' && m.tile === winTile) return 'shanpon';
  }
  for (const m of d.melds) {
    if (m.kind !== 'run') continue;
    const [a, b, c] = [m.tile, m.tile + 1, m.tile + 2];
    if (winTile === b) return 'kanchan';
    if (winTile === a && c % 9 === 8) return 'penchan'; // 789 の 7 待ち
    if (winTile === c && a % 9 === 0) return 'penchan'; // 123 の 3 待ち
    if (winTile === a || winTile === c) return 'ryanmen';
  }
  return 'tanki';
}

// ---- シャンテン数(あと何枚で聴牌か。-1 = 和了)----
export function shanten(counts: Counts, openCount = 0): number {
  return Math.min(shantenRegular(counts.slice(), openCount), shantenChiitoi(counts), shantenKokushi(counts));
}

function shantenChiitoi(counts: Counts): number {
  let pairs = 0, kinds = 0;
  for (const n of counts) { if (n >= 2) pairs++; if (n > 0) kinds++; }
  return 6 - pairs + Math.max(0, 7 - kinds); // 種類が足りないぶんは余計にかかる
}

function shantenKokushi(counts: Counts): number {
  let kinds = 0, hasPair = 0;
  for (const t of KOKUSHI_TILES) { if (counts[t] > 0) kinds++; if (counts[t] >= 2) hasPair = 1; }
  return 13 - kinds - hasPair;
}

// 面子と搭子(2 枚組)を最大まで取って数える。標準式: 8 - 2*面子 - max(搭子+雀頭)
function shantenRegular(counts: Counts, openCount: number): number {
  let best = 8;
  const scan = (sets: number, partials: number, pairUsed: boolean): void => {
    const total = sets + openCount;
    const usable = Math.min(partials, 4 - total);
    const val = 8 - 2 * total - usable - (pairUsed && total + usable < 5 ? 1 : 0);
    if (val < best) best = val;
  };
  // 雀頭を決め打つ場合としない場合の両方を見る
  const walk = (i: number, sets: number, partials: number, pairUsed: boolean): void => {
    while (i < 34 && counts[i] === 0) i++;
    if (i >= 34) { scan(sets, partials, pairUsed); return; }
    scan(sets, partials, pairUsed); // ここで打ち切る場合
    if (counts[i] >= 3) { counts[i] -= 3; walk(i, sets + 1, partials, pairUsed); counts[i] += 3; }
    if (i < HONOR && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--; walk(i, sets + 1, partials, pairUsed);
      counts[i]++; counts[i + 1]++; counts[i + 2]++;
    }
    if (counts[i] >= 2) {
      counts[i] -= 2;
      if (!pairUsed) walk(i, sets, partials, true);   // 雀頭にする
      walk(i, sets, partials + 1, pairUsed);          // 対子(刻子の種)にする
      counts[i] += 2;
    }
    if (i < HONOR && i % 9 <= 7 && counts[i + 1] > 0) { // 両面・辺張
      counts[i]--; counts[i + 1]--; walk(i, sets, partials + 1, pairUsed); counts[i]++; counts[i + 1]++;
    }
    if (i < HONOR && i % 9 <= 6 && counts[i + 2] > 0) { // 嵌張
      counts[i]--; counts[i + 2]--; walk(i, sets, partials + 1, pairUsed); counts[i]++; counts[i + 2]++;
    }
    counts[i]--; walk(i, sets, partials, pairUsed); counts[i]++; // この牌を使わない
  };
  walk(0, 0, 0, false);
  return best;
}

/** 何を引けば進むか(受け入れ牌)。AI の打牌選びに使う */
export function ukeire(counts: Counts, openCount = 0): { tiles: Tile[]; count: number } {
  const base = shanten(counts, openCount);
  const tiles: Tile[] = [];
  let count = 0;
  for (let t = 0; t < 34; t++) {
    if (counts[t] >= 4) continue;
    counts[t]++;
    if (shanten(counts, openCount) < base) { tiles.push(t); count += 4 - (counts[t] - 1); }
    counts[t]--;
  }
  return { tiles, count };
}

// ---- 役 ----
export type Ctx = {
  tsumo: boolean;
  riichi: boolean;
  menzen: boolean;      // 鳴いていない
  seatWind: Tile;       // 自風(27..30)
  roundWind: Tile;      // 場風
  winTile: Tile;
  dora: number;         // ドラの枚数(役ではないが翻に足す)
  ippatsu?: boolean;
  rinshan?: boolean;
  haitei?: boolean;
  chankan?: boolean;
  doubleRiichi?: boolean;
};
export type Yaku = { name: string; han: number };

const allTiles = (d: Decomp): Tile[] => {
  const out: Tile[] = [d.pair, d.pair];
  for (const m of d.melds) {
    if (m.kind === 'run') out.push(m.tile, m.tile + 1, m.tile + 2);
    else out.push(m.tile, m.tile, m.tile, ...(m.kind === 'kan' ? [m.tile] : []));
  }
  return out;
};

export function yakuOf(d: Decomp, ctx: Ctx, counts: Counts, open: Meld[]): { yaku: Yaku[]; yakuman: boolean } {
  const tiles = allTiles(d);
  const runs = d.melds.filter((m) => m.kind === 'run');
  const trips = d.melds.filter((m) => m.kind === 'triplet' || m.kind === 'kan');
  const y: Yaku[] = [];
  const add = (name: string, han: number): void => { y.push({ name, han }); };

  // ---- 役満 ----
  const yakuman: Yaku[] = [];
  if (isKokushi(counts)) yakuman.push({ name: '国士無双', han: 13 });
  if (trips.length === 4) {
    const concealed = trips.filter((m) => !m.open).length;
    // ロンで完成した刻子は明刻扱い(四暗刻の判定はここで効く)
    const conc = ctx.tsumo || d.wait !== 'shanpon' ? concealed : concealed - 1;
    if (conc === 4) yakuman.push({ name: d.wait === 'tanki' ? '四暗刻単騎' : '四暗刻', han: 13 });
  }
  const honorTrips = trips.filter((m) => isHonor(m.tile));
  const dragons = honorTrips.filter((m) => m.tile >= HAKU).length;
  if (dragons === 3) yakuman.push({ name: '大三元', han: 13 });
  if (tiles.every(isHonor)) yakuman.push({ name: '字一色', han: 13 });
  if (tiles.every((t) => isTerminal(t))) yakuman.push({ name: '清老頭', han: 13 });
  const winds = honorTrips.filter((m) => m.tile < HAKU).length;
  if (winds === 4) yakuman.push({ name: '大四喜', han: 13 });
  else if (winds === 3 && d.pair >= EAST && d.pair < HAKU) yakuman.push({ name: '小四喜', han: 13 });
  const GREEN = [19, 20, 21, 23, 25, HATSU]; // 2,3,4,6,8索 と 發
  if (tiles.every((t) => GREEN.includes(t))) yakuman.push({ name: '緑一色', han: 13 });
  if (yakuman.length > 0) return { yaku: yakuman, yakuman: true };

  // ---- 通常役 ----
  if (ctx.riichi) add(ctx.doubleRiichi ? 'ダブル立直' : '立直', ctx.doubleRiichi ? 2 : 1);
  if (ctx.ippatsu && ctx.riichi) add('一発', 1);
  if (ctx.menzen && ctx.tsumo) add('門前清自摸和', 1);
  if (ctx.haitei) add(ctx.tsumo ? '海底摸月' : '河底撈魚', 1);
  if (ctx.rinshan) add('嶺上開花', 1);
  if (ctx.chankan) add('槍槓', 1);

  // 平和: 門前・全部順子・雀頭が役牌でない・両面待ち
  const pairIsYakuhai = d.pair >= HAKU || d.pair === ctx.seatWind || d.pair === ctx.roundWind;
  if (ctx.menzen && runs.length === 4 && !pairIsYakuhai && d.wait === 'ryanmen') add('平和', 1);

  if (tiles.every((t) => !isYaochu(t))) add('断幺九', 1);

  for (const m of honorTrips) {
    if (m.tile === HAKU) add('役牌 白', 1);
    else if (m.tile === HATSU) add('役牌 發', 1);
    else if (m.tile === CHUN) add('役牌 中', 1);
    else {
      if (m.tile === ctx.seatWind) add(`自風 ${tileName(m.tile)}`, 1);
      if (m.tile === ctx.roundWind) add(`場風 ${tileName(m.tile)}`, 1);
    }
  }

  // 一盃口 / 二盃口(門前限定)
  if (ctx.menzen) {
    const seen = new Map<number, number>();
    for (const r of runs) seen.set(r.tile, (seen.get(r.tile) ?? 0) + 1);
    const doubles = [...seen.values()].filter((n) => n >= 2).length;
    if (doubles >= 2) add('二盃口', 3);
    else if (doubles === 1) add('一盃口', 1);
  }

  // 三色同順 / 一気通貫 / 三色同刻
  const runStarts = new Set(runs.map((r) => r.tile));
  for (let n = 0; n <= 6; n++) {
    if (runStarts.has(MAN + n) && runStarts.has(PIN + n) && runStarts.has(SOU + n)) { add('三色同順', ctx.menzen ? 2 : 1); break; }
  }
  for (const base of [MAN, PIN, SOU]) {
    if (runStarts.has(base) && runStarts.has(base + 3) && runStarts.has(base + 6)) { add('一気通貫', ctx.menzen ? 2 : 1); break; }
  }
  const tripNums = new Set(trips.filter((m) => !isHonor(m.tile)).map((m) => m.tile));
  for (let n = 0; n <= 8; n++) {
    if (tripNums.has(MAN + n) && tripNums.has(PIN + n) && tripNums.has(SOU + n)) { add('三色同刻', 2); break; }
  }

  if (trips.length === 4) add('対々和', 2);
  const concealedTrips = trips.filter((m) => !m.open).length
    - (!ctx.tsumo && d.wait === 'shanpon' ? 1 : 0);
  if (concealedTrips === 3) add('三暗刻', 2);
  if (d.melds.filter((m) => m.kind === 'kan').length === 3) add('三槓子', 2);
  if (dragons === 2 && d.pair >= HAKU) add('小三元', 2);

  // 全帯么九 / 純全帯么九 / 混老頭
  const groups: Tile[][] = [[d.pair, d.pair], ...d.melds.map((m) =>
    m.kind === 'run' ? [m.tile, m.tile + 1, m.tile + 2] : [m.tile])];
  const everyGroupHasYaochu = groups.every((g) => g.some(isYaochu));
  if (everyGroupHasYaochu) {
    if (tiles.every(isYaochu)) add('混老頭', 2);
    else if (tiles.some(isHonor)) add('混全帯幺九', ctx.menzen ? 2 : 1);
    else add('純全帯幺九', ctx.menzen ? 3 : 2);
  }

  // 混一色 / 清一色
  const suits = new Set(tiles.filter((t) => !isHonor(t)).map(suitOf));
  if (suits.size === 1) {
    if (tiles.some(isHonor)) add('混一色', ctx.menzen ? 3 : 2);
    else add('清一色', ctx.menzen ? 6 : 5);
  }

  return { yaku: y, yakuman: false };
}

/** 七対子は面子に分けられないので別扱い */
export function chiitoiYaku(ctx: Ctx, counts: Counts): Yaku[] {
  const y: Yaku[] = [{ name: '七対子', han: 2 }];
  if (ctx.riichi) y.unshift({ name: ctx.doubleRiichi ? 'ダブル立直' : '立直', han: ctx.doubleRiichi ? 2 : 1 });
  if (ctx.ippatsu && ctx.riichi) y.push({ name: '一発', han: 1 });
  if (ctx.menzen && ctx.tsumo) y.push({ name: '門前清自摸和', han: 1 });
  const tiles: Tile[] = [];
  for (let t = 0; t < 34; t++) for (let i = 0; i < counts[t]; i++) tiles.push(t);
  if (tiles.every((t) => !isYaochu(t))) y.push({ name: '断幺九', han: 1 });
  if (tiles.every(isYaochu)) y.push({ name: '混老頭', han: 2 });
  const suits = new Set(tiles.filter((t) => !isHonor(t)).map(suitOf));
  if (suits.size === 1) y.push(tiles.some(isHonor) ? { name: '混一色', han: 3 } : { name: '清一色', han: 6 });
  return y;
}

// ---- 符 ----
export function fuOf(d: Decomp, ctx: Ctx, hasPinfu: boolean): number {
  if (hasPinfu) return ctx.tsumo ? 20 : 30; // 平和ツモは 20 固定、平和ロンは 30
  let fu = 20;
  if (ctx.menzen && !ctx.tsumo) fu += 10;
  if (ctx.tsumo) fu += 2;
  for (const m of d.melds) {
    if (m.kind === 'run') continue;
    const base = isYaochu(m.tile) ? 2 : 1;
    // ロンで完成した刻子は明刻として数える
    const ronCompleted = !ctx.tsumo && d.wait === 'shanpon' && m.tile === ctx.winTile;
    const concealed = !m.open && !ronCompleted;
    fu += base * (m.kind === 'kan' ? (concealed ? 16 : 8) : (concealed ? 4 : 2));
  }
  if (d.pair >= HAKU) fu += 2;
  if (d.pair === ctx.seatWind) fu += 2;
  if (d.pair === ctx.roundWind) fu += 2;
  if (d.wait === 'kanchan' || d.wait === 'penchan' || d.wait === 'tanki') fu += 2;
  const rounded = Math.ceil(fu / 10) * 10;
  // 食い平和形(鳴いていて符が付かない)は 30 符
  return !ctx.menzen && rounded === 20 ? 30 : rounded;
}

// ---- 点数 ----
export type Score = { han: number; fu: number; points: number; name: string; payments: { fromDealer?: number; fromEach?: number; total: number } };

/** han/fu から点数を出す。ceil100 は麻雀の切り上げ */
export function score(han: number, fu: number, dealer: boolean, tsumo: boolean): Score {
  // 素点(基本点)を出してから、満貫以上の頭打ちに掛ける。
  // 4 翻 40 符(素点 2560)のように素点が 2000 を超えたら満貫になる
  const raw = fu * Math.pow(2, 2 + han);
  let base = raw;
  let name = '';
  if (han >= 13) { base = 8000; name = '役満'; }
  else if (han >= 11) { base = 6000; name = '三倍満'; }
  else if (han >= 8) { base = 4000; name = '倍満'; }
  else if (han >= 6) { base = 3000; name = '跳満'; }
  else if (han >= 5 || raw >= 2000) { base = 2000; name = '満貫'; }
  const ceil100 = (n: number): number => Math.ceil(n / 100) * 100;
  if (tsumo) {
    if (dealer) {
      const each = ceil100(base * 2);
      return { han, fu, points: each * 3, name, payments: { fromEach: each, total: each * 3 } };
    }
    const fromDealer = ceil100(base * 2);
    const fromEach = ceil100(base);
    return { han, fu, points: fromDealer + fromEach * 2, name, payments: { fromDealer, fromEach, total: fromDealer + fromEach * 2 } };
  }
  const total = ceil100(base * (dealer ? 6 : 4));
  return { han, fu, points: total, name, payments: { total } };
}

/** 和了の一式: 一番高い取り方を選んで点数まで出す */
export type WinResult = { yaku: Yaku[]; han: number; fu: number; score: Score; text: string };

export function judgeWin(counts: Counts, open: Meld[], ctx: Ctx, dealer: boolean): WinResult | null {
  const withWin = counts.slice();
  const options: WinResult[] = [];

  if (isKokushi(withWin)) {
    const s = score(13, 25, dealer, ctx.tsumo);
    return { yaku: [{ name: '国士無双', han: 13 }], han: 13, fu: 25, score: s, text: '国士無双' };
  }
  if (isChiitoi(withWin) && ctx.menzen) {
    const y = chiitoiYaku(ctx, withWin);
    const han = y.reduce((n, x) => n + x.han, 0) + ctx.dora;
    options.push({ yaku: y, han, fu: 25, score: score(han, 25, dealer, ctx.tsumo), text: y.map((x) => x.name).join('・') });
  }
  for (const d of winningDecomps(withWin, open, ctx.winTile, ctx.tsumo)) {
    const { yaku, yakuman } = yakuOf(d, ctx, withWin, open);
    if (yakuman) {
      const han = yaku.reduce((n, x) => n + x.han, 0);
      options.push({ yaku, han, fu: 0, score: score(han, 0, dealer, ctx.tsumo), text: yaku.map((x) => x.name).join('・') });
      continue;
    }
    if (yaku.length === 0) continue; // 役無しは和了れない
    const hasPinfu = yaku.some((x) => x.name === '平和');
    const fu = fuOf(d, ctx, hasPinfu);
    const han = yaku.reduce((n, x) => n + x.han, 0) + ctx.dora;
    options.push({ yaku, han, fu, score: score(han, fu, dealer, ctx.tsumo), text: yaku.map((x) => x.name).join('・') });
  }
  if (options.length === 0) return null;
  // 一番高くなる取り方を選ぶ(麻雀は高点法)
  options.sort((a, b) => b.score.points - a.score.points || b.han - a.han || b.fu - a.fu);
  return options[0];
}

/** 聴牌しているか + 何待ちか */
export function waits(counts: Counts, openCount = 0): Tile[] {
  const out: Tile[] = [];
  for (let t = 0; t < 34; t++) {
    if (counts[t] >= 4) continue;
    counts[t]++;
    if (shanten(counts, openCount) === -1) out.push(t);
    counts[t]--;
  }
  return out;
}
