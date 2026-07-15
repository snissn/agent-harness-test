import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  AttemptState,
  DeterministicRunner,
  deriveDiagnosticAttempt,
  FakeHarnessAdapter,
  RunnerError,
  atomicWrite,
  runWithHardTimeout,
} from "../src/runner.js";
import { sha256, treeDigest } from "../src/digests.js";
import { RecordedCaptureAdapter } from "../src/offline-replay.js";

const root = fileURLToPath(new URL("..", import.meta.url));
process.env.RUNNER_GIT_COMMIT = "cf40646";
async function fixture(
  scenario: ConstructorParameters<typeof FakeHarnessAdapter>[0] = "success",
) {
  const dir = await mkdtemp(join(tmpdir(), "aht-runner-")),
    state = join(dir, "state");
  await mkdir(state);
  await writeFile(join(state, "input.txt"), "input\n");
  const request = JSON.parse(
    await readFile(
      join(root, "spec/examples/run-request.example.json"),
      "utf8",
    ),
  );
  request.run_id = `run-${scenario}`;
  request.campaign_id = "fake-campaign";
  request.experiment.id = "fake-experiment";
  request.workspace.initial_tree_digest = await treeDigest(state);
  request.task.initial_tree_digest = request.workspace.initial_tree_digest;
  request.workspace.path = "workspace";
  request.configuration.harness = {
    family: "fake",
    interface: "test",
    adapter_id: "fake-adapter",
    adapter_version: "0.2.0",
    runtime_version: "0.2.0",
    config: {},
  };
  request.invocation.argv = ["fake"];
  request.invocation.working_directory = "workspace";
  request.task.prompt_digest = `sha256:${sha256("p")}`;
  request.workspace.prompt_digest = request.task.prompt_digest;
  request.invocation.stdin_digest = request.task.prompt_digest;
  const evaluator = {
    evaluate: async () => ({
      schema_version: "0.2.0",
      task_id: request.task.id,
      task_version: request.task.version,
      status: "ok",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:00Z",
      duration_ms: 0,
      checks: [{ id: "core", score: 1, passed: true }],
    }),
  };
  return {
    dir,
    state,
    request,
    evaluator,
    adapter: new FakeHarnessAdapter(scenario),
  };
}
test("M0 state and immutable artifacts fail closed", async () => {
  const s = new AttemptState();
  assert.throws(() => s.transition("running"), RunnerError);
  s.transition("request-finalized");
  s.transition("materialized");
  s.transition("running");
  s.transition("captured");
  s.finalize();
  assert.throws(() => s.finalize(), /cannot transition/);
  const d = await mkdtemp(join(tmpdir(), "atomic-"));
  try {
    await atomicWrite(join(d, "a"), "one");
    await assert.rejects(atomicWrite(join(d, "a"), "two"));
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("M0 finalization is legal only from captured/evaluated and atomic publication never replaces", async () => {
  const s = new AttemptState();
  assert.throws(() => s.finalize(), /cannot transition/);
  s.transition("request-finalized");
  s.transition("materialized");
  s.transition("running");
  s.transition("captured");
  s.finalize();
  const d = await mkdtemp(join(tmpdir(), "atomic-race-"));
  try {
    await Promise.allSettled([
      atomicWrite(join(d, "x"), "one"),
      atomicWrite(join(d, "x"), "two"),
    ]);
    assert.equal(
      (await readFile(join(d, "x"), "utf8")) === "one" ||
        (await readFile(join(d, "x"), "utf8")) === "two",
      true,
    );
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("hard timeout wins when an adapter ignores cooperative abort and invokes process termination", async () => {
  let terminated = false;
  const adapter = {
    run: async () => await new Promise<any>(() => undefined),
    terminate: async () => {
      terminated = true;
    },
  };
  const result = await runWithHardTimeout(
    adapter,
    {
      workspace: ".",
      prompt: "",
      request: {},
      signal: new AbortController().signal,
    },
    0,
  );
  assert.equal(result.terminal, "wall_time_exhausted");
  assert.equal(terminated, true);
});
test("M1-M3 request, fake capture, evaluation and immutable result", async () => {
  const f = await fixture();
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter: f.adapter,
      evaluator: f.evaluator,
      taskChecks: [{ id: "core", weight: 1, required: true }],
      schemaDirectory: join(root, "spec/schemas"),
    });
    assert.equal(result.terminal.reason, "agent_completed");
    assert.equal(result.evaluation.artifact_quality_score, 1);
    assert.equal(
      JSON.parse(
        await readFile(
          join(
            f.dir,
            "results/fake-experiment/fake-campaign/runs/run-success/run.json",
          ),
          "utf8",
        ),
      ).artifacts.length,
      8,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("offline replay selects only final workspace files and redacts local event paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aht-replay-"));
  try {
    const capture = join(dir, "capture"), workspace = join(dir, "workspace");
    await mkdir(capture);
    await Promise.all([
      writeFile(join(capture, "text_report.py"), "done\n"),
      writeFile(join(capture, "sample.txt"), "sample\n"),
      writeFile(join(capture, "filter.txt"), "filter\n"),
      writeFile(join(capture, "stderr.txt"), ""),
      writeFile(join(capture, "exit-code"), "0"),
      writeFile(join(capture, "evaluator.json"), "{}"),
      writeFile(join(capture, "native.jsonl"), `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "at /tmp/local-work" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1 } })}\n`),
    ]);
    const result = await new RecordedCaptureAdapter(capture).run({ workspace, prompt: "", request: {}, signal: new AbortController().signal });
    assert.equal(result.finalMessage?.includes("/tmp"), false);
    assert.deepEqual((await (await import("node:fs/promises")).readdir(workspace)).sort(), ["filter.txt", "sample.txt", "text_report.py"]);
    assert.equal((result.events![0] as any).item.text.includes("/tmp"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("runner can record unavailable timing without replay milliseconds", async () => {
  const f = await fixture();
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir, stateSource: f.state, prompt: "p", adapter: f.adapter, evaluator: f.evaluator,
      taskChecks: [{ id: "core", weight: 1, required: true }], schemaDirectory: join(root, "spec/schemas"),
      timing: { status: "unavailable", source: "offline-replay", unavailable_reason: "no captured monotonic clock" },
    });
    assert.deepEqual(result.metrics.timing, { status: "unavailable", source: "offline-replay", unavailable_reason: "no captured monotonic clock" });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test("M2 timeout preserves partial work and still evaluates it", async () => {
  const f = await fixture("timeout");
  try {
    const timer = {
      set: (_ms: number, cb: () => void) => {
        queueMicrotask(cb);
        return 1;
      },
      clear: () => undefined,
    };
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter: f.adapter,
      evaluator: f.evaluator,
      taskChecks: [{ id: "core", weight: 1, required: true }],
      timer,
    });
    assert.equal(result.terminal.reason, "wall_time_exhausted");
    assert.equal(result.evaluation.status, "ok");
    assert.equal(result.metrics.tokens.status, "unavailable");
    assert.ok(
      await readFile(
        join(
          f.dir,
          "results/fake-experiment/fake-campaign/runs/run-timeout/workspace/fake-harness.txt",
        ),
      ),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("M1 digest mismatch prevents harness launch with environment attribution", async () => {
  const f = await fixture();
  f.request.workspace.initial_tree_digest = `tree-sha256-v1:${"f".repeat(64)}`;
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter: f.adapter,
      evaluator: f.evaluator,
      taskChecks: [{ id: "core", weight: 1, required: true }],
    });
    assert.equal(result.terminal.reason, "environment_error");
    assert.equal(result.errors[0].attribution, "environment");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("M3 errors never fabricate a score and persisted secret sentinels are redacted", async () => {
  const f = await fixture("provider-error");
  f.request.invocation.secret_names = ["TOP_SECRET"];
  const adapter = {
    run: async (input: Parameters<FakeHarnessAdapter["run"]>[0]) => ({
      ...(await f.adapter.run(input)),
      stderr: "TOP_SECRET",
    }),
  };
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter,
      evaluator: {
        evaluate: async () => {
          throw new Error("broken evaluator TOP_SECRET");
        },
      },
      taskChecks: [{ id: "core", weight: 1, required: true }],
      runtimeRedactions: ["TOP_SECRET"],
    });
    assert.equal(result.terminal.attribution, "provider");
    assert.equal(result.evaluation.status, "error");
    assert.equal(JSON.stringify(result).includes("TOP_SECRET"), false);
    assert.match(
      await readFile(
        join(
          f.dir,
          "results/fake-experiment/fake-campaign/runs/run-provider-error/stderr.log",
        ),
        "utf8",
      ),
      /\[REDACTED\]/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("request is retained unchanged and evaluator mutation cannot alter retained workspace", async () => {
  const f = await fixture();
  const original = JSON.stringify(f.request);
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter: f.adapter,
      evaluator: {
        evaluate: async ({ workspace }) => {
          await writeFile(join(workspace, "input.txt"), "evaluator mutation\n");
          return {
            schema_version: "0.2.0",
            task_id: f.request.task.id,
            task_version: f.request.task.version,
            status: "ok",
            started_at: "2026-01-01T00:00:00Z",
            finished_at: "2026-01-01T00:00:00Z",
            duration_ms: 0,
            checks: [{ id: "core", score: 1, passed: true }],
          };
        },
      },
      taskChecks: [{ id: "core", weight: 1, required: true }],
    });
    assert.equal(JSON.stringify(f.request), original);
    assert.equal(result.evaluation.status, "ok");
    assert.equal(
      await readFile(
        join(
          f.dir,
          "results/fake-experiment/fake-campaign/runs/run-success/workspace/input.txt",
        ),
        "utf8",
      ),
      "input\n",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("runner rejects unsafe identifiers, escaped targets, and false execution topology before launch", async () => {
  for (const mutate of [
    (request: any) => (request.run_id = "../escape"),
    (request: any) => (request.campaign_id = "a/b"),
    (request: any) => (request.artifact_targets.stdout = "../stdout.log"),
  ]) {
    const f = await fixture();
    mutate(f.request);
    try {
      await assert.rejects(
        new DeterministicRunner().run(f.request, {
          root: f.dir,
          stateSource: f.state,
          prompt: "p",
          adapter: f.adapter,
          evaluator: f.evaluator,
          taskChecks: [{ id: "core", weight: 1, required: true }],
        }),
        RunnerError,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
  const f = await fixture();
  try {
    await assert.rejects(
      new DeterministicRunner().run(f.request, {
        root: f.dir,
        stateSource: f.state,
        prompt: "p",
        adapter: f.adapter,
        evaluator: f.evaluator,
        taskChecks: [{ id: "core", weight: 1, required: true }],
        actualExecution: { mode: "host" },
      }),
      /topology/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("scoring policy applies threshold and optional completion requirement", async () => {
  const f = await fixture("token-limit");
  try {
    const result = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter: f.adapter,
      evaluator: {
        evaluate: async () => ({
          schema_version: "0.2.0",
          task_id: f.request.task.id,
          task_version: f.request.task.version,
          status: "ok",
          started_at: "2026-01-01T00:00:00Z",
          finished_at: "2026-01-01T00:00:00Z",
          duration_ms: 0,
          checks: [{ id: "core", score: 0.5, passed: true }],
        }),
      },
      taskChecks: [],
      scoringPolicy: {
        checks: [{ id: "core", weight: 1, required: true }],
        pass_threshold: 0.5,
        require_agent_completion: false,
      },
    });
    assert.equal(result.evaluation.criteria_passed, true);
    assert.equal(result.evaluation.end_to_end_passed, true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("diagnostic lineage derives from matching immutable parent evidence", async () => {
  const f = await fixture();
  try {
    const parent = await new DeterministicRunner().run(f.request, {
      root: f.dir,
      stateSource: f.state,
      prompt: "p",
      adapter: f.adapter,
      evaluator: f.evaluator,
      taskChecks: [{ id: "core", weight: 1, required: true }],
    });
    const child = deriveDiagnosticAttempt(f.request, parent, {
      mode: "retry",
      newRunId: "retry-safe",
      reason: "operator diagnosis",
    });
    assert.deepEqual(f.request.attempt, {
      number: 1,
      mode: "initial",
      initiated_by: "runner",
    });
    assert.deepEqual(child.attempt, {
      number: 2,
      mode: "retry",
      initiated_by: "operator",
      parent_run_id: f.request.run_id,
      reason: "operator diagnosis",
    });
    assert.throws(
      () =>
        deriveDiagnosticAttempt(
          f.request,
          { ...parent, run_id: "wrong" },
          { mode: "resume", newRunId: "new", reason: "x" },
        ),
      RunnerError,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
