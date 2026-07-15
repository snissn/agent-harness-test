import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { Diagnostic, ValidationError } from "./types.js";
import { loadManifestText } from "./load.js";

const schemaByKind: Record<string, string> = {
  task: "task.schema.json", suite: "suite.schema.json", experiment: "experiment.schema.json", campaign: "campaign.schema.json",
  evaluation: "evaluation.schema.json", "run-request": "run-request.schema.json", "run-result": "run-result.schema.json"
};
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (validator: Ajv2020) => void;
const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const exampleKinds: Record<string, string> = {
  "task.example.json": "task", "suite.example.json": "suite", "experiment.example.json": "experiment",
  "campaign.example.json": "campaign", "evaluation.example.json": "evaluation", "run-request.example.json": "run-request", "run-result.example.json": "run-result"
};

export function kindFromRepositoryPath(file: string): string | undefined {
  const parts = file.replace(/^\.\//, "").split(/[\\/]/);
  if (parts.length === 3 && parts[0] === "spec" && parts[1] === "examples") return exampleKinds[parts[2]!] ?? undefined;
  if (parts.length === 4 && parts[0] === "tasks" && identifier.test(parts[1]!) && semver.test(parts[2]!) && /task\.(json|ya?ml)$/i.test(parts[3]!)) return "task";
  if (parts.length === 3 && identifier.test(parts[1]!)) {
    const match = /^(.*)\.(json|ya?ml)$/i.exec(parts[2]!);
    if (match && semver.test(match[1]!)) {
      if (parts[0] === "suites") return "suite";
      if (parts[0] === "experiments") return "experiment";
    }
  }
  if (parts.length === 4 && parts[0] === "results" && parts.slice(1, 3).every(Boolean) && parts[3] === "campaign.json") return "campaign";
  if (parts.length === 6 && parts[0] === "results" && parts.slice(1, 3).every(Boolean) && parts[3] === "runs" && parts[4]) {
    if (parts[5] === "request.json") return "run-request";
    if (parts[5] === "run.json") return "run-result";
    if (parts[5] === "evaluator.json") return "evaluation";
  }
  return undefined;
}

export function kindFromPath(file: string): string | undefined {
  return kindFromRepositoryPath(file) ?? ({ "run-request.json": "run-request", "run-result.json": "run-result" } as Record<string, string>)[basename(file)];
}

export class SchemaValidator {
  private readonly validators = new Map<string, ValidateFunction>();
  static async create(schemaDirectory: string): Promise<SchemaValidator> {
    const validator = new SchemaValidator();
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    addFormats(ajv);
    for (const name of (await readdir(schemaDirectory)).filter((file) => file.endsWith(".json")).sort()) {
      ajv.addSchema(loadManifestText(await readFile(join(schemaDirectory, name), "utf8"), join(schemaDirectory, name)) as AnySchema);
    }
    for (const [kind, filename] of Object.entries(schemaByKind)) {
      const compiled = ajv.getSchema(filename);
      if (!compiled) throw new Error(`schema did not compile: ${filename}`);
      validator.validators.set(kind, compiled);
    }
    return validator;
  }
  validate(kind: string, value: unknown, file = "<input>"): void {
    const validate = this.validators.get(kind);
    if (!validate) throw new Error(`unknown manifest kind: ${kind}`);
    if (validate(value)) return;
    const diagnostics: Diagnostic[] = (validate.errors ?? []).map((error: ErrorObject) => ({
      file, code: `schema/${error.keyword}`, path: error.instancePath || "/", message: error.message ?? "schema validation failed"
    }));
    throw new ValidationError(diagnostics);
  }
}
