"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SUPPORTED_PLATFORMS = {
  "darwin arm64": "acpfx-darwin-arm64",
  "darwin x64": "acpfx-darwin-x64",
  "linux arm64": "acpfx-linux-arm64",
  "linux x64": "acpfx-linux-x64",
  "win32 arm64": "acpfx-win32-arm64.exe",
  "win32 x64": "acpfx-win32-x64.exe",
};

function getBinaryName() {
  const key = `${process.platform} ${process.arch}`;
  const name = SUPPORTED_PLATFORMS[key];
  if (!name) {
    throw new Error(
      `Unsupported platform: ${process.platform} ${process.arch}.\n` +
        `Supported: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`
    );
  }
  return name;
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: { "User-Agent": "acpfx-postinstall" } }, (res) => {
        // Follow redirects (GitHub releases redirect to S3)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  const pkg = require("../package.json");
  const version = pkg.version;
  const binaryName = getBinaryName();
  const binDir = path.join(__dirname, "..", "bin");
  const destPath = path.join(binDir, binaryName);

  // Skip if binary already exists (e.g. local dev with pre-built binary)
  if (fs.existsSync(destPath)) {
    console.log(`acpfx: binary already exists at ${destPath}, skipping download.`);
    return;
  }

  const url = `https://github.com/thisnick/acpfx/releases/download/%40acpfx%2Fcli%40${version}/${binaryName}`;
  console.log(`acpfx: downloading ${binaryName} from GitHub Releases...`);
  console.log(`  ${url}`);

  const data = await fetch(url);

  // Ensure bin/ directory exists
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(destPath, data);
  fs.chmodSync(destPath, 0o755);

  console.log(`acpfx: installed ${binaryName} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.warn(`acpfx: postinstall failed — ${err.message}`);
  console.warn(
    "acpfx: the native binary could not be downloaded. " +
      "You can set ACPFX_BINARY_PATH to a local build."
  );
  // Don't exit with error — allow npm install to succeed
  // The bin shim will show a helpful error at runtime
});
