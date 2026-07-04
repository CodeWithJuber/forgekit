// forge doctor — turn silent misconfiguration into an actionable pass/fail list
// (chezmoi-doctor pattern). Exits non-zero only on hard failures, not warnings.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BRAND } from "./brand.js";
import { canonical } from "./sync.js";
import { hashContent, extractHash } from "./emit/_shared.js";

const ok = (label, note = "") => ({ status: "ok", label, note });
const warn = (label, note = "") => ({ status: "warn", label, note });
const fail = (label, note = "") => ({ status: "fail", label, note });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function checkNode(out) {
  const major = Number(process.versions.node.split(".")[0]);
  out.push(
    major >= 18
      ? ok("node", `v${process.versions.node}`)
      : fail("node", `v${process.versions.node} < 18`),
  );
}

function checkBrandConsistency(out) {
  try {
    const plugin = readJson(join(BRAND.root, ".claude-plugin/plugin.json"));
    out.push(
      plugin.name === BRAND.pkg
        ? ok("brand↔plugin", `${plugin.name} v${plugin.version}`)
        : warn(
            "brand↔plugin",
            `plugin.json name "${plugin.name}" != brand pkg "${BRAND.pkg}"`,
          ),
    );
  } catch {
    out.push(warn("brand↔plugin", "plugin.json missing or invalid"));
  }
}

function checkLayers(out) {
  for (const layer of ["tools", "crew", "guards"]) {
    const dir = join(BRAND.root, "global", layer);
    if (!existsSync(dir)) {
      out.push(fail(layer, "missing"));
      continue;
    }
    out.push(ok(layer, `${readdirSync(dir).length} item(s)`));
  }
}

function checkInstall(out) {
  const forgeHome = join(homedir(), ".forge");
  out.push(
    existsSync(forgeHome)
      ? ok("~/.forge", "linked")
      : warn("~/.forge", "not installed — run install.sh or the plugin"),
  );
}

function checkDrift(out, targetRoot) {
  const agents = join(targetRoot, "AGENTS.md");
  if (!existsSync(agents)) {
    out.push(warn("AGENTS.md", "not emitted here — run `forge sync`"));
    return;
  }
  const current = hashContent(canonical(targetRoot));
  const onDisk = extractHash(readFileSync(agents, "utf8"));
  out.push(
    current === onDisk
      ? ok("AGENTS.md", "in sync")
      : warn("AGENTS.md", "stale — run `forge sync`"),
  );
}

export function doctor({ targetRoot = process.cwd() } = {}) {
  const results = [];
  checkNode(results);
  checkBrandConsistency(results);
  checkLayers(results);
  checkInstall(results);
  checkDrift(results, targetRoot);
  return { results, failed: results.filter((r) => r.status === "fail").length };
}
