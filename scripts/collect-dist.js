#!/usr/bin/env node

/**
 * Collects built artifacts from each package into the root dist/ directory.
 *
 * dist/
 *   orchestrator.js    — from packages/orchestrator/dist/main.js
 *   nodes/
 *     mic-sox.js       — from packages/node-mic-sox/dist/index.js
 *     ...
 */

import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const nodesDist = join(dist, "nodes");

mkdirSync(nodesDist, { recursive: true });

// Orchestrator
const orchSrc = join(root, "packages", "orchestrator", "dist", "main.js");
if (existsSync(orchSrc)) {
  cpSync(orchSrc, join(dist, "orchestrator.js"));
}

// Node packages: packages/node-<name>/dist/index.js -> dist/nodes/<name>.js
const nodePackages = [
  "mic-sox",
  "stt-deepgram",
  "stt-elevenlabs",
  "tts-deepgram",
  "tts-elevenlabs",
  "bridge-acpx",
  "audio-player",
  "play-sox",
  "recorder",
  "ui-cli",
  "mic-file",
  "play-file",
  "echo",
];

for (const name of nodePackages) {
  const src = join(root, "packages", `node-${name}`, "dist", "index.js");
  if (existsSync(src)) {
    cpSync(src, join(nodesDist, `${name}.js`));
  }
}

// Native binary (if built)
const aecBin = join(root, "packages", "node-aec-speex", "bin", "aec-speex");
if (existsSync(aecBin)) {
  cpSync(aecBin, join(nodesDist, "aec-speex"));
}

console.log("dist/ collected successfully");
