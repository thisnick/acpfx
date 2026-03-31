/**
 * play-sox node — live speaker output via sox `play` command.
 * Reads audio.chunk events from stdin, paces PCM writes at real-time rate.
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

// Audio queue: PCM buffers waiting to be written to sox at real-time rate
const pcmQueue: Buffer[] = [];
let playInterval: ReturnType<typeof setInterval> | null = null;
let stdinClosed = false;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[play-sox] ${msg}\n`);
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
  });

  // Suppress EPIPE
  proc.stdin!.on("error", () => {});

  return proc;
}

function stopPlay(): void {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
  }
  if (playProc && !playProc.killed) {
    playProc.kill("SIGTERM");
  }
  playProc = null;
  pcmQueue.length = 0;
}

// Write one chunk from the queue to sox every ~100ms (real-time pacing for 100ms chunks)
function startDraining(): void {
  if (playInterval) return;

  playInterval = setInterval(() => {
    if (pcmQueue.length > 0 && playProc && !playProc.killed) {
      const chunk = pcmQueue.shift()!;
      playProc.stdin!.write(chunk);
    } else if (pcmQueue.length === 0 && stdinClosed) {
      // Queue drained and no more input coming — close sox
      clearInterval(playInterval!);
      playInterval = null;
      if (playProc && !playProc.killed) {
        playProc.stdin!.end();
        playProc.on("close", () => {
          log("Playback complete");
          emit({ type: "lifecycle.done", component: "play-sox" });
          process.exit(0);
        });
      } else {
        emit({ type: "lifecycle.done", component: "play-sox" });
        process.exit(0);
      }
    }
  }, 100); // 100ms interval matches 100ms audio chunks
}

// Handle events from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);

    if (event.type === "control.interrupt") {
      stopPlay();
      return;
    }

    if (event.type === "audio.chunk") {
      if (!playProc || playProc.killed) {
        log("Starting sox play");
        playProc = startPlay();
        playProc.on("close", (code) => {
          log(`sox play exited with code ${code}`);
        });
      }
      const pcm = Buffer.from(event.data, "base64");
      pcmQueue.push(pcm);
      startDraining();
    }
  } catch {}
});

rl.on("close", () => {
  stdinClosed = true;
  // If nothing is queued or playing, exit immediately
  if (pcmQueue.length === 0 && !playProc) {
    emit({ type: "lifecycle.done", component: "play-sox" });
    process.exit(0);
  }
  // Otherwise the drain interval will handle cleanup
});

process.on("SIGTERM", () => {
  stopPlay();
  process.exit(0);
});

// Emit lifecycle.ready immediately — sox starts lazily on first chunk
emit({ type: "lifecycle.ready", component: "play-sox" });
