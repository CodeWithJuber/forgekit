// forge knowledge-router — A7 of the TASK loop: route(fact) → storage home, TOTAL by
// construction (formal-synthesis Theorem T6). The discipline already existed as prose
// ("decisions go in decisions.md, facts in the ledger…") but prose routing is exactly
// what sessions forget — so knowledge landed nowhere and was re-learned. This module is
// the third routing leg beside route.js (model tiers) and intent.js (intent classes):
// the SAME exemplar k-NN math (labeled rows + overlap coefficient + confidence gate),
// tuned by adding example rows, never by editing regexes. Totality is the one place the
// shape differs from classifyIntent: a fact resembling nothing in the bank falls back to
// the ledger (`ledger-fact`, provenance:"fallback") — the ledger is the home whose decay
// semantics make an unsure placement safe — it is NEVER "none".
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { appendDecision } from "./decide.js";
import { intentGrams } from "./intent.js";
import { shadowFact } from "./ledger_bridge.js";
import { repoLedger } from "./ledger_store.js";
import { setOverlap } from "./math.js";
import { defaultStore, add as recallAdd, reindex } from "./recall.js";
import { hasSecret } from "./secrets.js";
import { slug } from "./util.js";

/**
 * The storage homes — DATA, one row per home. `write` is the dispatch mode:
 * "auto" homes have an append-only store this module may write directly;
 * "advise" homes are curated FILES (rewritten wholesale by a human or another
 * command), so routing there returns advice, never a blind write.
 * @type {Record<string, {write:"auto"|"advise", where:string, advice:string}>}
 */
export const HOMES = {
  "claude-md": {
    write: "advise",
    where: "CLAUDE.md / AGENTS.md",
    advice: `project-wide instruction — add it to the canonical source (AGENTS.md, or source/ then \`${BRAND.cli} sync\`) so every agent loads it`,
  },
  rule: {
    write: "advise",
    where: "rules / guards",
    advice: `a policy is enforced, not remembered — encode it as a rule or guard (global/rules/, a PreToolUse guard) rather than prose`,
  },
  skill: {
    write: "advise",
    where: "a skill / runbook",
    advice: `a procedure belongs in replayable steps — capture it as a skill or runbook document, not a one-line memory`,
  },
  state: {
    write: "advise",
    where: ".forge/state.md",
    advice: `session state — record it with \`${BRAND.cli} handoff\` so the next session resumes instead of re-assuming`,
  },
  decision: {
    write: "auto",
    where: ".forge/decisions.md + ledger",
    advice: `a settled choice — \`${BRAND.cli} decide "<what — why>"\` appends the ADR-lite line`,
  },
  "ledger-fact": {
    write: "auto",
    where: ".forge/ledger",
    advice: `a verifiable repo fact — \`${BRAND.cli} remember "<name>" "<fact>"\` shadows it into the ledger`,
  },
  recall: {
    write: "auto",
    where: "~/.forge/recall",
    advice: `a personal preference — \`${BRAND.cli} recall add "<name>" "<fact>"\` keeps it across repos`,
  },
};

/** The totality fallback (T6): unsure placements land here, never nowhere. */
export const FALLBACK_HOME = "ledger-fact";

/** Labeled home bank — DATA, not decision code. Extend coverage by adding rows. */
export const HOME_EXEMPLARS = [
  // claude-md — durable project-wide conventions every agent must follow
  {
    text: "always run the full test suite before committing",
    home: "claude-md",
  },
  { text: "this repo uses tabs not spaces for indentation", home: "claude-md" },
  { text: "all api handlers must validate their input", home: "claude-md" },
  { text: "never use default exports in this codebase", home: "claude-md" },
  { text: "commit messages follow conventional commits", home: "claude-md" },
  { text: "use the shared logger instead of console log", home: "claude-md" },
  {
    text: "docs must move in the same pull request as the code",
    home: "claude-md",
  },
  {
    text: "prefer composition over inheritance in the services layer",
    home: "claude-md",
  },
  {
    text: "every module gets a header comment explaining why it exists",
    home: "claude-md",
  },
  { text: "imports are esm only never require", home: "claude-md" },
  // rule — enforced policy: block / never / deny (a guard, not a memory)
  { text: "never commit directly to the main branch", home: "rule" },
  { text: "block any edit to the generated dist folder", home: "rule" },
  { text: "deny network calls from unit tests", home: "rule" },
  { text: "reject pull requests without a changelog entry", home: "rule" },
  { text: "do not delete migration files ever", home: "rule" },
  { text: "guard against force pushes to release branches", home: "rule" },
  { text: "never log user emails in production", home: "rule" },
  { text: "block writes outside the project directory", home: "rule" },
  { text: "credentials must never be committed to the repo", home: "rule" },
  { text: "forbid new runtime dependencies without an adr", home: "rule" },
  // skill — a reusable multi-step procedure / runbook
  {
    text: "how to cut a release bump version update changelog tag publish",
    home: "skill",
  },
  { text: "steps to add a new database migration", home: "skill" },
  { text: "the procedure for rotating the api keys", home: "skill" },
  { text: "how to regenerate the protobuf bindings", home: "skill" },
  {
    text: "runbook for restoring the staging database from backup",
    home: "skill",
  },
  {
    text: "how to profile a slow endpoint with the flame graph tooling",
    home: "skill",
  },
  { text: "checklist for onboarding a new microservice", home: "skill" },
  { text: "workflow to reproduce the flaky test locally", home: "skill" },
  { text: "how to run the app against a local postgres", home: "skill" },
  { text: "steps to debug a failing ci pipeline", home: "skill" },
  // state — in-flight session progress the NEXT session resumes from
  {
    text: "halfway through migrating the auth module tests still failing",
    home: "state",
  },
  {
    text: "next step is to wire pagination into the export endpoint",
    home: "state",
  },
  {
    text: "currently refactoring the payment service two files left",
    home: "state",
  },
  {
    text: "paused while waiting for the api schema from the backend team",
    home: "state",
  },
  {
    text: "todo tomorrow finish the error handling in the upload path",
    home: "state",
  },
  {
    text: "in progress renaming the user manager across the callers",
    home: "state",
  },
  {
    text: "the branch has uncommitted changes to the cache layer",
    home: "state",
  },
  { text: "still need to update the docs for the new flag", home: "state" },
  {
    text: "resume from the failing integration test in checkout",
    home: "state",
  },
  {
    text: "work remaining hook the new validator into the form",
    home: "state",
  },
  // decision — "we chose X over Y because Z" (settled, with a why)
  { text: "we chose sqlite over postgres because zero ops", home: "decision" },
  { text: "picked vitest instead of jest for startup speed", home: "decision" },
  {
    text: "decided to keep the monorepo rather than splitting packages",
    home: "decision",
  },
  {
    text: "went with server side rendering because seo matters here",
    home: "decision",
  },
  {
    text: "we rejected graphql because the api surface is small",
    home: "decision",
  },
  {
    text: "chose to vendor the parser instead of adding a dependency",
    home: "decision",
  },
  { text: "agreed to drop support for the legacy browser", home: "decision" },
  {
    text: "we opted for feature flags over long lived branches",
    home: "decision",
  },
  {
    text: "settled on a queue in redis because it is already deployed",
    home: "decision",
  },
  {
    text: "decision use jwt sessions because the gateway validates them",
    home: "decision",
  },
  // ledger-fact — a verifiable fact about THIS repo/system (also the T6 fallback)
  {
    text: "the api rate limit is 100 requests per minute",
    home: "ledger-fact",
  },
  {
    text: "postgres runs on port 5433 in this environment",
    home: "ledger-fact",
  },
  {
    text: "the payments service times out after 30 seconds",
    home: "ledger-fact",
  },
  {
    text: "the ci pipeline takes about twelve minutes end to end",
    home: "ledger-fact",
  },
  { text: "the default branch is called trunk", home: "ledger-fact" },
  { text: "user ids are uuids not integers", home: "ledger-fact" },
  { text: "the mobile app pins the tls certificate", home: "ledger-fact" },
  {
    text: "the staging bucket is named acme staging assets",
    home: "ledger-fact",
  },
  { text: "sessions expire after 24 hours", home: "ledger-fact" },
  { text: "the csv exporter caps at 50000 rows", home: "ledger-fact" },
  // recall — personal, cross-repo preference (first-person signal)
  { text: "i prefer short commit messages", home: "recall" },
  { text: "my editor is neovim with lsp enabled", home: "recall" },
  { text: "i like seeing the diff before any commit", home: "recall" },
  { text: "my timezone is ist so schedule builds accordingly", home: "recall" },
  { text: "i want explanations in hindi when possible", home: "recall" },
  { text: "my default shell is fish", home: "recall" },
  { text: "i always want a summary at the end of a session", home: "recall" },
  { text: "call me by my first name in replies", home: "recall" },
  { text: "i prefer yarn over npm on my machine", home: "recall" },
  { text: "my laptop has 16gb ram so keep builds light", home: "recall" },
];

// intentGrams, not a new tokenizer: task verbs and function-word stripping behave the
// same for "what kind of knowledge is this" as for "what kind of work is this".
const EXEMPLAR_GRAMS = HOME_EXEMPLARS.map((e) => ({
  ...e,
  grams: intentGrams(e.text),
}));

/**
 * k-NN over the home bank: similarity-weighted vote among the top-k neighbors, gated on
 * the best similarity. TOTAL (T6): below the gate — or an unparseable text — the answer
 * is the FALLBACK_HOME with provenance "fallback", never "none". Neighbors ride along so
 * every routing is attributable to its evidence (mizan: the confidence IS the evidence).
 * @param {string} text
 * @param {{k?:number, minConf?:number}} [opts]
 * @returns {{home:string, confidence:number, provenance:"knn"|"fallback", write:"auto"|"advise", neighbors:{text:string, home:string, sim:number}[]}}
 */
export function routeFact(text, { k = 3, minConf = 0.25 } = {}) {
  const grams = intentGrams(text);
  const sims = !grams.size
    ? []
    : EXEMPLAR_GRAMS.map((e) => ({
        text: e.text,
        home: e.home,
        sim: setOverlap(grams, e.grams),
      }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k);
  const top = sims[0];
  if (!top || top.sim < minConf) {
    return {
      home: FALLBACK_HOME,
      confidence: Number((top?.sim ?? 0).toFixed(3)),
      provenance: "fallback",
      write: HOMES[FALLBACK_HOME].write,
      neighbors: sims,
    };
  }
  const votes = new Map();
  for (const s of sims) votes.set(s.home, (votes.get(s.home) ?? 0) + s.sim);
  const [home] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    home,
    confidence: Number(top.sim.toFixed(3)),
    provenance: "knn",
    write: HOMES[home].write,
    neighbors: sims,
  };
}

/** A short, stable fact NAME from its text (ledger/recall stores key facts by name). */
export function factName(text) {
  const s = slug(text).split("-").slice(0, 6).join("-");
  return s || "fact";
}

/**
 * Store a routed fact in its home. Refuses secrets (same rule as every store, checked
 * HERE so no dispatch target can be reached with one). "advise"-mode homes — and every
 * home when `mode:"advise"` (the CLI's --dry-run) — return advice and write NOTHING.
 * Dispatch reuses the existing stores verbatim: appendDecision, shadowFact into the
 * repo ledger, recall add + personal-ledger shadow (the exact `recall add` CLI path).
 * Never throws — a routing must never break its caller.
 * @param {string} root repo root
 * @param {string} text the fact
 * @param {{mode?:"auto"|"advise", route?:ReturnType<typeof routeFact>}} [opts]
 * @returns {{ok:boolean, home:string, stored:boolean, reason?:string, refused?:boolean, ref?:string, advice?:string}}
 */
export function storeFact(root, text, { mode = "auto", route } = {}) {
  const body = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const r = route ?? routeFact(body);
  if (!body) return { ok: false, home: r.home, stored: false, reason: "empty fact" };
  if (hasSecret(body)) {
    return {
      ok: false,
      home: r.home,
      stored: false,
      refused: true,
      reason: "refused: looks like a secret/credential — store a pointer, not the value",
    };
  }
  const advice = HOMES[r.home]?.advice ?? HOMES[FALLBACK_HOME].advice;
  if (mode === "advise" || r.write === "advise")
    return { ok: true, home: r.home, stored: false, advice };
  try {
    if (r.home === "decision") {
      const d = appendDecision(root, body);
      return d.ok
        ? { ok: true, home: r.home, stored: true, ref: d.id }
        : { ok: false, home: r.home, stored: false, reason: d.reason };
    }
    if (r.home === "recall") {
      const store = defaultStore();
      const res = recallAdd(store, factName(body), body);
      if (!res.ok) return { ok: false, home: r.home, stored: false, reason: res.reason };
      // Shadow into the PERSONAL ledger beside the global store, then re-index — the
      // same best-effort pair `forge recall add` performs (repo promotion stays explicit).
      try {
        shadowFact(join(store, "ledger"), factName(body), body);
        reindex(store);
      } catch {}
      return { ok: true, home: r.home, stored: true, ref: res.slug };
    }
    // ledger-fact (including every T6 fallback): a claim in the repo ledger, where
    // decay semantics make an unsure placement safe (unverified → fades to unsure).
    const s = shadowFact(repoLedger(root), factName(body), body);
    return s.ok
      ? { ok: true, home: "ledger-fact", stored: true, ref: s.id }
      : { ok: false, home: "ledger-fact", stored: false, reason: s.reason };
  } catch (err) {
    return {
      ok: false,
      home: r.home,
      stored: false,
      reason: String(err?.message ?? err),
    };
  }
}
