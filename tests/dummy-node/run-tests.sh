#!/usr/bin/env bash
# Integration tests for orchestrator setup phase using a dummy node.
# Requires: ./target/debug/acpfx (built orchestrator)
#
# Usage: ./tests/dummy-node/run-tests.sh
# Returns 0 if all tests pass, 1 if any fail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACPFX="./target/debug/acpfx"
PASS=0
FAIL=0

run_test() {
    local name="$1"
    local expected_pattern="$2"
    local reject_pattern="${3:-}"
    shift 3 || shift $#
    local config="$1"
    shift

    echo -n "TEST: $name ... "

    output=$(timeout 15 "$ACPFX" run --config "$config" --headless 2>&1 || true)

    if [ -n "$expected_pattern" ] && ! echo "$output" | grep -q "$expected_pattern"; then
        echo "FAIL (expected pattern not found: $expected_pattern)"
        echo "  output: $output"
        FAIL=$((FAIL + 1))
        return
    fi

    if [ -n "$reject_pattern" ] && echo "$output" | grep -q "$reject_pattern"; then
        echo "FAIL (unexpected pattern found: $reject_pattern)"
        echo "  output: $output"
        FAIL=$((FAIL + 1))
        return
    fi

    echo "PASS"
    PASS=$((PASS + 1))
}

# Verify orchestrator binary exists
if [ ! -x "$ACPFX" ]; then
    echo "ERROR: $ACPFX not found. Run 'cargo build -p acpfx-orchestrator' first."
    exit 1
fi

echo "=== Orchestrator Setup Phase Tests ==="
echo ""

# Test 1: No setup needed — node starts normally
run_test "no setup needed" "All nodes ready" "" \
    "$SCRIPT_DIR/test-no-setup.yaml"

# Test 2: Setup needed — runs setup, then starts
run_test "setup succeeds" "Setup complete" "" \
    "$SCRIPT_DIR/test-setup-needed.yaml"

# Test 3: Setup auth failure — aborts with clear message
run_test "setup auth failure" "huggingface-cli login" "" \
    "$SCRIPT_DIR/test-setup-auth-fail.yaml"

# Test 4: No setup flag in output when not needed
run_test "no setup output when not needed" "All nodes ready" "First-time setup" \
    "$SCRIPT_DIR/test-no-setup.yaml"

# Test 5: --skip-setup flag bypasses setup
echo -n "TEST: --skip-setup bypasses setup ... "
output=$(timeout 15 "$ACPFX" run --config "$SCRIPT_DIR/test-setup-needed.yaml" --headless --skip-setup 2>&1 || true)
if echo "$output" | grep -q "First-time setup"; then
    echo "FAIL (setup phase ran despite --skip-setup)"
    FAIL=$((FAIL + 1))
else
    echo "PASS"
    PASS=$((PASS + 1))
fi

# Test 6: --acpfx-manifest flag works
echo -n "TEST: dummy node --acpfx-manifest ... "
manifest=$("$SCRIPT_DIR/dummy-node.sh" --acpfx-manifest 2>&1)
if echo "$manifest" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['name']=='dummy'" 2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  output: $manifest"
    FAIL=$((FAIL + 1))
fi

# Test 7: Manifest loaded via --acpfx-manifest fallback (no co-located file)
# The dummy node has no .manifest.yaml next to it, so the orchestrator
# should fall back to running dummy-node.sh --acpfx-manifest
run_test "manifest via --acpfx-manifest fallback" "All nodes ready" "no manifest for" \
    "$SCRIPT_DIR/test-no-setup.yaml"

# Test 8: Unknown --acpfx-* flag returns unsupported response
echo -n "TEST: unknown --acpfx-* flag ... "
response=$("$SCRIPT_DIR/dummy-node.sh" --acpfx-future-flag 2>&1)
if echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['unsupported']==True; assert d['flag']=='--acpfx-future-flag'" 2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  output: $response"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
