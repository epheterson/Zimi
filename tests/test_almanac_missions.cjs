// The mission player's maths (zimi/static/almanac-missions.js), run from the shipped file without a browser: the Hermite
// curve through a path table, the timeline's phases and their widths, mission elapsed time. The data itself
// (static/earth/missions-v1.json) is checked in tests/test_almanac_missions.py against the flight reports and JPL Horizons.
//
// Run: node tests/test_almanac_missions.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-missions.js'), 'utf8');
const cut = src.indexOf('// ── Where a vehicle is, in the scene ──');
if (cut < 0) throw new Error('the pure section moved');
const ctx = { Math, Object, Array, String, JSON };
vm.createContext(ctx);
vm.runInContext('var AE_EARTH_RADIUS_KM = 6378.137; function _aeT(k) { return k; }\n' + src.slice(0, cut), ctx);

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A path with a known answer: a circle of radius 7000 km at 7.5 km/s sampled every 60 s.
const w = 7.5 / 7000, rows = [];
for (let i = 0; i <= 20; i++) { const t = i * 60; rows.push([t, 7000 * Math.cos(w * t), 7000 * Math.sin(w * t), 0, -7.5 * Math.sin(w * t), 7.5 * Math.cos(w * t), 0]); }
let worst = 0;
for (let t = 0; t <= 1200; t += 7.3) {
  const r = ctx._amTable(rows, t);
  worst = Math.max(worst, Math.hypot(r.p[0] - 7000 * Math.cos(w * t), r.p[1] - 7000 * Math.sin(w * t)));
}
check(worst < 0.01, 'a Hermite curve through one minute rows follows a circular orbit to ' + worst.toFixed(4) + ' km');
const r0 = ctx._amTable(rows, 600);
check(near(Math.hypot(r0.v[0], r0.v[1]), 7.5, 1e-4), 'its velocity is the orbit\'s speed');
const out = ctx._amTable(rows, 1300);
check(isFinite(out.p[0]), 'asked past its end it still answers');

// The timeline.
const m = { end: 1000, start: 0, phases: [{ t: 0, w: 1 }, { t: 100, w: 2 }, { t: 400, w: 1 }] };
check(ctx._amPhaseAt(m, 0) === 0 && ctx._amPhaseAt(m, 99.9) === 0 && ctx._amPhaseAt(m, 100) === 1 && ctx._amPhaseAt(m, 999) === 2, 'the phase at a time is the last that began');
const wd = ctx._amWidths(m);
check(near(wd[0] + wd[1] + wd[2], 1, 1e-12) && near(wd[1], 0.5, 1e-12), 'the widths share the timeline by weight');
for (const t of [0, 50, 100, 250, 400, 700, 1000]) check(near(ctx._amTimeOf(m, ctx._amPosOf(m, t)), t, 1e-9), 'timeline position and time are inverses at ' + t);
check(near(ctx._amPosOf(m, 100), 0.25, 1e-12), 'a phase starts where the one before it ends');

// Elapsed time.
check(ctx._amMet(0) === 'T+0:00:00' && ctx._amMet(3723) === 'T+1:02:03' && ctx._amMet(-12) === 'T−0:00:12', 'elapsed time reads T+h:mm:ss, T− before zero');
check(ctx._amMet(102 * 3600 + 33 * 60 + 5) === 'T+102:33:05', 'and over a hundred hours still reads in hours');
check(ctx._amLabel({ k: 'x', en: 'Liftoff' }) === 'Liftoff', 'a label falls back on the data\'s English');

process.exit(failures ? 1 : 0);
