//! DAG construction from a PipelineConfig.
//!
//! - Builds adjacency list from node outputs
//! - Topological sort (Kahn's algorithm, cycles appended in config order)
//! - Downstream sets for interrupt propagation

use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use std::cmp::Reverse;

use crate::config::PipelineConfig;

/// A node in the DAG with its manifest contract.
#[derive(Debug, Clone)]
pub struct DagNode {
    pub name: String,
    pub use_: String,
    pub settings: Option<serde_json::Value>,
    pub outputs: Vec<String>,
    /// Event types this node consumes (from manifest). Empty = accepts all.
    pub consumes: Vec<String>,
    /// Event types this node emits (from manifest). Empty = emits any.
    pub emits: Vec<String>,
}

/// The complete DAG.
#[derive(Debug)]
pub struct Dag {
    /// All nodes keyed by name.
    pub nodes: BTreeMap<String, DagNode>,
    /// Topological order (sources first).
    pub order: Vec<String>,
    /// For a given node, all transitive downstream nodes. Used for interrupt propagation.
    pub downstream: BTreeMap<String, BTreeSet<String>>,
}

/// Build and validate a DAG from a pipeline config.
pub fn build_dag(config: &PipelineConfig) -> Dag {
    let mut nodes = BTreeMap::new();

    for (name, nc) in &config.nodes {
        nodes.insert(
            name.clone(),
            DagNode {
                name: name.clone(),
                use_: nc.use_.clone(),
                settings: nc.settings.clone(),
                outputs: nc.outputs.clone(),
                consumes: Vec::new(),
                emits: Vec::new(),
            },
        );
    }

    let order = topological_sort(&nodes);
    let downstream = compute_downstream(&nodes);

    Dag {
        nodes,
        order,
        downstream,
    }
}

/// Check if a node accepts a given event type based on its manifest.
/// Empty consumes list = permissive (accepts everything).
pub fn node_consumes_event(node: &DagNode, event_type: &str) -> bool {
    if node.consumes.is_empty() {
        return true;
    }
    node.consumes.iter().any(|c| c == event_type)
}

/// Topological sort using Kahn's algorithm. Cycles are appended in config order.
fn topological_sort(nodes: &BTreeMap<String, DagNode>) -> Vec<String> {
    let mut in_degree: BTreeMap<&str, usize> = BTreeMap::new();
    for name in nodes.keys() {
        in_degree.insert(name.as_str(), 0);
    }
    for node in nodes.values() {
        for out in &node.outputs {
            *in_degree.entry(out.as_str()).or_insert(0) += 1;
        }
    }

    // Min-heap for deterministic (alphabetical) ordering
    let mut heap: BinaryHeap<Reverse<String>> = BinaryHeap::new();
    for (name, &deg) in &in_degree {
        if deg == 0 {
            heap.push(Reverse(name.to_string()));
        }
    }

    let mut result = Vec::new();
    while let Some(Reverse(name)) = heap.pop() {
        result.push(name.clone());
        if let Some(node) = nodes.get(&name) {
            for out in &node.outputs {
                if let Some(deg) = in_degree.get_mut(out.as_str()) {
                    *deg -= 1;
                    if *deg == 0 {
                        heap.push(Reverse(out.clone()));
                    }
                }
            }
        }
    }

    // Nodes in cycles: append in config declaration order
    if result.len() != nodes.len() {
        let sorted: BTreeSet<String> = result.iter().cloned().collect();
        for name in nodes.keys() {
            if !sorted.contains(name) {
                result.push(name.clone());
            }
        }
    }

    result
}

/// Compute transitive downstream sets via DFS.
fn compute_downstream(nodes: &BTreeMap<String, DagNode>) -> BTreeMap<String, BTreeSet<String>> {
    let mut downstream = BTreeMap::new();

    for name in nodes.keys() {
        let mut visited = BTreeSet::new();
        let mut stack: Vec<&str> = nodes
            .get(name)
            .map(|n| n.outputs.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();

        while let Some(cur) = stack.pop() {
            if !visited.insert(cur.to_string()) {
                continue;
            }
            if let Some(cur_node) = nodes.get(cur) {
                for out in &cur_node.outputs {
                    if !visited.contains(out.as_str()) {
                        stack.push(out.as_str());
                    }
                }
            }
        }

        downstream.insert(name.clone(), visited);
    }

    downstream
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_config;

    #[test]
    fn linear_pipeline_order() {
        let config = parse_config(
            r#"
nodes:
  a:
    use: echo
    outputs: [b]
  b:
    use: echo
    outputs: [c]
  c:
    use: echo
    outputs: []
"#,
        )
        .unwrap();
        let dag = build_dag(&config);
        assert_eq!(dag.order, vec!["a", "b", "c"]);
    }

    #[test]
    fn downstream_computation() {
        let config = parse_config(
            r#"
nodes:
  a:
    use: echo
    outputs: [b]
  b:
    use: echo
    outputs: [c]
  c:
    use: echo
    outputs: []
"#,
        )
        .unwrap();
        let dag = build_dag(&config);
        let ds_a = &dag.downstream["a"];
        assert!(ds_a.contains("b"));
        assert!(ds_a.contains("c"));
        let ds_b = &dag.downstream["b"];
        assert!(ds_b.contains("c"));
        assert!(!ds_b.contains("a"));
        assert!(dag.downstream["c"].is_empty());
    }

    #[test]
    fn fan_out_topology() {
        let config = parse_config(
            r#"
nodes:
  source:
    use: echo
    outputs: [a, b]
  a:
    use: echo
    outputs: []
  b:
    use: echo
    outputs: []
"#,
        )
        .unwrap();
        let dag = build_dag(&config);
        assert!(dag.downstream["source"].contains("a"));
        assert!(dag.downstream["source"].contains("b"));
    }

    #[test]
    fn node_consumes_permissive_when_empty() {
        let node = DagNode {
            name: "test".into(),
            use_: "echo".into(),
            settings: None,
            outputs: vec![],
            consumes: vec![],
            emits: vec![],
        };
        assert!(node_consumes_event(&node, "audio.chunk"));
        assert!(node_consumes_event(&node, "anything"));
    }

    #[test]
    fn node_consumes_filters_when_declared() {
        let node = DagNode {
            name: "test".into(),
            use_: "echo".into(),
            settings: None,
            outputs: vec![],
            consumes: vec!["audio.chunk".into(), "control.interrupt".into()],
            emits: vec![],
        };
        assert!(node_consumes_event(&node, "audio.chunk"));
        assert!(node_consumes_event(&node, "control.interrupt"));
        assert!(!node_consumes_event(&node, "speech.final"));
    }
}
