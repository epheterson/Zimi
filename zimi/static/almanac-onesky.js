// ── Almanac: one sky ──
// The live sky card, Look and Stand here are three windows on one thing: a body, a place, a height, an instant and a way of
// facing. This file is what they share, small enough to load with the sky:
//   the definition    { body, lat, lon, heightM, tMs, heading, pitch, fov }   (degrees; heading from north clockwise; tMs in ms)
//   the photometry    _osSkyState(def): the Sun's and the Moon's places and light, how bright the sky is and so the exposure and
//                     the faintest star (almanac-skygl.js's own functions, called once, here)
//   the sky's objects _osSkySource(src): satellites, trains, rockets, plumes register once and every window draws them
// almanac-oneair.js puts the card's atmosphere into Stand here's Earth; almanac-sky.js paints the objects on the card.

var OS_BODY_EARTH = 'earth';
var OS_DEFAULT_FOV_DEG = 70;
var OS_ASK_EVERY_MS = 1000;     // a source with an `ask` is asked about this often (never overlapping itself)
var OS_ASK_JUMP_MS = 4000;      // ... and at once when the displayed instant moved this far from the one it was asked about
var OS_STATE_CACHE_MS = 1000;   // the photometry is worked out again when the instant has moved this much (or the place has)

// The one definition: whatever a caller leaves out takes the plainest value (Earth, the ground, now, facing north and level).
function _osDef(o) {
  o = o || {};
  var n = function (v, d) { return isFinite(v) && v !== null ? Number(v) : d; };
  return { body: o.body || OS_BODY_EARTH, lat: n(o.lat, 0), lon: n(o.lon, 0), heightM: n(o.heightM, 0), tMs: n(o.tMs, Date.now()),
    heading: ((n(o.heading, 0) % 360) + 360) % 360, pitch: Math.max(-90, Math.min(90, n(o.pitch, 0))), fov: n(o.fov, OS_DEFAULT_FOV_DEG) };
}

// ── The photometry ──
// The light of the Earth's sky at a place and an instant: the sky scene's own ephemeris, brightness and light numbers
// (almanac-sky.js _skyFrame, _skyBrightness, _skyLightParams) and the shaders' values for them (almanac-skygl.js
// _sgLightValues). {eph, moonData, now, p: light parameters, lv: lux/exposure/glow, lm: faintest star, lum}.
var _osStateCache = null;
function _osSkyState(def) {
  var c = _osStateCache;
  if (c && c.lat === def.lat && c.lon === def.lon && Math.abs(c.t - def.tMs) < OS_STATE_CACHE_MS && c.dial === _skySetting('dial')) return c.state;
  var now = new Date(def.tMs), f = _skyFrame(now, def.lat, def.lon);
  var s = { eph: f.eph, moonData: f.moonData, now: now, lat: def.lat, lon: def.lon };
  _skyBrightness(s);
  var p = _skyLightParams(s);
  var state = { eph: s.eph, moonData: s.moonData, now: now, p: p, lv: _sgLightValues(p), lm: s.lm, lum: s.lum };
  _osStateCache = { lat: def.lat, lon: def.lon, t: def.tMs, dial: p.dial, state: state };
  return state;
}

// ── The day's clouds ──
// Not weather (Zimi has none): a field of the place and the day, the same for everyone there, thin on some days and heavy on others
// (the cover is evenly spread over 0..1), blown by a wind of the day. The GLSL that draws it is almanac-skygl.js SG_GLSL_CLOUDS.
var OS_CLOUD_BASE_M = 2500, OS_CLOUD_THICK_M = 700;
var OS_CLOUD_WIND_MS = [4, 16];          // the day's wind speed, m/s
var OS_CLOUD_SEED_PLACE = 10;            // the place enters the seed to this many parts of a degree
var OS_CLOUD_NOISE_SPAN = 1000;          // the day's offset in the noise's own units
var OS_DAY_MS = 86400000, OS_DAY_S = 86400;
var OS_SEED_MULT = [73856093, 19349663, 83492791];
function _osMulberry(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The place's solar day (a new one starts at the place's own midnight, to the hour) and the seed it and the place make.
function _osSolarDay(tMs, lon) { return tMs / OS_DAY_MS + lon / 360; }
function _osCloudSeed(tMs, lat, lon) {
  return (Math.imul(Math.floor(_osSolarDay(tMs, lon)), OS_SEED_MULT[0]) ^ Math.imul(Math.round(lat * OS_CLOUD_SEED_PLACE), OS_SEED_MULT[1]) ^ Math.imul(Math.round(lon * OS_CLOUD_SEED_PLACE), OS_SEED_MULT[2])) >>> 0;
}
function _osCloudField(def) {
  var seed = _osCloudSeed(def.tMs, def.lat, def.lon), r = _osMulberry(seed);
  var coverage = r(), dir = r() * 2 * Math.PI, speed = OS_CLOUD_WIND_MS[0] + (OS_CLOUD_WIND_MS[1] - OS_CLOUD_WIND_MS[0]) * r();
  return { coverage: coverage, wind: [Math.sin(dir) * speed, Math.cos(dir) * speed], base: OS_CLOUD_BASE_M, thickness: OS_CLOUD_THICK_M, seed: seed % OS_CLOUD_NOISE_SPAN };
}
// The field as the shaders take it (almanac-skygl.js SG_GLSL_CLOUDS' uniforms); sunShare is the Sun's light that reaches the place (an eclipse).
function _osCloudValues(def, sunShare) {
  var f = _osCloudField(def), day = _osSolarDay(def.tMs, def.lon);
  return { cloud: [f.coverage, f.base, f.thickness, f.seed], wind: [f.wind[0], f.wind[1], (day - Math.floor(day)) * OS_DAY_S], sunE: SG_SUN_LUX * (sunShare == null ? 1 : sunShare) };
}

// ── The sky's objects ──
// One registry for what things put in the sky (satellites, trains, rockets, plumes): the card paints them, Stand here draws them.
// A source is either
//     { ask(lat, lon, tMs) -> Promise | answer,   about once a second, never overlapping itself, off the main thread if it likes
//       at(answer, tMs) -> [object] }             at every picture: move things by their rates, drop what has set (cheap, no I/O)
// or, for what is cheap to work out anywhere, a plain function  fn(body, lat, lon, tMs) -> [object]  at every picture.
// An object is
//     { az, el,           degrees: azimuth from north clockwise, elevation over the horizon
//       mag,              apparent magnitude (smaller is brighter; a plume may be -6 or less)
//       kind,             'sat' | 'train' | 'rocket' | 'plume' | 'gps': a point, a point with its trail, a large soft glow, a ring
//       rgb,              optional [r, g, b] 0..1 (white by default)
//       trail,            optional path behind it, [{az, el, mag?}, ...] (or [[az, el], ...]); a point's own mag dims the tail there
//       name }            optional: what a tap on it says
// Only the Earth has any: another body's sky asks for none.
var _osSources = [];
var _osPlace = null;   // the last place objects were asked for: { lat, lon }
function _osSkySource(src) {
  var entry = typeof src === 'function' ? { fn: src } : { ask: src.ask, at: src.at, answer: null, pending: false, askedAt: 0, askedMs: 0, askedPlace: '' };
  _osSources.push(entry);
  _osChanged();
  return function () {
    var k = _osSources.indexOf(entry);
    if (k >= 0) _osSources.splice(k, 1);
    _osChanged();
  };
}
var _osListeners = [];
// Whoever draws the sky asks to be told when the set of sources, or an answer, changes (a window repaints).
function _osOnChange(fn) { _osListeners.push(fn); return function () { var k = _osListeners.indexOf(fn); if (k >= 0) _osListeners.splice(k, 1); }; }
function _osChanged() { _osListeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* a window that is gone */ } }); }
function _osAskAll(lat, lon, tMs) {
  var now = performance.now(), place = lat.toFixed(4) + ',' + lon.toFixed(4);
  _osSources.forEach(function (e) {
    if (!e.ask || e.pending) return;
    var stale = now - e.askedAt >= OS_ASK_EVERY_MS || Math.abs(tMs - e.askedMs) > OS_ASK_JUMP_MS || e.askedPlace !== place;
    if (!stale) return;
    e.pending = true; e.askedAt = now; e.askedMs = tMs; e.askedPlace = place;
    var done = function (a) { e.answer = a; e.pending = false; _osChanged(); };
    try { Promise.resolve(e.ask(lat, lon, tMs)).then(done, function () { e.pending = false; }); } catch (x) { e.pending = false; }
  });
}
// The objects for a body, a place and an instant: asks what needs asking, moves what has been answered. [] when there are none.
function _osObjects(body, lat, lon, tMs) {
  if (body !== OS_BODY_EARTH || !_osSources.length) return [];
  _osPlace = { lat: lat, lon: lon };
  _osAskAll(lat, lon, tMs);
  var list = [];
  _osSources.forEach(function (e) {
    try {
      var r = e.fn ? e.fn(body, lat, lon, tMs) : (e.at && e.answer ? e.at(e.answer, tMs) : null);
      if (r && r.length) for (var i = 0; i < r.length; i++) list.push(r[i]);
    } catch (x) { /* a source that fails draws nothing */ }
  });
  return list;
}
function _osHasSources() { return _osSources.length > 0; }

// ── The card to Stand here, and back ──
// The card's place, instant and facing, as the hand-off Stand here takes (almanac-stand.js _aeStandOpen).
function _osHandoffFrom(def, back) {
  return { body: def.body, lat: def.lat, lon: def.lon, ms: def.tMs, heading: def.heading, pitch: def.pitch, back: back };
}

// The card's definition: the Almanac's place, the instant it shows (the time machine's, or now) and the way the panorama faces.
var OS_CARD_PITCH_DEG = 8;   // the card's horizon sits low in the picture: Stand here looks a little over it
function _osCardDef() {
  var s = typeof _skyState !== 'undefined' ? _skyState : null;
  if (!s || !isFinite(s.lat) || !isFinite(s.lon)) return null;
  return _osDef({ lat: s.lat, lon: s.lon, tMs: _skyLive() ? Date.now() : s.nowTime, heading: s.center, pitch: OS_CARD_PITCH_DEG });
}
// "Stand here" on the card: the 3D view's ground at the Almanac's place, at the same instant, facing the same way; its Back returns the
// page as it was (the scroll, the card painting again).
function _osStandHere() {
  var def = _osCardDef();
  if (!def || typeof _aeStandOpen !== 'function' && typeof _almLoadEarth !== 'function') return Promise.resolve(false);
  var y = window.pageYOffset || 0;
  var back = function () { window.scrollTo(0, y); if (typeof _skyResume === 'function' && typeof _skyState !== 'undefined' && _skyState) _skyResume(); };
  var ready = typeof _aeStandOpen === 'function' ? Promise.resolve() : _almLoadEarth().then(function () { return _aeStandReady(); });
  return ready.then(function () { return _aeStandOpen(_osHandoffFrom(def, back)); }).catch(function () { return false; });
}

// ── The objects on the card ──
// What _osObjects holds for the place, drawn on the sky's canvas (the panorama or a lens): a point's glow by its magnitude, its trail
// fading by the magnitude of each step, a rocket's plume as a soft glow, the GPS satellites as rings. Hidden when the sky is brighter
// than the object, as the stars are; named beside the first of each name, and each one a tap target (s.bodies).
var OS_POINT_R_PX = [1.4, 3.4], OS_POINT_ALPHA = [0.6, 1], OS_POINT_MAG_SPAN = 6;   // a point's radius (CSS px) and opacity, faint to bright
var OS_PLUME_R_PX = 9, OS_PLUME_ALPHA = 0.35, OS_TRAIL_ALPHA = 0.7, OS_TRAIL_PX = 1.4;
var OS_LABEL_PX = 11, OS_LABEL_GAP_PX = 6, OS_RING_PX = 4, OS_GPS_RGB = [140, 215, 255];
var OS_DEFAULT_RGB = [255, 250, 235];
function _osRgb255(o) { return o.rgb ? o.rgb.map(function (c) { return Math.round(c * 255); }) : OS_DEFAULT_RGB; }
function _osPaintObjects(ctx, s) {
  if (!_osHasSources() || !s.eph) return;
  var ms = _skyLive() ? Date.now() : s.nowTime, list = _osObjects(OS_BODY_EARTH, s.lat, s.lon, ms), dpr = s.dpr, drawn = false, named = {};
  list.forEach(function (o) {
    var mag = o.mag === undefined ? 3 : o.mag;
    if (o.kind !== 'gps' && o.kind !== 'plume' && s.lm - mag <= 0) return;
    var p = _skyScreen(s, o.az, o.el, 4);
    if (!p.visible) return;
    var rgb = _osRgb255(o), near = _skyClamp(1 - mag / OS_POINT_MAG_SPAN, 0.25, 1), x = p.x, y = p.y;
    if (o.kind === 'gps') {
      ctx.strokeStyle = _skyRgb(OS_GPS_RGB, 0.85); ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath(); ctx.arc(x, y, OS_RING_PX * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = _skyRgb(OS_GPS_RGB, 0.9); ctx.font = (10 * dpr) + 'px sans-serif';
      ctx.fillText(String(o.name || '').replace(/^GPS\s*/, ''), x + 7 * dpr, y + 3 * dpr);
      drawn = true;
      return;
    }
    if (o.trail && o.trail.length) {
      var px = x, py = y;
      ctx.lineCap = 'round';
      for (var k = 0; k < o.trail.length; k++) {
        var q = o.trail[k], qaz = q.az !== undefined ? q.az : q[0], qel = q.el !== undefined ? q.el : q[1], qm = q.mag !== undefined ? q.mag : mag;
        var qp = _skyScreen(s, qaz, qel, 0);
        if (Math.abs(qp.x - px) > s.W / 2) break;   // across the panorama's seam
        ctx.strokeStyle = _skyRgb(rgb, OS_TRAIL_ALPHA * near * Math.pow(10, -0.4 * Math.max(0, qm - mag)));
        ctx.lineWidth = dpr * OS_TRAIL_PX * (1 - 0.6 * k / o.trail.length);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qp.x, qp.y); ctx.stroke();
        px = qp.x; py = qp.y;
      }
    }
    if (o.kind === 'plume') _skyLight(ctx, x, y, OS_PLUME_R_PX * dpr, rgb, OS_PLUME_ALPHA);
    else _skyLight(ctx, x, y, _skyLerp(OS_POINT_R_PX[0], OS_POINT_R_PX[1], near) * dpr, rgb, _skyLerp(OS_POINT_ALPHA[0], OS_POINT_ALPHA[1], near));
    if (o.name && !named[o.name]) {
      named[o.name] = true;
      ctx.fillStyle = 'rgba(255,250,235,.8)'; ctx.font = (OS_LABEL_PX * dpr) + 'px sans-serif';
      ctx.fillText(o.name, x + OS_LABEL_GAP_PX * dpr, y - OS_LABEL_GAP_PX * dpr);
    }
    if (s.bodies && o.kind !== 'plume') s.bodies.push({ type: o.kind === 'rocket' ? 'rocket' : 'sat', name: o.name || '', x: x / dpr, y: y / dpr, r: 5, alt: o.el, az: o.az, km: o.km || 0 });
    drawn = true;
  });
  if (drawn) s.issUp = true;   // the sky repaints twice a second while one is up (its ISS timer)
}
// An answer that came in, or a source that came or went, is a reason for the card to paint again.
_osOnChange(function () { if (typeof _skyKick === 'function' && typeof _skyState !== 'undefined' && _skyState) _skyKick(); });
