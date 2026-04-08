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

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use acpfx_schema::manifest::{NodeManifest, SetupCheckResponse, SetupProgress};

use crate::config::{load_config, parse_config, PipelineConfig};
use crate::dag::{build_dag, node_consumes_event, Dag};
use crate::node_runner::{resolve_node, NodeEvent, NodeRunner, ResolvedNode};

pub struct Orchestrator {
    config: PipelineConfig,
    dag: Dag,
    runners: BTreeMap<String, NodeRunner>,
    event_tx: mpsc::Sender<(String, NodeEvent)>,
    event_rx: Option<mpsc::Receiver<(String, NodeEvent)>>,
    dist_dir: PathBuf,
    ready_timeout_ms: u64,
    setup_timeout_ms: u64,
    skip_setup: bool,
    stopped: bool,
    /// UI controls declared by manifests, keyed by node name.
    ui_controls: BTreeMap<String, Vec<acpfx_schema::manifest::ManifestControl>>,
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
            setup_timeout_ms: 600000,
            skip_setup: false,
            stopped: false,
            ui_controls: BTreeMap::new(),
        }
    }

    pub fn set_ready_timeout(&mut self, ms: u64) {
        self.ready_timeout_ms = ms;
    }

    pub fn set_setup_timeout(&mut self, ms: u64) {
        self.setup_timeout_ms = ms;
    }

    pub fn set_skip_setup(&mut self, skip: bool) {
        self.skip_setup = skip;
    }

    /// Merge additional env vars into the pipeline config.
    /// Used to inject env vars from ~/.acpfx/config.json and .acpfx/config.json.
    /// Existing keys in the pipeline YAML are NOT overwritten (YAML takes precedence
    /// over config files; system env takes precedence over everything at spawn time).
    pub fn merge_env(&mut self, env: std::collections::BTreeMap<String, String>) {
        for (k, v) in env {
            self.config.env.entry(k).or_insert(v);
        }
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

    /// Get UI controls declared by all node manifests.
    /// Returns (node_name, controls) pairs.
    pub fn get_ui_controls(&self) -> &BTreeMap<String, Vec<acpfx_schema::manifest::ManifestControl>> {
        &self.ui_controls
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
                // Fallback: run the node with --acpfx-manifest to get manifest JSON
                fetch_manifest_via_flag(&resolved)
            };

            if let Some(m) = manifest {
                // Validate settings against manifest arguments
                let node_settings = self.config.nodes.get(name)
                    .and_then(|n| n.settings.as_ref());
                validate_settings(name, node_settings, &m);

                // Store UI controls if declared
                if let Some(ref ui) = m.ui {
                    if !ui.controls.is_empty() {
                        self.ui_controls.insert(name.clone(), ui.controls.clone());
                    }
                }

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

    /// Check which nodes need first-time setup (e.g., model downloads).
    /// Runs `--acpfx-setup-check` on all nodes in parallel with a 5s timeout.
    async fn run_setup_checks(&self) -> Vec<SetupNeeded> {
        let mut handles = Vec::new();

        for (name, dag_node) in &self.dag.nodes {
            let resolved = resolve_node(&dag_node.use_, &self.dist_dir);
            let node_name = name.clone();
            let settings = dag_node.settings.clone();
            let env = self.config.env.clone();

            handles.push(tokio::spawn(async move {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    run_setup_check_process(&node_name, &resolved, settings.as_ref(), &env),
                )
                .await;

                match result {
                    Ok(Some(resp)) if resp.needed => Some(SetupNeeded {
                        node_name,
                        description: resp.description.unwrap_or_default(),
                        resolved,
                    }),
                    _ => None,
                }
            }));
        }

        let mut needs_setup = Vec::new();
        for handle in handles {
            if let Ok(Some(needed)) = handle.await {
                needs_setup.push(needed);
            }
        }
        needs_setup
    }

    /// Run setup for nodes that need it (e.g., download models).
    /// Spawns `--acpfx-setup` on each node in parallel, streaming progress to stderr.
    async fn run_setup(&self, nodes: &[SetupNeeded]) -> Result<(), String> {
        let mut handles = Vec::new();

        for needed in nodes {
            let node_name = needed.node_name.clone();
            let resolved = needed.resolved.clone();
            let settings = self.dag.nodes.get(&needed.node_name)
                .and_then(|n| n.settings.clone());
            let env = self.config.env.clone();
            let timeout_ms = self.setup_timeout_ms;

            handles.push(tokio::spawn(async move {
                run_setup_process(&node_name, &resolved, settings.as_ref(), &env, timeout_ms).await
            }));
        }

        for handle in handles {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(e),
                Err(e) => return Err(format!("Setup task panicked: {e}")),
            }
        }
        Ok(())
    }

    /// Start the pipeline: load manifests, run setup if needed, spawn all nodes, wait for ready, begin routing.
    pub async fn start(&mut self) -> Result<(), String> {
        self.load_manifests();

        // Run setup phase unless skipped
        if !self.skip_setup {
            let needs_setup = self.run_setup_checks().await;
            if !needs_setup.is_empty() {
                eprintln!(
                    "[acpfx] First-time setup required for: {}",
                    needs_setup.iter().map(|s| s.node_name.as_str()).collect::<Vec<_>>().join(", ")
                );
                for s in &needs_setup {
                    eprintln!("[{}] {}", s.node_name, s.description);
                }
                self.run_setup(&needs_setup).await?;
                eprintln!("[acpfx] Setup complete.");
            }
        }

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
    /// Optionally accepts a receiver for UI actions (e.g., control toggles).
    pub async fn run(
        &mut self,
        on_event: impl FnMut(&serde_json::Value),
    ) {
        self.run_with_ui(on_event, None).await;
    }

    /// Run the event routing loop with optional UI action channel.
    pub async fn run_with_ui(
        &mut self,
        mut on_event: impl FnMut(&serde_json::Value),
        mut ui_rx: Option<tokio::sync::mpsc::UnboundedReceiver<crate::ui_widgets::UiAction>>,
    ) {
        let mut event_rx = self.event_rx.take().expect("run() called twice");

        loop {
            let (from_node, node_event) = if let Some(ref mut rx) = ui_rx {
                tokio::select! {
                    event = event_rx.recv() => {
                        match event {
                            Some(e) => e,
                            None => break,
                        }
                    }
                    action = rx.recv() => {
                        if let Some(action) = action {
                            self.handle_ui_action(action).await;
                        }
                        continue;
                    }
                }
            } else {
                match event_rx.recv().await {
                    Some(e) => e,
                    None => break,
                }
            };
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

    /// Handle a UI action (e.g., control toggle).
    async fn handle_ui_action(&self, action: crate::ui_widgets::UiAction) {
        match action {
            crate::ui_widgets::UiAction::ControlToggle { ref node, ref control_id, value } => {
                // Find the control spec for this node
                if let Some(controls) = self.ui_controls.get(node.as_str()) {
                    if let Some(ctrl) = controls.iter().find(|c| c.id == *control_id) {
                        let event = serde_json::json!({
                            "type": ctrl.event.type_,
                            ctrl.event.field.clone(): value,
                        });
                        self.send_to_node(node, &event).await;
                    }
                }
            }
            crate::ui_widgets::UiAction::Quit => {
                // Quit is handled by the UI thread, not here
            }
        }
    }

    /// Send an event directly to a specific node.
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

/// Validate YAML config `settings` against the manifest's declared `arguments`.
/// Emits warnings on stderr for mismatches (does not abort the pipeline).
/// Fallback: run the node with --acpfx-manifest and parse stdout JSON.
/// Used when no co-located manifest file exists (e.g., npx-resolved nodes).
fn fetch_manifest_via_flag(resolved: &ResolvedNode) -> Option<NodeManifest> {
    use std::process::Command;

    let mut cmd = Command::new(&resolved.command);
    cmd.args(&resolved.args)
        .arg("--acpfx-manifest")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return None,
    };

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    if line.is_empty() {
        return None;
    }

    serde_json::from_str(line).ok()
}

fn validate_settings(
    node_name: &str,
    settings: Option<&serde_json::Value>,
    manifest: &NodeManifest,
) {
    use acpfx_schema::manifest::ArgumentType;

    let settings_obj = match settings {
        Some(serde_json::Value::Object(map)) => map,
        Some(_) => {
            eprintln!(
                "[orchestrator] WARN: node '{node_name}' settings is not a JSON object"
            );
            return;
        }
        None => return,
    };

    // Check for unknown keys if additional_arguments is not enabled
    if !manifest.allows_additional_arguments() {
        for key in settings_obj.keys() {
            if !manifest.arguments.contains_key(key) {
                eprintln!(
                    "[orchestrator] WARN: node '{node_name}' has unknown setting '{key}' \
                     (not declared in manifest arguments)"
                );
            }
        }
    }

    // Validate declared arguments
    for (arg_name, arg_def) in &manifest.arguments {
        if let Some(value) = settings_obj.get(arg_name) {
            // Type check
            let type_ok = match arg_def.type_ {
                ArgumentType::String => value.is_string(),
                ArgumentType::Number => value.is_number(),
                ArgumentType::Boolean => value.is_boolean(),
            };
            if !type_ok {
                eprintln!(
                    "[orchestrator] WARN: node '{node_name}' setting '{arg_name}' \
                     has type {} but manifest declares type {:?}",
                    json_type_name(value),
                    arg_def.type_,
                );
            }

            // Enum check
            if let Some(ref enum_values) = arg_def.enum_values {
                if !enum_values.contains(value) {
                    eprintln!(
                        "[orchestrator] WARN: node '{node_name}' setting '{arg_name}' \
                         value {} is not in allowed enum values {:?}",
                        value,
                        enum_values,
                    );
                }
            }
        } else if arg_def.is_required() && arg_def.default.is_none() {
            eprintln!(
                "[orchestrator] WARN: node '{node_name}' is missing required setting '{arg_name}'"
            );
        }
    }
}

fn json_type_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// A node that needs first-time setup.
struct SetupNeeded {
    node_name: String,
    description: String,
    resolved: ResolvedNode,
}

/// Spawn `--acpfx-setup-check` for a node and parse the response.
async fn run_setup_check_process(
    node_name: &str,
    resolved: &ResolvedNode,
    settings: Option<&serde_json::Value>,
    env: &BTreeMap<String, String>,
) -> Option<SetupCheckResponse> {
    let mut cmd = Command::new(&resolved.command);
    cmd.args(&resolved.args)
        .arg("--acpfx-setup-check")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    cmd.env("ACPFX_NODE_NAME", node_name);
    if let Some(s) = settings {
        cmd.env("ACPFX_SETTINGS", serde_json::to_string(s).unwrap_or_default());
    }
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[orchestrator] setup-check spawn failed for '{}': {}", node_name, e);
            return None;
        }
    };
    let stdout = child.stdout.take()?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    if let Err(e) = reader.read_line(&mut line).await {
        eprintln!("[orchestrator] setup-check read failed for '{}': {}", node_name, e);
        let _ = child.wait().await;
        return None;
    }
    let _ = child.wait().await;

    match serde_json::from_str::<SetupCheckResponse>(line.trim()) {
        Ok(resp) => Some(resp),
        Err(e) => {
            eprintln!("[orchestrator] setup-check parse failed for '{}': {} (got: {:?})", node_name, e, line.trim());
            None
        }
    }
}

/// Spawn `--acpfx-setup` for a node, stream progress lines to stderr.
async fn run_setup_process(
    node_name: &str,
    resolved: &ResolvedNode,
    settings: Option<&serde_json::Value>,
    env: &BTreeMap<String, String>,
    timeout_ms: u64,
) -> Result<(), String> {
    let mut cmd = Command::new(&resolved.command);
    cmd.args(&resolved.args)
        .arg("--acpfx-setup")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    cmd.env("ACPFX_NODE_NAME", node_name);
    if let Some(s) = settings {
        cmd.env("ACPFX_SETTINGS", serde_json::to_string(s).unwrap_or_default());
    }
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn setup for '{node_name}': {e}")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        format!("No stdout for setup of '{node_name}'")
    })?;

    let node = node_name.to_string();
    let read_task = async {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<SetupProgress>(line.trim()) {
                Ok(SetupProgress::Progress { message, pct }) => {
                    eprintln!(
                        "[{node}] {message}{}",
                        pct.map(|p| format!(" {}%", p)).unwrap_or_default()
                    );
                }
                Ok(SetupProgress::Complete { message }) => {
                    eprintln!("[{node}] {message}");
                }
                Ok(SetupProgress::Error { message }) => {
                    return Err(format!("Setup failed for '{node}': {message}"));
                }
                Err(_) => {
                    // Ignore unparseable lines
                }
            }
        }
        Ok(())
    };

    let result = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        read_task,
    )
    .await;

    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!("Setup timed out for '{node_name}' after {timeout_ms}ms"));
        }
    }

    let status = child.wait().await.map_err(|e| {
        format!("Failed to wait for setup of '{node_name}': {e}")
    })?;

    if !status.success() {
        return Err(format!(
            "Setup for '{node_name}' exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }

    Ok(())
}
