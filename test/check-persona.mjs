// PBI-021 の検査。src/persona.ts は依存ゼロ・純関数なので import して直接呼べる
// (部屋も音声エンジンも API キーも要らない = CI でそのまま緑になる)。
//
// 守っているもの:
//   AC-1..4  interpret が拾うもの / 拾わないもの
//   AC-5     飽和(clamp) — 外すと落ちる
//   AC-6     減衰(DECAY) — 0 にすると落ちる
//   AC-7     決定性(同じ入力 → 同じ出力)
//   AC-9/10  隔離 HOME での保存 round-trip と signals.jsonl の追記
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const t = (n, f) => { try { f(); ok(n); } catch (e) { fail(n, e.message); } };
const eq = (a, b, why) => { if (a !== b) throw new Error(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const truthy = (v, why) => { if (!v) throw new Error(why); };

// 保存先を隔離してから import する(persona.ts は homedir() を実行時に読む)
const HOME = mkdtempSync(join(tmpdir(), 'claw-persona-'));
process.env.HOME = HOME;

const P = await import('../src/persona.ts');

// ---- AC-1..4: 解釈 ----------------------------------------------------------
const user = (text) => P.interpret({ speaker: 'user', text, at: '2026-08-15T00:00:00.000Z' });
const params = (sigs) => sigs.map((s) => `${s.param}${s.direction === 'up' ? '+' : '-'}`).sort();

t('AC-1 質問すると 好奇心(a) が上がる', () => {
  truthy(params(user('なんでこれ動かないの？')).includes('a+'), 'a+ が無い');
});
t('AC-2 感謝すると 優しさ(d) が上がる', () => {
  truthy(params(user('ありがとう、助かった')).includes('d+'), 'd+ が無い');
});
t('AC-3 決めると 決める力(g) が上がる', () => {
  truthy(params(user('これで行こう')).includes('g+'), 'g+ が無い');
});
t('AC-3b 迷うと 決める力(g) が下がる', () => {
  truthy(params(user('やっぱりやめとく')).includes('g-'), 'g- が無い');
});
t('AC-4 合図の無い相槌は 0 本(何でも拾わない)', () => {
  eq(user('うん').length, 0, '「うん」で signal が出た');
  eq(user('').length, 0, '空文字で signal が出た');
});
t('AC-4b 既定では相棒(agent)の発話は観測しない', () => {
  eq(P.interpret({ speaker: 'agent', text: 'ありがとう、助かった' }).length, 0, 'agent 発話を拾った');
});
t('英語でも拾う', () => {
  truthy(params(user('thanks, that helped a lot')).includes('d+'), 'd+ が無い(英語)');
});

// ---- AC-5/6/7: 集約の性質 ---------------------------------------------------
const sig = (param, direction = 'up', strength = 1) => ({
  param, direction, strength, source: 'talkingclaw', reasoning: 'test', created_at: '2026-08-15T00:00:00.000Z',
});

t('AC-5 up を 1000 本入れても 100 を超えない(飽和する)', () => {
  let st = P.emptyState('2026-08-15T00:00:00.000Z');
  for (let i = 0; i < 1000; i++) st = P.reduce(st, [sig('a')], '2026-08-15T00:00:00.000Z');
  truthy(st.values.a <= P.LIMIT, `上限を超えた: ${st.values.a}`);
  truthy(st.values.a > 50, `上がっていない: ${st.values.a}`);
  let dn = P.emptyState();
  for (let i = 0; i < 1000; i++) dn = P.reduce(dn, [sig('a', 'down')], '2026-08-15T00:00:00.000Z');
  truthy(dn.values.a >= -P.LIMIT, `下限を超えた: ${dn.values.a}`);
});

t('AC-6 signal が無いターンは 0 へ近づく(符号は跨がない)', () => {
  let st = P.reduce(P.emptyState(), [sig('a'), sig('a'), sig('a')]);
  const start = st.values.a;
  truthy(start > 0, '前提: 正の値になっている');
  let prev = start;
  for (let i = 0; i < 50; i++) {
    st = P.reduce(st, []);
    truthy(st.values.a <= prev, `増えた: ${prev} → ${st.values.a}`);
    truthy(st.values.a >= 0, `符号を跨いだ: ${st.values.a}`);
    prev = st.values.a;
  }
  truthy(prev < start, `減衰していない: ${start} → ${prev}`);
});

t('AC-6b turns は signal が 0 本でも進む', () => {
  const st = P.reduce(P.emptyState(), []);
  eq(st.turns, 1, 'turns が進まない');
});

t('AC-7 決定的(同じ入力 → 同じ出力)', () => {
  const a = JSON.stringify(user('なんで？ ありがとう、これで行こう'));
  const b = JSON.stringify(user('なんで？ ありがとう、これで行こう'));
  eq(a, b, 'interpret が揺れる');
  const s1 = P.reduce(P.emptyState('2026-01-01T00:00:00.000Z'), user('ありがとう'), '2026-01-01T00:00:00.000Z');
  const s2 = P.reduce(P.emptyState('2026-01-01T00:00:00.000Z'), user('ありがとう'), '2026-01-01T00:00:00.000Z');
  eq(JSON.stringify(s1), JSON.stringify(s2), 'reduce が揺れる');
});

// ---- AC-9/10: 保存 -----------------------------------------------------------
t('AC-9/10 観測すると persona.json と signals.jsonl に残り、読み直せる', () => {
  eq(homedir(), HOME, '前提: HOME が隔離されている');
  P.resetPersonaCache(P.emptyState('2026-08-15T00:00:00.000Z'));
  const r = P.observeTurn({ speaker: 'user', text: 'ありがとう、これで行こう', at: '2026-08-15T00:00:00.000Z' });
  truthy(r.signals.length >= 2, `signal が少ない: ${r.signals.length}`);
  truthy(existsSync(P.personaPath()), 'persona.json が無い');
  truthy(existsSync(P.signalsPath()), 'signals.jsonl が無い');

  const lines = readFileSync(P.signalsPath(), 'utf8').trim().split('\n');
  eq(lines.length, r.signals.length, 'signals.jsonl の行数が合わない');
  const first = JSON.parse(lines[0]);
  eq(first.source, 'talkingclaw', 'source が違う');
  truthy(typeof first.strength === 'number' && first.strength > 0 && first.strength <= 1, 'strength が 0..1 でない');
  truthy(typeof first.reasoning === 'string' && first.reasoning.length > 0, 'reasoning が空(なぜ出たか分からない)');

  P.resetPersonaCache(); // cache を捨ててファイルから読み直す
  const back = P.currentPersona();
  eq(back.turns, 1, '再読込で turns が復元されない');
  eq(back.values.d, r.state.values.d, '再読込で値が変わった');
});

t('壊れた persona.json でも部屋を止めない(空状態に落ちる)', () => {
  writeFileSync(P.personaPath(), '{ this is not json');
  P.resetPersonaCache();
  const st = P.currentPersona();
  eq(st.turns, 0, '壊れたファイルから turns を作った');
});


// ---- PBI-039: 育ちが態度に出る ----
{
  const flat = Object.fromEntries(P.PARAM_KEYS.map((k) => [k, 50]));

  t('AC-1 初期状態では態度の行を足さない', () => {
    eq(P.attitudeLine(flat), '', '素の子に一文を足している');
    eq(P.attitudeTone(flat), 0, '素の子の言い回しが変わっている');
  });

  t('AC-2 振れた軸だけが 1 行に出る（最大 3 つ）', () => {
    const line = P.attitudeLine({ ...flat, g: 72, d: 64, e: 38, a: 55 });
    const traits = line.split('\n')[1].split(' / ');
    eq(traits.length, 3, `特徴が ${traits.length} 個（上限 3）`);
    truthy(traits.includes('はっきり決める'), `決める力が出ていない: ${traits.join(',')}`);
    truthy(traits.includes('せっかち'), `下振れが出ていない: ${traits.join(',')}`);
    truthy(!/好奇心|食いつく/.test(line), '閾値未満の軸まで出ている');
  });

  t('AC-3 決定的（同じ 9 軸 → 同じ文）', () => {
    const v = { ...flat, c: 30, i: 70 };
    eq(P.attitudeLine(v), P.attitudeLine(v), '揺れる');
  });

  t('AC-4 違う育ちは違う態度（W6 の完了条件）', () => {
    const a = P.attitudeLine({ ...flat, g: 72, e: 38 });
    const b = P.attitudeLine({ ...flat, c: 30, i: 70 });
    truthy(a !== b && a !== '' && b !== '', `育ちの差が出ない: ${JSON.stringify([a, b])}`);
    truthy(P.attitudeTone({ ...flat, g: 72 }) !== P.attitudeTone({ ...flat, d: 70 }), '言い回しの選び分けが同じ');
  });

  t('AC-6 壊れた値でも落ちない', () => {
    eq(P.attitudeLine({}), '', '空の値で例外 or 余計な文');
    eq(P.attitudeTone(undefined), 0, 'undefined で落ちる');
    eq(P.attitudeLine({ a: Number.NaN, g: 99 }).includes('はっきり決める'), true, 'NaN が混ざると壊れる');
  });

  t('AC-5/配線: prompt と手番の声かけの両方で使っている', () => {
    const room = readFileSync(new URL('../src/room.ts', import.meta.url), 'utf8');
    truthy(/attitudeLine\(currentPersona\(\)\.values\)/.test(room), 'prompt に態度が入っていない');
    truthy(/casino\.turnLine\(view\.kind, st\.said, tone\)/.test(room), '手番の声かけに 9 軸が効いていない');
    const casino = readFileSync(new URL('../src/casino.ts', import.meta.url), 'utf8');
    truthy(/turnLine\(kind: Session\['kind'\] \| null, nth: number, tone = 0\)/.test(casino), 'tone を受け取っていない');
  });
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
