#!/usr/bin/env python3
"""One-command quality gate: compilers, linters, unit tests and fuzzers.

    python3 tools/check.py              # full gate
    python3 tools/check.py --quick      # skip the long fuzz phases
    python3 tools/check.py --install    # fetch the JS toolchain first (npm)

Python side needs nothing but the stdlib (ruff is optional). The JavaScript side
uses tsc / esbuild / eslint when a local npm toolchain is present
(`npm i --prefix .toolchain typescript esbuild eslint`) and degrades to a
bundling check otherwise — the gate never lies about what it skipped.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The optional JS toolchain (tsc/esbuild/eslint) is looked up in the project first and
# then in ~/.toolchain, which is where `--install` puts it when the project tree is
# meant to stay stdlib-only.
TOOLCHAIN = ROOT / ".toolchain"
if not (TOOLCHAIN / "node_modules").exists() and (Path.home() / ".toolchain" / "node_modules").exists():
    TOOLCHAIN = Path.home() / ".toolchain"
BIN = TOOLCHAIN / "node_modules" / ".bin"

ROWS: list[tuple[str, str, str, str]] = []   # (area, check, verdict, note)


def run(cmd: list[str], cwd: Path = ROOT, timeout: int = 900, env: dict | None = None) -> tuple[int, str]:
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              env={**os.environ, **(env or {})})
        return proc.returncode, tidy(proc.stdout + proc.stderr)
    except FileNotFoundError:
        return 127, "not installed"
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"


def tidy(text: str, limit: int = 2400) -> str:
    """Trim tool output but keep the tail — summaries live at the end."""
    text = "\n".join(line.rstrip() for line in text.strip().splitlines() if line.strip())
    return text if len(text) <= limit else "… " + text[-limit:]


def row(area: str, check: str, code: int, note: str, *, skip: bool = False) -> None:
    verdict = "skip" if skip else ("pass" if code == 0 else "FAIL")
    ROWS.append((area, check, verdict, note))


def tool(name: str) -> str | None:
    local = BIN / name
    if local.exists():
        return str(local)
    return shutil.which(name)


# --------------------------------------------------------------------- JS ----
def check_js(quick: bool) -> None:
    files = sorted(str(p) for p in (ROOT / "src" / "js").rglob("*.js"))
    tsc, esbuild, eslint, node = tool("tsc"), tool("esbuild"), tool("eslint"), tool("node")

    if esbuild:
        code, out = run([esbuild, "src/js/main.js", "--bundle", "--outfile=/dev/null", "--format=esm", "--log-level=warning"])
        row("compile", "esbuild bundle (parse + resolve every import)", code, out if code else f"{len(files)} modules linked")
    elif node:
        # fall back to a real ESM parse of every file with node's own parser
        script = (
            "const {readFileSync}=require('fs');const vm=require('vm');let bad=0;"
            "for(const f of process.argv.slice(1)){"
            "try{new vm.SourceTextModule(readFileSync(f,'utf8'),{identifier:f});}"
            "catch(e){bad++;console.log(f+': '+e.message);}}"
            "process.exit(bad?1:0);"
        )
        code, out = run([node, "--experimental-vm-modules", "--no-warnings", "-e", script, *files])
        row("compile", "node ESM parse (all sources)", code, out if code else f"{len(files)} files parsed")
    else:
        row("compile", "JS syntax", 0, "no node/npm toolchain — skipped", skip=True)

    if tsc:
        code, out = run([tsc, "-p", "tsconfig.json"])
        errors = out.count("error TS")
        row("types", "tsc --checkJs (JSDoc-typed JS)", code, f"{errors} error(s)" if code else "0 errors")
    else:
        row("types", "tsc --checkJs", 0, "typescript not installed — run with --install", skip=True)

    if eslint:
        code, out = run([eslint, "src/js"])
        problems = [line for line in out.splitlines() if "problem" in line]
        row("lint", "eslint (no-undef, dupe members, unreachable)", code, problems[0] if problems else "clean")
    else:
        row("lint", "eslint", 0, "eslint not installed — run with --install", skip=True)

    node = tool("node")
    if node:
        code, out = run([node, "tests/test_core.mjs"])
        row("tests", "node tests/test_core.mjs (device + runtime + apps)", code, summary(out, prefer=r"\d+ passed"))
        if not quick:
            code, out = run([node, "tests/fuzz_core.mjs"], timeout=900)
            row("fuzz", "tests/fuzz_core.mjs (keyboard/hotplug/lcd/runtime)", code, summary(out))
    else:
        row("tests", "JS test suites", 0, "node not installed — skipped", skip=True)


# ----------------------------------------------------------------- Python ----
def check_py(quick: bool) -> None:
    py = sys.executable
    if tool("ruff"):
        code, out = run([tool("ruff"), "check", "."])
        row("lint", "ruff check . (py39, stdlib-only)", code, out.splitlines()[-1] if code else "All checks passed")
    else:
        code, out = run([py, "-m", "compileall", "-q", "cardputer", "tools", "tests", "run.py", "build.py"])
        row("compile", "python compileall", code, out if code else "byte-compiles cleanly")

    code, out = run([py, "tests/test_updater.py"])
    row("tests", "tests/test_updater.py (check/apply/rollback)", code, summary(out))
    code, out = run([py, "tests/test_install.py"], timeout=1200)
    row("tests", "tests/test_install.py (clean install, rebuild, failure modes)", code, summary(out))
    if not quick:
        code, out = run([py, "tests/fuzz_updater.py"], timeout=1200)
        row("fuzz", "tests/fuzz_updater.py (hostile feeds + archives)", code, summary(out))


# ------------------------------------------------------------------ build ----
def check_build() -> None:
    py = sys.executable
    code, out = run([py, "build.py"])
    size = ROOT / "cardputer.html"
    mb = f"{size.stat().st_size / 1024:.1f} KB" if size.exists() else "missing"
    row("build", "python build.py -> cardputer.html", code if size.exists() else 1, mb)
    code, out = run([py, "run.py", "--status"])
    row("build", "python run.py --status", code, summary(out, prefer=r"installed\s+v"))


def check_browser() -> None:
    """Optional: boot the real page in headless Chromium if Playwright is around."""
    py = sys.executable
    probe = run([py, "-c", "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('playwright') else 1)"])
    if probe[0] != 0:
        row("browser", "headless boot (console errors)", 0, "playwright not installed — skipped", skip=True)
        return
    code, out = run([py, "tools/browser_check.py"], timeout=300)
    row("browser", "headless boot (console errors)", code, summary(out, prefer=r"ok:|FAIL"))


def last_line(text: str) -> str:
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-1].strip() if lines else ""


def summary(text: str, *, prefer: str = r"passed|invariants|ok:|installed") -> str:
    """Pick the most informative line of a tool's output for the table."""
    import re
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    hits = [line for line in lines if re.search(prefer, line)]
    return (hits[-1] if hits else (lines[-1] if lines else ""))[:110]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the fuzz phases")
    ap.add_argument("--install", action="store_true", help="npm install the JS toolchain into .toolchain")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    if args.install:
        npm = shutil.which("npm")
        if not npm:
            print("npm is not available — cannot install the JS toolchain", file=sys.stderr)
        else:
            TOOLCHAIN.mkdir(exist_ok=True)
            (TOOLCHAIN / "package.json").write_text(json.dumps({"name": "cardputer-toolchain", "private": True}), encoding="utf-8")
            print("installing typescript + esbuild + eslint into .toolchain …")
            code, out = run([npm, "i", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", str(TOOLCHAIN),
                             "typescript@5.6.3", "esbuild@0.24.0", "eslint@8.57.1"], timeout=900)
            if code != 0:
                print(out, file=sys.stderr)

    t0 = time.time()
    check_py(args.quick)
    check_js(args.quick)
    check_build()
    check_browser()
    elapsed = time.time() - t0

    if args.json:
        print(json.dumps({"rows": ROWS, "seconds": round(elapsed, 1)}, indent=1))
    else:
        print("\nCardputer EMU — quality gate\n")
        area_w = max(len(r[0]) for r in ROWS)
        check_w = max(len(r[1]) for r in ROWS)
        print(f"  {'':<{area_w}}  {'check':<{check_w}}  verdict  detail")
        print(f"  {'-' * area_w}  {'-' * check_w}  -------  ------")
        for area, check, verdict, note in ROWS:
            mark = {"pass": "  ✓  ", "FAIL": "  ✗  ", "skip": "  –  "}[verdict]
            print(f"  {area:<{area_w}}  {check:<{check_w}}{mark}{note}")
        failed = [r for r in ROWS if r[2] == "FAIL"]
        skipped = [r for r in ROWS if r[2] == "skip"]
        print(f"\n  {len(ROWS) - len(failed) - len(skipped)} passed, {len(failed)} failed, {len(skipped)} skipped  ({elapsed:.1f}s)\n")
    return 1 if any(r[2] == "FAIL" for r in ROWS) else 0


if __name__ == "__main__":
    raise SystemExit(main())
