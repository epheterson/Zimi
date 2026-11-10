// Capability levels: what this device can carry, decided once, and adapted from the frames it really draws.
//
// ZimiCap decides a level (low / standard / high) per session from cheap signals, lets the person override it in the 3D view's
// gear (Auto / Light / Full, remembered), and holds the one governor every 3D scene feeds its frame times to: a run of slow
// frames steps the pixel ratio and the features down, for good (never back up within a session), and at the bottom of the
// ladder asks the 3D view to give way to its plain line instead of holding the tab hostage.
//
// What each level means is TABLE below, one row per level; lanes read it with ZimiCap.get(key) and never test a device
// themselves. The Almanac reference (almanac-reference.js, "Capability levels") prints the same table.
//
// Loaded with the Almanac's modules and, before them, by app.js when the Moon's 4096 map is about to be asked for.

var ZimiCap = window.ZimiCap || (function () {
  'use strict';
  var SETTING_KEY = 'zimi_cap';            // 'auto' | 'light' | 'full', kept on this device
  var LEVEL_KEY = 'zimi_cap_level';        // the level an Auto decided, kept for the session (a reload does not ask the GPU again)
  var SETTINGS = ['auto', 'light', 'full'];
  var LEVELS = ['low', 'standard', 'high'];

  // One row per level. Numbers are ceilings; 'quality' keys are 0 (least) to 2 (most).
  //   dprMax / standDprMax   the pixel ratio the 3D view / Stand here may draw at (before the governor's steps)
  //   skyQuality, shadowQuality, materialDetail   0 off or cheapest .. 2 full (Stand's sky march and half-res sky, terrain
  //                          shadows, procedural ground detail); 0 draws the sky at AE_STAND_SKY_SCALE 1/3, no shadows
  //   satMax                 satellites drawn at most (low keeps the brightest: GPS, ISS, then by size)
  //   hdTiles / hdMemMB      Almanac HD tiles on or off, and the GPU memory they may hold
  //   textureMax             the biggest map a scene asks for (the Moon's 4096 map needs 4096)
  //   mapLabels              the map overlay's names: 'none', 'major' (cities) or 'all'
  //   gpuMB                  the budget for everything the view holds on the GPU; a scene that would pass it drops its sharpest map
  //   fpsMax                 the most frames a second a scene draws (0: the display's rate)
  //   slowMs                 a painted frame this slow counts toward a step down
  var TABLE = {
    low:      { dprMax: 1,   standDprMax: 1,   skyQuality: 0, shadowQuality: 0, materialDetail: 0, satMax: 200,   hdTiles: false, hdMemMB: 0,   textureMax: 2048, mapLabels: 'none',  gpuMB: 96,  fpsMax: 30, slowMs: 50 },
    standard: { dprMax: 2,   standDprMax: 1.5, skyQuality: 1, shadowQuality: 1, materialDetail: 1, satMax: 3000,  hdTiles: true,  hdMemMB: 96,  textureMax: 4096, mapLabels: 'major', gpuMB: 256, fpsMax: 0,  slowMs: 20 },
    high:     { dprMax: 3,   standDprMax: 2,   skyQuality: 2, shadowQuality: 2, materialDetail: 2, satMax: 30000, hdTiles: true,  hdMemMB: 384, textureMax: 8192, mapLabels: 'all',   gpuMB: 768, fpsMax: 0,  slowMs: 18 }
  };
  var STEP = [1, 0.8, 0.64, 0.5];          // the governor's pixel-ratio factor at each step down
  var SLOW_RUN = 3;                         // slow frames in a row that cost a step (an idle gap is not a slow frame)
  var SLOW_CEIL_MS = 250;
  var FALLBACK_SLOW = 45;                   // slow frames at the last step before the 3D view gives way
  var LEVEL_DROP_STEP = 2;                  // from this step down the level itself drops one (features, not only pixels)
  var LOSS_WINDOW_MS = 60000, LOSS_LIMIT = 3;   // context losses in a minute before the view gives way

  var SOFT_GL_RE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|microsoft basic/i;
  var OLD_GPU_RE = /mali-4|mali-t|adreno \(tm\) ?[23]\d\d|powervr|sgx|videocore|v3d|vivante|tegra [234]/i;
  var BENCH_SIZE = 256, BENCH_DRAWS = 8, BENCH_FAST_MS = 1.5, BENCH_SLOW_MS = 9;
  var MIN_DEVICE_MEM_FOR_HIGH = 8, MIN_CORES_FOR_HIGH = 8, MIN_TEX_FOR_HIGH = 16384, MIN_TEX_FOR_STANDARD = 4096;

  var listeners = [], sig = null, levelNow = null, step = 0, frames = {}, slowTotal = 0, losses = [], started = false, fellBack = false;

  function store(kind, k, v) {
    try {
      var s = kind === 'session' ? sessionStorage : localStorage;
      if (v === undefined) return s.getItem(k);
      if (v === null) s.removeItem(k); else s.setItem(k, v);
    } catch (e) {}
    return null;
  }
  // The person's word, else Auto; an automated browser (a test) with no word gets Full: it is not somebody's device, and
  // a suite that opens the 3D view must not be met by the plain line. A test of the levels says Auto in so many words.
  function setting() {
    var s = store('local', SETTING_KEY);
    if (SETTINGS.indexOf(s) >= 0) return s;
    return navigator.webdriver ? 'full' : 'auto';
  }
  function emit(evt, info) { listeners.slice().forEach(function (fn) { try { fn(evt, info); } catch (e) {} }); }

  // What the device says about itself, read once. The throwaway WebGL context is lost again at once.
  function probe() {
    if (sig) return sig;
    var nav = navigator, s = {
      mem: nav.deviceMemory || 0, cores: nav.hardwareConcurrency || 0, webgl2: false, maxTex: 0, renderer: '', soft: false, benchMs: 0,
      coarse: false, reduced: false, saveData: false
    };
    try { s.coarse = matchMedia('(pointer: coarse)').matches; s.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    try { s.saveData = !!(nav.connection && nav.connection.saveData); } catch (e) {}
    try {
      var c = document.createElement('canvas');
      c.width = c.height = BENCH_SIZE;
      var gl = c.getContext('webgl2', { powerPreference: 'high-performance' });
      s.webgl2 = !!gl;
      if (!gl) gl = c.getContext('webgl');
      if (gl) {
        s.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        s.renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        s.soft = SOFT_GL_RE.test(s.renderer);
        if (!s.soft) {
          // A browser that will not give a real GPU its context under this flag is drawing in software.
          var c2 = document.createElement('canvas');
          s.soft = !c2.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) && s.webgl2;
        }
        if (s.webgl2 && ambiguous(s)) s.benchMs = bench(gl);
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) {}
    sig = s;
    return s;
  }
  // Signals that do not settle it: no memory figure (Safari, Firefox) and a core count in the middle.
  function ambiguous(s) {
    return !s.mem && !s.soft && !OLD_GPU_RE.test(s.renderer) && s.cores >= 4 && s.cores <= 12;
  }
  // About 100 ms: a loop-heavy fragment shader over a small target, timed with a read-back so the GPU's work is in it.
  function bench(gl) {
    try {
      var vs = '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
      var fs = '#version 300 es\nprecision highp float;uniform float t;out vec4 o;void main(){float a=gl_FragCoord.x*.01+t;for(int i=0;i<96;i++){a=sin(a)*1.7+cos(a*1.3);}o=vec4(a);}';
      var mk = function (type, src) { var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
      var pr = gl.createProgram();
      gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(pr); gl.useProgram(pr);
      var buf = gl.createBuffer(), loc = gl.getAttribLocation(pr, 'p'), px = new Uint8Array(4), ts = [];
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, BENCH_SIZE, BENCH_SIZE);
      for (var i = 0; i < BENCH_DRAWS; i++) {
        var t0 = performance.now();
        gl.uniform1f(gl.getUniformLocation(pr, 't'), i);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (i) ts.push(performance.now() - t0);   // the first draw carries the compile
      }
      ts.sort(function (a, b) { return a - b; });
      return ts[ts.length >> 1];
    } catch (e) { return 0; }
  }

  function decide() {
    var s = probe();
    if (!s.webgl2 || s.soft || s.maxTex < MIN_TEX_FOR_STANDARD || (s.mem && s.mem <= 2) || (s.cores && s.cores <= 2) || OLD_GPU_RE.test(s.renderer)) return 'low';
    if (s.benchMs && s.benchMs > BENCH_SLOW_MS) return 'low';
    var level = 'standard';
    var roomy = (s.mem >= MIN_DEVICE_MEM_FOR_HIGH || (!s.mem && s.benchMs && s.benchMs < BENCH_FAST_MS)) && s.cores >= MIN_CORES_FOR_HIGH && s.maxTex >= MIN_TEX_FOR_HIGH;
    if (roomy && !s.coarse && !s.reduced && !s.saveData) level = 'high';
    return level;
  }
  function level() {
    if (levelNow) return levelNow;
    var s = setting(), base;
    if (s === 'light') base = 'low';
    else if (s === 'full') base = 'high';
    else base = store('session', LEVEL_KEY) || decide();
    if (LEVELS.indexOf(base) < 0) base = 'standard';
    if (s === 'auto') store('session', LEVEL_KEY, base);
    levelNow = base;
    return levelNow;
  }
  function row() { return TABLE[level()]; }

  // Whether the 3D view opens: a plain line instead, never a tab crash, where Auto found no WebGL2 or a software renderer.
  // Light and Full are the person's word: they try it (still under the governor, which can give way at Light).
  function view3d() {
    var s = probe(), st = setting();
    if (!s.webgl2) return 'static';
    if (st === 'auto' && level() === 'low' && (s.soft || s.maxTex < MIN_TEX_FOR_STANDARD)) return 'static';
    if (fellBack && st !== 'full') return 'static';
    return 'open';
  }

  // ── The governor ──
  // Every 3D scene calls frame(scene, now) once per painted frame. Slow frames (not idle gaps) three in a row step the
  // pixel ratio down; the third step also drops the level a notch (fewer satellites, no HD tiles, ...); at the last step a
  // run of slow frames sets the 3D view aside. Nothing goes back up before the page is reloaded.
  function frame(scene, now) {
    started = true;
    var f = frames[scene] || (frames[scene] = { last: 0, run: 0 });
    var dt = f.last ? now - f.last : 0;
    f.last = now;
    var slow = dt > row().slowMs && dt < SLOW_CEIL_MS;
    f.run = slow ? f.run + 1 : 0;
    if (!slow) return false;
    slowTotal++;
    if (f.run < SLOW_RUN) return false;
    f.run = 0;
    return slower('slow frames in ' + scene);
  }
  // Scenes call this when they start over (a new scene's first frame is not a gap to measure).
  function resetFrames(scene) { if (frames[scene]) frames[scene].last = 0; }
  function slower(why) {
    if (step < STEP.length - 1) {
      step++;
      if (step >= LEVEL_DROP_STEP && LEVELS.indexOf(levelNow) > 0) levelNow = LEVELS[LEVELS.indexOf(levelNow) - 1];
      emit('step', { step: step, level: levelNow, why: why });
      return true;
    }
    if (setting() !== 'full' && slowTotal >= FALLBACK_SLOW && !fellBack) {
      fellBack = true;
      emit('fallback', { why: why });
    }
    return false;
  }
  function dprCap(scene) {
    var r = row();
    var base = scene === 'stand' ? r.standDprMax : r.dprMax;
    return base * STEP[step];
  }

  // ── A GL context taken away ──
  // watchContext(canvas, onLost, onRestored): the default (no restore) is prevented so the browser may give it back; a
  // scene that cannot use a restored context builds a fresh one in onLost. Three losses in a minute set the view aside.
  function watchContext(canvas, onLost, onRestored) {
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      var now = Date.now();
      losses = losses.filter(function (t) { return now - t < LOSS_WINDOW_MS; });
      losses.push(now);
      var give = losses.length >= LOSS_LIMIT;
      if (give) { fellBack = true; emit('fallback', { why: 'context lost' }); }
      if (onLost) onLost(give);
    });
    if (onRestored) canvas.addEventListener('webglcontextrestored', function () { onRestored(); });
  }

  // ── The gear ──
  var ICONS = {
    auto: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3"/>',
    light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.1 1 1.9V16h5v-.2c0-.8.4-1.4 1-1.9A6 6 0 0 0 12 3z"/>',
    full: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'
  };
  var ONLINE_ICONS = {
    ask: '<circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.7"/><path d="M12 17v.1"/>',
    auto: '<path d="M20 11a8 8 0 0 0-14-4.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4.5l2-2.5"/><path d="M20 20v-5h-5"/>',
    never: '<circle cx="12" cy="12" r="9.5"/><path d="M5.3 18.7l13.4-13.4"/>'
  };
  var ONLINE_ROWS = ['satellites', 'almanac_hd', 'streetzim'];   // outbound.py ids that make the Almanac better with a network
  var OUTBOUND_URL = '/manage/outbound';
  var inventory = null;
  function T(key) { return typeof _aeT === 'function' ? _aeT(key) : (typeof t === 'function' ? t(key) : key); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function svg(path) { return '<svg class="ae-set-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>'; }
  function gearHtml() {
    var cur = setting();
    var html = '<div class="ae-set-sep" aria-hidden="true"></div><h3 id="cap-title">' + esc(T('cap_title')) + '</h3><div role="radiogroup" aria-labelledby="cap-title">';
    SETTINGS.forEach(function (k) {
      html += '<label class="ae-set-choice" title="' + esc(T('cap_hint_' + k)) + '"><input type="radio" name="cap-setting" value="' + k + '"' + (cur === k ? ' checked' : '') + '>' +
        svg(ICONS[k]) + '<b>' + esc(T('cap_' + k)) + '</b></label>';
    });
    html += '</div><p class="ae-set-why" id="cap-now">' + esc(T('cap_level_' + level())) + '</p><div id="cap-online"></div>';
    return html;
  }
  function onlineHtml(rows) {
    var out = '';
    ONLINE_ROWS.forEach(function (id) {
      var r = rows.filter(function (x) { return x.id === id; })[0];
      if (!r) return;
      var mode = r.state === 'auto' || r.state === 'lan' ? 'auto' : r.state === 'ask' ? 'ask' : 'never';
      out += '<div class="ae-set-choice ae-off" title="' + esc((r.hosts || []).join(', ')) + '">' + svg(ONLINE_ICONS[mode]) + '<b>' + esc(T('cap_o_' + id)) + '</b></div>';
    });
    return out ? '<div class="ae-set-sep" aria-hidden="true"></div><h3>' + esc(T('cap_online')) + '</h3>' + out : '';
  }
  // Wire the radios and fill in "Better online" from the server's own inventory (admin only: others see no list).
  function gearBind(root) {
    var radios = root.querySelectorAll('input[name="cap-setting"]');
    Array.prototype.forEach.call(radios, function (r) { r.onchange = function () { choose(r.value); }; });
    var slot = root.querySelector('#cap-online');
    if (!slot) return;
    var paint = function (rows) { if (rows && slot.isConnected) slot.innerHTML = onlineHtml(rows); };
    if (inventory) { paint(inventory); return; }
    (window.manageFetch ? window.manageFetch(OUTBOUND_URL) : fetch(OUTBOUND_URL, { credentials: 'same-origin' })).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      inventory = d && d.rows;
      paint(inventory);
    }).catch(function () {});
  }
  function choose(v) {
    if (SETTINGS.indexOf(v) < 0) return;
    store('local', SETTING_KEY, v);
    levelNow = null; step = 0; slowTotal = 0; fellBack = false; frames = {};
    store('session', LEVEL_KEY, null);
    emit('setting', { setting: v, level: level() });
  }

  return {
    TABLE: TABLE, STEP: STEP,
    level: level,
    setting: setting,
    set: choose,
    get: function (key) { return row()[key]; },
    row: row,
    dprCap: dprCap,
    view3d: view3d,
    frame: frame,
    resetFrames: resetFrames,
    watchContext: watchContext,
    on: function (fn) { listeners.push(fn); },
    gearHtml: gearHtml,
    gearBind: gearBind,
    // Whether a map of this size may be asked for at this level (and the device's own limit).
    textureOk: function (px) { return px <= row().textureMax && (!sig || !sig.maxTex || px <= sig.maxTex); },
    // The signals behind the level, for the reference and for tests.
    signals: function () { var s = probe(); return { level: level(), setting: setting(), step: step, fellBack: fellBack, mem: s.mem, cores: s.cores, webgl2: s.webgl2, maxTex: s.maxTex, renderer: s.renderer, soft: s.soft, benchMs: s.benchMs, coarse: s.coarse }; }
  };
})();
