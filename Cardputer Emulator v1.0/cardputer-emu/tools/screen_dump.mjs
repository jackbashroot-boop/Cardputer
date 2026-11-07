// Dump real LCD framebuffers from the emulator core (headless, no DOM) so the
// artwork is driven by the actual emulator rather than by hand-drawn pixels.
//
//   node tools/screen_dump.mjs --app env --module env3 --frames 240 --out /tmp/screen.json
//   node tools/screen_dump.mjs --app terminal --keys "help⏎" --out /tmp/term.json
//
// Emits { app, frames, w, h, rgb565: number[240*135], text: string[] } — the text
// array is the screen as ASCII, handy when you want to check what was rendered.
import { readFileSync, writeFileSync } from 'node:fs';
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
const { Cardputer, Runtime, BUILTIN_APPS, MODULE_CATALOG, KEY_BY_ID } =
  new Function(`${code}\nreturn { Cardputer, Runtime, BUILTIN_APPS, MODULE_CATALOG, KEY_BY_ID };`)();

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const app = arg('app', 'env');
const variant = arg('variant', 'adv');
const frames = Number(arg('frames', 240));
const modules = (arg('module', 'env3') || '').split(',').filter(Boolean);
const keys = arg('keys', '');
const out = arg('out', '');

const device = new Cardputer({ variant, catalog: MODULE_CATALOG });
device.boot();
for (const id of modules) device.attachModule(id);
const runtime = new Runtime(device, { apps: BUILTIN_APPS, version: '1.0.0' });
runtime.boot();
for (let i = 0; i < 200; i++) runtime.tick(0.016);
runtime.launch(app);

// optional scripted typing, e.g. --keys "help⏎" (⏎ = Enter)
let t = 0;
for (const ch of keys) {
  if (ch === '⏎') { device.keyboard.down('enter', t); device.keyboard.up('enter', t + 30); }
  else {
    const id = ch === ' ' ? 'space' : ch;
    if (!KEY_BY_ID.has(id)) continue;
    device.keyboard.down(id, t); device.keyboard.up(id, t + 30);
  }
  for (let i = 0; i < 6; i++) { device.tick(0.016); runtime.tick(0.016); }
  t += 100;
}
for (let f = 0; f < frames; f++) { device.tick(0.016); runtime.tick(0.016); }

const lcd = device.display;
const text = [];
for (let y = 0; y < lcd.h; y += 8) {
  let line = '';
  for (let x = 0; x < lcd.w; x += 2) {
    const c = lcd.buf[y * lcd.nativeW + x];
    const lum = ((c >> 11) & 0x1f) * 2 + ((c >> 5) & 0x3f) + (c & 0x1f) * 2;
    line += lum > 60 ? '#' : lum > 16 ? '+' : '.';
  }
  text.push(line);
}
const payload = { app, variant, modules, frames, w: lcd.w, h: lcd.h, rgb565: Array.from(lcd.buf), text };
if (out) {
  writeFileSync(out, JSON.stringify(payload));
  console.log(`wrote ${out} — ${payload.w}x${payload.h}, app=${app}, modules=${modules.join('+') || 'none'}`);
} else {
  console.log(text.join('\n'));
}
