#!/usr/bin/env bash
# Dummy node that declares a UI control and echoes received custom.* events to stderr.
# Used to test that the orchestrator routes UI control events to the declaring node.

set -euo pipefail

for arg in "$@"; do
    case "$arg" in
        --acpfx-manifest|--manifest)
            cat <<'EOF'
{"name":"dummy-control","description":"Test node with UI control","consumes":["custom.mute"],"emits":["lifecycle.ready","lifecycle.done","node.status"],"ui":{"controls":[{"id":"mute","type":"toggle","label":"Mute","hold":true,"keybind":"space","event":{"type":"custom.mute","field":"muted"}}]}}
EOF
            exit 0
            ;;
        --acpfx-setup-check)
            echo '{"needed":false}'
            exit 0
            ;;
        --acpfx-*)
            echo "{\"unsupported\":true,\"flag\":\"$arg\"}"
            exit 0
            ;;
    esac
done

# Normal startup
echo '{"type":"lifecycle.ready","component":"dummy-control"}'
echo '{"type":"node.status","text":"Ready"}'

# Read stdin and echo any custom.* events to BOTH stdout (as node.status) and stderr (for test capture)
while IFS= read -r line; do
    event_type=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null || echo "")
    if [[ "$event_type" == custom.* ]]; then
        # Echo the received event as node.status so the test can verify it arrived
        muted=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('muted','unknown'))" 2>/dev/null || echo "unknown")
        echo "{\"type\":\"node.status\",\"text\":\"muted=$muted\"}"
        echo "RECEIVED: $line" >&2
    fi
done

echo '{"type":"lifecycle.done","component":"dummy-control"}'
