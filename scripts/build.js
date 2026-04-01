#!/usr/bin/env node

/**
 * Build all packages using esbuild.
 * Bundles all npm dependencies into each output file.
 * Only node builtins and native addons (speaker) are external.
 */

import { buildSync } from "esbuild";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
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
const nativeExternal = ["speaker", "yaml"];

const commonOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  external: nativeExternal,
  logLevel: "info",
};

// --- Node packages ---
const nodePackages = [
  { name: "mic-sox", external: [] },
  { name: "stt-deepgram", external: [] },
  { name: "stt-elevenlabs", external: [] },
  { name: "tts-deepgram", external: [] },
  { name: "tts-elevenlabs", external: [] },
  { name: "bridge-acpx", external: [] },
  { name: "audio-player", external: ["speaker"] },
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

// Copy manifests for native binary nodes
copyManifest(join(root, "packages/node-mic-aec/manifest.yaml"), join(nodesDist, "mic-aec"));

console.log("\nBuild complete!");
