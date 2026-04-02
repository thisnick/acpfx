---
"@acpfx/cli": minor
"@acpfx/mic-speaker": minor
"@acpfx/core": patch
---

Consolidate mic-aec and mic-sox into unified mic-speaker node

- **Remove `node-mic-aec` and `node-mic-sox`**: Replaced by the native `node-mic-speaker` package with built-in AEC support.
- **Add `node-mic-speaker`**: Rust-based mic capture + speaker output with acoustic echo cancellation in a single node.
- **Simplify pipeline configs**: Remove deprecated AEC/sysvoice pipeline variants; update remaining configs to use `@acpfx/mic-speaker`.
- **Update audio-player**: Streamline to work with the new mic-speaker node.
- **Update orchestrator**: Onboarding, templates, and node runner adjusted for consolidated mic node.
- **Update tests**: Reflect removed packages and new node structure.
