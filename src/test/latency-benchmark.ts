#!/usr/bin/env node
/**
 * Latency benchmark for acpfx pipeline.
 *
 * Measures:
 * 1. TTS TTFB (time to first audio byte) — old buffered vs new streaming
 * 2. End-to-end through real ACP: speech.pause → bridge → Claude → TTS → first audio
 * 3. Token streaming verification: audio starts before all tokens arrive
 * 4. Interrupt latency: time from control.interrupt to last audio.chunk
 *
 * Prerequisites:
 * - ELEVENLABS_API_KEY set in env or ~/.acpfx/.env
 * - For ACP tests: acpx claude session active with --ttl 0
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";

const CLI = path.resolve(import.meta.dirname, "..", "cli.js");
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? "";

// ── Helpers ────────────────────────────────────────────────────────

function spawnNode(args: string[], env?: Record<string, string>): ChildProcess {
  return spawn("node", [CLI, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function sendLine(proc: ChildProcess, obj: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(obj) + "\n");
}

function readLines(proc: ChildProcess): AsyncGenerator<Record<string, unknown>> {
  const rl = readline.createInterface({ input: proc.stdout! });
  const queue: Record<string, unknown>[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  rl.on("line", (line) => {
    try {
      queue.push(JSON.parse(line));
      resolve?.();
    } catch { /* skip */ }
  });
  rl.on("close", () => {
    done = true;
    resolve?.();
  });

  return (async function* () {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => { resolve = r; });
      resolve = null;
    }
  })();
}

function killProc(proc: ChildProcess): void {
  try {
    proc.stdin?.end();
    proc.kill("SIGTERM");
  } catch { /* already dead */ }
}

function hrMs(): number {
  return performance.now();
}

function fmt(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

// ── Benchmark 1: TTS TTFB ────────────────────────────────────────

async function benchmarkTtsTtfb(): Promise<void> {
  console.log("\n═══ Benchmark 1: TTS TTFB (time to first audio byte) ═══");

  const text = "The Fibonacci sequence is a series of numbers where each number is the sum of the two before it.";
  const runs = 3;

  // Streaming mode: send tokens incrementally
  const streamingTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    const proc = spawnNode(["tts", "--provider", "elevenlabs"], {
      ELEVENLABS_API_KEY: ELEVENLABS_KEY,
    });
    const lines = readLines(proc);
    const t0 = hrMs();

    // Send text in chunks like Claude would
    const words = text.split(" ");
    for (let w = 0; w < words.length; w += 3) {
      sendLine(proc, {
        type: "text.delta",
        requestId: "r1",
        delta: words.slice(w, w + 3).join(" ") + " ",
        seq: w,
      });
    }
    sendLine(proc, { type: "text.complete", requestId: "r1", text });

    for await (const event of lines) {
      if (event.type === "audio.chunk") {
        streamingTimes.push(hrMs() - t0);
        break;
      }
    }

    killProc(proc);
    // Small delay between runs to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  const avgStreaming = streamingTimes.reduce((a, b) => a + b, 0) / streamingTimes.length;
  console.log(`  Streaming TTFB (${runs} runs): ${streamingTimes.map(fmt).join(", ")}`);
  console.log(`  Average: ${fmt(avgStreaming)}`);
}

// ── Benchmark 2: End-to-end through ACP ──────────────────────────

async function benchmarkE2E(): Promise<void> {
  console.log("\n═══ Benchmark 2: End-to-end ACP latency ═══");
  console.log("  (speech.pause → bridge → Claude Code → TTS → first audio)");

  // First test bridge-only latency
  console.log("\n  --- Bridge only (speech.pause → first text.delta) ---");
  const bridgeRuns = 3;
  const bridgeTimes: number[] = [];

  for (let i = 0; i < bridgeRuns; i++) {
    const proc = spawnNode(["bridge", "claude", "--raw"]);
    const lines = readLines(proc);
    const t0 = hrMs();

    sendLine(proc, {
      type: "speech.pause",
      streamId: "s1",
      silenceMs: 600,
      pendingText: "what is two plus two",
    });

    let gotDelta = false;
    for await (const event of lines) {
      if (event.type === "text.delta" && typeof event.delta === "string" && event.delta.length > 0) {
        bridgeTimes.push(hrMs() - t0);
        gotDelta = true;
        break;
      }
    }

    if (!gotDelta) {
      console.log(`  Run ${i + 1}: FAILED (no text.delta received)`);
    }

    killProc(proc);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (bridgeTimes.length > 0) {
    const avg = bridgeTimes.reduce((a, b) => a + b, 0) / bridgeTimes.length;
    console.log(`  Bridge TTFB (${bridgeTimes.length} runs): ${bridgeTimes.map(fmt).join(", ")}`);
    console.log(`  Average: ${fmt(avg)}`);
  }

  // Full pipeline: bridge | tts → first audio
  console.log("\n  --- Full pipeline (speech.pause → first audio.chunk) ---");
  const fullRuns = 2;
  const fullTimes: number[] = [];

  for (let i = 0; i < fullRuns; i++) {
    const bridge = spawnNode(["bridge", "claude", "--raw"]);
    const tts = spawnNode(["tts", "--provider", "elevenlabs"], {
      ELEVENLABS_API_KEY: ELEVENLABS_KEY,
    });

    // Pipe bridge stdout → tts stdin
    bridge.stdout!.pipe(tts.stdin!);

    const lines = readLines(tts);
    const t0 = hrMs();

    sendLine(bridge, {
      type: "speech.pause",
      streamId: "s1",
      silenceMs: 600,
      pendingText: "explain what a fibonacci number is in one sentence",
    });

    let gotAudio = false;
    for await (const event of lines) {
      if (event.type === "audio.chunk") {
        fullTimes.push(hrMs() - t0);
        gotAudio = true;
        break;
      }
    }

    if (!gotAudio) {
      console.log(`  Run ${i + 1}: FAILED (no audio.chunk received)`);
    }

    killProc(bridge);
    killProc(tts);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (fullTimes.length > 0) {
    const avg = fullTimes.reduce((a, b) => a + b, 0) / fullTimes.length;
    console.log(`  Full pipeline TTFA (${fullTimes.length} runs): ${fullTimes.map(fmt).join(", ")}`);
    console.log(`  Average: ${fmt(avg)}`);
  }
}

// ── Benchmark 3: Token streaming verification ────────────────────

async function benchmarkTokenStreaming(): Promise<void> {
  console.log("\n═══ Benchmark 3: Token streaming verification ═══");
  console.log("  (audio starts before all tokens arrive)");

  const proc = spawnNode(["tts", "--provider", "elevenlabs"], {
    ELEVENLABS_API_KEY: ELEVENLABS_KEY,
  });
  const lines = readLines(proc);
  const t0 = hrMs();

  // Send tokens slowly, simulating Claude's token-by-token output
  // Use a long enough text that ElevenLabs starts generating audio before all tokens arrive
  const tokens = [
    "The Fibonacci sequence is a fascinating mathematical pattern ",
    "where each number is the sum of the two preceding ones. ",
    "Starting from zero and one, the sequence grows as follows: ",
    "zero, one, one, two, three, five, eight, thirteen, ",
    "twenty-one, thirty-four, and so on forever. ",
    "This pattern appears throughout nature in surprising ways. ",
    "You can find it in the spiral arrangement of sunflower seeds, ",
    "the branching patterns of trees, and the shell of a nautilus. ",
    "Mathematicians have studied this sequence for centuries.",
  ];

  let tokensSent = 0;
  let firstAudioAt: number | null = null;
  let allTokensSentAt: number | null = null;
  let audioChunksBeforeAllTokens = 0;
  let totalAudioChunks = 0;

  // Send tokens with delays
  const sendTokens = async () => {
    for (let i = 0; i < tokens.length; i++) {
      sendLine(proc, {
        type: "text.delta",
        requestId: "r1",
        delta: tokens[i],
        seq: i,
      });
      tokensSent++;
      await new Promise((r) => setTimeout(r, 300));
    }
    allTokensSentAt = hrMs() - t0;
    sendLine(proc, {
      type: "text.complete",
      requestId: "r1",
      text: tokens.join(""),
    });
  };

  const sendPromise = sendTokens();

  for await (const event of lines) {
    if (event.type === "audio.chunk") {
      totalAudioChunks++;
      if (!firstAudioAt) {
        firstAudioAt = hrMs() - t0;
      }
      if (!allTokensSentAt) {
        audioChunksBeforeAllTokens++;
      }
    }
    if (event.type === "text.complete") {
      // Wait a bit for remaining audio
      await new Promise((r) => setTimeout(r, 2000));
      break;
    }
  }

  await sendPromise;
  killProc(proc);

  console.log(`  Tokens sent: ${tokensSent} over ~${fmt(allTokensSentAt ?? 0)}`);
  console.log(`  First audio arrived at: ${fmt(firstAudioAt ?? 0)}`);
  console.log(`  All tokens sent at: ${fmt(allTokensSentAt ?? 0)}`);
  console.log(`  Audio chunks before all tokens sent: ${audioChunksBeforeAllTokens}`);
  console.log(`  Total audio chunks: ${totalAudioChunks}`);
  console.log(
    `  STREAMING VERIFIED: ${audioChunksBeforeAllTokens > 0 ? "YES — audio started before all text arrived" : "NO — audio started only after all text"}`,
  );
}

// ── Benchmark 4: Interrupt latency ──────────────────────────────

async function benchmarkInterrupt(): Promise<void> {
  console.log("\n═══ Benchmark 4: Interrupt latency ═══");
  console.log("  (time from control.interrupt to audio stopping)");

  const proc = spawnNode(["tts", "--provider", "elevenlabs"], {
    ELEVENLABS_API_KEY: ELEVENLABS_KEY,
  });
  const lines = readLines(proc);

  // Send text tokens slowly to simulate an active stream — do NOT send text.complete,
  // so the WebSocket is still open and receiving when we interrupt.
  const longTokens = [
    "This is a very long response that will generate audio. ",
    "We want to ensure interrupt works mid-stream. ",
    "The latency from interrupt to silence is critical. ",
    "More text to keep the stream going. ",
    "And even more text so audio keeps flowing. ",
    "This sentence adds more audio content. ",
    "We need enough text to keep the WebSocket busy. ",
    "Almost there, just a few more tokens. ",
    "One more sentence for good measure. ",
    "And the final token in this stream. ",
  ];

  // Start sending tokens with delays (simulates Claude token streaming)
  let tokenIdx = 0;
  const tokenInterval = setInterval(() => {
    if (tokenIdx < longTokens.length) {
      sendLine(proc, {
        type: "text.delta",
        requestId: "r1",
        delta: longTokens[tokenIdx],
        seq: tokenIdx,
      });
      tokenIdx++;
    } else {
      clearInterval(tokenInterval);
    }
  }, 200);

  let audioCountBefore = 0;
  let audioCountAfter = 0;
  let interruptSentAt: number | null = null;
  let lastAudioTime: number | null = null;
  let gotInterruptEvent = false;
  let interrupted = false;

  // Single loop: count audio before and after interrupt
  for await (const event of lines) {
    if (event.type === "audio.chunk") {
      if (!interrupted) {
        audioCountBefore++;
        // After 5 audio chunks, send interrupt mid-stream
        if (audioCountBefore >= 5 && !interrupted) {
          clearInterval(tokenInterval);
          interruptSentAt = hrMs();
          interrupted = true;
          sendLine(proc, {
            type: "control.interrupt",
            requestId: "r1",
            reason: "user_speech",
          });
        }
      } else {
        audioCountAfter++;
        lastAudioTime = hrMs();
      }
    }
    if (event.type === "control.interrupt") {
      gotInterruptEvent = true;
      // Wait briefly for any trailing audio in pipe buffers
      await new Promise((r) => setTimeout(r, 300));
      break;
    }
    // Safety timeout
    if (interrupted && interruptSentAt && hrMs() - interruptSentAt > 3000) break;
  }

  killProc(proc);

  const interruptToForward = gotInterruptEvent && interruptSentAt
    ? hrMs() - interruptSentAt
    : null;
  const audioDurationAfter = audioCountAfter * 100; // each chunk ~100ms of audio
  // The real interrupt metric: how much buffered audio leaked through after we sent the interrupt
  // These chunks were already in the Node.js pipe buffer, not newly generated.

  console.log(`  Tokens sent before interrupt: ${tokenIdx}/${longTokens.length}`);
  console.log(`  Audio chunks before interrupt: ${audioCountBefore}`);
  console.log(`  Buffered audio chunks after interrupt: ${audioCountAfter} (~${audioDurationAfter}ms of audio content)`);
  console.log(`  Interrupt event forwarded: ${gotInterruptEvent ? "YES" : "NO"}`);
  if (interruptToForward !== null) {
    console.log(`  Interrupt round-trip (send → forwarded back): ${fmt(interruptToForward)}`);
  }
  console.log(`  FAST INTERRUPT: ${gotInterruptEvent && audioDurationAfter < 2000 ? "YES" : "NO"} (interrupt forwarded, < 2s buffered audio)`);
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║  acpfx Latency Benchmark Suite            ║");
  console.log("╚═══════════════════════════════════════════╝");

  if (!ELEVENLABS_KEY) {
    console.error("ERROR: ELEVENLABS_API_KEY not set");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const runAll = args.length === 0;
  const runTest = (name: string) => runAll || args.includes(name);

  if (runTest("tts")) await benchmarkTtsTtfb();
  if (runTest("e2e")) await benchmarkE2E();
  if (runTest("streaming")) await benchmarkTokenStreaming();
  if (runTest("interrupt")) await benchmarkInterrupt();

  console.log("\n══════════════════════════════════════════════");
  console.log("Benchmarks complete.");
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
