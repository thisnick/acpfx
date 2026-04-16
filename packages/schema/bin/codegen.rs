//! Codegen binary: generates JSON Schema from the Rust schema definitions.
//!
//! Usage:
//!   cargo run -p acpfx-schema --bin acpfx-codegen [output-dir]
//!
//! If output-dir is not specified, writes schema.json to the workspace root.
//!
//! TypeScript types and Zod schemas are generated separately by
//! `scripts/generate-from-schema.js` which reads schema.json.

use acpfx_schema::*;
use std::path::PathBuf;

fn main() {
    let output_dir = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        let workspace = std::env::var("CARGO_WORKSPACE_DIR")
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(workspace).join("packages/core/src")
    });

    std::fs::create_dir_all(&output_dir).expect("failed to create output directory");

    // Generate JSON Schema
    let schema = schemars::schema_for!(Event);
    let schema_json = serde_json::to_string_pretty(&schema).unwrap();
    let schema_path = output_dir.join("../../../schema.json");
    std::fs::write(&schema_path, &schema_json)
        .unwrap_or_else(|_| {
            // Fallback: write next to output dir
            std::fs::write(output_dir.join("schema.json"), &schema_json).unwrap();
        });
    eprintln!("wrote schema.json");
}
