//! Node Runner — spawns a node as a child process, manages NDJSON stdin/stdout.
//!
//! Each node is a child process that:
//! - Receives NDJSON events on stdin
//! - Emits NDJSON events on stdout
//! - Logs to stderr (forwarded to parent's stderr)
//! - Gets settings via ACPFX_SETTINGS env var
//! - Must emit lifecycle.ready when initialized
//! - Exits on stdin EOF or SIGTERM

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// How to launch a resolved node.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum LaunchType {
    /// Fork via `node <path>` (JS files)
    Fork,
    /// Spawn directly (native binaries, npx)
    Spawn,
}

/// A resolved node ready to spawn.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ResolvedNode {
    pub command: String,
    pub args: Vec<String>,
    pub launch_type: LaunchType,
}

/// Resolve a `use` string to a command + launch strategy.
///
/// When `dist_dir` is Some (debug/dev), tries local resolution first:
///   1. Local JS:     dist/nodes/<name>.js  -> fork via `node`
///   2. Local binary: dist/nodes/<name>     -> spawn directly
///   3. npx fallback
///
/// When `dist_dir` is None (release), goes straight to npx for @acpfx/* packages.
///
/// External paths always resolve directly regardless of mode.
pub fn resolve_node(use_: &str, dist_dir: Option<&Path>) -> ResolvedNode {
    if let Some(name) = use_.strip_prefix("@acpfx/") {
        // Debug/dev: try local dist/ first
        if let Some(dist) = dist_dir {
            let nodes_dir = dist.join("nodes");

            // 1. Local JS bundle
            let js_path = nodes_dir.join(format!("{name}.js"));
            if js_path.exists() {
                return ResolvedNode {
                    command: "node".into(),
                    args: vec![js_path.to_string_lossy().into()],
                    launch_type: LaunchType::Fork,
                };
            }

            // 2. Local native binary
            let bin_path = nodes_dir.join(name);
            if bin_path.exists() {
                return ResolvedNode {
                    command: bin_path.to_string_lossy().into(),
                    args: vec![],
                    launch_type: LaunchType::Spawn,
                };
            }
        }

        // Release (or local not found): use npx
        return ResolvedNode {
            command: "npx".into(),
            args: vec!["-y".into(), use_.into()],
            launch_type: LaunchType::Spawn,
        };
    }

    // External path
    let path = PathBuf::from(use_);
    if use_.ends_with(".js") || use_.ends_with(".mjs") {
        ResolvedNode {
            command: "node".into(),
            args: vec![
                std::fs::canonicalize(&path)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into(),
            ],
            launch_type: LaunchType::Fork,
        }
    } else {
        let abs = std::fs::canonicalize(&path).unwrap_or(path);
        ResolvedNode {
            command: abs.to_string_lossy().into(),
            args: vec![],
            launch_type: LaunchType::Spawn,
        }
    }
}

/// Events emitted by a NodeRunner to the orchestrator.
#[derive(Debug)]
#[allow(dead_code)]
pub enum NodeEvent {
    /// A parsed NDJSON event from the node's stdout.
    Event(serde_json::Value),
    /// The node process exited.
    Exited { code: Option<i32>, name: String },
    /// An error occurred.
    Error { message: String, name: String },
}

/// Handle to a running node process.
pub struct NodeRunner {
    name: String,
    /// Channel to send NDJSON events to the node's stdin.
    stdin_tx: mpsc::Sender<String>,
    /// Handle to the spawned child (for shutdown).
    child: Option<Child>,
    ready_rx: Option<oneshot::Receiver<()>>,
}

impl NodeRunner {
    /// Spawn a node process and start reading its stdout/stderr.
    pub fn spawn(
        name: &str,
        resolved: &ResolvedNode,
        settings: Option<&serde_json::Value>,
        env: &BTreeMap<String, String>,
        event_tx: mpsc::Sender<NodeEvent>,
    ) -> Self {
        let mut cmd = Command::new(&resolved.command);
        cmd.args(&resolved.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Set environment
        cmd.env("ACPFX_NODE_NAME", name);
        if let Some(s) = settings {
            cmd.env("ACPFX_SETTINGS", serde_json::to_string(s).unwrap_or_default());
        }
        for (k, v) in env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().unwrap_or_else(|e| {
            panic!("Failed to spawn node '{name}' ({:?}): {e}", resolved.command);
        });

        let stdin = child.stdin.take().expect("stdin must be piped");
        let stdout = child.stdout.take().expect("stdout must be piped");
        let stderr = child.stderr.take().expect("stderr must be piped");

        // Stdin writer task
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(256);
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        // Ready signal
        let (ready_tx, ready_rx) = oneshot::channel::<()>();
        let mut ready_tx = Some(ready_tx);

        // Stdout reader task — parse NDJSON, detect lifecycle.ready
        let node_name = name.to_string();
        let event_tx_stdout = event_tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(event) => {
                        // Detect lifecycle.ready
                        if event.get("type").and_then(|t| t.as_str()) == Some("lifecycle.ready") {
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(());
                            }
                        }
                        let _ = event_tx_stdout
                            .send(NodeEvent::Event(event))
                            .await;
                    }
                    Err(_) => {
                        let _ = event_tx_stdout
                            .send(NodeEvent::Error {
                                message: format!("Invalid JSON from stdout: {line}"),
                                name: node_name.clone(),
                            })
                            .await;
                    }
                }
            }
        });

        // Stderr reader task — forward to parent stderr
        let node_name_err = name.to_string();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[{node_name_err}] {line}");
            }
        });

        NodeRunner {
            name: name.to_string(),
            stdin_tx,
            child: Some(child),
            ready_rx: Some(ready_rx),
        }
    }

    /// Wait for this node to emit lifecycle.ready.
    pub async fn wait_ready(&mut self, timeout_ms: u64) -> Result<(), String> {
        if let Some(rx) = self.ready_rx.take() {
            match tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                rx,
            )
            .await
            {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) => Err(format!(
                    "Node '{}' stdout closed before lifecycle.ready",
                    self.name
                )),
                Err(_) => Err(format!(
                    "Node '{}' did not become ready within {timeout_ms}ms",
                    self.name
                )),
            }
        } else {
            Ok(()) // Already received ready
        }
    }

    /// Send an NDJSON event to this node's stdin.
    pub async fn send(&self, json: &str) {
        let _ = self.stdin_tx.send(json.to_string()).await;
    }

    /// Gracefully shut down: close stdin, then SIGTERM after timeout.
    pub async fn stop(&mut self, timeout_ms: u64) {
        // Drop stdin sender to close the pipe
        // (The channel will be closed when NodeRunner is dropped or we replace it)

        if let Some(mut child) = self.child.take() {
            // Close stdin by dropping the sender
            drop(std::mem::replace(
                &mut self.stdin_tx,
                mpsc::channel(1).0,
            ));

            // Wait for exit or kill after timeout
            match tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                child.wait(),
            )
            .await
            {
                Ok(_) => {} // Exited cleanly
                Err(_) => {
                    // Timeout — kill
                    let _ = child.kill().await;
                }
            }
        }
    }

    #[allow(dead_code)]
    pub fn name(&self) -> &str {
        &self.name
    }
}
