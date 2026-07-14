# Structural examples

These examples demonstrate how the schemas fit together. They are deliberately
not stored under `tasks/`, `suites/`, `experiments/`, or `results/`, so the
future cross-file validator must not treat them as runnable or released
artifacts.

All repeated hexadecimal digests are placeholders. The examples are expected to
pass their individual JSON Schemas, but their referenced files and digests are
not expected to resolve.

`run-request.example.json` and `run-result.example.json` share a run ID and show
the before/after contract for one attempt. They intentionally include realistic
provenance and telemetry shapes while retaining placeholder content digests.
