/**
 * Node Runner — spawns a node as a child process, manages NDJSON stdin/stdout,
 * handles lifecycle events and clean shutdown.
 *
 * Each node is a child process that:
 * - Receives NDJSON events on stdin
 * - Emits NDJSON events on stdout
 * - Logs to stderr (forwarded to parent's stderr)
 * - Gets settings via ACPFX_SETTINGS env var
 * - Must emit lifecycle.ready when initialized
 * - Exits on stdin EOF or SIGTERM
 */

import { ChildProcess, fork, spawn as cpSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { type AnyEvent, parseEvent, serializeEvent } from "@acpfx/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type NodeRunnerOptions = {
  name: string;
  use: string;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  quiet?: boolean; // suppress stderr forwarding (when UI is active)
  onEvent: (event: AnyEvent) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: string | null) => void;
};

export class NodeRunner {
  readonly name: string;
  readonly use: string;
  private proc: ChildProcess | null = null;
  private options: NodeRunnerOptions;
  private _ready = false;
  private _readyPromiseResolve: (() => void) | null = null;
  private _readyPromise: Promise<void>;

  constructor(options: NodeRunnerOptions) {
    this.name = options.name;
    this.use = options.use;
    this.options = options;
    this._readyPromise = new Promise((resolve) => {
      this._readyPromiseResolve = resolve;
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Wait for this node to emit lifecycle.ready. */
  waitReady(timeoutMs = 10000): Promise<void> {
    if (this._ready) return Promise.resolve();
    return Promise.race([
      this._readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Node '${this.name}' did not become ready within ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /** Spawn the node process. */
  spawn(): void {
    const resolved = resolveNode(this.use);
    const env: Record<string, string | undefined> = { ...process.env, ...this.options.env };
    env.ACPFX_NODE_NAME = this.name;
    if (this.options.settings) {
      env.ACPFX_SETTINGS = JSON.stringify(this.options.settings);
    }

    if (resolved.type === "fork") {
      this.proc = fork(resolved.command, resolved.args, {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env,
        silent: true,
      });
    } else {
      this.proc = cpSpawn(resolved.command, resolved.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    }

    // Suppress EPIPE errors on stdin (node may exit while we're writing)
    this.proc.stdin!.on("error", () => {});

    // Read NDJSON from stdout
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = parseEvent(line);
        // Check for lifecycle.ready
        if (event.type === "lifecycle.ready") {
          this._ready = true;
          this._readyPromiseResolve?.();
        }
        this.options.onEvent(event);
      } catch (err) {
        this.options.onError(
          new Error(`Node '${this.name}' emitted invalid JSON: ${line}`),
        );
      }
    });

    // Forward stderr
    if (this.use.includes("ui-cli") || this.use.includes("ui-web")) {
      // UI nodes: pipe raw bytes so Ink's ANSI escape sequences work
      this.proc.stderr!.pipe(process.stderr);
    } else {
      // Convert node stderr lines to log events routed through the orchestrator
      const stderrRl = createInterface({ input: this.proc.stderr! });
      stderrRl.on("line", (line) => {
        if (line.includes("buffer underflow") || line.includes("Didn't have any audio")) return;
        if (!line.trim()) return;
        // Emit as a log event so it flows through the orchestrator like any other event
        this.options.onEvent({
          type: "log",
          level: line.toLowerCase().includes("error") ? "error" : "info",
          component: this.name,
          message: line,
        } as AnyEvent);
      });
    }

    this.proc.on("error", (err) => {
      this.options.onError(err);
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      this.options.onExit(code, signal);
    });
  }

  /** Send an event to this node's stdin. */
  send(event: AnyEvent): void {
    if (!this.proc?.stdin?.writable) {
      if (event.type === "audio.chunk") {
        // Only log once per dropped burst
        if (!this._loggedDrop) {
          this._loggedDrop = true;
          process.stderr.write(`[orchestrator] WARNING: dropping ${event.type} to ${this.name} (stdin not writable)\n`);
        }
      }
      return;
    }
    this._loggedDrop = false;
    try {
      this.proc.stdin.write(serializeEvent(event) + "\n");
    } catch {
      // Node may have exited — ignore write errors
    }
  }
  private _loggedDrop = false;

  /** Gracefully shut down: close stdin, then SIGTERM after timeout. */
  async stop(timeoutMs = 3000): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;

    // Close stdin to signal EOF
    proc.stdin?.end();

    // Wait for exit, or SIGTERM
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve();
      }, timeoutMs);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Forcefully kill the node process. */
  kill(): void {
    this.proc?.kill("SIGKILL");
  }
}

export type ResolvedNode = {
  command: string;
  args: string[];
  type: "fork" | "spawn";
};

/**
 * Resolve a `use` string to a command + launch strategy.
 *
 * For @acpfx/<name>:
 *   1. Local JS:     dist/nodes/<name>.js  → fork()
 *   2. Local binary: dist/nodes/<name>     → spawn()
 *   3. npx fallback: npx -y @acpfx/<name> → spawn()
 *
 * For external paths:
 *   - .js/.mjs → fork()
 *   - otherwise → spawn()
 */
export function resolveNode(use: string): ResolvedNode {
  const match = use.match(/^@acpfx\/(.+)$/);
  if (match) {
    const name = match[1];
    // 1. Local JS bundle
    const jsPath = resolve(__dirname, "nodes", `${name}.js`);
    if (existsSync(jsPath)) {
      return { command: jsPath, args: [], type: "fork" };
    }
    // 2. Local native binary
    const binPath = resolve(__dirname, "nodes", name);
    if (existsSync(binPath)) {
      return { command: binPath, args: [], type: "spawn" };
    }
    // 3. npx fallback
    return { command: "npx", args: ["-y", use], type: "spawn" };
  }

  // External path
  if (use.endsWith(".js") || use.endsWith(".mjs")) {
    return { command: resolve(use), args: [], type: "fork" };
  }
  return { command: resolve(use), args: [], type: "spawn" };
}
