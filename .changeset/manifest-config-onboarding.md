---
"@acpfx/cli": minor
"@acpfx/core": minor
---

Add manifest argument/env schema, config system, pipeline resolver, and onboarding TUI

- **Manifest schema**: Node manifests now declare typed `arguments` (string/number/boolean with defaults, enums, required) and `env` var requirements. Codegen produces TypeScript types + Zod schemas.
- **All 12 node manifests updated** with arguments and env declarations derived from source code audit.
- **Build-time validation**: `scripts/validate-manifests.ts` validates against generated Zod schema. Orchestrator validates settings at startup.
- **Config system**: `~/.acpfx/config.json` (global) and `.acpfx/config.json` (project) with env var layering. New CLI: `acpfx config`, `acpfx config set/get`.
- **Pipeline resolver**: `acpfx run [name]` resolves pipelines from .acpfx/pipelines/, ~/.acpfx/pipelines/, or bundled examples. `acpfx pipelines` lists available pipelines.
- **Onboarding TUI**: `acpfx onboard` for interactive pipeline creation from templates or scratch. Auto-triggered on first `acpfx run` with no default pipeline.
