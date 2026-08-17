// PBI-030: **活発な動きを自分で作る**。配布されている .vrma は落ち着いた仕草が多く、
// 実測でも手の振れ幅が小さいものが半分あった(Angry 0.008 / Sad 0.015 / LookAround 0.03)。
// 探し回る代わりにキーフレームを書き、.vrma に焼く。ログインもライセンスの縛りも無い。
//
// **変換は自作しない** —— text-to-vrma(MIT)の builder をそのまま使う:
//   git clone --depth 1 https://github.com/Kirakun0328/text-to-vrma ~/src/text-to-vrma && (cd $_ && npm install)
//   node tools/make-motions.mjs ~/.talkingclaw/motions
//
// 腕の符号は**実測で決めた**(2026-08-16): 左腕は +Z で上がり、右腕は -Z で上がる。
// 逆にすると腕が下がるだけで「動いていない」ように見える。変える時は必ず手の高さを測り直すこと
// (`test/check-motion-visible.mjs` が待機 -0.09 → 再生 +0.5 を見ている)。
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUILDER = process.env.VRMA_BUILDER ?? join(homedir(), 'src/text-to-vrma/src/vrmaBuilder.js');
const { buildVRMA } = await import(BUILDER).catch(() => {
  console.error(`text-to-vrma が見つからない: ${BUILDER}\n  git clone --depth 1 https://github.com/Kirakun0328/text-to-vrma ~/src/text-to-vrma && (cd ~/src/text-to-vrma && npm install)`);
  process.exit(1);
});

const OUT = process.argv[2] ?? join(homedir(), '.talkingclaw', 'motions');
mkdirSync(OUT, { recursive: true });

// 腕の向き。**符号は実測で決める**(モデルによって上下が逆になるので、作ったら手の高さを測る)
const S = Number(process.env.ARM_SIGN ?? 1);    // 左腕を上げる回転の符号(実測で +1)
const upL = (deg) => S * deg;                    // 左: 上げる
const upR = (deg) => -S * deg;                   // 右: 上げる(左の逆)

const k = (t, r) => ({ t, r });

// 1) ダンス — 体重移動 + 腕の交互上げ + 頭のノリ(ループ)
const dance = {
  name: 'Dance', duration: 4, loop: true,
  hips: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map((t, i) => ({ t, p: [i % 2 ? 0.07 : -0.07, i % 2 ? 0.04 : 0, 0] })),
  tracks: {
    spine: [0, 1, 2, 3, 4].map((t, i) => k(t, [0, i % 2 ? 12 : -12, i % 2 ? 6 : -6])),
    chest: [0, 1, 2, 3, 4].map((t, i) => k(t, [i % 2 ? 6 : -3, 0, 0])),
    head: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map((t, i) => k(t, [i % 2 ? 10 : -6, i % 2 ? -12 : 12, 0])),
    leftUpperArm: [k(0, [0, 0, upL(20)]), k(0.5, [0, 0, upL(110)]), k(1, [0, 0, upL(30)]), k(1.5, [0, 0, upL(120)]),
      k(2, [0, 0, upL(20)]), k(2.5, [0, 0, upL(110)]), k(3, [0, 0, upL(30)]), k(3.5, [0, 0, upL(120)]), k(4, [0, 0, upL(20)])],
    rightUpperArm: [k(0, [0, 0, upR(110)]), k(0.5, [0, 0, upR(25)]), k(1, [0, 0, upR(120)]), k(1.5, [0, 0, upR(30)]),
      k(2, [0, 0, upR(110)]), k(2.5, [0, 0, upR(25)]), k(3, [0, 0, upR(120)]), k(3.5, [0, 0, upR(30)]), k(4, [0, 0, upR(110)])],
    leftLowerArm: [k(0, [0, -40, 0]), k(1, [0, -70, 0]), k(2, [0, -40, 0]), k(3, [0, -70, 0]), k(4, [0, -40, 0])],
    rightLowerArm: [k(0, [0, 40, 0]), k(1, [0, 70, 0]), k(2, [0, 40, 0]), k(3, [0, 70, 0]), k(4, [0, 40, 0])],
    leftUpperLeg: [k(0, [-8, 0, 0]), k(1, [4, 0, 0]), k(2, [-8, 0, 0]), k(3, [4, 0, 0]), k(4, [-8, 0, 0])],
    rightUpperLeg: [k(0, [4, 0, 0]), k(1, [-8, 0, 0]), k(2, [4, 0, 0]), k(3, [-8, 0, 0]), k(4, [4, 0, 0])],
  },
  expressions: { happy: [{ t: 0, w: 0.6 }, { t: 4, w: 0.6 }] },
};

// 2) ジャンプ — しゃがむ → 跳ぶ → 着地(手も一緒に上がる)
const jump = {
  name: 'JumpJoy', duration: 1.8, loop: false,
  hips: [{ t: 0, p: [0, 0, 0] }, { t: 0.3, p: [0, -0.14, 0] }, { t: 0.6, p: [0, 0.38, 0] },
    { t: 0.9, p: [0, 0.42, 0] }, { t: 1.2, p: [0, -0.10, 0] }, { t: 1.8, p: [0, 0, 0] }],
  tracks: {
    leftUpperArm: [k(0, [0, 0, upL(15)]), k(0.3, [0, 0, upL(-20)]), k(0.7, [0, 0, upL(150)]), k(1.2, [0, 0, upL(40)]), k(1.8, [0, 0, upL(15)])],
    rightUpperArm: [k(0, [0, 0, upR(15)]), k(0.3, [0, 0, upR(-20)]), k(0.7, [0, 0, upR(150)]), k(1.2, [0, 0, upR(40)]), k(1.8, [0, 0, upR(15)])],
    leftUpperLeg: [k(0, [0, 0, 0]), k(0.3, [-45, 0, 0]), k(0.7, [10, 0, 0]), k(1.2, [-40, 0, 0]), k(1.8, [0, 0, 0])],
    rightUpperLeg: [k(0, [0, 0, 0]), k(0.3, [-45, 0, 0]), k(0.7, [10, 0, 0]), k(1.2, [-40, 0, 0]), k(1.8, [0, 0, 0])],
    leftLowerLeg: [k(0, [0, 0, 0]), k(0.3, [70, 0, 0]), k(0.7, [5, 0, 0]), k(1.2, [65, 0, 0]), k(1.8, [0, 0, 0])],
    rightLowerLeg: [k(0, [0, 0, 0]), k(0.3, [70, 0, 0]), k(0.7, [5, 0, 0]), k(1.2, [65, 0, 0]), k(1.8, [0, 0, 0])],
    spine: [k(0, [0, 0, 0]), k(0.3, [14, 0, 0]), k(0.7, [-8, 0, 0]), k(1.8, [0, 0, 0])],
    head: [k(0, [0, 0, 0]), k(0.7, [-14, 0, 0]), k(1.8, [0, 0, 0])],
  },
  expressions: { happy: [{ t: 0, w: 0.3 }, { t: 0.7, w: 1 }, { t: 1.8, w: 0.4 }] },
};

// 3) ガッツポーズ — 両拳を握って引き寄せ、跳ねる
const victory = {
  name: 'Victory', duration: 2.4, loop: false,
  hips: [{ t: 0, p: [0, 0, 0] }, { t: 0.6, p: [0, 0.12, 0] }, { t: 0.9, p: [0, 0, 0] }, { t: 1.4, p: [0, 0.08, 0] }, { t: 2.4, p: [0, 0, 0] }],
  tracks: {
    leftUpperArm: [k(0, [0, 0, upL(20)]), k(0.4, [0, 0, upL(135)]), k(0.9, [0, 0, upL(100)]), k(1.4, [0, 0, upL(140)]), k(2.4, [0, 0, upL(25)])],
    rightUpperArm: [k(0, [0, 0, upR(20)]), k(0.4, [0, 0, upR(135)]), k(0.9, [0, 0, upR(100)]), k(1.4, [0, 0, upR(140)]), k(2.4, [0, 0, upR(25)])],
    leftLowerArm: [k(0, [0, -20, 0]), k(0.4, [0, -95, 0]), k(2.4, [0, -25, 0])],
    rightLowerArm: [k(0, [0, 20, 0]), k(0.4, [0, 95, 0]), k(2.4, [0, 25, 0])],
    spine: [k(0, [0, 0, 0]), k(0.4, [-12, 0, 0]), k(2.4, [0, 0, 0])],
    head: [k(0, [0, 0, 0]), k(0.4, [-18, 0, 0]), k(1.4, [-8, 0, 0]), k(2.4, [0, 0, 0])],
  },
  expressions: { happy: [{ t: 0, w: 0.5 }, { t: 0.5, w: 1 }, { t: 2.4, w: 0.6 }] },
};

// 4) 大きく手を振る — 片腕を高く上げて左右に大きく
const bigWave = {
  name: 'BigWave', duration: 3, loop: false,
  tracks: {
    rightUpperArm: [k(0, [0, 0, upR(20)]), k(0.4, [0, 0, upR(140)]), k(2.6, [0, 0, upR(140)]), k(3, [0, 0, upR(25)])],
    rightLowerArm: [k(0.4, [0, 30, 0]), k(0.9, [0, 30, -35]), k(1.4, [0, 30, 35]), k(1.9, [0, 30, -35]), k(2.4, [0, 30, 25]), k(3, [0, 20, 0])],
    leftUpperArm: [k(0, [0, 0, upL(20)]), k(3, [0, 0, upL(20)])],
    spine: [k(0, [0, 0, 0]), k(0.9, [0, -8, 0]), k(1.9, [0, 8, 0]), k(3, [0, 0, 0])],
    head: [k(0, [0, 0, 0]), k(0.9, [-8, -10, 0]), k(1.9, [-8, 10, 0]), k(3, [0, 0, 0])],
    hips: undefined,
  },
  expressions: { happy: [{ t: 0, w: 0.7 }, { t: 3, w: 0.5 }] },
};

// 5) 悔しがる — 両手を頭に、前に崩れる(既存の Sad は手がほぼ動かないので、見える負け方を作る)
const frustrated = {
  name: 'Frustrated', duration: 2.6, loop: false,
  hips: [{ t: 0, p: [0, 0, 0] }, { t: 0.8, p: [0, -0.10, 0] }, { t: 2.6, p: [0, -0.04, 0] }],
  tracks: {
    leftUpperArm: [k(0, [0, 0, upL(20)]), k(0.5, [0, 0, upL(95)]), k(2.6, [0, 0, upL(80)])],
    rightUpperArm: [k(0, [0, 0, upR(20)]), k(0.5, [0, 0, upR(95)]), k(2.6, [0, 0, upR(80)])],
    leftLowerArm: [k(0, [0, -20, 0]), k(0.5, [0, -120, 0]), k(2.6, [0, -110, 0])],
    rightLowerArm: [k(0, [0, 20, 0]), k(0.5, [0, 120, 0]), k(2.6, [0, 110, 0])],
    spine: [k(0, [0, 0, 0]), k(0.8, [22, 0, 0]), k(2.6, [16, 0, 0])],
    chest: [k(0, [0, 0, 0]), k(0.8, [10, 0, 0]), k(2.6, [8, 0, 0])],
    head: [k(0, [0, 0, 0]), k(0.8, [26, 0, 0]), k(2.6, [22, 0, 0])],
    leftUpperLeg: [k(0, [0, 0, 0]), k(0.8, [-18, 0, 0]), k(2.6, [-10, 0, 0])],
    rightUpperLeg: [k(0, [0, 0, 0]), k(0.8, [-18, 0, 0]), k(2.6, [-10, 0, 0])],
    leftLowerLeg: [k(0, [0, 0, 0]), k(0.8, [30, 0, 0]), k(2.6, [18, 0, 0])],
    rightLowerLeg: [k(0, [0, 0, 0]), k(0.8, [30, 0, 0]), k(2.6, [18, 0, 0])],
  },
  expressions: { sad: [{ t: 0, w: 0.4 }, { t: 0.8, w: 1 }, { t: 2.6, w: 0.9 }] },
};

for (const spec of [dance, jump, victory, bigWave, frustrated]) {
  const glb = buildVRMA(spec);
  writeFileSync(`${OUT}/${spec.name}.vrma`, Buffer.from(glb));
  console.log(`${spec.name}.vrma ${glb.byteLength} bytes`);
}
