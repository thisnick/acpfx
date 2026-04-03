# @acpfx/core

Shared types, Zod schemas, and manifest utilities for acpfx nodes. This package contains the generated TypeScript types and validation schemas derived from the canonical Rust schema definitions.

## Install

```bash
npm install @acpfx/core
```

## What's Included

- **Generated types** -- TypeScript interfaces for all event types (`audio.chunk`, `speech.final`, `agent.delta`, etc.)
- **Zod schemas** -- Runtime validation for events
- **Manifest utilities** -- Helpers for loading and validating `manifest.yaml` files
- **Protocol helpers** -- Event construction and parsing

## Usage

```typescript
import { AudioChunkEvent, SpeechFinalEvent } from "@acpfx/core";
```

Types are generated from the Rust schema crate via `cargo run -p acpfx-schema --bin acpfx-codegen`.

## License

ISC
