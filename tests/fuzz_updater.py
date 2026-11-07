#!/usr/bin/env python3
"""Adversarial fuzzer for the auto-updater.

Everything here is hostile input: mangled manifests, byte-flipped feeds, zip
slip, symlinks, zip bombs, truncated archives, unsigned packages, impossible
version strings, hostile feeds and hostile catalogues. The invariants are:

  * every call either succeeds or raises UpdateError — never any other exception
  * a failed apply leaves VERSION, data/ and installed files untouched
  * nothing is ever written outside the project root (no traversal, no symlink escape)
  * a package that fails verification is never unpacked

    python3 tests/fuzz_updater.py            # ~1 200 hostile cases
    python3 tests/fuzz_updater.py --cases 5000 --seed 7
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cardputer.updater import UpdateError, Updater, compare, version_key  # noqa: E402

PASS = FAIL = 0
FAILURES: list[str] = []
CHECKS = 0


def ok(cond: bool, name: str, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(f"{name}{': ' + detail if detail else ''}")


def case(name: str, fn) -> None:
    global PASS, FAIL
    try:
        fn()
        PASS += 1
    except Exception as exc:
        FAIL += 1
        FAILURES.append(f"{name}: {exc}")


# --------------------------------------------------------------- fixtures ---
def sandbox() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="cardputer-fuzz-"))
    for name in ("VERSION", "updates"):
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, tmp / name)
        elif src.exists():
            shutil.copy2(src, tmp / name)
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    (tmp / "docs").mkdir(parents=True, exist_ok=True)
    (tmp / "docs" / "keep.txt").write_text("original\n", encoding="utf-8")
    return tmp


def write_feed(root: Path, feed: dict | str, name: str = "fuzz.json") -> Path:
    path = root / "updates" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(feed if isinstance(feed, str) else json.dumps(feed, indent=2), encoding="utf-8")
    return path


def base_feed(root: Path, *, version="9.9.9", sha=None, url=None, extra=None) -> dict:
    feed = {
        "schema": 1,
        "channel": "stable",
        "generated": "2026-11-07",
        "latest": version,
        "releases": [{
            "version": version,
            "channel": "stable",
            "notes": "fuzz release",
            "url": url if url is not None else "fuzz-pkg.zip",
            "sha256": sha if sha is not None else "0" * 64,
            "size": 1234,
        }],
        "catalog": [],
        "apps": [],
    }
    if extra:
        feed.update(extra)
    return feed


def make_zip(path: Path, entries: dict[str, bytes | None], *, symlinks: dict[str, str] | None = None,
             compress=zipfile.ZIP_DEFLATED) -> Path:
    """entries: name -> bytes (None = directory). symlinks: name -> target."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compress) as zf:
        for name, data in entries.items():
            if data is None:
                zf.writestr(zipfile.ZipInfo(name.rstrip("/") + "/"), b"")
            else:
                zf.writestr(name, data)
        for name, target in (symlinks or {}).items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3                      # unix
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, target)
    return path


def sha256_of(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def installed(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def tree_state(root: Path) -> dict[str, int]:
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and "data" not in p.parts and "updates" not in p.parts:
            out[str(p.relative_to(root))] = p.stat().st_size
    return out


# ----------------------------------------------------------- fuzz helpers ---
GARBAGE = ['', ' ', '{', '}', 'null', 'true', '[]', '"x"', '0', 'NaN', '{"latest":}', '\x00\x01\x02',
           '{"latest":null}', '{"releases":[[]]}', 'x' * 5000, '{"a":1e999}']


def mutate_text(text: str, rng: random.Random) -> str:
    """Flip/insert/delete a byte-ish unit in a JSON document."""
    if not text:
        return rng.choice(GARBAGE)
    op = rng.randrange(5)
    i = rng.randrange(len(text))
    ch = rng.choice('{}[]",:0123456789abcdef-\\ \x00\xff')
    if op == 0:
        return text[:i] + ch + text[i:]
    if op == 1:
        return text[:i] + text[i + 1:]
    if op == 2:
        return text[:i] + ch + text[i + 1:]
    if op == 3:
        return text[:i]
    return text + ch


HOSTILE_VERSIONS = ['', 'x', '0', '-1', '1..2', '999999999999999999999999.0.0', '1.0.0-', 'v1.0.0',
                    '1.0.0+build', ' 1.0.0', '1.0.0\n', '9' * 400, '1.0.0-β', '\x00', '../1.0.0',
                    '1.0.0; rm -rf /', '1.0.0%00', '<script>', '1.0.0/../1.0.1']


# ---------------------------------------------------------------- checks ----
def check_version_parser() -> None:
    for v in HOSTILE_VERSIONS:
        key = version_key(v)                     # must never raise
        ok(isinstance(key, tuple), "version_key returns a tuple", repr(v))
        ok(compare(v, v) == 0, "a version equals itself", repr(v))
    for a, b in [("1.0.0", "1.0.0-beta.1"), ("1.0.0-rc.1", "1.0.0-rc.2"), ("2.0.0", "10.0.0")]:
        ok(compare(a, b) != 0, "distinct versions order", f"{a} vs {b}")


def check_malformed_feed(rng: random.Random, cases: int) -> None:
    root = sandbox()
    up = Updater(root=root)
    baseline = installed(root)
    good = json.dumps(base_feed(root))
    for i in range(cases):
        text = good
        for _ in range(rng.randrange(1, 6)):
            text = mutate_text(text, rng)
        if rng.random() < 0.2:
            text = rng.choice(GARBAGE)
        feed = write_feed(root, text, f"fuzz{i}.json")
        try:
            res = up.check(channel="stable", feed=feed.as_uri())
            ok(isinstance(res, dict), "check returns a dict")
            ok("ok" in res, "check reports ok flag")
            ok(installed(root) == baseline, "VERSION untouched by a check")
            if res.get("ok"):
                ok(isinstance(res.get("releases") or [], list), "releases is a list")
                avail = res.get("available")
                ok(avail is None or isinstance(avail, dict), "available is a dict or None")
                if avail:
                    ok(isinstance(avail.get("version"), str), "available version is a string")
        except UpdateError:
            pass                                  # a clean refusal is fine
        except Exception as exc:
            raise AssertionError(f"feed case {i} raised {type(exc).__name__}: {exc}\n{text[:160]}") from exc
    shutil.rmtree(root, ignore_errors=True)


def check_hostile_release_fields(rng: random.Random, cases: int) -> None:
    """Structurally valid JSON with poisoned fields."""
    root = sandbox()
    up = Updater(root=root)
    poisons = [
        {"url": ""}, {"url": None}, {"url": "http://127.0.0.1:1/nope.zip"},
        {"url": "ftp://example.com/x.zip"}, {"url": "../../../../etc/passwd"},
        {"url": "/etc/passwd"}, {"url": "file:///etc/passwd"},
        {"sha256": ""}, {"sha256": "zz" * 32}, {"sha256": "0" * 63}, {"sha256": None},
        {"sha256": 12345}, {"sha256": "0" * 64 + "00"},
        {"size": -1}, {"size": 10 ** 18}, {"size": "big"},
        {"notes": 1e308}, {"notes": ["a"]}, {"channel": None}, {"channel": 42},
        {"version": None}, {"version": 1.0}, {"version": []},
    ]
    for i in range(cases):
        entry = {"version": rng.choice(["9.9.9", "1.1.0", "0.0.1", "x"]), "channel": "stable",
                 "url": "missing.zip", "sha256": "0" * 64, "size": 1}
        entry.update(rng.choice(poisons))
        feed = base_feed(root, extra={"latest": entry.get("version") or "9.9.9"})
        feed["releases"] = [entry]
        path = write_feed(root, feed, f"poison{i}.json")
        before = installed(root)
        try:
            res = up.check(channel="stable", feed=path.as_uri())
            ok(isinstance(res, dict), "check ok")
            if res.get("ok"):
                r = up.apply(channel="stable", feed=path.as_uri())
                ok(isinstance(r, dict), "apply returns a dict")
                ok("ok" in r, "apply reports ok")
                if not r.get("ok"):
                    ok(installed(root) == before, "failed apply left VERSION alone", str(r.get("error"))[:80])
        except UpdateError:
            pass
        except Exception as exc:
            raise AssertionError(f"release-field case {i} raised {type(exc).__name__}: {exc}") from exc
        ok(installed(root) == before, "VERSION stable across a hostile feed", f"{before} -> {installed(root)}")
    shutil.rmtree(root, ignore_errors=True)


def check_hostile_zips() -> None:
    """Every hostile archive must be rejected and must not touch the tree."""
    variants: dict[str, dict] = {
        "traversal": {"files": {"../escaped.txt": b"pwn", "web/index.html": b"<html>"}},
        "deep-traversal": {"files": {"../../../../tmp/escaped.txt": b"pwn"}},
        "absolute": {"files": {"/tmp/absolute-escape.txt": b"pwn"}},
        "windows-abs": {"files": {"C:\\Windows\\evil.txt": b"pwn", "web/index.html": b"hi"}},
        "backslash-traversal": {"files": {"..\\..\\evil.txt": b"pwn"}},
        "symlink-escape": {"files": {"web/index.html": b"hi"}, "symlinks": {"link": "/etc/passwd"}},
        "symlink-dir": {"files": {}, "symlinks": {"web": "/tmp"}},
        "no-version": {"files": {"web/index.html": b"hi"}},
        "duplicate-entries": {"files": {"VERSION": b"9.9.9\n", "VERSION": b"1.0.0\n"}},
        "empty": {"files": {}},
        "nul-name": {"files": {"web/index\x00.html": b"hi"}},
        "dot-dot-name": {"files": {"web/..": b"hi"}},
    }
    root = sandbox()
    up = Updater(root=root)
    for name, spec in variants.items():
        pkg = make_zip(root / "updates" / f"{name}.zip", spec["files"], symlinks=spec.get("symlinks"))
        good = base_feed(root, version="9.9.9", sha=sha256_of(pkg), url=f"updates/{pkg.name}")
        feed = write_feed(root, good, f"{name}.json")
        before_version, before_tree = installed(root), tree_state(root)
        try:
            res = up.apply(channel="stable", feed=feed.as_uri())
            ok(isinstance(res, dict), "apply returns a dict")
            if res.get("ok"):
                raise AssertionError(f"hostile archive '{name}' was accepted")
        except UpdateError:
            pass
        except AssertionError:
            raise
        except Exception as exc:
            raise AssertionError(f"{name}: raised {type(exc).__name__}: {exc}") from exc
        ok(installed(root) == before_version, f"{name}: VERSION untouched")
        ok(tree_state(root) == before_tree, f"{name}: project tree untouched")
        ok(not (root / "escaped.txt").exists(), f"{name}: no file escaped the root")
        ok(not Path("/tmp/absolute-escape.txt").exists() or name != "absolute", f"{name}: absolute path blocked")
    shutil.rmtree(root, ignore_errors=True)


def check_bad_hash_and_truncation() -> None:
    root = sandbox()
    up = Updater(root=root)
    good_pkg = make_zip(root / "updates" / "good.zip",
                        {"VERSION": b"9.9.9\n", "web/index.html": b"<html>new</html>",
                         "cardputer.html": b"<html>app</html>"})
    real = sha256_of(good_pkg)
    cases = {
        "wrong-hash": real[:-1] + ("0" if real[-1] != "0" else "1"),
        "short-hash": real[:64 - 4],
        "uppercase-hash": real.upper(),
        "empty-hash": "",
    }
    for name, sha in cases.items():
        feed = write_feed(root, base_feed(root, sha=sha, url="updates/good.zip"), f"{name}.json")
        before = installed(root)
        res = up.apply(channel="stable", feed=feed.as_uri())
        # an uppercase hash is equivalent — accept either behaviour, but never a bad file
        if name == "uppercase-hash":
            ok(res.get("ok") in (True, False), "uppercase hash handled")
            if res.get("ok"):
                ok(installed(root) == "9.9.9", "uppercase hash applied the package")
                (root / "VERSION").write_text("1.0.0\n", encoding="utf-8")
            continue
        ok(res.get("ok") is False, f"{name}: package refused", str(res.get("error")))
        ok(installed(root) == before, f"{name}: VERSION untouched")
    # truncated archive with a *correct* hash of the truncated bytes
    blob = good_pkg.read_bytes()
    trunc = root / "updates" / "truncated.zip"
    trunc.write_bytes(blob[: len(blob) // 2])
    feed = write_feed(root, base_feed(root, sha=sha256_of(trunc), url="updates/truncated.zip"), "trunc.json")
    before = installed(root)
    res = up.apply(channel="stable", feed=feed.as_uri())
    ok(res.get("ok") is False, "truncated package refused", str(res.get("error")))
    ok(installed(root) == before, "truncated package left VERSION alone")
    shutil.rmtree(root, ignore_errors=True)


def check_zip_bomb() -> None:
    """A 200 MB-of-zeros archive must not be unpacked into the tree."""
    root = sandbox()
    up = Updater(root=root)
    bomb = root / "updates" / "bomb.zip"
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("VERSION", b"9.9.9\n")
        zf.writestr("web/bomb.bin", b"\0" * (200 * 1024 * 1024))
    ok(bomb.stat().st_size < 1024 * 1024, "the bomb itself compresses small", str(bomb.stat().st_size))
    feed = write_feed(root, base_feed(root, sha=sha256_of(bomb), url="updates/bomb.zip"), "bomb.json")
    before = installed(root)
    try:
        res = up.apply(channel="stable", feed=feed.as_uri())
        if res.get("ok"):
            raise AssertionError("zip bomb was unpacked")
    except UpdateError:
        pass
    ok(installed(root) == before, "zip bomb left VERSION alone")
    ok(not any(p.stat().st_size > 64 * 1024 * 1024 for p in root.rglob("*") if p.is_file()),
       "no giant file materialised on disk")
    shutil.rmtree(root, ignore_errors=True)


def check_hostile_catalog(rng: random.Random, cases: int) -> None:
    """The soft payload (catalog + apps) must never break the client contract."""
    root = sandbox()
    up = Updater(root=root)
    poisons = [
        {"catalog": "nope"}, {"catalog": {}}, {"catalog": [None, 1, "x"]},
        {"catalog": [{"id": "dup"}, {"id": "dup"}]},
        {"catalog": [{"id": "", "name": None}]},
        {"catalog": [{"id": "x", "addrs": "0x29"}]},
        {"apps": "nope"}, {"apps": [{"id": "../../evil.js"}]},
        {"apps": [{"id": "a", "url": "javascript:alert(1)"}]},
        {"apps": [{"id": "a", "url": "http://127.0.0.1:1/x.js"}]},
        {"catalog": [], "apps": [], "soft": None},
        {"catalog": [], "apps": [], "soft": "yes"},
        {"schema": "one"}, {"schema": -1}, {"schema": 10 ** 12},
        {"channel": "nightly"}, {"latest": "9.9.9", "releases": None},
    ]
    for i in range(cases):
        extra = rng.choice(poisons)
        feed = write_feed(root, base_feed(root, extra=extra), f"cat{i}.json")
        try:
            res = up.check(channel="stable", feed=feed.as_uri())
            ok(isinstance(res, dict), "check ok")
            payload = res.get("soft") or {}
            cat = payload.get("catalog")
            if cat is not None:
                ok(isinstance(cat, list), "catalog is a list")
                ids = [c.get("id") for c in cat if isinstance(c, dict)]
                ok(len(ids) == len(set(ids)), "catalog ids are unique", str(ids)[:80])
            apps = payload.get("apps")
            if apps is not None:
                ok(isinstance(apps, list), "apps is a list")
                for a in apps:
                    if isinstance(a, dict):
                        ok(isinstance(a.get("id"), str), "app id is a string")
                        ok("/" not in (a.get("id") or "") and ".." not in (a.get("id") or ""),
                           "app id is a plain slug", repr(a.get("id")))
        except UpdateError:
            pass
        except Exception as exc:
            raise AssertionError(f"catalog case {i} raised {type(exc).__name__}: {exc}") from exc
    shutil.rmtree(root, ignore_errors=True)


def check_snapshot_hygiene() -> None:
    """The updater must never write outside data/ and never eat user data."""
    root = sandbox()
    up = Updater(root=root)
    (root / "data" / "state.json").write_text('{"mine":true}', encoding="utf-8")
    (root / "data" / "sd" / "firmware").mkdir(parents=True, exist_ok=True)
    (root / "data" / "sd" / "firmware" / "app.txt").write_text("user file", encoding="utf-8")
    pkg = make_zip(root / "updates" / "ok.zip", {
        "VERSION": b"9.9.9\n",
        "data/state.json": b'{"clobbered":true}',
        "data/sd/firmware/app.txt": b"overwritten",
        "docs/keep.txt": b"replaced by the package\n",
    })
    feed = write_feed(root, base_feed(root, sha=sha256_of(pkg), url="updates/ok.zip"), "hygiene.json")
    res = up.apply(channel="stable", feed=feed.as_uri())
    ok(res.get("ok") is True, "well-formed package applies", str(res.get("error")))
    ok(json.loads((root / "data" / "state.json").read_text()) == {"mine": True}, "user data/ untouched")
    ok((root / "data" / "sd" / "firmware" / "app.txt").read_text() == "user file", "SD image untouched")
    ok((root / "docs" / "keep.txt").read_text().startswith("replaced"), "project files did get updated")
    ok(installed(root) == "9.9.9", "VERSION updated last")
    shutil.rmtree(root, ignore_errors=True)



def check_version_path_traversal() -> None:
    """A hostile version string must never become a path (staging/download escape)."""
    root = sandbox()
    up = Updater(root=root)
    pkg = make_zip(root / "updates" / "ok2.zip", {"VERSION": b"9.9.9\n", "web/index.html": b"hi"})
    sha = sha256_of(pkg)
    outside = Path(tempfile.mkdtemp(prefix="cardputer-escape-"))
    hostile = ["../../escape", "..\\..\\escape", f"../../../../{outside}/pwn", "1.0.0/../../x",
               "C:\\Windows\\evil", "\\x00", "./../..", "..", ".", "%2e%2e%2fescape", "a" * 300]
    for i, version in enumerate(hostile):
        feed = base_feed(root, version=version, sha=sha, url="updates/ok2.zip")
        feed["latest"] = version
        path = write_feed(root, feed, f"ver{i}.json")
        before = installed(root)
        try:
            res = up.apply(channel="stable", feed=path.as_uri())
            ok(isinstance(res, dict), "apply returns a dict")
            if res.get("ok"):
                # If it installed, everything it touched must still live under root.
                installed_version = installed(root)
                ok(".." not in installed_version, "VERSION never contains traversal", repr(installed_version))
        except UpdateError:
            pass
        except Exception as exc:
            raise AssertionError(f"version {version!r} raised {type(exc).__name__}: {exc}") from exc
        ok(not (outside / "pwn").exists(), f"nothing written outside the root for {version!r}")
        ok(not (root.parent / "escape").exists(), "no sibling directory created")
        ok((root / "data" / "staging").exists() and all(
            p.resolve().is_relative_to((root / "data" / "staging").resolve())
            for p in (root / "data" / "staging").rglob("*")
        ), "staging stays inside data/staging")
        void = before
        del void
    shutil.rmtree(outside, ignore_errors=True)
    shutil.rmtree(root, ignore_errors=True)


def check_rollback_edges() -> None:
    root = sandbox()
    up = Updater(root=root)
    baseline = installed(root)
    r = up.rollback()
    ok(isinstance(r, dict) and r.get("ok") is False, "rollback with no snapshot is refused", str(r))
    ok(installed(root) == baseline, "VERSION untouched by an empty rollback")
    # a poisoned snapshot.json must not crash the rollback path
    snap = root / "data" / "snapshots" / "20260101-000000"
    snap.mkdir(parents=True, exist_ok=True)
    (snap / "snapshot.json").write_text('{"version": 5, "files": "nope"}', encoding="utf-8")
    try:
        r = up.rollback()
        ok(isinstance(r, dict), "rollback returns a dict even with a broken snapshot")
    except UpdateError:
        pass
    except Exception as exc:
        raise AssertionError(f"rollback raised {type(exc).__name__}: {exc}") from exc
    shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20261107)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    print(f"\nCardputer EMU updater fuzz  (seed {args.seed}, {args.cases} cases per phase)\n")
    phases = [
        ("version parser", check_version_parser),
        ("malformed feed", lambda: check_malformed_feed(rng, args.cases)),
        ("hostile fields", lambda: check_hostile_release_fields(rng, args.cases)),
        ("hostile archives", check_hostile_zips),
        ("version traversal", check_version_path_traversal),
        ("hash / truncation", check_bad_hash_and_truncation),
        ("zip bomb", check_zip_bomb),
        ("hostile catalogue", lambda: check_hostile_catalog(rng, args.cases)),
        ("snapshot hygiene", check_snapshot_hygiene),
        ("rollback edges", check_rollback_edges),
    ]
    for name, fn in phases:
        before = len(FAILURES)
        case(name, fn)
        mark = "\u2713" if len(FAILURES) == before else "\u2717"
        print(f"  {mark} {name}")
    print(f"\n{CHECKS} invariants checked, {len(FAILURES)} failure(s)")
    for f in FAILURES[:20]:
        print("  ! " + f)
    print()
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
