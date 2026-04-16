# @acpfx/bridge-acp

## 0.2.0

### Minor Changes

- a3e4495: Replace subprocess-based ACPX bridge with native Rust ACP client

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

### Patch Changes

- f4ecece: Fix bridge-acp behavioral parity with deleted TS bridge-acpx and resolve SMS/phone-mode failures

  - Replace single `pending_text` string with FIFO `VecDeque<PendingPrompt>` queue preserving per-entry response_mode
  - Drain queued prompts after agent.complete (queued prompts were silently dropped)
  - speech.pause now accumulates text fragments during streaming instead of overwriting
  - speech.pause during active response cancels the ACP session and starts a new turn immediately
  - prompt.text no longer sets agent_active — text responses are not interruptible by speech.partial barge-in
  - Fix double-completion: agent_active now set only on first delta (matching TS agentResponding semantics)
  - Recover from stale session IDs: session/load error responses now trigger fallback to session/new (was silently using the dead session ID, breaking subsequent requests with "Session not found")
  - Emit agent.complete from JSON-RPC response with stopReason and tokenUsage from result (real claude-agent-acp signals completion via response, not a separate "end" notification)
  - Add 8 targeted integration tests in tests/bridge-acp-gaps/ with a mock ACP agent matching real Claude semantics
