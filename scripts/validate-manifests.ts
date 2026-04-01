#!/usr/bin/env tsx
/**
 * Validates all node manifest.yaml files against the schema's known event types.
 * Exits with code 1 if any manifest references an unknown event type.
 *
 * Usage: npx tsx scripts/validate-manifests.ts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const packagesDir = join(root, "packages");

// Known event types from the schema (must match categories.rs ALL_EVENT_TYPES)
const KNOWN_EVENT_TYPES = new Set([
  "audio.chunk",
  "audio.level",
  "speech.partial",
  "speech.delta",
  "speech.final",
  "speech.pause",
  "agent.submit",
  "agent.delta",
  "agent.complete",
  "agent.thinking",
  "agent.tool_start",
  "agent.tool_done",
  "control.interrupt",
  "control.state",
  "control.error",
  "lifecycle.ready",
  "lifecycle.done",
  "log",
  "player.status",
]);

let errors = 0;
let manifests = 0;

const dirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("node-"));

for (const dir of dirs) {
  const manifestPath = join(packagesDir, dir.name, "manifest.yaml");
  if (!existsSync(manifestPath)) {
    console.warn(`WARN: ${dir.name} has no manifest.yaml`);
    continue;
  }

  manifests++;
  const content = readFileSync(manifestPath, "utf8");
  const manifest = parseYaml(content);

  if (!manifest.name) {
    console.error(`ERROR: ${dir.name}/manifest.yaml missing 'name' field`);
    errors++;
  }

  for (const field of ["consumes", "emits"] as const) {
    const types: string[] = manifest[field] ?? [];
    if (!Array.isArray(types)) {
      console.error(`ERROR: ${dir.name}/manifest.yaml '${field}' is not an array`);
      errors++;
      continue;
    }
    for (const t of types) {
      if (!KNOWN_EVENT_TYPES.has(t)) {
        console.error(
          `ERROR: ${dir.name}/manifest.yaml ${field} references unknown event type '${t}'`
        );
        errors++;
      }
    }
  }
}

console.log(`\nValidated ${manifests} manifests.`);
if (errors > 0) {
  console.error(`${errors} error(s) found.`);
  process.exit(1);
} else {
  console.log("All manifests valid.");
}
