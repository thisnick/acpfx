#!/usr/bin/env bash
# Test: mic-speaker node handles custom.mute events on stdin.
#
# Sends custom.mute events via stdin and checks stdout for node.status responses.
# Also verifies audio.chunk events stop when muted and resume when unmuted.
#
# Requires: ./target/debug/mic-speaker (built mic-speaker binary)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIC="$ROOT/target/debug/mic-speaker"
PASS=0
FAIL=0

if [ ! -x "$MIC" ]; then
    echo "ERROR: $MIC not found. Run 'cargo build -p mic-speaker' first."
    exit 1
fi

echo "=== mic-speaker Mute Tests ==="
echo ""

# Test 1: Node starts and emits lifecycle.ready + initial node.status
echo -n "TEST: node starts with lifecycle.ready + node.status ... "
output=$(sleep 1 | timeout 3 "$MIC" 2>/dev/null | head -2)
if echo "$output" | grep -q "lifecycle.ready" && echo "$output" | grep -q "node.status"; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    echo "  output: $output"
    FAIL=$((FAIL + 1))
fi

# Test 2: Sending custom.mute produces node.status response
echo -n "TEST: custom.mute produces node.status response ... "
output=$( (sleep 1; echo '{"type":"custom.mute","muted":false}'; sleep 1) | timeout 4 "$MIC" 2>/dev/null)
if echo "$output" | grep -q '"text":"Listening"'; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL (no 'Listening' status in output)"
    echo "  output: $output"
    FAIL=$((FAIL + 1))
fi

# Test 3: When muted, no audio.chunk events
echo -n "TEST: muted = no audio.chunk events ... "
output=$( (sleep 1; sleep 2) | timeout 4 "$MIC" 2>/dev/null)
if echo "$output" | grep -q "audio.chunk"; then
    echo "FAIL (got audio.chunk while muted)"
    FAIL=$((FAIL + 1))
else
    echo "PASS"
    PASS=$((PASS + 1))
fi

# Test 4: When unmuted, audio.chunk events flow
echo -n "TEST: unmuted = audio.chunk events flow ... "
output=$( (sleep 1; echo '{"type":"custom.mute","muted":false}'; sleep 2) | timeout 5 "$MIC" 2>/dev/null)
if echo "$output" | grep -q "audio.chunk"; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL (no audio.chunk after unmute)"
    echo "  output lines: $(echo "$output" | wc -l)"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
