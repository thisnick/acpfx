"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SUPPORTED_PLATFORMS = {
  "darwin arm64": "bridge-acp-darwin-arm64",
  "darwin x64": "bridge-acp-darwin-x64",
  "linux arm64": "bridge-acp-linux-arm64",
  "linux x64": "bridge-acp-linux-x64",
  "win32 arm64": "bridge-acp-win32-arm64.exe",
  "win32 x64": "bridge-acp-win32-x64.exe",
};

function getBinaryName() {
  const key = `${process.platform} ${process.arch}`;
  const base = SUPPORTED_PLATFORMS[key];
  if (!base) {
    throw new Error(
      `Unsupported platform: ${process.platform} ${process.arch}.\n` +
        `Supported: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`
    );
  }
  return base;
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: { "User-Agent": "bridge-acp-postinstall" } }, (res) => {
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

  if (fs.existsSync(destPath)) {
    console.log(`bridge-acp: binary already exists at ${destPath}, skipping download.`);
    return;
  }

  const url = `https://github.com/thisnick/acpfx/releases/download/%40acpfx/bridge-acp%40${version}/${binaryName}`;
  console.log(`bridge-acp: downloading ${binaryName} from GitHub Releases...`);
  console.log(`  ${url}`);

  const data = await fetch(url);

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(destPath, data);
  fs.chmodSync(destPath, 0o755);

  console.log(`bridge-acp: installed ${binaryName} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.warn(`bridge-acp: postinstall failed — ${err.message}`);
  console.warn(
    "bridge-acp: the native binary could not be downloaded. " +
      "You can build locally with: cargo build --release -p bridge-acp"
  );
});
