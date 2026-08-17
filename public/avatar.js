// PBI-022: 部屋にキャラ(VRM)を立てる。喋ると口が動き、待機中もまばたきと呼吸で動く。
//
// **出どころ**: 描画の骨格は自分の ai-vtuber repo の `src/vrm.ts`(331 行)からの移植。
// この Wave では W1 の範囲だけを持ってきている —— 表情 preset / 視線 saccade /
// gesture 再生 / 感情連動は **W3 以降**なので入れていない(EP-004 の Wave 表)。
//
// **口の駆動**: 部屋の音声は `<audio>` 要素で鳴っている。AnalyserMode を挟むと
// 音声グラフに手を入れることになり、会話そのものを壊す危険がある(CLAUDE.md §2)。
// そこで v0 は **「鳴っているか」の 1 ビット(`window.__clawSpeaking`)だけ**を読み、
// 口の開き方はこちらで作る。精度が要るようになったら `mouth()` の中身だけ差し替える。
//
// **アバターが無い時は何もしない** —— `~/.talkingclaw/avatars/` が空なら部屋は今までどおり。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// 異周波 sin の重ね合わせ。周波数比を無理数寄せにして「同じ姿勢へ戻らない」揺れを作る。
// 係数和 = 1.0 なので |layered| <= 1.0(有界)。seed でパーツごとに非相関にする。
export function layered(t, seed) {
  return (
    Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.3 + seed * 1.7) * 0.3 +
    Math.sin(t * 0.37 + seed * 0.5) * 0.2
  );
}

// 喋っている間の口の開き(0..1)。母音ごとの本物の音量ではなく、
// **鳴っている間だけ動く有界な波**。止まれば 0 に落ちる(AC-4)。
export function mouthEnvelope(t, speaking) {
  if (!speaking) return 0;
  const v = 0.45 + layered(t * 6, 0.7) * 0.35; // 0.1 〜 0.8 のあたりで開閉
  return Math.max(0, Math.min(1, v));
}

// PBI-027: ゲームの出来事 → 再生する動き。**純関数**(時計も画面も触らない)。
//
// 判定は**数字**で行う —— 盤面の見出しに出ている自分の持ち分(`チップ 1200 枚` / `25000 点`)の増減。
// 「勝ち」という言葉を探すと、ゲームごと・言い回しごとに静かに壊れる。
// 並びは**実測の振れ幅が大きい順**(PBI-025 / PBI-030 の G2)。上から在るものを選ぶので、
// 自作の活発な動き(Victory / JumpJoy / Frustrated)を置いていればそちらが優先される
const MOOD_MOTIONS = {
  win: ['Victory', 'JumpJoy', 'Clapping', 'Goodbye', 'Jump'],
  lose: ['Frustrated', 'Sad', 'Sleepy', 'Angry'],   // Sad は手が 0.015 しか動かない = 見えない
  big: ['JumpJoy', 'Surprised', 'Jump'],
};

/**
 * 自分の持ち分を読む。読めなければ null(反応しない)。
 * **場に在る数(残り牌・ポット)は自分の持ち分ではない** —— 麻雀の見出しは打牌のたびに
 * 「残り 枚」が減るので、そこを読むと 1 巡ごとに落ち込む。
 */
export function stackOf(view) {
  const self = (view?.board?.seats ?? []).find((s) => s.at === 'self');
  if (typeof self?.points === 'number') return self.points;    // 麻雀は卓から自分の点を取る
  for (const m of String(view?.title ?? '').matchAll(/(残り|ポット)?\s*(\d[\d,]*)\s*(枚|点)/g)) {
    if (m[1]) continue;
    return Number(m[2].replace(/,/g, ''));
  }
  return null;
}

/** 前の盤面と今の盤面から「気分」を出す。体(動き)も顔(表情)も**同じ判定**を見る */
export function gameMood(prev, next) {
  if (!prev || !next || !next.kind) return null;        // 開いた瞬間には踊らない
  if (prev.kind !== next.kind) return null;             // 別ゲームの数字を比べない(AC-6)
  const hot = (v) => (v.moves ?? []).some((m) => String(m.label ?? '').includes('🎉'));
  if (hot(next) && !hot(prev)) return 'big';            // 和了れる / 勝負できる場面
  const a = stackOf(prev), b = stackOf(next);
  if (a === null || b === null || a === b) return null; // 動いていなければ何もしない(AC-4)
  return b > a ? 'win' : 'lose';
}

/** 気分 → 置いてある .vrma。**置いていない動きは選ばない**(素材が無ければ null) */
export function motionForMood(mood, files = []) {
  for (const name of MOOD_MOTIONS[mood] ?? []) {
    const hit = files.find((f) => f.toLowerCase().startsWith(name.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/** 盤面 2 つ → 再生する .vrma(無ければ null)。気分の判定と素材選びの合成 */
export function gameMotion(prev, next, files = []) {
  const mood = gameMood(prev, next);
  return mood ? motionForMood(mood, files) : null;
}

// ---- PBI-031: 顔と視線 ----
// 気分 → 表情 preset。**そのモデルが持っている名前しか使わない**(VRM0 由来のモデルは
// 大文字の独自名だったりする —— AvatarSample_A は 'Surprised' を持つが 'surprised' preset は無い)
const MOOD_FACES = { win: ['happy', 'relaxed'], lose: ['sad', 'angry'], big: ['surprised', 'happy'] };
const FACE_LIFE = 3.5;   // 秒。これを過ぎると顔は平常に戻る(固まらせない)

export function emotionFor(mood, available = []) {
  for (const want of MOOD_FACES[mood] ?? []) {
    const hit = available.find((a) => String(a).toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

/**
 * 顔を出してからの経過秒 → 重み。**フレームの積み上げではなく時計で決める** ——
 * 描画が遅い環境(SwiftShader・裏に回ったタブ)では delta を頭打ちにしているので、
 * 積み上げだと「5 秒待っても顔が戻らない」が起きる(2026-08-16 実測: 5 秒後に 0.34 残った)。
 */
export function faceWeight(elapsedSec, life = FACE_LIFE) {
  if (!(elapsedSec >= 0)) return 1;
  return Math.max(0, Math.min(1, 1 - elapsedSec / life));
}

const ARM_DOWN = 1.2;   // 上腕を下ろす角(rad ≈ 69°)。VRM 既定の T ポーズを A ポーズにする
const BLINK_DUR = 0.12; // まばたき 1 回の秒数
const MAX_BODIES = 3;   // 画角に収まる上限(増やすと 1 体が小さくなりすぎる)
const SPACING = 0.62;   // 体と体の間隔(m)

/**
 * PBI-032: 置いてある .vrm と在室者の名前 → 誰がどの体か。**純関数**。
 * 規則は 2 段: ①ファイル名 = 名前(大小無視)で一致した人に割り当てる
 * ②余った体を、まだ体の無い人へ**置いた順**に配る。**上限 3 体**。
 */
export function assignBodies(files = [], names = [], limit = MAX_BODIES) {
  const base = (f) => String(f).replace(/\.vrm$/i, '').toLowerCase();
  const used = new Set();
  const pairs = new Map();                       // name -> file(名前の並び順を保つ)
  for (const n of names) {
    const hit = files.find((f) => !used.has(f) && base(f) === String(n).toLowerCase());
    if (hit) { used.add(hit); pairs.set(n, hit); }
  }
  for (const n of names) {
    if (pairs.has(n)) continue;
    const hit = files.find((f) => !used.has(f));
    if (!hit) break;
    used.add(hit); pairs.set(n, hit);
  }
  const out = [...pairs].map(([name, file]) => ({ name, file }));
  // 在室者が分からない時でも、置いてある体は立てる(今までどおり動く)
  if (out.length === 0 && files.length > 0) out.push({ name: null, file: files[0] });
  return out.slice(0, limit);
}

/**
 * canvas に VRM を立てる(最大 3 体)。`loadAvatars([{name, url}])` で読み込み、
 * `dispose()` で完全に止める。**例外は握って外に出さない**(キャラの描画で会話を止めない)。
 */
export function createAvatarStage(canvas, opts = {}) {
  const isSpeaking = opts.isSpeaking ?? (() => !!window.__clawSpeaking);
  // 誰が喋っているか(名前)。分からない環境では null = 先頭の体が喋る(今までどおり)
  const speakerName = opts.speakerName ?? (() => window.__clawSpeakingName ?? null);

  const scene = new THREE.Scene();
  // 手を使う動き(拍手・手を振る)が枠から出ないよう、上半身が入る画角にする
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 1.15, 1.9);
  camera.lookAt(0, 1.15, 0);
  scene.add(camera);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0); // 透過(部屋の背景の上に乗る)

  const dir = new THREE.DirectionalLight(0xffffff, Math.PI);
  dir.position.set(1, 2, 1.5);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.5));

  /** 1 体ぶんの状態。**体ごとに独立**(口・まばたき・表情・再生中の動き) */
  const bodies = [];
  const newBody = (name, vrm, x) => ({
    name, vrm, x,
    idleT: Math.random() * 10,                 // 同じ呼吸で揃わないよう位相をずらす
    mouth: 0, blinkCountdown: 2 + Math.random() * 3, blinkPhase: -1,
    face: { name: null, at: 0, weight: 0 },
    mixer: null, action: null,
    gaze: new THREE.Object3D(), saccadeAt: 0, sacc: { x: 0, y: 0 },
  });

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  function blink(b, delta) {
    if (b.blinkPhase >= 0) {
      b.blinkPhase += delta;
      if (b.blinkPhase >= BLINK_DUR) { b.blinkPhase = -1; b.blinkCountdown = 2 + Math.random() * 3; return 0; }
      const half = BLINK_DUR / 2;
      return b.blinkPhase < half ? b.blinkPhase / half : 1 - (b.blinkPhase - half) / half; // 三角波
    }
    b.blinkCountdown -= delta;
    if (b.blinkCountdown <= 0) b.blinkPhase = 0;
    return 0;
  }

  // 待機モーション(素材不要): 腕を下ろす + 呼吸 + 重心移動 + 頭の微揺れ。
  // 毎フレーム絶対値で humanoid ボーンに書く(vrm.update が normalized → raw に反映する)
  function idle(b, delta) {
    const h = b.vrm?.humanoid;
    if (!h) return;
    b.idleT += delta;
    const breath = Math.sin(b.idleT * 1.4);      // 呼吸 ≈ 4.5 秒周期
    const sway = layered(b.idleT, 1.3);          // 重心移動
    h.getNormalizedBoneNode('leftUpperArm')?.rotation.set(0, 0, ARM_DOWN + breath * 0.03);
    h.getNormalizedBoneNode('rightUpperArm')?.rotation.set(0, 0, -ARM_DOWN - breath * 0.03);
    h.getNormalizedBoneNode('spine')?.rotation.set(breath * 0.02 + b.mouth * 0.03, sway * 0.08, 0);
    h.getNormalizedBoneNode('chest')?.rotation.set(breath * 0.015, 0, 0);
    h.getNormalizedBoneNode('head')?.rotation.set(
      breath * 0.015 + b.mouth * 0.06,
      layered(b.idleT, 3.1) * 0.15,
      0,
    );
  }

  /** 名前で体を探す。名前が分からなければ先頭(今までどおり 1 体で動く) */
  const bodyOf = (name) => (name == null ? bodies[0]
    : bodies.find((b) => b.name != null && String(b.name).toLowerCase() === String(name).toLowerCase()) ?? null);

  /** いま喋っている体。名前が取れない時は「誰かが喋っている」なら先頭 */
  function speakingBody() {
    const n = speakerName();
    const named = n != null ? bodyOf(n) : null;
    if (named) return named;
    return isSpeaking() ? bodies[0] ?? null : null;
  }

  // PBI-025: .vrma の再生。待機モーションは土台のままで、再生中だけボーンを mixer に譲る
  const motionCache = new Map();

  async function playMotion(url, name) {
    const b = bodyOf(name);
    if (!b) throw new Error('キャラがまだ居ない');
    const key = `${b.name ?? 0}|${url}`;
    let clip = motionCache.get(key);
    if (!clip) {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      const anim = gltf.userData.vrmAnimations?.[0];
      if (!anim) throw new Error('VRM Animation ではないファイルでした');
      clip = createVRMAnimationClip(anim, b.vrm);
      motionCache.set(key, clip);
    }
    stopMotion(name);                   // AC-6: 二重再生しない
    b.mixer = new THREE.AnimationMixer(b.vrm.scene);
    b.action = b.mixer.clipAction(clip);
    b.action.setLoop(THREE.LoopOnce, 1);
    b.action.clampWhenFinished = false; // AC-3: 終わったら待機へ戻す
    b.action.play();
    b.mixer.addEventListener('finished', () => stopMotion(b.name));
  }

  function stopMotion(name) {
    const targets = name === undefined ? bodies : [bodyOf(name)].filter(Boolean);
    for (const b of targets) {
      if (b.action) { b.action.stop(); b.action = null; }
      if (b.mixer) { b.mixer.stopAllAction(); b.mixer.uncacheRoot(b.mixer.getRoot()); b.mixer = null; }
    }
  }

  const clock = new THREE.Clock();
  let raf = 0;
  let frames = 0, frameErrors = 0, lastFrameError = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    // 裏に回っていた間の空白をそのまま渡すと、戻った瞬間にモーションが飛ぶ。1 フレーム分で頭打ちにする
    const delta = Math.min(clock.getDelta(), 0.1);
    try {
      const talker = speakingBody();
      for (const b of bodies) {
        if (!b.vrm) continue;
        // 口: 生の波をそのまま入れるとカクつくので、少しなまして入れる。**喋っている体だけ**動く
        const target = mouthEnvelope(b.idleT, b === talker);
        b.mouth += (target - b.mouth) * Math.min(1, delta * 12);
        const em = b.vrm.expressionManager;
        em?.setValue('aa', b.mouth);
        if (em) em.setValue('blink', blink(b, delta));
        // 気分の表情: 出したら時間で戻す(口・まばたきとは別の preset なので喧嘩しない)
        if (b.face.name && em) {
          b.face.weight = faceWeight((performance.now() - b.face.at) / 1000);
          em.setValue(b.face.name, b.face.weight);
          if (b.face.weight === 0) b.face = { name: null, at: 0, weight: 0 };
        }
        // 視線: 喋っている人はこちら、聞いている人は**喋っている人**を見る。数秒ごとに少し外す
        // 視線の移りも**時計で決める**(表情と同じ理由。低 fps で「目が固まる」を避ける)
        if (performance.now() >= b.saccadeAt) {
          b.saccadeAt = performance.now() + (1500 + Math.random() * 2500);
          b.sacc.x = (Math.random() - 0.5) * 0.28;
          b.sacc.y = (Math.random() - 0.5) * 0.16;
        }
        if (talker && b !== talker) {
          const head = talker.vrm.humanoid?.getRawBoneNode?.('head');
          const at = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(talker.x, 1.3, 0);
          b.gaze.position.set(at.x + b.sacc.x * 0.3, at.y + b.sacc.y * 0.3, at.z);
        } else {
          b.gaze.position.set(camera.position.x + b.sacc.x, camera.position.y + b.sacc.y, camera.position.z);
        }
        // 再生中はボーンを mixer に任せる(取り合うとちらつく)。口とまばたきは別なので動き続ける(AC-4)
        if (b.mixer) b.mixer.update(delta);
        else idle(b, delta);
        b.vrm.update(delta);
      }
      renderer.render(scene, camera);
      frames++;
    } catch (e) {
      // 1 フレーム落ちても次で立て直す(会話は止めない)。
      // ただし**黙らせない** —— ここを握り潰すと「動いているのに絵が変わらない」が原因不明になる
      frameErrors++;
      lastFrameError = String(e?.message ?? e).slice(0, 200);
    }
  };
  tick();

  function clearBodies() {
    stopMotion();
    for (const b of bodies) {
      scene.remove(b.vrm.scene);
      scene.remove(b.gaze);
      VRMUtils.deepDispose(b.vrm.scene);
    }
    bodies.length = 0;
    motionCache.clear();
  }

  async function loadOne(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const loaded = gltf.userData.vrm;
    if (!loaded) throw new Error('VRM ではないファイルでした');
    VRMUtils.rotateVRM0(loaded); // VRM0 系を正面向きに補正
    return loaded;
  }

  /** [{ name, url }] を並べて立たせる。**読めなかった体は飛ばす**(1 体失敗で全部消さない) */
  async function loadAvatars(list) {
    const wanted = list.slice(0, MAX_BODIES);
    const loaded = [];
    for (const item of wanted) {
      try { loaded.push({ name: item.name ?? null, vrm: await loadOne(item.url) }); }
      catch (e) { if (wanted.length === 1) throw e; }   // 1 体だけなら理由を上へ(今までどおり)
    }
    if (loaded.length === 0) throw new Error('立たせられる体が 1 つも無い');
    clearBodies();
    loaded.forEach(({ name, vrm }, i) => {
      const x = (i - (loaded.length - 1) / 2) * SPACING;
      const b = newBody(name, vrm, x);
      vrm.scene.position.x = x;
      if (vrm.lookAt) vrm.lookAt.target = b.gaze;   // PBI-031: 目が合う(持っていないモデルは素通り)
      scene.add(vrm.scene);
      scene.add(b.gaze);
      bodies.push(b);
    });
    // 人数が増えたら少し引く(はみ出さない・小さくしすぎない)
    camera.position.set(0, 1.15, 1.9 + (loaded.length - 1) * 0.55);
    camera.lookAt(0, 1.15, 0);
    resize();
  }

  /** 1 体だけ立たせる(PBI-022 からの口。名前は付かない) */
  const loadVRM = (url) => loadAvatars([{ name: null, url }]);

  function dispose() {
    stopped = true;
    stopMotion();   // AC-7: 閉じたら再生も止める
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    clearBodies();
    renderer.dispose();
  }

  const first = () => bodies[0] ?? null;
  const q = (node) => node?.quaternion?.toArray?.().map((n) => Math.round(n * 1000) / 1000) ?? null;
  const lift = (bone, b = first()) => {
    const h = b?.vrm?.humanoid;
    const hand = h?.getRawBoneNode?.(bone), hips = h?.getRawBoneNode?.('hips');
    if (!hand || !hips) return null;
    return Math.round((hand.getWorldPosition(new THREE.Vector3()).y - hips.getWorldPosition(new THREE.Vector3()).y) * 1000) / 1000;
  };

  /** 気分の表情を出す。**持っていない preset は出さない**(AC-7) */
  function setMood(mood, name) {
    const b = bodyOf(name);
    const names = b?.vrm?.expressionManager?.expressions?.map((e) => e.expressionName) ?? [];
    const face = emotionFor(mood, names);
    if (!face || !b) return null;
    if (b.face.name && b.face.name !== face) b.vrm.expressionManager?.setValue(b.face.name, 0);
    b.face = { name: face, at: performance.now(), weight: 1 };
    return face;
  }

  return {
    loadVRM, loadAvatars, playMotion, stopMotion, dispose, resize, setMood,
    get loaded() { return bodies.length > 0; },
    // 検査から「本当に再生されているか」を見るための口(見た目だけでは判定できないため)
    isPlaying: (name) => { const b = bodyOf(name); return !!(b?.action && b?.mixer); },
    // 読み取りだけの窓。**画面を見ても分からない**ことを機械で確かめるために置いてある
    debug: () => {
      const b = first();
      const action = b?.action, mixer = b?.mixer, vrm = b?.vrm;
      return {
        frames, frameErrors, lastFrameError,
        mouth: Math.round((b?.mouth ?? 0) * 100) / 100,   // 口の開き(AC-4: 動きの再生中も動くこと)
        playing: !!action,
        running: action?.isRunning?.() ?? null,
        time: action?.time ?? null,
        weight: action?.getEffectiveWeight?.() ?? null,
        tracks: action?.getClip?.()?.tracks?.length ?? null,
        firstTrack: action?.getClip?.()?.tracks?.[0]?.name ?? null,
        hipsQuat: q(vrm?.humanoid?.getNormalizedBoneNode('hips')),
        armQuat: q(vrm?.humanoid?.getNormalizedBoneNode('leftUpperArm')),
        // **正規化ボーンが動いても、生ボーンに移らなければ見た目は変わらない**。その 2 つを同時に出す
        rawArmQuat: q(vrm?.humanoid?.getRawBoneNode?.('leftUpperArm')),
        // clip の本数ではなく、**mixer の根から実際に見つかる**本数
        bound: action ? action.getClip().tracks.filter((t) => mixer.getRoot().getObjectByName(t.name.split('.')[0])).length : null,
        // 手が腰からどれだけ上に在るか(世界座標)。**両手**を見る(片腕だけの動きを見落とさない)
        handLift: lift('leftHand'),
        handLiftR: lift('rightHand'),
        expressions: vrm?.expressionManager?.expressions?.map((e) => e.expressionName) ?? null,
        hasLookAt: !!vrm?.lookAt,
        emotion: { name: b?.face.name ?? null, weight: Math.round((b?.face.weight ?? 0) * 100) / 100 },
        gaze: [Math.round((b?.sacc.x ?? 0) * 100) / 100, Math.round((b?.sacc.y ?? 0) * 100) / 100],
        // PBI-032: 立っている体ぜんぶ(名前・位置・口の開き)。**別々に動いているか**を見る
        speaking: speakingBody()?.name ?? (speakingBody() ? '(先頭)' : null),
        bodies: bodies.map((x) => ({ name: x.name, x: Math.round(x.x * 100) / 100, mouth: Math.round(x.mouth * 100) / 100 })),
      };
    },
  };
}
