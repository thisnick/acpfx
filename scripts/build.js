#!/usr/bin/env node

/**
 * Build all packages using esbuild.
 * Bundles all npm dependencies into each output file.
 * Only node builtins and CJS packages are external.
 */

import { buildSync } from "esbuild";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const nodesDist = join(dist, "nodes");

mkdirSync(nodesDist, { recursive: true });

/** Copy manifest.yaml and also write manifest.json for the --manifest flag. */
function copyManifest(yamlPath, destBase) {
  if (!existsSync(yamlPath)) return;
  cpSync(yamlPath, `${destBase}.manifest.yaml`);
  const manifest = parseYaml(readFileSync(yamlPath, "utf8"));
  writeFileSync(`${destBase}.manifest.json`, JSON.stringify(manifest));
}

// Native addons and CJS packages that can't be bundled into ESM
const nativeExternal = ["yaml"];

const commonOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  external: nativeExternal,
  logLevel: "info",
};

// --- Node packages ---
const nodePackages = [
  { name: "stt-deepgram", external: [] },
  { name: "stt-elevenlabs", external: [] },
  { name: "tts-deepgram", external: [] },
  { name: "tts-elevenlabs", external: [] },
  { name: "bridge-acpx", external: [] },
  { name: "audio-player", external: [] },
  { name: "recorder", external: [] },
  { name: "mic-file", external: [] },
  { name: "play-file", external: [] },
  { name: "echo", external: [] },
];

for (const pkg of nodePackages) {
  const entryPoint = join(root, `packages/node-${pkg.name}/src/index.ts`);
  const opts = {
    ...commonOptions,
    entryPoints: [entryPoint],
    outfile: join(nodesDist, `${pkg.name}.js`),
    external: [...nativeExternal, ...pkg.external],
    banner: { js: "#!/usr/bin/env node" },
  };
  if (pkg.jsx) opts.jsx = pkg.jsx;
  buildSync(opts);

  // Copy manifest.yaml + generate manifest.json alongside the built artifact
  copyManifest(
    join(root, `packages/node-${pkg.name}/manifest.yaml`),
    join(nodesDist, pkg.name),
  );
}

// Copy bundled sounds for audio-player
const soundsSrc = join(root, "packages/node-audio-player/sounds");
const soundsDist = join(nodesDist, "sounds");
if (existsSync(soundsSrc)) {
  mkdirSync(soundsDist, { recursive: true });
  for (const f of readdirSync(soundsSrc).filter(f => f.endsWith(".wav"))) {
    cpSync(join(soundsSrc, f), join(soundsDist, f));
  }
  console.log("  Copied bundled sounds to dist/nodes/sounds/");
}

// --- Native binary nodes (auto-discovered via Cargo.toml in packages/node-*/) ---
const packagesDir = join(root, "packages");
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
  if (srcBin && !existsSync(distBin)) {
    cpSync(srcBin, distBin);
    console.log(`  Copied native binary: ${name}`);
  } else if (!srcBin) {
    console.warn(`  WARN: native binary '${name}' not found — run 'cargo build -p ${name}' first`);
  }
}

console.log("\nBuild complete!");
