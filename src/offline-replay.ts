import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ControlledHarnessAdapter, HarnessResult } from "./runner.js";

/**
 * Replays a retained, completed capture without starting a provider process.
 * The capture directory is deliberately supplied by the operator and is never
 * discovered from the environment, network, or a Codex installation.
 */
export class RecordedCaptureAdapter implements ControlledHarnessAdapter {
  constructor(private readonly captureDirectory: string) {}

  async terminate(): Promise<void> {
    // There is no child process or provider request in offline replay.
  }

  async run(input: Parameters<ControlledHarnessAdapter["run"]>[0]): Promise<HarnessResult> {
    await rm(input.workspace, { recursive: true, force: true });
    await mkdir(input.workspace, { recursive: true });
    // The retained capture mixes final workspace files with capture-control
    // evidence. Select only the task file and the two agent-created fixtures;
    // native JSONL, stderr, exit status, and evaluator output are evidence
    // artifacts and must never be represented as agent workspace output.
    for (const name of ["text_report.py", "sample.txt", "filter.txt"])
      await cp(join(this.captureDirectory, name), join(input.workspace, name), {
        verbatimSymlinks: true,
      });
    const events = (await readFile(join(this.captureDirectory, "native.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
    const finalMessage = typeof final?.item.text === "string" ? final.item.text : undefined;
    return {
      terminal: "agent_completed",
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
