#!/usr/bin/env node
/**
 * Collect built node outputs to dist/nodes/ for local development.
 *
 * Run after `pnpm -r --filter './packages/node-*' run --if-present build`
 * which builds each TS node package to its own dist/index.js.
 *
 * This script:
 * 1. Copies TS node outputs from packages/node-<name>/dist/index.js → dist/nodes/<name>.js
 * 2. Copies manifests (YAML + JSON) alongside each output
 * 3. Copies bundled sounds for audio-player
 * 4. Copies native binaries (Rust) from cargo target/
 * 5. Copies Python node wrappers
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const nodesDist = join(dist, "nodes");
const packagesDir = join(root, "packages");

mkdirSync(nodesDist, { recursive: true });

/** Copy manifest.yaml and also write manifest.json for the --manifest flag. */
function copyManifest(yamlPath, destBase) {
  if (!existsSync(yamlPath)) return;
  cpSync(yamlPath, `${destBase}.manifest.yaml`);
  const manifest = parseYaml(readFileSync(yamlPath, "utf8"));
  writeFileSync(`${destBase}.manifest.json`, JSON.stringify(manifest));
}

// --- TS node packages: collect from per-package dist/ ---
const tsNodes = readdirSync(packagesDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith("node-"))
  .filter(d => existsSync(join(packagesDir, d.name, "dist", "index.js")))
  .map(d => d.name.replace(/^node-/, ""));

for (const name of tsNodes) {
  const src = join(packagesDir, `node-${name}`, "dist", "index.js");
  cpSync(src, join(nodesDist, `${name}.js`));
  copyManifest(
    join(packagesDir, `node-${name}`, "manifest.yaml"),
    join(nodesDist, name),
  );
}
if (tsNodes.length > 0) {
  console.log(`  Collected ${tsNodes.length} TS nodes: ${tsNodes.join(", ")}`);
}

// --- Bundled sounds for audio-player ---
const soundsSrc = join(packagesDir, "node-audio-player/sounds");
const soundsDist = join(nodesDist, "sounds");
if (existsSync(soundsSrc)) {
  mkdirSync(soundsDist, { recursive: true });
  for (const f of readdirSync(soundsSrc).filter(f => f.endsWith(".wav"))) {
    cpSync(join(soundsSrc, f), join(soundsDist, f));
  }
  console.log("  Copied bundled sounds");
}

// --- Native binary nodes (auto-discovered via Cargo.toml) ---
const nativeNodes = readdirSync(packagesDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith("node-"))
  .filter(d => existsSync(join(packagesDir, d.name, "Cargo.toml")))
  .map(d => d.name.replace(/^node-/, ""));

for (const name of nativeNodes) {
  copyManifest(join(packagesDir, `node-${name}`, "manifest.yaml"), join(nodesDist, name));

  const debugBin = join(root, "target/debug", name);
  const releaseBin = join(root, "target/release", name);
  const distBin = join(nodesDist, name);
  const srcBin = existsSync(debugBin) ? debugBin : existsSync(releaseBin) ? releaseBin : null;
  if (srcBin) {
    cpSync(srcBin, distBin);
    console.log(`  Copied native binary: ${name}`);
  } else {
    console.warn(`  WARN: native binary '${name}' not found — run 'cargo build -p ${name}' first`);
  }
}

// --- Python/shell wrapper nodes ---
const pythonNodes = readdirSync(packagesDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith("node-"))
  .filter(d => !existsSync(join(packagesDir, d.name, "Cargo.toml")))
  .filter(d => !existsSync(join(packagesDir, d.name, "src", "index.ts")))
  .filter(d => existsSync(join(packagesDir, d.name, "bin")))
  .filter(d => existsSync(join(packagesDir, d.name, "src")))
  .map(d => d.name.replace(/^node-/, ""));

for (const name of pythonNodes) {
  copyManifest(join(packagesDir, `node-${name}`, "manifest.yaml"), join(nodesDist, name));

  const pyFiles = readdirSync(join(packagesDir, `node-${name}`, "src"))
    .filter(f => f.endsWith(".py"));
  if (pyFiles.length > 0) {
    const pyEntry = pyFiles[0];
    cpSync(join(packagesDir, `node-${name}`, "src", pyEntry), join(nodesDist, pyEntry));
    const wrapper = [
      `#!/usr/bin/env bash`,
      `if ! command -v uv &>/dev/null; then`,
      `  echo '{"type":"error","message":"uv is required but not installed."}' >&1`,
      `  exit 1`,
      `fi`,
      `exec uv run --python ">=3.10" "$(cd "$(dirname "$0")" && pwd)/${pyEntry}" "$@"`,
      ``
    ].join("\n");
    writeFileSync(join(nodesDist, name), wrapper, { mode: 0o755 });
    console.log(`  Copied Python node: ${name} (${pyEntry})`);
  }
}

console.log("\nCollect complete!");
