#!/usr/bin/env python3
"""Render a scripted terminal demo of `forge budget` (hard-breaker flow) as an animated GIF.

Usage:  python3 scripts/make-cost-gif.py   # writes mintlify/images/cost-governance.gif

Companion to examples/cost-governance/demo.sh: the same commands, the same real
output (captured with FORGE_NO_HINT=1). If the CLI output changes, update SCENES
and re-render — the GIF is a build artifact, never hand-edited.
"""

from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------------------
# Script: (command, output lines). Captured from real runs, FORGE_NO_HINT=1.
# ----------------------------------------------------------------------------
SCENES = [
    (
        "forge budget set --daily 10 --per-task 2 --alert-at 0.8 --hard",
        [
            "  daily     $10.00",
            "  per-task  $2.00",
            "  alert at  80% of a budget",
            "  breaker   HARD \u2014 tool calls are blocked over budget",
            "",
            "  the cost guard enforces this on every tool call (checked 1/100 calls)",
        ],
    ),
    (
        "forge budget status",
        [
            "Forge budget \u2014 spend vs budget",
            "  today  unknown of $10.00 [unknown]  [unknown]",
            "  per-task budget $2.00 \u2014 session spend:",
            "    (no sessions tracked yet \u2014 the guard records one per session)",
            "  alert at 80% \u00b7 breaker: HARD (blocks tool calls over budget)",
            "  \u00b7 daily source: config",
            "  spend is unknown \u2014 install ccusage for precise tracking: npm i -g ccusage",
        ],
    ),
    (
        "forge budget check --session-id demo",
        [
            "decision: allow",
            "reason:",
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
    title = "forge \u2014 cost governance demo"
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

    out_path = "mintlify/images/cost-governance.gif"
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
