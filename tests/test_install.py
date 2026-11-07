#!/usr/bin/env python3
"""Tests for install.py — the round-4 zero-install installer.

Everything here runs the real installer in a throwaway directory, so the tests
prove what a user gets: the UI is built when it is missing, kept when it is
current, rebuilt when the sources change, and the exit codes tell the truth when
parts are missing or broken.

    python3 tests/test_install.py            # one summary line, exit 0/1
    python3 tests/test_install.py -v         # per-test output
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
INSTALLER = ROOT / "install.py"

# The minimum a package needs to create its own UI: the sources, the builder, the
# Python launcher package and the feed that gets inlined into the bundle.
RUNTIME = ["install.py", "build.py", "run.py", "VERSION", "README.md", "START-HERE.txt",
           "src", "cardputer", "updates", "tools/browser_check.py"]


def make_package(dest: Path) -> Path:
    """Copy the runtime parts of the project into `dest` (no bundle, no data/)."""
    dest.mkdir(parents=True, exist_ok=True)
    for name in RUNTIME:
        src = ROOT / name
        if not src.exists():
            continue
        target = dest / name
        if src.is_dir():
            shutil.copytree(src, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
    bundle = dest / "cardputer.html"
    if bundle.exists():
        bundle.unlink()
    return dest


def run_installer(cwd: Path, *args: str, timeout: int = 300) -> subprocess.CompletedProcess:
    """Run the installer with a throwaway HOME so shortcuts never touch the real one.

    Playwright installs its browsers under $HOME, so the real cache is passed
    through explicitly — otherwise the optional headless check would silently
    disappear from these tests.
    """
    home = cwd / ".home"
    env = {**os.environ, "HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}
    real_cache = Path(os.environ.get("HOME", "~")).expanduser() / ".cache" / "ms-playwright"
    if real_cache.is_dir():
        env["PLAYWRIGHT_BROWSERS_PATH"] = str(real_cache)
    home.mkdir(exist_ok=True)
    return subprocess.run([PY, "install.py", *args], cwd=cwd, capture_output=True,
                          text=True, timeout=timeout, env=env)


def last_line(text: str) -> str:
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    return lines[-1] if lines else "(no output)"


class InstallTests(unittest.TestCase):
    """Each test gets its own copy of the package: no shared state, no network."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="cardputer-install-")
        cls.base = Path(cls._tmp.name) / "base"
        make_package(cls.base)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def package(self, name: str) -> Path:
        dest = Path(self._tmp.name) / name
        if not dest.exists():
            shutil.copytree(self.base, dest)
        return dest

    # -- 1. the happy path -------------------------------------------------
    def test_builds_the_ui_when_it_is_missing(self):
        pkg = self.package("fresh")
        self.assertFalse((pkg / "cardputer.html").exists(), "fixture should ship no bundle")
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        bundle = pkg / "cardputer.html"
        self.assertTrue(bundle.exists(), "installer did not create cardputer.html")
        html = bundle.read_text(encoding="utf-8", errors="replace")
        for marker in ('<!doctype html', 'id="deviceStage"', 'id="console"', 'type="module"'):
            self.assertIn(marker.lower(), html.lower())
        self.assertGreater(bundle.stat().st_size, 200_000, "bundle looks truncated")
        self.assertTrue((pkg / "data" / "config.json").exists(), "data/config.json missing")

    def test_is_idempotent_and_keeps_the_bundle(self):
        pkg = self.package("idempotent")
        first = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        stamp = (pkg / "cardputer.html").stat().st_mtime
        second = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test")
        self.assertEqual(second.returncode, 0)
        self.assertIn("is current", second.stdout)
        self.assertEqual(stamp, (pkg / "cardputer.html").stat().st_mtime,
                         "installer rebuilt a current bundle for no reason")
        # the data directory survives re-installs
        cfg = pkg / "data" / "config.json"
        self.assertIn("kept existing", second.stdout)
        self.assertTrue(cfg.exists())

    def test_rebuild_flag_forces_a_new_bundle(self):
        pkg = self.package("rebuild")
        self.assertEqual(run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test").returncode, 0)
        before = (pkg / "cardputer.html").stat().st_mtime
        time.sleep(1.1)   # mtime resolution
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test", "--rebuild")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertGreater((pkg / "cardputer.html").stat().st_mtime, before)

    def test_source_change_marks_the_bundle_stale(self):
        pkg = self.package("stale")
        self.assertEqual(run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test").returncode, 0)
        banner = pkg / "cardputer.html"
        banner.write_text("<!-- stale, hand edited -->", encoding="utf-8")
        later = time.time() + 5
        os.utime(pkg / "src" / "js" / "core" / "device.js", (later, later))
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("newer than the bundle", res.stdout)
        self.assertGreater(banner.stat().st_size, 200_000, "stale bundle was not rebuilt")

    def test_feed_change_marks_the_bundle_stale(self):
        """updates/manifest.json is inlined in the bundle, so it is an input too."""
        pkg = self.package("feed")
        self.assertEqual(run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test").returncode, 0)
        later = time.time() + 5
        os.utime(pkg / "updates" / "manifest.json", (later, later))
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test")
        self.assertIn("newer than the bundle", res.stdout)

    def test_data_directory_is_portable_and_ignores_a_broken_config(self):
        pkg = self.package("config")
        (pkg / "data").mkdir()
        (pkg / "data" / "config.json").write_text("{not json", encoding="utf-8")
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test", "--portable")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("portable mode", res.stdout)
        self.assertIn("reset to defaults", res.stdout)
        self.assertIn('"portable": true', (pkg / "data" / "config.json").read_text())

    def test_self_test_passes_on_a_good_package(self):
        pkg = self.package("selftest")
        res = run_installer(pkg, "--yes", "--no-shortcuts")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        for expected in ("contains the full UI", "server answered /api/info",
                         "serves the UI over HTTP", "self-contained"):
            self.assertIn(expected, res.stdout)

    def test_shortcut_is_written_into_a_fresh_home(self):
        pkg = self.package("shortcut")
        res = run_installer(pkg, "--yes", "--skip-test")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        home = pkg / ".home"
        entries = list(home.rglob("*.desktop")) + list(home.rglob("*.command")) + \
            list(home.rglob("*.lnk")) + list(home.rglob("*.bat"))
        self.assertTrue(entries, f"no shortcut created under {home}: {last_line(res.stdout)}")
        text = entries[0].read_text(encoding="utf-8", errors="replace")
        self.assertIn("run.py", text)

    # -- 2. the failure modes ---------------------------------------------
    def test_exit_code_4_when_the_ui_cannot_be_created(self):
        pkg = self.package("no-ui")
        (pkg / "build.py").unlink()
        self.assertFalse((pkg / "cardputer.html").exists())
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test")
        self.assertEqual(res.returncode, 4, res.stdout + res.stderr)
        self.assertIn("cannot create the UI", res.stdout)

    def test_exit_code_5_when_the_bundle_is_broken_and_cannot_be_rebuilt(self):
        pkg = self.package("broken")
        (pkg / "build.py").unlink()
        (pkg / "cardputer.html").write_text("<!doctype html><p>nope</p>", encoding="utf-8")
        res = run_installer(pkg, "--yes", "--no-shortcuts")
        self.assertEqual(res.returncode, 5, res.stdout + res.stderr)
        self.assertIn("looks incomplete", res.stdout)

    def test_a_failed_build_falls_back_to_the_shipped_bundle(self):
        pkg = self.package("fallback")
        self.assertEqual(run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test").returncode, 0)
        (pkg / "build.py").write_text('raise SystemExit("simulated build failure")\n', encoding="utf-8")
        res = run_installer(pkg, "--yes", "--no-shortcuts", "--skip-test", "--rebuild")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("falling back to the shipped bundle", res.stdout)
        self.assertGreater((pkg / "cardputer.html").stat().st_size, 200_000)

    def test_shipped_bundle_only_package_still_installs(self):
        """A package with no sources at all must still work — the bundle is enough."""
        pkg = self.package("bundle-only")
        shutil.copy2(ROOT / "cardputer.html", pkg / "cardputer.html")
        (pkg / "build.py").unlink()
        shutil.rmtree(pkg / "src")
        res = run_installer(pkg, "--yes", "--no-shortcuts")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("no build.py in this package", res.stdout)

    def test_missing_chromium_is_a_warning_not_a_failure(self):
        """A machine with playwright but no browser download must still install cleanly."""
        import importlib.util
        if importlib.util.find_spec("playwright") is None:
            self.skipTest("playwright is not installed here")
        pkg = self.package("no-chromium")
        env_home = pkg / ".home"
        env_home.mkdir(exist_ok=True)
        empty = pkg / "no-browsers"
        empty.mkdir(exist_ok=True)
        # HOME is redirected to hide the real browser cache, but a per-user
        # (`pip install --user`) Playwright lives under the real HOME too and
        # would vanish from the subprocess along with it. Pass its site-packages
        # directory through PYTHONPATH so this test exercises "Playwright
        # importable, browser download missing" on every install layout.
        import playwright
        site_packages = str(Path(playwright.__file__).resolve().parent.parent)
        pythonpath = os.pathsep.join(x for x in [site_packages, os.environ.get("PYTHONPATH", "")] if x)
        env = {**os.environ, "HOME": str(env_home), "PYTHONDONTWRITEBYTECODE": "1",
               "PLAYWRIGHT_BROWSERS_PATH": str(empty), "PYTHONPATH": pythonpath}
        res = subprocess.run([PY, "install.py", "--yes", "--no-shortcuts"], cwd=pkg,
                             capture_output=True, text=True, timeout=600, env=env)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("headless UI check skipped", res.stdout)

    def test_help_works_without_side_effects(self):
        pkg = self.package("help")
        res = run_installer(pkg, "--help")
        self.assertEqual(res.returncode, 0)
        for flag in ("--yes", "--launch", "--port", "--rebuild", "--no-shortcuts",
                     "--skip-test", "--portable"):
            self.assertIn(flag, res.stdout)
        self.assertFalse((pkg / "data").exists(), "--help must not touch the install")


if __name__ == "__main__":
    prog = unittest.main(argv=sys.argv, exit=False, verbosity=2 if "-v" in sys.argv else 1)
    suite = prog.result
    if suite.wasSuccessful():
        print(f"ok: {suite.testsRun} install tests passed")
        raise SystemExit(0)
    print(f"FAIL: {len(suite.failures)} failed, {len(suite.errors)} errors "
          f"of {suite.testsRun} install tests")
    raise SystemExit(1)
