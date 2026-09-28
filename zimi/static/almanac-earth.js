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

// ═══════════════════════════════════════════════════════════════════════
// The view
// ═══════════════════════════════════════════════════════════════════════

// Assets. Static files are served immutable for a year, so each name carries
// its version: replacing one means a new name here, never new bytes under
// the old one.
var AE_THREE_URL = '/static/earth/three-r186.min.js';
var AE_SGP4_URL = '/static/earth/satellite-7.1.0.min.js';
var AE_TEX_DAY = '/static/earth/earth-day-v1.webp';
var AE_TEX_NIGHT = '/static/earth/earth-night-v1.webp';
var AE_TEX_MOON = '/static/earth/moon-v1.webp';
var AE_SATS_URL = '/almanac-satellites';

// Camera.
var AE_FOV_DEG = 35;
var AE_NEAR_FRACTION = 0.05;          // near plane, as a share of the distance to the nearest surface
var AE_NEAR_MIN = 1e-4;
var AE_FAR = 6000;                    // Earth radii: past the Moon at the widest zoom
var AE_STAR_RADIUS = 5000;            // the star sphere, carried with the camera
var AE_MIN_DIST_EARTH = 1.12;         // closest approach, from the Earth's centre (~770 km up)
var AE_MIN_DIST_MOON = AE_MOON_RADIUS_RE * 1.25;
var AE_MAX_DIST = 420;                // wide enough to hold the Moon's whole orbit
var AE_MAX_ELEVATION = _aeRad(85);    // north stays up; never flip over a pole
var AE_START_MAX_LAT = _aeRad(50);    // the opening view leans no further toward a pole
var AE_DRAG_RAD_PER_PX = 0.006;
var AE_DRAG_MIN_SCALE = 0.15;         // up close a drag turns the globe more gently
var AE_WHEEL_ZOOM = 0.0015;           // log-distance per wheel unit
var AE_KEY_TURN = _aeRad(5);
var AE_KEY_ZOOM = 1.15;
var AE_FLY_MS = 900;
var AE_FLY_START_DIST = 40;           // the zoom in from the orrery starts this far out
var AE_TAP_SLOP_PX = 6;               // a pointer that moved less than this was a tap
var AE_TAP_RADIUS_PX = 22;            // how near a tap must land to pick something
var AE_LABEL_DX = 8;                  // labels sit this far right of their point (CSS px)
// Presets: the radius (Earth radii) each view must hold, and how full.
var AE_FIT_EARTH = 1.12;              // the Earth and the ISS's orbit
var AE_FIT_SATS = 4.35;               // the GPS shell (AE_GPS_SHELL_RE) and a margin
var AE_FIT_MOON = AE_MOON_RADIUS_RE * 1.35;
var AE_FIT_FILL = 0.92;

// Rendering.
var AE_MAX_DPR = 2;                   // a 3x phone fills 2.25x the pixels for little gain
var AE_EARTH_SEGMENTS = [128, 64];
var AE_ATMO_SEGMENTS = [96, 48];
var AE_MOON_SEGMENTS = [64, 32];
var AE_ATMOSPHERE_SCALE = 1.018;      // the glow's shell, ~115 km above the surface
var AE_ANISOTROPY = 8;
var AE_IDLE_RENDER_MS = 250;          // at real-time speed nothing moves faster than this shows
var AE_TEXT_TICK_MS = 100;            // readouts and the GPS counter
var AE_STATS_WINDOW = 120;            // frames kept for the frame-rate readout
var AE_SAT_CAPACITY = 80;
var AE_GPS_RING_POINTS = 72;
var AE_ISS_RING_POINTS = 96;
var AE_RING_REFRESH_MS = 6 * 3600 * 1000;   // GPS orbits barely turn in six hours
var AE_ISS_RING_REFRESH_MS = 60 * 1000;
var AE_MOON_PATH_HALF_DAYS = 13.66;   // half a sidereal month either side
var AE_MOON_PATH_STEP_HOURS = 6;
var AE_MOON_PATH_REFRESH_MS = MS_PER_DAY;
var AE_SAT_POINT_PX = 4;
var AE_SAT_SELECTED_PX = 9;
var AE_ISS_POINT_PX = 6;
var AE_ISS_FADED_ALPHA = 0.45;
var AE_SUN_POINT_PX = 30;
var AE_HINT_MS = 4500;
var AE_SPEEDS = [1, 60, 3600];        // real time, a minute a second, an hour a second
var AE_SPEED_KEYS = ['alm_earth_rate_real', 'alm_earth_rate_min', 'alm_earth_rate_hour'];
var AE_GPS_COLOR = [0.55, 0.85, 1.0];
var AE_ISS_COLOR = [1.0, 0.82, 0.35];
var AE_SELECTED_COLOR = [1.0, 0.62, 0.04];
var AE_SUN_COLOR = [1.0, 0.93, 0.78];
var AE_GPS_RING_COLOR = 0x6fb8ff, AE_GPS_RING_ALPHA = 0.2;
var AE_GPS_SHELL_RE = 4.16;           // GPS orbit radius, 26,560 km, in Earth radii
// Orbits fade in between the view holding half of one and nearly all of it.
var AE_ORBIT_FADE_FROM = 0.5, AE_ORBIT_FADE_TO = 0.85;
var AE_ISS_RING_COLOR = 0xffc861, AE_ISS_RING_ALPHA = 0.5, AE_ISS_RING_FADED = 0.25;
var AE_MOON_PATH_COLOR = 0xffffff, AE_MOON_PATH_ALPHA = 0.16;
// Star dots from magnitude (brighter = bigger, more opaque) and colour index.
var AE_STAR_SIZE0 = 3.4, AE_STAR_SIZE_PER_MAG = 0.55, AE_STAR_SIZE_MIN = 1.2;
var AE_STAR_ALPHA0 = 1.05, AE_STAR_ALPHA_PER_MAG = 0.16, AE_STAR_ALPHA_MIN = 0.3;
var AE_HOURS_TO_RAD = Math.PI / 12;

var _ae = null;          // view state, built on first open
var _aeIsOpen = false;

function _aeLang() { return (typeof _currentLang !== 'undefined' && _currentLang) ? _currentLang : undefined; }
function _aeT(key, vars) { return (typeof t === 'function') ? t(key, vars) : key; }
function _aeEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _aeReduceMotion() { return (typeof _almReduceMotion === 'function') ? _almReduceMotion() : false; }
function _aeLink(key, html) { return window.AlmanacLinks ? window.AlmanacLinks.wrap(key, html) : html; }
function _aeLinked(key) { return !!(window.AlmanacLinks && window.AlmanacLinks.linkFor(key)); }
function _aeClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function _aeEaseOut(p) { return 1 - Math.pow(1 - p, 3); }
function _aeFmtLatLon(p) {
  var ns = p.lat >= 0 ? 'N' : 'S', ew = p.lon >= 0 ? 'E' : 'W';
  return _aeNum(Math.abs(p.lat), 1) + '° ' + ns + ', ' + _aeNum(Math.abs(p.lon), 1) + '° ' + ew;
}
// Intl formatters are built once per language and shape: the readouts run
// ten times a second, and building one costs about a millisecond on a phone.
var _aeFmtCache = {};
function _aeFormatter(kind, opts, ctor) {
  var key = kind + '|' + (_aeLang() || '');
  if (!_aeFmtCache[key]) {
    try { _aeFmtCache[key] = new ctor(_aeLang(), opts); }
    catch (e) { _aeFmtCache[key] = new ctor(undefined, opts); }
  }
  return _aeFmtCache[key];
}
function _aeNum(n, digits) {
  return _aeFormatter('n' + digits, { minimumFractionDigits: digits, maximumFractionDigits: digits }, Intl.NumberFormat).format(n);
}
var AE_DATE_OPTS = { day: 'numeric', month: 'short', year: 'numeric' };
var AE_WHEN_OPTS = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
function _aeFmtDate(ms) { return _aeFormatter('d', AE_DATE_OPTS, Intl.DateTimeFormat).format(new Date(ms)); }
function _aeFmtWhen(ms) {
  var d = new Date(ms);
  // A year before 1 needs the era spelled out (almanac.js _almEraOpts).
  if (d.getFullYear() <= 0 && typeof _almEraOpts === 'function') {
    return _aeFormatter('we', _almEraOpts(d, AE_WHEN_OPTS), Intl.DateTimeFormat).format(d);
  }
  return _aeFormatter('w', AE_WHEN_OPTS, Intl.DateTimeFormat).format(d);
}
function _aeById(id) { return document.getElementById(id); }

// The styles live with the view (injected on first open), so a device that
// never opens it never parses them.
var AE_CSS = [
  '.ae-view{position:absolute;inset:0;z-index:40;background:#000;display:none;overflow:hidden;color:var(--text);touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',
  '.ae-view.open{display:block}',
  '.ae-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;outline:none}',
  '.ae-canvas.ae-dragging{cursor:grabbing}',
  '.ae-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 16px 28px;background:linear-gradient(rgba(0,0,0,.6),transparent);pointer-events:none}',
  '.ae-top>*{pointer-events:auto}',
  '.ae-btn{font:inherit;font-size:13px;line-height:1;padding:8px 12px;min-height:34px;border-radius:999px;border:1px solid var(--border);background:rgba(18,18,20,.82);color:var(--text2);cursor:pointer;white-space:nowrap}',
  '.ae-btn:hover,.ae-btn:focus-visible{color:var(--amber);border-color:var(--amber-border);background:var(--amber-glow);outline:none}',
  '.ae-btn[aria-pressed="true"]{color:var(--amber);border-color:var(--amber-border);background:rgba(245,158,11,.14)}',
  '.ae-btn[hidden]{display:none}',
  '.ae-back{color:var(--text);flex:0 0 auto}',
  '[dir="rtl"] .ae-chev{display:inline-block;transform:scaleX(-1)}',
  '.ae-when{text-align:end;font-size:11px;color:var(--text2);font-variant-numeric:tabular-nums;line-height:1.35;min-width:0}',
  '.ae-when b{display:block;font-size:13px;color:var(--text);font-weight:600}',
  '.ae-live{color:#6ec56e}',
  '.ae-status{position:absolute;left:16px;right:16px;top:66px;text-align:center;font-size:13px;line-height:1.4;color:#f5c16c;pointer-events:none;text-shadow:0 1px 3px #000}',
  '.ae-bottom{position:absolute;left:0;right:0;bottom:0;padding:28px 16px calc(12px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;align-items:center;background:linear-gradient(transparent,rgba(0,0,0,.72));pointer-events:none}',
  '.ae-row{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;pointer-events:auto}',
  '.ae-note{font-size:10.5px;line-height:1.4;color:var(--text3);text-align:center;pointer-events:auto;max-width:560px}',
  '.ae-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}',
  '.ae-label{position:absolute;left:0;top:0;font-size:11px;color:#dfe6f0;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 4px #000}',
  '.ae-label[hidden]{display:none}',
  '.ae-label.ae-faded{opacity:.62}',
  '.ae-label-sub{display:block;font-size:10px;color:var(--text2)}',
  '.ae-label-you{color:#f5c16c}',
  '.ae-label-shadow{color:#ffb4a0}',
  '.ae-card{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(118px + env(safe-area-inset-bottom));width:min(420px,calc(100% - 32px));box-sizing:border-box;background:rgba(14,14,16,.94);border:1px solid var(--border);border-radius:12px;padding:12px 40px 12px 14px;font-size:13px;line-height:1.5;color:var(--text2)}',
  '.ae-card[hidden]{display:none}',
  '.ae-card h3{margin:0 0 4px;font-size:14px;font-weight:600;color:var(--text)}',
  '.ae-card p{margin:0}',
  '.ae-card p+p{margin-top:6px}',
  '.ae-counter{color:var(--amber);font-variant-numeric:tabular-nums}',
  '.ae-card-x{position:absolute;top:4px;right:4px;width:36px;height:36px;border:0;background:none;color:var(--text3);font-size:20px;line-height:1;cursor:pointer;border-radius:8px}',
  '.ae-card-x:hover,.ae-card-x:focus-visible{color:var(--amber);outline:none}',
  '[dir="rtl"] .ae-card{padding:12px 14px 12px 40px}',
  '[dir="rtl"] .ae-card-x{right:auto;left:4px}',
  '.ae-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--text2);font-size:14px;pointer-events:none}',
  '.ae-msg[hidden]{display:none}',
  '.ae-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:8px 14px;border-radius:999px;background:rgba(0,0,0,.6);color:var(--text2);font-size:12px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .6s}',
  '.ae-hint.ae-show{opacity:1}',
  '@media (prefers-reduced-motion: reduce){.ae-hint{transition:none}}',
  '@media (max-width:420px){.ae-btn{font-size:12px;padding:7px 10px;min-height:32px}.ae-status{top:60px;font-size:12px}}'
].join('\n');

function _aeEnsureStyles() {
  if (_aeById('ae-style')) return;
  var st = document.createElement('style');
  st.id = 'ae-style';
  st.textContent = AE_CSS;
  document.head.appendChild(st);
}

function _aeBuildDom() {
  var host = _aeById('almanac-view');
  if (!host) return null;
  var el = document.createElement('div');
  el.className = 'ae-view';
  el.id = 'ae-view';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', _tp('Earth'));
  var speeds = AE_SPEEDS.map(function (s, i) {
    return '<button type="button" class="ae-btn" data-ae-speed="' + s + '" aria-pressed="' + (i === 0) + '">' +
      _aeEsc(_aeT(AE_SPEED_KEYS[i])) + '</button>';
  }).join('');
  el.innerHTML =
    '<canvas class="ae-canvas" id="ae-canvas" tabindex="0" role="img"></canvas>' +
    '<div class="ae-labels" id="ae-labels">' +
      '<span class="ae-label" id="ae-lbl-moon" hidden>' + _aeEsc(_aeT('alm_moon')) + '</span>' +
      '<span class="ae-label" id="ae-lbl-iss" hidden></span>' +
      '<span class="ae-label ae-label-you" id="ae-lbl-you" hidden>● ' + _aeEsc(_aeT('alm_earth_you')) + '</span>' +
      '<span class="ae-label ae-label-shadow" id="ae-lbl-shadow" hidden>◉ ' + _aeEsc(_aeT('alm_earth_shadow')) + '</span>' +
    '</div>' +
    '<div class="ae-msg" id="ae-msg"></div>' +
    '<div class="ae-hint" id="ae-hint">' + _aeEsc(_aeT('alm_earth_hint')) + '</div>' +
    '<div class="ae-top">' +
      '<button type="button" class="ae-btn ae-back" id="ae-back"><span class="ae-chev" aria-hidden="true">‹</span> ' + _aeEsc(_aeT('alm_solar_system')) + '</button>' +
      '<div class="ae-when" id="ae-when"></div>' +
    '</div>' +
    '<div class="ae-status" id="ae-status" aria-live="polite"></div>' +
    '<div class="ae-card" id="ae-card" hidden></div>' +
    '<div class="ae-bottom">' +
      '<div class="ae-row" role="group" id="ae-views">' +
        '<button type="button" class="ae-btn" data-ae-view="earth" aria-pressed="true">' + _aeEsc(_tp('Earth')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="sats" aria-pressed="false">' + _aeEsc(_aeT('alm_earth_view_sats')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="moon" aria-pressed="false">' + _aeEsc(_aeT('alm_moon')) + '</button>' +
      '</div>' +
      '<div class="ae-row" role="group" id="ae-time">' + speeds +
        '<button type="button" class="ae-btn" id="ae-eclipse">' + _aeEsc(_aeT('alm_earth_next_eclipse')) + '</button>' +
        '<button type="button" class="ae-btn" id="ae-now" hidden>' + _aeEsc(_aeT('alm_now')) + '</button>' +
      '</div>' +
      '<div class="ae-note" id="ae-note"></div>' +
    '</div>';
  host.appendChild(el);
  return el;
}

// ── Loading: three.js as a module, the propagator as a classic script ──
var _aeThreePromise = null;
function _aeLoadThree() {
  if (!_aeThreePromise) {
    _aeThreePromise = import(AE_THREE_URL);
    _aeThreePromise.catch(function () { _aeThreePromise = null; });
  }
  return _aeThreePromise;
}
var _aeSgp4Promise = null;
function _aeLoadSgp4() {
  if (window.SatelliteJS) return Promise.resolve(window.SatelliteJS);
  if (!_aeSgp4Promise) {
    _aeSgp4Promise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = AE_SGP4_URL;
      s.onload = function () { if (window.SatelliteJS) resolve(window.SatelliteJS); else reject(new Error('sgp4')); };
      s.onerror = function () { _aeSgp4Promise = null; reject(new Error('sgp4')); };
      document.head.appendChild(s);
    });
  }
  return _aeSgp4Promise;
}
function _aeLoadTexture(THREE, url) {
  return new Promise(function (resolve, reject) {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

// ── Shaders ──
// The disc-overlap formula: the GLSL twin of _aeDiscOverlap / _aeSunlightAt.
var AE_GLSL_OVERLAP = [
  'float aeOverlap(float r1, float r2, float d) {',
  '  if (d >= r1 + r2) return 0.0;',
  '  if (d <= abs(r1 - r2)) return r2 >= r1 ? 1.0 : (r2 * r2) / (r1 * r1);',
  '  float a1 = r1 * r1 * acos(clamp((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1), -1.0, 1.0));',
  '  float a2 = r2 * r2 * acos(clamp((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2), -1.0, 1.0));',
  '  float tri = 0.5 * sqrt(max(0.0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));',
  '  return (a1 + a2 - tri) / (3.14159265 * r1 * r1);',
  '}',
  'float aeSunlight(vec3 p, vec3 sunPos, float sunR, vec3 occ, float occR) {',
  '  vec3 toSun = sunPos - p; vec3 toOcc = occ - p;',
  '  if (dot(toSun, toOcc) <= 0.0) return 1.0;',
  '  float dS = length(toSun), dO = length(toOcc);',
  '  vec3 s = toSun / dS, o = toOcc / dO;',
  '  float rs = asin(min(1.0, sunR / dS));',
  '  float ro = asin(min(1.0, occR / dO));',
  '  float d = atan(length(cross(s, o)), dot(s, o));',
  '  return 1.0 - aeOverlap(rs, ro, d);',
  '}'
].join('\n');

var AE_SPHERE_VERT = [
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  'void main() {',
  '  vUv = uv;',
  '  vec4 w = modelMatrix * vec4(position, 1.0);',
  '  vWorld = w.xyz;',
  '  vNormal = normalize(mat3(modelMatrix) * normal);',
  '  gl_Position = projectionMatrix * viewMatrix * w;',
  '}'
].join('\n');

// The Earth: the day map where the Sun is up, city lights where it is down,
// a soft twilight band between, sun glint on the oceans, and the Moon's
// shadow wherever the Moon covers some of the Sun.
var AE_EARTH_FRAG = [
  'precision highp float;',
  'uniform sampler2D dayMap; uniform sampler2D nightMap;',
  'uniform vec3 sunPos; uniform float sunR; uniform vec3 moonPos; uniform float moonR;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_OVERLAP,
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  vec3 L = normalize(sunPos - vWorld);',
  '  vec3 V = normalize(cameraPosition - vWorld);',
  '  float mu = dot(N, L);',
  '  float light = aeSunlight(vWorld, sunPos, sunR, moonPos, moonR);',
  '  vec3 day = texture2D(dayMap, vUv).rgb;',
  '  float lights = texture2D(nightMap, vUv).r;',
  // Lambert shading, softened (the air scatters light round the limb), over
  // a twilight band ~7 degrees wide, times what the Moon leaves of the Sun.
  '  float sun = smoothstep(-0.05, 0.12, mu) * (0.4 + 0.6 * max(mu, 0.0)) * light;',
  '  float night = 1.0 - smoothstep(-0.18, 0.02, mu);',
  '  float ocean = step(day.r * 1.25 + 0.02, day.b) * step(day.g, day.b) * (1.0 - smoothstep(0.12, 0.3, day.b));',
  '  vec3 H = normalize(L + V);',
  '  float glint = pow(max(dot(N, H), 0.0), 80.0) * 0.35 * ocean;',
  // The air's own blue glow (sunlight scattered toward us) lies over the
  // day side; it is what makes the Moon's shadow show over dark ocean too.
  '  vec3 haze = vec3(0.05, 0.09, 0.16);',
  '  vec3 col = day * (0.035 + 1.05 * sun) + haze * sun + vec3(1.0, 0.92, 0.8) * glint * sun;',
  '  col += vec3(1.0, 0.78, 0.45) * pow(lights, 1.6) * 1.25 * night;',
  '  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
  '  col += vec3(0.30, 0.55, 1.0) * rim * 0.55 * smoothstep(-0.25, 0.4, mu) * max(light, 0.35);',
  '  gl_FragColor = vec4(col, 1.0);',
  '}'
].join('\n');

// The atmosphere's glow past the limb, on the sunlit side.
var AE_ATMO_FRAG = [
  'precision highp float;',
  'uniform vec3 sunPos;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  vec3 V = normalize(cameraPosition - vWorld);',
  '  float edge = pow(clamp(1.0 + dot(N, V) * 1.6, 0.0, 1.0), 2.2);',
  '  float lit = smoothstep(-0.3, 0.5, dot(N, normalize(sunPos - vWorld)));',
  '  gl_FragColor = vec4(vec3(0.32, 0.58, 1.0) * edge * lit * 0.8, 1.0);',
  '}'
].join('\n');

// The Moon: sunlight, the Earth's shadow (with the dim copper light the
// Earth's atmosphere bends into it), and a little earthshine.
var AE_MOON_FRAG = [
  'precision highp float;',
  'uniform sampler2D moonMap;',
  'uniform vec3 sunPos; uniform float sunR; uniform float earthR;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_OVERLAP,
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  vec3 L = normalize(sunPos - vWorld);',
  '  float mu = max(dot(N, L), 0.0);',
  '  float light = aeSunlight(vWorld, sunPos, sunR, vec3(0.0), earthR);',
  '  float albedo = texture2D(moonMap, vUv).r;',
  '  vec3 sunlit = vec3(albedo) * 1.15 * mu * light;',
  '  vec3 umbral = vec3(albedo) * vec3(0.62, 0.24, 0.10) * 0.75 * mu * (1.0 - light);',
  '  float earthshine = 0.025 * (1.0 - mu);',
  '  gl_FragColor = vec4(sunlit + umbral + vec3(albedo) * earthshine, 1.0);',
  '}'
].join('\n');

// Points with their own colour, alpha and size: satellites, stars, the Sun.
var AE_POINTS_VERT = [
  'attribute vec3 aColor; attribute float aAlpha; attribute float aSize;',
  'uniform float dpr;',
  'varying vec3 vColor; varying float vAlpha;',
  'void main() {',
  '  vColor = aColor; vAlpha = aAlpha;',
  '  gl_PointSize = aSize * dpr;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');
var AE_POINTS_FRAG = [
  'precision mediump float;',
  'uniform float glow;',
  'varying vec3 vColor; varying float vAlpha;',
  'void main() {',
  '  vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;',
  '  if (r > 1.0) discard;',
  '  float a = glow > 0.5 ? pow(1.0 - r, 2.2) : 1.0 - smoothstep(0.65, 1.0, r);',
  '  gl_FragColor = vec4(vColor, vAlpha * a);',
  '}'
].join('\n');

// A point cloud of `capacity` points on the points shader.
function _aePointCloud(THREE, capacity, dpr, glow, opts) {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(capacity), 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(capacity), 1));
  g.setDrawRange(0, 0);
  var m = new THREE.ShaderMaterial({
    uniforms: { dpr: { value: dpr }, glow: { value: glow ? 1 : 0 } },
    vertexShader: AE_POINTS_VERT, fragmentShader: AE_POINTS_FRAG,
    transparent: true, depthWrite: false, depthTest: opts.depthTest !== false
  });
  var p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}
function _aeSetPoint(cloud, i, pos, color, alpha, size) {
  var a = cloud.geometry.attributes;
  a.position.array[i * 3] = pos[0]; a.position.array[i * 3 + 1] = pos[1]; a.position.array[i * 3 + 2] = pos[2];
  a.aColor.array[i * 3] = color[0]; a.aColor.array[i * 3 + 1] = color[1]; a.aColor.array[i * 3 + 2] = color[2];
  a.aAlpha.array[i] = alpha;
  a.aSize.array[i] = size;
}
function _aeCommitPoints(cloud, count) {
  var a = cloud.geometry.attributes;
  a.position.needsUpdate = a.aColor.needsUpdate = a.aAlpha.needsUpdate = a.aSize.needsUpdate = true;
  cloud.geometry.setDrawRange(0, count);
}
// A line of `count` vertices whose positions are rewritten in place.
function _aeLine(THREE, Kind, count, color, alpha) {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setDrawRange(0, 0);
  var line = new Kind(g, new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: alpha, depthWrite: false }));
  line.frustumCulled = false;
  return line;
}

// The background: the Almanac's bright-star catalogue (almanac-sky.js,
// J2000; the 0.4 degrees of precession since are below what this view
// shows), carried with the camera so the stars sit at infinity.
function _aeStarField(THREE, dpr) {
  var named = (typeof _STARS !== 'undefined') ? _STARS : [];
  var field = (typeof _SKY_FIELD_STARS !== 'undefined') ? _SKY_FIELD_STARS : [];
  var all = named.concat(field);
  var cloud = _aePointCloud(THREE, all.length, dpr, false, { depthTest: true });
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    var v = _aeEqVec(s[0] * AE_HOURS_TO_RAD, _aeRad(s[1]), AE_STAR_RADIUS);
    var mag = s[2], ci = s.length > 3 ? s[3] : 0.6;
    var warm = _aeClamp((ci + 0.3) / 1.9, 0, 1);   // colour index -0.3 (blue) .. 1.6 (orange)
    var col = [0.78 + 0.22 * warm, 0.84 + 0.06 * warm, 1.0 - 0.3 * warm];
    _aeSetPoint(cloud, i, v, col,
      _aeClamp(AE_STAR_ALPHA0 - AE_STAR_ALPHA_PER_MAG * mag, AE_STAR_ALPHA_MIN, 1),
      Math.max(AE_STAR_SIZE_MIN, AE_STAR_SIZE0 - AE_STAR_SIZE_PER_MAG * mag));
  }
  _aeCommitPoints(cloud, all.length);
  return cloud;
}

// Build the three.js scene. Returns null when WebGL is not available.
function _aeBuildGl(THREE, canvas) {
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, AE_MAX_DPR));
  renderer.setClearColor(0x000000, 1);
  var dpr = renderer.getPixelRatio();
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(AE_FOV_DEG, 1, 0.01, AE_FAR);
  camera.up.set(0, 0, 1);

  var shared = {
    sunPos: { value: new THREE.Vector3() },
    sunR: { value: AE_SUN_RADIUS_RE }
  };
  // three's sphere has its poles on y; this scene's are on z. Turned so,
  // texture u = 0.5 lands on +x: longitude 0 on the Earth, the near side's
  // centre on the Moon.
  var earthGeo = new THREE.SphereGeometry(1, AE_EARTH_SEGMENTS[0], AE_EARTH_SEGMENTS[1]);
  earthGeo.rotateX(Math.PI / 2);
  var earthUni = {
    dayMap: { value: null }, nightMap: { value: null },
    sunPos: shared.sunPos, sunR: shared.sunR,
    moonPos: { value: new THREE.Vector3() }, moonR: { value: AE_MOON_RADIUS_RE }
  };
  var earth = new THREE.Mesh(earthGeo, new THREE.ShaderMaterial({
    uniforms: earthUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_EARTH_FRAG
  }));
  earth.scale.set(1, 1, 1 - AE_EARTH_FLATTENING);
  scene.add(earth);

  var atmo = new THREE.Mesh(
    new THREE.SphereGeometry(AE_ATMOSPHERE_SCALE, AE_ATMO_SEGMENTS[0], AE_ATMO_SEGMENTS[1]),
    new THREE.ShaderMaterial({
      uniforms: { sunPos: shared.sunPos }, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_ATMO_FRAG,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
    }));
  scene.add(atmo);

  var moonGeo = new THREE.SphereGeometry(AE_MOON_RADIUS_RE, AE_MOON_SEGMENTS[0], AE_MOON_SEGMENTS[1]);
  moonGeo.rotateX(Math.PI / 2);
  var moonUni = { moonMap: { value: null }, sunPos: shared.sunPos, sunR: shared.sunR, earthR: { value: AE_SHADOW_ENLARGE } };
  var moon = new THREE.Mesh(moonGeo, new THREE.ShaderMaterial({
    uniforms: moonUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_MOON_FRAG
  }));
  moon.matrixAutoUpdate = false;
  scene.add(moon);

  var sky = new THREE.Group();
  sky.add(_aeStarField(THREE, dpr));
  var sunDot = _aePointCloud(THREE, 1, dpr, true, { depthTest: true });
  sky.add(sunDot);
  scene.add(sky);

  var moonPathCount = Math.round(2 * AE_MOON_PATH_HALF_DAYS * 24 / AE_MOON_PATH_STEP_HOURS) + 1;
  var moonPath = _aeLine(THREE, THREE.Line, moonPathCount, AE_MOON_PATH_COLOR, AE_MOON_PATH_ALPHA);
  scene.add(moonPath);
  var gpsRings = _aeLine(THREE, THREE.LineSegments, AE_SAT_CAPACITY * AE_GPS_RING_POINTS * 2, AE_GPS_RING_COLOR, AE_GPS_RING_ALPHA);
  scene.add(gpsRings);
  var issRing = _aeLine(THREE, THREE.LineLoop, AE_ISS_RING_POINTS, AE_ISS_RING_COLOR, AE_ISS_RING_ALPHA);
  scene.add(issRing);
  var sats = _aePointCloud(THREE, AE_SAT_CAPACITY, dpr, false, { depthTest: true });
  scene.add(sats);

  return {
    THREE: THREE, renderer: renderer, scene: scene, camera: camera, dpr: dpr,
    earth: earth, earthUni: earthUni, moon: moon, moonUni: moonUni, shared: shared,
    sky: sky, sunDot: sunDot, moonPath: moonPath, moonPathCount: moonPathCount,
    gpsRings: gpsRings, issRing: issRing, sats: sats,
    basis: new THREE.Matrix4(), vx: new THREE.Vector3(), vy: new THREE.Vector3(), vz: new THREE.Vector3()
  };
}

// ── State ──
function _aeNewState(el) {
  return {
    el: el, gl: null, loading: false, failed: false,
    speed: 1, offset: 0,                  // this view's own clock on top of the Almanac's
    target: 'earth', az: 0, el_: 0, dist: AE_FLY_START_DIST,
    fly: null,                            // { start, from:{target pos, dist}, to }
    pointers: {}, pinch: null, drag: null,
    sats: null, satsFailed: false, satsFetchedAt: null,
    selected: null,                       // { kind: 'gps'|'iss', idx, tapMs }
    ringsAt: null, issRingAt: null, moonPathAt: null,
    positions: [],                        // projected satellites for tapping
    lastTs: 0, lastRender: 0, lastText: 0, dirty: true,
    raf: 0, idleTimer: 0, stats: [], renderMs: [],
    scene: null
  };
}

// The instant on display: the Almanac's (live now, or wherever its time
// machine stands) plus whatever this view's own speed has run up.
function _aeDisplayMs() {
  var base = (typeof _almFocusInstant === 'function') ? _almFocusInstant().getTime() : Date.now();
  return base + (_ae ? _ae.offset : 0);
}
function _aeIsLive() {
  return !(typeof _almFocus !== 'undefined' && _almFocus) && _ae && _ae.offset === 0 && _ae.speed === 1;
}

// ── Camera ──
function _aeFitDist(radius) {
  var S = _ae.gl, cam = S.camera;
  var half = Math.tan(_aeRad(AE_FOV_DEG) / 2) * Math.min(1, cam.aspect);
  return radius / (half * AE_FIT_FILL);
}
function _aeMinDist() { return _ae.target === 'moon' ? AE_MIN_DIST_MOON : AE_MIN_DIST_EARTH; }
function _aeTargetPos() {
  return (_ae.target === 'moon' && _ae.scene) ? _ae.scene.moon : [0, 0, 0];
}
function _aeCameraOffset(az, el, dist) {
  return [dist * Math.cos(el) * Math.cos(az), dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el)];
}
// Direction (az, el) from which the camera looks down on a scene vector.
function _aeAzElOf(v) {
  var n = _aeNorm(v);
  return { az: Math.atan2(n[1], n[0]), el: _aeClamp(Math.asin(n[2]), -AE_MAX_ELEVATION, AE_MAX_ELEVATION) };
}

function _aeFlyTo(target, dist, azel) {
  var from = { pos: _aeTargetPos(), dist: _ae.dist, az: _ae.az, el: _ae.el_ };
  _ae.target = target;
  if (azel) { _ae.az = azel.az; _ae.el_ = azel.el; }
  var to = { dist: _aeClamp(dist, _aeMinDist(), AE_MAX_DIST) };
  if (_aeReduceMotion()) { _ae.dist = to.dist; _ae.fly = null; }
  else {
    // Turn the short way round.
    var daz = ((_ae.az - from.az + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    _ae.fly = { start: performance.now(), from: from, toDist: to.dist, toAz: from.az + daz, toEl: _ae.el_ };
    _ae.az = from.az; _ae.el_ = from.el;
  }
  _aeMarkViews();
  _aeKick();
}
function _aeStepFly(now) {
  var f = _ae.fly;
  if (!f) return false;
  var p = _aeClamp((now - f.start) / AE_FLY_MS, 0, 1), e = _aeEaseOut(p);
  _ae.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.toDist) - Math.log(f.from.dist)) * e);
  _ae.az = f.from.az + (f.toAz - f.from.az) * e;
  _ae.el_ = f.from.el + (f.toEl - f.from.el) * e;
  if (p >= 1) _ae.fly = null;
  return true;
}
function _aeFlyTargetPos() {
  var f = _ae.fly, to = _aeTargetPos();
  if (!f) return to;
  var e = _aeEaseOut(_aeClamp((performance.now() - f.start) / AE_FLY_MS, 0, 1));
  return [f.from.pos[0] + (to[0] - f.from.pos[0]) * e, f.from.pos[1] + (to[1] - f.from.pos[1]) * e, f.from.pos[2] + (to[2] - f.from.pos[2]) * e];
}

function _aePlaceCamera() {
  var S = _ae.gl, cam = S.camera;
  var tp = _aeFlyTargetPos();
  var off = _aeCameraOffset(_ae.az, _ae.el_, _ae.dist);
  var pos = [tp[0] + off[0], tp[1] + off[1], tp[2] + off[2]];
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.lookAt(tp[0], tp[1], tp[2]);
  // Near plane from the nearest surface, so the Earth's limb never clips
  // and depth precision stays where the eye is.
  var toEarth = _aeLen(pos) - 1;
  var toMoon = _ae.scene ? _aeLen(_aeSub(pos, _ae.scene.moon)) - AE_MOON_RADIUS_RE : Infinity;
  cam.near = Math.max(AE_NEAR_MIN, Math.min(toEarth, toMoon) * AE_NEAR_FRACTION);
  cam.updateProjectionMatrix();
  S.sky.position.copy(cam.position);
  // An orbit much wider than the screen shows only as arcs through it, a web
  // of straight lines, not a ring: the GPS orbits and the Moon's path fade in
  // as the view widens to hold them.
  var halfView = _aeLen(pos) * Math.tan(_aeRad(AE_FOV_DEG) / 2) * Math.min(1, cam.aspect);
  _aeFadeLine(S.gpsRings, AE_GPS_RING_ALPHA, halfView / AE_GPS_SHELL_RE);
  _aeFadeLine(S.moonPath, AE_MOON_PATH_ALPHA, halfView / _aeLen(_ae.scene ? _ae.scene.moon : [AE_MOON_MEAN_DIST_KM / AE_EARTH_RADIUS_KM, 0, 0]));
}
// Opacity from how much of an orbit the view holds (half-view over radius).
function _aeFadeLine(line, alpha, held) {
  var out = _aeClamp((held - AE_ORBIT_FADE_FROM) / (AE_ORBIT_FADE_TO - AE_ORBIT_FADE_FROM), 0, 1);
  line.material.opacity = alpha * out;
  line.visible = out > 0;
}

function _aePreset(name) {
  if (!_ae.gl) return;
  if (name === 'moon') {
    // From the Earth's side: the phase (and any eclipse) as seen from home.
    var azel = _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.moon, -1)) : null;
    _aeFlyTo('moon', _aeFitDist(AE_FIT_MOON), azel);
  } else {
    _aeFlyTo('earth', _aeFitDist(name === 'sats' ? AE_FIT_SATS : AE_FIT_EARTH), null);
  }
  _ae.preset = name;
  _aeMarkViews();
}
function _aeMarkViews() {
  var btns = document.querySelectorAll('#ae-views [data-ae-view]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-ae-view') === _ae.preset));
  }
}

// ── Satellites ──
function _aeLoadSats() {
  Promise.all([_aeLoadSgp4(), fetch(AE_SATS_URL).then(function (r) {
    if (!r.ok) throw new Error('status ' + r.status);
    return r.json();
  })]).then(function (res) {
    var lib = res[0], data = res[1];
    var list = [];
    (data.gps || []).forEach(function (omm) {
      try { var rec = lib.json2satrec(omm); if (!rec.error) list.push({ omm: omm, rec: rec, iss: false }); } catch (e) {}
    });
    if (data.iss) {
      try { var r2 = lib.json2satrec(data.iss); if (!r2.error) list.push({ omm: data.iss, rec: r2, iss: true }); } catch (e) {}
    }
    list = list.slice(0, AE_SAT_CAPACITY);
    list.forEach(function (s) { s.epochMs = _aeSatEpochMs(s.rec); });
    _ae.sats = { lib: lib, list: list, source: data.source || '' };
    _ae.ringsAt = _ae.issRingAt = null;
    _ae.dirty = true;
    _aeKick();
  }).catch(function () {
    _ae.satsFailed = true;
    _ae.dirty = true;
  });
}

// Position (scene) and velocity (km/s) of a satellite at a JS time, or null.
function _aeSatAt(s, ms, eqeq) {
  var pv = _ae.sats.lib.sgp4(s.rec, (ms - s.epochMs) / AE_MS_PER_MINUTE);
  if (!pv || !pv.position || typeof pv.position.x !== 'number' || isNaN(pv.position.x)) return null;
  return { pos: _aeTemeToScene(pv.position, eqeq), posKm: pv.position, velKmS: pv.velocity };
}

// One orbit of a satellite as scene points, starting now.
function _aeOrbitPoints(s, ms, eqeq, n) {
  var periodMs = AE_MINUTES_PER_DAY / s.omm.MEAN_MOTION * AE_MS_PER_MINUTE;
  var pts = [];
  for (var i = 0; i < n; i++) {
    var st = _aeSatAt(s, ms + periodMs * i / n, eqeq);
    if (!st) return null;
    pts.push(st.pos);
  }
  return pts;
}

function _aeUpdateSats(ms, sc) {
  var S = _ae.gl, sats = _ae.sats;
  _ae.positions = [];
  if (!sats) { _aeCommitPoints(S.sats, 0); S.gpsRings.geometry.setDrawRange(0, 0); S.issRing.geometry.setDrawRange(0, 0); return; }
  var eqeq = _aeEqEq(sc);
  var count = 0;
  var refreshRings = _ae.ringsAt === null || Math.abs(ms - _ae.ringsAt) > AE_RING_REFRESH_MS;
  var ringArr = S.gpsRings.geometry.attributes.position.array, ringN = 0;
  var issShown = false;
  for (var i = 0; i < sats.list.length; i++) {
    var s = sats.list[i];
    var standing = _aeSatStanding((ms - s.epochMs) / MS_PER_DAY, s.iss);
    s.standing = standing;
    if (standing === 'none') continue;
    var st = _aeSatAt(s, ms, eqeq);
    if (!st) continue;
    var sel = _ae.selected && _ae.selected.idx === i;
    var color = sel ? AE_SELECTED_COLOR : (s.iss ? AE_ISS_COLOR : AE_GPS_COLOR);
    var alpha = (s.iss && standing === 'approximate') ? AE_ISS_FADED_ALPHA : 1;
    var size = sel ? AE_SAT_SELECTED_PX : (s.iss ? AE_ISS_POINT_PX : AE_SAT_POINT_PX);
    _aeSetPoint(S.sats, count++, st.pos, color, alpha, size);
    _ae.positions.push({ idx: i, pos: st.pos, st: st });
    if (s.iss) {
      issShown = true;
      if (_ae.issRingAt === null || Math.abs(ms - _ae.issRingAt) > AE_ISS_RING_REFRESH_MS) {
        var ring = _aeOrbitPoints(s, ms, eqeq, AE_ISS_RING_POINTS);
        if (ring) {
          var ia = S.issRing.geometry.attributes.position.array;
          for (var k = 0; k < ring.length; k++) { ia[k * 3] = ring[k][0]; ia[k * 3 + 1] = ring[k][1]; ia[k * 3 + 2] = ring[k][2]; }
          S.issRing.geometry.attributes.position.needsUpdate = true;
          S.issRing.geometry.setDrawRange(0, ring.length);
          _ae.issRingAt = ms;
        }
      }
      S.issRing.material.opacity = standing === 'approximate' ? AE_ISS_RING_FADED : AE_ISS_RING_ALPHA;
    } else if (refreshRings) {
      var pts = _aeOrbitPoints(s, ms, eqeq, AE_GPS_RING_POINTS);
      if (pts) {
        for (var j = 0; j < pts.length; j++) {
          var a = pts[j], b = pts[(j + 1) % pts.length];
          ringArr.set(a, ringN * 3); ringArr.set(b, ringN * 3 + 3);
          ringN += 2;
        }
      }
    }
  }
  _aeCommitPoints(S.sats, count);
  if (refreshRings) {
    S.gpsRings.geometry.attributes.position.needsUpdate = true;
    S.gpsRings.geometry.setDrawRange(0, ringN);
    _ae.ringsAt = ms;
  }
  if (!issShown) { S.issRing.geometry.setDrawRange(0, 0); _ae.issRingAt = null; }
}
