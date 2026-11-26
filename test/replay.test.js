// Replay engine: serving a repeated request from verified traces with no model call.
// Ground-truth procedures are generated at random, so the expected steps are known exactly and
// independently of the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anytimeLower, minAnytimeStreak } from "../src/mathcore/sequential.js";
import { ReplayEngine, replayOpportunity } from "../src/replay/engine.js";
import {
  addOutputs,
  chooseChild,
  induceFamily,
  instantiate,
  readRequest,
  runtimeSources,
} from "../src/replay/induce.js";
import {
  accepts,
  canonical,
  fine,
  flatten,
  generalize,
  matchPattern,
  patternOf,
  trigramCosine,
  typeOf,
  unflatten,
  words,
} from "../src/replay/tokens.js";
import { rng } from "./_prng.js";

const WORDS =
  "open close show list count build check fetch store rotate archive verify render queue from into with using under after before inside project branch folder report ticket region cluster".split(
    " ",
  );
const LOWER = "abcdefghijklmnopqrstuvwxyz";

function makeGenerator(random) {
  const pick = (xs) => xs[Math.floor(random() * xs.length)];
  const mixed = () => {
    let s = pick(LOWER).toUpperCase() + pick(LOWER);
    for (let i = 0; i < 4; i++)
      s +=
        random() < 0.3
          ? String(Math.floor(random() * 10))
          : random() < 0.5
            ? pick(LOWER)
            : pick(LOWER).toUpperCase();
    return s;
  };
  const digits = () => String(10 + Math.floor(random() * 9000));
  const procedure = () => {
    const pool = WORDS.slice().sort(() => random() - 0.5);
    const k = 1 + Math.floor(random() * 3);
    const numeric = Array.from({ length: k }, (_, i) => i > 0 && random() < 0.3);
    const intent = [pool.pop()];
    for (let i = 0; i < k; i++) {
      intent.push({ slot: i });
      intent.push(pool.pop());
      if (random() < 0.4) intent.push(pool.pop());
    }
    const steps = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, depth) => {
      const parts = [`${pool.pop() ?? "run"} --${pool.pop() ?? "opt"} `];
      for (let i = 0; i < k; i++)
        if (random() < 0.7) {
          parts.push({ slot: i, f: numeric[i] ? "id" : pick(["id", "id", "lower", "upper"]) });
          parts.push(pick(["/", " ", ":", "-x ", ".log "]));
        }
      if (depth > 0 && random() < 0.5) {
        parts.push("--ref=");
        parts.push({ out: Math.floor(random() * depth) });
      }
      const num = numeric.findIndex(Boolean);
      return {
        tool: pick(["shell", "http", "file"]),
        parts,
        limit: num >= 0 && random() < 0.5 ? { slot: num } : 5 + depth,
        salt: Math.floor(random() * 1e6),
      };
    });
    return { k, numeric, intent, steps };
  };
  const values = (proc) => proc.numeric.map((isNum) => (isNum ? digits() : mixed()));
  const trace = (proc, vals) => {
    const outs = [];
    const steps = proc.steps.map((step) => {
      const cmd = step.parts
        .map((p) => {
          if (typeof p === "string") return p;
          if (p.out !== undefined) return outs[p.out].id;
          const v = vals[p.slot];
          return p.f === "lower" ? v.toLowerCase() : p.f === "upper" ? v.toUpperCase() : v;
        })
        .join("");
      const limit = typeof step.limit === "number" ? step.limit : Number(vals[step.limit.slot]);
      let h = step.salt;
      for (const ch of vals.join("|")) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
      const out = { id: `Tok${h.toString(36)}Z`, code: 0 };
      outs.push(out);
      return { tool: step.tool, effect: "read", args: { cmd, opts: { limit, dry: false } }, out };
    });
    const intent = proc.intent.map((p) => (typeof p === "string" ? p : vals[p.slot])).join(" ");
    return { intent, steps, outcome: "verified" };
  };
  return { procedure, values, trace };
}

function predict(family, example) {
  const read = readRequest(family, example.intent);
  if (!read.values) return { miss: read.reason };
  const runtime = runtimeSources(read.values, example.env);
  let node = family.root;
  const steps = [];
  for (let depth = 0; ; depth++) {
    const child = chooseChild(node, runtime);
    if (!child) return { stopped: "undetermined_branch", steps };
    if (child.end) return { steps };
    if (!child.closed) return { stopped: "argument_without_source", steps };
    const made = instantiate(child, runtime);
    if (made.missing) return { stopped: "missing_source", steps };
    steps.push({ tool: child.tool, args: made.args });
    addOutputs(runtime, depth, example.steps[depth]?.out);
    node = child;
  }
}

test("replay: induced procedures reproduce training traces and predict unseen requests exactly", (t) => {
  const gen = makeGenerator(rng(8086));
  let procedures = 0;
  let training = 0;
  let heldOut = 0;
  let abstained = 0;
  for (let trial = 0; trial < 250; trial++) {
    const proc = gen.procedure();
    const n = 2 + Math.floor(trial % 4);
    const examples = Array.from({ length: n }, () => gen.trace(proc, gen.values(proc)));
    const family = induceFamily(examples);
    assert.ok(family, "family should be inducible");
    for (const e of examples) {
      const got = predict(family, e);
      assert.equal(
        canonical(got.steps),
        canonical(e.steps.map(({ tool, args }) => ({ tool, args }))),
        "training trace not reproduced",
      );
      assert.equal(got.stopped, undefined);
      training++;
    }
    for (let i = 0; i < 8; i++) {
      const fresh = gen.trace(proc, gen.values(proc));
      const got = predict(family, fresh);
      if (got.miss) {
        // A value outside the classes seen so far. Declining is correct; guessing is not.
        assert.equal(got.miss, "slot_out_of_type");
        abstained++;
        continue;
      }
      assert.equal(got.stopped, undefined);
      assert.equal(
        canonical(got.steps),
        canonical(fresh.steps.map(({ tool, args }) => ({ tool, args }))),
        "held-out trace mispredicted",
      );
      heldOut++;
    }
    procedures++;
  }
  // Every unseen request was either predicted exactly or declined as unfamiliar; none was wrong.
  t.diagnostic(
    `${procedures} random procedures: ${training} training traces reproduced, ${heldOut} unseen requests predicted exactly, ${abstained} declined, 0 wrong`,
  );
  assert.equal(heldOut + abstained, procedures * 8);
  assert.ok(training >= 2 * procedures);
  assert.ok(heldOut > 2 * abstained, `predicted ${heldOut}, declined ${abstained}`);
  // Degenerate training sets: one example, duplicates, values drawn from a pool of two. The only
  // promise here is soundness: whatever the engine does emit for a training request is what the
  // verified trace did, step for step, and it may stop early.
  let degenerate = 0;
  const small = makeGenerator(rng(1234));
  for (let trial = 0; trial < 200; trial++) {
    const proc = small.procedure();
    const pool = [small.values(proc), small.values(proc)];
    const n = 1 + (trial % 4);
    const examples = Array.from({ length: n }, (_, i) =>
      small.trace(proc, pool[(trial + i * i) % 2]),
    );
    const family = induceFamily(examples);
    if (!family) continue;
    for (const e of examples) {
      const got = predict(family, e);
      assert.equal(got.miss, undefined);
      const truth = e.steps.map(({ tool, args }) => ({ tool, args }));
      assert.equal(
        canonical(got.steps),
        canonical(truth.slice(0, got.steps.length)),
        "emitted a step the trace did not take",
      );
      if (!got.stopped) assert.equal(got.steps.length, truth.length);
      degenerate++;
    }
  }
  assert.ok(degenerate > 300);
});

const cheap = () =>
  new ReplayEngine({
    alpha: 0.05,
    costs: { teacher: 1, replay: 0.01 },
    loss: { pure: 0, read: 0, write: 9 },
  });

test("replay: an argument with no source is handed back, after the closed prefix has run", () => {
  const random = rng(5);
  const nonce = () => Math.floor(random() * 1e9).toString(36);
  const eng = cheap();
  const mk = (name) => ({
    intent: `publish note ${name}`,
    outcome: "verified",
    steps: [
      { tool: "file", effect: "read", args: { path: `notes/${name}.md` }, out: { bytes: 10 } },
      {
        tool: "http",
        effect: "read",
        args: { url: "https://example.invalid/publish", token: nonce() },
        out: { ok: true },
      },
    ],
  });
  for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"])
    eng.learn(mk(name));
  assert.equal(eng.families.length, 1);
  const run = eng.begin("publish note omega");
  const first = run.next();
  assert.deepEqual(first, {
    action: "execute",
    tool: "file",
    args: { path: "notes/omega.md" },
    effect: "read",
  });
  run.report({ out: { bytes: 3 }, verified: true });
  const second = run.next();
  assert.deepEqual(second, { action: "handoff", reason: "argument_without_source", executed: 1 });
});

test("replay: negation, injection and unseen wording never match a pattern", () => {
  const eng = cheap();
  const restore = (id) => ({
    intent: `restore account ${id}`,
    outcome: "verified",
    steps: [
      {
        tool: "shell",
        effect: "read",
        args: { cmd: `acct restore ${id} --from-backup latest` },
        out: { code: 0 },
      },
    ],
  });
  const remove = (id) => ({
    intent: `delete account ${id}`,
    outcome: "verified",
    steps: [{ tool: "shell", effect: "read", args: { cmd: `acct rm ${id}` }, out: { code: 0 } }],
  });
  const polite = (id) => ({ ...remove(id), intent: `please delete account ${id}` });
  for (let id = 100; id < 110; id++) {
    eng.learn(restore(id));
    eng.learn(remove(id));
  }
  eng.learn(polite(500));
  assert.equal(eng.families.length, 2);
  const plan = (text) => {
    const run = eng.begin(text);
    return run.state === "miss" ? "miss" : (run.next().args?.cmd ?? "handoff");
  };
  assert.equal(plan("delete account 777"), "acct rm 777");
  assert.equal(plan("restore account 777"), "acct restore 777 --from-backup latest");
  assert.equal(plan("please delete account 778"), "acct rm 778");
  const refused = [
    "do not delete account 777", // negation in front
    "never delete account 777",
    "delete account 777 and 778", // extra clause inside the slot
    "delete account 777; drop database", // injected text
    "delete account all", // slot value outside the observed type
    "kindly delete account 777", // filler never observed
    "delete accounts 777", // different constant
    "remove account 777", // paraphrase: goes to the teacher once, then becomes a pattern
    "",
  ];
  for (const text of refused) assert.equal(plan(text), "miss", `should not match: ${text}`);
});

test("replay: a step unlocks exactly when its evidence bound reaches the threshold", () => {
  const eng = new ReplayEngine({
    alpha: 0.05,
    costs: { teacher: 1, replay: 0.01 },
    loss: { pure: 0, read: 0.2, write: 9 },
  });
  assert.ok(Math.abs(eng.threshold("pure") - 0.01) < 1e-12);
  assert.ok(Math.abs(eng.threshold("read") - 0.21 / 1.2) < 1e-12);
  assert.ok(Math.abs(eng.threshold("write") - 0.901) < 1e-12);
  assert.equal(eng.threshold("irreversible"), Infinity);
  const names = "ab cd ef gh ij kl mn op qr st uv wx yz".split(" ");
  const mk = (i, verb = "restart") => {
    const svc = names[i % names.length] + names[(i * 7 + 3) % names.length];
    const host = names[(i * 5 + 1) % names.length] + names[(i * 3 + 2) % names.length];
    return {
      intent: `${verb} ${svc} on host ${host}`,
      outcome: "verified",
      steps: [
        {
          tool: "shell",
          effect: "read",
          args: { cmd: `ssh ${host} systemctl is-active ${svc}` },
          out: { code: 0 },
        },
        {
          tool: "shell",
          effect: verb === "wipe" ? "irreversible" : "write",
          args: { cmd: `ssh ${host} systemctl ${verb} ${svc}` },
          out: { code: 0 },
        },
      ],
    };
  };
  const probe = () => {
    const run = eng.begin("restart cache on host edge");
    const a = run.next();
    if (a.action !== "execute") return [a.reason];
    run.report({ out: { code: 0 }, verified: true });
    const b = run.next();
    return ["execute", b.action === "execute" ? "execute" : b.reason];
  };
  eng.learn(mk(0));
  eng.learn(mk(1));
  assert.deepEqual(probe(), ["not_enough_evidence"]);
  const needRead = minAnytimeStreak(eng.threshold("read"), 0.05);
  const needWrite = minAnytimeStreak(eng.threshold("write"), 0.05);
  let unlockedRead = null;
  let unlockedWrite = null;
  // The probe itself reports one verified read once the read step is open; count evidence exactly.
  for (let i = 2; unlockedWrite === null && i < 200; i++) {
    const res = eng.learn(mk(i));
    assert.equal(res.shadow.agreed, true);
    const state = (() => {
      const run = eng.begin("restart cache on host edge");
      const a = run.next();
      if (a.action !== "execute") return 0;
      const fam = eng.families[0];
      const second = fam.model.root.children[0].children[0];
      return eng.blocker(fam, second, ["cache", "edge"]) === null ? 2 : 1;
    })();
    if (state >= 1 && unlockedRead === null) unlockedRead = i - 1;
    if (state === 2) unlockedWrite = i - 1;
  }
  assert.equal(unlockedRead, needRead);
  assert.equal(unlockedWrite, needWrite);
  assert.deepEqual(probe(), ["execute", "execute"]);
  // A failed live step stops the run and is counted.
  const run = eng.begin("restart cache on host edge");
  run.next();
  run.report({ out: { code: 1 }, verified: false });
  assert.equal(run.next().reason, "step_failed");
  // Irreversible steps are never replayed, whatever the evidence.
  const wipe = new ReplayEngine({
    alpha: 0.05,
    costs: { teacher: 1, replay: 0.01 },
    loss: { pure: 0, read: 0, write: 0 },
  });
  for (let i = 0; i < 80; i++) wipe.learn(mk(i, "wipe"));
  const w = wipe.begin("wipe cache on host edge");
  assert.equal(w.next().action, "execute");
  w.report({ out: { code: 0 }, verified: true });
  assert.equal(w.next().reason, "needs_confirmation");
});

test("replay: branches follow observed evidence and an unseen value hands off", () => {
  const eng = cheap();
  const hosts = "ab cd ef gh ij kl mn op qr st".split(" ");
  const mk = (i, state) => {
    const host = hosts[i % hosts.length] + hosts[(i * 3 + 1) % hosts.length];
    const steps = [
      {
        tool: "shell",
        effect: "read",
        args: { cmd: `ssh ${host} systemctl is-active web` },
        out: { state },
      },
    ];
    if (state === "active")
      steps.push({
        tool: "shell",
        effect: "read",
        args: { cmd: `ssh ${host} systemctl reload web` },
        out: { code: 0 },
      });
    if (state === "inactive")
      steps.push({
        tool: "shell",
        effect: "read",
        args: { cmd: `ssh ${host} systemctl start web` },
        out: { code: 0 },
      });
    return { intent: `heal web on ${host}`, outcome: "verified", steps };
  };
  const states = ["active", "inactive", "masked"];
  for (let i = 0; i < 60; i++) eng.learn(mk(i, states[i % 3]));
  const follow = (state) => {
    const run = eng.begin("heal web on zz");
    const first = run.next();
    assert.equal(first.args.cmd, "ssh zz systemctl is-active web");
    run.report({ out: { state }, verified: true });
    const second = run.next();
    return second.action === "execute"
      ? second.args.cmd
      : `${second.action}:${second.reason ?? ""}`;
  };
  assert.equal(follow("active"), "ssh zz systemctl reload web");
  assert.equal(follow("inactive"), "ssh zz systemctl start web");
  assert.equal(follow("masked"), "done:");
  assert.equal(follow("failed"), "handoff:undetermined_branch");
});

test("replay: the prefix tree cannot follow a path no trace took", () => {
  // Two verified procedures share a middle step. Counting transitions step to step, as a
  // first-order graph does, makes "a then m then y" the best-scoring path from a.
  const A = ["a", "m", "x"];
  const B = ["b", "m", "y"];
  const observed = [A, A, B, B, B];
  const counts = new Map();
  for (const t of observed)
    for (let i = 0; i + 1 < t.length; i++)
      counts.set(`${t[i]}>${t[i + 1]}`, (counts.get(`${t[i]}>${t[i + 1]}`) ?? 0) + 1);
  const best = (from) =>
    [...counts]
      .filter(([k]) => k.startsWith(`${from}>`))
      .sort((p, q) => q[1] - p[1])[0][0]
      .split(">")[1];
  const spliced = ["a", best("a"), best(best("a"))];
  assert.deepEqual(spliced, ["a", "m", "y"]);
  assert.ok(!observed.some((t) => canonical(t) === canonical(spliced)));
  const mk = (kind, seq, i) => ({
    intent: `ship ${kind} build ${i}`,
    outcome: "verified",
    steps: seq.map((tool) => ({ tool, effect: "read", args: { n: 1 }, out: { ok: true } })),
  });
  const examples = observed.map((seq, i) => mk(seq === A ? "alpha" : "beta", seq, 100 + i));
  const family = induceFamily(examples);
  const language = [];
  const walk = (node, path) => {
    for (const child of node.children) {
      if (child.end) language.push(path);
      else walk(child, [...path, child.tool]);
    }
  };
  walk(family.root, []);
  assert.deepEqual(language.map(canonical).sort(), [A, B].map(canonical).sort());
});

test("replay: a changed tool retires the step quickly and the new form is learned", (t) => {
  const eng = cheap();
  const names = "ab cd ef gh ij kl mn op qr st uv wx".split(" ");
  const mk = (i, form) => {
    const svc = names[i % names.length] + names[(i * 5 + 2) % names.length];
    return {
      intent: `flush ${svc} cache`,
      outcome: "verified",
      steps: [
        {
          tool: "shell",
          effect: "write",
          args: { cmd: form === "old" ? `cachectl flush ${svc}` : `cache flush --service ${svc}` },
          out: { code: 0 },
        },
      ],
    };
  };
  let i = 0;
  const open = () => {
    const run = eng.begin("flush zz cache");
    return run.state === "miss" ? { run, step: { action: "miss" } } : { run, step: run.next() };
  };
  while (open().step.action !== "execute") eng.learn(mk(i++, "old"));
  // No replay before the write step has earned its streak of agreeing teacher runs.
  assert.ok(i >= minAnytimeStreak(eng.threshold("write"), 0.05));
  assert.equal(open().step.args.cmd, "cachectl flush zz");
  // A long good history: 300 verified live replays.
  for (let k = 0; k < 300; k++) open().run.report({ out: { code: 0 }, verified: true });
  const family = eng.families[0];
  const row = eng.statFor(family, family.model.root.children[0]);
  const goodOutcomes = row.s;
  assert.ok(goodOutcomes >= 300);
  const floor = eng.threshold("write");
  let cumulativeAlone = 0;
  while (anytimeLower(row.s, cumulativeAlone, 0.05) >= floor) cumulativeAlone++;
  // The tool changes. Live replays now fail verification.
  let failures = 0;
  for (;;) {
    const { run, step } = open();
    if (step.action !== "execute") break;
    failures++;
    run.report({ out: { code: 127 }, verified: false });
    assert.ok(failures < 100, "detector should have fired");
  }
  assert.equal(open().step.action, "miss");
  assert.ok(failures < cumulativeAlone);
  // The teacher handles requests again and produces the new form.
  let relearn = 0;
  while (open().step.action !== "execute") {
    eng.learn(mk(i++, "new"));
    relearn++;
    assert.ok(relearn < 200, "should recover");
  }
  assert.equal(open().step.args.cmd, "cache flush --service zz");
  t.diagnostic(
    `after ${goodOutcomes} good outcomes, ${failures} failed replays retired the step (the cumulative bound alone would allow ${cumulativeAlone}); ${relearn} fresh teacher runs taught the new form`,
  );
});

test("replay: upper limit on the share of requests replay can serve", () => {
  const value = replayOpportunity([100, 40, 10, 3], 34);
  assert.ok(Math.abs(value - 72 / 153) < 1e-12);
  assert.equal(replayOpportunity([], 34), 0);
  assert.equal(replayOpportunity([5, 5, 5], 34), 0);
});

test("replay tokens: generalization keeps shared words and turns the rest into slots", () => {
  let pattern = patternOf(words("restart nginx on server A"));
  pattern = generalize(pattern, words("Restart apache on server B."));
  assert.deepEqual(pattern, [{ c: "restart" }, { v: 0 }, { c: "on" }, { c: "server" }, { v: 1 }]);
  assert.deepEqual(matchPattern(pattern, words("restart redis on server C")), [["redis", "C"]]);
  assert.deepEqual(matchPattern(pattern, words("stop redis on server C")), []);
  // Generalizing with an example the pattern already covers changes nothing.
  assert.deepEqual(generalize(pattern, words("restart redis on server C")), pattern);
  // A repeated constant makes the reading ambiguous, and both readings are reported.
  const loose = [{ v: 0 }, { c: "on" }, { v: 1 }];
  assert.equal(matchPattern(loose, words("turn on lights on porch")).length, 2);
});

test("replay tokens: slot types accept what was seen and refuse what was not", () => {
  const type = typeOf(["nginx", "apache2"]);
  assert.deepEqual(type, { cls: "alnum", min: 1, max: 1 });
  assert.equal(accepts(type, "redis7"), true);
  assert.equal(accepts(type, "redis; rm -rf /"), false);
  assert.equal(accepts(type, "a.b"), false);
  assert.equal(accepts(type, ""), false);
  assert.deepEqual(typeOf(["10.0.0.5", "web-1"]), { cls: "ident", min: 1, max: 1 });
});

test("replay tokens: fine tokens are lossless and flatten round-trips", () => {
  const text = "ssh web-1 'systemctl restart nginx' # 10.0.0.5";
  assert.equal(fine(text).join(""), text);
  for (const value of [
    { cmd: "ls", opts: { limit: 5, dry: false, tags: ["a", "b"] }, none: null },
    ["x", { y: 1 }],
    "plain",
    { empty: {}, list: [] },
  ])
    assert.equal(canonical(unflatten(flatten(value))), canonical(value));
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("replay tokens: trigram similarity only ranks", () => {
  assert.ok(Math.abs(trigramCosine("restart nginx", "restart nginx") - 1) < 1e-12);
  assert.ok(
    trigramCosine("restart nginx", "restart ngnix") >
      trigramCosine("restart nginx", "deploy the app"),
  );
  assert.equal(trigramCosine("", "anything"), 0);
});
