#!/usr/bin/env node
// PreToolUse guard — dep-gate: vet a package BEFORE it lands, on the two tool calls that bring
// one in. A Bash install command (`npm install x`, `pip install -r …`, `go get …`,
// `composer require …`, `npx x` …) and an Edit / Write / MultiEdit that ADDS a dependency to a
// manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, a `.csproj` …).
// An agent that invents a package name is the slopsquatting attack surface; these are the
// moments the name can still be checked against its registry. The rule set lives in
// src/depgate.js and src/depgate_sources.js, shared with `forge vet` and the `dep_check` MCP
// tool — this file only reads the payload and speaks the hook protocol.
//
// FAIL OPEN — the opposite of protect-paths, on purpose. This guard does network I/O, and an
// install must keep working offline, behind a proxy, with a registry down. Only a first-hand
// finding blocks (the name is not on its own registry, or OSV lists it as malicious). An
// internal error, an unparseable payload, a missing rule set, a timeout: exit 0, silently.
//
// Cost: every matched tool call pays for reading stdin and one regex. Only a command that
// names a package manager, or an edit to a dependency manifest, loads the rule set — and only
// a new package reaches the network.

/** Does the command so much as mention a package manager? Cheap pre-filter, no parsing. */
export const MENTIONS_PACKAGE_MANAGER =
  /(?:^|[^\w.-])(?:npm|pnpm|yarn|bunx?|npx|pnpx|pip[\d.]*|uvx?|poetry|pdm|pipx|cargo|go|gem|bundler?|composer(?:\.phar)?|dotnet|nuget|dart|flutter|py(?:thon[\d.]*)?)(?:\.(?:exe|cmd|bat))?(?![\w-])/i;

/** Is this path a dependency manifest? Mirrors MANIFESTS in src/depgate_sources.js (a test
 *  holds the two together) so an ordinary edit never loads the rule set. */
export const MANIFEST_FILE =
  /(?:^|[\\/])(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|gems\.rb|composer\.json|pubspec\.ya?ml|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|libs\.versions\.toml|Directory\.Packages\.props|packages\.config|[\w.-]*(?:requirements|constraints)[\w.-]*\.(?:txt|in)|[^\\/]+\.(?:cs|fs|vb)proj)$/i;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** The whole guard may take this long before it gives up and lets the call through. */
const OVERALL_BUDGET_MS = 8000;

/**
 * The hook response for a decision. Pure — `exit` is the process exit code.
 * @param {{decision: string, reason: string}} d
 * @returns {{stdout: string, stderr: string, exit: number}}
 */
export function hookResponse(d) {
  const hookEventName = "PreToolUse";
  if (d.decision === "deny") {
    // Structured decision for current Claude Code; exit 2 + stderr is the version-agnostic
    // fallback older versions rely on.
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "deny",
          permissionDecisionReason: d.reason,
        },
      }),
      stderr: `BLOCKED by dep-gate guard: ${d.reason}\n`,
      exit: 2,
    };
  }
  if (d.decision === "ask") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "ask",
          permissionDecisionReason: d.reason,
        },
      }),
      stderr: "",
      exit: 0,
    };
  }
  if (d.decision === "note") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: d.reason },
      }),
      stderr: "",
      exit: 0,
    };
  }
  return { stdout: "", stderr: "", exit: 0 };
}

/**
 * Which decision function (if any) this payload needs. Pure — no I/O, so the routing is
 * testable without loading the rule set.
 * @param {any} data the PreToolUse hook payload
 * @returns {"command"|"edit"|null}
 */
export function route(data) {
  if (data?.tool_name === "Bash")
    return MENTIONS_PACKAGE_MANAGER.test(String(data.tool_input?.command ?? "")) ? "command" : null;
  if (EDIT_TOOLS.has(data?.tool_name))
    return MANIFEST_FILE.test(String(data.tool_input?.file_path ?? "")) ? "edit" : null;
  return null;
}

async function main() {
  if (process.env.FORGE_DEPGATE === "0") return 0;
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const data = raw.trim() ? JSON.parse(raw) : {};
  const kind = route(data);
  if (!kind) return 0;
  const gate = await import("../../src/depgate.js");
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const decision =
    kind === "command"
      ? await gate.depgateDecision({ command: String(data.tool_input.command), cwd })
      : await gate.depgateEditDecision({
          toolName: data.tool_name,
          toolInput: data.tool_input,
          cwd,
        });
  const out = hookResponse(decision);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  return out.exit;
}

// Run only as the hook entrypoint; importing it (tests) must evaluate no payload.
if (process.argv[1] && /dep-gate\.mjs$/i.test(process.argv[1])) {
  // A hung registry must not hang the tool call: past the budget, let it through.
  setTimeout(() => process.exit(0), OVERALL_BUDGET_MS).unref();
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
