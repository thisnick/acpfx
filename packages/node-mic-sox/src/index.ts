/**
 * mic-sox node — live microphone capture via sox `rec` command.
 * Emits audio.chunk and audio.level events.
 *
 * Settings (via ACPFX_SETTINGS):
 *   sampleRate?: number  — sample rate (default: 16000)
 *   channels?: number    — channels (default: 1)
 *   chunkMs?: number     — chunk duration in ms (default: 100)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

type Settings = {
  sampleRate?: number;
  channels?: number;
  chunkMs?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const SAMPLE_RATE = settings.sampleRate ?? 16000;
const CHANNELS = settings.channels ?? 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = settings.chunkMs ?? 100;
const CHUNK_SIZE = Math.floor(
  (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_MS) / 1000,
);
const TRACK_ID = "mic";

let recProc: ChildProcess | null = null;
let interrupted = false;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[mic-sox] ${msg}\n`);
}

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

function cleanup(): void {
  if (recProc && !recProc.killed) {
    recProc.kill("SIGTERM");
  }
}

// Handle control.interrupt from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    if (event.type === "control.interrupt") {
      interrupted = true;
      cleanup();
    }
  } catch {}
});

rl.on("close", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// --- Main ---

recProc = spawn("rec", [
  "-q",
  "-t", "raw",       // output format: raw PCM
  "-b", "16",
  "-e", "signed-integer",
  "-r", String(SAMPLE_RATE),
  "-c", String(CHANNELS),
  "--endian", "little",
  "-",
  "rate", String(SAMPLE_RATE),   // resample to target rate
  "channels", String(CHANNELS),  // downmix to mono
], {
  stdio: ["ignore", "pipe", "pipe"],
});

recProc.stderr?.on("data", (data: Buffer) => {
  // sox may emit warnings to stderr
  log(data.toString().trim());
});

recProc.on("error", (err) => {
  log(`rec error: ${err.message}`);
  emit({
    type: "control.error",
    component: "mic-sox",
    message: `sox rec failed: ${err.message}`,
    fatal: true,
  });
  process.exit(1);
});

// Emit lifecycle.ready
emit({ type: "lifecycle.ready", component: "mic-sox" });

let buffer = Buffer.alloc(0);

recProc.stdout!.on("data", (chunk: Buffer) => {
  if (interrupted) return;

  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length >= CHUNK_SIZE && !interrupted) {
    const pcmChunk = buffer.subarray(0, CHUNK_SIZE);
    buffer = buffer.subarray(CHUNK_SIZE);

    const durationMs = CHUNK_MS;

    emit({
      type: "audio.chunk",
      trackId: TRACK_ID,
      format: "pcm_s16le",
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      data: Buffer.from(pcmChunk).toString("base64"),
      durationMs,
    });

    const level = computeLevel(pcmChunk);
    emit({
      type: "audio.level",
      trackId: TRACK_ID,
      rms: level.rms,
      peak: level.peak,
      dbfs: level.dbfs,
    });
  }
});

recProc.stdout!.on("end", () => {
  // Flush remaining
  if (buffer.length > 0 && !interrupted) {
    const durationMs = Math.round(
      (buffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000,
    );
    emit({
      type: "audio.chunk",
      trackId: TRACK_ID,
      format: "pcm_s16le",
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      data: Buffer.from(buffer).toString("base64"),
      durationMs,
    });
  }
  emit({ type: "lifecycle.done", component: "mic-sox" });
  process.exit(0);
});

recProc.on("close", () => {
  if (!interrupted) {
    emit({ type: "lifecycle.done", component: "mic-sox" });
  }
  process.exit(0);
});
