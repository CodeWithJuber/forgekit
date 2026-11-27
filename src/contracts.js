// forge contracts — the shape of each graduated command's `--json` output, as data.
//
// A script that reads `forge <cmd> --json` depends on these fields. Each contract has a
// version; removing a field, renaming it or changing its type is a breaking change, which
// ships only with a new major release (Semantic Versioning, docs/RELEASING.md) and a new
// contract version. Adding a field is not breaking: the validator ignores keys it does not
// declare (src/schema.js), so a contract lists what a caller may rely on, not every key.
//
// test/contracts.test.js runs every command below against a fixture repository and checks
// its output with these specs, and checks that the exit status is the same with and without
// --json. docs/CLI-CONTRACTS.md is the reader's view of the same table.

/** @typedef {import("./schema.js").Spec} Spec */

const str = /** @type {Spec} */ ({ type: "string" });
const strOrNull = /** @type {Spec} */ ({ type: "string", nullable: true });
const num = /** @type {Spec} */ ({ type: "number" });
const int = /** @type {Spec} */ ({ type: "number", integer: true, min: 0 });
const bool = /** @type {Spec} */ ({ type: "boolean" });
const unit = /** @type {Spec} */ ({ type: "number", min: 0, max: 1 });
/** @param {Spec} items */
const list = (items) => /** @type {Spec} */ ({ type: "array", items });
/**
 * @param {Record<string, Spec>} props
 * @param {string[]} [required] defaults to every declared prop that is not nullable
 */
const obj = (props, required) =>
  /** @type {Spec} */ ({
    type: "object",
    props,
    required: required ?? Object.keys(props).filter((k) => !props[k].nullable),
  });

/** The JSON a usage-level refusal prints for commands that report one in JSON. */
const errorBody = obj({ error: { type: "string", nonEmpty: true } });

/**
 * Keyed by the command and, where the output differs by form, the subcommand.
 * `exit` narrows the exit statuses when one form always ends the same way.
 * @type {Record<string, {version: number, spec: Spec, note?: string, exit?: number[]}>}
 */
export const CONTRACTS = {
  "taste list": { version: 1, spec: obj({ styles: list(str) }) },
  "taste apply": {
    version: 1,
    spec: obj({ style: str, action: { type: "enum", values: ["written", "unchanged"] } }),
  },
  "taste refused": { version: 1, spec: errorBody, exit: [1] },

  "uicheck contrast": {
    version: 1,
    spec: obj({
      fg: str,
      bg: str,
      fgHex: str,
      bgHex: str,
      ratio: { type: "number", min: 1, max: 21 },
      passesAA: bool,
      passesAAA: bool,
      level: { type: "enum", values: ["AAA", "AA", "fail"] },
      large: bool,
      required: obj({ aa: num, aaa: num }),
      notes: list(str),
    }),
  },
  "uicheck fingerprint": {
    version: 1,
    spec: obj({
      palette: list(obj({ h: num, s: num, l: num })),
      paletteSize: int,
      hueBuckets: list(int),
      spacing: list(num),
      spacingBase: { type: "number", nullable: true },
      spacingOnScale: unit,
      fontFamilies: list(str),
      radii: list(num),
      radiusLevels: int,
      shadowLevels: int,
    }),
  },
  "uicheck design": {
    version: 1,
    spec: obj({
      pass: bool,
      verdict: { type: "enum", values: ["pass", "fail", "insufficient-signal"] },
      slop: num,
      conform: { type: "number", nullable: true },
      violations: list(obj({ feature: str, detail: str, hint: str })),
      checks: list(obj({ id: str, pass: bool, detail: str }, ["id", "pass", "detail"])),
      hasProjectFingerprint: bool,
      taste: strOrNull,
      tauSlop: num,
      tauConform: num,
      theme: obj({ sources: list(str), colors: int, radius: int, shadow: int }),
    }),
  },

  imagine: {
    version: 1,
    spec: obj({
      task: str,
      targets: list(str),
      found: bool,
      predictedBreaks: list(obj({ file: str, confidence: unit })),
      tests: list(str),
      uncovered: list(str),
      riskScore: { type: "number", min: 0 },
    }),
  },
  "imagine --run": {
    version: 1,
    note: "the prediction above plus dryRun; counts are present when the run produced a verdict",
    spec: obj({
      task: str,
      targets: list(str),
      found: bool,
      dryRun: obj(
        {
          ok: bool,
          reason: strOrNull,
          passed: { type: "number", integer: true, min: 0, nullable: true },
          failed: { type: "number", integer: true, min: 0, nullable: true },
          worktree: { type: "enum", values: ["removed", "leaked"], nullable: true },
          isolation: { type: "object", nullable: true },
        },
        ["ok"],
      ),
    }),
  },

  lean: {
    version: 1,
    spec: obj({
      warnings: list(str),
      footprint: obj({
        files: int,
        linesAdded: int,
        newAbstractions: list(str),
        unrequestedAbstractions: list(str),
      }),
      hasDiff: bool,
      scope: { type: "enum", values: ["session", "worktree"] },
    }),
  },

  anchor: {
    version: 1,
    spec: obj({
      goal: str,
      keywords: list(str),
      changed: list(str),
      onGoal: list(str),
      offGoal: list(str),
      drift: bool,
      driftScore: unit,
    }),
  },
  "anchor set": { version: 1, spec: obj({ goal: { type: "string", nonEmpty: true } }) },
  "anchor show": { version: 1, spec: obj({ goal: strOrNull }) },
  "anchor clear": { version: 1, spec: obj({ cleared: bool }) },

  diagnose: {
    version: 1,
    note: "escalate and claimId are present once the signature crosses the thrash threshold",
    spec: obj(
      {
        thrash: bool,
        signature: { type: "string", nonEmpty: true },
        count: { type: "number", integer: true, min: 1 },
        escalate: strOrNull,
        claimId: strOrNull,
      },
      ["thrash", "signature", "count"],
    ),
  },

  deja: {
    version: 1,
    spec: list(
      obj({
        id: str,
        kind: str,
        score: num,
        verified: bool,
        day: num,
        gist: str,
      }),
    ),
  },

  "reuse query": {
    version: 1,
    spec: obj(
      {
        tier: { type: "enum", values: ["exact", "near", "adapt", "miss"] },
        artifact: strOrNull,
        requiresRevalidation: bool,
        reasons: list(str),
      },
      ["tier", "requiresRevalidation", "reasons"],
    ),
  },
  "reuse mint": {
    version: 1,
    note: "ok false comes with a reason and exit status 1",
    spec: obj({ ok: bool, id: strOrNull, reason: strOrNull }, ["ok"]),
  },
  "reuse stats": {
    version: 1,
    spec: obj({ events: int, byOutcome: { type: "object" }, savedEstimate: num }),
  },

  rank: {
    version: 1,
    spec: obj({
      built: bool,
      nodes: int,
      edges: int,
      topFiles: list(obj({ file: str, score: num, history: num, incidents: int, hazard: num })),
      topSymbols: list(obj({ name: str, file: str, score: num })),
      cycles: list(list(str)),
      chokepoints: list(obj({ file: str, splits: int })),
    }),
  },

  dash: {
    version: 1,
    note: "one line on stdout once listening; the server keeps running",
    spec: obj({
      url: { type: "string", pattern: /^http:\/\/127\.0\.0\.1:\d+$/ },
      port: { type: "number", integer: true, min: 1, max: 65535 },
      root: str,
    }),
  },
  "dash refused": { version: 1, spec: errorBody, exit: [1] },

  report: {
    version: 1,
    spec: obj({
      path: { type: "string", nonEmpty: true },
      bytes: { type: "number", integer: true, min: 1 },
    }),
  },
  "report refused": { version: 1, spec: errorBody, exit: [1] },

  "cloud status": {
    version: 1,
    note: "enrolled false has no other field; remote appears with --remote",
    spec: obj(
      {
        enrolled: bool,
        revision: strOrNull,
        pending: { type: "boolean", nullable: true },
        remote: { type: "object", nullable: true },
      },
      ["enrolled"],
    ),
  },
  "cloud preview": {
    version: 1,
    spec: obj({
      bytes: int,
      files: list(obj({ path: str, kind: str, redacted: bool, sha256: str, bytes: int })),
      skipped: { type: "object" },
    }),
  },
  "cloud logout": { version: 1, spec: obj({ enrolled: bool, remoteDeleted: bool }) },
  "relay status": {
    version: 1,
    note: "with --remote: remote.history is first, current, newer, older, fork or missing, and older, fork and missing carry remote.warning",
    spec: obj(
      {
        enrolled: bool,
        revision: strOrNull,
        pending: { type: "boolean", nullable: true },
        remote: {
          type: "object",
          nullable: true,
          props: {
            revision: strOrNull,
            authenticated: bool,
            files: int,
            history: {
              type: "enum",
              values: ["first", "current", "newer", "older", "fork", "missing"],
            },
            warning: strOrNull,
          },
          required: ["authenticated", "files", "history"],
        },
      },
      ["enrolled"],
    ),
  },
  "relay push": {
    version: 1,
    spec: obj({ revision: strOrNull, modified: int, removed: int, skipped: { type: "object" } }),
  },
  "relay list": {
    version: 1,
    spec: obj({
      revision: strOrNull,
      parent: strOrNull,
      authenticated: bool,
      files: list(obj({ path: str, kind: str, redacted: bool, sha256: str, bytes: int })),
    }),
  },
  "relay read --json": {
    version: 1,
    spec: obj({
      revision: str,
      parent: strOrNull,
      path: str,
      kind: str,
      redacted: bool,
      sha256: { type: "string", pattern: /^[a-f0-9]{64}$/ },
      bytes: int,
      content: str,
    }),
  },

  collide: {
    version: 1,
    spec: obj({
      risk: unit,
      sessions: list(
        obj({ author: strOrNull, day: num, rec: num, direct: list(str), coupled: list(str) }, [
          "day",
          "rec",
          "direct",
          "coupled",
        ]),
      ),
      mine: list(str),
    }),
  },
};

/** Every command that has at least one contract, in table order. */
export function contractCommands() {
  return [...new Set(Object.keys(CONTRACTS).map((k) => k.split(" ")[0]))];
}
