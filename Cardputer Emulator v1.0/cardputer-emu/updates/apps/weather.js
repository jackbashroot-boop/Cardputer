// =============================================================================
//  Weather — firmware app delivered as a *soft update* from the release feed.
//  Not part of the 1.0.0 bundle: it appears in the launcher after you install
//  v1.1.0 from the Updates panel (or run `python run.py --update`).
// =============================================================================
const COL = {
  bg: 0x0841, panel: 0x10c3, ink: 0xFFFF, dim: 0x8410, accent: 0xFE80, hot: 0xFB00, cool: 0x3C1F,
};

const OUTLOOK = [
  { d: 'MON', hi: 12, lo: 4, sky: 'CLOUD' },
  { d: 'TUE', hi: 15, lo: 6, sky: 'SUN' },
  { d: 'WED', hi: 9, lo: 2, sky: 'RAIN' },
  { d: 'THU', hi: 7, lo: 1, sky: 'RAIN' },
  { d: 'FRI', hi: 11, lo: 3, sky: 'SUN' },
];

export const APP = {
  id: 'weather',
  name: 'Weather',
  icon: 'WX',
  color: '#38bdf8',
  category: 'sensors',
  version: '1.0.0',
  about: 'Arrived via the update feed. Reads the Grove ENV unit when one is attached, otherwise uses a cached forecast.',
  setup(api) {
    this.day = 0;
    this.inside = null;
    this.acc = 0;
    api.serial.println('weather app started (soft-installed)');
  },
  loop(api, dt) {
    const L = api.lcd;
    const k = api.input();
    if (k.esc) return api.exit();
    if (k.right) this.day = (this.day + 1) % OUTLOOK.length;
    if (k.left) this.day = (this.day + OUTLOOK.length - 1) % OUTLOOK.length;

    // hot-plug aware: sample the ENV unit if the user has one on the Grove port
    this.acc += dt;
    if (this.acc > 0.5) {
      this.acc = 0;
      for (const id of ['env3', 'env4', 'envpro']) {
        const s = api.modules.state(id);
        if (s) { this.inside = { temp: s.temp, hum: s.humidity, src: id }; break; }
        this.inside = null;
      }
    }

    const day = OUTLOOK[this.day];
    L.fillScreen(COL.bg);
    L.fillRect(0, 0, 240, 13, COL.panel);
    L.drawString(4, 3, 'WEATHER', COL.ink, 1);
    L.drawRightString(this.inside ? 'ENV ' + this.inside.src : 'CACHED', COL.accent, 1);

    L.drawString(6, 20, day.d, COL.dim, 1);
    L.drawRightString(day.hi + '°', 96, 14, COL.ink, 4);
    L.drawString(102, 26, '/ ' + day.lo + '°', COL.dim, 2);

    // sky glyph, drawn from primitives like real firmware would
    if (day.sky === 'SUN') {
      L.fillCircle(196, 34, 12, COL.accent);
      for (let a = 0; a < 8; a++) {
        const r = (a / 8) * Math.PI * 2;
        L.drawLine(196 + Math.cos(r) * 16, 34 + Math.sin(r) * 16, 196 + Math.cos(r) * 22, 34 + Math.sin(r) * 22, COL.accent);
      }
    } else if (day.sky === 'RAIN') {
      L.fillCircle(184, 32, 10, COL.dim); L.fillCircle(198, 32, 12, COL.dim); L.fillCircle(210, 32, 9, COL.dim);
      for (let i = 0; i < 5; i++) L.drawLine(180 + i * 9, 46, 177 + i * 9, 54, COL.cool);
    } else {
      L.fillCircle(184, 32, 10, COL.dim); L.fillCircle(198, 32, 13, COL.dim); L.fillCircle(212, 32, 9, COL.dim);
    }
    L.drawString(6, 46, day.sky, COL.accent, 1);

    // five-day strip
    L.fillRect(0, 60, 240, 1, 0x2124);
    OUTLOOK.forEach((o, i) => {
      const x = 6 + i * 46;
      const sel = i === this.day;
      if (sel) L.fillRoundRect(x - 2, 64, 44, 40, 4, COL.panel);
      L.drawString(x, 66, o.d, sel ? COL.accent : COL.dim, 1);
      L.drawString(x, 78, o.hi + '°', sel ? COL.ink : COL.dim, 2);
      const h = Math.max(2, o.hi - 4);
      L.fillRect(x + 30, 92 - h, 5, h, o.sky === 'SUN' ? COL.accent : COL.cool);
    });

    // indoor panel from the Grove sensor, or a hint to plug one in
    const y = 108;
    L.fillRect(0, y - 4, 240, 1, 0x2124);
    if (this.inside) {
      L.drawString(6, y, 'INDOOR', COL.dim, 1);
      L.drawString(50, y - 3, this.inside.temp.toFixed(1) + '°C', COL.ink, 2);
      L.drawString(120, y, this.inside.hum.toFixed(0) + '% RH', COL.accent, 1);
      L.drawString(180, y, 'OK', 0x07E0, 1);
    } else {
      L.drawString(6, y, 'plug a Grove ENV unit for indoor data', COL.dim, 1);
    }
    L.drawString(6, 124, '< > day   Fn+` back', 0x6B4D, 1);
  },
};
