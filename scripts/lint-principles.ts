/**
 * Lint script: detect violations of acpfx design principles.
 *
 * Checks:
 * 1. No hardcoded node names in node source code
 * 2. No cross-node imports (nodes must not import from other nodes)
 * 3. No string literal _from checks against hardcoded names
 *    (should use settings or ACPFX_NODE_NAME)
 * 4. No direct process.stderr.write in nodes (should emit log events) [future]
 *
 * Run: npx tsx scripts/lint-principles.ts
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const NODES_DIR = join(ROOT, "packages");

type Violation = {
  file: string;
  line: number;
  rule: string;
  text: string;
};

const violations: Violation[] = [];

// ---- Rules ----

/**
 * Rule 1: No hardcoded node names in node packages.
 *
 * Node code should not reference specific pipeline node names like "bridge",
 * "stt", "player", etc. as string literals used for routing/identification.
 *
 * Exceptions:
 *   - component name in lifecycle.ready/done (e.g., component: "stt-deepgram")
 *     is the package name, not a pipeline node name
 *   - Log prefix strings like "[stt-deepgram]" are fine
 *   - Settings defaults like `speechSource ?? "tts"` are fine (they're defaults,
 *     not hardcoded assumptions about the pipeline)
 */
const HARDCODED_NAME_PATTERNS = [
  // Checking _from against a literal node name (not from settings/env)
  // e.g., _from === "bridge" or _from !== "mic"
  /(?:_from\s*[!=]==?\s*["'](?!process\.env))(mic|stt|bridge|tts|player|aec|recorder|ui)\b/,
  // Sending to a specific node by name (e.g., sendToNode("bridge", ...))
  /sendToNode\s*\(\s*["'](mic|stt|bridge|tts|player|aec|recorder|ui)["']/,
];

/**
 * Rule 2: No cross-node imports.
 * A node package must not import from another node package.
 */
const CROSS_NODE_IMPORT = /from\s+["']@acpfx\/(?!core|orchestrator|node-sdk)/;

/**
 * Rule 3: Hardcoded _from checks should use settings.
 * The pattern `_from === "..."` with a literal should use
 * ACPFX_NODE_NAME or a setting, not a hardcoded name.
 *
 * ALLOWED: event._from !== NODE_NAME (self-identification via env var)
 * ALLOWED: from !== SPEECH_SOURCE (from settings)
 * DISALLOWED: event._from === "bridge" (hardcoded name)
 */
const HARDCODED_FROM_CHECK =
  /(?:event\.|e\.|\b)_from\s*[!=]==?\s*["'](?!$)/;

// Allowlist: _from checks that use variables (not string literals)
const FROM_CHECK_ALLOWLIST = [
  /NODE_NAME/,
  /SPEECH_SOURCE/,
  /process\.env/,
  /settings\./,
];

// ---- File collection ----

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "node_modules" || entry === "dist" || entry === "target") continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...collectTsFiles(full));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  } catch {
    // ignore permission errors
  }
  return files;
}

function isNodePackage(filePath: string): boolean {
  const rel = relative(NODES_DIR, filePath);
  return rel.startsWith("node-") && !rel.startsWith("node_modules");
}

// ---- Linting ----

function lintFile(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = relative(ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    // Rule 1: Hardcoded node names (only in node packages)
    if (isNodePackage(filePath)) {
      for (const pattern of HARDCODED_NAME_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: "hardcoded-node-name",
            text: trimmed,
          });
        }
      }
    }

    // Rule 2: Cross-node imports (only in node packages)
    if (isNodePackage(filePath) && CROSS_NODE_IMPORT.test(line)) {
      // Allow imports from @acpfx/core and @acpfx/node-sdk
      violations.push({
        file: relPath,
        line: lineNum,
        rule: "cross-node-import",
        text: trimmed,
      });
    }

    // Rule 3: Hardcoded _from checks (only in node packages)
    if (isNodePackage(filePath) && HARDCODED_FROM_CHECK.test(line)) {
      // Check if any allowlisted pattern is on the same line
      const allowed = FROM_CHECK_ALLOWLIST.some((p) => p.test(line));
      if (!allowed) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: "hardcoded-from-check",
          text: trimmed,
        });
      }
    }
  }
}

// ---- Main ----

const nodePackageDirs = readdirSync(NODES_DIR)
  .filter((d) => d.startsWith("node-"))
  .map((d) => join(NODES_DIR, d));

let totalFiles = 0;

for (const dir of nodePackageDirs) {
  const files = collectTsFiles(join(dir, "src"));
  for (const file of files) {
    lintFile(file);
    totalFiles++;
  }
}

// Also lint Rust node source files
for (const dir of nodePackageDirs) {
  const mainRs = join(dir, "src", "main.rs");
  try {
    const content = readFileSync(mainRs, "utf-8");
    const lines = content.split("\n");
    const relPath = relative(ROOT, mainRs);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//")) continue;

      // Check for hardcoded _from checks in Rust
      if (/["']_from["']\s*==\s*["'](?:mic|stt|bridge|tts|player|aec|recorder|ui)["']/.test(line)) {
        violations.push({
          file: relPath,
          line: i + 1,
          rule: "hardcoded-from-check",
          text: line.trim(),
        });
      }
    }
    totalFiles++;
  } catch {
    // No main.rs in this package
  }
}

// ---- Report ----

console.log(`\nLint: checked ${totalFiles} source files across ${nodePackageDirs.length} node packages\n`);

if (violations.length === 0) {
  console.log("No violations found.\n");
  process.exit(0);
} else {
  console.log(`Found ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line} [${v.rule}]`);
    console.log(`    ${v.text}\n`);
  }
  process.exit(1);
}
