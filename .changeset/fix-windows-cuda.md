---
"@acpfx/stt-kyutai": patch
"@acpfx/tts-pocket": patch
---

Fix Windows CUDA build: use pwsh instead of bash to avoid Git's link.exe shadowing MSVC linker. Drop Linux CUDA (toolkit install broken on Ubuntu 24.04 GH runners).
