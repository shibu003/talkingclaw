// 会話OS / 音声平面（設計: docs/conversation-os-v0.1.md §4.1, §4.8）
//
// ここに置くのは「発話の音声側」に関わる機構だけ。テキスト平面（EventStore への append）は
// roomcore.ts が持つ。両者を分けているのが二平面発話の骨格 —
// テキストは append-only で失われないが、音声は失効しうるリースである。
//
// C1 の抽出方針: 挙動を変えない。room.ts にあった実装をそのまま移し、依存は注入する。

// ---- UserSpeechState: 「ユーザーが今話しているか」の単一の状態源（§4.8）----
// ブラウザの STT interim 結果を /speech-state で報告させて保持する。AI 側の音声出力
// （TtsScheduler の pump / filler escalation）はこれを見て、ユーザーが話し終わるまで先に進めない。
// マイクの状態は部屋のグローバル資源であり、状態源を 2 つ持たないことがこの型の存在理由。
// client からの更新が途切れても staleMs で自動解除する（更新が来なくなった時の deadlock 防止）。
export class UserSpeechState {
  #speaking = false;
  #at = 0;
  readonly #staleMs: number;

  constructor(staleMs = 4_000) {
    this.#staleMs = staleMs;
  }

  // client からの報告。戻り値は「話し中 → 話し終わり」に変わったかどうか。
  // 呼び側はこれを確定バッファの flush の起点に使う
  report(speaking: boolean): boolean {
    const ended = this.#speaking && !speaking;
    this.#speaking = speaking;
    this.#at = Date.now();
    return ended;
  }

  // 発話がテキストとして確定した = この turn の「発話中」は終了。
  // client からの false 通知の到着順に依存しないよう、確定側からも倒せるようにしている
  clear(): void {
    this.#speaking = false;
  }

  get active(): boolean {
    return this.#speaking && Date.now() - this.#at < this.#staleMs;
  }

  waitUntilDone(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.active) return resolve();
        setTimeout(check, 200);
      };
      check();
    });
  }
}
