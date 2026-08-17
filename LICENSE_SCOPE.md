# Licence scope

This repository is not covered by a single licence. Code and third-party
assets are separate.

## 1. Code — Apache License 2.0

Everything not listed under §2 below, including:

```
src/  bin/  scripts/  test/  tools/  deploy/
public/         (except public/vad/)
```

Full text: [`LICENSE`](LICENSE) (also [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)).

Apache-2.0 is permissive: use it, modify it, ship it in a commercial product,
host it as a service. The only obligations are to keep the notices and to state
what you changed. It also carries an explicit patent grant, which matters
because agents and third-party rooms are meant to be built against this code.

Files that define the boundary other software connects through carry an
`SPDX-License-Identifier: Apache-2.0` header:

```
src/protocol.ts   wire types: RoomEvent, Participant, Channel, JoinOutcome,
                  JoinResume, Delivery, RoomInfo, and the enums they use
src/mcp.ts        MCP stdio proxy: the interface coding agents speak to
```

`src/protocol.ts` is types only — no behaviour, no imports. Everything that
crosses the boundary between the room daemon and a client is described there,
and `roomcore.ts` re-exports it so existing imports keep working.

## 2. Third-party components — their own terms

Not owned by this project and not relicensed by it:

| Component | Licence | How it is used |
|---|---|---|
| [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) | LGPL-3.0 | separate process, over REST — not bundled |
| Voice models (Mao / Kohaku / Mai) | ACML 1.0 | downloaded by the user — not bundled |
| [three.js](https://threejs.org), [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | MIT | avatar rendering |
| `public/vad/` — [@ricky0123/vad-web](https://github.com/ricky0123/vad), silero VAD v5, onnxruntime-web | see upstream | barge-in detection |
| VRM avatar models | model-specific terms | supplied by the user — not bundled |

## Trademarks

Apache-2.0 covers code. It does not grant rights to the **talkingclaw** name,
logo, or the right to describe a fork as official.

## Contributing

Contributions require a sign-off — see [`CLA.md`](CLA.md). It keeps the project
able to change how it is distributed in future while guaranteeing that every
released open-source version stays open source.

## History

Releases up to and including the last ISC version remain available under ISC.
There was also a brief period on Elastic License 2.0 (2026-08-17); that has
been reverted and no release shipped under it.
