// ブラックジャックの純ロジック(I/O なし。test/check-blackjack.mjs から直接叩いて検査する)。
//
// なぜサーバで持つか: カードを配るのも勝敗を決めるのも LLM にやらせると「ズルしていない」を
// 証明できない。ここは決定的なコードで持ち、乱数は seed 付きにして seed を記録に残す。
// 同じ seed から同じ札順が再現できる = 後から検証できる。
//
// ハウスルール(声で聞かれたらこのまま答えられるように、ここに 1 か所だけ書く):
//   6 デッキ / 残り 25% で再シャッフル / ブラックジャックは 1.5 倍 /
//   ディーラーはソフト 17 でも引く(H17)/ ダブルは最初の 2 枚のみ /
//   スプリット・保険・サレンダーは無し

export type Card = { rank: number; suit: number }; // rank 1=A..13=K, suit 0..3
export type Phase = 'betting' | 'player' | 'done';
export type Result = 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | 'surrender';

export type Game = {
  seed: number;
  cursor: number;     // seed から何回乱数を引いたか(再現用)
  shoe: Card[];
  dealt: number;      // シューから配った枚数
  chips: number;
  bet: number;
  player: Card[];
  dealer: Card[];
  phase: Phase;
  doubled: boolean;
  result?: Result;
  payout?: number;    // 収支(賭け金を含む増減)
  hands: number;
  wins: number;
  losses: number;
  pushes: number;
  best: number;       // 一番増えた時のチップ
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const DECKS = 6;
const RESHUFFLE_AT = 0.75; // 75% 配ったら次の手の前に組み直す
export const MIN_BET = 10;

// Math.random を使わないのは「同じ seed で同じ札順」を作れるようにするため
function next(g: Game): number {
  g.cursor++;
  return mix(g.seed, g.cursor);
}

// splitmix32 の仕上げ。近い seed(999 と 1000)でも別の並びになるまで混ぜる。
// 素朴な xorshift だと小さい seed の違いが上位ビットに届かず、山が同じになる
export function mix(seed: number, cursor: number): number {
  let x = (seed ^ Math.imul(cursor, 0x9e3779b9)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 0x1_0000_0000;
}

function buildShoe(g: Game): void {
  const shoe: Card[] = [];
  for (let d = 0; d < DECKS; d++) {
    for (let suit = 0; suit < 4; suit++) {
      for (let rank = 1; rank <= 13; rank++) shoe.push({ rank, suit });
    }
  }
  for (let i = shoe.length - 1; i > 0; i--) { // Fisher-Yates(seed 付き)
    const j = Math.floor(next(g) * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  g.shoe = shoe;
  g.dealt = 0;
}

export function newGame(seed: number, chips = 1000): Game {
  const g: Game = {
    seed: seed | 0, cursor: 0, shoe: [], dealt: 0, chips, bet: 0,
    player: [], dealer: [], phase: 'betting', doubled: false,
    hands: 0, wins: 0, losses: 0, pushes: 0, best: chips,
  };
  buildShoe(g);
  return g;
}

function draw(g: Game): Card {
  if (g.dealt >= g.shoe.length) buildShoe(g); // 保険(通常は手の前に組み直す)
  return g.shoe[g.dealt++];
}

export function cardName(c: Card): string { return SUITS[c.suit] + RANKS[c.rank]; }
export function handText(cards: Card[]): string { return cards.map(cardName).join(' '); }

// A を 11 で数えられるだけ数える。soft = A を 11 として使っている(引いても即バーストしない)
export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 1) { aces++; total += 11; } else total += Math.min(c.rank, 10);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) { total -= 10; aces--; soft = aces > 0; }
  return { total, soft };
}

export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** 賭けて 1 手はじめる。エラー文はそのまま声にできる日本語で返す */
export function startHand(g: Game, bet: number): { ok: true } | { ok: false; error: string } {
  if (g.phase === 'player') return { ok: false, error: 'まだ手の途中だよ。引くか勝負か決めて' };
  if (g.chips < MIN_BET) return { ok: false, error: `チップが足りないよ。「補充して」って言えば ${1000} 枚足すよ` };
  const amount = Math.max(MIN_BET, Math.min(Math.floor(bet) || MIN_BET, g.chips));
  if (g.dealt > g.shoe.length * RESHUFFLE_AT) buildShoe(g); // 手の途中では組み直さない
  g.bet = amount;
  g.chips -= amount;
  g.player = [draw(g), draw(g)];
  g.dealer = [draw(g), draw(g)];
  g.phase = 'player';
  g.doubled = false;
  g.result = undefined;
  g.payout = undefined;
  g.hands++;
  if (isBlackjack(g.player) || isBlackjack(g.dealer)) finish(g); // 両者いずれかが 21 なら即決着
  return { ok: true };
}

export function hit(g: Game): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'player') return { ok: false, error: 'いまは引けないよ。賭けるところから' };
  g.player.push(draw(g));
  if (handValue(g.player).total > 21) finish(g);
  return { ok: true };
}

export function stand(g: Game): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'player') return { ok: false, error: 'いまは勝負できないよ' };
  finish(g);
  return { ok: true };
}

/** ダブルダウン: 賭け金を倍にして 1 枚だけ引いて終わり */
export function double(g: Game): { ok: true } | { ok: false; error: string } {
  if (g.phase !== 'player') return { ok: false, error: 'いまはダブルできないよ' };
  if (g.player.length !== 2) return { ok: false, error: 'ダブルは最初の 2 枚の時だけだよ' };
  if (g.chips < g.bet) return { ok: false, error: 'チップが足りないからダブルはできないよ' };
  g.chips -= g.bet;
  g.bet *= 2;
  g.doubled = true;
  g.player.push(draw(g));
  finish(g);
  return { ok: true };
}

// ディーラーの手番と精算。ディーラーはソフト 17 でも引く(H17)
function finish(g: Game): void {
  const player = handValue(g.player);
  const playerBJ = isBlackjack(g.player);
  const dealerBJ = isBlackjack(g.dealer);

  if (player.total > 21) {
    g.result = 'bust';
  } else if (playerBJ && !dealerBJ) {
    g.result = 'blackjack';
  } else if (dealerBJ && !playerBJ) {
    g.result = 'lose';
  } else if (playerBJ && dealerBJ) {
    g.result = 'push';
  } else {
    let d = handValue(g.dealer);
    while (d.total < 17 || (d.total === 17 && d.soft)) {
      g.dealer.push(draw(g));
      d = handValue(g.dealer);
    }
    if (d.total > 21) g.result = 'win';
    else if (d.total > player.total) g.result = 'lose';
    else if (d.total < player.total) g.result = 'win';
    else g.result = 'push';
  }

  const back = { blackjack: g.bet * 2.5, win: g.bet * 2, push: g.bet, lose: 0, bust: 0, surrender: g.bet / 2 }[g.result];
  g.chips += Math.floor(back);
  g.payout = Math.floor(back) - g.bet;
  if (g.result === 'blackjack' || g.result === 'win') g.wins++;
  else if (g.result === 'push') g.pushes++;
  else g.losses++;
  g.best = Math.max(g.best, g.chips);
  g.phase = 'done';
}

export function addChips(g: Game, amount = 1000): void {
  g.chips += amount;
  g.best = Math.max(g.best, g.chips);
}

/** 今の場を声で読み上げる文。手の途中ではディーラーの 2 枚目は伏せる */
export function describe(g: Game): string {
  if (g.phase === 'betting') return `チップは ${g.chips} 枚。いくら賭ける?`;
  const p = handValue(g.player);
  if (g.phase === 'player') {
    return `あなたは ${handText(g.player)} で ${p.total}${p.soft ? '(ソフト)' : ''}。`
      + `ディーラーは ${cardName(g.dealer[0])} と伏せ札。引く? 勝負する?`;
  }
  const d = handValue(g.dealer);
  const line = `あなた ${handText(g.player)} で ${p.total}、ディーラー ${handText(g.dealer)} で ${d.total}。`;
  const verdict = {
    blackjack: `ブラックジャック! ${g.payout} 枚の勝ち。`,
    win: `あなたの勝ち。${g.payout} 枚もらってね。`,
    push: '引き分け。賭け金は戻すね。',
    lose: `わたしの勝ち。${-(g.payout ?? 0)} 枚もらうね。`,
    bust: `${p.total} でバースト。${-(g.payout ?? 0)} 枚もらうね。`,
    surrender: '降りたね。半分返すよ。',
  }[g.result ?? 'push'];
  return `${line}${verdict}チップは ${g.chips} 枚。`;
}

/** 記録用の短い 1 行(履歴に積む) */
export function summary(g: Game): string {
  const p = handValue(g.player).total;
  const d = handValue(g.dealer).total;
  const mark = { blackjack: 'BJ', win: '勝', push: '分', lose: '負', bust: 'バ', surrender: '降' }[g.result ?? 'push'];
  return `${mark} ${p} vs ${d} ${(g.payout ?? 0) >= 0 ? '+' : ''}${g.payout}`;
}
