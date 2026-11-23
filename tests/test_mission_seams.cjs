// Where a mission's Sun-centred leg hands over to a planet-centred one, the two must meet: the player measures the gap with both
// ends at the hand-over (almanac-missions.js _amHelioKm, the planet from the view's one ephemeris, almanac-ephem.js _ephBodyJ2000)
// and closes it over the next leg. With the planets from JPL's approximate elements Perseverance's cruise met its Mars approach
// 49,500 km apart (the elements' Mars); with VSOP87D it is the tables' own few hundred kilometres. Run: node tests/test_mission_seams.cjs
const fs = require('fs'), path = require('path'), vm = require('vm');
const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('no ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1); }
  throw new Error('unbalanced ' + name);
}
const S = { Math, Date, Object, JSON, console, String, Number, Array, isNaN, isFinite };
vm.createContext(S);
vm.runInContext(require('./sk.cjs')(), S);
vm.runInContext('var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000; var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;', S);
const alm = read('almanac.js');
for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_jdnToGregorian', '_cnDeltaTdays']) vm.runInContext(extractFn(alm, fn), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(read('almanac-vsop87.js'), S);
vm.runInContext(read('almanac-ephem.js'), S);
vm.runInContext('function _aeAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; } function _aeScale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }', S);
const earth = read('almanac-earth.js');
vm.runInContext(earth.slice(earth.indexOf('var AE_PLANETS = ['), earth.indexOf('];', earth.indexOf('var AE_PLANETS = [')) + 2), S);
const ms = read('almanac-missions.js');
for (const fn of ['_amHerm', '_amBracket', '_amTable', '_amPrepare', '_amHelioKm']) vm.runInContext(extractFn(ms, fn), S);
S.DATA = JSON.parse(fs.readFileSync(path.join(STATIC, 'earth', 'missions-v1.json'), 'utf8'));
// Each hand-over at a planet must close within TOL_KM (the tables' own disagreement plus, at Mars, the 8 minutes between them).
const TOL_KM = { earth: 500, mars: 500 };
const rows = vm.runInContext(`(function () { var out = [];
  Object.keys(DATA.missions).forEach(function (id) { var m = DATA.missions[id]; _amPrepare(m);
    m.vehicles.forEach(function (v) { v.legs.forEach(function (leg) {
      if (!leg.prev || (leg.frame !== 'helio' && leg.prev.frame !== 'helio')) return;
      var t1 = leg.s[0][0], a = _amHelioKm(m, leg.prev, t1), b = _amHelioKm(m, leg, t1);
      var at = leg.frame === 'helio' ? (leg.prev.frame === 'eci' ? 'earth' : leg.prev.body) : (leg.frame === 'eci' ? 'earth' : leg.body);
      out.push([id, v.id, leg.prev.frame, leg.frame, at, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])]); }); }); });
  return out; })()`, S);
let fails = 0;
for (const [id, vid, from, to, at, km] of rows) {
  const ok = km <= (TOL_KM[at] || 0);
  console.log(`${ok ? 'ok' : 'FAIL'}: ${id} ${vid} ${from}->${to} at ${at}: ${km.toFixed(0)} km (under ${TOL_KM[at]})`);
  if (!ok) fails++;
}
if (!rows.length) { console.error('FAIL: no hand-over to a Sun-centred leg found'); fails++; }
process.exit(fails ? 1 : 0);
