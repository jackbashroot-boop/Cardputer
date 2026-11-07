"""Local HTTP server: serves the emulator UI plus a small JSON API used by
the in-page Updater / System panels. Standard library only — no pip installs."""
from __future__ import annotations

import json
import mimetypes
import platform
import sys
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import config
from .updater import Updater, installed_version

ROOT = config.ROOT
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("text/html", ".html")

MAX_PROXY_BYTES = 2 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    server_version = "CardputerEMU/1.0"

    def __init__(self, *args, dev: bool = False, **kwargs):
        self.dev = dev
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # -- helpers ------------------------------------------------------------
    def _json(self, payload, code: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, ctype: str) -> None:
        if not path.exists():
            self.send_error(404, f"{path.name} not found — run: python build.py")
            return
        body = path.read_bytes()
        if ctype.startswith("text/html"):
            # lets the page skip the /api probe (and its console noise) when opened from disk
            body = body.replace(b"<head>", b'<head>\n<meta name="cardputer-native" content="1">', 1)
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            return
        sys.stderr.write("  · %s\n" % (fmt % args))

    # -- routes -------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            target = ROOT / "src" / "index.html" if self.dev else ROOT / "cardputer.html"
            return self._file(target, "text/html; charset=utf-8")

        if path == "/api/info":
            cfg = config.load_config()
            return self._json({
                "native": True,
                "version": installed_version(),
                "channel": cfg.get("channel", "stable"),
                "feed": cfg.get("feed"),
                "autoUpdate": cfg.get("auto_update", True),
                "codename": __import__("cardputer.version", fromlist=["CODENAME"]).CODENAME,
                "platform": f"{platform.system()} {platform.release()}",
                "python": sys.version.split()[0],
                "root": str(ROOT),
                "dev": self.dev,
            })

        if path == "/api/state":
            return self._json(config.load_state())

        if path == "/api/update/check":
            try:
                res = Updater().check(channel=(query.get("channel") or [None])[0])
            except Exception as exc:
                res = {"ok": False, "error": str(exc), "log": [str(exc)], "current": installed_version()}
            return self._json(res)

        if path == "/api/update/status":
            try:
                return self._json(Updater().status())
            except Exception as exc:
                return self._json({"error": str(exc)}, 500)

        if path == "/api/feed":
            try:
                return self._json(Updater().load_feed())
            except Exception as exc:
                return self._json({"error": str(exc)}, 502)

        if path == "/api/proxy":
            url = (query.get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                return self._json({"error": "only http(s) urls may be proxied"}, 400)
            try:
                req = urllib.request.Request(url, headers={"user-agent": "CardputerEMU/1.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read(MAX_PROXY_BYTES)
                self.send_response(200)
                self.send_header("content-type", resp.headers.get("content-type", "text/plain"))
                self.send_header("content-length", str(len(data)))
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except Exception as exc:
                self._json({"error": f"proxy failed: {exc}"}, 502)
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}

        if path == "/api/state":
            return self._json(config.save_state(payload))

        if path == "/api/config":
            cfg = config.load_config()
            for key in ("channel", "feed", "auto_update", "port", "open_browser"):
                if key in payload:
                    cfg[key] = payload[key]
            return self._json(config.save_config(cfg))

        if path == "/api/update/apply":
            try:
                res = Updater().apply(version=payload.get("version"), channel=payload.get("channel"))
            except Exception as exc:
                res = {"ok": False, "error": str(exc), "log": [f"apply failed: {exc}"]}
            return self._json(res)

        if path == "/api/update/rollback":
            try:
                res = Updater().rollback()
            except Exception as exc:
                res = {"ok": False, "error": str(exc), "log": [f"rollback failed: {exc}"]}
            return self._json(res)

        if path == "/api/reset":
            for name in ("state.json", "config.json", "history.json"):
                try:
                    (config.DATA / name).unlink()
                except OSError:
                    pass
            return self._json({"ok": True, "log": ["user data cleared"]})

        return self._json({"error": "unknown endpoint"}, 404)


def serve(host: str = "0.0.0.0", port: int = 8787, dev: bool = False) -> ThreadingHTTPServer:
    handler = partial(Handler, dev=dev)
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd
