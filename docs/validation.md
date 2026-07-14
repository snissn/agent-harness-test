# Validation and CI

Node `24.12.0` and npm `11.7.0` are pinned by `package.json` and the committed
lockfile. From a fresh checkout, run:

```sh
npm ci
npm run typecheck
npm test
npm run validate
```

`npm run validate` loads canonical checked-in JSON/YAML manifests under the
repository layout plus all structural examples. Suite and experiment manifests
must use their versioned canonical paths; result source manifests use the exact
`campaign.json`, `request.json`, `run.json`, and `evaluator.json` names. Derived
report JSON, including summary filenames that merely contain a manifest kind,
is not treated as a source manifest. Validation rejects duplicate keys, YAML tags,
anchors, aliases, merge keys, non-string mapping keys, non-JSON YAML values,
unsafe/escaping paths, schema errors, and the implemented
cross-file invariants. Diagnostics use `file [rule] path: message` and exit
nonzero on any invalid input. Validate one named file structurally with
`npm run validate:file -- tasks/<id>/<version>/task.yaml`.

Task authors should add a failing fixture/test first, update `SPEC.md` and its
schema before using a new concept, then add the valid manifest/artifacts and
digest expectations. Candidate/released tasks must have co-located state and
evaluator trees; released suites reference released tasks and their RFC 8785
manifest digests. This command deliberately does not run agents or require
provider credentials.

GitHub Actions runs the same fresh-install commands on pull requests and pushes
to `main`, with read-only repository permissions.
