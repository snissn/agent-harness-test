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

export function kindFromPath(file: string): string | undefined {
  const name = basename(file);
  const exampleKinds: Record<string, string> = {
    "task.example.json": "task", "suite.example.json": "suite", "experiment.example.json": "experiment",
    "campaign.example.json": "campaign", "evaluation.example.json": "evaluation", "run-request.example.json": "run-request", "run-result.example.json": "run-result"
  };
  if (exampleKinds[name]) return exampleKinds[name];
  const parts = file.replace(/^\.\//, "").split(/[\\/]/);
  if (parts[0] === "suites") return "suite";
  if (parts[0] === "experiments") return "experiment";
  if (parts[0] === "results" && name === "request.json") return "run-request";
  if (name === "task.yaml" || name === "task.yml" || name === "task.json") return "task";
  if (name === "evaluator.json") return "evaluation";
  if (name === "run-request.json") return "run-request";
  if (name === "run-result.json" || name === "run.json") return "run-result";
  if (name.includes("suite")) return "suite";
  if (name.includes("experiment")) return "experiment";
  if (name.includes("campaign")) return "campaign";
  if (name.includes("evaluation")) return "evaluation";
  return undefined;
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
