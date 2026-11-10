// Stand at the pad's maths (zimi/static/almanac-padview.js), run from the shipped files without a browser: the pad's frame from the
// mission's own table, the first seconds of the climb the table is too coarse for, the moment the tower is cleared, the vehicle's
// attitude. The data is the mission player's (static/earth/missions-v1.json); nothing here is a second trajectory.
//
// Run: node tests/test_almanac_padview.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const missions = read('almanac-missions.js'), pad = read('almanac-padview.js');
const mCut = missions.indexOf('// ── Where a vehicle is, in the scene ──'), pCut = pad.indexOf('// ── Entry ──');
if (mCut < 0 || pCut < 0) throw new Error('a pure section moved');

const ctx = { Math, Object, Array, String, JSON };
vm.createContext(ctx);
vm.runInContext([
  'var AE_EARTH_RADIUS_KM = 6378.137, AE_SITE_FACTS = { launchTowerM: 122 }; function _aeT(k) { return k; }',
  'function _aeDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }',
  'function _aeLen(a) { return Math.sqrt(_aeDot(a, a)); }',
  'function _aeScale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }',
  'function _aeNorm(a) { return _aeScale(a, 1 / _aeLen(a)); }',
  'function _aeAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }',
  'function _aeSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }',
  'function _aeCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }',
  missions.slice(0, mCut), pad.slice(0, pCut)].join('\n'), ctx);
ctx._amData = JSON.parse(read('earth/missions-v1.json'));

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// The published pads and launch azimuths (NASA: LC-39A 28.6082 N 80.6041 W, Apollo 11 azimuth 72 degrees at the pad; Mars 2020 launched on 93).
const PADS = { apollo11: { lat: 28.6083, lon: -80.6041, az: 72 }, perseverance: { lat: 28.5833, lon: -80.5828, az: 93 } };
Object.keys(PADS).forEach((id) => {
  const cfg = ctx.PV_PADS[id], P = ctx._pvPrepare(cfg), want = PADS[id], stack = P.stack;
  check(near(P.lat, want.lat, 0.003) && near(P.lon, want.lon, 0.003), id + ': the table\'s first row is on the pad (' + P.lat.toFixed(4) + ', ' + P.lon.toFixed(4) + ')');
  const rest = ctx._pvVehicleAt(P, stack, P.tLift - 5);
  check(rest.p[0] === 0 && rest.p[1] === 0 && near(rest.p[2], P.z0, 1e-9) && rest.v[2] === 0, id + ': it stands still on the pad until lift-off');
  // The first seconds are continuous with the table where the fit meets it.
  const t1 = P.fit.t1, before = ctx._pvVehicleAt(P, stack, t1 - 1e-6), after = ctx._pvVehicleAt(P, stack, t1 + 1e-6);
  const dp = Math.hypot(before.p[0] - after.p[0], before.p[1] - after.p[1], before.p[2] - after.p[2]), dv = Math.hypot(before.v[0] - after.v[0], before.v[1] - after.v[1], before.v[2] - after.v[2]);
  check(dp < 0.1 && dv < 3, id + ': the fit meets the table at T+' + t1 + ' s (' + dp.toExponential(1) + ' m, ' + dv.toFixed(2) + ' m/s apart)');
  // It rises, and never goes back down, from lift-off to the minute after the fit.
  let rising = true, last = -1e9, maxLean = 0;
  for (let t = P.tLift; t <= t1 + 60; t += 0.25) {
    const s = ctx._pvVehicleAt(P, stack, t);
    if (s.p[2] < last - 1e-6) rising = false;
    last = s.p[2];
    if (t < P.tLift + 8) maxLean = Math.max(maxLean, Math.atan2(Math.hypot(s.v[0], s.v[1]), s.v[2]) * 180 / Math.PI);
  }
  check(rising, id + ': its height only grows from lift-off to a minute after the fit');
  check(maxLean < 3, id + ': it climbs straight up for the first 8 s (lean at most ' + maxLean.toFixed(2) + ' degrees)');
  check(near(P.azimuth, want.az, 8), id + ': the launch azimuth read from the table is ' + P.azimuth.toFixed(1) + ' (published ' + want.az + ')');
  check(P.clearS > P.tLift + 3 && P.clearS < P.tLift + 14, id + ': the tower is cleared at T+' + P.clearS.toFixed(1) + ' s');
  check(P.events.some((e) => e.text === 'alm_pad_ignition') === (id === 'apollo11') && P.events.some((e) => e.text === 'alm_pad_cleared'), id + ': its events are the mission\'s own and the tower\'s');
  // The attitude: nose up on the pad, a right-handed frame of unit vectors, the nose along the path once it is moving.
  const bUp = ctx._pvBasis(P, [0, 0, 0]);
  check(near(bUp.y[2], 1, 1e-9) && near(ctx._aeLen(bUp.z), 1, 1e-9) && near(ctx._aeDot(bUp.y, bUp.z), 0, 1e-9), id + ': on the pad the nose is vertical and the frame is square');
  const mv = ctx._pvVehicleAt(P, stack, t1 + 30), bm = ctx._pvBasis(P, mv.v), vh = ctx._aeNorm(mv.v);
  check(near(ctx._aeDot(bm.y, vh), 1, 1e-6) && near(ctx._aeDot(ctx._aeCross(bm.x, bm.y), bm.z), 1, 1e-9), id + ': in flight the nose is along the path and the frame is right-handed');
});

// The pad's own geometry: the foot of the table's first row is on the ellipsoid, the Atlas V's origin (its spacecraft) 47 m above it.
const A = ctx._pvPrepare(ctx.PV_PADS.apollo11), M = ctx._pvPrepare(ctx.PV_PADS.perseverance);
check(near(A.z0, 0, 0.5), 'Apollo 11\'s origin is at the pad\'s ground (' + A.z0.toFixed(2) + ' m)');
check(near(M.z0, 46.7, 1), 'Mars 2020\'s origin is its spacecraft, 47 m over the pad (' + M.z0.toFixed(1) + ' m), the parts hang from it');
check(ctx._pvCountText(-30) === 'T−0:30' && ctx._pvCountText(12) === 'T+0:12' && ctx._pvCountText(-3).charAt(0) === 'T', 'the count reads T−0:30 before zero, T+0:12 after');

process.exit(failures ? 1 : 0);
