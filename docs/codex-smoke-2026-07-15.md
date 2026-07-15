# Codex text-report local smoke

This is non-canonical, one-repetition smoke evidence; it is not statistically
stable and must not be used for a ranking claim. The adapter used Codex CLI
`0.145.0-alpha.11` with `--json`, `--ephemeral`, `--ignore-user-config`,
`--ignore-rules`, `--strict-config`, `--skip-git-repo-check`,
`--sandbox workspace-write`, and configuration overrides for `approval_policy`
`never`, native reasoning effort, and disabled task network access. It did not
use either dangerous-bypass flag.

The initially prepared medium workspace was rejected before provider contact
because a materialized task workspace is not a Git repository. That setup-only
preflight evidence is excluded from campaign counting. The corrected two-call
campaign used a controlled `CODEX_HOME` containing authentication only and
ignored personal configuration.

| Configuration | Provider call | Native terminal | Evaluator score | Qualification |
| --- | ---: | --- | ---: | --- |
| `codex-medium` | 1 | `turn.completed` | 1.00 | completed and scored |
| `codex-high` | 2 | `turn.completed` | not scored | retained, but environment-contaminated |

Native usage reported: medium input 129756 (cached 93696), output 3463,
reasoning output 1307; high input 150805 (cached 107776), output 3913,
reasoning output 1983. The high capture is not a quality observation: native
events show evaluator-created `evaluator.json`, `sample.txt`, and `filter.txt`
appearing mid-run and being read by the agent. It is retained for provenance
only and classified as an environment error with evaluation not run. Cost and
resource telemetry were not reported and remain unavailable rather than zero.

## Canonical offline finalization

The checked-in campaign is
`results/codex-text-report-smoke/2026-07-15-codex-text-report-smoke/`. It is
created by replaying only the task file from the retained captures and JSONL through
the deterministic runner; it does not start Codex, contact a provider, or claim
that the runner launched the original two manual calls. Native events and local
path strings are redacted in the immutable artifacts.

The capture has no monotonic live wall duration or startup-latency samples.
Consequently each canonical run marks timing unavailable rather than treating
the short offline replay as agent execution time. The runner result timestamps
identify canonical finalization, while the evaluator artifact retains its
captured completion timestamp.

To re-finalize from the retained captures (which are deliberately not checked
in), provide the exact recorded Codex executable so its fingerprint is derived
without running it:

```sh
RUNNER_GIT_COMMIT="$(git rev-parse HEAD)" \
  npx tsx tools/finalize-codex-smoke.ts . /path/to/captures "$(command -v codex)"
npm run validate
```
