#!/usr/bin/env bash
# Mock ACP agent for gap tests.
# Same protocol as tests/mock-acp-agent/mock-agent.sh but with cancel logging.
#
# Env vars:
#   MOCK_SESSION_ID=<id>           — session ID to return (default: "mock-session-001")
#   MOCK_STREAM_DELAY_MS=<ms>      — delay between streamed deltas (default: 10)
#   MOCK_RESPONSE_TEXT=<text>       — full response text (default: "Hello! I am a mock agent.")
#   MOCK_AGENT_LOG=<path>          — log file for cancel/other diagnostics
#   MOCK_STALE_SESSION=true        — simulate stale session: session/load returns -32002 error

set -euo pipefail

SESSION_ID="${MOCK_SESSION_ID:-mock-session-001}"
STREAM_DELAY_MS="${MOCK_STREAM_DELAY_MS:-10}"
RESPONSE_TEXT="${MOCK_RESPONSE_TEXT:-Hello! I am a mock agent.}"
AGENT_LOG="${MOCK_AGENT_LOG:-/dev/null}"
STALE_SESSION="${MOCK_STALE_SESSION:-false}"

# Log helper
log_msg() {
    echo "$(date +%s.%N) $*" >> "$AGENT_LOG"
}

send_response() {
    local id="$1"
    local result="$2"
    printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
}

send_notification() {
    local method="$1"
    local params="$2"
    printf '{"jsonrpc":"2.0","method":"%s","params":%s}\n' "$method" "$params"
}

stream_response() {
    local prompt_id="$1"
    local text="$RESPONSE_TEXT"
    local delay_s
    delay_s=$(echo "scale=3; $STREAM_DELAY_MS / 1000" | bc 2>/dev/null || echo "0.01")

    local word_count=0
    for word in $text; do
        if [ $word_count -gt 0 ]; then
            word=" $word"
        fi
        send_notification "session/update" "{\"type\":\"text_delta\",\"delta\":\"$word\"}"
        sleep "$delay_s"
        word_count=$((word_count + 1))
    done

    # Real claude-agent-acp signals completion via the JSON-RPC RESPONSE to
    # session/prompt (with stopReason + usage), NOT via an "end" notification.
    send_response "$prompt_id" "{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":10,\"outputTokens\":${word_count},\"totalTokens\":$((10 + word_count))}}"
}

while IFS= read -r line; do
    line=$(echo "$line" | tr -d '\r')
    [ -z "$line" ] && continue

    id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
    method=$(echo "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')

    log_msg "RECV method=$method id=$id"

    case "$method" in
        initialize)
            send_response "$id" '{"serverName":"gap-mock-agent","serverVersion":"0.1.0","protocolVersion":"0.1"}'
            ;;

        session/new)
            send_response "$id" "{\"sessionId\":\"$SESSION_ID\"}"
            ;;

        session/load)
            if [ "$STALE_SESSION" = "true" ]; then
                # Extract the sessionId from params for the error data
                load_sid=$(echo "$line" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
                log_msg "STALE_SESSION: rejecting session/load for $load_sid"
                printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32002,"message":"Resource not found","data":{"uri":"%s"}}}\n' "$id" "$load_sid"
            else
                send_response "$id" "{\"sessionId\":\"$SESSION_ID\"}"
            fi
            ;;

        session/prompt)
            log_msg "PROMPT received id=$id"
            stream_response "$id"
            ;;

        session/cancel)
            log_msg "CANCEL received id=$id"
            # If it has an id, send response. If not (notification), just log.
            if [ -n "$id" ]; then
                send_response "$id" '{"status":"cancelled"}'
            fi
            ;;

        session/set_config_option)
            if [ -n "$id" ]; then
                send_response "$id" '{"status":"ok"}'
            fi
            ;;

        *)
            log_msg "UNKNOWN method=$method"
            if [ -n "$id" ]; then
                printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found: %s"}}\n' "$id" "$method"
            fi
            ;;
    esac
done
