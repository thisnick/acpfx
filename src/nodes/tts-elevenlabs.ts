/**
 * tts-elevenlabs node — reads agent.delta events, streams text to ElevenLabs
 * WebSocket TTS, emits audio.chunk events as audio arrives.
 *
 * True streaming: sends each delta token to the WebSocket as it arrives,
 * so audio generation starts before the full response is complete.
 *
 * Settings (via ACPFX_SETTINGS):
 *   voiceId?: string    — ElevenLabs voice ID (default: Rachel)
 *   model?: string       — TTS model (default: eleven_turbo_v2_5)
 *   apiKey?: string      — API key (falls back to ELEVENLABS_API_KEY env)
 */

import { createInterface } from "node:readline";

const WS_BASE_URL = "wss://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_MODEL = "eleven_turbo_v2_5";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const OUTPUT_FORMAT = "pcm_16000";
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(
  (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000,
);
const TRACK_ID = "tts";

type Settings = {
  voiceId?: string;
  model?: string;
  apiKey?: string;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const API_KEY = settings.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
const VOICE_ID = settings.voiceId ?? DEFAULT_VOICE_ID;
const MODEL = settings.model ?? DEFAULT_MODEL;

if (!API_KEY) {
  process.stderr.write(
    "[tts-elevenlabs] ERROR: No API key. Set ELEVENLABS_API_KEY or settings.apiKey\n",
  );
  process.exit(1);
}

let ws: WebSocket | null = null;
let connected = false;
let interrupted = false;
let pcmBuffer = Buffer.alloc(0);
let currentRequestId: string | null = null;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[tts-elevenlabs] ${msg}\n`);
}

async function openWebSocket(): Promise<void> {
  if (ws && connected) return;

  const url =
    `${WS_BASE_URL}/${VOICE_ID}/stream-input` +
    `?model_id=${encodeURIComponent(MODEL)}` +
    `&output_format=${OUTPUT_FORMAT}` +
    `&xi_api_key=${encodeURIComponent(API_KEY)}`;

  ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener(
      "open",
      () => {
        connected = true;
        log("Connected to ElevenLabs TTS");
        resolve();
      },
      { once: true },
    );
    ws!.addEventListener(
      "error",
      () => reject(new Error("TTS WebSocket connection failed")),
      { once: true },
    );
  });

  // Send BOS (beginning of stream) with voice settings
  ws.send(
    JSON.stringify({
      text: " ",
      xi_api_key: API_KEY,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
      generation_config: {
        chunk_length_schedule: [120],
      },
    }),
  );

  ws.addEventListener("message", (event: MessageEvent) => {
    if (interrupted) return;
    try {
      const data =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
      const msg = JSON.parse(data);

      if (msg.audio) {
        const rawPcm = Buffer.from(msg.audio, "base64");
        pcmBuffer = Buffer.concat([pcmBuffer, rawPcm]);

        // Emit fixed-size audio chunks
        while (pcmBuffer.length >= CHUNK_SIZE) {
          const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
          pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
          emitAudioChunk(chunk);
        }
      }

      if (msg.isFinal) {
        // Flush remaining buffer
        if (pcmBuffer.length > 0) {
          emitAudioChunk(pcmBuffer);
          pcmBuffer = Buffer.alloc(0);
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.addEventListener("error", (event: Event) => {
    log(`WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`);
    emit({
      type: "control.error",
      component: "tts-elevenlabs",
      message: "TTS WebSocket error",
      fatal: false,
    });
  });

  ws.addEventListener("close", () => {
    connected = false;
  });
}

function emitAudioChunk(pcm: Buffer): void {
  const durationMs = Math.round(
    (pcm.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000,
  );
  emit({
    type: "audio.chunk",
    trackId: TRACK_ID,
    format: "pcm_s16le",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    data: Buffer.from(pcm).toString("base64"),
    durationMs,
  });
}

function sendText(text: string): void {
  if (!ws || !connected) return;
  ws.send(JSON.stringify({ text }));
}

function endStream(): void {
  if (!ws || !connected) return;
  // Send empty text to signal EOS (end of stream)
  ws.send(JSON.stringify({ text: "" }));
}

function closeWebSocket(): void {
  connected = false;
  pcmBuffer = Buffer.alloc(0);
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

// --- Main ---

async function main(): Promise<void> {
  await openWebSocket();

  // Emit lifecycle.ready after WS connected
  emit({ type: "lifecycle.ready", component: "tts-elevenlabs" });

  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "agent.delta") {
        if (event.delta) {
          // If this is a new request after an interrupt, reconnect first
          if (interrupted || currentRequestId !== event.requestId) {
            interrupted = false;
            currentRequestId = event.requestId;
            // Close old WS if any, open fresh one
            closeWebSocket();
            await openWebSocket();
          }
          sendText(event.delta);
        }
      } else if (event.type === "agent.complete" && !interrupted) {
        // Agent is done — signal end of text stream so TTS can finalize
        endStream();
        currentRequestId = null;
      } else if (event.type === "control.interrupt") {
        interrupted = true;
        // Close WebSocket immediately to stop audio generation
        closeWebSocket();
        currentRequestId = null;
      }
    } catch {
      // ignore
    }
  });

  rl.on("close", () => {
    closeWebSocket();
    emit({ type: "lifecycle.done", component: "tts-elevenlabs" });
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    closeWebSocket();
    process.exit(0);
  });
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
