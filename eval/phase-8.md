# Phase 8: CLI UI (Ink dashboard) Evaluation

*2026-03-31T04:57:13Z by Showboat 0.6.1*
<!-- showboat-id: 6fba5f5a-d277-4454-a771-7d9301857f14 -->

```bash
node --test dist/test/v2/ui-cli.test.js
```

```output
▶ ui-cli components
  ✔ PipelineStatus renders node names and checkmarks from lifecycle.ready (22.448875ms)
  ✔ PipelineStatus renders error messages (1.177625ms)
  ✔ InputSection renders level meter and STT text (0.989875ms)
  ✔ InputSection renders empty level for rms=0 (1.239417ms)
  ✔ InputSection updates with new STT text (2.6585ms)
  ✔ AgentSection renders streaming text and token count (0.818625ms)
  ✔ AgentSection renders waiting state (0.748709ms)
  ✔ OutputSection renders TTS progress (0.756459ms)
  ✔ LatencyBar computes and displays hop latencies (0.860291ms)
  ✔ LatencyBar shows no data when no latencies available (0.660333ms)
✔ ui-cli components (33.026375ms)
ℹ tests 10
ℹ suites 1
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 299.08675
```

Phase 8 evaluates the Ink-based CLI dashboard. Criteria: snapshot-based per-state rendering (idle, listening, speech, processing, streaming, speaking, interrupted, error), modular components, and 10 UI tests.

```bash
node --test dist/test/v2/ui-cli.test.js
```

```output
▶ ui-cli components
  ✔ PipelineStatus renders node names and checkmarks from lifecycle.ready (20.463417ms)
  ✔ PipelineStatus renders error messages (1.685292ms)
  ✔ InputSection renders level meter and STT text (1.221292ms)
  ✔ InputSection renders empty level for rms=0 (1.088584ms)
  ✔ InputSection updates with new STT text (4.353083ms)
  ✔ AgentSection renders streaming text and token count (0.72575ms)
  ✔ AgentSection renders waiting state (0.56025ms)
  ✔ OutputSection renders TTS progress (0.58725ms)
  ✔ LatencyBar computes and displays hop latencies (0.613416ms)
  ✔ LatencyBar shows no data when no latencies available (0.560125ms)
✔ ui-cli components (32.341875ms)
ℹ tests 10
ℹ suites 1
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 211.063042
```

All 10 UI tests pass. Now capturing frame snapshots for each pipeline state.

```bash
node ui-snapshots.mjs
```

```output
=== SNAPSHOT: Idle/Listening with node status ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Pipeline                                                                                        │
│ State: Listening                                                                                 │
│ Nodes: mic + stt + bridge + tts + play +                                                         │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Listening with level meter ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Input                                                                                           │
│ Mic: [==========----------] -6.0 dBFS                                                            │
│ STT: ""                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Speech recognized (partial) ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Input                                                                                           │
│ Mic: [=====---------------] -12.0 dBFS                                                           │
│ STT: "Write me an essay about" (partial)                                                         │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Speech recognized (final) ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Input                                                                                           │
│ Mic: [--------------------] -inf dBFS                                                            │
│ STT: "Write me an essay about why people should not fear AI" (final)                             │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Processing state ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Pipeline                                                                                        │
│ State: Processing                                                                                │
│ Nodes: bridge +                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Streaming with agent text ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Agent                                                                                           │
│ Status: Streaming... (3.5s)                                                                      │
│ > The fear of AI is largely unfounded because technological progress has consistently improved   │
│ human welfare.                                                                                   │
│ Tokens: 18  TTFT: 1.2s                                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Speaking with TTS progress ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Pipeline                                                                                        │
│ State: Speaking                                                                                  │
│ Nodes: tts +                                                                                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Output                                                                                          │
│ TTS: 42 chunks (8.4s audio)                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Interrupted state ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Pipeline                                                                                        │
│ State: Interrupted                                                                               │
│ Nodes: bridge +                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Error state ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Pipeline                                                                                        │
│ State: Listening                                                                                 │
│ Nodes:                                                                                           │
│ Error: WebSocket connection failed: ECONNREFUSED                                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Latency bar with all hops ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Latency                                                                                         │
│ STT: 150ms -> VAD: 620ms -> Agent: 1.8s -> TTS: 480ms                                            │
│ End-to-end: 3.05s                                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

=== SNAPSHOT: Latency bar — no data ===
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Latency                                                                                         │
│ No data yet                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Criteria Verification

### 1. Idle/Listening state with node status
PASS — PipelineStatus shows 'State: Listening' with all 5 nodes listed (mic, stt, bridge, tts, play) each with '+' ready indicator.

### 2. Listening with level meter (rms)
PASS — InputSection shows '[==========----------] -6.0 dBFS' for rms=16384. Empty meter '[--------------------]' for rms=0.

### 3. Speech recognized (partial + final)
PASS — InputSection shows '"Write me an essay about" (partial)' and '"Write me an essay about why people should not fear AI" (final)'. Rerender test confirms text updates.

### 4. Processing state (speech.pause)
PASS — PipelineStatus shows 'State: Processing' after speech.pause event.

### 5. Streaming (agent.delta accumulated text + tokens)
PASS — AgentSection shows 'Streaming... (3.5s)' with full text, 'Tokens: 18', and 'TTFT: 1.2s'.

### 6. Speaking (TTS audio.chunk progress)
PASS — PipelineStatus shows 'State: Speaking'. OutputSection shows '42 chunks (8.4s audio)'.

### 7. Interrupted state (control.interrupt)
PASS — PipelineStatus shows 'State: Interrupted'.

### 8. Error state (control.error, no crash)
PASS — PipelineStatus shows 'Error: WebSocket connection failed: ECONNREFUSED'. Component renders without crash.

### 9. Latency bar
PASS — LatencyBar shows 'STT: 150ms -> VAD: 620ms -> Agent: 1.8s -> TTS: 480ms' with 'End-to-end: 3.05s'. Shows 'No data yet' when no latencies available.

### 10. Modular components
PASS — 5 independently testable components (PipelineStatus, InputSection, AgentSection, OutputSection, LatencyBar) + Dashboard composition. All exported separately. 10 tests exercise each component in isolation using ink-testing-library.

## Verdict: APPROVED

All Phase 8 criteria satisfied. 10/10 tests pass. Frame snapshots confirm correct rendering for all pipeline states. Components are modular and independently testable.
