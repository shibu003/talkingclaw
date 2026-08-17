// 声で遊ぶための層。ブラックジャックとポーカーの「言葉 → 手」の翻訳と、
// 1 手ぶんの進行をまとめる(I/O なし。test/check-casino.mjs から直接叩いて検査する)。
//
// なぜ LLM を通さないか: 「引く」と言ってから返事まで数秒かかるゲームは遊べない。
// ここで即座に判定して返し、クロエは審判ではなく実況に回る。
import * as bj from './blackjack.ts';
import * as pk from './poker.ts';
import * as mj from './mahjong.ts';
import * as mg from './mahjongGame.ts';

// PBI-037: **誰の手か（actor）は session の状態ではなく 1 手ごとの引数**。
// `meId` は「人間の席が 1 つだった頃」の既定値として残す（呼び側が actor を渡さない時だけ使う）。
export type Human = { id: string; name: string };
export type Session =
  | { kind: 'blackjack'; game: bj.Game; humans?: Human[] }
  | { kind: 'poker'; table: pk.Table; meId: string; humans?: Human[] }
  | { kind: 'mahjong'; game: mg.Game; meId: string; humans?: Human[] };

export type Cmd =
  | { type: 'start'; game: 'blackjack' | 'poker' | 'mahjong'; blind?: number }
  | { type: 'quit' }
  | { type: 'hit' } | { type: 'stand' } | { type: 'double' }
  | { type: 'fold' } | { type: 'check' } | { type: 'call' } | { type: 'raise'; amount: number } | { type: 'allin' }
  | { type: 'deal'; bet: number }
  | { type: 'discard'; tile: mj.Tile; riichi: boolean }
  | { type: 'tsumo' } | { type: 'ron' } | { type: 'skip' }
  | { type: 'pon' } | { type: 'kan' } | { type: 'chi'; low: number }
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
    if (has('ポーカー', 'ぽーかー', 'ホールデム')) {
      const m = t.match(/(\d+)/);   // 「レート 50 でポーカー」のように言える
      return { type: 'start', game: 'poker', blind: m ? Number(m[1]) : undefined };
    }
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
    if (has('ポン', 'ぽん')) return { type: 'pon' };
    if (has('カン', 'かん')) return { type: 'kan' };
    if (has('チー', 'ちー')) {
      const t2 = mj.parseSpokenTile(t);   // 「チー三萬」のように取り方を言えたらそれを使う
      return { type: 'chi', low: t2 ?? -1 };
    }
    if (has('スルー', '見送', 'いらない', 'パス', 'なし')) return { type: 'skip' };
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

// say = みんなに聞こえる進行(記録に残る) / show = あなただけに見せる情報(読み上げず記録もしない)
// 手牌や手札を say に入れると、進行役の発言としてログに残り、対戦相手の文脈に戻ってしまう
export type Reply = { say: string[]; show?: string[]; session: Session | null; hand?: string };

// キャラごとの打ち方。強気なほど、勝率が微妙でも乗るしブラフも打つ
const STYLE: Record<string, number> = { クロエ: 0.72, コハク: 0.3, まい: 0.55, 作業係: 0.45 };

// PBI-034: **人数が足りない時に座る面子**。麻雀は 4 人、ポーカーは 3 人以上でないと成立しない —— 
// 1 人しか居ない時に卓が立つことがこの部屋の存在理由なので、空席は `NPC2` ではなく
// **名前と打ち癖を持ったキャラ**で埋める。**推論は一切使わない**(打ち筋は規則)。
const HOUSE: { id: string; name: string; style: number }[] = [
  { id: 'house-tsubaki', name: 'ツバキ', style: 0.78 },   // 攻める。危険牌でも押す
  { id: 'house-nagi', name: 'ナギ', style: 0.34 },        // 降りる。鳴きも慎重
  { id: 'house-rin', name: 'リン', style: 0.55 },         // 素直に手を進める
  { id: 'house-kaede', name: 'カエデ', style: 0.66 },
  { id: 'house-sumi', name: 'スミ', style: 0.42 },
];

export function styleOf(name: string): number {
  return STYLE[name] ?? HOUSE.find((h) => h.name === name)?.style ?? 0.5;
}

/**
 * 卓に必要な人数まで席を埋める。**居る人が優先**、足りないぶんだけ面子から座る。
 * 純関数（同じ入力 → 同じ席順）。名前は重ならない。
 */
export function fillSeats(
  opponents: { id: string; name: string; style?: number }[],
  need: number,
): { id: string; name: string; style: number }[] {
  const seats = opponents.slice(0, need).map((o) => ({ id: o.id, name: o.name, style: o.style ?? styleOf(o.name) }));
  const taken = new Set(seats.map((s) => s.name));
  for (const h of HOUSE) {
    if (seats.length >= need) break;
    if (taken.has(h.name)) continue;
    seats.push({ ...h });
    taken.add(h.name);
  }
  return seats;
}

const RULES_BJ = 'ブラックジャックのルールね。6 デッキで、わたしは 17 以上で止まるけどソフト 17 は引くよ。'
  + 'ブラックジャックは 1.5 倍。ダブルは最初の 2 枚だけ。スプリットと保険は無しね。';
const RULES_PK = 'テキサスホールデムだよ。ブラインドは 5 と 10、上限なし。'
  + '降りる・チェック・コール・レイズ・オールインで言ってね。手札は 2 枚、場に 5 枚出るよ。';
const RULES_MJ = '東風戦の 4 人麻雀。25000 点持ちで、赤ドラは無し。'
  + '「一萬切る」みたいに切る牌を言ってね。聴牌したら「リーチ」、和了れる時は「ツモ」か「ロン」。'
  + '鳴きもできるよ。誰かが捨てるたびに聞くから、いる時は「ポン」「チー」「カン」、いらない時は「スルー」。'
  + 'チーは下家だけ、鳴いたら立直はできない。暗槓と加槓はまだ無し。振聴あり、流局は聴牌してる人で分けるよ。';

/** ゲームを始める。相手(AI)の名前は部屋にいる人から渡してもらう */
export function start(game: 'blackjack' | 'poker' | 'mahjong', seed: number,
  opponents: { id: string; name: string; style?: number }[], blind = 10, humans: Human[] = []): Reply {
  // PBI-037: **人間の席は 1 つとは限らない**。招いた人が居ればその人も卓に着く
  const people: Human[] = humans.length > 0 ? humans.slice(0, 4) : [{ id: 'you', name: 'あなた' }];
  const humanSeats = people.map((h) => ({ id: h.id, name: h.name, human: true }));
  if (game === 'blackjack') {
    const g = bj.newGame(seed);
    return {
      say: ['ブラックジャックね、いいよ。わたしがディーラーやる。', `チップは ${g.chips} 枚から。いくら賭ける?「100 賭ける」って言ってね。`],
      session: { kind: 'blackjack', game: g, humans: people },
    };
  }
  // PBI-034: ポーカーも 1 人では成立しない。最低 2 人(合計 3 人)まで面子が座る
  const seats = [
    ...humanSeats,
    // 最低 3 人、最大 4 人の卓にする（人間が増えたぶんだけ面子は減る）
    ...fillSeats(opponents, Math.max(3 - humanSeats.length, Math.min(opponents.length, 4 - humanSeats.length)))
      .map((o) => ({ ...o, human: false })),
  ];
  if (game === 'mahjong') {
    // PBI-034/037: 4 人に足りないぶんは**名前のある面子**が座る(1 人でも東風戦が立つ)
    const players = [
      ...humanSeats,
      ...fillSeats(opponents, Math.max(0, 4 - humanSeats.length)).map((o) => ({ ...o, human: false })),
    ];
    const g = mg.newGame(seed, players);
    const names = players.filter((p) => !p.human).map((p) => p.name).join('と');
    return {
      say: [`麻雀やろう。${names}と 4 人ね。`, '東風戦、25000 点持ち。ポン・チー・カンもありだよ。', '「配って」で始めるね。'],
      session: { kind: 'mahjong', game: g, meId: people[0].id, humans: people },
    };
  }
  const stake = Math.max(2, Math.min(Math.floor(blind) || 10, 500));
  const table = pk.newTable(seed, seats, stake * 100, stake);   // 持ち点はブラインドの 100 倍
  const names = seats.filter((s) => !s.human).map((s) => s.name).join('と');
  return {
    say: [`ポーカーやろう。${names}も入るね。`,
      `レートはブラインド ${Math.floor(stake / 2)} と ${stake}、ひとり ${stake * 100} 枚から。「配って」で始めるよ。`],
    session: { kind: 'poker', table, meId: people[0].id, humans: people },
  };
}

/**
 * PBI-038: **離席した人の代わりに 1 手だけ打つ。**
 * 打ち筋は面子と同じ（本人の代わりであって敵ではない）。**推論は使わない**。
 * 手番でない席・卓に居ない席を指定した時は何もしない（`null`）。
 */
export function autoPlay(session: Session, seatId: string): Reply | null {
  if (session.kind === 'poker') {
    const t = session.table;
    if (t.street === 'done' || t.seats[t.toAct]?.id !== seatId) return null;
    const who = t.seats[t.toAct].name;
    const before = t.log.length;
    const d = pk.decide(t);
    const r = pk.act(t, seatId, d.move, d.amount);
    if (!r.ok) return null;
    // 打った後は**次の人間の番まで**進める（1 手ずつ 60 秒待たせない）
    return runAi(t, session, [`${who}の手が止まっていたから、代わりに打っておいたよ。`, ...t.log.slice(before)], seatId);
  }
  if (session.kind === 'mahjong') {
    const g = session.game;
    const seat = g.players.findIndex((p) => p.id === seatId);
    if (seat < 0) return null;
    const who = g.players[seat].name;
    const before = g.log.length;
    if (g.phase === 'ron') {
      // 鳴き・ロンの返事待ちで止まっている。**権利が無い席でも場を進める**
      // （ここで戻らないと、誰も鳴かない場面で卓が永久に止まる）
      const calls = mg.callsFor(g, seat);
      const had = calls.ron || calls.pon || calls.kan || calls.chi.length > 0;
      if (!mg.pass(g).ok) return null;
      return runMahjongAi(g, session, [
        had ? `${who}の返事が無かったから、スルーしておいたよ。` : '返事が無かったから場を進めるね。',
        ...g.log.slice(before),
      ], seatId);
    }
    if (g.phase !== 'discard' || g.turn !== seat) return null;
    // 和了れるなら和了る。それ以外は面子と同じ選び方で 1 枚切る
    if (mg.canTsumo(g, seat)) {
      const r = mg.win(g, seat, true);
      if (r.ok) return runMahjongAi(g, session, [`${who}が止まっていたけど、ツモってたよ。`, ...g.log.slice(before)], seatId);
    }
    const pick = mg.chooseDiscard(g, seat);
    if (!mg.discard(g, seat, pick.tile, pick.riichi).ok) return null;
    return runMahjongAi(g, session, [
      `${who}の手が止まっていたから、代わりに ${mj.tileName(pick.tile)} を切っておいたよ。`,
      ...g.log.slice(before),
    ], seatId);
  }
  return null;   // ブラックジャックは席が 1 つ（誰も待っていない）
}

/**
 * PBI-043: **人の番が来るまで、AI を 1 手ずつ**進めるための 2 つ。
 * 部屋はこれを「5 秒おき」に呼ぶ —— 卓の生っぽさは間合いで決まる（一瞬で全部流れると見物になる）。
 */
export function humanTurnPending(session: Session): boolean {
  const humans = humanIds(session);
  if (session.kind === 'mahjong') {
    const g = session.game;
    if (g.phase === 'done' || g.phase === 'over' || g.phase === 'idle') return true;
    if (g.phase === 'ron') {
      return g.players.some((p, i) => {
        if (!humans.has(p.id)) return false;
        const c = mg.callsFor(g, i);
        return c.ron || c.pon || c.kan || c.chi.length > 0;
      });
    }
    return humans.has(g.players[g.turn]?.id ?? '');
  }
  if (session.kind === 'poker') {
    const t = session.table;
    return t.street === 'done' || humans.has(t.seats[t.toAct]?.id ?? '');
  }
  return true;   // ブラックジャックは 1 手で決着する（間合いは要らない）
}

/** AI を **1 手だけ** 進める。人の番 / 終局なら何もしない(null) */
export function stepOnce(session: Session): Reply | null {
  if (humanTurnPending(session)) return null;
  // ここに来た時点で「AI の番」。**進んだかどうかは say では測れない**
  // （鳴きのスルーなど、言葉を伴わない 1 手がある。実測で null を返して止まった）
  if (session.kind === 'mahjong') return runMahjongAi(session.game, session, [], undefined, 1);
  if (session.kind === 'poker') return runAi(session.table, session, [], undefined, 1);
  return null;
}

/** 1 コマンドぶん進める。say はそのまま順に読み上げる文 */
/** 卓に着いている**人間**の id。AI を進めるのは「次の人間の番」まで（PBI-037） */
export function humanIds(session: Session): Set<string> {
  const list = session.humans?.map((h) => h.id) ?? [];
  if (list.length > 0) return new Set(list);
  return new Set(['meId' in session ? session.meId : 'you']);
}

/** 1 手を誰が打ったか。渡されなければ「人間の席が 1 つ」の頃と同じ既定（'you'） */
function actorOf(session: Session, actorId?: string): string {
  if (actorId) return actorId;
  return 'meId' in session ? session.meId : 'you';
}

export function apply(session: Session, cmd: Cmd, actorId?: string, opts: { stepwise?: boolean } = {}): Reply {
  if (cmd.type === 'quit') {
    const tail = session.kind === 'blackjack' ? `チップは ${session.game.chips} 枚`
      : session.kind === 'poker' ? `チップは ${session.table.seats.find((s) => s.human)?.chips ?? 0} 枚`
        : `点数は ${session.game.players.find((p) => p.human)?.points ?? 0} 点`;
    return { say: [`おつかれさま。${tail}で終わりだね。`], session: null };
  }
  if (cmd.type === 'rules') {
    return { say: [{ blackjack: RULES_BJ, poker: RULES_PK, mahjong: RULES_MJ }[session.kind]], session };
  }
  const actor = actorOf(session, actorId);
  // PBI-043: stepwise = **人の手だけ適用して返す**。他家は部屋が 5 秒おきに 1 手ずつ進める
  const steps = opts.stepwise ? 0 : Infinity;
  if (session.kind === 'mahjong') return applyMahjong(session, cmd, actor, steps);
  return session.kind === 'blackjack' ? applyBlackjack(session, cmd) : applyPoker(session, cmd, actor, steps);
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

function applyPoker(session: Session & { kind: 'poker' }, cmd: Cmd, actor: string, steps = Infinity): Reply {
  const t = session.table;
  const me = t.seats.find((s) => s.id === actor)!;
  const board = (): string => `${t.board.length > 0 ? `場 ${pk.handText(t.board)} / ` : ''}あなた ${pk.handText(me.hole)}`;

  if (cmd.type === 'status') {
    const rows = t.seats.map((s) => `${s.name} ${s.chips}`).join('、');
    return { say: [`チップは ${rows}。`], show: [pk.describe(t, actor)], session, hand: board() };
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
    return { ...runAi(t, session, [...t.log], actor, steps), hand: board() };
  }
  if (t.street === 'done') return { say: ['いまは手の外だよ。「配って」で次いこう。'], session };

  const map: Record<string, pk.Move> = { fold: 'fold', check: 'check', call: 'call', raise: 'raise', allin: 'allin' };
  const move = map[cmd.type];
  if (!move) return { say: ['それはポーカーでは使えないよ。降りる? コール? レイズ?'], session };
  const amount = cmd.type === 'raise'
    ? (cmd.amount > 0 ? cmd.amount : t.bet + Math.max(t.minRaise, Math.floor(pk.potOf(t) / 2)))
    : 0;
  const r = pk.act(t, actor, move, amount);
  if (!r.ok) return { say: [r.error], session };
  const before = t.log.length;
  return { ...runAi(t, session, t.log.slice(before - 1), actor, steps), hand: board() };
}

// 画面に出すための今の様子。ボタンは「声で言うのと同じ言葉」を持たせるので、
// 押した時の道筋は声とまったく同じになる(判定の入口を二重に作らない)
export type Face = { text: string; red?: boolean; hidden?: boolean; move?: string };
// 麻雀の卓。自分から見た向き(自分=下、下家=右、対面=上、上家=左)で並べる
export type MjSeat = {
  at: 'self' | 'right' | 'top' | 'left';
  name: string; points: number; wind: string;
  riichi: boolean; turn: boolean; dealer: boolean;
  river: string[];
  melds: string[][];   // 晒した面子(鳴いたもの)
};
export type MjBoard = {
  round: string; honba: number; left: number; dora: string; sticks: number;
  seats: MjSeat[];
};
export type Seat = { name: string; turn: boolean; you: boolean; chips?: number };

export type View = {
  kind: Session['kind'] | null;
  /** PBI-042: 卓に着いている面々（Zoom の窓・名札に使う）。**3 ゲーム共通の形** */
  seats: Seat[];
  /** 自分が手を打つ番か。**画面と声かけで同じ判定を使う**(room 側で推測しない。PBI-028) */
  yourTurn: boolean;
  title: string;
  state: string[];
  rules: string;
  moves: { label: string; text: string }[];
  tiles: { label: string; text: string }[];
  // 実物として見せる札・牌。move があるものは押せる(麻雀の打牌)
  table: { label: string; kind: 'card' | 'tile'; faces: Face[] }[];
  board?: MjBoard;   // 麻雀だけ。卓そのものを描くための情報
  hand?: Face[];     // 麻雀の手牌(卓の下に大きく並べる)
};

// ---- PBI-028: 手番の声かけ。**LLM を呼ばない**(手番のたびに API を叩かない) ----
// 実況(卓の進行)とは別で、「あなたに向けた一言」だけを持つ。
// PBI-039: **同じ場面でも、育った 9 軸で言い回しが変わる**（tone。推論は使わない）
//   0 = 素 / 1 = きっぱり(決める力が高い) / 2 = やわらかい(優しさ) / 3 = せっかち(落ち着きが低い)
const TURN_LINES: Record<NonNullable<Session['kind']>, string[][]> = {
  blackjack: [
    ['どうする? 引く? 勝負?', 'はい、あなたの番。引く?', 'その手でいく? もう一枚?'],
    ['引く? 勝負?', '決めて。引く?', 'どっち。'],
    ['ゆっくりでいいよ。引く? 勝負?', 'あなたの番だよ。どうしたい?', '無理しなくていいからね。引く?'],
    ['ほら、あなたの番!', '早く早く、引く?', 'まだ? 勝負しちゃお'],
  ],
  poker: [
    ['あなたの番だよ。降りる? コール?', 'どうする? 乗る?', 'さあ、勝負どころだね'],
    ['降りる? 乗る? 決めて', '乗るか降りるか。', 'はっきりいこう'],
    ['あなたの番。無理せず降りてもいいよ', 'どうしたい? 乗る?', 'ゆっくり考えていいからね'],
    ['ほら番だよ、乗る?', '早く! 降りる?', 'まだ考えてるの?'],
  ],
  mahjong: [
    ['あなたの番。切る牌決まった?', 'どれ切る?', 'はい、ツモったね。どうする?'],
    ['切って。どれ?', '一枚決めて', 'さ、切ろう'],
    ['あなたの番だよ。ゆっくり選んでね', 'どれ切ろうか。迷うよね', '危ないのは置いといていいからね'],
    ['早く切って!', 'まだ? どれ切る?', 'ほら番だよ'],
  ],
};
const IDLE_LINES: string[][] = [
  ['まだ考え中?', 'ゆっくりでいいよ', '迷ってる? 聞いてくれてもいいよ'],
  ['決まった?', 'そろそろ決めよう', 'どっちにする?'],
  ['ゆっくりでいいからね', '迷ってる? 一緒に考えよっか', '急がなくていいよ'],
  ['まだー?', 'ねえ、まだ?', '長考だね'],
];

/** 手番が来た時の一言。`nth` は「その卓で何回目か」(乱数を使わない = 検査できる) */
export function turnLine(kind: Session['kind'] | null, nth: number, tone = 0): string | null {
  const table = kind ? TURN_LINES[kind] : null;
  if (!table) return null;
  const lines = table[Math.abs(Math.trunc(tone)) % table.length];
  return lines[Math.abs(Math.trunc(nth)) % lines.length];
}

/** 手番のまま黙っている時の一言 */
export function idleLine(nth: number, tone = 0): string {
  const lines = IDLE_LINES[Math.abs(Math.trunc(tone)) % IDLE_LINES.length];
  return lines[Math.abs(Math.trunc(nth)) % lines.length];
}

const RED_SUITS = ['♥', '♦'];
const cardFace = (name: string): Face => ({ text: name, red: RED_SUITS.includes(name[0]) });

/** クロエに渡す「場の説明」。同じ卓に着いている時は、ユーザーの手札を絶対に入れない */
export function brief(session: Session | null): string {
  if (!session) return '';
  if (session.kind === 'blackjack') {
    const g = session.game;
    const open = g.phase === 'player';
    return [
      'いまユーザーとブラックジャックで遊んでいる。あなたがディーラー。',
      `ルール: ${RULES_BJ}`,
      `チップ ${g.chips} 枚 / ${g.hands} 手 ${g.wins} 勝 ${g.losses} 敗 ${g.pushes} 分。`,
      g.player.length > 0 ? `ユーザーの手は ${bj.handText(g.player)}(${bj.handValue(g.player).total})。表向きなので見えている。` : '',
      g.dealer.length > 0 ? `あなたの手は ${open ? `${bj.cardName(g.dealer[0])} と伏せ札(2 枚目はユーザーに言わないこと)` : bj.handText(g.dealer)}。` : '',
      'ルールや状況を聞かれたら答えていい。ただし伏せ札は明かさない。',
    ].filter(Boolean).join('\n');
  }
  if (session.kind === 'poker') {
    const t = session.table;
    const me = t.seats.find((s) => s.id === session.meId);
    return [
      'いまユーザーとポーカー(テキサスホールデム)を遊んでいる。あなたは同じ卓の相手。',
      `ルール: ${RULES_PK}`,
      `ポット ${pk.potOf(t)} / ${t.seats.map((s) => `${s.name} ${s.chips}${s.folded ? '(降)' : ''}`).join(' / ')}`,
      t.board.length > 0 ? `場札は ${pk.handText(t.board)}(全員に見えている)。` : '場札はまだ無い。',
      `いまは ${t.seats[t.toAct]?.name ?? '?'} の番。`,
      `【重要】${me?.name ?? 'ユーザー'}の手札は伏せられていて、あなたには見えない。`,
      '推測して言い当てようとしないこと。聞かれても「見えないよ」と答える。',
      'ルール・ポット・場札・チップの話はしていい。',
    ].join('\n');
  }
  const g = session.game;
  const seat = g.players.findIndex((p) => p.id === session.meId);
  const me = g.players[seat];
  return [
    'いまユーザーと麻雀(東風戦)を遊んでいる。あなたは同じ卓の相手。',
    `ルール: ${RULES_MJ}`,
    `東${g.round}局 ${g.honba}本場 / 残り ${mg.remaining(g)} 枚 / ドラ表示は ${mj.tileName(g.doraIndicator)}。`,
    g.players.map((p) => `${p.name} ${p.points}点${p.riichi ? '(立直)' : ''}`).join(' / '),
    `いまは ${g.players[g.turn]?.name ?? '?'} の番。`,
    `捨て牌(全員に見えている): ${g.players.map((p) => `${p.name}[${p.discards.map(mj.tileName).join(' ') || '無し'}]`).join(' ')}`,
    `【重要】${me?.name ?? 'ユーザー'}の手牌は伏せられていて、あなたには見えない。`,
    '推測して言い当てようとしないこと。聞かれても「見えないよ」と答える。',
    'ルール・点数・巡目・捨て牌・ドラの話はしていい。',
  ].join('\n');
}

export function view(session: Session | null, viewerId?: string): View {
  // PBI-037: **見る人ごとの盤面**。自分の手牌は自分にしか出さない
  const actor = session ? actorOf(session, viewerId) : 'you';
  if (!session) {
    return {
      kind: null, yourTurn: false, seats: [], title: 'いまは遊んでないよ', state: [],
      rules: 'ゲーム部屋で遊べるよ。ポーカーはクロエたちと、ブラックジャックはクロエがディーラー、麻雀は 4 人で東風戦。',
      moves: [
        { label: '🃏 ポーカー(レート 10)', text: 'ポーカーやろう' },
        { label: '🃏 レート 50', text: 'レート50でポーカーやろう' },
        { label: '🃏 レート 100', text: 'レート100でポーカーやろう' },
        { label: '♠ ブラックジャック', text: 'ブラックジャックやろう' },
        { label: '🀄 麻雀', text: '麻雀やろう' },
      ],
      tiles: [], table: [],
    };
  }
  if (session.kind === 'blackjack') {
    const g = session.game;
    const playing = g.phase === 'player';
    return {
      kind: 'blackjack',
      yourTurn: playing,
      seats: [
        { name: 'あなた', turn: playing, you: true, chips: g.chips },
        { name: 'クロエ(ディーラー)', turn: !playing && g.player.length > 0, you: false },
      ],
      title: `ブラックジャック — チップ ${g.chips} 枚`,
      state: [
        g.player.length > 0 ? `あなた ${bj.handText(g.player)}(${bj.handValue(g.player).total})` : '賭けるところから',
        g.dealer.length > 0 ? `ディーラー ${playing ? `${bj.cardName(g.dealer[0])} ■` : bj.handText(g.dealer)}` : '',
        `${g.hands} 手 ${g.wins} 勝 ${g.losses} 敗 ${g.pushes} 分`,
      ].filter(Boolean),
      rules: RULES_BJ,
      moves: playing
        ? [{ label: '引く', text: '引く' }, { label: '勝負', text: '勝負' },
          ...(g.player.length === 2 ? [{ label: 'ダブル', text: 'ダブル' }] : [])]
        : [{ label: '100 賭ける', text: '100賭ける' }, { label: '500 賭ける', text: '500賭ける' },
          { label: '補充', text: '補充して' }, { label: 'やめる', text: 'もうやめる' }],
      tiles: [],
      table: g.player.length === 0 ? [] : [
        { label: `ディーラー${playing ? '' : `(${bj.handValue(g.dealer).total})`}`, kind: 'card',
          faces: playing ? [cardFace(bj.cardName(g.dealer[0])), { text: '?', hidden: true }]
            : g.dealer.map((c) => cardFace(bj.cardName(c))) },
        { label: `あなた(${bj.handValue(g.player).total})`, kind: 'card',
          faces: g.player.map((c) => cardFace(bj.cardName(c))) },
      ],
    };
  }
  if (session.kind === 'poker') {
    const t = session.table;
    // PBI-041: **卓に着いていない人が見ることがある**（招かれた人が他人の卓を覗く / 席を持たない見物）。
    // ここで席が無いことを前提にすると undefined を触って**部屋ごと落ちる**（実際に落ちた）
    const me = t.seats.find((s) => s.id === actor);
    if (!me) {
      return {
        kind: 'poker', yourTurn: false,
        seats: t.seats.map((x, i) => ({ name: x.name, turn: t.street !== 'done' && t.toAct === i, you: false, chips: x.chips })),
        title: `ポーカー — ポット ${pk.potOf(t)}（見物中）`,
        state: [t.seats.map((x) => `${x.name} ${x.chips}${x.folded ? '(降)' : ''}`).join(' / '),
          t.board.length > 0 ? `場 ${pk.handText(t.board)}` : ''].filter(Boolean),
        rules: RULES_PK, moves: [], tiles: [], table: [],
      };
    }
    const myTurn = t.street !== 'done' && t.seats[t.toAct]?.id === actor;
    const need = pk.toCall(t, me);
    return {
      kind: 'poker',
      yourTurn: myTurn,
      seats: t.seats.map((x, i) => ({ name: x.name, turn: t.street !== 'done' && t.toAct === i, you: x.id === actor, chips: x.chips })),
      title: `ポーカー — ポット ${pk.potOf(t)} / あなた ${me.chips} 枚`,
      state: [
        me.hole.length > 0 ? `あなたの手 ${pk.handText(me.hole)}` : '「配って」で始まるよ',
        t.board.length > 0 ? `場 ${pk.handText(t.board)}` : '',
        t.seats.map((s) => `${s.name} ${s.chips}${s.folded ? '(降)' : ''}`).join(' / '),
      ].filter(Boolean),
      rules: RULES_PK,
      moves: myTurn
        ? [
          ...(need > 0 ? [{ label: '降りる', text: '降りる' }, { label: `コール ${need}`, text: 'コール' }]
            : [{ label: 'チェック', text: 'チェック' }]),
          { label: 'レイズ', text: `${t.bet + Math.max(t.minRaise, Math.floor(pk.potOf(t) / 2))}まで上げる` },
          { label: 'オールイン', text: 'オールイン' },
        ]
        : [{ label: '配って', text: '配って' }, { label: 'やめる', text: 'もうやめる' }],
      tiles: [],
      table: me.hole.length === 0 ? [] : [
        { label: `場(ポット ${pk.potOf(t)})`, kind: 'card',
          faces: [...t.board.map((c) => cardFace(pk.cardName(c))),
            ...Array.from({ length: Math.max(0, 5 - t.board.length) }, () => ({ text: '?', hidden: true }))] },
        { label: `あなたの手${need > 0 ? `(コール ${need})` : ''}`, kind: 'card',
          faces: me.hole.map((c) => cardFace(pk.cardName(c))) },
      ],
    };
  }
  const g = session.game;
  const seat = g.players.findIndex((p) => p.id === actor);
  if (seat < 0) {
    // 卓に着いていない人（見物）。手牌は出さない・押せる手も出さない
    return {
      kind: 'mahjong', yourTurn: false,
      seats: g.players.map((p, i) => ({ name: p.name, turn: g.turn === i, you: false, chips: p.points })),
      title: `麻雀 — 東${g.round}局 ${g.honba}本場 / 残り ${mg.remaining(g)} 枚（見物中）`,
      state: [g.players.map((p) => `${p.name} ${p.points}`).join(' / ')],
      rules: RULES_MJ, moves: [], tiles: [], table: [],
    };
  }
  const me = g.players[seat];
  const myDiscard = g.phase === 'discard' && g.turn === seat;
  const canT = myDiscard && mg.canTsumo(g, seat) !== null;
  const tiles: { label: string; text: string }[] = [];
  if (myDiscard) {
    for (let t = 0; t < 34; t++) {
      for (let i = 0; i < me.hand[t]; i++) {
        if (me.riichi && t !== me.drawn) continue; // 立直中はツモ切りだけ
        tiles.push({ label: mj.tileName(t), text: `${mj.tileName(t)}切る` });
        break; // 同じ牌は 1 つのボタンで足りる
      }
    }
  }
  const moves: { label: string; text: string }[] = [];
  if (canT) moves.push({ label: '🎉 ツモ', text: 'ツモ' });
  // 鳴ける場面ではその選択肢だけを出す(ターン制。ここで止まって選ぶ)
  const calls = mg.callsFor(g, seat);
  if (calls.ron) moves.push({ label: '🎉 ロン', text: 'ロン' });
  if (calls.kan) moves.push({ label: 'カン', text: 'カン' });
  if (calls.pon) moves.push({ label: 'ポン', text: 'ポン' });
  for (const low of calls.chi) {
    moves.push({ label: `チー ${mj.tileName(low)}${mj.tileName(low + 1)}${mj.tileName(low + 2)}`, text: `チー${mj.tileName(low)}` });
  }
  if (calls.ron || calls.kan || calls.pon || calls.chi.length > 0) moves.push({ label: 'スルー', text: 'スルー' });
  if (myDiscard && !me.riichi) {
    const after = me.hand.slice();
    if (me.drawn !== null) after[me.drawn]--;
    if (mj.shanten(after) === 0) moves.push({ label: 'リーチ(ツモ切り)', text: 'リーチ' });
  }
  // 卓を開いた直後(idle)は**押せる手が「やめる」しか無く、画面に何も出ない**。
  // 「『配って』で始めるね」と言われても押す物が無い = 遊べない（2026-08-16 実機で踏んだ）
  if (g.phase === 'idle') moves.push({ label: '🀄 配って', text: '配って' });
  if (g.phase === 'done' || g.phase === 'over') moves.push({ label: '次の局', text: '配って' });
  moves.push({ label: 'やめる', text: 'もうやめる' });
  const handFaces: Face[] = [];
  if (me.hand.some((n) => n > 0)) {
    for (let t = 0; t < 34; t++) {
      for (let i = 0; i < me.hand[t]; i++) {
        if (t === me.drawn && i === me.hand[t] - 1) continue; // ツモ牌は右に離して置く
        handFaces.push({ text: mj.tileName(t), move: myDiscard && (!me.riichi || t === me.drawn) ? `${mj.tileName(t)}切る` : undefined });
      }
    }
    if (me.drawn !== null) handFaces.push({ text: mj.tileName(me.drawn), red: true, move: myDiscard ? `${mj.tileName(me.drawn)}切る` : undefined });
  }
  const WINDS = ['東', '南', '西', '北'];
  const AT: MjSeat['at'][] = ['self', 'right', 'top', 'left']; // 自分から見た並び(反時計回り)
  const board: MjBoard | undefined = handFaces.length === 0 ? undefined : {
    round: `東${g.round}局`, honba: g.honba, left: mg.remaining(g),
    dora: mj.tileName(mg.doraOf(g.doraIndicator)), sticks: g.riichiSticks,
    seats: AT.map((at, i) => {
      const p = g.players[(seat + i) % 4];
      return {
        at, name: p.name, points: p.points,
        wind: WINDS[((seat + i) % 4 - g.dealer + 4) % 4],
        riichi: p.riichi, turn: g.turn === (seat + i) % 4, dealer: g.dealer === (seat + i) % 4,
        river: p.discards.map(mj.tileName),
        melds: p.melds.map((m) => (m.kind === 'run'
          ? [m.tile, m.tile + 1, m.tile + 2]
          : m.kind === 'kan' ? [m.tile, m.tile, m.tile, m.tile] : [m.tile, m.tile, m.tile]).map(mj.tileName)),
      };
    }),
  };
  return {
    kind: 'mahjong',
    yourTurn: myDiscard || moves.some((m) => m.label.includes('🎉')),
    seats: g.players.map((p, i) => ({ name: p.name, turn: g.turn === i, you: i === seat, chips: p.points })),
    title: `麻雀 — 東${g.round}局 ${g.honba}本場 / 残り ${mg.remaining(g)} 枚`,
    board,
    hand: handFaces,
    table: [],
    // 局・ドラ・点数・河は卓が見せるので、ここでは重複させない(縦を詰めてスクロールを出さない)
    state: handFaces.length === 0 ? ['「配って」で始まるよ'] : [
      g.phase === 'discard' && g.turn === seat
        ? `${mj.shanten(me.hand) === 0 ? '聴牌' : `${mj.shanten(me.hand)} シャンテン`}${me.riichi ? ' / 立直中' : ''}`
        : `${g.players[g.turn]?.name ?? ''} の番`,
    ],
    rules: RULES_MJ,
    moves,
    tiles,
  };
}

function applyMahjong(session: Session & { kind: 'mahjong' }, cmd: Cmd, actor: string, steps = Infinity): Reply {
  const g = session.game;
  const seat = g.players.findIndex((p) => p.id === actor);
  const me = g.players[seat];

  if (cmd.type === 'status') {
    return { say: [`点数は ${g.players.map((p) => `${p.name} ${p.points}`).join('、')}。`],
      show: [mg.describe(g, actor)], session, hand: mg.handDisplay(g, actor) };
  }
  if (cmd.type === 'refill') return { say: ['麻雀では点棒は足せないよ。飛んだら終わりね。'], session };
  if (cmd.type === 'deal') {
    if (g.phase === 'over') return { say: [g.log[g.log.length - 1] ?? '終局してるよ。「やめる」で席を立とう。'], session };
    const r = mg.startHand(g);
    if (!r.ok) return { say: [r.error], session };
    return runMahjongAi(g, session, [...g.log], actor, steps);
  }
  if (cmd.type === 'tsumo') {
    const r = mg.win(g, seat, true);
    if (!r.ok) return { say: [r.error], session };
    return { say: [...g.log.slice(-2), '次いく?'], session, hand: mg.handDisplay(g, actor) };
  }
  if (cmd.type === 'ron') {
    const r = mg.win(g, seat, false);
    if (!r.ok) return { say: [r.error], session };
    return { say: [...g.log.slice(-2), '次いく?'], session, hand: mg.handDisplay(g, actor) };
  }
  if (cmd.type === 'skip') {
    if (g.phase !== 'ron') return { say: ['いまは見送る場面じゃないよ'], session };
    const before = g.log.length;
    if (!mg.pass(g).ok) return { say: ['進められなかった'], session };
    return runMahjongAi(g, session, g.log.slice(before), actor, steps);
  }
  if (cmd.type === 'pon' || cmd.type === 'kan' || cmd.type === 'chi') {
    const before = g.log.length;
    const r = cmd.type === 'pon' ? mg.pon(g, seat)
      : cmd.type === 'kan' ? mg.kan(g, seat)
        : mg.chi(g, seat, cmd.low >= 0 ? cmd.low : (mg.chiOptions(g, seat)[0] ?? -1));
    if (!r.ok) return { say: [r.error], session, hand: mg.handDisplay(g, actor) };
    return runMahjongAi(g, session, g.log.slice(before), actor, steps);
  }
  if (cmd.type === 'discard') {
    if (g.phase !== 'discard' || g.turn !== seat) return { say: ['いまは切る番じゃないよ'], session };
    const tile = cmd.tile >= 0 ? cmd.tile : (me.drawn ?? -1);
    if (tile < 0) return { say: ['どれを切るか言ってね'], session };
    const before = g.log.length;
    const r = mg.discard(g, seat, tile, cmd.riichi);
    if (!r.ok) return { say: [r.error], session, hand: mg.handDisplay(g, actor) };
    return runMahjongAi(g, session, [...g.log.slice(before)], actor, steps);
  }
  return { say: ['それは麻雀では使えないよ。切る牌を言うか、ツモ・ロン・リーチだよ。'], session };
}

// 自分の番が来るまで他家に打たせる。ロンできる場面では止めて聞く
function runMahjongAi(g: mg.Game, session: Session & { kind: 'mahjong' }, say: string[], actor?: string, maxSteps = Infinity): Reply {
  const humans = humanIds(session);
  // 返事を受け取る人（打った本人）の席。鳴きの権利もこの人のぶんを見る
  const seat = g.players.findIndex((p) => p.id === (actor ?? session.meId));
  let steps = 0;   // PBI-043: 1 手ずつ進める時はここで止める（間合いは部屋が置く）
  const show: string[] = [];
  let guard = 0;
  while (guard++ < 200) {
    if (g.phase === 'done' || g.phase === 'over') {
      say.push(...g.log.slice(-2));
      say.push(g.phase === 'over' ? '終局。もう一回やる?' : '次いく?');
      break;
    }
    if (g.phase === 'ron') {
      // 麻雀は打牌ごとに全員へ権利が回る。自分に権利があれば必ず止めて聞く
      const mine = mg.callsFor(g, seat);
      if (mine.ron || mine.pon || mine.kan || mine.chi.length > 0) {
        const d = g.lastDiscard!;
        const can = [mine.ron ? 'ロン' : '', mine.kan ? 'カン' : '', mine.pon ? 'ポン' : '', mine.chi.length > 0 ? 'チー' : '']
          .filter(Boolean).join('・');
        say.push(`${g.players[d.from].name} が ${mj.tileName(d.tile)} を切ったよ。${can} できる。どうする?`);
        break;
      }
      // PBI-037/038: **他の人間に権利がある時は AI に決めさせない**。
      // ここで止めれば、その人の画面に「ロン / ポン」が出る（返事が無ければ PBI-038 が場を進める）
      const waiting = g.players.some((p, i) => {
        if (i === seat || !humans.has(p.id)) return false;
        const c = mg.callsFor(g, i);
        return c.ron || c.pon || c.kan || c.chi.length > 0;
      });
      if (waiting) break;
      // 他家のロン → 鳴き の順に見る(優先順位どおり)
      let acted = false;
      for (let i = 1; i <= 3; i++) {
        const s2 = (g.lastDiscard!.from + i) % 4;
        if (s2 !== seat && mg.canRon(g, s2)) { const b = g.log.length; mg.win(g, s2, false); say.push(...g.log.slice(b)); acted = true; break; }
      }
      if (acted) continue;
      for (let i = 1; i <= 3 && !acted; i++) {
        const s2 = (g.lastDiscard!.from + i) % 4;
        if (s2 === seat || humans.has(g.players[s2].id)) continue;   // 人の手は AI が触らない
        const call = mg.aiCall(g, s2);
        if (call) { const b = g.log.length; (call === 'kan' ? mg.kan : mg.pon)(g, s2); say.push(...g.log.slice(b)); acted = true; }
      }
      if (acted) continue;
      const before = g.log.length;
      if (!mg.pass(g).ok) break;
      say.push(...g.log.slice(before));
      continue;
    }
    if (g.phase === 'discard') {
      // PBI-043(重大): **人の席では止まる**。ここを「打った本人の席」だけで見ていたので、
      // 招いた人の打牌まで AI が代わりに打っていた（＝「友達の番が来なかった」の正体）
      if (g.turn !== seat && humans.has(g.players[g.turn].id)) break;
      if (g.turn === seat) {
        const t = mg.canTsumo(g, seat);
        if (t) say.push('和了れるよ! ツモする?');   // 何をツモったかは読み上げない(画面で見る)
        show.push(mg.describe(g, actor ?? session.meId));
        break;
      }
      const s = g.turn;
      const t = mg.canTsumo(g, s);
      if (t) { const before = g.log.length; mg.win(g, s, true); say.push(...g.log.slice(before)); continue; }
      // PBI-043: **打つ前に**歩数を見る。0 なら「他家が打つ手前」で止まる
      // （鳴きの解決や自分のツモは済ませた状態で止めるので、卓は固まらない）
      if (steps >= maxSteps) break;
      const { tile, riichi } = mg.chooseDiscard(g, s);
      const before = g.log.length;
      if (!mg.discard(g, s, tile, riichi).ok) break;
      say.push(...g.log.slice(before));
      steps++;
      continue;
    }
    break;
  }
  return { say: dedupe(say), show, session, hand: mg.handDisplay(g, actor ?? session.meId) };
}

// 人間の番が来るまで AI に打たせる。1 手ごとの出来事をそのまま読み上げ文にする
function runAi(t: pk.Table, session: Session & { kind: 'poker' }, say: string[], actor?: string, maxSteps = Infinity): Reply {
  const humans = humanIds(session);
  const me0 = actor ?? session.meId;
  let guard = 0;
  // **どの人間の番でも止める**（1 人卓の時は今までと同じ動き）
  while (t.street !== 'done' && !humans.has(t.seats[t.toAct]?.id ?? '') && guard++ < 40) {
    if (maxSteps <= 0) break;   // PBI-043: 打つ前に歩数を見る（0 なら他家の手前で止まる）
    const before = t.log.length;
    const d = pk.decide(t);
    const r = pk.act(t, t.seats[t.toAct].id, d.move, d.amount);
    if (!r.ok) break; // 反則は起こらない想定。起きたら手を止めて場を読ませる
    say.push(...t.log.slice(before));
    maxSteps -= 1;
  }
  if (t.street === 'done') {
    say.push(...t.log.slice(-3).filter((l) => l.includes('獲得')));
    const me = t.seats.find((s) => s.id === me0)!;
    say.push(`あなたのチップは ${me.chips} 枚。次いく?`);
  }
  // 自分の手札が入る説明は読み上げない(画面で見る)
  const show = t.street === 'done' ? [] : [pk.describe(t, me0)];
  return { say: dedupe(say), show, session };
}

// 同じ行を二重に読まない(log の切り出しが重なることがある)
function dedupe(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) if (l && l !== out[out.length - 1]) out.push(l);
  return out;
}
