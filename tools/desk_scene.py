#!/usr/bin/env python3
"""Compose the hero shot: a Cardputer lying on a real desk, mid-session.

The device is not pasted together from stock art — it is the georeferenced model
from ``tools/render_device.py`` (84 x 54 x 19.7 mm, correct key matrix, correct
modifier colours) rendered into a 3D projection, with the LCD showing a real
framebuffer dumped out of the emulator by ``tools/screen_dump.mjs``.

Everything else is synthesised: walnut desk, the laptop running the emulator, the
USB-C lead, the Grove lead to a physically modelled ENV III unit, a mug, notebook,
pen and SD card — plus the light rig (warm key from the window, cool bounce),
depth of field, contact shadows, screen bloom and film grain.

    python3 tools/desk_scene.py --screen /tmp/screen_env.json --out art/cardputer-desk.png
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import render_device as rd
from PIL import Image, ImageDraw, ImageFilter
from render_device import F_BOLD, F_MONO, font

ROOT = Path(__file__).resolve().parent.parent
W, H = 2560, 1600

# --------------------------------------------------------------------------- #
#  Tiny 3D: world is millimetres, z up, desk plane at z = 0.
# --------------------------------------------------------------------------- #
class Cam:
    def __init__(self, eye, target, fov=38.0, up=(0, 0, 1), size=(W, H)):
        self.eye = np.array(eye, dtype=float)
        fwd = np.array(target, dtype=float) - self.eye
        self.fwd = fwd / np.linalg.norm(fwd)
        right = np.cross(self.fwd, np.array(up, dtype=float))
        self.right = right / np.linalg.norm(right)
        self.up = np.cross(self.right, self.fwd)
        self.f = (size[1] / 2) / math.tan(math.radians(fov) / 2)
        self.cx, self.cy = size[0] / 2, size[1] / 2

    def project(self, p):
        d = np.array(p, dtype=float) - self.eye
        z = float(np.dot(d, self.fwd))
        if z <= 1e-6:
            return None
        x = float(np.dot(d, self.right))
        y = float(np.dot(d, self.up))
        return (self.cx + self.f * x / z, self.cy - self.f * y / z)


def perspective_coeffs(src, dst):
    """PIL PERSPECTIVE coefficients mapping dst -> src (PIL pulls source pixels)."""
    A, b = [], []
    for (xs, ys), (xd, yd) in zip(src, dst, strict=False):
        A.append([xd, yd, 1, 0, 0, 0, -xs * xd, -xs * yd])
        b.append(xs)
        A.append([0, 0, 0, xd, yd, 1, -ys * xd, -ys * yd])
        b.append(ys)
    return np.linalg.solve(np.array(A, dtype=float), np.array(b, dtype=float))


def quad_mask(size, quad, ss=3) -> Image.Image:
    """Antialiased polygon mask. ImageDraw has no AA, so rasterise at ss x and box-filter
    down -- a hard-aliased diagonal edge survives a Gaussian blur as a visible staircase."""
    w, h = size
    big = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(big).polygon([(p[0] * ss, p[1] * ss) for p in quad], fill=255)
    return big.resize((w, h), Image.BOX)


def warp_flat(tex: Image.Image, quad_dst, canvas) -> tuple[Image.Image, tuple[int, int]]:
    """Perspective-warp `tex` onto `quad_dst` inside a full-size RGBA layer.

    Returned separately from the composite so callers can derive shadows, walls or
    reflections from the *warped* alpha: deriving them from a hand-drawn polygon
    instead leaves a 1 px seam (dark line plus bright specks) where the two edges
    disagree by sub-pixel fractions.
    """
    xs = [p[0] for p in quad_dst]
    ys = [p[1] for p in quad_dst]
    x0, y0 = math.floor(min(xs)), math.floor(min(ys))
    x1, y1 = math.ceil(max(xs)), math.ceil(max(ys))
    out = Image.new("RGBA", canvas, (0, 0, 0, 0))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return out, (0, 0)
    local = [(p[0] - x0, p[1] - y0) for p in quad_dst]
    coeffs = perspective_coeffs([(0, 0), (tex.width, 0), (tex.width, tex.height), (0, tex.height)], local)
    size = (x1 - x0, y1 - y0)
    if tex.mode == "RGBA":
        # Warp colour and coverage separately. PIL's transform samples black outside
        # the source, so warping premultiplied-looking RGBA in one pass leaves a dark
        # 1 px ring (plus bright specks where the alpha gaps) around the silhouette.
        # Filling the outside with the body colour first makes that ring impossible.
        fill = tex.getpixel((1, 1))[:3]
        rgb = Image.alpha_composite(Image.new("RGBA", tex.size, (*fill, 255)), tex).convert("RGB")
        warped = rgb.transform(size, Image.PERSPECTIVE, coeffs, Image.BILINEAR).convert("RGBA")
        a = tex.split()[3].transform(size, Image.PERSPECTIVE, coeffs, Image.BILINEAR)
        # hard-threshold then re-soften: a 1 px antialiased rim otherwise reads as a
        # dotted white stitch once the sprite sits on the photo
        a = a.point(lambda v: 255 if v >= 128 else 0).filter(ImageFilter.GaussianBlur(1.1))
        warped.putalpha(a)
    else:
        # BILINEAR, not BICUBIC: bicubic rings on the alpha edge and turns a clean
        # silhouette into a dotted fringe once the sprite is composited.
        warped = tex.transform(size, Image.PERSPECTIVE, coeffs, Image.BILINEAR).convert("RGBA")
    out.alpha_composite(warped, (x0, y0))
    return out, (x0, y0)


def warp_into(scene: Image.Image, tex: Image.Image, quad_dst, alpha=1.0) -> None:
    layer, _pos = warp_flat(tex, quad_dst, scene.size)
    if alpha < 1.0:
        a = layer.split()[3].point(lambda v: int(v * alpha))
        layer.putalpha(a)
    scene.alpha_composite(layer, (0, 0))


# --------------------------------------------------------------------------- #
#  Materials
# --------------------------------------------------------------------------- #
def wood_texture(size, seed=5):
    """Walnut-ish desk: long grain bands + fine fibre + a couple of knots."""
    rng = np.random.default_rng(seed)
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # warped horizontal grain
    warp = (np.sin(xx / 380.0) * 9 + np.sin(xx / 97.0) * 3.4 + np.sin(xx / 1630.0) * 26)
    band = np.sin((yy + warp) / 5.6) * 0.5 + np.sin((yy + warp * 1.6) / 15.0) * 0.32
    fine = rng.normal(0, 1, (h, w)).astype(np.float32)
    fine = np.array(Image.fromarray(((fine * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(0.7)), dtype=np.float32) / 255.0 - 0.5
    fibre = np.sin((yy * 3.0 + warp * 2.2) / 1.7) * 0.08
    t = np.clip(0.5 + band * 0.35 + fibre + fine * 0.5, 0, 1)[..., None]
    dark = np.array([44, 27, 18], dtype=np.float32)
    light = np.array([104, 68, 44], dtype=np.float32)
    return (dark * (1 - t) + light * t)


def desk_light(size, cam_angle=0.0):
    """Warm window light from the upper left, cool fill from the right."""
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = xx / w, yy / h
    warm = np.exp(-(((u - 0.06) / 0.55) ** 2 + ((v - 0.02) / 0.62) ** 2))
    cool = np.exp(-(((u - 1.02) / 0.6) ** 2 + ((v - 0.85) / 0.7) ** 2)) * 0.55
    field = 0.52 + 0.72 * warm + 0.30 * cool
    tint = np.stack([field * 1.06, field * 1.0, field * 0.90], axis=-1)
    tint[..., 2] += cool * 0.18
    return tint


def vignette(size, power=2.1, strength=0.55):
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = (xx / w - 0.5) * 2, (yy / h - 0.5) * 2
    r = np.sqrt(u * u * 0.86 + v * v)
    return np.clip(1 - strength * np.clip((r - 0.35) / 1.15, 0, 1) ** power, 0.25, 1)[..., None]


def add_grain(img: Image.Image, amount=4.0, seed=11) -> Image.Image:
    rng = np.random.default_rng(seed)
    a = np.array(img.convert("RGB"), dtype=np.float32)
    n = rng.normal(0, amount, a.shape[:2])[..., None]
    fine = rng.normal(0, amount * 2.2, a.shape[:2])[..., None]
    a = a + n + fine
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def bloom(img: Image.Image, threshold=196, radius=26, gain=0.85) -> Image.Image:
    a = np.array(img.convert("RGB"), dtype=np.float32)
    lum = a.max(axis=2, keepdims=True)
    mask = np.clip((lum - threshold) / (255.0 - threshold), 0, 1)
    bright = a * mask
    b = Image.fromarray(np.clip(bright, 0, 255).astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(radius))
    out = np.clip(a + np.array(b, dtype=np.float32) * gain, 0, 255)
    return Image.fromarray(out.astype(np.uint8), "RGB")


# --------------------------------------------------------------------------- #
#  Props (drawn in 2D but placed with the scene's projection)
# --------------------------------------------------------------------------- #
def draw_mug(scene: Image.Image, cam: Cam, center_mm, r_mm=34, h_mm=90):
    """A stoneware mug: ellipse mouth, shaded cylinder wall, handle, contact shadow."""
    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center_mm
    top = cam.project((cx, cy, h_mm))
    bot = cam.project((cx, cy, 0))
    if not top or not bot:
        return
    # radius in pixels at the mouth and at the base
    rx = abs(cam.project((cx + r_mm, cy, h_mm))[0] - top[0])
    ry = rx * 0.34
    d.ellipse((top[0] - rx, top[1] - ry, top[0] + rx, top[1] + ry), fill=(232, 228, 220, 255))
    body = [(top[0] - rx, top[1]), (top[0] + rx, top[1]), (bot[0] + rx * 0.86, bot[1]), (bot[0] - rx * 0.86, bot[1])]
    d.polygon(body, fill=(222, 217, 208, 255))
    d.polygon([(top[0] - rx, top[1]), (top[0] - rx * 0.25, top[1] + 4), (bot[0] - rx * 0.3, bot[1]), (bot[0] - rx * 0.86, bot[1])],
              fill=(240, 236, 228, 255))
    # handle
    hx = top[0] + rx * 0.95
    d.arc((hx - rx * 0.7, top[1] + ry, hx + rx * 0.85, bot[1] - (bot[1] - top[1]) * 0.15), -80, 100,
          fill=(214, 209, 200, 255), width=max(6, int(rx * 0.22)))
    # coffee
    d.ellipse((top[0] - rx * 0.86, top[1] - ry * 0.82, top[0] + rx * 0.86, top[1] + ry * 0.82), fill=(58, 34, 20, 255))
    d.ellipse((top[0] - rx * 0.86, top[1] - ry * 0.86, top[0] + rx * 0.86, top[1] + ry * 0.8), outline=(248, 245, 240, 255), width=max(3, int(rx * 0.06)))
    layer = layer.filter(ImageFilter.GaussianBlur(0.8))
    scene.alpha_composite(layer)


def draw_notebook(scene: Image.Image, cam: Cam, x0, y0, x1, y1, lines=9):
    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    quad = [cam.project((x0, y0, 1.2)), cam.project((x1, y0, 1.2)), cam.project((x1, y1, 1.2)), cam.project((x0, y1, 1.2))]
    if any(q is None for q in quad):
        return
    d.polygon(quad, fill=(246, 243, 234, 255))
    d.line([quad[0], quad[1], quad[2], quad[3], quad[0]], fill=(206, 200, 186, 255), width=3)
    # stitched left edge + ruled lines of handwriting
    for i in range(lines):
        t = (i + 1) / (lines + 1)
        p0 = (quad[0][0] + (quad[3][0] - quad[0][0]) * t, quad[0][1] + (quad[3][1] - quad[0][1]) * t)
        p1 = (quad[1][0] + (quad[2][0] - quad[1][0]) * t, quad[1][1] + (quad[2][1] - quad[1][1]) * t)
        a = 0.06 + 0.5 * (i % 3 == 0)
        p0 = (p0[0] + (p1[0] - p0[0]) * a, p0[1] + (p1[1] - p0[1]) * a)
        p1 = (p1[0] - (p1[0] - p0[0]) * 0.18, p1[1] - (p1[1] - p0[1]) * 0.18)
        d.line([p0, p1], fill=(88, 84, 78, 150), width=3)
    scene.alpha_composite(layer)


def draw_pen(scene: Image.Image, cam: Cam, x0, y0, x1, y1):
    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    p0, p1 = cam.project((x0, y0, 3.5)), cam.project((x1, y1, 3.5))
    if not p0 or not p1:
        return
    d.line([p0, p1], fill=(18, 19, 22, 255), width=11)
    d.line([p0, p1], fill=(52, 54, 60, 255), width=6)
    tip = (p1[0] + (p1[0] - p0[0]) * 0.10, p1[1] + (p1[1] - p0[1]) * 0.10)
    d.polygon([tip, (p1[0] - 4, p1[1] - 3), (p1[0] + 3, p1[1] + 4)], fill=(150, 150, 152, 255))
    d.line([(p0[0], p0[1] - 2), (p0[0] + (p1[0] - p0[0]) * 0.2, p0[1] + (p1[1] - p0[1]) * 0.2 - 2)],
           fill=(120, 122, 128, 200), width=2)
    scene.alpha_composite(layer)


def draw_sd_card(scene: Image.Image, cam: Cam, cx, cy, ang=18):
    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    wmm, hmm = 11.0, 15.0
    ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    pts = []
    for dx, dy in [(-wmm / 2, -hmm / 2), (wmm / 2, -hmm / 2), (wmm / 2, hmm / 2 - 3), (wmm / 2 - 3, hmm / 2), (-wmm / 2, hmm / 2)]:
        rx, ry = dx * ca - dy * sa, dx * sa + dy * ca
        p = cam.project((cx + rx, cy + ry, 2.2))
        if p is None:
            return
        pts.append(p)
    d.polygon(pts, fill=(38, 40, 44, 255))
    inner = [(x + (np.mean([p[0] for p in pts]) - x) * 0.12, y + (np.mean([p[1] for p in pts]) - y) * 0.12) for x, y in pts]
    d.polygon(inner, fill=(52, 55, 60, 255))
    # the gold contact fingers on the back
    for i in range(8):
        t = (i + 1) / 9
        p0 = (inner[0][0] + (inner[1][0] - inner[0][0]) * t, inner[0][1] + (inner[1][1] - inner[0][1]) * t)
        p1 = (inner[3][0] + (inner[2][0] - inner[3][0]) * t, inner[3][1] + (inner[2][1] - inner[3][1]) * t)
        d.line([p0, (p0[0] + (p1[0] - p0[0]) * 0.35, p0[1] + (p1[1] - p0[1]) * 0.35)], fill=(196, 168, 84, 220), width=2)
    scene.alpha_composite(layer)


def draw_grove_unit(scene: Image.Image, cam: Cam, cx, cy, label="ENV III", unit_w=34, unit_d=24, unit_h=13):
    """M5Stack Grove Unit ENV III-ish enclosure: grey box, label plate, vent slots."""
    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0 = cx - unit_w / 2, cy - unit_d / 2
    x1, y1 = cx + unit_w / 2, cy + unit_d / 2
    top = [cam.project((x0, y0, unit_h)), cam.project((x1, y0, unit_h)),
           cam.project((x1, y1, unit_h)), cam.project((x0, y1, unit_h))]
    bot = [cam.project((x0, y0, 0)), cam.project((x1, y0, 0)), cam.project((x1, y1, 0)), cam.project((x0, y1, 0))]
    if any(p is None for p in top + bot):
        return
    # front + right side
    d.polygon([top[3], top[2], bot[2], bot[3]], fill=(86, 88, 92, 255))
    d.polygon([top[1], top[2], bot[2], bot[1]], fill=(66, 68, 72, 255))
    d.polygon(top, fill=(210, 210, 208, 255))
    # label plate
    mid = [(p[0] * 0.62 + top[3][0] * 0.38, p[1] * 0.62 + top[3][1] * 0.38) for p in top]
    plate = [top[0], top[1], ((top[1][0] + top[2][0]) / 2, (top[1][1] + top[2][1]) / 2), ((top[0][0] + top[3][0]) / 2, (top[0][1] + top[3][1]) / 2)]
    d.polygon(plate, fill=(238, 238, 236, 255))
    tx = (top[0][0] + top[1][0]) / 2
    ty = (top[0][1] + top[3][1]) / 2
    d.text((tx - 26, ty - 8), label, font=font(F_BOLD, 17), fill=(40, 41, 44, 255))
    # vents on the side face
    for i in range(4):
        t = (i + 1) / 5.5
        p0 = (bot[3][0] + (bot[2][0] - bot[3][0]) * t, bot[3][1] + (bot[2][1] - bot[3][1]) * t)
        d.line([(p0[0], p0[1] - 4), (p0[0], p0[1] - 22)], fill=(52, 54, 58, 255), width=3)
    void = mid
    del void
    layer = layer.filter(ImageFilter.GaussianBlur(0.6))
    scene.alpha_composite(layer)


# --------------------------------------------------------------------------- #
#  Cables
# --------------------------------------------------------------------------- #
def bezier(p0, p1, p2, p3, n=220):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0]
        y = mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]
        pts.append((x, y))
    return pts


def draw_cable(scene: Image.Image, pts, width, colour, *, highlight=None, sag_shadow=True):
    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if sag_shadow:
        sh = [(p[0] + 4, p[1] + 12) for p in pts]
        d.line(sh, fill=(20, 12, 8, 90), width=width + 6)
        layer = layer.filter(ImageFilter.GaussianBlur(7))
        d = ImageDraw.Draw(layer)
    d.line(pts, fill=colour, width=width, joint="curve")
    if highlight:
        hi = [(p[0] - width * 0.18, p[1] - width * 0.28) for p in pts]
        d.line(hi, fill=highlight, width=max(2, width // 3), joint="curve")
    scene.alpha_composite(layer)


def draw_laptop(scene: Image.Image, cam: Cam, origin_mm, yaw_deg=26, lines=None, title="cardputer-emu"):
    """A laptop seen from behind-right: keyboard deck + tilted panel showing a terminal."""
    ox, oy = origin_mm
    ca, sa = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    base_w, base_d = 320, 225
    hinge_h, lid_d = 8, 205

    def world(dx, dy, z):
        return (ox + dx * ca - dy * sa, oy + dx * sa + dy * ca, z)

    deck = [world(0, 0, 0), world(base_w, 0, 0), world(base_w, base_d, 0), world(0, base_d, 0)]
    deck_top = [cam.project(p) for p in deck]
    # the lid leans back from the far edge
    lid = [world(0, base_d, hinge_h), world(base_w, base_d, hinge_h),
           world(base_w, base_d + 0, lid_d), world(0, base_d + 0, lid_d)]
    # give the lid a lean: tilt it backwards by pulling the far edge down/away
    lid = [world(0, base_d, hinge_h), world(base_w, base_d, hinge_h),
           world(base_w, base_d - 46, hinge_h + 168), world(0, base_d - 46, hinge_h + 168)]
    lid_top = [cam.project(p) for p in lid]
    if any(p is None for p in deck_top + lid_top):
        return None

    layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # deck side (thickness)
    thick = [world(0, 0, 0), world(base_w, 0, 0), world(base_w, 0, 9), world(0, 0, 9)]
    front = [cam.project(p) for p in thick]
    d.polygon(front, fill=(38, 40, 44, 255))
    d.polygon(deck_top, fill=(150, 152, 156, 255))
    d.polygon(lid_top, fill=(52, 54, 58, 255))

    # keyboard hint: rows of dark keycaps in perspective
    for r in range(5):
        for c in range(14):
            kx0 = 26 + c * 19.5
            ky0 = 24 + r * 14.0
            q = [world(kx0, ky0, 1.4), world(kx0 + 15, ky0, 1.4), world(kx0 + 15, ky0 + 10, 1.4), world(kx0, ky0 + 10, 1.4)]
            pp = [cam.project(p) for p in q]
            d.polygon(pp, fill=(74, 76, 80, 255))
    trackpad = [world(110, 150, 1.4), world(210, 150, 1.4), world(210, 200, 1.4), world(110, 200, 1.4)]
    d.polygon([cam.project(p) for p in trackpad], fill=(140, 142, 146, 255))
    scene.alpha_composite(layer)

    # screen: a real terminal panel, warped into the lid quad
    sw, sh = 1280, 800
    panel = Image.new("RGBA", (sw, sh), (16, 18, 22, 255))
    pd = ImageDraw.Draw(panel)
    pd.rectangle((0, 0, sw, 46), fill=(28, 30, 36, 255))
    pd.text((16, 12), "zsh — cardputer-emu — 132×38", font=font(F_MONO, 22), fill=(150, 156, 168, 255))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        pd.ellipse((sw - 120 + i * 34, 14, sw - 102 + i * 34, 32), fill=(*c, 255))
    yy = 66
    for line, colour in (lines or []):
        col = {"dim": (120, 128, 140), "hot": (126, 214, 138), "warn": (232, 184, 92), "txt": (206, 212, 222)}.get(colour, (206, 212, 222))
        pd.text((18, yy), line, font=font(F_MONO, 21), fill=(*col, 255))
        yy += 30
    pd.rectangle((12 + 0, 56, sw - 8, yy + 8), outline=(50, 54, 62, 255), width=1)
    warp_into(scene, panel, lid_top)


# --------------------------------------------------------------------------- #
#  Scene
# --------------------------------------------------------------------------- #
def build(screen_json: Path, out: Path, ppm=20, wide=False) -> None:
    scene_w, scene_h = (3200, 1800) if wide else (W, H)
    cam = Cam(eye=(-30, -390, 430), target=(70, 60, 12), fov=40, size=(scene_w, scene_h))

    # ---- desk -------------------------------------------------------------
    tex = wood_texture((scene_w, scene_h), seed=17)
    desk = np.clip(tex * desk_light((scene_w, scene_h)), 0, 255)
    scene = Image.fromarray(desk.astype(np.uint8), "RGB").convert("RGBA")

    # ---- laptop -----------------------------------------------------------
    term = [
        ("$ python cardputer.py", "txt"),
        ("  Cardputer EMU  v1.0.0   (stable · linux)", "dim"),
        ("  serving   127.0.0.1:8787   cardputer.html", "dim"),
        ("$ python cardputer.py --update", "txt"),
        ("  checking updates/manifest.json …", "dim"),
        ("  installed v1.0.0 → v1.1.0 available", "hot"),
        ("  sha256 ok · snapshot 20261107-2015", "dim"),
        ("  applied: catalog.json, apps/weather.js", "hot"),
        ("$ python cardputer.py --status", "txt"),
        ("  modules 28 · apps 16 · EXT header ready", "dim"),
    ]
    draw_laptop(scene, cam, origin_mm=(-210, 120), yaw_deg=14, lines=term)

    # ---- device -----------------------------------------------------------
    DEV_W, DEV_H, THICK = rd.FACE_W, rd.FACE_H, rd.THICK
    yaw, pos = math.radians(-17.0), (150.0, -10.0)
    ca, sa = math.cos(yaw), math.sin(yaw)

    def face_pt(u, v, z):          # u,v in mm from the face's top-left corner
        x, y = pos[0] + u * ca - v * sa, pos[1] + u * sa + v * ca
        return (x, y, z)

    top = [cam.project(face_pt(0, 0, THICK)), cam.project(face_pt(DEV_W, 0, THICK)),
           cam.project(face_pt(DEV_W, DEV_H, THICK)), cam.project(face_pt(0, DEV_H, THICK))]
    bot = [cam.project(face_pt(0, 0, 0)), cam.project(face_pt(DEV_W, 0, 0)),
           cam.project(face_pt(DEV_W, DEV_H, 0)), cam.project(face_pt(0, DEV_H, 0))]
    if any(p is None for p in top + bot):
        raise SystemExit("camera framing error")

    # contact shadow: silhouette on the desk, offset along the light direction
    shadow = Image.new("L", (scene_w, scene_h), 0)
    sd = ImageDraw.Draw(shadow)
    sd.polygon(bot, fill=255)
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    shifted = Image.new("L", (scene_w, scene_h), 0)
    shifted.paste(shadow, (int(58 * 1.0), int(30 * 1.0)))
    shadow_arr = np.array(shifted, dtype=np.float32) / 255.0
    a = np.array(scene.convert("RGB"), dtype=np.float32)
    a *= (1 - 0.62 * shadow_arr)[..., None]
    scene = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").convert("RGBA")

    # side walls: white shell above, charcoal base below (matches the real part)
    d = ImageDraw.Draw(scene)
    shell_split = 0.42                     # fraction of the height that is white shell
    for i, j in [(3, 0), (2, 1), (1, 2), (0, 3)]:
        hi_top = [top[i], top[j]]
        hi_mid = [cam.project(face_pt(*((0, 0) if i in (0, 3) else (DEV_W, 0)), THICK * (1 - shell_split)))] if False else None
        void = (hi_top, hi_mid)
        del void
    # front edge (bottom of the face image = nearest the camera) and right edge
    def edge_quad(i, j, z0, z1):
        u0, v0 = [(0, 0), (DEV_W, 0), (DEV_W, DEV_H), (0, DEV_H)][i]
        u1, v1 = [(0, 0), (DEV_W, 0), (DEV_W, DEV_H), (0, DEV_H)][j]
        return [cam.project(face_pt(u0, v0, z0)), cam.project(face_pt(u1, v1, z0)),
                cam.project(face_pt(u1, v1, z1)), cam.project(face_pt(u0, v0, z1))]
    white_top = THICK
    white_bot = THICK * (1 - shell_split)
    for i, j, shade in [(3, 2, (196, 195, 191)), (2, 1, (168, 168, 164)), (1, 2, (208, 207, 203)), (3, 0, (150, 150, 146))]:
        q = edge_quad(i, j, white_bot, white_top)
        if all(q):
            d.polygon(q, fill=shade)
    for i, j, shade in [(3, 2, (46, 49, 54)), (2, 1, (36, 38, 42)), (3, 0, (30, 32, 35)), (1, 2, (52, 55, 60))]:
        q = edge_quad(i, j, 0, white_bot)
        if all(q):
            d.polygon(q, fill=shade)

    # the face itself, warped into the projected quad
    face = rd.render_face(ppm, screen_json, pressed=(3, 1))
    warp_into(scene, face, top)

    # ---- screen bloom -----------------------------------------------------
    gx0, gy0, gx1, gy1 = rd.GLASS
    _bx0, _by0, _bx1, _by1 = rd.BEZEL
    glass_quad = [cam.project(face_pt(gx0, gy0, THICK)), cam.project(face_pt(gx1, gy0, THICK)),
                  cam.project(face_pt(gx1, gy1, THICK)), cam.project(face_pt(gx0, gy1, THICK))]
    glow = Image.new("RGB", (scene_w, scene_h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.polygon(glass_quad, fill=(120, 210, 150))
    glow = glow.filter(ImageFilter.GaussianBlur(46))
    scene = Image.fromarray(
        np.clip(np.array(scene.convert("RGB"), dtype=np.float32) + np.array(glow, dtype=np.float32) * 0.30, 0, 255
                ).astype(np.uint8), "RGB").convert("RGBA")

    # ---- cables -----------------------------------------------------------
    usb_a = cam.project(face_pt(DEV_W * 0.52, DEV_H, THICK - 4))     # top edge, USB-C
    usb_b = cam.project((-70, 210, 12))
    if usb_a and usb_b:
        c1 = (usb_a[0] - 120, usb_a[1] - 130)
        c2 = (usb_b[0] + 240, usb_b[1] + 90)
        pts = bezier(usb_a, c1, c2, usb_b)
        draw_cable(scene, pts, 13, (232, 231, 227, 255), highlight=(250, 250, 248, 200))
    # Grove lead from the Grove port to the ENV III unit
    grove_a = cam.project(face_pt(0, DEV_H * 0.62, THICK - 4))
    grove_b = cam.project((248, 26, 9))
    if grove_a and grove_b:
        pts = bezier(grove_a, (grove_a[0] - 80, grove_a[1] + 60), (grove_b[0] + 70, grove_b[1] + 46), grove_b)
        draw_cable(scene, pts, 20, (236, 236, 232, 255), highlight=None)

    # ---- props ------------------------------------------------------------
    draw_grove_unit(scene, cam, cx=232, cy=-4, label="ENV III")
    draw_sd_card(scene, cam, cx=120, cy=118, ang=-24)
    draw_notebook(scene, cam, x0=-60, y0=-150, x1=140, y1=-30)
    draw_pen(scene, cam, x0=20, y0=-60, x1=118, y1=-142)
    draw_mug(scene, cam, center_mm=(-30, -230), r_mm=36, h_mm=92)

    # ---- post -------------------------------------------------------------
    img = scene.convert("RGB")
    img = bloom(img, threshold=188, radius=34, gain=0.55)
    a = np.array(img, dtype=np.float32) * vignette((scene_w, scene_h), strength=0.42)
    # gentle warm grade + a touch of halation in the shadows
    a[..., 0] *= 1.035
    a[..., 2] *= 0.985
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    img = add_grain(img, amount=3.2)
    img = img.filter(ImageFilter.UnsharpMask(radius=2.2, percent=48, threshold=3))

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    img.resize((1600, int(1600 * scene_h / scene_w)), Image.LANCZOS).save(out.with_name(out.stem + "-1600.png"))
    print(f"wrote {out} ({img.width}x{img.height}) + {out.stem}-1600.png")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--screen", default="/tmp/screen_env.json")
    ap.add_argument("--out", default="art/cardputer-desk.png")
    ap.add_argument("--ppm", type=int, default=20)
    ap.add_argument("--wide", action="store_true")
    args = ap.parse_args()
    build(Path(args.screen), ROOT / args.out, args.ppm, args.wide)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
