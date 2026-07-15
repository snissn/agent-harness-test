#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { manifestDigest, sha256 } from "../src/digests.js";
import { codexRuntimeFingerprint } from "../src/codex-adapter.js";
import { RecordedCaptureAdapter } from "../src/offline-replay.js";
import { DeterministicRunner } from "../src/runner.js";
import { validateRepository } from "../src/repository.js";

const root = resolve(process.argv[2] ?? ".");
const captures = process.argv[3] ? resolve(process.argv[3]) : undefined;
const executable = process.argv[4] ? resolve(process.argv[4]) : undefined;
if (!captures || !executable) throw new Error("usage: finalize-codex-smoke <repository-root> <capture-root> <captured-codex-executable>");

const campaignId = "2026-07-15-codex-text-report-smoke";
const experiment = JSON.parse(await readFile(join(root, "experiments/codex-text-report-smoke/1.0.0.json"), "utf8"));
const suite = JSON.parse(await readFile(join(root, "suites/first-codex-slice/1.0.0.json"), "utf8"));
const task = JSON.parse(await readFile(join(root, "tasks/python-text-report/1.0.0/task.json"), "utf8"));
const prompt = await readFile(join(root, task.prompt.path), "utf8");
const { runtime_digest: runtimeDigest, executable_digest: executableDigest } = await codexRuntimeFingerprint(executable);
const execution = {
  mode: "host", isolation: "harness-sandbox", canonical: false,
  credential_protection: "short-lived",
  environment_digest: `sha256:${sha256("darwin-arm64 codex smoke capture")}`,
  operating_system: "darwin", architecture: "arm64",
};
const artifactTargets = {
  request: "request.json", run_result: "run.json", native_events: "events.native.jsonl",
  stdout: "stdout.log", stderr: "stderr.log", final_message: "final-message.txt",
  workspace_patch: "workspace.patch", workspace_tree: "workspace-tree.json", evaluator_result: "evaluator.json",
};
const ref = {
  experiment: { id: experiment.id, version: experiment.version, spec_path: "experiments/codex-text-report-smoke/1.0.0.json", spec_digest: manifestDigest(experiment) },
  suite: { id: suite.id, version: suite.version, spec_path: "suites/first-codex-slice/1.0.0.json", spec_digest: manifestDigest(suite) },
  task: {
    id: task.id, version: task.version, spec_path: "tasks/python-text-report/1.0.0/task.json", spec_digest: manifestDigest(task),
    prompt_digest: task.prompt.digest, initial_tree_digest: task.problem_state.expected_tree_digest, evaluator_digest: task.evaluator.digest,
  },
};
const argv = (effort: string) => ["codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", "/workspace", "--model", "gpt-5.6-sol", "--config", "approval_policy=\"never\"", "--config", `model_reasoning_effort=\"${effort}\"`, "--config", "sandbox_workspace_write.network_access=false", "-"];
const request = (configuration: Record<string, unknown>, scheduleIndex: number) => ({
  schema_version: "0.2.0", run_id: `codex-${String(configuration.id)}-r1`, campaign_id: campaignId,
  created_at: "2026-07-15T08:30:00.000Z", experiment: ref.experiment, suite: ref.suite, task: ref.task,
  repetition: 1, schedule_index: scheduleIndex, attempt: { number: 1, mode: "initial", initiated_by: "runner" },
  workspace: { path: "/workspace", prompt_path: task.prompt.path, prompt_digest: task.prompt.digest, initial_tree_digest: task.problem_state.expected_tree_digest },
  configuration, execution, network: task.environment.network,
  invocation: {
    runtime_source: "npm:@openai/codex", requested_runtime: "0.145.0-alpha.11", resolved_runtime_version: "0.145.0-alpha.11",
    runtime_digest: runtimeDigest, executable_digest: executableDigest, argv: argv((configuration.effort as Record<string, string>).native_value),
    working_directory: "/workspace", stdin_digest: task.prompt.digest,
    environment: [{ name: "LANG", classification: "public", source: "runner", value: "C.UTF-8" }], secret_names: [], full_access: false,
  }, artifact_targets: artifactTargets,
});

const campaignRoot = join(root, "results", experiment.id, campaignId);
await rm(campaignRoot, { recursive: true, force: true });
const runner = new DeterministicRunner();
const results = [] as Record<string, any>[];
for (const [index, configuration] of experiment.configurations.entries()) {
  const capture = join(captures, configuration.id === "codex-medium" ? "issue4-medium" : "issue4-high");
  results.push(await runner.run(request(configuration, index), {
    root, stateSource: join(root, task.problem_state.source.path), prompt,
    adapter: new RecordedCaptureAdapter(capture),
    evaluator: { evaluate: async () => JSON.parse(await readFile(join(capture, "evaluator.json"), "utf8")) },
    taskChecks: task.scoring.checks, scoringPolicy: task.scoring, actualExecution: execution,
    schemaDirectory: join(root, "spec/schemas"), runnerGitCommit: process.env.RUNNER_GIT_COMMIT!,
    runtimeRedactions: ["/private/tmp/issue4-medium", "/private/tmp/issue4-high", "/tmp/issue4-medium", "/tmp/issue4-high"],
  }));
  results[index] = JSON.parse(await readFile(join(campaignRoot, "runs", results[index]!.run_id, "run.json"), "utf8"));
}
const campaign = {
  schema_version: "0.2.0", campaign_id: campaignId, experiment: ref.experiment, suite: ref.suite, mode: experiment.mode,
  observed_at: results.at(-1)!.finished_at, started_at: results[0]!.started_at, finished_at: results.at(-1)!.finished_at, status: "completed",
  runner: { version: "0.2.0", git_commit: process.env.RUNNER_GIT_COMMIT!, runtime: results[0]!.provenance.runner_runtime },
  preflight: { started_at: "2026-07-15T08:29:00.000Z", finished_at: "2026-07-15T08:29:01.000Z", harness_runtimes: [{ harness_family: "codex", runtime_source: "npm:@openai/codex", requested_runtime: "0.145.0-alpha.11", resolved_runtime_version: "0.145.0-alpha.11", runtime_digest: runtimeDigest, executable_digest: executableDigest, acquisition: "cache-hit" }] },
  planned_run_count: 2,
  runs: results.map((run) => ({ run_id: run.run_id, path: `runs/${run.run_id}/run.json`, digest: manifestDigest(run) })),
  summary: { recorded_runs: 2, operational_successes: 2, quality_eligible_runs: 2, end_to_end_passes: 2, invalid_runs: 0 },
  labels: { evidence: "non-canonical-smoke", stability: "one-repetition-not-statistically-stable", finalization: "offline-replay-of-retained-captures" }, errors: [], warnings: [],
};
await mkdir(campaignRoot, { recursive: true });
await writeFile(join(campaignRoot, "campaign.json"), `${JSON.stringify(campaign)}\n`);
await validateRepository(root);
