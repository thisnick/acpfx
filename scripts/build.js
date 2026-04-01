#!/usr/bin/env node

/**
 * Build all packages using esbuild.
 * Bundles all npm dependencies into each output file.
 * Only node builtins and native addons (speaker) are external.
 */

import { buildSync } from "esbuild";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const nodesDist = join(dist, "nodes");

mkdirSync(nodesDist, { recursive: true });

// Native addons that can't be bundled
const nativeExternal = ["speaker"];

const commonOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  external: nativeExternal,
  logLevel: "info",
};

// --- Orchestrator ---
// commander is CJS and can't be bundled into ESM — keep it external
buildSync({
  ...commonOptions,
  entryPoints: [join(root, "packages/orchestrator/src/main.ts")],
  outfile: join(dist, "orchestrator.js"),
  external: [...nativeExternal, "commander", "yaml"],
});

// --- Node packages ---
const nodePackages = [
  { name: "mic-sox", external: [] },
  { name: "stt-deepgram", external: [] },
  { name: "stt-elevenlabs", external: [] },
  { name: "tts-deepgram", external: [] },
  { name: "tts-elevenlabs", external: [] },
  { name: "bridge-acpx", external: [] },
  { name: "audio-player", external: ["speaker"] },
  { name: "play-sox", external: ["speaker"] },
  { name: "recorder", external: [] },
  { name: "ui-cli", external: ["ink", "react", "react/jsx-runtime"], jsx: "automatic" },
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
}

// Native binary — prefer target/release (most recent), fall back to bin/
const aecRelease = join(root, "packages/node-aec-speex/target/release/aec-speex");
const aecBin = join(root, "packages/node-aec-speex/bin/aec-speex");
const aecSrc = existsSync(aecRelease) ? aecRelease : existsSync(aecBin) ? aecBin : null;
if (aecSrc) {
  cpSync(aecSrc, join(nodesDist, "aec-speex"));
  // Keep bin/ in sync for npx
  if (aecSrc !== aecBin) {
    mkdirSync(dirname(aecBin), { recursive: true });
    cpSync(aecSrc, aecBin);
  }
}

console.log("\nBuild complete!");
