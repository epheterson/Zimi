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
vm.runInContext(block(earthSrc, 'AE_SATS_REF') + block(earthSrc, 'AE_LAUNCH_REF'), S);
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
  check(flight.points.length === 527 && at(0).h === 0 && near(at(0).lat, 28.562, 1e-9), 'the track starts at the pad, T+0 to T+526 each second');
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
  check(flight.events.map((e) => e.key).join() === 'liftoff,maxq,meco,sep,stage2,fairing,seco', 'events: ' + flight.events.map((e) => e.key + '@' + e.t).join(' '));
  const b = flight.booster, landing = b[b.length - 1];
  check(b && landing.h === 0 && near(S._lfGroundKm(28.562, -80.577, landing.lat, landing.lon), 610, 15), 'the booster lands on a ship about 610 km away');
  check(b.some((p) => p.burn === 3) && b.some((p) => p.burn === 4) && Math.max.apply(null, b.map((p) => p.h)) > 130, 'with an entry burn, a landing burn and an apogee near 140 km');
  const failed = S._lfAscent(Object.assign({}, SLC40, { ok: false }));
  check(failed.stop === 151 && !failed.insertion && !failed.booster, 'a failed launch is drawn to the end of its first stage and no further');
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
  check(spread(hours(0.1)) < 1 && spread(hours(72)) > 1 && spread(hours(72)) < 6, 'the string is a point at release and a few degrees long after three days (' + spread(hours(72)).toFixed(0) + ' deg)');
  // The plane of the batch is the inclination asked for.
  const p1 = dep.at(hours(5), 30), p2 = dep.at(hours(5.4), 30);
  const nrm = [p1[1] * p2[2] - p1[2] * p2[1], p1[2] * p2[0] - p1[0] * p2[2], p1[0] * p2[1] - p1[1] * p2[0]];
  const inclination = Math.acos(Math.abs(nrm[2]) / Math.hypot.apply(null, nrm)) * D;
  check(near(inclination, 53.05, 0.5), 'the batch lies in a plane inclined ' + inclination.toFixed(2) + ' deg');
  // Seen from the Cape's own latitude band a few hours later the pass has a height and a bearing.
  const seen = S._lfSeenFrom(dep.at(hours(2), 30), hours(2), 28.5, -80.6);
  check(typeof seen.el === 'number' && seen.range > 0 && typeof seen.lit === 'boolean', 'a position can be seen from a place');
}


// ── 5. Against documented reality ──────────────────────────────────────────
{
  // SpaceX's timeline for Starlink 4-9 (Spaceflight Now, 2022-03-03): max-Q 1:12, MECO 2:31, stage separation 2:35, second
  // stage ignition 2:42, fairing 2:47, entry burn 6:49 to 7:09, landing burn 8:25, SECO 8:46, landing 8:47.
  const at = Object.fromEntries(flight.events.map((e) => [e.key, e.t]));
  check(at.maxq === 72 && at.meco === 151 && at.sep === 155 && at.stage2 === 162 && at.fairing === 167 && at.seco === 526, 'the Falcon 9 events are the ones SpaceX printed for Starlink 4-9');
  const b = flight.booster;
  check(b[0].t === 155 && b[b.length - 1].t === 527 && b.find((p) => p.burn === 3).t === 409 && b.filter((p) => p.burn === 3).pop().t === 429 && b.find((p) => p.burn === 4).t === 505, 'and the booster: entry burn 6:49 to 7:09, landing burn 8:25, landing 8:47');
  // The first Starlink train of 2021 (launch 25, 4 May 19:01 UTC), as reported: KCRA, Sacramento, 7 May 2021: from Grass Valley
  // "soon after 9 p.m." on Thursday 6 May, "a line of lights moving across the sky in a northeasterly direction", for "maybe
  // two minutes". Tolerance: the pass starts between 9:00 and 9:30 pm PDT and ends in the north-east to east.
  const GCAT_L25 = { mission: 'Starlink V1.0-L25', inc: 53.05, n: 60, depKm: 268.5 };   // GCAT's first orbit for the batch: 261 x 276 km
  const t0 = Date.UTC(2021, 4, 4, 19, 1);
  const f25 = S._lfAscent({ name: 'Falcon 9', lat: 28.608, lon: -80.604, siteName: 'Kennedy', incDeg: 53.05, perigeeKm: 261, ok: true });
  const d25 = S._lfDeploy(GCAT_L25, f25, t0, 63);
  const gv = S._lfBatchWindows(d25, Date.UTC(2021, 4, 7, 2, 0), Date.UTC(2021, 4, 7, 8, 0), 39.22, -121.06, 5, 10000);
  const pdt = (ms) => new Date(ms - 7 * 3600000).toISOString().slice(11, 16);
  check(gv.length === 1 && pdt(gv[0].start) >= '21:00' && pdt(gv[0].start) <= '21:30' && gv[0].azEnd > 45 && gv[0].azEnd < 90 && gv[0].count > 30,
    'launch 25 from Grass Valley on 6 May: ' + (gv[0] ? pdt(gv[0].start) + ' pm PDT, to ' + gv[0].azEnd.toFixed(0) + ' deg, ' + gv[0].count + ' satellites' : 'nothing'));
  // Starlink raises itself to its shell about 45 days after release (McDowell et al. 2020, ApJL 892 L6).
  check(Math.abs((d25.raiseDoneMs - d25.sepMs) / 86400000 - 45) < 0.01, 'the batch reaches its shell 45 days after release');
  // The Long March 5B core stage (2021-035B, NORAD 48275), from a TLE of 8 May 2021 20:34 UTC (karhukoti.com's copy of the
  // Space-Track set, 16.44 rev/day, B* 1.9e-4): for a place at 37.0 N, 121.5 W it was not up and lit over 5 degrees in the
  // evening of 7 May (to 10 pm PDT), and was at dawn on 8 May (about 04:32 PDT, in the east).
  const lib = S.SatelliteJS;
  const rec = lib.json2satrec({ OBJECT_NAME: 'CZ-5B R/B', NORAD_CAT_ID: 48275, EPOCH: '2021-05-08T20:34:12.100Z', MEAN_MOTION: 16.44362448, ECCENTRICITY: 0.0029099, INCLINATION: 41.4573, RA_OF_ASC_NODE: 159.7603, ARG_OF_PERICENTER: 247.8635, MEAN_ANOMALY: 292.7779, BSTAR: 1.9011e-4, MEAN_MOTION_DOT: 0.10495065, MEAN_MOTION_DDOT: 0.80719e-5 });
  const epoch = Date.parse('2021-05-08T20:34:12.1Z');
  const seeLit = (a, c) => {
    const out = [];
    for (let ms = a; ms < c; ms += 30000) {
      const pv = lib.sgp4(rec, (ms - epoch) / 60000), w = S._lfWatcher(ms, 37.0, -121.5), v = S._lfSeenBy(w, [pv.position.x, pv.position.y, pv.position.z]);
      if (v.el > 5 && v.lit && w.sunAlt < -6) out.push(ms);
    }
    return out;
  };
  check(seeLit(Date.UTC(2021, 4, 8, 2, 0), Date.UTC(2021, 4, 8, 5, 0)).length === 0, 'the Long March 5B stage was not seen on the evening of 7 May');
  const dawn = seeLit(Date.UTC(2021, 4, 8, 10, 0), Date.UTC(2021, 4, 8, 14, 0));
  check(dawn.length >= 3 && pdt(dawn[0]) >= '04:30' && pdt(dawn[0]) <= '04:35', 'but at dawn on 8 May: ' + (dawn.length ? pdt(dawn[0]) + ' PDT' : 'never'));
}

// ── 6. A moment to stand in ────────────────────────────────────────────────
{
  const L = { tag: '2022-141', name: 'Falcon 9', mission: 'Starlink Group 4-31', ms: Date.UTC(2022, 9, 28, 1, 14), lat: 34.632, lon: -120.611, siteName: 'Vandenberg', incDeg: 53.2, perigeeKm: 230, ok: true };
  const f = S._lfAscent(L), seen = S._lfObserve(f, L, L.ms, 34.05, -118.24);
  const m = S._lfThen(L, { name: 'Los Angeles', lat: 34.05, lon: -118.24 }, seen);
  check(m && m.id === 'launch:2022-141:34.05,-118.24' && m.family === 'launch' && m.place.name === 'Los Angeles' && m.instant > L.ms && m.look.az > 200 && m.look.az < 240 && m.see === 'jellyfish' && m.source.licence === 'CC BY 4.0',
    'a launch seen from Los Angeles is a moment: ' + (m ? m.id + ' at +' + (m.instant - L.ms) / 1000 + ' s, face ' + m.look.az.toFixed(0) : 'none'));
  check(S._lfThen(L, { lat: 28, lon: -80 }, { seen: false }) === null, 'and one that could not be seen is not');
  // The shipped entry for it (earth/thens-v1.json; its id is the slug the then_<slug> strings are keyed by, not the computed one) is what the code computes, and carries its sources.
  const shipped = JSON.parse(fs.readFileSync(path.join(STATIC, 'earth', 'thens-v1.json'), 'utf8')).moments[0];
  check(shipped.id === 'launch-starlink-4-31-la' && Math.abs(shipped.instant - m.instant) <= 10000 && Math.abs(shipped.look.az - m.look.az) < 3 && shipped.see === m.see && shipped.refs.length === 2 && /^https:/.test(shipped.refs[0]),
    'the shipped there-and-then for Los Angeles is the computed one: ' + new Date(shipped.instant).toISOString() + ', face ' + shipped.look.az.toFixed(0) + ' at ' + shipped.look.el.toFixed(0) + ' deg');
}


// ── 7. For a sky that draws what it is given ───────────────────────────────
{
  const L = { tag: '2022-141', name: 'Falcon 9', mission: 'Starlink Group 4-31', ms: Date.UTC(2022, 9, 28, 1, 14), lat: 34.632, lon: -120.611, siteName: 'Vandenberg', incDeg: 53.2, perigeeKm: 230, ok: true };
  const f = S._lfAscent(L), LA = [34.05, -118.24];
  check(S._lfSkyRocket(f, L, L.ms - 5000, LA[0], LA[1]) === null && S._lfSkyRocket(f, L, L.ms + 600000, LA[0], LA[1]) === null, 'no rocket before lift-off or after the burn');
  const seen = S._lfObserve(f, L, L.ms, LA[0], LA[1]);
  const r = S._lfSkyRocket(f, L, L.ms + 150000, LA[0], LA[1]);
  const sample = seen.samples[150];
  check(r && r.kind === 'rocket' && Math.abs(r.az - sample.az) < 1e-6 && Math.abs(r.el - sample.el) < 1e-6 && r.sight === sample.sight, 'the rocket at T+150 s is where _lfObserve puts it (' + (r ? r.az.toFixed(0) + ' deg, ' + r.el.toFixed(0) + ' deg, ' + r.sight : 'none') + ')');
  check(r.sight === 'jellyfish' && r.mag === S.AE_LAUNCH_REF.sightMag.jellyfish && r.trail.length > 3 && r.trail.every((q) => q.el >= 0), 'a lit exhaust in twilight: its magnitude, and a trail of earlier places');
  const far = S._lfSkyRocket(f, L, L.ms + 150000, 37.19, -121.55 + 40);
  check(far === null, 'and nothing from a place that cannot see it');
  // The Starlink 4-31 batch: seen from Los Angeles in the evenings after, as points with magnitudes.
  const L25 = { mission: 'Starlink V1.0-L25', inc: 53.05, n: 60, depKm: 268.5 }, t25 = Date.UTC(2021, 4, 4, 19, 1);
  const dep = S._lfDeploy(L25, S._lfAscent({ name: 'Falcon 9', lat: 28.608, lon: -80.604, siteName: 'Kennedy', incDeg: 53.05, perigeeKm: 261, ok: true }), t25, 63), GV = [39.22, -121.06];
  const wins = S._lfBatchWindows(dep, Date.UTC(2021, 4, 7, 2, 0), Date.UTC(2021, 4, 7, 8, 0), GV[0], GV[1], 10, 30000);
  check(S._lfSkyBatch(dep, t25 + 60000, GV[0], GV[1]).length === 0, 'no satellites before release');
  const at = wins.length ? wins[0].peakMs : 0, sats = S._lfSkyBatch(dep, at, GV[0], GV[1]);
  check(sats.length > 0 && sats.every((v) => v.kind === 'sat' && v.el >= 0 && isFinite(v.mag) && v.mag > -2 && v.mag < 8 && v.km > 250 && v.km < 600), 'the batch at its best pass is ' + sats.length + ' points with magnitudes ' + (sats.length ? Math.min.apply(null, sats.map((v) => v.mag)).toFixed(1) + ' to ' + Math.max.apply(null, sats.map((v) => v.mag)).toFixed(1) : '-'));
  check(S._lfSkyBatch(dep, Date.UTC(2021, 4, 7, 20, 0), GV[0], GV[1]).length === 0, 'and none in daylight');
  // The brightness: Mallama (2020) puts a v1.0 Starlink on station at 550 km at magnitude 4.6 (quarter phase); range scales it by 5 log
  // of the distance, and while it is raised it is brighter by 1.5 (Tregloan-Reed et al. 2020), which makes a days-old string, overhead
  // at about 290 km, magnitude 2 to 3 as observers report (Langbroek: "naked eye, magnitude 2-3").
  const half = Math.PI / 2;
  check(Math.abs(S._lfBatchMagnitude(550, half, false) - 4.6) < 1e-9, 'a Starlink on station at 550 km, quarter phase: magnitude 4.6');
  const overhead = S._lfBatchMagnitude(290, half, true);
  check(overhead > 1.2 && overhead < 3, 'days old, overhead at 290 km: magnitude ' + overhead.toFixed(1));
  check(Math.abs(S._lfBatchMagnitude(1100, half, false) - S._lfBatchMagnitude(550, half, false) - 5 * Math.log10(2)) < 1e-9, 'twice the range is 1.5 magnitudes fainter');
  check(S._lfBatchMagnitude(550, 2.6, false) > S._lfBatchMagnitude(550, 1.0, false), 'and nearly full-face is brighter than a thin crescent');
  // The Earth's shadow: full sun outside, none well inside, a smooth fade across the edge.
  const sun = [1, 0, 0], R = S.LF_MEAN_RADIUS_KM;
  const share = (perp, along) => S._lfSunShare([along, perp, 0], sun);
  check(share(R + 100, -5000) === 1 && share(R - 100, -5000) === 0 && share(0, 5000) === 1, 'sunlight is all or nothing away from the shadow edge');
  const edge = [R - 20, R - 5, R, R + 5, R + 20].map((x) => share(x, -5000));
  check(edge.every((v, k) => k === 0 || v >= edge[k - 1]) && edge[0] > 0 && edge[4] < 1 && Math.abs(edge[2] - 0.5) < 1e-9, 'across the edge it fades smoothly (' + edge.map((v) => v.toFixed(2)).join(', ') + ')');
}


// ── 8. What the ground view's sky is given ─────────────────────────────────
{
  const L = { tag: '2022-141', name: 'Falcon 9', mission: 'Starlink Group 4-31', ms: Date.UTC(2022, 9, 28, 1, 14), lat: 34.632, lon: -120.611, siteName: 'Vandenberg', incDeg: 53.2, perigeeKm: 230, ok: true };
  const f = S._lfAscent(L);
  const o = S._lfStandObjects(f, L, null, L.ms + 150000, 34.05, -118.24);
  const rocket = o.find((x) => x.kind === 'rocket'), plume = o.find((x) => x.kind === 'plume');
  check(o.length === 2 && rocket && plume && rocket.az === plume.az && rocket.el === plume.el && plume.mag === rocket.mag, 'a lit exhaust is a rocket point and a plume at the same place');
  check(rocket.rgb.every((c) => c >= 0 && c <= 1) && rocket.trail.length > 3 && rocket.name.indexOf('Starlink Group 4-31') >= 0, 'with colours 0 to 1, a trail and a name');
  check(S._lfStandObjects(f, L, null, L.ms + 150000, 34.05, 100).length === 0, 'nothing for a place on the far side of the Earth');
  const L25 = { mission: 'Starlink V1.0-L25', inc: 53.05, n: 60, depKm: 268.5 }, t25 = Date.UTC(2021, 4, 4, 19, 1);
  const f25 = S._lfAscent({ name: 'Falcon 9', lat: 28.608, lon: -80.604, siteName: 'Kennedy', incDeg: 53.05, perigeeKm: 261, ok: true });
  const dep = S._lfDeploy(L25, f25, t25, 63), at = Date.UTC(2021, 4, 7, 4, 19);
  const train = S._lfStandObjects(f25, { name: 'Falcon 9', mission: 'Starlink V1.0-L25', ms: t25, lat: 28.608, lon: -80.604, ok: true }, dep, at, 39.22, -121.06);
  check(train.length > 20 && train.every((x) => x.kind === 'train' && x.trail.length >= 1 && x.el >= 0 && x.az >= 0 && x.az < 360 && isFinite(x.mag)), 'the L25 batch over Grass Valley on 6 May: ' + train.length + ' train points');
  check(S._lfStandObjects(f25, { name: 'Falcon 9', ms: t25, lat: 28.608, lon: -80.604, ok: true }, null, at, 39.22, -121.06).length === 0, 'and with the batch not asked for, none');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
