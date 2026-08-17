// 伝言の受け口(PBI-002)。EventStore や room の内部を直接知らない大きな 1 部品。
// 部屋側の操作は全部 DI で受ける — 本番 mount(PBI-003)では room.ts が adapter を注入し、
// 検証では fake を注入して隔離実行する。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ページに見せる 1 行。id は memo-log 内で単調増加(= polling の cursor)。
export type MemoEntry = {
  id: number;
  at: string;
  // intent = submit 前の write-ahead 行(P2 002-F1: crash window の証跡。ページには出さない)
  kind: 'memo' | 'reply' | 'note' | 'report' | 'intent';
  text: string;
  name?: string;          // 話者(memo なら送信者の identity、reply/report なら agent 名)
  clientMessageId?: string;
  turnId?: string;
  sourceTurnId?: string;  // report がどの伝言(turn)への報告か
};

export type MemoDeps = {
  // 既存 userSpeech と同じ routing/permission/consult を通す約束の口(channel=work 固定)。
  // dedup=true は「この呼び出しは新しい side effect(user_speech / Brain / OfficeTask)を作っていない」
  // = adapter 側の永続台帳に当たった、という意味(裁定 2026-08-06 17:08)。memo 確定行の有無とは別軸。
  submit: (input: { text: string; clientMessageId: string }) => Promise<{ turnId: string; dedup?: boolean }>;
  // 部屋の返答・実況・作業報告の購読(adapter が MemoEntry の形に正規化して流す)
  read: { subscribe(cb: (e: Omit<MemoEntry, 'id' | 'at'> & { at?: string }) => void): () => void };
  recordMetric: (m: { kind: string; turnId: string; path: 'memo'; ms: number }) => void;
  identity: (req: IncomingMessage) => string | null;
  logPath?: string;   // 既定 ~/.talkingclaw/memo-log.jsonl
  pagePath?: string;  // 既定 ../public/memo.html
};

const TEXT_MAX = 4_000;
const BODY_MAX = 64 * 1024;
const PAGE_MAX_ENTRIES = 200;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function createMemoHandler(deps: MemoDeps) {
  const logPath = deps.logPath ?? join(homedir(), '.talkingclaw', 'memo-log.jsonl');
  const pagePath = deps.pagePath ?? fileURLToPath(new URL('../public/memo.html', import.meta.url));

  // --- 永続ログの復元(dedupe 台帳ごと。台帳の寿命 = ログの寿命) ---
  const entries: MemoEntry[] = [];
  const ledger = new Map<string, { turnId: string; messageId: number; text: string }>();
  let seq = 0;
  try {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as MemoEntry;
        if (typeof e.id !== 'number' || typeof e.text !== 'string') continue;
        entries.push(e);
        seq = Math.max(seq, e.id);
        if (e.kind === 'memo' && e.clientMessageId && e.turnId) {
          ledger.set(e.clientMessageId, { turnId: e.turnId, messageId: e.id, text: e.text });
        }
      } catch { /* 壊れた行は飛ばす(残りは生かす) */ }
    }
  } catch { /* ログ無し = 初回 */ }

  function append(e: Omit<MemoEntry, 'id' | 'at'> & { at?: string }): MemoEntry {
    const row: MemoEntry = { ...e, id: ++seq, at: e.at ?? new Date().toISOString() };
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, JSON.stringify(row) + '\n', { mode: 0o600 });
    entries.push(row);
    return row;
  }

  // 部屋からの返答・実況・報告を永続タイムラインへ
  deps.read.subscribe((e) => {
    if (!e || typeof e.text !== 'string' || !e.text.trim()) return;
    if (e.kind !== 'reply' && e.kind !== 'note' && e.kind !== 'report') return;
    append(e);
  });

  // 同一 clientMessageId の並行 POST は同じ Promise を共有する(二重発注防止の 2 層目)。
  // text も持つ — 並行の別内容(G2-F1)は Promise を共有せず 409 で落とす
  const inflight = new Map<string, { text: string; p: Promise<{ turnId: string; messageId: number; dedup: boolean }> }>();

  async function say(text: string, clientMessageId: string): Promise<{ turnId: string; messageId: number; dedup: boolean }> {
    const hit = ledger.get(clientMessageId);
    if (hit) {
      // P2 002-F1: 同じ id で別内容は別の依頼 — 既存 id を成功として返さない
      if (hit.text !== text) throw Object.assign(new Error('同じ clientMessageId が別の内容で使われています'), { status: 409 });
      return { turnId: hit.turnId, messageId: hit.messageId, dedup: true };
    }
    const running = inflight.get(clientMessageId);
    if (running) {
      if (running.text !== text) throw Object.assign(new Error('同じ clientMessageId が別の内容で使われています'), { status: 409 });
      return { ...(await running.p), dedup: true };
    }
    const p = (async () => {
      // write-ahead: submit の副作用より先に「試みた」証跡を永続化する(crash window の観測点)。
      // submit 成功後・memo 行前に落ちた場合の突合は room 側 adapter の永続 dedupe が担う(PBI-003 の契約)
      append({ kind: 'intent', text, clientMessageId });
      const submitted = await deps.submit({ text, clientMessageId });
      const row = append({ kind: 'memo', text, clientMessageId, turnId: submitted.turnId, name: undefined });
      ledger.set(clientMessageId, { turnId: submitted.turnId, messageId: row.id, text });
      deps.recordMetric({ kind: 'turn_created', turnId: submitted.turnId, path: 'memo', ms: 0 });
      // 初回経路でも、adapter の永続台帳に当たっていれば dedup は true(裁定 17:08)。
      // memo 行は今この呼び出しが補完したが、submit の副作用は再実行していない
      return { turnId: submitted.turnId, messageId: row.id, dedup: submitted.dedup === true };
    })();
    inflight.set(clientMessageId, { text, p });
    try {
      return await p;
    } finally {
      inflight.delete(clientMessageId);
    }
  }

  function json(res: ServerResponse, code: number, body: object): void {
    res.writeHead(code, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
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

  // 自分の path なら処理して true。それ以外は false(room 側の分岐が続きを処理)。
  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string, searchParams: URLSearchParams): Promise<boolean> {
    if (req.method === 'GET' && pathname === '/memo') {
      // G2-F3: identity は HTML に raw で入れない — JSON リテラル(< を < 化)として注入し、
      // ページ側は textContent で表示する
      const idJson = JSON.stringify(deps.identity(req) ?? '').replace(/</g, '\\u003c');
      // 関数置換 — 文字列置換だと idJson 内の $& 等が replacement token として展開される(G2-F4)
      const html = (await readFile(pagePath, 'utf8')).replace('"__MEMO_USER_JSON__"', () => idJson);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
      });
      res.end(html);
      return true;
    }

    if (req.method === 'POST' && pathname === '/memo/api/say') {
      let raw: string | null;
      try {
        raw = await readBody(req);
      } catch {
        return true; // client 切断 — 応答先が居ない
      }
      if (raw === null) return json(res, 413, { error: '本文が大きすぎます' }), true;
      let body: { text?: unknown; clientMessageId?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'JSON が壊れています' }), true;
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const cid = typeof body.clientMessageId === 'string' ? body.clientMessageId : '';
      if (!text) return json(res, 400, { error: '伝言が空です' }), true;
      if (text.length > TEXT_MAX) return json(res, 400, { error: `伝言が長すぎます(上限 ${TEXT_MAX} 文字)` }), true;
      if (!CLIENT_ID_RE.test(cid)) return json(res, 400, { error: 'clientMessageId が不正です' }), true;
      try {
        const out = await say(text, cid);
        return json(res, 200, out), true;
      } catch (e) {
        const status = (e as { status?: number }).status === 409 ? 409 : 502;
        return json(res, status, { error: status === 409 ? (e as Error).message : `部屋に届けられませんでした: ${(e as Error).message}` }), true;
      }
    }

    if (req.method === 'GET' && pathname === '/memo/api/log') {
      const after = Number(searchParams.get('after') ?? 0);
      const from = Number.isFinite(after) && after > 0 ? after : 0;
      const slice = entries.filter((e) => e.id > from && e.kind !== 'intent').slice(0, PAGE_MAX_ENTRIES);
      return json(res, 200, { entries: slice, cursor: slice.length > 0 ? slice[slice.length - 1].id : seq }), true;
    }

    return false;
  }

  return { handle, say, entryCount: () => entries.length };
}
