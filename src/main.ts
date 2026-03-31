#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("acpfx")
  .description("Observable DAG-based voice pipeline for ACP agents")
  .version("0.2.0");

program
  .command("run")
  .description("Run a pipeline from a YAML config file")
  .option("--config <path>", "Path to acpfx YAML config file", "acpfx.yaml")
  .option("--headless", "Run without UI node")
  .action(async (opts) => {
    const { runPipeline } = await import("./cli.js");
    await runPipeline(opts);
  });

program.parse();
