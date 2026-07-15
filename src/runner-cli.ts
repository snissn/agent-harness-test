#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DeterministicRunner, FakeHarnessAdapter } from "./runner.js";
import { treeDigest } from "./digests.js";
const [requestFile, state, output, scenario = "success"] = process.argv.slice(2);
if (!requestFile || !state || !output) throw new Error("usage: runner:fake <request.json> <state-dir> <output-root> [fake scenario]");
const request = JSON.parse(await readFile(resolve(requestFile), "utf8")); request.workspace.initial_tree_digest = await treeDigest(resolve(state)); request.task.initial_tree_digest = request.workspace.initial_tree_digest;
const result = await new DeterministicRunner().run(request, { root: resolve(output), stateSource: resolve(state), prompt: "fake fixture", adapter: new FakeHarnessAdapter(scenario as ConstructorParameters<typeof FakeHarnessAdapter>[0]), evaluator: { evaluate: async () => ({ schema_version: "0.2.0", task_id: request.task.id, task_version: request.task.version, status: "ok", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 0, checks: [{ id: "fixture", score: 1, passed: true }] }) }, taskChecks: [{ id: "fixture", weight: 1, required: true }] });
console.log(JSON.stringify({ run_id: result.run_id, terminal: result.terminal.reason }));
