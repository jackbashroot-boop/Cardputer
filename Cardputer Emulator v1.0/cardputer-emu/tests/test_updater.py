#!/usr/bin/env python3
"""Updater tests: runs the real check → apply → rollback cycle inside a throwaway
copy of the project, then proves a tampered package is rejected.

    python3 tests/test_updater.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cardputer.updater import Updater, compare, installed_version, version_key  # noqa: E402

passed = failed = 0


def check(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"  \u2713 {name}")
    except Exception as exc:
        failed += 1
        print(f"  \u2717 {name}\n      {exc}")


def sandbox() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="cardputer-emu-test-"))
    for name in ("VERSION", "updates", "dist"):
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, tmp / name)
        elif src.exists():
            shutil.copy2(src, tmp / name)
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    return tmp


def main() -> int:
    print("\nCardputer EMU updater tests\n")

    def version_math():
        assert compare("1.1.0", "1.0.0") == 1
        assert compare("1.0.0", "1.0.0") == 0
        assert compare("1.0.1", "1.2.0") == -1
        assert compare("1.1.0", "1.1.0-beta.1") == 1
        assert version_key("1.10.0") > version_key("1.9.9")

    def check_finds_update():
        root = sandbox()
        up = Updater(root=root)
        res = up.check(channel="stable")
        assert res["ok"], res
        assert res["current"] == "1.0.0", res["current"]
        assert res["available"] and res["available"]["version"] == "1.1.0", res

    def apply_then_rollback():
        root = sandbox()
        up = Updater(root=root)
        # ensure a clean baseline regardless of what the repo currently ships
        (root / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        res = up.apply(channel="stable")
        assert res["ok"], res
        assert (root / "VERSION").read_text().strip() == "1.1.0"
        assert installed_version.__module__  # sanity: importable
        assert (root / "updates" / "catalog.json").exists()
        assert any(p.is_dir() for p in (root / "data" / "snapshots").iterdir()), "snapshot written"
        assert up.check(channel="stable")["available"] is None, "already current after apply"
        rb = up.rollback()
        assert rb["ok"], rb
        assert (root / "VERSION").read_text().strip() == "1.0.0"
        assert not any(p.is_dir() for p in (root / "data" / "snapshots").iterdir()), "snapshot consumed"

    def tampered_package_rejected():
        root = sandbox()
        pkg = root / "updates" / "packages" / "cardputer-emu-1.1.0.zip"
        with zipfile.ZipFile(pkg, "a") as zf:      # append a byte → hash changes
            zf.writestr("evil.txt", "pwned")
        up = Updater(root=root)
        res = up.apply(channel="stable")
        assert not res["ok"], "tampered package must be refused"
        assert any("sha256 mismatch" in line for line in res["log"]), res["log"]
        assert (root / "VERSION").read_text().strip() == "1.0.0", "version untouched"

    def beta_channel():
        root = sandbox()
        (root / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        up = Updater(root=root)
        stable = up.check(channel="stable")["available"]["version"]
        beta = up.check(channel="beta")["available"]["version"]
        assert beta == "1.2.0-beta.1", beta
        assert beta != stable

    def unsigned_package_rejected():
        root = sandbox()
        manifest = json.loads((root / "updates" / "manifest.json").read_text())
        for rel in manifest["releases"]:
            rel.pop("sha256", None)
        (root / "updates" / "manifest.json").write_text(json.dumps(manifest))
        up = Updater(root=root)
        res = up.apply(channel="stable")
        assert not res["ok"]
        assert any("no sha256" in line for line in res["log"]), res["log"]

    for name, fn in [
        ("semver ordering", version_math),
        ("check() finds the feed release", check_finds_update),
        ("apply() upgrades, then rollback() restores", apply_then_rollback),
        ("tampered package is rejected", tampered_package_rejected),
        ("channels select different releases", beta_channel),
        ("unsigned package is rejected", unsigned_package_rejected),
    ]:
        check(name, fn)

    print(f"\n{passed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
