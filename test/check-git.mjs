// 自動コミットの秘密よけを検査する(daemon 不要)。room.ts から正規表現だけ取り出して当てる。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/room.ts', import.meta.url), 'utf8');
const lit = src.match(/const SECRET_RE = (\/.+\/i);/);
let fail = 0;
if (!lit) {
  console.log('  ❌ SECRET_RE が見つからない(自動コミットの秘密よけが消えてる?)');
  process.exit(1);
}
const SECRET_RE = new Function(`return ${lit[1]}`)();
const blocked = (f) => SECRET_RE.test(f) && !/\.(example|sample|template)$/i.test(f);

for (const f of ['.env', '.env.local', 'app/.dev.vars', 'deploy/id_rsa', 'certs/server.pem', 'keys/api.key', '.aws/credentials']) {
  if (!blocked(f)) { console.log(`  ❌ ${f} を止められていない`); fail = 1; }
}
for (const f of ['src/room.ts', 'public/room.js', 'README.md', 'docs/monkey.js', '.env.example', 'config/.dev.vars.sample']) {
  if (blocked(f)) { console.log(`  ❌ ${f} を秘密と誤判定してコミットが止まる`); fail = 1; }
}
// push は既定 OFF(取り返しがつかないので明示 ON した時だけ)
if (!/autoPush:\s*false/.test(src)) { console.log('  ❌ autoPush の既定が false でない'); fail = 1; }

if (fail === 0) console.log('  ✅ 自動コミットの秘密よけと push 既定 OFF は保たれてる');
process.exit(fail);
