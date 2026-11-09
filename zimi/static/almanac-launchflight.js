// ── Almanac: the maths of a launch ──
// Pure functions, no page: almanac-launches.js draws them, tests/test_almanac_launches.cjs checks them.
//   - the launch azimuth from the target inclination and the pad's latitude (the Earth's turning subtracted);
//   - the ascent: altitude, speed and ground range against time, from a vehicle family's published events
//     (Falcon 9 from SpaceX's webcast telemetry; other vehicles a typical profile of the same shape, scaled to the burn
//     time), laid along the great circle from the pad at the launch azimuth;
//   - what a place sees of it: elevation and azimuth each second, whether the rocket is in sunlight, and which of
//     the sights that is (the lit exhaust of a twilight launch, an engine's glow, a daytime dot);
//   - the deployment: the batch's orbit plane from where the rocket was when it let go, the string spreading by
//     the satellites' small differences in height, the Earth's bulge (J2) turning the plane, the raising of a
//     Starlink batch to its shell.
// Thresholds are AE_LAUNCH_REF (almanac-earth.js), which the Almanac's constants pages show with their sources.
// Shares almanac-earth.js's global scope (AE_EARTH_RADIUS_KM, AE_GM_EARTH, MS_PER_DAY).

var LF_D2R = Math.PI / 180;
var LF_EARTH_RATE_RAD_S = AE_LAUNCH_REF.earthRateRadS, LF_J2 = AE_LAUNCH_REF.j2, LF_MEAN_RADIUS_KM = AE_LAUNCH_REF.meanRadiusKm;
var LF_SOUTH_SITE = /^Vandenberg$/;          // range safety lets nothing fly north from here
var LF_NORTH_SITE = /^Plesetsk$/;            // and the polar launches from here fly north
var LF_STEP_S = 1;                           // the ascent is sampled every second
var LF_TABLE_STEP_S = 1200;                  // the deployment's integrals are tabled at this step
var LF_SPREAD_SEED = 2654435761;
// Families by the vehicle's name: the profile it flies and the time to the end of its last burn (s).
var LF_FAMILIES = [
  [/^Falcon/, 'falcon'],
  [/^Space Shuttle/, 'shuttle'],
  [/^Saturn/, 'saturn']
];
// Falcon 9 from the first stage's lift-off: seconds, height (km) and speed relative to the Earth (km/s). SpaceX's launch
// webcasts print these two every second; rounded here to the nearest few percent.
var LF_FALCON_KNOTS = [
  [0, 0, 0], [10, 0.25, 0.05], [30, 2.2, 0.2], [60, 8, 0.4], [72, 12.5, 0.52], [100, 26, 0.95], [120, 38, 1.3],
  [150, 68, 2.1], [160, 76, 2.1], [180, 96, 2.4], [240, 130, 3.4], [300, 160, 4.2], [360, 185, 5.0], [420, 210, 5.8],
  [480, 240, 6.6], [525, 270, 7.35]
];
// The first stage's way back to a drone ship: seconds, height (km) and ground range (km) from the pad.
var LF_FALCON_BOOSTER_KNOTS = [[160, 76, null], [235, 140, 260], [380, 70, 490], [405, 40, 520], [480, 6, 580], [510, 0, 610]];

function _lfFamily(name) {
  for (var i = 0; i < LF_FAMILIES.length; i++) if (LF_FAMILIES[i][0].test(name || '')) return LF_FAMILIES[i][1];
  return 'typical';
}

// ── The azimuth ──
// The compass heading, degrees clockwise from north, a rocket leaves a pad at to reach an orbit of inclination `inc`
// at height `altKm`. sin(azimuth) = cos(inclination) / cos(latitude) in the stars' frame; the Earth's turning carries the
// rocket east at omega R cos(latitude) already, which is taken off the orbital speed. `south`: the branch that flies
// south of east. An inclination below the pad's latitude cannot be reached by one burn: due east (a dog-leg later).
function _lfAzimuth(latDeg, incDeg, altKm, south) {
  var lat = latDeg * LF_D2R, ratio = Math.cos(incDeg * LF_D2R) / Math.cos(lat), reach = Math.abs(ratio) <= 1;
  var inertial = Math.asin(Math.max(-1, Math.min(1, ratio)));
  if (south) inertial = Math.PI - inertial;
  var v = Math.sqrt(AE_GM_EARTH / (AE_EARTH_RADIUS_KM + altKm));
  var vx = v * Math.sin(inertial) - LF_EARTH_RATE_RAD_S * AE_EARTH_RADIUS_KM * Math.cos(lat), vy = v * Math.cos(inertial);
  return { az: (Math.atan2(vx, vy) / LF_D2R + 360) % 360, inertial: (inertial / LF_D2R + 360) % 360, reach: reach,
    speed: Math.hypot(vx, vy) };
}
// Which way a pad's launches go when both would reach the orbit: the site's rule, then the inclination's.
function _lfSouth(siteName, incDeg) {
  if (LF_SOUTH_SITE.test(siteName || '')) return true;
  if (LF_NORTH_SITE.test(siteName || '')) return false;
  return incDeg > 90;
}

// ── The ascent ──
// A monotone cubic through (x, y) knots (Fritsch-Carlson), so a profile never overshoots between two readings.
function _lfMonotone(xs, ys) {
  var n = xs.length, d = [], m = [], i;
  for (i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    var a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { var t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return function (x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    var k = 0;
    while (x > xs[k + 1]) k++;
    var h = xs[k + 1] - xs[k], t2 = (x - xs[k]) / h, t3 = t2 * t2, t4 = t3 * t2;
    return (2 * t4 - 3 * t3 + 1) * ys[k] + (t4 - 2 * t3 + t2) * h * m[k] + (-2 * t4 + 3 * t3) * ys[k + 1] + (t4 - t3) * h * m[k + 1];
  };
}
// The profile's knots for a family, stretched to a burn that ends `endS` seconds after lift-off at `endKm` and `endKmS`.
function _lfKnots(family, endKm, endKmS) {
  var ref = AE_LAUNCH_REF, base = LF_FALCON_KNOTS, tEnd = base[base.length - 1][0], tMeco = ref.falcon.mecoS;
  var scale = (family === 'falcon' ? tEnd : ref.typicalBurnS[family] || ref.typicalBurnS.typical) / tEnd;
  var endBase = base[base.length - 1];
  return base.map(function (k) {
    var t = k[0], past = t > tMeco ? (t - tMeco) / (tEnd - tMeco) : 0;
    return [t * scale, k[1] + (endKm - endBase[1]) * past, k[2] + (endKmS - endBase[2]) * past];
  });
}
// The great-circle point `rangeKm` from (lat, lon) along `azDeg`.
function _lfDestination(latDeg, lonDeg, azDeg, rangeKm) {
  var d = rangeKm / LF_MEAN_RADIUS_KM, la = latDeg * LF_D2R, az = azDeg * LF_D2R;
  var sla = Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(az);
  var lo = lonDeg * LF_D2R + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * sla);
  return { lat: Math.asin(Math.max(-1, Math.min(1, sla))) / LF_D2R, lon: ((lo / LF_D2R + 540) % 360) - 180 };
}
// A launch's ascent. in: {name, lat, lon, siteName, incDeg, perigeeKm, ok}. out: samples every second (t s, h km, speed
// km/s, ground range km, lat, lon, burn: 0 coasting, 1 first stage, 2 later stage), the events, the azimuth, and for a
// Falcon the first stage's way back. A launch with no known orbit flies due east to 200 km (`guessed`).
function _lfAscent(L) {
  var ref = AE_LAUNCH_REF, family = _lfFamily(L.name), guessed = L.incDeg == null;
  var inc = guessed ? Math.abs(L.lat) : L.incDeg;
  var endKm = Math.max(ref.insertionKm[0], Math.min(ref.insertionKm[1], L.perigeeKm == null ? ref.insertionKm[0] : L.perigeeKm));
  var az = _lfAzimuth(L.lat, inc, endKm, _lfSouth(L.siteName, inc)), knots = _lfKnots(family, endKm, az.speed);   // the speed at the end, relative to the ground, is what the azimuth was worked from
  var ts = knots.map(function (k) { return k[0]; }), height = _lfMonotone(ts, knots.map(function (k) { return k[1]; }));
  var speed = _lfMonotone(ts, knots.map(function (k) { return k[2]; }));
  var tEnd = ts[ts.length - 1], stretch = tEnd / LF_FALCON_KNOTS[LF_FALCON_KNOTS.length - 1][0], firstEnd = ref.falcon.mecoS * stretch;
  var stop = L.ok === false ? firstEnd : tEnd;   // a launch that failed is drawn to where its first stage ended
  var pts = [], range = 0, prevH = 0;
  for (var t = 0; t <= stop; t += LF_STEP_S) {
    var h = height(t), v = speed(t), dh = h - prevH, vh = Math.sqrt(Math.max(0, v * v - dh * dh));
    range += vh * LF_STEP_S * LF_MEAN_RADIUS_KM / (LF_MEAN_RADIUS_KM + h);
    prevH = h;
    var at = _lfDestination(L.lat, L.lon, az.az, range);
    pts.push({ t: t, h: h, v: v, range: range, lat: at.lat, lon: at.lon, burn: t <= firstEnd ? 1 : t >= firstEnd + ref.coastS ? 2 : 0 });
  }
  var events = [{ t: 0, key: 'liftoff' }, { t: ref.falcon.maxQS * stretch, key: 'maxq' }, { t: firstEnd, key: 'meco' },
    { t: firstEnd + ref.coastS, key: 'stage2' }];
  if (family === 'falcon') events.push({ t: ref.falcon.fairingS, key: 'fairing' });
  events.push({ t: tEnd, key: 'seco' });
  events = events.filter(function (e) { return e.t <= stop; });
  var out = { family: family, az: az.az, azInertial: az.inertial, reach: az.reach, guessed: guessed, endKm: endKm, tEnd: tEnd, stop: stop,
    points: pts, events: events, insertion: stop === tEnd ? pts[pts.length - 1] : null, booster: null, incDeg: inc };
  if (family === 'falcon' && stop === tEnd) out.booster = _lfBooster(L, az.az, pts);
  return out;
}
// The Falcon first stage after it lets go: up to its highest point, the entry burn, the landing, on a drone ship.
function _lfBooster(L, az, pts) {
  var ref = AE_LAUNCH_REF, k = LF_FALCON_BOOSTER_KNOTS, from = pts[Math.min(pts.length - 1, ref.falcon.mecoS + ref.coastS)];
  var ts = [], hs = [], rs = [];
  k.forEach(function (row, i) { ts.push(row[0]); hs.push(row[1]); rs.push(i === 0 ? from.range : row[2]); });
  var height = _lfMonotone(ts, hs), range = _lfMonotone(ts, rs), out = [];
  for (var t = ts[0]; t <= ts[ts.length - 1]; t += LF_STEP_S) {
    var at = _lfDestination(L.lat, L.lon, az, range(t));
    out.push({ t: t, h: height(t), lat: at.lat, lon: at.lon, burn: t >= ref.falcon.entryBurnS[0] && t <= ref.falcon.entryBurnS[1] ? 3 : t >= ref.falcon.landS - ref.falcon.landBurnS ? 4 : 0 });
  }
  return out;
}

// ── The Sun, and what a place sees ──
// The Sun's direction (a unit vector, equatorial) to a few hundredths of a degree: all a twilight and a shadow need.
function _lfSunUnit(ms) {
  var n = ms / MS_PER_DAY + 2440587.5 - 2451545.0;
  var L = (280.460 + 0.9856474 * n) * LF_D2R, g = (357.528 + 0.9856003 * n) * LF_D2R;
  var lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * LF_D2R, eps = (23.439 - 0.0000004 * n) * LF_D2R;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}
function _lfGmst(ms) {
  var n = ms / MS_PER_DAY + 2440587.5 - 2451545.0;
  return (((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24) * 15 * LF_D2R;
}
// A point at (lat, lon, height) as a vector in the stars' frame, kilometres, on the sphere.
function _lfEci(latDeg, lonDeg, hKm, gmst) {
  var la = latDeg * LF_D2R, th = lonDeg * LF_D2R + gmst, r = LF_MEAN_RADIUS_KM + hKm;
  return [r * Math.cos(la) * Math.cos(th), r * Math.cos(la) * Math.sin(th), r * Math.sin(la)];
}
function _lfDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
// The Sun's height above the horizon at a place (degrees).
function _lfSunAlt(ms, lat, lon) {
  var up = _lfEci(lat, lon, 0, _lfGmst(ms));
  return Math.asin(_lfDot(up, _lfSunUnit(ms)) / LF_MEAN_RADIUS_KM) / LF_D2R;
}
// Whether sunlight reaches a point (stars' frame, km): in front of the Earth, or outside the shadow's cylinder.
function _lfSunlit(posKm, sun) {
  var along = _lfDot(posKm, sun);
  if (along >= 0) return true;
  var px = posKm[0] - sun[0] * along, py = posKm[1] - sun[1] * along, pz = posKm[2] - sun[2] * along;
  return Math.sqrt(px * px + py * py + pz * pz) > LF_MEAN_RADIUS_KM;
}
// Elevation, azimuth (degrees) and range (km) of a point at (lat, lon, height) from a place on the ground.
function _lfLook(obsLat, obsLon, lat, lon, hKm) {
  var la = obsLat * LF_D2R, lo = obsLon * LF_D2R, p = _lfEci(lat, lon, hKm, 0), o = _lfEci(obsLat, obsLon, 0, 0);
  var dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2], range = Math.hypot(dx, dy, dz);
  var sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  var up = dx * cl * co + dy * cl * so + dz * sl, east = -dx * so + dy * co, north = -dx * sl * co - dy * sl * so + dz * cl;
  return { el: Math.asin(Math.max(-1, Math.min(1, up / range))) / LF_D2R, az: (Math.atan2(east, north) / LF_D2R + 360) % 360, range: range };
}
// Great-circle distance between two points on the ground (km).
function _lfGroundKm(lat1, lon1, lat2, lon2) {
  var p1 = lat1 * LF_D2R, p2 = lat2 * LF_D2R, dp = p2 - p1, dl = (lon2 - lon1) * LF_D2R;
  var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * LF_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
// What the sight is. 'below': under the horizon. 'jellyfish': an engine burning high, its exhaust lit by a Sun that has
// set for the watcher. 'flame': a burning engine against a dark sky with the rocket itself in shadow. 'dot': a coasting
// stage lit against the twilight. 'day': a bright point and a white trail in daylight.
function _lfSight(burning, lit, sunAlt, el, hKm) {
  var ref = AE_LAUNCH_REF;
  if (el < ref.minElDeg) return 'below';
  if (sunAlt > ref.darkSunAlt) return 'day';
  if (burning && lit && hKm >= ref.plumeMinKm) return 'jellyfish';
  if (burning) return 'flame';
  return lit ? 'dot' : 'below';
}
// A launch as one place sees it. flight: _lfAscent's. ms0: lift-off. out: a sample each second the rocket is up, a summary,
// and for a place too far away, how far.
function _lfObserve(flight, L, ms0, obsLat, obsLon) {
  var padKm = _lfGroundKm(obsLat, obsLon, L.lat, L.lon), samples = [], best = null, first = null, last = null, peak = null;
  var rank = { below: 0, dot: 1, day: 2, flame: 3, jellyfish: 4 };
  flight.points.forEach(function (p) {
    var ms = ms0 + p.t * 1000, lk = _lfLook(obsLat, obsLon, p.lat, p.lon, p.h), sunAlt = _lfSunAlt(ms, obsLat, obsLon);
    var lit = _lfSunlit(_lfEci(p.lat, p.lon, p.h, _lfGmst(ms)), _lfSunUnit(ms));
    var sight = _lfSight(p.burn > 0, lit, sunAlt, lk.el, p.h);
    var s = { t: p.t, el: lk.el, az: lk.az, range: lk.range, h: p.h, lit: lit, sunAlt: sunAlt, sight: sight, burn: p.burn };
    samples.push(s);
    if (sight === 'below') return;
    if (!first) first = s;
    last = s;
    if (!peak || s.el > peak.el) peak = s;
    if (!best || rank[sight] > rank[best]) best = sight;
  });
  var closest = samples.reduce(function (m, s) { return Math.min(m, s.range); }, Infinity);
  return { seen: !!first, sight: best, first: first, last: last, peak: peak, samples: samples, padKm: padKm, closestKm: closest };
}

// ── The deployment ──
function _lfCircularRate(aKm) { return Math.sqrt(AE_GM_EARTH / (aKm * aKm * aKm)); }   // rad/s
// The mean rate of the argument of latitude and the node's drift (rad/s) for a circular orbit of radius aKm, inclination
// iRad, with the Earth's bulge: u' = n (1 + 1.5 J2 (Re/a)^2 (3 - 4 sin^2 i)), node' = -1.5 J2 n (Re/a)^2 cos i.
function _lfRates(aKm, iRad) {
  var n = _lfCircularRate(aKm), q = LF_J2 * Math.pow(AE_EARTH_RADIUS_KM / aKm, 2), si = Math.sin(iRad);
  return { u: n * (1 + 1.5 * q * (3 - 4 * si * si)), node: -1.5 * q * n * Math.cos(iRad) };
}
// A deterministic number in [0, 1) from an integer, so a batch spreads the same way every time it is drawn.
function _lfHash01(i) { return ((Math.imul(i + 1, LF_SPREAD_SEED) >>> 0) % 65536) / 65536; }
// The Starlink shell a batch is raised to, by its inclination (degrees).
function _lfShellKm(incDeg) {
  var shells = AE_LAUNCH_REF.starlinkShells, best = shells.other;
  Object.keys(shells).forEach(function (k) { if (k !== 'other' && Math.abs(Number(k) - incDeg) < 2) best = shells[k]; });
  return best;
}
// A batch let go at `sepMs` from the rocket's last place on its ascent. L: {mission, inc, n, depKm}; flight: the ascent;
// ms0: lift-off; sepMin: minutes from lift-off to separation. Returns {at(ms, k): the satellite's position in the stars'
// frame, node, plane, raising(ms)} for k in [0, n).
function _lfDeploy(L, flight, ms0, sepMin) {
  var ref = AE_LAUNCH_REF, inc = L.inc * LF_D2R, ins = flight.insertion || flight.points[flight.points.length - 1];
  var tsep = ms0 + sepMin * 60000, tins = ms0 + ins.t * 1000, depA = AE_EARTH_RADIUS_KM + L.depKm;
  // The plane: the rocket's place at insertion, on the orbit of this inclination, flying with the launch azimuth.
  var gm = _lfGmst(tins), la = ins.lat * LF_D2R, lonI = ins.lon * LF_D2R + gm;
  var ascending = Math.cos(flight.azInertial * LF_D2R) >= 0;
  var u = Math.asin(Math.max(-1, Math.min(1, Math.sin(la) / Math.sin(inc))));
  if (!ascending) u = Math.PI - u;
  var node0 = lonI - Math.atan2(Math.cos(inc) * Math.sin(u), Math.cos(u));
  var starlink = /^Starlink/i.test(L.mission || ''), shellKm = starlink ? _lfShellKm(L.inc) : null;
  var raiseFrom = tsep + ref.checkoutDays * MS_PER_DAY;
  var raiseMs = shellKm == null ? 0 : (shellKm - L.depKm) / ref.raiseKmPerDay * MS_PER_DAY;
  function heightAt(ms) {
    if (shellKm == null || ms <= raiseFrom) return L.depKm;
    return ms >= raiseFrom + raiseMs ? shellKm : L.depKm + (shellKm - L.depKm) * (ms - raiseFrom) / raiseMs;
  }
  // The string's centre: its argument of latitude and node, tabled from separation on at LF_TABLE_STEP_S.
  var table = [{ ms: tsep, u: u + _lfCircularRate(depA) * (tsep - tins) / 1000, node: node0, drift: 0 }], dep = {};
  function extend(ms) {
    var last = table[table.length - 1];
    while (last.ms < ms) {
      var mid = last.ms + LF_TABLE_STEP_S * 500, r = _lfRates(AE_EARTH_RADIUS_KM + heightAt(mid), inc);
      var am = AE_EARTH_RADIUS_KM + heightAt(mid);
      last = { ms: last.ms + LF_TABLE_STEP_S * 1000, u: last.u + r.u * LF_TABLE_STEP_S, node: last.node + r.node * LF_TABLE_STEP_S,
        drift: last.drift - 1.5 * _lfCircularRate(am) / am * LF_TABLE_STEP_S };
      table.push(last);
    }
  }
  function centre(ms) {
    extend(ms + LF_TABLE_STEP_S * 1000);
    var k = Math.max(0, Math.min(table.length - 2, Math.floor((ms - tsep) / (LF_TABLE_STEP_S * 1000)))), a = table[k], b = table[k + 1], f = (ms - a.ms) / (b.ms - a.ms);
    return { u: a.u + (b.u - a.u) * f, node: a.node + (b.node - a.node) * f, drift: a.drift + (b.drift - a.drift) * f };
  }
  var n = L.n;
  dep.n = n; dep.sepMs = tsep; dep.shellKm = shellKm; dep.raiseFromMs = raiseFrom; dep.raiseDoneMs = shellKm == null ? tsep : raiseFrom + raiseMs;
  // Satellite k is ahead of or behind the centre by its own small difference in height (a string, ordered by it) and a
  // short step apart at release. A difference da in height drifts a satellite by du/dt = -1.5 n da / a, summed in the table.
  dep.offsetKm = function (k) { return ref.spreadKm * ((k + 0.5) / n * 2 - 1); };
  dep.at = function (ms, k) {
    var c = centre(ms), a = AE_EARTH_RADIUS_KM + heightAt(ms), da = dep.offsetKm(k);
    var uk = c.u + c.drift * da + (k - (n - 1) / 2) * ref.releaseGapDeg * LF_D2R, ci = Math.cos(inc), si = Math.sin(inc);
    var cu = Math.cos(uk), su = Math.sin(uk), cn = Math.cos(c.node), sn = Math.sin(c.node), r = a + da;
    return [r * (cn * cu - sn * ci * su), r * (sn * cu + cn * ci * su), r * si * su];
  };
  dep.heightKm = heightAt;
  dep.raising = function (ms) { return shellKm != null && ms > raiseFrom && ms < dep.raiseDoneMs; };
  return dep;
}
// A place at an instant, ready to look at many positions (the Sun and the Earth's turning worked out once).
function _lfWatcher(ms, obsLat, obsLon) {
  var gm = _lfGmst(ms), la = obsLat * LF_D2R, th = obsLon * LF_D2R + gm, sun = _lfSunUnit(ms);
  var up = [Math.cos(la) * Math.cos(th), Math.cos(la) * Math.sin(th), Math.sin(la)];
  return { o: _lfEci(obsLat, obsLon, 0, gm), sl: Math.sin(la), cl: Math.cos(la), st: Math.sin(th), ct: Math.cos(th), sun: sun,
    sunAlt: Math.asin(_lfDot(up, sun)) / LF_D2R };
}
// A position (stars' frame, km) seen by a watcher: elevation, azimuth, range, and whether it is in sunlight.
function _lfSeenBy(w, posKm) {
  var dx = posKm[0] - w.o[0], dy = posKm[1] - w.o[1], dz = posKm[2] - w.o[2], range = Math.hypot(dx, dy, dz);
  var up = dx * w.cl * w.ct + dy * w.cl * w.st + dz * w.sl, east = -dx * w.st + dy * w.ct, north = -dx * w.sl * w.ct - dy * w.sl * w.st + dz * w.cl;
  return { el: Math.asin(Math.max(-1, Math.min(1, up / range))) / LF_D2R, az: (Math.atan2(east, north) / LF_D2R + 360) % 360, range: range,
    lit: _lfSunlit(posKm, w.sun) };
}
function _lfSeenFrom(posKm, ms, obsLat, obsLon) { return _lfSeenBy(_lfWatcher(ms, obsLat, obsLon), posKm); }
// The windows in which a released batch can be seen from a place between two instants: the Sun below the dark limit, the
// satellite in sunlight and above `minEl`. Merged where the gap is under a step. Each: {start, end, peakEl, count, azStart,
// azEnd, peakMs}.
function _lfBatchWindows(dep, fromMs, toMs, obsLat, obsLon, minEl, stepMs) {
  var ref = AE_LAUNCH_REF, out = [], cur = null;
  for (var ms = Math.max(fromMs, dep.sepMs); ms <= toMs; ms += stepMs) {
    var w = _lfWatcher(ms, obsLat, obsLon), count = 0, peak = -90, azFirst = null, azLast = null;
    if (w.sunAlt < ref.darkSunAlt) {
      for (var k = 0; k < dep.n; k++) {
        var v = _lfSeenBy(w, dep.at(ms, k));
        if (v.el >= minEl && v.lit) { count++; if (v.el > peak) { peak = v.el; } if (azFirst === null) azFirst = v.az; azLast = v.az; }
      }
    }
    if (count) {
      if (!cur || ms - cur.end > stepMs * 1.5) { cur = { start: ms, end: ms, peakEl: peak, count: count, azStart: azFirst, azEnd: azLast, peakMs: ms }; out.push(cur); }
      else { cur.end = ms; cur.count = Math.max(cur.count, count); cur.azEnd = azLast; if (peak > cur.peakEl) { cur.peakEl = peak; cur.peakMs = ms; } }
    }
  }
  return out;
}
