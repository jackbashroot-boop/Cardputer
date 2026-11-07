#!/usr/bin/env python3
"""Bundle src/ into a single self-contained cardputer.html.

The bundle is what the launcher serves and what you can double-click on any OS.
Run:  python build.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT            # keeps the bundle out of build-only directories

# dependency order matters: every module is concatenated into one <script type=module>
ORDER = [
    "js/core/util.js",
    "js/core/font.js",
    "js/core/hardware.js",
    "js/core/peripherals.js",
    "js/core/flash.js",
    "js/modules/modules.js",
    "js/core/device.js",
    "js/rt/runtime.js",
    "js/apps/apps.js",
    "js/ui/chassis.js",
    "js/ui/panels.js",
    "js/ui/updater.js",
    "js/main.js",
]

IMPORT_RE = re.compile(r"^\s*import\s[^;]*?;\s*$", re.M)
EXPORT_LIST_RE = re.compile(r"^\s*export\s*\{[^}]*\};?\s*$", re.M)
EXPORT_DECL_RE = re.compile(r"^(\s*)export\s+(async\s+function|function|class|const|let|var)\s", re.M)


def strip_module_syntax(src: str, name: str) -> str:
    src = IMPORT_RE.sub("", src)
    src = EXPORT_LIST_RE.sub("", src)
    src = EXPORT_DECL_RE.sub(r"\1\2 ", src)
    if re.search(r"^\s*(import|export)\s", src, re.M):
        raise SystemExit(f"build: unbundled module syntax left in {name}")
    return src


def read_version() -> str:
    try:
        return (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "1.0.0"


def bundle_js() -> str:
    parts = []
    for rel in ORDER:
        path = SRC / rel
        if not path.exists():
            raise SystemExit(f"build: missing source file {rel}")
        body = strip_module_syntax(path.read_text(encoding="utf-8"), rel)
        banner = f"\n// ────────────────────────────────────────────── {rel}\n"
        parts.append(banner + body)
    return "".join(parts)


def build(version: str | None = None) -> Path:
    version = version or read_version()
    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "css" / "emulator.css").read_text(encoding="utf-8")
    js = bundle_js()

    feed_path = ROOT / "updates" / "manifest.json"
    feed = feed_path.read_text(encoding="utf-8") if feed_path.exists() else '{"releases":[]}'

    html = html.replace(
        '<link rel="stylesheet" href="css/emulator.css">',
        "<style>\n" + css + "\n</style>",
    )
    html = html.replace(
        '<script type="module" src="js/main.js"></script>',
        '<script type="application/json" id="feed-manifest">' + feed + "</script>\n"
        + '<script type="module">\n"use strict";\n'
        + f"const EMU_BUILD = {{ version: {json.dumps(version)}, built: {json.dumps(__import__('time').strftime('%Y-%m-%dT%H:%M:%S'))} }};\n"
        + js + "\n</script>",
    )
    html = html.replace("__EMU_VERSION__", version)

    DIST.mkdir(parents=True, exist_ok=True)
    out = ROOT / "cardputer.html"
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    path = build()
    size = path.stat().st_size
    print(f"built {path.relative_to(ROOT)}  ({size/1024:.1f} KB)")
