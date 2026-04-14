---
"@acpfx/tts-kyutai": patch
"@acpfx/cli": patch
"@acpfx/mic-speaker": patch
---

Fix Kyutai TTS interrupt during flush and PTT race condition

- Make flush_remaining() interruptible by accepting a check_interrupted callback that polls for control.interrupt between generation steps
- Update finish_generation() to detect interrupts during flush and discard buffered output
- Route idle-branch agent.complete through finish_generation() for consistent interrupt handling
- Fix PTT race condition: add monotonic seq counter to mute events and gap-aware re-activation in HoldState to prevent stale timeout-mute from killing active capture
- Add interrupt unit tests and CI step for Python node tests
