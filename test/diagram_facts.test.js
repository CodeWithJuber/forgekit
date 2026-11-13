// Diagram facts (src/diagram_facts.js): labels in docs/diagrams/src bound to the code that
// decides them — the hook chain, the tool count, thresholds. The repo's own diagrams must
// agree with its code, and a rewrite touches only the bound field.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import {
  DIAGRAM_SOURCE_DIR,
  FACTS,
  factField,
  hookChain,
  inWords,
  renderDiagramFacts,
} from "../src/diagram_facts.js";
import { NATIVE_CONFIG_TOOLS } from "../src/sync.js";

const hook = (event, script, mode) => ({
  type: "command",
  command: "node",
  args: ["plugin/global/guards/run.mjs", "--event", event, `g/${script}`].concat(
    mode ? [mode] : [],
  ),
});

test("hookChain: guards in manifest order, each once, cortex steps last", () => {
  const manifest = {
    hooks: {
      PostToolUse: [
        { matcher: "Edit", hooks: [hook("PostToolUse", "format-on-edit.sh")] },
        { matcher: "Edit", hooks: [hook("PostToolUse", "cortex.sh", "capture")] },
        { matcher: "Bash", hooks: [hook("PostToolUse", "secret-redact.sh")] },
        { matcher: "Bash", hooks: [hook("PostToolUse", "cortex.sh", "capture")] },
      ],
      PreToolUse: [
        { hooks: [hook("PreToolUse", "protect-paths.sh"), hook("PreToolUse", "dep-gate.sh")] },
        { hooks: [hook("PreToolUse", "cortex.sh", "pre-edit")] },
        { hooks: [hook("PreToolUse", "protect-paths.sh")] },
        { hooks: [hook("PreToolUse", "cortex.sh", "brand-new-mode")] },
      ],
    },
  };
  assert.deepEqual(hookChain(manifest, "PostToolUse"), [
    "format-on-edit",
    "secret-redact",
    "cortex capture",
  ]);
  assert.deepEqual(hookChain(manifest, "PreToolUse"), [
    "protect-paths",
    "dep-gate",
    "cortex",
    "cortex brand-new-mode",
  ]);
  assert.deepEqual(hookChain(manifest, "Stop"), []);
  assert.deepEqual(hookChain(null, "Stop"), []);
});

test("hookChain: the shipped manifest's PreToolUse chain includes dep-gate", () => {
  const manifest = JSON.parse(readFileSync(join(BRAND.root, "hooks/hooks.json"), "utf8"));
  assert.ok(hookChain(manifest, "PreToolUse").includes("dep-gate"));
});

test("factField: reads and rewrites one field on the marked line, nothing else", () => {
  const text = [
    "{",
    '  "messages": [',
    '    { "id": "pre-tool", "from": "a", "label": "old \\"quoted\\" · text", "variant": "security" },',
    '    { "id": "pre-tool-2", "label": "untouched" }',
    "  ],",
    '  "cards": [{ "dot": "rose", "title": "Kinds", "items": ["a · b", "second"] }]',
    "}",
    "",
  ].join("\n");
  const read = factField(text, { at: '"id": "pre-tool"', field: "label" });
  assert.ok(read.ok);
  assert.equal(read.ok && read.current, 'old "quoted" · text');
  const w = factField(text, { at: '"id": "pre-tool"', field: "label" }, "new · label");
  assert.ok(w.ok);
  const out = w.ok ? w.text : "";
  assert.equal(
    out,
    text.replace('"label": "old \\"quoted\\" · text"', '"label": "new · label"'),
    "only the bound field changes",
  );
  const item = factField(text, { at: '"title": "Kinds"', field: "items[0]" }, "a · b · c");
  assert.ok(item.ok && item.text.includes('"items": ["a · b · c", "second"]'));
  // `"label"` must not match inside `"sublabel"`.
  const sub = factField('{ "id": "n", "sublabel": "s" }', { at: '"id": "n"', field: "label" });
  assert.equal(sub.ok, false);
  // The marker must name exactly one line.
  assert.equal(factField(text, { at: '"id": "nope"', field: "label" }).ok, false);
  assert.equal(
    factField(`${text}${text}`, { at: '"title": "Kinds"', field: "items[0]" }).ok,
    false,
  );
});

test("renderDiagramFacts: the repo's diagrams say what its code does", async () => {
  const r = await renderDiagramFacts(BRAND.root, { write: false });
  assert.deepEqual(r.errors, [], "every fact's marker and field exist");
  assert.deepEqual(
    r.drift.map((d) => `${d.file} ${d.at} ${d.field}: ${d.current} → ${d.expected}`),
    [],
    "run `forge docs render` then `node scripts/diagrams.mjs build --stale`",
  );
  assert.deepEqual(r.changed, []);
});

test("renderDiagramFacts: rewrites a stale fact in place and names the diagram", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-diagram-facts-"));
  try {
    const fact = FACTS.find((f) => f.diagram === "system.architecture");
    assert.ok(fact);
    const rel = `${DIAGRAM_SOURCE_DIR}/${fact.diagram}.json`;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    const stale =
      '{\n  "components": [\n    { "id": "native-configs", "type": "external", "label": "Native configs for ten tools", "pos": [1, 2] }\n  ]\n}\n';
    writeFileSync(join(root, rel), stale);
    const dry = await renderDiagramFacts(root);
    assert.equal(dry.drift.length, 1);
    assert.equal(readFileSync(join(root, rel), "utf8"), stale, "a dry run writes nothing");
    const r = await renderDiagramFacts(root, { write: true });
    assert.deepEqual(r.changed, ["system"]);
    const expected = `Native configs for ${inWords(NATIVE_CONFIG_TOOLS.length)} tools`;
    assert.equal(
      readFileSync(join(root, rel), "utf8"),
      stale.replace("Native configs for ten tools", expected),
    );
    const again = await renderDiagramFacts(root, { write: true });
    assert.deepEqual([again.drift, again.changed], [[], []], "a second render is a no-op");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NATIVE_CONFIG_TOOLS: one name per tool, Claude Code counted once", () => {
  assert.equal(new Set(NATIVE_CONFIG_TOOLS).size, NATIVE_CONFIG_TOOLS.length);
  assert.ok(NATIVE_CONFIG_TOOLS.includes("Claude Code"));
  assert.ok(NATIVE_CONFIG_TOOLS.includes("Codex"));
  assert.equal(inWords(11), "eleven");
  assert.equal(inWords(42), "42");
});
