# Cardputer EMU changelog

## v1.1.0 — "grove"
- Module catalog grows from the feed (no core rebuild needed):
  Unit CO2 (SCD40 @0x62), Unit Accel (LIS3DH @0x19), Unit Kmeter (0x50).
- New firmware app: **Weather** — reads a Grove ENV unit when present, otherwise
  shows the cached five-day outlook.
- Soft payload: catalog + app are applied live; the core bundle swaps on restart.
- Updater: SHA-256 verification is now mandatory, rollback snapshots are kept
  in `data/snapshots/`.

## v1.0.0 — first release
- ST7789V2 240×135 panel, 56-key matrix (74HC138 + TCA8418), ES8311 / NS4168 audio,
  BMI270 IMU, IR blaster, microSD, Wi-Fi/BLE, battery + charger model.
- Cardputer v1.0 / v1.1 / Cardputer-Adv variants with real pinmaps.
- Hot-pluggable Grove units and EXT CAP modules with address/pin conflict checks.
- 15 built-in firmware apps, serial console, auto-update engine.
