// =============================================================================
//  Bootstrap: builds the device, the firmware runtime, the chassis and panels.
// =============================================================================
import { Cardputer, VARIANTS } from './core/device.js';
import { Runtime } from './rt/runtime.js';
import { BUILTIN_APPS } from './apps/apps.js';
import { MODULE_CATALOG } from './modules/modules.js';
import { Chassis, AudioOut } from './ui/chassis.js';
import { SidePanels } from './ui/panels.js';
import { EmuUpdater } from './ui/updater.js';
import { FlashManager } from './core/flash.js';
import { clamp } from './core/util.js';

const VERSION = '1.0.0';

// ---------------------------------------------------------- persistence -----
// Sandboxed iframes (e.g. the Arena preview) throw on localStorage access, so
// every call goes through this guard.
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

const localStore = {
  key: 'cardputer-emu.sd',
  load() { try { return JSON.parse(LS.get(this.key) || 'null'); } catch { return null; } },
  save(v) { LS.set(this.key, JSON.stringify(v)); },
};
const nativeApi = {
  available: false,
  async probe() {
    if (typeof location !== 'undefined' && location.protocol === 'file:') return null;   // single-file mode
    if (!document.querySelector('meta[name="cardputer-native"]')) return null;           // preview / static host
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || !j.native) return null;
      this.available = true;
      this.info = j;
      return j;
    } catch { return null; }
  },
  async loadState() {
    try { const r = await fetch('/api/state', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
  },
  async saveState(state) {
    try { await fetch('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) }); } catch { /* ignore */ }
  },
};

// NVS + installed user programs live next to the SD card state: native launcher
// when there is one, localStorage in the single-file build.
function makeFlashStore() {
  if (nativeApi.available) {
    return {
      load: () => (stateCache && stateCache.flash) || null,
      save: v => { stateCache = { ...(stateCache || {}), flash: v }; queueSave(); },
    };
  }
  return {
    key: 'cardputer-emu.flash',
    load() { try { return JSON.parse(LS.get(this.key) || 'null'); } catch { return null; } },
    save(v) { LS.set(this.key, JSON.stringify(v)); },
  };
}

function makeSdStore() {
  if (nativeApi.available) {
    return {
      load: () => (stateCache && stateCache.sd) || null,
      save: v => { stateCache = { ...(stateCache || {}), sd: v }; queueSave(); },
    };
  }
  return localStore;
}

let stateCache = null;
let saveTimer = null;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap = { ...(stateCache || {}), ...app.snapshot() };
    stateCache = snap;
    if (nativeApi.available) nativeApi.saveState(snap);
    else LS.set('cardputer-emu.state', JSON.stringify(snap));
  }, 400);
}

// --------------------------------------------------------------- the app ----
export const app = {
  device: null, runtime: null, chassis: null, panels: null, updater: null,
  audio: null, startTime: 0, fps: 0,
  snapshot() {
    return {
      settings: {
        variant: this.device.variantId,
        channel: this.updater.channel,
        autoUpdate: this.updater.auto,
        feed: this.updater.feedUrl,
        volume: this.device.speaker.volume,
        backlight: this.device.display.backlight,
        battery: this.device.power.percent,
        modules: this.device.modules.map(m => m.def.id),
        sdInserted: this.device.sd.inserted,
        usb: this.device.usbConnected,
        jack: this.device.audioJack,
        grove5v: this.device.grove5v,
      },
    };
  },
};

async function boot() {
  const native = await nativeApi.probe();
  stateCache = native ? await nativeApi.loadState() : (() => {
    try { return JSON.parse(LS.get('cardputer-emu.state') || 'null'); } catch { return null; }
  })();
  const settings = stateCache?.settings || {};

  const device = new Cardputer({
    variant: settings.variant || 'adv',
    catalog: MODULE_CATALOG,
    store: { sd: makeSdStore() },
  });
  const audio = new AudioOut();
  const runtime = new Runtime(device, { apps: BUILTIN_APPS, version: native?.version || VERSION, fetcher: makeFetcher(native) });
  const flash = new FlashManager(device, runtime, { store: makeFlashStore() });
  runtime.flash = flash;
  flash.bus.on('log', line => device.serial('[flash] ' + line, 'info'));
  const updater = new EmuUpdater({
    device, runtime,
    native: native ? { version: native.version, channel: settings.channel || native.channel, feed: native.feed, autoUpdate: native.autoUpdate ?? true } : null,
    feedUrl: settings.feed || 'updates/manifest.json',
    channel: settings.channel || 'stable',
    version: native?.version || VERSION,
  });
  app.device = device; app.runtime = runtime; app.audio = audio; app.updater = updater; app.flash = flash;

  // feed-delivered firmware apps survive restarts
  updater.onSoft = urls => { stateCache = { ...(stateCache || {}), settings: { ...(stateCache?.settings || {}), installedApps: urls } }; queueSave(); };
  for (const url of settings.installedApps || []) {
    updater.loadApp(url).catch(e => console.warn('app restore failed', url, e.message));
  }

  // ---- speakers / module sounds
  device.speaker.bus.on('tone', t => audio.tone(t));
  device.bus.on('module-event', ({ id, evt, payload }) => {
    if (evt === 'relay') audio.click(2.2);
    if (evt === 'buzz') audio.tone({ freq: payload.freq || 2400, ms: 120, wave: 'square', vol: 0.4, audible: true });
    if (evt === 'rfid') audio.tone({ freq: 1800, ms: 60, wave: 'sine', vol: 0.3, audible: true });
    if (evt === 'button') audio.click(1.4);
    if (evt === 'pir') audio.click(0.7);
    toast(`${id}: ${evt}`);
  });
  device.ir.bus.on('tx', e => app.chassis?.flashIr());

  // ---- chassis + panels
  const chassisRoot = document.querySelector('#deviceStage');
  const chassis = new Chassis(chassisRoot, device, audio);
  app.chassis = chassis;

  const panels = new SidePanels(document.querySelector('#console'), {
    device, runtime, updater, variants: VARIANTS,
    // runtime.fps is the measured LCD frame rate (app.fps was never updated -> always 0)
    fps: () => app.runtime.fps,
    toast: (msg, lvl) => toast(msg, lvl),
    onRefresh: () => { chassis.refresh(); refreshStatus(); panels.refreshLive(); },
    onRgb: () => { },
    flash,
    setVariant: id => {
      const res = device.setVariant(id);
      if (!res.ok) { toast(res.error, 'error'); return res; }
      if (!res.changed) return res;
      runtime.reboot();
      panels.render(); chassis.refresh(); refreshStatus(); queueSave();
      const n = res.ejected.length;
      toast(`swapped to ${VARIANTS[id].label}` + (n ? ` — ${n} module${n > 1 ? 's' : ''} unplugged (not physically supported)` : ''),
        n ? 'warn' : 'ok');
      for (const e of res.ejected) device.serial(`[W][board] ${e.name} unplugged: ${e.reason}`, 'warn');
      return res;
    },
    setGrove5v: v => { const r = device.setGrove5v(v); panels.render(); chassis.refresh(); return r; },
    setPower: v => v ? runtime.reboot() : runtime.powerOff(),
    setUsb: v => { device.setUsb(v); chassis.refresh(); },
    setJack: v => { device.setAudioJack(v); chassis.refresh(); },
    useRealMic: async () => {
      const ok = await audio.enableMic(device);
      toast(ok ? 'host microphone routed to the MEMS/ES8311 ADC' : 'microphone permission denied', ok ? 'ok' : 'error');
    },
    reboot: () => { runtime.reboot(); toast('rebooting…'); },
    factoryReset: () => {
      LS.del('cardputer-emu.state');
      LS.del('cardputer-emu.sd');
      if (nativeApi.available) fetch('/api/reset', { method: 'POST' }).catch(() => { });
      toast('factory reset — reloading');
      setTimeout(() => location.reload(), 600);
    },
  });
  app.panels = panels;
  panels.setTab(location.hash === '#updates' ? 'updates' : 'modules');

  chassis.onRail = action => {
    switch (action) {
      case 'power': device.power.switchOn ? runtime.powerOff() : (device.powerOn(), runtime.boot()); break;
      case 'reset': runtime.reboot(); toast('reset'); break;
      case 'boot': device.enterDownloadMode(); toast('download mode: waiting for esptool'); break;
      case 'usb': device.setUsb(!device.usbConnected); break;
      case 'sd': device.sd.inserted ? device.sd.eject() : device.sd.insert(); toast(device.sd.inserted ? 'microSD mounted' : 'microSD ejected'); break;
      case 'jack': device.setAudioJack(!device.audioJack); break;
      case 'grove': panels.setTab('modules'); break;
    }
    chassis.refresh();
    panels.render();
    refreshStatus();
    queueSave();
  };

  // ---- device events -> UI
  device.bus.on('serial', () => { if (panels.tab === 'serial') panels.renderSerialLines(); });
  device.bus.on('modules-changed', () => { chassis.refresh(); refreshStatus(); if (panels.tab === 'modules') panels.render(); });
  device.bus.on('power', () => { chassis.refresh(); refreshStatus(); });
  device.bus.on('mode', () => { chassis.refresh(); });
  device.bus.on('brownout', () => {
    runtime.powerOff();
    toast('brownout: battery below 3.35 V — charge it or enable USB', 'error');
  });
  device.bus.on('variant', () => { chassis.refresh(); refreshStatus(); queueSave(); });
  device.bus.on('grove5v', () => { panels.render(); });
  device.bus.on('led', () => chassis.refresh());
  device.bus.on('tick', () => { });
  runtime.onEvent = (evt, payload) => {
    if (evt === 'toast') toast(payload.msg, payload.level);
    if (evt === 'launch') refreshStatus();
    if (evt === 'panic') toast('firmware crashed — any key returns to launcher', 'error');
  };

  // ---- restore persisted state
  device.speaker.setVolume(settings.volume ?? 0.7);
  device.display.setBacklight(settings.backlight ?? 1);
  if (settings.battery != null) device.power.percent = settings.battery;
  if (settings.sdInserted) device.sd.insert();
  for (const id of settings.modules || []) device.attachModule(id);
  if (settings.jack) device.setAudioJack(true);
  if (settings.usb) device.setUsb(true);

  const footNative = document.querySelector('#footNative');
  if (footNative) footNative.textContent = native
    ? `native launcher · ${native.platform} · python ${native.python}`
    : 'browser mode — catalog + app updates only (use `python run.py` for core updates)';

  runtime.boot();
  flash.restoreApps().then(ids => { if (ids.length) toast(`restored ${ids.length} installed program(s)`); });
  app.startTime = performance.now();
  refreshStatus();
  startLoop();

  // ---- apply the soft payload that belongs to the installed version --------
  // (a launcher-driven core update swaps files on disk; the catalog/apps that
  //  version promised still have to be loaded into this page)
  (async () => {
    try {
      const feed = await updater.fetchFeed();
      const rel = (feed?.releases || []).find(r => r.version === updater.version);
      if (rel?.soft) {
        const apps = [...new Set([...(rel.soft.apps || []), ...(settings.installedApps || [])])];
        const log = await updater.applySoft({ ...rel.soft, apps });
        if (log.length) { updater.relay(log); updater.onChange(); }
      }
    } catch { /* feed unavailable — run with what we have */ }
  })();

  // ---- auto update on launch
  if (updater.auto) {
    const r = await updater.check().catch(() => null);
    if (r?.available) toast(`v${r.available.version} available — see Updates`, 'ok');
  }

  // one-click SKU swap from the status bar (the System tab has the full picker)
  const variantPill = document.querySelector('#statusVariant');
  if (variantPill) {
    variantPill.addEventListener('click', () => {
      const order = ['cardputer', 'v11', 'adv'];
      const next = order[(order.indexOf(device.variantId) + 1) % order.length];
      panels.ctx.setVariant(next);
      panels.setTab('system');
    });
  }

  // global shortcuts
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyU') { e.preventDefault(); panels.setTab('updates'); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); panels.setTab('serial'); }
    if (e.key === 'F1') { e.preventDefault(); panels.setTab('help'); }
    if (e.key === 'F2') { e.preventDefault(); panels.setTab('modules'); }
  });
  // Automation/CI hook: the Playwright harness and the serial console use this.
  /** @type {any} */ (window).__emu = app;
}

function makeFetcher(native) {
  return async url => {
    const target = native?.available ? `/api/proxy?url=${encodeURIComponent(url)}` : url;
    const r = await fetch(target, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  };
}

// ------------------------------------------------------------------ loop ----
let last = 0;
function startLoop() {
  const step = now => {
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    if (app.device.mode !== 'off') {
      app.device.tick(dt);
      app.runtime.tick(dt);
    }
    app.chassis.tick(dt);
    app.panels.tick(dt);
    app.fps = app.runtime.fps;
    app._acc = (app._acc || 0) + dt;
    if (app._acc > 0.25) { app._acc = 0; refreshStatus(); }
    requestAnimationFrame(step);
  };
  last = performance.now();
  requestAnimationFrame(step);
}

// --------------------------------------------------------------- status -----
function refreshStatus() {
  const d = app.device, u = app.updater;
  const q = s => document.querySelector(s);
  const set = (sel, v) => { const el = q(sel); if (el && el.textContent !== v) el.textContent = v; };
  if (!d) return;
  set('#statusVariant', d.variant.label);
  set('#statusBattery', `${d.power.percent.toFixed(0)}%${d.power.charging ? ' ⚡' : ''}`);
  set('#statusModules', `${d.modules.length} module${d.modules.length === 1 ? '' : 's'}`);
  set('#statusApp', app.runtime.active?.name || '—');
  set('#statusVer', 'v' + (u?.version || VERSION));
  set('#statusState', d.mode === 'off' ? 'powered off' : d.mode === 'download' ? 'download mode' : 'running');
  const dot = q('#statusDot');
  if (dot) dot.className = 'dot ' + (d.mode === 'off' ? 'off' : d.mode === 'download' ? 'dl' : 'run');
  const batteryEl = q('#statusBattery');
  if (batteryEl) batteryEl.classList.toggle('low', d.power.percent < 20);
}

// ---------------------------------------------------------------- toast -----
let toastTimer = null;
function toast(msg, level = 'info') {
  const wrap = document.querySelector('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + level;
  el.textContent = msg;
  wrap.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3100);
  while (wrap.children.length > 4) wrap.firstChild.remove();
  clearTimeout(toastTimer);
}

boot().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<pre style="position:fixed;inset:20px;background:#200;color:#f88;padding:20px;z-index:9999;overflow:auto">Boot failed:\n${err.stack || err}</pre>`);
});

export { VERSION };
