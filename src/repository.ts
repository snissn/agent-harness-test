import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { manifestDigest, treeDigest } from "./digests.js";
import { isManifestPath, loadManifest } from "./load.js";
import { kindFromPath, SchemaValidator } from "./schema.js";
import { Diagnostic, ValidationError } from "./types.js";

type ObjectValue = Record<string, any>;

export function safeRelativePath(value: string): boolean {
  return value.length > 0 && !value.includes("\\") && !value.includes("\0") && !posix.isAbsolute(value) && value === posix.normalize(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }

async function resolveSafe(root: string, value: string): Promise<string> {
  if (!safeRelativePath(value)) throw new Error(`unsafe repository-relative path: ${value}`);
  const absolute = resolve(root, value);
  if (relative(root, absolute).startsWith("..")) throw new Error(`path escapes repository root: ${value}`);
  let cursor = root;
  for (const segment of value.split("/")) {
    cursor = join(cursor, segment);
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink is not allowed in manifest path: ${value}`);
  }
  return absolute;
}

async function walk(root: string, directory: string, out: string[]): Promise<void> {
  if (!await exists(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(root, file, out);
    else if (entry.isFile() && isManifestPath(file)) out.push(file);
  }
}

export async function validateRepository(rootInput: string): Promise<void> {
  const root = await realpath(rootInput);
  const schemas = await SchemaValidator.create(join(root, "spec/schemas"));
  const diagnostics: Diagnostic[] = [];
  const manifests: Array<{ file: string; kind: string; value: ObjectValue }> = [];
  const exampleFiles = (await readdir(join(root, "spec/examples"))).filter((name) => name.endsWith(".json")).map((name) => join(root, "spec/examples", name));
  const repoFiles: string[] = [];
  for (const directory of ["tasks", "suites", "experiments", "results"]) await walk(root, join(root, directory), repoFiles);
  for (const file of [...exampleFiles, ...repoFiles].sort()) {
    const kind = kindFromPath(file);
    if (!kind) continue;
    try { const value = await loadManifest(file) as ObjectValue; schemas.validate(kind, value, file); manifests.push({ file, kind, value }); }
    catch (error) { diagnostics.push(...(error instanceof ValidationError ? error.diagnostics : [{ file, code: "internal", message: String(error) }])); }
  }
  const taskByIdentity = new Map<string, { file: string; value: ObjectValue }>();
  for (const manifest of manifests.filter((item) => item.kind === "task" && !item.file.includes(`${sep}spec${sep}examples${sep}`))) {
    const identity = `${manifest.value.id}@${manifest.value.version}`;
    if (taskByIdentity.has(identity)) diagnostics.push({ file: manifest.file, code: "semantic/duplicate-task", message: `duplicate task identity ${identity}` });
    taskByIdentity.set(identity, manifest);
    try {
      for (const path of [manifest.value.prompt.path, manifest.value.problem_state.source.path, manifest.value.evaluator.path, manifest.value.calibration?.evidence_path].filter(Boolean)) await resolveSafe(root, path);
      if (["candidate", "released", "retired"].includes(manifest.value.status)) {
        const state = await resolveSafe(root, manifest.value.problem_state.source.path);
        const evaluator = await resolveSafe(root, manifest.value.evaluator.path);
        if (!await stat(state).then((item) => item.isDirectory())) throw new Error("problem state must be a directory");
        if (!await stat(evaluator).then((item) => item.isDirectory())) throw new Error("evaluator must be a directory");
        const actualState = await treeDigest(state); if (actualState !== manifest.value.problem_state.expected_tree_digest) throw new Error(`problem-state digest mismatch: expected ${manifest.value.problem_state.expected_tree_digest}, got ${actualState}`);
        const actualEvaluator = await treeDigest(evaluator); if (actualEvaluator !== manifest.value.evaluator.digest) throw new Error(`evaluator digest mismatch: expected ${manifest.value.evaluator.digest}, got ${actualEvaluator}`);
      }
    } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/task-artifact", message: error instanceof Error ? error.message : String(error) }); }
  }
  for (const suite of manifests.filter((item) => item.kind === "suite" && !item.file.includes(`${sep}spec${sep}examples${sep}`))) {
    for (const task of suite.value.tasks as ObjectValue[]) {
      const target = taskByIdentity.get(`${task.id}@${task.version}`);
      if (!target) diagnostics.push({ file: suite.file, code: "semantic/task-reference", message: `missing task ${task.id}@${task.version}` });
      else if (suite.value.status === "released" && target.value.status !== "released") diagnostics.push({ file: suite.file, code: "semantic/released-suite", message: `released suite references non-released task ${task.id}@${task.version}` });
      else if (target && task.spec_digest !== manifestDigest(target.value)) diagnostics.push({ file: suite.file, code: "semantic/task-digest", message: `task digest mismatch for ${task.id}@${task.version}` });
    }
  }
  for (const evaluation of manifests.filter((item) => item.kind === "evaluation" && !item.file.includes(`${sep}spec${sep}examples${sep}`))) {
    const task = taskByIdentity.get(`${evaluation.value.task_id}@${evaluation.value.task_version}`);
    if (task && evaluation.value.status === "ok") {
      const expected = new Set(task.value.scoring.checks.map((check: ObjectValue) => check.id));
      const actual = new Set(evaluation.value.checks.map((check: ObjectValue) => check.id));
      if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) diagnostics.push({ file: evaluation.file, code: "semantic/check-ids", message: "evaluator check IDs must exactly match task scoring check IDs" });
    }
  }
  if (diagnostics.length) throw new ValidationError(diagnostics);
}
