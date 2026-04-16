use crate::acp_client::AcpClient;
use crate::state::BridgeState;
use crate::{emit, emit_log};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) async fn handle_speech_partial(
    event: &Value,
    state: &mut BridgeState,
    client: &mut AcpClient,
    session_id: &str,
) {
    let text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
    state.pending_text = text.to_string();

    // Barge-in: if agent responded (even if done streaming), interrupt
    if state.agent_active && !text.is_empty() {
        emit_log("info", "barge-in detected, interrupting");
        emit(&json!({
            "type": "control.interrupt",
            "reason": "barge-in",
        }));
        // Send cancel as notification (no response expected)
        let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
        state.reset();
    }
}

pub(crate) async fn handle_speech_pause(
    text: &str,
    state: &mut BridgeState,
    client: &mut AcpClient,
    session_id: &str,
) {
    state.response_mode = "voice";

    // Always emit interrupt to cancel downstream TTS/playback
    emit(&json!({
        "type": "control.interrupt",
        "reason": "user_speech",
    }));

    if state.agent_active {
        let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
        if state.streaming {
            // Agent started responding but still streaming —
            // accumulate (user speaking in rapid chunks)
            emit_log("debug", "speech.pause: agent_active+streaming, canceling and appending");
            if state.accumulated_text.is_empty() {
                state.accumulated_text = text.to_string();
            } else {
                state.accumulated_text.push(' ');
                state.accumulated_text.push_str(text);
            }
        } else {
            // Agent finished responding — new turn, replace
            emit_log("debug", "speech.pause: agent_active+done, replacing accumulatedText");
            state.accumulated_text = text.to_string();
        }
        state.agent_active = false;
    } else if state.streaming {
        // Submitted but agent hasn't responded yet — cancel and append
        emit_log("debug", "speech.pause: streaming (no delta yet), canceling and appending");
        let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
        if state.accumulated_text.is_empty() {
            state.accumulated_text = text.to_string();
        } else {
            state.accumulated_text.push(' ');
            state.accumulated_text.push_str(text);
        }
    } else {
        // Fresh submission
        emit_log("debug", "speech.pause: fresh submission");
        if state.accumulated_text.is_empty() {
            state.accumulated_text = text.to_string();
        } else {
            state.accumulated_text.push(' ');
            state.accumulated_text.push_str(text);
        }
    }

    // Always submit immediately (never queue voice prompts)
    // Note: agent_active is NOT set here — it's set in
    // handle_notification when the first delta arrives,
    // matching the TS agentResponding semantics.
    let submit_text = state.accumulated_text.clone();
    let request_id = Uuid::new_v4().to_string();
    state.active_request_id = Some(request_id.clone());
    state.streaming = true;
    state.seq = 0;

    emit(&json!({
        "type": "agent.submit",
        "requestId": request_id,
        "text": submit_text,
        "responseMode": state.response_mode,
    }));

    emit_log("info", &format!("sending prompt to agent (session={}): {}", &session_id[..8.min(session_id.len())], &submit_text[..80.min(submit_text.len())]));
    match client
        .send_request("session/prompt", json!({
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": submit_text}]
        }))
        .await
    {
        Ok(rpc_id) => { state.active_prompt_rpc_id = Some(rpc_id); }
        Err(e) => {
            emit_log("error", &format!("failed to send prompt: {}", e));
            state.streaming = false;
            state.active_request_id = None;
            state.active_prompt_rpc_id = None;
        }
    }

    state.pending_text.clear();
}

pub(crate) async fn handle_prompt_text(
    text: &str,
    state: &mut BridgeState,
    client: &mut AcpClient,
    session_id: &str,
) {
    state.response_mode = "text";
    // Do NOT set agent_active — text prompts are not interruptible
    // by speech.partial barge-in

    let request_id = Uuid::new_v4().to_string();
    state.active_request_id = Some(request_id.clone());
    state.streaming = true;
    state.accumulated_text.clear();
    state.seq = 0;

    emit(&json!({
        "type": "agent.submit",
        "requestId": request_id,
        "text": text,
        "responseMode": state.response_mode,
    }));

    match client
        .send_request("session/prompt", json!({
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text.to_string()}]
        }))
        .await
    {
        Ok(rpc_id) => { state.active_prompt_rpc_id = Some(rpc_id); }
        Err(e) => {
            emit_log("error", &format!("failed to send prompt: {}", e));
            state.streaming = false;
            state.active_request_id = None;
            state.active_prompt_rpc_id = None;
        }
    }
}

pub(crate) async fn handle_control_interrupt(
    state: &mut BridgeState,
    client: &mut AcpClient,
    session_id: &str,
) {
    if state.streaming {
        state.streaming = false;
        let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
        state.active_request_id = None;
        state.active_prompt_rpc_id = None;
        state.accumulated_text.clear();
    }
    state.agent_active = false;
}

pub(crate) async fn handle_agent_response(
    resp: &Value,
    node_name: &str,
    state: &mut BridgeState,
    client: &mut AcpClient,
    session_id: &str,
) {
    // This is the JSON-RPC response to send_request("session/prompt").
    // Real ACP agents (e.g. claude-agent-acp) signal completion
    // via this response (with result.stopReason and result.usage),
    // NOT via a separate "end" notification. We emit agent.complete
    // here for success, and handle errors below.

    // Ignore stale responses from cancelled prompts
    let resp_id = resp.get("id").and_then(|id| id.as_u64());
    if resp_id.is_some() && resp_id != state.active_prompt_rpc_id {
        emit_log("debug", &format!("ignoring stale response (id={:?}, active={:?})", resp_id, state.active_prompt_rpc_id));
    } else if resp.get("error").is_some() {
        let msg = resp.get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        emit_log("error", &format!("prompt error: {}", msg));
        emit(&json!({
            "type": "control.error",
            "component": node_name,
            "message": format!("agent error: {}", msg),
            "fatal": false,
        }));
        // Clean up state on error — the stream will not produce
        // an "end" notification, so we must reset here.
        state.reset();

        // Drain one queued prompt on error recovery
        drain_one_prompt(client, session_id, state).await;
    } else if resp_id.is_some() && resp_id == state.active_prompt_rpc_id {
        // Successful response to session/prompt — this IS the
        // completion signal from real ACP agents (e.g. claude-agent-acp).
        // The response contains result.stopReason and result.usage.
        let result = resp.get("result").cloned().unwrap_or(json!({}));

        let rid = state.active_request_id.take().unwrap_or_default();
        let text = state.accumulated_text.clone();

        let mut event = json!({
            "type": "agent.complete",
            "requestId": rid,
            "text": text,
            "responseMode": state.response_mode,
        });

        // Include stopReason if provided
        if let Some(stop_reason) = result.get("stopReason") {
            event["stopReason"] = stop_reason.clone();
        }

        // Include token usage if provided
        if let Some(usage) = result.get("usage") {
            event["tokenUsage"] = usage.clone();
        }

        emit(&event);

        // Clean up state
        state.reset();

        // Drain one queued prompt
        drain_one_prompt(client, session_id, state).await;
    }
    // else: response without matching active id and no error — ignore
}

/// Drain one queued prompt if available — sends it to the agent and updates state.
pub(crate) async fn drain_one_prompt(
    client: &mut AcpClient,
    session_id: &str,
    state: &mut BridgeState,
) {
    if let Some(next) = state.pending_prompts.pop_front() {
        emit_log("info", &format!(
            "draining queued prompt: \"{}\" ({} remaining)",
            &next.text[..80.min(next.text.len())],
            state.pending_prompts.len()
        ));
        state.response_mode = next.response_mode;
        state.agent_active = false;

        let request_id = Uuid::new_v4().to_string();
        state.active_request_id = Some(request_id.clone());
        state.streaming = true;
        state.seq = 0;

        emit(&json!({
            "type": "agent.submit",
            "requestId": request_id,
            "text": next.text,
            "responseMode": state.response_mode,
        }));

        match client
            .send_request("session/prompt", json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": next.text}]
            }))
            .await
        {
            Ok(rpc_id) => { state.active_prompt_rpc_id = Some(rpc_id); }
            Err(e) => {
                emit_log("error", &format!("failed to send queued prompt: {}", e));
                state.streaming = false;
                state.active_request_id = None;
                state.active_prompt_rpc_id = None;
            }
        }
    }
}
