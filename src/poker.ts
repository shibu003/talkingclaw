// テキサスホールデムの純ロジック(I/O なし。test/check-poker.mjs から直接叩いて検査する)。
//
// なぜサーバで持つか: 配札・役の判定・ポットの分配を LLM にやらせると「ズルしていない」を
// 証明できないし、金が湧く。ここは決定的なコードで持ち、乱数は seed 付きにする。
// クロエたちは「判定役」ではなく「席に着く相手」で、降りるか乗るかだけを決める。
//
// AI の強さ: 手なりの表ではなくモンテカルロで勝率を出す(残りの札を何度も配って数える)。
// そのうえでポットオッズと比べて降り引きを決めるので、キャラの強気さを変えても
// 「明らかにおかしい打ち方」にはならない。
//
// ハウスルール: ノーリミット / ブラインドは固定 / サイドポットあり / レーキなし

export type Card = { rank: number; suit: number }; // rank 2..14(14=A)、suit 0..3
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'done';
export type Move = 'fold' | 'check' | 'call' | 'raise' | 'allin';

export type Seat = {
  id: string;
  name: string;
  human: boolean;
  style: number;      // 0=慎重 .. 1=強気(キャラごとの性格)
  chips: number;
  hole: Card[];
  committed: number;  // このストリートで出した額
  totalIn: number;    // この手で出した合計(サイドポット計算に使う)
  folded: boolean;
  allIn: boolean;
  acted: boolean;     // このストリートで一度でも行動したか
  won?: number;       // 直前の手で受け取った額
  handName?: string;  // ショーダウンで見せた役
};

export type Table = {
  seed: number;
  cursor: number;
  deck: Card[];
  dealt: number;
  seats: Seat[];
  button: number;
  toAct: number;
  board: Card[];
  street: Street;
  bet: number;        // このストリートの最高 committed
  minRaise: number;   // 次のレイズで最低限上げる幅
  blind: number;
  hands: number;
  refilled: number;   // 卓に足したチップの合計(黙って増やさないための記録)
  log: string[];      // この手の出来事(読み上げ用)
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
const CAT_NAME = ['ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ'];

export function cardName(c: Card): string { return SUITS[c.suit] + RANKS[c.rank]; }
export function handText(cards: Card[]): string { return cards.map(cardName).join(' '); }

// ---- seed 付き乱数(同じ seed なら同じ札順 = 後から検証できる)----
function next(t: { seed: number; cursor: number }): number {
  t.cursor++;
  return mix(t.seed, t.cursor);
}

// splitmix32 の仕上げ。近い seed でも別の並びになるまで混ぜる
// (素朴な xorshift だと小さい seed の違いが上位ビットに届かず、山が同じになる)
export function mix(seed: number, cursor: number): number {
  let x = (seed ^ Math.imul(cursor, 0x9e3779b9)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 0x1_0000_0000;
}

function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  return deck;
}

function shuffle(t: Table): void {
  const deck = freshDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(next(t) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  t.deck = deck;
  t.dealt = 0;
}

// ---- 役の判定: 手札 + 場札(最大 7 枚)から一番強い 5 枚を選ぶ ----
// cat が大きいほど強い。同じ cat なら tie を頭から比べる
export type Rank = { cat: number; tie: number[]; name: string };

export function evaluate(cards: Card[]): Rank {
  const byRank = new Map<number, number>();
  const bySuit = new Map<number, Card[]>();
  for (const c of cards) {
    byRank.set(c.rank, (byRank.get(c.rank) ?? 0) + 1);
    (bySuit.get(c.suit) ?? bySuit.set(c.suit, []).get(c.suit)!).push(c);
  }

  const flushSuit = [...bySuit.entries()].find(([, cs]) => cs.length >= 5)?.[0];
  const straightTop = (ranks: number[]): number | null => {
    const uniq = [...new Set(ranks)].sort((a, b) => b - a);
    if (uniq.includes(14)) uniq.push(1); // A は 5-4-3-2-A の 1 としても使える
    let run = 1;
    for (let i = 1; i < uniq.length; i++) {
      if (uniq[i] === uniq[i - 1] - 1) {
        run++;
        if (run >= 5) return uniq[i] + 4;
      } else run = 1;
    }
    return null;
  };

  if (flushSuit !== undefined) {
    const fc = bySuit.get(flushSuit)!;
    const sfTop = straightTop(fc.map((c) => c.rank));
    if (sfTop !== null) return { cat: 8, tie: [sfTop], name: sfTop === 14 ? 'ロイヤルフラッシュ' : CAT_NAME[8] };
  }

  const groups = [...byRank.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const counts = groups.map(([, n]) => n);
  const kickers = (used: number[], n: number): number[] =>
    cards.map((c) => c.rank).filter((r) => !used.includes(r)).sort((a, b) => b - a).slice(0, n);

  if (counts[0] === 4) return { cat: 7, tie: [groups[0][0], ...kickers([groups[0][0]], 1)], name: CAT_NAME[7] };
  if (counts[0] === 3 && counts[1] >= 2) return { cat: 6, tie: [groups[0][0], groups[1][0]], name: CAT_NAME[6] };
  if (flushSuit !== undefined) {
    const top5 = bySuit.get(flushSuit)!.map((c) => c.rank).sort((a, b) => b - a).slice(0, 5);
    return { cat: 5, tie: top5, name: CAT_NAME[5] };
  }
  const sTop = straightTop(cards.map((c) => c.rank));
  if (sTop !== null) return { cat: 4, tie: [sTop], name: CAT_NAME[4] };
  if (counts[0] === 3) return { cat: 3, tie: [groups[0][0], ...kickers([groups[0][0]], 2)], name: CAT_NAME[3] };
  if (counts[0] === 2 && counts[1] === 2) {
    const [hi, lo] = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return { cat: 2, tie: [hi, lo, ...kickers([hi, lo], 1)], name: CAT_NAME[2] };
  }
  if (counts[0] === 2) return { cat: 1, tie: [groups[0][0], ...kickers([groups[0][0]], 3)], name: CAT_NAME[1] };
  return { cat: 0, tie: cards.map((c) => c.rank).sort((a, b) => b - a).slice(0, 5), name: CAT_NAME[0] };
}

export function compare(a: Rank, b: Rank): number {
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
    const d = (a.tie[i] ?? 0) - (b.tie[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---- 卓 ----
export function newTable(seed: number, players: { id: string; name: string; human: boolean; style?: number }[],
  chips = 1000, blind = 10): Table {
  const t: Table = {
    seed: seed | 0, cursor: 0, deck: [], dealt: 0,
    seats: players.map((p) => ({
      id: p.id, name: p.name, human: p.human, style: p.style ?? 0.5,
      chips, hole: [], committed: 0, totalIn: 0, folded: false, allIn: false, acted: false,
    })),
    button: 0, toAct: 0, board: [], street: 'done',
    bet: 0, minRaise: blind, blind, hands: 0, refilled: 0, log: [],
  };
  shuffle(t);
  return t;
}

const live = (t: Table): Seat[] => t.seats.filter((s) => !s.folded);
const canAct = (t: Table): Seat[] => t.seats.filter((s) => !s.folded && !s.allIn);
export const potOf = (t: Table): number => t.seats.reduce((n, s) => n + s.totalIn, 0);

function nextIndex(t: Table, from: number): number {
  for (let i = 1; i <= t.seats.length; i++) {
    const idx = (from + i) % t.seats.length;
    const s = t.seats[idx];
    if (!s.folded && !s.allIn) return idx;
  }
  return from;
}

/** 1 手はじめる。チップが無い席は自動で補充する(暇つぶしなので卓は畳まない) */
export function startHand(t: Table): { ok: true } | { ok: false; error: string } {
  if (t.street !== 'done') return { ok: false, error: 'まだ手の途中だよ' };
  if (t.dealt > 30) shuffle(t); // 1 手で使うのは最大 (人数×2 + 5 + バーン無し)。余裕を見て組み直す
  t.log = []; // 補充のお知らせを消さないよう、席をなおす前に空にする
  for (const s of t.seats) {
    if (s.chips < t.blind) { s.chips += 1000; t.refilled += 1000; t.log.push(`${s.name} にチップを 1000 足したよ`); }
    s.hole = []; s.committed = 0; s.totalIn = 0; s.folded = false; s.allIn = false; s.acted = false;
    s.won = undefined; s.handName = undefined;
  }
  t.board = [];
  t.bet = 0;
  t.minRaise = t.blind;
  t.hands++;
  t.button = t.hands === 1 ? 0 : (t.button + 1) % t.seats.length;

  for (let round = 0; round < 2; round++) for (const s of t.seats) s.hole.push(t.deck[t.dealt++]);

  // ブラインド。2 人ならボタンが SB(ヘッズアップの決まり)
  const heads = t.seats.length === 2;
  const sb = heads ? t.button : (t.button + 1) % t.seats.length;
  const bb = heads ? (t.button + 1) % t.seats.length : (t.button + 2) % t.seats.length;
  put(t, t.seats[sb], Math.floor(t.blind / 2));
  put(t, t.seats[bb], t.blind);
  t.bet = t.blind;
  t.street = 'preflop';
  t.toAct = heads ? sb : (bb + 1) % t.seats.length;
  if (t.seats[t.toAct].folded || t.seats[t.toAct].allIn) t.toAct = nextIndex(t, t.toAct);
  t.log.push(`${t.seats[sb].name} が SB ${Math.floor(t.blind / 2)}、${t.seats[bb].name} が BB ${t.blind}`);
  return { ok: true };
}

function put(t: Table, s: Seat, amount: number): number {
  const paid = Math.min(amount, s.chips);
  s.chips -= paid;
  s.committed += paid;
  s.totalIn += paid;
  if (s.chips === 0) s.allIn = true;
  return paid;
}

export function toCall(t: Table, s: Seat): number { return Math.max(0, Math.min(t.bet - s.committed, s.chips)); }

/** 席の行動。amount は raise の時の「最終的な committed 額」ではなく「上乗せ後の総額」 */
export function act(t: Table, seatId: string, move: Move, amount = 0): { ok: true } | { ok: false; error: string } {
  if (t.street === 'done' || t.street === 'showdown') return { ok: false, error: 'いまは手の外だよ' };
  const s = t.seats[t.toAct];
  if (!s || s.id !== seatId) return { ok: false, error: `いまは ${t.seats[t.toAct]?.name ?? '?'} の番だよ` };
  const need = toCall(t, s);

  if (move === 'fold') {
    if (need === 0) return { ok: false, error: '払うものが無いよ。チェックでいいよ' };
    s.folded = true;
    t.log.push(`${s.name} は降りた`);
  } else if (move === 'check') {
    if (need > 0) return { ok: false, error: `${need} 払わないとチェックできないよ` };
    t.log.push(`${s.name} はチェック`);
  } else if (move === 'call') {
    if (need === 0) return { ok: false, error: '払うものが無いよ。チェックでいいよ' };
    put(t, s, need);
    t.log.push(`${s.name} は ${need} コール`);
  } else if (move === 'raise' || move === 'allin') {
    const all = move === 'allin' || amount >= s.chips + s.committed;
    const target = all ? s.chips + s.committed : Math.floor(amount);
    if (!all) {
      if (target <= t.bet) return { ok: false, error: `${t.bet} より上げてね` };
      if (target - t.bet < t.minRaise) return { ok: false, error: `最低 ${t.bet + t.minRaise} まで上げてね` };
    }
    const raiseBy = target - t.bet;
    put(t, s, target - s.committed);
    if (s.committed > t.bet) {
      if (raiseBy >= t.minRaise) t.minRaise = raiseBy;
      t.bet = s.committed;
      for (const o of t.seats) if (o !== s && !o.folded && !o.allIn) o.acted = false; // 上げられたら全員もう一度
    }
    t.log.push(`${s.name} は ${s.allIn ? 'オールイン' : `${t.bet} までレイズ`}`);
  }
  s.acted = true;
  advance(t);
  return { ok: true };
}

function advance(t: Table): void {
  if (live(t).length === 1) return settle(t); // 全員降りた
  const pending = canAct(t).filter((s) => !s.acted || s.committed < t.bet);
  if (pending.length > 0) {
    t.toAct = nextIndex(t, t.toAct);
    return;
  }
  nextStreet(t);
}

function nextStreet(t: Table): void {
  for (const s of t.seats) { s.committed = 0; s.acted = false; }
  t.bet = 0;
  t.minRaise = t.blind;
  if (t.street === 'preflop') { t.board.push(t.deck[t.dealt++], t.deck[t.dealt++], t.deck[t.dealt++]); t.street = 'flop'; }
  else if (t.street === 'flop') { t.board.push(t.deck[t.dealt++]); t.street = 'turn'; }
  else if (t.street === 'turn') { t.board.push(t.deck[t.dealt++]); t.street = 'river'; }
  else return settle(t);

  if (canAct(t).length <= 1) return nextStreet(t); // もう誰も動けない = 最後まで配る
  t.toAct = nextIndex(t, t.button);
  t.log.push(`${t.street === 'flop' ? 'フロップ' : t.street === 'turn' ? 'ターン' : 'リバー'}: ${handText(t.board)}`);
}

/** ポットを配る。出した額(totalIn)の刻みでサイドポットを作るので、金は 1 枚も湧かないし消えない */
function settle(t: Table): void {
  t.street = 'showdown';
  const contenders = live(t);
  const ranks = new Map<string, Rank>();
  if (contenders.length > 1) {
    for (const s of contenders) {
      const r = evaluate([...s.hole, ...t.board]);
      ranks.set(s.id, r);
      s.handName = r.name;
    }
  }

  const levels = [...new Set(t.seats.filter((s) => s.totalIn > 0).map((s) => s.totalIn))].sort((a, b) => a - b);
  let taken = 0;
  for (const level of levels) {
    const slice = t.seats.reduce((n, s) => n + Math.max(0, Math.min(s.totalIn, level) - taken), 0);
    if (slice <= 0) { taken = level; continue; }
    const eligible = contenders.filter((s) => s.totalIn >= level);
    if (eligible.length === 0) { taken = level; continue; }
    let winners = eligible;
    if (eligible.length > 1) {
      let best = ranks.get(eligible[0].id)!;
      winners = [eligible[0]];
      for (const s of eligible.slice(1)) {
        const r = ranks.get(s.id)!;
        const d = compare(r, best);
        if (d > 0) { best = r; winners = [s]; } else if (d === 0) winners.push(s);
      }
    }
    const share = Math.floor(slice / winners.length);
    let rest = slice - share * winners.length;
    for (const w of winners) {
      const add = share + (rest-- > 0 ? 1 : 0); // 割り切れない端数は前の席から
      w.chips += add;
      w.won = (w.won ?? 0) + add;
    }
    taken = level;
  }

  const won = t.seats.filter((s) => (s.won ?? 0) > 0);
  for (const w of won) {
    t.log.push(contenders.length > 1
      ? `${w.name} が ${w.handName} で ${w.won} 獲得`
      : `${w.name} が ${w.won} 獲得(みんな降りた)`);
  }
  t.street = 'done';
}

// ---- AI: モンテカルロで勝率を出して、ポットオッズと比べて決める ----
/** この席の勝率(0..1)。残りの札から相手の手と場札を何度も配って数える */
export function equity(t: Table, s: Seat, trials = 240): number {
  const known = [...s.hole, ...t.board];
  const opponents = live(t).length - 1;
  if (opponents <= 0) return 1;
  const deck = freshDeck().filter((c) => !known.some((k) => k.rank === c.rank && k.suit === c.suit));
  const need = 5 - t.board.length;
  const rng = { seed: t.seed ^ (s.id.length * 2654435761), cursor: t.cursor + t.dealt };
  let win = 0;
  for (let n = 0; n < trials; n++) {
    const pool = deck.slice();
    for (let i = pool.length - 1; i > 0; i--) { // 使う分だけ引く(部分シャッフル)
      const j = Math.floor(next(rng) * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      if (pool.length - i > need + opponents * 2) break;
    }
    let at = pool.length - 1;
    const board = [...t.board];
    for (let i = 0; i < need; i++) board.push(pool[at--]);
    const mine = evaluate([...s.hole, ...board]);
    let best = 0; // 1 = 誰かが上、0.5 = 分け合い
    for (let o = 0; o < opponents; o++) {
      const theirs = evaluate([pool[at--], pool[at--], ...board]);
      const d = compare(theirs, mine);
      if (d > 0) { best = 1; break; }
      if (d === 0) best = Math.max(best, 0.5);
    }
    win += best === 1 ? 0 : best === 0.5 ? 0.5 : 1;
  }
  return win / trials;
}

/** AI の一手。style が高いほど、勝率が微妙でも乗る・上げる */
export function decide(t: Table): { move: Move; amount: number; equity: number } {
  const s = t.seats[t.toAct];
  const need = toCall(t, s);
  const pot = potOf(t);
  const eq = equity(t, s);
  const odds = need === 0 ? 0 : need / (pot + need);
  const rng = { seed: t.seed ^ 0x5bf03635, cursor: t.cursor + t.hands * 31 + t.board.length };
  const noise = (next(rng) - 0.5) * 0.08;          // 毎回きっちり同じ打ち方にはしない
  const strength = eq + noise + (s.style - 0.5) * 0.10;

  if (need === 0) {
    // 誰も賭けていない: 強ければ賭ける。弱くても style が高いとたまにブラフ
    const bluff = next(rng) < s.style * 0.18;
    if (strength > 0.62 || bluff) {
      const size = Math.max(t.blind, Math.floor(pot * (0.45 + s.style * 0.35)));
      return { move: 'raise', amount: Math.min(t.bet + Math.max(size, t.minRaise), s.chips + s.committed), equity: eq };
    }
    return { move: 'check', amount: 0, equity: eq };
  }
  if (strength < odds - 0.04) return { move: 'fold', amount: 0, equity: eq };
  if (strength > 0.78 && s.chips > 0) {
    const size = Math.floor(pot * (0.6 + s.style * 0.5));
    const target = Math.min(t.bet + Math.max(size, t.minRaise), s.chips + s.committed);
    if (target > t.bet) return { move: 'raise', amount: target, equity: eq };
  }
  return { move: 'call', amount: need, equity: eq };
}

/** 今の場を声で読み上げる文。人間の伏せ札は見せるが、AI の伏せ札はショーダウンまで隠す */
export function describe(t: Table, meId: string): string {
  const me = t.seats.find((s) => s.id === meId);
  if (!me) return '席が見つからないよ';
  if (t.street === 'done') {
    const rows = t.seats.map((s) => `${s.name} ${s.chips}`).join(' / ');
    return `${t.log.slice(-2).join('。')}。チップは ${rows}。`;
  }
  const board = t.board.length > 0 ? `場は ${handText(t.board)}。` : '';
  const need = toCall(t, me);
  const you = `あなたの手は ${handText(me.hole)}。`;
  const turn = t.seats[t.toAct]?.id === meId
    ? (need > 0 ? `${need} 払えばコール。降りる? 乗る? 上げる?` : 'チェックでいい? 賭ける?')
    : `いまは ${t.seats[t.toAct]?.name} の番。`;
  return `${board}${you}ポットは ${potOf(t)}。${turn}`;
}
