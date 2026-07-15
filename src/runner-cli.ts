#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DeterministicRunner, FakeHarnessAdapter } from "./runner.js";
import { sha256 } from "./digests.js";
const [command, ...args] = process.argv.slice(2);
if (command === "inspect") {
  const [runDirectory] = args;
  if (!runDirectory)
    throw new Error("usage: runner:fake inspect <run-directory>");
  const state = await new DeterministicRunner().inspect(resolve(runDirectory!));
  console.log(JSON.stringify(state));
  process.exitCode = state.finalized ? 0 : 2;
} else if (command === "recover") {
  const [
    requestFile,
    stateDir,
    output,
    mode,
    parentRunId,
    reason,
    scenario = "success",
  ] = args;
  if (
    !requestFile ||
    !stateDir ||
    !output ||
    !mode ||
    !["retry", "resume"].includes(mode) ||
    !parentRunId ||
    !reason
  )
    throw new Error(
      "usage: runner:fake recover <request.json> <state-dir> <output-root> <retry|resume> <parent-run-id> <reason> [scenario]",
    );
  const request = JSON.parse(await readFile(resolve(requestFile), "utf8"));
  request.run_id = `${request.run_id}-${mode}-2`;
  request.attempt = {
    number: 2,
    mode,
    initiated_by: "operator",
    parent_run_id: parentRunId,
    reason,
  };
  const prompt = "fake fixture";
  if (
    `sha256:${sha256(prompt)}` !== request.task.prompt_digest ||
    request.task.prompt_digest !== request.invocation.stdin_digest
  )
    throw new Error(
      "request prompt/stdin digests must already match fake fixture; CLI never rewrites finalized request facts",
    );
  const result = await new DeterministicRunner().run(request, {
    root: resolve(output),
    stateSource: resolve(stateDir),
    prompt,
    adapter: new FakeHarnessAdapter(
      scenario as ConstructorParameters<typeof FakeHarnessAdapter>[0],
    ),
    evaluator: {
      evaluate: async () => ({
        schema_version: "0.2.0",
        task_id: request.task.id,
        task_version: request.task.version,
        status: "ok",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 0,
        checks: [{ id: "fixture", score: 1, passed: true }],
      }),
    },
    taskChecks: [{ id: "fixture", weight: 1, required: true }],
  });
  console.log(
    JSON.stringify({ run_id: result.run_id, terminal: result.terminal.reason }),
  );
} else {
  const [requestFile, stateDir, output, scenario = "success"] = [
    command,
    ...args,
  ];
  if (!requestFile || !stateDir || !output)
    throw new Error(
      "usage: runner:fake <request.json> <state-dir> <output-root> [fake scenario]",
    );
  const request = JSON.parse(await readFile(resolve(requestFile), "utf8"));
  const prompt = "fake fixture";
  if (
    `sha256:${sha256(prompt)}` !== request.task.prompt_digest ||
    request.task.prompt_digest !== request.invocation.stdin_digest
  )
    throw new Error(
      "request prompt/stdin digests must already match fake fixture; CLI never rewrites finalized request facts",
    );
  const result = await new DeterministicRunner().run(request, {
    root: resolve(output),
    stateSource: resolve(stateDir),
    prompt,
    adapter: new FakeHarnessAdapter(
      scenario as ConstructorParameters<typeof FakeHarnessAdapter>[0],
    ),
    evaluator: {
      evaluate: async () => ({
        schema_version: "0.2.0",
        task_id: request.task.id,
        task_version: request.task.version,
        status: "ok",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 0,
        checks: [{ id: "fixture", score: 1, passed: true }],
      }),
    },
    taskChecks: [{ id: "fixture", weight: 1, required: true }],
  });
  console.log(
    JSON.stringify({ run_id: result.run_id, terminal: result.terminal.reason }),
  );
}
