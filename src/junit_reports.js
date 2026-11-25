// Gradle's console often prints only BUILD SUCCESSFUL. Count JUnit reports
// generated during this invocation, including reports from nested projects.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readBounded } from "./private_paths.js";

export function gradleReports(root) {
  const files = new Map();
  const dirs = [root];
  let entries = 0;
  while (dirs.length) {
    const dir = dirs.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 100000) throw new Error("Gradle report discovery exceeded its file budget");
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      const path = join(dir, entry.name);
      if (entry.name !== "build") {
        dirs.push(path);
        continue;
      }
      const results = join(path, "test-results");
      if (!lstatSync(results, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const task of readdirSync(results, { withFileTypes: true })) {
        if (!task.isDirectory()) continue;
        const taskDir = join(results, task.name);
        for (const report of readdirSync(taskDir, { withFileTypes: true })) {
          if (!report.isFile() || !/^TEST-.*\.xml$/.test(report.name)) continue;
          const file = join(taskDir, report.name);
          const stat = lstatSync(file, { bigint: true });
          files.set(file, [stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":"));
        }
      }
    }
  }
  return files;
}

export function countedGradleReports(root, before) {
  const counts = { total: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
  let fresh = 0;
  for (const [file, stamp] of gradleReports(root)) {
    if (before.get(file) === stamp) return null;
    const xml = readBounded(file, 8 * 1024 * 1024)
      .bytes.toString("utf8")
      .trim();
    const suite = /^(?:<\?xml[^?]*\?>\s*)?<testsuite\s+([^>]+)>[\s\S]*<\/testsuite>$/.exec(xml);
    if (!suite) return null;
    const attrs = Object.fromEntries(
      [...suite[1].matchAll(/\b(tests|failures|errors|skipped)=["'](\d+)["']/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    if (
      !["tests", "failures", "errors", "skipped"].every((key) => Number.isSafeInteger(attrs[key]))
    )
      return null;
    const failures = attrs.failures + attrs.errors;
    if (attrs.tests < failures + attrs.skipped) return null;
    counts.total += attrs.tests;
    counts.fail += failures;
    counts.skipped += attrs.skipped;
    counts.pass += attrs.tests - failures - attrs.skipped;
    fresh++;
  }
  return fresh ? counts : null;
}
