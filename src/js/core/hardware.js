// 1.14" ST7789V2 display model (240x135 RGB565) with an Adafruit-GFX-compatible
// drawing API, plus the 56-key matrix keyboard and its two scan back-ends
// (74HC138 GPIO scan on Cardputer/v1.1, TCA8418 I2C expander on Cardputer-Adv).
import { clamp } from './util.js';
import { glyphBytes, FONT_W, FONT_H } from './font.js';

export function color565(r, g, b) {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}
export function rgb888(c) {
  const r = (c >> 11) & 0x1f, g = (c >> 5) & 0x3f, b = c & 0x1f;
  return [Math.round((r * 255) / 31), Math.round((g * 255) / 63), Math.round((b * 255) / 31)];
}
export const COLORS = {
  BLACK: color565(0, 0, 0), NAVY: color565(0, 0, 128), DARKGREEN: color565(0, 128, 0),
  DARKCYAN: color565(0, 128, 128), MAROON: color565(128, 0, 0), PURPLE: color565(128, 0, 128),
  OLIVE: color565(128, 128, 0), LIGHTGREY: color565(211, 211, 211), DARKGREY: color565(64, 64, 64),
  BLUE: color565(0, 0, 255), GREEN: color565(0, 255, 0), CYAN: color565(0, 255, 255),
  RED: color565(255, 0, 0), MAGENTA: color565(255, 0, 255), YELLOW: color565(255, 255, 0),
  WHITE: color565(255, 255, 255), ORANGE: color565(255, 165, 0), GREENYELLOW: color565(173, 255, 47),
  PINK: color565(255, 192, 203), SKYBLUE: color565(135, 206, 235), DARK: color565(18, 20, 26),
  PANEL: color565(28, 32, 42), GREY: color565(128, 128, 128), TEAL: color565(0, 150, 136),
  AMBER: color565(255, 176, 32), LIME: color565(180, 255, 90),
};

// The GLCD font is 8-bit; map the handful of typographic characters that apps
// use onto glyphs it actually has (0xF8 is a real degree symbol) and degrade
// anything else to '?' rather than painting nonsense.
const XLATE = {
  '°': '\u00F8', '·': '\u00FA', '±': '+', '◀': '<', '▶': '>', '▲': '^', '▼': 'v',
  '❚': '|', '—': '-', '–': '-', '…': '...', '›': '>', '‹': '<', '✓': '*', '✔': '*',
  '␣': '_', '×': 'x', '÷': '/', '≤': '<=', '≥': '>=', 'µ': 'u', 'Ω': 'ohm', '→': '->', '←': '<-',
};
export function xlate(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code === 10 || code === 13 || code === 9 || (code >= 32 && code <= 126)) { out += ch; continue; }
    const rep = XLATE[ch];
    out += rep != null ? rep : '?';
  }
  return out;
}

export class Display {
  constructor(w = 240, h = 135) {
    this.nativeW = w; this.nativeH = h;
    this.w = w; this.h = h;
    this.buf = new Uint16Array(w * h);
    this.rotation = 0;
    this.backlight = 1;        // 0..1 (GPIO38 PWM on ADV, shares rail with RGB LED)
    this.asleep = false;
    this.invert = false;
    this.cursorX = 0; this.cursorY = 0;
    this.textColor = COLORS.WHITE;
    this.textBg = null;
    this.textSize = 1;
    this.wrap = true;
    this.frameCount = 0;
    this.dirty = true;
    this.clipX = 0; this.clipY = 0; this.clipW = w; this.clipH = h;
    this._rect = { x: 0, y: 0, w: 0, h: 0 };
  }
  // --- controller-level state (ST7789 commands) ---
  setRotation(r) {
    this.rotation = ((r % 4) + 4) % 4;
    if (this.rotation % 2 === 1) { this.w = this.nativeH; this.h = this.nativeW; }
    else { this.w = this.nativeW; this.h = this.nativeH; }
    this.setClip(0, 0, this.w, this.h);
  }
  setClip(x, y, w, h) {
    // A clip rect of NaN/±Infinity would silently disable every primitive or make a
    // fuzzed app hang the emulator — fall back to the full panel instead.
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      this.clipX = 0; this.clipY = 0; this.clipW = this.w; this.clipH = this.h;
      return;
    }
    this.clipX = Math.round(x); this.clipY = Math.round(y);
    this.clipW = Math.round(w); this.clipH = Math.round(h);
  }
  // Intersect a rect with the clip window and the panel. Returned size may be 0.
  // The result object is reused, so read the fields before the next drawing call.
  _clampRect(x, y, w, h) {
    const out = this._rect || (this._rect = { x: 0, y: 0, w: 0, h: 0 });
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h))) {
      out.x = 0; out.y = 0; out.w = 0; out.h = 0; return out;
    }
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const cx0 = Math.max(this.clipX, 0), cy0 = Math.max(this.clipY, 0);
    const cx1 = Math.min(this.clipX + this.clipW, this.w), cy1 = Math.min(this.clipY + this.clipH, this.h);
    const x0 = Math.max(x, cx0), y0 = Math.max(y, cy0);
    const x1 = Math.min(x + w, cx1), y1 = Math.min(y + h, cy1);
    out.x = x0; out.y = y0; out.w = x1 > x0 ? x1 - x0 : 0; out.h = y1 > y0 ? y1 - y0 : 0;
    return out;
  }
  clearClip() { this.setClip(0, 0, this.w, this.h); }
  sleep(on) { this.asleep = !!on; this.dirty = true; }
  setBacklight(v) { this.backlight = clamp(v, 0, 1); this.dirty = true; }
  push(count = 1) { this.frameCount += count; this.dirty = true; }

  _xy(x, y) {
    // rotation-aware coordinate mapping into the native landscape buffer
    x |= 0; y |= 0;
    if (this.rotation === 0) return [x, y];
    if (this.rotation === 1) return [y, this.nativeH - 1 - x];
    if (this.rotation === 2) return [this.nativeW - 1 - x, this.nativeH - 1 - y];
    return [this.nativeW - 1 - y, x];
  }
  pixel(x, y, c) {
    if (x < this.clipX || y < this.clipY || x >= this.clipX + this.clipW || y >= this.clipY + this.clipH) return;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [nx, ny] = this._xy(x, y);
    this.buf[ny * this.nativeW + nx] = c & 0xffff;
    this.dirty = true;
  }
  getPixel(x, y) {
    const [nx, ny] = this._xy(x, y);
    if (nx < 0 || ny < 0 || nx >= this.nativeW || ny >= this.nativeH) return 0;
    return this.buf[ny * this.nativeW + nx];
  }
  // Liang–Barsky clip of a segment against the visible window; null if fully outside.
  _clipSegment(x0, y0, x1, y1) {
    const xmin = Math.max(this.clipX, 0), ymin = Math.max(this.clipY, 0);
    const xmax = Math.min(this.clipX + this.clipW, this.w), ymax = Math.min(this.clipY + this.clipH, this.h);
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1;
    const edges = [[-dx, x0 - xmin], [dx, xmax - x0], [-dy, y0 - ymin], [dy, ymax - y0]];
    for (const [p, q] of edges) {
      if (p === 0) { if (q < 0) return null; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
  }
  // --- primitives ---
  fillScreen(c) { this.buf.fill(c & 0xffff); this.dirty = true; this.cursorX = this.cursorY = 0; }
  fillRect(x, y, w, h, c) {
    const r = this._clampRect(x, y, w, h);
    for (let j = r.y; j < r.y + r.h; j++) for (let i = r.x; i < r.x + r.w; i++) this.pixel(i, j, c);
  }
  drawRect(x, y, w, h, c) {
    this.drawFastHLine(x, y, w, c); this.drawFastHLine(x, y + h - 1, w, c);
    this.drawFastVLine(x, y, h, c); this.drawFastVLine(x + w - 1, y, h, c);
  }
  drawFastHLine(x, y, w, c) {
    const r = this._clampRect(x, y, w, 1);
    for (let i = r.x; i < r.x + r.w; i++) this.pixel(i, r.y, c);
  }
  drawFastVLine(x, y, h, c) {
    const r = this._clampRect(x, y, 1, h);
    for (let i = r.y; i < r.y + r.h; i++) this.pixel(r.x, i, c);
  }
  drawLine(x0, y0, x1, y1, c) {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    // Clip to the window before walking pixels: a fuzzed 1e9-pixel line must not hang.
    const seg = this._clipSegment(x0, y0, x1, y1);
    if (!seg) return;
    ({ x0, y0, x1, y1 } = { x0: Math.round(seg[0]), y0: Math.round(seg[1]), x1: Math.round(seg[2]), y1: Math.round(seg[3]) });
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.pixel(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  fillCircle(cx, cy, r, c) {
    if (![cx, cy, r].every(Number.isFinite) || r < 0) return;
    // only sweep the rows that can actually touch the window
    const yTop = Math.max(-r, Math.floor(Math.max(this.clipY, 0) - cy));
    const yBot = Math.min(r, Math.ceil(Math.min(this.clipY + this.clipH, this.h) - cy));
    for (let y = yTop; y <= yBot; y++) {
      const dx = Math.floor(Math.sqrt(r * r - y * y));
      this.drawFastHLine(cx - dx, cy + y, dx * 2 + 1, c);
    }
  }
  drawCircle(cx, cy, r, c) {
    if (![cx, cy, r].every(Number.isFinite) || r < 0) return;
    if (r > 4096) return;                     // far outside any plausible window
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      this.pixel(cx + x, cy + y, c); this.pixel(cx + y, cy + x, c);
      this.pixel(cx - y, cy + x, c); this.pixel(cx - x, cy + y, c);
      this.pixel(cx - x, cy - y, c); this.pixel(cx - y, cy - x, c);
      this.pixel(cx + y, cy - x, c); this.pixel(cx + x, cy - y, c);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }
  fillTriangle(x0, y0, x1, y1, x2, y2, c) {
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = minY; y <= maxY; y++) {
      let lo = Infinity, hi = -Infinity;
      const edges = [[x0, y0, x1, y1], [x1, y1, x2, y2], [x2, y2, x0, y0]];
      for (const [ax, ay, bx, by] of edges) {
        if (ay === by) { if (y === ay) { lo = Math.min(lo, ax, bx); hi = Math.max(hi, ax, bx); } continue; }
        const t = (y - ay) / (by - ay);
        if (t < 0 || t > 1) continue;
        const x = ax + (bx - ax) * t;
        lo = Math.min(lo, x); hi = Math.max(hi, x);
      }
      if (lo <= hi) this.drawFastHLine(Math.round(lo), y, Math.round(hi - lo) + 1, c);
    }
  }
  fillRoundRect(x, y, w, h, r, c) {
    r = Math.min(r, Math.floor(Math.min(w, h) / 2));
    this.fillRect(x + r, y, w - 2 * r, h, c);
    this.fillRect(x, y + r, r, h - 2 * r, c);
    this.fillRect(x + w - r, y + r, r, h - 2 * r, c);
    this.fillCircle(x + r, y + r, r, c); this.fillCircle(x + w - r - 1, y + r, r, c);
    this.fillCircle(x + r, y + h - r - 1, r, c); this.fillCircle(x + w - r - 1, y + h - r - 1, r, c);
  }
  drawRoundRect(x, y, w, h, r, c) {
    this.drawLine(x + r, y, x + w - r, y, c); this.drawLine(x + r, y + h - 1, x + w - r, y + h - 1, c);
    this.drawLine(x, y + r, x, y + h - r, c); this.drawLine(x + w - 1, y + r, x + w - 1, y + h - r, c);
    const q = [[x + r, y + r, 2], [x + w - r - 1, y + r, 3], [x + r, y + h - r - 1, 1], [x + w - r - 1, y + h - r - 1, 0]];
    for (const [cx, cy, qd] of q) {
      let px = 0, py = r, d = 3 - 2 * r;
      while (px <= py) {
        const pts = [[px, py], [py, px]];
        for (const [a, b] of pts) {
          const sx = qd === 1 || qd === 2 ? -1 : 1;
          const sy = qd === 0 || qd === 1 ? -1 : 1;
          this.pixel(cx + a * sx, cy + b * sy, c);
          this.pixel(cx + b * sx, cy + a * sy, c);
        }
        if (d < 0) d += 4 * px + 6; else { d += 4 * (px - py) + 10; py--; }
        px++;
      }
    }
  }
  // --- text ---
  setTextColor(fg, bg = null) { this.textColor = fg; this.textBg = bg; }
  setTextSize(s) { this.textSize = clamp(s | 0 || 1, 1, 8); }
  setCursor(x, y) { this.cursorX = x; this.cursorY = y; }
  setTextWrap(v) { this.wrap = !!v; }
  drawChar(x, y, code, color = this.textColor, bg = this.textBg, size = this.textSize) {
    if (![x, y].every(Number.isFinite)) return 0;
    // TFT_eSPI allows 1..7; clamping also stops a fuzzed size from exploding the loop
    size = Math.max(1, Math.min(8, Math.round(Number.isFinite(size) ? size : 1)));
    const b = glyphBytes(code);
    for (let col = 0; col < FONT_W; col++) {
      for (let row = 0; row < FONT_H + 1; row++) {
        const on = row < FONT_H ? (b[col] >> row) & 1 : 0;
        if (on) this.fillRect(x + col * size, y + row * size, size, size, color);
        else if (bg !== null) this.fillRect(x + col * size, y + row * size, size, size, bg);
      }
    }
    return (FONT_W + 1) * size;
  }
  drawString(x, y, str, color = this.textColor, size = this.textSize) {
    let cx = Math.round(x);
    for (const ch of xlate(str)) {
      const code = ch.codePointAt(0);
      this.drawChar(cx, Math.round(y), code, color, null, size);
      cx += (FONT_W + 1) * size;
    }
    return cx;
  }
  print(s) {
    for (const ch of xlate(s)) {
      if (ch === '\n') { this.cursorX = 0; this.cursorY += (FONT_H + 1) * this.textSize; continue; }
      if (ch === '\r') { this.cursorX = 0; continue; }
      if (this.wrap && this.cursorX + (FONT_W + 1) * this.textSize > this.w) {
        this.cursorX = 0; this.cursorY += (FONT_H + 1) * this.textSize;
      }
      if (this.textBg !== null) this.fillRect(this.cursorX, this.cursorY, (FONT_W + 1) * this.textSize, (FONT_H + 1) * this.textSize, this.textBg);
      this.drawChar(this.cursorX, this.cursorY, ch.codePointAt(0), this.textColor, this.textBg, this.textSize);
      this.cursorX += (FONT_W + 1) * this.textSize;
    }
  }
  println(s = '') { this.print(s + '\n'); }
  textWidth(str, size = this.textSize) { return String(str).length * (FONT_W + 1) * size; }
  textHeight(size = this.textSize) { return (FONT_H + 1) * size; }
  drawCentreString(str, cx, y, color, size = this.textSize) { this.drawString(cx - this.textWidth(str, size) / 2, y, str, color, size); }
  drawRightString(str, rx, y, color, size = this.textSize) { this.drawString(rx - this.textWidth(str, size), y, str, color, size); }
  // --- image / scroll ---
  // TFT_eSPI pushImage(): blit a w*h RGB565 buffer. Pass `trans` to skip a colour key
  // (TFT_eSPI's transparent-colour overload). Out-of-bounds pixels are clipped.
  pushImage(x, y, w, h, data, trans) {
    const key = trans == null ? null : trans;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || !data) return 0;
    if (w * h > 240 * 240) return 0;          // refuse absurd blits instead of hanging
    let drawn = 0;
    w = Math.round(w); h = Math.round(h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = data[j * w + i];
        if (key != null && v === key) continue;
        if (x + i < 0 || y + j < 0 || x + i >= this.w || y + j >= this.h) continue;
        this.pixel(x + i, y + j, v); drawn++;
      }
    }
    return drawn;
  }
  scroll(dy) {
    if (!Number.isFinite(dy)) return;
    dy = Math.trunc(dy);
    if (Math.abs(dy) >= this.nativeH) { this.fillScreen(COLORS.BLACK); return; }
    const nw = this.nativeW;
    if (dy > 0) this.buf.copyWithin(0, dy * nw); else if (dy < 0) this.buf.copyWithin(-dy * nw, 0);
    const from = dy > 0 ? (this.nativeH - dy) * nw : 0;
    const n = Math.min(Math.abs(dy), this.nativeH) * nw;
    this.buf.fill(COLORS.BLACK, from, from + n);
    this.dirty = true;
  }
  // Copy the RGB565 buffer into a Uint8ClampedArray (RGBA) for canvas blitting.
  toRGBA(out) {
    const n = this.buf.length;
    out = out || new Uint8ClampedArray(n * 4);
    const bl = this.asleep ? 0 : this.backlight;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      let c = this.buf[i];
      if (this.invert) c = ~c & 0xffff;
      const r = ((c >> 11) & 0x1f) * 255 / 31;
      const g = ((c >> 5) & 0x3f) * 255 / 63;
      const b = (c & 0x1f) * 255 / 31;
      out[o] = r * bl; out[o + 1] = g * bl; out[o + 2] = b * bl; out[o + 3] = 255;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Keyboard: 4 rows x 14 columns = 56 keys (K132 layout)
// Every key has a base legend, a shift legend and an Fn-layer function.
// ---------------------------------------------------------------------------
const K = (id, base, shift, fn) => ({ id, base, shift: shift ?? base, fn: fn ?? null });

export const KEY_ROWS = [
  [K('`', '`', '~', 'ESC'), K('1', '1', '!', 'F1'), K('2', '2', '@', 'F2'), K('3', '3', '#', 'F3'),
   K('4', '4', '$', 'F4'), K('5', '5', '%', 'F5'), K('6', '6', '^', 'F6'), K('7', '7', '&', 'F7'),
   K('8', '8', '*', 'F8'), K('9', '9', '(', 'F9'), K('0', '0', ')', 'F10'), K('-', '-', '_', 'BRI-'),
   K('=', '=', '+', 'BRI+'), K('backspace', 'DEL', 'DEL', 'DELETE')],
  [K('tab', 'TAB', 'TAB', null), K('q', 'q', 'Q'), K('w', 'w', 'W'), K('e', 'e', 'E'), K('r', 'r', 'R'),
   K('t', 't', 'T'), K('y', 'y', 'Y'), K('u', 'u', 'U'), K('i', 'i', 'I'), K('o', 'o', 'O'),
   K('p', 'p', 'P'), K('[', '[', '{', 'PREV'), K(']', ']', '}', 'NEXT'), K('\\', '\\', '|', 'MUTE')],
  [K('fn', 'fn', 'fn', null), K('shift', 'SHIFT', 'SHIFT', null), K('a', 'a', 'A'), K('s', 's', 'S'),
   K('d', 'd', 'D'), K('f', 'f', 'F'), K('g', 'g', 'G'), K('h', 'h', 'H'), K('j', 'j', 'J'),
   K('k', 'k', 'K'), K('l', 'l', 'L'), K(';', ';', ':', 'UP'), K("'", "'", '"', 'DOWN'), K('enter', 'ENTER', 'ENTER', null)],
  [K('ctrl', 'CTRL', 'CTRL', null), K('opt', 'OPT', 'OPT', null), K('alt', 'ALT', 'ALT', null),
   K('z', 'z', 'Z'), K('x', 'x', 'X'), K('c', 'c', 'C'), K('v', 'v', 'V'), K('b', 'b', 'B'),
   K('n', 'n', 'N'), K('m', 'm', 'M'), K(',', ',', '<', 'LEFT'), K('.', '.', '>', 'DOWN'),
   K('/', '/', '?', 'RIGHT'), K('space', ' ', ' ', 'HOME')],
];
export const KEY_BY_ID = new Map();
KEY_ROWS.forEach((row, r) => row.forEach((k, c) => KEY_BY_ID.set(k.id, { ...k, row: r, col: c })));

const MODIFIERS = new Set(['fn', 'shift', 'ctrl', 'opt', 'alt']);

export class Keyboard {
  constructor({ scanMode = 'gpio' } = {}) {
    this.rows = 4; this.cols = 14;
    this.matrix = new Uint8Array(this.rows * this.cols);
    this.scanMode = scanMode;       // 'gpio' (74HC138) | 'tca8418' (I2C expander)
    this.events = [];               // {type:'down'|'up', id, row, col, fn, shift, t}
    this.fifo = [];                 // TCA8418-style 10-entry event FIFO (with overflow)
    this.overflow = 0;
    this.repeatDelay = 400; this.repeatRate = 60;
    const held = new Map();
    this.held = held;               // id -> {since, lastRepeat}
    this.int = false;               // INT line to GPIO11 (ADV)
    this.enabled = true;
    this.charQueue = [];
    this.lastScan = 0;
  }
  idx(row, col) { return row * this.cols + col; }
  isDown(id) { const k = KEY_BY_ID.get(id); return !!k && this.matrix[this.idx(k.row, k.col)] === 1; }
  down(id, t = 0) {
    const k = KEY_BY_ID.get(id);
    if (!k) return false;
    const i = this.idx(k.row, k.col);
    if (this.matrix[i]) return false;
    this.matrix[i] = 1;
    this.held.set(id, { since: t, lastRepeat: t });
    this._pushEvent('down', k, t);
    return true;
  }
  up(id, t = 0) {
    const k = KEY_BY_ID.get(id);
    if (!k) return false;
    const i = this.idx(k.row, k.col);
    if (!this.matrix[i]) return false;
    this.matrix[i] = 0;
    this.held.delete(id);
    this._pushEvent('up', k, t);
    return true;
  }
  releaseAll() { for (const id of [...this.held.keys()]) this.up(id); }
  _pushEvent(type, k, t) {
    const ev = { type, id: k.id, row: k.row, col: k.col, t };
    this.events.push(ev);
    if (this.events.length > 64) this.events.shift();
    // TCA8418 emulation: 10-deep key event FIFO, INT asserted while non-empty
    if (this.scanMode === 'tca8418') {
      if (this.fifo.length >= 10) { this.overflow++; }
      else {
        const code = (type === 'down' ? 1 : 2) << 7 | (k.row < 8 ? k.row + 1 : k.row + 1) << 4 | (k.col + 1);
        this.fifo.push({ code, id: k.id, type });
      }
      this.int = this.fifo.length > 0;
    }
  }
  // TCA8418 register access used by Cardputer-Adv driver demos
  tcaReadReg(reg) {
    if (reg === 0x03) return this.fifo.length ? this.fifo[0].code & 0xff : 0;         // KEY_EVENT_A
    if (reg === 0x04) return this.fifo.length ? (this.fifo[0].code >> 8) & 0xff : 0;
    if (reg === 0x02) return (this.fifo.length << 0);                                // KEY_LCK_EC count
    if (reg === 0x01) return 0;                                                      // KEY_INT_STAT
    return 0;
  }
  tcaWriteReg(reg, v) {
    if (reg === 0x03) { this.fifo.shift(); this.int = this.fifo.length > 0; }
  }
  modifiers() {
    return { fn: this.isDown('fn'), shift: this.isDown('shift'), ctrl: this.isDown('ctrl'), opt: this.isDown('opt'), alt: this.isDown('alt') };
  }
  _legendFor(k, shift) { return shift ? k.shift : k.base; }
  // Translate matrix state -> keyState struct compatible with M5Cardputer.
  keyState() {
    const m = this.modifiers();
    const word = [];
    const fnKeys = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (!this.matrix[this.idx(r, c)]) continue;
        const k = KEY_ROWS[r][c];
        if (MODIFIERS.has(k.id)) continue;
        if (m.fn && k.fn) { fnKeys.push(k.fn); continue; }
        if (k.id === 'space') { word.push(' '); continue; }
        if (k.id === 'enter' || k.id === 'tab' || k.id === 'backspace') continue;
        word.push(this._legendFor(k, m.shift));
      }
    }
    return {
      ...m, word, fnKeys,
      del: this.isDown('backspace'), enter: this.isDown('enter'), tab: this.isDown('tab'), space: this.isDown('space'),
      esc: m.fn && this.isDown('`'),
      arrows: { up: m.fn && this.isDown(';'), down: m.fn && (this.isDown('.') || this.isDown("'")), left: m.fn && this.isDown(','), right: m.fn && this.isDown('/') },
      ctrl: m.ctrl, opt: m.opt,
    };
  }
  // Auto-repeat while a key is held. Events stay in the queue until the runtime
  // drains them with takeEvents() — otherwise firmware would never see input.
  tick(t) {
    for (const [id, st] of this.held) {
      if (t - st.since > this.repeatDelay && t - st.lastRepeat > this.repeatRate) {
        st.lastRepeat = t;
        this._pushEvent('down', KEY_BY_ID.get(id), t);
      }
    }
  }
  // Decode key-down events into the character stream the firmware reads.
  _emitChars(events) {
    for (const ev of events) {
      if (ev.type !== 'down' || ev._charsDone) continue;
      ev._charsDone = true;
      const k = KEY_ROWS[ev.row][ev.col];
      if (MODIFIERS.has(k.id)) continue;
      const m = this.modifiers();
      if (m.fn && k.fn) continue;                    // Fn layer: function, not a character
      let ch = this._legendFor(k, m.shift);
      if (k.id === 'enter') ch = '\n';
      if (k.id === 'tab') ch = '\t';
      if (k.id === 'backspace') ch = '\b';
      if (k.id === 'space') ch = ' ';
      this.charQueue.push(ch);
      if (this.charQueue.length > 128) this.charQueue.shift();
    }
  }
  // Drain the key-event queue. Chars are derived here, so a firmware that only calls
  // takeEvents() still gets the M5Cardputer print stream.
  takeEvents() { const e = this.events; this.events = []; this._emitChars(e); return e; }
  // Characters produced since last call (handles shift + fn layers).
  takeChars() {
    if (this.events.length) this._emitChars(this.events);
    const c = this.charQueue;
    this.charQueue = [];
    return c;
  }
}
