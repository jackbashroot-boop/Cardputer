#!/usr/bin/env python3
"""Composite the accurate Cardputer render onto a photographic desk plate.

Two sources are combined:

  1. ``art/desk-plate.png`` — a photographic desk (generated once, checked into
     the repo) with deliberate empty space in the middle;
  2. the georeferenced device model from ``tools/render_device.py``, projected in
     3D at 84 x 54 x 19.7 mm with a real emulator framebuffer on the LCD.

The result is lit to match the plate (warm key from the upper left, cool bounce),
with a cast shadow whose penumbra grows with distance, contact shading, screen
bloom, a USB-C lead and a Grove lead to a physically modelled ENV III unit — so
the shot reads as a machine that is actually running.

    python3 tools/compose_art.py --plate art/desk-plate.png --screen /tmp/screen_env.json \
        --out art/cardputer-desk.png
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import render_device as rd
from desk_scene import Cam, add_grain, bloom, draw_cable, quad_mask, warp_flat
from PIL import Image, ImageDraw, ImageFilter
from render_device import font as make_font

ROOT = Path(__file__).resolve().parent.parent
OUT_W, OUT_H = 2560, 1600


# --------------------------------------------------------------------------- #
def device_sprite(ppm: int, screen_json: Path, yaw_deg: float, press=(3, 1),
                  width_px: int | None = None):
    """Project the device model into its own RGBA sprite; returns sprite + geometry.

    The camera is normalised, then scaled so the projected face is *already* the size
    the frame needs; that keeps the only resampling a single perspective warp. Reusing
    the scene camera left the device at ~550 px and the sprite had to be upscaled ~2x,
    which both blurred the keys and produced a dotted alpha rim.
    """
    W, H, T = rd.FACE_W, rd.FACE_H, rd.THICK
    yaw = math.radians(yaw_deg)
    ca, sa = math.cos(yaw), math.sin(yaw)
    cam0 = Cam(eye=(0, -290, 330), target=(0, 0, 9), fov=22, size=(1.0, 1.0))

    def pt(u, v, z):
        return (u * ca - v * sa, u * sa + v * ca, z)

    def nproj(p):
        q = cam0.project(p)
        return (q[0] - 0.5, q[1] - 0.5)

    quad_n = [nproj(pt(0, H, T)), nproj(pt(W, H, T)), nproj(pt(W, 0, T)), nproj(pt(0, 0, T))]
    span = (quad_n[1][0] - quad_n[0][0]) / W                    # normalised units per mm
    if width_px:
        ppm = max(6, round(width_px / W))
    S = ppm / span                                              # px per normalised unit

    pts = [nproj(pt(u, v, z)) for u in (0, W) for v in (0, H) for z in (0, T)]
    xs = [p[0] * S for p in pts]
    ys = [p[1] * S for p in pts]
    m = 26
    ox, oy = m - min(xs), m - min(ys)
    canvas = (int(max(xs) - min(xs)) + 2 * m, int(max(ys) - min(ys)) + 2 * m)

    def P(p):
        return (p[0] * S + ox, p[1] * S + oy)

    top = [P(q) for q in quad_n]
    bot = [P(nproj(pt(0, H, 0))), P(nproj(pt(W, H, 0))), P(nproj(pt(W, 0, 0))), P(nproj(pt(0, 0, 0)))]
    sprite = Image.new("RGBA", canvas, (0, 0, 0, 0))

    # Slab thickness as a single offset: project the same point at the top and at the
    # desk plane, then extrude the face silhouette by it (twice: shell, then base).
    near, near0 = pt(W / 2, 0, T), pt(W / 2, 0, 0)
    p_top, p_bot = P(nproj(near)), P(nproj(near0))
    delta = (p_bot[0] - p_top[0], p_bot[1] - p_top[1])
    split = 0.42                                    # white shell : charcoal base
    # underlay: no rim at the corners. Drawn through an AA mask, not ImageDraw.polygon,
    # because a hard-aliased polygon edge shows as a staircase around the silhouette.
    sprite.alpha_composite(Image.merge("RGBA", (*[Image.new("L", canvas, c) for c in (172, 172, 168)],
                                                   quad_mask(canvas, top, ss=4).filter(ImageFilter.GaussianBlur(0.8)))))

    def extruded(mask, frac, colour):
        off = (round(delta[0] * frac), round(delta[1] * frac))
        layer = Image.new("RGBA", canvas, colour)
        layer.putalpha(mask)
        sprite.alpha_composite(layer, off)

    # Render oversampled then area-average down to the frame density, so thin bevel
    # and moulding lines stay continuous instead of moire-ing through the warp.
    pp = max(ppm + 1, round(ppm * 1.7))
    face = rd.render_face(pp, screen_json, pressed=press)
    gx0, gy0, gx1, gy1 = rd.GLASS
    panel = face.crop((int(gx0 * pp), int(gy0 * pp), int(gx1 * pp), int(gy1 * pp)))
    px = np.array(panel.convert("RGB"), dtype=np.float32)
    px = np.clip((px / 255.0) ** 0.80 * 255.0 * 1.30 - 6, 0, 255)      # backlight lift, deeper blacks
    panel = Image.fromarray(np.clip(px, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    panel.putalpha(panel.split()[3])
    face.paste(panel, (int(gx0 * pp), int(gy0 * pp)))
    # area-average the oversampled face, keeping colour and coverage apart (see warp_flat)
    tgt = (round(W * ppm), round(H * ppm))
    keep = face.split()[3].resize(tgt, Image.LANCZOS)
    face = Image.alpha_composite(Image.new("RGBA", face.size, (*face.getpixel((1, 1))[:3], 255)), face)
    face = face.convert("RGB").resize(tgt, Image.LANCZOS).convert("RGBA")
    face.putalpha(keep)
    flat, _pos = warp_flat(face, top, canvas)

    # walls are the face's own silhouette, extruded: identical edges, so no seam
    # Erode the extruded layers by a pixel: on the far sides the translated silhouette
    # has nowhere to go, and its antialiased sliver pokes out of the face as a dark
    # 1 px outline all the way round the chassis.
    alph = flat.split()[3].filter(ImageFilter.MinFilter(3))
    extruded(alph, 1.0, (36, 38, 42, 255))                # charcoal base
    extruded(alph, split, (146, 145, 141, 255))           # white shell band
    sprite.alpha_composite(flat, (0, 0))

    # face-space v runs from the far edge towards the camera, so mirror it
    glass = [P(nproj(pt(gx0, H - gy1, T))), P(nproj(pt(gx1, H - gy1, T))),
             P(nproj(pt(gx1, H - gy0, T))), P(nproj(pt(gx0, H - gy0, T)))]
    return sprite, top, bot, glass


def plate_tint(scene: Image.Image, box) -> np.ndarray:
    """Mean colour of the desk around the device, so the sprite inherits the light."""
    x0, y0, x1, y1 = [int(v) for v in box]
    patch = np.array(scene.convert("RGB").crop((max(0, x0), max(0, y0), x1, y1)), dtype=np.float32)
    if patch.size == 0:
        return np.array([1.0, 1.0, 1.0], dtype=np.float32)
    mean = patch.reshape(-1, 3).mean(axis=0)
    ref = np.array([168, 132, 108], dtype=np.float32)      # neutral warm wood
    ratio = np.clip(mean / ref, 0.6, 1.45)
    return 0.45 * ratio + 0.55


def brighten_polygon(sprite: Image.Image, quad, gain=1.45) -> Image.Image:
    """The panel is emissive: undo the scene lighting over the glass only."""
    mask = Image.new("L", sprite.size, 0)
    ImageDraw.Draw(mask).polygon(quad, fill=255)
    a = np.array(sprite.convert("RGB"), dtype=np.float32)
    m = (np.array(mask, dtype=np.float32) / 255.0)[..., None]
    a = a * (1 - m) + np.clip(a * gain, 0, 255) * m
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    out.putalpha(sprite.split()[3])
    return out


def tint_to_plate(sprite: Image.Image, warm=(1.06, 1.0, 0.94)) -> Image.Image:
    a = np.array(sprite.convert("RGB"), dtype=np.float32)
    alpha = np.array(sprite.split()[3], dtype=np.float32) / 255.0
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    light = 0.80 + 0.34 * np.exp(-(((xx / w - 0.26) / 0.52) ** 2 + ((yy / h - 0.18) / 0.58) ** 2))
    a = a * light[..., None]
    rng = np.random.default_rng(4)
    a += rng.normal(0, 1.5, (h, w, 1))                                          # plastic micro-texture
    a[..., 0] *= 1.03
    a[..., 2] *= 0.96
    a[..., 0] *= warm[0]
    a[..., 1] *= warm[1]
    a[..., 2] *= warm[2]
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    out.putalpha(sprite.split()[3])
    return out


def scale_quad(q, k, dx, dy):
    return [(p[0] * k + dx, p[1] * k + dy) for p in q]


def grove_unit_sprite(ppm: int, label="ENV III", wmm=34, dmm=26, hmm=12, canvas=(520, 380)):
    """Small Grove Unit box drawn with the same projection, so the light matches."""
    cam = Cam(eye=(0, -190, 160), target=(0, 0, 5), fov=30, size=canvas)
    x0, y0, x1, y1 = -wmm / 2, -dmm / 2, wmm / 2, dmm / 2
    top = [cam.project((x0, y0, hmm)), cam.project((x1, y0, hmm)),
           cam.project((x1, y1, hmm)), cam.project((x0, y1, hmm))]
    bot = [cam.project((x0, y0, 0)), cam.project((x1, y0, 0)),
           cam.project((x1, y1, 0)), cam.project((x0, y1, 0))]
    img = Image.new("RGBA", canvas, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([bot[0], bot[1], top[1], top[0]], fill=(74, 76, 80, 255))       # front wall
    d.polygon([bot[1], bot[2], top[2], top[1]], fill=(50, 52, 56, 255))       # right wall
    d.polygon(top, fill=(196, 196, 192, 255))
    # label plate
    mx = [top[0][0] + (top[3][0] - top[0][0]) * 0.16, top[0][1] + (top[3][1] - top[0][1]) * 0.16]
    plate = [top[0], top[1], (top[1][0] + (top[2][0] - top[1][0]) * 0.55, top[1][1] + (top[2][1] - top[1][1]) * 0.55),
             (mx[0] + (top[2][0] - top[3][0]) * 0.0, mx[1])]
    d.polygon(plate, fill=(243, 243, 240, 255))
    f = make_font(rd.F_BOLD, max(8, int(dmm * ppm * 0.20)))
    tx = top[0][0] + 14
    ty = top[0][1] + (top[3][1] - top[0][1]) * 0.42
    d.text((tx, ty), label, font=f, fill=(36, 37, 40, 255))
    # vent slots on the front wall
    for i in range(4):
        t = 0.18 + i * 0.16
        p0 = (bot[0][0] + (bot[1][0] - bot[0][0]) * t, bot[0][1] + (bot[1][1] - bot[0][1]) * t)
        p1 = (top[0][0] + (top[1][0] - top[0][0]) * t, top[0][1] + (top[1][1] - top[0][1]) * t)
        d.line([p0, p1], fill=(44, 46, 50, 255), width=max(2, int(hmm * ppm * 0.06)))
    return img, top


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plate", default="art/desk-plate.png")
    ap.add_argument("--screen", default="/tmp/screen_env.json")
    ap.add_argument("--out", default="art/cardputer-desk.png")
    ap.add_argument("--yaw", type=float, default=-13.0)
    ap.add_argument("--width", type=float, default=0.44, help="device width as a fraction of the frame")
    ap.add_argument("--centre", default="0.545,0.545", help="device centre, fraction of the frame")
    ap.add_argument("--no-grove", action="store_true")
    ap.add_argument("--dump-steps", help="write the frame after each stage to this directory")
    args = ap.parse_args()

    plate_path = ROOT / args.plate
    if not plate_path.exists():
        raise SystemExit(f"missing plate {plate_path} — pass --plate")
    plate = Image.open(plate_path).convert("RGB")
    # cover-fit the plate to the output frame
    sc = max(OUT_W / plate.width, OUT_H / plate.height)
    plate = plate.resize((max(OUT_W, int(plate.width * sc)), max(OUT_H, int(plate.height * sc))), Image.LANCZOS)
    left = (plate.width - OUT_W) // 2
    top_crop = (plate.height - OUT_H) // 2
    plate = plate.crop((left, top_crop, left + OUT_W, top_crop + OUT_H))
    scene = plate.convert("RGBA")

    def dump(tag):
        if args.dump_steps:
            d = Path(args.dump_steps)
            d.mkdir(parents=True, exist_ok=True)
            (scene if isinstance(scene, Image.Image) else plate).convert("RGB").save(d / f"{tag}.png")

    dump("00-plate")
    # ---- device -----------------------------------------------------------
    target_w = args.width * OUT_W
    # pick the density so the face lands in the canvas at (almost) 1:1 with the frame
    # Supersample the face: a thin bevel line resampled at ~1:1 turns into a dashed
    # moire, which is exactly the fringe the eye picks up on a rendered product shot.
    ppm = max(8, round(target_w / rd.FACE_W))
    sprite, top, bot, glass = device_sprite(ppm, Path(args.screen), args.yaw, width_px=int(target_w))
    edge = math.hypot(top[1][0] - top[0][0], top[1][1] - top[0][1])   # the W edge
    k = target_w / edge
    cx_frac, cy_frac = (float(v) for v in args.centre.split(","))
    dev_cx = (min(p[0] for p in top) + max(p[0] for p in top)) / 2
    dev_cy = (min(p[1] for p in top) + max(p[1] for p in top)) / 2
    dx = OUT_W * cx_frac - dev_cx * k
    dy = OUT_H * cy_frac - dev_cy * k
    # The face is already rendered at the density the frame needs; resampling an RGBA
    # sprite (LANCZOS on a soft alpha edge) is what produced the dotted rim, so only
    # rescale for a real size correction.
    if abs(k - 1.0) > 0.03:
        sprite = sprite.resize((int(sprite.width * k), int(sprite.height * k)), Image.LANCZOS)
    else:
        k = 1.0
    sprite = tint_to_plate(sprite)
    glass_local = [(p[0] * k, p[1] * k) for p in glass]
    sprite = brighten_polygon(sprite, glass_local, gain=1.60)
    top_k, bot_k, glass_k = (scale_quad(q, k, dx, dy) for q in (top, bot, glass))

    dump("01-sprite-ready")
    # ---- shadows on the plate -------------------------------------------
    # light comes from the upper left in the plate, so the shadow falls lower-right
    shadow = quad_mask((OUT_W, OUT_H), bot_k, ss=3)
    wide = shadow.filter(ImageFilter.GaussianBlur(46))
    tight = shadow.filter(ImageFilter.GaussianBlur(9))
    wide = wide.transform(wide.size, Image.AFFINE, (1, 0, -34, 0, 1, -22), resample=Image.BILINEAR)
    arr = np.array(scene.convert("RGB"), dtype=np.float32)
    arr *= (1 - 0.68 * (np.array(wide.filter(ImageFilter.GaussianBlur(26)), dtype=np.float32) / 255.0))[..., None]
    arr *= (1 - 0.34 * (np.array(tight, dtype=np.float32) / 255.0))[..., None]
    scene = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").convert("RGBA")

    dump("02-shadows")
    # ---- screen bloom before the device is pasted (so it spills onto the desk)
    gm = quad_mask((OUT_W, OUT_H), glass_k, ss=3)
    glow = Image.new("RGB", (OUT_W, OUT_H), (0, 0, 0))
    glow.paste((96, 176, 128), (0, 0), gm)
    glow = glow.filter(ImageFilter.GaussianBlur(38))
    arr = np.array(scene.convert("RGB"), dtype=np.float32) + np.array(glow, dtype=np.float32) * 0.42
    scene = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").convert("RGBA")

    dump("03-glow")
    # ---- cable routing (from the real port positions) --------------------
    def lerp(a, b, t):
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    FL, FR, _NR, NL = top_k          # far-left, far-right, near-right, near-left
    usb_start = lerp(FL, FR, 0.56)  # USB-C sits on the top (far) edge
    grove_start = lerp(NL, FL, 0.58)  # Grove port on the left flank

    def plug(scene, at, direction, size=17, colour=(30, 32, 36, 255)):
        d = ImageDraw.Draw(scene)
        ux, uy = direction
        n = math.hypot(ux, uy) or 1.0
        ux, uy = ux / n, uy / n
        px_, py_ = -uy, ux
        pts = [(at[0] - px_ * size * 0.55, at[1] - py_ * size * 0.55),
               (at[0] + px_ * size * 0.55, at[1] + py_ * size * 0.55),
               (at[0] + px_ * size * 0.55 + ux * size * 0.55, at[1] + py_ * size * 0.55 + uy * size * 0.55),
               (at[0] - px_ * size * 0.55 + ux * size * 0.55, at[1] - py_ * size * 0.55 + uy * size * 0.55)]
        d.polygon(pts, fill=colour)
        d.line([*pts, pts[0]], fill=(96, 98, 104, 255), width=1)

    # Grove lead: exits the left flank and runs off-frame to the ENV III unit
    grove_end = (OUT_W * 0.045, OUT_H * 1.01)
    gmid = ((grove_start[0] + grove_end[0]) / 2 + 40, (grove_start[1] + grove_end[1]) / 2 + 150)
    pts = [((1 - t) ** 2 * grove_start[0] + 2 * (1 - t) * t * gmid[0] + t * t * grove_end[0],
            (1 - t) ** 2 * grove_start[1] + 2 * (1 - t) * t * gmid[1] + t * t * grove_end[1])
           for t in np.linspace(0, 1, 70)]
    draw_cable(scene, pts, 13, (232, 231, 226, 255), highlight=(250, 250, 248, 205))
    plug(scene, grove_start, (grove_start[0] - grove_end[0], grove_start[1] - grove_end[1]), size=15)

    # USB-C lead out of the far edge towards the laptop
    end = (OUT_W * 0.395, OUT_H * 0.205)
    mid = ((usb_start[0] + end[0]) / 2 - 30, (usb_start[1] + end[1]) / 2 - 90)
    pts = [((1 - t) ** 2 * usb_start[0] + 2 * (1 - t) * t * mid[0] + t * t * end[0],
            (1 - t) ** 2 * usb_start[1] + 2 * (1 - t) * t * mid[1] + t * t * end[1])
           for t in np.linspace(0, 1, 70)]
    draw_cable(scene, pts, 13, (230, 229, 225, 255), highlight=(250, 250, 248, 205))
    plug(scene, usb_start, (usb_start[0] - end[0], usb_start[1] - end[1]), size=16)
    plug(scene, end, (end[0] - usb_start[0], end[1] - usb_start[1]), size=18, colour=(24, 25, 28, 255))

    dump("04-cables")
    # ---- paste the device ------------------------------------------------
    scene.alpha_composite(sprite, (int(dx), int(dy)))

    if args.dump_steps:
        sprite.save(Path(args.dump_steps) / "sprite.png")
    dump("05-pasted")
    # ---- grade ------------------------------------------------------------
    img = scene.convert("RGB")
    img = bloom(img, threshold=218, radius=26, gain=0.12)
    a = np.array(img, dtype=np.float32)
    a[..., 0] *= 1.02
    a[..., 2] *= 0.99
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    img = add_grain(img, amount=1.5)
    img = img.filter(ImageFilter.UnsharpMask(radius=1.6, percent=24, threshold=3))

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    img.resize((1600, int(1600 * OUT_H / OUT_W)), Image.LANCZOS).save(out.with_name(out.stem + "-1600.png"))
    print(f"wrote {out} ({img.width}x{img.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
