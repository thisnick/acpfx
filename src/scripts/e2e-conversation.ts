/**
 * End-to-end voice conversation recorder.
 *
 * Runs the REAL pipeline:
 *   mic (file) → stt (elevenlabs) → vad → bridge (claude) → tts (elevenlabs) → play (file)
 *
 * Captures timestamps at every hop via a tee to a NDJSON log file,
 * then post-processes the log for latency analysis.
 *
 * Usage:
 *   pnpm e2e "your prompt"
 *   pnpm e2e "your prompt" claude-haiku-4-5-20251001
 *   pnpm e2e:haiku "your prompt"
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..", "..");
const CLI = path.join(PROJECT_DIR, "dist", "cli.js");
const OUTPUT_DIR = path.join(PROJECT_DIR, "demo-audio");

const INPUT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah - female, american
const OUTPUT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George - male, british
const ELEVENLABS_MODEL = "eleven_turbo_v2_5";
const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const SAMPLE_RATE = 16000;

// ---- WAV helpers ----

function createWavHeader(dataSize: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(dataSize + 36, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataSize, 40);
  return h;
}

// ---- Generate input audio via ElevenLabs REST ----

async function generateInputAudio(text: string, outputPath: string): Promise<number> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set. Add to .env and `direnv allow`.");

  log(`Generating input speech: "${text}"`);
  const resp = await fetch(
    `${ELEVENLABS_TTS_URL}/${INPUT_VOICE_ID}?output_format=pcm_16000`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );

  if (!resp.ok) throw new Error(`ElevenLabs TTS failed (${resp.status}): ${await resp.text()}`);

  const pcm = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(outputPath, Buffer.concat([createWavHeader(pcm.length), pcm]));
  const durationMs = (pcm.length / (SAMPLE_RATE * 2)) * 1000;
  log(`Input audio: ${(durationMs / 1000).toFixed(2)}s`);
  return durationMs;
}

// ---- Run the full pipeline as a single shell command ----

type PipelineResult = {
  transcript: string;
  sttText: string;
  timestamps: Record<string, number>;
  outputAudioDurationMs: number;
};

async function runPipeline(
  inputWavPath: string,
  outputWavPath: string,
  eventLogPath: string,
): Promise<PipelineResult> {
  // Run the full pipeline as a single shell pipe.
  // We insert a "timestamping tap" that logs every event with a wall-clock timestamp
  // to a file, while forwarding all events unchanged.
  //
  // The pipeline:
  //   mic → stt → [tap1 → file] → vad → [tap2 → file] → bridge → [tap3 → file] → tts → play
  //
  // Simplified: we use a single tap after vad (to capture speech events)
  // and capture bridge output by teeing to the log file.

  // Actually, the simplest approach: run the full pipeline and tee the bridge output
  // (which contains both input events forwarded and output text events) to a log.

  const pipelineCmd = [
    `node ${CLI} mic --provider file --path "${inputWavPath}" --no-pace`,
    `node ${CLI} stt --provider elevenlabs`,
    `node ${CLI} vad --pause-ms 600`,
    `node ${CLI} bridge claude --raw`,
    // Tee all events to log file while forwarding to tts
    `tee "${eventLogPath}"`,
    `node ${CLI} tts --provider elevenlabs --voice-id ${OUTPUT_VOICE_ID}`,
    `node ${CLI} play --provider file --path "${outputWavPath}"`,
  ].join(" | ");

  log("Pipeline: mic → stt → vad → bridge → tee(log) → tts → play");

  return new Promise((resolve, reject) => {
    const t0 = Date.now();

    const proc = spawn("bash", ["-c", pipelineCmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Stream stderr to show progress
    proc.stderr?.on("data", (c: Buffer) => {
      const lines = c.toString().split("\n").filter(l => l.trim());
      for (const line of lines) {
        // Only show bridge connection and key events, not every chunk
        if (line.includes("bridge") || line.includes("acpfx")) {
          process.stderr.write(`  ${line}\n`);
        }
      }
    });

    proc.on("close", async (code) => {
      log(`Pipeline exited (${code})`);

      // Parse the event log to extract timestamps and transcript
      const timestamps: Record<string, number> = {};
      let transcript = "";
      let sttText = "";

      try {
        const logContent = await fs.readFile(eventLogPath, "utf-8");
        // tee writes the raw NDJSON — but we don't have wall-clock timestamps
        // in the events themselves. We need another approach.
        //
        // Better: write a custom tap that adds timestamps.
        // For now, parse events and use the log file mtime as approximation.
        // Actually, we can time the whole pipeline and parse events for ordering.

        const lines = logContent.split("\n").filter(l => l.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === "speech.final" && !sttText) {
              sttText = event.text ?? "";
            }
            if (event.type === "text.delta") {
              transcript += event.delta ?? "";
            }
          } catch {}
        }
      } catch {}

      // Get output audio duration
      let outputAudioDurationMs = 0;
      try {
        const stat = await fs.stat(outputWavPath);
        const dataSize = stat.size - 44;
        if (dataSize > 0) outputAudioDurationMs = (dataSize / (SAMPLE_RATE * 2)) * 1000;
      } catch {}

      resolve({ transcript, sttText, timestamps, outputAudioDurationMs });
    });

    // Timeout
    setTimeout(() => {
      log("Pipeline timeout (180s)");
      proc.kill("SIGTERM");
    }, 180_000);
  });
}

// Better approach: custom timestamping tap that writes events + timestamps to a log

async function runPipelineWithTimestamps(
  inputWavPath: string,
  outputWavPath: string,
  eventLogPath: string,
): Promise<PipelineResult> {
  // We run the pipeline in two halves, intercepting the middle (bridge output)
  // to capture timestamps on each event type. But the previous approach of
  // manual stdin/stdout forwarding was buggy.
  //
  // New approach: write a tiny inline node script that acts as a timestamping tee.

  const tsLogPath = eventLogPath.replace(".jsonl", "-timestamps.jsonl");

  // Inline timestamping tee script — reads stdin NDJSON, writes to stdout unchanged,
  // and appends {timestamp, type} to the log file.
  const tsTapScript = `
    const fs = require('fs');
    const rl = require('readline').createInterface({ input: process.stdin });
    const fd = fs.openSync(${JSON.stringify(tsLogPath)}, 'w');
    const t0 = Date.now();
    rl.on('line', (line) => {
      process.stdout.write(line + '\\n');
      try {
        const e = JSON.parse(line);
        fs.writeSync(fd, JSON.stringify({ ts: Date.now() - t0, type: e.type, text: e.text, delta: e.delta, pendingText: e.pendingText }) + '\\n');
      } catch {}
    });
    rl.on('close', () => { fs.closeSync(fd); });
  `.trim();

  // Place a timestamping tap between vad and bridge (captures input events)
  // and another between bridge and tts (captures output events)
  const tapBeforeBridge = `node -e '${tsTapScript.replace(tsLogPath, tsLogPath.replace(".jsonl", "-in.jsonl"))}'`;
  const tapAfterBridge = `node -e '${tsTapScript.replace(tsLogPath, tsLogPath.replace(".jsonl", "-out.jsonl"))}'`;

  const inLogPath = tsLogPath.replace(".jsonl", "-in.jsonl");
  const outLogPath = tsLogPath.replace(".jsonl", "-out.jsonl");

  const tapInScript = `node -e '${makeTapScript(inLogPath)}'`;
  const tapOutScript = `node -e '${makeTapScript(outLogPath)}'`;

  const pipelineCmd = [
    `node ${CLI} mic --provider file --path "${inputWavPath}" --no-pace`,
    `node ${CLI} stt --provider elevenlabs`,
    `node ${CLI} vad --pause-ms 600`,
    tapInScript,     // timestamp tap: captures speech.pause, speech.final, etc.
    `node ${CLI} bridge claude --raw`,
    tapOutScript,    // timestamp tap: captures text.delta, text.complete, audio.chunk from tts
    `node ${CLI} tts --provider elevenlabs --voice-id ${OUTPUT_VOICE_ID}`,
    `node ${CLI} play --provider file --path "${outputWavPath}"`,
  ].join(" | ");

  log("Pipeline: mic → stt → vad → [tap] → bridge → [tap] → tts → play");

  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", pipelineCmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    proc.stderr?.on("data", (c: Buffer) => {
      const s = c.toString();
      if (s.includes("bridge") || s.includes("connected") || s.includes("submitted")) {
        process.stderr.write(`  ${s.trimEnd()}\n`);
      }
    });

    proc.on("close", async (code) => {
      log(`Pipeline exited (${code})`);

      // Parse both timestamp logs
      const timestamps: Record<string, number> = {};
      let transcript = "";
      let sttText = "";

      // Input events log (before bridge)
      try {
        const lines = (await fs.readFile(inLogPath, "utf-8")).split("\n").filter(l => l.trim());
        for (const line of lines) {
          const e = JSON.parse(line);
          if (e.type === "audio.chunk") {
            timestamps["lastAudioInput"] = e.ts;
          }
          if (e.type === "speech.final" && !timestamps["speechFinal"]) {
            timestamps["speechFinal"] = e.ts;
            sttText = e.text ?? "";
          }
          if (e.type === "speech.pause" && !timestamps["speechPause"]) {
            timestamps["speechPause"] = e.ts;
          }
        }
      } catch {}

      // Output events log (after bridge)
      try {
        const lines = (await fs.readFile(outLogPath, "utf-8")).split("\n").filter(l => l.trim());
        for (const line of lines) {
          const e = JSON.parse(line);
          if (e.type === "text.delta") {
            if (!timestamps["firstTextDelta"]) timestamps["firstTextDelta"] = e.ts;
            transcript += e.delta ?? "";
          }
          if (e.type === "text.complete") {
            timestamps["textComplete"] = e.ts;
          }
        }
      } catch {}

      // Note: firstAudioOutput timestamp comes from the tts output side.
      // Since we tap between bridge and tts (not between tts and play),
      // we don't have it. We can approximate from the tts latency benchmarks (~500ms after TTFT).

      let outputAudioDurationMs = 0;
      try {
        const stat = await fs.stat(outputWavPath);
        const dataSize = stat.size - 44;
        if (dataSize > 0) outputAudioDurationMs = (dataSize / (SAMPLE_RATE * 2)) * 1000;
      } catch {}

      // Clean up temp logs
      await fs.unlink(inLogPath).catch(() => {});
      await fs.unlink(outLogPath).catch(() => {});

      resolve({ transcript, sttText, timestamps, outputAudioDurationMs });
    });

    setTimeout(() => { proc.kill("SIGTERM"); }, 180_000);
  });
}

function makeTapScript(logPath: string): string {
  // Escape for embedding in shell single quotes
  return `
    const fs = require("fs");
    const rl = require("readline").createInterface({ input: process.stdin });
    const fd = fs.openSync("${logPath}", "w");
    const t0 = Date.now();
    rl.on("line", (line) => {
      process.stdout.write(line + "\\n");
      try {
        const e = JSON.parse(line);
        fs.writeSync(fd, JSON.stringify({ ts: Date.now() - t0, type: e.type, text: e.text, delta: e.delta, pendingText: e.pendingText }) + "\\n");
      } catch {}
    });
    rl.on("close", () => fs.closeSync(fd));
  `.replace(/\n/g, " ").trim();
}

// ---- Audio merging ----

async function mergeAudio(
  inputPath: string, outputPath: string, conversationPath: string,
  inputDurationMs: number, gapMs: number,
): Promise<void> {
  let hasOutput = false;
  try { hasOutput = (await fs.stat(outputPath)).size > 44; } catch {}

  if (!hasOutput) {
    await fs.copyFile(inputPath, conversationPath);
    return;
  }

  const gap = Math.max(gapMs / 1000, 0.1);
  const tmp = (name: string) => path.join(OUTPUT_DIR, name);

  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=mono -t ${gap} -c:a pcm_s16le "${tmp("_s.wav")}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i "${inputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${tmp("_i.wav")}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i "${outputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${tmp("_o.wav")}"`, { stdio: "pipe" });
  await fs.writeFile(tmp("_c.txt"), `file '${tmp("_i.wav")}'\nfile '${tmp("_s.wav")}'\nfile '${tmp("_o.wav")}'`);
  execSync(`ffmpeg -y -f concat -safe 0 -i "${tmp("_c.txt")}" -c:a pcm_s16le "${conversationPath}"`, { stdio: "pipe" });

  for (const f of ["_s.wav", "_i.wav", "_o.wav", "_c.txt"]) await fs.unlink(tmp(f)).catch(() => {});
  log(`Merged: ${conversationPath}`);
}

// ---- Spectrogram ----

async function generateSpectrogram(
  convPath: string, specPath: string,
  inputMs: number, gapMs: number, outputMs: number,
): Promise<void> {
  const totalMs = inputMs + gapMs + outputMs;
  const W = 1200, H = 400;
  const raw = path.join(OUTPUT_DIR, "_spec.png");

  try {
    execSync(`sox "${convPath}" -n spectrogram -x ${W} -y ${H - 100} -o "${raw}"`, { stdio: "pipe" });
  } catch {
    execSync(`ffmpeg -y -i "${convPath}" -lavfi "showspectrumpic=s=${W}x${H - 100}:mode=combined:color=intensity" "${raw}"`, { stdio: "pipe" });
  }

  const x1 = Math.floor((inputMs / totalMs) * W);
  const x2 = Math.floor(((inputMs + gapMs) / totalMs) * W);

  try {
    execSync([
      `magick "${raw}"`,
      `-stroke red -strokewidth 2 -draw "line ${x1},0 ${x1},${H}"`,
      `-stroke green -strokewidth 2 -draw "line ${x2},0 ${x2},${H}"`,
      `-stroke none`,
      `-fill "rgba(0,100,255,0.15)" -draw "rectangle 0,0 ${x1},${H}"`,
      `-fill "rgba(255,165,0,0.15)" -draw "rectangle ${x1},0 ${x2},${H}"`,
      `-fill "rgba(0,200,0,0.15)" -draw "rectangle ${x2},0 ${W},${H}"`,
      `-fill white -stroke none -pointsize 18`,
      `-gravity NorthWest`,
      `-annotate +${Math.max(x1 * 0.3, 5)}+8 "INPUT"`,
      `-annotate +${Math.max((x1 + x2) / 2 - 40, x1 + 5)}+8 "WAIT"`,
      `-annotate +${Math.max((x2 + W) / 2 - 30, x2 + 5)}+8 "OUTPUT"`,
      `"${specPath}"`,
    ].join(" "), { stdio: "pipe", shell: "/bin/bash" });
  } catch {
    await fs.copyFile(raw, specPath);
  }

  await fs.unlink(raw).catch(() => {});
  log(`Spectrogram: ${specPath}`);
}

// ---- Logging ----

let t0Global = Date.now();
function log(msg: string): void {
  process.stderr.write(`[e2e +${((Date.now() - t0Global) / 1000).toFixed(1)}s] ${msg}\n`);
}

// ---- Main ----

async function main(): Promise<void> {
  t0Global = Date.now();

  const inputText = process.argv[2] || "What is the fibonacci sequence and why is it important?";
  const model = process.argv[3] || process.env.ACPFX_MODEL || undefined;

  // Warm up acpx
  const modelArgs = model ? `--model ${model}` : "";
  try {
    log(`Warming up acpx${model ? ` (${model})` : ""}...`);
    execSync(`acpx ${modelArgs} --approve-all --format quiet claude "ping"`, {
      stdio: ["ignore", "ignore", "inherit"], cwd: PROJECT_DIR, timeout: 60000,
    });
    log("Session warm.");
  } catch (err) {
    log(`Warning: ${err instanceof Error ? err.message : err}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const inputWav = path.join(OUTPUT_DIR, "e2e-input.wav");
  const outputWav = path.join(OUTPUT_DIR, "e2e-output.wav");
  const convWav = path.join(OUTPUT_DIR, "e2e-conversation.wav");
  const specPng = path.join(OUTPUT_DIR, "e2e-spectrogram.png");
  const transcriptJson = path.join(OUTPUT_DIR, "e2e-transcript.json");
  const eventLog = path.join(OUTPUT_DIR, "e2e-events.jsonl");

  log("=== End-to-End Conversation Recorder ===");
  log(`Prompt: "${inputText}"`);

  // Step 1: Generate input audio
  const tGen = Date.now();
  const inputDurationMs = await generateInputAudio(inputText, inputWav);
  log(`Input TTS: ${Date.now() - tGen}ms`);

  // Step 2: Run full pipeline with timestamp taps
  const result = await runPipelineWithTimestamps(inputWav, outputWav, eventLog);
  const ts = result.timestamps;

  // Step 3: Latency waterfall
  log("\n=== Latency Waterfall ===");
  const lastAudio = ts["lastAudioInput"] ?? 0;
  const speechFinal = ts["speechFinal"] ?? 0;
  const speechPause = ts["speechPause"] ?? 0;
  const ttft = ts["firstTextDelta"] ?? 0;
  const textComplete = ts["textComplete"] ?? 0;

  log(`  Audio input ends:        +${lastAudio}ms`);
  log(`  STT speech.final:        +${speechFinal}ms  (STT latency: ${speechFinal - lastAudio}ms)`);
  log(`  VAD speech.pause:        +${speechPause}ms  (VAD latency: ${speechPause - speechFinal}ms)`);
  log(`  TTFT (first text.delta): +${ttft}ms  (agent latency: ${ttft - speechPause}ms)`);
  log(`  text.complete:           +${textComplete}ms`);
  log(`  ---`);
  log(`  End-of-speech → TTFT:    ${ttft - lastAudio}ms`);
  log(`  End-of-speech → agent done: ${textComplete - lastAudio}ms`);
  log(`  Output audio duration:   ${(result.outputAudioDurationMs / 1000).toFixed(2)}s`);
  log(`  STT transcript:          "${result.sttText}"`);
  log(`  Agent response:          "${result.transcript.slice(0, 150)}..."`);

  // Step 4: Merge audio
  // Gap = time from input audio end to first agent audio output
  // Approximate: speechPause + agent latency + TTS latency
  const gapMs = Math.max(ttft + 500, 1000); // TTFT + ~500ms TTS
  await mergeAudio(inputWav, outputWav, convWav, inputDurationMs, gapMs);

  // Step 5: Spectrogram
  await generateSpectrogram(convWav, specPng, inputDurationMs, gapMs, result.outputAudioDurationMs);

  // Step 6: Transcript
  const data = {
    input: { text: inputText, sttTranscript: result.sttText, audioDurationMs: inputDurationMs },
    latency: {
      audioInputEndsMs: lastAudio,
      sttSpeechFinalMs: speechFinal,
      sttLatencyMs: speechFinal - lastAudio,
      vadSpeechPauseMs: speechPause,
      vadLatencyMs: speechPause - speechFinal,
      ttftMs: ttft,
      agentLatencyMs: ttft - speechPause,
      textCompleteMs: textComplete,
      endOfSpeechToTtftMs: ttft - lastAudio,
    },
    output: { text: result.transcript, audioDurationMs: result.outputAudioDurationMs },
    model: model ?? "default",
    recordedAt: new Date().toISOString(),
  };

  await fs.writeFile(transcriptJson, JSON.stringify(data, null, 2));

  log("\n=== Output Files ===");
  log(`  Conversation: ${convWav}`);
  log(`  Input audio:  ${inputWav}`);
  log(`  Output audio: ${outputWav}`);
  log(`  Spectrogram:  ${specPng}`);
  log(`  Transcript:   ${transcriptJson}`);
  log("\n=== Done ===");
}

main().catch((err) => {
  process.stderr.write(`\n[e2e] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.cause) {
    process.stderr.write(`Cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}\n`);
  }
  process.exit(1);
});
