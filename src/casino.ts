// 声で遊ぶための層。ブラックジャックとポーカーの「言葉 → 手」の翻訳と、
// 1 手ぶんの進行をまとめる(I/O なし。test/check-casino.mjs から直接叩いて検査する)。
//
// なぜ LLM を通さないか: 「引く」と言ってから返事まで数秒かかるゲームは遊べない。
// ここで即座に判定して返し、クロエは審判ではなく実況に回る。
import * as bj from './blackjack.ts';
import * as pk from './poker.ts';

export type Session =
  | { kind: 'blackjack'; game: bj.Game }
  | { kind: 'poker'; table: pk.Table; meId: string };

export type Cmd =
  | { type: 'start'; game: 'blackjack' | 'poker' }
  | { type: 'quit' }
  | { type: 'hit' } | { type: 'stand' } | { type: 'double' }
  | { type: 'fold' } | { type: 'check' } | { type: 'call' } | { type: 'raise'; amount: number } | { type: 'allin' }
  | { type: 'deal'; bet: number }
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
    return null;
  }

  if (t.length > 20) return null; // 長い発話は普通の会話(ゲーム中でも話しかけられる)
  if (has('ゲームやめ', 'もうやめ', 'おしまい', '終わりにし', '抜ける', '席を立')) return { type: 'quit' };
  if (has('ルール', 'どういう決まり', '配当')) return { type: 'rules' };
  if (has('補充', 'チップちょうだい', 'チップ足し', 'お金貸し')) return { type: 'refill' };
  if (has('いまいくら', '今いくら', 'チップは', '成績', '状況', 'どうなって', '手札')) return { type: 'status' };

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

/** ゲームを始める。相手(AI)の名前は部屋にいる人から渡してもらう */
export function start(game: 'blackjack' | 'poker', seed: number, opponents: { id: string; name: string; style?: number }[]): Reply {
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
    const chips = session.kind === 'blackjack' ? session.game.chips : session.table.seats.find((s) => s.human)?.chips ?? 0;
    return { say: [`おつかれさま。チップは ${chips} 枚で終わりだね。`], session: null };
  }
  if (cmd.type === 'rules') {
    return { say: [session.kind === 'blackjack' ? RULES_BJ : RULES_PK], session };
  }
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
