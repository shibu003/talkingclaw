// PBI-009: 開いたパネルが「読める」ことを geometry で測る。稼働中の部屋(3300)/ engine(10101)には
// 触らない — 空きポート + 一時 HOME の隔離部屋と、fake の engine / Fish だけを使う。
//
// 実行:      node test/check-ui-geometry.mjs
// 負の対照:  UI_GEOM_BASELINE=a522e2c node test/check-ui-geometry.mjs
//            → 修理前の public/ を一時ツリーへ取り出して当てる。**赤くならなければ検査が無意味**
//
// なぜこの検査が要るか(PBI-009 AC-4): 従来の geometry 検査は「#log と重なるか」しか見ていない。
// 幅 27px まで潰れたパネルは何とも重ならないので、**壊れているほど緑で通る**穴があった。
// 「パネルの content 幅 >= 320px」を主 assert に据えて、その穴を塞ぐ。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BASELINE = process.env.UI_GEOM_BASELINE ?? '';
// 変異(木のコピーに当てる)。clamp / uplift を外して、AC-8 が本当に赤くなるかを測る
const MUTATE = process.env.UI_GEOM_MUTATE ?? '';
const MIN_PANEL_W = 320;   // PBI-009 AC-1: これ未満は「読めない」
const MIN_LOG_DVH = 0.35;  // PBI-008 AC-10 の維持
const MAX_LABEL_LINES = 3;
const VIEWPORTS = [
  { tag: 'desktop', w: 1440, h: 900 },
  { tag: 'laptop', w: 1024, h: 768 },
  { tag: 'mobile', w: 390, h: 844 },
];

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((r) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

function wav() {
  const b = Buffer.alloc(844);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(836, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(800, 40);
  return b;
}

// fake AivisSpeech(話者一覧を返すだけ)。本物の 10101 には 1 リクエストも出さない
async function engineFake() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('"fake"'); }
    if (u.pathname === '/speakers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        { name: 'まお', styles: [{ name: 'あまあま', id: 1 }, { name: 'ノーマル', id: 2 }] },
        { name: 'まい', styles: [{ name: 'ノーマル', id: 3 }] },
      ]));
    }
    if (u.pathname === '/audio_query') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ speedScale: 1 })); }
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav());
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

// fake Fish(候補一覧。長い名前を混ぜて折返しも測れるようにする)
async function fishFake() {
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/model') {
      const items = [];
      for (let i = 0; i < 12; i++) items.push({ _id: `m${i}`, title: i === 0 ? 'とても長い声の名前'.repeat(8) : `アニメ声 ${i}`, tags: ['anime'], languages: ['ja'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items, has_more: false }));
    }
    const c = []; for await (const x of req) c.push(x);
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav());
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

function localChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      for (const rel of ['chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* 無ければ playwright の既定に任せる */ }
  return undefined;
}

async function resolvePlaywright() {
  const cands = [];
  if (process.env.PLAYWRIGHT_MODULE) cands.push(process.env.PLAYWRIGHT_MODULE);
  cands.push('playwright');
  const npx = join(homedir(), '.npm', '_npx');
  try { for (const d of readdirSync(npx)) cands.push(join(npx, d, 'node_modules', 'playwright', 'index.mjs')); } catch { /* 無ければ飛ばす */ }
  cands.push(join(homedir(), '.claude', 'skills', 'gstack', 'node_modules', 'playwright', 'index.mjs'));
  for (const c of cands) {
    try { const mod = await import(c); return { browser: await mod.chromium.launch({ executablePath: localChromium() }) }; } catch { /* 次の候補へ */ }
  }
  return { browser: null };
}

// 負の対照用のコピーツリー。**src は現行のまま・public/ だけを修理前へ戻す**ので、
// 「今の検査が、修理前の画面を赤く出せるか」を測れる。
// git archive を使う理由: `git checkout <ref> -- path` は共有ツリーの index を汚す
// (他セッションが stage 中のものを巻き込む)。archive は index に一切触らない。
function baselineTree() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-geom-base-'));
  for (const p of ['src', 'package.json', 'tsconfig.json']) {
    execFileSync('cp', ['-R', join(REPO, p), dir]);
  }
  execFileSync('ln', ['-s', join(REPO, 'node_modules'), join(dir, 'node_modules')]);
  execFileSync('sh', ['-c', `git -C '${REPO}' archive ${BASELINE} public | tar -x -C '${dir}'`]);
  return dir;
}

// clamp を外した木を作る(負の対照)。共有ツリーには 1 バイトも書かない
function mutatedTree() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-geom-mut-'));
  for (const p of ['src', 'public', 'package.json', 'tsconfig.json']) execFileSync('cp', ['-R', join(REPO, p), dir]);
  execFileSync('ln', ['-s', join(REPO, 'node_modules'), join(dir, 'node_modules')]);
  let targetFile = 'public/room.js';
  const expr = MUTATE === 'no-clamp'
    // drag の下限を px clamp から元の 22% へ戻す(1440px で 316.8px = content 287px)
    ? 's/const minPx = SIDE_MIN_PX;/const minPx = window.innerWidth * 0.22;/'
    : MUTATE === 'no-narrow-entry'
      // 狭い画面の到達導線を殺す(rail の無い帯で作成フォームへ行けなくなる)
      ? { file: 'public/index.html', expr: 's/<button id="roomAdminOpen" class="linkbtn" hidden>/<button id="roomAdminOpen" class="linkbtn" hidden style="display:none!important">/' }
    : MUTATE === 'no-uplift'
      // 保存済みの狭すぎる値をそのまま採用する(引き上げ判定を常に「足りている」にする)
      ? 's/px >= SIDE_MIN_PX/true/'
      : null;
  if (!expr) throw new Error(`未知の UI_GEOM_MUTATE: ${MUTATE}(no-clamp|no-uplift|no-narrow-entry)`);
  const spec = typeof expr === 'string' ? { file: targetFile, expr } : expr;
  const target = join(dir, spec.file);
  const before = execFileSync('cat', [target]).toString();
  execFileSync('perl', ['-0pi', '-e', spec.expr, target]);
  if (execFileSync('cat', [target]).toString() === before) throw new Error(`変異が当たっていない: ${MUTATE}`);
  return dir;
}

async function startRoom({ engineBase, fishBase, root }) {
  const home = mkdtempSync(join(tmpdir(), 'claw-geom-'));
  const port = await freePort();
  const env = {
    ...process.env, HOME: home, PORT: String(port), NO_CHLOE: '1',
    TTS_URL: engineBase, FISH_API_KEY: 'GEOM_FAKE_KEY', FISH_API_BASE: fishBase,
  };
  const proc = spawn(process.execPath, ['src/room.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error('部屋が起動しない:\n' + out.slice(-800)); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })).status === 200) break; } catch { /* 起動待ち */ }
    await sleep(200);
  }
  return { port, proc, home, stop: () => { try { proc.kill('SIGTERM'); } catch { /* 既に死んでいる */ } } };
}

// ---- discovery: 修理前 / 修理後で **同じ手順**で要素を見つける(F1)----
// id で引くと markup 移動で「見つからない赤」になり、幅 assert が一度も発火せずに
// 負の対照が成立してしまう。見出しの文字から container を辿る = 両 build 共通の道。
const DISCOVER = (headingText) => {
  const heads = [...document.querySelectorAll('h1,h2,h3,legend,summary')]
    .filter((e) => (e.textContent ?? '').trim() === headingText);
  if (heads.length === 0) return null;
  // 見出しの親のうち「パネルらしい箱」= 背景か枠を持つ最初の祖先
  let el = heads[0].parentElement;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (cs.borderTopWidth !== '0px' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)') return el;
    el = el.parentElement;
  }
  return heads[0].parentElement;
};

// ---- ページ内で測る(1 関数にまとめて 1 往復で取る)----
const MEASURE = (opts) => {
  const { panelId, bodyId, minPanelW, minLogDvh, heading } = opts;
  const discover = (headingText) => {
    const heads = [...document.querySelectorAll('h1,h2,h3,legend,summary')]
      .filter((e) => (e.textContent ?? '').trim() === headingText);
    if (heads.length === 0) return null;
    let el = heads[0].parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (cs.borderTopWidth !== '0px' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)') return el;
      el = el.parentElement;
    }
    return heads[0].parentElement;
  };
  const panel = discover(heading) ?? document.getElementById(panelId);
  if (!panel) return { notFound: true, heading };
  const log = document.getElementById('log');
  const r = (e) => e.getBoundingClientRect();
  const area = (a, b) => {
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return Math.round(x * y);
  };
  const cs = getComputedStyle(panel);
  const contentW = panel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // パネル配下で内部 scroll を持つ要素(本体 1 つだけであること)
  const scrollers = [...panel.querySelectorAll('*'), panel]
    .filter((e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2; })
    .map((e) => e.id || e.className || e.tagName);
  // 折返し行数は **Range.getClientRects() の line box 数**で数える(F2)。
  // line-height 除算は 'normal' や入れ子 span でずれる。text を持つ葉を母集団にする。
  const body = bodyId ? (document.getElementById(bodyId) ?? panel) : panel;
  // 名前を持つ「葉」だけを母集団にする。container(.vname など)を混ぜると、
  // 中の葉が省略済みでも container 側が全行を返して二重に数えてしまう
  const labels = [...body.querySelectorAll('label, .vtitle, .erow > span:first-child, h2, button')]
    .filter((e) => e.offsetParent !== null && (e.textContent ?? '').trim().length > 0);
  const lineCount = (e) => {
    const rng = document.createRange();
    rng.selectNodeContents(e);
    const rects = [...rng.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
    if (rects.length === 0) return 0;
    // 同じ行の rect が複数返るので、top でまとめて行数にする
    return new Set(rects.map((b) => Math.round(b.top))).size;
  };
  const wrapped = labels.map((e) => {
    const full = (e.textContent ?? '').trim();
    const acc = (e.getAttribute('title') ?? e.getAttribute('aria-label') ?? '').trim();
    // 切り詰めているか(nowrap+hidden / ellipsis / line-clamp は全部これで露見)
    const clipped = e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
    // 「省略してよい」のは全文を読む道がある時だけ(PBI-008 AC-10 の accessible full name)。
    // 道が無い切詰めは「3 行以内」の偽装なので、そちらだけを違反として数える
    return { text: full.slice(0, 24), lines: lineCount(e), clipped, named: acc.length > 0 && acc.includes(full.slice(0, 12)) };
  }).filter((x) => x.lines > 0);
  // 省略が許されている要素は行数の対象から外す(見えている行は clamp 済みで、
  // Range は隠れた行も返すため。読める保証は accessible full name 側が担う)
  const measurable = wrapped.filter((x) => !(x.clipped && x.named));
  const worst = measurable.sort((a, b) => b.lines - a.lines)[0] ?? { text: '(label なし)', lines: 0 };
  const clippedLabels = wrapped.filter((x) => x.clipped && !x.named).map((x) => x.text);
  // control の touch target。**押せる範囲**で測る — label に包まれた control は
  // label をタップしても効くので、的の実体は label(生の checkbox の 13px ではない)
  const small = [...panel.querySelectorAll('button, input, select')]
    .filter((e) => e.offsetParent !== null && r(e).height > 0)
    .map((e) => ({ id: e.id || e.tagName, h: Math.round(r(e.closest('label') ?? e).height) }))
    .filter((x) => x.h < 44)
    .map((x) => `${x.id}:${x.h}px`);
  // 辞書 / 記憶の行(AC-5): 1 行 1 対で横書き = **文字が縦積みにならない**こと。
  // 行そのものの高さは 44px の touch target で決まるので、測るのは中の文字(span)の折返し行数
  const erows = [...(body ? body.querySelectorAll('.erow') : [])].map((e) => {
    const span = e.querySelector('span');
    const lh = parseFloat(getComputedStyle(span ?? e).lineHeight) || 20;
    const btn = e.querySelector('button');
    return {
      lines: span ? Math.round(r(span).height / lh) : 1,
      btnInside: btn ? (r(btn).top >= r(e).top - 1 && r(btn).bottom <= r(e).bottom + 1) : true,
    };
  });
  // パネル自身の箱が viewport の外へ出ていないか。起票時の症状(container が y=-12,726 に
  // 高さ 13,616px で存在し、辞書の行が可視域へ漏れていた)はこの不変条件の違反そのもの。
  // 中身の scroll ははみ出しに数えない(scroller が clip するので画面は汚れない)
  const pb = r(panel);
  const offscreen = Math.round(
    (Math.max(0, -pb.top) + Math.max(0, pb.bottom - innerHeight)) * Math.min(pb.width, innerWidth)
    + (Math.max(0, -pb.left) + Math.max(0, pb.right - innerWidth)) * Math.min(pb.height, innerHeight));
  return {
    offscreen,
    open: panel.classList.contains('open'),
    panelW: Math.round(r(panel).width), contentW: Math.round(contentW),
    panelH: Math.round(r(panel).height),
    logH: Math.round(r(log).height), logNeeded: Math.round(innerHeight * minLogDvh),
    intersect: area(r(panel), r(log)),
    scrollers, worstLabel: worst, small,
    labelCount: wrapped.length, clippedLabels,
    truncatedButNamed: wrapped.filter((x) => x.clipped && x.named).length,
    erowMaxLines: erows.reduce((a, x) => Math.max(a, x.lines), 0),
    erowBtnOutside: erows.filter((x) => !x.btnInside).length,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    passW: contentW >= minPanelW,
    viewport: [innerWidth, innerHeight],
  };
};

// 設定に必ず在る section 数(モデル / effort / 会話モデル / 会話 effort / 並列数 / チェック群 / 記憶 / 辞書)。
// 母集団が 0 件や極端に少ない緑は「測っていない緑」なので fail にする(F2-3)
const MIN_LABELS = 7;

function judge(tag, panelName, m, { minLabels = 0 } = {}) {
  assert.ok(!m.notFound, `${tag}/${panelName}: 見出し「${m.heading}」から container を見つけられない(discovery 失敗 = 幅 assert が発火していない)`);
  assert.ok(m.open, `${tag}/${panelName}: パネルが開いていない`);
  assert.ok(m.passW, `${tag}/${panelName}: パネルの content 幅が ${m.contentW}px(>= ${MIN_PANEL_W}px でないと読めない)`);
  if (minLabels > 0) {
    assert.ok(m.labelCount >= minLabels,
      `${tag}/${panelName}: 測れた label が ${m.labelCount} 件(既知 ${minLabels} 件未満 = 検査が母集団を掴めていない)`);
  }
  assert.ok(m.offscreen <= 4, `${tag}/${panelName}: パネルが画面の外へはみ出している(${m.offscreen}px² — 起票時の y=-12,726 と同じ壊れ方)`);
  assert.deepEqual(m.clippedLabels, [],
    `${tag}/${panelName}: 文字が切り詰められている(nowrap/ellipsis/line-clamp で「3 行以内」を偽装): ${m.clippedLabels.join(' / ')}`);
  assert.equal(m.intersect, 0, `${tag}/${panelName}: #log との矩形交差が ${m.intersect}px²(0 でなければ会話を覆っている)`);
  assert.ok(m.logH >= m.logNeeded, `${tag}/${panelName}: #log が ${m.logH}px(>= ${m.logNeeded}px = 35dvh が要る)`);
  assert.ok(m.worstLabel.lines <= MAX_LABEL_LINES,
    `${tag}/${panelName}: label が ${m.worstLabel.lines} 行に折返している(<= ${MAX_LABEL_LINES} 行)「${m.worstLabel.text}」`);
  assert.ok(m.scrollers.length <= 1, `${tag}/${panelName}: 内部 scroll が ${m.scrollers.length} 個(1 つだけ): ${m.scrollers.join(',')}`);
  assert.deepEqual(m.small, [], `${tag}/${panelName}: 44px 未満の control: ${m.small.join(',')}`);
  assert.equal(m.overflowX, 0, `${tag}/${panelName}: 横 overflow ${m.overflowX}px`);
}

async function openPanelByButton(page, btnId) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (el && el.getAttribute('aria-expanded') !== 'true') el.click();
  }, btnId);
  await page.waitForTimeout(700);
}


// 共有キャッシュ(~/Library/Caches/ms-playwright)は別セッションの install で revision がずれ、
// playwright が期待する版が消えることがある(2026-08-08 実測)。**そこに実在する chromium を直接指す**ことで、
// 誰が何を入れても検査が SKIP に落ちないようにする
async function main() {
  const { browser } = await resolvePlaywright();
  if (!browser) { console.log('SKIP - playwright を launch できないので geometry は測れない'); process.exit(0); }
  const eng = await engineFake();
  const fish = await fishFake();
  const root = BASELINE ? baselineTree() : MUTATE ? mutatedTree() : REPO;
  if (BASELINE) console.log(`(負の対照: 修理前 ${BASELINE} の public/ を当てる → ${root})`);
  if (MUTATE) console.log(`(負の対照: 変異 ${MUTATE} を当てた木 → ${root})`);
  const room = await startRoom({ engineBase: eng.base, fishBase: fish.base, root });
  const page = await browser.newPage();
  try {
    // F6: 辞書が空だと AC-5 の箱検査が vacuous に緑になる。長文対を含む行を先に seed する
    const SEED = [
      ['ボイスクロー', 'talkingclaw'], ['コーキングクロー', 'talkingclaw'], ['キッドハブ', 'GitHub'],
      ['プラモード', 'プランモード'], ['エムシーピー', 'MCP'], ['ユーアイ', 'UI'],
    ];
    {
      const t = await (await fetch(`http://127.0.0.1:${room.port}/health`)).json().catch(() => null);
      void t;
      const html = await (await fetch(`http://127.0.0.1:${room.port}/`)).text();
      const token = html.match(/name="room-token" content="([^"]+)"/)[1];
      for (const [wrong, right] of SEED) {
        await fetch(`http://127.0.0.1:${room.port}/dict`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': token },
          body: JSON.stringify({ wrong, right }),
        }).catch(() => {});
      }
    }
    await page.goto(`http://127.0.0.1:${room.port}/`);
    await page.waitForTimeout(600);
    // 会話 40 行 + 最新 user 行を積む(パネルが会話を押し出さないことを測るため)
    await page.evaluate(() => {
      const log = document.getElementById('log');
      for (let i = 0; i < 40; i++) {
        const d = document.createElement('div'); d.className = 'turn';
        const t = document.createElement('div'); t.className = 'tx';
        t.textContent = 'ダミー会話行 ' + i; d.appendChild(t); log.appendChild(d);
      }
    });

    // ---- AC-7(F3): **設定を一度も開いていない**通常画面で、設定系の中身が漏れていないこと ----
    // 起票の症状「辞書の行が可視領域に漏れて画面が左に寄って見える」は閉状態で起きていた。
    // 開いた状態の AC だけでは、この症状が直った証拠にならない。
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(400);
      const bleed = await page.evaluate((seedWords) => {
        const vpRect = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const hit = (b) => Math.max(0, Math.min(b.right, vpRect.right) - Math.max(b.left, vpRect.left))
                         * Math.max(0, Math.min(b.bottom, vpRect.bottom) - Math.max(b.top, vpRect.top));
        // seed した辞書語を含む「葉」が画面内に描画されていたら漏れ
        const leaked = [...document.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && seedWords.some((w) => (e.textContent ?? '').includes(w)))
          .filter((e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden'; })
          .map((e) => Math.round(hit(e.getBoundingClientRect())))
          .filter((a) => a > 0);
        return {
          leakedCount: leaked.length, leakedArea: leaked.reduce((a, b) => a + b, 0),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, SEED.map((x) => x[0]));
      try {
        assert.equal(bleed.leakedCount, 0, `${vp.tag}: 設定を開いていないのに辞書の行が画面へ漏れている(${bleed.leakedCount} 箇所 / ${bleed.leakedArea}px²)`);
        assert.equal(bleed.overflowX, 0, `${vp.tag}: 閉状態で横 scroll が ${bleed.overflowX}px`);
        ok(`AC-7 閉状態の漏れなし ${vp.tag}(${vp.w}x${vp.h}): 辞書行の可視 0 箇所・横 overflow 0`);
      } catch (e) { fail(`AC-7 閉状態の漏れ ${vp.tag}`, e.message); }
    }

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(400);

      // ---- AC-1 / AC-2 / AC-5: 設定 ----
      await openPanelByButton(page, 'settingsBtn');
      const ms = await page.evaluate(MEASURE, { panelId: 'settings', bodyId: 'settingsBody', minPanelW: MIN_PANEL_W, minLogDvh: MIN_LOG_DVH, heading: '設定' });
      try {
        judge(vp.tag, '設定', ms, { minLabels: MIN_LABELS });
        assert.ok(ms.erowMaxLines <= 2, `${vp.tag}/設定: 辞書 / 記憶の行が ${ms.erowMaxLines} 行(1 行 1 対で <= 2 行)`);
        assert.equal(ms.erowBtnOutside, 0, `${vp.tag}/設定: 行の外へ出たボタンが ${ms.erowBtnOutside} 個`);
        ok(`AC-1/2/5 設定パネル ${vp.tag}(${vp.w}x${vp.h}): 幅 ${ms.contentW}px / #log ${ms.logH}px / 交差 ${ms.intersect} / 最大折返し ${ms.worstLabel.lines} 行`);
      } catch (e) { fail(`AC-1/2/5 設定パネル ${vp.tag}`, e.message); }

      // ---- AC-3: 声セクション(PBI-008 の契約が引き続き成立)----
      await openPanelByButton(page, 'voiceBtn');
      const mv = await page.evaluate(MEASURE, { panelId: 'voice', bodyId: 'voiceList', minPanelW: MIN_PANEL_W, minLogDvh: MIN_LOG_DVH, heading: 'クロエの声' });
      try {
        judge(vp.tag, '声', mv);
        ok(`AC-3 声セクション ${vp.tag}: 幅 ${mv.contentW}px / #log ${mv.logH}px / 交差 ${mv.intersect} / 内部 scroll ${mv.scrollers.length}`);
      } catch (e) { fail(`AC-3 声セクション ${vp.tag}`, e.message); }
    }

    // ---- AC-6: リロード無しの resize に追随する ----
    // 設定を開いたまま 3 サイズを往復し、各サイズで契約が成立し続けること
    await openPanelByButton(page, 'settingsBtn');
    const seq = [...VIEWPORTS, ...VIEWPORTS.slice().reverse()];
    let resizeOk = true;
    for (const vp of seq) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(350);
      const m = await page.evaluate(MEASURE, { panelId: 'settings', bodyId: 'settingsBody', minPanelW: MIN_PANEL_W, minLogDvh: MIN_LOG_DVH, heading: '設定' });
      try {
        assert.ok(m.open, `AC-6 ${vp.tag}: resize でパネルが勝手に閉じた(リロード無しの追随が要件)`);
        judge(`AC-6/${vp.tag}`, '設定', m, { minLabels: MIN_LABELS });
      } catch (e) {
        // 途中で return すると集計に辿り着かず exit 0 で緑に見える。break して必ず集計へ落とす
        fail(`AC-6 resize 追随 ${vp.tag}(${vp.w}x${vp.h})`, e.message);
        resizeOk = false;
        break;
      }
    }
    if (resizeOk) ok(`AC-6 resize 追随: ${seq.map((v) => v.tag).join('→')} をリロード無しで往復、各サイズで契約成立・横 overflow 0`);

    // ---- PBI-010 AC-1/2/3/4: 部屋の作成フォーム ----
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    try {
      // rail の「＋ 作る」を名前で探して押す(id ではなく導線を辿る)
      const opened = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((e) => (e.textContent ?? '').includes('作る'));
        if (!b) return false;
        b.click(); return true;
      });
      assert.ok(opened, '「作る」の導線を画面から見つけられない');
      await page.waitForTimeout(500);
      // 測る箱は **#roomsExtra 自身**(修理前後で同じ id = 同じ discovery)。
      // 見出しから辿ると修理前 build には「部屋の管理」が無く『要素不発見の赤』になり、
      // 幅 assert が一度も発火しない = 負の対照として成立しない(judge F1 の指摘と同型)
      const form = await page.evaluate(() => {
        const box = document.getElementById('roomsExtra');
        if (!box) return { missing: true };
        const b = box.getBoundingClientRect();
        const log = document.getElementById('log').getBoundingClientRect();
        const inter = Math.max(0, Math.min(b.right, log.right) - Math.max(b.left, log.left))
                    * Math.max(0, Math.min(b.bottom, log.bottom) - Math.max(b.top, log.top));
        const input = box.querySelector('input');
        return { missing: false, w: Math.round(b.width), h: Math.round(b.height),
                 visible: getComputedStyle(box).display !== 'none' && b.width > 0 && b.height > 0,
                 inter: Math.round(inter),
                 inputW: input ? Math.round(input.getBoundingClientRect().width) : 0 };
      });
      assert.ok(!form.missing, '#roomsExtra が DOM に無い');
      assert.ok(form.visible, `作成フォームに box が無い(実測 ${form.w}x${form.h} — 寸法ゼロ / clip)`);
      assert.ok(form.w >= MIN_PANEL_W, `作成フォームの幅が ${form.w}px(>= ${MIN_PANEL_W}px でないと読めない)`);
      assert.ok(form.inputW >= 200, `名前の入力欄が ${form.inputW}px(打鍵できない)`);
      assert.equal(form.inter, 0, `作成フォームが #log と交差している(${form.inter}px²)`);
      const m = { contentW: form.w, intersect: form.inter };
      // AC-1: 1 字ずつ打鍵して値が完全一致する(途中で focus / DOM が壊れない)
      const NAME = 'デザイン相談';
      await page.click('#roomsExtra input');
      for (const ch of NAME) { await page.keyboard.type(ch); await page.waitForTimeout(120); }
      const typed = await page.evaluate(() => ({
        value: document.querySelector('#roomsExtra input')?.value ?? null,
        focused: document.activeElement === document.querySelector('#roomsExtra input'),
      }));
      assert.equal(typed.value, NAME, `打鍵途中で値が壊れた(実測 ${JSON.stringify(typed.value)})`);
      assert.ok(typed.focused, '打鍵途中で focus が失われた');
      ok(`AC-1 部屋作成フォーム: content ${m.contentW}px(>= ${MIN_PANEL_W})・交差 ${m.intersect}・「${NAME}」を最後まで打鍵`);
    } catch (e) { fail('AC-1 部屋作成フォームが読めて打鍵できる', e.message); }

    // AC-3: 打鍵中に SSE(participants 更新)が届いても値と focus が残る
    try {
      const before = await page.evaluate(() => document.querySelector('#roomsExtra input')?.value ?? '');
      // 関数名が変わったら silent no-op で緑になるので、存在を前提として assert する
      const hasRefresh = await page.evaluate(() => typeof refreshRoster === 'function');
      assert.ok(hasRefresh, 'refreshRoster が見つからない(再レンダーを誘発できない = 検査が空振りする)');
      await page.evaluate(() => { void fetch('/participants?token=' + TOKEN); });   // SSE 相当の更新
      await page.evaluate(() => refreshRoster());
      await page.waitForTimeout(600);
      await page.keyboard.type('X');
      const after = await page.evaluate(() => ({
        value: document.querySelector('#roomsExtra input')?.value ?? null,
        focused: document.activeElement === document.querySelector('#roomsExtra input'),
      }));
      assert.equal(after.value, before + 'X', `再レンダーで値が失われた(${before} → ${after.value})`);
      assert.ok(after.focused, '再レンダーで focus が失われた');
      ok(`AC-3 再レンダー保護: SSE 相当の更新を挟んでも値「${after.value}」と focus が残る`);
    } catch (e) { fail('AC-3 入力中の再レンダー保護', e.message); }

    // AC-4(R2): 話す相手チップが agent 名とホーム部屋名で融合しない。
    // **故障形は「別の部屋にいる参加者の chip」でしか出ない**ので、その参加者を実在させる —
    // work に join させてから画面を chat へ移すと、その相手は elsewhere になり .where が付く
    try {
      const token = await page.evaluate(() => TOKEN);
      const who = await (await fetch(`http://127.0.0.1:${room.port}/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': token },
        body: JSON.stringify({ requestedName: '作業係', voice: 'まい/ノーマル' }),
      })).json();
      assert.ok(who.participantId, 'elsewhere 参加者を作れない(検査の前提が立たない)');
      await page.evaluate(async () => {
        await post('/channel', { channel: 'chat' });          // 画面だけ別の部屋へ移る
        if (typeof refreshRoster === 'function') await refreshRoster();
      });
      await page.waitForTimeout(700);
      const chips = await page.evaluate(() => [...document.querySelectorAll('#roster .chip')]
        .filter((c) => c.querySelector('.where'))              // 別の部屋にいる相手だけが対象
        .map((c) => ({
          aria: c.getAttribute('aria-label') ?? '',
          text: (c.textContent ?? '').trim(),
          name: c.querySelector('.cname')?.textContent ?? null,
          where: c.querySelector('.where')?.textContent ?? '',
          whereHidden: c.querySelector('.where')?.getAttribute('aria-hidden') ?? null,
        })));
      // 母集団の前提 assert(0 件の緑と本物の緑は同じ顔をする)
      assert.ok(chips.length >= 1,
        `elsewhere の chip が 1 件も無い = AC-4 の assert が一度も走っていない(空振り緑)`);
      for (const c of chips) {
        assert.ok(c.name, `chip に名前の要素(.cname)が無い: ${JSON.stringify(c.text)}`);
        // 読み上げ名に部屋名が「地のまま」混ざっていないこと。融合すると aria は無く
        // textContent が「作業係作業部屋」になる
        assert.ok(c.aria, `chip に aria-label が無い(読み上げ名が textContent の連結になる): ${JSON.stringify(c.text)}`);
        assert.ok(!c.aria.startsWith(c.name + c.where),
          `読み上げ名が融合している: ${JSON.stringify(c.aria)}`);
        assert.equal(c.whereHidden, 'true', `居場所が読み上げ名に混ざっている: ${JSON.stringify(c.text)}`);
      }
      ok(`AC-4 チップ非融合: elsewhere の chip ${chips.length} 件で assert 実行(名前=${JSON.stringify(chips[0].name)} / 読み上げ=${JSON.stringify(chips[0].aria)})`);
    } catch (e) { fail('AC-4 チップの融合', e.message); }

    // ---- AC-5: 幅 390〜1440 を 50px 刻みでスイープ(設定 open / close 両方)----
    try {
      const bad = [];
      for (const open of [false, true]) {
        await page.evaluate((wantOpen) => {
          const btn = document.getElementById('settingsBtn');
          const isOpen = btn.getAttribute('aria-expanded') === 'true';
          if (isOpen !== wantOpen) btn.click();
        }, open);
        for (let w = 390; w <= 1440; w += 50) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.waitForTimeout(120);
          const r = await page.evaluate(() => {
            const de = document.documentElement;
            const log = document.getElementById('log').getBoundingClientRect();
            // 「全画面でないと見えない」= 主要な導線が画面外にある状態
            const reach = [...document.querySelectorAll('header button, #rooms button, #roster .chip, footer button')]
              .filter((e) => e.offsetParent !== null)
              .filter((e) => { const b = e.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1 || b.bottom > innerHeight + 1; });
            return { overflowX: de.scrollWidth - de.clientWidth, logH: Math.round(log.height),
                     need: Math.round(innerHeight * 0.35), offscreen: reach.length };
          });
          if (r.overflowX > 0) bad.push(`${w}px(open=${open}): 横 overflow ${r.overflowX}px`);
          if (r.logH < r.need) bad.push(`${w}px(open=${open}): #log ${r.logH} < ${r.need}`);
          if (r.offscreen > 0) bad.push(`${w}px(open=${open}): 画面外の操作要素 ${r.offscreen} 個`);
        }
      }
      assert.deepEqual(bad.slice(0, 5), [], `幅スイープで崩れ: ${bad.length} 件 — ${bad.slice(0, 5).join(' / ')}`);
      ok('AC-5 幅スイープ 390〜1440px(50px 刻み・設定 open/close 両方): 横 overflow 0・#log >= 35dvh・画面外の操作要素 0');
    } catch (e) { fail('AC-5 幅スイープ', e.message); }

    // ---- R1: 幅 3 バンドでの「到達性」と「冪等性」、および AC-2 の実測 ----
    const BANDS = [
      { tag: 'wide(>=1100)', w: 1200 },
      { tag: 'mid(860-1100)', w: 950 },
      { tag: 'narrow(<860)', w: 500 },
    ];
    for (const band of BANDS) {
      try {
        await page.setViewportSize({ width: band.w, height: 900 });
        await page.waitForTimeout(300);
        // いったん全部畳んでから、可視の導線だけを名前で辿る
        await page.evaluate(() => { if (typeof openPanel === 'function' && openedPanel) openPanel(openedPanel); });
        await page.waitForTimeout(200);
        const reached = await page.evaluate(() => {
          const visible = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
          // 「部屋」へ入る導線 → その中の「作る」導線、の 2 段を名前で辿る
          const step = (words) => [...document.querySelectorAll('button')]
            .filter(visible).find((e) => words.some((w) => (e.textContent ?? '').includes(w)));
          const roomsBtn = step(['部屋']);
          if (roomsBtn) { roomsBtn.click(); }
          return !!roomsBtn;
        });
        await page.waitForTimeout(300);
        const opened = await page.evaluate(() => {
          const visible = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
          const b = [...document.querySelectorAll('button')].filter(visible)
            .find((e) => /作る|名前を変える/.test(e.textContent ?? ''));
          if (!b) return { found: false };
          b.click();
          return { found: true };
        });
        assert.ok(reached || opened.found, `${band.tag}: 「部屋」への可視な導線が無い`);
        assert.ok(opened.found, `${band.tag}: 「作る / 名前を変える」への可視な導線が無い(= この幅で部屋を作れない)`);
        await page.waitForTimeout(400);
        const form = await page.evaluate(() => {
          const box = document.getElementById('roomsExtra');
          const input = box?.querySelector('input');
          const b = box?.getBoundingClientRect();
          return { w: b ? Math.round(b.width) : 0, visible: !!b && b.width > 0 && b.height > 0,
                   inputVisible: !!input && input.getBoundingClientRect().width > 0 };
        });
        assert.ok(form.visible, `${band.tag}: 作成フォームが可視にならない`);
        assert.ok(form.w >= MIN_PANEL_W, `${band.tag}: 作成フォームの幅が ${form.w}px(>= ${MIN_PANEL_W}px)`);
        assert.ok(form.inputVisible, `${band.tag}: 名前の入力欄が見えない`);
        ok(`R1 到達性 ${band.tag}: 導線を名前で辿って form 可視・幅 ${form.w}px`);
      } catch (e) { fail(`R1 到達性 ${band.tag}(${band.w}px)`, e.message); }
    }

    // 冪等性: 何度描画しても導線ボタンは 1 個(B と同型の増殖を防ぐ)
    try {
      await page.setViewportSize({ width: 950, height: 900 });
      await page.waitForTimeout(250);
      const n = await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) { if (typeof renderRooms === 'function') await renderRooms(); }
        for (let i = 0; i < 2; i++) { if (typeof enterRoom === 'function') await enterRoom(currentChannel); }
        return document.querySelectorAll('#roomAdminOpen').length;
      });
      assert.equal(n, 1, `renderRooms×3 + enterRoom×2 の後に導線ボタンが ${n} 個(1 個であること)`);
      ok('R1 冪等性: renderRooms×3 + enterRoom×2 の後も導線ボタンは 1 個');
    } catch (e) { fail('R1 冪等性(導線ボタンの増殖)', e.message); }

    // AC-2 実測: create を実際に click して部屋が作られ・入室し・rail に出て・パネルが畳まれる
    try {
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.waitForTimeout(300);
      const NEW_ROOM = 'けんさ部屋';
      await page.evaluate((name) => {
        const visible = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
        const b = [...document.querySelectorAll('button')].filter(visible).find((e) => (e.textContent ?? '').includes('作る'));
        b?.click();
        const input = document.querySelector('#roomsExtra input');
        if (input) { input.value = name; input.dispatchEvent(new Event('input', { bubbles: true })); }
      }, NEW_ROOM);
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const visible = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
        [...document.querySelectorAll('#roomsExtra button')].filter(visible)
          .find((e) => (e.textContent ?? '').includes('この名前で作る'))?.click();
      });
      await page.waitForTimeout(1500);
      const after = await page.evaluate((name) => ({
        inRail: [...document.querySelectorAll('#roomList .room, #roomList button')].some((e) => (e.textContent ?? '').includes(name)),
        entered: (document.getElementById('roomTitle')?.textContent ?? '').includes(name)
              || (document.querySelector('#roomBtn .rname')?.textContent ?? '').includes(name),
        panelOpen: document.getElementById('roomAdmin').classList.contains('open'),
      }), NEW_ROOM);
      assert.ok(after.inRail, `作った部屋「${NEW_ROOM}」が一覧に出ない`);
      assert.ok(after.entered, `作った部屋へ入室していない`);
      assert.ok(!after.panelOpen, '作成後もパネルが開いたまま');
      ok(`AC-2 実測: 「${NEW_ROOM}」を実 click で作成 → 一覧に反映・入室・パネルは畳まれた`);
    } catch (e) { fail('AC-2 作成を実際に押して確かめる', e.message); }

    // ---- AC-8(judge R1): 幅の下限が「実行時に」守られること ----
    // この PBI は「CSS を書いたのに効いていない」を 2 回踏んだ。clamp と uplift も
    // code を読んで納得するのではなく、**到達可能な状態を作って測る**。
    const SETTINGS_MEASURE = { panelId: 'settings', bodyId: 'settingsBody', minPanelW: MIN_PANEL_W, minLogDvh: MIN_LOG_DVH, heading: '設定' };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    await openPanelByButton(page, 'settingsBtn');

    // (a) grip を目一杯まで縮める drag(ユーザーが実際にできる最小状態)
    try {
      const grip = await page.$('.lane.side .grip');
      assert.ok(grip, '右レーンの幅変更 grip が見つからない(drag 最小化を再現できない)');
      const gb = await grip.boundingBox();
      await page.mouse.move(gb.x + gb.width / 2, gb.y + Math.min(200, gb.height / 2));
      await page.mouse.down();
      await page.mouse.move(1439, gb.y + Math.min(200, gb.height / 2), { steps: 10 }); // 画面右端まで = 最小
      await page.mouse.up();
      await page.waitForTimeout(450);
      const m = await page.evaluate(MEASURE, SETTINGS_MEASURE);
      const stored = await page.evaluate(() => localStorage.getItem('tc-side-w'));
      judge('AC-8/min-drag', '設定', m, { minLabels: MIN_LABELS });
      ok(`AC-8(a) drag 最小化: content ${m.contentW}px(>= ${MIN_PANEL_W})・保存値 ${stored}`);
    } catch (e) { fail('AC-8(a) drag で下限まで縮めた状態', e.message); }

    // (b) 下限未満の tc-side-w が保存されている状態で起動(旧版の値が残っている想定)
    try {
      await page.evaluate(() => localStorage.setItem('tc-side-w', '22.0%')); // 1440px で 316.8px
      await page.reload();
      await page.waitForTimeout(700);
      await openPanelByButton(page, 'settingsBtn');
      const m = await page.evaluate(MEASURE, SETTINGS_MEASURE);
      const stored = await page.evaluate(() => localStorage.getItem('tc-side-w'));
      judge('AC-8/stored-too-narrow', '設定', m, { minLabels: MIN_LABELS });
      assert.notEqual(stored, '22.0%', '保存値が下限未満のまま残っている(次回起動でも読めない状態が続く)');
      ok(`AC-8(b) 下限未満の保存値で起動: content ${m.contentW}px(>= ${MIN_PANEL_W})・保存値を ${stored} へ引き上げ`);
    } catch (e) { fail('AC-8(b) 下限未満の tc-side-w で起動', e.message); }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    room.stop();
    eng.close(); fish.close();
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\npass ${results.length - bad.length} / FAIL ${bad.length}`);
  for (const b of bad) console.log(`  FAIL ${b.n}\n        ${b.e}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('検査自体が落ちた:', e.message); process.exit(2); });
