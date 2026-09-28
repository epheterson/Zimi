// The orrery's flight: radio delay on hover, the ride, the twin paradox, and
// the Earth glow.
//
// What this locks in, executed from the shipped almanac-orrery.js:
//   1. Light travel time from the named constants: 1 AU is ~499 s (8 min 19 s),
//      the Sun's light is 490.7 s old at perihelion and 507.3 s at aphelion.
//   2. Mars's radio delay, from the orrery's own planet positions, spans the
//      known 3 to 22 minutes (2003's close approach at the bottom).
//   3. The Lorentz factor and the twins against textbook values (0.6c gives
//      1.25; Proxima at 0.9c is 4.7 years at home and about 2 aboard), and a
//      real rocket's ~1e-9 difference survives floating point.
//   4. A tapped planet still launches its transit with the same semantics
//      (Earth never, never under the time machine, one mission per target),
//      now carrying the ride's physics; the ride starts at Earth and arrives
//      where the target is.
//   5. Taps: a click flies, a first touch shows the info and a second flies,
//      Earth and its glow open the Earth view only when it exists, and the
//      glow is drawn only then.
//
// Run: node tests/test_orrery_flight.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const orrSrc = fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8');
const almSrc = fs.readFileSync(path.join(STATIC, 'almanac.js'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces extracting ' + name);
}
function extractVar(src, name) {
  const m = new RegExp('^var ' + name + ' =([^;]*);', 'm').exec(src);
  if (!m) throw new Error('var ' + name + ' not found');
  return 'var ' + name + ' =' + m[1] + ';';
}

// A 2D context that accepts every call; gradients take colour stops.
function fakeCtx() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

const S = {
  Math, Date, Intl, Object, JSON, console, String, Number, Proxy,
  performance: { now: () => 1000 },
  requestAnimationFrame: () => 0,
  window: {},
  document: { getElementById: () => null },
};
vm.createContext(S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5, JD_J2000 = 2451545.0, MS_PER_DAY = 86400000, JULIAN_CENTURY = 36525;' +
  'var DEG_TO_RAD = Math.PI / 180; var _almanacOpen = false; var _almFocus = null; var _currentLang = "en";' +
  'var _voyagerPositions = [];' +
  'function t(k, vars) { var s = k; if (vars) for (var v in vars) s += "|" + v + "=" + vars[v]; return s; }' +
  'function _tp(n) { return n; }' +
  'function _almEsc(s) { return String(s); }' +
  'function _lterm(k, h) { return h; }' +
  'function _showVoyagerCard() {}', S);
for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_orrDeepRadius', '_voyagerDist',
                  '_parseHex', '_hexToRgba', '_lighten', '_darken']) {
  vm.runInContext(extractFn(almSrc, fn), S);
}
for (const v of ['_VOYAGERS', '_HELIO_TERMINATION_AU', '_HELIOPAUSE_AU', '_KUIPER_INNER_AU', '_ORBIT_VIS']) {
  vm.runInContext(extractVar(almSrc, v), S);
}
const auToVis = extractFn(almSrc, '_auToVis');
vm.runInContext(almSrc.slice(almSrc.indexOf('var _AU_VIS_X'), almSrc.indexOf(auToVis) + auToVis.length), S);
vm.runInContext(orrSrc, S);
const run = (code) => vm.runInContext(code, S);

const DAY_MS = 86400000;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);

// ── 1. Light travel time ────────────────────────────────────────────────
check(near(run('LIGHT_SECONDS_PER_AU'), 499.004784, 1e-6), 'one AU of light travel is 499.004784 s (from c and the AU)');
check(run('_orrFmtSpan(_lightDelaySeconds(1))') === '8 min 19 sec', '1 AU reads "8 min 19 sec"');
const sunPeri = run('_lightDelaySeconds(_orreryDistanceFromEarthAU("Sun", ' + utc(2026, 1, 3) + '))');
const sunAph = run('_lightDelaySeconds(_orreryDistanceFromEarthAU("Sun", ' + utc(2026, 7, 6) + '))');
check(near(sunPeri, 490.7, 0.5), 'the Sun\'s light at perihelion (0.9833 AU) is 490.7 s old, got ' + sunPeri.toFixed(2));
check(near(sunAph, 507.3, 0.5), 'the Sun\'s light at aphelion (1.0167 AU) is 507.3 s old, got ' + sunAph.toFixed(2));

// ── 2. Mars: 3 to 22 minutes ────────────────────────────────────────────
let lo = Infinity, hi = 0;
for (let ms = utc(2000, 1, 1); ms < utc(2050, 1, 1); ms += DAY_MS) {
  const s = run('_lightDelaySeconds(_orreryDistanceFromEarthAU("Mars", ' + ms + '))');
  lo = Math.min(lo, s); hi = Math.max(hi, s);
}
check(lo >= 3 * 60 && lo < 3.3 * 60, 'Mars\'s shortest delay 2000-2050 is just over 3 min, got ' + (lo / 60).toFixed(2));
check(hi > 21.8 * 60 && hi <= 22.5 * 60, 'Mars\'s longest delay 2000-2050 is about 22 min, got ' + (hi / 60).toFixed(2));
const mars2003 = run('_orreryDistanceFromEarthAU("Mars", ' + utc(2003, 8, 27) + ')');
check(near(mars2003, 0.3727, 0.0037), 'Mars on 2003-08-27 is 0.3727 AU away (within 1%), got ' + mars2003.toFixed(4));
const mars2025 = run('_orreryDistanceFromEarthAU("Mars", ' + utc(2025, 1, 12) + ')');
check(near(mars2025, 0.6423, 0.0064), 'Mars on 2025-01-12 is 0.6423 AU away (within 1%), got ' + mars2025.toFixed(4));

// ── 3. Lorentz factor and the twins ─────────────────────────────────────
check(run('_lorentzFactor(0)') === 1, 'gamma is 1 at rest');
check(near(run('_lorentzFactor(0.6)'), 1.25, 1e-12), 'gamma(0.6c) = 1.25');
check(near(run('_lorentzFactor(0.8)'), 5 / 3, 1e-12), 'gamma(0.8c) = 5/3');
check(near(run('_lorentzFactor(0.9)'), 2.294157, 1e-6), 'gamma(0.9c) = 2.294157');
check(near(run('_lorentzFactor(0.99)'), 7.088812, 1e-6), 'gamma(0.99c) = 7.088812');
const LY_AU = 63241.077;
const proxEarth = run('_tripSecondsAtBeta(' + 4.2465 * LY_AU + ', 0.9)') / run('SECONDS_PER_JULIAN_YEAR');
const proxShip = run('_properTime(' + proxEarth + ', 0.9)');
check(near(proxEarth, 4.72, 0.01), 'Proxima at 0.9c: 4.7 years on Earth, got ' + proxEarth.toFixed(3));
check(near(proxShip, 2.06, 0.01), 'Proxima at 0.9c: about 2 years aboard, got ' + proxShip.toFixed(3));
// A real rocket: beta ~1e-4. The lag must match beta^2/2 + beta^4/8 (series),
// which the naive sec * (1 - sqrt(1 - beta^2)) gets wrong in the 8th digit.
const beta = 8.75e-5, sec = 2.237e7;
const series = sec * (beta * beta / 2 + Math.pow(beta, 4) / 8);
const lag = run('_timeDilationLag(' + sec + ', ' + beta + ')');
check(Math.abs(lag - series) / series < 1e-12, 'a real rocket\'s twin lag keeps full precision (' + lag.toExponential(6) + ' s)');
check(run('_orrFmtGamma(_lorentzFactor(0.9))') === '2.29', 'gamma 2.294 reads "2.29"');
check(run('_orrFmtGamma(1.0000000038)') === '1.0000000038', 'a real rocket\'s gamma shows its first digits past the 1');
check(run('_orrFmtSpan(760)') === '12 min 40 sec', '760 s reads "12 min 40 sec"');
check(run('_orrFmtSpan(0.0857)') === '86 ms', 'under a second reads in ms');
check(run('_orrFmtSpan(258.9 * SECONDS_PER_DAY)') === '259 days', 'a Mars transfer reads "259 days"');
check(run('_orrFmtSpan(59.6)') === '1 min', '59.6 s reads "1 min", not "60 sec"');
// The twins' difference is checked by subtraction, so rounding a span to its
// shown step must never change how it reads.
const spans = [0.0004, 0.5, 3.26, 9.96, 44.6, 59.6, 404.9, 929.6, 3725, 20000, 86400 * 3.4, 86400 * 258.7, 86400 * 400, 9.7e8];
const drift = spans.filter((x) => run('_orrFmtSpan(_orrSpanRound(' + x + ')) !== _orrFmtSpan(' + x + ')'))
  .map((x) => x + ': ' + run('_orrFmtSpan(' + x + ')') + ' -> ' + run('_orrFmtSpan(_orrSpanRound(' + x + '))'));
check(drift.length === 0, 'rounding a span to its shown step never changes how it reads ' + JSON.stringify(drift));
const shown = run('_orreryShownLag({ earth: 929.6, ship: 404.9, lag: 524.7 })');
check(shown === 525, 'the twins\' lag is the difference of the clocks as shown (15:30 - 6:45 = 8:45), got ' + shown);
check(run('_orreryShownLag({ earth: 2.237e7, ship: 2.237e7 - 0.0857, lag: 0.0857 })') === 0.0857,
  'when both clocks read the same, the lag is the exact one');

// ── 4. A tapped planet still launches its transit ───────────────────────
run('_orreryRockets = []; _orreryPlaying = true; _almFocus = null;');
run('_orreryLaunchRocket("Earth")');
check(run('_orreryRockets.length') === 0, 'Earth never launches (the rockets leave from it)');
run('_almFocus = new Date(' + utc(2100, 6, 1) + '); _orreryLaunchRocket("Mars"); _almFocus = null;');
check(run('_orreryRockets.length') === 0, 'no launch while the time machine holds the clock');
run('_orreryLaunchRocket("Mars")');
const rk = run('_orreryRockets[0]');
check(run('_orreryRockets.length') === 1 && rk.target === 'Mars', 'a Mars transit launches');
check(near(rk.duration / DAY_MS, 258.9, 0.5), 'its duration is the Hohmann transfer, 259 days, got ' + (rk.duration / DAY_MS).toFixed(1));
check(rk.outbound === true && rk.arrived === false && rk.elapsed === 0, 'outbound, in flight, at the start');
check(run('_orreryAutoTransit') === true, 'the auto-transit speed profile engages');
check(near(rk.r0AU, 1, 0.02) && rk.r1AU > 1.38 && rk.r1AU < 1.67, 'the ride runs from Earth\'s orbit to Mars\'s');
check(near(rk.straightAU, run('_orreryDistanceFromEarthAU("Mars", ' + rk._launchRealTime + ')'), 1e-12),
  'the what-if distance is Mars\'s distance from Earth at launch');
check(rk.pathAU > rk.straightAU, 'the transfer path is longer than the straight line');
run('_orreryLaunchRocket("Mars")');
check(run('_orreryRockets.length') === 1, 'a second Mars launch replaces the one in flight');

// The ride starts at Earth, the delay home grows, and it arrives at the target.
const at = (frac) => run('(function(){ var r = _orreryRockets[0]; r.elapsed = ' + frac + ' * r.duration; return _orreryRideStatus(r); })()');
const s0 = at(0), sMid = at(0.5), s1 = at(1);
check(s0.au < 1e-6 && s0.delay < 1e-3, 'at launch the rocket is at Earth (no delay home)');
check(sMid.delay > s0.delay && sMid.au > 0.2, 'halfway, the delay home has grown');
const r1 = run('_orreryRockets[0]');
const arriveMs = r1._launchRealTime + r1.duration;
const marsAtArrival = run('_orreryDistanceFromEarthAU("Mars", ' + arriveMs + ')');
check(near(s1.au, marsAtArrival, 1e-9), 'at arrival the message home travels Mars\'s distance from Earth then');

// The twins on this ride.
const real = run('_orreryTwinClocks(_orreryRockets[0], 0, 1)');
check(real.gamma > 1 && real.gamma - 1 < 1e-7, 'the real rocket\'s gamma is barely above 1');
check(real.lag > 0.01 && real.lag < 1, 'the real crew ages about a tenth of a second less, got ' + real.lag.toFixed(4) + ' s');
check(near(real.earth, r1.duration / 1000, 1e-6), 'the real trip takes the transfer time on Earth\'s clock');
const fast = run('_orreryTwinClocks(_orreryRockets[0], 0.99, 1)');
check(near(fast.earth, r1.straightAU * 499.004784 / 0.99, 1e-3), 'at 0.99c the trip takes the light time / 0.99 on Earth\'s clock');
check(near(fast.ship, fast.earth / 7.088812, 1e-3), 'and 7.09 times less on the ship\'s');
check(run('_twinSliderToBeta(99)') === 0.99 && run('_twinSliderToBeta(150)') === 0.99 && run('_twinSliderToBeta(0)') === 0,
  'the speed control tops out at 0.99c; 0 is the real rocket');

// ── 5. Taps ─────────────────────────────────────────────────────────────
run('_orreryCanvas = { clientWidth: 400, width: 400 }; _orreryDpr = 1; _orreryCamReset();');
run('_orrerySunPos = { x: 200, y: 200, r: 8 };');
run('_orreryPlanetPositions = [{ name: "Mars", x: 100, y: 100, r: 5 }, { name: "Earth", x: 300, y: 300, r: 5, glowR: 13 }];');
run('_orreryRockets = []; _orrerySelectedKey = null;');
let res = run('_orreryTap(100, 100, 10, false)');
check(res.action === 'fly' && run('_orreryRockets.length') === 1, 'a click on a planet flies, as before');
run('_orreryRockets = []; _orrerySelectedKey = null;');
res = run('_orreryTap(100, 100, 14, true)');
check(res.action === 'info' && run('_orreryRockets.length') === 0, 'a first touch shows the info and does not launch');
res = run('_orreryTap(100, 100, 14, true)');
check(res.action === 'fly' && run('_orreryRockets.length') === 1, 'a second touch flies');
res = run('_orreryTap(200, 200, 14, true)');
check(res.action === 'info' && res.hit.type === 'sun', 'a first touch on the Sun shows its light delay');

run('_orreryRockets = []; _orrerySelectedKey = null;');
check(run('_orreryEarthViewAvailable()') === false, 'without almanac-earth.js there is no Earth view');
res = run('_orreryTap(300, 300, 10, false)');
check(res.action === 'link', 'Earth without the view opens its article, as before');
let opened = 0;
S.window.openAlmanacEarth = () => { opened++; };
res = run('_orreryTap(300, 300, 10, false)');
check(res.action === 'earth' && opened === 1, 'Earth with the view opens it');
res = run('_orreryTap(311, 300, 2, true)');
check(res && res.action === 'earth' && opened === 2, 'a tap on the glow (outside the disc) opens it too');
run('_orreryPlanetPositions.push({ name: "Venus", x: 312, y: 300, r: 4 });');
res = run('_orreryTap(311, 300, 2, false)');
check(res.hit.data.name === 'Venus', 'a neighbour\'s disc wins over Earth\'s glow');

// The glow is drawn only while the Earth view exists; the camera draw runs.
const canvas = { width: 400, height: 400, clientWidth: 400, getContext: () => fakeCtx() };
run('_orreryRockets = [];');
S.__canvas = canvas;
delete S.window.openAlmanacEarth;
run('_drawOrrery(__canvas, 1)');
const earthNo = run('_orreryPlanetPositions.filter(function (p) { return p.name === "Earth"; })[0]');
check(earthNo && !earthNo.glowR, 'no Earth view: no glow and no glow hit zone');
S.window.openAlmanacEarth = () => {};
run('_drawOrrery(__canvas, 1)');
const earthYes = run('_orreryPlanetPositions.filter(function (p) { return p.name === "Earth"; })[0]');
check(earthYes && earthYes.glowR > earthYes.r, 'with the Earth view: a glow wider than the Earth');

// The camera follows a ride and rests at the whole system otherwise.
run('_orreryCamReset(); _orreryLaunchRocket("Jupiter"); _orreryRockets[0].elapsed = _orreryRockets[0].duration / 2;');
const tgt = run('_orreryCamTarget(_orreryDeepFactor(), 0)');
check(tgt.zoom > 1 && !(tgt.x === 0.5 && tgt.y === 0.5), 'on a ride the camera centres the rocket and zooms in');
run('_orreryRockets = [];');
const rest = run('_orreryCamTarget(_orreryDeepFactor(), 0)');
check(rest.zoom === 1 && rest.x === 0.5 && rest.y === 0.5, 'with no ride the camera rests on the whole system');
const round = run('(function(){ _orreryCam = { x: 0.4, y: 0.6, zoom: 2.5 }; var w = _orreryScreenToWorld(123, 321); return _orreryWorldToScreen(w.x, w.y); })()');
check(near(round.x, 123, 1e-9) && near(round.y, 321, 1e-9), 'screen and world coordinates round-trip through the camera');

process.exit(failures ? 1 : 0);
