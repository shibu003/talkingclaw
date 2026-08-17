// クロエの声をユーザーが画面から選ぶ受け口(PBI-008)。room の内部を直接知らない大きな 1 部品で、
// 部屋側の操作(合成・話者一覧・cooldown・commit 通知)は全部 DI で受ける — memo.ts と同じ形。
// 検証では fake を注入して隔離実行する。
//
// ここが持つ concern は「声の選択」ひとつ: 候補の取得(cache 3 状態)・試聴(課金の門)・
// 選択の確定(atomic persist)。3 つは同じ候補台帳(known)を共有するので 1 部品に閉じている。
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PreviewResult, VoiceSnapshot } from './voice.ts';

// ---- 凍結値(PBI-008 §2/§3)。数値は 1 箇所でだけ定義する ----
// 「実運用で 429 / 課金が出たら上限値だけを下げる」(G1 不確実性表)ため、下げる場所をここに一本化。
const PREVIEW_TEXT = 'こんにちは、クロエだよ。'; // server 固定。client が送った text は採用しない
const PAGE_SIZE = 20;
const SORT_BY = 'task_count';
// これ未満 = fresh(upstream 0)。既定 5 分。検査が stale を実時間 5 分待たずに測れるよう
// env で上書きできる — 未設定・不正値なら既定のままなので本番挙動は不変
const LIST_FRESH_MS = Number(process.env.VOICE_LIST_TTL_MS) > 0 ? Number(process.env.VOICE_LIST_TTL_MS) : 5 * 60_000;
const PREVIEW_CACHE_MS = 10 * 60_000; // 同一 candidate は Fish 1 回だけ
const PREVIEW_WINDOW_MS = 10 * 60_000;
const PREVIEW_MAX = 10;              // 異なる candidate を room 全体で 10 分 10 回
const BODY_MAX = 64 * 1024;
const TITLE_MAX = 80;                // remote metadata は信用しない: 長さで殴られないよう切る
const TAG_MAX = 24;
const TAGS_MAX = 6;
const LANGS_MAX = 4;
const MAX_PAGE = 50;                 // 1-origin。青天井の page_number を upstream へ渡さない

// 画面に出す候補。**この形だけを返す**(上流 JSON の他の field は 1 つも通さない = AC-3 allowlist)
export type VoiceCandidate = {
  provider: 'fish' | 'local';
  id: string;      // 'fish:<modelId>' / 'local:<speakerId>'
  title: string;
  tags: string[];
  languages: string[];
  selected: boolean;
};

// voice.json の中身(discriminated union + 単調増加 revision)。API key / token は 1 件も入れない
export type VoiceSelection =
  | { provider: 'fish'; id: string; title: string }
  | { provider: 'local'; speakerId: number; title: string };

export type VoiceSwitchDeps = {
  fish: { apiKey?: string; base?: string };
  // 試聴の合成(Voice.previewFish)。通常会話の cooldown を汚さない専用経路
  previewFish: (referenceId: string, text: string) => Promise<PreviewResult>;
  localSynth: (text: string, speakerId: number) => Promise<Buffer | null>;
  localSpeakers: () => Promise<{ speakerId: number; title: string }[]>;
  cloudCooldown: () => boolean;                 // PBI-007 の cooldown 中か(AC-9c)
  conversationBusy: () => string | null;        // 会話が音を出している理由。null = 空いている(AC-5)
  lastUsed: () => 'fish' | 'aivis-cloud' | 'local' | null; // 実際に鳴っている provider(AC-9d の二重表示)
  // persist が成功した後にだけ呼ばれる。pool 失効と次 turn への適用は呼び側の責任(AC-6)
  onCommit: (selection: VoiceSelection | null, revision: number) => void;
  now?: () => number;
  stateDir?: string;
};

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').slice(0, max);

export function createVoiceSwitch(deps: VoiceSwitchDeps) {
  const now = deps.now ?? (() => Date.now());
  const stateDir = deps.stateDir ?? join(homedir(), '.talkingclaw');
  const selectionPath = join(stateDir, 'voice.json');
  const walPath = join(stateDir, 'voice-preview.jsonl');

  // 一度でも画面に出した候補。preview / select はここからしか解決しない
  // (client が送った任意の id や URL を上流へ通さないための唯一の関門 = AC-3)
  const known = new Map<string, { provider: 'fish' | 'local'; refId: string; speakerId?: number; title: string }>();
  const cardMeta = new Map<string, { tags: string[]; languages: string[] }>();
  const listCache = new Map<string, { at: number; ids: string[]; hasMore: boolean }>();
  const listInflight = new Map<string, Promise<{ ids: string[]; hasMore: boolean } | null>>();
  // 検索条件ごとの終端ページ。has_more=false を見た後は、その先を upstream へ取りに行かない(AC-1)
  const lastPage = new Map<string, number>();
  const previewCache = new Map<string, { at: number; wav: Buffer }>();
  let previewChain: Promise<unknown> = Promise.resolve(); // 「preview 同時実行は 1」(AC-5)
  let selectChain: Promise<unknown> = Promise.resolve();  // select は到着順に直列化(AC-8)

  // ---- 試聴の台帳(WAL)。送信**前**に書く = crash しても消費が消えない(AC-4)----
  let attempts: number[] = [];
  try {
    for (const line of readFileSync(walPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const at = Number((JSON.parse(line) as { at?: unknown }).at);
        if (Number.isFinite(at)) attempts.push(at);
      } catch { /* 壊れた行は飛ばす(残りの消費は生かす — 上限が緩む方に倒さない) */ }
    }
  } catch { /* 台帳無し = 初回 */ }

  const windowed = (): number[] => (attempts = attempts.filter((t) => now() - t < PREVIEW_WINDOW_MS));

  // ---- 選択の復元。壊れていても起動は止めない(AC-8)----
  let selection: VoiceSelection | null = null;
  let revision = 0;
  try {
    const raw = JSON.parse(readFileSync(selectionPath, 'utf8')) as { version?: unknown; revision?: unknown; selection?: unknown };
    const parsed = parseSelection(raw?.selection);
    if (raw?.version !== 1 || !parsed) throw new Error('未知の schema か provider');
    selection = parsed;
    revision = Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0;
  } catch (e) {
    // ENOENT(= まだ選んでいない)は正常。それ以外だけ 1 行警告して既定へ落ちる
    if ((e as { code?: string }).code !== 'ENOENT') {
      console.error(`voice.json を読めないので PBI-007 の既定の声で起動する: ${(e as Error).message}`);
    }
  }

  function parseSelection(v: unknown): VoiceSelection | null {
    const s = v as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') return null;
    if (s.provider === 'fish' && typeof s.id === 'string' && s.id) {
      return { provider: 'fish', id: s.id, title: clip(s.title, TITLE_MAX) || s.id };
    }
    if (s.provider === 'local' && Number.isInteger(s.speakerId)) {
      return { provider: 'local', speakerId: s.speakerId as number, title: clip(s.title, TITLE_MAX) || String(s.speakerId) };
    }
    return null; // 未知 provider も壊れた形もここで null(= 既定へ fallback)
  }

  // 消えたローカル話者を掴んだままにしない。ただし engine が黙っている時に選択を捨てると
  // 「engine が落ちていただけ」でユーザーの選択が消えるので、**一覧が取れた時だけ**判定する(AC-8)。
  // 起動時にも 1 回走らせる — corrupt / 未知 schema / 未知 provider の 3 通りと同じく、
  // 「画面を開くまで警告が出ない」では起動時の 1 行にならない(worker-f 実測 F3)
  let localChecked = false;
  async function ensureLocalStillThere(): Promise<void> {
    const sel = selection;
    if (localChecked || sel?.provider !== 'local') return;
    const list = await deps.localSpeakers().catch(() => [] as { speakerId: number; title: string }[]);
    if (list.length === 0) return; // engine 不通 — 判定しない(選択は保持)
    localChecked = true;
    if (!list.some((s) => s.speakerId === sel.speakerId)) {
      console.error(`選ばれていたローカル話者 ${sel.speakerId} が見つからないので既定の声に戻す`);
      selection = null;
      deps.onCommit(null, revision);
    }
  }

  void ensureLocalStillThere(); // 起動時に 1 回(engine が答えなければ何もしない = 選択は保持)

  // ---- 外向きの読み口 ----
  // turn 生成時に読む確定値。null = 選択なし = PBI-007 の既定挙動(AC-11 で完全不変)
  function snapshot(): VoiceSnapshot | null {
    if (!selection) return null;
    return selection.provider === 'fish'
      ? { provider: 'fish', referenceId: selection.id }
      : { provider: 'local', speakerId: selection.speakerId };
  }

  // ---- 候補の取得(cache 3 状態 + single-flight)----
  // 検索条件(ページを除く)= 終端ページを覚える単位 / それに page を足したものが cache の単位
  function queryKey(q: { title: string; all: boolean }): string {
    return `${q.all ? '*' : 'ja'}|${q.title}`;
  }
  function cacheKey(q: { title: string; all: boolean; page: number }): string {
    return `${queryKey(q)}|${q.page}`;
  }

  async function fetchPage(q: { title: string; all: boolean; page: number }): Promise<{ ids: string[]; hasMore: boolean } | null> {
    // upstream へ渡すのは allowlist した key だけ。client の生 query は 1 つも素通ししない
    const params = new URLSearchParams({
      page_size: String(PAGE_SIZE),
      page_number: String(q.page), // 1-origin
      sort_by: SORT_BY,
    });
    if (!q.all) params.set('language', 'ja');
    if (q.title) params.set('title', q.title);
    const base = (deps.fish.base ?? 'https://api.fish.audio').replace(/\/+$/, '');
    const res = await fetch(`${base}/model?${params}`, {
      headers: { authorization: `Bearer ${deps.fish.apiKey ?? ''}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {}); // 上流 error body は読まない = 持ち出さない(AC-3)
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { items?: unknown[]; has_more?: unknown };
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      const it = raw as Record<string, unknown>;
      if (it?.dmca_taken_down === true) continue;              // takedown は出さない
      // 候補 id は **Fish の model id そのもの**。voice.json の id とも送信する reference_id とも
      // 同じ文字列にする(AC-7「reference_id が選択した id と exact 一致」を字義どおり満たす)。
      // ローカルだけ 'local:<speakerId>' の接頭辞を持つ — Fish の id は 32 桁 hex なので衝突しない。
      const id = clip(it?._id ?? it?.id, 128);
      if (!id || id.startsWith('local:') || seen.has(id)) continue; // ページ内の重複 id を落とす
      seen.add(id);
      known.set(id, { provider: 'fish', refId: id, title: clip(it?.title, TITLE_MAX) || id });
      ids.push(id);
      cardMeta.set(id, {
        tags: (Array.isArray(it?.tags) ? it.tags : []).slice(0, TAGS_MAX).map((t) => clip(t, TAG_MAX)).filter(Boolean),
        languages: (Array.isArray(it?.languages) ? it.languages : []).slice(0, LANGS_MAX).map((t) => clip(t, 12)).filter(Boolean),
      });
    }
    return { ids, hasMore: data.has_more === true };
  }

  // fresh(<5 分)= upstream 0 / stale(>=5 分・保持は捨てない)= 再取得し失敗なら stale を出す /
  // 無し = 再取得し失敗なら local だけ。いずれも部屋は沈黙しない(AC-2)
  async function candidatesFor(q: { title: string; all: boolean; page: number }): Promise<{ ids: string[]; hasMore: boolean; stale: boolean; error: string | null }> {
    const key = cacheKey(q);
    const hit = listCache.get(key);
    if (hit && now() - hit.at < LIST_FRESH_MS) return { ids: hit.ids, hasMore: hit.hasMore, stale: false, error: null };
    // 終端より先は「無い」と分かっている。upstream を 1 本も叩かない(AC-1: has_more=false で止める)
    const end = lastPage.get(queryKey(q));
    if (end !== undefined && q.page > end) return { ids: [], hasMore: false, stale: false, error: null };
    if (!deps.fish.apiKey) {
      return { ids: hit?.ids ?? [], hasMore: hit?.hasMore ?? false, stale: !!hit, error: 'Fish のキーが無いので公開ボイスは出せない(ローカルの声は選べる)' };
    }
    let running = listInflight.get(key);
    if (!running) {
      running = fetchPage(q).finally(() => { listInflight.delete(key); });
      listInflight.set(key, running);
    }
    try {
      const page = await running;
      if (page) {
        listCache.set(key, { at: now(), ids: page.ids, hasMore: page.hasMore });
        if (!page.hasMore) lastPage.set(queryKey(q), q.page); // ここが終端
      }
      return { ids: page?.ids ?? [], hasMore: page?.hasMore ?? false, stale: false, error: null };
    } catch (e) {
      const why = `公開ボイスの一覧を取れなかった(${(e as Error).message})`;
      // 保持している stale は捨てない。無ければローカルだけで続ける
      return hit
        ? { ids: hit.ids, hasMore: hit.hasMore, stale: true, error: why }
        : { ids: [], hasMore: false, stale: false, error: why };
    }
  }

  async function localCandidates(): Promise<string[]> {
    const list = await deps.localSpeakers().catch(() => [] as { speakerId: number; title: string }[]);
    const ids: string[] = [];
    for (const s of list) {
      const id = `local:${s.speakerId}`;
      known.set(id, { provider: 'local', refId: id, speakerId: s.speakerId, title: clip(s.title, TITLE_MAX) || id });
      cardMeta.set(id, { tags: ['ローカル'], languages: ['ja'] });
      ids.push(id);
    }
    return ids;
  }

  function toCard(id: string): VoiceCandidate | null {
    const k = known.get(id);
    if (!k) return null;
    const meta = cardMeta.get(id) ?? { tags: [], languages: [] };
    return {
      provider: k.provider,
      id,
      title: k.title,
      tags: meta.tags,
      languages: meta.languages,
      selected: selection
        ? (selection.provider === 'fish' ? selection.id : `local:${selection.speakerId}`) === id
        : false,
    };
  }

  // ---- 選択の確定。persist の成功が commit point(AC-8)----
  function persist(next: VoiceSelection, nextRevision: number): void {
    mkdirSync(dirname(selectionPath), { recursive: true, mode: 0o700 });
    const tmp = `${selectionPath}.tmp`;
    const payload = JSON.stringify({ version: 1, revision: nextRevision, selection: next }, null, 1);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, payload);
      fsyncSync(fd); // rename の前に必ず落とす(電源断で空ファイルが残らない)
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, selectionPath); // ここを越えて初めて「決まった」
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* 消せなくても本流は止めない */ }
      throw e;
    }
  }

  // tsconfig の strict が off なので `{ok:true}|{ok:false}` の判別 union は narrow されない
  // (既存 baseline 16 件と同じ形の型エラーになる)。preview() と同じ「1 つの形」で返す。
  type SelectResult = { status: number; revision?: number; selection?: VoiceSelection; error?: string };

  async function select(candidateId: string): Promise<SelectResult> {
    const k = known.get(candidateId);
    if (!k) return { status: 404, error: 'その声は候補にない' };
    if (k.provider === 'fish') {
      if (!deps.fish.apiKey) return { status: 503, error: 'Fish のキーが無いので公開ボイスは選べない' };
      // AC-9c: PBI-007 の cooldown 中は Fish の選択を受けない(現在の選択は変えない)
      if (deps.cloudCooldown()) return { status: 503, error: 'いまクラウド合成を休ませている最中なので、少ししてからもう一度選んで' };
    }
    const next: VoiceSelection = k.provider === 'fish'
      ? { provider: 'fish', id: k.refId, title: k.title }
      : { provider: 'local', speakerId: k.speakerId!, title: k.title };
    const nextRevision = revision + 1;
    try {
      persist(next, nextRevision); // validate → temp 0600 write/fsync → atomic rename
    } catch (e) {
      // memory も現在の選択も queue も旧値のまま(画面だけ成功して再起動で戻る、を作らない)
      return { status: 500, error: `選択を保存できなかった: ${(e as Error).message}` };
    }
    selection = next;      // publish は persist の後
    revision = nextRevision;
    localChecked = k.provider === 'local'; // いま選んだ話者は実在する
    deps.onCommit(selection, revision);    // pool 失効・次 turn からの適用
    return { status: 200, revision, selection };
  }

  // ---- 試聴 ----
  async function preview(candidateId: string): Promise<{ status: number; wav?: Buffer; error?: string; retryAfterMs?: number }> {
    const k = known.get(candidateId);
    if (!k) return { status: 404, error: 'その声は候補にない' };
    const busy = deps.conversationBusy();
    if (busy) return { status: 409, error: busy }; // Fish へは 1 リクエストも出さない(AC-5)

    // ローカル話者の試聴は Fish を使わない = 課金の門(上限・台帳)も通さない
    if (k.provider === 'local') {
      const wav = await deps.localSynth(PREVIEW_TEXT, k.speakerId!).catch(() => null);
      return wav ? { status: 200, wav } : { status: 502, error: 'ローカル合成で試聴を作れなかった' };
    }

    const cached = previewCache.get(candidateId);
    if (cached && now() - cached.at < PREVIEW_CACHE_MS) return { status: 200, wav: cached.wav }; // Fish 0 回

    const used = windowed();
    if (used.length >= PREVIEW_MAX) {
      const retryAfterMs = Math.max(0, used[0] + PREVIEW_WINDOW_MS - now());
      return { status: 429, error: `試聴が続いたので少し休ませて(10 分に ${PREVIEW_MAX} 回まで)`, retryAfterMs };
    }

    // write-ahead: 送信**前**に永続化する。ここが書けないなら送らない(AC-4)
    const at = now();
    try {
      mkdirSync(dirname(walPath), { recursive: true, mode: 0o700 });
      appendFileSync(walPath, JSON.stringify({ at, iso: new Date(at).toISOString(), candidateId }) + '\n', { mode: 0o600 });
    } catch (e) {
      return { status: 503, error: `試聴の台帳に書けなかったので送らなかった: ${(e as Error).message}` };
    }
    attempts.push(at);

    const r = await deps.previewFish(k.refId, PREVIEW_TEXT); // retry 0 / timeout 4s は Voice 側
    if (!r.wav) {
      // 失敗してもローカル音声は流さない(別の声を候補の声と誤認させない = AC-9b)
      return { status: r.status === 400 || r.status === 404 ? 404 : 502, error: `この声は試聴できなかった(${r.reason})` };
    }
    previewCache.set(candidateId, { at: now(), wav: r.wav });
    return { status: 200, wav: r.wav };
  }

  // ---- HTTP ----
  function json(res: ServerResponse, code: number, body: object): void {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<string | null> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_MAX) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // body は exact `{candidateId}` だけ。任意の text / model / URL は受けない(AC-3)
  async function readCandidateId(req: IncomingMessage): Promise<string | null> {
    const raw = await readBody(req).catch(() => null);
    if (raw === null) return null;
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const keys = Object.keys(body as object);
    if (keys.length !== 1 || keys[0] !== 'candidateId') return null;
    const id = (body as { candidateId: unknown }).candidateId;
    return typeof id === 'string' && id ? id : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string, searchParams: URLSearchParams): Promise<boolean> {
    if (req.method === 'GET' && pathname === '/voice/api/candidates') {
      void ensureLocalStillThere();
      const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(searchParams.get('page') ?? 1)) || 1));
      const q = { title: clip(searchParams.get('title') ?? '', TITLE_MAX).trim(), all: searchParams.get('all') === '1', page };
      const [locals, fish] = await Promise.all([localCandidates(), candidatesFor(q)]);
      // ローカル話者はページに依らず常に先頭に載せる。画面側は id で束ねるのでページを跨いでも重複しない
      const candidates = [...locals, ...fish.ids].map(toCard).filter((c): c is VoiceCandidate => c !== null);
      return json(res, 200, {
        candidates, hasMore: fish.hasMore, page, stale: fish.stale, error: fish.error,
        selection, revision, actual: deps.lastUsed(), previewLeft: Math.max(0, PREVIEW_MAX - windowed().length),
      }), true;
    }

    if (req.method === 'POST' && pathname === '/voice/api/preview') {
      const id = await readCandidateId(req);
      if (id === null) return json(res, 400, { error: 'body は candidateId だけ' }), true;
      const run = previewChain.then(() => preview(id), () => preview(id)); // 同時実行 1
      previewChain = run.catch(() => {});
      const out = await run;
      if (out.status !== 200 || !out.wav) {
        return json(res, out.status, { error: out.error ?? '試聴できなかった', ...(out.retryAfterMs !== undefined ? { retryAfterMs: out.retryAfterMs } : {}) }), true;
      }
      // ephemeral WAV。audioStore にも EventStore にも入れない(AC-5)
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(out.wav);
      return true;
    }

    if (req.method === 'POST' && pathname === '/voice/api/select') {
      const id = await readCandidateId(req);
      if (id === null) return json(res, 400, { error: 'body は candidateId だけ' }), true;
      const run = selectChain.then(() => select(id), () => select(id)); // 到着順に直列化
      selectChain = run.catch(() => {});
      const out = await run;
      if (out.status !== 200) return json(res, out.status, { error: out.error }), true;
      return json(res, 200, { ok: true, revision: out.revision, selection: out.selection }), true;
    }

    return false;
  }

  return {
    handle,
    snapshot,
    get selection() { return selection; },
    get revision() { return revision; },
    // 検査用の観測点(キーや上流本文は含めない)
    diag: () => ({ revision, selection, previewUsed: windowed().length, knownCount: known.size }),
  };
}
