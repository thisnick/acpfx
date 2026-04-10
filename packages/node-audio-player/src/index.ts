/**
 * audio-player node — audio mixer with priority queue and SFX.
 *
 * Receives TTS audio + bridge events, implements a priority queue
 * (speech > SFX), loads WAV clips for thinking/tool indicator sounds,
 * and emits audio.chunk events for downstream playback (mic-speaker).
 *
 * Does NOT play audio locally — the downstream mic-speaker node handles
 * speaker output through the OS audio system with echo cancellation.
 *
 * Settings (via ACPFX_SETTINGS):
 *   speechSource?: string   — _from value identifying speech audio (default: "tts")
 *   sampleRate?: number     — sample rate (default: 16000)
 *   thinkingClip?: string   — path to WAV file for thinking sound (default: bundled)
 *   toolClip?: string       — path to WAV file for tool use sound (default: bundled)
 *   sfxVolume?: number      — 0.0-1.0 gain for SFX (default: 0.3)
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

handleManifestFlag();

type Settings = {
  speechSource?: string;
  sampleRate?: number;
  thinkingClip?: string;
  toolClip?: string;
  sfxVolume?: number;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const SPEECH_SOURCE = settings.speechSource ?? "tts";
const SAMPLE_RATE = settings.sampleRate ?? 16000;
const SFX_VOLUME = settings.sfxVolume ?? 0.3;
const BYTES_PER_SAMPLE = 2;

// ---- Resolve bundled sounds ----

/** Find a bundled sound file. Checks relative to the script, then common locations. */
function findBundledSound(filename: string): string | null {
  const candidates = [
    join(__dirname, "..", "sounds", filename),       // dev: src/../sounds/
    join(__dirname, "sounds", filename),             // dist: next to bundled .js
    join(__dirname, "..", "..", "sounds", filename),  // npm package layout
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- Audio helpers ----

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
    log.error(`Failed to load WAV: ${filePath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---- State ----

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
let sfxClipOffset = 0;
let sfxCurrentClip: Buffer | null = null;

const SFX_CHUNK_MS = 100;
const SFX_CHUNK_BYTES = Math.floor(SAMPLE_RATE * BYTES_PER_SAMPLE * SFX_CHUNK_MS / 1000);

// ---- Pacing state ----
// All audio (speech + SFX) goes through the pacing queue.
// We maintain a ~500ms lookahead buffer downstream.
const LOOKAHEAD_MS = 500;
let audioQueue: Array<{pcm: Buffer, kind: "speech" | "sfx"}> = [];
let playbackEndTime = 0;
let pacingTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueAudio(pcm: Buffer, kind: "speech" | "sfx"): void {
  audioQueue.push({ pcm, kind });
  drainToLookahead();
}

function drainToLookahead(): void {
  const now = Date.now();
  if (playbackEndTime <= now) playbackEndTime = now;
  while (audioQueue.length > 0 && (playbackEndTime - now) < LOOKAHEAD_MS) {
    const chunk = audioQueue.shift()!;
    emitChunk(chunk.pcm, chunk.kind);
    const durationMs = Math.round((chunk.pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);
    playbackEndTime += durationMs;
  }
  if (audioQueue.length > 0) schedulePacing();
}

function schedulePacing(): void {
  if (pacingTimer || audioQueue.length === 0) return;
  const delay = Math.max(0, (playbackEndTime - LOOKAHEAD_MS) - Date.now());
  pacingTimer = setTimeout(() => {
    pacingTimer = null;
    drainToLookahead();
  }, delay);
}

function flushAudioQueue(): void {
  audioQueue = [];
  if (pacingTimer) { clearTimeout(pacingTimer); pacingTimer = null; }
  playbackEndTime = 0;
}


function emitStatus(): void {
  let text: string;
  if (playingKind === "speech") {
    text = "\u25B6 speech";
  } else if (sfxActive) {
    text = `\u266B ${agentState} SFX`;
  } else if (agentState !== "idle") {
    text = agentState;
  } else {
    text = "\u23F9 idle";
  }
  emit({
    type: "node.status",
    text,
  });
}

// ---- Emit audio chunks downstream ----

function emitChunk(pcm: Buffer, kind: "speech" | "sfx"): void {
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
  log.info(`Starting SFX loop (${agentState})`);

  writeSfxChunk();
  sfxLoopTimer = setInterval(writeSfxChunk, SFX_CHUNK_MS);
}

function writeSfxChunk(): void {
  if (!sfxActive || !sfxCurrentClip) return;

  const remaining = sfxCurrentClip.length - sfxClipOffset;
  if (remaining <= 0) {
    sfxClipOffset = 0;
  }

  const bytesToWrite = Math.min(SFX_CHUNK_BYTES, sfxCurrentClip.length - sfxClipOffset);
  const chunk = sfxCurrentClip.subarray(sfxClipOffset, sfxClipOffset + bytesToWrite);
  sfxClipOffset += bytesToWrite;

  enqueueAudio(chunk, "sfx");
}

/** Stop the SFX loop timer. */
function stopSfxLoop(): void {
  if (sfxLoopTimer) {
    clearInterval(sfxLoopTimer);
    sfxLoopTimer = null;
  }
  if (sfxActive) {
    sfxActive = false;
    log.info("Stopped SFX loop");
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

/** Stop SFX for incoming speech. */
function flushSfxForSpeech(): void {
  stopSfxLoop();
}

// ---- Event handling ----

function handleEvent(event: Record<string, unknown>): void {
  const type = event.type as string;
  const from = event._from as string | undefined;

  // Speech audio from TTS
  if (type === "audio.chunk") {
    if (from !== SPEECH_SOURCE) {
      log.debug(`Ignoring audio.chunk from "${from}" (expected "${SPEECH_SOURCE}")`);
      return;
    }
    cancelSfxDelay();

    if (sfxActive) {
      flushSfxForSpeech();
    }

    playingKind = "speech";
    const pcm = Buffer.from(event.data as string, "base64");
    enqueueAudio(pcm, "speech");
    return;
  }

  // Agent thinking — delay SFX start by 500ms (+ speech drain time if buffered)
  if (type === "agent.thinking") {
    agentState = "thinking";
    cancelSfxDelay();
    const now = Date.now();
    const speechRemaining = Math.max(0, playbackEndTime - now);
    sfxDelayTimer = setTimeout(() => {
      sfxDelayTimer = null;
      if (agentState === "thinking") startSfxLoop();
    }, speechRemaining + THINKING_DELAY_MS);
    emitStatus();
    return;
  }

  // Tool started — start SFX immediately (or after speech drains)
  if (type === "agent.tool_start") {
    agentState = "tool";
    cancelSfxDelay();
    stopSfxLoop();
    const now = Date.now();
    const speechRemaining = Math.max(0, playbackEndTime - now);
    if (speechRemaining > 0) {
      sfxDelayTimer = setTimeout(() => {
        sfxDelayTimer = null;
        if (agentState === "tool") startSfxLoop();
      }, speechRemaining);
    } else {
      startSfxLoop();
    }
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
    // Don't flush queue — let remaining audio play out
    // Just reset playbackEndTime so next turn gets a fresh burst
    playbackEndTime = 0;
    cancelSfxDelay();
    stopSfxLoop();
    emitStatus();
    return;
  }

  // Interrupt — stop everything
  if (type === "control.interrupt") {
    agentState = "idle";
    flushAudioQueue();
    cancelSfxDelay();
    stopSfxLoop();
    playingKind = null;
    return;
  }
}

// ---- Main ----

function main(): void {
  const thinkingPath = settings.thinkingClip ?? findBundledSound("thinking.wav");
  const toolPath = settings.toolClip ?? findBundledSound("typing.wav");

  if (thinkingPath) {
    thinkingPcm = loadWavPcm(thinkingPath);
    if (thinkingPcm) log.info(`Loaded thinking clip: ${thinkingPath} (${thinkingPcm.length} bytes)`);
  }
  if (toolPath) {
    toolPcm = loadWavPcm(toolPath);
    if (toolPcm) log.info(`Loaded tool clip: ${toolPath} (${toolPcm.length} bytes)`);
  }

  emit({ type: "lifecycle.ready", component: "audio-player" });

  const rl = onEvent(handleEvent);

  rl.on("close", () => {
    stopSfxLoop();
    emit({ type: "lifecycle.done", component: "audio-player" });
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopSfxLoop();
    process.exit(0);
  });
}

main();
