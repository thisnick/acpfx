/**
 * Graph construction from a PipelineConfig.
 *
 * - Builds an adjacency list from node outputs
 * - Produces a spawn order (best-effort topological, tolerates cycles)
 * - Computes downstream sets for interrupt propagation (with cycle protection)
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
};

export type Dag = {
  /** All nodes keyed by name. */
  nodes: Map<string, DagNode>;
  /** Spawn order (best-effort topological — sources first, cycles tolerated). */
  order: string[];
  /** For a given node, all nodes reachable downstream (transitive, cycle-safe). */
  downstream: Map<string, Set<string>>;
};

/** Build a graph from a pipeline config. Cycles are allowed. */
export function buildDag(config: PipelineConfig): Dag {
  const nodes = new Map<string, DagNode>();

  for (const [name, nc] of Object.entries(config.nodes)) {
    nodes.set(name, {
      name,
      use: nc.use,
      settings: nc.settings,
      outputs: nc.outputs ?? [],
    });
  }

  // Validate all output references exist
  for (const node of nodes.values()) {
    for (const out of node.outputs) {
      if (!nodes.has(out)) {
        throw new DagError(
          `Node '${node.name}' outputs to undefined node '${out}'`,
        );
      }
    }
  }

  const order = spawnOrder(nodes);
  const downstream = computeDownstream(nodes);

  return { nodes, order, downstream };
}

/**
 * Best-effort topological sort. Processes zero-in-degree nodes first (Kahn's),
 * then appends any remaining nodes (in a cycle) in alphabetical order.
 * This gives a reasonable spawn order even with cycles.
 */
function spawnOrder(nodes: Map<string, DagNode>): string[] {
  const inDegree = new Map<string, number>();
  for (const name of nodes.keys()) {
    inDegree.set(name, 0);
  }
  for (const node of nodes.values()) {
    for (const out of node.outputs) {
      inDegree.set(out, (inDegree.get(out) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }
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
        const idx = queue.findIndex((q) => q > out);
        if (idx === -1) queue.push(out);
        else queue.splice(idx, 0, out);
      }
    }
  }

  // Append any remaining nodes involved in cycles
  if (result.length < nodes.size) {
    const remaining = [...nodes.keys()]
      .filter((n) => !result.includes(n))
      .sort();
    result.push(...remaining);
  }

  return result;
}

/**
 * Compute downstream sets (transitive closure). Handles cycles by tracking
 * visited nodes — won't infinite loop.
 */
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
