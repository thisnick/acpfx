/**
 * macOS `say` TTS provider — zero-dependency fallback for testing.
 *
 * Uses the `say` command to generate AIFF audio, then converts to raw PCM
 * via `afconvert` (both ship with macOS).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TtsProvider, TtsChunk } from "./types.js";

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FORMAT = "pcm_s16le";
const CHUNK_DURATION_MS = 100;
const BYTES_PER_SAMPLE = 2; // 16-bit
const CHUNK_SIZE = Math.floor((SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000);

export class SayProvider implements TtsProvider {
  private _voice: string;

  constructor(opts?: { voice?: string }) {
    this._voice = opts?.voice ?? "Samantha";
  }

  async *synthesize(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TtsChunk> {
    if (signal?.aborted) return;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpfx-say-"));
    const aiffPath = path.join(tmpDir, "out.aiff");
    const pcmPath = path.join(tmpDir, "out.raw");

    try {
      // Generate AIFF with `say`
      await execFileAsync("say", ["-v", this._voice, "-o", aiffPath, text], signal);
      if (signal?.aborted) return;

      // Convert AIFF to raw PCM with `afconvert`
      await execFileAsync(
        "afconvert",
        [
          "-f", "WAVE",
          "-d", "LEI16",
          "-c", String(CHANNELS),
          "-r", String(SAMPLE_RATE),
          aiffPath,
          pcmPath,
        ],
        signal,
      );
      if (signal?.aborted) return;

      // Read PCM data and emit chunks
      const rawData = await fs.readFile(pcmPath);
      // WAV header is 44 bytes, skip it for raw PCM
      const pcmData = rawData.subarray(44);

      let offset = 0;
      while (offset < pcmData.length) {
        if (signal?.aborted) return;
        const end = Math.min(offset + CHUNK_SIZE, pcmData.length);
        const chunk = pcmData.subarray(offset, end);
        const durationMs = Math.floor((chunk.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000);

        yield {
          format: FORMAT,
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          data: Buffer.from(chunk).toString("base64"),
          durationMs,
        };

        offset = end;
      }
    } finally {
      // Cleanup temp files
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function execFileAsync(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, (error) => {
      if (error) reject(error);
      else resolve();
    });

    if (signal) {
      const onAbort = () => {
        proc.kill("SIGTERM");
        reject(new Error("Aborted"));
      };
      if (signal.aborted) {
        proc.kill("SIGTERM");
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
