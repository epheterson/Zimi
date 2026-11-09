// The Almanac's launches (zimi/static/almanac-launchflight.js): the maths behind the ascent a launch draws, what a place
// sees of it, and the batch of satellites it leaves.
//
//   1. The launch azimuth, against flown missions: Apollo 11 (the mission report's 72.058 deg from LC-39A to the 32.521 deg
//      parking orbit), the ISS from Baikonur (Soyuz flies about 62.8 deg) and from the Cape (about 42-43 deg), the
//      polar launches from Vandenberg (south, 190-200 deg), an inclination below the pad's latitude (due east, flagged).
//   2. The Falcon 9 ascent: its published events (max-Q T+1:12, MECO T+2:30, SECO about T+8:45), the height and speed at
//      the end, the ground range at the end, the booster's landing at about 610 km, and the track starting at the pad.
//   3. What a place sees: nothing from 3,900 km away; the exhaust lit for a watcher in twilight and dark for one
//      in the night; the Sun's cylinder shadow; and the sight's classes.
//   4. The deployment: the mean-element J2 propagation against SGP4 (the vendored satellite.js) for the ISS's own
//      elements over three days, the string's length after a few days, the Starlink raising, the node drift of a 53 deg
//      shell against its published -4.5 deg/day.
//
// Run: node tests/test_almanac_launches.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'zimi', 'static');
const earthSrc = fs.readFileSync(path.join(STATIC, 'almanac-earth.js'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
function block(src, name) {
  const start = src.indexOf('var ' + name + ' = ');
  if (start < 0) throw new Error(name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) + ';';
  }
  throw new Error('unbalanced ' + name);
}
function line(src, name) {
  const m = new RegExp('^var ' + name + ' = [^;]+;', 'm').exec(src);
  if (!m) throw new Error(name + ' not found');
  return m[0];
}

const S = { Math, Date, Object, JSON, console, Number, Array, isNaN, Int32Array, Float64Array };
vm.createContext(S);
vm.runInContext(['AE_EARTH_RADIUS_KM', 'AE_GM_EARTH'].map((n) => line(earthSrc, n)).join('\n') + '\nvar MS_PER_DAY = 86400000;', S);
vm.runInContext(block(earthSrc, 'AE_LAUNCH_REF'), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-launchflight.js'), 'utf8'), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'earth', 'satellite-7.1.0.min.js'), 'utf8'), S);
const D = 180 / Math.PI;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. Azimuths ────────────────────────────────────────────────────────────
{
  const KSC = 28.608, apollo = S._lfAzimuth(KSC, 32.521, 185, false);
  check(near(apollo.az, 72.058, 1.5), 'Apollo 11 from LC-39A: ' + apollo.az.toFixed(2) + ' deg (flown 72.058)');
  const bai = S._lfAzimuth(45.92, 51.65, 300, false);
  check(near(bai.az, 62.8, 1.5), 'ISS from Baikonur: ' + bai.az.toFixed(2) + ' deg (Soyuz flies about 62.8)');
  const cape = S._lfAzimuth(KSC, 51.65, 300, false);
  check(near(cape.az, 42.8, 1.5), 'ISS from the Cape: ' + cape.az.toFixed(2) + ' deg (about 42-43)');
  const vsfb = S._lfAzimuth(34.63, 97.4, 520, S._lfSouth('Vandenberg', 97.4));
  check(vsfb.az > 190 && vsfb.az < 200, 'Sun-synchronous from Vandenberg flies south: ' + vsfb.az.toFixed(1) + ' deg');
  check(S._lfSouth('Vandenberg', 53) && !S._lfSouth('Plesetsk', 97) && S._lfSouth('Kourou', 97) && !S._lfSouth('Kourou', 5), 'the branch each site flies');
  const equator = S._lfAzimuth(28.5, 20, 300, false);
  check(!equator.reach && near(equator.az, 90, 8), 'an inclination below the latitude is flagged, and flown east-ish');
  const polar = S._lfAzimuth(34.63, 90, 400, true);
  check(polar.az > 170 && polar.az < 195, 'a polar orbit from Vandenberg heads a little west of south: ' + polar.az.toFixed(1) + ' deg');
  // The inertial azimuth is the textbook one.
  check(near(S._lfAzimuth(28.5, 51.6, 300, false).inertial, Math.asin(Math.cos(51.6 / D) / Math.cos(28.5 / D)) * D, 1e-9), 'inertial azimuth = asin(cos i / cos lat)');
}

// ── 2. The Falcon 9 ascent ─────────────────────────────────────────────────
const SLC40 = { name: 'Falcon 9', lat: 28.562, lon: -80.577, siteName: 'Canaveral', incDeg: 53.05, perigeeKm: 280, ok: true };
const flight = S._lfAscent(SLC40);
{
  const at = (t) => flight.points[t];
  check(flight.family === 'falcon', 'Falcon 9 flies its own profile');
  check(flight.points.length === 526 && at(0).h === 0 && near(at(0).lat, 28.562, 1e-9), 'the track starts at the pad, T+0 to T+525 each second');
  check(near(at(72).h, 12.5, 0.6) && near(at(72).v, 0.52, 0.05), 'max-Q at T+1:12: ' + at(72).h.toFixed(1) + ' km, ' + (at(72).v * 1000).toFixed(0) + ' m/s');
  check(near(at(150).h, 68, 2) && near(at(150).v, 2.1, 0.1), 'MECO at T+2:30: ' + at(150).h.toFixed(0) + ' km, ' + at(150).v.toFixed(2) + ' km/s');
  const end = at(525);
  check(near(end.h, 280, 2), 'the burn ends at the perigee asked for (' + end.h.toFixed(0) + ' km)');
  check(end.v > 7.2 && end.v < 7.5, 'with the speed of a 280 km orbit relative to the ground (' + end.v.toFixed(2) + ' km/s)');
  check(end.range > 1500 && end.range < 2600, 'about 2,000 km down range at orbit (' + end.range.toFixed(0) + ' km)');
  check(flight.az > 38 && flight.az < 46, 'azimuth for 53 deg from SLC-40: ' + flight.az.toFixed(1) + ' deg');
  check(end.lat > 28.562 && end.lon > -80.577, 'it flies north-east');
  const mono = flight.points.every((p, i) => i === 0 || (p.range >= flight.points[i - 1].range && p.v >= flight.points[i - 1].v - 0.05));
  check(mono, 'range grows and speed never falls by more than the coast');
  check(flight.events.map((e) => e.key).join() === 'liftoff,maxq,meco,stage2,fairing,seco', 'events: ' + flight.events.map((e) => e.key + '@' + e.t).join(' '));
  const b = flight.booster, landing = b[b.length - 1];
  check(b && landing.h === 0 && near(S._lfGroundKm(28.562, -80.577, landing.lat, landing.lon), 610, 15), 'the booster lands on a ship about 610 km away');
  check(b.some((p) => p.burn === 3) && b.some((p) => p.burn === 4) && Math.max.apply(null, b.map((p) => p.h)) > 130, 'with an entry burn, a landing burn and an apogee near 140 km');
  const failed = S._lfAscent(Object.assign({}, SLC40, { ok: false }));
  check(failed.stop === 150 && !failed.insertion && !failed.booster, 'a failed launch is drawn to the end of its first stage and no further');
  const unknown = S._lfAscent({ name: 'Mystery', lat: 10, lon: 20, siteName: 'X', incDeg: null, perigeeKm: null, ok: true });
  check(unknown.guessed && near(unknown.az, 90, 3) && unknown.family === 'typical', 'no orbit known: due east, said so');
  const shuttle = S._lfAscent({ name: 'Space Shuttle', lat: 28.6, lon: -80.6, siteName: 'Kennedy', incDeg: 51.6, perigeeKm: 160, ok: true });
  check(shuttle.family === 'shuttle' && near(shuttle.tEnd, 510, 1), 'a Shuttle burns to T+8:30');
}

// ── 3. What a place sees ───────────────────────────────────────────────────
{
  // From California the Cape's ascent is under the horizon: 3,600 km away, 280 km up at most.
  const t0 = Date.UTC(2021, 4, 9, 6, 42);
  const far = S._lfObserve(flight, SLC40, t0, 37.19, -121.55);
  check(!far.seen && far.padKm > 3500 && far.padKm < 4000, 'not visible from 3,600 km away (' + far.padKm.toFixed(0) + ' km)');
  // From Daytona Beach, 90 km up the coast, it is.
  const near1 = S._lfObserve(flight, SLC40, t0, 29.2, -81.0);
  check(near1.seen && near1.peak.el > 20, 'seen from the coast 130 km north: peak ' + (near1.peak ? near1.peak.el.toFixed(0) : '-') + ' deg');
  // The Sun's shadow: straight overhead at 100 km with the Sun 6 deg down is lit, with the Sun 20 deg down it is not.
  const ms = Date.UTC(2023, 2, 20, 12, 0), sun = S._lfSunUnit(ms), gm = S._lfGmst(ms);
  // A place whose Sun is `alt` degrees up: step along the meridian from the subsolar point.
  const sub = { lat: Math.asin(sun[2]) * D, lon: ((Math.atan2(sun[1], sun[0]) - gm) * D + 540) % 360 - 180 };
  const downAt = (alt) => S._lfEci(sub.lat, sub.lon + 90 - alt, 0, gm);   // 90 - alt degrees of arc from the subsolar point, along the parallel
  const upRocket = (alt, h) => { const p = downAt(alt), s = 1 + h / S.LF_MEAN_RADIUS_KM; return [p[0] * s, p[1] * s, p[2] * s]; };
  const dipDeg = Math.acos(S.LF_MEAN_RADIUS_KM / (S.LF_MEAN_RADIUS_KM + 100)) * D;
  check(dipDeg > 9.5 && dipDeg < 10.5, 'the horizon dips 10 degrees at 100 km (' + dipDeg.toFixed(2) + ')');
  check(S._lfSunlit(upRocket(-6, 100), sun) && !S._lfSunlit(upRocket(-14, 100), sun), 'a rocket at 100 km is in sunlight with the Sun 6 deg down below it, in shadow at 14 deg down');
  check(S._lfSunlit(upRocket(-6, 0), sun) === false && S._lfSunlit(upRocket(10, 0), sun) === true, 'the ground is dark with the Sun down and lit with it up');
  check(near(S._lfSunAlt(ms, sub.lat, sub.lon), 90, 0.5), 'the Sun is overhead at its own subsolar point');
  // The classes of sight.
  check(S._lfSight(true, true, -8, 30, 90) === 'jellyfish', 'a lit exhaust in twilight is the jellyfish');
  check(S._lfSight(true, false, -30, 30, 90) === 'flame', 'an engine alone in the night is a flame');
  check(S._lfSight(true, true, -8, 30, 10) === 'flame', 'low down the exhaust is a flame, not a cloud');
  check(S._lfSight(false, true, -8, 30, 150) === 'dot', 'a lit stage coasting is a dot');
  check(S._lfSight(true, true, 20, 30, 90) === 'day', 'in daylight a bright point and a trail');
  check(S._lfSight(true, true, -8, -2, 90) === 'below', 'under the horizon is not seen');
  check(S._lfSight(false, false, -30, 30, 150) === 'below', 'a coasting stage in the dark is not seen');
  // A well-placed watcher: 2022-10-... style twilight from Los Angeles of a Vandenberg launch.
  const VS = { name: 'Falcon 9', lat: 34.632, lon: -120.611, siteName: 'Vandenberg', incDeg: 53.2, perigeeKm: 300, ok: true };
  const vf = S._lfAscent(VS);
  check(vf.az > 130 && vf.az < 160, 'a 53 deg launch from Vandenberg flies south-east: ' + vf.az.toFixed(0) + ' deg');
  const la = S._lfObserve(vf, VS, Date.UTC(2023, 0, 1, 1, 0), 34.05, -118.24);
  check(la.seen && la.first.az > 250 && la.first.az < 300, 'from Los Angeles it rises west-north-west of the watcher (' + (la.first ? la.first.az.toFixed(0) : '-') + ' deg)');
}

// ── 4. The deployment ──────────────────────────────────────────────────────
{
  // The mean-element propagation against SGP4, for the ISS's own element set in the repository's reference.
  const iss = JSON.parse(fs.readFileSync(path.join(ROOT, 'zimi', 'assets', 'satellites-snapshot.json'), 'utf8')).iss;
  const rec = S.SatelliteJS ? S.SatelliteJS.json2satrec(iss) : S.satellite.json2satrec(iss);
  const lib = S.SatelliteJS || S.satellite;
  const epoch = Date.parse(iss.EPOCH.replace(/Z?$/, 'Z')), inc = iss.INCLINATION / D;
  const n = iss.MEAN_MOTION * 2 * Math.PI / 86400, a = Math.cbrt(S.AE_GM_EARTH / (n * n));
  // TLE mean motion already carries the bulge's share of the mean anomaly's rate (Kozai), so the argument of latitude
  // moves at that plus the perigee's drift; the node's drift is _lfRates'. A circular orbit of height h given as a
  // radius uses _lfRates' own sum, which the two agree with to the bulge's second order.
  const q = S.AE_EARTH_RADIUS_KM / a, J2 = S.LF_J2;
  const r = { u: n * (1 + 0.75 * J2 * q * q * (4 - 5 * Math.sin(inc) ** 2)), node: S._lfRates(a, inc).node };
  const u0 = (iss.ARG_OF_PERICENTER + iss.MEAN_ANOMALY) / D, node0 = iss.RA_OF_ASC_NODE / D;
  const worst = {};
  for (const days of [0.5, 1, 3]) {
    const dt = days * 86400, ms = epoch + dt * 1000, u = u0 + r.u * dt, node = node0 + r.node * dt;
    const mine = [a * (Math.cos(node) * Math.cos(u) - Math.sin(node) * Math.cos(inc) * Math.sin(u)),
      a * (Math.sin(node) * Math.cos(u) + Math.cos(node) * Math.cos(inc) * Math.sin(u)), a * Math.sin(inc) * Math.sin(u)];
    const pv = lib.sgp4(rec, (ms - epoch) / 60000), p = pv.position;
    worst[days] = Math.hypot(mine[0] - p.x, mine[1] - p.y, mine[2] - p.z);
  }
  check(worst[0.5] < 20 && worst[1] < 35 && worst[3] < 90, 'mean-element J2 against SGP4 for the ISS (the rest is its drag): ' + [0.5, 1, 3].map((d) => d + ' d ' + worst[d].toFixed(0) + ' km').join(', '));
  // The node's drift for a 53 deg Starlink shell at 550 km: about -4.5 deg/day (it is why the shells are staggered).
  const shell = S._lfRates(S.AE_EARTH_RADIUS_KM + 550, 53 / D);
  check(near(shell.node * 86400 * D, -4.5, 0.2), 'node drift at 550 km, 53 deg: ' + (shell.node * 86400 * D).toFixed(2) + ' deg/day');
  check(near(shell.u * 5700 * D / 360, 1, 0.01) || shell.u > 0, 'the argument of latitude advances with the orbit');
  // A Starlink batch: deployed 63 minutes after lift-off, raised after two days of checks.
  const L = { mission: 'Starlink V1.0-L25', inc: 53.05, n: 60, depKm: 275 };
  const t0 = Date.UTC(2021, 4, 4, 19, 1);
  const dep = S._lfDeploy(L, flight, t0, 63);
  const hours = (h) => t0 + 63 * 60000 + h * 3600000;
  check(dep.shellKm === 550 && dep.heightKm(hours(1)) === 275 && dep.heightKm(hours(24 * 10)) > 275 && dep.heightKm(hours(24 * 90)) === 550, 'raised from 275 to 550 km after the checks');
  check(dep.raising(hours(24 * 10)) && !dep.raising(hours(24)) && !dep.raising(hours(24 * 90)), 'and the raising is said to be under way only while it is');
  const radius = (ms, k) => Math.hypot.apply(null, dep.at(ms, k));
  check(near(radius(hours(0), 30), S.AE_EARTH_RADIUS_KM + 275, 3.5), 'at release the batch is at its height (' + (radius(hours(0), 30) - S.AE_EARTH_RADIUS_KM).toFixed(0) + ' km)');
  const spread = (ms) => {
    const first = dep.at(ms, 0), last = dep.at(ms, 59);
    const c = (first[0] * last[0] + first[1] * last[1] + first[2] * last[2]) / Math.hypot.apply(null, first) / Math.hypot.apply(null, last);
    return Math.acos(Math.min(1, c)) * D;
  };
  check(spread(hours(0.1)) < 1 && spread(hours(72)) > 8 && spread(hours(72)) < 30, 'the string is a point at release and some tens of degrees long after three days (' + spread(hours(72)).toFixed(0) + ' deg)');
  // The plane of the batch is the inclination asked for.
  const p1 = dep.at(hours(5), 30), p2 = dep.at(hours(5.4), 30);
  const nrm = [p1[1] * p2[2] - p1[2] * p2[1], p1[2] * p2[0] - p1[0] * p2[2], p1[0] * p2[1] - p1[1] * p2[0]];
  const inclination = Math.acos(Math.abs(nrm[2]) / Math.hypot.apply(null, nrm)) * D;
  check(near(inclination, 53.05, 0.5), 'the batch lies in a plane inclined ' + inclination.toFixed(2) + ' deg');
  // Seen from the Cape's own latitude band a few hours later the pass has a height and a bearing.
  const seen = S._lfSeenFrom(dep.at(hours(2), 30), hours(2), 28.5, -80.6);
  check(typeof seen.el === 'number' && seen.range > 0 && typeof seen.lit === 'boolean', 'a position can be seen from a place');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
