// PBI-025 の本丸: **.vrma が体を実際に動かすか**を、数字で確かめる。
//
// **なぜ数字なのか**（2026-08-16 に踏んだ）: 見た目の確認に `locator.screenshot()` を使うと、
// Playwright は「2 フレーム同じ絵」になるまで待つ。**動いている canvas は永遠に安定しない**ので、
// 時間切れになるか、動きの止まっている瞬間（＝待機の姿勢）が返る。
// それで「モーションが再生されていない」と誤診した。実際は全部動いていた。
// だからここでは絵を撮らず、**手が腰からどれだけ上がったか**（世界座標）を測る。
//
// 素材が無い機械（CI・他人の clone）では**黙って skip**する。素材は repo に入れない。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.MOTION_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));
const AV_DIR = join(homedir(), '.talkingclaw', 'avatars');
const MO_DIR = join(homedir(), '.talkingclaw', 'motions');
const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const skip = (why) => { console.log('skip    -', why); console.log('\n0/0 pass（素材が無いので測っていない）'); process.exit(0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vrms = existsSync(AV_DIR) ? readdirSync(AV_DIR).filter((f) => f.toLowerCase().endsWith('.vrm')) : [];
const vrmas = existsSync(MO_DIR) ? readdirSync(MO_DIR).filter((f) => f.toLowerCase().endsWith('.vrma')) : [];
if (vrms.length === 0 || vrmas.length === 0) skip('~/.talkingclaw/avatars/*.vrm と motions/*.vrma が要る');

function localChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))) {
      for (const rel of ['chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* 既定に任せる */ }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

let mod = null;
for (const c of [process.env.PLAYWRIGHT_MODULE, 'playwright', join(homedir(), 'shibubu-manager/projects/Shibubu/node_modules/playwright/index.mjs')].filter(Boolean)) {
  try { mod = await import(c); break; } catch { /* 次の候補 */ }
}
if (!mod) skip('playwright が見つからない');

const HOME = mkdtempSync(join(tmpdir(), 'claw-motionvis-'));
mkdirSync(join(HOME, '.talkingclaw', 'avatars'), { recursive: true });
mkdirSync(join(HOME, '.talkingclaw', 'motions'), { recursive: true });
copyFileSync(join(AV_DIR, vrms[0]), join(HOME, '.talkingclaw', 'avatars', vrms[0]));
// PBI-032: 2 体目は同じファイルの複製で足りる（見た目ではなく**別々に動くか**を測る）
copyFileSync(join(AV_DIR, vrms[0]), join(HOME, '.talkingclaw', 'avatars', 'コハク.vrm'));
// 腕を大きく上げる素材を選ぶ（無ければ先頭。閾値は下で素材に依らない形にしてある）
const motion = vrmas.find((m) => /goodbye|wave|clap/i.test(m)) ?? vrmas[0];
copyFileSync(join(MO_DIR, motion), join(HOME, '.talkingclaw', 'motions', motion));

const PORT = 3370 + Math.floor(Math.random() * 12);
const room = spawn(process.execPath, ['src/room.ts'], {
  cwd: REPO, env: { ...process.env, HOME, PORT: String(PORT), NO_CHLOE: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
});
const base = `http://127.0.0.1:${PORT}`;
let browser = null;
try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) { up = true; break; } } catch { /* まだ */ } await sleep(500); }
  if (!up) { fail('部屋が起動する', 'health が返らない'); } else {
    const token = JSON.parse(readFileSync(join(HOME, '.talkingclaw', 'room.json'), 'utf8')).token;
    browser = await mod.chromium.launch({ executablePath: localChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await p.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    // 自動で開く画面幅では押すと**閉じてしまう**ので、閉じている時だけ押す
    await p.evaluate(() => {
      if (getComputedStyle(document.getElementById('avatar')).display === 'none') document.getElementById('avatarBtn')?.click();
    });
    // 15MB の VRM を SwiftShader で読む。機械が混んでいると 30 秒では足りない（実測で落ちた）
    await p.waitForFunction(() => window.__clawStage?.loaded === true, { timeout: 120_000 });
    await p.evaluate((f) => { window.__firstVrm = f; }, vrms[0]);
    await p.waitForTimeout(1200);
    const dbg = () => p.evaluate(() => window.__clawStage.debug());

    const idle = await dbg();
    if (idle.handLift !== null && idle.handLift < 0.1) ok(`待機では手が下がっている（handLift=${idle.handLift}）`);
    else fail('待機では手が下がっている', `handLift=${idle.handLift}`);

    // AC-4 も同時に見る: 喋っている扱いにして再生し、**口が動き続ける**か
    await p.evaluate(() => { window.__clawSpeaking = true; });
    await p.evaluate((n) => window.__clawStage.playMotion('/motions/' + encodeURIComponent(n) + '?token=' + TOKEN), motion);
    let peak = -9, samples = 0, mouthMax = 0;
    for (let i = 0; i < 12; i++) {
      const d = await dbg();
      if (d.playing) { samples++; peak = Math.max(peak, d.handLift ?? -9); mouthMax = Math.max(mouthMax, d.mouth ?? 0); }
      await p.waitForTimeout(120);
    }
    await p.evaluate(() => { window.__clawSpeaking = false; });
    // AC-1: **体が実際に動く**。待機との差で見る（素材ごとの絶対値に依存しない）
    if (peak - idle.handLift > 0.25) ok(`再生で手が上がる（待機 ${idle.handLift} → 最大 ${Math.round(peak * 1000) / 1000}）`);
    else fail('再生で手が上がる', `待機 ${idle.handLift} / 最大 ${peak}（clip がボーンに届いていない）`);

    if (samples >= 3) ok(`再生中の標本が取れている（${samples} 点）`);
    else fail('再生中の標本が取れている', `${samples} 点しか再生していない`);

    if (mouthMax > 0.1) ok(`AC-4 再生中も口が動く（最大 ${mouthMax}）`);
    else fail('AC-4 再生中も口が動く', `口の開き最大 ${mouthMax}`);

    // AC-3: 終わったら待機に戻る（棒立ちで固まらない）
    for (let i = 0; i < 40 && (await dbg()).playing; i++) await p.waitForTimeout(200);
    const after = await dbg();
    if (!after.playing && after.handLift < 0.1) ok(`AC-3 終わったら待機へ戻る（handLift=${after.handLift}）`);
    else fail('AC-3 終わったら待機へ戻る', JSON.stringify({ playing: after.playing, handLift: after.handLift }));

    // PBI-031: 顔と視線（素材が要らないので、モーションが無くても効く）
    const faces = (await dbg()).expressions ?? [];
    if (faces.length > 0) {
      const shown = await p.evaluate(() => window.__clawStage.setMood('win'));
      await p.waitForTimeout(200);
      const d1 = await dbg();
      if (shown && d1.emotion?.weight > 0.5) ok(`AC-1 勝つと顔が変わる（${d1.emotion.name} = ${d1.emotion.weight}）`);
      else fail('AC-1 勝つと顔が変わる', JSON.stringify({ shown, emotion: d1.emotion, faces: faces.slice(0, 6) }));
      await p.waitForTimeout(5000);
      const d2 = await dbg();
      if ((d2.emotion?.weight ?? 0) < 0.1) ok(`AC-4 5 秒で戻る（${d2.emotion?.weight}）`);
      else fail('AC-4 5 秒で戻る', `weight=${d2.emotion?.weight}（顔が固まっている）`);
    } else {
      console.log('skip    - 表情を持たないモデル（AC-7 の側）');
    }
    {
      const g1 = (await dbg()).gaze;
      let moved = false;
      for (let i = 0; i < 20 && !moved; i++) { await p.waitForTimeout(300); const g = (await dbg()).gaze; moved = g[0] !== g1[0] || g[1] !== g1[1]; }
      if (moved) ok('AC-5 視線が動く（人形の目になっていない）');
      else fail('AC-5 視線が動く', `6 秒見て ${JSON.stringify(g1)} のまま`);
    }
    if ((await dbg()).hasLookAt) ok('AC-5 lookAt を持つモデルで目が的を追う設定になっている');
    else console.log('skip    - lookAt を持たないモデル');

    // ---- PBI-032: 体が 2 つ在る時、**喋っている人の口だけ**動く ----
    {
      const two = await p.evaluate(async () => {
        const { assignBodies } = await import('/avatar.js');
        const cast = assignBodies(['A.vrm', 'コハク.vrm'], ['クロエ', 'コハク']);
        await window.__clawStage.loadAvatars(cast.map((c) => ({
          name: c.name, url: '/avatars/' + encodeURIComponent(c.file === 'A.vrm' ? window.__firstVrm : c.file) + '?token=' + TOKEN,
        })));
        return window.__clawStage.debug().bodies;
      }).catch((e) => ({ error: String(e).slice(0, 120) }));
      if (Array.isArray(two) && two.length === 2) ok(`AC-1 2 体が並ぶ（x = ${two.map((b) => b.x).join(', ')}）`);
      else fail('AC-1 2 体が並ぶ', JSON.stringify(two));
      if (Array.isArray(two) && two[0].x !== two[1].x) ok('AC-1 重なっていない');
      else fail('AC-1 重なっていない', JSON.stringify(two));

      await p.evaluate(() => { window.__clawSpeaking = true; window.__clawSpeakingName = 'コハク'; });
      await p.waitForTimeout(900);
      const d = await dbg();
      const kohaku = d.bodies?.find((b) => b.name === 'コハク');
      const chloe = d.bodies?.find((b) => b.name === 'クロエ');
      if (kohaku?.mouth > 0.1 && (chloe?.mouth ?? 1) < 0.1) ok(`AC-2 喋っている人の口だけ動く（コハク ${kohaku.mouth} / クロエ ${chloe.mouth}）`);
      else fail('AC-2 喋っている人の口だけ動く', JSON.stringify(d.bodies));
      if (d.speaking === 'コハク') ok('AC-2 誰が喋っているかを部屋から受け取れている');
      else fail('AC-2 誰が喋っているかを部屋から受け取れている', `speaking=${d.speaking}`);
      await p.evaluate(() => { window.__clawSpeaking = false; window.__clawSpeakingName = null; });
    }

    const last = await dbg();
    if (last.frameErrors === 0) ok('描画が 1 フレームも落ちていない');
    else fail('描画が 1 フレームも落ちていない', `${last.frameErrors} 回: ${last.lastFrameError}`);
    if (last.frames > 20) ok(`実際に描画されている（${last.frames} フレーム）`);
    else fail('実際に描画されている', `${last.frames} フレームしか描いていない`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  room.kill('SIGKILL');
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} pass`);
process.exit(bad.length === 0 ? 0 : 1);
