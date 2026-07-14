import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, chmod, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, manifestDigest, treeDigest } from "../src/digests.js";
import { loadManifestText } from "../src/load.js";
import { SchemaValidator } from "../src/schema.js";
import { safeRelativePath } from "../src/repository.js";
import { ValidationError } from "../src/types.js";

const root = new URL("..", import.meta.url).pathname;

test("all checked-in examples validate under strict Draft 2020-12 schemas", async () => {
  const validator = await SchemaValidator.create(join(root, "spec/schemas"));
  const task = loadManifestText(await (await import("node:fs/promises")).readFile(join(root, "spec/examples/task.example.json"), "utf8"), "task.example.json");
  validator.validate("task", task, "task.example.json");
});

test("loaders reject duplicate keys and forbidden YAML tags", () => {
  assert.throws(() => loadManifestText('{"id":"one","id":"two"}', "bad.json"), ValidationError);
  assert.throws(() => loadManifestText("id: one\nid: two\n", "bad.yaml"), ValidationError);
  assert.throws(() => loadManifestText("id: !custom one\n", "bad.yaml"), ValidationError);
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

test("repository paths fail closed for escapes and collisions", () => {
  for (const path of ["../escape", "/absolute", "a//b", "a/../b", "a\\b"]) assert.equal(safeRelativePath(path), false);
  assert.equal(safeRelativePath("tasks/example/1.0.0/task.yaml"), true);
});
