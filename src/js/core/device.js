// =============================================================================
//  Cardputer device model: variants, pinmap, virtual buses, hot-plug, power.
// =============================================================================
import { Display, Keyboard, COLORS } from './hardware.js';
import { Speaker, Microphone, Imu, Infrared, Radio, Power, SdCard, Rtc } from './peripherals.js';
import { Emitter, clamp, hex, makeRng, fmtBytes } from './util.js';
import { MODULE_CATALOG, MODULE_BY_ID, ECOSYSTEMS } from '../modules/modules.js';

// Pinmaps straight from docs.m5stack.com (Cardputer-Adv "PinMap" section).
const LCD_PINS = [
  { gpio: 38, signal: 'LCD_BL / RGB_PWR_EN' }, { gpio: 33, signal: 'LCD_RST' }, { gpio: 34, signal: 'LCD_RS(DC)' },
  { gpio: 35, signal: 'LCD_MOSI' }, { gpio: 36, signal: 'LCD_SCK' }, { gpio: 37, signal: 'LCD_CS' },
];
const SD_PINS = [{ gpio: 12, signal: 'SD_CS' }, { gpio: 14, signal: 'SD_MOSI' }, { gpio: 40, signal: 'SD_CLK' }, { gpio: 39, signal: 'SD_MISO' }];
const ADV_EXT_PINS = [
  { gpio: 3, signal: 'EXT RESET' }, { gpio: 4, signal: 'EXT INT' }, { gpio: 6, signal: 'EXT BUSY' },
  { gpio: 40, signal: 'EXT SCK' }, { gpio: 14, signal: 'EXT MOSI' }, { gpio: 39, signal: 'EXT MISO' },
  { gpio: 5, signal: 'EXT CS' }, { gpio: 8, signal: 'EXT I2C_SDA' }, { gpio: 9, signal: 'EXT I2C_SCL' },
  { gpio: 13, signal: 'EXT UART_TX' }, { gpio: 15, signal: 'EXT UART_RX' },
];

export const VARIANTS = {
  cardputer: {
    id: 'cardputer', name: 'Cardputer', label: 'Cardputer v1.0', sku: 'K132', year: 2024, color: '#d8dde3',
    soc: 'ESP32-S3FN8', cores: 2, mhz: 240, flashBytes: 8 * 1024 ** 2, psramBytes: 0,
    keyboard: 'gpio', kbChip: '74HC138 scan matrix', audio: 'NS4168 amp + SPM1423 mic',
    imu: false, jack: false, ext: false, tca8418: false, rgbLed: 'direct',
    groveToggle: false, groveVolts: 3.3,
    battery: { main: 120, base: 1400, total: 1520 }, lanyard: false, antenna: 'standard',
    pins: [...LCD_PINS, ...SD_PINS,
      { gpio: 8, signal: 'KB A0' }, { gpio: 9, signal: 'KB A1' }, { gpio: 11, signal: 'KB A2' },
      { gpio: 13, signal: 'KB IN0' }, { gpio: 15, signal: 'KB IN1' }, { gpio: 3, signal: 'KB IN2' },
      { gpio: 4, signal: 'KB IN3' }, { gpio: 5, signal: 'KB IN4' }, { gpio: 6, signal: 'KB IN5' }, { gpio: 7, signal: 'KB IN6' },
      { gpio: 41, signal: 'I2S BCLK' }, { gpio: 42, signal: 'I2S DOUT' }, { gpio: 43, signal: 'I2S LRCK' },
      { gpio: 46, signal: 'I2S MIC DIN' }, { gpio: 44, signal: 'IR TX' }, { gpio: 10, signal: 'BAT ADC' },
      { gpio: 2, signal: 'GROVE (yellow)' }, { gpio: 1, signal: 'GROVE (white)' }],
  },
  v11: {
    id: 'v11', name: 'Cardputer v1.1', label: 'Cardputer v1.1', sku: 'K132-V11', year: 2025, color: '#dfe4ea',
    soc: 'ESP32-S3FN8', cores: 2, mhz: 240, flashBytes: 8 * 1024 ** 2, psramBytes: 0,
    keyboard: 'gpio', kbChip: '74HC138 scan matrix', audio: 'NS4168 amp + SPM1423 mic',
    imu: false, jack: false, ext: false, tca8418: false, rgbLed: 'shared',
    groveToggle: false, groveVolts: 3.3,
    battery: { main: 120, base: 1400, total: 1520 }, lanyard: false, antenna: 'optimised',
    pins: [],
  },
  adv: {
    id: 'adv', name: 'Cardputer-Adv', label: 'Cardputer-Adv', sku: 'K132-Adv', year: 2026, color: '#f2f4f7',
    soc: 'ESP32-S3FN8 (Stamp-S3A)', cores: 2, mhz: 240, flashBytes: 8 * 1024 ** 2, psramBytes: 0,
    keyboard: 'tca8418', kbChip: 'TCA8418RTWR @0x34', audio: 'ES8311 codec + NS4150B amp',
    imu: true, jack: true, ext: true, tca8418: true, rgbLed: 'shared',
    groveToggle: true, groveVolts: 5,
    battery: { main: 1500, base: 0, total: 1500 }, lanyard: true, antenna: 'optimised',
    pins: [...LCD_PINS, ...SD_PINS, ...ADV_EXT_PINS,
      { gpio: 8, signal: 'I2C SDA (codec/IMU/kb)' }, { gpio: 9, signal: 'I2C SCL (codec/IMU/kb)' },
      { gpio: 11, signal: 'KB INT' }, { gpio: 41, signal: 'I2S SCLK' }, { gpio: 42, signal: 'I2S DSDIN' },
      { gpio: 43, signal: 'I2S LRCK' }, { gpio: 46, signal: 'I2S ASDOUT (mic)' },
      { gpio: 44, signal: 'IR TX' }, { gpio: 10, signal: 'BAT ADC' },
      { gpio: 2, signal: 'GROVE (yellow)' }, { gpio: 1, signal: 'GROVE (white)' }],
  },
};
VARIANTS.v11.pins = VARIANTS.cardputer.pins;

// ---------------------------------------------------------------------------
//  Buses
// ---------------------------------------------------------------------------
class I2CBus {
  constructor(name, sda, scl) {
    this.name = name; this.sda = sda; this.scl = scl;
    this.clients = new Map();       // addr -> {name, read, write}
    this.transactions = 0;
    this.naks = 0;
  }
  attach(addr, name, impl) {
    if (this.clients.has(addr)) throw new Error(`I2C address ${hex(addr)} already in use by ${this.clients.get(addr).name}`);
    this.clients.set(addr, { addr, name, ...impl });
  }
  detach(addr) { this.clients.delete(addr); }
  has(addr) { return this.clients.has(addr); }
  scan() { return [...this.clients.keys()].sort((a, b) => a - b); }
  _get(addr) {
    const c = this.clients.get(addr);
    if (!c) { this.naks++; throw new Error(`I2C NAK: no device at ${hex(addr)} on ${this.name}`); }
    return c;
  }
  // master writes [reg, ...data]
  writeBytes(addr, bytes) {
    const c = this._get(addr); this.transactions++;
    const reg = bytes[0] ?? 0, data = bytes.slice(1);
    if (c.write) c.write(reg, data);
  }
  readBytes(addr, n) {
    const c = this._get(addr); this.transactions++;
    return c.read ? (c.read(0, n) || new Array(n).fill(0)) : new Array(n).fill(0);
  }
  writeReg(addr, reg, val) { return this.writeBytes(addr, [reg, val & 0xff]); }
  readReg(addr, reg, n = 1) {
    const c = this._get(addr); this.transactions++;
    return c.read ? (c.read(reg, n) || new Array(n).fill(0)) : new Array(n).fill(0);
  }
}

class UartBus {
  constructor(tx, rx) {
    this.tx = tx; this.rx = rx; this.client = null; this.baud = 115200;
    this.txBytes = 0; this.rxBytes = 0; this.log = [];
    this.rxBuf = [];          // ring of bytes waiting for the firmware to read()
    this.rxOverflows = 0;
    /** @type {null | ((bytes: number[]) => void)} extra tap used by tests/UIs */
    this.onRx = null;
  }
  attach(name, impl, baud) {
    if (this.client) throw new Error(`UART already in use by ${this.client.name}`);
    this.client = { name, ...impl }; this.baud = baud || this.baud;
  }
  detach() { this.client = null; this.rxBuf.length = 0; }
  // SoC -> module
  send(bytes) {
    const arr = typeof bytes === 'string' ? Array.from(new TextEncoder().encode(bytes)) : Array.from(bytes);
    this.txBytes += arr.length;
    if (this.client?.uartIn) this.client.uartIn(arr);
  }
  // module -> SoC: queued in the RX ring that api.uart.read() drains, mirroring the
  // UART RX FIFO the real ESP32-S3 driver exposes to firmware.
  reply(bytes) {
    const arr = typeof bytes === 'string' ? Array.from(new TextEncoder().encode(bytes)) : Array.from(bytes);
    this.rxBytes += arr.length;
    for (const b of arr) this.rxBuf.push(b & 0xff);
    const max = 1024;
    if (this.rxBuf.length > max) { this.rxOverflows++; this.rxBuf.splice(0, this.rxBuf.length - max); }
    if (this.onRx) this.onRx(arr);
  }
  pending() { return this.rxBuf.length; }
  read(n) {
    const k = n == null ? this.rxBuf.length : Math.max(0, Math.min(n | 0, this.rxBuf.length));
    return this.rxBuf.splice(0, k);
  }
  flush() { this.rxBuf.length = 0; }
  stats() { return { tx: this.txBytes, rx: this.rxBytes, pending: this.rxBuf.length, overflows: this.rxOverflows, baud: this.baud }; }
}

class SpiBus {
  constructor(pins) { this.pins = pins; this.devices = new Map(); }
  attach(cs, name, impl) { this.devices.set(cs, { name, ...impl }); }
  detach(cs) { this.devices.delete(cs); }
  transfer(cs, bytes) {
    const d = this.devices.get(cs);
    if (!d) return bytes.map(() => 0xff);
    return d.spiXfer ? d.spiXfer(bytes) : bytes.map(() => 0x00);
  }
}

// ---------------------------------------------------------------------------
//  Device
// ---------------------------------------------------------------------------
export class Cardputer {
  constructor({ variant = 'adv', catalog = MODULE_CATALOG, store = null } = {}) {
    this.bus = new Emitter();
    this.catalog = catalog;
    this.store = store;
    this.variantId = VARIANTS[variant] ? variant : 'adv';
    this.uptime = 0;
    this.serialBuf = [];
    this.serialSeq = 0;
    this.modules = [];              // {uuid, def, inst}
    this._uuid = 1;
    this.cpuLoad = 0.3;
    this.booted = false;
    this.mode = 'off';              // off | boot | run | download | panic | sleep
    this.rng = makeRng();
    this._initPeripherals();
    this._initBuses();
  }

  get variant() { return VARIANTS[this.variantId]; }

  _initPeripherals() {
    const v = this.variant;
    this.display = new Display(240, 135);
    this.keyboard = new Keyboard({ scanMode: v.keyboard });
    this.speaker = new Speaker();
    this.mic = new Microphone();
    this.imu = new Imu({ present: v.imu });
    this.ir = new Infrared();
    this.radio = new Radio({ hasWifi: true, hasBle: true });
    this.power = new Power({ capacityMah: v.battery.total || 1500 });
    this.sd = new SdCard({ store: this.store ? this.store.sd : null });
    this.rtc = new Rtc();
    this.led = { r: 0, g: 0, b: 0, mode: 'off', power: true };
    this.usbConnected = false;
    this.audioJack = false;
    this.speaker.jackPlugged = false;
    // Grove can be switched between 3.3 V and 5 V on the Adv (the original is fixed
    // at 3.3 V). 5 V-only units refuse to answer when the rail is left at 3.3 V.
    this.grove5v = v.groveToggle ? true : false;
    // die temperature model: passive, ambient 24 C, thermal resistance ~38 K/W
    this.thermal = { dieC: 24, ambientC: 24, throttled: false, peakC: 24 };
    // task watchdog: firmware must feed it from its loop, like the real WDT
    this.wdt = { enabled: true, timeoutMs: 5000, lastFeed: 0, feeds: 0, trips: 0 };
  }

  _initBuses() {
    const v = this.variant;
    this.buses = {
      internal: new I2CBus('internal', 8, 9),
      grove: new I2CBus('grove', 2, 1),
      ext: new I2CBus('ext', 8, 9),            // EXT header exposes the internal I²C pins
      uartGrove: new UartBus(2, 1),
      uartExt: new UartBus(13, 15),
      spi: new SpiBus({ sck: 40, mosi: 14, miso: 39 }),
    };
    // On-board I²C devices of the ADV (codec + IMU + keypad controller)
    if (v.imu) {
      this.buses.internal.attach(0x68, 'BMI270 (on-board IMU)', { read: (reg, n) => { const a = this.imu.getAccel() || { x: 0, y: 0, z: 1 }; return [x16(a.x), x16(a.y), x16(a.z)].slice(0, n || 6); } });
    }
    if (v.audio === 'ES8311 codec + NS4150B amp') {
      this.buses.internal.attach(0x18, 'ES8311 (on-board codec)', { read: (reg, n) => new Array(n || 1).fill(reg === 0x00 ? 0x83 : 0x00), write: () => {} });
    }
    if (v.tca8418) {
      this.buses.internal.attach(0x34, 'TCA8418 (on-board keypad)', {
        read: (reg, n) => [this.keyboard.tcaReadReg(reg)].slice(0, n || 1),
        write: (reg, data) => this.keyboard.tcaWriteReg(reg, data[0]),
      });
    }
    this.buses.spi.attach(12, 'microSD (on-board)');
  }

  // --- serial ---------------------------------------------------------------
  serial(msg, level = 'info') {
    const line = { t: this.uptime, seq: ++this.serialSeq, msg: String(msg), level };
    this.serialBuf.push(line);
    if (this.serialBuf.length > 800) this.serialBuf.splice(0, 200);
    this.bus.emit('serial', line);
    return line;
  }
  clearSerial() { this.serialBuf.length = 0; this.bus.emit('serial-clear'); }

  // --- lifecycle ------------------------------------------------------------
  boot() {
    this.mode = 'boot';
    this.booted = true;
    this.uptime = 0;
    this.bootLines();
    this.mode = 'run';
    this.bus.emit('boot');
  }
  bootLines() {
    const v = this.variant;
    const lines = [
      ['ESP-ROM:esp32s3-20210327', 'boot'],
      ['Build:Mar 27 2021', 'boot'],
      [`rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)`, 'boot'],
      [`mode:DIO, clock div:1  --  ${v.soc} @ ${v.mhz}MHz, ${(v.flashBytes / 1024 ** 2)}MB flash`, 'boot'],
      ['load:0x3fcd0108,len:0x15e8', 'boot'],
      ['entry 0x403c98d0', 'boot'],
      ['[I][esp_image] booting factory partition (ota_0)', 'info'],
      [`[I][board] model=${v.sku} keyboard=${v.kbChip}`, 'info'],
      [`[I][board] audio=${v.audio}`, 'info'],
      ['[I][i2c] bus internal SDA=8 SCL=9', 'info'],
      ['[I][i2c] scan internal -> ' + (this.buses.internal.scan().map(a => hex(a)).join(' ') || 'none'), 'info'],
      ['[I][i2c] scan grove    -> ' + (this.buses.grove.scan().map(a => hex(a)).join(' ') || 'none'), 'info'],
      ['[I][sd] mount ' + (this.sd.inserted ? 'ok (FAT32)' : 'no card'), 'info'],
      ['[I][wifi] sta start, mac=8c:aa:b5:' + Math.floor(this.rng() * 255).toString(16).padStart(2, '0') + ':11:22', 'info'],
      ['[I][imu] ' + (v.imu ? 'BMI270 online (chip id 0x24)' : 'not present on this SKU'), v.imu ? 'info' : 'warn'],
      ['[I][audio] ' + v.audio, 'info'],
      [`[I] free heap: ${(200000 + Math.floor(this.rng() * 40000))} bytes`, 'info'],
      ['[I][boot] CardputerOS starting…', 'ok'],
    ];
    for (const [m, l] of lines) this.serial(m, l);
    return lines;
  }
  powerOff() { this.mode = 'off'; this.display.sleep(true); this.power.switchOn = false; this.serial('[I] power off', 'warn'); this.bus.emit('power', 'off'); }
  powerOn() { this.power.switchOn = true; this.display.sleep(false); this.bus.emit('power', 'on'); this.boot(); }
  reboot() {
    this.serial('[I] rst:0xc (SW_CPU_RESET) — rebooting', 'warn');
    // a reset does not unplug anything: keep modules, card, charge and audio state
    const keep = {
      // keep the identity too: a physical reset does not renumber the units on the bus
      modules: this.modules.map(m => ({ id: m.def.id, uuid: m.uuid })),
      percent: this.power.percent,
      sdInserted: this.sd.inserted,
      volume: this.speaker.volume,
      backlight: this.display.backlight,
      usb: this.usbConnected,
      jack: this.audioJack,
    };
    this.modules.forEach(m => m.inst.dispose && m.inst.dispose());
    this.modules = [];
    this._initPeripherals();
    this._initBuses();
    this.power.percent = keep.percent;
    this.speaker.setVolume(keep.volume);
    this.display.setBacklight(keep.backlight);
    if (keep.sdInserted) this.sd.insert();
    this.audioJack = keep.jack;
    this.speaker.jackPlugged = keep.jack && this.variant.jack;
    this.usbConnected = keep.usb;
    this.power.usb = keep.usb;
    for (const rec of keep.modules) {
      const res = this.attachModule(rec.id);
      // restore the original handle so open panels/tests keep working after a reset
      if (res.ok && res.module) { res.module.uuid = rec.uuid; this._uuid = Math.max(this._uuid, Number(String(rec.uuid).slice(1)) + 1 || this._uuid); }
    }
    this.boot();
  }
  enterDownloadMode() { this.mode = 'download'; this.display.sleep(true); this.serial('[I] download mode: waiting for esptool on USB-C', 'warn'); this.bus.emit('mode', 'download'); }

  // --- modules --------------------------------------------------------------
  // Chip-select of an SPI module: explicit `cs:` wins, else the EXT header's own CS
  // (GPIO5) or the Grove-side default (GPIO6). GPIO12 is the microSD card, never free.
  csPinOf(def) { return def && def.cs != null ? def.cs : (def && def.eco === 'ext' ? 5 : 6); }
  slotOf(eco) { return this.modules.filter(m => m.def.eco === eco); }
  slotFull(eco) { const lim = ECOSYSTEMS[eco]?.max ?? 1; return this.slotOf(eco).length >= lim; }

  checkAttach(def) {
    const compat = this.compatFor(def);
    if (!compat.ok) return compat;
    if (['grove', 'ext'].includes(def.eco) && this.slotFull(def.eco)) {
      return { ok: false, error: `${def.eco === 'grove' ? 'Grove port' : 'EXT header'} already occupied by ${this.slotOf(def.eco)[0].def.name}` };
    }
    if (def.eco === 'ext' && !this.variant.ext) return { ok: false, error: 'this SKU has no EXT header' };
    // address conflicts
    if (def.addrs) {
      const bus = def.eco === 'ext' ? this.buses.ext : this.buses.grove;
      for (const a of def.addrs) {
        if (bus.has(a.addr)) return { ok: false, error: `I²C address ${hex(a.addr)} already answered by ${bus.clients.get(a.addr).name}` };
      }
    }
    // pin conflicts
    if (def.pins) {
      for (const p of def.pins) {
        const owner = this.modules.find(m => (m.def.pins || []).includes(p));
        if (owner) return { ok: false, error: `GPIO${p} already claimed by ${owner.def.name}` };
      }
    }
    if (def.transport === 'uart') {
      const u = def.eco === 'ext' ? this.buses.uartExt : this.buses.uartGrove;
      if (u.client) return { ok: false, error: `UART already in use by ${u.client.name}` };
    }
    if (def.transport === 'spi') {
      const csPin = this.csPinOf(def);
      if (csPin === 12) return { ok: false, error: 'GPIO12 is the microSD chip-select — a module cannot share it' };
      if (this.buses.spi.devices.has(csPin)) return { ok: false, error: `SPI chip-select GPIO${csPin} already in use by ${this.buses.spi.devices.get(csPin).name}` };
    }
    return { ok: true };
  }

  attachModule(id) {
    const def = (this.catalog || MODULE_CATALOG).find(m => m.id === id) || MODULE_BY_ID.get(id);
    const check = this.checkAttach(def);
    if (!check.ok) { this.serial(`[E][mod] ${id}: ${check.error}`, 'error'); return check; }
    const bus = def.eco === 'ext' ? this.buses.ext : this.buses.grove;
    const uart = def.eco === 'ext' ? this.buses.uartExt : this.buses.uartGrove;
    const ctx = {
      now: () => this.uptime * 1000,
      heat: () => 0.6 + this.cpuLoad * 4.2 + (this.display.backlight * 1.4),
      emit: (evt, payload) => this.bus.emit('module-event', { id: def.id, evt, payload }),
      log: (m, l = 'info') => this.serial(`[${def.shortName || def.name}] ${m}`, l),
      uartOpen: () => !!uart.client && uart.client.name === def.name,
      uartSend: (data) => uart.reply(typeof data === 'string' ? Array.from(new TextEncoder().encode(data)) : data),
      i2c: this.buses,
      device: this,
    };
    let inst;
    try {
      // feed-delivered modules carry their driver as source text (no bundling needed)
      const factory = def.create || (def.source ? new Function('return (' + def.source + ')')() : null);
      inst = factory ? (factory(ctx) || {}) : { state: {} };
    }
    catch (e) { this.serial(`[E][mod] ${def.name} driver failed: ${e.message}`, 'error'); return { ok: false, error: 'driver init failed: ' + e.message }; }

    if (def.addrs) {
      for (const a of def.addrs) {
        bus.attach(a.addr, `${def.name} ${a.chip}`, {
          read: (reg, n) => (inst.read ? inst.read(a.addr, reg, n) : new Array(n || 1).fill(0)),
          write: (reg, data) => inst.write && inst.write(a.addr, reg, data),
        });
      }
    }
    if (def.transport === 'uart') {
      // expose the module -> SoC direction so drivers can answer AT/NMEA/Modbus frames
      inst._reply = (bytes) => uart.reply(bytes);
      uart.attach(def.name, { uartIn: (b) => inst.uartIn && inst.uartIn(b) }, def.baud);
    }
    if (def.transport === 'spi') {
      // EXT CAPs share the SD SPI lines (SCK 40 / MOSI 14 / MISO 39) but take their own
      // chip-select. Never allow a module to take CS 12 — that is the microSD card.
      const csPin = this.csPinOf(def);
      if (csPin === 12) { this.serial(`[E][spi] ${def.name}: CS 12 belongs to the microSD card`, 'error'); return { ok: false, error: 'CS 12 is the microSD card' }; }
      this.buses.spi.attach(csPin, def.name, { spiXfer: (b) => (inst.spiXfer ? inst.spiXfer(b) : b.map(() => 0)) });
    }
    if (def.transport === 'gpio') {
      for (const pin of def.pins || []) {
        const prevPush = [...(inst.gpioInput ? [] : [])];
        this.buses.gpio = this.buses.gpio || new Map();
        this.buses.gpio.set(pin, { owner: def.name, inst });
        void prevPush;
      }
    }

    const rec = { uuid: `m${this._uuid++}`, def, inst };
    this.modules.push(rec);
    const addrTxt = def.addrs ? ' @ ' + def.addrs.map(a => hex(a.addr)).join(', ') : '';
    this.serial(`[I][mod] attached ${def.name} (${def.sku}) on ${def.eco}${addrTxt}`, 'ok');
    this.bus.emit('modules-changed', this.modules);
    this.bus.emit('module-attached', rec);
    return { ok: true, module: rec };
  }

  detachModule(uuid) {
    const i = this.modules.findIndex(m => m.uuid === uuid);
    if (i < 0) return { ok: false, error: 'not present' };
    const rec = this.modules[i];
    const def = rec.def;
    const bus = def.eco === 'ext' ? this.buses.ext : this.buses.grove;
    if (def.addrs) for (const a of def.addrs) bus.detach(a.addr);
    if (def.transport === 'uart') (def.eco === 'ext' ? this.buses.uartExt : this.buses.uartGrove).detach();
    if (def.transport === 'spi') this.buses.spi.detach(this.csPinOf(def.def));
    if (def.transport === 'gpio') for (const pin of def.pins || []) this.buses.gpio?.delete(pin);
    try { rec.inst.dispose && rec.inst.dispose(); } catch { /* ignore */ }
    this.modules.splice(i, 1);
    this.serial(`[W][mod] removed ${def.name} from ${def.eco}`, 'warn');
    this.bus.emit('modules-changed', this.modules);
    this.bus.emit('module-detached', rec);
    return { ok: true };
  }

  findModule(id) { return this.modules.find(m => m.def.id === id) || null; }
  moduleState(id) { const m = this.findModule(id); return m ? m.inst.state : null; }
  setModuleControl(uuid, controlId, value) {
    const rec = this.modules.find(m => m.uuid === uuid);
    if (!rec) return { ok: false, error: 'module not attached' };
    const ctrls = [...(rec.def.controls || []), ...(rec.inst.controls || [])];
    const c = ctrls.find(c => c.id === controlId);
    if (!rec.inst.setControl) return { ok: false, error: 'module has no injectable controls' };
    rec.inst.setControl(controlId, value);
    return { ok: true, control: c };
  }

  // --- GPIO / ADC -----------------------------------------------------------
  digitalRead(pin) {
    const g = this.buses.gpio?.get(pin);
    if (g?.inst.gpioRead) return g.inst.gpioRead();
    return 0;
  }
  analogRead(pin) {
    const g = this.buses.gpio?.get(pin);
    if (g?.inst.analogRead) return g.inst.analogRead();
    return Math.round(2048 + Math.sin(this.uptime * 3) * 200);
  }
  digitalWrite(pin, level) {
    const g = this.buses.gpio?.get(pin);
    if (g?.inst.gpio) g.inst.gpio(level);
    if (pin === 38 && this.variant.rgbLed === 'shared') this.display.setBacklight(level ? this.display.backlight : 0);
  }
  setLed(r, g, b) {
    if (this.variant.rgbLed === 'shared' && !this.led.power) return false;
    this.led = { ...this.led, r, g, b };
    this.bus.emit('led', this.led);
    return true;
  }

  // --- thermal --------------------------------------------------------------
  // First-order thermal model: the SoC's dissipation heats a lumped mass, the shell
  // radiates to ambient. Real Cardputers get warm under sustained load and the IDF
  // driver pulls the CPU clock back; that is what `throttled` models.
  _thermalTick(dt, mA) {
    const t = this.thermal;
    const watts = (3.7 * mA) / 1000;
    const rK = 34;                       // K/W, board + shell into still air
    const tau = 55;                      // s, thermal time constant
    const target = t.ambientC + watts * rK;
    t.dieC += (target - t.dieC) * Math.min(1, dt / tau);
    t.peakC = Math.max(t.peakC, t.dieC);
    const was = t.throttled;
    t.throttled = t.dieC > 78;
    if (t.throttled !== was) {
      this.serial(t.throttled
        ? `[W][thermal] die ${t.dieC.toFixed(1)} C — throttling CPU to 160 MHz`
        : `[I][thermal] die ${t.dieC.toFixed(1)} C — full 240 MHz`, t.throttled ? 'warn' : 'info');
      this.bus.emit('thermal', t);
    }
  }
  setAmbient(c) { this.thermal.ambientC = clamp(Number(c) || 24, -10, 50); return this.thermal.ambientC; }

  // --- watchdog -------------------------------------------------------------
  // Espressif's task WDT: firmware has to feed it, and a blocked loop trips a panic
  // reset. Apps call api.wdt.feed() implicitly once per rendered frame.
  feedWatchdog(now = this.uptime) {
    this.wdt.lastFeed = now; this.wdt.feeds++;
    return true;
  }
  watchdogTripped(now = this.uptime) {
    if (!this.wdt.enabled) return false;
    return (now - this.wdt.lastFeed) * 1000 > this.wdt.timeoutMs;
  }

  // --- tick -----------------------------------------------------------------
  tick(dt, { cpuLoad = this.cpuLoad } = {}) {
    if (this.mode === 'off') return;
    this.cpuLoad = clamp(cpuLoad, 0, 1);
    this.uptime += dt;
    this.keyboard.tick(this.uptime * 1000);
    this.radio.tick(dt);
    this.imu.tick(dt);
    const moduleMa = this.modules.reduce((a, m) => a + (m.def.powerMa || 6), 0);
    this.power.tick(dt, {
      loadFactor: this.cpuLoad, wifi: this.radio.state === 'connected',
      jack: this.audioJack, modulesMa: moduleMa, throttled: this.thermal.throttled,
    });
    this._thermalTick(dt, this.power.milliamps);
    // ESP32-S3 brownout detector: the cell sags under the LCD + radio load well
    // before it is chemically empty, which is why a Cardputer dies at "2 %".
    if (this.power.volts < 3.30 && !this.usbConnected && this.power.percent > 0 && this.mode === 'run') {
      this.mode = 'brownout';
      this.serial(`[E][power] brownout detector was triggered (${this.power.volts.toFixed(2)} V) — see you after the charger`, 'error');
      this.bus.emit('brownout', { volts: this.power.volts });
    }
    for (const rec of this.modules) {
      try { rec.inst.tick && rec.inst.tick(dt); }
      catch (e) { this.serial(`[E][mod] ${rec.def.name} tick: ${e.message}`, 'error'); }
    }
    this.bus.emit('tick', dt);
  }

  sdInfo() { return this.sd.info(); }

  // serializable snapshot for persistence
  snapshot() {
    return {
      variant: this.variantId,
      modules: this.modules.map(m => m.def.id),
      sdInserted: this.sd.inserted,
      volume: this.speaker.volume,
      backlight: this.display.backlight,
      audioJack: this.audioJack,
      battery: this.power.percent,
      led: this.led,
    };
  }
  restore(snap) {
    if (!snap) return;
    this.speaker.setVolume(snap.volume ?? 0.7);
    this.display.setBacklight(snap.backlight ?? 1);
    this.power.percent = snap.battery ?? 82;
    if (snap.sdInserted) this.sd.insert();
    this.setAudioJack(!!snap.audioJack);
    for (const id of snap.modules || []) this.attachModule(id);
  }
  setAudioJack(plugged) {
    this.audioJack = plugged;
    this.speaker.jackPlugged = plugged && this.variant.jack;
    if (plugged && !this.variant.jack) { this.serial('[W][audio] this SKU has no 3.5mm jack', 'warn'); this.audioJack = false; }
    else this.serial(`[I][audio] 3.5mm jack ${this.audioJack ? 'inserted — speaker amp disabled' : 'removed — speaker amp enabled'}`, 'info');
    this.bus.emit('jack', this.audioJack);
  }
  setUsb(connected) {
    this.usbConnected = connected;
    this.power.usb = connected;
    this.serial(connected ? '[I][usb] USB-C connected — serial/JTAG up, charging' : '[I][usb] USB-C disconnected — on battery', 'info');
    this.bus.emit('usb', connected);
  }
  // Swap the SKU underneath the running firmware without touching anything else:
  // peripherals and buses are rebuilt for the new pinmap, modules that the new SKU
  // physically cannot host are unplugged (and reported), everything else survives.
  setVariant(id) {
    if (!VARIANTS[id]) return { ok: false, error: `unknown SKU "${id}"` };
    if (id === this.variantId) return { ok: true, changed: false, ejected: [] };
    const before = this.modules.map(m => ({ id: m.def.id, uuid: m.uuid, name: m.def.name }));
    const hadToggle = !!this.variant.groveToggle;
    const keep = {
      percent: this.power.percent, sdInserted: this.sd.inserted, volume: this.speaker.volume,
      backlight: this.display.backlight, usb: this.usbConnected, jack: this.audioJack,
      grove5v: this.grove5v, led: { ...this.led }, uptime: this.uptime,
    };
    this.modules.forEach(m => m.inst.dispose && m.inst.dispose());
    this.modules = [];
    this.variantId = id;
    this.rng = makeRng();
    this._initPeripherals();
    this._initBuses();
    this.power.percent = keep.percent;
    this.speaker.setVolume(keep.volume);
    this.display.setBacklight(keep.backlight);
    this.led = keep.led;
    if (keep.sdInserted) this.sd.insert();
    this.audioJack = keep.jack;
    this.speaker.jackPlugged = keep.jack && this.variant.jack;
    this.usbConnected = keep.usb;
    this.power.usb = keep.usb;
    // the 5 V switch is a physical switch: keep its position, but a SKU that has no
    // switch always sits at 3.3 V, and coming back to a SKU with one starts at 5 V
    this.grove5v = this.variant.groveToggle ? (hadToggle ? keep.grove5v : true) : false;
    const ejected = [];
    for (const rec of before) {
      const def = MODULE_BY_ID.get(rec.id);
      const why = this.compatFor(def).error;
      if (why) { ejected.push({ ...rec, reason: why }); continue; }
      const res = this.attachModule(rec.id);
      if (res.ok && res.module) res.module.uuid = rec.uuid;
      else ejected.push({ ...rec, reason: res.error || 'did not fit' });
    }
    this.serial(`[I][board] SKU -> ${this.variant.label} (${this.variant.sku}); ${ejected.length} module(s) unplugged`, 'info');
    this.bus.emit('variant', { id, ejected });
    return { ok: true, changed: true, ejected, variant: this.variant };
  }

  // Does this SKU physically support this module? Separate from checkAttach(),
  // which is about what is already plugged in this instant.
  compatFor(def) {
    if (!def) return { ok: false, error: 'unknown module' };
    const v = this.variant;
    if (def.requires === 'adv' && v.id !== 'adv') {
      return { ok: false, error: `needs the EXT 2.54-14P header (Cardputer-Adv only) — this is a ${v.label}` };
    }
    if (def.eco === 'ext' && !v.ext) return { ok: false, error: `${v.label} has no EXT header — CAP modules need the Cardputer-Adv` };
    if (def.requires === 'imu' && !v.imu) return { ok: false, error: 'needs the on-board BMI270 (Cardputer-Adv only)' };
    if (def.requires === 'jack' && !v.jack) return { ok: false, error: 'needs the 3.5 mm jack (Cardputer-Adv only)' };
    if (def.needs5v) {
      if (!v.groveToggle) return { ok: false, error: 'this unit needs 5 V on the Grove rail — only the Adv can switch it' };
      if (!this.grove5v) return { ok: false, error: 'Grove rail is at 3.3 V — flip the 5 V toggle on this SKU to power it' };
    }
    return { ok: true };
  }

  setGrove5v(on) {
    if (!this.variant.groveToggle) {
      this.serial('[W][grove] this SKU has no 5 V/3.3 V toggle — rail stays at 3.3 V', 'warn');
      return { ok: false, error: 'no Grove voltage toggle on this SKU' };
    }
    this.grove5v = !!on;
    this.serial(`[I][grove] rail -> ${this.grove5v ? '5 V' : '3.3 V'}`, 'info');
    // a 5 V-only unit drops off the bus if the rail goes away
    for (const rec of [...this.modules]) {
      const c = this.compatFor(rec.def);
      if (!c.ok) { this.detachModule(rec.uuid); this.bus.emit('module-event', { id: rec.def.id, evt: 'power-loss', payload: {} }); }
    }
    this.bus.emit('grove5v', this.grove5v);
    return { ok: true, volts: this.grove5v ? 5 : 3.3 };
  }

  availableModules() {
    const list = this.catalog || MODULE_CATALOG;
    return list.map(def => {
      const compat = this.compatFor(def);
      const check = compat.ok ? this.checkAttach(def) : compat;
      return { def, ok: check.ok, error: check.error, compatible: compat.ok };
    });
  }
  formatBytes(n) { return fmtBytes(n); }
}

function x16(v) { return clamp(Math.round((v ?? 0) * 4096 + 2048), 0, 65535); }

export { COLORS };
