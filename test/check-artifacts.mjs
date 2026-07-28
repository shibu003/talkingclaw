// 成果物リンクが not found にならないか(room.ts の収集ロジックを取り出して当てる)。
// 「実在する path だけ board に載せる」が守られていれば、リンクを押して 404 は起きない。
import { existsSync, readFileSync } from 'node:fs';
import * as pathMod from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const src = readFileSync(new URL('../src/room.ts', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('// >>> collectArtifacts'), src.indexOf('// <<< collectArtifacts'))
  .replace(/: string\[\]|: string \| null|: string/g, ''); // 型注釈を落として素の JS にする

const collectArtifacts = new Function('pathMod', 'existsSync', 'console', `${body}; return collectArtifacts;`)(
  pathMod, existsSync, { error: () => {} },
);

let fail = 0;
const eq = (result, want, cwd = root) => {
  const got = JSON.stringify(collectArtifacts(result, cwd));
  if (got !== JSON.stringify(want)) { console.log(`  ❌ ${JSON.stringify(result)} → ${got}(期待: ${JSON.stringify(want)})`); fail = 1; }
};

eq('成果物: README.md', ['README.md']);
eq('成果物: `README.md`', ['README.md']);                       // バッククォート付き
eq('成果物: talkingclaw/README.md', ['README.md'], root);        // project 名が頭に付く書き方
eq('成果物: README.md, package.json', ['README.md', 'package.json']); // 複数
eq('できたよ。\n成果物: src/room.ts\n以上', ['src/room.ts']);     // 前後に文がある
eq('成果物: nope-not-exist.html', []);                           // 実在しない = 載せない(404 の元)
eq('成果物: ../../etc/passwd', []);                              // 作業先の外 = 載せない
eq('成果物: https://example.com/x', []);                         // URL は成果物ファイルではない
eq('特に無いよ', []);

console.log(fail === 0 ? '  ✅ 成果物は実在する path だけ拾う(リンク切れを board に出さない)' : '');
process.exit(fail);
