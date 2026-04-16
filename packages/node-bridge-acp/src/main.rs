#![allow(unused_assignments)]
//! bridge-acp node — ACP JSON-RPC bridge for acpfx pipelines.
//!
//! Spawns an ACP agent process once at startup and communicates via JSON-RPC 2.0
//! over NDJSON stdio. Translates between acpfx events (orchestrator channel) and
//! ACP protocol messages (agent channel).

mod acp_client;
mod agent_registry;
mod notifications;
mod session;
mod state;

use acp_client::{AcpClient, AgentMessage};
use serde::Deserialize;
use serde_json::{json, Value};
use state::{BridgeState, PendingPrompt};
use std::io::{self, BufRead, Write};
use tokio::sync::mpsc;
use uuid::Uuid;

/// Manifest YAML embedded at compile time.
const MANIFEST_YAML: &str = include_str!("../manifest.yaml");

// ---- Settings ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub(crate) agent: String,
    #[serde(default = "default_session")]
    pub(crate) session: String,
    #[serde(default = "default_permission_mode")]
    pub(crate) permission_mode: String,
    #[serde(default)]
    pub(crate) agent_command: Option<String>,
}

fn default_session() -> String {
    "default".into()
}

fn default_permission_mode() -> String {
    "approve-all".into()
}

// ---- Event emitting ----

pub(crate) fn emit(event: &Value) {
    let mut out = io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, event);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

pub(crate) fn emit_log(level: &str, message: &str) {
    let node_name = std::env::var("ACPFX_NODE_NAME").unwrap_or_else(|_| "bridge-acp".into());
    emit(&json!({
        "type": "log",
        "level": level,
        "component": node_name,
        "message": message,
    }));
}

// ---- Flag handling ----

fn handle_manifest() {
    let manifest: Value = serde_yaml::from_str(MANIFEST_YAML)
        .expect("embedded manifest.yaml is invalid");
    println!("{}", manifest);
    std::process::exit(0);
}

fn handle_acpfx_flags() {
    let acpfx_flag = std::env::args().find(|a| a.starts_with("--acpfx-"));
    let legacy_manifest = std::env::args().any(|a| a == "--manifest");

    let flag = match acpfx_flag.or(if legacy_manifest {
        Some("--acpfx-manifest".to_string())
    } else {
        None
    }) {
        Some(f) => f,
        None => return,
    };

    match flag.as_str() {
        "--acpfx-manifest" => handle_manifest(),
        "--acpfx-setup-check" => {
            println!("{}", json!({"needed": false}));
            std::process::exit(0);
        }
        _ => {
            println!("{}", json!({"unsupported": true, "flag": flag}));
            std::process::exit(0);
        }
    }
}

// ---- Main ----

#[tokio::main]
async fn main() {
    handle_acpfx_flags();

    let node_name = std::env::var("ACPFX_NODE_NAME").unwrap_or_else(|_| "bridge-acp".into());

    let settings_json = std::env::var("ACPFX_SETTINGS").unwrap_or_else(|_| "{}".into());
    let settings: Settings = match serde_json::from_str(&settings_json) {
        Ok(s) => s,
        Err(e) => {
            emit(&json!({
                "type": "control.error",
                "component": node_name,
                "message": format!("invalid ACPFX_SETTINGS: {}", e),
                "fatal": true,
            }));
            std::process::exit(1);
        }
    };

    let cwd = std::env::var("ACPFX_CWD")
        .or_else(|_| std::env::current_dir().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|_| ".".into());

    // Resolve agent command — agentCommand setting overrides registry lookup
    let command: Vec<String> = if let Some(ref cmd) = settings.agent_command {
        cmd.split_whitespace().map(String::from).collect()
    } else {
        agent_registry::resolve_agent_command(&settings.agent)
    };
    emit_log("info", &format!("spawning agent: {}", command.join(" ")));

    // Spawn ACP client
    let mut client = match AcpClient::spawn(&command, vec![]).await {
        Ok(c) => c,
        Err(e) => {
            emit(&json!({
                "type": "control.error",
                "component": node_name,
                "message": format!("failed to spawn agent: {}", e),
                "fatal": true,
            }));
            std::process::exit(1);
        }
    };

    // ACP Initialize handshake
    let init_result = client
        .request(
            "initialize",
            json!({
                "clientName": "acpfx-bridge-acp",
                "clientVersion": env!("CARGO_PKG_VERSION"),
                "protocolVersion": "0.1",
            }),
        )
        .await;

    if let Err(e) = &init_result {
        emit(&json!({
            "type": "control.error",
            "component": node_name,
            "message": format!("initialize failed: {}", e),
            "fatal": true,
        }));
        std::process::exit(1);
    }

    emit_log("info", "agent initialized");

    let session_id = session::setup_session(&mut client, &settings, &cwd, &node_name).await;

    // Emit lifecycle.ready
    emit(&json!({
        "type": "lifecycle.ready",
        "component": node_name,
    }));

    // Main event loops — orchestrator stdin + agent messages
    let (orch_tx, mut orch_rx) = mpsc::channel::<Value>(256);

    // Spawn stdin reader on a blocking thread
    let stdin_node_name = node_name.clone();
    tokio::task::spawn_blocking(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        if orch_tx.blocking_send(event).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // stdin closed — emit lifecycle.done
        emit(&json!({
            "type": "lifecycle.done",
            "component": stdin_node_name,
        }));
    });

    // State
    let mut state = BridgeState::new();
    let permission_mode = settings.permission_mode.clone();

    loop {
        tokio::select! {
            // Events from orchestrator (our stdin)
            Some(event) = orch_rx.recv() => {
                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let event_from = event.get("_from").and_then(|f| f.as_str()).unwrap_or("");

                match event_type {
                    "speech.partial" => {
                        handle_speech_partial(&event, &mut state, &mut client, &session_id).await;
                    }

                    "speech.pause" => {
                        let text = event.get("pendingText").and_then(|t| t.as_str()).unwrap_or("");
                        let text = if text.is_empty() {
                            state.pending_text.clone()
                        } else {
                            text.to_string()
                        };

                        if text.trim().is_empty() {
                            continue;
                        }

                        handle_speech_pause(&text, &mut state, &mut client, &session_id).await;
                    }

                    "prompt.text" => {
                        let text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if text.trim().is_empty() {
                            continue;
                        }

                        if state.streaming {
                            // Agent is busy — queue with its responseMode for later
                            state.pending_prompts.push_back(PendingPrompt {
                                text: text.to_string(),
                                response_mode: "text",
                            });
                            emit_log("info", &format!("queued prompt.text ({} pending)", state.pending_prompts.len()));
                            continue;
                        }

                        handle_prompt_text(text, &mut state, &mut client, &session_id).await;
                    }

                    "control.interrupt" => {
                        // Ignore self-interrupts
                        if event_from == node_name {
                            continue;
                        }

                        handle_control_interrupt(&mut state, &mut client, &session_id).await;
                    }

                    _ => {
                        // Ignore unknown events
                    }
                }
            }

            // Messages from agent process
            msg = client.messages.recv() => {
                match msg {
                    Some(AgentMessage::Notification(notif)) => {
                        let was_streaming = state.streaming;
                        notifications::handle_notification(&notif, &node_name, &mut state, false);

                        // If handle_notification saw "end" and cleared streaming,
                        // drain one queued prompt.
                        if was_streaming && !state.streaming {
                            drain_one_prompt(&mut client, &session_id, &mut state).await;
                        }
                    }
                    Some(AgentMessage::Request(req)) => {
                        notifications::handle_agent_request(&mut client, &req, &permission_mode).await;
                    }
                    Some(AgentMessage::Response(resp)) => {
                        handle_agent_response(&resp, &node_name, &mut state, &mut client, &session_id).await;
                    }
                    None => {
                        // Agent channel closed — agent process died
                        let status_msg = match client.try_wait() {
                            Some(status) => format!("agent process exited: {}", status),
                            None => "agent process died unexpectedly".into(),
                        };
                        emit_log("error", &status_msg);
                        emit(&json!({
                            "type": "control.error",
                            "component": node_name,
                            "message": status_msg,
                            "fatal": true,
                        }));
                        state.streaming = false;
                        state.active_request_id = None;
                        break;
                    }
                }
            }
        }
    }

    emit(&json!({
        "type": "lifecycle.done",
        "component": node_name,
    }));
}

// ---- Orchestrator event handlers ----

async fn handle_speech_partial(
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

async fn handle_speech_pause(
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

async fn handle_prompt_text(
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

async fn handle_control_interrupt(
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

// ---- Agent response handler ----

async fn handle_agent_response(
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
async fn drain_one_prompt(
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

