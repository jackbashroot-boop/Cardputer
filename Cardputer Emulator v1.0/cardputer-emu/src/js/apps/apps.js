// =============================================================================
//  Firmware apps. Each one is a tiny Arduino-style program: setup() + loop().
//  They draw straight into the emulated ST7789 framebuffer and read the
//  emulated keyboard / modules, exactly like firmware on real hardware.
// =============================================================================
import { clamp } from '../core/util.js';

const hex2 = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(2, '0');

// ----------------------------------------------------------------- launcher --
const launcher = {
  id: 'launcher', name: 'CardputerOS', short: 'Home', icon: 'OS', color: '#60a5fa', system: true, version: '1.0.0',
  about: 'Home screen. Arrow keys (Fn + ; . , /) to move, ENTER to launch, Fn+` to go back.',
  setup(api) {
    this.sel = 0; this.page = 0;
    this.apps = api.apps.list().filter(a => !a.system);
    this.t0 = 0;
  },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS;
    if (!this.apps || this.apps.length !== api.apps.list().filter(a => !a.system).length) this.setup(api);
    const inp = api.input();
    const cols = 3, rows = 4, perPage = cols * rows;
    const pages = Math.max(1, Math.ceil(this.apps.length / perPage));
    if (inp.right) this.sel = (this.sel + 1) % this.apps.length;
    if (inp.left) this.sel = (this.sel + this.apps.length - 1) % this.apps.length;
    if (inp.down) this.sel = (this.sel + cols) % this.apps.length;
    if (inp.up) this.sel = (this.sel + this.apps.length - cols) % this.apps.length;
    this.page = Math.floor(this.sel / perPage);
    if (inp.enter) { const a = this.apps[this.sel]; api.M5.Speaker.tone(1200, 24, 'square', 0.12); return api.apps.launch(a.id); }

    L.fillScreen(api.color565(6, 8, 12));
    // top bar
    L.fillRect(0, 0, 240, 12, api.color565(26, 32, 44));
    L.drawString(4, 3, 'CardputerOS', K.WHITE, 1);
    L.drawRightString(`v${api.version}`, 236, 3, api.color565(120, 130, 150), 1);
    const pct = api.power.percent();
    L.drawRightString(`${pct}%${api.power.charging() ? '+' : ''}`, 196, 3, pct < 20 ? K.RED : K.GREEN, 1);
    // module + wifi indicators
    const mods = api.modules.list().length;
    L.drawString(150, 3, `${mods}mod`, mods ? K.CYAN : api.color565(90, 96, 110), 1);

    const start = this.page * perPage;
    for (let i = 0; i < perPage; i++) {
      const app = this.apps[start + i];
      if (!app) break;
      const cx = 3 + (i % cols) * 79, cy = 15 + Math.floor(i / cols) * 23;
      const selected = start + i === this.sel;
      const accent = hexColor(app.color || '#64748b');
      L.fillRoundRect(cx, cy, 76, 21, 3, selected ? api.color565(48, 56, 72) : api.color565(24, 29, 38));
      if (selected) L.drawRoundRect(cx, cy, 76, 21, 3, K.AMBER);
      L.fillRoundRect(cx + 2, cy + 3, 15, 15, 3, accent);
      L.drawString(cx + 5, cy + 7, app.icon.slice(0, 2), api.color565(9, 11, 16), 1);
      L.drawString(cx + 21, cy + 3, (app.short || app.name).slice(0, 9), selected ? K.AMBER : api.color565(244, 248, 255), 1);
      L.drawString(cx + 21, cy + 12, (app.category || '').slice(0, 9), api.color565(138, 150, 170), 1);
    }
    // page dots
    for (let pg = 0; pg < pages; pg++) L.fillCircle(112 + pg * 10, 112 + (pages > 1 ? 0 : 0), 2, pg === this.page ? K.AMBER : api.color565(60, 68, 84));
    // bottom bar
    L.fillRect(0, 124, 240, 11, api.color565(26, 32, 44));
    L.drawString(4, 126, `${this.sel + 1}/${this.apps.length}  ${this.apps[this.sel]?.name || ''}`, K.LIGHTGREY, 1);
    L.drawRightString(`page ${this.page + 1}/${pages}`, 236, 126, api.color565(120, 130, 150), 1);
  },
};

function hexColor(h) {
  const n = parseInt(String(h).replace('#', ''), 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

// ----------------------------------------------------------------- terminal --
const terminal = {
  id: 'terminal', name: 'Terminal', short: 'Terminal', icon: '>_', color: '#22c55e', category: 'tools', version: '1.2.0',
  about: 'CardputerOS shell: i2c scan, gpio, wifi, sd, modules, ir, led, reboot…',
  setup(api) {
    this.lines = ['CardputerOS shell — type "help"', ''];
    this.input = '';
    this.hist = []; this.histIdx = 0;
    this.blink = 0;
    api.serial.println('shell started');
  },
  loop(api, dt) {
    const inp = api.input();
    this.blink += dt;
    for (const ch of api.chars()) {
      if (ch === '\n') { this.run(api, this.input.trim()); this.input = ''; }
      else if (ch === '\b') this.input = this.input.slice(0, -1);
      else if (ch >= ' ' && ch.length === 1) this.input += ch;
    }
    if (inp.esc) return api.exit();
    const L = api.lcd, K = api.COLORS;
    L.fillScreen(api.color565(6, 10, 8));
    const rows = 12;
    const inputY = 125;
    const prompt = '> ' + this.input.slice(-36);
    L.drawString(2, inputY, prompt, K.WHITE, 1);
    if (Math.floor(this.blink * 2) % 2 === 0) L.fillRect(2 + prompt.length * 6, inputY, 5, 7, K.GREEN);
    L.fillRect(0, inputY - 3, 240, 1, api.color565(20, 50, 34));
    const view = this.lines.slice(-rows);
    const top = inputY - 6 - view.length * 9;
    view.forEach((line, i) => {
      const isErr = /^(err|E:)/.test(line);
      L.drawString(2, top + i * 9, line.slice(0, 39), isErr ? K.RED : api.color565(150, 235, 170), 1);
    });
  },
  out(line) { this.lines.push(String(line)); if (this.lines.length > 120) this.lines.shift(); },
  run(api, cmd) {
    if (!cmd) return;
    this.out('> ' + cmd);
    const [c, ...args] = cmd.split(/\s+/);
    try { this.cmd(api, c.toLowerCase(), args); }
    catch (e) { this.out('err: ' + e.message); }
  },
  cmd(api, c, a) {
    const d = api.device;
    switch (c) {
      case 'help':
        this.out('ls cat echo mod i2c gpio wifi ble sd bat');
        this.out('led beep ir app run reboot time free clear');
        break;
      case 'clear': this.lines.length = 0; break;
      case 'mod': {
        const m = api.modules.list();
        if (!m.length) return this.out('no modules attached');
        m.forEach(x => this.out(` ${x.eco.padEnd(6)} ${x.name} (${x.id})`));
        this.out(`i2c grove: ${api.M5.Ex_I2C.scan().map(hex2).join(' ') || '-'}`);
        break;
      }
      case 'i2c': {
        const bus = a[0] === 'in' ? api.M5.In_I2C : api.M5.Ex_I2C;
        const found = bus.scan();
        this.out(`scan ${a[0] === 'in' ? 'internal' : 'grove'}: ${found.length} dev`);
        found.forEach(x => this.out(`  ${hex2(x)}  ${d.buses[a[0] === 'in' ? 'internal' : 'grove'].clients.get(x).name}`));
        if (!found.length) this.out('  (nothing responded)');
        break;
      }
      case 'gpio': {
        const pin = +(a[0] || 2);
        this.out(`gpio${pin} digital=${api.gpio.digitalRead(pin)} analog=${api.gpio.analogRead(pin)}`);
        break;
      }
      case 'ls': {
        if (!api.sd.mounted()) return this.out('err: no SD card');
        api.sd.list('/').forEach(f => this.out(` ${f.dir ? 'd' : '-'} ${f.name}`));
        break;
      }
      case 'cat': {
        const t = api.sd.read(a[0] || '/README.txt');
        if (t == null) return this.out('err: not found');
        t.split('\n').slice(0, 6).forEach(l => this.out(' ' + l));
        break;
      }
      case 'wifi': {
        if (a[0] === 'scan' || !a.length) {
          api.wifi.scan();
          const res = d.radio.listAccessPoints();
          res.forEach(ap => this.out(` ${ap.ssid.padEnd(16)} ${ap.rssi}dB ${ap.auth}`));
        } else if (a[0] === 'conn' || a[0] === 'connect') {
          const r = api.wifi.connect(a[1], a[2] || 'cardputer123');
          this.out(r.ok ? `connecting to ${a[1]}...` : 'err: ' + r.error);
        } else if (a[0] === 'status') {
          const s = api.wifi.status(); this.out(` ${s.state} ${s.ssid || '-'} ${s.ip}`);
        } else this.out('usage: wifi scan|connect <ssid> [pass]|status');
        break;
      }
      case 'ble': d.radio.bleScan().forEach(b => this.out(` ${b.name} ${b.rssi}dB`)); break;
      case 'sd': {
        const i = api.sd.info();
        this.out(` card ${i.inserted ? 'mounted' : 'absent'} ${(i.used / 1024).toFixed(1)}/${(i.capacity / 1024 ** 3).toFixed(0)}GB`);
        break;
      }
      case 'bat': {
        const p = api.power;
        this.out(` ${p.percent()}% ${p.voltage().toFixed(2)}V ${p.milliamps().toFixed(0)}mA ${p.charging() ? 'charging' : ''}`);
        break;
      }
      case 'led': api.power.led(+a[0] || 0, +a[1] || 0, +a[2] || 0); this.out('led set'); break;
      case 'beep': api.M5.Speaker.tone(+(a[0] || 880), +(a[1] || 120)); this.out(`beep ${a[0] || 880}Hz`); break;
      case 'ir': {
        if (a[0] === 'log') return api.M5.IR.log.slice(0, 5).forEach(x => this.out(` ${x.protocol} ${hex2(x.addr)} ${hex2(x.cmd)}`));
        const e = api.M5.IR.sendNec(parseInt(a[0] || '0x00', 16), parseInt(a[1] || '0x45', 16));
        this.out(`sent NEC ${hex2(e.addr)}:${hex2(e.cmd)}`);
        break;
      }
      case 'app': case 'apps': api.apps.list().forEach(x => this.out(` ${x.id.padEnd(10)} v${x.version || '1.0'}`)); break;
      case 'run': return api.apps.launch(a[0]);
      case 'time': this.out(' ' + new Date().toTimeString().slice(0, 8)); break;
      case 'free': this.out(` heap ${(180 + Math.round(Math.random() * 40))}KB  psram 0  cpu ${(d.cpuLoad * 100).toFixed(0)}%`); break;
      case 'reboot': return api.reboot();
      case 'poweroff': return api.device.powerOff();
      case 'echo': this.out(' ' + a.join(' ')); break;
      default: this.out(`err: ${c}: command not found`);
    }
  },
};

// -------------------------------------------------------------------- snake --
const snake = {
  id: 'snake', name: 'Snake', icon: 'SN', color: '#f97316', category: 'games', version: '1.0.2',
  about: 'Classic snake. Steering: Fn + ; . , /  — Fn+` quits.',
  setup(api) { this.reset(api); this.acc = 0; },
  reset(api) {
    this.body = [{ x: 20, y: 11 }, { x: 19, y: 11 }, { x: 18, y: 11 }];
    this.dir = { x: 1, y: 0 }; this.next = { x: 1, y: 0 };
    this.score = 0; this.dead = false;
    this.food = { x: 30, y: 11 };
    this.speed = 0.13;
    this.w = 48; this.h = 23;   // 5px cells inside a 240x115 field
  },
  loop(api, dt) {
    const inp = api.input(), L = api.lcd, K = api.COLORS;
    if (inp.esc) return api.exit();
    if (this.dead) {
      if (inp.enter) { this.reset(api); api.M5.Speaker.tone(660, 60); }
      L.fillScreen(api.color565(14, 8, 8));
      L.drawCentreString('GAME OVER', 120, 44, K.RED, 2);
      L.drawCentreString(`score ${this.score}`, 120, 68, K.WHITE, 1);
      L.drawCentreString('ENTER to retry · Fn+` to quit', 120, 88, api.color565(150, 150, 150), 1);
      return;
    }
    if (inp.up && this.dir.y === 0) this.next = { x: 0, y: -1 };
    if (inp.down && this.dir.y === 0) this.next = { x: 0, y: 1 };
    if (inp.left && this.dir.x === 0) this.next = { x: -1, y: 0 };
    if (inp.right && this.dir.x === 0) this.next = { x: 1, y: 0 };

    this.acc += dt;
    if (this.acc >= this.speed) {
      this.acc = 0;
      this.dir = this.next;
      const head = { x: this.body[0].x + this.dir.x, y: this.body[0].y + this.dir.y };
      if (head.x < 0 || head.y < 0 || head.x >= this.w || head.y >= this.h || this.body.some(b => b.x === head.x && b.y === head.y)) {
        this.dead = true;
        api.M5.Speaker.tone(180, 260, 'sawtooth', 0.2);
        return;
      }
      this.body.unshift(head);
      if (head.x === this.food.x && head.y === this.food.y) {
        this.score += 10;
        this.speed = Math.max(0.06, this.speed - 0.004);
        api.M5.Speaker.tone(1500, 40, 'square', 0.12);
        do { this.food = { x: Math.floor(Math.random() * this.w), y: Math.floor(Math.random() * this.h) }; }
        while (this.body.some(b => b.x === this.food.x && b.y === this.food.y));
      } else this.body.pop();
    }
    L.fillScreen(api.color565(8, 16, 10));
    L.fillRect(0, 0, 240, 14, api.color565(20, 30, 22));
    L.drawString(4, 3, `SCORE ${this.score}`, K.GREEN, 1);
    L.drawRightString(`len ${this.body.length}`, 236, 3, api.color565(140, 200, 150), 1);
    L.fillRect(this.food.x * 5, 16 + this.food.y * 5, 5, 5, K.RED);
    this.body.forEach((b, i) => L.fillRect(b.x * 5, 16 + b.y * 5, 5, 5, i === 0 ? K.LIME : api.color565(40, 190, 90)));
  },
};

// -------------------------------------------------------------------- paint --
const paint = {
  id: 'paint', name: 'Paint', icon: 'PT', color: '#a855f7', category: 'tools', version: '1.0.0',
  about: 'Pixel sketcher. Move with arrows, SPACE draws, C cycles colour, X clears, S saves to SD.',
  setup(api) { this.x = 120; this.y = 70; this.ci = 0; this.px = []; this.colors = [COLORS_RGB(255, 80, 80), COLORS_RGB(80, 220, 120), COLORS_RGB(90, 160, 255), COLORS_RGB(255, 220, 90), COLORS_RGB(240, 240, 240)]; this.rep = 0; },
  loop(api, dt) {
    const inp = api.input(), L = api.lcd, K = api.COLORS;
    this.rep += dt;
    const step = 3, repeat = this.rep > 0.18;
    if (repeat && (inp.up || inp.down || inp.left || inp.right)) this.rep = 0;
    if (inp.up && repeat) this.y = Math.max(14, this.y - step);
    if (inp.down && repeat) this.y = Math.min(132, this.y + step);
    if (inp.left && repeat) this.x = Math.max(2, this.x - step);
    if (inp.right && repeat) this.x = Math.min(237, this.x + step);
    const typed = api.typed();
    if (typed.includes('c')) this.ci = (this.ci + 1) % this.colors.length;
    if (typed.includes('s') && api.sd.mounted()) { api.sd.write('/paint.txt', this.px.map(p => `${p.x},${p.y},${p.c}`).join('\n')); api.notify('saved /paint.txt'); }
    if (typed.includes('x')) this.px = [];
    if (inp.esc) return api.exit();
    if (inp.space || api.pressed('space')) this.px.push({ x: this.x, y: this.y, c: this.ci });
    if (this.px.length > 3000) this.px.shift();
    L.fillScreen(api.color565(14, 14, 20));
    for (const p of this.px) L.fillRect(p.x, p.y, 2, 2, this.colors[p.c]);
    L.drawRect(this.x, this.y, 3, 3, K.WHITE);
    L.fillRect(0, 0, 240, 12, api.color565(30, 26, 40));
    L.drawString(3, 2, 'PAINT', K.WHITE, 1);
    L.drawRightString('space=draw c=col x=clear s=save', 237, 2, api.color565(150, 140, 170), 1);
    for (let i = 0; i < this.colors.length; i++) L.fillRect(4 + i * 10, 125, 8, 8, this.colors[i]);
    L.drawRect(4 + this.ci * 10, 125, 8, 8, K.WHITE);
  },
};
function COLORS_RGB(r, g, b) { return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3); }

// --------------------------------------------------------------------- calc --
const calc = {
  id: 'calc', name: 'Calc', icon: 'CC', color: '#38bdf8', category: 'tools', version: '1.1.0',
  about: 'Four-function calculator. Type an expression, ENTER to evaluate.',
  setup() { this.expr = ''; this.result = ''; this.err = ''; },
  loop(api) {
    const L = api.lcd, K = api.COLORS;
    const inp = api.input();
    for (const ch of api.chars()) {
      if (ch === '\n') { this.evaluate(); continue; }
      if (ch === '\b') { this.expr = this.expr.slice(0, -1); continue; }
      if (/[0-9+\-*/().%^ ]/.test(ch)) this.expr += ch;
    }
    if (inp.esc) return api.exit();
    L.fillScreen(api.color565(10, 16, 26));
    L.fillRect(0, 0, 240, 12, api.color565(20, 34, 50));
    L.drawString(3, 2, 'CALCULATOR', K.WHITE, 1);
    L.drawString(6, 22, '›', api.color565(120, 180, 240), 1);
    L.drawString(18, 20, this.expr.slice(-34), K.WHITE, 1);
    L.fillRect(4, 34, 232, 1, api.color565(50, 70, 100));
    const shown = this.err ? 'error' : (this.result !== '' ? this.result : '0');
    L.drawRightString(String(shown).slice(-22), 234, 42, this.err ? K.RED : K.AMBER, 3);
    L.drawString(4, 84, this.err ? 'err: ' + this.err : 'ENTER = evaluate  Fn+` = quit', api.color565(110, 140, 170), 1);
    L.fillRect(4, 96, 232, 1, api.color565(50, 70, 100));
    L.drawString(4, 103, 'digits   + - * /   ( )   %   ^', api.color565(120, 150, 180), 1);
    L.drawString(4, 115, 'history:', api.color565(90, 120, 150), 1);
    L.drawString(50, 115, this.hist || '', api.color565(200, 210, 220), 1);
  },
  evaluate() {
    const e = this.expr.replace(/\^/g, '**').replace(/%/g, '/100');
    if (!e.trim()) return;
    try {
      if (!/^[\d+\-*/().\s]+$/.test(e)) throw new Error('bad chars');
      const v = Function(`"use strict";return (${e})`)();
      if (!isFinite(v)) throw new Error('not finite');
      this.result = Math.round(v * 1e6) / 1e6;
      this.hist = (this.expr + ' = ' + this.result).slice(-40);
      this.expr = String(this.result);
      this.err = '';
    } catch (err) { this.err = err.message; }
  },
};

// -------------------------------------------------------------------- files --
const files = {
  id: 'files', name: 'Files', icon: 'SD', color: '#fbbf24', category: 'tools', version: '1.0.1',
  about: 'Browse and read files on the virtual microSD card.',
  setup(api) { this.sel = 0; this.mode = 'list'; this.path = '/'; this.entries = []; this.text = []; this.scroll = 0; this.reload(api); },
  reload(api) {
    if (!api.sd.mounted()) { this.entries = []; return; }
    try { this.entries = api.sd.list(this.path); } catch { this.entries = []; }
    this.sel = Math.min(this.sel, Math.max(0, this.entries.length - 1));
  },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS, inp = api.input();
    if (inp.esc) { if (this.mode === 'view') { this.mode = 'list'; return; } return api.exit(); }
    L.fillScreen(api.color565(18, 16, 10));
    L.fillRect(0, 0, 240, 12, api.color565(40, 34, 18));
    L.drawString(3, 2, 'SD ' + this.path, K.AMBER, 1);
    if (!api.sd.mounted()) {
      L.drawCentreString('no microSD card', 120, 50, K.RED, 1);
      L.drawCentreString('insert one from the Device panel', 120, 66, api.color565(170, 160, 140), 1);
      return;
    }
    const info = api.sd.info();
    if (this.mode === 'list') {
      if (inp.up) this.sel = (this.sel + this.entries.length - 1) % Math.max(1, this.entries.length);
      if (inp.down) this.sel = (this.sel + 1) % Math.max(1, this.entries.length);
      if (inp.enter && this.entries[this.sel]) {
        const e = this.entries[this.sel];
        if (e.dir) { this.path = e.path; this.reload(api); }
        else { this.text = (api.sd.read(e.path) || '').split('\n'); this.mode = 'view'; this.scroll = 0; }
      }
      const rows = this.entries.map(e => ({ label: (e.dir ? '[' + e.name + ']' : e.name), right: e.dir ? '' : e.size + 'B' }));
      api.ui.list(rows.length ? rows : [{ label: '(empty)' }], this.sel, { y: 17, rowH: 12 });
      L.fillRect(0, 124, 240, 11, api.color565(40, 34, 18));
      L.drawString(3, 126, `${(info.used / 1024).toFixed(1)}KB used of ${(info.capacity / 1024 ** 3).toFixed(0)}GB`, api.color565(200, 180, 120), 1);
    } else {
      if (inp.up) this.scroll = Math.max(0, this.scroll - 1);
      if (inp.down) this.scroll = Math.min(Math.max(0, this.text.length - 12), this.scroll + 1);
      this.text.slice(this.scroll, this.scroll + 12).forEach((line, i) => L.drawString(3, 16 + i * 9, line.slice(0, 39), api.color565(230, 220, 190), 1));
      L.drawString(3, 126, `line ${this.scroll + 1}/${this.text.length} · Fn+\` back`, api.color565(160, 150, 120), 1);
    }
  },
};

// ----------------------------------------------------------------- sensors ---
const ENV_MODULES = ['env3', 'env4', 'envpro'];
const envapp = {
  id: 'env', name: 'ENV Mon', short: 'ENV Mon', icon: 'EN', color: '#4ade80', category: 'sensors', version: '1.3.0',
  about: 'Live temperature / humidity / pressure from a Grove ENV unit. Unplug it while running to see the fail path.',
  setup(api) { this.hist = []; this.t = 0; this.acc = 0; },
  activeModule(api) {
    for (const id of ENV_MODULES) { const s = api.modules.state(id); if (s) return { id, s }; }
    return null;
  },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS;
    if (api.input().esc) return api.exit();
    const found = this.activeModule(api);
    this.acc += dt;
    if (found && this.acc > 0.3) {
      this.acc = 0;
      this.hist.push(found.s.temp);
      if (this.hist.length > 60) this.hist.shift();
    }
    L.fillScreen(api.color565(6, 14, 10));
    L.fillRect(0, 0, 240, 12, api.color565(16, 34, 24));
    L.drawString(3, 2, 'ENV MONITOR', K.GREEN, 1);
    if (!found) {
      L.drawCentreString('no ENV unit detected', 120, 40, K.AMBER, 1);
      L.drawCentreString('Grove port is empty', 120, 56, api.color565(150, 180, 155), 1);
      const mods = api.modules.list();
      L.drawString(8, 74, mods.length ? 'attached: ' + mods.map(m => m.name).join(', ').slice(0, 36) : 'plug ENV III / ENV IV / ENV Pro', api.color565(120, 170, 130), 1);
      L.drawString(8, 88, 'i2c grove: ' + (api.M5.Ex_I2C.scan().map(hex2).join(' ') || 'empty'), api.color565(120, 150, 130), 1);
      L.drawString(8, 106, 'the driver re-scans every frame —', api.color565(90, 130, 100), 1);
      L.drawString(8, 116, 'hot-plug it and this screen wakes up.', api.color565(90, 130, 100), 1);
      return;
    }
    const s = found.s;
    L.drawString(3, 15, found.id.toUpperCase(), api.color565(120, 200, 140), 1);
    L.drawString(196, 15, 'OK', K.GREEN, 1);
    L.drawRightString(s.temp.toFixed(1), 130, 26, K.WHITE, 4);
    L.drawString(132, 28, 'C', K.AMBER, 2);
    L.drawString(3, 70, `HUM  ${s.humidity.toFixed(1)} %`, api.color565(120, 200, 255), 1);
    L.drawString(3, 82, `PRES ${s.pressure ? s.pressure.toFixed(1) : '--'} hPa`, api.color565(200, 200, 120), 1);
    // sparkline
    const gx = 130, gy = 62, gw = 104, gh = 44;
    L.drawRect(gx, gy, gw, gh, api.color565(40, 70, 55));
    if (this.hist.length > 1) {
      const mn = Math.min(...this.hist) - 0.5, mx = Math.max(...this.hist) + 0.5;
      for (let i = 1; i < this.hist.length; i++) {
        const x0 = gx + ((i - 1) / 59) * gw, x1 = gx + (i / 59) * gw;
        const y0 = gy + gh - ((this.hist[i - 1] - mn) / (mx - mn || 1)) * gh;
        const y1 = gy + gh - ((this.hist[i] - mn) / (mx - mn || 1)) * gh;
        L.drawLine(x0, y0, x1, y1, K.GREENYELLOW);
      }
    }
    L.drawString(gx + 2, gy + 2, '60 samples', api.color565(80, 120, 95), 1);
    L.fillRect(0, 124, 240, 11, api.color565(16, 34, 24));
    L.drawString(3, 126, `i2c: ${api.M5.Ex_I2C.scan().map(hex2).join(' ')}`, api.color565(110, 180, 130), 1);
  },
};

// --------------------------------------------------------------------- imu ---
const imuapp = {
  id: 'imu', name: 'Level', icon: 'IM', color: '#c084fc', category: 'sensors', version: '1.0.0',
  about: 'Bubble level driven by the on-board BMI270 (Cardputer-Adv only). Drag the tilt pad in the Device panel.',
  setup() { this.sx = 0; this.sy = 0; },
  loop(api) {
    const L = api.lcd, K = api.COLORS;
    if (api.input().esc) return api.exit();
    L.fillScreen(api.color565(12, 8, 20));
    L.fillRect(0, 0, 240, 12, api.color565(30, 20, 46));
    L.drawString(3, 2, 'BUBBLE LEVEL', K.MAGENTA, 1);
    if (!api.M5.Imu.available()) {
      L.drawCentreString('BMI270 not present', 120, 44, K.AMBER, 1);
      L.drawCentreString('IMU ships on Cardputer-Adv only', 120, 60, api.color565(170, 150, 190), 1);
      L.drawCentreString('switch SKU in System → Variant', 120, 74, api.color565(140, 120, 170), 1);
      L.drawCentreString('or attach an external IMU', 120, 88, api.color565(120, 100, 150), 1);
      return;
    }
    const a = api.M5.Imu.getAccel();
    this.sx += (a.x - this.sx) * 0.2; this.sy += (a.y - this.sy) * 0.2;
    const cx = 120, cy = 60, r = 42;
    L.drawCircle(cx, cy, r, api.color565(70, 50, 100));
    L.drawCircle(cx, cy, 22, api.color565(50, 36, 76));
    L.drawLine(cx - r, cy, cx + r, cy, api.color565(40, 30, 60));
    L.drawLine(cx, cy - r, cx, cy + r, api.color565(40, 30, 60));
    const bx = cx + this.sx * r, by = cy + this.sy * r;
    const centered = Math.hypot(this.sx, this.sy) < 0.06;
    L.fillCircle(bx, by, 7, centered ? K.GREEN : K.AMBER);
    L.drawString(4, 108, `x ${a.x.toFixed(2)}  y ${a.y.toFixed(2)}  z ${a.z.toFixed(2)} g`, api.color565(170, 150, 200), 1);
    L.drawString(4, 120, centered ? 'LEVEL — spot on' : `tilt ${(Math.hypot(this.sx, this.sy) * 90).toFixed(0)}°`, centered ? K.GREEN : K.AMBER, 1);
    L.drawRightString(`steps ${api.device.imu.steps}`, 236, 120, api.color565(110, 90, 140), 1);
  },
};

// ---------------------------------------------------------------------- ir ---
const irapp = {
  id: 'ir', name: 'IR Remote', short: 'IR Ctrl', icon: 'IR', color: '#ef4444', category: 'radio', version: '1.1.0',
  about: 'NEC infrared blaster (GPIO44). Sends real NEC frames to the virtual receiver.',
  setup(api) { this.sel = 0; this.buttons = [['POWER', 0x00, 0x45], ['VOL+', 0x00, 0x46], ['VOL-', 0x00, 0x15], ['MUTE', 0x00, 0x47], ['CH+', 0x00, 0x09], ['CH-', 0x00, 0x1d], ['UP', 0x00, 0x40], ['DOWN', 0x00, 0x41], ['OK', 0x00, 0x44], ['MENU', 0x00, 0x13]]; this.log = []; },
  loop(api) {
    const L = api.lcd, K = api.COLORS, inp = api.input();
    if (inp.esc) return api.exit();
    if (inp.right) this.sel = (this.sel + 1) % this.buttons.length;
    if (inp.left) this.sel = (this.sel + this.buttons.length - 1) % this.buttons.length;
    if (inp.down) this.sel = (this.sel + 5) % this.buttons.length;
    if (inp.up) this.sel = (this.sel + this.buttons.length - 5) % this.buttons.length;
    if (inp.enter) {
      const [name, addr, cmd] = this.buttons[this.sel];
      api.M5.IR.sendNec(addr, cmd);
      api.M5.Speaker.tone(2400, 12, 'square', 0.05);
      this.log.unshift(`${name} → ${hex2(addr)}:${hex2(cmd)}`);
      if (this.log.length > 5) this.log.pop();
    }
    L.fillScreen(api.color565(18, 8, 8));
    L.fillRect(0, 0, 240, 12, api.color565(44, 16, 16));
    L.drawString(3, 2, 'IR BLASTER · NEC', K.RED, 1);
    L.drawRightString('38kHz', 236, 2, api.color565(160, 80, 80), 1);
    this.buttons.forEach((b, i) => {
      const x = 4 + (i % 5) * 47, y = 18 + Math.floor(i / 5) * 32;
      const sel = i === this.sel;
      L.fillRoundRect(x, y, 44, 28, 4, sel ? api.color565(120, 30, 30) : api.color565(34, 16, 16));
      if (sel) L.drawRoundRect(x, y, 44, 28, 4, K.AMBER);
      L.drawCentreString(b[0], x + 22, y + 11, sel ? K.WHITE : api.color565(200, 140, 140), 1);
    });
    L.drawString(4, 88, 'transmit log:', api.color565(150, 100, 100), 1);
    this.log.forEach((l, i) => L.drawString(4, 98 + i * 9, l, api.color565(230, 180, 180), 1));
    L.drawRightString(`pulses ${api.device.ir.log.length}`, 236, 124, api.color565(120, 80, 80), 1);
  },
};

// -------------------------------------------------------------------- wifi ---
const wifiapp = {
  id: 'wifi', name: 'WiFi', icon: 'WF', color: '#22d3ee', category: 'radio', version: '1.2.0',
  about: 'Scan 2.4 GHz access points, connect (any 8+ char password), watch the DHCP handshake.',
  setup(api) { this.sel = 0; this.mode = 'scan'; this.aps = []; this.pass = ''; this.msg = ''; this.scanned = false; },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS, inp = api.input();
    if (inp.esc) { if (this.mode === 'pass') { this.mode = 'scan'; this.pass = ''; return; } return api.exit(); }
    if (!this.scanned) { this.aps = api.device.radio.listAccessPoints(); this.scanned = true; }
    const st = api.wifi.status();
    if (this.mode === 'scan') {
      if (inp.down) this.sel = (this.sel + 1) % Math.max(1, this.aps.length);
      if (inp.up) this.sel = (this.sel + this.aps.length - 1) % Math.max(1, this.aps.length);
      if (api.typed().includes('r')) this.aps = api.device.radio.listAccessPoints();
      if (inp.enter && this.aps[this.sel]) { this.mode = 'pass'; this.pass = ''; this.target = this.aps[this.sel]; }
    } else if (this.mode === 'pass') {
      for (const ch of api.chars()) {
        if (ch === '\n') { api.wifi.connect(this.target.ssid, this.pass); this.mode = 'status'; this.msg = 'connecting…'; }
        else if (ch === '\b') this.pass = this.pass.slice(0, -1);
        else if (ch >= ' ') this.pass += ch;
      }
    }
    if (this.mode === 'status' && st.state === 'connected') this.msg = 'connected';
    L.fillScreen(api.color565(6, 14, 20));
    L.fillRect(0, 0, 240, 12, api.color565(14, 40, 56));
    L.drawString(3, 2, 'WIFI', K.CYAN, 1);
    const bar = st.state === 'connected' ? `${st.ssid} ${st.ip}` : st.state;
    L.drawRightString(bar.slice(0, 26), 236, 2, st.state === 'connected' ? K.GREEN : api.color565(150, 180, 200), 1);
    if (this.mode === 'scan') {
      this.aps.forEach((ap, i) => {
        const y = 16 + i * 14;
        const bars = clamp(Math.round((ap.rssi + 95) / 12), 0, 5);
        if (i === this.sel) { L.fillRect(0, y - 2, 240, 13, api.color565(18, 50, 70)); L.fillRect(0, y - 2, 2, 13, K.AMBER); }
        L.drawString(5, y, ap.ssid.slice(0, 17), i === this.sel ? K.AMBER : K.WHITE, 1);
        for (let b = 0; b < 5; b++) L.fillRect(150 + b * 5, y + 6 - b * 1.4, 3, 2 + b * 1.4, b < bars ? (bars > 3 ? K.GREEN : K.AMBER) : api.color565(40, 60, 70));
        L.drawString(182, y, `${ap.rssi}`, api.color565(150, 190, 210), 1);
        L.drawString(212, y, ap.auth === 'OPEN' ? 'OPEN' : 'WPA2', api.color565(110, 150, 170), 1);
      });
      L.fillRect(0, 124, 240, 11, api.color565(14, 40, 56));
      L.drawString(3, 126, 'ENTER connect · R rescan', api.color565(150, 200, 220), 1);
    } else if (this.mode === 'pass') {
      L.drawCentreString('connect to', 120, 26, api.color565(160, 200, 220), 1);
      L.drawCentreString(this.target.ssid, 120, 40, K.WHITE, 2);
      L.drawRect(20, 64, 200, 18, api.color565(40, 90, 120));
      L.drawString(24, 70, '*'.repeat(this.pass.length), K.AMBER, 1);
      L.drawCentreString('type password, ENTER to join', 120, 94, api.color565(130, 170, 195), 1);
      L.drawCentreString('(m5stack-lab / HomeNet need 8+ chars)', 120, 108, api.color565(100, 140, 165), 1);
    } else {
      L.drawCentreString('WIFI STATUS', 120, 22, api.color565(150, 200, 220), 1);
      L.drawCentreString(st.state.toUpperCase(), 120, 40, st.state === 'connected' ? K.GREEN : K.AMBER, 2);
      L.drawString(10, 66, `SSID   ${st.ssid || '—'}`, K.WHITE, 1);
      L.drawString(10, 78, `IPv4   ${st.ip}`, K.WHITE, 1);
      L.drawString(10, 90, `RSSI   ${st.rssi ?? '—'} dBm`, K.WHITE, 1);
      L.drawString(10, 102, `TX/RX  ${api.device.radio.txBytes}/${api.device.radio.rxBytes} B`, api.color565(150, 190, 210), 1);
      L.drawString(10, 116, 'Fn+` back · R rescan', api.color565(120, 160, 185), 1);
    }
  },
};

// -------------------------------------------------------------------- lora ---
const loraapp = {
  id: 'lora', name: 'LoRa Chat', short: 'LoRa', icon: 'LO', color: '#fb923c', category: 'radio', version: '1.4.0',
  about: 'Meshtastic-style text chat. Needs CAP LoRa-1262 (EXT header) or a Grove LoRa unit.',
  setup(api) { this.msgs = []; this.input = ''; this.sel = 0; },
  radio(api) {
    return api.modules.find('cap-lora1262') || api.modules.find('lora') || null;
  },
  loop(api) {
    const L = api.lcd, K = api.COLORS, inp = api.input();
    if (inp.esc) return api.exit();
    const radio = this.radio(api);
    L.fillScreen(api.color565(16, 12, 6));
    L.fillRect(0, 0, 240, 12, api.color565(44, 30, 10));
    L.drawString(3, 2, 'LORA MESH', K.ORANGE, 1);
    if (!radio) {
      L.drawCentreString('no LoRa radio attached', 120, 40, K.AMBER, 1);
      L.drawCentreString('plug CAP LoRa-1262 on the EXT header', 120, 56, api.color565(200, 170, 130), 1);
      L.drawCentreString('(System → Modules → EXT)', 120, 70, api.color565(160, 130, 100), 1);
      const hasExt = api.device.variant.ext;
      L.drawCentreString(hasExt ? 'EXT header present ✔' : 'this SKU has no EXT header', 120, 92, hasExt ? K.GREEN : K.RED, 1);
      L.drawCentreString('or attach Grove Unit LoRaWAN', 120, 108, api.color565(150, 120, 90), 1);
      return;
    }
    const s = radio.state || {};
    L.drawRightString(`${s.meshNodes ?? 0} nodes · ${s.rssi ?? '--'}dBm`, 236, 2, api.color565(230, 180, 110), 1);
    for (const ch of api.chars()) {
      if (ch === '\n') {
        if (this.input.trim()) { this.msgs.push('me: ' + this.input.trim()); api.M5.Speaker.tone(900, 40); }
        this.input = '';
      } else if (ch === '\b') this.input = this.input.slice(0, -1);
      else if (ch >= ' ') this.input += ch;
    }
    if (this.msgs.length > 40) this.msgs.shift();
    L.fillRect(0, 14, 240, 96, api.color565(10, 9, 6));
    this.msgs.slice(-9).forEach((m, i) => {
      const mine = m.startsWith('me:');
      L.drawString(4, 16 + i * 10, (mine ? '▶ ' : '◀ ') + m.slice(0, 35), mine ? K.GREENYELLOW : api.color565(220, 200, 170), 1);
    });
    L.fillRect(0, 111, 240, 1, api.color565(60, 44, 20));
    L.drawString(3, 115, '> ' + this.input.slice(-34), K.WHITE, 1);
    L.fillRect(0, 124, 240, 11, api.color565(44, 30, 10));
    L.drawString(3, 126, `${radio.name} · ${s.freq ?? 915} MHz · SF11`, api.color565(200, 160, 110), 1);
  },
};

// ------------------------------------------------------------------- music ---
const music = {
  id: 'music', name: 'Tunes', icon: 'MU', color: '#f472b6', category: 'media', version: '1.0.0',
  about: 'Tone sequencer on the 1 W speaker. ENTER play/stop, left/right change track, +/- volume.',
  setup(api) { this.track = 0; this.playing = false; this.i = 0; this.t = 0; this.tracks = TRACKS; },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS, inp = api.input();
    if (inp.esc) { api.M5.Speaker.stop(); return api.exit(); }
    if (inp.right) { this.track = (this.track + 1) % this.tracks.length; this.playing = false; this.i = 0; }
    if (inp.left) { this.track = (this.track + this.tracks.length - 1) % this.tracks.length; this.playing = false; this.i = 0; }
    if (inp.enter) { this.playing = !this.playing; this.i = 0; this.t = 0; }
    const typed = api.typed();
    if (typed.includes('+')) api.M5.Speaker.setVolume(clamp(api.M5.Speaker.getVolume() + 0.1, 0, 1));
    if (typed.includes('-')) api.M5.Speaker.setVolume(clamp(api.M5.Speaker.getVolume() - 0.1, 0, 1));
    const tr = this.tracks[this.track];
    if (this.playing) {
      this.t += dt;
      const note = tr.notes[this.i % tr.notes.length];
      if (this.t > (note[1] || 0.18)) { this.t = 0; this.i++; }
      if (this.t === 0 || this.i === 0) {
        const n = tr.notes[this.i % tr.notes.length];
        if (n[0] > 0) api.M5.Speaker.tone(n[0], Math.round((n[1] || 0.18) * 900), 'square', 0.5);
      }
    }
    L.fillScreen(api.color565(18, 8, 16));
    L.fillRect(0, 0, 240, 12, api.color565(44, 18, 38));
    L.drawString(3, 2, 'TUNES', K.PINK, 1);
    L.drawRightString(`vol ${(api.M5.Speaker.getVolume() * 100).toFixed(0)}%`, 236, 2, api.color565(220, 150, 190), 1);
    L.drawCentreString(tr.name, 120, 20, K.WHITE, 2);
    L.drawCentreString(this.playing ? '▶ playing' : '❚❚ stopped', 120, 40, this.playing ? K.GREEN : api.color565(160, 120, 145), 1);
    for (let b = 0; b < 24; b++) {
      const active = this.playing && (this.i % 24) === b;
      const h = 6 + (Math.sin(b * 0.7 + api.millis() / 200) * 0.5 + 0.5) * 18;
      L.fillRect(6 + b * 9.6, 96 - h / 2, 7, h, active ? K.AMBER : api.color565(90, 30, 70));
    }
    L.drawString(4, 104, 'ENTER play/stop  ◀ ▶ track  + - volume', api.color565(190, 140, 175), 1);
    L.drawRightString(`track ${this.track + 1}/${this.tracks.length}`, 236, 116, api.color565(150, 110, 140), 1);
  },
};
const TRACKS = [
  { name: 'Boot Chime', notes: [[880, 0.12], [1108, 0.12], [1318, 0.3], [0, 0.1]] },
  { name: 'Arpeggio', notes: [[523, 0.12], [659, 0.12], [784, 0.12], [1046, 0.2], [784, 0.12], [659, 0.12], [0, 0.15]] },
  { name: 'Nokia-ish', notes: [[1318, 0.1], [1174, 0.1], [740, 0.1], [830, 0.1], [1108, 0.1], [988, 0.1], [830, 0.1], [740, 0.2]] },
  { name: 'Sweep', notes: [[200, 0.08], [300, 0.08], [400, 0.08], [500, 0.08], [600, 0.08], [800, 0.08], [1000, 0.2]] },
];

// --------------------------------------------------------------------- mic ---
const micapp = {
  id: 'mic', name: 'Mic', icon: 'MI', color: '#facc15', category: 'media', version: '1.0.0',
  about: 'Microphone scope (SPM1423 on v1.x, ES8311 ADC on ADV). Uses your real mic if you allow it.',
  setup(api) { this.lvl = 0; this.peak = 0; this.t = 0; this.buf = new Float32Array(96); },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS;
    if (api.input().esc) return api.exit();
    this.t += dt;
    if (this.t > 0.05) {
      this.t = 0;
      const s = api.M5.Mic.record(50);
      const rms = api.M5.Mic.rms(s);
      this.lvl = clamp(rms * 3, 0, 1);
      this.peak = Math.max(this.peak * 0.995, this.lvl);
      for (let i = 0; i < this.buf.length - 1; i++) this.buf[i] = this.buf[i + 1];
      this.buf[this.buf.length - 1] = rms * 6;
    }
    L.fillScreen(api.color565(14, 12, 4));
    L.fillRect(0, 0, 240, 12, api.color565(44, 38, 10));
    L.drawString(3, 2, 'MIC SCOPE', K.YELLOW, 1);
    L.drawRightString(api.device.variant.audio.split(' ')[0], 236, 2, api.color565(190, 170, 80), 1);
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      const h = Math.min(34, Math.abs(v) * 34);
      L.fillRect(6 + i * 2.4, 60 - h / 2, 2, Math.max(1, h), api.color565(200, 200, 60));
    }
    api.ui.gauge(10, 92, 220, 8, this.lvl, this.lvl > 0.85 ? K.RED : K.GREEN, api.color565(40, 40, 10));
    L.drawString(10, 104, `level ${(this.lvl * 100).toFixed(0)}%  peak ${(this.peak * 100).toFixed(0)}%`, api.color565(220, 210, 120), 1);
    L.drawString(10, 116, api.M5.Mic.jackSource ? 'source: real microphone' : 'source: simulated ambience', api.color565(140, 130, 70), 1);
  },
};

// ------------------------------------------------------------------ keytest --
const keytest = {
  id: 'keytest', name: 'Key Test', short: 'Keys', icon: 'KB', color: '#94a3b8', category: 'tools', version: '1.0.0',
  about: 'Shows the live 4x14 key matrix, modifier state and the last decoded key events.',
  setup(api) { this.last = []; },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS, d = api.device;
    if (api.input().esc) return api.exit();
    const evs = api.keys().filter(e => e.type === 'down');
    for (const e of evs) { this.last.unshift(e.id); if (this.last.length > 14) this.last.pop(); }
    L.fillScreen(api.color565(10, 12, 16));
    L.fillRect(0, 0, 240, 12, api.color565(26, 30, 38));
    L.drawString(3, 2, 'KEY MATRIX 4x14', K.LIGHTGREY, 1);
    L.drawRightString(d.variant.tca8418 ? 'TCA8418 @0x34' : '74HC138 scan', 236, 2, api.color565(140, 150, 165), 1);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 14; c++) {
      const on = d.keyboard.matrix[r * 14 + c];
      const x = 4 + c * 17, y = 16 + r * 15;
      L.fillRect(x, y, 15, 13, on ? K.GREEN : api.color565(28, 32, 42));
      L.drawRect(x, y, 15, 13, api.color565(48, 54, 66));
    }
    const s = api.state();
    L.drawString(4, 78, `fn ${s.fn ? 1 : 0} sh ${s.shift ? 1 : 0} ct ${s.ctrl ? 1 : 0} alt ${s.alt ? 1 : 0}`, api.color565(160, 200, 220), 1);
    L.drawString(4, 88, 'word: ' + s.word.join('').slice(0, 30), api.color565(200, 210, 225), 1);
    L.drawString(4, 98, 'fn layer: ' + (s.fnKeys.join(' ') || '—'), api.color565(220, 190, 120), 1);
    L.drawString(4, 110, 'events: ' + (this.last.join(' ') || '—').slice(0, 36), api.color565(140, 160, 180), 1);
    L.drawString(4, 122, `fifo ${d.keyboard.fifo.length}/10${d.keyboard.overflow ? ' overflow ' + d.keyboard.overflow : ''}`, api.color565(120, 140, 160), 1);
  },
};

// ------------------------------------------------------------------ system ---
const about = {
  id: 'system', name: 'System', icon: 'SY', color: '#64748b', category: 'tools', version: '1.0.0',
  about: 'Firmware + hardware inventory: SKU, I²C scan, modules, SD, battery, heap.',
  setup() { this.page = 0; },
  loop(api) {
    const L = api.lcd, K = api.COLORS, d = api.device, inp = api.input();
    if (inp.esc) return api.exit();
    if (inp.right || inp.enter) this.page = (this.page + 1) % 2;
    if (inp.left) this.page = (this.page + 1) % 2;
    L.fillScreen(api.color565(10, 12, 16));
    L.fillRect(0, 0, 240, 12, api.color565(26, 30, 38));
    L.drawString(3, 2, 'SYSTEM', K.LIGHTGREY, 1);
    L.drawRightString(`page ${this.page + 1}/2`, 236, 2, api.color565(130, 140, 155), 1);
    const rows = this.page === 0 ? [
      ['SKU', d.variant.sku], ['SoC', d.variant.soc], ['Flash', (d.variant.flashBytes / 1048576) + ' MB'],
      ['Keyboard', d.variant.kbChip], ['Audio', d.variant.audio], ['IMU', d.variant.imu ? 'BMI270' : 'none'],
      ['Firmware', api.version], ['Uptime', `${Math.floor(d.uptime / 60)}m ${Math.floor(d.uptime % 60)}s`],
      ['Battery', `${api.power.percent()}% ${api.power.voltage().toFixed(2)}V`],
      ['Modules', api.modules.list().map(m => m.name).join(', ') || 'none'],
    ] : [
      ['I2C internal', api.M5.In_I2C.scan().map(hex2).join(' ') || '—'],
      ['I2C grove', api.M5.Ex_I2C.scan().map(hex2).join(' ') || '—'],
      ['SD', api.sd.info().inserted ? `${(api.sd.info().used / 1024).toFixed(1)}KB used` : 'absent'],
      ['WiFi', api.wifi.status().state],
      ['Apps', String(api.apps.list().length)],
      ['Heap', '214 KB'],
      ['CPU', `${(d.cpuLoad * 100).toFixed(0)}%`],
      ['UART', api.uart.available() ? 'device on bus' : 'idle'],
      ['IR', `${api.M5.IR.log.length} frames sent`],
      ['Reset', 'ENTER page · Fn+` quit'],
    ];
    rows.forEach(([k, v], i) => {
      L.drawString(4, 17 + i * 11, k, api.color565(130, 145, 165), 1);
      L.drawString(78, 17 + i * 11, String(v).slice(0, 26), K.WHITE, 1);
    });
  },
};

export const BUILTIN_APPS = [launcher, terminal, snake, paint, calc, files, envapp, imuapp, irapp, wifiapp, loraapp, music, micapp, keytest, about];
