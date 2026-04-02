/**
 * bridge-acpx node — reads speech.pause events, submits to acpx CLI,
 * streams agent.submit/agent.delta/agent.complete events.
 * Handles control.interrupt by killing the active process + acpx cancel.
 *
 * Uses `acpx --format json` for structured ACP output instead of
 * direct socket IPC. acpx handles session management, queue owner
 * lifecycle, and agent reconnection.
 *
 * Settings:
 *   agent: string (required)  — agent name (claude, codex, pi, etc.)
 *   session?: string          — named session (maps to acpx -s <name>)
 *   args?: Record<string, string | boolean> — extra acpx CLI flags
 *   verbose?: boolean
 */

import { randomUUID } from "node:crypto";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { emit, log, onEvent, handleManifestFlag } from "@acpfx/node-sdk";

handleManifestFlag();

type Settings = {
  agent: string;
  session?: string;
  args?: Record<string, string | boolean>;
  verbose?: boolean;
};

const settings: Settings = JSON.parse(process.env.ACPFX_SETTINGS || "{}");

if (!settings.agent) {
  log.error("settings.agent is required");
  process.exit(1);
}

const AGENT = settings.agent;
const VERBOSE = settings.verbose ?? false;
const NODE_NAME = process.env.ACPFX_NODE_NAME ?? "bridge";

let activeChild: ChildProcess | null = null;
let interrupted = false;
let streaming = false;
let agentResponding = false;


/** Build CLI args from settings.args */
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
 * Ensure an acpx session exists.
 * `sessions ensure` creates the record; the first prompt bootstraps the queue owner.
 */
function ensureSession(): void {
  log.info(`Ensuring session for "${AGENT}"${settings.session ? ` (session: ${settings.session})` : ""}...`);

  const args = ["acpx@latest", AGENT, "sessions", "ensure"];
  if (settings.session) args.push("--name", settings.session);

  try {
    const output = execSync(["npx", "-y", ...args].join(" "), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      timeout: 30000,
      encoding: "utf8",
    });
    log.info(`Session: ${output.trim()}`);
  } catch (err) {
    log.warn(`sessions ensure failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Submit a prompt via `acpx --format json` and stream deltas.
 */
function handleSpeechPause(pendingText: string): void {
  if (interrupted) return;

  const requestId = randomUUID();
  streaming = true;

  emit({ type: "agent.submit", requestId, text: pendingText });

  // Build acpx command: npx -y acpx@latest --format json [extra-args] <agent> -s <session> "text"
  const args = [
    "-y", "acpx@latest",
    "--format", "json",
    ...buildExtraArgs(),
    AGENT,
  ];
  if (settings.session) args.push("-s", settings.session);
  args.push(pendingText);

  const child = spawn("npx", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  activeChild = child;

  let seq = 0;
  let fullText = "";
  let buffer = "";

  let emittedThinking = false;

  const processLine = (line: string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Handle session/update events
    if (msg.method === "session/update") {
      const params = msg.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      if (!update) return;

      const sessionUpdate = update.sessionUpdate as string;
      // Log all non-chunk session updates to debug event flow
      if (sessionUpdate !== "agent_message_chunk" && sessionUpdate !== "usage_update" && sessionUpdate !== "available_commands_update") {
        log.debug(`ACP: ${sessionUpdate} ${JSON.stringify(update).slice(0, 200)}`);
      }

      // Thinking chunks
      if (sessionUpdate === "agent_thought_chunk") {
        if (!emittedThinking) {
          emittedThinking = true;
          emit({ type: "agent.thinking", requestId });
        }
        return;
      }

      // Tool call started — tool_call event means a new tool invocation
      if (sessionUpdate === "tool_call") {
        // Extract tool name — prefer _meta.claudeCode.toolName, fall back to title
        const meta = update._meta as Record<string, unknown> | undefined;
        const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
        const toolTitle =
          (typeof claudeCode?.toolName === "string" && claudeCode.toolName ? claudeCode.toolName : null)
          ?? (typeof update.title === "string" && update.title ? update.title : null)
          ?? (typeof update.name === "string" && update.name ? update.name : null)
          ?? undefined;
        log.debug(`tool_call: toolName=${claudeCode?.toolName} title=${update.title} resolved=${toolTitle}`);
        emit({
          type: "agent.tool_start",
          requestId,
          toolCallId: (typeof update.toolCallId === "string" ? update.toolCallId : "") ?? "",
          title: toolTitle,
        });
        return;
      }

      // Tool call completed/failed
      if (sessionUpdate === "tool_call_update") {
        const status = update.status as string | undefined;
        if (status === "completed" || status === "failed") {
          emit({
            type: "agent.tool_done",
            requestId,
            toolCallId: (update.toolCallId as string) ?? "",
            status,
          });
        }
        return;
      }

      // Text generation
      if (sessionUpdate === "agent_message_chunk") {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type === "text" && typeof content.text === "string" && content.text) {
          fullText += content.text;
          agentResponding = true;
          emit({ type: "agent.delta", requestId, delta: content.text, seq: seq++ });
        }
        return;
      }

      return;
    }

    // Look for completion: JSON-RPC result with stopReason
    if (Object.hasOwn(msg, "result") && typeof msg.id === "number") {
      const result = msg.result as Record<string, unknown> | undefined;
      if (result && typeof result.stopReason === "string") {
        if (!interrupted) {
          emit({ type: "agent.complete", requestId, text: fullText });
        }
      }
    }
  };

  writeFileSync("/tmp/acpfx-bridge-raw.log", "");
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    appendFileSync("/tmp/acpfx-bridge-raw.log", chunk);
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) processLine(line);
      idx = buffer.indexOf("\n");
    }
  });

  if (VERBOSE) {
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      log.debug(`acpx stderr: ${chunk.trimEnd()}`);
    });
  }

  child.on("close", (code, _signal) => {
    if (activeChild === child) activeChild = null;
    streaming = false;

    // null code + signal means we killed it (SIGTERM on cancel) — not an error
    if (code !== 0 && code !== null && !interrupted) {
      log.error(`acpx exited with code ${code}`);
      emit({
        type: "control.error",
        component: "bridge-acpx",
        message: `acpx exited with code ${code}`,
        fatal: false,
      });
    }
  });
}

/**
 * Cancel the active prompt: kill process + acpx cancel command.
 */
function cancelCurrentPrompt(): void {
  if (activeChild) {
    activeChild.kill("SIGTERM");
    activeChild = null;
  }

  // Fire-and-forget cancel to the queue owner
  const args = ["-y", "acpx@latest", AGENT, "cancel"];
  if (settings.session) args.push("-s", settings.session);

  const cancel = spawn("npx", args, {
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  cancel.unref();

  streaming = false;
}

// --- Main ---

function main(): void {
  ensureSession();

  emit({ type: "lifecycle.ready", component: "bridge-acpx" });

  let active = false;
  let interruptedForBargein = false;
  let accumulatedText = "";

  const rl = onEvent((event) => {
      if (event.type === "speech.partial" && active && !interruptedForBargein) {
        log.info("Barge-in detected (speech.partial while active) — interrupting");
        interruptedForBargein = true;
        emit({ type: "control.interrupt", reason: "user_speech" });
        if (streaming) cancelCurrentPrompt();
      } else if (event.type === "speech.pause") {
        interruptedForBargein = false;
        active = true;
        const text = (event.pendingText as string) ?? (event.text as string) ?? "";
        if (text) {
          emit({ type: "control.interrupt", reason: "user_speech" });

          if (agentResponding) {
            // Agent already responded — this is a new turn, clear accumulator
            accumulatedText = text;
            agentResponding = false;
          } else if (streaming) {
            // Agent hasn't responded yet — append to accumulator and resubmit
            cancelCurrentPrompt();
            accumulatedText = accumulatedText ? accumulatedText + " " + text : text;
          } else {
            // Fresh submission
            accumulatedText = accumulatedText ? accumulatedText + " " + text : text;
          }

          handleSpeechPause(accumulatedText);
        }
      } else if (event.type === "control.interrupt" && event._from !== NODE_NAME) {
        // Ignore our own interrupts that cycled back through the graph
        interrupted = true;
        cancelCurrentPrompt();
        interrupted = false;
      }
  });

  rl.on("close", () => {
    if (streaming) cancelCurrentPrompt();
    emit({ type: "lifecycle.done", component: "bridge-acpx" });
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    if (streaming) cancelCurrentPrompt();
    process.exit(0);
  });
}

main();
