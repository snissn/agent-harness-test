import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { manifestDigest, sha256 } from "./digests.js";
import { SchemaValidator } from "./schema.js";

type Json = Record<string, any>;
export const REPORT_DATA_VERSION = "0.1.0";

async function json(path: string): Promise<Json> { return JSON.parse(await readFile(path, "utf8")) as Json; }
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else found.push(path);
    }
  }
  await walk(root); return found;
}
function metric(value: unknown): number | null { return typeof value === "number" ? value : null; }
function safe(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]!); }

export interface RebuildResult { database: string; data: string; html: string; invalid: number; runs: number; }

/** Rebuilds a disposable projection. Source artifacts are never modified. */
export async function rebuildReport(rootInput: string, outputInput = "reports"): Promise<RebuildResult> {
  const root = resolve(rootInput), output = resolve(root, outputInput), results = join(root, "results");
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  const database = join(output, "index.sqlite"), db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE campaigns (id TEXT PRIMARY KEY, observed_at TEXT, mode TEXT, suite_key TEXT, status TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, campaign_id TEXT, configuration_id TEXT, task_key TEXT, category TEXT, languages TEXT, attempt_number INTEGER, attempt_mode TEXT, terminal_reason TEXT, attribution TEXT, operational_success INTEGER, quality_eligible INTEGER, score REAL, end_to_end_passed INTEGER, timing_status TEXT, timing_ms INTEGER, tokens_status TEXT, tokens_total INTEGER, cost_status TEXT, cost REAL, resources_status TEXT);
CREATE TABLE ingestion_errors (source TEXT, code TEXT, message TEXT);
CREATE TABLE lineage (run_id TEXT, parent_run_id TEXT, attempt_mode TEXT);`);
  const validator = await SchemaValidator.create(join(root, "spec/schemas"));
  const campaignFiles = (await files(results)).filter(path => path.endsWith("/campaign.json")).sort();
  const errors: Json[] = [], rows: Json[] = [];
  const taskMetadata = new Map<string, Json>();
  for (const path of (await files(join(root, "tasks"))).filter(path => /\/task\.json$/.test(path))) { const task = await json(path); taskMetadata.set(`${task.id}@${task.version}`, task); }
  for (const campaignPath of campaignFiles) {
    let campaign: Json;
    try { campaign = await json(campaignPath); validator.validate("campaign", campaign, campaignPath); }
    catch (error) { errors.push({ source: relative(root, campaignPath), code: "invalid-campaign", message: String(error).replaceAll(root, "[REPOSITORY]") }); continue; }
    const campaignDir = resolve(campaignPath, "..");
    db.prepare("INSERT INTO campaigns VALUES (?, ?, ?, ?, ?)").run(campaign.campaign_id, campaign.observed_at, campaign.mode, `${campaign.suite.id}@${campaign.suite.version}`, campaign.status);
    for (const ref of campaign.runs) {
      const runPath = resolve(campaignDir, ref.path);
      try {
        if (!runPath.startsWith(`${campaignDir}/`)) throw new Error("run reference escapes campaign");
        const run = await json(runPath); validator.validate("run-result", run, runPath);
        if (manifestDigest(run) !== ref.digest) throw new Error("run digest does not match campaign reference");
        if (run.campaign_id !== campaign.campaign_id || run.run_id !== ref.run_id) throw new Error("run identity does not match campaign reference");
        for (const artifact of run.artifacts ?? []) {
          const artifactPath = resolve(campaignDir, artifact.path);
          if (!artifactPath.startsWith(`${campaignDir}/`)) throw new Error(`artifact path escapes campaign: ${artifact.path}`);
          if (`sha256:${sha256(await readFile(artifactPath))}` !== artifact.digest) throw new Error(`artifact digest mismatch: ${artifact.path}`);
        }
        const task = taskMetadata.get(`${run.task.id}@${run.task.version}`) ?? {};
        const evaluation = run.evaluation ?? {}, metrics = run.metrics ?? {}, timing = metrics.timing ?? {}, tokens = metrics.tokens ?? {}, cost = metrics.cost ?? {}, resources = metrics.resources ?? {};
        const row = { campaign_id: campaign.campaign_id, observed_at: campaign.observed_at, mode: campaign.mode, configuration_id: run.configuration_id, task: `${run.task.id}@${run.task.version}`, category: task.category ?? "unknown", languages: task.languages ?? [], attempt: run.attempt, terminal: run.terminal, evaluation, metrics, compatible_key: JSON.stringify({ suite: campaign.suite, task: run.task, harness: run.resolved_configuration.harness, model: run.resolved_configuration.model, effort: run.resolved_configuration.effort, topology: run.provenance.execution }) };
        rows.push(row);
        db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(run.run_id, campaign.campaign_id, run.configuration_id, row.task, row.category, JSON.stringify(row.languages), run.attempt.number, run.attempt.mode, run.terminal.reason, run.terminal.attribution, Number(run.terminal.operational_success), Number(evaluation.eligible_for_quality_aggregate), metric(evaluation.artifact_quality_score), Number(evaluation.end_to_end_passed === true), timing.status ?? "unavailable", metric(timing.wall_time_ms), tokens.status ?? "unavailable", metric(tokens.total), cost.status ?? "unavailable", metric(cost.amount), resources.status ?? "unavailable");
        if (run.attempt.number > 1) db.prepare("INSERT INTO lineage VALUES (?, ?, ?)").run(run.run_id, run.attempt.parent_run_id ?? null, run.attempt.mode);
      } catch (error) { errors.push({ source: relative(root, runPath), code: "invalid-run", message: String(error).replaceAll(root, "[REPOSITORY]") }); }
    }
  }
  for (const error of errors) db.prepare("INSERT INTO ingestion_errors VALUES (?, ?, ?)").run(error.source, error.code, error.message);
  const initial = rows.filter(row => row.attempt.number === 1 && row.attempt.mode === "initial");
  const configs = [...new Set(initial.map(row => row.configuration_id))].sort().map(configuration_id => {
    const set = initial.filter(row => row.configuration_id === configuration_id), quality = set.filter(row => row.evaluation.eligible_for_quality_aggregate === true);
    return { configuration_id, recorded_attempts: set.length, quality_denominator: quality.length, headline_score: quality.length ? quality.reduce((n, row) => n + row.evaluation.artifact_quality_score, 0) / quality.length : null, end_to_end_pass_rate: quality.length ? quality.filter(row => row.evaluation.end_to_end_passed).length / quality.length : null, operational_completion_rate: set.length ? set.filter(row => row.terminal.operational_success).length / set.length : null, invalid_or_infrastructure_attempts: set.filter(row => !row.evaluation.eligible_for_quality_aggregate).length, metric_completeness: { timing: set.filter(row => row.metrics.timing?.status === "complete").length, tokens: set.filter(row => row.metrics.tokens?.status === "complete").length, cost: set.filter(row => row.metrics.cost?.status === "complete").length, resources: set.filter(row => row.metrics.resources?.status !== "unavailable").length } };
  });
  const comparisons: Json[] = []; for (const baseline of configs) for (const candidate of configs) if (baseline.configuration_id < candidate.configuration_id) {
    const paired = initial.filter(row => row.configuration_id === baseline.configuration_id && row.evaluation.eligible_for_quality_aggregate).flatMap(left => initial.filter(right => right.configuration_id === candidate.configuration_id && right.evaluation.eligible_for_quality_aggregate && right.task === left.task && right.compatible_key === left.compatible_key).map(right => ({ task: left.task, baseline: baseline.configuration_id, candidate: candidate.configuration_id, score_delta: right.evaluation.artifact_quality_score - left.evaluation.artifact_quality_score })));
    comparisons.push({ baseline: baseline.configuration_id, candidate: candidate.configuration_id, paired_task_deltas: paired, qualification: paired.length ? "paired compatible task observations; smoke only" : "no compatible scorable paired task observations" });
  }
  const data = { report_data_version: REPORT_DATA_VERSION, generated_from: "immutable results/ source artifacts", warnings: ["Smoke evidence has one repetition and is not suitable for confidence intervals or ranking.", "Retries/resumes are visible but excluded from v0 headline aggregates.", "Unavailable telemetry is missing, not zero."], campaigns: [...new Set(rows.map(row => row.campaign_id))].sort(), configurations: configs, comparisons, operational_failures: initial.filter(row => !row.terminal.operational_success).map(row => ({ configuration_id: row.configuration_id, terminal_reason: row.terminal.reason, attribution: row.terminal.attribution, errors: row.evaluation.reason ?? "no evaluation" })), history: rows.map(row => ({ observed_at: row.observed_at, campaign_id: row.campaign_id, configuration_id: row.configuration_id, task: row.task, score: row.evaluation.artifact_quality_score ?? null, compatibility: "qualified: model snapshot unavailable and local topology" })), ingestion_errors: errors, lineage: rows.filter(row => row.attempt.number > 1).map(row => ({ configuration_id: row.configuration_id, task: row.task, attempt: row.attempt })) };
  const dataPath = join(output, "report-data.json"); await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  const html = `<!doctype html><meta charset="utf-8"><title>Agent Harness Test report</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.45rem;text-align:left}.warn{background:#fff4cc;padding:1rem}</style><h1>Agent Harness Test report</h1><p class="warn">${safe(data.warnings.join(" "))}</p><h2>Configuration metrics</h2><table><tr><th>Configuration</th><th>Headline score (quality denominator)</th><th>End-to-end pass</th><th>Operational completion</th><th>Invalid/infrastructure</th></tr>${configs.map(c => `<tr><td>${safe(c.configuration_id)}</td><td>${c.headline_score ?? "unavailable"} (${c.quality_denominator})</td><td>${c.end_to_end_pass_rate ?? "unavailable"}</td><td>${c.operational_completion_rate ?? "unavailable"}</td><td>${c.invalid_or_infrastructure_attempts}</td></tr>`).join("")}</table><h2>Paired task deltas</h2><pre>${safe(JSON.stringify(comparisons, null, 2))}</pre><h2>Operational failures and ingestion errors</h2><pre>${safe(JSON.stringify({ failures: data.operational_failures, ingestion_errors: errors }, null, 2))}</pre>`;
  const htmlPath = join(output, "index.html"); await writeFile(htmlPath, html);
  db.close(); return { database, data: dataPath, html: htmlPath, invalid: errors.length, runs: rows.length };
}
