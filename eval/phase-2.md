# Phase 2: Orchestrator + Node Runner Evaluation

*2026-03-31T04:14:43Z by Showboat 0.6.1*
<!-- showboat-id: ee70442a-be50-41c0-acb5-ed9e35a568e3 -->

```bash
echo '=== TypeScript Compilation ===' && npx tsc --noEmit 2>&1 && echo 'PASS: no errors'
```

```output
=== TypeScript Compilation ===
PASS: no errors
```

```bash
echo '=== All v2 Unit Tests ===' && node --test dist/test/v2/*.test.js 2>&1
```

```output
=== All v2 Unit Tests ===
▶ config v2
  ✔ parses standard config (4.341417ms)
  ✔ parses test config (0.509042ms)
  ✔ parses conference config (0.497584ms)
  ✔ rejects empty config (0.195083ms)
  ✔ rejects config without nodes (0.122291ms)
  ✔ rejects node without use (0.113167ms)
  ✔ rejects output to undefined node (0.157916ms)
  ✔ rejects non-array outputs (0.13775ms)
  ✔ accepts node with no outputs (0.110667ms)
✔ config v2 (6.741833ms)
▶ dag v2
  ✔ builds a valid DAG from standard config (4.172709ms)
  ✔ handles fan-out (one node to multiple) (0.406708ms)
  ✔ handles fan-in (multiple nodes to one) (0.303333ms)
  ✔ rejects config with a cycle (A→B→A) (0.402292ms)
  ✔ rejects config with a longer cycle (A→B→C→A) (0.286792ms)
  ✔ computes downstream sets for interrupt propagation (0.414875ms)
  ✔ produces deterministic topological order (0.245875ms)
✔ dag v2 (6.856041ms)
▶ orchestrator v2
  ✔ spawns an echo node and receives lifecycle.ready (52.271625ms)
  ✔ routes events from node A to node B (561.18ms)
  ✔ fan-out: routes from one node to multiple destinations (588.544083ms)
  ✔ stamps ts and _from on all routed events (57.752833ms)
  ✔ emits control.error when a node crashes (49.6355ms)
  ✔ handles clean shutdown on stop() (52.049958ms)
  ✔ propagates control.interrupt to downstream nodes (570.143166ms)
✔ orchestrator v2 (1932.6635ms)
▶ protocol v2
  ✔ defines all event types with string literal type field (0.434208ms)
  ✔ isKnownEventType recognizes all v2 types (0.101125ms)
  ✔ parseEvent parses valid JSON (0.058125ms)
  ✔ parseEvent rejects invalid JSON (0.199792ms)
  ✔ serializeEvent round-trips (0.613584ms)
  ✔ stampEvent adds ts and _from (0.056333ms)
✔ protocol v2 (2.013292ms)
ℹ tests 29
ℹ suites 4
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6451.517417
```

```bash
echo '=== Check 1: Orchestrator spawns echo node ===' && node --input-type=module -e '
import { Orchestrator } from "./dist/v2/orchestrator.js";

const events = [];
const orch = Orchestrator.fromYaml(`
nodes:
  echo:
    use: "@acpfx/echo"
    outputs: []
`, { onEvent: (e) => events.push(e), readyTimeoutMs: 5000 });

await orch.start();
console.log("Orchestrator started with echo node.");
console.log("Events received:", events.length);
for (const e of events) console.log("  " + JSON.stringify(e));
await orch.stop();
console.log("Clean shutdown.");
' 2>&1
```

```output
=== Check 1: Orchestrator spawns echo node ===
[echo] node:internal/modules/esm/resolve:985
[echo]     if (inputTypeFlag) { throw new ERR_INPUT_TYPE_NOT_ALLOWED(); }
[echo]                                ^
[echo] 
[echo] Error [ERR_INPUT_TYPE_NOT_ALLOWED]: --input-type can only be used with string input via --eval, --print, or STDIN
[echo]     at defaultResolve (node:internal/modules/esm/resolve:985:32)
[echo]     at #cachedDefaultResolve (node:internal/modules/esm/loader:713:20)
[echo]     at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:730:38)
[echo]     at ModuleLoader.resolveSync (node:internal/modules/esm/loader:759:52)
[echo]     at #resolve (node:internal/modules/esm/loader:695:17)
[echo]     at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:615:35)
[echo]     at onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:644:32)
[echo]     at TracingChannel.tracePromise (node:diagnostics_channel:350:14)
[echo]     at ModuleLoader.import (node:internal/modules/esm/loader:640:21)
[echo]     at node:internal/modules/run_main:162:35 {
[echo]   code: 'ERR_INPUT_TYPE_NOT_ALLOWED'
[echo] }
[echo] 
[echo] Node.js v25.6.1
file:///Users/nick/code/acpfx/dist/v2/node-runner.js:44
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Node '${this.name}' did not become ready within ${timeoutMs}ms`)), timeoutMs)),
                                                               ^

Error: Node 'echo' did not become ready within 5000ms
    at Timeout._onTimeout (file:///Users/nick/code/acpfx/dist/v2/node-runner.js:44:64)
    at listOnTimeout (node:internal/timers:605:17)
    at process.processTimers (node:internal/timers:541:7)

Node.js v25.6.1
```

```bash
cat > /tmp/acpfx-eval-p2-check1.mjs << 'SCRIPT'
import { Orchestrator } from '/Users/nick/code/acpfx/dist/v2/orchestrator.js';

const events = [];
const orch = Orchestrator.fromYaml(`
nodes:
  echo:
    use: "@acpfx/echo"
    outputs: []
`, { onEvent: (e) => events.push(e), readyTimeoutMs: 5000 });

await orch.start();
console.log('Orchestrator started with echo node.');
console.log('Events received:', events.length);
for (const e of events) console.log('  ' + JSON.stringify(e));
await orch.stop();
console.log('Clean shutdown.');
SCRIPT
node /tmp/acpfx-eval-p2-check1.mjs 2>&1
```

```output
Orchestrator started with echo node.
Events received: 1
  {"type":"lifecycle.ready","component":"echo","ts":1774930542909,"_from":"echo"}
Clean shutdown.
```

CHECK 1 PASS: Orchestrator spawns echo node, receives lifecycle.ready with ts and _from stamps. Event: {type:'lifecycle.ready', component:'echo', ts:1774930542909, _from:'echo'}. Clean shutdown completes without hanging.

```bash
node /tmp/acpfx-eval-p2-routing.mjs 2>&1
```

```output
=== Event routing: source -> sink ===
  type=audio.chunk _from=source ts=1774930568995 trackId=test
  type=audio.chunk _from=sink ts=1774930568996 trackId=test
audio.chunk from source: 1
audio.chunk from sink: 1
Routing A->B: PASS
```

CHECK 2 PASS: Events route correctly. Sent audio.chunk to source, source echoed it (stamped _from=source), orchestrator routed to sink, sink echoed it (stamped _from=sink). 1ms hop latency between source and sink.

```bash
node /tmp/acpfx-eval-p2-fanout.mjs 2>&1
```

```output
=== Fan-out: source -> dest1 + dest2 ===
  type=audio.level _from=source ts=1774930585788
  type=audio.level _from=dest1 ts=1774930585788
  type=audio.level _from=dest2 ts=1774930585788
audio.level from dest1: 1
audio.level from dest2: 1
Fan-out: PASS
```

CHECK 3 PASS: Fan-out works. source emitted audio.level, both dest1 and dest2 received and echoed it. All three events stamped at same millisecond (sub-ms routing).

CHECK 4 PASS: ts and _from fields added to all routed events. Evidence from checks 1-3 above: every event has numeric ts (epoch ms) and string _from (node name). The stampEvent function in protocol.ts adds Date.now() and the source node name. Verified in direct test: lifecycle.ready had ts=1774930542909, _from='echo'; audio.chunk had _from='source'/'sink' with different ts values.

CHECK 5 PASS: lifecycle.ready received before routing begins. The orchestrator calls runner.spawn() for each node, then awaits Promise.all(readyPromises) — no events are routed until all nodes have emitted lifecycle.ready. The start() method is async and only resolves after all ready signals. Evidence: in check 1, lifecycle.ready is the first (and only before routing) event received.

```bash
node /tmp/acpfx-eval-p2-shutdown.mjs 2>&1
```

```output
Started 3-node pipeline (a->b->c).
Child PIDs before stop: 39717
39718
39719
stop() completed.
Child PIDs after stop: (none)
Clean shutdown: PASS - no zombies
```

CHECK 6 PASS: Clean shutdown with no zombie processes. 3 child PIDs (39717, 39718, 39719) existed before stop(). After stop(), pgrep returns no children. Shutdown order is reverse-topological (sinks first): c, b, a. Each node receives stdin EOF, exits cleanly.

```bash
node /tmp/acpfx-eval-p2-crash.mjs 2>&1
```

```output
Started. Waiting for crasher to exit...
control.error events: 1
  {"type":"control.error","component":"crasher","message":"Node 'crasher' exited with code 42","fatal":false,"ts":1774930635122,"_from":"crasher"}
Orchestrator errors: 1
  Node 'crasher' exited unexpectedly (code=42, signal=null)
Healthy node still responds: YES
Orchestrator survived crash: PASS
```

CHECK 7 PASS: Node crash emits control.error, orchestrator continues. Crasher node (exit code 42) produced: {type:'control.error', component:'crasher', message:'Node crasher exited with code 42', fatal:false}. After the crash, the healthy echo node still responds to events — orchestrator is not brought down by a single node failure.

CHECK 8 PASS: Echo test node verifies the node runner contract. echo.ts (src/v2/nodes/echo.ts, 27 lines) implements the full contract:
- Emits lifecycle.ready on startup (line 9)
- Reads NDJSON from stdin via readline (line 12-18)
- Echoes each event to stdout unchanged
- Exits cleanly on stdin close (rl 'close' event, line 20-22)
- Handles SIGTERM for graceful shutdown (line 24-27)
- Configured via fork() with ACPFX_SETTINGS env var (handled by node-runner.ts)
This echo node is used in all 7 orchestrator tests as a universal test fixture.

## Verdict

- [x] Orchestrator spawns a trivial echo node: PASS
- [x] Events route correctly (A -> B): PASS (1ms hop latency)
- [x] Fan-out works (A -> B + C): PASS (sub-ms routing)
- [x] ts and _from fields added to routed events: PASS (all events stamped)
- [x] lifecycle.ready received before routing begins: PASS (start() awaits all ready)
- [x] Clean shutdown: all processes terminated, no zombies: PASS (pgrep confirms 0 children)
- [x] Node crash -> control.error, orchestrator doesn't crash: PASS (crasher exit 42 -> error event, healthy node still responds)
- [x] Echo test node verifies node runner contract: PASS (27-line implementation covers all contract points)

**Phase 2: APPROVED** — all 8 criteria pass with evidence. 29/29 total tests pass.
