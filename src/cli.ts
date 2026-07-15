#!/usr/bin/env node
import { resolve } from "node:path";
import { loadManifest } from "./load.js";
import { kindFromPath, SchemaValidator } from "./schema.js";
import { validateRepository } from "./repository.js";
import { ValidationError } from "./types.js";
import { rebuildReport } from "./report.js";

async function main(): Promise<void> {
  const [command, target = "."] = process.argv.slice(2);
  if (command === "validate") { await validateRepository(resolve(target)); return; }
  if (command === "report" && target === "rebuild") {
    const [root = ".", output = "reports"] = process.argv.slice(4);
    const result = await rebuildReport(root, output); console.log(JSON.stringify(result)); return;
  }
  if (command === "file") {
    const kind = kindFromPath(target);
    if (!kind) throw new Error(`cannot infer schema kind from ${target}`);
    const root = resolve(import.meta.dirname, "..");
    const validator = await SchemaValidator.create(resolve(root, "spec/schemas"));
    validator.validate(kind, await loadManifest(resolve(target)), target);
    return;
  }
  throw new Error("usage: validate [repository-root] | file <manifest> | report rebuild [repository-root] [output-directory]");
}

main().catch((error) => {
  if (error instanceof ValidationError) for (const item of error.diagnostics) console.error(`${item.file} [${item.code}]${item.path ? ` ${item.path}` : ""}: ${item.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
