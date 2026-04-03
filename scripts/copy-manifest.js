#!/usr/bin/env node
/**
 * Copies manifest.yaml → dist/manifest.json (YAML → JSON).
 * Run from a node package directory after esbuild.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

if (!existsSync("manifest.yaml")) {
  process.exit(0); // No manifest, skip silently
}
mkdirSync("dist", { recursive: true });
const yaml = readFileSync("manifest.yaml", "utf8");
const manifest = parseYaml(yaml);
writeFileSync("dist/manifest.json", JSON.stringify(manifest));
