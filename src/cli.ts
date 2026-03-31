#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("acpfx")
  .description("CLI-composable voice pipeline for ACP agents")
  .version("0.1.0");

program
  .command("tap")
  .description("Debug inspector: logs all events to stderr, passes through to stdout")
  .option("--json", "Output raw JSON to stderr instead of formatted summary")
  .action(async (opts) => {
    const { runTap } = await import("./commands/tap.js");
    await runTap(opts);
  });

program
  .command("bridge")
  .description("Orchestrator: connects speech events to an ACP agent via acpx")
  .argument("<agent>", "Agent name (e.g., claude)")
  .option("--raw", "Raw mode: read speech events from stdin, write text events to stdout")
  .option("--input <pipeline>", "Custom input pipeline command (default: acpfx mic | acpfx stt | acpfx vad)")
  .option("--output <pipeline>", "Custom output pipeline command (default: acpfx tts | acpfx play)")
  .option("--model <id>", "Agent model ID (passed to acpx --model)")
  .option("--approve-all", "Auto-approve all agent permission requests")
  .option("--acpx-args <args>", "Additional args to pass to acpx session setup")
  .option("--verbose", "Enable verbose logging to stderr")
  .action(async (agent: string, opts) => {
    const { runBridge } = await import("./commands/bridge.js");
    await runBridge(agent, opts);
  });

program
  .command("tts")
  .description("Text-to-speech: reads text events, emits audio.chunk events")
  .option("--provider <name>", "TTS provider (elevenlabs, say)", "elevenlabs")
  .option("--api-key <key>", "API key (or set ELEVENLABS_API_KEY env var)")
  .option("--voice-id <id>", "ElevenLabs voice ID")
  .option("--model <id>", "ElevenLabs model ID")
  .option("--voice <name>", "macOS say voice name")
  .action(async (opts) => {
    const { runTts } = await import("./commands/tts.js");
    await runTts(opts);
  });

program
  .command("stt")
  .description("Speech-to-text: reads audio.chunk events, emits speech.final events")
  .option("--provider <name>", "STT provider (elevenlabs, openai)", "elevenlabs")
  .option("--api-key <key>", "API key (or set OPENAI_API_KEY env var)")
  .option("--language <lang>", "Language hint (e.g., en)")
  .option("--chunk-ms <ms>", "Audio accumulation window in ms", "3000")
  .action(async (opts) => {
    const { runStt } = await import("./commands/stt.js");
    await runStt(opts);
  });

program
  .command("mic")
  .description("Audio capture: reads from microphone or file, emits audio.chunk events")
  .option("--provider <name>", "Audio provider (sox, file)", "sox")
  .option("--path <file>", "WAV file path (required for file provider)")
  .option("--chunk-ms <ms>", "Chunk duration in ms", "100")
  .option("--no-pace", "Disable real-time pacing for file provider")
  .action(async (opts) => {
    const { runMic } = await import("./commands/mic.js");
    await runMic(opts);
  });

program
  .command("play")
  .description("Audio playback: reads audio.chunk events, plays to speaker or file")
  .option("--provider <name>", "Audio provider (sox, file)", "sox")
  .option("--path <file>", "WAV file path (required for file provider)")
  .action(async (opts) => {
    const { runPlay } = await import("./commands/play.js");
    await runPlay(opts);
  });

program
  .command("vad")
  .description("Voice activity detection: emits speech.resume/speech.pause events")
  .option("--pause-ms <ms>", "Silence duration before emitting speech.pause", "600")
  .option("--energy-threshold <n>", "RMS energy threshold for speech detection", "200")
  .action(async (opts) => {
    const { runVad } = await import("./commands/vad.js");
    await runVad(opts);
  });

program.parse();
