// forge skill-gate — vet a skill / MCP config BEFORE it's installed. ToxicSkills
// found ~36% of skills flawed / 13.4% critical, ~60% of the risk in the instruction
// (markdown) layer — so string prose matters as much as code. Prefer a real scanner
// (Snyk agent-scan) when present; otherwise a built-in heuristic catches the loud cases.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Instruction-layer + tool-layer red flags. `critical` blocks install.
const RULES = [
  {
    re: /\bcurl\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    sev: "critical",
    msg: "pipes curl to a shell (remote code execution)",
  },
  {
    re: /\bwget\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    sev: "critical",
    msg: "pipes wget to a shell (remote code execution)",
  },
  {
    re: /base64\s+(--decode|-d|-D)\b[^\n]*\|\s*(sh|bash)/i,
    sev: "critical",
    msg: "decodes and executes an obfuscated payload",
  },
  {
    re: /ignore\s+(all\s+)?(your\s+)?previous\s+instructions|disregard\s+(your|the|all)\s+(system|previous|prior)/i,
    sev: "critical",
    msg: "prompt-injection phrasing in the instruction layer",
  },
  {
    re: /(id_rsa|id_ed25519|\.aws\/credentials|\.claude\.json|\.env)\b[^\n]{0,80}\b(curl|wget|nc|https?:\/\/|base64|>\s*\/dev\/tcp)/i,
    sev: "critical",
    msg: "reads a credential file near a network/exfil call",
  },
  {
    re: /\brm\s+-rf\s+[~/]/i,
    sev: "high",
    msg: "destructive recursive delete of an absolute/home path",
  },
  {
    re: /\beval\s*\(\s*(await\s+)?fetch|child_process|\bexec(Sync)?\s*\(/i,
    sev: "high",
    msg: "dynamic code execution / process spawn",
  },
];

/** Pure: scan raw text for red flags. Returns findings [{sev, msg}]. */
export function heuristicScan(text) {
  const s = String(text);
  return RULES.filter((r) => r.re.test(s)).map(({ sev, msg }) => ({
    sev,
    msg,
  }));
}

/** Scan a path (SKILL.md/.mcp.json) or raw text. Real scanner if available, else heuristic. */
export function scan(target) {
  const isPath = typeof target === "string" && existsSync(target);
  const content = isPath ? readFileSync(target, "utf8") : String(target);

  if (isPath && process.env.FORGE_SKILLGATE_NOEXTERNAL !== "1") {
    try {
      // Pinned (verified 2026-07-05) — never @latest for code we execute; re-verify via dev-radar.
      const out = execFileSync("uvx", ["snyk-agent-scan==0.5.12", target], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 90000,
      });
      const critical = /\bcritical\b|tool poisoning|prompt injection|malicious/i.test(out);
      return {
        ok: !critical,
        critical,
        scanner: "snyk-agent-scan",
        findings: [],
        raw: out,
      };
    } catch (err) {
      if (process.env.FORGE_DEBUG === "1")
        process.stderr.write(
          `forge skillgate: scanner failed, using heuristic: ${err?.message ?? err}\n`,
        );
    }
  }

  const findings = heuristicScan(content);
  const critical = findings.some((f) => f.sev === "critical");
  return { ok: !critical, critical, scanner: "heuristic", findings };
}
