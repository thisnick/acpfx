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
import { emit, log, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

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
  log.error("No API key. Set ELEVENLABS_API_KEY or settings.apiKey");
  process.exit(1);
}

let ws: WebSocket | null = null;
let connected = false;
let interrupted = false;
let pcmBuffer = Buffer.alloc(0);
let currentRequestId: string | null = null;


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
        log.info("Connected to ElevenLabs TTS");
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
        chunk_length_schedule: [50],
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
    log.error(`WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`);
    emit({
      type: "control.error",
      component: "tts-elevenlabs",
      message: "TTS WebSocket error",
      fatal: false,
    });
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    log.info(`WebSocket closed (code=${event.code}, reason=${event.reason || "none"})`);
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

/**
 * Strip markdown characters from streaming tokens.
 * Tokens arrive fragmented, so we strip character-by-character
 * and track state for URLs and code blocks.
 */
let inUrl = false;
let inCodeBlock = false;

function stripMarkdown(text: string): string {
  if (text.includes("```")) {
    inCodeBlock = !inCodeBlock;
    return "";
  }
  if (inCodeBlock) return "";

  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inUrl) {
      if (ch === ")") inUrl = false;
      continue;
    }
    if (ch === "]" && i + 1 < text.length && text[i + 1] === "(") {
      inUrl = true;
      i++;
      continue;
    }
    if (ch === "[" || ch === "]") continue;
    if (ch === "*" || ch === "~" || ch === "`") continue;
    if (ch === "#" && (i === 0 || text[i - 1] === "\n")) continue;
    result += ch;
  }
  return result;
}

function sendText(text: string): void {
  if (!ws || !connected) {
    log.warn(`sendText dropped (connected=${connected}): "${text.slice(0, 30)}"`);
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  ws.send(JSON.stringify({ text: clean }));
}

function endStream(): void {
  if (!ws || !connected) return;
  // Send empty text to signal EOS (end of stream)
  log.debug("Sending EOS");
  ws.send(JSON.stringify({ text: "" }));
  // Don't close the WebSocket — let ElevenLabs close it after isFinal
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

  // Queue events and process sequentially to avoid async races
  const eventQueue: string[] = [];
  let processing = false;

  async function processQueue(): Promise<void> {
    if (processing) return;
    processing = true;

    while (eventQueue.length > 0) {
      const line = eventQueue.shift()!;
      try {
        const event = JSON.parse(line);
        await handleEvent(event);
      } catch {
        // ignore
      }
    }

    processing = false;
  }

  let afterTool = false;

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    if (event.type === "agent.delta") {
      if (event.delta) {
        // Reconnect if WebSocket is down, we were interrupted, or we're
        // starting a new segment after a tool call.
        if (interrupted || !connected || afterTool) {
          log.info(`Opening TTS stream (interrupted=${interrupted}, connected=${connected}, afterTool=${afterTool})`);
          interrupted = false;
          afterTool = false;
          closeWebSocket();
          await openWebSocket();
        }
        currentRequestId = event.requestId as string;
        sendText(event.delta as string);
      }
    } else if (event.type === "agent.tool_start" && !interrupted) {
      // Tool call started — close the WebSocket to force ElevenLabs to
      // finalize audio for the text sent so far. EOS alone may not work
      // if the text was mid-sentence.
      if (connected) {
        log.info("Tool started — closing TTS stream for segment break");
        endStream();
        // Give ElevenLabs a moment to send final audio, then force close
        setTimeout(() => {
          closeWebSocket();
        }, 500);
        afterTool = true;
      }
    } else if (event.type === "agent.complete" && !interrupted) {
      // Agent is done — signal end of text stream so TTS can finalize
      endStream();
      currentRequestId = null;
    } else if (event.type === "control.interrupt") {
      interrupted = true;
      afterTool = false;
      closeWebSocket();
      currentRequestId = null;
    }
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    eventQueue.push(line);
    processQueue();
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
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
