/**
 * tts-deepgram node — Deepgram Aura streaming TTS via WebSocket.
 *
 * Reads agent.delta events, streams text tokens to Deepgram WebSocket,
 * emits audio.chunk events as audio arrives.
 *
 * True streaming: sends each delta token as it arrives via {"type":"Speak","text":"..."}.
 * Explicit segment control:
 *   - Flush on agent.tool_start (finalize current segment)
 *   - Clear on control.interrupt (discard buffered text)
 *
 * Settings (via ACPFX_SETTINGS):
 *   voice?: string      — Deepgram voice model (default: aura-2-apollo-en)
 *   apiKey?: string      — API key (falls back to DEEPGRAM_API_KEY env)
 *   sampleRate?: number  — output sample rate (default: 16000)
 */

import { createInterface } from "node:readline";

const WS_URL = "wss://api.deepgram.com/v1/speak";
const DEFAULT_VOICE = "aura-2-apollo-en";
const TRACK_ID = "tts";

type Settings = {
  voice?: string;
  apiKey?: string;
  sampleRate?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const API_KEY = settings.apiKey ?? process.env.DEEPGRAM_API_KEY ?? "";
const VOICE = settings.voice ?? DEFAULT_VOICE;
const SAMPLE_RATE = settings.sampleRate ?? 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_MS = 100;
const CHUNK_SIZE = Math.floor(
  (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000,
);

if (!API_KEY) {
  process.stderr.write(
    "[tts-deepgram] ERROR: No API key. Set DEEPGRAM_API_KEY or settings.apiKey\n",
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
  process.stderr.write(`[tts-deepgram] ${msg}\n`);
}

async function openWebSocket(): Promise<void> {
  if (ws && connected) return;

  const url =
    `${WS_URL}?model=${encodeURIComponent(VOICE)}` +
    `&encoding=linear16` +
    `&sample_rate=${SAMPLE_RATE}`;

  ws = new WebSocket(url, ["token", API_KEY]);

  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener(
      "open",
      () => {
        connected = true;
        log("Connected to Deepgram TTS");
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

  ws.addEventListener("message", (event: MessageEvent) => {
    if (interrupted) return;

    const data = event.data;

    // Handle Blob (browser-style WebSocket returns Blobs for binary)
    if (typeof data === "object" && data !== null && typeof (data as any).arrayBuffer === "function") {
      (data as Blob).arrayBuffer().then((ab) => {
        if (interrupted) return;
        handleAudioData(Buffer.from(ab));
      });
      return;
    }

    // Handle ArrayBuffer / Buffer
    if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
      handleAudioData(Buffer.from(data as ArrayBuffer));
      return;
    }

    // Text frame — metadata/control message
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "Flushed") {
          if (pcmBuffer.length > 0) {
            emitAudioChunk(pcmBuffer);
            pcmBuffer = Buffer.alloc(0);
          }
        } else if (msg.type === "Warning") {
          log(`Deepgram warning: ${msg.description ?? msg.code ?? "unknown"}`);
        }
      } catch {
        // ignore
      }
    }
  });

  function handleAudioData(rawPcm: Buffer): void {
    pcmBuffer = Buffer.concat([pcmBuffer, rawPcm]);
    while (pcmBuffer.length >= CHUNK_SIZE) {
      const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
      pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
      emitAudioChunk(chunk);
    }
  }

  ws.addEventListener("error", (event: Event) => {
    log(`WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`);
    emit({
      type: "control.error",
      component: "tts-deepgram",
      message: "TTS WebSocket error",
      fatal: false,
    });
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    log(`WebSocket closed (code=${event.code})`);
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
 * Since tokens arrive fragmented (e.g., "**" then "bold" then "**"),
 * we can't use pattern-based regex. Instead, just remove markdown
 * syntax characters and track URL state to skip link targets.
 */
let inUrl = false;
let inCodeBlock = false;

function stripMarkdown(text: string): string {
  // Track code block state across tokens
  if (text.includes("```")) {
    inCodeBlock = !inCodeBlock;
    return "";
  }
  if (inCodeBlock) return "";

  // Track markdown link URL: after "](" skip until ")"
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inUrl) {
      if (ch === ")") inUrl = false;
      continue; // skip URL characters
    }
    if (ch === "]" && i + 1 < text.length && text[i + 1] === "(") {
      inUrl = true;
      i++; // skip the "("
      continue;
    }
    if (ch === "[" || ch === "]") continue; // link brackets
    if (ch === "*" || ch === "~" || ch === "`") continue;
    if (ch === "#" && (i === 0 || text[i - 1] === "\n")) continue;
    result += ch;
  }
  return result;
}

function sendText(text: string): void {
  if (!ws || !connected) {
    log(`sendText dropped (connected=${connected}): "${text.slice(0, 30)}"`);
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  ws.send(JSON.stringify({ type: "Speak", text: clean }));
}

function flushStream(): void {
  if (!ws || !connected) return;
  log("Sending Flush");
  ws.send(JSON.stringify({ type: "Flush" }));
}

function clearStream(): void {
  if (!ws || !connected) return;
  log("Sending Clear");
  ws.send(JSON.stringify({ type: "Clear" }));
}

function closeWebSocket(): void {
  connected = false;
  pcmBuffer = Buffer.alloc(0);
  if (ws) {
    try {
      ws.send(JSON.stringify({ type: "Close" }));
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

  emit({ type: "lifecycle.ready", component: "tts-deepgram" });

  const rl = createInterface({ input: process.stdin });

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

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    if (event.type === "agent.delta") {
      if (event.delta) {
        if (interrupted || !connected) {
          log(`Reconnecting (interrupted=${interrupted}, connected=${connected})`);
          interrupted = false;
          closeWebSocket();
          await openWebSocket();
        }
        currentRequestId = event.requestId as string;
        sendText(event.delta as string);
      }
    } else if (event.type === "agent.tool_start" && !interrupted) {
      // Tool call started — flush current segment
      if (connected) {
        log("Tool started — flushing TTS segment");
        flushStream();
      }
    } else if (event.type === "agent.complete" && !interrupted) {
      // Agent done — flush remaining text
      flushStream();
      currentRequestId = null;
    } else if (event.type === "control.interrupt") {
      interrupted = true;
      // Clear discards buffered text immediately
      clearStream();
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
    emit({ type: "lifecycle.done", component: "tts-deepgram" });
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
