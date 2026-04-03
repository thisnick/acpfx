/**
 * Manifest utilities and acpfx flag handling for nodes.
 *
 * Call `handleAcpfxFlags()` at the top of your node's entry point.
 * It handles all `--acpfx-*` convention flags:
 *   --acpfx-manifest       Print manifest JSON and exit
 *   --acpfx-setup-check    Print {"needed": false} and exit (TS nodes don't need setup)
 *   --acpfx-*  (unknown)   Print {"unsupported": true, "flag": "..."} and exit
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { NodeManifest } from "./generated-manifest.js";

// Re-export the generated manifest types as the canonical definitions.
export type {
  NodeManifest,
  ManifestArgument,
  ManifestEnvField,
  ArgumentType,
} from "./generated-manifest.js";

// Re-export the generated Zod schemas.
export {
  NodeManifestSchema,
  ManifestArgumentSchema,
  ManifestEnvFieldSchema,
  ArgumentTypeSchema,
} from "./generated-manifest.js";

// Re-export acpfx flag protocol types.
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

/**
 * Handle all `--acpfx-*` convention flags.
 *
 * Must be called at the top of every node's entry point (before any async work).
 * Handles:
 *   --acpfx-manifest       Read co-located manifest.json, print to stdout, exit(0)
 *   --acpfx-setup-check    Print {"needed": false} and exit(0) (TS nodes don't need setup)
 *   --acpfx-*  (unknown)   Print {"unsupported": true, "flag": "..."} and exit(0)
 *
 * Also supports legacy `--manifest` for backward compatibility.
 */
export function handleAcpfxFlags(manifestPath?: string): void {
  // Find any --acpfx-* flag
  const acpfxFlag = process.argv.find((a) => a.startsWith("--acpfx-"));

  // Legacy support: --manifest (without prefix)
  const legacyManifest = process.argv.includes("--manifest");

  if (!acpfxFlag && !legacyManifest) return;

  const flag = acpfxFlag ?? "--acpfx-manifest";

  switch (flag) {
    case "--acpfx-manifest":
      printManifest(manifestPath);
      break;

    case "--acpfx-setup-check":
      // TS nodes don't need setup (no model downloads)
      process.stdout.write(JSON.stringify({ needed: false }) + "\n");
      process.exit(0);
      break;

    default:
      // Unrecognized --acpfx-* flag → forward compatibility response
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
 *
 * Resolution order:
 * 1. Explicit `manifestPath` if provided
 * 2. `<script-base>.manifest.json` (bundled: dist/nodes/foo.js -> foo.manifest.json)
 * 3. `manifest.json` in the script's directory
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
