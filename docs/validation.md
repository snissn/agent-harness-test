# Validation and CI

CI pins Node `24.12.0` in `.github/workflows/validation.yml`. `package.json`
declares npm `11.7.0` through `packageManager` and supported Node 24/npm 11
ranges through `engines`. From a fresh checkout, run:

```sh
npm ci
npm run typecheck
npm test
npm run validate
```

`npm run validate` loads canonical checked-in JSON/YAML manifests under the
repository layout plus all structural examples. Suite and experiment manifests
must use their versioned canonical paths; task and result source manifests must
use the complete canonical layouts defined in `SPEC.md`. JSON files under any
`reports/` directory are never inferred as source manifests, even when their
name or nested directories resemble one. Validation rejects duplicate keys, YAML tags,
anchors, aliases, merge keys, non-string mapping keys, non-JSON YAML values,
unsafe/escaping paths, schema errors, and the implemented
cross-file invariants. Diagnostics use `file [rule] path: message` and exit
nonzero on any invalid input. Validate one named file structurally with
`npm run validate:file -- tasks/<id>/<version>/task.yaml`. The one-file command
also retains `run-request.json` and `run-result.json` as explicit standalone
filename aliases; repository discovery does not recognize those aliases.

Task authors should add a failing fixture/test first, update `SPEC.md` and its
schema before using a new concept, then add the valid manifest/artifacts and
digest expectations. Candidate/released tasks must have co-located state and
evaluator trees. Draft tasks may declare URI-only archive sources, but candidate,
released, and retired archive sources require repository-verifiable path bytes.
Released suites reference released tasks and their RFC 8785
manifest digests. Campaign, run-request, and run-result experiment/suite/task
references must resolve the exact loaded manifest path and digest. Run task
references also pin the TaskSpec prompt, initial-state, and evaluator digests;
run-request workspace fingerprints and network policy must exactly agree with the
same TaskSpec. Campaign and run suites must equal their experiment's pinned suite;
run tasks must belong
to that suite and satisfy experiment selection. A run-request configuration must
exactly equal one experiment-declared configuration. Every run
result is joined to its co-located `request.json` by canonical digest and shared
run, campaign, experiment, suite, task, configuration, repetition, schedule, and
attempt identities. Its resolved harness, requested model identity, effort,
limits, and execution provenance must preserve the resolved request. When the
request pins `expected_snapshot_id`, the result must report an available snapshot
with that exact resolved ID; unpinned requests may retain result-only snapshot
resolution metadata. Successful
run results are also joined to their co-located
`evaluator.json`: validation checks its manifest digest, evaluator/task identity,
mirrored check results, scoring derivations, and end-to-end pass state. Only
quality-eligible terminal outcomes can pass end to end; evaluator scores remain
available for salvageable infrastructure and operator failures. Finalized
campaign summaries are recomputed only after every unique run reference verifies.
`recorded_runs` counts referenced results, `operational_successes` counts true
`terminal.operational_success` values, and the quality-eligible and end-to-end
counters use their corresponding run evaluation booleans. Quality eligibility is
verified from attempt lineage, evaluation status, and the terminal failure taxonomy;
operator-initiated retries and resumes are diagnostic and ineligible. Per SPEC section
11.2, `invalid_runs` narrowly counts results excluded from the quality denominator
(`eligible_for_quality_aggregate = false`); it is not inferred from planned run
counts or campaign status. This command deliberately does not run agents or
require provider credentials.

Resolved requests must also agree with deterministic control-plane provenance:
Codex `invocation.full_access` exactly tracks the documented sandbox-bypass argv
flag. The owning campaign must pin the request's exact experiment and suite, and
its preflight must match the invocation runtime version/package/executable
fingerprints for the request's harness and runtime source.

GitHub Actions runs the same fresh-install commands on pull requests and pushes
to `main`, with read-only repository permissions.
