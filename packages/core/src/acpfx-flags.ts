/**
 * acpfx flag protocol types and handler.
 *
 * All orchestrator-reserved flags use the `--acpfx-` prefix.
 * Nodes that receive an unrecognized `--acpfx-*` flag should emit
 * an UnsupportedFlagResponse and exit 0 (forward compatibility).
 */

import { z } from "zod";

// ---- Types ----

/** Response from `--acpfx-setup-check`. */
export interface SetupCheckResponse {
  needed: boolean;
  description?: string;
}

/** Progress line from `--acpfx-setup` (NDJSON on stdout). */
export type SetupProgress =
  | { type: "progress"; message: string; pct?: number }
  | { type: "complete"; message: string }
  | { type: "error"; message: string };

/** Response for unrecognized `--acpfx-*` flags (forward compatibility). */
export interface UnsupportedFlagResponse {
  unsupported: boolean;
  flag: string;
}

// ---- Zod Schemas ----

export const SetupCheckResponseSchema = z.object({
  needed: z.boolean(),
  description: z.string().optional(),
});

export const SetupProgressSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    message: z.string(),
    pct: z.number().optional(),
  }),
  z.object({ type: z.literal("complete"), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export const UnsupportedFlagResponseSchema = z.object({
  unsupported: z.boolean(),
  flag: z.string(),
});
