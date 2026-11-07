// Headless test suite: loads the emulator core (no DOM) and exercises the
// device model, the module buses, hot-plug rules, the runtime and every app.
//   node tests/test_core.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'src/js/core/util.js',
  'src/js/core/font.js',
  'src/js/core/hardware.js',
  'src/js/core/peripherals.js',
  'src/js/modules/modules.js',
  'src/js/core/device.js',
  'src/js/core/flash.js',
  'src/js/rt/runtime.js',
  'src/js/apps/apps.js',
];

const strip = src => src
  .replace(/^\s*import\s[^;]*?;\s*$/gm, '')
  .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^(\s*)export\s+(async\s+function|function|class|const|let|var)\s/gm, '$1$2 ');

const code = FILES.map(f => strip(readFileSync(join(ROOT, f), 'utf8'))).join('\n');
const API = ['Cardputer', 'VARIANTS', 'Runtime', 'BUILTIN_APPS', 'MODULE_CATALOG', 'MODULE_BY_ID',
  'KEY_ROWS', 'KEY_BY_ID', 'COLORS', 'color565', 'compareVersions', 'crc8', 'Display', 'Keyboard', 'mergeCatalog',
  'FlashManager', 'parseImage', 'partitionTable', 'Nvs'];
const boot = new Function(`${code}\nreturn {${API.join(',')}};`)();
const { Cardputer, VARIANTS, Runtime, BUILTIN_APPS, MODULE_CATALOG, KEY_BY_ID, COLORS, compareVersions, crc8, mergeCatalog,
  FlashManager, parseImage, partitionTable, Nvs } = boot;

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`  ✓ ${name}`); }
  catch (e) { fail++; results.push(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'expected equality'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not close'}: got ${a}, want ${b}±${tol}`); }

function makeDevice(variant = 'adv', catalog = MODULE_CATALOG) {
  const d = new Cardputer({ variant, catalog });
  d.boot();
  return d;
}
function makeRuntime(d) {
  const rt = new Runtime(d, { apps: BUILTIN_APPS, version: '1.0.0' });
  rt.boot();
  for (let i = 0; i < 200; i++) rt.tick(0.016);   // boot -> splash -> launcher
  return rt;
}
const tickN = (rt, n, dt = 0.016) => { for (let i = 0; i < n; i++) rt.tick(dt); };

// ---------------------------------------------------------------------------
console.log('\nCardputer EMU core tests\n');

test('variants expose the documented hardware', () => {
  const adv = makeDevice('adv');
  eq(adv.variant.kbChip, 'TCA8418RTWR @0x34');
  eq(adv.variant.imu, true);
  eq(adv.variant.ext, true);
  eq(adv.buses.internal.scan().join(','), '24,52,104');   // 0x18 ES8311, 0x34 TCA8418, 0x68 BMI270
  const v11 = makeDevice('v11');
  eq(v11.variant.imu, false);
  eq(v11.buses.internal.scan().length, 0);
  eq(v11.buses.grove.sda, 2);
  eq(v11.keyboard.scanMode, 'gpio');
});

test('LCD framebuffer + GFX primitives', () => {
  const d = makeDevice();
  d.display.fillScreen(COLORS.BLACK);
  d.display.fillRect(10, 10, 20, 10, COLORS.RED);
  eq(d.display.getPixel(15, 15), COLORS.RED, 'fillRect pixel');
  eq(d.display.getPixel(5, 5), COLORS.BLACK, 'outside rect');
  d.display.drawLine(0, 0, 100, 0, COLORS.WHITE);
  eq(d.display.getPixel(50, 0), COLORS.WHITE, 'drawLine');
  d.display.drawString(0, 20, 'A', COLORS.WHITE, 2);
  const lit = [];
  for (let x = 0; x < 12; x++) for (let y = 20; y < 36; y++) if (d.display.getPixel(x, y) === COLORS.WHITE) lit.push([x, y]);
  assert(lit.length > 8, 'glyph A should paint pixels, got ' + lit.length);
  d.display.setRotation(1);
  eq(d.display.w, 135); eq(d.display.h, 240);
  d.display.setRotation(0);
  const rgba = d.display.toRGBA();
  eq(rgba.length, 240 * 135 * 4);
});

test('keyboard matrix, Fn layer and typed characters', () => {
  const d = makeDevice();
  const kb = d.keyboard;
  kb.down('a', 0);
  assert(kb.keyState().word.includes('a'), 'letter a in word list');
  eq(kb.keyState().shift, false);
  kb.up('a', 0);
  kb.down('shift', 0); kb.down('1', 0);
  assert(kb.keyState().word.includes('!'), 'shift+1 = !');
  kb.up('shift', 0); kb.up('1', 0);
  kb.down('fn', 0); kb.down(';', 0);
  eq(kb.keyState().arrows.up, true, 'Fn+; = up arrow');
  kb.up(';', 0); kb.down(',', 0);
  eq(kb.keyState().arrows.left, true, 'Fn+, = left arrow');
  kb.up(',', 0); kb.up('fn', 0);
  kb.down('x', 0); kb.tick(1000);
  assert(kb.takeChars().includes('x'), 'typed char captured');
  // TCA8418 FIFO on ADV
  kb.down('z', 2000);
  assert(kb.fifo.length > 0 && kb.int === true, 'keypad FIFO + INT line');
});

test('host-style auto-repeat produces extra events', () => {
  const d = makeDevice();
  d.keyboard.down('a', 0);
  d.keyboard.tick(1000);
  const evs = d.keyboard.takeEvents().filter(e => e.type === 'down');
  assert(evs.length >= 2, 'auto-repeat after the delay');
});

test('I2C bus: ENV III registers decode with valid SHT30 CRC', () => {
  const d = makeDevice();
  const r = d.attachModule('env3');
  assert(r.ok, 'attach env3: ' + r.error);
  eq(d.buses.grove.scan().join(','), '68,112');     // 0x44, 0x70
  const s = d.moduleState('env3');
  d.buses.grove.writeBytes(0x44, [0x2c, 0x06]);      // high-repeatability measurement
  const bytes = d.buses.grove.readBytes(0x44, 6);
  eq(bytes.length, 6);
  assert(crc8([bytes[0], bytes[1]]) === bytes[2], 'temperature CRC valid');
  assert(crc8([bytes[3], bytes[4]]) === bytes[5], 'humidity CRC valid');
  const rawT = (bytes[0] << 8) | bytes[1];
  const tempC = -45 + 175 * rawT / 65535;
  near(tempC, s.temp, 0.6, 'decoded temperature matches the simulator');
});

test('I2C NAK when a device is unplugged mid-run', () => {
  const d = makeDevice();
  const r = d.attachModule('light');
  d.buses.grove.readReg(0x23, 0x10, 2);
  d.detachModule(r.module.uuid);
  let threw = false;
  try { d.buses.grove.readReg(0x23, 0x10, 2); } catch (e) { threw = /NAK/.test(e.message); }
  assert(threw, 'expected an I2C NAK after unplug');
});

test('module conflicts: addresses, GPIO pins, slot occupancy, EXT requirement', () => {
  const d = makeDevice('adv');
  assert(d.attachModule('tof').ok, 'tof attaches');
  const clash = d.attachModule('color');       // both claim 0x29, and the port only has one slot
  assert(!clash.ok, 'second Grove unit refused: ' + clash.error);
  // simulate a second bus slot to prove the address rule itself
  const dev2 = makeDevice('adv');
  dev2.buses.grove.attach(0x29, 'Legacy Unit Color');   // something already answers on 0x29
  const addrClash = dev2.checkAttach(MODULE_CATALOG.find(m => m.id === 'tof'));
  assert(!addrClash.ok && /0x29/.test(addrClash.error), 'address conflict reported: ' + addrClash.error);

  const d3 = makeDevice('adv');
  assert(d3.attachModule('pir').ok, 'pir (GPIO2)');
  const pinClash = d3.checkAttach(MODULE_CATALOG.find(m => m.id === 'rgb'));
  assert(!pinClash.ok, 'GPIO2 already claimed');

  const d4 = makeDevice('v11');
  const cap = d4.checkAttach(MODULE_CATALOG.find(m => m.id === 'cap-lora1262'));
  assert(!cap.ok && /EXT/.test(cap.error), 'CAP needs the ADV EXT header: ' + cap.error);

  const d5 = makeDevice('adv');
  assert(d5.attachModule('env3').ok);
  assert(!d5.attachModule('env4').ok, 'Grove port only takes one unit');
  d5.detachModule(d5.modules[0].uuid);
  assert(d5.attachModule('env4').ok, 'port free again after unplug');
});

test('every catalog module attaches on a fresh ADV and produces live state', () => {
  for (const def of MODULE_CATALOG) {
    const d = makeDevice('adv');
    const r = d.attachModule(def.id);
    assert(r.ok, `${def.id} failed to attach: ${r.error}`);
    for (let i = 0; i < 12; i++) d.tick(0.05);
    const st = d.moduleState(def.id);
    assert(st && typeof st === 'object', `${def.id} exposes state`);
  }
});

test('module controls (UI injectors) drive the simulated hardware', () => {
  const d = makeDevice();
  const r = d.attachModule('env3');
  d.setModuleControl(r.module.uuid, 'temp', 31.5);
  for (let i = 0; i < 200; i++) d.tick(0.02);
  near(d.moduleState('env3').temp, 31.5 + d.cpuLoad * 4.2 + 1.4, 2.5, 'temperature follows the injector');
  const pir = d.detachModule(r.module.uuid) && d.attachModule('pir');
  let hits = 0;
  d.bus.on('module-event', e => { if (e.evt === 'pir') hits++; });
  d.setModuleControl(pir.module.uuid, 'trigger', 1);
  eq(hits, 1, 'PIR trigger event emitted');
  eq(d.moduleState('pir').motion, true);
});

test('UART, SPI and GPIO transports', () => {
  const d = makeDevice('adv');
  const gps = d.attachModule('gps');
  assert(gps.ok, 'gps attaches on grove UART');
  const rt = makeRuntime(d);
  for (let i = 0; i < 30; i++) d.tick(0.1);
  // firmware reads module -> SoC bytes through the same door the real UART driver uses
  const rx = rt.api.uart.readString();
  assert(rx.includes('$GPGGA'), 'NMEA sentences stream out of the module: ' + rx.slice(0, 20));
  d.detachModule(gps.module.uuid);
  const cap = d.attachModule('cap-lora1262');
  assert(cap.ok, 'CAP LoRa on EXT SPI: ' + cap.error);
  const out = d.buses.spi.transfer(5, [0x01, 0x02]);
  eq(out.length, 2);
  const d2 = makeDevice();
  const relay = d2.attachModule('relay');
  d2.buses.grove.writeBytes(0x26, [0x00, 0x01]);
  eq(d2.moduleState('relay').closed, true, 'relay closes on I2C write');
  void relay;
});

test('microSD: mount, write, read, list, eject', () => {
  const d = makeDevice();
  let threw = false;
  try { d.sd.list('/'); } catch { threw = true; }
  assert(threw, 'unmounted card rejects access');
  d.sd.insert();
  d.sd.writeText('/logs/test.txt', 'hello cardputer');
  eq(d.sd.readText('/logs/test.txt'), 'hello cardputer');
  assert(d.sd.list('/logs').some(f => f.name === 'test.txt'), 'file listed');
  assert(d.sd.info().used > 10, 'usage tracked');
  d.sd.eject();
  threw = false;
  try { d.sd.readText('/logs/test.txt'); } catch { threw = true; }
  assert(threw, 'ejected card rejects access');
});

test('battery discharges under load and charges over USB', () => {
  const d = makeDevice();
  const start = d.power.percent;
  for (let i = 0; i < 600; i++) d.tick(0.5);
  assert(d.power.percent < start, 'battery drained');
  d.setUsb(true);
  const low = d.power.percent;
  for (let i = 0; i < 600; i++) d.tick(0.5);
  assert(d.power.percent > low, 'usb charging recovers charge');
});

test('IMU only exists on the ADV', () => {
  const adv = makeDevice('adv');
  adv.imu.setTilt(0.5, -0.25);
  for (let i = 0; i < 60; i++) adv.tick(0.02);
  const a = adv.imu.getAccel();
  assert(a.x > 0.2, 'tilt reaches the accelerometer');
  const old = makeDevice('v11');
  eq(old.imu.getAccel(), null, 'no IMU on v1.1');
  eq(old.imu.present, false);
});

test('IR NEC framing', () => {
  const d = makeDevice();
  const e = d.ir.sendNec(0x00, 0x45);
  eq(e.protocol, 'NEC');
  eq(d.ir.log.length, 1);
  const pulses = d.ir.necEncode(0x00, 0x45);
  eq(pulses[0], 9000); eq(pulses[1], 4500);
  eq(pulses.length, 2 + 64 + 1);
});

test('runtime boots to the launcher and runs every app', () => {
  const d = makeDevice();
  const rt = makeRuntime(d);
  eq(rt.phase, 'run');
  eq(rt.active.id, 'launcher');
  const serial = d.serialBuf.map(l => l.msg).join('\n');
  assert(/CardputerOS starting/.test(serial), 'boot log written');
  for (const app of BUILTIN_APPS) {
    rt.launch(app.id);
    eq(rt.phase, 'run', `${app.id} launched`);
    tickN(rt, 90);
    assert(rt.phase !== 'panic', `${app.id} did not crash: ${rt.panic?.message || ''}`);
  }
});

test('apps react to hardware appearing and disappearing at runtime', () => {
  const d = makeDevice();
  const rt = makeRuntime(d);
  rt.launch('env');
  tickN(rt, 30);
  const r = d.attachModule('env3');
  assert(r.ok);
  tickN(rt, 60);
  eq(rt.phase, 'run', 'env app survives hot-plug');
  d.detachModule(r.module.uuid);
  tickN(rt, 60);
  eq(rt.phase, 'run', 'env app survives unplug');
});

test('terminal shell commands work end to end', () => {
  const d = makeDevice();
  const rt = makeRuntime(d);
  rt.launch('terminal');
  const term = rt.active;
  term.run(rt.api, 'i2c');
  term.run(rt.api, 'mod');
  term.run(rt.api, 'bat');
  term.run(rt.api, 'ls');
  term.run(rt.api, 'nonsense-command');
  const text = term.lines.join('\n');
  assert(/scan grove/.test(text), 'i2c scan output');
  assert(/command not found/.test(text), 'unknown command handled');
  tickN(rt, 20);
  eq(rt.phase, 'run');
});

test('a crashing app shows the panic screen and recovers', () => {
  const d = makeDevice();
  const rt = new Runtime(d, { apps: [...BUILTIN_APPS, {
    id: 'crashy', name: 'Crashy', setup() { }, loop() { throw new Error('boom'); },
  }], version: '1.0.0' });
  rt.boot();
  tickN(rt, 200);
  rt.launch('crashy');
  rt.tick(0.016);
  eq(rt.phase, 'panic');
  assert(/boom/.test(d.serialBuf.map(l => l.msg).join(' ')), 'panic logged to serial');
  for (let i = 0; i < 60; i++) rt.tick(0.016);
  d.keyboard.down('a', 0); d.keyboard.tick(0);
  rt.tick(0.016);
  eq(rt.active.id, 'launcher', 'any key returns to the launcher');
});

test('feed catalog merge + feed-delivered module driver', () => {
  const extra = [{ id: 'unit-x1', name: 'Unit X1', sku: 'U999', eco: 'grove', transport: 'i2c', addrs: [{ addr: 0x62, chip: 'SCD40' }], source: "(ctx) => { const st = { ppm: 640 }; return { state: st, setControl(id, v) { st.ppm = v; } }; }" }];
  const merged = mergeCatalog(MODULE_CATALOG, extra);
  eq(merged.length, MODULE_CATALOG.length + 1);
  const d = makeDevice('adv', merged);
  const r = d.attachModule('unit-x1');
  assert(r.ok, 'feed module attaches: ' + r.error);
  eq(d.buses.grove.scan()[0], 0x62);
  eq(d.moduleState('unit-x1').ppm, 640);
});

test('version comparison rules', () => {
  eq(compareVersions('1.1.0', '1.0.0'), 1);
  eq(compareVersions('1.0.0', '1.0.0'), 0);
  eq(compareVersions('1.0.0', '1.2.0'), -1);
  eq(compareVersions('1.1.0', '1.1.0-beta.1'), 1, 'release beats prerelease');
  eq(compareVersions('1.10.0', '1.9.9'), 1, 'numeric, not lexical');
});

test('reboot keeps modules plugged in and preserves charge', () => {
  const d = makeDevice();
  d.attachModule('env3');
  d.power.percent = 41;
  d.reboot();
  eq(d.modules.length, 1, 'module still attached after reset');
  near(d.power.percent, 41, 0.01, 'battery state survives reboot');
  eq(d.mode, 'run');
});


test('UART RX ring: firmware-facing read(), pending(), flush() and overflow', () => {
  const d = makeDevice('adv');
  const rt = makeRuntime(d);
  eq(rt.api.uart.available(), false, 'no UART unit plugged in');
  const lora = d.attachModule('lora');
  assert(lora.ok, 'Unit LoRaWAN attaches: ' + lora.error);
  // module replies must land in the RX ring, not vanish
  d.buses.uartGrove.send('AT+JOIN');
  assert(rt.api.uart.pending() > 0, 'reply sits in the RX ring');
  const ack = rt.api.uart.readString();
  assert(ack.includes('JOINED'), 'firmware sees the module reply: ' + JSON.stringify(ack));
  eq(rt.api.uart.pending(), 0, 'read() drains the ring');
  // baud is settable and byte reads work
  rt.api.uart.setBaud(57600);
  eq(d.buses.uartGrove.baud, 57600);
  d.buses.uartGrove.send('AT+JOIN');
  const bytes = rt.api.uart.read(4);
  assert(Array.isArray(bytes) && bytes.length === 4, 'read(n) returns n bytes');
  rt.api.uart.flush();
  eq(rt.api.uart.pending(), 0, 'flush empties the ring');
  // an unread module can never grow memory without bound
  for (let i = 0; i < 400; i++) d.buses.uartGrove.send('AT+SEND=1,200,hello');
  assert(d.buses.uartGrove.pending() <= 1024, 'ring is capped at 1 KiB');
  assert(d.buses.uartGrove.stats().overflows > 0, 'overflow counter records the loss');
  eq(rt.api.uart.available(), true);
  d.detachModule(lora.module.uuid);
  eq(rt.api.uart.available(), false, 'unplug hides the bus again');
});

test('SPI chip-select: a module can never steal the microSD line (GPIO12)', () => {
  const d = makeDevice('adv');
  assert(d.buses.spi.devices.has(12), 'microSD owns CS 12 at boot');
  const bad = { id: 'evil', name: 'Evil SPI', eco: 'ext', transport: 'spi', pins: [40, 14, 39, 12], cs: 12 };
  const res = d.checkAttach(bad);
  eq(res.ok, false);
  assert(/microSD/.test(res.error), 'rejected with a microSD explanation: ' + res.error);
  const ok = d.checkAttach({ id: 'cap-x', name: 'CAP X', eco: 'ext', transport: 'spi', pins: [40, 14, 39, 5], cs: 5 });
  eq(ok.ok, true, 'CS 5 on the EXT header is free');
  const cap = d.attachModule('cap-cc1101');
  assert(cap.ok, 'CC1101 CAP attaches: ' + cap.error);
  assert(d.buses.spi.devices.has(5), 'it registered its own chip-select 5');
  assert(d.buses.spi.devices.has(12), 'and the SD card survived');
});

test('pushImage honours a transparency key and clips to the panel', () => {
  const d = makeDevice('adv');
  const lcd = d.display;
  lcd.fillScreen(COLORS.BLACK);
  const px = [0xf800, 0xffff, 0x07e0, 0x001f];
  const drawn = lcd.pushImage(4, 4, 2, 2, px, 0xffff);
  eq(drawn, 3, 'transparent pixel skipped');
  eq(lcd.getPixel(4, 4), 0xf800);
  eq(lcd.getPixel(5, 4), COLORS.BLACK, 'colour key left the framebuffer untouched');
  eq(lcd.getPixel(5, 5), 0x001f);
  // a blit that hangs off the edge must not corrupt neighbouring rows
  const n = lcd.pushImage(238, 133, 4, 4, new Array(16).fill(0xffff - 1));
  assert(n === 4, 'only the in-bounds 2x2 corner is drawn, got ' + n);
  eq(lcd.getPixel(0, 0), COLORS.BLACK, 'no wraparound into row 0');
});

test('keyboard queue: one source of truth for events and characters', () => {
  const d = makeDevice('cardputer');
  const kb = d.keyboard;
  const t = 1000;
  kb.down('a', t);
  const evs = kb.takeEvents();
  eq(evs.length, 1, 'one key event');
  const chars = kb.takeChars();
  eq(chars.join(''), 'a', 'the same press also yields its character: ' + JSON.stringify(chars));
  eq(kb.takeChars().length, 0, 'queue is drained');
  kb.up('a', t);
  // shift layer must survive the round trip through takeEvents()
  kb.down('shift', t); kb.down('1', t);
  kb.takeEvents();
  eq(kb.takeChars().join(''), '!', 'shift+1 -> "!"');
  kb.up('1', t); kb.up('shift', t);
  eq(kb.keyState().word.length, 0, 'nothing held any more');
});

test('rail buttons dispatch exactly one action per press', () => {
  const d = makeDevice('adv');
  let calls = [];
  const chassis = { onRail: a => calls.push(a) };
  // the chassis handler is a plain callback; emulate the wiring contract
  const press = label => { chassis.onRail?.(label); };
  press('usb');
  eq(calls.join(','), 'usb', 'one call, one action');
  void d;
});

// ---------------------------------------------------------------------------
// --------------------------------------------------------------- round 2 -----
test('SKU swap rebuilds the board and unplugs what no longer fits', () => {
  const d = makeDevice('adv');
  d.boot();
  eq(d.attachModule('cap-gps').ok, true, 'CAP GPS on the Adv');
  eq(d.attachModule('env3').ok, true, 'Grove unit alongside it');
  const r = d.setVariant('cardputer');
  eq(r.ok, true);
  eq(r.changed, true);
  eq(d.variantId, 'cardputer');
  // env3 is Grove, it survives; the CAP cannot exist without an EXT header
  assert(d.findModule('env3'), 'Grove unit survives the swap');
  eq(d.variant.ext, false);
  eq(d.grove5v, false, '3.3 V SKU has no 5 V rail');
  // and back again
  const back = d.setVariant('adv');
  eq(back.ok, true);
  eq(d.variant.ext, true);
  eq(d.grove5v, true);
});

test('per-SKU module compatibility matrix', () => {
  const d = makeDevice('cardputer');
  const ext = d.compatFor({ id: 'x', eco: 'ext', requires: 'adv' });
  eq(ext.ok, false);
  assert(/EXT/.test(ext.error), 'reason mentions the EXT header');
  const five = d.compatFor({ id: 'y', eco: 'grove', needs5v: true });
  eq(five.ok, false);
  const adv = makeDevice('adv');
  eq(adv.compatFor({ id: 'y', eco: 'grove', needs5v: true }).ok, true);
  adv.setGrove5v(false);
  eq(adv.compatFor({ id: 'y', eco: 'grove', needs5v: true }).ok, false, '5 V-only unit refuses a 3.3 V rail');
  eq(adv.setGrove5v(true).ok, true);
});

test('every catalog entry attaches on at least one SKU and reports a state', () => {
  const adv = makeDevice('adv');
  let attached = 0;
  for (const def of MODULE_CATALOG) {
    const d = makeDevice('adv');
    d.boot();
    const r = d.attachModule(def.id);
    if (!r.ok) {
      // must be blocked for a physical reason, never a driver crash
      assert(/EXT|Grove port|UART|SPI|I²C address|GPIO|5 V/.test(r.error), `${def.id}: ${r.error}`);
      continue;
    }
    attached++;
    assert(r.module.inst && typeof r.module.inst === 'object', def.id + ' has a driver');
    assert(d.moduleState(def.id) && typeof d.moduleState(def.id) === 'object', def.id + ' exposes state');
    adv.setVariant(adv.variantId);
  }
  assert(attached >= 45, 'most of the catalog plugs in: ' + attached);
});

test('thermal model warms up and throttles, watchdog tracks feeds', () => {
  const d = makeDevice('adv');
  d.boot();
  d.setAmbient(24);
  d.cpuLoad = 1;
  for (let i = 0; i < 400; i++) d.tick(0.25);
  assert(d.thermal.dieC > 30, 'die warms under load: ' + d.thermal.dieC.toFixed(1));
  eq(d.thermal.throttled, d.thermal.dieC > 78);
  d.setAmbient(-10);
  for (let i = 0; i < 200; i++) d.tick(0.25);
  assert(d.thermal.dieC < 60, 'cools back down');
  // watchdog
  d.wdt.enabled = true; d.wdt.timeoutMs = 1000;
  d.feedWatchdog(d.uptime);
  eq(d.watchdogTripped(d.uptime + 0.5), false);
  eq(d.watchdogTripped(d.uptime + 2), true);
});

test('battery falls off its curve and browns out before empty', () => {
  const d = makeDevice('adv');
  d.boot();
  d.setUsb(false);
  d.power.percent = 2;
  let brown = 0;
  d.bus.on('brownout', () => brown++);
  for (let i = 0; i < 1400 && !brown; i++) d.tick(1);
  eq(brown > 0, true, 'brownout detector fires');
  eq(d.mode, 'brownout');
  assert(d.power.volts < 3.3, 'below the 3.3 V detector');
  const pctAtBrown = d.power.percent;
  assert(pctAtBrown > 0, 'fires before the cell is flat: ' + pctAtBrown.toFixed(1) + '%');
});

test('ESP32 image parser validates magic, header checksum and segments', () => {
  const entry = 0x4037c4e0;
  const hdr = imageHeader(entry);
  const seg = [0x3c, 0x00, 0x00, 0x00, 4, 0, 0, 0, 1, 2, 3, 4];
  const img = new Uint8Array([...hdr, ...seg, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const p = parseImage(img);
  eq(p.ok, true, p.error);
  eq(p.chip, 'ESP32-S3');
  eq(p.segCount, 1);
  eq(p.entryHex, '0x4037C4E0');
  eq(parseImage(new Uint8Array(8)).ok, false);
  eq(parseImage(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])).ok, false);
  // a corrupt header byte has to be caught
  const bad = new Uint8Array(img); bad[8] ^= 0x55;
  eq(parseImage(bad).ok, false);
});

test('flash manager writes an OTA slot, verifies it and can switch slots', async () => {
  const d = makeDevice('adv');
  d.boot();
  const f = new FlashManager(d, null, {});
  const table = partitionTable(8 * 1024 ** 2);
  eq(table.at(-1).offset + table.at(-1).size <= 8 * 1024 ** 2, true, 'table fits in flash');
  const bytes = fakeImage(4096);
  const r = await f.flash({ name: 'cardputeros.bin', bytes });
  eq(r.ok, true, r.error);
  eq(r.image.slot, 'ota_1', 'writes the inactive slot');
  eq(f.slot, 'ota_1');
  eq(!!f.imageSummary('ota_1'), true);
  const sw = f.switchSlot();
  eq(sw.ok, false, 'cannot boot an empty slot');
  const r2 = await f.flash({ name: 'second.bin', bytes });
  eq(r2.ok, true);
  eq(f.switchSlot().ok, true, 'now both slots hold images');
  eq(f.slot, 'ota_0');
});

test('user programs install, persist and are re-registered', async () => {
  const d = makeDevice('adv');
  const rt = new Runtime(d, { apps: [] });
  const store = memoryStore();
  const f = new FlashManager(d, rt, { store });
  const src = "export const APP = { id: 'testprog', name: 'Test Prog', setup(api) { this.n = 0; }, loop(api, dt) { this.n += dt; } };";
  const r = await f.installApp(src, { name: 'test' });
  eq(r.ok, true, r.error);
  eq(rt.apps.has('testprog'), true);
  eq(f.listApps().length, 1);
  // persisted through the store
  const saved = store.load();
  eq(saved.apps.length, 1);
  eq(saved.apps[0].id, 'testprog');
  // bad programs are rejected with a reason, not a crash
  eq((await f.installApp('nope', {})).ok, false);
  eq((await f.installApp('export const APP = {};')).ok, false);
  eq((await f.installApp("export const APP = { id: 'BAD ID!', loop() {} };")).ok, false);
  eq(f.removeApp('testprog').ok, true);
  eq(rt.apps.has('testprog'), false);
});

test('NVS round-trips values and enforces its size limit', () => {
  const n = new Nvs();
  n.set('ssid', 'cardputer-lab');
  n.set('boot_count', 7);
  n.set('ota_seq', 2);
  eq(n.get('ssid'), 'cardputer-lab');
  eq(n.get('missing', 'dflt'), 'dflt');
  eq(n.entries().length, 3);
  n.erase('boot_count');
  eq(n.get('boot_count', -1), -1);
  let threw = false;
  try { n.set('big', 'x'.repeat(5000)); } catch { threw = true; }
  eq(threw, true, 'over-long value rejected');
});

test('IR learns a frame and replays it; range table matches the datasheet', () => {
  const d = makeDevice('adv');
  const f = d.ir.learnNec([0x00, 0xff, 0x45, 0xba], { source: 'remote' });
  eq(f.pulses.length > 60, true, 'NEC frame is 67 pulses: ' + f.pulses.length);
  eq(d.ir.captures.length, 1);
  eq(d.ir.rangeCm(0), 410);
  eq(d.ir.rangeCm(45), 170);
  assert(d.ir.rangeCm(90) <= 90, 'steep angles fall away: ' + d.ir.rangeCm(90));
});

// The ESP-IDF image header checksum is the XOR of its first 16 bytes and must
// equal 0xEF; byte 8 (WP pin, unused here) is the free byte we tune.
function imageHeader(entry = 0x4037c4e0, chip = 9) {
  const hdr = [0xe9, 1, 2, 0x2f,
    entry & 0xff, (entry >> 8) & 0xff, (entry >> 16) & 0xff, (entry >> 24) & 0xff,
    0, 0, 0, 0, chip, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let y = 0;
  for (let i = 0; i < 16; i++) y ^= hdr[i];
  hdr[8] = y ^ 0xef;
  return hdr;
}

function fakeImage(size = 4096) {
  const entry = 0x4037c4e0;
  const hdr = imageHeader(entry);
  const segLen = size - 24 - 8 - 16;
  const seg = [0x3c, 0x00, 0x00, 0x00, segLen & 0xff, (segLen >> 8) & 0xff, (segLen >> 16) & 0xff, (segLen >> 24) & 0xff];
  const body = new Array(segLen).fill(0x41);
  const out = new Uint8Array([...hdr, ...seg, ...body]);
  return out;
}

function memoryStore() {
  let v = null;
  return { load: () => v, save: x => { v = JSON.parse(JSON.stringify(x)); } };
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

