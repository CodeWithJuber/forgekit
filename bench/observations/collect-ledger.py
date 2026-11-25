"""Refresh the frozen operational corpus with gh. No private ledger data is read."""
import csv
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

REPO = "CodeWithJuber/forgekit"
WORKFLOWS = ("ci", "smoke", "docs-links", "codeql")
WINDOW = "2026-07-01..2026-11-23"
END = "2026-11-24T00:00:00Z"


def get(path):
    raw = subprocess.check_output(["gh", "api", f"repos/{REPO}/{path}"])
    return json.loads(raw)


def pull_intervals():
    intervals = {}
    page = 1
    while True:
        items = get(f"pulls?base=master&state=all&per_page=100&page={page}")
        for pr in items:
            head = pr["head"]
            if head["repo"]:
                key = head["repo"]["full_name"], head["ref"]
                intervals.setdefault(key, []).append((pr["created_at"], pr["closed_at"] or END, pr["number"]))
        if len(items) < 100:
            return intervals
        page += 1


def collect(workflow, intervals=None):
    rows = []
    page = 1
    while True:
        scope = {"event": "pull_request"} if intervals is not None else {"event": "push", "branch": "master"}
        params = urlencode(dict(scope, created=WINDOW, per_page=100, page=page))
        runs = get(f"actions/workflows/{workflow}.yml/runs?{params}")["workflow_runs"]
        for run in runs:
            if run["run_attempt"] > 1:
                run = get(f"actions/runs/{run['id']}/attempts/1")
            if run["updated_at"] >= END or run["conclusion"] not in {"success", "failure"}:
                continue
            # UTC Unix seconds let the evaluator distinguish a pending run from known evidence.
            times = [int(datetime.fromisoformat(run[k].replace("Z", "+00:00")).timestamp())
                     for k in ("created_at", "updated_at")]
            stream = workflow
            if intervals is not None:
                key = (run["head_repository"]["full_name"], run["head_branch"])
                numbers = [n for start, finish, n in intervals.get(key, [])
                           if start <= run["created_at"] <= finish]
                if len(numbers) != 1:
                    continue
                stream = f"pr-{numbers[0]}/{workflow}"
            rows.append((*times, stream, run["id"], run["head_sha"], run["conclusion"]))
        if len(runs) < 100:
            return rows
        page += 1


if __name__ == "__main__":
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("ledger-ci.tsv")
    with ThreadPoolExecutor(max_workers=len(WORKFLOWS)) as executor:
        rows = sorted(row for batch in executor.map(collect, WORKFLOWS) for row in batch)
    rows = sorted(rows + collect("ci", pull_intervals()))
    with destination.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file, delimiter="\t", lineterminator="\n")
        writer.writerow(("started", "completed", "workflow", "run", "commit", "conclusion"))
        writer.writerows(rows)
    print(f"{len(rows)} eligible first attempts in the default-branch and pull-request cohorts")

