// 相棒の人格が会話で育つ層(PBI-021)。
//
// 9 軸と ParamSignal の形は **Shibubu(shibu003/Shibubu, BSL 1.1) の設計を契約として共有**している。
// **BSL のコードは 1 行も持ち込んでいない** — この repo は ISC なので、共有するのは
// 「signal の形」と「軸の意味」だけで、下の reducer は独立に書いた小さな実装。
// 同じ signal を後で Shibubu 側のサーバ engine に流せるように、フィールド名は向こうに合わせてある。
//
// 決定的であること(LLM を使わないこと)が v0 の要件: API キー無しの CI で検査が回り、
// 同じ会話からは必ず同じ値が出る。解釈を賢くしたくなったら interpret() を差し替える
// (signature を変えなければ、検査もこのファイルの外も無傷)。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---- 契約(Shibubu と共有) ----------------------------------------------------

export type ParamKey = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i';
export const PARAM_KEYS: readonly ParamKey[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const;

export const AXES: Record<ParamKey, { ja: string; en: string }> = {
  a: { ja: '好奇心', en: 'Curiosity' },
  b: { ja: '几帳面さ', en: 'Diligence' },
  c: { ja: '社交性', en: 'Sociability' },
  d: { ja: '優しさ', en: 'Kindness' },
  e: { ja: '心の落ち着き', en: 'Calm' },
  f: { ja: '夢を持つ力', en: 'Purpose' },
  g: { ja: '自分で決める力', en: 'Courage' },
  h: { ja: '自分らしさ', en: 'Identity' },
  i: { ja: '思いやり', en: 'Compassion' },
};

export type SignalDirection = 'up' | 'down';

export type ParamSignal = {
  param: ParamKey;
  direction: SignalDirection;
  strength: number; // 0.0 – 1.0
  source: 'talkingclaw';
  reasoning: string; // なぜこの signal が出たか(規則の名前)。人が読んで反証できるように残す
  created_at: string; // ISO
  session_id?: string; // 同じ turn から出た signal をまとめる
};

export type PersonaState = {
  values: Record<ParamKey, number>; // -100 .. 100
  turns: number; // 観測した発話数(signal が 0 本でも数える)
  updatedAt: string;
};

// ---- 係数(ここだけ動かせば挙動が変わる) --------------------------------------

/** signal 1 本が値をどれだけ動かすか。strength 1.0 の up 1 本で +GAIN。 */
export const GAIN = 4;
/** 1 ターンごとに 0 へ引き戻す割合。0 にすると減衰しない(AC-6 の負の対照)。 */
export const DECAY = 0.005;
/** 値の上限・下限。Shibubu と同じ -100..100。 */
export const LIMIT = 100;

export function emptyState(now = new Date().toISOString()): PersonaState {
  const values = {} as Record<ParamKey, number>;
  for (const k of PARAM_KEYS) values[k] = 0;
  return { values, turns: 0, updatedAt: now };
}

// ---- 解釈: 発話 → signal(純関数・決定的) -------------------------------------

export type Turn = {
  speaker: 'user' | 'agent';
  text: string;
  at?: string;
  sessionId?: string;
};

type Rule = {
  name: string;
  param: ParamKey;
  direction: SignalDirection;
  strength: number;
  /** どちらの発話を見るか。既定は user だけ(相棒は「あなた」を観測して育つ) */
  speaker?: 'user' | 'agent' | 'both';
  test: (text: string) => boolean;
};

const has = (...needles: string[]) => (t: string) => needles.some((n) => t.includes(n));
const matches = (re: RegExp) => (t: string) => re.test(t);

// v0 の規則。日本語と英語の両方を拾う。**拾いすぎない**ことを AC-4 が守る。
export const RULES: readonly Rule[] = [
  { name: 'question', param: 'a', direction: 'up', strength: 0.3,
    test: matches(/[?？]|なんで|なぜ|どうやって|どうして|教えて|知りたい|\bwhy\b|\bhow\b|\bwhat is\b/i) },
  { name: 'gratitude', param: 'd', direction: 'up', strength: 0.4,
    test: matches(/ありがと|助かっ|助かる|感謝|\bthanks?\b|\bthank you\b|nice work|good job/i) },
  { name: 'addressing-others', param: 'c', direction: 'up', strength: 0.3,
    test: matches(/みんな|一緒に|手伝って|相談|\beveryone\b|\btogether\b|let'?s talk/i) },
  { name: 'decision', param: 'g', direction: 'up', strength: 0.4,
    test: matches(/これで(行|い)こ|やろう|決めた|進めて|着手|やります|\bship it\b|let'?s go|go ahead/i) },
  { name: 'hesitation', param: 'g', direction: 'down', strength: 0.2,
    test: matches(/やめとく|やっぱりいい|迷って|わからない|分からない|どうしよう|\bnot sure\b|\bmaybe later\b/i) },
  { name: 'aspiration', param: 'f', direction: 'up', strength: 0.3,
    test: matches(/したい|作りたい|目標|いつか|将来|夢|\bi want to\b|\bgoal\b|someday/i) },
  { name: 'planning', param: 'b', direction: 'up', strength: 0.3,
    test: (t) => /手順|計画|まず|次に|整理|順番|\bplan\b|\bstep \d/i.test(t) || t.length >= 120 },
  { name: 'empathy', param: 'i', direction: 'up', strength: 0.3,
    test: matches(/ごめん|大丈夫\?|大丈夫？|無理しない|お疲れ|\bsorry\b|are you ok|take care/i) },
  { name: 'frustration', param: 'e', direction: 'down', strength: 0.3,
    test: matches(/イライラ|最悪|うざ|むかつ|なんでこうなる|\bdamn\b|\bugh\b|this sucks/i) },
  { name: 'composure', param: 'e', direction: 'up', strength: 0.2,
    test: matches(/落ち着い|ゆっくり|焦らな|一つずつ|\bcalm\b|one at a time|no rush/i) },
  { name: 'self-statement', param: 'h', direction: 'up', strength: 0.2,
    test: matches(/自分は|私は|僕は|俺は|と思う|考えてる|\bi think\b|\bi believe\b|in my opinion/i) },
];

/** 発話 1 つ → signal 0..n 本。純関数・決定的(同じ入力なら必ず同じ出力)。 */
export function interpret(turn: Turn): ParamSignal[] {
  const text = (turn.text ?? '').trim();
  if (!text) return [];
  const created_at = turn.at ?? new Date().toISOString();
  const out: ParamSignal[] = [];
  for (const rule of RULES) {
    const want = rule.speaker ?? 'user';
    if (want !== 'both' && want !== turn.speaker) continue;
    if (!rule.test(text)) continue;
    out.push({
      param: rule.param,
      direction: rule.direction,
      strength: rule.strength,
      source: 'talkingclaw',
      reasoning: rule.name,
      created_at,
      ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
    });
  }
  return out;
}

// ---- 集約: signal → 状態(純関数) ---------------------------------------------

const clamp = (v: number) => Math.max(-LIMIT, Math.min(LIMIT, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 1 ターン分を反映する。signal が 0 本でも turns は進み、減衰だけがかかる。
 * 飽和(clamp)と減衰(DECAY)がこの関数の性質で、AC-5 / AC-6 がそれを守る。
 */
export function reduce(state: PersonaState, signals: ParamSignal[], now?: string): PersonaState {
  const values = { ...state.values };
  for (const k of PARAM_KEYS) {
    // 減衰は「0 へ近づく」だけ。符号は跨がない
    values[k] = values[k] * (1 - DECAY);
  }
  for (const s of signals) {
    const delta = (s.direction === 'up' ? 1 : -1) * s.strength * GAIN;
    values[s.param] = clamp(values[s.param] + delta);
  }
  for (const k of PARAM_KEYS) values[k] = round1(clamp(values[k]));
  return { values, turns: state.turns + 1, updatedAt: now ?? new Date().toISOString() };
}

/** 上位 n 軸(絶対値の大きい順)。表示用。 */
export function top(state: PersonaState, n = 3): { key: ParamKey; ja: string; en: string; value: number }[] {
  return [...PARAM_KEYS]
    .map((key) => ({ key, ja: AXES[key].ja, en: AXES[key].en, value: state.values[key] }))
    .filter((x) => x.value !== 0)
    .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
    .slice(0, n);
}

// ---- 保存(ここだけ I/O) -------------------------------------------------------

function dir(): string {
  return join(homedir(), '.talkingclaw');
}
export function personaPath(): string {
  return join(dir(), 'persona.json');
}
export function signalsPath(): string {
  return join(dir(), 'signals.jsonl');
}

export function loadPersona(): PersonaState {
  try {
    const raw = JSON.parse(readFileSync(personaPath(), 'utf8')) as Partial<PersonaState>;
    const base = emptyState();
    if (raw && typeof raw === 'object' && raw.values) {
      for (const k of PARAM_KEYS) {
        const v = (raw.values as Record<string, unknown>)[k];
        if (typeof v === 'number' && Number.isFinite(v)) base.values[k] = clamp(v);
      }
      if (typeof raw.turns === 'number' && raw.turns >= 0) base.turns = Math.floor(raw.turns);
      if (typeof raw.updatedAt === 'string') base.updatedAt = raw.updatedAt;
    }
    return base;
  } catch {
    return emptyState(); // 壊れていても部屋は止めない
  }
}

export function savePersona(state: PersonaState): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = personaPath() + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, personaPath()); // 途中で落ちても壊れた JSON を残さない
}

export function appendSignals(signals: ParamSignal[]): void {
  if (signals.length === 0) return;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  // 1 行 1 signal。**Shibubu 側がそのまま食える形**にしておく(後で同期する時の入口)
  appendFileSync(signalsPath(), signals.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
}

// ---- 部屋からの入口 -----------------------------------------------------------

let cache: PersonaState | null = null;

/** 現在の状態(初回はファイルから読む)。 */
export function currentPersona(): PersonaState {
  if (!cache) cache = loadPersona();
  return cache;
}

/** 検査で状態を差し替えるための口。 */
export function resetPersonaCache(state?: PersonaState): void {
  cache = state ?? null;
}

/**
 * 発話 1 つを観測して、状態を更新し、保存する。部屋の onAppend から呼ばれる。
 * **例外は外に出さない** — 人格の計算で会話が止まってはいけない。
 */
export function observeTurn(turn: Turn): { signals: ParamSignal[]; state: PersonaState } {
  const state = currentPersona();
  let signals: ParamSignal[] = [];
  try {
    signals = interpret(turn);
    cache = reduce(state, signals, turn.at);
    appendSignals(signals);
    savePersona(cache);
  } catch {
    // 保存に失敗しても計算結果は保持する(次の書き込みで追いつく)
  }
  return { signals, state: cache ?? state };
}

// ---- PBI-039: 育ちが**態度**に出る ----
// 9 軸は PBI-021 から育っていたが、画面に数字が出るだけだった。育てても何も変わらないなら
// 育てる意味が無い。ここで 2 つの出口を作る:
//   1. prompt に 1 行入れる（下の attitudeLine）
//   2. 手番の声かけの言い回しを選ぶ（casino.turnLine が同じ値を見る）
// **どちらも決定的**（同じ 9 軸 → 同じ結果）。乱数を混ぜない = 検査できる。

/** これだけ振れたら「その子の特徴」と呼ぶ。GAIN=4 なので数回の会話では動かない */
export const TRAIT_EDGE = 8;
const TRAIT_MAX = 3;   // 1 行に入れる特徴の数（多いと prompt が濁る）

const HIGH: Record<ParamKey, string> = {
  a: '知らないことに食いつく', b: '細かいところまで気にする', c: '自分から話しかける',
  d: '相手を立てる', e: '慌てない', f: '先の話をしたがる',
  g: 'はっきり決める', h: '自分の好みを言う', i: '相手の事情を先に考える',
};
const LOW: Record<ParamKey, string> = {
  a: '新しい話題には慎重', b: '細部よりだいたいで進める', c: '聞き役に回る',
  d: '遠慮せず言う', e: 'せっかち', f: '目の前のことに集中する',
  g: '決めるのは相手に譲る', h: '相手に合わせる', i: '事実を先に言う',
};

/**
 * 9 軸 → prompt に入れる 1 行。**振れた軸だけ**（初期状態は空文字 = 素のまま）。
 * 同じ値なら必ず同じ文（決定的）。
 */
export function attitudeLine(values: Record<ParamKey, number>, edge = TRAIT_EDGE): string {
  const traits = PARAM_KEYS
    .map((k) => ({ k, d: (values?.[k] ?? 50) - 50 }))
    .filter((x) => Math.abs(x.d) >= edge)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.k.localeCompare(b.k))
    .slice(0, TRAIT_MAX)
    .map((x) => (x.d > 0 ? HIGH[x.k] : LOW[x.k]));
  if (traits.length === 0) return '';
  return `(いまのあなたの性格。話し方に薄く出す。説明はしない)\n${traits.join(' / ')}`;
}

/** 手番の声かけなどで「どの言い回しを選ぶか」。0 = 素 / 1 = きっぱり / 2 = やわらかい / 3 = せっかち */
export function attitudeTone(values: Record<ParamKey, number>, edge = TRAIT_EDGE): 0 | 1 | 2 | 3 {
  const v = (k: ParamKey): number => (values?.[k] ?? 50) - 50;
  if (v('g') >= edge) return 1;        // 自分で決める力
  if (v('d') >= edge || v('i') >= edge) return 2;  // 優しさ・思いやり
  if (v('e') <= -edge) return 3;       // 心の落ち着きが低い
  return 0;
}

export function personaSummary(): {
  values: Record<ParamKey, number>;
  turns: number;
  updatedAt: string;
  top: ReturnType<typeof top>;
  axes: typeof AXES;
} {
  const s = currentPersona();
  return { values: s.values, turns: s.turns, updatedAt: s.updatedAt, top: top(s), axes: AXES };
}
