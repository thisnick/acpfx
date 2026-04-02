# acpfx

## 0.2.6

### Patch Changes

- ea30448: Skip binary builds when package version unchanged — only build orchestrator if @acpfx/cli was published, only build mic-aec if @acpfx/mic-aec was published

## 0.2.5

### Patch Changes

- baf94bd: Upgrade GitHub Actions to Node.js 24 compatible versions

## 0.2.4

### Patch Changes

- 6e742d2: Fix binary downloads: split GitHub Releases so each package has its own binaries, fix postinstall URL encoding

## 0.2.3

### Patch Changes

- 65d0337: Use native GitHub runners for all 6 platforms (no cross-compilation)

## 0.2.2

### Patch Changes

- 5412c87: Rename orchestrator package to @acpfx/cli (npm rejected 'acpfx' as too similar to 'cpx').
  Fix darwin-x64 builds: use macos-14 runner (macos-13 retired).
  Switch to postinstall binary download pattern (no more platform npm packages).

## 0.2.1

### Patch Changes

- 5332dd2: Fix darwin-x64 binary builds: macos-13 runner retired, use macos-14 with cross-compilation
