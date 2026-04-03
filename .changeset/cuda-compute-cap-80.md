---
"@acpfx/stt-kyutai": patch
"@acpfx/tts-pocket": patch
---

CUDA builds now target Ampere (compute capability 8.0+) instead of Turing (7.5) to support bf16 WMMA required by candle-kernels. Documented GPU requirements in READMEs.
