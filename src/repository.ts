import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { manifestDigest, sha256, treeDigest } from "./digests.js";
import { isManifestPath, loadManifest } from "./load.js";
import { kindFromRepositoryPath, SchemaValidator } from "./schema.js";
import { Diagnostic, ValidationError } from "./types.js";

type ObjectValue = Record<string, unknown>;
type Manifest = { file: string; kind: string; value: ObjectValue };
const nonDraft = new Set(["candidate", "released", "retired"]);
const scorableFailureReasons = new Set(["wall_time_exhausted", "token_limit_exhausted", "tool_limit_exhausted"]);
const artifactTargetKeys: Record<string, string> = { request: "request", "run-result": "run_result", "native-events": "native_events", "normalized-events": "normalized_events", stdout: "stdout", stderr: "stderr", "final-message": "final_message", "workspace-patch": "workspace_patch", "workspace-tree": "workspace_tree", "evaluator-result": "evaluator_result" };

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
async function discoveryDirectory(path: string, diagnostics: Diagnostic[]): Promise<boolean> {
  try {
    const fileType = await lstat(path);
    if (!fileType.isDirectory() || fileType.isSymbolicLink()) {
      diagnostics.push({ file: path, code: "semantic/discovery-root", message: "repository discovery root must be a regular non-symlink directory" });
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function asObject(value: unknown): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object"); return value as ObjectValue; }
function asString(value: unknown): string { if (typeof value !== "string") throw new Error("expected string"); return value; }
function derivedQualityEligibility(value: ObjectValue): boolean {
  const summary = asObject(value.evaluation), terminal = asObject(value.terminal), attempt = asObject(value.attempt);
  const terminalReason = asString(terminal.reason), terminalAttribution = asString(terminal.attribution);
  const diagnosticAttempt = attempt.initiated_by === "operator" && (attempt.mode === "retry" || attempt.mode === "resume");
  const scorableAgentOutcome = terminalAttribution === "agent" && (terminalReason === "agent_completed" || terminalReason === "agent_failed");
  return !diagnosticAttempt && summary.status === "ok" && (scorableFailureReasons.has(terminalReason) || scorableAgentOutcome);
}

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

async function walk(root: string, directory: string, out: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const repositoryPath = relative(root, file).split(sep).join("/");
      if (kindFromRepositoryPath(repositoryPath)) out.push(file);
      continue;
    }
    if (entry.isDirectory()) await walk(root, file, out);
    else if (entry.isFile() && isManifestPath(file)) out.push(file);
  }
}
async function taskManifests(tasksDirectory: string): Promise<string[]> {
  const manifests: string[] = [];
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

function insideExamples(root: string, file: string): boolean { return relative(root, file).split(sep).join("/").startsWith("spec/examples/"); }
function manifestOwnedPath(file: string): boolean { const parts = file.replace(/^\.\//, "").split(/[\\/]/); return parts[0] === "tasks" || parts[0] === "suites" || parts[0] === "experiments"; }
function identity(manifest: Manifest): string | undefined {
  if (["task", "suite", "experiment"].includes(manifest.kind)) return `${asString(manifest.value.id)}@${asString(manifest.value.version)}`;
  if (manifest.kind === "campaign") return asString(manifest.value.campaign_id);
  if (["run-request", "run-result"].includes(manifest.kind)) return asString(manifest.value.run_id);
  return undefined;
}
function declaredManifestPaths(manifest: Manifest): string[] | undefined {
  const id = typeof manifest.value.id === "string" ? asString(manifest.value.id) : undefined;
  const version = typeof manifest.value.version === "string" ? asString(manifest.value.version) : undefined;
  if (manifest.kind === "task") return ["json", "yaml", "yml"].map((extension) => `tasks/${id}/${version}/task.${extension}`);
  if (manifest.kind === "suite") return ["json", "yaml", "yml"].map((extension) => `suites/${id}/${version}.${extension}`);
  if (manifest.kind === "experiment") return ["json", "yaml", "yml"].map((extension) => `experiments/${id}/${version}.${extension}`);
  if (manifest.kind === "campaign") return [`results/${asString(asObject(manifest.value.experiment).id)}/${asString(manifest.value.campaign_id)}/campaign.json`];
  if (manifest.kind === "run-request" || manifest.kind === "run-result") {
    const root = `results/${asString(asObject(manifest.value.experiment).id)}/${asString(manifest.value.campaign_id)}/runs/${asString(manifest.value.run_id)}`;
    return [`${root}/${manifest.kind === "run-request" ? "request.json" : "run.json"}`];
  }
  return undefined;
}

export async function validateRepository(rootInput: string): Promise<void> {
  const root = await realpath(rootInput);
  const schemas = await SchemaValidator.create(join(root, "spec/schemas"));
  const diagnostics: Diagnostic[] = [];
  const manifests: Manifest[] = [];
  const exampleDirectory = join(root, "spec/examples");
  const exampleFiles = await discoveryDirectory(exampleDirectory, diagnostics)
    ? (await readdir(exampleDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && isManifestPath(entry.name)).map((entry) => join(exampleDirectory, entry.name))
    : [];
  const tasksDirectory = join(root, "tasks");
  const tasksDirectoryAvailable = await discoveryDirectory(tasksDirectory, diagnostics);
  const repoFiles = tasksDirectoryAvailable ? await taskManifests(tasksDirectory) : [];
  for (const directory of ["suites", "experiments", "results"]) {
    const discoveryRoot = join(root, directory);
    if (await discoveryDirectory(discoveryRoot, diagnostics)) await walk(root, discoveryRoot, repoFiles);
  }
  for (const file of [...exampleFiles, ...repoFiles].sort()) {
    const repositoryPath = relative(root, file).split(sep).join("/");
    const kind = kindFromRepositoryPath(repositoryPath);
    if (!kind) { if (manifestOwnedPath(repositoryPath)) diagnostics.push({ file, code: "semantic/unknown-manifest", message: "cannot infer manifest schema kind from a manifest-owned path" }); continue; }
    if (!insideExamples(root, file)) {
      const fileType = await lstat(file);
      if (fileType.isSymbolicLink() || !fileType.isFile()) {
        diagnostics.push({ file, code: `semantic/${kind}-manifest-type`, message: `canonical ${kind} manifest must be a regular non-symlink file` });
        continue;
      }
    }
    try { const value = asObject(await loadManifest(file)); schemas.validate(kind, value, file); manifests.push({ file, kind, value }); }
    catch (error) { diagnostics.push(...(error instanceof ValidationError ? error.diagnostics : [{ file, code: "internal", message: error instanceof Error ? error.message : String(error) }])); }
  }
  const repositoryManifests = manifests.filter((manifest) => !insideExamples(root, manifest.file));
  for (const manifest of repositoryManifests) {
    const declaredPaths = declaredManifestPaths(manifest);
    const manifestPath = relative(root, manifest.file).split(sep).join("/");
    if (declaredPaths && !declaredPaths.includes(manifestPath)) diagnostics.push({ file: manifest.file, code: `semantic/${manifest.kind}-identity`, message: `${manifest.kind} manifest path does not match its declared identity` });
  }
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
  const runResultsByFile = new Map(repositoryManifests.filter((manifest) => manifest.kind === "run-result").map((manifest) => [resolve(manifest.file), manifest]));
  for (const campaign of repositoryManifests.filter((manifest) => manifest.kind === "campaign")) {
    const campaignDirectory = relative(root, dirname(campaign.file)).split(sep).join("/");
    const campaignId = asString(campaign.value.campaign_id), campaignExperiment = asObject(campaign.value.experiment), campaignSuite = asObject(campaign.value.suite);
    const referencedRuns: Manifest[] = [];
    const referencedRunIds = new Set<string>(), referencedRunPaths = new Set<string>();
    let referencesValid = true;
    for (const item of campaign.value.runs as unknown[]) {
      const reference = asObject(item), runId = asString(reference.run_id), path = asString(reference.path);
      if (referencedRunIds.has(runId) || referencedRunPaths.has(path)) { diagnostics.push({ file: campaign.file, code: "semantic/duplicate-run-reference", message: `duplicate campaign run reference ${runId}` }); referencesValid = false; }
      else { referencedRunIds.add(runId); referencedRunPaths.add(path); }
      const expectedPath = `runs/${runId}/run.json`;
      if (!safeRelativePath(path) || path !== expectedPath) {
        diagnostics.push({ file: campaign.file, code: "semantic/campaign-run-path", message: `campaign run ${runId} must use canonical path ${expectedPath}` });
        referencesValid = false;
        continue;
      }
      let target: Manifest | undefined;
      try { target = runResultsByFile.get(await resolveSafe(root, `${campaignDirectory}/${path}`)); }
      catch (error) { diagnostics.push({ file: campaign.file, code: "semantic/campaign-run-path", message: error instanceof Error ? error.message : String(error) }); referencesValid = false; continue; }
      if (!target) { diagnostics.push({ file: campaign.file, code: "semantic/campaign-run-reference", message: `missing run result ${path}` }); referencesValid = false; continue; }
      const targetExperiment = asObject(target.value.experiment), targetSuite = asObject(target.value.suite);
      const linked = asString(target.value.run_id) === runId
        && asString(target.value.campaign_id) === campaignId
        && asString(targetExperiment.id) === asString(campaignExperiment.id)
        && asString(targetExperiment.version) === asString(campaignExperiment.version)
        && asString(targetSuite.id) === asString(campaignSuite.id)
        && asString(targetSuite.version) === asString(campaignSuite.version);
      if (!linked) { diagnostics.push({ file: campaign.file, code: "semantic/campaign-run-identity", message: `run result identity does not match campaign reference ${runId}` }); referencesValid = false; }
      if (asString(reference.digest) !== manifestDigest(target.value)) { diagnostics.push({ file: campaign.file, code: "semantic/campaign-run-digest", message: `run result digest mismatch for ${runId}` }); referencesValid = false; }
      const campaignRunner = asObject(campaign.value.runner), provenance = asObject(target.value.provenance);
      const campaignRuntime = asObject(campaignRunner.runtime), runRuntime = asObject(provenance.runner_runtime);
      const runnerMatches = asString(campaignRunner.version) === asString(provenance.runner_version)
        && asString(campaignRunner.git_commit) === asString(provenance.runner_git_commit)
        && asString(campaignRuntime.name) === asString(runRuntime.name)
        && asString(campaignRuntime.version) === asString(runRuntime.version);
      if (!runnerMatches) { diagnostics.push({ file: campaign.file, code: "semantic/campaign-runner", message: `run result runner provenance does not match campaign runner for ${runId}` }); referencesValid = false; }
      referencedRuns.push(target);
    }
    if (referencesValid) {
      const summary = asObject(campaign.value.summary);
      const qualityEligibleRuns = referencedRuns.filter((run) => derivedQualityEligibility(run.value));
      const expectedSummary: Record<string, number> = {
        recorded_runs: referencedRuns.length,
        operational_successes: referencedRuns.filter((run) => asObject(run.value.terminal).operational_success === true).length,
        quality_eligible_runs: qualityEligibleRuns.length,
        end_to_end_passes: referencedRuns.filter((run) => asObject(run.value.evaluation).end_to_end_passed === true).length,
        invalid_runs: referencedRuns.length - qualityEligibleRuns.length
      };
      for (const [name, expected] of Object.entries(expectedSummary)) if (summary[name] !== expected) diagnostics.push({ file: campaign.file, code: "semantic/campaign-summary", message: `campaign summary ${name} must be ${expected}` });
    }
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
        if (sourceKind === "archive" && typeof source.path !== "string") throw new Error("URI-only archive sources cannot be verified against their declared archive digest");
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
        } else if (sourceKind === "archive") {
          const archive = await resolveSafe(root, asString(source.path)); const actual = `sha256:${sha256(await readFile(archive))}`;
          if (actual !== asString(source.archive_digest)) throw new Error(`archive digest mismatch: expected ${asString(source.archive_digest)}, got ${actual}`);
        } else if (sourceKind === "git") {
          for (const patch of (source.patches as unknown[] | undefined) ?? []) { const item = asObject(patch); const actual = `sha256:${sha256(await readFile(await resolveSafe(root, asString(item.path))))}`; if (actual !== asString(item.digest)) throw new Error(`patch digest mismatch for ${asString(item.path)}`); }
        }
      }
    } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/task-artifact", message: error instanceof Error ? error.message : String(error) }); }
  }
  const taskRoots = new Set(repositoryManifests.filter((item) => item.kind === "task").map((item) => join(root, "tasks", asString(item.value.id), asString(item.value.version))));
  const artifacts = tasksDirectoryAvailable ? await canonicalArtifactDirectories(tasksDirectory) : [];
  for (const artifact of artifacts) {
    if (!taskRoots.has(join(artifact, ".."))) diagnostics.push({ file: artifact, code: "semantic/orphan-artifact", message: "state/evaluator artifact has no co-located task spec" });
  }
  const suiteByIdentity = new Map<string, Manifest>();
  for (const suite of repositoryManifests.filter((item) => item.kind === "suite")) {
    suiteByIdentity.set(`${asString(suite.value.id)}@${asString(suite.value.version)}`, suite);
    const suiteStatus = asString(suite.value.status);
    const taskReferences = new Set<string>();
    for (const item of suite.value.tasks as unknown[]) {
      const task = asObject(item), target = taskByIdentity.get(`${asString(task.id)}@${asString(task.version)}`);
      const taskReference = `${asString(task.id)}@${asString(task.version)}`;
      if (taskReferences.has(taskReference)) diagnostics.push({ file: suite.file, code: "semantic/duplicate-task-reference", message: `duplicate suite task reference ${taskReference}` });
      else taskReferences.add(taskReference);
      if (!target) diagnostics.push({ file: suite.file, code: "semantic/task-reference", message: `missing task ${asString(task.id)}@${asString(task.version)}` });
      else {
        try { const path = asString(task.spec_path); if (!safeRelativePath(path) || resolve(root, path) !== resolve(target.file)) diagnostics.push({ file: suite.file, code: "semantic/task-path", message: `task spec_path does not resolve to ${asString(task.id)}@${asString(task.version)}` }); }
        catch { diagnostics.push({ file: suite.file, code: "semantic/task-path", message: `unsafe task spec_path for ${asString(task.id)}@${asString(task.version)}` }); }
        if (suiteStatus === "released" && asString(target.value.status) !== "released") diagnostics.push({ file: suite.file, code: "semantic/released-suite", message: `released suite references non-released task ${asString(task.id)}@${asString(task.version)}` });
        if (suiteStatus === "retired" && !["released", "retired"].includes(asString(target.value.status))) diagnostics.push({ file: suite.file, code: "semantic/retired-suite", message: `retired suite references mutable task ${asString(task.id)}@${asString(task.version)}` });
        if (task.spec_digest !== undefined && asString(task.spec_digest) !== manifestDigest(target.value)) diagnostics.push({ file: suite.file, code: "semantic/task-digest", message: `task digest mismatch for ${asString(task.id)}@${asString(task.version)}` });
      }
    }
  }
  const experimentByIdentity = new Map<string, Manifest>();
  for (const experiment of repositoryManifests.filter((item) => item.kind === "experiment")) {
    experimentByIdentity.set(`${asString(experiment.value.id)}@${asString(experiment.value.version)}`, experiment);
    const configurationIds = (experiment.value.configurations as unknown[]).map((configuration) => asString(asObject(configuration).id));
    const declaredConfigurations = new Set<string>();
    for (const configurationId of configurationIds) {
      if (declaredConfigurations.has(configurationId)) diagnostics.push({ file: experiment.file, code: "semantic/duplicate-configuration", message: `duplicate experiment configuration ID ${configurationId}` });
      else declaredConfigurations.add(configurationId);
    }
    for (const value of asObject(experiment.value.reporting).comparisons as unknown[]) {
      const comparison = asObject(value), comparisonId = asString(comparison.id), baseline = asString(comparison.baseline_configuration_id);
      if (!declaredConfigurations.has(baseline)) diagnostics.push({ file: experiment.file, code: "semantic/comparison-configuration", message: `comparison ${comparisonId} references undeclared baseline configuration ${baseline}` });
      for (const candidate of comparison.candidate_configuration_ids as unknown[]) {
        const candidateId = asString(candidate);
        if (!declaredConfigurations.has(candidateId)) diagnostics.push({ file: experiment.file, code: "semantic/comparison-configuration", message: `comparison ${comparisonId} references undeclared candidate configuration ${candidateId}` });
      }
    }
    const reference = asObject(experiment.value.suite), target = suiteByIdentity.get(`${asString(reference.id)}@${asString(reference.version)}`);
    if (!target) diagnostics.push({ file: experiment.file, code: "semantic/suite-reference", message: `missing suite ${asString(reference.id)}@${asString(reference.version)}` });
    else {
      try { const path = asString(reference.spec_path); if (!safeRelativePath(path) || resolve(root, path) !== resolve(target.file)) diagnostics.push({ file: experiment.file, code: "semantic/suite-path", message: `suite spec_path does not resolve to ${asString(reference.id)}@${asString(reference.version)}` }); }
      catch { diagnostics.push({ file: experiment.file, code: "semantic/suite-path", message: `unsafe suite spec_path for ${asString(reference.id)}@${asString(reference.version)}` }); }
      if (asString(reference.spec_digest) !== manifestDigest(target.value)) diagnostics.push({ file: experiment.file, code: "semantic/suite-digest", message: `suite digest mismatch for ${asString(reference.id)}@${asString(reference.version)}` });
      if (experiment.value.task_selection !== undefined) {
        const selection = asObject(experiment.value.task_selection);
        const selectedIds = (selection.include ?? selection.exclude) as unknown[];
        const suiteTaskIds = new Set((target.value.tasks as unknown[]).map((item) => asString(asObject(item).id)));
        for (const selectedId of selectedIds.map(asString)) if (!suiteTaskIds.has(selectedId)) diagnostics.push({ file: experiment.file, code: "semantic/task-selection", message: `task_selection references task ID not present in suite: ${selectedId}` });
      }
    }
  }
  function validateSpecReference(owner: Manifest, reference: ObjectValue, kind: "experiment" | "suite" | "task", targets: Map<string, Manifest>): Manifest | undefined {
    const id = asString(reference.id), version = asString(reference.version), target = targets.get(`${id}@${version}`);
    if (!target) { diagnostics.push({ file: owner.file, code: `semantic/${kind}-reference`, message: `missing ${kind} ${id}@${version}` }); return undefined; }
    const path = asString(reference.spec_path);
    if (!safeRelativePath(path) || resolve(root, path) !== resolve(target.file)) diagnostics.push({ file: owner.file, code: `semantic/${kind}-path`, message: `${kind} spec_path does not resolve to ${id}@${version}` });
    if (asString(reference.spec_digest) !== manifestDigest(target.value)) diagnostics.push({ file: owner.file, code: `semantic/${kind}-digest`, message: `${kind} digest mismatch for ${id}@${version}` });
    return target;
  }
  function validateTaskFingerprints(owner: Manifest, reference: ObjectValue, task: Manifest): void {
    try {
      const prompt = asObject(task.value.prompt), state = asObject(task.value.problem_state), evaluator = asObject(task.value.evaluator);
      const matching = asString(reference.prompt_digest) === asString(prompt.digest)
        && asString(reference.initial_tree_digest) === asString(state.expected_tree_digest)
        && asString(reference.evaluator_digest) === asString(evaluator.digest);
      if (!matching) diagnostics.push({ file: owner.file, code: "semantic/task-fingerprint", message: `task artifact fingerprints do not match ${asString(reference.id)}@${asString(reference.version)}` });
    } catch (error) { diagnostics.push({ file: owner.file, code: "semantic/task-fingerprint", message: error instanceof Error ? error.message : String(error) }); }
  }
  for (const campaign of repositoryManifests.filter((manifest) => manifest.kind === "campaign")) {
    const experimentReference = asObject(campaign.value.experiment), suiteReference = asObject(campaign.value.suite);
    const experiment = validateSpecReference(campaign, experimentReference, "experiment", experimentByIdentity);
    const suite = validateSpecReference(campaign, suiteReference, "suite", suiteByIdentity);
    const suiteMatchesExperiment = experiment && suite && manifestDigest(suiteReference) === manifestDigest(experiment.value.suite);
    if (experiment && suite && !suiteMatchesExperiment) diagnostics.push({ file: campaign.file, code: "semantic/experiment-suite", message: "campaign suite does not match the experiment's pinned suite" });
    if (experiment && suite && suiteMatchesExperiment) {
      const selection = experiment.value.task_selection === undefined ? undefined : asObject(experiment.value.task_selection);
      const selectedTaskCount = (suite.value.tasks as unknown[]).filter((item) => {
        const taskId = asString(asObject(item).id);
        if (selection && Array.isArray(selection.include)) return selection.include.includes(taskId);
        if (selection && Array.isArray(selection.exclude)) return !selection.exclude.includes(taskId);
        return true;
      }).length;
      const plannedRunCount = selectedTaskCount * (experiment.value.configurations as unknown[]).length * (experiment.value.repetitions as number);
      if (campaign.value.planned_run_count !== plannedRunCount) diagnostics.push({ file: campaign.file, code: "semantic/campaign-plan", message: `campaign planned_run_count must be ${plannedRunCount}` });
    }
  }
  for (const manifest of repositoryManifests.filter((item) => item.kind === "run-request" || item.kind === "run-result")) {
    const experimentReference = asObject(manifest.value.experiment), suiteReference = asObject(manifest.value.suite);
    const experiment = validateSpecReference(manifest, experimentReference, "experiment", experimentByIdentity);
    const suite = validateSpecReference(manifest, suiteReference, "suite", suiteByIdentity);
    if (experiment) {
      const repetition = manifest.value.repetition as number, repetitions = experiment.value.repetitions as number;
      if (repetition < 1 || repetition > repetitions) diagnostics.push({ file: manifest.file, code: "semantic/run-repetition", message: `run repetition ${repetition} must be between 1 and experiment repetitions ${repetitions}` });
    }
    if (experiment && suite && manifestDigest(suiteReference) !== manifestDigest(experiment.value.suite)) diagnostics.push({ file: manifest.file, code: "semantic/experiment-suite", message: "run suite does not match the experiment's pinned suite" });
    const taskReference = asObject(manifest.value.task), task = validateSpecReference(manifest, taskReference, "task", taskByIdentity);
    if (task) {
      validateTaskFingerprints(manifest, taskReference, task);
      if (suite && !(suite.value.tasks as unknown[]).some((item) => { const reference = asObject(item); return reference.id === taskReference.id && reference.version === taskReference.version; })) diagnostics.push({ file: manifest.file, code: "semantic/run-task-suite", message: `run task ${asString(taskReference.id)}@${asString(taskReference.version)} is not present in its suite` });
      if (experiment && experiment.value.task_selection !== undefined) {
        const selection = asObject(experiment.value.task_selection), taskId = asString(taskReference.id);
        if ((Array.isArray(selection.include) && !selection.include.includes(taskId)) || (Array.isArray(selection.exclude) && selection.exclude.includes(taskId))) diagnostics.push({ file: manifest.file, code: "semantic/run-task-selection", message: `run task ${taskId} is not selected by experiment task_selection` });
      }
      if (manifest.kind === "run-request") {
        try {
          const workspace = asObject(manifest.value.workspace), prompt = asObject(task.value.prompt), state = asObject(task.value.problem_state);
          const workspaceMatches = asString(workspace.prompt_path) === asString(prompt.path)
            && asString(workspace.prompt_digest) === asString(prompt.digest)
            && asString(workspace.initial_tree_digest) === asString(state.expected_tree_digest);
          if (!workspaceMatches) diagnostics.push({ file: manifest.file, code: "semantic/workspace-fingerprint", message: "run request workspace fingerprints do not match TaskSpec" });
        } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/workspace-fingerprint", message: error instanceof Error ? error.message : String(error) }); }
        try {
          const environment = asObject(task.value.environment);
          if (manifestDigest(manifest.value.network) !== manifestDigest(environment.network)) diagnostics.push({ file: manifest.file, code: "semantic/run-network-policy", message: "run request network policy does not match TaskSpec" });
        } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/run-network-policy", message: error instanceof Error ? error.message : String(error) }); }
        try {
          const runtime = asObject(asObject(task.value.environment).runtime), execution = asObject(manifest.value.execution);
          if (runtime.kind === "oci") {
            const imageDigest = asString(runtime.image_digest);
            if (execution.environment_digest !== imageDigest || execution.image_digest !== imageDigest) diagnostics.push({ file: manifest.file, code: "semantic/run-environment", message: "run request execution environment_digest and image_digest must match the TaskSpec OCI image_digest" });
          }
        } catch (error) { diagnostics.push({ file: manifest.file, code: "semantic/run-environment", message: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (manifest.kind === "run-request") {
      const configuration = asObject(manifest.value.configuration), harness = asObject(configuration.harness), invocation = asObject(manifest.value.invocation);
      if (experiment) {
        const declared = (experiment.value.configurations as unknown[]).find((item) => asObject(item).id === configuration.id);
        if (!declared || manifestDigest(declared) !== manifestDigest(configuration)) diagnostics.push({ file: manifest.file, code: "semantic/run-configuration-reference", message: `run configuration ${asString(configuration.id)} does not exactly match its experiment declaration` });
      }
      if (asString(harness.runtime_version) !== asString(invocation.resolved_runtime_version)) diagnostics.push({ file: manifest.file, code: "semantic/run-configuration-runtime", message: "run configuration harness runtime_version must match invocation resolved_runtime_version" });
      if (asString(harness.family) === "codex") {
        const bypassesSandbox = (invocation.argv as unknown[]).some((argument) => argument === "--dangerously-bypass-approvals-and-sandbox");
        if (invocation.full_access !== bypassesSandbox) diagnostics.push({ file: manifest.file, code: "semantic/invocation-full-access", message: "Codex full_access must match the sandbox-bypass argv flag" });
      }
      const campaign = byKindIdentity.get(`campaign:${asString(manifest.value.campaign_id)}`);
      if (!campaign) diagnostics.push({ file: manifest.file, code: "semantic/campaign-preflight", message: `run request requires campaign ${asString(manifest.value.campaign_id)} to verify invocation preflight` });
      else {
        const ownsRequest = manifestDigest(experimentReference) === manifestDigest(campaign.value.experiment) && manifestDigest(suiteReference) === manifestDigest(campaign.value.suite);
        if (!ownsRequest) diagnostics.push({ file: manifest.file, code: "semantic/campaign-preflight", message: "run request experiment and suite must match its owning campaign before preflight validation" });
        else {
          const preflight = asObject(campaign.value.preflight), resolutions = preflight.harness_runtimes as unknown[];
          const matchesPreflight = resolutions.some((item) => { const resolution = asObject(item); return resolution.harness_family === harness.family
            && resolution.runtime_source === invocation.runtime_source
            && resolution.requested_runtime === invocation.requested_runtime
            && resolution.resolved_runtime_version === invocation.resolved_runtime_version
            && resolution.resolved_runtime_version === harness.runtime_version
            && resolution.runtime_digest === invocation.runtime_digest
            && resolution.executable_digest === invocation.executable_digest; });
          if (!matchesPreflight) diagnostics.push({ file: manifest.file, code: "semantic/campaign-preflight", message: `run invocation does not match campaign preflight for ${asString(harness.family)}` });
        }
      }
    }
  }
  const runRequestsByFile = new Map(repositoryManifests.filter((manifest) => manifest.kind === "run-request").map((manifest) => [resolve(manifest.file), manifest]));
  for (const run of repositoryManifests.filter((manifest) => manifest.kind === "run-result")) {
    const campaignDirectory = dirname(dirname(dirname(run.file)));
    for (const item of run.value.artifacts as unknown[]) {
      const artifact = asObject(item), artifactPath = asString(artifact.path);
      try {
        const file = await resolveSafe(campaignDirectory, artifactPath);
        let fileType;
        try { fileType = await lstat(file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`missing run artifact: ${artifactPath}`);
          throw error;
        }
        if (!fileType.isFile()) throw new Error(`run artifact is not a regular file: ${artifactPath}`);
        if (`sha256:${sha256(await readFile(file))}` !== asString(artifact.digest)) throw new Error(`run artifact digest mismatch: ${artifactPath}`);
      } catch (error) { diagnostics.push({ file: run.file, code: "semantic/run-artifact", message: error instanceof Error ? error.message : String(error) }); }
    }
    const request = runRequestsByFile.get(resolve(dirname(run.file), "request.json"));
    if (!request) { diagnostics.push({ file: run.file, code: "semantic/run-request-reference", message: "run result requires a co-located request.json" }); continue; }
    const artifactTargets = asObject(request.value.artifact_targets);
    for (const item of run.value.artifacts as unknown[]) {
      const artifact = asObject(item), kind = asString(artifact.kind), targetKey = artifactTargetKeys[kind];
      if (targetKey) {
        const target = artifactTargets[targetKey], expected = typeof target === "string" ? `runs/${asString(run.value.run_id)}/${target}` : undefined;
        if (artifact.path !== expected) diagnostics.push({ file: run.file, code: "semantic/run-artifact-target", message: `${kind} artifact path must match request target ${expected ?? targetKey}` });
      }
    }
    const provenance = asObject(run.value.provenance);
    if (asString(provenance.request_digest) !== manifestDigest(request.value)) diagnostics.push({ file: run.file, code: "semantic/run-request-digest", message: "run result request_digest does not match request.json" });
    const requestConfiguration = asObject(request.value.configuration), resolvedConfiguration = asObject(run.value.resolved_configuration);
    const identityMatches = asString(run.value.run_id) === asString(request.value.run_id)
      && asString(run.value.campaign_id) === asString(request.value.campaign_id)
      && manifestDigest(run.value.experiment) === manifestDigest(request.value.experiment)
      && manifestDigest(run.value.suite) === manifestDigest(request.value.suite)
      && manifestDigest(run.value.task) === manifestDigest(request.value.task)
      && asString(run.value.configuration_id) === asString(requestConfiguration.id)
      && run.value.repetition === request.value.repetition
      && run.value.schedule_index === request.value.schedule_index
      && manifestDigest(run.value.attempt) === manifestDigest(request.value.attempt);
    if (!identityMatches) diagnostics.push({ file: run.file, code: "semantic/run-request-identity", message: "run result identity does not match request.json" });
    const requestModel = asObject(requestConfiguration.model), resolvedModel = asObject(resolvedConfiguration.model);
    const configurationMatches = manifestDigest(requestConfiguration.harness) === manifestDigest(resolvedConfiguration.harness)
      && manifestDigest(requestConfiguration.effort) === manifestDigest(resolvedConfiguration.effort)
      && manifestDigest(requestConfiguration.limits) === manifestDigest(resolvedConfiguration.limits)
      && asString(requestModel.provider) === asString(resolvedModel.provider)
      && asString(requestModel.requested_id) === asString(resolvedModel.requested_id)
      && (requestModel.expected_snapshot_id === undefined
        || (resolvedModel.snapshot_available === true && resolvedModel.resolved_id === requestModel.expected_snapshot_id));
    if (!configurationMatches) diagnostics.push({ file: run.file, code: "semantic/run-configuration", message: "run result resolved configuration does not match request.json" });
    if (manifestDigest(request.value.execution) !== manifestDigest(provenance.execution)) diagnostics.push({ file: run.file, code: "semantic/run-execution", message: "run result execution provenance does not match request.json" });
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
  const evaluationsByFile = new Map(repositoryManifests.filter((manifest) => manifest.kind === "evaluation").map((manifest) => [resolve(manifest.file), manifest]));
  for (const run of repositoryManifests.filter((manifest) => manifest.kind === "run-result")) {
    const summary = asObject(run.value.evaluation), summaryStatus = asString(summary.status);
    const terminal = asObject(run.value.terminal), terminalReason = asString(terminal.reason), terminalAttribution = asString(terminal.attribution);
    const attempt = asObject(run.value.attempt);
    if ((terminalReason === "agent_completed" || terminalReason === "agent_failed") && terminalAttribution !== "agent") diagnostics.push({ file: run.file, code: "semantic/run-terminal-attribution", message: `${terminalReason} terminal reason requires agent attribution, got ${terminalAttribution}` });
    const qualityEligible = derivedQualityEligibility(run.value);
    if (summary.eligible_for_quality_aggregate !== qualityEligible) diagnostics.push({ file: run.file, code: "semantic/run-quality-eligibility", message: `eligible_for_quality_aggregate must be ${qualityEligible} for ${asString(attempt.mode)} attempt, evaluation status ${summaryStatus}, and terminal reason ${terminalReason}` });
    const evaluation = evaluationsByFile.get(resolve(dirname(run.file), "evaluator.json"));
    if (!evaluation) {
      if (summaryStatus === "ok") diagnostics.push({ file: run.file, code: "semantic/run-evaluation-reference", message: "successful run evaluation requires a co-located evaluator.json" });
      continue;
    }
    const taskReference = asObject(run.value.task);
    const identityMatches = asString(evaluation.value.task_id) === asString(taskReference.id) && asString(evaluation.value.task_version) === asString(taskReference.version);
    if (!identityMatches) diagnostics.push({ file: run.file, code: "semantic/run-evaluation-identity", message: "evaluator task identity does not match run result" });
    if (asString(evaluation.value.status) !== summaryStatus) diagnostics.push({ file: run.file, code: "semantic/run-evaluation-status", message: "evaluator status does not match run evaluation status" });
    if (summaryStatus !== "ok" || asString(evaluation.value.status) !== "ok") continue;
    if (asString(summary.result_artifact_digest) !== manifestDigest(evaluation.value)) diagnostics.push({ file: run.file, code: "semantic/run-evaluation-digest", message: "run evaluation digest does not match evaluator.json" });
    if (!identityMatches) continue;
    const task = taskByIdentity.get(`${asString(evaluation.value.task_id)}@${asString(evaluation.value.task_version)}`);
    if (!task) continue;
    const scoring = asObject(task.value.scoring);
    const evaluatorCheckItems = evaluation.value.checks as unknown[], summaryCheckItems = summary.checks as unknown[];
    const declaredChecks = new Map((scoring.checks as unknown[]).map((item) => { const check = asObject(item); return [asString(check.id), check]; }));
    const evaluatorChecks = new Map(evaluatorCheckItems.map((item) => { const check = asObject(item); return [asString(check.id), check]; }));
    const summaryChecks = new Map(summaryCheckItems.map((item) => { const check = asObject(item); return [asString(check.id), check]; }));
    const evaluatorComplete = evaluatorChecks.size === evaluatorCheckItems.length
      && evaluatorChecks.size === declaredChecks.size
      && [...declaredChecks.keys()].every((id) => evaluatorChecks.has(id));
    let checksMatch = evaluatorComplete && evaluatorChecks.size === summaryChecks.size && summaryChecks.size === summaryCheckItems.length;
    for (const [id, evaluatorCheck] of evaluatorChecks) {
      const summaryCheck = summaryChecks.get(id), declaredCheck = declaredChecks.get(id);
      if (!summaryCheck || !declaredCheck
        || summaryCheck.score !== evaluatorCheck.score
        || summaryCheck.passed !== evaluatorCheck.passed
        || summaryCheck.message !== evaluatorCheck.message
        || summaryCheck.weight !== declaredCheck.weight
        || summaryCheck.required !== declaredCheck.required) checksMatch = false;
    }
    if (!checksMatch) diagnostics.push({ file: run.file, code: "semantic/run-evaluation-checks", message: "run evaluation checks do not match evaluator output and task scoring" });
    if (!evaluatorComplete) continue;
    const weighted = [...declaredChecks.entries()].reduce((totals, [id, declaredCheck]) => {
      const evaluatorCheck = evaluatorChecks.get(id);
      if (!evaluatorCheck) return totals;
      const weight = declaredCheck.weight as number, score = evaluatorCheck.score as number;
      return { score: totals.score + weight * score, weight: totals.weight + weight };
    }, { score: 0, weight: 0 });
    if (weighted.weight === 0) continue;
    const artifactQualityScore = weighted.score / weighted.weight;
    const criteriaPassed = artifactQualityScore >= (scoring.pass_threshold as number)
      && [...declaredChecks.entries()].every(([id, check]) => check.required !== true || evaluatorChecks.get(id)?.passed === true);
    const agentCompletionRequired = scoring.require_agent_completion === true;
    const agentCompleted = terminal.reason === "agent_completed" && terminal.attribution === "agent" && terminal.operational_success === true;
    const endToEndPassed = qualityEligible && criteriaPassed && (!agentCompletionRequired || agentCompleted);
    const derivedMatches = Math.abs((summary.artifact_quality_score as number) - artifactQualityScore) <= 1e-12
      && summary.criteria_passed === criteriaPassed
      && summary.agent_completion_required === agentCompletionRequired
      && summary.end_to_end_passed === endToEndPassed;
    if (!derivedMatches) diagnostics.push({ file: run.file, code: "semantic/run-evaluation-summary", message: "run evaluation summary does not match evaluator output, task scoring, and terminal state" });
  }
  if (diagnostics.length) throw new ValidationError(diagnostics);
}
