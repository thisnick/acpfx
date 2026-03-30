/**
 * Pipeline manager: spawns input and output sub-pipelines as shell pipelines,
 * holds handles to their stdin and stdout for bidirectional communication.
 *
 * Input pipeline (default: "acpfx mic | acpfx stt | acpfx vad"):
 *   - Bridge writes control events to its stdin
 *   - Bridge reads speech events from its stdout
 *
 * Output pipeline (default: "acpfx tts | acpfx play"):
 *   - Bridge writes text/control events to its stdin
 *   - Bridge reads feedback events from its stdout (optional)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readEvents, createEventWriter } from "../pipeline-io.js";
import type { AnyEvent } from "../protocol.js";

const DEFAULT_INPUT_PIPELINE = "acpfx mic | acpfx stt | acpfx vad";
const DEFAULT_OUTPUT_PIPELINE = "acpfx tts | acpfx play";

export type PipelineManagerOptions = {
  input?: string;
  output?: string;
  verbose?: boolean;
};

export type PipelineHandles = {
  /** Write events to the input pipeline's stdin (control events) */
  writeToInput: (event: AnyEvent) => Promise<boolean>;
  /** Write events to the output pipeline's stdin (text/control events) */
  writeToOutput: (event: AnyEvent) => Promise<boolean>;
  /** Read events from the input pipeline's stdout (speech events) */
  onInputEvent: (handler: (event: AnyEvent) => void | Promise<void>) => void;
  /** Read events from the output pipeline's stdout (feedback events) */
  onOutputEvent: (handler: (event: AnyEvent) => void | Promise<void>) => void;
  /** Shut down both pipelines cleanly */
  shutdown: () => Promise<void>;
  /** Promise that resolves when the input pipeline exits */
  inputDone: Promise<void>;
  /** Promise that resolves when the output pipeline exits */
  outputDone: Promise<void>;
};

/**
 * Spawn a shell pipeline and return the child process.
 * Uses `sh -c` to get proper pipe handling.
 */
function spawnPipeline(
  command: string,
  label: string,
  verbose: boolean,
): ChildProcess {
  if (verbose) {
    process.stderr.write(`[acpfx:bridge] spawning ${label}: ${command}\n`);
  }

  const proc = spawn("sh", ["-c", command], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Forward stderr from sub-pipeline to our stderr
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  return proc;
}

/**
 * Wait for a child process to exit.
 * Returns the exit code (or null if killed by signal).
 */
function waitForExit(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    proc.on("close", (code) => {
      resolve(code);
    });
  });
}

/**
 * Spawn input and output pipelines and return handles for bidirectional communication.
 */
export function startPipelines(
  opts: PipelineManagerOptions,
): PipelineHandles {
  const verbose = opts.verbose ?? false;
  const inputCmd = opts.input ?? DEFAULT_INPUT_PIPELINE;
  const outputCmd = opts.output ?? DEFAULT_OUTPUT_PIPELINE;

  const inputProc = spawnPipeline(inputCmd, "input", verbose);
  const outputProc = spawnPipeline(outputCmd, "output", verbose);

  const inputWriter = createEventWriter(inputProc.stdin!);
  const outputWriter = createEventWriter(outputProc.stdin!);

  // Event handler registrations (set once by the caller)
  let inputEventHandler: ((event: AnyEvent) => void | Promise<void>) | null = null;
  let outputEventHandler: ((event: AnyEvent) => void | Promise<void>) | null = null;

  // Start reading from input pipeline stdout (speech events)
  const inputReadDone = readEvents(
    inputProc.stdout!,
    async (event) => {
      if (inputEventHandler) {
        await inputEventHandler(event);
      }
    },
    async (error) => {
      if (verbose) {
        process.stderr.write(
          `[acpfx:bridge] input pipeline parse error: ${error.message}\n`,
        );
      }
    },
  );

  // Start reading from output pipeline stdout (feedback events)
  const outputReadDone = readEvents(
    outputProc.stdout!,
    async (event) => {
      if (outputEventHandler) {
        await outputEventHandler(event);
      }
    },
    async (error) => {
      if (verbose) {
        process.stderr.write(
          `[acpfx:bridge] output pipeline parse error: ${error.message}\n`,
        );
      }
    },
  );

  const inputDone = Promise.all([
    inputReadDone,
    waitForExit(inputProc),
  ]).then((results) => {
    if (verbose) {
      process.stderr.write(
        `[acpfx:bridge] input pipeline exited (code: ${results[1]})\n`,
      );
    }
  });

  const outputDone = Promise.all([
    outputReadDone,
    waitForExit(outputProc),
  ]).then((results) => {
    if (verbose) {
      process.stderr.write(
        `[acpfx:bridge] output pipeline exited (code: ${results[1]})\n`,
      );
    }
  });

  async function shutdown(): Promise<void> {
    // Close stdin to signal pipelines to finish
    await inputWriter.end();
    await outputWriter.end();

    // Give pipelines time to exit gracefully
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));

    await Promise.race([
      Promise.all([inputDone, outputDone]),
      timeout,
    ]);

    // Force kill if still running
    if (inputProc.exitCode === null) {
      inputProc.kill("SIGTERM");
    }
    if (outputProc.exitCode === null) {
      outputProc.kill("SIGTERM");
    }
  }

  return {
    writeToInput: (event) => inputWriter.write(event),
    writeToOutput: (event) => outputWriter.write(event),
    onInputEvent: (handler) => {
      inputEventHandler = handler;
    },
    onOutputEvent: (handler) => {
      outputEventHandler = handler;
    },
    shutdown,
    inputDone,
    outputDone,
  };
}
