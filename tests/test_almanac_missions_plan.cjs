// The mission planner's maths (zimi/static/almanac-missions-plan.js): Lambert's problem against scripts/mission_lambert.py's answer, the conic propagated
// from a transfer's departure state back to its arrival, and the porkchop plot's best Earth-to-Mars transfer in the 2020 window against what was flown
// (Perseverance: launch 30 July 2020, arrival 18 February 2021, C3 about 14 km^2/s^2 on the Atlas V; the grid's best is in the same valley).
//
// Run: node tests/test_almanac_missions_plan.cjs   (exit 0 = pass)

process.env.TZ = 'America/Los_Angeles';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const almSrc = read('almanac.js');
let failures = 0;
function check(ok, label) { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); }
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1); }
  throw new Error('unbalanced ' + name);
}
const S = { Math, Date, Object, JSON, console, String, Number, Array, isNaN, isFinite };
vm.createContext(S);
vm.runInContext(require('./sk.cjs')(), S);
vm.runInContext('var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000; var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;', S);
for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_jdnToGregorian', '_cnDeltaTdays']) vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(read('almanac-ephem.js'), S);
const plan = read('almanac-missions-plan.js');
vm.runInContext(plan.slice(0, plan.indexOf('// ── The sheet ──')), S);
const E = (expr) => vm.runInContext(expr, S);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Lambert: the Python solver's answer for one case (Earth orbit, km, s).
const L = E('_apLambert([7000, 0, 0], [0, 12000, 3000], 5000, 398600.4418, true, [0, 0, 1])');
check(near(L.v1[0], 5.1504918, 1e-6) && near(L.v1[1], 6.2713347, 1e-6) && near(L.v1[2], 1.5678337, 1e-6), 'Lambert gives the departure velocity scripts/mission_lambert.py gives');
check(near(L.v2[0], -3.6582786, 1e-6) && near(L.v2[1], -2.2744279, 1e-6), 'and the arrival velocity');

// Kepler: from the departure state for the time of flight, the arrival position.
const K = E('(function () { var l = _apLambert([7000, 0, 0], [0, 12000, 3000], 5000, 398600.4418, true, [0, 0, 1]); return _apKepler([7000, 0, 0], l.v1, 5000, 398600.4418); })()');
check(near(K.r[0], 0, 1e-4) && near(K.r[1], 12000, 1e-4) && near(K.r[2], 3000, 1e-4), 'propagating the conic from its departure state arrives at the target');

// The 2020 Earth to Mars window.
const jd0 = E('_dateToJD(new Date(Date.UTC(2020, 5, 1)))') ;
const g = E('_apPorkchop("Mars", ' + jd0 + ')');
const dep = new Date((g.best.dep - 2440587.5) * 86400000), arr = new Date((g.best.arr - 2440587.5) * 86400000);
console.log('best: depart ' + dep.toISOString().slice(0, 10) + ' arrive ' + arr.toISOString().slice(0, 10) + ' C3 ' + g.best.c3.toFixed(1) + ' vinf ' + g.best.vinf.toFixed(2));
check(g.span > 420 && g.span < 440, 'the window is a share of the synodic period (' + g.span.toFixed(0) + ' days)');
check(dep >= Date.UTC(2020, 6, 1) && dep <= Date.UTC(2020, 8, 15), 'the best departure falls in the real 2020 window (July to mid September)');
check(g.best.c3 > 8 && g.best.c3 < 20, 'with a launch C3 of the order the Atlas V gave (' + g.best.c3.toFixed(1) + ' km^2/s^2)');
check(g.best.tof > 150 && g.best.tof < 400, 'and a flight of months (' + g.best.tof.toFixed(0) + ' days)');
process.exit(failures ? 1 : 0);
