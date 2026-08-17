# Contributing to talkingclaw

Thanks for coming. This project wants contributions from people who don't read Japanese and don't own a Mac —
so if something in the way is unclear or macOS-only, that itself is a good issue.

## What we'd love

| Area | Examples | Label |
|---|---|---|
| **Voices & languages** | a TTS engine for your language (Piper, Kokoro, VOICEVOX, ElevenLabs, OS built-in…), a new voice model, UI strings | `voice` |
| **Platforms** | Linux / Windows playback (`afplay` → portable player), speech input without `swiftc`, install scripts | `platform` |
| **Agents** | connecting another MCP-capable coding agent, better instructions for an existing one | `agent` |
| **Docs** | fixing anything the English README gets wrong, screenshots, a demo GIF | `docs` |
| **Everything else** | bugs, latency, the games (mahjong / poker / blackjack are staying) | — |

Small, focused PRs land fastest. If you are planning something larger, open an issue first so we can agree on the shape.

## Run it locally

```sh
npm install
npm run check-ui        # the whole test suite — no daemon, no audio engine, no API keys needed. CI runs exactly this.
npm run web             # start the room (needs the AivisSpeech engine, see README)
```

`check-ui` type-checks (`scripts/typecheck.mjs`, with a per-file baseline of known errors that may only go down)
and runs the `test/check-*.mjs` scripts, which use only Node built-ins. Tests that depend on the maintainer's
machine (for example the `newway-gate` hook) skip themselves when that thing is absent — a green CI must be
reachable from a fresh clone.

## Where things are

```
src/room.ts, src/roomcore.ts   room daemon: event store, registry, router, TTS scheduler, fillers
src/mcp.ts                     thin MCP proxy each agent CLI runs (stdio ⇄ HTTP)
src/voice.ts                   TTS providers (Fish cloud / Aivis cloud / local AivisSpeech) + playback  ← voices go here
src/cli.ts                     terminal client (uses afplay + optional swift STT)               ← platform work starts here
src/brain.ts, src/memo.ts …    built-in agent (Chloe), memos, plans
src/casino.ts, mahjong*.ts …   voice games
public/                        the browser UI (single page, no framework)
test/check-*.mjs               the test suite; test/accept-*.sh are manual acceptance scripts
backlog/, docs/                the maintainer's planning ledger (PBIs) and design notes — Japanese, read-only for you; not required
```

## Conventions

- Node ≥ 23.6, TypeScript executed directly (type-stripping) — **no build step, no bundler, no new runtime dependencies**
  unless the issue says so. The current dependency list is three packages; keep it that way.
- Match the surrounding style. Comments explain *why*; there is no linter beyond `tsc`.
- Commit messages: `type(scope): what` (`feat(voice): add Piper provider`). English or Japanese both fine.
- Add or extend a `test/check-*.mjs` when you change behavior; make it pass with `npm run check-ui`.
- Don't commit secrets or engine binaries. `engine/` is git-ignored.

## Pull request checklist

- [ ] `npm run check-ui` passes locally
- [ ] README (English) updated if you changed a command, a requirement or a voice
- [ ] For a new voice/engine: license of the model/engine noted in the README credits

## Code of conduct

Be kind, assume good faith, keep it about the code. Maintainer: [@shibu003](https://github.com/shibu003) (Japanese / English).

---

日本語: 貢献は英語でも日本語でも歓迎です。`npm run check-ui` が全検査で、CI も同じものを回します。
声・言語・プラットフォーム対応の PR がいちばん助かります。設計の背景は `docs/` と `backlog/`（日本語）にあります。
