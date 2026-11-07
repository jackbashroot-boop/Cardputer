# Modules — the hot-plug rack

Every module in the emulator is a small device simulator registered on an emulated bus.
The UI rack, the conflict checker and the firmware all read from the same catalog, so
what you see is what the emulated SoC sees.

## Ports

| Eco id | Physical port | Buses |
| --- | --- | --- |
| `grove` | HY2.0-4P Grove (G2/G1, 5 V) | I²C `0x08..0x77`, UART (G2 TX / G1 RX), GPIO on G2 |
| `ext` | EXT 2.54-14P (Cardputer-Adv only) | SPI (SCK 40 / MOSI 14 / MISO 39 / CS 5), I²C shared with the internal bus, UART G13/G15 |
| `sd` | microSD slot | SPI (CS 12) |
| `onboard` | soldered: BMI270, ES8311, TCA8418 | internal I²C G8/G9 |

Slot limits, address claims and pin claims are enforced by
`Cardputer.checkAttach(def)`; the rack shows the exact reason a module cannot attach.

## Catalog entries

```js
{
  id: 'env3',                 // unique, used by api.modules.find('env3')
  name: 'ENV III',
  sku: 'U001-C',
  eco: 'grove',               // grove | ext
  transport: 'i2c',           // i2c | uart | spi | gpio
  color: '#4ade80',           // rack accent
  addrs: [                    // I²C claims (address + chip label)
    { addr: 0x44, chip: 'SHT30' },
    { addr: 0x70, chip: 'QMP6988' },
  ],
  pins: [2],                  // GPIO claims for transport: 'gpio'
  baud: 9600,                 // for transport: 'uart'
  requires: 'adv',            // refuse to attach on v1.0 / v1.1
  summary: 'Temp / humidity / barometric pressure',
  tags: ['sensor', 'weather'],// rack filter chips
  controls: [                 // injectors rendered on the module's card
    { id: 'temp', label: 'Ambient temp', min: -10, max: 45, step: 0.5, unit: '°C' },
    { id: 'trigger', label: 'Wave a hand', type: 'button' },
  ],
  create(ctx) { /* returns the driver instance — see below */ },
}
```

## Driver contract

`create(ctx)` returns an object with any of these members:

| Member | Purpose |
| --- | --- |
| `state` | plain object shown live in the rack and readable by apps (`api.modules.state(id)`) |
| `tick(dt)` | advance the physics, called every frame |
| `read(addr, reg, n)` | bytes for an I²C master read (return an array) |
| `write(addr, reg, data)` | handle an I²C master write |
| `gpioRead()` / `gpio(level)` | GPIO input value / receive an output level |
| `analogRead()` | analog value for `api.gpio.analogRead(pin)` |
| `uartIn(bytes)` | bytes sent by the SoC UART |
| `spiXfer(bytes)` | full-duplex SPI transfer when this device's CS is selected |
| `setControl(id, value)` | apply an injector from the UI |
| `controls` | extra injectors appended to the catalog ones |
| `dispose()` | called on unplug |

`ctx` gives you the rest of the machine:

```js
ctx.heat()        // self-heating offset from CPU load + backlight (≈0.6…6 °C)
ctx.now()         // milliseconds since boot
ctx.emit(evt, p)  // UI toast + sound hook, e.g. ctx.emit('relay', { on: true })
ctx.log(msg, lvl) // write to the serial console
ctx.uartOpen()    // is a UART listener attached?
ctx.uartSend(str)// bytes from the module back to the SoC
ctx.i2c.internal / .grove / .ext
ctx.device        // the Cardputer instance
```

## Worked example — a 20-line unit

```js
{
  id: 'my-sensor', name: 'My Unit', sku: 'U999', eco: 'grove', transport: 'i2c',
  color: '#f0f', addrs: [{ addr: 0x5c, chip: 'XYZ123' }],
  summary: 'Reads the thing', tags: ['sensor'],
  controls: [{ id: 'value', label: 'Value', min: 0, max: 100, step: 1 }],
  create(ctx) {
    const st = { value: 42 };
    return {
      state: st,
      read: (addr, reg, n) => [st.value & 0xff, (st.value >> 8) & 0xff].slice(0, n || 2),
      setControl: (id, v) => { if (id === 'value') st.value = Number(v); },
    };
  },
}
```

Drop it into `MODULE_CATALOG` in `src/js/modules/modules.js` and rebuild
(`python build.py`) — or ship it from the feed without touching the build (below).

## Shipping a module from the update feed

Feed modules carry their driver as **source text** instead of a function, so they need no
bundling. `updates/catalog.json`:

```json
{
  "version": "2026.11.1",
  "modules": [{
    "id": "co2", "name": "Unit CO2", "sku": "U089", "eco": "grove", "transport": "i2c",
    "addrs": [{ "addr": 98, "chip": "SCD40" }],
    "summary": "Photoacoustic CO2 sensor",
    "controls": [{ "id": "ppm", "label": "CO2 level", "min": 400, "max": 5000, "step": 10 }],
    "source": "(ctx) => { const st = { ppm: 640 }; return { state: st, setControl(id, v) { st.ppm = v; } }; }"
  }]
}
```

The emulator merges this into its catalog on startup/refresh (`mergeCatalog`) and
`device.attachModule('co2')` works exactly like a built-in module. The three feed
modules shipped here (CO₂, Accel, Kmeter) arrive with the v1.1.0 update.

## Firmware side

```js
api.modules.list()             // attached modules
api.modules.has('env3')        // boolean
api.modules.state('env3')      // live sim state
api.modules.find('env3')       // driver instance
api.modules.require('env3')    // driver, throws a helpful error if absent
api.M5.Ex_I2C.scan()           // grove bus
api.M5.Ex_I2C.readRegister(0x44, 0x00, 6)
api.gpio.digitalRead(2)        // GPIO modules
```

A raw-register example: the ENV III really answers SHT30 frames. Write `[0x2C, 0x06]`,
read 6 bytes, and bytes 2 and 5 are CRC-8 (poly `0x31`) over the temperature and humidity
word — the test suite asserts it (`tests/test_core.mjs`, "ENV III registers decode with
valid SHT30 CRC").

## The full catalogue (50 modules)

Generated from `src/js/modules/modules.js` — every row is a working driver, not a
placeholder. `python3 tools/check.py` asserts that each one attaches on a fresh
Cardputer-Adv, publishes live state, and that every *refusal* is a physical one
(slot full, address taken, no EXT header, 3.3 V rail on a 5 V unit, …).

| id | unit | SKU | port / transport | addresses & chips | needs | draw |
| --- | --- | --- | --- | --- | --- | --- |
| `cap-brk` | CAP Breakout | U191-BRK | ext/gpio | GPIO | ADV/EXT | 1 mA |
| `cap-cc1101` | CAP CC1101 | U191-C | ext/spi | SPI | ADV/EXT | 6 mA |
| `cap-gps` | CAP GPS | U191-G | ext/uart | UART | ADV/EXT | 28 mA |
| `cap-lora1262` | CAP LoRa-1262 | U191-B | ext/spi | SPI | ADV/EXT | 6 mA |
| `cap-rs485` | CAP RS485 | U191-R | ext/uart | UART | ADV/EXT | 14 mA |
| `adc` | Unit ADC | U013 | grove/i2c | `0x48` ADS1100 | — | 6 mA |
| `button` | Unit Button | U025-B | grove/gpio | GPIO | — | 6 mA |
| `buzzer` | Unit Buzzer | U004-B | grove/gpio | GPIO | — | 6 mA |
| `can` | CAN Unit | U126-CAN | grove/can | CAN | — | 12 mA |
| `catm` | Unit Cat-M | U114 | grove/uart | UART | — | 55 mA |
| `co2` | Unit CO2 | U103 | grove/i2c | `0x62` SCD40 | — | 22 mA |
| `color` | Unit Color | U009 | grove/i2c | `0x29` TCS34725 | — | 6 mA |
| `dac` | Unit DAC | U028 | grove/i2c | `0x60` MCP4725 | — | 6 mA |
| `dlight` | DLight Unit | U136 | grove/i2c | `0x23` BH1750FVI | — | 2 mA |
| `earth` | Unit Earth | U018 | grove/gpio | GPIO | — | 6 mA |
| `encoder` | Unit Encoder | U135 | grove/i2c | `0x40` STM32F030 | — | 5 mA |
| `env3` | ENV III | U001-C | grove/i2c | `0x44` SHT30, `0x70` QMP6988 | — | 6 mA |
| `env4` | ENV IV | U001-D | grove/i2c | `0x44` SHT40, `0x76` BMP280 | — | 6 mA |
| `envpro` | ENV Pro | U001-B | grove/i2c | `0x77` BME688 | — | 6 mA |
| `extio` | Unit ExtIO | U011 | grove/i2c | `0x20` MCP23017 | — | 6 mA |
| `fingerprint` | Unit Fingerprint | U041 | grove/uart | UART | — | 6 mA |
| `gesture` | Unit Gesture | U032-G | grove/i2c | `0x73` PAJ7620U2 | — | 6 mA |
| `gps` | Unit GPS | U032 | grove/uart | UART | — | 6 mA |
| `gsm` | GSM Unit | U043 | grove/uart | UART | — | 70 mA |
| `hcho` | Unit HCHO | U092 | grove/i2c | `0x5D` SFA30 | — | 6 mA |
| `heart` | Unit Heart | U029 | grove/i2c | `0x57` MAX30100 | — | 6 mA |
| `imu` | Unit IMU | U095 | grove/i2c | `0x68` MPU6886 | — | 4 mA |
| `joyc` | Unit JoyC | U073 | grove/i2c | `0x38` STM32 | — | 6 mA |
| `light` | Unit Light | U021 | grove/i2c | `0x23` BH1750FVI | — | 6 mA |
| `lora` | Unit LoRaWAN | U111 | grove/uart | UART | — | 6 mA |
| `mmwave` | mmWave Human Presence | U157 | grove/uart | UART | — | 25 mA |
| `mosfet` | MOSFET Unit | U102 | grove/gpio | GPIO | — | 3 mA |
| `nbiot` | Unit NB-IoT | U113 | grove/uart | UART | — | 45 mA |
| `ncir` | Unit NCIR | U016-B | grove/i2c | `0x5A` MLX90614 | — | 6 mA |
| `oled` | OLED Unit | U001-OLED | grove/i2c | `0x3C` SSD1306 | — | 8 mA |
| `opto` | Opto-coupler Unit | U120 | grove/gpio | GPIO | — | 6 mA |
| `pir` | Unit PIR | U054 | grove/gpio | GPIO | — | 6 mA |
| `pm25` | Unit PM2.5 | U109 | grove/uart | UART | — | 30 mA |
| `relay` | Unit Relay | U004 | grove/i2c | `0x26` STM32F030 | — | 6 mA |
| `rfid` | Unit RFID | U031 | grove/i2c | `0x28` MFRC522 | — | 6 mA |
| `rgb` | Unit RGB | U001-RGB | grove/gpio | GPIO | — | 6 mA |
| `rs485` | RS485 Unit | U094 | grove/uart | UART | — | 10 mA |
| `rtc` | RTC Unit | U126 | grove/i2c | `0x51` BM8563 | — | 1 mA |
| `servo` | Unit 8Servo | U025 | grove/i2c | `0x40` PCA9685 | — | 6 mA |
| `sonic` | Unit Sonic | U033 | grove/i2c | `0x57` RCWL-9600 | — | 6 mA |
| `thermal` | Unit Thermal | U016 | grove/i2c | `0x33` MLX90640 | — | 6 mA |
| `tof` | Unit ToF | U034 | grove/i2c | `0x29` VL53L0X | — | 6 mA |
| `tof4m` | ToF4M Unit | U101 | grove/i2c | `0x29` VL53L1X | — | 18 mA |
| `tvoc` | Unit TVOC | U088 | grove/i2c | `0x58` SGP30 | — | 12 mA |
| `zigbee` | Unit ZigBee | U112 | grove/uart | UART | — | 30 mA |

### SKU compatibility

| | Cardputer v1.0 / v1.1 | Cardputer-Adv |
| --- | --- | --- |
| Grove HY2.0-4P (I²C / UART / GPIO) | yes | yes |
| EXT 2.54-14P header (CAPs) | **no** | yes |
| Grove 5 V rail toggle | no (fixed 3.3 V) | yes — 5 V-only units refuse to power up at 3.3 V |
| Units requiring the on-board BMI270 or the 3.5 mm jack | no | yes |

Swapping the SKU in the UI (`System → Hardware SKU`) re-runs `Cardputer.setVariant()`:
the pinmap, keyboard controller, audio path, IMU and EXT header are rebuilt, modules
the new board cannot physically host are unplugged with a reason, everything else
stays attached on its bus. The fuzzer (`tests/fuzz_core.mjs`, phase `skus`) checks the
invariants after every swap: no duplicate I²C address, no EXT module on a SKU without
the header, no Grove slot over-subscription.
