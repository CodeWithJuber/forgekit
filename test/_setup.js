// The suite's hermetic boundary. Preloaded into EVERY test process via
// `node --test --import ./test/_setup.js`, so it runs before any test module body.
//
// Three ambient things made this suite non-hermetic — CI green, developer machine red:
//   1. Exported FORGE_*/provider env. An exported FORGE_LLM=1 flipped the assertion at
//      test/substrate.test.js:105 AND made that file fire real model calls: 552s vs <1s.
//   2. The real $HOME. src reads ~/.forge (src/doctor.js:374), ~/.claude/settings.json
//      (src/doctor.js:93), ~/.claude/projects (src/cost_report.js:219) and
//      ~/.local/state/forgekit (src/recall.js:22); git reads ~/.gitconfig.
//   3. A real `claude` binary on PATH, which src/adjudicate.js shells out to.
//
// A test that needs one of these BACK just sets it in its own file's top-level body:
// node --test gives every FILE its own process, so a per-file assignment runs after this
// and wins. That is already the convention at test/doctor.test.js:20 and
// test/recall.test.js:11 — no opt-in machinery required.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A PREFIX DENYLIST, not an allowlist. An allowlist would have to enumerate everything git,
// node, bash and Windows need (SYSTEMROOT, PATHEXT, COMSPEC, SSH_AUTH_SOCK, TMP...) and rots
// on contact — and this suite spawns git/node/bash/npx and runs on windows-latest. The
// prefix rule is a superset of src/docs_check.js envVarsRead(): it also covers provider keys
// forge does not read yet, and any FORGE_NEWTHING added next week, with zero edits. That
// zero-maintenance property is the point; test/hermetic.test.js pins it against
// envVarsRead() so the two can never drift.
const SCRUB =
  /^(_?FORGE_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|GOOGLE_|LITELLM_|ENABLE_CORTEX_|TYPESAFE_|XDG_)/;
// Not prefix-matchable. FORCE_COLOR is the dangerous one: it OUTRANKS NO_COLOR in
// src/fmt.js supportsColor(), so an exported FORCE_COLOR=1 defeats the explicit NO_COLOR=1
// that test/radar.test.js passes to its spawned CLI.
const SCRUB_EXACT = ["CLAUDECODE", "FORCE_COLOR", "NO_COLOR", "COLORTERM"];

for (const key of Object.keys(process.env)) if (SCRUB.test(key)) delete process.env[key];
for (const key of SCRUB_EXACT) delete process.env[key];

// An empty home, not a missing one. os.homedir() honours $HOME (POSIX) / $USERPROFILE
// (Windows) and is not cached, so every ~/.forge, ~/.claude and ~/.gitconfig read lands in
// throwaway space. This is also what makes `git init` deterministic: no inherited
// init.defaultBranch, and no commit.gpgsign, which would otherwise block the suite on a
// passphrase prompt.
const home = mkdtempSync(join(tmpdir(), "forge-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// The last uninjected model call. Faculties that build their own runner (src/substrate.js,
// src/route.js, src/anchor.js, src/preflight.js) reach the real `claude` binary when it is
// on PATH. FORGE_LLM_HTTP=1 forces src/adjudicate.js down the HTTP branch instead, where the
// now-keyless provider resolution returns null and the runner throws synchronously — the
// exact fail-safe path CI already takes. No subprocess, no socket, no timeout.
process.env.FORGE_LLM_HTTP = "1";
