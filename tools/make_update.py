#!/usr/bin/env python3
"""Build a signed-by-hash update package and publish it into the release feed.

    python tools/make_update.py \
        --version 1.1.0 --channel stable \
        --files updates/catalog.json updates/apps/weather.js \
        --soft '{"catalog":"updates/catalog.json","apps":["updates/apps/weather.js"]}' \
        --note "Grove catalog: Unit CO2, Accel, Kmeter" \
        --note "New firmware app: Weather"

Writes updates/packages/cardputer-emu-<version>.zip and rewrites the release
entry (version, channel, date, sha256, size, notes, soft) inside
updates/manifest.json. Re-running for the same version replaces the entry.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ROOT / "updates" / "packages"
MANIFEST = ROOT / "updates" / "manifest.json"


def version_key(text: str):
    core = text.split("-")[0].split(".")
    try:
        nums = tuple(int(p) for p in [*core, "0", "0", "0"][:3])
    except ValueError:
        nums = (0, 0, 0)
    return (*nums, 0 if "-" in text else 1, text)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="build an update package + feed entry")
    ap.add_argument("--version", required=True)
    ap.add_argument("--channel", default="stable", choices=["stable", "beta"])
    ap.add_argument("--date", default=date.today().isoformat())
    ap.add_argument("--files", nargs="+", required=True, help="repo-relative files to ship")
    ap.add_argument("--soft", default="{}", help="JSON object: catalogs/apps applied without a restart")
    ap.add_argument("--note", action="append", default=[], help="release note line (repeatable)")
    ap.add_argument("--min-version", default="1.0.0")
    args = ap.parse_args(argv)

    PACKAGES.mkdir(parents=True, exist_ok=True)
    out = PACKAGES / f"cardputer-emu-{args.version}.zip"

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("VERSION", args.version + "\n")
        for rel in args.files:
            src = ROOT / rel
            if not src.exists():
                print(f"missing file: {rel}", file=sys.stderr)
                return 2
            zf.write(src, arcname=rel)
        if (ROOT / "updates" / "CHANGELOG.md").exists():
            zf.write(ROOT / "updates" / "CHANGELOG.md", arcname="updates/CHANGELOG.md")

    entry = {
        "version": args.version,
        "channel": args.channel,
        "date": args.date,
        "notes": args.note or [f"release {args.version}"],
        "requires": args.min_version,
        "url": f"updates/packages/{out.name}",
        "sha256": sha256_of(out),
        "size": out.stat().st_size,
        "soft": json.loads(args.soft),
    }

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"schema": 1, "app": "cardputer-emu", "releases": []}
    manifest["generated"] = args.date
    releases = [r for r in manifest.get("releases", []) if r.get("version") != args.version]
    releases.append(entry)
    releases.sort(key=lambda r: version_key(r["version"]), reverse=True)
    manifest["releases"] = releases
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"package  {out.relative_to(ROOT)}  ({entry['size']} bytes)")
    print(f"sha256   {entry['sha256']}")
    print(f"feed     {MANIFEST.relative_to(ROOT)}  ({len(releases)} release(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
