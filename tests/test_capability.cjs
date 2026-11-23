// Capability levels (zimi/static/capability.js), executed from the shipped source with a stubbed browser:
// how a level is decided from the signals, what the person's word does, the governor's steps (down, and back up with hysteresis, the level
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
  const gl = sig.gl, stats = { made: 0, lost: 0 };
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
          stats.made++;
          return {
            MAX_TEXTURE_SIZE: 1, RENDERER: 2, VERTEX_SHADER: 3, FRAGMENT_SHADER: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8, RGBA: 9, UNSIGNED_BYTE: 10,
            getParameter: (p) => (p === 1 ? gl.maxTex : gl.renderer),
            getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 99 } : { loseContext() { stats.lost++; } }),
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
  return { cap: vm.runInContext('ZimiCap', ctx), store, session, stats };
}
const GL = (o) => Object.assign({ webgl2: true, maxTex: 16384, renderer: 'Apple M2', strict: false }, o || {});

// ── The probe lets go of every context it made, the second one (the performance-caveat check) too ──
{
  const l = load({ mem: 8, cores: 10, gl: GL() });
  l.cap.level();
  check(l.stats.made === 2 && l.stats.lost === l.stats.made, 'the probe loses both contexts it made (' + l.stats.lost + ' of ' + l.stats.made + ')');
}

// ── The level from the signals ──
check(load({ mem: 8, cores: 10, gl: GL() }).cap.level() === 'high', 'a big desktop with a real GPU is high');
check(load({ mem: 4, cores: 6, gl: GL({ renderer: 'Mali-G78', maxTex: 8192 }), coarse: true }).cap.level() === 'standard', 'a mid touch device is standard');
check(load({ mem: 8, cores: 10, gl: GL(), reduced: true }).cap.level() === 'high', 'reduced motion is about motion, not resolution: it holds nothing back');
check(load({ mem: 8, cores: 10, gl: GL(), saveData: true }).cap.level() === 'standard', 'Save-Data is never above standard');
check(load({ mem: 4, cores: 6, gl: GL({ maxTex: 8192 }) }).cap.level() === 'standard', 'a mid machine is standard');
check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'Google SwiftShader', strict: true }) }).cap.level() === 'low', 'SwiftShader is low whatever the CPU');
check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'llvmpipe (LLVM 15)' }) }).cap.level() === 'low', 'llvmpipe is low');
check(load({ mem: 8, cores: 8, gl: GL({ strict: true }) }).cap.level() === 'low', 'a browser that refuses a real-GPU context is drawing in software: low');
check(load({ mem: 2, cores: 8, gl: GL() }).cap.level() === 'low', 'two gigabytes is low');
check(load({ mem: 8, cores: 2, gl: GL() }).cap.level() === 'low', 'two cores is low');
check(load({ mem: 4, cores: 4, gl: GL({ maxTex: 8192 }) }).cap.level() === 'low', 'four gigabytes and four cores: low (a budget laptop)');
check(load({ mem: 0, cores: 6, gl: GL({ renderer: 'Apple GPU', maxTex: 16384 }), coarse: true }).cap.level() !== 'low', 'an iPhone (no memory figure, six cores) is never low');
check(load({ mem: 0, cores: 4, gl: GL({ maxTex: 16384 }) }).cap.level() !== 'low', 'no memory figure and four cores (Safari or Firefox on a 4-core desktop) is not low by the hints');
check(load({ mem: 8, cores: 4, gl: GL({ maxTex: 16384 }) }).cap.level() !== 'low', 'four cores with eight gigabytes is not low');
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
  check(load(sw, { zimi_cap: 'auto' }).cap.setting() === 'auto' && load(sw, { zimi_cap: 'auto' }).cap.level() === 'low', 'a test of the levels says Auto in so many words');
}

// ── One decision about what a low machine is (the page's gate to hold the 3D files back) ──
check(load({ mem: 1, cores: 4, gl: GL() }).cap.lowPower() === true, 'a one-gigabyte device is low power');
check(load({ mem: 8, cores: 8, gl: GL(), saveData: true }).cap.lowPower() === true, 'Save-Data holds the 3D files back though the level is standard');
check(load({ mem: 8, cores: 10, gl: GL() }).cap.lowPower() === false, 'a big machine is not');
{
  const r = load({ mem: 1, cores: 2, gl: GL() });
  r.cap.set('full');
  check(r.cap.lowPower() === false, 'Full overrides: the files come ahead of the tap');
  r.cap.set('light');
  check(load({ mem: 16, cores: 16, gl: GL() }, { zimi_cap: 'light' }).cap.lowPower() === true, 'Light is low power on any machine');
}

// ── The 3D view opens, or gives a plain line ──
check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'SwiftShader' }) }).cap.view3d() === 'open', 'Auto on software GL: the view opens (low, at a slower refresh), never turned away');
check(load({ mem: 8, cores: 8, gl: GL({ maxTex: 2048 }) }).cap.view3d() === 'open', 'a small maximum texture opens too');
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
  check(r.cap.view3d() === 'open' && r.cap.level() === 'low' && r.store.zimi_cap === 'auto', 'Auto asks the signals again');
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
  c.on((e, info) => events.push([e, info]));
  const dpr0 = c.dprCap('earth');
  check(dpr0 === 3 && c.dprCap('stand') === 3, 'high: the pixel ratios are the table\'s (Stand draws at the device\'s own ratio of a phone: a ratio of 2 left its sky and ground soft at 3)');
  let t = 1000;
  const frames = (scene, n, ms) => { for (let i = 0; i < n; i++) { t += ms; c.frame(scene, t); } };
  c.frame('earth', t);
  frames('earth', 30, 40);
  check(c.signals().step === 0 && c.dprCap('earth') === dpr0, 'a hitch of thirty slow frames costs nothing');
  frames('earth', 20, 16);
  frames('earth', 30, 40);
  check(c.signals().step === 0, 'slow frames among fast ones do not add up across a calm stretch');
  frames('earth', 60, 40);
  check(c.signals().step === 1 && Math.abs(c.dprCap('earth') - dpr0 * 0.8) < 1e-9, 'sustained slowness (a window of sixty) steps the pixel ratio down');
  check(events.some(([e]) => e === 'step'), 'a step is announced');
  t += 5000; c.frame('earth', t);   // an idle gap is not a slow frame
  frames('earth', 5, 16);
  check(c.signals().step === 1, 'an idle gap and fast frames cost nothing');
  frames('earth', 60, 40);
  check(c.signals().step === 2 && c.level() === 'standard', 'the second step drops the level a notch too (high to standard)');
  check(c.dprCap('earth') === Math.max(1, 3 * c.STEP[2]), 'the pixel ratio stays that of the level the device started on');
  frames('earth', 60, 40);
  check(c.signals().step === 3 && c.level() === 'low', 'at the last step the level is low');
  check(c.dprCap('stand') === Math.max(1, 3 * c.STEP[3]), 'Stand follows the same steps from its own start');
  check(c.dprCap('earth') >= 1, 'the pixel ratio never goes below the CSS pixel');
  // Past the last pixel step the view slows its refresh instead of going away: 20, 12, 8, 5 a second, everything kept.
  check(c.get('fpsMax') === 30, 'at the bottom of the pixels the low level draws 30 a second');
  [20, 12, 8, 5].forEach((fps, i) => {
    const gap = 1000 / fps * 2;   // twice the rung's own period: a frame that missed it
    frames('earth', 60, gap > 240 ? 240 : gap);
    check(c.signals().step === 4 + i && c.get('fpsMax') === fps, 'a slow window at the bottom draws ' + fps + ' a second');
  });
  frames('earth', 400, 240);
  check(!events.some(([e]) => e === 'fallback') && c.view3d() === 'open' && c.get('fpsMax') === 5, 'the slowest refresh stays open, however slow');
  frames('earth', 100, 200);
  check(c.signals().step === 7 && c.view3d() === 'open', 'frames at the rung\'s own period are not slow: no step past the floor');
  c.set('full');
  check(c.signals().step === 0 && c.view3d() === 'open' && c.level() === 'high', 'choosing Full starts over, and tries');
}
{
  // Every step comes back: one stutter must not leave the view degraded for the whole session.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap, events = [];
  c.on((e, info) => events.push([e, info]));
  let t = 1000;
  const frames = (scene, n, ms) => { for (let i = 0; i < n; i++) { t += ms; c.frame(scene, t); } };
  c.frame('earth', t);
  frames('earth', 60, 40);
  check(c.signals().step === 1, 'a bad stretch steps down');
  t += 60000; c.frame('earth', t);
  check(c.signals().step === 1, 'a minute left idle proves nothing: only painted frames count toward the step back');
  frames('earth', 300, 16);   // under five seconds of easy frames
  check(c.signals().step === 1, 'five easy seconds is not yet enough');
  frames('earth', 30, 22);    // neither slow nor easy at this level: they neither count nor undo
  check(c.signals().step === 1, 'frames with no room to spare do not count');
  frames('earth', 100, 16);
  check(c.signals().step === 0 && events.some(([e, i]) => e === 'step' && i.recovered), 'six easy seconds give the step back');
}
{
  // The tile holes' trigger: all the way down to low (no HD tiles), then the phone is fine again.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap;
  let t = 1000;
  const frames = (scene, n, ms) => { for (let i = 0; i < n; i++) { t += ms; c.frame(scene, t); } };
  c.frame('earth', t);
  frames('earth', 180, 40);
  check(c.signals().step === 3 && c.level() === 'low' && c.get('hdTiles') === false, 'three slow windows: low, no HD tiles');
  t += 30000; c.frame('earth', t);   // long after any bounce window
  frames('earth', 250, 33);          // low draws 30 a second: frames that keep that cadence are all it can show
  check(c.signals().step === 2 && c.level() === 'standard' && c.get('hdTiles') === true, 'frames on low\'s cadence give standard, and the HD tiles, back');
  frames('earth', 3000, 16);
  check(c.signals().step === 0 && c.level() === 'high' && c.dprCap('earth') === 3, 'and easy frames after that give back the level and the pixels it started with');
}
{
  // A device that cannot hold the step it got back is not offered it for ever.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap;
  let t = 1000, ups = 0;
  c.on((e, i) => { if (e === 'step' && i.recovered) ups++; });
  const frames = (scene, n, ms) => { for (let i = 0; i < n; i++) { t += ms; c.frame(scene, t); } };
  c.frame('earth', t);
  frames('earth', 60, 40);
  const cycle = () => { const before = ups; let n = 0; while (ups === before && n++ < 5000) frames('earth', 1, 16); const took = n * 16; if (ups > before) frames('earth', 110, 40); return took; };
  const first = cycle(), second = cycle();
  check(first < 9000 && second > first * 1.8, 'a step lost at once doubles the wait for the next (' + first + ' ms, then ' + second + ' ms)');
  check(c.signals().step === 1 && c.signals().ceiling === 1, 'after two bounces the governor settles on the step the device holds');
  frames('earth', 6000, 16);
  check(c.signals().step === 1 && ups === 2, 'and stops trying above it: no thrashing');
  c.set('full');
  check(c.signals().step === 0 && c.signals().ceiling === 0, 'the person choosing a level starts it over');
  const g = c.GOVERNOR;
  check(g.slowInWindow === 42 && g.windowFrames === 60 && g.recoverEasyMs === 6000 && g.easyShare === 0.75 && g.bounceMs === 20000 && g.maxBounces === 2 && g.levelDropStep === 2 && g.holdMs === 1500 && g.slowCeilMs === 250 && g.cadenceSlack === 1.15,
    'the governor\'s figures are told for the reference pages, as the checks above found them');
}
{
  // Frames while something loads are not the device's pace.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap;
  let t = 1000;
  c.frame('earth', t);
  for (let i = 0; i < 200; i++) { t += 40; if (i % 30 === 0) c.hold(1500, t); c.frame('earth', t); }
  check(c.signals().step === 0, 'slow frames inside the hold after each load never add up to a step');
}
{
  // The sky card and Look are a separate channel: they never step the 3D pixel ratio.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap;
  let t = 1000;
  c.frame('sky', t);
  for (let i = 0; i < 500; i++) { t += 90; c.frame('sky', t); c.frame('look', t); }
  check(c.signals().step === 0 && c.dprCap('earth') === 3, 'a slow sky card or Look leaves the 3D view\'s pixel ratio alone');
}
{
  // Full never gives way: the person asked for it.
  const r = load({ mem: 8, cores: 10, gl: GL() }), c = r.cap, events = [];
  c.set('full');
  c.on((e) => events.push(e));
  let t = 1000;
  c.frame('earth', t);
  for (let i = 0; i < 800; i++) { t += 60; c.frame('earth', t); }
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
{
  // A frame at 40 a second on a standard phone is on time: no capable phone is made softer for it.
  const r = load({ mem: 4, cores: 6, gl: GL({ renderer: 'Mali-G78' }), coarse: true }), c = r.cap;
  let t = 1000;
  c.frame('earth', t);
  for (let i = 0; i < 400; i++) { t += 25; c.frame('earth', t); }
  check(c.signals().step === 0 && c.dprCap('earth') === 2, 'standard: 25 ms frames (40 a second) cost nothing');
}

// ── The phones ──
{
  // A current iPhone: Safari gives no memory figure, six cores, "Apple GPU", 16384, a touch screen.
  const iphone = { mem: 0, cores: 6, gl: GL({ renderer: 'Apple GPU', maxTex: 16384 }), coarse: true, benchMs: 0.6 };
  const c = load(iphone).cap;
  check(c.level() === 'high' && c.dprCap('earth') === 3 && c.dprCap('stand') === 3, 'an iPhone 15 class device is high, at the full device ratio');
  check(c.view3d() === 'open' && c.get('hdTiles') === true && c.get('fpsMax') === 0, 'and draws everything at the display\'s rate');
  check(load(Object.assign({}, iphone, { reduced: true })).cap.level() === 'high', 'reduced motion does not hold it back');
  check(load(Object.assign({}, iphone, { saveData: true })).cap.level() === 'standard', 'Save-Data does');
  check(load(Object.assign({}, iphone, { cores: 4 })).cap.level() === 'standard', 'an older four-core iPhone is standard');
  check(load(Object.assign({}, iphone, { benchMs: 12 })).cap.level() === 'low', 'one whose micro-benchmark is slow is low');
  // A mid-range Android: Chrome reports 4 GB, eight cores, a Mali/Adreno GPU.
  const mid = load({ mem: 4, cores: 8, gl: GL({ renderer: 'Mali-G78 MP14', maxTex: 8192 }), coarse: true }).cap;
  check(mid.level() === 'standard' && mid.dprCap('earth') === 2, 'a mid-range Android is standard, at 1.15.4\'s ratio of 2');
  // An Android flagship.
  check(load({ mem: 8, cores: 8, gl: GL({ renderer: 'Adreno (TM) 740', maxTex: 16384 }), coarse: true }).cap.level() === 'high', 'an Android flagship is high');
  // A 2 GB Android.
  const low = load({ mem: 2, cores: 8, gl: GL({ renderer: 'Mali-G52', maxTex: 8192 }), coarse: true }).cap;
  check(low.level() === 'low' && low.dprCap('earth') === 1 && low.get('fpsMax') === 30 && low.view3d() === 'open', 'a 2 GB Android is low: the lighter 3D view, not the plain line');
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

// Stand's sky is not drawn small and stretched where the device is roomy: a sky at 0.75 of a pixel ratio of 2 was 1.5 px per CSS px on a phone of 3.
{
  const m = /var AE_STAND_SKY_BY_LEVEL = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-stand.js'), 'utf8'));
  const by = m && m[1].split(',').map(Number);
  check(by && by.length === 3 && by[2] === 1 && by[0] <= by[1] && by[1] <= by[2], 'the high level draws the Stand sky at full size, and no level asks for more than the one above it');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
