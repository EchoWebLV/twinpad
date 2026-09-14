#!/usr/bin/env python3
"""Lockstep (LSTP) token image: two interlocking rings, one supply. 1024x1024 PNG."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 1024
HERE = Path(__file__).resolve().parent

def font(size: int):
    for path in ("/System/Library/Fonts/Supplemental/Futura.ttc",
                 "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                 "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)

def main() -> None:
    img = Image.new("RGB", (S, S))
    px = img.load()
    for y in range(S):
        t = y / (S - 1)
        px_row = (int(9 + 14 * t), int(12 + 22 * t), int(28 + 40 * t))
        for x in range(S):
            px[x, y] = px_row
    glow = Image.new("RGB", (S, S), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    r, w, cy = 250, 44, 470
    cx_l, cx_r = 372, 652
    g.ellipse((cx_l - r, cy - r, cx_l + r, cy + r), outline=(153, 69, 255), width=w)   # Solana purple
    g.ellipse((cx_r - r, cy - r, cx_r + r, cy + r), outline=(20, 241, 149), width=w)   # Solana green / lockstep
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    img = Image.blend(img, Image.composite(glow, img, glow.convert("L").point(lambda v: min(255, v * 3))), 0.55)
    d = ImageDraw.Draw(img)
    d.ellipse((cx_l - r, cy - r, cx_l + r, cy + r), outline=(153, 69, 255), width=w)
    d.ellipse((cx_r - r, cy - r, cx_r + r, cy + r), outline=(20, 241, 149), width=w)
    # interlock: redraw the left ring's lower arc over the right ring
    d.arc((cx_l - r, cy - r, cx_l + r, cy + r), start=300, end=420, fill=(153, 69, 255), width=w)
    f_big, f_small = font(150), font(46)
    text = "LSTP"
    tw = d.textlength(text, font=f_big)
    d.text(((S - tw) / 2, 735), text, font=f_big, fill=(244, 246, 250))
    sub = "ONE SUPPLY  ·  TWO CHAINS"
    sw = d.textlength(sub, font=f_small)
    d.text(((S - sw) / 2, 905), sub, font=f_small, fill=(160, 172, 196))
    out = HERE / "lockstep.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} {img.size[0]}x{img.size[1]} {out.stat().st_size} bytes")

if __name__ == "__main__":
    main()
