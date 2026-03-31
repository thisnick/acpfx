# Phase 3: Audio Nodes (mic-file, play-file) Evaluation

*2026-03-31T04:20:52Z by Showboat 0.6.1*
<!-- showboat-id: 2c9606d1-aa8b-42cb-8e12-dca90dba836c -->

```bash
echo '=== All v2 Unit Tests ===' && node --test dist/test/v2/*.test.js 2>&1
```

```output
=== All v2 Unit Tests ===
▶ audio nodes v2
  ✔ mic-file emits lifecycle.ready before audio.chunk (1058.853834ms)
  ✔ mic-file emits audio.level events (1079.46925ms)
  ✔ mic-file paces output at real-time rate (1578.640417ms)
  ✔ WAV roundtrip: mic-file → play-file produces valid WAV (2585.486917ms)
  ✔ play-file handles control.interrupt (2090.516083ms)
✔ audio nodes v2 (8395.790708ms)
▶ config v2
  ✔ parses standard config (4.942334ms)
  ✔ parses test config (0.583708ms)
  ✔ parses conference config (0.54575ms)
  ✔ rejects empty config (0.1995ms)
  ✔ rejects config without nodes (0.124292ms)
  ✔ rejects node without use (0.131ms)
  ✔ rejects output to undefined node (0.162791ms)
  ✔ rejects non-array outputs (0.161709ms)
  ✔ accepts node with no outputs (0.129416ms)
✔ config v2 (7.607208ms)
▶ dag v2
  ✔ builds a valid DAG from standard config (4.434458ms)
  ✔ handles fan-out (one node to multiple) (0.429583ms)
  ✔ handles fan-in (multiple nodes to one) (0.296208ms)
  ✔ rejects config with a cycle (A→B→A) (0.404834ms)
  ✔ rejects config with a longer cycle (A→B→C→A) (0.274834ms)
  ✔ computes downstream sets for interrupt propagation (0.388041ms)
  ✔ produces deterministic topological order (0.23325ms)
✔ dag v2 (7.070875ms)
▶ orchestrator v2
  ✔ spawns an echo node and receives lifecycle.ready (57.8875ms)
  ✔ routes events from node A to node B (560.467583ms)
  ✔ fan-out: routes from one node to multiple destinations (584.594875ms)
  ✔ stamps ts and _from on all routed events (50.316042ms)
  ✔ emits control.error when a node crashes (48.809625ms)
  ✔ handles clean shutdown on stop() (52.051583ms)
  ✔ propagates control.interrupt to downstream nodes (572.548041ms)
✔ orchestrator v2 (1927.65725ms)
▶ protocol v2
  ✔ defines all event types with string literal type field (0.437791ms)
  ✔ isKnownEventType recognizes all v2 types (0.08525ms)
  ✔ parseEvent parses valid JSON (0.055667ms)
  ✔ parseEvent rejects invalid JSON (0.181667ms)
  ✔ serializeEvent round-trips (0.709416ms)
  ✔ stampEvent adds ts and _from (0.075083ms)
✔ protocol v2 (2.155042ms)
ℹ tests 34
ℹ suites 5
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11406.333875
```

```bash
node /tmp/acpfx-eval-p3-roundtrip.mjs 2>&1
```

```output
Input WAV: /tmp/acpfx-eval-p3/input.wav (32044 bytes, 1s @ 16000Hz)
Output WAV: /tmp/acpfx-eval-p3/output.wav (32044 bytes)
Input size:  32044
Output size: 32044
Input  header: RIFF/WAVE
Output header: RIFF/WAVE
Input  PCM bytes: 32000
Output PCM bytes: 32000
PCM byte-identical: true
WAV roundtrip: PASS

Events: 24 total
  lifecycle.ready: 2
  audio.chunk: 10
  audio.level: 10
```

CHECK 1 PASS: WAV roundtrip is byte-identical. 1-second 16kHz mono WAV (32044 bytes) sent through mic-file -> play-file. Input and output both 32044 bytes. PCM data (32000 bytes, skipping 44-byte headers) is byte-identical. Valid RIFF/WAVE headers on both.

```bash
node /tmp/acpfx-eval-p3-levels.mjs 2>&1
```

```output
=== audio.level events ===
  rms=11314  peak=16000  dbfs=-9.2
  rms=11314  peak=16000  dbfs=-9.2
  rms=11314  peak=16000  dbfs=-9.2
  rms=11314  peak=16000  dbfs=-9.2
  rms=11314  peak=16000  dbfs=-9.2
Count: 5
All have non-zero RMS: true
audio.level check: PASS
```

CHECK 2 PASS: mic-file emits audio.level events with computed RMS energy. 5 level events for 500ms audio (one per 100ms chunk). Sine wave at amplitude 16000: rms=11314 (correctly ~16000/sqrt(2)), peak=16000, dbfs=-9.2. All fields are numeric and non-zero.

```bash
node /tmp/acpfx-eval-p3-realtime.mjs 2>&1
```

```output
Created 3s WAV (96044 bytes)
audio.chunk count: 30
First chunk ts: 1774930946706
Last chunk ts:  1774930949645
Spread (ms):    2939
Expected ~2900ms for 3s audio with 100ms chunks
Real-time pacing: PASS (spread 2939ms for 3s audio)
```

CHECK 3 PASS: mic-file paces output at real-time rate. 3-second audio with 100ms chunks: 30 chunks emitted over 2939ms (expected ~2900ms). Chunks are spread over time, not emitted instantly. The 39ms overhead is within acceptable tolerance for setTimeout-based pacing.

CHECK 4 PASS: mic-file emits lifecycle.ready before first audio.chunk. From the roundtrip test events, lifecycle.ready (from mic) appears as event index 0 or 1 (alongside play-file's ready), always before any audio.chunk events. The unit test 'mic-file emits lifecycle.ready before audio.chunk' explicitly asserts readyIdx < firstChunkIdx. Code confirms: emit({type:'lifecycle.ready'}) is called at line 153, before the chunk emission loop starting at line 156.

```bash
node /tmp/acpfx-eval-p3-interrupt.mjs 2>&1
```

```output
Input WAV: 96044 bytes (3s)
Sending control.interrupt to play-file...
Output WAV: 19244 bytes
Output is smaller than input: true
Valid WAV header: true
RIFF size field: 19236 (file: 19244, expected: 19236)
WAV header finalized correctly: true
Interrupt handling: PASS
```

CHECK 5 PASS: play-file handles control.interrupt correctly. 3-second input (96044 bytes), interrupted after ~600ms. Output: 19244 bytes (20% of input — ~600ms of audio written). WAV header finalized with correct RIFF size (19236 = 19244 - 8). Output is a valid, playable WAV file, not a truncated/corrupt file.

## Verdict

- [x] WAV roundtrip: mic-file -> play-file produces byte-identical output: PASS (32044 bytes in = 32044 bytes out, PCM identical)
- [x] mic-file emits audio.level events with RMS energy: PASS (rms=11314, peak=16000, dbfs=-9.2 for sine wave)
- [x] mic-file paces output at real-time rate: PASS (3s audio spread over 2939ms with 100ms chunks)
- [x] mic-file emits lifecycle.ready before first audio.chunk: PASS (ready at index 0, chunks after)
- [x] play-file handles control.interrupt: PASS (truncated output with finalized WAV header, RIFF size correct)

**Phase 3: APPROVED** — all 5 criteria pass with evidence. 34/34 total tests pass.
