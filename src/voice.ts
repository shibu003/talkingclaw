import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// AivisSpeech でアニメ声を合成して afplay で再生する「声」担当。
// 文単位に分割し、文 N の再生中に文 N+1 を合成するパイプラインで体感遅延を下げる。
export class Voice {
  #url: string;
  #speaker: number;
  #speedScale: number;
  #enginePath: string;
  #tmpDir: string | null = null;
  #player: ChildProcess | null = null;
  #playQueue: Promise<void> = Promise.resolve();
  #generation = 0;
  #fileSeq = 0;

  constructor(opts: { url: string; speaker: number; speedScale: number; enginePath: string }) {
    this.#url = opts.url;
    this.#speaker = opts.speaker;
    this.#speedScale = opts.speedScale;
    this.#enginePath = opts.enginePath;
  }

  // engine 疎通確認。落ちていたら同梱バイナリから自動起動して立ち上がりを待つ。
  async ensureEngine(): Promise<string> {
    const version = await this.#fetchVersion();
    if (version !== null) return version;

    if (!existsSync(this.#enginePath)) {
      throw new Error(
        `AivisSpeech Engine に接続できません (${this.#url})。` +
          `engine が見つかりません: ${this.#enginePath}\n` +
          'https://github.com/Aivis-Project/AivisSpeech-Engine/releases から macOS 版を engine/ に展開してください。',
      );
    }

    // MCP モードでは stdout が protocol 専用なのでログは stderr へ
    console.error('AivisSpeech Engine を起動しています…(音声モデルの読み込みに数十秒かかります)');
    spawn(this.#enginePath, [], {
      cwd: dirname(this.#enginePath),
      detached: true,
      stdio: 'ignore',
      // ローカルに無効な HuggingFace token があると BERT モデル取得が 401 で落ちるため、
      // 公開 repo に token を送らない設定で起動する
      env: { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_TOKEN: '' },
    }).unref();

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const v = await this.#fetchVersion();
      if (v !== null) return v;
    }
    throw new Error(
      `AivisSpeech Engine が起動しませんでした (${this.#url})。手動起動で原因を確認してください: ${this.#enginePath}`,
    );
  }

  async #fetchVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${this.#url}/version`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      return (await res.json()) as string;
    } catch {
      return null;
    }
  }

  // 1 文を WAV に合成して返す(ブラウザ再生用)。読み上げるものが無ければ null。
  // speaker を渡すと既定の声を上書きできる(agent ごとに声を変える用)。
  async synthesizeWav(text: string, speaker?: number): Promise<Buffer | null> {
    const speakable = stripForSpeech(text);
    if (!speakable) return null;
    return this.#synthesize(speakable, speaker);
  }

  // 文をキューに積む。合成は即座に始まり、再生はキュー順。途中で stop() されたら破棄。
  enqueue(sentence: string): void {
    const gen = this.#generation;
    for (const chunk of splitSentences(stripForSpeech(sentence))) {
      const synthesis = this.#synthesize(chunk);
      // 再生キューが await する前に reject すると unhandledRejection でプロセスが落ちるため、
      // 先にハンドラを付けておく(実際のエラー処理はキュー側の catch)
      synthesis.catch(() => {});
      this.#playQueue = this.#playQueue
        .then(async () => {
          const wav = await synthesis;
          if (gen !== this.#generation) return;
          await this.#play(wav, gen);
        })
        .catch((error: unknown) => {
          // 1 文の失敗で以降のキューを殺さない(テキストは画面に出ている)
          console.error(`音声合成エラー: ${(error as Error).message}`);
        });
    }
  }

  // キューに積んだ音声の再生完了を待つ。合成/再生の失敗はここで表面化させず握る。
  async waitIdle(): Promise<void> {
    await this.#playQueue.catch(() => {});
  }

  // テキスト全体を読み上げて再生完了まで待つ。
  async speak(text: string): Promise<void> {
    this.enqueue(text);
    await this.waitIdle();
  }

  stop(): void {
    this.#generation++;
    this.#playQueue = Promise.resolve();
    if (this.#player) {
      this.#player.kill('SIGKILL');
      this.#player = null;
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    if (this.#tmpDir) await rm(this.#tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  async #synthesize(text: string, speaker = this.#speaker): Promise<Buffer> {
    // timeout 必須: 応答しない request を待ち続けると直列 pump 全体が巻き添えで停止する
    // (以降の合成が一切走らない)。abort → 呼び出し側の retry / text-only 経路へ。
    // synthesis の上限はモデル cold load 実測 83s × 1.8(短くすると初回合成を殺してフラッピングする)
    const params = new URLSearchParams({ text, speaker: String(speaker) });
    const queryRes = await fetch(`${this.#url}/audio_query?${params}`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    if (!queryRes.ok) throw new Error(`AivisSpeech audio_query が失敗しました (${queryRes.status})`);
    const audioQuery = (await queryRes.json()) as { speedScale: number };
    audioQuery.speedScale = this.#speedScale;

    const synthRes = await fetch(`${this.#url}/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(audioQuery),
      signal: AbortSignal.timeout(150_000),
    });
    if (!synthRes.ok) throw new Error(`AivisSpeech synthesis が失敗しました (${synthRes.status})`);
    return Buffer.from(await synthRes.arrayBuffer());
  }

  async #play(wav: Buffer, gen: number): Promise<void> {
    if (!this.#tmpDir) this.#tmpDir = await mkdtemp(join(tmpdir(), 'talkingclaw-'));
    const path = join(this.#tmpDir, `${this.#fileSeq++}.wav`);
    await writeFile(path, wav);
    if (gen !== this.#generation) return;

    await new Promise<void>((resolve) => {
      const player = spawn('afplay', [path], { stdio: 'ignore' });
      this.#player = player;
      player.on('close', () => {
        if (this.#player === player) this.#player = null;
        resolve();
      });
      player.on('error', () => resolve());
    });
  }
}

// 読み上げに不向きな記号・コードを落とす(persona 側でも禁止しているが防御)
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, 'コードは画面のほうを見てね。')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*#>_~|]/g, '')
    .trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。．！？!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
