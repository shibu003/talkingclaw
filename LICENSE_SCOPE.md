# Licence scope

This repository is not covered by a single licence. Three things live here and
each is licensed differently.

## 1. Core — Elastic License 2.0

Everything not listed under §2 or §3 below, including:

```
src/            (except src/protocol.ts and src/mcp.ts)
public/         (except public/vad/)
bin/  scripts/  test/  tools/  deploy/
```

Full text: [`LICENSE`](LICENSE) (also [`LICENSES/Elastic-2.0.txt`](LICENSES/Elastic-2.0.txt)).

You may use, copy, modify and redistribute the core. You may **not** provide it
to third parties as a hosted or managed service that gives users access to a
substantial set of its features, and you may not remove or obscure licensing,
copyright or trademark notices.

Running talkingclaw yourself — on your own machine, on your LAN, inside your
company — is exactly what it is for and is unrestricted.

## 2. Protocol and connection surface — Apache License 2.0

```
src/protocol.ts   wire types: RoomEvent, Participant, Channel, JoinOutcome,
                  JoinResume, Delivery, RoomInfo, and the enums they use
src/mcp.ts        MCP stdio proxy: the interface coding agents speak to
```

`src/protocol.ts` is types only — no behaviour, no imports. Everything that
crosses the boundary between the room daemon and a client is described there,
and `roomcore.ts` re-exports it so existing imports keep working.

Full text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

The surface an agent connects through is permissive on purpose: writing an
adapter, a client, or a competing room implementation against this interface
should carry no obligation back to us. Apache-2.0 also grants an explicit
patent licence, which matters for an interface other people build on.

Files under §2 carry an `SPDX-License-Identifier: Apache-2.0` header.

## 3. Third-party components — their own terms

Not owned by this project and not relicensed by it:

| Component | Licence | How it is used |
|---|---|---|
| [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) | LGPL-3.0 | separate process, over REST — not bundled |
| Voice models (Mao / Kohaku / Mai) | ACML 1.0 | downloaded by the user — not bundled |
| [three.js](https://threejs.org), [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | MIT | avatar rendering |
| `public/vad/` — [@ricky0123/vad-web](https://github.com/ricky0123/vad), silero VAD v5, onnxruntime-web | see upstream | barge-in detection |
| VRM avatar models | model-specific terms | supplied by the user — not bundled |

## Trademarks

The licences above cover code. They do not grant rights to the **talkingclaw**
name, logo, or the right to describe a fork as official.

## Commercial licensing

The copyright is held in full by the author, so terms other than Elastic
License 2.0 can be granted. Open an issue if you need one.

## History

Versions up to and including the last ISC-licensed release remain available
under ISC; that grant cannot be and is not withdrawn. This scope applies from
the relicensing commit forward.
