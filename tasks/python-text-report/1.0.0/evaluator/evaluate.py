#!/usr/bin/env python3
"""Protected deterministic evaluator for python-text-report; never copy into agent state."""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

TASK_ID = "python-text-report"
TASK_VERSION = "1.0.0"


def call(workspace, *args):
    return subprocess.run([sys.executable, str(Path(workspace) / "text_report.py"), *args], text=True, capture_output=True, timeout=10)


def check_summary(workspace):
    sample = Path(workspace) / "sample.txt"
    sample.write_text("Alpha beta alpha!\n\nBeta gamma\n", encoding="utf-8")
    result = call(workspace, "--input", str(sample), "--limit", "2")
    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError:
        output = None
    passed = result.returncode == 0 and output == {"line_count": 2, "word_count": 5, "top_words": [["alpha", 2], ["beta", 2]]}
    return passed, "normal summary output" if passed else "normal summary output was incorrect"


def check_filters(workspace):
    sample = Path(workspace) / "filter.txt"
    sample.write_text("Apple apricot banana apple\n", encoding="utf-8")
    result = call(workspace, "--input", str(sample), "--prefix", "AP", "--limit", "5")
    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError:
        output = None
    passed = result.returncode == 0 and output == {"line_count": 1, "word_count": 3, "top_words": [["apple", 2], ["apricot", 1]]}
    return passed, "prefix filtering and order" if passed else "prefix filtering or order was incorrect"


def check_errors(workspace):
    missing = call(workspace, "--input", str(Path(workspace) / "absent.txt"))
    invalid = call(workspace, "--input", str(Path(workspace) / "absent.txt"), "--limit", "0")
    passed = missing.returncode != 0 and bool(missing.stderr.strip()) and invalid.returncode != 0 and "limit" in invalid.stderr.lower()
    return passed, "input errors are useful" if passed else "missing input or invalid limit did not report a useful error"


def main():
    started = datetime.now(timezone.utc)
    workspace = sys.argv[1]
    checks = []
    for identifier, function in [("summary-output", check_summary), ("filters-and-order", check_filters), ("input-errors", check_errors)]:
        try:
            passed, message = function(workspace)
        except Exception as error:
            passed, message = False, f"evaluator exception: {error}"
        checks.append({"id": identifier, "score": 1 if passed else 0, "passed": passed, "message": message})
    finished = datetime.now(timezone.utc)
    output = {"schema_version": "0.2.0", "task_id": TASK_ID, "task_version": TASK_VERSION, "status": "ok", "started_at": started.isoformat().replace("+00:00", "Z"), "finished_at": finished.isoformat().replace("+00:00", "Z"), "duration_ms": 0, "checks": checks}
    Path(workspace, "evaluator.json").write_text(json.dumps(output, sort_keys=True, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
