// Generate the expected host wiring with the shipping emitters in a disposable
// directory. Compare only owned entries in the actual checkout. Nothing supplied
// by the project is executed and unrelated editor settings are left out.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BRAND } from "./brand.js";
import { HOOK_TIMEOUT_S, planHooks } from "./emit/hooks.js";
import { emitMcp } from "./emit/mcp.js";
import { GENERIC_HOST, genericHarnessServer, parseHarnessHosts } from "./harness_hosts.js";
import { installedHarnessPython } from "./harness_python.js";
import { HOSTS, isForgeHookCommand, kimiPluginEnabled } from "./hosts.js";
import { managedMcpState } from "./integrations.js";
import { readForgeConfig } from "./repo_config.js";

function read(root, path) {
  const realRoot = realpathSync.native(root);
  const file = join(realRoot, path),
    rel = relative(realRoot, realpathSync.native(file));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("Configuration resolves outside this checkout");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("Expected a regular configuration file under 1 MiB");
  return readFileSync(file, "utf8");
}
function hooksMatch(actual, expected) {
  if (expected.version !== undefined && actual?.version !== expected.version) return false;
  if (!actual?.hooks || typeof actual.hooks !== "object" || Array.isArray(actual.hooks))
    return false;
  const managed = {};
  for (const [event, entries] of Object.entries(actual.hooks)) {
    if (!Array.isArray(entries)) return false;
    const owned = entries.filter(
      (e) =>
        e &&
        [
          e.command,
          e.bash,
          e.powershell,
          e.windows,
          ...(Array.isArray(e.hooks) ? e.hooks.map((h) => h?.command) : []),
        ].some(isForgeHookCommand),
    );
    if (owned.length) managed[event] = owned;
  }
  return isDeepStrictEqual(managed, expected.hooks);
}
function parseToml(root, text) {
  // Real TOML parsing also catches duplicate tables and setting overrides
  // outside ForgeKit's markers. Python never imports anything from the checkout.
  const result = spawnSync(
    installedHarnessPython(root),
    [
      "-I",
      "-c",
      "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read()).get('mcp_servers',{})))",
    ],
    {
      input: text,
      encoding: "utf8",
      cwd: tmpdir(),
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.status !== 0) throw new Error("Could not parse Codex TOML (requires Python 3.11+)");
  return JSON.parse(result.stdout);
}
function mcpMatches(root, path, actual, expected) {
  if (path.endsWith(".yaml")) return actual.replaceAll("\r\n", "\n") === expected; // One owned file per server
  let seen, wanted;
  if (path.endsWith(".toml")) {
    seen = parseToml(root, actual);
    wanted = parseToml(root, expected);
    for (const name of Object.keys(wanted)) {
      if (
        !actual.split(/\r?\n/).includes(`# forge:managed:${name} begin`) ||
        !actual.split(/\r?\n/).includes(`# forge:managed:${name} end`)
      )
        return false;
    }
  } else {
    const project = JSON.parse(actual),
      generated = JSON.parse(expected);
    const bucket = (doc) =>
      doc?.mcpServers ?? doc?.servers ?? doc?.context_servers ?? doc?.mcp?.servers;
    // Choose the generated host's exact bucket. An ignored key with the correct
    // name/value cannot compensate for a deleted real registration.
    const path = Object.keys(generated)[0];
    wanted = bucket(generated);
    seen = path === "mcp" ? project?.mcp?.servers : project?.[path];
  }
  return (
    !!seen && Object.entries(wanted).every(([name, def]) => isDeepStrictEqual(seen[name], def))
  );
}
function kimiManifestMatches() {
  const manifest = JSON.parse(read(BRAND.root, "kimi.plugin.json"));
  if (manifest.name !== BRAND.pkg || !Array.isArray(manifest.hooks)) return false;
  const expected = Object.entries(HOSTS.kimi.events).map(([event, e]) => ({
    event,
    command: `node ./src/cli.js hooks run kimi ${event}`,
    timeout: HOOK_TIMEOUT_S[e.as],
  }));
  return (
    expected.length === manifest.hooks.length &&
    expected.every((row) => manifest.hooks.some((h) => isDeepStrictEqual(h, row)))
  );
}
/** Explicit hosts define the CI expectation even if a repo edit removed its hook selection. */
export function checkHarnessDrift(root, hosts) {
  const cfg = readForgeConfig(root),
    requested = hosts ?? cfg.tools;
  if (cfg.corrupt) throw new Error("Invalid project host configuration");
  if (!requested || (Array.isArray(requested) && !requested.length))
    throw new Error("Choose the expected hosts for the drift check");
  const chosen = parseHarnessHosts(requested);
  const checks = [];
  function check(host, component, path, run) {
    try {
      if (!run()) throw new Error("Generated binding differs");
      checks.push({ host, component, path, status: "pass" });
    } catch (error) {
      checks.push({
        host,
        component,
        path,
        status: "drift",
        reason:
          error.code === "ENOENT" ? "Missing managed file" : String(error.message).slice(0, 250),
      });
    }
  }
  function note(host, component, status, reason) {
    checks.push({ host, component, status, reason });
  }
  const state = managedMcpState(root),
    tmp = mkdtempSync(join(tmpdir(), "forge-harness-drift-"));
  try {
    if (state.warning) note("project", "mcp", "manual", state.warning);
    for (const tool of chosen) {
      if (tool === GENERIC_HOST) {
        checks.push({
          host: tool,
          component: "stdio MCP",
          status: "manual",
          reason:
            "Register forge-cortex in your client and call forge_harness_run or forge_harness_status. Native client tools use its own permissions.",
          mcpServers: { "forge-cortex": genericHarnessServer(root) },
        });
        continue;
      }
      const host = Object.keys(HOSTS).find((k) => HOSTS[k].tool === tool) ?? tool;
      const target = HOSTS[host];
      if (host === "kimi") {
        check(host, "packaged hooks", "kimi.plugin.json", kimiManifestMatches);
        check(host, "project selection", ".forge/forge.config.json", () => kimiPluginEnabled(cfg));
        note(
          host,
          "user plugin",
          "manual",
          "Installation, trust and reload belong to this Kimi profile",
        );
      } else if (target?.file || target?.via) {
        const id = target.via ?? host,
          file = HOSTS[id].file;
        const plan = planHooks(null, id, {
          enable: true,
          bootstrap: cfg.hooks?.bootstrap === true,
        });
        check(host, "project hooks", file, () =>
          hooksMatch(JSON.parse(read(root, file)), JSON.parse(plan.next)),
        );
      } else
        note(host, "lifecycle hooks", "unsupported", "No managed lifecycle hooks for this host");
      const rows = emitMcp({ targetRoot: tmp, tools: [tool], servers: state.servers });
      if (!rows.length)
        note(host, "mcp", "unsupported", "No project MCP registration for this host");
      for (const row of rows) {
        if (row.action === "skipped") {
          note(host, "mcp", "unsupported", row.note);
          continue;
        }
        check(host, "mcp", row.target, () =>
          mcpMatches(root, row.target, read(root, row.target), read(tmp, row.target)),
        );
      }
      if (tool === "openclaw")
        note(
          host,
          "global registry",
          "manual",
          "Register the generated OpenClaw fragment in the client",
        );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const failures = checks.filter((c) => c.status === "drift");
  return { ok: !failures.length, checks, failures };
}
