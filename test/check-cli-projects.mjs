// PBI-020: terminal だけで作業先を完結できるか。稼働中の部屋(3300)には触らない —
// 隔離 HOME + 空きポート + fake engine + 偽 gh だけを使い、cli.ts に実際にコマンドを打ち込む。
//
// 実行: node test/check-cli-projects.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const results = [];
const ok = (n) => { results.push({ ok: true }); console.log('ok      -', n); };
const fail = (n, e) => { results.push({ ok: false }); console.log('FAIL    -', n, ':', e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((r) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

async function engineFake() {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(new URL(req.url, 'http://x').pathname === '/speakers' ? '[]' : '"fake"');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// 偽 gh(clone だけ演じる)。本物の GitHub には 1 リクエストも出さない
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-cli-gh-'));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.60.0 (fake)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  [ -f "${dir}/unauthed" ] && exit 1
  echo tok; exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  if [ -f "${dir}/unauthed" ]; then
    echo "To get started with GitHub CLI, please run:  gh auth login" >&2
    exit 1
  fi
  mkdir -p "$4/.git" && printf 'hi\\n' > "$4/README.md" || exit 1
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return dir;
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'claw-cli-home-'));
  const ghDir = fakeGh();
  const engine = await engineFake();
  const port = await freePort();
  const env = { ...process.env, HOME: home, PORT: String(port), NO_CHLOE: '1', GH_BIN: join(ghDir, 'gh'),
                PATH: `${ghDir}:${process.env.PATH}`, TTS_URL: engine.base, FISH_API_KEY: 'X', FISH_API_BASE: engine.base };
  const room = spawn(process.execPath, ['src/room.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { try { room.kill('SIGTERM'); } catch { /* */ } engine.close(); };
  process.once('exit', stop);
  for (let i = 0; ; i += 1) {
    if (i > 200) { stop(); throw new Error('部屋が起動しない'); }
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })).status === 200) break; } catch { /* 待つ */ }
    await sleep(200);
  }

  // 「登録したいフォルダで cli を開いている」状況を作る(cli の cwd = そのフォルダ)
  const proj = join(home, 'myproject');
  mkdirSync(proj, { recursive: true });
  const cli = spawn(process.execPath, [join(REPO, 'src', 'cli.ts')], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  cli.stdout.on('data', (d) => { out += d.toString(); });
  cli.stderr.on('data', (d) => { out += d.toString(); });
  // 固定 sleep で待たない —— 返事が届くまでの時間は machine の混み具合で変わる。
  // 1500ms 固定だと、他の検査と並んで走った時に out が空のまま判定して落ちていた(実測)。
  // 欲しい行が来るまで見に行き、来なければ timeout してその時点の出力を見せる
  const type = async (line, want, maxMs = 15_000) => {
    out = '';
    cli.stdin.write(line + '\n');
    for (const until = Date.now() + maxMs; Date.now() < until;) {
      if (want.test(out)) { await sleep(150); return out; } // 画面より先に台帳が落ちきるのを待つ
      await sleep(50);
    }
    return out;
  };
  await sleep(2500); // 起動と購読

  {
    const o = await type('/help', /\/project/);
    if (/\/project/.test(o)) ok('020-AC-6 /help に /project が載っている'); else fail('020-AC-6 help', o.slice(-200));
  }
  {
    // 引数なし = 今いる場所。パスも名前も打たない
    const o = await type('/project add', /を作業先にした/);
    const disk = readFileSync(join(home, '.talkingclaw', 'projects.json'), 'utf8');
    if (/myproject を作業先にした/.test(o) && disk.includes('"myproject"') && disk.includes(proj)) {
      ok('020-AC-1 /project add だけで、今いる場所が登録される(パスを打たない)');
    } else fail('020-AC-1 add', o.slice(-300));
  }
  {
    const o = await type('/project', /今ここ/);
    if (/myproject/.test(o) && /今ここ/.test(o)) ok('020-AC-3 /project で一覧が出て、今いる場所が分かる');
    else fail('020-AC-3 list', o.slice(-300));
  }
  {
    const o = await type('/project clone octo/fromcli', /を作業先にした/);
    const disk = readFileSync(join(home, '.talkingclaw', 'projects.json'), 'utf8');
    if (/fromcli を作業先にした/.test(o) && disk.includes('"fromcli"')) ok('020-AC-4 /project clone owner/repo で clone → 登録');
    else fail('020-AC-4 clone', o.slice(-300));
  }
  {
    writeFileSync(join(ghDir, 'unauthed'), '');
    const o = await type('/project clone octo/needauth', /gh auth login/);
    if (/gh auth login/.test(o)) ok('020-AC-4 未認証なら打つべきコマンドをそのまま出す');
    else fail('020-AC-4 未認証の案内', o.slice(-300));
  }
  {
    const o = await type('/project rm myproject', /外したよ/);
    const disk = readFileSync(join(home, '.talkingclaw', 'projects.json'), 'utf8');
    if (/外したよ/.test(o) && !disk.includes('"myproject"')) ok('020-AC-5 /project rm で登録だけ外す(フォルダは残る)');
    else fail('020-AC-5 rm', o.slice(-300));
    const o2 = await type('/project rm talkingclaw', /土台/);
    if (/土台/.test(o2)) ok('020-AC-5 土台 2 つは外せない'); else fail('020-AC-5 土台保護', o2.slice(-200));
  }
  {
    const m = readFileSync(join(home, '.talkingclaw', 'metrics.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (m.some((x) => x.kind === 'project_add' && x.via === 'cli') && m.some((x) => x.kind === 'project_clone' && x.via === 'cli')) {
      ok('OBSERVE terminal から入った登録が via: cli で残る');
    } else fail('OBSERVE via cli', JSON.stringify(m.filter((x) => String(x.kind).startsWith('project_')).slice(-4)));
  }

  cli.stdin.write('/quit\n');
  await sleep(500);
  try { cli.kill('SIGTERM'); } catch { /* */ }
  stop();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} pass`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => { console.error('前提エラー:', e.message); process.exit(2); });
