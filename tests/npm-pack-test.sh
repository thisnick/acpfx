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

# Auto-discover TS node packages (have src/index.ts + manifest.yaml)
TS_NODES=()
for d in "$ROOT"/packages/node-*/; do
  name=$(basename "$d" | sed 's/^node-//')
  [ -f "$d/src/index.ts" ] && [ -f "$d/manifest.yaml" ] && TS_NODES+=("$name")
done

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

# Auto-discover native Rust nodes (have Cargo.toml)
for d in "$ROOT"/packages/node-*/; do
  name=$(basename "$d" | sed 's/^node-//')
  [ -f "$d/Cargo.toml" ] || continue

  echo -n "TEST: $name --acpfx-manifest (native) ... "
  bin="$ROOT/target/debug/$name"
  if [ -x "$bin" ]; then
    output=$("$bin" --acpfx-manifest 2>/dev/null || true)
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
  else
    echo "SKIP (binary not built)"
  fi
done

# Auto-discover Python nodes (have bin/ wrapper + src/*.py, no Cargo.toml, no src/index.ts)
for d in "$ROOT"/packages/node-*/; do
  name=$(basename "$d" | sed 's/^node-//')
  [ -f "$d/Cargo.toml" ] && continue
  [ -f "$d/src/index.ts" ] && continue
  [ -d "$d/bin" ] || continue
  [ -d "$d/src" ] || continue

  # Find .py file in src/
  py_file=$(find "$d/src" -name "*.py" -maxdepth 1 | head -1)
  [ -n "$py_file" ] || continue

  echo -n "TEST: $name --acpfx-manifest (python) ... "
  if command -v uv &>/dev/null; then
    output=$(uv run --python ">=3.10" "$py_file" --acpfx-manifest 2>/dev/null || true)
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
  else
    echo "SKIP (uv not installed)"
  fi
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
