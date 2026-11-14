#!/usr/bin/env python3
"""Capture the current Forge CLI in disposable repositories and render documentation GIFs."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BRAND = json.loads((ROOT / "brand.json").read_text())["colors"]["dark"]
FONT_DIR = Path(os.environ.get("FORGE_DEMO_FONTS", "/usr/share/fonts/truetype/dejavu"))
SIZE = (960, 400)
FILES = {
    "setup": "docs/assets/demo.gif",
    "verify": ".github/assets/forgekit-verify.gif",
    "precommit": ".github/assets/forgekit-precommit.gif",
    "memory": ".github/assets/forgekit-memory.gif",
    "cost": "mintlify/images/cost-governance.gif",
    "doctor": "mintlify/images/adversarial-doctor.gif",
}


class Capture:
    def __init__(self, scratch):
        self.repo = scratch / "project"
        self.repo.mkdir()
        home = scratch / "home"
        home.mkdir()
        # Only tools on PATH and invented fixtures are needed. Never inherit
        # an operator's model keys, credentials, global Git config or .forge.
        self.env = {
            "PATH": os.environ["PATH"], "HOME": str(home),
            "FORGE_HOME": str(scratch / "state"), "LANG": "C.UTF-8",
            "FORGE_NO_HINT": "1", "FORGE_EVIDENCE_WEB": "0",
            "GIT_CONFIG_NOSYSTEM": "1", "npm_config_offline": "true", "NO_COLOR": "1",
        }
        self.exec(["git", "init", "-q"])

    def exec(self, argv, expected=0):
        result = subprocess.run(argv, env=self.env, cwd=self.repo, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        if result.returncode != expected:
            raise RuntimeError(f"{argv!r} exited {result.returncode}: {result.stdout}")
        return result.stdout.rstrip()

    def forge(self, args, expected=0):
        return self.exec(["node", str(ROOT / "src/cli.js"), *shlex.split(args)], expected)


def excerpt(output, patterns):
    """Select real output lines in order. A changed observation must fail the capture."""
    lines = output.splitlines()
    selected = []
    for pattern in patterns:
        index = next((i for i, line in enumerate(lines) if re.search(pattern, line)), None)
        if index is None:
            raise ValueError(f"CLI output missing {pattern!r}: {output}")
        selected.append(lines[index].strip())
        lines = lines[index + 1:]
    return selected


def screen(command, lines, status=0):
    return (command, lines, status)


def capture_scenes(key, c):
    if key == "setup":
        args = "harness init --hosts kimi,codex --supervised"
        init = json.loads(c.forge(args))
        status = json.loads(c.forge("harness status"))
        drift_args = "harness drift --hosts kimi,codex"
        drift = json.loads(c.forge(drift_args))
        if not drift["ok"] or init["activated"]["mode"] != "supervised":
            raise ValueError("Supervised setup must pass the project drift check")
        # These are selected JSON fields, displayed as a table for a small screen.
        return [
            screen("forge " + args, ["created", *("  " + name for name in init["created"])]),
            screen("forge harness status", [f"mode      {status['mode']}",
                   "hosts     " + ", ".join(status["hosts"]),
                   "profiles  " + ", ".join(status["profiles"])]),
            screen("forge " + drift_args, [f"{row['host']:<7} {row['component']:<18} {row['status']}"
                   for row in drift["checks"]]),
        ]
    if key == "verify":
        # Build a real failing npm suite. No test dependencies or downloads.
        (c.repo / "package.json").write_text('{"name":"fixture","scripts":{"test":"node --test"}}\n')
        (c.repo / "check.test.cjs").write_text("require('forgekit-missing-fixture');\n")
        c.exec(["git", "add", "package.json", "check.test.cjs"])
        code = c.exec(["git", "diff", "--cached", "--", "check.test.cjs"])
        checks = c.forge("verify", expected=1)
        return [screen("git diff --cached -- check.test.cjs", excerpt(code, [r"^\+require"])),
                screen("forge verify", excerpt(checks, [r"tests:.*FAIL", r"suites ran:", r"BLOCKED"]), 1)]
    if key == "precommit":
        # Synthetic grammar match. Never display the token or read a real .env.
        (c.repo / "sample.env").write_text("API_KEY=" + "ghp_" + "a" * 36 + "\n")
        c.exec(["git", "add", "sample.env"])
        staged = c.exec(["git", "diff", "--cached", "--name-only"])
        checks = c.forge("precommit", expected=1)
        return [screen("git diff --cached --name-only", staged.splitlines()),
                screen("forge precommit", excerpt(checks, [r"\[secret\]", r"fix: remove", r"commit refused"]), 1)]
    if key == "memory":
        args = 'recall add deploy-window "Deploy on weekdays."'
        saved = c.forge(args)
        read = c.forge("recall list")
        return [screen("forge " + args, excerpt(saved, [r"saved: deploy-window"])),
                screen("forge recall list", excerpt(read, [r"- deploy-window"]))]
    if key == "cost":
        args = "budget set --daily 10 --per-task 2 --alert-at 0.8 --hard"
        budget = c.forge(args)
        status = c.forge("budget status")
        check = c.forge("budget check --session-id demo")
        return [screen("forge " + args, excerpt(budget, [r"daily ", r"per-task ", r"alert at", r"breaker"])),
                screen("forge budget status", excerpt(status, [r"today ", r"per-task budget", r"no sessions", r"spend is unknown"])),
                screen("forge budget check --session-id demo", excerpt(check, [r"decision:", r"reason:"]))]
    result = c.forge("doctor --adversarial")
    return [screen("forge doctor --adversarial", excerpt(result, patterns)) for patterns in (
        [r"adv: sed-inplace", r"adv: cp-exfil", r"adv: read-secret", r"adv: grep-env", r"adv: env-template"],
        [r"adv: truncated-json", r"adv: garbage-stdin", r"adv: empty-stdin"],
        [r"adv: settings-bypass", r"adv: live-bypass", r"^all clear$"],
    )]


TITLES = {
    "setup": "Supervised setup", "verify": "Verifying a failing test",
    "precommit": "Checking a staged credential", "memory": "Recalling a saved fact",
    "cost": "Setting a spending limit", "doctor": "Testing the guard hooks",
}


def render(key, scenes, output):
    fonts = {name: ImageFont.truetype(str(FONT_DIR / file), size) for name, file, size in [
        ("title", "DejaVuSans-Bold.ttf", 25), ("cmd", "DejaVuSansMono-Bold.ttf", 18),
        ("body", "DejaVuSansMono.ttf", 18), ("small", "DejaVuSans.ttf", 15),
    ]}
    frames = []
    duration = []
    for i, (cmd, rows, status) in enumerate(scenes):
        wrapped = [part for line in rows for part in textwrap.wrap(
            line, width=78, replace_whitespace=False, subsequent_indent="  ")]
        if len(wrapped) > 8:
            raise ValueError(f"More lines than the frame can display: {cmd}")
        # The first frame contains a readable command and its observed result.
        for n in range(1 if i else len(wrapped), len(wrapped) + 1):
            img = Image.new("RGB", SIZE, BRAND["bg"])
            d = ImageDraw.Draw(img)
            def put(x, y, s, face, color):
                box = d.textbbox((x, y), s, font=fonts[face])
                if box[2] > SIZE[0] - 28 or box[3] > SIZE[1] - 12:
                    raise ValueError(f"Text falls outside the frame: {s}")
                d.text((x, y), s, font=fonts[face], fill=color)
            put(30, 19, TITLES[key], "title", BRAND["text"])
            d.line((30, 68, 930, 68), fill=BRAND["line-strong"], width=2)
            put(30, 92, "$", "cmd", BRAND["brand-2"])
            put(57, 92, cmd, "cmd", BRAND["text"])
            for line_no, row in enumerate(wrapped[:n]):
                put(43, 140 + line_no * 24, row, "body", BRAND["muted"])
            footer = "Selected JSON fields" if key == "setup" else "CLI output excerpt"
            put(30, 356, footer, "small", BRAND["muted"])
            put(845, 356, f"exit {status}", "small", BRAND["ok"] if status == 0 else BRAND["brand-2"])
            frames.append(img)
            duration.append(3400 if n == len(wrapped) else 175)
    frames[0].save(output, save_all=True, append_images=frames[1:],
                   duration=duration, loop=0, optimize=True)
    print(f"{output.relative_to(ROOT)}: {len(frames)} frames, {output.stat().st_size:,} bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("demo", nargs="?", default="all", choices=["all", *FILES])
    selected = parser.parse_args().demo
    for key in (FILES if selected == "all" else [selected]):
        with tempfile.TemporaryDirectory(prefix="forgekit-demo-") as tmp:
            scenes = capture_scenes(key, Capture(Path(tmp)))
        path = ROOT / FILES[key]
        render(key, scenes, path)
        if key == "setup":
            shutil.copyfile(path, ROOT / "mintlify/images/supervised-setup.gif")


if __name__ == "__main__":
    main()
