// =============================================================================
//  M5Stack Grove Unit / Cardputer CAP catalog  (hot-pluggable peripherals)
// =============================================================================
//  Every entry is a small device simulator. It registers I2C addresses (or GPIO
//  pins / UART lines / SPI chip-selects) on the emulated buses, exposes live
//  physical state for the UI, and can be plugged or unplugged while firmware is
//  running so apps have to cope with a device that disappears mid-run.
//
//  Driver contract (returned by create(ctx)):
//    state                 plain object, shown in the UI + readable by apps
//    tick(dt)              advance the physics
//    read(addr, reg, n)    I2C master read  -> array of bytes (optional)
//    write(addr, reg, data)I2C master write -> void (optional)
//    setControl(id, value) UI "inject" sliders (optional)
//    gpio(level)           GPIO input module: level changes from the master
//    uartIn(bytes)         bytes sent by the SoC UART
//    spiXfer(bytes)        SPI full-duplex transfer when this module is selected
//    dispose()             called on unplug
// =============================================================================
import { clamp, makeRng, crc8 } from '../core/util.js';

const be16 = v => [(v >> 8) & 0xff, v & 0xff];
const lerpN = (v, target, k) => v + (target - v) * k;

export const ECOSYSTEMS = {
  grove: { id: 'grove', label: 'Grove (HY2.0-4P)', note: 'Port CUSTOM — G2 / G1 + 5V', max: 1 },
  ext: { id: 'ext', label: 'EXT 2.54-14P', note: 'Rear header — ADV only (UART/I2C/SPI)', max: 1 },
  sd: { id: 'sd', label: 'microSD', note: 'SPI: CS G12 / MOSI G14 / CLK G40 / MISO G39', max: 1 },
  onboard: { id: 'onboard', label: 'On-board', note: 'Soldered on the PCB', max: Infinity },
};

export const MODULE_CATALOG = [
  // ---------------------------------------------------------------- ENV -----
  {
    id: 'env3', name: 'ENV III', sku: 'U001-C', eco: 'grove', transport: 'i2c', color: '#4ade80',
    addrs: [{ addr: 0x44, chip: 'SHT30' }, { addr: 0x70, chip: 'QMP6988' }],
    summary: 'Temp / humidity / barometric pressure (SHT30 + QMP6988)',
    tags: ['sensor', 'weather'],
    controls: [
      { id: 'temp', label: 'Ambient temp', min: -10, max: 45, step: 0.5, unit: '°C' },
      { id: 'humidity', label: 'Humidity', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'pressure', label: 'Pressure', min: 950, max: 1060, step: 1, unit: 'hPa' },
    ],
    create(ctx) {
      const st = { temp: 22.6, humidity: 47.5, pressure: 1012.8, cmd: 0 };
      let ambient = { temp: 22.6, humidity: 47.5, pressure: 1012.8 };
      return {
        state: st,
        tick(dt) { st.temp = lerpN(st.temp, ambient.temp + ctx.heat(), Math.min(1, dt * 0.8)); st.humidity = lerpN(st.humidity, ambient.humidity, Math.min(1, dt * 0.8)); st.pressure = lerpN(st.pressure, ambient.pressure, Math.min(1, dt * 0.8)); },
        write(addr, reg, data) { if (addr === 0x44) st.cmd = reg; },
        read(addr, reg, n) {
          if (addr === 0x44) {
            const t = Math.round(((st.temp + 45) / 175) * 65535) & 0xffff;
            const h = Math.round((st.humidity / 100) * 65535) & 0xffff;
            const tb = be16(t), hb = be16(h);
            return [tb[0], tb[1], crc8(tb), hb[0], hb[1], crc8(hb)].slice(0, n || 6);
          }
          return [0];
        },
        setControl(id, v) { ambient[id] = Number(v); },
      };
    },
  },
  {
    id: 'env4', name: 'ENV IV', sku: 'U001-D', eco: 'grove', transport: 'i2c', color: '#22d3ee',
    addrs: [{ addr: 0x44, chip: 'SHT40' }, { addr: 0x76, chip: 'BMP280' }],
    summary: 'High-accuracy temp / humidity + pressure (SHT40 + BMP280)',
    tags: ['sensor', 'weather'],
    controls: [
      { id: 'temp', label: 'Ambient temp', min: -10, max: 45, step: 0.5, unit: '°C' },
      { id: 'humidity', label: 'Humidity', min: 0, max: 100, step: 1, unit: '%' },
    ],
    create(ctx) {
      const st = { temp: 21.8, humidity: 41, pressure: 1009.4 };
      const ambient = { temp: 21.8, humidity: 41 };
      return {
        state: st,
        tick(dt) { st.temp = lerpN(st.temp, ambient.temp + ctx.heat() * 1.2, Math.min(1, dt)); st.humidity = lerpN(st.humidity, ambient.humidity, Math.min(1, dt)); },
        setControl(id, v) { if (id in ambient) ambient[id] = Number(v); },
      };
    },
  },
  {
    id: 'envpro', name: 'ENV Pro', sku: 'U001-B', eco: 'grove', transport: 'i2c', color: '#a3e635',
    addrs: [{ addr: 0x77, chip: 'BME688' }],
    summary: 'Temp / humidity / pressure / VOC gas resistance (BME688)',
    tags: ['sensor', 'air'],
    controls: [{ id: 'gas', label: 'VOC index', min: 0, max: 500, step: 1, unit: '' }],
    create() {
      const st = { temp: 23.4, humidity: 44, pressure: 1011.2, gas: 82 };
      const rng = makeRng(0x77);
      return {
        state: st,
        tick(dt) { st.temp += (rng() - 0.5) * dt * 0.2; st.gas = clamp(st.gas + (rng() - 0.5) * dt * 6, 0, 500); },
        setControl(id, v) { if (id === 'gas') st.gas = Number(v); },
      };
    },
  },
  // ------------------------------------------------------------ optical -----
  {
    id: 'light', name: 'Unit Light', sku: 'U021', eco: 'grove', transport: 'i2c', color: '#fbbf24',
    addrs: [{ addr: 0x23, chip: 'BH1750FVI' }],
    summary: 'Digital ambient light sensor, 1–65535 lx',
    tags: ['sensor', 'light'],
    controls: [{ id: 'lux', label: 'Illuminance', min: 0, max: 65535, step: 10, unit: 'lx' }],
    create() {
      const st = { lux: 240 };
      return {
        state: st,
        tick(dt) { st.lux = clamp(st.lux + (Math.random() - 0.5) * dt * 40, 0, 65535); },
        read(addr, reg, n) { const v = Math.round(st.lux / 1.2) & 0xffff; return [v >> 8, v & 0xff].slice(0, n || 2); },
        setControl(id, v) { if (id === 'lux') st.lux = Number(v); },
      };
    },
  },
  {
    id: 'color', name: 'Unit Color', sku: 'U009', eco: 'grove', transport: 'i2c', color: '#f472b6',
    addrs: [{ addr: 0x29, chip: 'TCS34725' }],
    summary: 'RGB + clear-channel colour sensor (I²C 0x29)',
    tags: ['sensor', 'light'],
    controls: [{ id: 'hue', label: 'Colour under sensor', min: 0, max: 360, step: 1, unit: '°' }],
    create() {
      const st = { r: 210, g: 40, b: 60, c: 320, hue: 350 };
      return {
        state: st,
        tick() {
          const h = st.hue / 60, c = 255, x = c * (1 - Math.abs((h % 2) - 1));
          const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
          st.r = Math.round(r); st.g = Math.round(g); st.b = Math.round(b); st.c = Math.round((r + g + b) / 3) + 32;
        },
        setControl(id, v) { if (id === 'hue') st.hue = Number(v); },
      };
    },
  },
  {
    id: 'tof', name: 'Unit ToF', sku: 'U034', eco: 'grove', transport: 'i2c', color: '#818cf8',
    addrs: [{ addr: 0x29, chip: 'VL53L0X' }],
    summary: 'Laser time-of-flight distance, 30–2000 mm (I²C 0x29)',
    tags: ['sensor', 'distance'],
    controls: [{ id: 'distance', label: 'Target distance', min: 30, max: 2000, step: 1, unit: 'mm' }],
    create() {
      const st = { distance: 420, valid: true };
      return {
        state: st,
        tick() { st.valid = st.distance < 1900; },
        read(addr, reg, n) { return [Math.round(st.distance) >> 8, Math.round(st.distance) & 0xff].slice(0, n || 2); },
        setControl(id, v) { if (id === 'distance') st.distance = Number(v); },
      };
    },
  },
  {
    id: 'thermal', name: 'Unit Thermal', sku: 'U016', eco: 'grove', transport: 'i2c', color: '#fb7185',
    addrs: [{ addr: 0x33, chip: 'MLX90640' }],
    summary: '32×24 IR thermopile array, -40…300 °C',
    tags: ['sensor', 'thermal'],
    controls: [{ id: 'hotspot', label: 'Hot spot temp', min: 20, max: 120, step: 1, unit: '°C' }],
    create() {
      const st = { hotspot: 38, ambient: 24, frame: new Float32Array(768) };
      return {
        state: st,
        tick(dt) { for (let i = 0; i < 768; i++) { const x = i % 32, y = (i / 32) | 0; const d = Math.hypot(x - 16, y - 12) / 12; st.frame[i] = st.ambient + (st.hotspot - st.ambient) * Math.max(0, 1 - d) + (Math.random() - 0.5) * 0.4; } },
        setControl(id, v) { if (id === 'hotspot') st.hotspot = Number(v); },
      };
    },
  },
  // -------------------------------------------------------- environment -----
  {
    id: 'pir', name: 'Unit PIR', sku: 'U054', eco: 'grove', transport: 'gpio', pins: [2], color: '#facc15',
    summary: 'Passive-infrared human motion detector (digital out)',
    tags: ['sensor', 'motion'],
    controls: [{ id: 'trigger', label: 'Wave a hand', type: 'button' }, { id: 'sensitivity', label: 'Hold time', min: 1, max: 30, step: 1, unit: 's' }],
    create(ctx) {
      const st = { motion: false, level: 0, triggers: 0, hold: 8 };
      let until = 0;
      return {
        state: st,
        tick(dt) { st.level = st.motion ? 1 : 0; if (st.motion && ctx.now() > until) { st.motion = false; } },
        setControl(id, v) {
          if (id === 'trigger') { st.motion = true; st.triggers++; until = ctx.now() + st.hold * 1000; ctx.emit('pir', st); }
          if (id === 'sensitivity') st.hold = Number(v);
        },
        gpioRead() { return st.motion ? 1 : 0; },
      };
    },
  },
  {
    id: 'earth', name: 'Unit Earth', sku: 'U018', eco: 'grove', transport: 'gpio', pins: [2], color: '#84cc16',
    summary: 'Capacitive soil-moisture sensor (analog out)',
    tags: ['sensor', 'plant'],
    controls: [{ id: 'moisture', label: 'Soil moisture', min: 0, max: 100, step: 1, unit: '%' }],
    create() {
      const st = { moisture: 34, raw: 1300 };
      return {
        state: st,
        tick() { st.raw = Math.round(4095 - (st.moisture / 100) * 2400); },
        analogRead() { return st.raw; },
        setControl(id, v) { if (id === 'moisture') st.moisture = Number(v); },
      };
    },
  },
  {
    id: 'heart', name: 'Unit Heart', sku: 'U029', eco: 'grove', transport: 'i2c', color: '#ef4444',
    addrs: [{ addr: 0x57, chip: 'MAX30100' }],
    summary: 'PPG heart-rate / SpO₂ (I²C 0x57)',
    tags: ['sensor', 'bio'],
    controls: [{ id: 'bpm', label: 'Heart rate', min: 45, max: 190, step: 1, unit: 'bpm' }],
    create() {
      const st = { bpm: 72, spo2: 97.4, finger: true };
      return {
        state: st,
        tick(dt) { st.bpm = clamp(st.bpm + (Math.random() - 0.5) * dt * 2, 45, 190); st.spo2 = clamp(st.spo2 + (Math.random() - 0.5) * dt * 0.2, 90, 100); },
        setControl(id, v) { if (id === 'bpm') st.bpm = Number(v); },
      };
    },
  },
  {
    id: 'sonic', name: 'Unit Sonic', sku: 'U033', eco: 'grove', transport: 'i2c', color: '#38bdf8',
    addrs: [{ addr: 0x57, chip: 'RCWL-9600' }],
    summary: 'Ultrasonic ranger, 20–4500 mm (I²C 0x57 — clashes with Unit Heart)',
    tags: ['sensor', 'distance'],
    controls: [{ id: 'distance', label: 'Distance', min: 20, max: 4500, step: 5, unit: 'mm' }],
    create() {
      const st = { distance: 800 };
      return { state: st, setControl(id, v) { if (id === 'distance') st.distance = Number(v); }, read(a, r, n) { return [Math.round(st.distance) >> 8, Math.round(st.distance) & 0xff].slice(0, n || 2); } };
    },
  },
  // ---------------------------------------------------- actuators / IO ------
  {
    id: 'relay', name: 'Unit Relay', sku: 'U004', eco: 'grove', transport: 'i2c', color: '#f97316',
    addrs: [{ addr: 0x26, chip: 'STM32F030' }],
    summary: 'SPST relay, 250 VAC / 10 A, I²C controlled',
    tags: ['actuator'],
    create(ctx) {
      const st = { closed: false, toggles: 0 };
      return {
        state: st,
        tick() {},
        write(addr, reg, data) {
          if (reg === 0x00) {
            const on = !!(data[0] ?? 0);
            if (on !== st.closed) { st.toggles++; ctx.emit('relay', { on }); }
            st.closed = on;
          }
        },
        setControl(id) { if (id === 'toggle') { st.closed = !st.closed; st.toggles++; ctx.emit('relay', { on: st.closed }); } },
        controls: [{ id: 'toggle', label: 'Toggle contact', type: 'button' }],
      };
    },
  },
  {
    id: 'adc', name: 'Unit ADC', sku: 'U013', eco: 'grove', transport: 'i2c', color: '#c084fc',
    addrs: [{ addr: 0x48, chip: 'ADS1100' }],
    summary: '16-bit ADC, ±5 V differential input',
    tags: ['input'],
    controls: [{ id: 'volts', label: 'Input voltage', min: -5, max: 5, step: 0.01, unit: 'V' }],
    create() {
      const st = { volts: 1.25 };
      return {
        state: st,
        read(addr, reg, n) { const v = Math.round((st.volts / 5) * 32767) & 0xffff; return [v >> 8, v & 0xff].slice(0, n || 2); },
        setControl(id, v) { if (id === 'volts') st.volts = Number(v); },
      };
    },
  },
  {
    id: 'dac', name: 'Unit DAC', sku: 'U028', eco: 'grove', transport: 'i2c', color: '#2dd4bf',
    addrs: [{ addr: 0x60, chip: 'MCP4725' }],
    summary: '12-bit DAC, 0–3.3 V analog out',
    tags: ['actuator'],
    create() {
      const st = { volts: 0, raw: 0 };
      return {
        state: st,
        write(addr, reg, data) {
          const raw = ((data[0] ?? 0) << 4) | ((data[1] ?? 0) >> 4);
          st.raw = raw & 0xfff; st.volts = (st.raw / 4095) * 3.3;
        },
        setControl(id, v) { if (id === 'volts') { st.volts = Number(v); st.raw = Math.round((st.volts / 3.3) * 4095); } },
        controls: [{ id: 'volts', label: 'Manual output', min: 0, max: 3.3, step: 0.01, unit: 'V' }],
      };
    },
  },
  {
    id: 'servo', name: 'Unit 8Servo', sku: 'U025', eco: 'grove', transport: 'i2c', color: '#60a5fa',
    addrs: [{ addr: 0x40, chip: 'PCA9685' }],
    summary: '8-channel 12-bit PWM servo driver',
    tags: ['actuator'],
    create() {
      const st = { angles: [90, 90, 90, 90, 90, 90, 90, 90] };
      const regs = new Uint8Array(16);
      return {
        state: st,
        write(addr, reg, data) {
          if (reg >= 0x06 && reg <= 0x45) {
            regs[reg] = data[0] ?? 0;
            const ch = (reg - 0x06) >> 2;
            if (ch < 8) {
              const on = (regs[0x06 + ch * 4] << 8) | regs[0x07 + ch * 4];
              const off = (regs[0x08 + ch * 4] << 8) | regs[0x09 + ch * 4];
              const duty = ((off - on + 4096) % 4096) / 4096;
              st.angles[ch] = Math.round(duty * 180);
            }
          }
        },
        setControl(id, v) { if (id.startsWith('ch')) st.angles[+id.slice(2)] = Number(v); },
        controls: [
          { id: 'ch0', label: 'Servo 0', min: 0, max: 180, step: 1, unit: '°' },
          { id: 'ch1', label: 'Servo 1', min: 0, max: 180, step: 1, unit: '°' },
        ],
      };
    },
  },
  {
    id: 'joyc', name: 'Unit JoyC', sku: 'U073', eco: 'grove', transport: 'i2c', color: '#94a3b8',
    addrs: [{ addr: 0x38, chip: 'STM32' }],
    summary: '2-axis joystick + push button, I²C 0x38',
    tags: ['input'],
    create() {
      const st = { x: 0, y: 0, pressed: false };
      return {
        state: st,
        read(addr, reg, n) { return [st.x & 0xff, st.y & 0xff, st.pressed ? 1 : 0].slice(0, n || 3); },
        setControl(id, v) { if (id in st) st[id] = id === 'pressed' ? !!v : Number(v); },
        controls: [
          { id: 'x', label: 'X axis', min: -100, max: 100, step: 1, unit: '' },
          { id: 'y', label: 'Y axis', min: -100, max: 100, step: 1, unit: '' },
          { id: 'pressed', label: 'Press stick', type: 'button' },
        ],
      };
    },
  },
  {
    id: 'button', name: 'Unit Button', sku: 'U025-B', eco: 'grove', transport: 'gpio', pins: [2], color: '#e2e8f0',
    summary: 'Single push button with RGB indicator (digital in / out)',
    tags: ['input'],
    create(ctx) {
      const st = { pressed: false, presses: 0, led: '#00ff00' };
      return {
        state: st,
        gpioRead() { return st.pressed ? 0 : 1; },
        setControl(id) { if (id === 'press') { st.pressed = !st.pressed; if (st.pressed) st.presses++; ctx.emit('button', { pressed: st.pressed }); } },
        controls: [{ id: 'press', label: 'Press button', type: 'button' }],
      };
    },
  },
  {
    id: 'rgb', shortName: 'RGB', name: 'Unit RGB', sku: 'U001-RGB', eco: 'grove', transport: 'gpio', pins: [2], color: '#a855f7',
    summary: 'SK6812 addressable RGB LED string (GPIO data line)',
    tags: ['actuator', 'led'],
    create(ctx) {
      const st = { color: '#22d3ee', brightness: 0.6, leds: 3, mode: 'solid' };
      return {
        state: st,
        setControl(id, v) { if (id in st) st[id] = v; ctx.emit('rgb', st); },
        controls: [{ id: 'color', label: 'Colour', type: 'color' }, { id: 'brightness', label: 'Brightness', min: 0, max: 1, step: 0.05, unit: '' }],
      };
    },
  },
  {
    id: 'buzzer', name: 'Unit Buzzer', sku: 'U004-B', eco: 'grove', transport: 'gpio', pins: [2], color: '#fde047',
    summary: 'Passive piezo buzzer on a PWM pin',
    tags: ['actuator', 'audio'],
    create(ctx) {
      const st = { freq: 0, sounding: false };
      return {
        state: st,
        gpio(level) { st.sounding = !!level; if (st.sounding) ctx.emit('buzz', st); },
        setControl(id, v) { if (id === 'freq') st.freq = Number(v); },
        controls: [{ id: 'freq', label: 'Tone', min: 200, max: 5000, step: 10, unit: 'Hz' }],
      };
    },
  },
  // -------------------------------------------------------------- radios ----
  {
    id: 'rfid', name: 'Unit RFID', sku: 'U031', eco: 'grove', transport: 'i2c', color: '#facc15',
    addrs: [{ addr: 0x28, chip: 'MFRC522' }],
    summary: '13.56 MHz RFID / NFC reader (MIFARE Classic, I²C 0x28)',
    tags: ['sensor', 'nfc'],
    create(ctx) {
      const CARDS = [{ uid: 'a1:b2:c3:d4', type: 'MIFARE 1K' }, { uid: '08:93:2f:11', type: 'NTAG213' }];
      const st = { present: false, uid: '--', card: CARDS[0], reads: 0 };
      return {
        state: st,
        tick() { st.uid = st.present ? st.card.uid : '--'; },
        setControl(id) { if (id === 'tap') { st.present = !st.present; if (st.present) { st.reads++; ctx.emit('rfid', st.card); } } if (id === 'next') { st.card = CARDS[(CARDS.indexOf(st.card) + 1) % CARDS.length]; } },
        controls: [{ id: 'tap', label: 'Tap card', type: 'button' }, { id: 'next', label: 'Swap card', type: 'button' }],
      };
    },
  },
  {
    id: 'gps', name: 'Unit GPS', sku: 'U032', eco: 'grove', transport: 'uart', baud: 9600, color: '#4ade80',
    summary: 'GNSS receiver streaming NMEA 0183 over UART',
    tags: ['sensor', 'position'],
    controls: [{ id: 'sats', label: 'Satellites', min: 0, max: 16, step: 1, unit: '' }],
    create(ctx) {
      const st = { lat: 41.3573, lon: -72.0994, sats: 9, fix: true, hdop: 0.9, alt: 32 };
      let t = 0;
      return {
        state: st,
        tick(dt) {
          t += dt;
          if (t > 1) {
            t = 0;
            if (ctx.uartOpen()) {
              const nmea = `$GPGGA,1200${Math.floor(ctx.now() / 1000) % 60},${st.lat.toFixed(4)},N,${Math.abs(st.lon).toFixed(4)},W,1,${String(st.sats).padStart(2, '0')},${st.hdop.toFixed(1)},${st.alt.toFixed(0)},M,0.0,M,,*7E\r\n`;
              ctx.uartSend(nmea);
            }
          }
        },
        setControl(id, v) { if (id === 'sats') { st.sats = Number(v); st.fix = st.sats > 3; } },
      };
    },
  },
  {
    id: 'lora', name: 'Unit LoRaWAN', sku: 'U111', eco: 'grove', transport: 'uart', baud: 115200, color: '#f59e0b',
    summary: 'SX1262 LoRa module over UART (AT command set)',
    tags: ['radio', 'lora'],
    controls: [{ id: 'inject', label: 'Inject inbound packet', type: 'button' }],
    create(ctx) {
      const st = { rssi: -87, snr: 8.5, packets: 0, last: '' };
      return {
        state: st,
        uartIn(bytes) {
          const s = new TextDecoder().decode(Uint8Array.from(bytes));
          // RUI3-style AT firmware: every accepted command is acknowledged on TX.
          if (s.includes('AT+SEND')) { st.packets++; ctx.uartSend('+OK\r\n'); }
          else if (s.includes('AT+JOIN')) { st.joined = true; ctx.uartSend('+EVT:JOINED\r\n'); }
          else if (s.trim()) ctx.uartSend('+ERR:unknown command\r\n');
        },
        tick() { },
        setControl(id) {
          if (id === 'inject') { const msg = 'hello from node ' + (1000 + Math.floor(Math.random() * 8999)); st.last = msg; st.packets++; ctx.uartSend('+RCV=9f3a,' + msg.length + ',' + msg + ',' + st.rssi + ',' + st.snr + '\r\n'); }
        },
      };
    },
  },
  {
    id: 'fingerprint', name: 'Unit Fingerprint', sku: 'U041', eco: 'grove', transport: 'uart', baud: 57600, color: '#cbd5e1',
    summary: 'Capacitive fingerprint module, 100-finger library over UART',
    tags: ['sensor', 'bio'],
    create(ctx) {
      const st = { enrolled: 3, matched: null };
      return {
        state: st,
        setControl(id) { if (id === 'scan') { st.matched = 1 + Math.floor(Math.random() * st.enrolled); ctx.uartSend('\xEF\x01'); } if (id === 'enroll') st.enrolled++; },
        controls: [{ id: 'scan', label: 'Scan finger', type: 'button' }, { id: 'enroll', label: 'Enroll finger', type: 'button' }],
      };
    },
  },
  {
    id: 'gesture', name: 'Unit Gesture', sku: 'U032-G', eco: 'grove', transport: 'i2c', color: '#a78bfa',
    addrs: [{ addr: 0x73, chip: 'PAJ7620U2' }],
    summary: 'Hand-gesture recognition: up / down / left / right / push',
    tags: ['sensor', 'input'],
    create(ctx) {
      const GEST = ['up', 'down', 'left', 'right', 'push'];
      const st = { gesture: 'none', count: 0, last: 0 };
      return {
        state: st,
        setControl(id) {
          if (id === 'gesture') {
            st.gesture = GEST[Math.floor(Math.random() * GEST.length)];
            st.count++; st.last = GEST.indexOf(st.gesture) + 1;
            ctx.emit('gesture', { gesture: st.gesture });
          }
        },
        controls: [{ id: 'gesture', label: 'Wave a hand', type: 'button' }],
      };
    },
  },
  {
    id: 'ncir', name: 'Unit NCIR', sku: 'U016-B', eco: 'grove', transport: 'i2c', color: '#f87171',
    addrs: [{ addr: 90, chip: 'MLX90614' }],
    summary: 'Non-contact IR thermometer, -70…380 °C (I²C 0x5A)',
    tags: ['sensor', 'thermal'],
    controls: [{ id: 'object', label: 'Object temp', min: -20, max: 200, step: 0.5, unit: '°C' }],
    create() {
      const st = { object: 31.4, ambient: 23.2 };
      return {
        state: st,
        tick() { st.ambient += (Math.random() - 0.5) * 0.02; },
        setControl(id, v) { if (id === 'object') st.object = Number(v); },
      };
    },
  },
  {
    id: 'extio', name: 'Unit ExtIO', sku: 'U011', eco: 'grove', transport: 'i2c', color: '#94a3b8',
    addrs: [{ addr: 32, chip: 'MCP23017' }],
    summary: '16-channel digital expander, 8 in / 8 out with LED feedback',
    tags: ['input', 'actuator'],
    create() {
      const st = { outputs: 0, inputs: 0b10100101 };
      const regs = new Uint8Array(22);
      return {
        state: {
          get outputs() { return '0b' + st.outputs.toString(2).padStart(8, '0'); },
          get inputs() { return '0b' + st.inputs.toString(2).padStart(8, '0'); },
        },
        write(addr, reg, data) { if (reg === 0x12) { st.outputs = data[0] ?? 0; regs[0x12] = data[0] ?? 0; } },
        setControl(id, v) { if (id === 'inputs') st.inputs = Number(v) & 0xff; },
        controls: [{ id: 'inputs', label: 'Input bits', min: 0, max: 255, step: 1 }],
      };
    },
  },
  // ------------------------------------------------- Cardputer CAP modules --
  {
    id: 'cap-lora1262', name: 'CAP LoRa-1262', sku: 'U191-B', eco: 'ext', transport: 'spi', requires: 'adv',
    pins: [40, 14, 39, 5, 6, 4], cs: 5, color: '#fb923c',
    summary: 'SX1262 868/915 MHz LoRa radio — Meshtastic capable (rear EXT header)',
    tags: ['radio', 'lora', 'cap'],
    create(ctx) {
      const st = { freq: 915.0, txPower: 14, packets: 0, rssi: -104, snr: 5.2, meshNodes: 3 };
      return {
        state: st,
        tick(dt) { if (Math.random() < dt * 0.15) { st.packets++; st.rssi = -80 - Math.round(Math.random() * 40); } },
        spiXfer(bytes) { return bytes.map((b, i) => (i === 0 ? 0x00 : b)); },
        setControl(id) { if (id === 'tx') { st.packets++; ctx.emit('lora-tx', st); } },
        controls: [{ id: 'tx', label: 'Transmit test packet', type: 'button' }],
      };
    },
  },
  {
    id: 'cap-cc1101', name: 'CAP CC1101', sku: 'U191-C', eco: 'ext', transport: 'spi', requires: 'adv',
    pins: [40, 14, 39, 5, 6, 4], cs: 5, color: '#22d3ee',
    summary: 'Sub-GHz CC1101 transceiver, 300–928 MHz (rear EXT header)',
    tags: ['radio', 'cap'],
    create() {
      const st = { freq: 433.92, mode: 'idle', packets: 0 };
      return { state: st, setControl(id) { if (id === 'tx') st.packets++; }, controls: [{ id: 'tx', label: 'Send OOK burst', type: 'button' }] };
    },
  },
  // ------------------------------------------------------ more Grove Units --
  // Second batch: the long tail of M5Stack's Unit family. Same driver contract as
  // above, real chip addresses, and each carries a realistic supply current so the
  // battery model (and the thermal model) sees the load the real stack would draw.
  {
    id: 'imu', name: 'Unit IMU', sku: 'U095', eco: 'grove', transport: 'i2c', color: '#f472b6', powerMa: 4,
    addrs: [{ addr: 0x68, chip: 'MPU6886' }],
    summary: '6-axis accel + gyro (MPU6886), ±8 g / ±2000 °/s',
    tags: ['sensor', 'motion'],
    controls: [{ id: 'tiltX', label: 'Tilt X', min: -1, max: 1, step: 0.02 }, { id: 'tiltY', label: 'Tilt Y', min: -1, max: 1, step: 0.02 }],
    create() {
      const st = { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 };
      let tx = 0, ty = 0, phase = 0;
      const s16 = v => { const i = clamp(Math.round(v * 2048), -32768, 32767) & 0xffff; return [i >> 8, i & 0xff]; };
      const regs = new Uint8Array(128);
      return {
        state: st,
        tick(dt) { phase += dt * 2; st.ax = tx + Math.sin(phase) * 0.01; st.ay = ty + Math.cos(phase) * 0.01; st.az = Math.sqrt(Math.max(0, 1 - st.ax ** 2 - st.ay ** 2)); },
        setControl(id, v) { if (id === 'tiltX') tx = Number(v); if (id === 'tiltY') ty = Number(v); },
        write(addr, reg, data) { regs[reg & 0x7f] = data[0] ?? 0; },
        read(addr, reg) {
          if ((reg & 0x7f) === 0x75) return [0x19];             // WHO_AM_I
          const base = reg & 0x7f;
          const acc = [...s16(st.ax), ...s16(st.ay), ...s16(st.az)];
          const gyr = [...s16(st.gx / 100), ...s16(st.gy / 100), ...s16(st.gz / 100)];
          const table = { 0x3b: acc, 0x43: gyr, 0x3c: acc, 0x3d: acc };
          return (table[base] || acc).slice(0, 6);
        },
      };
    },
  },
  {
    id: 'dlight', name: 'DLight Unit', sku: 'U136', eco: 'grove', transport: 'i2c', color: '#facc15', powerMa: 2,
    addrs: [{ addr: 0x23, chip: 'BH1750FVI' }],
    summary: 'Ambient light sensor, 1–65535 lx, 16-bit',
    tags: ['sensor', 'light'],
    controls: [{ id: 'lux', label: 'Illuminance', min: 0, max: 4000, step: 10, unit: 'lx' }],
    create(ctx) {
      const st = { lux: 320, mode: 'continuous H-res' };
      let target = 320;
      return {
        state: st,
        tick(dt) { st.lux = lerpN(st.lux, target, Math.min(1, dt * 2)); },
        setControl(id, v) { if (id === 'lux') target = Number(v); },
        write(addr, reg) { if (reg === 0x10) st.mode = 'continuous H-res'; },
        read() { const v = Math.round(st.lux * 1.2) & 0xffff; return [v >> 8, v & 0xff]; },
      };
    },
  },
  {
    id: 'co2', name: 'Unit CO2', sku: 'U103', eco: 'grove', transport: 'i2c', color: '#34d399', powerMa: 22,
    addrs: [{ addr: 0x62, chip: 'SCD40' }],
    summary: 'Photoacoustic CO₂ 400–2000 ppm + T/RH, CRC-checked words',
    tags: ['sensor', 'air'],
    controls: [
      { id: 'co2', label: 'CO₂', min: 400, max: 2000, step: 10, unit: 'ppm' },
      { id: 'temp', label: 'Temp', min: 0, max: 45, step: 0.5, unit: '°C' },
    ],
    create() {
      const st = { co2: 612, temp: 23.4, humidity: 44.1, ready: true };
      let tc = 612, tt = 23.4;
      const crc = bytes => crc8(bytes);
      return {
        state: st,
        tick(dt) { st.co2 = lerpN(st.co2, tc, Math.min(1, dt * 0.5)); st.temp = lerpN(st.temp, tt, Math.min(1, dt * 0.5)); },
        setControl(id, v) { if (id === 'co2') tc = Number(v); if (id === 'temp') tt = Number(v); },
        write() { },
        read(addr, reg) {
          if (reg === 0x21) {                                 // read_measurement
            const w = v => [(v >> 8) & 0xff, v & 0xff];
            const c = w(Math.round(st.co2)); const t = w(Math.round((st.temp + 45) * 65535 / 175));
            return [...c, crc(c), ...t, crc(t)];
          }
          return [0];
        },
      };
    },
  },
  {
    id: 'tvoc', name: 'Unit TVOC', sku: 'U088', eco: 'grove', transport: 'i2c', color: '#a3e635', powerMa: 12,
    addrs: [{ addr: 0x58, chip: 'SGP30' }],
    summary: 'TVOC + eCO₂ air-quality sensor (sensirion SGP30)',
    tags: ['sensor', 'air'],
    controls: [{ id: 'tvoc', label: 'TVOC', min: 0, max: 1000, step: 5, unit: 'ppb' }],
    create() {
      const st = { tvoc: 88, eco2: 604 };
      let tv = 88;
      return {
        state: st,
        tick(dt) { st.tvoc = lerpN(st.tvoc, tv, Math.min(1, dt)); st.eco2 = 400 + Math.round(st.tvoc * 2.3); },
        setControl(id, v) { if (id === 'tvoc') tv = Number(v); },
        read(addr, reg) {
          if (reg === 0x20) return [0, 0];
          const w = v => [(v >> 8) & 0xff, v & 0xff];
          return [...w(Math.round(st.eco2)), ...w(Math.round(st.tvoc))];
        },
      };
    },
  },
  {
    id: 'hcho', name: 'Unit HCHO', sku: 'U092', eco: 'grove', transport: 'i2c', color: '#f87171', powerMa: 6,
    addrs: [{ addr: 0x5d, chip: 'SFA30' }],
    summary: 'Formaldehyde sensor, 0–1000 ppb, electrochemical cell',
    tags: ['sensor', 'air'],
    controls: [{ id: 'hcho', label: 'HCHO', min: 0, max: 500, step: 1, unit: 'ppb' }],
    create() {
      const st = { hcho: 12, temp: 22.8, rh: 41.0 };
      let h = 12;
      return {
        state: st,
        tick(dt) { st.hcho = lerpN(st.hcho, h, Math.min(1, dt * 2)); },
        setControl(id, v) { if (id === 'hcho') h = Number(v); },
        read(addr, reg) {
          if (reg === 0x00) {
            const w = v => [(v >> 8) & 0xff, v & 0xff];
            const a = w(Math.round(st.hcho * 10)), b = w(Math.round(st.temp * 200)), c = w(Math.round(st.rh * 100));
            return [...a, crc8(a), ...b, crc8(b), ...c, crc8(c)];
          }
          return [0];
        },
      };
    },
  },
  {
    id: 'pm25', name: 'Unit PM2.5', sku: 'U109', eco: 'grove', transport: 'uart', baud: 9600, color: '#fb7185', powerMa: 30,
    pins: [2, 1],
    summary: 'Particulate sensor (PMSA003) — PM1.0 / PM2.5 / PM10 over UART',
    tags: ['sensor', 'air'],
    create() {
      const st = { pm1: 6, pm25: 11, pm10: 18, frames: 0 };
      return {
        state: st,
        tick(dt) { st.frames += Math.random() < dt * 0.8 ? 1 : 0; },
        uartIn(bytes) {
          // 0xE2 0x00 = "read in passive mode": answer with a 32-byte PMS frame
          if (bytes[0] === 0xe2 && bytes[1] === 0x00) {
            const body = [0x42, 0x4d, 0, 28];
            for (const v of [st.pm1 * 10, st.pm25 * 10, st.pm10 * 10, 3, 5, 7]) {
              const x = Math.min(65535, Math.round(v)); body.push(x >> 8, x & 0xff);
            }
            while (body.length < 30) body.push(0);
            const sum = body.reduce((a, b) => a + b, 0) & 0xffff;
            body.push(sum >> 8, sum & 0xff);
            st.frames++;
            this._reply && this._reply(body);
          }
        },
      };
    },
  },
  {
    id: 'tof4m', name: 'ToF4M Unit', sku: 'U101', eco: 'grove', transport: 'i2c', color: '#38bdf8', powerMa: 18,
    addrs: [{ addr: 0x29, chip: 'VL53L1X' }],
    summary: '4 m time-of-flight ranger (VL53L1X) — shares 0x29 with the VL53L0X unit',
    tags: ['sensor', 'distance'],
    controls: [{ id: 'distance', label: 'Distance', min: 30, max: 4000, step: 10, unit: 'mm' }],
    create() {
      const st = { distanceMm: 842, ranging: true };
      let d = 842;
      return {
        state: st,
        tick(dt) { st.distanceMm = Math.round(lerpN(st.distanceMm, d, Math.min(1, dt * 3))); },
        setControl(id, v) { if (id === 'distance') d = Number(v); },
        read(addr, reg) {
          if (reg === 0x1e) return [0xea, 0x01];               // model id
          const mm = st.distanceMm;
          return [mm >> 8, mm & 0xff];
        },
      };
    },
  },
  {
    id: 'encoder', name: 'Unit Encoder', sku: 'U135', eco: 'grove', transport: 'i2c', color: '#c084fc', powerMa: 5,
    addrs: [{ addr: 0x40, chip: 'STM32F030' }],
    summary: 'Rotary encoder + push button, 12-bit absolute counter',
    tags: ['input'],
    controls: [{ id: 'count', label: 'Counter', min: 0, max: 4095, step: 1 }],
    create() {
      const st = { count: 2048, direction: 'cw', pressed: false };
      return {
        state: st,
        setControl(id, v) { if (id === 'count') { st.direction = Number(v) > st.count ? 'cw' : 'ccw'; st.count = Number(v) & 0xfff; } },
        read(addr, reg) {
          if (reg === 0x10) return [st.count & 0xff, (st.count >> 8) & 0x0f];
          if (reg === 0x20) return [st.pressed ? 1 : 0, st.direction === 'cw' ? 0 : 1];
          return [0];
        },
      };
    },
  },
  {
    id: 'rtc', name: 'RTC Unit', sku: 'U126', eco: 'grove', transport: 'i2c', color: '#60a5fa', powerMa: 1,
    addrs: [{ addr: 0x51, chip: 'BM8563' }],
    summary: 'Real-time clock + 256 B battery-backed RAM (BM8563)',
    tags: ['sensor', 'time'],
    create() {
      const st = { time: '--:--:--', ram: 0 };
      const bcd = n => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
      return {
        state: st,
        tick() { const d = new Date(); st.time = d.toTimeString().slice(0, 8); },
        read(addr, reg) {
          const d = new Date();
          if (reg === 0x02) return [bcd(d.getSeconds()), bcd(d.getMinutes()), bcd(d.getHours())];
          if (reg === 0x05) return [bcd(d.getDate()), bcd(d.getMonth() + 1), bcd(d.getFullYear() % 100)];
          return [0];
        },
      };
    },
  },
  {
    id: 'oled', name: 'OLED Unit', sku: 'U001-OLED', eco: 'grove', transport: 'i2c', color: '#93c5fd', powerMa: 8,
    addrs: [{ addr: 0x3c, chip: 'SSD1306' }],
    summary: '0.96" 128×64 monochrome OLED on the Grove bus',
    tags: ['actuator', 'display'],
    create() {
      const st = { w: 128, h: 64, pages: 8, contrast: 0x8f };
      return {
        state: st,
        write(addr, reg, data) { if (data.length === 2 && data[0] === 0x81) st.contrast = data[1]; },
        read() { return [0x00]; },
      };
    },
  },
  {
    id: 'opto', name: 'Opto-coupler Unit', sku: 'U120', eco: 'grove', transport: 'gpio', color: '#94a3b8', powerMa: 6,
    pins: [6],
    summary: 'Isolated digital input (3–24 V), 1 kHz max edge rate',
    tags: ['input'],
    controls: [{ id: 'sense', label: 'External level', min: 0, max: 1, step: 1 }],
    create() {
      const st = { level: 0, edges: 0 };
      return {
        state: st,
        setControl(id, v) { if (id === 'sense') { if (Number(v) !== st.level) st.edges++; st.level = Number(v); } },
        digitalRead: () => st.level,
        gpio: () => st.level,
      };
    },
  },
  {
    id: 'mosfet', name: 'MOSFET Unit', sku: 'U102', eco: 'grove', transport: 'gpio', color: '#fb923c', powerMa: 3,
    pins: [6],
    summary: 'Low-side MOSFET switch, 24 V / 2 A inductive loads',
    tags: ['actuator'],
    create() {
      const st = { on: false, duty: 0 };
      return {
        state: st,
        gpio(level) { st.on = !!level; },
        digitalWrite: (v) => { st.on = v > 0; },
      };
    },
  },
  {
    id: 'rs485', name: 'RS485 Unit', sku: 'U094', eco: 'grove', transport: 'uart', baud: 9600, color: '#fbbf24', powerMa: 10,
    summary: 'Half-duplex RS485 (MAX485) with DE/RE on the Grove GPIO',
    tags: ['radio', 'fieldbus'],
    create() {
      const st = { tx: 0, rx: 0, bus: 'idle', lastFrame: '' };
      const crc16 = body => {
        let c = 0xffff;
        for (const b of body) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1; }
        return [c & 0xff, c >> 8];
      };
      return {
        state: st,
        uartIn(bytes) {
          st.tx++; st.bus = 'tx';
          st.lastFrame = bytes.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ');
          // play Modbus slave 0x01: answer a read-holding-registers request
          if (bytes[0] === 0x01 && bytes[1] === 0x03) {
            const body = [0x01, 0x03, 0x02, 0x00, 0x2a];
            st.rx++; st.bus = 'rx';
            this._reply && this._reply([...body, ...crc16(body)]);
          }
        },
      };
    },
  },
  {
    id: 'can', name: 'CAN Unit', sku: 'U126-CAN', eco: 'grove', transport: 'can', color: '#f59e0b', powerMa: 12,
    summary: 'CAN 2.0B transceiver (TJA1051) on the ESP32-S3 TWAI controller',
    tags: ['radio', 'fieldbus'],
    create() {
      const st = { bitrate: 500000, frames: 0, errors: 0, lastId: '0x18F' };
      return {
        state: st,
        tick(dt) { if (Math.random() < dt * 0.4) { st.frames++; st.lastId = '0x' + (0x100 + Math.floor(Math.random() * 0x700)).toString(16).toUpperCase(); } },
        setControl(id) { if (id === 'tx') st.frames++; },
        controls: [{ id: 'tx', label: 'Send test frame', type: 'button' }],
      };
    },
  },
  {
    id: 'mmwave', name: 'mmWave Human Presence', sku: 'U157', eco: 'grove', transport: 'uart', baud: 115200, color: '#22d3ee', powerMa: 25,
    summary: '24 GHz presence / respiration sensor (S3KM1110)',
    tags: ['sensor', 'motion'],
    controls: [{ id: 'present', label: 'Occupant present', min: 0, max: 1, step: 1 }],
    create() {
      const st = { present: true, distanceCm: 92, respiration: 14 };
      let p = 1;
      return {
        state: st,
        tick(dt) { st.present = !!p; if (p) st.distanceCm = Math.round(90 + Math.sin(Date.now() / 4000) * 12); },
        setControl(id, v) { if (id === 'present') p = Number(v); },
        uartIn(bytes) { if (bytes[0] === 0xf4 && bytes[1] === 0xf3) st.present = true; },
      };
    },
  },
  {
    id: 'nbiot', name: 'Unit NB-IoT', sku: 'U113', eco: 'grove', transport: 'uart', baud: 115200, color: '#818cf8', powerMa: 45,
    summary: 'SIM7020G NB-IoT modem — AT command set, needs a SIM',
    tags: ['radio', 'cellular'],
    controls: [{ id: 'signal', label: 'CSQ', min: 0, max: 31, step: 1 }],
    create() {
      const st = { registered: '1', csq: 18, imei: '865067021234567', apn: 'nbiot' };
      return {
        state: st,
        setControl(id, v) { if (id === 'signal') st.csq = Number(v); },
        uartIn(bytes) {
          const cmd = String.fromCharCode(...bytes).trim().toUpperCase();
          const reply = m => this._reply && this._reply(Array.from(new TextEncoder().encode(m + '\r\n')));
          if (cmd.startsWith('AT+CSQ')) reply(`+CSQ: ${st.csq},0`);
          else if (cmd.startsWith('AT+CEREG')) reply('+CEREG: 0,1');
          else if (cmd.startsWith('AT+CGATT')) reply('+CGATT: 1');
          else if (cmd === 'AT') reply('OK');
        },
      };
    },
  },
  {
    id: 'catm', name: 'Unit Cat-M', sku: 'U114', eco: 'grove', transport: 'uart', baud: 115200, color: '#a78bfa', powerMa: 55,
    summary: 'SIM7080G Cat-M1 / NB-IoT modem with GNSS',
    tags: ['radio', 'cellular'],
    create() {
      const st = { rat: 'CAT-M', registered: true, gnssFix: false, lat: 41.52, lon: -72.07 };
      return {
        state: st,
        uartIn(bytes) {
          const cmd = String.fromCharCode(...bytes).trim().toUpperCase();
          const reply = m => this._reply && this._reply(Array.from(new TextEncoder().encode(m + '\r\n')));
          if (cmd.startsWith('AT+CGNSPWR=1')) { st.gnssFix = true; reply('OK'); }
          else if (cmd.startsWith('AT+CGNSINF')) reply(`+CGNSINF: 1,1,20261107210000.0,${st.lat},${st.lon},24.5,0.2,1,,1.1,1.2,1.3,,8,,1.0,1.0`);
          else if (cmd === 'AT') reply('OK');
        },
      };
    },
  },
  {
    id: 'gsm', name: 'GSM Unit', sku: 'U043', eco: 'grove', transport: 'uart', baud: 115200, color: '#fca5a5', powerMa: 70,
    summary: 'Quad-band 2G modem (SIM800L) — 2 A peaks while transmitting',
    tags: ['radio', 'cellular'],
    create() {
      const st = { registered: false, signal: 14, smsSent: 0 };
      return {
        state: st,
        uartIn(bytes) {
          const cmd = String.fromCharCode(...bytes).trim().toUpperCase();
          const reply = m => this._reply && this._reply(Array.from(new TextEncoder().encode(m + '\r\n')));
          if (cmd.startsWith('AT+CREG')) reply('+CREG: 0,1');
          else if (cmd.startsWith('AT+CSQ')) reply(`+CSQ: ${st.signal},0`);
          else if (cmd.startsWith('AT+CMGS')) { st.smsSent++; reply('OK'); }
          else if (cmd === 'AT') reply('OK');
        },
      };
    },
  },
  {
    id: 'zigbee', name: 'Unit ZigBee', sku: 'U112', eco: 'grove', transport: 'uart', baud: 115200, color: '#fdba74', powerMa: 30,
    summary: 'CC2630 ZigBee module, transparent-transport mode',
    tags: ['radio', 'mesh'],
    create() {
      const st = { panId: '0x1A62', channel: 15, joined: true, peers: 2 };
      return {
        state: st,
        uartIn(bytes) {
          const cmd = String.fromCharCode(...bytes).trim();
          const reply = m => this._reply && this._reply(Array.from(new TextEncoder().encode(m)));
          if (cmd.startsWith('AT+PANID')) reply('+PANID:0x1A62\r\n');
          else if (cmd === 'AT') reply('OK\r\n');
        },
      };
    },
  },
  // ------------------------------------------- Cardputer CAP modules (EXT) --
  {
    id: 'cap-gps', name: 'CAP GPS', sku: 'U191-G', eco: 'ext', transport: 'uart', requires: 'adv', baud: 9600,
    pins: [13, 15], color: '#34d399', powerMa: 28,
    summary: 'GNSS receiver (ATGM336H) on the rear EXT header — NMEA over UART',
    tags: ['sensor', 'position', 'cap'],
    controls: [{ id: 'fix', label: 'Satellites', min: 0, max: 12, step: 1 }],
    create() {
      const st = { sats: 8, fix: '3D', hdop: 0.9, lat: 41.5243, lon: -72.0758 };
      let sats = 8;
      const nmea = (body) => {
        let c = 0; for (const ch of body) c ^= ch.charCodeAt(0);
        return `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
      };
      return {
        state: st,
        tick() { st.sats = sats; st.fix = sats >= 4 ? '3D' : 'no fix'; },
        setControl(id, v) { if (id === 'fix') sats = Number(v); },
        uartIn(bytes) {
          if (bytes[0] === 0x24) {                              // '$' -> start streaming NMEA
            const d = new Date();
            const hhmmss = d.toISOString().slice(11, 19).replace(/:/g, '');
            this._reply && this._reply(Array.from(new TextEncoder().encode(
              nmea(`GNGGA,${hhmmss}.00,4131.458,N,07204.548,W,${st.fix === '3D' ? 1 : 0},0${sats},${st.hdop},24.5,M,,,,`) +
              nmea('GNRMC,' + hhmmss + '.00,A,4131.458,N,07204.548,W,0.02,0.0,071126,,,A'))));
          }
        },
      };
    },
  },
  {
    id: 'cap-rs485', name: 'CAP RS485', sku: 'U191-R', eco: 'ext', transport: 'uart', requires: 'adv', baud: 115200,
    pins: [13, 15], color: '#fbbf24', powerMa: 14,
    summary: 'Isolated RS485 transceiver on the EXT header (Modbus RTU)',
    tags: ['fieldbus', 'cap'],
    create() {
      const st = { frames: 0, errors: 0, last: '' };
      return {
        state: st,
        uartIn(bytes) {
          st.frames++;
          st.last = bytes.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ');
          if (bytes[0] === 0x01 && bytes[1] === 0x03) {
            const body = [0x01, 0x03, 0x02, 0x01, 0x2c];
            let c = 0xffff;
            for (const b of body) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1; }
            this._reply && this._reply([...body, c & 0xff, c >> 8]);
          }
        },
      };
    },
  },
  {
    id: 'cap-brk', name: 'CAP Breakout', sku: 'U191-BRK', eco: 'ext', transport: 'gpio', requires: 'adv',
    pins: [], color: '#64748b', powerMa: 1,
    summary: '14-pin breakout for a custom CAP — exposes UART/I²C/SPI + 3 GPIO to apps',
    tags: ['cap', 'input', 'actuator'],
    create() {
      const st = { exposed: 'UART 13/15 · I2C 8/9 · SPI 40/14/39/5', cs: 5, custom: false };
      return { state: st, setControl(id) { if (id === 'probe') st.custom = true; }, controls: [{ id: 'probe', label: 'Probe header', type: 'button' }] };
    },
  },
];

export const MODULE_BY_ID = new Map(MODULE_CATALOG.map(m => [m.id, m]));

// Merge a remote catalog (delivered by the auto-update feed) with the built-in
// one so new modules can appear without shipping a new emulator build.
export function mergeCatalog(base, extra) {
  const map = new Map(base.map(m => [m.id, m]));
  for (const m of extra || []) {
    if (!m || !m.id) continue;
    const prev = map.get(m.id);
    map.set(m.id, prev ? { ...prev, ...m, driverFromFeed: !m.create } : m);
  }
  return [...map.values()];
}
