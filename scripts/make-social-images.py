#!/usr/bin/env python3
"""Build the Mintlify and GitHub social cards from the shared ForgeKit brand art."""
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
FONTS = Path(os.environ.get("FORGE_DEMO_FONTS", "/usr/share/fonts/truetype/dejavu"))
COLORS = json.loads((ROOT / "brand.json").read_text())["colors"]["dark"]


def card(width, height, path):
    art = ROOT / "docs/assets/og-background.webp"
    with Image.open(art) as source:
        image = ImageOps.fit(source.convert("RGB"), (width, height))
    draw = ImageDraw.Draw(image)
    margin = 70
    def put(y, text, file, size, color):
        font = ImageFont.truetype(str(FONTS / file), size)
        box = draw.textbbox((margin, y), text, font=font)
        if box[2] > width * .60 or box[3] > height - 45:
            raise ValueError(f"Text crosses the safe region: {text}")
        draw.text((margin, y), text, fill=COLORS[color], font=font)
    put(58, "forgekit", "DejaVuSans-Bold.ttf", 42, "brand-2")
    put(172, "Supervised runs", "DejaVuSans-Bold.ttf", 60, "text")
    put(246, "for coding agents", "DejaVuSans-Bold.ttf", 60, "text")
    draw.line((margin, 365, margin + 100, 365), width=3, fill=COLORS["brand"])
    put(407, "Project evidence, tool permissions", "DejaVuSans.ttf", 29, "text")
    put(455, "and verified outcomes.", "DejaVuSans.ttf", 29, "text")
    put(height - 95, "CLI  /  MCP  /  Native hooks", "DejaVuSansMono.ttf", 21, "muted")
    image.quantize(colors=192, method=Image.Quantize.MEDIANCUT).save(ROOT / path, optimize=True)
    print(f"{path}: {width} × {height}")


if __name__ == "__main__":
    card(1200, 630, "mintlify/images/og-image.png")
    card(1280, 640, ".github/assets/social-preview.png")
