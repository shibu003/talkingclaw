# talkingclaw 現時点の図(2026-08-06)

出典: `CLAUDE.md` / `AGENTS.md` / `.kaiwa-loop/handoffs/004.md` / `src/{cli,room,config,brain,mcp}.ts` の grep 実測。
コードから自明でない構造だけを描く。コードが変わったらこの図も同じ commit で直す(嘘の図は消す方がまし)。

## 1. ガバナンス図 — 4 層と、誰が何に縛られるか

```mermaid
flowchart TB
  subgraph agents["並走する 2 エージェント"]
    CL["Claude Code"]
    CX["Codex"]
  end
  subgraph L1["層1 指示"]
    CM["CLAUDE.md<br>グローバル + repo"]
    AM["AGENTS.md<br>repo + ~/.codex"]
  end
  subgraph L2["層2 手順の正本"]
    NW["~/OhJOJO/newway.md<br>G1→G2 ゲート手順"]
    SK["skills 正本 ~/.claude/skills<br>~/.codex/skills へ symlink 共有"]
    LS["LESSONS.md 台帳<br>行動別 12 ファイル"]
  end
  subgraph L3["層3 強制"]
    HK["newway-gate.sh<br>PreToolUse Write/Edit<br>backlog/ に ready・doing の PBI が鍵"]
  end
  subgraph L4["層4 図"]
    DG["docs/diagrams.md<br>この文書"]
  end
  CL --> CM
  CX --> AM
  CM --> NW
  AM --> NW
  CM --> SK
  AM --> SK
  CM --> LS
  NW --> HK
  HK ==>|"ツール呼び出しを実際に拒否"| CL
  HK -.->|"枠外。AGENTS.md の規律のみ"| CX
  NW --> DG
```

拘束の非対称(意図した設計): Claude は hook で止まる。Codex は止まらない — Codex への強制は
AGENTS.md の記述だけなので、**Codex の実装編集は PBI の存在を人が確認する**。
共有資源: MCP 4 つ(context7 / playwright / obsidian / talkingclaw)、`.kaiwa-loop/handoffs/`(着手・完了宣言)、`backlog/`。
並走規約: worktree 分離・main へは直列 merge(repo `AGENTS.md` 並走 5 か条)。

## 2. 構成 + デプロイ図 — 何がどのポートで動き、どう繋がるか

```mermaid
flowchart LR
  U["ユーザー"]
  U -->|"声"| LSN["claw-listen<br>tools/listen.swift<br>Apple Speech STT<br>音量ゲート STT_GATE=0.02"]
  LSN --> CLI["CLI src/cli.ts<br>afplay 再生<br>audioGen 世代照合"]
  U -->|"ブラウザ"| PUB["部屋 UI public/"]
  CLI -->|"HTTP/SSE :3300 のみ"| ROOM["部屋サーバ src/room.ts<br>port 3300"]
  PUB --> ROOM
  MCP["MCP src/mcp.ts<br>参加者コハク(Claude)<br>Codex も接続可"] --> ROOM
  ROOM --> BR["brain.ts クロエ<br>claude-agent-sdk<br>APIキー不要"]
  ROOM -->|"合成"| TTS["音声エンジン AivisSpeech<br>port 10101"]
```

grep 実測: CLI の fetch 先は部屋(`:3300`)のみ(`cli.ts:39,67,95,248`)。TTS の URL は `config.ts:8`(`:10101`)。
brain は `@anthropic-ai/claude-agent-sdk` の `query`(`brain.ts:1`)。
**部屋(3300)とエンジン(10101)のプロセスは止めない**(`CLAUDE.md` ルール 4)。

## 3. 割り込み(barge-in)シーケンス — 現在地(handoff 004)

```mermaid
sequenceDiagram
  actor U as ユーザー
  participant L as claw-listen
  participant C as CLI
  participant R as 部屋 :3300
  participant T as エンジン :10101
  U->>L: 声
  L->>L: 音量 peak で区切り判定(❌実機未検証)
  L->>C: FINAL テキスト
  C->>R: 発話送信
  R->>R: brain が応答生成
  R->>T: 合成(十数秒かかる)
  C->>R: 音声取得
  Note over C: 世代照合 3 点で破棄判定<br>1 順番待ち後 / 2 取得後 / 3 書き込み後
  C->>C: afplay 再生
  U->>L: 話しかける(割り込み)
  L->>C: PARTIAL
  C->>C: stopAudio で audioGen++<br>合成待ちの音声も破棄(❌実機未検証)
  L->>C: FINAL
  C->>R: 新しい user_speech
  R->>R: channel revision 更新<br>旧 Brain detach + 旧 TTS emit 破棄
```

❌ = 実機未検証(handoff 004 §4-1: 検証中に Apple 音声認識が沈黙し確認できていない。変更前バイナリでも沈黙するため変更起因ではない)。
実機確認の手順: `ON_DEVICE=1 STT_LOCALE=en-US npm run cli /v` → ①送信が 1 回で済むか ②声が出る前の割り込みで `(割り込み)` が出るか ③独り言が混ざらないか。

## 4. 同期部屋の latest-turn 制御(PBI-001)

```mermaid
sequenceDiagram
  actor U as ユーザー
  participant W as public/room.js
  participant R as room.ts / EventStore
  participant C as LatestChannel(channel)
  participant B1 as 旧 Brain
  participant B2 as 新 Brain
  participant S as SpeechPlane
  U->>W: Web Speech final
  W->>R: POST /chat immediate:true
  R->>S: channel revision++
  R->>C: receive(revision, 最新発話)
  C-->>B1: interrupt(2s deadline・完了は待たない)
  C->>B2: 新 turn を即開始
  B1-->>C: 遅延 token / reject
  C->>C: isCurrent=false で破棄
  B2->>S: sentence + captured revision
  S->>S: 合成前 / 合成後 / emit直前に revision 照合
  S->>R: current の agent_speech だけ append
  R-->>W: user_speech SSE
  W->>W: 再生中 audio 停止 + queue 全消去
```

世代の発行源は `SpeechPlane.revision(channel)` の 1 つで、`LatestChannel.revision` は user_speech ごとにその絶対値を受け取る。
別 channel は別 `LatestChannel`・別 revision なので中断されない。EventStore/transcript は append-only のまま、取消後に到着した旧 AI 出力だけを境界で捨てる。
