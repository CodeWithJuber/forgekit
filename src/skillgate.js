// forge skill-gate — vet a skill / MCP config BEFORE it's installed. The external
// ToxicSkills study reported ~36% of skills flawed / 13.4% critical, with ~60% of the
// risk in the instruction (markdown) layer — so string prose matters as much as code.
// Prefer a real scanner (Snyk agent-scan) when present; otherwise a built-in heuristic
// catches the loud, KNOWN-shape cases. A clean pass is NOT a safety certification.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { shannonEntropy } from "./math.js";

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

// Obfuscation detector: a long base64-class blob whose Shannon entropy sits in
// encoded-payload territory. The RULES above are signatures for KNOWN attack shapes;
// entropy catches the unknown one hiding as an opaque blob in the instruction layer
// (nothing in a legitimate SKILL.md needs a 200-char undecodable string).
const BLOB_RE = /[A-Za-z0-9+/=]{200,}/g;
const BLOB_MIN_BITS = 4.5;

/** Pure: scan raw text for red flags. Returns findings [{sev, msg}]. */
export function heuristicScan(text) {
  const s = String(text);
  const findings = RULES.filter((r) => r.re.test(s)).map(({ sev, msg }) => ({
    sev,
    msg,
  }));
  const blobs = (s.match(BLOB_RE) || []).filter((b) => shannonEntropy(b) >= BLOB_MIN_BITS);
  if (blobs.length) {
    findings.push({
      sev: "high",
      msg: `${blobs.length} high-entropy encoded blob(s) — possible obfuscated payload`,
    });
  }
  return findings;
}

/**
 * Human-readable verdict. A scan with no critical/high signal is NOT a clearance to
 * install — the heuristic only catches KNOWN attack shapes, so the honest verdict is the
 * ABSENCE of a signature, never a certification of safety.
 * @param {{critical?: boolean, high?: boolean}} sev
 */
export function verdict({ critical, high }) {
  if (critical) return "BLOCKED — critical signature detected, do not install";
  if (high)
    return "High-severity signal(s) present — treat as unsafe; do not install without review";
  return "No critical signature detected — this is NOT a safety certification. Review the source, permissions, package provenance, and network behaviour before installing.";
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
        high: false,
        safe: false, // never certify safety from an absence of findings
        scanner: "snyk-agent-scan",
        findings: [],
        raw: out,
        verdict: verdict({ critical, high: false }),
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
  const high = findings.some((f) => f.sev === "high");
  // `ok` gates install/exit-code on the blocking (critical) tier only, unchanged. `safe`
  // is the stricter, honest reading: no critical AND no high — but even `safe` is only the
  // absence of a known signature, never a certification (see `verdict`).
  return {
    ok: !critical,
    critical,
    high,
    safe: !critical && !high,
    scanner: "heuristic",
    findings,
    verdict: verdict({ critical, high }),
  };
}
