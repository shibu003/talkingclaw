# talkingclaw — a voice room for your coding agents

[![check](https://github.com/shibu003/talkingclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/shibu003/talkingclaw/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Talk to your coding agents — and let them talk back, each in its own voice.**

talkingclaw is a local, open-source "voice room". Claude Code, Codex CLI, Gemini CLI and any other
MCP-capable coding agent can sit in the same room; you speak, they answer and narrate their work
out loud, each with a distinct (anime) voice. **No API keys** — it reuses the login of each CLI you
already have, a free local TTS engine and the browser's speech recognition.

- One agent in the room → a 1:1 voice conversation (*talkingclaw*).
- Several agents → address them by name (*talking orchestra*). No mode switch: the number of participants is the mode.
- A built-in agent, **Chloe** (Claude Agent SDK, inherits your Claude Code login), is always there. Anything not addressed to someone else goes to her.

日本語版 README → [README.ja.md](README.ja.md)

## Requirements (today)

- **macOS + Chrome** (speech recognition uses the Web Speech API; playback uses `afplay`).
  Linux / Windows support is a wanted contribution — see [issues tagged `platform`](https://github.com/shibu003/talkingclaw/issues?q=label%3Aplatform).
- **Node.js ≥ 23.6** (runs TypeScript directly, no build step).
- **[AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine/releases)** unpacked into `engine/macOS-x64/`
  (the room starts and restarts it for you). Other TTS engines / languages are a wanted contribution —
  see [issues tagged `voice`](https://github.com/shibu003/talkingclaw/issues?q=label%3Avoice).
- Logged in to Claude Code (for the built-in agent).
- Optional: [GitHub CLI](https://cli.github.com) (`gh`) to clone a project to work on from inside the room;
  [herdr](https://github.com/shibu003/herdr) to drive a fleet of terminals by voice.
- Intel Macs work but are outside AivisSpeech's official support (≈4 s per sentence; the room hides it with backchannels and fillers).

## Quick start

```sh
git clone https://github.com/shibu003/talkingclaw && cd talkingclaw
npm install
npm run web          # start the room → open http://localhost:3300 in Chrome → 🎤 ON and talk
```

Or without cloning (first run installs dependencies, ~1 min):

```sh
npx -y github:shibu003/talkingclaw          # same as `npm run web`
npx -y github:shibu003/talkingclaw cli      # the same room from your terminal
```

Other commands:

```sh
npm run cli          # join the same room from a terminal (type / listen / watch; voice input is browser-only)
npm run setup-voice  # install a third voice ("Mai") from AivisHub, with the consent flow
npm run smoke        # non-interactive smoke test
npm run metrics      # latency / coverage report (~/.talkingclaw/metrics.jsonl)
npm run cost         # measured SDK spend + what N parallel workers would cost
npm run split-log    # split a mixed transcript into per-topic transcripts
npm run check-ui     # the test suite CI runs (no daemon, no audio engine needed)
```

## Put a coding agent in the room (MCP)

```sh
# Claude Code (instructions are picked up automatically)
claude mcp add talkingclaw -- node /path/to/talkingclaw/src/mcp.ts
```

```toml
# Codex CLI (~/.codex/config.toml)
[mcp_servers.talkingclaw]
command = "node"
args = ["/path/to/talkingclaw/src/mcp.ts"]
env = { AGENT_NAME = "Kohaku", VOICE = "コハク/ノーマル" }
```

```jsonc
// Gemini CLI (~/.gemini/settings.json) — don't forget useInstructions
"mcpServers": { "talkingclaw": {
  "command": "node", "args": ["/path/to/talkingclaw/src/mcp.ts"],
  "env": { "AGENT_NAME": "Mai", "VOICE": "まい/ノーマル" },
  "timeout": 600000, "useInstructions": true } }
```

Start the agent's CLI and tell it "join the voice room and talk" — it starts listening. From the
browser, call agents **by name** ("Kohaku, fix this") or click a chip in the presence list to pin
who you are talking to.

- env: `AGENT_NAME` (name in the room) / `VOICE` (`model/style`) / `PORT` (default 3300)
- Any AivisSpeech model works as a voice (`curl http://127.0.0.1:10101/speakers` lists them)

## What it does beyond talking

- **Consult before acting (default on)** — ask for work and Chloe first pins down *what / how / how far* in
  conversation, then shows a one-line plan; work starts only when you say "go" (or press the button).
- **Commit when done** — finished work is committed in the target folder (push is off by default; secrets
  like `.env` / `*.pem` block the commit).
- **Voice navigation** — "show rooms", "join the design room", "open the board", "mute" … work without buttons.
- **Terminal client** — `npm run cli`: same room, same voices; `/project add` makes the folder you are in the
  work target, `/project clone owner/repo` pulls one from GitHub.
- **Games** — mahjong, poker and blackjack you can play by voice (`src/mahjong*.ts`, `src/poker.ts`,
  `src/blackjack.ts`, `src/casino.ts`). Built to prove that a stateful dialogue can run on voice alone.

## What makes it feel live

- **Backchannel in ~0.5 s**: a pre-synthesized WAV plays the moment your utterance is final (no LLM in the loop).
- **Filler coverage**: while the answer is slow — "thinking…" → progress ×2 → cut-off — the gap is bridged in stages.
- **Barge-in**: start speaking over an agent and local VAD (silero v5) stops it at once.
- **Stale drop**: your next utterance discards queued speech (the text stays).
- **Fragment merging**: chopped-up recognition is merged into one utterance before it is sent; agents don't
  start answering while you are still speaking (max 5 s).
- **Mishearing fixes**: `~/.talkingclaw/dictionary.json`; say "X means Y" and Chloe remembers it (`/dict add` in the CLI).
- **Speaker separation**: conversation = Chloe, work narration = the worker voice, external agents = their own voices.
- **Self-healing**: room daemon and audio engine restart themselves; agent connections recover transparently.

## Architecture

```
each agent CLI ─ MCP stdio ─ src/mcp.ts (thin proxy) × N
                                │ HTTP 127.0.0.1:3300 (token)
                                ▼
   room daemon (src/room.ts + src/roomcore.ts)
     EventStore (append-only log + cursor delivery) / Registry (takeover / presence)
     Router (name > selection > floor > default) / TtsScheduler / FillerEngine / EngineManager
                                ▼
   browser (Web Speech mic · audio playback · timeline · presence list)
```

## Security / threat model

- Binds to 127.0.0.1 only. The token embedded in the page defends against **browser-side cross-origin
  attacks (CSRF / DNS rebinding) only**, not against other processes on the same machine — it is a local tool.
- The Web Speech API sends audio to Google for recognition (fully local STT is an open item).
- Anything said in the room is untrusted input for every agent; agent-to-agent prompt injection is not defended.
- The worker's dangerous-command check (`kill`, `rm -rf`, `git push` … → asks by voice) is a **self-harm guard,
  not a security boundary** against a malicious agent.

## Give the room a body (VRM)

The room can show a character that moves while it talks. **No model ships with this repo** — drop your
own `.vrm` into `~/.talkingclaw/avatars/` and a 🧍 button appears in the header (on a wide screen the
panel opens by itself). With no file there, nothing changes.

```sh
mkdir -p ~/.talkingclaw/avatars
cp your-avatar.vrm ~/.talkingclaw/avatars/
```

Where to get one:

- **[Open Source Avatars](https://www.opensourceavatars.com/)** — a few hundred VRM avatars the site
  publishes as CC0 (check each model's page before you redistribute anything).
- **VRoid sample models** (`AvatarSample_A/B/C`) — usable and modifiable, but **not CC0**: pixiv keeps
  the copyright and sets [conditions of use](https://vroid.pixiv.help/hc/en-us/articles/4402394424089).
- **[VRoid Studio](https://vroid.com/en/studio)** — make your own.

The avatar is rendered with [three.js](https://threejs.org) + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)
(both MIT). They are the only browser-side dependencies; the room server still has none of them.

## Contributing

PRs are welcome — especially **new voices / languages / TTS engines** and **Linux / Windows support**.
Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[`good first issue`](https://github.com/shibu003/talkingclaw/issues?q=label%3A%22good+first+issue%22) list.
`npm run check-ui` is the whole test suite and runs without audio hardware.

## Credits

- Speech synthesis: [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) (LGPL-3.0, via REST)
- Voice models (all ACML 1.0; credit optional but appreciated): Mao (OzChat) / Kohaku (OzChat) / Mai (MAHOPROGRAM).
  Models are downloaded from AivisHub on first setup and are subject to their own terms; impersonation and abuse are the user's responsibility.
- VAD: [@ricky0123/vad-web](https://github.com/ricky0123/vad) (silero VAD v5) + onnxruntime-web

## How it differs from similar projects

Unlike mcp-simple-aivisspeech (single agent, server-side playback), voicemode (single agent, server-side
mic) or AgentsRoom (closed, one voice for all agents), talkingclaw lets **agents from different vendors sit
in one room and converse live, each with its own voice**, with the browser as the I/O device. It does not
manage agent processes, so it composes with orchestrators like vibe-kanban.

## License

**Apache License 2.0** — see [LICENSE](LICENSE).

Use it, modify it, ship it commercially, host it. Third-party components
(AivisSpeech, voice models, three.js/three-vrm, vad-web) keep their own terms —
[LICENSE_SCOPE.md](LICENSE_SCOPE.md) records which file falls where.

Contributions need a sign-off: see [CLA.md](CLA.md).
