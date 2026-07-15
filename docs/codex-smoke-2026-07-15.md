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
| `codex-high` | 2 | missing terminal | 1.00 salvage evaluation | native stream was incomplete; not retried |

The raw redacted workspace copies and JSONL evidence were retained during the
local campaign under `/tmp/issue4-medium` and `/tmp/issue4-high`. Token, cost,
and resource telemetry were not reported by the native event stream and are
therefore unavailable rather than zero.
