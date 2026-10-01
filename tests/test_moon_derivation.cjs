// One moon everywhere — derivation-equality gate.
//
// The hero disc (almanac.js), the sky-scene moon (almanac-sky.js) and the
// Today discover card (app.js) once each derived the disc's orientation their
// own way: the hero used -(chi - q) - 90, the Today card raw q, the sky scene
// +q — three different terminator angles for the same date. All three now
// draw the ONE canonical _moonView in app.js: a lunar-north-up sprite (phase,
// bright limb, libration) turned by its tilt. This test guards that
// unification two ways:
//
//   1. Functional: _heroMoonTiltDeg (almanac.js) must return exactly what
//      _moonScreenTiltDeg (app.js) returns, across a grid of dates and
//      observer locations including polar and equatorial edge cases.
//   2. Source-level: the sky scene, the hero and the Today card must reach
//      their view through _moonView — a reintroduced local derivation fails
//      the grep even if it happens to agree numerically today.
//
// Pure-helper approach, matching tests/test_almanac_tz_resolution.cjs: pull
// the functions straight out of the shipped sources by marker and eval them
// in a sandbox, so the test drives the shipped code rather than a copy.
//
// Run: node tests/test_moon_derivation.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const appSrc = fs.readFileSync(path.join(STATIC, 'app.js'), 'utf8');
const almSrc = fs.readFileSync(path.join(STATIC, 'almanac.js'), 'utf8');
const skySrc = fs.readFileSync(path.join(STATIC, 'almanac-sky.js'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

// Extract a top-level `function NAME(...) {...}` by brace matching.
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

const sandbox = { Math, Date, console };
vm.createContext(sandbox);
vm.runInContext('var _MOON_EQUATOR_TILT_DEG = 1.54242;', sandbox);
vm.runInContext(require('./moon_model.cjs')(), sandbox);   // the series _moonPhase and _moonEqCoords call
for (const name of ['_moonEqCoords', '_moonLimbAngles', '_moonLimbAnglesOf', '_moonAxisOf', '_moonView', '_normDeg360', '_moonScreenTiltDeg', '_moonIsWaxing', '_moonPhase']) {
  vm.runInContext(extractFn(appSrc, name), sandbox);
}
vm.runInContext(extractFn(almSrc, '_heroMoonView'), sandbox);
vm.runInContext(extractFn(almSrc, '_heroMoonTiltDeg'), sandbox);

// ── 1. Functional equality: hero delegates to the canonical derivation ──
const dates = [];
for (let y = 1980; y <= 2080; y += 7) dates.push(Date.UTC(y, (y * 5) % 12, 1 + (y % 27), (y * 3) % 24, 30));
dates.push(Date.UTC(2026, 7, 6, 4, 0));       // a real "tonight"
const locs = [
  { lat: 37.77, lon: -122.42 },  // San Francisco
  { lat: -33.87, lon: 151.21 },  // Sydney (southern hemisphere flips the view)
  { lat: 0, lon: 0 },            // equator, prime meridian
  { lat: 78.22, lon: 15.63 },    // Svalbard (polar)
  { lat: -89.9, lon: 45 },       // near south pole
  { lat: 34, lon: -120 }         // the synthetic default _getLocation falls back to
];
let worst = 0, finite = true;
for (const t of dates) {
  for (const loc of locs) {
    const d = new Date(t);
    const hero = vm.runInContext('_heroMoonTiltDeg(new Date(' + t + '), ' + JSON.stringify(Object.assign({ stored: true }, loc)) + ')', sandbox);
    const canon = vm.runInContext('_moonScreenTiltDeg(new Date(' + t + '), ' + loc.lat + ', ' + loc.lon + ')', sandbox);
    if (!isFinite(hero) || !isFinite(canon)) finite = false;
    worst = Math.max(worst, Math.abs(hero - canon));
  }
}
check(finite, 'tilt is finite at every date/location including polar');
check(worst === 0, 'hero tilt === canonical tilt exactly (worst delta ' + worst + ' deg)');

// Waxing predicate agrees with the phase convention (phase < 0.5 = waxing).
const wax1 = vm.runInContext('_moonIsWaxing({ phase: 0.25 })', sandbox);
const wax2 = vm.runInContext('_moonIsWaxing({ phase: 0.75 })', sandbox);
check(wax1 === true && wax2 === false, '_moonIsWaxing follows the phase < 0.5 convention');

// ── 2. Source-level: every renderer reaches the canonical helpers ──
check(/_moonView\(now, lat, lon\)/.test(extractFn(skySrc, '_skyFrame')),
  'sky scene derives its view via _moonView');
check(!/parallactic/.test(extractFn(skySrc, '_drawSkyScene')),
  'sky draw no longer rotates by the parallactic angle');
check(/_moonSpriteCanvas\(view,/.test(extractFn(skySrc, '_drawSkyScene')),
  'sky draw shades the canonical view');
check(/_moonView\(date, ll\.lat, ll\.lon\)/.test(extractFn(appSrc, "_quickMoonView")),
  'Today card (_quickMoonView) delegates to _moonView');
check(/_moonView\(date, loc\.lat, loc\.lon\)/.test(extractFn(almSrc, '_heroMoonView')),
  'hero (_heroMoonView) delegates to _moonView');
check(/_moonEqCoords\(date\)/.test(extractFn(almSrc, '_moonPosition')),
  '_moonPosition consumes the canonical _moonEqCoords elements');

// ── 3. Physical sanity of the canonical derivation ──
// Near full moon the illumination must be ~100 and near new ~0 (ties the
// sprite's lit fraction to the same _moonPhase all readouts use).
const full = vm.runInContext('_moonPhase(new Date(Date.UTC(2026, 0, 3, 10, 0)))', sandbox); // full moon Jan 3 2026
const nw = vm.runInContext('_moonPhase(new Date(Date.UTC(2026, 0, 18, 19, 0)))', sandbox);  // new moon Jan 18 2026
check(full.illumination > 97, 'known full moon reads > 97% (' + full.illumination + '%)');
check(nw.illumination < 3, 'known new moon reads < 3% (' + nw.illumination + '%)');

// ── 4. CORRECTNESS, not just agreement ──────────────────────────────────────
//
// Everything above checks that the four renderers compute the SAME tilt. They
// did, and it was wrong for half of every month (issue #60): the sprite shades
// from a Sun vector already flipped by the waxing flag, and chi carries that
// same flip, so every waning moon was turned a further 180 degrees. The lit
// limb sat on the wrong side and the maria were upside down. Four renderers
// agreeing on one wrong number is exactly what a consistency test cannot see.
//
// The invariant with a known answer: put the Moon on the observer's meridian
// at a quarter phase. The Sun is then roughly 90 degrees away along the
// horizon, so the lit limb lies close to horizontal: the sprite's limb less
// the disc's tilt is near 90 or 270 from up. True at BOTH quarters.
function haDeg(t, lon) {
  const eq = vm.runInContext('_moonEqCoords(new Date(' + t + '))', sandbox);
  const gmst = (280.46061837 + 360.98564736629 * (eq.JD - 2451545.0)) % 360;
  let ha = ((gmst + lon) - eq.ra * 180 / Math.PI) % 360;
  if (ha > 180) ha -= 360;
  if (ha < -180) ha += 360;
  return ha;
}
function phaseAt(t) {
  return vm.runInContext('_moonPhase(new Date(' + t + '))', sandbox).phase;
}
function nearestMeridianQuarter(target, lon) {
  let best = null;
  for (let m = 0; m < 70 * 24 * 60; m += 10) {
    const t = Date.UTC(2026, 8, 1) + m * 60000;
    const score = Math.abs(haDeg(t, lon)) + Math.abs(phaseAt(t) - target) * 720;
    if (!best || score < best.score) best = { t, score };
  }
  return best.t;
}
for (const [label, target] of [['first quarter (waxing)', 0.25],
                               ['last quarter (waning)', 0.75]]) {
  for (const loc of [{ lat: 51.5, lon: -0.12 }, { lat: 40.7, lon: -74.0 }]) {
    const t = nearestMeridianQuarter(target, loc.lon);
    const v = vm.runInContext(
      '_moonView(new Date(' + t + '), ' + loc.lat + ', ' + loc.lon + ')', sandbox);
    const lit = ((v.limb - v.tilt) % 360 + 360) % 360;
    const want = target < 0.5 ? 270 : 90;     // waxing lit on the right (west), waning left
    check(Math.abs(lit - want) < 45 && Math.abs(v.tilt) < 45,
      label + ' on the meridian at lat ' + loc.lat + ': lit limb ' + lit.toFixed(1) +
      ' from up (want ~' + want + '), lunar north near up (tilt ' + v.tilt.toFixed(1) + ')');
  }
}

// The tilt never steps: it is the pole's turn (q - P), continuous, and the
// side the Sun lights is the sprite's own limb angle. (It once turned over by
// 180 degrees at new and full, a waning correction for a sprite that could
// only be lit from 3 or 9 o'clock.)
const steps = [];
let prevTilt = null;
for (let m = 0; m < 30 * 24 * 60; m += 5) {
  const t = Date.UTC(2026, 8, 1) + m * 60000;
  const v = vm.runInContext('_moonScreenTiltDeg(new Date(' + t + '), 51.5, -0.12)', sandbox);
  if (prevTilt !== null) {
    let d = v - prevTilt;
    d = ((d % 360) + 540) % 360 - 180;
    if (Math.abs(d) > 5) steps.push(vm.runInContext('_moonPhase(new Date(' + t + '))', sandbox).illumination);
  }
  prevTilt = v;
}
check(steps.length === 0,
  'the tilt is continuous through a month (' + steps.length + ' steps, at ' + steps.join('%, ') + '% lit)');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all moon derivation checks passed');
