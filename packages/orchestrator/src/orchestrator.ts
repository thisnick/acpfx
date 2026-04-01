/**
 * Orchestrator — the DAG executor.
 *
 * 1. Loads YAML config
 * 2. Builds + validates DAG
 * 3. Spawns each node via NodeRunner
 * 4. Waits for all lifecycle.ready
 * 5. Routes events: reads from each node's stdout, stamps ts/_from, writes to destination stdin
 * 6. Propagates control.interrupt to downstream nodes
 * 7. Forwards all events to observer callbacks
 * 8. Clean shutdown on stop()
 */

import { loadConfig, parseConfig, type PipelineConfig, buildDag, type Dag, type AnyEvent, type ControlErrorEvent, stampEvent } from "@acpfx/core";
import { NodeRunner } from "./node-runner.js";

export type OrchestratorOptions = {
  /** Called for every event from every node (after stamping). */
  onEvent?: (event: AnyEvent) => void;
  /** Called on orchestrator-level errors. */
  onError?: (error: Error) => void;
  /** Timeout (ms) waiting for each node to emit lifecycle.ready. */
  readyTimeoutMs?: number;
};

export class Orchestrator {
  private dag: Dag;
  private config: PipelineConfig;
  private runners = new Map<string, NodeRunner>();
  private options: OrchestratorOptions;
  private stopped = false;

  constructor(config: PipelineConfig, options: OrchestratorOptions = {}) {
    this.config = config;
    this.dag = buildDag(config);
    this.options = options;
  }

  /** Load from a YAML file path. */
  static fromFile(path: string, options?: OrchestratorOptions): Orchestrator {
    return new Orchestrator(loadConfig(path), options);
  }

  /** Load from a YAML string. */
  static fromYaml(yaml: string, options?: OrchestratorOptions): Orchestrator {
    return new Orchestrator(parseConfig(yaml), options);
  }

  /** Get the DAG for inspection. */
  getDag(): Dag {
    return this.dag;
  }

  /** Start the pipeline: spawn all nodes, wait for ready, begin routing. */
  async start(): Promise<void> {
    // Spawn nodes in topological order
    for (const name of this.dag.order) {
      const dagNode = this.dag.nodes.get(name)!;

      // Suppress non-UI node stderr when a UI node is present
      const hasUi = Array.from(this.dag.nodes.values()).some(
        (n) => n.use.includes("ui-cli") || n.use.includes("ui-web"),
      );

      const runner = new NodeRunner({
        name,
        use: dagNode.use,
        settings: dagNode.settings,
        env: this.config.env,
        quiet: hasUi && !dagNode.use.includes("ui-"),
        onEvent: (event) => this.handleNodeEvent(name, event),
        onError: (error) => this.handleNodeError(name, error),
        onExit: (code, signal) => this.handleNodeExit(name, code, signal),
      });

      this.runners.set(name, runner);
      runner.spawn();
    }

    // Wait for all nodes to be ready
    const timeoutMs = this.options.readyTimeoutMs ?? 10000;
    const readyPromises = [...this.runners.values()].map((r) =>
      r.waitReady(timeoutMs),
    );
    await Promise.all(readyPromises);
  }

  /** Stop all nodes gracefully. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Stop in reverse topological order (sinks first)
    const reversed = [...this.dag.order].reverse();
    for (const name of reversed) {
      const runner = this.runners.get(name);
      if (runner) {
        await runner.stop();
      }
    }
  }

  /** Send an event directly to a specific node. */
  sendToNode(name: string, event: AnyEvent): void {
    const runner = this.runners.get(name);
    if (runner) {
      runner.send(event);
    }
  }

  // ---- Internal event handling ----

  private handleNodeEvent(fromNode: string, event: AnyEvent): void {
    if (this.stopped) return;

    // Stamp with ts and _from
    const stamped = stampEvent(event, fromNode);

    // Notify observers
    this.options.onEvent?.(stamped);

    // Route to destination nodes per DAG config
    const dagNode = this.dag.nodes.get(fromNode);
    if (dagNode) {
      for (const dest of dagNode.outputs) {
        const destRunner = this.runners.get(dest);
        if (destRunner) {
          destRunner.send(stamped);
        }
      }
    }

    // Log events are broadcast to all UI and recorder nodes regardless of DAG wiring
    if (stamped.type === "log") {
      for (const [name, node] of this.dag.nodes) {
        const isObserver = node.use.includes("ui-") || node.use.includes("recorder");
        if (isObserver && !dagNode?.outputs.includes(name)) {
          const runner = this.runners.get(name);
          if (runner) runner.send(stamped);
        }
      }
    }

    // If this is speech.pause from an STT node while bridge might be streaming,
    // propagate interrupt to bridge and all downstream of bridge.
    // The orchestrator checks: if speech.pause arrives and there's a bridge node
    // downstream, send control.interrupt to the bridge and its downstream nodes.
    // NOTE: Interrupt propagation is triggered externally or by specific node logic.
    // The orchestrator itself propagates control.interrupt events to downstream nodes.
    if (stamped.type === "control.interrupt") {
      this.propagateInterrupt(fromNode, stamped);
    }
  }

  /** Propagate a control.interrupt to all downstream nodes of the source. */
  private propagateInterrupt(fromNode: string, event: AnyEvent): void {
    const downstream = this.dag.downstream.get(fromNode);
    if (!downstream) return;

    for (const name of downstream) {
      const runner = this.runners.get(name);
      if (runner) {
        runner.send(event);
      }
    }
  }

  private handleNodeError(name: string, error: Error): void {
    const errorEvent: ControlErrorEvent = {
      type: "control.error",
      component: name,
      message: error.message,
      fatal: false,
    };
    const stamped = stampEvent(errorEvent, name);
    this.options.onEvent?.(stamped);
    this.options.onError?.(error);
  }

  private handleNodeExit(
    name: string,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.stopped) return;

    // Unexpected exit
    if (code !== 0 && code !== null) {
      const errorEvent: ControlErrorEvent = {
        type: "control.error",
        component: name,
        message: `Node '${name}' exited with code ${code}`,
        fatal: false,
      };
      const stamped = stampEvent(errorEvent, name);
      this.options.onEvent?.(stamped);
      this.options.onError?.(
        new Error(`Node '${name}' exited unexpectedly (code=${code}, signal=${signal})`),
      );
    }
  }
}
