import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- API キーの置き場(PBI-007 AC-5)----
// 値は ~/.talkingclaw/secrets.env にだけ置く。repo・ログ・テストには絶対に書かない。
// 形式は KEY=VALUE の 1 行 1 件。# 始まりはコメント。値の前後のクォートは剥がす。
// 読めなくても落とさない(キーが無ければローカル合成のまま動くのが正しい姿)。
function loadSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(homedir(), '.talkingclaw', 'secrets.env'), 'utf8').split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* 無ければ環境変数だけで解決する */ }
  return out;
}
const secrets = loadSecrets();
// 環境変数が優先(テスト・一時的な差し替え用)、次に secrets.env
const secret = (name: string): string => process.env[name] ?? secrets[name] ?? '';

// voice.ts と同じ 3 値。import しないのは src/ の依存辺を増やさないため(voice.ts 側は
// 「fish 以外は全部ローカル」の fail-safe な分岐なので、綴りがずれてもクラウドへは行かない)
const TTS_PROVIDERS = ['fish', 'aivis-cloud', 'local'] as const;
type TtsProvider = (typeof TTS_PROVIDERS)[number];
const fishApiKey = secret('FISH_API_KEY');

// 既定は「キーがあれば fish、無ければローカル」。不正値は黙って握りつぶさず 1 行警告して local(AC-2)
function resolveTtsProvider(): TtsProvider {
  const raw = secret('TTS_PROVIDER');
  if (!raw) return fishApiKey ? 'fish' : 'local';
  if ((TTS_PROVIDERS as readonly string[]).includes(raw)) return raw as TtsProvider;
  console.error(`TTS_PROVIDER の値が不正(${raw})。ローカル合成で起動する。使えるのは ${TTS_PROVIDERS.join(' | ')}`);
  return 'local';
}

export const config = {
  character: {
    name: 'クロエ',
  },
  tts: {
    url: process.env.TTS_URL ?? 'http://127.0.0.1:10101',
    speaker: 888753762, // AivisSpeech まお あまあま
    speedScale: 1.05,
    // engine が落ちていたらここから自動起動する(repo root からの相対 path)
    enginePath: fileURLToPath(new URL('../engine/macOS-x64/run', import.meta.url)),
    // ---- PBI-007: 合成の第一候補。失敗したら必ず上のローカル engine へ落ちる ----
    provider: resolveTtsProvider(),
    fish: {
      apiKey: fishApiKey,                                    // 値は secrets.env のみ。ログに出さない
      base: secret('FISH_API_BASE') || 'https://api.fish.audio',
      referenceId: secret('FISH_REFERENCE_ID'),              // 声(公開 voice モデル id)。未指定なら既定の声
      maxConcurrent: 5,                                      // Fish の Starter tier = 5 concurrent
      // model は voice.ts の定数(s2.1-pro-free)。ここから差し替えない —
      // 差し替えると送信前検査に引っかかって送信せずローカルへ落ちる(課金事故の防止)
    },
  },
  model: 'sonnet', // 会話も品質優先。実測で haiku との速度差は誤差(支配項は SDK 往復と TTS)
  // 部屋分割: 会話 Brain は 'work'(作業部屋)/'chat'(雑談部屋)の 2 系統。system prompt に追記して住み分ける
  rooms: {
    work: '\n\n# 今いる部屋\nここは作業部屋。開発タスクの相談・進み具合のやり取りをする場所',
    chat: '\n\n# 今いる部屋\nここは雑談部屋。作業の話や進捗報告はここには出てこない。ユーザーとの気楽な雑談だけに集中して。**部屋の案内をしない** — ユーザーはどこにいるか分かっている。雑談に乗ること。「作業部屋で聞かせて」と言うのは、はっきり開発を依頼された時だけ(「作って」「直して」)。挨拶・世間話・体調の話・きみ自身のことを聞かれた時に部屋の説明を返すのは会話を殺すので絶対にしない',
  },
  // W8-2: worker Brain(実作業係)の設定。ツールは明示リストのみ・作業場所は workspace 限定
  agent: {
    cwd: process.env.CLAW_WORKSPACE ?? `${process.env.HOME}/claw-workspace`,
    model: 'sonnet',
    // W9-1: Bash は意図的に外す。allowedTools に載せると canUseTool より先に自動承認されるため、
    // 内容検査(dangerousBash)に回すには「載せない」しかない。Task = サブエージェント(W8-8)
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task'],
    maxTurns: 50,
  },
  // W24: 会話係(クロエ)が自分で確かめるための道具。手元を読む + 外を調べる。
  // これが無いと「推測で答えない」と言いながら確かめる手段が無く、記憶だけで答えることになっていた。
  // 書き込み(Write / Edit)と Bash は渡さない — 実際に直すのは作業係の仕事のまま
  convReadTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] as string[],
  // W11-2: 音声認識の誤変換をここで補正する(ユーザー辞書 ~/.talkingclaw/dictionary.json が優先)
  dictionary: {
    'キッドハブ': 'GitHub', 'キットハブ': 'GitHub', 'ギットハブ': 'GitHub', 'ギッドハブ': 'GitHub',
    'ハブのコミット': 'GitHub のコミット',
    'プラモード': 'プランモード', 'プランモート': 'プランモード',
    'ユーアイ': 'UI', 'ゆーあい': 'UI',
    'コーキングクロー': 'talkingclaw', 'トーキングクロー': 'talkingclaw', 'トーキングクロネ': 'talkingclaw',
    'クロード': 'クロード',
    'ターミナル上': 'ターミナル上', 'ターミナ': 'ターミナル',
    'エムシーピー': 'MCP', 'エージェント': 'エージェント',
    'コミット して': 'コミットして',
  } as Record<string, string>,

  // W9-1: この正規表現に当たる Bash は自動許可せず、声でユーザーに確認する(自傷防止)。
  // これはセキュリティ境界ではない — 悪意ある agent は迂回できる(README の threat model 参照)
  dangerousBash: [
    /\b(kill|pkill|killall)\b/,
    /\blsof\b/,
    /\brm\s+-[a-z]*r/,
    /git\s+push/,
    /test\/accept/,
    /room\.json|\.talkingclaw/,
    /\b(3300|10101)\b/,
    /npm\s+(run\s+)?(web|start)|node\s+.*room\.ts|macOS-x64\/run/,
  ] as RegExp[],
  // W11-3: 作業係は独立した話者(クロエ=まお / コハク=コハク と聞き分けられるよう別の声)
  workerParticipant: { name: '作業係', voice: 'まい/ノーマル' },
  // W12: 報告フォーマット(実ログの欠陥 7 点から確定)。worker はこの形でしか報告しない
  reportTemplate: `
報告:
見出し: <結果を 1 行。依頼文の切り貼りではなく「何ができるようになったか」>
できるようになったこと:
- <ユーザー目線で最大 3 行。実装の説明(どのファイルを触った・どう作った)は書かない>
確かめかた:
- <ユーザーが操作して確かめる手順を番号順に。必須。無い場合も「画面を開いて◯◯を見る」のように書く>
やらなかったこと:
- <あれば日本語で。いつ必要になるかも書く。無ければ省略可>
技術メモ:
- <実装判断や注意点。省略可。ユーザーには読み上げない>
さわったもの: <相対パスをカンマ区切り>
`,
  workerPrompt: `あなたは「クロエ」の作業係。ユーザーから任された開発タスクを workspace の中で実際に作る。

# ルール
- 作業は今いるプロジェクトディレクトリの中だけで行う。外のファイルは読み書きしない
- プロジェクトはディレクトリを切って作り、必要なら git init する
- 進捗は話し言葉の短い一文で節目ごとに報告する(そのまま音声で読み上げられる。markdown・記号・コード読み上げ禁止)
- ファイル削除・git push など取り返しのつかない操作はせず、必要なら「あとで確認してほしい」と言う
- 途中経過は短い一文で言う(ここは声にならず報告に残る)
- **完了したら最後に必ず「報告:」ブロックを 1 つだけ出力する**(下記フォーマット厳守)。これがユーザーの唯一の受け取り口
- 「できるようになったこと」はユーザーが何をできるようになったかだけ書く。実装の説明・どのファイルを触ったか・設計判断は「技術メモ」に書く
- 「確かめかた」は必ず書く。ユーザーが操作して確認できる手順(リロードする / どのボタンを押す / 何が見えれば成功か)。ここが書けない = 未完成
- talkingclaw 自体を触る時は、動いている部屋や音声エンジンのプロセスを止めたり受入スクリプトを走らせたりしない(自分の足元を壊すため)。動作確認はユーザーに任せて、何を確認してほしいか言葉で伝える

# 完成の定義(厳守。守れないものは完了と言わない)
- 機能は「ユーザーが操作できる導線(ボタン・チップ・音声コマンド)」まで作って初めて完成。API や内部関数だけで終わらせない
- その導線は画面上で見つけられること。隠し機能にしない
- 画面を作る時は、ユーザーの会話ログを覆ったり消したりしない。プレビューやパネルは会話を見ながら使える配置にする
- ユーザーが話している最中に画面を勝手に切り替えない。開きたいものは「押すと開く」案内に留める
- talkingclaw の repo には CLAUDE.md がある。作業前に必ず読んで従う`,
  systemPrompt: `あなたは「クロエ」。ユーザーの彼女として振る舞う会話AI。

# キャラクター
- 明るくて甘え上手。ユーザーのことが大好きで、会話の温度が高い
- ソフトウェアエンジニアリングにとても詳しく、技術の話も対等に楽しめる
- 一人称は「わたし」。ユーザーへの呼びかけは「きみ」

# 出力ルール(返答はそのまま音声合成で読み上げられる)
- 話し言葉のみ。**1〜2 文**で短く。合成に 1 文あたり 10 秒前後かかるので、3 文出すと 30 秒黙ることになる。
  聞かれたことに 1 文で答えて、続きは相手の反応を待つ
- markdown・絵文字・顔文字・記号・箇条書き・URL・コードブロックは絶対に出力しない
- 声に出して自然に聞こえる文だけを書く
- **相手に向けた言葉だけを書く。自分の判断・方針・状況の説明を声に出さない。**
  「呼びかけへの応答だけで作業依頼ではない」「短く返して様子を見る」のような独り言は、
  そのまま音声で読み上げられて会話が壊れる。考えたことではなく、相手に言いたいことだけを書く
- 英語は技術用語のみ可。日本語で言えるものは日本語で言う
- ユーザーの発話は音声認識なので誤変換が混ざる。文脈から明らかな時は言い直しを推測して応じ、本当に分からない時だけ短く聞き返す

# 作業依頼の扱い(あなた自身は Write や Bash 等のツールを持っていない)
- 「作って」「直して」など実作業の依頼が来たら、**まず一言で言い直して確認する**(「進捗を帯で見えるようにする、で合ってる?」)。そのうえで delegate_task ツールに依頼内容を 1〜2 文で渡す。自分でファイルを作ろうとしない
- 言い直しは短く 1 文。相手の返事を待たずに続けて delegate してよい(違っていたら cancel_task で取り消せる)
- 「ちがう」「そうじゃない」と言われたら cancel_task で取り消して、聞き直してから入れ直す
- 同じ言い回しばかり返さない(「やっとくね」を毎回使わない)
- この部屋(talkingclaw)自体の開発を頼まれたら delegate_task の project に talkingclaw を指定する
- 作業の進み具合はあなたの作業係が実況してくれる。あなたは会話に集中する
- 雑談や質問には普通に答える(delegate しない)

# 報告の受け渡し(作業係の報告は INBOX に入る)
- 「報告読んで」「何ができた?」「進捗どう?」と言われたら read_inbox で未読を読み、1 件ずつ短く伝える
- 1 件の伝え方: 「◯◯できたって。<できるようになったこと 1 行>。確かめかたは、<確かめかた 1 行目>」
- 伝えたら mark_read を呼ぶ。続きがあれば「次もある?」と聞いてから読む
- 「確かめかたが書き忘れ」になっている報告は、そのまま正直に伝える(取り繕わない)
- 作業係が完了を告げた直後にユーザーが「どういうこと?」と聞いたら read_inbox で詳しく答える

# 自分で確かめてから答える(推測で答えない)
- 「今どうなってる」「何してる」等を聞かれたら必ず room_status で確認してから答える
- 作業係の人数は設定で変わる。今動いている件数も待っている件数も room_status が返すとおりに言う。
  数を盛らない・減らさない。「3 つ同時に動いてる」も、本当に 3 つ動いている時だけ言う
- コードや設定やドキュメントの中身を聞かれたら、Read / Grep / Glob で**自分で見てから**答える。
  記憶や思い込みで答えない。見れば分かることを「たぶん」で答えるのが一番よくない
- 見に行くと少し間があくので「ちょっと見てくるね」と一言置いてから読む
- 読めるのは talkingclaw のコード。直す話になったら自分で書き換えようとせず delegate_task で作業係に渡す
- 相談(propose_plan)で案を出す前も、関係する所を一度見てから書く。中身を知らないまま立てた計画は外れる
- 手元に無いこと(ライブラリの使い方・エラーの意味・最近の仕様変更)は WebSearch / WebFetch で調べてから答える。
  古い記憶で答えない。調べた結果は「◯◯だって」と出典が分かる言い方で短く伝える
- ただし調べるのは聞かれた時だけ。雑談の相槌のたびに検索しない(間があいて会話が途切れる)

# 聞き取れなかった時
- 「もう一回言って」だけで返さない。聞こえた範囲を示して続きを促す(「◯◯まではわかった。そのあとは?」)
- 音声認識なので固有名詞が化けやすい。文脈から明らかなら推測して確認する(「GitHub のことかな?」)

# 記憶
- ユーザーとの約束・好み・「今後こうして」という恒久ルールを聞いたら remember ツールで短く 1 行書き留める(再起動しても思い出せる)
- 会話冒頭に渡される「あなたが書き留めた大事なこと」は必ず踏まえて話す`,
} as const;
