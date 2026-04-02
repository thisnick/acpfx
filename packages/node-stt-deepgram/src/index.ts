/**
 * stt-deepgram node — Deepgram Nova-3 Realtime STT with UtteranceEnd detection.
 *
 * Reads audio.chunk events from stdin, streams to Deepgram WebSocket,
 * emits speech.partial, speech.final, and speech.pause events.
 *
 * Uses UtteranceEnd for end-of-turn detection — analyzes word timing gaps,
 * ignores non-speech audio (won't false-trigger on SFX sounds).
 *
 * Settings (via ACPFX_SETTINGS):
 *   language?: string           — language code (default: "en")
 *   apiKey?: string             — Deepgram API key (falls back to DEEPGRAM_API_KEY env)
 *   model?: string              — STT model (default: "nova-3")
 *   utteranceEndMs?: number     — ms gap for utterance end (default: 1000)
 *   endpointing?: number        — VAD endpointing ms (default: 300)
 */

import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

const WS_URL = "wss://api.deepgram.com/v1/listen";

type Settings = {
  language?: string;
  apiKey?: string;
  model?: string;
  utteranceEndMs?: number;
  endpointing?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const API_KEY = settings.apiKey ?? process.env.DEEPGRAM_API_KEY ?? "";
const LANGUAGE = settings.language ?? "en";
const MODEL = settings.model ?? "nova-3";
const UTTERANCE_END_MS = settings.utteranceEndMs ?? 1000;
const ENDPOINTING = settings.endpointing ?? 300;
const TRACK_ID = "stt";

if (!API_KEY) {
  log.error("No API key. Set DEEPGRAM_API_KEY or settings.apiKey");
  process.exit(1);
}

let ws: WebSocket | null = null;
let connected = false;
let lastFinalText = "";
let pendingText = "";


async function connectWebSocket(): Promise<void> {
  const url =
    `${WS_URL}?model=${MODEL}` +
    `&language=${encodeURIComponent(LANGUAGE)}` +
    `&encoding=linear16` +
    `&sample_rate=16000` +
    `&channels=1` +
    `&interim_results=true` +
    `&punctuate=true` +
    `&smart_format=true` +
    `&utterance_end_ms=${UTTERANCE_END_MS}` +
    `&endpointing=${ENDPOINTING}` +
    `&vad_events=true`;

  ws = new WebSocket(url, ["token", API_KEY]);

  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener(
      "open",
      () => {
        connected = true;
        log.info("Connected to Deepgram STT");
        resolve();
      },
      { once: true },
    );

    ws!.addEventListener(
      "error",
      () => {
        reject(new Error("WebSocket connection failed"));
      },
      { once: true },
    );
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      const data =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
      const msg = JSON.parse(data);
      handleServerMessage(msg);
    } catch {
      // ignore parse errors
    }
  });

  ws.addEventListener("error", (event: Event) => {
    log.error(`WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`);
    emit({
      type: "control.error",
      component: "stt-deepgram",
      message: "STT WebSocket error",
      fatal: false,
    });
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    log.info(`WebSocket closed (code=${event.code})`);
    connected = false;
  });
}

function handleServerMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string | undefined;

  // UtteranceEnd — speaker finished their turn (word-timing based, ignores noise)
  if (type === "UtteranceEnd") {
    if (pendingText) {
      emit({
        type: "speech.pause",
        trackId: TRACK_ID,
        pendingText,
        silenceMs: UTTERANCE_END_MS,
      });
      pendingText = "";
    }
    return;
  }

  // SpeechStarted — VAD detected speech beginning
  if (type === "SpeechStarted") {
    return;
  }

  // Transcription result
  if (type === "Results") {
    const channel = msg.channel as Record<string, unknown> | undefined;
    const alternatives = (channel?.alternatives as Array<Record<string, unknown>>) ?? [];
    if (alternatives.length === 0) return;

    const transcript = (alternatives[0].transcript as string) ?? "";
    const isFinal = msg.is_final === true;
    const speechFinal = msg.speech_final === true;

    if (!transcript) return;

    if (isFinal) {
      // Clear stale partial timer — proper final arrived
      // Final transcript for this segment
      lastFinalText = transcript;
      pendingText = pendingText ? pendingText + " " + transcript : transcript;

      emit({
        type: "speech.final",
        trackId: TRACK_ID,
        text: transcript,
        confidence: (alternatives[0].confidence as number) ?? undefined,
      });

      // If speech_final (endpointing detected silence), also emit pause
      if (speechFinal) {
        emit({
          type: "speech.pause",
          trackId: TRACK_ID,
          pendingText,
          silenceMs: ENDPOINTING,
        });
        pendingText = "";
      }
    } else {
      // Interim result — partial transcript
      emit({
        type: "speech.partial",
        trackId: TRACK_ID,
        text: transcript,
      });
    }
  }
}

function sendAudio(base64Pcm: string): void {
  if (!ws || !connected) return;
  const pcm = Buffer.from(base64Pcm, "base64");
  try {
    ws.send(pcm);
  } catch {
    // WebSocket may have closed
  }
}

function closeWebSocket(): void {
  connected = false;
  if (ws) {
    try {
      // Send close message per Deepgram protocol
      ws.send(JSON.stringify({ type: "CloseStream" }));
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

// --- Main ---

async function main(): Promise<void> {
  await connectWebSocket();

  emit({ type: "lifecycle.ready", component: "stt-deepgram" });

  const rl = onEvent((event) => {
    if (event.type === "audio.chunk") {
      if (!connected) {
        connectWebSocket().then(() => {
          sendAudio(event.data as string);
        }).catch(() => {});
      } else {
        sendAudio(event.data as string);
      }
    } else if (event.type === "control.interrupt") {
      // Don't close WebSocket — STT should keep listening for barge-in.
    }
  });

  rl.on("close", () => {
    closeWebSocket();
    emit({ type: "lifecycle.done", component: "stt-deepgram" });
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
