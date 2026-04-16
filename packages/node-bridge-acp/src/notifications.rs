use crate::acp_client::AcpClient;
use crate::state::BridgeState;
use crate::{emit, emit_log};
use serde_json::{json, Value};

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_notification(
    notif: &Value,
    _node_name: &str,
    state: &mut BridgeState,
    is_replay: bool,
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
                        let rid = state.active_request_id.clone().unwrap_or_default();
                        state.accumulated_text.push_str(delta);
                        // Mark agent as active on first delta for voice responses
                        // — this enables barge-in and controls speech.pause
                        // accumulation semantics. Text prompts (prompt.text) are
                        // NOT interruptible by speech.partial barge-in.
                        if state.response_mode == "voice" {
                            state.agent_active = true;
                        }
                        emit(&json!({
                            "type": "agent.delta",
                            "requestId": rid,
                            "delta": delta,
                            "seq": state.seq,
                            "responseMode": state.response_mode,
                        }));
                        state.seq += 1;
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
                        let rid = state.active_request_id.clone().unwrap_or_default();
                        emit(&json!({
                            "type": "agent.thinking",
                            "responseMode": state.response_mode,
                            "requestId": rid,
                        }));
                    }
                }

                "tool_call" | "tool_use_begin" => {
                    if !is_replay {
                        let rid = state.active_request_id.clone().unwrap_or_default();
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
                            "responseMode": state.response_mode,
                            "requestId": rid,
                            "toolCallId": tool_call_id,
                            "title": title,
                        }));
                    }
                }

                "tool_call_update" | "tool_use_end" => {
                    if !is_replay {
                        let rid = state.active_request_id.clone().unwrap_or_default();
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
                            "responseMode": state.response_mode,
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
                        if !state.streaming {
                            return;
                        }

                        let rid = state.active_request_id.take().unwrap_or_default();
                        let text = if state.accumulated_text.is_empty() {
                            params
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string()
                        } else {
                            state.accumulated_text.clone()
                        };

                        let mut event = json!({
                            "type": "agent.complete",
                            "requestId": rid,
                            "text": text,
                            "responseMode": state.response_mode,
                        });

                        // Include token usage if provided
                        if let Some(usage) = params.get("tokenUsage").or_else(|| params.get("usage")) {
                            event["tokenUsage"] = usage.clone();
                        }

                        emit(&event);
                        state.streaming = false;
                        state.agent_active = false;
                        state.accumulated_text.clear();
                        state.seq = 0;
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

pub(crate) async fn handle_agent_request(client: &mut AcpClient, req: &Value, permission_mode: &str) {
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
