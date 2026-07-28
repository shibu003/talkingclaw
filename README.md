# talkingclaw — 声の部屋

アニメ声の agent たちと**喋りながらコーディングする**ローカル OSS。Claude Code / Codex / Gemini CLI など MCP 対応の coding agent が 1 つの「声の部屋」に同席し、agent ごとに違うアニメ声(AivisSpeech)で返事や作業実況をする。**API キー不要 — 各 CLI のログイン(サブスク)と無料のローカル TTS / ブラウザ STT だけで動く。**

- 部屋に agent が 1 人なら一対一の音声会話(**talkingclaw**)、複数入れば名前で呼び分けるマルチ agent ルーム(**talking orchestra**)。モード切替は不要 — 参加者数がモード。
- 内蔵キャラ「クロエ」(Claude Agent SDK、Claude Code の認証を継承)が既定で在室。名指しなしの発話はクロエへ。

## 必要環境

- macOS + Chrome(音声認識に Web Speech API を使用)
- Node.js >= 23.6(TypeScript 直接実行)
- [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine/releases) を `engine/macOS-x64/` に展開(落ちていれば部屋が自動起動・自動復旧する)
- Claude Code にログイン済み(内蔵クロエ用)
- ※ Intel Mac は AivisSpeech 公式サポート外(本プロジェクトでは動作するが合成 1 文 4 秒級 — 相槌と filler で体感を補っている)

## 使い方

```sh
npm install
npm run web          # 部屋を起動 → Chrome で http://localhost:3300 → 🎤 ON で音声会話
npm run cli          # 同じ部屋を terminal から(打ち込む・聞く・見る。音声入力だけブラウザ専用)
npm run setup-voice  # 第3の声「まい」を AivisHub から導入(同意フロー付き)
npm start            # 旧: テキスト入力の一対一 CLI
npm run smoke        # 非対話スモーク
npm run metrics      # レイテンシ・被覆率レポート(~/.talkingclaw/metrics.jsonl)
bash test/accept-3a1ai.sh などで受入テスト一式
```

### coding agent を部屋に入れる(MCP)

```sh
# Claude Code(instructions は自動で読み込まれる)
claude mcp add talkingclaw -- node /path/to/talkingclaw/src/mcp.ts
```

```toml
# Codex CLI(~/.codex/config.toml)
[mcp_servers.talkingclaw]
command = "node"
args = ["/path/to/talkingclaw/src/mcp.ts"]
env = { AGENT_NAME = "コハク", VOICE = "コハク/ノーマル" }
```

```jsonc
// Gemini CLI(~/.gemini/settings.json)— useInstructions を忘れずに
"mcpServers": { "talkingclaw": {
  "command": "node", "args": ["/path/to/talkingclaw/src/mcp.ts"],
  "env": { "AGENT_NAME": "マイ", "VOICE": "まい/ノーマル" },
  "timeout": 600000, "useInstructions": true } }
```

agent の CLI を起動して「声の部屋に入って会話して」と言えば listen で待ち始める。ブラウザから「コハク、これ直して」のように**名前で呼び分け**、在室リストのチップをクリックして**話し相手を固定**できる。

- env: `AGENT_NAME`(部屋での名前)/ `VOICE`(`モデル名/スタイル名`)/ `PORT`(既定 3300)
- 声は AivisSpeech の任意モデルを指定可(`curl http://127.0.0.1:10101/speakers` で一覧)

### terminal から使う

```sh
npm run cli   # 部屋が無ければ自動で起動する
```

ブラウザと同じ部屋に繋がり、会話ログが流れ、**クロエたちの声はそのまま鳴る**(afplay)。
打ち込んだ文はそのまま発言になる。コマンド: `/tasks`(作業ボード)`/who`(在室)
`/settings [key] [value]`(モデル・effort の確認と変更)`/room chat|work`(部屋切替)
`/log [n]` `/mute` `/quit`。`CLI_MUTE=1` で無音運用。

**音声入力(マイク)だけはブラウザ専用** — 認識に使う Web Speech API がブラウザの機能のため。
喋りたい時はブラウザ、打ち込みたい時は terminal、と使い分けられる(同じ部屋・同じ記憶)。

## 体感を作っている仕組み

- **相槌 0.5 秒前後**: 発話確定と同時に事前合成 WAV を再生(LLM を経由しない)
- **filler 被覆**: 返事が遅い間は「いま考えてるところ」→ 状況報告 ×2 → 打切り、と段階的に間を繋ぐ
- **barge-in**: agent の音声再生中に話し始めると VAD(silero v5、ローカル)が検知して即座に黙る
- **stale drop**: あなたが次の発話をしたら古い読み上げは破棄(テキストは残る)
- **自己修復**: 部屋 daemon・音声エンジンが落ちても自動復旧。agent の接続も透過的に回復(daemon kill から 1 秒で復帰)

## アーキテクチャ

```
各 agent CLI ─ MCP stdio ─ src/mcp.ts(thin proxy)×N
                              │ HTTP 127.0.0.1:3300(token)
                              ▼
   room daemon(src/room.ts + src/roomcore.ts)
     EventStore(append-only log + cursor 配送)/ Registry(takeover/presence)
     Router(名前 > 選択 > floor > default)/ TtsScheduler / FillerEngine / EngineManager
                              ▼
   ブラウザ(Web Speech マイク・audio 要素再生・timeline・在室リスト)
```

## セキュリティ / threat model

- bind は 127.0.0.1 のみ。token は GET / がページに埋め込んで配布(no-store)。**token が守るのはブラウザ経由の cross-origin 攻撃(CSRF / DNS rebinding)のみ**で、同一マシン内の他プロセスには効かない(ローカル専用ツールとしての割り切り)
- Web Speech API は音声を Google のサーバで認識する(完全ローカル STT は今後の課題)
- 部屋の発話は各 agent にとって未信頼入力。agent 間の prompt injection は防御対象外
- 作業係の Bash 危険コマンド検査(kill / rm -rf / git push 等 → 声で許可を求める)は**自傷防止であり、悪意ある agent に対するセキュリティ境界ではない**(パターン検査は迂回可能)

## クレジット

- 音声合成: [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine)(LGPL-3.0、REST 連携)
- 音声モデル(いずれも ACML 1.0、クレジット表記は任意・推奨): まお(オズチャット)/ コハク(同)/ まい(MAHOPROGRAM)。モデルは初回セットアップ時に AivisHub からダウンロードされ、各モデルの利用規約に従う。なりすまし・誹謗中傷等の禁止事項は生成音声の利用者の責任
- VAD: [@ricky0123/vad-web](https://github.com/ricky0123/vad)(silero VAD v5)+ onnxruntime-web

## 類似プロジェクトとの違い

mcp-simple-aivisspeech(単一 agent・サーバ側再生)、voicemode(単一 agent・サーバ側マイク)、AgentsRoom(closed・全 agent 同一声)等と異なり、**複数社の agent が同席して agent 別の声でライブに会話でき**、ブラウザが入出力端末になる。agent のプロセス管理はしないので vibe-kanban 等のオーケストレータと併用できる。
