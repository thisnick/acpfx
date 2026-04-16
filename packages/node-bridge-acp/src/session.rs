use crate::acp_client::AcpClient;
use crate::notifications::handle_notification;
use crate::state::BridgeState;
use crate::{emit, emit_log, Settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

pub(crate) async fn setup_session(
    client: &mut AcpClient,
    settings: &Settings,
    cwd: &str,
    node_name: &str,
) -> String {
    // Session: load or create
    let prior_session = load_session(cwd, &settings.agent, &settings.session);
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
                        delete_session(cwd, &settings.agent, &settings.session);
                    }
                }
            }
            Err(e) => {
                emit_log("warn", &format!("session/load failed ({}), deleting stale session and creating new", e));
                delete_session(cwd, &settings.agent, &settings.session);
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
        save_session(cwd, &settings.agent, &settings.session, &session_id);
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
        let mut replay_state = BridgeState::new();
        while let Ok(msg) = client.messages.try_recv() {
            if let crate::acp_client::AgentMessage::Notification(notif) = msg {
                handle_notification(
                    &notif, node_name, &mut replay_state,
                    true, // is_replay = true
                );
                replay_count += 1;
            }
        }
        if replay_count > 0 {
            emit_log("info", &format!("replayed {} history events", replay_count));
        }
    }

    session_id
}
