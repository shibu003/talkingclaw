#!/usr/bin/env node
// Entry point so the room can be started without cloning:
//   npx -y github:shibu003/talkingclaw          → the room (same as `npm run web`)
//   npx -y github:shibu003/talkingclaw cli      → the terminal client
// Everything else is delegated to the scripts in package.json, so there is one source of truth.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = {
  web: 'src/room.ts',
  cli: 'src/cli.ts',
  mcp: 'src/mcp.ts',
  smoke: 'src/smoke.ts',
};

const [cmd = 'web', ...rest] = process.argv.slice(2);

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`talkingclaw — a voice room for your coding agents

  talkingclaw [web]     start the room, then open http://localhost:3300 in Chrome (default)
  talkingclaw cli       join the same room from this terminal
  talkingclaw mcp       run the MCP proxy (this is what an agent CLI spawns; see README)
  talkingclaw smoke     non-interactive smoke test
  talkingclaw --help    this message

Requires Node >= 23.6 and, for sound, the AivisSpeech engine (see README).
Docs: https://github.com/shibu003/talkingclaw`);
  process.exit(0);
}

const target = TARGETS[cmd];
if (!target) {
  console.error(`talkingclaw: unknown command "${cmd}". Try --help.`);
  process.exit(2);
}

const child = spawn(process.execPath, [join(ROOT, target), ...rest], { stdio: 'inherit', cwd: ROOT });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
