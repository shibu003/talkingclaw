// PBI-011: 作業先プロジェクトの UI 追加・登録解除。稼働中の部屋(3300)には触らない —
// 空きポート + 一時 HOME の隔離部屋と fake engine だけを使う。
//
// 実行:      node test/check-projects.mjs
// 負の対照:  PROJ_BASELINE=<修理前 commit> node test/check-projects.mjs
//            → 修理前の public/ を一時ツリーへ取り出して当てる。区画が無いので赤くなるのが正
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BASELINE = process.env.PROJ_BASELINE ?? '';

const results = [];
const ok = (n) => { results.push({ n, ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ n, ok: false, e }); console.log('FAIL    -', n, ':', e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 偽 gh 側でも消えるマーカーがある(承認を演じると unauthed を自分で消す)ので、無くても落とさない
const rm = (p) => { try { unlinkSync(p); } catch { /* もう無い */ } };

const freePort = () => new Promise((r) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

// fake AivisSpeech(起動時の /version 確認だけ受ける)。本物の 10101 には 1 リクエストも出さない
async function engineFake() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('"fake"'); }
    if (u.pathname === '/speakers') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// 負の対照: src は現行のまま public/ だけを修理前へ戻す(check-ui-geometry と同じ archive 方式 —
// index を汚さない)
function baselineTree() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-proj-base-'));
  for (const p of ['src', 'package.json', 'tsconfig.json']) execFileSync('cp', ['-R', join(REPO, p), dir]);
  execFileSync('ln', ['-s', join(REPO, 'node_modules'), join(dir, 'node_modules')]);
  execFileSync('sh', ['-c', `git -C '${REPO}' archive ${BASELINE} public | tar -x -C '${dir}'`]);
  return dir;
}

// PBI-012: PATH の先頭に置く偽の gh。本物の GitHub には 1 リクエストも出さない。
// missing マーカーを touch すれば「gh が入っていない環境」も同じ部屋のまま演じられる
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-proj-gh-'));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "$*" >> "${join(dir, 'calls.log')}"
if [ "$1" = "--version" ]; then
  [ -f "${join(dir, 'missing')}" ] && exit 127
  echo "gh version 2.60.0 (fake)"; exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  [ -f "${dir}/unauthed" ] && exit 1
  echo "gho_faketoken"; exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "! First copy your one-time code: ABCD-1234" >&2
  echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
  # 承認されるまで待つ(approved が置かれたら成功、denied なら失敗)
  i=0
  while [ $i -lt 200 ]; do
    [ -f "${dir}/approved" ] && { rm -f "${dir}/unauthed"; exit 0; }
    [ -f "${dir}/denied" ] && { echo "error: authentication was not completed" >&2; exit 1; }
    sleep 0.1
    i=$((i+1))
  done
  exit 1
fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "octo"; exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "list" ]; then
  if [ -f "${dir}/norepos" ]; then
    echo "To get started with GitHub CLI, please run:  gh auth login" >&2
    exit 1
  fi
  cat <<'JSON'
[{"nameWithOwner":"octo/hello","isPrivate":false,"updatedAt":"2026-08-01T00:00:00Z"},
 {"nameWithOwner":"octo/secretlab","isPrivate":true,"updatedAt":"2026-08-05T00:00:00Z"},
 {"nameWithOwner":"octo/uiclone","isPrivate":false,"updatedAt":"2026-08-07T00:00:00Z"}]
JSON
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  case "$3" in
    */ghost) echo "GraphQL: Could not resolve to a Repository with the name '$3'. (repository)" >&2; exit 1;;
    */slow*) sleep 2;;
    */forever)
      echo $$ > "${dir}/forever.pid"
      sleep 20 &
      echo $! > "${dir}/sleep.pid"
      wait
      ;;
  esac
  mkdir -p "$4/.git" && printf 'hi\\n' > "$4/README.md" || exit 1
  echo "Cloning into '$4'..." >&2
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return dir;
}

async function startRoom(root, ghDir, sharedHome, extraEnv = {}) {
  const home = sharedHome ?? mkdtempSync(join(tmpdir(), 'claw-proj-home-'));
  const engine = await engineFake();
  const port = await freePort();
  // GH_BIN で偽物を名指しする(PATH 差し替えだけだと、探索の候補にある本物の gh へ落ちうる)。
  // 打ち切りの検査を現実的な時間で回すため timeout も 5 秒に縮める
  const env = { ...process.env, HOME: home, PORT: String(port), NO_CHLOE: '1',
                PATH: `${ghDir}:${process.env.PATH}`, GH_BIN: join(ghDir, 'gh'), CLAW_CLONE_TIMEOUT_MS: '5000', CLAW_BROWSE_LIMIT: '50',
                TTS_URL: engine.base, FISH_API_KEY: 'PROJ_FAKE_KEY', FISH_API_BASE: engine.base, ...extraEnv };
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
  return { base: `http://127.0.0.1:${port}`, home, stop: () => { try { proc.kill('SIGTERM'); } catch { /* */ } engine.close(); } };
}


// 共有キャッシュ(~/Library/Caches/ms-playwright)は別セッションの install で revision がずれ、
// playwright が期待する版が消えることがある(2026-08-08 実測)。**そこに実在する chromium を直接指す**ことで、
// 誰が何を入れても検査が SKIP に落ちないようにする
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

async function main() {
  const root = BASELINE ? baselineTree() : REPO;
  const ghDir = fakeGh();
  const room = await startRoom(root, ghDir);
  // 途中で throw しても部屋と偽 engine を残さない(npm test から走るので、落ちるたびに孤児が溜まる)
  process.once('exit', room.stop);
  const { base, home } = room;
  // token は部屋がページに埋め込むものを取り出す(実ユーザーと同じ経路)
  const page = await (await fetch(base + '/')).text();
  const token = (page.match(/[0-9a-f]{48}/) ?? [])[0];
  if (!token) { room.stop(); throw new Error('前提が壊れている: ページから token を取り出せない'); }
  const api = async (body, withToken = true) => {
    const res = await fetch(base + '/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(withToken ? { 'x-room-token': token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const diskJson = () => readFileSync(join(home, '.talkingclaw', 'projects.json'), 'utf8');

  // ---- API(AC-1/2/3/4/5)----
  {
    const r = await api({});
    if (r.status === 200 && r.body.projects?.workspace && r.body.projects?.talkingclaw) ok('AC-1 一覧に workspace / talkingclaw が path 付きで居る');
    else fail('AC-1 一覧', JSON.stringify(r));
  }
  const target = join(home, 'myapp');
  mkdirSync(target);
  {
    const r = await api({ action: 'add', name: 'myapp', path: target });
    const onDisk = diskJson().includes('"myapp"');
    if (r.status === 200 && r.body.projects?.myapp === target && onDisk) ok('AC-2 追加 → 200・一覧に即反映・projects.json に永続');
    else fail('AC-2 追加', JSON.stringify(r) + ' disk=' + onDisk);
    if (!existsSync(join(home, '.talkingclaw', 'projects.json.tmp'))) ok('AC-2 temp ファイルが残らない(rename 完了)');
    else fail('AC-2 temp 残骸', 'projects.json.tmp が残っている');
    const mode = statSync(join(home, '.talkingclaw', 'projects.json')).mode & 0o777;
    if (mode === 0o600) ok('AC-2 projects.json は 0600'); else fail('AC-2 mode', mode.toString(8));
  }
  {
    // ~ 展開は部屋プロセスの HOME(= 隔離 home)基準で解決される
    mkdirSync(join(home, 'tilde-app'));
    const r = await api({ action: 'add', name: 'tildeapp', path: '~/tilde-app' });
    if (r.status === 200 && r.body.projects?.tildeapp === join(home, 'tilde-app')) ok('AC-2 ~ 展開で絶対パス化して登録');
    else fail('AC-2 ~ 展開', JSON.stringify(r.body.projects?.tildeapp));
  }
  {
    const before = diskJson();
    const cases = [
      ['重複名 → 409', { action: 'add', name: 'myapp', path: target }, 409],
      ['相対パス → 400', { action: 'add', name: 'rel', path: 'some/dir' }, 400],
      ['実在しないパス → 400', { action: 'add', name: 'ghost', path: join(home, 'no-such-dir') }, 400],
      ['ファイル → 400', { action: 'add', name: 'afile', path: join(home, '.talkingclaw', 'projects.json') }, 400],
      ['不正な名前 → 400', { action: 'add', name: 'だめな名前!', path: target }, 400],
    ];
    for (const [label, body, want] of cases) {
      const r = await api(body);
      if (r.status === want && typeof r.body.error === 'string' && r.body.error.length > 0) ok(`AC-3 ${label} + 理由あり`);
      else fail(`AC-3 ${label}`, JSON.stringify(r));
    }
    if (diskJson() === before) ok('AC-3 不正入力後も projects.json は 1 バイトも変わらない');
    else fail('AC-3 不変', 'projects.json が変わった');
  }
  {
    const r = await api({ action: 'remove', name: 'myapp' });
    const gone = !diskJson().includes('"myapp"');
    if (r.status === 200 && gone && existsSync(target)) ok('AC-4 登録解除 → json から消える・フォルダは消えない');
    else fail('AC-4 登録解除', JSON.stringify(r) + ' gone=' + gone + ' dir=' + existsSync(target));
    const r2 = await api({ action: 'remove', name: 'talkingclaw' });
    if (r2.status === 400) ok('AC-4 土台 2 つは外せない(400)'); else fail('AC-4 土台保護', JSON.stringify(r2));
    const r3 = await api({ action: 'remove', name: 'nobody' });
    if (r3.status === 404) ok('AC-4 未登録名 → 404'); else fail('AC-4 未登録名', JSON.stringify(r3));
  }
  {
    const r = await api({}, false);
    if (r.status === 401) ok('AC-5 token 無し → 401(伝言公開経路から不可視)');
    else fail('AC-5 無認証', JSON.stringify(r));
  }

  // ---- PBI-012: GitHub から clone(AC-1〜5)。gh は PATH 先頭の偽物 ----
  const wsDir = join(home, 'claw-workspace');
  const calls = () => { try { return readFileSync(join(ghDir, 'calls.log'), 'utf8'); } catch { return ''; } };
  {
    const r = await api({ action: 'clone', url: 'https://github.com/octo/hello' });
    const dir = join(wsDir, 'hello');
    if (r.status === 200 && r.body.projects?.hello === dir && existsSync(join(dir, '.git')) && diskJson().includes('"hello"')) {
      ok('012-AC-1 clone → workspace 直下に落ちて projects.json に自動登録');
    } else fail('012-AC-1 clone', JSON.stringify(r) + ' git=' + existsSync(join(dir, '.git')));
    // AC-2: 資格情報を自前で渡さず素の gh に任せている = keyring の認証がそのまま効く(private も同じ経路)
    if (/repo clone octo\/hello /.test(calls()) && !/--with-token|-p ssh/.test(calls())) ok('012-AC-2 gh repo clone にそのまま任せる(private は gh の認証で通る)');
    else fail('012-AC-2 gh 呼び出し', calls().slice(-200));
  }
  {
    // 置き場に同名フォルダが在るだけの状態を作る(登録は外す。フォルダは残る)
    await api({ action: 'remove', name: 'hello' });
    const readme = join(wsDir, 'hello', 'README.md');
    const before = readFileSync(readme, 'utf8');
    const r = await api({ action: 'clone', url: 'https://github.com/octo/hello' });
    if (r.status === 409 && typeof r.body.error === 'string' && readFileSync(readme, 'utf8') === before) ok('012-AC-3 同名フォルダが在れば拒否(409)・中身は 1 バイトも触らない');
    else fail('012-AC-3 既存フォルダ', JSON.stringify(r));
  }
  {
    const before = diskJson();
    const r = await api({ action: 'clone', url: 'https://github.com/octo/ghost' });
    const noDir = !existsSync(join(wsDir, 'ghost'));
    if (r.status === 502 && /Could not resolve to a Repository/.test(r.body.error ?? '') && diskJson() === before && noDir) {
      ok('012-AC-4 clone 失敗 → gh の理由をそのまま返す・projects.json は不変');
    } else fail('012-AC-4 clone 失敗', JSON.stringify(r) + ' 不変=' + (diskJson() === before));
    // repo 名は GitHub の実態に合わせて `.` 入り・長めも通す(登録名になるので先頭は英数字だけ)
    const dotted = await api({ action: 'clone', url: 'https://github.com/octo/nvim.config' });
    if (dotted.status === 200 && dotted.body.projects?.['nvim.config']) ok('012-AC-1 `.` を含む repo 名もそのまま登録できる');
    else fail('012 ドット入り repo 名', JSON.stringify(dotted));
    for (const [label, url] of [['URL の形が違う', 'github.com/octo/hello'], ['SSH はスコープ外', 'git@github.com:octo/x.git'], ['他所のホスト', 'https://gitlab.com/octo/x']]) {
      const b = await api({ action: 'clone', url });
      if (b.status === 400 && b.body.error) ok(`012-AC-4 ${label} → 400 + 理由`); else fail(`012-AC-4 ${label}`, JSON.stringify(b));
    }
  }
  {
    // AC-5: clone は通るが登録が書けない(.talkingclaw を書込み不可にして再現)
    chmodSync(join(home, '.talkingclaw'), 0o500);
    const r = await api({ action: 'clone', url: 'https://github.com/octo/keeper' });
    chmodSync(join(home, '.talkingclaw'), 0o700);
    const kept = existsSync(join(wsDir, 'keeper', 'README.md'));
    if (r.status === 500 && kept && /登録/.test(r.body.error ?? '')) ok('012-AC-5 登録だけ失敗 → clone したフォルダは残し、そう伝える');
    else fail('012-AC-5 登録失敗', JSON.stringify(r) + ' 残っている=' + kept);
  }
  {
    // 走っている最中に別の登録操作が入っても、clone の完了で巻き戻さない(入口で撮った写しを書き戻さない)
    mkdirSync(join(home, 'during'));
    const slow = api({ action: 'clone', url: 'https://github.com/octo/slow' });
    await sleep(400);
    const dup = await api({ action: 'clone', url: 'https://github.com/octo/slow' });
    await api({ action: 'add', name: 'during', path: join(home, 'during') });
    const done = await slow;
    const after = (await api({})).body.projects ?? {};
    if (dup.status === 409) ok('012 同じ repo を二重に clone しようとしたら 409 で断る'); else fail('012 二重 clone', JSON.stringify(dup));
    if (done.status === 200 && after.slow && after.during) ok('012 clone 中に足した作業先が、clone の完了で消えない');
    else fail('012 clone 中の登録', JSON.stringify(done.body) + ' 後=' + JSON.stringify(Object.keys(after)));
  }
  {
    // 打ち切りは gh だけでなく孫ごと。偽 gh は自分の pid を置いて眠るので、生き残りを直接見る
    const t0 = Date.now();
    const r = await api({ action: 'clone', url: 'https://github.com/octo/forever' });
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    // gh 本体だけでなく、その子(実際に時間を食っている方 = 本物なら git)も見る。
    // 親だけ見ると、プロセスグループを畳んでいなくても通ってしまう
    const gh = alive(Number(readFileSync(join(ghDir, 'forever.pid'), 'utf8').trim()));
    const kid = alive(Number(readFileSync(join(ghDir, 'sleep.pid'), 'utf8').trim()));
    if (r.status === 502 && /打ち切った/.test(r.body.error ?? '') && !gh && !kid) ok(`012 打ち切りで gh も孫も残らない(${Date.now() - t0}ms)`);
    else fail('012 打ち切り', JSON.stringify(r) + ` gh生存=${gh} 孫生存=${kid}`);
  }
  {
    // gh が居ない環境で押されても、生の ENOENT ではなく日本語で断る(画面の note と同じ案内)
    writeFileSync(join(ghDir, 'missing'), '');
    const r = await api({ action: 'clone', url: 'https://github.com/octo/nogh' });
    rm(join(ghDir, 'missing'));
    if (r.status === 400 && /gh/.test(r.body.error ?? '') && !/ENOENT/.test(r.body.error)) ok('012 gh が無ければ clone は 400 + 日本語で断る');
    else fail('012 gh 不在の clone', JSON.stringify(r));
  }
  // ---- PBI-018: 部屋を再起動しても同じ URL で繋がる ----
  {
    const tokenOf = async (r) => ((await (await fetch(r.base + '/')).text()).match(/[0-9a-f]{48}/) ?? [])[0];
    // 同じ HOME を使う 2 つ目の部屋(別ポート)を立てて、埋まる token を比べる
    const again = await startRoom(root, ghDir, home);
    const t2 = await tokenOf(again);
    if (t2 === token) ok('018-AC-1 再起動しても token は変わらない(開いている URL が生き続ける)');
    else fail('018-AC-1 token 維持', `${String(token).slice(0, 8)} → ${String(t2).slice(0, 8)}`);
    again.stop();
    // 壊れた room.json は信用せず作り直す
    writeFileSync(join(home, '.talkingclaw', 'room.json'), '{"token":"short"}');
    const third = await startRoom(root, ghDir, home);
    const t3 = await tokenOf(third);
    if (t3 && t3 !== 'short' && /^[0-9a-f]{48}$/.test(t3)) ok('018-AC-3 壊れた room.json なら作り直す(落ちない)');
    else fail('018-AC-3 壊れた room.json', String(t3));
    third.stop();
    // 明示すれば変えられる
    const fourth = await startRoom(root, ghDir, home, { CLAW_NEW_TOKEN: '1' });
    const t4 = await tokenOf(fourth);
    if (t4 && t4 !== t3) ok('018-AC-4 CLAW_NEW_TOKEN=1 なら新しくなる'); else fail('018-AC-4 明示更新', String(t4));
    fourth.stop();
    // 以降の検査のために、元の token を書き戻す(この部屋はまだ動いている)
    writeFileSync(join(home, '.talkingclaw', 'room.json'), JSON.stringify({ port: 0, token }));
  }

  // ---- PBI-017: フォルダを持ち込む(落とす / 選ぶ)----
  const sendFile = async (name, rel, content) => {
    const res = await fetch(`${base}/intake?name=${encodeURIComponent(name)}&rel=${encodeURIComponent(rel)}`, {
      method: 'POST', headers: { 'x-room-token': token }, body: content,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  {
    const start = await api({ action: 'intakeStart', name: 'dropped', files: 2, bytes: 12 });
    if (start.status === 200 && existsSync(join(wsDir, 'dropped'))) ok('017-AC-3 受付を開くと置き場ができる');
    else fail('017 intakeStart', JSON.stringify(start));
    const a = await sendFile('dropped', 'index.html', 'hello');
    const b = await sendFile('dropped', 'src/app.js', 'world');
    const fin = await api({ action: 'intakeDone', name: 'dropped', skipped: 3 });
    const laid = existsSync(join(wsDir, 'dropped', 'src', 'app.js')) && readFileSync(join(wsDir, 'dropped', 'index.html'), 'utf8') === 'hello';
    if (a.status === 200 && b.status === 200 && fin.status === 200 && laid && fin.body.projects?.dropped) {
      ok('017-AC-3 中身が相対パスのまま置かれて、作業先に登録される');
    } else fail('017-AC-3 取り込み', JSON.stringify({ a: a.status, b: b.status, fin: fin.body, laid }));
  }
  {
    // 置き場の外に書かせない(信頼境界)
    await api({ action: 'intakeStart', name: 'escape', files: 1, bytes: 4 });
    const bad = await sendFile('escape', '../../evil.txt', 'x');
    const evil = existsSync(join(home, 'evil.txt')) || existsSync(join(wsDir, 'evil.txt'));
    if (!evil && (bad.status === 400 || existsSync(join(wsDir, 'escape', 'evil.txt')))) ok('017 .. で置き場の外には書けない');
    else fail('017 パストラバーサル', JSON.stringify(bad) + ' 外に出た=' + evil);
    await api({ action: 'intakeDone', name: 'escape' });
  }
  {
    // 途中で切れた取り込みの跡は、やり直せる(端末で rm -rf させない)
    await api({ action: 'intakeStart', name: 'aborted', files: 1, bytes: 1 });
    const again = await api({ action: 'intakeStart', name: 'aborted', files: 1, bytes: 1 });
    if (again.status === 200 && again.body.resumed === true) ok('017 空のまま残った置き場は、次の取り込みでやり直せる');
    else fail('017 やり直し', JSON.stringify(again));
    const fin = await api({ action: 'intakeDone', name: 'aborted' });
    if (fin.status === 500 && !existsSync(join(wsDir, 'aborted'))) ok('017 1 つも置けなかった時は、自分が作った空の置き場を片付ける');
    else fail('017 空置き場の後始末', JSON.stringify(fin) + ' 残=' + existsSync(join(wsDir, 'aborted')));
  }
  {
    // 申告より多く送られても止める。413 は socket を壊さずに返す(理由が画面に届く)
    await api({ action: 'intakeStart', name: 'overrun', files: 1, bytes: 10 });
    await sendFile('overrun', 'a.txt', 'x');
    const over = await sendFile('overrun', 'b.txt', 'y');
    if (over.status === 413 && /申告/.test(over.body.error ?? '')) ok('017 申告より多く送られたら断る(理由つき)');
    else fail('017 申告超過', JSON.stringify(over));
    await api({ action: 'intakeDone', name: 'overrun' });
  }
  {
    const dup = await api({ action: 'intakeStart', name: 'dropped', files: 1, bytes: 1 });
    if (dup.status === 409) ok('017-AC-4 同名は受け付けない(上書きしない)'); else fail('017-AC-4 同名', JSON.stringify(dup));
    const many = await api({ action: 'intakeStart', name: 'toomany', files: 9999, bytes: 10 });
    const heavy = await api({ action: 'intakeStart', name: 'toobig', files: 1, bytes: 999 * 1024 * 1024 });
    if (many.status === 413 && /個まで/.test(many.body.error ?? '') && heavy.status === 413 && /MB まで/.test(heavy.body.error ?? '')) {
      ok('017-AC-5 多すぎ・重すぎは送る前に断る(上限も言う)');
    } else fail('017-AC-5 上限', JSON.stringify({ many: many.body, heavy: heavy.body }));
    const empty = await api({ action: 'intakeStart', name: 'nothing', files: 0, bytes: 0 });
    if (empty.status === 400) ok('017 空のフォルダは断る'); else fail('017 空', JSON.stringify(empty));
  }
  {
    const m = readFileSync(join(home, '.talkingclaw', 'metrics.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === 'project_intake');
    if (m.some((x) => x.mode === 'upload' && x.files === 2 && x.skipped === 3)) ok('OBSERVE 取り込みの規模(件数・除外数)が metrics に残る');
    else fail('OBSERVE intake', JSON.stringify(m));
  }

  // ---- PBI-016: 画面から GitHub にログインする(端末で gh auth login を打たせない)----
  {
    const authed = await api({});
    if (authed.body.ghAuthed === true) ok('016-AC-4 認証済みならそう返す(連携ボタンを出さない材料)');
    else fail('016-AC-4 認証済み判定', JSON.stringify(authed.body.ghAuthed));
  }
  {
    writeFileSync(join(ghDir, 'unauthed'), ''); // 未認証の環境を演じる
    const r = await api({});
    if (r.body.ghAuthed === false) ok('016-AC-1 未認証もそう返る'); else fail('016 未認証判定', JSON.stringify(r.body.ghAuthed));
    const t0 = Date.now();
    const start = await api({ action: 'auth' });
    if (start.status === 200 && start.body.code === 'ABCD-1234' && /login\/device/.test(start.body.url ?? '')) {
      ok(`016-AC-1 連携を始めると合言葉と貼り先が返る(${Date.now() - t0}ms)`);
    } else fail('016-AC-1 連携開始', JSON.stringify(start));
    const dup = await api({ action: 'auth' });
    if (dup.body.code === 'ABCD-1234') ok('016 二重に押しても gh を 2 つ起こさない'); else fail('016 二重起動', JSON.stringify(dup));
    const waiting = await api({ action: 'authPoll' });
    if (waiting.body.waiting === true && waiting.body.code === 'ABCD-1234') ok('016-AC-2 承認前は待ち状態を返す');
    else fail('016 待ち状態', JSON.stringify(waiting));
    writeFileSync(join(ghDir, 'approved'), ''); // ブラウザ側で許可した
    let done = null;
    for (let i = 0; i < 30; i += 1) {
      await sleep(300);
      done = await api({ action: 'authPoll' });
      if (done.body.waiting === false) break;
    }
    if (done?.body.authed === true && done.body.user === 'octo') ok('016-AC-2 承認したら「連携できた(@octo)」まで届く');
    else fail('016-AC-2 承認', JSON.stringify(done?.body));
    rm(join(ghDir, 'approved'));
    const after = await api({});
    if (after.body.ghAuthed === true) ok('016-AC-2 以後は認証済みとして扱われる(一覧が使える)');
    else fail('016 認証後', JSON.stringify(after.body.ghAuthed));
  }
  {
    // やめたら gh のプロセスも残さない
    writeFileSync(join(ghDir, 'unauthed'), '');
    await api({ action: 'auth' });
    const before = Number(execFileSync('sh', ['-c', `pgrep -f 'auth login' | wc -l`], { encoding: 'utf8' }).trim());
    await api({ action: 'authCancel' });
    await sleep(500);
    const after = Number(execFileSync('sh', ['-c', `pgrep -f 'auth login' | wc -l`], { encoding: 'utf8' }).trim());
    const poll = await api({ action: 'authPoll' });
    if (after < before && poll.body.waiting === false) ok(`016-AC-3 やめたら待ち受けも gh も終わる(${before}→${after})`);
    else fail('016-AC-3 中止', `before=${before} after=${after} poll=${JSON.stringify(poll.body)}`);
    rm(join(ghDir, 'unauthed'));
  }
  {
    // gh 不在で連携を押しても、生の ENOENT ではなく案内を返す
    writeFileSync(join(ghDir, 'missing'), '');
    const r = await api({ action: 'auth' });
    rm(join(ghDir, 'missing'));
    if (r.status === 400 && /gh/.test(r.body.error ?? '') && !/ENOENT/.test(r.body.error)) ok('016-AC-5 gh 不在なら 400 + 案内');
    else fail('016-AC-5 gh 不在', JSON.stringify(r));
  }
  {
    const m = readFileSync(join(home, '.talkingclaw', 'metrics.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === 'gh_auth');
    const phases = new Set(m.map((x) => x.phase));
    if (phases.has('start') && phases.has('done') && phases.has('cancel')) ok('OBSERVE 連携の開始・成功・中止が metrics に残る');
    else fail('OBSERVE gh_auth', JSON.stringify([...phases]));
  }

  // ---- PBI-015: 打たずに選ぶ(repo 一覧 / フォルダを辿る)----
  {
    const r = await api({ action: 'repos' });
    const names = (r.body.repos ?? []).map((x) => x.nameWithOwner);
    if (r.status === 200 && names.length === 3 && names[0] === 'octo/uiclone') ok('015-AC-1 自分の repo が新しい順で返る(private 含む)');
    else fail('015-AC-1 repo 一覧', JSON.stringify(r.body).slice(0, 200));
    if ((r.body.repos ?? []).some((x) => x.isPrivate === true)) ok('015-AC-1 private かどうかが分かる');
    else fail('015-AC-1 private 表示', JSON.stringify(names));
  }
  {
    writeFileSync(join(ghDir, 'norepos'), '');
    const r = await api({ action: 'repos' });
    rm(join(ghDir, 'norepos'));
    if (r.status === 502 && /gh auth login/.test(r.body.error ?? '')) ok('015-AC-3 未認証なら空一覧でなく gh の文言を返す');
    else fail('015-AC-3 未認証', JSON.stringify(r));
  }
  {
    mkdirSync(join(home, 'tree', 'withgit', '.git'), { recursive: true });
    mkdirSync(join(home, 'tree', 'plain'), { recursive: true });
    const r = await api({ action: 'browse', path: '~/tree' });
    const names = (r.body.entries ?? []).map((e) => e.name);
    const git = (r.body.entries ?? []).find((e) => e.name === 'withgit');
    if (r.status === 200 && names.includes('withgit') && names.includes('plain') && git?.git === true && r.body.up === join(home)) {
      ok('015-AC-4 フォルダを辿れる(git repo には印・上の階層が分かる)');
    } else fail('015-AC-4 browse', JSON.stringify(r.body).slice(0, 200));
    if (!(r.body.entries ?? []).some((e) => e.name.startsWith('.'))) ok('015-AC-4 隠しフォルダは出さない');
    else fail('015-AC-4 隠しフォルダ', JSON.stringify(names));
  }
  {
    const r = await api({ action: 'browse', path: join(home, 'no-such-place') });
    if (r.status === 400 && r.body.error) ok('015-AC-5 開けない場所は理由を返す(落ちない)');
    else fail('015-AC-5 browse 失敗', JSON.stringify(r));
  }
  {
    // symlink のフォルダも辿れる(外付け・dotfiles 運用では珍しくない)。壊れた link は出さない
    symlinkSync(join(home, 'tree', 'withgit'), join(home, 'tree', 'linked'));
    symlinkSync(join(home, 'tree', 'nowhere'), join(home, 'tree', 'broken'));
    const r = await api({ action: 'browse', path: join(home, 'tree') });
    const names = (r.body.entries ?? []).map((e) => e.name);
    const linked = (r.body.entries ?? []).find((e) => e.name === 'linked');
    if (names.includes('linked') && linked?.git === true && !names.includes('broken')) ok('015 symlink のフォルダも辿れる(壊れた link は出さない)');
    else fail('015 symlink', JSON.stringify(names));
  }
  {
    // 多すぎるフォルダで会話を止めない: 上限で切り、切ったことを黙らない
    mkdirSync(join(home, 'many'), { recursive: true });
    for (let i = 0; i < 55; i += 1) mkdirSync(join(home, 'many', `d${String(i).padStart(2, '0')}`), { recursive: true });
    const r = await api({ action: 'browse', path: join(home, 'many') });
    if ((r.body.entries ?? []).length === 50 && r.body.more === 5) ok('015 1 フォルダの上限で切り、残り件数を返す(CLAW_BROWSE_LIMIT=50 に 55 件で実測)');
    else fail('015 browse 上限', JSON.stringify({ n: (r.body.entries ?? []).length, more: r.body.more }));
  }
  {
    // OBSERVE(015): どの入口から登録されたかが残る
    const r = await api({ action: 'add', name: 'viacheck', path: join(home, 'tree', 'plain'), via: 'browse' });
    const m = readFileSync(join(home, '.talkingclaw', 'metrics.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === 'project_add');
    if (r.status === 200 && m.some((x) => x.via === 'browse')) ok('OBSERVE 登録の入口(via)が metrics に残る');
    else fail('OBSERVE via', JSON.stringify(m));
    await api({ action: 'remove', name: 'viacheck' });
  }
  {
    // OBSERVE: clone の成否と所要時間が metrics.jsonl に残る
    const m = readFileSync(join(home, '.talkingclaw', 'metrics.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === 'project_clone');
    if (m.length >= 2 && m.some((x) => x.ok === true) && m.some((x) => x.ok === false) && m.every((x) => typeof x.ms === 'number')) {
      ok(`OBSERVE project_clone を ${m.length} 件記録(成功・失敗・所要 ms)`);
    } else fail('OBSERVE metrics', JSON.stringify(m));
  }

  // ---- UI(AC-1/2: 実ブラウザで区画と実クリック)----
  const browser = await launchBrowser();
  if (!browser) {
    console.log('SKIP    - playwright を launch できないので UI は測れない(API のみ検証済み)');
  } else {
    const pg = await browser.newPage();
    // networkidle は使わない — SSE 常時接続の部屋では永遠に静かにならない(load で足りる)
    await pg.goto(base + '/');
    await pg.evaluate(() => {
      const el = document.getElementById('settingsBtn');
      if (el && el.getAttribute('aria-expanded') !== 'true') el.click();
    });
    // renderSettings は /settings → /projects → /memory と await が連なる。見出しが出るまで待つ
    for (let i = 0; i < 15; i += 1) {
      const found = await pg.evaluate(() => [...document.querySelectorAll('b')].some((e) => e.textContent === '作業先プロジェクト'));
      if (found) break;
      await sleep(400);
    }
    // 修理前 build でも同じ手順で探す: 見出しの文字から辿る(id は修理後にしか無い)
    const section = async () => pg.evaluate(() => {
      const b = [...document.querySelectorAll('b')].find((e) => e.textContent === '作業先プロジェクト');
      if (!b) return null;
      const boxEl = b.parentElement;
      const rows = [...boxEl.querySelectorAll('.erow')].map((r) => r.textContent);
      const rect = boxEl.getBoundingClientRect();
      return { rows, w: rect.width, hasForm: !!boxEl.querySelector('input') };
    });
    {
      let s = null;
      for (let i = 0; i < 15; i += 1) { // 描き直しの最中は一瞬 null になる
        s = await section();
        if (s && s.rows.length >= 2) break;
        await sleep(400);
      }
      if (s && s.rows.length >= 2 && s.hasForm && s.w >= 320) ok(`AC-1 UI 区画あり・${s.rows.length} 行・追加フォームあり・幅 ${Math.round(s.w)}px >= 320`);
      else fail('AC-1 UI 区画', JSON.stringify(s));
    }
    // PBI-015: 入口が 3 つになった。パス手打ちの検査はその入口に切り替えてから当てる
    // 入口の切替。押した瞬間に別の描き直しが走っていると空振りすることがあるので、切り替わるまで押す
    const tab = async (key) => {
      for (let i = 0; i < 10; i += 1) {
        await pg.evaluate((k) => document.getElementById('projTab-' + k)?.click(), key);
        await sleep(400);
        if (await pg.evaluate((k) => projTab === k, key)) return true;
      }
      return false;
    };
    {
      let st = null;
      for (let i = 0; i < 15; i += 1) { // 入口は /projects の応答を待って描かれる
        st = await pg.evaluate(() => ({
          tabs: ['github', 'folder', 'path'].filter((k) => !!document.getElementById('projTab-' + k)),
          github: !!document.getElementById('repoSelect'),
          path: !!document.getElementById('projPath'),
        }));
        if (st.tabs.length === 3) break;
        await sleep(400);
      }
      if (st.tabs.length === 3 && st.github && !st.path) ok('015-AC-6 入口 3 つ・既定は GitHub・同時に 1 つだけ出る');
      else fail('015-AC-6 入口', JSON.stringify(st));
    }
    await tab('path');
    {
      mkdirSync(join(home, 'uiapp'));
      await pg.evaluate((p) => {
        const boxEl = [...document.querySelectorAll('b')].find((e) => e.textContent === '作業先プロジェクト')?.parentElement;
        if (!boxEl) return;
        boxEl.querySelector('#projName').value = 'uiapp';
        boxEl.querySelector('#projPath').value = p;
        [...boxEl.querySelectorAll('button')].find((b) => b.textContent === '追加')?.click();
      }, join(home, 'uiapp'));
      // 追加 → renderSettings の再描画は /settings + /projects の往復ぶん遅れる。負荷下でも待ち切る
      let s = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(500);
        s = await section();
        if (s && s.rows.some((r) => r.includes('uiapp'))) break;
      }
      if (s && s.rows.some((r) => r.includes('uiapp'))) ok('AC-2 UI から追加 → 再読込なしで一覧に反映');
      else {
        const errText = await pg.evaluate(() => document.getElementById('projErr')?.textContent ?? '(projErr 無し)');
        const reg = await api({});
        fail('AC-2 UI 追加', `rows=${JSON.stringify(s?.rows)} projErr=「${errText}」 api側=${JSON.stringify(Object.keys(reg.body.projects ?? {}))}`);
      }
    }
    {
      await pg.evaluate(() => {
        const boxEl = [...document.querySelectorAll('b')].find((e) => e.textContent === '作業先プロジェクト')?.parentElement;
        if (!boxEl) return;
        boxEl.querySelector('#projName').value = 'ghost2';
        boxEl.querySelector('#projPath').value = '/no/such/dir/at-all';
        [...boxEl.querySelectorAll('button')].find((b) => b.textContent === '追加')?.click();
      });
      await sleep(600);
      const msg = await pg.evaluate(() => document.getElementById('projErr')?.textContent ?? '');
      if (msg.length > 0) ok(`AC-3 UI に理由が出る: 「${msg}」`);
      else fail('AC-3 UI 理由表示', '空');
    }
    // ---- PBI-015 UI: GitHub の一覧から選んで clone(URL を打たない)----
    await tab('github');
    {
      let opts = [];
      for (let i = 0; i < 15; i += 1) { // 一覧は開いた時に gh を叩くので届くまで待つ
        await sleep(400);
        opts = await pg.evaluate(() => [...(document.getElementById('repoSelect')?.options ?? [])].map((o) => o.textContent));
        if (opts.length >= 3) break;
      }
      if (opts.length === 3 && opts.some((t) => t.includes('secretlab') && t.includes('private'))) ok(`015-AC-1 一覧に自分の repo が並ぶ(${opts.length} 件・private も分かる)`);
      else fail('015-AC-1 UI 一覧', JSON.stringify(opts));
      const narrowed = await pg.evaluate(async () => {
        const f = document.getElementById('repoFilter');
        f.value = 'secret';
        f.dispatchEvent(new Event('input'));
        return [...document.getElementById('repoSelect').options].map((o) => o.textContent);
      });
      if (narrowed.length === 1 && narrowed[0].includes('secretlab')) ok('015-AC-2 絞り込みで一覧が減る');
      else fail('015-AC-2 絞り込み', JSON.stringify(narrowed));
      const empty = await pg.evaluate(async () => {
        const f = document.getElementById('repoFilter');
        f.value = 'zzzznope';
        f.dispatchEvent(new Event('input'));
        return document.getElementById('repoSelect').textContent;
      });
      if (empty.includes('見つからない')) ok('015-AC-2 0 件なら「見つからない」と出る'); else fail('015-AC-2 0 件', empty);
    }
    {
      // 絞り込みで消えた選択が残っていると、画面に見えていない repo を clone してしまう
      const picked = await pg.evaluate(() => {
        const f = document.getElementById('repoFilter');
        const sel = document.getElementById('repoSelect');
        f.value = 'hello';
        f.dispatchEvent(new Event('input'));
        sel.selectedIndex = 0;
        sel.dispatchEvent(new Event('change'));
        const chosen = sel.value;
        f.value = 'secret'; // hello は消える
        f.dispatchEvent(new Event('input'));
        return { chosen, nowSel: sel.value, shown: [...sel.options].map((o) => o.textContent) };
      });
      if (picked.chosen.includes('hello') && !picked.nowSel.includes('hello') && picked.shown.every((t) => !t.includes('hello'))) {
        ok('015 絞り込みで消えた選択は捨てる(見えていない repo を clone しない)');
      } else fail('015 消えた選択', JSON.stringify(picked));
    }
    {
      // 失敗した clone は、待つ間に描き直されていても理由が見える(「clone 中…」で固まらない)
      await pg.evaluate(() => {
        document.getElementById('repoFilter').value = 'zzz-none';
        document.getElementById('projClone').click(); // 選択なし → 案内が出るだけ
      });
      await sleep(200);
      await tab('path');
      await pg.evaluate(() => {
        document.getElementById('projPath').value = 'https://github.com/octo/ghost';
        document.getElementById('projAdd').click();
      });
      await pg.evaluate(() => renderSettings()); // 待っている間に描き直しが挟まる
      let st = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(400);
        st = await pg.evaluate(() => ({ msg: document.getElementById('projErr')?.textContent ?? '', off: !!document.getElementById('projAdd')?.disabled }));
        if (!st.off) break;
      }
      if (/Could not resolve to a Repository/.test(st.msg) && !st.off) ok('015 失敗した clone の理由が、描き直しを跨いでも画面に出る');
      else fail('015 失敗が見えない', JSON.stringify(st));
      await tab('github');
    }
    {
      // 選んで押すだけで clone → 登録まで(URL は 1 文字も打たない)
      const busy = await pg.evaluate(() => {
        const f = document.getElementById('repoFilter');
        f.value = 'uiclone';
        f.dispatchEvent(new Event('input'));
        const sel = document.getElementById('repoSelect');
        sel.selectedIndex = 0;
        sel.dispatchEvent(new Event('change'));
        document.getElementById('projClone').click();
        return { picked: sel.value, err: document.getElementById('projErr')?.textContent ?? '', off: !!document.getElementById('projClone')?.disabled };
      });
      if (busy.picked === 'https://github.com/octo/uiclone' && busy.err.includes('clone 中') && busy.off) ok('015-AC-1 一覧から選んで clone(実行中の表示・二度押し不可)');
      else fail('015-AC-1 一覧から clone', JSON.stringify(busy));
      let s = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(500);
        s = await section();
        if (s && s.rows.some((r) => r.includes('uiclone'))) break;
      }
      if (s && s.rows.some((r) => r.includes('uiclone'))) ok('015-AC-1 選んだ repo が再読込なしで一覧に載る');
      else fail('015-AC-1 一覧反映', `rows=${JSON.stringify(s?.rows)} projErr=${await pg.evaluate(() => document.getElementById('projErr')?.textContent ?? '')}`);
    }
    // ---- PBI-015 UI: フォルダを辿って登録(絶対パスを打たない)----
    {
      await tab('folder');
      let entries = [];
      for (let i = 0; i < 15; i += 1) {
        await sleep(400);
        entries = await pg.evaluate(() => [...document.querySelectorAll('#browseList button')].map((b) => b.textContent));
        if (entries.length > 0) break;
      }
      const hasTree = entries.some((t) => t.includes('tree'));
      if (hasTree) ok(`015-AC-4 ~ の中のフォルダが並ぶ(${entries.length} 件)`); else fail('015-AC-4 一覧', JSON.stringify(entries.slice(0, 10)));
      // tree → withgit と潜って、そこを登録する
      for (const want of ['tree', 'withgit']) {
        await pg.evaluate((w) => [...document.querySelectorAll('#browseList button')].find((b) => b.textContent.includes(w))?.click(), want);
        await sleep(600);
      }
      const at = await pg.evaluate(() => ({ where: document.getElementById('browseAt')?.textContent ?? '', name: document.getElementById('browseName')?.value ?? '' }));
      if (at.where.includes('withgit') && at.where.includes('git repo') && at.name === 'withgit') ok('015-AC-4 潜れて、git repo だと分かり、名前が既定で入る');
      else fail('015-AC-4 潜り', JSON.stringify(at));
      await pg.evaluate(() => document.getElementById('browsePick').click());
      let s = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(500);
        s = await section();
        if (s && s.rows.some((r) => r.includes('withgit'))) break;
      }
      if (s && s.rows.some((r) => r.includes('withgit'))) ok('015-AC-4 「ここにする」で登録できる(パスは 1 文字も打たない)');
      else fail('015-AC-4 登録', `rows=${JSON.stringify(s?.rows)} projErr=${await pg.evaluate(() => document.getElementById('projErr')?.textContent ?? '')}`);
    }
    {
      // パネルは他の操作(記憶の削除・画面幅の変化)でも丸ごと描き直される。
      // その時に実行中の表示が消えると「始まっていない」ように見えて二度押しを誘う
      await tab('path');
      await pg.evaluate(() => {
        document.getElementById('projPath').value = 'https://github.com/octo/slowui';
        document.getElementById('projAdd').click();
      });
      await pg.evaluate(() => renderSettings());
      await sleep(400);
      const st = await pg.evaluate(() => ({ err: document.getElementById('projErr')?.textContent ?? '', off: !!document.getElementById('projAdd')?.disabled }));
      if (st.err.includes('clone 中') && st.off) ok('012 パネルを描き直しても実行中の表示が残る(二度押しを誘わない)');
      else fail('012 再描画で実行中表示が消える', JSON.stringify(st));
      for (let i = 0; i < 15; i += 1) { // 次の検査に混ざらないよう終わるまで待つ
        await sleep(400);
        if (!(await pg.evaluate(() => !!document.getElementById('projAdd')?.disabled))) break;
      }
    }
    // ---- PBI-017 UI: フォルダを落とす(場所が取れる時 / 取れない時)----
    {
      await tab('drop');
      const has = await pg.evaluate(() => !!document.getElementById('dropZone') && !!document.getElementById('dropPicker'));
      if (has) ok('017-AC-1 落とし口がある(押してフォルダを選ぶこともできる)');
      else fail('017-AC-1 落とし口', await pg.evaluate(() => document.getElementById('projectsAdmin')?.textContent?.slice(0, 120) ?? '(区画無し)'));
      // ① Finder 相当: file:// が取れる drop → コピーせずそのまま登録
      mkdirSync(join(home, 'dropped-in-place'), { recursive: true });
      await pg.evaluate((p) => {
        const dt = new DataTransfer();
        dt.setData('text/uri-list', 'file://' + p);
        document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      }, join(home, 'dropped-in-place'));
      let s = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(500);
        s = await section();
        if (s && s.rows.some((r) => r.includes('dropped-in-place'))) break;
      }
      const msg = await pg.evaluate(() => document.getElementById('projErr')?.textContent ?? '');
      if (s && s.rows.some((r) => r.includes('dropped-in-place')) && /コピーしていない/.test(msg)) {
        ok('017-AC-2 場所が取れる drop はコピーせずそのまま登録(そう伝える)');
      } else fail('017-AC-2 その場登録', `rows=${JSON.stringify(s?.rows?.slice(-3))} msg=${msg}`);
      // ② 場所が取れない drop → 中身を送る(picker と同じ道)
      await tab('drop');
      await pg.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['<h1>hi</h1>'], 'index.html'));
        dt.items.add(new File(['x'], 'skip.txt'));
        const files = [...dt.files];
        files[0]._rel = 'sentfolder/index.html';
        files[1]._rel = 'sentfolder/node_modules/skip.txt';
        return intakeFiles(files, (t) => { document.getElementById('projErr').textContent = t; });
      });
      for (let i = 0; i < 15; i += 1) {
        await sleep(500);
        s = await section();
        if (s && s.rows.some((r) => r.includes('sentfolder'))) break;
      }
      const msg2 = await pg.evaluate(() => document.getElementById('projErr')?.textContent ?? '');
      if (s && s.rows.some((r) => r.includes('sentfolder')) && /1 件/.test(msg2) && /除外/.test(msg2)) {
        ok(`017-AC-3/6 中身を送って登録・除外した件数も伝える(「${msg2}」)`);
      } else fail('017-AC-3 取り込み UI', `rows=${JSON.stringify(s?.rows?.slice(-3))} msg=${msg2}`);
      if (existsSync(join(home, 'claw-workspace', 'sentfolder', 'index.html')) && !existsSync(join(home, 'claw-workspace', 'sentfolder', 'node_modules'))) {
        ok('017-AC-6 node_modules は送られていない');
      } else fail('017-AC-6 除外', 'node_modules が置かれた or index.html が無い');
    }
    // ---- PBI-016 UI: 画面から GitHub と連携する(端末を触らない)----
    {
      writeFileSync(join(ghDir, 'unauthed'), '');
      await tab('path'); // 一度離れて、戻った時に「連携」が出ることを見る
      await tab('github');
      let has = false;
      for (let i = 0; i < 15; i += 1) {
        await sleep(400);
        has = await pg.evaluate(() => !!document.getElementById('ghConnect'));
        if (has) break;
      }
      if (has) ok('016-AC-1 未認証なら一覧ではなく「GitHub と連携する」が出る');
      else fail('016-AC-1 UI 連携ボタン', await pg.evaluate(() => document.getElementById('projectsAdmin')?.textContent?.slice(0, 160) ?? '(区画無し)'));
      await pg.evaluate(() => document.getElementById('ghConnect').click());
      let shown = null;
      for (let i = 0; i < 20; i += 1) {
        await sleep(400);
        shown = await pg.evaluate(() => ({
          code: document.getElementById('ghCode')?.textContent ?? '',
          open: document.getElementById('ghOpen')?.textContent ?? '',
          cancel: !!document.getElementById('ghCancel'),
        }));
        if (shown.code) break;
      }
      if (shown?.code === 'ABCD-1234' && shown.open.includes('GitHub') && shown.cancel) ok('016-AC-1 合言葉が大きく出て、GitHub を開く導線と「やめる」が並ぶ');
      else fail('016-AC-1 UI 合言葉', JSON.stringify(shown));
      const size = await pg.evaluate(() => parseFloat(getComputedStyle(document.getElementById('ghCode')).fontSize));
      if (size >= 24) ok(`016-AC-1 合言葉は大きい(${Math.round(size)}px)`); else fail('016 合言葉の大きさ', String(size));
      writeFileSync(join(ghDir, 'approved'), ''); // ブラウザ側で許可した
      let after = null;
      for (let i = 0; i < 30; i += 1) {
        await sleep(500);
        after = await pg.evaluate(() => ({
          code: !!document.getElementById('ghCode'),
          msg: document.getElementById('projErr')?.textContent ?? '',
          list: !!document.getElementById('repoSelect'),
        }));
        if (!after.code && after.list) break;
      }
      if (!after.code && after.list && after.msg.includes('octo')) ok(`016-AC-2 承認したら合言葉が消えて一覧に変わる(「${after.msg}」)`);
      else fail('016-AC-2 UI 承認後', JSON.stringify(after));
      rm(join(ghDir, 'approved'));
      rm(join(ghDir, 'unauthed'));
    }
    {
      // 不確実性の適応: gh が入っていない環境ではフォームを使えなくし、理由を画面に出す
      writeFileSync(join(ghDir, 'missing'), '');
      await tab('github');
      let st = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(400);
        st = await pg.evaluate(() => {
          const b = document.getElementById('projClone');
          const boxEl = document.getElementById('projectsAdmin');
          const ids = [...(boxEl?.querySelectorAll('button, input, select') ?? [])].map((e) => e.id || e.textContent?.slice(0, 8));
          return b
            ? { off: b.disabled, label: b.textContent, note: boxEl?.textContent ?? '' }
            : { off: false, label: '(ボタン無し)', tab: typeof projTab === 'undefined' ? '?' : projTab, ids: ids.slice(-8), note: '' };
        });
        if (st?.off) break;
      }
      if (st?.off && st.note.includes('gh')) ok(`012 gh 不在ならボタンを止めて理由を出す: 「${st.label}」`);
      else fail('012 gh 不在の扱い', JSON.stringify(st));
      rm(join(ghDir, 'missing'));
    }
    await browser.close();
  }

  room.stop();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} pass${BASELINE ? '(負の対照モード: 赤が出るのが正)' : ''}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

async function launchBrowser() {
  const cands = ['playwright'];
  const npx = join(homedir(), '.npm', '_npx');
  try { for (const d of readdirSync(npx)) cands.push(join(npx, d, 'node_modules', 'playwright', 'index.mjs')); } catch { /* 無ければ飛ばす */ }
  cands.push(join(homedir(), '.claude', 'skills', 'gstack', 'node_modules', 'playwright', 'index.mjs'));
  for (const c of cands) {
    try { const mod = await import(c); return await mod.chromium.launch({ executablePath: localChromium() }); } catch { /* 次の候補へ */ }
  }
  return null;
}

main().catch((e) => { console.error('前提エラー:', e.message); process.exit(2); });
