// 同一 channel の会話は最新の user_speech だけを生かす。
// Brain の中断完了は新 turn の開始条件にせず、revision で遅延 callback を失効させる。

export interface InterruptibleBrain {
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export type TurnPath = 'room' | 'memo';

export class TurnMetricClock {
  readonly #started = new Map<string, number>();
  readonly #floor = new Map<string, number>();
  readonly #path = new Map<string, TurnPath>();
  readonly #limit: number;

  constructor(limit = 1_000) {
    this.#limit = limit;
  }

  begin(turnId: string, path: TurnPath, at = Date.now()): void {
    this.#started.set(turnId, at);
    this.#floor.set(turnId, 0);
    this.#path.set(turnId, path);
    if (this.#started.size <= this.#limit) return;
    const oldest = this.#started.keys().next().value as string | undefined;
    if (!oldest) return;
    this.#started.delete(oldest);
    this.#floor.delete(oldest);
    this.#path.delete(oldest);
  }

  event(turnId: string, kind: string, at = Date.now()): { path: TurnPath; ms: number } | null {
    const started = this.#started.get(turnId);
    if (started === undefined) return null;
    const elapsed = kind === 'turn_created' ? 0 : Math.max(0, at - started);
    const ms = Math.max(this.#floor.get(turnId) ?? 0, elapsed);
    this.#floor.set(turnId, ms);
    return { path: this.#path.get(turnId) ?? 'room', ms };
  }
}

export type ChannelRun<B extends InterruptibleBrain> = {
  brain: B;
  revision: number;
  freshBrain: boolean;
  isCurrent: () => boolean;
  detach: () => boolean;
};

type Active<T, B> = { item: T; brain: B; revision: number };

export class LatestChannel<T, B extends InterruptibleBrain> {
  revision = 0;
  inbox: T[] = [];
  busy = false;

  readonly #makeBrain: () => B;
  readonly #process: (item: T, run: ChannelRun<B>) => Promise<void>;
  readonly #onCancel: (item: T, revision: number) => void;
  readonly #interruptTimeoutMs: number;
  readonly #timeout: (ms: number) => Promise<void>;
  #brain: B;
  #freshBrain = true;
  #active: Active<T, B> | null = null;
  #scheduled = false;
  #resetWhenIdle = false;

  constructor(opts: {
    makeBrain: () => B;
    process: (item: T, run: ChannelRun<B>) => Promise<void>;
    onCancel?: (item: T, revision: number) => void;
    interruptTimeoutMs?: number;
    timeout?: (ms: number) => Promise<void>;
  }) {
    this.#makeBrain = opts.makeBrain;
    this.#process = opts.process;
    this.#onCancel = opts.onCancel ?? (() => {});
    this.#interruptTimeoutMs = opts.interruptTimeoutMs ?? 2_000;
    this.#timeout = opts.timeout ?? ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }));
    this.#brain = this.#makeBrain();
  }

  // revision は SpeechPlane と共有する絶対値。item が無ければ現在の応答だけを止める。
  receive(revision: number, item?: T): void {
    if (revision < this.revision) return;
    const previousRevision = this.revision;
    const pending = this.inbox.length > 0 ? this.inbox[this.inbox.length - 1] : undefined;
    if (pending !== undefined && revision !== previousRevision) this.#onCancel(pending, previousRevision);
    this.revision = revision;
    this.inbox.splice(0, this.inbox.length, ...(item === undefined ? [] : [item]));

    const active = this.#active;
    if (active && active.revision !== revision) {
      this.#onCancel(active.item, active.revision);
      this.#active = null;
      this.busy = false;
      this.#rotateBrain(active.brain);
    }
    if (item !== undefined) this.#schedule();
  }

  // greeting など user_speech 以外の初回処理。現在 revision のまま開始する。
  start(item: T): void {
    this.inbox.splice(0, this.inbox.length, item);
    this.#schedule();
  }

  // 設定変更は実行中 turn を切らず、次に空いた時点で Brain を作り直す。
  resetBrain(): void {
    if (this.#active) {
      this.#resetWhenIdle = true;
      return;
    }
    this.#rotateBrain(this.#brain);
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#active) return;
    const item = this.inbox.pop();
    this.inbox.length = 0;
    if (item === undefined) return;

    const active: Active<T, B> = { item, brain: this.#brain, revision: this.revision };
    const freshBrain = this.#freshBrain;
    this.#freshBrain = false;
    this.#active = active;
    this.busy = true;
    const run: ChannelRun<B> = {
      brain: active.brain,
      revision: active.revision,
      freshBrain,
      isCurrent: () => this.#active === active && this.revision === active.revision,
      detach: () => {
        if (this.#active !== active) return false;
        this.#active = null;
        this.busy = false;
        this.#rotateBrain(active.brain);
        return true;
      },
    };

    try {
      await this.#process(item, run);
    } finally {
      if (this.#active === active) {
        this.#active = null;
        this.busy = false;
        if (this.#resetWhenIdle) this.#rotateBrain(active.brain);
      }
      if (this.inbox.length > 0) this.#schedule();
    }
  }

  #rotateBrain(oldBrain: B): void {
    this.#resetWhenIdle = false;
    if (this.#brain === oldBrain) {
      this.#brain = this.#makeBrain();
      this.#freshBrain = true;
    }
    void Promise.race([
      Promise.resolve().then(() => oldBrain.interrupt()),
      this.#timeout(this.#interruptTimeoutMs),
    ]).catch(() => {}).finally(() => {
      void oldBrain.close().catch(() => {});
    });
  }
}
