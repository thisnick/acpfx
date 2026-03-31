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

import { ChildProcess, fork } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnyEvent, parseEvent, serializeEvent } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type NodeRunnerOptions = {
  name: string;
  use: string;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
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
    const modulePath = resolveNodeModule(this.use);
    const env: Record<string, string | undefined> = { ...process.env, ...this.options.env };
    if (this.options.settings) {
      env.ACPFX_SETTINGS = JSON.stringify(this.options.settings);
    }

    this.proc = fork(modulePath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env,
      silent: true,
    });

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

    // Forward stderr to parent stderr
    if (this.use.includes("ui-cli") || this.use.includes("ui-web")) {
      // UI nodes: pipe raw bytes so Ink's ANSI escape sequences work
      this.proc.stderr!.pipe(process.stderr);
    } else {
      // Other nodes: prefix each line with node name
      const stderrRl = createInterface({ input: this.proc.stderr! });
      stderrRl.on("line", (line) => {
        process.stderr.write(`[${this.name}] ${line}\n`);
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
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(serializeEvent(event) + "\n");
    } catch {
      // Node may have exited — ignore write errors
    }
  }

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

/** Resolve a `use` string like "@acpfx/mic-file" to a JS module path. */
function resolveNodeModule(use: string): string {
  // Built-in nodes: @acpfx/<name> → dist/nodes/<name>.js
  const match = use.match(/^@acpfx\/(.+)$/);
  if (match) {
    // __dirname is dist/, so nodes are at dist/nodes/<name>.js
    return resolve(__dirname, "nodes", `${match[1]}.js`);
  }
  // External: treat as a file path or module specifier
  return resolve(use);
}
