import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, manifestDigest, sha256 } from "./digests.js";
import { isManifestPath, loadManifest } from "./load.js";
import { SchemaValidator } from "./schema.js";

type Json = Record<string, any>;

export const REPORT_DATA_VERSION = "0.1.0";

class SourceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function portable(path: string): string { return path.replaceAll("\\", "/"); }
function key(reference: Json): string { return `${reference.id}@${reference.version}`; }
function equal(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function metric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function safe(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]!); }
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function redactString(value: string, root: string): string {
  return value
    .replaceAll(root, "[REPOSITORY]")
    .replaceAll(portable(root), "[REPOSITORY]")
    .replaceAll("SECRET_SENTINEL", "[REDACTED]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|opt)\/)(?:[^\s"'<>]+[\\/]?)+/g, "[ABSOLUTE_PATH]");
}
function sanitize(value: unknown, root: string): unknown {
  if (typeof value === "string") return redactString(value, root);
  if (Array.isArray(value)) return value.map(item => sanitize(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, root)]));
  return value;
}
async function json(path: string): Promise<Json> { return JSON.parse(await readFile(path, "utf8")) as Json; }
async function manifest(path: string): Promise<Json> { return await loadManifest(path) as Json; }
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else found.push(path);
    }
  }
  await walk(root);
  return found;
}
function sourceError(error: unknown, fallback: string): { code: string; message: string } {
  return error instanceof SourceError ? { code: error.code, message: error.message } : { code: fallback, message: String(error) };
}
function validateSchema(validator: SchemaValidator, kind: string, value: unknown, path: string, code: string): void {
  try { validator.validate(kind, value, path); }
  catch (error) { throw new SourceError(code, String(error)); }
}
function historyIdentity(campaign: Json, run: Json): { identity: Json; reasons: string[] } {
  const harness = run.resolved_configuration.harness;
  const model = run.resolved_configuration.model;
  const effort = run.resolved_configuration.effort;
  const topology = run.provenance.execution;
  const reasons: string[] = [];
  if (!harness.adapter_version || !harness.runtime_version) reasons.push("harness or adapter version unavailable");
  if (model.snapshot_available !== true) reasons.push("resolved model snapshot unavailable");
  if (topology.canonical !== true) reasons.push("execution topology is non-canonical");
  return {
    identity: {
      suite: campaign.suite,
      task: run.task,
      harness: { family: harness.family, interface: harness.interface, adapter_id: harness.adapter_id, adapter_version: harness.adapter_version, runtime_version: harness.runtime_version },
      model: { provider: model.provider, requested_id: model.requested_id, resolved_id: model.resolved_id ?? null, snapshot_available: model.snapshot_available === true },
      effort: { native_value: effort.native_value },
      topology,
    },
    reasons,
  };
}

export function weightedSuiteHeadline(observations: Array<{ task: string; score: number; weight: number }>): number | null {
  const tasks = new Map<string, { scores: number[]; weight: number }>();
  for (const observation of observations) {
    const task = tasks.get(observation.task) ?? { scores: [], weight: observation.weight };
    task.scores.push(observation.score);
    tasks.set(observation.task, task);
  }
  const taskScores = [...tasks.values()].filter(task => task.scores.length > 0 && task.weight > 0);
  const totalWeight = taskScores.reduce((total, task) => total + task.weight, 0);
  if (totalWeight === 0) return null;
  return taskScores.reduce((total, task) => total + task.weight * (task.scores.reduce((sum, score) => sum + score, 0) / task.scores.length), 0) / totalWeight;
}

export interface RebuildResult { database: string; data: string; html: string; invalid: number; runs: number; }

/** Rebuilds a disposable projection. Source artifacts are never modified. */
export async function rebuildReport(rootInput: string, outputInput = "reports"): Promise<RebuildResult> {
  const root = resolve(rootInput);
  const output = resolve(root, outputInput);
  const results = join(root, "results");
  const protectedRoots = [results, join(root, "tasks"), join(root, "spec"), join(root, "experiments"), join(root, "suites")];
  if (output === root || !within(root, output) || protectedRoots.some(source => output === source || within(source, output) || within(output, source))) {
    throw new Error("report output must be a disposable directory outside authoritative source roots");
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const database = join(output, "index.sqlite");
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE campaigns (id TEXT PRIMARY KEY, campaign_id TEXT, experiment_key TEXT, observed_at TEXT, mode TEXT, suite_key TEXT, status TEXT);
CREATE TABLE configurations (experiment_key TEXT, configuration_id TEXT, harness TEXT, model TEXT, effort TEXT, limits TEXT, PRIMARY KEY (experiment_key, configuration_id));
CREATE TABLE tasks (task_key TEXT PRIMARY KEY, category TEXT, languages TEXT, spec_digest TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, campaign_key TEXT, run_id TEXT, configuration_id TEXT, task_key TEXT, category TEXT, languages TEXT, attempt_number INTEGER, attempt_mode TEXT, terminal_reason TEXT, attribution TEXT, operational_success INTEGER, quality_eligible INTEGER, score REAL, end_to_end_passed INTEGER, timing_status TEXT, timing_ms INTEGER, tokens_status TEXT, tokens_total INTEGER, cost_status TEXT, cost REAL, resources_status TEXT);
CREATE TABLE checks (run_key TEXT, check_id TEXT, score REAL, passed INTEGER, weight REAL, required INTEGER, PRIMARY KEY (run_key, check_id));
CREATE TABLE artifacts (run_key TEXT, kind TEXT, path TEXT, digest TEXT, bytes INTEGER, PRIMARY KEY (run_key, kind, path));
CREATE TABLE structured_errors (campaign_key TEXT, run_id TEXT, phase TEXT, code TEXT, attribution TEXT, retryable INTEGER, message TEXT);
CREATE TABLE ingestion_errors (source TEXT, code TEXT, message TEXT);
CREATE TABLE lineage (campaign_key TEXT, run_id TEXT, parent_run_id TEXT, attempt_mode TEXT);`);

  const validator = await SchemaValidator.create(join(root, "spec/schemas"));
  const campaignFiles = (await files(results)).filter(path => {
    const parts = portable(relative(results, path)).split("/");
    return parts.length === 3 && parts[2] === "campaign.json";
  }).sort((left, right) => portable(left).localeCompare(portable(right)));
  const taskMetadata = new Map<string, Json>();
  const experimentMetadata = new Map<string, Json>();
  const suiteMetadata = new Map<string, Json>();
  for (const path of (await files(join(root, "tasks"))).filter(path => {
    const parts = portable(relative(join(root, "tasks"), path)).split("/");
    return parts.length === 3 && /^task\.(?:json|ya?ml)$/i.test(parts[2] ?? "");
  })) {
    const task = await manifest(path); validateSchema(validator, "task", task, path, "schema-invalid-task"); taskMetadata.set(key(task), task);
  }
  for (const path of (await files(join(root, "experiments"))).filter(path => portable(relative(join(root, "experiments"), path)).split("/").length === 2 && isManifestPath(path))) {
    const experiment = await manifest(path); validateSchema(validator, "experiment", experiment, path, "schema-invalid-experiment"); experimentMetadata.set(key(experiment), experiment);
  }
  for (const path of (await files(join(root, "suites"))).filter(path => portable(relative(join(root, "suites"), path)).split("/").length === 2 && isManifestPath(path))) {
    const suite = await manifest(path); validateSchema(validator, "suite", suite, path, "schema-invalid-suite"); suiteMetadata.set(key(suite), suite);
  }

  const errors: Json[] = [];
  const rows: Json[] = [];
  const campaignRecords: Json[] = [];
  const campaignErrors: Json[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run("projection_schema_version", REPORT_DATA_VERSION);
    for (const [experimentKey, experiment] of experimentMetadata) for (const configuration of experiment.configurations) {
      db.prepare("INSERT INTO configurations VALUES (?, ?, ?, ?, ?, ?)").run(experimentKey, configuration.id, JSON.stringify(configuration.harness), JSON.stringify(configuration.model), JSON.stringify(configuration.effort), JSON.stringify(configuration.limits));
    }
    for (const [taskKey, task] of taskMetadata) db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?)").run(taskKey, task.category ?? "unknown", JSON.stringify(task.languages ?? []), manifestDigest(task));
    for (const campaignPath of campaignFiles) {
      let campaign: Json;
      let experiment: Json;
      try {
        campaign = await json(campaignPath);
        validateSchema(validator, "campaign", campaign, campaignPath, "schema-invalid-campaign");
        const referencedExperiment = experimentMetadata.get(key(campaign.experiment));
        if (!referencedExperiment || manifestDigest(referencedExperiment) !== campaign.experiment.spec_digest) throw new SourceError("reference-invalid", "campaign experiment reference/digest is invalid");
        experiment = referencedExperiment;
        const suite = suiteMetadata.get(key(campaign.suite));
        if (!suite || manifestDigest(suite) !== campaign.suite.spec_digest || !equal(experiment.suite, campaign.suite)) throw new SourceError("reference-invalid", "campaign suite reference/digest is invalid");
      } catch (error) {
        const detail = sourceError(error, "invalid-campaign");
        errors.push({ source: portable(relative(root, campaignPath)), ...detail });
        continue;
      }

      const campaignDir = resolve(campaignPath, "..");
      const experimentKey = key(campaign.experiment);
      const campaignKey = `${experimentKey}:${campaign.campaign_id}`;
      try {
        db.prepare("INSERT INTO campaigns VALUES (?, ?, ?, ?, ?, ?, ?)").run(campaignKey, campaign.campaign_id, experimentKey, campaign.observed_at, campaign.mode, key(campaign.suite), campaign.status);
      } catch (error) {
        errors.push({ source: portable(relative(root, campaignPath)), code: "duplicate-campaign", message: String(error) });
        continue;
      }
      campaignRecords.push({ campaign_key: campaignKey, campaign_id: campaign.campaign_id, experiment: experimentKey, observed_at: campaign.observed_at, mode: campaign.mode, repetitions: experiment.repetitions });
      for (const error of campaign.errors ?? []) {
        const detail = { campaign_key: campaignKey, run_id: null, configuration_id: null, terminal_reason: null, attribution: error.attribution, phase: error.phase, code: error.code, retryable: error.retryable, message: error.message };
        campaignErrors.push(detail);
        db.prepare("INSERT INTO structured_errors VALUES (?, ?, ?, ?, ?, ?, ?)").run(campaignKey, null, error.phase, error.code, error.attribution, error.retryable ? 1 : 0, redactString(error.message, root));
      }

      let summaryVerifiable = true;
      const derivedSummary = { recorded_runs: 0, operational_successes: 0, quality_eligible_runs: 0, end_to_end_passes: 0, invalid_runs: 0 };
      for (const ref of campaign.runs) {
        const runPath = resolve(campaignDir, ref.path);
        let summaryRecorded = false;
        try {
          if (!within(campaignDir, runPath)) throw new SourceError("reference-invalid", "run reference escapes campaign");
          const run = await json(runPath);
          validateSchema(validator, "run-result", run, runPath, "schema-invalid-run");
          if (manifestDigest(run) !== ref.digest) throw new SourceError("digest-mismatch", "run digest does not match campaign reference");
          if (run.campaign_id !== campaign.campaign_id || run.run_id !== ref.run_id) throw new SourceError("reference-invalid", "run identity does not match campaign reference");
          if (!equal(run.experiment, campaign.experiment) || !equal(run.suite, campaign.suite)) throw new SourceError("reference-invalid", "run experiment/suite reference does not match campaign");
          derivedSummary.recorded_runs += 1;
          derivedSummary.operational_successes += run.terminal.operational_success === true ? 1 : 0;
          derivedSummary.quality_eligible_runs += run.evaluation?.eligible_for_quality_aggregate === true ? 1 : 0;
          derivedSummary.end_to_end_passes += run.evaluation?.end_to_end_passed === true ? 1 : 0;
          derivedSummary.invalid_runs += run.evaluation?.eligible_for_quality_aggregate === true ? 0 : 1;
          summaryRecorded = true;
          const suite = suiteMetadata.get(key(run.suite))!;
          const task = taskMetadata.get(key(run.task));
          if (!task || manifestDigest(task) !== run.task.spec_digest) throw new SourceError("reference-invalid", "run task reference/digest is invalid");
          const suiteTask = suite.tasks.find((entry: Json) => entry.id === run.task.id && entry.version === run.task.version);
          if (!suiteTask || suiteTask.spec_digest !== run.task.spec_digest || run.task.prompt_digest !== task.prompt.digest || run.task.initial_tree_digest !== task.problem_state.expected_tree_digest || run.task.evaluator_digest !== task.evaluator.digest) throw new SourceError("reference-invalid", "run task provenance does not match suite/task metadata");
          const declaredConfiguration = experiment.configurations.find((configuration: Json) => configuration.id === run.configuration_id);
          if (!declaredConfiguration) throw new SourceError("reference-invalid", "run configuration is not declared by experiment");
          const resolvedModel = run.resolved_configuration.model;
          const declaredModel = declaredConfiguration.model;
          const modelMatches = resolvedModel.provider === declaredModel.provider
            && resolvedModel.requested_id === declaredModel.requested_id
            && (declaredModel.expected_snapshot_id === undefined || (resolvedModel.snapshot_available === true && resolvedModel.resolved_id === declaredModel.expected_snapshot_id));
          if (!equal(run.resolved_configuration.harness, declaredConfiguration.harness) || !modelMatches || !equal(run.resolved_configuration.effort, declaredConfiguration.effort) || !equal(run.resolved_configuration.limits, declaredConfiguration.limits)) throw new SourceError("reference-invalid", "resolved run configuration does not match experiment declaration");

          let requestSeen = false;
          let evaluatorSeen = false;
          for (const artifact of run.artifacts ?? []) {
            const artifactPath = resolve(campaignDir, artifact.path);
            if (!within(campaignDir, artifactPath)) throw new SourceError("reference-invalid", `artifact path escapes campaign: ${artifact.path}`);
            const content = await readFile(artifactPath);
            if (`sha256:${sha256(content)}` !== artifact.digest || content.byteLength !== artifact.bytes) throw new SourceError("digest-mismatch", `artifact digest/size mismatch: ${artifact.path}`);
            if (artifact.kind === "request") {
              const request = JSON.parse(content.toString("utf8")) as Json;
              validateSchema(validator, "run-request", request, artifactPath, "schema-invalid-artifact");
              const requestChecks = {
                run_id: request.run_id === run.run_id,
                campaign_id: request.campaign_id === run.campaign_id,
                repetition: request.repetition === run.repetition,
                schedule_index: request.schedule_index === run.schedule_index,
                configuration_id: request.configuration.id === run.configuration_id,
                configuration: equal(request.configuration, declaredConfiguration),
                experiment: equal(request.experiment, run.experiment),
                suite: equal(request.suite, run.suite),
                task: equal(request.task, run.task),
                attempt: equal(request.attempt, run.attempt),
                execution: equal(request.execution, run.provenance.execution),
                digest: manifestDigest(request) === run.provenance.request_digest,
              };
              const requestMismatches = Object.entries(requestChecks).filter(([, matches]) => !matches).map(([field]) => field);
              if (requestMismatches.length > 0) throw new SourceError("reference-invalid", `request artifact does not match run: ${requestMismatches.join(", ")}`);
              requestSeen = true;
            }
            if (artifact.kind === "evaluator-result") {
              const evaluation = JSON.parse(content.toString("utf8")) as Json;
              validateSchema(validator, "evaluation", evaluation, artifactPath, "schema-invalid-artifact");
              if (evaluation.task_id !== run.task.id || evaluation.task_version !== run.task.version || manifestDigest(evaluation) !== run.evaluation.result_artifact_digest) throw new SourceError("reference-invalid", "evaluator artifact identity/digest does not match run");
              evaluatorSeen = true;
            }
          }
          if (!requestSeen || (run.evaluation.status === "ok" && !evaluatorSeen)) throw new SourceError("reference-invalid", "required request/evaluator artifact is missing");

          const metrics = run.metrics ?? {};
          const timing = metrics.timing ?? {};
          const tokens = metrics.tokens ?? {};
          const cost = metrics.cost ?? {};
          const resources = metrics.resources ?? {};
          const history = historyIdentity(campaign, run);
          const row = {
            campaign_id: campaign.campaign_id,
            campaign_key: campaignKey,
            run_id: run.run_id,
            repetition: run.repetition,
            observed_at: campaign.observed_at,
            mode: campaign.mode,
            repetitions: experiment.repetitions,
            experiment: experimentKey,
            configuration_id: run.configuration_id,
            configuration_key: `${experimentKey}:${run.configuration_id}`,
            task: key(run.task),
            task_weight: suiteTask.weight,
            category: task.category ?? "unknown",
            languages: task.languages ?? [],
            effort: run.resolved_configuration.effort.native_value ?? "unknown",
            errors: run.errors ?? [],
            attempt: run.attempt,
            terminal: run.terminal,
            evaluation: run.evaluation ?? {},
            metrics,
            history_identity: history.identity,
            history_reasons: history.reasons,
          };
          const runKey = `${campaignKey}:${run.run_id}`;
          db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runKey, campaignKey, run.run_id, run.configuration_id, row.task, row.category, JSON.stringify(row.languages), run.attempt.number, run.attempt.mode, run.terminal.reason, run.terminal.attribution, run.terminal.operational_success === true ? 1 : 0, run.evaluation?.eligible_for_quality_aggregate === true ? 1 : 0, metric(run.evaluation?.artifact_quality_score), run.evaluation?.end_to_end_passed === true ? 1 : 0, timing.status ?? "unavailable", metric(timing.wall_time_ms), tokens.status ?? "unavailable", metric(tokens.total), cost.status ?? "unavailable", metric(cost.amount), resources.status ?? "unavailable");
          for (const check of run.evaluation?.checks ?? []) db.prepare("INSERT INTO checks VALUES (?, ?, ?, ?, ?, ?)").run(runKey, check.id, metric(check.score), check.passed === true ? 1 : 0, metric(check.weight), check.required === true ? 1 : 0);
          for (const artifact of run.artifacts ?? []) db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?)").run(runKey, artifact.kind, portable(artifact.path), artifact.digest, artifact.bytes);
          for (const error of run.errors ?? []) db.prepare("INSERT INTO structured_errors VALUES (?, ?, ?, ?, ?, ?, ?)").run(campaignKey, run.run_id, error.phase, error.code, error.attribution, error.retryable ? 1 : 0, redactString(error.message, root));
          rows.push(row);
          if (run.attempt.number > 1) db.prepare("INSERT INTO lineage VALUES (?, ?, ?, ?)").run(campaignKey, run.run_id, run.attempt.parent_run_id ?? null, run.attempt.mode);
        } catch (error) {
          if (!summaryRecorded) summaryVerifiable = false;
          const detail = sourceError(error, "invalid-run");
          errors.push({ source: portable(relative(root, runPath)), ...detail });
        }
      }
      if (summaryVerifiable && !equal(campaign.summary, derivedSummary)) errors.push({ source: portable(relative(root, campaignPath)), code: "summary-mismatch", message: `campaign summary does not match referenced run results: expected ${JSON.stringify(derivedSummary)}` });
    }
    for (const error of errors) db.prepare("INSERT INTO ingestion_errors VALUES (?, ?, ?)").run(error.source, error.code, redactString(error.message, root));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK"); db.close(); throw error;
  }

  const initial = rows.filter(row => row.attempt.number === 1 && row.attempt.mode === "initial");
  const configurations = [...new Set(initial.map(row => row.configuration_key))].sort().map(configurationKey => {
    const attempts = initial.filter(row => row.configuration_key === configurationKey);
    const representative = attempts[0]!;
    const quality = attempts.filter(row => row.evaluation.eligible_for_quality_aggregate === true);
    return {
      configuration_key: configurationKey,
      experiment: representative.experiment,
      configuration_id: representative.configuration_id,
      recorded_attempts: attempts.length,
      quality_denominator: quality.length,
      headline_score: weightedSuiteHeadline(quality.map(row => ({ task: row.task, score: row.evaluation.artifact_quality_score, weight: row.task_weight }))),
      end_to_end_pass_rate: quality.length ? quality.filter(row => row.evaluation.end_to_end_passed === true).length / quality.length : null,
      operational_completion_rate: attempts.length ? attempts.filter(row => row.terminal.operational_success === true).length / attempts.length : null,
      invalid_or_infrastructure_attempts: attempts.filter(row => row.evaluation.eligible_for_quality_aggregate !== true).length,
      metric_completeness: {
        timing: attempts.filter(row => row.metrics.timing?.status === "complete").length,
        tokens: attempts.filter(row => row.metrics.tokens?.status === "complete").length,
        cost: attempts.filter(row => row.metrics.cost?.status === "complete").length,
        resources: attempts.filter(row => row.metrics.resources?.status === "complete").length,
      },
    };
  });

  const comparisons: Json[] = [];
  for (const experiment of experimentMetadata.values()) {
    const experimentKey = key(experiment);
    for (const plan of experiment.reporting.comparisons) for (const candidate of plan.candidate_configuration_ids) {
      const paired: Json[] = [];
      const baselines = initial.filter(row => row.experiment === experimentKey && row.configuration_id === plan.baseline_configuration_id && row.evaluation.eligible_for_quality_aggregate === true);
      for (const baseline of baselines) {
        const match = initial.find(row => row.experiment === experimentKey && row.campaign_key === baseline.campaign_key && row.configuration_id === candidate && row.task === baseline.task && row.repetition === baseline.repetition && row.evaluation.eligible_for_quality_aggregate === true);
        if (match) paired.push({ campaign_key: baseline.campaign_key, observed_at: baseline.observed_at, task: baseline.task, repetition: baseline.repetition, baseline: plan.baseline_configuration_id, candidate, baseline_score: baseline.evaluation.artifact_quality_score, candidate_score: match.evaluation.artifact_quality_score, score_delta: match.evaluation.artifact_quality_score - baseline.evaluation.artifact_quality_score });
      }
      paired.sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.campaign_key.localeCompare(right.campaign_key) || left.task.localeCompare(right.task) || left.repetition - right.repetition);
      comparisons.push({ id: plan.id, experiment: experimentKey, baseline: plan.baseline_configuration_id, candidate, direction: "candidate-minus-baseline", paired_task_deltas: paired, aggregate_score_delta: paired.length ? paired.reduce((total, item) => total + item.score_delta, 0) / paired.length : null, qualification: paired.length ? "declared candidate-minus-baseline paired task deltas; smoke only when sourced from one repetition" : "declared comparison has no scorable paired task observations" });
    }
  }

  const historyGroups = new Map<string, Json[]>();
  for (const row of initial) {
    const identity = canonicalJson(row.history_identity);
    const group = historyGroups.get(identity) ?? [];
    group.push(row); historyGroups.set(identity, group);
  }
  const historySeries = [...historyGroups.entries()].map(([identity, group]) => {
    const reasons = [...new Set(group.flatMap(row => row.history_reasons))].sort();
    const points = group.map(row => ({ observed_at: row.observed_at, campaign_key: row.campaign_key, configuration_key: row.configuration_key, configuration_id: row.configuration_id, task: row.task, score: row.evaluation.artifact_quality_score ?? null })).sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.campaign_key.localeCompare(right.campaign_key));
    return { series_id: `sha256:${sha256(identity)}`, compatibility_identity: JSON.parse(identity), connected_unqualified: reasons.length === 0, qualification_reasons: reasons, points };
  }).sort((left, right) => left.series_id.localeCompare(right.series_id));

  const telemetry = (row: Json, name: "timing" | "tokens" | "cost"): Json => {
    const observation = row.metrics[name] ?? { status: "unavailable", unavailable_reason: "not reported" };
    const value = name === "timing" ? metric(observation.wall_time_ms) : name === "tokens" ? metric(observation.total) : metric(observation.amount);
    return { status: observation.status ?? "unavailable", value: observation.status === "complete" ? value : null, qualification: observation.partial_reason ?? observation.unavailable_reason ?? (observation.status === "complete" ? null : "incomplete observation") };
  };
  const taskCategoryLanguage = initial.map(row => ({ task: row.task, category: row.category, languages: row.languages, configuration_key: row.configuration_key, configuration_id: row.configuration_id, score: row.evaluation.artifact_quality_score ?? null, passed: row.evaluation.end_to_end_passed === true, quality_eligible: row.evaluation.eligible_for_quality_aggregate === true }));
  const effortQuality = initial.map(row => ({ campaign_key: row.campaign_key, configuration_key: row.configuration_key, configuration_id: row.configuration_id, effort: row.effort, score: row.evaluation.artifact_quality_score ?? null, timing: telemetry(row, "timing"), tokens: telemetry(row, "tokens"), cost: telemetry(row, "cost") }));
  const operationalFailures = rows.filter(row => row.terminal.operational_success !== true).map(row => ({ campaign_key: row.campaign_key, run_id: row.run_id, configuration_key: row.configuration_key, configuration_id: row.configuration_id, headline_eligible: row.attempt.number === 1 && row.attempt.mode === "initial", terminal_reason: row.terminal.reason, attribution: row.terminal.attribution, evaluation_status: row.evaluation.status, evaluation_reason: row.evaluation.reason ?? null }));
  const errorDetails = [...campaignErrors, ...rows.flatMap(row => row.errors.map((error: Json) => ({ campaign_key: row.campaign_key, run_id: row.run_id, configuration_key: row.configuration_key, configuration_id: row.configuration_id, terminal_reason: row.terminal.reason, attribution: error.attribution, phase: error.phase, code: error.code, retryable: error.retryable, message: error.message })))];
  const lineage = rows.filter(row => row.attempt.number > 1).map(row => ({ campaign_key: row.campaign_key, run_id: row.run_id, configuration_key: row.configuration_key, configuration_id: row.configuration_id, task: row.task, attempt: row.attempt, excluded_from_headline: true }));
  const warnings: string[] = [];
  if (campaignRecords.some(campaign => campaign.repetitions === 1)) warnings.push("Smoke evidence has one repetition and is not suitable for confidence intervals or ranking.");
  warnings.push("Retries/resumes are visible but excluded from v0 headline aggregates.", "Unavailable or partial telemetry is qualified missing data, never zero.");
  const rawData = {
    report_data_version: REPORT_DATA_VERSION,
    generated_from: "immutable results/ source artifacts",
    warnings,
    campaigns: campaignRecords.sort((left, right) => left.campaign_key.localeCompare(right.campaign_key)),
    configurations,
    comparisons,
    operational_failures: operationalFailures,
    error_details: errorDetails,
    task_category_language: taskCategoryLanguage,
    effort_quality: effortQuality,
    resource_observations: initial.map(row => ({ campaign_key: row.campaign_key, configuration_key: row.configuration_key, configuration_id: row.configuration_id, status: row.metrics.resources?.status ?? "unavailable", observations: row.metrics.resources ?? null })),
    history_series: historySeries,
    ingestion_errors: errors,
    lineage,
  };
  const data = sanitize(rawData, root) as Json;
  const dataPath = join(output, "report-data.json");
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  const sections: Array<[string, unknown]> = [
    ["Paired task deltas", data.comparisons],
    ["Operational failures and ingestion errors", { failures: data.operational_failures, errors: data.error_details, ingestion_errors: data.ingestion_errors }],
    ["Task, category, and language drill-down", data.task_category_language],
    ["Effort and telemetry completeness", { effort_quality: data.effort_quality, resource_observations: data.resource_observations }],
    ["Historical compatibility and lineage", { history_series: data.history_series, lineage: data.lineage }],
    ["Metric completeness", data.configurations.map((configuration: Json) => ({ configuration_id: configuration.configuration_id, metric_completeness: configuration.metric_completeness }))],
  ];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Harness Test report</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.45rem;text-align:left}.warn{background:#fff4cc;padding:1rem}pre{white-space:pre-wrap}</style></head><body><h1>Agent Harness Test report</h1><p class="warn">${safe(data.warnings.join(" "))}</p><h2>Configuration metrics</h2><table><tr><th>Configuration</th><th>Headline score (quality denominator)</th><th>End-to-end pass</th><th>Operational completion</th><th>Invalid/infrastructure</th></tr>${data.configurations.map((configuration: Json) => `<tr><td>${safe(configuration.configuration_id)}</td><td>${configuration.headline_score ?? "unavailable"} (${configuration.quality_denominator})</td><td>${configuration.end_to_end_pass_rate ?? "unavailable"}</td><td>${configuration.operational_completion_rate ?? "unavailable"}</td><td>${configuration.invalid_or_infrastructure_attempts}</td></tr>`).join("")}</table>${sections.map(([heading, contents]) => `<h2>${safe(heading)}</h2><pre>${safe(JSON.stringify(contents, null, 2))}</pre>`).join("")}</body></html>`;
  const htmlPath = join(output, "index.html");
  await writeFile(htmlPath, html);
  db.close();
  return { database, data: dataPath, html: htmlPath, invalid: errors.length, runs: rows.length };
}
