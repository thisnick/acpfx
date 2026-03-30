/**
 * File-based audio providers for testing (no microphone/speaker needed).
 *
 * FileCaptureProvider: reads a WAV file and emits audio chunks paced at real-time rate.
 * FilePlaybackProvider: writes incoming PCM audio to a WAV file.
 */

import * as fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import type {
  AudioCaptureProvider,
  AudioCaptureChunk,
  AudioPlaybackProvider,
  AudioFormat,
} from "./types.js";

const DEFAULT_CHUNK_MS = 100;
const BYTES_PER_SAMPLE = 2; // 16-bit

export class FileCaptureProvider implements AudioCaptureProvider {
  private _path: string;
  private _chunkMs: number;
  private _realtime: boolean;
  private _format: AudioFormat;

  constructor(opts: {
    path: string;
    chunkMs?: number;
    realtime?: boolean;
  }) {
    this._path = opts.path;
    this._chunkMs = opts.chunkMs ?? DEFAULT_CHUNK_MS;
    this._realtime = opts.realtime ?? true;
    // Default format; will be overridden by WAV header if present
    this._format = {
      format: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    };
  }

  get format(): AudioFormat {
    return this._format;
  }

  async *capture(signal?: AbortSignal): AsyncGenerator<AudioCaptureChunk> {
    const fileData = await fs.readFile(this._path);

    // Parse WAV header if present
    let pcmData: Buffer;
    if (
      fileData.length > 44 &&
      fileData.toString("ascii", 0, 4) === "RIFF" &&
      fileData.toString("ascii", 8, 12) === "WAVE"
    ) {
      const wavInfo = parseWavHeader(fileData);
      this._format = {
        format: "pcm_s16le",
        sampleRate: wavInfo.sampleRate,
        channels: wavInfo.channels,
      };
      pcmData = fileData.subarray(wavInfo.dataOffset);
    } else {
      // Assume raw PCM
      pcmData = fileData;
    }

    const chunkSize = Math.floor(
      (this._format.sampleRate *
        this._format.channels *
        BYTES_PER_SAMPLE *
        this._chunkMs) /
        1000,
    );

    let offset = 0;
    while (offset < pcmData.length) {
      if (signal?.aborted) return;

      const end = Math.min(offset + chunkSize, pcmData.length);
      const chunk = pcmData.subarray(offset, end);
      const durationMs = Math.floor(
        (chunk.length /
          (this._format.sampleRate *
            this._format.channels *
            BYTES_PER_SAMPLE)) *
          1000,
      );

      yield { data: Buffer.from(chunk), durationMs };
      offset = end;

      // Pace at real-time rate if enabled
      if (this._realtime && offset < pcmData.length) {
        await sleep(durationMs, signal);
      }
    }
  }
}

export class FilePlaybackProvider implements AudioPlaybackProvider {
  private _path: string;
  private _format: AudioFormat;
  private _stream: WriteStream | null = null;
  private _bytesWritten = 0;

  constructor(opts: { path: string }) {
    this._path = opts.path;
    this._format = {
      format: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    };
  }

  get format(): AudioFormat {
    return this._format;
  }

  async start(): Promise<void> {
    this._stream = createWriteStream(this._path);
    this._bytesWritten = 0;
    // Write a placeholder WAV header (will be updated on close)
    const header = Buffer.alloc(44);
    this._stream.write(header);
  }

  async write(data: Buffer): Promise<void> {
    if (!this._stream) throw new Error("Playback not started");
    const ok = this._stream.write(data);
    this._bytesWritten += data.length;
    if (!ok) {
      await new Promise<void>((resolve) => {
        this._stream!.once("drain", resolve);
      });
    }
  }

  async flush(): Promise<void> {
    // Node streams auto-flush; nothing extra needed
  }

  async close(): Promise<void> {
    if (!this._stream) return;

    await new Promise<void>((resolve, reject) => {
      this._stream!.end(() => resolve());
      this._stream!.on("error", reject);
    });

    // Update the WAV header with correct sizes
    const header = createWavHeader(
      this._bytesWritten,
      this._format.sampleRate,
      this._format.channels,
    );
    const fd = await fs.open(this._path, "r+");
    await fd.write(header, 0, header.length, 0);
    await fd.close();

    this._stream = null;
  }
}

// --- WAV helpers ---

type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
};

function parseWavHeader(data: Buffer): WavInfo {
  // Find "fmt " chunk
  let offset = 12; // skip RIFF header
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
    // Align to 2-byte boundary
    if (chunkSize % 2 !== 0) offset += 1;
  }

  return { sampleRate, channels, bitsPerSample, dataOffset };
}

function createWavHeader(
  dataSize: number,
  sampleRate: number,
  channels: number,
): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  let off = 0;

  header.write("RIFF", off);
  off += 4;
  header.writeUInt32LE(dataSize + 36, off); // file size - 8
  off += 4;
  header.write("WAVE", off);
  off += 4;

  header.write("fmt ", off);
  off += 4;
  header.writeUInt32LE(16, off); // fmt chunk size
  off += 4;
  header.writeUInt16LE(1, off); // PCM
  off += 2;
  header.writeUInt16LE(channels, off);
  off += 2;
  header.writeUInt32LE(sampleRate, off);
  off += 4;
  header.writeUInt32LE(byteRate, off);
  off += 4;
  header.writeUInt16LE(blockAlign, off);
  off += 2;
  header.writeUInt16LE(bitsPerSample, off);
  off += 2;

  header.write("data", off);
  off += 4;
  header.writeUInt32LE(dataSize, off);

  return header;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
