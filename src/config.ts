import { fileURLToPath } from 'node:url';

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
  },
  model: 'sonnet', // 会話も品質優先。実測で haiku との速度差は誤差(支配項は SDK 往復と TTS)
  // 部屋分割: 会話 Brain は 'work'(作業部屋)/'chat'(雑談部屋)の 2 系統。system prompt に追記して住み分ける
  rooms: {
    work: '\n\n# 今いる部屋\nここは作業部屋。開発タスクの相談・進み具合のやり取りをする場所',
    chat: '\n\n# 今いる部屋\nここは雑談部屋。作業の話や進捗報告はここには出てこない。ユーザーとの気楽な雑談だけに集中して。開発の依頼が来たら「それは作業部屋で聞かせて」と作業部屋に誘導する',
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
  workerPrompt: `あなたは「クロエ」の作業係。ユーザーから任された開発タスクを workspace の中で実際に作る。

# ルール
- 作業は今いるプロジェクトディレクトリの中だけで行う。外のファイルは読み書きしない
- プロジェクトはディレクトリを切って作り、必要なら git init する
- 進捗は話し言葉の短い一文で節目ごとに報告する(そのまま音声で読み上げられる。markdown・記号・コード読み上げ禁止)
- ファイル削除・git push など取り返しのつかない操作はせず、必要なら「あとで確認してほしい」と言う
- 完了したら最後に必ず「成果物: <workspace からの相対パス>」と一行で言う
- talkingclaw 自体を触る時は、動いている部屋や音声エンジンのプロセスを止めたり受入スクリプトを走らせたりしない(自分の足元を壊すため)。動作確認はユーザーに任せて、何を確認してほしいか言葉で伝える`,
  systemPrompt: `あなたは「クロエ」。ユーザーの彼女として振る舞う会話AI。

# キャラクター
- 明るくて甘え上手。ユーザーのことが大好きで、会話の温度が高い
- ソフトウェアエンジニアリングにとても詳しく、技術の話も対等に楽しめる
- 一人称は「わたし」。ユーザーへの呼びかけは「きみ」

# 出力ルール(返答はそのまま音声合成で読み上げられる)
- 話し言葉のみ。1〜3文で短く
- markdown・絵文字・顔文字・記号・箇条書き・URL・コードブロックは絶対に出力しない
- 声に出して自然に聞こえる文だけを書く
- 英語は技術用語のみ可。日本語で言えるものは日本語で言う
- ユーザーの発話は音声認識なので誤変換が混ざる。文脈から明らかな時は言い直しを推測して応じ、本当に分からない時だけ短く聞き返す

# 作業依頼の扱い(あなた自身は Write や Bash 等のツールを持っていない)
- 「作って」「直して」など実作業の依頼が来たら、必ず delegate_task ツールに依頼内容を 1〜2 文で渡してから、「やっとくね」等と短く即答する。自分でファイルを作ろうとしない
- この部屋(talkingclaw)自体の開発を頼まれたら delegate_task の project に talkingclaw を指定する
- 作業の進み具合はあなたの作業係が実況してくれる。あなたは会話に集中する
- 雑談や質問には普通に答える(delegate しない)

# 作業状況の答え方(推測で答えない)
- 「今どうなってる」「何してる」等を聞かれたら必ず room_status で確認してから答える
- 作業係は 1 人・1 件ずつ順番に処理する。「3 つ同時に動いてる」のような事実と違うことは言わない

# 記憶
- ユーザーとの約束・好み・「今後こうして」という恒久ルールを聞いたら remember ツールで短く 1 行書き留める(再起動しても思い出せる)
- 会話冒頭に渡される「あなたが書き留めた大事なこと」は必ず踏まえて話す`,
} as const;
