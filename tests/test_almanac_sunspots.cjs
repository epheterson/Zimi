// The 3D Sun's spots (zimi/static/almanac-earth.js _aeSunSpots): made up,
// but by the Sun's rules, and the same date always the same Sun.
//
//   1. The cycle: the sunspot number peaks with Cycle 25 (2024-2025) and is
//      near nothing at its minimum (2019.9) and the next (about 2030.9);
//      quiet through the Maunder minimum.
//   2. The spots follow it: many in 2025, few in 2019 and 2030.
//   3. Sporer's law: mean latitude falls from about 25-30 degrees early in a
//      cycle to under 15 late in it; never near a pole.
//   4. Differential rotation (Snodgrass): about 24.5 days sidereal at the
//      equator, about 34 near the poles; a spot moves at its latitude's rate.
//   5. Deterministic: the same instant gives the same spots; a day later the
//      same groups have turned, some faded, some born.
//
// Run: node tests/test_almanac_sunspots.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

const S = { Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, window: {}, document: { getElementById: () => null } };
vm.createContext(S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;' +
  'function t(k) { return k; } function _dateToJD(ms) { return JD_UNIX_EPOCH + ms / MS_PER_DAY; }', S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8'), S);
vm.runInContext(require('./moon_model.cjs')(), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-earth.js'), 'utf8'), S);

const ssn = (y) => vm.runInContext('_aeSunspotNumber(' + y + ').r', S);
const spots = (iso) => vm.runInContext('_aeSunSpots(' + Date.parse(iso) + ')', S);

// 1. The cycle.
check(ssn(2024.8) > 120 && ssn(2024.8) < 200, 'Cycle 25 near its peak: ' + ssn(2024.8).toFixed(0));
check(ssn(2019.95) < 25, 'the 2019 minimum is quiet: ' + ssn(2019.95).toFixed(0));
check(ssn(2031.0) < 25, 'the next minimum, about 2031, is quiet: ' + ssn(2031.0).toFixed(0));
check(ssn(2036) > 100, 'Cycle 26 rises (the mean cycle): ' + ssn(2036).toFixed(0));
check(ssn(1680) < 15, 'the Maunder minimum: ' + ssn(1680).toFixed(0));
check(ssn(1958.2) > 200, 'Cycle 19, the strongest recorded: ' + ssn(1958.2).toFixed(0));

// 2. The spots follow it (counted over a month of days, to smooth the dice).
function monthCount(y, m) {
  let n = 0;
  for (let d = 1; d <= 28; d += 3) n += spots(new Date(Date.UTC(y, m, d)).toISOString()).length;
  return n / 10;
}
const max = monthCount(2025, 0), min19 = monthCount(2019, 11), min30 = monthCount(2030, 11);
check(max > 8, '2025: many groups on the Sun: ' + max.toFixed(1));
check(min19 < max / 4 && min30 < max / 4, '2019 and 2030: few (' + min19.toFixed(1) + ', ' + min30.toFixed(1) + ')');

// 3. Sporer's law.
function meanLat(y) {
  let s = 0, n = 0, maxLat = 0;
  for (let d = 0; d < 360; d += 5) {
    const g = spots(new Date(Date.UTC(y, 0, 1) + d * 86400000).toISOString());
    for (const x of g) { s += Math.abs(x.lat); n++; maxLat = Math.max(maxLat, Math.abs(x.lat)); }
  }
  return { mean: s / n, max: maxLat };
}
const early = meanLat(2021), late = meanLat(2028);
check(early.mean > 20, 'early in Cycle 25, spots high: ' + early.mean.toFixed(1) + ' deg');
check(late.mean < 15, 'late in Cycle 25, spots low: ' + late.mean.toFixed(1) + ' deg');
check(Math.max(early.max, late.max) <= 45, 'never near a pole');

// 4. Differential rotation.
const rot = (lat) => 360 / vm.runInContext('_aeSunRotation(' + lat + ')', S);
check(Math.abs(rot(0) - 24.47) < 0.1, 'equator: ' + rot(0).toFixed(2) + ' days sidereal');
check(rot(75) > 31 && rot(90) > 33, 'near the poles: ' + rot(75).toFixed(1) + ', ' + rot(90).toFixed(1) + ' days');

// 5. Deterministic, and evolving.
const a = JSON.stringify(spots('2025-03-01T00:00:00Z')), b = JSON.stringify(spots('2025-03-01T00:00:00Z'));
check(a === b, 'the same instant, the same Sun');
const day0 = spots('2025-03-01T00:00:00Z'), day1 = spots('2025-03-02T00:00:00Z');
const same = day0.filter((g) => day1.some((h) => h.born === g.born));
check(same.length > 0, 'a day on, groups are still there: ' + same.length + ' of ' + day0.length);
const g0 = same[0], g1 = day1.find((h) => h.born === g0.born);
const turned = ((g1.lon - g0.lon) % 360 + 360) % 360;
const want = vm.runInContext('_aeSunRotation(' + g0.lat + ')', S);
check(Math.abs(turned - want) < 1e-6, 'a group turns at its latitude\'s rate: ' + turned.toFixed(3) + ' deg/day');
check(day1.some((h) => !day0.some((g) => g.born === h.born)) || day0.some((g) => !day1.some((h) => h.born === g.born)),
  'groups are born and fade');

// The shader takes them as unit vectors, at most its array.
const v = vm.runInContext('_aeSpotVectors(' + Date.parse('2025-03-01T00:00:00Z') + ')', S);
check(v.length > 0 && v.length <= vm.runInContext('AE_SPOT_MAX', S), 'spots for the shader: ' + v.length);
check(v.every((x) => Math.abs(Math.hypot(x[0], x[1], x[2]) - 1) < 1e-9 && x[3] > 0), 'unit vectors, positive radii');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
