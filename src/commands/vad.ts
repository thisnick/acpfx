/**
 * acpfx vad — Hybrid voice activity detection.
 *
 * Consumes both audio.chunk and speech.* events:
 * - Audio energy on audio.chunk → fast speech.resume (~20ms latency)
 * - Transcript timeline gaps between speech.final → reliable speech.pause
 *
 * This hybrid approach gives us fast interrupt detection (audio-level)
 * without false-trigger pauses (transcript-level).
 */

import { randomUUID } from "node:crypto";
import { createEventWriter, readEvents } from "../pipeline-io.js";
import type {
  AnyEvent,
  AudioChunkEvent,
  SpeechFinalEvent,
} from "../protocol.js";

const DEFAULT_PAUSE_MS = 600;
const DEFAULT_ENERGY_THRESHOLD = 200; // RMS threshold for speech detection
const SPEECH_HOLD_MS = 300; // Hold speech state for this long after energy drops

export type VadOptions = {
  pauseMs?: string;
  energyThreshold?: string;
};

export async function runVad(opts: VadOptions): Promise<void> {
  const writer = createEventWriter(process.stdout);
  const pauseMs = parseInt(opts.pauseMs ?? String(DEFAULT_PAUSE_MS), 10);
  const energyThreshold = parseInt(
    opts.energyThreshold ?? String(DEFAULT_ENERGY_THRESHOLD),
    10,
  );

  const streamId = randomUUID();

  // --- Audio energy state (for speech.resume) ---
  let isSpeaking = false;
  let lastEnergyAboveThreshold = 0;
  let speechHoldTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Transcript timeline state (for speech.pause) ---
  let lastSpeechFinalAt = 0;
  let accumulatedText = "";
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  function computeRmsEnergy(pcmData: Buffer): number {
    if (pcmData.length < 2) return 0;
    let sumSquares = 0;
    const numSamples = Math.floor(pcmData.length / 2);
    for (let i = 0; i < numSamples; i++) {
      const sample = pcmData.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / numSamples);
  }

  function handleAudioChunk(event: AudioChunkEvent): void {
    const pcmData = Buffer.from(event.data, "base64");
    const energy = computeRmsEnergy(pcmData);

    if (energy > energyThreshold) {
      lastEnergyAboveThreshold = Date.now();

      if (!isSpeaking) {
        // Speech started — emit speech.resume quickly
        isSpeaking = true;
        writer.write({
          type: "speech.resume",
          streamId,
        });
      }

      // Clear any pending speech hold timer
      if (speechHoldTimer) {
        clearTimeout(speechHoldTimer);
        speechHoldTimer = null;
      }
    } else if (isSpeaking) {
      // Energy dropped below threshold — start hold timer
      if (!speechHoldTimer) {
        speechHoldTimer = setTimeout(() => {
          speechHoldTimer = null;
          // Don't emit speech.pause here — wait for transcript timeline
          // Just update internal state
          isSpeaking = false;
        }, SPEECH_HOLD_MS);
      }
    }
  }

  function handleSpeechFinal(event: SpeechFinalEvent): void {
    lastSpeechFinalAt = Date.now();
    accumulatedText = accumulatedText
      ? accumulatedText + " " + event.text
      : event.text;

    // Reset the pause timer
    if (pauseTimer) {
      clearTimeout(pauseTimer);
    }

    // Start a new pause timer — if no more speech.final arrives
    // within pauseMs, emit speech.pause
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (accumulatedText.trim().length > 0) {
        const silenceMs = Date.now() - lastSpeechFinalAt;
        writer.write({
          type: "speech.pause",
          streamId,
          silenceMs,
          pendingText: accumulatedText.trim(),
        });
        accumulatedText = "";
      }
    }, pauseMs);
  }

  await readEvents(
    process.stdin,
    async (event: AnyEvent) => {
      if (event.type === "audio.chunk") {
        handleAudioChunk(event as AudioChunkEvent);
        // Forward audio.chunk for downstream consumers
        await writer.write(event);
        return;
      }

      if (event.type === "speech.final") {
        handleSpeechFinal(event as SpeechFinalEvent);
        // Forward speech.final downstream
        await writer.write(event);
        return;
      }

      if (event.type === "speech.partial") {
        // Forward speech.partial downstream
        await writer.write(event);
        return;
      }

      // Forward all other events unchanged
      await writer.write(event);
    },
    async (error: Error, _line: string) => {
      await writer.write({
        type: "control.error",
        message: `Invalid JSON: ${error.message}`,
        source: "vad",
      });
    },
  );

  // Cleanup timers
  if (pauseTimer) clearTimeout(pauseTimer);
  if (speechHoldTimer) clearTimeout(speechHoldTimer);

  // Flush any remaining accumulated text as a final speech.pause
  if (accumulatedText.trim().length > 0) {
    await writer.write({
      type: "speech.pause",
      streamId,
      silenceMs: Date.now() - lastSpeechFinalAt,
      pendingText: accumulatedText.trim(),
    });
  }

  await writer.end();
}
