// Small shared helpers. No DOM access here so the core is headless-testable.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const hex = (n, w = 2) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

// Deterministic-ish RNG (mulberry32) so simulations are reproducible in tests.
export function makeRng(seed = 0x1a2b3c4d) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._h.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    const s = this._h.get(evt);
    if (s) for (const fn of [...s]) { try { fn(...args); } catch (e) { console.error('[emitter]', evt, e); } }
    const any = this._h.get('*');
    if (any) for (const fn of [...any]) { try { fn(evt, ...args); } catch (e) { console.error(e); } }
  }
}

// --- semver ---------------------------------------------------------------
export function parseVersion(v) {
  const m = String(v || '0.0.0').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' } : { major: 0, minor: 0, patch: 0, pre: '' };
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;      // release > prerelease
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

export function pad(s, n, c = ' ') { s = String(s); return s.length >= n ? s : s + c.repeat(n - s.length); }
export function padStart(s, n, c = ' ') { s = String(s); return s.length >= n ? s : c.repeat(n - s.length) + s; }

export function crc8(bytes, poly = 0x31, init = 0xff) {
  let crc = init;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function bytesToHex(arr) {
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join(' ');
}

export function nowStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
