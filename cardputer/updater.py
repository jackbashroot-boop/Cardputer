"""Automatic update / upgrade engine.

Flow
----
1. ``check()``  fetch the release feed (local path or https URL), compare versions
                with semver rules, pick the newest entry for the channel.
2. ``apply()``  download the package, verify its SHA-256, unpack into a staging
                directory, snapshot the files it will replace, then copy them in
                atomically and bump ``VERSION``.
3. ``rollback()`` restore the most recent snapshot.

Every step appends to a log list that the UI shows verbatim, so an upgrade is
observable rather than magic. Unsigned packages are refused by default.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

from . import config

ROOT = config.ROOT
DATA = config.DATA


class UpdateError(RuntimeError):
    pass


# Hard limits for a hostile package. A feed is remote input, so the unpacker is
# defensive: bounded member count, bounded uncompressed size, bounded compression
# ratio, no symlinks, no absolute paths, no traversal.
MAX_MEMBERS = 5000
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_RATIO = 200
SAFE_TOKEN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$")


def safe_token(value: object, fallback: str = "pkg") -> str:
    """A filesystem-safe token for a version/directory name (never '../..').

    Hostile versions ("../../tmp", "1.0.0/../..", NUL bytes) are reduced to a
    stable, collision-free token instead of being passed to the filesystem.
    """
    text = str(value if value is not None else "").strip()
    cleaned = re.sub(r"[^0-9A-Za-z.+_-]", "_", text.replace("..", "_"))
    cleaned = cleaned.strip("._-")[:64]
    if text and SAFE_TOKEN.match(cleaned or "") and cleaned == text:
        return cleaned
    digest = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:10]
    return f"{fallback}-{digest}"


def _as_list(value: object) -> list:
    return value if isinstance(value, list) else []


def _as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def sanitise_soft(soft: object) -> dict:
    """Coerce the feed's soft payload (catalogue + apps) into the shape the UI
    expects: lists of dicts with unique, slug-like ids. Anything else is dropped."""
    soft = _as_dict(soft)
    out: dict = {}
    catalog = []
    seen: set[str] = set()
    for item in _as_list(soft.get("catalog")):
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        if not mid or mid in seen or not re.match(r"^[a-z0-9][a-z0-9._-]{0,63}$", mid):
            continue
        seen.add(mid)
        catalog.append(item)
    if catalog:
        out["catalog"] = catalog
    apps = []
    seen = set()
    for item in _as_list(soft.get("apps")):
        if not isinstance(item, dict):
            continue
        aid = str(item.get("id") or "").strip()
        url = str(item.get("url") or "").strip()
        if not re.match(r"^[a-z0-9][a-z0-9._-]{0,63}$", aid) or aid in seen:
            continue
        if not url or url.startswith(("javascript:", "data:", "vbscript:")):
            continue
        seen.add(aid)
        entry = dict(item)
        entry["id"] = aid
        entry["url"] = url
        apps.append(entry)
    if apps:
        out["apps"] = apps
    if "version" in soft:
        out["version"] = str(soft.get("version"))[:32]
    return out


# --------------------------------------------------------------------------- #
#  semver
# --------------------------------------------------------------------------- #
_VER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$")


def parse_version(text: str) -> tuple:
    m = _VER_RE.match(str(text or "").strip())
    if not m:
        return (0, 0, 0, "")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4) or "")


def version_key(text: str) -> tuple:
    major, minor, patch, pre = parse_version(text)
    # a release sorts after any prerelease of the same number
    return (major, minor, patch, 0 if pre else 1, pre)


def compare(a: str, b: str) -> int:
    ka, kb = version_key(a), version_key(b)
    return (ka > kb) - (ka < kb)


def installed_version() -> str:
    path = ROOT / "VERSION"
    try:
        return path.read_text(encoding="utf-8").strip() or "1.0.0"
    except OSError:
        return "1.0.0"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
#  updater
# --------------------------------------------------------------------------- #
class Updater:
    def __init__(self, root: Path | None = None, cfg: dict | None = None):
        self.root = Path(root or ROOT)
        self.data = self.root / "data"
        self.data.mkdir(parents=True, exist_ok=True)
        for sub in ("snapshots", "downloads", "staging"):
            (self.data / sub).mkdir(parents=True, exist_ok=True)
        self.cfg = cfg or config.load_config()

    # -- version ------------------------------------------------------------
    def installed_version(self) -> str:
        try:
            return (self.root / "VERSION").read_text(encoding="utf-8").strip() or "1.0.0"
        except OSError:
            return "1.0.0"

    # -- feed ---------------------------------------------------------------
    def resolve_feed(self, feed: str | None = None) -> str:
        feed = feed or self.cfg.get("feed") or "updates/manifest.json"
        if feed.startswith(("http://", "https://", "file://")):
            return feed
        return (self.root / feed).as_uri()

    def load_feed(self, feed: str | None = None) -> dict:
        url = self.resolve_feed(feed)
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                raw = resp.read().decode("utf-8")
        except Exception as exc:
            raise UpdateError(f"cannot read feed {url}: {exc}") from exc
        try:
            manifest = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise UpdateError(f"feed is not valid JSON: {exc}") from exc
        if not isinstance(manifest, dict):
            raise UpdateError(f"feed is not a JSON object (got {type(manifest).__name__})")
        # Normalise. A remote feed may contain anything: nulls, strings, arrays of
        # arrays. Everything downstream can then assume lists of dicts.
        releases = [r for r in _as_dict(manifest).get("releases", []) if isinstance(r, dict)] \
            if isinstance(manifest.get("releases"), list) else []
        manifest["releases"] = releases
        for rel in releases:
            rel["version"] = str(rel.get("version") or "").strip()
            rel["channel"] = str(rel.get("channel") or "stable")
            rel["soft"] = sanitise_soft(rel.get("soft"))
        manifest["soft"] = sanitise_soft(manifest.get("soft"))
        manifest["catalog"] = sanitise_soft({"catalog": manifest.get("catalog")}).get("catalog", [])
        manifest["apps"] = sanitise_soft({"apps": manifest.get("apps")}).get("apps", [])
        return manifest

    def check(self, channel: str | None = None, feed: str | None = None) -> dict:
        channel = channel or self.cfg.get("channel", "stable")
        log: list[str] = []
        current = self.installed_version()
        log.append(f"installed: v{current}")
        try:
            manifest = self.load_feed(feed)
        except UpdateError as exc:
            log.append(str(exc))
            return {"ok": False, "current": current, "available": None, "log": log, "error": str(exc)}

        releases = [r for r in _as_list(manifest.get("releases")) if isinstance(r, dict)]
        cand = [r for r in releases if channel == "beta" or r.get("channel", "stable") == channel]
        cand = [r for r in cand if str(r.get("version") or "").strip()]
        cand.sort(key=lambda r: version_key(str(r.get("version") or "0.0.0")), reverse=True)
        log.append(f"feed: {len(releases)} release(s), channel={channel}")
        if not cand:
            log.append("no releases for this channel")
            return {"ok": True, "current": current, "available": None, "releases": releases, "log": log}

        newest = cand[0]
        newer = compare(str(newest.get("version") or "0.0.0"), current) > 0
        log.append(
            f"newest on channel: v{newest.get('version')}"
            + (" — update available" if newer else " — nothing to do")
        )
        return {
            "ok": True,
            "current": current,
            "available": newest if newer else None,
            "releases": releases,
            "channel": channel,
            "log": log,
        }

    # -- download + verify --------------------------------------------------
    def _download(self, entry: dict) -> Path:
        url = entry.get("url")
        if not url:
            raise UpdateError("release entry has no package url")
        if not url.startswith(("http://", "https://", "file://")):
            url = (self.root / url).as_uri()
        dest = self.data / "downloads" / f"cardputer-emu-{safe_token(entry.get('version'))}.zip"
        try:
            with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as fh:
                shutil.copyfileobj(resp, fh)
        except Exception as exc:
            raise UpdateError(f"download failed: {exc}") from exc
        return dest

    def _verify(self, path: Path, entry: dict, log: list[str]) -> None:
        want = (entry.get("sha256") or "").strip().lower()
        got = _sha256(path)
        if not want:
            raise UpdateError("package has no sha256 in the feed — refusing unsigned update")
        if want != got:
            raise UpdateError(f"sha256 mismatch: feed={want[:16]}… file={got[:16]}…")
        log.append(f"sha256 ok: {got[:32]}…")

    # -- unpack -------------------------------------------------------------
    def _unpack(self, pkg: Path, staging: Path, log: list[str]) -> list[str]:
        """Extract a package with every guard the feed path needs: no traversal, no
        absolute paths, no symlinks/devices, bounded size and compression ratio."""
        try:
            zf = zipfile.ZipFile(pkg)
        except zipfile.BadZipFile as exc:
            raise UpdateError(f"package is not a valid zip: {exc}") from exc
        with zf:
            infos = zf.infolist()
            if len(infos) > MAX_MEMBERS:
                raise UpdateError(f"package declares {len(infos)} members (limit {MAX_MEMBERS})")
            members: list[str] = []
            seen_names: set[str] = set()
            total = 0
            for info in infos:
                name = info.filename
                pure = PurePosixPath(name.replace("\\", "/"))
                if pure.is_absolute() or ".." in pure.parts or ":" in pure.parts[0]:
                    raise UpdateError(f"unsafe path in package: {name}")
                if "\x00" in name:
                    raise UpdateError("package contains a NUL byte in a path")
                mode = (info.external_attr >> 16) & 0xFFFF
                if mode and (mode & 0o170000) in (0o120000, 0o140000, 0o060000, 0o020000):
                    raise UpdateError(f"package contains a special file (symlink/device): {name}")
                if name.endswith("/"):
                    continue
                if name in seen_names:
                    raise UpdateError(f"package contains duplicate entries: {name}")
                seen_names.add(name)
                members.append(name)
                total += max(0, int(info.file_size))
                if total > MAX_TOTAL_BYTES:
                    raise UpdateError("package expands beyond the size limit")
                if info.compress_size and info.file_size / max(1, info.compress_size) > MAX_RATIO:
                    raise UpdateError(f"suspicious compression ratio in {name}")
            for info in infos:
                if info.filename.endswith("/"):
                    continue
                target = staging / str(PurePosixPath(info.filename.replace("\\", "/")))
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with zf.open(info) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 256)
                except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
                    raise UpdateError(f"cannot extract {info.filename}: {exc}") from exc
        log.append(f"verified archive: {len(members)} member(s), {total} byte(s) uncompressed")
        return members

    # -- snapshot -----------------------------------------------------------
    def _snapshot(self, files: list[str], log: list[str]) -> Path:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        snap = self.data / "snapshots" / stamp
        snap.mkdir(parents=True, exist_ok=True)
        saved = []
        for rel in files:
            src = self.root / rel
            if src.exists():
                dst = snap / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                saved.append(rel)
        (snap / "snapshot.json").write_text(
            json.dumps({"version": self.installed_version(), "files": saved, "created": stamp}, indent=2),
            encoding="utf-8",
        )
        log.append(f"snapshot {stamp}: {len(saved)} file(s) backed up")
        return snap

    # -- apply --------------------------------------------------------------
    def apply(self, version: str | None = None, channel: str | None = None,
              feed: str | None = None) -> dict:
        try:
            return self._apply(version, channel, feed)
        except UpdateError as exc:
            return {"ok": False, "error": str(exc), "log": [f"refused: {exc}"],
                    "current": self.installed_version()}

    def _apply(self, version: str | None = None, channel: str | None = None,
               feed: str | None = None) -> dict:
        log: list[str] = []
        result = self.check(channel=channel, feed=feed)
        entry = result.get("available")
        if version:
            pool = [r for r in (result.get("releases") or []) if r.get("version") == version]
            entry = pool[0] if pool else None
        if not entry:
            log.append(f"nothing to install (installed v{self.installed_version()})")
            return {"ok": False, "error": "no update available", "log": log, "current": self.installed_version()}

        log.append(f"updating v{self.installed_version()} → v{safe_token(entry.get('version'))}")
        pkg = self._download(entry)
        log.append(f"downloaded {pkg.name} ({pkg.stat().st_size} bytes)")
        self._verify(pkg, entry, log)

        staging = self.data / "staging" / safe_token(entry.get("version"))
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True, exist_ok=True)
        members = self._unpack(pkg, staging, log)
        log.append(f"extracted {len(members)} file(s) to staging")

        # A package must declare its own version and agree with the feed entry;
        # otherwise "what is installed" would depend on which side you ask.
        if "version" not in {str(PurePosixPath(m)).lower() for m in members}:
            raise UpdateError("package has no VERSION file")
        declared = (staging / "VERSION").read_text(encoding="utf-8", errors="replace").strip()
        claimed = str(entry.get("version") or "").strip()
        if claimed and declared != claimed:
            raise UpdateError(f"package declares v{declared or '?'} but the feed says v{claimed}")

        # which files does this package replace?
        targets = []
        for name in members:
            rel = str(PurePosixPath(name))
            targets.append(rel)
        self._snapshot(targets, log)

        # selective copy: never clobber user data, only package-owned paths
        protected = ("data/", "node_modules/", ".git/")
        copied = 0
        for name in members:
            rel = str(PurePosixPath(name))
            if any(rel.startswith(p) for p in protected):
                log.append(f"skipped protected path {rel}")
                continue
            src = staging / rel
            dst = self.root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_suffix(dst.suffix + ".new")
            shutil.copy2(src, tmp)
            os.replace(tmp, dst)
            copied += 1
        log.append(f"installed {copied} file(s)")

        new_version = entry.get("version") or self.installed_version()
        (self.root / "VERSION").write_text(new_version + "\n", encoding="utf-8")
        history = self._load_history()
        history["releases"].insert(0, {
            "version": new_version,
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "channel": entry.get("channel", "stable"),
            "soft": entry.get("soft") or {},
        })
        self._save_history(history)
        log.append(f"version pinned to {new_version}")
        soft = entry.get("soft") or {}
        if soft:
            log.append("soft payload queued: " + ", ".join(sorted(soft.keys())))
        return {"ok": True, "version": new_version, "log": log, "soft": soft,
                "previous": history["releases"][1]["version"] if len(history["releases"]) > 1 else None,
                "reload": True}

    # -- rollback -----------------------------------------------------------
    def rollback(self) -> dict:
        log: list[str] = []
        snaps = sorted([p for p in (self.data / "snapshots").iterdir() if p.is_dir()])
        if not snaps:
            return {"ok": False, "error": "no snapshot to roll back to", "log": ["no snapshots found"]}
        snap = snaps[-1]
        try:
            meta = json.loads((snap / "snapshot.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise UpdateError(f"snapshot {snap.name} is unreadable: {exc}") from exc
        if not isinstance(meta, dict):
            raise UpdateError(f"snapshot {snap.name} has no metadata object")
        log.append(f"rolling back to snapshot {snap.name} (v{meta.get('version')})")
        restored = 0
        for rel in [r for r in _as_list(meta.get("files")) if isinstance(r, str) and ".." not in PurePosixPath(r).parts]:
            src = snap / rel
            if not src.exists():
                continue
            dst = self.root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            restored += 1
        (self.root / "VERSION").write_text(str(meta.get("version", "0.0.0")) + "\n", encoding="utf-8")
        shutil.rmtree(snap)
        log.append(f"restored {restored} file(s), version now {meta.get('version')}")
        history = self._load_history()
        if history["releases"]:
            history["releases"].insert(0, {
                "version": str(meta.get("version")),
                "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "rolled_back": True,
            })
            self._save_history(history)
        return {"ok": True, "version": str(meta.get("version")), "log": log, "reload": True}

    # -- history ------------------------------------------------------------
    def _load_history(self) -> dict:
        path = self.data / "history.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"releases": []}

    def _save_history(self, payload: dict) -> None:
        (self.data / "history.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def history(self) -> dict:
        return self._load_history()

    # -- helpers ------------------------------------------------------------
    def catalogue_version(self) -> str | None:
        try:
            return json.loads((self.root / "updates" / "catalog.json").read_text(encoding="utf-8")).get("version")
        except (OSError, json.JSONDecodeError):
            return None

    def status(self) -> dict:
        """Everything the UI needs in one call."""
        cfg = config.load_config()
        hist = self._load_history()
        return {
            "version": self.installed_version(),
            "channel": cfg.get("channel", "stable"),
            "feed": cfg.get("feed"),
            "auto_update": bool(cfg.get("auto_update", True)),
            "catalogue": self.catalogue_version(),
            "history": hist.get("releases", [])[:8],
            "snapshots": sorted(p.name for p in (self.data / "snapshots").iterdir() if p.is_dir())[-5:],
        }
