#!/usr/bin/env node
/**
 * Build all node packages and collect outputs to dist/nodes/.
 *
 * 1. Runs each TS node package's own build script (pnpm -r)
 * 2. Collects all outputs to dist/nodes/ for local development
 */

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Step 1: Build each TS node package (creates packages/node-<name>/dist/index.js)
console.log("Building TS node packages...");
execSync("pnpm -r --filter './packages/node-*' run --if-present build", {
  cwd: root,
  stdio: "inherit",
});

// Step 2: Collect all outputs to dist/nodes/
console.log("\nCollecting to dist/nodes/...");
execSync("node scripts/collect-dist.js", {
  cwd: root,
  stdio: "inherit",
});
