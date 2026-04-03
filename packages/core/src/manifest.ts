/**
 * Manifest types, Zod schemas, and acpfx flag handling for nodes.
 *
 * Call `handleAcpfxFlags()` at the top of your node's entry point.
 * It handles all `--acpfx-*` convention flags:
 *   --acpfx-manifest       Print manifest JSON and exit
 *   --acpfx-setup-check    Print {"needed": false} and exit (TS nodes don't need setup)
 *   --acpfx-*  (unknown)   Print {"unsupported": true, "flag": "..."} and exit
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";

// ---- Manifest Types ----

export type ArgumentType = "string" | "number" | "boolean";

export interface ManifestArgument {
  type: ArgumentType;
  default?: unknown;
  description?: string;
  required?: boolean;
  enum?: unknown[];
}

export interface ManifestEnvField {
  required?: boolean;
  description?: string;
}

export interface NodeManifest {
  name: string;
  description?: string;
  consumes: string[];
  emits: string[];
  arguments?: Record<string, ManifestArgument>;
  additional_arguments?: boolean;
  env?: Record<string, ManifestEnvField>;
}

// ---- Manifest Zod Schemas ----

export const ArgumentTypeSchema = z.enum(["string", "number", "boolean"]);

export const ManifestArgumentSchema = z.object({
  type: ArgumentTypeSchema,
  default: z.unknown().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  enum: z.array(z.unknown()).optional(),
});

export const ManifestEnvFieldSchema = z.object({
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const NodeManifestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  consumes: z.array(z.string()),
  emits: z.array(z.string()),
  arguments: z.record(z.string(), ManifestArgumentSchema).optional(),
  additional_arguments: z.boolean().optional(),
  env: z.record(z.string(), ManifestEnvFieldSchema).optional(),
});

// ---- acpfx Flag Protocol Types ----

export type {
  SetupCheckResponse,
  SetupProgress,
  UnsupportedFlagResponse,
} from "./acpfx-flags.js";

export {
  SetupCheckResponseSchema,
  SetupProgressSchema,
  UnsupportedFlagResponseSchema,
} from "./acpfx-flags.js";

// ---- Flag Handling ----

/**
 * Handle all `--acpfx-*` convention flags.
 *
 * Must be called at the top of every node's entry point (before any async work).
 * Also supports legacy `--manifest` for backward compatibility.
 */
export function handleAcpfxFlags(manifestPath?: string): void {
  const acpfxFlag = process.argv.find((a) => a.startsWith("--acpfx-"));
  const legacyManifest = process.argv.includes("--manifest");

  if (!acpfxFlag && !legacyManifest) return;

  const flag = acpfxFlag ?? "--acpfx-manifest";

  switch (flag) {
    case "--acpfx-manifest":
      printManifest(manifestPath);
      break;

    case "--acpfx-setup-check":
      process.stdout.write(JSON.stringify({ needed: false }) + "\n");
      process.exit(0);
      break;

    default:
      process.stdout.write(
        JSON.stringify({ unsupported: true, flag }) + "\n"
      );
      process.exit(0);
  }
}

/**
 * @deprecated Use `handleAcpfxFlags()` instead.
 */
export function handleManifestFlag(manifestPath?: string): void {
  handleAcpfxFlags(manifestPath);
}

/**
 * Print the co-located manifest JSON to stdout and exit.
 */
function printManifest(manifestPath?: string): void {
  if (!manifestPath) {
    const script = process.argv[1];
    const scriptDir = dirname(script);
    const scriptBase = script.replace(/\.[^.]+$/, "");
    const colocated = `${scriptBase}.manifest.json`;
    try {
      readFileSync(colocated);
      manifestPath = colocated;
    } catch {
      manifestPath = join(scriptDir, "manifest.json");
    }
  }

  try {
    const content = readFileSync(manifestPath, "utf8");
    process.stdout.write(content.trim() + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Failed to read manifest: ${err}\n`);
    process.exit(1);
  }
}

/**
 * Load a manifest from a JSON file.
 */
export function loadManifestJson(path: string): NodeManifest {
  const content = readFileSync(path, "utf8");
  return JSON.parse(content) as NodeManifest;
}
