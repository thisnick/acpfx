/**
 * Compliance tests for npm platform package distribution.
 *
 * Verifies the esbuild-style binary distribution pattern:
 * - Wrapper packages (@acpfx/cli, @acpfx/mic-speaker) with optionalDependencies
 * - Platform packages with correct os/cpu fields
 * - bin.js shims that resolve the correct binary for the current platform
 * - Windows .exe handling
 * - Consistent structure across both binaries (acpfx + mic-speaker)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// When built to dist/tests/, dirname is dist/tests — need to go up 2 levels
const ROOT = existsSync(resolve(import.meta.dirname, "../npm"))
  ? resolve(import.meta.dirname, "..")
  : resolve(import.meta.dirname, "../..");

const PLATFORMS = [
  { dir: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { dir: "darwin-x64", os: "darwin", cpu: "x64" },
  { dir: "linux-arm64", os: "linux", cpu: "arm64" },
  { dir: "linux-x64", os: "linux", cpu: "x64" },
  { dir: "win32-arm64", os: "win32", cpu: "arm64" },
  { dir: "win32-x64", os: "win32", cpu: "x64" },
] as const;

const BINARIES = [
  {
    name: "acpfx",
    wrapperPkg: "@acpfx/cli",
    platformPrefix: "@acpfx/acpfx",
    npmDir: "npm/acpfx",
    binaryName: "acpfx",
  },
  {
    name: "mic-speaker",
    wrapperPkg: "@acpfx/mic-speaker",
    platformPrefix: "@acpfx/mic-speaker",
    npmDir: "npm/mic-speaker",
    binaryName: "mic-speaker",
  },
] as const;

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

for (const bin of BINARIES) {
  describe(`${bin.name} npm packages`, () => {
    describe("wrapper package", () => {
      const wrapperDir = resolve(ROOT, bin.npmDir);
      const wrapperPkg = readJson(join(wrapperDir, "package.json"));

      it("has correct package name", () => {
        assert.equal(wrapperPkg.name, bin.wrapperPkg);
      });

      it("declares bin entry", () => {
        assert.ok(wrapperPkg.bin, "wrapper package must have a bin field");
        const binEntries = Object.values(wrapperPkg.bin) as string[];
        assert.ok(binEntries.length > 0, "bin must have at least one entry");
      });

      it("has all 6 platform optionalDependencies", () => {
        const deps = Object.keys(wrapperPkg.optionalDependencies || {});
        assert.equal(deps.length, 6, `expected 6 optionalDependencies, got ${deps.length}`);
        for (const plat of PLATFORMS) {
          const expectedPkg = `${bin.platformPrefix}-${plat.dir}`;
          assert.ok(
            deps.includes(expectedPkg),
            `missing optionalDependency: ${expectedPkg}`
          );
        }
      });

      it("optionalDependency versions match wrapper version", () => {
        const version = wrapperPkg.version;
        for (const [dep, depVersion] of Object.entries(wrapperPkg.optionalDependencies || {})) {
          assert.equal(depVersion, version, `${dep} version ${depVersion} != wrapper version ${version}`);
        }
      });

      it("bin shim file exists", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        assert.ok(existsSync(binPath), `bin shim not found: ${binPath}`);
      });

      it("bin shim has correct shebang", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        assert.ok(content.startsWith("#!/usr/bin/env node"), "bin shim must start with node shebang");
      });

      it("bin shim uses a consistent child_process method", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        assert.match(
          content,
          /require\("child_process"\)/,
          "must require child_process"
        );
        // Must import and actually call the same function (spawnSync or execFileSync)
        const importsSpawn = content.includes("spawnSync");
        const importsExec = content.includes("execFileSync");
        assert.ok(
          importsSpawn || importsExec,
          "bin shim must import spawnSync or execFileSync"
        );
        // The function used must be the one imported — no undefined references
        if (importsSpawn) {
          assert.ok(
            content.includes("{ spawnSync }") || content.includes("{spawnSync}"),
            "spawnSync must be destructured from require"
          );
        }
        if (importsExec) {
          assert.ok(
            content.includes("{ execFileSync }") || content.includes("{execFileSync}"),
            "execFileSync must be destructured from require"
          );
        }
      });

      it("bin shim maps all 6 platforms", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        for (const plat of PLATFORMS) {
          const key = `${plat.os} ${plat.cpu}`;
          assert.ok(
            content.includes(`"${key}"`),
            `bin shim missing platform key: "${key}"`
          );
        }
      });

      it("bin shim handles Windows .exe extension", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        assert.ok(
          content.includes('.exe') && content.includes('win32'),
          "bin shim must handle .exe for win32"
        );
      });

      it("bin shim has unsupported platform error", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        assert.ok(
          content.includes("Unsupported platform"),
          "bin shim must throw for unsupported platforms"
        );
      });

      it("bin shim propagates exit code", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        assert.ok(
          content.includes("process.exitCode") || content.includes("process.exit("),
          "bin shim must propagate the child process exit code"
        );
      });

      it("bin shim has missing package error with reinstall hint", () => {
        const binPath = join(wrapperDir, "bin", bin.binaryName);
        const content = readFileSync(binPath, "utf-8");
        assert.ok(
          content.includes("Could not find the binary package"),
          "bin shim must have helpful error for missing platform package"
        );
        assert.ok(
          content.includes("npm install"),
          "error message should suggest reinstalling"
        );
      });
    });

    describe("platform packages", () => {
      for (const plat of PLATFORMS) {
        describe(`${plat.dir}`, () => {
          const platDir = resolve(ROOT, bin.npmDir, plat.dir);
          const expectedName = `${bin.platformPrefix}-${plat.dir}`;
          const isWindows = plat.os === "win32";

          it("package.json exists", () => {
            assert.ok(existsSync(join(platDir, "package.json")), `missing: ${platDir}/package.json`);
          });

          it("has correct package name", () => {
            const pkg = readJson(join(platDir, "package.json"));
            assert.equal(pkg.name, expectedName);
          });

          it("has correct os field", () => {
            const pkg = readJson(join(platDir, "package.json"));
            assert.deepEqual(pkg.os, [plat.os]);
          });

          it("has correct cpu field", () => {
            const pkg = readJson(join(platDir, "package.json"));
            assert.deepEqual(pkg.cpu, [plat.cpu]);
          });

          it("has preferUnplugged for Yarn PnP", () => {
            const pkg = readJson(join(platDir, "package.json"));
            assert.equal(pkg.preferUnplugged, true);
          });

          it("files array references correct binary name", () => {
            const pkg = readJson(join(platDir, "package.json"));
            const expectedBin = isWindows ? `bin/${bin.binaryName}.exe` : `bin/${bin.binaryName}`;
            assert.ok(
              pkg.files?.includes(expectedBin),
              `files should include "${expectedBin}", got ${JSON.stringify(pkg.files)}`
            );
          });

          it("bin/ directory exists (placeholder for CI-built binary)", () => {
            assert.ok(
              existsSync(join(platDir, "bin")),
              `bin/ directory should exist in ${platDir}`
            );
          });
        });
      }
    });
  });
}

describe("CI workflow", () => {
  const ciPath = resolve(ROOT, ".github/workflows/ci.yml");

  it("ci.yml exists", () => {
    assert.ok(existsSync(ciPath), "CI workflow file must exist");
  });

  it("is valid YAML", () => {
    const content = readFileSync(ciPath, "utf-8");
    assert.ok(content.includes("name: CI"), "must have workflow name");
    assert.ok(content.includes("on:"), "must have trigger config");
    assert.ok(content.includes("jobs:"), "must have jobs");
  });

  it("runs on ubuntu", () => {
    const content = readFileSync(ciPath, "utf-8");
    assert.ok(content.includes("ubuntu-latest"), "must run on ubuntu");
  });

  it("includes Rust build and test", () => {
    const content = readFileSync(ciPath, "utf-8");
    assert.ok(content.includes("cargo"), "must invoke cargo");
    assert.ok(content.includes("cargo test"), "must run Rust tests");
  });

  it("includes TypeScript build", () => {
    const content = readFileSync(ciPath, "utf-8");
    assert.ok(content.includes("pnpm install") || content.includes("pnpm build"), "must build TS packages");
  });

  it("installs libpulse-dev on Linux for sys-voice", () => {
    const content = readFileSync(ciPath, "utf-8");
    assert.ok(content.includes("libpulse-dev"), "must install libpulse-dev for sys-voice on Linux");
  });

  it("builds orchestrator for all 6 targets", () => {
    const content = readFileSync(ciPath, "utf-8");
    const targets = [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "aarch64-pc-windows-msvc",
      "x86_64-pc-windows-msvc",
    ];
    for (const target of targets) {
      assert.ok(content.includes(target), `CI must build orchestrator for ${target}`);
    }
  });
});

describe("Release workflow", () => {
  const releasePath = resolve(ROOT, ".github/workflows/release.yml");

  it("release.yml exists", () => {
    assert.ok(existsSync(releasePath), "Release workflow file must exist");
  });

  it("triggers on version tags", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(content.includes('tags:') && content.includes('"v*"'), "must trigger on v* tags");
  });

  it("builds for all supported Rust targets", () => {
    const content = readFileSync(releasePath, "utf-8");
    const requiredTargets = [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-pc-windows-msvc",
    ];
    for (const target of requiredTargets) {
      assert.ok(
        content.includes(target),
        `release workflow must build for ${target}`
      );
    }
  });

  it("packages both acpfx and mic-speaker binaries", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(content.includes("acpfx"), "must package acpfx binary");
    assert.ok(content.includes("mic-speaker"), "must package mic-speaker binary");
  });

  it("does not reference deleted aec-speex binary", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(
      !content.includes("aec-speex"),
      "release workflow must not reference deleted aec-speex binary"
    );
  });

  it("handles Windows .exe extension", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(content.includes(".exe"), "must handle .exe for Windows builds");
  });

  it("has npm publish job", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(content.includes("npm publish"), "release must publish to npm");
  });

  it("publishes platform packages before wrappers", () => {
    const content = readFileSync(releasePath, "utf-8");
    // Platform packages should be published before wrapper packages
    const platformPublishIdx = content.indexOf("Publish orchestrator platform packages");
    const wrapperPublishIdx = content.indexOf("Publish @acpfx/cli wrapper");
    assert.ok(platformPublishIdx > 0, "must publish platform packages");
    assert.ok(wrapperPublishIdx > 0, "must publish wrapper package");
    assert.ok(
      platformPublishIdx < wrapperPublishIdx,
      "platform packages must be published before wrapper"
    );
  });

  it("stamps version from git tag", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(
      content.includes("GITHUB_REF_NAME"),
      "must extract version from git tag"
    );
  });

  it("uses NPM_TOKEN secret", () => {
    const content = readFileSync(releasePath, "utf-8");
    assert.ok(
      content.includes("NPM_TOKEN"),
      "must use NPM_TOKEN secret for publishing"
    );
  });
});
