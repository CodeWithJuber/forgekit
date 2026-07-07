#!/usr/bin/env python3
"""Pre-flight scanner for code-modernizer skill.

Stdlib-only — nothing to install.

Usage:
    python3 scripts/preflight_scan.py <path> [--json]

Reports file count, total lines of code, detected dependency manifests,
and flags high-cost files (> 800 lines).
"""

import json
import os
import sys
from pathlib import Path

SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", "coverage", ".tox",
    "vendor", "target", "out", ".cache", ".turbo",
}

CODE_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".pyx",
    ".rs", ".go", ".java", ".kt", ".kts",
    ".c", ".cpp", ".cc", ".h", ".hpp",
    ".rb", ".php", ".swift", ".scala",
    ".vue", ".svelte", ".astro",
    ".css", ".scss", ".less",
    ".sql", ".sh", ".bash", ".zsh",
    ".lua", ".zig", ".nim", ".ex", ".exs",
    ".cs", ".fs",
}

MANIFEST_FILES = {
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile",
    "Cargo.toml", "go.mod", "Gemfile", "composer.json",
    "build.gradle", "build.gradle.kts", "pom.xml",
    "pubspec.yaml", "mix.exs",
}

HIGH_COST_THRESHOLD = 800


def count_lines(path: Path) -> int:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except (OSError, UnicodeDecodeError):
        return 0


def parse_dependencies(root: Path) -> list[str]:
    deps = []
    pkg = root / "package.json"
    if pkg.is_file():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
            for key in ("dependencies", "devDependencies"):
                if key in data:
                    deps.extend(data[key].keys())
        except (json.JSONDecodeError, OSError):
            pass

    req = root / "requirements.txt"
    if req.is_file():
        try:
            for line in req.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and not line.startswith("-"):
                    name = line.split("==")[0].split(">=")[0].split("<=")[0].split("[")[0].strip()
                    if name:
                        deps.append(name)
        except OSError:
            pass

    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            content = pyproject.read_text(encoding="utf-8")
            in_deps = False
            for line in content.splitlines():
                if line.strip().startswith("dependencies"):
                    in_deps = True
                    continue
                if in_deps:
                    if line.strip() == "]":
                        in_deps = False
                        continue
                    dep = line.strip().strip('",').split(">=")[0].split("==")[0].split("<")[0].strip()
                    if dep:
                        deps.append(dep)
        except OSError:
            pass

    return sorted(set(deps))


def scan(root: Path) -> dict:
    file_count = 0
    total_lines = 0
    high_cost_files = []
    manifests_found = []

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        for fname in filenames:
            fpath = Path(dirpath) / fname

            if fname in MANIFEST_FILES:
                manifests_found.append(str(fpath.relative_to(root)))

            if fpath.suffix.lower() in CODE_EXTENSIONS:
                file_count += 1
                lines = count_lines(fpath)
                total_lines += lines
                if lines > HIGH_COST_THRESHOLD:
                    high_cost_files.append({
                        "file": str(fpath.relative_to(root)),
                        "lines": lines,
                    })

    deps = parse_dependencies(root)

    return {
        "root": str(root),
        "file_count": file_count,
        "total_lines": total_lines,
        "manifests": manifests_found,
        "dependencies": deps,
        "high_cost_files": sorted(high_cost_files, key=lambda x: -x["lines"]),
    }


def format_report(result: dict) -> str:
    lines = [
        f"Scope: scan on {result['root']}",
        f"~{result['file_count']} files, ~{result['total_lines']} lines of code",
    ]

    if result["dependencies"]:
        dep_preview = result["dependencies"][:20]
        dep_str = ", ".join(dep_preview)
        if len(result["dependencies"]) > 20:
            dep_str += f" (+{len(result['dependencies']) - 20} more)"
        lines.append(f"Dependencies already available: {dep_str}")
    else:
        lines.append("Dependencies already available: (none detected)")

    if result["high_cost_files"]:
        hc = "; ".join(f"{f['file']} ({f['lines']} lines)" for f in result["high_cost_files"][:10])
        lines.append(f"Flagged high-cost (>{HIGH_COST_THRESHOLD} lines): {hc}")
    else:
        lines.append(f"Flagged high-cost: none (all files <{HIGH_COST_THRESHOLD} lines)")

    risk = "low"
    if result["file_count"] > 20:
        risk = "medium"
    if result["file_count"] > 50 or result["total_lines"] > 20000:
        risk = "high"

    lines.append(f"Estimated breaking-change risk: {risk}")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path> [--json]", file=sys.stderr)
        sys.exit(1)

    target = Path(sys.argv[1]).resolve()
    if not target.is_dir():
        print(f"Error: {target} is not a directory", file=sys.stderr)
        sys.exit(1)

    result = scan(target)

    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(format_report(result))


if __name__ == "__main__":
    main()
