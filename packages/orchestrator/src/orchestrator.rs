//! Orchestrator — the DAG executor.
//!
//! 1. Loads YAML config
//! 2. Builds + validates DAG
//! 3. Spawns each node via NodeRunner
//! 4. Waits for all lifecycle.ready
//! 5. Routes events: reads from each node's stdout, stamps ts/_from, writes to destination stdin
//! 6. Propagates control.interrupt to downstream nodes
//! 7. Forwards all events to observer callback
//! 8. Clean shutdown on stop()

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::config::{load_config, parse_config, PipelineConfig};
use crate::dag::{build_dag, node_consumes_event, Dag};
use crate::node_runner::{resolve_node, NodeEvent, NodeRunner};

/// Manifest loaded from a node's co-located manifest file.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct NodeManifest {
    pub name: Option<String>,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub emits: Vec<String>,
}

pub struct Orchestrator {
    config: PipelineConfig,
    dag: Dag,
    runners: BTreeMap<String, NodeRunner>,
    event_tx: mpsc::Sender<(String, NodeEvent)>,
    event_rx: Option<mpsc::Receiver<(String, NodeEvent)>>,
    dist_dir: PathBuf,
    ready_timeout_ms: u64,
    stopped: bool,
}

impl Orchestrator {
    /// Create from a YAML file path.
    pub fn from_file(path: &Path, dist_dir: &Path) -> Result<Self, String> {
        let config =
            load_config(path).map_err(|e| format!("Failed to load config: {e}"))?;
        Ok(Self::new(config, dist_dir))
    }

    /// Create from a YAML string.
    #[allow(dead_code)]
    pub fn from_yaml(yaml: &str, dist_dir: &Path) -> Result<Self, String> {
        let config =
            parse_config(yaml).map_err(|e| format!("Failed to parse config: {e}"))?;
        Ok(Self::new(config, dist_dir))
    }

    fn new(config: PipelineConfig, dist_dir: &Path) -> Self {
        let dag = build_dag(&config);
        let (event_tx, event_rx) = mpsc::channel(1024);
        Orchestrator {
            config,
            dag,
            runners: BTreeMap::new(),
            event_tx,
            event_rx: Some(event_rx),
            dist_dir: dist_dir.to_path_buf(),
            ready_timeout_ms: 10000,
            stopped: false,
        }
    }

    pub fn set_ready_timeout(&mut self, ms: u64) {
        self.ready_timeout_ms = ms;
    }

    /// Get manifest data for all nodes (for UI rendering).
    /// Returns (name, use_, emits) tuples in config declaration order.
    pub fn get_manifests(&self) -> Vec<(String, String, Vec<String>)> {
        self.config
            .nodes
            .keys()
            .filter_map(|name| {
                self.dag.nodes.get(name).map(|n| {
                    (n.name.clone(), n.use_.clone(), n.emits.clone())
                })
            })
            .collect()
    }

    /// Load manifests for all nodes from co-located manifest files.
    fn load_manifests(&mut self) {
        for (name, dag_node) in &mut self.dag.nodes {
            let resolved = resolve_node(&dag_node.use_, &self.dist_dir);
            // Strip extension from command to find manifest base path
            let cmd = if resolved.args.is_empty() {
                &resolved.command
            } else {
                // For fork (node <path>), the path is args[0]
                resolved.args.first().unwrap_or(&resolved.command)
            };
            let base_path = if cmd.ends_with(".js") || cmd.ends_with(".mjs") {
                cmd.rsplit_once('.').map(|(b, _)| b.to_string()).unwrap_or(cmd.to_string())
            } else {
                cmd.to_string()
            };

            // Try YAML first, then JSON
            let yaml_path = format!("{base_path}.manifest.yaml");
            let json_path = format!("{base_path}.manifest.json");

            let manifest: Option<NodeManifest> = if Path::new(&yaml_path).exists() {
                match std::fs::read_to_string(&yaml_path) {
                    Ok(content) => serde_yaml::from_str(&content).ok(),
                    Err(_) => None,
                }
            } else if Path::new(&json_path).exists() {
                match std::fs::read_to_string(&json_path) {
                    Ok(content) => serde_json::from_str(&content).ok(),
                    Err(_) => None,
                }
            } else {
                None
            };

            if let Some(m) = manifest {
                dag_node.consumes = m.consumes;
                dag_node.emits = m.emits;
            } else {
                eprintln!(
                    "[orchestrator] WARN: no manifest for '{name}' — accepting all events (permissive mode)"
                );
            }
        }

        // Validate edge compatibility
        type NodeInfo = (Vec<String>, Vec<String>, Vec<String>);
        let nodes_snapshot: BTreeMap<String, NodeInfo> = self
            .dag
            .nodes
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    (v.emits.clone(), v.outputs.clone(), v.consumes.clone()),
                )
            })
            .collect();

        for (name, (emits, outputs, _)) in &nodes_snapshot {
            if emits.is_empty() {
                continue;
            }
            for dest in outputs {
                if let Some((_, _, dest_consumes)) = nodes_snapshot.get(dest) {
                    if dest_consumes.is_empty() {
                        continue;
                    }
                    let overlap = emits.iter().any(|e| dest_consumes.contains(e));
                    if !overlap {
                        eprintln!(
                            "[orchestrator] WARN: edge {name} -> {dest} has no event overlap \
                             (emits: [{}], consumes: [{}])",
                            emits.join(","),
                            dest_consumes.join(","),
                        );
                    }
                }
            }
        }
    }

    /// Start the pipeline: load manifests, spawn all nodes, wait for ready, begin routing.
    pub async fn start(&mut self) -> Result<(), String> {
        self.load_manifests();

        // Spawn nodes in topological order
        let order = self.dag.order.clone();
        for name in &order {
            let dag_node = self.dag.nodes.get(name).unwrap();
            let resolved = resolve_node(&dag_node.use_, &self.dist_dir);

            // Create a per-node event sender that tags events with the node name
            let node_name = name.clone();
            let tx = self.event_tx.clone();
            let node_tx = mpsc::channel::<NodeEvent>(256);
            let (ntx, mut nrx) = node_tx;

            // Forward per-node events to the central channel tagged with node name
            let name_for_task = node_name.clone();
            tokio::spawn(async move {
                while let Some(event) = nrx.recv().await {
                    let _ = tx.send((name_for_task.clone(), event)).await;
                }
            });

            let runner = NodeRunner::spawn(
                name,
                &resolved,
                dag_node.settings.as_ref(),
                &self.config.env,
                ntx,
            );
            self.runners.insert(name.clone(), runner);
        }

        // Wait for all nodes to be ready
        let timeout = self.ready_timeout_ms;
        for name in &order {
            if let Some(runner) = self.runners.get_mut(name) {
                runner.wait_ready(timeout).await?;
            }
        }

        Ok(())
    }

    /// Run the event routing loop. Call after start(). Returns when all nodes exit or stop() is called.
    pub async fn run(
        &mut self,
        mut on_event: impl FnMut(&serde_json::Value),
    ) {
        let mut event_rx = self.event_rx.take().expect("run() called twice");

        while let Some((from_node, node_event)) = event_rx.recv().await {
            if self.stopped {
                break;
            }

            match node_event {
                NodeEvent::Event(mut event) => {
                    // Stamp with ts and _from
                    let ts = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if let serde_json::Value::Object(ref mut map) = event {
                        map.insert("ts".into(), serde_json::json!(ts));
                        map.insert("_from".into(), serde_json::json!(from_node));
                    }

                    // Notify observer
                    on_event(&event);

                    let event_type = event
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();

                    let serialized = serde_json::to_string(&event).unwrap_or_default();

                    // Route to destination nodes per DAG edges, filtered by manifest
                    if let Some(dag_node) = self.dag.nodes.get(&from_node) {
                        let outputs = dag_node.outputs.clone();
                        for dest in &outputs {
                            if let Some(dest_node) = self.dag.nodes.get(dest) {
                                if node_consumes_event(dest_node, &event_type) {
                                    if let Some(runner) = self.runners.get(dest) {
                                        runner.send(&serialized).await;
                                    }
                                }
                            }
                        }
                    }

                    // Log events broadcast to all nodes that consume them
                    if event_type == "log" {
                        let outputs: Vec<String> = self
                            .dag
                            .nodes
                            .get(&from_node)
                            .map(|n| n.outputs.clone())
                            .unwrap_or_default();

                        for (name, dag_node) in &self.dag.nodes {
                            if *name == from_node {
                                continue;
                            }
                            if outputs.contains(name) {
                                continue;
                            }
                            if node_consumes_event(dag_node, "log") {
                                if let Some(runner) = self.runners.get(name) {
                                    runner.send(&serialized).await;
                                }
                            }
                        }
                    }

                    // control.interrupt: propagate to transitive downstream
                    if event_type == "control.interrupt" {
                        if let Some(downstream) = self.dag.downstream.get(&from_node) {
                            let downstream = downstream.clone();
                            for name in &downstream {
                                if let Some(dest_node) = self.dag.nodes.get(name) {
                                    if node_consumes_event(dest_node, "control.interrupt") {
                                        if let Some(runner) = self.runners.get(name) {
                                            runner.send(&serialized).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                NodeEvent::Exited { code, name } => {
                    if let Some(c) = code {
                        if !self.stopped && c != 0 {
                            eprintln!("[orchestrator] Node '{name}' exited with code {c}");
                        }
                    }
                }
                NodeEvent::Error { message, name } => {
                    eprintln!("[orchestrator] Error from '{name}': {message}");
                }
            }
        }
    }

    /// Send an event directly to a specific node.
    #[allow(dead_code)]
    pub async fn send_to_node(&self, name: &str, event: &serde_json::Value) {
        if let Some(runner) = self.runners.get(name) {
            let json = serde_json::to_string(event).unwrap_or_default();
            runner.send(&json).await;
        }
    }

    /// Stop all nodes gracefully in reverse topological order.
    pub async fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;

        let reversed: Vec<String> = self.dag.order.iter().rev().cloned().collect();
        for name in &reversed {
            if let Some(runner) = self.runners.get_mut(name) {
                runner.stop(3000).await;
            }
        }
    }
}
