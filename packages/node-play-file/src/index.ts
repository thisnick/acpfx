/**
 * play-file node — reads audio.chunk events from stdin and writes a WAV file.
 * Handles control.interrupt by stopping and finalizing the WAV header.
 *
 * Settings (via ACPFX_SETTINGS):
 *   path: string — output WAV file path
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

type Settings = {
  path: string;
};

const settings: Settings = JSON.parse(
  process.env.ACPFX_SETTINGS || "{}",
);

if (!settings.path) {
  log.error("settings.path is required");
  process.exit(1);
}

const filePath = resolve(settings.path);
let stream: WriteStream | null = null;
let bytesWritten = 0;
let sampleRate = 16000;
let channels = 1;
let started = false;

function createWavHeader(dataSize: number, sr: number, ch: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sr * ch * bitsPerSample) / 8;
  const blockAlign = (ch * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  let off = 0;

  header.write("RIFF", off); off += 4;
  header.writeUInt32LE(dataSize + 36, off); off += 4;
  header.write("WAVE", off); off += 4;
  header.write("fmt ", off); off += 4;
  header.writeUInt32LE(16, off); off += 4;
  header.writeUInt16LE(1, off); off += 2;
  header.writeUInt16LE(ch, off); off += 2;
  header.writeUInt32LE(sr, off); off += 4;
  header.writeUInt32LE(byteRate, off); off += 4;
  header.writeUInt16LE(blockAlign, off); off += 2;
  header.writeUInt16LE(bitsPerSample, off); off += 2;
  header.write("data", off); off += 4;
  header.writeUInt32LE(dataSize, off);

  return header;
}

function startWriting(): void {
  if (started) return;
  started = true;
  stream = createWriteStream(filePath);
  bytesWritten = 0;
  // Write placeholder WAV header
  stream.write(Buffer.alloc(44));
}

async function finalize(): Promise<void> {
  if (!stream) return;

  await new Promise<void>((resolve, reject) => {
    stream!.end(() => resolve());
    stream!.on("error", reject);
  });

  // Update WAV header with correct sizes
  const header = createWavHeader(bytesWritten, sampleRate, channels);
  const fd = await open(filePath, "r+");
  await fd.write(header, 0, header.length, 0);
  await fd.close();

  stream = null;
}

// Emit lifecycle.ready
emit({ type: "lifecycle.ready", component: "play-file" });

const rl = onEvent((event) => {
  if (event.type === "audio.chunk") {
    startWriting();
    // Capture format from first chunk
    if (bytesWritten === 0) {
      sampleRate = (event.sampleRate as number) ?? 16000;
      channels = (event.channels as number) ?? 1;
    }
    const pcm = Buffer.from(event.data as string, "base64");
    if (stream?.writable) {
      stream.write(pcm);
      bytesWritten += pcm.length;
    }
  } else if (event.type === "control.interrupt") {
    finalize().then(() => {
      emit({ type: "lifecycle.done", component: "play-file" });
      process.exit(0);
    });
  } else if (event.type === "lifecycle.done") {
    finalize().then(() => {
      emit({ type: "lifecycle.done", component: "play-file" });
      process.exit(0);
    });
  }
});

rl.on("close", () => {
  // stdin EOF — finalize and exit
  finalize().then(() => {
    emit({ type: "lifecycle.done", component: "play-file" });
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  finalize().then(() => process.exit(0));
});
