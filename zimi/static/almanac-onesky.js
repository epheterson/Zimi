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
