// ── The Almanac's long-haul reference: what to keep for a world with no new data ──
// Eric, 2026-09-30: "What can/should be documented offline for folks that may
// never get new data again ever? Tables seasons conversions i dunno?"
//
// The sums behind the Almanac's Tables and Calculations (almanac-tables.js,
// which draws them): loaded with it on first use, after almanac.js,
// almanac-earth.js and almanac-navdata.js. Here: the Nautical Almanac's
// places and sight reduction; any run of days for one place (rise, set,
// twilight, transit, the Moon); the equation of time; the star calendar;
// six calendars and the movable feasts; and "what stops being true", the
// one page drawn here, with each thing's age.
//
// Borrowed, not copied: the Sun (VSOP87D), the Moon (Meeus 47, full tables),
// nutation and sidereal time come from almanac-earth.js; delta T, the
// calendars, Easter and the season instants from almanac.js. The planets and
// the navigational stars are almanac-navdata.js (scripts/build_almanac_navdata.py).

// ═══════════════════════════════════════════════════════════════════════
// The sky, to Nautical Almanac precision
// ═══════════════════════════════════════════════════════════════════════

var AR_DAYS_PER_JULIAN_YEAR = 365.25;
// Light's time across one AU, in days (Meeus 33.3).
var AR_LIGHT_DAYS_PER_AU = 0.0057755183;
// The constant of aberration, arcseconds (Meeus 23).
var AR_ABERRATION_ARCSEC = 20.49552;
// The Sun's semi-diameter and horizontal parallax at 1 AU, arcseconds.
var AR_SUN_SD_1AU_ARCSEC = 959.63;
var AR_SOLAR_PARALLAX_ARCSEC = 8.794;
// The Moon's radius over the Earth's equatorial radius: SD = asin(k sin HP).
var AR_MOON_K = 0.2725076;
// Milliarcseconds to radians.
var AR_MAS_TO_RAD = Math.PI / 180 / 3600000;
// One AU per Julian year in km/s: a radial velocity in proper-motion units.
var AR_KMS_PER_AU_PER_YEAR = 149597870.7 / (365.25 * 86400);
var AR_PLANETS = ['venus', 'mars', 'jupiter', 'saturn'];
var AR_HOURS = 24;
var AR_MS_PER_HOUR = 3600000;

function _arNorm360(d) { return ((d % 360) + 360) % 360; }

// One coordinate of a VSOP87 series (almanac-navdata.js keeps each power's
// terms flat: A, B, C, A, B, C...).
function _arVsop(rows, tau) {
  var total = 0, tp = 1;
  for (var p = 0; p < rows.length; p++) {
    var row = rows[p], s = 0;
    for (var i = 0; i < row.length; i += 3) s += row[i] * Math.cos(row[i + 1] + row[i + 2] * tau);
    total += s * tp;
    tp *= tau;
  }
  return total;
}

// Heliocentric ecliptic rectangular coordinates (AU, ecliptic and equinox
// of date): a planet from almanac-navdata.js, the Earth from almanac-earth.js.
function _arHelioRect(l, b, r) {
  return [r * Math.cos(b) * Math.cos(l), r * Math.cos(b) * Math.sin(l), r * Math.sin(b)];
}
function _arPlanetHelio(name, tau) {
  var s = AR_VSOP[name];
  return _arHelioRect(_arVsop(s.L, tau), _arVsop(s.B, tau), _arVsop(s.R, tau));
}
function _arEarthHelio(tau) {
  return _arHelioRect(_aeVsopSum(AE_VSOP_L, tau), _aeVsopSum(AE_VSOP_B, tau), _aeVsopSum(AE_VSOP_R, tau));
}

// Mean ecliptic of date (degrees, astrometric) to apparent equatorial place:
// annual aberration (Meeus 23.2, with the Sun's true longitude sunLon),
// nutation in longitude, then the true obliquity. Shared by planets and stars.
function _arApparentFromEcliptic(lonDeg, latDeg, T, sunLon, nut) {
  var e = 0.016708634 - 0.000042037 * T;            // the Earth orbit's eccentricity
  var peri = 102.93735 + 1.71946 * T;               // its perihelion's longitude
  var k = AR_ABERRATION_ARCSEC * AE_ARCSEC_TO_DEG;
  var l = _aeRad(lonDeg), b = _aeRad(latDeg);
  var s = _aeRad(sunLon), p = _aeRad(peri);
  var dl = (-k * Math.cos(s - l) + e * k * Math.cos(p - l)) / Math.cos(b);
  var db = -k * Math.sin(b) * (Math.sin(s - l) - e * Math.sin(p - l));
  return _aeEclipticToEquatorial(lonDeg + dl + nut.dpsi, latDeg + db, nut.eps);
}

// The Sun's true geometric longitude (degrees) from the Earth's heliocentric place.
function _arSunTrueLon(earth) { return _arNorm360(_aeDeg(Math.atan2(earth[1], earth[0])) + 180); }

// A planet's apparent geocentric place at jde (TT): RA/Dec (radians) and its
// distance (AU). Light time by iteration (Meeus 33), the FK5 frame
// correction (Meeus 32.3), then aberration and nutation.
function _arPlanet(name, jde, nut) {
  var tau = (jde - JD_J2000) / AE_DAYS_PER_JULIAN_MILLENNIUM;
  var T = (jde - JD_J2000) / JULIAN_CENTURY;
  var earth = _arEarthHelio(tau);
  var lt = 0, x = 0, y = 0, z = 0, dist = 0;
  for (var i = 0; i < 3; i++) {
    var p = _arPlanetHelio(name, tau - lt / AE_DAYS_PER_JULIAN_MILLENNIUM);
    x = p[0] - earth[0]; y = p[1] - earth[1]; z = p[2] - earth[2];
    dist = Math.sqrt(x * x + y * y + z * z);
    lt = AR_LIGHT_DAYS_PER_AU * dist;
  }
  var lon = _aeDeg(Math.atan2(y, x)), lat = _aeDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
  var lp = _aeRad(lon - 1.397 * T - 0.00031 * T * T);
  lon += (AE_FK5_DLON_ARCSEC + AE_FK5_DLAT_ARCSEC * (Math.cos(lp) + Math.sin(lp)) * Math.tan(_aeRad(lat))) * AE_ARCSEC_TO_DEG;
  lat += AE_FK5_DLAT_ARCSEC * (Math.cos(lp) - Math.sin(lp)) * AE_ARCSEC_TO_DEG;
  var eq = _arApparentFromEcliptic(lon, lat, T, _arSunTrueLon(earth), nut || _aeNutation(T));
  return { ra: eq.ra, dec: eq.dec, distAU: dist };
}

// A star's apparent place at jde: its space motion from J2000 (straight
// line, radial velocity included: the twin of the build script's), the IAU
// 1976 precession (Meeus 21.2/21.3), then aberration and nutation.
function _arStar(star, jde, nut) {
  var T = (jde - JD_J2000) / JULIAN_CENTURY;
  var years = (jde - JD_J2000) / AR_DAYS_PER_JULIAN_YEAR;
  var a = _aeRad(star[2]), d = _aeRad(star[3]);
  var ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
  var radial = star[7] / AR_KMS_PER_AU_PER_YEAR * star[6] * AR_MAS_TO_RAD;
  var pa = star[4] * AR_MAS_TO_RAD, pd = star[5] * AR_MAS_TO_RAD;
  var px = cd * ca + years * (-pa * sa - pd * sd * ca + radial * cd * ca);
  var py = cd * sa + years * (pa * ca - pd * sd * sa + radial * cd * sa);
  var pz = sd + years * (pd * cd + radial * sd);
  var a0 = Math.atan2(py, px), d0 = Math.atan2(pz, Math.sqrt(px * px + py * py));
  // Precession, J2000 to the date.
  var zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * AE_ARCSEC_TO_DEG;
  var zz = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * AE_ARCSEC_TO_DEG;
  var th = _aeRad((2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * AE_ARCSEC_TO_DEG);
  var az = a0 + _aeRad(zeta);
  var A = Math.cos(d0) * Math.sin(az);
  var B = Math.cos(th) * Math.cos(d0) * Math.cos(az) - Math.sin(th) * Math.sin(d0);
  var C = Math.sin(th) * Math.cos(d0) * Math.cos(az) + Math.cos(th) * Math.sin(d0);
  var ra = Math.atan2(A, B) + _aeRad(zz), dec = Math.asin(C);
  // To the mean ecliptic of the date, for the shared apparent-place step.
  nut = nut || _aeNutation(T);
  var e0 = _aeRad(nut.eps0);
  var lon = _aeDeg(Math.atan2(Math.sin(ra) * Math.cos(e0) + Math.tan(dec) * Math.sin(e0), Math.cos(ra)));
  var lat = _aeDeg(Math.asin(Math.sin(dec) * Math.cos(e0) - Math.cos(dec) * Math.sin(e0) * Math.sin(ra)));
  var tau = (jde - JD_J2000) / AE_DAYS_PER_JULIAN_MILLENNIUM;
  return _arApparentFromEcliptic(lon, lat, T, _arSunTrueLon(_arEarthHelio(tau)), nut);
}

// Everything a Nautical Almanac page gives for one instant (ms, UT):
// Greenwich hour angles and declinations in degrees, the Sun's and Moon's
// semi-diameters and horizontal parallaxes in arcminutes. GHA = GAST - RA;
// a star's SHA = 360 - RA, and its GHA = GHA Aries + SHA.
function _arNavAt(ms, opts) {
  var jd = _dateToJD(ms);
  var jde = jd + _cnDeltaTdays(jd);
  var T = (jde - JD_J2000) / JULIAN_CENTURY;
  var nut = _aeNutation(T);
  var gast = _aeDeg(_aeGast(jd, nut));
  var sun = _aeSun(jde), moon = _aeMoon(jde);
  var sunAU = sun.distKm / AU_KM;
  var hp = _aeDeg(Math.asin(AE_EARTH_RADIUS_KM / moon.distKm));
  var out = {
    ms: ms, aries: gast,
    sun: _arBody(gast, sun.ra, sun.dec, { sd: AR_SUN_SD_1AU_ARCSEC / sunAU / 60, hp: AR_SOLAR_PARALLAX_ARCSEC / sunAU / 60 }),
    moon: _arBody(gast, moon.ra, moon.dec, { hp: hp * 60, sd: _aeDeg(Math.asin(AR_MOON_K * Math.sin(_aeRad(hp)))) * 60 })
  };
  if (!opts || !opts.noPlanets) {
    for (var i = 0; i < AR_PLANETS.length; i++) {
      var p = _arPlanet(AR_PLANETS[i], jde, nut);
      out[AR_PLANETS[i]] = _arBody(gast, p.ra, p.dec, { hp: AR_SOLAR_PARALLAX_ARCSEC / p.distAU / 60, sd: 0 });
    }
  }
  if (opts && opts.stars) {
    out.stars = AR_NAV_STARS.map(function (s) {
      var eq = _arStar(s, jde, nut);
      return { num: s[0], name: s[1], mag: s[8], sha: _arNorm360(-_aeDeg(eq.ra)), dec: _aeDeg(eq.dec) };
    });
  }
  return out;
}
function _arBody(gast, ra, dec, extra) {
  return { gha: _arNorm360(gast - _aeDeg(ra)), dec: _aeDeg(dec), hp: extra.hp, sd: extra.sd };
}

// The GHA and declination of one body (a key of _arNavAt's result, or
// 'star:<name>') at an instant, for sight reduction.
function _arBodyAt(key, ms) {
  if (key.indexOf('star:') === 0) {
    var name = key.slice(5);
    var nav = _arNavAt(ms, { noPlanets: true, stars: true });
    for (var i = 0; i < nav.stars.length; i++) {
      var s = nav.stars[i];
      if (s.name === name) return { gha: _arNorm360(nav.aries + s.sha), dec: s.dec, hp: 0, sd: 0, sha: s.sha };
    }
    return null;
  }
  var all = _arNavAt(ms, { noPlanets: AR_PLANETS.indexOf(key) < 0 });
  return all[key] || null;
}

// ── Sight reduction ──
// Dip of the sea horizon, arcminutes, for a height of eye in metres (the
// Nautical Almanac's 1.76' sqrt(h)).
var AR_DIP_ARCMIN_PER_SQRT_M = 1.76;
function _arDip(heightM) { return heightM > 0 ? AR_DIP_ARCMIN_PER_SQRT_M * Math.sqrt(heightM) : 0; }
// Refraction, arcminutes, for an apparent altitude (degrees): the Nautical
// Almanac's formula (Bennett), scaled for temperature (C) and pressure (hPa).
var AR_STD_TEMP_C = 10, AR_STD_PRESSURE_HPA = 1010;
function _arRefraction(haDeg, tempC, hPa) {
  if (tempC == null || isNaN(tempC)) tempC = AR_STD_TEMP_C;
  if (hPa == null || isNaN(hPa)) hPa = AR_STD_PRESSURE_HPA;
  var r0 = 1 / Math.tan(_aeRad(haDeg + 7.31 / (haDeg + 4.4)));
  return Math.max(0, r0 * 0.28 * hPa / (tempC + 273));
}
// Altitude and azimuth (degrees) of a body at declination dec and local hour
// angle lha seen from latitude lat: the navigator's Hc and Zn.
function _arAltAz(lat, dec, lha) {
  var L = _aeRad(lat), d = _aeRad(dec), h = _aeRad(lha);
  var sinH = Math.sin(L) * Math.sin(d) + Math.cos(L) * Math.cos(d) * Math.cos(h);
  var hc = Math.asin(Math.max(-1, Math.min(1, sinH)));
  var zn = Math.atan2(-Math.cos(d) * Math.sin(h), Math.sin(d) * Math.cos(L) - Math.cos(d) * Math.sin(L) * Math.cos(h));
  return { hc: _aeDeg(hc), zn: _arNorm360(_aeDeg(zn)) };
}
// A point dist nautical miles from lat/lon along true bearing brg (degrees):
// a great circle, which on a plotting sheet's few miles is the straight line.
function _arDestination(lat, lon, brg, distNm) {
  var d = _aeRad(distNm / 60), b = _aeRad(brg), p = _aeRad(lat);
  var p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
  var l2 = _aeRad(lon) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
  return { lat: _aeDeg(p2), lon: ((_aeDeg(l2) + 540) % 360) - 180 };
}

// The whole reduction, every step kept so the sheet can show its working.
// s: { body: 'sun'|'moon'|planet|'star:<name>', limb: 'lower'|'upper',
//      ms (UT), hs (degrees), ie (arcminutes, on the arc +), heightM,
//      tempC, hPa, lat, lon (the assumed position, east +) }.
function _arReduceSight(s) {
  var b = _arBodyAt(s.body, s.ms);
  if (!b) return null;
  var steps = { hs: s.hs, ie: -(s.ie || 0) / 60, dip: -_arDip(s.heightM || 0) / 60 };
  var ha = s.hs + steps.ie + steps.dip;
  steps.ha = ha;
  steps.refr = -_arRefraction(ha, s.tempC, s.hPa) / 60;
  var limbed = s.body === 'sun' || s.body === 'moon';
  steps.sd = 0;
  if (limbed) {
    var sd = b.sd;
    // The Moon is nearer when it is higher: its semi-diameter grows with
    // altitude (the augmentation the Almanac's Moon tables build in).
    if (s.body === 'moon') sd *= 1 + Math.sin(_aeRad(ha)) * Math.sin(_aeRad(b.hp / 60));
    steps.sd = (s.limb === 'upper' ? -sd : sd) / 60;
  }
  steps.pa = (b.hp || 0) * Math.cos(_aeRad(ha)) / 60;
  var ho = ha + steps.refr + steps.sd + steps.pa;
  var lha = _arNorm360(b.gha + s.lon);
  var c = _arAltAz(s.lat, b.dec, lha);
  var intercept = (ho - c.hc) * 60;   // nautical miles, toward the body when +
  var foot = _arDestination(s.lat, s.lon, c.zn, intercept);
  return { body: b, steps: steps, ho: ho, lha: lha, hc: c.hc, zn: c.zn, intercept: intercept,
    foot: foot, lopBearing: _arNorm360(c.zn + 90) };
}

// Latitude from a meridian altitude: the noon sight. Ho is the corrected
// altitude at its highest; bearing 'S' when the body stood to the south.
function _arNoonLatitude(ho, dec, bearing) {
  var zd = 90 - ho;
  return bearing === 'S' ? dec + zd : dec - zd;
}

// ═══════════════════════════════════════════════════════════════════════
// A year for one place: rise, set, twilight, transit, phases, eclipses
// ═══════════════════════════════════════════════════════════════════════
// The Sun and Moon are sampled once an hour across the year (one ephemeris
// call each), and every event is a crossing found between two samples by
// bisection on positions interpolated within that hour: the Sun's 2.5' an
// hour and the Moon's half degree are straight enough at that scale.
// Altitudes are geocentric; each threshold folds in what the eye adds:
// sunrise -50' (refraction 34' + semi-diameter 16'), twilights -6/-12/-18,
// the Moon 0.7275 HP - 34' (Meeus 15: its parallax and semi-diameter).
var AR_SUNRISE_ALT = -50 / 60;
var AR_TWILIGHT_ALTS = { civil: -6, nautical: -12, astronomical: -18 };
var AR_MOON_REFRACTION_DEG = 34 / 60;
var AR_MOON_HP_FACTOR = 0.7275;
var AR_PHASE_ANGLES = [0, 90, 180, 270];
// The ephemeris is sampled every AR_SAMPLE_HOURS; between samples the place
// is interpolated (the Moon's curvature over three hours moves it ~10", a
// second or two of time), altitudes are checked every AR_GRID_STEPS-th of an
// interval (20 minutes) for a crossing, and a crossing is bisected to
// AR_BISECT_STEPS halvings of that (about a second).
var AR_SAMPLE_HOURS = 3;
var AR_GRID_STEPS = 9;
var AR_BISECT_STEPS = 10;

function _arGmstDeg(jd) { return 280.46061837 + 360.98564736629 * (jd - JD_J2000); }

// Samples of the Sun and Moon every AR_SAMPLE_HOURS from t0 to t1 (ms, UT).
function _arSampleSky(t0, t1) {
  var step = AR_SAMPLE_HOURS * AR_MS_PER_HOUR;
  var n = Math.ceil((t1 - t0) / step) + 1, out = new Array(n);
  for (var i = 0; i < n; i++) {
    var ms = t0 + i * step, jd = _dateToJD(ms), jde = jd + _cnDeltaTdays(jd);
    var sun = _aeSun(jde), moon = _aeMoon(jde);
    out[i] = { ms: ms, jd: jd,
      sRa: sun.ra, sDec: sun.dec, sLon: sun.lon,
      mRa: moon.ra, mDec: moon.dec, mLon: moon.lon, mHp: Math.asin(AE_EARTH_RADIUS_KM / moon.distKm) };
  }
  return out;
}
function _arLerpAngle(a, b, f) {
  var d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * f;
}
// Altitude (degrees, geocentric) of the Sun (body 's') or the Moon ('m'), f
// of the way from sample a to sample b. The Moon's comes less its own rising
// threshold, which moves with its distance, so its events are crossings of 0.
function _arAlt(a, b, f, body, lat, lon) {
  var ra = _arLerpAngle(a[body + 'Ra'], b[body + 'Ra'], f), dec = a[body + 'Dec'] + (b[body + 'Dec'] - a[body + 'Dec']) * f;
  var jd = a.jd + (b.jd - a.jd) * f;
  var H = _aeRad(_arGmstDeg(jd) + lon) - ra, L = _aeRad(lat);
  var alt = _aeDeg(Math.asin(Math.sin(L) * Math.sin(dec) + Math.cos(L) * Math.cos(dec) * Math.cos(H)));
  if (body === 'm') alt -= AR_MOON_HP_FACTOR * _aeDeg(a.mHp + (b.mHp - a.mHp) * f) - AR_MOON_REFRACTION_DEG;
  return alt;
}
// Bisect g(f) = 0 on [lo, hi], where g(lo) has the sign of glo; returns f.
function _arBisect(g, lo, hi, glo) {
  for (var k = 0; k < AR_BISECT_STEPS; k++) {
    var mid = (lo + hi) / 2;
    if ((g(mid) < 0) === (glo < 0)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// Every crossing of each threshold (degrees) by a body's altitude: one list
// of [{ms, up}] per threshold, from one pass over the altitudes.
function _arCrossings(samples, body, lat, lon, thresholds) {
  var out = thresholds.map(function () { return []; });
  var prev = _arAlt(samples[0], samples[0], 0, body, lat, lon);
  for (var i = 1; i < samples.length; i++) {
    var a = samples[i - 1], b = samples[i];
    var g = function (x) { return _arAlt(a, b, x, body, lat, lon); };
    for (var s = 1; s <= AR_GRID_STEPS; s++) {
      var f0 = (s - 1) / AR_GRID_STEPS, f1 = s / AR_GRID_STEPS, cur = g(f1);
      for (var k = 0; k < thresholds.length; k++) {
        var h0 = thresholds[k];
        if ((prev < h0) !== (cur < h0)) {
          var f = _arBisect(function (x) { return g(x) - h0; }, f0, f1, prev - h0);
          out[k].push({ ms: a.ms + (b.ms - a.ms) * f, up: cur >= h0 });
        }
      }
      prev = cur;
    }
  }
  return out;
}
// Signed difference a - b of two angles in degrees, in (-180, 180].
function _arDeltaDeg(a, b) { return ((a - b + 540) % 360) - 180; }
// The instants a quantity q(a, b, f) (degrees, wrapping) passes target going
// up, between samples (to ten seconds). Shared by the Sun's transits and the
// phases; neither moves 90 degrees in a sample interval.
function _arAngleRises(samples, q, target) {
  var out = [];
  for (var i = 1; i < samples.length; i++) {
    var a = samples[i - 1], b = samples[i];
    var d1 = _arDeltaDeg(q(a, b, 0), target), d2 = _arDeltaDeg(q(a, b, 1), target);
    if (d1 < 0 && d2 >= 0 && d2 - d1 < 90) {
      var f = _arBisect(function (x) { return _arDeltaDeg(q(a, b, x), target); }, 0, 1, d1);
      out.push({ ms: a.ms + (b.ms - a.ms) * f, a: a, b: b, f: f });
    }
  }
  return out;
}
// The Sun's upper transits (local apparent noon) and its altitude there.
function _arTransits(samples, lat, lon) {
  return _arAngleRises(samples, function (a, b, f) {
    return _arGmstDeg(a.jd + (b.jd - a.jd) * f) + lon - _aeDeg(_arLerpAngle(a.sRa, b.sRa, f));
  }, 0).map(function (r) {
    var dec = _aeDeg(r.a.sDec + (r.b.sDec - r.a.sDec) * r.f);
    return { ms: r.ms, alt: 90 - Math.abs(lat - dec) };
  });
}
// The Moon's principal phases: the instants its longitude leads the Sun's by
// 0, 90, 180 and 270 degrees. [{ms, q}], q the quarter (0 = new).
function _arPhases(samples) {
  function elong(a, b, f) { return (a.mLon - a.sLon) + _arDeltaDeg(b.mLon - b.sLon, a.mLon - a.sLon) * f; }
  var out = [];
  for (var q = 0; q < AR_PHASE_ANGLES.length; q++) {
    _arAngleRises(samples, elong, AR_PHASE_ANGLES[q]).forEach(function (r) { out.push({ ms: r.ms, q: q }); });
  }
  return out.sort(function (x, y) { return x.ms - y.ms; });
}

// What one place sees of an eclipse, sampled every AR_ECL_STEP_MS across
// AR_ECL_HALF_SPAN_MS either side of greatest eclipse. Solar: the largest
// fraction of the Sun's diameter covered while the Sun is up, and whether the
// Moon covers it whole (total) or sits inside it (annular). Lunar: the
// deepest umbral magnitude while the Moon is up.
var AR_ECL_STEP_MS = 2 * 60000;
var AR_ECL_HALF_SPAN_MS = 4 * AR_MS_PER_HOUR;
function _arEclipseHere(greatestMs, solar, lat, lon) {
  var fixed = _aeGeodeticToFixed(lat, lon), up = _aeNorm(fixed);
  var best = null, start = null, end = null;
  for (var ms = greatestMs - AR_ECL_HALF_SPAN_MS; ms <= greatestMs + AR_ECL_HALF_SPAN_MS; ms += AR_ECL_STEP_MS) {
    var sc = _aeSceneAt(ms);
    var obs = _aeFixedToScene(fixed, sc.gast), upS = _aeFixedToScene(up, sc.gast);
    var mag = 0, kind = null, alt;
    if (solar) {
      var toSun = _aeSub(sc.sun, obs), toMoon = _aeSub(sc.moon, obs);
      alt = 90 - _aeDeg(_aeAngle(toSun, upS));
      var rs = Math.asin(AE_SUN_RADIUS_RE / _aeLen(toSun)), rm = Math.asin(AE_MOON_RADIUS_RE / _aeLen(toMoon));
      var sep = _aeAngle(toSun, toMoon);
      if (alt > AR_SUNRISE_ALT && sep < rs + rm) {
        mag = (rs + rm - sep) / (2 * rs);
        kind = sep <= Math.abs(rm - rs) ? (rm >= rs ? 'total' : 'annular') : 'partial';
      }
    } else {
      alt = 90 - _aeDeg(_aeAngle(_aeSub(sc.moon, obs), upS));
      var sh = _aeLunarShadow(sc);
      if (alt > 0 && sh.penumbralMag > 0) {
        mag = sh.umbralMag;
        kind = sh.umbralMag >= 1 ? 'total' : (sh.umbralMag > 0 ? 'partial' : 'penumbral');
      }
    }
    if (kind) {
      if (start === null) start = ms;
      end = ms;
      if (!best || mag > best.mag) best = { ms: ms, mag: mag, kind: kind };
    }
  }
  return best ? { ms: best.ms, mag: best.mag, kind: best.kind, start: start, end: end } : null;
}
// The year's eclipses (UT year), each with its greatest instant and what the
// place at lat/lon sees of it (null: nothing).
var AR_ECLIPSES_PER_YEAR_MAX = 8;
function _arYearEclipses(year, lat, lon) {
  var from = new Date(0);
  from.setUTCFullYear(year, 0, 1);
  var list = _computeEclipses(new Date(from.getTime() - 2 * MS_PER_DAY), AR_ECLIPSES_PER_YEAR_MAX), out = [];
  for (var i = 0; i < list.length; i++) {
    var m = /^(-?\d+)-(\d+)-(\d+)$/.exec(list[i].date);
    if (!m) continue;
    var guess = new Date(0);
    guess.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
    var at = _aeGreatestEclipse(guess.getTime() + MS_PER_DAY / 2, list[i].solar);
    if (new Date(at).getUTCFullYear() !== year) continue;
    out.push({ ms: at, solar: list[i].solar, type: list[i].type, here: _arEclipseHere(at, list[i].solar, lat, lon) });
  }
  return out;
}

// A calendar day {y, m, d} as a sortable number, and the UT midnight it starts.
function _arKeyNum(k) { return k.y * 10000 + k.m * 100 + k.d; }
function _arDayMs(k) { var d = new Date(0); d.setUTCFullYear(k.y, k.m - 1, k.d); return d.getTime(); }

// Every local day from one calendar day to another (inclusive), for one place
// and time zone: rise, set, twilights, transit, moonrise and moonset, and the
// Moon's principal phases among them. tz is an IANA zone (or null for the
// device's own). The tables draw any span from it; a year is one span.
function _arSpan(from, to, lat, lon, tz) {
  var a = _arDayMs(from), b = _arDayMs(to) + MS_PER_DAY;
  var lo = _arKeyNum(from), hi = _arKeyNum(to);
  // A day's margin each side: local days begin up to 14 hours from UT's.
  var samples = _arSampleSky(a - MS_PER_DAY, b + MS_PER_DAY);
  var dayKey = _arLocalDayKeyer(tz);
  var days = {};
  function day(ms) {
    var k = dayKey(ms), n = _arKeyNum(k);
    if (n < lo || n > hi) return null;
    if (!days[k.key]) days[k.key] = { y: k.y, m: k.m, d: k.d };
    return days[k.key];
  }
  function note(list, upName, downName) {
    list.forEach(function (c) {
      var r = day(c.ms);
      if (!r) return;
      var f = c.up ? upName : downName;
      if (r[f] == null) r[f] = c.ms;
    });
  }
  var tws = Object.keys(AR_TWILIGHT_ALTS);
  var sunX = _arCrossings(samples, 's', lat, lon, [AR_SUNRISE_ALT].concat(tws.map(function (k) { return AR_TWILIGHT_ALTS[k]; })));
  note(sunX[0], 'rise', 'set');
  tws.forEach(function (k, i) { note(sunX[i + 1], k + 'Dawn', k + 'Dusk'); });
  note(_arCrossings(samples, 'm', lat, lon, [0])[0], 'moonrise', 'moonset');
  _arTransits(samples, lat, lon).forEach(function (tr) {
    var r = day(tr.ms);
    if (r && r.noon == null) { r.noon = tr.ms; r.noonAlt = tr.alt; }
  });
  var phases = _arPhases(samples).filter(function (p) {
    var r = day(p.ms);
    if (r) r.phase = p.q;
    return !!r;
  });
  // Every calendar day of the span, in order, even one with no event.
  var rows = [];
  // Noon UT steps through every local day for any offset (-12 to +14 h);
  // starting a day early catches the first day of zones ahead of UT.
  for (var ms = a - MS_PER_DAY / 2; ; ms += MS_PER_DAY) {
    var k = dayKey(ms), n = _arKeyNum(k);
    if (n > hi) break;
    if (n < lo) continue;
    var r = days[k.key] || { y: k.y, m: k.m, d: k.d };
    if (rows.length && rows[rows.length - 1] === r) continue;
    // Neither rise nor set: up all day or down all day, by the noon altitude.
    if (r.rise == null && r.set == null && r.noonAlt != null) r.polar = r.noonAlt > AR_SUNRISE_ALT ? 'up' : 'down';
    if (r.rise != null && r.set != null && r.set > r.rise) r.length = r.set - r.rise;
    rows.push(r);
  }
  return { rows: rows, phases: phases };
}
// The year's four season instants (UT ms): March equinox, June solstice,
// September equinox, December solstice.
function _arSeasons(year) {
  var out = [];
  for (var s = 0; s < 4; s++) {
    var jde = _seasonInstantJDE(year, s);
    out.push((jde - _cnDeltaTdays(jde) - JD_UNIX_EPOCH) * MS_PER_DAY);
  }
  return out;
}
// A whole year for one place: its days, phases, seasons and eclipses.
function _arYear(year, lat, lon, tz) {
  var span = _arSpan({ y: year, m: 1, d: 1 }, { y: year, m: 12, d: 31 }, lat, lon, tz);
  return { rows: span.rows, phases: span.phases, seasons: _arSeasons(year), eclipses: _arYearEclipses(year, lat, lon) };
}
// A function from an instant to its calendar day in time zone tz: {y, m, d, key}.
function _arLocalDayKeyer(tz) {
  var fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric', era: 'short' }); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', era: 'short' }); }
  return function (ms) {
    var p = fmt.formatToParts(new Date(ms)), o = {};
    for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    var y = +o.year;
    if (o.era && /^B/.test(o.era)) y = 1 - y;
    return { y: y, m: +o.month, d: +o.day, key: y + '-' + o.month + '-' + o.day };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Sun time: the equation of time, and a sundial's corrections for a place
// ═══════════════════════════════════════════════════════════════════════
var AR_MIN_PER_DEG = 4;
var AR_HOURS_PER_DEG = 1 / 15;

// The equation of time at an instant, minutes: apparent solar time less
// mean solar time (positive when a sundial is ahead of the clock), and the
// Sun's declination (degrees). From the Sun's Greenwich hour angle.
function _arEquationOfTime(ms) {
  var jd = _dateToJD(ms), jde = jd + _cnDeltaTdays(jd);
  var sun = _aeSun(jde);
  var gha = _arNorm360(_aeDeg(_aeGast(jd, sun.nut)) - _aeDeg(sun.ra));
  var utDeg = ((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY / MS_PER_DAY * 360;
  return { eot: _arDeltaDeg(gha, utDeg + 180) * AR_MIN_PER_DEG, dec: _aeDeg(sun.dec) };
}
// Each day of a year at a place: when the Sun crosses the meridian (UT ms),
// the equation of time and declination there, and - for a sundial - how
// many minutes its clock (zone tz, daylight saving included) reads past
// 12:00 at that moment: add it to sundial time to get clock time.
function _arSunTimeSpan(from, to, lon, tz) {
  var lo = _arKeyNum(from), hi = _arKeyNum(to);
  var clock = _arClockMinutes(tz), out = [];
  for (var ms = _arDayMs(from) - MS_PER_DAY; ; ms += MS_PER_DAY) {
    // Local mean noon, then the equation of time there twice: it moves 30 s a day at most.
    var mean = ms + (12 - lon * AR_HOURS_PER_DEG) * AR_MS_PER_HOUR;
    var e = _arEquationOfTime(mean);
    e = _arEquationOfTime(mean - e.eot * 60000);
    var noon = mean - e.eot * 60000;
    var c = clock(noon), n = _arKeyNum(c);
    if (n > hi) break;
    if (n < lo) continue;
    if (out.length && out[out.length - 1].d === c.d && out[out.length - 1].m === c.m) continue;
    out.push({ y: c.y, m: c.m, d: c.d, noon: noon, eot: e.eot, dec: e.dec, correction: c.minutes - 12 * 60 });
  }
  return out;
}
function _arSunTimeYear(year, lon, tz) { return _arSunTimeSpan({ y: year, m: 1, d: 1 }, { y: year, m: 12, d: 31 }, lon, tz); }
// A function from an instant to its clock reading in zone tz: {y, m, d, minutes}.
function _arClockMinutes(tz) {
  var fmt;
  var opts = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', era: 'short' };
  try { fmt = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || undefined }, opts)); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-US', opts); }
  return function (ms) {
    var p = fmt.formatToParts(new Date(ms)), o = {};
    for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    var y = +o.year;
    if (o.era && /^B/.test(o.era)) y = 1 - y;
    return { y: y, m: +o.month, d: +o.day, minutes: (+o.hour % 24) * 60 + +o.minute + +o.second / 60 };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// The star calendar: the bright stars' first and last appearances
// ═══════════════════════════════════════════════════════════════════════
// A star is seen rising at dawn (its heliacal rising) once the Sun is far
// enough below the horizon as the star clears it: the arcus visionis, about
// 10 degrees for a first-magnitude star, less for a brighter one (Schoch's
// rule of thumb, 10 + magnitude). Its heliacal setting is the last evening
// it is seen setting after dusk. A clear, flat horizon is assumed; haze and
// hills move both a few days, which is why every date is "about".
var AR_ARCUS_VISIONIS_DEG = 10;
var AR_STAR_RISE_ALT = -34 / 60;
var AR_STAR_MIN_ALT = 5;
var AR_STAR_CAL_MAG = 1.3;
// The Pleiades: not a navigational star, but the oldest of these calendars
// (Hesiod's ploughing, Matariki). Alcyone's place; the cluster shines ~1.6.
var AR_EXTRA_CAL_STARS = [[0, 'Pleiades', 56.871152, 24.105136, 19.34, -43.67, 8.09, 10, 1.6]];
var AR_SIDEREAL_DEG_PER_DAY = 360.98564736629;

function _arStarCalendarStars() {
  return AR_NAV_STARS.filter(function (s) { return s[8] <= AR_STAR_CAL_MAG; }).concat(AR_EXTRA_CAL_STARS);
}
// For the year at lat/lon: per star, its heliacal rising and setting (UT
// ms, at the star's rise or set), or why it has none ('never' below the
// horizon, 'always' circumpolar, 'seen' visible all year).
function _arStarCalendar(year, lat, lon) {
  var start = new Date(0); start.setUTCFullYear(year, 0, 1);
  var jd0 = _dateToJD(start.getTime()), days = 368;
  // The Sun at each 0h UT, once; interpolated between.
  var sun = [];
  for (var i = -1; i <= days; i++) {
    var jd = jd0 + i, s = _aeSun(jd + _cnDeltaTdays(jd));
    sun.push({ ra: _aeDeg(s.ra), dec: s.dec });
  }
  function sunAlt(jd) {
    var k = Math.floor(jd - jd0) + 1, f = jd - jd0 + 1 - k;
    var a = sun[k], b = sun[k + 1];
    var ra = a.ra + _arDeltaDeg(b.ra, a.ra) * f, dec = a.dec + (b.dec - a.dec) * f;
    var H = _aeRad(_arGmstDeg(jd) + lon - ra), L = _aeRad(lat);
    return _aeDeg(Math.asin(Math.sin(L) * Math.sin(dec) + Math.cos(L) * Math.cos(dec) * Math.cos(H)));
  }
  var mid = jd0 + 182 + _cnDeltaTdays(jd0);
  return _arStarCalendarStars().map(function (st) {
    var eq = _arStar(st, mid), ra = _aeDeg(eq.ra), dec = eq.dec, L = _aeRad(lat);
    var cosH = (Math.sin(_aeRad(AR_STAR_RISE_ALT)) - Math.sin(L) * Math.sin(dec)) / (Math.cos(L) * Math.cos(dec));
    var res = { name: st[1], mag: st[8], dec: _aeDeg(dec) };
    // A star that never climbs clear of the horizon's haze is never seen.
    if (cosH > 1 || 90 - Math.abs(lat - res.dec) < AR_STAR_MIN_ALT) { res.none = 'never'; return res; }
    if (cosH < -1) { res.none = 'always'; return res; }
    var H0 = _aeDeg(Math.acos(cosH)), av = AR_ARCUS_VISIONIS_DEG + st[8];
    // The star's rise (or set) on UT day i, and whether the sky is dark then.
    function event(i, sign) {
      var lst = ra + sign * H0, d0 = jd0 + i;
      var t = d0 + _arNorm360(lst - _arGmstDeg(d0) - lon) / AR_SIDEREAL_DEG_PER_DAY;
      return { jd: t, dark: sunAlt(t) <= -av };
    }
    var prevR = event(-1, -1).dark, prevS = event(-1, 1);
    for (var d = 0; d < days - 2; d++) {
      var r = event(d, -1), s = event(d, 1);
      if (!prevR && r.dark && res.rising == null) res.rising = (r.jd - JD_UNIX_EPOCH) * MS_PER_DAY;
      if (prevS.dark && !s.dark && res.setting == null) res.setting = (prevS.jd - JD_UNIX_EPOCH) * MS_PER_DAY;
      prevR = r.dark; prevS = s;
    }
    if (res.rising == null && res.setting == null) res.none = 'seen';
    return res;
  }).sort(function (a, b) { return (a.rising || Infinity) - (b.rising || Infinity); });
}

// ═══════════════════════════════════════════════════════════════════════
// Calendars: the computus, the movable holidays, the Persian year by the Sun
// ═══════════════════════════════════════════════════════════════════════
var AR_DOMINICAL_LETTERS = 'ABCDEFG';

// The Gregorian computus (the Gauss/Knuth form of the tables of 1582),
// with its working: golden number, epact, the Paschal full moon (a March
// day number past 31 runs into April), Sunday letter(s), Easter.
function _arComputusGregorian(y) {
  var G = y % 19 + 1, C = Math.floor(y / 100) + 1;
  var X = Math.floor(3 * C / 4) - 12;                 // the solar correction: dropped leap days
  var Z = Math.floor((8 * C + 5) / 25) - 5;           // the lunar correction
  var D = Math.floor(5 * y / 4) - X - 10;             // March (-D mod 7) is a Sunday
  var E = _floorMod(11 * G + 20 + Z - X, 30);         // the epact: the Moon's age on 1 January
  if ((E === 25 && G > 11) || E === 24) E++;
  var N = 44 - E;
  if (N < 21) N += 30;                                // the Paschal full moon, as a March day
  var easter = N + 7 - _floorMod(D + N, 7);
  return { golden: G, epact: E, solarCorr: X, lunarCorr: Z, pfm: _gregorianToJDN(y, 3, 1) + N - 1,
    letters: _arSundayLetters(y, 'gregorian'), easter: _gregorianToJDN(y, 3, 1) + easter - 1 };
}
// The Julian computus of the Orthodox churches: the 19-year cycle with no
// corrections, its Paschal full moon and Easter in the Julian calendar,
// then carried to a Gregorian day.
function _arComputusJulian(y) {
  var a = y % 19, d = (19 * a + 15) % 30;
  var e = (2 * (y % 4) + 4 * (y % 7) - d + 34) % 7;
  var pfm = _julianToJDN(y, 3, 21) + d;
  return { golden: a + 1, pfmOffset: d, pfm: pfm, letters: _arSundayLetters(y, 'julian'), easter: pfm + e + 1 };
}
// The Sunday (dominical) letter: A if 1 January is a Sunday, B if the 2nd,
// and so on; a leap year has two, the second from March on.
function _arSundayLetters(y, sys) {
  var jan1 = sys === 'julian' ? _julianToJDN(y, 1, 1) : _gregorianToJDN(y, 1, 1);
  var i = (7 - _floorMod(jan1 + 1, 7)) % 7;   // (JDN + 1) mod 7 is 0 on a Sunday
  var leap = sys === 'julian' ? y % 4 === 0 : (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return AR_DOMINICAL_LETTERS[i] + (leap ? AR_DOMINICAL_LETTERS[(i + 6) % 7] : '');
}

// Nowruz by the Sun, the rule Iran's calendar keeps: 1 Farvardin is the day
// the March equinox falls before noon at the 52.5 E meridian (Iran Standard
// Time, UT+3:30), else the day after. Returns the Gregorian year's JDN.
var AR_IRAN_OFFSET_H = 3.5;
function _arNowruzJDN(gy) {
  var jde = _seasonInstantJDE(gy, 0);
  var local = jde - _cnDeltaTdays(jde) + AR_IRAN_OFFSET_H / 24;   // JD in Iran time
  var day = Math.floor(local + 0.5);                              // its civil day number
  return (local + 0.5 - day) < 0.5 ? day : day + 1;
}

// The Persian (Solar Hijri) calendar by that rule: six months of 31 days,
// five of 30, and Esfand of 29 or 30 as the next Nowruz decides. The
// Almanac's month grid uses the 33-year arithmetic (almanac.js); the two
// agree on every year from 1799 to 2222, and past that the Sun is the rule.
var AR_PERSIAN_YEAR_OFFSET = 621;
var AR_PERSIAN_LONG_MONTHS_DAYS = 186;   // six months of 31
function _arPersianToJDN(py, pm, pd) {
  return _arNowruzJDN(py + AR_PERSIAN_YEAR_OFFSET) + (pm <= 6 ? (pm - 1) * 31 : AR_PERSIAN_LONG_MONTHS_DAYS + (pm - 7) * 30) + pd - 1;
}
function _arPersianDaysInMonth(py, pm) {
  if (pm <= 6) return 31;
  if (pm <= 11) return 30;
  return _arNowruzJDN(py + AR_PERSIAN_YEAR_OFFSET + 1) - _arPersianToJDN(py, 12, 1);
}
function _arPersianFromJDN(jdn) {
  var gy = _jdnToGregorian(jdn).year;
  if (jdn < _arNowruzJDN(gy)) gy--;
  var doy = jdn - _arNowruzJDN(gy);
  var long = doy < AR_PERSIAN_LONG_MONTHS_DAYS;
  return { year: gy - AR_PERSIAN_YEAR_OFFSET,
    month: long ? Math.floor(doy / 31) + 1 : Math.floor((doy - AR_PERSIAN_LONG_MONTHS_DAYS) / 30) + 7,
    day: long ? doy % 31 + 1 : (doy - AR_PERSIAN_LONG_MONTHS_DAYS) % 30 + 1 };
}

// The converter's calendars, one interface: to and from a JDN, and a year's
// months as [{name, days}]. Five come from the Almanac's month grid.
var AR_CAL_SYSTEMS = ['gregorian', 'julian', 'hebrew', 'islamic', 'persian', 'chinese'];
function _arCalToJDN(sys, y, m, d) {
  return sys === 'persian' ? _arPersianToJDN(y, m, d) : _calFirstDayJDN(sys, y, m) + d - 1;
}
function _arCalFromJDN(sys, jdn) {
  return sys === 'persian' ? _arPersianFromJDN(jdn) : _jdnToCalendar(sys, jdn);
}
function _arCalMonths(sys, y) {
  var out = [];
  var n = sys === 'persian' ? 12 : _calMonthCount(sys, y);
  for (var m = 1; m <= n; m++) {
    out.push({ name: _calMonthName(sys, y, m),
      days: sys === 'persian' ? _arPersianDaysInMonth(y, m) : _calDaysInMonth(sys, y, m) });
  }
  return out;
}

// The movable feasts of one Gregorian year, as JDNs. The Islamic ones come
// from the tabular calendar (30-year cycle) and may fall a day or two from
// the sighted crescent; each may occur twice in a year, or not at all.
function _arHolidays(gy) {
  var out = {
    easter: _arComputusGregorian(gy).easter,
    orthodox: _arComputusJulian(gy).easter,
    passover: _arHebrewDay(gy + 3760, 'Nisan', 15),
    roshHashanah: _hebrewNewYear(gy + 3761),
    cny: _cnChineseNewYearJDN(gy),
    nowruz: _arNowruzJDN(gy),
    ramadan: [], eidFitr: [], eidAdha: []
  };
  var j0 = _gregorianToJDN(gy, 1, 1), j1 = _gregorianToJDN(gy + 1, 1, 1);
  for (var hy = _jdnToHijri(j0).year; hy <= _jdnToHijri(j1).year; hy++) {
    [['ramadan', 9, 1], ['eidFitr', 10, 1], ['eidAdha', 12, 10]].forEach(function (h) {
      var j = _hijriToJDN(hy, h[1], h[2]);
      if (j >= j0 && j < j1) out[h[0]].push(j);
    });
  }
  return out;
}
function _arHebrewDay(hy, monthName, day) {
  var months = _hebrewMonthList(hy);
  for (var i = 0; i < months.length; i++) if (months[i].name === monthName) return _calFirstDayJDN('hebrew', hy, i + 1) + day - 1;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Words and numbers, as the tables print them
// ═══════════════════════════════════════════════════════════════════════

function _arT(k, vars) { return t('ref_' + k, vars); }
function _arTH(k, vars) { return _almEsc(_arT(k, vars)); }
function _arLang() { return (typeof _currentLang !== 'undefined' && _currentLang) || 'en'; }

// Formatters, built once per language and zone (Intl construction is slow).
var _arFmtCache = {};
function _arFmt(key, opts) {
  var k = _arLang() + '|' + key;
  if (!_arFmtCache[k]) {
    try { _arFmtCache[k] = new Intl.DateTimeFormat(_arLang(), opts); }
    catch (e) { _arFmtCache[k] = new Intl.DateTimeFormat('en', Object.assign({}, opts, { timeZone: 'UTC' })); }
  }
  return _arFmtCache[k];
}
function _arTime(ms, tz) {
  if (ms == null) return '–';
  // To the nearest minute, as almanacs print (Intl would truncate).
  ms = Math.round(ms / 60000) * 60000;
  return _arFmt('hm|' + tz, { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
function _arDateTime(ms, tz) {
  return _arFmt('dt|' + tz, { timeZone: tz || undefined, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
function _arLongDate(ms, tz) {
  return _arFmt('ld|' + tz, { timeZone: tz || undefined, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms));
}
function _arShortDate(ms, tz) {
  return _arFmt('sd|' + tz, { timeZone: tz || undefined, month: 'short', day: 'numeric' }).format(new Date(ms));
}
function _arMonthName(m) {
  var d = new Date(0); d.setUTCFullYear(2001, m - 1, 1);
  return _arFmt('mon', { timeZone: 'UTC', month: 'long' }).format(d);
}
function _arMonthShort(m) {
  var d = new Date(0); d.setUTCFullYear(2001, m - 1, 1);
  return _arFmt('mons', { timeZone: 'UTC', month: 'short' }).format(d);
}
function _arNum(n, digits) {
  return _arFmtNum(digits).format(n);
}
var _arNumCache = {};
function _arFmtNum(digits) {
  var k = _arLang() + digits;
  if (!_arNumCache[k]) _arNumCache[k] = new Intl.NumberFormat(_arLang(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return _arNumCache[k];
}
// The UT midnight (ms) that starts the civil day a JDN names (JDNs fall at noon).
function _arJdnMs(jdn) { return (jdn - 0.5 - JD_UNIX_EPOCH) * MS_PER_DAY; }
// A JDN as a Gregorian date, in the reader's words.
function _arJdnDate(jdn, long) {
  var d = new Date(_arJdnMs(jdn));
  return long ? _arLongDate(d.getTime(), 'UTC') : _arShortDate(d.getTime(), 'UTC');
}

// Navigation notation stays the Nautical Almanac's whatever the language:
// degrees and minutes to a tenth, "183 45.6", declinations "N 23 26.4".
function _arDM(deg) {
  var a = Math.abs(deg), d = Math.floor(a), m = Math.round((a - d) * 600) / 10;
  if (m >= 60) { d += 1; m = 0; }
  return d + ' ' + (m < 10 ? '0' : '') + m.toFixed(1);
}
function _arNavGha(deg) { return _arDM(_arNorm360(deg)); }
function _arNavDec(deg) { return (deg >= 0 ? 'N ' : 'S ') + _arDM(deg); }
function _arDegMin(deg) {
  var a = Math.abs(deg), d = Math.floor(a), m = Math.round((a - d) * 600) / 10;
  if (m >= 60) { d += 1; m = 0; }
  return d + '°' + (m < 10 ? '0' : '') + m.toFixed(1) + '′';
}
function _arLatText(lat) { return _arDegMin(lat) + (lat >= 0 ? 'N' : 'S'); }
function _arLonText(lon) { return _arDegMin(lon) + (lon >= 0 ? 'E' : 'W'); }
function _arArcmin(min) { return (min >= 0 ? '+' : '−') + Math.abs(min).toFixed(1) + '′'; }
// Minutes as a signed "m:ss", for the sundial.
function _arMinSec(min) {
  // Past an hour (a daylight-saving clock), hours too: +1:06:42.
  var s = Math.round(Math.abs(min) * 60), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return (min < 0 ? '−' : '+') + (hh ? hh + ':' + pad(mm) : mm) + ':' + pad(ss);
}
// A magnitude to a tenth, never "-0.0".
function _arMag(m) { return ((Math.round(m * 10) / 10) || 0).toFixed(1); }
function _arDuration(ms) {
  if (ms == null) return '–';
  var m = Math.round(ms / 60000);
  return Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60);
}

// The UT day (ms at 0h) holding an instant.
function _arUtDay(ms) { return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY; }

// The span the sheets accept. The maths runs further; this is where delta T
// (the Earth's unpredictable spin) has stopped being a matter of seconds.
var _AR_MIN_YEAR = -2000, _AR_MAX_YEAR = 4000;
// Past these, the sheets say the clock times are uncertain by minutes or more.
var _AR_DELTA_T_SURE_FROM = 1600, _AR_DELTA_T_SURE_TO = 2100;
function _arDeltaTNote(year) {
  return (year < _AR_DELTA_T_SURE_FROM || year > _AR_DELTA_T_SURE_TO) ? '<p class="alm-ref-note alm-ref-warn">' + _arTH('far_year') + '</p>' : '';
}

function _arTable(head, rows, cls) {
  return '<div class="alm-ref-scroll"><table class="alm-ref-table' + (cls ? ' ' + cls : '') + '"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
}
function _arTh(cells) { return '<tr>' + cells.map(function (c) { return '<th scope="col">' + c + '</th>'; }).join('') + '</tr>'; }
function _arTr(cells, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }

// ── The Nautical Almanac's day ──
var AR_MOON_V_BASE_ARCMIN = 14 * 60 + 19.0;   // the Moon's tabulated hourly GHA step, 14 19.0
var AR_SUN_V_BASE_ARCMIN = 15 * 60;            // the Sun's and planets', 15 00.0
// The UT (hh:mm) a body's GHA passes target degrees during the day, from the
// hourly rows; '–' when it does not that day.
function _arMerPass(rows, key, target) {
  for (var h = 0; h < AR_HOURS; h++) {
    var a = key === 'aries' ? rows[h].aries : rows[h][key].gha;
    var b = key === 'aries' ? rows[h + 1].aries : rows[h + 1][key].gha;
    var da = _arDeltaDeg(a, target), db = _arDeltaDeg(b, target);
    if (da < 0 && db >= 0 && db - da < 90) {
      var m = Math.round((h + (-da) / (db - da)) * 60);
      return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    }
  }
  return '–';
}

// ── 2. Sight reduction ──
var AR_FT_PER_M = 3.28084;
var AR_EXAMPLE_IE_ARCMIN = 1.2, AR_EXAMPLE_EYE_M = 3, AR_EXAMPLE_INTERCEPT_NM = 1.5;
var AR_EXAMPLE_HOURS_BEFORE_NOON = 2, AR_EXAMPLE_MIN_ALT = 10;
var AR_PLOT_SPAN_NM = 10;   // the plotting sheet's half-width
var AR_NOON_LHA_DEG = 2;    // a sight within 8 minutes of the meridian is a noon sight

// p: the place ({lat, lon}); dayMs: an instant on the day to use.
function _arSightDefaults(p, dayMs) {
  var day = _arUtDay(dayMs);
  // A worked example, so the page teaches from its first second: the Sun two
  // hours before local noon at the place, measured 1.5 miles toward it; at a
  // polar winter's noon, the brightest navigational star that is well up.
  var noon = day + (12 - p.lon * AR_HOURS_PER_DEG) * AR_MS_PER_HOUR;
  noon -= _arEquationOfTime(noon).eot * 60000;
  var ms = Math.round((noon - AR_EXAMPLE_HOURS_BEFORE_NOON * AR_MS_PER_HOUR) / 60000) * 60000;
  var s = { body: 'sun', limb: 'lower', ms: ms, ie: AR_EXAMPLE_IE_ARCMIN, heightM: AR_EXAMPLE_EYE_M, tempC: AR_STD_TEMP_C, hPa: AR_STD_PRESSURE_HPA,
    lat: Math.round(p.lat * 60) / 60, lon: Math.round(p.lon * 60) / 60, unit: 'm' };
  var b = _arBodyAt('sun', ms);
  if (_arAltAz(s.lat, b.dec, b.gha + s.lon).hc < AR_EXAMPLE_MIN_ALT) {
    var nav = _arNavAt(ms, { noPlanets: true, stars: true }), best = null;
    nav.stars.forEach(function (st) {
      var h = _arAltAz(s.lat, st.dec, nav.aries + st.sha + s.lon).hc;
      if (h > AR_EXAMPLE_MIN_ALT * 2 && (!best || st.mag < best.mag)) best = st;
    });
    if (best) s.body = 'star:' + best.name;
  }
  // Work back from the computed altitude to the sextant reading.
  s.hs = 45;
  for (var i = 0; i < 4; i++) {
    var r = _arReduceSight(s);
    s.hs -= (r.intercept - AR_EXAMPLE_INTERCEPT_NM) / 60;
  }
  s.hs = Math.round(s.hs * 600) / 600;
  return s;
}
// A plotting sheet: north up, the assumed position at the centre, the
// azimuth line, the intercept, and the line of position square across it.
function _arPlotSvg(s, r) {
  var W = 240, c = W / 2, k = c / AR_PLOT_SPAN_NM;
  var zr = _aeRad(r.zn), ix = Math.sin(zr), iy = -Math.cos(zr);
  var a = Math.max(-AR_PLOT_SPAN_NM, Math.min(AR_PLOT_SPAN_NM, r.intercept));
  var fx = c + ix * a * k, fy = c + iy * a * k;
  var lx = -iy, ly = ix, L = W;
  var grid = '';
  for (var g = -AR_PLOT_SPAN_NM; g <= AR_PLOT_SPAN_NM; g += 5) {
    grid += '<line x1="' + (c + g * k) + '" y1="0" x2="' + (c + g * k) + '" y2="' + W + '" class="g"/><line x1="0" y1="' + (c + g * k) + '" x2="' + W + '" y2="' + (c + g * k) + '" class="g"/>';
  }
  return '<svg viewBox="0 0 ' + W + ' ' + W + '" role="img" aria-label="' + _arTH('plot_label') + '">' +
    '<style>.g{stroke:var(--border);stroke-width:1}.az{stroke:var(--text2);stroke-width:1.2;stroke-dasharray:4 3}.lop{stroke:var(--amber);stroke-width:2.5}.t{fill:var(--text2);font:10px sans-serif}</style>' +
    '<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (W - 1) + '" fill="none" stroke="var(--border)"/>' + grid +
    '<line x1="' + c + '" y1="' + c + '" x2="' + (c + ix * c * 0.95) + '" y2="' + (c + iy * c * 0.95) + '" class="az"/>' +
    '<line x1="' + (fx - lx * L) + '" y1="' + (fy - ly * L) + '" x2="' + (fx + lx * L) + '" y2="' + (fy + ly * L) + '" class="lop"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="4" fill="none" stroke="var(--text)" stroke-width="1.5"/>' +
    '<circle cx="' + fx + '" cy="' + fy + '" r="3" fill="var(--amber)"/>' +
    // AP's label on the side away from the body, clear of both lines.
    '<text x="' + (c - ix * 14 - (ix > 0 ? 6 : -2)).toFixed(1) + '" y="' + (c - iy * 14 + 4).toFixed(1) + '" class="t" text-anchor="middle">AP</text>' +
    '<text x="' + (c - 3) + '" y="11" class="t">N</text>' +
    '<rect x="4" y="4" width="64" height="14" fill="var(--bg)"/><text x="6" y="14" class="t">' + _arTH('grid_nm') + '</text></svg>';
}

// ── The Sun and Moon over days ──
var AR_PHASE_GLYPHS = ['●', '◑', '○', '◐'];   // new, first quarter, full, last quarter
var AR_PHASE_KEYS = ['new_moon', 'first_quarter', 'full_moon', 'last_quarter'];

// The analemma: the equation of time across, the declination up, one dot a
// day and the first of each month marked. Its scales come from the data.
function _arAnalemmaSvg(rows) {
  var W = 200, H = 300, pad = 24;
  var eMax = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.eot); }));
  var dMax = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.dec); }));
  var x = function (e) { return W / 2 + e / eMax * (W / 2 - pad); };
  var y = function (d) { return H / 2 - d / dMax * (H / 2 - pad); };
  var path = rows.map(function (r, i) { return (i ? 'L' : 'M') + x(r.eot).toFixed(1) + ' ' + y(r.dec).toFixed(1); }).join('');
  var marks = rows.filter(function (r) { return r.d === 1; }).map(function (r) {
    return '<circle cx="' + x(r.eot).toFixed(1) + '" cy="' + y(r.dec).toFixed(1) + '" r="3" fill="var(--amber)"/>' +
      '<text x="' + (x(r.eot) + (r.eot >= 0 ? 6 : -6)).toFixed(1) + '" y="' + (y(r.dec) + 3).toFixed(1) + '" text-anchor="' + (r.eot >= 0 ? 'start' : 'end') + '" class="t">' + _almEsc(_arMonthShort(r.m)) + '</text>';
  }).join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + _arTH('analemma') + '">' +
    '<style>.ax{stroke:var(--border);stroke-width:1}.t{fill:var(--text2);font:10px sans-serif}</style>' +
    '<line x1="' + W / 2 + '" y1="' + pad / 2 + '" x2="' + W / 2 + '" y2="' + (H - pad / 2) + '" class="ax"/>' +
    '<line x1="' + pad / 2 + '" y1="' + H / 2 + '" x2="' + (W - pad / 2) + '" y2="' + H / 2 + '" class="ax"/>' +
    '<path d="' + path + '" fill="none" stroke="var(--text)" stroke-width="1.5"/>' + marks +
    '<text x="' + (W - pad / 2) + '" y="' + (H - 4) + '" text-anchor="end" class="t">\u2192 +' + Math.round(eMax) + ' min</text>' +
    '<text x="' + (W / 2 + 4) + '" y="' + (pad / 2 + 8) + '" class="t">' + Math.round(dMax * 10) / 10 + '°</text></svg>';
}

// ── Calendars ──
var AR_HOLIDAY_COLS = ['easter', 'orthodox', 'passover', 'roshHashanah', 'ramadan', 'eidFitr', 'eidAdha', 'cny', 'nowruz'];
function _arCalDateText(sys, c) {
  var months = _arCalMonths(sys, c.year);
  var name = sys === 'gregorian' || sys === 'julian' ? _arMonthName(c.month) : (months[c.month - 1] || {}).name;
  var yr = sys === 'chinese' ? c.year + ' (' + _chineseZodiac(c.year - 2697).cycle + ')' : String(c.year) + _calYearSuffix(sys);
  return c.day + ' ' + name + ' ' + yr;
}
function _arCalLabel(sys) { return _calLabel(sys); }

// ── What stops being true ──
// Each thing that decays, with its age read from this machine; then what
// holds forever. Ages come from /almanac-ages, which reads files here and
// asks nothing of the internet.
var AR_LAST_LEAP_SECOND = '2016-12-31';
var AR_TAI_MINUS_UTC = 37;
var AR_MEASURED_DELTA_T = { year: 2025, s: 69.1 };   // IERS, Bulletin A, 2025
function _arRenderDecay(body) {
  body.innerHTML = '<p class="alm-ref-busy" role="status">' + _arTH('working') + '</p>';
  var done = function (ages) {
    if (!body.isConnected) return;
    var now = Date.now();
    function age(iso) {
      if (!iso) return _arT('age_unknown');
      var ms = Date.parse(iso);
      if (!isFinite(ms)) return _arT('age_unknown');
      var days = Math.max(0, Math.floor((now - ms) / MS_PER_DAY));
      return _arT('age_days', { date: _arShortDate(ms, 'UTC') + ' ' + new Date(ms).getUTCFullYear(), n: _arNum(days, 0) });
    }
    var yr = new Date().getUTCFullYear();
    var model = _cnDeltaTdays(_dateToJD(now)) * 86400;
    var items = [
      { k: 'tz', age: ages && ages.tz_map ? _arT('tz_age', { map: ages.tz_map, db: ages.tzdata || _arT('age_unknown') }) : _arT('age_unknown') },
      { k: 'sats', age: ages && ages.satellites ? age(ages.satellites.fetched) : _arT('age_unknown') },
      { k: 'deltat', age: _arT('deltat_age', { model: _arNum(model, 1), year: AR_MEASURED_DELTA_T.year, measured: _arNum(AR_MEASURED_DELTA_T.s, 1), now: yr }) },
      { k: 'leap', age: _arT('leap_age', { date: AR_LAST_LEAP_SECOND, n: AR_TAI_MINUS_UTC }) },
      { k: 'catalog', age: ages && ages.catalog && ages.catalog.as_of ? age(ages.catalog.as_of) : _arT('age_unknown') }
    ];
    var holds = ['h_calendars', 'h_sky', 'h_stars', 'h_seasons'];
    body.innerHTML = '<p class="alm-ref-lede">' + _arTH('decay_lede') + '</p>' +
      '<h3>' + _arTH('decays') + '</h3><ul class="alm-ref-list">' + items.map(function (it) {
        return '<li><h4>' + _arTH('d_' + it.k) + '<span class="alm-ref-age">' + _almEsc(it.age) + '</span></h4><p>' + _arTH('d_' + it.k + '_text') + '</p></li>';
      }).join('') + '</ul>' +
      '<h3>' + _arTH('holds') + '</h3><ul class="alm-ref-list alm-ref-holds">' + holds.map(function (k) {
        return '<li><h4>' + _arTH(k + '_title') + '</h4><p>' + _arTH(k + '_text') + '</p></li>';
      }).join('') + '</ul>';
  };
  fetch('/almanac-ages', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
    .then(done, function () { done(null); });
}

