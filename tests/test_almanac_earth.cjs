// The Almanac's 3D Earth (zimi/static/almanac-earth.js): the maths behind
// every pixel, checked against published values.
//
//   1. The Sun and the Moon: Meeus's worked examples (Astronomical
//      Algorithms, 2nd ed., 25.b and 47.a), and JPL's DE421 ephemeris at five
//      instants 1987-2041 (apparent geocentric RA/Dec, true equator and
//      equinox of date, computed with Skyfield 1.x). The Sun is VSOP87D
//      truncated (2" against DE421 over 1950-2050), the Moon Meeus's full
//      tables (7").
//   2. The Earth's turning: Greenwich apparent sidereal time (Meeus 12.b), and
//      the point under the Sun at the March 2024 equinox, the June 2024
//      solstice and an ordinary instant, against DE421 + WGS84 (Skyfield
//      subpoint_of). That point sets the day, the night and the terminator.
//   3. Eclipses, from the same geometry the shaders draw:
//        2024-04-08 total solar: EclipseWise (Espenak) greatest eclipse
//          18:17:17.9 UT1, gamma 0.34314, at 25 deg 17.4' N, 104 deg 08.3' W;
//        2025-03-14 total lunar: greatest 06:58:44.5 UT1, gamma 0.34846,
//          umbral magnitude 1.18038, totality 06:25:57.5 to 07:32:01.5 UT1.
//      Plus the JS twin of the shaders' sunlight function: dark in the
//      umbra, lit away from it, and "Next eclipse" landing on both.
//   4. Satellites: the propagator the browser runs (satellite.js, vendored)
//      against Vallado's reference SGP4 (python sgp4) for every element set
//      in the shipped snapshot, at 0, 1, 30 and 90 days
//      (tests/fixtures/satellites-reference.json, written with the snapshot
//      by scripts/build_satellite_snapshot.py); the frame the view places
//      them in; and the ISS's fade, then its orbit alone, as its data ages.
//   5. The GPS clock: +45.7 us/day from gravity, -7.2 from speed, net ~38.5,
//      about 11.5 km a day of ranging error if ignored.
//   6. A drag: the point under the finger follows it, at any roll of the
//      view (the Moon's tilt in the observer's sky) and any elevation.
//
// Run: node tests/test_almanac_earth.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'zimi', 'static');
const almSrc = fs.readFileSync(path.join(STATIC, 'almanac.js'), 'utf8');

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

// A page with no orrery drawn: the Earth view's load asks it to update its hint.
const S = { Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, window: {}, document: { getElementById: () => null } };
vm.createContext(S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;' +
  'function t(k) { return k; }', S);
for (const fn of ['_dateToJD', '_jdnToGregorian', '_cnDeltaTdays', '_computeEclipses']) vm.runInContext(extractFn(almSrc, fn), S);
// The orrery owns the constants the Earth view shares (the AU, the speed of
// light, the day in seconds) and the formatter cache; it loads first in the app.
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8'), S);
vm.runInContext(require('./moon_model.cjs')(), S);   // app.js's, which loads before every Almanac file
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-earth.js'), 'utf8'), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'earth', 'satellite-7.1.0.min.js'), 'utf8'), S);

const DEG = 180 / Math.PI;
const ARCSEC = 1 / 3600;
function angleArcsec(ra1, dec1, ra2, dec2) {
  const a = S._aeEqVec(ra1, dec1, 1), b = S._aeEqVec(ra2, dec2, 1);
  return S._aeAngle(a, b) * DEG * 3600;
}
function lonDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
const utc = (iso) => Date.parse(iso);

// ── 1. The Sun and the Moon ────────────────────────────────────────────────
{
  // Meeus 47.a: 1992 April 12, 0h TD.
  const m = S._aeMoon(2448724.5);
  check(Math.abs(m.lat - -3.229126) < 1e-5, 'Moon latitude, Meeus 47.a (' + m.lat.toFixed(6) + ')');
  check(Math.abs(m.distKm - 368409.7) < 0.5, 'Moon distance, Meeus 47.a (' + m.distKm.toFixed(1) + ' km)');
  check(Math.abs(m.lon - 133.167265) < 2 * ARCSEC, 'Moon apparent longitude, Meeus 47.a (' + m.lon.toFixed(6) + ')');
  check(Math.abs(m.dec * DEG - 13.768368) < 2 * ARCSEC, 'Moon declination, Meeus 47.a');
  // Meeus 25.b (VSOP87): 1992 October 13, 0h TD.
  const s = S._aeSun(2448908.5);
  check(Math.abs(s.lon - 199.906060) < ARCSEC, 'Sun apparent longitude, Meeus 25.b (' + s.lon.toFixed(6) + ')');
  check(Math.abs(s.ra * DEG + 360 - 198.378178) < ARCSEC, 'Sun RA, Meeus 25.b');
  check(Math.abs(s.dec * DEG - -7.783871) < ARCSEC, 'Sun declination, Meeus 25.b');
  // R is truncated at 1e-5 AU a term: a few thousand km, nothing on screen.
  check(Math.abs(s.distKm / 149597870.7 - 0.99760775) < 2e-5, 'Sun distance, Meeus 25.b');

  // JPL DE421 via Skyfield: [RA hours, Dec degrees, distance km].
  const DE421 = [
    ['1987-04-10T19:21:00Z', [1.2554445, 7.968245, 149880999.2], [10.8605746, 10.223489, 392558.4]],
    ['2003-11-23T22:49:00Z', [15.9397631, -20.406302, 147720997.3], [15.9185445, -21.345114, 356811.3]],
    ['2019-07-02T19:23:00Z', [6.770773, 23.010113, 152102184.7], [6.771652, 22.369227, 367729.5]],
    ['2026-09-28T07:00:00Z', [12.3169621, -2.057753, 149909670.1], [1.4698925, 13.869262, 374052.5]],
    ['2041-10-25T01:36:00Z', [13.989467, -12.172428, 148775467.4], [14.0011232, -11.834664, 397952.8]],
  ];
  for (const [iso, sun, moon] of DE421) {
    const sc = S._aeSceneAt(utc(iso));
    const ds = angleArcsec(sc.sunEq.ra, sc.sunEq.dec, sun[0] * 15 / DEG, sun[1] / DEG);
    const dm = angleArcsec(sc.moonEq.ra, sc.moonEq.dec, moon[0] * 15 / DEG, moon[1] / DEG);
    check(ds < 4, iso + ' Sun within 4" of DE421 (' + ds.toFixed(1) + '")');
    check(dm < 12, iso + ' Moon within 12" of DE421 (' + dm.toFixed(1) + '")');
    check(Math.abs(sc.moonEq.distKm - moon[2]) < 50, iso + ' Moon distance within 50 km of DE421');
  }
}

// ── 2. The Earth's turning, and where it is day ────────────────────────────
{
  // Meeus 12.b: 1987 April 10, 0h UT, apparent sidereal time 13h10m46.1351s.
  const nut = S._aeNutation((2446895.5 - 2451545) / 36525);
  const gast = S._aeGast(2446895.5, nut) * DEG / 15;
  check(Math.abs(gast - (13 + 10 / 60 + 46.1351 / 3600)) < 0.01 / 3600, 'GAST, Meeus 12.b');

  const SUBSOLAR = [
    ['2024-03-20T03:06:21Z', 0.0001, 135.2673],    // the March equinox
    ['2024-06-20T20:50:56Z', 23.4382, -132.287],   // the June solstice
    ['2026-09-28T07:00:00Z', -2.0578, 72.6788],
  ];
  for (const [iso, lat, lon] of SUBSOLAR) {
    const p = S._aeSubsolarPoint(S._aeSceneAt(utc(iso)));
    check(Math.abs(p.lat - lat) < 0.005 && lonDiff(p.lon, lon) < 0.01,
      iso + ' Sun overhead at ' + p.lat.toFixed(3) + ', ' + p.lon.toFixed(3) + ' (DE421: ' + lat + ', ' + lon + ')');
  }
  // The terminator: a quarter turn from the point under the Sun, the Sun is
  // on the horizon; half a turn, it is straight down.
  const sc = S._aeSceneAt(utc('2024-03-20T03:06:21Z'));
  const sunDir = S._aeNorm(sc.sun);
  const up = (lat, lon) => S._aeNorm(S._aeFixedToScene(S._aeGeodeticToFixed(lat, lon), sc.gast));
  check(Math.abs(S._aeDot(up(0, 135.2673), sunDir) - 1) < 1e-6, 'noon at the subsolar point');
  check(Math.abs(S._aeDot(up(0, 135.2673 - 90), sunDir)) < 1e-3, 'sunrise a quarter turn west');
  check(Math.abs(S._aeDot(up(89.99, 0), sunDir)) < 2e-3, 'the Sun on the horizon at the pole on the equinox');
  check(S._aeDot(up(0, 135.2673 - 180), sunDir) < -0.999, 'midnight on the far side');
}

// ── 3. Eclipses ────────────────────────────────────────────────────────────
{
  const solarAt = S._aeGreatestEclipse(utc('2024-04-08T12:00:00Z'), true);
  const want = utc('2024-04-08T18:17:17.900Z');
  // UT differs by the two sides' Delta T estimates (71.5 s vs the Almanac's 73.9 s).
  check(Math.abs(solarAt - want) < 10000, '2024-04-08 greatest eclipse within 10 s (' + new Date(solarAt).toISOString() + ')');
  const sc = S._aeSceneAt(solarAt);
  const sh = S._aeSolarShadow(sc);
  check(Math.abs(Math.abs(sh.gamma) - 0.34314) < 0.001, '2024-04-08 gamma ' + sh.gamma.toFixed(5) + ' (0.34314)');
  check(sh.umbra, '2024-04-08 the umbra reaches the ground (total)');
  check(sh.hit && Math.abs(sh.hit.lat - (25 + 17.4 / 60)) < 0.05 && lonDiff(sh.hit.lon, -(104 + 8.3 / 60)) < 0.05,
    '2024-04-08 shadow at ' + (sh.hit && sh.hit.lat.toFixed(3) + ', ' + sh.hit.lon.toFixed(3)) + ' (25.290, -104.138)');
  // The shader's twin: sunlight on the ground under the axis, and away from it.
  const ground = (lat, lon) => S._aeFixedToScene(S._aeGeodeticToFixed(lat, lon), sc.gast);
  const moonR = S.AE_MOON_RADIUS_RE;
  check(S._aeSunlightAt(ground(sh.hit.lat, sh.hit.lon), sc.sun, sc.moon, moonR) === 0, 'darkness in the umbra');
  const dallas = S._aeSunlightAt(ground(32.78, -96.80), sc.sun, sc.moon, moonR);
  check(dallas > 0.05 && dallas < 0.9, 'Dallas at 18:17 UT is in the penumbra (' + dallas.toFixed(3) + ' of the Sun)');
  check(S._aeSunlightAt(ground(51.5, -0.13), sc.sun, sc.moon, moonR) === 1, 'London sees the whole Sun');
  const status = S._aeEclipseNow(sc);
  check(status && status.solar && status.total && status.central, 'the status line reads a total solar eclipse');
  check(S._aeEclipseNow(S._aeSceneAt(utc('2024-04-10T18:00:00Z'))) === null, 'two days later, no eclipse');

  const lunarAt = S._aeGreatestEclipse(utc('2025-03-14T00:00:00Z'), false);
  check(Math.abs(lunarAt - utc('2025-03-14T06:58:44.500Z')) < 60000, '2025-03-14 greatest eclipse within a minute (' + new Date(lunarAt).toISOString() + ')');
  const lun = S._aeLunarShadow(S._aeSceneAt(lunarAt));
  check(Math.abs(Math.abs(lun.gamma) - 0.34846) < 0.002, '2025-03-14 gamma ' + lun.gamma.toFixed(5) + ' (0.34846)');
  check(Math.abs(lun.umbralMag - 1.18038) < 0.01, '2025-03-14 umbral magnitude ' + lun.umbralMag.toFixed(4) + ' (1.18038)');
  const mag = (iso) => S._aeLunarShadow(S._aeSceneAt(utc(iso))).umbralMag;
  check(mag('2025-03-14T06:29:00Z') > 1 && mag('2025-03-14T07:29:00Z') > 1, 'totality holds between U2 and U3');
  check(mag('2025-03-14T06:22:00Z') < 1 && mag('2025-03-14T07:36:00Z') < 1, 'not total before U2 or after U3');
  check(mag('2025-03-14T05:05:00Z') < 0, 'no umbra before U1 (05:09:22.6 UT1)');
  const lsc = S._aeSceneAt(lunarAt);
  check(S._aeSunlightAt(lsc.moon, lsc.sun, [0, 0, 0], S.AE_SHADOW_ENLARGE) === 0, 'the Moon’s centre gets no direct sunlight');
  const ls = S._aeEclipseNow(lsc);
  check(ls && !ls.solar && ls.total, 'the status line reads a total lunar eclipse');

  const n1 = S._aeNextEclipse(utc('2024-04-01T12:00:00Z'));
  check(n1 && n1.solar && Math.abs(n1.ms - solarAt) < 2000, 'Next eclipse from 2024-04-01 is 2024-04-08, solar');
  const n2 = S._aeNextEclipse(utc('2025-03-10T12:00:00Z'));
  check(n2 && !n2.solar && Math.abs(n2.ms - lunarAt) < 2000, 'Next eclipse from 2025-03-10 is 2025-03-14, lunar');
  const n3 = S._aeNextEclipse(solarAt);
  check(n3 && n3.ms > solarAt + 86400000, 'Next eclipse from an eclipse moves on to the one after');
}

// ── 4. Satellites ──────────────────────────────────────────────────────────
{
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'zimi', 'assets', 'satellites-snapshot.json'), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'satellites-reference.json'), 'utf8')).positions;
  const lib = S.SatelliteJS;
  let worst = 0, compared = 0, missing = [];
  for (const rec of snap.gps.concat([snap.iss])) {
    const key = rec.NORAD_CAT_ID + '@' + rec.EPOCH;
    if (!ref[key]) { missing.push(key); continue; }
    const satrec = lib.json2satrec(rec);
    for (const row of ref[key]) {
      const p = lib.sgp4(satrec, row.days * 1440).position;
      worst = Math.max(worst, Math.hypot(p.x - row.km[0], p.y - row.km[1], p.z - row.km[2]));
      compared++;
    }
  }
  check(missing.length === 0, 'every shipped element set has SGP4 reference positions' +
    (missing.length ? ' (missing ' + missing.slice(0, 3).join(', ') + '; run scripts/build_satellite_snapshot.py)' : ''));
  check(compared >= 33 * 4 && worst < 0.001, compared + ' positions within 1 m of Vallado’s SGP4 (worst ' + (worst * 1000).toFixed(3) + ' m)');

  // The epoch the view measures age from.
  const iss = lib.json2satrec(snap.iss);
  check(Math.abs(S._aeSatEpochMs(iss) - Date.parse(snap.iss.EPOCH)) < 2, 'the ISS epoch reads back to the millisecond');
  // Placed in the scene: GPS on its ~26,560 km shell, the ISS ~420 km up.
  const sc = S._aeSceneAt(Date.parse(snap.iss.EPOCH));
  const eqeq = S._aeEqEq(sc);
  const gps0 = lib.json2satrec(snap.gps[0]);
  const gPos = S._aeTemeToScene(lib.sgp4(gps0, 0).position, eqeq);
  check(Math.abs(S._aeLen(gPos) * 6378.137 - 26560) < 400, 'a GPS satellite sits on the GPS shell (' + (S._aeLen(gPos) * 6378.137).toFixed(0) + ' km)');
  const iPos = S._aeTemeToScene(lib.sgp4(iss, 0).position, eqeq);
  const alt = S._aeLen(iPos) * 6378.137 - 6378.137;
  check(alt > 350 && alt < 480, 'the ISS flies ' + alt.toFixed(0) + ' km up');
  // Standing: exact, then approximate, then the orbit alone (the ISS only),
  // then not drawn. Drag and reboosts make the ISS's place along its orbit
  // a guess within weeks; the orbit's plane SGP4 keeps for months.
  check(S._aeSatStanding(1, true) === 'exact' && S._aeSatStanding(-2.9, true) === 'exact', 'fresh ISS data is exact');
  check(S._aeSatStanding(3.5, true) === 'approximate' && S._aeSatStanding(-10, true) === 'approximate', 'days-old ISS data is approximate');
  check(S._aeSatStanding(14, true) === 'approximate', 'two weeks on, the ISS still has its (approximate) dot');
  check(S._aeSatStanding(20, true) === 'orbit' && S._aeSatStanding(-20, true) === 'orbit' && S._aeSatStanding(179, true) === 'orbit',
    'past two weeks only the ISS\'s orbit is drawn, not a dot at an arbitrary place');
  check(S._aeSatStanding(20, false) === 'exact' && S._aeSatStanding(90, false) === 'exact', 'GPS holds for months at this scale');
  check(S._aeSatStanding(181, false) === 'none' && S._aeSatStanding(-400, true) === 'none', 'far from its data, nothing is drawn');
}

// ── 5. The GPS clock ───────────────────────────────────────────────────────
{
  const r = 26560, v = Math.sqrt(398600.4418 / r);
  const rates = S._aeGpsClockRates(r, v);
  const us = (x) => S._aeMicrosPerDay(x);
  check(Math.abs(us(rates.grav) - 45.7) < 0.3, 'gravity: +' + us(rates.grav).toFixed(2) + ' us/day (45.7)');
  check(Math.abs(-us(rates.speed) - 7.2) < 0.1, 'speed: -' + (-us(rates.speed)).toFixed(2) + ' us/day (7.2)');
  check(Math.abs(us(rates.net) - 38.5) < 0.4, 'net: ' + us(rates.net).toFixed(2) + ' us/day (38)');
  const km = S._aeKmPerDay(rates.net);
  check(km > 10 && km < 12, 'ignored, it costs ' + km.toFixed(1) + ' km a day');
}

// ── 6. A drag turns the globe the way the finger goes ─────────────────────
// The point under the finger follows it: the near surface point at the
// screen's centre, fixed on the Moon, seen from the camera after the turn,
// lands where the finger went, whatever the view's roll (the Moon's tilt in
// the observer's sky) and the camera's elevation.
{
  const R = S.AE_MOON_RADIUS_RE, D = 7.5 * R, f = 900;
  const k = S._aeDragRadPerPx(D, R, f);
  check(Math.abs(k - (D - R) / (R * f)) < 1e-12, 'a drag turns (D - R) / (R f) radians a pixel');
  check(S._aeDragRadPerPx(400, R, f) === S.AE_DRAG_RAD_PER_PX, 'from far out, no faster than the cap');
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function screen(az, el, roll, p) {
    const pos = S._aeCameraOffset(az, el, D);
    const fwd = S._aeNorm(S._aeSub([0, 0, 0], pos));
    const up = S._aeViewUp(fwd, roll);
    const right = S._aeCross(fwd, up);
    const v = S._aeSub(p, pos), z = dot(v, fwd);
    return [f * dot(v, right) / z, -f * dot(v, up) / z];
  }
  let worst = 0;
  for (const roll of [0, 37, 90, -120, 180]) {
    for (const el of [0, 0.5, -0.9]) {
      const az = 1.1;
      const near = S._aeScale(S._aeNorm(S._aeCameraOffset(az, el, D)), R);
      for (const [dx, dy] of [[12, 0], [0, 12], [-8, 6]]) {
        const tr = S._aeDragTurn(dx, dy, roll, k, el);
        const got = screen(az + tr.daz, el + tr.del, roll, near);
        const e = Math.hypot(got[0] - dx, got[1] - dy) / Math.hypot(dx, dy);
        worst = Math.max(worst, e);
      }
    }
  }
  // Off by a little only where a turn in azimuth bends round a latitude.
  check(worst < 0.08, 'the point under the finger follows it, any roll or elevation (worst ' + (worst * 100).toFixed(1) + '% off)');
  // The directions, plainly: north up, a drag right turns the camera west
  // (azimuth down), a drag down lifts it (elevation up).
  const r = S._aeDragTurn(10, 0, 0, k, 0), d = S._aeDragTurn(0, 10, 0, k, 0);
  check(r.daz < 0 && r.del === 0 && d.del > 0 && Math.abs(d.daz) < 1e-15, 'right and down, north up');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
