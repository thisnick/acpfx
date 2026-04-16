#![allow(unused_assignments)]
//! bridge-acp node — ACP JSON-RPC bridge for acpfx pipelines.
//!
//! Spawns an ACP agent process once at startup and communicates via JSON-RPC 2.0
//! over NDJSON stdio. Translates between acpfx events (orchestrator channel) and
//! ACP protocol messages (agent channel).

mod acp_client;
mod agent_registry;

use acp_client::{AcpClient, AgentMessage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{self, BufRead, Write};
use tokio::sync::mpsc;
use uuid::Uuid;

/// A queued prompt with its own response mode, used for prompt.text entries
/// that arrive while the agent is busy streaming a response.
struct PendingPrompt {
    text: String,
    response_mode: &'static str,
}

/// Manifest YAML embedded at compile time.
const MANIFEST_YAML: &str = include_str!("../manifest.yaml");

// ---- Settings ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    agent: String,
    #[serde(default = "default_session")]
    session: String,
    #[serde(default = "default_permission_mode")]
    permission_mode: String,
    #[serde(default)]
    agent_command: Option<String>,
}

fn default_session() -> String {
    "default".into()
}

fn default_permission_mode() -> String {
    "approve-all".into()
}

// ---- Session persistence ----

#[derive(Debug, Serialize, Deserialize)]
struct SessionRecord {
    cwd: String,
    agent: String,
    session_name: String,
    acp_session_id: String,
}

fn sessions_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("ACPFX_SESSION_DIR") {
        return std::path::PathBuf::from(dir);
    }
    dirs_path().join("sessions")
}

fn dirs_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home).join(".acpfx")
}

fn session_file_path(cwd: &str, agent: &str, session_name: &str) -> std::path::PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    cwd.hash(&mut hasher);
    agent.hash(&mut hasher);
    session_name.hash(&mut hasher);
    let hash = hasher.finish();

    sessions_dir().join(format!("{:x}.json", hash))
}

fn load_session(cwd: &str, agent: &str, session_name: &str) -> Option<SessionRecord> {
    let path = session_file_path(cwd, agent, session_name);
    let data = std::fs::read_to_string(&path).ok()?;
    let record: SessionRecord = serde_json::from_str(&data).ok()?;
    // Verify it matches
    if record.cwd == cwd && record.agent == agent && record.session_name == session_name {
        Some(record)
    } else {
        None
    }
}

fn save_session(cwd: &str, agent: &str, session_name: &str, acp_session_id: &str) {
    let _ = std::fs::create_dir_all(sessions_dir());
    let path = session_file_path(cwd, agent, session_name);
    let record = SessionRecord {
        cwd: cwd.into(),
        agent: agent.into(),
        session_name: session_name.into(),
        acp_session_id: acp_session_id.into(),
    };
    let data = serde_json::to_string_pretty(&record).unwrap();
    let _ = std::fs::write(path, data);
}

fn delete_session(cwd: &str, agent: &str, session_name: &str) {
    let path = session_file_path(cwd, agent, session_name);
    let _ = std::fs::remove_file(path);
}

/// Extract sessionId from a JSON-RPC response, returning Err if the response
/// contains an "error" field (i.e. the server returned an error response).
fn extract_session_id(resp: &Value) -> Result<String, String> {
    if let Some(err) = resp.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("code:{} message:{}", code, message));
    }
    resp.get("result")
        .and_then(|r| r.get("sessionId"))
        .and_then(|s| s.as_str())
        .map(String::from)
        .ok_or_else(|| "missing result.sessionId in response".to_string())
}

// ---- Event emitting ----

fn emit(event: &Value) {
    let mut out = io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, event);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn emit_log(level: &str, message: &str) {
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

    // Session: load or create
    let prior_session = load_session(&cwd, &settings.agent, &settings.session);
    let mut session_id: String = String::new();

    // Try to load a prior session; on any failure, delete the stale record and create new.
    let mut need_new_session = true;

    if let Some(record) = prior_session {
        emit_log(
            "info",
            &format!("resuming session: {}", record.acp_session_id),
        );
        let load_result = client
            .request(
                "session/load",
                json!({
                    "sessionId": record.acp_session_id,
                    "cwd": cwd,
                    "mcpServers": [],
                }),
            )
            .await;

        match load_result {
            Ok(resp) => {
                match extract_session_id(&resp) {
                    Ok(id) => {
                        session_id = id;
                        need_new_session = false;
                    }
                    Err(e) => {
                        emit_log("warn", &format!("session/load returned error ({}), deleting stale session and creating new", e));
                        delete_session(&cwd, &settings.agent, &settings.session);
                    }
                }
            }
            Err(e) => {
                emit_log("warn", &format!("session/load failed ({}), deleting stale session and creating new", e));
                delete_session(&cwd, &settings.agent, &settings.session);
            }
        }
    } else {
        emit_log("info", "no prior session, creating new");
    }

    if need_new_session {
        let new_result = client.request("session/new", json!({"cwd": cwd, "mcpServers": []})).await;
        match new_result {
            Ok(resp) => {
                emit_log("debug", &format!("session/new response: {}", serde_json::to_string(&resp).unwrap_or_default()));
                match extract_session_id(&resp) {
                    Ok(id) => {
                        session_id = id;
                    }
                    Err(e) => {
                        emit(&json!({
                            "type": "control.error",
                            "component": node_name,
                            "message": format!("session/new returned error: {}", e),
                            "fatal": true,
                        }));
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                emit(&json!({
                    "type": "control.error",
                    "component": node_name,
                    "message": format!("session/new failed: {}", e),
                    "fatal": true,
                }));
                std::process::exit(1);
            }
        }
    }

    if session_id != "unknown" && !session_id.is_empty() {
        save_session(&cwd, &settings.agent, &settings.session, &session_id);
    }
    emit_log("info", &format!("session ready: {}", session_id));

    // Set permission mode on the agent session
    if settings.permission_mode == "approve-all" {
        match client.request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "mode", "value": "bypassPermissions"}),
        ).await {
            Ok(resp) => {
                if let Some(err) = resp.get("error") {
                    let message = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
                    emit_log("warn", &format!("session/set_config_option error: {}", message));
                } else {
                    emit_log("info", "set agent mode to bypassPermissions");
                }
            }
            Err(e) => {
                emit_log("warn", &format!("session/set_config_option failed: {}", e));
            }
        }
    }

    // Drain any replay notifications that arrived during session/load.
    // These are buffered in client.messages while request() was awaiting.
    {
        let mut replay_count = 0u32;
        while let Ok(msg) = client.messages.try_recv() {
            if let crate::acp_client::AgentMessage::Notification(notif) = msg {
                let mut _rid: Option<String> = None;
                let mut _streaming = false;
                let mut _agent_active = false;
                let mut _text = String::new();
                let mut _seq = 0u64;
                handle_notification(
                    &notif, &node_name, &mut _rid, &mut _streaming, &mut _agent_active, &mut _text, &mut _seq,
                    true, // is_replay = true
                    "voice",
                );
                replay_count += 1;
            }
        }
        if replay_count > 0 {
            emit_log("info", &format!("replayed {} history events", replay_count));
        }
    }

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
    let mut active_request_id: Option<String> = None;
    let mut streaming = false;
    let mut agent_active = false; // true from first voice prompt until next speech.pause — barge-in window
    let mut accumulated_text = String::new();
    let mut seq: u64 = 0;
    let mut pending_text = String::new(); // last speech.partial text (used as fallback in speech.pause)
    let mut pending_prompts: VecDeque<PendingPrompt> = VecDeque::new();
    let mut response_mode: &str = "voice"; // "voice" for speech.pause, "text" for prompt.text
    let mut active_prompt_rpc_id: Option<u64> = None; // JSON-RPC id of current send_request
    let permission_mode = settings.permission_mode.clone();
    let replaying = false; // always false in main loop — replay handled above

    loop {
        tokio::select! {
            // Events from orchestrator (our stdin)
            Some(event) = orch_rx.recv() => {
                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let event_from = event.get("_from").and_then(|f| f.as_str()).unwrap_or("");

                match event_type {
                    "speech.partial" => {
                        let text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        pending_text = text.to_string();

                        // Barge-in: if agent responded (even if done streaming), interrupt
                        if agent_active && !text.is_empty() {
                            emit_log("info", "barge-in detected, interrupting");
                            emit(&json!({
                                "type": "control.interrupt",
                                "reason": "barge-in",
                            }));
                            streaming = false;
                            // Send cancel as notification (no response expected)
                            let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
                            active_request_id = None;
                            active_prompt_rpc_id = None;
                            accumulated_text.clear();
                            agent_active = false;
                        }
                    }

                    "speech.pause" => {
                        let text = event.get("pendingText").and_then(|t| t.as_str()).unwrap_or("");
                        let text = if text.is_empty() { &pending_text } else { text };

                        if text.trim().is_empty() {
                            continue;
                        }

                        response_mode = "voice";

                        // Always emit interrupt to cancel downstream TTS/playback
                        emit(&json!({
                            "type": "control.interrupt",
                            "reason": "user_speech",
                        }));

                        if agent_active {
                            let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
                            if streaming {
                                // Agent started responding but still streaming —
                                // accumulate (user speaking in rapid chunks)
                                emit_log("debug", "speech.pause: agent_active+streaming, canceling and appending");
                                if accumulated_text.is_empty() {
                                    accumulated_text = text.to_string();
                                } else {
                                    accumulated_text.push(' ');
                                    accumulated_text.push_str(text);
                                }
                            } else {
                                // Agent finished responding — new turn, replace
                                emit_log("debug", "speech.pause: agent_active+done, replacing accumulatedText");
                                accumulated_text = text.to_string();
                            }
                            agent_active = false;
                        } else if streaming {
                            // Submitted but agent hasn't responded yet — cancel and append
                            emit_log("debug", "speech.pause: streaming (no delta yet), canceling and appending");
                            let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
                            if accumulated_text.is_empty() {
                                accumulated_text = text.to_string();
                            } else {
                                accumulated_text.push(' ');
                                accumulated_text.push_str(text);
                            }
                        } else {
                            // Fresh submission
                            emit_log("debug", "speech.pause: fresh submission");
                            if accumulated_text.is_empty() {
                                accumulated_text = text.to_string();
                            } else {
                                accumulated_text.push(' ');
                                accumulated_text.push_str(text);
                            }
                        }

                        // Always submit immediately (never queue voice prompts)
                        // Note: agent_active is NOT set here — it's set in
                        // handle_notification when the first delta arrives,
                        // matching the TS agentResponding semantics.
                        let submit_text = accumulated_text.clone();
                        let request_id = Uuid::new_v4().to_string();
                        active_request_id = Some(request_id.clone());
                        streaming = true;
                        seq = 0;

                        emit(&json!({
                            "type": "agent.submit",
                            "requestId": request_id,
                            "text": submit_text,
                            "responseMode": response_mode,
                        }));

                        emit_log("info", &format!("sending prompt to agent (session={}): {}", &session_id[..8.min(session_id.len())], &submit_text[..80.min(submit_text.len())]));
                        match client
                            .send_request("session/prompt", json!({
                                "sessionId": session_id,
                                "prompt": [{"type": "text", "text": submit_text}]
                            }))
                            .await
                        {
                            Ok(rpc_id) => { active_prompt_rpc_id = Some(rpc_id); }
                            Err(e) => {
                                emit_log("error", &format!("failed to send prompt: {}", e));
                                streaming = false;
                                active_request_id = None;
                                active_prompt_rpc_id = None;
                            }
                        }

                        pending_text.clear();
                    }

                    "prompt.text" => {
                        let text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if text.trim().is_empty() {
                            continue;
                        }

                        if streaming {
                            // Agent is busy — queue with its responseMode for later
                            pending_prompts.push_back(PendingPrompt {
                                text: text.to_string(),
                                response_mode: "text",
                            });
                            emit_log("info", &format!("queued prompt.text ({} pending)", pending_prompts.len()));
                            continue;
                        }

                        response_mode = "text";
                        // Do NOT set agent_active — text prompts are not interruptible
                        // by speech.partial barge-in

                        let request_id = Uuid::new_v4().to_string();
                        active_request_id = Some(request_id.clone());
                        streaming = true;
                        accumulated_text.clear();
                        seq = 0;

                        emit(&json!({
                            "type": "agent.submit",
                            "requestId": request_id,
                            "text": text,
                            "responseMode": response_mode,
                        }));

                        match client
                            .send_request("session/prompt", json!({
                                "sessionId": session_id,
                                "prompt": [{"type": "text", "text": text.to_string()}]
                            }))
                            .await
                        {
                            Ok(rpc_id) => { active_prompt_rpc_id = Some(rpc_id); }
                            Err(e) => {
                                emit_log("error", &format!("failed to send prompt: {}", e));
                                streaming = false;
                                active_request_id = None;
                                active_prompt_rpc_id = None;
                            }
                        }
                    }

                    "control.interrupt" => {
                        // Ignore self-interrupts
                        if event_from == node_name {
                            continue;
                        }

                        if streaming {
                            streaming = false;
                            let _ = client.notify("session/cancel", json!({"sessionId": session_id})).await;
                            active_request_id = None;
                            active_prompt_rpc_id = None;
                            accumulated_text.clear();
                        }
                        agent_active = false;
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
                        let was_streaming = streaming;
                        handle_notification(&notif, &node_name, &mut active_request_id, &mut streaming, &mut agent_active, &mut accumulated_text, &mut seq, replaying, response_mode);

                        // If handle_notification saw "end" and cleared streaming,
                        // drain one queued prompt.
                        if was_streaming && !streaming {
                            drain_one_prompt(
                                &mut client, &session_id, &mut pending_prompts,
                                &mut response_mode, &mut agent_active, &mut active_request_id,
                                &mut active_prompt_rpc_id, &mut streaming, &mut seq,
                            ).await;
                        }
                    }
                    Some(AgentMessage::Request(req)) => {
                        handle_agent_request(&mut client, &req, &permission_mode).await;
                    }
                    Some(AgentMessage::Response(resp)) => {
                        // This is the JSON-RPC response to send_request("session/prompt").
                        // Real ACP agents (e.g. claude-agent-acp) signal completion
                        // via this response (with result.stopReason and result.usage),
                        // NOT via a separate "end" notification. We emit agent.complete
                        // here for success, and handle errors below.

                        // Ignore stale responses from cancelled prompts
                        let resp_id = resp.get("id").and_then(|id| id.as_u64());
                        if resp_id.is_some() && resp_id != active_prompt_rpc_id {
                            emit_log("debug", &format!("ignoring stale response (id={:?}, active={:?})", resp_id, active_prompt_rpc_id));
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
                            streaming = false;
                            agent_active = false;
                            active_request_id = None;
                            active_prompt_rpc_id = None;
                            accumulated_text.clear();
                            seq = 0;

                            // Drain one queued prompt on error recovery
                            drain_one_prompt(
                                &mut client, &session_id, &mut pending_prompts,
                                &mut response_mode, &mut agent_active, &mut active_request_id,
                                &mut active_prompt_rpc_id, &mut streaming, &mut seq,
                            ).await;
                        } else if resp_id.is_some() && resp_id == active_prompt_rpc_id {
                            // Successful response to session/prompt — this IS the
                            // completion signal from real ACP agents (e.g. claude-agent-acp).
                            // The response contains result.stopReason and result.usage.
                            let result = resp.get("result").cloned().unwrap_or(json!({}));

                            let rid = active_request_id.take().unwrap_or_default();
                            let text = accumulated_text.clone();

                            let mut event = json!({
                                "type": "agent.complete",
                                "requestId": rid,
                                "text": text,
                                "responseMode": response_mode,
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
                            streaming = false;
                            agent_active = false;
                            active_request_id = None;
                            active_prompt_rpc_id = None;
                            accumulated_text.clear();
                            seq = 0;

                            // Drain one queued prompt
                            drain_one_prompt(
                                &mut client, &session_id, &mut pending_prompts,
                                &mut response_mode, &mut agent_active, &mut active_request_id,
                                &mut active_prompt_rpc_id, &mut streaming, &mut seq,
                            ).await;
                        }
                        // else: response without matching active id and no error — ignore
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
                        streaming = false;
                        active_request_id = None;
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

#[allow(clippy::too_many_arguments)]
fn handle_notification(
    notif: &Value,
    _node_name: &str,
    active_request_id: &mut Option<String>,
    streaming: &mut bool,
    agent_active: &mut bool,
    accumulated_text: &mut String,
    seq: &mut u64,
    is_replay: bool,
    response_mode: &str,
) {
    let method = notif
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let params = notif.get("params").cloned().unwrap_or(json!({}));

    match method {
        "session/update" => {
            // ACP session/update format: params.update.sessionUpdate
            let update = params.get("update").cloned().unwrap_or(json!({}));
            let update_type = update
                .get("sessionUpdate")
                .and_then(|t| t.as_str())
                // Fallback to params.type for compatibility
                .or_else(|| params.get("type").and_then(|t| t.as_str()))
                .unwrap_or("");

            match update_type {
                "agent_message_chunk" | "text_delta" | "agent_text_chunk" => {
                    // ACP format: update.content.text
                    let delta = update
                        .get("content")
                        .and_then(|c| c.get("text"))
                        .and_then(|t| t.as_str())
                        // Fallback for other formats
                        .or_else(|| params.get("delta").and_then(|d| d.as_str()))
                        .or_else(|| params.get("text").and_then(|d| d.as_str()))
                        .unwrap_or("");

                    if is_replay {
                        emit(&json!({
                            "type": "agent.history",
                            "role": "assistant",
                            "text": delta,
                        }));
                    } else {
                        let rid = active_request_id.clone().unwrap_or_default();
                        accumulated_text.push_str(delta);
                        // Mark agent as active on first delta for voice responses
                        // — this enables barge-in and controls speech.pause
                        // accumulation semantics. Text prompts (prompt.text) are
                        // NOT interruptible by speech.partial barge-in.
                        if response_mode == "voice" {
                            *agent_active = true;
                        }
                        emit(&json!({
                            "type": "agent.delta",
                            "requestId": rid,
                            "delta": delta,
                            "seq": *seq,
                            "responseMode": response_mode,
                        }));
                        *seq += 1;
                    }
                }

                "user_message_chunk" | "user_text" | "user_message" => {
                    // ACP format: update.content.text
                    let text = update
                        .get("content")
                        .and_then(|c| c.get("text"))
                        .and_then(|t| t.as_str())
                        .or_else(|| params.get("text").and_then(|t| t.as_str()))
                        .unwrap_or("");
                    if is_replay && !text.is_empty() {
                        // Filter out internal command XML (e.g. <command-name>...</command-name>)
                        if !text.starts_with('<') {
                            emit(&json!({
                                "type": "agent.history",
                                "role": "user",
                                "text": text,
                            }));
                        }
                    }
                }

                "agent_thought_chunk" | "thinking" => {
                    if !is_replay {
                        let rid = active_request_id.clone().unwrap_or_default();
                        emit(&json!({
                            "type": "agent.thinking",
                            "responseMode": response_mode,
                            "requestId": rid,
                        }));
                    }
                }

                "tool_call" | "tool_use_begin" => {
                    if !is_replay {
                        let rid = active_request_id.clone().unwrap_or_default();
                        let tool_call_id = update
                            .get("toolCallId")
                            .or_else(|| params.get("toolCallId"))
                            .or_else(|| params.get("id"))
                            .and_then(|id| id.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let title = update
                            .get("name")
                            .or_else(|| params.get("name"))
                            .or_else(|| params.get("title"))
                            .and_then(|t| t.as_str())
                            .map(String::from);
                        emit(&json!({
                            "type": "agent.tool_start",
                            "responseMode": response_mode,
                            "requestId": rid,
                            "toolCallId": tool_call_id,
                            "title": title,
                        }));
                    }
                }

                "tool_call_update" | "tool_use_end" => {
                    if !is_replay {
                        let rid = active_request_id.clone().unwrap_or_default();
                        let tool_call_id = update
                            .get("toolCallId")
                            .or_else(|| params.get("toolCallId"))
                            .or_else(|| params.get("id"))
                            .and_then(|id| id.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let status = update
                            .get("status")
                            .or_else(|| params.get("status"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("done")
                            .to_string();
                        emit(&json!({
                            "type": "agent.tool_done",
                            "responseMode": response_mode,
                            "requestId": rid,
                            "toolCallId": tool_call_id,
                            "status": status,
                        }));
                    }
                }

                "end" | "complete" => {
                    if !is_replay {
                        // Guard against double-fire: if the Response handler
                        // already emitted agent.complete and cleared streaming,
                        // skip this fallback path.
                        if !*streaming {
                            return;
                        }

                        let rid = active_request_id.take().unwrap_or_default();
                        let text = if accumulated_text.is_empty() {
                            params
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string()
                        } else {
                            accumulated_text.clone()
                        };

                        let mut event = json!({
                            "type": "agent.complete",
                            "requestId": rid,
                            "text": text,
                            "responseMode": response_mode,
                        });

                        // Include token usage if provided
                        if let Some(usage) = params.get("tokenUsage").or_else(|| params.get("usage")) {
                            event["tokenUsage"] = usage.clone();
                        }

                        emit(&event);
                        *streaming = false;
                        *agent_active = false;
                        accumulated_text.clear();
                        *seq = 0;
                    }
                }

                // Known but unhandled update types — silently ignore
                "usage_update" | "available_commands_update" | "config_option_update"
                | "current_mode_update" | "session_info_update" => {}

                _ => {
                    emit_log(
                        "debug",
                        &format!("unknown session/update type: {}", update_type),
                    );
                }
            }
        }

        _ => {
            emit_log(
                "debug",
                &format!("unknown notification method: {}", method),
            );
        }
    }
}

/// Drain one queued prompt if available — sends it to the agent and updates state.
#[allow(clippy::too_many_arguments)]
async fn drain_one_prompt(
    client: &mut AcpClient,
    session_id: &str,
    pending_prompts: &mut VecDeque<PendingPrompt>,
    response_mode: &mut &str,
    agent_active: &mut bool,
    active_request_id: &mut Option<String>,
    active_prompt_rpc_id: &mut Option<u64>,
    streaming: &mut bool,
    seq: &mut u64,
) {
    if let Some(next) = pending_prompts.pop_front() {
        emit_log("info", &format!(
            "draining queued prompt: \"{}\" ({} remaining)",
            &next.text[..80.min(next.text.len())],
            pending_prompts.len()
        ));
        *response_mode = next.response_mode;
        *agent_active = false;

        let request_id = Uuid::new_v4().to_string();
        *active_request_id = Some(request_id.clone());
        *streaming = true;
        *seq = 0;

        emit(&json!({
            "type": "agent.submit",
            "requestId": request_id,
            "text": next.text,
            "responseMode": *response_mode,
        }));

        match client
            .send_request("session/prompt", json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": next.text}]
            }))
            .await
        {
            Ok(rpc_id) => { *active_prompt_rpc_id = Some(rpc_id); }
            Err(e) => {
                emit_log("error", &format!("failed to send queued prompt: {}", e));
                *streaming = false;
                *active_request_id = None;
                *active_prompt_rpc_id = None;
            }
        }
    }
}

async fn handle_agent_request(client: &mut AcpClient, req: &Value, permission_mode: &str) {
    let method = req
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let id = req.get("id").cloned().unwrap_or(json!(null));
    let params = req.get("params").cloned().unwrap_or(json!({}));

    match method {
        "session/request_permission" => {
            let options = params
                .get("options")
                .and_then(|o| o.as_array())
                .cloned()
                .unwrap_or_default();

            let allow_id = options.iter()
                .find(|o| {
                    let oid = o.get("optionId").and_then(|i| i.as_str()).unwrap_or("");
                    oid == "allow_once" || oid == "allow_always"
                })
                .and_then(|o| o.get("optionId").and_then(|i| i.as_str()))
                .or_else(|| options.first().and_then(|o| o.get("optionId").and_then(|i| i.as_str())));

            let reject_id = options.iter()
                .find(|o| {
                    let oid = o.get("optionId").and_then(|i| i.as_str()).unwrap_or("");
                    oid == "reject_once" || oid == "reject_always"
                })
                .and_then(|o| o.get("optionId").and_then(|i| i.as_str()));

            let outcome = match permission_mode {
                "approve-all" => {
                    if let Some(aid) = allow_id {
                        json!({"outcome": "selected", "optionId": aid})
                    } else {
                        json!({"outcome": "selected", "optionId": options.first().and_then(|o| o.get("optionId").and_then(|i| i.as_str())).unwrap_or("allow_once")})
                    }
                }
                "deny-all" => {
                    if let Some(rid) = reject_id {
                        json!({"outcome": "selected", "optionId": rid})
                    } else {
                        json!({"outcome": "cancelled"})
                    }
                }
                _ => {
                    if let Some(aid) = allow_id {
                        json!({"outcome": "selected", "optionId": aid})
                    } else {
                        json!({"outcome": "cancelled"})
                    }
                }
            };

            let _ = client
                .respond(&id, json!({ "outcome": outcome }))
                .await;
        }

        "fs/read_text_file" => {
            let path = params
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            match tokio::fs::read_to_string(path).await {
                Ok(content) => {
                    let _ = client.respond(&id, json!({ "content": content })).await;
                }
                Err(e) => {
                    let _ = client
                        .respond_error(&id, -32000, &format!("read failed: {}", e))
                        .await;
                }
            }
        }

        "fs/write_text_file" => {
            let path = params
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let content = params
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            match tokio::fs::write(path, content).await {
                Ok(_) => {
                    let _ = client.respond(&id, json!({ "success": true })).await;
                }
                Err(e) => {
                    let _ = client
                        .respond_error(&id, -32000, &format!("write failed: {}", e))
                        .await;
                }
            }
        }

        _ => {
            let _ = client
                .respond_error(&id, -32601, &format!("method not found: {}", method))
                .await;
        }
    }
}
