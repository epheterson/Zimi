// The Moon's face as seen: which way its north pole points and which point of
// it faces us (app.js _moonView / _moonAxisOf, Meeus ch. 53), and that the 3D
// view's Moon stands the same way.
//
// Every Moon the Almanac draws is the same LRO map projected as seen: the
// hero disc and the Today card draw it lunar north up and turn it by the pole's
// position angle P (less the parallactic angle q at a chosen place); the 3D
// view sets its sphere's pole and prime meridian from the same answer.
//
//   1. P, l, b against JPL Horizons (DE441; Moon 301 from geocentre 500@399,
//      quantities 14 ObsSub-LON/LAT and 17 NP.ang, fetched 2026-09-30), and
//      Meeus's worked Example 53.a (1992 April 12: P 15.08, l -1.206,
//      b +4.194). The shipped low-precision Moon series must land within
//      1 degree.
//   2. The sprite's terminator: its bright limb, turned by the disc's tilt,
//      lies at chi - q from up (the geometry test_moon_orientation checks
//      against DE421), so for Eric's photo (2026-09-30 07:26 UTC, Los
//      Angeles) the dark limb is at the upper right.
//   3. The 3D view's Moon: its pole's position angle from the Earth is P and
//      the point of it facing the Earth is (l, b), within 1 degree.
//
// Before this, the hero rotated a photo of the full Moon so its lit limb
// faced the Sun: the terminator was right and the maria were turned by
// whatever the limb angle happened to be, up to 90 degrees off near new and
// full, and the 3D Moon's pole lay along the ecliptic's with no libration.
//
// Run: node tests/test_moon_face.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const appSrc = read('app.js');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
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

const S = { Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, window: {}, document: { getElementById: () => null } };
vm.createContext(S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180; var _MOON_EQUATOR_TILT_DEG = 1.54242;' +
  'var _MOON_SYNODIC_MS = 29.530588853 * 86400000; var _MOON_ANIM_MAX_CYCLES = 3;' +
  'function t(k) { return k; }', S);
for (const fn of ['_moonEqCoords', '_moonLimbAngles', '_moonLimbAnglesOf', '_normDeg360', '_moonAxisOf', '_moonView',
  '_moonScreenTiltDeg', '_moonIsWaxing', '_moonPhase', '_moonAnimPhaseAt', '_moonAnimViewAt'])
  vm.runInContext(extractFn(appSrc, fn), S);
for (const fn of ['_dateToJD', '_jdnToGregorian', '_cnDeltaTdays', '_almEsc'])
  vm.runInContext(extractFn(read('almanac.js'), fn), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(require('./moon_model.cjs')(), S);   // app.js's Moon model, which the shader is written from
vm.runInContext(read('almanac-earth.js'), S);

const diff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const TOL = 1;
// Horizons ObsSub-LON is east-positive 0..360; l is -180..180.
const CASES = [
  { name: "Eric's photo, 2026-09-30 07:26 UTC", ms: Date.UTC(2026, 8, 30, 7, 26), P: 345.3327, l: 358.020499, b: -6.662454 },
  { name: '2026-01-10 03:00 UTC', ms: Date.UTC(2026, 0, 10, 3, 0), P: 21.6473, l: 5.622164, b: 3.699253 },
  { name: '2027-05-12 09:00 UTC', ms: Date.UTC(2027, 4, 12, 9, 0), P: 14.2938, l: 2.230967, b: -0.552005 },
  { name: 'Meeus Example 53.a, 1992-04-12 0h', ms: Date.UTC(1992, 3, 12, 0, 0), P: 15.08, l: -1.206, b: 4.194 },
];

// ── 1. P, l, b ──
for (const c of CASES) {
  const v = S._moonView(new Date(c.ms), null, null);
  console.log('   ' + c.name + ': P ' + v.P.toFixed(2) + ' (ref ' + c.P + '), l ' + v.l.toFixed(2) +
    ' (ref ' + (((c.l + 180) % 360) - 180).toFixed(2) + '), b ' + v.b.toFixed(2) + ' (ref ' + c.b + ')');
  check(diff(v.P, c.P) < TOL, c.name + ': pole position angle P within ' + TOL + ' deg');
  check(diff(v.l, c.l) < TOL, c.name + ': libration in longitude within ' + TOL + ' deg');
  check(Math.abs(v.b - c.b) < TOL, c.name + ': libration in latitude within ' + TOL + ' deg');
}

// ── 2. The sprite's terminator and turn ──
// The sprite is lunar north up with its bright limb at `limb` counterclockwise
// from the pole; CSS rotation (tilt) runs clockwise. So the lit limb stands
// limb - tilt counterclockwise from up, which must be chi - q.
{
  const ms = CASES[0].ms, lat = 34.05, lon = -118.25;
  const v = S._moonView(new Date(ms), lat, lon);
  const ang = S._moonLimbAngles(new Date(ms), lat, lon);
  const litFromUp = S._normDeg360(v.limb - v.tilt);
  const poleFromUp = S._normDeg360(-v.tilt);
  const darkClockwise = S._normDeg360(-(litFromUp + 180));
  console.log('   hero, Los Angeles: P ' + v.P.toFixed(1) + ', q ' + v.q.toFixed(1) + ', chi ' + v.chi.toFixed(1) +
    ', lunar north ' + poleFromUp.toFixed(1) + ' ccw from up, lit limb ' + litFromUp.toFixed(1) +
    ' ccw, dark limb ' + darkClockwise.toFixed(1) + ' cw from up, ' + (v.k * 100).toFixed(1) + '% lit');
  check(diff(litFromUp, ang.rot) < 1e-9, 'the sprite, turned, puts the lit limb at chi - q');
  check(darkClockwise > 15 && darkClockwise < 75, "the dark limb is at the upper right, as in Eric's photo");
  check(diff(poleFromUp, v.P - v.q) < 1e-9, 'lunar north stands P - q counterclockwise from the zenith');
  const n = S._moonView(new Date(ms), null, null);
  check(diff(-n.tilt, n.P) < 1e-9 && n.q === 0, 'no place: celestial north up, the pole at P');
  check(S._moonScreenTiltDeg(new Date(ms), lat, lon) === v.tilt, '_moonScreenTiltDeg is the view\'s tilt');
  // A waning Moon is not turned upside down any more: the sprite's limb
  // carries the side, the tilt only the pole.
  for (let d = 0; d < 30; d++) {
    const w = S._moonView(new Date(ms + d * 86400000), lat, lon);
    if (diff(w.tilt, w.q - w.P) > 1e-9) { check(false, 'day ' + d + ': tilt is q - P'); break; }
  }
  // The travel sweep's view is the real Moon at the real instant.
  const mid = S._moonAnimViewAt(ms, ms + 10 * 86400000, 0.5);
  const real = S._moonView(new Date(ms + 5 * 86400000), null, null);
  check(mid.limb === real.limb && mid.l === real.l && mid.k === real.k, 'a sweep draws the real Moon at the midpoint');
}

// ── 3. The 3D view's Moon ──
for (const c of CASES) {
  const sc = S._aeSceneAt(c.ms);
  const m = S._aeMoonBasis(sc);
  const d = S._aeNorm(sc.moon);                             // Earth -> Moon
  const north = S._aeNorm(S._aeSub([0, 0, 1], S._aeScale(d, d[2])));
  const east = S._aeCross(north, d);
  const pa = S._normDeg360(Math.atan2(S._aeDot(m.z, east), S._aeDot(m.z, north)) * 180 / Math.PI);
  const home = S._aeScale(d, -1);                           // Moon -> Earth
  const lon = Math.atan2(S._aeDot(home, m.y), S._aeDot(home, m.x)) * 180 / Math.PI;
  const lat = Math.asin(S._aeDot(home, m.z)) * 180 / Math.PI;
  console.log('   3D ' + c.name + ': pole PA ' + pa.toFixed(2) + ', sub-Earth ' + lon.toFixed(2) + ', ' + lat.toFixed(2));
  check(diff(pa, c.P) < TOL, '3D view, ' + c.name + ': the Moon\'s pole at P');
  check(diff(lon, c.l) < TOL && Math.abs(lat - c.b) < TOL, '3D view, ' + c.name + ': the face toward the Earth is (l, b)');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all moon face checks passed');
