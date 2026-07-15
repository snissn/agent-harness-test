import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { rebuildReport } from "../src/report.js";

const source = resolve(import.meta.dirname, "..");
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-report-"));
  for (const path of ["spec", "tasks"]) await cp(join(source, path), join(root, path), { recursive: true });
  await cp(join(source, "results/codex-text-report-smoke/2026-07-15-codex-text-report-smoke"), join(root, "results/codex-text-report-smoke/2026-07-15-codex-text-report-smoke"), { recursive: true });
  return root;
}

test("report rebuild is deterministic and keeps infrastructure failures out of quality denominator", async () => {
  const root = await fixture();
  try {
    const first = await rebuildReport(root, "report-a"), firstData = await readFile(first.data, "utf8");
    const second = await rebuildReport(root, "report-b"), secondData = await readFile(second.data, "utf8");
    assert.equal(firstData, secondData);
    const data = JSON.parse(firstData);
    assert.match(await readFile(first.html, "utf8"), /Smoke evidence/);
    assert.equal(data.configurations.find((item: any) => item.configuration_id === "codex-medium").quality_denominator, 1);
    assert.equal(data.configurations.find((item: any) => item.configuration_id === "codex-high").quality_denominator, 0);
    assert.equal(data.configurations.find((item: any) => item.configuration_id === "codex-high").invalid_or_infrastructure_attempts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt source artifact is quarantined without changing valid aggregate rows", async () => {
  const root = await fixture();
  try {
    const corrupt = join(root, "results/codex-text-report-smoke/2026-07-15-codex-text-report-smoke/runs/codex-codex-high-r1/stdout.log");
    await writeFile(corrupt, "corrupt source evidence\n");
    const result = await rebuildReport(root);
    const data = JSON.parse(await readFile(result.data, "utf8"));
    assert.equal(result.runs, 1);
    assert.equal(result.invalid, 1);
    assert.equal(data.configurations.find((item: any) => item.configuration_id === "codex-medium").headline_score, 1);
    assert.match(data.ingestion_errors[0].message, /artifact digest mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report refuses destructive output paths", async () => {
  const root = await fixture();
  try {
    await assert.rejects(rebuildReport(root, "."), /disposable directory/);
    await assert.rejects(rebuildReport(root, "results"), /disposable directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
