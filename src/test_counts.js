import { stripVTControlCharacters } from "node:util";

import { terminalReport } from "./runner_reports.js";

// Count only complete runner summaries. Exit zero alone can also mean skip or no discovery.
/** @typedef {{total:number, pass:number, fail:number, cancelled:number, skipped:number, todo:number}} Counts */
/** @typedef {Counts & {incompleteReports?:number}} EvidenceCounts */
/** @returns {Counts} */
const empty = () => ({ total: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });

/** @param {EvidenceCounts|null|undefined} counts */
export function countVerdict(counts) {
  if (!counts) return "INCOMPLETE";
  const { total, pass, fail, cancelled, skipped, todo } = counts;
  if (Number.isSafeInteger(fail) && fail > 0) return "FAIL";
  const values = [total, pass, fail, cancelled, skipped, todo];
  if (
    !values.every((v) => Number.isSafeInteger(v) && v >= 0) ||
    total !== pass + fail + cancelled + skipped + todo
  )
    return "INCOMPLETE";
  return pass > 0 && cancelled === 0 && !counts.incompleteReports ? "PASS" : "INCOMPLETE";
}

/** @type {Record<string, keyof Counts>} */
const summaryTerms = {
  passed: "pass",
  failed: "fail",
  error: "fail",
  errors: "fail",
  skipped: "skipped",
  pending: "skipped",
  xfailed: "skipped",
  xpassed: "pass",
  todo: "todo",
  todos: "todo",
  cancelled: "cancelled",
};

/** @param {string} summary @param {string} [expectedTotal] */
function terms(summary, expectedTotal) {
  const counts = empty();
  for (const part of summary.split(/\s*[,|]\s*/)) {
    const match = /^(\d+) ([a-z]+)$/.exec(part.trim());
    if (!match) return null;
    if (/^(?:warnings?|deselected|rerun)$/.test(match[2])) continue;
    const key = summaryTerms[match[2]];
    if (!key) return null;
    counts[key] += Number(match[1]);
    counts.total += Number(match[1]);
  }
  return expectedTotal == null || counts.total === Number(expectedTotal) ? counts : null;
}

/** Read complete reports from one output stream. A partial report contributes no pass.
 * @param {string} output @param {(Counts|null)[]} summaries @param {string} [reporter] */
function collectReports(output, summaries, reporter = "") {
  const terminal = terminalReport(output, reporter);
  summaries.push(...terminal.reports);
  const text = terminal.text;
  if (!text) return;
  const node =
    /^(?:#|ℹ) tests (\d+)\n(?:#|ℹ) suites \d+\n(?:#|ℹ) pass (\d+)\n(?:#|ℹ) fail (\d+)\n(?:#|ℹ) cancelled (\d+)\n(?:#|ℹ) skipped (\d+)\n(?:#|ℹ) todo (\d+)\n(?:#|ℹ) duration_ms [\d.]+$/gm;
  let nodeReports = 0;
  for (const m of text.matchAll(node)) {
    const [total, pass, fail, cancelled, skipped, todo] = m.slice(1).map(Number);
    summaries.push({ total, pass, fail, cancelled, skipped, todo });
    nodeReports++;
  }
  const starts = (text.match(/^(?:#|ℹ) tests \d+$/gm) ?? []).length;
  for (let i = nodeReports; i < starts; i++) summaries.push(null);
  for (const m of text.matchAll(/^Tests:[ \t]*([^\n]*)$/gm)) {
    const parts = /^(?:(.+),[ \t]*)?(\d+) total$/.exec(m[1].trim());
    if (parts?.[1]) summaries.push(terms(parts[1], parts[2]));
    else summaries.push(parts?.[2] === "0" ? empty() : null);
  }
  for (const m of text.matchAll(/^[ \t]*Tests[ \t]+([^\n]+?)\s+\((\d+)\)[ \t]*$/gm))
    summaries.push(terms(m[1], m[2]));
  for (const m of text.matchAll(
    /^(?:=+ )?((?:\d+ [a-z]+, )*\d+ [a-z]+|no tests ran) in [\d.]+s(?: \([\d:]+\))?(?: =+)?$/gm,
  ))
    summaries.push(m[1] === "no tests ran" ? empty() : terms(m[1]));
}

/** Parse terminal summaries emitted by Node TAP/spec, pytest, Jest and Vitest.
 * pnpm multiplexes workspace lifecycle output by project. Never join parts of two
 * different packages' reports or let a passing package cover a silent sibling.
 * @param {unknown} output @param {string[]} [pnpmProjects] @param {string} [reporter] @returns {EvidenceCounts|null} */
export function observedTestCounts(output, pnpmProjects = [], reporter = "") {
  if (!output) return null;
  const text = stripVTControlCharacters(String(output)).replaceAll("\r\n", "\n");
  /** @type {(Counts|null)[]} */
  const summaries = [];
  if (text.includes(" test: ") || text.includes(" test$ ")) {
    /** @type {Map<string,string[]>} */
    const streams = new Map();
    const expected = new Set(pnpmProjects);
    const outer = [];
    for (const line of text.split("\n")) {
      const scope = /^(\S.*?) test([:$]) (.*)$/.exec(line);
      if (!scope) {
        outer.push(line);
        continue;
      }
      const name = scope[1].replaceAll("\\", "/").replace(/^\.\//, "");
      let lines = streams.get(name);
      if (!lines && scope[2] !== "$" && !expected.has(name)) {
        outer.push(line);
        continue;
      }
      if (!lines) {
        lines = [];
        streams.set(name, lines);
      }
      if (scope[2] === ":") lines.push(scope[3]);
    }
    collectReports(outer.join("\n"), summaries, reporter);
    for (const lines of streams.values()) {
      const before = summaries.length;
      collectReports(lines.join("\n"), summaries, reporter);
      if (summaries.length === before) summaries.push(null);
    }
    if (streams.size || expected.size > 1)
      for (const name of expected) if (!streams.has(name)) summaries.push(null);
  } else {
    collectReports(text, summaries, reporter);
    if (pnpmProjects.length > 1) summaries.push(null);
  }
  if (!summaries.length) return null;
  const all = empty();
  let malformed = 0;
  let incomplete = 0;
  for (const c of summaries) {
    if (
      !c ||
      !Object.values(c).every(Number.isSafeInteger) ||
      c.total !== c.pass + c.fail + c.cancelled + c.skipped + c.todo
    ) {
      malformed++;
      continue;
    }
    if (countVerdict(c) === "INCOMPLETE") incomplete++;
    for (const k of /** @type {(keyof Counts)[]} */ (Object.keys(all))) all[k] += c[k];
  }
  return malformed || (summaries.length > 1 && incomplete)
    ? { ...all, incompleteReports: malformed + incomplete }
    : all;
}

/** @param {unknown} suites */
export function passingSuiteEvidence(suites) {
  return (
    Array.isArray(suites) &&
    suites.length > 0 &&
    suites.every(
      (s) => s?.status === "PASS" && s.exitCode === 0 && countVerdict(s.reportedCounts) === "PASS",
    )
  );
}
