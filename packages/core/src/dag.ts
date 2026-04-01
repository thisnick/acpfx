/**
 * Directed graph construction from a PipelineConfig.
 *
 * - Builds an adjacency list from node outputs
 * - Produces a topological ordering (nodes in cycles are appended in config declaration order)
 * - Computes downstream sets for interrupt propagation
 */

import { PipelineConfig } from "./config.js";

export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

export type DagNode = {
  name: string;
  use: string;
  settings?: Record<string, unknown>;
  outputs: string[];
  /** Event types this node declares it consumes (from manifest). Empty = accepts all. */
  consumes: string[];
  /** Event types this node declares it emits (from manifest). Empty = emits any. */
  emits: string[];
};

export type Dag = {
  /** All nodes keyed by name. */
  nodes: Map<string, DagNode>;
  /** Topological order (sources first). */
  order: string[];
  /** For a given node, all nodes downstream (transitive). Used for interrupt propagation. */
  downstream: Map<string, Set<string>>;
};

/** Build and validate a DAG from a pipeline config. */
export function buildDag(config: PipelineConfig): Dag {
  const nodes = new Map<string, DagNode>();

  for (const [name, nc] of Object.entries(config.nodes)) {
    nodes.set(name, {
      name,
      use: nc.use,
      settings: nc.settings,
      outputs: nc.outputs ?? [],
      consumes: [],
      emits: [],
    });
  }

  // Validate all output references exist (config.ts already does this, but belt-and-suspenders)
  for (const node of nodes.values()) {
    for (const out of node.outputs) {
      if (!nodes.has(out)) {
        throw new DagError(
          `Node '${node.name}' outputs to undefined node '${out}'`,
        );
      }
    }
  }

  const order = topologicalSort(nodes);
  const downstream = computeDownstream(nodes);

  return { nodes, order, downstream };
}

/**
 * Check if a node accepts a given event type based on its manifest.
 * If the node has no consumes list (empty), it accepts everything (permissive mode).
 */
export function nodeConsumesEvent(node: DagNode, eventType: string): boolean {
  if (node.consumes.length === 0) return true; // permissive: no manifest or empty consumes
  return node.consumes.includes(eventType);
}

// ---- Topological sort (Kahn's algorithm, cycles allowed) ----

function topologicalSort(nodes: Map<string, DagNode>): string[] {
  // Compute in-degrees
  const inDegree = new Map<string, number>();
  for (const name of nodes.keys()) {
    inDegree.set(name, 0);
  }
  for (const node of nodes.values()) {
    for (const out of node.outputs) {
      inDegree.set(out, (inDegree.get(out) ?? 0) + 1);
    }
  }

  // Start with zero in-degree nodes
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }
  // Sort for deterministic order
  queue.sort();

  const result: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    result.push(name);
    const node = nodes.get(name)!;
    for (const out of node.outputs) {
      const newDeg = (inDegree.get(out) ?? 1) - 1;
      inDegree.set(out, newDeg);
      if (newDeg === 0) {
        // Insert sorted for deterministic order
        const idx = queue.findIndex((q) => q > out);
        if (idx === -1) queue.push(out);
        else queue.splice(idx, 0, out);
      }
    }
  }

  if (result.length !== nodes.size) {
    // Nodes in cycles: append in config declaration order
    const sorted = new Set(result);
    for (const name of nodes.keys()) {
      if (!sorted.has(name)) result.push(name);
    }
  }

  return result;
}

// ---- Downstream computation (transitive closure) ----

function computeDownstream(nodes: Map<string, DagNode>): Map<string, Set<string>> {
  const downstream = new Map<string, Set<string>>();

  for (const name of nodes.keys()) {
    const visited = new Set<string>();
    const stack = [...(nodes.get(name)?.outputs ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const curNode = nodes.get(cur);
      if (curNode) {
        for (const out of curNode.outputs) {
          if (!visited.has(out)) stack.push(out);
        }
      }
    }
    downstream.set(name, visited);
  }

  return downstream;
}
