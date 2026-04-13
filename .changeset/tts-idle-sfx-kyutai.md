---
"@acpfx/tts-deepgram": patch
"@acpfx/tts-elevenlabs": patch
"@acpfx/audio-player": patch
"@acpfx/stt-kyutai": patch
---

Fix TTS audio cutoff, improve SFX lifecycle, and add Kyutai silence-based pause detection

- TTS Deepgram/ElevenLabs: increase idle timeout to 60s and reset on incoming audio chunks to prevent premature WebSocket close during long responses
- Audio player: keep SFX playing through consecutive tool calls, only stop on agent.delta or agent.complete
- STT Kyutai: add silence timer (utteranceEndMs) to emit speech.pause after period of no words, fixing agent not responding after speech.final
- Add phone-agent-local-gpu.yaml pipeline config for on-device Kyutai STT+TTS
