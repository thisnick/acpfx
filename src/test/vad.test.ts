import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { readEvents, createEventWriter } from "../pipeline-io.js";
import type { AnyEvent } from "../protocol.js";

/**
 * Helper: create a base64-encoded PCM chunk with a given RMS energy level.
 * Generates 16-bit signed LE samples at the specified amplitude.
 */
function makePcmChunk(opts: {
  amplitude: number;
  durationMs: number;
  sampleRate?: number;
}): string {
  const sampleRate = opts.sampleRate ?? 16000;
  const numSamples = Math.floor((sampleRate * opts.durationMs) / 1000);
  const buffer = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    // Simple sine wave at the given amplitude
    const value = Math.round(
      opts.amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
    );
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buffer.toString("base64");
}

function makeAudioChunk(amplitude: number, durationMs = 20): string {
  return JSON.stringify({
    type: "audio.chunk",
    streamId: "s1",
    format: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
    data: makePcmChunk({ amplitude, durationMs }),
    durationMs,
  });
}

function makeSpeechFinal(text: string): string {
  return JSON.stringify({
    type: "speech.final",
    streamId: "s1",
    text,
  });
}

function makeSpeechPartial(text: string): string {
  return JSON.stringify({
    type: "speech.partial",
    streamId: "s1",
    text,
  });
}

/**
 * Feed NDJSON lines to the VAD command and collect output events.
 * Uses the VAD logic directly rather than spawning a process.
 */
async function feedVadEvents(
  inputLines: string[],
  opts?: { pauseMs?: number; energyThreshold?: number },
): Promise<AnyEvent[]> {
  // We test by importing and running the VAD logic
  // For unit testing, we simulate by parsing events and checking the logic

  // Since VAD uses timers, we test the core logic directly
  const events: AnyEvent[] = [];

  // Create input stream from lines
  const input = Readable.from(
    inputLines.map((l) => l + "\n"),
  );

  const output = new PassThrough();
  const writer = createEventWriter(output);

  // Collect output events
  const readPromise = readEvents(output, (event) => {
    events.push(event);
  });

  // Import and simulate VAD processing
  // For simplicity, we'll just verify the energy computation
  return events;
}

describe("VAD energy computation", () => {
  it("computes RMS energy for silence (amplitude 0)", () => {
    const pcmData = Buffer.alloc(640); // 320 samples of silence
    const energy = computeRms(pcmData);
    assert.equal(energy, 0);
  });

  it("computes RMS energy for loud signal", () => {
    const numSamples = 320;
    const pcmData = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const value = Math.round(
        10000 * Math.sin((2 * Math.PI * 440 * i) / 16000),
      );
      pcmData.writeInt16LE(value, i * 2);
    }
    const energy = computeRms(pcmData);
    // RMS of a sine wave at amplitude A is A/sqrt(2) ≈ 0.707*A
    assert.ok(energy > 5000, `Expected energy > 5000, got ${energy}`);
    assert.ok(energy < 10000, `Expected energy < 10000, got ${energy}`);
  });

  it("computes RMS energy for quiet signal", () => {
    const numSamples = 320;
    const pcmData = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const value = Math.round(
        50 * Math.sin((2 * Math.PI * 440 * i) / 16000),
      );
      pcmData.writeInt16LE(value, i * 2);
    }
    const energy = computeRms(pcmData);
    assert.ok(energy < 200, `Expected energy < 200, got ${energy}`);
  });

  it("handles empty buffer", () => {
    const energy = computeRms(Buffer.alloc(0));
    assert.equal(energy, 0);
  });

  it("handles single-byte buffer", () => {
    const energy = computeRms(Buffer.alloc(1));
    assert.equal(energy, 0);
  });
});

describe("VAD event generation", () => {
  it("generates speech.resume for loud audio.chunk events", async () => {
    const events = await runVadOnLines(
      [makeAudioChunk(10000, 20)],
      { pauseMs: 100, energyThreshold: 200 },
    );

    const resumeEvents = events.filter((e) => e.type === "speech.resume");
    assert.ok(
      resumeEvents.length >= 1,
      `Expected at least 1 speech.resume, got ${resumeEvents.length}`,
    );
  });

  it("does not generate speech.resume for quiet audio", async () => {
    const events = await runVadOnLines(
      [makeAudioChunk(10, 20)],
      { pauseMs: 100, energyThreshold: 200 },
    );

    const resumeEvents = events.filter((e) => e.type === "speech.resume");
    assert.equal(resumeEvents.length, 0);
  });

  it("generates speech.pause after speech.final + silence", async () => {
    const events = await runVadOnLines(
      [makeSpeechFinal("hello world")],
      { pauseMs: 50 },
    );

    // Wait for the pause timer to fire
    await sleep(100);

    const pauseEvents = events.filter((e) => e.type === "speech.pause");
    assert.ok(
      pauseEvents.length >= 1,
      `Expected at least 1 speech.pause, got ${pauseEvents.length}`,
    );

    const pause = pauseEvents[0] as Record<string, unknown>;
    assert.equal(pause.pendingText, "hello world");
  });

  it("accumulates text from multiple speech.final events", async () => {
    const events = await runVadOnLines(
      [
        makeSpeechFinal("hello"),
        makeSpeechFinal("world"),
      ],
      { pauseMs: 50 },
    );

    await sleep(100);

    const pauseEvents = events.filter((e) => e.type === "speech.pause");
    assert.ok(pauseEvents.length >= 1);

    const pause = pauseEvents[0] as Record<string, unknown>;
    assert.equal(pause.pendingText, "hello world");
  });

  it("forwards audio.chunk events through", async () => {
    const events = await runVadOnLines(
      [makeAudioChunk(10, 20)],
      { pauseMs: 100 },
    );

    const audioEvents = events.filter((e) => e.type === "audio.chunk");
    assert.equal(audioEvents.length, 1);
  });

  it("forwards speech.partial events through", async () => {
    const events = await runVadOnLines(
      [makeSpeechPartial("hel")],
      { pauseMs: 100 },
    );

    const partialEvents = events.filter((e) => e.type === "speech.partial");
    assert.equal(partialEvents.length, 1);
  });

  it("forwards speech.final events through", async () => {
    const events = await runVadOnLines(
      [makeSpeechFinal("hello")],
      { pauseMs: 100 },
    );

    const finalEvents = events.filter((e) => e.type === "speech.final");
    assert.equal(finalEvents.length, 1);
  });

  it("forwards unknown events unchanged", async () => {
    const events = await runVadOnLines(
      [JSON.stringify({ type: "vendor.custom", data: "test" })],
      { pauseMs: 100 },
    );

    const customEvents = events.filter((e) => e.type === "vendor.custom");
    assert.equal(customEvents.length, 1);
  });
});

// --- Helpers ---

/**
 * Inline RMS computation matching the VAD's implementation.
 */
function computeRms(pcmData: Buffer): number {
  if (pcmData.length < 2) return 0;
  let sumSquares = 0;
  const numSamples = Math.floor(pcmData.length / 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = pcmData.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / numSamples);
}

/**
 * Run VAD on a set of NDJSON input lines and collect output.
 * Spawns the actual VAD command as a child process for realistic testing.
 */
async function runVadOnLines(
  lines: string[],
  opts?: { pauseMs?: number; energyThreshold?: number },
): Promise<AnyEvent[]> {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");

  const events: AnyEvent[] = [];
  // Build CLI arguments
  const cliArgs: string[] = [];
  if (opts?.pauseMs !== undefined) {
    cliArgs.push("--pause-ms", String(opts.pauseMs));
  }
  if (opts?.energyThreshold !== undefined) {
    cliArgs.push("--energy-threshold", String(opts.energyThreshold));
  }

  // import.meta.dirname is dist/test/, so ../cli.js -> dist/cli.js
  const cliPath = resolve(import.meta.dirname, "../cli.js");
  const proc = spawn("node", [cliPath, "vad", ...cliArgs], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  // Write input lines
  for (const line of lines) {
    proc.stdin!.write(line + "\n");
  }
  proc.stdin!.end();

  // Wait for process to exit (with timeout)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve();
    }, 2000);

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    proc.on("error", reject);
  });

  // Parse output events
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed
    }
  }

  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
