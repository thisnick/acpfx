#!/usr/bin/env tsx
/**
 * Validates all node manifest.yaml files against:
 * 1. The generated Zod NodeManifestSchema (structural validation)
 * 2. Known event types from the schema (consumes/emits validation)
 * 3. Argument type correctness (defaults match declared types, enum values match)
 *
 * Exits with code 1 if any manifest is invalid.
 *
 * Usage: npx tsx scripts/validate-manifests.ts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { NodeManifestSchema } from "@acpfx/core";

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

const VALID_ARGUMENT_TYPES = new Set(["string", "number", "boolean"]);

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

  // 1. Zod schema validation
  const zodResult = NodeManifestSchema.safeParse(manifest);
  if (!zodResult.success) {
    for (const issue of zodResult.error.issues) {
      console.error(
        `ERROR: ${dir.name}/manifest.yaml Zod validation: ${issue.path.join(".")} — ${issue.message}`
      );
      errors++;
    }
    continue; // Skip further checks if schema fails
  }

  const parsed = zodResult.data;

  // 2. Event type validation
  for (const field of ["consumes", "emits"] as const) {
    const types: string[] = parsed[field] ?? [];
    for (const t of types) {
      if (!KNOWN_EVENT_TYPES.has(t)) {
        console.error(
          `ERROR: ${dir.name}/manifest.yaml ${field} references unknown event type '${t}'`
        );
        errors++;
      }
    }
  }

  // 3. Argument validation (defaults match types, enum values match types)
  const args = parsed.arguments ?? {};
  for (const [argName, arg] of Object.entries(args)) {
    // Validate default matches declared type
    if (arg.default !== undefined) {
      const valid = checkValueMatchesType(arg.default, arg.type);
      if (!valid) {
        console.error(
          `ERROR: ${dir.name}/manifest.yaml arguments.${argName}.default ` +
          `has value ${JSON.stringify(arg.default)} but declared type is '${arg.type}'`
        );
        errors++;
      }
    }

    // Validate enum values match declared type
    if (arg.enum) {
      for (let i = 0; i < arg.enum.length; i++) {
        const valid = checkValueMatchesType(arg.enum[i], arg.type);
        if (!valid) {
          console.error(
            `ERROR: ${dir.name}/manifest.yaml arguments.${argName}.enum[${i}] ` +
            `has value ${JSON.stringify(arg.enum[i])} but declared type is '${arg.type}'`
          );
          errors++;
        }
      }
    }

    // Validate description is present
    if (!arg.description) {
      console.warn(
        `WARN: ${dir.name}/manifest.yaml arguments.${argName} has no description`
      );
    }
  }

  // 4. Env var validation
  const env = parsed.env ?? {};
  for (const [envName, envField] of Object.entries(env)) {
    if (!envField.description) {
      console.warn(
        `WARN: ${dir.name}/manifest.yaml env.${envName} has no description`
      );
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

function checkValueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}
