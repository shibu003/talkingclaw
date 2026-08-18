# プロダクト方針 — Talkingclaw（統合版・2026-08-17）

出典: CEO からの統合指示（会話内、PBI-045）。実装前の意思決定を凍結するための正本。
実装に入る際は本書を G1 の前提として参照し、各 Phase を PBI 化してから着手する。

## 1. プロダクトの位置づけ

**Talkingclaw を別プロダクトへ分割しない。**
`LastSeat` は新しい製品名ではなく、Talkingclaw の最初の強いユースケースとして扱う。

### 一文定義
> 人間と継続的な人格を持つ AI キャラクターが、同じ部屋で話し、一緒に遊べる空間。
> 人数が足りない場合は AI が席を埋める。
>
> A shared room where humans and persistent AI characters can talk and play together.
> When a game is one player short, an AI friend fills the seat.

### 用語
| 名称 | 役割 |
|---|---|
| Talkingclaw | 製品全体 |
| Last Seat | 人数不足・離席時に AI が席を埋める機能 |
| Character Provider | キャラクター人格・記憶の供給層 |
| Character Passport | 将来のゲーム間持ち運び機能 |
| Talkingclaw SDK | 外部ゲーム需要が出てから分離する SDK |

## 2. 現在の最優先目標（新機能追加より優先）

新しい大機能を追加する前に、以下の2実証を完了する。

### 実証A：実際の友人と一局遊ぶ
最低条件:
- 人間1〜3人とAIで卓を成立させる／AIが不足席に入る
- 人間が離席したらAIが代打／人間が戻ったら席を返す
- AIが合法手だけを実行する
- 音声会話をしながら最後まで一局終えられる

観察内容: AIがいたことで本来始まらなかったゲームが始まったか／人間がAIを名前で呼んだか／
AIへの自然な発話が発生したか／AIの発言がゲームを邪魔しなかったか／終了後、同じAIをまた呼びたいか。

### 実証B：同じAIを1週間使う
確認するのは内部の9軸数値ではなく**ユーザーが変化に気づくか**。検証時には9軸の内容を事前に説明しない。

1週間後の質問: 「初日と比べて、このキャラクターの性格や自分への態度はどう変わったと思うか。」

成功の兆候: 前より強気になった／自分への当たりが変わった／過去の出来事を気にしている／
特定の人にだけ態度が違う／別のAIではなく同じAIを呼びたい。

## 3. 今、Talkingclaw へ追加するもの（Phase 1〜2 で PBI 化する対象）

### 3.1 Seat Manager
人数不足・離席・復帰を管理する。

```ts
interface SeatManager {
  detectMissingSeats(gameId: string): Promise<Seat[]>;
  assignAI(seatId: string, characterId: string): Promise<void>;
  substituteHuman(userId: string, characterId: string): Promise<void>;
  returnSeatToHuman(userId: string): Promise<void>;
  releaseAI(seatId: string): Promise<void>;
}

type SeatStatus = "empty" | "human" | "ai" | "ai-substitute" | "reserved-for-human";
```

守るべきルール: 人間が優先／AIが勝手に人間の席を奪わない／復帰した人間へ安全に席を戻す／
turnの途中では不整合が起きない／disconnectと意図的離席を区別する／timeout後の処理を明示する。

### 3.2 Character Provider
Talkingclawのroom機能と、人格・記憶を分離する。

```ts
interface CharacterProvider {
  getCharacter(characterId: string): Promise<CharacterProfile>;
  getRelationship(characterId: string, subjectId: string): Promise<RelationshipSnapshot>;
  getRelevantMemories(characterId: string, context: MemoryContext): Promise<CharacterMemory[]>;
  recordEvent(event: CharacterEvent): Promise<void>;
  updateRelationship(update: RelationshipUpdate): Promise<void>;
}
```

実装は最低2つ用意する:
- **LocalCharacterProvider**: ローカル保存・アカウント不要・Shibubu不要・最低限の人格記憶・開発/offline向け
- **ShibubuCharacterProvider**: 長期記憶・9軸・成長・進化・複数端末同期・複数room間の継続性

原則: **TalkingclawはShibubuなしでも動作する。Shibubuは高度な継続人格を提供するoptional providerとする。**

### 3.3 Character Profile
```ts
interface CharacterProfile {
  id: string;
  displayName: string;
  avatar?: { type: "vrm" | "image" | "none"; uri?: string };
  voice?: { provider: string; voiceId: string };
  personality: { traits: Record<string, number>; speakingStyle?: string; behaviorHints?: string[] };
  capabilities: { canSpeak: boolean; canPlayGames: boolean; canUseTools: boolean };
}
```
Talkingclaw側はShibubu内部のDB構造や9軸更新アルゴリズムを知らない。渡すのは描画・会話・行動に必要なsnapshotだけ。

### 3.4 Relationship Snapshot
キャラクターと各人・各groupの関係を分けて扱う。
```ts
interface RelationshipSnapshot {
  characterId: string;
  subjectId: string;
  subjectType: "user" | "group";
  traits: { trust?: number; familiarity?: number; rivalry?: number; affection?: number; caution?: number };
  behaviorHints: string[];
  updatedAt: string;
}
```

### 3.5 Character Event
会話全文を無条件保存せず、構造化イベントを送る。
```ts
interface CharacterEvent {
  id: string; roomId: string; gameId?: string;
  characterId: string; actorId: string;
  type: "game-started" | "game-finished" | "won" | "lost" | "helped" | "betrayed"
      | "praised" | "criticized" | "substituted-player" | "returned-seat" | "custom";
  summary: string; intensity: number;
  visibility: "private" | "room" | "group";
  occurredAt: string;
}
```
保存原則: 生の音声・会話全文はデフォルト保存しない／必要な場合だけ明示的な同意を取る／
記憶は閲覧・削除・export可能にする／他roomのprivate memoryを現在のroomへ出さない。

## 4. Game Adapter（別SDK・別repoにしない）

麻雀・ポーカー・ブラックジャックを同じinterfaceに載せる（Talkingclaw内部）。
```ts
interface GameAdapter<State, Action> {
  id: string; displayName: string;
  getRequiredSeats(state: State): number;
  getCurrentSeats(state: State): GameSeat[];
  getPublicState(state: State): unknown;
  getPrivateState(state: State, participantId: string): unknown;
  getLegalActions(state: State, participantId: string): Action[];
  validateAction(state: State, participantId: string, action: Action): ValidationResult;
  applyAction(state: State, participantId: string, action: Action): State;
  isFinished(state: State): boolean;
}
```

### 重要な実装原則
**LLMに自由形式でゲーム操作をさせない。**
```
ゲーム状態 → 合法手一覧をdeterministicに生成 → AIへ合法手だけを渡す
→ AIが候補を選ぶ → validatorで再確認 → 合法なactionだけ実行
```
異常時（応答timeout／JSON parse失敗／違法手／service停止／context不足）は
deterministic policyから合法手を選ぶfallbackにする。

Pigmanから持ち込むのは **schema validation・deterministic fallback・versioned resultの思想だけ**。
Pigman全体は統合しない。

## 5. Shibubu → Talkingclaw の境界

**渡す**: stable character ID／display name／avatar reference／voice reference／
personality snapshot／relationship snapshot／relevant memory summaries／behavior hints／
evolution stage／expression hints／event記録API

**渡さない**: 9軸の本番更新式／evolution scoring／production prompts／
memory rankingの内部ロジック／Shibubuのprivate DB schema／全ユーザーのrelationship graph／
anti-abuse内部処理／analytics／server secrets／不要な会話全文

```
Talkingclaw → CharacterProvider interface → Shibubu adapter → shibubu-sdk → Shibubu private server
```

## 6. Shenron は毎turnの処理へ入れない

理由: latency増／failure point増／prompt injection面拡大／debugging範囲拡大／
ゲームAIと業務agentの責務が混ざる。

将来、次の用途だけで接続する: room作成／日程調整／招待／tournament運営／
game adapter生成補助／game終了後のsummary／外部tool実行／承認が必要な行動／
非リアルタイムのキャラクター行動。

```
Shenron（Planning / Tool Execution） → Talkingclaw Adapter → Room operation
```

## 7. MTV は今は中心に入れない

将来、AI participantあたりのtoken消費／retry／stale context／full-state rebroadcast／
overthinking／provider別コスト／game sessionあたりの推論費用の監査目的で接続する。
最初の友人テストでは通常の簡単なログで十分。

## 8. Ringo は今は必須にしない

現在のTTSを維持。Ringoは将来のoptional provider。
```ts
interface AudioProvider {
  speak(request: SpeechRequest): Promise<AudioResult>;
  generateSound?(request: SoundRequest): Promise<AudioResult>;
}
```
Talkingclaw coreへRingoのmodelや生成engineを直接組み込まない。

## 9. 今は実装しないもの（仮説検証まで凍結）

新しい`LastSeat`ブランド／新しいLastSeat repo／完全なCharacter Passport／
複数ゲーム間の完全な記憶移行／外部ゲーム向け正式SDK／marketplace／creator economy／
matchmaking／大規模cloud room／課金／enterprise管理／open world／巨大3D空間／
Shenronによる毎turn推論／Daily Lifeとの統合／Pigmanとの統合／NFT・blockchain。

## 10. Character Passport を作る条件（すべて確認後）

1. 同じゲームで、同じAIをもう一度呼ぶ人がいる
2. ユーザーがAIを名前で再指名する
3. 過去の関係性に価値を感じる
4. 別ゲームでも同じAIを使いたいという要求が出る

それまではTalkingclaw内のcharacter persistenceで十分。

将来のPassport構造（実装しない・参考のみ）:
```ts
interface CharacterPassport {
  identity: CharacterIdentity;
  publicProfile: PublicCharacterProfile;
  relationshipRefs: RelationshipReference[];
  memoryRefs: MemoryReference[];
  gameProfiles: Record<string, GameProfile>;
  permissions: CharacterPermissions;
  schemaVersion: string;
}
```
Passportにはprivate memoryの本文を直接詰めず、原則として参照または暗号化されたexportにする。

## 11. 計測するイベント

```
room_created / human_joined / ai_joined / missing_seat_detected / ai_assigned_to_seat
/ human_left / ai_substitution_started / human_returned / seat_returned_to_human
/ game_started / game_finished / ai_addressed_by_name / ai_muted / ai_interrupted
/ character_reinvited / memory_deleted / memory_exported
```

### 成功指標（Star数ではなく次を見る）
**Primary**: AIによって成立したゲーム数／session完了率／同じAIの再指名率／7日以内の再利用率
**Secondary**: AIが名前で呼ばれた回数／AIへの発話数／mute率／AI発話の割り込み率／
離席代打の成功率／違法手率／turn timeout率

**North Star候補**: 同じgroupが同じAI characterを再び招待した回数

## 12. 実装順序

- **Phase 0**: 現在の動作を固定（既存の麻雀flowをend-to-endで通す／主要event記録／
  game stateとvoice stateの不整合確認／既存機能を壊さないtest追加）
- **Phase 1**: 友人との一局（Seat Manager／AI不足席／離席代打／復帰／合法手validator／
  session記録／終了後インタビュー）
- **Phase 2**: 1週間の人格テスト（Character Provider／Local provider／Shibubu provider／
  structured event／relationship snapshot／memory確認・削除）
- **Phase 3**: 再指名の検証（同じcharacterを簡単に再招待／過去の出来事を一つだけ反映／
  再指名率を測定／別characterとの比較）
- **Phase 4**: 内部共通化（麻雀・ポーカー・ブラックジャックをGame Adapterへ移す／
  少なくとも2ゲームで共通interfaceを検証／不要な抽象化を削除）
- **Phase 5**: 外部需要が出た場合のみ（Talkingclaw SDK／Character Passport／
  外部ゲームadapter／hosted character／marketplace等を検討）

**Wave一本化ルール（shibubu-manager憲法）に従い、上記Phaseは並列トラックではなく直列チェーンとして扱う。**

## 13. 完了条件（次を満たすまで新しい大規模機能へ進まない）

### 一局テスト完了
友人を含む複数人で実施／AIを含む一局が最後まで完了／離席・復帰が少なくとも一度成功／
違法手ゼロ／音声interactionの録画または観察記録あり／終了後フィードバックあり

### 1週間テスト完了
同じcharacterを複数日に利用／relationship eventが蓄積／最終日に非誘導質問を実施／
ユーザーが知覚した変化を記録／数値変化と知覚変化を比較

### 継続判断
以下のどちらかが確認できれば次へ進む: 「次も同じAIを呼びたい」または「別のゲームでもこのAIと遊びたい」。
どちらも確認できなければ、Passportや外部SDKを作らず、会話頻度・ゲームAI・人格表現を見直す。

---

## 実装担当への短縮版

```
Talkingclawを別製品へ分割しない。LastSeatはSeat Manager機能。

最優先は新機能開発ではなく次の2実証:
1. 実際の友人を呼び、AIを含めて麻雀を一局完了する。
2. 同じAIを1週間使い、9軸の変化をユーザーが知覚するか確認する。

追加する主要境界: SeatManager / CharacterProvider / LocalCharacterProvider /
ShibubuCharacterProvider / CharacterEvent / RelationshipSnapshot / 内部GameAdapter。

TalkingclawはShibubuなしでも動作可能にする。
LLMへ自由形式でゲーム操作をさせない。合法手一覧をdeterministicに生成し、
AIが選んだactionをvalidatorで再確認してから実行する。

Shenronは毎turnの処理へ入れない。MTVとRingoもMVPでは必須にしない。

今は作らない: 別のLastSeat製品・repo / 完全なCharacter Passport / 外部向けSDK /
marketplace / matchmaking / 課金 / 大規模3D world / 全ゲーム対応。

Character Passportと外部SDKは、ユーザーが同じAIを再指名し、
別ゲームでも使いたいという需要が確認された後に作る。

最重要指標: 「同じgroupが同じAI characterを再び招待したか」。
```
