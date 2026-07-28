// 音声ナビの言葉の判定(navIntent)を単体で検査する。room.js は素の <script> なので
// マーカーで囲んだ純関数だけ取り出して評価する(DOM もサーバも要らない)。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/room.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('// >>> navIntent'), src.indexOf('// <<< navIntent'));
const navIntent = new Function(`${body}; return navIntent;`)();

const ROOMS = [
  { channel: 'work', label: '🛠 作業部屋' },
  { channel: 'chat', label: '💬 雑談部屋' },
  { channel: 'design', label: 'デザイン相談' },
];
let fail = 0;
const eq = (text, want) => {
  const got = navIntent(text, ROOMS);
  const g = got ? got.kind + (got.channel ? ':' + got.channel : '') : 'null';
  if (g !== want) { console.log(`  ❌ 「${text}」→ ${g}(期待: ${want})`); fail = 1; }
};

// 画面を開く
eq('部屋一覧見せて', 'rooms');
eq('部屋のリスト出して', 'rooms');
eq('作業ボード見せて', 'board');
eq('進捗どう', 'board');
eq('設定開いて', 'settings');
eq('履歴見せて', 'history');
eq('アーカイブ出して', 'archive');
eq('閉じて', 'close');
// 部屋に入る(正式名・語幹・rename 後の名前)
eq('雑談部屋に行って', 'enter:chat');
eq('作業部屋', 'enter:work');
eq('雑談に切り替えて', 'enter:chat');
eq('デザイン相談に入って', 'enter:design');
// 会話を誤って乗っ取らない
eq('今日はいい天気だね、そっちはどう?', 'null');
eq('さっき話してた履歴のことなんだけど、まだ残ってるか調べておいてほしいな', 'null');
eq('部屋の掃除をする話を前にしたよね、あれから進んでるのか気になってるんだけど', 'null');
// 「作業ボード」は作業部屋より先に判定される(語の食い合い)
eq('作業ボード', 'board');

console.log(fail === 0 ? '  ✅ 音声ナビの言葉の判定は全部期待どおり' : '');
process.exit(fail);
