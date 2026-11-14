// The supervised runtime and native adapters use the same role and stage policy.
// Approval records live outside the checkout, and cannot be minted by a harness tool.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize } from "./ledger.js";
import { redactSecrets } from "./secrets.js";
import { contentHash } from "./util.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const turnCaps = [0, 5, 8, 10, 12, 15, 20, 25];
const levels = new Set(["denied", "restricted", "approval", "allowed", "sandbox"]);
const risks = new Set([
  "read",
  "write-local",
  "write-external",
  "execute",
  "spend",
  "communicate",
  "delete",
]);
const irreversible = new Set(["write-external", "spend", "communicate", "delete"]);
const own = (obj, key) => obj && Object.hasOwn(obj, key);
const exact = (value) => canonicalize(value, (s) => s);

export function defaultHarnessPolicy() {
  const reader = () => ({
    stage: 2,
    tools: { list_files: "allowed", read_file: "allowed", write_file: "denied" },
  });
  return {
    profiles: {
      coder: {
        stage: 3,
        tools: { list_files: "allowed", read_file: "allowed", write_file: "restricted" },
      },
      reviewer: reader(),
      researcher: reader(),
      analyst: reader(),
      browser: reader(),
    },
  };
}

function profileFor(policy, name) {
  if (!own(policy?.profiles, name)) return null;
  const profile = policy.profiles[name];
  return Number.isInteger(profile?.stage) && profile.stage >= 1 && profile.stage <= 7
    ? profile
    : null;
}

export function stageTurnCap(policy, profile) {
  return turnCaps[profileFor(policy, profile)?.stage ?? 0];
}

// Supported JSON Schema subset. Unsupported constraints fail closed so a descriptor
// cannot advertise validation that the executor doesn't perform.
const schemaKeys = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "description",
  "title",
  "default",
]);
export function validateHarnessArgs(schema, value) {
  function check(s, v, path, depth) {
    if (!s || typeof s !== "object" || depth > 12 || Object.keys(s).some((k) => !schemaKeys.has(k)))
      throw new Error("Unsupported argument schema");
    const type = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.includes(type) && !(types.includes("integer") && Number.isSafeInteger(v)))
      throw new Error(`${path}: unexpected type`);
    if (s.enum && !s.enum.includes(v)) throw new Error(`${path}: value outside enum`);
    if (type === "number" && (!Number.isFinite(v) || v < s.minimum || v > s.maximum))
      throw new Error(`${path}: number outside bounds`);
    if (type === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? 131072)))
      throw new Error(`${path}: text outside bounds`);
    if (type === "array") {
      if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? 256) || !s.items)
        throw new Error(`${path}: invalid array`);
      for (const [i, item] of v.entries()) check(s.items, item, `${path}[${i}]`, depth + 1);
    }
    if (type === "object") {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new Error(`${path}: expected plain object`);
      if (Object.keys(v).length > 64 || s.required?.some((k) => !own(v, k)))
        throw new Error(`${path}: missing or excessive arguments`);
      for (const [k, val] of Object.entries(v)) {
        if (!own(s.properties, k) || ["__proto__", "prototype", "constructor"].includes(k))
          throw new Error(`${path}: unknown property`);
        check(s.properties[k], val, `${path}.${k}`, depth + 1);
      }
    }
  }
  if (schema?.type !== "object") throw new Error("Tool needs an object argument schema");
  check(schema, value, "args", 0);
  return true;
}

function actionRule(policy, profileName, tool) {
  const profile = profileFor(policy, profileName);
  const deny = (reason) => ({ level: "denied", reason });
  if (!profile) return deny("Missing profile or invalid trust stage");
  if (!tool || !risks.has(tool.risk)) return deny("Unknown tool or missing risk descriptor");
  const explicit = own(profile.tools, tool.name);
  const rule = explicit ? profile.tools[tool.name] : "restricted";
  if (!levels.has(rule) || rule === "denied") return deny("Denied by profile tool table");
  const stage = profile.stage;
  if (tool.risk !== "read" && !explicit)
    return deny("Restricted default permits only bounded reads");
  if (stage === 1 && tool.risk !== "read")
    return deny("Observe stage permits only restricted reads");
  if (stage === 2 && !["read", "write-local"].includes(tool.risk))
    return deny("Assist stage permits only reads and reviewed local drafts");
  if (stage < 5 && irreversible.has(tool.risk))
    return deny("Stage does not permit external or irreversible effects");
  if (tool.risk === "write-local" && stage === 2) {
    if (rule === "sandbox") return deny("Assist stage cannot apply sandbox changes");
    return { level: "approval", reason: "Assist stage requires human approval for a local change" };
  }
  if (rule === "sandbox")
    return typeof tool.executeSandbox === "function"
      ? { level: "sandbox", reason: "Run using the trusted sandbox executor" }
      : deny("No sandbox executor registered");
  if (irreversible.has(tool.risk) || (tool.risk === "execute" && stage <= 4) || rule === "approval")
    return { level: "approval", reason: "Exact call requires human authorization" };
  if (rule === "restricted" && tool.risk !== "read" && typeof tool.validate !== "function")
    return deny("No restricted argument validator registered");
  if (tool.risk === "execute" && typeof tool.validate !== "function")
    return deny("Execution needs an allow-listed argument validator or sandbox");
  if (stage === 1 || rule === "restricted" || (tool.risk === "write-local" && stage <= 4))
    return { level: "restricted", reason: "Scoped by tool validator and trust stage" };
  return { level: "allowed", reason: "Allowed by profile and stage" };
}

export function visibleHarnessTools(policy, profile, tools) {
  return tools.filter((t) => actionRule(policy, profile, t).level !== "denied");
}

export function decideHarnessCall({ root, request, policy, tool, call }) {
  if (!tool || tool.name !== call?.name) return { level: "denied", reason: "Unregistered tool" };
  const rule = actionRule(policy, request?.profile ?? "coder", tool);
  if (rule.level === "denied") return rule;
  try {
    validateHarnessArgs(tool.inputSchema, call.args);
    const checked = tool.validate?.(call.args, { root, request });
    if (checked === false || checked?.then)
      throw new Error("Argument validator must return synchronously");
    return rule;
  } catch (e) {
    return {
      level: "denied",
      reason: redactSecrets(String(e?.message ?? "Invalid tool arguments")).slice(0, 300),
    };
  }
}

function privateFolder(root, area) {
  const dir = join(privateWorkspaceFile(root, "harness").replace(/\.json$/, ""), area);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync.native(dir) !== dir) throw new Error("Refusing symlinked harness private state");
  return dir;
}

// Publish a fully written file without replacement, including competing processes.
function publish(path, record) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, path);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return false;
  } finally {
    unlinkSync(temp);
  }
}
function readRecord(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 1536000) throw new Error("Invalid private harness record");
  return JSON.parse(readFileSync(path, "utf8"));
}
function identity({ runId, profile, call, attempt }) {
  if (
    typeof runId !== "string" ||
    !runId ||
    typeof profile !== "string" ||
    !profile ||
    !call ||
    typeof call.name !== "string" ||
    !call.args ||
    !["string", "number"].includes(typeof attempt)
  )
    throw new Error("Approval requires a run, profile, exact call and attempt");
  // Preserve byte-sensitive strings (including CRLF and Unicode form) and omit
  // provider-generated, transport-only call ids.
  return contentHash(exact([runId, profile, attempt, call.name, call.args]));
}
export function approvalStore(root, { now = Date.now } = {}) {
  const dir = privateFolder(root, "approvals");
  const rows = (id, suffix) => {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid approval id");
    return join(dir, `${id}.${suffix}`);
  };
  function get(id) {
    const data = readRecord(rows(id, "json"));
    if (!data) throw new Error("Approval not found");
    const decision = readRecord(rows(id, "decision"));
    const status = existsSync(rows(id, "used"))
      ? "consumed"
      : decision?.status === "denied"
        ? "denied"
        : now() >= data.expiresAt
          ? "expired"
          : (decision?.status ?? "pending");
    return { ...data, status };
  }
  function decide(id, status) {
    const row = get(id);
    if (row.status !== "pending") return row;
    publish(rows(id, "decision"), { status, at: now() });
    return get(id);
  }
  return {
    request(binding) {
      const id = identity(binding),
        ttl = binding.ttlMs ?? 600000;
      if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400000)
        throw new Error("Invalid approval lifetime");
      const at = now();
      const call = { name: binding.call.name, args: binding.call.args };
      // Never store literal credentials in prompts awaiting approval. Refuse if
      // redaction would change the arguments a human needs to inspect.
      if (redactSecrets(exact(call)) !== exact(call))
        throw new Error("Refusing secret-bearing approval arguments");
      publish(rows(id, "json"), {
        id,
        runId: binding.runId,
        profile: binding.profile,
        attempt: binding.attempt,
        call,
        at,
        expiresAt: at + ttl,
      });
      return get(id);
    },
    get,
    list: () =>
      readdirSync(dir)
        .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
        .map((f) => get(f.slice(0, -5))),
    grant: (id) => decide(id, "granted"),
    deny: (id) => decide(id, "denied"),
    consume(id, binding) {
      if (identity(binding) !== id || get(id).status !== "granted") return false;
      const row = get(id),
        at = now();
      return at < row.expiresAt && publish(rows(id, "used"), { at });
    },
  };
}

function freshTrust(stage, model) {
  if (
    !Number.isInteger(stage) ||
    stage < 1 ||
    stage > 7 ||
    typeof model !== "string" ||
    !model ||
    model.length > 250
  )
    throw new Error("Expected a named model and trust stage from 1 to 7");
  return { model, stage, verified: 0, total: 0, consecutive: 0, failures: 0, reason: "initial" };
}

export function advanceHarnessTrust(
  previous,
  outcome,
  { requiredRuns = 20, minPassRate = 0.9 } = {},
) {
  if (
    !Number.isInteger(requiredRuns) ||
    requiredRuns < 1 ||
    !Number.isFinite(minPassRate) ||
    minPassRate < 0 ||
    minPassRate > 1
  )
    throw new Error("Invalid trust thresholds");
  if (
    !Number.isInteger(outcome.gateViolations) ||
    outcome.gateViolations < 0 ||
    typeof outcome.verified !== "boolean"
  )
    throw new Error("Trust requires measured verification and violation counts");
  const state =
    previous.model === outcome.model
      ? { ...previous }
      : freshTrust(Math.min(2, previous.stage), outcome.model);
  state.total++;
  if (outcome.verified) state.verified++;
  state.consecutive = outcome.verified && !outcome.gateViolations ? state.consecutive + 1 : 0;
  state.failures = outcome.verified ? 0 : state.failures + 1;
  state.reason = "recorded";
  if (
    outcome.bypassedGate ||
    outcome.unverifiedFact ||
    outcome.secretExposed ||
    state.failures >= 3
  )
    return { ...freshTrust(Math.max(1, state.stage - 1), state.model), reason: "demoted" };
  if (
    state.stage < 7 &&
    state.consecutive >= requiredRuns &&
    state.verified / state.total >= minPassRate
  )
    return { ...freshTrust(state.stage + 1, state.model), reason: "promoted" };
  return state;
}

// Each successful hard-link publishes one immutable state transition at the next
// sequence index. Two processes racing retry against the winner's entire state.
// A repeated record id cannot count twice, including after a crash and restart.
export function harnessTrust(root) {
  const dir = privateFolder(root, "trust");
  function update(profile, model, initialStage, runId, outcome) {
    if (
      typeof profile !== "string" ||
      !profile ||
      profile.length > 128 ||
      (runId !== null && (typeof runId !== "string" || !runId || runId.length > 200))
    )
      throw new Error("Invalid trust profile or run identity");
    const scope = join(dir, contentHash(profile));
    mkdirSync(scope, { recursive: true, mode: 0o700 });
    for (let retry = 0; retry < 50; retry++) {
      const files = readdirSync(scope)
        .filter((s) => /^\d{12}\.json$/.test(s))
        .sort();
      const previous = files.length ? readRecord(join(scope, files.at(-1))).state : null;
      let state = previous ?? freshTrust(initialStage, model);
      if (previous && state.model !== model) {
        if (outcome) return state; // A superseded model cannot change its replacement's stage.
        state = { ...freshTrust(Math.min(2, initialStage), model), reason: "model_changed" };
      } else if (previous && !outcome) return state;
      if (outcome) {
        if (files.some((f) => readRecord(join(scope, f)).runId === runId)) return state;
        state = advanceHarnessTrust(state, outcome);
      }
      const file = join(scope, `${String(files.length + 1).padStart(12, "0")}.json`);
      if (publish(file, { profile, runId, state, at: Date.now() })) return state;
    }
    throw new Error("Concurrent trust updates exceeded retry budget");
  }
  return {
    get: (profile, model, initialStage) => update(profile, model, initialStage, null, null),
    record: (profile, runId, outcome, initialStage) =>
      update(profile, outcome.model, initialStage, runId, outcome),
  };
}
