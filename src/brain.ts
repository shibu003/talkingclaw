import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Claude Agent SDK の streaming input mode で 1 セッションを維持する「頭脳」担当。
// Claude Code の認証を継承するので API key 不要。会話文脈はセッション内で続く。
export class Brain {
  #input = new AsyncQueue<SDKUserMessage>();
  #query: Query;
  #waiting: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  #buffer = '';
  #streamBuffer = '';
  #onSentence: ((sentence: string) => void) | null = null;

  constructor(opts: {
    systemPrompt: string; model: string;
    allowedTools?: string[]; cwd?: string; maxTurns?: number;
    mcpServers?: Record<string, unknown>;
    settingSources?: ('user' | 'project' | 'local')[];
    effort?: string;
    canUseTool?: (name: string, input: Record<string, unknown>) => Promise<
      { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
    >;
  }) {
    this.#query = query({
      prompt: this.#input,
      options: {
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        // allowedTools に載せたツールだけ承認なしで使える(未記載は不可のまま)。
        // 危険寄りの操作(削除・push 等)は persona の口頭確認ルールで抑止する
        allowedTools: opts.allowedTools ?? [],
        cwd: opts.cwd,
        maxTurns: opts.maxTurns ?? 1,
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers as never } : {}),
        ...(opts.canUseTool ? { canUseTool: opts.canUseTool as never } : {}),
        ...(opts.settingSources ? { settingSources: opts.settingSources } : {}),
        ...(opts.effort ? { effort: opts.effort as never } : {}),
        includePartialMessages: true,
      },
    });
    void this.#pump();
  }

  // onSentence を渡すと、生成途中でも文が完成した端から呼ばれる(先行 TTS 用)。
  ask(text: string, onSentence?: (sentence: string) => void): Promise<string> {
    if (this.#waiting) return Promise.reject(new Error('前の返答を待っています'));
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#buffer = '';
      this.#streamBuffer = '';
      this.#onSentence = onSentence ?? null;
      this.#input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      } as SDKUserMessage);
    });
  }

  async close(): Promise<void> {
    this.#input.close();
    this.#waiting?.reject(new Error('セッションを終了しました'));
    this.#waiting = null;
  }

  // 実行中の turn を中断する(SDK が result を返し、待機中の ask が解決される)
  async interrupt(): Promise<void> {
    await this.#query.interrupt();
  }

  async #pump(): Promise<void> {
    try {
      for await (const msg of this.#query) {
        if (msg.type === 'stream_event') {
          const event = msg.event;
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            this.#streamBuffer += event.delta.text;
            this.#emitCompleteSentences();
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') this.#buffer += block.text;
          }
        } else if (msg.type === 'result') {
          const waiting = this.#waiting;
          this.#waiting = null;
          const remainder = this.#streamBuffer.trim();
          if (remainder) this.#onSentence?.(remainder);
          this.#streamBuffer = '';
          this.#onSentence = null;
          const text = this.#buffer.trim();
          this.#buffer = '';
          if (!waiting) continue;
          if (msg.subtype === 'success') waiting.resolve(text || msg.result);
          else waiting.reject(new Error(`Claude セッションでエラーが発生しました (${msg.subtype})`));
        }
      }
      this.#fail(new Error('Claude セッションが終了しました'));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // streamBuffer から完成した文(。！？!? まで)を取り出して通知する
  #emitCompleteSentences(): void {
    let index: number;
    while ((index = this.#streamBuffer.search(/(?<=[。．！？!?])/)) > 0) {
      const sentence = this.#streamBuffer.slice(0, index).trim();
      this.#streamBuffer = this.#streamBuffer.slice(index);
      if (sentence) this.#onSentence?.(sentence);
    }
  }

  #fail(error: Error): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    this.#onSentence = null;
    waiting?.reject(error);
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift() as T, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
