/**
 * Manifest utilities for acpfx nodes.
 *
 * Call `handleManifestFlag()` at the top of your node's entry point.
 * If `--manifest` is in argv, it prints the manifest as JSON and exits.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface NodeManifest {
  name: string;
  description?: string;
  consumes: string[];
  emits: string[];
}

/**
 * If `--manifest` is in process.argv, read the co-located manifest.json,
 * print it to stdout, and exit(0).
 *
 * Resolution order:
 * 1. Explicit `manifestPath` if provided
 * 2. `<script-base>.manifest.json` (bundled: dist/nodes/foo.js -> foo.manifest.json)
 * 3. `manifest.json` in the script's directory
 */
export function handleManifestFlag(manifestPath?: string): void {
  if (!process.argv.includes("--manifest")) return;

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
    // Already JSON — just write it out
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
