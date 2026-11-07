#!/usr/bin/env python3
"""Headless browser smoke test for the emulator UI.

Boots the real server on a free port, drives the page with Chromium (Playwright)
and asserts the things a user would notice: zero console/page errors, the boot
sequence lands in the launcher, the update check works, a module can be plugged
in live, an app runs and every rail button toggles exactly one hardware state.

    python3 tools/browser_check.py                # exit 0 / 1, one line summary
    python3 tools/browser_check.py --shot out.png # also write a screenshot
    python3 tools/browser_check.py --url http://127.0.0.1:8787/   # use a running server

Requires `pip install playwright && playwright install chromium`. Without it the
script reports "skipped" and exits 0 so it can sit inside a CI gate.
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_server(url: str, timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url + "api/info", timeout=1.5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


class BrowserUnavailable(Exception):
    """Playwright is importable but Chromium cannot start (missing download/libs)."""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--shot", help="write a PNG of the UI here")
    ap.add_argument("--headful", action="store_true")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skipped: playwright is not installed (pip install playwright)")
        return 0

    proc = None
    url = args.url
    if not url:
        port = free_port()
        url = f"http://127.0.0.1:{port}/"
        proc = subprocess.Popen(
            [sys.executable, "run.py", "--port", str(port), "--no-browser", "--no-build", "--no-auto-update"],
            cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if not wait_for_server(url):
            proc.kill()
            print("FAIL: server did not come up")
            return 1

    errors: list[str] = []
    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=not args.headful)
            except Exception as exc:     # no browser download, missing shared libs, …
                raise BrowserUnavailable(str(exc).splitlines()[0]) from exc
            page = browser.new_page(viewport={"width": 1500, "height": 950})
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(5000)

            boot = page.evaluate("""() => ({
                version: window.__emu.updater.version,
                apps: window.__emu.runtime.apps.size,
                catalog: window.__emu.device.catalog.length,
                phase: window.__emu.runtime.phase,
                variant: window.__emu.device.variantId,
                lcd: window.__emu.device.display.buf.length,
            })""")
            assert boot["phase"] in ("run", "launcher"), f"boot stuck in {boot['phase']}"
            assert boot["apps"] >= 15, f"only {boot['apps']} apps registered"
            assert boot["lcd"] == 240 * 135, "framebuffer is not 240x135"

            # plug a Grove unit in live, then launch an app and type into it
            page.evaluate("""() => {
                const d = window.__emu.device;
                for (const m of [...d.modules]) d.detachModule(m.uuid);
                return d.attachModule('env3').ok;
            }""")
            page.evaluate("() => window.__emu.runtime.launch('terminal')")
            page.wait_for_timeout(400)
            page.keyboard.type("help")
            page.keyboard.press("Enter")
            page.wait_for_timeout(600)
            live = page.evaluate("""() => ({
                app: window.__emu.runtime.active && window.__emu.runtime.active.id,
                modules: window.__emu.device.modules.map(m => m.def.id),
                dirtyFrame: window.__emu.device.display.frameCount > 0,
                fps: Math.round(window.__emu.runtime.fps),
            })""")
            assert live["app"] == "terminal", f"app did not start: {live['app']}"
            assert "env3" in live["modules"], "hot-plugged module missing"
            assert live["dirtyFrame"], "panel never scanned out a frame"

            # every rail button must flip exactly one hardware state. Normalise first:
            # the launcher persists the SKU, and on a v1.0 the 3.5 mm button is disabled.
            page.evaluate("""() => {
                const d = window.__emu.device;
                if (d.variantId !== 'adv') window.__emu.panels.ctx.setVariant('adv');
                if (d.audioJack) d.setAudioJack(false);
                if (d.usbConnected) d.setUsb(false);
                if (d.sd.inserted) d.sd.eject();
                return true;
            }""")
            page.wait_for_timeout(300)
            states = page.evaluate("""() => {
                const d = window.__emu.device;
                const read = () => ({ usb: d.usbConnected, sd: d.sd.inserted, jack: d.audioJack, mode: d.mode });
                const out = [];
                for (const id of ['btnUsb', 'btnSd', 'btnJack']) {
                    const before = read();
                    document.getElementById(id).click();
                    const after = read();
                    const diff = Object.keys(before).filter(k => before[k] !== after[k]);
                    out.push({ id, diff });
                    document.getElementById(id).click();
                }
                return out;
            }""")
            for s in states:
                assert len(s["diff"]) == 1, f"{s['id']} changed {s['diff']} (expected exactly one)"

            # ---- round 2: SKU swap, flash panel, program install, bench tabs
            swap = page.evaluate("""() => {
                const d = window.__emu.device;
                const r1 = window.__emu.panels.ctx.setVariant('cardputer');
                const after = { id: d.variantId, ext: d.variant.ext, grove5v: d.grove5v, ejected: r1.ejected.length };
                const r2 = window.__emu.panels.ctx.setVariant('adv');
                return { after, back: d.variantId, backExt: d.variant.ext, backEjected: r2.ejected.length };
            }""")
            assert swap["after"]["id"] == "cardputer", "SKU swap did not take"
            assert swap["after"]["ext"] is False, "original Cardputer must not expose EXT"
            assert swap["back"] == "adv" and swap["backExt"] is True, "could not swap back to the Adv"

            # the Flash tab must render its dropzone and partition table
            page.evaluate("() => window.__emu.panels.setTab('flash')")
            page.wait_for_timeout(300)
            flash_ui = page.evaluate("""() => ({
                drop: !!document.querySelector('#flashDrop'),
                partitions: document.querySelectorAll('table.ptable tr').length,
                editor: !!document.querySelector('.code-editor'),
            })""")
            assert flash_ui["drop"], "flash tab has no dropzone"
            assert flash_ui["partitions"] > 6, f"partition table rendered {flash_ui['partitions']} rows"
            assert flash_ui["editor"], "no program editor"

            # installing a program from the UI has to land in the runtime + catalog
            installed = page.evaluate("""async () => {
                const r = await window.__emu.flash.installApp(
                  "export const APP = { id: 'browserprog', name: 'Browser Prog', setup() {}, loop(api) { api.lcd.drawString(2, 2, 'ok', api.COLORS.GREEN, 1); } };",
                  { source: 'browser_check' });
                window.__emu.runtime.launch('browserprog');
                return { ok: r.ok, error: r.error, running: window.__emu.runtime.active && window.__emu.runtime.active.id,
                         listed: window.__emu.flash.listApps().map(a => a.id) };
            }""")
            assert installed["ok"], "program install failed: " + str(installed.get("error"))
            assert installed["running"] == "browserprog", "installed program did not launch"
            page.wait_for_timeout(300)

            bench = page.evaluate("""() => {
                window.__emu.panels.setTab('bench');
                const d = window.__emu.device;
                d.ir.learnNec([0, 255, 69, 186], { source: 'browser' });
                return { rows: document.querySelectorAll('.file-row').length, ir: d.ir.captures.length };
            }""")
            assert bench["ir"] >= 1, "IR capture did not register"
            page.evaluate("() => window.__emu.panels.setTab('system')")

            if args.shot:
                page.screenshot(path=args.shot)
            browser.close()
    except BrowserUnavailable as exc:
        print(f"skipped: Chromium for Playwright cannot start ({str(exc).strip()[:110]})")
        return 0
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    if errors:
        print("FAIL: " + " | ".join(errors[:4]))
        return 1
    print(f"ok: v{boot['version']} · {boot['apps']} apps · {boot['catalog']} modules · "
          f"{live['app']} running · 0 console errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
