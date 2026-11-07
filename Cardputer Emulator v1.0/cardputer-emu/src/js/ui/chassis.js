// =============================================================================
//  Chassis UI: renders the 240x135 LCD, the 56-key keyboard, the hardware
//  switches/ports, and wires host input + WebAudio to the device model.
// =============================================================================
import { KEY_ROWS } from '../core/hardware.js';
import { clamp } from '../core/util.js';

// ------------------------------------------------------------- audio out ----
export class AudioOut {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
    this.micStream = null;
    this.micAnalyser = null;
    this.micBuf = null;
  }
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }
  tone({ freq, ms, wave = 'square', vol = 0.5, audible = true }) {
    if (!audible || !this.enabled) return;
    const ctx = this.ensure(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = wave === 'sawtooth' ? 'sawtooth' : wave === 'sine' ? 'sine' : wave === 'triangle' ? 'triangle' : 'square';
    osc.frequency.value = clamp(freq, 30, 12000);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(clamp(vol, 0, 1) * 0.18, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + Math.max(0.03, ms / 1000));
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + Math.max(0.04, ms / 1000) + 0.02);
  }
  click(strength = 1) {
    if (!this.enabled) return;
    const ctx = this.ensure(); if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * 0.02);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) * 0.35 * strength;
    const src = ctx.createBufferSource();
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.buffer = buf; src.connect(g).connect(this.master); src.start();
  }
  async enableMic(device) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = this.ensure();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.micStream = stream; this.micAnalyser = an;
      this.micBuf = new Float32Array(an.fftSize);
      device.mic.jackSource = () => {
        an.getFloatTimeDomainData(this.micBuf);
        let peak = 0;
        for (const v of this.micBuf) peak = Math.max(peak, Math.abs(v));
        return peak;
      };
      return true;
    } catch (e) {
      return false;
    }
  }
}

// ------------------------------------------------------------- LCD view -----
export class ScreenView {
  constructor(canvas, device, dimEl = null) {
    this.canvas = canvas;
    this.device = device;
    this.dimEl = dimEl;
    this.ctx = canvas.getContext('2d', { alpha: false });
    const W = device.display.nativeW, H = device.display.nativeH;
    canvas.width = W; canvas.height = H;
    this.img = this.ctx.createImageData(W, H);
    this.rgba = new Uint8ClampedArray(W * H * 4);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, W, H);
  }
  render() {
    const d = this.device.display;
    const rgba = d.toRGBA(this.rgba);
    this.img.data.set(rgba);
    this.ctx.putImageData(this.img, 0, 0);
    d.frameCount++;                       // frames actually scanned out to the panel
    d.dirty = false;
    // Backlight/sleep are physical: dim with a black overlay so the pixel grid
    // stays perfectly crisp (a CSS filter would resample the canvas).
    const bl = d.asleep ? 0 : clamp(d.backlight, 0, 1);
    if (this.dimEl) this.dimEl.style.opacity = String(1 - bl * 0.94);
  }
}

// ------------------------------------------------------------ key mapping ---
// host key -> device key id (+ whether Shift must be held)
const HOST_MAP = {
  Backquote: ['`', false], Digit1: ['1', false], Digit2: ['2', false], Digit3: ['3', false], Digit4: ['4', false],
  Digit5: ['5', false], Digit6: ['6', false], Digit7: ['7', false], Digit8: ['8', false], Digit9: ['9', false],
  Digit0: ['0', false], Minus: ['-', false], Equal: ['=', false], Backspace: ['backspace', false],
  Tab: ['tab', false], KeyQ: ['q', false], KeyW: ['w', false], KeyE: ['e', false], KeyR: ['r', false], KeyT: ['t', false],
  KeyY: ['y', false], KeyU: ['u', false], KeyI: ['i', false], KeyO: ['o', false], KeyP: ['p', false],
  BracketLeft: ['[', false], BracketRight: [']', false], Backslash: ['\\', false],
  KeyA: ['a', false], KeyS: ['s', false], KeyD: ['d', false], KeyF: ['f', false], KeyG: ['g', false], KeyH: ['h', false],
  KeyJ: ['j', false], KeyK: ['k', false], KeyL: ['l', false], Semicolon: [';', false], Quote: ["'", false], Enter: ['enter', false],
  KeyZ: ['z', false], KeyX: ['x', false], KeyC: ['c', false], KeyV: ['v', false], KeyB: ['b', false], KeyN: ['n', false],
  KeyM: ['m', false], Comma: [',', false], Period: ['.', false], Slash: ['/', false], Space: ['space', false],
};
// shifted symbols are produced by Shift + the unshifted key
const SHIFT_OF = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
// host arrows / esc map onto the Cardputer Fn layer
const FN_LAYER = { ArrowUp: ';', ArrowDown: '.', ArrowLeft: ',', ArrowRight: '/', Escape: '`' };

export class KeyboardView {
  /** @param {{onAction?: (type: string, id: string) => void}} [__opts] */
  constructor(root, device, __opts = {}) {
    const { onAction } = /** @type {{onAction?: (type: string, id: string) => void}} */ (__opts);
    this.root = root;
    this.device = device;
    this.keys = new Map();
    this.onAction = onAction || (() => { });
    this.fnLatch = false;
    this.build();
    this.bindHost();
  }
  build() {
    this.root.innerHTML = '';
    this.root.style.setProperty('--cols', '14');
    KEY_ROWS.forEach((row, r) => {
      row.forEach((k, c) => {
        const el = document.createElement('button');
        el.className = 'key';
        el.type = 'button';
        el.dataset.id = k.id;
        el.style.gridRow = String(r + 1);
        el.style.gridColumn = String(c + 1);
        const wide = ['backspace', 'enter', 'space', 'tab', 'shift', 'fn'].includes(k.id);
        if (wide) el.classList.add('key-wide');
        if (['fn', 'shift', 'ctrl', 'opt', 'alt'].includes(k.id)) el.classList.add('key-mod');
        const legend = k.base === ' ' ? '␣' : k.base.length > 1 ? k.base : k.base.toUpperCase();
        el.innerHTML = `<span class="legend">${legend}</span>${k.fn ? `<span class="fnlabel">${k.fn}</span>` : ''}`;
        const press = (ev) => {
          ev.preventDefault();
          if (!this.device.keyboard.isDown(k.id)) {
            this.device.keyboard.down(k.id, this.device.uptime * 1000);
            el.classList.add('down');
            this.onAction('keydown', k.id);
          }
        };
        const release = () => {
          if (this.device.keyboard.isDown(k.id)) {
            this.device.keyboard.up(k.id, this.device.uptime * 1000);
            el.classList.remove('down');
          }
        };
        el.addEventListener('pointerdown', press);
        el.addEventListener('pointerup', release);
        el.addEventListener('pointerleave', release);
        el.addEventListener('pointercancel', release);
        this.keys.set(k.id, el);
        this.root.appendChild(el);
      });
    });
    this.sync();
  }
  sync() {
    for (const [id, el] of this.keys) {
      const down = this.device.keyboard.isDown(id);
      el.classList.toggle('down', down);
    }
  }
  bindHost() {
    window.addEventListener('keydown', e => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      if (tgt && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tgt.tagName)) return;
      if (e.metaKey || (e.ctrlKey && e.code === 'KeyR')) return;    // let browser shortcuts through
      const mods = { Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'opt', CapsLock: 'fn' };
      if (mods[e.key]) {
        e.preventDefault();
        this.hit(mods[e.key], true);
        return;
      }
      let target = HOST_MAP[e.code];
      let shift = e.shiftKey;
      if (!target && SHIFT_OF[e.key]) { target = [SHIFT_OF[e.key], false]; shift = true; }
      if (!target && FN_LAYER[e.code]) {
        e.preventDefault();
        if (e.repeat) return;
        this.combo(['fn', FN_LAYER[e.code]]);
        return;
      }
      if (!target) return;
      e.preventDefault();
      if (e.repeat) return;
      if (shift) this.hit('shift', true);
      this.hit(target[0], true);
      if (shift) setTimeout(() => this.hit('shift', false), 12);
    });
    window.addEventListener('keyup', e => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      if (tgt && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tgt.tagName)) return;
      const mods = { Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'opt', CapsLock: 'fn' };
      if (mods[e.key]) { this.hit(mods[e.key], false); return; }
      const target = HOST_MAP[e.code];
      if (target && !FN_LAYER[e.code]) this.hit(target[0], false);
      else if (FN_LAYER[e.code]) { for (const id of ['fn', FN_LAYER[e.code]]) this.hit(id, false); }
      else if (SHIFT_OF[e.key]) this.hit(SHIFT_OF[e.key], false);
    });
    window.addEventListener('blur', () => this.device.keyboard.releaseAll());
  }
  hit(id, down) {
    const d = this.device;
    if (down) {
      if (d.keyboard.isDown(id)) return;
      d.keyboard.down(id, d.uptime * 1000);
    } else d.keyboard.up(id, d.uptime * 1000);
    this.keys.get(id)?.classList.toggle('down', down);
  }
  // press a chord like ['fn', ';'] and auto-release it after ~90 ms
  combo(ids, ms = 90) {
    for (const id of ids) this.hit(id, true);
    this.onAction('keydown', ids[ids.length - 1]);
    setTimeout(() => { for (const id of ids) this.hit(id, false); }, ms);
  }
}

// ---------------------------------------------------------------- chassis ---
export class Chassis {
  constructor(root, device, audio) {
    /** @type {null | ((action: string) => void)} */
    this.onRail = null;
    this.root = root;
    this.device = device;
    this.audio = audio;
    this.screen = null;
    this.kbv = null;
    this.build();
  }
  build() {
    this.root.innerHTML = `
      <div class="device-shell">
        <div class="device-body">
          <div class="device-topline">
            <div class="brand-mini">M5Stack <b>Cardputer</b></div>
            <div class="led-strip" id="ledStrip" title="SK6812 RGB LED"></div>
            <div class="ir-window" id="irWindow" title="IR emitter (GPIO44)"></div>
          </div>
          <div class="screen-bezel">
            <div class="screen-inner">
              <canvas id="lcd" width="240" height="135"></canvas>
              <div class="lcd-dim" id="lcdDim"></div>
              <div class="lcd-glare"></div>
              <div class="lcd-scanlines"></div>
            </div>
          </div>
          <div class="deck">
            <div class="grille" id="grille" title="1 W speaker"></div>
            <div class="mic-hole" title="MEMS microphone"></div>
            <div class="deck-labels"><span id="skuLabel">K132-Adv</span><span id="fwLabel">CardputerOS</span></div>
          </div>
          <div class="keyboard" id="keyboard"></div>
        </div>
        <div class="device-rail">
          <button class="rail-btn" id="btnPower" title="Power switch"><span class="ico">⏻</span><span>PWR</span></button>
          <button class="rail-btn" id="btnRst" title="Reset"><span class="ico">⟲</span><span>RST</span></button>
          <button class="rail-btn" id="btnBoot" title="Hold G0 at boot for download mode"><span class="ico">◉</span><span>G0</span></button>
          <button class="rail-btn" id="btnUsb" title="USB-C: serial/JTAG + charging"><span class="ico">⏺</span><span>USB-C</span></button>
          <button class="rail-btn" id="btnSd" title="microSD slot"><span class="ico">▤</span><span>SD</span></button>
          <button class="rail-btn" id="btnJack" title="3.5 mm audio jack (ADV only)"><span class="ico">◎</span><span>3.5mm</span></button>
          <button class="rail-btn" id="btnGrove" title="HY2.0-4P Grove port"><span class="ico">⌗</span><span>Grove</span></button>
        </div>
      </div>
      <div class="chassis-foot">
        <div class="tilt-wrap">
          <div class="tilt-pad" id="tiltPad" title="Tilt the Cardputer (BMI270)">
            <div class="tilt-knob" id="tiltKnob"></div>
            <span class="tilt-label">TILT</span>
          </div>
          <div class="tilt-read" id="tiltRead">x 0.00<br>y 0.00</div>
        </div>
        <div class="hintlist">
          <div><kbd>Esc</kbd> = Fn+<kbd>\`</kbd> (back)</div>
          <div><kbd>↑↓←→</kbd> = Fn+<kbd>; . , /</kbd></div>
          <div><kbd>CapsLock</kbd> = hold <b>Fn</b> layer</div>
          <div>Click any key on the deck — it drives the same matrix.</div>
        </div>
      </div>`;
    this.screen = new ScreenView(this.root.querySelector('#lcd'), this.device, this.root.querySelector('#lcdDim'));
    this.kbv = new KeyboardView(this.root.querySelector('#keyboard'), this.device, {
      onAction: (type, id) => { if (type === 'keydown') this.audio.click(0.8); },
    });
    this.wireRail();
    this.wireTilt();
    this.refresh();
  }
  wireRail() {
    const q = id => this.root.querySelector('#' + id);
    // One physical press = one onRail(action). The visual feedback (click tick,
    // refresh, 160 ms strike) happens locally and never re-enters the dispatcher.
    const action = (el, label) => {
      if (!el) return;
      el.addEventListener('click', () => {
        this.audio.click(1.2);
        el.classList.add('strike');
        setTimeout(() => el.classList.remove('strike'), 160);
        this.onRail?.(label);
        this.refresh();
      });
    };
    action(q('btnPower'), 'power');
    action(q('btnRst'), 'reset');
    action(q('btnBoot'), 'boot');
    action(q('btnUsb'), 'usb');
    action(q('btnSd'), 'sd');
    action(q('btnJack'), 'jack');
    action(q('btnGrove'), 'grove');
    q('irWindow')?.addEventListener('click', () => { this.device.ir.sendNec(0x00, 0x45); this.flashIr(); });
  }
  wireTilt() {
    const pad = this.root.querySelector('#tiltPad');
    const knob = this.root.querySelector('#tiltKnob');
    const read = this.root.querySelector('#tiltRead');
    let dragging = false;
    const move = ev => {
      if (!dragging) return;
      const r = pad.getBoundingClientRect();
      const x = clamp(((ev.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      const y = clamp(((ev.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      this.device.imu.setTilt(x, y);
      this.updateTiltVisual();
    };
    pad.addEventListener('pointerdown', ev => { dragging = true; pad.setPointerCapture(ev.pointerId); move(ev); });
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', () => { dragging = false; });
    pad.addEventListener('dblclick', () => { this.device.imu.setTilt(0, 0); this.updateTiltVisual(); });
    this._tiltRead = read; this._knob = knob;
    this.updateTiltVisual();
  }
  updateTiltVisual() {
    const t = this.device.imu.tilt;
    if (this._knob) this._knob.style.transform = `translate(${t.x * 26}px, ${t.y * 26}px)`;
    if (this._tiltRead) {
      const a = this.device.imu.getAccel();
      this._tiltRead.innerHTML = a ? `x ${a.x.toFixed(2)}<br>y ${a.y.toFixed(2)}` : 'no IMU';
    }
  }
  flashIr() {
    const el = this.root.querySelector('#irWindow');
    el?.classList.add('blast');
    setTimeout(() => el?.classList.remove('blast'), 220);
  }
  refresh() {
    const d = this.device;
    this.root.querySelector('#skuLabel').textContent = d.variant.sku;
    this.root.querySelector('#fwLabel').textContent = `CardputerOS · emu`;
    const usb = this.root.querySelector('#btnUsb');
    usb.classList.toggle('on', d.usbConnected);
    const sd = this.root.querySelector('#btnSd');
    sd.classList.toggle('on', d.sd.inserted);
    const jack = this.root.querySelector('#btnJack');
    jack.classList.toggle('on', d.audioJack);
    jack.disabled = !d.variant.jack;
    const pwr = this.root.querySelector('#btnPower');
    pwr.classList.toggle('on', d.power.switchOn);
    const led = this.root.querySelector('#ledStrip');
    if (led) {
      const { r, g, b } = d.led;
      led.style.background = `rgb(${r},${g},${b})`;
      led.style.boxShadow = `0 0 ${6 + (r + g + b) / 30}px rgb(${r},${g},${b})`;
    }
    this.root.querySelector('.device-body').dataset.variant = d.variantId;
    this.root.querySelector('.device-body').classList.toggle('powered', d.mode !== 'off');
  }
  tick() {
    this.screen.render();
    this.kbv.sync();
    if (this.device.imu.present && this.device.imu.tilt.x === 0 && this.device.imu.tilt.y === 0 && Math.random() < 0.01) this.updateTiltVisual();
  }
}
