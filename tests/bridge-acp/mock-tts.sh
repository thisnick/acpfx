#!/usr/bin/env bash
# Mock TTS node for integration tests.
# Has the same consumes list as a real TTS node.
# Captures all received events to a file — if it receives agent.history,
# that's a test failure (history should NOT be routed to TTS).
#
# Env vars:
#   MOCK_TTS_OUTPUT=<path>    — file to write captured events to (required)

set -euo pipefail

# Handle --acpfx-manifest / --manifest FIRST (before env var checks)
for arg in "$@"; do
    case "$arg" in
        --acpfx-manifest|--manifest)
            # Same consumes as a real TTS node — crucially does NOT include agent.history
            cat <<'EOF'
{"name":"mock-tts","description":"Mock TTS for testing","consumes":["agent.submit","agent.delta","agent.complete","agent.tool_start","control.interrupt"],"emits":["audio.chunk","lifecycle.ready","lifecycle.done","control.error"]}
EOF
            exit 0
            ;;
        --acpfx-*)
            echo "{\"unsupported\":true,\"flag\":\"$arg\"}"
            exit 0
            ;;
    esac
done

OUTPUT="${MOCK_TTS_OUTPUT:?MOCK_TTS_OUTPUT must be set}"

node_name="${ACPFX_NODE_NAME:-mock-tts}"

# Clear output file
> "$OUTPUT"

# Emit ready
echo "{\"type\":\"lifecycle.ready\",\"component\":\"$node_name\"}"

# Capture events from stdin
while IFS= read -r line; do
    if [ -z "$line" ]; then
        continue
    fi
    echo "$line" >> "$OUTPUT"
done

echo "{\"type\":\"lifecycle.done\",\"component\":\"$node_name\"}"
