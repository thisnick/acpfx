//! ACP JSON-RPC client — spawns an agent process and communicates via NDJSON stdio.

use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A pending JSON-RPC request awaiting its response.
type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// Messages from the agent process.
#[derive(Debug)]
pub enum AgentMessage {
    /// A JSON-RPC notification (no `id` field) from the agent.
    Notification(Value),
    /// An agent-initiated JSON-RPC request (has `id` and `method`).
    Request(Value),
    /// A JSON-RPC response not matched by a pending `request()` call.
    /// Used when `send_request()` was used instead of `request()`.
    Response(Value),
}

pub struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    next_id: AtomicU64,
    pending: PendingMap,
    /// Receiver for notifications and agent-initiated requests from the reader task.
    pub messages: mpsc::Receiver<AgentMessage>,
}

impl AcpClient {
    /// Spawn the agent process and start reading its stdout.
    pub async fn spawn(command: &[String], env_vars: Vec<(String, String)>) -> Result<Self, String> {
        let prog = &command[0];
        let args = &command[1..];

        let mut cmd = tokio::process::Command::new(prog);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        for (k, v) in &env_vars {
            cmd.env(k, v);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn agent: {}", e))?;

        let stdin = child.stdin.take().ok_or("failed to get agent stdin")?;
        let stdout = child.stdout.take().ok_or("failed to get agent stdout")?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel(256);

        // Spawn reader task
        let pending_clone = pending.clone();
        tokio::spawn(Self::reader_loop(stdout, pending_clone, tx));

        Ok(Self {
            child,
            stdin,
            next_id: AtomicU64::new(1),
            pending,
            messages: rx,
        })
    }

    /// Send a JSON-RPC request and wait for the response.
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        self.write_message(&msg).await?;

        rx.await.map_err(|_| format!("agent dropped response for request {}", id))
    }

    /// Send a JSON-RPC request but don't wait for the response.
    /// The response will arrive as a `Response` variant on the `messages` channel.
    /// Use this for long-running requests (like session/prompt) where you need
    /// to process notifications while waiting.
    pub async fn send_request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        // Don't register in pending — response will come through messages channel
        self.write_message(&msg).await?;
        Ok(id)
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    #[allow(dead_code)]
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_message(&msg).await
    }

    /// Send a JSON-RPC response (for agent-initiated requests).
    pub async fn respond(&mut self, id: &Value, result: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        self.write_message(&msg).await
    }

    /// Send a JSON-RPC error response.
    pub async fn respond_error(&mut self, id: &Value, code: i64, message: &str) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        });
        self.write_message(&msg).await
    }

    async fn write_message(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("failed to write to agent stdin: {}", e))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("failed to flush agent stdin: {}", e))?;
        Ok(())
    }

    async fn reader_loop(
        stdout: ChildStdout,
        pending: PendingMap,
        tx: mpsc::Sender<AgentMessage>,
    ) {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // Check if this is a response to a pending request
            if let Some(id) = msg.get("id") {
                if msg.get("result").is_some() || msg.get("error").is_some() {
                    // This is a response — check for pending handler first
                    if let Some(id_num) = id.as_u64() {
                        if let Some(sender) = pending.lock().unwrap().remove(&id_num) {
                            let _ = sender.send(msg);
                            continue;
                        }
                    }
                    // No pending handler — sent via send_request(), forward to channel
                    let _ = tx.send(AgentMessage::Response(msg)).await;
                    continue;
                }

                // Has an id and a method — it's an agent-initiated request
                if msg.get("method").is_some() {
                    let _ = tx.send(AgentMessage::Request(msg)).await;
                    continue;
                }
            }

            // No id — it's a notification
            if msg.get("method").is_some() {
                let _ = tx.send(AgentMessage::Notification(msg)).await;
            }
        }

        // Agent stdout closed — drop all pending senders to unblock waiters
        pending.lock().unwrap().clear();
    }

    /// Check if the child process has exited.
    pub fn try_wait(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Kill the child process.
    #[allow(dead_code)]
    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}
