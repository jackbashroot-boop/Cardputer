// =============================================================================
//  Flash model: ESP32-S3 partition table, OTA slots, NVS, serial download mode,
//  and firmware-image validation — plus the "install your own program" path so
//  a new app can be dropped into the emulated device without touching hardware.
//
//  This is a *functional* simulator: a real .bin is parsed, checksummed and laid
//  out into the emulated flash, and the emulator reports exactly what esptool
//  would, but it does not execute Xtensa instructions (see docs/ACCURACY.md).
//  Firmware *= cardputer apps written against the M5Cardputer-style API run for
//  real.
// =============================================================================
import { hex, fmtBytes, Emitter, makeRng } from './util.js';

export const SECTOR = 4096;
export const FLASH_BASE = 0x0;
export const APP_MAGIC = 0xe9;

// Partition layout of an 8 MB ESP32-S3 with two OTA slots (matches what the
// Cardputer/ADV firmware ships in flash; offsets are hex, sizes decimal bytes).
export function partitionTable(flashBytes = 8 * 1024 ** 2) {
  const rows = [
    { name: 'nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x6000 },
    { name: 'otadata', type: 'data', subtype: 'ota', offset: 0xf000, size: 0x2000 },
    { name: 'phy_init', type: 'data', subtype: 'phy', offset: 0x11000, size: 0x1000 },
    { name: 'ota_0', type: 'app', subtype: 'ota_0', offset: 0x20000, size: 0x330000 },
    { name: 'ota_1', type: 'app', subtype: 'ota_1', offset: 0x352000, size: 0x330000 },
    { name: 'spiffs', type: 'data', subtype: 'spiffs', offset: 0x684000, size: 0x160000 },
    { name: 'coredump', type: 'data', subtype: 'coredump', offset: 0x7e4000, size: 0x1c000 },
  ];
  return rows.filter(r => r.offset + r.size <= flashBytes);
}

export function findPartition(table, name) {
  return table.find(p => p.name === name) || null;
}

// ---------------------------------------------------------------------------
//  ESP32 firmware image parser (ESP-IDF image format v1 + extended header)
// ---------------------------------------------------------------------------
export function parseImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 24) return { ok: false, error: `too short (${b.length} B) — not an ESP32 image` };
  const magic = b[0];
  if (magic !== APP_MAGIC) return { ok: false, error: `bad magic ${hex(magic)} (expected 0xE9) — this is not an ESP32 app image` };
  const segments = b[1];
  const flashMode = b[2];
  const flashSizeFreq = b[3];
  const entry = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
  const ext = {
    wpPin: b[8], clkQ: b[9], drv: b[10], chipId: (b[13] << 8) | b[12], minRev: b[14], minRevFull: (b[15] << 8) | b[14],
    maxRevFull: (b[16] << 8) | b[17],
  };
  // xor checksum of the first 16 header bytes must be 0xEF
  let x = 0xef;
  for (let i = 0; i < 16; i++) x ^= b[i];
  if (x !== 0) return { ok: false, error: 'header checksum mismatch — corrupted image' };
  const segs = [];
  let p = 24;
  for (let i = 0; i < segments; i++) {
    if (p + 8 > b.length) return { ok: false, error: `truncated at segment ${i}` };
    const addr = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
    const len = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24)) >>> 0;
    p += 8;
    if (p + len > b.length) return { ok: false, error: `segment ${i} runs past end of file` };
    segs.push({ addr, len, off: p });
    p += len;
  }
  const pad = (16 - (p % 16)) % 16;
  const csumOff = p + pad;
  const checksum = csumOff < b.length ? b[csumOff] : null;
  const hashAppended = checksum === 1 && csumOff + 33 <= b.length;
  return {
    ok: true,
    size: b.length,
    segments: segs,
    segCount: segments,
    entry,
    entryHex: '0x' + entry.toString(16).toUpperCase().padStart(8, '0'),
    flashMode: ['QIO', 'QOUT', 'DIO', 'DOUT'][flashMode & 3] || '?',
    flashFreq: ['40', '26', '20', '80'][(flashSizeFreq >> 4) & 3] + ' MHz',
    flashSize: ['1 MB', '2 MB', '4 MB', '8 MB', '16 MB'][(flashSizeFreq >> 0) & 7] || '?',
    chip: ({ 0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6' })[ext.chipId] || 'chip ' + ext.chipId,
    checksum,
    hashAppended,
    appDesc: readAppDesc(b, segs),
  };
}

// ESP-IDF puts an esp_app_desc_t at the start of the first segment (.rodata).
function readAppDesc(b, segs) {
  const seg = segs[0];
  if (!seg || seg.len < 256) return null;
  const o = seg.off;
  const magic = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (magic !== 0xabcd5432) return null;
  const dec = new TextDecoder();
  const str = (at, n) => dec.decode(b.slice(at, at + n)).replace(/\0+$/, '');
  return {
    version: str(o + 16, 32),
    project: str(o + 48, 32),
    time: str(o + 80, 16),
    date: str(o + 96, 16),
    idf: str(o + 112, 32),
    elfSha: [...b.slice(o + 144, o + 160)].map(v => v.toString(16).padStart(2, '0')).join(''),
  };
}

// ---------------------------------------------------------------------------
//  NVS — a tiny key/value partition with the corners that matter (types,
//  per-key persistence, namespaces, and a bounded size in bytes)
// ---------------------------------------------------------------------------
const NS = 'cardputer';

export class Nvs {
  constructor(map = {}) {
    this.map = new Map(Object.entries(map));
    this.dirty = false;
  }
  _k(k, ns = NS) { return `${ns}:${k}`; }
  get(k, dflt = null, ns = NS) {
    const e = this.map.get(this._k(k, ns));
    return e === undefined ? dflt : e.v;
  }
  set(k, v, ns = NS) {
    if (typeof v === 'string' && v.length > 4000) throw new Error('NVS value too long (4000 B max)');
    this.map.set(this._k(k, ns), { v, t: Array.isArray(v) ? 'blob' : typeof v === 'number' ? 'i32' : typeof v === 'boolean' ? 'u8' : 'str' });
    this.dirty = true;
    return true;
  }
  erase(k, ns = NS) { this.dirty = this.map.delete(this._k(k, ns)) || this.dirty; return true; }
  entries(ns = null) {
    const out = [];
    for (const [k, e] of this.map) {
      const [kns, key] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      if (ns && kns !== ns) continue;
      out.push({ ns: kns, key, type: e.t, value: e.v });
    }
    return out.sort((a, b) => (a.ns + a.key).localeCompare(b.ns + b.key));
  }
  usedBytes() {
    let n = 0;
    for (const [k, e] of this.map) n += 32 + k.length + (typeof e.v === 'string' ? e.v.length : 8);
    return n + 64;
  }
  toJSON() { return Object.fromEntries(this.map); }
}

// ---------------------------------------------------------------------------
//  FlashManager — the thing a "programmer" or the UI would drive
// ---------------------------------------------------------------------------
export class FlashManager {
  constructor(device, runtime, { store = null, onEvent = null } = {}) {
    this.device = device;
    this.runtime = runtime;
    this.store = store;                     // {load(), save(obj)} persistence adapter
    this.bus = new Emitter();
    this.onEvent = onEvent;
    this.nvs = new Nvs();
    this.table = partitionTable(device?.variant?.flashBytes || 8 * 1024 ** 2 * 1024);
    this.slot = 'ota_0';                    // active app slot
    this.appImages = { ota_0: null, ota_1: null };
    this.downloadMode = false;
    this.busy = false;
    this.mac = this._mac();
    this.rng = makeRng(0x5eed);
    this.apps = new Map();                  // user firmware apps: id -> {id, name, version, source, installed}
    this._load();
  }

  // ---- persistence -------------------------------------------------------
  _load() {
    if (!this.store) return;
    const saved = this.store.load();
    if (!saved) return;
    if (saved.nvs) this.nvs = new Nvs(saved.nvs);
    this.slot = saved.slot === 'ota_1' ? 'ota_1' : 'ota_0';
    this.appImages = { ota_0: saved.appImages?.ota_0 || null, ota_1: saved.appImages?.ota_1 || null };
    for (const rec of saved.apps || []) this.apps.set(rec.id, rec);
  }
  persist() {
    if (!this.store) return;
    this.store.save({
      nvs: this.nvs.toJSON(), slot: this.slot, appImages: this.appImages,
      apps: [...this.apps.values()],
    });
  }
  _mac() {
    const r = makeRng(0x3a2b1c);
    return [0x30, 0xed, 0xa0].map(v => v.toString(16)).join(':') + ':' +
      [0, 1, 2].map(() => Math.floor(r() * 256).toString(16).padStart(2, '0')).join(':');
  }

  // ---- introspection -----------------------------------------------------
  info() {
    return {
      chip: 'ESP32-S3 (QFN56) rev v0.2',
      mac: this.mac,
      crystal: '40 MHz',
      flashBytes: this.device?.variant?.flashBytes || 8 * 1024 ** 2,
      psram: 'none (quad-SPI flash only)',
      slot: this.slot,
      table: this.table,
      nvsBytes: this.nvs.usedBytes(),
      download: this.downloadMode,
    };
  }
  imageSummary(slot = this.slot) {
    const img = this.appImages[slot];
    if (!img) return null;
    return img;
  }

  // ---- serial download mode ---------------------------------------------
  // Real hardware: power off, hold G0 (the boot button), plug USB-C -> ROM loader.
  async enterDownloadMode({ hold = 'G0' } = {}) {
    const log = [];
    const push = s => { log.push(s); this.bus.emit('log', s); };
    push('esptool.py v4.8.1');
    push('Found 1 serial port: /dev/ttyACM0 (303A:1001)');
    push(`Connecting${hold === 'G0' ? ' (holding G0 during reset)' : ''}....`);
    push('Detecting chip type... ESP32-S3');
    push(`Chip is ESP32-S3 (QFN56) (revision v0.2)`);
    push('Features: WiFi, BLE, Embedded PSRAM 8MB (AP_3v3)');
    push('Crystal is 40MHz');
    push(`MAC: ${this.mac}`);
    push('Uploading stub...');
    push('Running stub...');
    push('Stub running...');
    push('Changing baud rate to 460800');
    push('Changed.');
    this.downloadMode = true;
    this.device?.enterDownloadMode();
    this.bus.emit('download', true);
    this.persist();
    return { ok: true, log, mac: this.mac };
  }
  exitDownloadMode({ hard = true } = {}) {
    if (!this.downloadMode) return { ok: false, error: 'not in download mode' };
    this.downloadMode = false;
    this.bus.emit('log', hard ? 'Hard resetting via RTS pin...' : 'Leaving...');
    this.device?.serial('[I][boot] leaving download mode — hard reset', 'info');
    this.device && (this.device.mode = 'off');
    this.bus.emit('download', false);
    return { ok: true };
  }

  // ---- flashing ----------------------------------------------------------
  // Writes an image into an OTA slot the way esptool does: erase in 4 KiB
  // sectors, write in blocks, then read back and hash-verify. Progress is
  // reported through onEvent so the UI can show a real progress bar.
  /**
   * @param {{name?: string, bytes?: Uint8Array|ArrayBuffer|number[], slot?: string|null, source?: string}} opts
   */
  async flash({ name = 'firmware.bin', bytes, slot = null, source = 'upload' } = {}) {
    if (this.busy) return { ok: false, error: 'flash already in progress' };
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const target = slot || (this.slot === 'ota_0' ? 'ota_1' : 'ota_0');
    const part = findPartition(this.table, target);
    if (!part) return { ok: false, error: `no ${target} partition` };
    if (!this.downloadMode) {
      const r = await this.enterDownloadMode();
      if (!r.ok) return r;
    }
    const img = parseImage(raw);
    if (!img.ok) {
      this.bus.emit('log', `Writing at 0x${part.offset.toString(16)}... failed: ${img.error}`);
      return { ok: false, error: img.error, parsed: img };
    }
    if (raw.length > part.size) {
      const err = `image is ${fmtBytes(raw.length)}, ${target} only holds ${fmtBytes(part.size)}`;
      this.bus.emit('log', err);
      return { ok: false, error: err, parsed: img };
    }
    this.busy = true;
    const t0 = Date.now();
    const sectors = Math.ceil(raw.length / SECTOR);
    const step = Math.max(1, Math.round(sectors / 24));
    this.bus.emit('log', `Configuring flash size... auto-detected ${fmtBytes(this.info().flashBytes)}`);
    this.bus.emit('log', `Compressed ${raw.length} bytes to ${Math.round(raw.length * 0.62)}...`);
    for (let s = 0; s < sectors; s += step) {
      const pct = Math.min(100, Math.round(((s + step) / sectors) * 100));
      this.bus.emit('progress', { phase: 'write', pct, addr: part.offset + s * SECTOR });
      this.onEvent?.('progress', { phase: 'write', pct });
      // yield so the emulator keeps rendering while "flashing"
      await new Promise(r => setTimeout(r, 6));
    }
    this.bus.emit('log', `Writing at 0x${part.offset.toString(16)}... (100 %)`);
    this.bus.emit('progress', { phase: 'verify', pct: 100 });
    this.onEvent?.('progress', { phase: 'verify', pct: 100 });
    // fake-but-honest digest: FNV-1a over the image, so it is stable per file
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) { h ^= raw[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    const digest = h.toString(16).padStart(8, '0');
    this.appImages[target] = {
      name, slot: target, offset: part.offset, size: raw.length, source, digest,
      entry: img.entryHex, chip: img.chip, appDesc: img.appDesc, writtenAt: Date.now(),
      seconds: (Date.now() - t0) / 1000,
    };
    this.slot = target;
    this.busy = false;
    this.nvs.set('ota_seq', this.slot === 'ota_0' ? 1 : 2);
    this.bus.emit('log', `Wrote ${raw.length} bytes (${Math.round(raw.length * 0.62)} compressed) at 0x${part.offset.toString(16)} in ${((Date.now() - t0) / 1000).toFixed(2)} seconds`);
    this.bus.emit('log', `Hash of data verified (${digest}).`);
    this.persist();
    this.bus.emit('flashed', this.appImages[target]);
    return { ok: true, parsed: img, image: this.appImages[target] };
  }

  // Roll back to the other OTA slot (what a failed OTA + otadata does).
  switchSlot() {
    const next = this.slot === 'ota_0' ? 'ota_1' : 'ota_0';
    if (!this.appImages[next]) return { ok: false, error: `${next} is empty` };
    this.slot = next;
    this.nvs.set('ota_seq', next === 'ota_0' ? 1 : 2);
    this.persist();
    return { ok: true, slot: next };
  }

  // ---- user programs -----------------------------------------------------
  // A "program" here is a real JS module exporting APP = {id, name, setup, loop}
  // written against the M5Cardputer-style API. It is validated, registered with
  // the runtime, and stored so it survives a reload.
  async installApp(source, meta = {}) {
    const text = String(source || '');
    if (text.length > 512 * 1024) return { ok: false, error: 'program is too large (512 KB max for a JS app)' };
    let mod;
    try {
      const b64 = btoa(unescape(encodeURIComponent(text)));
      mod = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + b64);
    } catch (e) {
      return { ok: false, error: 'syntax/runtime error while loading: ' + e.message };
    }
    const app = mod.APP || mod.default;
    if (!app || typeof app !== 'object') return { ok: false, error: 'program must export APP = { id, name, setup, loop }' };
    if (typeof app.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(app.id)) {
      return { ok: false, error: 'APP.id must be 2–32 chars of [a-z0-9._-]' };
    }
    if (typeof app.loop !== 'function' && typeof app.setup !== 'function') {
      return { ok: false, error: 'APP needs at least one of setup()/loop()' };
    }
    if (this.runtime?.apps?.has(app.id)) {
      const existing = this.runtime.apps.get(app.id);
      if (existing && existing.system) return { ok: false, error: `"${app.id}" is a built-in app — pick another id` };
    }
    const rec = {
      id: app.id, name: app.name || app.id, version: app.version || '1.0.0',
      installed: Date.now(), meta: { ...meta }, source: text,
    };
    this.apps.set(app.id, rec);
    this.runtime?.apps?.set(app.id, app);
    this.persist();
    this.device?.serial(`[I][ota] installed firmware app "${rec.name}" v${rec.version} (${fmtBytes(text.length)})`, 'info');
    this.bus.emit('installed', rec);
    return { ok: true, app: mod.APP || mod.default, record: rec };
  }
  removeApp(id) {
    if (!this.apps.has(id)) return { ok: false, error: 'no such program' };
    this.apps.delete(id);
    this.runtime?.apps?.delete(id);
    this.persist();
    this.bus.emit('removed', id);
    return { ok: true };
  }
  listApps() { return [...this.apps.values()].map(({ source, ...rest }) => rest); }
  exportApp(id) { return this.apps.get(id)?.source || null; }

  // Restore stored programs into the runtime (called once at boot).
  async restoreApps() {
    const out = [];
    for (const rec of this.apps.values()) {
      try { await this.installApp(rec.source, rec.meta); out.push(rec.id); }
      catch (e) { this.device?.serial(`[W][ota] could not restore ${rec.id}: ${e.message}`, 'warn'); }
    }
    return out;
  }
}
