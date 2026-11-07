#!/usr/bin/env python3
"""Render the front face of an M5Stack Cardputer as a photo-ish, spec-accurate image.

Everything is driven by the real hardware description:

  * 84 x 54 mm face, 19.7 mm thick, rounded 2.8 mm corners
  * 4 x 14 staggered key matrix, black capsule caps, legends silkscreened on the
    shell (with the shifted symbol printed in blue, exactly like the retail part)
  * modifier artwork: esc/fn orange, Aa blue, opt green, tab/ctrl/alt white
  * 1.14" 240x135 ST7789V2 panel behind a black bezel — the content is a *real*
    framebuffer dumped from the emulator core (tools/screen_dump.mjs)
  * StampS3A sticker sheet, M5 wordmark, Torx screws, mic slots, status LED

    python3 tools/render_device.py --screen /tmp/screen.json --out art/device.png
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
F_BOLD = FONT_DIR / "DejaVuSans-Bold.ttf"
F_REG = FONT_DIR / "DejaVuSans.ttf"
F_MONO = FONT_DIR / "DejaVuSansMono.ttf"

# --------------------------------------------------------------------------- #
#  Hardware description (mm). Sources: docs.m5stack.com/en/core/Cardputer-Adv,
#  the v1.1 manual and teardown photos of the retail part.
# --------------------------------------------------------------------------- #
FACE_W, FACE_H = 84.0, 54.0
THICK = 19.7
CORNER = 2.8

SHELL_TOP = (247, 246, 243)
SHELL_BOT = (214, 213, 209)
SHELL_EDGE = (176, 176, 172)
BASE_DARK = (43, 46, 50)
KEY_BLACK = (28, 29, 31)
KEY_TOP = (58, 60, 64)
INK = (26, 27, 29)
SHIFT_INK = (38, 96, 168)
ORANGE = (240, 106, 33)
BLUE = (31, 95, 168)
GREEN = (52, 178, 106)
WHITE_BOX = (250, 250, 249)

# key matrix: (base, shift, label, label_style)
#   label_style: None = plain printed base/shift, or "esc"/"tab"/"fn"/"Aa"/"ctrl"/"opt"/"alt"/"del"/"ok"
ROWS = [
    [("`", "~", "esc"), ("1", "!"), ("2", "@"), ("3", "#"), ("4", "$"), ("5", "%"), ("6", "^"),
     ("7", "&"), ("8", "*"), ("9", "("), ("0", ")"), ("-", "_"), ("=", "+"), ("", "", "del")],
    [("", "", "tab"), ("q",), ("w",), ("e",), ("r",), ("t",), ("y",), ("u",), ("i",), ("o",), ("p",),
     ("[", "{"), ("]", "}"), ("\\", "|")],
    [("", "", "fn"), ("", "", "Aa"), ("a",), ("s",), ("d",), ("f",), ("g",), ("h",), ("j",), ("k",),
     ("l",), (";", ":"), ("'", '"'), ("", "", "ok")],
    [("", "", "ctrl"), ("", "", "opt"), ("", "", "alt"), ("z",), ("x",), ("c",), ("v",), ("b",),
     ("n",), ("m",), (",", "<"), (".", ">"), ("/", "?"), ("", "", "home")],
]
# Fn-layer artwork printed under some keys (arrows on ; . , / and the space bar)
FN_ART = {(2, 12): "up", (2, 13): "down", (3, 12): "left", (3, 13): "right", (3, 11): "down"}
BOX_STYLE = {
    "esc": (ORANGE, (255, 255, 255)), "fn": (ORANGE, (255, 255, 255)),
    "Aa": (BLUE, (255, 255, 255)), "opt": (GREEN, (255, 255, 255)),
    "tab": (WHITE_BOX, INK), "ctrl": (WHITE_BOX, INK), "alt": (WHITE_BOX, INK),
    "del": (ORANGE, (255, 255, 255)), "ok": ((24, 25, 27), (255, 255, 255)),
    "home": (WHITE_BOX, INK),
}
STAGGER = [0.0, 0.30, 0.30, 0.0]      # key rows are offset, like the real part
KEY_W, KEY_H = 4.05, 2.30              # capsule keycap, mm
PITCH_X, PITCH_Y = 5.58, 6.85
KB_X0, KB_Y0 = 3.2, 26.2               # first key centre

# screen module (mm, top-left origin)
BEZEL = (26.4, 4.6, 51.6, 21.0)        # x0, y0, x1, y1
GLASS = (27.7, 5.9, 50.3, 19.7)


def font(path: Path, px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), px)


def rounded_mask(size: tuple[int, int], radius: float, ss: float = 4) -> Image.Image:
    w, h = size
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=radius * ss, fill=255)
    return m.resize(size, Image.LANCZOS)


def lighting(size: tuple[int, int], *, key=(0.28, 0.12), soft=(0.9, 0.75), strength=0.16,
             ambient=0.94) -> np.ndarray:
    """Soft studio key light from the upper-left, as a multiplicative field."""
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    u, v = xx / w, yy / h
    d = np.sqrt(((u - key[0]) / soft[0]) ** 2 + ((v - key[1]) / soft[1]) ** 2)
    field = ambient + strength * np.exp(-d * d)
    field -= 0.06 * np.clip((u - 0.55) / 0.45, 0, 1) * np.clip((v - 0.5) / 0.5, 0, 1)
    return np.clip(field, 0.55, 1.18)[..., None]


def grain(size: tuple[int, int], amount=3.0, seed=3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    w, h = size
    n = rng.normal(0, 1, (h, w))
    n = np.array(Image.fromarray(((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)))
    return ((n.astype(np.float32) / 255.0 - 0.5) * amount)[..., None]


def vertical_gradient(size: tuple[int, int], top: tuple, bottom: tuple) -> np.ndarray:
    w, h = size
    t = np.linspace(0, 1, h)[:, None, None]
    top_a = np.array(top, dtype=np.float32)
    bot_a = np.array(bottom, dtype=np.float32)
    return (top_a * (1 - t) + bot_a * t) * np.ones((1, w, 1), dtype=np.float32)


def screen_image(path: Path | None, size_px: tuple[int, int]) -> Image.Image:
    """Real emulator framebuffer -> RGB image, with the pixel grid kept crisp."""
    if path is None or not path.exists():
        rgb = np.zeros((135, 240, 3), dtype=np.uint8)
    else:
        data = json.loads(path.read_text())
        buf = np.array(data["rgb565"], dtype=np.uint16).reshape(data["h"], data["w"])
        r = ((buf >> 11) & 0x1F) * 255 // 31
        g = ((buf >> 5) & 0x3F) * 255 // 63
        b = (buf & 0x1F) * 255 // 31
        rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    img = Image.fromarray(rgb, "RGB").resize(size_px, Image.NEAREST)
    return img


def draw_key_shadow(shadow: ImageDraw.ImageDraw, cx: float, cy: float, s: float) -> None:
    """Contact shadow, drawn on its own layer so it can be blurred."""
    w, h = KEY_W * s, KEY_H * s
    shadow.rounded_rectangle((cx - w / 2 + 0.04 * s, cy - h / 2 + 0.10 * s,
                              cx + w / 2 + 0.08 * s, cy + h / 2 + 0.16 * s),
                             radius=h / 2, fill=140)


def draw_key(d: ImageDraw.ImageDraw, cx: float, cy: float, s: float, down: bool = False) -> None:
    """One black capsule keycap with a soft top bevel."""
    w, h = KEY_W * s, KEY_H * s
    if down:
        h *= 0.92
    box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    d.rounded_rectangle(box, radius=h / 2, fill=(20, 21, 23) if down else KEY_BLACK)
    if down:
        return
    # top-lit bevel: a slightly smaller, brighter capsule offset up
    inner = (box[0] + 0.34 * s, box[1] + 0.22 * s, box[2] - 0.34 * s, box[3] - 0.62 * s)
    d.rounded_rectangle(inner, radius=(inner[3] - inner[1]) / 2, fill=(44, 46, 50))
    hi = (inner[0] + 0.3 * s, inner[1] + 0.16 * s, inner[2] - 0.3 * s, inner[1] + (inner[3] - inner[1]) * 0.52)
    d.rounded_rectangle(hi, radius=(hi[3] - hi[1]) / 2, fill=(62, 64, 69))


def arrow(d: ImageDraw.ImageDraw, cx: float, cy: float, size: float, direction: str) -> None:
    r = size * 0.5
    pts = {
        "up": [(cx, cy - r), (cx + r, cy + r * 0.7), (cx - r, cy + r * 0.7)],
        "down": [(cx, cy + r), (cx + r, cy - r * 0.7), (cx - r, cy - r * 0.7)],
        "left": [(cx - r, cy), (cx + r * 0.7, cy - r), (cx + r * 0.7, cy + r)],
        "right": [(cx + r, cy), (cx - r * 0.7, cy - r), (cx - r * 0.7, cy + r)],
    }[direction]
    d.polygon(pts, fill=ORANGE)


def render_face(px_per_mm: int = 30, screen: Path | None = None, ss: int | None = None,
                pressed: tuple[int, int] | None = None) -> Image.Image:
    """pressed=(row, col) renders that keycap pushed down, as if a finger is on it.

    ``ss`` is the supersample factor; it defaults to 2 at low densities and 1 above
    20 px/mm (where the density itself already provides the antialiasing, and a 2x
    supersample would allocate a gigabyte for no visible gain).
    """
    if ss is None:
        ss = 2 if px_per_mm <= 20 else 1
    s = px_per_mm * ss
    W, H = int(FACE_W * s), int(FACE_H * s)
    # ---- shell base -------------------------------------------------------
    grad = vertical_gradient((W, H), SHELL_TOP, SHELL_BOT)
    img = np.clip(grad * lighting((W, H)) + grain((W, H), 2.2), 0, 255).astype(np.uint8)
    face = Image.fromarray(img, "RGB").convert("RGBA")
    d = ImageDraw.Draw(face)
    shadow_layer = Image.new("L", (W, H), 0)
    shadow = ImageDraw.Draw(shadow_layer)

    # Moulding: the deck groove and the shell bevel. These are drawn on a layer that
    # gets a small blur — a hard 1 px white line turns into moire stitching as soon
    # as the face is perspective-warped, which is exactly what the eye picks out.
    mould = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    md = ImageDraw.Draw(mould)
    md.line([(0, 22.6 * s), (W, 22.6 * s)], fill=(186, 185, 181, 255), width=max(1, int(0.13 * s)))
    md.line([(0, 23.15 * s), (W, 23.15 * s)], fill=(250, 250, 248, 150), width=max(1, int(0.09 * s)))
    md.rounded_rectangle((0.62 * s, 0.62 * s, W - 0.62 * s, H - 0.62 * s), radius=CORNER * s,
                         outline=(252, 252, 250, 120), width=max(2, int(0.30 * s)))
    md.rounded_rectangle((0.25 * s, 0.25 * s, W - 0.25 * s, H - 0.25 * s), radius=CORNER * s,
                         outline=(186, 186, 182, 150), width=max(2, int(0.38 * s)))
    face.alpha_composite(mould.filter(ImageFilter.GaussianBlur(0.09 * s)))

    # ---- printed identity -------------------------------------------------
    d.text((4.2 * s, 7.4 * s), "CARDPUTER", font=font(F_BOLD, int(1.55 * s)), fill=(60, 62, 66))
    d.text((4.0 * s, 9.2 * s), "ADV", font=font(F_BOLD, int(5.4 * s)), fill=(22, 23, 25))
    # status LED + mic slots
    d.rounded_rectangle((4.6 * s, 16.9 * s, 5.9 * s, 18.2 * s), radius=0.6 * s, fill=(214, 88, 40))
    for i in range(2):
        d.rounded_rectangle((7.4 * s + i * 1.35 * s, 17.4 * s, 7.9 * s + i * 1.35 * s, 18.3 * s), radius=0.25 * s, fill=(40, 41, 44))

    # ---- screws -----------------------------------------------------------
    for (sx, sy, r) in [(22.9, 19.6, 1.55), (79.4, 4.4, 1.0), (79.4, 25.6, 1.0)]:
        d.ellipse((sx * s - r * s, sy * s - r * s, sx * s + r * s, sy * s + r * s), fill=(203, 204, 206), outline=(120, 122, 125), width=max(1, int(0.08 * s)))
        d.ellipse((sx * s - r * 0.62 * s, sy * s - r * 0.62 * s, sx * s + r * 0.62 * s, sy * s + r * 0.62 * s), fill=(228, 229, 231))
        star = []
        for i in range(12):
            a = i * math.pi / 6
            rr = (0.42 if i % 2 == 0 else 0.18) * r * s
            star.append((sx * s + rr * math.cos(a), sy * s + rr * math.sin(a)))
        d.polygon(star, fill=(120, 122, 126))

    # ---- screen -----------------------------------------------------------
    # the panel sits on a slightly raised deck, which is what catches the light
    d.rounded_rectangle((25.4 * s, 3.7 * s, 52.6 * s, 22.1 * s), radius=1.5 * s, fill=(236, 235, 231))
    d.rounded_rectangle((25.4 * s, 3.7 * s, 52.6 * s, 22.1 * s), radius=1.5 * s, outline=(206, 205, 201), width=max(1, int(0.12 * s)))
    bx0, by0, bx1, by1 = [v * s for v in BEZEL]
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=0.9 * s, fill=(18, 19, 21))
    d.rounded_rectangle((bx0 + 0.18 * s, by0 + 0.18 * s, bx1 - 0.18 * s, by1 - 0.18 * s),
                        radius=0.8 * s, fill=(12, 13, 15))
    gx0, gy0, gx1, gy1 = [v * s for v in GLASS]
    panel = screen_image(screen, (int(gx1 - gx0), int(gy1 - gy0))).convert("RGBA")
    face.alpha_composite(panel, (int(gx0), int(gy0)))
    d.rectangle((gx0, gy0, gx1, gy1), outline=(30, 32, 36), width=max(1, int(0.1 * s)))
    # glass: a diagonal reflection streak across the panel
    gloss = Image.new("RGBA", (int(gx1 - gx0), int(gy1 - gy0)), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gw, gh = gloss.size
    gd.polygon([(0, gh * 0.62), (gw * 0.55, 0), (gw * 0.78, 0), (0, gh * 0.9)], fill=(255, 255, 255, 16))
    face.alpha_composite(gloss, (int(gx0), int(gy0)))

    # ---- StampS3A sticker sheet + M5 mark --------------------------------
    np.random.default_rng(9)
    stx0, sty0, stx1, sty1 = 55.0 * s, 3.4 * s, 75.4 * s, 13.2 * s
    d.rounded_rectangle((stx0, sty0, stx1, sty1), radius=0.5 * s, fill=(248, 247, 244), outline=(205, 205, 202), width=max(1, int(0.08 * s)))
    labels = [("STAMPS3A", (32, 33, 36)), ("2.4G", (60, 62, 66)), ("Wi-Fi", (31, 95, 168)),
              ("BLE", (31, 95, 168)), ("ESP32-S3", (32, 33, 36)), ("8MB", (32, 33, 36)),
              ("CE", (32, 33, 36)), ("FCC", (32, 33, 36)), ("FNK", (200, 60, 40)),
              ("240MHz", (32, 33, 36)), ("DoB", (200, 60, 40)), ("M5-ADV", (32, 33, 36))]
    xs, ys = stx0 + 0.35 * s, sty0 + 0.3 * s
    for i, (txt, col) in enumerate(labels):
        fpx = int((0.95 + 0.35 * (i % 2)) * s)
        f = font(F_BOLD, fpx)
        tw = d.textlength(txt, font=f)
        if xs + tw > stx1 - 0.3 * s:
            xs, ys = stx0 + 0.35 * s, ys + 1.45 * s
        d.text((xs, ys), txt, font=f, fill=col)
        xs += tw + 0.6 * s
    # colour chips like the real compliance sticker cluster
    chips = [((190, 40, 40), 458), ((40, 110, 190), 461), ((60, 150, 90), 464), ((230, 140, 40), 467),
             ((120, 70, 160), 470), ((30, 30, 34), 473)]
    for col, yy in chips:
        d.ellipse((76.6 * s, (yy - 450) * 0.06 * s + 5.6 * s, 77.4 * s, (yy - 450) * 0.06 * s + 6.4 * s), fill=col)
    # the pin-header strip under the sticker
    d.rounded_rectangle((56.0 * s, 13.4 * s, 75.0 * s, 15.0 * s), radius=0.3 * s, fill=(26, 27, 29))
    for i in range(14):
        cx = 56.6 * s + i * 1.32 * s
        d.rectangle((cx, 13.8 * s, cx + 0.6 * s, 14.6 * s), fill=(196, 190, 150))
    d.text((60.0 * s, 16.4 * s), "M5", font=font(F_BOLD, int(3.6 * s)), fill=(196, 196, 193))

    # ---- keyboard ---------------------------------------------------------
    # Pass 1: legends and contact shadows. The shadows must be under the caps, so
    # they are blurred and composited onto the shell before any cap is drawn.
    key_geo = []
    for r, row in enumerate(ROWS):
        for c, key in enumerate(row):
            base = key[0]
            shift = key[1] if len(key) > 1 else ""
            label = key[2] if len(key) > 2 else None
            cx = (KB_X0 + c * PITCH_X + STAGGER[r] * PITCH_X) * s
            cy = (KB_Y0 + r * PITCH_Y) * s
            # legend printed on the shell, above the cap
            legend_top = cy - 3.05 * s
            if label:
                bg, fg = BOX_STYLE[label]
                f = font(F_BOLD, int(1.5 * s))
                tw = d.textlength(label, font=f)
                box = (cx - tw / 2 - 0.42 * s, legend_top + 0.15 * s,
                       cx + tw / 2 + 0.42 * s, legend_top + 1.65 * s)
                d.rounded_rectangle(box, radius=0.22 * s, fill=bg)
                d.text((box[0] + 0.42 * s, box[1] + 0.02 * s), label, font=f, fill=fg)
            elif base:
                f = font(F_BOLD, int(1.65 * s))
                g = font(F_BOLD, int(1.05 * s))
                up = base.upper() if base.isalpha() else base
                tw = d.textlength(up, font=f)
                d.text((cx - tw / 2 - 0.28 * s, legend_top + 0.1 * s), up, font=f, fill=INK)
                if shift:
                    d.text((cx + tw / 2 - 0.35 * s, legend_top + 0.02 * s), shift, font=g, fill=SHIFT_INK)
            art = FN_ART.get((r, c))
            if art:
                arrow(d, cx + 1.55 * s, legend_top + 1.0 * s, 1.1 * s, art)
            draw_key_shadow(shadow, cx, cy, s)
            key_geo.append((r, c, cx, cy))
    # the space bar is the widest cap on the real part and runs to the right edge
    cx = (KB_X0 + 13 * PITCH_X + STAGGER[3] * PITCH_X) * s
    cy = (KB_Y0 + 3 * PITCH_Y) * s
    bar = (cx - KEY_W * 0.5 * s, cy - KEY_H * 0.5 * s, FACE_W * s - 2.6 * s, cy + KEY_H * 0.5 * s)
    d.rounded_rectangle((bar[0] + 0.05 * s, bar[1] + 0.18 * s, bar[2] + 0.12 * s, bar[3] + 0.3 * s),
                        radius=KEY_H * 0.5 * s, fill=(70, 71, 76))
    d.rounded_rectangle(bar, radius=KEY_H * 0.5 * s, fill=KEY_BLACK)
    d.rounded_rectangle((bar[0] + 0.35 * s, bar[1] + 0.3 * s, bar[2] - 0.4 * s, bar[1] + 0.85 * s),
                        radius=0.28 * s, fill=(56, 58, 63))

    # Bake the key shadows into the shell with an explicit multiply: alpha_composite
    # ordering here is easy to get backwards, and a shadow that lands on top of the
    # keycaps (or nowhere at all) is the sort of thing the eye catches immediately.
    soft = shadow_layer.filter(ImageFilter.GaussianBlur(0.10 * s))
    sa = (np.asarray(soft, dtype=np.float32) / 255.0) * 0.42
    fa = np.asarray(face.convert("RGB"), dtype=np.float32) * (1.0 - sa)[..., None]
    keep_alpha = face.split()[3]
    face = Image.fromarray(np.clip(fa, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    face.putalpha(keep_alpha)
    d = ImageDraw.Draw(face)
    for (r, c, cx, cy) in key_geo:
        if pressed == (r, c):
            draw_key(d, cx, cy + 0.28 * s, s, down=True)      # held down: lower, no highlight
        else:
            draw_key(d, cx, cy, s)

    # ---- knock the moulding back to a physical surface --------------------
    alpha = face.split()[3]
    surface = np.array(face.convert("RGB"), dtype=np.float32)
    surface = surface * lighting((W, H), key=(0.22, 0.05), soft=(1.1, 0.9), strength=0.07, ambient=1.0)
    face = Image.fromarray(np.clip(surface, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    face.putalpha(alpha)

    # rounded silhouette
    mask = rounded_mask((W, H), CORNER * s)
    face.putalpha(Image.composite(face.split()[3], Image.new("L", (W, H), 0), mask))
    return face.resize((int(FACE_W * px_per_mm), int(FACE_H * px_per_mm)), Image.LANCZOS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--screen", help="JSON dumped by tools/screen_dump.mjs")
    ap.add_argument("--out", default="art/device.png")
    ap.add_argument("--ppm", type=int, default=26, help="pixels per millimetre")
    ap.add_argument("--press", help="row,col of a key held down")
    args = ap.parse_args()
    pressed = tuple(int(v) for v in args.press.split(",")) if args.press else None
    face = render_face(args.ppm, Path(args.screen) if args.screen else None, pressed=pressed)
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    face.save(out)
    print(f"wrote {out} ({face.width}x{face.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
