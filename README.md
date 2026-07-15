# Agent Harness Test

Agent Harness Test is a spec-first evaluation system for coding agents. It is
intended to demonstrate what good inference operations can look like for model
release QA and end-to-end production-agent evaluation.

The system evaluates ordinary software-engineering work—building a small tool,
fixing a subtle defect, completing a feature, adding effective tests, and
similar tasks—against deterministic, versioned evaluators. It records enough
provenance to compare models, reasoning-effort settings, and agent harnesses
both within one campaign and across historical campaigns.

The initial harness is the non-interactive Codex CLI (`codex exec`). The design
keeps harness adapters modular so Pi, Claude Code, and future systems can be
added without changing task definitions.

## Current status

This repository contains the `0.2.0-draft` framework contract, schemas,
deterministic validation/CI gate, and a provider-free deterministic runner.

## Start here

- [SPEC.md](SPEC.md) is the normative framework specification.
- [spec/schemas](spec/schemas) contains JSON Schemas for manifests and results.
- [spec/examples](spec/examples) contains non-runnable structural examples.
- [docs/validation.md](docs/validation.md) documents the deterministic local and CI validation gate.
- `npm run runner:fake -- request.json state/ output/ success` exercises the
  typed request → materialize → fake harness → evaluator → immutable `run.json`
  path without a live provider. Output directories must be fresh: finalized
  artifacts are never overwritten.
- `npm run runner:fake -- inspect <run-directory>` safely reports whether an
  interrupted attempt has a finalized result (exit `0`) or remains incomplete
  (exit `2`); it never repairs or overwrites evidence.
- `npm run runner:fake -- recover <parent-request.json> <parent-run.json>
<state-dir> <output-root> <retry|resume> <new-run-id> <reason> [scenario]` is an explicit,
  operator-initiated diagnostic attempt. It creates a distinct run ID with
  parent lineage and attempt number two; the runner never retries or resumes
  automatically. The request must already contain the correct state, prompt,
  and stdin digests—the CLI does not rewrite finalized request facts.

## Rebuild the local report

The SQLite index and static report are disposable derived projections. From a
checkout containing `results/`, run:

```sh
npm run report:rebuild
open reports/index.html
```

This revalidates each campaign/run/request/evaluator schema, cross-file identity,
campaign run digest, cached campaign summary, and retained artifact digest and
byte count while walking source artifacts in stable order. It writes
`reports/index.sqlite`, `reports/report-data.json`, and a self-contained
`reports/index.html`; deleting `reports/` and rerunning is safe. Invalid source
records are quarantined in `report-data.json` and `ingestion_errors` rather
than contributing valid aggregate rows. Quality/headline and end-to-end-pass
denominators include only initial attempts eligible for quality aggregation;
operational completion includes all initial attempts. Retry/resume attempts,
unavailable telemetry, local/non-canonical topology, unsnapshotted model IDs,
and one-repetition smoke data are visibly qualified rather than normalized.
Historical points connect only within an exact suite/task/harness/model/effort/
topology identity; incompatible identities remain separate series. Campaign
identity is scoped by experiment, so distinct experiments may reuse a local
campaign ID without colliding in the projection.

No provider credentials are needed to rebuild or open the report.

## Deploy the report to Cloudflare

The public site is an assets-only Cloudflare Worker containing a snapshot of
the generated report. It does not run agents, expose evaluator internals, or
require provider credentials.

For a Git-connected Workers deployment, use these settings:

- **Build command:** `npm run build`
- **Deploy command:** `npm run deploy`
- **Production branch:** `main`

The checked-in `.node-version` selects Node.js 24 in Cloudflare Builds, and
`wrangler.jsonc` publishes `dist/` as static assets. Preview builds for
non-production branches are optional. To verify the complete build and deploy
configuration without publishing anything, run:

```sh
npm ci
npm run build
npm run deploy:dry-run
```

The generated `dist/` directory is disposable and ignored by Git. Each deploy
rebuilds it from the versioned source artifacts in the checkout.

## Runner contracts

Adapters receive an immutable resolved request, workspace, exact prompt bytes,
and abort signal. The runner owns the hard wall timer: on expiry it aborts and
calls the adapter's `terminate("wall_time_exhausted")` hook, then preserves the
partial workspace and ignores any late adapter result. Adapters must make that
hook kill their process/process group when abort is insufficient.

The evaluator receives a protected copy of the final workspace. Its raw output
must validate against `evaluation.schema.json` and match the task check IDs
exactly; evaluator mutation cannot alter retained evidence. Artifact target
paths come from the request, tree manifests are deterministic, and the patch
records the initial-to-final manifest delta. `secret_names` records variable
names only. Runtime secret values are passed separately as non-persisted
redaction controls and are scanned/redacted before every durable artifact is
published.

The fake-fixture characterization is observational, not a product-performance
claim: the lifecycle test records monotonic per-phase timings in `run.json`,
plus initial/final workspace byte counts. On this local checkout the complete
schema-valid success fixture test took about 121 ms; this includes Node startup,
schema loading, filesystem work, and test harness overhead, so it is useful only
for detecting accidental pathological runner overhead on the same fixture.

## Core principles

- Specifications precede fixtures and implementation.
- A deterministic program owns execution and scoring; an agent may operate or
  investigate the runner but never becomes the benchmark control plane.
- Released task and suite versions are immutable.
- Every runnable task resolves to fingerprinted prompt, problem-state,
  environment, and evaluator artifacts.
- Agents see the task prompt and problem workspace, not the benchmark control
  plane or evaluator.
- Correctness, pass rate, operational reliability, time, tokens, and cost remain
  separately inspectable even when a headline score is shown.
- Missing usage and resource metrics are explicitly complete, partial, or
  unavailable; absent telemetry is never reported as zero.
- Canonical runs use an isolated, fingerprinted environment. Local host runs are
  useful but explicitly non-canonical.
- Raw run artifacts are authoritative; databases and reports are rebuildable
  projections.
- Historical comparisons use an unchanged suite version or an explicitly
  identified common anchor set.

## Intended implementation sequence

1. Implement schema and cross-file validation, resolved run requests, and
   canonical digests.
2. Implement one end-to-end task and the `codex exec` adapter.
3. Expand to a small breadth-first suite across Python, TypeScript, and Go.
4. Add historical reports and candidate-versus-baseline release views.
5. Add Pi and Claude Code adapters using the same task and result contracts.
