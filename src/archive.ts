// 会話ログのアーカイブ(セッション単位で保存し、後から一覧・参照できるようにする)。
// transcript*.jsonl(会話ログの正、W8-1)を切り詰めずに残したまま、「前回の区切り以降に増えた分」を
// ~/.talkingclaw/archives/ へ複製保存する薄い機構。区切り = daemon の起動〜終了(部屋を閉じた時)、
// または一定期間ごと。room.ts の channel 構成(部屋分割)に依存しないよう、stateDir 直下の
// transcript*.jsonl を動的に列挙して扱う(channel が増減しても本ファイルの変更は不要)。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const stateDir = join(homedir(), '.talkingclaw');
const ARCHIVE_DIR = join(stateDir, 'archives');
const ARCHIVE_INDEX = join(ARCHIVE_DIR, 'index.jsonl');
const MARKERS_PATH = join(ARCHIVE_DIR, 'markers.json');

export type ArchiveEntry = {
  archivedAt: string; bootId: string; reason: string; source: string;
  startedAt: string; endedAt: string; file: string; lines: number;
};

function readMarkers(): Record<string, number> {
  try { return JSON.parse(readFileSync(MARKERS_PATH, 'utf8')); } catch { return {}; }
}
function writeMarkers(m: Record<string, number>): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(MARKERS_PATH, JSON.stringify(m), { mode: 0o600 });
}
function readLines(path: string): string[] {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
function transcriptFiles(): string[] {
  try { return readdirSync(stateDir).filter((f) => f.startsWith('transcript') && f.endsWith('.jsonl')); } catch { return []; }
}

// daemon 起動時に呼ぶ: これ以前の行(前セッション以前の分)を今回のアーカイブ対象から外す基準点を記録する
export function markArchiveBaseline(): void {
  const markers = readMarkers();
  for (const f of transcriptFiles()) markers[f] = readLines(join(stateDir, f)).length;
  writeMarkers(markers);
}

// 各 transcript*.jsonl の「前回区切り以降」を archives/ へ複製保存し、index に記録する
export function archiveSession(bootId: string, reason: string): ArchiveEntry[] {
  const markers = readMarkers();
  const results: ArchiveEntry[] = [];
  for (const f of transcriptFiles()) {
    const all = readLines(join(stateDir, f));
    const slice = all.slice(markers[f] ?? 0);
    if (slice.length === 0) continue;
    try {
      mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
      const first = JSON.parse(slice[0]) as { at: string };
      const last = JSON.parse(slice[slice.length - 1]) as { at: string };
      const archFile = `${first.at.replace(/[:.]/g, '-')}_${f.replace(/\.jsonl$/, '')}_${bootId.slice(0, 8)}.jsonl`;
      writeFileSync(join(ARCHIVE_DIR, archFile), slice.join('\n') + '\n', { mode: 0o600 });
      const entry: ArchiveEntry = {
        archivedAt: new Date().toISOString(), bootId, reason, source: f,
        startedAt: first.at, endedAt: last.at, file: archFile, lines: slice.length,
      };
      appendFileSync(ARCHIVE_INDEX, JSON.stringify(entry) + '\n', { mode: 0o600 });
      results.push(entry);
      markers[f] = all.length;
    } catch (e) {
      console.error('archive 失敗:', (e as Error).message);
    }
  }
  if (results.length > 0) writeMarkers(markers);
  return results;
}

export function archiveIndexTail(limit: number): ArchiveEntry[] {
  try {
    const all = readFileSync(ARCHIVE_INDEX, 'utf8').trim().split('\n');
    return all.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// file は archiveSession が生成した basename のみ許可(path traversal 防止)
export function archiveRead(file: string): { at: string; who: string; text: string }[] | null {
  if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(file)) return null;
  try {
    return readFileSync(join(ARCHIVE_DIR, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}
