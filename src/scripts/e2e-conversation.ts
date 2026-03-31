/**
 * End-to-end voice conversation recorder.
 *
 * Records a full bidirectional conversation through the REAL pipeline:
 *   mic (file) → stt (elevenlabs) → vad → bridge (claude) → tts (elevenlabs) → play (file)
 *
 * Captures timestamps at every hop for latency analysis:
 *   1. Audio input ends (last audio.chunk from mic)
 *   2. STT produces speech.final (transcription complete)
 *   3. VAD emits speech.pause (pause detected, text submitted)
 *   4. Bridge receives first text.delta (TTFT from agent)
 *   5. TTS produces first audio.chunk (time to first audio)
 *   6. Agent completes (text.complete)
 *
 * Usage:
 *   pnpm e2e "your prompt"
 *   pnpm e2e "your prompt" claude-haiku-4-5-20251001
 *   pnpm e2e:haiku "your prompt"
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  const header = Buffer.alloc(44);
  let o = 0;
  header.write("RIFF", o); o += 4;
  header.writeUInt32LE(dataSize + 36, o); o += 4;
  header.write("WAVE", o); o += 4;
  header.write("fmt ", o); o += 4;
  header.writeUInt32LE(16, o); o += 4;
  header.writeUInt16LE(1, o); o += 2;   // PCM
  header.writeUInt16LE(1, o); o += 2;   // mono
  header.writeUInt32LE(SAMPLE_RATE, o); o += 4;
  header.writeUInt32LE(SAMPLE_RATE * 2, o); o += 4;
  header.writeUInt16LE(2, o); o += 2;
  header.writeUInt16LE(16, o); o += 2;
  header.write("data", o); o += 4;
  header.writeUInt32LE(dataSize, o);
  return header;
}

// ---- Generate input audio via ElevenLabs REST ----

async function generateInputAudio(text: string, outputPath: string): Promise<number> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set. Add it to .env and run `direnv allow`.");

  log(`Generating input speech: "${text}"`);
  const url = `${ELEVENLABS_TTS_URL}/${INPUT_VOICE_ID}?output_format=pcm_16000`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${body}`);
  }

  const pcm = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, Buffer.concat([createWavHeader(pcm.length), pcm]));

  const durationMs = (pcm.length / (SAMPLE_RATE * 2)) * 1000;
  log(`Input audio: ${(durationMs / 1000).toFixed(2)}s`);
  return durationMs;
}

// ---- Latency timestamps ----

type Timestamps = {
  pipelineStartMs: number;       // when pipeline starts
  lastAudioInputMs: number;      // last audio.chunk from mic (end of speech input)
  speechFinalMs: number;         // stt emits speech.final (transcription done)
  speechPauseMs: number;         // vad emits speech.pause (pause detected → submit)
  firstTextDeltaMs: number;      // TTFT: first text.delta from agent
  firstAudioOutputMs: number;    // first audio.chunk from TTS
  textCompleteMs: number;        // text.complete from agent
  lastAudioOutputMs: number;     // last audio.chunk from TTS
};

function emptyTimestamps(): Timestamps {
  return {
    pipelineStartMs: 0,
    lastAudioInputMs: 0,
    speechFinalMs: 0,
    speechPauseMs: 0,
    firstTextDeltaMs: 0,
    firstAudioOutputMs: 0,
    textCompleteMs: 0,
    lastAudioOutputMs: 0,
  };
}

type PipelineResult = {
  transcript: string;
  sttText: string;
  timestamps: Timestamps;
  outputAudioDurationMs: number;
};

// ---- Full pipeline: mic → stt → vad → bridge → tts → play ----

async function runFullPipeline(
  inputWavPath: string,
  outputWavPath: string,
): Promise<PipelineResult> {
  return new Promise((resolve, reject) => {
    const ts = emptyTimestamps();
    ts.pipelineStartMs = Date.now();
    const t0 = ts.pipelineStartMs;

    let transcript = "";
    let sttText = "";

    // Build the full pipeline as one shell command.
    // We intercept by reading the final stage's stdout (which forwards all events).
    // But we need timestamps at intermediate points. Solution: use a node script
    // as a "timestamping tap" that intercepts specific events.
    //
    // Instead of a single pipe, we spawn stages individually and wire them:
    //   mic → [stt → vad] → bridge → [tts → play]
    // We read the NDJSON between stages to capture timestamps.

    // --- Input stage: mic → stt → vad ---
    const inputCmd = [
      `node ${CLI} mic --provider file --path "${inputWavPath}" --no-pace`,
      `node ${CLI} stt --provider elevenlabs`,
      `node ${CLI} vad --pause-ms 600`,
    ].join(" | ");

    // --- Agent stage: bridge ---
    const bridgeCmd = `node ${CLI} bridge claude --raw --verbose`;

    // --- Output stage: tts → play ---
    const outputCmd = [
      `node ${CLI} tts --provider elevenlabs --voice-id ${OUTPUT_VOICE_ID}`,
      `node ${CLI} play --provider file --path "${outputWavPath}"`,
    ].join(" | ");

    log("Starting input pipeline: mic → stt → vad");
    const inputStage = spawn("bash", ["-c", inputCmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    log("Starting bridge");
    const bridgeStage = spawn("bash", ["-c", bridgeCmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    log("Starting output pipeline: tts → play");
    const outputStage = spawn("bash", ["-c", outputCmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Forward stderr
    inputStage.stderr?.on("data", (c: Buffer) => process.stderr.write(`[input] ${c}`));
    bridgeStage.stderr?.on("data", (c: Buffer) => process.stderr.write(`[bridge] ${c}`));
    outputStage.stderr?.on("data", (c: Buffer) => process.stderr.write(`[output] ${c}`));

    // --- Wire: inputStage.stdout → bridge.stdin ---
    // But we intercept to capture timestamps
    let inputBuffer = "";
    inputStage.stdout?.on("data", (chunk: Buffer) => {
      inputBuffer += chunk.toString("utf-8");
      let idx = inputBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = inputBuffer.slice(0, idx).trim();
        inputBuffer = inputBuffer.slice(idx + 1);

        if (line.length > 0) {
          try {
            const event = JSON.parse(line);
            const now = Date.now();

            if (event.type === "audio.chunk") {
              ts.lastAudioInputMs = now - t0;
            }

            if (event.type === "speech.final") {
              ts.speechFinalMs = now - t0;
              sttText += (sttText ? " " : "") + (event.text ?? "");
              log(`STT speech.final at +${ts.speechFinalMs}ms: "${event.text}"`);
            }

            if (event.type === "speech.pause") {
              ts.speechPauseMs = now - t0;
              log(`VAD speech.pause at +${ts.speechPauseMs}ms (pendingText: "${event.pendingText}")`);
            }
          } catch {
            // forward anyway
          }

          // Forward to bridge
          bridgeStage.stdin?.write(line + "\n");
        }
        idx = inputBuffer.indexOf("\n");
      }
    });

    inputStage.on("close", () => {
      log("Input pipeline done");
      // Don't close bridge stdin yet — bridge needs to finish processing
    });

    // --- Wire: bridgeStage.stdout → outputStage.stdin ---
    // Intercept to capture TTFT and text
    let bridgeBuffer = "";
    bridgeStage.stdout?.on("data", (chunk: Buffer) => {
      bridgeBuffer += chunk.toString("utf-8");
      let idx = bridgeBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = bridgeBuffer.slice(0, idx).trim();
        bridgeBuffer = bridgeBuffer.slice(idx + 1);

        if (line.length > 0) {
          try {
            const event = JSON.parse(line);
            const now = Date.now();

            if (event.type === "text.delta") {
              if (ts.firstTextDeltaMs === 0) {
                ts.firstTextDeltaMs = now - t0;
                log(`TTFT: first text.delta at +${ts.firstTextDeltaMs}ms`);
              }
              transcript += event.delta ?? "";
            }

            if (event.type === "text.complete") {
              ts.textCompleteMs = now - t0;
              log(`text.complete at +${ts.textCompleteMs}ms`);
            }
          } catch {
            // forward anyway
          }

          // Forward to output stage
          outputStage.stdin?.write(line + "\n");
        }
        idx = bridgeBuffer.indexOf("\n");
      }
    });

    bridgeStage.on("close", (code) => {
      log(`Bridge exited (${code})`);
      outputStage.stdin?.end();
    });

    // --- Wire: outputStage.stdout → capture first audio.chunk timestamp ---
    let outputBuffer = "";
    outputStage.stdout?.on("data", (chunk: Buffer) => {
      outputBuffer += chunk.toString("utf-8");
      let idx = outputBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = outputBuffer.slice(0, idx).trim();
        outputBuffer = outputBuffer.slice(idx + 1);

        if (line.length > 0) {
          try {
            const event = JSON.parse(line);
            const now = Date.now();

            if (event.type === "audio.chunk") {
              if (ts.firstAudioOutputMs === 0) {
                ts.firstAudioOutputMs = now - t0;
                log(`First output audio.chunk at +${ts.firstAudioOutputMs}ms`);
              }
              ts.lastAudioOutputMs = now - t0;
            }
          } catch {
            // ignore
          }
        }
        idx = outputBuffer.indexOf("\n");
      }
    });

    // --- Handle completion ---
    let completeTimerSet = false;
    const checkComplete = () => {
      if (ts.textCompleteMs > 0 && !completeTimerSet) {
        completeTimerSet = true;
        // Give bridge a moment to flush, then close its stdin
        setTimeout(() => {
          bridgeStage.stdin?.end();
        }, 500);
      }
    };

    // Poll for text.complete
    const pollInterval = setInterval(checkComplete, 100);

    outputStage.on("close", async () => {
      clearInterval(pollInterval);
      clearTimeout(pipelineTimeout);
      log("Output pipeline done");

      let outputAudioDurationMs = 0;
      try {
        const stat = await fs.stat(outputWavPath);
        const dataSize = stat.size - 44;
        if (dataSize > 0) outputAudioDurationMs = (dataSize / (SAMPLE_RATE * 2)) * 1000;
      } catch {
        // no output
      }

      resolve({ transcript, sttText, timestamps: ts, outputAudioDurationMs });
    });

    // Timeout
    const pipelineTimeout = setTimeout(() => {
      log("Pipeline timeout (180s)");
      inputStage.kill("SIGTERM");
      bridgeStage.kill("SIGTERM");
      outputStage.kill("SIGTERM");
    }, 180_000);
  });
}

// ---- Audio merging ----

async function mergeAudio(
  inputPath: string,
  outputPath: string,
  conversationPath: string,
  inputDurationMs: number,
  gapMs: number,
): Promise<void> {
  let outputExists = false;
  try {
    const stat = await fs.stat(outputPath);
    outputExists = stat.size > 44;
  } catch {}

  if (!outputExists) {
    log("WARNING: No output audio. Copying input as conversation.");
    await fs.copyFile(inputPath, conversationPath);
    return;
  }

  const gapSec = Math.max(gapMs / 1000, 0.1);
  const silencePath = path.join(OUTPUT_DIR, "_silence.wav");
  const inputNorm = path.join(OUTPUT_DIR, "_input_norm.wav");
  const outputNorm = path.join(OUTPUT_DIR, "_output_norm.wav");
  const concatList = path.join(OUTPUT_DIR, "_concat.txt");

  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=mono -t ${gapSec} -c:a pcm_s16le "${silencePath}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i "${inputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${inputNorm}"`, { stdio: "pipe" });
  execSync(`ffmpeg -y -i "${outputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${outputNorm}"`, { stdio: "pipe" });

  await fs.writeFile(concatList, `file '${inputNorm}'\nfile '${silencePath}'\nfile '${outputNorm}'`);
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:a pcm_s16le "${conversationPath}"`, { stdio: "pipe" });

  for (const f of [silencePath, inputNorm, outputNorm, concatList]) await fs.unlink(f).catch(() => {});
  log(`Merged conversation: ${conversationPath}`);
}

// ---- Spectrogram ----

async function generateSpectrogram(
  conversationPath: string, spectrogramPath: string,
  inputDurationMs: number, gapMs: number, outputDurationMs: number,
): Promise<void> {
  const totalMs = inputDurationMs + gapMs + outputDurationMs;
  const W = 1200, H = 400;
  const raw = path.join(OUTPUT_DIR, "_spectrogram_raw.png");

  try {
    execSync(`sox "${conversationPath}" -n spectrogram -x ${W} -y ${H - 100} -o "${raw}"`, { stdio: "pipe" });
  } catch {
    execSync(`ffmpeg -y -i "${conversationPath}" -lavfi "showspectrumpic=s=${W}x${H - 100}:mode=combined:color=intensity" "${raw}"`, { stdio: "pipe" });
  }

  const x1 = Math.floor((inputDurationMs / totalMs) * W);
  const x2 = Math.floor(((inputDurationMs + gapMs) / totalMs) * W);
  const font = "/System/Library/Fonts/Supplemental/Arial.ttf";

  try {
    execSync([
      `magick "${raw}"`,
      `-stroke red -strokewidth 2 -draw "line ${x1},0 ${x1},${H}"`,
      `-stroke green -strokewidth 2 -draw "line ${x2},0 ${x2},${H}"`,
      `-stroke none`,
      `-fill "rgba(0,100,255,0.15)" -draw "rectangle 0,0 ${x1},${H}"`,
      `-fill "rgba(255,165,0,0.15)" -draw "rectangle ${x1},0 ${x2},${H}"`,
      `-fill "rgba(0,200,0,0.15)" -draw "rectangle ${x2},0 ${W},${H}"`,
      `-fill white -stroke none -font "${font}" -pointsize 18`,
      `-gravity NorthWest`,
      `-annotate +${Math.max(x1 * 0.3, 5)}+8 "INPUT"`,
      `-annotate +${Math.max((x1 + x2) / 2 - 50, x1 + 5)}+8 "PROCESSING"`,
      `-annotate +${Math.max((x2 + W) / 2 - 30, x2 + 5)}+8 "OUTPUT"`,
      `"${spectrogramPath}"`,
    ].join(" "), { stdio: "pipe", shell: "/bin/bash" });
  } catch {
    await fs.copyFile(raw, spectrogramPath);
  }

  await fs.unlink(raw).catch(() => {});
  log(`Spectrogram: ${spectrogramPath}`);
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

  // Warm up acpx session
  const modelArgs = model ? `--model ${model}` : "";
  try {
    log(`Warming up acpx session${model ? ` (model: ${model})` : ""}...`);
    execSync(`acpx ${modelArgs} --approve-all --format quiet claude "ping"`, {
      stdio: ["ignore", "ignore", "inherit"],
      cwd: PROJECT_DIR,
      timeout: 60000,
    });
    log("Session warm.");
  } catch (err) {
    log(`Warning: could not warm acpx session: ${err instanceof Error ? err.message : err}`);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const inputWavPath = path.join(OUTPUT_DIR, "e2e-input.wav");
  const outputWavPath = path.join(OUTPUT_DIR, "e2e-output.wav");
  const conversationWavPath = path.join(OUTPUT_DIR, "e2e-conversation.wav");
  const spectrogramPath = path.join(OUTPUT_DIR, "e2e-spectrogram.png");
  const transcriptPath = path.join(OUTPUT_DIR, "e2e-transcript.json");

  log("=== End-to-End Conversation Recorder ===");
  log(`Prompt: "${inputText}"`);

  // Step 1: Generate input audio
  const tGen0 = Date.now();
  const inputDurationMs = await generateInputAudio(inputText, inputWavPath);
  log(`Input TTS took ${Date.now() - tGen0}ms`);

  // Step 2: Run full pipeline: mic → stt → vad → bridge → tts → play
  log("Running full pipeline: mic → stt → vad → bridge → tts → play");
  const result = await runFullPipeline(inputWavPath, outputWavPath);
  const ts = result.timestamps;

  // Step 3: Print timing waterfall
  log("\n=== Latency Waterfall ===");
  log(`  Audio input ends:        +${ts.lastAudioInputMs}ms`);
  log(`  STT speech.final:        +${ts.speechFinalMs}ms  (STT latency: ${ts.speechFinalMs - ts.lastAudioInputMs}ms)`);
  log(`  VAD speech.pause:        +${ts.speechPauseMs}ms  (VAD latency: ${ts.speechPauseMs - ts.speechFinalMs}ms)`);
  log(`  TTFT (first text.delta): +${ts.firstTextDeltaMs}ms  (agent latency: ${ts.firstTextDeltaMs - ts.speechPauseMs}ms)`);
  log(`  First audio output:      +${ts.firstAudioOutputMs}ms  (TTS latency: ${ts.firstAudioOutputMs - ts.firstTextDeltaMs}ms)`);
  log(`  text.complete:           +${ts.textCompleteMs}ms`);
  log(`  Last audio output:       +${ts.lastAudioOutputMs}ms`);
  log(`  ---`);
  log(`  End-of-speech → TTFT:    ${ts.firstTextDeltaMs - ts.lastAudioInputMs}ms`);
  log(`  End-of-speech → audio:   ${ts.firstAudioOutputMs - ts.lastAudioInputMs}ms`);
  log(`  TTFT → first audio:      ${ts.firstAudioOutputMs - ts.firstTextDeltaMs}ms`);
  log(`  Output audio duration:   ${(result.outputAudioDurationMs / 1000).toFixed(2)}s`);
  log(`  STT transcript:          "${result.sttText}"`);
  log(`  Agent response:          "${result.transcript.slice(0, 120)}..."`);

  // Step 4: Merge audio
  const gapMs = Math.max(ts.firstAudioOutputMs, 500);
  await mergeAudio(inputWavPath, outputWavPath, conversationWavPath, inputDurationMs, gapMs);

  // Step 5: Spectrogram
  await generateSpectrogram(conversationWavPath, spectrogramPath, inputDurationMs, gapMs, result.outputAudioDurationMs);

  // Step 6: Save transcript with full timing
  const transcriptData = {
    input: {
      text: inputText,
      sttTranscript: result.sttText,
      audioDurationMs: inputDurationMs,
    },
    latency: {
      audioInputEndsMs: ts.lastAudioInputMs,
      sttSpeechFinalMs: ts.speechFinalMs,
      sttLatencyMs: ts.speechFinalMs - ts.lastAudioInputMs,
      vadSpeechPauseMs: ts.speechPauseMs,
      vadLatencyMs: ts.speechPauseMs - ts.speechFinalMs,
      ttftMs: ts.firstTextDeltaMs,
      agentLatencyMs: ts.firstTextDeltaMs - ts.speechPauseMs,
      firstAudioOutputMs: ts.firstAudioOutputMs,
      ttsLatencyMs: ts.firstAudioOutputMs - ts.firstTextDeltaMs,
      textCompleteMs: ts.textCompleteMs,
      endOfSpeechToTtftMs: ts.firstTextDeltaMs - ts.lastAudioInputMs,
      endOfSpeechToAudioMs: ts.firstAudioOutputMs - ts.lastAudioInputMs,
      ttftToFirstAudioMs: ts.firstAudioOutputMs - ts.firstTextDeltaMs,
    },
    output: {
      text: result.transcript,
      audioDurationMs: result.outputAudioDurationMs,
    },
    model: model ?? "default",
    recordedAt: new Date().toISOString(),
  };

  await fs.writeFile(transcriptPath, JSON.stringify(transcriptData, null, 2));
  log(`Transcript: ${transcriptPath}`);

  log("\n=== Output Files ===");
  log(`  Conversation: ${conversationWavPath}`);
  log(`  Input audio:  ${inputWavPath}`);
  log(`  Output audio: ${outputWavPath}`);
  log(`  Spectrogram:  ${spectrogramPath}`);
  log(`  Transcript:   ${transcriptPath}`);
  log("\n=== Done ===");
}

main().catch((err) => {
  process.stderr.write(`\n[e2e] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.cause) {
    process.stderr.write(`Cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}\n`);
  }
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
