# Flashing, OTA and installing your own programs

The point of this page is the thing a physical Cardputer makes painful: **you should
not have to swap hardware, hold G0 and re-flash a board to try a program.** In the
emulator every one of those steps exists, is observable, and takes a click.

There are two different "flash" paths, and it matters which one you are on:

| Path | What it does | Runs? |
| --- | --- | --- |
| **Firmware program** (`.js`, or the editor in the Flash tab) | a real program written against the M5Cardputer-style API | **yes** — it is executed by the firmware runtime |
| **Firmware image** (`.bin`) | a real ESP32-S3 app image is parsed, checksummed and laid into an OTA slot with erase/write/verify | **no** — Xtensa instructions are not interpreted (see `docs/ACCURACY.md`) |

---

## 1. Download mode (the ROM loader)

Real hardware: power off, hold **G0**, plug in USB-C. The chip comes up in its serial
bootloader instead of running the application, and `esptool.py` takes over.

In the emulator: **Flash → enter download mode (hold G0)**, or the `G0` button on the
side rail. You get the stub handshake and the chip identity the real tool prints:

```
esptool.py v4.8.1
Found 1 serial port: /dev/ttyACM0 (303A:1001)
Connecting (holding G0 during reset)....
Chip is ESP32-S3 (QFN56) (revision v0.2)
Features: WiFi, BLE, Embedded PSRAM 8MB (AP_3v3)
Crystal is 40MHz
MAC: 30:ed:a0:…
Uploading stub / Running stub / Stub running...
Changing baud rate to 460800
```

`hard reset` releases it (RTS) and the emulated board reboots into the firmware.

The same state is reachable from code and from the CLI-style debug hook:

```js
__emu.device.enterDownloadMode();      // ROM loader, LCD dark
__emu.flash.exitDownloadMode();        // hard reset back into the app
```

## 2. Partition table

Both SKUs ship 8 MB of flash with two OTA slots, so an update can be written to the
slot that is *not* running:

```
nvs        data/nvs        0x9000    24.0 KB
otadata    data/ota        0xf000     8.0 KB
phy_init   data/phy       0x11000     4.0 KB
ota_0      app/ota_0      0x20000     3.2 MB   ← running
ota_1      app/ota_1     0x352000     3.2 MB
spiffs     data/spiffs   0x684000     1.4 MB
coredump   data/coredump 0x7e4000   112.0 KB
```

`partitionTable()` builds it, `flash.switchSlot()` moves the boot selection (what
`otadata` does on a real board), and the fuzzer asserts the rows are sector-aligned,
non-overlapping and inside the flash.

## 3. Flashing an image

Drop a `.bin` on the Flash tab (or `flash.flash({name, bytes})`). The image is
validated the way the ROM loader validates it:

* magic `0xE9`
* the image checksum — XOR of every segment payload byte, seeded `0xEF` and stored after zero padding so the length including it is a multiple of 16 — must verify, and an appended SHA-256 (exactly 32 trailing bytes, when present) must verify too. The image header itself is *not* checksummed (byte 8 is the SPI WP pin, `0xEE` on shipped firmware)
* every segment must fit inside the file
* chip id, flash mode/frequency, entry point and — when the app descriptor is
  present — the project name, version, build date and IDF version are read out

Then it erases in 4 KiB sectors, writes, reports progress and verifies:

```
Writing at 0x352000... (100 %)
Wrote 1132464 bytes (702128 compressed) at 0x352000 in 0.14 seconds
Hash of data verified (a3f19c02).
```

A rejected image tells you *why* (`bad magic 0x00 (expected 0xE9)`, `segment 2 runs
past end of file`, `image is 4.2 MB, ota_1 only holds 3.2 MB`) instead of failing
silently. `tests/fuzz_core.mjs` phase `flash` throws 60 hostile byte blobs at the
parser and asserts that the slot bookkeeping never drifts.

## 4. Installing your own program

A program is an ordinary ES module:

```js
export const APP = {
  id: 'my-app',                 // 2–32 chars, [a-z0-9._-]
  name: 'My App', icon: 'MY', version: '1.0.0',
  setup(api) { this.n = 0; },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS;
    L.fillScreen(K.BLACK);
    L.drawString(4, 4, 't=' + (this.n += dt).toFixed(1) + 's', K.GREEN, 1);
    const env = api.modules.find('env3');           // hot-plugged Grove unit
    if (env) L.drawString(4, 20, env.state.temp.toFixed(1) + ' C', K.WHITE, 1);
    if (api.input().esc) api.exit();
  },
};
```

Install it three ways:

1. **Flash tab → editor** — paste, `install & run`.
2. **Drop a `.js` file** on the Flash tab.
3. **From firmware code**, exactly like an app that updates itself:
   ```js
   await api.flash.install('export const APP = { id: "next", loop() {} };');
   ```

Validation happens before anything is registered: syntax, the export shape, the id
pattern, that `setup`/`loop` exists, and that the id does not shadow a built-in app.
Rejections are strings you can show a user (`APP.id must be 2–32 chars of [a-z0-9._-]`).

Installed programs are stored (NVS in the native launcher, `localStorage` in the
single-file build) and re-registered on reload. `export` writes the `.js` back out.

The program sees the same API the 17 built-in apps use:

| namespace | surface |
| --- | --- |
| `api.lcd` | Adafruit-GFX style drawing, 240×135 RGB565, rotation, clip, text size |
| `api.input()` | edge-triggered key state (letters, arrows, fn layer, modifiers, `esc`) |
| `api.modules` | `list()`, `find(id)`, `state(id)`, `require(id)` — live hot-plug |
| `api.gpio / uart / i2c` | pin level, UART frames, register reads on the emulated buses |
| `api.sd` | mount state, `read/list/write` on the persistent microSD image |
| `api.ir` | NEC transmit, `captures()`, `learn()`, `replay()`, datasheet range model |
| `api.power` | percent, volts, current, charging, RGB LED |
| `api.flash` | partition info, OTA slot, `nvs.get/set/list`, `install(source)` |
| `api.thermal` | die temperature, ambient, throttle flag, effective CPU MHz |
| `api.wdt` | `feed()`, `setTimeout()`, trip counter |
| `api.wifi` | AP scan, connect/DHCP, BLE scan |
| `api.apps` | `list()`, `launch(id)`, `current()` |

## 5. NVS

A small key/value store with namespaces, typed values and a size ceiling, so a program
can persist settings the way `Preferences` does on hardware:

```js
api.flash.nvs.set('wifi_ssid', 'm5stack-lab');
api.flash.nvs.get('boot_count', 0);
api.flash.nvs.list();          // [{ns, key, type, value}, …]
```

The **Bench** tab shows the NVS contents, the boot slot and the watchdog counters.

## 6. OTA updates (the emulator itself)

Unrelated to the emulated board, but worth knowing: the launcher checks a signed feed,
verifies SHA-256, stages the package, snapshots the previous build and rolls back with
`python run.py --rollback`. See `docs/UPDATES.md`.
