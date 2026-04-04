---
"@acpfx/stt-kyutai": patch
"@acpfx/tts-kyutai": patch
---

Fix manifest lookup in Python nodes: use os.path.realpath + load manifest.yaml from package root instead of hardcoded inline JSON
