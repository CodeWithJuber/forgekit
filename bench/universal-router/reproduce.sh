#!/bin/sh
# Reproduce data/router_prior.json from pinned public data, on a cold machine.
#
#   sh bench/universal-router/reproduce.sh [WORK_DIR]
#
# Needs network access (Hugging Face, raw.githubusercontent.com, PyPI), python3 >= 3.10 with
# the venv module, and node >= 20. Everything goes under WORK_DIR (default:
# ${TMPDIR:-/tmp}/forgekit-router-repro), outside the repository: the downloaded per-task
# results are not redistributed here and must not be committed.
#
#   1. a venv with the pinned pyarrow (requirements.txt)
#   2. build_input.py: download + sha256-check the sources pinned in sources.json and write
#      WORK_DIR/universal_all.json (a second run reads WORK_DIR/cache instead of downloading)
#   3. fit_prior.mjs: refit the prior into WORK_DIR/router_prior.json (several minutes of CPU).
#      WORK_DIR/environment.txt records the versions, the CPU, the fit time, and which code the
#      fit ran: the git HEAD and any uncommitted change to src/router, src/route.js or
#      data/models.json.
#   4. compare_priors.mjs: compare it with data/router_prior.json; the report is
#      WORK_DIR/prior-comparison.json
#
# Exit status: 0 when the refit reproduces every value of the shipped prior (except
# provenance.fittedAt; values only in the refit, such as provenance.build, are listed in the
# report as added); 1 when any value differs or is missing; anything else is an error in 1-3.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=${1:-${TMPDIR:-/tmp}/forgekit-router-repro}
mkdir -p "$work"
work=$(cd "$work" && pwd)

echo "== 1/4 python venv with the pinned pyarrow ($work/venv)"
[ -d "$work/venv" ] || python3 -m venv "$work/venv"
py="$work/venv/bin/python"
[ -x "$py" ] || py="$work/venv/Scripts/python.exe"
"$py" -m pip install --quiet --disable-pip-version-check -r "$here/requirements.txt"

echo "== 2/4 build the fitting input"
"$py" "$here/build_input.py" --cache "$work/cache" --out "$work/universal_all.json"

echo "== 3/4 refit the prior (this takes minutes; about 7 on a 2.8 GHz Xeon)"
# The code the fit loads, recorded just before it starts.
head=unknown
changes="unknown (not a git checkout)"
if git -C "$root" rev-parse --verify -q HEAD > /dev/null 2>&1; then
  head=$(git -C "$root" rev-parse HEAD)
  changes=$(git -C "$root" diff --stat HEAD -- src/router src/route.js data/models.json)
  changes=${changes:-none}
fi
start=$(date +%s)
node "$here/fit_prior.mjs" "$work/universal_all.json" --out "$work/router_prior.json"
elapsed=$(($(date +%s) - start))

{
  echo "node: $(node --version)"
  echo "python: $("$py" --version 2>&1)"
  echo "pyarrow: $("$py" -c 'import pyarrow; print(pyarrow.__version__)')"
  echo "cpu: $(node -p 'const c = require("os").cpus(); `${c[0]?.model} x${c.length}`')"
  echo "platform: $(node -p 'process.platform + "-" + process.arch')"
  echo "fit_elapsed_seconds: $elapsed"
  echo "repo_head: $head"
  echo "uncommitted changes to src/router, src/route.js, data/models.json:"
  echo "$changes"
} > "$work/environment.txt"
cat "$work/environment.txt"

echo "== 4/4 compare with data/router_prior.json"
status=0
node "$here/compare_priors.mjs" "$root/data/router_prior.json" "$work/router_prior.json" \
  > "$work/prior-comparison.json" || status=$?
echo "report: $work/prior-comparison.json"
exit "$status"
