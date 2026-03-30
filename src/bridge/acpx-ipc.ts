/**
 * acpx Queue IPC client.
 *
 * Connects to acpx's queue owner Unix socket, submits prompts,
 * streams responses (ACP JSON-RPC messages), and cancels.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 50;
const CONNECT_MAX_ATTEMPTS = 40;

// --- Queue path resolution (mirrors acpx/src/queue-paths.ts) ---

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function queueKeyForSession(sessionId: string): string {
  return shortHash(sessionId, 24);
}

function queueBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "queues");
}

function queueSocketPath(sessionId: string): string {
  const key = queueKeyForSession(sessionId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acpx-${key}`;
  }
  const socketBase = path.join("/tmp", `acpx-${shortHash(os.homedir(), 10)}`);
  return path.join(socketBase, `${key}.sock`);
}

function queueLockFilePath(sessionId: string): string {
  return path.join(queueBaseDir(), `${queueKeyForSession(sessionId)}.lock`);
}

// --- Queue owner record ---

type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  ownerGeneration?: number;
};

async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const lockPath = queueLockFilePath(sessionId);
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(payload);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.socketPath !== "string"
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      sessionId: parsed.sessionId,
      socketPath: parsed.socketPath,
      ownerGeneration:
        typeof parsed.ownerGeneration === "number"
          ? parsed.ownerGeneration
          : undefined,
    };
  } catch {
    return undefined;
  }
}

// --- Socket connection ---

function connectToSocket(
  socketPath: string,
  timeoutMs = SOCKET_CONNECT_TIMEOUT_MS,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new Error(
          `Connection to ${socketPath} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(socket);
    });

    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function connectToQueueOwner(
  owner: QueueOwnerRecord,
): Promise<net.Socket | undefined> {
  let lastError: unknown;

  for (let attempt = 0; attempt < CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      return await connectToSocket(owner.socketPath);
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") {
        throw error;
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }

  return undefined;
}

// --- ACP message parsing ---

type AcpTextDelta = {
  type: "text_delta";
  text: string;
};

type AcpStopReason = {
  type: "stop_reason";
  reason: string;
};

type AcpEvent = AcpTextDelta | AcpStopReason | { type: "other" };

/**
 * Extracts meaningful data from an ACP JSON-RPC message streamed from the queue owner.
 * The queue owner wraps ACP messages in: { type: "event", requestId, message: AcpJsonRpcMessage }
 * where AcpJsonRpcMessage is a JSON-RPC notification like:
 * { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "..." } } } }
 */
export function extractAcpEvent(acpMessage: Record<string, unknown>): AcpEvent {
  // Check for session/update notifications with agent_message_chunk
  if (acpMessage.method === "session/update") {
    const params = acpMessage.params as Record<string, unknown> | undefined;
    if (!params) return { type: "other" };
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return { type: "other" };

    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      if (content && content.type === "text" && typeof content.text === "string") {
        return { type: "text_delta", text: content.text };
      }
    }
    return { type: "other" };
  }

  // Check for prompt completion (JSON-RPC response with result)
  if (Object.hasOwn(acpMessage, "result")) {
    const result = acpMessage.result as Record<string, unknown> | undefined;
    if (result && typeof result.stopReason === "string") {
      return { type: "stop_reason", reason: result.stopReason };
    }
  }

  return { type: "other" };
}

// --- IPC client ---

export type SubmitOptions = {
  sessionId: string;
  text: string;
  onTextDelta: (delta: string, seq: number) => void;
  onComplete: (fullText: string) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
};

export type CancelResult = {
  cancelled: boolean;
};

export class AcpxIpcClient {
  private _sessionId: string;
  private _verbose: boolean;

  constructor(sessionId: string, opts?: { verbose?: boolean }) {
    this._sessionId = sessionId;
    this._verbose = opts?.verbose ?? false;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Submit a prompt to the acpx queue owner and stream text deltas back.
   * Returns the requestId. Calls onTextDelta for each chunk, onComplete when done.
   */
  async submitPrompt(opts: SubmitOptions): Promise<string> {
    const owner = await readQueueOwnerRecord(this._sessionId);
    if (!owner) {
      throw new Error(
        `No active acpx session found for "${this._sessionId}". ` +
        `Start one with: acpx ${this._sessionId} "hello"`,
      );
    }

    const socket = await connectToQueueOwner(owner);
    if (!socket) {
      throw new Error(
        `Could not connect to acpx queue owner for session "${this._sessionId}"`,
      );
    }

    const requestId = randomUUID();
    let seq = 0;
    let fullText = "";
    let acknowledged = false;
    let buffer = "";

    const request = {
      type: "submit_prompt",
      requestId,
      ownerGeneration: owner.ownerGeneration,
      message: opts.text,
      permissionMode: "approve-all",
      waitForCompletion: true,
    };

    socket.setEncoding("utf8");

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (!socket.destroyed) {
          socket.end();
        }
        socket.removeAllListeners();
      };

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          opts.onError(error);
          reject(error);
        }
      };

      // Handle abort signal
      if (opts.signal) {
        if (opts.signal.aborted) {
          cleanup();
          reject(new Error("Aborted"));
          return;
        }
        opts.signal.addEventListener("abort", () => {
          finish(new Error("Aborted"));
        }, { once: true });
      }

      const processLine = (line: string) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // Skip malformed lines
        }

        if (typeof parsed.type !== "string") return;

        // Check requestId matches
        if (parsed.requestId !== requestId) return;

        if (parsed.type === "accepted") {
          acknowledged = true;
          return;
        }

        if (!acknowledged) {
          finish(new Error("Queue owner sent data before acknowledging request"));
          return;
        }

        if (parsed.type === "error") {
          const msg = typeof parsed.message === "string"
            ? parsed.message
            : "Queue owner error";
          finish(new Error(msg));
          return;
        }

        if (parsed.type === "event") {
          const acpMessage = parsed.message as Record<string, unknown> | undefined;
          if (!acpMessage) return;

          const event = extractAcpEvent(acpMessage);
          if (event.type === "text_delta") {
            fullText += event.text;
            opts.onTextDelta(event.text, seq++);
          }
          return;
        }

        if (parsed.type === "result") {
          opts.onComplete(fullText);
          if (!settled) {
            settled = true;
            cleanup();
            resolve(requestId);
          }
          return;
        }

        if (parsed.type === "cancel_result") {
          opts.onComplete(fullText);
          if (!settled) {
            settled = true;
            cleanup();
            resolve(requestId);
          }
          return;
        }
      };

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) {
            processLine(line);
          }
          idx = buffer.indexOf("\n");
        }
      });

      socket.once("error", (err: Error) => {
        finish(err);
      });

      socket.once("close", () => {
        if (!settled) {
          if (!acknowledged) {
            finish(new Error("Queue owner disconnected before acknowledging request"));
          } else {
            // Connection closed after acknowledgement, treat as completion
            opts.onComplete(fullText);
            settled = true;
            cleanup();
            resolve(requestId);
          }
        }
      });

      // Send the request
      socket.write(JSON.stringify(request) + "\n");

      if (this._verbose) {
        process.stderr.write(
          `[acpfx:bridge] submitted prompt to session ${this._sessionId} (requestId: ${requestId})\n`,
        );
      }
    });
  }

  /**
   * Cancel a running prompt on the acpx queue owner.
   */
  async cancelPrompt(): Promise<CancelResult> {
    const owner = await readQueueOwnerRecord(this._sessionId);
    if (!owner) {
      return { cancelled: false };
    }

    const socket = await connectToQueueOwner(owner);
    if (!socket) {
      return { cancelled: false };
    }

    const requestId = randomUUID();
    const request = {
      type: "cancel_prompt",
      requestId,
      ownerGeneration: owner.ownerGeneration,
    };

    socket.setEncoding("utf8");

    return new Promise<CancelResult>((resolve) => {
      let settled = false;
      let buffer = "";

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ cancelled: false });
      }, SOCKET_CONNECT_TIMEOUT_MS);

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.requestId === requestId) {
                if (parsed.type === "accepted") {
                  // Wait for cancel_result
                } else if (parsed.type === "cancel_result") {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    socket.end();
                    resolve({ cancelled: parsed.cancelled === true });
                  }
                } else if (parsed.type === "error") {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    socket.end();
                    resolve({ cancelled: false });
                  }
                }
              }
            } catch {
              // Skip malformed
            }
          }
          idx = buffer.indexOf("\n");
        }
      });

      socket.once("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ cancelled: false });
        }
      });

      socket.once("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ cancelled: false });
        }
      });

      socket.write(JSON.stringify(request) + "\n");

      if (this._verbose) {
        process.stderr.write(
          `[acpfx:bridge] cancel request sent to session ${this._sessionId}\n`,
        );
      }
    });
  }
}

// --- Session resolution ---

/**
 * Find the session ID for a given agent name.
 * Looks at ~/.acpx/sessions/ index to find the most recent open session
 * for the given agent command.
 */
export async function resolveSessionId(
  agentName: string,
): Promise<string | undefined> {
  const indexPath = path.join(os.homedir(), ".acpx", "sessions", "index.json");
  try {
    const data = await fs.readFile(indexPath, "utf8");
    const raw = JSON.parse(data);

    // Support both array format and {entries: [...]} format
    const entries: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    if (entries.length === 0) return undefined;

    // Find most recent open session matching the agent
    type IndexEntry = {
      acpxRecordId?: string;
      acpSessionId?: string;
      agentCommand?: string;
      closed?: boolean;
      lastUsedAt?: string;
    };

    const matches = (entries as IndexEntry[])
      .filter(
        (entry) =>
          entry.agentCommand &&
          entry.agentCommand.includes(agentName) &&
          !entry.closed &&
          (entry.acpxRecordId || entry.acpSessionId),
      )
      .sort((a, b) =>
        (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""),
      );

    // Queue owner uses acpxRecordId as the session key, not acpSessionId
    return matches[0]?.acpxRecordId ?? matches[0]?.acpSessionId;
  } catch {
    return undefined;
  }
}
