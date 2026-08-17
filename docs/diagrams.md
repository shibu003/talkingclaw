# talkingclaw 現時点の図(2026-08-06 精密版)

出典: `src/*.ts`・`src/convos/*.ts` 全文精読、`public/room.js` の API 呼び出し grep、`.kaiwa-loop/handoffs/004.md`。
図中の endpoint 名・関数名・クラス名はすべて実在(行番号つき)。コードが変わったら同じ commit でこの図も直す。
(2026-08-06 二股統合: 精密版を土台に、Codex commit 0082679「cancel superseded turns」の
latest-turn 制御を図 4・5・6 へ反映。行番号は統合後のコードで再実測済み)

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
    DC["newway-diagram-check.sh<br>PreToolUse Bash: git commit 前に<br>docs/diagrams-check.sh を自動実行<br>ずれたら commit 拒否"]
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
  NW --> DC
  HK ==>|"ツール呼び出しを実際に拒否"| CL
  DC ==>|"腐った図での commit を拒否"| CL
  HK -.->|"枠外。AGENTS.md の規律のみ"| CX
  NW --> DG
  DC -.-> DG
```

## 2. モジュール依存図(import 実測 — 存在しない依存は描いていない)

```mermaid
flowchart LR
  subgraph roomproc["部屋プロセス node room.ts(port 3300・単一プロセス)"]
    ROOM["room.ts(2836 行)<br>HTTP 50 endpoint + memo/voice mount・EngineManager・クロエ配線 startChloe"]
    MEMO["memo.ts<br>伝言の受け口(GET /memo・say・log)<br>memo-log.jsonl + submit 台帳で dedupe<br>DI: submit/read は room.ts が注入"]
    VSW["voiceswitch.ts<br>声スイッチャー(候補 cache 3 状態・試聴の課金門<br>10 分 10 回 + WAL・voice.json の atomic persist)<br>DI: 合成/話者一覧/cooldown/commit は room.ts が注入"]
    RC["roomcore.ts<br>EventStore(append-only 1000 件)<br>Registry(join 5 規則・takeover)"]
    CH["convos/channel.ts<br>LatestChannel(最新 turn 勝ち・旧 Brain detach)<br>TurnMetricClock(turn_created 基準)"]
    SP["convos/speech.ts<br>SpeechPlane(TTS キュー+相槌プール<br>+channel 別 revision)<br>UserSpeechState(mic 状態)"]
    TP["convos/turn.ts<br>TurnPlane(Router・Turn 表・escalation)"]
    VC["voice.ts<br>Voice(合成クライアント・provider 分岐<br>fish/aivis-cloud/local)・splitSentences<br>VoiceSnapshot で turn ごとに声を固定・previewFish"]
    BR["brain.ts<br>Brain(SDK streaming セッション)"]
    AR["archive.ts"]
    CFG["config.ts"]
    PPBI["planpbi.ts<br>相談で合意した案 → backlog/ の G1 PBI(PBI-013)<br>採番ロック .pbi-number.lock で「読む→作る」を直列化"]
    CAS["casino.ts"]
    GAMES["blackjack / poker /<br>mahjong / mahjongGame"]
  end
  FISHAPI["(外部)Fish Audio API<br>POST /v1/tts・model header s2.1-pro-free 固定<br>fail-closed: 定数不一致なら送信 0 で local へ"]
  ROOM --> CFG & AR & RC & CH & SP & TP & VC & BR & CAS & MEMO & VSW & PPBI
  VC -->|"provider=fish・format wav 固定<br>429/5xx は R 後 1 retry・他は即 local<br>(T=4s / status 別 cooldown)"| FISHAPI
  VSW -->|"GET /model(候補検索・allowlist query のみ)<br>5 分 cache + single-flight"| FISHAPI
  SP --> RC
  SP -->|"synthesizeWav(text, speaker, snapshot)"| VC
  VSW -->|"previewFish / previewLocal"| VC
  VSW -.->|"voice.json / voice-preview.jsonl<br>~/.talkingclaw(0600)"| STATE["選択と試聴台帳(永続)"]
  TP --> RC
  TP -->|"FillerCue 型のみ"| SP
  CAS --> GAMES
  BR --> SDK["@anthropic-ai/claude-agent-sdk<br>query(API キー不要=Claude Code 認証継承)"]
  VC -->|"POST /audio_query・/synthesis"| TTS["AivisSpeech Engine<br>port 10101(別プロセス・自動起動)"]

  CLI["cli.ts(別プロセス)<br>src import なし・HTTP のみ"] -->|"HTTP+SSE"| ROOM
  MCPX["mcp.ts(別プロセス)<br>MCP stdio→HTTP 中継"] -->|"HTTP"| ROOM
  BROW["public/room.js(ブラウザ)"] -->|"HTTP+SSE"| ROOM
  LSN["tools/claw-listen(Swift)<br>Apple Speech STT"] -->|"PARTIAL/FINAL 行"| CLI
```

設計上の要点(コードから自明でないもの):
- **convos/ は room.ts を import しない**(一方向依存。依存は `SpeechDeps`/`TurnDeps` で注入 — `speech.ts:74-86`, `turn.ts:28-40`。channel.ts は Brain を `InterruptibleBrain` interface で受ける — `channel.ts:4-7`)
- **テキスト平面と音声平面の分離**: テキストは EventStore に append-only で不喪失、音声は失効しうるリース(`speech.ts:1-8`)
- cli.ts / mcp.ts は src を一切 import せず、部屋の状態は全部 HTTP 越し(mcp.ts:1-2「thin proxy」)
- **声の選択は turn 生成時の snapshot で固定する**(PBI-008 AC-6)。実行時に現在値を読むと queue 済み job が切替後の声になり、同一返答の途中で声が混ざる。`speech.ts` の `speakSentences` が 1 turn 1 回だけ `voiceSnapshot(pid)` を読み、全 job に配る。クロエ以外は常に null(= 既定の声のまま)
- **試聴は通常会話と別経路**(`Voice.previewFish`)。retry 0・PBI-007 の cooldown を読み書きしない・失敗してもローカル合成へ落とさない。会話用に同時実行 slot を 1 つ常に残す

## 3. API 依存表 — 全 50+3+3 endpoint × 中で働く関数 × 呼び出し元

呼び出し元の凡例: **B** = ブラウザ public/room.js、**C** = cli.ts、**M** = mcp.ts(コハク/Codex 等の外部 agent)、**P** = 外網(スマホ。Tunnel+Access 経由 — PBI-003)

### memo(3・memo.ts)— token gate より**前**に mount。origin は memo 限定規則(localhost または `MEMO_PUBLIC_ORIGIN` の exact Host/Origin)

| endpoint | 中で働く関数 | 呼び出し元 |
|---|---|---|
| GET /memo | memo.ts handle() → identity(Cf-Access ヘッダ・表示用)を JSON リテラルで埋めた HTML | P |
| POST /memo/api/say | say() → room.ts の memoSubmit adapter(永続 dedupe 台帳 → userSpeech channel=work 固定) | P |
| GET /memo/api/log | 永続 timeline の cursor 増分(reply/note/report は read adapter が正規化) | P(polling) |

### voice(3・voiceswitch.ts)— token gate より**後ろ**に mount(memo とは逆。声は部屋の持ち主の設定)

| endpoint | 中で働く関数 | 呼び出し元 |
|---|---|---|
| GET /voice/api/candidates | candidatesFor()(5 分 cache 3 状態 + single-flight)+ localCandidates() → allowlist した候補だけ返す | B(声パネル) |
| POST /voice/api/preview | preview() → 会話中なら 409・同一は 10 分 cache・10 分 10 回で 429・WAL 先行 → previewFish() → ephemeral WAV | B(▶ 試聴) |
| POST /voice/api/select | select() → validate → temp 0600 write/fsync → atomic rename → publish → onCommit(プール失効) | B(これにする) |

### 認証なし(6)— token 配布より前に置ける最小限だけ

| endpoint | 中で働く関数 | 呼び出し元 |
|---|---|---|
| GET /health | store.bootId を返すだけ | B / C healthy() / M healthOk() |
| GET / | index.html に token・bootId を埋めて配信(no-store) | B(token 配布の唯一の経路) |
| GET /vad/* | public/vad/ の onnx・wasm 配信 | B(ブラウザ側 VAD) |
| GET /room.js | UI スクリプト配信 | B |
| GET /avatar.js | キャラ描画スクリプト配信(PBI-022) | B(dynamic import) |
| GET /vendor/* | node_modules の ESM 配信。**three / @pixiv/three-vrm の .js だけ**(allowlist・`..` 拒否) | B(import map の行き先) |

### token 認証(40)— `authed()`: x-room-token ヘッダ or ?token=

> **GET の口は `if (req.method !== 'POST') return 404` より前に置く**(room.ts:2093)。
> 後ろに書くと常に 404 になる —— 2026-08-15 に `/persona` と `/avatars` で実際に踏んだ。
> 恒久の守り手 = `test/check-http-get.mjs`(部屋を起こして 200 を見る)

| endpoint | 中で働く関数 | 呼び出し元 |
|---|---|---|
| GET /uploads/* | uploadDir() から配信 | B(添付の表示) |
| GET /files[/*] | loadProjects() → traversal 拒否 → 成果物配信 | B(INBOX の 📦 リンク) |
| GET /transcript.md | transcriptTail() → markdown | B(リンク) |
| GET /persona | personaSummary() → 9 軸 + turns + top(PBI-021) | B(🌱)/ C(/persona) |
| GET /avatars | listAvatars() → ~/.talkingclaw/avatars/*.vrm の名前(PBI-022) | B(起動時に 1 回) |
| GET /avatars/&lt;name&gt; | 名前を検査して .vrm を配信(traversal 拒否) | B(GLTFLoader) |
| GET /vocab | 覚えた語 + まだ聞いていない候補(PBI-024) | B(発話のたび)/ C(/vocab) |
| POST /vocab | `remember` / `ignore` を人が決める(勝手に覚えない) | B(「これ覚える?」の ✓ / ✕) |
| GET /motions | `~/.talkingclaw/motions/*.vrma` の名前(PBI-025) | B(キャラ枠を開いた時) |
| GET /motions/&lt;name&gt; | 名前を検査して .vrma を配信(traversal 拒否) | B(VRMAnimationLoaderPlugin) |
| GET /archives.md | archiveIndexTail() | B |
| GET /archive.md | archiveRead() | B |
| GET /events | SSE: store.since() 再送 + store.onAppend() 購読 + 25s ping | B / C subscribe() |
| GET /channels | rooms・activeChannel | B |
| GET /participants | registry.all()・registry.presence()・turn.selected・mic.active | B / C showWho() |
| GET /audio/N | audioStore(合成済み WAV の置き場。putAudio() が書く) | B の Audio / C enqueueAudio() |
| POST /upload | 20MB 上限で uploadDir() へ保存 | B |
| POST /intake | 落とされたフォルダの中身を 1 ファイルずつ受け、`~/claw-workspace/<名前>/<相対パス>` に置く(`..` は弾く)。開閉は /projects の intakeStart / intakeDone(PBI-017) | B(作業先パネルの落とし口) |
| POST /join | registry.join(5 規則) → resolveVoice() → speech.buildAckPool() | M ensureJoined() |
| POST /game | casino.view() | B(ゲーム盤のボタン生成) |
| POST /chat | tryGame() 即判定 → acceptUtterance()(断片確定)or userSpeech()(immediate) | B / C(入力・音声とも) |
| POST /dict | learnWord() / saveDict()(聞き間違い補正辞書) | B / C /dict |
| POST /memory | memoryLines() / appendMemory() / writeMemory() | B |
| POST /settings | workerSettings 更新 → saveSettings() → chloeResetWorker()/chloeResetChat() | B / C /settings |
| POST /projects | 作業先の一覧 / 追加 / 登録解除 → saveProjects()(temp→rename 原子的、PBI-011)。clone は ghPath()→ghClone()(spawn detached + グループ kill)で外部プロセス gh に委任し、成功時だけ saveProjects(PBI-012)。repos = `gh repo list --json` / browse = readdirSync で ~ を辿る(PBI-015 の「選ぶ」材料) | B |
| POST /herdr | fleetAct() → HerdrBridge(src/herdr.ts)= herdr CLI の thin adapter。list / start / prompt / read。書込みは台帳内だけ(PBI-014) | B(作業タブの「herdr の艦隊を見る」) |
| POST /ui-state | uiState 更新(クロエが room_status で読む) | B |
| POST /inbox | officeTasks の report 付きを返す | B / C /inbox |
| POST /task | 台帳手入れ: delete / cancel / edit / merge(working は拒否) | B |
| POST /inbox/read | t.unread = false | B / C |
| POST /inbox/delete | スレッド削除 | B |
| POST /inbox/reply | chloeReply() → taskQueue 再投入(同スレッドの続き) | B / C |
| POST /tasks | boardSnapshot() + fleetView(最後に見た herdr の艦隊。ここでは herdr を叩かない) | B / C /tasks |
| POST /plan | confirmPlan() → planPbi() → planpbi.writePbi(相談モードの案。確定時に backlog/ へ G1 PBI を書き、pbi/note を返す)/ 取り下げ | B |
| POST /transcript | transcriptTail()(JSON) | C /log / M recall |
| POST /screen | 在室・routing・speaking・board・直近ログを 1 発で | M look |
| POST /metrics | metrics.jsonl へ追記(stt_final_delay 等) | B |
| POST /select | turn.select()(話し相手の固定) | B |
| POST /rooms | newRoomId() / saveRooms()(create / rename、上限 12) | B |
| POST /invite | participantRoom.set()(別部屋の相手を呼ぶ) | B |
| POST /channel | activeChannel 切替 | B / C /room |
| POST /speech-state | mic.report() → true→false で flushPending()(断片確定の起点) | B(STT interim/final) |
| POST /played | turn.advanceFloor()(floor 前進)/ turn.onFillerPlayed()(escalation 前倒し) | B(再生完了通知) |

### participant 認証(4)— `registry.auth(participantId, sessionId)`

| endpoint | 中で働く関数 | 呼び出し元 |
|---|---|---|
| POST /heartbeat | lastSeen 更新(alive 判定 2.5 分) | M(60s 毎) |
| POST /leave | registry.leave() + waiter を no_speech 解決 | (現状呼び出し元なし) |
| POST /speak | clientSeq 冪等 → turn.attribute()(turn 帰属+窓閉じ)→ speech.speakSentences() | M speak |
| POST /listen | resolveListen()(即答)or waiters に long-poll 登録(最大 48s) | M listen |

## 4. クロエの内部構造 — 会話 Brain・作業係・office ツール(room.ts:847-1370)

```mermaid
flowchart TB
  EV["store.onAppend: user_speech<br>(room.ts:1342)"] --> LC["chan(channel) = LatestChannel<br>部屋ごとに Brain と記憶が独立(room.ts:1270-1296)<br>receive(revision, 最新発話) room.ts:1349"]
  LC --> AO["askOnce()(room.ts:1325)<br>freshBrain なら contextPrefix 再注入<br>ASK_GUARD 超過 → run.detach() で Brain 破棄+再生成"]
  AO --> CB["会話 Brain(brain.ts)<br>model=chatModel / maxTurns 12<br>convReadTools(読むだけ)+ office ツール<br>canUseTool: Write/Edit/Bash は deny→作業係へ誘導"]
  CB -->|"onSentence(文の完成ごと)"| SS["speakStreamed()(room.ts:1316)<br>run.isCurrent() 照合<br>初文で turn.markResponded()<br>speech.enqueue(revision 付き)"]
  CB --> OFF["office MCP ツール 10 種(in-process)<br>room_status / read_inbox / mark_read / cancel_task<br>learn_word / remember / propose_plan / confirm_plan / delegate_task<br>herdr(艦隊: list / start / prompt / read)"]
  OFF -->|"herdr(action) — 画面の「艦隊を見る」も同じ入口"| HRD["fleetAct()(room.ts)→ HerdrBridge(src/herdr.ts)<br>herdr CLI を execFile(成功=stdout / 失敗=exit1+stderr)<br>台帳 ~/.talkingclaw/herdr-owned.json = 部屋が立てた子<br>prompt / start は台帳内のみ・ユーザーの pane は読むだけ"]
  OFF -->|"delegate_task(直行)or<br>propose_plan(summary/steps/accept)→同意→confirm_plan(相談モード)<br>確定時に planpbi.writePbi で backlog/ に G1 PBI を残す(PBI-013)"| DLG["delegate() → taskQueue<br>伝言起点なら sourceTurnId/clientMessageId を<br>OfficeTask に引き継ぐ(PBI-003 相関)"]
  DLG --> PMP["pumpTasks()(room.ts:950)"] --> SLT["runSlot() × workerCount(1〜4 スロット)"] --> RT["runTask()(room.ts:1029)"]
  RT --> WB["作業 Brain(スロットごと)<br>model=workerModel / cwd=project<br>canUseTool: dangerousBash() 以外の Bash は自動許可<br>それ以外は askUserPermission()=声で「いいよ/だめ」"]
  WB -->|"10 分超過"| TO["interrupt → 15s 猶予 → Brain 破棄"]
  RT --> GAC["gitAutoCommit()(room.ts:981)<br>SECRET_RE 検査→add -A→commit<br>push は autoPush ON のみ"]
  RT --> RPT["parseReport() → task.report<br>INBOX 未読 + notifyUnread()"]
```

- 声のパーミッション: allow-list 外ツール → `askUserPermission()`(room.ts:585)が部屋に「許可待ち」を流し、次の user 発話を `PERM_YES/PERM_NO` 正規表現で判定。許可待ちの読み上げは `advanceRevision` で直前の読み上げより優先(room.ts:593)
- 会話 Brain 再生成時は `contextPrefix()` で記憶全文 + 直近ログ 60 行を再注入(room.ts:1300-1314)。**これが会話遅延の支配項**(履歴肥大、メモリ `talkingclaw-chat-latency` 参照)
- 旧 `drain()/askGuarded()` の直列 chain は PBI-001 で LatestChannel に置換(中断完了を待たず新 turn を開始する — channel.ts:2)

## 5. 音声会話・割り込みシーケンス(関数名レベル。❌ = 実機未検証 — handoff 004 §4)

```mermaid
sequenceDiagram
  participant L as claw-listen
  participant C as cli.ts
  participant R as room.ts
  participant K as 会話 Brain
  participant S as SpeechPlane
  participant T as AivisSpeech :10101
  L->>L: installTap 音量 peak≧STT_GATE で区切り ❌
  L->>C: FINAL テキスト
  C->>C: isEcho 棄却 → stopAudio
  C->>R: POST /chat
  R->>R: acceptUtterance(断片は armPending/flushPending で確定)
  R->>R: userSpeech(546): applyDict → mic.clear → turn.route → store.append(user_speech)
  R->>R: onAppend: speech.advanceRevision(271)+ chan().receive(1349) = 旧 Brain 即 detach・新 Brain 開始
  R->>R: fireAck(事前合成プール即再生) + scheduleEscalation + scheduleUndeliveredNotice
  R->>K: LatestChannel.process → askOnce → Brain.ask
  K-->>R: onSentence(文ごと) → speakStreamed(isCurrent 照合) → speech.enqueue
  S->>S: pump: mic.waitUntilDone → runJob(isCurrent 照合: 旧 revision は text-only=stale drop)
  S->>T: synthesizeWav: POST /audio_query → POST /synthesis(timeout 150s)
  S->>R: putAudio → store.append(agent_speech, audio=/audio/N)
  R-->>C: SSE /events
  C->>C: render → enqueueAudio(gen 照合 3 点: 順番待ち後/取得後/書き込み後)→ afplay
  Note over L,C: 割り込み: PARTIAL → stopAudio で audioGen++ → 合成待ち含め全部破棄 ❌
  Note over K: 新 user_speech は LatestChannel が旧 Brain を即 detach(PBI-001 実装済み。<br>実機 barge-in 確認は部屋再起動待ち — commit 0082679)
```

実機確認の手順: `ON_DEVICE=1 STT_LOCALE=en-US npm run cli /v` → ①送信が 1 回で済むか ②声が出る前の割り込みで `(割り込み)` が出るか ③独り言が混ざらないか。

## 6. 同期部屋の latest-turn 制御(PBI-001 — commit 0082679)

```mermaid
sequenceDiagram
  actor U as ユーザー
  participant W as public/room.js
  participant R as room.ts / EventStore
  participant C as LatestChannel(channel.ts)
  participant B1 as 旧 Brain
  participant B2 as 新 Brain
  participant S as SpeechPlane
  U->>W: Web Speech final
  W->>R: POST /chat immediate:true(room.js:537)
  R->>R: userSpeech(546) → store.append(user_speech)
  R->>S: onAppend: advanceRevision(271) = channel revision++
  R->>C: receive(revision, 最新発話)(room.ts:1349)
  C-->>B1: interrupt(deadline 2s・完了は待たない)(channel.ts:79)
  C->>B2: process=askOnce を即開始
  B1-->>C: 遅延 token / reject
  C->>C: run.isCurrent()=false で破棄(channel.ts:145)
  B2->>S: speakStreamed → enqueue(revision 付き)(room.ts:1316)
  S->>S: isCurrent 照合 4 点: 積む時/合成前/合成後/emit 直前<br>(speech.ts:223,277,283,288)
  S->>R: current の agent_speech だけ append
  R-->>W: user_speech SSE
  W->>W: 再生中 audio 停止 + audioQueue 全消去(room.js:256)
```

世代の発行源は `SpeechPlane` の channel 別 `#revisions`(speech.ts:115・136)の 1 つで、`LatestChannel.revision` は receive ごとにその絶対値を受け取る(channel.ts:88-93)。
別 channel は別 `LatestChannel`・別 revision なので中断されない。EventStore/transcript は append-only のまま、取消後に到着した旧 AI 出力だけを境界で捨てる。
取消時は onCancel が `turn.cancelEscalation` + `turn_cancelled` metric を出す(room.ts:1287-1292)。turn metrics は `TurnMetricClock`(channel.ts:11)が turn_created 基準の path('room'|'memo')・ms を付ける。

## 再測手順(recipe — newway §16-7)

この図が正しいかは「ちゃんと描いたか」ではなく、**下を再実行して数が合うか**で判定する。
コードを変えた PBI の G2 で再実行し、ずれていたら図が腐っている — 同じ commit で図を直す。

```bash
cd /Users/YOUR_USER/talkingclaw

# 図3: endpoint 全量 — 期待 43 行(4 認証なし + 33 token + 4 participant + memo mount 1 行
# + voice mount 1 行)。memo / voice の 3+3 endpoint はそれぞれの module 側 = 次の grep で 3・3
# 注: パターンは "path === '/" のように '/ まで含める。'/ 無しだと TurnPath('room'|'memo')の
# 比較 path === 'memo' を拾って +2 に化ける(2026-08-06 実測)
grep -c -e "path === '/" -e "path\.startsWith('/" src/room.ts
grep -c "pathname === '" src/memo.ts
grep -c "pathname === '" src/voiceswitch.ts

# 図2: モジュール依存の辺 — 期待 27 行(room 11 / speech 2 / turn 2 / voiceswitch 1 / casino 4 / mahjongGame 1 / index 3 / smoke 3)
# 注: '../ (convos → 親) を拾うため 2 パターン必須。片方だけだと減る(2026-08-06 実測)
grep -r -e "^import .*from '\./" -e "^import .*from '\.\./" src/ | grep -c "import"

# 図3 呼び出し元 B 列: ブラウザが叩く口(post 21 種 + fetch/EventSource 5 種)
grep -o "post('/[a-z./-]*" public/room.js | sort -u
grep -o "fetch('/[a-z./-]*\|EventSource('/[a-z]*" public/room.js | sort -u

# 図3 呼び出し元 C / M 列: CLI・MCP が叩く口
grep -o "api('/[a-z./-]*" src/cli.ts src/mcp.ts | sort -u

# 図4・図5・図6: 図中の関数が実在するか(名前を変えたらここで落ちる)
grep -c -e "function acceptUtterance" -e "function userSpeech" -e "function askUserPermission" src/room.ts
grep -c -e "function enqueueAudio" -e "function stopAudio" -e "function handsfreeLoop" src/cli.ts
grep -c -e "class LatestChannel" -e "class TurnMetricClock" src/convos/channel.ts

# render 検証 — 期待 5 図・エラー 0
npx -y @mermaid-js/mermaid-cli -i docs/diagrams.md -o /tmp/diagrams-check.md
```

## 7. 遊ぶ時の 3 本の流れ(PBI-025 / 027 / 028 / 029 / 034)

**卓に着く前に席が埋まる(PBI-034)**: 人数が足りないぶんだけ、名前と打ち癖を持った面子が座る。
**ここは推論を 1 回も使わない**（鍵が無くても卓が立つ = D-019 の土台）。

```mermaid
flowchart LR
  START["「麻雀やろう」"] --> WHO["humansIn(部屋): ホスト + その部屋のゲスト<br>registry: 居る agent"]
  WHO --> FILL["fillSeats(居る人, 必要人数)"]
  FILL --> A["居る人を先に座らせる"]
  A --> B{"まだ足りない?"}
  B -- はい --> C["面子表から座る<br>ツバキ 0.78 / ナギ 0.34 / リン 0.55 …<br>(名前も打ち癖も違う)"]
  B -- いいえ --> D["卓が立つ"]
  C --> D
  D --> E["打つ・鳴く・和了る<br>**すべて規則。LLM を呼ばない**"]
  E --> ACT{"打ったのは誰?<br>apply(session, cmd, **actor**)"}
  ACT -- その人の番 --> ADV["卓が進む → 次の**人間**の番まで AI が打つ"]
  ACT -- 番でない / 席が無い --> NO["卓は動かない(断りの一言)"]
  ADV --> V["view(session, **見る人**)<br>手牌は自分にしか見えない"]
  V --> IDLE{"2 人以上の卓で<br>60 秒 無操作?"}
  IDLE -- はい --> AUTO["面子が 1 手だけ代打ち(PBI-038)<br>「代わりに打っておいたよ」と言う<br>→ 次の人間の番まで進める"]
  IDLE -- いいえ --> WAIT["待つ(1 人の卓では代打ちしない)"]
```


**盤面が動いた 1 回の更新**で、体・声・記憶がそれぞれ独立に動く。判定はすべて**数字か状態**で、
文字列の言い回しには依存しない（言い回しはゲームごとに変わるので、そこを読むと静かに壊れる）。

```mermaid
flowchart TB
  MOVE["手を打つ / 相手が打つ<br>(POST /chat → tryGame)"] --> APPLY["casino.apply()<br>say[] = 実況"]
  APPLY --> NARR["speakSentences(実況役)<br>声 = narratorSwitch(PBI-029)"]
  APPLY --> TICK["turnTalkTick(channel)<br>PBI-028"]
  APPLY --> VIEW["casino.view()<br>yourTurn / title / board"]

  TICK --> EDGE{"yourTurn が<br>false → true?"}
  EDGE -- いいえ --> QUIET["黙る(同じ手番で繰り返さない)"]
  EDGE -- はい --> TONE["9 軸 → tone(PBI-039)<br>きっぱり / やわらかい / せっかち"]
  TONE --> MIC{"マイクが立っている?"}
  MIC -- はい --> QUIET
  MIC -- いいえ --> TALK["turnLine(kind, n) を 1 回<br>クロエの声"]
  TALK --> TIMER["25 秒タイマー<br>盤面が動いたら取り消す"]
  TIMER -- "無操作のまま満了" --> IDLE["idleLine(n) を 1 回"]

  VIEW -.-> POLL["ブラウザ refreshGame()<br>200ms ごと / 手を打った後"]
  POLL --> GM["gameMood(prev, next)<br>PBI-027 / 031"]
  GM --> FACE["setMood(mood)<br>顔: happy / sad / Surprised<br>5 秒かけて戻る(時計で減衰)"]
  SPK["音声を再生<br>__clawSpeakingName = 名前"] --> BODY{"その名前の体は?"}
  BODY -- 在る --> M1["その体の口だけ動く<br>他の体はその人を見る(PBI-032)"]
  BODY -- 無い --> M2["先頭の体が喋る(今までどおり)"]
  GM --> STACK{"自分の持ち分が動いた?<br>stackOf: 卓の self / 見出し<br>(残り・ポットは読まない)"}
  STACK -- 増えた --> WIN["Victory / JumpJoy / Clapping<br>(在るものを上から)"]
  STACK -- 減った --> LOSE["Frustrated / Sad"]
  STACK -- 変わらない --> HOT{"🎉 が新しく出た?"}
  HOT -- はい --> BIG["JumpJoy / Surprised"]
  HOT -- いいえ --> NONE["何もしない"]
  WIN & LOSE & BIG --> PLAY["playMotion()<br>再生中は待機モーションを止める<br>口とまばたきは動き続ける"]
```

**「聞いて覚える」(PBI-024 / 026)** は会話の側の流れ。ゲームとは独立に、発話が入るたびに走る。

```mermaid
flowchart LR
  SP["user_speech"] --> OBS["observeText()"]
  OBS --> CAND{"字種で絞る"}
  CAND -- "英字を含む" --> ASK["候補に溜める(最大 12)"]
  CAND -- "カタカナ 3 字以上<br>かつ一般外来語でない" --> ASK
  CAND -- "漢字だけ / 一般語 /<br>既知 / 断った語" --> DROP["捨てる"]
  ASK --> BAR["画面: これ覚える? ✓ / ✕<br>(同時に 3 語まで)"]
  BAR -- "✓" --> KNOWN["vocab.json known[]<br>→ prompt に 1 行"]
  BAR -- "✕" --> IGN["ignored[] 二度と聞かない"]
```

## 7-2. ゲストが入る時の関所（PBI-035・W4）

**「入れる」と「何でもできる」を分ける。** 鍵は 2 種類あり、ゲストは allowlist の口しか叩けない。
**どこまで出すか**は別の軸（PBI-036）: 既定は `127.0.0.1` だけ、`ROOM_BIND=0.0.0.0` で LAN。
出す先を広げても、通す Host は**列挙一致のまま**。
**新しい口を足しても既定で通らない**（忘れても穴が開かない形）。

```mermaid
flowchart TB
  REQ["要求(token 付き)"] --> H{"ホストの token?"}
  H -- はい --> ALL["全部の口が通る(今までどおり)"]
  H -- いいえ --> G{"guests.json に在る?<br>取り消し・期限切れは除く"}
  G -- 無い --> E401["401"]
  G -- 在る --> A{"guestAllows(method, path)?"}
  A -- いいえ --> E403["403 + metric(guest_denied)"]
  A -- はい --> OK["遊ぶ・話す・見る"]
  OK --> PAGE["画面: **その人の token** を焼く<br>role=guest なら body.guest<br>(ホスト専用は最初から出さない)"]
  REQ --> HOST{"Host は<br>この機械の住所?<br>(127.0.0.1 / localhost / LAN の IPv4)"}
  HOST -- いいえ / 欠如 --> E403H["403(DNS rebinding 対策)"]
  OK --> EV["/events は<br>**その人の部屋だけ**流す"]
  OK --> CHAT["/chat は targets 空<br>= **ホストの推論を使わない**(D-019)"]
  CHAT --> GAME["卓は動く(推論ゼロ・PBI-034)"]
```

## 8. UI 構造図 — 矩形の契約(正本は assert・px は参考値)

**この図の正本は下の契約表**(どの要素が・どの状態で・何を満たすか)。座標 px は撮影日付きの
参考値に過ぎない — CSS を変えれば腐るし、`diagrams-check.sh` は px の腐りを検出できない。
契約の側は `test/check-ui-geometry.mjs` が実行時に測るので、破れたら赤で分かる。

```mermaid
flowchart TB
  subgraph vp["viewport(wide >= 1100px は 3 列 grid / narrow は 1 カラム flex)"]
    BANNER["banner<br>部屋名・話す相手・📋 🎙 ⚙"]
    subgraph NAV["nav 部屋レール(--nav-w 既定 84px・grip で 180px〜)"]
      ROOMS["部屋ボタン群(アイコン + 名前)"]
    end
    MAIN["main #log 会話<br>**常に見える・覆われない**"]
    subgraph SIDE["aside 右レーン(--side-w・下限 352px)"]
      BOARD["#board 成果物 / 報告"]
      SET["#settings 設定<br>内部 scroll = #settingsBody"]
      ADMIN["#roomAdmin 部屋の管理<br>作成 / rename / 記録リンク<br>内部 scroll = #roomAdminBody"]
      VOICE["#voice 声<br>内部 scroll = #voiceList"]
    end
    FOOTER["footer 入力(44px の的)"]
  end
  SET -. "同時に開くのは 1 枚(openPanel)" .- VOICE
  SIDE -. "#log とは別の列 = 交差 0 が構造的に成立" .- MAIN
```

### 契約(= `test/check-ui-geometry.mjs` の assert。破れたら赤)

| # | 対象 | 状態 | 満たすこと |
|---|---|---|---|
| C1 | `#settings` / `#voice` | 開 | content 幅 >= **320px**(測る箱 = `#settingsBody` / `#voiceList` の clientWidth) |
| C2 | パネル ∩ `#log` | 開 | 矩形交差 **0** |
| C3 | `#log` | 常時 | 高さ >= **35dvh**。narrow では `min-height: 35dvh` が構造的な下限 |
| C4 | パネル内部 | 開 | 内部 scroll を持つのは**本体 1 つだけ**(`#settingsBody` / `#voiceList`) |
| C5 | label / 見出し / ボタン | 開 | 折返し **<= 3 行**(`Range.getClientRects()` の line box 数)。母集団 >= 7 件でなければ検査自体を fail |
| C6 | 同上 | 開 | 切詰め(nowrap/ellipsis/line-clamp)で 3 行以内を偽装しない。**省略してよいのは accessible な全文がある時だけ** |
| C7 | control | 開 | touch target >= **44px**(label に包まれた control は label が的) |
| C8 | パネル自身 | 開 | 画面の外へはみ出さない(起票時の `y=-12,726` の再発防止) |
| C9 | 辞書 / 記憶の行 | 開 | 文字が縦積みにならない(span の折返し <= 2 行)・消すボタンが行内 |
| C10 | 全体 | 常時 | 横 overflow **0** |
| C11 | パネル | resize | リロード無しの resize で**勝手に閉じない**。3 サイズ往復で C1〜C10 が成立し続ける |
| C12 | 右レーン幅 | grip drag / 保存値復元 | 下限 **396px**(実測: lane→content で 66px 失われる)。`tc-side-w` に永続するので、下限を割ると次回以降ずっと読めない。**drag 最小化した状態**と**下限未満の保存値で起動した状態**の両方で content >= 320 を実測する(AC-8) |
| C13 | `.grip` | wide | computed 幅 **9px**(掴める)。`.lane > *` の `width: auto` に負けて 0px になっていた実績あり |
| C14 | `#roomsExtra`(部屋作成フォーム) | 開 | box 幅 >= **320px**・`#log` 交差 0・**打鍵中に再構築されない**(SSE 再描画で focus と値が飛ばない)。rail 内の `position:fixed` 吹き出し(280px)は廃止 |
| C15 | 話す相手チップ | 描画 | accessible name は agent 名のみ。居場所は `aria-hidden` の副題(`aria-label` で補う)。text node + span の連結による 1 語融合を作らない |

### 参考値(2026-08-06 実測・修理後。**契約ではない**)

| viewport | 設定パネル content | `#log` | 交差 |
|---|---|---|---|
| 1440x900 | 509px | 690px(35dvh=315) | 0 |
| 1024x768 | 794px | 317px(35dvh=269) | 0 |
| 390x844 | 332px | 316px(35dvh=295) | 0 |
| 1440x900(右レーンを最小まで drag) | 329px | 690px | 0 |

修理前(a522e2c)の同じ測定: 設定 content **38px** / `#log` 173〜198px = C1・C3 違反。
負の対照はこの数値で赤くなることを確認済み(`UI_GEOM_BASELINE=a522e2c node test/check-ui-geometry.mjs`)。
