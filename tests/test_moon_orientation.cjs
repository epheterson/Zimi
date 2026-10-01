// The Moon as the viewer sees it: which way its lit limb points in their sky.
//
// One geometry drives every Moon the Almanac draws: the position angle of the
// bright limb, chi (Meeus 48.5), and the parallactic angle at the observer,
// q (Meeus 14.1). The lit limb lies rot = chi - q from the zenith,
// counterclockwise as seen (app.js _moonLimbAngles). The hero disc turns by
// it, and the 3D view's Moon camera rolls by q, so both show one Moon.
//
//   1. chi and rot against JPL's DE421 (Skyfield 1.54, apparent topocentric
//      RA/Dec of date, LAST from GAST), and against a second, independent
//      route in the same script: the Sun's direction projected on the sky at
//      the Moon in the observer's alt-az frame, measured from the zenith.
//      The two agree to 0.01 deg; the shipped low-precision series must land
//      within 2 deg. Cases:
//        Eric's photo: 2026-09-30 07:26 UTC, Los Angeles (34.05 N, 118.25 W),
//          waning gibbous 84% lit, dark limb at the upper right;
//        2026-01-10 03:00 UTC, London, last quarter;
//        2027-05-12 09:00 UTC, Sydney (southern sky), waxing crescent.
//   2. The hero disc: its sprite, turned by _heroMoonView's tilt, puts the dark
//      limb at the upper right for Eric's case. Without a chosen place it
//      stands celestial north up (rot = chi) and says "north up".
//   3. The 3D view: a camera looking at the Moon with up from _aeViewUp and
//      the roll _aeRollDeg gives, lit by the view's own Sun and Moon (VSOP87 +
//      Meeus 47), shows the lit limb at the same rot, within 2 deg.
//
// Before this, the 3D Moon kept celestial north up whatever the place (the
// dark side "on the plain right" of Eric's photo) and _moonEqCoords had the
// evection and variation with the wrong sign, 3 deg off in right ascension.
//
// Run: node tests/test_moon_orientation.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const appSrc = read('app.js'), almSrc = read('almanac.js');

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
  'var _MOON_EQUATOR_TILT_DEG = 1.54242; var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;' +
  'function t(k) { return k; }', S);
for (const fn of ['_moonEqCoords', '_moonLimbAngles', '_moonLimbAnglesOf', '_moonAxisOf', '_moonView', '_normDeg360', '_moonScreenTiltDeg', '_moonIsWaxing', '_moonPhase'])
  vm.runInContext(extractFn(appSrc, fn), S);
for (const fn of ['_dateToJD', '_jdnToGregorian', '_cnDeltaTdays', '_almEsc', '_heroMoonView', '_heroMoonTiltDeg', '_heroMoonOrientNote'])
  vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(extractFn(read('almanac-sky.js'), '_angleDelta'), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(read('almanac-earth.js'), S);

const diff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const TOL = 2;
const CASES = [
  { name: "Eric's photo, Los Angeles", ms: Date.UTC(2026, 8, 30, 7, 26), lat: 34.05, lon: -118.25, chi: 71.13, rot: 135.72, illum: 83.8 },
  { name: 'London, last quarter', ms: Date.UTC(2026, 0, 10, 3, 0), lat: 51.5, lon: -0.12, chi: 113.26, rot: 137.30, illum: 54.8 },
  { name: 'Sydney, waxing crescent', ms: Date.UTC(2027, 4, 12, 9, 0), lat: -33.87, lon: 151.21, chi: 285.50, rot: 128.47, illum: 40.3 },
];
const angles = (c, lat, lon) => S._moonLimbAngles(new Date(c.ms), lat === undefined ? c.lat : lat, lon === undefined ? c.lon : lon);

// ── 1. chi and rot against DE421 ──
for (const c of CASES) {
  const a = angles(c);
  console.log('   ' + c.name + ': chi ' + a.chi.toFixed(2) + ' (DE421 ' + c.chi + '), q ' + a.q.toFixed(2) +
    ', zenith-up ' + a.rot.toFixed(2) + ' (DE421 ' + c.rot + ')');
  check(diff(a.chi, c.chi) < TOL, c.name + ': bright-limb position angle chi within ' + TOL + ' deg of DE421');
  check(diff(a.rot, c.rot) < TOL, c.name + ': zenith-up angle chi - q within ' + TOL + ' deg of DE421');
  check(Math.abs(S._moonPhase(new Date(c.ms)).illumination - c.illum) < 1.5, c.name + ': illumination ~' + c.illum + '%');
}

// ── 2. The hero disc ──
{
  const c = CASES[0];
  const loc = { lat: c.lat, lon: c.lon, stored: true };
  const view = S._heroMoonView(new Date(c.ms), loc), tilt = view.tilt;
  // The sprite is drawn lunar north up, lit at `limb` counterclockwise from
  // the pole, and CSS rotation runs clockwise: the lit limb ends up this far
  // counterclockwise from straight up.
  const waxing = S._moonIsWaxing(S._moonPhase(new Date(c.ms)));
  const litFromUp = S._normDeg360(view.limb - tilt);
  const darkClockwise = S._normDeg360(-(litFromUp + 180));   // dark limb, clockwise from up
  console.log('   hero: tilt ' + tilt.toFixed(2) + ', lit limb ' + litFromUp.toFixed(1) +
    ' deg counterclockwise from up, dark limb ' + darkClockwise.toFixed(1) + ' deg clockwise from up');
  check(!waxing, "Eric's Moon is waning");
  check(darkClockwise > 15 && darkClockwise < 75, "the hero's dark limb is at the upper right, as in Eric's photo");
  check(diff(litFromUp, c.rot) < TOL, 'the hero draws the lit limb at the zenith-up angle');

  const guess = { lat: 34, lon: -120, stored: false };
  const north = S._heroMoonView(new Date(c.ms), guess);
  check(diff(S._normDeg360(north.limb - north.tilt), angles(c).chi) < 1e-9,
    'no place chosen: the hero stands celestial north up (lit limb at chi), not at a guessed place');
  check(S._heroMoonOrientNote(guess).includes('alm_moon_north_up') && S._heroMoonOrientNote(loc) === '',
    'and says "north up" only then');
  check(diff(S._moonLimbAngles(new Date(c.ms), null, null).rot, angles(c).chi) < 1e-9, 'with no place rot is chi');
}

// ── 3. The 3D view's Moon camera ──
for (const c of CASES) {
  const sc = S._aeSceneAt(c.ms);
  const d = S._aeNorm(sc.moon);                         // looking at the Moon from the Earth
  S._ae = { you: { lat: c.lat, lon: c.lon } };
  const roll = S._aeRollDeg('moon', c.ms);
  const up = S._aeViewUp(d, roll);
  const left = S._aeCross(up, d);
  let s = S._aeSub(sc.sun, sc.moon);                    // toward the Sun, from the Moon
  s = S._aeSub(s, S._aeScale(d, S._aeDot(s, d)));
  const lit = S._normDeg360(Math.atan2(S._aeDot(s, left), S._aeDot(s, up)) * 180 / Math.PI);
  console.log('   3D ' + c.name + ': roll ' + roll.toFixed(2) + ', lit limb ' + lit.toFixed(2) + ' from up');
  check(diff(lit, c.rot) < TOL, '3D view, ' + c.name + ': the Moon camera shows the lit limb at the zenith-up angle');
  S._ae = { you: null };
  S._getLocation = () => ({ lat: 0, lon: 0, stored: false });
  check(S._aeRollDeg('moon', c.ms) === 0 && S._aeObserver() === null, '3D view, ' + c.name + ': no place, north up');
  delete S._getLocation;
}
check(S._aeRollDeg('earth', CASES[0].ms) === 0, 'the Earth and the Sun keep north up');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all moon orientation checks passed');
