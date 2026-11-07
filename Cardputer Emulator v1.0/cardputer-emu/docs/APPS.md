# Firmware apps

A firmware app is an Arduino-style program: `setup()` runs once, `loop()` runs every
frame. Apps are plain ES modules, so the update feed can deliver new ones at runtime.

```js
export const APP = {
  id: 'hello',
  name: 'Hello',
  icon: 'HI',              // two characters, drawn in the launcher tile
  color: '#38bdf8',
  category: 'tools',
  version: '1.0.0',

  setup(api) { api.lcd.drawString(4, 4, 'hello', api.COLORS.WHITE, 1); },

  loop(api, dt) {
    const k = api.input();
    if (k.esc) return api.exit();
    api.lcd.drawString(4, 20, 'dt ' + dt.toFixed(3), api.COLORS.GREEN, 1);
  },

  onKey(ev, api) { /* optional: ev = {type:'down'|'up', id, row, col} */ },
};
```

Built-ins live in `src/js/apps/apps.js` (`BUILTIN_APPS`); feed-delivered apps are imported
from a URL and registered in `runtime.apps`.

## Display (`api.lcd`, `api.M5.Lcd`)

```
fillScreen(c)  clear()  drawPixel(x,y,c)  drawLine  drawRect  fillRect
drawRoundRect / fillRoundRect(x,y,w,h,r,c)  drawCircle / fillCircle(cx,cy,r,c)
fillTriangle(x0,y0,x1,y1,x2,y2,c)  drawString(x,y,str[,color,size])
drawCentreString(str,cx,y[,color,size])  drawRightString(str,rx,y[,color,size])
setTextSize(size)  setCursor(x,y)  print / println  scroll(dy)
setBrightness(0..1)  setRotation(0..3)  width / height
COLORS.*  color565(r,g,b)
```

Text is the classic 5×7 GLCD font. Characters the font doesn't have (degree sign, arrows,
dashes) are transliterated automatically — `°` maps to the real degree glyph, `▶` becomes
`>`, anything unmappable becomes `?`.

## Input

```js
const k = api.input();   // edge-triggered for this frame
k.up k.down k.left k.right k.enter k.esc k.space k.backspace k.tab
k.fn k.shift k.ctrl k.any k.ids
```

Arrows and Esc live on the Cardputer's Fn layer, so `api.input()` accepts both
`Fn + ; . , /` and synthetic `up/down/left/right` events. Raw access:

```js
api.keys()                 // [{type:'down'|'up', id:'a', row, col}]
api.chars()                // characters produced this frame
api.typed()                // the same, as a string
api.state()                // {word, fn, shift, ctrl, opt, del, enter, tab, space, fnKeys, arrows}
api.pressed('shift')       // is a key held right now
```

## Peripherals

```js
api.M5.Speaker.tone(freq, ms, 'square'|'sine'|'sawtooth', volume)
api.M5.Speaker.setVolume(0..1)   getVolume()   stop()   isEnabled()
api.M5.Mic.record(ms[, rate])    // Float32Array of samples
api.M5.Mic.rms(samples)          api.M5.Mic.getLevel()
api.M5.Imu.available()           getAccel()  getGyro()  getTilt()      // BMI270
api.M5.IR.sendNec(addr, cmd)     sendRaw(pulses)     api.M5.IR.log
api.M5.Power.getBatteryLevel()   getBatteryVoltage()  isCharging()  setLed(r,g,b)
api.M5.Ex_I2C.scan()             readRegister(addr, reg, n)  writeRegister(addr, reg, v)
api.M5.In_I2C.scan()             // internal bus (codec, IMU, keypad controller)
api.M5.Sd.readFile / writeFile / listDir / info / mkdir / remove / isMounted
api.wifi.scan()  connect(ssid, pass)  status()  bleScan()
api.http.get(url)                // proxied through the launcher when present
api.gpio.digitalRead(pin)  analogRead(pin)  digitalWrite(pin, level)
api.uart.available()  send(text)
```

## Modules

```js
api.modules.list()          // [{uuid, id, name, eco, state}]
api.modules.has('env3')
api.modules.state('env3')   // live simulator state, e.g. {temp, humidity, pressure}
api.modules.find('env3')    // driver instance
api.modules.require('env3') // throws "module is not attached — plug it in…"
```

Because unplugging detaches a real bus device, defensive code is realistic — wrap raw
I²C reads in `try/catch` and you'll see genuine NAKs.

## Misc

```js
api.millis()  api.micros()  api.delay()   // delay() is cooperative, never blocks
api.random(a,b)  api.map(v,a1,a2,b1,b2)  api.constrain(v,a,b)
api.apps.list()  api.apps.launch('env')  api.exit()  api.reboot()
api.notify('message', 'ok'|'error')      // toast in the host UI
api.serial.println('…')                  // serial console
api.ui.header(title, right)  api.ui.footer(text)
api.ui.list(items, sel, opts)  api.ui.gauge(x,y,w,h,pct,fg,bg)
```

## Crash handling

Any uncaught error inside `setup`, `loop` or `onKey` shows the panic screen, writes the
stack to the serial console, and returns to the launcher on the next key press — the same
behaviour a real device gives you, minus the brick.

## Delivering an app by update

1. Write `updates/apps/myapp.js` exporting `APP`.
2. Publish a release whose `soft.apps` lists it (`tools/make_update.py --soft …`).
3. On install the emulator imports it, registers it in the launcher grid and remembers
   the URL in `data/state.json` so it is restored on the next start.
