// PBI-022 の検査。GPU も three も要らない範囲だけを機械で守る:
//   - 純関数（layered の有界性 / mouthEnvelope が「鳴っている間だけ動く」）を直に叩く
//   - 配線（import map・canvas・パネル登録・口の 1 ビット・置いていない時の分岐）を
//     **ソースの構造**として確かめる
//
// なぜ描画そのものを検査しないか: WebGL は CI に無い。**無い物を検査したふりをしない**。
// 実機の目視確認は PBI の G2 に人の手で残す。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const t = (n, f) => { try { f(); ok(n); } catch (e) { fail(n, e.message); } };
const truthy = (v, why) => { if (!v) throw new Error(why); };
const eq = (a, b, why) => { if (a !== b) throw new Error(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

// ---- 純関数（three を import せずに取り出す。ブラウザ専用 import を評価しないため）----
// avatar.js は 'three' を import するので node からは丸ごと読めない。
// export された 2 つの純関数だけを切り出して評価する。
const avatarSrc = read('public/avatar.js');
const pure = avatarSrc
  .split('\n')
  .filter((l) => !l.startsWith('import '))
  .join('\n')
  .replace(/export function createAvatarStage[\s\S]*$/, '');   // 描画本体は落とす
const { layered, mouthEnvelope, gameMotion, gameMood, motionForMood, stackOf, emotionFor, faceWeight, assignBodies } = await import(
  'data:text/javascript;base64,' + Buffer.from(pure, 'utf8').toString('base64')
);

t('layered は有界（|v| <= 1）', () => {
  for (let x = 0; x < 200; x += 0.31) {
    truthy(Math.abs(layered(x, 1.3)) <= 1 + 1e-9, `bound@${x}: ${layered(x, 1.3)}`);
  }
});

t('layered は単一 sin ではない（2π で戻らない = 同じ姿勢を繰り返さない）', () => {
  truthy(Math.abs(layered(0, 1) - layered(2 * Math.PI, 1)) > 1e-3, '2π で元に戻った');
});

t('AC-3 鳴っている間は口が開く（0 のままにならない）', () => {
  let maxV = 0;
  for (let x = 0; x < 20; x += 0.05) maxV = Math.max(maxV, mouthEnvelope(x, true));
  truthy(maxV > 0.3, `開かない: max=${maxV}`);
});

t('AC-3b 口は 0..1 に収まる', () => {
  for (let x = 0; x < 50; x += 0.07) {
    const v = mouthEnvelope(x, true);
    truthy(v >= 0 && v <= 1, `範囲外: ${v}@${x}`);
  }
});

t('AC-4 鳴っていなければ口は必ず閉じる', () => {
  for (let x = 0; x < 50; x += 0.13) eq(mouthEnvelope(x, false), 0, `閉じない@${x}`);
});

t('AC-7 決定的（同じ t なら同じ値。乱数を口に混ぜない）', () => {
  eq(mouthEnvelope(3.3, true), mouthEnvelope(3.3, true), '揺れる');
});

// ---- 配線 ----
const html = read('public/index.html');
const roomJs = read('public/room.js');
const roomTs = read('src/room.ts');

t('import map が three / three-vrm を /vendor/ に向けている', () => {
  truthy(/<script type="importmap">/.test(html), 'importmap が無い');
  truthy(html.includes('"three": "/vendor/three/build/three.module.js"'), 'three の対応が無い');
  truthy(html.includes('"three/": "/vendor/three/"'), 'three/ の prefix が無い（GLTFLoader が解決できない）');
  truthy(html.includes('"@pixiv/three-vrm": "/vendor/@pixiv/three-vrm/lib/three-vrm.module.js"'), 'three-vrm の対応が無い');
  truthy(html.indexOf('importmap') < html.indexOf('<script src="/room.js">'), 'importmap が script より後ろにある');
});

t('AC-5 キャラは会話ログを覆わない場所（右レーンの aside）に居る', () => {
  const aside = html.slice(html.indexOf('<aside class="lane side"'), html.indexOf('</aside>'));
  truthy(aside.includes('id="avatar"'), 'avatar パネルが右レーンに無い');
  truthy(aside.includes('id="avatarCanvas"'), 'canvas が右レーンに無い');
  truthy(!/position:\s*fixed[^}]*#avatarCanvas|#avatarCanvas[^}]*position:\s*fixed/.test(html), '会話に被せる position:fixed になっている');
});

t('AC-8 狭い画面で高さを抑えている（#log を潰さない）', () => {
  truthy(/#avatarCanvas[^}]*max-height:\s*30dvh/.test(html), 'max-height の上限が無い');
});

t('操作導線がある（ヘッダのボタン + パネル登録）', () => {
  truthy(html.includes('id="avatarBtn"'), 'ヘッダにボタンが無い');
  truthy(roomJs.includes("avatar: { el: document.getElementById('avatar'), btn: document.getElementById('avatarBtn')"), 'パネル登録が無い');
  truthy(roomJs.includes("SIDE_PANELS = new Set(['voice', 'settings', 'roomAdmin', 'avatar'])"), '右レーン扱いになっていない');
});

t('AC-2 置いていなければボタンごと出さない（今までどおりの画面）', () => {
  truthy(/avatarFiles\.length === 0\) return;/.test(roomJs), '空の時に早期 return していない');
  truthy(html.includes('id="avatarBtn"') && /id="avatarBtn"[^>]*hidden/.test(html), '既定で hidden になっていない');
});

t('AC-3/AC-4 口は「鳴っているか」の 1 ビットだけを見る（音声グラフに触らない）', () => {
  truthy(/const setPlaying = \(v, who\) => \{/.test(roomJs), 'setPlaying が無い');
  truthy(/window\.__clawSpeaking = v;/.test(roomJs), '「鳴っているか」の 1 ビットが無い');
  // 宣言(`let playing = false;`)は代入ではない。lookbehind で「let 以外の代入」だけを禁じる
  truthy(!/(?<!let )playing = (true|false);/.test(roomJs), '直接代入が残っている（口が追従しない経路ができる）');
  truthy(avatarSrc.includes('window.__clawSpeaking'), 'avatar 側が読んでいない');
  truthy(!/AudioContext|createMediaElementSource|AnalyserNode/.test(avatarSrc), '音声グラフに手を入れている');
});

t('AC-7 読み込み失敗でも部屋を止めない（理由を 1 行出して終わる）', () => {
  truthy(/catch \(e\)[\s\S]{0,200}avatarNote|note\.textContent = 'キャラを読み込めませんでした/.test(roomJs), '失敗時の表示が無い');
  truthy(roomJs.includes('stopAvatar();'), '失敗時に後始末していない');
});

t('見えていない時は描画を止める（GPU を回し続けない）', () => {
  truthy(roomJs.includes("if (openedPanel !== 'avatar') stopAvatar();"), 'パネルを閉じても止まらない');
});

t('AC-1/AC-2 動き(.vrma): 口とボタンと配線が在る', () => {
  truthy(html.includes('"@pixiv/three-vrm-animation"'), 'import map に animation が無い');
  truthy(html.includes('id="motionBar"'), 'ボタンの置き場が無い');
  truthy(roomJs.includes("fetch('/motions?token='"), '一覧を取っていない');
  truthy(roomJs.includes('avatarStage?.playMotion('), '再生を呼んでいない');
  truthy(avatarSrc.includes('AnimationMixer'), 'mixer が無い');
  truthy(/addEventListener\('finished', \(\) => stopMotion\(b\.name\)\)/.test(avatarSrc), 'AC-3: 終了で待機に戻していない');
  truthy(/if \(b\.mixer\) b\.mixer\.update\(delta\);\s*\n\s*else idle\(b, delta\);/.test(avatarSrc), '再生中に待機とボーンを取り合っている');
  truthy(avatarSrc.includes("em?.setValue('aa'"), 'AC-4: 口の駆動が mixer と分かれていない');
  truthy(roomTs.includes("path === '/motions'") && roomTs.includes("path.startsWith('/motions/')"), 'サーバの口が無い');
  truthy(/name\.includes\('\/'\)[\s\S]{0,120}listMotions\(\)\.includes\(name\)/.test(roomTs), '.vrma の名前が列挙 allowlist で守られていない');
  truthy(roomTs.includes("'@pixiv/three-vrm-animation/'"), 'vendor の allowlist に入っていない');
  const gate = roomTs.indexOf("if (req.method !== 'POST') return json(res, 404");
  truthy(roomTs.indexOf("path === '/motions'") < gate, 'GET /motions がゲートより後ろ（404 になる）');
});

t('AC-6/AC-7 二重再生しない・閉じたら止まる', () => {
  truthy(/stopMotion\(name\);\s+\/\/ AC-6/.test(avatarSrc), '再生前に止めていない');
  truthy(/function dispose\(\) \{\s*\n\s*stopped = true;\s*\n\s*stopMotion\(\);/.test(avatarSrc), 'dispose で止めていない');
});

t('サーバ: /avatars と /vendor が在り、vendor は許可した package の .js だけ', () => {
  truthy(roomTs.includes("path === '/avatars'"), '/avatars が無い');
  truthy(roomTs.includes("path.startsWith('/avatars/')"), '/avatars/<file> が無い');
  truthy(/name\.includes\('\/'\)[\s\S]{0,120}listAvatars\(\)\.includes\(name\)/.test(roomTs), '.vrm の名前が列挙 allowlist で守られていない');
  truthy(/const allowed = \['three\/'[^\]]*\]\.some/.test(roomTs), 'vendor の allowlist が無い');
  truthy(roomTs.includes("rel.includes('..')"), 'vendor の .. 検査が無い');
  truthy(roomTs.includes("rel.endsWith('.js')"), 'vendor が .js 以外も配っている');
});

t('依存は browser 側だけ（サーバの実行時依存を増やしていない）', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys(pkg.dependencies ?? {});
  truthy(deps.includes('three') && deps.includes('@pixiv/three-vrm'), 'three / three-vrm が dependencies に無い');
  truthy(!read('src/room.ts').includes("from 'three'"), 'サーバが three を import している');
  truthy(!read('src/persona.ts').includes("from 'three'"), 'persona が three を import している');
});


// ---- PBI-027: ゲームの出来事で動く（純関数なので直に叩ける）----
const FILES = ['Clapping.vrma', 'Sad.vrma', 'Surprised.vrma', 'Thinking.vrma'];
const view = (over = {}) => ({ kind: 'blackjack', title: 'ブラックジャック — チップ 1200 枚', moves: [], ...over });

t('AC-1 持ち分が増えたら喜ぶ', () => {
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), FILES), 'Clapping.vrma', '喜ばない');
});

t('AC-2 減ったら落ち込む', () => {
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 900 枚' }), FILES), 'Sad.vrma', '落ち込まない');
});

t('AC-3 🎉 の手が出たら驚く（持ち分が動く前に反応する）', () => {
  const before = view({ kind: 'mahjong', title: '麻雀 — 25000 点' });
  const after = view({ kind: 'mahjong', title: '麻雀 — 25000 点', moves: [{ label: '🎉 ツモ' }] });
  eq(gameMotion(before, after, FILES), 'Surprised.vrma', '驚かない');
  eq(gameMotion(after, after, FILES), null, '🎉 が出続けている間ずっと驚いている');
});

t('AC-4 持ち分が動いていなければ何もしない', () => {
  eq(gameMotion(view(), view(), FILES), null, '動いていないのに再生した');
  eq(gameMotion(null, view(), FILES), null, '開いた瞬間に踊った');
  eq(gameMotion(view(), { kind: null, title: 'いまは遊んでないよ' }, FILES), null, 'ゲームを閉じた時に再生した');
});

t('麻雀: 打牌で残り牌が減っても反応しない（点が動いた時だけ）', () => {
  const mj = (left, points) => ({ kind: 'mahjong', title: `麻雀 — 東1局 0本場 / 残り ${left} 枚`, moves: [], board: { seats: [{ at: 'self', points }] } });
  eq(gameMotion(mj(70, 25000), mj(69, 25000), FILES), null, '牌を切っただけで反応した');
  eq(gameMotion(mj(69, 25000), mj(68, 33000), FILES), 'Clapping.vrma', '和了っても喜ばない');
  eq(gameMotion(mj(69, 25000), mj(68, 21000), FILES), 'Sad.vrma', '振り込んでも落ち込まない');
});

t('AC-6 ゲームが変わった時は比べない', () => {
  const a = view({ kind: 'poker', title: 'ポーカー — ポット 40 / あなた 500 枚' });
  const b = view({ kind: 'mahjong', title: '麻雀 — 25000 点' });
  eq(gameMotion(a, b, FILES), null, '別ゲームの数字を比べた');
});

t('PBI-030 自作の活発な動きが在ればそちらを優先する', () => {
  const rich = ['Victory.vrma', 'JumpJoy.vrma', 'Frustrated.vrma', 'Clapping.vrma', 'Sad.vrma'];
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), rich), 'Victory.vrma', '喜びが控えめな方に落ちた');
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 900 枚' }), rich), 'Frustrated.vrma', '負けが見えない動きになった');
  // 無ければ従来の素材に降りる(置いていない人の環境を壊さない)
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), FILES), 'Clapping.vrma', '降り先が無い');
});

t('AC-5 置いていない動きは選ばない（素材ゼロなら null）', () => {
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), []), null, '無い素材を再生した');
  // 喜ぶ第一候補が無ければ次の候補に降りる
  eq(gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), ['Goodbye.vrma']), 'Goodbye.vrma', '代わりを選べない');
});

t('持ち分の読み取り（3 ゲームの実際の見出し）', () => {
  eq(stackOf({ title: 'ブラックジャック — チップ 1200 枚' }), 1200, 'BJ');
  // ポット(単位なし)ではなく**自分のチップ**を読む。ポットで反応すると、
  // 他人が賭けただけで喜んだり落ち込んだりする
  eq(stackOf({ title: 'ポーカー — ポット 40 / あなた 500 枚' }), 500, 'ポーカーは自分のチップを読む');
  eq(stackOf({ title: '麻雀 — 25000 点' }), 25000, '麻雀');
  // 麻雀の実際の見出しは「残り 70 枚」で**打牌のたびに減る**。そこを読むと 1 巡ごとに落ち込む
  eq(stackOf({ title: '麻雀 — 東1局 0本場 / 残り 70 枚' }), null, '場の残り牌を持ち分として読んだ');
  eq(stackOf({
    title: '麻雀 — 東1局 0本場 / 残り 70 枚',
    board: { seats: [{ at: 'self', points: 25000 }, { at: 'right', points: 25000 }] },
  }), 25000, '卓から自分の点を取れない');
  eq(stackOf({ title: 'いまは遊んでないよ' }), null, '数字が無い');
});

t('決定的（同じ入力 → 同じ出力）', () => {
  const a = gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), FILES);
  const b = gameMotion(view(), view({ title: 'ブラックジャック — チップ 1400 枚' }), FILES);
  eq(a, b, '揺れる');
});

t('配線: 盤面の更新で体と顔が反応する（キャラが居る時だけ）', () => {
  const room = read('public/room.js');
  truthy(/reactToGame\(lastGameView, v\)/.test(room), 'refreshGame が気分を出していない');
  truthy(/avatarStage && reactToGame/.test(room), 'キャラが居ない時にも呼んでいる');
  truthy(/avatarStage\.setMood\(mood\)/.test(room), '顔が反応していない(PBI-031)');
  truthy(/pickMotionForMood\?\.\(mood, motionFiles\)/.test(room), '同じ気分で動きを選んでいない');
  truthy(/motionFiles = motions/.test(room), '置いてある動きの一覧を覚えていない');
});

// ---- PBI-031: 顔と視線 ----
// AvatarSample_A が実際に持っていた preset(2026-08-16 実測)。**surprised は無く 'Surprised'**
const SAMPLE_FACES = ['neutral', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight',
  'angry', 'relaxed', 'happy', 'sad', 'Surprised', 'Extra'];

t('AC-1/2 気分が顔になる', () => {
  eq(emotionFor('win', SAMPLE_FACES), 'happy', '勝っても笑わない');
  eq(emotionFor('lose', SAMPLE_FACES), 'sad', '負けても顔が変わらない');
});

t('AC-3 大文字の独自名でも拾う（VRM0 由来のモデル）', () => {
  eq(emotionFor('big', SAMPLE_FACES), 'Surprised', '実測で在る名前を選べていない');
  // preset が無ければ次の候補に降りる
  eq(emotionFor('big', ['happy', 'sad']), 'happy', '代わりに降りられない');
  eq(emotionFor('lose', ['happy']), null, '持っていない顔を出そうとした');
  eq(emotionFor('win', []), null, '表情を持たないモデルで顔を出そうとした');
});

t('AC-4 表情は時間で戻る（顔が固まらない）', () => {
  eq(faceWeight(0), 1, '出した瞬間に薄い');
  truthy(faceWeight(1.75) > 0.4 && faceWeight(1.75) < 0.6, `半分の時点で ${faceWeight(1.75)}`);
  eq(faceWeight(5), 0, '5 秒たっても残っている');
  eq(faceWeight(999), 0, '下限を割った');
  truthy(faceWeight(1) > faceWeight(2), '単調に減っていない');
  // **フレームではなく時計で決める**(遅い描画でも 5 秒で戻る。実測で踏んだ)
  truthy(/performance\.now\(\) - b\.face\.at/.test(read('public/avatar.js')), 'フレームの積み上げに戻っている');
});

t('AC-5/AC-6 視線と表情の配線', () => {
  const av = read('public/avatar.js');
  truthy(/lookAt\.target = b\.gaze/.test(av), '目が的を追っていない');
  truthy(/performance\.now\(\) >= b\.saccadeAt/.test(av), '視線が固定のまま(saccade が無い)');
  truthy(/setValue\('aa', b\.mouth\)/.test(av) && /faceWeight\(\(performance/.test(av), '口と表情が別扱いになっていない');
});


// ---- PBI-032: agent ごとの体 ----
t('AC-2 ファイル名 = 名前 で割り当てる（大小・拡張子は無視）', () => {
  const got = assignBodies(['コハク.vrm', 'クロエ.vrm'], ['クロエ', 'コハク']);
  eq(JSON.stringify(got), JSON.stringify([{ name: 'クロエ', file: 'クロエ.vrm' }, { name: 'コハク', file: 'コハク.vrm' }]), '名前で対応していない');
  eq(assignBodies(['Chloe.VRM'], ['chloe'])[0].file, 'Chloe.VRM', '大小で外した');
});

t('AC-3 名前が合わなければ置いた順に配る', () => {
  const got = assignBodies(['a.vrm', 'b.vrm'], ['クロエ', 'コハク']);
  eq(got.map((x) => x.file).join(','), 'a.vrm,b.vrm', '順に配れていない');
  eq(got.map((x) => x.name).join(','), 'クロエ,コハク', '名前が付いていない');
  // 一致するものが 1 つだけ在る時は、それを優先してから残りを配る
  const mix = assignBodies(['x.vrm', 'コハク.vrm'], ['クロエ', 'コハク']);
  eq(mix.find((b) => b.name === 'コハク').file, 'コハク.vrm', '一致より順番を優先した');
  eq(mix.find((b) => b.name === 'クロエ').file, 'x.vrm', '余りを配れていない');
});

t('AC-6/AC-7 上限 3 体・体が無ければ空・在室者が分からなくても立つ', () => {
  eq(assignBodies(['a.vrm', 'b.vrm', 'c.vrm', 'd.vrm'], ['1', '2', '3', '4']).length, 3, '上限が効いていない');
  eq(assignBodies([], ['クロエ']).length, 0, '体が無いのに立てた');
  eq(assignBodies(['a.vrm'], []).length, 1, '在室者が空だと立たない（今までどおり 1 体が立つべき）');
  eq(assignBodies(['a.vrm'], [])[0].name, null, '名前が無いのに付いた');
});

t('AC-1/AC-4 配線: 体ごとの口と、喋っている人を向く視線', () => {
  const av = read('public/avatar.js');
  truthy(/mouthEnvelope\(b\.idleT, b === talker\)/.test(av), '喋っている体だけ口が動く形になっていない');
  truthy(/talker && b !== talker/.test(av), '聞いている人が喋っている人を見ていない');
  truthy(/window\.__clawSpeakingName/.test(av), '誰が喋っているかを読んでいない');
  const room = read('public/room.js');
  truthy(/__clawSpeakingName/.test(room), '部屋が「誰が喋っているか」を出していない');
  truthy(/loadAvatars\(/.test(room), '複数の体を立てていない');
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
