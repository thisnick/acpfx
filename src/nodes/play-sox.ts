/**
 * play-sox node — speaker output using node-speaker.
 *
 * Uses the `speaker` npm package which provides a proper Node.js Writable
 * stream backed by CoreAudio (macOS). Handles backpressure automatically —
 * no buffer overflow, no stuttering.
 *
 * Settings (via ACPFX_SETTINGS):
 *   sampleRate?: number  — sample rate (default: 16000)
 *   channels?: number    — channels (default: 1)
 */

import { createInterface } from "node:readline";
// @ts-ignore — speaker has no type declarations
import Speaker from "speaker";

type Settings = {
  sampleRate?: number;
  channels?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const SAMPLE_RATE = settings.sampleRate ?? 16000;
const CHANNELS = settings.channels ?? 1;

let speaker: InstanceType<typeof Speaker> | null = null;
let stdinClosed = false;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[play-sox] ${msg}\n`);
}

// Convert mono PCM to stereo by duplicating each sample
function monoToStereo(mono: Buffer): Buffer {
  const stereo = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i += 2) {
    const sample = mono.readInt16LE(i);
    stereo.writeInt16LE(sample, i * 2);       // left
    stereo.writeInt16LE(sample, i * 2 + 2);   // right
  }
  return stereo;
}

function createSpeaker(): InstanceType<typeof Speaker> {
  // Always open in stereo — macOS CoreAudio often rejects mono channel maps.
  // We convert mono→stereo before writing.
  const s = new Speaker({
    channels: 2,
    bitDepth: 16,
    sampleRate: SAMPLE_RATE,
  } as Record<string, unknown>);

  s.on("close", () => {
    log("Speaker closed");
    speaker = null;
  });

  s.on("error", (err: Error) => {
    log(`Speaker error: ${err.message}`);
  });

  return s;
}

function destroySpeaker(): void {
  if (speaker) {
    try {
      speaker.destroy();
    } catch {}
    speaker = null;
  }
}

// Sequential event processing queue
const eventQueue: string[] = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (eventQueue.length > 0) {
    const line = eventQueue.shift()!;
    try {
      const event = JSON.parse(line);

      if (event.type === "control.interrupt") {
        // Immediate silence
        destroySpeaker();
        continue;
      }

      if (event.type === "audio.chunk") {
        if (!speaker) {
          log("Creating speaker");
          speaker = createSpeaker();
        }
        const monopcm = Buffer.from(event.data, "base64");
        const pcm = CHANNELS === 1 ? monoToStereo(monopcm) : monopcm;
        const ok = speaker.write(pcm);
        if (!ok) {
          // Backpressure — wait for speaker to drain
          await new Promise<void>((resolve) => {
            speaker!.once("drain", resolve);
          });
        }
      }
    } catch {}
  }

  processing = false;

  // If stdin is closed and queue is drained, close speaker and exit
  if (stdinClosed && eventQueue.length === 0) {
    if (speaker) {
      speaker.end();
      speaker.on("close", () => {
        emit({ type: "lifecycle.done", component: "play-sox" });
        process.exit(0);
      });
    } else {
      emit({ type: "lifecycle.done", component: "play-sox" });
      process.exit(0);
    }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  eventQueue.push(line);
  processQueue();
});

rl.on("close", () => {
  stdinClosed = true;
  if (eventQueue.length === 0 && !processing) {
    if (speaker) {
      speaker.end();
      speaker.on("close", () => {
        emit({ type: "lifecycle.done", component: "play-sox" });
        process.exit(0);
      });
    } else {
      emit({ type: "lifecycle.done", component: "play-sox" });
      process.exit(0);
    }
  }
});

process.on("SIGTERM", () => {
  destroySpeaker();
  process.exit(0);
});

emit({ type: "lifecycle.ready", component: "play-sox" });
