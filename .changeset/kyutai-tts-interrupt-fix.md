---
"@acpfx/tts-kyutai": patch
"@acpfx/cli": patch
---

Fix Kyutai TTS not responding to interrupt during flush_remaining

- Make flush_remaining() interruptible by accepting a check_interrupted callback that polls for control.interrupt between generation steps
- Update finish_generation() to detect interrupts during flush and discard buffered output
- Route idle-branch agent.complete through finish_generation() for consistent interrupt handling
- Add interrupt unit tests and CI step for Python node tests
