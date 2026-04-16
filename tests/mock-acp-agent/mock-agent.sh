#!/usr/bin/env bash
# Mock ACP agent for testing bridge-acp.
#
# Implements ACP JSON-RPC protocol on stdin/stdout:
#   - initialize → server info response
#   - session/new → new session ID
#   - session/load → load session, optionally replay history
#   - session/prompt → stream response deltas + complete
#   - session/cancel → acknowledge cancel
#
# Controlled via env vars:
#   MOCK_SESSION_ID=<id>           — session ID to return (default: "mock-session-001")
#   MOCK_REPLAY_COUNT=<n>          — number of history entries to replay on session/load (default: 0)
#   MOCK_STREAM_DELAY_MS=<ms>      — delay between streamed deltas in ms (default: 10)
#   MOCK_RESPONSE_TEXT=<text>       — full response text (default: "Hello! I am a mock agent.")
#   MOCK_CRASH_AFTER_PROMPT=true   — crash after receiving a prompt
#   MOCK_TOOL_CALL=true            — emit a tool call during response
#   MOCK_THINKING=true             — emit thinking notification before response
#   MOCK_PERMISSION_REQUEST=true   — send permission request during response
#   MOCK_FILE_READ=<path>          — send fs/read_text_file request during response

set -euo pipefail

SESSION_ID="${MOCK_SESSION_ID:-mock-session-001}"
REPLAY_COUNT="${MOCK_REPLAY_COUNT:-0}"
STREAM_DELAY_MS="${MOCK_STREAM_DELAY_MS:-10}"
RESPONSE_TEXT="${MOCK_RESPONSE_TEXT:-Hello! I am a mock agent.}"
PROMPT_COUNT=0

# Send a JSON-RPC response
send_response() {
    local id="$1"
    local result="$2"
    printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
}

# Send a JSON-RPC notification
send_notification() {
    local method="$1"
    local params="$2"
    printf '{"jsonrpc":"2.0","method":"%s","params":%s}\n' "$method" "$params"
}

# Send a JSON-RPC request (agent-initiated)
send_request() {
    local id="$1"
    local method="$2"
    local params="$3"
    printf '{"jsonrpc":"2.0","id":%s,"method":"%s","params":%s}\n' "$id" "$method" "$params"
}

# Stream response text as deltas
stream_response() {
    local text="$RESPONSE_TEXT"
    local delay_s
    delay_s=$(echo "scale=3; $STREAM_DELAY_MS / 1000" | bc 2>/dev/null || echo "0.01")

    # Thinking phase
    if [ "${MOCK_THINKING:-}" = "true" ]; then
        send_notification "session/update" '{"type":"agent_thought_chunk","text":"Let me think..."}'
        sleep "$delay_s"
    fi

    # Tool call phase
    if [ "${MOCK_TOOL_CALL:-}" = "true" ]; then
        send_notification "session/update" '{"type":"tool_call","toolCallId":"tc-001","name":"read_file"}'
        sleep "$delay_s"
        send_notification "session/update" '{"type":"tool_call_update","toolCallId":"tc-001","status":"done"}'
        sleep "$delay_s"
    fi

    # Permission request
    if [ "${MOCK_PERMISSION_REQUEST:-}" = "true" ]; then
        send_request 1000 "session/request_permission" '{"tool":"write_file","path":"/tmp/test.txt"}'
        # Wait for and consume the response
        while IFS= read -r line; do
            if echo "$line" | grep -q '"id":1000' 2>/dev/null; then
                break
            fi
        done
    fi

    # File read request
    if [ -n "${MOCK_FILE_READ:-}" ]; then
        send_request 1001 "fs/read_text_file" "{\"path\":\"$MOCK_FILE_READ\"}"
        # Wait for and consume the response
        while IFS= read -r line; do
            if echo "$line" | grep -q '"id":1001' 2>/dev/null; then
                break
            fi
        done
    fi

    # Stream text word by word
    local word_count=0
    for word in $text; do
        if [ $word_count -gt 0 ]; then
            word=" $word"
        fi
        send_notification "session/update" "{\"type\":\"text_delta\",\"delta\":\"$word\"}"
        sleep "$delay_s"
        word_count=$((word_count + 1))
    done

    # Complete
    send_notification "session/update" "{\"type\":\"end\",\"text\":\"$text\"}"
}

# Replay history entries
replay_history() {
    local count="$1"
    local i=0
    while [ $i -lt "$count" ]; do
        send_notification "session/update" "{\"type\":\"user_text\",\"text\":\"History prompt $i\",\"replay\":true}"
        send_notification "session/update" "{\"type\":\"text_delta\",\"delta\":\"History response $i\",\"replay\":true}"
        send_notification "session/update" "{\"type\":\"end\",\"text\":\"History response $i\",\"replay\":true}"
        i=$((i + 1))
    done
}

# Main loop: read JSON-RPC messages from stdin
while IFS= read -r line; do
    line=$(echo "$line" | tr -d '\r')
    [ -z "$line" ] && continue

    # Extract fields using simple parsing
    id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
    method=$(echo "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')

    case "$method" in
        initialize)
            send_response "$id" '{"serverName":"mock-acp-agent","serverVersion":"0.1.0","protocolVersion":"0.1"}'
            ;;

        session/new)
            send_response "$id" "{\"sessionId\":\"$SESSION_ID\"}"
            ;;

        session/load)
            send_response "$id" "{\"sessionId\":\"$SESSION_ID\"}"
            # Replay history if configured
            if [ "$REPLAY_COUNT" -gt 0 ]; then
                replay_history "$REPLAY_COUNT"
            fi
            ;;

        session/prompt)
            PROMPT_COUNT=$((PROMPT_COUNT + 1))

            if [ "${MOCK_CRASH_AFTER_PROMPT:-}" = "true" ]; then
                exit 1
            fi

            send_response "$id" '{"status":"ok"}'
            stream_response
            ;;

        session/cancel)
            send_response "$id" '{"status":"cancelled"}'
            ;;

        *)
            # Unknown method — return error
            if [ -n "$id" ]; then
                printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found: %s"}}\n' "$id" "$method"
            fi
            ;;
    esac
done
