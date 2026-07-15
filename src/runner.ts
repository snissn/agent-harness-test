import {
  cp,
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { manifestDigest, sha256, treeDigest } from "./digests.js";
import { SchemaValidator } from "./schema.js";

export type RunnerState =
  | "new"
  | "request-finalized"
  | "materialized"
  | "running"
  | "captured"
  | "evaluated"
  | "finalized"
  | "failed";
export type Attribution =
  | "agent"
  | "provider"
  | "harness"
  | "environment"
  | "runner"
  | "operator";
export type TerminalReason =
  | "agent_completed"
  | "wall_time_exhausted"
  | "token_limit_exhausted"
  | "tool_limit_exhausted"
  | "agent_failed"
  | "provider_error"
  | "harness_error"
  | "environment_error"
  | "runner_error"
  | "cancelled";

export class RunnerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly attribution: Attribution = "runner",
  ) {
    super(message);
  }
}

const transitions: Record<RunnerState, RunnerState[]> = {
  new: ["request-finalized", "failed"],
  "request-finalized": ["materialized", "failed"],
  materialized: ["running", "failed"],
  running: ["captured", "failed"],
  captured: ["evaluated", "finalized", "failed"],
  evaluated: ["finalized", "failed"],
  finalized: [],
  failed: ["finalized"],
};
export const TERMINAL_ATTRIBUTION: Record<TerminalReason, Attribution> = {
  agent_completed: "agent",
  wall_time_exhausted: "runner",
  token_limit_exhausted: "runner",
  tool_limit_exhausted: "runner",
  agent_failed: "agent",
  provider_error: "provider",
  harness_error: "harness",
  environment_error: "environment",
  runner_error: "runner",
  cancelled: "operator",
};
export class AttemptState {
  state: RunnerState = "new";
  transition(next: RunnerState): void {
    if (!transitions[this.state].includes(next))
      throw new RunnerError(
        "runner.illegal-transition",
        `${this.state} cannot transition to ${next}`,
      );
    this.state = next;
  }
  fail(): void {
    this.transition("failed");
  }
  finalize(): void {
    this.transition("finalized");
  }
}

export interface HarnessResult {
  terminal: TerminalReason;
  stdout?: string;
  stderr?: string;
  events?: unknown[];
  finalMessage?: string;
  exitCode?: number | null;
  signal?: string;
  tokens?: Record<string, unknown>;
  toolUsage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  externalRequestId?: string;
}
export interface HarnessAdapter {
  run(input: {
    workspace: string;
    prompt: string;
    request: Record<string, unknown>;
    signal: AbortSignal;
    capture?: {
      event: (event: unknown) => void;
      stdout: (chunk: string) => void;
      stderr: (chunk: string) => void;
      finalMessage: (message: string) => void;
    };
  }): Promise<HarnessResult>;
}
/** A process adapter must kill its child/process group here. Abort alone is only cooperative. */
export interface ControlledHarnessAdapter extends HarnessAdapter {
  terminate?(reason: "wall_time_exhausted"): Promise<void>;
}
export interface Timer {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}
export const systemTimer: Timer = {
  set: (ms, cb) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Races the adapter only after controller enforcement has fired. Late adapter results are deliberately ignored. */
export async function runWithHardTimeout(
  adapter: ControlledHarnessAdapter,
  input: Parameters<HarnessAdapter["run"]>[0],
  timeoutMs: number,
  timer: Timer = systemTimer,
): Promise<HarnessResult> {
  const controller = new AbortController();
  let settled = false;
  let timerHandle: unknown;
  let timerCleared = false;
  const clearTimer = () => {
    if (!timerCleared && timerHandle !== undefined) {
      timerCleared = true;
      timer.clear(timerHandle);
    }
  };
  // Invoke through a promise boundary so a synchronous adapter throw also
  // participates in the race and cannot escape before timer cleanup is wired.
  const run = Promise.resolve().then(() => adapter.run({ ...input, signal: controller.signal }));
  const timedOut = new Promise<HarnessResult>((resolve) => {
    const fire = async () => {
      if (settled) return;
      clearTimer();
      controller.abort();
      if (!settled) {
        settled = true;
        resolve({
          terminal: "wall_time_exhausted",
          events: [{ type: "runner.timeout", enforcement: "terminate", termination_requested: true }],
          stderr: "hard wall time exhausted",
          exitCode: null,
        });
      }
      // Termination is best-effort evidence collection, never a condition for
      // publishing the hard timeout. A rejection is intentionally observed.
      void Promise.resolve()
        .then(() => adapter.terminate?.("wall_time_exhausted"))
        .catch(() => undefined);
    };
    timerHandle = timer.set(timeoutMs, () => void fire());
    run.then(clearTimer, clearTimer);
  });
  try {
    const result = await Promise.race([run, timedOut]);
    settled = true;
    return result;
  } finally {
    void run.catch(() => undefined);
  }
}

export interface Evaluator {
  evaluate(input: {
    workspace: string;
    request: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}
export type FakeScenario =
  | "success"
  | "timeout"
  | "token-limit"
  | "tool-limit"
  | "malformed-stream"
  | "provider-error"
  | "harness-error"
  | "cancelled";
export class FakeHarnessAdapter implements ControlledHarnessAdapter {
  private terminated = false;
  constructor(
    private readonly scenario: FakeScenario = "success",
    private readonly delayMs = 0,
    private readonly ignoreAbort = false,
  ) {}
  async terminate(): Promise<void> {
    this.terminated = true;
  }
  async run(
    input: Parameters<HarnessAdapter["run"]>[0],
  ): Promise<HarnessResult> {
    await writeFile(
      join(input.workspace, "fake-harness.txt"),
      `scenario=${this.scenario}\n`,
    );
    if (this.scenario === "timeout") await new Promise<void>(() => undefined);
    if (this.delayMs)
      await new Promise<void>((resolve) => {
        const h = setTimeout(resolve, this.delayMs);
        if (!this.ignoreAbort)
          input.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(h);
              resolve();
            },
            { once: true },
          );
      });
    if (this.terminated || input.signal.aborted)
      return {
        terminal: "wall_time_exhausted",
        events: [{ type: "started" }],
        stderr: "fake timeout",
        exitCode: null,
      };
    const terminal: TerminalReason =
      this.scenario === "success"
        ? "agent_completed"
        : this.scenario === "token-limit"
          ? "token_limit_exhausted"
          : this.scenario === "tool-limit"
            ? "tool_limit_exhausted"
            : this.scenario === "provider-error"
              ? "provider_error"
              : this.scenario === "harness-error" ||
                  this.scenario === "malformed-stream"
                ? "harness_error"
                : "cancelled";
    return {
      terminal,
      events:
        this.scenario === "malformed-stream"
          ? [{ broken: true }]
          : [{ type: "turn.started" }, { type: "turn.completed" }],
      stdout: "fake stdout\n",
      stderr: terminal === "agent_completed" ? "" : `fake ${terminal}\n`,
      ...(terminal === "agent_completed"
        ? { finalMessage: "fake completed" }
        : {}),
      exitCode: terminal === "agent_completed" ? 0 : 1,
    };
  }
}

export async function atomicWrite(
  file: string,
  value: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()}`;
  await writeFile(temp, value, { flag: "wx" });
  try {
    await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new RunnerError(
        "runner.artifact-exists",
        `refusing to overwrite ${file}`,
      );
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}
export function redact(value: string, secrets: string[]): string {
  return secrets.reduce(
    (out, secret) => (secret ? out.split(secret).join("[REDACTED]") : out),
    value,
  );
}
/** Byte-level redaction deliberately never decodes workspace files as text. */
async function redactWorkspace(root: string, secrets: string[]): Promise<void> {
  const patterns = [...new Set(secrets.filter(Boolean))]
    .map((secret) => Buffer.from(secret, "utf8"))
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!patterns.length) return;
  const replacement = Buffer.from("[REDACTED]", "utf8");
  const replace = (body: Buffer): Buffer => {
    const chunks: Buffer[] = [];
    let cursor = 0;
    let changed = false;
    while (cursor < body.length) {
      const match = patterns.find(
        (pattern) =>
          cursor + pattern.length <= body.length &&
          body.subarray(cursor, cursor + pattern.length).equals(pattern),
      );
      if (match) {
        chunks.push(replacement);
        cursor += match.length;
        changed = true;
      } else {
        const end = cursor + 1;
        chunks.push(body.subarray(cursor, end));
        cursor = end;
      }
    }
    return changed ? Buffer.concat(chunks) : body;
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const body = await readFile(path);
        const redacted = replace(body);
        if (redacted !== body) await writeFile(path, redacted);
      }
      // Symlinks are never followed: they are evidence metadata, not files to
      // traverse or rewrite outside the workspace root.
    }
  };
  await walk(root);
}
const cloneFreeze = <T>(value: T): T => {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(copy) as T;
};
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function workspaceBytes(dir: string): Promise<number> {
  let total = 0;
  if (!(await exists(dir))) return total;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) total += await workspaceBytes(file);
    else if (entry.isFile()) total += (await lstat(file)).size;
  }
  return total;
}
async function treeManifest(
  root: string,
): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        output.push({ type: "directory", path: name });
        await walk(path);
      } else if (entry.isFile())
        output.push({
          type: "file",
          path: name,
          mode: ((await lstat(path)).mode & 0o111) !== 0 ? "executable" : "regular",
          bytes: (await lstat(path)).size,
          digest: `sha256:${sha256(await readFile(path))}`,
        });
      else if (entry.isSymbolicLink())
        output.push({ type: "symlink", path: name, target: await readlink(path) });
    }
  }
  await walk(root);
  return output.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}
function diffManifest(
  initial: Array<Record<string, unknown>>,
  final: Array<Record<string, unknown>>,
): string {
  const a = new Map(initial.map((e) => [String(e.path), JSON.stringify(e)]));
  const b = new Map(final.map((e) => [String(e.path), JSON.stringify(e)]));
  return (
    [...new Set([...a.keys(), ...b.keys()])]
      .sort()
      .flatMap((path) =>
        a.get(path) === b.get(path)
          ? []
          : [
              `--- ${a.has(path) ? path : "/dev/null"}`,
              `+++ ${b.has(path) ? path : "/dev/null"}`,
              `${a.get(path) ?? ""}`,
              `${b.get(path) ?? ""}`,
            ],
      )
      .join("\n") + "\n"
  );
}
function unavailable(source: string, reason: string): Record<string, unknown> {
  return { status: "unavailable", source, unavailable_reason: reason };
}
function evaluationSummary(
  raw: Record<string, unknown>,
  policy: {
    checks: Array<Record<string, unknown>>;
    pass_threshold?: number;
    require_agent_completion?: boolean;
  },
  terminal: TerminalReason,
  attempt: Record<string, unknown>,
  digest: string,
): Record<string, unknown> {
  if (raw.status !== "ok")
    return {
      status: "error",
      reason: String(raw.error_message ?? "evaluator error"),
      eligible_for_quality_aggregate: false,
    };
  const received = Array.isArray(raw.checks)
    ? (raw.checks as Array<Record<string, unknown>>)
    : [];
  const got = new Map(received.map((c) => [c.id, c]));
  const checks = policy.checks;
  if (
    !checks.length ||
    checks.some(
      (c) => !Number.isFinite(Number(c.weight)) || Number(c.weight) <= 0,
    ) ||
    received.some(
      (c) =>
        !Number.isFinite(Number(c.score)) ||
        Number(c.score) < 0 ||
        Number(c.score) > 1,
    ) ||
    new Set(received.map((c) => c.id)).size !== received.length ||
    got.size !== checks.length ||
    checks.some((c) => !got.has(c.id))
  )
    return {
      status: "error",
      reason: "evaluator check IDs do not exactly match task checks",
      eligible_for_quality_aggregate: false,
    };
  const entries: Array<Record<string, unknown>> = checks.map((c) => ({
    ...got.get(c.id),
    weight: c.weight,
    required: c.required,
  }));
  const quality =
    entries.reduce((n, c) => n + Number(c.score) * Number(c.weight), 0) /
    entries.reduce((n, c) => n + Number(c.weight), 0);
  const criteria =
    entries.filter((c) => c.required).every((c) => c.passed === true) &&
    quality >= (policy.pass_threshold ?? 1);
  const eligible =
    attempt.mode === "initial" &&
    [
      "agent_completed",
      "agent_failed",
      "wall_time_exhausted",
      "token_limit_exhausted",
      "tool_limit_exhausted",
    ].includes(terminal);
  return {
    status: "ok",
    result_artifact_digest: digest,
    checks: entries,
    artifact_quality_score: quality,
    criteria_passed: criteria,
    agent_completion_required: policy.require_agent_completion ?? true,
    end_to_end_passed:
      criteria &&
      eligible &&
      (!(policy.require_agent_completion ?? true) ||
        terminal === "agent_completed"),
    eligible_for_quality_aggregate: eligible,
  };
}

export interface RunOptions {
  root: string;
  stateSource: string;
  prompt: string;
  adapter: ControlledHarnessAdapter;
  evaluator: Evaluator;
  taskChecks: Array<Record<string, unknown>>;
  scoringPolicy?: {
    checks: Array<Record<string, unknown>>;
    pass_threshold?: number;
    require_agent_completion?: boolean;
  };
  actualExecution?: Record<string, unknown>;
  schemaDirectory?: string;
  timer?: Timer;
  runtimeRedactions?: string[];
  runnerGitCommit?: string;
}
export function deriveDiagnosticAttempt(
  parentRequest: Record<string, any>,
  parentResult: Record<string, any>,
  input: { mode: "retry" | "resume"; newRunId: string; reason: string },
): Record<string, any> {
  const safe = (id: string) => id !== "." && id !== ".." && !/[\\/\0]/.test(id);
  if (
    !safe(input.newRunId) ||
    input.newRunId === parentRequest.run_id ||
    !input.reason.trim()
  )
    throw new RunnerError(
      "operator.invalid-diagnostic-attempt",
      "new run ID and reason are required",
      "operator",
    );
  if (
    parentRequest.run_id !== parentResult.run_id ||
    parentRequest.campaign_id !== parentResult.campaign_id ||
    parentResult.provenance?.request_digest !== manifestDigest(parentRequest)
  )
    throw new RunnerError(
      "operator.parent-mismatch",
      "parent request/result identity or digest mismatch",
      "operator",
    );
  const request = JSON.parse(JSON.stringify(parentRequest)) as Record<
    string,
    any
  >;
  request.run_id = input.newRunId;
  request.attempt = {
    number: Number(parentRequest.attempt?.number) + 1,
    mode: input.mode,
    initiated_by: "operator",
    parent_run_id: parentRequest.run_id,
    reason: input.reason,
  };
  return request;
}
export class DeterministicRunner {
  async run(
    inputRequest: Record<string, unknown>,
    o: RunOptions,
  ): Promise<Record<string, any>> {
    const request = cloneFreeze(inputRequest);
    const secrets = o.runtimeRedactions ?? [];
    const schema = o.schemaDirectory
      ? await SchemaValidator.create(o.schemaDirectory)
      : undefined;
    schema?.validate("run-request", request);
    const commit = o.runnerGitCommit ?? process.env.RUNNER_GIT_COMMIT;
    if (!commit || !/^[a-f0-9]{7,64}$/.test(commit))
      throw new RunnerError(
        "runner.missing-git-commit",
        "runner git commit must be an exact hexadecimal commit",
      );
    if (
      o.actualExecution &&
      JSON.stringify(o.actualExecution) !== JSON.stringify(request.execution)
    )
      throw new RunnerError(
        "environment.execution-topology-mismatch",
        "actual execution topology differs from finalized request",
        "environment",
      );
    if (
      sha256(o.prompt) !==
        String((request.task as any).prompt_digest).replace("sha256:", "") ||
      sha256(o.prompt) !==
        String((request.invocation as any).stdin_digest).replace(
          "sha256:",
          "",
        ) ||
      sha256(o.prompt) !==
        String((request.workspace as any).prompt_digest).replace("sha256:", "")
    )
      throw new RunnerError(
        "environment.prompt-or-stdin-digest-mismatch",
        "prompt and stdin bytes do not match finalized request",
        "environment",
      );
    const target = request.artifact_targets as Record<string, string>;
    const safePart = (value: unknown) =>
      typeof value === "string" &&
      value !== "." &&
      value !== ".." &&
      !/[\\/\0]/.test(value);
    if (
      !safePart((request.experiment as any)?.id) ||
      !safePart(request.campaign_id) ||
      !safePart(request.run_id)
    )
      throw new RunnerError(
        "runner.unsafe-attempt-path",
        "experiment, campaign, and run IDs must be single safe path components",
      );
    const root = join(
      o.root,
      "results",
      (request.experiment as any).id,
      String(request.campaign_id),
      "runs",
      String(request.run_id),
    );
    // The adapter only ever receives this disposable path. On capture it is
    // copied into the durable workspace evidence path, so a non-cooperative
    // process cannot mutate finalized evidence after a hard timeout.
    const activeWorkspace = join(root, ".agent-workspace");
    const workspace = join(root, "workspace");
    const within = (path: string) =>
      path === root || path.startsWith(`${root}/`);
    for (const value of Object.values(target)) {
      const path = join(root, value);
      if (!within(path))
        throw new RunnerError(
          "runner.unsafe-artifact-path",
          "artifact target escapes attempt directory",
        );
    }
    const state = new AttemptState();
    await mkdir(root, { recursive: true });
    await atomicWrite(
      join(root, target.request!),
      redact(JSON.stringify(request), secrets),
    );
    state.transition("request-finalized");
    const startedAt = new Date();
    const started = performance.now();
    const phases: Record<string, number> = {};
    const errors: Array<Record<string, unknown>> = [];
    let terminal: TerminalReason = "runner_error";
    let harness: HarnessResult | undefined;
    let post = `tree-sha256-v1:${"0".repeat(64)}`;
    let final = post;
    let initialBytes = 0;
    let materializationVerified = false;
    let evaluation: Record<string, unknown> = {
      status: "not-run",
      reason: "no salvageable workspace",
      eligible_for_quality_aggregate: false,
    };
    const captured = {
      events: [] as unknown[],
      stdout: [] as string[],
      stderr: [] as string[],
      finalMessage: [] as string[],
    };
    const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const at = performance.now();
      try {
        return await fn();
      } finally {
        phases[name] = Math.round(performance.now() - at);
      }
    };
    const error = (
      phaseName: "materialization" | "agent" | "evaluation",
      e: unknown,
      attribution: Attribution | "evaluator",
      code: string,
    ) =>
      errors.push({
        occurred_at: new Date().toISOString(),
        phase: phaseName,
        code,
        attribution,
        retryable: false,
        message: redact(e instanceof Error ? e.message : String(e), secrets),
        exit_code: harness?.exitCode ?? null,
        ...(harness?.signal ? { signal: harness.signal } : {}),
        ...(harness?.externalRequestId
          ? { external_request_id: harness.externalRequestId }
          : {}),
      });
    try {
      await phase("materialization", async () => {
        await cp(o.stateSource, activeWorkspace, {
          recursive: true,
          errorOnExist: true,
          verbatimSymlinks: true,
        });
        post = await treeDigest(activeWorkspace);
        if (
          post !== (request.workspace as any).initial_tree_digest ||
          post !== (request.task as any).initial_tree_digest
        )
          throw new RunnerError(
            "environment.initial-tree-digest-mismatch",
            "initial state digest mismatch",
            "environment",
          );
        materializationVerified = true;
        initialBytes = await workspaceBytes(activeWorkspace);
      });
      state.transition("materialized");
      state.transition("running");
      harness = await phase("agent", () =>
        runWithHardTimeout(
          o.adapter,
          {
            workspace: activeWorkspace,
            prompt: o.prompt,
            request,
            signal: new AbortController().signal,
            capture: {
              event: (event) => captured.events.push(event),
              stdout: (chunk) => captured.stdout.push(chunk),
              stderr: (chunk) => captured.stderr.push(chunk),
              finalMessage: (message) => captured.finalMessage.push(message),
            },
          },
          Number(
            (request.configuration as any).limits.wall_time_seconds.value,
          ) * 1000,
          o.timer,
        ),
      );
      terminal = harness.terminal;
      state.transition("captured");
      if (terminal !== "agent_completed")
        error(
          "agent",
          new Error(`terminal ${terminal}`),
          TERMINAL_ATTRIBUTION[terminal],
          `terminal.${terminal}`,
        );
    } catch (e) {
      const r =
        e instanceof RunnerError
          ? e
          : new RunnerError(
              "runner.unhandled",
              e instanceof Error ? e.message : String(e),
            );
      const failedDuringAgent = state.state === "running";
      terminal =
        r.attribution === "environment"
          ? "environment_error"
          : r.attribution === "agent"
            ? "agent_failed"
            : "runner_error";
      if (state.state !== "failed") state.fail();
      error(
        failedDuringAgent ? "agent" : "materialization",
        r,
        r.attribution,
        r.code,
      );
    }
    const protectedWorkspace = join(root, ".evaluator-workspace");
    if (materializationVerified && (await exists(activeWorkspace)))
      await cp(activeWorkspace, protectedWorkspace, {
        recursive: true,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
    // Snapshot before writing any final evidence. The active workspace is then
    // removed; a late, non-cooperative adapter can only recreate that disposable
    // path and cannot alter the retained workspace or its digest.
    if (await exists(activeWorkspace)) {
      await phase("snapshot", async () => {
        await redactWorkspace(activeWorkspace, secrets);
        await cp(activeWorkspace, workspace, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
        await rm(activeWorkspace, { recursive: true, force: true });
      });
    }
    const write = async (name: keyof typeof target, text: string) =>
      atomicWrite(join(root, target[name]!), redact(text, secrets));
    await write(
      "native_events",
      [...captured.events, ...(harness?.events ?? [])]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    await write("stdout", [...captured.stdout, harness?.stdout ?? ""].join(""));
    await write("stderr", [...captured.stderr, harness?.stderr ?? ""].join(""));
    await write(
      "final_message",
      [...captured.finalMessage, harness?.finalMessage ?? ""].join(""),
    );
    if (await exists(workspace)) {
      const initialManifest = await treeManifest(o.stateSource);
      const finalManifest = await phase("snapshot", () =>
        treeManifest(workspace),
      );
      final = await treeDigest(workspace);
      await write(
        "workspace_tree",
        JSON.stringify({ digest: final, entries: finalManifest }),
      );
      await write(
        "workspace_patch",
        diffManifest(initialManifest, finalManifest),
      );
      if (materializationVerified) {
        try {
        const raw = await phase("evaluation", () =>
          o.evaluator.evaluate({ workspace: protectedWorkspace, request }),
        );
        schema?.validate("evaluation", raw);
        evaluation = evaluationSummary(
          raw,
          o.scoringPolicy ?? { checks: o.taskChecks },
          terminal,
          request.attempt as Record<string, unknown>,
          manifestDigest(raw),
        );
        if (evaluation.status === "error")
          await write(
            "evaluator_result",
            JSON.stringify({
              schema_version: "0.2.0",
              task_id: (request.task as any).id,
              task_version: (request.task as any).version,
              status: "error",
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
              duration_ms: 0,
              error_message: String(evaluation.reason),
            }),
          );
        else await write("evaluator_result", JSON.stringify(raw));
        if (evaluation.status === "error")
          error(
            "evaluation",
            new Error(String(evaluation.reason)),
            "evaluator",
            "evaluator.invalid-output",
          );
        } catch (e) {
        const message = redact(
          e instanceof Error ? e.message : String(e),
          secrets,
        );
        const raw = {
          schema_version: "0.2.0",
          task_id: (request.task as any).id,
          task_version: (request.task as any).version,
          status: "error",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 0,
          error_message: message || "evaluator error",
        };
        schema?.validate("evaluation", raw);
        await write("evaluator_result", JSON.stringify(raw));
        evaluation = {
          status: "error",
          reason: "evaluator error",
          eligible_for_quality_aggregate: false,
        };
        error("evaluation", e, "evaluator", "evaluator.error");
        } finally {
          await rm(protectedWorkspace, { recursive: true, force: true });
        }
      }
    }
    const base = join(
      o.root,
      "results",
      (request.experiment as any).id,
      String(request.campaign_id),
    );
    const artifactKinds: Array<[keyof typeof target, string, string]> = [
      ["request", "request", "application/json"],
      ["native_events", "native-events", "application/x-ndjson"],
      ["stdout", "stdout", "text/plain"],
      ["stderr", "stderr", "text/plain"],
      ["final_message", "final-message", "text/plain"],
      ["workspace_patch", "workspace-patch", "text/x-diff"],
      ["workspace_tree", "workspace-tree", "application/json"],
      ["evaluator_result", "evaluator-result", "application/json"],
    ];
    const artifacts = await Promise.all(
      (
        await Promise.all(
          artifactKinds.map(async (entry) =>
            target[entry[0]] && (await exists(join(root, target[entry[0]]!)))
              ? entry
              : undefined,
          ),
        )
      )
        .filter(
          (entry): entry is [keyof typeof target, string, string] =>
            entry !== undefined,
        )
        .map(async ([key, kind, media_type]) => {
          const file = join(root, target[key]!);
          const body = await readFile(file);
          return {
            kind,
            path: relative(base, file).replaceAll("\\", "/"),
            digest: `sha256:${sha256(body)}`,
            media_type,
            bytes: body.length,
          };
        }),
    );
    const finished = new Date();
    const finalBytes = await workspaceBytes(workspace);
    const result: Record<string, any> = {
      schema_version: "0.2.0",
      run_id: request.run_id,
      campaign_id: request.campaign_id,
      experiment: request.experiment,
      suite: request.suite,
      task: request.task,
      configuration_id: (request.configuration as any).id,
      repetition: request.repetition,
      schedule_index: request.schedule_index,
      attempt: request.attempt,
      observed_at: finished.toISOString(),
      started_at: startedAt.toISOString(),
      finished_at: finished.toISOString(),
      terminal: {
        reason: terminal,
        attribution: TERMINAL_ATTRIBUTION[terminal],
        operational_success: terminal === "agent_completed",
        exit_code: harness?.exitCode ?? null,
        ...(harness?.signal ? { signal: harness.signal } : {}),
      },
      resolved_configuration: {
        harness: (request.configuration as any).harness,
        model: {
          provider: (request.configuration as any).model.provider,
          requested_id: (request.configuration as any).model.requested_id,
          snapshot_available: false,
        },
        effort: (request.configuration as any).effort,
        limits: (request.configuration as any).limits,
        effective_config_digest: manifestDigest(request.configuration),
      },
      provenance: {
        runner_version: "0.2.0",
        runner_git_commit: commit,
        runner_runtime: { name: "node", version: process.version.slice(1) },
        request_digest: manifestDigest(request),
        host: {
          operating_system: process.platform,
          architecture: process.arch,
        },
        execution: request.execution,
        post_setup_tree_digest: post,
        final_tree_digest: final,
      },
      metrics: {
        timing: {
          clock_source: "monotonic",
          wall_time_ms: Math.round(performance.now() - started),
          phases_ms: phases,
        },
        tokens:
          harness?.tokens ??
          unavailable(
            "fake-harness",
            "adapter did not expose token observations",
          ),
        tool_usage:
          harness?.toolUsage ??
          unavailable(
            "fake-harness",
            "adapter did not expose tool observations",
          ),
        cost:
          harness?.cost ??
          unavailable(
            "fake-harness",
            "adapter did not expose cost observations",
          ),
        resources: {
          status: "partial",
          source: "runner-workspace",
          partial_reason: "adapter does not expose process counters",
          scope: "agent-process",
          workspace_initial_bytes: initialBytes,
          workspace_final_bytes: finalBytes,
          workspace_delta_bytes: finalBytes - initialBytes,
        },
      },
      evaluation,
      errors,
      artifacts,
      warnings: [],
    };
    schema?.validate("run-result", result);
    await phase("finalization", () =>
      atomicWrite(
        join(root, target.run_result!),
        redact(JSON.stringify(result), secrets),
      ),
    );
    state.finalize();
    return result;
  }
  async inspect(
    root: string,
  ): Promise<{
    finalized: boolean;
    run?: Record<string, unknown>;
    artifacts: string[];
  }> {
    const requestFile = join(root, "request.json");
    const request = (await exists(requestFile))
      ? JSON.parse(await readFile(requestFile, "utf8"))
      : undefined;
    const file = join(
      root,
      request?.artifact_targets?.run_result ?? "run.json",
    );
    const candidates = request?.artifact_targets
      ? Object.values(request.artifact_targets)
      : ["request.json", "run.json"];
    const artifacts = (
      await Promise.all(
        candidates.map(async (path) =>
          (await exists(join(root, String(path)))) ? String(path) : undefined,
        ),
      )
    ).filter((path): path is string => path !== undefined);
    return (await exists(file))
      ? {
          finalized: true,
          run: JSON.parse(await readFile(file, "utf8")),
          artifacts,
        }
      : { finalized: false, artifacts };
  }
}
