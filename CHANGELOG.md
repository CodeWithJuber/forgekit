# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`forge know` — the A7 knowledge-router.** Total routing (formal-synthesis
  Theorem T6) of any fact to its storage home: exemplar k-NN over a labeled bank
  (`src/knowledge_router.js`) picks among claude-md / rule / skill / state /
  decision / ledger-fact / recall; below-confidence facts fall back to the ledger
  (provenance `fallback`) instead of being dropped. Append-only homes are written
  directly (decide log, repo-ledger fact claim, personal recall store), curated
  files get advice naming the right command, secrets are refused before dispatch,
  and `--dry-run`/`--json` route without writing. Distilled Cortex lessons that
  read like decisions or durable facts auto-route to those homes (fail-open).
- **Commit-level gate rung (`forge precommit`).** The gate lattice's middle rung
  (turn ⊂ commit ⊂ PR): `src/commit_gate.js` classifies staged files with the same
  registry-derived classifier as the Stop gate (code staged with no doc/state artifact
  → finding) and runs the built-in secret detector over staged added lines as a
  gitleaks fallback. `FORGE_COMMIT_GATE` sets the mode (`warn` default · `block` ·
  `0` kill switch); a detected secret blocks in every mode. `forge harden` now installs
  a pre-commit hook that runs gitleaks when present, then the commit gate — and never
  clobbers a user-authored hook (writes `pre-commit.forge` beside it instead).
- **Pin/downgrade via `update --to <version>`.** New `applyUpdateTo` in
  `src/update.js`: for a git checkout it fetches tags, verifies the release tag
  exists (unknown version → honest miss, never a throw), and detached-checkouts
  the tag with a note on how to return to latest; npm-global installs get the
  exact `npm i -g <pkg>@<version>` instruction instead.
- **Multi-lens verification consensus.** `forge verify --deep` (new `src/consensus.js`)
  runs a LENSES table over the diff — tests, unknown symbols, unreviewed impact
  radius, docs drift, secrets in added lines, spec-lock drift, plus an optional
  `--llm` majority-of-3 reviewer panel — and aggregates noisy-OR
  `P(defect)=1−∏(1−wᵢsᵢ)` with the same cross-family gate as the lesson miner: a
  lone structural signal (or the model reviewer alone) never blocks; a failing test
  suite or a leaked secret blocks solo. Findings extend `.forge/provenance.json`
  with per-lens evidence and the Theorem-D residual `∏(1−cⱼ)` over the lenses that
  ran, and each run appends one `stage:"verify"` metrics record.
- **`forge radar` — dependency-currency rings (I4 verified currency).** New zero-dep
  `src/radar.js` reads this repo's Node manifests, probes the registry (injectable
  `fetchImpl`; metadata + bulk advisories; 4s timeout) and classifies every dependency
  into an adopt/trial/assess/hold ring from _evidence_ — staleness (540-day half-life),
  major-version lag, severity-weighted advisories, deprecation; atlas usage is stakes,
  not risk. Deprecated or a critical advisory → `hold`; fewer than two verified evidence
  kinds → `assess` (never adopt on absence). Cached at `.forge/radar.json`
  (`FORGE_RADAR_TTL_H`, default 24h); `--offline` serves the stale cache or fails
  honestly; `--refresh` re-probes; `--json` for tooling. A network scan records I4
  evidence into the ledger (`currency:<dep>` facts, supersede semantics) plus a metrics
  line, and the pre-edit hook surfaces a cache-only advisory when a file imports a `hold`
  dependency (kill switch `FORGE_RADAR=0`).
- **Cross-machine memory sync.** `forge ledger sync` push-pulls the PCM ledger through a
  git ref (`refs/forge/ledger` via `hash-object`/`mktree`/`commit-tree` plumbing;
  non-fast-forward races re-merge and retry ≤3 — monotone by the CRDT join, so nothing is
  lost) or a shared directory (bidirectional union-merge; `FORGE_SYNC_DIR` is the default
  dir target). Target precedence: `--dir` > `--remote`/`--ref` > the repo's git remote >
  `FORGE_SYNC_DIR` > an honest "no target". `--personal` syncs the per-user ledger beside
  the recall store, making recall facts portable across machines. Fails open (offline,
  missing remote, or corrupt remote blob → an honest reason, never a throw); the git
  runner is injectable so tests drive it with local bare remotes and never touch the
  network.
- **Anti-repetition memory (`forge deja`).** A first-try success mints no Cortex lesson,
  so its trace used to be discarded when the session ended — the root of cross-session
  repetition. Now every session Stop mints one `summary` claim (an existing ledger kind)
  with a secret-redacted gist of the task and the files touched, attaching a `test.run`
  confirm outcome when the session's own tests passed (so verified work outranks a mere
  attempt). New `src/deja.js` `dejaLookup` ranks prior summaries/lessons/diagnoses via the
  same Eq. 3 retrieval as `ledger query`; `forge deja "<task>"` surfaces them, and the
  pre-action substrate shows a one-line "déjà vu" advisory when a prompt matches prior
  solved work. Kill switch `FORGE_DEJA=0`. Because summaries are ordinary ledger claims,
  `forge ledger merge` carries them between machines.

## [0.19.0] - 2026-07-17

### Added

- **Color-aware CLI output.** New zero-dep `src/fmt.js`: `supportsColor` honoring the
  `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > TTY precedence, brand-token painting
  (24-bit from `brand.json` when `COLORTERM` declares truecolor, portable 16-color
  fallback otherwise), visible-width-aligned `table`, and `bar` confidence meters —
  adopted across `ledger` (stats/blame/query), `cortex`, `route`, `doctor`, and
  `cost` output plus the `--verbose` title line. Piped output stays escape-free.

### Fixed

- **Research crosswalk reconciled with the code.** The formal-synthesis paper's
  crosswalk (rows 5/6/12/14 and the README §11 binding paragraph) cited hooks that
  no longer exist (`docs-guard.sh`, `session-context.sh`, `intent-router.sh`); the
  bindings now name the real system (`cortex.sh` → `src/gate.js` stopGate,
  `src/session.js` rehydrationBlock, `src/intent.js` exemplar k-NN), with kit-only
  names marked by a `kit:` prefix. A new `crosswalk` docs-check reconciler fails CI
  when any non-`kit:` `.js`/`.sh` binding in `crosswalk.json` names a file that does
  not exist in `src/`, `global/guards/`, or `hooks/`.

## [0.18.0] - 2026-07-16

### Changed

- **Single design-token source.** `brand.json` gained a `colors` block (full dark +
  light palettes) as the one source of the visual palette, plus `fonts` and `site`.
  `src/brand.js` exposes it via `cssVars(scheme)` + `rootTokensCss()` pure helpers;
  the generated status page (`scripts/build-pages.mjs`) now injects tokens from that
  one source (and gains light mode), and `test/pages.test.js` enforces full-palette
  parity — every dark and light hex in `brand.json` must appear on both public pages,
  so the landing page and status page can no longer fork into two palettes claiming
  to be one.
- **Landing page redesign.** Rebuilt `landing/index.html` on a Stat-Led structure:
  the real shipped hero diagram is now embedded (inlined so it resolves in local
  preview and at the deployed site root), the fake terminal chrome, placeholder
  digit/glyph icons, and faux-live pulse dot are gone, capabilities use real inline
  SVG icons in a hairline-divided layout instead of a uniform card grid, and the
  sticky-nav blur is compositor-light. Light-mode accents are darkened to meet AA
  contrast on the light paper.
- **Accessibility + design-system hygiene.** All accent/supplementary-text pairs on
  both themes are now verified ≥4.5:1 (bumped `--faint` in dark + light, and light
  `--brand`/`--ok`, at the single brand.json source). Border-radii are collapsed onto
  a deliberate 3-level scale (`--radius-sm` / `--radius` / pill), so `forge uicheck
design` passes spacing-scale, radius-levels, and shadow-levels with a healthy
  slop-distance. Focus rings appear instantly (no animated outline), motion is
  transform/opacity-only under `prefers-reduced-motion`.

### Added

- **Social + icon metadata on both public pages.** The landing and generated status
  pages now ship `og:image` / `twitter:image` (a 1200×630 brand card,
  `docs/assets/og.png`, rasterized once via Chromium — an author artifact, not a
  runtime dep), a favicon + apple-touch-icon (`docs/assets/favicon.svg` /
  `apple-touch-icon.png`), and consistent `canonical` == `og:url`. The status page
  gained a full Open Graph / Twitter / `SoftwareApplication` JSON-LD head; the deploy
  workflow copies the brand assets to the Pages root so the absolute URLs resolve.
- **Brand-aligned status line.** `global/statusline.sh` now renders the exact brand
  tokens (ember `#f26430`, warm-taupe greys) in 24-bit truecolor from a named palette
  block, with a 256-color fallback when the terminal can't do truecolor. New
  `test/statusline.test.js` smoke-tests the segments, the exact truecolor hexes, the
  fallback, and graceful degradation on minimal input.
- **Mermaid theme-value guard.** `forge docs check`'s `checkDiagrams` now verifies each
  `%%{init` block carries the brand's actual color values (ember + warm-black from
  `brand.json`), not just that a theme directive is present — a diagram can no longer
  declare a theme and still render off-brand. README leads with a `Start in 60 seconds`
  block, and `ARCHITECTURE.md` documents `brand.json` as the single color source.

### Fixed

- **Status-page metrics were silently stale.** The `impact` and `saved` regexes in
  `scripts/build-pages.mjs` no longer matched the current README, so those
  "repo-sourced" numbers were really hardcoded fallbacks. Regexes fixed to parse the
  README, and a non-match is now a hard build error (`mustMatch`) instead of a silent
  fallback; the dead `claim` field is removed.
- **Generated status page no longer ships stale/leaky.** `public/index.html` is a
  build artifact (regenerated at deploy), so it is now gitignored and dropped from
  the npm `files` list — a stale committed copy (old version + a dev-branch name
  leaked into a visible chip) can no longer be published in the tarball.
- **Landing → status link** now points at the absolute Pages URL, so it resolves in
  local file preview instead of 404-ing on `./status/`.

## [0.17.0] - 2026-07-15

### Added

- **OpenAI + Gemini provider detection** — `autoDetectProvider()` now recognizes
  `OPENAI_API_KEY` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) as zero-config
  fallbacks after Anthropic, exposing `openai` and `gemini` as built-in providers
  with tier→model maps. Both are reached over their OpenAI-compatible
  chat/completions surface: `src/llm.js` gained an OpenAI-compatible wire format
  (`resolveHttpProvider()` now returns a `format` field) alongside the Anthropic
  Messages path, so a native key from either vendor works with no manual config.
  Anthropic credentials still win when present. `forge config` status and
  `listDetectedProviders()` surface the new keys.

## [0.16.0] - 2026-07-15

### Added

- **Playwright interaction loop** — `forge uicheck interact <file-or-url>` drives the
  page headless under `prefers-reduced-motion` and checks what it _does_
  (console-clean, keyboard-reachable, focus-visible, reduced-motion), where
  `uicheck visual` only fingerprints what it paints. The verdict is recorded through
  the ledger's cross-family-gated `behavioral` oracle (advisory by default;
  `--record` appends it as evidence on the project `fingerprint` claim, `--enforce`
  gates). Reuses the visual gate's Playwright resolver + loopback-only target guard;
  Playwright stays an optional tier (ADR-0005) with a graceful skip. New
  `src/uiinteract.js` (`runInteractions`, `summarizeVerdict`, `verdictOutcome`,
  `recordInteraction`) with a browser-free test suite.

## [0.15.0] - 2026-07-15

### Added

- measured-promotion gate + outcome-calibrated routing

## [0.14.0] - 2026-07-15

### Added

- **Measured-promotion gate + outcome-calibrated routing (`forge route calibrate`)** —
  a reusable `src/promote.js` generalizes the risk predictor's kill-criteria: an
  advisory signal (a calibrated weight, later a consolidation cluster or hazard
  estimate) may become active **only** if it beats the current baseline on held-out
  data under a metric+margin — the honesty register (overview §4), never an assertion.
  First application: `forge route calibrate` fits an affine correction of the routing
  rubric toward a held-out labeled fixture and promotes it only if it lowers held-out
  MAE. Advisory by default — routing keeps the rubric until a promotion is adopted
  (`calibratedComplexity` mirrors `predictor.riskFor`). Zero deps, fully unit-tested.
- **Legacy-store retirement (`FORGE_LEDGER_ONLY`)** — the PCM ledger can now be the
  _only_ store. Since P1 it has been the convergent write store (dual-write) with a
  merged read (`ledger_read`); with `FORGE_LEDGER_ONLY=1` the legacy files
  (`.forge/lessons/*.md`, recall/brain fact files) stop being written and every read
  materializes from the ledger — cortex confirm/create/distill dedup against
  `ledgerLessons`, `mergedLessons` returns the ledger view, and `recall.readFact` falls
  back to the ledger (also fixing merged teammate facts that had no local file). Run
  `forge ledger import` first to backfill. Default off keeps the legacy files canonical.

## [0.13.0] - 2026-07-15

### Added

- Custom-gateway model remap (`src/gateway_model_map.js`). The tier table pins public
  Anthropic IDs that a self-hosted LiteLLM/proxy gateway may not serve; when a non-default
  gateway base URL is set, Forge fetches `GET /v1/models` once per process and scores each
  advertised model against every tier's family (family-word gate + `setOverlap` name-token
  score, deterministic tie-break) to remap `haiku/sonnet/opus/fable` onto the gateway's real
  IDs. `forge doctor` surfaces the resolved `tier→model` mapping under a **gateway models** row.
  Zero breaking change — the `MODELS` export shape is unchanged, it fails safe to the stock ID
  on no gateway / unreachable `/v1/models` / no family match, and an explicit
  `.forge/providers.json` alias or `ANTHROPIC_MODEL` override always wins. Direct
  `api.anthropic.com` sessions never probe and are byte-identical.

## [0.12.4] - 2026-07-11

### Fixed

- security: drop two inert `curl`-pipe deny rules from the settings template.
  Claude Code only honors `:*` as a trailing wildcard, so the trailing pipe made
  the colon a literal and the rules matched nothing. Real pipe-to-shell
  enforcement already lives in `protect-paths.sh`, now tightened to also catch a
  no-space pipe and a `zsh` target. Adds a regression test for template rule
  shape.

## [0.12.3] - 2026-07-11

### Fixed

- bump.mjs keeps ROADMAP's "Now" marker in sync

## [0.12.2] - 2026-07-11

### Fixed

- allowlist bibliography citation-key false positives in gitleaks
- don't let an empty Unreleased section blank the status page changelog

## [0.12.1] - 2026-07-11

### Fixed

- don't let an empty Unreleased section blank the status page changelog

## [0.12.0] - 2026-07-11

### Changed

- **Goal-drift classification is graded and identifier-aware (`src/anchor.js`).** A changed
  file's on-goal/off-goal call is now a **noisy-OR** (`1 − (1 − p)^hits`) over how many
  distinct goal concepts it exhibits in its path **and** the identifiers it defines (via the
  atlas), thresholded at the single-hit floor — replacing the binary path-substring match, so
  a file that implements the goal but never names it in its path is caught deterministically,
  not just by the opt-in LLM pass. `driftScore` stays the off-goal fraction, so the CUSUM
  detector's operating point is unchanged (an on-goal checkpoint scores 0 and drains the chart);
  the sharper classification is what improves the signal.
- **Specification completeness is a logistic estimator (`src/preflight.js`).** The M2
  assumption gate's `s(x)` completeness score is now a logistic over its features
  (concreteness, named specifics, vagueness, a smooth `tanh` length term) — replacing the
  additive scorer's magic coefficients and discontinuous word-count steps. The `sigmoid`
  bounds it to (0,1) with no clamp, each feature's pull stays attributable, and a labeled
  bank could refine the weights via `predictor.js`'s `trainLogistic`. Calibrated to keep the
  documented examples (a bare "make the auth better" ≈ 0.23 → ask; a concrete verifyToken
  edit ≈ 0.63 → proceed).

### Added

- **`forge docs check` now guards intra-repo links and roadmap freshness** — two more
  reconcilers close recurring "docs rot" classes: `checkLinks` resolves every Markdown
  anchor (`#x` and `path.md#x`) against the target file's real headings using
  GitHub-exact slugs (an em-dash yields `--`, never collapsed), catching dead anchors like
  a renamed `#install`; `checkRoadmap` fails when ROADMAP's "Now" marker trails the shipped
  `package.json` version.

### Fixed

- **Dead and fabricated docs** — a fabricated `forge route` example in `docs/GUIDE.md`
  (an impossible `Fable 5 / Opus` / "premium tier" output) now shows the real routed
  verdict; broken `#install` anchors in `ONBOARDING.md` and the substrate README now point
  to `#60-second-quickstart`; a dead `#use-it-in-a-script` self-link resolves; and ROADMAP's
  "Now" marker is current (v0.11.0). All now enforced by the new docs-check guards.

## [0.11.0] - 2026-07-11

### Added

- **`forge stack`** — dynamic stack detection: reads the repo's dependency manifests
  (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`,
  `pom.xml`/`build.gradle`, `*.csproj`) and reports its real languages, frameworks,
  package managers, and test commands — data-driven (extend by adding a `SIGNATURES`
  row), not a hardcoded menu. The detected test commands now drive the substrate's
  verification checklist instead of assuming npm.
- **Six more atlas languages** — Ruby, C#, PHP, Kotlin, Swift, and C/C++ join JS/TS,
  Python, Go, Rust, and Java (whose method defs are now indexed too). One `RULES` table;
  the walk, completion gate, and docs sweep pick each up automatically.
- **`forge update`** — self-update: `--check` reports whether a newer version is
  available (commits behind upstream, from a cached hourly fetch), bare applies it
  (`git pull --ff-only` for a checkout, or the `npm i -g` command otherwise). `forge
doctor` surfaces a non-nagging "update available" notice; `FORGE_NO_UPDATE_CHECK=1`
  silences it. Fail-open: offline / non-git / detached-HEAD never error.
- **Self-dogfood** — a committed `.claude/settings.json` wires forgekit's own guards via
  `${CLAUDE_PROJECT_DIR}`, so the repo runs its own completion gate, cortex, and guards
  during local dev without a marketplace install.
- **Auto-release on merge** — pushing a `feat`/`fix`/`perf`/breaking change to `master`
  now cuts the release automatically (bump → tag → npm publish → GitHub Release); a
  chore/docs-only merge skips cleanly (`bump.mjs auto` exits `3`). When `[Unreleased]` is
  empty, `bump.mjs` synthesizes the changelog body from commit subjects so every release
  still describes itself. Manual **Actions → Bump version** dispatch stays available.
- **`forge docs check` now guards diagrams, model prices, and benchmark numbers** — three
  new reconcilers close the blind spots behind recurring complaints: every `mermaid` block
  across all Markdown must carry the branded theme and use `<br/>` (not a literal `\n`);
  model prices in the docs must match `src/model_tiers.json`; and every bolded `N ms`
  claim in the README must be a value `reports/benchmarks.md` actually measured.

### Changed

- **CLI output is quiet by default** — the `Forge <command> — …` title line no longer
  prints on every command; results come first. `--verbose` or `FORGE_VERBOSE=1` restores
  it. The `--help` / `--version` banner is unchanged.
- **Unified public design system** — the landing page and the generated status page now
  share one warm ember/near-black palette and a system font stack (the landing page no
  longer declares the Inter webfont it never loaded). `test/pages.test.js` enforces token
  parity, a non-empty changes list, and no phantom webfont.
- **Restyled the terminal statusline** — a restrained palette (muted structure, one ember
  accent, green/red reserved for the diff) with consistent `·` separators and a subtle
  context-limit marker instead of an alarming red block.
- **Plain-language docs pass** — the README and GUIDE openings lead with what forgekit is
  and does; the deep math (`y = f(x)`, join-semilattice, Beta posteriors) moved into
  parentheticals or the white paper, and comparison-table cells no longer cite code
  identifiers as if they were user features.

### Fixed

- **Broken diagrams** — two `mermaid` diagrams rendered in Mermaid's off-brand default
  theme, one with literal `\n` node breaks GitHub showed as garbage; both fixed, and the
  over-wide 13-node pre-action pipeline was regrouped so it reads at GitHub width.
- **Status page "Latest changes" list** — wrapped CHANGELOG bullets were truncated
  mid-sentence (and could render empty); the parser now joins lazy/indented continuation
  lines into the full item.

## [0.10.0] - 2026-07-10

### Added

- **The completion gate** — a synchronous Stop hook (`global/guards/completion-gate.sh`
  → `src/gate.js`) that blocks a session ONCE when code changed but no doc or state
  artifact moved with it, answering with the repair checklist (`forge docs sync`,
  `forge handoff`, `forge decide`, plus a CUSUM goal-drift alarm when the session's
  recorded drift sustained). Loop-safe (`stop_hook_active` + once-per-session marker),
  fail-open on every error path, kill switch `FORGE_STOPGATE=0`. Classification derives
  from the atlas registries + the shared test-file predicate — no parallel regex lists.
- **`forge handoff`** — the bounded session snapshot: rewrites `.forge/state.md`
  (≤150 lines; goal/phase, acceptance criteria, done, next, gotchas, recorded
  assumptions, in-progress git files) and SessionStart re-injects it, so the next
  session resumes instead of re-assuming. Refuses secrets like every forge store.
- **`forge decide`** — append-only ADR-lite decision log (`.forge/decisions.md`,
  `D-####` numbering) + a machine-readable `decision` ledger twin; bare `forge decide`
  lists the last ten. Supersede with a new entry, never an edit.
- **`forge docs sync`** — the diff-driven half of docs↔code alignment: changed
  identifiers (paths, definitions, called symbols — from added AND removed lines) swept
  against every doc artifact → UPDATED / STALE (file:line hits) / VERIFIED-UNAFFECTED
  (reason recorded). Advisory by default, `--strict` for CI, `--base <ref>` to widen;
  CHANGELOG and the decision log are exempt (append-only history).
- **Session baseline + rehydration** — SessionStart records the session's git anchor
  (`.forge/sessions/<sid>.base`; a resume never moves it), prunes week-old session
  artifacts, and injects the handoff snapshot + last 10 commits + uncommitted changes.
- **Intent protocol cards** — UserPromptSubmit classifies the prompt with the same
  exemplar k-NN math as routing (labeled bank incl. Hinglish rows, overlap similarity,
  confidence gate) and injects a bugfix/feature/refactor/release protocol card once per
  run of that intent; questions get no ceremony. Kill switch `FORGE_INTENT=0`.
- **Recorded assumptions** — when preflight proceeds without asking, the assumption is
  appended to the session log, named in the advisory, and surfaces in the next handoff;
  the per-prompt goal-drift score is recorded the same way and feeds the gate's CUSUM.
- **Config artifacts in the atlas** — CI workflows (`.github` is now walked),
  manifests, and Dockerfiles become `config:` nodes with `references` edges to the code
  paths they name, so `forge impact` lists the configs a change can break (lockfiles
  excluded as generated churn).
- **End-to-end skills + agent** — `handoff`, `sync-docs`, and `catchup` skills, a
  `doc-sync` crew agent that repairs stale docs in its own context, and an
  `end-to-end` rules section (Definition of Done, no silent assumptions, decision log)
  compiled into every tool by `forge sync`.

### Fixed

- **`cortex.sh` hook entry resolution in symlink installs** — `~/.forge/src/…` pointed
  at the nonexistent `global/src/`, silently no-opping every cortex hook outside plugin
  mode; the shim now resolves through the symlink (`pwd -P`), same as `secret-redact.sh`.
- **Twelve defects found by a two-angle adversarial review of the new layer, all with
  regression tests** — the gate no longer attributes pre-session dirt, branch-switch/pull
  commits, or vendor trees to the session (session-scoped changed set: committer-time
  window + SessionStart dirty snapshot); `-z` NUL parsing keeps unicode/space/arrow paths
  correctly classified; an unwritable block-once marker stands down instead of blocking
  every turn; a missing `session_id` disables gating instead of sharing `default` state;
  a >7-day resume re-anchors instead of losing its baseline to the prune; `readState` no
  longer truncates snapshots whose rows contain `<!--`; `forge decide` takes a lock so
  concurrent appends can't mint duplicate D-#### ids; the docs sweep stopped scanning its
  own bookkeeping (`.forge/state.md`), scans touched docs for REMOVED symbols (the rename
  case), counts lowercase symbols only inside backticks, dedupes recorded assumptions,
  and errors on an unknown `--base` instead of mislabeling the report.

## [0.9.0] - 2026-07-10

### Added

- **Gateway environments work end to end** — `ANTHROPIC_AUTH_TOKEN` is recognized
  everywhere `ANTHROPIC_API_KEY` is; `ANTHROPIC_MODEL` / `FORGE_MODEL` pin one model
  (bypassing tier routing); a gateway-looking `ANTHROPIC_BASE_URL` auto-classifies as
  LiteLLM; and the LLM proposer falls back to **direct HTTP** (`src/llm.js`, Anthropic
  Messages API) when the `claude` CLI is absent — or on `FORGE_LLM_HTTP=1`.
- **`forge docs check`** (+ CI job + doctor check) — reconciles README/GUIDE/
  ARCHITECTURE/ROADMAP against the code: every CLI command documented, every env var
  read is documented and every documented var is real, MCP tool counts/names match the
  registry, CHANGELOG sections non-empty. First run found 56 real drift issues,
  including a phantom env var. `scripts/bump.mjs` now refuses to rotate an empty
  `[Unreleased]`.
- **Docs are in the impact graph** — the atlas parses markdown into doc nodes with
  `references` edges to the code they name, so `forge impact src/foo.js` lists the
  docs that go stale, and the pre-edit hook says so before the edit.
- **Persistent goal** — `forge anchor set/show/clear` stores the active goal in
  `.forge/goal.md`; SessionStart re-injects it and a bare `forge anchor` checks
  against it. `goalDrift` also returns a graded `driftScore` for the CUSUM detector.
- **AGENTS.md auto-repair** — the Stop hook re-runs sync when the managed AGENTS.md
  drifts from its canonical inputs (disable: `FORGE_AUTOSYNC=0`).
- **Entropy secret detection** — `src/secrets.js` is the single source of truth
  (format grammars + Shannon-entropy gate for unknown-vendor tokens); the
  `secret-redact` guard now imports it, ending the JS/shell regex divergence.
- **`src/math.js`** — Shannon entropy, charset classes, exact set Jaccard/overlap.

### Changed

- **Routing scores by exemplar similarity, not keyword lists** — the text rubric is
  similarity-weighted k-NN over a labeled `EXEMPLARS` bank (overlap-coefficient on
  stopword-filtered unigram+bigram sets, credibility-shrunk); the four topic keyword
  regexes and their additive magic weights are gone. Tune routing by adding labeled
  rows, not by editing weights.
- **Lesson matching is graded** — the keyword tier of `matchScore` scores by token
  overlap (same-module partial credit) instead of all-or-nothing string equality.
- **Substrate minimality warnings derive from computed signals** (preflight missing
  dimensions + route score) instead of a second keyword copy.
- **`forge scan` detects obfuscated payloads** — long high-entropy base64 blobs flag
  as findings alongside the signature rules.
- **`providerStatus` probes `/health` on any custom base URL** and reports behavioral
  gateway evidence (a proxy that answers /health is a gateway, whatever its hostname).

## [0.8.1] - 2026-07-08

### Added

- **MCP write tools** — `forge_remember`, `forge_ledger_ratify`,
  `forge_ledger_retract` join the read tools (19 tools total).

### Changed

- Simplified CLI surface and improved dashboard UX empty states.

### Fixed

- Stale documentation across command references.

## [0.8.0] - 2026-07-08

### Added

- **Forge work system** — auto-install flow, multi-provider routing, the cost
  dashboard (`forge dash`), and the cortex MCP server's read-path tools.
- **Zero-config provider auto-detection** — `autoDetectProvider()` resolves the
  provider from the environment (LiteLLM local/hosted, OpenRouter, Anthropic);
  `forge init` reports what it found.
- **Hosted LiteLLM gateway support** — `emitGatewayConfig()` writes a
  `litellm.config.yaml` exposing complexity tiers as model aliases.

### Fixed

- TypeScript errors and Biome 2.5.2 lint warnings across source and tests.

## [0.7.0] - 2026-07-08

### Added

- **Optional embeddings tier** (`src/embed.js`, ADR-0005; ROADMAP "Next"): set
  `FORGE_EMBED=cmd:<command>` (stdin/stdout JSON protocol — any local model or script)
  or `FORGE_EMBED=http:<url>` (OpenAI-compatible, `$FORGE_EMBED_MODEL` /
  `$FORGE_EMBED_KEY`, key never logged) and `forge reuse query` + `forge ledger query`
  replace the MinHash `rel` term with embedding cosine (near/adapt ≥ 0.85/0.7 — a
  higher bar than Jaccard's 0.8/0.6 to match dense cosine's noise floor), fixing the
  documented weak spot on very short specs. Vectors are disk-cached
  (`.forge/embed-cache.jsonl`, content-hash keyed, corrupt-tolerant, truncate-oldest);
  both commands print the backend that served (`sim: minhash` / `sim: embed(cmd)`);
  any provider failure degrades silently to MinHash. `dependencies` stays empty —
  the tier is configuration, not a package; the pure ledger core never imports it.
- **`forge uicheck visual <file-or-url>`** — the Playwright visual loop
  (07-ui-quality-gate §5): renders the page headless at two viewports, fingerprints
  the **computed** styles of every visible element (what the cascade and runtime
  theming actually painted, with used `auto`-margins and never-painted UA noise
  filtered out), and runs the identical `design` gate over that rendered vector —
  screenshots land in `.forge/ui/`. Playwright stays an optional tier (ADR-0005):
  `package.json` gains no dependency, absence degrades to a "skipped (no browser
  runtime)" note with exit 0 (`npm i -D playwright-core` or `FORGE_PLAYWRIGHT=…` to
  enable), and non-loopback http(s) targets are refused by default (`--remote` to
  override) — a gate that fetches arbitrary URLs is an exfiltration hazard.

### Changed

- **Ledger read-path flip (P2).** Reads are now a merged view (legacy ∪ ledger) via the
  new `src/ledger_read.js`, so teammate knowledge that arrives with `forge ledger merge`
  actually reaches injection and retrieval: cortex lesson surfaces
  (`lessonsForContext`, `startupBlock`, `summary`, the substrate advisory and routing
  past-mistake density) map ledger `lesson` claims onto the legacy lesson shape with an
  evidence-derived status (tombstoned → retired, val ≥ 0.6 → active, val < 0.45 with a
  contradiction → quarantined, else candidate), and fact surfaces (`recall list`/
  `MEMORY.md`, brain's `AGENTS.md` index) include live ledger `fact` claims — always
  deduped by legacy id/slug with the local file winning, and best-effort (a missing or
  corrupt ledger degrades to legacy-only). Write paths (`recordMistake`'s
  confirm-vs-create lookup, `recordContradiction`, `applyDistillation`) deliberately
  keep reading the legacy store they edit; convergence comes from content-addressed
  claim ids. `reconcileFacts` now only tombstones locally-authored claims, so a merged
  teammate fact survives `forge recall consolidate`. Legacy formats are still written —
  full retirement is the next step.
- **Professional redesign of the public site, gated by forge's own UI system.** The
  landing page (`landing/index.html`) and the generated status page
  (`scripts/build-pages.mjs` → `public/index.html`) are rebuilt on one design system —
  the `forge dash` eight-color warm-ink/ember palette, a strict 4px spacing base, three
  radius levels, one shadow — and both now pass `forge uicheck design` **and** the
  rendered `forge uicheck visual` gate (the old pages failed with 15–19 accumulated
  colors and 5–9 radius levels; a project fingerprint claim is minted so conformance is
  checked too). Scroll-reveal is JS-gated progressive enhancement (no-JS UAs, crawlers,
  and reduced-motion users see the full page), and the Pages workflow (`static.yml`) now
  builds and deploys an assembled `_site/` — landing at the site root, status page at
  `/status/` — instead of uploading the entire repository as the artifact.

## [0.6.0] - 2026-07-07

### Changed

- Docs consolidation pass: deduplicated cross-doc prose into single canonical homes
  (the substrate README now points at the GUIDE's command reference, output table, and
  honest-limits list instead of repeating them), added orientation diagrams
  (ARCHITECTURE four-layer compiler + ledger, substrate-v2 phase graph with all phases
  marked shipped, the GUIDE daily loop), brought the ROADMAP current, and refreshed the
  model-facing skills/crew guidance for the v0.5.0 surface (`forge context`,
  `forge imagine --run`, `forge diagnose`, `forge ledger blame`, `forge cost --stages`,
  `forge uicheck design --taste`) without growing the skills' context payload.

## [0.5.0] - 2026-07-07

### Added

- Security & OSS hardening: CodeQL, gitleaks secret-scan (blocking; verified clean on the
  full history), and OSSF Scorecard workflows; refreshed repo topics; SECURITY.md now
  states the supported line (0.5.x) and documents the ledger's forgery-resistance
  properties (content-hash verification; oracle weights never trusted from records).
- **UI fingerprints resolve CSS `var()` indirection**, so design systems declared as
  custom properties fingerprint fully (the dashboard now reads as a 6-value 4px scale
  with two radius levels instead of one lonely spacing value), and the five taste
  profiles gain machine-readable constraint JSONs (`global/taste/<name>.json`) wired
  into `forge uicheck design --taste <name>` — with auto-pickup from a
  `forge taste`-managed DESIGN.md. Prose steers generation; the JSON is what the gate
  checks.
- **One-click release automation.** `scripts/bump.mjs` (node stdlib only, unit-tested)
  bumps every version field in one shot — `package.json`, `package-lock.json`, both
  plugin manifests, `CITATION.cff`, the landing page — rotates the CHANGELOG
  `[Unreleased]` section under a dated heading, and prints the new version;
  `npm run bump -- <patch|minor|major|auto>` (auto = conventional commits since the last
  tag: BREAKING → major, feat → minor, else patch). The new `bump.yml` workflow makes a
  release one click from the Actions tab (commit + tag + dispatch of `release.yml`);
  `release.yml` now soft-skips npm publish when `NPM_TOKEN` is missing instead of
  failing, and CI gained a version-drift guard (`node scripts/bump.mjs check`).
- **Benchmark harness (`npm run bench`) + measured results doc.** `bench/bench.mjs`
  (node stdlib only) measures the substrate primitives as medians of N runs after
  warmup — atlas build/incremental/impact latency on this repo, ledger
  mint+put/loadClaims/mergeDirs/val() on seeded synthetic fixtures, reuse fingerprint +
  exact/near-LSH lookup at 100 and 1000 artifacts, `assemble()` and full
  `substrateCheck` wall time — and writes the tables plus an environment block into
  `reports/benchmarks.md`. The same run scores `impact()` precision/recall/F1 against a
  committed, hand-labeled case set from this repo's real import graph
  (`bench/impact_cases.mjs`, every reference cited; one known-miss alias case kept in on
  purpose), reported next to — never blended with — the paper prototype's
  mutation-derived numbers, plus a structural-only contrast with adjacent tools (note
  stores, LLM gateways, plain RAG), every row checkable from the named source.
- **Loop closure (P5 of the substrate-v2 plan): doom-loop diagnosis, imagination, CUSUM
  drift, checkpoint cadence.** `forge diagnose "<error>"` hashes each failure into a
  signature (line numbers, addresses, timestamps, and absolute paths normalized out) and
  counts recurrences in a 50-entry ring; the 3rd identical hit is thrash — it mints a
  content-addressed `diagnosis` claim into the team ledger and tells the agent to STOP
  retrying and escalate ONE model tier with the diagnosis as the prompt's head (the same
  loop becomes a one-per-team event, not one-per-session). `forge imagine "<task>"` is the
  static half of the consequence simulator (paper Eq. 4): entities → blast radius →
  predicted breaks with confidence, plus the minimal dry-run test suite via weighted greedy
  set cover (weight = file size as a duration proxy; classic ln-n approximation) and
  `riskScore = Σ confidence`. **`forge imagine --run` executes that minimal suite in a
  sandboxed ephemeral git worktree** (HEAD-only — refused on a dirty tree unless
  `--allow-dirty`), parses the TAP summary into per-file verdicts, always removes the
  worktree (verified in a finally), and meters the run (`stage: "imagine"`); on this repo
  the 8-test selected suite measured 1.3 s where the full suite takes ~60 s.
  `anchor.cusum()` adds the M4 one-sided CUSUM control chart (k = 0.35,
  h = 1.0): sustained small drift alarms, a single exploratory spike drains back to zero.
  `verify.checkpointCadence()` prices M6's "when to check?" as the optimal-stopping
  threshold rule `n* = ⌈checkCost / (pErr·tokensPerStep·costPerToken)⌉`, clamped to
  [1, 50] — every input measured or priced, no magic constants.

- **Context assembly + completeness gate (P4 of the substrate-v2 plan).** `forge context
"<task>"` makes what goes into the window a budgeted optimization and makes
  _sufficiency_ a computed set. The required-knowledge set `R(edit)` — the target's
  definitions, its hop-1 dependents from the atlas, sibling tests, and team lessons
  trusted past val ≥ 0.8 — is derived, then covered by pinned items with a **compression
  ladder** (full → head → pointer): a tight budget downgrades granularity instead of
  silently dropping coverage. Optional items (trusted facts) fill remaining budget
  greedily with per-source diminishing returns. `missing = R \ covered` becomes derived
  clarifying questions ("the task names `X` but the repo doesn't define it — which file
  implements it?"), shown in `forge substrate` and — under `FORGE_ENFORCE=1` — blocking:
  acting on missing context is acting on a guess. Incomplete context stops being a
  feeling and starts being a set difference.
- **Generated-UI quality gate (P6 of the substrate-v2 plan).** Taste becomes measurable:
  `src/uifingerprint.js` extracts a deterministic design fingerprint from CSS/JSX/Tailwind
  classes — pure static parsing, no LLM, no screenshots — covering palette (HSL + 12-bin hue
  histogram), spacing (base unit by residual-minimization approximate GCD, on-scale
  fraction), font families, radius and shadow levels. Two distances gate generated UI:
  `slopDistance` to a shipped, rationale-documented generic-template signature set
  (default-Tailwind blue/indigo, stock Bootstrap, the AI-landing gradient) must stay HIGH,
  and `conformance` to the project's own fingerprint — stored as a shared `fingerprint`
  ledger claim via `mintProjectFingerprint` — must stay LOW; `uiGate` failures are
  actionable per-feature edits, never a bare score. Scale-conformance checks
  (spacing-on-base, radius/shadow level caps, palette bound) join `ASSERTABLE_CHECKS`.
  `forge uicheck` gains `fingerprint <file...> [--mint]` and `design <file...>` (exit 1 on
  fail) alongside the unchanged contrast math.
- **Local dashboard (P7 of the substrate-v2 plan).** `forge dash [--port N]` serves a
  read-only lens on the substrate's state: a `node:http` stdlib server (localhost-only,
  zero runtime deps) with ONE self-contained HTML page — inline CSS/JS, no CDN, no
  framework, no build step. Panels: Ledger (claims with val bars, kind filter, contested
  claims — val ∈ [0.4, 0.6] with ≥1 contradiction — and per-author trust), Cost/Cache
  (stage counters + measured saved-token estimates from `.forge/metrics.jsonl`), and
  Impact (atlas blast-radius explorer via `/api/impact?target=X`). Every claim row shows
  its `forge ledger blame <id>` command — no unexplained scores anywhere in the UI. Data
  is separated from serving (`dashData()` vs `serve()` in `src/dash.js`) so the payload
  is tested without sockets, and corrupt/missing stores degrade to empty sections instead
  of taking down the lens. The ratify/retract POSTs are a follow-up; this phase never
  writes.
- **Measured cost report (P8 of the substrate-v2 plan).** `forge cost --stages [--json]`
  computes per-stage cost factors as pure arithmetic over `.forge/metrics.jsonl`
  (`src/cost_report.js`): gate halt rate, tier-weighted cache hit rate (exact 1.0 / near
  0.85 / adapt 0.5), route saving priced against the always-premium baseline, and context
  assembly — then composes `C = C₀ · Π(1 − fᵢ)` over ONLY the measured stages. A stage with
  no events reports "no data", never a default; the composed figure is a lower bound whose
  caveats name every unmeasured stage; the paper's 62 % routing figure is cited as context,
  and ~90 % appears only as a labeled target. `substrateCheck` now meters the assumption
  gate on the explicit path (one `gate` halt/pass line per decision; ambient hooks stay
  write-free), `recordGate`/`recordRoute` give future stage wiring one obvious call each,
  and `reports/cost-eval.md` scaffolds the paired-run harness report with a truthful
  empty state.

- **Proof-carrying reuse cache (P3 of the substrate-v2 plan).** `forge reuse` turns
  "reuse already-generated code" from prose into a deterministic system: verified code
  becomes an `artifact` claim keyed by a normalized task fingerprint (volatile literals →
  typed placeholders; MinHash sketch + 16×8 LSH banding for near-match), looked up through
  the exact → near → adapt → miss ladder. An artifact serves ONLY while its proof holds —
  confidence above the 0.6 floor (an unverified mint sits at the 0.5 prior and does not
  serve) and every declared dependency still resolving in the atlas; a failed revalidation
  appends a `graph.reval` contradiction, so stale code demotes itself for the whole team.
  `forge reuse query|mint|stats`, a reuse stage in `forge substrate` (read-only on the
  ambient hook path), and `src/metrics.js` — the stage-tagged `.forge/metrics.jsonl` the
  cost model's measured savings are computed from. The `reuse-first` skill now calls the
  cache before advising a repo search.

- **Team memory (P2 of the substrate-v2 plan).** The PCM ledger becomes shared:
  `forge ledger merge <path>` performs the conflict-free semilattice merge of any other
  ledger tree (a teammate's checkout, a worktree, a backup) — identical knowledge minted
  independently converges to one claim with every author preserved in its provenance log.
  `forge ledger blame <id>` is the accountability view (every mint, every oracle outcome,
  every retraction, per-author trust). `forge ledger query "<text>"` ranks live claims by
  the paper's Eq. 3. Every claim, evidence record, and tombstone now carries the git
  identity (`FORGE_AUTHOR` override; cached; best-effort). **Per-author trust**
  `u(author) ∈ [0.5, 1]` is computed from the oracle track record of the claims an author
  minted — smoothed to 1.0 for new teammates, floored at 0.5, self-confirmation excluded —
  and optionally weights `val()`. `forge doctor` now checks the union-merge driver is
  present (a populated ledger without it WILL conflict) and the ledger's normal form.

### Fixed

- **PCM ledger hardened after an 8-angle adversarial review of the P1 merge.** The
  conflict-free-merge guarantee is now structural: claim file bytes are a pure function of
  (kind, body, scope) — byte-identical on every replica — while provenance and tombstones
  move into per-claim append-only logs (hash-deduped, union-merged like evidence), so
  concurrent mints and concurrent retractions can never produce a git conflict or a
  merge-order-dependent state. Forged evidence is now powerless AND detectable: `val()`
  takes oracle weights from the ORACLES table (never the stored record) and skips unknown
  oracles, while `forge ledger verify` recomputes every record's content hash and flags
  mismatches, ghost oracles, and inflated weights. `forge ledger import` is truly
  idempotent (claims already tracked live are never re-synthesized — no double counting).
  Cortex shadow-writes: distillation now supersedes (evidence carried over, template claim
  tombstoned); evidence refs carry the confirmation counter so same-day sessions with
  colliding episode ids stay distinct; regex-detected reverts contradict at the
  conservative bridge weight instead of the full-weight human oracle. Fact claims: one
  CRLF-tolerant parser (`recall.readFact`), trimmed bodies (shadow path and import path
  mint one id), same-name updates supersede the stale claim, and `forge recall
consolidate` reconciles deletions into tombstones. `putClaim` repairs corrupt/truncated
  claim files instead of trusting `existsSync`. `forge ledger --personal` reaches the
  personal ledger (previously write-only); `forge ledger show` resolves by shard instead
  of scanning; `forge init` emits the union-merge `.gitattributes` rule into consumer
  repos. `SCOPE_WEIGHT` has one home (ledger core; lessons re-exports).

### Documentation

- **Substrate v2 plan: the whitepaper, completed (`docs/plans/substrate-v2/`).** Nine specs
  - two ADRs mapping every remaining paper faculty/mechanism to a concrete algorithm, unified
    by the **Proof-Carrying Memory (PCM) protocol**: every stored unit (lesson, fact, cached
    artifact, graph edge, design fingerprint, diagnosis) becomes a content-addressed claim whose
    confidence is a decayed Beta posterior over independent-oracle outcomes — retrieval implements
    the paper's Eq. 3, team memory is a conflict-free CRDT ledger merged over git, code reuse is a
    proof-carrying artifact cache, context assembly is a token-budget knapsack with a set-cover
    completeness gate, and generated-UI quality is a measurable slop-distance/conformance gate.
    ADR-0005 relaxes the zero-dependency rule to selective optional deps with stdlib fallbacks;
    ADR-0006 converges all persistence on the PCM ledger. `ROADMAP.md` now carries the P1–P8
    phase plan. Docs only — no runtime behavior changes.
- **Visual flow diagrams in the entry-point docs.** A "one source → every tool + pre-action gate"
  mermaid in `README.md` and a "your day with Forge" loop in `ONBOARDING.md` (alongside the
  propose→verify diagram in the substrate README) — making the model easier to grasp at a glance,
  while preserving the docs' existing dry-precise voice.

### Added

- **Proof-Carrying Memory ledger (P1 of the substrate-v2 plan).** `src/ledger.js` — the
  pure PCM core (ADR-0006): content-addressed claims over canonical JSON, an oracle
  taxonomy in which only independent signals (tests, CI, human accept/revert) may move
  confidence, a time-decayed Beta-posterior `val` that decays toward _uncertainty_ (never
  toward false), the paper's Eq. 3 retrieval score, dependency-free MinHash similarity +
  union-find consolidation clustering, and a join-semilattice merge (property-tested:
  commutative, associative, idempotent — teammate ledgers converge in any order).
  `src/ledger_store.js` — the git-native on-disk ledger (`.forge/ledger/`): one immutable
  file per claim sharded by id, append-only hash-deduped evidence logs (union-merge safe,
  see `.gitattributes`), tombstones, attic, `LEDGER.md` index, and a CI-friendly
  normal-form `verify`. `forge ledger stats|verify|show|import` CLI. The legacy stores
  stay the read path in P1: cortex shadow-writes every lesson event (create/confirm/
  human-revert contradiction) into the ledger, `forge remember` / `forge recall add`
  shadow facts, and `forge ledger import` back-fills history idempotently
  (`src/ledger_bridge.js`). Secret-refusal now lives in the ledger core so no claim kind
  can store a credential (re-exported from `recall.js` for compatibility).
- **Uniform `--json`.** `doctor`, `route`, `preflight`, `verify`, and `scope` now accept `--json`
  (previously only `impact`/`substrate`/`anchor` did) — so CI and scripts can gate on the health
  check, the routed tier, the assumption gap, and the verification result.
- **`forge doctor` sees more silent misconfiguration.** New checks: guard scripts present **and
  executable**, `jq`/`git` availability (several guards degrade without `jq`), atlas
  **presence + freshness** (a stale graph misleads impact/verify), and **model-pricing staleness**
  (warns when the verified date is >90 days old).
- **Evaluation harness (`src/eval.js`).** The deterministic core of the prototype's mutation-testing
  idea: score the impact oracle's precision/recall/F1 over labeled cases and against the
  edited-file-only baseline the paper measured against — so the graph-quality claim is checkable in CI.

### Changed

- **Model tiers carry a currency + a verified date.** `model_tiers.js` exports `PRICING_CURRENCY`
  ("USD") and `PRICING_VERIFIED`, which `forge doctor` uses for the staleness warning.
- **One shared call-site extractor (`src/extract.js`).** `atlas.js` and `verify.js` each kept their
  own copy of the call regex + builtins ignore-list; they now share one module so the two can't
  drift apart.

- **Opt-in enforcing gate (`FORGE_ENFORCE=1`).** The substrate's assumption gate can now be a real
  _halt_ (the paper's Eq 5 / M2 "block on insufficient input"), not just advice. On the Claude Code
  ambient path it blocks a prompt with **no concrete anchor at all** ("fix it", "make it better") —
  or an action into a very large predicted blast radius — and returns the clarifying questions.
  Deliberately low-false-positive: a specified task is never blocked, and it's **off by default**
  (`enforceDecision()` in `src/substrate.js`).
- **M5 anti-over-engineering is now measured, not guessed (`forge lean`).** The paper's
  `φ(y) − φ*(x)` check replaces the old three-keyword stub: `src/lean.js` reads the working diff
  and flags the footprint beyond what the task asked for — new abstractions the task never named,
  a large diff for a short ask, files touched beyond the stated scope. Folded into
  `forge substrate` (a `minimality.footprint` field) and available standalone as `forge lean "<task>"`.
- **Doom-loop breaker (self-correction).** Complements the shell guard (which catches the _same
  action_ repeated) by catching the subtler loop the paper names — _different edits that keep
  producing the same test failure_. `cortex_hook` now captures a normalized signature of failing
  test output; `detectDoomLoop` fires when one signature recurs past a threshold, and the
  pre-edit hook surfaces a "stop and find the root cause" advisory with the diagnosis.
- **Consequence simulation — failing-tests class (Eq 4).** `forge substrate` now predicts the
  tests likely to break _before_ an edit (`impact.predictedTests`): the impacted files that are
  tests, plus each impacted source file's sibling test — surfaced so you run the narrowest
  affected tests first, not after the fact.

### Changed

- **`forge sync` now adopts an existing project `CLAUDE.md` instead of skipping it.** Previously a
  repo with its own `CLAUDE.md` was left untouched — which meant Forge's shared rules never
  reached Claude Code there. Sync now prepends the one-line `@AGENTS.md` import (idempotent,
  every original line preserved) and reports `adopted`. `AGENTS.md` keeps its back-up-then-write
  behaviour; your skills and other tool files are untouched.

### Fixed

- **The Cortex capture/learn loop now works in the dotfile install too.** `global/settings.template.json`
  wired only `cortex.sh preflight` (1 of 6 modes), so dotfile users got the substrate advisory but
  **never captured events or distilled lessons** — the learning loop was dead for them while plugin
  users had it. The template now wires all six modes (`session-start`, `prompt`, `preflight`,
  `pre-edit`, `capture`, `stop`), matching `hooks/hooks.json`.
- **`forge verify` can't hang.** `runTests` now bounds the test run with a timeout
  (`FORGE_VERIFY_TIMEOUT_MS`, default 10 min); a timeout is reported honestly as "did not complete",
  never as a pass.
- **Secret-refusal no longer guts auth-related work.** `SECRET_RE` matched the bare words
  `secret`/`password`/`api key`, so any task or lesson merely mentioning them was silently
  refused — disabling the LLM proposer (`adjudicate`) and blocking memory persistence
  (`recall`/`lessons`) for exactly the high-risk code you most want help on. The word arm now
  requires a value-shaped assignment (`password = "…"`, `SECRET_KEY: …`); credential _formats_
  (`sk-…`, `ghp_…`, JWTs, …) are still refused.
- **One malformed file no longer takes down memory.** `lessons_store.load`/`readEpisodes` and
  `cortex_hook.readSession` now skip a corrupt lesson file / JSONL line instead of throwing
  (which previously broke retrieval, routing, and the pre-edit advisory everywhere `load` is used).
- **`recordMistake` reports `refused` (not `created`) when a save is rejected**, so the Stop hook
  never tries to distill a phantom lesson; `applyDistillation`/`recordContradiction` surface the
  real write result too.
- **Atlas emits `inherits` edges** (`class X extends Y`; Python `class X(Base)`) — the weight was
  defined but never produced, so base-class changes were invisible to blast-radius.
- **Atlas is incremental + staleness-aware.** `build()` reuses per-file extraction by content
  hash (a sidecar cache) instead of re-parsing the whole repo; `isStale()` lets `verify` rebuild
  when the cached graph is out of date (post-edit hallucination detection was running on a stale
  atlas). A capped graph now degrades to "uncertain" rather than raising false "unknown symbol".
- **Performance:** `resolveEdges` is O(E) (was O(E·N) — a full node scan per edge); `impact()`
  reuses one memoized reverse-adjacency map across the up-to-8 calls per `substrate` run.
- **`substrate` no longer recomputes preflight twice** (or fires a redundant assumption model
  call): the gap is computed once and threaded into routing.

### Added

- **Opt-in LLM adjudication for the substrate (`FORGE_LLM=1`)** — one shared, fail-safe `claude -p` proposer (`src/adjudicate.js`) wired thinly into the assumption gate (M2), model routing (M1), impact/blast-radius, and goal-drift (M4). The model only _proposes_; every proposal is verified against the deterministic rubric, the code graph, or a grep before it can move a verdict. Off by default — behaviour is unchanged unless enabled — never blocks, and the ambient Claude Code hook stays deterministic unless `FORGE_LLM_AMBIENT=1`. `forge substrate --json` carries an `llm.provenance` map per faculty for auditability.
- **Bidirectional verified reconcile (default on when `FORGE_LLM=1`; `llm.bidirectional` in `source/substrate.json` to disable).** A verified reading may now _reduce_ caution as well as add it — clear a false "ASK FIRST" (`llm-cleared`) and route a task _down_ a tier (`llm-lowered`) — but only within `band` and never past the hard floors: the gate can't clear a task with no concrete anchor or one naming symbols/files the repo lacks, and routing can't drop below a strong-signal (algorithmic/architectural) floor. Set `llm.bidirectional: false` for the conservative tighten-/raise-only mode. Impact edges stay graph-+-grep-verified; goal-drift stays off→on with a goal-referencing reason.
- **Explicit memory `val` term** — lesson retrieval now decomposes into the white paper's `relevance × freshness × validity × scope`, with `validity()` (a ground-truth Beta posterior over confirmed vs. contradicted outcomes) exported and ranked so outcome-confirmed lessons outrank merely-recent ones.

### Changed

- **Unified the model-call path** — the Cortex distiller now shares the `adjudicate` runner instead of its own `claude` shell-out.

## [0.4.0] - 2026-07-06

### Added

- **Forge Cognitive Substrate** — one pre-action command (`forge substrate`) plus an MCP surface (`substrate_check`, `predict_impact`, `assumption_gate`, `route_task`, `scope_files`): assumption gate, transparent model routing, impact/blast-radius, scope decomposition, Cortex lessons, minimality, and a verification checklist.
- **M4 goal-anchoring (`forge anchor`)** — a deterministic goal-drift check that flags changed files off the stated goal. All 11 white-paper capabilities now ship a real mechanism.
- **Atlas v2 graph** — dependency nodes/edges + reverse-dependency impact traversal (the symbol-query API is preserved).
- **`docs/GUIDE.md`** (the complete command guide) and **`docs/RELEASING.md`** (release runbook).
- **Repo automation** — `repo-settings.yml` (About/topics/Discussions as code) and `labels.yml` (label sync) workflows; a Codex plugin manifest and `cognitive-substrate` skill; the paper bundle under `docs/cognitive-substrate/`.

### Changed

- **Publish to public npm.** `@codewithjuber/forgekit` now publishes to npmjs with provenance, so `npm install -g @codewithjuber/forgekit` needs no token (replacing the GitHub Packages route, which required auth even for public installs). The release workflow was fixed to trigger on a tag, publish, and cut a GitHub Release with generated notes.
- **Substrate auto-runs in Claude Code** via a `UserPromptSubmit` hook — it surfaces only when something needs attention and never blocks — and `forge init` emits a "run substrate before risky work" rule into every other tool's config.
- **Docs overhaul** — README rewritten (problem → solution → how, npm-first, SEO-friendly); the install, honest-limits, frozen-model, and substrate blocks are single-sourced instead of copied across files; the supported-tool list is reconciled everywhere.

### Fixed

- **Security (research prototype):** removed the pickle-based cache in `impact_oracle/world_model.py` — an insecure-deserialization (RCE) vector on a caller-supplied `cache_dir`. Now JSON node-link only, with `cache_dir` contained inside `root`.
- **Smaller npm package** — stopped publishing the ~2 MB paper bundle and the redundant `*_src.zip` (source lives unzipped under `research/`).
- **Perf** — `substrateCheck` no longer recomputes the assumption assessment.

## [0.3.1] - 2026-07-05

### Changed

- **Publish to GitHub Packages** instead of npmjs. Package renamed to the scoped
  `@codewithjuber/forgekit`; `publishConfig.registry` → `https://npm.pkg.github.com`. The
  release workflow now authenticates with the built-in `GITHUB_TOKEN` (`packages: write`) — no
  external `NPM_TOKEN` secret. A committed `.npmrc` maps the scope to the registry and sets
  `min-release-age=7` (supply-chain cooldown). Note: GitHub Packages requires consumers to
  authenticate even for public installs, so the `bash install.sh` clone path stays the
  friction-free primary channel.

## [0.3.0] - 2026-07-05

### Added

- **Forge Preflight** — a deterministic, math-first layer that runs BEFORE tokens are spent,
  on the premise that an LLM is a fixed-capacity stochastic predictor: size the task to the
  model, fill the context, detect assumptions. All advisory, never blocks.
  - **Assumption detector** (`forge preflight`, UserPromptSubmit hook): scans a task for code
    identifiers/files the repo doesn't define — what the model would otherwise ASSUME — and
    surfaces the known-unknowns so it asks instead of confabulating. The research whitespace.
  - **Complexity routing** (`forge route`): recommends the cheapest CAPABLE model
    (Haiku → Sonnet → Opus → Fable) from code-task signals (files, fan-out, churn, past-mistake
    density, ambiguity). `forge route gateway` emits a LiteLLM config for real auto-routing.
  - **Decomposition** (`forge scope`): a zero-dep import graph → connected components →
    independent clusters (run as separate sessions) + the coupled files you didn't name.
  - **Design-quality**: emitted AI-UX rules (anti-slop, WCAG, functional empty states, specific
    errors, confidence/transparency, pattern selection) + `forge uicheck` (exact WCAG contrast
    math) + a calibrated frontend-verifier that ASSERTS only the deterministic and keeps
    hierarchy/taste ADVISORY (the fix for hallucinated UI audits).
  - Cross-tool via `preflight_check` / `route_task` / `scope_files` MCP tools.

## [0.2.0] - 2026-07-05

### Added

- **Forge Cortex** — self-correcting project memory. Detects a genuine recurring mistake
  on this repo (test-fail→fix, revert, symbol thrash, explicit human undo), distills a
  structured lesson, and re-confirms it against independent outcomes — with an
  anti-self-reinforcement lifecycle (`Beta` confidence + decay; injection never confirms;
  a green build always wins) so a wrong lesson decays out instead of ossifying.
  `forge cortex`, `forge cortex why <symbol>`.
- Ambient hooks (fail-safe, never block): capture signals during a session, distill at
  `Stop`, inject learned lessons at `SessionStart`, and a `PreToolUse` advisory before a
  risky edit.
- Local error predictor (heuristic + a tiny logistic model) gated by an AUC-PR kill-switch
  — it only ships if it measurably beats the heuristic; otherwise it falls back or disables.
- Cross-tool: lessons inlined into `AGENTS.md` + a zero-dependency MCP server
  (`forge cortex-mcp`, registered in `source/mcp.json`).
- Optional LLM lesson distiller (`ENABLE_CORTEX_DISTILL=1`) — replaces the deterministic
  template with a real distilled lesson via `claude -p`.
- `forge doctor` reports Cortex lesson state; `forge catalog` lists Cortex.

## [0.1.0] - 2026-07-05

### Added

- Cross-tool config emitter (`forge sync`) — one source → each tool's native format; three
  install channels (Claude plugin + marketplace, installer, npm); `forge doctor`; code-graph
  (`atlas`); `lean` discipline; guard/skill/crew layers.
- Verification layer: `forge verify` (tests + hallucinated-symbol catch + provenance),
  doom-loop breaker guard, bias-safe `independent-reviewer` agent.
- Security gate: `forge scan` (skill-gate), `secret-redact` guard, structured
  `permissionDecision` in `protect-paths`, `forge harden` (gitleaks + sandbox).
- Cross-tool MCP emit; portable memory (`forge brain` / `forge remember`); design-taste
  menu (`forge taste`); `forge spec` spec-lock + OpenSpec wiring; MCP ~6-server hygiene
  check; coverage + type-checking (`tsc --checkJs`); 2026 production-standard rules;
  OWASP-LLM / NIST SSDF / SLSA control mapping.

[Unreleased]: https://github.com/CodeWithJuber/forgekit/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.4...v0.13.0
[0.12.4]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.3...v0.12.4
[0.12.3]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodeWithJuber/forgekit/releases/tag/v0.1.0
