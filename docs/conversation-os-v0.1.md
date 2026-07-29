# 会話OS 設計ドキュメント v0.1 — talkingclaw 専用の OS と言語

**一文定義**
> 人間と複数のエージェントがリアルタイム音声で会話しながら働くための実行基盤（会話OS）と、その意味論を静的に保証する言語。talkingclaw が参照実装。

**このドキュメントの位置づけ（他セッション向け・自己完結）**
- これは **agent-runtime（NewOs：capability / effect / budget / 証拠ログのカーネル）とは別プロジェクト**。混ぜない。境界面は §8 だけで定義し、依存は持たない。
- 方法論は POSIX 型：仕様を発明するのではなく、**既に動いている talkingclaw が手書きしている機構を抽出・成文化**する。room.ts に実在しないプリミティブを先に設計しない。
- 読み方：§2 が現状資産の地図（行番号つき）。§4〜§6 が規範。§9 が作業順序。実装前に必ず §9 C0 と「破壊禁止事項」を読むこと。

---

## 1. スコープ / 非スコープ

**会話OSが所有する問題**（＝talkingclaw が現に解いている問題）：
- リアルタイム性：初音までの時間、相槌、filler による間の被覆
- ターンテイキング：誰に向けた発話か、誰が答えるか、floor の移動
- 割り込みと失効：barge-in、stale drop、「言った文は取り消せないが残りは止められる」
- 発話の二平面性：テキスト（永続）と音声（失効しうる）の分離
- 非決定的セッションの監督：ハング検知 → interrupt → 再生成 → 文脈再注入
- 対話としての承認：音声での許可/拒否
- 入力正規化：細切れ認識の結合、誤変換辞書
- 在室と再接続：presence / takeover / suffix identity

**非スコープ**（agent-runtime の領分。会話OSはフックだけ提供する — §8）：
- capability の scope / expires、Effect の多軸分類、taint/provenance、予算の強制、承認の証拠ログ（署名・引数ハッシュ束縛の**強制**）、ツール副作用の意味論

**非スコープ**（どちらでもない）：
- STT/TTS エンジン自体（AivisSpeech / Web Speech はドライバとして扱う）
- エージェントのプロセス管理（vibe-kanban 等と併用する前提を維持）

---

## 2. 出発点：talkingclaw の現状資産（実測インベントリ）

リポジトリ地図（src/ 計 ~6,000 行）：

| ファイル | 行数 | 役割 |
|---|---|---|
| `src/room.ts` | 2,345 | daemon 本体。**カーネル相当の機構とアプリが同居**（抽出対象） |
| `src/roomcore.ts` | 192 | 純ロジック層（I/O なし）：EventStore / Registry。**抽出は既に始まっている** |
| `src/brain.ts` | 173 | Claude Agent SDK streaming セッション。文単位 onSentence、interrupt、コスト実測 |
| `src/voice.ts` | 178 | AivisSpeech 合成 + afplay。文Nの再生中に文N+1を合成するパイプライン |
| `src/mcp.ts` | 304 | 外部 agent 用 thin proxy（stdio MCP → HTTP 127.0.0.1:3300）。daemon 自動復旧・rejoin |
| `src/cli.ts` | 396 | terminal クライアント |
| `src/config.ts` | 143 | persona / prompt / allowedTools |
| `src/{casino,poker,blackjack,mahjong*}.ts` | ~2,180 | ゲーム（**アプリ**。主題ではないが「声だけで状態を持つ対話」の検証物） |
| `public/room.js` | — | ブラウザ端末：Web Speech マイク、**VAD barge-in（530行〜）**、再生、timeline |

room.ts 内の機構（行番号は現時点。抽出時の索引に使う）：

| 機構 | 位置 | 一言 |
|---|---|---|
| audio 置き場 + 相槌プール保護 | 73〜 | 事前合成 WAV の evict 管理 |
| EngineManager | 92〜203 | AivisSpeech の保有・監視・自動復旧（S5） |
| UserSpeechState | 231〜249 | 「ユーザーが今話しているか」の**単一状態源**。pump がこれで停止 |
| FillerEngine | 251〜298 | 相槌＝事前合成プールのみ。ack/context/status の3種 |
| TtsScheduler | 300〜405 | participant 内 FIFO / 間は (priority, RR)。**speechEpoch stale drop**。queue上限20→text-only |
| listen waiter | 407〜440 | long-poll 配送。at-least-once、cursor_expired |
| Router / Turn | 444〜531 | 名前 > UI選択 > floor > last_responder > default。turnId / delivered / responded |
| 報告パーサ | 532〜 | テンプレ準拠なら構造化、逸脱は notes から組立（W12） |
| 補正辞書 | 578〜613 | 誤変換の学習（learn_word） |
| 確定バッファ | 615〜745 | 細切れ認識の結合。FRAGMENT_MAX_CHARS=15 / WAIT=1.5s / HOLD上限=5s / 助詞末尾判定 |
| 音声パーミッション | 783〜816 | pendingPermission（同時1件・60sタイムアウト否決）、PERM_YES/NO 正規表現 |
| filler escalation | 818〜893 | 段階通知＋未配達通知 |
| 危険Bash検査 | 897〜 | 自傷防止（セキュリティ境界ではないと明記済み） |
| 永続化群 | 902〜1010 | tasks / memory(末尾100行) / projects / settings / games — **JSONファイル分散** |
| 相談モード | 1034〜 | propose_plan / confirm_plan（案→合意→登録） |
| startChloe | 1132〜1660 | 会話Brain(channel毎) / workerスロット / askGuarded(ハング監督) / 文脈再注入 |
| archive | 2334〜 | 6hごとのセッション区切り保存 |

既にある計測資産（回帰と評価に使う）：`~/.talkingclaw/metrics.jsonl`（初音・barge_in 等）、`cost.jsonl`（SDK実費）、`test/accept-*.sh` / `test/check-*.mjs`（受入・UI検査）。

---

## 3. 中心命題

**FACT**：talkingclaw は、会話に固有の実行機構（floor、二平面発話、レイテンシ契約、音声承認、セッション監督、presence）を room.ts 内に一体で手書きしており、それらはゲーム・相談・作業実況という複数の「アプリ」から共用されている。

**HYPOTHESIS**：これらを命名されたプリミティブ集合（会話syscall）として room.ts から抽出すれば、(a) talkingclaw 本体の変更容易性が上がり、(b) 新しい会話アプリ（新ゲーム、新ワークフロー）が「アプリ層のコードだけ」で書けるようになり、(c) 将来の言語がこの意味論の静的検査層として成立する。

**LIMITATION**：
- 会話の「正しさ」（返答の質）は保証対象外。保証するのは**時間・順序・失効・帰属**という実行上の性質のみ
- Web Speech API（STT）は外部サービス。完全ローカルSTTは別課題
- agent 間 prompt injection は会話OSでは防がない（§8 のフックで将来カーネルに委ねる）

**FALSIFICATION**：抽出後に (a) talkingclaw 本体の行数・結合度が悪化する、(b) 2つ目のアプリ（ゲーム移植）がプリミティブ外のエスケープを多発する、(c) metrics.jsonl の初音・barge-in 反応が抽出前より劣化する — のいずれかなら設計を修正する。

---

## 4. コア抽象（このOSの新規性はここ）

### 4.1 二平面発話（最重要）
発話は 2 つの平面に同時に存在する：
- **テキスト平面**：append-only。一度流れたら失われない（transcript）。会話の真実
- **音声平面**：**リース**。合成・再生の権利であり、ユーザーの新しい発話（epoch 前進）や barge-in で失効しうる。失効しても対応するテキストは残る

現行実装：`speechEpoch`（room.ts:303）＋「2世代以上前は text-only」＋ブラウザ VAD barge-in（room.js:530〜）。
規範化：**「不可逆なのは発話済みの音声だけ。未再生分の停止は第一級操作。記録（テキスト）は失効の対象外」**。

### 4.2 Floor / Turn（会話のスケジューラ）
- ルーティング優先順位（固定）：明示の名前 > UI 選択 > floor 保持者 > last_responder > default（クロエ）
- Turn = { turnId, target, delivered, responded, channel }。応答窓と未応答通知（escalation）を持つ
- floor は「audio なしで応答した者へ進む」（room.ts:428 の floorAdvance）

### 4.3 レイテンシ契約（deadline スケジューリング）
発話への応答は段階的な締切列を持つ：
```
t=~0.5s  ack（事前合成プールから。LLM 非経由）
t=T1     filler: context（「いま考えてるところ」）
t=T2..   filler: status ×2 → 打切り通知
t=48s    listen 内部 deadline（LISTEN_MAX_S）
t=ASK_GUARD(180s)  会話Brain interrupt → 10s 猶予 → 再生成
worker: 600s → interrupt → 15s 猶予 → セッション破棄
```
規範化：**latency contract はアプリが宣言し、OS が段階発火と打切りを実行する**。現行の定数散在（LISTEN_MAX_S / ASK_GUARD_MS / escalation 遅延）を 1 つの契約型に集約する。

### 4.4 音声承認（対話プリミティブ）
`ask_user(question) → allow | deny | timeout_deny`。現行：pendingPermission 同時1件、PERM_YES/NO 正規表現、60s で否決、epoch を進めて質問を最優先で読み上げ。
**既知の欠陥（§7-2）**：承認が「次の user 発話の先頭が はい か」でしか判定されず、**何に対する承認かに束縛されていない**。会話版 TOCTOU。修正は会話OS側の責務（束縛と復唱）＋カーネル側の責務（引数ハッシュ強制）に分かれる — §8。

### 4.5 セッション監督と文脈ページング
Brain（非決定的プロセス）の lifecycle：ask 監視 → deadline 超過で interrupt → 猶予 → close → 再生成 → `needsContext` により **memory（末尾100行）＋ transcript tail（60行）＋ ゲーム brief** を次の ask に再注入（room.ts:1583〜, contextPrefix）。
規範化：これは**コンテキストのページイン**。「セッションは使い捨て、文脈は永続層から再構成可能」という不変条件を OS が保証する。

### 4.6 Presence / Takeover（プロセステーブル）
roomcore.ts の join 5 規則（resume+gone→takeover / resume+alive→拒否 / 同名gone→名前takeover / 同名alive→suffix ephemeral / 新規）。participantId 維持＋sessionId ローテで cursor・floor が連続する。**このまま規範に昇格**（既に純ロジック・テスト可能）。

### 4.7 入力正規化
確定バッファ（細切れ結合、助詞末尾で継続判定、5s 上限）＋補正辞書（learn_word で成長）。規範化：**「話し終わるまで考え始めない」はOSの保証**であり、アプリは常に確定済み発話だけを受け取る。

### 4.8 UserSpeechState
「ユーザーが話しているか」は単一の状態源で、TTS pump はこれでゲートされる（AI側音声はユーザー発話中に前進しない）。規範化：**マイクの状態は部屋のグローバル資源**。

---

## 5. 会話 syscall 仕様 v0（抽出後の公開面）

room.ts が現にやっていることの命名。**新機能を足さない**（§7 の修正を除く）。

```ts
// --- 発話（二平面） ---
utter(pid, text, { turnId?, channel, priority }) -> UtteranceLease
  // テキスト平面へは即 append（不喪失）。音声平面はリース
lease.status: 'queued' | 'synthesizing' | 'playing' | 'played' | 'revoked'
revoke_pending(reason: 'user_spoke' | 'barge_in' | 'explicit')
  // 現行の speechEpoch++ に相当。played は対象外

// --- 配送（at-least-once） ---
listen(pid, cursor, deadline<=48s) -> { events, cursor } | cursor_expired | no_speech
say_ack(pid, turnId)                 // 事前合成プールから即再生

// --- floor / turn ---
route(text) -> { targets, method }
turn_open(target, text, channel) -> turnId
turn_responded(turnId)

// --- レイテンシ契約 ---
contract(turnId, stages: [{at, action: 'ack'|'filler:context'|'filler:status'|'cutoff'}])

// --- 対話承認（§7-2 の修正込み） ---
ask_user(question, { bindId, summaryToRead, timeoutMs=60_000 })
  -> 'allow' | 'deny' | 'timeout_deny'
  // bindId ごとに個別の待ち。承認発話は復唱確認つき（「◯◯、許可でいい?」）

// --- セッション監督 ---
session_open(opts) -> Session          // Brain 生成
session_ask(s, text, { onSentence, guardMs }) -> string
session_supervise: guard超過 → interrupt → grace → recreate → page_in
page_in(channel) -> string             // memory + transcript tail + app brief

// --- presence ---
join(name, voice, resume?) -> { participant, mode: new|takeover|suffix } | full
heartbeat(pid) / leave(pid)

// --- 入力 ---
ingest_utterance(raw) -> RoomEvent | null   // 辞書適用 + 確定バッファ + ナビ/ゲーム分岐
```

イベント語彙は roomcore.ts の RoomEvent をそのまま採用（user_speech / agent_speech / presence / system、filler、turnId='none'、channel）。

---

## 6. 状態と永続化

**現状（分散）**：in-memory EventStore（上限1000・揮発）＋ `~/.talkingclaw/` の tasks.json / rooms.json / settings.json / chloe-memory.md / transcript-<ch>.jsonl / games.json / projects.json / dictionary.json / metrics.jsonl / cost.jsonl。整合は都度パッチ（W9-1 P2 で tasks を永続化した経緯）。

**方針（C2 で実施）**：
1. EventStore を **WAL つき**にする：append は先にディスク（transcript-*.jsonl を汎用化した room-events.jsonl）→ メモリ。in-memory 1000 件は「配送窓」であって真実ではない、と定義を明文化
2. tasks / plan / permission の状態遷移をイベント経由に寄せる（`TaskQueued/Working/Done/Failed`, `PermissionAsked/Answered`, `PlanProposed/Confirmed/Cancelled`）。導出ビューが tasks.json を置き換える。settings / dictionary / memory は設定ファイルのまま（イベントにしない — 過剰化しない）
3. アーカイブ（6h 区切り）は WAL のローテーションとして再定義

---

## 7. 既知の欠陥と修正（抽出と同時にやる価値があるもの）

1. **イベントログが真実の源でない** → §6。クラッシュ整合の場当たり対応を根治
2. **承認の非束縛（会話版 TOCTOU）**：pendingPermission 中は次発話の「はい〜」が何にでも効く。クロエが並行で別の質問をしていたら誤承認する。修正（会話OS側）：(a) ask_user を bindId 単位にし、質問の**復唱**（対象の要約）を必須にする、(b) 承認発話の判定を「直近に読み上げた質問への応答窓内」に限定、(c) `PermissionAsked/Answered` をイベント化して誰が何を許可したか残す。引数ハッシュへの暗号学的束縛は**やらない**（カーネルの領分 — §8）
3. **`remember` が無審査の永続書き込み**：モデル出力が chloe-memory.md に直行し毎回注入される（記憶汚染面）。会話OS側の最小修正：remember を `MemoryAppended` イベント化＋画面に可視化＋声で取り消せる（「さっきのは覚えなくていい」→ 削除）。信頼分類はしない（カーネルの領分）
4. **コストは観測のみ**：cost.jsonl は enforce されない。会話OSは**閾値通知フック**だけ持つ（「今日はもう $X 使ってるよ」）。停止の強制はしない（カーネルの領分）

境界原則：**会話OSが直すのは「対話として壊れている」部分まで。「セキュリティとして壊れている」部分はフックを空けてカーネルに残す。**

---

## 8. agent-runtime との境界面（依存なし・フック3点）

| フック | 会話OS側 | 将来カーネル側が挿すもの |
|---|---|---|
| 承認 | ask_user(bindId, 復唱, 応答窓) | 引数ハッシュ束縛・署名 token・証拠ログ |
| 委任 | delegate 直前の `beforeDelegate(task)` フック | capability 発行・effect 分類・budget checkout |
| 記憶 | MemoryAppended イベント + 取り消し UI | provenance/trust 付与・書き込みポリシー |

会話OSはこの3点を**関数フックとイベント**として空けておくだけ。カーネル不在でも完全に動く（今の talkingclaw と同じ）。両プロジェクトが共有するのは「append-only イベント」という形だけで、スキーマも別、リポジトリも別。

---

## 9. 抽出計画（Claude Code 向け・破壊禁止事項つき）

**破壊禁止（CLAUDE.md rule 4 準拠）**：稼働中の部屋(port 3300)・音声エンジン(port 10101)を止めない。accept-*.sh を勝手に実行しない。サーバ変更は再起動が要る旨をユーザーに伝える（勝手に再起動しない）。

- **C0：計測の基線を取る。** 変更前に metrics.jsonl から現状値を記録（初音 ms 分布、ack 被覆率、barge_in 件数）。抽出の成否はこの回帰で判定する
- **C1：抽出（挙動不変）。** room.ts から §2 の機構を `src/convos/`（仮）へ移す。順序は結合の薄い順：①TtsScheduler+FillerEngine+UserSpeechState → ②Router/Turn/escalation → ③確定バッファ+辞書 → ④permission → ⑤session 監督(askGuarded/page_in) → ⑥永続化群。roomcore.ts の「I/O なし純ロジック」規律を全体に適用し、各段で check-ui / accept を通す。**ゲーム・相談モード・git 自動 commit はアプリ層に残す**（動かさない）
- **C2：§6 の WAL 化 + §7-2/3 の承認束縛・remember 可視化。** ここだけが挙動変更。それぞれ独立 PR
- **C3：2つ目のアプリで検証。** ゲーム1本（blackjack が最小）を convos プリミティブだけで書き直し、エスケープハッチ数を数える（FALSIFICATION 判定）
- **C4：仕様化。** 安定した syscall だけを §5 の形で成文化。metrics 基線との差分を付す
- **C5：言語プロトタイプ（§10）。** C4 の後でのみ着手

---

## 10. 会話言語（TalkScript 仮）— 最後にやる

言語が**静的に保証できて、SDKでは保証できない**もの：
1. すべての応答経路に latency contract がある（filler 未定義の待ちが存在しない）ことをコンパイル時に検査
2. すべての発話に turn 帰属がある（帰属なし発話は型エラー、進捗発話は明示の `progress` 構文）
3. 割り込み点の全域性：N 秒を超える非中断区間が書けない
4. 二平面の分離：`say`（リース）と記録は言語が自動で分け、「テキストを消す」操作が存在しない（CLAUDE.md rule 2 の言語化）
5. 承認の束縛：`ask permission` は対象式なしでは書けない

構文スケッチ（拘束力なし・C5 で再設計）：

```
room work {
  participant chloe  voice "まお/ノーマル"  role conversation
  participant worker voice "まい/ノーマル"  role narration

  on utterance from user {
    within 500ms  ack from pool
    within 8s     first sentence of reply(session: chloe) else filler context
    within 20s    else filler status
    within 180s   else interrupt session, say "ごめん、固まってた", repage
  }

  on user_speaks   { revoke pending audio }     // テキストは言語仕様上、消せない

  when tool outside allowlist {
    ask user permission bind tool.description   // 束縛なしは型エラー
      timeout 60s => deny
  }
}
```

コンパイル先は §5 の syscall。**C4 より前に構文を確定しない**（agent-runtime 側で確立した規律と同じ：意味論→表現の順）。

---

## 11. 成功 / 失敗条件（実測で判定）

成功：
- 初音時間・ack 被覆率・barge-in 反応が C0 基線から劣化しない（metrics.jsonl）
- stale drop の誤破棄 0（再生済みを消さない・テキスト喪失 0）
- 承認の誤発火 0（束縛外の「はい」で許可されない — 会話しながらの許可テストを accept に追加）
- blackjack の再実装がプリミティブのみで書け、room.ts 側の該当コードが消える
- daemon 強制終了 → 再起動で、tasks / 承認待ち / 会話が WAL から復元される

失敗（設計修正）：
- 抽出後に room.ts＋convos の合計行数・相互 import が抽出前より増える
- レイテンシ回帰が出て契約型では表現できない
- ゲーム移植でエスケープハッチが 3 箇所を超える

---

## 12. Open Questions
1. channel（部屋）と floor の関係 — 部屋を跨ぐ floor は存在しうるか（現状は部屋ごと独立で正しそう）
2. 完全ローカル STT（Web Speech の Google 依存の解消）— tools/listen.swift（macOS Speech）路線の昇格可否
3. 複数人の人間ユーザー — UserSpeechState と floor が単一ユーザー前提。マルチユーザーは v2 以降の仮定として明記
4. mcp.ts（外部 agent proxy）を convos のクライアントライブラリとして一般化するか
5. 命名 — 本書では ConvOS/TalkScript は仮。決定はプロジェクトオーナー

---

## 変更履歴
- v0.1（本書）：talkingclaw コードレビューから初版起草。agent-runtime との分離を明文化
