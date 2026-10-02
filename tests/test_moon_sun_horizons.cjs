// The Sun, the Moon and the Earth's day side at any focus date, past and
// future, against JPL Horizons: the hero disc (app.js _moonView, the flat
// Moon the page paints first) and the 3D scene (almanac-earth.js
// _aeSceneAt, _aeMoonBasis, _aeSubsolarPoint) must both stand within 1
// degree of the ephemeris, or the handoff between them would be a lie.
//
// Reference values: JPL Horizons (https://ssd.jpl.nasa.gov/horizons/, the
// API, DE441), fetched 2026-09-30 with
//   COMMAND=301 CENTER=500@399 QUANTITIES=2,10,14,17,24 (the Moon, geocentric:
//     apparent RA/Dec, illuminated %, sub-observer lon/lat, north pole
//     position angle, Sun-Moon-Earth phase angle),
//   COMMAND=10  CENTER=coord@399 SITE_COORD=0,0,0 QUANTITIES=2,7 (the Sun's
//     apparent RA/Dec and the apparent sidereal time at Greenwich),
//   TIME_TYPE=UT, ANG_FORMAT=DEG, EXTRA_PREC=YES.
// The bright limb's position angle is not a Horizons column: it is Meeus
// 48.5 on Horizons' apparent RA/Dec of the Sun and the Moon. The point under
// the Sun is the Sun's apparent RA less Greenwich's sidereal time, at its
// declination (8.8" of parallax between Greenwich and the geocentre).
//
// Instants: Apollo 11's landing; the total solar eclipses of 1999-08-11,
// 2024-04-08 and 2026-08-12 at greatest eclipse; the total lunar eclipse of
// 2025-03-14; today; a thin crescent in 2031; and 2100-01-01.
//
// At a solar eclipse the Moon stands a few arcminutes from the Sun, and the
// bright limb's direction is the direction of a 0.1-degree separation: a
// position good to 10" swings it by degrees, and the lit sliver it points to
// is under a thousandth of the disc. At a lunar eclipse the whole disc is
// lit and there is no bright limb to point to. There the test asks instead
// for the eclipse itself, from the scene's own geometry, and the limb angle
// is checked where the elongation lies between 10 and 170 degrees.
//
// Run: node tests/test_moon_sun_horizons.cjs   (exit 0 = pass)

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
for (const fn of ['_moonEqCoords', '_moonLimbAngles', '_moonLimbAnglesOf', '_moonAxisOf', '_moonView', '_normDeg360', '_moonIsWaxing', '_moonPhase'])
  vm.runInContext(extractFn(appSrc, fn), S);
for (const fn of ['_dateToJD', '_jdnToGregorian', '_cnDeltaTdays', '_computeEclipses']) vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(extractFn(read('almanac-sky.js'), '_angleDelta'), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(require('./moon_model.cjs')(), S);
vm.runInContext(read('almanac-earth.js'), S);

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const diff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const TOL = 1;

// [UT, Moon RA, Dec, illuminated %, sub-Earth lon, lat, pole PA, phase angle S-T-O,
//  Sun RA, Dec, Greenwich apparent sidereal time (hours)]
const HORIZONS = [
  ['1969-07-20T20:17:40Z', 186.696497875, -4.379609918, 32.99279, 352.840302, 1.698770, 21.7834, 109.8876, 119.999626915, 20.584455443, 16.1899139311],
  ['1999-08-11T11:03:00Z', 140.893061997, 15.810878919, 0.00187, 4.723541, -0.677419, 19.4953, 179.5044, 140.785266203, 15.328330898, 8.3482149353],
  ['2024-04-08T18:17:18Z', 17.739124078, 7.898561999, 0.00092, 1.972833, -0.459252, 339.2556, 179.6515, 17.901221360, 7.591478184, 7.4547127701],
  ['2025-03-14T06:58:45Z', 174.595534479, 2.681977168, 99.99924, 2.840556, -0.400446, 21.7744, 0.3163, 354.443903096, -2.404701838, 18.4560506898],
  ['2026-08-12T17:46:00Z', 142.822803024, 15.616022545, 0.00609, 4.100814, -1.135147, 16.9763, 179.1060, 142.444445131, 14.801317947, 15.1794933988],
  ['2026-09-30T12:00:00Z', 53.161339176, 24.451372544, 82.46625, 358.234514, -6.681689, 346.1855, 49.5130, 186.747142423, -2.915731455, 12.6167827850],
  ['2031-05-20T06:00:00Z', 44.414237029, 17.925368278, 1.08339, 4.315052, -1.277136, 341.9741, 168.0455, 56.843591135, 19.943705224, 21.8471592984],
  ['2100-01-01T00:00:00Z', 159.518492817, 9.798226243, 77.45830, 357.829041, -1.469027, 20.3930, 56.6934, 281.532342386, -23.004260896, 6.7159098837],
];

// The bright limb's position angle from the Sun's and the Moon's RA/Dec (Meeus 48.5).
function chiOf(raS, decS, raM, decM) {
  const dA = (raS - raM) * D2R;
  return ((Math.atan2(Math.cos(decS * D2R) * Math.sin(dA),
    Math.sin(decS * D2R) * Math.cos(decM * D2R) - Math.cos(decS * D2R) * Math.sin(decM * D2R) * Math.cos(dA)) * R2D) + 360) % 360;
}
// The phase angle a lit fraction stands for: k = (1 + cos i) / 2.
const phaseOfK = (k) => Math.acos(Math.max(-1, Math.min(1, 2 * k - 1))) * R2D;
function elongation(raS, decS, raM, decM) {
  return S._aeAngle(S._aeEqVec(raS * D2R, decS * D2R, 1), S._aeEqVec(raM * D2R, decM * D2R, 1)) * R2D;
}
// A scene vector's position angle on the sky, seen from the Earth's centre
// looking along `d`: from celestial north through east.
function paOnSky(v, d) {
  const n = S._aeNorm(S._aeSub([0, 0, 1], S._aeScale(d, d[2])));
  const e = S._aeCross(n, d);
  return (Math.atan2(S._aeDot(v, e), S._aeDot(v, n)) * R2D + 360) % 360;
}

for (const row of HORIZONS) {
  const [iso, mRa, mDec, illu, subLon, subLat, np, sto, sRa, sDec, gastH] = row;
  const ms = Date.parse(iso), when = iso.slice(0, 16);
  const chiRef = chiOf(sRa, sDec, mRa, mDec);
  const elong = elongation(sRa, sDec, mRa, mDec);
  const limbDefined = elong > 10 && elong < 170;
  const lRef = ((subLon + 180) % 360) - 180;

  // ── The hero disc ──
  const v = S._moonView(new Date(ms), null, null);
  const iHero = phaseOfK(v.k);
  check(Math.abs(iHero - sto) < TOL, when + ' hero: phase angle ' + iHero.toFixed(2) + ' vs Horizons ' + sto);
  check(Math.abs(v.k * 100 - illu) < 1, when + ' hero: lit ' + (v.k * 100).toFixed(2) + '% vs ' + illu + '%');
  if (limbDefined) check(diff(v.chi, chiRef) < TOL, when + ' hero: bright limb PA ' + v.chi.toFixed(2) + ' vs ' + chiRef.toFixed(2));
  check(diff(v.P, np) < TOL, when + ' hero: pole PA ' + v.P.toFixed(2) + ' vs ' + np);
  check(diff(v.l, lRef) < TOL && Math.abs(v.b - subLat) < TOL,
    when + ' hero: face l,b ' + v.l.toFixed(2) + ',' + v.b.toFixed(2) + ' vs ' + lRef.toFixed(2) + ',' + subLat);

  // ── The 3D scene ──
  const sc = S._aeSceneAt(ms);
  const sunDir = S._aeNorm(sc.sun), moonDir = S._aeNorm(sc.moon);
  const sunErr = S._aeAngle(sunDir, S._aeEqVec(sRa * D2R, sDec * D2R, 1)) * R2D;
  const moonErr = S._aeAngle(moonDir, S._aeEqVec(mRa * D2R, mDec * D2R, 1)) * R2D;
  check(sunErr < TOL, when + ' 3D: Sun direction off by ' + (sunErr * 3600).toFixed(1) + '"');
  check(moonErr < TOL, when + ' 3D: Moon direction off by ' + (moonErr * 3600).toFixed(1) + '"');
  const i3d = S._aeAngle(S._aeSub(sc.sun, sc.moon), S._aeScale(sc.moon, -1)) * R2D;
  check(Math.abs(i3d - sto) < TOL, when + ' 3D: phase angle ' + i3d.toFixed(3) + ' vs ' + sto);
  check(Math.abs((1 + Math.cos(i3d * D2R)) / 2 * 100 - illu) < 1, when + ' 3D: lit fraction');
  if (limbDefined) {
    const chi3d = paOnSky(S._aeNorm(S._aeSub(sc.sun, sc.moon)), moonDir);
    check(diff(chi3d, chiRef) < TOL, when + ' 3D: bright limb PA ' + chi3d.toFixed(2) + ' vs ' + chiRef.toFixed(2));
  } else {
    // The eclipse itself: the Moon over the Sun (solar), or the Moon in the
    // Earth's shadow (lunar), from the scene's own geometry.
    const e = S._aeEclipseNow(sc);
    check(!!e, when + ' 3D: an eclipse is under way (elongation ' + elong.toFixed(2) + ' deg)');
  }
  const basis = S._aeMoonBasis(sc);
  const p3d = paOnSky(basis.z, moonDir);
  check(diff(p3d, np) < TOL, when + ' 3D: pole PA ' + p3d.toFixed(2) + ' vs ' + np);
  const home = S._aeScale(moonDir, -1);
  const l3d = Math.atan2(S._aeDot(home, basis.y), S._aeDot(home, basis.x)) * R2D;
  const b3d = Math.asin(S._aeDot(home, basis.z)) * R2D;
  check(diff(l3d, lRef) < TOL && Math.abs(b3d - subLat) < TOL,
    when + ' 3D: face l,b ' + l3d.toFixed(2) + ',' + b3d.toFixed(2) + ' vs ' + lRef.toFixed(2) + ',' + subLat);
  // The Earth's day side: the point under the Sun.
  const sub = S._aeSubsolarPoint(sc);
  const subLonRef = ((sRa - gastH * 15) % 360 + 540) % 360 - 180;
  check(Math.abs(sub.lat - sDec) < TOL && diff(sub.lon, subLonRef) < TOL,
    when + ' 3D: Sun overhead at ' + sub.lat.toFixed(3) + ',' + sub.lon.toFixed(3) + ' vs ' + sDec.toFixed(3) + ',' + subLonRef.toFixed(3));
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
