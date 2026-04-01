/**
 * mic-file node — reads a WAV file and emits audio.chunk events with real-time pacing.
 * Also emits audio.level events with computed RMS energy.
 *
 * Settings (via ACPFX_SETTINGS):
 *   path: string       — path to WAV file
 *   realtime?: boolean  — pace at real-time rate (default: true)
 *   chunkMs?: number    — chunk duration in ms (default: 100)
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

type Settings = {
  path: string;
  realtime?: boolean;
  chunkMs?: number;
};

const settings: Settings = JSON.parse(
  process.env.ACPFX_SETTINGS || "{}",
);

if (!settings.path) {
  process.stderr.write("[mic-file] ERROR: settings.path is required\n");
  process.exit(1);
}

const CHUNK_MS = settings.chunkMs ?? 100;
const REALTIME = settings.realtime ?? true;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const TRACK_ID = "mic";

let interrupted = false;

// Handle control.interrupt from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    if (event.type === "control.interrupt") {
      interrupted = true;
    }
  } catch {
    // ignore
  }
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  interrupted = true;
  process.exit(0);
});

// --- WAV parsing ---

type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
};

function parseWavHeader(data: Buffer): WavInfo {
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = 44;

  while (offset + 8 <= data.length) {
    const chunkId = data.toString("ascii", offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      channels = data.readUInt16LE(offset + 10);
      sampleRate = data.readUInt32LE(offset + 12);
      bitsPerSample = data.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1;
  }

  return { sampleRate, channels, bitsPerSample, dataOffset };
}

// --- Audio level computation ---

function computeLevel(pcm: Buffer): { rms: number; peak: number; dbfs: number } {
  const samples = pcm.length / BYTES_PER_SAMPLE;
  if (samples === 0) return { rms: 0, peak: 0, dbfs: -Infinity };

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(i);
    sumSq += sample * sample;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSq / samples);
  const dbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity;

  return { rms: Math.round(rms), peak, dbfs: Math.round(dbfs * 10) / 10 };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

async function main() {
  const filePath = resolve(settings.path);
  const fileData = readFileSync(filePath);

  let sampleRate = 16000;
  let channels = 1;
  let pcmData: Buffer;

  // Parse WAV header if present
  if (
    fileData.length > 44 &&
    fileData.toString("ascii", 0, 4) === "RIFF" &&
    fileData.toString("ascii", 8, 12) === "WAVE"
  ) {
    const wavInfo = parseWavHeader(fileData);
    sampleRate = wavInfo.sampleRate;
    channels = wavInfo.channels;
    pcmData = fileData.subarray(wavInfo.dataOffset);
  } else {
    pcmData = fileData;
  }

  const bytesPerFrame = channels * BYTES_PER_SAMPLE;
  const chunkSize = Math.floor((sampleRate * channels * BYTES_PER_SAMPLE * CHUNK_MS) / 1000);

  // Emit lifecycle.ready
  emit({ type: "lifecycle.ready", component: "mic-file" });

  let offset = 0;
  while (offset < pcmData.length && !interrupted) {
    const end = Math.min(offset + chunkSize, pcmData.length);
    const chunk = pcmData.subarray(offset, end);
    const durationMs = Math.round((chunk.length / (sampleRate * bytesPerFrame)) * 1000);

    // Emit audio.chunk
    emit({
      type: "audio.chunk",
      trackId: TRACK_ID,
      format: "pcm_s16le",
      sampleRate,
      channels,
      data: Buffer.from(chunk).toString("base64"),
      durationMs,
    });

    // Emit audio.level
    const level = computeLevel(chunk);
    emit({
      type: "audio.level",
      trackId: TRACK_ID,
      rms: level.rms,
      peak: level.peak,
      dbfs: level.dbfs,
    });

    offset = end;

    // Pace at real-time rate
    if (REALTIME && offset < pcmData.length) {
      await sleep(durationMs);
    }
  }

  // Emit lifecycle.done
  emit({ type: "lifecycle.done", component: "mic-file" });
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[mic-file] Fatal: ${err.message}\n`);
  process.exit(1);
});
