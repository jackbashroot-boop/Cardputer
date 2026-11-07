# Cardputer Emulator v1.0 — fixes applied

Date: 2026-11-07
Fixed tree: `fixed/cardputer-emu/`
Original preserved tree: `unpacked/cardputer-emu/` (untouched)
Change record: `emulator-fixes.patch`
Redistributable fixed archive: `cardputer-emulator-v1.0-fixed.tar.gz`
SHA-256: `218d00867caaa6bca20daa4e9b41518b263b93d51c678c6f3a4829554403c1b8`

## 1. Critical: real ESP32-S3 firmware images were rejected (FIXED)

`src/js/core/flash.js` required the first 16 image-header bytes to XOR to
`0xEF`. No such header checksum exists in the ESP-IDF image format, so every
real firmware image — including both verified Cardputer binaries on hand —
was rejected as "header checksum mismatch — corrupted image".

Fixed to the real format:

- image checksum = XOR of all segment **payload** bytes, seeded `0xEF`;
- the checksum byte is located after zero padding so the length up to and
  including it is a multiple of 16 (the old offset math was also wrong);
- stored vs computed checksum mismatch is now a hard rejection with both
  values reported;
- an appended SHA-256 is recognised as exactly 32 trailing bytes and is
  **verified** (new dependency-free synchronous SHA-256 in `flash.js`,
  because `parseImage()` is synchronous and cannot await WebCrypto);
- any other trailing bytes after the checksum are rejected;
- implausible segment counts (0 or >16) are rejected;
- `esp_app_desc_t` ELF SHA now reads the full 32 bytes (was truncated to 16);
- the no-device default flash size in `FlashManager` is 8 MB as documented.

Regression evidence — both real binaries now parse, verify (appended SHA-256
verified) and "flash" into a simulated OTA slot; a one-byte payload
corruption and a truncated copy are both rejected without disturbing slot
bookkeeping:

- `aegis-phoenix-adv.bin` (Aegis PHOENIX v0.6.0): OK, ESP32-S3, 5 segments,
  entry `0x40377A1C`, checksum `0x6D`, SHA-256 verified.
- `AEGIS-Red-Team-v0.1.1-ADV.bin`: OK, ESP32-S3, 5 segments, entry
  `0x40377314`, checksum `0x73`, SHA-256 verified.

## 2. Tests encoded the wrong format (FIXED)

`tests/test_core.mjs` manufactured a header and tuned byte 8 until it
satisfied the fictional checksum, which is why the suite passed while real
images failed. The helper now builds images the way ESP-IDF does (WP pin
`0xEE`, payload checksum, 16-byte alignment), and the parser test now asserts:

- flipping the WP-pin header byte does **not** reject an image;
- flipping a segment payload byte **does** (checksum);
- trailing garbage after the checksum byte is rejected.

## 3. Environment-dependent installer test (FIXED)

`tests/test_install.py::test_missing_chromium_is_a_warning_not_a_failure`
redirects `HOME` to hide the browser cache; with a `pip install --user`
Playwright that also hid the Playwright package itself, so the installer
reported "Playwright not installed" and the test failed on any machine set up
that way. The test now passes the real site-packages directory through
`PYTHONPATH`, exercising the intended "importable but no browser download"
path on every install layout. All 14 installer tests pass.

## 4. Python lint gate (FIXED)

Running the project's own `ruff.toml` ruleset surfaced 11 findings, all fixed:

- `install.py`: f-string without placeholders; unused `noqa` directive.
- `tools/make_release.py`: three simplifiable conditionals (SIM102/SIM103),
  rewritten with identical behaviour.
- Executable bit restored on `build.py`, `install.py`, `run.py` and the
  test scripts (EXE001 — the shebangs were present but the files were not
  executable).

`ruff check .` is now clean.

## 5. Documentation (FIXED)

`docs/FLASH.md` repeated the fictional header-checksum rule; it now describes
the real payload checksum, the padding/alignment rule and appended-SHA-256
verification.

## Full quality gate — after fixes

`python3 tools/check.py` (with the JS toolchain installed via `--install`,
plus Ruff and Playwright/Chromium installed in this sandbox):

```
lint     ruff check .                                    ✓ All checks passed
tests    tests/test_updater.py                           ✓ 6 passed, 0 failed
tests    tests/test_install.py                           ✓ 14 install tests passed
fuzz     tests/fuzz_updater.py                           ✓ 2041 invariants, 0 failures
compile  esbuild bundle                                  ✓ 13 modules linked
types    tsc --checkJs                                   ✓ 0 errors
lint     eslint                                          ✓ clean
tests    node tests/test_core.mjs                        ✓ 36 passed, 0 failed
fuzz     tests/fuzz_core.mjs                             ✓ 8055 invariants, 0 failures
build    python build.py -> cardputer.html               ✓ 312.1 KB
build    python run.py --status                          ✓ installed v1.0.0
browser  headless boot (console errors)                  ✓ v1.0.0 · 17 apps · 50 modules · 0 console errors

12 passed, 0 failed, 0 skipped
```

Previously 3 of these rows were skipped (tsc, eslint, browser) and the
browser row had never run here. The fixed emulator is running from
`fixed/cardputer-emu/` on port 8787 (see the live preview).

## Still true by design (not defects)

- Real `.bin` images are parsed/verified/placed in simulated OTA slots but
  their Xtensa code is never executed — this is a functional simulator, so
  Aegis PHOENIX still needs real hardware (or a true ESP32 emulator such as
  QEMU) for runtime validation.
- The local update feed advertises v1.1.0; it was not applied.
