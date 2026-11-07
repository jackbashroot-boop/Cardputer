"""Command line entry point — the same command works on Linux, macOS and Windows."""
from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser

from . import config
from .updater import Updater, installed_version
from .version import CODENAME

BANNER = r"""
   ___             _            _              _____ __  __ _   _
  / __\ __ _ _ __| |_ _ __  ___| |_ ___ _ __  | ____|  \/  | | | |
 / / |/ _` | '__| __| '_ \/ __| __/ _ \ '__| |  _| | |\/| | | | |
/ /__| (_| | |  | |_| |_) \__ \ ||  __/ |    | |___| |  | |_| |_|
\____/\__,_|_|   \__| .__/|___/\__\___|_|    \____|_|  |_|\___/
                    |_|   M5Stack Cardputer emulator  v{ver}  ({codename})
"""


def _free_port(preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 24), 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("0.0.0.0", port))
                return sock.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free TCP port found")


def _build(root) -> bool:
    build_py = root / "build.py"
    if not build_py.exists():
        return False
    sys.path.insert(0, str(root))
    import importlib

    mod = importlib.import_module("build")
    out = mod.build()
    print(f"  · built {out.relative_to(root)}")
    return True


def cmd_status(args) -> int:
    up = Updater()
    st = up.status()
    print(BANNER.format(ver=st["version"], codename=CODENAME))
    print(f"  installed      v{st['version']}")
    print(f"  channel        {st['channel']}")
    print(f"  feed           {st['feed']}")
    print(f"  auto-update    {'on' if st['auto_update'] else 'off'}")
    print(f"  module catalog {st['catalogue'] or 'not built'}")
    print(f"  snapshots      {', '.join(st['snapshots']) or 'none'}")
    for rel in st["history"][:5]:
        print(f"  history        v{rel['version']} ({rel.get('installed_at', '?')})")
    return 0


def cmd_check(args) -> int:
    up = Updater()
    res = up.check(channel=args.channel)
    for line in res.get("log", []):
        print("  " + line)
    if res.get("available"):
        entry = res["available"]
        print(f"\n  available: v{entry['version']} ({entry.get('channel', 'stable')}, {entry.get('date', '?')})")
        for note in entry.get("notes", []):
            print(f"    · {note}")
        print("\n  install with:  python run.py --update")
    return 0


def cmd_update(args) -> int:
    up = Updater()
    res = up.apply(channel=args.channel)
    for line in res.get("log", []):
        print("  " + line)
    if res.get("ok"):
        print(f"\n  ✔ upgraded to v{res['version']} — restart the launcher to run it")
        if args.build:
            _build(config.ROOT)
        return 0
    print("\n  nothing applied:", res.get("error", "unknown"))
    return 1


def cmd_rollback(args) -> int:
    res = Updater().rollback()
    for line in res.get("log", []):
        print("  " + line)
    return 0 if res.get("ok") else 1


def cmd_serve(args) -> int:
    from .server import serve

    cfg = config.load_config()
    if args.channel or args.feed:
        cfg["channel"] = args.channel or cfg["channel"]
        cfg["feed"] = args.feed or cfg["feed"]
        config.save_config(cfg)
    if args.no_auto_update:
        cfg["auto_update"] = False
        config.save_config(cfg)

    dev = args.dev
    dist = config.ROOT / "cardputer.html"
    if not dev and (args.build or not dist.exists()):
        try:
            _build(config.ROOT)
        except Exception as exc:
            print(f"  ! build failed ({exc}); falling back to source mode", file=sys.stderr)
            dev = True

    # auto-update before serving so the running build is current
    if cfg.get("auto_update", True) and not args.no_auto_update and not dev:
        try:
            up = Updater(cfg=cfg)
            check = up.check(channel=args.channel)
            if check.get("available"):
                v = check["available"]["version"]
                print(f"  · auto-update: v{installed_version()} → v{v} available, installing…")
                res = up.apply(channel=args.channel)
                for line in res.get("log", []):
                    print("    " + line)
                if res.get("ok") and not args.no_build:
                    _build(config.ROOT)
        except Exception as exc:
            print(f"  · auto-update skipped: {exc}")

    port = _free_port(args.port or cfg.get("port", 8787))
    httpd = serve(host=args.host, port=port, dev=dev)
    url = f"http://127.0.0.1:{port}/"
    print(BANNER.format(ver=installed_version(), codename=CODENAME))
    print(f"  serving   {config.ROOT}  ({'src (dev)' if dev else 'cardputer.html'})")
    print(f"  url       {url}")
    print("  api       /api/info  /api/update/check  /api/update/apply")
    print("  ctrl-c    to stop\n")

    if cfg.get("open_browser", True) and not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
    finally:
        httpd.server_close()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="run.py",
        description="M5Stack Cardputer emulator — runs on Linux, macOS and Windows.",
    )
    parser.add_argument("--port", type=int, help="TCP port for the local UI server")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    parser.add_argument("--dev", action="store_true", help="serve src/ (unbundled) instead of dist/")
    parser.add_argument("--build", action="store_true", help="rebuild dist/cardputer.html before serving")
    parser.add_argument("--no-build", action="store_true", help="never rebuild")
    parser.add_argument("--check", action="store_true", help="check the release feed and exit")
    parser.add_argument("--update", action="store_true", help="download + verify + install an update and exit")
    parser.add_argument("--rollback", action="store_true", help="restore the previous build and exit")
    parser.add_argument("--status", action="store_true", help="print version / update status and exit")
    parser.add_argument("--channel", choices=["stable", "beta"], help="release channel")
    parser.add_argument("--feed", help="release feed path or https URL")
    parser.add_argument("--no-auto-update", action="store_true", help="skip the update check on launch")
    args = parser.parse_args(argv)

    if args.status:
        return cmd_status(args)
    if args.check:
        return cmd_check(args)
    if args.update:
        return cmd_update(args)
    if args.rollback:
        return cmd_rollback(args)
    return cmd_serve(args)
