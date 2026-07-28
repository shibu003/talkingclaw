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
const PEOPLE = [{ participantId: 'p1', name: 'コハク' }, { participantId: 'p2', name: 'まい' }];
let fail = 0;
const eq = (text, want, hasPlan = false) => {
  const got = navIntent(text, ROOMS, PEOPLE, hasPlan);
  const detail = got ? (got.channel ?? got.name ?? (got.kind === 'mic' ? (got.on ? 'on' : 'off') : got.participantId)) : null;
  const g = got ? got.kind + (detail ? ':' + detail : '') : 'null';
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

// 他タスクで増える画面 —— 作る・名前を変える・成果物・マイク・話し相手
eq('新しい部屋作って', 'create');
eq('デザイン相談って部屋作って', 'create:デザイン相談');
eq('部屋を作って、名前はレビュー会', 'create:レビュー会');
eq('この部屋の名前をデザイン相談に変えて', 'rename:デザイン相談');
eq('名前をレビュー会にして', 'rename:レビュー会');
eq('部屋の名前変えて', 'rename');
eq('成果物見せて', 'artifact');
eq('できたやつ見せて', 'artifact');
eq('会話ログ出して', 'logfile');
eq('マイク切って', 'mic:off');
eq('マイクつけて', 'mic:on');
eq('ハンズフリーやめて', 'mic:off');
eq('コハクと話す', 'speaker:コハク');
eq('まいに聞いて', 'speaker:まい');
eq('みんなに戻して', 'speaker');   // 相手指定を自動に戻す
eq('戻って', 'close');             // 画面を戻す方は close
eq('みんなに切り替えて', 'speaker');
// 作る・変えるの言葉でも、雑談は拾わない
eq('新しいカフェができたらしいよ、今度いっしょに行ってみたいなって思ってるんだけど', 'null');

// 相談の締め(第 4 引数 = 案が画面に出ているか)
const P = true;
eq('終わり', 'plan-confirm', P);
eq('それでいこう', 'plan-confirm', P);
eq('オッケー、それでお願い', 'plan-confirm', P);
eq('じゃあ始めて', 'plan-confirm', P);
eq('やっぱやめて', 'plan-cancel', P);
eq('キャンセルで', 'plan-cancel', P);
// 直したい時は確定しない(相談を続ける)
eq('でも二番目のところ変えてほしい', 'null', P);
eq('ちょっと待って', 'null', P);
eq('もう一度考えて', 'null', P);
// 案が出ていない時は普通の会話として素通しする
eq('終わり', 'null');
eq('それでいこう', 'null');
// 案が出ていても画面移動の言葉はこれまで通り効く
eq('部屋一覧見せて', 'rooms', P);
eq('マイク切って', 'mic:off', P);

console.log(fail === 0 ? '  ✅ 音声ナビの言葉の判定は全部期待どおり' : '');
process.exit(fail);
