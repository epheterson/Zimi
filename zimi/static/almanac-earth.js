// ── Almanac: the Earth up close ──
// Tap the glow around the Earth in the orrery and the view drops to the
// Earth's own scale: a 3D Earth lit by the real Sun (day, night and the
// terminator where they are), the Moon where it is, lit and shadowed, and the
// ISS and the GPS constellation on their orbits. Eclipses are not special
// cases: the shading asks, for every point on the Earth and the Moon, how much
// of the Sun's disc the other body covers from there, so the Moon's shadow
// crosses the Earth and the Earth's shadow reddens the Moon on their own.
//
// Offline and honest:
//   - The Sun, the Moon, the Earth's turning and the eclipses are pure maths,
//     exact offline for any date (Meeus, "Astronomical Algorithms", 2nd ed.).
//   - Satellites come from orbital elements (CelesTrak's OMM records):
//     a snapshot ships with each release, the server refreshes it when online
//     (/almanac-satellites; ZIMI_OFFLINE turns that off), and SGP4/SDP4
//     (satellite.js, MIT) propagates them. The ISS's place along its orbit
//     drifts once its data is a few days old, so its dot fades and says so.
//     Nothing is drawn that the data does not support.
//
// Loaded with the other almanac modules (they share one global scope); the
// heavy parts (three.js, the textures, the propagator) load only when the
// view is first opened. window.openAlmanacEarth() is the entry point: the
// orrery's Earth glow calls it.
//
// Frames and units: the scene is geocentric, in Earth equatorial radii, on
// the true equator and equinox of date (x toward the equinox, z toward the
// north celestial pole). The Earth turns in it by Greenwich apparent sidereal
// time. The pure functions below take and return plain numbers so the tests
// (tests/test_almanac_earth.cjs) can check them against published values.

// ── Physical constants ──
var AE_EARTH_RADIUS_KM = 6378.137;            // WGS84 equatorial radius
var AE_EARTH_FLATTENING = 1 / 298.257223563;  // WGS84
var AE_EARTH_E2 = AE_EARTH_FLATTENING * (2 - AE_EARTH_FLATTENING); // first eccentricity squared
var AE_MOON_RADIUS_KM = 1737.4;               // IAU mean radius
var AE_SUN_RADIUS_KM = 695700;                // IAU 2015 nominal solar radius
var AE_AU_KM = 149597870.7;                   // IAU 2012 astronomical unit
var AE_C_KM_S = 299792.458;                   // speed of light
var AE_GM_EARTH = 398600.4418;                // km^3/s^2, WGS84 / IERS
// L_G: the rate by which a clock on the geoid (Earth's rotation included)
// runs slow against one far from the Earth, W0/c^2 (IAU 2000 Resolution B1.9).
var AE_L_G = 6.969290134e-10;
var AE_SECONDS_PER_DAY = 86400;
var AE_MICRO = 1e6;
var AE_NANO = 1e9;
var AE_ARCSEC_TO_DEG = 1 / 3600;
var AE_TWO_PI = 2 * Math.PI;
// The Earth's shadow is wider than the solid Earth: the atmosphere blocks
// sunlight too. Chauvenet's rule enlarges it by 1/50 (Meeus ch. 54).
var AE_SHADOW_ENLARGE = 1.02;
// Aberration of the Sun: the constant of aberration over the Sun's distance
// in AU (Meeus 25.10).
var AE_SUN_ABERRATION_ARCSEC = 20.4898;
// Moon mean distance, the constant of Meeus 47 (km).
var AE_MOON_MEAN_DIST_KM = 385000.56;

function _aeDeg(x) { return x * 180 / Math.PI; }
function _aeRad(x) { return x * Math.PI / 180; }
function _aeNormDeg(x) { return ((x % 360) + 360) % 360; }

// Julian Day (UT) of a JS time in ms.
function _aeJulianDayUT(ms) { return JD_UNIX_EPOCH + ms / MS_PER_DAY; }

// TT - UT in days for a UT Julian Day. The Almanac's own Espenak-Meeus fit
// (almanac.js _cnDeltaTdays) when it is loaded, which it always is in the app.
function _aeDeltaTDays(jdUT) {
  return (typeof _cnDeltaTdays === 'function') ? _cnDeltaTdays(jdUT) : 0;
}

// ── Nutation and obliquity (Meeus ch. 22, the 0.5" series) ──
// T in Julian centuries of TT from J2000. Returns degrees.
function _aeNutation(T) {
  var omega = _aeRad(125.04452 - 1934.136261 * T);   // Moon's ascending node
  var Ls = _aeRad(280.4665 + 36000.7698 * T);        // Sun's mean longitude
  var Lm = _aeRad(218.3165 + 481267.8813 * T);       // Moon's mean longitude
  var dpsi = (-17.20 * Math.sin(omega) - 1.32 * Math.sin(2 * Ls) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * omega)) * AE_ARCSEC_TO_DEG;
  var deps = (9.20 * Math.cos(omega) + 0.57 * Math.cos(2 * Ls) + 0.10 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * omega)) * AE_ARCSEC_TO_DEG;
  // Mean obliquity of the ecliptic (Meeus 22.2).
  var eps0 = 23 + 26 / 60 + (21.448 - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) / 3600;
  return { dpsi: dpsi, deps: deps, eps0: eps0, eps: eps0 + deps };
}

// Ecliptic (longitude, latitude, degrees) to equatorial RA/Dec (radians) for
// obliquity eps (degrees). Meeus 13.3 / 13.4.
function _aeEclipticToEquatorial(lonDeg, latDeg, epsDeg) {
  var l = _aeRad(lonDeg), b = _aeRad(latDeg), e = _aeRad(epsDeg);
  var ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  var dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  return { ra: ra, dec: dec };
}

// ── The Sun: the Earth's orbit from VSOP87 (version D), apparent place ──
// Meeus ch. 25's short series is good to ~30" against JPL DE421, which moves
// the Moon's shadow on the Earth by up to ~50 km. These are the largest terms
// of VSOP87D (Bretagnon & Francou 1988, CDS catalogue VI/81, file
// VSOP87D.ear): every term of L above 3e-6 rad, of B above 1e-6 rad, of R
// above 1e-5 AU, the way Meeus's Appendix III truncates it. Measured against
// DE421 over 1950-2050: 2.2" at worst. Each term is [A, B, C]: A cos(B + C tau),
// tau in Julian millennia of TT from J2000; row i is multiplied by tau^i.
var AE_VSOP_L = [
  [[1.75347045673,0,0],[0.03341656456,4.66925680417,6283.0758499914],[0.00034894275,4.62610241759,12566.1516999828],[3.417571e-05,2.82886579606,3.523118349],[3.497056e-05,2.74411800971,5753.3848848968],[3.135896e-05,3.62767041758,77713.7714681205],[2.676218e-05,4.41808351397,7860.4193924392],[2.342687e-05,6.13516237631,3930.2096962196],[1.273166e-05,2.03709655772,529.6909650946],[1.324292e-05,0.74246356352,11506.7697697936],[9.01855e-06,2.04505443513,26.2983197998],[1.199167e-05,1.10962944315,1577.3435424478],[8.57223e-06,3.50849156957,398.1490034082],[7.79786e-06,1.17882652114,5223.6939198022],[9.9025e-06,5.23268129594,5884.9268465832],[7.53141e-06,2.53339053818,5507.5532386674],[5.05264e-06,4.58292563052,18849.2275499742],[4.92379e-06,4.20506639861,775.522611324],[3.56655e-06,2.91954116867,0.0673103028],[3.17087e-06,5.84901952218,11790.6290886588]],
  [[6283.31966747491,0,0],[0.00206058863,2.67823455584,6283.0758499914],[4.30343e-05,2.63512650414,12566.1516999828],[4.25264e-06,1.59046980729,3.523118349]],
  [[0.0005291887,0,0],[8.719837e-05,1.07209665242,6283.0758499914],[3.09125e-06,0.86728818832,12566.1516999828]],
  [[2.89226e-06,5.84384198723,6283.0758499914]],
  [[1.14084e-06,3.14159265359,0]]
];
var AE_VSOP_B = [
  [[2.7962e-06,3.19870156017,84334.66158130829],[1.01643e-06,5.42248619256,5507.5532386674]],
  [[9.03e-08,3.8972906189,5507.5532386674]]
];
var AE_VSOP_R = [
  [[1.00013988799,0,0],[0.01670699626,3.09846350771,6283.0758499914],[0.00013956023,3.0552460962,12566.1516999828],[3.08372e-05,5.19846674381,77713.7714681205],[1.628461e-05,1.17387749012,5753.3848848968],[1.575568e-05,2.84685245825,7860.4193924392]],
  [[0.00103018608,1.10748969588,6283.0758499914],[1.721238e-05,1.06442301418,12566.1516999828]],
  [[4.359385e-05,5.78455133738,6283.0758499914]],
  [[1.44595e-06,4.27319435148,6283.0758499914]]
];
var AE_DAYS_PER_JULIAN_MILLENNIUM = 365250;
// VSOP's dynamical frame to FK5 (Meeus 32.3), arcseconds.
var AE_FK5_DLON_ARCSEC = -0.09033;
var AE_FK5_DLAT_ARCSEC = 0.03916;

function _aeVsopSum(series, tau) {
  var total = 0, tp = 1;
  for (var p = 0; p < series.length; p++) {
    var s = 0, row = series[p];
    for (var i = 0; i < row.length; i++) s += row[i][0] * Math.cos(row[i][1] + row[i][2] * tau);
    total += s * tp;
    tp *= tau;
  }
  return total;
}

// Geocentric apparent place of the Sun at jde (TT): RA/Dec (radians),
// ecliptic longitude (degrees), distance (km).
function _aeSun(jde) {
  var tau = (jde - JD_J2000) / AE_DAYS_PER_JULIAN_MILLENNIUM;
  var T = (jde - JD_J2000) / JULIAN_CENTURY;
  var R = _aeVsopSum(AE_VSOP_R, tau);                              // AU
  // The Sun is where the Earth is not: geocentric = heliocentric + 180 deg.
  var lon = _aeDeg(_aeVsopSum(AE_VSOP_L, tau)) + 180;
  var lat = -_aeDeg(_aeVsopSum(AE_VSOP_B, tau));
  var lp = _aeRad(lon - 1.397 * T - 0.00031 * T * T);
  lon += AE_FK5_DLON_ARCSEC * AE_ARCSEC_TO_DEG;
  lat += AE_FK5_DLAT_ARCSEC * AE_ARCSEC_TO_DEG * (Math.cos(lp) - Math.sin(lp));
  var nut = _aeNutation(T);
  lon += nut.dpsi - AE_SUN_ABERRATION_ARCSEC / R * AE_ARCSEC_TO_DEG;
  var eq = _aeEclipticToEquatorial(lon, lat, nut.eps);
  return { ra: eq.ra, dec: eq.dec, distKm: R * AE_AU_KM, lon: _aeNormDeg(lon), nut: nut };
}

// ── The Moon (Meeus ch. 47, the full tables 47.A and 47.B) ──
// Rows: [D, M, M', F, sum-l coefficient (1e-6 deg), sum-r coefficient (1e-3 km)].
var AE_MOON_LR = [
  [0,0,1,0,6288774,-20905355],[2,0,-1,0,1274027,-3699111],[2,0,0,0,658314,-2955968],
  [0,0,2,0,213618,-569925],[0,1,0,0,-185116,48888],[0,0,0,2,-114332,-3149],
  [2,0,-2,0,58793,246158],[2,-1,-1,0,57066,-152138],[2,0,1,0,53322,-170733],
  [2,-1,0,0,45758,-204586],[0,1,-1,0,-40923,-129620],[1,0,0,0,-34720,108743],
  [0,1,1,0,-30383,104755],[2,0,0,-2,15327,10321],[0,0,1,2,-12528,0],
  [0,0,1,-2,10980,79661],[4,0,-1,0,10675,-34782],[0,0,3,0,10034,-23210],
  [4,0,-2,0,8548,-21636],[2,1,-1,0,-7888,24208],[2,1,0,0,-6766,30824],
  [1,0,-1,0,-5163,-8379],[1,1,0,0,4987,-16675],[2,-1,1,0,4036,-12831],
  [2,0,2,0,3994,-10445],[4,0,0,0,3861,-11650],[2,0,-3,0,3665,14403],
  [0,1,-2,0,-2689,-7003],[2,0,-1,2,-2602,0],[2,-1,-2,0,2390,10056],
  [1,0,1,0,-2348,6322],[2,-2,0,0,2236,-9884],[0,1,2,0,-2120,5751],
  [0,2,0,0,-2069,0],[2,-2,-1,0,2048,-4950],[2,0,1,-2,-1773,4130],
  [2,0,0,2,-1595,0],[4,-1,-1,0,1215,-3958],[0,0,2,2,-1110,0],
  [3,0,-1,0,-892,3258],[2,1,1,0,-810,2616],[4,-1,-2,0,759,-1897],
  [0,2,-1,0,-713,-2117],[2,2,-1,0,-700,2354],[2,1,-2,0,691,0],
  [2,-1,0,-2,596,0],[4,0,1,0,549,-1423],[0,0,4,0,537,-1117],
  [4,-1,0,0,520,-1571],[1,0,-2,0,-487,-1739],[2,1,0,-2,-399,0],
  [0,0,2,-2,-381,-4421],[1,1,1,0,351,0],[3,0,-2,0,-340,0],
  [4,0,-3,0,330,0],[2,-1,2,0,327,0],[0,2,1,0,-323,1165],
  [1,1,-1,0,299,0],[2,0,3,0,294,0],[2,0,-1,-2,0,8752]
];
// Rows: [D, M, M', F, sum-b coefficient (1e-6 deg)].
var AE_MOON_B = [
  [0,0,0,1,5128122],[0,0,1,1,280602],[0,0,1,-1,277693],[2,0,0,-1,173237],
  [2,0,-1,1,55413],[2,0,-1,-1,46271],[2,0,0,1,32573],[0,0,2,1,17198],
  [2,0,1,-1,9266],[0,0,2,-1,8822],[2,-1,0,-1,8216],[2,0,-2,-1,4324],
  [2,0,1,1,4200],[2,1,0,-1,-3359],[2,-1,-1,1,2463],[2,-1,0,1,2211],
  [2,-1,-1,-1,2065],[0,1,-1,-1,-1870],[4,0,-1,-1,1828],[0,1,0,1,-1794],
  [0,0,0,3,-1749],[0,1,-1,1,-1565],[1,0,0,1,-1491],[0,1,1,1,-1475],
  [0,1,1,-1,-1410],[0,1,0,-1,-1344],[1,0,0,-1,-1335],[0,0,3,1,1107],
  [4,0,0,-1,1021],[4,0,-1,1,833],[0,0,1,-3,777],[4,0,-2,1,671],
  [2,0,0,-3,607],[2,0,2,-1,596],[2,-1,1,-1,491],[2,0,-2,1,-451],
  [0,0,3,-1,439],[2,0,2,1,422],[2,0,-3,-1,421],[2,1,-1,1,-366],
  [2,1,0,1,-351],[4,0,0,1,331],[2,-1,1,1,315],[2,-2,0,-1,302],
  [0,0,1,3,-283],[2,1,1,-1,-229],[1,1,0,-1,223],[1,1,0,1,223],
  [0,1,-2,-1,-220],[2,1,-1,-1,-220],[1,0,1,1,-185],[2,-1,-2,-1,181],
  [0,1,2,1,-177],[4,0,-2,-1,176],[4,-1,-1,-1,166],[1,0,1,-1,-164],
  [4,0,1,-1,132],[1,0,-1,-1,-119],[4,-1,0,-1,115],[2,-2,0,1,107]
];
var AE_MOON_COEF_SCALE = 1e-6;   // table units: 1e-6 degree
var AE_MOON_DIST_SCALE = 1e-3;   // table units: 1e-3 km

// Geocentric apparent place of the Moon at jde (TT): RA/Dec (radians),
// ecliptic longitude/latitude (degrees) and distance (km).
function _aeMoon(jde) {
  var T = (jde - JD_J2000) / JULIAN_CENTURY;
  var T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  var Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;   // mean longitude
  var D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000;     // mean elongation
  var M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000;                     // Sun's mean anomaly
  var Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000;       // Moon's mean anomaly
  var F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000;      // argument of latitude
  var A1 = 119.75 + 131.849 * T;      // action of Venus
  var A2 = 53.09 + 479264.290 * T;    // action of Jupiter
  var A3 = 313.45 + 481266.484 * T;   // flattening of the Earth
  var E = 1 - 0.002516 * T - 0.0000074 * T2;   // decreasing eccentricity of the Earth's orbit
  var Dr = _aeRad(D), Mr = _aeRad(M), Mpr = _aeRad(Mp), Fr = _aeRad(F);
  var sl = 0, sr = 0, sb = 0, i, row, arg, ef;
  for (i = 0; i < AE_MOON_LR.length; i++) {
    row = AE_MOON_LR[i];
    arg = row[0] * Dr + row[1] * Mr + row[2] * Mpr + row[3] * Fr;
    ef = Math.abs(row[1]) === 1 ? E : (Math.abs(row[1]) === 2 ? E * E : 1);
    sl += row[4] * ef * Math.sin(arg);
    sr += row[5] * ef * Math.cos(arg);
  }
  for (i = 0; i < AE_MOON_B.length; i++) {
    row = AE_MOON_B[i];
    arg = row[0] * Dr + row[1] * Mr + row[2] * Mpr + row[3] * Fr;
    ef = Math.abs(row[1]) === 1 ? E : (Math.abs(row[1]) === 2 ? E * E : 1);
    sb += row[4] * ef * Math.sin(arg);
  }
  sl += 3958 * Math.sin(_aeRad(A1)) + 1962 * Math.sin(_aeRad(Lp - F)) + 318 * Math.sin(_aeRad(A2));
  sb += -2235 * Math.sin(_aeRad(Lp)) + 382 * Math.sin(_aeRad(A3)) + 175 * Math.sin(_aeRad(A1 - F)) +
        175 * Math.sin(_aeRad(A1 + F)) + 127 * Math.sin(_aeRad(Lp - Mp)) - 115 * Math.sin(_aeRad(Lp + Mp));
  var nut = _aeNutation(T);
  var lon = _aeNormDeg(Lp + sl * AE_MOON_COEF_SCALE + nut.dpsi);
  var lat = sb * AE_MOON_COEF_SCALE;
  var eq = _aeEclipticToEquatorial(lon, lat, nut.eps);
  return { ra: eq.ra, dec: eq.dec, lon: lon, lat: lat, distKm: AE_MOON_MEAN_DIST_KM + sr * AE_MOON_DIST_SCALE };
}

// ── The Earth's turning (Meeus 12.4, and 12 for apparent time) ──
// Greenwich apparent sidereal time, radians, for a UT Julian Day. Nutation
// (the equation of the equinoxes) puts it on the same true equinox the Sun
// and Moon above are referred to.
function _aeGast(jdUT, nut) {
  var T = (jdUT - JD_J2000) / JULIAN_CENTURY;
  var gmst = 280.46061837 + 360.98564736629 * (jdUT - JD_J2000) + 0.000387933 * T * T - T * T * T / 38710000;
  return _aeRad(_aeNormDeg(gmst + nut.dpsi * Math.cos(_aeRad(nut.eps))));
}

// Unit vector (or scaled by r) from RA/Dec in radians.
function _aeEqVec(ra, dec, r) {
  var c = Math.cos(dec);
  return [r * c * Math.cos(ra), r * c * Math.sin(ra), r * Math.sin(dec)];
}

// Everything the view draws for one instant, in scene units (Earth radii).
// ms is a JS time (UTC).
function _aeSceneAt(ms) {
  var jd = _aeJulianDayUT(ms);
  var jde = jd + _aeDeltaTDays(jd);
  var sun = _aeSun(jde), moon = _aeMoon(jde);
  return {
    ms: ms, jd: jd, jde: jde,
    sun: _aeEqVec(sun.ra, sun.dec, sun.distKm / AE_EARTH_RADIUS_KM),
    moon: _aeEqVec(moon.ra, moon.dec, moon.distKm / AE_EARTH_RADIUS_KM),
    sunEq: sun, moonEq: moon,
    gast: _aeGast(jd, sun.nut)
  };
}

// ── Small vector helpers ──
function _aeDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _aeSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _aeLen(a) { return Math.sqrt(_aeDot(a, a)); }
function _aeScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function _aeNorm(a) { return _aeScale(a, 1 / _aeLen(a)); }
function _aeCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
// Angle between two directions, stable for tiny angles (atan2 of the cross and
// dot products; acos loses everything below ~1e-4 rad in float arithmetic).
function _aeAngle(a, b) { return Math.atan2(_aeLen(_aeCross(a, b)), _aeDot(a, b)); }
// Rotate about the z axis.
function _aeRotZ(v, ang) {
  var c = Math.cos(ang), s = Math.sin(ang);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

// ── Geodesy (WGS84): Earth-fixed position <-> latitude and longitude ──
// Earth-fixed position (Earth radii) of a surface point, geodetic degrees.
function _aeGeodeticToFixed(latDeg, lonDeg) {
  var la = _aeRad(latDeg), lo = _aeRad(lonDeg);
  var N = 1 / Math.sqrt(1 - AE_EARTH_E2 * Math.sin(la) * Math.sin(la));
  return [N * Math.cos(la) * Math.cos(lo), N * Math.cos(la) * Math.sin(lo), N * (1 - AE_EARTH_E2) * Math.sin(la)];
}
// Geodetic latitude/longitude (degrees) of a point on the ellipsoid surface.
function _aeFixedToGeodetic(p) {
  var lon = _aeDeg(Math.atan2(p[1], p[0]));
  var lat = _aeDeg(Math.atan2(p[2], (1 - AE_EARTH_E2) * Math.sqrt(p[0] * p[0] + p[1] * p[1])));
  return { lat: lat, lon: lon };
}
// Scene position -> Earth-fixed, and back, for an instant's sidereal angle.
function _aeSceneToFixed(v, gast) { return _aeRotZ(v, -gast); }
function _aeFixedToScene(v, gast) { return _aeRotZ(v, gast); }

// Where a ray first meets the ellipsoid, or null. Scaling z by 1/(1-f) turns
// the ellipsoid into the unit sphere.
function _aeRayEllipsoid(origin, dir) {
  var k = 1 / (1 - AE_EARTH_FLATTENING);
  var o = [origin[0], origin[1], origin[2] * k], d = [dir[0], dir[1], dir[2] * k];
  var a = _aeDot(d, d), b = 2 * _aeDot(o, d), c = _aeDot(o, o) - 1;
  var disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  var t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
}

// The point on the Earth with the Sun overhead: latitude = the Sun's
// declination, longitude from the Earth's turning.
function _aeSubsolarPoint(scene) {
  return _aeFixedToGeodeticDirection(_aeSceneToFixed(scene.sun, scene.gast));
}
// Latitude/longitude of the surface point straight below a direction (the
// geodetic point whose normal points along it).
function _aeFixedToGeodeticDirection(v) {
  var n = _aeNorm(v);
  return { lat: _aeDeg(Math.asin(n[2])), lon: _aeDeg(Math.atan2(n[1], n[0])) };
}

// ── Eclipses: how much of the Sun's disc a body covers ──
// Fraction of a disc of angular radius r1 covered by a disc of radius r2
// whose centre is d away (all in the same angular unit). Flat-disc geometry,
// fine at half a degree; the Sun's limb darkening is ignored. The GLSL twin
// in the view's shaders (AE_GLSL_OVERLAP) is this same formula.
function _aeDiscOverlap(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1);
  var a1 = r1 * r1 * Math.acos(Math.max(-1, Math.min(1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1))));
  var a2 = r2 * r2 * Math.acos(Math.max(-1, Math.min(1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))));
  var tri = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return (a1 + a2 - tri) / (Math.PI * r1 * r1);
}

// Fraction of the Sun's light reaching `point` (scene units) with a body of
// radius `occR` at `occ` in the way. 1 = full sunlight, 0 = inside the umbra.
function _aeSunlightAt(point, sun, occ, occR) {
  var toSun = _aeSub(sun, point), toOcc = _aeSub(occ, point);
  var dSun = _aeLen(toSun), dOcc = _aeLen(toOcc);
  var rSun = Math.asin(Math.min(1, AE_SUN_RADIUS_KM / AE_EARTH_RADIUS_KM / dSun));
  var rOcc = Math.asin(Math.min(1, occR / dOcc));
  if (_aeDot(toSun, toOcc) <= 0) return 1;   // the body is behind the point
  return 1 - _aeDiscOverlap(rSun, rOcc, _aeAngle(toSun, toOcc));
}

var AE_MOON_RADIUS_RE = AE_MOON_RADIUS_KM / AE_EARTH_RADIUS_KM;
var AE_SUN_RADIUS_RE = AE_SUN_RADIUS_KM / AE_EARTH_RADIUS_KM;

// The Moon's shadow on the Earth. gamma: the shadow axis's least distance
// from the Earth's centre in Earth radii (Besselian gamma, signed north
// positive); hit: where the axis meets the ground (geodetic), or null when it
// passes the Earth by. umbra: the axis carries the umbra (total) rather than
// the antumbra (annular) at the Earth.
function _aeSolarShadow(scene) {
  var axis = _aeNorm(_aeSub(scene.moon, scene.sun));       // Sun -> Moon, the shadow's way
  var along = _aeDot(_aeScale(scene.moon, -1), axis);     // Earth centre's distance down the axis
  var closest = [scene.moon[0] + axis[0] * along, scene.moon[1] + axis[1] * along, scene.moon[2] + axis[2] * along];
  var gamma = _aeLen(closest) * (closest[2] >= 0 ? 1 : -1);
  var hitScene = _aeRayEllipsoid(scene.moon, axis);
  var hit = hitScene ? _aeFixedToGeodetic(_aeSceneToFixed(hitScene, scene.gast)) : null;
  // Umbra length: the cone of the Sun's and Moon's radii converges this far
  // behind the Moon (similar triangles).
  var sunMoon = _aeLen(_aeSub(scene.moon, scene.sun));
  var umbraLen = sunMoon * AE_MOON_RADIUS_RE / (AE_SUN_RADIUS_RE - AE_MOON_RADIUS_RE);
  var toGround = hitScene ? _aeLen(_aeSub(hitScene, scene.moon)) : along;
  return { gamma: gamma, hit: hit, umbra: toGround < umbraLen, axis: axis };
}

// The Earth's shadow on the Moon, in the classical geocentric angles (Meeus
// ch. 54, Chauvenet's 1/50 enlargement). gamma: the Moon centre's distance
// from the shadow axis in Earth radii; magnitudes: the fraction of the Moon's
// diameter inside the umbra and the penumbra (negative = clear of it).
function _aeLunarShadow(scene) {
  var dMoon = _aeLen(scene.moon), dSun = _aeLen(scene.sun);
  var piMoon = Math.asin(1 / dMoon);                    // Moon's horizontal parallax
  var piSun = Math.asin(1 / dSun);                      // Sun's horizontal parallax
  var sSun = Math.asin(AE_SUN_RADIUS_RE / dSun);        // Sun's semi-diameter
  var sMoon = Math.asin(AE_MOON_RADIUS_RE / dMoon);     // Moon's semi-diameter
  var umbraR = AE_SHADOW_ENLARGE * (piMoon + piSun - sSun);
  var penumbraR = AE_SHADOW_ENLARGE * (piMoon + piSun + sSun);
  var anti = _aeScale(_aeNorm(scene.sun), -1);
  var sep = _aeAngle(anti, scene.moon);                 // Moon centre from the shadow axis
  var axisDist = dMoon * Math.sin(sep);
  var north = _aeDot(_aeSub(_aeNorm(scene.moon), anti), [0, 0, 1]) >= 0 ? 1 : -1;
  return {
    gamma: axisDist * north,
    umbralMag: (umbraR + sMoon - sep) / (2 * sMoon),
    penumbralMag: (penumbraR + sMoon - sep) / (2 * sMoon),
    umbraR: umbraR, penumbraR: penumbraR, sMoon: sMoon, sep: sep
  };
}

// The instant (ms) near `ms` where f(ms) is least, by golden-section search
// over +/- spanMs. f must be unimodal there (an eclipse's axis distance is).
var AE_GOLDEN = (Math.sqrt(5) - 1) / 2;
var AE_MIN_SEARCH_TOL_MS = 1000;
function _aeMinimize(f, ms, spanMs) {
  var a = ms - spanMs, b = ms + spanMs;
  var c = b - AE_GOLDEN * (b - a), d = a + AE_GOLDEN * (b - a);
  var fc = f(c), fd = f(d);
  while (b - a > AE_MIN_SEARCH_TOL_MS) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - AE_GOLDEN * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + AE_GOLDEN * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

// Greatest eclipse near `ms`: the instant the shadow axis passes closest to
// the Earth's centre (solar) or the Moon's centre is closest to the Earth's
// shadow axis (lunar). Search +/- a day and a half, enough to cover the
// local-date slack of the Almanac's eclipse list.
var AE_ECLIPSE_SEARCH_MS = 1.5 * MS_PER_DAY;
function _aeGreatestEclipse(ms, solar) {
  var f = solar
    ? function (t) { return Math.abs(_aeSolarShadow(_aeSceneAt(t)).gamma); }
    : function (t) { return Math.abs(_aeLunarShadow(_aeSceneAt(t)).gamma); };
  // Coarse hourly scan first, then the golden section inside the best hour:
  // the guess can sit a day off the eclipse, and over three days the distance
  // need not fall steadily toward it from both ends.
  var best = ms, bestV = Infinity, step = MS_PER_DAY / 24;
  for (var t = ms - AE_ECLIPSE_SEARCH_MS; t <= ms + AE_ECLIPSE_SEARCH_MS; t += step) {
    var v = f(t);
    if (v < bestV) { bestV = v; best = t; }
  }
  return _aeMinimize(f, best, step);
}

// ── Satellites: the GPS clock's relativity ──
// A GPS satellite's clock against a clock on the ground, as fractional
// rates: gravity is weaker up there, so it runs fast by (W0 - GM/r)/c^2; it
// moves, so it runs slow by v^2/(2 c^2). r in km, v in km/s (inertial).
function _aeGpsClockRates(rKm, vKmS) {
  var c2 = AE_C_KM_S * AE_C_KM_S;
  var grav = AE_L_G - AE_GM_EARTH / (rKm * c2);
  var speed = -(vKmS * vKmS) / (2 * c2);
  return { grav: grav, speed: speed, net: grav + speed };
}
// Microseconds a day for a fractional rate, and the ranging error it becomes
// in a day if ignored (the clock error times the speed of light), km.
function _aeMicrosPerDay(rate) { return rate * AE_SECONDS_PER_DAY * AE_MICRO; }
function _aeKmPerDay(rate) { return rate * AE_SECONDS_PER_DAY * AE_C_KM_S; }

// ── Satellites: what the data supports ──
// Elements are drawn only near the instant they describe. GPS orbits hold
// their shape for months at this scale; the ISS's orbit (height, tilt, lap)
// does too, but drag and reboosts move its place along the orbit within
// days, so past AE_ISS_EXACT_DAYS its dot fades and is labelled approximate.
var AE_SAT_WINDOW_DAYS = 180;
var AE_ISS_EXACT_DAYS = 3;
var AE_MINUTES_PER_DAY = 1440;
var AE_MS_PER_MINUTE = 60000;
var AE_ISS_NORAD_ID = 25544;

// JS time of an element set's epoch, from satellite.js's Julian date.
function _aeSatEpochMs(satrec) { return (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY; }

// 'exact', 'approximate' or 'none' for an element set this many days from
// the displayed instant (either direction).
function _aeSatStanding(ageDays, isIss) {
  var a = Math.abs(ageDays);
  if (a > AE_SAT_WINDOW_DAYS) return 'none';
  if (isIss && a > AE_ISS_EXACT_DAYS) return 'approximate';
  return 'exact';
}

// SGP4 answers in TEME (true equator, mean equinox); the scene is on the
// true equinox, a turn of the equation of the equinoxes away. km -> Earth radii.
function _aeTemeToScene(pKm, eqeq) {
  return _aeScale(_aeRotZ([pKm.x, pKm.y, pKm.z], eqeq), 1 / AE_EARTH_RADIUS_KM);
}
// The equation of the equinoxes (radians) for a scene.
function _aeEqEq(scene) {
  return _aeRad(scene.sunEq.nut.dpsi * Math.cos(_aeRad(scene.sunEq.nut.eps)));
}

// ── The next eclipse after an instant ──
// Which eclipses happen comes from the Almanac's own list (almanac.js
// _computeEclipses, Meeus ch. 54, with its NASA-checked filters); the instant
// of greatest eclipse is refined here from the same geometry the view draws.
var AE_ECLIPSE_MIN_AHEAD_MS = 60 * 60 * 1000;
var AE_ECLIPSE_CANDIDATES = 3;
var AE_NOON_HOUR = 12;
function _aeNextEclipse(ms) {
  if (typeof _computeEclipses !== 'function') return null;
  var list = _computeEclipses(new Date(ms - MS_PER_DAY), AE_ECLIPSE_CANDIDATES);
  for (var i = 0; i < list.length; i++) {
    var m = /^(-?\d+)-(\d+)-(\d+)$/.exec(list[i].date);
    if (!m) continue;
    var guess = new Date(0);
    guess.setFullYear(+m[1], +m[2] - 1, +m[3]);
    guess.setHours(AE_NOON_HOUR, 0, 0, 0);
    var at = _aeGreatestEclipse(guess.getTime(), list[i].solar);
    if (at > ms + AE_ECLIPSE_MIN_AHEAD_MS) return { ms: at, solar: list[i].solar, type: list[i].type };
  }
  return null;
}

// What is being eclipsed right now, for the status line: a solar eclipse
// while the Moon's penumbra touches the Earth, a lunar one while the Moon is
// in the Earth's penumbra. The penumbra's half-width at the Earth: the cone
// through the Sun's and Moon's limbs, crossed, widening past the Moon.
function _aeEclipseNow(scene) {
  var facing = _aeDot(scene.moon, scene.sun) > 0;
  if (facing) {
    var sol = _aeSolarShadow(scene);
    var sunMoon = _aeLen(_aeSub(scene.moon, scene.sun));
    var penHalf = AE_MOON_RADIUS_RE + (AE_SUN_RADIUS_RE + AE_MOON_RADIUS_RE) * _aeLen(scene.moon) / sunMoon;
    if (Math.abs(sol.gamma) < 1 + penHalf) return { solar: true, central: !!sol.hit, total: sol.umbra, hit: sol.hit };
    return null;
  }
  var lun = _aeLunarShadow(scene);
  if (lun.penumbralMag > 0) return { solar: false, total: lun.umbralMag >= 1, partial: lun.umbralMag > 0, umbralMag: lun.umbralMag };
  return null;
}
