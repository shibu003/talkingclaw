// PBI-035: ゲストの鍵。**「入れる」と「何でもできる」を分ける**ための小さな 1 部品。
//
// いまの部屋は token が 1 つで、持っていれば全部の口が叩ける（会話ログ・プロジェクト・ファイル・
// 設定・声の選択まで）。人を招くならそこを割る必要がある。ここが持つのは 2 つだけ:
//   1. **誰がゲストか**（発行・期限・取り消し・照合）
//   2. **ゲストが叩いてよい口はどれか**（allowlist。**列挙で持つ** —— 「危ないものを弾く」形にすると、
//      新しい口を足した人が忘れた瞬間に穴が開く。**足したものは既定で通らない**方が安全）
//
// 依存ゼロ・保存だけが I/O。例外は外に出さない（ゲストの都合で部屋を止めない）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type Guest = {
  id: string;
  token: string;
  name: string;
  channel: string;      // この部屋しか見えない
  createdAt: string;
  expiresAt: string;
  revoked?: boolean;
};

export type GuestFile = { guests: Guest[] };

const LIMIT = 20;                       // 同時に持てるゲストの上限（古い順に落とす）
const DEFAULT_HOURS = 12;

/**
 * ゲストが叩いてよい口。**遊ぶ・話す・見る**だけ。
 * ここに無いものは 403 —— 新しい口を足しても**既定で通らない**（忘れても穴が開かない）。
 */
export function guestAllows(method: string, path: string): boolean {
  const m = (method ?? '').toUpperCase();
  if (m === 'GET') {
    const exact = ['/', '/index.html', '/room.js', '/avatar.js', '/health',
      '/events', '/participants', '/channels', '/persona', '/avatars', '/motions', '/game'];
    if (exact.includes(path)) return true;
    // 静的な素材だけ。**`..` を含む物は絶対に通さない**（この関数の外でも弾いているが、ここでも見る）
    if (path.includes('..')) return false;
    return ['/vendor/', '/audio/', '/avatars/', '/motions/', '/vad/'].some((p) => path.startsWith(p));
  }
  if (m === 'POST') {
    // 話す・遊ぶ・再生の後始末だけ。**声の選択も設定も語彙も渡さない**（ホストのものだから）
    return ['/chat', '/game', '/played', '/speech-state', '/metrics'].includes(path);
  }
  return false;
}

export function guestsPath(): string {
  return join(homedir(), '.talkingclaw', 'guests.json');
}

export function loadGuests(): GuestFile {
  try {
    const raw = JSON.parse(readFileSync(guestsPath(), 'utf8')) as Partial<GuestFile>;
    const list = Array.isArray(raw.guests) ? raw.guests : [];
    return { guests: list.filter((g): g is Guest => !!g && typeof g.token === 'string' && typeof g.id === 'string') };
  } catch {
    return { guests: [] };            // 壊れていても部屋は止めない
  }
}

export function saveGuests(file: GuestFile): void {
  try {
    const dir = join(homedir(), '.talkingclaw');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = guestsPath() + '.tmp';
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, guestsPath());    // 途中で落ちても壊れた JSON を残さない
  } catch { /* 保存に失敗しても会話は続ける */ }
}

/** 招く。token はここでしか作らない（呼び側が作らない） */
export function issueGuest(
  file: GuestFile,
  opts: { name: string; channel: string; hours?: number; now?: number; token?: string },
): { file: GuestFile; guest: Guest } {
  const now = opts.now ?? Date.now();
  const hours = Math.max(1, Math.min(24 * 7, opts.hours ?? DEFAULT_HOURS));
  const guest: Guest = {
    id: `g${now.toString(36)}${randomBytes(3).toString('hex')}`,
    token: opts.token ?? randomBytes(24).toString('base64url'),
    name: (opts.name ?? '').trim().slice(0, 24) || 'ゲスト',
    channel: opts.channel,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3600_000).toISOString(),
  };
  const guests = [guest, ...file.guests].slice(0, LIMIT);
  return { file: { guests }, guest };
}

export function revokeGuest(file: GuestFile, id: string): GuestFile {
  return { guests: file.guests.map((g) => (g.id === id ? { ...g, revoked: true } : g)) };
}

/** token → ゲスト。取り消し済み・期限切れは **null**（= 401） */
export function findGuest(file: GuestFile, token: string, now = Date.now()): Guest | null {
  if (!token) return null;
  const g = file.guests.find((x) => x.token === token);
  if (!g || g.revoked) return null;
  if (Date.parse(g.expiresAt) <= now) return null;
  return g;
}

/** 画面に出す形（**token は出さない** —— 一覧に鍵を並べない） */
export function guestSummary(file: GuestFile, now = Date.now()): {
  id: string; name: string; channel: string; expiresAt: string; active: boolean;
}[] {
  return file.guests.map((g) => ({
    id: g.id, name: g.name, channel: g.channel, expiresAt: g.expiresAt,
    active: !g.revoked && Date.parse(g.expiresAt) > now,
  }));
}
