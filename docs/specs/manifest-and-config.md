# Spec: Manifest Schema + Config/Pipeline Management

## Part 1: Manifest Schema

### Goal
Define node settings/params in the manifest so they can be validated at build time, displayed in onboarding, and used to extract required env vars.

### Manifest format (extend existing manifest.yaml)

```yaml
name: stt-deepgram
description: "Speech-to-text via Deepgram Nova-3 streaming API"

consumes:
  - audio.chunk
emits:
  - speech.partial
  - speech.final
  - speech.pause
  - lifecycle.ready
  - lifecycle.done
  - control.error

# NEW: settings schema — what can be passed in the YAML config's `settings:` block
settings:
  language:
    type: string
    default: "en"
    description: "Language code for transcription"
  model:
    type: string
    default: "nova-3"
    description: "Deepgram model name"
  utteranceEndMs:
    type: number
    default: 1000
    description: "Milliseconds of silence before utterance end"
  endpointing:
    type: number
    default: 300
    description: "VAD endpointing threshold in ms"

# NEW: environment variables this node reads
env:
  DEEPGRAM_API_KEY:
    required: true
    description: "Deepgram API key for STT"
  # Optional env vars can also be declared
```

### Settings field types
- `string`, `number`, `boolean`
- `required: true/false` (default false)
- `default: <value>` (optional)
- `description: string`
- `enum: [value1, value2]` (optional, for constrained choices)

### Schema definition (Rust + codegen)

1. **Add to `packages/schema/`**: Define `ManifestSchema` types in Rust (settings field, env field, etc.)
2. **Codegen**: Generate TypeScript types + Zod schema for manifest validation
3. **node-sdk**: Export Zod schema so TS nodes can validate their own manifests at build time
4. **Orchestrator**: Validate manifests at startup — check settings passed in YAML match the manifest's declared settings schema

### Build-time validation

- A build script / test automatically discovers all `manifest.yaml` files in the workspace
- Validates each against the manifest Zod schema
- Checks: all declared env vars are strings, all settings have valid types, consumes/emits reference known event types
- **If a manifest is invalid, the build/test fails**

### Tests
- Schema round-trip tests for manifest types (Rust)
- Zod validation tests for each node's manifest
- Auto-discovery test that finds all manifests and validates them
- Test that YAML config settings match the manifest's declared settings schema

---

## Part 2: Config & Pipeline Management

### File structure

```
~/.acpfx/
  config.json          # Global config (env vars, default pipeline)
  pipelines/           # User-created pipelines
    default.yaml       # The default pipeline
    my-custom.yaml

.acpfx/                # Project-local (cwd)
  config.json          # Project-level config (overrides global)
  pipelines/
    dev.yaml
```

### config.json format

```json
{
  "defaultPipeline": "default",
  "env": {
    "DEEPGRAM_API_KEY": "sk-...",
    "ELEVENLABS_API_KEY": "sk-..."
  }
}
```

### Pipeline resolution (for `acpfx run --config <name>`)

1. If `<name>` is a file path (contains `/` or `.yaml`) → load directly
2. If `<name>` matches `.acpfx/pipelines/<name>.yaml` → use project-local
3. If `<name>` matches `~/.acpfx/pipelines/<name>.yaml` → use global
4. If `<name>` matches `examples/pipeline/<name>.yaml` → use bundled example (debug only)
5. Error: pipeline not found

### Env var resolution (layered, project overrides global)

1. `process.env` / system env (highest priority)
2. `.acpfx/config.json` env (project-local)
3. `~/.acpfx/config.json` env (global)

These are merged and passed to nodes via the orchestrator.

### CLI subcommands

```
acpfx run [<pipeline>]     # Run a pipeline (default: "default")
acpfx run --config <path>  # Run from explicit path (existing behavior)
acpfx onboard              # Interactive setup / re-setup
acpfx config               # Show current config
acpfx config set <key> <value>  # Set a config value
acpfx config get <key>     # Get a config value
acpfx pipelines            # List available pipelines
acpfx pipelines create     # Interactive pipeline builder
```

### Onboarding TUI (`acpfx onboard`)

Multi-step interactive terminal experience using ratatui or crossterm prompts:

**Step 1: Welcome**
- "Welcome to acpfx! Let's set up your first voice pipeline."
- Brief explanation of what acpfx does

**Step 2: Choose starting point**
- "Start from a template" → show list of bundled templates (deepgram, elevenlabs, etc.)
- "Build from scratch" → interactive node-by-node builder

**Step 3a: Template mode**
- Show the template's nodes and connections
- "Here's your pipeline: mic → stt → bridge → tts → player"
- Allow customization: "Would you like to modify any nodes?"

**Step 3b: Build mode**
- Step-by-step:
  1. "Add a node" → pick from available node types (discovered from installed @acpfx/* packages)
  2. "Connect nodes" → pick source and destination
  3. Repeat until done
  4. "Done" → finalize pipeline

**Step 4: Environment variables**
- Extract required env vars from all nodes in the pipeline (from manifest `env` section)
- For each env var:
  - If already set (in system env, global config, or project config): show current value, ask to keep or change
  - If not set: prompt user to enter value
  - Ask where to store: project (`.acpfx/config.json`) or global (`~/.acpfx/config.json`)

**Step 5: Save pipeline**
- "Save as default?" → yes/no
- "Save to project or global?" → `.acpfx/pipelines/` or `~/.acpfx/pipelines/`
- Name the pipeline

**Step 6: Run**
- "Pipeline saved! Run it now?" → launch immediately

### First-run behavior

When `acpfx run` is called with no arguments and no default pipeline exists:
- Automatically trigger the onboarding flow
- After onboarding, run the newly created pipeline

---

## Implementation notes

- Manifest schema types should be defined in Rust (`packages/schema/`) and generated to TypeScript (same codegen pattern as events)
- The onboarding TUI can use `crossterm` for input + `ratatui` for rendering (already dependencies)
- Config reading/writing is in the orchestrator (Rust)
- Pipeline resolution is in the orchestrator (Rust)
- The `acpfx` binary gets new subcommands: `onboard`, `config`, `pipelines`
