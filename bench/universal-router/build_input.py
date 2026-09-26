#!/usr/bin/env python3
"""Build the universal router's fitting input from pinned public data.

Reads the files pinned in bench/universal-router/sources.json (SWE-bench Verified as one parquet
file, and the eleven runs' per_instance_details.json from SWE-bench/experiments), checks every
file's size and sha256 (and, for GitHub files, the git blob id) before using it, and writes the
JSON that bench/universal-router/fit_prior.mjs reads:

    {source: {...}, tasks: [{id, text}], outcomes: {<registry id>: {<instance_id>: {resolved, cost}}}}

Evaluator/agent boundary: the parquet also holds the gold patch, the test patch and the
evaluation fields. Only two columns are read, instance_id and problem_statement, so nothing else
reaches the output. The output does carry outcome labels and costs: it is training data for the
router fit, never a prompt for a coding agent.

Canonical orders. The fit is order-sensitive (feature means are summed in task order, and the
cross-validation folds are assigned by task index), so both orders are fixed here:
    tasks   instance_id ascending (code-point order)
    models  registry id ascending (code-point order)

Attempts with a recorded cost of 0 (two failed Gemini runs at the pinned commit) are kept as
outcomes. fit_prior.mjs's cost model only uses positive costs, so it skips them.

Usage:
    python3 bench/universal-router/build_input.py --out universal_all.json [--cache DIR] [--offline]

Needs Python 3.10+ and pyarrow (pinned in requirements.txt). Downloads honour HTTPS_PROXY.
"""

import argparse
import hashlib
import io
import json
import math
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
REL_HERE = HERE.relative_to(ROOT).as_posix()
# Files the text features depend on: the feature code, and the rubric (with its exemplars) that
# it calls. Hashed after normalising CRLF to LF, so a Windows checkout records the same value.
FEATURE_CODE = ["src/router/features.js", "src/route.js"]


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def git_blob_id(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def problems_with(entry, data):
    """Differences between a file's bytes and its pinned description (empty when it matches)."""
    out = []
    if len(data) != entry["bytes"]:
        out.append(f"size {len(data)} != pinned {entry['bytes']}")
    got = sha256_hex(data)
    if got != entry["sha256"]:
        out.append(f"sha256 {got} != pinned {entry['sha256']}")
    if "gitBlob" in entry and git_blob_id(data) != entry["gitBlob"]:
        out.append(f"git blob {git_blob_id(data)} != pinned {entry['gitBlob']}")
    return out


def fetch(entry, dest, offline):
    """Return the verified bytes of one pinned file, reading `dest` or downloading into it."""
    if dest.exists():
        data = dest.read_bytes()
        bad = problems_with(entry, data)
        if not bad:
            return data, "cached"
        if offline:
            sys.exit(f"build_input: {dest}: {'; '.join(bad)}")
        print(
            f"  {dest.name}: cached copy does not match ({'; '.join(bad)}); downloading again"
        )
    elif offline:
        sys.exit(f"build_input: {dest} is missing and --offline was given")
    request = urllib.request.Request(
        entry["url"], headers={"User-Agent": "forgekit-build-input"}
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        data = response.read()
    bad = problems_with(entry, data)
    if bad:
        sys.exit(f"build_input: {entry['url']}: {'; '.join(bad)}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    part.write_bytes(data)
    part.replace(dest)
    return data, "downloaded"


def read_tasks(parquet_bytes):
    """(instance_id, problem_statement) pairs. No other column is read."""
    import pyarrow.parquet as pq

    table = pq.read_table(
        io.BytesIO(parquet_bytes), columns=["instance_id", "problem_statement"]
    )
    ids = table.column("instance_id").to_pylist()
    texts = table.column("problem_statement").to_pylist()
    if len(set(ids)) != len(ids):
        sys.exit("build_input: duplicate instance_id in the dataset")
    for tid, text in zip(ids, texts):
        if not isinstance(tid, str) or not isinstance(text, str) or not text:
            sys.exit(f"build_input: {tid!r}: missing instance_id or problem_statement")
    return ids, dict(zip(ids, texts))


def read_outcomes(model_id, raw, task_ids):
    """{instance_id: {resolved, cost}} in canonical task order, after strict validation."""
    per = json.loads(raw)
    if not isinstance(per, dict):
        sys.exit(f"build_input: {model_id}: per_instance_details.json is not an object")
    missing = sorted(set(task_ids) - set(per))
    extra = sorted(set(per) - set(task_ids))
    if missing or extra:
        sys.exit(
            f"build_input: {model_id}: {len(missing)} dataset tasks missing, "
            f"{len(extra)} unknown ids (e.g. {(missing + extra)[:3]})"
        )
    rows = {}
    for tid in task_ids:
        rec = per[tid]
        resolved, cost = rec.get("resolved"), rec.get("cost")
        if not isinstance(resolved, bool):
            sys.exit(
                f"build_input: {model_id} {tid}: resolved is {resolved!r}, not a boolean"
            )
        numeric = isinstance(cost, (int, float)) and not isinstance(cost, bool)
        if not numeric or not math.isfinite(cost) or cost < 0:
            sys.exit(
                f"build_input: {model_id} {tid}: cost is {cost!r}, not a finite number >= 0"
            )
        rows[tid] = {"resolved": resolved, "cost": cost}
    return rows


def feature_version():
    out = {}
    for rel in FEATURE_CODE:
        data = (ROOT / rel).read_bytes().replace(b"\r\n", b"\n")
        out[rel] = f"sha256:{sha256_hex(data)}"
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--out", required=True, help="where to write the fitting input JSON"
    )
    ap.add_argument(
        "--cache",
        help="directory that holds (or receives) the pinned source files; "
        "without it they are downloaded into a temporary directory",
    )
    ap.add_argument(
        "--offline", action="store_true", help="never download; use --cache only"
    )
    args = ap.parse_args()
    if args.offline and not args.cache:
        sys.exit("build_input: --offline needs --cache")

    sources_path = HERE / "sources.json"
    sources = json.loads(sources_path.read_text(encoding="utf-8"))
    ds, ex = sources["dataset"], sources["experiments"]
    runs = ex["runs"]
    model_ids = sorted(runs)

    # The registry is what fit_prior.mjs keeps models by: a pinned run whose id is not in it
    # would be dropped silently, and a registry that names another run would be misleading.
    registry = json.loads((ROOT / "data" / "models.json").read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in registry["models"]}
    for mid in model_ids:
        if mid not in by_id:
            sys.exit(
                f"build_input: {mid} is pinned in sources.json but not in data/models.json"
            )
        if by_id[mid].get("benchmark_run") != runs[mid]["run"]:
            sys.exit(
                f"build_input: {mid}: data/models.json says benchmark_run "
                f"{by_id[mid].get('benchmark_run')!r}, sources.json pins {runs[mid]['run']!r}"
            )

    with tempfile.TemporaryDirectory(prefix="router-input-") as tmp:
        cache = Path(args.cache) if args.cache else Path(tmp)
        print(f"sources: {sources_path.relative_to(ROOT).as_posix()} (cache: {cache})")
        dest = cache / ds["repo"].replace("/", "__") / ds["revision"] / ds["path"]
        parquet, how = fetch(ds, dest, args.offline)
        print(f"  {ds['repo']}@{ds['revision'][:7]} {ds['path']}: {how}, sha256 ok")
        task_ids, texts = read_tasks(parquet)
        task_ids = sorted(task_ids)
        exp_repo = ex["repo"].removeprefix("https://github.com/")
        outcomes = {}
        for mid in model_ids:
            run = runs[mid]
            dest = cache / exp_repo.replace("/", "__") / ex["commit"] / run["path"]
            raw, how = fetch(run, dest, args.offline)
            print(f"  {mid:<18} {run['run']}: {how}, sha256 + git blob ok")
            outcomes[mid] = read_outcomes(mid, raw, task_ids)

    source = {
        "benchmark": f"{ds['name']} (rev {ds['revision'][:7]})",
        "runs": f"{exp_repo}@{ex['commit'][:7]}, {ex['scaffold']}, dated {ex['runDate']}",
        "split": "all",
        "build": {
            "builder": f"{REL_HERE}/build_input.py",
            "dataset": f"{ds['repo']}@{ds['revision']}",
            "experiments": f"{exp_repo}@{ex['commit']}",
            "taskText": "problem_statement, verbatim",
            "taskOrder": "instance_id ascending",
            "modelOrder": "registry id ascending",
            "featureVersion": feature_version(),
        },
    }
    doc = {
        "source": source,
        "tasks": [{"id": tid, "text": texts[tid]} for tid in task_ids],
        "outcomes": outcomes,
    }
    # Bytes, not text mode: the same file (and sha256) on every platform.
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n"
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    part.write_bytes(text.encode("utf-8"))
    part.replace(out)

    cells = [(mid, tid, o) for mid in model_ids for tid, o in outcomes[mid].items()]
    zero = [(mid, tid, o["resolved"]) for mid, tid, o in cells if o["cost"] == 0]
    print(f"tasks: {len(task_ids)}  models: {len(model_ids)}  outcomes: {len(cells)}")
    for mid in model_ids:
        solved = sum(o["resolved"] for o in outcomes[mid].values())
        print(f"  {mid:<18} resolved {solved}/{len(task_ids)}")
    print(
        f"zero-cost attempts kept as outcomes: {len(zero)} "
        f"({sum(1 for z in zero if not z[2])} unresolved); the cost fit skips them"
    )
    for mid, tid, resolved in zero:
        print(f"  {mid} {tid} resolved={str(resolved).lower()} cost=0")
    for rel, digest in source["build"]["featureVersion"].items():
        print(f"feature code {rel}: {digest}")
    print(
        f"wrote {out} ({len(text.encode('utf-8'))} bytes, sha256 {sha256_hex(text.encode('utf-8'))})"
    )


if __name__ == "__main__":
    main()
