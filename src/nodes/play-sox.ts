/**
 * play-sox node — live speaker output via sox `play` command.
 * Reads audio.chunk events from stdin, pipes PCM to sox.
 *
 * Settings (via ACPFX_SETTINGS):
 *   sampleRate?: number  — sample rate (default: 16000)
 *   channels?: number    — channels (default: 1)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

type Settings = {
  sampleRate?: number;
  channels?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const SAMPLE_RATE = settings.sampleRate ?? 16000;
const CHANNELS = settings.channels ?? 1;

let playProc: ChildProcess | null = null;
let interrupted = false;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[play-sox] ${msg}\n`);
}

function cleanup(): void {
  if (playProc && !playProc.killed) {
    playProc.kill("SIGTERM");
  }
}

function startPlay(): ChildProcess {
  const proc = spawn("play", [
    "-q",
    "-t", "raw",
    "-b", "16",
    "-e", "signed-integer",
    "-r", String(SAMPLE_RATE),
    "-c", String(CHANNELS),
    "--endian", "little",
    "-",
  ], {
    stdio: ["pipe", "ignore", "pipe"],
  });

  proc.stderr?.on("data", (data: Buffer) => {
    log(data.toString().trim());
  });

  proc.on("error", (err) => {
    log(`play error: ${err.message}`);
    emit({
      type: "control.error",
      component: "play-sox",
      message: `sox play failed: ${err.message}`,
      fatal: true,
    });
    process.exit(1);
  });

  // Suppress EPIPE if play exits while we're still writing
  proc.stdin!.on("error", () => {});

  return proc;
}

// Handle events from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);

    if (event.type === "control.interrupt") {
      // Kill current playback immediately (silence)
      cleanup();
      playProc = null;
      // Don't set interrupted=true permanently — allow new audio after interrupt
      return;
    }

    if (event.type === "audio.chunk") {
      // Start or restart sox play on demand
      if (!playProc || playProc.killed) {
        playProc = startPlay();
      }
      const pcm = Buffer.from(event.data, "base64");
      try {
        playProc.stdin!.write(pcm);
      } catch {
        // play process may have exited — restart on next chunk
        playProc = null;
      }
    }
  } catch {}
});

rl.on("close", () => {
  if (playProc && !playProc.killed) {
    playProc.stdin!.end();
    playProc.on("close", () => {
      emit({ type: "lifecycle.done", component: "play-sox" });
      process.exit(0);
    });
  } else {
    emit({ type: "lifecycle.done", component: "play-sox" });
    process.exit(0);
  }
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// Emit lifecycle.ready immediately — we start sox lazily on first chunk
emit({ type: "lifecycle.ready", component: "play-sox" });
