# E2E Test 3: Pause Detection Timing

*2026-03-31T05:27:43Z by Showboat 0.6.1*
<!-- showboat-id: 9eba0506-82f7-4911-9a59-91375f26e94e -->

**Setup:** 'Hello world, this is a test of pause detection.' (2.60s speech) + 10s silence = 12.60s total audio.
**Config:** mic-file -> stt-elevenlabs (with built-in VAD) -> recorder

## Results

**Speech events timeline:**
- +2115ms: speech.partial 'Hello world, this'
- +2215ms: speech.partial 'Hello world, this is a test of pause to'
- +3126ms: speech.delta 'Hello world, this is a test of pause detection.'
- +3351ms: speech.final 'Hello world, this is a test of pause detection.'
- +3351ms: speech.pause (simultaneous with speech.final)
- +12827ms: lifecycle.done (mic file exhausted)

No additional speech events during 10s silence period.

## Criteria Checklist
- [x] speech.final at ~3s mark (actual: 3.35s — 2.60s speech + 0.75s STT processing)
- [x] speech.pause within 1s of speech end (actual: 0ms after speech.final — ElevenLabs Scribe v2 built-in VAD fires both simultaneously)
- [x] speech.pause NOT at 13s file end (no speech events after 3.35s)

## Verdict: PASS
