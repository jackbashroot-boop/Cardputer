"""Config + persistent state, stored as plain JSON next to the app.

    <root>/data/config.json   user preferences (channel, feed, auto-update)
    <root>/data/state.json    the emulated device state (SD card, modules, settings)
    <root>/data/snapshots/    rollback snapshots created by the updater
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

DEFAULTS = {
    "channel": "stable",
    "feed": "updates/manifest.json",
    "auto_update": True,
    "port": 8787,
    "host": "0.0.0.0",
    "open_browser": True,
    "dev_mode": False,
}


def ensure_dirs() -> None:
    for sub in ("", "snapshots", "downloads", "staging"):
        (DATA / sub).mkdir(parents=True, exist_ok=True)


def _read_json(path: Path, fallback):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def _write_json_atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_config() -> dict:
    ensure_dirs()
    cfg = dict(DEFAULTS)
    cfg.update(_read_json(DATA / "config.json", {}) or {})
    return cfg


def save_config(cfg: dict) -> dict:
    ensure_dirs()
    merged = dict(DEFAULTS)
    merged.update(cfg or {})
    _write_json_atomic(DATA / "config.json", merged)
    return merged


def load_state() -> dict:
    ensure_dirs()
    return _read_json(DATA / "state.json", {}) or {}


def save_state(state: dict) -> dict:
    ensure_dirs()
    snap = {"saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **(state or {})}
    _write_json_atomic(DATA / "state.json", snap)
    return snap
