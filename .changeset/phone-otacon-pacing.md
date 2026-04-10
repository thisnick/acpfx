---
"@acpfx/phone-otacon": minor
"@acpfx/audio-player": minor
"@acpfx/bridge-acpx": minor
---

Add phone-otacon node for telephony integration, audio player pacing, and prompt.text support

- New `@acpfx/phone-otacon` node: bidirectional phone audio + SMS via Otacon server with auto-answer whitelist
- New `prompt.text` event type for non-voice text input (SMS), queued in bridge when agent is busy
- Audio player now paces output with 500ms lookahead to prevent Bluetooth stutter
- All audio (speech + SFX) goes through unified pacing queue
- Bridge queues prompt.text when agent is streaming, drains after completion
