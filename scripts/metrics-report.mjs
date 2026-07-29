// 6A: metrics.jsonl から S10 レポート(p50/p95・被覆・skip 率)を出す
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const rows = readFileSync(join(homedir(), '.talkingclaw', 'metrics.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ts = (r) => new Date(r.at).getTime();
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : null; };

// STT
const stt = rows.filter((r) => r.kind === 'stt_final_delay').map((r) => r.ms);
console.log(`STT final 遅延: n=${stt.length} p50=${pct(stt, 50)}ms p95=${pct(stt, 95)}ms`);

// turn 集計。
// turnId は T1 / T2 ... の連番で、部屋を再起動するとリセットされる。一方 metrics.jsonl は
// 複数セッション(複数日)ぶんが 1 本に積まれるので、turnId だけでグループ化すると
// 別セッションの turn_created と play_started がペアになる。
// (実測 2026-07-29: turnId は 80 種しかないのにイベント 1586 件、T1 に turn_created が 94 回。
//  その結果 初音 p50 が 5 分、p95 が 8.5 時間という測れていない値が出ていた)
// 時刻順に読み、同じ turnId の次の turn_created が来たらそこで区切る。
const sorted = [...rows].sort((a, b) => ts(a) - ts(b));
const openTurns = new Map();
const turns = [];
for (const r of sorted) {
  if (!r.turnId) continue;
  if (r.kind === 'turn_created') {
    const t = { id: r.turnId, t0: ts(r), events: [r] };
    openTurns.set(r.turnId, t);
    turns.push(t);
  } else {
    openTurns.get(r.turnId)?.events.push(r); // 対応する turn_created が無いものは測れない
  }
}
const ackLat = [], firstPlay = [], covered = [];
for (const t of turns) {
  const t0 = t.t0;
  const ackPlay = t.events.find((e) => e.kind === 'play_started' && e.filler === 'ack');
  if (ackPlay) ackLat.push(ts(ackPlay) - t0);
  const respPlay = t.events.find((e) => e.kind === 'play_started' && !e.filler);
  if (respPlay) firstPlay.push(ts(respPlay) - t0);
  const closed = t.events.find((e) => e.kind === 'turn_window_closed');
  if (closed) {
    const plays = t.events.filter((e) => e.kind === 'play_started' || e.kind === 'ack_emitted' || e.kind === 'filler_emitted')
      .map(ts).sort((a, b) => a - b);
    const span = [t0, ...plays, ts(closed)];
    let maxGap = 0;
    for (let i = 1; i < span.length; i++) maxGap = Math.max(maxGap, span[i] - span[i - 1]);
    covered.push(maxGap <= 6000);
  }
}
console.log(`相槌 latency(turn_created→ack play): n=${ackLat.length} p50=${pct(ackLat, 50)}ms p95=${pct(ackLat, 95)}ms`);
console.log(`本応答初音(turn_created→非 filler play): n=${firstPlay.length} p50=${pct(firstPlay, 50)}ms p95=${pct(firstPlay, 95)}ms`);
console.log(`filler 被覆率(閉窓 turn の 6s 超無音なし): ${covered.length ? Math.round(100 * covered.filter(Boolean).length / covered.length) + '%' : 'n/a'} (n=${covered.length})`);
const kinds = {};
for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
console.log('記録内訳:', kinds);
