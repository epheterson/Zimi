// Capability levels (zimi/static/capability.js), executed from the shipped source with a stubbed browser:
// how a level is decided from the signals, what the person's word does, the governor's steps (down for good, the level
// dropping with them, the fallback), the plain line for the 3D view, and that every level's row has every key.
//
// Run: node tests/test_capability.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'capability.js'), 'utf8');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

// A browser with the given signals. gl: { webgl2, maxTex, renderer, strict } (strict: refuses a context under
// failIfMajorPerformanceCaveat, as a software renderer does).
function load(sig, stored) {
  const store = Object.assign({}, stored || {});
  const session = {};
  const mkStorage = (o) => ({ getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); }, removeItem: (k) => { delete o[k]; } });
  const gl = sig.gl;
  const ctx = {
    window: {},
    navigator: { deviceMemory: sig.mem, hardwareConcurrency: sig.cores, webdriver: !!sig.webdriver, connection: { saveData: !!sig.saveData } },
    matchMedia: (q) => ({ matches: /coarse/.test(q) ? !!sig.coarse : /reduce/.test(q) ? !!sig.reduced : false }),
    localStorage: mkStorage(store),
    sessionStorage: mkStorage(session),
    performance: { now: () => 0 },
    document: {
      createElement: () => ({
        width: 0, height: 0,
        getContext: (kind, opts) => {
          if (!gl || (kind === 'webgl2' && !gl.webgl2)) return null;
          if (opts && opts.failIfMajorPerformanceCaveat && gl.strict) return null;
          return {
            MAX_TEXTURE_SIZE: 1, RENDERER: 2, VERTEX_SHADER: 3, FRAGMENT_SHADER: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8, RGBA: 9, UNSIGNED_BYTE: 10,
            getParameter: (p) => (p === 1 ? gl.maxTex : gl.renderer),
            getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 99 } : { loseContext() {} }),
            // the micro-benchmark: every call answers, the clock below advances by the stated cost per draw
            createShader: () => ({}), shaderSource() {}, compileShader() {}, createProgram: () => ({}), attachShader() {}, linkProgram() {}, useProgram() {},
            createBuffer: () => ({}), getAttribLocation: () => 0, bindBuffer() {}, bufferData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
            viewport() {}, uniform1f() {}, getUniformLocation: () => ({}), drawArrays() {}, readPixels() { clock += sig.benchMs || 0; }
          };
        }
      })
    },
    setTimeout, console
  };
  let clock = 0;
  ctx.performance.now = () => clock;
  ctx.window = ctx;
  vm.createContext(ctx);
  // the renderer string is read through UNMASKED_RENDERER_WEBGL (99)
  const patched = src;
  vm.runInContext(patched.replace(/gl\.getParameter\(ext\.UNMASKED_RENDERER_WEBGL\)/, 'gl.getParameter(gl.RENDERER)'), ctx);
  return { cap: vm.runInContext('ZimiCap', ctx), store, session };
}
const GL = (o) => Object.assign({ webgl2: true, maxTex: 16384, renderer: 'Apple M2', strict: false }, o || {});

// ── The level from the signals ──
check(load({ mem: 8, cores: 10, gl: GL() }).cap.level() === 'high', 'a big desktop with a real GPU is high');
check(load({ mem: 8, cores: 10, gl: GL(), coarse: true }).cap.level() === 'standard', 'a touch screen is never above standard');
check(load({ mem: 8, cores: 10, gl: GL(), reduced: true }).cap.level() === 'standard', 'reduced motion is never above standard');
check(load({ mem: 8, cores: 10, gl: GL(), saveData: true }).cap.level() === 'standard', 'Save-Data is never above standard');
check(load({ mem: 4, cores: 6, gl: GL({ maxTex: 8192 }) }).cap.level() === 'standard', 'a mid machine is standard');
check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'Google SwiftShader', strict: true }) }).cap.level() === 'low', 'SwiftShader is low whatever the CPU');
check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'llvmpipe (LLVM 15)' }) }).cap.level() === 'low', 'llvmpipe is low');
check(load({ mem: 8, cores: 8, gl: GL({ strict: true }) }).cap.level() === 'low', 'a browser that refuses a real-GPU context is drawing in software: low');
check(load({ mem: 2, cores: 8, gl: GL() }).cap.level() === 'low', 'two gigabytes is low');
check(load({ mem: 8, cores: 2, gl: GL() }).cap.level() === 'low', 'two cores is low');
check(load({ mem: 4, cores: 4, gl: GL({ renderer: 'V3D 4.2' }) }).cap.level() === 'low', 'a Raspberry Pi 4 GPU is low');
check(load({ mem: 8, cores: 8, gl: GL({ maxTex: 2048 }) }).cap.level() === 'low', 'a small maximum texture is low');
check(load({ mem: 8, cores: 8, gl: null }).cap.level() === 'low', 'no WebGL is low');
check(load({ mem: 0, cores: 8, gl: GL(), benchMs: 0.5 }).cap.level() === 'high', 'no memory figure and a fast micro-benchmark: high');
check(load({ mem: 0, cores: 8, gl: GL(), benchMs: 4 }).cap.level() === 'standard', 'no memory figure and a middling benchmark: standard');
check(load({ mem: 0, cores: 8, gl: GL(), benchMs: 20 }).cap.level() === 'low', 'no memory figure and a slow benchmark: low');
{
  const r = load({ mem: 8, cores: 8, gl: GL(), benchMs: 20 });
  check(r.cap.signals().benchMs === 0, 'the benchmark does not run when the signals settle it');
}

// ── An automated browser is a test, not a device ──
{
  const sw = { mem: 8, cores: 8, gl: GL({ renderer: 'SwiftShader' }), webdriver: true };
  check(load(sw).cap.setting() === 'full' && load(sw).cap.view3d() === 'open', 'a test browser (webdriver) gets Full unless it says otherwise');
  check(load(sw, { zimi_cap: 'auto' }).cap.view3d() === 'static', 'a test of the levels says Auto in so many words');
}

// ── The 3D view opens, or gives a plain line ──
check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'SwiftShader' }) }).cap.view3d() === 'static', 'Auto on software GL: the plain line, not a tab crash');
check(load({ mem: 8, cores: 8, gl: null }).cap.view3d() === 'static', 'no WebGL: the plain line');
check(load({ mem: 4, cores: 4, gl: GL({ renderer: 'V3D 4.2' }) }).cap.view3d() === 'open', 'a low device with a real GPU still opens the view (lighter)');
{
  const r = load({ mem: 8, cores: 8, gl: GL({ renderer: 'SwiftShader' }) });
  r.cap.set('full');
  check(r.cap.view3d() === 'open' && r.cap.level() === 'high', 'Full is the person\'s word: the view tries, at the full level');
  r.cap.set('light');
  check(r.cap.view3d() === 'open' && r.cap.level() === 'low', 'Light tries the view at the low level');
  check(r.store.zimi_cap === 'light', 'the choice is kept on the device');
  r.cap.set('auto');
  check(r.cap.view3d() === 'static' && r.store.zimi_cap === 'auto', 'Auto asks the signals again');
}
{
  const r = load({ mem: 8, cores: 10, gl: GL() });
  r.cap.level();
  check(r.session.zimi_cap_level === 'high', 'the decision is kept for the session');
  const again = load({ mem: 8, cores: 10, gl: GL({ renderer: 'SwiftShader', strict: true }) });
  again.session.zimi_cap_level = 'standard';
  check(again.cap.level() === 'standard', 'a level kept for the session is used: the GPU is not asked twice');
}

// ── The governor ──
{
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap, events = [];
  c.on((e, info) => events.push(e));
  const dpr0 = c.dprCap('earth');
  check(dpr0 === 3 && c.dprCap('stand') === 2, 'high: the pixel ratios are the table\'s');
  let t = 1000;
  const slow = (scene, n, ms) => { for (let i = 0; i < n; i++) { t += ms || 40; c.frame(scene, t); } };
  c.frame('earth', t);
  slow('earth', 2);
  check(c.signals().step === 0 && c.dprCap('earth') === dpr0, 'a slow frame or two costs nothing');
  slow('earth', 1);
  check(c.signals().step === 1 && Math.abs(c.dprCap('earth') - dpr0 * 0.8) < 1e-9, 'three slow frames in a row step the pixel ratio down');
  check(events.indexOf('step') >= 0, 'a step is announced');
  t += 5000; c.frame('earth', t);   // an idle gap is not a slow frame
  t += 16; c.frame('earth', t);
  check(c.signals().step === 1, 'an idle gap and a fast frame cost nothing');
  slow('earth', 4);
  check(c.signals().step === 2 && c.level() === 'standard', 'the second step drops the level a notch too (high to standard)');
  slow('earth', 8);
  check(c.signals().step === 3 && c.level() === 'low', 'at the last step the level is low');
  const capLow = c.dprCap('stand');
  check(capLow === 1 * c.STEP[3], 'low: Stand draws at the table\'s ratio times the last step');
  slow('earth', 200, 80);
  check(events.indexOf('fallback') >= 0 && c.view3d() === 'static', 'forty-five slow frames at the bottom set the view aside');
  for (let i = 0; i < 400; i++) { t += 8; c.frame('earth', t); }
  check(c.signals().step === 3 && c.level() === 'low', 'nothing goes back up in the session');
  c.set('full');
  check(c.signals().step === 0 && c.view3d() === 'open' && c.level() === 'high', 'choosing Full starts over, and tries');
}
{
  // Full never gives way: the person asked for it.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap, events = [];
  c.set('full');
  c.on((e) => events.push(e));
  let t = 1000;
  c.frame('earth', t);
  for (let i = 0; i < 400; i++) { t += 60; c.frame('earth', t); }
  check(events.indexOf('fallback') < 0 && c.view3d() === 'open', 'Full keeps trying whatever the frames do');
}
{
  // A low device is judged by its own, slower frame (30 a second).
  const r = load({ mem: 4, cores: 4, gl: GL({ renderer: 'V3D 4.2' }) }), c = r.cap;
  let t = 1000;
  c.frame('earth', t);
  for (let i = 0; i < 100; i++) { t += 34; c.frame('earth', t); }
  check(c.signals().step === 0, 'low: frames at 30 a second are on time');
  check(c.get('fpsMax') === 30, 'low draws 30 frames a second at most');
}

// ── Context loss ──
{
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap, lost = [];
  const handlers = {};
  const canvas = { addEventListener: (n, fn) => { handlers[n] = fn; } };
  c.watchContext(canvas, (give) => lost.push(give), () => lost.push('restored'));
  const ev = () => ({ preventDefault() { this.prevented = true; } });
  let e1 = ev(); handlers.webglcontextlost(e1);
  check(e1.prevented && lost[0] === false, 'a lost context is held back for the browser to restore, and reported');
  handlers.webglcontextlost(ev());
  check(lost[1] === false, 'a second loss is still rebuilt');
  handlers.webglcontextlost(ev());
  check(lost[2] === true && c.view3d() === 'static', 'three in a minute: the view gives way');
  handlers.webglcontextrestored();
  check(lost[3] === 'restored', 'a restored context is reported');
}

// ── The GPU budget ──
{
  const c = load({ mem: 4, cores: 4, gl: GL({ renderer: 'V3D 4.2' }) }).cap;   // low: 96 MB
  const MB = 1048576;
  check(c.gpuTrack('earth-day', 40 * MB) && c.gpuTrack('earth-night', 40 * MB), 'two maps within the budget are tracked');
  check(c.gpuTrack('moon-4k', 40 * MB) === false && c.gpuUsedMB() === 80, 'a map that would pass the budget is refused and not counted');
  c.gpuFree('earth-night');
  check(c.gpuFits(40 * MB) && c.gpuUsedMB() === 40, 'freeing a map makes room');
  check(c.gpuTrack('earth-day', 10 * MB) && c.gpuUsedMB() === 10, 'tracking a key again replaces its size');
}

// ── The table ──
{
  const T = load({ mem: 8, cores: 10, gl: GL() }).cap.TABLE, keys = Object.keys(T.standard).sort().join();
  check(Object.keys(T.low).sort().join() === keys && Object.keys(T.high).sort().join() === keys, 'every level has every key');
  const mono = ['dprMax', 'standDprMax', 'skyQuality', 'shadowQuality', 'materialDetail', 'satMax', 'hdMemMB', 'textureMax', 'gpuMB'];
  check(mono.every((k) => T.low[k] <= T.standard[k] && T.standard[k] <= T.high[k]), 'no key asks for more at a lower level');
  check(T.low.hdTiles === false && T.standard.hdTiles === true, 'HD tiles are off at low');
  check(T.low.textureMax < 4096 + 1 && T.standard.textureMax >= 4096, 'the Moon\'s 4096 map is asked for from standard up');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
