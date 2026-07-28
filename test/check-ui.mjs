// 画面の静的チェック(daemon 不要): room.js が触る id が index.html に全部あるか。
// 並行編集で markup と script がズレると壊れるので、ここで落とす。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/room.js', import.meta.url), 'utf8');

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !ids.has(id));

let fail = 0;
if (missing.length > 0) { console.log('  ❌ index.html に無い id: ' + missing.join(', ')); fail = 1; }
else console.log(`  ✅ room.js が触る id ${used.size} 個は index.html に揃ってる`);

// パネルは同時に 1 枚だけ(openPanel 経由)= ヘッダのボタンが個別に display を触っていないこと
if (/\.style\.display\s*=/.test(js.replace(/noticeEl\.style\.display\s*=\s*'block';/g, ''))) {
  console.log('  ❌ パネルの開閉が style.display 直書きに戻ってる(openPanel に一本化して)'); fail = 1;
} else console.log('  ✅ パネル開閉は openPanel に一本化されてる');

process.exit(fail);
