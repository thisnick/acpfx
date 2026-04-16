#!/usr/bin/env bash
# Observer node for integration tests.
# Captures all received events to a file for later inspection.
#
# Env vars:
#   OBSERVER_OUTPUT=<path>    — file to write captured events to (required)
#   OBSERVER_FILTER=<types>   — comma-separated event types to capture (default: all)

set -euo pipefail

# Handle --acpfx-manifest / --manifest FIRST (before env var checks)
for arg in "$@"; do
    case "$arg" in
        --acpfx-manifest|--manifest)
            cat <<'EOF'
{"name":"test-observer","description":"Test observer that captures events","consumes":[],"emits":["lifecycle.ready","lifecycle.done"]}
EOF
            exit 0
            ;;
        --acpfx-*)
            echo "{\"unsupported\":true,\"flag\":\"$arg\"}"
            exit 0
            ;;
    esac
done

OUTPUT="${OBSERVER_OUTPUT:?OBSERVER_OUTPUT must be set}"
FILTER="${OBSERVER_FILTER:-}"

node_name="${ACPFX_NODE_NAME:-observer}"

# Clear output file
> "$OUTPUT"

# Emit ready
echo "{\"type\":\"lifecycle.ready\",\"component\":\"$node_name\"}"

# Capture events from stdin
while IFS= read -r line; do
    if [ -z "$line" ]; then
        continue
    fi

    event_type=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('type',''))" 2>/dev/null || echo "")

    if [ -n "$FILTER" ]; then
        # Check if event type matches filter
        if echo ",$FILTER," | grep -q ",$event_type,"; then
            echo "$line" >> "$OUTPUT"
        fi
    else
        echo "$line" >> "$OUTPUT"
    fi
done

echo "{\"type\":\"lifecycle.done\",\"component\":\"$node_name\"}"
