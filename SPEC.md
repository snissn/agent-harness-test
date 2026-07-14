# Agent Harness Test Framework Specification

Version: `0.2.0-draft`

Status: normative design draft

## 1. Purpose

Agent Harness Test defines a reproducible, modular system for evaluating coding
agents on common software-engineering tasks. Its initial purpose is an internal
demo, but its design should be credible as a model-lab QA system used before a
model or agent-harness release.

The framework must answer questions such as:

- Did a candidate model regress on end-to-end coding tasks?
- How does the same model perform under Codex and Pi?
- How does native reasoning effort affect correctness, latency, and cost?
- Is a score change caused by the agent, the harness, the evaluator, or broken
  evaluation infrastructure?
- How has a fixed model-harness configuration performed across historical runs?

The words **MUST**, **SHOULD**, and **MAY** describe required, recommended, and
optional behavior respectively.

## 2. Scope

### 2.1 Goals

The framework MUST provide:

1. Versioned task specifications for realistic coding work.
2. A verifiable correspondence between runnable task specs and concrete problem
   states.
3. Deterministic, machine-readable evaluation and scoring.
4. A harness-neutral run contract with harness-specific adapters.
5. Historical provenance sufficient to reproduce or qualify comparisons.
6. Aggregate and drill-down views across model, harness, effort, task, language,
   category, and observed run date.
7. Explicit separation of solution quality from operational failures.
8. A spec-first lifecycle for adding and changing tasks.

### 2.2 Initial scope

The first implementation targets:

- local, non-interactive `codex exec` execution;
- ChatGPT-authenticated models available through that Codex installation;
- a deterministic, non-agent runner with an explicit run state machine;
- public tasks and evaluators;
- ordinary network access during agent execution;
- one smoke attempt per matrix cell while the system is being stabilized;
- a breadth-first suite spanning Python, TypeScript, and Go;
- local immutable artifacts, a rebuildable SQLite index, and static reports;
- a non-canonical local-development execution profile; and
- a canonical profile isolated from the host by an ephemeral Linux container or
  virtual machine.

### 2.3 Non-goals for v0

The following are explicitly deferred:

- adversarial benchmark secrecy or anti-gaming mechanisms;
- a public leaderboard;
- a single universal mapping between harness-specific effort settings;
- subjective LLM judging as a foundational scorer;
- statistically strong claims from single-run smoke campaigns;
- exact isolation of a model from the agent harness surrounding it; and
- distributed scheduling or a hosted control plane.

## 3. System model

The system has six durable layers:

```text
TaskSpec + SuiteSpec
        |
        v
Materialized problem state + isolated evaluator
        |
        v
ExperimentSpec + campaign preflight
        |
        v
Deterministic runner -> immutable ResolvedRunRequest
        |
        v
Harness adapter -> agent workspace -> immutable run artifacts
        |
        v
Evaluation -> RunResult -> derived index and reports
```

Three specifications carry different responsibilities:

- **Framework spec:** this document and the schemas that govern semantics.
- **Task and suite specs:** what work exists and how it is evaluated.
- **Experiment spec:** which task suite and agent configurations are run.

Time is not a manipulated experiment axis in v0. Each campaign and run records
its observation time, and reports use those records to show historical trends.

## 4. Repository model

The intended repository layout is:

```text
SPEC.md
spec/
  schemas/
  examples/
tasks/
  <task-id>/
    <task-version>/
      task.yaml
      prompt.md
      state/
      evaluator/
suites/
  <suite-id>/<suite-version>.yaml
experiments/
  <experiment-id>/<experiment-version>.yaml
harnesses/
  codex-cli/
  pi-cli/
  claude-code/
runner/
reports/
results/
```

JSON and YAML manifests MAY both be accepted. They MUST validate against the
same JSON Schemas and normalize to the same JSON data model. Readers MUST reject
duplicate object keys. Repository paths in manifests use `/` separators and are
relative to the repository root unless a field explicitly says otherwise.

YAML readers MUST reject duplicate mapping keys, non-string mapping keys,
custom tags, and values that cannot be represented by the JSON data model. This
keeps canonical manifest digests independent of parser-specific YAML behavior.

`results/` holds immutable source artifacts. A SQLite database and rendered
reports are derived projections and MUST be rebuildable from those artifacts.

## 5. Identity, versions, and fingerprints

### 5.1 Identifiers

Task, suite, experiment, configuration, check, and adapter IDs use lowercase
kebab-case. IDs describe identity; display names may change independently.

### 5.2 Schema versions

Every manifest contains `schema_version`. Schema versions follow semantic
versioning. A reader MUST reject an unsupported major version and SHOULD reject
unknown fields unless they occur under an explicit `extensions` object.

### 5.3 Artifact versions

Task, suite, and experiment versions follow semantic versioning but are treated
as opaque immutable release identifiers. Any change capable of affecting an
agent's behavior or score requires a new version, including changes to:

- prompt wording;
- initial workspace contents;
- runtime or setup behavior;
- evaluator code;
- checks, weights, or pass criteria; or
- required completion behavior.

Typographical or descriptive metadata changes SHOULD also create a new version
after release so historical artifacts remain byte-addressable.

### 5.4 Digests

Released artifacts are identified with `sha256:<lowercase-hex>` digests.

- Manifest digests use canonical JSON as defined by RFC 8785, regardless of
  whether the source file is JSON or YAML.
- Prompt digests cover the exact UTF-8 bytes delivered as the user prompt.
- OCI environments use the registry-provided immutable image digest.
- State and evaluator directories use `tree-sha256-v1`.

`tree-sha256-v1` walks the tree without following symlinks, excludes `.git`,
normalizes relative paths to NFC Unicode with `/` separators, sorts entries by
normalized path, and represents each entry as:

```json
["file", "path", "mode", "sha256-of-content"]
["symlink", "path", "target"]
["directory", "path"]
```

The complete entry array is encoded as RFC 8785 canonical JSON and hashed with
SHA-256. File mode records only `regular` or `executable`; ownership, timestamps,
platform ACLs, and other host metadata are excluded. A directory entry is
required only for an empty directory. Duplicate normalized paths and paths that
escape the root are invalid.

The validator implementation for each digest algorithm is normative once
released. Changing an algorithm requires a new algorithm ID.

## 6. Task specification and lifecycle

A `TaskSpec` describes one scored programming problem. Its structural contract
is [task.schema.json](spec/schemas/task.schema.json).

### 6.1 Required concepts

Each task defines:

- identity, version, lifecycle status, title, and summary;
- category, tags, and implementation languages;
- the agent-visible prompt;
- the initial problem-state source and expected materialized digest;
- the execution environment and network policy;
- evaluator command and result location;
- weighted scoring checks and pass rules; and
- default execution limits.

### 6.2 Lifecycle

Task status is one of:

1. `draft`: intent is specified first; artifacts or digests may be incomplete.
2. `candidate`: all artifacts resolve and validation passes; calibration may
   still be in progress.
3. `released`: immutable and eligible for released suites.
4. `retired`: immutable and retained for historical interpretation, but not
   selected for new suites.

This lifecycle makes spec-first changes concrete. A new task begins as a draft
spec containing at least its objective, category, intended prompt, environment,
checks, and limits. State and evaluator work follows that contract. Promotion
to `candidate` requires all mandatory digests. Promotion to `released` requires
calibration evidence and a versioned suite decision.

Released and retired task directories MUST NOT be edited in place. Corrections
create a new task version.

### 6.3 Categories

The initial category vocabulary is:

- `build`
- `bugfix`
- `feature`
- `tests`
- `integration`
- `concurrency`
- `refactor`
- `repair`

Adding a category requires updating this spec and schema before using it in a
task.

## 7. Problem-state correspondence

Each candidate or released `task-id@version` MUST resolve to exactly one
materialized initial tree digest. The source MAY be:

- a checked-in directory;
- an archive with an immutable content digest; or
- a Git repository pinned to an immutable revision, optionally plus pinned
  patch artifacts.

V0 released tasks SHOULD use checked-in directories to minimize external
availability and setup variance.

Materialization MUST occur in a fresh directory. The runner MUST verify the
materialized tree before the agent starts. A digest mismatch invalidates the run
as an environment error; it is never an agent failure.

For v0, each checked-in `tasks/<id>/<version>/state/` directory belongs to the
co-located task version. Candidate and released state directories without a
co-located task spec are invalid. Shared states MAY be introduced later only
through an explicit shared-state manifest and schema change.

Setup commands run after source materialization. If setup changes files visible
to the agent, the post-setup tree digest MUST also be recorded in `RunResult`.
Secrets and benchmark evaluator files MUST NOT be introduced into the agent
workspace by setup.

## 8. Agent-visible boundary

The agent receives:

1. the exact bytes of `prompt.md` as its user instruction;
2. the materialized problem workspace;
3. task-owned repository guidance such as `AGENTS.md`, if included in that
   problem state; and
4. the ordinary tools and native system instructions supplied by its harness.

The agent does not receive through the benchmark runner:

- the full `TaskSpec`;
- evaluator source or private evaluator dependencies;
- check weights or benchmark-only check descriptions;
- experiment comparison labels or baseline identities;
- candidate/reference patches; or
- results from other configurations.

Tasks and evaluators are public in this demo, and network use may make them
discoverable. V0 does not claim anti-gaming protection. The separation above is
still required so accidental prompt leakage does not become part of the
baseline protocol.

## 9. Environment and access policy

Canonical task environments SHOULD be pinned OCI images on Linux. Local host
runs are allowed for development, but MUST be marked non-canonical and MUST NOT
be mixed silently into canonical headline comparisons.

Normal agent network access is enabled for the initial demo. Each task declares
one of:

- `enabled`: ordinary outbound access;
- `disabled`: no outbound access; or
- `restricted`: only the declared allowlist and methods.

Credentials required to invoke the model are part of the harness control plane,
not the task workspace. Other secrets MUST be explicitly declared by name and
MUST NOT be included in artifacts or exposed to evaluators unnecessarily.

Harnesses SHOULD receive equivalent task-level filesystem, environment, and
network capabilities. Harness-native tools and system instructions remain
intact because the evaluated unit is the production agent system, not a bare
model.

The execution topology is part of run provenance. Local host runs use the
harness sandbox and MUST be marked non-canonical. Canonical runs MUST place the
harness and task workspace inside an ephemeral Linux container or virtual
machine with bounded resources and no unrelated host mounts or credentials.
Using both outer isolation and a harness-native sandbox is allowed and MUST be
recorded.

Model credentials belong to the control plane. A canonical runner MUST NOT make
long-lived model credentials readable from the agent workspace or from commands
the agent can execute. If a harness cannot invoke the model without exposing a
credential file or environment value to an unrestricted agent process, that
process MUST retain a sandbox that protects the credential. Full-access mode is
not permitted merely because the task and evaluator are public.

## 10. Evaluator contract

The evaluator is trusted benchmark code that runs after agent execution. It is
never mounted into the agent workspace while the agent is active.

By default, evaluation uses the task's pinned runtime with the final workspace
and evaluator bundle mounted at their declared locations. A future separate
evaluator runtime would require an explicit schema and framework revision.

The runner invokes the evaluator command without implicit shell expansion. A
task needing shell syntax must request it explicitly, for example
`["sh", "-lc", "..."]`.

The evaluator:

- MUST operate on a copy or read-only snapshot of the final workspace unless
  mutation is explicitly required;
- MUST enforce its timeout;
- MUST write a result conforming to
  [evaluation.schema.json](spec/schemas/evaluation.schema.json);
- MUST emit exactly one result for every check declared in the `TaskSpec`;
- MUST reject unknown check IDs;
- MUST avoid model calls and subjective grading in v0; and
- SHOULD be deterministic across at least three clean repetitions.

The runner SHOULD attempt evaluation whenever a salvageable final workspace
exists, including after agent timeout or budget exhaustion. This preserves
partial-progress information.

An evaluator crash, timeout, malformed result, missing check, or unknown check
invalidates evaluation and is classified as `evaluator_error`. It MUST NOT be
converted into a zero agent score.

## 11. Scoring

Each declared check has a positive weight and receives an evaluator score in the
closed interval `[0, 1]`.

For task `t` with checks `i`, the artifact-quality score is:

```text
task_score(t) = sum(weight_i * check_score_i) / sum(weight_i)
```

The stored normalized score is in `[0, 1]`; reports may display it as 0–100.

A task's evaluator criteria pass when:

1. `task_score >= pass_threshold`; and
2. every check marked `required` reports `passed = true`.

By default, an end-to-end run passes only when the evaluator criteria pass and
the agent terminates normally with an agent-declared completion. A task may set
`require_agent_completion` to false, but this SHOULD be rare.

This creates two separately reported facts:

- **artifact quality:** how correct the final workspace is, including partial
  work after a timeout; and
- **end-to-end pass:** whether the artifact passed and the agent completed the
  production protocol.

### 11.1 Suite aggregation

For one configuration and task, the task score is the arithmetic mean over
scorable repetitions. Task pass rate is passed repetitions divided by attempted
repetitions.

The suite headline score is the weighted arithmetic mean of task scores, using
the task weights in `SuiteSpec`. Initial suites SHOULD weight tasks equally.

Reports MUST show at least:

- headline score;
- end-to-end pass rate;
- operational completion rate;
- invalid/infrastructure run count;
- median wall time;
- token usage when available; and
- cost when available.

One number MUST NOT erase the component metrics.

### 11.2 Invalid and failed runs

- Incorrect completed work is scorable and may receive any evaluator score.
- Timeout, token exhaustion, tool exhaustion, or agent-declared failure remains
  scorable if evaluation succeeds.
- Provider, harness, environment, evaluator, runner, and operator failures are
  excluded from the quality-score denominator and reported separately.
- Operational reports MUST still count those failures so an unreliable system
  cannot appear healthy through exclusion alone.

## 12. Suites

A `SuiteSpec` is an immutable, ordered set of released task references and
weights. Its structure is defined in
[suite.schema.json](spec/schemas/suite.schema.json).

A released suite MUST reference exact task versions and canonical task-spec
digests. A suite validator MUST confirm that every referenced task is released
and that its prompt, state, environment, and evaluator artifacts verify.

New tasks create a new suite version. Old suite versions remain runnable. Tasks
marked `anchor = true` form the preferred common subset for qualified
cross-suite historical comparisons.

## 13. Experiments and campaigns

An `ExperimentSpec` defines a reusable evaluation plan. A **campaign** is one
timestamped execution of that plan.

The experiment structure is defined in
[experiment.schema.json](spec/schemas/experiment.schema.json). It selects:

- one exact suite version and digest;
- an optional task subset;
- explicit agent configurations;
- repetitions;
- run ordering and random seed;
- default limits and allowed per-configuration overrides; and
- requested report comparisons.

Before scheduling attempts, campaign preflight MUST resolve and fingerprint the
runner runtime and every harness runtime. It records whether each runtime was
preinstalled, found in a cache, or installed. This work is campaign provenance,
not agent execution time. Preflight, scheduling, indexing, and reporting errors
are retained as structured campaign errors even when no run can be created.
The runtime digest identifies the resolved package or installation tree; the
executable digest identifies the exact entry point invoked from that runtime.

### 13.1 Explicit configurations

The framework uses an explicit list of configurations instead of assuming a
complete Cartesian product. A configuration contains:

- harness family and interface;
- harness adapter and runtime versions;
- model provider, requested model ID, and optional expected snapshot ID;
- a display label and native value for reasoning effort;
- execution limits; and
- harness-specific configuration under a namespaced object.

This representation permits unsupported or unavailable matrix cells to remain
explicit rather than generating invalid runs.

Effort display labels enable report cuts such as `low`, `medium`, and `high`, but
they do not assert semantic equivalence across harnesses. Reports MUST retain the
native effort value.

### 13.2 Repetitions

- Development smoke experiments use one repetition per task/configuration cell.
- Stabilized benchmark campaigns SHOULD use at least five repetitions.
- Benchmark order SHOULD be randomized using a recorded seed.
- Repetition index and scheduling order MUST be recorded in each run.

Single-run results MUST be labeled as smoke evidence and not presented as
statistically stable rankings.

## 14. Historical comparison

Every campaign records an RFC 3339 UTC observation timestamp. Every run also
records start and finish timestamps.

Historical comparisons are valid without qualification only when they use:

- the same task and suite versions;
- matching problem-state, prompt, evaluator, and environment digests;
- the same harness family and interface;
- known harness and adapter versions;
- a matching canonical execution topology and environment; and
- the same requested model identity and native effort configuration.

When a provider exposes a resolved model snapshot, the runner MUST record it.
When only a mutable alias is available, the result MUST retain the alias and
mark snapshot identity as unavailable. Reports MUST not imply exact model
stability in that case.

Cross-suite reports MUST use an explicitly labeled common anchor subset or show
the suite versions as separate series. They MUST NOT connect incompatible
headline scores as though the benchmark were unchanged.

## 15. Deterministic control plane and runner

The authoritative runner MUST be ordinary deterministic program code. A model
or coding agent MUST NOT own experiment expansion, run ordering, retry policy,
limit enforcement, terminal classification, artifact finalization, evaluation,
scoring, or report aggregation. Using an agent for those decisions would add an
uncontrolled model-harness system to the benchmark control plane.

The runner SHOULD expose a small typed command surface equivalent to:

```text
validate -> materialize -> run -> evaluate -> index -> report
```

The implementation MAY be launched through a script, but durable behavior MUST
live in testable program modules rather than ad hoc shell orchestration. Each
state transition MUST be determined by validated inputs and recorded state.
Operations SHOULD be idempotent and resumable; an interrupted run MUST never
silently overwrite a finalized artifact.

An optional operator agent MAY select an already-defined experiment, invoke the
deterministic runner, summarize results, or investigate failures. Its prompts,
commands, and interventions MUST be recorded when they affect execution. It
MUST NOT calculate authoritative scores, change evaluator output, mutate
finalized source artifacts, or make an unrecorded retry or exclusion decision.

Every attempt receives a distinct run ID. A retry or resume records its parent
run, attempt number, initiator, and reason. Retries never replace the original
attempt and are not silently substituted into aggregates. V0 performs no
automatic retries. Operator-initiated retries and resumes are diagnostic runs
and are excluded from headline quality aggregates unless a future experiment
schema defines an explicit selection policy.

Before materialization, the runner MUST finalize a resolved request conforming
to [run-request.schema.json](spec/schemas/run-request.schema.json). The request
records the exact task and experiment inputs, resolved harness configuration,
execution topology, sanitized environment, exact argv, stdin digest, limits,
and scheduling coordinates. Secret values MUST NOT appear in the request;
declared secret names and redacted placeholders are sufficient.

The runner, rather than the harness adapter, asserts and verifies execution
topology. Semantic validation MUST reject disagreement between invocation flags
and normalized fields—for example, a bypass-sandbox argv with
`full_access = false`, or a runtime version that differs from campaign
preflight.

## 16. Harness adapter contract

Each adapter accepts a resolved run request containing:

- workspace path;
- exact prompt bytes;
- requested model and native effort value;
- task access policy;
- execution limits;
- controlled environment variables; and
- artifact output paths.

Each adapter returns or records:

- exact adapter and harness runtime versions;
- raw harness event stream;
- stdout and stderr;
- final agent message;
- terminal reason and attribution;
- start, finish, and wall-clock duration;
- model identity reported by the harness, if available;
- native token, tool-call, and cost counters, if available; and
- the final workspace without cleaning agent changes.

Adapters MUST preserve raw native events even when normalized events are also
produced. A normalized metric that the harness cannot provide is marked
`unavailable` with a reason; adapters MUST NOT fabricate cross-harness
equivalents.

Recorded effective configuration MUST contain no authentication material or
secret values. Secret names and redacted placeholders may be recorded when they
are needed to interpret a run.

The harness's native system instructions and ordinary tools SHOULD remain
unchanged. Personal user configuration, memories, undeclared MCP servers,
plugins, and skills MUST be excluded from canonical campaigns.

Harness runtime versions in benchmark experiments MUST be immutable exact
versions. Mutable channels such as `latest` or `alpha` MAY be used during local
development only if campaign preflight resolves them to an exact version before
creating run requests. Package download, installation, and cache warming happen
before the timed run and are recorded as campaign preflight, not agent time.

## 17. Initial Codex CLI adapter

The initial adapter identity is:

```yaml
harness_family: codex
runner_interface: cli-exec
```

It invokes the stable non-interactive `codex exec` interface. The normative
implementation SHOULD be equivalent to:

```text
codex exec
  --json
  --ephemeral
  --ignore-user-config
  --strict-config
  --sandbox workspace-write
  --model <requested-model>
  --ask-for-approval never
  -c model_reasoning_effort="<native-effort>"
  -c sandbox_workspace_write.network_access=true
  -C <workspace>
  -
```

The prompt is supplied on standard input. Argument construction MUST use an argv
array rather than concatenated shell text. Network configuration follows the
task policy rather than always using `true`.

Canonical runs use a controlled `CODEX_HOME` for authentication while excluding
personal configuration and extensions. The exact CLI version and effective
configuration are captured before the run.

For example, a development invocation through npm MAY resolve
`@openai/codex@alpha`, but the resolved package version MUST be recorded and a
benchmark experiment MUST invoke that exact version. Invoking a mutable dist-tag
independently for every run is invalid because the harness could change within
one campaign.

`--dangerously-bypass-approvals-and-sandbox` removes the Codex filesystem,
network, and approval boundary. It MUST NOT be used on a bare development host
by the benchmark runner. It MAY be used inside an externally hardened ephemeral
container or virtual machine only when the agent cannot read model credentials,
unrelated host files, other workspaces, or finalized results. Otherwise the
adapter uses `workspace-write`, `approval_policy = "never"`, and the task's
declared network policy.

The adapter maps a successful `turn.completed` event and clean process exit to
agent-declared completion. It captures JSONL events from stdout and diagnostic
output from stderr. A missing terminal event, nonzero exit, timeout, or malformed
stream is classified explicitly rather than inferred as incorrect code.

The Codex SDK or app-server MAY later replace subprocess control internally. If
the native agent behavior remains the same, that is a runner-interface revision,
not automatically a new harness family. Codex MCP orchestration, Codex cloud,
and custom Responses API agents are separate configurations because they add or
change orchestration and execution behavior.

Current interface references:

- <https://learn.chatgpt.com/docs/non-interactive-mode>
- <https://learn.chatgpt.com/docs/developer-commands?surface=cli>

## 18. Run lifecycle and failure taxonomy

The runner executes these stages:

1. Resolve and validate experiment, suite, task, and configuration.
2. Create a fresh run directory and finalize an immutable resolved request.
3. Materialize and verify the initial problem state.
4. Prepare the controlled task environment.
5. Launch the harness adapter and start the hard wall timer.
6. Capture events and resource observations until a terminal condition.
7. Snapshot the final workspace and compute its digest and patch.
8. Run the isolated evaluator whenever the workspace is salvageable.
9. Compute task score and pass state.
10. Atomically finalize `run.json` and artifact digests.

Terminal reasons are:

- `agent_completed`
- `wall_time_exhausted`
- `token_limit_exhausted`
- `tool_limit_exhausted`
- `agent_failed`
- `provider_error`
- `harness_error`
- `environment_error`
- `runner_error`
- `cancelled`

Terminal attribution is recorded separately as `agent`, `provider`, `harness`,
`environment`, `runner`, or `operator`. Evaluation has its own `ok`, `error`, or
`not-run` status, so a broken evaluator does not erase the fact that an agent
completed normally. The normalized result format is defined in
[run-result.schema.json](spec/schemas/run-result.schema.json).

The terminal record is the final summary, not the complete error log. Every
observed error MUST also be recorded structurally with its phase, stable code,
attribution, retryability, timestamp, message, and available process, signal,
or provider-request identifiers. Raw native errors remain in their source
artifacts. Sensitive values MUST be redacted.

## 19. Timing, usage, and resource observations

Run evidence has three layers:

1. raw native events, stdout, stderr, and evaluator output are authoritative;
2. `run.json` contains normalized cross-harness facts; and
3. SQLite indexes, summaries, and reports are rebuildable projections.

UTC timestamps establish historical ordering. Durations MUST be measured with a
monotonic clock so wall-clock adjustments cannot change elapsed time. The run's
`started_at` is captured immediately after the resolved request is finalized;
`finished_at` is captured after all measured phases and immediately before the
result is published by atomic rename. `wall_time_ms` spans those boundaries.

The runner SHOULD record durations for materialization, setup, harness startup,
agent execution, evaluation, workspace snapshotting, and finalization. It SHOULD
also record time to first harness event, first agent output, and first tool call
from harness launch when those events are observable. Missing phases remain
absent rather than zero.

Tokens, tool usage, cost, and resources each record a status of `complete`,
`partial`, or `unavailable`, plus their source. `unavailable` requires a reason.
`partial` means at least one observation exists but the adapter cannot claim a
complete run total and therefore also requires a limitation reason. A timeout
without a final native usage event is normally partial or unavailable, never
silently zero. Harness counters MUST retain native semantics; adapters MUST NOT
invent comparable values.

Each adapter version MUST document the observations required for it to claim a
`complete` resource record. If any required observation is missing, the record
is `partial` and states the limitation, even when the schema permits a different
field set for another execution environment.

Normalized resource observations SHOULD include CPU time, peak resident memory,
filesystem bytes read and written, network bytes sent and received, and initial
and final workspace sizes when the execution environment can measure them
reliably. Unsupported metrics are explicitly unavailable. The host fingerprint
records at least operating system and architecture and SHOULD include kernel,
CPU, logical processor count, total memory, locale, and timezone.

## 20. Limits and completion

Normal completion is agent-declared. Every run also has a hard wall-time limit.
Token and tool-call limits MAY be hard, soft, or observe-only depending on the
harness; their enforcement mode MUST be recorded.

`limits.wall_time_seconds` bounds the harness/agent execution phase beginning at
adapter launch. `metrics.timing.wall_time_ms` measures the entire attempt after
request finalization, including materialization, setup, snapshot, evaluation,
and result preparation. Reports SHOULD expose both the agent phase and the
end-to-end attempt duration.

The controller MUST terminate a run that exceeds a hard limit and preserve the
partial workspace and event log. Limits are part of the experiment
configuration and therefore part of comparison provenance.

## 21. Artifact layout

A campaign SHOULD produce:

```text
results/<experiment-id>/<campaign-id>/
  campaign.json
  runs/<run-id>/
    request.json
    run.json
    events.native.jsonl
    stdout.log
    stderr.log
    final-message.txt
    workspace.patch
    workspace-tree.json
    evaluator.json
  reports/
```

`campaign.json`, `request.json`, `run.json`, native events, and evaluator output
are source artifacts. `request.json` and `run.json` MUST validate against their
schemas. The final `run.json` MUST contain digests for every artifact it
references. Finalization SHOULD use a temporary file plus atomic rename so
incomplete runs cannot masquerade as complete records.

Finalized `campaign.json` MUST validate against
[campaign.schema.json](spec/schemas/campaign.schema.json). It records the exact
experiment and suite, observation time, runner and harness preflight provenance,
campaign errors, run-result digests, and operational summary. Summary counts are
cached derivations and MUST be verified against the referenced run results when
reports are rebuilt.

Sensitive environment values, authentication tokens, and unrelated host paths
MUST be redacted before artifact persistence.

## 22. Reporting and release QA

The initial report surface MUST support:

1. headline score and pass rate by model-harness configuration;
2. same-model comparisons across harnesses;
3. historical score by campaign observation time;
4. score and pass rate by task, category, and language;
5. effort versus quality, wall time, tokens, and cost;
6. per-task candidate-versus-baseline deltas;
7. operational failure counts by reason and attribution;
8. retry and resume counts without silently replacing original attempts; and
9. metric completeness and resource observations when available.

A comparison identifies an explicit baseline configuration and one or more
candidates. The report MUST show paired task deltas before aggregate deltas.
When harnesses differ, the comparison is between complete model-harness systems;
it MUST NOT be described as isolating a pure harness effect unless every other
material input is demonstrably controlled.
Release gates may initially be informational, but the data model should support:

- minimum headline score or score delta;
- minimum pass rate;
- maximum allowed per-task regression;
- maximum operational error rate; and
- required task or category passes.

## 23. Spec-first authoring and validation

Adding a task follows this order:

1. Add or revise this framework spec/schema if the task needs a new concept.
2. Add a `draft` TaskSpec describing intent, prompt, checks, and limits.
3. Build the prompt, state, environment, and evaluator to satisfy the draft.
4. Materialize artifacts and stamp their digests.
5. Promote to `candidate` and run structural and cross-file validation.
6. Calibrate the task using an untouched baseline, a known-good solution, and at
   least one plausible partial solution.
7. Verify evaluator determinism across three clean runs.
8. Promote the immutable task to `released` and add it to a new suite version.

CI MUST eventually enforce:

- schema validity;
- unique IDs and versions;
- path safety;
- digest correctness;
- no orphan candidate/released problem states or evaluators;
- exact evaluator check-ID correspondence;
- released-suite references to released tasks only;
- calibration evidence presence;
- no mutation of released artifact versions;
- resolved-request and run-result validity;
- explicit unavailable or partial metric status rather than omitted totals; and
- example-manifest validity.

## 24. Initial breadth-first suite

The first suite should contain approximately eight modest tasks:

| Category | Example shape | Initial language |
| --- | --- | --- |
| build | Build a small end-to-end CLI | Python |
| bugfix | Fix a subtle edge-case or state bug | Go |
| feature | Complete a partially implemented feature | TypeScript |
| tests | Add tests that detect seeded faults | Python |
| integration | Complete a small API or library integration | TypeScript |
| concurrency | Repair a race or coordination defect | Go |
| refactor | Restructure code while preserving behavior | TypeScript |
| repair | Diagnose and fix a broken build or configuration | Go or Python |

Tasks SHOULD be solvable using normal repository discovery and documentation,
fit within a modest wall-time budget, and avoid exotic domain knowledge. The
suite SHOULD vary codebase shape and failure mode without allowing environment
setup to dominate the result.

For `tests` tasks, evaluators SHOULD measure whether the submitted tests detect
known fault variants or mutations, while also verifying that the tests pass on
the correct implementation. Counting new test lines or accepting a green test
command alone is not a sufficient score.

## 25. Framework acceptance criteria

The first implemented milestone is complete when:

1. all manifests validate structurally and across references;
2. the deterministic runner finalizes a validated resolved request before each
   attempt;
3. one released task can be materialized reproducibly;
4. an exact pinned `codex exec` version can run it non-interactively with
   captured JSONL;
5. the evaluator produces a deterministic weighted score;
6. timing, token, tool, cost, and resource measurements record complete,
   partial, or unavailable status without fabricated values;
7. structured errors distinguish agent, provider, harness, environment,
   evaluator, runner, and operator failures;
8. a timeout preserves and scores partial work;
9. retry and resume attempts preserve lineage without replacing prior results;
10. local runs are marked non-canonical and unsafe full-access execution is
    rejected unless an outer isolation boundary and credential protection are
    proven;
11. repeated campaigns create immutable timestamped results;
12. a static report compares at least two Codex model/effort configurations;
    and
13. the report distinguishes agent outcomes from benchmark infrastructure
    errors.
