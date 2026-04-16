#!/usr/bin/env bash
# Integration tests for bridge-acp node (Tier 2).
# Tests the NDJSON wire contract between orchestrator, bridge, and mock agent.
#
# Requires:
#   - ./target/debug/acpfx (built orchestrator)
#   - ./target/debug/acpfx-bridge-acp (built bridge)
#   - python3 (for JSON parsing)
#
# Usage: ./tests/bridge-acp/run-tests.sh
# Returns 0 if all tests pass, 1 if any fail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACPFX="$PROJECT_DIR/target/debug/acpfx"
MOCK_AGENT="$SCRIPT_DIR/../mock-acp-agent/mock-agent.sh"
TMPDIR_BASE=$(mktemp -d)
PASS=0
FAIL=0
SKIP=0

cleanup() {
    rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

# Make test scripts executable
chmod +x "$MOCK_AGENT"
chmod +x "$SCRIPT_DIR/test-observer.sh"
chmod +x "$SCRIPT_DIR/test-injector.sh"
chmod +x "$SCRIPT_DIR/mock-tts.sh"

# --- Helpers ---

run_pipeline() {
    local config="$1"
    local timeout_sec="${2:-3}"
    timeout "$timeout_sec" "$ACPFX" run --config "$config" --dist "$PROJECT_DIR/dist" --headless --skip-setup 2>&1 || true
}

# Create a temporary directory for a test
make_test_dir() {
    local name="$1"
    local dir="$TMPDIR_BASE/$name"
    mkdir -p "$dir"
    echo "$dir"
}

# Write a pipeline config YAML
write_config() {
    local path="$1"
    cat > "$path"
}

# Write event injection file
write_events() {
    local path="$1"
    cat > "$path"
}

# Count events of a given type in an observer output file
count_events() {
    local file="$1"
    local event_type="$2"
    if [ ! -f "$file" ]; then
        echo "0"
        return
    fi
    python3 -c "
import json, sys
count = 0
for line in open('$file'):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
        if e.get('type') == '$event_type':
            count += 1
    except:
        pass
print(count)
" 2>/dev/null || echo "0"
}

# Check if any event of a given type exists in observer output
has_event() {
    local file="$1"
    local event_type="$2"
    local count
    count=$(count_events "$file" "$event_type")
    [ "$count" -gt 0 ]
}

# Extract text from agent.delta events (field is 'delta' per schema)
extract_deltas() {
    local file="$1"
    if [ ! -f "$file" ]; then
        echo ""
        return
    fi
    python3 -c "
import json
text = ''
for line in open('$file'):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
        if e.get('type') == 'agent.delta':
            text += e.get('delta', '') or e.get('text', '')
    except:
        pass
print(text.strip())
" 2>/dev/null || echo ""
}

# Extract all event types from an observer output file
list_event_types() {
    local file="$1"
    if [ ! -f "$file" ]; then
        echo ""
        return
    fi
    python3 -c "
import json
types = set()
for line in open('$file'):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
        t = e.get('type', '')
        if t:
            types.add(t)
    except:
        pass
for t in sorted(types):
    print(t)
" 2>/dev/null || echo ""
}

pass_test() {
    local name="$1"
    echo "PASS"
    PASS=$((PASS + 1))
}

fail_test() {
    local name="$1"
    local reason="$2"
    echo "FAIL ($reason)"
    FAIL=$((FAIL + 1))
}

skip_test() {
    local name="$1"
    local reason="$2"
    echo "SKIP ($reason)"
    SKIP=$((SKIP + 1))
}

# --- Pre-checks ---

if [ ! -x "$ACPFX" ]; then
    echo "ERROR: $ACPFX not found. Run 'cargo build -p acpfx-orchestrator' first."
    exit 1
fi

if [ ! -f "$MOCK_AGENT" ]; then
    echo "ERROR: $MOCK_AGENT not found."
    exit 1
fi

echo "=== ACP Bridge Integration Tests (Tier 2) ==="
echo ""

# =============================================================================
# T2.1: Full Pipeline Round-Trip
# Spawn bridge with mock agent, send speech.pause, verify agent.delta/agent.complete
# =============================================================================
echo -n "T2.1: Full pipeline round-trip ... "

T21_DIR=$(make_test_dir "t2.1")
T21_OBSERVER="$T21_DIR/observer.jsonl"
T21_EVENTS="$T21_DIR/inject-events.jsonl"

write_events "$T21_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"What is 2+2?","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

write_config "$T21_DIR/config.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T21_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T21_OBSERVER'
  MOCK_RESPONSE_TEXT: 'The answer is four'
YAML

output=$(run_pipeline "$T21_DIR/config.yaml" 20)

if has_event "$T21_OBSERVER" "agent.delta"; then
    if has_event "$T21_OBSERVER" "agent.complete"; then
        delta_text=$(extract_deltas "$T21_OBSERVER")
        if echo "$delta_text" | grep -qi "answer"; then
            pass_test "T2.1"
        else
            fail_test "T2.1" "agent.delta received but text wrong: '$delta_text'"
        fi
    else
        fail_test "T2.1" "agent.delta received but no agent.complete"
    fi
else
    fail_test "T2.1" "no agent.delta events received"
    echo "  stderr: $(echo "$output" | tail -20)"
    echo "  observer file exists: $([ -f "$T21_OBSERVER" ] && echo yes || echo no)"
    if [ -f "$T21_OBSERVER" ]; then
        echo "  observer contents: $(cat "$T21_OBSERVER" | head -10)"
    fi
fi

# =============================================================================
# T2.2: History NOT Routed to TTS
# Verify agent.history events are emitted but NOT consumed by TTS node.
# Two-run approach: first run creates a session, second run loads it and replays.
# =============================================================================
echo -n "T2.2: History NOT routed to TTS ... "

T22_DIR=$(make_test_dir "t2.2")
T22_TTS_OUTPUT="$T22_DIR/tts-received.jsonl"
T22_OBSERVER1="$T22_DIR/observer1.jsonl"
T22_OBSERVER2="$T22_DIR/observer2.jsonl"
T22_EVENTS_R1="$T22_DIR/inject-events-r1.jsonl"
T22_EVENTS_R2="$T22_DIR/inject-events-r2.jsonl"
T22_SESSIONS="$T22_DIR/sessions"
T22_CWD="$T22_DIR/project"
mkdir -p "$T22_SESSIONS" "$T22_CWD"

# Run 1: create session with a prompt (establishes history)
write_events "$T22_EVENTS_R1" <<'EVENTS'
{"type":"speech.pause","pendingText":"Hello history test","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

write_config "$T22_DIR/config-r1.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-history
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T22_EVENTS_R1'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T22_OBSERVER1'
  ACPFX_SESSION_DIR: '$T22_SESSIONS'
  ACPFX_CWD: '$T22_CWD'
YAML

run_pipeline "$T22_DIR/config-r1.yaml" 15 >/dev/null 2>&1

# Run 2: load session — agent replays history. Bridge should emit agent.history.
# TTS node should NOT receive agent.history (not in its consumes).
write_events "$T22_EVENTS_R2" <<'EVENTS'
DELAY:1000
EVENTS

write_config "$T22_DIR/config-r2.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-history
    outputs: [tts, observer]
  tts:
    use: '$SCRIPT_DIR/mock-tts.sh'
    settings: {}
    outputs: []
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T22_EVENTS_R2'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T22_OBSERVER2'
  MOCK_TTS_OUTPUT: '$T22_TTS_OUTPUT'
  MOCK_REPLAY_COUNT: '3'
  ACPFX_SESSION_DIR: '$T22_SESSIONS'
  ACPFX_CWD: '$T22_CWD'
YAML

output=$(run_pipeline "$T22_DIR/config-r2.yaml" 15)

# Check that observer got agent.history events
observer_history_count=$(count_events "$T22_OBSERVER2" "agent.history")
# Check that TTS did NOT get agent.history events
tts_history_count=$(count_events "$T22_TTS_OUTPUT" "agent.history")

if [ "$observer_history_count" -gt 0 ]; then
    if [ "$tts_history_count" -eq 0 ]; then
        pass_test "T2.2"
    else
        fail_test "T2.2" "TTS received $tts_history_count agent.history events (should be 0)"
    fi
else
    # The observer has empty consumes (permissive), so if bridge emitted agent.history
    # the observer should see them. If not, maybe bridge isn't emitting them.
    fail_test "T2.2" "observer received 0 agent.history events (expected >0 from replay)"
    echo "  observer types: $(list_event_types "$T22_OBSERVER2")"
    echo "  stderr: $(echo "$output" | tail -10)"
fi

# =============================================================================
# T2.3: Cancel During Streaming
# Send interrupt mid-stream, verify audio stops, new prompt works
# =============================================================================
echo -n "T2.3: Cancel during streaming ... "

T23_DIR=$(make_test_dir "t2.3")
T23_OBSERVER="$T23_DIR/observer.jsonl"
T23_EVENTS="$T23_DIR/inject-events.jsonl"

write_events "$T23_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"Tell me a very long story about dragons","trackId":"mic-0","silenceMs":500}
DELAY:500
{"type":"control.interrupt","reason":"barge-in"}
DELAY:500
{"type":"speech.pause","pendingText":"What is 1+1?","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

write_config "$T23_DIR/config.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-cancel
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T23_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '1000'
  OBSERVER_OUTPUT: '$T23_OBSERVER'
  MOCK_STREAM_DELAY_MS: '50'
  MOCK_RESPONSE_TEXT: 'Once upon a time there was a dragon who lived in a cave'
YAML

output=$(run_pipeline "$T23_DIR/config.yaml" 25)

# After interrupt + new prompt, we should see agent.complete for the second prompt
complete_count=$(count_events "$T23_OBSERVER" "agent.complete")
delta_count=$(count_events "$T23_OBSERVER" "agent.delta")

if [ "$delta_count" -gt 0 ]; then
    if [ "$complete_count" -ge 1 ]; then
        pass_test "T2.3"
    else
        fail_test "T2.3" "got deltas but no agent.complete after cancel+retry"
    fi
else
    fail_test "T2.3" "no agent.delta events after cancel and new prompt"
    echo "  observer types: $(list_event_types "$T23_OBSERVER")"
    echo "  stderr: $(echo "$output" | tail -10)"
fi

# =============================================================================
# T2.4: Agent Crash Recovery
# Bridge handles crash, emits control.error
# =============================================================================
echo -n "T2.4: Agent crash recovery ... "

T24_DIR=$(make_test_dir "t2.4")
T24_OBSERVER="$T24_DIR/observer.jsonl"
T24_EVENTS="$T24_DIR/inject-events.jsonl"

write_events "$T24_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"This prompt will crash the agent","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

write_config "$T24_DIR/config.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-crash
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T24_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '1000'
  OBSERVER_OUTPUT: '$T24_OBSERVER'
  MOCK_CRASH_AFTER_PROMPT: 'true'
YAML

output=$(run_pipeline "$T24_DIR/config.yaml" 20)

if has_event "$T24_OBSERVER" "control.error"; then
    pass_test "T2.4"
else
    # Check stderr for crash indication
    if echo "$output" | grep -qi "crash\|error\|fatal\|exit"; then
        fail_test "T2.4" "crash detected in stderr but no control.error event emitted"
    else
        fail_test "T2.4" "no control.error after agent crash"
    fi
    echo "  observer types: $(list_event_types "$T24_OBSERVER")"
    echo "  stderr: $(echo "$output" | tail -10)"
fi

# =============================================================================
# T2.5: Session Persistence Restart
# Run bridge twice, second run should session/load not session/new.
# Detection: run1 should NOT have agent.history, run2 SHOULD (replay triggers it).
# Also check that session files exist on disk after run1.
# =============================================================================
echo -n "T2.5: Session persistence restart ... "

T25_DIR=$(make_test_dir "t2.5")
T25_SESSIONS="$T25_DIR/sessions"
T25_OBSERVER1="$T25_DIR/observer1.jsonl"
T25_OBSERVER2="$T25_DIR/observer2.jsonl"
T25_EVENTS="$T25_DIR/inject-events.jsonl"
T25_CWD="$T25_DIR/project"
mkdir -p "$T25_CWD" "$T25_SESSIONS"

write_events "$T25_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"Hello","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

# Run 1: should create new session (no history replay)
write_config "$T25_DIR/config1.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-persist
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T25_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T25_OBSERVER1'
  ACPFX_SESSION_DIR: '$T25_SESSIONS'
  ACPFX_CWD: '$T25_CWD'
YAML

output1=$(run_pipeline "$T25_DIR/config1.yaml" 15)

# Verify session files were created
session_files=$(find "$T25_SESSIONS" -type f 2>/dev/null | wc -l | tr -d ' ')

# Run 2: should load existing session (mock replays history → agent.history events)
write_config "$T25_DIR/config2.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-persist
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T25_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T25_OBSERVER2'
  ACPFX_SESSION_DIR: '$T25_SESSIONS'
  ACPFX_CWD: '$T25_CWD'
  MOCK_REPLAY_COUNT: '2'
YAML

output2=$(run_pipeline "$T25_DIR/config2.yaml" 15)

# Verify: run1 should have agent.delta/complete but NO agent.history
run1_history=$(count_events "$T25_OBSERVER1" "agent.history")
run1_complete=$(count_events "$T25_OBSERVER1" "agent.complete")
# Verify: run2 should have agent.history (from replay)
run2_history=$(count_events "$T25_OBSERVER2" "agent.history")

if [ "$run1_complete" -gt 0 ] && [ "$run1_history" -eq 0 ]; then
    if [ "$session_files" -gt 0 ]; then
        if [ "$run2_history" -gt 0 ]; then
            pass_test "T2.5"
        else
            fail_test "T2.5" "run2: no agent.history events (session load didn't trigger replay)"
            echo "  run2 types: $(list_event_types "$T25_OBSERVER2")"
        fi
    else
        fail_test "T2.5" "no session files found after run1 (session not persisted)"
    fi
else
    if [ "$run1_complete" -eq 0 ]; then
        fail_test "T2.5" "run1: no agent.complete (bridge didn't process prompt)"
        echo "  run1 types: $(list_event_types "$T25_OBSERVER1")"
    else
        fail_test "T2.5" "run1: unexpected agent.history events ($run1_history) on fresh session"
    fi
    echo "  stderr1: $(echo "$output1" | tail -5)"
    echo "  stderr2: $(echo "$output2" | tail -5)"
fi

# =============================================================================
# T2.6: Permission Request Flow
# Auto-approve → tool executes
# =============================================================================
echo -n "T2.6: Permission request flow ... "

T26_DIR=$(make_test_dir "t2.6")
T26_OBSERVER="$T26_DIR/observer.jsonl"
T26_EVENTS="$T26_DIR/inject-events.jsonl"

write_events "$T26_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"Run a command","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

write_config "$T26_DIR/config.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-perm
      permissionMode: approve-all
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T26_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '1000'
  OBSERVER_OUTPUT: '$T26_OBSERVER'
  MOCK_PERMISSION_REQUEST: 'true'
YAML

output=$(run_pipeline "$T26_DIR/config.yaml" 20)

# Should still get agent.complete — permission was auto-approved
if has_event "$T26_OBSERVER" "agent.complete"; then
    pass_test "T2.6"
else
    fail_test "T2.6" "no agent.complete after permission request (auto-approve may have failed)"
    echo "  observer types: $(list_event_types "$T26_OBSERVER")"
    echo "  stderr: $(echo "$output" | tail -10)"
fi

# =============================================================================
# T2.7: Barge-In
# Send speech.partial during streaming, verify interrupt
# =============================================================================
echo -n "T2.7: Barge-in ... "

T27_DIR=$(make_test_dir "t2.7")
T27_OBSERVER="$T27_DIR/observer.jsonl"
T27_EVENTS="$T27_DIR/inject-events.jsonl"

write_events "$T27_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"Tell me something","trackId":"mic-0","silenceMs":500}
DELAY:300
{"type":"speech.partial","text":"wait","trackId":"mic-0"}
DELAY:1000
EVENTS

write_config "$T27_DIR/config.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: test-bargein
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T27_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '1000'
  OBSERVER_OUTPUT: '$T27_OBSERVER'
  MOCK_STREAM_DELAY_MS: '50'
  MOCK_RESPONSE_TEXT: 'This is a long response that should get interrupted before finishing all of these words'
YAML

output=$(run_pipeline "$T27_DIR/config.yaml" 20)

# Barge-in should trigger control.interrupt from the bridge
if has_event "$T27_OBSERVER" "control.interrupt"; then
    pass_test "T2.7"
elif has_event "$T27_OBSERVER" "agent.delta"; then
    # Got deltas but no interrupt — barge-in didn't work
    fail_test "T2.7" "agent.delta received but no control.interrupt (barge-in didn't trigger)"
else
    fail_test "T2.7" "no events received at all"
    echo "  observer types: $(list_event_types "$T27_OBSERVER")"
    echo "  stderr: $(echo "$output" | tail -10)"
fi

# =============================================================================
# T2.8: Real Agent Smoke Test
# Actually call claude-agent-acp with a simple prompt. Skip if no credentials.
# =============================================================================
echo -n "T2.8: Real agent smoke test ... "

if ! command -v npx &>/dev/null; then
    skip_test "T2.8" "npx not found"
elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    skip_test "T2.8" "ANTHROPIC_API_KEY not set"
else
    T28_DIR=$(make_test_dir "t2.8")
    T28_OBSERVER="$T28_DIR/observer.jsonl"
    T28_EVENTS="$T28_DIR/inject-events.jsonl"

    write_events "$T28_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"Say hello and nothing else.","trackId":"mic-0","silenceMs":500}
DELAY:5000
EVENTS

    write_config "$T28_DIR/config.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: claude
      session: test-real
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T28_EVENTS'
  INJECTOR_DELAY_MS: '150'
  INJECTOR_EXIT_AFTER_MS: '1500'
  OBSERVER_OUTPUT: '$T28_OBSERVER'
  ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}'
YAML

    output=$(run_pipeline "$T28_DIR/config.yaml" 30)

    if has_event "$T28_OBSERVER" "agent.delta"; then
        if has_event "$T28_OBSERVER" "agent.complete"; then
            delta_text=$(extract_deltas "$T28_OBSERVER")
            if [ -n "$delta_text" ]; then
                pass_test "T2.8"
            else
                fail_test "T2.8" "agent.delta events have empty text"
            fi
        else
            fail_test "T2.8" "got agent.delta but no agent.complete"
        fi
    else
        fail_test "T2.8" "no agent.delta from real agent"
        echo "  observer types: $(list_event_types "$T28_OBSERVER")"
        echo "  stderr: $(echo "$output" | tail -15)"
    fi
fi

# =============================================================================
# T2.9: CWD Session Isolation
# Two different CWDs get separate sessions, don't cross-contaminate.
# Detection: fresh runs have no agent.history; restart with same CWD does.
# =============================================================================
echo -n "T2.9: CWD session isolation ... "

T29_DIR=$(make_test_dir "t2.9")
T29_SESSIONS="$T29_DIR/sessions"
T29_CWD_A="$T29_DIR/project-a"
T29_CWD_B="$T29_DIR/project-b"
T29_OBSERVER_A1="$T29_DIR/observer-a1.jsonl"
T29_OBSERVER_B1="$T29_DIR/observer-b1.jsonl"
T29_OBSERVER_A2="$T29_DIR/observer-a2.jsonl"
T29_OBSERVER_B2="$T29_DIR/observer-b2.jsonl"
T29_EVENTS="$T29_DIR/inject-events.jsonl"
mkdir -p "$T29_CWD_A" "$T29_CWD_B" "$T29_SESSIONS"

write_events "$T29_EVENTS" <<'EVENTS'
{"type":"speech.pause","pendingText":"Hello","trackId":"mic-0","silenceMs":500}
DELAY:800
EVENTS

# Run 1A: CWD A — fresh session (no history)
write_config "$T29_DIR/config-a1.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: voice
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T29_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T29_OBSERVER_A1'
  ACPFX_SESSION_DIR: '$T29_SESSIONS'
  ACPFX_CWD: '$T29_CWD_A'
YAML

# Run 1B: CWD B — fresh session (no history)
write_config "$T29_DIR/config-b1.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: voice
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T29_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T29_OBSERVER_B1'
  ACPFX_SESSION_DIR: '$T29_SESSIONS'
  ACPFX_CWD: '$T29_CWD_B'
YAML

output_a1=$(run_pipeline "$T29_DIR/config-a1.yaml" 15)
output_b1=$(run_pipeline "$T29_DIR/config-b1.yaml" 15)

# Both should have agent.complete but NO agent.history (fresh sessions)
a1_complete=$(count_events "$T29_OBSERVER_A1" "agent.complete")
b1_complete=$(count_events "$T29_OBSERVER_B1" "agent.complete")
a1_history=$(count_events "$T29_OBSERVER_A1" "agent.history")
b1_history=$(count_events "$T29_OBSERVER_B1" "agent.history")

# Run 2A: restart with CWD A — should load A's session (history replay)
write_config "$T29_DIR/config-a2.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: voice
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T29_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T29_OBSERVER_A2'
  ACPFX_SESSION_DIR: '$T29_SESSIONS'
  ACPFX_CWD: '$T29_CWD_A'
  MOCK_REPLAY_COUNT: '1'
YAML

# Run 2B: restart with CWD B — should load B's session (history replay)
write_config "$T29_DIR/config-b2.yaml" <<YAML
nodes:
  injector:
    use: '$SCRIPT_DIR/test-injector.sh'
    settings: {}
    outputs: [bridge]
  bridge:
    use: '@acpfx/bridge-acp'
    settings:
      agent: mock
      agentCommand: '$MOCK_AGENT'
      session: voice
    outputs: [observer]
  observer:
    use: '$SCRIPT_DIR/test-observer.sh'
    settings: {}
    outputs: []
env:
  INJECTOR_EVENTS: '$T29_EVENTS'
  INJECTOR_DELAY_MS: '100'
  INJECTOR_EXIT_AFTER_MS: '800'
  OBSERVER_OUTPUT: '$T29_OBSERVER_B2'
  ACPFX_SESSION_DIR: '$T29_SESSIONS'
  ACPFX_CWD: '$T29_CWD_B'
  MOCK_REPLAY_COUNT: '1'
YAML

output_a2=$(run_pipeline "$T29_DIR/config-a2.yaml" 15)
output_b2=$(run_pipeline "$T29_DIR/config-b2.yaml" 15)

a2_history=$(count_events "$T29_OBSERVER_A2" "agent.history")
b2_history=$(count_events "$T29_OBSERVER_B2" "agent.history")

if [ "$a1_complete" -gt 0 ] && [ "$b1_complete" -gt 0 ]; then
    if [ "$a1_history" -eq 0 ] && [ "$b1_history" -eq 0 ]; then
        if [ "$a2_history" -gt 0 ] && [ "$b2_history" -gt 0 ]; then
            pass_test "T2.9"
        else
            fail_test "T2.9" "restart: expected agent.history for both CWDs (a=$a2_history, b=$b2_history)"
            echo "  a2 types: $(list_event_types "$T29_OBSERVER_A2")"
            echo "  b2 types: $(list_event_types "$T29_OBSERVER_B2")"
        fi
    else
        fail_test "T2.9" "fresh runs: unexpected agent.history (a=$a1_history, b=$b1_history)"
    fi
else
    fail_test "T2.9" "fresh runs: no agent.complete (a=$a1_complete, b=$b1_complete)"
    echo "  stderr A: $(echo "$output_a1" | tail -5)"
    echo "  stderr B: $(echo "$output_b1" | tail -5)"
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
