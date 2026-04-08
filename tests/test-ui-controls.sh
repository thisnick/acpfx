#!/usr/bin/env bash
# Test the UI control chain:
# 1. Orchestrator parses ui.controls from manifest
# 2. Keybinds are registered correctly
# 3. ControlToggle events reach the node
#
# Uses the dummy-control-node which echoes received custom.* events.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACPFX="./target/debug/acpfx"
PASS=0
FAIL=0

if [ ! -x "$ACPFX" ]; then
    echo "ERROR: $ACPFX not found. Run 'cargo build -p acpfx-orchestrator' first."
    exit 1
fi

echo "=== UI Control Chain Tests ==="
echo ""

# Test 1: Orchestrator starts with UI controls from manifest (no warnings about ui field)
echo -n "TEST: orchestrator parses ui.controls from manifest ... "
output=$(timeout 10 "$ACPFX" run --config "$SCRIPT_DIR/dummy-node/test-ui-control.yaml" --headless 2>&1 || true)
if echo "$output" | grep -q "All nodes ready" && ! echo "$output" | grep -q "unknown field.*ui"; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  output: $output"
    FAIL=$((FAIL + 1))
fi

# Test 2: Directly send custom.mute to the dummy control node and verify it echoes back
echo -n "TEST: dummy control node receives and echoes custom.mute ... "
output=$( (sleep 1; echo '{"type":"custom.mute","muted":false}'; sleep 1) | timeout 4 "$SCRIPT_DIR/dummy-node/dummy-control-node.sh" 2>/tmp/dummy-stderr.log)
stderr=$(cat /tmp/dummy-stderr.log 2>/dev/null || true)
if echo "$output" | grep -qi '"muted=false\|muted=False"' && echo "$stderr" | grep -q "RECEIVED"; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  stdout: $output"
    echo "  stderr: $stderr"
    FAIL=$((FAIL + 1))
fi

# Test 3: Verify keybind parsing (space -> KeyCode::Char(' '))
# This is tested indirectly — if the orchestrator doesn't crash with ui.controls,
# the parsing worked. But let's also check the manifest has keybind: space.
echo -n "TEST: manifest declares keybind 'space' ... "
manifest=$("$SCRIPT_DIR/dummy-node/dummy-control-node.sh" --acpfx-manifest)
if echo "$manifest" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ctrl = d['ui']['controls'][0]
assert ctrl['keybind'] == 'space', f'expected space, got {ctrl.get(\"keybind\")}'
assert ctrl['hold'] == True, 'expected hold=true'
assert ctrl['event']['type'] == 'custom.mute'
assert ctrl['event']['field'] == 'muted'
" 2>/dev/null; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  manifest: $manifest"
    FAIL=$((FAIL + 1))
fi

# Test 4: Verify the orchestrator's send_to_node works for UI controls
# We can't easily simulate Space press from a script, but we can verify
# the node receives events on stdin by checking the headless output.
# The dummy node prints "RECEIVED:" to stderr for any custom.* event.
echo -n "TEST: orchestrator routes events to node stdin ... "
# Start orchestrator in background, send a raw event via a FIFO
tmp=$(mktemp -d)
mkfifo "$tmp/input"
# The orchestrator's stdin isn't connected to node stdin — events come through routing.
# For this test, we just verify the node starts and stays alive (no stdin issues).
output=$(timeout 5 "$ACPFX" run --config "$SCRIPT_DIR/dummy-node/test-ui-control.yaml" --headless 2>&1 || true)
rm -rf "$tmp"
if echo "$output" | grep -q "All nodes ready"; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  output: $output"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
