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

// The way a view faces when nothing has said: toward the Sun's side of the sky, south in the northern hemisphere and north in the southern.
// The card, Look and Stand here all start here (almanac-stand.js takes it when it is opened with no heading).
function _osDefaultHeading(lat) { return lat >= 0 ? 180 : 0; }

// The one definition: whatever a caller leaves out takes the plainest value (Earth, the ground, now, facing north and level).
function _osDef(o) {
  o = o || {};
  var n = function (v, d) { return isFinite(v) && v !== null ? Number(v) : d; };
  return { body: o.body || OS_BODY_EARTH, lat: n(o.lat, 0), lon: n(o.lon, 0), heightM: n(o.heightM, 0), tMs: n(o.tMs != null ? o.tMs : o.ms, Date.now()),
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
  var state = { eph: s.eph, moonData: s.moonData, now: now, p: p, lv: _sgLightValues(p), lm: s.lm, lum: s.lum, obsc: s.obsc, sunShare: s.sunShare, moonShare: s.moonShare };
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
  def = _osDef(def);
  var seed = _osCloudSeed(def.tMs, def.lat, def.lon), r = _osMulberry(seed);
  var coverage = r(), dir = r() * 2 * Math.PI, speed = OS_CLOUD_WIND_MS[0] + (OS_CLOUD_WIND_MS[1] - OS_CLOUD_WIND_MS[0]) * r();
  return { coverage: coverage, wind: [Math.sin(dir) * speed, Math.cos(dir) * speed], base: OS_CLOUD_BASE_M, thickness: OS_CLOUD_THICK_M, seed: [seed % OS_CLOUD_NOISE_SPAN, (seed >>> 10) % OS_CLOUD_NOISE_SPAN] };
}
// The field as the shaders take it (almanac-skygl.js SG_GLSL_CLOUDS' uniforms); sunShare is the Sun's light that reaches the place (an eclipse).
// mode 'clear' draws none (a visit to see something in the sky is not left to the day's deck); 'auto' (or nothing) is the day's own.
function _osCloudValues(def, sunShare, mode) {
  var f = _osCloudField(def), day = _osSolarDay(def.tMs, def.lon);
  return { cloud: [mode === 'clear' ? 0 : f.coverage, f.base, f.thickness, f.seed[0]], wind: [f.wind[0], f.wind[1], (day - Math.floor(day)) * OS_DAY_S], sunE: SG_SUN_LUX * (sunShare == null ? 1 : sunShare) };
}

// ── An eclipse of the Sun ──
// What a window needs to draw one: how much of the Sun's disc the Moon covers (the card's own two-circle overlap), where each stands and
// how big each is, and the corona's strength (it comes out in the last tenth before totality). The light it takes from the sky is already
// in _osSkyState (sunShare, the lux and the exposure); this is for the discs.
var OS_CORONA_FROM = 0.9;
function _osEclipse(def) {
  var S = _osSkyState(def), e = S.eph;
  return { obsc: S.obsc, sunShare: S.sunShare, sunAz: e.sun.az, sunAlt: e.sun.alt, moonAz: e.moon.azimuth, moonAlt: e.moon.altitude,
    sunSemiDeg: SKY_SUN_SEMI_DEG, moonSemiDeg: _skyMoonSemi(S.now, e.moon.altitude),
    corona: S.obsc > OS_CORONA_FROM ? Math.pow((S.obsc - OS_CORONA_FROM) / (1 - OS_CORONA_FROM), 3) : 0 };
}

// The same field on the CPU, for what is drawn over the sky by the canvas (the Sun's disc): the sum of almanac-skygl.js SG_GLSL_CLOUD_FIELD,
// integer hash included, so a lattice point has the same value on the GPU and here. How much of the sky the deck covers at a bearing and height
// (degrees), from _osCloudValues' numbers: 0 clear to about 1 solid.
function _osCloudHash(ix, iy) {
  var h = (Math.imul(ix | 0, 1597334673) ^ Math.imul(iy | 0, 3812015801)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function _osCloudNoise(x, y) {
  var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  var a = _osCloudHash(ix, iy), b = _osCloudHash(ix + 1, iy), c = _osCloudHash(ix, iy + 1), d = _osCloudHash(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function _osSmoothstep(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function _osCloudFbm(px, py, size, fp) {   // each octave fades to its mean once its cells are smaller than the ground a pixel covers (the GLSL's sum)
  var s = 0, a = 0.5;
  for (var i = 0; i < 4; i++) { s += a * (0.5 + (_osCloudNoise(px, py) - 0.5) * (1 - _osSmoothstep(0.25, 1, fp / size))); px = px * 2.03 + 17.1; py = py * 2.03 + 17.1; a *= 0.5; size /= 2.03; }
  return s / 0.9375;
}
function _osCloudMargin(v, x, y, t) {
  var D = SG_CLOUD_DETAIL, qx = (x - v.wind[0] * v.wind[2]) / SG_CLOUD_SCALE_M + v.cloud[3], qy = (y - v.wind[1] * v.wind[2]) / SG_CLOUD_SCALE_M + v.cloud[3];
  var n = (1 - D.share) * _osCloudFbm(qx, qy, SG_CLOUD_SCALE_M, t * SG_CLOUD_FOOTPRINT) + D.share * _osCloudFbm(qx * D.scale + D.offset, qy * D.scale + D.offset, SG_CLOUD_SCALE_M / D.scale, t * SG_CLOUD_FOOTPRINT);
  n = (n - 0.47) * D.stretch + 0.47;
  var th = SG_CLOUD_THRESHOLD[0] + (SG_CLOUD_THRESHOLD[1] - SG_CLOUD_THRESHOLD[0]) * v.cloud[0];
  return n - th;
}
function _osCloudAlphaAt(v, azDeg, altDeg) {
  var az = azDeg * Math.PI / 180, alt = altDeg * Math.PI / 180, dz = Math.sin(alt);
  if (dz <= 0.003 || v.cloud[0] <= 0) return 0;
  var t = Math.min(v.cloud[1] / dz, SG_CLOUD_FAR_M), c = Math.cos(alt);
  return (1 - Math.exp(-SG_CLOUD_TAU * _osSmoothstep(0, SG_CLOUD_EDGE, _osCloudMargin(v, Math.sin(az) * c * t, Math.cos(az) * c * t, t)))) * 0.94 * _osSmoothstep(0.003, 0.03, dz);
}

// How much of the Moon the day's deck hides (0 clear to about 1 solid), at its place in the sky.
function _osMoonVeil(s) { return _osMoonVeilAt(_osDef({ lat: s.lat, lon: s.lon, tMs: s.nowTime })); }
// The same for any definition; mode 'clear' (a hand-off's) has no deck. The ground view's Moon takes this (almanac-oneair.js moonVeil).
function _osMoonVeilAt(def, mode) {
  var S = _osSkyState(def), m = S.eph.moon;
  return m.altitude > 0 ? _osCloudAlphaAt(_osCloudValues(def, S.sunShare, mode), m.azimuth, m.altitude) : 0;
}
function _osSunVeilAt(def, mode) {
  var S = _osSkyState(def), q = S.eph.sun;
  return q.alt > 0 ? _osCloudAlphaAt(_osCloudValues(def, S.sunShare, mode), q.az, q.alt) : 0;
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

// ── Whether the 3D view can run here ──
// Stand here, There and then's ground and Look's way down all need the 3D view, which needs WebGL2. The answer is asked for when a person taps
// (or after the card's first picture), never before it: a context costs. A page whose 3D view has found it cannot run says so itself.
var _osGl2 = null, _osButtonsSynced = false;
function _os3DAvailable() {
  if (typeof window.openAlmanacEarth === 'function' && window.openAlmanacEarth.unsupported) return false;
  if (_osGl2 === null) {
    try { _osGl2 = !!document.createElement('canvas').getContext('webgl2'); } catch (e) { _osGl2 = false; }
  }
  return _osGl2;
}
// The buttons that lead to the ground are not shown where it cannot be drawn.
function _osSync3DButtons() {
  var ok = _os3DAvailable();
  Array.prototype.forEach.call(document.querySelectorAll('.alm-sky-stand, #look-stand'), function (b) { b.hidden = !ok; });
}

// ── The card to Stand here, and back ──
// The card's place, instant and facing, as the hand-off Stand here takes (almanac-stand.js _aeStandOpen).
// opts.clouds: 'auto' (the day's own deck: the default) or 'clear' (a visit to see something in the sky: an eclipse, a there-and-then, is not left to a coin flip).
function _osHandoffFrom(def, back, opts) {
  return { body: def.body, lat: def.lat, lon: def.lon, ms: def.tMs, heading: def.heading, pitch: def.pitch, back: back, clouds: opts && opts.clouds === 'clear' ? 'clear' : 'auto' };
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
  if (!def) return Promise.resolve(false);
  var y = window.pageYOffset || 0;
  return _osStandOpen(def, function () { window.scrollTo(0, y); if (typeof _skyResume === 'function' && typeof _skyState !== 'undefined' && _skyState) _skyResume(); });
}
// Stand here at a definition (the 3D view's files load on the first ask), then `back` when its own way back is taken.
function _osStandOpen(def, back) {
  if (!_os3DAvailable()) return Promise.resolve(false);
  if (typeof _aeStandOpen !== 'function' && typeof _almLoadEarth !== 'function') return Promise.resolve(false);
  var ready = typeof _aeStandOpen === 'function' ? Promise.resolve() : _almLoadEarth().then(function () { return _aeStandReady(); });
  return ready.then(function () { return _aeStandOpen(_osHandoffFrom(def, back)); }).catch(function () { return false; });
}

// Stand here is open without a hand-off (a there-and-then arrives by place): say how its sky is to be clouded.
function _osStandClouds(mode) {
  var st = typeof _ae !== 'undefined' && _ae && _ae.stand;
  if (!st) return;
  st.handoff = Object.assign(st.handoff || {}, { clouds: mode });
  st.dirty = true; _ae.dirty = true;
}

// Look's way down to the ground: the same place, instant and facing, and the phone still turning the view if it was (Stand here reads the
// phone through the same sensors, and the person's choice is the one Look kept); its way back opens Look again where it was.
var OS_LOOK_BACK_MS = 700;   // the longest Look waits for the browser's step back before it opens anyway
var OS_MOTION_KEY = 'zimi_ae_stand_motion';   // almanac-standlook.js AE_MOTION_KEY: whether the phone turns the ground view
function _osStandFromLook() {
  var S = typeof _look !== 'undefined' ? _look : null;
  if (!S) return Promise.resolve(false);
  var place = S.place, view = S.view, sensing = S.mode === 'sensor', ms = typeof _almFocusInstant === 'function' ? _almFocusInstant().getTime() : Date.now();
  _lookClose();
  if (sensing) { try { localStorage.setItem(OS_MOTION_KEY, '1'); } catch (e) { /* private window */ } }
  var def = _osDef({ lat: place.lat, lon: place.lon, tMs: ms, heading: view.az, pitch: Math.max(0, view.alt) });
  // Closing the 3D view takes the browser a step back; Look opens after that step has landed, or its own would be taken back with it.
  return _osStandOpen(def, function () {
    var done = false, open = function () {
      if (done) return;
      done = true;
      if (typeof _lookOpen === 'function') _lookOpen({ lat: place.lat, lon: place.lon, name: place.name });
    }, onPop = function () { window.removeEventListener('popstate', onPop); setTimeout(open, 0); };
    window.addEventListener('popstate', onPop);
    setTimeout(function () { window.removeEventListener('popstate', onPop); open(); }, OS_LOOK_BACK_MS);
  });
}

// ── The place's own night ──
// The light-pollution dial's starting point, from a one-degree night-lights grid (zimi/static/earth/nightlights-v1.bin, 5.8 KB, from the Black
// Marble: scripts/build_nightlights.py): a city under its glow, a desert under none. The person's own choice of dial wins (almanac-sky.js).
var OS_NIGHT_URL = '/static/earth/nightlights-v1.bin', OS_NIGHT_MAGIC = 'ZNLT', OS_NIGHT_HEADER = 10, OS_NIGHT_MAX_DIAL = 1;
var _osPlaceDial = null, _osNight = null, _osNightLoading = false;
function _osNightParse(buf) {
  if (!buf || buf.byteLength < OS_NIGHT_HEADER) return null;
  var u8 = new Uint8Array(buf), v = new DataView(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== OS_NIGHT_MAGIC || u8[4] !== 1) return null;
  var w = v.getUint16(6, true), h = v.getUint16(8, true), n = w * h, cells = new Uint8Array(n), k = 0, pos = OS_NIGHT_HEADER;
  while (k < n && pos + 1 < buf.byteLength) {
    var len = u8[pos + 1];
    if (!len || k + len > n) return null;
    cells.fill(u8[pos], k, k + len);
    k += len; pos += 2;
  }
  return k === n ? { w: w, h: h, cells: cells } : null;
}
// The dial for a place (0 a dark site to 1 a city), or null while the grid is not in.
function _osNightDial(lat, lon) {
  var g = _osNight;
  if (!g || !isFinite(lat) || !isFinite(lon)) return null;
  var x = Math.min(g.w - 1, Math.max(0, Math.floor((((lon + 180) % 360) + 360) % 360 / 360 * g.w))), y = Math.min(g.h - 1, Math.max(0, Math.floor((90 - lat) / 180 * g.h)));
  return Math.min(OS_NIGHT_MAX_DIAL, g.cells[y * g.w + x] / 255);
}
function _osNightLoad() {
  if (_osNight || _osNightLoading) return;
  _osNightLoading = true;
  fetch(OS_NIGHT_URL).then(function (r) { if (!r.ok) throw new Error('night'); return r.arrayBuffer(); }).then(function (b) {
    _osNight = _osNightParse(b);
    var st = typeof _skyState !== 'undefined' ? _skyState : null;
    if (st) _osSetPlaceDial(st);
  }).catch(function () { /* the dial stays where it was */ });
}
// The place's dial into effect (and remembered with the place), repainting the sky if it moved.
function _osSetPlaceDial(s) {
  var d = _osNightDial(s.lat, s.lon);
  if (d === null || d === _osPlaceDial) return;
  _osPlaceDial = d;
  if (s.land) _osLandRemember(_osLandKey(s), s.land);
  if (s.eph && typeof _skyBrightness === 'function') _skyBrightness(s);
  s.baseDirty = true;
  if (typeof _skyKick === 'function') _skyKick();
}

// ── What the card stands on ──
// The foreground of the live sky is the place's own land (almanac-skyland.js, from the one grid: almanac-oneland.js). Until the grid is in
// it is a plain horizon, never the palms; the grid and the painter load after the card's first picture, and the answer for a place is
// kept (a place is the same land next time) so a return visit paints it at once.
var OS_LAND_KEY = 'zimi_sky_land', OS_LAND_SRCS = ['/static/almanac-oneland.js', '/static/almanac-skyland.js'];
var _osLandLoading = false, _osLandFailed = false;
function _osLandKey(s) { return Math.floor(s.lat) + ',' + Math.floor(s.lon); }
function _osLandRemembered(key) {
  try { var r = JSON.parse(localStorage.getItem(OS_LAND_KEY)); return r && r.k === key ? r : null; } catch (e) { return null; }
}
function _osLandRemember(key, land) {
  try { localStorage.setItem(OS_LAND_KEY, JSON.stringify({ k: key, cls: land.cls, coast: land.coast, rgb: land.rgb, dial: _osPlaceDial })); } catch (e) { /* private window */ }
}
// The scene to draw: 'plain' | 'beach' | a land class ('broadleaf', 'conifer', 'grass', 'desert', 'snow', 'tundra').
function _osCardScene(s) {
  if (s.hosted) return 'beach';   // Look's own sphere keeps what it had
  if (!_osButtonsSynced) { _osButtonsSynced = true; if (typeof requestIdleCallback === 'function') requestIdleCallback(_osSync3DButtons, { timeout: 3000 }); else setTimeout(_osSync3DButtons, 1500); }
  var key = _osLandKey(s);
  if (s.landKey !== key) {
    s.landKey = key; s.land = _osLandRemembered(key);
    if (s.land && typeof s.land.dial === 'number') _osPlaceDial = s.land.dial;   // a return visit starts at the place's own dial
    if (_osNight) _osSetPlaceDial(s);
  }
  if (!s.land) { _osLandKick(s, key); return 'plain'; }
  // The sea where the grid says sea or a coast, except where ice or tundra holds the shore: that is an ice shore, not a beach.
  return s.land.cls === 'sea' || (s.land.coast && s.land.cls !== 'snow' && s.land.cls !== 'tundra') ? 'beach' : s.land.cls;
}
function _osLandKick(s, key) {
  if (_osLandLoading || _osLandFailed || typeof _loadScript !== 'function') return;
  _osLandLoading = true;
  var go = function () {
    _osSync3DButtons();
    _osNightLoad();
    Promise.all(OS_LAND_SRCS.map(function (src) { return _loadScript(src); })).then(function (ok) {
      if (!ok.every(Boolean) || typeof _osLandCoverLoad !== 'function') return false;
      return _osLandCoverLoad();
    }).then(function (ok) {
      _osLandLoading = false;
      if (!ok) _osLandFailed = true;   // the plain horizon stays; not retried every picture
      var st = typeof _skyState !== 'undefined' ? _skyState : null;
      if (!ok || !st || _osLandKey(st) !== key) return;
      st.land = _osLandCover(st.lat, st.lon);
      if (st.land) _osLandRemember(key, st.land);
      st.baseDirty = true;
      if (typeof _skyKick === 'function') _skyKick();
    });
  };
  // After the card's first picture and the page's own work, when the person is not touching the screen.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 400);
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
