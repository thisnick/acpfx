---
"@acpfx/cli": patch
"@acpfx/mic-aec": patch
---

Rename orchestrator package to @acpfx/cli (npm rejected 'acpfx' as too similar to 'cpx').
Fix darwin-x64 builds: use macos-14 runner (macos-13 retired).
Switch to postinstall binary download pattern (no more platform npm packages).
