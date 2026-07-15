import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ControlledHarnessAdapter, HarnessResult } from "./runner.js";

function redactLocalPaths(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(/\/(?:private\/)?tmp\/[A-Za-z0-9._/-]+|\/Users\/[A-Za-z0-9._/-]+/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactLocalPaths);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactLocalPaths(item)]));
  return value;
}

/**
 * Replays a retained, completed capture without starting a provider process.
 * The capture directory is deliberately supplied by the operator and is never
 * discovered from the environment, network, or a Codex installation.
 */
export class RecordedCaptureAdapter implements ControlledHarnessAdapter {
  constructor(
    private readonly captureDirectory: string,
    private readonly contaminationReason?: string,
  ) {}

  async terminate(): Promise<void> {
    // There is no child process or provider request in offline replay.
  }

  async run(input: Parameters<ControlledHarnessAdapter["run"]>[0]): Promise<HarnessResult> {
    await rm(input.workspace, { recursive: true, force: true });
    await mkdir(input.workspace, { recursive: true });
    // Retained capture roots mix final workspace files with capture-control and
    // evaluator-created files. The original task has exactly one workspace
    // file; replaying anything else would import evaluator leakage.
    await cp(join(this.captureDirectory, "text_report.py"), join(input.workspace, "text_report.py"), {
      verbatimSymlinks: true,
    });
    const events = (await readFile(join(this.captureDirectory, "native.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => redactLocalPaths(JSON.parse(line)));
    const terminal = events.findLast(
      (event) => (event as Record<string, unknown>).type === "turn.completed",
    ) as Record<string, unknown> | undefined;
    if (!terminal) throw new Error("recorded capture has no turn.completed event");
    const final = events.findLast((event) => {
      const item = (event as Record<string, unknown>).item;
      return (event as Record<string, unknown>).type === "item.completed"
        && item && typeof item === "object"
        && (item as Record<string, unknown>).type === "agent_message";
    }) as { item: { text?: unknown } } | undefined;
    const finalMessage = typeof final?.item.text === "string" ? redactLocalPaths(final.item.text) as string : undefined;
    return {
      terminal: this.contaminationReason ? "environment_error" : "agent_completed",
      events,
      stderr: await readFile(join(this.captureDirectory, "stderr.txt"), "utf8"),
      ...(finalMessage === undefined ? {} : { finalMessage }),
      exitCode: Number((await readFile(join(this.captureDirectory, "exit-code"), "utf8")).trim()),
      tokens: {
        status: "complete",
        source: "recorded-codex-jsonl",
        input: Number((terminal.usage as Record<string, unknown>).input_tokens),
        cached_input: Number((terminal.usage as Record<string, unknown>).cached_input_tokens),
        output: Number((terminal.usage as Record<string, unknown>).output_tokens),
        reasoning_output: Number((terminal.usage as Record<string, unknown>).reasoning_output_tokens),
        total: Number((terminal.usage as Record<string, unknown>).input_tokens)
          + Number((terminal.usage as Record<string, unknown>).output_tokens),
      },
      toolUsage: { status: "unavailable", source: "recorded-codex-jsonl", unavailable_reason: "native capture does not report aggregate tool usage" },
      cost: { status: "unavailable", source: "recorded-codex-jsonl", unavailable_reason: "native capture does not report cost" },
    };
  }
}
