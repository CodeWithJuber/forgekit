// Reuse jscpd's token detector and Git baseline. Run only a user-installed scanner,
// with a private, fixed config and transient report. Persist locations, never code.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readForgeConfig } from "./repo_config.js";
import { readWorkspaceText, symbolCandidates } from "./reuse_symbols.js";
import { redactSecrets } from "./secrets.js";

const label = "jscpd new clones";
const under = (base, path) => {
  const r = relative(base, path);
  return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`);
};

function scanner(root, env) {
  const fixed = env.FORGE_JSCPD_BIN;
  if (fixed && !isAbsolute(fixed)) return null;
  const base = realpathSync(root);
  const candidates = fixed
    ? [fixed]
    : String(env.PATH ?? env.Path ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .flatMap((dir) =>
          process.platform === "win32"
            ? [join(dir, "jscpd.exe"), join(dir, "node_modules", "jscpd", "run-jscpd.js")]
            : [join(dir, "jscpd")],
        );
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const bin = realpathSync(candidate);
    if (under(base, resolve(candidate)) || under(base, bin)) continue;
    if (process.platform === "win32" && !/\.(?:exe|js|mjs|cjs)$/i.test(bin)) continue;
    return /\.(?:mjs|cjs|js)$/i.test(bin) ? [process.execPath, bin] : [bin];
  }
  return null;
}

function location(root, side) {
  if (typeof side?.name !== "string" || !Number.isSafeInteger(side.start) || side.start < 1)
    return null;
  const full = resolve(root, side.name);
  if (!under(root, full) || /[\p{Cc}\p{Cf}]/u.test(side.name)) return null;
  return { file: redactSecrets(relative(root, full)).slice(0, 300), line: side.start };
}

/** @param {string} root @param {string} base
 * @param {{env?:NodeJS.ProcessEnv}} options */
export function duplicateGate(root, base = "HEAD", { env = process.env } = {}) {
  const incomplete = (reason) => ({ label, status: "INCOMPLETE", reason, findings: [] });
  if (readForgeConfig(root)?.verify?.duplicates !== true)
    return {
      label,
      status: "OFF",
      reason: "Set verify.duplicates to true to enable jscpd",
      findings: [],
    };
  let temp;
  try {
    const cmd = scanner(root, env);
    if (!cmd)
      return incomplete(
        "Install jscpd 5.4.2 outside the workspace and place it on PATH, or set FORGE_JSCPD_BIN to its absolute path.",
      );
    // Resolve an actual commit before invoking the scanner. A malformed ref, unborn
    // repository, or shallow checkout missing the base cannot establish a baseline.
    const head = spawnSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${base}^{commit}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const commit = head.stdout?.trim();
    if (head.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? ""))
      return incomplete("The requested Git baseline is unavailable");
    temp = realpathSync(mkdtempSync(join(tmpdir(), "forge-jscpd-")));
    const config = join(temp, "config.json");
    writeFileSync(config, "{}", { mode: 0o600 });
    const args = [
      ...cmd.slice(1),
      "--config",
      config,
      "--baseline-from-ref",
      commit,
      "--fail-on-new-clones=0",
      "--min-lines",
      "5",
      "--min-tokens",
      "50",
      "--ignore-identifiers",
      "--ignore",
      "**/.forge/**,**/node_modules/**,**/dist/**,**/build/**,**/.git/**",
      "--reporters",
      "json",
      "--output",
      temp,
      ".",
    ];
    const run = spawnSync(cmd[0], args, {
      cwd: root,
      env,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (run.error || run.signal || ![0, 1].includes(run.status))
      return incomplete("jscpd failed to run or exceeded its time limit");
    const report = JSON.parse(
      readWorkspaceText(temp, "jscpd-report.json", 16 * 1024 * 1024) ?? "null",
    );
    const count = report?.statistics?.total?.newClones;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Array.isArray(report.duplicates) ||
      run.status !== (count ? 1 : 0)
    )
      return incomplete(
        "jscpd did not return a complete new-clone verdict; verify the installed version and baseline",
      );
    const findings = [];
    for (const row of report.duplicates) {
      if (!row?.isNew) continue;
      const first = location(root, row.firstFile),
        second = location(root, row.secondFile);
      if (first && second) findings.push({ first, second });
      if (findings.length === 10) break;
    }
    return {
      label,
      status: count ? "FAIL" : "PASS",
      reason: `${count} new clone(s) against ${commit.slice(0, 12)}`,
      count,
      findings,
    };
  } catch {
    return incomplete("jscpd's report or local scanner was unavailable");
  } finally {
    if (temp) rmSync(temp, { force: true, recursive: true });
  }
}

// Pre-edit is deliberately cheap: use declarations already in the atlas and validate
// their source bytes. A matching name is a reuse lead, never proof of a clone.
export function preEditReuse(root, input) {
  if (!input?.file_path || readForgeConfig(root)?.verify?.duplicates !== true) return "";
  const parts = Array.isArray(input.edits) ? input.edits.slice(0, 8) : [input];
  const names = new Set();
  for (const part of parts) {
    const fresh = part?.new_string ?? part?.content;
    if (typeof fresh !== "string") continue;
    const declarations = /\b(?:function\s*\*?\s*|(?:def|fn|func)\s+)([A-Za-z_$][\w$]{1,99})\s*\(/g;
    const oldNames = new Set(
      typeof part.old_string === "string"
        ? Array.from(part.old_string.slice(0, 32768).matchAll(declarations), (m) => m[1])
        : [],
    );
    for (const match of fresh.slice(0, 32768).matchAll(declarations)) {
      if (!oldNames.has(match[1])) names.add(match[1]);
      if (names.size >= 4) break;
    }
  }
  if (!names.size) return "";
  const namesToCheck = [...names].slice(0, 4);
  const matches = symbolCandidates(root, namesToCheck.join(" ")).filter(
    (x) => names.has(x.name) && resolve(root, x.file) !== resolve(root, input.file_path),
  );
  if (!matches.length) return "";
  return (
    "Check these existing declarations before writing another implementation: " +
    matches.map((x) => `${x.file}:${x.line} (${x.name})`).join(", ") +
    ". The verifier compares new clone blocks against the Git baseline."
  );
}
