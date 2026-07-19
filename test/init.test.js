import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import {
  catalog,
  ensureLedgerGitattributes,
  guardKey,
  init,
  LEGACY_PROFILES,
  mergeSettings,
  PROFILES,
  removeForgeSettings,
  shellQuote,
  validateProfile,
} from "../src/init.js";
import { GITATTRIBUTES_RULE } from "../src/ledger_store.js";

/** The effective shell command a hook/statusLine entry runs, across BOTH forms: exec form
 *  (`command`+`args`, ME-23) joins the args onto the command; a legacy shell string is returned
 *  as-is. Tests assert on this so they are form-agnostic. */
const effectiveCmd = (h) => (Array.isArray(h.args) ? [h.command, ...h.args].join(" ") : h.command);

test("init emits the shared config for a fresh repo in one call", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-init-"));
  init({ targetRoot: root });
  assert.ok(existsSync(join(root, "AGENTS.md")), "AGENTS.md");
  assert.ok(existsSync(join(root, "CLAUDE.md")), "CLAUDE.md");
  assert.ok(existsSync(join(root, ".aider.conf.yml")), ".aider.conf.yml");
});

test("mergeSettings deduplicates plugin-style and settings-style hooks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-hooks-"));
  const settingsPath = join(tmp, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: '"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh prompt',
              },
              {
                type: "command",
                command: '"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh preflight',
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: '"${CLAUDE_PLUGIN_ROOT}"/global/guards/lean-guard.sh',
              },
            ],
          },
        ],
      },
    }),
  );
  mergeSettings({ settingsPath });
  const result = JSON.parse(readFileSync(settingsPath, "utf8"));
  const promptHooks = result.hooks.UserPromptSubmit.flatMap((e) =>
    (e.hooks || []).map(effectiveCmd),
  );
  const cortexPromptCount = promptHooks.filter((c) => c.includes("cortex.sh prompt")).length;
  assert.equal(
    cortexPromptCount,
    1,
    "cortex.sh prompt must not duplicate across plugin + settings paths",
  );
  const stopHooks = result.hooks.Stop.flatMap((e) => (e.hooks || []).map(effectiveCmd));
  const leanCount = stopHooks.filter((c) => c.includes("lean-guard.sh")).length;
  assert.equal(leanCount, 1, "lean-guard.sh must not duplicate");
});

test("mergeSettings refuses to overwrite a present-but-unparseable settings file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-corrupt-"));
  const settingsPath = join(tmp, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const original = "{ this is not valid json ";
  writeFileSync(settingsPath, original);
  const result = mergeSettings({ settingsPath });
  assert.equal(result.action, "error", "corrupt file must not be silently overwritten");
  assert.equal(readFileSync(settingsPath, "utf8"), original, "original bytes preserved");
});

// ME-12: a settings file that is valid JSON but NOT an object ([] / "x" / 42 / null) is
// corrupt, not empty settings — it must be refused and its bytes preserved, exactly like
// unparseable JSON. Otherwise the merge would silently replace the user's real file.
for (const body of ["[]", '"x"', "42", "null"]) {
  test(`ME-12: non-object settings JSON (${body}) is treated as corrupt, bytes preserved`, () => {
    const tmp = mkdtempSync(join(tmpdir(), "forge-settings-nonobj-"));
    const settingsPath = join(tmp, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, body);
    const result = mergeSettings({ settingsPath });
    assert.equal(result.action, "error", "non-object settings must not be overwritten");
    assert.equal(readFileSync(settingsPath, "utf8"), body, "original bytes preserved");
  });
}

// ME-21: presence of the ledger merge rule is decided by parsing the EXACT active
// attribute line, not a substring — a comment that merely mentions the path must not
// suppress the real rule.
test("ME-21: a .gitattributes with only a COMMENT mentioning the ledger still gets the real rule", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-ga-comment-"));
  writeFileSync(join(root, ".gitattributes"), "# note: .forge/ledger/ logs use union merge\n");
  const r = ensureLedgerGitattributes(root);
  assert.equal(r.written, true, "the real rule was added despite the comment");
  const text = readFileSync(join(root, ".gitattributes"), "utf8");
  assert.match(text, /\.forge\/ledger\/\*\/\*\.log merge=union/, "active rule present");
});

test("ME-21: an existing REAL rule is not duplicated", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-ga-real-"));
  writeFileSync(join(root, ".gitattributes"), `${GITATTRIBUTES_RULE}\n`);
  const r = ensureLedgerGitattributes(root);
  assert.equal(r.written, false, "already-present rule is a no-op");
  const text = readFileSync(join(root, ".gitattributes"), "utf8");
  const occurrences = text.split(".forge/ledger/*/*.log merge=union").length - 1;
  assert.equal(occurrences, 1, "rule appears exactly once");
});

test("ME-21: a real rule alongside an unrelated comment still counts as present", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-ga-mixed-"));
  writeFileSync(
    join(root, ".gitattributes"),
    "# ledger config below\n.forge/ledger/*/*.log merge=union\n",
  );
  assert.equal(
    ensureLedgerGitattributes(root).written,
    false,
    "present rule detected, not re-added",
  );
});

// ME-22: the GLOBAL-settings disclosure must be emitted BEFORE the merge mutates the file,
// never after. mergeSettings fires onNotice with the target path prior to any write.
test("ME-22: mergeSettings fires the disclosure BEFORE it mutates the global file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-me22-"));
  const settingsPath = join(tmp, ".claude", "settings.json");
  let noticedPath = null;
  let fileExistedAtNotice = null;
  const r = mergeSettings({
    settingsPath,
    onNotice: (p) => {
      noticedPath = p;
      fileExistedAtNotice = existsSync(settingsPath);
    },
  });
  assert.equal(noticedPath, settingsPath, "notice carries the resolved target path");
  assert.equal(fileExistedAtNotice, false, "notice fired before the file was created");
  assert.ok(existsSync(settingsPath), "the merge then created the file");
  assert.ok(r.action === "created" || r.action === "merged");
});

test("ME-22: no disclosure fires when the merge is skipped (--no-settings)", () => {
  let fired = false;
  const r = mergeSettings({
    noSettings: true,
    onNotice: () => {
      fired = true;
    },
  });
  assert.equal(r.action, "skipped");
  assert.equal(fired, false, "nothing to disclose when nothing is merged");
});

test("mergeSettings backs up an existing valid file and resolves guard paths absolutely", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-backup-"));
  const settingsPath = join(tmp, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ model: "sonnet" }));
  const result = mergeSettings({ settingsPath });
  assert.equal(result.action, "merged");
  assert.ok(result.backup && existsSync(result.backup), "a timestamped backup was written");
  const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
  const cmds = (merged.hooks?.UserPromptSubmit || []).flatMap((e) =>
    (e.hooks || []).map(effectiveCmd),
  );
  assert.ok(
    cmds.some((c) => c.includes("/global/guards/") && !c.includes("~/.forge/")),
    "hook commands resolve to the installed package, not the unmaterialized ~/.forge",
  );
});

test("init({settingsOnly}) merges hooks + permissions but never emits repo config", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-settingsonly-"));
  const settingsPath = join(root, ".claude", "settings.json");
  const r = init({ targetRoot: root, settingsOnly: true, settingsPath });
  // Settings were written and marked forge-managed.
  assert.ok(existsSync(settingsPath), "settings.json written");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings._forge, "forge-managed", "marker stamped");
  assert.ok(settings.hooks, "hooks merged");
  assert.ok(settings.permissions, "permissions merged");
  assert.equal(r.settings.path, settingsPath, "reports the merged path");
  // But NO repo emit: none of the per-tool config files exist.
  assert.ok(!existsSync(join(root, "AGENTS.md")), "no AGENTS.md emitted");
  assert.ok(!existsSync(join(root, "CLAUDE.md")), "no CLAUDE.md emitted");
  assert.ok(!existsSync(join(root, ".aider.conf.yml")), "no .aider.conf.yml emitted");
  assert.ok(!existsSync(join(root, ".gitattributes")), "no gitattributes emitted");
});

test("init({settingsOnly}) is idempotent — a second run reports unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-settingsonly-idem-"));
  const settingsPath = join(root, ".claude", "settings.json");
  const first = init({ targetRoot: root, settingsOnly: true, settingsPath });
  assert.equal(first.settings.action, "merged");
  const second = init({ targetRoot: root, settingsOnly: true, settingsPath });
  assert.equal(second.settings.action, "unchanged", "re-run never clobbers");
});

test("PROFILES lists only real profiles; validateProfile maps legacy names (RA-14)", () => {
  assert.deepEqual(PROFILES, ["minimal", "standard"]);
  assert.deepEqual(validateProfile("minimal"), {
    ok: true,
    profile: "minimal",
  });
  assert.deepEqual(validateProfile("standard"), {
    ok: true,
    profile: "standard",
  });
  for (const legacy of Object.keys(LEGACY_PROFILES)) {
    assert.deepEqual(validateProfile(legacy), {
      ok: true,
      profile: "standard",
      deprecated: legacy,
    });
  }
  const bogus = validateProfile("bogus");
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /unknown profile: bogus/);
});

test("init --profile with a legacy name stores the mapped profile and reports the deprecation", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-profile-"));
  const r = init({ targetRoot: root, profile: "web-app", noSettings: true });
  assert.equal(r.profile.profile, "standard");
  assert.equal(r.profile.deprecated, "web-app");
  const cfg = JSON.parse(readFileSync(join(root, ".forge/forge.config.json"), "utf8"));
  assert.equal(cfg.profile, "standard", "the mapped profile is stored, never the legacy name");
});

test("init --profile refuses to overwrite a corrupt forge.config.json (RA-15)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-profile-corrupt-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  const file = join(root, ".forge/forge.config.json");
  const original = "{ nope";
  writeFileSync(file, original);
  const r = init({ targetRoot: root, profile: "minimal", noSettings: true });
  assert.match(r.profile.error, /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), original, "corrupt bytes preserved");
});

test("catalog indexes tools (with a why), crew, and guards", () => {
  const c = catalog();
  assert.ok(
    c.tools.some((t) => t.name === "lean"),
    "has lean tool",
  );
  assert.ok(
    c.tools.some((t) => t.name === "atlas"),
    "has atlas tool",
  );
  assert.ok(
    c.tools.every((t) => t.why.length > 0),
    "every tool has a one-line why",
  );
  assert.ok(c.crew.includes("scout"), "has scout crew");
  assert.ok(c.guards.includes("cost-budget"), "has cost-budget guard");
  assert.ok(!c.guards.includes("_guardlib"), "excludes the sourced lib");
});

// ---------------------------------------------------------------------------
// ME-23 — exec-form hooks (command + args, no shell quoting) + legacy dedup
// ---------------------------------------------------------------------------

test("shellQuote single-quotes paths (spaces safe) and escapes embedded quotes", () => {
  // Retained for the defensive legacy shell-string path; exec form no longer needs it.
  assert.equal(shellQuote("/a b/guards/x.sh"), "'/a b/guards/x.sh'");
  assert.equal(shellQuote("/o'brien/x.sh"), "'/o'\\''brien/x.sh'");
});

test("guardKey derives ONE identity from legacy shell-string AND exec-form spellings (ME-23)", () => {
  const base = join(BRAND.root, "global");
  const key = "cortex.sh prompt";
  // Legacy shell-string spellings (quoted, unquoted, tilde, plugin-root).
  assert.equal(guardKey(`bash ~/.forge/guards/cortex.sh prompt`), key);
  assert.equal(guardKey(`bash '${base}/guards/cortex.sh' prompt`), key);
  assert.equal(guardKey(`bash ${base}/guards/cortex.sh prompt`), key);
  assert.equal(guardKey(`bash '/a b/with space/guards/cortex.sh' prompt`), key);
  assert.equal(guardKey('"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh prompt'), key);
  // Exec-form objects with the same basename+args reduce to the SAME key.
  assert.equal(
    guardKey({
      command: "bash",
      args: ["~/.forge/guards/cortex.sh", "prompt"],
    }),
    key,
  );
  assert.equal(guardKey({ command: "bash", args: [`${base}/guards/cortex.sh`, "prompt"] }), key);
  assert.equal(
    guardKey({
      command: "bash",
      args: ["/a b/with space/guards/cortex.sh", "prompt"],
    }),
    key,
  );
  assert.equal(
    guardKey({
      command: "bash",
      args: ["${CLAUDE_PLUGIN_ROOT}/global/guards/cortex.sh", "prompt"],
    }),
    key,
  );
  // A hook object carrying only a legacy `.command` string is accepted too.
  assert.equal(guardKey({ command: `bash ${base}/guards/cortex.sh prompt` }), key);
  // Args are part of identity: `cortex.sh prompt` and `cortex.sh stop` differ.
  assert.notEqual(guardKey({ command: "bash", args: ["~/.forge/guards/cortex.sh", "stop"] }), key);
});

test("mergeSettings writes hooks in EXEC form — path in args[], resolved, UNQUOTED (ME-23)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-execform-"));
  const settingsPath = join(tmp, "settings.json");
  mergeSettings({ settingsPath });
  const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
  const base = join(BRAND.root, "global");
  const hooks = Object.values(merged.hooks)
    .flat()
    .flatMap((e) => e.hooks || []);
  assert.ok(hooks.length > 0, "hooks merged");
  for (const h of hooks) {
    assert.equal(h.command, "bash", "command is the bare interpreter, no path baked in");
    assert.ok(Array.isArray(h.args) && h.args.length > 0, "path lives in args[]");
    const path = h.args[0];
    // Resolved to the real install base, NOT the unmaterialized ~/.forge, and — the whole point
    // of exec form — carrying NO surrounding quote characters (spaces would just work).
    assert.ok(path.startsWith(`${base}/`), `args path resolved to the install base: ${path}`);
    assert.ok(!path.includes("~/.forge/"), "no unresolved ~/.forge in args path");
    assert.doesNotMatch(path, /['"]/, `exec-form args path is unquoted: ${path}`);
  }
  // The statusLine migrated to exec form too.
  assert.equal(merged.statusLine.command, "bash");
  assert.equal(merged.statusLine.args[0], join(base, "statusline.sh"));
  assert.doesNotMatch(merged.statusLine.args[0], /['"]/, "statusline args path unquoted");
});

test("resolveManagedPaths: a base path WITH A SPACE lands literally in args, no quoting (ME-23)", () => {
  // The exec-form guarantee: the args element is the LITERAL path even with a space — nothing
  // to escape because the hook is spawned directly with no shell. We assert the shape a merge
  // produces (args[0] === the exact join()ed path) so a space in BRAND.root could never break it.
  const tmp = mkdtempSync(join(tmpdir(), "forge-space-"));
  const settingsPath = join(tmp, "settings.json");
  mergeSettings({ settingsPath });
  const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
  const base = join(BRAND.root, "global");
  const cortexPrompt = merged.hooks.UserPromptSubmit.flatMap((e) => e.hooks || []).find(
    (h) => guardKey(h) === "cortex.sh prompt",
  );
  assert.ok(cortexPrompt, "cortex prompt hook present");
  assert.deepEqual(
    cortexPrompt.args,
    [join(base, "guards", "cortex.sh"), "prompt"],
    "args are the literal resolved path element + trailing arg, verbatim and unquoted",
  );
});

test("an OLD shell-string install dedupes against the exec-form template and is upgraded (ME-23)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-legacy-dedup-"));
  const settingsPath = join(tmp, "settings.json");
  const base = join(BRAND.root, "global");
  // What a pre-ME-23 install wrote: one resolved shell-string command (RA-12 quoted form).
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `bash ${shellQuote(`${base}/guards/cortex.sh`)} prompt`,
              },
            ],
          },
        ],
      },
    }),
  );
  mergeSettings({ settingsPath });
  const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
  const promptHooks = merged.hooks.UserPromptSubmit.flatMap((e) => e.hooks || []).filter(
    (h) => guardKey(h) === "cortex.sh prompt",
  );
  assert.equal(
    promptHooks.length,
    1,
    "no duplicate — the legacy hook deduped against the template",
  );
  // ...and it was upgraded IN PLACE to exec form (command + resolved, unquoted args).
  assert.equal(promptHooks[0].command, "bash");
  assert.deepEqual(promptHooks[0].args, [`${base}/guards/cortex.sh`, "prompt"]);
});

// ---------------------------------------------------------------------------
// RA-13 — invalid profile aborts before ANY side effect
// ---------------------------------------------------------------------------

test("validateProfile accepts known profiles and absence, rejects garbage", () => {
  assert.deepEqual(validateProfile(undefined), { ok: true });
  assert.deepEqual(validateProfile("standard"), {
    ok: true,
    profile: "standard",
  });
  const bad = validateProfile("bogus");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown profile: bogus/);
});

test("init with an invalid profile mutates NOTHING — no emit, no .forge, no gitattributes, no settings", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-badprofile-"));
  const settingsPath = join(root, "home-settings.json");
  const r = init({ targetRoot: root, profile: "bogus", settingsPath });
  assert.equal(r.aborted, true, "init reports the abort");
  assert.match(r.profile.error, /unknown profile: bogus/);
  assert.ok(!existsSync(join(root, "AGENTS.md")), "no AGENTS.md");
  assert.ok(!existsSync(join(root, ".forge")), "no .forge/");
  assert.ok(!existsSync(join(root, ".gitattributes")), "no .gitattributes");
  assert.ok(!existsSync(settingsPath), "settings untouched");
  assert.deepEqual(
    readdirSync(root),
    [],
    "target root is byte-for-byte pristine — zero side effects",
  );
});

// ---------------------------------------------------------------------------
// RA-17 — removeForgeSettings reverses the merge
// ---------------------------------------------------------------------------

test("removeForgeSettings round-trips: merge then remove restores the user's file exactly", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-remove-"));
  const settingsPath = join(tmp, "settings.json");
  const original = {
    model: "opus",
    statusLine: { type: "command", command: "bash ~/my-own-statusline.sh" },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "bash ~/my-hook.sh" }],
        },
      ],
    },
    permissions: { allow: ["Bash(mycmd:*)"], defaultMode: "plan" },
    custom: { keep: true },
  };
  writeFileSync(settingsPath, JSON.stringify(original, null, 2));
  const merged = mergeSettings({ settingsPath });
  assert.equal(merged.action, "merged");
  const r = removeForgeSettings({ settingsPath });
  assert.equal(r.action, "removed");
  assert.ok(r.removed.includes("_forge"), "marker removed");
  assert.ok(r.backup && existsSync(r.backup), "timestamped backup written");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(after, original, "user-owned content is restored exactly");
});

test("removeForgeSettings strips a merge into an EMPTY file completely (fresh-install teardown)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-remove-fresh-"));
  const settingsPath = join(tmp, "settings.json");
  mergeSettings({ settingsPath }); // creates the file from the template
  const r = removeForgeSettings({ settingsPath });
  assert.equal(r.action, "removed");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(!after._forge, "marker gone");
  assert.ok(!after.hooks, "no forge hooks remain");
  assert.ok(!after.permissions, "no forge permissions remain");
  assert.ok(!after.statusLine, "template statusline removed");
});

test("removeForgeSettings removes an OLD unquoted install's entries too (quote-normalized match)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-remove-old-"));
  const settingsPath = join(tmp, "settings.json");
  const base = join(BRAND.root, "global");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      _forge: "forge-managed",
      statusLine: { type: "command", command: `bash ${base}/statusline.sh` },
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `bash ${base}/guards/completion-gate.sh`,
              },
            ],
          },
        ],
      },
    }),
  );
  const r = removeForgeSettings({ settingsPath });
  assert.equal(r.action, "removed");
  assert.ok(r.removed.includes("statusLine"), "unquoted statusline matched and removed");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(!after.hooks, "unquoted guard hook removed");
  assert.ok(!after.statusLine, "statusline removed");
});

test("removeForgeSettings refuses a corrupt file and noops on a missing or unmanaged one", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-remove-edge-"));
  const corrupt = join(tmp, "corrupt.json");
  const garbage = "{ not json ";
  writeFileSync(corrupt, garbage);
  const bad = removeForgeSettings({ settingsPath: corrupt });
  assert.equal(bad.action, "error", "corrupt → refuse");
  assert.equal(readFileSync(corrupt, "utf8"), garbage, "original bytes preserved");
  const missing = removeForgeSettings({ settingsPath: join(tmp, "nope.json") });
  assert.equal(missing.action, "noop", "missing → noop");
  const clean = join(tmp, "clean.json");
  writeFileSync(clean, JSON.stringify({ model: "opus" }));
  const noop = removeForgeSettings({ settingsPath: clean });
  assert.equal(noop.action, "noop", "nothing forge-managed → noop");
  assert.deepEqual(JSON.parse(readFileSync(clean, "utf8")), { model: "opus" });
});

// ---------------------------------------------------------------------------
// HI-05 — ownership manifest: uninstall reverses ONLY what Forge added
// ---------------------------------------------------------------------------

const SETTINGS_SCHEMA = "https://json.schemastore.org/claude-code-settings.json";

test("HI-05 ownership round-trip: user-owned entries that collide with the template survive uninstall byte-identical", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-own-"));
  const settingsPath = join(tmp, "settings.json");
  const base = join(BRAND.root, "global");
  // A statusLine byte-identical to the template's resolved command, a $schema identical to the
  // template's, an allow string the template also ships, and a cortex.sh hook at a DIFFERENT
  // absolute path than Forge's (same basename+args). None of these were added by Forge.
  const userStatusLine = {
    type: "command",
    command: `bash ${shellQuote(join(base, "statusline.sh"))}`,
  };
  const userCortex = {
    type: "command",
    command: "bash /home/user/custom/cortex.sh prompt",
  };
  const original = {
    $schema: SETTINGS_SCHEMA,
    permissions: { allow: ["Bash(git status:*)"], defaultMode: "default" },
    statusLine: userStatusLine,
    hooks: { UserPromptSubmit: [{ hooks: [userCortex] }] },
  };
  writeFileSync(settingsPath, JSON.stringify(original, null, 2));

  const merged = mergeSettings({ settingsPath });
  assert.equal(merged.action, "merged");
  // Delta manifest: an already-present permission is NOT recorded as Forge-added.
  const afterMerge = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(afterMerge._forgeOwned, "ownership manifest written");
  assert.ok(
    !afterMerge._forgeOwned.added.permissions.allow.includes("Bash(git status:*)"),
    "a permission the user already had is never claimed by Forge",
  );
  assert.equal(afterMerge._forgeOwned.added.statusLine, false, "Forge did not set the statusLine");
  assert.equal(afterMerge._forgeOwned.added.schema, false, "Forge did not set $schema");
  // Forge DID add its own cortex.sh prompt hook even though the user has a same-name one.
  const promptCmds = afterMerge.hooks.UserPromptSubmit.flatMap((e) =>
    (e.hooks || []).map(effectiveCmd),
  ).filter((c) => c.includes("cortex.sh") && c.endsWith("prompt"));
  assert.equal(promptCmds.length, 2, "user's and Forge's cortex hooks coexist (different paths)");

  const r = removeForgeSettings({ settingsPath });
  assert.equal(r.action, "removed");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(after, original, "every user-owned entry is restored byte-identical");
  // And Forge's own additions are gone.
  assert.ok(!after.permissions.allow.includes("Bash(git diff:*)"), "Forge's permission removed");
});

test("HI-05 delta manifest: a permission the user already had survives uninstall", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-delta-"));
  const settingsPath = join(tmp, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      permissions: { allow: ["Bash(git status:*)", "Bash(ls:*)"] },
    }),
  );
  mergeSettings({ settingsPath });
  const manifest = JSON.parse(readFileSync(settingsPath, "utf8"))._forgeOwned.added;
  assert.ok(!manifest.permissions.allow.includes("Bash(git status:*)"), "pre-owned not recorded");
  assert.ok(!manifest.permissions.allow.includes("Bash(ls:*)"), "pre-owned not recorded");
  assert.ok(manifest.permissions.allow.includes("Bash(git diff:*)"), "genuinely-added recorded");
  removeForgeSettings({ settingsPath });
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(
    after.permissions.allow.sort(),
    ["Bash(git status:*)", "Bash(ls:*)"].sort(),
    "the user's own permissions survive; only Forge's additions are removed",
  );
});

test("HI-05 re-merge is idempotent: the manifest and entries are stable, no duplicates", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-idem-"));
  const settingsPath = join(tmp, "settings.json");
  mergeSettings({ settingsPath });
  const first = JSON.parse(readFileSync(settingsPath, "utf8"));
  const second = mergeSettings({ settingsPath });
  assert.equal(second.action, "unchanged", "re-merge is a no-op");
  const afterSecond = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(afterSecond._forgeOwned, first._forgeOwned, "manifest is byte-stable");
  const promptCmds = afterSecond.hooks.UserPromptSubmit.flatMap((e) =>
    (e.hooks || []).map(effectiveCmd),
  );
  assert.equal(
    promptCmds.filter((c) => c.includes("cortex.sh") && c.endsWith("prompt")).length,
    1,
    "no duplicate hook entries on re-merge",
  );
});

// ---------------------------------------------------------------------------
// HI-09 — profile persistence failure aborts init before any side effect
// ---------------------------------------------------------------------------

test("HI-09 init aborts on a corrupt forge.config.json — zero side effects (no emit/gitattributes/settings)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-hi09-"));
  mkdirSync(join(root, ".forge"), { recursive: true });
  const cfg = join(root, ".forge/forge.config.json");
  const original = "{ corrupt";
  writeFileSync(cfg, original);
  const settingsPath = join(root, "home-settings.json");
  const r = init({ targetRoot: root, profile: "minimal", settingsPath });
  assert.equal(r.aborted, true, "init reports the abort");
  assert.match(r.profile.error, /not valid JSON/);
  assert.equal(readFileSync(cfg, "utf8"), original, "corrupt config bytes preserved");
  assert.ok(!existsSync(join(root, "AGENTS.md")), "no AGENTS.md emitted");
  assert.ok(!existsSync(join(root, "CLAUDE.md")), "no CLAUDE.md emitted");
  assert.ok(!existsSync(join(root, ".gitattributes")), "no .gitattributes appended");
  assert.ok(!existsSync(settingsPath), "settings never touched");
});
