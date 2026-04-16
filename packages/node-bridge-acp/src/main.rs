#![allow(unused_assignments)]
//! bridge-acp node — ACP JSON-RPC bridge for acpfx pipelines.
//!
//! Spawns an ACP agent process once at startup and communicates via JSON-RPC 2.0
//! over NDJSON stdio. Translates between acpfx events (orchestrator channel) and
//! ACP protocol messages (agent channel).

mod acp_client;
mod agent_registry;
mod events;
mod notifications;
mod session;
mod state;

use acp_client::{AcpClient, AgentMessage};
use serde::Deserialize;
use serde_json::{json, Value};
use state::{BridgeState, PendingPrompt};
use std::io::{self, BufRead, Write};
use tokio::sync::mpsc;

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
                        events::handle_speech_partial(&event, &mut state, &mut client, &session_id).await;
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

                        events::handle_speech_pause(&text, &mut state, &mut client, &session_id).await;
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

                        events::handle_prompt_text(text, &mut state, &mut client, &session_id).await;
                    }

                    "control.interrupt" => {
                        // Ignore self-interrupts
                        if event_from == node_name {
                            continue;
                        }

                        events::handle_control_interrupt(&mut state, &mut client, &session_id).await;
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
                            events::drain_one_prompt(&mut client, &session_id, &mut state).await;
                        }
                    }
                    Some(AgentMessage::Request(req)) => {
                        notifications::handle_agent_request(&mut client, &req, &permission_mode).await;
                    }
                    Some(AgentMessage::Response(resp)) => {
                        events::handle_agent_response(&resp, &node_name, &mut state, &mut client, &session_id).await;
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
