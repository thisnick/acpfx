#!/usr/bin/env bash
# Integration test: pack each node package, install the tarball in isolation,
# and verify --acpfx-manifest outputs valid JSON with expected fields.
#
# This tests the PUBLISHED artifact, not the local source.
#
# Usage: ./tests/npm-pack-test.sh
# Requires: pnpm, node, python3

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0

# TS node packages (use pnpm pack → npm install → run bin)
TS_NODES=(
  stt-deepgram
  stt-elevenlabs
  tts-deepgram
  tts-elevenlabs
  bridge-acpx
  audio-player
  recorder
  mic-file
  play-file
  echo
)

test_ts_package() {
  local name="$1"
  local pkg_dir="$ROOT/packages/node-$name"
  echo -n "TEST: @acpfx/$name --acpfx-manifest ... "

  if [ ! -d "$pkg_dir" ]; then
    echo "SKIP (package dir not found)"
    return
  fi

  tmp=$(mktemp -d)
  trap "rm -rf $tmp" RETURN

  # Pack with pnpm (resolves workspace: protocol)
  cd "$pkg_dir"
  pnpm pack --pack-destination "$tmp" >/dev/null 2>&1

  # Install in isolation
  cd "$tmp"
  echo '{"name":"test","type":"module","dependencies":{}}' > package.json
  npm install acpfx-*.tgz --silent 2>/dev/null

  # Run via bin link
  local bin_name="acpfx-$name"
  if [ ! -f "node_modules/.bin/$bin_name" ]; then
    echo "FAIL (bin '$bin_name' not found in node_modules/.bin/)"
    FAIL=$((FAIL + 1))
    cd "$ROOT"
    return
  fi

  local output
  output=$(node "node_modules/.bin/$bin_name" --acpfx-manifest 2>/dev/null || true)

  # Validate JSON with required fields
  if echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'name' in d, 'missing name'
assert 'consumes' in d, 'missing consumes'
assert 'emits' in d, 'missing emits'
" 2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "  output: ${output:0:200}"
    FAIL=$((FAIL + 1))
  fi

  cd "$ROOT"
}

echo "=== npm pack Integration Tests ==="
echo ""

# Build all TS packages first (prepack needs workspace deps)
echo "Building TS packages..."
pnpm -r --filter './packages/node-*' run --if-present build >/dev/null 2>&1
echo ""

for name in "${TS_NODES[@]}"; do
  test_ts_package "$name"
done

# Test native binary (mic-speaker) — just test the local binary directly
echo -n "TEST: mic-speaker --acpfx-manifest ... "
if [ -x "$ROOT/target/debug/mic-speaker" ]; then
  output=$("$ROOT/target/debug/mic-speaker" --acpfx-manifest 2>/dev/null || true)
  if echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['name'] == 'mic-speaker'
assert 'arguments' in d
" 2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "  output: ${output:0:200}"
    FAIL=$((FAIL + 1))
  fi
else
  echo "SKIP (binary not built)"
fi

# Test tts-pocket native binary
echo -n "TEST: tts-pocket --acpfx-manifest ... "
if [ -x "$ROOT/target/debug/tts-pocket" ]; then
  output=$("$ROOT/target/debug/tts-pocket" --acpfx-manifest 2>/dev/null || true)
  if echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['name'] == 'tts-pocket'
" 2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "  output: ${output:0:200}"
    FAIL=$((FAIL + 1))
  fi
else
  echo "SKIP (binary not built)"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
