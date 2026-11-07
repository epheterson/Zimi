// The Almanac's one ephemeris (zimi/static/almanac-ephem.js): the Sun
// (VSOP87D), the Moon (Meeus 47) and the planets, in the two frames the
// views use, pinned at fixed dates against JPL Horizons (DE441) and against
// each other. Pure maths: this file loads no GL and no DOM.
//
// The Horizons numbers below were fetched once from
// https://ssd.jpl.nasa.gov/api/horizons.api on 2026-10-16 (TT, geometric
// vectors in km on the ICRF-aligned ecliptic of J2000; apparent RA/Dec of date
// for the geocentric Sun and Moon) and are written here so this test needs no
// network. Epochs: J2000.0, 2025-Nov-21 00:00 TT, 2050-Jul-13 00:00 TT.
//
// Run: node tests/test_almanac_ephem.cjs   (exit 0 = pass)

process.env.TZ = 'America/Los_Angeles';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const almSrc = read('almanac.js');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
function near(a, b, tol, label) {
  check(Math.abs(a - b) <= tol, label + ' (' + a + ' vs ' + b + ', tol ' + tol + ')');
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

// No document, no window: the file must run in a bare global scope.
const S = { Math, Date, Object, JSON, console, String, Number, Array, isNaN };
vm.createContext(S);
vm.runInContext(require("./sk.cjs")(), S);   // app.js SK, loaded before every Almanac file
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;', S);
for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_jdnToGregorian', '_cnDeltaTdays']) vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(read('almanac-ephem.js'), S);
const E = (expr) => vm.runInContext(expr, S);
const AU_KM = E('AU_KM');
const DEG = 180 / Math.PI;

// ── JPL Horizons, geometric J2000 ecliptic vectors (km) and apparent places ──
const HZ = [
  { jdTT: 2451545.0, label: 'J2000.0',
    moon: { ra: 222.44359, dec: -10.89791, delta: 0.00268997545281, ecl: [-2.916083842345213E+05, -2.749797416199811E+05, 3.627119662782984E+04] },
    sun: { ra: 281.27755, dec: -23.03249, range: 0.98332763198913 },
    helio: {
      Mars: [2.080481406417574E+08, -2.007052629937911E+06, -5.156288959306011E+06],
      Earth: [-2.649903367526336E+07, 1.446972967929471E+08, -6.111494259759784E+02],
      Jupiter: [5.985676246576397E+08, 4.396046799473614E+08, -1.522686167299697E+07],
      Neptune: [2.515046523943985E+09, -3.738714567646598E+09, 1.903221685678434E+07]
    } },
  { jdTT: 2461000.5, label: '2025-11-21',
    moon: { ra: 243.92414, dec: -26.30045, delta: 0.00271691399574, ecl: [-1.625097084805163E+05, -3.708866965399061E+05, -3.502445186105371E+04] },
    sun: { ra: 236.69823, dec: -19.91769, range: 0.98800561389166 },
    helio: {
      Mars: [-3.747736868505748E+07, -2.176726841409163E+08, -3.642484547867596E+06],
      Earth: [7.708376728830616E+07, 1.261109714907015E+08, -7.507945428729057E+03],
      Jupiter: [-2.086495305658425E+08, 7.489327099915220E+08, 1.557178033186257E+06],
      Neptune: [4.469266233825270E+09, 5.826605184834480E+07, -1.041906261802228E+08]
    } },
  { jdTT: 2470000.5, label: '2050-07-13',
    moon: { ra: 38.41925, dec: 15.81778, delta: 0.00253411707753, ecl: [2.888595779018791E+05, 2.455210654694057E+05, 4.654591087142791E+03] },
    sun: { ra: 112.52985, dec: 21.81646, range: 1.01653748649276 },
    helio: {
      Mars: [1.076304272495304E+08, -1.801212289159556E+08, -6.409486541731812E+06],
      Earth: [5.234470904940591E+07, -1.427791207391454E+08, 1.561979487501085E+04],
      Jupiter: [-5.386363126721927E+08, 5.832144559917815E+08, 9.606563838873386E+06],
      Neptune: [2.527937977908040E+09, 3.672580878404170E+09, -1.338875945203233E+08]
    } }
];

const vlen = (v) => Math.hypot(v[0], v[1], v[2]);
const angleDeg = (a, b) => Math.atan2(vlen([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * DEG;
const lonDeg = (v) => ((Math.atan2(v[1], v[0]) * DEG) + 360) % 360;
const raDecVec = (raDeg, decDeg) => {
  const ra = raDeg / DEG, dec = decDeg / DEG;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
};
// UT Julian Day for a TT one (the views pass UT, as the page's clock is UT).
const utFor = (jdTT) => { let ut = jdTT; for (let i = 0; i < 3; i++) ut = jdTT - E('_aeDeltaTDays(' + ut + ')'); return ut; };

// Tolerances, set from the measured misses with room: the Moon and Sun are
// series good to arcseconds; the planets are JPL's approximate elements.
const TOL = {
  moonDirDeg: 0.003, moonDistKm: 15, sunDirDeg: 0.001, sunRangeAU: 2e-5,   // the Sun's range drops VSOP terms under 1e-5 AU

  earthAU: 2e-5, marsAU: 2.5e-3, outerAU: 4e-2, marsLonDeg: 0.1
};

for (const h of HZ) {
  const jdUT = utFor(h.jdTT);
  // Apparent places of date (what the Earth view draws from).
  const mq = E('_aeMoon(' + h.jdTT + ')');
  const mv = [Math.cos(mq.dec) * Math.cos(mq.ra), Math.cos(mq.dec) * Math.sin(mq.ra), Math.sin(mq.dec)];
  near(angleDeg(mv, raDecVec(h.moon.ra, h.moon.dec)), 0, TOL.moonDirDeg, h.label + ': Moon RA/Dec vs Horizons (deg off)');
  near(mq.distKm, vlen(h.moon.ecl), TOL.moonDistKm, h.label + ': Moon geocentric distance vs Horizons geometric vector (km)');
  const sq = E('_aeSun(' + h.jdTT + ')');
  const sv = [Math.cos(sq.dec) * Math.cos(sq.ra), Math.cos(sq.dec) * Math.sin(sq.ra), Math.sin(sq.dec)];
  near(angleDeg(sv, raDecVec(h.sun.ra, h.sun.dec)), 0, TOL.sunDirDeg, h.label + ': Sun RA/Dec vs Horizons (deg off)');
  near(sq.distKm / AU_KM, vlen(h.helio.Earth) / AU_KM, TOL.sunRangeAU, h.label + ': Sun range vs Horizons Earth-Sun vector (AU)');
  // Sun's apparent ecliptic longitude: Horizons' RA/Dec turned to the ecliptic of date.
  const eps = E('_aeNutation(' + ((h.jdTT - 2451545) / 36525) + ')').eps / DEG;
  const hl = Math.atan2(Math.sin(h.sun.ra / DEG) * Math.cos(eps) + Math.tan(h.sun.dec / DEG) * Math.sin(eps), Math.cos(h.sun.ra / DEG)) * DEG;
  near(((sq.lon - hl + 540) % 360) - 180, 0, 0.001, h.label + ': Sun apparent longitude vs Horizons (deg)');

  // One frame: heliocentric J2000 ecliptic.
  const moonGeo = E('_ephMoonGeoJ2000(' + jdUT + ')').map((x) => x * AU_KM);
  near(angleDeg(moonGeo, h.moon.ecl), 0, TOL.moonDirDeg, h.label + ': Moon geocentric J2000 direction vs Horizons (deg off)');
  near(vlen(moonGeo), vlen(h.moon.ecl), TOL.moonDistKm, h.label + ': Moon geocentric J2000 distance vs Horizons (km)');
  const earth = E('_ephBodyJ2000("Earth", ' + jdUT + ')').map((x) => x * AU_KM);
  near(vlen([earth[0] - h.helio.Earth[0], earth[1] - h.helio.Earth[1], earth[2] - h.helio.Earth[2]]) / AU_KM, 0, TOL.earthAU, h.label + ': Earth heliocentric vs Horizons (AU off)');
  const moonHelio = E('_ephBodyJ2000("Moon", ' + jdUT + ')');
  check(vlen([moonHelio[0] - earth[0] / AU_KM - moonGeo[0] / AU_KM, moonHelio[1] - earth[1] / AU_KM - moonGeo[1] / AU_KM, moonHelio[2] - earth[2] / AU_KM - moonGeo[2] / AU_KM]) < 1e-12, h.label + ': Moon from the Sun is the Earth plus the Moon from the Earth');
  const mars = E('_ephBodyJ2000("Mars", ' + jdUT + ')').map((x) => x * AU_KM);
  near(vlen([mars[0] - h.helio.Mars[0], mars[1] - h.helio.Mars[1], mars[2] - h.helio.Mars[2]]) / AU_KM, 0, TOL.marsAU, h.label + ': Mars heliocentric vs Horizons (AU off)');
  near(((lonDeg(mars) - lonDeg(h.helio.Mars) + 540) % 360) - 180, 0, TOL.marsLonDeg, h.label + ': Mars heliocentric longitude vs Horizons (deg)');
  for (const name of ['Jupiter', 'Neptune']) {
    const p = E('_ephBodyJ2000("' + name + '", ' + jdUT + ')').map((x) => x * AU_KM), q = h.helio[name];
    near(vlen([p[0] - q[0], p[1] - q[1], p[2] - q[2]]) / AU_KM, 0, TOL.outerAU, h.label + ': ' + name + ' heliocentric vs Horizons (AU off)');
  }
}

// Pinned values: the Mars longitude and the Sun's apparent longitude, the
// numbers the plan names, written out so a change to the series shows here.
{
  const mars = E('_ephBodyJ2000("Mars", ' + utFor(2461000.5) + ')');
  near(lonDeg(mars), lonDeg(HZ[1].helio.Mars), TOL.marsLonDeg, 'Mars heliocentric longitude 2025-11-21: ' + lonDeg(HZ[1].helio.Mars).toFixed(3) + ' deg (Horizons)');
  near(E('_aeSun(2461000.5)').lon, 239.0, 1.0, 'Sun apparent longitude 2025-11-21 is near 239 deg (Scorpio into Sagittarius)');
}

// The conversion between the two frames: a J2000 ecliptic vector and back is
// the identity, and the Moon through it lands on the Moon's own RA/Dec of date.
for (const jdTT of [2451545.0, 2461000.5, 2470000.5, 2433282.5]) {
  const v = [0.3, -0.8, 0.5];
  const back = E('_ephEclJ2000ToEqOfDate(_ephEqOfDateToEclJ2000([0.3, -0.8, 0.5], ' + jdTT + '), ' + jdTT + ')');
  near(vlen([back[0] - v[0], back[1] - v[1], back[2] - v[2]]), 0, 1e-12, 'frame round trip at JD ' + jdTT);
  const jdUT = utFor(jdTT);
  const mq = E('_aeMoon(' + jdTT + ')');
  const ofDate = E('_ephEclJ2000ToEqOfDate(_ephMoonGeoJ2000(' + jdUT + '), ' + jdTT + ')');
  const direct = [Math.cos(mq.dec) * Math.cos(mq.ra), Math.cos(mq.dec) * Math.sin(mq.ra), Math.sin(mq.dec)];
  near(angleDeg(ofDate, direct), 0, 1e-9, 'the Moon through the J2000 frame and back is _aeMoon\'s RA/Dec at JD ' + jdTT);
}


// J2000.0 itself: the equator-of-date turn is the J2000 obliquity, to nutation.
near(E('EPH_OBLIQUITY_DEG'), 23.4392911, 1e-6, 'J2000 mean obliquity');

// One source: nothing but the ephemeris defines these, and it needs no GL or DOM.
const ephSrc = read('almanac-ephem.js'), earthSrc = read('almanac-earth.js');
check(!/\b(document|window|THREE|WebGL|requestAnimationFrame|getContext)\b/.test(ephSrc.replace(/\/\/.*$/gm, '')), 'almanac-ephem.js touches no DOM, window or GL');
for (const def of [/function _aeSun\(/, /function _aeMoon\(/, /var AE_VSOP_L\b/, /var AE_MOON_LR\b/, /function _aeNutation\(/, /function _aeGast\(/]) {
  check(def.test(ephSrc) && !def.test(earthSrc), def + ' is defined in the ephemeris only');
}

if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('all passed');
