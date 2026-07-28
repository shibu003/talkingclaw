// 声で遊ぶための層。ブラックジャックとポーカーの「言葉 → 手」の翻訳と、
// 1 手ぶんの進行をまとめる(I/O なし。test/check-casino.mjs から直接叩いて検査する)。
//
// なぜ LLM を通さないか: 「引く」と言ってから返事まで数秒かかるゲームは遊べない。
// ここで即座に判定して返し、クロエは審判ではなく実況に回る。
import * as bj from './blackjack.ts';
import * as pk from './poker.ts';
import * as mj from './mahjong.ts';
import * as mg from './mahjongGame.ts';

export type Session =
  | { kind: 'blackjack'; game: bj.Game }
  | { kind: 'poker'; table: pk.Table; meId: string }
  | { kind: 'mahjong'; game: mg.Game; meId: string };

export type Cmd =
  | { type: 'start'; game: 'blackjack' | 'poker' | 'mahjong' }
  | { type: 'quit' }
  | { type: 'hit' } | { type: 'stand' } | { type: 'double' }
  | { type: 'fold' } | { type: 'check' } | { type: 'call' } | { type: 'raise'; amount: number } | { type: 'allin' }
  | { type: 'deal'; bet: number }
  | { type: 'discard'; tile: mj.Tile; riichi: boolean }
  | { type: 'tsumo' } | { type: 'ron' } | { type: 'skip' }
  | { type: 'refill' }
  | { type: 'status' }
  | { type: 'rules' };

const num = (t: string): number => {
  const m = t.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
};

// >>> parseCommand(pure: test/check-casino.mjs から取り出して単体で検査する)
// 会話に紛れて誤爆しないよう、遊んでいない時は「ゲーム名」を言った時だけ拾う。
// 遊んでいる間は短い言い切り(20 字以内)だけを手として受ける。
export function parseCommand(text: string, session: Session | null): Cmd | null {
  const t = (text || '').replace(/\s|[、。!?！?]/g, '');
  const has = (...w: string[]): boolean => w.some((x) => t.includes(x));

  if (!session) {
    if (has('ポーカー', 'ぽーかー', 'ホールデム')) return { type: 'start', game: 'poker' };
    if (has('ブラックジャック', 'ぶらっくじゃっく', 'ジャックポット21')) return { type: 'start', game: 'blackjack' };
    if (has('麻雀', 'マージャン', 'まーじゃん', 'リーチ麻雀')) return { type: 'start', game: 'mahjong' };
    return null;
  }

  if (t.length > 20) return null; // 長い発話は普通の会話(ゲーム中でも話しかけられる)
  if (has('ゲームやめ', 'もうやめ', 'おしまい', '終わりにし', '抜ける', '席を立')) return { type: 'quit' };
  if (has('ルール', 'どういう決まり', '配当')) return { type: 'rules' };
  if (has('補充', 'チップちょうだい', 'チップ足し', 'お金貸し')) return { type: 'refill' };
  if (has('いまいくら', '今いくら', 'チップは', '成績', '状況', 'どうなって', '手札')) return { type: 'status' };

  if (session.kind === 'mahjong') {
    if (has('ツモ', 'つも')) return { type: 'tsumo' };
    if (has('ロン', 'ろん')) return { type: 'ron' };
    if (has('スルー', '見送', 'いらない', 'パス')) return { type: 'skip' };
    if (has('次の局', '次いく', '続け', '配って', '次')) return { type: 'deal', bet: 0 };
    const riichi = has('リーチ', 'りーち', '立直');
    // 牌の名前は会話にも出るので、「切る」等の動作語があるか、牌だけを短く言った時にだけ手にする
    const acting = riichi || has('切', 'きる', 'きって', '捨て', 'すて', '打つ', 'うつ');
    if (!acting && t.length > 8) return null;
    const tile = mj.parseSpokenTile(t);
    if (tile !== null) return { type: 'discard', tile, riichi };
    if (riichi) return { type: 'discard', tile: -1, riichi: true }; // 牌を言わない立直 = ツモ切り立直
    return null;
  }

  if (session.kind === 'blackjack') {
    if (has('引く', 'ひく', 'ヒット', 'もう一枚', 'もういちまい', 'ちょうだい', 'カード')) return { type: 'hit' };
    if (has('勝負', 'スタンド', 'ステイ', '止ま', 'とま', '十分', 'じゅうぶん', 'これでいい', 'もういい')) return { type: 'stand' };
    if (has('ダブル', '倍にし', '倍で')) return { type: 'double' };
    if (has('賭け', 'かけ', 'ベット', '配って', 'くばって', 'next', '次')) return { type: 'deal', bet: num(t) };
    return null;
  }

  if (has('降り', 'おり', 'フォールド', 'やめとく', '捨て')) return { type: 'fold' };
  if (has('チェック', 'ちぇっく', 'パス')) return { type: 'check' };
  if (has('オールイン', '全部', 'ぜんぶ', '全額')) return { type: 'allin' };
  if (has('レイズ', '上げ', 'あげ')) return { type: 'raise', amount: num(t) };
  if (has('コール', 'こーる', '乗る', 'のる', 'ついて', '払う')) return { type: 'call' };
  if (has('配って', 'くばって', '次の手', '次', 'もう一回', 'もういっかい')) return { type: 'deal', bet: 0 };
  return null;
}
// <<< parseCommand

export type Reply = { say: string[]; session: Session | null; hand?: string };

// キャラごとの打ち方。強気なほど、勝率が微妙でも乗るしブラフも打つ
const STYLE: Record<string, number> = { クロエ: 0.72, コハク: 0.3, まい: 0.55, 作業係: 0.45 };
export function styleOf(name: string): number { return STYLE[name] ?? 0.5; }

const RULES_BJ = 'ブラックジャックのルールね。6 デッキで、わたしは 17 以上で止まるけどソフト 17 は引くよ。'
  + 'ブラックジャックは 1.5 倍。ダブルは最初の 2 枚だけ。スプリットと保険は無しね。';
const RULES_PK = 'テキサスホールデムだよ。ブラインドは 5 と 10、上限なし。'
  + '降りる・チェック・コール・レイズ・オールインで言ってね。手札は 2 枚、場に 5 枚出るよ。';
const RULES_MJ = '東風戦の 4 人麻雀。25000 点持ちで、赤ドラは無し。鳴きは入れてないから門前だけね。'
  + '「一萬切る」みたいに切る牌を言ってね。聴牌したら「リーチ」、和了れる時は「ツモ」か「ロン」。'
  + '振聴あり、流局は聴牌してる人で分けるよ。';

/** ゲームを始める。相手(AI)の名前は部屋にいる人から渡してもらう */
export function start(game: 'blackjack' | 'poker' | 'mahjong', seed: number, opponents: { id: string; name: string; style?: number }[]): Reply {
  if (game === 'blackjack') {
    const g = bj.newGame(seed);
    return {
      say: ['ブラックジャックね、いいよ。わたしがディーラーやる。', `チップは ${g.chips} 枚から。いくら賭ける?「100 賭ける」って言ってね。`],
      session: { kind: 'blackjack', game: g },
    };
  }
  const seats = [
    { id: 'you', name: 'あなた', human: true },
    ...opponents.slice(0, 3).map((o) => ({ id: o.id, name: o.name, human: false, style: o.style ?? 0.5 })),
  ];
  if (game === 'mahjong') {
    const players = [
      { id: 'you', name: 'あなた', human: true },
      ...opponents.slice(0, 3).map((o) => ({ id: o.id, name: o.name, human: false, style: o.style ?? 0.5 })),
    ];
    while (players.length < 4) players.push({ id: `bot${players.length}`, name: `NPC${players.length}`, human: false, style: 0.5 });
    const g = mg.newGame(seed, players);
    const names = players.filter((p) => !p.human).map((p) => p.name).join('と');
    return {
      say: [`麻雀やろう。${names}と 4 人ね。`, '東風戦、25000 点持ち。鳴きは無しで門前だけだよ。', '「配って」で始めるね。'],
      session: { kind: 'mahjong', game: g, meId: 'you' },
    };
  }
  const table = pk.newTable(seed, seats, 1000, 10);
  const names = seats.filter((s) => !s.human).map((s) => s.name).join('と');
  return {
    say: [`ポーカーやろう。${names}も入るね。`, 'ひとり 1000 枚から。「配って」で始めるよ。'],
    session: { kind: 'poker', table, meId: 'you' },
  };
}

/** 1 コマンドぶん進める。say はそのまま順に読み上げる文 */
export function apply(session: Session, cmd: Cmd): Reply {
  if (cmd.type === 'quit') {
    const tail = session.kind === 'blackjack' ? `チップは ${session.game.chips} 枚`
      : session.kind === 'poker' ? `チップは ${session.table.seats.find((s) => s.human)?.chips ?? 0} 枚`
        : `点数は ${session.game.players.find((p) => p.human)?.points ?? 0} 点`;
    return { say: [`おつかれさま。${tail}で終わりだね。`], session: null };
  }
  if (cmd.type === 'rules') {
    return { say: [{ blackjack: RULES_BJ, poker: RULES_PK, mahjong: RULES_MJ }[session.kind]], session };
  }
  if (session.kind === 'mahjong') return applyMahjong(session, cmd);
  return session.kind === 'blackjack' ? applyBlackjack(session, cmd) : applyPoker(session, cmd);
}

function applyBlackjack(session: Session & { kind: 'blackjack' }, cmd: Cmd): Reply {
  const g = session.game;
  const done = (extra: string[] = []): Reply => ({
    say: [...extra, bj.describe(g), ...(g.phase === 'done' ? ['次いく?'] : [])],
    session,
    hand: g.phase === 'betting' ? undefined : `あなた ${bj.handText(g.player)} / ディーラー ${g.phase === 'done' ? bj.handText(g.dealer) : `${bj.cardName(g.dealer[0])} ■`}`,
  });

  if (cmd.type === 'status') {
    return { say: [`チップ ${g.chips} 枚。${g.hands} 手で ${g.wins} 勝 ${g.losses} 敗 ${g.pushes} 分。一番増えた時で ${g.best} 枚。`], session };
  }
  if (cmd.type === 'refill') { bj.addChips(g, 1000); return { say: [`はい、1000 枚足したよ。いまは ${g.chips} 枚。`], session }; }
  if (cmd.type === 'deal') {
    const bet = cmd.bet > 0 ? cmd.bet : Math.max(bj.MIN_BET, Math.min(100, g.chips));
    const r = bj.startHand(g, bet);
    if (!r.ok) return { say: [r.error], session };
    return done([`${g.bet} 枚だね。配るよ。`]);
  }
  const move = { hit: bj.hit, stand: bj.stand, double: bj.double }[cmd.type as 'hit' | 'stand' | 'double'];
  if (!move) return { say: ['それはブラックジャックでは使えないよ。引く? 勝負する?'], session };
  const r = move(g);
  if (!r.ok) return { say: [r.error], session };
  return done();
}

function applyPoker(session: Session & { kind: 'poker' }, cmd: Cmd): Reply {
  const t = session.table;
  const me = t.seats.find((s) => s.id === session.meId)!;
  const board = (): string => `${t.board.length > 0 ? `場 ${pk.handText(t.board)} / ` : ''}あなた ${pk.handText(me.hole)}`;

  if (cmd.type === 'status') {
    const rows = t.seats.map((s) => `${s.name} ${s.chips}`).join('、');
    return { say: [`${pk.describe(t, session.meId)}`, `チップは ${rows}。`], session, hand: board() };
  }
  if (cmd.type === 'refill') {
    me.chips += 1000;
    t.refilled += 1000;
    return { say: [`はい、1000 枚足したよ。いまは ${me.chips} 枚。`], session };
  }
  if (cmd.type === 'deal') {
    const r = pk.startHand(t);
    if (!r.ok) return { say: [r.error], session };
    // 手札は describe が言うので、ここでは繰り返さない(同じ文を二度読み上げない)
    return { ...runAi(t, session, [...t.log]), hand: board() };
  }
  if (t.street === 'done') return { say: ['いまは手の外だよ。「配って」で次いこう。'], session };

  const map: Record<string, pk.Move> = { fold: 'fold', check: 'check', call: 'call', raise: 'raise', allin: 'allin' };
  const move = map[cmd.type];
  if (!move) return { say: ['それはポーカーでは使えないよ。降りる? コール? レイズ?'], session };
  const amount = cmd.type === 'raise'
    ? (cmd.amount > 0 ? cmd.amount : t.bet + Math.max(t.minRaise, Math.floor(pk.potOf(t) / 2)))
    : 0;
  const r = pk.act(t, session.meId, move, amount);
  if (!r.ok) return { say: [r.error], session };
  const before = t.log.length;
  return { ...runAi(t, session, t.log.slice(before - 1)), hand: board() };
}

function applyMahjong(session: Session & { kind: 'mahjong' }, cmd: Cmd): Reply {
  const g = session.game;
  const seat = g.players.findIndex((p) => p.id === session.meId);
  const me = g.players[seat];

  if (cmd.type === 'status') {
    return { say: [mg.describe(g, session.meId), `点数は ${g.players.map((p) => `${p.name} ${p.points}`).join('、')}。`],
      session, hand: mg.handDisplay(g, session.meId) };
  }
  if (cmd.type === 'refill') return { say: ['麻雀では点棒は足せないよ。飛んだら終わりね。'], session };
  if (cmd.type === 'deal') {
    if (g.phase === 'over') return { say: [g.log[g.log.length - 1] ?? '終局してるよ。「やめる」で席を立とう。'], session };
    const r = mg.startHand(g);
    if (!r.ok) return { say: [r.error], session };
    return runMahjongAi(g, session, [...g.log]);
  }
  if (cmd.type === 'tsumo') {
    const r = mg.win(g, seat, true);
    if (!r.ok) return { say: [r.error], session };
    return { say: [...g.log.slice(-2), '次いく?'], session, hand: mg.handDisplay(g, session.meId) };
  }
  if (cmd.type === 'ron') {
    const r = mg.win(g, seat, false);
    if (!r.ok) return { say: [r.error], session };
    return { say: [...g.log.slice(-2), '次いく?'], session, hand: mg.handDisplay(g, session.meId) };
  }
  if (cmd.type === 'skip') {
    if (g.phase !== 'ron') return { say: ['いまは見送る場面じゃないよ'], session };
    const before = g.log.length;
    if (!mg.pass(g).ok) return { say: ['進められなかった'], session };
    return runMahjongAi(g, session, g.log.slice(before));
  }
  if (cmd.type === 'discard') {
    if (g.phase !== 'discard' || g.turn !== seat) return { say: ['いまは切る番じゃないよ'], session };
    const tile = cmd.tile >= 0 ? cmd.tile : (me.drawn ?? -1);
    if (tile < 0) return { say: ['どれを切るか言ってね'], session };
    const before = g.log.length;
    const r = mg.discard(g, seat, tile, cmd.riichi);
    if (!r.ok) return { say: [r.error], session, hand: mg.handDisplay(g, session.meId) };
    return runMahjongAi(g, session, [`${mj.tileName(tile)} を切ったよ。`, ...g.log.slice(before)]);
  }
  return { say: ['それは麻雀では使えないよ。切る牌を言うか、ツモ・ロン・リーチだよ。'], session };
}

// 自分の番が来るまで他家に打たせる。ロンできる場面では止めて聞く
function runMahjongAi(g: mg.Game, session: Session & { kind: 'mahjong' }, say: string[]): Reply {
  const seat = g.players.findIndex((p) => p.id === session.meId);
  let guard = 0;
  while (guard++ < 200) {
    if (g.phase === 'done' || g.phase === 'over') {
      say.push(...g.log.slice(-2));
      say.push(g.phase === 'over' ? '終局。もう一回やる?' : '次いく?');
      break;
    }
    if (g.phase === 'ron') {
      // 自分がロンできるなら止めて聞く(勝手に和了らない)
      if (mg.canRon(g, seat)) {
        const t = g.lastDiscard!;
        say.push(`${g.players[t.from].name} が ${mj.tileName(t.tile)} を切ったよ。ロンできる! ロンする?`);
        break;
      }
      let ronned = false;
      for (let i = 1; i <= 3; i++) {
        const s = (g.lastDiscard!.from + i) % 4;
        if (s !== seat && mg.canRon(g, s)) { const before = g.log.length; mg.win(g, s, false); say.push(...g.log.slice(before)); ronned = true; break; }
      }
      if (ronned) continue;
      const before = g.log.length;
      if (!mg.pass(g).ok) break;
      say.push(...g.log.slice(before));
      continue;
    }
    if (g.phase === 'discard') {
      if (g.turn === seat) {
        const t = mg.canTsumo(g, seat);
        if (t) say.push(`${mj.tileName(g.players[seat].drawn!)} をツモった。和了れるよ! ツモする?`);
        say.push(mg.describe(g, session.meId));
        break;
      }
      const s = g.turn;
      const t = mg.canTsumo(g, s);
      if (t) { const before = g.log.length; mg.win(g, s, true); say.push(...g.log.slice(before)); continue; }
      const { tile, riichi } = mg.chooseDiscard(g, s);
      const before = g.log.length;
      if (!mg.discard(g, s, tile, riichi).ok) break;
      say.push(...g.log.slice(before));
      continue;
    }
    break;
  }
  return { say: dedupe(say), session, hand: mg.handDisplay(g, session.meId) };
}

// 人間の番が来るまで AI に打たせる。1 手ごとの出来事をそのまま読み上げ文にする
function runAi(t: pk.Table, session: Session & { kind: 'poker' }, say: string[]): Reply {
  let guard = 0;
  while (t.street !== 'done' && t.seats[t.toAct]?.id !== session.meId && guard++ < 40) {
    const before = t.log.length;
    const d = pk.decide(t);
    const r = pk.act(t, t.seats[t.toAct].id, d.move, d.amount);
    if (!r.ok) break; // 反則は起こらない想定。起きたら手を止めて場を読ませる
    say.push(...t.log.slice(before));
  }
  if (t.street === 'done') {
    say.push(...t.log.slice(-3).filter((l) => l.includes('獲得')));
    const me = t.seats.find((s) => s.id === session.meId)!;
    say.push(`あなたのチップは ${me.chips} 枚。次いく?`);
  } else {
    say.push(pk.describe(t, session.meId));
  }
  return { say: dedupe(say), session };
}

// 同じ行を二重に読まない(log の切り出しが重なることがある)
function dedupe(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) if (l && l !== out[out.length - 1]) out.push(l);
  return out;
}
