#!/usr/bin/env python3
"""Render social/OG images with one visual language.

Usage:  python3 scripts/make-social-images.py
Writes:
  mintlify/images/og-image.png        1200x630  (docs site og:image)
  .github/assets/social-preview.png   1280x640  (repo Settings -> Social preview upload)
"""

from PIL import Image, ImageDraw, ImageFont

BG = (13, 17, 23)
ACCENT = (242, 100, 48)  # forgekit brand primary
WHITE = (230, 237, 243)
GRAY = (154, 164, 178)
GREEN = (126, 231, 135)
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def card(w, h, path):
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    # keep all content inside a 60px safe inset (surfaces crop edges)
    m = 60
    # wordmark
    f_wm = ImageFont.truetype(SANS_B, 96)
    d.text((m, m + 10), "forge", font=f_wm, fill=WHITE)
    w_forge = d.textlength("forge", font=f_wm)
    d.text((m + w_forge, m + 10), "kit", font=f_wm, fill=ACCENT)
    # tagline
    f_tag = ImageFont.truetype(SANS, 34)
    d.text(
        (m, m + 140),
        "Reliability infrastructure for AI coding agents",
        font=f_tag,
        fill=GRAY,
    )
    # feature chips row
    f_chip = ImageFont.truetype(MONO, 20)
    chips = ["evidence-linked memory", "blast-radius analysis", "guardrails", "cost governance"]
    cx = m
    cy = m + 235
    for chip in chips:
        tw = d.textlength(chip, font=f_chip)
        d.rounded_rectangle([cx, cy, cx + tw + 36, cy + 52], radius=26, outline=(60, 68, 82))
        d.text((cx + 18, cy + 10), chip, font=f_chip, fill=GRAY)
        cx += tw + 36 + 18
    # terminal motif
    f_mono = ImageFont.truetype(MONO, 30)
    y0 = h - m - 150
    d.rectangle([m, y0, w - m, y0 + 110], fill=(22, 27, 34))
    d.text((m + 28, y0 + 34), "$", font=f_mono, fill=GREEN)
    d.text(
        (m + 28 + d.textlength("$ ", font=f_mono), y0 + 34),
        "forge budget set --daily 10 --per-task 2",
        font=f_mono,
        fill=WHITE,
    )
    # cursor block
    cx = m + 28 + d.textlength("$ forge budget set --daily 10 --per-task 2 ", font=f_mono)
    d.rectangle([cx, y0 + 36, cx + 16, y0 + 36 + 30], fill=WHITE)
    img.save(path)
    print("wrote", path)


if __name__ == "__main__":
    card(1200, 630, "mintlify/images/og-image.png")
    card(1280, 640, ".github/assets/social-preview.png")
