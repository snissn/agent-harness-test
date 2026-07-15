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
