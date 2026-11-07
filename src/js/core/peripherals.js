// Peripheral models: audio codec + speaker + mic, IMU, IR blaster, Wi-Fi/BLE
// radio, battery/charger and the virtual microSD card. All of it is DOM-free
// (audio is emitted as events; the UI layer turns events into WebAudio).
import { clamp, Emitter, makeRng } from './util.js';

// ---------------------------------------------------------------- audio -----
export class Speaker {
  constructor() {
    this.bus = new Emitter();
    this.volume = 0.7;
    this.enabled = true;        // NS4150B / NS4168 amp enable
    this.jackPlugged = false;   // 3.5mm on ADV: speaker amp auto-disabled
    this.sampleRate = 44100;
    this.nowPlaying = null;
    this.tones = 0;
  }
  get audible() { return this.enabled && !this.jackPlugged && this.volume > 0; }
  tone(freq, ms = 200, wave = 'square', vol = null) {
    this.tones++;
    this.bus.emit('tone', { freq, ms, wave, vol: vol ?? this.volume, audible: this.audible });
    return this.audible;
  }
  play(samples, rate = 8000) {
    this.bus.emit('samples', { samples, rate, vol: this.volume, audible: this.audible });
  }
  stop() { this.bus.emit('stop'); }
  setVolume(v) { this.volume = clamp(v, 0, 1); }
}

export class Microphone {
  constructor() {
    this.sampleRate = 8000;
    this.gain = 1;
    this.recording = false;
    this.jackSource = null;      // UI can inject a real mic sampler: () => [-1..1]
    this.rng = makeRng(0xbeef);
    this.wavePhase = 0;
  }
  level() {
    if (this.jackSource) return Math.abs(this.jackSource());
    this.wavePhase += 0.3;
    return 0.05 + 0.03 * Math.sin(this.wavePhase);
  }
  // SPM1423 (v1.x) / ES8311 ADC (ADV) model: returns normalized samples.
  record(ms, rate = this.sampleRate) {
    const n = Math.max(1, Math.round((ms / 1000) * rate));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let v;
      if (this.jackSource) v = this.jackSource();
      else {
        // ambient room tone + mains hum + a little vocal-ish wobble
        v = 0.04 * Math.sin(2 * Math.PI * 180 * t) + 0.02 * Math.sin(2 * Math.PI * 60 * t)
          + 0.015 * Math.sin(2 * Math.PI * 420 * t * (1 + 0.01 * Math.sin(t * 3)))
          + (this.rng() - 0.5) * 0.03;
      }
      out[i] = clamp(v * this.gain, -1, 1);
    }
    return out;
  }
  rms(samples) {
    let s = 0;
    for (const v of samples) s += v * v;
    return Math.sqrt(s / Math.max(1, samples.length));
  }
}

// ------------------------------------------------------------- BMI270 IMU ---
export class Imu {
  constructor({ present = true } = {}) {
    this.present = present;
    this.bus = new Emitter();
    this.addr = 0x68;
    this.accl = { x: 0, y: 0, z: 1 };   // in g
    this.gyro = { x: 0, y: 0, z: 0 };   // deg/s
    this.tilt = { x: 0, y: 0 };         // -1..1 UI tilt pad
    this.noise = 0.004;
    this.rng = makeRng(0x5150);
    this.steps = 0;
    this._lastAcc = 1;
  }
  setTilt(x, y) { this.tilt.x = clamp(x, -1, 1); this.tilt.y = clamp(y, -1, 1); }
  tick(dt) {
    const gx = this.tilt.x * 0.9, gy = this.tilt.y * 0.9;
    const target = { x: gx, y: gy, z: Math.sqrt(Math.max(0.05, 1 - gx * gx - gy * gy)) };
    const k = Math.min(1, dt * 12);
    this.accl.x += (target.x - this.accl.x) * k;
    this.accl.y += (target.y - this.accl.y) * k;
    this.accl.z += (target.z - this.accl.z) * k;
    this.gyro.x = (this.accl.y * 57) + (this.rng() - 0.5) * 0.6;
    this.gyro.y = (-this.accl.x * 57) + (this.rng() - 0.5) * 0.6;
    this.gyro.z = (this.rng() - 0.5) * 1.2;
    const mag = Math.hypot(this.accl.x, this.accl.y, this.accl.z);
    if (this._lastAcc < 1.25 && mag > 1.6) this.steps++;
    this._lastAcc = mag;
  }
  getAccel() {
    if (!this.present) return null;
    return { x: this.accl.x + (this.rng() - 0.5) * this.noise, y: this.accl.y + (this.rng() - 0.5) * this.noise, z: this.accl.z + (this.rng() - 0.5) * this.noise };
  }
  getGyro() { return this.present ? { ...this.gyro } : null; }
  // raw register style read used by I2C demos
  readReg(reg) {
    if (reg === 0x00) return 0x24; // CHIP_ID
    return 0;
  }
}

// ------------------------------------------------------------------- IR -----
export class Infrared {
  constructor() {
    this.bus = new Emitter();
    this.log = [];               // decoded transmissions
    this.carrierHz = 38000;
    this.lastPulseUs = 0;
    this.captures = [];          // received frames (learn / replay)
    this.rx = null;
  }
  // NEC frame: 9ms lead, 4.5ms space, 32 bits (addr, ~addr, cmd, ~cmd)
  necEncode(addr, cmd) {
    const bits = [];
    const push = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    push(addr & 0xff, 8); push(~addr & 0xff, 8); push(cmd & 0xff, 8); push(~cmd & 0xff, 8);
    const pulses = [9000, 4500];
    for (const b of bits) { pulses.push(560); pulses.push(b ? 1690 : 560); }
    pulses.push(560);
    return pulses;      // microseconds, alternating mark/space
  }
  sendNec(addr, cmd) {
    const pulses = this.necEncode(addr, cmd);
    const entry = { protocol: 'NEC', addr: addr & 0xff, cmd: cmd & 0xff, at: Date.now(), pulses: pulses.length };
    this.log.unshift(entry);
    if (this.log.length > 40) this.log.pop();
    this.bus.emit('tx', entry);
    return entry;
  }
  // Receiver side: real hardware has an IR photodiode on GPIO44 shared with the
  // emitter, so a remote pressed at the emulated device lands in a capture buffer.
  capture(pulses, { source = 'remote', carriers = 38000 } = {}) {
    const frame = { pulses: Array.from(pulses || []), source, carriers, at: Date.now() };
    this.rx = frame;
    this.captures.push(frame);
    if (this.captures.length > 16) this.captures.shift();
    this.bus.emit('rx', frame);
    return frame;
  }
  learnNec(bytes, { source = 'remote' } = {}) {
    const bits = [];
    for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    const pulses = [9000, -4500];
    for (const b of bits) pulses.push(562, b ? -1687 : -562);
    pulses.push(562, -40000);
    return this.capture(pulses, { source });
  }
  // Range table from M5Stack's datasheet: 410 cm at 0 deg, 170 cm at 45 deg, 66 cm
  // at 90 deg. Used by the UI to say whether a shot would actually reach.
  rangeCm(angleDeg = 0) {
    const a = Math.abs(clamp(angleDeg, -90, 90));
    return Math.round(410 - (410 - 170) * (a / 45) * (a <= 45 ? 1 : 0.55) - (a > 45 ? (a - 45) * 2.7 : 0));
  }
  sendRaw(pulses) {
    const entry = { protocol: 'RAW', length: pulses.length, at: Date.now(), pulses: pulses.length };
    this.log.unshift(entry);
    if (this.log.length > 40) this.log.pop();
    this.bus.emit('tx', entry);
    return entry;
  }
}

// --------------------------------------------------------------- radio ------
const AP_POOL = [
  { ssid: 'm5stack-lab', bssid: 'aa:bb:cc:11:22:01', auth: 'WPA2', channel: 6, rssi: -52 },
  { ssid: 'CU_5G_8821', bssid: 'aa:bb:cc:11:22:02', auth: 'WPA2', channel: 11, rssi: -71 },
  { ssid: 'Meshtastic-9c31', bssid: 'aa:bb:cc:11:22:03', auth: 'WPA2', channel: 1, rssi: -63 },
  { ssid: 'HomeNet', bssid: 'aa:bb:cc:11:22:04', auth: 'WPA2', channel: 3, rssi: -58 },
  { ssid: 'NETGEAR-ghost', bssid: 'aa:bb:cc:11:22:05', auth: 'OPEN', channel: 8, rssi: -80 },
  { ssid: 'printer-direct', bssid: 'aa:bb:cc:11:22:06', auth: 'WPA2', channel: 6, rssi: -84 },
  { ssid: 'Cardputer-AP', bssid: 'aa:bb:cc:11:22:07', auth: 'WPA2', channel: 11, rssi: -37 },
];

export class Radio {
  constructor({ hasWifi = true, hasBle = true } = {}) {
    this.hasWifi = hasWifi; this.hasBle = hasBle;
    this.bus = new Emitter();
    this.rng = makeRng(0x2f2f);
    this.state = 'idle';          // idle | scanning | connecting | connected | failed
    this.ssid = null; this.ip = '0.0.0.0'; this.rssi = null;
    this.timer = 0;
    this.scanResults = [];
    this.txBytes = 0; this.rxBytes = 0;
    this.apMode = false;
  }
  listAccessPoints() {
    return AP_POOL.map(ap => ({ ...ap, rssi: Math.round(ap.rssi + (this.rng() - 0.5) * 6) }))
      .sort((a, b) => b.rssi - a.rssi);
  }
  scan() {
    if (!this.hasWifi) return [];
    this.state = 'scanning';
    this.timer = 0.6;
    this.scanResults = this.listAccessPoints();
    return this.scanResults;
  }
  connect(ssid, password = '') {
    if (!this.hasWifi) return { ok: false, error: 'no wifi hardware' };
    if (!ssid) return { ok: false, error: 'ssid required' };
    this.state = 'connecting'; this.timer = 1.4;
    this._pending = { ssid, password };
    this.bus.emit('state', this.state);
    return { ok: true };
  }
  disconnect() { this.state = 'idle'; this.ssid = null; this.ip = '0.0.0.0'; this.rssi = null; this.bus.emit('state', this.state); }
  tick(dt) {
    if (this.timer > 0) this.timer -= dt;
    if (this.state === 'scanning' && this.timer <= 0) { this.state = 'idle'; this.bus.emit('scan', this.scanResults); }
    if (this.state === 'connecting' && this.timer <= 0) {
      /** @type {{ssid?: string, password?: string}} */
      const p = this._pending || {};
      const known = this.scanResults.length ? this.scanResults : this.listAccessPoints();
      const ap = known.find(a => a.ssid === p.ssid);
      // any password works except for the deliberately secured "m5stack-lab" / "HomeNet"
      const needsPass = ['m5stack-lab', 'HomeNet'].includes(p.ssid);
      if (!ap) { this.state = 'failed'; this.bus.emit('state', this.state, 'no such ssid'); return; }
      if (needsPass && (p.password || '').length < 8) { this.state = 'failed'; this.bus.emit('state', this.state, 'auth failed (min 8 chars)'); return; }
      this.state = 'connected'; this.ssid = p.ssid; this.rssi = ap.rssi;
      this.ip = '192.168.4.' + (20 + Math.floor(this.rng() * 60));
      this.bus.emit('state', this.state, this.ip);
    }
  }
  bleScan() {
    if (!this.hasBle) return [];
    const names = ['Mi Band 7', 'AirPods Pro', 'ESP32-S3-DevKit', 'Tile Mate', 'Cardputer-ADV', 'Shelly-Plus-1PM', 'Logitech K380'];
    return names.map((n, i) => ({ name: n, addr: 'f4:12:fa:' + (16 + i).toString(16) + ':aa:0' + i, rssi: -40 - i * 7 }))
      .sort((a, b) => b.rssi - a.rssi);
  }
}

// ---------------------------------------------------------------- battery ---
export class Power {
  constructor({ capacityMah = 1400, hasUsb = true } = {}) {
    this.capacityMah = capacityMah;
    this.percent = 82;
    this.charging = false;
    this.usb = false;
    this.switchOn = true;
    this.milliamps = 120;
    this.volts = 4.05;
    this.chargeCycles = 41;
    this.slept = false;
    // TP4056/TP4057-class charger: ~290 mA CC then CV taper at 4.2 V
    this.chargeCurrentMa = 290;
    this.usbMilliamps = 0;      // what the USB side is delivering
    this.bus = new Emitter();
    this.history = [];
  }
  // 1S Li-ion discharge curve, not a straight line: the knee at ~3.6 V is what makes
  // the last 15 % fall off a cliff on the real thing.
  voltage() {
    const p = clamp(this.percent, 0, 100) / 100;
    const v = 3.20 + 0.70 * Math.pow(p, 0.42) + 0.28 * Math.pow(p, 3.2);
    const sag = (this.milliamps / 1000) * 0.16;                 // internal resistance
    return clamp(v - (this.charging ? 0 : sag), 3.0, this.charging ? 4.2 : 4.2);
  }
  // Active-current budget measured on real hardware: ~165 mA with the keyboard lit
  // and idle, ~256 mA with the IR LED blasting; sleep is a fraction of a µA.
  tick(dt, { loadFactor = 1, wifi = false, jack = false, modulesMa = 0, throttled = false } = {}) {
    let mA = 44 + 96 * loadFactor;                  // SoC + LCD panel + backlight
    if (wifi) mA += 62;
    if (jack) mA += 12;
    if (throttled) mA *= 0.82;
    mA += modulesMa;
    if (this.slept) mA = 0.00026;                   // 0.26 uA light-sleep spec
    this.milliamps = mA;
    if (this.usb) {
      this.charging = this.percent < 99.5;
      // constant-current until 4.15 V, then taper
      const cc = this.percent > 92 ? this.chargeCurrentMa * Math.max(0.08, (100 - this.percent) / 8) : this.chargeCurrentMa;
      this.usbMilliamps = this.charging ? cc : 0;
      if (this.charging) {
        this.percent = clamp(this.percent + ((cc * dt) / 3600) * (100 / this.capacityMah), 0, 100);
      }
    } else {
      this.charging = false;
      this.usbMilliamps = 0;
      const before = this.percent;
      this.percent = clamp(this.percent - (((mA * dt) / 3600) * 100) / this.capacityMah, 0, 100);
      if (before > 5 && this.percent <= 5) this.bus.emit('low');
      if (before > 0 && this.percent <= 0) this.bus.emit('empty');
    }
    this.volts = this.voltage();
    this.history.push(this.volts);
    if (this.history.length > 240) this.history.shift();
  }
  // runtime estimator used by the UI ("1 h 48 m left")
  remainingMinutes(idle = 165) {
    if (this.charging) return null;
    const mA = Math.max(20, this.milliamps || idle);
    return Math.round((this.percent / 100) * this.capacityMah / mA * 60);
  }
}

// ------------------------------------------------------------- microSD ------
export class SdCard {
  constructor({ store = null, capacityBytes = 8 * 1024 ** 3 } = {}) {
    this.store = store;                 // {load():obj, save(obj)} persistence adapter
    this.capacityBytes = capacityBytes;
    this.inserted = false;
    this.mountError = null;
    this.files = new Map();             // path -> {dir, data, mtime}
    this.bus = new Emitter();
    this._seed();
  }
  _seed() {
    const now = Date.now();
    const put = (p, data) => this.files.set(p, { dir: false, data, mtime: now });
    const dir = p => this.files.set(p, { dir: true, data: null, mtime: now });
    dir('/'); dir('/apps'); dir('/logs'); dir('/music');
    put('/README.txt', 'Cardputer-EMU virtual microSD\nInsert / eject this card from the Device panel.\nFiles persist locally.\n');
    put('/config.json', JSON.stringify({ owner: 'cardputer', theme: 'dark', boot_sound: true }, null, 2));
    put('/logs/boot.log', '[  0.00] emu-sd mounted\n');
    put('/notes.txt', 'modules: plug/unplug live on the right ->\n');
  }
  insert() {
    this.inserted = true; this.mountError = null;
    if (this.store) {
      const saved = this.store.load();
      if (saved && saved.files) {
        this.files = new Map(Object.entries(saved.files));
        this.capacityBytes = saved.capacityBytes || this.capacityBytes;
      }
    }
    this.bus.emit('mounted', { files: this.files.size });
    return true;
  }
  eject() { this.inserted = false; this.bus.emit('ejected'); return true; }
  persist() {
    if (!this.store || !this.inserted) return;
    this.store.save({ files: Object.fromEntries(this.files), capacityBytes: this.capacityBytes });
  }
  _norm(p) {
    if (!p) return '/';
    p = String(p).replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    return p.replace(/\/+/, '/');
  }
  mounted() { if (!this.inserted) throw new Error('SD card not mounted'); }
  list(path = '/') {
    this.mounted();
    const base = this._norm(path);
    const out = [];
    for (const [p, f] of this.files) {
      if (p === base) continue;
      const prefix = base === '/' ? '/' : base + '/';
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({ name: rest, path: p, dir: f.dir, size: f.dir ? 0 : (typeof f.data === 'string' ? f.data.length : f.data.byteLength), mtime: f.mtime });
    }
    return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  }
  readText(path) {
    this.mounted();
    const f = this.files.get(this._norm(path));
    if (!f || f.dir) return null;
    return typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data);
  }
  writeText(path, text) {
    this.mounted();
    const p = this._norm(path);
    if (this.usedBytes() + text.length > this.capacityBytes) throw new Error('SD card full');
    this.files.set(p, { dir: false, data: String(text), mtime: Date.now() });
    this.persist();
    return true;
  }
  append(path, text) { return this.writeText(path, (this.readText(path) || '') + text); }
  mkdir(path) { this.mounted(); this.files.set(this._norm(path), { dir: true, data: null, mtime: Date.now() }); this.persist(); return true; }
  remove(path) { this.mounted(); const p = this._norm(path); this.files.delete(p); this.persist(); return true; }
  exists(path) { return this.files.has(this._norm(path)); }
  usedBytes() {
    let n = 0;
    for (const f of this.files.values()) if (!f.dir) n += typeof f.data === 'string' ? f.data.length : f.data.byteLength;
    return n;
  }
  info() {
    return { inserted: this.inserted, capacity: this.capacityBytes, used: this.usedBytes(), free: this.capacityBytes - this.usedBytes(), files: this.files.size };
  }
}

export class Rtc {
  constructor() { this.epochOffset = 0; }
  now() { return new Date(Date.now() + this.epochOffset); }
  fmt(d = this.now()) { return d.toTimeString().slice(0, 8); }
}
