/**
 * Sox-based audio providers for live microphone capture and speaker playback.
 *
 * Requires `sox` to be installed: `brew install sox`
 *
 * SoxCaptureProvider: captures audio from the default microphone via `rec`.
 * SoxPlaybackProvider: plays audio to the default speaker via `play`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  AudioCaptureProvider,
  AudioCaptureChunk,
  AudioPlaybackProvider,
  AudioFormat,
} from "./types.js";

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(
  (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000,
);

export class SoxCaptureProvider implements AudioCaptureProvider {
  private _format: AudioFormat = {
    format: "pcm_s16le",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  };

  get format(): AudioFormat {
    return this._format;
  }

  async *capture(signal?: AbortSignal): AsyncGenerator<AudioCaptureChunk> {
    // `rec` is part of sox: captures from default microphone
    const proc = spawn("rec", [
      "-q",              // quiet
      "-t", "raw",       // raw PCM output
      "-b", "16",        // 16-bit
      "-e", "signed-integer",
      "-r", String(SAMPLE_RATE),
      "-c", String(CHANNELS),
      "--endian", "little",
      "-",               // stdout
    ], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const cleanup = () => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    };

    signal?.addEventListener("abort", cleanup, { once: true });

    let buffer = Buffer.alloc(0);
    let done = false;
    let resolveWait: (() => void) | null = null;
    let error: Error | null = null;

    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      resolveWait?.();
    });

    proc.stdout!.on("end", () => {
      done = true;
      resolveWait?.();
    });

    proc.on("error", (err) => {
      error = err;
      done = true;
      resolveWait?.();
    });

    proc.on("close", () => {
      done = true;
      resolveWait?.();
    });

    try {
      while (!done || buffer.length >= CHUNK_SIZE) {
        if (signal?.aborted) break;

        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.subarray(0, CHUNK_SIZE);
          buffer = buffer.subarray(CHUNK_SIZE);
          const durationMs = CHUNK_DURATION_MS;
          yield { data: Buffer.from(chunk), durationMs };
        }

        if (done) break;

        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
        resolveWait = null;
      }

      // Flush remaining
      if (buffer.length > 0 && !signal?.aborted) {
        const durationMs = Math.floor(
          (buffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000,
        );
        yield { data: Buffer.from(buffer), durationMs };
      }

      if (error) throw error;
    } finally {
      cleanup();
      signal?.removeEventListener("abort", cleanup);
    }
  }
}

export class SoxPlaybackProvider implements AudioPlaybackProvider {
  private _proc: ChildProcess | null = null;
  private _format: AudioFormat = {
    format: "pcm_s16le",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  };

  get format(): AudioFormat {
    return this._format;
  }

  async start(): Promise<void> {
    // `play` is part of sox: plays to default speaker
    this._proc = spawn("play", [
      "-q",              // quiet
      "-t", "raw",       // raw PCM input
      "-b", "16",        // 16-bit
      "-e", "signed-integer",
      "-r", String(SAMPLE_RATE),
      "-c", String(CHANNELS),
      "--endian", "little",
      "-",               // stdin
    ], {
      stdio: ["pipe", "ignore", "ignore"],
    });

    this._proc.on("error", (err) => {
      process.stderr.write(`[acpfx:play] sox error: ${err.message}\n`);
    });
  }

  async write(data: Buffer): Promise<void> {
    if (!this._proc?.stdin) throw new Error("Playback not started");
    const ok = this._proc.stdin.write(data);
    if (!ok) {
      await new Promise<void>((resolve) => {
        this._proc!.stdin!.once("drain", resolve);
      });
    }
  }

  async flush(): Promise<void> {
    // Stream-based; auto-flushed
  }

  async close(): Promise<void> {
    if (!this._proc) return;
    const proc = this._proc;
    this._proc = null;

    await new Promise<void>((resolve) => {
      proc.stdin?.end(() => {
        proc.once("close", () => resolve());
      });
    });
  }
}
