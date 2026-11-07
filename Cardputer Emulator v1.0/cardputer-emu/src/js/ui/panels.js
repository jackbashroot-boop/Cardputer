// =============================================================================
//  Right-hand console: Modules (hot-plug rack), System, Serial, Updates, Help.
// =============================================================================
import { ECOSYSTEMS, mergeCatalog } from '../modules/modules.js';
import { escapeHtml, fmtBytes, hex } from '../core/util.js';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const fmtVal = v => {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  // DataView has no length/iterator, so only index/flat views can be summarised.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const a = /** @type {number[] & {length: number}} */ (/** @type {unknown} */ (v));
    if (a.length > 8) {
      let mn = Infinity, mx = -Infinity;
      for (const x of a) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
      return `${a.length} cells · ${mn.toFixed(1)}…${mx.toFixed(1)}`;
    }
  }
  if (Array.isArray(v)) return '[' + v.slice(0, 4).map(x => fmtVal(x)).join(', ') + ']';
  if (typeof v === 'object') return escapeHtml(JSON.stringify(v).slice(0, 48));
  return String(v);
};

// Only the "physical" fields of a driver's state are interesting to a human.
const HIDDEN_STATE_KEYS = new Set(['frame', 'cmd', 'raw']);

export class SidePanels {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;                 // {device, runtime, updater, app}
    this.tab = 'modules';
    this.filter = 'all';
    this.search = '';
    this.serialPaused = false;
    this.serialFilter = '';
    this.build();
  }
  get device() { return this.ctx.device; }

  build() {
    const TABS = [
      ['modules', 'Modules'], ['flash', 'Flash'], ['bench', 'Bench'],
      ['system', 'System'], ['serial', 'Serial'], ['updates', 'Updates'], ['help', 'Help'],
    ];
    const nav = h('nav', { class: 'tabs' }, TABS.map(([id, label]) =>
      h('button', { class: 'tab' + (id === this.tab ? ' active' : ''), 'data-tab': id, onclick: () => this.setTab(id) }, label)));
    this.nav = nav;
    this.pane = h('div', { class: 'pane' });
    this.root.append(nav, this.pane);
    this.render();
  }
  setTab(id) {
    this.tab = id;
    for (const b of this.nav.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === id);
    this.render();
  }
  render() {
    const pane = this.pane;
    pane.innerHTML = '';
    pane.classList.remove('serial-pane');
    if (this.tab === 'modules') this.renderModules(pane);
    if (this.tab === 'flash') this.renderFlash(pane);
    if (this.tab === 'bench') this.renderBench(pane);
    if (this.tab === 'system') this.renderSystem(pane);
    if (this.tab === 'serial') this.renderSerial(pane);
    if (this.tab === 'updates') this.renderUpdates(pane);
    if (this.tab === 'help') this.renderHelp(pane);
  }

  // --------------------------------------------------------------- modules --
  renderModules(pane) {
    const d = this.device;
    const ports = h('div', { class: 'ports' },
      this.portChip('grove', d.slotOf('grove').length, 1),
      d.variant.ext ? this.portChip('ext', d.slotOf('ext').length, 1) : null,
      this.sdChip(),
    );
    pane.append(h('div', { class: 'pane-title' }, 'Hardware ports',
      h('span', { class: 'muted' }, 'plug and unplug while the firmware runs')));

    if (!d.variant.ext) {
      pane.append(h('div', { class: 'notice' }, 'This SKU has no EXT header — CAP modules need the Cardputer-Adv.'));
    }
    pane.append(ports);

    // ---- attached modules
    const attached = d.modules;
    pane.append(h('div', { class: 'pane-sub' }, `Attached (${attached.length})`));
    if (!attached.length) {
      pane.append(h('div', { class: 'empty-slot' }, 'Grove port is empty — attach a unit below to see it appear on the I²C bus.'));
    }
    for (const rec of attached) pane.append(this.moduleCard(rec));

    // ---- catalog
    const cats = ['all', 'sensor', 'actuator', 'input', 'radio'];
    const search = h('input', {
      class: 'search', type: 'search', placeholder: 'filter modules…', value: this.search,
      oninput: e => { this.search = e.target.value; this.renderRefreshCatalog(); },
    });
    this.catBar = h('div', { class: 'chipbar' }, cats.map(c =>
      h('button', { class: 'chip' + (this.filter === c ? ' active' : ''), onclick: () => { this.filter = c; this.render(); } }, c)));
    this.catalogList = h('div', { class: 'catalog' });
    pane.append(h('div', { class: 'pane-sub', style: 'margin-top:14px' },
      'Catalog',
      h('span', { class: 'muted' }, `${(d.catalog || []).length} modules · feed-refreshable`)), search, this.catBar, this.catalogList);
    this.renderRefreshCatalog();
  }

  renderRefreshCatalog() {
    if (!this.catalogList) return;
    const d = this.device;
    const list = (d.catalog || []).filter(def => {
      const s = this.search.toLowerCase();
      const hit = !s || (def.name + ' ' + def.sku + ' ' + (def.summary || '') + ' ' + def.id).toLowerCase().includes(s);
      const cat = this.filter === 'all' || (def.tags || []).includes(this.filter)
        || (this.filter === 'input' && (def.tags || []).includes('input'));
      return hit && cat;
    });
    this.catalogList.innerHTML = '';
    for (const def of list) {
      const check = d.checkAttach(def);
      const attachedAlready = !!d.findModule(def.id);
      const row = h('div', { class: 'cat-row' + (check.ok ? '' : ' blocked') },
        h('span', { class: 'mod-dot', style: `background:${def.color || '#64748b'}` }),
        h('div', { class: 'cat-main' },
          h('div', { class: 'cat-name' }, def.name, h('span', { class: 'sku' }, def.sku)),
          h('div', { class: 'cat-sum' }, def.summary || ''),
          h('div', { class: 'cat-meta' },
            h('span', { class: 'tag' }, ECOSYSTEMS[def.eco]?.label.split(' ')[0] || def.eco),
            (def.addrs || []).map(a => h('code', {}, hex(a.addr) + ' ' + a.chip)),
            def.transport !== 'i2c' ? h('span', { class: 'tag' }, def.transport.toUpperCase()) : null,
            def.requires === 'adv' ? h('span', { class: 'tag warn' }, 'ADV only') : null,
          ),
          check.ok ? null : h('div', { class: 'cat-why' }, '! ' + check.error),
        ),
        h('button', {
          class: 'btn tiny' + (check.ok ? ' primary' : ''),
          disabled: !check.ok || attachedAlready,
          onclick: () => this.plug(def.id),
        }, attachedAlready ? 'plugged' : 'plug'),
      );
      this.catalogList.append(row);
    }
    if (!list.length) this.catalogList.append(h('div', { class: 'empty-slot' }, 'no modules match this filter'));
  }

  portChip(eco, used, cap) {
    const e = ECOSYSTEMS[eco];
    return h('div', { class: 'port' + (used ? ' filled' : '') },
      h('div', { class: 'port-name' }, e.label),
      h('div', { class: 'port-count' }, `${used}/${cap}`),
      h('div', { class: 'port-note' }, e.note));
  }
  sdChip() {
    const d = this.device, info = d.sd.info();
    return h('div', { class: 'port' + (d.sd.inserted ? ' filled' : '') },
      h('div', { class: 'port-name' }, 'microSD'),
      h('div', { class: 'port-count' }, d.sd.inserted ? fmtBytes(info.used) : '—'),
      h('div', { class: 'port-note' }, d.sd.inserted ? `${fmtBytes(info.capacity)} FAT32` : 'no card inserted'),
      h('button', { class: 'btn tiny', onclick: () => { d.sd.inserted ? d.sd.eject() : d.sd.insert(); this.ctx.onRefresh?.(); this.render(); } },
        d.sd.inserted ? 'eject' : 'insert'));
  }

  moduleCard(rec) {
    const d = this.device, def = rec.def, inst = rec.inst;
    const state = inst.state || {};
    const keys = Object.keys(state).filter(k => !k.startsWith('_') && !HIDDEN_STATE_KEYS.has(k)).slice(0, 7);
    const card = h('div', { class: 'mod-card', 'data-uuid': rec.uuid },
      h('div', { class: 'mod-head' },
        h('span', { class: 'mod-dot', style: `background:${def.color || '#64748b'}` }),
        h('div', { class: 'mod-title' },
          h('div', { class: 'mod-name' }, def.name),
          h('div', { class: 'mod-sku' }, `${def.sku} · ${def.eco}${def.transport === 'uart' ? ' · UART' : def.transport === 'spi' ? ' · SPI' : ''}`)),
        h('button', { class: 'btn tiny danger', onclick: () => { d.detachModule(rec.uuid); this.ctx.onRefresh?.(); } }, 'unplug')),
      (def.addrs || []).length ? h('div', { class: 'addr-row' }, def.addrs.map(a => h('code', {}, `${hex(a.addr)} ${a.chip}`))) : null,
      keys.length ? h('div', { class: 'live-grid' },
        keys.map(k => h('div', { class: 'live-row' },
          h('span', { class: 'live-k' }, k.replace(/([A-Z])/g, ' $1').toLowerCase()),
          h('span', { class: 'live-v', 'data-live-uuid': rec.uuid, 'data-live-key': k }, fmtVal(state[k]))))) : null,
    );
    const controls = [...(def.controls || []), ...(inst.controls || [])];
    if (controls.length && inst.setControl) {
      const wrap = h('div', { class: 'controls' });
      for (const c of controls) {
        if (c.type === 'button') {
          wrap.append(h('button', {
            class: 'btn tiny', onclick: () => { d.setModuleControl(rec.uuid, c.id, true); this.refreshLive(); },
          }, c.label));
        } else if (c.type === 'color') {
          wrap.append(h('label', { class: 'ctl' }, h('span', {}, c.label),
            h('input', {
              type: 'color', value: inst.state?.[c.id] || '#22d3ee',
              oninput: e => { d.setModuleControl(rec.uuid, c.id, e.target.value); this.ctx.onRgb?.(e.target.value); },
            })));
        } else {
          const live = inst.state?.[c.id] ?? c.min;
          const out = h('span', { class: 'ctl-val' }, fmtVal(live) + (c.unit ? ' ' + c.unit : ''));
          wrap.append(h('label', { class: 'ctl' },
            h('span', {}, c.label),
            h('input', {
              type: 'range', min: c.min, max: c.max, step: c.step || 1, value: live,
              oninput: e => {
                const v = Number(e.target.value);
                d.setModuleControl(rec.uuid, c.id, v);
                out.textContent = fmtVal(v) + (c.unit ? ' ' + c.unit : '');
              },
            }), out));
        }
      }
      card.append(wrap);
    }
    return card;
  }

  refreshLive() {
    if (this.tab !== 'modules') return;
    for (const el of this.pane.querySelectorAll('[data-live-uuid]')) {
      const rec = this.device.modules.find(m => m.uuid === el.dataset.liveUuid);
      if (!rec) continue;
      const v = (rec.inst.state || {})[el.dataset.liveKey];
      const next = fmtVal(v);
      if (el.textContent !== next) el.textContent = next;
    }
  }

  plug(id) {
    const r = this.device.attachModule(id);
    this.ctx.onRefresh?.();
    if (!r.ok) this.ctx.toast?.(r.error, 'error');
    this.render();
  }

  // ---------------------------------------------------------------- system --
  renderSystem(pane) {
    const d = this.device, u = this.ctx.updater;
    // how many catalog entries each SKU could physically host (no state involved)
    const compatible = id => {
      const v = this.ctx.variants[id];
      return (d.catalog || []).filter(def => {
        if (def.requires === 'adv' && v.id !== 'adv') return false;
        if (def.requires === 'imu' && !v.imu) return false;
        if (def.requires === 'jack' && !v.jack) return false;
        if (def.eco === 'ext' && !v.ext) return false;
        if (def.needs5v && !v.groveToggle) return false;
        return true;
      }).length;
    };
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Hardware SKU',
        h('span', { class: 'muted' }, 'swap the board under the running firmware — no re-plugging needed')),
      h('div', { class: 'variant-grid' }, ['cardputer', 'v11', 'adv'].map(id => {
        const spec = this.ctx.variants[id];
        return h('button', {
          class: 'variant' + (d.variantId === id ? ' active' : ''),
          title: `switch to ${spec.label}`,
          onclick: () => { this.ctx.setVariant(id); this.render(); },
        },
          h('div', { class: 'variant-name' }, spec.label),
          h('div', { class: 'variant-sku' }, spec.sku + ' · ' + spec.year),
          h('div', { class: 'variant-feats' }, [
            spec.imu ? 'IMU' : null, spec.jack ? '3.5mm' : null, spec.ext ? 'EXT' : null,
            spec.groveToggle ? '5V toggle' : null,
            spec.keyboard === 'tca8418' ? 'TCA8418' : '74HC138', (spec.battery.total || 0) + 'mAh',
            compatible(id) + ' modules',
          ].filter(Boolean).join(' · ')));
      })),
      h('div', { class: 'muted small' }, 'Swapping rebuilds the pinmap, keyboard controller, audio path, IMU and EXT header. Modules the new SKU cannot host are unplugged and reported; the rest stay attached.')));

    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Hardware switches & ports'),
      h('div', { class: 'switch-grid' },
        this.toggle('Power switch', d.power.switchOn, v => this.ctx.setPower(v)),
        this.toggle('USB-C', d.usbConnected, v => this.ctx.setUsb(v)),
        this.toggle('microSD card', d.sd.inserted, v => { v ? d.sd.insert() : d.sd.eject(); this.ctx.onRefresh?.(); this.render(); }),
        this.toggle('3.5 mm jack', d.audioJack, v => this.ctx.setJack(v), d.variant.jack),
        this.toggle(d.variant.battery.base ? 'Battery base 1400 mAh' : 'Single 1500 mAh cell', true, () => { }, true),
        this.toggle('Grove rail 5 V', d.grove5v, v => this.ctx.setGrove5v(v), !d.variant.groveToggle),
      )));

    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Display & audio'),
      this.slider('Backlight', d.display.backlight, 0, 1, 0.01, v => { d.display.setBacklight(v); d.display.dirty = true; }, v => Math.round(v * 100) + '%'),
      this.slider('Speaker volume', d.speaker.volume, 0, 1, 0.01, v => d.speaker.setVolume(v), v => Math.round(v * 100) + '%'),
      h('div', { class: 'row' },
        h('button', { class: 'btn tiny', onclick: () => d.speaker.tone(440, 300) }, 'test tone'),
        h('button', { class: 'btn tiny', onclick: () => this.ctx.useRealMic() }, 'use host microphone'),
        h('button', { class: 'btn tiny', onclick: () => d.setLed(Math.floor(Math.random() * 255), Math.floor(Math.random() * 255), Math.floor(Math.random() * 255)) }, 'flash RGB LED'),
      )));

    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Power'),
      h('div', { class: 'batt' },
        h('div', { class: 'batt-bar' }, h('i', { style: `width:${d.power.percent}%` })),
        h('div', { class: 'batt-txt' }, `${d.power.percent.toFixed(1)} % · ${d.power.volts.toFixed(2)} V · ${d.power.milliamps.toFixed(0)} mA · ${d.power.charging ? 'charging' : 'discharging'}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn tiny', onclick: () => this.ctx.reboot() }, 'reboot (RST)'),
        h('button', { class: 'btn tiny', onclick: () => { d.enterDownloadMode(); this.ctx.onRefresh?.(); } }, 'download mode'),
        h('button', { class: 'btn tiny danger', onclick: () => this.ctx.factoryReset() }, 'factory reset'))));

    const info = [
      ['SKU', d.variant.sku], ['SoC', d.variant.soc], ['Flash', fmtBytes(d.variant.flashBytes)],
      ['Keyboard', d.variant.kbChip], ['Audio', d.variant.audio], ['IMU', d.variant.imu ? 'BMI270 @0x68' : '—'],
      ['Grove I²C', d.buses.grove.scan().map(a => hex(a)).join(' ') || '—'],
      ['Internal I²C', d.buses.internal.scan().map(a => hex(a)).join(' ') || '—'],
      ['Firmware', u.version], ['Uptime', `${Math.floor(d.uptime / 60)}m ${Math.floor(d.uptime % 60)}s`],
      ['FPS', (this.ctx.fps?.() || 0).toFixed(0)], ['CPU load', (d.cpuLoad * 100).toFixed(0) + '%'],
      ['Die temp', `${d.thermal.dieC.toFixed(1)} °C${d.thermal.throttled ? ' (throttled)' : ''}`],
      ['Battery est.', d.power.remainingMinutes() == null ? 'charging' : d.power.remainingMinutes() + ' min'],
      ['Watchdog', `${d.wdt.timeoutMs} ms · ${d.wdt.trips} trip(s)`],
    ];
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Inventory'),
      h('table', { class: 'kv' }, info.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v)))))));
  }

  toggle(label, on, fn, disabled = false) {
    return h('label', { class: 'toggle' + (disabled ? ' disabled' : '') },
      h('input', { type: 'checkbox', checked: on ? '' : null, disabled: disabled ? '' : null, onchange: e => { fn(e.target.checked); this.render(); } }),
      h('span', {}, label));
  }
  slider(label, value, min, max, step, fn, fmt = v => v) {
    const out = h('span', { class: 'ctl-val' }, fmt(value));
    return h('label', { class: 'ctl' }, h('span', {}, label),
      h('input', { type: 'range', min, max, step, value, oninput: e => { const v = Number(e.target.value); fn(v); out.textContent = fmt(v); } }), out);
  }

  // ---------------------------------------------------------------- serial --
  renderSerial(pane) {
    const d = this.device;
    pane.classList.add('serial-pane');
    const bar = h('div', { class: 'serial-bar' },
      h('input', {
        class: 'search', type: 'search', placeholder: 'grep…', value: this.serialFilter,
        oninput: e => { this.serialFilter = e.target.value; this.renderSerialLines(); },
      }),
      h('button', { class: 'btn tiny', onclick: () => { this.serialPaused = !this.serialPaused; this.render(); } }, this.serialPaused ? 'resume' : 'pause'),
      h('button', { class: 'btn tiny', onclick: () => { d.clearSerial(); this.render(); } }, 'clear'),
      h('button', { class: 'btn tiny', onclick: () => navigator.clipboard?.writeText(this.serialText()) }, 'copy'),
    );
    this.serialList = h('div', { class: 'serial', id: 'serialList' });
    pane.append(h('div', { class: 'pane-title' }, 'UART0 / USB-JTAG console',
      h('span', { class: 'muted' }, '115200 8N1')), bar, this.serialList);
    this.renderSerialLines();
  }
  serialText() {
    return this.device.serialBuf.map(l => `[${l.t.toFixed(3)}] ${l.msg}`).join('\n');
  }
  renderSerialLines() {
    if (!this.serialList) return;
    const f = this.serialFilter.toLowerCase();
    const lines = this.device.serialBuf.filter(l => !f || l.msg.toLowerCase().includes(f)).slice(-400);
    this.serialList.innerHTML = lines.map(l =>
      `<div class="sline ${l.level}"><span class="st">${l.t.toFixed(2)}</span>${escapeHtml(l.msg)}</div>`).join('');
    if (!this.serialPaused && this.serialList.scrollHeight > this.serialList.clientHeight + 2) {
      this.serialList.scrollTop = this.serialList.scrollHeight;
    }
  }

  // --------------------------------------------------------------- updates --
  renderUpdates(pane) {
    const u = this.ctx.updater;
    pane.append(h('div', { class: 'pane-title' }, 'Updates', h('span', { class: 'muted' }, u.hasNative ? 'native launcher connected' : 'browser mode (soft updates)')));
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'ver-row' },
        h('div', {}, h('div', { class: 'ver-big' }, 'v' + u.version), h('div', { class: 'muted' }, 'emulator + firmware')),
        h('div', { class: 'ver-status' }, u.available ? h('span', { class: 'badge up' }, 'v' + u.available.version + ' available') : h('span', { class: 'badge ok' }, 'up to date'))),
      h('div', { class: 'row' },
        h('label', { class: 'ctl inline' }, h('span', {}, 'channel'),
          h('select', { onchange: e => { u.setChannel(e.target.value); this.render(); } },
            ['stable', 'beta'].map(c => h('option', { value: c, selected: u.channel === c ? '' : null }, c)))),
        h('label', { class: 'ctl wide' }, h('span', {}, 'feed'),
          h('input', { class: 'search', value: u.feedUrl || 'updates/manifest.json', oninput: e => { u.feedUrl = e.target.value; } })),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { await u.check(); this.render(); } }, 'check now'),
        h('button', { class: 'btn', disabled: !u.available ? '' : null, onclick: async () => { await u.install(); this.render(); } }, 'install ' + (u.available ? 'v' + u.available.version : '')),
        h('button', { class: 'btn', onclick: async () => { await u.rollback(); this.render(); } }, 'rollback'),
        this.toggle('auto-update on launch', u.auto, v => u.setAuto(v)),
      ),
      h('div', { class: 'muted small' }, u.hasNative
        ? 'The launcher verifies each package with SHA-256, stages it, keeps the previous build for rollback, and applies it on next start.'
        : 'Opened straight from a file: core binaries cannot self-replace, but the module catalog and firmware apps still update.')));

    const feed = u._feed;
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Release feed'),
      feed?.releases?.length
        ? h('div', { class: 'rel-list' }, feed.releases.map(r => h('div', { class: 'rel' + (r.version === u.version ? ' current' : '') },
          h('div', { class: 'rel-head' }, h('b', {}, 'v' + r.version),
            h('span', { class: 'tag' }, r.channel), h('span', { class: 'muted' }, r.date || ''),
            r.version === u.version ? h('span', { class: 'badge ok' }, 'installed') : null),
          h('ul', { class: 'notes' }, (r.notes || []).map(n => h('li', {}, n))))))
        : h('div', { class: 'muted' }, 'No feed loaded yet — hit “check now”.')));

    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Module catalog'),
      h('div', { class: 'muted small' }, `Loaded: ${(this.device.catalog || []).length} module definitions. The catalog comes from the same feed, so new hardware support can land without a core update.`),
      h('div', { class: 'row' }, h('button', { class: 'btn tiny', onclick: async () => { await u.installSoft(); this.render(); } }, 'refresh from feed'))));

    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Firmware apps'),
      h('div', { class: 'app-list' }, [...this.ctx.runtime.apps.values()].map(a => h('div', { class: 'app-row' },
        h('span', { class: 'app-ic', style: `background:${a.color || '#64748b'}` }, a.icon || 'AP'),
        h('span', { class: 'app-name' }, a.name),
        h('span', { class: 'muted' }, a.category || ''),
        h('span', { class: 'tag' }, 'v' + (a.version || '1.0.0')))))));

    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Updater log'),
      h('div', { class: 'uplog' }, u.log.slice(0, 14).map(l => h('div', {}, h('span', { class: 'st' }, l.t), l.msg)))));
  }

  // ------------------------------------------------------------------ help --
  renderHelp(pane) {
    const rows = [
      ['Type letters / digits', 'press the matching key on the deck'],
      ['Shift', 'hold host Shift (or click SHIFT)'],
      ['Arrows', 'host arrow keys → Fn + ; . , /'],
      ['Esc / back', 'host Esc → Fn + `'],
      ['Fn layer', 'hold CapsLock, or click Fn on the deck'],
      ['Ctrl / Alt / Opt', 'host Ctrl / Alt / Meta'],
      ['Reset', 'RST button on the side rail'],
      ['Download mode', 'hold G0 while powering on (Flash tab)'],
      ['Install a program', 'Flash tab → editor, or drop a .js file on it'],
      ['Swap the board', 'System tab → Hardware SKU (v1.0 / v1.1 / Adv)'],
      ['Flash a .bin', 'drag it onto the Flash tab — parsed, written, verified'],
      ['Watchdog / thermal', 'Bench tab (ambient slider, WDT timeout, die temp)'],
    ];
    pane.append(h('div', { class: 'pane-title' }, 'Help & reference'));
    pane.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Host keyboard'),
      h('table', { class: 'kv' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))));
    const emulated = [
      'ST7789V2 240×135 RGB565 panel with an Adafruit-GFX style drawing API',
      '4×14 = 56-key matrix; 74HC138 scan or TCA8418 keypad controller (ADV)',
      'ES8311 codec / NS4168 + SPM1423 mic, 1 W speaker, 3.5 mm jack detect',
      'BMI270 6-axis IMU (ADV), SK6812 RGB LED, IR blaster (NEC, GPIO44)',
      'microSD over SPI with a persistent FAT-style filesystem',
      'Wi-Fi AP scan + DHCP + HTTP, BLE scan, battery + TP4057 charger model',
      'HY2.0-4P Grove I²C/UART/GPIO port, EXT 2.54-14P header, hot-plug',
      'ESP32-S3 flash layout with NVS, OTA slots, ROM download mode + image parser',
      'Thermal model with CPU throttle, task watchdog, brownout detector',
    ];
    const emuCard = h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'What is emulated'),
      h('ul', { class: 'nlist' }, emulated.map(t => h('li', {}, t))));
    pane.append(emuCard);

    pane.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Add your own module'),
      h('pre', { class: 'code' }, `// src/js/modules/modules.js
{
  id: 'my-sensor', name: 'My Unit', sku: 'U999',
  eco: 'grove', transport: 'i2c', color: '#f0f',
  addrs: [{ addr: 0x5c, chip: 'XYZ123' }],
  summary: 'Reads the thing',
  controls: [{ id: 'v', label: 'Value', min: 0, max: 100, step: 1 }],
  create(ctx) {
    const st = { v: 42 };
    return {
      state: st,
      read: (addr, reg, n) => [st.v & 0xff],
      setControl: (id, val) => { st.v = val; },
    };
  },
}`),
      h('div', { class: 'muted small' }, 'Drop it in the catalog array (or serve it from the update feed) and it shows up in the rack instantly.')));
    pane.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Write an app'),
      h('pre', { class: 'code' }, `// firmware app: setup() + loop()
export const APP = {
  id: 'hello', name: 'Hello', icon: 'HI',
  setup(api) { api.lcd.drawString(4, 4, 'hi', api.COLORS.WHITE, 1); },
  loop(api, dt) {
    const k = api.input();
    if (k.esc) api.exit();
    if (api.modules.has('env3'))
      api.lcd.drawString(4, 20, api.modules.state('env3').temp.toFixed(1), api.COLORS.GREEN, 2);
  },
};`)));
  }


  // ----------------------------------------------------------------- flash --
  renderFlash(pane) {
    const f = this.ctx.flash;
    if (!f) { pane.append(h('div', { class: 'empty-slot' }, 'flash backend unavailable')); return; }
    const info = f.info();

    pane.append(h('div', { class: 'pane-title' }, 'Flash & install',
      h('span', { class: 'muted' }, 'no hardware swaps needed')));

    // ---- serial download mode
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Download mode', h('span', { class: 'badge ' + (f.downloadMode ? 'up' : 'ok') }, f.downloadMode ? 'in ROM loader' : 'firmware running')),
      h('div', { class: 'muted small' }, 'Real hardware: power off, hold G0, plug in USB-C. The ROM loader then accepts an image over the serial stub.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn tiny primary', onclick: async () => { await f.enterDownloadMode(); this.render(); } }, 'enter download mode (hold G0)'),
        h('button', { class: 'btn tiny', disabled: f.downloadMode ? null : '', onclick: () => { f.exitDownloadMode(); this.render(); } }, 'hard reset'),
      ),
      h('table', { class: 'kv' },
        [['chip', info.chip], ['MAC', info.mac], ['crystal', info.crystal],
          ['flash', fmtBytes(info.flashBytes)], ['PSRAM', info.psram], ['boot slot', info.slot]]
          .map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v)))))));

    // ---- flash a file
    const drop = h('div', { class: 'dropzone', id: 'flashDrop' },
      h('b', {}, 'Drop a firmware image or program here'),
      h('span', {}, '.bin (ESP32-S3 app image) · .js (firmware program) · .json (package)'),
      h('input', { type: 'file', accept: '.bin,.js,.json,.txt', style: 'display:none', id: 'flashFile',
        onchange: e => { const file = e.target.files?.[0]; if (file) this.handleFlashFile(file); } }),
      h('button', { class: 'btn tiny', onclick: () => this.root.querySelector('#flashFile')?.click() }, 'choose file'),
    );
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      const file = e.dataTransfer?.files?.[0];
      if (file) this.handleFlashFile(file);
    });
    this.flashEl = { drop, progress: h('div', { class: 'prog' }, h('i', { style: 'width:0%' })), out: h('div', { class: 'uplog' }) };
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Flash an image'),
      drop,
      this.flashEl.progress,
      this.flashEl.out,
      h('div', { class: 'muted small' }, 'A real .bin is parsed and checksummed (magic, segments, entry point, app description) and laid into an OTA slot with erase/write/verify progress. It is not executed — this is a functional simulator, see docs/ACCURACY.md. .js programs run for real.')));

    // ---- partition table
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Partition table', h('span', { class: 'muted' }, fmtBytes(info.flashBytes) + ' flash')),
      h('table', { class: 'ptable' },
        h('tr', {}, ['name', 'type', 'offset', 'size', 'image'].map(x => h('th', {}, x))),
        info.table.map(p => h('tr', { class: p.name === info.slot ? 'active' : '' },
          h('td', {}, p.name), h('td', {}, p.subtype),
          h('td', {}, '0x' + p.offset.toString(16)), h('td', {}, fmtBytes(p.size)),
          h('td', {}, f.appImages[p.name] ? f.appImages[p.name].name : '—')))),
      h('div', { class: 'row' },
        h('button', { class: 'btn tiny', disabled: f.appImages.ota_0 && f.appImages.ota_1 ? null : '', onclick: () => { const r = f.switchSlot(); this.ctx.toast?.(r.ok ? 'booted ' + r.slot : r.error, r.ok ? 'ok' : 'error'); this.render(); } }, 'switch OTA slot'),
        h('button', { class: 'btn tiny', onclick: () => { this.render(); } }, 'refresh'))));

    // ---- write a program
    const tmpl = `export const APP = {
  id: 'my-app', name: 'My App', icon: 'MY', version: '1.0.0',
  setup(api) { this.n = 0; },
  loop(api, dt) {
    const L = api.lcd, K = api.COLORS;
    L.fillScreen(K.BLACK);
    L.drawString(4, 4, 'hello from my-app', K.WHITE, 1);
    L.drawString(4, 18, 't=' + (this.n += dt).toFixed(1) + 's', K.GREEN, 1);
    const mods = api.modules.list();
    L.drawString(4, 32, mods.length + ' module(s) attached', K.AMBER, 1);
    if (api.input().esc) api.exit();
  },
};`;
    this.editor = h('textarea', { class: 'code-editor', spellcheck: 'false' }, tmpl);
    this.appName = h('input', { class: 'search', placeholder: 'program name (optional)', value: '' });
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Write & install a program', h('span', { class: 'muted' }, 'setup()/loop(), saved in NVS')),
      h('div', { class: 'muted small' }, 'Runs against the same M5Cardputer-style API as the built-in apps — display, keyboard, Grove/EXT modules, SD, IR, power, Wi-Fi. It is stored and restored on reload.'),
      this.appName, this.editor,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary tiny', onclick: () => this.installFromEditor() }, 'install & run'),
        h('button', { class: 'btn tiny', onclick: () => this.installFromEditor({ run: false }) }, 'install only'),
        h('button', { class: 'btn tiny', onclick: () => { this.editor.value = tmpl; } }, 'reset template'))));

    // ---- installed programs
    const apps = f.listApps();
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, `Installed programs (${apps.length})`),
      apps.length
        ? h('div', { class: 'app-list' }, apps.map(a => h('div', { class: 'app-row' },
          h('span', { class: 'app-ic', style: 'background:#8b5cf6' }, 'JS'),
          h('span', { class: 'app-name' }, a.name),
          h('span', { class: 'muted' }, 'v' + a.version),
          h('button', { class: 'btn tiny', onclick: () => { this.ctx.runtime.launch(a.id); this.ctx.toast?.('launched ' + a.name); } }, 'run'),
          h('button', { class: 'btn tiny', onclick: () => this.downloadApp(a.id) }, 'export'),
          h('button', { class: 'btn tiny danger', onclick: () => { f.removeApp(a.id); this.render(); } }, 'remove'))))
        : h('div', { class: 'empty-slot' }, 'nothing installed yet — write one above or drop a .js file')));

    // ---- NVS
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'NVS', h('span', { class: 'muted' }, fmtBytes(info.nvsBytes) + ' used')),
      h('table', { class: 'ptable' },
        h('tr', {}, ['namespace', 'key', 'type', 'value'].map(x => h('th', {}, x))),
        f.nvs.entries().slice(0, 24).map(e => h('tr', {},
          h('td', {}, e.ns), h('td', {}, e.key), h('td', {}, e.type),
          h('td', {}, typeof e.value === 'string' ? e.value.slice(0, 24) : String(e.value)))))));
  }

  async handleFlashFile(file) {
    const f = this.ctx.flash;
    const out = this.flashEl?.out;
    const log = (m) => { if (out) { out.prepend(h('div', {}, h('span', { class: 'st' }, new Date().toLocaleTimeString()), m)); } };
    const progress = (p) => { const i = this.flashEl?.progress?.querySelector('i'); if (i) i.style.width = (p || 0) + '%'; };
    const name = file.name || 'upload';
    try {
      if (/\.(js|mjs|json|txt)$/i.test(name)) {
        const text = await file.text();
        if (/\.json$/i.test(name)) {
          let pack;
          try { pack = JSON.parse(text); } catch (e) { log('package is not valid JSON: ' + e.message); return; }
          if (pack.modules) {
            this.device.catalog = mergeCatalog(this.device.catalog, pack.modules);
            log(`module package "${pack.name || name}" → ${pack.modules.length} definition(s)`);
            return;
          }
          if (pack.source) { await this.installProgram(pack.source, pack.name); return; }
          log('JSON has neither a module list nor program source'); return;
        }
        await this.installProgram(text, name.replace(/\.[^.]+$/, ''));
        return;
      }
      // binary: ESP32 image
      const buf = new Uint8Array(await file.arrayBuffer());
      const parsed = (await import('../core/flash.js')).parseImage(buf);
      if (!parsed.ok) { log(`${name}: ${parsed.error}`); this.ctx.toast?.(parsed.error, 'error'); return; }
      log(`${name}: ${parsed.chip}, ${parsed.segCount} segments, entry ${parsed.entryHex}, ${parsed.flashMode} @ ${parsed.flashFreq}`);
      if (parsed.appDesc) log(`app: "${parsed.appDesc.project}" v${parsed.appDesc.version} built ${parsed.appDesc.date} on IDF ${parsed.appDesc.idf}`);
      const r = await f.flash({ name, bytes: buf, source: 'upload' });
      if (!r.ok) { log('flash failed: ' + r.error); this.ctx.toast?.('flash failed: ' + r.error, 'error'); return; }
      progress(100);
      log(`flashed into ${r.image.slot} @ 0x${r.image.offset.toString(16)} — verified ${r.image.digest}`);
      log('note: the emulator lays the image into flash but does not run Xtensa code');
      this.ctx.toast?.('image written & verified');
      this.render();
    } catch (e) {
      log('error: ' + e.message);
    }
  }

  async installFromEditor({ run = true } = {}) {
    const src = this.editor?.value || '';
    await this.installProgram(src, this.appName?.value || undefined, { run });
  }

  async installProgram(source, name, { run = true } = {}) {
    const r = await this.ctx.flash.installApp(source, { name });
    if (!r.ok) { this.ctx.toast?.(r.error, 'error'); return r; }
    this.ctx.toast?.(`installed ${r.record.name} v${r.record.version}`, 'ok');
    if (run) this.ctx.runtime.launch(r.record.id);
    this.render();
    return r;
  }

  downloadApp(id) {
    const src = this.ctx.flash.exportApp(id);
    if (!src) return;
    const blob = new Blob([src], { type: 'text/javascript' });
    const a = h('a', { href: URL.createObjectURL(blob), download: id + '.js' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ----------------------------------------------------------------- bench --
  // Everything you would normally need a bench for: SD contents, IR captures,
  // thermal state, watchdog, radio scan, microphone level, Grove rail.
  renderBench(pane) {
    const d = this.device, f = this.ctx.flash;
    pane.append(h('div', { class: 'pane-title' }, 'Bench', h('span', { class: 'muted' }, 'hardware you would otherwise have to poke with a probe')));

    // thermal + watchdog
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Thermal & watchdog'),
      h('div', { class: 'batt' },
        h('div', { class: 'batt-bar' }, h('i', { style: `width:${Math.min(100, (d.thermal.dieC / 100) * 100)}%` })),
        h('div', { class: 'batt-txt' }, `${d.thermal.dieC.toFixed(1)} °C die · ambient ${d.thermal.ambientC} °C · ${d.thermal.throttled ? 'throttled to 160 MHz' : '240 MHz'} · peak ${d.thermal.peakC.toFixed(1)} °C`)),
      this.slider('Ambient temperature', d.thermal.ambientC, -10, 50, 1, v => d.setAmbient(v), v => v + ' °C'),
      h('div', { class: 'row' },
        this.toggle('Task watchdog enabled', d.wdt.enabled, v => { d.wdt.enabled = v; }),
        h('label', { class: 'ctl' }, h('span', {}, 'timeout'), h('input', {
          type: 'range', min: 500, max: 15000, step: 500, value: d.wdt.timeoutMs,
          oninput: e => { d.wdt.timeoutMs = Number(e.target.value); },
        }), h('span', { class: 'ctl-val' }, d.wdt.timeoutMs + ' ms')),
      ),
      h('div', { class: 'muted small' }, 'A loop() that blocks for three frames trips the WDT and shows a guru-meditation panic, like the real task watchdog.') ));

    // microSD browser
    this.sdBrowse = this.sdBrowse || '/';
    const sd = d.sd;
    const rows = sd.inserted ? sd.list(this.sdBrowse) : [];
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'microSD', h('span', { class: 'muted' }, sd.inserted ? `${fmtBytes(sd.info().used)} / ${fmtBytes(sd.info().capacity)}` : 'no card')),
      h('div', { class: 'row' },
        h('code', {}, this.sdBrowse),
        h('button', { class: 'btn tiny', onclick: () => { const p = this.sdBrowse.replace(/\/[^/]+$/, '') || '/'; this.sdBrowse = p || '/'; this.render(); } }, 'up'),
        h('button', { class: 'btn tiny', onclick: () => { sd.inserted ? sd.eject() : sd.insert(); this.render(); } }, sd.inserted ? 'eject' : 'insert'),
      ),
      sd.inserted ? h('div', { class: 'filelist' }, rows.map(r => h('div', { class: 'file-row' },
        h('span', { class: 'fname', onclick: () => { if (r.dir) { this.sdBrowse = r.path; this.render(); } } }, (r.dir ? '📁 ' : '📄 ') + r.name),
        h('span', { class: 'muted' }, r.dir ? '' : fmtBytes(r.size)),
        r.dir ? null : h('button', { class: 'btn tiny danger', onclick: () => { sd.remove(r.path); this.render(); } }, 'del'))))
        : null,
      h('div', { class: 'row' },
        h('input', { class: 'search', placeholder: 'new file name', onkeydown: e => { if (e.key === 'Enter' && e.target.value) { sd.writeText((this.sdBrowse === '/' ? '' : this.sdBrowse) + '/' + e.target.value, ''); e.target.value = ''; this.render(); } } }),
        h('button', { class: 'btn tiny', onclick: () => { const p = (this.sdBrowse === '/' ? '' : this.sdBrowse) + '/emu-note.txt'; sd.writeText(p, 'written from the bench at ' + new Date().toISOString() + '\n'); this.render(); } }, 'write test file'))));

    // IR
    const caps = d.ir.captures.slice(-5).reverse();
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'IR', h('span', { class: 'muted' }, `NEC @ ${d.ir.carrierHz / 1000} kHz`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn tiny', onclick: () => { d.ir.sendNec(0x00, 0x45); this.render(); } }, 'blast NEC 0x45'),
        h('button', { class: 'btn tiny', onclick: () => { d.ir.learnNec([0x00, 0xff, 0x45, 0xba], { source: 'bench remote' }); this.render(); } }, 'simulate a remote press'),
      ),
      caps.length ? h('div', { class: 'filelist' }, caps.map((c, i) => h('div', { class: 'file-row' },
        h('span', { class: 'fname' }, `${c.source} · ${c.pulses.length} pulses · ${c.carriers / 1000} kHz`),
        h('button', { class: 'btn tiny', onclick: () => { d.ir.sendRaw(c.pulses); this.ctx.toast?.('replayed'); } }, 'replay'))))
        : h('div', { class: 'muted small' }, 'no captures — press “simulate a remote press”'),
      h('div', { class: 'muted small' }, `datasheet range: ${d.ir.rangeCm(0)} cm @ 0° · ${d.ir.rangeCm(45)} cm @ 45° · ${d.ir.rangeCm(90)} cm @ 90°`)));

    // radio + mic
    const aps = d.radio.scan();
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Wi-Fi / BLE', h('span', { class: 'muted' }, d.radio.state + (d.radio.ssid ? ' · ' + d.radio.ssid : ''))),
      h('div', { class: 'filelist' }, aps.slice(0, 5).map(a => h('div', { class: 'file-row' },
        h('span', { class: 'fname' }, a.ssid), h('span', { class: 'muted' }, a.rssi + ' dBm · ' + a.auth),
        h('button', { class: 'btn tiny', onclick: () => { d.radio.connect(a.ssid); this.render(); } }, 'connect')))),
      h('div', { class: 'row' },
        h('button', { class: 'btn tiny', onclick: () => { d.radio.disconnect(); this.render(); } }, 'disconnect'),
        h('button', { class: 'btn tiny', onclick: () => this.ctx.useRealMic?.() }, 'route host mic'),
        h('span', { class: 'muted' }, `mic ${(d.mic.level() * 100).toFixed(0)} %`))));

    // NVS quick look + reset
    pane.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'NVS / boot counters'),
      h('table', { class: 'kv' }, (f?.nvs.entries() || []).slice(0, 8).map(e => h('tr', {}, h('th', {}, e.key), h('td', {}, String(e.value)))))));
  }

  // ------------------------------------------------------------------ tick --
  tick() {
    if (this.tab === 'modules') this.refreshLive();
    if (this.tab === 'bench' && !this._benchAt) this._benchAt = 0;
    if (this.tab === 'bench') {
      const now = performance.now();
      if (now - (this._benchAt || 0) > 1500) { this._benchAt = now; this.render(); }
    }
    if (this.tab === 'serial' && !this.serialPaused) this.renderSerialLines();
  }
}
