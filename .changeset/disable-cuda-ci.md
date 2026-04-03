---
"@acpfx/stt-kyutai": patch
"@acpfx/tts-pocket": patch
---

Disable CUDA CI builds (Linux: toolkit install broken, Windows: CRT mismatch). Postinstall falls back to CPU. Users can build CUDA locally.
