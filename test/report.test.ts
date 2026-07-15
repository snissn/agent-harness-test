import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { stringify } from "yaml";
import { manifestDigest, sha256 } from "../src/digests.js";
import { rebuildReport, weightedSuiteHeadline } from "../src/report.js";

type Json = Record<string, any>;

const source = resolve(import.meta.dirname, "..");
const experimentId = "codex-text-report-smoke";
const campaignId = "2026-07-15-codex-text-report-smoke";
const campaignRelative = `results/${experimentId}/${campaignId}`;

async function readJson(path: string): Promise<Json> { return JSON.parse(await readFile(path, "utf8")) as Json; }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
function databaseSnapshot(path: string): Json {
  const database = new DatabaseSync(path, { readOnly: true });
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  const snapshot = Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()]));
  database.close();
  return snapshot;
}
function campaignPath(root: string): string { return join(root, campaignRelative, "campaign.json"); }
function runPath(root: string, runId: string): string { return join(root, campaignRelative, "runs", runId, "run.json"); }

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-report-"));
  for (const path of ["spec", "tasks", "experiments", "suites"]) await cp(join(source, path), join(root, path), { recursive: true });
  await mkdir(join(root, "results", experimentId), { recursive: true });
  await cp(join(source, campaignRelative), join(root, campaignRelative), { recursive: true });
  return root;
}

async function restampRun(root: string, runId: string, run: Json): Promise<void> {
  await writeJson(runPath(root, runId), run);
  const campaign = await readJson(campaignPath(root));
  const reference = campaign.runs.find((item: Json) => item.run_id === runId);
  assert.ok(reference, `missing campaign reference for ${runId}`);
  reference.digest = manifestDigest(run);
  const referencedRuns = await Promise.all(campaign.runs.map((item: Json) => readJson(join(root, campaignRelative, item.path))));
  campaign.summary = {
    recorded_runs: referencedRuns.length,
    operational_successes: referencedRuns.filter(item => item.terminal?.operational_success === true).length,
    quality_eligible_runs: referencedRuns.filter(item => item.evaluation?.eligible_for_quality_aggregate === true).length,
    end_to_end_passes: referencedRuns.filter(item => item.evaluation?.end_to_end_passed === true).length,
    invalid_runs: referencedRuns.filter(item => item.evaluation?.eligible_for_quality_aggregate !== true).length,
  };
  await writeJson(campaignPath(root), campaign);
}

async function mutateRun(root: string, runId: string, mutate: (run: Json) => void): Promise<void> {
  const run = await readJson(runPath(root, runId));
  mutate(run);
  await restampRun(root, runId, run);
}

async function mutateRequest(root: string, runId: string, mutate: (request: Json) => void): Promise<void> {
  const run = await readJson(runPath(root, runId));
  const requestArtifact = run.artifacts.find((artifact: Json) => artifact.kind === "request");
  const requestPath = join(root, campaignRelative, requestArtifact.path);
  const request = await readJson(requestPath);
  mutate(request);
  await writeJson(requestPath, request);
  const content = await readFile(requestPath);
  requestArtifact.digest = `sha256:${sha256(content)}`;
  requestArtifact.bytes = content.byteLength;
  run.provenance.request_digest = manifestDigest(request);
  await restampRun(root, runId, run);
}

async function mutateExperiment(root: string, mutate: (experiment: Json) => void): Promise<void> {
  const path = join(root, "experiments", experimentId, "1.0.0.json");
  const experiment = await readJson(path);
  mutate(experiment);
  await writeJson(path, experiment);
  const reference = { ...experiment.suite, id: experiment.id, version: experiment.version, spec_path: `experiments/${experiment.id}/${experiment.version}.json`, spec_digest: manifestDigest(experiment) };
  delete reference.weight; delete reference.anchor;
  const campaign = await readJson(campaignPath(root));
  campaign.experiment = reference;
  for (const runReference of campaign.runs) {
    const path = runPath(root, runReference.run_id);
    const run = await readJson(path);
    run.experiment = reference;
    const requestArtifact = run.artifacts.find((artifact: Json) => artifact.kind === "request");
    const requestPath = join(root, campaignRelative, requestArtifact.path);
    const request = await readJson(requestPath);
    request.experiment = reference;
    request.configuration = experiment.configurations.find((configuration: Json) => configuration.id === run.configuration_id);
    await writeJson(requestPath, request);
    const requestContent = await readFile(requestPath);
    requestArtifact.digest = `sha256:${sha256(requestContent)}`;
    requestArtifact.bytes = requestContent.byteLength;
    run.provenance.request_digest = manifestDigest(request);
    await writeJson(path, run);
    runReference.digest = manifestDigest(run);
  }
  await writeJson(campaignPath(root), campaign);
}

async function makeHighScorable(root: string, score: number): Promise<void> {
  const highId = "codex-codex-high-r1";
  const run = await readJson(runPath(root, highId));
  const medium = await readJson(runPath(root, "codex-codex-medium-r1"));
  const evaluatorSource = join(root, campaignRelative, "runs/codex-codex-medium-r1/evaluator.json");
  const evaluatorPath = join(root, campaignRelative, `runs/${highId}/evaluator.json`);
  await cp(evaluatorSource, evaluatorPath);
  const evaluator = await readJson(evaluatorPath);
  run.evaluation = { ...medium.evaluation, artifact_quality_score: score, end_to_end_passed: score >= 0.85, criteria_passed: score >= 0.85, result_artifact_digest: manifestDigest(evaluator) };
  const content = await readFile(evaluatorPath);
  run.artifacts.push({ kind: "evaluator-result", path: `runs/${highId}/evaluator.json`, digest: `sha256:${sha256(content)}`, media_type: "application/json", bytes: content.byteLength });
  await restampRun(root, highId, run);
}

async function addRetry(root: string): Promise<string> {
  const parentId = "codex-codex-medium-r1";
  const retryId = "codex-codex-medium-r2";
  const parentDirectory = join(root, campaignRelative, "runs", parentId);
  const retryDirectory = join(root, campaignRelative, "runs", retryId);
  await cp(parentDirectory, retryDirectory, { recursive: true });
  const requestPath = join(retryDirectory, "request.json");
  const request = JSON.parse((await readFile(requestPath, "utf8")).replaceAll(parentId, retryId)) as Json;
  request.run_id = retryId;
  request.attempt = { number: 2, mode: "retry", initiated_by: "operator", parent_run_id: parentId, reason: "diagnostic retry" };
  await writeJson(requestPath, request);
  const requestContent = await readFile(requestPath);
  const run = JSON.parse(JSON.stringify(await readJson(join(parentDirectory, "run.json"))).replaceAll(parentId, retryId)) as Json;
  run.run_id = retryId;
  run.attempt = request.attempt;
  const requestArtifact = run.artifacts.find((artifact: Json) => artifact.kind === "request");
  requestArtifact.digest = `sha256:${sha256(requestContent)}`;
  requestArtifact.bytes = requestContent.byteLength;
  run.provenance.request_digest = manifestDigest(request);
  await writeJson(join(retryDirectory, "run.json"), run);
  const campaign = await readJson(campaignPath(root));
  campaign.runs.push({ run_id: retryId, path: `runs/${retryId}/run.json`, digest: manifestDigest(run) });
  campaign.summary.recorded_runs += 1;
  campaign.summary.operational_successes += 1;
  campaign.summary.quality_eligible_runs += 1;
  campaign.summary.end_to_end_passes += 1;
  await writeJson(campaignPath(root), campaign);
  return retryId;
}

async function addDuplicateCampaignIdInAnotherExperiment(root: string): Promise<void> {
  const alternateId = "alternate-report-smoke";
  const originalExperiment = await readJson(join(root, "experiments", experimentId, "1.0.0.json"));
  const experiment = { ...originalExperiment, id: alternateId, title: "Alternate empty campaign identity" };
  await mkdir(join(root, "experiments", alternateId), { recursive: true });
  await writeJson(join(root, "experiments", alternateId, "1.0.0.json"), experiment);
  const originalCampaign = await readJson(campaignPath(root));
  const campaign = {
    ...originalCampaign,
    experiment: { id: alternateId, version: "1.0.0", spec_path: `experiments/${alternateId}/1.0.0.json`, spec_digest: manifestDigest(experiment) },
    planned_run_count: 1,
    runs: [],
    summary: { recorded_runs: 0, operational_successes: 0, quality_eligible_runs: 0, end_to_end_passes: 0, invalid_runs: 0 },
    warnings: ["synthetic empty campaign used to test scoped identity"],
  };
  const directory = join(root, "results", alternateId, campaignId);
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "campaign.json"), campaign);
}

async function addFullyIncompatibleHistory(root: string): Promise<void> {
  const alternateTaskVersion = "1.0.1";
  const alternateSuiteId = "incompatible-slice";
  const alternateExperimentId = "incompatible-history";
  const alternateCampaignId = "2026-07-16-incompatible-history";

  const taskSource = join(root, "tasks/python-text-report/1.0.0");
  const taskDirectory = join(root, `tasks/python-text-report/${alternateTaskVersion}`);
  await cp(taskSource, taskDirectory, { recursive: true });
  const task = await readJson(join(taskDirectory, "task.json"));
  task.version = alternateTaskVersion;
  task.prompt.path = `tasks/python-text-report/${alternateTaskVersion}/prompt.md`;
  task.problem_state.source.path = `tasks/python-text-report/${alternateTaskVersion}/state`;
  task.evaluator.path = `tasks/python-text-report/${alternateTaskVersion}/evaluator`;
  task.calibration.evidence_path = `tasks/python-text-report/${alternateTaskVersion}/calibration.json`;
  await writeJson(join(taskDirectory, "task.json"), task);
  const taskReference = {
    id: task.id,
    version: task.version,
    spec_path: `tasks/${task.id}/${task.version}/task.json`,
    spec_digest: manifestDigest(task),
    prompt_digest: task.prompt.digest,
    initial_tree_digest: task.problem_state.expected_tree_digest,
    evaluator_digest: task.evaluator.digest,
  };

  const suite = await readJson(join(root, "suites/first-codex-slice/1.0.0.json"));
  suite.id = alternateSuiteId;
  suite.title = "Incompatible synthetic history slice";
  suite.tasks = [{ id: task.id, version: task.version, spec_path: taskReference.spec_path, spec_digest: taskReference.spec_digest, weight: 1, anchor: true }];
  await mkdir(join(root, "suites", alternateSuiteId), { recursive: true });
  await writeJson(join(root, "suites", alternateSuiteId, "1.0.0.json"), suite);
  const suiteReference = { id: suite.id, version: suite.version, spec_path: `suites/${suite.id}/${suite.version}.json`, spec_digest: manifestDigest(suite) };

  const experiment = await readJson(join(root, "experiments", experimentId, "1.0.0.json"));
  experiment.id = alternateExperimentId;
  experiment.title = "Every historical compatibility dimension differs";
  experiment.suite = suiteReference;
  experiment.configurations = [experiment.configurations[0]];
  experiment.configurations[0].harness.interface = "sdk-exec";
  experiment.configurations[0].harness.adapter_version = "9.0.0";
  experiment.configurations[0].harness.runtime_version = "9.0.0";
  experiment.configurations[0].model.requested_id = "different-model";
  experiment.configurations[0].effort = { display_label: "different", native_value: "different" };
  experiment.reporting.comparisons = [];
  await mkdir(join(root, "experiments", alternateExperimentId), { recursive: true });
  await writeJson(join(root, "experiments", alternateExperimentId, "1.0.0.json"), experiment);
  const experimentReference = { id: experiment.id, version: experiment.version, spec_path: `experiments/${experiment.id}/${experiment.version}.json`, spec_digest: manifestDigest(experiment) };

  const directory = join(root, "results", alternateExperimentId, alternateCampaignId);
  await cp(join(root, campaignRelative), directory, { recursive: true });
  const campaign = await readJson(join(directory, "campaign.json"));
  campaign.campaign_id = alternateCampaignId;
  campaign.experiment = experimentReference;
  campaign.suite = suiteReference;
  campaign.observed_at = "2026-07-16T00:00:00.000Z";
  campaign.runs = campaign.runs.filter((reference: Json) => reference.run_id === "codex-codex-medium-r1");
  campaign.planned_run_count = 1;
  campaign.summary = { recorded_runs: 1, operational_successes: 1, quality_eligible_runs: 1, end_to_end_passes: 1, invalid_runs: 0 };
  const runFile = join(directory, "runs/codex-codex-medium-r1/run.json");
  const run = await readJson(runFile);
  run.campaign_id = alternateCampaignId;
  run.experiment = experimentReference;
  run.suite = suiteReference;
  run.task = taskReference;
  const { id: _configurationId, ...resolvedConfiguration } = experiment.configurations[0];
  run.resolved_configuration = { ...resolvedConfiguration, model: { ...resolvedConfiguration.model, snapshot_available: false }, effective_config_digest: run.resolved_configuration.effective_config_digest };
  run.provenance.execution = { ...run.provenance.execution, environment_digest: `sha256:${"a".repeat(64)}`, operating_system: "linux", architecture: "x64" };
  const requestArtifact = run.artifacts.find((artifact: Json) => artifact.kind === "request");
  const requestPath = join(directory, requestArtifact.path);
  const request = await readJson(requestPath);
  request.campaign_id = alternateCampaignId;
  request.experiment = experimentReference;
  request.suite = suiteReference;
  request.task = taskReference;
  request.configuration = experiment.configurations.find((configuration: Json) => configuration.id === run.configuration_id);
  request.execution = run.provenance.execution;
  await writeJson(requestPath, request);
  const requestContent = await readFile(requestPath);
  requestArtifact.digest = `sha256:${sha256(requestContent)}`;
  requestArtifact.bytes = requestContent.byteLength;
  run.provenance.request_digest = manifestDigest(request);
  const evaluatorArtifact = run.artifacts.find((artifact: Json) => artifact.kind === "evaluator-result");
  const evaluatorPath = join(directory, evaluatorArtifact.path);
  const evaluator = await readJson(evaluatorPath);
  evaluator.task_version = alternateTaskVersion;
  await writeJson(evaluatorPath, evaluator);
  const evaluatorContent = await readFile(evaluatorPath);
  evaluatorArtifact.digest = `sha256:${sha256(evaluatorContent)}`;
  evaluatorArtifact.bytes = evaluatorContent.byteLength;
  run.evaluation.result_artifact_digest = manifestDigest(evaluator);
  await writeJson(runFile, run);
  campaign.runs[0].digest = manifestDigest(run);
  await writeJson(join(directory, "campaign.json"), campaign);
}

async function convertCanonicalMetadataToYaml(root: string): Promise<void> {
  const taskJsonPath = join(root, "tasks/python-text-report/1.0.0/task.json");
  const taskYamlPath = join(root, "tasks/python-text-report/1.0.0/task.yaml");
  const suiteJsonPath = join(root, "suites/first-codex-slice/1.0.0.json");
  const suiteYamlPath = join(root, "suites/first-codex-slice/1.0.0.yml");
  const experimentJsonPath = join(root, "experiments", experimentId, "1.0.0.json");
  const experimentYamlPath = join(root, "experiments", experimentId, "1.0.0.yaml");

  const task = await readJson(taskJsonPath);
  await writeFile(taskYamlPath, stringify(task));
  await rm(taskJsonPath);
  const taskReference = { id: task.id, version: task.version, spec_path: "tasks/python-text-report/1.0.0/task.yaml", spec_digest: manifestDigest(task), prompt_digest: task.prompt.digest, initial_tree_digest: task.problem_state.expected_tree_digest, evaluator_digest: task.evaluator.digest };

  const suite = await readJson(suiteJsonPath);
  suite.tasks[0].spec_path = taskReference.spec_path;
  await writeFile(suiteYamlPath, stringify(suite));
  await rm(suiteJsonPath);
  const suiteReference = { id: suite.id, version: suite.version, spec_path: "suites/first-codex-slice/1.0.0.yml", spec_digest: manifestDigest(suite) };

  const experiment = await readJson(experimentJsonPath);
  experiment.suite = suiteReference;
  await writeFile(experimentYamlPath, stringify(experiment));
  await rm(experimentJsonPath);
  const experimentReference = { id: experiment.id, version: experiment.version, spec_path: `experiments/${experimentId}/1.0.0.yaml`, spec_digest: manifestDigest(experiment) };

  const campaign = await readJson(campaignPath(root));
  campaign.experiment = experimentReference;
  campaign.suite = suiteReference;
  for (const runReference of campaign.runs) {
    const path = runPath(root, runReference.run_id);
    const run = await readJson(path);
    run.experiment = experimentReference;
    run.suite = suiteReference;
    run.task = taskReference;
    const requestArtifact = run.artifacts.find((artifact: Json) => artifact.kind === "request");
    const requestPath = join(root, campaignRelative, requestArtifact.path);
    const request = await readJson(requestPath);
    request.experiment = experimentReference;
    request.suite = suiteReference;
    request.task = taskReference;
    await writeJson(requestPath, request);
    const requestContent = await readFile(requestPath);
    requestArtifact.digest = `sha256:${sha256(requestContent)}`;
    requestArtifact.bytes = requestContent.byteLength;
    run.provenance.request_digest = manifestDigest(request);
    await writeJson(path, run);
    runReference.digest = manifestDigest(run);
  }
  await writeJson(campaignPath(root), campaign);
}

test("suite headline averages repetitions per task before applying declared task weights", () => {
  const score = weightedSuiteHeadline([
    { task: "task-a@1.0.0", score: 0, weight: 1 },
    { task: "task-a@1.0.0", score: 1, weight: 1 },
    { task: "task-b@1.0.0", score: 1, weight: 3 },
  ]);
  assert.equal(score, 0.875);
});

test("campaign discovery ignores nested workspace campaign files", async () => {
  const root = await fixture();
  try {
    const nested = join(root, campaignRelative, "runs", "unreferenced", "workspace");
    await mkdir(nested, { recursive: true });
    await writeJson(join(nested, "campaign.json"), { invalid: "SECRET_SENTINEL" });
    const result = await rebuildReport(root);
    const data = await readJson(result.data);
    assert.equal(result.runs, 2);
    assert.equal(result.invalid, 0);
    assert.equal(data.ingestion_errors.length, 0);
    assert.doesNotMatch(await readFile(result.data, "utf8"), /SECRET_SENTINEL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expected model snapshots accept the matching resolved snapshot", async () => {
  const root = await fixture();
  try {
    await mutateExperiment(root, experiment => {
      experiment.configurations.find((configuration: Json) => configuration.id === "codex-medium").model.expected_snapshot_id = "gpt-5.6-sol-2026-07-01";
    });
    await mutateRun(root, "codex-codex-medium-r1", run => {
      run.resolved_configuration.model.snapshot_available = true;
      run.resolved_configuration.model.resolved_id = "gpt-5.6-sol-2026-07-01";
    });
    const result = await rebuildReport(root);
    const data = await readJson(result.data);
    assert.equal(result.runs, 2, JSON.stringify(data.ingestion_errors));
    assert.equal(result.invalid, 0, JSON.stringify(data.ingestion_errors));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical task, suite, and experiment YAML/YML manifests rebuild successfully", async () => {
  const root = await fixture();
  try {
    await convertCanonicalMetadataToYaml(root);
    const result = await rebuildReport(root);
    assert.equal(result.runs, 2);
    assert.equal(result.invalid, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("request plan coordinates must match the retained run", async () => {
  for (const coordinate of ["repetition", "schedule_index"] as const) {
    const root = await fixture();
    try {
      await mutateRequest(root, "codex-codex-medium-r1", request => { request[coordinate] += 1; });
      const result = await rebuildReport(root);
      const data = await readJson(result.data);
      assert.equal(result.runs, 1, coordinate);
      assert.equal(result.invalid, 1, coordinate);
      assert.equal(data.ingestion_errors[0].code, "reference-invalid", coordinate);
      assert.match(data.ingestion_errors[0].message, new RegExp(coordinate));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("deterministic rebuild renders every required report section and smoke qualification", async () => {
  const root = await fixture();
  try {
    const first = await rebuildReport(root, "report-a");
    const second = await rebuildReport(root, "report-b");
    const firstData = await readFile(first.data, "utf8");
    assert.equal(firstData, await readFile(second.data, "utf8"));
    assert.deepEqual(databaseSnapshot(first.database), databaseSnapshot(second.database));
    const html = await readFile(first.html, "utf8");
    for (const heading of ["Configuration metrics", "Paired task deltas", "Operational failures and ingestion errors", "Task, category, and language drill-down", "Effort and telemetry completeness", "Historical compatibility and lineage", "Metric completeness"]) assert.match(html, new RegExp(heading));
    assert.match(firstData, /one repetition/);
    assert.doesNotMatch(`${firstData}${html}`, /agent-harness-report-|SECRET_SENTINEL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("infrastructure and valid exhausted evaluations use distinct denominators and terminal evidence", async () => {
  const root = await fixture();
  try {
    await mutateRun(root, "codex-codex-medium-r1", run => {
      run.terminal = { reason: "wall_time_exhausted", attribution: "runner", operational_success: false, exit_code: null };
      run.evaluation.eligible_for_quality_aggregate = true;
      run.evaluation.end_to_end_passed = false;
    });
    const result = await rebuildReport(root);
    const data = await readJson(result.data);
    const medium = data.configurations.find((item: Json) => item.configuration_id === "codex-medium");
    const high = data.configurations.find((item: Json) => item.configuration_id === "codex-high");
    assert.equal(medium.quality_denominator, 1);
    assert.equal(medium.operational_completion_rate, 0);
    assert.equal(high.quality_denominator, 0);
    assert.equal(high.invalid_or_infrastructure_attempts, 1);
    assert.deepEqual(data.operational_failures.map((failure: Json) => failure.terminal_reason).sort(), ["environment_error", "wall_time_exhausted"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial and unavailable tokens/cost are qualified null rather than zero", async () => {
  const root = await fixture();
  try {
    await mutateRun(root, "codex-codex-medium-r1", run => {
      run.metrics.tokens = { status: "partial", source: "synthetic", partial_reason: "only output observed", output: 3 };
      run.metrics.cost = { status: "unavailable", source: "synthetic", unavailable_reason: "provider omitted cost" };
    });
    const data = await readJson((await rebuildReport(root)).data);
    const observation = data.effort_quality.find((item: Json) => item.configuration_id === "codex-medium");
    assert.deepEqual(observation.tokens, { status: "partial", value: null, qualification: "only output observed" });
    assert.deepEqual(observation.cost, { status: "unavailable", value: null, qualification: "provider omitted cost" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retry remains visible with parent lineage and is excluded from headline aggregates", async () => {
  const root = await fixture();
  try {
    const retryId = await addRetry(root);
    const data = await readJson((await rebuildReport(root)).data);
    const medium = data.configurations.find((item: Json) => item.configuration_id === "codex-medium");
    assert.equal(medium.recorded_attempts, 1);
    assert.equal(medium.quality_denominator, 1);
    assert.deepEqual(data.lineage.map((item: Json) => [item.run_id, item.attempt.parent_run_id, item.excluded_from_headline]), [[retryId, "codex-codex-medium-r1", true]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("declared reverse-sorted baseline direction emits per-task deltas before aggregate", async () => {
  const root = await fixture();
  try {
    await makeHighScorable(root, 0.25);
    await mutateRun(root, "codex-codex-medium-r1", run => { run.evaluation.artifact_quality_score = 0.75; });
    await mutateExperiment(root, experiment => { experiment.reporting.comparisons = [{ id: "reverse-sort", baseline_configuration_id: "codex-high", candidate_configuration_ids: ["codex-medium"], gates: [] }]; });
    const text = await readFile((await rebuildReport(root)).data, "utf8");
    const data = JSON.parse(text) as Json;
    const comparison = data.comparisons[0];
    assert.equal(comparison.baseline, "codex-high");
    assert.equal(comparison.candidate, "codex-medium");
    assert.equal(comparison.direction, "candidate-minus-baseline");
    assert.equal(comparison.paired_task_deltas[0].score_delta, 0.5);
    assert.equal(comparison.aggregate_score_delta, 0.5);
    assert.ok(text.indexOf('"paired_task_deltas"') < text.indexOf('"aggregate_score_delta"'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("suite/task/harness/model/effort/topology incompatibilities split and qualify history", async () => {
  const root = await fixture();
  try {
    await addFullyIncompatibleHistory(root);
    const data = await readJson((await rebuildReport(root)).data);
    const base = data.history_series.find((series: Json) => series.points.some((point: Json) => point.campaign_key === `${experimentId}@1.0.0:${campaignId}` && point.configuration_id === "codex-medium"));
    const alternate = data.history_series.find((series: Json) => series.points.some((point: Json) => point.campaign_key.includes("incompatible-history")));
    assert.ok(base && alternate, JSON.stringify(data.ingestion_errors));
    assert.notEqual(base.series_id, alternate.series_id);
    for (const dimension of ["suite", "task", "harness", "model", "effort", "topology"]) assert.notDeepEqual(base.compatibility_identity[dimension], alternate.compatibility_identity[dimension]);
    assert.equal(base.connected_unqualified, false);
    assert.match(base.qualification_reasons.join(" "), /snapshot unavailable|non-canonical/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("campaign IDs are scoped by experiment and can repeat without collision", async () => {
  const root = await fixture();
  try {
    await addDuplicateCampaignIdInAnotherExperiment(root);
    const result = await rebuildReport(root);
    const data = await readJson(result.data);
    assert.equal(result.invalid, 0);
    assert.equal(data.campaigns.filter((campaign: Json) => campaign.campaign_id === campaignId).length, 2);
    assert.equal(new Set(data.campaigns.map((campaign: Json) => campaign.campaign_key)).size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema, digest, and reference corruption are quarantined with stable codes", async () => {
  for (const corruption of ["schema", "digest", "reference"] as const) {
    const root = await fixture();
    try {
      if (corruption === "schema") {
        const run = await readJson(runPath(root, "codex-codex-high-r1"));
        delete run.terminal;
        await restampRun(root, "codex-codex-high-r1", run);
      } else if (corruption === "digest") {
        await writeFile(join(root, campaignRelative, "runs/codex-codex-high-r1/stdout.log"), "corrupt\n");
      } else {
        await mutateRun(root, "codex-codex-high-r1", run => { run.task.spec_digest = `sha256:${"0".repeat(64)}`; });
      }
      const result = await rebuildReport(root);
      const data = await readJson(result.data);
      assert.equal(result.runs, 1, corruption);
      assert.equal(result.invalid, 1, corruption);
      assert.equal(data.ingestion_errors[0].code, corruption === "schema" ? "schema-invalid-run" : corruption === "digest" ? "digest-mismatch" : "reference-invalid");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("structured errors retain attribution/phase/code while secrets and host paths are redacted", async () => {
  const root = await fixture();
  try {
    await mutateRun(root, "codex-codex-high-r1", run => {
      run.errors = [{ occurred_at: run.observed_at, phase: "harness-startup", code: "harness.launch_failed", attribution: "harness", retryable: true, message: "SECRET_SENTINEL leaked from /Users/unrelated/private/token.txt" }];
    });
    const result = await rebuildReport(root);
    const jsonText = await readFile(result.data, "utf8");
    const htmlText = await readFile(result.html, "utf8");
    assert.doesNotMatch(`${jsonText}${htmlText}`, /SECRET_SENTINEL|\/Users\/unrelated|agent-harness-report-/);
    const data = JSON.parse(jsonText) as Json;
    assert.deepEqual(({ attribution: data.error_details[0].attribution, phase: data.error_details[0].phase, code: data.error_details[0].code }), { attribution: "harness", phase: "harness-startup", code: "harness.launch_failed" });
    assert.match(data.error_details[0].message, /\[REDACTED\].*\[ABSOLUTE_PATH\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report refuses output paths that overlap authoritative sources", async () => {
  const root = await fixture();
  try {
    await assert.rejects(rebuildReport(root, "."), /disposable directory/);
    await assert.rejects(rebuildReport(root, "results"), /disposable directory/);
    await assert.rejects(rebuildReport(root, "tasks/out"), /authoritative source roots/);
    await assert.rejects(rebuildReport(root, "suites/out"), /authoritative source roots/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
