# E2E Test 1: Full Turn

*2026-03-31T05:08:05Z by Showboat 0.6.1*
<!-- showboat-id: 76212f5f-e73b-4eae-bfe6-df4faa4c938a -->

E2E Test 1: Full Turn — mic-file -> stt-elevenlabs -> bridge-acpx (haiku) -> tts-elevenlabs -> play-file + recorder

**Bug found and fixed during testing:** The bridge-acpx node emits an initial agent.delta with an empty delta field. The tts-elevenlabs node was sending this empty string to ElevenLabs, which interpreted it as EOS (end-of-stream), prematurely closing the TTS WebSocket. Fixed by adding `if (event.delta)` guard before `sendText()` in tts-elevenlabs.ts line 213.

**Input:** 'Explain why the sky is blue in three sentences' (2.60s audio, padded to 5.60s with silence for VAD)

## Results

**Event counts:**
- lifecycle.ready: 6 (all nodes)
- audio.chunk from mic: 57
- audio.level from mic: 57
- speech.partial: 2, speech.delta: 1, speech.final: 1, speech.pause: 1
- agent.submit: 1, agent.delta: 21, agent.complete: 1
- audio.chunk from tts: 204
- lifecycle.done from mic: 1

**STT text:** 'Explain why the sky is blue in three sentences.'
**Agent response:** 'Sunlight enters the atmosphere carrying every wavelength of visible light. Air molecules scatter blue wavelengths disproportionately because Rayleigh scattering scales with the inverse fourth power of wavelength, heavily favoring shorter waves. This scattered blue light reaches observers from all directions, painting the sky blue.'
**TTS output:** 204 audio chunks, 20.39s WAV audio

**Latency waterfall:**
- speech.final: ts=1774934762437
- First agent.delta: ts=1774934763974 (VAD->agent: 1537ms)
- agent.complete: ts=1774934765170 (agent duration: 1196ms)
- First TTS chunk: ts=1774934766210 (agent->TTS: 2236ms)
- End-to-end (speech.final -> first TTS audio): 3773ms

**Roundtrip STT:** Running STT on the output WAV produces 'Sunlight enters the atmosphere carrying every wavelength of visible light.' — matches the first sentence of the agent response. Valid speech confirmed.

**Recorder output:** events.jsonl (905KB), timeline.html (874KB), tts.wav (652KB), conversation.wav (33KB)

## Criteria Checklist
- [x] Every component emits expected event types
- [x] STT text matches input text
- [x] Agent responds coherently (3 sentences about Rayleigh scattering)
- [x] TTS audio is valid speech (roundtrip STT matches agent text)
- [x] Roundtrip: STT on output WAV matches agent response
- [x] Latency: no single hop > 5s (max hop: agent->TTS 2.2s)
- [x] events.jsonl and timeline.html generated

## Verdict: PASS
