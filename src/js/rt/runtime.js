// =============================================================================
//  Firmware runtime: boots CardputerOS, exposes an M5Cardputer-style API to
//  apps, drives their setup()/loop() lifecycle, and shows panics on a crash.
// =============================================================================
import { COLORS, color565 } from '../core/hardware.js';
import { clamp } from '../core/util.js';

export class Runtime {
  constructor(device, { apps = [], fetcher = null, version = '1.0.0' } = {}) {
    this.device = device;
    this.apps = new Map(apps.map(a => [a.id, a]));
    this.fetcher = fetcher;
    this.version = version;
    this.active = null;
    this.phase = 'off';       // off | boot | splash | run | panic
    this.timer = 0;
    this.panic = null;
    this.frame = 0;
    this.fps = 0;
    this._fpsAcc = 0; this._fpsFrames = 0;
    this.onEvent = () => {};
    this.serialTag = 'fw';
    this.launcherId = 'launcher';
    this.history = [];
    this.flash = null;          // FlashManager, attached by main.js
    this.loopMs = 0;            // budget spent in the app's loop() this frame
    this.slowFrames = 0;        // consecutive frames that blew the budget
  }

  // ---------------------------------------------------------------- boot ----
  boot() {
    this.device.boot();
    this.phase = 'boot';
    this.timer = 0;
    this.active = null;
    this.device.display.sleep(false);
    this.device.display.fillScreen(COLORS.BLACK);
    this.emit('boot');
  }

  splash() {
    const d = this.device, L = d.display;
    L.fillScreen(COLORS.BLACK);
    L.fillRoundRect(300, 0, 0, 0, 0, 0); // no-op keeps API honest
    L.fillRect(0, 0, 240, 135, color565(10, 12, 18));
    L.drawRoundRect(14, 26, 212, 62, 8, color565(40, 46, 60));
    L.drawCentreString('CARDPUTER', 120, 38, COLORS.WHITE, 3);
    L.drawCentreString(`emulator firmware ${this.version}`, 120, 66, color565(120, 200, 255), 1);
    L.drawCentreString(d.variant.sku + '  ·  ' + d.variant.soc.split(' ')[0], 120, 96, color565(110, 116, 130), 1);
    const p = Math.min(1, this.timer / 1.1);
    L.drawRect(30, 112, 180, 7, color565(60, 66, 80));
    L.fillRect(31, 113, Math.round(178 * p), 5, color565(90, 220, 150));
    if (!this._chime) { this._chime = true; d.speaker.tone(880, 60, 'sine', 0.25); setTimeout(() => d.speaker.tone(1320, 90, 'sine', 0.22), 90); }
  }

  // ------------------------------------------------------------- lifecycle --
  launch(id) {
    const app = this.apps.get(id);
    if (!app) { this.device.serial(`[E][fw] no such app: ${id}`, 'error'); return { ok: false, error: 'no such app' }; }
    if (this.active && this.active.onExit) this.safe(() => this.active.onExit(this.api));
    this.active = app;
    this.phase = 'run';
    this.panic = null;
    this.device.display.sleep(false);
    this.device.display.clearClip();
    this.device.display.fillScreen(COLORS.BLACK);
    this.device.serial(`[I][fw] launching ${app.name} v${app.version || '1.0'}`, 'info');
    if (app.onEnter) this.safe(() => app.onEnter(this.api));
    this.safe(() => app.setup && app.setup(this.api));
    this.history.push(id);
    if (this.history.length > 20) this.history.shift();
    this.emit('launch', id);
    return { ok: true };
  }
  exit() {
    if (this.active && this.active.onExit) this.safe(() => this.active.onExit(this.api));
    this.active = null;
    this.phase = 'splash';
    this.timer = 0;
    this._chime = true;
    this.launch(this.launcherId);
    return { ok: true };
  }
  reboot() {
    this.active = null;
    this._chime = false;
    this.device.reboot();
    this.phase = 'boot';
    this.timer = 0;
  }
  powerOff() {
    this.active = null;
    this.phase = 'off';
    this.device.powerOff();
  }

  crash(err) {
    this.panic = err;
    this.phase = 'panic';
    this.timer = 0;
    this.device.serial(`[E][panic] ${err && err.message}`, 'error');
    if (err && err.stack) for (const l of String(err.stack).split('\n').slice(0, 6)) this.device.serial('  ' + l.trim(), 'error');
    const L = this.device.display;
    L.fillScreen(color565(20, 40, 90));
    L.drawString(6, 6, 'Guru Meditation Error', color565(255, 220, 120), 1);
    L.drawString(6, 20, (this.active?.name || 'fw') + ' crashed', color565(255, 255, 255), 1);
    const msg = String(err && err.message || err);
    L.drawString(6, 34, msg.slice(0, 38), color565(255, 170, 170), 1);
    L.drawString(6, 44, msg.slice(38, 76), color565(255, 170, 170), 1);
    L.drawString(6, 60, 'PC : 0x' + (0x40000000 + (Math.random() * 0xfffff | 0)).toString(16), color565(180, 200, 255), 1);
    L.drawString(6, 70, 'EXCVADDR: 0x' + (Math.random() * 0xffff | 0).toString(16), color565(180, 200, 255), 1);
    L.drawString(6, 86, 'Backtrace:', color565(140, 200, 255), 1);
    for (let i = 0; i < 3; i++) L.drawString(14, 96 + i * 10, '0x' + (0x42000000 + (Math.random() * 0xfffff | 0)).toString(16) + ':0x' + (Math.random() * 0xffff | 0).toString(16), color565(120, 170, 220), 1);
    L.drawString(6, 124, '[ any key ] back to launcher', color565(220, 220, 220), 1);
    this.emit('panic', msg);
  }
  safe(fn) { try { return fn(); } catch (e) { this.crash(e); return null; } }

  // ----------------------------------------------------------------- tick ---
  tick(dt) {
    this.timer += dt;
    this.frame++;
    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) { this.fps = this._fpsFrames / this._fpsAcc; this._fpsAcc = 0; this._fpsFrames = 0; }
    const dev = this.device;
    if (this.phase === 'off') return;
    if (this.phase === 'boot') { if (this.timer > 0.45) { this.phase = 'splash'; this.timer = 0; } return; }
    if (this.phase === 'splash') { this.splash(); if (this.timer > 1.6) { this.timer = 0; this._chime = true; this.launch(this.launcherId); } return; }
    if (this.phase === 'panic') {
      const keys = dev.keyboard.takeEvents();
      if (this.timer > 0.6 && keys.some(k => k.type === 'down')) this.exit();
      return;
    }
    if (this.phase === 'run' && this.active) {
      const evs = dev.keyboard.takeEvents();
      const chars = dev.keyboard.takeChars();
      this.api._input = { events: evs, chars, state: dev.keyboard.keyState() };
      this.api._dt = dt;
      const t0 = performance.now();
      this.safe(() => this.active.loop && this.active.loop(this.api, dt));
      // A loop() that stops returning is exactly what trips the task watchdog on real
      // silicon; measure it and feed the WDT only when the frame came back.
      this.loopMs = performance.now() - t0;
      if (this.phase === 'run') {
        if (this.loopMs > 400) {
          this.slowFrames++;
          if (this.slowFrames >= 3) {
            dev.wdt.trips++;
            this.slowFrames = 0;
            dev.serial('[E][wdt] Task watchdog got triggered: loop() blocked for ' + Math.round(this.loopMs) + ' ms', 'error');
            this.crash(new Error('Task watchdog timeout (loop() blocked ' + Math.round(this.loopMs) + ' ms)'));
            return;
          }
        } else this.slowFrames = 0;
        dev.feedWatchdog();
      }
      if (this.active && this.active.onKey) {
        for (const ev of evs) if (ev.type === 'down') this.safe(() => this.active.onKey(ev, this.api));
      }
      if (this.phase === 'run') this.api._input = { events: [], chars: [], state: dev.keyboard.keyState() };
    }
  }

  /** @type {(evt: string, payload?: any) => void} UI event sink (set by main.js) */
  onEvent(evt, payload) { void evt; void payload; }
  emit(evt, payload) { try { this.onEvent(evt, payload); } catch (e) { console.error(e); } }

  // ------------------------------------------------------------------ api ---
  get api() {
    if (this._api) return this._api;
    const self = this;
    const dev = this.device;
    const L = dev.display;

    const lcd = {
      get width() { return L.w; }, get height() { return L.h; },
      fillScreen: c => L.fillScreen(c), clear: () => L.fillScreen(COLORS.BLACK),
      fillRect: (x, y, w, h, c) => L.fillRect(x, y, w, h, c),
      drawRect: (x, y, w, h, c) => L.drawRect(x, y, w, h, c),
      fillRoundRect: (x, y, w, h, r, c) => L.fillRoundRect(x, y, w, h, r, c),
      drawRoundRect: (x, y, w, h, r, c) => L.drawRoundRect(x, y, w, h, r, c),
      drawLine: (x0, y0, x1, y1, c) => L.drawLine(x0, y0, x1, y1, c),
      drawCircle: (x, y, r, c) => L.drawCircle(x, y, r, c),
      fillCircle: (x, y, r, c) => L.fillCircle(x, y, r, c),
      drawPixel: (x, y, c) => L.pixel(x, y, c),
      drawString: (x, y, s, c, sz) => L.drawString(x, y, s, c, sz),
      drawCentreString: (s, cx, y, c, sz) => L.drawCentreString(s, cx, y, c, sz),
      drawRightString: (s, rx, y, c, sz) => L.drawRightString(s, rx, y, c, sz),
      setTextColor: (fg, bg) => L.setTextColor(fg, bg ?? null),
      setTextSize: s => L.setTextSize(s),
      setCursor: (x, y) => L.setCursor(x, y),
      setRotation: r => L.setRotation(r),
      print: s => L.print(s), println: (s = '') => L.println(s),
      textWidth: (s, sz) => L.textWidth(s, sz),
      setBrightness: v => L.setBacklight(clamp(v, 0, 1)),
      getBrightness: () => L.backlight,
      color565, COLORS,
      scroll: dy => L.scroll(dy),
      drawBar: (x, y, w, h, pct, c, bg = COLORS.DARKGREY) => { L.fillRect(x, y, w, h, bg); L.fillRect(x, y, Math.round(w * clamp(pct, 0, 1)), h, c); },
    };

    const api = {
      _input: { events: [], chars: [], state: dev.keyboard.keyState() },
      _dt: 0.016,
      device: dev,
      runtime: self,
      version: self.version,
      // ---- the M5-ish facade -------------------------------------------------
      M5: {
        Lcd: lcd, Display: lcd,
        Keyboard: {
          isPressed: () => dev.keyboard.held.size > 0,
          isChange: () => api._input.events.length > 0,
          keysState: () => api._input.state,
          getKey: () => api._input.state.word.join(''),
          takeEvents: () => api._input.events,
          isKeyPressed: id => dev.keyboard.isDown(id),
        },
        Speaker: {
          tone: (f, ms = 200, wave = 'square', vol) => dev.speaker.tone(f, ms, wave, vol),
          setVolume: v => dev.speaker.setVolume(v),
          getVolume: () => dev.speaker.volume,
          stop: () => dev.speaker.stop(),
          isEnabled: () => dev.speaker.audible,
          playSamples: (s, rate) => dev.speaker.play(s, rate),
        },
        Mic: {
          record: (ms, rate) => dev.mic.record(ms, rate),
          getLevel: () => dev.mic.level(),
          rms: s => dev.mic.rms(s),
        },
        Imu: {
          available: () => dev.imu.present,
          getAccel: () => dev.imu.getAccel(),
          getGyro: () => dev.imu.getGyro(),
          getTilt: () => ({ ...dev.imu.tilt }),
        },
        IR: { sendNec: (a, c) => dev.ir.sendNec(a, c), sendRaw: p => dev.ir.sendRaw(p), get log() { return dev.ir.log; } },
        Power: {
          getBatteryLevel: () => Math.round(dev.power.percent),
          getBatteryVoltage: () => dev.power.volts,
          isCharging: () => dev.power.charging,
          setLed: (r, g, b) => dev.setLed(r, g, b),
          lightSleep: () => { dev.mode = 'sleep'; dev.display.sleep(true); },
          wake: () => { dev.mode = 'run'; dev.display.sleep(false); },
          get isUsb() { return dev.usbConnected; },
        },
        Ex_I2C: {
          scan: () => dev.buses.grove.scan(),
          readBytes: (addr, n) => dev.buses.grove.readBytes(addr, n),
          readRegister: (addr, reg, n) => dev.buses.grove.readReg(addr, reg, n),
          writeRegister: (addr, reg, v) => dev.buses.grove.writeReg(addr, reg, v),
          writeBytes: (addr, bytes) => dev.buses.grove.writeBytes(addr, bytes),
          getSDA: () => 2, getSCL: () => 1,
        },
        In_I2C: {
          scan: () => dev.buses.internal.scan(),
          readRegister: (addr, reg, n) => dev.buses.internal.readReg(addr, reg, n),
          writeRegister: (addr, reg, v) => dev.buses.internal.writeReg(addr, reg, v),
        },
        Sd: {
          isMounted: () => dev.sd.inserted,
          open: p => ({ read: () => dev.sd.readText(p) }),
          readFile: p => dev.sd.readText(p),
          writeFile: (p, s) => dev.sd.writeText(p, s),
          appendFile: (p, s) => dev.sd.append(p, s),
          listDir: p => dev.sd.list(p || '/'),
          info: () => dev.sd.info(),
          mkdir: p => dev.sd.mkdir(p), remove: p => dev.sd.remove(p),
        },
        BtnA: { isPressed: () => dev.keyboard.isDown('enter'), wasPressed: () => api._input.events.some(e => e.id === 'enter') },
      },
      // ---- conveniences apps actually use ------------------------------------
      lcd, COLORS, color565,
      get width() { return L.w; }, get height() { return L.h; },
      keys() { return api._input.events; },
      // Edge-triggered navigation state for the current frame. Cardputer has no
      // dedicated arrow keys: they live on the Fn layer (Fn+; . , /) so both the
      // Fn layer and synthetic 'up'/'down' events are accepted here.
      input() {
        const s = api._input.state;
        const ids = new Set(api._input.events.filter(e => e.type === 'down').map(e => e.id));
        const fnHit = id => ids.has(id) && dev.keyboard.modifiers().fn;
        return {
          up: fnHit(';') || ids.has('up'),
          down: fnHit('.') || fnHit("'") || ids.has('down'),
          left: fnHit(',') || ids.has('left'),
          right: fnHit('/') || ids.has('right'),
          enter: ids.has('enter'),
          esc: fnHit('`') || ids.has('esc'),
          backspace: ids.has('backspace'),
          tab: ids.has('tab'),
          space: ids.has('space'),
          fn: s.fn, shift: s.shift, ctrl: s.ctrl,
          any: ids.size > 0,
          ids: [...ids],
        };
      },
      chars() { return api._input.chars; },
      state() { return api._input.state; },
      pressed(id) { return dev.keyboard.isDown(id); },
      typed() { return api._input.chars.join(''); },
      fn() { return api._input.state.fn; },
      serial: {
        println: (s = '') => dev.serial(`[${self.active?.name || 'app'}] ${s}`, 'app'),
        printf: (fmt, ...a) => dev.serial(`[${self.active?.name || 'app'}] ` + fmt.replace(/%[sdifx]/g, m => String(a.shift())), 'app'),
        flush: () => { },
      },
      millis: () => Math.round(dev.uptime * 1000),
      micros: () => Math.round(dev.uptime * 1e6),
      delay: () => { /* cooperative: never blocks the emulator */ },
      random: (a = 0, b = 1) => (b === undefined || a === b ? Math.random() * a : a + Math.random() * (b - a)),
      map: (v, a1, a2, b1, b2) => b1 + ((v - a1) * (b2 - b1)) / (a2 - a1 || 1),
      constrain: (v, a, b) => clamp(v, a, b),
      // ---- peripherals -------------------------------------------------------
      modules: {
        list: () => dev.modules.map(m => ({ uuid: m.uuid, id: m.def.id, name: m.def.name, eco: m.def.eco, state: m.inst.state })),
        has: id => !!dev.findModule(id),
        find: id => { const m = dev.findModule(id); return m ? m.inst : null; },
        state: id => dev.moduleState(id),
        require: id => {
          const m = dev.findModule(id);
          if (!m) throw new Error(`module "${id}" is not attached — plug it in on the Grove port`);
          return m.inst;
        },
        all: () => dev.modules,
        catalog: () => dev.catalog || [],
      },
      gpio: {
        digitalRead: p => dev.digitalRead(p),
        analogRead: p => dev.analogRead(p),
        digitalWrite: (p, v) => dev.digitalWrite(p, v),
      },
      uart: {
        // A UART unit can sit on the Grove port of every Cardputer, or on the EXT
        // header of an Adv. Bytes the module writes back are drained with read().
        available: () => !!(dev.buses.uartExt.client || dev.buses.uartGrove.client),
        bus: () => (dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove),
        send: s => (dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove).send(s),
        pending: () => (dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove).pending(),
        read: n => (dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove).read(n),
        readString: n => new TextDecoder().decode(Uint8Array.from((dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove).read(n))),
        flush: () => (dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove).flush(),
        setBaud: b => { const u = dev.buses.uartExt.client ? dev.buses.uartExt : dev.buses.uartGrove; u.baud = b; },
      },
      wifi: {
        available: () => dev.radio.hasWifi,
        scan: () => dev.radio.scan(),
        connect: (ssid, pass) => dev.radio.connect(ssid, pass),
        disconnect: () => dev.radio.disconnect(),
        status: () => ({ state: dev.radio.state, ssid: dev.radio.ssid, ip: dev.radio.ip, rssi: dev.radio.rssi }),
        bleScan: () => dev.radio.bleScan(),
      },
      http: {
        get: async (url) => {
          if (!self.fetcher) throw new Error('no network backend available');
          return self.fetcher(url);
        },
      },
      sd: api0(dev),
      power: {
        percent: () => Math.round(dev.power.percent),
        voltage: () => dev.power.volts,
        charging: () => dev.power.charging,
        milliamps: () => dev.power.milliamps,
        capacity: () => dev.power.capacityMah,
        led: (r, g, b) => dev.setLed(r, g, b),
      },
      apps: {
        list: () => [...self.apps.values()].map(a => ({ id: a.id, name: a.name, icon: a.icon, category: a.category, version: a.version, system: !!a.system })),
        launch: id => self.launch(id),
        current: () => self.active?.id,
      },
      // watchdog + thermal are visible to firmware, like esp_task_wdt / temperatureRead()
      wdt: {
        enabled: () => dev.wdt.enabled,
        setTimeout: ms => { dev.wdt.timeoutMs = clamp(Number(ms) || 5000, 500, 60000); },
        feed: () => dev.feedWatchdog(),
        trips: () => dev.wdt.trips,
      },
      thermal: {
        dieC: () => +dev.thermal.dieC.toFixed(1),
        ambientC: () => dev.thermal.ambientC,
        throttled: () => dev.thermal.throttled,
        cpuMhz: () => (dev.thermal.throttled ? 160 : dev.variant.mhz),
      },
      // flash/NVS/OTA surface: a firmware app can read its own partition state or
      // hand the emulator a new program to install, exactly like a self-updater.
      flash: {
        info: () => (self.flash ? self.flash.info() : null),
        slot: () => (self.flash ? self.flash.slot : null),
        switchSlot: () => (self.flash ? self.flash.switchSlot() : { ok: false }),
        nvs: {
          get: (k, d = null) => (self.flash ? self.flash.nvs.get(k, d) : d),
          set: (k, v) => (self.flash ? self.flash.nvs.set(k, v) : false),
          erase: k => (self.flash ? self.flash.nvs.erase(k) : false),
          list: () => (self.flash ? self.flash.nvs.entries() : []),
        },
        install: (source, meta) => (self.flash ? self.flash.installApp(source, meta) : Promise.resolve({ ok: false, error: 'no flash backend' })),
      },
      ir: {
        rangeCm: angle => dev.ir.rangeCm(angle),
        captures: () => dev.ir.captures.slice(-8),
        learn: (bytes, opts) => dev.ir.learnNec(bytes, opts),
        replay: i => { const f = dev.ir.captures.slice(-8)[i ?? -1]; if (f) { dev.ir.sendRaw(f.pulses); return true; } return false; },
      },
      exit: () => self.exit(),
      reboot: () => self.reboot(),
      notify: (msg, level = 'info') => { dev.serial(`[I][ui] ${msg}`, level); self.emit('toast', { msg, level }); },
      crash: e => self.crash(e),
      // simple reusable widgets so app code stays short
      ui: makeWidgets(lcd, COLORS),
    };
    function api0(d) {
      return {
        mounted: () => d.sd.inserted,
        read: p => d.sd.readText(p),
        write: (p, s) => d.sd.writeText(p, s),
        list: p => d.sd.list(p),
        info: () => d.sd.info(),
      };
    }
    this._api = api;
    return api;
  }
}

function makeWidgets(lcd, C) {
  return {
    header(title, right = '') {
      lcd.fillRect(0, 0, lcd.width, 13, C.PANEL);
      lcd.drawString(3, 3, title, C.WHITE, 1);
      if (right) lcd.drawRightString(right, lcd.width - 3, 3, C.AMBER, 1);
    },
    footer(text) {
      lcd.fillRect(0, lcd.height - 11, lcd.width, 11, C.PANEL);
      lcd.drawString(3, lcd.height - 9, text, C.LIGHTGREY, 1);
    },
    statusBar(dev) {
      const pct = Math.round(dev.power.percent);
      lcd.fillRect(0, 0, lcd.width, 10, C.PANEL);
      lcd.drawString(2, 2, dev.variant.sku, C.LIGHTGREY, 1);
      lcd.drawRightString(`${pct}%${dev.power.charging ? '+' : ''}`, lcd.width - 2, 2, pct < 20 ? C.RED : C.GREEN, 1);
      lcd.drawRightString(dev.wifiIcon ? 'wifi' : '', lcd.width - 40, 2, C.CYAN, 1);
    },
    list(items, sel, { x = 4, y = 16, w = 232, rowH = 12, color = C.WHITE, selColor = C.AMBER } = {}) {
      items.forEach((it, i) => {
        const yy = y + i * rowH;
        if (yy + rowH > lcd.height - 12) return;
        if (i === sel) {
          lcd.fillRect(x - 2, yy - 1, w, rowH, C.PANEL);
          lcd.fillRect(x - 2, yy - 1, 2, rowH, selColor);
        }
        lcd.drawString(x + 2, yy + 1, String(it.label ?? it), i === sel ? selColor : color, 1);
        if (it.right) lcd.drawRightString(String(it.right), x + w - 4, yy + 1, i === sel ? selColor : C.GREY, 1);
      });
    },
    gauge(x, y, w, h, pct, fg = C.GREEN, bg = C.DARKGREY) {
      lcd.fillRect(x, y, w, h, bg);
      lcd.fillRect(x, y, Math.round(w * clamp(pct, 0, 1)), h, fg);
    },
  };
}
