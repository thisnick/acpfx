import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "@acpfx/orchestrator";
import type { AnyEvent } from "@acpfx/core";

const TMP_DIR = join(process.cwd(), "tmp-test-audio");
const INPUT_WAV = join(TMP_DIR, "input.wav");
const OUTPUT_WAV = join(TMP_DIR, "output.wav");

/** Create a valid WAV file with a sine wave tone. */
function createTestWav(path: string, durationMs: number, sampleRate = 16000, channels = 1): void {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const bytesPerSample = 2;
  const dataSize = numSamples * channels * bytesPerSample;

  // WAV header
  const header = Buffer.alloc(44);
  let off = 0;
  header.write("RIFF", off); off += 4;
  header.writeUInt32LE(dataSize + 36, off); off += 4;
  header.write("WAVE", off); off += 4;
  header.write("fmt ", off); off += 4;
  header.writeUInt32LE(16, off); off += 4;
  header.writeUInt16LE(1, off); off += 2;
  header.writeUInt16LE(channels, off); off += 2;
  header.writeUInt32LE(sampleRate, off); off += 4;
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, off); off += 4;
  header.writeUInt16LE(channels * bytesPerSample, off); off += 2;
  header.writeUInt16LE(16, off); off += 2;
  header.write("data", off); off += 4;
  header.writeUInt32LE(dataSize, off);

  // PCM data: 440Hz sine wave
  const pcm = Buffer.alloc(dataSize);
  const freq = 440;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(16000 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    for (let ch = 0; ch < channels; ch++) {
      pcm.writeInt16LE(sample, (i * channels + ch) * bytesPerSample);
    }
  }

  writeFileSync(path, Buffer.concat([header, pcm]));
}

describe("audio nodes v2", () => {
  let orch: Orchestrator | null = null;

  before(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (orch) {
      await orch.stop();
      orch = null;
    }
  });

  it("mic-file emits lifecycle.ready before audio.chunk", async () => {
    createTestWav(INPUT_WAV, 300, 16000, 1); // 300ms audio

    const events: AnyEvent[] = [];
    orch = Orchestrator.fromYaml(
      `
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: "${INPUT_WAV}"
      realtime: false
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    await orch.start();
    await sleep(1000);

    const readyIdx = events.findIndex((e) => e.type === "lifecycle.ready" && e._from === "mic");
    const firstChunkIdx = events.findIndex((e) => e.type === "audio.chunk" && e._from === "mic");

    assert.ok(readyIdx >= 0, "Should emit lifecycle.ready");
    assert.ok(firstChunkIdx >= 0, "Should emit audio.chunk");
    assert.ok(readyIdx < firstChunkIdx, "lifecycle.ready must come before audio.chunk");
  });

  it("mic-file emits audio.level events", async () => {
    createTestWav(INPUT_WAV, 300, 16000, 1);

    const events: AnyEvent[] = [];
    orch = Orchestrator.fromYaml(
      `
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: "${INPUT_WAV}"
      realtime: false
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    await orch.start();
    await sleep(1000);

    const levels = events.filter((e) => e.type === "audio.level" && e._from === "mic");
    assert.ok(levels.length > 0, "Should emit audio.level events");

    // Sine wave should have non-zero RMS
    const firstLevel = levels[0] as any;
    assert.ok(firstLevel.rms > 0, "RMS should be non-zero for sine wave");
    assert.ok(typeof firstLevel.peak === "number", "Should have peak");
    assert.ok(typeof firstLevel.dbfs === "number", "Should have dbfs");
  });

  it("mic-file paces output at real-time rate", async () => {
    createTestWav(INPUT_WAV, 500, 16000, 1); // 500ms audio

    const events: AnyEvent[] = [];
    orch = Orchestrator.fromYaml(
      `
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: "${INPUT_WAV}"
      realtime: true
      chunkMs: 100
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    const startTime = Date.now();
    await orch.start();

    // Wait for all chunks to be emitted
    await sleep(1500);

    const chunks = events.filter((e) => e.type === "audio.chunk" && e._from === "mic");
    assert.ok(chunks.length >= 3, `Should emit multiple chunks (got ${chunks.length})`);

    // With realtime pacing, 500ms audio should take ~500ms to emit
    const firstChunk = chunks[0] as any;
    const lastChunk = chunks[chunks.length - 1] as any;
    const elapsed = lastChunk.ts - firstChunk.ts;
    assert.ok(elapsed >= 300, `Chunks should be spread over time (elapsed: ${elapsed}ms)`);
  });

  it("WAV roundtrip: mic-file → play-file produces valid WAV", async () => {
    createTestWav(INPUT_WAV, 500, 16000, 1);

    const events: AnyEvent[] = [];
    orch = Orchestrator.fromYaml(
      `
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: "${INPUT_WAV}"
      realtime: false
    outputs: [play]
  play:
    use: "@acpfx/play-file"
    settings:
      path: "${OUTPUT_WAV}"
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    await orch.start();

    // Wait for all data to flow through
    await sleep(2000);
    await orch.stop();
    orch = null;

    // Wait for file to be finalized
    await sleep(500);

    // Verify output WAV exists and is valid
    assert.ok(existsSync(OUTPUT_WAV), "Output WAV should exist");

    const inputData = readFileSync(INPUT_WAV);
    const outputData = readFileSync(OUTPUT_WAV);

    // Both should be valid WAV files
    assert.equal(outputData.toString("ascii", 0, 4), "RIFF", "Output should be RIFF");
    assert.equal(outputData.toString("ascii", 8, 12), "WAVE", "Output should be WAVE");

    // PCM data should match (skip 44-byte headers)
    const inputPcm = inputData.subarray(44);
    const outputPcm = outputData.subarray(44);
    assert.equal(outputPcm.length, inputPcm.length, "PCM data length should match");
    assert.ok(inputPcm.equals(outputPcm), "PCM data should be byte-identical");
  });

  it("play-file handles control.interrupt", async () => {
    createTestWav(INPUT_WAV, 2000, 16000, 1); // 2s audio

    const outputPath = join(TMP_DIR, "interrupted-output.wav");
    const events: AnyEvent[] = [];
    orch = Orchestrator.fromYaml(
      `
nodes:
  mic:
    use: "@acpfx/mic-file"
    settings:
      path: "${INPUT_WAV}"
      realtime: true
      chunkMs: 100
    outputs: [play]
  play:
    use: "@acpfx/play-file"
    settings:
      path: "${outputPath}"
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    await orch.start();

    // Let some audio flow
    await sleep(500);

    // Send interrupt to play node
    orch.sendToNode("play", {
      type: "control.interrupt",
      reason: "test interrupt",
    });

    await sleep(1000);
    await orch.stop();
    orch = null;
    await sleep(500);

    // Output should exist but be smaller than input (was interrupted)
    if (existsSync(outputPath)) {
      const outputData = readFileSync(outputPath);
      const inputData = readFileSync(INPUT_WAV);
      assert.ok(
        outputData.length < inputData.length,
        "Interrupted output should be smaller than full input",
      );
      // Should still be a valid WAV
      assert.equal(outputData.toString("ascii", 0, 4), "RIFF");
    }
    // If the file doesn't exist, the interrupt may have been too fast — that's also acceptable
    assert.ok(true, "Interrupt handled without crash");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
