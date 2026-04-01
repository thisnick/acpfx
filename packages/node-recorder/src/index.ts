/**
 * recorder node — captures all events to events.jsonl, writes audio tracks
 * to WAV files, generates conversation.wav and timeline.html.
 *
 * Settings (via ACPFX_SETTINGS):
 *   outputDir?: string — output directory (default: ./recordings/<run-id>)
 */

import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
  readFileSync,
  type WriteStream,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

type Settings = {
  outputDir?: string;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");
const RUN_ID = randomUUID().slice(0, 8);
const OUTPUT_DIR = resolve(settings.outputDir ?? "./recordings", RUN_ID);

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

// State
let eventsStream: WriteStream;
let startTime = Date.now();
const allEvents: Array<Record<string, unknown>> = [];

// Audio track writers
type TrackWriter = {
  stream: WriteStream;
  path: string;
  bytesWritten: number;
};
const tracks = new Map<string, TrackWriter>();


function createWavHeader(dataSize: number, sr: number, ch: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sr * ch * bitsPerSample) / 8;
  const blockAlign = (ch * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  let off = 0;
  header.write("RIFF", off); off += 4;
  header.writeUInt32LE(dataSize + 36, off); off += 4;
  header.write("WAVE", off); off += 4;
  header.write("fmt ", off); off += 4;
  header.writeUInt32LE(16, off); off += 4;
  header.writeUInt16LE(1, off); off += 2;
  header.writeUInt16LE(ch, off); off += 2;
  header.writeUInt32LE(sr, off); off += 4;
  header.writeUInt32LE(byteRate, off); off += 4;
  header.writeUInt16LE(blockAlign, off); off += 2;
  header.writeUInt16LE(bitsPerSample, off); off += 2;
  header.write("data", off); off += 4;
  header.writeUInt32LE(dataSize, off);
  return header;
}

function getOrCreateTrack(trackId: string): TrackWriter {
  let tw = tracks.get(trackId);
  if (tw) return tw;

  const filename = `${trackId}.wav`;
  const path = join(OUTPUT_DIR, filename);
  const stream = createWriteStream(path);
  // Write placeholder header
  stream.write(Buffer.alloc(44));
  tw = { stream, path, bytesWritten: 0 };
  tracks.set(trackId, tw);
  return tw;
}

async function finalizeTrack(tw: TrackWriter): Promise<void> {
  await new Promise<void>((res, rej) => {
    tw.stream.end(() => res());
    tw.stream.on("error", rej);
  });

  const header = createWavHeader(tw.bytesWritten, SAMPLE_RATE, CHANNELS);
  const fd = await open(tw.path, "r+");
  await fd.write(header, 0, header.length, 0);
  await fd.close();
}

function generateConversationWav(): void {
  // Merge input (mic) and output (tts) tracks into a single timeline WAV.
  // We place them sequentially: input audio, then a gap, then output audio.
  // Timeline positions come from event timestamps.

  const micTrack = tracks.get("mic");
  const ttsTrack = tracks.get("tts");
  if (!micTrack && !ttsTrack) return;

  // Find the first and last audio chunk timestamps for each track
  let micStartMs = Infinity, micEndMs = 0;
  let ttsStartMs = Infinity, ttsEndMs = 0;

  for (const ev of allEvents) {
    if (ev.type === "audio.chunk") {
      const ts = (ev.ts as number) ?? 0;
      const dur = (ev.durationMs as number) ?? 0;
      if (ev.trackId === "mic" || ev._from === "mic") {
        micStartMs = Math.min(micStartMs, ts);
        micEndMs = Math.max(micEndMs, ts + dur);
      }
      if (ev.trackId === "tts" || ev._from === "tts") {
        ttsStartMs = Math.min(ttsStartMs, ts);
        ttsEndMs = Math.max(ttsEndMs, ts + dur);
      }
    }
  }

  // Calculate total duration and offsets relative to the earliest timestamp
  const globalStart = Math.min(
    micStartMs === Infinity ? Infinity : micStartMs,
    ttsStartMs === Infinity ? Infinity : ttsStartMs,
  );
  if (globalStart === Infinity) return;

  const globalEnd = Math.max(micEndMs, ttsEndMs);
  const totalDurationMs = globalEnd - globalStart;
  const totalSamples = Math.ceil((totalDurationMs / 1000) * SAMPLE_RATE);
  const totalBytes = totalSamples * CHANNELS * BYTES_PER_SAMPLE;

  // Create a silent buffer for the full duration
  const pcm = Buffer.alloc(totalBytes);

  // Write mic audio at correct timeline position
  for (const ev of allEvents) {
    if (ev.type !== "audio.chunk") continue;
    const ts = (ev.ts as number) ?? 0;
    const trackId = (ev.trackId as string) ?? (ev._from as string) ?? "";
    if (trackId !== "mic" && trackId !== "tts") continue;

    const offsetMs = ts - globalStart;
    const offsetSamples = Math.floor((offsetMs / 1000) * SAMPLE_RATE);
    const offsetBytes = offsetSamples * CHANNELS * BYTES_PER_SAMPLE;
    const data = Buffer.from((ev.data as string) ?? "", "base64");

    // Mix: add samples (clamped to int16 range)
    for (let i = 0; i < data.length && offsetBytes + i + 1 < pcm.length; i += 2) {
      const existing = pcm.readInt16LE(offsetBytes + i);
      const incoming = data.readInt16LE(i);
      const mixed = Math.max(-32768, Math.min(32767, existing + incoming));
      pcm.writeInt16LE(mixed, offsetBytes + i);
    }
  }

  const convPath = join(OUTPUT_DIR, "conversation.wav");
  const header = createWavHeader(pcm.length, SAMPLE_RATE, CHANNELS);
  writeFileSync(convPath, Buffer.concat([header, pcm]));
  log.info(`Wrote conversation.wav (${totalDurationMs}ms)`);
}

function generateTimelineHtml(): void {
  // Read WAV files as base64 for embedding
  let inputWavB64 = "";
  let outputWavB64 = "";
  const micPath = join(OUTPUT_DIR, "mic.wav");
  const ttsPath = join(OUTPUT_DIR, "tts.wav");
  try { inputWavB64 = readFileSync(micPath).toString("base64"); } catch {}
  try { outputWavB64 = readFileSync(ttsPath).toString("base64"); } catch {}

  // Prepare event markers
  const markers = allEvents
    .filter((ev) => {
      const t = ev.type as string;
      return (
        t === "speech.partial" ||
        t === "speech.delta" ||
        t === "speech.final" ||
        t === "speech.pause" ||
        t === "agent.submit" ||
        t === "agent.delta" ||
        t === "agent.complete" ||
        t === "control.interrupt"
      );
    })
    .map((ev) => ({
      time: ((ev.ts as number) - startTime) / 1000,
      type: ev.type,
      text:
        (ev as any).text ??
        (ev as any).delta ??
        (ev as any).pendingText ??
        (ev as any).reason ??
        "",
    }));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>acpfx Timeline - ${RUN_ID}</title>
<script src="https://unpkg.com/wavesurfer.js@7"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
  h1 { font-size: 18px; margin-bottom: 16px; color: #88f; }
  h2 { font-size: 14px; margin: 16px 0 8px; color: #aaa; }
  .track { background: #16213e; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .track-label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .markers { max-height: 300px; overflow-y: auto; font-size: 12px; font-family: monospace; }
  .marker { padding: 2px 8px; border-left: 3px solid #444; margin-bottom: 2px; }
  .marker.speech { border-color: #4caf50; }
  .marker.agent { border-color: #2196f3; }
  .marker.control { border-color: #f44336; }
  .marker .time { color: #888; margin-right: 8px; }
  .marker .type { color: #fff; margin-right: 8px; font-weight: bold; }
  .marker .text { color: #ccc; }
  .controls { margin: 12px 0; }
  button { background: #333; color: #eee; border: 1px solid #555; padding: 6px 16px; border-radius: 4px; cursor: pointer; margin-right: 8px; }
  button:hover { background: #444; }
</style>
</head>
<body>
<h1>acpfx Timeline - Run ${RUN_ID}</h1>

<div class="controls">
  <button onclick="playPause()">Play / Pause</button>
</div>

<div class="track">
  <div class="track-label">Input (Mic)</div>
  <div id="input-waveform"></div>
</div>

<div class="track">
  <div class="track-label">Output (TTS)</div>
  <div id="output-waveform"></div>
</div>

<h2>Event Timeline</h2>
<div class="markers" id="markers"></div>

<script>
const MARKERS = ${JSON.stringify(markers)};

// Render markers
const markersEl = document.getElementById('markers');
MARKERS.forEach(m => {
  const div = document.createElement('div');
  const cat = m.type.startsWith('speech') ? 'speech' : m.type.startsWith('agent') ? 'agent' : 'control';
  div.className = 'marker ' + cat;
  div.innerHTML = '<span class="time">' + m.time.toFixed(2) + 's</span>'
    + '<span class="type">' + m.type + '</span>'
    + '<span class="text">' + (m.text || '').substring(0, 80) + '</span>';
  markersEl.appendChild(div);
});

// WaveSurfer instances
let wsInput, wsOutput;

${inputWavB64 ? `
wsInput = WaveSurfer.create({
  container: '#input-waveform',
  waveColor: '#4caf50',
  progressColor: '#2e7d32',
  height: 80,
  url: 'data:audio/wav;base64,${inputWavB64}',
});
` : `document.getElementById('input-waveform').textContent = 'No input audio recorded';`}

${outputWavB64 ? `
wsOutput = WaveSurfer.create({
  container: '#output-waveform',
  waveColor: '#2196f3',
  progressColor: '#1565c0',
  height: 80,
  url: 'data:audio/wav;base64,${outputWavB64}',
});
` : `document.getElementById('output-waveform').textContent = 'No output audio recorded';`}

function playPause() {
  if (wsInput) wsInput.playPause();
  if (wsOutput) wsOutput.playPause();
}
</script>
</body>
</html>`;

  const htmlPath = join(OUTPUT_DIR, "timeline.html");
  writeFileSync(htmlPath, html);
  log.info(`Wrote timeline.html`);
}

async function finalize(): Promise<void> {
  // Close events stream
  if (eventsStream) {
    await new Promise<void>((res) => eventsStream.end(() => res()));
  }

  // Finalize all audio tracks
  for (const tw of tracks.values()) {
    await finalizeTrack(tw);
  }

  // Generate conversation.wav
  try {
    generateConversationWav();
  } catch (err) {
    log.error(`Error generating conversation.wav: ${err}`);
  }

  // Generate timeline.html
  try {
    generateTimelineHtml();
  } catch (err) {
    log.error(`Error generating timeline.html: ${err}`);
  }

  log.info(`Recording saved to ${OUTPUT_DIR}`);
}

// --- Main ---

mkdirSync(OUTPUT_DIR, { recursive: true });
eventsStream = createWriteStream(join(OUTPUT_DIR, "events.jsonl"));
startTime = Date.now();

emit({ type: "lifecycle.ready", component: "recorder" });
log.info(`Recording to ${OUTPUT_DIR}`);

const rl = onEvent((event) => {
  // Record every event to events.jsonl
  allEvents.push(event);
  eventsStream.write(JSON.stringify(event) + "\n");

  // Capture audio tracks
  if (event.type === "audio.chunk") {
    const trackId = (event.trackId as string) ?? (event._from as string) ?? "unknown";
    const tw = getOrCreateTrack(trackId);
    const pcm = Buffer.from((event.data as string) ?? "", "base64");
    tw.stream.write(pcm);
    tw.bytesWritten += pcm.length;
  }
});

rl.on("close", () => {
  finalize().then(() => {
    emit({ type: "lifecycle.done", component: "recorder" });
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  finalize().then(() => process.exit(0));
});
