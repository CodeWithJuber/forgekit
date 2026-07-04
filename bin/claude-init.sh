#!/usr/bin/env bash
# claude-init — scaffold per-repo AI config in the CURRENT directory.
# Auto-detects stack + commands and writes a shared AGENTS.md (read by
# Claude/Cursor/Codex/Gemini) + a thin CLAUDE.md that references it.
# Idempotent: won't overwrite existing files unless --force.
set -uo pipefail

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
root="$PWD"
name="$(basename "$root")"

# --- detect package manager + scripts (Node) ---
pm=""; dev=""; build=""; test=""; lint=""; typecheck=""; fw=""; ts=""
if [ -f package.json ]; then
  [ -f pnpm-lock.yaml ] && pm=pnpm; [ -f yarn.lock ] && pm=yarn
  [ -f package-lock.json ] && pm=npm; [ -f bun.lockb ] && pm=bun
  [ -z "$pm" ] && pm=npm
  read -r dev build test lint typecheck fw ts < <(node -e '
    const p=require("./package.json"); const s=p.scripts||{}; const d={...p.dependencies,...p.devDependencies};
    const has=k=>s[k]?k:"-";
    const fw = d.next?"Next.js":d.astro?"Astro":d.nuxt?"Nuxt":d["@remix-run/react"]?"Remix":d.svelte?"Svelte":d.vue?"Vue":d.react?"React":d.express?"Express/Node":"Node";
    const ts = (d.typescript||require("fs").existsSync("tsconfig.json"))?"TypeScript":"JavaScript";
    console.log([has("dev"),has("build"),has("test"),has("lint"),has("typecheck")||has("type-check"),fw,ts].join(" "));
  ' 2>/dev/null || echo "- - - - - Node JavaScript")
fi

# --- detect python / db / infra ---
py=""; [ -f pyproject.toml ] && py="uv (pyproject.toml)"; [ -z "$py" ] && [ -f requirements.txt ] && py="pip (requirements.txt)"
db=""
[ -f prisma/schema.prisma ] && db="Prisma"
[ -f drizzle.config.ts ] || [ -f drizzle.config.js ] && db="${db:+$db, }Drizzle"
grep -riqE 'pgvector|postgres' docker-compose*.yml 2>/dev/null && db="${db:+$db, }Postgres"
infra=""; ls ./*.tf >/dev/null 2>&1 && infra="Terraform"
[ -f Dockerfile ] || ls docker-compose*.yml >/dev/null 2>&1 && infra="${infra:+$infra, }Docker"

pmr(){ [ -n "$pm" ] && [ "$1" != "-" ] && echo "\`$pm run $1\`" || echo "<add>"; }
stack="$( [ -n "$fw" ] && echo -n "$fw · $ts"; [ -n "$py" ] && echo -n " · Python ($py)"; [ -n "$db" ] && echo -n " · $db"; [ -n "$infra" ] && echo -n " · $infra")"
[ -z "$stack" ] && stack="<fill in: language, framework, DB, infra>"

write_agents(){
cat > AGENTS.md <<EOF
# AGENTS.md — $name

Cross-tool rules (Claude Code, Cursor, Codex, Gemini, Aider…). Keep thin.

## Stack
$stack

## Commands
- Install: \`${pm:-npm} ${pm:+install}${pm:-} \`
- Dev: $(pmr "${dev:--}")
- Test: $(pmr "${test:--}")
- Lint: $(pmr "${lint:--}")  ·  Typecheck: $(pmr "${typecheck:--}")
- Build: $(pmr "${build:--}")
$( [ -n "$py" ] && echo "- Python: \`uv run <cmd>\` · lint \`ruff check\` · test \`pytest\`" )
$( [ -n "$db" ] && echo "- DB migrate: <add migrate command>" )

## Rules
- Reuse existing components/utils before writing new; smallest change that works.
- Verify current best library from live sources before adding a dependency; prefer what's here.
- Wrap fallible async in try/catch; guard array/object access; explicit errors.
- UI: check mobile AND desktop; clear loading/empty/error states; follow DESIGN.md if present.
- Verify before "done": run tests/build/lint and show output; screenshot UI changes.
- Never commit secrets or .env*; never run destructive DB/FS commands without confirmation.

## References
- Visual rules: @DESIGN.md (if present)
EOF
}

write_claude(){
cat > CLAUDE.md <<EOF
# $name — Claude notes

Shared rules live in @AGENTS.md (stack, commands, engineering rules). Keep this
file thin — only Claude-specific or repo-specific bits Claude keeps getting wrong.

## Notes
- <add non-obvious gotchas, e.g. "run X before Y", env quirks>
EOF
}

made=""
if [ -f AGENTS.md ] && [ $FORCE -eq 0 ]; then echo "skip AGENTS.md (exists — use --force)"; else write_agents; made="$made AGENTS.md"; fi
if [ -f CLAUDE.md ] && [ $FORCE -eq 0 ]; then echo "skip CLAUDE.md (exists — use --force)"; else write_claude; made="$made CLAUDE.md"; fi

echo "✓ $name: detected [$stack]"
[ -n "$made" ] && echo "  wrote:$made" || echo "  nothing written (both existed)"
echo "  next: skim AGENTS.md, fill any <add>/<fill> spots, then: git add AGENTS.md CLAUDE.md"
echo "  optional: 'graphify install --project' + '/graphify .' to add a code graph"
