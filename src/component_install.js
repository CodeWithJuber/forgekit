// Install bundled skills only. A digest covers references, scripts and any extra user files.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BRAND } from "./brand.js";
import { heuristicScan } from "./skillgate.js";

export const skillDirectories = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  gemini: ".gemini/skills",
  cursor: ".cursor/skills",
  copilot: ".github/skills",
  opencode: ".opencode/skills",
  portable: ".agents/skills",
};
const receipt = ".forgekit-skill.json";

function installationDirectory(root, path, remove) {
  let parent = realpathSync(root);
  for (const part of path.split("/")) {
    parent = join(parent, part);
    if (!remove) mkdirSync(parent, { recursive: true });
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (!stat && remove) return null;
    if (!stat?.isDirectory())
      throw new Error("Component directory must be a real project directory");
  }
  return parent;
}

const agentReceipt = /\n<!-- forgekit-agent-sha256:([a-f0-9]{64}) -->\n$/;

/** Install a packaged native crew description without adopting or replacing user files. */
export function installAgent(component, root, host, remove = false) {
  if (host !== "claude" || component.mode !== "crew")
    throw new Error(
      "Only packaged crew agents can be installed into Claude Code. Use agents run for a portable handoff.",
    );
  const parent = installationDirectory(root, ".claude/agents", remove);
  if (!parent) return { id: component.id, host, status: "absent" };
  const path = join(parent, `${component.id}.md`);
  const payload = readFileSync(join(BRAND.root, component.source), "utf8").replaceAll("\r\n", "\n");
  const checksum = (text) => createHash("sha256").update(text).digest("hex");
  const digest = checksum(payload);
  const present = lstatSync(path, { throwIfNoEntry: false });
  if (present) {
    if (!present.isFile() || present.nlink !== 1 || present.size > 128 * 1024)
      throw new Error("Destination belongs to the user");
    const prior = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    const marker = agentReceipt.exec(prior);
    if (!marker) throw new Error("Destination belongs to the user");
    if (marker[1] !== checksum(prior.slice(0, marker.index)))
      throw new Error("Installed agent contains user changes");
    if (remove) {
      rmSync(path);
      return { id: component.id, host, path, status: "removed" };
    }
    if (marker[1] !== digest)
      throw new Error(
        "An older ForgeKit agent is installed. Uninstall it before installing this version.",
      );
    return { id: component.id, host, path, status: "current" };
  }
  if (remove) return { id: component.id, host, path, status: "absent" };
  const area = mkdtempSync(join(parent, ".forge-agent-"));
  try {
    const staged = join(area, "agent.md");
    writeFileSync(staged, `${payload}\n<!-- forgekit-agent-sha256:${digest} -->\n`);
    linkSync(staged, path);
    return { id: component.id, host, path, status: "installed" };
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
}

function digestTree(root) {
  const hash = createHash("sha256");
  function visit(rel) {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (!rel && name === receipt) continue;
      const file = rel ? `${rel}/${name}` : name;
      const path = join(root, file);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        hash.update(`d\0${file}\0`);
        visit(file);
      } else if (stat.isFile()) {
        hash.update(`f\0${file}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      } else throw new Error("Skill contains a link or unsupported file");
    }
  }
  visit("");
  return hash.digest("hex");
}

function owned(path, id) {
  const marker = join(path, receipt);
  if (!lstatSync(path).isDirectory() || !lstatSync(marker, { throwIfNoEntry: false })?.isFile())
    throw new Error("Destination belongs to the user");
  const meta = JSON.parse(readFileSync(marker, "utf8"));
  if (meta.id !== id || meta.digest !== digestTree(path))
    throw new Error("Installed skill contains user changes");
  return meta;
}

export function installSkill(component, root, host, remove = false) {
  if (!Object.hasOwn(skillDirectories, host))
    throw new Error("Unsupported skill directory. Use --host portable for a local handoff");
  const parent = installationDirectory(root, skillDirectories[host], remove);
  if (!parent) return { id: component.id, host, status: "absent" };
  const dest = join(parent, component.id);
  const present = lstatSync(dest, { throwIfNoEntry: false });
  if (!present && remove) return { id: component.id, host, status: "absent" };
  const previous = present ? owned(dest, component.id) : null;
  const area = mkdtempSync(join(parent, ".forge-install-"));
  const old = join(area, "previous");
  let preserve = false;
  try {
    let digest;
    if (!remove) {
      const staged = join(area, "skill");
      const source = join(BRAND.root, dirname(component.source));
      const findings = heuristicScan(readFileSync(join(source, "SKILL.md"), "utf8"));
      if (findings.some((f) => f.sev === "critical"))
        throw new Error("Skill inspection rejected the bundled instructions");
      cpSync(source, staged, { recursive: true });
      if (host !== "claude") {
        const md = join(staged, "SKILL.md");
        const text = readFileSync(md, "utf8");
        writeFileSync(md, text.replace(/^(---\r?\n[\s\S]*?\r?\n)allowed-tools:[^\n]*\n/, "$1"));
      }
      digest = digestTree(staged);
      if (previous?.digest === digest)
        return { id: component.id, host, path: dest, status: "current" };
      writeFileSync(
        join(staged, receipt),
        JSON.stringify({ id: component.id, version: BRAND.version, digest }),
      );
    }
    if (previous) {
      renameSync(dest, old);
      owned(old, component.id);
    }
    if (!remove) renameSync(join(area, "skill"), dest);
    return { id: component.id, host, path: dest, status: remove ? "removed" : "installed" };
  } catch (error) {
    if (existsSync(old)) {
      preserve = true;
      if (lstatSync(dest, { throwIfNoEntry: false })) {
        throw new Error(`Concurrent skill change. Preserved previous files at ${old}`, {
          cause: error,
        });
      }
      renameSync(old, dest);
      preserve = false;
    }
    throw error;
  } finally {
    if (!preserve) rmSync(area, { recursive: true, force: true });
  }
}
