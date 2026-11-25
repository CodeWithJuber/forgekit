"""Offline comparison of reverse-graph rankings against observed historical test outcomes."""
from collections import Counter
from itertools import groupby
from pathlib import Path
from random import Random
import json

data = json.loads(Path(__file__).with_name("impact-cases.json").read_text())
held = [case for case in data["cases"] if case["date"] >= data["holdout"]]
training = [case for case in data["cases"] if case["date"] < data["holdout"]]
assert {c["commit"] for c in held}.isdisjoint(c["commit"] for c in training)
methods = ("fixed", "unweighted", "calibrated")


def affected(row):
    return row["before"] in ("assertion", "api")


def assessed(case):
    return [r for r in case["tests"] if r["after"] == "pass" and (r["before"] == "pass" or affected(r))]


def measures(case, method):
    rows = assessed(case)
    positives = sum(affected(r) for r in rows)
    ranked = sorted((r for r in rows if r[method] > 0), key=lambda r: -r[method])
    found = seen = 0
    ap = 0.
    # Ties enter together. Unreachable positives earn no ranking credit.
    for _, tied in groupby(ranked, key=lambda r: r[method]):
        group = list(tied)
        new = sum(affected(r) for r in group)
        found += new
        seen += len(group)
        ap += new * found / seen
    return positives, found, seen, ap / positives if positives else None


def summarize(cases, method):
    rows = [measures(c, method) for c in cases]
    positives, found, seen = (sum(row[i] for row in rows) for i in range(3))
    ap = [row[3] for row in rows if row[3] is not None]
    return {"affected": positives, "reached": found, "missed": positives - found,
            "predicted": seen, "recall": found / positives if positives else None,
            "precision": found / seen if seen else None, "macroAP": sum(ap) / len(ap) if ap else None}


def endpoints(values):
    values = sorted(v for v in values if v is not None)
    return [values[int(.025 * (len(values)-1))], values[int(.975 * (len(values)-1))]] if values else None


rng = Random(262)
draws = [rng.choices(held, k=len(held)) for _ in range(2000)]
results = {}
for method in methods:
    row = summarize(held, method)
    samples = [summarize(sample, method) for sample in draws]
    row["recall95"] = endpoints(s["recall"] for s in samples)
    row["macroAP95"] = endpoints(s["macroAP"] for s in samples)
    row["misses"] = [{"commit": c["commit"], "test": r["test"], "observed": r["before"]}
                     for c in held for r in assessed(c) if affected(r) and not r[method]]
    results[method] = row
print(json.dumps({"trainingCommits": len(training), "heldoutCommits": len(held),
                  "candidates": sum(len(c["tests"]) for c in held),
                  "assessed": sum(len(assessed(c)) for c in held),
                  "observations": dict(Counter(r["before"] for c in held for r in assessed(c))),
                  "positiveCommits": sum(any(affected(r) for r in assessed(c)) for c in held),
                  "weights": data["weights"], "rankings": results}, indent=2))

