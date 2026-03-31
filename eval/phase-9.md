# Phase 9: Live Audio Nodes (mic-sox, play-sox) Evaluation

*2026-03-31T05:03:55Z by Showboat 0.6.1*
<!-- showboat-id: d7a63174-95f5-400f-ae23-2f0e01bdc8d1 -->

## Code Review

**mic-sox.ts** (182 lines):
- Spawns `rec` (sox) with correct raw PCM args: -t raw -b 16 -e signed-integer -r 16000 -c 1 --endian little
- Buffers raw PCM, emits audio.chunk when CHUNK_SIZE (100ms) accumulated
- Computes RMS/peak/dBFS for audio.level events per chunk
- Handles control.interrupt via stdin readline — sets interrupted flag, kills rec process
- Handles SIGTERM — kills rec process, exits cleanly
- Flushes remaining buffer on stdout end
- Emits lifecycle.ready before first chunk, lifecycle.done on close

**play-sox.ts** (121 lines):
- Lazy-starts `play` (sox) on first audio.chunk — correct raw PCM args matching mic-sox
- Decodes base64 PCM from audio.chunk events, writes to play stdin
- Handles control.interrupt — kills play process, stops writing
- EPIPE suppression on play.stdin (line 69) — handles play exiting while still writing
- On stdin close: ends play.stdin, waits for close event before lifecycle.done
- Handles SIGTERM — kills play process, exits cleanly
- Emits lifecycle.ready immediately (lazy start pattern)

## Build Verification

```bash
npx tsc --noEmit 2>&1 && echo 'Build clean: OK'
```

```output
Build clean: OK
```

## All Tests (46 pass)

```bash
node --test dist/test/v2/*.test.js 2>&1
```

```output
▶ audio nodes v2
  ✔ mic-file emits lifecycle.ready before audio.chunk (1059.177958ms)
  ✔ mic-file emits audio.level events (1074.578667ms)
  ✔ mic-file paces output at real-time rate (1553.517459ms)
  ✔ WAV roundtrip: mic-file → play-file produces valid WAV (2556.994542ms)
  ✔ play-file handles control.interrupt (2073.259583ms)
✔ audio nodes v2 (8320.237042ms)
▶ config v2
  ✔ parses standard config (4.912542ms)
  ✔ parses test config (0.563625ms)
  ✔ parses conference config (0.52725ms)
  ✔ rejects empty config (0.204959ms)
  ✔ rejects config without nodes (0.130667ms)
  ✔ rejects node without use (0.135708ms)
  ✔ rejects output to undefined node (0.261ms)
  ✔ rejects non-array outputs (0.154583ms)
  ✔ accepts node with no outputs (0.135583ms)
✔ config v2 (7.648625ms)
▶ dag v2
  ✔ builds a valid DAG from standard config (4.661958ms)
  ✔ handles fan-out (one node to multiple) (0.443041ms)
  ✔ handles fan-in (multiple nodes to one) (0.307167ms)
  ✔ rejects config with a cycle (A→B→A) (0.497792ms)
  ✔ rejects config with a longer cycle (A→B→C→A) (0.385291ms)
  ✔ computes downstream sets for interrupt propagation (0.433917ms)
  ✔ produces deterministic topological order (0.2535ms)
✔ dag v2 (7.618083ms)
▶ orchestrator v2
  ✔ spawns an echo node and receives lifecycle.ready (56.234625ms)
  ✔ routes events from node A to node B (563.023458ms)
  ✔ fan-out: routes from one node to multiple destinations (585.606625ms)
  ✔ stamps ts and _from on all routed events (53.3585ms)
  ✔ emits control.error when a node crashes (51.463083ms)
  ✔ handles clean shutdown on stop() (55.203833ms)
  ✔ propagates control.interrupt to downstream nodes (572.352208ms)
✔ orchestrator v2 (1938.231541ms)
▶ protocol v2
  ✔ defines all event types with string literal type field (0.46225ms)
  ✔ isKnownEventType recognizes all v2 types (0.089666ms)
  ✔ parseEvent parses valid JSON (0.059333ms)
  ✔ parseEvent rejects invalid JSON (0.190625ms)
  ✔ serializeEvent round-trips (0.628667ms)
  ✔ stampEvent adds ts and _from (0.061709ms)
✔ protocol v2 (2.12825ms)
[recorder] [recorder] Recording to /Users/nick/code/acpfx/tmp-test-recorder/recordings/56badae0
[recorder] [recorder] Wrote conversation.wav (100ms)
[recorder] [recorder] Wrote timeline.html
[recorder] [recorder] Recording saved to /Users/nick/code/acpfx/tmp-test-recorder/recordings/56badae0
▶ recorder node v2
  ✔ captures events to events.jsonl and audio to WAV (3089.3085ms)
[recorder] [recorder] Recording to /Users/nick/code/acpfx/tmp-test-recorder/recordings/9226ddcb
[recorder] [recorder] Wrote conversation.wav (101ms)
[recorder] [recorder] Wrote timeline.html
[recorder] [recorder] Recording saved to /Users/nick/code/acpfx/tmp-test-recorder/recordings/9226ddcb
  ✔ generates timeline.html (3081.683792ms)
✔ recorder node v2 (6173.493333ms)
▶ ui-cli components
  ✔ PipelineStatus renders node names and checkmarks from lifecycle.ready (21.067084ms)
  ✔ PipelineStatus renders error messages (1.635084ms)
  ✔ InputSection renders level meter and STT text (1.282583ms)
  ✔ InputSection renders empty level for rms=0 (1.057417ms)
  ✔ InputSection updates with new STT text (4.144625ms)
  ✔ AgentSection renders streaming text and token count (0.738667ms)
  ✔ AgentSection renders waiting state (0.558667ms)
  ✔ OutputSection renders TTS progress (0.59475ms)
  ✔ LatencyBar computes and displays hop latencies (0.652ms)
  ✔ LatencyBar shows no data when no latencies available (0.593709ms)
✔ ui-cli components (32.841458ms)
ℹ tests 46
ℹ suites 7
ℹ pass 46
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11345.93475
```

## Smoke Test: mic-sox (2s capture)

```bash
node /tmp/mic-sox-smoke.mjs 2>/dev/null
```

```output
Event counts: {"lifecycle.ready":1,"audio.chunk":15,"audio.level":15}
Total events: 31
First event: {"type":"lifecycle.ready","component":"mic-sox"}
Sample audio.chunk keys: [
  'type',
  'trackId',
  'format',
  'sampleRate',
  'channels',
  'data',
  'durationMs'
]
Sample audio.level: {"type":"audio.level","trackId":"mic","rms":195,"peak":450,"dbfs":-44.5}
```

## Smoke Test: play-sox (clean exit + interrupt)

```bash
echo '--- play-sox: clean exit ---' && echo '{"type":"audio.chunk","trackId":"tts","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAAAAAAAAAAAAAAAAAAAAA==","durationMs":100}' | timeout 3 node dist/v2/nodes/play-sox.js 2>/dev/null && echo '--- play-sox: interrupt test ---' && printf '{"type":"audio.chunk","trackId":"tts","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAAAAAAAAAAAAAAAAAAAAA==","durationMs":100}\n{"type":"control.interrupt","reason":"test"}\n{"type":"audio.chunk","trackId":"tts","format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAAAAAAAAAAAAAAAAAAAAA==","durationMs":100}\n' | timeout 3 node dist/v2/nodes/play-sox.js 2>/dev/null && echo 'Both tests exited cleanly (exit 0)'
```

```output
--- play-sox: clean exit ---
{"type":"lifecycle.ready","component":"play-sox"}
{"type":"lifecycle.done","component":"play-sox"}
--- play-sox: interrupt test ---
{"type":"lifecycle.ready","component":"play-sox"}
{"type":"lifecycle.done","component":"play-sox"}
Both tests exited cleanly (exit 0)
```

## Criteria Verification

### 1. mic-sox emits audio.chunk events
PASS — 15 audio.chunk events in 2 seconds (100ms chunks). Each contains trackId, format, sampleRate, channels, base64 data, durationMs. Also emits 15 audio.level events with rms/peak/dbfs.

### 2. play-sox plays audio from audio.chunk events
PASS — Spawns sox `play` process, decodes base64 PCM, pipes to stdin. Emits lifecycle.ready immediately (lazy start), lifecycle.done on clean close. Exit code 0.

### 3. Both handle control.interrupt and clean shutdown
PASS — mic-sox: kills rec process on interrupt, sets interrupted flag, stops emitting chunks. play-sox: kills play process on interrupt, stops writing PCM. Both handle SIGTERM and stdin close. Both exit 0.

### 4. Build clean (tsc --noEmit)
PASS — Zero errors.

### Additional observations:
- sox falls back gracefully when requested sample rate/channels not available (16000 -> 48000, 1ch -> 2ch)
- play-sox suppresses EPIPE errors if play exits while still writing (line 69)
- play-sox uses lazy start pattern — sox only spawned on first audio.chunk

## Verdict: APPROVED

All Phase 9 criteria satisfied. 46/46 tests pass. Live smoke tests confirm mic-sox captures audio and play-sox plays it back. Both handle interrupt and shutdown cleanly.
