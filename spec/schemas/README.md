# Schema catalog

These JSON Schemas use JSON Schema Draft 2020-12.

| Schema | Purpose |
| --- | --- |
| `common.schema.json` | Shared identifiers, limits, topology, errors, and artifacts |
| `task.schema.json` | Versioned programming-task contract |
| `suite.schema.json` | Immutable ordered task suite |
| `experiment.schema.json` | Evaluation matrix and report comparisons |
| `campaign.schema.json` | Finalized timestamped execution of an experiment |
| `run-request.schema.json` | Immutable resolved execution request for one attempt |
| `evaluation.schema.json` | Trusted evaluator output |
| `run-result.schema.json` | Normalized immutable result, telemetry, and errors |

Schema validation establishes document shape. The future repository validator
must also enforce cross-file semantics described in `SPEC.md`, including digest
verification, released-artifact immutability, unique IDs, exact evaluator check
correspondence, execution-policy consistency, and released suite/task status.

The JSON documents under `../examples/` are structural examples only. Their
placeholder digests do not identify real repository artifacts.
