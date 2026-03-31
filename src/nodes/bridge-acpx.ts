/**
 * bridge-acpx node — reads speech.pause events, submits to acpx via queue IPC,
 * streams agent.submit/agent.delta/agent.complete events.
 *
 * Handles control.interrupt by cancelling the active acpx prompt.
 *
 * Settings (via ACPFX_SETTINGS):
 *   agent: string         — agent name (e.g., "claude")
 *   model?: string         — model ID (e.g., "claude-haiku-4-5-20251001")
 *   approveAll?: boolean   — auto-approve all permission requests
 *   verbose?: boolean      — enable verbose logging
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import {
  AcpxIpcClient,
  resolveSessionId,
} from "../bridge/acpx-ipc.js";

type Settings = {
  agent: string;
  model?: string;
  approveAll?: boolean;
  verbose?: boolean;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");

if (!settings.agent) {
  process.stderr.write("[bridge-acpx] ERROR: settings.agent is required\n");
  process.exit(1);
}

const AGENT = settings.agent;
const VERBOSE = settings.verbose ?? false;

let ipcClient: AcpxIpcClient | null = null;
let activeAbort: AbortController | null = null;
let acpxProcess: ChildProcess | null = null;
let interrupted = false;
let streaming = false;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[bridge-acpx] ${msg}\n`);
}

/**
 * Ensure an acpx session is running for the agent.
 * If no session exists, spawn one with a simple initial prompt.
 */
async function ensureSession(): Promise<string> {
  // First, check if a session already exists
  let sessionId = await resolveSessionId(AGENT);
  if (sessionId) {
    log(`Found existing session: ${sessionId}`);
    return sessionId;
  }

  // No session — spawn acpx with the agent
  log(`No active session for "${AGENT}", starting acpx...`);

  const args: string[] = [AGENT];
  if (settings.model) args.push("--model", settings.model);
  if (settings.approveAll) args.push("--approve-all");
  args.push("--format", "quiet");
  args.push("hello"); // Initial prompt to establish session

  acpxProcess = spawn("acpx", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  acpxProcess.stderr?.on("data", (data: Buffer) => {
    if (VERBOSE) {
      process.stderr.write(`[acpx] ${data.toString()}`);
    }
  });

  // Wait for the session to appear (acpx needs time to start)
  const maxWaitMs = 30000;
  const pollMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(pollMs);
    sessionId = await resolveSessionId(AGENT);
    if (sessionId) {
      log(`Session started: ${sessionId}`);
      return sessionId;
    }
  }

  throw new Error(
    `Timed out waiting for acpx session for "${AGENT}" after ${maxWaitMs}ms`,
  );
}

async function handleSpeechPause(pendingText: string): Promise<void> {
  if (!ipcClient || interrupted) return;
  if (streaming) {
    // Already streaming — cancel first, then resubmit
    await cancelCurrentPrompt();
  }

  const requestId = randomUUID();
  streaming = true;
  activeAbort = new AbortController();

  // Emit agent.submit
  emit({
    type: "agent.submit",
    requestId,
    text: pendingText,
  });

  let seq = 0;
  let fullText = "";

  try {
    await ipcClient.submitPrompt({
      sessionId: ipcClient.sessionId,
      text: pendingText,
      signal: activeAbort.signal,
      onTextDelta: (delta, _seq) => {
        if (interrupted) return;
        fullText += delta;
        emit({
          type: "agent.delta",
          requestId,
          delta,
          seq: seq++,
        });
      },
      onComplete: (text) => {
        if (!interrupted) {
          emit({
            type: "agent.complete",
            requestId,
            text: text || fullText,
          });
        }
        streaming = false;
        activeAbort = null;
      },
      onError: (error) => {
        log(`Prompt error: ${error.message}`);
        emit({
          type: "control.error",
          component: "bridge-acpx",
          message: error.message,
          fatal: false,
        });
        streaming = false;
        activeAbort = null;
      },
    });
  } catch (err) {
    if (!interrupted) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Submit error: ${msg}`);
      emit({
        type: "control.error",
        component: "bridge-acpx",
        message: msg,
        fatal: false,
      });
    }
    streaming = false;
    activeAbort = null;
  }
}

async function cancelCurrentPrompt(): Promise<void> {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }

  if (ipcClient) {
    try {
      const result = await ipcClient.cancelPrompt();
      if (VERBOSE) log(`Cancel result: ${result.cancelled}`);
    } catch (err) {
      if (VERBOSE) log(`Cancel error: ${err}`);
    }
  }

  streaming = false;

  // Emit control.interrupt so downstream nodes (TTS, play) flush their buffers
  emit({
    type: "control.interrupt",
    reason: "user_speech",
  });
}

function cleanup(): void {
  if (acpxProcess && !acpxProcess.killed) {
    acpxProcess.stdin?.end();
    acpxProcess.kill("SIGTERM");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

async function main(): Promise<void> {
  const sessionId = await ensureSession();
  ipcClient = new AcpxIpcClient(sessionId, { verbose: VERBOSE });

  // Emit lifecycle.ready
  emit({ type: "lifecycle.ready", component: "bridge-acpx" });

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);

      if (event.type === "speech.pause" && !interrupted) {
        const text = event.pendingText ?? event.text ?? "";
        if (text) {
          handleSpeechPause(text);
        }
      } else if (event.type === "control.interrupt") {
        interrupted = true;
        cancelCurrentPrompt().then(() => {
          interrupted = false;
        });
      }
    } catch {
      // ignore
    }
  });

  rl.on("close", () => {
    cleanup();
    emit({ type: "lifecycle.done", component: "bridge-acpx" });
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
