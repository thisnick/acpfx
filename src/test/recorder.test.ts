import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../orchestrator.js";
import type { AnyEvent } from "../protocol.js";

const TMP_DIR = join(process.cwd(), "tmp-test-recorder");
const INPUT_WAV = join(TMP_DIR, "input.wav");
const RECORDINGS_DIR = join(TMP_DIR, "recordings");

function createTestWav(
  path: string,
  durationMs: number,
  sampleRate = 16000,
  channels = 1,
): void {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const bytesPerSample = 2;
  const dataSize = numSamples * channels * bytesPerSample;

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

  const pcm = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(
      16000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
    );
    for (let ch = 0; ch < channels; ch++) {
      pcm.writeInt16LE(sample, (i * channels + ch) * bytesPerSample);
    }
  }

  writeFileSync(path, Buffer.concat([header, pcm]));
}

describe("recorder node v2", () => {
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

  it("captures events to events.jsonl and audio to WAV", async () => {
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
    outputs: [recorder]
  recorder:
    use: "@acpfx/recorder"
    settings:
      outputDir: "${RECORDINGS_DIR}"
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    await orch.start();
    await sleep(2000);
    await orch.stop();
    orch = null;
    await sleep(1000);

    // Find the recording directory (has a random run ID)
    const dirs = readdirSync(RECORDINGS_DIR);
    assert.ok(dirs.length > 0, "Should create a recording directory");

    const runDir = join(RECORDINGS_DIR, dirs[0]);

    // Check events.jsonl exists and has content
    const eventsPath = join(runDir, "events.jsonl");
    assert.ok(existsSync(eventsPath), "events.jsonl should exist");
    const eventsContent = readFileSync(eventsPath, "utf-8").trim();
    const eventLines = eventsContent.split("\n").filter((l) => l.trim());
    assert.ok(
      eventLines.length > 0,
      `events.jsonl should have events (got ${eventLines.length})`,
    );

    // Verify events are valid JSON with type fields
    for (const line of eventLines.slice(0, 5)) {
      const ev = JSON.parse(line);
      assert.ok(typeof ev.type === "string", "Each event should have a type");
    }

    // Check audio WAV exists
    const micWav = join(runDir, "mic.wav");
    assert.ok(existsSync(micWav), "mic.wav should exist");
    const wavData = readFileSync(micWav);
    assert.equal(wavData.toString("ascii", 0, 4), "RIFF", "Should be valid WAV");
    assert.ok(wavData.length > 44, "WAV should have audio data");
  });

  it("generates timeline.html", async () => {
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
    outputs: [recorder]
  recorder:
    use: "@acpfx/recorder"
    settings:
      outputDir: "${RECORDINGS_DIR}"
    outputs: []
`,
      {
        onEvent: (e) => events.push(e),
        readyTimeoutMs: 5000,
      },
    );

    await orch.start();
    await sleep(2000);
    await orch.stop();
    orch = null;
    await sleep(1000);

    const dirs = readdirSync(RECORDINGS_DIR);
    // Use the latest directory
    const runDir = join(RECORDINGS_DIR, dirs[dirs.length - 1]);

    const htmlPath = join(runDir, "timeline.html");
    assert.ok(existsSync(htmlPath), "timeline.html should exist");

    const html = readFileSync(htmlPath, "utf-8");
    assert.ok(html.includes("WaveSurfer"), "Should reference WaveSurfer.js");
    assert.ok(html.includes("acpfx Timeline"), "Should have title");
    assert.ok(
      html.includes("data:audio/wav;base64,"),
      "Should embed audio as base64",
    );
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
