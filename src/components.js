// Standalone commands discover the same packaged playbooks and guard manifest the host plugins use.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { rolePrompts } from "./development_prompt_library.js";
import { validateHarnessArgs } from "./harness_policy.js";
import { guardChain, hookId, interpret, loadManifest, runGuards } from "./hosts.js";
import { redactSecrets } from "./secrets.js";

export const COMPONENT_CATALOG_VERSION = 1;

const empty = { type: "object", properties: {}, additionalProperties: false };
const targetSchema = {
  ...empty,
  required: ["target"],
  properties: { target: { type: "string", minLength: 1, maxLength: 2048 } },
};

// An executable binding is package-owned data. Text in SKILL.md never becomes an executable.
const bindings = {
  "forge-impact": {
    schema: targetSchema,
    argv: ({ target }) => {
      if (target.startsWith("-") || !target.trim()) throw new Error("Expected a symbol or file");
      return ["impact", target];
    },
  },
  "forge-verify": { schema: empty, argv: () => ["verify"] },
  "forge-ledger": { schema: empty, argv: () => ["ledger", "stats"] },
};

/** Read the simple scalar and folded fields used by the shipped Markdown manifests. */
function markdown(source) {
  const text = readFileSync(join(BRAND.root, source), "utf8").replace(/\r\n/g, "\n");
  const end = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || end < 0) throw new Error(`Invalid packaged manifest: ${source}`);
  const fields = {};
  const lines = text.slice(4, end).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    let value = field[2];
    if (/^[>|]-?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(" ");
    }
    fields[field[1]] = value;
  }
  if (!fields.name || !fields.description)
    throw new Error(`Incomplete packaged manifest: ${source}`);
  return {
    id: fields.name,
    description: fields.description,
    source,
    instructions: text.slice(end + 5).trim(),
  };
}

function documents(dir, skill) {
  const entries = readdirSync(join(BRAND.root, dir), { withFileTypes: true });
  return entries
    .filter((e) => (skill ? e.isDirectory() : e.isFile() && e.name.endsWith(".md")))
    .map((e) => markdown(`${dir}/${e.name}${skill ? "/SKILL.md" : ""}`));
}

function hookEntries() {
  const hooks = new Map();
  for (const [event, groups] of Object.entries(loadManifest())) {
    for (const group of groups)
      for (const command of group.hooks) {
        const id = hookId(command.args);
        const entry = hooks.get(id) ?? {
          id,
          event,
          mode: "hook",
          source: "hooks/hooks.json",
          matchers: [],
        };
        if (entry.event !== event) throw new Error(`Ambiguous hook id ${id}`);
        entry.matchers.push(group.matcher ?? "*");
        hooks.set(id, entry);
      }
  }
  return [...hooks.values()];
}

export function componentCatalog(kind) {
  let entries;
  if (kind === "hooks") entries = hookEntries();
  else if (kind === "agents")
    entries = [
      ...documents("global/crew", false).map((d) => ({ ...d, mode: "crew" })),
      ...rolePrompts.map((r) => ({
        id: r.id,
        description: r.title,
        mode: "role",
        source: "src/development_prompt_library.js",
        instructions: `${r.prompt}\n\n${r.proof}`,
      })),
    ];
  else if (kind === "skills")
    entries = [...documents("skills", true), ...documents("global/tools", true)].map((d) => {
      const bound = Object.hasOwn(bindings, d.id);
      return {
        ...d,
        mode: bound ? "command" : "instructions",
        ...(bound ? { binding: d.id, inputSchema: bindings[d.id].schema } : {}),
      };
    });
  else throw new Error(`Unknown component collection: ${kind}`);
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export function runSkillBinding(component, input, root) {
  const binding = bindings[component.binding];
  validateHarnessArgs(binding.schema, input);
  const result = spawnSync(
    process.execPath,
    [join(BRAND.root, "src/cli.js"), ...binding.argv(input), "--json"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (!result.stdout.trim())
    throw new Error(
      redactSecrets(result.stderr).slice(0, 2000) || "Component produced no JSON result",
    );
  return {
    id: component.id,
    mode: "command",
    ok: result.status === 0,
    result: JSON.parse(result.stdout),
  };
}

export async function invokeComponentHook(component, raw, root) {
  if (raw.hook_event_name !== component.event)
    throw new Error(`Expected hook_event_name ${component.event}`);
  if (
    ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(component.event) &&
    (typeof raw.tool_name !== "string" ||
      !raw.tool_name.trim() ||
      !raw.tool_input ||
      typeof raw.tool_input !== "object" ||
      Array.isArray(raw.tool_input))
  )
    throw new Error("Tool events require tool_name and an object tool_input");
  if (component.event === "UserPromptSubmit" && typeof raw.prompt !== "string")
    throw new Error("Prompt events require a prompt string");
  const payload = { ...raw, cwd: root };
  const steps = guardChain(payload).filter((s) => hookId(s.args) === component.id);
  if (steps.length !== 1) throw new Error("Event does not select this hook exactly once");
  const [result] = await runGuards(steps, payload);
  const verdict = interpret(component.event, result);
  const completed = result.status === 0 || result.status === 2;
  return {
    id: component.id,
    mode: "hook",
    ok: completed && !verdict.block && verdict.decision === "allow",
    status: result.status,
    ...verdict,
  };
}
