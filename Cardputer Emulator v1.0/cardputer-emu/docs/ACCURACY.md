# Accuracy — how close is this to a real Cardputer, and how does it compare?

Round-2 deliverable: an honest comparison against other real Cardputer builds and
emulators, plus a list of what is missing or wrong here.

**One line:** this is a *functional* simulator of the Cardputer as a device — the
esp32-s3 pinmap, the panel, both keyboard controllers, the audio path, power, thermal
and the whole Grove/CAP bus tree — not an ESP32-S3 instruction emulator. If you want
to run an unmodified `.bin`, use Espressif's QEMU (boot only) or Wokwi; if you want to
write and test an *application* in minutes with live hot-plug of M5 hardware, this is
the thing. Both answers are legitimate; they answer different questions.

---

## 1. What is emulated, and with what fidelity

Fidelity classes used below: **MEASURED** (taken from a datasheet or a measurement we
trust), **MODELLED** (behaviour derived from measured quantities, not identical),
**STUBBED** (a plausible stand-in that keeps the API honest).

| Subsystem | Real hardware | Here | Fidelity |
| --- | --- | --- | --- |
| SoC | ESP32-S3FN8, 2× Xtensa LX7 @240 MHz, 8 MB flash | variant record only; no instruction execution | STUBBED |
| Panel | ST7789V2 1.14", 240×135, SPI up to 80 MHz | real 240×135 RGB565 framebuffer + GFX drawing API, rotation, clip, dirty-flag scanout | MODELLED |
| Keyboard | 4×14 = 56 keys; 74HC138 GPIO scan (v1.0/v1.1) or TCA8418 I²C keypad controller with 10-entry FIFO + INT on GPIO11 (Adv) | full matrix, Fn layer, modifier state, auto-repeat, FIFO overflow, INT line | MODELLED |
| Audio out | NS4168 I²S amp (v1.0/1.1); ES8311 codec + NS4150B (Adv); 1 W 8 Ω; jack detect | sample-rate/tone synthesis, volume, amp enable, jack disables the speaker | MODELLED |
| Microphone | SPM1423 PDM (v1.0/1.1); MEMS on ES8311 ADC (Adv) | level/RMS model; optional routing of the host microphone | MODELLED |
| IMU | BMI270 on the Adv only | present/absent per SKU, tilt + noise, register read | MODELLED |
| IR | 38 kHz emitter/receiver, GPIO44; 410 cm @0°, 170 cm @45°, 66 cm @90° | NEC encode/decode, raw pulse capture/replay, the datasheet range table | MEASURED (ranges) / MODELLED (framing) |
| RTC | none on the original board (set from Wi-Fi/NTP); BM8563 on some builds | host clock offset | STUBBED |
| microSD | SPI: CS 12 / MOSI 14 / CLK 40 / MISO 39, FAT32 | persistent FAT-style tree, capacity/usage, mount/eject, SPI CS conflict rules | MODELLED |
| Wi-Fi / BLE | 2.4 GHz Wi-Fi + BLE 5 on the S3 | scan list with RSSI/auth, connect + DHCP + HTTP proxy, BLE scan | STUBBED |
| Battery | v1.0/1.1: 120 mAh + 1400 mAh base = 1520; Adv: 1500 mAh; 0.26 µA sleep; ~165 mA working, ~256 mA with the IR LED | 1S discharge curve with load sag, CC/CV charging at ~290 mA, per-module current draw, sleep current, brownout detector | MEASURED (capacity/current) / MODELLED (curve) |
| Power path | TP4057 charger, USB-C | USB presence, charge taper, brownout at 3.30 V under load | MODELLED |
| Thermal | SoC warms under sustained load; IDF pulls the clock back | first-order lumped model, ambient slider, throttle flag above 78 °C that caps the CPU at 160 MHz | MODELLED |
| Watchdog | task WDT, panic + reboot | loop() budget measured per frame; three blown frames → guru-meditation panic | MODELLED |
| Grove port | HY2.0-4P, G2/G1, 5 V rail; Adv adds a 5 V/3.3 V toggle | full I²C/UART/GPIO bus, address + pin conflict detection, 5 V gating | MEASURED (pinmap) |
| EXT header | 2.54-14P on the Adv (SPI/I²C/UART + 3 GPIO) | separate SPI CS 5, UART G13/G15, shared internal I²C | MEASURED (pinmap) |
| Modules | M5Stack Grove Units + Cardputer CAPs | 50 drivers with real chip addresses, UART protocols (NMEA, Modbus RTU, AT, PMS), SPI, GPIO | MEASURED (addresses/SKUs) / MODELLED (values) |
| Dimensions / mass | 84 × 54 × 19.7 mm, 92.3 g (v1.0); ~81 g (Adv) | used directly by the art pipeline | MEASURED |

### Numbers we deliberately match
240 × 135 panel, 4 × 14 keys, 84 × 54 × 19.7 mm, 92.3 g / ~81 g, 1520 mAh vs 1500 mAh,
0.26 µA sleep, 165.7 mA typing / 255.6 mA IR, IR ranges 410/170/66 cm, NS4168 vs
ES8311+NS4150B, SPM1423 vs MEMS, BMI270 on the Adv only, TCA8418 at `0x34`, SHT30
`0x44` + QMP6988 `0x70`, SD pins 12/14/40/39, LCD pins 38/33/34/35/36/37.

## 2. Comparison with other Cardputer work

| Project | Approach | What it gets right | What it cannot do |
| --- | --- | --- | --- |
| **[JayPloss/cardputer-emulator](https://github.com/JayPloss/cardputer-emulator)** | the closest peer: compiles the *firmware source* natively against shims, device-sized heap, watchdog/stack/power checks; every constant tagged MEASURED/ESTIMATE/CALIBRATED. Also runs the real binary in **Espressif ESP32-S3 QEMU** with the real ROM, bootloader, newlib and FATFS | real firmware logic and real ROM boot semantics; honest provenance of constants | QEMU path is boot-only: no Wi-Fi, no display, no keyboard, SD only via `SD_MMC`, no I²S. Author lists radio, SD timing, audio, display speed, task scheduling, stack high-water and prebuilt libraries as the open gaps |
| **Wokwi** | discrete-chip simulation on a stock ESP32-S3 dev board | real firmware, real toolchain, good peripheral models it has | **no Cardputer board**: no 4×14 keyboard matrix, no TCA8418 wiring, no ES8311/NS4168 or SPM1423, no CAP/EXT header. You must build custom chips, and large SD images need a paid plan |
| **Espressif ESP32-S3 QEMU** | full instruction-level emulation | boots unmodified images, real FreeRTOS timing | no Cardputer peripherals at all; SD/display/audio/keyboard are board-specific work you have to add |
| **[Clearwavelet/CardPuter86](https://github.com/Clearwavelet/CardPuter86)** | 8086 PC emulator running *on* a Cardputer, with CPU-speed profiles and a light-sleep that wakes every 100 ms to scan the matrix | excellent detail about the *keyboard scan loop* and battery cost of light sleep | it is a program for the real device, not a model of the device |
| **[geo-tp/Cardputer-Game-Station-Emulators](https://github.com/geo-tp/Cardputer-Game-Station-Emulators)** | console emulators on-device: <256 KB RAM budget, ROM in flash, JoyV2 autodetect | real memory budget and peripheral sharing on hardware | same: on-device software |
| **maxallion/Cardputer-Launcher**, **Bruce**, **Dwight** firmware | OTA launcher / pentest firmware | real OTA flows, real radio work | on-device software |
| **M5Stack** | — | official docs / pinmap (used as the source of truth here) | **no official Cardputer simulator exists** |

### Where this emulator is *better* than the peers
* The full peripheral tree is present at once: panel + both keyboard controllers + both
  audio paths + IMU + IR + SD + Grove + EXT, hot-pluggable *while firmware runs*.
* 50 module drivers with real addresses/UART protocols, address/pin/rail conflict
  detection, and per-SKU gating (an EXT CAP refuses to attach on a v1.0).
* Both SKUs (plus v1.1) swap under the running firmware, with the physical
  consequences surfaced (modules unplugged, IMU/jack/EXT disappearing, 5 V rail gone).
* Power and thermal are coupled to the workload; the battery estimate uses real
  currents rather than a linear drain, and brownout is reachable.
* The GUI is the product: you can see the panel, press the matrix, inject sensor
  values, drag a firmware image in and watch the erase/write/verify.

### Where the peers are better than this emulator
* **They run the real thing.** QEMU boots the actual `.bin`; JayPloss compiles the
  actual firmware source. Here a `.bin` is parsed, checksummed and flashed but never
  executed, so you cannot validate Xtensa codegen, a linker map, PSRAM behaviour,
  flash-encryption, secure boot or a partition-table mismatch against real ROM code.
* **Real FreeRTOS scheduling and interrupt latency.** There is no task scheduler,
  no priority inversion, no ISR-to-task handoff, no `uxTaskGetStackHighWaterMark`.
  A latency bug in your firmware will not show up here.
* **Radio.** No 802.11 or BLE stack, no association/beacon timing, no BLE GATT. The
  Wi-Fi surface is a stub with believable values.
* **Bit-exact panel and audio.** No SPI bus timing, no DMA underrun, no I²S word
  clocks, no ES8311 register-level codec behaviour, no amplifier distortion. Audio is
  synthesised, not sampled.
* **Analog reality.** ADC noise/linearity, brownout timing (µs), the TP4057's actual
  charge curve, cell ageing: all modelled, none measured.

## 3. Known gaps, by severity

**Won't bite you for app work**
* Text is drawn with the GLCD 8-bit font; a handful of typographic glyphs are
  transliterated (`°`, `µ`, `→`, `±`). Apps that use a custom font see the fallback.
* `api.http` needs the native launcher (browser mode has no proxy).
* SD timing/throughput is not modelled; large file copies are instant.

**Could mislead a firmware author**
* No instruction execution (above) — this is the big one. Anything you learn about
  codegen, cache, PSRAM or flash cache misses here is only an opinion.
* Interrupt latency and FreeRTOS scheduling are absent, so "it works in the emulator"
  says nothing about real-time deadlines.
* The 240 MHz / 160 MHz throttle is a flag on a model, not a clock domain.
* Keyboard rollover is matrix-accurate but the *scan loop* is not: real firmware
  polling at 50 Hz can miss a 5 ms tap, which cannot happen here.

**Missing hardware entirely**
* Wi-Fi/BLE radio behaviour, USB MSC/JTAG details, deep-sleep RTC domains and
  wake-on-touch, flash encryption / secure boot, OTA rollback counters beyond `otadata`.
* The rear battery base's separate charging path and its physical switch (only the
  combined capacity is modelled).

## 4. How this document stays honest

Every claim above that could rot is covered by a test:

```bash
python3 tools/check.py            # 11 rows: lint, types, tests, fuzz, build, browser
node tests/test_core.mjs          # 36 behavioural assertions
node tests/fuzz_core.mjs --seed 11  # keyboard/hotplug/SKU-swap/flash/framebuffer + 10k frames
python3 tools/browser_check.py    # boots the real UI, swaps SKUs, installs a program
```

The `skus`, `flash` and `hotplug` fuzz phases exist specifically to catch the ways a
hardware model goes wrong: a module surviving on a board that cannot host it, a
duplicate I²C address, or an image parser that accepts a truncated file.

## 5. Sources used for the hardware facts

* M5Stack Cardputer-Adv documentation (pinmap, ES8311 + NS4150B, BMI270, 1500 mAh,
  3.5 mm jack, Grove 5 V toggle, dimensions/mass) — <https://docs.m5stack.com/en/core/Cardputer-Adv>
* M5Stack Cardputer documentation (NS4168, SPM1423, IR range table, 120 + 1400 mAh,
  92.3 g, sleep/working currents, TCA8418-free keyboard scan) — <https://docs.m5stack.com/en/core/Cardputer>
* Cardputer v1.1 manual (StampS3A, port layout) — manuals.plus listing B0F211W7HL
* Peer projects linked in §2, inspected for architecture and for the gaps they report.
