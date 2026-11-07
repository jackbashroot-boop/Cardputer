// Adversarial fuzzer for the emulator core. No DOM, no network: it hammers the
// device model, the keyboard matrix, the buses, the framebuffer and the firmware
// runtime with random/illegal input and checks invariants after every step.
//
//   node tests/fuzz_core.mjs            # 10 000 runtime frames + 4 fuzz phases
//   node tests/fuzz_core.mjs --long     # 100 000 frames
//   node tests/fuzz_core.mjs --seed 7
//
// Exit code is non-zero on the first broken invariant, so it drops straight into CI.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'src/js/core/util.js', 'src/js/core/font.js', 'src/js/core/hardware.js',
  'src/js/core/peripherals.js', 'src/js/core/flash.js', 'src/js/modules/modules.js', 'src/js/core/device.js',
  'src/js/rt/runtime.js', 'src/js/apps/apps.js',
];
const strip = src => src
  .replace(/^\s*import\s[^;]*?;\s*$/gm, '')
  .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^(\s*)export\s+(async\s+function|function|class|const|let|var)\s/gm, '$1$2 ');

const code = FILES.map(f => strip(readFileSync(join(ROOT, f), 'utf8'))).join('\n');
const boot = new Function(`${code}\nreturn { Cardputer, Runtime, BUILTIN_APPS, MODULE_CATALOG, KEY_ROWS, KEY_BY_ID, COLORS, Display, FlashManager, parseImage, partitionTable };`)();
const { Cardputer, Runtime, BUILTIN_APPS, MODULE_CATALOG, KEY_BY_ID, COLORS, Display, FlashManager, parseImage, partitionTable } = boot;

// ------------------------------------------------------------------ rng ------
let seed = 0x5eed1234;
const argv = process.argv.slice(2);
const getArg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
seed = Number(getArg('--seed', seed)) >>> 0 || seed;
const LONG = argv.includes('--long');
function rng() { // xorshift32 — reproducible, no dependency
  seed ^= seed << 13; seed >>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>= 0;
  return (seed >>> 0) / 0x100000000;
}
const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
const pick = arr => arr[Math.floor(rng() * arr.length)];
const chance = p => rng() < p;

// ------------------------------------------------------------- harness ------
let checks = 0;
const failures = [];
function fail(phase, msg) { failures.push(`${phase}: ${msg}`); }
const ok = (cond, phase, msg) => { checks++; if (!cond) fail(phase, msg); };

const makeDevice = (variant = 'adv') => {
  const d = new Cardputer({ variant, catalog: MODULE_CATALOG });
  d.boot();
  return d;
};
const makeRuntime = (d) => {
  const rt = new Runtime(d, { apps: BUILTIN_APPS, version: '1.0.0' });
  rt.boot();
  for (let i = 0; i < 200; i++) rt.tick(0.016);
  return rt;
};

// ------------------------------------------------------- phase 1: keyboard --
function fuzzKeyboard() {
  const P = 'keyboard';
  const d = makeDevice(pick(['cardputer', 'v11', 'adv']));
  const kb = d.keyboard;
  const ids = [...KEY_BY_ID.keys()];
  const cells = kb.rows * kb.cols;
  let clock = 0;
  for (let step = 0; step < 4000; step++) {
    clock += ri(0, 40);
    const op = rng();
    if (op < 0.45) kb.down(pick(ids), clock);
    else if (op < 0.85) kb.up(pick(ids), clock);
    else if (op < 0.92) kb.down('not-a-key', clock);          // unknown id must be ignored
    else if (op < 0.96) { kb.tick(clock); }
    else { kb.releaseAll ? kb.releaseAll(clock) : kb.up(pick(ids), clock); }

    if (step % 97 === 0) {
      // roll-over: hold everything at once, then read the state
      for (const id of ids) kb.down(id, clock);
      const st = kb.keyState();
      ok(Array.isArray(st.word), P, 'keyState().word is an array');
      ok(st.word.length <= cells, P, `roll-over word too long: ${st.word.length}`);
      ok(Object.keys(st.arrows).length === 4, P, 'arrow map complete');
      for (const id of ids) kb.up(id, clock);
      kb.takeEvents(); kb.takeChars();
    }
    if (step % 13 === 0) {
      ok(kb.matrix.length === cells, P, `matrix size drifted to ${kb.matrix.length}`);
      const evs = kb.takeEvents();
      const chars = kb.takeChars();
      ok(chars.length <= 128, P, `char queue unbounded: ${chars.length}`);
      ok(evs.length < 4096, P, `event queue unbounded: ${evs.length}`);
      ok(kb.charQueue.length <= 128, P, 'char queue cap enforced');
      // every queued event must reference a real matrix cell
      for (const ev of evs) ok(ev.row >= 0 && ev.row < kb.rows && ev.col >= 0 && ev.col < kb.cols, P, `bogus key event ${ev.row},${ev.col}`);
    }
  }
  // typing under a modifier storm must never throw
  for (const mod of ['shift', 'fn', 'ctrl', 'opt', 'alt']) {
    kb.down(mod, clock);
    for (const id of ids.slice(0, 20)) { kb.down(id, clock); kb.up(id, clock); }
    kb.up(mod, clock);
  }
  kb.takeChars();
  ok(true, P, 'no exception during modifier storm');
}

// -------------------------------------------------------- phase 2: hot-plug --
function fuzzHotplug() {
  const P = 'hotplug';
  const d = makeDevice('adv');
  const rt = makeRuntime(d);
  const ids = MODULE_CATALOG.map(m => m.id);
  const bad = ['', 'nope', null, undefined, '../../etc/passwd', 'x'.repeat(4096), '__proto__', 'constructor'];
  const attached = [];
  for (let step = 0; step < 1200; step++) {
    const roll = rng();
    if (roll < 0.5) {
      const id = chance(0.1) ? pick(bad) : pick(ids);
      let res;
      try { res = d.attachModule(id); }
      catch (e) { fail(P, `attachModule(${String(id).slice(0, 20)}) threw: ${e.message}`); res = { ok: false }; }
      ok(res && typeof res.ok === 'boolean', P, 'attachModule returns a verdict');
      if (res.ok) attached.push(res.module.uuid);
    } else if (roll < 0.85) {
      const uuid = attached.length && chance(0.85) ? pick(attached) : 'missing-uuid';
      try { d.detachModule(uuid); } catch (e) { fail(P, `detachModule threw: ${e.message}`); }
      const i = attached.indexOf(uuid); if (i >= 0) attached.splice(i, 1);
    } else if (roll < 0.93) {
      rt.tick(0.016);
    } else {
      // module controls on a random module, including ones that are not plugged in
      const uuid = attached.length ? pick(attached) : 'nope';
      try { d.setModuleControl(uuid, pick(['trigger', 'inject', 'tx', 'bogus']), ri(-5, 100)); }
      catch (e) { fail(P, `setModuleControl threw: ${e.message}`); }
    }

    if (step % 23 === 0) {
      // invariants: one device per slot, no duplicate I2C addresses, no orphan GPIO claims
      const byEco = {};
      for (const m of d.modules) byEco[m.def.eco] = (byEco[m.def.eco] || 0) + 1;
      for (const [eco, n] of Object.entries(byEco)) ok(n <= 1, P, `${eco} slot holds ${n} modules`);
      for (const bus of [d.buses.grove, d.buses.ext]) {
        const seen = new Set();
        for (const [addr, client] of bus.clients) {
          ok(!seen.has(addr), P, `duplicate I2C client at 0x${addr.toString(16)}`);
          seen.add(addr);
          ok(client && typeof client.name === 'string', P, 'I2C client has a name');
        }
      }
      ok(d.modules.length === attached.length, P, `module bookkeeping drifted: ${d.modules.length} vs ${attached.length}`);
      // the SoC I2C map must never contain two owners for one address
      const addrs = d.buses.internal.scan().filter(a => a < 0x70);
      ok(new Set(addrs).size === addrs.length, P, 'internal I2C address collision');
      ok(Number.isFinite(d.power.percent) && d.power.percent >= 0 && d.power.percent <= 100, P, `battery out of range: ${d.power.percent}`);
    }
    if (step % 211 === 0) { d.reboot(); ok(d.modules.length === attached.length, P, 'modules survive a reboot'); }
  }
  // unplug everything, twice — the second pass must be a no-op
  for (const uuid of [...attached]) d.detachModule(uuid);
  for (const uuid of [...attached]) d.detachModule(uuid);
  ok(d.modules.length === 0, P, `stale modules after unplug-all: ${d.modules.length}`);
  ok(d.buses.grove.clients.size === 0, P, 'Grove bus not empty after unplug-all');
}

// -------------------------------------------------- phase 3: framebuffer -----
function fuzzFramebuffer() {
  const P = 'framebuffer';
  const d = makeDevice('adv');
  const lcd = d.display;
  const size = lcd.nativeW * lcd.nativeH;
  const wild = [0, 1, -1, 240, 241, 4000, -4000, 1e9, -1e9, NaN, Infinity, -Infinity, 0.5, -0.5];
  const coord = () => chance(0.55) ? ri(-8, 250) : pick(wild);
  for (let step = 0; step < 6000; step++) {
    const op = rng();
    try {
      if (op < 0.14) lcd.pixel(coord(), coord(), ri(0, 0xffff));
      else if (op < 0.28) lcd.drawLine(coord(), coord(), coord(), coord(), ri(0, 0xffff));
      else if (op < 0.40) lcd.fillRect(coord(), coord(), coord(), coord(), ri(0, 0xffff));
      else if (op < 0.50) lcd.drawCircle(coord(), coord(), coord(), ri(0, 0xffff));
      else if (op < 0.58) lcd.drawString(coord(), coord(), pick(['ok', '', 'x'.repeat(300), '\u0000\u00ff\u0100', 'ÿ€😀']), ri(0, 0xffff), ri(1, 8));
      else if (op < 0.66) lcd.pushImage(coord(), coord(), ri(0, 8), ri(0, 8), Array.from({ length: 64 }, () => ri(0, 0xffff)), chance(0.5) ? 0xffff : undefined);
      else if (op < 0.74) lcd.scroll(pick([1, -1, 4, -4, 240, -240, 1e6, -1e6]));
      else if (op < 0.80) lcd.setRotation(ri(-2, 6));
      else if (op < 0.86) lcd.fillScreen(ri(0, 0xffff));
      else if (op < 0.92) lcd.setClip(coord(), coord(), coord(), coord());
      else lcd.drawFastVLine(coord(), coord(), coord(), ri(0, 65535));
    } catch (e) {
      fail(P, `drawing op threw (${op.toFixed(2)}): ${e.message}`);
      break;
    }
    if (step % 151 === 0) {
      ok(lcd.buf.length === size, P, `framebuffer resized to ${lcd.buf.length}`);
      const strays = Object.keys(lcd.buf).filter(k => Number.isNaN(Number(k)));
      ok(strays.length === 0, P, `non-index property leaked onto the framebuffer: ${strays.slice(0, 3)}`);
      let nanPixels = 0;
      for (let i = 0; i < size; i++) if (!Number.isInteger(lcd.buf[i]) || lcd.buf[i] < 0 || lcd.buf[i] > 0xffff) { nanPixels++; if (nanPixels > 3) break; }
      ok(nanPixels === 0, P, `${nanPixels} corrupted pixels (NaN/out-of-range)`);
      lcd.setRotation(0); lcd.fillScreen(COLORS.BLACK);
      lcd.setClip(0, 0, lcd.width, lcd.height);
    }
  }
  // every glyph of the 8-bit font must render without throwing or leaving NaN
  for (let ch = 0; ch < 256; ch++) lcd.drawChar(0, 0, String.fromCharCode(ch), 0xffff, 0, 1);
  ok(lcd.buf.every ? lcd.buf.every(v => Number.isInteger(v)) : true, P, 'font sweep corrupted the buffer');
  void Display;
}

// ------------------------------------------------------ phase 4: runtime -----
function fuzzRuntime(frames) {
  const P = 'runtime';
  const d = makeDevice(pick(['cardputer', 'v11', 'adv']));
  const rt = makeRuntime(d);
  const apps = BUILTIN_APPS.map(a => a.id);
  const keys = [...KEY_BY_ID.keys()];
  const phases = new Set(['boot', 'splash', 'launcher', 'run', 'panic', 'off']);
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    const roll = rng();
    try {
      if (roll < 0.02) rt.launch(pick(apps));
      else if (roll < 0.025) rt.exit();
      else if (roll < 0.028) rt.reboot();
      else if (roll < 0.030) (d.power.switchOn ? rt.powerOff() : (d.powerOn(), rt.boot()));
      else if (roll < 0.034) d.attachModule(pick(MODULE_CATALOG).id);
      else if (roll < 0.037 && d.modules.length) d.detachModule(pick(d.modules).uuid);
      else if (roll < 0.16) { const k = pick(keys); d.keyboard.down(k, f * 16); if (chance(0.6)) d.keyboard.up(k, f * 16 + 40); }
      else if (roll < 0.17) rt.launch('no-such-app');
      rt.tick(chance(0.02) ? ri(1, 400) / 1000 : 0.016);
    } catch (e) {
      fail(P, `frame ${f} threw: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
      break;
    }
    if (f % 251 === 0) {
      ok(phases.has(rt.phase), P, `illegal phase "${rt.phase}"`);
      ok(rt.device === d, P, 'runtime lost its device');
      const api = rt.api;
      ok(typeof api.lcd.width === 'number' && api.lcd.width > 0, P, 'lcd api broken');
      ok(api.COLORS && typeof api.COLORS.BLACK === 'number', P, 'colour table broken');
      ok(Array.isArray(api.apps.list()), P, 'app list broken');
      ok(Number.isFinite(d.uptime), P, 'uptime went non-finite');
      ok(d.display.buf.length === d.display.nativeW * d.display.nativeH, P, 'framebuffer size drift');
      ok(d.serial ? d.serialLines === undefined || d.serialLines.length <= 5000 : true, P, 'serial log unbounded');
    }
  }
  const ms = Date.now() - t0;
  return { frames, ms, fps: Math.round(frames / (ms / 1000)) };
}


// ------------------------------------------------------- phase: SKU swap -----
// Swapping hardware mid-run must never leave the board in a state the firmware
// cannot see: every attached module has to be on a bus, every bus address unique.
function fuzzSkus() {
  const P = 'skus';
  const ids = Object.keys({ cardputer: 1, v11: 1, adv: 1 });
  const d = makeDevice('adv');
  const rt = makeRuntime(d);
  for (let i = 0; i < 140; i++) {
    const target = pick(ids);
    const r = d.setVariant(target);
    ok(r.ok === true, P, 'setVariant refused ' + target + ': ' + r.error);
    ok(d.variantId === target, P, 'variant id did not change');
    ok(d.variant.groveToggle === (target === 'adv'), P, 'grove 5 V toggle flag wrong for ' + target);
    ok(!d.variant.ext || target === 'adv', P, 'EXT flag wrong for ' + target);
    // invariants: modules are all on the new board, addresses unique
    const grove = d.modules.filter(m => m.def.eco === 'grove');
    const ext = d.modules.filter(m => m.def.eco === 'ext');
    ok(grove.length <= 1, P, 'Grove slot over-subscribed after swap');
    ok(ext.length === 0 || d.variant.ext, P, 'EXT module survived on a SKU without the header');
    for (const bus of [d.buses.grove, d.buses.ext]) {
      const addrs = [];
      for (const [a] of bus.clients) addrs.push(a);
      ok(new Set(addrs).size === addrs.length, P, 'duplicate I²C address after swap');
    }
    if (chance(0.6)) {
      const defs = MODULE_CATALOG.filter(m => chance(0.25));
      for (const def of defs) {
        const res = d.attachModule(def.id);
        if (!res.ok) ok(typeof res.error === 'string' && res.error.length > 4, P, 'attach failure without a reason');
      }
    }
    for (let k = 0; k < 8; k++) { rt.tick(0.016); d.tick(0.016); }
    ok(Number.isFinite(d.power.percent) && d.power.percent >= 0 && d.power.percent <= 100, P, 'charge out of range');
    ok(Number.isFinite(d.thermal.dieC) && d.thermal.dieC < 200, P, 'die temp diverged');
  }
}

// ------------------------------------------------- phase: flash / install ----
// Hostile images and hostile programs: the parser must reject them with a
// message, the flasher must never corrupt the slot bookkeeping, and program
// installation must survive arbitrary text without executing anything silly.
async function fuzzFlash() {
  const P = 'flash';
  const d = makeDevice('adv');
  const rt = makeRuntime(d);
  let saved = null;
  const f = new FlashManager(d, rt, { store: { load: () => saved, save: v => { saved = v; } } });
  const table = partitionTable(8 * 1024 ** 2);
  for (const p of table) ok(p.offset % 0x1000 === 0, P, p.name + ' offset not sector aligned');
  for (let i = 1; i < table.length; i++) {
    ok(table[i].offset >= table[i - 1].offset + table[i - 1].size, P, 'partitions overlap at ' + table[i].name);
  }
  ok(table.at(-1).offset + table.at(-1).size <= 8 * 1024 ** 2, P, 'table overruns flash');

  for (let i = 0; i < 60; i++) {
    const len = ri(0, 4096);
    const bytes = new Uint8Array(len);
    for (let j = 0; j < len; j++) bytes[j] = chance(0.5) ? ri(0, 255) : (chance(0.5) ? 0xe9 : 0);
    const parsed = parseImage(bytes);
    ok(typeof parsed.ok === 'boolean', P, 'parseImage returned no verdict');
    if (!parsed.ok) ok(typeof parsed.error === 'string', P, 'parse error without a message');
    else ok(parsed.segments.every(g => g.len >= 0), P, 'negative segment length');
    const r = await f.flash({ name: 'fuzz' + i + '.bin', bytes });
    ok(typeof r.ok === 'boolean', P, 'flash returned no verdict');
    if (r.ok) {
      ok(f.slot === 'ota_0' || f.slot === 'ota_1', P, 'slot id corrupted');
      ok(f.appImages[f.slot].size === len, P, 'image size bookkeeping wrong');
    }
    ok(f.nvs.usedBytes() >= 0, P, 'nvs size negative');
  }

  const nasty = [
    '', 'not js at all', 'export const APP = {};', 'export const APP = { id: 5 };',
    "export const APP = { id: 'x', loop: 3 };", "export const APP = { id: 'ok', loop() { throw new Error('boom'); } };",
    "export const APP = { id: 'quad', loop() { for(;;){} } };", 'export default null;',
    "export const APP = { id: 'huge', name: 'x'.repeat(1000), loop() {} };",
    "throw new Error('top level');", "export const APP = { id: '__proto__', loop() {} };",
    "export const APP = { id: 'sys', loop() {} };",
  ];
  for (const src of nasty) {
    const r = await Promise.race([
      f.installApp(src, { fuzz: true }),
      new Promise(res => setTimeout(() => res({ ok: false, error: 'timeout' }), 800)),
    ]);
    ok(typeof r.ok === 'boolean', P, 'installApp returned no verdict');
    if (!r.ok) ok(typeof r.error === 'string' && r.error.length > 0, P, 'install rejection without a reason');
  }
  ok(f.listApps().every(a => typeof a.id === 'string'), P, 'installed app record corrupted');
  // a re-load from the store must not throw on arbitrary saved data
  for (const junk of [null, {}, { apps: 'nope' }, { apps: [{ id: 5 }] }, { slot: 'ota_9' }, { nvs: { 'a:b': 5 } }]) {
    const f2 = new FlashManager(d, rt, { store: { load: () => junk, save: () => { } } });
    ok(['ota_0', 'ota_1'].includes(f2.slot), P, 'slot not sanitised on load');
    ok(Array.isArray(f2.listApps()), P, 'app list not an array after junk load');
  }
}

// ------------------------------------------------------------------- main ---
console.log(`\nCardputer EMU fuzz  (seed ${seed >>> 0}, ${LONG ? 'long' : 'normal'} mode)\n`);
const phases = [
  ['keyboard', fuzzKeyboard],
  ['hotplug', fuzzHotplug],
  ['skus', fuzzSkus],
  ['flash', fuzzFlash],
  ['framebuffer', fuzzFramebuffer],
];
for (const [name, fn] of phases) {
  const t = Date.now();
  try { await fn(); } catch (e) { fail(name, `phase aborted: ${e.message}`); }
  console.log(`  ${failures.some(f => f.startsWith(name + ':')) ? '✗' : '✓'} ${name.padEnd(12)} ${Date.now() - t} ms`);
}
const perf = fuzzRuntime(LONG ? 100000 : 10000);
console.log(`  ${failures.some(f => f.startsWith('runtime:')) ? '✗' : '✓'} ${'runtime'.padEnd(12)} ${perf.frames} frames in ${perf.ms} ms (~${perf.fps} fps headless)`);

console.log(`\n${checks} invariants checked, ${failures.length} failure(s)`);
for (const f of failures.slice(0, 25)) console.log('  ! ' + f);
process.exit(failures.length ? 1 : 0);
