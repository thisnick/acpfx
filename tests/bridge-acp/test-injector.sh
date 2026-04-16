#!/usr/bin/env bash
# Injector node for integration tests.
# Sends predetermined events after startup, then keeps alive.
#
# Env vars:
#   INJECTOR_EVENTS=<path>     — file containing NDJSON events to send (one per line)
#   INJECTOR_DELAY_MS=<n>      — delay before sending events in ms (default: 500)
#   INJECTOR_EXIT_AFTER_MS=<n> — exit after N ms (default: 0 = don't exit)

set -euo pipefail

# Handle --acpfx-manifest / --manifest FIRST (before env var checks)
for arg in "$@"; do
    case "$arg" in
        --acpfx-manifest|--manifest)
            cat <<'EOF'
{"name":"test-injector","description":"Test event injector","consumes":["audio.chunk","agent.delta","agent.complete","agent.history","agent.thinking","agent.tool_start","agent.tool_done","control.interrupt","control.error"],"emits":["speech.partial","speech.pause","speech.final","speech.delta","control.interrupt","lifecycle.ready","lifecycle.done"]}
EOF
            exit 0
            ;;
        --acpfx-*)
            echo "{\"unsupported\":true,\"flag\":\"$arg\"}"
            exit 0
            ;;
    esac
done

EVENTS_FILE="${INJECTOR_EVENTS:-}"
DELAY_MS="${INJECTOR_DELAY_MS:-500}"
EXIT_AFTER_MS="${INJECTOR_EXIT_AFTER_MS:-0}"

node_name="${ACPFX_NODE_NAME:-injector}"

# Emit ready
echo "{\"type\":\"lifecycle.ready\",\"component\":\"$node_name\"}"

# Wait for pipeline to stabilize
sleep "$(echo "scale=3; $DELAY_MS / 1000" | bc)"

# Send events from file
if [ -n "$EVENTS_FILE" ] && [ -f "$EVENTS_FILE" ]; then
    while IFS= read -r event; do
        if [ -z "$event" ]; then
            continue
        fi
        # Check for delay directives
        if [[ "$event" == DELAY:* ]]; then
            delay_val="${event#DELAY:}"
            sleep "$(echo "scale=3; $delay_val / 1000" | bc)"
            continue
        fi
        echo "$event"
    done < "$EVENTS_FILE"
fi

# Auto-exit or keep alive
if [ "$EXIT_AFTER_MS" != "0" ]; then
    sleep "$(echo "scale=3; $EXIT_AFTER_MS / 1000" | bc)"
    echo "{\"type\":\"lifecycle.done\",\"component\":\"$node_name\"}"
    exit 0
fi

# Keep alive — read stdin until EOF
while IFS= read -r line; do
    : # consume events
done

echo "{\"type\":\"lifecycle.done\",\"component\":\"$node_name\"}"
