"""Replay curated functional changes using their later tests, then score with parent graphs."""
import json
import os
import re
import shutil
import subprocess as sp
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
COMMITS = """d95b5c54f713af0cf79be88658bc36e6493ddcb0
f12492ae9e77a900b4857fcc8ff239665f0ddf2c
29532442ede6959c1be1c127f14ad9d540dec8a5
ee10a148abfd076fd8c84577e48129bb7a9c2ef3
54ff25fea3f7996b2731b489ef5856ceaac595ea
74001c239a4eeea21f7bfd02ce89306c93da8b47
413e4be08895c33478cea9b34a73f025ecd5f7f6
0b286c3265ffa3be652a01f61baf690c28124f36
5aacf5e83eca1bfabccec1c8bb4cb3453cbd4bd1
c98ef20d8bf91274aee45a6a64d875e0a733f19d
4b7be37e84836c91515f6b65649972111361b58a
c8eb7a822a007986e52080521a35e48689f30f9e
37213422ec54fb69a372d9a97db2059ac4a7c725""".split()
HOLDOUT = "2026-09-22"
SUITES = """atlas atlas_resolve atlas_relations path_aliases coupling lessons ledger ledger_read
            math rank route stack eval test_select orient""".split()


def git(*args):
    return sp.check_output(["git", *args], cwd=REPO, text=True).strip()


def extract(rev, dest):
    dest.mkdir()
    with sp.Popen(["git", "archive", rev], cwd=REPO, stdout=sp.PIPE) as archive:
        sp.run(["tar", "-xf", "-", "-C", str(dest)], stdin=archive.stdout, check=True)
        if archive.wait():
            raise RuntimeError(f"git archive failed for {rev}")


def graph(path, request):
    config = path.parent / "graph-request.json"
    config.write_text(json.dumps(request))
    return json.loads(sp.check_output(["node", HERE / "impact-graph.mjs", path, config], cwd=REPO))


def suite(snapshot, name, home):
    home.mkdir(parents=True, exist_ok=True)
    # Use uncredentialed historical fixtures. The fixed roster requires only Node and Git.
    env = {k: os.environ[k] for k in ("PATH", "SystemRoot", "TMPDIR") if k in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), FORGE_HOME=str(home / "forge"),
               FORGE_NO_HINT="1", CI="1", NO_COLOR="1")
    try:
        result = sp.run(["node", "--test", "--test-reporter=tap", name], cwd=snapshot, env=env,
                        stdout=sp.PIPE, stderr=sp.STDOUT, text=True, timeout=60, errors="replace")
    except sp.TimeoutExpired:
        return "timeout"
    if result.returncode == 0 and re.search(r"^# pass [1-9]\d*$", result.stdout, re.M):
        return "pass"
    if result.returncode and re.search(r"code: ['\"]ERR_ASSERTION['\"]", result.stdout):
        return "assertion"
    # A later test that needs a project export absent on its parent directly observes
    # an API change. Missing external dependencies and unrelated loader errors stay unknown.
    if result.returncode and (
        re.search(r"The requested module ['\"](?:\.\.?/)+src/[^'\"]+['\"] does not provide an export", result.stdout)
        or f"Cannot find module '{snapshot}/src/" in result.stdout
    ):
        return "api"
    return "unassessed"


def observe(commit, scratch):
    parent = git("rev-parse", commit + "^")
    date = git("show", "-s", "--format=%cs", commit)
    sources = git("diff", "--name-only", parent, commit, "--", "src").splitlines()
    p, c = scratch / "parent", scratch / "child"
    extract(parent, p)
    extract(commit, c)
    changed_tests = git("diff", "--name-only", parent, commit, "--", "test").splitlines()
    candidates = {f"test/{s}.test.js" for s in SUITES} | {path for path in changed_tests if path.endswith(".test.js")}
    names = sorted(path for path in candidates if (c / path).is_file())
    prediction = graph(p, {"sources": sources, "tests": names})
    # Score the graph first. New test files count as misses when absent from the parent.
    shutil.rmtree(p / "test")
    shutil.copytree(c / "test", p / "test")
    def evaluate(name):
        home = scratch / "home" / Path(name).stem
        before = suite(p, name, home / "old")
        after = suite(c, name, home / "new")
        return {"test": name, "before": before, "after": after,
                "fixed": prediction["fixed"][name]["score"], "path": prediction["fixed"][name]["path"],
                "unweighted": prediction["unweighted"][name]["score"]}
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(evaluate, names))
    return {"commit": commit, "parent": parent, "date": date, "sources": sources, "tests": rows}


def fit(cases):
    good, total = Counter(), Counter()
    for case in cases:
        if case["date"] >= HOLDOUT:
            continue
        for t in case["tests"]:
            if t["after"] == "pass" and t["before"] in ("pass", "assertion", "api"):
                for kind in set(t["path"]):
                    total[kind] += 1
                    good[kind] += t["before"] != "pass"
    return {kind: (good[kind] + 1) / (n + 2) for kind, n in sorted(total.items())}


if __name__ == "__main__":
    cases = []
    for commit in COMMITS:
        with tempfile.TemporaryDirectory(prefix="forge-impact-case-") as scratch:
            case = observe(commit, Path(scratch))
        cases.append(case)
        print(case["date"], commit[:8], len(case["tests"]), flush=True)
    weights = fit(cases)
    for case in cases:
        with tempfile.TemporaryDirectory(prefix="forge-impact-graph-") as scratch:
            parent = Path(scratch) / "parent"
            extract(case["parent"], parent)
            names = [t["test"] for t in case["tests"]]
            scores = graph(parent, {"sources": case["sources"], "tests": names, "weights": weights})
            for t in case["tests"]:
                t["calibrated"] = scores["calibrated"][t["test"]]["score"]
    data = {"repository": "CodeWithJuber/forgekit", "language": "JavaScript", "holdout": HOLDOUT,
            "weights": weights, "cases": cases}
    output = HERE / "impact-cases.json"
    output.write_text(json.dumps(data, indent=2) + "\n")
    sp.run(["node", REPO / "node_modules/@biomejs/biome/bin/biome", "format", "--write", output],
           cwd=REPO, check=True)

