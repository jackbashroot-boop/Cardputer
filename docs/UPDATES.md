# Updates and upgrades

Two things can be updated independently:

| Kind | What it is | Applied |
| --- | --- | --- |
| **Core** | `cardputer.html`, `src/`, anything the package ships | next launch (files replaced in place) |
| **Soft** | module catalog (`updates/catalog.json`) and firmware apps (`updates/apps/*.js`) | immediately, live in the running page |

## Feed format — `updates/manifest.json`

```json
{
  "schema": 1,
  "app": "cardputer-emu",
  "generated": "2026-11-05",
  "releases": [
    {
      "version": "1.1.0",
      "channel": "stable",
      "date": "2026-11-05",
      "notes": ["Feed catalog: Unit CO2, Unit Accel, Unit Kmeter", "New firmware app: Weather"],
      "requires": "1.0.0",
      "url": "updates/packages/cardputer-emu-1.1.0.zip",
      "sha256": "5933a55b…59e7a9",
      "size": 3634,
      "soft": {
        "catalog": "updates/catalog.json",
        "apps": ["updates/apps/weather.js"]
      }
    }
  ]
}
```

* `url` may be relative to the project root, a `file://` path, or an `https://` URL.
* `sha256` is **mandatory** — unsigned releases are refused.
* `channel` is `stable` or `beta`; `--channel beta` also accepts stable releases.
* `soft` is optional; it is what makes a new sensor unit or firmware app appear without
  a restart.

## Package format

A plain `.zip` whose paths are relative to the project root:

```
VERSION                     the new version (single line)
updates/catalog.json        (optional) soft payload
updates/apps/weather.js     (optional) soft payload
cardputer.html         (optional) rebuilt core bundle
```

`data/` is never touched by an update, so user state (SD card contents, settings,
snapshots) survives.

## Publishing a release

```bash
python tools/make_update.py \
  --version 1.2.0 --channel stable \
  --files updates/catalog.json updates/apps/weather.js cardputer.html \
  --soft '{"catalog":"updates/catalog.json","apps":["updates/apps/weather.js"]}' \
  --note "Grove: Unit CO2, Accel, Kmeter" \
  --note "fix: relay debounce"
```

The tool zips the files, adds `VERSION`, computes the SHA-256, and inserts/replaces the
entry in `updates/manifest.json` (sorted newest-first). Re-running for the same version
rewrites it, so publishing is idempotent.

Then point clients at the feed — either the local default, or your own server:

```bash
python run.py --feed https://example.com/cardputer/manifest.json
```

The feed URL is also editable in the **Updates** panel and is stored in
`data/config.json`.

## CLI

```bash
python run.py --check                 # what's available (prints notes)
python run.py --update                # apply now, then rebuild the bundle
python run.py --rollback              # restore the newest snapshot
python run.py --status                # installed version, channel, catalog, snapshots
python run.py --channel beta --check  # prereleases
python run.py --no-auto-update        # skip the launch check this run
```

## HTTP API (used by the UI)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/info` | version, channel, feed, platform, whether the native launcher is present |
| GET | `/api/update/check?channel=stable` | `{current, available, releases, log}` |
| POST | `/api/update/apply` | `{version?}` → `{ok, version, log, soft, reload}` |
| POST | `/api/update/rollback` | → `{ok, version, log}` |
| GET | `/api/update/status` | history, snapshots, catalog version |
| GET | `/api/feed` | raw manifest |
| GET/POST | `/api/state` | emulated device state (SD card, modules, settings) |
| GET | `/api/proxy?url=` | HTTP fetch for firmware Wi-Fi apps |
| POST | `/api/reset` | factory reset (clears user data) |

## Safety properties

* hash verification before anything is unpacked;
* zip path traversal (`..`, absolute paths) rejected;
* only package-owned paths are written — `data/`, `.git/`, `node_modules/` are skipped;
* every replaced file is snapshotted first, so `--rollback` always has something to
  restore;
* `VERSION` is only pinned after all files land;
* failures are reported as data (never exceptions) so the UI can show them:
  `{"ok": false, "error": "...", "log": [...]}`.

Both properties are covered by `tests/test_updater.py` (tampered package refused,
unsigned package refused, apply → rollback round-trip).
