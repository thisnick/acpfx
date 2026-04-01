/**
 * stt-elevenlabs node — ElevenLabs Scribe v2 Realtime STT with built-in VAD.
 *
 * Reads audio.chunk events from stdin, streams to ElevenLabs WebSocket,
 * emits speech.partial, speech.delta, speech.final, and speech.pause events.
 *
 * Uses commit_strategy=vad so ElevenLabs handles pause detection server-side.
 *
 * Settings (via ACPFX_SETTINGS):
 *   language?: string   — language code (default: "en")
 *   apiKey?: string      — ElevenLabs API key (falls back to ELEVENLABS_API_KEY env)
 *   pauseMs?: number     — VAD silence threshold hint (default: 600)
 */

import { createInterface } from "node:readline";

const WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MODEL = "scribe_v2_realtime";

type Settings = {
  language?: string;
  apiKey?: string;
  pauseMs?: number;
  vadThreshold?: number;         // 0-1, default 0.5 (higher = less sensitive)
  minSpeechDurationMs?: number;  // default 250 (ignore short noise bursts)
  minSilenceDurationMs?: number; // default 100
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const LANGUAGE = settings.language ?? "en";
const API_KEY = settings.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
const TRACK_ID = "stt";

if (!API_KEY) {
  process.stderr.write(
    "[stt-elevenlabs] ERROR: No API key. Set ELEVENLABS_API_KEY or settings.apiKey\n",
  );
  process.exit(1);
}

let ws: WebSocket | null = null;
let connected = false;
let reconnecting = false;
let interrupted = false;
let lastPartialText = "";
let accumulatedText = "";
let partialStaleTimer: ReturnType<typeof setTimeout> | null = null;
const PARTIAL_STALE_MS = 3000;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[stt-elevenlabs] ${msg}\n`);
}

async function connectWebSocket(): Promise<void> {
  const vadSilenceSecs = (settings.pauseMs ?? 600) / 1000;
  const vadThreshold = settings.vadThreshold ?? 0.5;
  const minSpeechMs = settings.minSpeechDurationMs ?? 250;
  const minSilenceMs = settings.minSilenceDurationMs ?? 100;
  const url =
    `${WS_URL}?model_id=${MODEL}` +
    `&language_code=${encodeURIComponent(LANGUAGE)}` +
    `&sample_rate=16000` +
    `&encoding=pcm_s16le` +
    `&commit_strategy=vad` +
    `&vad_silence_threshold_secs=${vadSilenceSecs}` +
    `&vad_threshold=${vadThreshold}` +
    `&min_speech_duration_ms=${minSpeechMs}` +
    `&min_silence_duration_ms=${minSilenceMs}`;

  ws = new WebSocket(url, {
    headers: { "xi-api-key": API_KEY },
  } as unknown as string[]);

  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener(
      "open",
      () => {
        connected = true;
        log("Connected to ElevenLabs STT");
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
    log(`WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`);
    emit({
      type: "control.error",
      component: "stt-elevenlabs",
      message: "WebSocket error",
      fatal: false,
    });
  });

  ws.addEventListener("close", () => {
    connected = false;
    log("WebSocket closed — will reconnect on next audio");
  });
}

function handleServerMessage(msg: Record<string, unknown>): void {
  const msgType = msg.message_type as string;

  if (interrupted) return;

  if (msgType === "partial_transcript") {
    const text = (msg.text as string) ?? "";
    if (!text) return;

    // Check if this is a correction of a previous partial
    if (lastPartialText && text !== lastPartialText && !text.startsWith(lastPartialText)) {
      // This is a correction — emit speech.delta with replaces
      emit({
        type: "speech.delta",
        trackId: TRACK_ID,
        text,
        replaces: lastPartialText,
      });
    } else {
      emit({
        type: "speech.partial",
        trackId: TRACK_ID,
        text,
      });
    }
    lastPartialText = text;

    // If partial never gets committed, force a commit after timeout.
    // Continuous audio stream means the API may never see "end of speech."
    if (partialStaleTimer) clearTimeout(partialStaleTimer);
    partialStaleTimer = setTimeout(() => {
      if (lastPartialText && !interrupted && ws && connected) {
        log(`Stale partial: forcing commit`);
        ws.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: 16000,
        }));
      }
      partialStaleTimer = null;
    }, PARTIAL_STALE_MS);
  } else if (
    msgType === "committed_transcript" ||
    msgType === "committed_transcript_with_timestamps"
  ) {
    const text = (msg.text as string) ?? "";
    if (!text) return;
    // Clear stale timer — proper commit arrived
    if (partialStaleTimer) { clearTimeout(partialStaleTimer); partialStaleTimer = null; }
    lastPartialText = "";

    // Emit speech.final
    emit({
      type: "speech.final",
      trackId: TRACK_ID,
      text,
    });

    accumulatedText = accumulatedText ? `${accumulatedText} ${text}` : text;

    // When using VAD commit_strategy, a committed_transcript means
    // ElevenLabs detected a pause. Emit speech.pause.
    emit({
      type: "speech.pause",
      trackId: TRACK_ID,
      pendingText: accumulatedText,
      silenceMs: settings.pauseMs ?? 600,
    });

    // Reset for next utterance
    lastPartialText = "";
    accumulatedText = "";
  } else if (msgType === "auth_error" || msgType === "error") {
    const errMsg =
      (msg.message as string) ?? (msg.error as string) ?? msgType;
    log(`Server error: ${errMsg}`);
    emit({
      type: "control.error",
      component: "stt-elevenlabs",
      message: errMsg,
      fatal: msgType === "auth_error",
    });
  }
}

function sendAudio(base64Data: string): void {
  if (!ws || !connected) return;
  ws.send(
    JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: base64Data,
      commit: false,
      sample_rate: 16000,
    }),
  );
}

function closeWebSocket(): void {
  connected = false;
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
  await connectWebSocket();

  // Emit lifecycle.ready after WS is connected
  emit({ type: "lifecycle.ready", component: "stt-elevenlabs" });

  // Read NDJSON from stdin
  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);

      if (event.type === "audio.chunk") {
        if (!connected && !reconnecting) {
          // Reconnect after close or interrupt
          reconnecting = true;
          interrupted = false;
          log("Reconnecting...");
          connectWebSocket().then(() => {
            reconnecting = false;
            sendAudio(event.data);
          }).catch(() => {
            reconnecting = false;
          });
        } else if (connected && !interrupted) {
          sendAudio(event.data);
        }
        // else: reconnecting or interrupted — drop this chunk
      } else if (event.type === "control.interrupt") {
        // Don't close WebSocket — STT should keep listening for barge-in.
        // Interrupt is meant for downstream nodes (TTS, player) to stop playback.
        // Closing the WebSocket kills the session mid-recognition.
      }
    } catch {
      // ignore
    }
  });

  rl.on("close", () => {
    closeWebSocket();
    emit({ type: "lifecycle.done", component: "stt-elevenlabs" });
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
