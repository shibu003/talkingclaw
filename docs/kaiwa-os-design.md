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
| `src/room.ts` | 2,197 | daemon 本体。**カーネル相当の機構とアプリが同居**（抽出対象）。①で 154 行を convos へ出した |
| `src/convos/speech.ts` | 308 | **音声平面（①で抽出済み）**：`UserSpeechState`（①a）/ `SpeechPlane` = TtsScheduler + FillerEngine（①d） |
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
| UserSpeechState | **→ `convos/speech.ts`（①a 済）** | 「ユーザーが今話しているか」の**単一状態源**。pump がこれで停止 |
| FillerEngine | **→ `convos/speech.ts`（①d 済）** | 相槌＝事前合成プールのみ。ack/context/status の3種 |
| TtsScheduler | **→ `convos/speech.ts`（①d 済）** | participant 内 FIFO / 間は (priority, RR)。**epoch stale drop**。queue上限20→text-only |
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

**①の抽出で見つかった構造（切断が正しい線に入った証拠。②以降の地図を読むときの手掛かり）**：

- **スケジューラ ⇄ filler は双方向だった**。filler が `enqueueJob` で事前合成を依頼し、`runJob` が
  完成した音声を **pid の文字列プレフィックス**（`__narration_` / `__context_`）で判別して
  filler のプールに書き戻していた。置き場をジョブ側に持たせる（`onReady`）と 10 行の分岐が 1 行になった
- **スケジューラがエンジンの生死を決めていた**。合成失敗を自分で数え、閾値 3 で `engineState='down'` に
  書き換え、告知まで出していた。数える・倒す・告知するを所有者（EngineManager）へ戻した
- **`down` の告知は 2 種類ある**（合成 3 連続失敗＝「声がうまく出せない。復旧するまで文字で続けるね」／
  プロセス死亡＝「音声エンジンが落ちたみたい。しばらく文字だけで続けるね」）。経路が別なので両方残す。
  ここを 1 つに畳むと、エンジンが生きているのに合成だけ失敗している状態を言い分けられなくなる
- **escalation（②の範囲）が filler の内部プールを直接読んでいた**。cue メソッド越しにしたら、
  未達通知の文言が `NARRATION_TEXTS.undelivered` と**同じ文字列のハードコード重複**だったことが判明して消えた。
  重複が浮き上がるのは、境界を正しい線で引けたときの副産物

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

**v0.3 の規範**：`responded` の boolean 1 つで二平面を表すのをやめ、**平面ごとに状態を持つ**。

```ts
text:  'pending' | 'answered'
voice: 'none' | 'queued' | 'synthesizing' | 'playing' | 'played' | 'revoked'
```

理由と実測は §7-5。要点は **「応答した」は平面ごとに違う時刻に起きる**ということ。
テキストは 23 秒で届き、音声は 2 分 56 秒後に鳴る、という状態が実在する。
1 つの bool はそのどちらかしか表せず、escalation（音声の穴を埋める機構）が
テキスト側の完了で止まると、音声側の穴が丸ごと空く。

**帰属は状態ではなく構造で保つ**：turnId を各層が手で持ち回るのではなく、
`utter()` が返す `UtteranceLease` に載せる（§5）。手で持ち回る限り、どこかの層で落ちる
（実際 transcript で落ちていた）。

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
// ⚠ v0.3 注記: この utter/lease は §5 の中で唯一「room.ts が現にやっていること」ではない。
// 実装は store.append で終わっていて lease を返していない。C2-① で実装する（§7-5）。
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

5. **二平面の速度差が状態として表現されていない（v0.3 で追加・最重要）**

   `Turn.responded` は **boolean 1 つ**で、テキスト平面と音声平面の両方を表している。
   §4.1 で二平面を最重要と置きながら、状態はそれを分けていない。実測（2026-07-30）:

   ```
   04:34:36  turn_created T10                      user「1から50まで数えて」
   04:34:59  turn_window_closed T10 reason=responded   ← テキスト到着で「応答済み」
   04:36:57  play_started T10                      ← 音声の 1 文目（2 分 20 秒後）
   04:37:33  play_started T10                      ← 音声の 2 文目（2 分 56 秒後）
   ```

   escalation（＝音声の穴を埋める仕組み）が `responded` を見て止まるため、
   **2 分の無音が丸ごと空く**。C0 で測った「filler 被覆率 16%・84% の turn で 6 秒超の無音」の正体はこれ。
   合成が遅いことが原因ではない（合成の遅さは下記の通り変えられない）。**穴を埋める仕組みが、
   埋めるべき時間帯に自分から降りている**のが原因である。

   派生して 2 つの症状が出る:

   - **帰属が表示層に届かない**。`transcript-*.jsonl` のキーは `["at","who","text"]` で
     **turnId が落ちている**。`RoomEvent` は turnId を持っているのに、書き出す時点で捨てている。
     結果、2 分後に届いた返答が別の質問の答えに見える。実測では
     「今日あったこと聞かせてよ」が `play_started turn=T10`（1から50への 2 文目）なのに、
     時系列上は直前の別発話（T11「ABC 全て発音して」）への返答に見えていた。
     さらに 04:27:16 には T5（挨拶）と T9（数えて）への返答 5 文が**同じ秒に混ざって**出ている
   - **`speak` の自動帰属も同じ bool を見る**ため、テキストの応答窓と音声の応答窓を区別できない

   **合成の実測（この設計の前提。変えられない側）**:

   ```
   audio_query   2,958ms
   synthesis    46,661ms   ← 3.4 秒の音声に 47 秒（リアルタイム比 14 倍）
   直列 2 文     44,428ms
   並列 2 文     52,772ms   ← 直列より遅い = エンジンは単一ロック。並列化は無効
   ```

   短文（「てすと」）なら 11 秒。**文が長いほど急激に遅くなる**。
   したがって「速くする」道は無く、**待ちを隠す／遅れても混ざらない**が設計の目標になる。

   **修正の方向（C2）**: `responded: boolean` を平面ごとに分ける。

   ```ts
   text:  'pending' | 'answered'                                   // テキスト平面（不喪失）
   voice: 'none' | 'queued' | 'synthesizing' | 'playing' | 'played' | 'revoked'  // 音声平面（リース）
   ```

   | 機構 | 現在の参照先 | 修正後 |
   |---|---|---|
   | escalation の停止 | `responded` | **`voice === 'playing'`**（鳴り始めるまで filler を出し続ける） |
   | 自動帰属（`attribute`） | `responded` | `text` |
   | board の「未応答」 | `responded` | `text` |
   | 打切り通知 | `noticeSent` | 変更なし |

   あわせて §5 の `UtteranceLease` を**実装する**（仕様にあるが未実装で、`store.append` で
   終わっている）。`utter()` が lease を返せば turnId が lease に載るので、
   **transcript に turnId を書き忘れる経路が構造上なくなる**。

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
  - **切断パターン（①で確立。②以降もこれに従う）**：**読み取りは注入 getter、状態変更は所有者への callback、告知は判定した者が出す。** 移す前に結合を切る（切らずに移すと結合ごと convos へ持っていく）
- **C2：§7-5 の二平面分離 + §6 の WAL 化 + §7-2/3 の承認束縛・remember 可視化。** ここだけが挙動変更。それぞれ独立 PR
  - **C2 の中では §7-5 を先にやる**（v0.3 で追加）。理由は 2 つ。(a) 実測で壊れていることが
    分かっている唯一の項目で、体験を最も損なっている（2 分の無音）。(b) `UtteranceLease` を
    実装すると turnId が構造として保存されるので、WAL（§6）に落とす時点で帰属が揃っている。
    順序が逆だと WAL に帰属なしのイベントが積まれ、後から遡れない
  - 実装順（実測が効く順）: ① Turn を 2 軸にして escalation の参照先を `voice` に変える
    → ② `utter()` に lease を返させ、transcript を lease から書く
    → ③ 散在する定数（`LISTEN_MAX_S` / `ASK_GUARD_MS` / escalation の遅延）を contract 型に集約
- **C3：2つ目のアプリで検証。** ゲーム1本（blackjack が最小）を convos プリミティブだけで書き直し、エスケープハッチ数を数える（FALSIFICATION 判定）
- **C4：仕様化。** 安定した syscall だけを §5 の形で成文化。metrics 基線との差分を付す
- **C5：言語プロトタイプ（§10）。** C4 の後でのみ着手

---

## 10. 会話言語（TalkScript 仮）— 最後にやる

言語が**静的に保証できて、SDKでは保証できない**もの：
1. すべての応答経路に latency contract がある（filler 未定義の待ちが存在しない）ことをコンパイル時に検査。
   **締切の対象は音声平面**（`voice playing`）であって、テキストの到着ではない（v0.3 / §7-5）。
   テキスト到着で締切を満たしたことにすると、実装が「答えたつもりで 2 分黙る」状態を書けてしまう
2. すべての発話に turn 帰属がある（帰属なし発話は型エラー、進捗発話は明示の `progress` 構文）。
   帰属は**手で持ち回らせない** — `say` は lease を返し、記録層は lease から書く。
   turnId を引数として渡す設計にすると、どこかの層で落ちる（v0.3 で実測: transcript が
   `["at","who","text"]` になっていて帰属が追えなかった）
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
    within 8s     voice playing else filler context   // ← テキスト到着ではなく「鳴り始めたか」
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
- **[C1 完了時に判定]** room.ts + src/convos/ の合計行数（生の行数、除外なし）が 2,345（C0 時点）の **+15%（2,700 行）を超える**、または相互 import が発生している → 失敗。中間段での増加は判定対象外だが、各段の commit メッセージに増分の内訳（型/公開面/実装）を記録する
- **[C3 完了時に判定]** blackjack 移植後の合計行数が **2,345 を下回らない** → 失敗。抽出の削減効果はここで回収されるべきで、回収されないなら公開面が過剰
- レイテンシ回帰が出て契約型では表現できない
- ゲーム移植でエスケープハッチが 3 箇所を超える

**指標について（事前登録）**：行数は**生の行数**で測る。型宣言・コメント・公開面を除外しない。
除外したくなる場面は必ず来る（実際 C1-① で +160 のうち大半が型と公開面だった）が、
**増えた中身が分かった後に条件から除外するのは、反証条件を結果に合わせて削る動き**である。
型・公開面の肥大は実在する失敗モードで、§3 の仮説 (b)「新アプリがアプリ層のコードだけで書ける」に
直接跳ね返る。`SpeechDeps` や cue 群が増え続けるなら、それは生の行数が捕まえるべき劣化。
**天井 2,700 を動かせるのは v0.2 を書いた今この時点だけ**。②以降の実測を見てからの変更は禁止。

---

## 12. Open Questions
1. channel（部屋）と floor の関係 — 部屋を跨ぐ floor は存在しうるか（現状は部屋ごと独立で正しそう）
2. 完全ローカル STT（Web Speech の Google 依存の解消）— tools/listen.swift（macOS Speech）路線の昇格可否
3. 複数人の人間ユーザー — UserSpeechState と floor が単一ユーザー前提。マルチユーザーは v2 以降の仮定として明記
4. mcp.ts（外部 agent proxy）を convos のクライアントライブラリとして一般化するか
5. 命名 — 本書では ConvOS/TalkScript は仮。決定はプロジェクトオーナー

---

## 変更履歴
- v0.1：talkingclaw コードレビューから初版起草。agent-runtime との分離を明文化
- **v0.2（本書）**：C1-① 完了時点の判定。合計行数が 2,345 → 2,505（**+160**）で、旧 §11 の
  「抽出後に合計行数が増える → 失敗」に形式的に触れた。判定は**失敗ではない**とした。理由は 2 つ:
  (1) 旧条件の「抽出後」は素直に読めば C1 完了後（⑥まで）であって①完了時点ではない、
  (2) §11 の成功条件が別項目で「blackjack 移植で room.ts 側の該当コードが消える」と立てている以上、
  この文書自身が**削減の回収は C3** と言っている。C1 は §5 が要求する「命名と公開面の明示」の工程なので、
  各段で行数が増えるのは抽出が正しく進んでいる兆候であり、①の +160 を失敗と数えることは
  §5 が要求したことを罰することになる。
  一方で「実装行数（型・コメントを除く）」への指標変更は**採らなかった** —
  増えた中身が型だと分かった後に型を除外するのは、反証条件を結果に合わせて削る動きそのものであり、
  型・公開面の肥大は §3 の仮説 (b) に直接跳ね返る実在の失敗モードだから。
  代わりに**指標は生の行数のまま、測定点を C1 完了時・C3 完了時に固定し、天井 2,700（+15%）を事前登録**した。
  +15% の根拠：①の +160 を⑥段まで単純外挿すると過大（①はクラス骨格・`SpeechDeps` 型など
  一回きりの固定費を多く含む）、一方 +5% では②の Router/Turn で turnId 周りの型を書き出すだけで尽きる、その間。
  **この天井を動かせるのは v0.2 を書いた時点だけで、②以降の実測を見てからの変更は禁止。**
  ①の増分内訳：型定義（`SynthJob` / `FillerCue` / `SpeechDeps`）・クラス骨格・公開面の cue 3 つ・
  設計への参照コメント。減：pid プレフィックス分岐（-9）、未達通知の文字列重複（-1）。
  あわせて §9 C1 に①で確立した切断パターンを、§2 に①で見つかった構造を記録した。
- **v0.3（本書）**：C1-① / C1-② を実機で動かして出た欠陥を §7-5 として追加し、
  その解を prompt ではなく**状態の型と syscall**で与えた。

  実測で確定したこと:
  - `Turn.responded` は boolean 1 つで**テキスト平面と音声平面の両方**を表しており、
    escalation がテキスト側の完了で止まるため音声側の穴（実測 2 分 20 秒）が丸ごと空く。
    C0 で測った「filler 被覆率 16%」の正体
  - `transcript-*.jsonl` のキーが `["at","who","text"]` で **turnId が落ちている**。
    `RoomEvent` は持っているのに書き出し時に捨てている。結果、2 分後に届いた返答が
    別の質問の答えに見える（実測: `play_started turn=T10` の 2 文目が、直後の別発話 T11 への
    返答に見えていた）。同一秒に 2 つの turn への返答 5 文が混ざる例もある
  - 合成は **audio_query 3.0s + synthesis 46.7s**（3.4 秒の音声にリアルタイム比 14 倍）。
    **並列 2 文 52.8s > 直列 2 文 44.4s** でエンジンは単一ロック。**並列化は無効**。
    したがって「速くする」道は無く、設計目標は**待ちを隠す／遅れても混ざらない**になる

  規範として入れたもの:
  - §4.2: `responded: boolean` → `text` / `voice` の 2 軸。escalation は `voice === 'playing'` を見る
  - §4.2 / §10-2: **帰属は手で持ち回らせない**。`utter()` が返す lease に載せ、記録層は lease から書く
  - §5: `utter`/`UtteranceLease` は §5 の中で唯一の**未実装項目**である旨を明記
  - §9 C2: C2 の中で §7-5 を**最初にやる**。WAL より先でないと、帰属なしのイベントが WAL に積まれる
  - §10-1: latency contract の締切対象は**音声平面**（`voice playing`）。テキスト到着で
    締切を満たすことにすると「答えたつもりで 2 分黙る」実装が書けてしまう

  この版で prompt による対処（返答を短くする・案内を減らす等）は**解にしていない**。
  症状は prompt で薄まるが、原因は状態の表現にあるため再発する。
