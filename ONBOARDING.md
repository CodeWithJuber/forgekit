# Onboarding — five minutes to productive

> **Forge** is a cross-tool config layer plus a cognitive substrate for AI coding
> agents (Claude Code, Codex, Cursor, Gemini, Aider…). Author your rules once; it
> configures every tool and adds memory, blast-radius checks, and guardrails.

## 1. Install (once)

The recommended paths need no token and no clone:

```bash
# Claude Code / Codex — the plugin (guards auto-wire, nothing to merge)
/plugin marketplace add CodeWithJuber/forgekit
/plugin install forgekit

# Any tool — the CLI, from public npm
npm install -g @codewithjuber/forgekit

forge doctor               # everything green?
```

Full matrix (no-registry `github:` install, symlink dev setup) →
[README → Install](README.md#install).

## 2. Configure a repo (once per repo)

```bash
cd ~/your-project
forge init                 # emits AGENTS.md, CLAUDE.md, .gemini/settings.json, .aider.conf.yml …
```

Now Claude Code, Codex, Cursor, Gemini, Aider, Copilot, Windsurf, Zed, and Continue all
read the **same** rules — each from its own native file (plus MCP config for Roo and VS Code).

## 3. Change a rule

Edit `source/rules.json` (or drop a per-repo `.forge/rules.json`), then:

```bash
forge sync                 # recompiles into every tool; idempotent (only rewrites what changed)
```

## 4. Use the cognitive substrate

```bash
forge substrate "<task>"      # ask/route/impact/scope/memory/verify in one pass
forge substrate "<task>" --json
forge impact <symbol-or-file>
```

If `forge substrate` says `ASK FIRST`, ask the returned questions before editing. Read predicted impacted files before making mutating changes.

Paper and evidence package: [docs/cognitive-substrate/](docs/cognitive-substrate/).

## 5. Use the extras

```bash
forge atlas build          # index this repo's symbols → .forge/atlas.json
forge atlas query useAuth  # where is it defined? (cheaper than grep-and-read)
forge atlas has useAuth    # does it exist? "not found" = likely hallucinated
forge recall add "db port" "Postgres is on 5433 here, not 5432"
forge recall list          # facts the recall-load guard injects next session
forge catalog              # the Start-Here index of everything
```

---

## Forge principles

Forge is opinionated. These are the ideas every part of it is built on — the "why"
behind the mechanisms.

### 1. Guard over prose

Rules the model can drift from live in prose; rules it must **never** break live in
**guards** (deterministic shell hooks). A guard can't be forgotten after context
compaction. Move every enforceable invariant out of `CLAUDE.md` and into a guard;
keep the prose thin.

### 2. One source, many emitters

Author rules **once** (`source/rules.json`); a deterministic compiler (`forge sync`)
emits each tool's native format with a content-hash header, so drift is detectable
and re-running is a no-op. No rule is ever written twice.

### 3. Precompute, then serve

Answer "where is X / does X exist" from a **prebuilt artifact** (`.forge/atlas.json`),
not a live scan. Resolve the expensive part once; serve a few-hundred-token slice
instead of reading five files. The artifact is portable — any tool reads it, no MCP
required.

### 4. The Lean Path

The smallest change that works, chosen _after_ understanding the problem: need it at
all? → already here? → stdlib/native/existing dep? → one small change → root not
symptom. Deletion over addition. Boring over clever. (See the `lean` tool.)

### 5. Reuse over rebuild — thin layers over proven primitives

"Our own" never means "reimplement a mature tool." `atlas` leans on LSP-class
primitives; `lean` is one rule file, not a plugin engine. The smallest surface that
delivers the capability.

### 6. Verify, don't assert

Nothing is "done" without a check you can run — a test, a build exit code, a
screenshot. Show the command and its output. Fix root causes; never suppress an
error to make a check pass.

### 7. Re-entrancy safety

No guard may loop. Every guard is idempotent, holds an atomic lock while it runs,
and the one guard that calls a model (`session-learner`) is opt-in, gated, and
single-shot. The class of bug that once burned 1.67B tokens in five hours cannot
originate here.

### 8. Name the ceiling

Every deliberate simplification states its limit and upgrade path, in code and in
docs. Forge would rather ship an honest subset with a clear boundary than a vague
claim — see [the honest limits](docs/GUIDE.md#honest-limits).

---

## Extend it

- **Add a rule** → a bullet in `source/rules.json`, then `forge sync`.
- **Add a tool (skill)** → `global/tools/<name>/SKILL.md` with `name` + `description` frontmatter.
- **Add a guard** → `global/guards/<name>.sh` (source `_guardlib.sh` for fields + the lock), then wire it in `global/settings.template.json` and `hooks/hooks.json`.
- **Rebrand** → edit `brand.json` (+ `package.json` bin, `.claude-plugin/plugin.json` name).

Every command with worked examples and the full extension guide live in
[docs/GUIDE.md](docs/GUIDE.md); the architecture, pain-point evidence, and cross-tool
matrix live in [ARCHITECTURE.md](ARCHITECTURE.md).
