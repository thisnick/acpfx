---
"@acpfx/bridge-acp": minor
"@acpfx/cli": minor
"@acpfx/core": patch
---

Replace subprocess-based ACPX bridge with native Rust ACP client

- New `@acpfx/bridge-acp` Rust crate: direct JSON-RPC 2.0 over NDJSON to the agent process
- Agent spawned once at startup, persistent connection — zero subprocess overhead per prompt
- Streaming responses via non-blocking send_request + async message channel
- Session persistence scoped by CWD + agent + session name
- Session replay on load: prior conversation displayed as agent.history events in TUI (not routed to TTS)
- Permission handling: auto-approve via bypassPermissions mode
- Agent-initiated requests handled: fs/read_text_file, fs/write_text_file, session/request_permission
- New agent.history event type in schema for TUI-only session replay
- Removed old TypeScript bridge-acpx package
- Pipeline configs updated: bridge-acpx → bridge-acp, args → permissionMode
- CI: added bridge-acp integration tests
