// A local comparison accepts measurements and citations from the investigation.
// Evidence is attributed to the supplied source; scoring does not verify a URL.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { appendDecision } from "./decide.js";
import { hasSecret } from "./secrets.js";

const GATES = [
  "licenseCompatible",
  "maintained",
  "noCriticalVulnerability",
  "stackCompatible",
  "withinBudget",
];
const CRITERIA = [
  "fit",
  "maturity",
  "maintenance",
  "performance",
  "documentation",
  "exitCost",
  "community",
];
const short = (s, limit = 300) =>
  typeof s === "string" && s.trim().length > 0 && s.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(s);
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function validateScores(weights) {
  if (!obj(weights) || Object.keys(weights).some((k) => !CRITERIA.includes(k)))
    throw new Error("Use only the seven documented weights");
  const resolved = Object.fromEntries(CRITERIA.map((k) => [k, weights[k] ?? 1]));
  if (
    !Object.values(resolved).every(
      (w) => typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 100,
    ) ||
    Object.values(resolved).every((w) => w === 0)
  )
    throw new Error("Weights must be in [0, 100] and total above zero");
  return resolved;
}

function gateStatus(name, row, now) {
  if (!obj(row) || !short(row.evidence)) return "unknown";
  if (name === "maintained") {
    // The most recent maintained release/commit must fall within one calendar year.
    const raw = row.value;
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "unknown";
    const date = new Date(`${raw}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== raw || date > now)
      return "unknown";
    const cutoff = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    return date >= cutoff ? "pass" : "fail";
  }
  return row.value === true ? "pass" : row.value === false ? "fail" : "unknown";
}

export function compareChoices(spec, now = new Date()) {
  if (
    !obj(spec) ||
    !short(spec.question) ||
    !Array.isArray(spec.candidates) ||
    spec.candidates.length < 2 ||
    spec.candidates.length > 20
  )
    throw new Error("Supply a question and between two and twenty candidates");
  const weights = validateScores(spec.weights ?? {});
  const mass = Object.values(weights).reduce((a, b) => a + b, 0);
  const names = new Set();
  const rows = spec.candidates.map((candidate) => {
    if (!obj(candidate) || !short(candidate.name, 100) || names.has(candidate.name.trim()))
      throw new Error("Each candidate needs a unique name");
    const name = candidate.name.trim();
    names.add(name);
    const gates = Object.fromEntries(
      GATES.map((k) => [
        k,
        {
          state: gateStatus(k, candidate.gates?.[k], now),
          evidence: short(candidate.gates?.[k]?.evidence) ? candidate.gates[k].evidence : null,
        },
      ]),
    );
    const reasons = GATES.filter((k) => gates[k].state !== "pass");
    if (reasons.length) {
      return {
        name,
        state: reasons.some((k) => gates[k].state === "fail") ? "rejected" : "needs-evidence",
        gates,
        reasons,
        score: null,
      };
    }
    const ratings = {};
    let sum = 0;
    for (const key of CRITERIA) {
      const row = candidate.scores?.[key];
      // Every rating is benefit-shaped: 5 = least upkeep/easiest exit.
      if (!Number.isFinite(row?.value) || row.value < 0 || row.value > 5 || !short(row.evidence)) {
        if (weights[key] > 0) reasons.push(key);
      } else {
        ratings[key] = { value: row.value, evidence: row.evidence };
        sum += row.value * weights[key];
      }
    }
    return {
      name,
      state: reasons.length ? "needs-evidence" : "qualified",
      gates,
      reasons,
      score: reasons.length ? null : sum / mass,
      ratings,
    };
  });
  const eligible = rows.filter((r) => r.state === "qualified").sort((a, b) => b.score - a.score);
  const leaders = eligible
    .filter((r) => Math.abs(r.score - eligible[0].score) < 1e-10)
    .map((r) => r.name);
  // A candidate lacking proof has not passed or failed its gates. Avoid recording a
  // final winner while that competitor could change the decision.
  const pending = rows.some((r) => r.state === "needs-evidence");
  const winner = !pending && leaders.length === 1 ? leaders[0] : null;
  return {
    question: spec.question,
    asOf: now.toISOString().slice(0, 10),
    weights,
    candidates: rows,
    leaders,
    winner,
    status: pending
      ? "needs-evidence"
      : leaders.length > 1
        ? "tie"
        : winner
          ? "selected"
          : "no-eligible-option",
  };
}

export async function compareCommand(args, root) {
  const flags = args.filter((a) => a.startsWith("--"));
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length !== 1 || flags.some((f) => f !== "--record" && f !== "--json"))
    throw new Error("Usage: forge decide compare <file.json> [--record] [--json]");
  const path = resolve(root, files[0]);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 128 * 1024)
    throw new Error("Supply a comparison JSON file under 128 KiB");
  const data = readFileSync(path, "utf8");
  if (hasSecret(data)) throw new Error("Remove credential-like values from the comparison");
  const report = compareChoices(JSON.parse(data));
  if (flags.includes("--record")) {
    if (!report.winner) throw new Error(`No decision to record (${report.status})`);
    const winner = report.candidates.find((c) => c.name === report.winner);
    const proof = Object.entries(winner.gates)
      .map(([k, v]) => `${k}=${v.evidence}`)
      .join(", ");
    const digest = createHash("sha256").update(data).digest("hex");
    const record = appendDecision(
      root,
      `${report.question} — selected ${report.winner} (${winner.score.toFixed(2)}/5, ${report.asOf}). Compared ${report.candidates.map((c) => `${c.name}: ${c.score?.toFixed(2) ?? c.state}`).join(", ")}. Evidence worksheet SHA-256 ${digest}. Gate evidence: ${proof}.`,
    );
    if (!record.ok) throw new Error(record.reason);
    report.decision = record.id;
  }
  console.log(JSON.stringify(report, null, 2));
}
