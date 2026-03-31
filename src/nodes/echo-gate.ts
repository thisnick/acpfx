/**
 * echo-gate node — sits between mic and stt to prevent speaker echo from
 * triggering STT during agent playback.
 *
 * Normal mode: forwards all mic audio.chunk events to output (STT).
 * Playback mode: when TTS audio is flowing, stops forwarding mic audio
 *   to STT, but monitors mic energy for barge-in detection.
 * Barge-in: if mic RMS spikes above threshold during playback, emits
 *   control.interrupt and resumes forwarding.
 *
 * Inputs:
 *   - audio.chunk (from mic, trackId="mic") — mic audio
 *   - audio.chunk (from tts, trackId="tts") — used to detect playback state
 *   - control.interrupt — reset state
 *   - agent.complete — playback will end soon
 *
 * Outputs:
 *   - audio.chunk (forwarded mic audio, gated during playback)
 *   - audio.level (always forwarded for UI)
 *   - control.interrupt (on barge-in detection)
 *
 * Settings:
 *   bargeInThreshold?: number — RMS threshold for barge-in detection (default: 1500)
 *   playbackTimeoutMs?: number — how long after last TTS chunk to exit playback mode (default: 2000)
 */

import { createInterface } from "node:readline";

type Settings = {
  bargeInThreshold?: number;
  playbackTimeoutMs?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const BARGE_IN_THRESHOLD = settings.bargeInThreshold ?? 1500;
const PLAYBACK_TIMEOUT_MS = settings.playbackTimeoutMs ?? 2000;

let playbackActive = false;
let lastTtsChunkTime = 0;
let playbackTimer: ReturnType<typeof setTimeout> | null = null;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[echo-gate] ${msg}\n`);
}

function computeRms(base64Pcm: string): number {
  const pcm = Buffer.from(base64Pcm, "base64");
  if (pcm.length < 2) return 0;
  let sumSq = 0;
  const numSamples = Math.floor(pcm.length / 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / numSamples);
}

function enterPlaybackMode(): void {
  if (!playbackActive) {
    playbackActive = true;
    log("Playback detected — gating mic audio");
  }
  // Reset timeout
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = setTimeout(() => {
    exitPlaybackMode();
  }, PLAYBACK_TIMEOUT_MS);
}

function exitPlaybackMode(): void {
  if (playbackActive) {
    playbackActive = false;
    log("Playback ended — resuming mic audio");
  }
  if (playbackTimer) {
    clearTimeout(playbackTimer);
    playbackTimer = null;
  }
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);

    // TTS audio chunk — indicates playback is active
    if (event.type === "audio.chunk" && event.trackId === "tts") {
      lastTtsChunkTime = Date.now();
      enterPlaybackMode();
      // Don't forward TTS chunks — they're just for detecting playback state
      return;
    }

    // Mic audio chunk
    if (event.type === "audio.chunk" && event.trackId === "mic") {
      if (playbackActive) {
        // Check for barge-in: is mic energy significantly above threshold?
        const rms = computeRms(event.data);
        if (rms > BARGE_IN_THRESHOLD) {
          log(`Barge-in detected (RMS=${Math.round(rms)} > ${BARGE_IN_THRESHOLD})`);
          // Emit interrupt to stop playback
          emit({ type: "control.interrupt", reason: "user_speech" });
          exitPlaybackMode();
          // Forward this chunk — STT should start processing
          emit(event);
        }
        // During playback, don't forward mic audio (would be echo)
        return;
      }
      // Normal mode — forward mic audio to STT
      emit(event);
      return;
    }

    // Audio level — always forward (for UI)
    if (event.type === "audio.level") {
      emit(event);
      return;
    }

    // control.interrupt — reset state
    if (event.type === "control.interrupt") {
      exitPlaybackMode();
      emit(event);
      return;
    }

    // agent.complete — playback will end soon (but not immediately, TTS still has buffered audio)
    if (event.type === "agent.complete") {
      // Don't exit playback mode yet — wait for TTS chunks to stop
      emit(event);
      return;
    }

    // Forward everything else unchanged
    emit(event);
  } catch {
    // ignore parse errors
  }
});

rl.on("close", () => {
  emit({ type: "lifecycle.done", component: "echo-gate" });
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

emit({ type: "lifecycle.ready", component: "echo-gate" });
