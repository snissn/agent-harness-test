import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { manifestDigest, sha256, treeDigest } from "./digests.js";
import { isManifestPath, loadManifest } from "./load.js";
import { kindFromPath, SchemaValidator } from "./schema.js";
import { Diagnostic, ValidationError } from "./types.js";

type ObjectValue = Record<string, unknown>;
type Manifest = { file: string; kind: string; value: ObjectValue };
const nonDraft = new Set(["candidate", "released", "retired"]);

export function safeRelativePath(value: string): boolean {
  return value.length > 0 && !value.includes("\\") && !value.includes("\0") && !/^[A-Za-z]:/.test(value) && !posix.isAbsolute(value) && value === posix.normalize(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function asObject(value: unknown): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object"); return value as ObjectValue; }
function asString(value: unknown): string { if (typeof value !== "string") throw new Error("expected string"); return value; }

async function resolveSafe(root: string, value: string): Promise<string> {
  if (!safeRelativePath(value)) throw new Error(`unsafe repository-relative path: ${value}`);
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path escapes repository root: ${value}`);
  let cursor = root;
  for (const segment of value.split("/")) {
    cursor = join(cursor, segment);
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink is not allowed in manifest path: ${value}`);
  }
  return absolute;
}

async function walk(directory: string, out: string[]): Promise<void> {
  if (!await exists(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(file, out);
    else if (entry.isFile() && isManifestPath(file)) out.push(file);
  }
}
async function taskManifests(tasksDirectory: string): Promise<string[]> {
  const manifests: string[] = [];
  if (!await exists(tasksDirectory)) return manifests;
  for (const task of await readdir(tasksDirectory, { withFileTypes: true })) {
    if (!task.isDirectory() || task.isSymbolicLink()) continue;
    const taskDirectory = join(tasksDirectory, task.name);
    for (const version of await readdir(taskDirectory, { withFileTypes: true })) {
      if (!version.isDirectory() || version.isSymbolicLink()) continue;
      const versionDirectory = join(taskDirectory, version.name);
      for (const name of ["task.json", "task.yaml", "task.yml"]) if (await exists(join(versionDirectory, name))) manifests.push(join(versionDirectory, name));
    }
  }
  return manifests;
}
async function canonicalArtifactDirectories(tasksDirectory: string): Promise<string[]> {
  const artifacts: string[] = [];
  if (!await exists(tasksDirectory)) return artifacts;
  for (const task of await readdir(tasksDirectory, { withFileTypes: true })) {
    if (!task.isDirectory() || task.isSymbolicLink()) continue;
    const taskDirectory = join(tasksDirectory, task.name);
    for (const version of await readdir(taskDirectory, { withFileTypes: true })) {
      if (!version.isDirectory() || version.isSymbolicLink()) continue;
      for (const name of ["state", "evaluator"]) if (await isDirectory(join(taskDirectory, version.name, name))) artifacts.push(join(taskDirectory, version.name, name));
    }
  }
  return artifacts;
}

function insideExamples(file: string): boolean { return file.includes(`${sep}spec${sep}examples${sep}`); }
function manifestOwnedPath(file: string): boolean { const parts = file.replace(/^\.\//, "").split(/[\\/]/); return parts[0] === "suites" || parts[0] === "experiments"; }
function identity(manifest: Manifest): string | undefined {
  if (["task", "suite", "experiment"].includes(manifest.kind)) return `${asString(manifest.value.id)}@${asString(manifest.value.version)}`;
  if (manifest.kind === "campaign") return asString(manifest.value.campaign_id);
  if (["run-request", "run-result"].includes(manifest.kind)) return asString(manifest.value.run_id);
  return undefined;
}

export async function validateRepository(rootInput: string): Promise<void> {
  const root = await realpath(rootInput);
  const schemas = await SchemaValidator.create(join(root, "spec/schemas"));
  const diagnostics: Diagnostic[] = [];
  const manifests: Manifest[] = [];
  const exampleDirectory = join(root, "spec/examples");
  const exampleFiles = await exists(exampleDirectory) ? (await readdir(exampleDirectory)).filter(isManifestPath).map((name) => join(exampleDirectory, name)) : [];
  const repoFiles = await taskManifests(join(root, "tasks"));
  for (const directory of ["suites", "experiments", "results"]) await walk(join(root, directory), repoFiles);
  for (const file of [...exampleFiles, ...repoFiles].sort()) {
    const repositoryPath = relative(root, file).split(sep).join("/");
    const kind = kindFromPath(repositoryPath);
    if (!kind) { if (manifestOwnedPath(repositoryPath)) diagnostics.push({ file, code: "semantic/unknown-manifest", message: "cannot infer manifest schema kind from a manifest-owned path" }); continue; }
    try { const value = asObject(await loadManifest(file)); schemas.validate(kind, value, file); manifests.push({ file, kind, value }); }
    catch (error) { diagnostics.push(...(error instanceof ValidationError ? error.diagnostics : [{ file, code: "internal", message: error instanceof Error ? error.message : String(error) }])); }
  }
  const repositoryManifests = manifests.filter((manifest) => !insideExamples(manifest.file));
  const byKindIdentity = new Map<string, Manifest>();
  for (const manifest of repositoryManifests) {
    try {
      const key = `${manifest.kind}:${identity(manifest) ?? ""}`;
      if (identity(manifest)) {
        if (byKindIdentity.has(key)) diagnostics.push({ file: manifest.file, code: "semantic/duplicate-identity", message: `duplicate ${manifest.kind} identity ${identity(manifest)}` });
        else byKindIdentity.set(key, manifest);
      }
    } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/identity", message: error instanceof Error ? error.message : String(error) }); }
  }
  const taskByIdentity = new Map<string, Manifest>();
  for (const manifest of repositoryManifests.filter((item) => item.kind === "task")) {
    const id = asString(manifest.value.id), version = asString(manifest.value.version), status = asString(manifest.value.status);
    const taskRoot = `tasks/${id}/${version}`;
    taskByIdentity.set(`${id}@${version}`, manifest);
    try {
      const prompt = asObject(manifest.value.prompt), state = asObject(manifest.value.problem_state), source = asObject(state.source), evaluator = asObject(manifest.value.evaluator);
      const checkIds = (asObject(manifest.value.scoring).checks as unknown[]).map((check) => asString(asObject(check).id));
      if (new Set(checkIds).size !== checkIds.length) diagnostics.push({ file: manifest.file, code: "semantic/check-ids", message: "task scoring check IDs must be unique" });
      const sourceKind = asString(source.kind);
      const optionalPaths = [typeof source.path === "string" ? source.path : undefined, typeof asObject(manifest.value.calibration ?? {}).evidence_path === "string" ? asString(asObject(manifest.value.calibration ?? {}).evidence_path) : undefined];
      if (sourceKind === "git") for (const patch of (source.patches as unknown[] | undefined) ?? []) optionalPaths.push(asString(asObject(patch).path));
      const paths = [asString(prompt.path), asString(evaluator.path), ...optionalPaths].filter((value): value is string => Boolean(value));
      for (const path of paths) await resolveSafe(root, path);
      if (nonDraft.has(status)) {
        if (!new RegExp(`^${taskRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/task\\.(json|ya?ml)$`).test(relative(root, manifest.file).split(sep).join("/"))) throw new Error("candidate/released/retired task spec must be co-located at tasks/<id>/<version>/task.{json,yaml,yml}");
        if (asString(prompt.path) !== `${taskRoot}/prompt.md` || asString(evaluator.path) !== `${taskRoot}/evaluator`) throw new Error("candidate/released/retired prompt and evaluator must be co-located with its task spec");
        const promptFile = await resolveSafe(root, asString(prompt.path));
        const evaluatorDirectory = await resolveSafe(root, asString(evaluator.path));
        const promptDigest = `sha256:${sha256(await readFile(promptFile))}`;
        if (promptDigest !== asString(prompt.digest)) throw new Error(`prompt digest mismatch: expected ${asString(prompt.digest)}, got ${promptDigest}`);
        if (!await isDirectory(evaluatorDirectory)) throw new Error("evaluator must be a directory");
        const actualEvaluator = await treeDigest(evaluatorDirectory); if (actualEvaluator !== asString(evaluator.digest)) throw new Error(`evaluator digest mismatch: expected ${asString(evaluator.digest)}, got ${actualEvaluator}`);
        if ((status === "released" || status === "retired") && manifest.value.calibration !== undefined) {
          const calibration = asObject(manifest.value.calibration);
          const evidencePath = asString(calibration.evidence_path);
          const evidenceFile = await resolveSafe(root, evidencePath);
          const actualEvidence = `sha256:${sha256(await readFile(evidenceFile))}`;
          if (actualEvidence !== asString(calibration.evidence_digest)) throw new Error(`calibration evidence digest mismatch for ${evidencePath}: expected ${asString(calibration.evidence_digest)}, got ${actualEvidence}`);
        }
        if (sourceKind === "directory") {
          if (asString(source.path) !== `${taskRoot}/state`) throw new Error("checked-in directory source must be co-located at tasks/<id>/<version>/state");
          const stateDirectory = await resolveSafe(root, asString(source.path));
          if (!await isDirectory(stateDirectory)) throw new Error("problem state must be a directory");
          const actualState = await treeDigest(stateDirectory); if (actualState !== asString(state.expected_tree_digest)) throw new Error(`problem-state digest mismatch: expected ${asString(state.expected_tree_digest)}, got ${actualState}`);
        } else if (sourceKind === "archive" && typeof source.path === "string") {
          const archive = await resolveSafe(root, source.path); const actual = `sha256:${sha256(await readFile(archive))}`;
          if (actual !== asString(source.archive_digest)) throw new Error(`archive digest mismatch: expected ${asString(source.archive_digest)}, got ${actual}`);
        } else if (sourceKind === "git") {
          for (const patch of (source.patches as unknown[] | undefined) ?? []) { const item = asObject(patch); const actual = `sha256:${sha256(await readFile(await resolveSafe(root, asString(item.path))))}`; if (actual !== asString(item.digest)) throw new Error(`patch digest mismatch for ${asString(item.path)}`); }
        }
      }
    } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/task-artifact", message: error instanceof Error ? error.message : String(error) }); }
  }
  const taskRoots = new Set(repositoryManifests.filter((item) => item.kind === "task").map((item) => join(root, "tasks", asString(item.value.id), asString(item.value.version))));
  const artifacts = await canonicalArtifactDirectories(join(root, "tasks"));
  for (const artifact of artifacts) {
    if (!taskRoots.has(join(artifact, ".."))) diagnostics.push({ file: artifact, code: "semantic/orphan-artifact", message: "state/evaluator artifact has no co-located task spec" });
  }
  const suiteByIdentity = new Map<string, Manifest>();
  for (const suite of repositoryManifests.filter((item) => item.kind === "suite")) {
    suiteByIdentity.set(`${asString(suite.value.id)}@${asString(suite.value.version)}`, suite);
    const suiteStatus = asString(suite.value.status);
    for (const item of suite.value.tasks as unknown[]) {
      const task = asObject(item), target = taskByIdentity.get(`${asString(task.id)}@${asString(task.version)}`);
      if (!target) diagnostics.push({ file: suite.file, code: "semantic/task-reference", message: `missing task ${asString(task.id)}@${asString(task.version)}` });
      else {
        try { const path = asString(task.spec_path); if (!safeRelativePath(path) || resolve(root, path) !== resolve(target.file)) diagnostics.push({ file: suite.file, code: "semantic/task-path", message: `task spec_path does not resolve to ${asString(task.id)}@${asString(task.version)}` }); }
        catch { diagnostics.push({ file: suite.file, code: "semantic/task-path", message: `unsafe task spec_path for ${asString(task.id)}@${asString(task.version)}` }); }
        if (suiteStatus === "released" && asString(target.value.status) !== "released") diagnostics.push({ file: suite.file, code: "semantic/released-suite", message: `released suite references non-released task ${asString(task.id)}@${asString(task.version)}` });
        if (task.spec_digest !== undefined && asString(task.spec_digest) !== manifestDigest(target.value)) diagnostics.push({ file: suite.file, code: "semantic/task-digest", message: `task digest mismatch for ${asString(task.id)}@${asString(task.version)}` });
      }
    }
  }
  for (const experiment of repositoryManifests.filter((item) => item.kind === "experiment")) {
    const reference = asObject(experiment.value.suite), target = suiteByIdentity.get(`${asString(reference.id)}@${asString(reference.version)}`);
    if (!target) diagnostics.push({ file: experiment.file, code: "semantic/suite-reference", message: `missing suite ${asString(reference.id)}@${asString(reference.version)}` });
    else {
      try { const path = asString(reference.spec_path); if (!safeRelativePath(path) || resolve(root, path) !== resolve(target.file)) diagnostics.push({ file: experiment.file, code: "semantic/suite-path", message: `suite spec_path does not resolve to ${asString(reference.id)}@${asString(reference.version)}` }); }
      catch { diagnostics.push({ file: experiment.file, code: "semantic/suite-path", message: `unsafe suite spec_path for ${asString(reference.id)}@${asString(reference.version)}` }); }
      if (asString(reference.spec_digest) !== manifestDigest(target.value)) diagnostics.push({ file: experiment.file, code: "semantic/suite-digest", message: `suite digest mismatch for ${asString(reference.id)}@${asString(reference.version)}` });
    }
  }
  for (const evaluation of repositoryManifests.filter((item) => item.kind === "evaluation")) {
    const task = taskByIdentity.get(`${asString(evaluation.value.task_id)}@${asString(evaluation.value.task_version)}`);
    if (!task) { diagnostics.push({ file: evaluation.file, code: "semantic/task-reference", message: `missing task ${asString(evaluation.value.task_id)}@${asString(evaluation.value.task_version)}` }); continue; }
    if (asString(evaluation.value.status) === "ok") {
      const expectedIds = (asObject(task.value.scoring).checks as unknown[]).map((check) => asString(asObject(check).id));
      const actualIds = (evaluation.value.checks as unknown[]).map((check) => asString(asObject(check).id));
      const expected = new Set(expectedIds), actual = new Set(actualIds);
      if (actual.size !== actualIds.length || expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) diagnostics.push({ file: evaluation.file, code: "semantic/check-ids", message: "evaluator check IDs must be unique and exactly match task scoring check IDs" });
    }
  }
  if (diagnostics.length) throw new ValidationError(diagnostics);
}
