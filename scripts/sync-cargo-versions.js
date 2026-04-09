#!/usr/bin/env node
/**
 * Sync package.json versions → Cargo.toml for packages that have both.
 *
 * Run after `changeset version` to keep Cargo.toml in sync:
 *   changeset version && node scripts/sync-cargo-versions.js
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, "..", "packages");

let changed = 0;

for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;

  const pkgJsonPath = join(packagesDir, dir.name, "package.json");
  const cargoTomlPath = join(packagesDir, dir.name, "Cargo.toml");

  if (!existsSync(pkgJsonPath) || !existsSync(cargoTomlPath)) continue;

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const version = pkgJson.version;
  if (!version) continue;

  let cargoToml = readFileSync(cargoTomlPath, "utf8");
  const versionRegex = /^(version\s*=\s*")([^"]+)(")/m;
  const match = cargoToml.match(versionRegex);

  if (!match) {
    console.warn(`  WARN: no version field found in ${dir.name}/Cargo.toml`);
    continue;
  }

  if (match[2] === version) continue;

  cargoToml = cargoToml.replace(versionRegex, `$1${version}$3`);
  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`  ${dir.name}/Cargo.toml: ${match[2]} → ${version}`);
  changed++;
}

if (changed === 0) {
  console.log("  All Cargo.toml versions already in sync.");
} else {
  console.log(`  Updated ${changed} Cargo.toml file(s).`);
}
