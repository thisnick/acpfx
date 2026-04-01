/**
 * audio-player node — smart speaker with priority queue and SFX.
 *
 * Replaces play-sox. Receives TTS audio + bridge events, implements a
 * priority queue (speech > SFX), loads WAV clips for thinking/tool
 * indicator sounds, and emits what it actually plays for recording.
 *
 * Settings (via ACPFX_SETTINGS):
 *   speechSource?: string   — _from value identifying speech audio (default: "tts")
 *   sampleRate?: number     — sample rate (default: 16000)
 *   thinkingClip?: string   — path to WAV file for thinking sound
 *   toolClip?: string       — path to WAV file for tool use sound
 *   sfxVolume?: number      — 0.0-1.0 gain for SFX (default: 0.3)
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
// @ts-ignore — speaker has no type declarations
import Speaker from "speaker";

type Settings = {
  speechSource?: string;
  sampleRate?: number;
  thinkingClip?: string;
  toolClip?: string;
  sfxVolume?: number;
  noLocalPlayback?: boolean;  // true = don't play through local speaker (mic-aec handles playback)
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const SPEECH_SOURCE = settings.speechSource ?? "tts";
const SAMPLE_RATE = settings.sampleRate ?? 16000;
const SFX_VOLUME = settings.sfxVolume ?? 0.3;
const BYTES_PER_SAMPLE = 2;
const NO_LOCAL_PLAYBACK = settings.noLocalPlayback ?? false;

// ---- Audio helpers ----

function monoToStereo(mono: Buffer): Buffer {
  const stereo = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i += 2) {
    const sample = mono.readInt16LE(i);
    stereo.writeInt16LE(sample, i * 2);
    stereo.writeInt16LE(sample, i * 2 + 2);
  }
  return stereo;
}

function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1.0) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain)));
    out.writeInt16LE(sample, i);
  }
  return out;
}

function loadWavPcm(filePath: string): Buffer | null {
  try {
    const raw = readFileSync(filePath);
    // Skip 44-byte WAV header to get raw PCM
    return raw.subarray(44);
  } catch (err) {
    log(`Failed to load WAV: ${filePath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---- State ----

let speaker: InstanceType<typeof Speaker> | null = null;
let stdinClosed = false;

// Agent state from bridge events
let agentState: "idle" | "thinking" | "tool" = "idle";

// What kind of audio is currently playing
let playingKind: "speech" | "sfx" | null = null;

// SFX clips (loaded at startup)
let thinkingPcm: Buffer | null = null;
let toolPcm: Buffer | null = null;

// SFX loop state
let sfxLoopTimer: ReturnType<typeof setInterval> | null = null;
let sfxActive = false;
let sfxClipOffset = 0; // current position within the SFX clip
let sfxCurrentClip: Buffer | null = null; // gain-adjusted clip being played

const SFX_CHUNK_MS = 100;
const SFX_CHUNK_BYTES = Math.floor(SAMPLE_RATE * BYTES_PER_SAMPLE * SFX_CHUNK_MS / 1000);

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[audio-player] ${msg}\n`);
}

function emitStatus(): void {
  emit({
    type: "player.status",
    playing: playingKind,
    agentState,
    sfxActive,
  });
}

// ---- Speaker management ----

function createSpeaker(): InstanceType<typeof Speaker> {
  const s = new Speaker({
    channels: 2,
    bitDepth: 16,
    sampleRate: SAMPLE_RATE,
  } as Record<string, unknown>);

  s.on("error", (err: Error) => {
    if (!err.message?.includes("underflow")) {
      log(`Speaker error: ${err.message}`);
    }
  });

  s.on("close", () => {
    speaker = null;
  });

  return s;
}

function ensureSpeaker(): void {
  if (!speaker) {
    speaker = createSpeaker();
  }
}

function destroySpeaker(): void {
  if (speaker) {
    try { speaker.destroy(); } catch {}
    speaker = null;
  }
}

// ---- Write audio to speaker ----

function writePcmToSpeaker(mono: Buffer): void {
  if (NO_LOCAL_PLAYBACK) return; // mic-aec handles playback
  ensureSpeaker();
  const stereo = monoToStereo(mono);
  try {
    speaker!.write(stereo);
  } catch {
    speaker = null;
  }
}

// ---- Emit what we play at real-time rate (for AEC reference + recording) ----

type PendingEmit = { pcm: Buffer; kind: "speech" | "sfx" };
const emitQueue: PendingEmit[] = [];
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function emitPlayedChunk(pcm: Buffer, kind: "speech" | "sfx"): void {
  if (NO_LOCAL_PLAYBACK) {
    // No pacing needed — downstream (mic-aec) handles playback timing
    const durationMs = Math.round((pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);
    emit({
      type: "audio.chunk",
      trackId: "player",
      format: "pcm_s16le",
      sampleRate: SAMPLE_RATE,
      channels: 1,
      data: pcm.toString("base64"),
      durationMs,
      kind,
    });
    return;
  }
  emitQueue.push({ pcm, kind });
  if (!emitTimer) {
    drainEmitQueue();
  }
}

function drainEmitQueue(): void {
  if (emitQueue.length === 0) {
    emitTimer = null;
    return;
  }
  const { pcm, kind } = emitQueue.shift()!;
  const durationMs = Math.round((pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);
  emit({
    type: "audio.chunk",
    trackId: "player",
    format: "pcm_s16le",
    sampleRate: SAMPLE_RATE,
    channels: 1,
    data: pcm.toString("base64"),
    durationMs,
    kind,
  });
  // Schedule next emit at real-time rate
  emitTimer = setTimeout(drainEmitQueue, durationMs);
}

function clearEmitQueue(): void {
  emitQueue.length = 0;
  if (emitTimer) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
}

// ---- SFX loop ----

function startSfxLoop(): void {
  if (sfxActive) return;
  const clip = agentState === "thinking" ? thinkingPcm : agentState === "tool" ? toolPcm : null;
  if (!clip) return;

  sfxActive = true;
  playingKind = "sfx";
  sfxCurrentClip = applyGain(clip, SFX_VOLUME);
  sfxClipOffset = 0;
  log(`Starting SFX loop (${agentState})`);

  // Write in small chunks so we can interrupt mid-clip
  writeSfxChunk();
  sfxLoopTimer = setInterval(writeSfxChunk, SFX_CHUNK_MS);
}

function writeSfxChunk(): void {
  if (!sfxActive || !sfxCurrentClip) return;

  const remaining = sfxCurrentClip.length - sfxClipOffset;
  if (remaining <= 0) {
    // Loop: restart from beginning
    sfxClipOffset = 0;
  }

  const bytesToWrite = Math.min(SFX_CHUNK_BYTES, sfxCurrentClip.length - sfxClipOffset);
  const chunk = sfxCurrentClip.subarray(sfxClipOffset, sfxClipOffset + bytesToWrite);
  sfxClipOffset += bytesToWrite;

  writePcmToSpeaker(chunk);
  emitPlayedChunk(chunk, "sfx");
}

/** Stop the SFX loop timer. Does NOT flush the speaker buffer. */
function stopSfxLoop(): void {
  if (sfxLoopTimer) {
    clearInterval(sfxLoopTimer);
    sfxLoopTimer = null;
  }
  if (sfxActive) {
    sfxActive = false;
    log("Stopped SFX loop");
  }
  if (playingKind === "sfx") {
    playingKind = null;
  }
}

const THINKING_DELAY_MS = 500;
let sfxDelayTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSfxDelay(): void {
  if (sfxDelayTimer) {
    clearTimeout(sfxDelayTimer);
    sfxDelayTimer = null;
  }
}

/** Stop SFX and flush the speaker buffer. */
function flushSfxForSpeech(): void {
  stopSfxLoop();
  clearEmitQueue();
  destroySpeaker();
}

// ---- Event handling ----

function handleEvent(event: Record<string, unknown>): void {
  const type = event.type as string;
  const from = event._from as string | undefined;

  // Speech audio from TTS
  if (type === "audio.chunk") {
    if (from !== SPEECH_SOURCE) {
      log(`Ignoring audio.chunk from "${from}" (expected "${SPEECH_SOURCE}")`);
      return;
    }
    // Cancel pending thinking delay — speech arrived first
    cancelSfxDelay();

    // If SFX is playing, flush it and switch to speech
    if (sfxActive) {
      flushSfxForSpeech();
    }

    playingKind = "speech";
    const pcm = Buffer.from(event.data as string, "base64");
    writePcmToSpeaker(pcm);
    emitPlayedChunk(pcm, "speech");
    return;
  }

  // Agent thinking — delay SFX start by 500ms
  if (type === "agent.thinking") {
    agentState = "thinking";
    cancelSfxDelay();
    sfxDelayTimer = setTimeout(() => {
      sfxDelayTimer = null;
      if (agentState === "thinking") startSfxLoop();
    }, THINKING_DELAY_MS);
    emitStatus();
    return;
  }

  // Tool started — start SFX immediately
  if (type === "agent.tool_start") {
    agentState = "tool";
    cancelSfxDelay();
    stopSfxLoop(); // stop thinking sound if any
    startSfxLoop();
    emitStatus();
    return;
  }

  // Tool done
  if (type === "agent.tool_done") {
    agentState = "idle";
    cancelSfxDelay();
    stopSfxLoop();
    emitStatus();
    return;
  }

  // Agent text delta — speech is coming
  if (type === "agent.delta") {
    if (agentState !== "idle") {
      agentState = "idle";
      cancelSfxDelay();
      emitStatus();
    }
    return;
  }

  // Agent complete
  if (type === "agent.complete") {
    agentState = "idle";
    cancelSfxDelay();
    stopSfxLoop();
    emitStatus();
    return;
  }

  // Interrupt — stop everything (orchestrator propagates to downstream nodes)
  if (type === "control.interrupt") {
    agentState = "idle";
    cancelSfxDelay();
    stopSfxLoop();
    clearEmitQueue();
    destroySpeaker();
    playingKind = null;
    // Don't re-emit — orchestrator already sends interrupt to all downstream
    return;
  }
}

// ---- Main ----

function main(): void {
  // Load WAV clips
  if (settings.thinkingClip) {
    thinkingPcm = loadWavPcm(settings.thinkingClip);
    if (thinkingPcm) log(`Loaded thinking clip: ${settings.thinkingClip} (${thinkingPcm.length} bytes)`);
  }
  if (settings.toolClip) {
    toolPcm = loadWavPcm(settings.toolClip);
    if (toolPcm) log(`Loaded tool clip: ${settings.toolClip} (${toolPcm.length} bytes)`);
  }

  emit({ type: "lifecycle.ready", component: "audio-player" });

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      handleEvent(event);
    } catch {
      // ignore malformed
    }
  });

  rl.on("close", () => {
    stdinClosed = true;
    stopSfxLoop();
    if (speaker) {
      speaker.end();
      speaker.on("close", () => {
        emit({ type: "lifecycle.done", component: "audio-player" });
        process.exit(0);
      });
    } else {
      emit({ type: "lifecycle.done", component: "audio-player" });
      process.exit(0);
    }
  });

  process.on("SIGTERM", () => {
    stopSfxLoop();
    destroySpeaker();
    process.exit(0);
  });
}

main();
