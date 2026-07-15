import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DeterministicRunner, FakeHarnessAdapter, runWithHardTimeout, type TerminalReason } from "../src/runner.js";
import { manifestDigest, sha256, treeDigest } from "../src/digests.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const execFile = promisify(execFileCallback);
const schemas = join(root, "spec/schemas");
const resultRoot = (f: Awaited<ReturnType<typeof fixture>>) =>
  join(f.dir, "results/fake-experiment/fake-campaign/runs", f.request.run_id);
async function treeContains(root: string, needle: Buffer): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && (await treeContains(path, needle))) return true;
    if (entry.isFile() && (await readFile(path)).includes(needle)) return true;
  }
  return false;
}
async function metadataContains(root: string, secret: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.includes(secret)) return true;
    if (entry.isDirectory() && (await metadataContains(path, secret))) return true;
    if (entry.isSymbolicLink() && (await readlink(path)).includes(secret)) return true;
  }
  return false;
}

async function fixture(runId = "run-acceptance") {
  const dir = await mkdtemp(join(tmpdir(), "aht-acceptance-"));
  const state = join(dir, "state");
  await mkdir(state);
  await writeFile(join(state, "input.txt"), "input\n");
  const request = JSON.parse(await readFile(join(root, "spec/examples/run-request.example.json"), "utf8"));
  request.run_id = runId;
  request.campaign_id = "fake-campaign";
  request.experiment.id = "fake-experiment";
  request.workspace.initial_tree_digest = await treeDigest(state);
  request.task.initial_tree_digest = request.workspace.initial_tree_digest;
  request.configuration.harness = { family: "fake", interface: "test", adapter_id: "fake-adapter", adapter_version: "0.2.0", runtime_version: "0.2.0", config: {} };
  request.invocation.argv = ["fake"];
  request.task.prompt_digest = `sha256:${sha256("p")}`;
  request.workspace.prompt_digest = request.task.prompt_digest;
  request.invocation.stdin_digest = request.task.prompt_digest;
  return { dir, state, request };
}
function evaluator(request: any, checks = [{ id: "core", score: 1, passed: true }]) {
  return { evaluate: async () => ({ schema_version: "0.2.0", task_id: request.task.id, task_version: request.task.version, status: "ok", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:00Z", duration_ms: 0, checks }) };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, terminal: TerminalReason = "agent_completed", extra: Record<string, unknown> = {}) {
  return new DeterministicRunner().run(f.request, {
    root: f.dir, stateSource: f.state, prompt: "p", schemaDirectory: schemas,
    adapter: { run: async () => ({ terminal, events: [{ type: "native" }], exitCode: terminal === "agent_completed" ? 0 : 1 }) },
    evaluator: evaluator(f.request), taskChecks: [{ id: "core", weight: 1, required: true }],
    runnerGitCommit: "a11c51473cd5b41dd6bf32ba3ee72de16a8bf303", ...extra,
  });
}

test("schema-enabled terminal matrix preserves taxonomy, errors, and eligibility", async () => {
  const reasons: TerminalReason[] = ["agent_completed", "wall_time_exhausted", "token_limit_exhausted", "tool_limit_exhausted", "agent_failed", "provider_error", "harness_error", "environment_error", "runner_error", "cancelled"];
  for (const reason of reasons) {
    const f = await fixture(`run-${reason}`);
    try {
      const result = await run(f, reason);
      assert.equal(result.terminal.operational_success, reason === "agent_completed");
      assert.equal(result.terminal.attribution, { agent_completed: "agent", wall_time_exhausted: "runner", token_limit_exhausted: "runner", tool_limit_exhausted: "runner", agent_failed: "agent", provider_error: "provider", harness_error: "harness", environment_error: "environment", runner_error: "runner", cancelled: "operator" }[reason]);
      if (reason !== "agent_completed") assert.ok(result.errors.some((e: any) => e.phase === "agent" && e.attribution === result.terminal.attribution));
      const eligible = ["agent_completed", "agent_failed", "wall_time_exhausted", "token_limit_exhausted", "tool_limit_exhausted"].includes(reason);
      assert.equal(result.evaluation.eligible_for_quality_aggregate, eligible);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test("schema-enabled evaluator and adapter failures remain structured and never score infrastructure", async () => {
  const invalidOutputs = [[], [{ id: "core", score: 1, passed: true }, { id: "core", score: 1, passed: true }], [{ id: "unknown", score: 1, passed: true }], [{ id: "core", score: 2, passed: true }]];
  for (const checks of invalidOutputs) {
    const f = await fixture(`run-invalid-${invalidOutputs.indexOf(checks)}`);
    try {
      const result = await run(f, "agent_completed", { evaluator: evaluator(f.request, checks) });
      assert.equal(result.evaluation.status, "error");
      assert.equal(result.evaluation.eligible_for_quality_aggregate, false);
      assert.ok(result.errors.some((e: any) => e.phase === "evaluation"));
      assert.equal(JSON.parse(await readFile(join(resultRoot(f), "evaluator.json"), "utf8")).status, "error");
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
  const rejected = await fixture("run-rejected");
  try {
    const result = await run(rejected, "agent_completed", { adapter: { run: async () => { throw new Error("adapter rejected"); } } });
    assert.equal(result.terminal.reason, "runner_error");
    assert.ok(result.errors.some((e: any) => e.phase === "agent" && /adapter rejected/.test(e.message)));
  } finally { await rm(rejected.dir, { recursive: true, force: true }); }
  const missing = await fixture("run-no-workspace");
  try {
    await rm(missing.state, { recursive: true });
    const result = await run(missing);
    assert.equal(result.evaluation.status, "not-run");
    assert.deepEqual(result.artifacts.map((a: any) => a.kind), ["request", "native-events", "stdout", "stderr", "final-message"]);
    assert.ok(await readFile(join(resultRoot(missing), "run.json")));
  } finally { await rm(missing.dir, { recursive: true, force: true }); }
  const unsafeExperiment = await fixture("run-safe-experiment");
  try {
    unsafeExperiment.request.experiment.id = "../escape";
    await assert.rejects(run(unsafeExperiment, "agent_completed", { schemaDirectory: undefined }), /single safe path components/);
    assert.equal(await lstat(join(unsafeExperiment.dir, "results")).then(() => true).catch(() => false), false);
  } finally { await rm(unsafeExperiment.dir, { recursive: true, force: true }); }
});

test("schema-enabled materialization digest mismatch retains evidence without evaluator success", async () => {
  const f = await fixture("run-unverified-materialization");
  try {
    f.request.workspace.initial_tree_digest = `tree-sha256-v1:${"f".repeat(64)}`;
    let evaluated = false;
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir, stateSource: f.state, prompt: "p", schemaDirectory: schemas,
      runnerGitCommit: "3bea225008b4972d547dc58f71273966b278f885",
      adapter: { run: async () => ({ terminal: "agent_completed" }) },
      evaluator: { evaluate: async () => { evaluated = true; return {}; } },
      taskChecks: [{ id: "core", weight: 1, required: true }],
    });
    assert.equal(result.terminal.reason, "environment_error");
    assert.equal(result.evaluation.status, "not-run");
    assert.equal(result.evaluation.eligible_for_quality_aggregate, false);
    assert.equal(evaluated, false);
    assert.equal(await lstat(join(resultRoot(f), "evaluator.json")).then(() => true).catch(() => false), false);
    assert.ok(result.artifacts.some((artifact: any) => artifact.kind === "workspace-tree"));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("hard timeout snapshots partial capture and clears timers without late mutation", async () => {
  const f = await fixture("run-late-timeout");
  let lateDone!: () => void;
  const late = new Promise<void>((resolve) => { lateDone = resolve; });
  let clears = 0;
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir, stateSource: f.state, prompt: "p", schemaDirectory: schemas, runnerGitCommit: "a11c51473cd5b41dd6bf32ba3ee72de16a8bf303",
      adapter: { terminate: async () => undefined, run: async (input) => {
        input.capture?.event({ type: "partial" }); input.capture?.stdout("partial stdout\n");
        await new Promise((resolve) => setTimeout(resolve, 15));
        await writeFile(join(input.workspace, "late.txt"), "late").catch(() => undefined);
        lateDone();
        return { terminal: "agent_completed", stdout: "late stdout" };
      } },
      evaluator: evaluator(f.request), taskChecks: [{ id: "core", weight: 1, required: true }],
      timer: { set: (_ms, cb) => { queueMicrotask(cb); return 1; }, clear: () => { clears += 1; } },
    });
    const evidence = resultRoot(f);
    const before = await Promise.all(["workspace-tree.json", "workspace.patch", "run.json"].map((name) => readFile(join(evidence, name))));
    await late;
    const after = await Promise.all(["workspace-tree.json", "workspace.patch", "run.json"].map((name) => readFile(join(evidence, name))));
    assert.deepEqual(after, before);
    assert.match(await readFile(join(evidence, "events.native.jsonl"), "utf8"), /partial/);
    assert.match(await readFile(join(evidence, "stdout.log"), "utf8"), /partial stdout/);
    assert.equal(await lstat(join(evidence, "workspace", "late.txt")).then(() => true).catch(() => false), false);
    assert.ok(clears >= 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
  for (const adapter of [{ run: async () => ({ terminal: "agent_completed" as const }) }, { run: async () => { throw new Error("reject"); } }]) {
    let cleared = 0;
    await runWithHardTimeout(adapter, { workspace: ".", prompt: "", request: {}, signal: new AbortController().signal }, 100, { set: () => 1, clear: () => { cleared += 1; } }).catch(() => undefined);
    assert.equal(cleared, 1);
  }
  const terminationNeverSettles = await Promise.race([
    runWithHardTimeout({ run: async () => await new Promise<any>(() => undefined), terminate: async () => await new Promise<void>(() => undefined) }, { workspace: ".", prompt: "", request: {}, signal: new AbortController().signal }, 0),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout was blocked by terminate")), 50)),
  ]);
  assert.equal(terminationNeverSettles.terminal, "wall_time_exhausted");
  assert.equal((terminationNeverSettles.events?.[0] as any).termination_requested, true);
  const fakeWorkspace = await mkdtemp(join(tmpdir(), "aht-fake-timeout-"));
  try {
    const fakeTimeout = await runWithHardTimeout(new FakeHarnessAdapter("timeout"), { workspace: fakeWorkspace, prompt: "", request: {}, signal: new AbortController().signal }, 5);
    assert.equal(fakeTimeout.terminal, "wall_time_exhausted");
  } finally { await rm(fakeWorkspace, { recursive: true, force: true }); }
});

test("whole-attempt secret redaction and workspace tree metadata are durable", async () => {
  const f = await fixture("run-secret-tree");
  const secret = "RUNTIME_SECRET_SENTINEL";
  let evaluatorSawOriginalWorkspace = false;
  try {
    await writeFile(join(f.state, "tool"), "#!/bin/sh\n"); await chmod(join(f.state, "tool"), 0o755); await symlink("tool", join(f.state, "tool-link"));
    await mkdir(join(f.state, ".git")); await writeFile(join(f.state, ".git", "internal"), "not evidence\n");
    f.request.workspace.initial_tree_digest = await treeDigest(f.state); f.request.task.initial_tree_digest = f.request.workspace.initial_tree_digest;
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir, stateSource: f.state, prompt: "p", schemaDirectory: schemas, runnerGitCommit: "a11c51473cd5b41dd6bf32ba3ee72de16a8bf303", runtimeRedactions: [secret],
      adapter: { run: async (input) => { const nested = join(input.workspace, "nested", `${secret}-dir`); await mkdir(nested, { recursive: true }); await writeFile(join(nested, `${secret}-file.bin`), Buffer.from(`binary:${secret}:payload`)); await symlink(`${secret}-file.bin`, join(nested, `${secret}-link`)); input.capture?.event({ secret }); input.capture?.stdout(secret); return { terminal: "provider_error", stdout: secret, stderr: secret, finalMessage: secret }; } },
      evaluator: { evaluate: async ({ workspace }) => { const nested = join(workspace, "nested", `${secret}-dir`); evaluatorSawOriginalWorkspace = (await readFile(join(nested, `${secret}-file.bin`))).includes(Buffer.from(secret)); return { schema_version: "0.2.0", task_id: f.request.task.id, task_version: f.request.task.version, status: "ok", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:00Z", duration_ms: 0, checks: [{ id: "core", score: 1, passed: true, message: secret, details: { secret } }] }; } }, taskChecks: [{ id: "core", weight: 1, required: true }],
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(evaluatorSawOriginalWorkspace, true);
    assert.equal(await treeContains(resultRoot(f), Buffer.from(secret)), false);
    assert.equal(await metadataContains(join(resultRoot(f), "workspace"), secret), false);
    const persistedEvaluator = JSON.parse(await readFile(join(resultRoot(f), "evaluator.json"), "utf8"));
    assert.equal(result.evaluation.result_artifact_digest, manifestDigest(persistedEvaluator));
    const files = await readdir(resultRoot(f));
    for (const file of files) if ((await lstat(join(resultRoot(f), file))).isFile()) assert.equal((await readFile(join(resultRoot(f), file), "utf8")).includes(secret), false, file);
    const entries = JSON.parse(await readFile(join(resultRoot(f), "workspace-tree.json"), "utf8")).entries;
    assert.deepEqual(entries.find((entry: any) => entry.path === "tool"), { type: "file", path: "tool", mode: "executable", bytes: 10, digest: `sha256:${sha256("#!/bin/sh\n")}` });
    assert.deepEqual(entries.find((entry: any) => entry.path === "tool-link"), { type: "symlink", path: "tool-link", target: "tool" });
    assert.equal(entries.some((entry: any) => String(entry.path).startsWith(".git")), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("fake runner CLI subprocess preserves finalized parent facts and recovery lineage", async () => {
  const f = await fixture("run-cli-parent");
  const output = join(f.dir, "out");
  try {
    const prompt = "fake fixture";
    f.request.task.prompt_digest = `sha256:${sha256(prompt)}`; f.request.workspace.prompt_digest = f.request.task.prompt_digest; f.request.invocation.stdin_digest = f.request.task.prompt_digest;
    const requestFile = join(f.dir, "request.json"); await writeFile(requestFile, JSON.stringify(f.request));
    const invoke = async (...args: string[]) => execFile("npm", ["run", "runner:fake", "--", ...args], { cwd: root });
    await invoke(requestFile, f.state, output);
    const parentDir = join(output, "results/fake-experiment/fake-campaign/runs/run-cli-parent");
    const parentRequest = await readFile(join(parentDir, "request.json")); const parentResult = await readFile(join(parentDir, "run.json"));
    const persisted = JSON.parse(parentResult.toString());
    assert.equal(persisted.provenance.runner_git_commit, (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim());
    assert.deepEqual(persisted.provenance.execution, f.request.execution);
    const inspect = await invoke("inspect", parentDir); assert.equal(JSON.parse(inspect.stdout.trim().split("\n").at(-1)!).finalized, true);
    await assert.rejects(invoke("inspect", join(f.dir, "missing")), (error: any) => error.code === 2);
    await invoke("recover", join(parentDir, "request.json"), join(parentDir, "run.json"), f.state, output, "retry", "run-cli-retry", "diagnosis");
    await invoke("recover", join(parentDir, "request.json"), join(parentDir, "run.json"), f.state, output, "resume", "run-cli-resume", "diagnosis");
    assert.deepEqual(await readFile(join(parentDir, "request.json")), parentRequest); assert.deepEqual(await readFile(join(parentDir, "run.json")), parentResult);
    const mismatchedResult = join(f.dir, "mismatched-run.json");
    await writeFile(mismatchedResult, JSON.stringify({ ...JSON.parse(parentResult.toString()), run_id: "wrong" }));
    const badDigest = join(f.dir, "bad-digest-run.json");
    await writeFile(badDigest, JSON.stringify({ ...persisted, provenance: { ...persisted.provenance, request_digest: `sha256:${"0".repeat(64)}` } }));
    for (const args of [["recover", join(parentDir, "request.json"), join(parentDir, "run.json"), f.state, output, "retry", "../unsafe", "x"], ["recover", join(parentDir, "request.json"), join(parentDir, "run.json"), f.state, output, "retry", "run-cli-retry", "x"], ["recover", join(parentDir, "request.json"), mismatchedResult, f.state, output, "retry", "run-cli-mismatch", "x"], ["recover", join(parentDir, "request.json"), badDigest, f.state, output, "retry", "run-cli-bad-digest", "x"]]) await assert.rejects(invoke(...args), (error: any) => error.code === 1);
    await assert.rejects(invoke(requestFile, f.state, output), (error: any) => error.code === 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
