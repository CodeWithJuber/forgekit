# Decision mathematics

Reference mathematics for decisions the project makes or plans to make from evidence: when a
route, a replayed step or a canary has earned trust, in which order to try fallible attempts,
how many changes to batch in a merge queue, and whether a failing test is flaky.

> **Evidence status (2026-11-27).** Everything here is **implemented and tested against an
> independent calculation** — exhaustive enumeration, direct summation, numeric integration, the
> router's own `choose`, or a seeded simulation. **None of it is wired into a command**, so no
> behaviour changes, and **nothing has been measured on a real repository, provider or user.**
> In particular the replay engine has run only on generated procedures; what share of real
> requests it can serve is a hypothesis until `replayOpportunity` is run on real logs.

| Module | Question | Checked against |
| --- | --- | --- |
| `src/mathcore/stats.js` | Exact binomial bound for a number of trials fixed in advance | Direct summation of the binomial tail, 4,920 bounds |
| `src/mathcore/sequential.js` | Is the evidence enough when it is read after every observation? Has behaviour changed? Promote or roll back a canary? | Seeded simulation at the boundary of each hypothesis |
| `src/router/cascade.js` | Cheapest order of a cascade, with correlated failures | Brute force over ordered cascades; `choose` in `src/router/policy.js` on 3,600 decisions |
| `src/replay/` | Can a repeated request be served from verified traces with no model call? | Randomly generated ground-truth procedures |
| `src/mathcore/grouptest.js` | Merge-queue batch size | Enumeration of every failure pattern up to 11 changes |
| `src/mathcore/flaky.js` | Flaky test or real regression, and how many reruns settle it | Numeric integration of the Beta moments |
| `src/mathcore/contextpack.js` | Which evidence fits a window when token cost is not additive | Brute force over all record subsets |
| `src/mathcore/rivals.js` | Which statements compete with the evidence and must leave a context window | A per-key reference on 400 random sets, in two input orders |
| `src/mathcore/vulnrank.js` | In which order to treat vulnerability findings when reachability is unknown | Hand-computed cases at each of the three reach values |
| `src/mathcore/occlusion.js` | How much of a control can be clicked, and whether the click point is exposed | A pixel count on 300 random layouts |

Run them with `node --test --import ./test/_setup.js test/mathcore_*.test.js test/router_cascade.test.js test/replay.test.js`.
The statistical tests print the rates they observe as diagnostics; the numbers below are those
diagnostics on Node 22.

## One rule

Take the cheapest permitted action whose verified success rate is provably high enough.

```
a* = argmin over permitted actions of E[cost(a)]   subject to   L_t(a) >= q
```

`L_t` is a lower confidence bound on the verified success probability that stays valid however
often it is read. The requirement `q` follows from three numbers the owner can measure — the
cost of the cheap action, the cost of the fallback, and the loss when the cheap action is wrong:

```
q* = (L_wrong + c_cheap) / (L_wrong + c_fallback)
```

A free mistake gives a threshold near zero; an unbounded loss gives 1, which means never.
Permissions, where data may go, context fit, budget and irreversible effects are filters applied
before anything is scored. Quality is a constraint on outcomes verified by something other than
the action's author. Cost is the only thing optimized.

## Evidence that survives repeated looks

An exact binomial bound holds for a number of trials fixed in advance. Read again after every
observation it is not a bound. With the true success rate exactly at a 0.9 requirement, so that
every activation is false, 2,000 seeded runs of 600 observations gave:

| Bound, nominal 5% | Runs that activated falsely |
| --- | --- |
| Exact (Clopper-Pearson), re-read after each observation | 24.3% |
| `anytimeLower` | 4.6% |

`anytimeLower(s, f, alpha)` inverts a test martingale. For the hypothesis "success rate at most
m", after `s` successes and `f` failures:

```
W(m) = Σ_j w_j · (1 + g_j·(1/m − 1))^s · (1 − g_j)^f        P(sup_t W_t(m) >= 1/alpha) <= alpha  when p <= m
L    = sup { m : W(m) >= 1/alpha }
```

Each factor has conditional mean at most 1 under the hypothesis and is never negative, so Ville's
inequality applies. The bet fractions `g` (1, 3/4, 1/2, 1/4) and weights (1/2, 1/6, 1/6, 1/6) are
fixed before any data. Validity under monitoring costs trials:

| Required success rate | Zero-failure trials, fixed in advance | Zero-failure streak, read any time |
| --- | --- | --- |
| 0.50 | 5 | 5 |
| 0.90 | 29 | 34 |
| 0.99 | 299 | 348 |

`EDetector` watches for a drop below a floor. Its guarantee is on run length: with no change the
expected time to a false alarm is at least `1/alpha` observations (observed 223 against a
guaranteed 100; a drop to 50% success was caught after 7.8 observations on average). It does not
bound the probability of ever alarming.

`CanaryTest` takes matched pairs of failure indicators and a tolerated increase `delta`, and runs
two tests on `d = canary − baseline`: rejecting `E[d] <= delta` means roll back, rejecting
`E[d] >= delta` means promote. Each wrong decision has probability at most `alpha` at any stopping
time; missing data causes no update. At the tolerance boundary 3.9% of 800 runs promoted and 3.5%
rolled back; an equal canary was promoted in all 200 runs and one four tolerances worse was
rolled back in all 200. Pairs must be the independent unit, and latency needs its own analysis.

## Cascade order over sets

`src/router/policy.js` scores a cascade by `E[cost] = Σ_i c_{m_i} · F({m_1 … m_{i−1}})`, where
`F(T)` is the probability that every attempt in `T` fails. The charge for a position depends only
on the set of earlier attempts, so:

```
g(∅) = 0        g(S) = min over i in S of [ g(S \ {i}) + c_i · F(S \ {i}) ]
```

This is exact with correlated failures and costs `O(2^n · n)` where enumerating ordered cascades
costs `O(n!)`. `chooseBySubsets` takes the arguments of `choose` and returned the same cascade and
the same result fields on 3,600 random decisions across all four objectives, feasible and not.
The router still calls `choose`; switching is a separate change.

Two consequences are worth stating. With independent attempts the best order of a fixed set sorts
by cost divided by success probability, so sorting by price alone is right only when success
rates are equal: routes costing 1 and 2 with success 0.1 and 0.9 cost 2.8 cheapest-first and 2.1
in the best order. With correlated failures even the ratio rule was not optimal in 50 of 150
random instances.

## Replay engine

A step runs without a model only when the request reads as an instance of a verified pattern,
every argument of the step has a known source, and the step has earned its evidence gate.
Otherwise the step is handed back, and the model's verified trace becomes new evidence.

- **Learning.** Requests and traces are generalized together. A value that varies across examples
  is a variable, and two positions hold the same variable exactly when their values agree in every
  example. That rule yields the mapping from request to step arguments.
- **Provenance closure.** A step is closed when each argument is a constant or a deterministic
  function (identity, case, number, text template) of request slots, the environment, or earlier
  step outputs. An argument with no source was invented by the model or came from context the
  trace did not record; that step is never replayed.
- **Reading a request.** A slot that feeds a step accepts only values of the class and length
  seen so far; a slot that feeds nothing accepts only the exact fillers seen. A negation in front,
  an injected clause and an unseen verb all fall through to the model.
- **Structure.** Steps form a prefix tree of observed step shapes, with branches chosen by a value
  observed at run time. Every path the engine can follow is a path some verified trace took. A
  first-order step graph does not have that property: from traces `a, m, x` and `b, m, y` it scores
  `a, m, y` highest.
- **Gate and retirement.** A step replays when `anytimeLower` of its verified outcomes reaches
  `q*` for its effect class (`pure`, `read`, `write`; `irreversible` never replays). Evidence is
  tied to the hash of the step template. A change detector retires a step that stops working and
  drops the examples that taught it.

```js
import { ReplayEngine } from "./src/replay/engine.js";

const engine = new ReplayEngine({
  alpha: 0.05,
  costs: { teacher: 1, replay: 0.01 }, // owner's numbers, one unit
  loss: { pure: 0, read: 0.2, write: 9 }, // cost of a wrong step, by effect class
});
engine.learn(trace); // every verified model run: { intent, env, steps, outcome: "verified" }
const run = engine.begin(request, env); // a Run, or { state: "miss" }
const step = run.next(); // execute | handoff | done
run.report({ out, verified }); // verified must come from a check independent of the engine
```

On 250 generated procedures the tests reproduced all 873 training traces and predicted 1,498
unseen requests exactly; 502 were declined as unfamiliar and none was wrong. After 334 good
outcomes, two failed replays retired a step whose tool had changed, where the cumulative bound
alone would have allowed 20.

The share of requests replay can serve is capped, because a family with `m` requests must first
earn a streak `n` on model runs: `share <= Σ max(0, m_f − n) / Σ m_f`. `replayOpportunity`
computes it; running it on real logs is the first measurement to make.

**Limits.** Bindings are inductive: two examples can agree by coincidence. The gate bounds a
long-run error rate under exchangeable requests and does not make a single replay safe, so every
step still needs an independent check. Agreement with the model and a passed postcondition are
pooled as one success count. A paraphrase with no shared wording is not recognized. A value cut
out of an earlier output counts as unsourced.

## Delivery

**Merge-queue batch size.** If each queued change breaks the build independently with probability
`p`, batch sizing is Dorfman's group-testing problem. Rebuilding each change after a failed batch
costs `1/b + 1 − (1 − p)^b` builds per change; halving does better (`halvingExpected`).

| Break rate | Best batch, rebuild each | Builds per change | Best batch, halving | Builds per change |
| --- | --- | --- | --- | --- |
| 1% | 11 | 0.196 | 53 | 0.098 |
| 5% | 5 | 0.426 | 13 | 0.323 |
| 20% | 3 | 0.821 | 3 | 0.749 |

Two individually good changes that fail together are outside the model; the combined check still
has to run.

**Flaky test or regression.** On identical inputs a test with no regression fails with probability
`f ~ Beta(a, b)`, estimated from same-input reruns. After `k` consecutive failures:

```
P(regression | k failures) = π / (π + (1 − π)·E[f^k])        E[f^k] = Π_{j<k} (a + j)/(a + b + j)
```

A test that failed 2 of 100 same-input reruns, with a 5% prior, reaches 64%, 97.9% and 99.9% after
one, two and three failures. The model covers deterministic regressions only.

## Three rules taken from 2026 evidence

Each rule below replaces a common formula that a 2026 study showed to be unsafe or aimed at the
wrong quantity.

**Rival statements before length.** A retrieval study on five open models
([arXiv:2611.04169](https://arxiv.org/abs/2611.04169)) found neutral filler leaves accuracy at
0.97 to 1.00 up to 32K tokens, while statements in the same form as the evidence drop it to 0.16
to 0.33, and one statement giving the queried key a rival value multiplies the loss 9 to 110
times. So a context window is cleaned of rivals before it is trimmed for size. `dropRivals` keeps,
per key, the statement with the latest order and reports every earlier one as superseded. Two
different values with the same order cannot be ranked: neither is packed and the pair is returned
as a conflict for the caller to resolve. The study used models of 0.5B to 3B parameters; whether
the ratio holds for larger models is not established here.

**Reachability has three values.** Scoring an unreachable finding zero assumes the graph is
complete. In 78,612 SBOMs ([arXiv:2607.22140](https://arxiv.org/abs/2607.22140)) 52.9% declare no
dependency edges and for 61.7% a missing path says nothing about reachability.

```
priority = EPSS × P(reach)
P(reach) = 1              reach is "yes"
         = residual       reach is "no" and the graph is complete
         = unknownPrior   reach is "no" on an incomplete graph, or "unknown"
```

`unknownPrior` defaults to 1, which makes an unknown rank exactly as plain EPSS would, and
`residual` defaults to 0. Only a finding that is "no" on a complete graph is marked suppressible.
Both parameters should come from measurement; no measured value is supplied here.

**Clickable area, not visibility.** A visibility assertion passes for a control under an overlay.
`visibleFraction` is the exact share of a control's box not covered by boxes painted above it,
measured on the grid cut by every box edge so overlapping covers count once. `clickPointExposed`
says whether the point a click lands on is free. A 100 by 40 button under a 30 by 20 badge at its
centre is 85% visible and not clickable at the default point. Which boxes are above the control is
read from the browser by the caller; where a browser is driving the page, its own trial click is
the simpler check and this function is for a stored layout snapshot.

## Adoption order

Each piece goes in shadow first and ends on evidence, not on a date.

1. Run `replayOpportunity` on existing request logs. If the cap is small, stop there for replay.
2. Compute `chooseBySubsets` beside `choose` for real tasks and log both with the verified outcome.
3. Call `learn` on verified traces and `begin` on requests, record what would have been replayed,
   and execute nothing. Proceed after 299 consecutive agreeing would-be replays, a count fixed in
   advance that bounds the error rate below 1% at 95%.
4. Replay `pure` and `read` steps live with an independent postcondition check. `write` steps wait
   for tool adapters that declare the effect class and an idempotency key.

5. Run `dropRivals` over the ledger claims a context packet would carry and log how many rivals
   it removes, before `src/context.js` uses it. Feed `rankVulnerabilities` from `forge radar` once
   an EPSS value and a reach verdict are attached to each advisory.

A changed model snapshot, tool version or tokenizer is a new hypothesis: its evidence starts again.
