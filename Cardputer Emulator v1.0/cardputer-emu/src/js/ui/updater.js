// =============================================================================
//  Client-side updater facade.
//  * native mode  -> talks to the Python launcher (/api/update/*)
//  * browser mode -> soft updates only: module catalog + firmware app packages
// =============================================================================
import { compareVersions } from '../core/util.js';
import { mergeCatalog } from '../modules/modules.js';

// UTF-8 safe base64 for `import()` of a data: URL — avoids the deprecated unescape().
const toB64Utf8 = src => {
  const bytes = new TextEncoder().encode(src);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export class EmuUpdater {
  constructor({ device, runtime, native = null, feedUrl = '', channel = 'stable', auto = true, version = '1.0.0' }) {
    this.device = device;
    this.runtime = runtime;
    this.native = native;         // {version, channel, feed, autoUpdate, dataDir} injected by the launcher
    this.feedUrl = feedUrl;
    this.channel = native?.channel || channel;
    this.auto = native?.autoUpdate ?? auto;
    this.version = native?.version || version;
    this.available = null;        // manifest entry for the newest version
    this.installedApps = [];      // soft-installed firmware app URLs
    this.onSoft = null;           // main.js persists this list
    this.history = [];
    this.lastCheck = null;
    this.log = [];
    this.onChange = () => {};
  }
  get hasNative() { return !!this.native; }
  note(msg) { this.log.unshift({ t: new Date().toTimeString().slice(0, 8), msg }); if (this.log.length > 60) this.log.pop(); this.onChange(); }

  async check() {
    try {
      if (this.hasNative) {
        const r = await fetch('/api/update/check?' + new URLSearchParams({ channel: this.channel }));
        const j = await r.json();
        this.lastCheck = new Date();
        this.available = j.available || null;
        this.version = j.current || this.version;
        if (Array.isArray(j.releases)) this._feed = { releases: j.releases };
        this.relay(j.log || []);
        this.note(j.available ? `update available: ${j.available.version}` : 'already up to date');
        this.onChange();
        return j;
      }
      // browser mode: compare against the bundled feed manifest
      const feed = await this.fetchFeed();
      this.lastCheck = new Date();
      const cand = (feed.releases || [])
        .filter(r => r.channel === this.channel || this.channel === 'beta')
        .sort((a, b) => compareVersions(b.version, a.version))[0];
      this.available = cand && compareVersions(cand.version, this.version) > 0 ? cand : null;
      this.note(this.available ? `feed offers v${this.available.version}` : 'already up to date');
      return { current: this.version, available: this.available, feed, native: false };
    } catch (e) {
      this.note('update check failed: ' + e.message);
      return { current: this.version, available: null, error: e.message };
    }
  }

  async fetchFeed() {
    if (this._feed) return this._feed;
    const inline = typeof document !== 'undefined' && document.getElementById('feed-manifest');
    if (inline && inline.textContent.trim().length > 2) {
      try { this._feed = JSON.parse(inline.textContent); return this._feed; } catch { /* fall through */ }
    }
    const urls = [this.feedUrl, 'updates/manifest.json', '../updates/manifest.json', '/updates/manifest.json'].filter(Boolean);
    for (const u of urls) {
      try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) { this._feed = await r.json(); return this._feed; } } catch { /* next */ }
    }
    return { releases: [] };
  }

  relay(lines) { for (const l of lines) this.log.unshift({ t: new Date().toTimeString().slice(0, 8), msg: l }); }

  async install(version = null) {
    const target = version || this.available?.version;
    if (!target) return { ok: false, error: 'nothing to install' };
    if (this.hasNative) {
      const r = await fetch('/api/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: target }) });
      const j = await r.json();
      this.relay(j.log || []);
      if (!j.ok) { this.note('install failed: ' + (j.error || 'unknown')); this.onChange(); return j; }
      this.version = target;
      this.available = null;
      if (j.soft) {
        const softLog = await this.applySoft(j.soft);
        this.relay(softLog);
      }
      this.note(`installed v${target} — core bundle applies on next launch, soft payload is live now`);
      this.onChange();
      return j;
    }
    // browser mode: only the soft payload (catalog + firmware apps) can be applied
    const rel = (await this.fetchFeed()).releases?.find(r => r.version === target);
    if (!rel) return { ok: false, error: 'release is not in the feed' };
    const softLog = await this.applySoft(rel.soft || {});
    this.relay(softLog);
    if (!softLog.length) {
      return { ok: false, error: 'nothing applied', log: ['core binaries can only be replaced by the launcher: python run.py --update'] };
    }
    this.version = target;
    this.available = null;
    this.note(`soft-updated to ${target} (catalog + apps)`);
    this.onChange();
    return { ok: true, soft: true, log: softLog };
  }

  // Merge a feed catalog and install feed-delivered firmware apps.
  async applySoft(soft = {}) {
    const log = [];
    if (soft.catalog) {
      try {
        const r = await fetch(soft.catalog, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          this.device.catalog = mergeCatalog(this.device.catalog, j.modules || []);
          log.push(`catalog ${j.version || ''} merged — ${(j.modules || []).length} new module definition(s)`);
        } else log.push(`catalog fetch failed: HTTP ${r.status}`);
      } catch (e) { log.push('catalog fetch failed: ' + e.message); }
    }
    for (const url of soft.apps || []) {
      try {
        await this.loadApp(url);
        log.push(`installed app package ${url}`);
        if (!this.installedApps.includes(url)) this.installedApps.push(url);
      } catch (e) { log.push(`app ${url} failed: ${e.message}`); }
    }
    if (soft.apps?.length) this.onSoft?.(this.installedApps);
    return log;
  }

  async loadApp(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const src = await r.text();
    const b64 = toB64Utf8(src);
    const mod = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + b64);
    const app = mod.APP || mod.default;
    if (!app || !app.id) throw new Error('package does not export APP');
    this.runtime.apps.set(app.id, app);
    this.note(`registered firmware app "${app.name}" v${app.version || '1.0.0'}`);
    return app;
  }

  async installSoft() {
    const rel = (this.available || (await this.fetchFeed()).releases?.[0]) || null;
    const soft = rel?.soft || { catalog: 'updates/catalog.json' };
    const log = await this.applySoft(soft);
    this.relay?.([]);
    for (const l of log) this.note(l);
    this.onChange();
    return { ok: log.length > 0, log };
  }

  async rollback() {
    if (!this.hasNative) return { ok: false, error: 'rollback needs the desktop launcher (python run.py --rollback)' };
    const r = await fetch('/api/update/rollback', { method: 'POST' });
    const j = await r.json();
    this.relay(j.log || []);
    this.note(j.ok ? 'rolled back to ' + j.version : 'rollback failed: ' + j.error);
    return j;
  }

  setChannel(ch) { this.channel = ch; this.note('channel → ' + ch); }
  setAuto(v) { this.auto = !!v; this.note('auto-update ' + (this.auto ? 'enabled' : 'disabled')); }
}
