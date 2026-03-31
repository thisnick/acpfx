/**
 * bridge-acpx node — reads speech.pause events, submits to acpx via queue IPC,
 * streams agent.submit/agent.delta/agent.complete events.
 * Handles control.interrupt by cancelling the active acpx prompt.
 *
 * Settings:
 *   agent: string (required)  — agent name (claude, codex, pi, etc.)
 *   session?: string          — named session (maps to acpx -s <name>)
 *   args?: Record<string, string | boolean> — extra acpx CLI flags, passed through
 *     e.g., { "model": "claude-sonnet-4-6", "approve-all": true, "ttl": "0" }
 *     String values → --key value, boolean true → --key
 *   verbose?: boolean
 */

import { randomUUID } from "node:crypto";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AcpxIpcClient,
  resolveSessionId,
} from "../bridge/acpx-ipc.js";

type Settings = {
  agent: string;
  session?: string;
  args?: Record<string, string | boolean>;
  verbose?: boolean;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");

if (!settings.agent) {
  process.stderr.write("[bridge-acpx] ERROR: settings.agent is required\n");
  process.exit(1);
}

const AGENT = settings.agent;
const VERBOSE = settings.verbose ?? false;
const ACPX_CMD = "npx";
const ACPX_PKG = "acpx@latest";

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

/** Build CLI args array from settings.args */
function buildExtraArgs(): string[] {
  const args: string[] = [];
  if (!settings.args) return args;
  for (const [key, value] of Object.entries(settings.args)) {
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    if (value === true) {
      args.push(flag);
    } else if (typeof value === "string") {
      args.push(flag, value);
    }
  }
  return args;
}

/**
 * Ensure an acpx session is running for the agent.
 * Runs a quick prompt to bootstrap session + queue owner if needed.
 */
async function ensureSession(): Promise<string> {
  // Check if a session already exists
  let sessionId = await resolveSessionId(AGENT, settings.session);
  if (sessionId) {
    log(`Found existing session: ${sessionId}`);
    return sessionId;
  }

  // No session — spawn acpx to create one
  log(`No active session for "${AGENT}"${settings.session ? ` (session: ${settings.session})` : ""}, starting...`);

  const args = ["-y", ACPX_PKG, ...buildExtraArgs(), AGENT];
  if (settings.session) args.push("-s", settings.session);
  args.push("--format", "quiet", "hello");

  acpxProcess = spawn(ACPX_CMD, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  acpxProcess.stderr?.on("data", (data: Buffer) => {
    if (VERBOSE) log(`[acpx] ${data.toString().trim()}`);
  });

  // Wait for session to appear
  const maxWaitMs = 60000;
  const pollMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(pollMs);
    sessionId = await resolveSessionId(AGENT, settings.session);
    if (sessionId) {
      log(`Session started: ${sessionId}`);
      return sessionId;
    }
  }

  throw new Error(`Timed out waiting for acpx session for "${AGENT}"`);
}

async function handleSpeechPause(pendingText: string): Promise<void> {
  if (!ipcClient || interrupted) return;

  const requestId = randomUUID();
  streaming = true;
  activeAbort = new AbortController();

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
      onTextDelta: (delta: string, _seq: number) => {
        if (interrupted) return;
        fullText += delta;
        emit({
          type: "agent.delta",
          requestId,
          delta,
          seq: seq++,
        });
      },
      onComplete: (text: string) => {
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
      onError: (error: Error) => {
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
}

function cleanup(): void {
  if (acpxProcess && !acpxProcess.killed) {
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

  emit({ type: "lifecycle.ready", component: "bridge-acpx" });

  const rl = createInterface({ input: process.stdin });

  let active = false;
  let interruptedForBargein = false;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);

      if (event.type === "speech.partial" && active && !interruptedForBargein) {
        log("Barge-in detected (speech.partial while active) — interrupting");
        interruptedForBargein = true;
        emit({ type: "control.interrupt", reason: "user_speech" });
        if (streaming) {
          cancelCurrentPrompt();
        }
      } else if (event.type === "speech.pause") {
        interruptedForBargein = false;
        active = true;
        const text = event.pendingText ?? event.text ?? "";
        if (text) {
          emit({ type: "control.interrupt", reason: "user_speech" });
          if (streaming) {
            cancelCurrentPrompt().then(() => handleSpeechPause(text));
          } else {
            handleSpeechPause(text);
          }
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
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
