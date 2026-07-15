import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { HarnessAdapter, HarnessResult } from "./runner.js";

export type CodexTerminal = "agent_completed" | "agent_failed" | "provider_error" | "harness_error" | "wall_time_exhausted";
export function codexArgv(input: { executable: string; workspace: string; model: string; effort: string; network: boolean }): string[] {
  return [input.executable, "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", input.workspace, "--model", input.model, "--config", `approval_policy=\"never\"`, "--config", `model_reasoning_effort=\"${input.effort}\"`, "--config", `sandbox_workspace_write.network_access=${input.network}`, "-"];
}
export function parseCodexJsonl(lines: string[], exitCode: number | null, timedOut = false): HarnessResult {
  if (timedOut) return { terminal: "wall_time_exhausted", events: lines, exitCode };
  const events: unknown[] = []; let finalMessage: string | undefined; let provider = false;
  for (const line of lines.filter(Boolean)) {
    try { const event = JSON.parse(line) as Record<string, unknown>; events.push(event); if (event.type === "item.completed" && (event.item as Record<string, unknown>)?.type === "agent_message") finalMessage = String((event.item as Record<string, unknown>).text ?? ""); if (String(event.type).includes("error") || String(event.error ?? "").toLowerCase().includes("provider")) provider = true; }
    catch { return { terminal: "harness_error", events, stderr: "malformed Codex JSONL", exitCode }; }
  }
  const message = finalMessage === undefined ? {} : { finalMessage };
  if (provider) return { terminal: "provider_error", events, ...message, exitCode };
  const completed = events.some((event) => (event as Record<string, unknown>).type === "turn.completed");
  if (!completed) return { terminal: "harness_error", events, ...message, stderr: "missing terminal event", exitCode };
  return { terminal: exitCode === 0 ? "agent_completed" : "agent_failed", events, ...message, exitCode };
}
export async function codexRuntimeFingerprint(executable: string): Promise<{ runtime_digest: string; executable_digest: string }> {
  const bytes = await readFile(executable); const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { runtime_digest: digest, executable_digest: digest };
}
export class CodexCliAdapter implements HarnessAdapter {
  constructor(private readonly argv: string[], private readonly env: NodeJS.ProcessEnv) {}
  async run(input: Parameters<HarnessAdapter["run"]>[0]): Promise<HarnessResult> {
    return await new Promise((resolve) => {
      const child = spawn(this.argv[0]!, this.argv.slice(1), { cwd: input.workspace, env: this.env, stdio: ["pipe", "pipe", "pipe"] }); const lines: string[] = []; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (data) => { lines.push(...data.split(/\r?\n/).filter(Boolean)); }); child.stderr.setEncoding("utf8"); child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", () => resolve({ terminal: "harness_error", events: lines, stderr, exitCode: null })); child.on("close", (code) => { const result = parseCodexJsonl(lines, code); resolve({ ...result, stderr: result.stderr ?? stderr }); }); input.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true }); child.stdin.end(input.prompt);
    });
  }
}
