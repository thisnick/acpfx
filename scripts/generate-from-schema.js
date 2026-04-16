#!/usr/bin/env node

/**
 * Generates TypeScript types and Zod schemas from schema.json.
 *
 * Usage:
 *   node scripts/generate-from-schema.js
 *
 * Reads:  schema.json (repo root)
 * Writes: packages/core/src/generated-types.ts
 *         packages/core/src/generated-zod.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const schema = JSON.parse(readFileSync(join(ROOT, "schema.json"), "utf-8"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an event type string to a PascalCase TypeScript name.
 *   "audio.chunk"    -> "AudioChunk"
 *   "agent.tool_start" -> "AgentToolStart"
 *   "log"            -> "Log"
 */
function toPascalCase(eventType) {
  return eventType
    .split(/[._]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Derive the category prefix from an event type string.
 *   "audio.chunk" -> "audio"
 *   "log"         -> "log"
 */
function categoryOf(eventType) {
  const dot = eventType.indexOf(".");
  return dot === -1 ? eventType : eventType.slice(0, dot);
}

/**
 * Resolve a JSON Schema property to a TS type string.
 */
function resolveType(propSchema, propName, required) {
  if (!propSchema) return "unknown";

  // $ref — resolve from definitions
  if (propSchema.$ref) {
    const refName = propSchema.$ref.replace("#/definitions/", "");
    return resolveDefinitionType(refName);
  }

  // anyOf: [ {$ref: ...}, {type: "null"} ] — optional reference
  if (propSchema.anyOf) {
    const nonNull = propSchema.anyOf.filter(
      (s) => !(s.type === "null"),
    );
    if (nonNull.length === 1) {
      return resolveType(nonNull[0], propName, true);
    }
    // Fallback
    return "unknown";
  }

  // type is an array: e.g., ["string", "null"] or ["integer", "null"]
  if (Array.isArray(propSchema.type)) {
    const nonNull = propSchema.type.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      return jsonTypeToTs(nonNull[0]);
    }
    return "unknown";
  }

  // enum values
  if (propSchema.enum && propSchema.type === "string") {
    // If this is the "type" discriminant, return a literal
    if (propSchema.enum.length === 1) {
      return JSON.stringify(propSchema.enum[0]);
    }
    return propSchema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Plain type
  if (propSchema.type) {
    return jsonTypeToTs(propSchema.type);
  }

  // No type constraint at all (e.g., `playing`, `agentState` in player.status)
  return "unknown";
}

function jsonTypeToTs(jsonType) {
  switch (jsonType) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return "Record<string, unknown>";
    case "array":
      return "unknown[]";
    default:
      return "unknown";
  }
}

/**
 * Resolve a $ref definition name to a TS type.
 */
function resolveDefinitionType(defName) {
  const def = schema.definitions?.[defName];
  if (!def) return "unknown";

  // Enum of strings
  if (def.type === "string" && def.enum) {
    return def.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Object — inline it
  if (def.type === "object" && def.properties) {
    const fields = [];
    for (const [k, v] of Object.entries(def.properties)) {
      const req = def.required?.includes(k);
      const tsType = resolveType(v, k, req);
      fields.push(`${k}: ${tsType}`);
    }
    return `{ ${fields.join("; ")} }`;
  }

  return "unknown";
}

/**
 * Resolve a JSON Schema property to a Zod schema string.
 */
function resolveZod(propSchema, propName, required) {
  if (!propSchema) return "z.unknown()";

  // $ref
  if (propSchema.$ref) {
    const refName = propSchema.$ref.replace("#/definitions/", "");
    return resolveDefinitionZod(refName);
  }

  // anyOf: [ {$ref: ...}, {type: "null"} ]
  if (propSchema.anyOf) {
    const nonNull = propSchema.anyOf.filter(
      (s) => !(s.type === "null"),
    );
    if (nonNull.length === 1) {
      return resolveZod(nonNull[0], propName, true);
    }
    return "z.unknown()";
  }

  // type is array: ["string", "null"]
  if (Array.isArray(propSchema.type)) {
    const nonNull = propSchema.type.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      return jsonTypeToZod(nonNull[0]);
    }
    return "z.unknown()";
  }

  // enum
  if (propSchema.enum && propSchema.type === "string") {
    if (propSchema.enum.length === 1) {
      return `z.literal(${JSON.stringify(propSchema.enum[0])})`;
    }
    return `z.enum([${propSchema.enum.map((v) => JSON.stringify(v)).join(", ")}])`;
  }

  // Plain type
  if (propSchema.type) {
    return jsonTypeToZod(propSchema.type);
  }

  return "z.unknown()";
}

function jsonTypeToZod(jsonType) {
  switch (jsonType) {
    case "string":
      return "z.string()";
    case "integer":
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    default:
      return "z.unknown()";
  }
}

function resolveDefinitionZod(defName) {
  const def = schema.definitions?.[defName];
  if (!def) return "z.unknown()";

  if (def.type === "string" && def.enum) {
    return `z.enum([${def.enum.map((v) => JSON.stringify(v)).join(", ")}])`;
  }

  if (def.type === "object" && def.properties) {
    const fields = [];
    for (const [k, v] of Object.entries(def.properties)) {
      const req = def.required?.includes(k);
      let zodType = resolveZod(v, k, req);
      fields.push(`${k}: ${zodType}`);
    }
    return `z.object({ ${fields.join(", ")} })`;
  }

  return "z.unknown()";
}

// ---------------------------------------------------------------------------
// Parse event variants from schema.json
// ---------------------------------------------------------------------------

const variants = schema.oneOf.map((variant) => {
  const typeEnum = variant.properties?.type?.enum;
  const eventType = typeEnum?.[0]; // e.g. "audio.chunk"
  if (!eventType) throw new Error("Variant missing type enum");

  const pascalName = toPascalCase(eventType);
  const category = categoryOf(eventType);
  const requiredFields = new Set(variant.required || []);

  // Collect fields (excluding ts, _from, type — those are handled separately)
  const stampFields = new Set(["ts", "_from", "type"]);
  const fields = [];

  // Maintain a stable field order: required fields first (sorted), then optional (sorted)
  const propNames = Object.keys(variant.properties || {}).filter(
    (k) => !stampFields.has(k),
  );

  const reqFields = propNames.filter((k) => requiredFields.has(k)).sort();
  const optFields = propNames.filter((k) => !requiredFields.has(k)).sort();

  for (const name of [...reqFields, ...optFields]) {
    const propSchema = variant.properties[name];
    const isRequired = requiredFields.has(name);

    // For nullable fields not in required array, treat as optional
    const isNullable =
      Array.isArray(propSchema.type) && propSchema.type.includes("null");
    const isAnyOfNull =
      propSchema.anyOf?.some((s) => s.type === "null") ?? false;

    const optional = !isRequired || isNullable || isAnyOfNull;

    fields.push({
      name,
      propSchema,
      isRequired,
      optional: !isRequired,
      tsType: resolveType(propSchema, name, isRequired),
      zodType: resolveZod(propSchema, name, isRequired),
    });
  }

  return { eventType, pascalName, category, fields };
});

// Group by category
const categories = {};
for (const v of variants) {
  if (!categories[v.category]) categories[v.category] = [];
  categories[v.category].push(v);
}

// Define the category display order and union type names
const CATEGORY_ORDER = [
  { key: "audio", label: "Audio", unionName: "AudioEvent" },
  { key: "speech", label: "Speech Recognition", unionName: "SpeechEvent" },
  { key: "agent", label: "Agent/LLM", unionName: "AgentEvent" },
  { key: "control", label: "Control", unionName: "ControlEvent" },
  { key: "lifecycle", label: "Lifecycle", unionName: "LifecycleEvent" },
  { key: "log", label: "Log", unionName: "LogEventType" },
  { key: "player", label: "Player", unionName: "PlayerEvent" },
  { key: "node", label: "Node", unionName: "NodeEvent" },
];

// ---------------------------------------------------------------------------
// Generate generated-types.ts
// ---------------------------------------------------------------------------

function generateTypes() {
  const lines = [];

  lines.push("/**");
  lines.push(
    " * AUTO-GENERATED by scripts/generate-from-schema.js from schema.json.",
  );
  lines.push(
    " * DO NOT EDIT — re-run `node scripts/generate-from-schema.js`.",
  );
  lines.push(" */");
  lines.push("");

  // OrchestratorStamp
  lines.push(
    "/** Fields added by the orchestrator to every routed event. */",
  );
  lines.push("export type OrchestratorStamp = {");
  lines.push("  ts?: number;");
  lines.push("  _from?: string;");
  lines.push("};");
  lines.push("");

  // Individual event types, grouped by category
  for (const cat of CATEGORY_ORDER) {
    const variantsInCat = categories[cat.key];
    if (!variantsInCat) continue;

    lines.push(`// ---- ${cat.label} ----`);
    lines.push("");

    for (const v of variantsInCat) {
      lines.push(
        `export type ${v.pascalName}Event = OrchestratorStamp & {`,
      );
      lines.push(`  type: "${v.eventType}";`);

      for (const f of v.fields) {
        const optMark = f.optional ? "?" : "";
        lines.push(`  ${f.name}${optMark}: ${f.tsType};`);
      }

      lines.push("};");
      lines.push("");
    }
  }

  // Union types
  lines.push("// ---- Union types ----");
  lines.push("");

  const unionLines = [];
  for (const cat of CATEGORY_ORDER) {
    const variantsInCat = categories[cat.key];
    if (!variantsInCat) continue;

    const typeNames = variantsInCat.map((v) => `${v.pascalName}Event`);

    if (typeNames.length === 1) {
      lines.push(`export type ${cat.unionName} = ${typeNames[0]};`);
    } else if (typeNames.length === 2) {
      lines.push(
        `export type ${cat.unionName} = ${typeNames[0]} | ${typeNames[1]};`,
      );
    } else {
      lines.push(`export type ${cat.unionName} =`);
      for (let i = 0; i < typeNames.length; i++) {
        const prefix = "  | ";
        const suffix = i === typeNames.length - 1 ? ";" : "";
        lines.push(`${prefix}${typeNames[i]}${suffix}`);
      }
    }

    // Add blank line after each union, but handle the special case of log
    if (cat.key === "lifecycle") {
      // LifecycleEvent is followed by LogEventType on same "block"
      lines.push("");
    } else if (cat.key === "log") {
      // No extra blank line — next line is PlayerEvent
      lines.push("");
    } else {
      lines.push("");
    }
  }

  // PipelineEvent
  lines.push("export type PipelineEvent =");
  // Use category union names, but for Log use LogEvent directly (matching original)
  const pipelineMembers = CATEGORY_ORDER.map((cat) => {
    if (cat.key === "log") return "LogEvent";
    return cat.unionName;
  });
  for (let i = 0; i < pipelineMembers.length; i++) {
    const suffix = i === pipelineMembers.length - 1 ? ";" : "";
    lines.push(`  | ${pipelineMembers[i]}${suffix}`);
  }
  lines.push("");

  // UnknownEvent
  lines.push(
    "/** An event with a `type` field that doesn't match a known type. Forwarded unchanged. */",
  );
  lines.push("export type UnknownEvent = OrchestratorStamp & {");
  lines.push("  type: string;");
  lines.push("  [key: string]: unknown;");
  lines.push("};");
  lines.push("");

  // AnyEvent
  lines.push("export type AnyEvent = PipelineEvent | UnknownEvent;");
  lines.push("");

  // KNOWN_TYPES
  lines.push("// ---- Type discrimination ----");
  lines.push("");
  lines.push("const KNOWN_TYPES = new Set([");
  for (const v of variants) {
    lines.push(`  "${v.eventType}",`);
  }
  lines.push("]);");
  lines.push("");

  lines.push("export function isKnownEventType(type: string): boolean {");
  lines.push("  return KNOWN_TYPES.has(type);");
  lines.push("}");
  lines.push("");

  // Serialization
  lines.push("// ---- Serialization ----");
  lines.push("");
  lines.push("export function parseEvent(json: string): AnyEvent {");
  lines.push("  const obj = JSON.parse(json);");
  lines.push(
    '  if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {',
  );
  lines.push("    throw new Error(\"Invalid event: missing 'type' field\");");
  lines.push("  }");
  lines.push("  return obj as AnyEvent;");
  lines.push("}");
  lines.push("");

  lines.push("export function serializeEvent(event: AnyEvent): string {");
  lines.push("  return JSON.stringify(event);");
  lines.push("}");
  lines.push("");

  // Helpers
  lines.push("// ---- Helpers ----");
  lines.push("");
  lines.push("/** Create an event with the given type and payload. */");
  lines.push(
    "export function createEvent<T extends AnyEvent>(event: T): T {",
  );
  lines.push("  return event;");
  lines.push("}");
  lines.push("");

  lines.push("/** Stamp an event with orchestrator metadata. */");
  lines.push("export function stampEvent<T extends AnyEvent>(");
  lines.push("  event: T,");
  lines.push("  from: string,");
  lines.push("): T & Required<OrchestratorStamp> {");
  lines.push("  return { ...event, ts: Date.now(), _from: from };");
  lines.push("}");

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Generate generated-zod.ts
// ---------------------------------------------------------------------------

function generateZod() {
  const lines = [];

  lines.push("/**");
  lines.push(
    " * AUTO-GENERATED by scripts/generate-from-schema.js from schema.json.",
  );
  lines.push(
    " * DO NOT EDIT — re-run `node scripts/generate-from-schema.js`.",
  );
  lines.push(" */");
  lines.push("");
  lines.push('import { z } from "zod";');
  lines.push("");

  // OrchestratorStampSchema
  lines.push("export const OrchestratorStampSchema = z.object({");
  lines.push("  ts: z.number().optional(),");
  lines.push("  _from: z.string().optional(),");
  lines.push("});");
  lines.push("");

  // Individual event schemas
  for (const cat of CATEGORY_ORDER) {
    const variantsInCat = categories[cat.key];
    if (!variantsInCat) continue;

    for (const v of variantsInCat) {
      lines.push(
        `export const ${v.pascalName}EventSchema = OrchestratorStampSchema.extend({`,
      );
      lines.push(`  type: z.literal("${v.eventType}"),`);

      for (const f of v.fields) {
        let zodStr = f.zodType;
        if (f.optional) {
          zodStr += ".optional()";
        }
        lines.push(`  ${f.name}: ${zodStr},`);
      }

      lines.push("});");
      lines.push("");
    }
  }

  // PipelineEventSchema
  lines.push(
    'export const PipelineEventSchema = z.discriminatedUnion("type", [',
  );
  for (const v of variants) {
    lines.push(`  ${v.pascalName}EventSchema,`);
  }
  lines.push("]);");

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const typesContent = generateTypes();
const zodContent = generateZod();

const typesPath = join(ROOT, "packages/core/src/generated-types.ts");
const zodPath = join(ROOT, "packages/core/src/generated-zod.ts");

writeFileSync(typesPath, typesContent);
console.log(`wrote ${typesPath}`);

writeFileSync(zodPath, zodContent);
console.log(`wrote ${zodPath}`);
