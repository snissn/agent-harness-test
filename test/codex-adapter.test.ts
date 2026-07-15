import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { spawn } from "node:child_process";
import { CodexCliAdapter, codexArgv, parseCodexJsonl } from "../src/codex-adapter.js";
const completed = ['{"type":"turn.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}', '{"type":"turn.completed"}'];
test("Codex argv uses stdin, safe config, and excludes personal configuration", () => { const argv = codexArgv({ executable: "codex", workspace: "/tmp/work", model: "gpt-5.6-sol", effort: "medium", network: false }); assert.ok(argv.includes("--ephemeral") && argv.includes("--ignore-user-config") && argv.includes("--json") && argv.includes("workspace-write") && argv.includes("--skip-git-repo-check")); assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false); assert.equal(argv.at(-1), "-"); });
test("Codex JSONL maps completed, missing terminal, malformed, nonzero, timeout and provider errors", () => { assert.equal(parseCodexJsonl(completed, 0).terminal, "agent_completed"); assert.equal(parseCodexJsonl(['{"type":"turn.started"}'], 0).terminal, "harness_error"); assert.equal(parseCodexJsonl(["nope"], 0).terminal, "harness_error"); assert.equal(parseCodexJsonl(completed, 1).terminal, "agent_failed"); assert.equal(parseCodexJsonl(completed, null, true).terminal, "wall_time_exhausted"); assert.equal(parseCodexJsonl(['{"type":"error","error":"provider unavailable"}'], 1).terminal, "provider_error"); });
class FakeStream extends EventEmitter { setEncoding(): this { return this; } end(): void {} }
class FakeChild extends EventEmitter {
  stdout = new FakeStream(); stderr = new FakeStream(); stdin = new FakeStream();
  kill(): boolean { return true; }
}
const adapterInput = { workspace: "/workspace", prompt: "prompt", request: {}, signal: new AbortController().signal };
test("Codex CLI buffers arbitrary stdout chunks until complete JSONL lines", async () => {
  const child = new FakeChild();
  const adapter = new CodexCliAdapter(["codex"], {}, (() => child) as unknown as typeof spawn);
  const pending = adapter.run(adapterInput);
  child.stdout.emit("data", '{"type":"turn.st');
  child.stdout.emit("data", 'arted"}\n{"type":"turn.completed"}');
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.terminal, "agent_completed");
  assert.equal(result.events?.length, 2);
});
test("Codex CLI converts early stdin EPIPE to exactly one harness error", async () => {
  const child = new FakeChild();
  const adapter = new CodexCliAdapter(["codex"], {}, (() => child) as unknown as typeof spawn);
  const pending = adapter.run(adapterInput);
  child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.terminal, "harness_error");
  assert.match(result.stderr ?? "", /stdin error: write EPIPE/);
});
