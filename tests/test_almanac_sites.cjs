// The landing sites of the 3D view (zimi/static/almanac-sites*.js): the numbers under the picture, without a browser.
// The rendered page is tests/test_almanac_sites_browser.py.
//
//   1. The Saturn V's launch is its own equations (thrust over a mass that burns, gravity, drag, the pitch program) and
//      reads like Apollo 11's: clear of the tower in about 12 s, near 67 km up, 91 km downrange and 2.4 km/s at the
//      first stage's cut-off.
//   2. The ground: level at the lander, the body's curve away from it, the same height every time it is asked.
//   3. A rover's wheels: on flat ground it sits level; on a slope it tilts to the slope; the wheels stand on it.
//   4. The frame of a site: east, north and up at a latitude and longitude, and back from a place in it to the same
//      latitude and longitude.
//
// Run: node tests/test_almanac_sites.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', f), 'utf8');
const ctx = {
  console, Math, window: {}, performance: { now: () => 0 },
  AE_EARTH_RADIUS_KM: 6378.137,
  _ae: { gl: { planets: {} } },
  _aeSunShown: () => [100, 0, 0],
  _aeRad: (d) => d * Math.PI / 180,
  _aeDeg: (r) => r * 180 / Math.PI,
  _smoothstep: (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
  _aeClamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  _aeDot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  _aeLen: (a) => Math.hypot(a[0], a[1], a[2]),
  _aeNorm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  _aeCross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  _aeAdd: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  _aeSub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  _aeScale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  _aeLatLonVec: (lat, lon) => { const la = lat * Math.PI / 180, lo = lon * Math.PI / 180; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; }
};
vm.createContext(ctx);
for (const f of ['almanac-sites.js', 'almanac-sites-ground.js', 'almanac-sites-drive.js', 'almanac-sites-launch.js']) vm.runInContext(read(f), ctx, { filename: f });
const S = (name) => vm.runInContext(name, ctx);

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── 1. The launch ──
{
  const pad = 5, rows = S('_asLaunchFlight')(72, pad), at = (t) => rows[Math.round(t / 0.05)];
  const alt = (t) => at(t).z - pad, down = (t) => Math.hypot(at(t).x, at(t).y);
  check(alt(0) < 1 && at(0).v === 0, 'held on the pad at t = 0');
  check(alt(12) > 100 && alt(12) < 220, 'clear of the 122 m tower after 12 s (' + alt(12).toFixed(0) + ' m)');
  check(near(alt(161) / 1000, 67, 6), 'about 67 km up at the first stage cut-off (' + (alt(161) / 1000).toFixed(1) + ' km)');
  check(near(down(161) / 1000, 91, 8), 'about 91 km downrange at cut-off (' + (down(161) / 1000).toFixed(1) + ' km)');
  check(near(at(161).v, 2380, 200), 'about 2.4 km/s at cut-off (' + at(161).v.toFixed(0) + ' m/s)');
  check(at(30).tilt > 0.1 && at(30).tilt < 0.3, 'pitched over by half a minute in (' + (at(30).tilt * 180 / Math.PI).toFixed(1) + ' degrees)');
  const east = at(120);
  check(Math.atan2(east.x, east.y) * 180 / Math.PI > 70 && Math.atan2(east.x, east.y) * 180 / Math.PI < 74, 'flies out on the azimuth it was given (72 degrees)');
  let steady = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].z < rows[i - 1].z - 1e-6 && rows[i].t < 160) steady = false;
  check(steady, 'climbs all the way to cut-off');
}

// ── 2. The ground ──
const moon = { info: { relief: 0.45, craters: 1 }, radiusM: 1737400, terrain: null };
{
  const h = S('_asGroundAt');
  check(Math.abs(h(moon, 0, 0, false)) < 1e-9, 'level at the lander');
  check(near(h(moon, 3000, 0, true), -(3000 * 3000) / (2 * 1737400), 2), 'falls away with the body\'s curve (a Moon horizon 3 km off is 2.6 m down)');
  check(h(moon, 71.3, -28.2, false) === h(moon, 71.3, -28.2, false), 'the same height each time it is asked');
  let big = 0;
  for (let i = 0; i < 400; i++) big = Math.max(big, Math.abs(h(moon, -300 + (i % 20) * 30, -300 + Math.floor(i / 20) * 30, false) + (((-300 + (i % 20) * 30) ** 2 + (-300 + Math.floor(i / 20) * 30) ** 2) / (2 * 1737400))));
  check(big < 4, 'the ground within 300 m has a swell of a few metres at most (' + big.toFixed(2) + ' m)');
  const hash = S('_asHash');
  let ok = true;
  for (let i = 0; i < 200; i++) { const v = hash(i * 7 - 300, i * 13, 5); if (!(v >= 0 && v < 1)) ok = false; }
  check(ok, 'the hash is in [0, 1)');
}

// ── 3. The wheels ──
{
  const flat = { info: { relief: 0, craters: 0 }, radiusM: 1e12, terrain: null };
  const at = [[-0.9, 1.15, 0.41], [0.9, 1.15, 0.41], [-0.9, -1.15, 0.41], [0.9, -1.15, 0.41]];
  const g = S('_asWheelsGround')(flat, at, 5, 5, 0.7);
  check(Math.abs(g.pitch) < 1e-9 && Math.abs(g.roll) < 1e-9 && Math.abs(g.mean) < 1e-9, 'on flat ground a rover sits level');
  const slope = { info: { relief: 0, craters: 0 }, radiusM: 1e12, terrain: (x, y) => 0.2 * y };   // a 20 % grade rising north
  const s0 = S('_asWheelsGround')(slope, at, 0, 10, 0);
  check(near(s0.pitch, Math.atan(0.2), 1e-6) && Math.abs(s0.roll) < 1e-9, 'facing uphill it tilts nose up by the grade (' + (s0.pitch * 180 / Math.PI).toFixed(1) + ' degrees)');
  check(near(s0.mean, 2, 1e-9), 'and rides the mean of the ground under its wheels');
  const s1 = S('_asWheelsGround')(slope, at, 0, 10, Math.PI / 2);
  check(Math.abs(s1.pitch) < 1e-9 && near(Math.abs(s1.roll), Math.atan(0.2), 1e-6), 'across the slope it rolls instead');
}

// ── 4. The frame ──
{
  const body = { key: 'moon', center: [60, 0, 0], r: 0.27, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] };
  const st = { lat: 20, lon: 30, body: 'moon' };
  const fr = S('_asFrame')(st, body, { ms: 0 });   // the Sun is read from the frame's own stub below
  st.fr = fr;
  const dir = ctx._aeLatLonVec(20, 30);
  check(near(ctx._aeDot(fr.u, dir), 1, 1e-9), 'up is the direction of the latitude and longitude');
  check(near(ctx._aeDot(fr.e, fr.u), 0, 1e-9) && near(ctx._aeDot(fr.n, fr.u), 0, 1e-9) && near(ctx._aeDot(fr.e, fr.n), 0, 1e-9), 'east, north and up are at right angles');
  check(fr.n[2] > 0.9 && fr.e[2] === 0 || near(fr.e[2], 0, 1e-12), 'north points toward the pole, east along the parallel');
  const back = S('_asLatLon')(st, body, [0, 0, 0]);
  check(near(back.lat, 20, 1e-6) && near(back.lon, 30, 1e-6), 'the origin of the frame is the site\'s latitude and longitude');
  const R = 0.27 * 6378.137 * 1000, north = S('_asLatLon')(st, body, [0, 1000, 0]);
  check(near(north.lat - 20, (1000 / R) * 180 / Math.PI, 5e-4) && near(north.lon, 30, 1e-3), '1 km north is a kilometre\'s worth of latitude');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
