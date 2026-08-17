// PBI-014: herdr(端末ワークスペース管理)への thin adapter。
// herdr は socket API を CLI で全部開けているので、ここでは再実装せず CLI を叩いて JSON を読むだけにする。
// 安全側の縛り(AC-5): 書込み(起動・指示投入)は「部屋が起こした agent」の台帳の中だけ。
// ユーザーが自分で立てたペインは読み取りのみ —— 規則ではなく、この class の中で実装として縛る。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type FleetAgent = {
  pane: string; workspace: string; name: string | null;
  status: string; cwd: string; title: string; mine: boolean;
};
export type FleetView = { at: string; agents: FleetAgent[]; error?: string };
// terminal はペインの中身の識別子。pane_id は閉じると再利用されるので、これが無いと
// 「昔ここに立てた子」の台帳が、後から人が開いた別のペインを自分の子だと誤認する(AC-5 の穴)
type Owned = Record<string, { name: string; at: string; terminal?: string }>;
// この repo は strict:false なので `!r.ok` では union が絞られない(error に触ると型エラーになる)。
// 絞り込みは `'error' in r` で行う —— 効く形はこちらだけ
type Cli = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: string };

const OWNED_PATH = join(homedir(), '.talkingclaw', 'herdr-owned.json');
// 部屋は LaunchDaemon 等 env の薄いところから起動されることがある(EP-003 の不確実性表)。
// そこでも届くよう、socket と実行ファイルの既定は自分で持つ
const DEFAULT_SOCKET = join(homedir(), '.config', 'herdr', 'herdr.sock');
// HERDR_BIN を明示したら、それ「だけ」を使う。見つからない時に本物へ落ちると、
// 検査のつもりで実際の艦隊を触ってしまう(自傷)
const BIN_CANDIDATES = process.env.HERDR_BIN
  ? [process.env.HERDR_BIN]
  : ['herdr', join(homedir(), '.local', 'bin', 'herdr')];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HerdrBridge {
  #owned: Owned = {};
  #bin: string | null = null;

  constructor() {
    try { this.#owned = JSON.parse(readFileSync(OWNED_PATH, 'utf8')) as Owned; } catch { this.#owned = {}; }
  }

  #save(): void {
    try {
      mkdirSync(join(homedir(), '.talkingclaw'), { recursive: true, mode: 0o700 });
      writeFileSync(OWNED_PATH, JSON.stringify(this.#owned, null, 1), { mode: 0o600 });
    } catch { /* 台帳が書けなくても今の操作は続ける(次回起動で忘れるだけ) */ }
  }

  // herdr CLI は成功なら exit 0 + stdout、失敗なら exit 1 + JSON を **stderr** に出す(2026-08-08 実測)。
  // stdout だけ見ていると失敗の理由(server_not_running / agent_pane_busy 等)を全部取り落として
  // 「答えなかった」に丸まるので、両方から JSON を拾う(AC-6)
  async #cli(args: string[], timeoutMs = 15_000, raw = false): Promise<Cli> {
    const env = { ...process.env, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH ?? DEFAULT_SOCKET };
    const bins = this.#bin ? [this.#bin] : BIN_CANDIDATES;
    // 断り文句を声で言える日本語に畳む。code は呼び出し側の分岐(busy の待ち直し)のために残す
    const refused = (body: string, fallback: string): Cli => {
      let err: { code?: string; message?: string } | undefined;
      try { err = (JSON.parse(body) as { error?: { code?: string; message?: string } }).error; } catch { /* JSON ですらない */ }
      if (!err) return { ok: false, error: `${fallback}: ${body.slice(0, 120)}` };
      return { ok: false, code: err.code, error: err.code === 'server_not_running'
        ? 'herdr のサーバが動いてないみたい。herdr を立ち上げてね'
        : `herdr が断った: ${err.message ?? err.code ?? '理由不明'}` };
    };
    let lastEnoent = '';
    for (const bin of bins) {
      let stdout: string;
      try {
        ({ stdout } = await execFileP(bin, args, { env, timeout: timeoutMs, maxBuffer: 8_000_000 }));
      } catch (error) {
        const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
        if (e.code === 'ENOENT') { lastEnoent = 'herdr のコマンドが見つからないよ。herdr が入っているか確かめてね'; continue; }
        if (e.killed) return { ok: false, error: 'herdr の応答が返ってこなかった(時間切れ)' };
        this.#bin = bin;
        return refused(e.stderr || e.stdout || '', 'herdr が答えなかった');
      }
      this.#bin = bin;
      // agent read --format text だけは JSON ではなく画面の生テキストが返る(2026-08-08 実測)
      if (raw) return { ok: true, data: { text: stdout } };
      let data: Record<string, unknown>;
      try { data = JSON.parse(stdout) as Record<string, unknown>; } catch { return { ok: false, error: `herdr の返事が読めなかった: ${stdout.slice(0, 120)}` }; }
      if (data.error) return refused(stdout, 'herdr の返事が読めなかった');
      return { ok: true, data };
    }
    return { ok: false, error: lastEnoent || 'herdr を実行できなかった' };
  }

  // 艦隊の実物一覧。台帳と突き合わせて mine を立て、消えたペインは台帳から掃除する(AC-1)
  async list(): Promise<FleetView> {
    const at = new Date().toISOString();
    const r = await this.#cli(['agent', 'list']);
    if ('error' in r) return { at, agents: [], error: r.error };
    const raw = ((r.data.result as { agents?: Record<string, unknown>[] })?.agents ?? []);
    // 台帳はここで掃除しない。一瞬 list に出ないだけ(再起動中・取りこぼし)で消すと、
    // 生きている自分の子への指示が二度と通らなくなる。誤認は terminal の照合で防ぐ
    const agents: FleetAgent[] = raw.map((a) => {
      const pane = String(a.pane_id ?? '');
      const owned = this.#owned[pane];
      return {
        pane,
        workspace: String(a.workspace_id ?? ''),
        name: (a.name as string) ?? owned?.name ?? null,
        status: String(a.agent_status ?? 'unknown'),
        cwd: String(a.foreground_cwd ?? a.cwd ?? ''),
        title: String(a.terminal_title_stripped ?? ''),
        mine: Boolean(owned) && (!owned.terminal || owned.terminal === String(a.terminal_id ?? '')),
      };
    });
    return { at, agents };
  }

  // 名前でもペイン ID でも指せるようにする(声で「worker-x」と言われる方が普通なので)
  #paneOf(target: string, view: FleetView): string | null {
    const t = target.trim();
    const hit = view.agents.find((a) => a.pane === t || (a.name && a.name === t));
    return hit?.pane ?? null;
  }

  // AC-2: 指定ワークスペースのペインを右に割って、そこに agent を立てる。
  // --no-focus: ユーザーが見ている画面を勝手に切り替えない(CLAUDE.md 2 章)
  async start(opts: { name: string; workspace?: string; cwd?: string }): Promise<{ ok: true; pane: string } | { ok: false; error: string }> {
    const name = opts.name.trim();
    // 名前は CLI の 1 つ目の positional に入る。`-` で始まるとオプションとして食われる
    if (!/^[A-Za-z0-9][\w.-]{0,23}$/.test(name)) return { ok: false, error: '名前は英数字で始まる 24 文字までにしてね' };
    const view = await this.list();
    if (view.error) return { ok: false, error: view.error };
    if (view.agents.some((a) => a.name === name)) return { ok: false, error: `「${name}」はもう居るよ。別の名前にしてね` };

    // 割る先は agent list ではなく **pane list** から選ぶ。agent list は「agent が動いているペイン」
    // しか返さないので、agent が 1 人も居ない workspace や起動直後だと永久に立てられなくなる
    const listed = await this.#cli(['pane', 'list']);
    if ('error' in listed) return { ok: false, error: listed.error };
    const panes = ((listed.data.result as { panes?: Record<string, unknown>[] })?.panes ?? []);
    const ws = opts.workspace?.trim();
    const pool = ws ? panes.filter((p) => String(p.workspace_id) === ws) : panes;
    if (pool.length === 0) return { ok: false, error: ws ? `${ws} に分割できるペインが見つからないよ` : 'herdr にペインが 1 つも無いよ' };
    const base = String(pool[pool.length - 1].pane_id); // 一番後ろを割る(先頭 = ユーザーが作業中のことが多い)

    const split = await this.#cli(['pane', 'split', base, '--direction', 'right', '--no-focus',
      ...(opts.cwd ? ['--cwd', opts.cwd] : [])]);
    if ('error' in split) return { ok: false, error: split.error };
    const result = split.data.result as { pane?: { pane_id?: string }; pane_id?: string } | undefined;
    const pane = result?.pane?.pane_id ?? result?.pane_id;
    if (!pane) return { ok: false, error: 'ペインは割れたけど場所が分からなかった。画面で確かめてね' };

    // 割った直後のペインは shell を起動している最中で、数十 ms だけ agent_pane_busy を返す
    // (2026-08-08 実測: 手で叩くと間が空いて通り、続けて叩くと落ちる)。一拍おいて数回まで待つ
    let started = await this.#cli(['agent', 'start', name, '--kind', 'claude', '--pane', pane], 60_000);
    for (let i = 0; i < 3 && 'code' in started && started.code === 'agent_pane_busy'; i++) {
      await sleep(700);
      started = await this.#cli(['agent', 'start', name, '--kind', 'claude', '--pane', pane], 60_000);
    }
    if ('error' in started) {
      await this.#cli(['pane', 'close', pane]); // 立てられなかった空ペインは片付ける(#cli は投げない)
      return { ok: false, error: started.error };
    }
    const agent = (started.data.result as { agent?: { terminal_id?: string } })?.agent;
    this.#owned[pane] = { name, at: new Date().toISOString(), terminal: agent?.terminal_id };
    // 台帳は掃除しないので、古い順に上限を切る(pane が消えた分は照合で弾かれるだけ)
    const keys = Object.keys(this.#owned);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete this.#owned[k];
    this.#save();
    return { ok: true, pane };
  }

  // 立ち上げたばかりの claude は起動画面の途中で、prompt を投げても入力欄に入らず消える
  // (2026-08-08 実測: 送った直後の画面は空のままだった)。herdr が interactive_ready を立てるまで待つ
  async #ready(pane: string, waitMs = Number(process.env.HERDR_READY_WAIT_MS ?? 20_000)): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const g = await this.#cli(['agent', 'get', pane]);
      const agent = 'data' in g ? (g.data.result as { agent?: { interactive_ready?: boolean } })?.agent : null;
      if (agent?.interactive_ready) return true;
      if (Date.now() >= deadline) return false;
      await sleep(1000);
    }
  }

  // AC-3: 投入したあと read で反映を確かめる。「送ったつもり」で渡したと言わないための裏取り
  async prompt(target: string, text: string): Promise<
    { ok: true; pane: string; confirmed: boolean; status: string; tail: string } | { ok: false; error: string }
  > {
    const view = await this.list();
    if (view.error) return { ok: false, error: view.error };
    const pane = this.#paneOf(target, view);
    if (!pane) return { ok: false, error: `「${target}」という子は居ないよ` };
    if (!view.agents.find((a) => a.pane === pane)?.mine) { // 台帳 + terminal 照合(pane 再利用に騙されない)
      return { ok: false, error: `「${target}」は部屋が立てた子じゃないから、指示は送らないよ。様子を読むだけならできる` };
    }
    if (!await this.#ready(pane)) {
      return { ok: false, error: `「${target}」はまだ起動中で、指示を受け取れる状態じゃないみたい。少し待ってからもう一度` };
    }
    // 投入前の状態を控えておく。「working なら届いた」では、元から働いている相手に何を送っても
    // 「渡した」になってしまう(実測で踏んだ)。見るのは status の遷移と、画面に出た実文の 2 つだけ
    const wasWorking = view.agents.find((a) => a.pane === pane)?.status === 'working';
    const r = await this.#cli(['agent', 'prompt', pane, text], 30_000);
    if ('error' in r) return { ok: false, error: r.error };

    // 投入した文が相手の画面に出るまで数秒かかる(2026-08-08 実測: 1.5 秒後は空・6 秒後には出ていた)。
    // 1 回読んで諦めると、届いているのに毎回「分からない」と言う羽目になる — 出るまで数回見る
    const needle = text.replace(/\s+/g, ' ').trim().slice(0, 12);
    let echoed = false;
    let tail = '';
    for (let i = 0; i < 8 && !echoed; i++) {
      await sleep(1000);
      // pane は解決済みなので read() を通さない(通すと 1 回ごとに agent list が走る)
      const back = await this.#cli(['agent', 'read', pane, '--lines', '40', '--format', 'text'], 15_000, true);
      tail = 'data' in back ? String(back.data.text ?? '') : '';
      echoed = needle.length > 0 && tail.replace(/\s+/g, ' ').includes(needle);
    }
    const got = await this.#cli(['agent', 'get', pane]);
    const status = 'data' in got
      ? String((got.data.result as { agent?: { agent_status?: string } })?.agent?.agent_status ?? 'unknown')
      : 'unknown';
    return { ok: true, pane, status, confirmed: echoed || (!wasWorking && status === 'working'), tail: tail.slice(-400) };
  }

  // 読み取りは台帳の外(ユーザーのペイン)でもできる。ここが AC-5 の「読むだけ」の側
  async read(target: string, lines = 60): Promise<{ text: string; pane: string } | { error: string }> {
    const view = await this.list();
    if (view.error) return { error: view.error };
    const pane = this.#paneOf(target, view);
    if (!pane) return { error: `「${target}」という子は居ないよ` };
    const r = await this.#cli(['agent', 'read', pane, '--lines', String(Math.min(Math.max(lines, 1), 200)), '--format', 'text'], 15_000, true);
    if ('error' in r) return { error: r.error };
    return { text: String(r.data.text ?? ''), pane };
  }
}
