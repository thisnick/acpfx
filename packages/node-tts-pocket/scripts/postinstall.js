"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SUPPORTED_PLATFORMS = {
  "darwin arm64": "tts-pocket-darwin-arm64",
  "linux arm64": "tts-pocket-linux-arm64",
  "linux x64": "tts-pocket-linux-x64",
  "win32 arm64": "tts-pocket-win32-arm64.exe",
  "win32 x64": "tts-pocket-win32-x64.exe",
};

function hasNvidiaGpu() {
  try {
    require("child_process").execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getBinaryName() {
  const key = `${process.platform} ${process.arch}`;
  const base = SUPPORTED_PLATFORMS[key];
  if (!base) {
    throw new Error(
      `Unsupported platform: ${process.platform} ${process.arch}.\n` +
        `Supported: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`
    );
  }

  // Try CUDA variant on Linux/Windows when an NVIDIA GPU is present
  if ((process.platform === "linux" || process.platform === "win32") && hasNvidiaGpu()) {
    return base.replace(/(\.\w+)?$/, "-cuda$1");
  }
  return base;
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: { "User-Agent": "tts-pocket-postinstall" } }, (res) => {
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
    console.log(`tts-pocket: binary already exists at ${destPath}, skipping download.`);
    return;
  }

  const url = `https://github.com/thisnick/acpfx/releases/download/%40acpfx/tts-pocket%40${version}/${binaryName}`;
  console.log(`tts-pocket: downloading ${binaryName} from GitHub Releases...`);
  console.log(`  ${url}`);

  let data;
  try {
    data = await fetch(url);
  } catch (err) {
    // If CUDA variant failed, fall back to CPU binary
    const cpuName = SUPPORTED_PLATFORMS[`${process.platform} ${process.arch}`];
    if (binaryName !== cpuName) {
      console.log(`tts-pocket: CUDA binary not available, falling back to CPU variant...`);
      const cpuUrl = `https://github.com/thisnick/acpfx/releases/download/%40acpfx/tts-pocket%40${version}/${cpuName}`;
      console.log(`  ${cpuUrl}`);
      data = await fetch(cpuUrl);
    } else {
      throw err;
    }
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(destPath, data);
  fs.chmodSync(destPath, 0o755);
  console.log(`tts-pocket: installed ${binaryName} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.warn(`tts-pocket: postinstall failed — ${err.message}`);
  console.warn(
    "tts-pocket: the native binary could not be downloaded. " +
      "You can build locally with: cargo build --release -p node-tts-pocket"
  );
});
