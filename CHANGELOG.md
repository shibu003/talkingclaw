# Changelog

## v0.1.0-alpha.1 — 2026-08-18

First public alpha. Not yet on npm (`package.json` is `"private": true`) — run it via `git clone`
or `npx -y github:shibu003/talkingclaw`.

### Added

- A local voice room for Claude Code, Codex CLI, Gemini CLI and any other MCP-capable coding
  agent. No separate API keys — reuses the login of each CLI you already have.
- `talkingclaw doctor` — checks Chrome, Node, Claude Code login and the AivisSpeech Engine before
  you start, and tells you what's missing.
- Built-in agent **Chloe** (Claude Agent SDK) with consult-before-acting, commit-when-done, and a
  terminal client (`npm run cli`).
- Three playable games by voice — mahjong, poker, blackjack — including AI seat-filling when a
  human is short or steps away.
- VRM avatar support (bring your own `.vrm`, none ships with the repo).

### Supported environment

| | Status |
|---|---|
| OS | macOS only (Linux / Windows are a wanted contribution — see issues tagged `platform`) |
| Browser | Chrome (speech recognition uses the Web Speech API; other browsers are untested) |
| Node.js | >= 23.6 (runs TypeScript directly, no build step) |
| TTS | AivisSpeech Engine, unpacked into `engine/macOS-x64/` (other engines are a wanted contribution) |
| CPU | Apple Silicon supported; Intel Macs work but are outside AivisSpeech's official support (~4s/sentence) |

### Known limitations

- **macOS only.** No Linux/Windows build; `talkingclaw doctor` does not check for either.
- **No `setup` command yet.** AivisSpeech Engine and voice models must be installed by hand
  (see README's Requirements section); `npm run setup-voice` only adds the optional third voice.
- **No demo mode.** You cannot try the UI without the AivisSpeech Engine running.
- **Speech recognition is not local.** Chrome's Web Speech API sends your audio to Google for
  recognition; the room and TTS themselves run on localhost only.
- **Not npm-published.** `package.json` is `"private": true`; install via git clone or
  `npx -y github:shibu003/talkingclaw`.
- **No automated Windows/Linux CI.** CI (`npm run check-ui`) runs on macOS only.

### Security / privacy summary

(Full detail: README → "Security / threat model".)

- Binds to `127.0.0.1` only. The token embedded in the page defends against browser-side
  cross-origin attacks (CSRF / DNS rebinding), not against other local processes — this is a
  local dev tool, not a hardened multi-tenant service.
- Speech recognition audio goes to Google via Chrome's Web Speech API. Nothing else leaves your
  machine by default (TTS synthesis is local; agent CLIs use their own existing auth).
- Anything said in the room is untrusted input for every connected agent; agent-to-agent prompt
  injection is not defended against.
- The worker's dangerous-command check (`kill`, `rm -rf`, `git push`, …) is a self-harm guard, not
  a security boundary against a malicious agent.

### Install / uninstall

Install:
```sh
git clone https://github.com/shibu003/talkingclaw && cd talkingclaw
npm install
npm run doctor   # check your environment first
npm run web
```
or without cloning: `npx -y github:shibu003/talkingclaw doctor`.

Uninstall: delete the cloned folder. State is kept outside the repo, in `~/.talkingclaw/`
(voice selection, dictionary, metrics) — remove that directory too if you want a clean slate.
No system-level install step, no daemon left running after you close the terminal.
