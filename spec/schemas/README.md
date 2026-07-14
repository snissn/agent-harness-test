# Schema catalog

These JSON Schemas use JSON Schema Draft 2020-12.

| Schema | Purpose |
| --- | --- |
| `common.schema.json` | Shared identifiers, references, limits, and artifacts |
| `task.schema.json` | Versioned programming-task contract |
| `suite.schema.json` | Immutable ordered task suite |
| `experiment.schema.json` | Evaluation matrix and report comparisons |
| `campaign.schema.json` | Finalized timestamped execution of an experiment |
| `evaluation.schema.json` | Trusted evaluator output |
| `run-result.schema.json` | Normalized immutable run result |

Schema validation establishes document shape. The future repository validator
must also enforce cross-file semantics described in `SPEC.md`, including digest
verification, released-artifact immutability, unique IDs, exact evaluator check
correspondence, and released suite/task status.

The JSON documents under `../examples/` are structural examples only. Their
placeholder digests do not identify real repository artifacts.
