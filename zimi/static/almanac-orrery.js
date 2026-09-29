// ── Almanac: solar-system orrery ──
// Split out of almanac.js, which had grown past 5,900 lines.
// Keplerian planet positions, the canvas orrery, its speed/date controls and the rocket transits.
// Loaded before almanac.js; all almanac scripts share one global scope.

var _almanacOrreryRAF = null;

// Planet visual radius is now a fraction of canvas width — much bigger, Apple Watch style
var _PLANETS = {
  Mercury: { a: 0.38710, e: 0.20563, I: 7.005, L: 252.251, LP: 77.457, N: 48.331, da: 0, de: 0.00002, dI: -0.0060, dL: 149472.674, dLP: 0.160, dN: -0.125, color: '#b0a090', glow: '#c4b8a8', vr: 0.008 },
  Venus:   { a: 0.72333, e: 0.00677, I: 3.395, L: 181.980, LP: 131.564, N: 76.680, da: 0, de: -0.00005, dI: -0.0008, dL: 58517.816, dLP: 0.013, dN: -0.278, color: '#e8c87a', glow: '#f0d890', vr: 0.014 },
  Earth:   { a: 1.00000, e: 0.01671, I: 0.000, L: 100.464, LP: 102.937, N: 0, da: 0, de: -0.00004, dI: -0.0131, dL: 35999.373, dLP: 0.323, dN: 0, color: '#4a90d9', glow: '#6ab0ff', vr: 0.015 },
  Mars:    { a: 1.52368, e: 0.09340, I: 1.850, L: 355.453, LP: 336.060, N: 49.558, da: 0, de: 0.00008, dI: -0.0013, dL: 19140.300, dLP: 0.444, dN: -0.293, color: '#c46040', glow: '#e07050', vr: 0.011 },
  Jupiter: { a: 5.20260, e: 0.04849, I: 1.303, L: 34.351, LP: 14.331, N: 100.464, da: -0.00002, de: 0.00018, dI: -0.0055, dL: 3034.906, dLP: 0.215, dN: 0.177, color: '#c49868', glow: '#e0b888', vr: 0.032 },
  Saturn:  { a: 9.55491, e: 0.05551, I: 2.489, L: 50.077, LP: 93.057, N: 113.665, da: -0.00003, de: -0.00035, dI: 0.0033, dL: 1222.114, dLP: 0.752, dN: -0.250, color: '#d4b878', glow: '#f0da98', vr: 0.026, rings: true },
  Uranus:  { a: 19.1884, e: 0.04638, I: 0.773, L: 314.055, LP: 173.005, N: 74.006, da: -0.00002, de: -0.00002, dI: -0.0023, dL: 428.467, dLP: 0.009, dN: 0.074, color: '#78c8c8', glow: '#a0e8e8', vr: 0.018 },
  Neptune: { a: 30.0699, e: 0.00895, I: 1.770, L: 304.223, LP: 46.682, N: 131.784, da: 0.00003, de: 0.00001, dI: 0.0001, dL: 218.460, dLP: 0.010, dN: -0.005, color: '#3868c8', glow: '#5888f0', vr: 0.016 }
};

var _ORRERY_MAX_ECC = 0.99;
function _planetPosition(name, T) {
  var p = _PLANETS[name];
  var a = p.a + p.da * T;
  // The element rates are linear fits for a few thousand years. Hundreds of
  // millennia out they carry e past 1, sqrt(1 - e*e) turns NaN and the canvas
  // throws; an orbit is an ellipse only for 0 <= e < 1, so hold it there.
  var e = Math.min(Math.max(p.e + p.de * T, 0), _ORRERY_MAX_ECC);
  var L = (p.L + p.dL * T) % 360;
  var LP = (p.LP + p.dLP * T) % 360;
  var M = ((L - LP) % 360 + 360) % 360;
  var Mrad = M * DEG_TO_RAD;
  var E = _solveKepler(Mrad, e);
  var xp = a * (Math.cos(E) - e);
  var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  var LPrad = LP * DEG_TO_RAD;
  var x = xp * Math.cos(LPrad) - yp * Math.sin(LPrad);
  var y = xp * Math.sin(LPrad) + yp * Math.cos(LPrad);
  return { x: x, y: y, r: Math.sqrt(x * x + y * y) };
}

// ── Light and relativity: the numbers behind the hover delay, the ride and the twins ──
// Both defining constants are exact (the metre since 1983; the AU by IAU 2012 B2).
// Literals, not MS_PER_DAY: this file is evaluated before almanac.js defines it.
var SPEED_OF_LIGHT_M_S = 299792458;
var SPEED_OF_LIGHT_KM_S = SPEED_OF_LIGHT_M_S / 1000;
var AU_M = 149597870700;
var AU_KM = AU_M / 1000;
var LIGHT_SECONDS_PER_AU = AU_M / SPEED_OF_LIGHT_M_S; // ~499.005 s, sunlight's trip at 1 AU
var SECONDS_PER_MINUTE = 60;
var SECONDS_PER_HOUR = 3600;
var SECONDS_PER_DAY = 86400;
var SECONDS_PER_JULIAN_YEAR = 365.25 * SECONDS_PER_DAY;

// One-way light (radio) travel time across a distance in AU.
function _lightDelaySeconds(au) { return au * LIGHT_SECONDS_PER_AU; }

// Lorentz factor gamma = 1 / sqrt(1 - beta^2), beta = v / c.
function _lorentzFactor(beta) { return 1 / Math.sqrt(1 - beta * beta); }

// How much less time a clock moving at beta records than one at rest over
// `sec` of rest-frame time: sec * (1 - 1/gamma), written as
// sec * beta^2 / (1 + sqrt(1 - beta^2)) so a real rocket's ~1e-9 difference
// survives instead of vanishing into 1 - 0.999999999.
function _timeDilationLag(sec, beta) {
  return sec * beta * beta / (1 + Math.sqrt(1 - beta * beta));
}

// The moving clock's own reading (proper time) over `sec` of rest-frame time.
function _properTime(sec, beta) { return sec - _timeDilationLag(sec, beta); }

// Rest-frame duration of a straight trip of `au` at beta * c.
function _tripSecondsAtBeta(au, beta) { return _lightDelaySeconds(au) / beta; }

// Heliocentric ecliptic position (AU) of a body at a sim instant; the Sun is the origin.
function _orreryBodyAU(name, simMs) {
  if (name === 'Sun') return { x: 0, y: 0, r: 0 };
  return _planetPosition(name, _jdToJulianCentury(_dateToJD(simMs)));
}

function _auBetween(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Distance from Earth (AU) to a body, from the orrery's own positions.
function _orreryDistanceFromEarthAU(name, simMs) {
  return _auBetween(_orreryBodyAU(name, simMs), _orreryBodyAU('Earth', simMs));
}

// ── Localized readouts ──
// Units come from Intl in the reader's language ("12 min 40 sec", "12 мин 40 с",
// "12分钟40秒"), so no unit strings to translate. Formatters are cached: the
// ride rewrites its readout every frame, the Earth view (almanac-earth.js)
// its readouts ten times a second, and each Intl formatter is costly.
var _orrFmtCache = {};
function _orrLang() { return (typeof _currentLang !== 'undefined' && _currentLang) ? _currentLang : 'en'; }
// The formatter for a shape in the reader's language, built by build(lang)
// the first time it is asked for.
function _orrFormatter(shape, build) {
  var key = _orrLang() + '|' + shape;
  return _orrFmtCache[key] || (_orrFmtCache[key] = build(_orrLang()));
}
function _orrNum(n, unit, fracDigits) {
  var d = fracDigits || 0;
  return _orrFormatter('n|' + (unit || '') + '|' + d, function (lang) {
    var opts = { minimumFractionDigits: d, maximumFractionDigits: d };
    if (unit) { opts.style = 'unit'; opts.unit = unit; opts.unitDisplay = 'short'; }
    try { return new Intl.NumberFormat(lang, opts); }
    catch (e) { return { format: function (x) { return x.toFixed(d) + (unit ? ' ' + unit : ''); } }; }
  }).format(n);
}

// Two whole units, the larger first ("12 min 40 sec", "3 hr 5 min"); the
// smaller is dropped when it is zero.
function _orrTwoUnits(sec, big, bigUnit, small, smallUnit) {
  var total = Math.round(sec / small);
  var per = big / small;
  var a = Math.floor(total / per), b = total % per;
  return _orrNum(a, bigUnit) + (b ? ' ' + _orrNum(b, smallUnit) : '');
}

// Below a second, the unit that keeps the number readable: a real rocket's
// twin lag is tens of milliseconds, and it starts at zero.
var _ORR_SUBSECOND_UNITS = [[1e-3, 'millisecond'], [1e-6, 'microsecond'], [1e-9, 'nanosecond']];
var _ORR_ONE_DECIMAL_BELOW = 10; // "8.3 sec" but "40 sec"
var _ORR_DAYS_WITH_HOURS = 10;   // "3 days 4 hr" but "259 days"

// A span of seconds, from nanoseconds to years, in the reader's language.
function _orrFmtSpan(sec) {
  // Round to the shown step first, so 59.6 s reads "1 min", not "60 sec".
  sec = _orrSpanRound(Math.max(0, sec || 0));
  if (sec >= SECONDS_PER_JULIAN_YEAR) return _orrNum(sec / SECONDS_PER_JULIAN_YEAR, 'year', 1);
  if (sec >= SECONDS_PER_DAY * _ORR_DAYS_WITH_HOURS) return _orrNum(Math.round(sec / SECONDS_PER_DAY), 'day');
  if (sec >= SECONDS_PER_DAY) return _orrTwoUnits(sec, SECONDS_PER_DAY, 'day', SECONDS_PER_HOUR, 'hour');
  if (sec >= SECONDS_PER_HOUR) return _orrTwoUnits(sec, SECONDS_PER_HOUR, 'hour', SECONDS_PER_MINUTE, 'minute');
  if (sec >= SECONDS_PER_MINUTE) return _orrTwoUnits(sec, SECONDS_PER_MINUTE, 'minute', 1, 'second');
  if (sec >= 1) return _orrNum(sec, 'second', sec < _ORR_ONE_DECIMAL_BELOW ? 1 : 0);
  for (var i = 0; i < _ORR_SUBSECOND_UNITS.length; i++) {
    var v = sec / _ORR_SUBSECOND_UNITS[i][0];
    if (v >= 1) return _orrNum(v, _ORR_SUBSECOND_UNITS[i][1], v < _ORR_ONE_DECIMAL_BELOW ? 1 : 0);
  }
  return _orrNum(0, 'second');
}

// The smallest step _orrFmtSpan shows for a span (0 below a second, where the
// unit changes instead), so two readouts can be subtracted as displayed.
function _orrSpanStep(sec) {
  if (sec >= SECONDS_PER_JULIAN_YEAR) return SECONDS_PER_JULIAN_YEAR / 10;
  if (sec >= SECONDS_PER_DAY * _ORR_DAYS_WITH_HOURS) return SECONDS_PER_DAY;
  if (sec >= SECONDS_PER_DAY) return SECONDS_PER_HOUR;
  if (sec >= SECONDS_PER_HOUR) return SECONDS_PER_MINUTE;
  if (sec >= _ORR_ONE_DECIMAL_BELOW) return 1;
  if (sec >= 1) return 0.1;
  return 0;
}
function _orrSpanRound(sec) { var s = _orrSpanStep(sec); return s ? Math.round(sec / s) * s : sec; }

// The twins' difference as the reader will check it: Earth's clock minus the
// ship's, as both are shown ("15 min 30 sec" and "6 min 45 sec" give 8 min 45
// sec, not the 8 min 44.6 sec underneath). When the two read the same, as for
// a real rocket, the exact lag is the only honest number.
function _orreryShownLag(tw) {
  var d = _orrSpanRound(tw.earth) - _orrSpanRound(tw.ship);
  return d > 0 ? d : tw.lag;
}

function _orrFmtAU(au) { return _orrNum(au, null, 2); }

// Speed as a fraction of light: "0.90c".
function _orrFmtBeta(beta) { return _orrNum(beta, null, 2) + 'c'; }

// Gamma with enough decimals to show two significant digits past the 1:
// "2.29" at 0.9c, "1.0000000038" for a real rocket.
var _ORR_MAX_FRACTION_DIGITS = 20; // Intl's ceiling
function _orrFmtGamma(g) {
  var ex = g - 1;
  var d = ex > 0 ? Math.max(2, Math.ceil(-Math.log10(ex)) + 1) : 2;
  return _orrNum(g, null, Math.min(d, _ORR_MAX_FRACTION_DIGITS));
}

// ── The ride: the newest mission, which the camera follows and the readout describes ──
function _orreryRide() { return _orreryRockets.length ? _orreryRockets[_orreryRockets.length - 1] : null; }

// Sweep of a ride's path in radians: counter-clockwise outbound, the other way
// inbound (the direction the transfers have always been drawn).
function _orreryRideSweep(rk) {
  var s = rk.arrivalAngle - rk.launchAngle;
  if (rk.outbound) { while (s <= 0) s += 2 * Math.PI; }
  else { while (s >= 0) s -= 2 * Math.PI; }
  return s;
}

// A ride at fraction `frac` (0 launch, 1 arrival) as polar {angle, r} between
// radius r0 (Earth's orbit) and r1 (the target's): the angle sweeps evenly and
// the radius eases on a cosine, so the path leaves and meets both orbits
// tangentially, like a real transfer. In visual radii it draws the rocket; in
// AU it gives the readout, so the numbers describe the rocket on screen.
function _orreryRidePolar(rk, frac, r0, r1) {
  var ease = 0.5 - 0.5 * Math.cos(frac * Math.PI);
  return { angle: rk.launchAngle + frac * _orreryRideSweep(rk), r: r0 + (r1 - r0) * ease };
}

// The same point placed on a canvas centred at (cx, cy), y down.
function _orreryRideScreen(rk, frac, r0, r1, cx, cy) {
  var p = _orreryRidePolar(rk, frac, r0, r1);
  return { x: cx + Math.cos(p.angle) * p.r, y: cy - Math.sin(p.angle) * p.r };
}

// The rocket's heliocentric position in AU.
function _orreryRideAU(rk, frac) {
  var p = _orreryRidePolar(rk, frac, rk.r0AU, rk.r1AU);
  return { x: p.r * Math.cos(p.angle), y: p.r * Math.sin(p.angle) };
}

// Length (AU) of a ride's path, summed along the same curve the rocket flies.
var _ORR_PATH_SAMPLES = 64;
function _orreryRidePathAU(rk) {
  var len = 0, prev = _orreryRideAU(rk, 0);
  for (var i = 1; i <= _ORR_PATH_SAMPLES; i++) {
    var p = _orreryRideAU(rk, i / _ORR_PATH_SAMPLES);
    len += _auBetween(p, prev);
    prev = p;
  }
  return len;
}

// Where the ride is and how long a message home takes, at its own clock.
// Its clock runs on past arrival (the orrery keeps turning), and the rocket,
// now orbiting the planet, goes where the planet goes: "a message home now
// takes" follows the planet, not the instant of arrival.
function _orreryRideStatus(rk) {
  var frac = Math.min(1, Math.max(0, rk.elapsed / rk.duration));
  var simMs = rk._launchRealTime + Math.max(0, rk.elapsed);
  var at = frac < 1 ? _orreryRideAU(rk, frac) : _orreryBodyAU(rk.target, simMs);
  var au = _auBetween(at, _orreryBodyAU('Earth', simMs));
  return { frac: frac, au: au, delay: _lightDelaySeconds(au) };
}

// A transit's progress in whole days, in the reader's language: "122 / 259 days".
function _orrFmtTransitDays(rk) {
  var done = Math.min(Math.max(0, rk.elapsed), rk.duration);
  return _orrNum(Math.round(done / MS_PER_DAY)) + ' / ' + _orrNum(Math.round(rk.duration / MS_PER_DAY), 'day');
}

// ── The twin paradox, on the ride ──
// Slider 0 is the rocket as flown: its average speed along the drawn path over
// the transfer time (tens of km/s, some 0.0001c). Above 0 is a what-if: a
// straight line to where the planet stood at launch, at that fraction of c.
// Both clocks run with the ride's progress and stop at arrival.
var _TWIN_SLIDER_STEPS_PER_C = 100;
var _TWIN_MAX_BETA = 0.99;
var _orreryTwinBeta = 0;

function _twinSliderToBeta(v) {
  return Math.min(_TWIN_MAX_BETA, Math.max(0, v / _TWIN_SLIDER_STEPS_PER_C));
}

function _orreryRealSpeedKmS(rk) { return rk.pathAU * AU_KM / (rk.duration / 1000); }

function _orreryTwinClocks(rk, whatIfBeta, frac) {
  var total, beta;
  if (whatIfBeta > 0) {
    beta = whatIfBeta;
    total = _tripSecondsAtBeta(rk.straightAU, beta);
  } else {
    total = rk.duration / 1000;
    beta = _orreryRealSpeedKmS(rk) * 1000 / SPEED_OF_LIGHT_M_S;
  }
  var earth = total * frac;
  return { beta: beta, gamma: _lorentzFactor(beta), earth: earth,
           ship: _properTime(earth, beta), lag: _timeDilationLag(earth, beta) };
}

function _orreryTwinInput(val) {
  _orreryTwinBeta = _twinSliderToBeta(parseInt(val, 10) || 0);
  _orreryUpdateRide();
}

// ── Camera ──
// World coordinates are the un-zoomed canvas in CSS px, where every hit zone
// is recorded; the camera maps them to the screen. At rest it is the identity
// (the whole system, the Sun centred). On a ride it centres the rocket and
// zooms until the ride's outer orbit fills the view, then eases back out once
// the arrival flourish has faded.
var _ORRERY_CAM_REST = { x: 0.5, y: 0.5, zoom: 1 };  // screen-centre point (fractions of width), zoom
var _ORRERY_CAM_TAU_MS = 500;       // easing time constant
var _ORRERY_CAM_MAX_STEP_MS = 100;  // a long gap between frames eases, never jumps
var _ORRERY_RIDE_FIT = 0.36;        // the ride's outer orbit radius after zoom, in canvas widths
var _ORRERY_RIDE_MAX_ZOOM = 3.5;
var _orreryCam = { x: 0.5, y: 0.5, zoom: 1 };
var _orreryCamStamp = 0;

function _orreryCamReset() {
  _orreryCam = { x: _ORRERY_CAM_REST.x, y: _ORRERY_CAM_REST.y, zoom: _ORRERY_CAM_REST.zoom };
  _orreryCamStamp = 0;
}

function _orreryCssWidth() {
  return _orreryCanvas ? (_orreryCanvas.clientWidth || _orreryCanvas.width / _orreryDpr) : 0;
}

function _orreryScreenToWorld(sx, sy) {
  var w = _orreryCssWidth();
  return { x: (sx - w / 2) / _orreryCam.zoom + _orreryCam.x * w,
           y: (sy - w / 2) / _orreryCam.zoom + _orreryCam.y * w };
}

function _orreryWorldToScreen(wx, wy) {
  var w = _orreryCssWidth();
  return { x: (wx - _orreryCam.x * w) * _orreryCam.zoom + w / 2,
           y: (wy - _orreryCam.y * w) * _orreryCam.zoom + w / 2 };
}

// Reduced motion: the camera stays on the whole system (no follow, no zoom)
// and the Earth glow holds still. The query is kept, not rebuilt each frame.
var _orreryReduceMq = null;
function _orreryReduceMotion() {
  try {
    _orreryReduceMq = _orreryReduceMq || window.matchMedia('(prefers-reduced-motion: reduce)');
    return _orreryReduceMq.matches;
  } catch (e) { return false; }
}

// Where the camera wants to be this frame (fractions of the canvas width).
function _orreryCamTarget(z, T) {
  var rk = _orreryRide();
  if (!rk || (rk.arrived && !(rk.pathFade > 0)) || _orreryReduceMotion()) return _ORRERY_CAM_REST;
  var zoom = Math.min(_ORRERY_RIDE_MAX_ZOOM, Math.max(1,
    _ORRERY_RIDE_FIT / Math.max(_orreryPlanetR('Earth', z), _orreryPlanetR(rk.target, z))));
  if (rk.arrived) {   // hold on the planet itself, which keeps moving
    var tp = _planetPosition(rk.target, T), a = Math.atan2(tp.y, tp.x), vr = _orreryPlanetR(rk.target, z);
    return { x: 0.5 + Math.cos(a) * vr, y: 0.5 - Math.sin(a) * vr, zoom: zoom };
  }
  var p = _orreryRideScreen(rk, Math.min(1, rk.elapsed / rk.duration),
    _orreryPlanetR('Earth', z), _orreryPlanetR(rk.target, z), 0.5, 0.5);
  return { x: p.x, y: p.y, zoom: zoom };
}

// Ease the camera toward its target, frame-rate independent.
function _orreryCamStep(target) {
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  var dt = _orreryCamStamp ? Math.min(now - _orreryCamStamp, _ORRERY_CAM_MAX_STEP_MS) : _ORRERY_CAM_MAX_STEP_MS;
  _orreryCamStamp = now;
  var k = 1 - Math.exp(-dt / _ORRERY_CAM_TAU_MS);
  _orreryCam.x += (target.x - _orreryCam.x) * k;
  _orreryCam.y += (target.y - _orreryCam.y) * k;
  _orreryCam.zoom += (target.zoom - _orreryCam.zoom) * k;
}

// ── The Earth glow: a way into the Earth view (almanac-earth.js) ──
// Drawn only while that view exists, so a build without it shows no dead glow.
var _EARTH_GLOW_SCALE = 2.6;        // glow radius, in Earth radii
var _EARTH_GLOW_PERIOD_MS = 3200;   // one slow breath
var _EARTH_GLOW_ALPHA = 0.10;       // resting strength
var _EARTH_GLOW_PULSE = 0.08;       // how much the breath adds

// Once a first open finds no WebGL (almanac-earth.js sets .unsupported), the
// glow and the Earth tip's button go, and Earth opens its article again.
function _orreryEarthViewAvailable() {
  return typeof window.openAlmanacEarth === 'function' && !window.openAlmanacEarth.unsupported;
}
function _orreryOpenEarthView() {
  if (!_orreryEarthViewAvailable()) return;
  _orreryMarkTried('earth');
  window.openAlmanacEarth();
}

// ── Saying what the orrery does, until it has been done ──
// A phone has no hover, and nothing said that a planet flies or that Earth
// opens in 3D (Eric, 2026-09-29, found neither). Until each has been done
// once on this device, a line under the orrery says it (on touch), and Earth
// sends out a slow ring over its glow. Done, each goes quiet for good.
var _ORRERY_TRIED_KEY = 'zimi_orrery_tried';
var _ORRERY_BEACON_PERIOD_MS = 2400;   // one ring, out and gone
var _ORRERY_BEACON_REACH = 4.2;        // how far it goes, in Earth radii
var _ORRERY_BEACON_ALPHA = 0.55;       // how bright it starts
var _orreryTriedCache = null;          // read once: the draw loop asks every frame
function _orreryTried() {
  if (!_orreryTriedCache) {
    try { _orreryTriedCache = JSON.parse(localStorage.getItem(_ORRERY_TRIED_KEY)) || {}; }
    catch (e) { _orreryTriedCache = {}; }
  }
  return _orreryTriedCache;
}
function _orreryMarkTried(what) {
  var tried = _orreryTried();
  if (tried[what]) return;
  tried[what] = 1;
  try { localStorage.setItem(_ORRERY_TRIED_KEY, JSON.stringify(tried)); } catch (e) { /* this visit only */ }
  _orreryRenderHint();
}
function _orreryRenderHint() {
  var el = document.getElementById('orrery-hint');
  if (!el) return;
  var tried = _orreryTried(), parts = [];
  if (!tried.fly) parts.push(t('alm_orr_hint_fly'));
  if (!tried.earth && _orreryEarthViewAvailable()) parts.push(t('alm_orr_hint_earth'));
  el.textContent = parts.join(' · ');
  el.hidden = !parts.length;
}
// The ring's radius (in Earth radii) and strength at an instant; a still
// ring when motion is reduced.
function _orreryBeacon(nowMs, reduced) {
  if (reduced) return { r: _EARTH_GLOW_SCALE, a: _ORRERY_BEACON_ALPHA * 0.6 };
  var p = (nowMs % _ORRERY_BEACON_PERIOD_MS) / _ORRERY_BEACON_PERIOD_MS;
  return { r: 1 + (_ORRERY_BEACON_REACH - 1) * p, a: _ORRERY_BEACON_ALPHA * (1 - p) };
}
function _orreryEarthGlowAlpha(nowMs) {
  return _EARTH_GLOW_ALPHA + _EARTH_GLOW_PULSE * (0.5 + 0.5 * Math.sin(2 * Math.PI * nowMs / _EARTH_GLOW_PERIOD_MS));
}

var _orreryPlanetPositions = []; // [{name, x, y, r, glowR?}] in world CSS px for hover

var _orrerySunPos = null; // {x, y, r} in world CSS px — the Sun is always at center

// ── Tapping a body ──
// Interaction model (the pre-1.8 direct actions, the article link added, not
// substituted):
//   • A click does what it always did: a planet flies (the ride), a probe opens
//     its detail card, the Sun and the belts open their article. Earth opens
//     the Earth view when it exists, otherwise its article.
//   • Hover shows the body's tooltip: for a planet its distance from Earth and
//     the radio delay to it now, for the Sun how old its light is. The NAME is a
//     dotted-amber link (.alm-link idiom) when the curated Q-ID resolved.
//   • Touch has no hover, so the first tap on a planet or the Sun shows that
//     tooltip (with a Fly button) and the second tap acts. Other bodies act on
//     the first tap and show the tooltip when they have a link.
//   • With a mouse, a SECOND click on a body whose article resolved opens it.

var _orrerySelectedKey = null; // link key of the selected body
// How far past a body's edge a finger still reaches it: a planet is a few
// pixels across on a phone, a fingertip about forty. The nearest body wins.
var _ORRERY_TOUCH_REACH_PX = 20;

// Belt annulus hit zones, recorded on each draw (asteroid + Kuiper belts). Each
// is {key, rIn, rOut} in world CSS px measured from the canvas centre.
var _orreryBeltZones = [];

// Find the hit target at a screen position (CSS px), or null. The Sun (small,
// fixed at center) and planets/probes win over the belts (they sit inside/over
// the bands); belts — and the heliopause ring — are broad/thin ring zones.
// The nearest planet disc wins, and Earth's glow only catches taps no disc did.
function _orreryHitTest(mx, my, tolerance) {
  var wp = _orreryScreenToWorld(mx, my);
  mx = wp.x; my = wp.y;
  tolerance /= _orreryCam.zoom;
  // The Sun is one more disc in the nearest-wins race: taken first, its
  // finger-wide margin swallowed Mercury and Venus beside it.
  var best = null, bestGap = Infinity, glow = null, sun = false;
  if (_orrerySunPos) {
    var sd = Math.sqrt((mx - _orrerySunPos.x) * (mx - _orrerySunPos.x) + (my - _orrerySunPos.y) * (my - _orrerySunPos.y));
    if (sd - _orrerySunPos.r < tolerance) { sun = true; bestGap = sd - _orrerySunPos.r; }
  }
  for (var i = 0; i < _orreryPlanetPositions.length; i++) {
    var p = _orreryPlanetPositions[i];
    var dx = mx - p.x, dy = my - p.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d - p.r < tolerance && d - p.r < bestGap) { best = p; bestGap = d - p.r; }
    if (p.glowR && d < p.glowR + tolerance) glow = p;
  }
  if (best) return { type: 'planet', data: best };
  if (sun) return { type: 'sun', data: _orrerySunPos };
  if (glow) return { type: 'planet', data: glow };
  for (var j = 0; j < _voyagerPositions.length; j++) {
    var v = _voyagerPositions[j];
    var vdx = mx - v.x, vdy = my - v.y;
    if (vdx * vdx + vdy * vdy < (v.r + tolerance + 6) * (v.r + tolerance + 6)) return { type: 'voyager', data: v };
  }
  if (_orreryCanvas && _orreryBeltZones.length) {
    var c = (_orreryCanvas.clientWidth || 0) / 2;
    var brx = mx - c, bry = my - c;
    var rr = Math.sqrt(brx * brx + bry * bry);
    for (var b = 0; b < _orreryBeltZones.length; b++) {
      var bz = _orreryBeltZones[b];
      if (rr >= bz.rIn - tolerance && rr <= bz.rOut + tolerance) {
        return { type: 'belt', data: { key: bz.key, labelKey: bz.labelKey, x: mx, y: my, r: 0 } };
      }
    }
  }
  return null;
}

// AlmanacLinks key for a hit-test result, or null for un-mappable bodies.
function _orreryLinkKey(hit) {
  if (!hit) return null;
  if (hit.type === 'sun') return 'planet:sun';
  if (hit.type === 'planet') return 'planet:' + hit.data.name.toLowerCase();
  if (hit.type === 'voyager') return 'probe:' + hit.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (hit.type === 'belt') return hit.data.key;
  return null;
}

// The resolved article for a hit (null when not a link / batch not yet landed).
function _orreryLinkFor(hit) {
  var key = _orreryLinkKey(hit);
  return (key && window.AlmanacLinks) ? window.AlmanacLinks.linkFor(key) : null;
}

function _orreryOpenLink(key) { if (key && window.AlmanacLinks) window.AlmanacLinks.open(key); }

// A launchable planet: every planet but the one the rockets leave from.
function _orreryIsDestination(hit) { return hit.type === 'planet' && hit.data.name !== 'Earth'; }

// Bodies whose first touch shows the tooltip rather than acting.
function _orreryInfoFirst(hit) { return hit.type === 'sun' || _orreryIsDestination(hit); }

// A body's direct action; returns what it did.
function _orreryAct(hit) {
  if (_orreryIsDestination(hit)) { _orreryLaunchRocket(hit.data.name); return 'fly'; }
  if (hit.type === 'planet' && _orreryEarthViewAvailable()) { _orreryOpenEarthView(); return 'earth'; }
  if (hit.type === 'voyager') { _showVoyagerCard(hit.data.idx); return 'card'; }
  _orreryOpenLink(_orreryLinkKey(hit));   // Earth without its view, the Sun, a belt: the article
  return 'link';
}

// Tap handler for mouse (touch = false) and touch. Returns { hit, action }
// with action 'info' (tooltip only), 'fly', 'earth', 'card' or 'link', so the
// touch path knows whether to raise the tooltip; null on empty space.
function _orreryTap(mx, my, tolerance, touch) {
  var hit = _orreryHitTest(mx, my, tolerance);
  if (!hit) { _orrerySelectedKey = null; return null; }
  var linkKey = _orreryLinkKey(hit);
  if (touch && _orreryInfoFirst(hit)) {
    if (linkKey !== _orrerySelectedKey) { _orrerySelectedKey = linkKey; return { hit: hit, action: 'info' }; }
    _orrerySelectedKey = null;
    return { hit: hit, action: _orreryAct(hit) };
  }
  var resolved = !!_orreryLinkFor(hit);
  // Mouse: a second click on the same, already-selected body (whose article
  // resolved) opens it, the same open as the tooltip name-link.
  if (resolved && linkKey && linkKey === _orrerySelectedKey) {
    _orreryOpenLink(linkKey);
    return { hit: hit, action: 'link' };
  }
  var action = _orreryAct(hit);
  // Remember the selection only when its article resolved, so a second click
  // has somewhere to go (no link, no second-click open, never a search). The
  // Earth view is Earth's click every time, so it never selects.
  _orrerySelectedKey = (resolved && action !== 'earth') ? linkKey : null;
  return { hit: hit, action: action };
}

// The tooltip's distance and delay lines for a body at a sim instant, from the
// orrery's own positions, so the time machine moves them with everything else.
// A planet: how far from Earth and how long a message takes to reach it. The
// Sun: how far, and how old its light is when it arrives.
function _orreryDelayLines(hit, simMs) {
  var name = hit.type === 'sun' ? 'Sun' : (_orreryIsDestination(hit) ? hit.data.name : null);
  if (!name) return [];
  var au = _orreryDistanceFromEarthAU(name, simMs);
  var span = _orrFmtSpan(_lightDelaySeconds(au));
  return [
    t('alm_orr_au_from_earth', { d: _orrFmtAU(au) }),
    name === 'Sun' ? t('alm_orr_sun_light', { t: span }) : t('alm_orr_msg_to', { planet: _tp(name), t: span })
  ];
}

function _initOrrery() {
  var canvas = document.getElementById('almanac-orrery');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth;
  canvas.width = w * dpr;
  canvas.height = w * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = w + 'px';
  canvas.style.borderRadius = '12px';
  // Cache DOM refs for RAF loop (avoids getElementById per frame)
  _orreryCanvas = canvas;
  _orreryDpr = dpr;
  // (Re)arm the travel-tick visibility gate on this render's canvas.
  if (_orreryViewObs) _orreryViewObs.disconnect();
  if (typeof IntersectionObserver === 'function') {
    _orreryViewObs = new IntersectionObserver(function (entries) {
      _orreryInView = entries[entries.length - 1].isIntersecting;
    });
    _orreryViewObs.observe(canvas);
  } else {
    _orreryInView = true;
  }
  _orrerySpeedLabel = document.getElementById('orrery-speed-label');
  _orrerySliderEl = document.getElementById('orrery-slider');
  _orrerySelectedKey = null;
  _orreryRenderHint();
  _orreryCamReset();
  _drawOrrery(canvas, dpr);
  _orreryUpdateRide();

  // Hover tooltip: the body stats with the body NAME as a dotted-amber link when
  // its curated Q-ID resolved, and the Fly / Earth-view buttons. The tooltip
  // box itself takes pointer events (see CSS) and a grace period
  // (_ORRERY_TIP_GRACE_MS) keeps it open while the pointer crosses the small
  // gap between the body and the box — long enough to reach and click the link
  // or a button, without lingering once the pointer is truly gone.
  var _ORRERY_TIP_GRACE_MS = 300;
  var _ORRERY_TIP_GAP_PX = 8;   // between the body's edge and the tip
  var tooltip = document.getElementById('orrery-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'orrery-tooltip';
    wrap.style.position = 'relative';
    wrap.appendChild(tooltip);
    tooltip.addEventListener('click', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var key = el.getAttribute('data-alm-key');
      var fly = el.getAttribute('data-orr-fly');
      if (key) { e.stopPropagation(); _orreryOpenLink(key); }
      else if (fly) { e.stopPropagation(); tooltip.style.display = 'none'; _orrerySelectedKey = null; _orreryLaunchRocket(fly); }
      else if (el.hasAttribute('data-orr-earth')) { e.stopPropagation(); tooltip.style.display = 'none'; _orreryOpenEarthView(); }
    });
  }
  var _tipHideTimer = null;
  function _cancelTipHide() { if (_tipHideTimer) { clearTimeout(_tipHideTimer); _tipHideTimer = null; } }
  function _hideTip() { _cancelTipHide(); tooltip.style.display = 'none'; }
  function _tipHasAction() { return !!tooltip.querySelector('.alm-link, .orrery-tip-btn'); }
  function _scheduleTipHide(ms) { _cancelTipHide(); _tipHideTimer = setTimeout(function () { tooltip.style.display = 'none'; }, ms); }
  function _releaseTip() { if (_tipHasAction()) _scheduleTipHide(_ORRERY_TIP_GRACE_MS); else _hideTip(); }

  // Info for a hit, split so the NAME can carry the link idiom while the trailing
  // stats stay plain text: { name, rest } where `rest` includes its leading ' · '.
  function _tipInfo(hit) {
    if (hit.type === 'sun') return { name: t('alm_sun'), rest: '' };
    if (hit.type === 'planet') {
      var rest = '';
      if (hit.data.name !== 'Earth') {
        var days = Math.round(_hohmannDays(_PLANETS['Earth'].a, _PLANETS[hit.data.name].a));
        rest = (days < 365) ? ' · ' + t('alm_transfer_days', { n: days })
                            : ' · ' + t('alm_transfer_years', { n: (days / 365.25).toFixed(1) });
      }
      return { name: _tp(hit.data.name), rest: rest };
    }
    if (hit.type === 'voyager') {
      var sig = _signalDelay(hit.data.dist);
      return { name: hit.data.name, rest: ' · ' + hit.data.dist.toFixed(1) + ' AU · ' +
        _fmtDuration(sig.h, sig.m) + ' ' + t('alm_signal_delay') };
    }
    if (hit.type === 'belt') return { name: t(hit.data.labelKey), rest: '' };
    return { name: '', rest: '' };
  }

  // The tip's button: Fly to a planet (not while the time machine holds the
  // clock, when launches are refused), or step into the Earth view.
  function _tipButtonHtml(hit) {
    if (_orreryIsDestination(hit) && !_orreryTravelFocus()) {
      return '<button type="button" class="orrery-tip-btn" data-orr-fly="' + _almEsc(hit.data.name) + '">' +
        _almEsc(t('alm_orr_fly')) + '</button>';
    }
    if (hit.type === 'planet' && hit.data.name === 'Earth' && _orreryEarthViewAvailable()) {
      return '<button type="button" class="orrery-tip-btn" data-orr-earth="1">' + _almEsc(t('alm_orr_earth_view')) + '</button>';
    }
    return '';
  }

  // Render + place the tip next to the target on the side away from the Sun,
  // clamped inside the orrery box. The inner planets crowd the middle, and on
  // a phone the tip is wide enough that beside-placement buried them (and the
  // Sun) under it; above or below the body, away from centre, keeps them clear.
  function _showTip(hit) {
    _cancelTipHide();
    var linkKey = _orreryLinkFor(hit) ? _orreryLinkKey(hit) : null;
    var info = _tipInfo(hit);
    // The body NAME is the link — a subtle dotted-amber underline (the almanac
    // link idiom), no separate "Wikipedia" line. AlmanacLinks.wrap yields the
    // same .alm-link span used everywhere else; the click handler above only
    // acts on data-alm-key / data-orr-* targets, so the rest of the box is inert.
    var nameHtml = _almEsc(info.name);
    if (linkKey) nameHtml = window.AlmanacLinks.wrap(linkKey, nameHtml);
    var html = '<span class="orrery-tip-info">' + nameHtml + _almEsc(info.rest) + '</span>';
    var lines = _orreryDelayLines(hit, _orrerySimTime());
    for (var i = 0; i < lines.length; i++) html += '<span class="orrery-tip-line">' + _almEsc(lines[i]) + '</span>';
    tooltip.innerHTML = html + _tipButtonHtml(hit);
    tooltip.style.display = 'block';
    tooltip._orrKind = hit.type;
    var maxX = wrap.clientWidth, maxY = wrap.clientHeight;
    var tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    var at = _orreryWorldToScreen(hit.data.x, hit.data.y), r = hit.data.r * _orreryCam.zoom;
    var gap = r + _ORRERY_TIP_GAP_PX;
    var above = at.y - gap - th, below = at.y + gap;
    var ty = at.y < maxY / 2 ? (above >= 2 ? above : below) : (below + th <= maxY - 2 ? below : above);
    ty = Math.max(2, Math.min(ty, maxY - th - 2));
    var lx = Math.max(2, Math.min(at.x - tw / 2, maxX - tw - 2));
    tooltip.style.left = lx + 'px';
    tooltip.style.top = ty + 'px';
  }

  // Is the pointer over the tip's box? Only its link and button take the
  // pointer (CSS), so the rest of the box lets the canvas see through it.
  function _overTip(p) {
    if (tooltip.style.display === 'none') return false;
    var b = tooltip.getBoundingClientRect();
    return p.clientX >= b.left && p.clientX <= b.right && p.clientY >= b.top && p.clientY <= b.bottom;
  }

  // The hit-test tolerance for a pointer at canvas (mx, my), or -1 when the
  // tip's box keeps it. Through the box only a body's own disc is reached (a
  // planet the tip had covered: Earth's sat on Mars and held the pointer off
  // it). Near misses and the belts' wide rings under the box are the tip's,
  // so crossing it toward its button beside another planet never flips it,
  // and a click or tap on its text never acts on what lies beneath.
  function _tipTolerance(p, mx, my, tol) {
    if (!_overTip(p)) return tol;
    var h = _orreryHitTest(mx, my, 0);
    return (h && h.type !== 'belt') ? 0 : -1;
  }

  // Keep the tip alive while the pointer is on its link or button; stepping
  // off them onto the tip's own text only starts the grace period, which
  // the canvas cancels below while the pointer stays inside the box.
  tooltip.onmouseenter = _cancelTipHide;
  tooltip.onmouseleave = _releaseTip;

  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var tol = _tipTolerance(e, mx, my, 8);
    var hit = tol < 0 ? null : _orreryHitTest(mx, my, tol);
    // A belt's wide ring does not take the tip from a body's: on the way
    // from Mars to its Fly button the pointer crosses the asteroid belt,
    // and the tip flipped to the belt (then to Jupiter) before it arrived.
    // The body's tip keeps its grace period; the belt's comes after it.
    if (hit && hit.type === 'belt' && tooltip.style.display !== 'none' && tooltip._orrKind !== 'belt') hit = null;
    if (hit) {
      _showTip(hit);
      // Pointer for anything actionable: a launchable planet, Earth with its
      // view, a probe, or any body whose article resolved.
      var actionable = _orreryIsDestination(hit) || hit.type === 'voyager' || !!_orreryLinkFor(hit) ||
        (hit.type === 'planet' && _orreryEarthViewAvailable());
      canvas.style.cursor = actionable ? 'pointer' : 'default';
    } else if (tol < 0) {
      // Crossing the tip's text toward its button: it stays.
      _cancelTipHide();
      canvas.style.cursor = 'default';
    } else {
      // Grace period so the pointer can reach the tip's link or button before it hides.
      _releaseTip();
      canvas.style.cursor = 'default';
    }
  };
  canvas.onmouseleave = _releaseTip;

  // A click does the body's direct action (fly / Earth view / detail card /
  // open article), exactly as before. The mouse path lets hover manage the tip,
  // except that a ride or the Earth view moves the scene out from under it.
  canvas.onclick = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var tol = _tipTolerance(e, mx, my, 10);
    if (tol < 0) return;
    var res = _orreryTap(mx, my, tol, false);
    if (res && (res.action === 'fly' || res.action === 'earth')) _hideTip();
  };

  // Touch support. A touchstart→touchend that moved more than a few px is a
  // scroll/drag, not a tap. On a hit we preventDefault to kill the synthetic
  // click. The first tap on a planet or the Sun shows its tip (the hover touch
  // cannot have); a tap that acted keeps the tip only when it carries a link.
  var _orreryTouchStart = null;
  canvas.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) _orreryTouchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', function(e) {
    if (e.changedTouches.length === 0) return;
    var touch = e.changedTouches[0];
    if (_orreryTouchStart) {
      var moved = Math.abs(touch.clientX - _orreryTouchStart.x) + Math.abs(touch.clientY - _orreryTouchStart.y);
      _orreryTouchStart = null;
      if (moved > 12) return; // a drag/scroll, not a tap
    }
    var rect = canvas.getBoundingClientRect();
    var tx = touch.clientX - rect.left, ty = touch.clientY - rect.top;
    var tol = _tipTolerance(touch, tx, ty, _ORRERY_TOUCH_REACH_PX);
    if (tol < 0) { e.preventDefault(); return; }   // a tap on the tip's text: the tip stays as it was
    var res = _orreryTap(tx, ty, tol, true);
    if (res) e.preventDefault();
    var keep = res && (res.action === 'info' ||
      (res.action !== 'fly' && res.action !== 'earth' && _orreryLinkFor(res.hit)));
    if (keep) _showTip(res.hit); else _hideTip();
  });

  // Initial sync, not just the date: a re-init mid-travel (deep-link return,
  // panel rebuild) must restore the controls' overridden state too.
  _orrerySyncToFocus();
}

// Deterministic seeded PRNG (Park-Miller minimal-standard LCG) — every
// decorative starfield in the almanac (orrery, horizon scene, star chart) is
// generated from one of these rather than Math.random, so a layout is stable
// across frames/re-inits and only ever changes if its seed does.
function _lcgRand(seed) {
  var s = seed;
  return function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

// Pre-computed orrery background stars (computed once, not per frame)
var _orreryBgStars = null;

function _ensureOrreryStars(W, dpr) {
  if (_orreryBgStars && _orreryBgStars.W === W) return _orreryBgStars.stars;
  var sr = _lcgRand(73);
  var stars = [];
  for (var i = 0; i < 40; i++) {
    stars.push({ x: sr() * W, y: sr() * W, b: 0.03 + sr() * 0.06, r: (0.3 + sr() * 0.4) * dpr });
  }
  _orreryBgStars = { W: W, stars: stars };
  return stars;
}

function _drawOrrery(canvas, dpr) {
  var ctx = canvas.getContext('2d');
  var W = canvas.width;
  var cx = W / 2, cy = W / 2;

  var simTime = _orrerySimTime();
  var JD = _dateToJD(simTime);
  var T = _jdToJulianCentury(JD);

  ctx.clearRect(0, 0, W, W);

  // Match page background
  ctx.fillStyle = '#0a0a0b';
  ctx.fillRect(0, 0, W, W);

  // Background stars — pre-computed positions, drawn every frame
  var bgStars = _ensureOrreryStars(W, dpr);
  for (var si = 0; si < bgStars.length; si++) {
    var st = bgStars[si];
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + st.b.toFixed(3) + ')';
    ctx.fill();
  }

  var names = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

  // z: how far the view has glided out toward the probes (0 = clean planet view
  // at "now", 1 = full deep space after scrubbing years away).
  var z = _orreryDeepFactor();

  // Everything below the stars goes through the camera (the ride's follow and
  // zoom). `u` is one screen CSS px in world device px: strokes, text and
  // markers are sized in u so they stay crisp and constant while bodies and
  // distances scale with the zoom.
  _orreryCamStep(_orreryCamTarget(z, T));
  var cam = _orreryCam;
  var u = dpr / cam.zoom;
  ctx.save();
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, W / 2 - cam.x * W * cam.zoom, W / 2 - cam.y * W * cam.zoom);

  // Orbit rings — Apple Watch style: visible but understated
  for (var i = 0; i < names.length; i++) {
    var orbitR = _orreryPlanetR(names[i], z) * W;
    ctx.beginPath();
    ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.7 * u;
    ctx.stroke();
  }

  // Faint labelled band helper (asteroid + Kuiper belts). Records each band's
  // annulus (CSS px) so the tap/hover hit-test can open its article.
  _orreryBeltZones = [];
  var _belt = function (auIn, auOut, fill, labelCol, label, key, labelKey) {
    var rIn = _orrR(auIn, z) * W, rOut = _orrR(auOut, z) * W, rMid = (rIn + rOut) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.arc(cx, cy, rIn, 0, Math.PI * 2, true);
    ctx.fillStyle = fill; ctx.fill('evenodd');
    ctx.font = (7.5 * u) + 'px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = labelCol; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy - rMid);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
    if (key) _orreryBeltZones.push({ key: key, labelKey: labelKey, rIn: rIn / dpr, rOut: rOut / dpr });
  };

  // Asteroid belt — a faint band in the Mars–Jupiter gap.
  _belt(2.1, 3.3, 'rgba(200,190,170,0.06)', 'rgba(200,190,170,0.5)', t('alm_asteroid_belt'), 'belt:asteroid', 'alm_asteroid_belt');

  // Deep-space reference rings — fade in as the view eases out (z), giving the
  // probes something to be "beyond".
  if (z > 0.02) {
    ctx.save();
    ctx.globalAlpha = z;
    var _refRing = function (au, col, dash, label, key, labelKey) {
      var rr = _orrR(au, z) * W;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = col; ctx.lineWidth = 0.8 * u;
      ctx.setLineDash(dash ? [3 * u, 4 * u] : []);
      ctx.stroke();
      if (label) {
        ctx.setLineDash([]);
        ctx.font = (8 * u) + 'px -apple-system, system-ui, sans-serif';
        ctx.fillStyle = col; ctx.textAlign = 'center';
        ctx.fillText(label, cx, cy - rr - 3 * u);
      }
      ctx.restore();
      // A thin ring (not a filled band) still gets a narrow hit zone around its
      // drawn line, same annulus scheme the belts use.
      if (key) {
        var ringTol = 4 * u;
        _orreryBeltZones.push({ key: key, labelKey: labelKey, rIn: (rr - ringTol) / dpr, rOut: (rr + ringTol) / dpr });
      }
    };
    _belt(_KUIPER_INNER_AU, _KUIPER_OUTER_AU, 'rgba(120,160,220,0.05)', 'rgba(150,180,230,0.55)', t('alm_kuiper_belt'), 'belt:kuiper', 'alm_kuiper_belt');
    _refRing(_HELIO_TERMINATION_AU, 'rgba(255,180,60,0.22)', true, null);
    _refRing(_HELIOPAUSE_AU, 'rgba(120,200,255,0.30)', true, t('alm_heliopause'), 'belt:heliopause', 'alm_heliopause');
    ctx.restore();
  }

  // Sun — large luminous glow, Apple Watch style
  var sunR = W * 0.022;
  _orrerySunPos = { x: cx / dpr, y: cy / dpr, r: sunR / dpr }; // hover/tap hit zone (CSS px)

  // Wide outer haze
  var haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.14);
  haze.addColorStop(0, 'rgba(255,210,100,0.10)');
  haze.addColorStop(0.2, 'rgba(255,180,60,0.04)');
  haze.addColorStop(0.6, 'rgba(255,150,40,0.01)');
  haze.addColorStop(1, 'transparent');
  ctx.fillStyle = haze;
  ctx.beginPath(); ctx.arc(cx, cy, W * 0.14, 0, Math.PI * 2); ctx.fill();

  // Inner corona
  var corona = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR * 4);
  corona.addColorStop(0, 'rgba(255,240,200,0.25)');
  corona.addColorStop(0.3, 'rgba(255,200,100,0.10)');
  corona.addColorStop(0.7, 'rgba(255,160,60,0.03)');
  corona.addColorStop(1, 'transparent');
  ctx.fillStyle = corona;
  ctx.beginPath(); ctx.arc(cx, cy, sunR * 4, 0, Math.PI * 2); ctx.fill();

  // Sun disc
  var sd = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR);
  sd.addColorStop(0, '#fffff4');
  sd.addColorStop(0.4, '#fff0c0');
  sd.addColorStop(0.8, '#ffc840');
  sd.addColorStop(1, '#e08820');
  ctx.fillStyle = sd;
  ctx.beginPath(); ctx.arc(cx, cy, sunR, 0, Math.PI * 2); ctx.fill();

  // Planets — big, no labels, Apple Watch proportions
  _orreryPlanetPositions = [];
  for (var i = 0; i < names.length; i++) {
    var pos = _planetPosition(names[i], T);
    var angle = Math.atan2(pos.y, pos.x);
    var visR = _orreryPlanetR(names[i], z) * W;
    var px = cx + Math.cos(angle) * visR;
    var py = cy - Math.sin(angle) * visR;
    var p = _PLANETS[names[i]];
    var pr = p.vr * W; // planet radius as fraction of canvas

    // Glow halo
    var halo = ctx.createRadialGradient(px, py, pr * 0.5, px, py, pr * 2.5);
    halo.addColorStop(0, _hexToRgba(p.glow, 0.10));
    halo.addColorStop(1, 'transparent');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(px, py, pr * 2.5, 0, Math.PI * 2); ctx.fill();

    // Saturn's rings — drawn BEHIND planet body on far side, IN FRONT on near side
    if (p.rings) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-0.4);
      // A-ring (outer)
      var ringGrad = ctx.createLinearGradient(-pr * 3, 0, pr * 3, 0);
      ringGrad.addColorStop(0, 'rgba(200,180,120,0.10)');
      ringGrad.addColorStop(0.3, 'rgba(210,190,140,0.35)');
      ringGrad.addColorStop(0.5, 'rgba(220,200,150,0.40)');
      ringGrad.addColorStop(0.7, 'rgba(210,190,140,0.35)');
      ringGrad.addColorStop(1, 'rgba(200,180,120,0.10)');
      ctx.strokeStyle = ringGrad;
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath(); ctx.ellipse(0, 0, pr * 2.8, pr * 0.75, 0, 0, Math.PI * 2); ctx.stroke();
      // B-ring (inner, brighter)
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.ellipse(0, 0, pr * 2.2, pr * 0.58, 0, 0, Math.PI * 2); ctx.stroke();
      // Cassini division (dark gap)
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.5 * dpr;
      ctx.beginPath(); ctx.ellipse(0, 0, pr * 2.5, pr * 0.66, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Planet body — sphere with directional lighting from sun
    var lightAngle = Math.atan2(py - cy, px - cx);
    var hlX = px - Math.cos(lightAngle) * pr * 0.3;
    var hlY = py - Math.sin(lightAngle) * pr * 0.3;
    var pg = ctx.createRadialGradient(hlX, hlY, 0, px, py, pr);
    pg.addColorStop(0, _lighten(p.color, 50));
    pg.addColorStop(0.4, p.color);
    pg.addColorStop(1, _darken(p.color, 70));
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();

    // Jupiter bands
    if (names[i] === 'Jupiter') {
      ctx.save();
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.clip();
      var bands = [-0.55, -0.25, 0.1, 0.4, 0.65];
      for (var bi = 0; bi < bands.length; bi++) {
        ctx.fillStyle = bi % 2 === 0 ? 'rgba(140,90,50,0.22)' : 'rgba(190,150,90,0.15)';
        ctx.fillRect(px - pr, py + bands[bi] * pr - pr * 0.06, pr * 2, pr * 0.12);
      }
      // Great Red Spot hint
      ctx.beginPath();
      ctx.ellipse(px + pr * 0.25, py + pr * 0.3, pr * 0.15, pr * 0.1, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(180,80,50,0.20)';
      ctx.fill();
      ctx.restore();
    }

    // Earth — blue with green hints and white polar
    if (names[i] === 'Earth') {
      ctx.save();
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(40,130,60,0.30)';
      ctx.beginPath(); ctx.ellipse(px - pr * 0.15, py - pr * 0.1, pr * 0.45, pr * 0.35, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(px + pr * 0.3, py + pr * 0.25, pr * 0.3, pr * 0.2, -0.2, 0, Math.PI * 2); ctx.fill();
      // Polar ice
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.ellipse(px, py - pr * 0.85, pr * 0.5, pr * 0.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Mars — rusty with polar cap
    if (names[i] === 'Mars') {
      ctx.save();
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.beginPath(); ctx.ellipse(px, py - pr * 0.8, pr * 0.3, pr * 0.15, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // The Earth glow: a slow breath around the Earth that invites the tap into
    // the Earth view, drawn only while that view exists.
    var glowR = 0;
    if (names[i] === 'Earth' && _orreryEarthViewAvailable()) {
      glowR = pr * _EARTH_GLOW_SCALE;
      var ga = _orreryEarthGlowAlpha(typeof performance !== 'undefined' && !_orreryReduceMotion() ? performance.now() : 0);
      var eg = ctx.createRadialGradient(px, py, pr, px, py, glowR);
      eg.addColorStop(0, _hexToRgba(p.glow, 0));
      eg.addColorStop(0.45, _hexToRgba(p.glow, ga));
      eg.addColorStop(1, _hexToRgba(p.glow, 0));
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(px, py, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, glowR * 0.62, 0, Math.PI * 2);
      ctx.strokeStyle = _hexToRgba(p.glow, ga);
      ctx.lineWidth = 0.8 * u; ctx.stroke();
      if (!_orreryTried().earth) {
        // Still when motion is reduced, and when the orrery is paused: no
        // next frame comes, and a ring caught fading out would stay unseen.
        var reduced = _orreryReduceMotion() || !_orreryPlaying;
        var bc = _orreryBeacon(typeof performance !== 'undefined' ? performance.now() : 0, reduced);
        ctx.beginPath(); ctx.arc(px, py, pr * bc.r, 0, Math.PI * 2);
        ctx.strokeStyle = _hexToRgba(p.glow, bc.a);
        ctx.lineWidth = 1.5 * u; ctx.stroke();
      }
    }

    // Record position for hover (world CSS px)
    var rec = { name: names[i], x: px / dpr, y: py / dpr, r: pr / dpr };
    if (glowR) rec.glowR = glowR / dpr;
    _orreryPlanetPositions.push(rec);

    // No labels — clean Apple Watch aesthetic, hover tooltip on desktop
  }

  // ── Interstellar probes — amber diamonds out past Neptune, revealed as the
  // view eases into deep space (z) where they have room to visibly crawl. ──
  _voyagerPositions = [];
  ctx.save();
  ctx.globalAlpha = z;
  for (var vi = 0; z > 0.02 && vi < _VOYAGERS.length; vi++) {
    var v = _VOYAGERS[vi];
    var dist = _voyagerDist(v, simTime);
    if (dist <= 0) continue; // pre-launch
    var angle = v.lon * DEG_TO_RAD;
    var visR = _orrR(dist, z) * W;
    var vx = cx + Math.cos(angle) * visR;
    // Match the planets' Y convention (cy − sin): the probes were mirrored
    // across the horizontal axis, plotting each one 2×longitude off.
    var vy = cy - Math.sin(angle) * visR;
    var vs = 2.5 * u;
    // Subtle amber glow
    var vGlow = ctx.createRadialGradient(vx, vy, 0, vx, vy, vs * 4);
    vGlow.addColorStop(0, 'rgba(255,180,60,0.15)');
    vGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = vGlow;
    ctx.beginPath(); ctx.arc(vx, vy, vs * 4, 0, Math.PI * 2); ctx.fill();
    // Diamond shape (rotated square)
    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#ffb83c';
    ctx.fillRect(-vs, -vs, vs * 2, vs * 2);
    ctx.restore();
    // Small label
    ctx.font = (8 * u) + 'px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,184,60,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText(v.label || ('V' + (vi + 1)), vx + vs * 2.5, vy + vs * 0.5);
    _voyagerPositions.push({ name: v.name, x: vx / dpr, y: vy / dpr, r: vs * 1.5 / dpr, dist: dist, idx: vi });
  }
  ctx.restore();

  // ── Draw Hohmann transfer orbits + rockets (supports multiple simultaneous) ──
  for (var ri = 0; ri < _orreryRockets.length; ri++) {
    var rk = _orreryRockets[ri];
    var progress = Math.min(1, rk.elapsed / rk.duration);

    // Smooth visual-space path (_orreryRidePolar): the orrery uses compressed
    // distances, so a physical Kepler ellipse looks warped; a cosine-eased
    // radius is tangent to both orbits at the ends, like a real transfer.
    var earthVisR = _orreryPlanetR('Earth', z) * W;
    var targetVisR = _orreryPlanetR(rk.target, z) * W;

    // Draw transfer path (fades after arrival)
    var pathAlpha = (rk.pathFade !== undefined ? rk.pathFade : 1) * 0.18;
    if (pathAlpha > 0.001) {
      ctx.save();
      ctx.setLineDash([4 * u, 6 * u]);
      ctx.strokeStyle = 'rgba(255,180,60,' + pathAlpha.toFixed(3) + ')';
      ctx.lineWidth = 1 * u;
      ctx.beginPath();
      for (var ai = 0; ai <= 80; ai++) {
        var pt = _orreryRideScreen(rk, ai / 80, earthVisR, targetVisR, cx, cy);
        if (ai === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // In-flight rocket
    if (!rk.arrived) {
      var rp = _orreryRideScreen(rk, progress, earthVisR, targetVisR, cx, cy);
      var rkX = rp.x, rkY = rp.y;

      // Trail
      rk.trail.push({ x: rkX, y: rkY, age: 0 });
      for (var ti = rk.trail.length - 1; ti >= 0; ti--) {
        rk.trail[ti].age++;
        if (rk.trail[ti].age > 80) rk.trail.splice(ti, 1);
      }
      for (var ti = 0; ti < rk.trail.length; ti++) {
        var dot = rk.trail[ti];
        var tAlpha = (1 - dot.age / 80) * 0.55;
        var tR2 = (1 - dot.age / 80) * 2.5 * u;
        ctx.beginPath(); ctx.arc(dot.x, dot.y, tR2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,180,60,' + tAlpha.toFixed(3) + ')';
        ctx.fill();
      }

      // Heading
      var rpPrev = _orreryRideScreen(rk, Math.max(0, progress - 0.005), earthVisR, targetVisR, cx, cy);
      var hdx = rkX - rpPrev.x, hdy = rkY - rpPrev.y;
      var heading = Math.atan2(-hdy, hdx);

      // Exhaust glow
      var exBX = rkX - Math.cos(heading) * 6 * u;
      var exBY = rkY + Math.sin(heading) * 6 * u;
      var exGlow = ctx.createRadialGradient(exBX, exBY, 0, exBX, exBY, 10 * u);
      exGlow.addColorStop(0, 'rgba(255,200,80,0.35)');
      exGlow.addColorStop(0.5, 'rgba(255,140,40,0.12)');
      exGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = exGlow;
      ctx.beginPath(); ctx.arc(exBX, exBY, 10 * u, 0, Math.PI * 2); ctx.fill();

      // Rocket body + flame
      ctx.save();
      ctx.translate(rkX, rkY);
      ctx.rotate(-heading + Math.PI / 2);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(0, -5 * u);
      ctx.lineTo(-2.2 * u, 3.5 * u);
      ctx.lineTo(2.2 * u, 3.5 * u);
      ctx.closePath();
      ctx.fill();
      var flameLen = (7 + Math.random() * 4) * u;
      ctx.fillStyle = 'rgba(255,160,40,0.85)';
      ctx.beginPath();
      ctx.moveTo(-1.5 * u, 3.5 * u); ctx.lineTo(0, flameLen); ctx.lineTo(1.5 * u, 3.5 * u);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,180,0.6)';
      ctx.beginPath();
      ctx.moveTo(-0.8 * u, 3.5 * u); ctx.lineTo(0, flameLen * 0.6); ctx.lineTo(0.8 * u, 3.5 * u);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      // No days label beside the rocket: the transit slider's readout, just
      // below the canvas, says the same (and the label sat on the trail).
    }

    // Arrived — orbiting target planet
    if (rk.arrived) {
      var targetPos = null;
      for (var pi = 0; pi < _orreryPlanetPositions.length; pi++) {
        if (_orreryPlanetPositions[pi].name === rk.target) { targetPos = _orreryPlanetPositions[pi]; break; }
      }
      if (targetPos) {
        var tpx = targetPos.x * dpr, tpy = targetPos.y * dpr;
        var glowColor = _PLANETS[rk.target] ? _PLANETS[rk.target].glow : '#ffffff';

        if (rk.arrivalGlow > 0) {
          var glowR = (targetPos.r * dpr + 25 * u) * rk.arrivalGlow;
          ctx.beginPath(); ctx.arc(tpx, tpy, glowR * 0.8, 0, Math.PI * 2);
          ctx.strokeStyle = _hexToRgba(glowColor, 0.4 * rk.arrivalGlow);
          ctx.lineWidth = 2 * u; ctx.stroke();
          var arrGlow = ctx.createRadialGradient(tpx, tpy, targetPos.r * dpr * 0.5, tpx, tpy, glowR);
          arrGlow.addColorStop(0, _hexToRgba(glowColor, 0.5 * rk.arrivalGlow));
          arrGlow.addColorStop(0.4, _hexToRgba(glowColor, 0.2 * rk.arrivalGlow));
          arrGlow.addColorStop(1, 'transparent');
          ctx.fillStyle = arrGlow;
          ctx.beginPath(); ctx.arc(tpx, tpy, glowR, 0, Math.PI * 2); ctx.fill();
          for (var si = 0; si < 8; si++) {
            var sa = (si / 8) * Math.PI * 2 + rk.arrivalGlow * 3;
            var sd = glowR * (0.5 + 0.5 * rk.arrivalGlow);
            ctx.beginPath(); ctx.arc(tpx + Math.cos(sa) * sd, tpy + Math.sin(sa) * sd, 1.5 * u * rk.arrivalGlow, 0, Math.PI * 2);
            ctx.fillStyle = _hexToRgba(glowColor, 0.6 * rk.arrivalGlow); ctx.fill();
          }
        }

        // Rocket orbits the planet — small circular orbit, no flame
        var orbitDist = (targetPos.r * dpr + 8 * u);
        var orbAngle = rk.orbitAngle || 0;
        var orbX = tpx + Math.cos(orbAngle) * orbitDist;
        var orbY = tpy + Math.sin(orbAngle) * orbitDist;

        ctx.beginPath(); ctx.arc(tpx, tpy, orbitDist, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 0.5 * u; ctx.stroke();

        var orbHeading = orbAngle + Math.PI / 2;
        ctx.save();
        ctx.translate(orbX, orbY);
        ctx.rotate(-orbHeading + Math.PI / 2);
        ctx.fillStyle = '#ddd';
        ctx.beginPath();
        ctx.moveTo(0, -4 * u);
        ctx.lineTo(-1.8 * u, 3 * u);
        ctx.lineTo(1.8 * u, 3 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  ctx.restore(); // the camera
}

var _orreryPlaying = true;

var _orrerySpeed = 100000;

var _orreryTimeOffset = 0;       // milliseconds offset from real time
// Whether the offset is a moment someone chose (the speed slider, a ride)
// rather than the orrery's own spin, which runs fast from the start as
// scenery. The Earth view opens on a chosen moment, and on now otherwise.
var _orreryClockChosen = false;
function _orreryAmbientOffset() { return _orreryClockChosen ? 0 : _orreryTimeOffset; }

var _orreryLastFrame = 0;        // last rAF timestamp

// ── Time-machine coupling ──
// The almanac's travel focus (_almFocus, almanac.js) outranks the orrery's
// local clock: while the lever is thrown — or the almanac is parked on any
// instant other than now — the planets must sit where the time machine says,
// not where the orrery's own speed control had wandered. Returning to now
// hands the local clock (offset + speed slider) back, untouched. (#48)
function _orreryTravelFocus() {
  return (typeof _almFocus !== 'undefined' && _almFocus) ? _almFocus : null;
}

// The one clock every orrery consumer reads (planet draw, rocket launches,
// the date readout, the Voyager card). Local time = real now plus whatever
// offset the speed slider has accumulated.
function _orrerySimTime() {
  var f = _orreryTravelFocus();
  return f ? f.getTime() : Date.now() + _orreryTimeOffset;
}

// Travel-tick visibility gate. The orrery lives well below the fold, so most
// scrubbing happens with it offscreen — measured in headless Chromium, gating
// those paints is the difference between 48fps and 60fps on a fast throw
// (_drawOrrery builds belt/ring gradients per frame). IntersectionObserver
// costs nothing per frame: no layout reads, just a flag flipped on scroll.
var _orreryInView = true;
var _orreryViewObs = null;

// Half-rate cap for travel repaints (~30Hz). _drawOrrery rebuilds belt/ring
// gradients every paint, and at full frame rate that alone dragged a fast
// throw from 60fps to ~33fps in headless profiling with the canvas on screen.
// At 30Hz the planet sweep still reads as continuous motion.
var _ORRERY_TRAVEL_TICK_MS = 28;

// Canvas-tier hook for _almTravelLive: while the orrery's own rAF loop runs it
// already repaints with the moving focus every frame (via _orrerySimTime), so
// this only paints when the loop is parked (speed at 1×) and the canvas is
// actually on screen — throttled via the shared travel throttle so the cadence
// resets on settle like every other tier. _orrerySyncToFocus paints the exact
// settled frame either way, so scrolling down after a throw never shows a
// stale sky.
function _orreryTravelTick() {
  if (_almanacOrreryRAF || !_orreryCanvas || !_orreryInView) return;
  _almTravelThrottled('orrery', _ORRERY_TRAVEL_TICK_MS, function () {
    _drawOrrery(_orreryCanvas, _orreryDpr);
  });
}

// Settle-time sync (called from _almRepaintFocus): reflect the travel verdict
// once, exactly — date readout, control availability, and a fresh frame even
// when the rAF loop is parked. The speed slider is disabled while the time
// machine owns the clock: under an override it would move nothing, and a dead
// control that looks alive is worse than one that says so.
function _orrerySyncToFocus() {
  var overridden = !!_orreryTravelFocus();
  var slider = document.getElementById('orrery-slider');
  if (slider) slider.disabled = overridden;
  var tSlider = document.getElementById('orrery-transit-slider');
  if (tSlider) tSlider.disabled = overridden;
  _orreryUpdateDate();
  if (!_almanacOrreryRAF && _orreryCanvas) _drawOrrery(_orreryCanvas, _orreryDpr);
}

// The orrery always shows the interstellar probes out past Neptune — the view
// sits at full "deep space" so they're always there and always creeping outward
// as the clock runs. (Kept as a factor, not a hard-coded scale, so the planet-
// vs-deep balance stays a one-line tuning knob.)
function _orreryDeepFactor() { return 1; }

// Planet orbit radius (fraction of half-width), blended between the hand-tuned
// planet view (_ORBIT_VIS) and the log deep-space map by the zoom factor z.
function _orreryPlanetR(name, z) {
  var near = _ORBIT_VIS[name] != null ? _ORBIT_VIS[name] : _auToVis(_PLANETS[name].a);
  return near * (1 - z) + _orrDeepRadius(_PLANETS[name].a) * z;
}

// Same blend for an arbitrary distance (rings, belts, probes): near-view uses
// the planet map (which pins everything past Neptune to the rim), deep uses log.
function _orrR(au, z) { return _auToVis(au) * (1 - z) + _orrDeepRadius(au) * z; }

var _orreryRockets = [];         // all rocket missions (in-flight + orbiting)

var _orreryAutoTransit = false;  // true when rocket launch controls speed profile

var _orreryCanvas = null;        // cached DOM refs for RAF loop

var _orrerySpeedLabel = null;

var _orrerySliderEl = null;

var _orreryDpr = 1;

// Hohmann transfer transit time in days
// Half-period of transfer ellipse: t = (T/2) where T = a^(3/2) years (Kepler's 3rd law)
function _hohmannDays(r1, r2) {
  return (365.25 / 2) * Math.pow((r1 + r2) / 2, 1.5);
}

function _transitEffectiveSpeed(rk) {
  var p = Math.max(0, Math.min(1, rk.elapsed / rk.duration));
  var rampUp = _smoothstep(0, 0.05, p);
  var rampDown = 1 - _smoothstep(0.95, 1.0, p);
  var blend = Math.min(rampUp, rampDown);
  return rk.departSpeed + blend * (rk.cruiseSpeed - rk.departSpeed);
}

function _orrerySliderInput(val) {
  _orreryClockChosen = true;
  _orreryAutoTransit = false; // Manual control disengages auto-transit
  var intVal = parseInt(val);
  // Manual input always wins — auto-transit was overwriting the slider
  // every frame, making speed unadjustable during a rocket flight.
  _orreryAutoTransit = false;
  _orrerySpeed = _sliderToSpeed(intVal);
  var label = document.getElementById('orrery-speed-label');
  if (label) label.textContent = _formatSpeed(_orrerySpeed);
  // Always animating — start if not already
  if (Math.abs(_orrerySpeed) > 1 && !_orreryPlaying) {
    _orreryPlaying = true;
    _orreryLastFrame = performance.now();
    _orreryAnimate();
  }
  // Back to 1× = stop fast-forwarding but keep real-time ticking
  if (Math.abs(_orrerySpeed) <= 1) {
    _orrerySpeed = 1;
    _orreryPlaying = false;
  }
}

function _orrerySetSlider(speed) {
  _orrerySpeed = speed;
  var slider = document.getElementById('orrery-slider');
  if (slider) slider.value = _speedToSlider(speed);
  var label = document.getElementById('orrery-speed-label');
  if (label) label.textContent = _formatSpeed(speed);
}

function _orrerySnapToNow() {
  _orreryAutoTransit = false;
  _orreryTimeOffset = 0;
  _orreryClockChosen = false;
  _orreryRockets = [];
  _orrerySetSlider(1);
  _orreryPlaying = false;
  var nowBtn = document.getElementById('orrery-now');
  if (nowBtn) nowBtn.style.display = 'none';
  _orreryShowTransit(false);
  _orreryUpdateDate();
  _orreryUpdateRide();
  _orreryCamReset();
  var canvas = document.getElementById('almanac-orrery');
  if (canvas) _drawOrrery(canvas, window.devicePixelRatio || 1);
}

function _orreryShowTransit(show) {
  var wrap = document.getElementById('orrery-transit-wrap');
  if (wrap) wrap.style.display = show ? 'flex' : 'none';
}

// Get the newest in-flight rocket (for transit slider control)
function _orreryGetActiveRocket() {
  for (var i = _orreryRockets.length - 1; i >= 0; i--) {
    if (!_orreryRockets[i].arrived) return _orreryRockets[i];
  }
  return null;
}

function _orreryTransitSlider(val) {
  var rk = _orreryGetActiveRocket();
  if (!rk) return;
  var frac = val / 1000;
  _orreryClockChosen = true;
  rk.elapsed = frac * rk.duration;
  var simLaunchTime = rk._launchRealTime || Date.now();
  _orreryTimeOffset = (simLaunchTime - Date.now()) + rk.elapsed;
  _orreryUpdateDate();
  _orreryUpdateTransitLabel();
  _orreryUpdateRide();
  if (!_orreryPlaying) {
    var canvas = document.getElementById('almanac-orrery');
    if (canvas) _drawOrrery(canvas, window.devicePixelRatio || 1);
  }
}

function _orreryUpdateTransitLabel() {
  var label = document.getElementById('orrery-transit-label');
  var slider = document.getElementById('orrery-transit-slider');
  var rk = _orreryGetActiveRocket();
  if (!label || !rk) return;
  // The ride panel just below names the ride's planet; the slider names its
  // own only when it holds an older rocket still in flight.
  var days = _orrFmtTransitDays(rk);
  label.textContent = rk === _orreryRide() ? days : _tp(rk.target) + ' · ' + days;
  if (slider) {
    slider.value = Math.round((rk.elapsed / rk.duration) * 1000);
  }
}

// The missions the ride panel does not describe: earlier rockets, still on
// their way or orbiting where they arrived. The ride (the newest) is the
// panel's, so a single flight lists nothing here.
function _orreryMissionHtml(rk) {
  var color = _PLANETS[rk.target] ? _PLANETS[rk.target].color : '#888';
  var html = '<div class="orrery-mission"><span style="color:' + color + '">●</span>';
  if (rk.arrived) return html + _almEsc(_tp(rk.target) + ' · ' + t('alm_orbiting')) + '</div>';
  var pct = Math.floor(Math.min(1, Math.max(0, rk.elapsed / rk.duration)) * 100);
  return html + _almEsc(t('alm_orr_ride_to', { planet: _tp(rk.target) })) +
    '<span class="orrery-mission-pct">' + _almEsc(_orrNum(pct, 'percent')) + '</span>' +
    '<span class="orrery-mission-days">' + _almEsc(_orrFmtTransitDays(rk)) + '</span></div>';
}

function _orreryUpdateMissions() {
  var el = document.getElementById('orrery-missions');
  if (!el) return;
  var html = '';
  for (var i = 0; i < _orreryRockets.length - 1; i++) html += _orreryMissionHtml(_orreryRockets[i]);
  // Called every frame: write only what changed.
  if (el._orrHtml !== html) { el.innerHTML = html; el._orrHtml = html; }
  el.style.display = html ? 'block' : 'none';
}

// ── The ride's readout and the twins (#orrery-ride, under the controls) ──
// Built once per ride panel and then only its text nodes change, so the twin
// slider keeps working while the readout updates every frame.
function _orreryRidePanelHtml() {
  var slider = Math.round(_orreryTwinBeta * _TWIN_SLIDER_STEPS_PER_C);
  var max = Math.round(_TWIN_MAX_BETA * _TWIN_SLIDER_STEPS_PER_C);
  return '<div class="orrery-ride-head"><span id="orrery-ride-where" class="orrery-ride-where"></span>' +
      '<span id="orrery-ride-dist" class="orrery-ride-dist"></span></div>' +
    '<div id="orrery-ride-delay" class="orrery-ride-delay"></div>' +
    '<div class="orrery-twin">' +
      '<div class="orrery-twin-head"><span class="orrery-twin-title">' + _lterm('twin_paradox', _almEsc(t('alm_orr_twin_title'))) + '</span>' +
        '<span class="orrery-twin-whatif">' + _almEsc(t('alm_orr_twin_whatif')) + '</span></div>' +
      '<div class="orrery-twin-ctl"><input id="orrery-twin-slider" type="range" min="0" max="' + max + '" value="' + slider + '"' +
        ' class="orrery-slider" aria-label="' + _almEsc(t('alm_orr_twin_whatif')) + '" oninput="_orreryTwinInput(this.value)" />' +
        '<span id="orrery-twin-speed" class="orrery-twin-speed"></span></div>' +
      '<div class="orrery-twin-clocks">' +
        '<div class="orrery-twin-clock"><span class="orrery-twin-lbl">' + _almEsc(t('alm_orr_twin_earth')) + '</span><span id="orrery-twin-earth" class="orrery-twin-val"></span></div>' +
        '<div class="orrery-twin-clock"><span class="orrery-twin-lbl">' + _almEsc(t('alm_orr_twin_ship')) + '</span><span id="orrery-twin-ship" class="orrery-twin-val"></span></div>' +
      '</div>' +
      '<div id="orrery-twin-note" class="orrery-twin-note"></div>' +
    '</div>';
}

function _orrSetText(id, s) {
  var e = document.getElementById(id);
  if (e && e.textContent !== s) e.textContent = s;
}

function _orreryUpdateRide() {
  var el = document.getElementById('orrery-ride');
  if (!el) return;
  var rk = _orreryRide();
  if (!rk) {
    if (el.style.display !== 'none') { el.style.display = 'none'; el.innerHTML = ''; }
    return;
  }
  if (!el.firstChild) el.innerHTML = _orreryRidePanelHtml();
  el.style.display = 'block';
  var st = _orreryRideStatus(rk);
  var arrived = st.frac >= 1;
  var planet = _tp(rk.target);
  var span = _orrFmtSpan(st.delay);
  _orrSetText('orrery-ride-where', t(arrived ? 'alm_orr_arrived' : 'alm_orr_ride_to', { planet: planet }));
  _orrSetText('orrery-ride-dist', t('alm_orr_au_from_earth', { d: _orrFmtAU(st.au) }));
  _orrSetText('orrery-ride-delay', t(arrived ? 'alm_orr_msg_home_now' : 'alm_orr_msg_home', { t: span }));
  var tw = _orreryTwinClocks(rk, _orreryTwinBeta, st.frac);
  _orrSetText('orrery-twin-speed', _orreryTwinBeta > 0
    ? t('alm_orr_twin_whatif_at', { v: _orrFmtBeta(_orreryTwinBeta) })
    : t('alm_orr_twin_real', { v: _orrNum(_orreryRealSpeedKmS(rk), 'kilometer-per-second') }));
  _orrSetText('orrery-twin-earth', _orrFmtSpan(tw.earth));
  _orrSetText('orrery-twin-ship', _orrFmtSpan(tw.ship));
  _orrSetText('orrery-twin-note', t('alm_orr_twin_explain', { g: _orrFmtGamma(tw.gamma), lag: _orrFmtSpan(_orreryShownLag(tw)) }));
}

function _orreryUpdateDate() {
  var el = document.getElementById('orrery-date');
  if (!el) return;
  var d = new Date(_orrerySimTime());
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var opts = { year: 'numeric', month: 'short', day: 'numeric' };
  el.textContent = d.toLocaleDateString(lang, typeof _almEraOpts === 'function' ? _almEraOpts(d, opts) : opts);
  // While the time machine owns the clock, its RETURN control is the honest
  // way back — a local "Now" would fight the almanac's focus, so hide it.
  var nowBtn = document.getElementById('orrery-now');
  if (nowBtn) nowBtn.style.display =
    (!_orreryTravelFocus() && Math.abs(_orreryTimeOffset) > MS_PER_DAY) ? '' : 'none';
}

function _orreryAnimate() {
  if (!_orreryPlaying || !_almanacOpen) {
    _almanacOrreryRAF = null;
    return;
  }
  var now = performance.now();
  var dt = now - _orreryLastFrame;
  _orreryLastFrame = now;

  // Time machine override: the focus IS the clock, so the local offset stops
  // accumulating and rockets hold their positions (suspend, never interpolate
  // across a scrub jump). The loop keeps painting — a moving focus then shows
  // up here every frame for free via _orrerySimTime.
  var _travelHeld = !!_orreryTravelFocus();

  // Auto-transit: modulate speed based on active rocket's flight progress
  if (_orreryAutoTransit && !_travelHeld) {
    var autoRk = _orreryGetActiveRocket();
    if (autoRk && !autoRk.arrived) {
      _orrerySpeed = _transitEffectiveSpeed(autoRk);
      if (_orrerySpeedLabel) _orrerySpeedLabel.textContent = _formatSpeed(_orrerySpeed);
      if (_orrerySliderEl) _orrerySliderEl.value = Math.min(_speedToSlider(_orrerySpeed), parseInt(_orrerySliderEl.max) || 60);
    }
  }

  // Advance simulated time
  if (!_travelHeld) _orreryTimeOffset += dt * _orrerySpeed;

  // Update all rocket missions
  var hasInFlight = false;
  if (_travelHeld) dt = 0;   // freeze mission clocks with the sim clock
  for (var ri = 0; ri < _orreryRockets.length; ri++) {
    var rk = _orreryRockets[ri];
    rk.elapsed += dt * _orrerySpeed;
    if (rk.elapsed < 0) rk.elapsed = 0;
    var prog = rk.elapsed / rk.duration;
    // Un-arrive if rewinding past arrival
    if (prog < 1 && rk.arrived) { rk.arrived = false; rk.pathFade = 1.0; }
    if (prog >= 1 && !rk.arrived) {
      rk.arrived = true;
      rk.arrivalGlow = 1.0;
      rk.orbitAngle = 0;
      rk.trail = [];
    }
    if (rk.arrived) {
      if (rk.arrivalGlow > 0) {
        rk.arrivalGlow -= dt / 1500;
        if (rk.arrivalGlow < 0) rk.arrivalGlow = 0;
      }
      if (rk.pathFade > 0) {
        rk.pathFade -= dt / 3000;
        if (rk.pathFade < 0) rk.pathFade = 0;
      }
      rk.orbitAngle += dt * 0.001;
    } else {
      hasInFlight = true;
    }
  }
  // Transit slider tracks the newest in-flight rocket
  var activeRocket = _orreryGetActiveRocket();
  if (activeRocket) {
    _orreryUpdateTransitLabel();
  }
  if (!hasInFlight && _orreryRockets.length > 0) {
    _orreryShowTransit(false);
    if (_orreryAutoTransit) {
      _orreryAutoTransit = false;
      _orrerySetSlider(100000); // Return to default speed after arrival
    }
  }

  _orreryUpdateDate();
  _orreryUpdateMissions();
  _orreryUpdateRide();

  if (_orreryCanvas) _drawOrrery(_orreryCanvas, _orreryDpr);

  // Live-update Voyager stats card if open
  if (_voyagerCardIdx >= 0) _updateVoyagerCard();

  // One loop, ever: a start while the loop runs (the Almanac opening, a
  // resume, a ride) takes over the frame already asked for instead of
  // asking for a second. Two ran: every frame drawn twice, and only one of
  // them stopped when the Earth view paused the Almanac, so the Earth's
  // clock ran on at the orrery's speed under a "Real time" label.
  if (_almanacOrreryRAF) cancelAnimationFrame(_almanacOrreryRAF);
  _almanacOrreryRAF = requestAnimationFrame(_orreryAnimate);
}

function _orreryLaunchRocket(targetName) {
  if (targetName === 'Earth') return;
  // No launches while the time machine holds the clock: the mission timer
  // would be frozen at the focus instant, leaving a rocket welded to Earth.
  // The tap still selects the planet, so its article stays one tap away.
  if (_orreryTravelFocus()) return;
  _orreryMarkTried('fly');

  var earthA = _PLANETS['Earth'].a;
  var targetA = _PLANETS[targetName].a;
  var transitDays = _hohmannDays(earthA, targetA);
  var transitMs = transitDays * MS_PER_DAY;

  // Compute launch and arrival positions
  var simNow = _orrerySimTime();
  var JD = _dateToJD(simNow);
  var T = _jdToJulianCentury(JD);
  var earthPos = _planetPosition('Earth', T);
  var launchAngle = Math.atan2(earthPos.y, earthPos.x);

  // Compute where the target planet will be at arrival time
  var arrivalJD = JD + transitDays;
  var T_arr = _jdToJulianCentury(arrivalJD);
  var targetPosArr = _planetPosition(targetName, T_arr);
  var arrivalAngle = Math.atan2(targetPosArr.y, targetPosArr.x);

  // Don't allow duplicate missions to the same planet
  for (var ri = _orreryRockets.length - 1; ri >= 0; ri--) {
    if (_orreryRockets[ri].target === targetName && !_orreryRockets[ri].arrived) {
      _orreryRockets.splice(ri, 1); // replace in-flight mission to same target
    }
  }
  // Speed profile: departure covers 2% of distance in ~1.5s, cruise covers 96% in ~9s
  var departSpeed = Math.max(10, Math.round(0.02 * transitMs / 1500));
  var cruiseSpeed = Math.max(departSpeed, Math.round(0.96 * transitMs / 9000));

  var rk = {
    target: targetName,
    earthOrbit: earthA,
    targetOrbit: targetA,
    duration: transitMs,
    elapsed: 0,
    launchAngle: launchAngle,
    arrivalAngle: arrivalAngle,
    outbound: targetA > earthA,
    arrived: false,
    arrivalGlow: 0,
    pathFade: 1.0,
    trail: [],
    _launchRealTime: simNow,
    departSpeed: departSpeed,
    cruiseSpeed: cruiseSpeed,
    // The ride's physics (AU): from Earth's distance from the Sun at launch to
    // the target's at arrival, and the straight line a what-if ship would fly.
    r0AU: earthPos.r,
    r1AU: targetPosArr.r,
    straightAU: _orreryDistanceFromEarthAU(targetName, simNow)
  };
  rk.pathAU = _orreryRidePathAU(rk);
  _orreryRockets.push(rk);
  _orreryShowTransit(true);
  _orreryUpdateTransitLabel();
  _orreryUpdateRide();

  // Enable auto-transit speed profile
  _orreryAutoTransit = true;
  _orreryClockChosen = true;
  if (!_orreryPlaying) {
    _orrerySpeed = departSpeed;
    _orrerySetSlider(departSpeed);
    _orreryPlaying = true;
    _orreryLastFrame = performance.now();
    _orreryAnimate();
  }
}

var _PLANET_V0 = { Mercury: -0.61, Venus: -4.40, Mars: -1.60, Jupiter: -9.40, Saturn: -8.88, Uranus: -7.19, Neptune: -6.87 };

var _VISIBLE_PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
