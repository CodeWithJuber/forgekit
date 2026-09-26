#!/usr/bin/env python3
"""Recompute every number used in the 2026-09-21 corrections to the research papers.

Pure Python 3 (standard library only: no numpy, scipy, pandas or pyarrow), so anyone can
re-run it. It reads the replication package shipped with the refutation paper:

    mkdir rp && tar -xzf research/empirical-refutation/replication_package.tar.gz -C rp
    python research/recompute_corrections.py rp/repro

Sections 1-3 need no data (they are arithmetic on the synthesis paper's own worked
examples). Section 3b (added 2026-09-26) holds executable sanity checks on Theorem D that
need no data either; each is an `assert`, so a wrong statement fails the run with a
non-zero exit. Sections 4-9 read `results/*.json` and `data/*.parquet` from the package.
Every random draw uses a fixed seed that is printed next to its result.

    python research/recompute_corrections.py --theorem-checks   # sections 1-3b only, no data
    python research/recompute_corrections.py --help

The corrections these numbers support were prompted by external deep reviews of the
repository (2026-09-21 and 2026-09-26); see the "Corrections" sections of each paper.
"""

import json
import math
import os
import random
import struct
import sys
from collections import Counter, defaultdict

SEED = 1234
B = 20000  # bootstrap resamples


def pct(a, q):
    """Percentile with linear interpolation (numpy's default method)."""
    a = sorted(a)
    pos = (len(a) - 1) * q / 100.0
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(a) - 1)
    return a[lo] + (a[hi] - a[lo]) * (pos - lo)


def binom_cdf(k, n, p):
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k + 1))


def clopper_pearson(k, n, alpha=0.05):
    """Exact binomial CI by bisection on the binomial tails."""

    def solve(f, target):
        # f is monotone on [0, 1]; find p with f(p) == target by bisection
        lo, hi = 0.0, 1.0
        rising = f(1.0) > f(0.0)
        for _ in range(200):
            mid = (lo + hi) / 2
            if (f(mid) < target) == rising:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    lower = 0.0 if k == 0 else solve(lambda p: 1 - binom_cdf(k - 1, n, p), alpha / 2)
    upper = 1.0 if k == n else solve(lambda p: binom_cdf(k, n, p), alpha / 2)
    return lower, upper


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * tp / (2 * tp + fp + fn) if tp + fp + fn else 0.0
    return p, r, f


def header(title):
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)


# --------------------------------------------------------------------------------------
# 1-3. Formal synthesis: Theorem D and Eq. 5 (no data needed)
# --------------------------------------------------------------------------------------


def theorem_d():
    header("1. Theorem D: P(>=1 miss) over n tasks, independent tasks")
    for p, n in ((0.9, 10), (0.9, 30), (0.99, 30)):
        print(f"  instruction layer alone, p={p}: 1-p^{n} = {1 - p**n:.4f}")
    r = (1 - 0.9) * (1 - 0.95)
    for n in (30, 1000):
        print(f"  composed, p=0.9 c=0.95 (residual {r:.3f}): 1-(1-r)^{n} = {1 - (1 - r) ** n:.4f}")
    r = (1 - 0.7) * (1 - 0.95)
    print(f"  composed, p=0.7 c=0.95 (residual {r:.3f}): 1-(1-r)^30 = {1 - (1 - r) ** 30:.4f}")
    print("  dependence-free bound (union bound): P(>=1 miss in n) <= n * max per-task residual")
    for eps, n in ((0.015, 30), (0.005, 30)):
        print(f"    residual {eps}, n={n}: <= {min(1, n * eps):.3f}  (independent: {1 - (1 - eps) ** n:.4f})")

    header("2. Eq. 5 with three copies of one classifier (Stop hook, pre-commit, CI)")
    p, c, k = 0.7, 0.95, 3
    eq5 = (1 - p) * (1 - c) ** k
    nested = (1 - p) * (1 - c)
    print(f"  Eq. 5 (independence), k={k}: (1-p)(1-c)^k = {eq5:.3e}")
    print(f"  identical/nested checks: (1-p)(1-c_max)   = {nested:.4f}")
    print(f"  understatement factor                     = {nested / eq5:.0f}x")
    rng = random.Random(0)
    n_sim, resid = 1_000_000, 0
    for _ in range(n_sim):
        miss = rng.random() > p
        z = rng.random() < c  # one predicate, evaluated at all three points on the same diff
        if miss and not (z or z or z):
            resid += 1
    print(f"  Monte Carlo (seed 0, N={n_sim}): residual = {resid / n_sim:.4f}")
    print("  Frechet bounds on P(all k miss | miss): max(0, 1 - sum c_j) <= . <= 1 - max c_j")

    header("3. The gate can be satisfied by touching STATE.md (c depends on agent behaviour)")
    for h in (0.0, 0.5, 0.9, 1.0):
        c1 = 0.95 * (1 - h)
        print(f"  STATE-touch rate h={h:.1f}: c = 0.95(1-h) = {c1:.3f}, residual (p=0.7) = {(1 - 0.7) * (1 - c1):.4f}")
    print(f"  block-once-per-session: c=0 for later tasks in the session, residual = {1 - 0.7:.2f}")
    print(f"  T4: 150 lines x 80 bytes = {150 * 80} bytes > 8 KB cap (8192); 8192/150 = {8192 / 150:.1f} bytes/line")


def theorem_checks():
    """Executable sanity checks on Theorem D (2026-09-26 corrections). Each one is an assert."""
    header("3b. Theorem D sanity checks (asserted; 2026-09-26 corrections)")
    tol = 1e-12

    # (a) Separately maximal p and q need not be jointly attainable under one policy. The
    # residual of a policy pi is (1 - p(pi)) * (1 - q(pi)); the target is its minimum over the
    # joint feasible set F = {(p(pi), q(pi)) : admissible pi}, not the product of the maxima.
    policies = {"A": (0.5, 0.9), "B": (0.9, 0.1)}
    residual = {name: (1 - p) * (1 - q) for name, (p, q) in policies.items()}
    p_max = max(p for p, _ in policies.values())
    q_max = max(q for _, q in policies.values())
    naive = (1 - p_max) * (1 - q_max)
    attained = min(residual.values())
    for name, (p, q) in policies.items():
        print(f"  policy {name}: (p, q) = ({p}, {q}) -> residual (1-p)(1-q) = {residual[name]:.4f}")
    print(f"  separate maxima p_max = {p_max}, q_max = {q_max} -> (1-p_max)(1-q_max) = {naive:.4f}")
    print(f"  lowest residual any feasible policy attains = {attained:.4f}")
    assert abs(residual["A"] - 0.05) < tol, residual["A"]
    assert abs(residual["B"] - 0.09) < tol, residual["B"]
    assert abs(naive - 0.01) < tol, naive
    assert naive < attained, "the product of separate maxima is not attained by any policy here"
    print("  => (1-p_max)(1-q_max) is a LOWER bound on the attainable residual unless the maxima are")
    print("     jointly attainable; optimise min over F = {(p(pi), q(pi))} of (1-p)(1-q) instead")

    # (b) Over n independent tasks with per-task residuals r_i <= eps,
    # P(>=1 miss) = 1 - prod(1 - r_i) <= 1 - (1 - eps)^n, with EQUALITY only when every r_i = eps.
    # Independence alone does not give equality; the union bound n * eps needs neither.
    eps = 0.01
    unequal = [0.01, 0.005, 0.001]
    n = len(unequal)
    bound = 1 - (1 - eps) ** n
    p_unequal = 1 - math.prod(1 - r for r in unequal)
    p_equal = 1 - math.prod(1 - r for r in [eps] * n)
    print(f"  n={n}, eps={eps}: 1-(1-eps)^n = {bound:.6f}; union bound n*eps = {n * eps:.6f}")
    print(f"    residuals {unequal}: 1-prod(1-r_i) = {p_unequal:.6f}  (strictly below the bound)")
    print(f"    residuals all equal to eps: 1-prod(1-r_i) = {p_equal:.6f}  (equality)")
    assert p_unequal < bound - tol, (p_unequal, bound)
    assert abs(p_equal - bound) < tol, (p_equal, bound)
    assert bound <= n * eps + tol, (bound, n * eps)

    # (c) Three lifecycle copies of one classifier are not three independent detectors: the
    # independence product understates the nested residual (1-p)(1-c) 400-fold (section 2).
    p, c, k = 0.7, 0.95, 3
    ratio = ((1 - p) * (1 - c)) / ((1 - p) * (1 - c) ** k)
    print(f"  {k} copies of one check (p={p}, c={c}): nested / independence-product residual = {ratio:.0f}x")
    assert round(ratio) == 400, ratio
    print("  all Theorem D sanity checks passed")


# --------------------------------------------------------------------------------------
# Minimal Parquet reader (flat schema; PLAIN/dictionary; UNCOMPRESSED or SNAPPY)
# --------------------------------------------------------------------------------------


class _Buf:
    def __init__(self, b, i=0):
        self.b, self.i = b, i

    def byte(self):
        v = self.b[self.i]
        self.i += 1
        return v

    def varint(self):
        s = r = 0
        while True:
            x = self.byte()
            r |= (x & 0x7F) << s
            if not x & 0x80:
                return r
            s += 7

    def zigzag(self):
        v = self.varint()
        return (v >> 1) ^ -(v & 1)

    def take(self, n):
        v = self.b[self.i : self.i + n]
        self.i += n
        return v


def _thrift_value(r, t):
    if t in (1, 2):
        return t == 1
    if t == 3:
        return r.byte()
    if t in (4, 5, 6):
        return r.zigzag()
    if t == 7:
        return struct.unpack("<d", r.take(8))[0]
    if t == 8:
        return bytes(r.take(r.varint()))
    if t in (9, 10):
        h = r.byte()
        n, et = h >> 4, h & 0x0F
        if n == 15:
            n = r.varint()
        if et in (1, 2):
            return [r.byte() == 1 for _ in range(n)]
        return [_thrift_value(r, et) for _ in range(n)]
    if t == 11:
        n = r.varint()
        if n == 0:
            return {}
        kv = r.byte()
        return {_thrift_value(r, kv >> 4): _thrift_value(r, kv & 0x0F) for _ in range(n)}
    if t == 12:
        return _thrift_struct(r)
    raise ValueError(f"thrift type {t}")


def _thrift_struct(r):
    out, fid = {}, 0
    while True:
        h = r.byte()
        if h == 0:
            return out
        delta, t = h >> 4, h & 0x0F
        fid = fid + delta if delta else r.zigzag()
        out[fid] = _thrift_value(r, t)


def _snappy(b):
    r = _Buf(b)
    n = r.varint()
    out = bytearray()
    while r.i < len(b):
        tag = r.byte()
        kind = tag & 3
        if kind == 0:
            ln = tag >> 2
            if ln >= 60:
                ln = int.from_bytes(r.take(ln - 59), "little")
            out += r.take(ln + 1)
            continue
        if kind == 1:
            ln, off = ((tag >> 2) & 7) + 4, ((tag >> 5) << 8) | r.byte()
        elif kind == 2:
            ln, off = (tag >> 2) + 1, int.from_bytes(r.take(2), "little")
        else:
            ln, off = (tag >> 2) + 1, int.from_bytes(r.take(4), "little")
        for _ in range(ln):
            out.append(out[-off])
    assert len(out) == n
    return bytes(out)


def _rle_hybrid(r, bw, count, end=None):
    vals, nbytes = [], (bw + 7) // 8
    while len(vals) < count and (end is None or r.i < end):
        h = r.varint()
        if h & 1:
            groups = h >> 1
            acc = int.from_bytes(r.take(groups * bw), "little")
            vals.extend((acc >> (j * bw)) & ((1 << bw) - 1) for j in range(groups * 8))
        else:
            v = int.from_bytes(r.take(nbytes), "little") if nbytes else 0
            vals.extend([v] * (h >> 1))
    return vals[:count]


def _plain(r, ptype, n):
    if ptype == 6:
        out = []
        for _ in range(n):
            out.append(bytes(r.take(struct.unpack("<I", r.take(4))[0])))
        return out
    if ptype == 2:
        return list(struct.unpack(f"<{n}q", r.take(8 * n)))
    if ptype == 1:
        return list(struct.unpack(f"<{n}i", r.take(4 * n)))
    raise ValueError(f"physical type {ptype}")


def read_parquet(path):
    b = open(path, "rb").read()
    flen = struct.unpack("<I", b[-8:-4])[0]
    meta = _thrift_struct(_Buf(b, len(b) - 8 - flen))
    leaves = meta[2][1:]
    cols = {}
    for rg in meta[4]:
        for cc, se in zip(rg[1], leaves):
            md = cc[3]
            name, ptype, codec, nvals = md[3][-1].decode(), md[1], md[4], md[5]
            optional = se.get(3, 0) == 1
            pos, dictionary, got = md.get(11) or md[9], None, []
            while len(got) < nvals:
                r = _Buf(b, pos)
                ph = _thrift_struct(r)
                body = b[r.i : r.i + ph[3]]
                pos = r.i + ph[3]
                if ph[1] == 3:  # data page v2
                    h2 = ph[8]
                    dl, rl = h2[5], h2[6]
                    rest = body[dl + rl :]
                    if codec == 1 and h2.get(7, True):
                        rest = _snappy(rest)
                    n = h2[1]
                    defs = _rle_hybrid(_Buf(body[: dl + rl]), 1, n, dl) if optional and dl else [1] * n
                    data, enc = _Buf(rest), h2[4]
                else:
                    if codec == 1:
                        body = _snappy(body)
                    elif codec != 0:
                        raise ValueError(f"unsupported codec {codec}")
                    if ph[1] == 2:
                        dictionary = _plain(_Buf(body), ptype, ph[7][1])
                        continue
                    n, data = ph[5][1], _Buf(body)
                    if optional:
                        ln = struct.unpack("<I", data.take(4))[0]
                        end = data.i + ln
                        defs = _rle_hybrid(data, 1, n, end)
                        data.i = end
                    else:
                        defs = [1] * n
                    enc = ph[5][2]
                present = sum(defs)
                if enc in (2, 8):
                    bw = data.byte()
                    vals = [dictionary[k] for k in _rle_hybrid(data, bw, present)]
                else:
                    vals = _plain(data, ptype, present)
                it = iter(vals)
                got.extend(next(it) if d else None for d in defs)
            if ptype == 6:
                got = [v.decode("utf-8") if v is not None else None for v in got]
            cols.setdefault(name, []).extend(got)
    return cols


# --------------------------------------------------------------------------------------
# 4-9. Refutation paper
# --------------------------------------------------------------------------------------


def ground_truth(pkg):
    header("4. Ground truth: labelled vs evaluated files, pair mirroring")
    cols = read_parquet(os.path.join(pkg, "data", "cochange_groundtruth.parquet"))
    rows = list(zip(cols["repo"], cols["file"], cols["ground_truth_impacted_files"]))
    per_repo = Counter(r[0] for r in rows)
    print(f"  labelled files: {len(rows)}  per repo: {dict(per_repo)}")
    res = json.load(open(os.path.join(pkg, "results", "cochange_results.json"), encoding="utf-8"))
    print(f"  evaluated files (pre-registered cap of 200 per repo): {res['metadata']['n_files_evaluated_total']}")
    by = defaultdict(dict)
    for repo, f, gt in rows:
        by[repo][f] = set(json.loads(gt))
    total = both = mirrored = 0
    for m in by.values():
        for f, gt in m.items():
            for g in gt:
                total += 1
                if g in m:
                    both += 1
                    mirrored += f in m[g]
    print(f"  ground-truth pairs over labelled files: {total}; both ends labelled: {both}; mirrored: {mirrored}")


def cluster_bootstrap(pkg):
    header(f"5. Repo-cluster bootstrap (resample the 9 repositories; seed {SEED}, B={B})")
    d = json.load(open(os.path.join(pkg, "results", "cochange_results.json"), encoding="utf-8"))
    repos = list(d["per_repo_metrics"])
    oracle = [[d["per_repo_metrics"][r]["oracle_by_threshold"]["0.02"][k] for k in ("tp", "fp", "fn")] for r in repos]
    grep = [[d["per_repo_metrics"][r]["baselines"]["grep"][k] for k in ("tp", "fp", "fn")] for r in repos]

    def pooled(rows, idx):
        tp = sum(rows[i][0] for i in idx)
        fp = sum(rows[i][1] for i in idx)
        fn = sum(rows[i][2] for i in idx)
        return prf(tp, fp, fn)

    full = list(range(len(repos)))
    po, pg = pooled(oracle, full), pooled(grep, full)
    print(f"  pooled oracle P/R/F1 = {po[0]:.4f} / {po[1]:.4f} / {po[2]:.4f}")
    print(f"  pooled grep   P/R/F1 = {pg[0]:.4f} / {pg[1]:.4f} / {pg[2]:.4f}")
    # Repository-level view (added 2026-09-26): macro F1 weights each repository equally, so one
    # large repository cannot carry the pooled figure. F1 is 0 where a method predicts nothing.
    f1o = [prf(*oracle[i])[2] for i in full]
    f1g = [prf(*grep[i])[2] for i in full]
    print(f"  macro F1 over {len(repos)} repositories: oracle {sum(f1o) / len(f1o):.4f}, grep {sum(f1g) / len(f1g):.4f}")
    print(f"  repositories where grep F1 > oracle F1: {sum(g > o for o, g in zip(f1o, f1g))} of {len(repos)}")
    rng = random.Random(SEED)
    draws = []
    for _ in range(B):
        idx = [rng.randrange(len(repos)) for _ in repos]
        o, g = pooled(oracle, idx), pooled(grep, idx)
        draws.append(o + g + (g[2] - o[2],))
    names = ["oracle P", "oracle R", "oracle F1", "grep P", "grep R", "grep F1", "grep F1 - oracle F1"]
    for i, nm in enumerate(names):
        col = [x[i] for x in draws]
        print(f"  {nm:<20} 95% CI [{pct(col, 2.5):.4f}, {pct(col, 97.5):.4f}]")
    print(f"  share of resamples with oracle recall == 0: {sum(x[1] == 0 for x in draws) / B:.4f}")
    fl = d["pooled_metrics"]["oracle_by_threshold"]["0.02"]
    print(
        f"  (reported file-level CIs: P [{fl['precision_ci95']['lo']}, {fl['precision_ci95']['hi']}],"
        f" R [{fl['recall_ci95']['lo']}, {fl['recall_ci95']['hi']}])"
    )


def repaired_vs_grep(pkg):
    header("6. Repaired oracle vs grep on the 3 held-out repositories (paired)")
    rr = json.load(open(os.path.join(pkg, "results", "repair_results.json"), encoding="utf-8"))
    cr = json.load(open(os.path.join(pkg, "results", "cochange_results.json"), encoding="utf-8"))
    h = rr["d_defect1and2_heldout_HEADLINE"]
    per = h["per_repo_metrics_at_best_threshold"]
    repos = list(per)
    o = {r: (per[r]["tp"], per[r]["fp"], per[r]["fn"]) for r in repos}
    g = {r: tuple(cr["per_repo_metrics"][r]["baselines"]["grep"][k] for k in ("tp", "fp", "fn")) for r in repos}
    pairs = {r: cr["per_repo_metrics"][r]["n_ground_truth_pairs"] for r in repos}
    tot = sum(pairs.values())
    for r in repos:
        fo, fg = prf(*o[r])[2], prf(*g[r])[2]
        print(f"  {r:<18} pairs {pairs[r]:5d} ({pairs[r] / tot:.1%})  oracle F1 {fo:.4f}  grep F1 {fg:.4f}  dF1 {fo - fg:+.4f}")

    def pooled_f1(rows, idx):
        return prf(sum(rows[i][0] for i in idx), sum(rows[i][1] for i in idx), sum(rows[i][2] for i in idx))[2]

    orow, grow = [o[r] for r in repos], [g[r] for r in repos]
    allidx = list(range(len(repos)))
    print(f"  pooled dF1 at t=0.10: {pooled_f1(orow, allidx) - pooled_f1(grow, allidx):+.4f}")
    c02 = h["metrics_at_canonical_0.02"]
    gh = rr["e_baselines_unchanged"]["grep_heldout_3repo"]
    print(f"  pooled dF1 at t=0.02 (headline): {c02['f1'] - gh['f1']:+.4f}  (per-repo counts at 0.02 not in package)")
    # exact repo-cluster bootstrap: enumerate all 3^3 ordered resamples
    deltas = []
    for a in allidx:
        for b in allidx:
            for c in allidx:
                idx = [a, b, c]
                deltas.append(pooled_f1(orow, idx) - pooled_f1(grow, idx))
    print(f"  exact repo-cluster bootstrap of pooled dF1 (27 resamples): min {min(deltas):+.4f}, max {max(deltas):+.4f}")
    wins = sum(prf(*o[r])[2] > prf(*g[r])[2] for r in repos)
    print(f"  sign test: {wins}/{len(repos)} repositories favour the oracle; one-sided p = {0.5 ** len(repos):.3f}")
    ci_o, ci_g = h["ci_at_canonical_0.02"]["f1_ci95"], rr["e_baselines_unchanged"]["grep_heldout_ci"]["f1_ci95"]
    print(f"  reported file-level F1 CIs: oracle [{ci_o[0]:.3f}, {ci_o[1]:.3f}] vs grep [{ci_g[0]:.3f}, {ci_g[1]:.3f}]")


def cost(pkg):
    header("7. Cost per judged-correct output (held-out, escalation-inclusive)")
    d = json.load(open(os.path.join(pkg, "results", "heldout_results.json"), encoding="utf-8"))
    tasks = [t for t in d["per_task"] if t.get("generation_routed_cost_usd") is not None]
    routed = sum(t["generation_routed_cost_usd"] for t in tasks)
    premium = sum(t["generation_premium_cost_usd"] for t in tasks)
    ok_pipe = sum(bool(t["generation_final_success"]) for t in tasks)
    ok_prem = sum(bool(t["generation_premium_baseline_correct"]) for t in tasks)
    none_ok = sum(not t["generation_final_success"] and not t["generation_premium_baseline_correct"] for t in tasks)
    print(f"  tasks: {len(tasks)}; total routed ${routed:.4f}; total always-premium ${premium:.4f}")
    print(f"  raw total-spend saving: {100 * (1 - routed / premium):.2f}%")
    print(f"  judged correct: pipeline {ok_pipe}/{len(tasks)}, premium {ok_prem}/{len(tasks)}; neither: {none_ok}")
    cpp, cpq = routed / ok_pipe, premium / ok_prem
    print(f"  cost per judged-correct output: pipeline ${cpp:.3f}  premium ${cpq:.3f}  ({100 * (1 - cpp / cpq):.1f}% lower)")
    for k in (ok_pipe, ok_prem):
        lo, hi = clopper_pearson(k, len(tasks))
        print(f"  Clopper-Pearson 95% for {k}/{len(tasks)}: [{lo:.3f}, {hi:.3f}]")


def calibration(pkg):
    header("8. Gate calibration bins")
    d = json.load(open(os.path.join(pkg, "results", "heldout_results.json"), encoding="utf-8"))
    tasks = d["per_task"]
    c = [t["gate_completeness"] for t in tasks]
    y = [0.0 if t["gold_ask"] else 1.0 for t in tasks]
    n = len(c)
    edges = [pct(c, q) for q in (0, 20, 40, 60, 80, 100)]
    print(f"  quantile edges: {[round(e, 3) for e in edges]}")
    print(f"  ties: {sum(v == 0.63 for v in c)} tasks at 0.63, {sum(v == 0.9 for v in c)} at 0.90, {sum(v == 1.0 for v in c)} at 1.00")
    for label, right in (("(lo, hi] bins (as reported)", True), ("[lo, hi) bins", False)):
        e, counts = 0.0, []
        for i in range(5):
            lo, hi = edges[i], edges[i + 1]
            if right:
                m = [j for j in range(n) if (c[j] > lo or (i == 0 and c[j] >= lo)) and c[j] <= hi]
            else:
                m = [j for j in range(n) if c[j] >= lo and (c[j] < hi or (i == 4 and c[j] <= hi))]
            counts.append(len(m))
            if m:
                e += len(m) / n * abs(sum(c[j] for j in m) / len(m) - sum(y[j] for j in m) / len(m))
        print(f"  {label:<28} counts {counts}  ECE {e:.4f}")
    cal = d["calibration"]["framing_A_reliability"]
    b2, b3 = cal[2], cal[3]
    k = round(b3["gate_decision_accuracy_in_bin"] * b3["n"])
    for p0, why in ((b2["gate_decision_accuracy_in_bin"], "middle-bin accuracy"), (b3["mean_predicted_completeness"], "bin's own mean score")):
        print(f"  bin 3: {k}/{b3['n']} correct; P(X<={k} | n={b3['n']}, p={p0:.4f} [{why}]) = {binom_cdf(k, b3['n'], p0):.4f}")
    lo, hi = clopper_pearson(k, b3["n"])
    print(f"  Clopper-Pearson 95% for {k}/{b3['n']}: [{lo:.3f}, {hi:.3f}]")


def kappa(pkg):
    header("9. Label agreement (pass 1 vs pass 2, same model, reworded prompt)")
    d = json.load(open(os.path.join(pkg, "results", "heldout_results.json"), encoding="utf-8"))
    tasks = d["per_task"]

    def cohen(a, b, cats, quadratic=False):
        k = len(cats)
        ix = {v: i for i, v in enumerate(cats)}
        m = [[0.0] * k for _ in range(k)]
        for x, z in zip(a, b):
            m[ix[x]][ix[z]] += 1
        tot = sum(map(sum, m))
        m = [[v / tot for v in row] for row in m]
        pa = [sum(row) for row in m]
        pb = [sum(m[i][j] for i in range(k)) for j in range(k)]

        def w(i, j):
            return ((i - j) / (k - 1)) ** 2 if quadratic else float(i != j)

        obs = sum(w(i, j) * m[i][j] for i in range(k) for j in range(k))
        exp = sum(w(i, j) * pa[i] * pb[j] for i in range(k) for j in range(k))
        return 1 - obs / exp

    sub = [t for t in tasks if t["pass2_gold_ask"] is not None]
    a, b = [t["gold_ask"] for t in sub], [t["pass2_gold_ask"] for t in sub]
    print(f"  n = {len(sub)}; halt label kappa = {cohen(a, b, [False, True]):.4f}")
    a, b = [t["gold_tier"] for t in sub], [t["pass2_gold_tier"] for t in sub]
    tiers = ["cheap", "mid", "premium"]
    print(f"  tier kappa unweighted = {cohen(a, b, tiers):.4f}, quadratic = {cohen(a, b, tiers, True):.4f}")
    ca = d["cost_analysis"]
    print(f"  judge model: {ca['judge_model']}; judge is the mid-tier executor: {ca['judge_is_same_as_mid_tier_executor']}")


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__)
        return
    theorem_d()
    theorem_checks()
    if args and args[0] == "--theorem-checks":
        return
    if not args:
        print("\n(pass the extracted replication package's repro/ directory to recompute sections 4-9)")
        return
    pkg = args[0]
    ground_truth(pkg)
    cluster_bootstrap(pkg)
    repaired_vs_grep(pkg)
    cost(pkg)
    calibration(pkg)
    kappa(pkg)


if __name__ == "__main__":
    main()
