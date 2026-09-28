#!/usr/bin/env python3
"""Render a scripted terminal demo of `forge doctor --adversarial` as an animated GIF.

Usage:  python3 scripts/make-doctor-gif.py   # writes mintlify/images/adversarial-doctor.gif

The command output in SCENES was captured from a real `forge doctor --adversarial`
run (FORGE_NO_HINT=1), word-wrapped only where a terminal would wrap. If the CLI
output changes, update SCENES and re-render — the GIF is a build artifact, never
hand-edited.
"""

from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------------------
# Script: (command, output lines). Captured from a real run, FORGE_NO_HINT=1.
# ----------------------------------------------------------------------------
SCENES = [
    (
        "forge doctor --adversarial",
        [
            "  attacking our own hooks with real payloads \u2014 a blocked attack is good news.",
            "",
            "  \u2713 adv: sed-inplace blocked (exit 2) \u2014 in-place edit of a secret file",
            "  \u2713 adv: heredoc-write blocked (exit 2) \u2014 heredoc redirect into a secret file",
            "  \u2713 adv: append-authkeys blocked (exit 2) \u2014 append to an SSH trust file",
            "  \u2713 adv: tee-secret  blocked (exit 2) \u2014 tee into a secret file",
            "  \u2713 adv: cp-exfil    blocked (exit 2) \u2014 copy a secret out of the repo",
            "  \u2713 adv: mv-key      blocked (exit 2) \u2014 move a private key out",
            "  \u2713 adv: read-secret blocked (exit 2) \u2014 plain read of a secret file",
            "  \u2713 adv: grep-env    allowed (exit 0) \u2014 regex text, not a secret path",
            "  \u2713 adv: env-template allowed (exit 0) \u2014 committed template, not the secret",
            "  \u2713 adv: truncated-json denied (exit 2, fail-closed) \u2014 truncated JSON bytes",
            "  \u2713 adv: garbage-stdin denied (exit 2, fail-closed) \u2014 non-JSON bytes",
            "  ! adv: empty-stdin allowed (exit 0) \u2014 empty stdin; not attacker-reachable",
            "    via the hook protocol, but a stdin-swallowing pipeline would silently",
            "    disable the guard",
            "  ! adv: empty-object allowed (exit 0) \u2014 {} \u2014 no tool call described; not",
            "    attacker-reachable via the hook protocol, but a stdin-swallowing pipeline",
            "    would silently disable the guard",
            "  ! adv: string-tool-input allowed (exit 0) \u2014 tool_input as a string,",
            "    not an object; not attacker-reachable via the hook protocol, but a",
            "    stdin-swallowing pipeline would silently disable the guard",
            "  \u2713 adv: settings-bypass no persistent permission bypass configured",
            "  \u2713 adv: live-bypass no --dangerously-skip-permissions in the ancestor",
            "    process tree",
            "",
            "all clear",
        ],
    ),
]

# ----------------------------------------------------------------------------
# Look (same terminal chrome as scripts/make-demo-gif.py)
# ----------------------------------------------------------------------------
W, H = 880, 550
BAR_H = 44
BG = (13, 17, 23)
BAR = (22, 27, 34)
PROMPT = (126, 231, 135)
CMD = (230, 237, 243)
OUT = (154, 164, 178)
DIM = (110, 118, 129)
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_SIZE = 17
LINE_H = 26
PAD_X = 24
FPS = 12
CHARS_PER_FRAME = 2
OUT_FRAMES_PER_LINE = 3
HOLD_AFTER_TYPE = 8
GAP_BETWEEN_SCENES = 6
END_HOLD = 48

font = ImageFont.truetype(FONT_PATH, FONT_SIZE)


def draw_chrome(d):
    d.rectangle([0, 0, W, BAR_H], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        x = 22 + i * 26
        d.ellipse([x, 16, x + 14, 30], fill=c)
    title = "forge \u2014 adversarial doctor demo"
    tw = d.textlength(title, font=font)
    d.text(((W - tw) / 2, 12), title, font=font, fill=DIM)


def render(lines):
    """lines: list of (kind, text); kind in prompt/cmd/out."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    draw_chrome(d)
    max_lines = (H - BAR_H - 16) // LINE_H
    vis = lines[-max_lines:]
    y = BAR_H + 16
    for kind, text in vis:
        x = PAD_X
        if kind == "prompt":
            d.text((x, y), "$ ", font=font, fill=PROMPT)
            x += d.textlength("$ ", font=font)
            d.text((x, y), text, font=font, fill=CMD)
        elif kind == "cursor":
            d.text((x, y), "$ ", font=font, fill=PROMPT)
            x += d.textlength("$ ", font=font)
            d.text((x, y), text, font=font, fill=CMD)
            cx = x + d.textlength(text, font=font)
            d.rectangle([cx + 2, y + 3, cx + 12, y + 3 + FONT_SIZE], fill=CMD)
        else:
            d.text((x, y), text, font=font, fill=OUT)
        y += LINE_H
    return img


def main():
    frames = []
    lines = []  # (kind, text)

    for cmd, out_lines in SCENES:
        # type the command
        typed = ""
        for i in range(0, len(cmd) + 1, CHARS_PER_FRAME):
            typed = cmd[:i]
            frames.append(render(lines + [("cursor", typed)]))
        lines.append(("prompt", cmd))
        frames.extend([render(lines)] * HOLD_AFTER_TYPE)
        # reveal output
        for ol in out_lines:
            lines.append(("out", ol))
            frames.extend([render(lines)] * OUT_FRAMES_PER_LINE)
        frames.extend([render(lines)] * GAP_BETWEEN_SCENES)

    frames.extend([render(lines)] * END_HOLD)

    out_path = "mintlify/images/adversarial-doctor.gif"
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=int(1000 / FPS),
        loop=0,
        optimize=True,
    )
    print(f"wrote {out_path}: {len(frames)} frames")


if __name__ == "__main__":
    main()
