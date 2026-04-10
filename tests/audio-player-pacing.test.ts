/**
 * Audio player pacing tests.
 *
 * Spawns the audio-player node as a child process and verifies timing/ordering
 * of emitted audio.chunk events under various scenarios.
 *
 * Run: cd /Users/nick/code/acpfx && npx tsx tests/audio-player-pacing.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_PLAYER_PATH = join(__dirname, "..", "dist", "nodes", "audio-player.js");
const TOLERANCE_MS = 50;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// ---- Helpers ----

function makeAudioChunk(durationMs: number, from = "tts"): string {
  const numBytes = Math.round((SAMPLE_RATE * BYTES_PER_SAMPLE * durationMs) / 1000);
  const pcm = Buffer.alloc(numBytes); // silence
  return JSON.stringify({
    type: "audio.chunk",
    trackId: "tts",
    format: "pcm_s16le",
    sampleRate: SAMPLE_RATE,
    channels: 1,
    data: pcm.toString("base64"),
    durationMs,
    kind: "speech",
    _from: from,
  });
}

function send(proc: ChildProcess, event: string | object): void {
  const line = typeof event === "string" ? event : JSON.stringify(event);
  proc.stdin!.write(line + "\n");
}

interface TimedEvent {
  event: any;
  timestamp: number;
}

function spawnPlayer(): ChildProcess {
  return spawn("node", [AUDIO_PLAYER_PATH], {
    env: {
      ...process.env,
      ACPFX_SETTINGS: JSON.stringify({ speechSource: "tts", sfxVolume: 0.3 }),
      ACPFX_NODE_NAME: "player",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collectEvents(proc: ChildProcess): TimedEvent[] {
  const events: TimedEvent[] = [];
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push({ event, timestamp: Date.now() });
    } catch {}
  });
  return events;
}

function audioChunks(events: TimedEvent[]): TimedEvent[] {
  return events.filter((e) => e.event.type === "audio.chunk");
}

function sfxChunks(events: TimedEvent[]): TimedEvent[] {
  return events.filter((e) => e.event.type === "audio.chunk" && e.event.kind === "sfx");
}

function speechChunks(events: TimedEvent[]): TimedEvent[] {
  return events.filter((e) => e.event.type === "audio.chunk" && e.event.kind === "speech");
}

function waitFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(events: TimedEvent[], timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.some((e) => e.event.type === "lifecycle.ready")) return;
    await waitFor(20);
  }
  throw new Error("Timed out waiting for lifecycle.ready");
}

function killProc(proc: ChildProcess): void {
  try {
    proc.stdin!.end();
    proc.kill("SIGTERM");
  } catch {}
}

function assertApprox(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > TOLERANCE_MS) {
    throw new Error(`${label}: expected ~${expected}ms, got ${actual}ms (tolerance ±${TOLERANCE_MS}ms)`);
  }
}

function assertGte(actual: number, min: number, label: string): void {
  if (actual < min - TOLERANCE_MS) {
    throw new Error(`${label}: expected >= ${min}ms, got ${actual}ms`);
  }
}

function assertLte(actual: number, max: number, label: string): void {
  if (actual > max + TOLERANCE_MS) {
    throw new Error(`${label}: expected <= ${max}ms, got ${actual}ms`);
  }
}

// ---- Test runner ----

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err: any) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exit(failed > 0 ? 1 : 0);
}

// ---- Tests ----

test("1. Burst fills 500ms", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  const t0 = Date.now();
  // Send 10 x 100ms chunks at once
  for (let i = 0; i < 10; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(1200);
  killProc(proc);

  const speech = speechChunks(events);
  // First ~5 chunks (500ms worth) should be emitted within ~50ms
  if (speech.length < 5) throw new Error(`Expected at least 5 speech chunks, got ${speech.length}`);

  const burstEnd = speech[4].timestamp - t0;
  assertLte(burstEnd, 100, "First 5 chunks should burst within ~100ms");

  // Remaining chunks should be paced — chunk 6+ should come later
  if (speech.length > 5) {
    const chunk6Time = speech[5].timestamp - t0;
    assertGte(chunk6Time, 50, "Chunk 6 should be delayed past burst");
  }
});

test("2. Pacing at real-time", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // Send 20 x 100ms chunks at once
  for (let i = 0; i < 20; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(2500);
  killProc(proc);

  const speech = speechChunks(events);
  if (speech.length < 15) throw new Error(`Expected at least 15 speech chunks, got ${speech.length}`);

  // After burst (first 5), check pacing intervals between subsequent chunks
  // They should be spaced ~100ms apart
  const pacedChunks = speech.slice(5);
  for (let i = 1; i < Math.min(pacedChunks.length, 10); i++) {
    const gap = pacedChunks[i].timestamp - pacedChunks[i - 1].timestamp;
    assertApprox(gap, 100, `Pacing gap between paced chunk ${i - 1} and ${i}`);
  }
});

test("3. TTS slower than real-time", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // Send 1 chunk every 200ms (100ms audio each) — always within lookahead
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    send(proc, makeAudioChunk(100));
    await waitFor(200);
  }

  await waitFor(200);
  killProc(proc);

  const speech = speechChunks(events);
  if (speech.length < 5) throw new Error(`Expected 5 speech chunks, got ${speech.length}`);

  // All should be emitted immediately (within ~50ms of being sent)
  // Since we send every 200ms, gaps should be ~200ms (matching send rate, not paced)
  for (let i = 1; i < speech.length; i++) {
    const gap = speech[i].timestamp - speech[i - 1].timestamp;
    assertApprox(gap, 200, `Gap between chunk ${i - 1} and ${i} should match send rate`);
  }
});

test("4. Interrupt clears queue", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // Send 10 chunks
  for (let i = 0; i < 10; i++) {
    send(proc, makeAudioChunk(100));
  }

  // Interrupt after 300ms
  await waitFor(300);
  send(proc, { type: "control.interrupt" });

  await waitFor(500);
  killProc(proc);

  const speech = speechChunks(events);
  // Should have gotten ~5 (burst) but NOT all 10
  // After interrupt, no more should be emitted
  if (speech.length >= 10) {
    throw new Error(`Expected fewer than 10 chunks after interrupt, got ${speech.length}`);
  }
});

test("5. SFX after speech", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  const t0 = Date.now();
  // Send 5 x 100ms speech chunks
  for (let i = 0; i < 5; i++) {
    send(proc, makeAudioChunk(100));
  }
  // Then tool start
  send(proc, { type: "agent.tool_start", tool: "test" });

  await waitFor(1500);
  killProc(proc);

  const sfx = sfxChunks(events);
  if (sfx.length === 0) throw new Error("Expected SFX chunks after speech drains");

  // SFX should not appear until ~500ms after t0 (when speech estimate drains)
  const firstSfxDelay = sfx[0].timestamp - t0;
  assertGte(firstSfxDelay, 400, "SFX should wait for speech to drain");
});

test("6. SFX skipped if speech resumes", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // 3 speech chunks
  for (let i = 0; i < 3; i++) {
    send(proc, makeAudioChunk(100));
  }
  // Tool start
  send(proc, { type: "agent.tool_start", tool: "test" });

  // Quickly send 3 more speech chunks (preempts SFX)
  await waitFor(50);
  for (let i = 0; i < 3; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(800);
  killProc(proc);

  const sfx = sfxChunks(events);
  if (sfx.length > 0) {
    throw new Error(`Expected no SFX (speech resumed), but got ${sfx.length} SFX chunks`);
  }
});

test("7. Thinking SFX delay", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  const t0 = Date.now();
  send(proc, { type: "agent.thinking" });

  await waitFor(1200);
  killProc(proc);

  const sfx = sfxChunks(events);
  if (sfx.length === 0) throw new Error("Expected thinking SFX after delay");

  const firstSfxDelay = sfx[0].timestamp - t0;
  assertApprox(firstSfxDelay, 500, "Thinking SFX should start after ~500ms delay");
});

test("8. Thinking during speech", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  const t0 = Date.now();
  // 5 x 100ms speech chunks
  for (let i = 0; i < 5; i++) {
    send(proc, makeAudioChunk(100));
  }
  // Then thinking
  send(proc, { type: "agent.thinking" });

  await waitFor(2000);
  killProc(proc);

  const sfx = sfxChunks(events);
  if (sfx.length === 0) throw new Error("Expected thinking SFX after speech drains");

  // SFX should be delayed by speech drain (~500ms) + thinking delay (500ms) = ~1000ms
  const firstSfxDelay = sfx[0].timestamp - t0;
  assertGte(firstSfxDelay, 900, "Thinking SFX should wait for speech drain + 500ms delay");
});

test("9. New turn resets", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // First batch: 5 x 100ms chunks
  for (let i = 0; i < 5; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(600);
  send(proc, { type: "agent.complete" });
  await waitFor(100);

  // Second batch: 5 x 100ms chunks
  const t1 = Date.now();
  for (let i = 0; i < 5; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(200);
  killProc(proc);

  // Find speech chunks after t1 — they should burst (all within ~100ms)
  const speech = speechChunks(events);
  const secondBatch = speech.filter((e) => e.timestamp >= t1 - 10);
  if (secondBatch.length < 5) throw new Error(`Expected 5 chunks in second batch, got ${secondBatch.length}`);

  const batchSpan = secondBatch[secondBatch.length - 1].timestamp - secondBatch[0].timestamp;
  assertLte(batchSpan, 100, "Second batch should burst (all within ~100ms)");
});

test("10. Interrupt resets", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // First batch: 5 x 100ms chunks
  for (let i = 0; i < 5; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(100);
  send(proc, { type: "control.interrupt" });
  await waitFor(100);

  // Second batch: 5 x 100ms chunks
  const t1 = Date.now();
  for (let i = 0; i < 5; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(200);
  killProc(proc);

  const speech = speechChunks(events);
  const secondBatch = speech.filter((e) => e.timestamp >= t1 - 10);
  if (secondBatch.length < 5) throw new Error(`Expected 5 chunks in second batch, got ${secondBatch.length}`);

  const batchSpan = secondBatch[secondBatch.length - 1].timestamp - secondBatch[0].timestamp;
  assertLte(batchSpan, 100, "Second batch after interrupt should burst");
});

test("11. Mixed speech and SFX ordering", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // Speech segment 1
  for (let i = 0; i < 3; i++) {
    send(proc, makeAudioChunk(100));
  }

  // Wait for speech to drain, then tool_start (long tool)
  await waitFor(400);
  send(proc, { type: "agent.tool_start", tool: "long_tool" });

  // Wait for SFX to start
  await waitFor(600);

  // Tool done + more speech
  send(proc, { type: "agent.tool_done" });
  await waitFor(50);
  for (let i = 0; i < 3; i++) {
    send(proc, makeAudioChunk(100));
  }

  await waitFor(600);
  killProc(proc);

  const all = audioChunks(events);
  // Verify ordering: speech chunks, then sfx chunks, then speech chunks
  let phase: "speech1" | "sfx" | "speech2" = "speech1";
  for (const e of all) {
    const kind = e.event.kind;
    if (phase === "speech1" && kind === "sfx") {
      phase = "sfx";
    } else if (phase === "sfx" && kind === "speech") {
      phase = "speech2";
    } else if (phase === "speech1" && kind === "speech") {
      // still in first speech segment
    } else if (phase === "sfx" && kind === "sfx") {
      // still in sfx
    } else if (phase === "speech2" && kind === "speech") {
      // still in second speech
    } else if (phase === "speech2" && kind === "sfx") {
      throw new Error("SFX appeared after second speech segment — ordering violated");
    }
  }

  if (phase !== "speech2") {
    throw new Error(`Expected to reach speech2 phase, ended at ${phase}`);
  }
});

test("12. Empty queue no crash", async () => {
  const proc = spawnPlayer();
  const events = collectEvents(proc);
  await waitForReady(events);

  // Send agent.complete with no prior audio
  send(proc, { type: "agent.complete" });

  await waitFor(300);

  // Process should still be alive
  if (proc.exitCode !== null) {
    throw new Error(`Process crashed with exit code ${proc.exitCode}`);
  }

  // No audio chunks should have been emitted
  const audio = audioChunks(events);
  if (audio.length > 0) {
    throw new Error(`Expected no audio chunks, got ${audio.length}`);
  }

  killProc(proc);
});

// ---- Run ----

console.log("Audio player pacing tests\n");
runTests();
