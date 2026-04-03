#!/usr/bin/env bash
# Dummy node for testing orchestrator setup phase behavior.
#
# Controlled via env vars:
#   DUMMY_SETUP_NEEDED=true|false    — what --acpfx-setup-check returns
#   DUMMY_SETUP_FAIL=true            — make --acpfx-setup emit error
#   DUMMY_SETUP_AUTH_FAIL=true       — simulate 401 auth failure
#   DUMMY_SETUP_DELAY=<seconds>      — delay during setup (simulates download)
#   DUMMY_READY_DELAY=<seconds>      — delay before lifecycle.ready
#   DUMMY_READY_FAIL=true            — never emit lifecycle.ready (exit instead)

set -euo pipefail

# Handle --acpfx-* flags
for arg in "$@"; do
    case "$arg" in
        --acpfx-manifest|--manifest)
            cat <<'EOF'
{"name":"dummy","description":"Dummy test node","consumes":["audio.chunk"],"emits":["lifecycle.ready","lifecycle.done","log"]}
EOF
            exit 0
            ;;
        --acpfx-setup-check)
            needed="${DUMMY_SETUP_NEEDED:-false}"
            if [ "$needed" = "true" ]; then
                echo '{"needed":true,"description":"Download dummy model (~1MB)"}'
            else
                echo '{"needed":false}'
            fi
            exit 0
            ;;
        --acpfx-setup)
            echo '{"type":"progress","message":"Downloading dummy model...","pct":0}'

            # Simulate delay
            delay="${DUMMY_SETUP_DELAY:-0}"
            if [ "$delay" != "0" ]; then
                sleep "$delay"
            fi

            # Simulate auth failure
            if [ "${DUMMY_SETUP_AUTH_FAIL:-}" = "true" ]; then
                echo '{"type":"error","message":"Authentication required to download '\''dummy model'\''. Run: huggingface-cli login"}'
                exit 1
            fi

            # Simulate generic failure
            if [ "${DUMMY_SETUP_FAIL:-}" = "true" ]; then
                echo '{"type":"error","message":"Network error: connection refused"}'
                exit 1
            fi

            echo '{"type":"progress","message":"Installing...","pct":50}'
            echo '{"type":"complete","message":"Setup complete"}'
            exit 0
            ;;
        --acpfx-*)
            echo "{\"unsupported\":true,\"flag\":\"$arg\"}"
            exit 0
            ;;
    esac
done

# Normal node startup
node_name="${ACPFX_NODE_NAME:-dummy}"

# Simulate startup delay
ready_delay="${DUMMY_READY_DELAY:-0}"
if [ "$ready_delay" != "0" ]; then
    sleep "$ready_delay"
fi

# Simulate ready failure
if [ "${DUMMY_READY_FAIL:-}" = "true" ]; then
    echo "{\"type\":\"log\",\"level\":\"error\",\"component\":\"$node_name\",\"message\":\"Failed to start\"}"
    exit 1
fi

# Emit ready
echo "{\"type\":\"lifecycle.ready\",\"component\":\"$node_name\"}"

# Read stdin until EOF (keep alive)
while IFS= read -r line; do
    : # consume events silently
done

# Emit done
echo "{\"type\":\"lifecycle.done\",\"component\":\"$node_name\"}"
