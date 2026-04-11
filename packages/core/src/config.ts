/**
 * YAML config loader and validator for acpfx v2 pipeline configs.
 *
 * Config format:
 * ```yaml
 * nodes:
 *   <name>:
 *     use: "@acpfx/<impl>"
 *     settings: { ... }
 *     outputs:
 *       - <name>                                    # unconditional
 *       - node: <name>                              # conditional
 *         whenFieldEquals: { field: "value", ... }
 * env:
 *   KEY: value
 * ```
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ---- Config types ----

/** An output edge — either a plain node name or a filtered edge. */
export type OutputEdge =
  | string
  | { node: string; whenFieldEquals?: Record<string, unknown> };

/** Get the destination node name from an output edge. */
export function outputNodeName(edge: OutputEdge): string {
  return typeof edge === "string" ? edge : edge.node;
}

export type NodeConfig = {
  use: string;
  settings?: Record<string, unknown>;
  outputs?: OutputEdge[];
};

export type PipelineConfig = {
  nodes: Record<string, NodeConfig>;
  env?: Record<string, string>;
};

// ---- Validation errors ----

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---- Loader ----

/** Load and validate a YAML config file. */
export function loadConfig(path: string): PipelineConfig {
  const raw = readFileSync(path, "utf-8");
  return parseConfig(raw);
}

/** Parse and validate a YAML string. */
export function parseConfig(yaml: string): PipelineConfig {
  const doc = parseYaml(yaml);
  return validateConfig(doc);
}

// ---- Validation ----

function validateConfig(doc: unknown): PipelineConfig {
  if (!doc || typeof doc !== "object") {
    throw new ConfigError("Config must be a YAML object");
  }

  const obj = doc as Record<string, unknown>;

  if (!obj.nodes || typeof obj.nodes !== "object") {
    throw new ConfigError("Config must have a 'nodes' object");
  }

  const nodes = obj.nodes as Record<string, unknown>;
  const nodeNames = new Set(Object.keys(nodes));

  if (nodeNames.size === 0) {
    throw new ConfigError("Config must have at least one node");
  }

  const validatedNodes: Record<string, NodeConfig> = {};

  for (const [name, raw] of Object.entries(nodes)) {
    if (!raw || typeof raw !== "object") {
      throw new ConfigError(`Node '${name}' must be an object`);
    }

    const node = raw as Record<string, unknown>;

    if (typeof node.use !== "string" || node.use.length === 0) {
      throw new ConfigError(`Node '${name}' must have a 'use' string`);
    }

    let outputs: OutputEdge[] | undefined;
    if (node.outputs !== undefined) {
      if (!Array.isArray(node.outputs)) {
        throw new ConfigError(`Node '${name}'.outputs must be an array`);
      }
      outputs = [];
      for (const out of node.outputs) {
        let destName: string;
        if (typeof out === "string") {
          destName = out;
          outputs.push(out);
        } else if (out && typeof out === "object" && typeof out.node === "string") {
          destName = out.node;
          const edge: OutputEdge = { node: out.node };
          if (out.whenFieldEquals && typeof out.whenFieldEquals === "object") {
            (edge as { node: string; whenFieldEquals: Record<string, unknown> }).whenFieldEquals = out.whenFieldEquals;
          }
          outputs.push(edge);
        } else {
          throw new ConfigError(
            `Node '${name}'.outputs entries must be strings or {node, whenFieldEquals?} objects`,
          );
        }
        if (!nodeNames.has(destName)) {
          throw new ConfigError(
            `Node '${name}' outputs to undefined node '${destName}'`,
          );
        }
      }
    }

    const settings =
      node.settings && typeof node.settings === "object"
        ? (node.settings as Record<string, unknown>)
        : undefined;

    validatedNodes[name] = { use: node.use, settings, outputs };
  }

  // Validate env
  let env: Record<string, string> | undefined;
  if (obj.env !== undefined) {
    if (typeof obj.env !== "object" || obj.env === null) {
      throw new ConfigError("'env' must be an object");
    }
    env = {};
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      env[k] = String(v);
    }
  }

  return { nodes: validatedNodes, env };
}
