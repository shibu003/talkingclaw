// PBI-048: 起動前に環境を診断する。read-only — ファイルの存在確認だけで、
// 中身は読まない・エンジンや部屋のプロセスは起動/停止しない(project CLAUDE.md §4)。
// 図: docs/diagrams.md「9. doctor の判定順序」
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';

type Status = 'OK' | 'MISSING' | 'UNKNOWN';
interface Check { label: string; status: Status; missingHint?: string }

function nodeOk(version: string): boolean {
  const m = version.match(/^v?(\d+)\.(\d+)/);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 23 || (major === 23 && minor >= 6);
}

export function runChecks(): Check[] {
  return [
    {
      label: 'Chrome',
      status: existsSync('/Applications/Google Chrome.app') ? 'OK' : 'MISSING',
      missingHint: 'Chrome をインストール(音声認識・音声出力の画面は Chrome 専用)',
    },
    {
      label: 'Node',
      status: nodeOk(process.version) ? 'OK' : 'MISSING',
      missingHint: `Node.js >= 23.6 に上げる(現在 ${process.version})`,
    },
    {
      label: 'Claude Code login',
      status: existsSync(join(homedir(), '.claude', '.credentials.json')) ? 'OK' : 'MISSING',
      missingHint: '`claude` を起動してログインする(内蔵キャラ用)',
    },
    {
      label: 'AivisSpeech Engine',
      status: existsSync(config.tts.enginePath) ? 'OK' : 'MISSING',
      missingHint: 'README の Requirements 節を見て AivisSpeech Engine を engine/macOS-x64/ に展開する',
    },
    {
      label: 'Microphone permission',
      status: 'UNKNOWN',
      missingHint: 'ブラウザでしか判定できない — 部屋を開いて 🎤 ON を押した時に Chrome が聞いてくる',
    },
  ];
}

export function formatReport(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.label.length)) + 2;
  const lines = checks.map((c) => `${c.label.padEnd(width)}${c.status}`);
  const missing = checks.filter((c) => c.status !== 'OK');
  const next = missing.length
    ? ['', 'Next:', ...missing.map((c) => `  ${c.label}: ${c.missingHint}`)]
    : ['', 'これで動きます → npm run web (または npx -y github:shibu003/talkingclaw)'];
  return [...lines, ...next].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(formatReport(runChecks()));
}
