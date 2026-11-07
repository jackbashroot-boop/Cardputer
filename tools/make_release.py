#!/usr/bin/env python3
"""Pack the project into the distributable zip (stdlib only).

    python3 tools/make_release.py                    # -> dist/cardputer-emu-<version>.zip
    python3 tools/make_release.py --out /tmp/x.zip   # somewhere else
    python3 tools/make_release.py --with-screenshots # keep the big art renders too
    python3 tools/make_release.py --no-bundle        # ship sources only (installer builds the UI)
    python3 tools/make_release.py --verify           # unzip to a temp dir and run the installer

The archive is self-contained: unzip it anywhere, run install.py (or double-click
install.sh / install.command / install.bat), and the installer creates the UI if
it is not already inside. Nothing is fetched from the network and nothing needs
pip, node or admin rights.

What goes in:
  * the runtime: install.*, run.*, build.py, cardputer/ (Python package),
    src/ (the UI sources — this is what "creates the UI as needed" builds from),
    updates/ (the release feed), VERSION
  * the docs a user may want: README.md, START-HERE.txt, docs/ (incl. the UI shots
    the README embeds)
  * the quality tools and tests, so the claim "verified" can be checked locally
Excluded on purpose: data/ (per-install state), dist/, .toolchain/, node_modules,
__pycache__, art/*.png above the size cap (the huge desk renders).
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

INCLUDE_FILES = [
    "install.py", "install.sh", "install.command", "install.bat",
    "run.py", "run.sh", "run.command", "run.bat",
    "build.py", "VERSION", "README.md", "START-HERE.txt",
]
INCLUDE_DIRS = [
    "src", "cardputer", "updates", "docs", "tests", "tools", "art",
]
# The bundle itself: 300 KB, and the installer can rebuild it from src/.
OPTIONAL_FILES = ["cardputer.html"]

EXCLUDE_DIRS = {"__pycache__", "node_modules", ".toolchain", "dist", "data",
                ".git", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv"}
EXCLUDE_GLOBS = [
    "*.pyc", "*.pyo", "*.log", "*.zip", "*.tmp", ".DS_Store", "Thumbs.db",
    "art/*.png",              # hero renders: re-added below when asked for
]
ART_ALLOW = ["art/device.png"]
ART_BIG_ALLOW = {"art/cardputer-desk.png", "art/cardputer-desk-1600.png", "art/desk-plate.png"}
BIG_FILE_LIMIT = 3 * 1024 * 1024     # single-file cap unless explicitly allowed


def say(msg: str = "") -> None:
    print(msg, flush=True)


def version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def skip(rel: str, big_ok: bool) -> bool:
    parts = Path(rel).parts
    if any(part in EXCLUDE_DIRS for part in parts):
        return True
    name = Path(rel).name
    if rel.startswith("updates/packages/"):
        return False          # the release packages the updater installs
    for pat in EXCLUDE_GLOBS:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(name, pat):
            if rel in ART_ALLOW or (big_ok and rel in ART_BIG_ALLOW):
                break
            return True
    return bool(not big_ok and (ROOT / rel).stat().st_size > BIG_FILE_LIMIT)


def collect(*, with_bundle: bool, with_screenshots: bool) -> list[Path]:
    files: list[Path] = []
    for name in INCLUDE_FILES + (OPTIONAL_FILES if with_bundle else []):
        path = ROOT / name
        if path.exists():
            files.append(path)
    for name in INCLUDE_DIRS:
        base = ROOT / name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file():
                files.append(path)
    seen, out = set(), []
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if rel in seen:
            continue
        seen.add(rel)
        if skip(rel, big_ok=with_screenshots):
            continue
        out.append(path)
    return sorted(out, key=lambda p: p.relative_to(ROOT).as_posix())


def build_archive(files: list[Path], out: Path, top: str) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            rel = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo.from_file(path, arcname=f"{top}/{rel}")
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if os.access(path, os.X_OK) else 0o644) << 16
            with open(path, "rb") as fh:
                zf.writestr(info, fh.read())
        # keep empty runtime folders present so the layout is obvious after unzip
        for folder in ("data",):
            zf.writestr(zipfile.ZipInfo(f"{top}/{folder}/.keep", time.localtime()[:6]), "")
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    return {"zip": out, "bytes": out.stat().st_size, "sha256": digest,
            "entries": len(files), "top": top}


def verify(zip_path: Path, top: str, run_installer: bool = True) -> bool:
    """Unzip into a temp dir and prove the result installs and answers HTTP."""
    say("\n  verifying the archive …")
    tmp = Path(tempfile.mkdtemp(prefix="cardputer-release-"))
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        root = tmp / top
        ok = True
        for needed in ("install.py", "run.py", "cardputer", "src"):
            if not (root / needed).exists():
                say(f"  ✖ {needed} is missing from the archive")
                ok = False
        if not ok:
            return False
        size = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        say(f"  ✔ extracted {size / 1024 / 1024:.1f} MB into {root}")
        if not run_installer:
            return True
        env = {**os.environ, "HOME": str(tmp / "home"), "PYTHONDONTWRITEBYTECODE": "1"}
        real_cache = Path(os.environ.get("HOME", "~")).expanduser() / ".cache" / "ms-playwright"
        if real_cache.is_dir():
            env["PLAYWRIGHT_BROWSERS_PATH"] = str(real_cache)
        (tmp / "home").mkdir(exist_ok=True)
        t0 = time.time()
        res = subprocess.run([sys.executable, "install.py", "--yes", "--no-shortcuts"],
                             cwd=root, capture_output=True, text=True, timeout=900, env=env)
        took = time.time() - t0
        for line in res.stdout.splitlines():
            if any(mark in line for mark in ("✔", "✖", "!")):
                say("   " + line.strip())
        if res.returncode != 0:
            say(f"  ✖ the installer inside the archive failed (exit {res.returncode})")
            say((res.stderr or res.stdout)[-1200:])
            return False
        say(f"  ✔ installer finished inside the archive in {took:.1f}s")
        if not (root / "cardputer.html").exists():
            say("  ✖ the installer did not create cardputer.html")
            return False
        status = subprocess.run([sys.executable, "run.py", "--status"], cwd=root,
                                capture_output=True, text=True, timeout=120)
        lines = [ln.strip() for ln in status.stdout.splitlines() if ln.strip()]
        pick = next((ln for ln in lines if "installed" in ln.lower()), lines[-1] if lines else "ok")
        say("  ✔ run.py --status: " + pick)
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(prog="make_release.py", description=__doc__.splitlines()[0])
    ap.add_argument("--out", help="path of the zip to write")
    ap.add_argument("--with-screenshots", action="store_true", help="include the big art renders")
    ap.add_argument("--no-bundle", action="store_true", help="do not ship cardputer.html")
    ap.add_argument("--no-verify", action="store_true", help="skip the extract + install check")
    args = ap.parse_args()

    ver = version()
    top = f"cardputer-emu-{ver}"
    out = Path(args.out) if args.out else DIST / f"{top}.zip"

    # a stale bundle would ship a UI that does not match the sources
    if not args.no_bundle and not (ROOT / "cardputer.html").exists():
        say("  building cardputer.html first …")
        subprocess.run([sys.executable, "build.py"], cwd=ROOT, check=True)

    files = collect(with_bundle=not args.no_bundle, with_screenshots=args.with_screenshots)
    say(f"  packing {len(files)} files from {ROOT}")
    info = build_archive(files, out, top)
    say(f"  ✔ {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
    say(f"     {info['bytes'] / 1024:.0f} KB · {info['entries']} files · "
        f"sha256 {info['sha256'][:16]}…")

    sums = out.with_suffix(out.suffix + ".sha256")
    sums.write_text(f"{info['sha256']}  {out.name}\n", encoding="utf-8")
    say(f"  ✔ {sums.name} written")

    if not args.no_verify and not verify(out, top):
        say("\n  ✖ release verification FAILED\n")
        return 1
    say(f"\n  done: {out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
