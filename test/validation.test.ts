import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readdir, rm, symlink, unlink, writeFile, chmod, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, manifestDigest, sha256, treeDigest } from "../src/digests.js";
import { loadManifestText } from "../src/load.js";
import { kindFromPath, kindFromRepositoryPath, SchemaValidator } from "../src/schema.js";
import { safeRelativePath, validateRepository } from "../src/repository.js";
import { ValidationError } from "../src/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("all seven checked-in examples are discoverable and schema-validated", async () => {
  const expected = ["task", "suite", "experiment", "campaign", "evaluation", "run-request", "run-result"];
  for (const kind of expected) assert.equal(kindFromRepositoryPath(join("spec/examples", `${kind}.example.json`)), kind);
  assert.equal(kindFromRepositoryPath("tasks/demo/1.0.0/task.yaml"), "task");
  assert.equal(kindFromRepositoryPath("suites/smoke/1.0.0.yaml"), "suite");
  assert.equal(kindFromRepositoryPath("experiments/smoke/1.0.0.yaml"), "experiment");
  assert.equal(kindFromRepositoryPath("results/demo/campaign/campaign.json"), "campaign");
  assert.equal(kindFromRepositoryPath("results/demo/campaign/runs/01J00000000000000000000000/request.json"), "run-request");
  assert.equal(kindFromRepositoryPath("results/demo/campaign/runs/01J00000000000000000000000/run.json"), "run-result");
  assert.equal(kindFromRepositoryPath("results/demo/campaign/runs/01J00000000000000000000000/evaluator.json"), "evaluation");
  assert.equal(kindFromPath("run-request.json"), "run-request");
  assert.equal(kindFromPath("run-result.json"), "run-result");
  for (const path of ["tasks/demo/1.0.0/state/suites/foo/1.0.0.json", "suites/demo/campaign.json", "experiments/demo/notes.json", "results/demo/campaign/run-result.json", "results/demo/campaign/reports/campaign.json", "results/demo/campaign/reports/task.json", "results/demo/campaign/reports/suites/foo/1.0.0.json"]) assert.equal(kindFromRepositoryPath(path), undefined);
  await validateRepository(root);
});

test("loaders reject duplicate keys and forbidden YAML tags", () => {
  assert.throws(() => loadManifestText('{"id":"one","id":"two"}', "bad.json"), ValidationError);
  assert.throws(() => loadManifestText("id: one\nid: two\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("id: !custom one\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("id: !<tag:example.test,2026:value> one\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("1: value\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("a: &value {x: one}\nb: *value\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("base: &base {x: one}\nvalue:\n  <<: *base\n", "bad.yaml"), ValidationError);
  assert.deepEqual(loadManifestText('{"value":1}', "mixed.JSON"), { value: 1 });
  assert.deepEqual(loadManifestText('note: "R&D &value"\n', "good.yaml"), { note: "R&D &value" });
  assert.deepEqual(loadManifestText('note: "literal *value"\n', "good.yaml"), { note: "literal *value" });
  assert.deepEqual(loadManifestText('note: "literal !word"\n', "good.yaml"), { note: "literal !word" });
  assert.deepEqual(loadManifestText('note: "literal <<:"\n', "good.yaml"), { note: "literal <<:" });
});

test("strict schemas reject unknown fields and incompatible versions", async () => {
  const validator = await SchemaValidator.create(join(root, "spec/schemas"));
  const valid = loadManifestText(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8"), "task.example.json") as Record<string, unknown>;
  assert.throws(() => validator.validate("task", { ...valid, unexpected: true }, "bad.json"), ValidationError);
  assert.throws(() => validator.validate("task", { ...valid, schema_version: "1.0.0" }, "bad.json"), ValidationError);
  const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); suite.tasks[0].spec_path = "tasks\\example-cli\\1.0.0\\task.yaml";
  assert.throws(() => validator.validate("suite", suite, "bad-suite.json"), ValidationError);
  for (const path of ["C:/tasks/example/task.yaml", "tasks/example/\u0000/task.yaml", "tasks/example/"]) { suite.tasks[0].spec_path = path; assert.throws(() => validator.validate("suite", suite, "bad-suite.json"), ValidationError); }
});

test("repository paths and schemas enforce strict SemVer identifiers", async () => {
  assert.equal(kindFromRepositoryPath("tasks/demo/1.0.0-alpha.1+build.01/task.yaml"), "task");
  assert.equal(kindFromRepositoryPath("suites/demo/1.0.0-0.json"), "suite");
  for (const version of ["1.0.0-alpha..1", "1.0.0-01", "1.0.0+build..1"]) assert.equal(kindFromRepositoryPath(`tasks/demo/${version}/task.yaml`), undefined);

  const validator = await SchemaValidator.create(join(root, "spec/schemas"));
  const task = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8"));
  validator.validate("task", { ...task, version: "1.0.0-0.alpha+build.01" }, "valid-task.json");
  for (const version of ["1.0.0-alpha..1", "1.0.0-01", "1.0.0+build..1"]) assert.throws(() => validator.validate("task", { ...task, version }, "bad-task.json"), ValidationError);
});

test("example discovery ignores symlinks and non-regular manifest-like entries", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "aht-repo-"));
  const external = await mkdtemp(join(tmpdir(), "aht-external-"));
  try {
    await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true });
    await mkdir(join(fixture, "spec/examples"), { recursive: true });
    await writeFile(join(external, "invalid.json"), "{ invalid");
    await symlink(join(external, "invalid.json"), join(fixture, "spec/examples/task.example.json"));
    await mkdir(join(fixture, "spec/examples/suite.example.json"));
    await validateRepository(fixture);
  } finally {
    await Promise.all([rm(fixture, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]);
  }
});

test("top-level discovery roots reject symlinks without loading external manifests", async () => {
  const fixture = await semanticFixture();
  const external = await mkdtemp(join(tmpdir(), "aht-external-"));
  try {
    await validateRepository(fixture.root);
    await mkdir(join(external, "poison"), { recursive: true });
    await writeFile(join(external, "poison", "1.0.0.json"), "{ invalid");
    await symlink(external, join(fixture.root, "suites"), "dir");
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError
      && error.diagnostics.some((item) => item.code === "semantic/discovery-root" && item.file.endsWith("/suites"))
      && !error.diagnostics.some((item) => item.file.endsWith("/suites/poison/1.0.0.json")));

    await unlink(join(fixture.root, "suites"));
    await mkdir(join(external, "poison", "1.0.0"));
    await writeFile(join(external, "poison", "1.0.0", "task.json"), "{ invalid");
    await rm(join(fixture.root, "tasks"), { recursive: true });
    await symlink(external, join(fixture.root, "tasks"), "dir");
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError
      && error.diagnostics.some((item) => item.code === "semantic/discovery-root" && item.file.endsWith("/tasks"))
      && !error.diagnostics.some((item) => item.file.endsWith("/tasks/poison/1.0.0/task.json")));
  } finally {
    await Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]);
  }
});

test("RFC 8785 canonical JSON and manifest digest have stable vectors", () => {
  assert.equal(canonicalJson({ b: [3, { z: 2, a: 1 }], a: "x" }), '{"a":"x","b":[3,{"a":1,"z":2}]}');
  assert.equal(manifestDigest({ a: 1 }), "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
});

test("tree-sha256-v1 ignores enumeration and timestamps but includes modes and symlink targets", async () => {
  const first = await mkdtemp(join(tmpdir(), "aht-tree-")); const second = await mkdtemp(join(tmpdir(), "aht-tree-"));
  for (const rootDir of [first, second]) { await mkdir(join(rootDir, "empty")); await writeFile(join(rootDir, "a.txt"), "same"); await writeFile(join(rootDir, "run"), "same"); await symlink("a.txt", join(rootDir, "link")); }
  assert.equal(await treeDigest(first), await treeDigest(second));
  await utimes(join(second, "a.txt"), new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z")); assert.equal(await treeDigest(first), await treeDigest(second));
  await chmod(join(second, "run"), 0o755); assert.notEqual(await treeDigest(first), await treeDigest(second));
  await chmod(join(second, "run"), 0o644); await (await import("node:fs/promises")).unlink(join(second, "link")); await symlink("run", join(second, "link")); assert.notEqual(await treeDigest(first), await treeDigest(second));
});

test("tree-sha256-v1 includes empty directories, including .git-only directories", async () => {
  const blank = await mkdtemp(join(tmpdir(), "aht-tree-")); const empty = await mkdtemp(join(tmpdir(), "aht-tree-")); const gitOnly = await mkdtemp(join(tmpdir(), "aht-tree-"));
  await mkdir(join(empty, "empty")); await mkdir(join(gitOnly, "empty", ".git"), { recursive: true });
  assert.notEqual(await treeDigest(blank), await treeDigest(empty));
  assert.equal(await treeDigest(empty), await treeDigest(gitOnly));
});

test("tree-sha256-v1 rejects a normalized-path collision when the filesystem permits one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aht-tree-")); const nfc = "é"; const nfd = "e\u0301";
  await writeFile(join(directory, nfc), "first"); await writeFile(join(directory, nfd), "second");
  if ((await readdir(directory)).length === 2) await assert.rejects(treeDigest(directory), /duplicate normalized path/);
  else assert.ok(true, "filesystem normalizes Unicode filenames before they can collide");
});

test("repository paths fail closed for escapes and collisions", () => {
  for (const path of ["../escape", "/absolute", "C:/absolute", "a//b", "a/../b", "a/", "a\\b", "a/\0/b"]) assert.equal(safeRelativePath(path), false);
  assert.equal(safeRelativePath("tasks/example/1.0.0/task.yaml"), true);
});

test("repository semantics remain enabled when the checkout path contains spec/examples", async () => {
  const ancestor = await mkdtemp(join(tmpdir(), "aht-ancestor-")); const fixture = join(ancestor, "spec", "examples", "checkout");
  try {
    await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true }); await mkdir(join(fixture, "spec/examples"), { recursive: true });
    const { taskFile, task } = await addValidTask(fixture, "demo"); (task.prompt as Record<string, unknown>).digest = `sha256:${"0".repeat(64)}`; await writeFile(taskFile, JSON.stringify(task));
    await assert.rejects(validateRepository(fixture), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/task-artifact" && item.message.includes("prompt digest mismatch")));
  } finally { await rm(ancestor, { recursive: true, force: true }); }
});

async function addValidTask(fixture: string, taskId: string): Promise<{ taskFile: string; task: Record<string, unknown> }> {
  const taskRoot = `tasks/${taskId}/1.0.0`; const taskFile = join(fixture, taskRoot, "task.json"); await mkdir(join(fixture, taskRoot, "state"), { recursive: true }); await mkdir(join(fixture, taskRoot, "evaluator"), { recursive: true });
  await writeFile(join(fixture, taskRoot, "prompt.md"), "prompt bytes\n"); await writeFile(join(fixture, taskRoot, "state/file.txt"), "state"); await mkdir(join(fixture, taskRoot, "state/suites")); await writeFile(join(fixture, taskRoot, "state/task.json"), "not a manifest"); await writeFile(join(fixture, taskRoot, "state/suites/my-suite.yaml"), "not: a framework suite"); await writeFile(join(fixture, taskRoot, "evaluator/evaluate.py"), "evaluator"); await writeFile(join(fixture, taskRoot, "evaluator/evaluator.json"), "not an evaluation artifact");
  const source = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8")) as Record<string, any>;
  source.id = taskId; source.status = "candidate"; source.prompt.path = `${taskRoot}/prompt.md`; source.prompt.digest = `sha256:${sha256("prompt bytes\n")}`; source.problem_state.source.path = `${taskRoot}/state`; source.problem_state.expected_tree_digest = await treeDigest(join(fixture, taskRoot, "state")); source.evaluator.path = `${taskRoot}/evaluator`; source.evaluator.digest = await treeDigest(join(fixture, taskRoot, "evaluator"));
  await writeFile(taskFile, JSON.stringify(source)); return { taskFile, task: source };
}

async function semanticFixture(taskId = "demo"): Promise<{ root: string; taskFile: string; task: Record<string, unknown> }> {
  const fixture = await mkdtemp(join(tmpdir(), "aht-repo-"));
  await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true }); await mkdir(join(fixture, "spec/examples"), { recursive: true });
  return { root: fixture, ...await addValidTask(fixture, taskId) };
}

function setCalibration(task: Record<string, any>, status: "draft" | "released" | "retired", evidenceDigest: string): void {
  task.status = status;
  task.calibration.evidence_path = "tasks/demo/1.0.0/calibration.json";
  task.calibration.evidence_digest = evidenceDigest;
}

async function addValidSuite(fixture: { root: string; task: Record<string, unknown> }): Promise<Record<string, any>> {
  await mkdir(join(fixture.root, "suites/demo-breadth"), { recursive: true });
  const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8"));
  suite.id = "demo-breadth";
  suite.status = "draft";
  suite.tasks[0].id = "demo";
  suite.tasks[0].spec_path = "tasks/demo/1.0.0/task.json";
  suite.tasks[0].spec_digest = manifestDigest(fixture.task);
  await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite));
  return suite;
}

async function addValidExperiment(fixture: { root: string; task: Record<string, unknown> }): Promise<{ experiment: Record<string, any>; file: string }> {
  const suite = await addValidSuite(fixture);
  await mkdir(join(fixture.root, "experiments/demo"), { recursive: true });
  const experiment = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/experiment.example.json"), "utf8"));
  experiment.id = "demo";
  experiment.suite.id = "demo-breadth";
  experiment.suite.spec_path = "suites/demo-breadth/1.0.0.json";
  experiment.suite.spec_digest = manifestDigest(suite);
  const file = join(fixture.root, "experiments/demo/1.0.0.json");
  await writeFile(file, JSON.stringify(experiment));
  return { experiment, file };
}

function setRunReferences(manifest: Record<string, any>, experiment: Record<string, any>, task: Record<string, any>): void {
  manifest.experiment = { id: experiment.id, version: experiment.version, spec_path: `experiments/${experiment.id}/${experiment.version}.json`, spec_digest: manifestDigest(experiment) };
  manifest.suite = { ...experiment.suite };
  manifest.task = { id: task.id, version: task.version, spec_path: `tasks/${task.id}/${task.version}/task.json`, spec_digest: manifestDigest(task), prompt_digest: task.prompt.digest, initial_tree_digest: task.problem_state.expected_tree_digest, evaluator_digest: task.evaluator.digest };
}

function setRunConfiguration(request: Record<string, any>, result: Record<string, any>, experiment: Record<string, any>): void {
  const configuration = structuredClone(experiment.configurations[0]); request.configuration = configuration; result.configuration_id = configuration.id;
  result.resolved_configuration.harness = structuredClone(configuration.harness); result.resolved_configuration.effort = structuredClone(configuration.effort); result.resolved_configuration.limits = structuredClone(configuration.limits);
  result.resolved_configuration.model.provider = configuration.model.provider; result.resolved_configuration.model.requested_id = configuration.model.requested_id;
}

async function addAlternateSuite(fixture: { root: string; request: Record<string, any> }): Promise<Record<string, any>> {
  const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); suite.id = "alternate"; suite.status = "draft";
  suite.tasks[0] = { id: fixture.request.task.id, version: fixture.request.task.version, spec_path: fixture.request.task.spec_path, spec_digest: fixture.request.task.spec_digest, weight: 1, anchor: true };
  await mkdir(join(fixture.root, "suites/alternate"), { recursive: true }); await writeFile(join(fixture.root, "suites/alternate/1.0.0.json"), JSON.stringify(suite)); return suite;
}

async function campaignRunFixture(taskNetwork?: Record<string, unknown>, expectedSnapshotId?: string): Promise<{ root: string; experiment: Record<string, any>; experimentFile: string; campaign: Record<string, any>; campaignFile: string; request: Record<string, any>; requestFile: string; result: Record<string, any>; resultFile: string }> {
  const fixture = await semanticFixture(); const task = fixture.task as Record<string, any>;
  if (taskNetwork) { task.environment.network = structuredClone(taskNetwork); await writeFile(fixture.taskFile, JSON.stringify(task)); }
  const { experiment, file: experimentFile } = await addValidExperiment(fixture);
  if (expectedSnapshotId) { experiment.configurations[0].model.expected_snapshot_id = expectedSnapshotId; await writeFile(experimentFile, JSON.stringify(experiment)); }
  const campaign = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/campaign.example.json"), "utf8"));
  const request = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/run-request.example.json"), "utf8"));
  const result = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/run-result.example.json"), "utf8"));
  result.artifacts = [];
  const experimentReference = { id: experiment.id, version: experiment.version, spec_path: `experiments/${experiment.id}/${experiment.version}.json`, spec_digest: manifestDigest(experiment) };
  campaign.experiment = experimentReference; campaign.suite = { ...experiment.suite }; setRunReferences(request, experiment, task); setRunReferences(result, experiment, task); setRunConfiguration(request, result, experiment); request.network = structuredClone(task.environment.network);
  request.workspace.prompt_path = task.prompt.path; request.workspace.prompt_digest = task.prompt.digest; request.workspace.initial_tree_digest = task.problem_state.expected_tree_digest;
  request.execution.environment_digest = task.environment.runtime.image_digest; request.execution.image_digest = task.environment.runtime.image_digest; result.provenance.execution = structuredClone(request.execution);
  result.evaluation = { status: "not-run", reason: "campaign reference fixture", eligible_for_quality_aggregate: false };
  result.provenance.request_digest = manifestDigest(request);
  const campaignDirectory = join(fixture.root, "results", campaign.experiment.id, campaign.campaign_id); const runDirectory = join(campaignDirectory, "runs", result.run_id); await mkdir(runDirectory, { recursive: true });
  const campaignFile = join(campaignDirectory, "campaign.json"), requestFile = join(runDirectory, "request.json"), resultFile = join(runDirectory, "run.json");
  campaign.planned_run_count = 1;
  campaign.runs = [{ run_id: result.run_id, path: `runs/${result.run_id}/run.json`, digest: manifestDigest(result) }];
  campaign.summary = { recorded_runs: 1, operational_successes: 1, quality_eligible_runs: 0, end_to_end_passes: 0, invalid_runs: 1 };
  await writeFile(campaignFile, JSON.stringify(campaign)); await writeFile(requestFile, JSON.stringify(request)); await writeFile(resultFile, JSON.stringify(result));
  return { root: fixture.root, experiment, experimentFile, campaign, campaignFile, request, requestFile, result, resultFile };
}

async function runEvaluationFixture(requireAgentCompletion = true): Promise<{ root: string; request: Record<string, any>; requestFile: string; result: Record<string, any>; resultFile: string; evaluation: Record<string, any>; evaluationFile: string }> {
  const fixture = await semanticFixture(); const task = fixture.task as Record<string, any>;
  if (!requireAgentCompletion) { task.scoring.require_agent_completion = false; await writeFile(fixture.taskFile, JSON.stringify(task)); }
  const { experiment } = await addValidExperiment(fixture);
  const campaign = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/campaign.example.json"), "utf8"));
  const request = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/run-request.example.json"), "utf8"));
  const result = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/run-result.example.json"), "utf8"));
  result.artifacts = [];
  const evaluation = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/evaluation.example.json"), "utf8"));
  setRunReferences(request, experiment, task); setRunReferences(result, experiment, task); setRunConfiguration(request, result, experiment); request.workspace.prompt_path = task.prompt.path; request.workspace.prompt_digest = task.prompt.digest; request.workspace.initial_tree_digest = task.problem_state.expected_tree_digest;
  request.execution.environment_digest = task.environment.runtime.image_digest; request.execution.image_digest = task.environment.runtime.image_digest; result.provenance.execution = structuredClone(request.execution);
  evaluation.task_id = "demo"; result.evaluation.result_artifact_digest = manifestDigest(evaluation);
  result.provenance.request_digest = manifestDigest(request);
  const runDirectory = join(fixture.root, "results", result.experiment.id, result.campaign_id, "runs", result.run_id); await mkdir(runDirectory, { recursive: true });
  campaign.experiment = structuredClone(request.experiment); campaign.suite = structuredClone(request.suite); campaign.planned_run_count = 1; campaign.runs = []; campaign.summary = { recorded_runs: 0, operational_successes: 0, quality_eligible_runs: 0, end_to_end_passes: 0, invalid_runs: 0 };
  const campaignFile = join(fixture.root, "results", result.experiment.id, result.campaign_id, "campaign.json");
  const requestFile = join(runDirectory, "request.json"), resultFile = join(runDirectory, "run.json"), evaluationFile = join(runDirectory, "evaluator.json"); await writeFile(requestFile, JSON.stringify(request)); await writeFile(resultFile, JSON.stringify(result)); await writeFile(evaluationFile, JSON.stringify(evaluation));
  await writeFile(campaignFile, JSON.stringify(campaign));
  return { root: fixture.root, request, requestFile, result, resultFile, evaluation, evaluationFile };
}

async function passingRunEvaluationFixture(requireAgentCompletion = true): Promise<Awaited<ReturnType<typeof runEvaluationFixture>>> {
  const fixture = await runEvaluationFixture(requireAgentCompletion);
  fixture.evaluation.checks[1].score = 1; fixture.evaluation.checks[1].passed = true;
  fixture.result.evaluation.result_artifact_digest = manifestDigest(fixture.evaluation); fixture.result.evaluation.checks[1].score = 1; fixture.result.evaluation.checks[1].passed = true;
  fixture.result.evaluation.artifact_quality_score = 1; fixture.result.evaluation.criteria_passed = true; fixture.result.evaluation.agent_completion_required = requireAgentCompletion; fixture.result.evaluation.end_to_end_passed = true;
  await writeFile(fixture.evaluationFile, JSON.stringify(fixture.evaluation)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  return fixture;
}

async function setTaskLifecycle(fixture: { root: string; taskFile: string; task: Record<string, any> }, status: "draft" | "candidate" | "released" | "retired"): Promise<void> {
  fixture.task.status = status;
  if (status === "released" || status === "retired") {
    const evidence = `{"status":"${status}"}\n`;
    setCalibration(fixture.task, status, `sha256:${sha256(evidence)}`);
    await writeFile(join(fixture.root, "tasks/demo/1.0.0/calibration.json"), evidence);
  }
  await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
}

test("repository semantics reject prompt digest, orphan artifacts, unknown evaluator tasks, and duplicate identities", async () => {
  const fixture = await semanticFixture();
  fixture.task.prompt = { ...(fixture.task.prompt as Record<string, unknown>), digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }; await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await mkdir(join(fixture.root, "tasks/orphan/1.0.0/state"), { recursive: true });
  const resultDirectory = join(fixture.root, "results/demo/campaign/runs/run"); await mkdir(resultDirectory, { recursive: true });
  const evaluation = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/evaluation.example.json"), "utf8")); evaluation.task_id = "missing"; await writeFile(join(resultDirectory, "evaluator.json"), JSON.stringify(evaluation));
  await mkdir(join(fixture.root, "suites/one-suite"), { recursive: true }); await mkdir(join(fixture.root, "suites/two-suite"), { recursive: true }); const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); await writeFile(join(fixture.root, "suites/one-suite/1.0.0.json"), JSON.stringify(suite)); await writeFile(join(fixture.root, "suites/two-suite/1.0.0.json"), JSON.stringify(suite));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && ["prompt digest mismatch", "state/evaluator artifact has no co-located task spec", "missing task missing@1.0.0", "duplicate suite identity"].every((fragment) => error.message.includes(fragment)));
});

test("semantic suite and evaluator invariants reject released candidates, bad digests, and check-ID mismatch", async () => {
  const fixture = await semanticFixture(); await mkdir(join(fixture.root, "suites/demo-suite"), { recursive: true }); const resultDirectory = join(fixture.root, "results/demo/campaign/runs/run"); await mkdir(resultDirectory, { recursive: true });
  const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); suite.tasks[0].id = "demo"; suite.tasks[0].spec_digest = manifestDigest(fixture.task); await writeFile(join(fixture.root, "suites/demo-suite/1.0.0.json"), JSON.stringify(suite));
  const result = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/evaluation.example.json"), "utf8")); result.task_id = "demo"; result.checks = [result.checks[0], result.checks[0], result.checks[1]]; await writeFile(join(resultDirectory, "evaluator.json"), JSON.stringify(result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("task spec_path does not resolve") && error.message.includes("released suite references non-released task") && error.message.includes("evaluator check IDs"));
  suite.status = "draft"; suite.tasks[0].spec_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(join(fixture.root, "suites/demo-suite/1.0.0.json"), JSON.stringify(suite));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("task digest mismatch"));
});

test("run-result metric telemetry permits honest partial/unavailable data and rejects fabricated unavailable totals", async () => {
  const validator = await SchemaValidator.create(join(root, "spec/schemas")); const result = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/run-result.example.json"), "utf8"));
  result.metrics.tokens = { status: "partial", source: "native", partial_reason: "provider only reported output", output: 3 }; validator.validate("run-result", result, "partial.json");
  result.metrics.tokens = { status: "unavailable", source: "native", unavailable_reason: "not reported", total: 3 }; assert.throws(() => validator.validate("run-result", result, "fabricated.json"), ValidationError);
});

test("candidate git sources remain valid without pretending to materialize them", async () => {
  const fixture = await semanticFixture();
  (fixture.task.problem_state as Record<string, unknown>).source = { kind: "git", repository: "https://example.test/demo.git", revision: "a".repeat(40) };
  await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await validateRepository(fixture.root);
});

test("draft URI-only archive sources remain valid while non-draft lifecycles require verifiable bytes", async () => {
  const archive = { kind: "archive", uri: "https://example.test/state.tar", archive_digest: `sha256:${"0".repeat(64)}` };
  const draft = await semanticFixture(); draft.task.status = "draft"; (draft.task.problem_state as Record<string, unknown>).source = archive; await writeFile(draft.taskFile, JSON.stringify(draft.task)); await validateRepository(draft.root);
  for (const status of ["candidate", "released", "retired"]) {
    const fixture = await semanticFixture(); fixture.task.status = status; (fixture.task.problem_state as Record<string, unknown>).source = archive; await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/task-artifact" && item.message.includes("URI-only archive sources")));
  }
});

test("released and retired task calibration evidence is verified from its bytes", async () => {
  const evidence = '{"reference":"passes"}\n';
  for (const status of ["released", "retired"] as const) {
    const fixture = await semanticFixture();
    setCalibration(fixture.task, status, `sha256:${sha256(evidence)}`);
    await writeFile(join(fixture.root, "tasks/demo/1.0.0/calibration.json"), evidence);
    await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
    await validateRepository(fixture.root);
  }
});

test("released task calibration evidence must exist", async () => {
  const fixture = await semanticFixture();
  setCalibration(fixture.task, "released", `sha256:${sha256("missing")}`);
  await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/task-artifact" && item.message.includes("calibration.json")));
});

test("retired task calibration evidence must match its declared digest", async () => {
  const fixture = await semanticFixture();
  setCalibration(fixture.task, "retired", `sha256:${sha256("declared bytes")}`);
  await writeFile(join(fixture.root, "tasks/demo/1.0.0/calibration.json"), "actual bytes");
  await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("calibration evidence digest mismatch"));
});

test("draft task calibration metadata does not require materialized evidence", async () => {
  const fixture = await semanticFixture();
  setCalibration(fixture.task, "draft", `sha256:${sha256("not materialized")}`);
  await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await validateRepository(fixture.root);
});

test("task artifact trees are digest inputs, not framework manifest discovery roots", async () => {
  const fixture = await semanticFixture(); await validateRepository(fixture.root);
});

test("draft task manifest path must match its declared ID and version", async () => {
  const fixture = await semanticFixture("foo"); fixture.task.id = "bar"; fixture.task.status = "draft"; await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/task-identity") && !error.diagnostics.some((item) => item.code === "semantic/task-artifact"));
});

test("draft suites may omit task spec digests", async () => {
  const fixture = await semanticFixture(); await mkdir(join(fixture.root, "suites/demo"), { recursive: true }); const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); suite.id = "demo"; suite.status = "draft"; suite.tasks[0].id = "demo"; suite.tasks[0].spec_path = "tasks/demo/1.0.0/task.json"; delete suite.tasks[0].spec_digest; await writeFile(join(fixture.root, "suites/demo/1.0.0.json"), JSON.stringify(suite)); await validateRepository(fixture.root);
});

test("suite task references are unique by task ID and version", async () => {
  const fixture = await semanticFixture();
  const suite = await addValidSuite(fixture);
  await validateRepository(fixture.root);
  suite.tasks.push({ ...suite.tasks[0] });
  await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("duplicate suite task reference demo@1.0.0"));
});

test("suite manifest path must match its declared ID and version", async () => {
  const fixture = await semanticFixture(); const suite = await addValidSuite(fixture); const file = join(fixture.root, "suites/demo-breadth/1.0.0.json");
  suite.id = "other-suite"; await writeFile(file, JSON.stringify(suite)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/suite-identity"));
  suite.id = "demo-breadth"; suite.version = "2.0.0"; await writeFile(file, JSON.stringify(suite)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/suite-identity"));
});

test("released and retired suites accept only their immutable task lifecycles", async () => {
  for (const taskStatus of ["released", "retired"] as const) {
    const fixture = await semanticFixture(); await setTaskLifecycle(fixture, taskStatus); const suite = await addValidSuite(fixture); suite.status = "retired"; await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite)); await validateRepository(fixture.root);
  }
  const fixture = await semanticFixture(); await setTaskLifecycle(fixture, "released"); const suite = await addValidSuite(fixture); suite.status = "released"; await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite)); await validateRepository(fixture.root);
  await setTaskLifecycle(fixture, "retired"); suite.tasks[0].spec_digest = manifestDigest(fixture.task); await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("released suite references non-released task demo@1.0.0"));
});

test("retired suites reject mutable draft and candidate tasks", async () => {
  for (const taskStatus of ["draft", "candidate"] as const) {
    const fixture = await semanticFixture(); await setTaskLifecycle(fixture, taskStatus); const suite = await addValidSuite(fixture); suite.status = "retired"; await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("retired suite references mutable task demo@1.0.0"));
  }
});

test("task scoring check IDs are unique without requiring an evaluation artifact", async () => {
  const fixture = await semanticFixture(); const checks = (fixture.task.scoring as Record<string, any>).checks; checks.push(checks[0]); await writeFile(fixture.taskFile, JSON.stringify(fixture.task)); await assert.rejects(validateRepository(fixture.root), /task scoring check IDs must be unique/);
});

test("experiment suite references require the loaded suite path and digest", async () => {
  const fixture = await semanticFixture(); await mkdir(join(fixture.root, "suites/demo-breadth"), { recursive: true }); await mkdir(join(fixture.root, "experiments/demo"), { recursive: true });
  const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); suite.status = "draft"; suite.tasks[0].id = "demo"; suite.tasks[0].spec_path = "tasks/demo/1.0.0/task.json"; suite.tasks[0].spec_digest = manifestDigest(fixture.task); await writeFile(join(fixture.root, "suites/demo-breadth/1.0.0.json"), JSON.stringify(suite));
  const experiment = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/experiment.example.json"), "utf8")); experiment.suite.spec_path = "suites/wrong/1.0.0.json"; experiment.suite.spec_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(join(fixture.root, "experiments/demo/1.0.0.json"), JSON.stringify(experiment));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("suite spec_path does not resolve") && error.message.includes("suite digest mismatch"));
});

test("experiment comparisons accept declared unique configuration IDs", async () => {
  const fixture = await semanticFixture();
  await addValidExperiment(fixture);
  await validateRepository(fixture.root);
});

test("experiment manifest path must match its declared ID and version", async () => {
  const fixture = await semanticFixture(); const { experiment, file } = await addValidExperiment(fixture);
  experiment.id = "other-experiment"; await writeFile(file, JSON.stringify(experiment)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/experiment-identity"));
  experiment.id = "demo"; experiment.version = "2.0.0"; await writeFile(file, JSON.stringify(experiment)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/experiment-identity"));
});

test("experiment reporting rejects ambiguous or undeclared configuration IDs", async () => {
  const fixture = await semanticFixture();
  const { experiment, file } = await addValidExperiment(fixture);

  experiment.configurations[1].id = experiment.configurations[0].id;
  await writeFile(file, JSON.stringify(experiment));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("duplicate experiment configuration ID codex-medium"));

  experiment.configurations[1].id = "codex-high";
  experiment.reporting.comparisons[0].baseline_configuration_id = "missing-baseline";
  await writeFile(file, JSON.stringify(experiment));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("undeclared baseline configuration missing-baseline"));

  experiment.reporting.comparisons[0].baseline_configuration_id = "codex-medium";
  experiment.reporting.comparisons[0].candidate_configuration_ids = ["missing-candidate"];
  await writeFile(file, JSON.stringify(experiment));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("undeclared candidate configuration missing-candidate"));

  experiment.reporting.comparisons[0].candidate_configuration_ids = ["codex-high", "codex-high"];
  await writeFile(file, JSON.stringify(experiment));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "schema/uniqueItems"));
});

test("experiment task selection accepts suite task IDs for include and exclude", async () => {
  const fixture = await semanticFixture(); const { experiment, file } = await addValidExperiment(fixture);
  experiment.task_selection = { include: ["demo"] }; await writeFile(file, JSON.stringify(experiment)); await validateRepository(fixture.root);
  experiment.task_selection = { exclude: ["demo"] }; await writeFile(file, JSON.stringify(experiment)); await validateRepository(fixture.root);
});

test("experiment task selection rejects include and exclude IDs absent from its suite", async () => {
  const fixture = await semanticFixture(); const { experiment, file } = await addValidExperiment(fixture);
  for (const mode of ["include", "exclude"] as const) {
    experiment.task_selection = { [mode]: ["missing-task"] }; await writeFile(file, JSON.stringify(experiment));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("task_selection references task ID not present in suite: missing-task"));
  }
});

test("canonical campaign and run result artifacts are discovered and schema-validated", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "aht-repo-")); await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true }); await mkdir(join(fixture, "spec/examples"), { recursive: true });
  const campaignDirectory = join(fixture, "results/demo/campaign"); const runDirectory = join(campaignDirectory, "runs/01J00000000000000000000000"); await mkdir(runDirectory, { recursive: true });
  for (const file of [join(campaignDirectory, "campaign.json"), join(runDirectory, "request.json"), join(runDirectory, "run.json"), join(runDirectory, "evaluator.json")]) await writeFile(file, '{"schema_version":"0.2.0"}');
  await assert.rejects(validateRepository(fixture), (error: unknown) => error instanceof ValidationError && ["campaign.json", "request.json", "run.json", "evaluator.json"].every((name) => error.diagnostics.some((item) => item.file.endsWith(name) && item.code === "schema/required")));
});

test("campaign and run manifest paths match their declared identities", async () => {
  const fixture = await campaignRunFixture(); const { campaign, campaignFile, request, requestFile, result, resultFile } = fixture; await validateRepository(fixture.root);
  campaign.experiment.id = "other-experiment"; await writeFile(campaignFile, JSON.stringify(campaign)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-identity"));
  campaign.experiment.id = request.experiment.id; await writeFile(campaignFile, JSON.stringify(campaign)); request.campaign_id = "other-campaign"; await writeFile(requestFile, JSON.stringify(request)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-request-identity"));
  request.campaign_id = result.campaign_id; await writeFile(requestFile, JSON.stringify(request)); result.run_id = "01J00000000000000000000099"; await writeFile(resultFile, JSON.stringify(result)); await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-result-identity"));
});

test("campaign run references resolve to canonical run results", async () => {
  const fixture = await campaignRunFixture(); await validateRepository(fixture.root);
});

test("campaign experiment and suite references resolve exact manifests", async () => {
  const fixture = await campaignRunFixture();
  fixture.campaign.experiment.spec_path = "experiments/demo/missing.json"; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/experiment-path"));
  fixture.campaign.experiment.spec_path = fixture.request.experiment.spec_path; fixture.campaign.experiment.spec_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/experiment-digest"));
  fixture.campaign.experiment.spec_digest = fixture.request.experiment.spec_digest; fixture.campaign.suite.id = "missing-suite"; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/suite-reference"));
});

test("run request and result references resolve exact specs and task fingerprints", async () => {
  const fixture = await campaignRunFixture();
  fixture.request.task.spec_path = "tasks/demo/1.0.0/missing.json"; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/task-path"));
  fixture.request.task.spec_path = fixture.result.task.spec_path; fixture.result.suite.spec_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/suite-digest"));
  fixture.result.suite.spec_digest = fixture.request.suite.spec_digest; fixture.result.task.spec_path = "tasks/demo/1.0.0/missing.json"; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.file.endsWith("/run.json") && item.code === "semantic/task-path"));
  fixture.result.task.spec_path = fixture.request.task.spec_path; fixture.result.task.spec_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.file.endsWith("/run.json") && item.code === "semantic/task-digest"));
  fixture.result.task.spec_digest = fixture.request.task.spec_digest; fixture.result.task.prompt_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.file.endsWith("/run.json") && item.code === "semantic/task-fingerprint"));
  fixture.result.task.prompt_digest = fixture.request.task.prompt_digest; fixture.request.experiment.id = "missing-experiment"; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/experiment-reference"));
});

test("campaign and run suites match their resolved experiment", async () => {
  const fixture = await campaignRunFixture(); const alternate = await addAlternateSuite(fixture);
  const reference = { id: alternate.id, version: alternate.version, spec_path: "suites/alternate/1.0.0.json", spec_digest: manifestDigest(alternate) };
  fixture.campaign.suite = reference; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.file.endsWith("/campaign.json") && item.code === "semantic/experiment-suite"));
  fixture.campaign.suite = { ...fixture.experiment.suite }; fixture.request.suite = reference; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign)); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.file.endsWith("/request.json") && item.code === "semantic/experiment-suite"));
  fixture.request.suite = { ...fixture.experiment.suite }; fixture.result.suite = reference; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.file.endsWith("/run.json") && item.code === "semantic/experiment-suite"));
});

test("run tasks belong to their suite and satisfy experiment selection", async () => {
  const fixture = await campaignRunFixture(); const other = (await addValidTask(fixture.root, "other")).task as Record<string, any>;
  setRunReferences(fixture.request, fixture.experiment, other); setRunReferences(fixture.result, fixture.experiment, other); fixture.request.workspace.prompt_path = other.prompt.path; fixture.request.workspace.prompt_digest = other.prompt.digest; fixture.request.workspace.initial_tree_digest = other.problem_state.expected_tree_digest; fixture.result.provenance.request_digest = manifestDigest(fixture.request); fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.filter((item) => item.code === "semantic/run-task-suite").length === 2);
  const selected = await campaignRunFixture(); selected.experiment.task_selection = { exclude: [selected.request.task.id] }; await writeFile(selected.experimentFile, JSON.stringify(selected.experiment));
  const experimentDigest = manifestDigest(selected.experiment); for (const manifest of [selected.campaign, selected.request, selected.result]) manifest.experiment.spec_digest = experimentDigest;
  selected.result.provenance.request_digest = manifestDigest(selected.request); selected.campaign.runs[0].digest = manifestDigest(selected.result); await writeFile(selected.campaignFile, JSON.stringify(selected.campaign)); await writeFile(selected.requestFile, JSON.stringify(selected.request)); await writeFile(selected.resultFile, JSON.stringify(selected.result));
  await assert.rejects(validateRepository(selected.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.filter((item) => item.code === "semantic/run-task-selection").length === 2);
});

test("run request configurations exactly match an experiment declaration", async () => {
  const undeclared = await campaignRunFixture(); undeclared.request.configuration.id = "missing-configuration"; undeclared.result.configuration_id = "missing-configuration"; undeclared.result.provenance.request_digest = manifestDigest(undeclared.request); undeclared.campaign.runs[0].digest = manifestDigest(undeclared.result); await writeFile(undeclared.requestFile, JSON.stringify(undeclared.request)); await writeFile(undeclared.resultFile, JSON.stringify(undeclared.result)); await writeFile(undeclared.campaignFile, JSON.stringify(undeclared.campaign));
  await assert.rejects(validateRepository(undeclared.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-configuration-reference"));
  const drifted = await campaignRunFixture(); drifted.request.configuration.harness.runtime_version = "9.9.9"; drifted.result.resolved_configuration.harness.runtime_version = "9.9.9"; drifted.result.provenance.request_digest = manifestDigest(drifted.request); drifted.campaign.runs[0].digest = manifestDigest(drifted.result); await writeFile(drifted.requestFile, JSON.stringify(drifted.request)); await writeFile(drifted.resultFile, JSON.stringify(drifted.result)); await writeFile(drifted.campaignFile, JSON.stringify(drifted.campaign));
  await assert.rejects(validateRepository(drifted.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-configuration-reference"));
});

test("run repetitions stay within the resolved experiment plan", async () => {
  const fixture = await campaignRunFixture();
  fixture.request.repetition = fixture.experiment.repetitions + 1; fixture.result.repetition = fixture.request.repetition; fixture.result.provenance.request_digest = manifestDigest(fixture.request); fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.filter((item) => item.code === "semantic/run-repetition").length === 2);
});

test("Codex invocation full_access matches its sandbox-bypass argv", async () => {
  const bypassed = await campaignRunFixture(); bypassed.request.invocation.argv.push("--dangerously-bypass-approvals-and-sandbox"); bypassed.result.provenance.request_digest = manifestDigest(bypassed.request); bypassed.campaign.runs[0].digest = manifestDigest(bypassed.result); await writeFile(bypassed.requestFile, JSON.stringify(bypassed.request)); await writeFile(bypassed.resultFile, JSON.stringify(bypassed.result)); await writeFile(bypassed.campaignFile, JSON.stringify(bypassed.campaign));
  await assert.rejects(validateRepository(bypassed.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/invocation-full-access"));
  const normalized = await campaignRunFixture(); normalized.request.invocation.full_access = true; normalized.request.execution.isolation = "outer-sandbox"; normalized.result.provenance.execution.isolation = "outer-sandbox"; normalized.result.provenance.request_digest = manifestDigest(normalized.request); normalized.campaign.runs[0].digest = manifestDigest(normalized.result); await writeFile(normalized.requestFile, JSON.stringify(normalized.request)); await writeFile(normalized.resultFile, JSON.stringify(normalized.result)); await writeFile(normalized.campaignFile, JSON.stringify(normalized.campaign));
  await assert.rejects(validateRepository(normalized.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/invocation-full-access"));
});

test("run invocation runtime fingerprints match campaign preflight", async () => {
  const fixture = await campaignRunFixture();
  for (const field of ["resolved_runtime_version", "runtime_digest", "executable_digest"]) {
    const original = fixture.request.invocation[field]; fixture.request.invocation[field] = field === "resolved_runtime_version" ? "9.9.9" : "sha256:0000000000000000000000000000000000000000000000000000000000000000"; fixture.result.provenance.request_digest = manifestDigest(fixture.request); fixture.campaign.runs[0].digest = manifestDigest(fixture.result); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-preflight"));
    fixture.request.invocation[field] = original;
  }
});

test("run configuration runtime versions bind experiment, invocation, and campaign preflight", async () => {
  const fixture = await campaignRunFixture();
  await validateRepository(fixture.root);
  fixture.request.invocation.resolved_runtime_version = "9.9.9";
  fixture.campaign.preflight.harness_runtimes[0].resolved_runtime_version = "9.9.9";
  fixture.result.provenance.request_digest = manifestDigest(fixture.request);
  fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.requestFile, JSON.stringify(fixture.request));
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError
    && error.diagnostics.some((item) => item.code === "semantic/run-configuration-runtime"));
});

test("run requests only use preflight from campaigns with matching experiment and suite pins", async () => {
  const matching = await campaignRunFixture(); await validateRepository(matching.root);
  for (const field of ["experiment", "suite"]) {
    const fixture = await campaignRunFixture(); fixture.request[field].spec_digest = `sha256:${"0".repeat(64)}`; await writeFile(fixture.requestFile, JSON.stringify(fixture.request));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-preflight" && item.message.includes("experiment and suite must match")));
  }
});

test("run requests require their owning campaign preflight", async () => {
  const fixture = await campaignRunFixture();
  await unlink(fixture.campaignFile);
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-preflight" && item.message.includes(`requires campaign ${fixture.request.campaign_id}`)));
});

test("run request workspace fingerprints resolve against its task spec", async () => {
  const fixture = await campaignRunFixture(); fixture.request.workspace.prompt_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/workspace-fingerprint"));
});

test("run request network policy exactly preserves its task spec", async () => {
  const cases = [
    { task: { mode: "disabled" }, broadened: { mode: "enabled" } },
    { task: { mode: "restricted", allow_domains: ["api.example.test"], allow_methods: ["GET"] }, broadened: { mode: "restricted", allow_domains: ["api.example.test", "other.example.test"], allow_methods: ["GET"] } }
  ];
  for (const network of cases) {
    const fixture = await campaignRunFixture(network.task); await validateRepository(fixture.root);
    fixture.request.network = network.broadened; fixture.result.provenance.request_digest = manifestDigest(fixture.request); fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
    await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-network-policy"));
  }
});

test("run execution accepts the TaskSpec OCI image digest", async () => {
  const fixture = await campaignRunFixture(); await validateRepository(fixture.root);
  assert.equal(fixture.request.execution.environment_digest, fixture.request.execution.image_digest);
});

test("run execution rejects OCI image digest mismatches blessed by request and result", async () => {
  for (const field of ["environment_digest", "image_digest"]) {
    const fixture = await campaignRunFixture(); fixture.request.execution[field] = `sha256:${"0".repeat(64)}`; fixture.result.provenance.execution[field] = fixture.request.execution[field]; fixture.result.provenance.request_digest = manifestDigest(fixture.request); fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
    await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-environment"));
  }
});

test("run results require their canonical request digest and comparable identity", async () => {
  const fixture = await campaignRunFixture(); fixture.result.provenance.request_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-request-digest"));
  fixture.request.configuration.id = "codex-high"; fixture.result.provenance.request_digest = manifestDigest(fixture.request); await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-request-identity"));
});

test("run results preserve resolved configuration and execution provenance", async () => {
  const fixture = await campaignRunFixture();
  for (const [mutate, restore] of [
    [() => { fixture.result.resolved_configuration.harness.runtime_version = "9.9.9"; }, () => { fixture.result.resolved_configuration.harness.runtime_version = fixture.request.configuration.harness.runtime_version; }],
    [() => { fixture.result.resolved_configuration.effort.native_value = "different"; }, () => { fixture.result.resolved_configuration.effort.native_value = fixture.request.configuration.effort.native_value; }],
    [() => { fixture.result.resolved_configuration.limits.wall_time_seconds.value += 1; }, () => { fixture.result.resolved_configuration.limits.wall_time_seconds.value = fixture.request.configuration.limits.wall_time_seconds.value; }],
    [() => { fixture.result.resolved_configuration.model.requested_id = "different-model"; }, () => { fixture.result.resolved_configuration.model.requested_id = fixture.request.configuration.model.requested_id; }]
  ] as Array<[() => void, () => void]>) {
    mutate(); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-configuration"));
    restore();
  }
  fixture.result.provenance.execution.environment_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-execution"));
});

test("pinned model snapshots reject unavailable resolution", async () => {
  const fixture = await campaignRunFixture(undefined, "gpt-5.6-sol-2026-07-14");
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-configuration"));
});

test("pinned model snapshots reject a different resolved ID", async () => {
  const fixture = await campaignRunFixture(undefined, "gpt-5.6-sol-2026-07-14"); fixture.result.resolved_configuration.model.snapshot_available = true; fixture.result.resolved_configuration.model.resolved_id = "gpt-5.6-sol-2026-07-13"; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-configuration"));
});

test("pinned model snapshots accept the exact resolved ID", async () => {
  const expected = "gpt-5.6-sol-2026-07-14"; const fixture = await campaignRunFixture(undefined, expected); fixture.result.resolved_configuration.model.snapshot_available = true; fixture.result.resolved_configuration.model.resolved_id = expected; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign)); await validateRepository(fixture.root);
});

test("unpinned model requests accept result-only snapshot resolution", async () => {
  const fixture = await campaignRunFixture(); fixture.result.resolved_configuration.model.snapshot_available = true; fixture.result.resolved_configuration.model.resolved_id = "gpt-5.6-sol-2026-07-14"; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign)); await validateRepository(fixture.root);
});

test("run artifacts verify valid referenced bytes", async () => {
  const fixture = await campaignRunFixture(); const bytes = "captured output\n"; const path = `runs/${fixture.result.run_id}/stdout.log`; await writeFile(join(fixture.root, "results", fixture.result.experiment.id, fixture.result.campaign_id, path), bytes);
  fixture.result.artifacts = [{ kind: "stdout", path, digest: `sha256:${sha256(bytes)}` }]; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign)); await validateRepository(fixture.root);
});

test("run artifacts reject missing referenced files", async () => {
  const fixture = await campaignRunFixture(); const path = `runs/${fixture.result.run_id}/missing.log`; fixture.result.artifacts = [{ kind: "stdout", path, digest: `sha256:${sha256("missing")}` }]; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-artifact" && item.message.includes("missing run artifact")));
});

test("run artifacts reject stale digests", async () => {
  const fixture = await campaignRunFixture(); const path = `runs/${fixture.result.run_id}/stdout.log`; await writeFile(join(fixture.root, "results", fixture.result.experiment.id, fixture.result.campaign_id, path), "current bytes\n");
  fixture.result.artifacts = [{ kind: "stdout", path, digest: `sha256:${sha256("stale bytes\n")}` }]; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-artifact" && item.message.includes("run artifact digest mismatch")));
});

test("run artifacts reject swapped request target paths", async () => {
  const fixture = await campaignRunFixture(); const runDirectory = join(fixture.root, "results", fixture.result.experiment.id, fixture.result.campaign_id, "runs", fixture.result.run_id); await writeFile(join(runDirectory, "stdout.log"), "stdout\n"); await writeFile(join(runDirectory, "stderr.log"), "stderr\n");
  fixture.result.artifacts = [{ kind: "stdout", path: `runs/${fixture.result.run_id}/stderr.log`, digest: `sha256:${sha256("stderr\n")}` }, { kind: "stderr", path: `runs/${fixture.result.run_id}/stdout.log`, digest: `sha256:${sha256("stdout\n")}` }]; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.filter((item) => item.code === "semantic/run-artifact-target").length === 2);
});

test("run evaluator artifacts require the evaluator request target", async () => {
  const fixture = await campaignRunFixture(); const path = `runs/${fixture.result.run_id}/stdout.log`; await writeFile(join(fixture.root, "results", fixture.result.experiment.id, fixture.result.campaign_id, path), "evaluator bytes\n");
  fixture.result.artifacts = [{ kind: "evaluator-result", path, digest: `sha256:${sha256("evaluator bytes\n")}` }]; fixture.campaign.runs[0].digest = manifestDigest(fixture.result);
  await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-artifact-target" && item.message.includes("evaluator-result")));
});

test("run results require a co-located canonical request", async () => {
  const fixture = await campaignRunFixture(); await unlink(fixture.requestFile);
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-request-reference"));
});

test("campaigns reject duplicate run references", async () => {
  const fixture = await campaignRunFixture(); fixture.campaign.runs.push({ ...fixture.campaign.runs[0] }); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/duplicate-run-reference"));
});

test("campaign run references require their run-result target", async () => {
  const fixture = await campaignRunFixture(); await unlink(fixture.resultFile);
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-run-reference"));
});

test("campaign run references require canonical paths aligned with run IDs", async () => {
  const fixture = await campaignRunFixture(); fixture.campaign.runs[0].path = `runs/${fixture.result.run_id}/request.json`; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-run-path"));
  fixture.campaign.runs[0].path = `runs/${fixture.result.run_id}/run.json`; fixture.campaign.runs[0].run_id = "01J00000000000000000000099"; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-run-path"));
});

test("campaign run targets retain campaign identity linkage", async () => {
  const fixture = await campaignRunFixture(); fixture.result.experiment.version = "2.0.0"; fixture.campaign.runs[0].digest = manifestDigest(fixture.result); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-run-identity") && !error.diagnostics.some((item) => item.code === "semantic/campaign-run-digest"));
});

test("campaign run references reject stale digests and mutated run results", async () => {
  const fixture = await campaignRunFixture(); fixture.campaign.runs[0].digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-run-digest"));
  fixture.campaign.runs[0].digest = manifestDigest(fixture.result); await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign)); fixture.result.warnings.push("mutated after campaign finalization"); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-run-digest"));
});

test("campaign summaries match every directly derivable referenced-run counter", async () => {
  const fixture = await campaignRunFixture(); await validateRepository(fixture.root);
  for (const name of ["recorded_runs", "operational_successes", "quality_eligible_runs", "end_to_end_passes", "invalid_runs"]) {
    fixture.campaign.summary[name] += 1; await writeFile(fixture.campaignFile, JSON.stringify(fixture.campaign));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/campaign-summary" && item.message.includes(name)));
    fixture.campaign.summary[name] -= 1;
  }
});

test("run evaluation summaries verify their co-located evaluator artifact", async () => {
  const fixture = await runEvaluationFixture(); await validateRepository(fixture.root);
  fixture.result.evaluation.result_artifact_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-digest"));
  fixture.result.evaluation.result_artifact_digest = manifestDigest(fixture.evaluation); await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); fixture.evaluation.checks[0].details = { mutation: true }; await writeFile(fixture.evaluationFile, JSON.stringify(fixture.evaluation));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-digest"));
});

test("run quality eligibility follows evaluation and terminal failure taxonomy", async () => {
  const successful = await runEvaluationFixture(); successful.result.evaluation.eligible_for_quality_aggregate = false; await writeFile(successful.resultFile, JSON.stringify(successful.result));
  await assert.rejects(validateRepository(successful.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-quality-eligibility" && item.message.includes("must be true")));

  const exhausted = await runEvaluationFixture(); exhausted.result.terminal = { reason: "wall_time_exhausted", attribution: "runner", operational_success: false }; await writeFile(exhausted.resultFile, JSON.stringify(exhausted.result));
  await validateRepository(exhausted.root);

  const providerFailure = await runEvaluationFixture(); providerFailure.result.terminal = { reason: "provider_error", attribution: "provider", operational_success: false }; await writeFile(providerFailure.resultFile, JSON.stringify(providerFailure.result));
  await assert.rejects(validateRepository(providerFailure.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-quality-eligibility" && item.message.includes("must be false")));
  providerFailure.result.evaluation.eligible_for_quality_aggregate = false; await writeFile(providerFailure.resultFile, JSON.stringify(providerFailure.result)); await validateRepository(providerFailure.root);
});

test("operator retries and resumes are excluded from headline quality aggregates", async () => {
  for (const mode of ["retry", "resume"]) {
    const fixture = await runEvaluationFixture();
    const attempt = { number: 2, mode, initiated_by: "operator", parent_run_id: "01J00000000000000000000001", reason: `operator ${mode}` };
    fixture.request.attempt = structuredClone(attempt); fixture.result.attempt = structuredClone(attempt); fixture.result.provenance.request_digest = manifestDigest(fixture.request);
    await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-quality-eligibility" && item.message.includes("must be false")));
    fixture.result.evaluation.eligible_for_quality_aggregate = false; await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await validateRepository(fixture.root);
  }
});

test("successful run evaluations require their co-located evaluator artifact", async () => {
  const fixture = await runEvaluationFixture(); await unlink(fixture.evaluationFile);
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-reference"));
});

test("run evaluation checks mirror evaluator scores and pass states", async () => {
  const fixture = await runEvaluationFixture(); fixture.result.evaluation.checks[0].score = 0; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-checks"));
  fixture.result.evaluation.checks[0].score = fixture.evaluation.checks[0].score; fixture.result.evaluation.checks[0].passed = false; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-checks"));
});

test("run end-to-end pass state is derived from evaluation, task policy, and terminal state", async () => {
  const fixture = await passingRunEvaluationFixture(); await validateRepository(fixture.root);
  fixture.result.terminal.reason = "wall_time_exhausted"; fixture.result.terminal.operational_success = false; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-summary"));
});

test("end-to-end passes require quality-eligible terminal outcomes", async () => {
  const terminals = [
    { reason: "provider_error", attribution: "provider", operational_success: false },
    { reason: "environment_error", attribution: "environment", operational_success: false },
    { reason: "cancelled", attribution: "operator", operational_success: false }
  ];
  for (const terminal of terminals) {
    const fixture = await passingRunEvaluationFixture(false); fixture.result.terminal = terminal; fixture.result.evaluation.eligible_for_quality_aggregate = false; await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-summary"));
    assert.equal(fixture.result.evaluation.artifact_quality_score, 1); assert.equal(fixture.result.evaluation.criteria_passed, true);
    fixture.result.evaluation.end_to_end_passed = false; await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await validateRepository(fixture.root);
  }

  const scorable = await passingRunEvaluationFixture(false); scorable.result.terminal = { reason: "wall_time_exhausted", attribution: "runner", operational_success: false }; await writeFile(scorable.resultFile, JSON.stringify(scorable.result));
  await validateRepository(scorable.root);
});

test("operator retry and resume attempts cannot count as end-to-end passes", async () => {
  for (const mode of ["retry", "resume"]) {
    const fixture = await passingRunEvaluationFixture();
    const attempt = { number: 2, mode, initiated_by: "operator", parent_run_id: "01J00000000000000000000001", reason: `operator ${mode}` };
    fixture.request.attempt = structuredClone(attempt); fixture.result.attempt = structuredClone(attempt); fixture.result.provenance.request_digest = manifestDigest(fixture.request); fixture.result.evaluation.eligible_for_quality_aggregate = false;
    await writeFile(fixture.requestFile, JSON.stringify(fixture.request)); await writeFile(fixture.resultFile, JSON.stringify(fixture.result));
    await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/run-evaluation-summary"));
    fixture.result.evaluation.end_to_end_passed = false; await writeFile(fixture.resultFile, JSON.stringify(fixture.result)); await validateRepository(fixture.root);
  }
});

test("noncanonical result reports are ignored even with exact names or canonical-looking directories", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "aht-repo-")); await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true }); await mkdir(join(fixture, "spec/examples"), { recursive: true });
  const reports = join(fixture, "results/demo/campaign/reports"); await mkdir(reports, { recursive: true });
  for (const name of ["suite-summary.json", "experiment-notes.json", "campaign.json", "task.json", "request.json", "run.json", "evaluator.json", "run-request.json", "run-result.json"]) await writeFile(join(reports, name), "{ not a manifest }");
  await mkdir(join(reports, "suites/foo"), { recursive: true }); await writeFile(join(reports, "suites/foo/1.0.0.json"), "{ not a manifest }");
  await mkdir(join(reports, "experiments/foo"), { recursive: true }); await writeFile(join(reports, "experiments/foo/1.0.0.json"), "{ not a manifest }");
  await validateRepository(fixture);
});

test("canonical task manifests reject symlinks without following external targets", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "aht-repo-")); await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true }); await mkdir(join(fixture, "spec/examples"), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "aht-external-")); const externalTask = join(outside, "task.json");
  const task = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8")); task.status = "draft"; await writeFile(externalTask, JSON.stringify(task));
  const taskDirectory = join(fixture, "tasks/demo/1.0.0"); await mkdir(taskDirectory, { recursive: true }); await symlink(externalTask, join(taskDirectory, "task.json"));
  await assert.rejects(validateRepository(fixture), (error: unknown) => error instanceof ValidationError && error.diagnostics.some((item) => item.code === "semantic/task-manifest-type" && item.message.includes("regular non-symlink file")));
});
