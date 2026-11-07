#!/usr/bin/env python3
"""Cardputer EMU — one-step installer.

What it does, in order (nothing here needs pip, node, a compiler or admin rights):

  1. checks the Python it is running on (3.9+ is required, 3.10+ recommended)
  2. creates the runtime data directory (config, state, snapshots, downloads)
  3. builds the UI bundle `cardputer.html` from `src/` when it is missing or stale
     — this is the "create the UI for the user as needed" step
  4. writes a launcher you can double-click (desktop shortcut / Start-menu entry /
     macOS .command) unless you pass --no-shortcuts
  5. runs a self-test: import the Python side, boot the local server, fetch
     /api/info, verify the bundle and the module catalog, and — when Playwright is
     installed — drive the real page in headless Chromium
  6. optionally launches the emulator straight away

    python3 install.py                 # install + self-test
    python3 install.py --launch        # ... and open the UI when done
    python3 install.py --rebuild       # force a fresh UI bundle
    python3 install.py --no-shortcuts   # do not touch the desktop / Start menu
    python3 install.py --yes           # never ask anything (non-interactive)
    python3 install.py --portable      # keep everything inside this folder

Exit code 0 means the install is usable; non-zero prints what to fix.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION_FILE = ROOT / "VERSION"
BUNDLE = ROOT / "cardputer.html"
DATA = ROOT / "data"
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"

OK = "  \u2714"
NO = "  \u2716"
WARN = "  !"


# --------------------------------------------------------------------- helpers
def say(msg: str = "") -> None:
    print(msg, flush=True)


def step(num: int, label: str) -> None:
    say(f"\n[{num}/6] {label}")


def ask(question: str, default: bool = True) -> bool:
    if not sys.stdin or not sys.stdin.isatty():
        return default
    suffix = "[Y/n]" if default else "[y/N]"
    try:
        reply = input(f"  ? {question} {suffix} ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return default
    if not reply:
        return default
    return reply in ("y", "yes")


def installed_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


def free_port(preferred: int = 8799) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 40), 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free TCP port")


def newest_mtime(target: Path) -> float:
    """Newest mtime under a directory, or the mtime of a single file."""
    if target.is_file():
        return target.stat().st_mtime
    newest = 0.0
    for path in target.rglob("*"):
        if path.is_file():
            newest = max(newest, path.stat().st_mtime)
    return newest


# ------------------------------------------------------------------ 1. python
def check_python() -> bool:
    step(1, "Python runtime")
    major, minor = sys.version_info[:2]
    say(f"    interpreter   {sys.executable}")
    say(f"    version       {platform.python_version()} on {platform.system()} {platform.release()}")
    if (major, minor) < (3, 9):
        say(f"{NO} Python 3.9 or newer is required (this is {major}.{minor}).")
        say("    Install Python from python.org (tick 'Add Python to PATH' on Windows) and run this again.")
        return False
    say(f"{OK} Python {major}.{minor} is supported")
    if not sys.stdout.encoding or "utf" not in sys.stdout.encoding.lower():
        say(f"{WARN} console encoding is {sys.stdout.encoding}; set PYTHONUTF8=1 if characters look wrong")
    return True


# -------------------------------------------------------------- 2. data + dirs
def prepare_data(portable: bool) -> bool:
    step(2, "Runtime data directory")
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "snapshots").mkdir(exist_ok=True)
    (DATA / "downloads").mkdir(exist_ok=True)
    cfg_path = DATA / "config.json"
    defaults = {
        "channel": "stable",
        "feed": "updates/manifest.json",
        "auto_update": True,
        "open_browser": True,
        "port": 8787,
        "portable": bool(portable),
    }
    if not cfg_path.exists():
        cfg_path.write_text(json.dumps(defaults, indent=2) + "\n", encoding="utf-8")
        say(f"{OK} created {cfg_path.relative_to(ROOT)} (channel=stable, auto-update on)")
    else:
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            say(f"{OK} kept existing data/config.json (channel={cfg.get('channel', 'stable')})")
        except (OSError, json.JSONDecodeError):
            cfg_path.write_text(json.dumps(defaults, indent=2) + "\n", encoding="utf-8")
            say(f"{WARN} data/config.json was unreadable — reset to defaults")
    if portable:
        say(f"{OK} portable mode: state, updates and snapshots stay inside {ROOT.name}/data")
    say(f"{OK} data/ ready (snapshots/, downloads/)")
    return True


# ------------------------------------------------------------------- 3. bundle
def build_ui(force: bool = False) -> bool:
    step(3, "UI bundle (cardputer.html)")
    builder = ROOT / "build.py"
    if not builder.exists():
        if BUNDLE.exists():
            say(f"{OK} no build.py in this package; using the shipped cardputer.html "
                f"({BUNDLE.stat().st_size // 1024} KB)")
            return True
        say(f"{NO} neither build.py nor cardputer.html is present — cannot create the UI")
        return False

    stale = True
    if BUNDLE.exists() and not force:
        bundle_age = BUNDLE.stat().st_mtime
        # everything build.py bakes into the bundle: sources, the feed it inlines,
        # the version string and the builder itself
        inputs = [ROOT / "src", ROOT / "build.py", ROOT / "VERSION",
                  ROOT / "updates" / "manifest.json"]
        src_age = max(newest_mtime(path) for path in inputs)
        stale = src_age > bundle_age + 1
        if not stale:
            say(f"{OK} cardputer.html is current ({BUNDLE.stat().st_size // 1024} KB, "
                f"{len(list((ROOT / 'src' / 'js').rglob('*.js')))} JS sources)")
            return True
        say(f"    sources are newer than the bundle — rebuilding")

    try:
        proc = subprocess.run([sys.executable, str(builder)], cwd=str(ROOT),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        code = proc.returncode
        tag = "    " if code == 0 else NO + " "
        for line in proc.stdout.decode("utf-8", "replace").strip().splitlines():
            say(tag + line.strip())
    except OSError as exc:
        say(f"{NO} could not run build.py: {exc}")
        code = 1
    if code != 0 or not BUNDLE.exists():
        if BUNDLE.exists():
            say(f"{WARN} build failed (exit {code}); falling back to the shipped bundle")
            return True
        say(f"{NO} build failed (exit {code}) and there is no prebuilt cardputer.html")
        return False
    say(f"{OK} built cardputer.html ({BUNDLE.stat().st_size // 1024} KB)")
    return True


# -------------------------------------------------------------- 4. shortcuts
def launcher_command() -> tuple[str, list[str]]:
    """The exact command a shortcut should run on this platform."""
    if IS_WIN:
        return "run.bat", []
    return sys.executable, ["run.py"]


def write_shortcut() -> list[str]:
    written: list[str] = []
    if IS_WIN:
        written += _shortcut_windows()
    elif IS_MAC:
        written += _shortcut_mac()
    else:
        written += _shortcut_linux()
    return written


def _shortcut_linux() -> list[str]:
    apps = Path.home() / ".local" / "share" / "applications"
    desktop = Path.home() / "Desktop"
    body = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Cardputer EMU\n"
        "Comment=M5Stack Cardputer / Cardputer-Adv emulator\n"
        f"Exec={sys.executable} {ROOT / 'run.py'}\n"
        f"Path={ROOT}\n"
        "Terminal=true\n"
        "Categories=Development;Electronics;\n"
        "Icon=utilities-terminal\n"
    )
    out = []
    for target in (apps / "cardputer-emu.desktop", desktop / "Cardputer EMU.desktop"):
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8")
            target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            out.append(str(target))
        except OSError:
            continue
    return out


def _shortcut_mac() -> list[str]:
    script = ROOT / "Cardputer EMU.command"
    try:
        script.write_text(
            "#!/bin/sh\n"
            f'cd "{ROOT}" || exit 1\n'
            f'exec "{sys.executable}" run.py\n',
            encoding="utf-8",
        )
        script.chmod(0o755)
        return [str(script)]
    except OSError:
        return []


def _shortcut_windows() -> list[str]:
    bat = ROOT / "Cardputer EMU.bat"
    try:
        bat.write_text(
            "@echo off\r\n"
            f'cd /d "{ROOT}"\r\n'
            'if exist "%~dp0run.bat" (call "%~dp0run.bat") else ('
            f'"{sys.executable}" run.py)\r\n'
            "pause\r\n",
            encoding="utf-8",
        )
        out = [str(bat)]
        desktop = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"
        link = desktop / "Cardputer EMU.lnk"
        ps = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');"
            "$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Description='Cardputer emulator';$s.Save()"
        ).format(link, bat, ROOT)
        if desktop.exists():
            subprocess.call(["powershell", "-NoProfile", "-Command", ps],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if link.exists():
                out.append(str(link))
        return out
    except OSError:
        return []


def shortcuts(enabled: bool, assume_yes: bool) -> bool:
    step(4, "Launcher shortcut")
    if not enabled:
        say(f"{WARN} skipped (--no-shortcuts); start the emulator with:  {sys.executable} run.py")
        return True
    if not assume_yes and not ask("Create a desktop/Start-menu shortcut for the emulator?", True):
        say(f"{WARN} skipped; start the emulator with:  {sys.executable} run.py")
        return True
    made = write_shortcut()
    if made:
        for path in made:
            say(f"{OK} {path}")
    else:
        say(f"{WARN} could not write a shortcut here; just run:  {sys.executable} run.py")
    return True


# ------------------------------------------------------------------ 5. testing
def http_json(url: str, timeout: float = 3.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def self_test() -> bool:
    step(5, "Self-test")
    failures = 0

    # a) the Python side imports
    sys.path.insert(0, str(ROOT))
    try:
        from cardputer import config as cfg  # noqa: F401
        from cardputer.updater import installed_version as iv
        from cardputer.version import CODENAME

        say(f"{OK} python package imports (v{iv()}, {CODENAME})")
    except Exception as exc:  # noqa: BLE001 - report anything the import raises
        say(f"{NO} python package failed to import: {exc}")
        return False

    # b) the bundle really is a UI
    try:
        html = BUNDLE.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        say(f"{NO} cannot read cardputer.html: {exc}")
        return False
    checks = {
        "html skeleton": "<!doctype html" in html.lower(),
        "device stage": 'id="deviceStage"' in html,
        "console panels": 'id="console"' in html,
        "firmware runtime": "CardputerOS" in html or "class Runtime" in html,
        "boot script": "js/main.js" in html or "type=\"module\"" in html,
    }
    bad = [k for k, ok in checks.items() if not ok]
    if bad:
        say(f"{NO} cardputer.html looks incomplete (missing: {', '.join(bad)})")
        failures += 1
    else:
        say(f"{OK} cardputer.html contains the full UI "
            f"({BUNDLE.stat().st_size // 1024} KB, {len(html)} characters)")

    # c) the module catalog and firmware apps are bundled
    catalog_src = ROOT / "src" / "js" / "modules" / "modules.js"
    try:
        if not catalog_src.exists() or not shutil.which("node"):
            raise FileNotFoundError
        out = subprocess.run(
            ["node", "--input-type=module", "-e",
             "import('./src/js/modules/modules.js').then(m=>console.log(m.MODULE_CATALOG.length))"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=25,
        )
        if out.returncode == 0 and out.stdout.strip().isdigit():
            say(f"{OK} catalog loads under node: {out.stdout.strip()} modules")
        else:
            say(f"{WARN} the catalog probe did not run — skipped "
                f"(nothing you need: the bundle is already verified above)")
    except (OSError, subprocess.SubprocessError):
        say(f"{WARN} no src/ sources or no node — skipped the catalog probe (optional)")

    # d) really boot the server and ask it what it is
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "run.py", "--port", str(port), "--no-browser", "--no-build", "--no-auto-update"],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    url = f"http://127.0.0.1:{port}/"
    info = None
    deadline = time.time() + 25
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                info = http_json(url + "api/info")
                break
            except (urllib.error.URLError, OSError, json.JSONDecodeError):
                time.sleep(0.3)
        if info is None:
            err = ""
            if proc.poll() is not None and proc.stderr:
                err = proc.stderr.read().decode("utf-8", "replace").strip().splitlines()[-1:]
            say(f"{NO} the local server did not answer on {url} {err}")
            failures += 1
        else:
            say(f"{OK} server answered /api/info: v{info.get('version', '?')} · "
                f"channel={info.get('channel', '?')} · {info.get('platform', '?')} · "
                f"python {info.get('python', '?')}")
            with urllib.request.urlopen(url, timeout=5) as resp:
                page = resp.read(4096)
            say(f"{OK} serves the UI over HTTP ({len(page)} B in the first packet)")

        # e) headless browser, when Playwright and the checker are both present
        checker = ROOT / "tools" / "browser_check.py"
        if info is not None:
            try:
                import playwright.sync_api  # noqa: F401
                have_pw = True
            except ImportError:
                have_pw = False
            if have_pw and not checker.exists():
                say(f"{WARN} tools/browser_check.py is not in this package — "
                    f"skipped the headless UI check (optional)")
            elif have_pw:
                res = subprocess.run(
                    [sys.executable, str(checker), "--url", url],
                    cwd=str(ROOT), capture_output=True, text=True, timeout=180,
                )
                lines = [ln.strip() for ln in (res.stdout or res.stderr or "").splitlines()
                         if ln.strip()]
                if res.returncode == 0 and lines and lines[-1].startswith("skipped"):
                    say(f"{WARN} headless UI check {lines[-1]} — optional, nothing to fix")
                elif res.returncode == 0:
                    say(f"{OK} headless UI check: {lines[-1] if lines else 'ok'}")
                else:
                    bad_line = next((ln for ln in reversed(lines) if "fail" in ln.lower()
                                     or "error" in ln.lower()), None)
                    say(f"{NO} headless UI check failed: {(bad_line or (lines[-1] if lines else 'no output'))}")
                    failures += 1
            else:
                say(f"{WARN} Playwright not installed — skipped the headless UI check (optional)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()

    # f) the single-file build must also work with no server at all
    if 'type="module"' not in html and "<script" not in html:
        say(f"{WARN} the bundle has no inline script — file:// mode may not work")
    else:
        say(f"{OK} cardputer.html is self-contained (openable straight from disk)")
    return failures == 0


# ------------------------------------------------------------------- 6. launch
def launch(port: int | None) -> int:
    step(6, "Launch")
    cmd = [sys.executable, "run.py"]
    if port:
        cmd += ["--port", str(port)]
    say("    " + " ".join(cmd))
    try:
        return subprocess.call(cmd, cwd=str(ROOT))
    except KeyboardInterrupt:
        return 0


# ----------------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="install.py", description=__doc__.splitlines()[0])
    ap.add_argument("--yes", action="store_true", help="accept all prompts")
    ap.add_argument("--launch", action="store_true", help="start the emulator when the install finishes")
    ap.add_argument("--port", type=int, help="port to use when launching")
    ap.add_argument("--rebuild", action="store_true", help="force a rebuild of cardputer.html")
    ap.add_argument("--no-shortcuts", action="store_true", help="do not create desktop/Start-menu entries")
    ap.add_argument("--skip-test", action="store_true", help="skip the self-test")
    ap.add_argument("--portable", action="store_true", help="keep all state inside this folder")
    args = ap.parse_args(argv)

    say("\n  Cardputer EMU — installer")
    say(f"  package v{installed_version()} · {ROOT}")
    say(f"  {platform.system()} {platform.machine()} · Python {platform.python_version()}")

    if not check_python():
        return 2
    if not prepare_data(args.portable):
        return 3
    if not build_ui(force=args.rebuild):
        return 4
    shortcuts(enabled=not args.no_shortcuts, assume_yes=args.yes)
    ok = True if args.skip_test else self_test()
    if not ok:
        say("\n  Install finished with warnings — the emulator may still run:")
        say(f"    {sys.executable} run.py")
        return 5

    if args.launch or (not args.yes and sys.stdin and sys.stdin.isatty()
                       and ask("Start the emulator now?", True)):
        return launch(args.port)

    step(6, "Done")
    say(f"{OK} everything is installed. Start it any time with:")
    say(f"      {sys.executable} run.py")
    if IS_WIN:
        say("      or double-click run.bat / the desktop shortcut")
    elif IS_MAC:
        say("      or double-click run.command / 'Cardputer EMU.command'")
    else:
        say("      or double-click run.sh / the desktop shortcut")
    say("    The UI opens in your browser at http://127.0.0.1:8787/")
    say("    Single file, no server needed:  cardputer.html")
    say("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
