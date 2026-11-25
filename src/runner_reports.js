// Terminal grammars for test programs used by package scripts and native suites.
/** @param {number} total */
const counts = (total, fail = 0, skipped = 0) => ({
  total,
  pass: total - fail - skipped,
  fail,
  cancelled: 0,
  skipped,
  todo: 0,
});

export function reporterFor(command = "") {
  const executable =
    /(?:^|[\s/\\])(?:node(?:\.exe)?\s+--test|pytest|vitest|jest|mocha|rspec|phpunit|cargo\s+test|bun\s+test|unittest|dotnet\s+test|go\s+test|gradlew?\s+test|mvn\s+test)(?=\s|$)/i.exec(
      command.trim(),
    );
  if (!executable) return "";
  const word = executable[0]
    .trim()
    .replace(/^[/\\]/, "")
    .split(/\s/)[0]
    .toLowerCase();
  return word === "node.exe" ? "node" : word === "gradlew" ? "gradle" : word;
}

// Use only the terminal report for a stream. Reporter trailers carry timings,
// seeds or completion status. Test diagnostics before the report are ordinary text.
/** @param {string} raw */
export function terminalReport(raw, expected = "") {
  const lines = raw
    .trimEnd()
    .split("\n")
    .map((line) => line.trimEnd());
  while (
    lines.length &&
    /^(?:\s*|.+ test: Done|Done(?: in [\d.]+s?\.?)?|Time:\s+[\d.]+.*|Ran all test suites.*|Snapshots:\s+.*|Finished in [\d.]+.*|Randomized with seed \d+|\s*(?:Start at|Duration)\s+.*|[-=]{4,}|\[INFO\] (?:BUILD SUCCESS|Total time:.*|Finished at:.*|[-]{4,})|\d+ actionable tasks?:.*)$/.test(
      lines.at(-1) ?? "",
    )
  )
    lines.pop();
  const last = lines.at(-1)?.trim() || "";
  const text = lines.join("\n");
  /** @param {RegExp} test */
  const tail = (test) => {
    let start = lines.length;
    while (start > 0 && test.test(lines[start - 1])) start--;
    return lines.slice(start).join("\n");
  };
  /** @param {string} kind */
  const allow = (kind) => !expected || expected === kind;
  if (allow("node")) {
    const reporterEnd = text.search(/\n(?:✖ failing tests:|ℹ failing tests:)/);
    const nodeText = reporterEnd < 0 ? text : text.slice(0, reporterEnd).trimEnd();
    const header = [...nodeText.matchAll(/^(?:#|ℹ) tests \d+$/gm)].at(-1);
    if (
      header &&
      /^(?:#|ℹ) (?:duration_ms [\d.]+|tests \d+|suites \d+|pass \d+|fail \d+|cancelled \d+|skipped \d+|todo \d+)$/.test(
        nodeText.split("\n").at(-1) ?? "",
      )
    ) {
      return { kind: "node", text: nodeText.slice(header.index), reports: [] };
    }
  }
  if (allow("jest") && /^Tests:[ \t]*\d/.test(last) && /\b\d+ total$/.test(last))
    return { kind: "jest", text: tail(/^Tests:[ \t]*\d/), reports: [] };
  if (allow("vitest") && /^Tests\s+.*\(\d+\)$/.test(last))
    return { kind: "vitest", text: last, reports: [] };
  if (
    allow("pytest") &&
    /^(?:=+ )?(?:\d+ (?:failed|passed|skipped|xpassed|xfailed|errors?|warnings?|deselected|rerun)|no tests ran).*\sin [\d.]+s\b/.test(
      last,
    )
  )
    return { kind: "pytest", text: last, reports: [] };

  let m;
  if (allow("mocha") && /^\d+ (?:passing|failing|pending)(?: \([^)]*\))?$/.test(last)) {
    const result = counts(0);
    for (const row of tail(/^\s*\d+ (?:passing|failing|pending)(?: \([^)]*\))?\s*$/).matchAll(
      /(\d+) (passing|failing|pending)/g,
    )) {
      const n = Number(row[1]);
      result.total += n;
      result[row[2] === "passing" ? "pass" : row[2] === "failing" ? "fail" : "skipped"] += n;
    }
    return { reports: [result] };
  }
  if (allow("rspec") && (m = /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?$/.exec(last)))
    return { reports: [counts(+m[1], +m[2], Number(m[3] ?? 0))] };
  if (
    (m = /^(\d+) runs?, \d+ assertions?, (\d+) failures?, (\d+) errors?, (\d+) skips?$/.exec(last))
  )
    return { reports: [counts(+m[1], +m[2] + +m[3], +m[4])] };
  if (allow("phpunit") && (m = /^OK \((\d+) tests?, \d+ assertions?\)$/.exec(last)))
    return { reports: [counts(+m[1])] };
  if (allow("phpunit") && (m = /^Tests:\s*(\d+),\s*Assertions:\s*\d+(.*)\.$/.exec(last))) {
    let failed = 0,
      skipped = 0;
    for (const match of m[2].matchAll(/,\s*([\w ]+):\s*(\d+)/g)) {
      if (/^(?:Errors|Failures)$/i.test(match[1])) failed += +match[2];
      else skipped += +match[2];
    }
    return { reports: [counts(+m[1], failed, skipped)] };
  }
  if (
    allow("unittest") &&
    (m = /(?:^|\n)Ran (\d+) tests? in [\d.]+s\s+(OK|FAILED)(?: \(([^)]*)\))?$/.exec(text))
  ) {
    let failed = 0,
      skipped = 0;
    for (const match of (m[3] || "").matchAll(/([\w ]+)=(\d+)/g)) {
      if (/failures|errors|unexpected successes/i.test(match[1])) failed += +match[2];
      else skipped += +match[2];
    }
    return { reports: [counts(+m[1], failed, skipped)] };
  }
  if (allow("cargo") && /^test result: (?:ok|FAILED)\./.test(last)) {
    const result = counts(0);
    for (const row of text.matchAll(
      /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; \d+ filtered out.*$/gm,
    )) {
      result.pass += +row[1];
      result.fail += +row[2];
      result.skipped += +row[3];
    }
    result.total = result.pass + result.fail + result.skipped;
    return { reports: [result] };
  }
  const bunRun = /^Ran (\d+) tests? across \d+ files?\b/.exec(last);
  if (allow("bun") && bunRun) {
    const result = counts(0);
    let observed = false;
    for (let i = lines.length - 2; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const row = /^(\d+) (pass|fail|skip|todo|expect\(\) calls)$/.exec(line);
      if (!row) break;
      if (row[2] === "expect() calls") continue;
      const key = /** @type {"pass"|"fail"|"skipped"|"todo"} */ (
        row[2] === "skip" ? "skipped" : row[2]
      );
      result[key] = Number(row[1]);
      observed = true;
    }
    result.total = Number(bunRun[1]);
    return { reports: observed ? [result] : [] };
  }
  if (
    allow("mvn") &&
    (m =
      /^(?:\[INFO\]\s*)?Tests run:\s*(\d+), Failures:\s*(\d+), Errors:\s*(\d+), Skipped:\s*(\d+)(?:,.*)?$/.exec(
        last,
      ))
  )
    return { reports: [counts(+m[1], +m[2] + +m[3], +m[4])] };
  if (allow("dotnet") && /^(?:Passed!|Failed!)/.test(last)) {
    const reports = [
      ...text.matchAll(
        /^(?:Passed!|Failed!)\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+),.*$/gm,
      ),
    ].map((row) => counts(+row[4], +row[1], +row[3]));
    return { reports };
  }
  if (
    allow("gradle") &&
    (m = /^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?$/.exec(last))
  )
    return { reports: [counts(+m[1], Number(m[2] ?? 0), Number(m[3] ?? 0))] };
  if (allow("go") && last.startsWith("{")) {
    const result = counts(0);
    let observedPackage = false;
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.Package === "string" && typeof event.Action === "string")
          observedPackage = true;
        if (!event.Package || !event.Test || !["pass", "fail", "skip"].includes(event.Action))
          continue;
        result[
          /** @type {"pass"|"fail"|"skipped"} */ (
            event.Action === "skip" ? "skipped" : event.Action
          )
        ]++;
        result.total++;
      } catch {
        return { reports: [null] };
      }
    }
    return { reports: observedPackage ? [result] : [] };
  }
  return { reports: [] };
}
