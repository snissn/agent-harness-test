import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readdir, symlink, writeFile, chmod, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, manifestDigest, sha256, treeDigest } from "../src/digests.js";
import { loadManifestText } from "../src/load.js";
import { kindFromPath, SchemaValidator } from "../src/schema.js";
import { safeRelativePath, validateRepository } from "../src/repository.js";
import { ValidationError } from "../src/types.js";

const root = new URL("..", import.meta.url).pathname;

test("all seven checked-in examples are discoverable and schema-validated", async () => {
  const expected = ["task", "suite", "experiment", "campaign", "evaluation", "run-request", "run-result"];
  for (const kind of expected) assert.equal(kindFromPath(join("spec/examples", `${kind}.example.json`)), kind);
  await validateRepository(root);
});

test("loaders reject duplicate keys and forbidden YAML tags", () => {
  assert.throws(() => loadManifestText('{"id":"one","id":"two"}', "bad.json"), ValidationError);
  assert.throws(() => loadManifestText("id: one\nid: two\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("id: !custom one\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("1: value\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("a: &value {x: one}\nb: *value\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("base: &base {x: one}\nvalue:\n  <<: *base\n", "bad.yaml"), ValidationError);
});

test("strict schemas reject unknown fields and incompatible versions", async () => {
  const validator = await SchemaValidator.create(join(root, "spec/schemas"));
  const valid = loadManifestText(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8"), "task.example.json") as Record<string, unknown>;
  assert.throws(() => validator.validate("task", { ...valid, unexpected: true }, "bad.json"), ValidationError);
  assert.throws(() => validator.validate("task", { ...valid, schema_version: "1.0.0" }, "bad.json"), ValidationError);
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
  for (const path of ["../escape", "/absolute", "a//b", "a/../b", "a\\b"]) assert.equal(safeRelativePath(path), false);
  assert.equal(safeRelativePath("tasks/example/1.0.0/task.yaml"), true);
});

async function semanticFixture(): Promise<{ root: string; taskFile: string; task: Record<string, unknown> }> {
  const fixture = await mkdtemp(join(tmpdir(), "aht-repo-"));
  await cp(join(root, "spec/schemas"), join(fixture, "spec/schemas"), { recursive: true }); await mkdir(join(fixture, "spec/examples"), { recursive: true });
  const taskFile = join(fixture, "tasks/demo/1.0.0/task.json"); await mkdir(join(fixture, "tasks/demo/1.0.0/state"), { recursive: true }); await mkdir(join(fixture, "tasks/demo/1.0.0/evaluator"), { recursive: true });
  await writeFile(join(fixture, "tasks/demo/1.0.0/prompt.md"), "prompt bytes\n"); await writeFile(join(fixture, "tasks/demo/1.0.0/state/file.txt"), "state"); await writeFile(join(fixture, "tasks/demo/1.0.0/evaluator/evaluate.py"), "evaluator");
  const source = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8")) as Record<string, any>;
  source.id = "demo"; source.status = "candidate"; source.prompt.path = "tasks/demo/1.0.0/prompt.md"; source.prompt.digest = `sha256:${sha256("prompt bytes\n")}`; source.problem_state.source.path = "tasks/demo/1.0.0/state"; source.problem_state.expected_tree_digest = await treeDigest(join(fixture, "tasks/demo/1.0.0/state")); source.evaluator.path = "tasks/demo/1.0.0/evaluator"; source.evaluator.digest = await treeDigest(join(fixture, "tasks/demo/1.0.0/evaluator"));
  await writeFile(taskFile, JSON.stringify(source)); return { root: fixture, taskFile, task: source };
}

test("repository semantics reject prompt digest, orphan artifacts, unknown evaluator tasks, and duplicate identities", async () => {
  const fixture = await semanticFixture();
  fixture.task.prompt = { ...(fixture.task.prompt as Record<string, unknown>), digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }; await writeFile(fixture.taskFile, JSON.stringify(fixture.task));
  await mkdir(join(fixture.root, "tasks/orphan/1.0.0/state"), { recursive: true });
  await mkdir(join(fixture.root, "results"), { recursive: true });
  const evaluation = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/evaluation.example.json"), "utf8")); evaluation.task_id = "missing"; await writeFile(join(fixture.root, "results/evaluation.json"), JSON.stringify(evaluation));
  await mkdir(join(fixture.root, "suites"), { recursive: true }); const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); await writeFile(join(fixture.root, "suites/one-suite.json"), JSON.stringify(suite)); await writeFile(join(fixture.root, "suites/two-suite.json"), JSON.stringify(suite));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && ["prompt digest mismatch", "state/evaluator artifact has no co-located task spec", "missing task missing@1.0.0", "duplicate suite identity"].every((fragment) => error.message.includes(fragment)));
});

test("semantic suite and evaluator invariants reject released candidates, bad digests, and check-ID mismatch", async () => {
  const fixture = await semanticFixture(); await mkdir(join(fixture.root, "suites")); await mkdir(join(fixture.root, "results"));
  const suite = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/suite.example.json"), "utf8")); suite.tasks[0].id = "demo"; suite.tasks[0].spec_digest = manifestDigest(fixture.task); await writeFile(join(fixture.root, "suites/demo-suite.json"), JSON.stringify(suite));
  const result = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/evaluation.example.json"), "utf8")); result.task_id = "demo"; result.checks = [result.checks[0]]; await writeFile(join(fixture.root, "results/evaluation.json"), JSON.stringify(result));
  await assert.rejects(validateRepository(fixture.root), (error: unknown) => error instanceof ValidationError && error.message.includes("released suite references non-released task") && error.message.includes("evaluator check IDs"));
  suite.status = "draft"; suite.tasks[0].spec_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; await writeFile(join(fixture.root, "suites/demo-suite.json"), JSON.stringify(suite));
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
