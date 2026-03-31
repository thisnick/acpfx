/**
 * End-to-end voice conversation recorder.
 *
 * Records a full bidirectional conversation with an ACP agent:
 * 1. Converts a text prompt to speech via ElevenLabs REST TTS
 * 2. Sends the text directly to bridge --raw (as a speech.pause event)
 * 3. Captures text.delta/text.complete events and pipes them through tts -> play
 * 4. Merges input + output audio into a single timeline with real-time gaps
 * 5. Generates a labeled spectrogram
 * 6. Saves a transcript with timestamps
 *
 * Usage: node dist/scripts/e2e-conversation.js [prompt text]
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..", "..");
const CLI_PATH = path.join(PROJECT_DIR, "dist", "cli.js");
const OUTPUT_DIR = path.join(PROJECT_DIR, "demo-audio");

const INPUT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah - female, american (user/question)
const OUTPUT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George - male, british (agent/answer)
const ELEVENLABS_MODEL = "eleven_turbo_v2_5";
const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const SAMPLE_RATE = 16000;

// Env vars loaded by direnv (see .envrc)

// ---- WAV header helpers ----

function createWavHeader(dataSize: number, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  let off = 0;
  header.write("RIFF", off); off += 4;
  header.writeUInt32LE(dataSize + 36, off); off += 4;
  header.write("WAVE", off); off += 4;
  header.write("fmt ", off); off += 4;
  header.writeUInt32LE(16, off); off += 4;
  header.writeUInt16LE(1, off); off += 2;
  header.writeUInt16LE(channels, off); off += 2;
  header.writeUInt32LE(sampleRate, off); off += 4;
  header.writeUInt32LE(byteRate, off); off += 4;
  header.writeUInt16LE(blockAlign, off); off += 2;
  header.writeUInt16LE(bitsPerSample, off); off += 2;
  header.write("data", off); off += 4;
  header.writeUInt32LE(dataSize, off);
  return header;
}

function writePcmToWav(pcmData: Buffer, filePath: string, sampleRate: number, channels: number): Promise<void> {
  const header = createWavHeader(pcmData.length, sampleRate, channels);
  return fs.writeFile(filePath, Buffer.concat([header, pcmData]));
}

// ---- ElevenLabs REST TTS for input generation ----

async function generateInputAudio(text: string, outputPath: string): Promise<number> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  log(`Generating input speech for: "${text}"`);
  const url = `${ELEVENLABS_TTS_URL}/${INPUT_VOICE_ID}?output_format=pcm_16000`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const pcmData = Buffer.from(arrayBuffer);
  await writePcmToWav(pcmData, outputPath, SAMPLE_RATE, 1);

  const durationMs = (pcmData.length / (SAMPLE_RATE * 2)) * 1000;
  log(`Input audio generated: ${(durationMs / 1000).toFixed(2)}s (${outputPath})`);
  return durationMs;
}

// ---- Pipeline execution ----

type PipelineResult = {
  transcript: string;
  outputAudioPath: string;
  firstDeltaTime: number;
  completeTime: number;
  outputAudioDurationMs: number;
};

/**
 * Runs the pipeline by directly sending a speech.pause event to bridge --raw,
 * then piping the text output through tts -> play to produce an output WAV.
 * This bypasses mic/stt/vad which would require an OpenAI API key.
 */
async function runPipeline(inputText: string, outputWavPath: string, startTime: number): Promise<PipelineResult> {
  return new Promise((resolve, reject) => {
    // Stage 1: bridge claude --raw (reads speech events from stdin, writes text events to stdout)
    const bridgeCmd = `node ${CLI_PATH} bridge claude --raw --verbose`;

    // Stage 2: tts -> play --provider file (reads text events, writes audio to file)
    const stage2Cmd = [
      `node ${CLI_PATH} tts --provider elevenlabs --voice-id ${OUTPUT_VOICE_ID}`,
      `node ${CLI_PATH} play --provider file --path "${outputWavPath}"`,
    ].join(" | ");

    log("Starting bridge (stage 1)");
    const bridge = spawn("bash", ["-c", bridgeCmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    log("Starting tts -> play (stage 2)");
    const stage2 = spawn("bash", ["-c", stage2Cmd], {
      cwd: PROJECT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let transcript = "";
    let firstDeltaTime = 0;
    let completeTime = 0;
    let buffer = "";
    let bridgeDone = false;

    // Forward stderr
    bridge.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[bridge] ${chunk.toString()}`);
    });
    stage2.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[tts/play] ${chunk.toString()}`);
    });

    // Read NDJSON from bridge stdout, intercept for transcript, forward to stage2
    bridge.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (line.length > 0) {
          try {
            const event = JSON.parse(line);

            if (event.type === "text.delta") {
              if (firstDeltaTime === 0) {
                firstDeltaTime = Date.now() - startTime;
                log(`First text.delta at +${firstDeltaTime}ms`);
              }
              transcript += event.delta;
            }

            if (event.type === "text.complete") {
              completeTime = Date.now() - startTime;
              log(`text.complete at +${completeTime}ms`);
              const preview = (event.text ?? transcript).slice(0, 120);
              log(`Transcript preview: ${preview}...`);
            }

            // Forward all events to stage2
            stage2.stdin?.write(line + "\n");
          } catch {
            stage2.stdin?.write(line + "\n");
          }
        }
        idx = buffer.indexOf("\n");
      }
    });

    bridge.on("close", (code) => {
      log(`Bridge exited with code ${code}`);
      bridgeDone = true;
      // Close stage2 stdin so tts/play know input is done
      stage2.stdin?.end();
    });

    stage2.on("close", async (code) => {
      log(`TTS/Play exited with code ${code}`);

      // Calculate output audio duration from the WAV file
      let outputAudioDurationMs = 0;
      try {
        const stat = await fs.stat(outputWavPath);
        const dataSize = stat.size - 44;
        if (dataSize > 0) {
          outputAudioDurationMs = (dataSize / (SAMPLE_RATE * 2)) * 1000;
        }
      } catch {
        // File might not exist if pipeline failed
      }

      resolve({
        transcript,
        outputAudioPath: outputWavPath,
        firstDeltaTime,
        completeTime,
        outputAudioDurationMs,
      });
    });

    // Send a speech.pause event to the bridge to trigger prompt submission.
    // The bridge state machine processes speech.pause with pendingText -> submit_prompt.
    const speechPauseEvent = JSON.stringify({
      type: "speech.pause",
      streamId: "e2e-input",
      silenceMs: 600,
      pendingText: inputText,
    });

    log(`Sending speech.pause to bridge: "${inputText}"`);
    // Small delay to let bridge initialize and connect to acpx session
    setTimeout(() => {
      bridge.stdin?.write(speechPauseEvent + "\n");
      // After sending, close stdin after a short delay to let bridge process
      // But we need to keep stdin open for bridge to stay alive until it gets a response.
      // Close stdin after text.complete is received (bridge will exit on its own).
      // Actually, bridge --raw reads from stdin until EOF, so we need to close it
      // after the response arrives. Let's close after completeTime is set.
      const checkDone = setInterval(() => {
        if (completeTime > 0) {
          clearInterval(checkDone);
          // Give bridge a moment to finish writing, then close stdin
          setTimeout(() => {
            bridge.stdin?.end();
          }, 500);
        }
      }, 100);
    }, 1000);

    // Handle pipeline timeout (3 minutes max)
    const timeout = setTimeout(() => {
      log("Pipeline timeout (180s) - killing processes");
      bridge.kill("SIGTERM");
      stage2.kill("SIGTERM");
      setTimeout(() => {
        bridge.kill("SIGKILL");
        stage2.kill("SIGKILL");
      }, 2000);
    }, 180_000);

    bridge.on("close", () => clearTimeout(timeout));
    stage2.on("close", () => clearTimeout(timeout));
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
  // Check output file exists and has data
  let outputExists = false;
  try {
    const stat = await fs.stat(outputPath);
    outputExists = stat.size > 44;
  } catch {
    // no output file
  }

  if (!outputExists) {
    log("WARNING: No output audio produced. Creating conversation with just input + silence.");
    // Just copy input as the conversation
    await fs.copyFile(inputPath, conversationPath);
    return;
  }

  log(`Merging audio: ${(inputDurationMs / 1000).toFixed(2)}s input + ${(gapMs / 1000).toFixed(2)}s gap + output`);

  const silencePath = path.join(OUTPUT_DIR, "_silence.wav");
  const gapSeconds = Math.max(gapMs / 1000, 0.1);

  // Generate silence with ffmpeg
  execSync(
    `ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=mono -t ${gapSeconds} -c:a pcm_s16le "${silencePath}"`,
    { stdio: "pipe" },
  );

  // Normalize all inputs to same format
  const inputNorm = path.join(OUTPUT_DIR, "_input_norm.wav");
  const outputNorm = path.join(OUTPUT_DIR, "_output_norm.wav");

  execSync(
    `ffmpeg -y -i "${inputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${inputNorm}"`,
    { stdio: "pipe" },
  );
  execSync(
    `ffmpeg -y -i "${outputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${outputNorm}"`,
    { stdio: "pipe" },
  );

  // Concat list
  const concatListPath = path.join(OUTPUT_DIR, "_concat.txt");
  const concatContent = [
    `file '${inputNorm}'`,
    `file '${silencePath}'`,
    `file '${outputNorm}'`,
  ].join("\n");
  await fs.writeFile(concatListPath, concatContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:a pcm_s16le "${conversationPath}"`,
    { stdio: "pipe" },
  );

  // Cleanup temp files
  for (const tmp of [silencePath, concatListPath, inputNorm, outputNorm]) {
    await fs.unlink(tmp).catch(() => {});
  }

  log(`Merged conversation audio: ${conversationPath}`);
}

// ---- Spectrogram generation ----

async function generateSpectrogram(
  conversationPath: string,
  spectrogramPath: string,
  inputDurationMs: number,
  gapMs: number,
  outputDurationMs: number,
): Promise<void> {
  const totalDurationMs = inputDurationMs + gapMs + outputDurationMs;
  const imgWidth = 1200;
  const imgHeight = 400;

  // Generate base spectrogram with sox
  const rawSpectrogram = path.join(OUTPUT_DIR, "_spectrogram_raw.png");
  try {
    execSync(
      `sox "${conversationPath}" -n spectrogram -x ${imgWidth} -y ${imgHeight - 100} -o "${rawSpectrogram}"`,
      { stdio: "pipe" },
    );
  } catch {
    // Fallback: use ffmpeg showspectrumpic
    execSync(
      `ffmpeg -y -i "${conversationPath}" -lavfi "showspectrumpic=s=${imgWidth}x${imgHeight - 100}:mode=combined:color=intensity" "${rawSpectrogram}"`,
      { stdio: "pipe" },
    );
  }

  // Calculate boundary positions as fractions of image width
  const inputEndX = Math.floor((inputDurationMs / totalDurationMs) * imgWidth);
  const outputStartX = Math.floor(((inputDurationMs + gapMs) / totalDurationMs) * imgWidth);

  // Use ImageMagick to annotate the spectrogram
  const inputEndSec = (inputDurationMs / 1000).toFixed(1);
  const outputStartSec = ((inputDurationMs + gapMs) / 1000).toFixed(1);
  const totalSec = (totalDurationMs / 1000).toFixed(1);

  const font = "/System/Library/Fonts/Supplemental/Arial.ttf";
  const magickCmd = [
    `magick "${rawSpectrogram}"`,
    // Draw vertical boundary lines
    `-stroke red -strokewidth 2 -draw "line ${inputEndX},0 ${inputEndX},${imgHeight}"`,
    `-stroke green -strokewidth 2 -draw "line ${outputStartX},0 ${outputStartX},${imgHeight}"`,
    // Add colored region overlays (semi-transparent)
    `-stroke none`,
    `-fill "rgba(0,100,255,0.15)" -draw "rectangle 0,0 ${inputEndX},${imgHeight}"`,
    `-fill "rgba(255,165,0,0.15)" -draw "rectangle ${inputEndX},0 ${outputStartX},${imgHeight}"`,
    `-fill "rgba(0,200,0,0.15)" -draw "rectangle ${outputStartX},0 ${imgWidth},${imgHeight}"`,
    // Add text labels at top
    `-fill white -stroke none -font "${font}" -pointsize 18`,
    `-gravity NorthWest`,
    `-annotate +${Math.max(Math.floor(inputEndX * 0.3), 5)}+8 "INPUT (0s - ${inputEndSec}s)"`,
    `-annotate +${Math.max(Math.floor((inputEndX + outputStartX) / 2) - 50, inputEndX + 5)}+8 "PROCESSING"`,
    `-annotate +${Math.max(Math.floor((outputStartX + imgWidth) / 2) - 30, outputStartX + 5)}+8 "OUTPUT (${outputStartSec}s - ${totalSec}s)"`,
    // Add timestamp markers at bottom
    `-pointsize 14 -fill red`,
    `-annotate +${Math.max(inputEndX - 25, 0)}+${imgHeight - 15} "${inputEndSec}s"`,
    `-fill green`,
    `-annotate +${Math.max(outputStartX - 25, 0)}+${imgHeight - 15} "${outputStartSec}s"`,
    `"${spectrogramPath}"`,
  ].join(" \\\n  ");

  try {
    execSync(magickCmd, { stdio: "pipe", shell: "/bin/bash" });
    log(`Spectrogram generated: ${spectrogramPath}`);
  } catch (err) {
    // Fallback: just use the raw spectrogram without labels
    log(`ImageMagick annotation failed, using raw spectrogram`);
    await fs.copyFile(rawSpectrogram, spectrogramPath);
  }

  await fs.unlink(rawSpectrogram).catch(() => {});
}

// ---- Transcript type ----

type TranscriptData = {
  input: {
    text: string;
    startMs: number;
    endMs: number;
    durationMs: number;
  };
  processing: {
    startMs: number;
    endMs: number;
    latencyMs: number;
  };
  output: {
    text: string;
    startMs: number;
    endMs: number;
    durationMs: number;
  };
  totalDurationMs: number;
  recordedAt: string;
};

// ---- Logging ----

function log(msg: string): void {
  const elapsed = (Date.now() - globalStartTime) / 1000;
  process.stderr.write(`[e2e +${elapsed.toFixed(1)}s] ${msg}\n`);
}

let globalStartTime = Date.now();

// ---- Main ----

async function main(): Promise<void> {
  globalStartTime = Date.now();

  const inputText = process.argv[2] || "What is the fibonacci sequence and why is it important?";
  const model = process.argv[3] || process.env.ACPFX_MODEL || undefined;

  // If a model is specified, set it on the acpx session before running
  if (model) {
    log(`Setting model to: ${model}`);
    const { execSync } = await import("node:child_process");
    try {
      execSync(`acpx --model ${model} claude sessions ensure`, {
        stdio: ["ignore", "ignore", "inherit"],
        cwd: PROJECT_DIR,
      });
    } catch {
      log(`Warning: could not set model via acpx. Continuing with current session model.`);
    }
  }

  // Ensure output directory exists
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const inputWavPath = path.join(OUTPUT_DIR, "e2e-input.wav");
  const outputWavPath = path.join(OUTPUT_DIR, "e2e-output.wav");
  const conversationWavPath = path.join(OUTPUT_DIR, "e2e-conversation.wav");
  const spectrogramPath = path.join(OUTPUT_DIR, "e2e-spectrogram.png");
  const transcriptPath = path.join(OUTPUT_DIR, "e2e-transcript.json");

  log("=== End-to-End Conversation Recorder ===");
  log(`Prompt: "${inputText}"`);

  // Step 1: Generate input audio from text
  const t0 = Date.now();
  const inputDurationMs = await generateInputAudio(inputText, inputWavPath);
  const tInputGenDone = Date.now();
  log(`Input TTS took ${tInputGenDone - t0}ms`);

  // Step 2: Run the pipeline (bridge --raw -> tts -> play)
  const tPipelineStart = Date.now();
  log("Running pipeline...");
  const result = await runPipeline(inputText, outputWavPath, tPipelineStart);

  // Step 3: Calculate timing
  // processingGapMs = time from pipeline start to first text delta (the "thinking" time)
  const processingGapMs = Math.max(result.firstDeltaTime, 500);

  log(`\n=== Timing Summary ===`);
  log(`Input audio duration:    ${(inputDurationMs / 1000).toFixed(2)}s`);
  log(`Processing latency:      ${(processingGapMs / 1000).toFixed(2)}s (first text.delta at +${result.firstDeltaTime}ms)`);
  log(`Output audio duration:   ${(result.outputAudioDurationMs / 1000).toFixed(2)}s`);
  log(`Transcript length:       ${result.transcript.length} chars`);

  // Step 4: Merge into conversation audio
  await mergeAudio(
    inputWavPath,
    outputWavPath,
    conversationWavPath,
    inputDurationMs,
    processingGapMs,
  );

  // Step 5: Generate spectrogram
  await generateSpectrogram(
    conversationWavPath,
    spectrogramPath,
    inputDurationMs,
    processingGapMs,
    result.outputAudioDurationMs,
  );

  // Step 6: Save transcript
  const outputStartMs = inputDurationMs + processingGapMs;
  const transcriptData: TranscriptData = {
    input: {
      text: inputText,
      startMs: 0,
      endMs: inputDurationMs,
      durationMs: inputDurationMs,
    },
    processing: {
      startMs: inputDurationMs,
      endMs: outputStartMs,
      latencyMs: processingGapMs,
    },
    output: {
      text: result.transcript,
      startMs: outputStartMs,
      endMs: outputStartMs + result.outputAudioDurationMs,
      durationMs: result.outputAudioDurationMs,
    },
    totalDurationMs: outputStartMs + result.outputAudioDurationMs,
    recordedAt: new Date().toISOString(),
  };

  await fs.writeFile(transcriptPath, JSON.stringify(transcriptData, null, 2));
  log(`Transcript saved: ${transcriptPath}`);

  // Summary
  log(`\n=== Output Files ===`);
  log(`  Conversation: ${conversationWavPath}`);
  log(`  Input audio:  ${inputWavPath}`);
  log(`  Output audio: ${outputWavPath}`);
  log(`  Spectrogram:  ${spectrogramPath}`);
  log(`  Transcript:   ${transcriptPath}`);
  log(`\n=== Done ===`);
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
