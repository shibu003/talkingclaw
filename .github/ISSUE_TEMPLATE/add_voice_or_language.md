---
name: Add a voice / language / TTS engine
about: Bring your language's voice into the room
labels: voice, help wanted
---

**Language / voice**

**Engine** (Piper, Kokoro, VOICEVOX, OS built-in, a cloud API, …) and its license

**How the engine is called** (HTTP? CLI? library?) — a curl/CLI example is perfect

**Would you like to send the PR?** (yes / no / maybe with guidance)

Where it goes: `src/voice.ts` (providers) — see CONTRIBUTING.md. If the provider interface is in your way, say so; that's a bug in our design, not in your engine.
