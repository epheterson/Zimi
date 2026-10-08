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
//     a snapshot ships with each release, the server fetches fresher ones as
//     "Satellite data from the internet" allows (/almanac-satellites: Ask
//     first, the default, fetches only when an admin presses Get fresh data;
//     Automatically; Never; ZIMI_OFFLINE forces Never), and SGP4/SDP4
//     (satellite.js, MIT) propagates them. The ISS's place along its orbit
//     drifts once its data is a few days old, so its dot fades and says so,
//     and past two weeks only its orbit is drawn.
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
// The AU, the speed of light and the day in seconds are the orrery's
// (almanac-orrery.js AU_KM, SPEED_OF_LIGHT_KM_S, SECONDS_PER_DAY); the
// Julian Day is almanac.js's _dateToJD. They share this global scope.
var AE_EARTH_RADIUS_KM = 6378.137;            // WGS84 equatorial radius
var AE_EARTH_FLATTENING = 1 / 298.257223563;  // WGS84
var AE_EARTH_E2 = AE_EARTH_FLATTENING * (2 - AE_EARTH_FLATTENING); // first eccentricity squared
var AE_MOON_RADIUS_KM = 1737.4;               // IAU mean radius
var AE_SUN_RADIUS_KM = 695700;                // IAU 2015 nominal solar radius
var AE_GM_EARTH = 398600.4418;                // km^3/s^2, WGS84 / IERS
// L_G: the rate by which a clock on the geoid (Earth's rotation included)
// runs slow against one far from the Earth, W0/c^2 (IAU 2000 Resolution B1.9).
var AE_L_G = 6.969290134e-10;
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
// The mean motions of Meeus 47.1-47.5, degrees per Julian century of TT, and
// the mean obliquity of Meeus 22.2 at J2000 and its rate (arcseconds). Named
// so the Almanac's Constants tables read the very numbers the Moon is built on.
var AE_MOON_MEAN_LON_RATE = 481267.88123421;   // the Moon's mean longitude
var AE_MOON_ELONG_RATE = 445267.1114034;       // its mean elongation from the Sun
var AE_SUN_ANOMALY_RATE = 35999.0502909;       // the Sun's mean anomaly
var AE_MOON_ANOMALY_RATE = 477198.8675055;     // the Moon's mean anomaly
var AE_MOON_ARGLAT_RATE = 483202.0175233;      // its argument of latitude
var AE_OBLIQUITY_J2000_ARCSEC = 23 * 3600 + 26 * 60 + 21.448;
var AE_OBLIQUITY_RATE_ARCSEC = -46.8150;

function _aeDeg(x) { return x * 180 / Math.PI; }
function _aeRad(x) { return x * Math.PI / 180; }
function _aeNormDeg(x) { return ((x % 360) + 360) % 360; }

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
  var eps0 = (AE_OBLIQUITY_J2000_ARCSEC + AE_OBLIQUITY_RATE_ARCSEC * T - 0.00059 * T * T + 0.001813 * T * T * T) / 3600;
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
  return { ra: eq.ra, dec: eq.dec, distKm: R * AU_KM, lon: _aeNormDeg(lon), nut: nut };
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
  var Lp = 218.3164477 + AE_MOON_MEAN_LON_RATE * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;   // mean longitude
  var D = 297.8501921 + AE_MOON_ELONG_RATE * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000;     // mean elongation
  var M = 357.5291092 + AE_SUN_ANOMALY_RATE * T - 0.0001536 * T2 + T3 / 24490000;                     // Sun's mean anomaly
  var Mp = 134.9633964 + AE_MOON_ANOMALY_RATE * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000;       // Moon's mean anomaly
  var F = 93.2720950 + AE_MOON_ARGLAT_RATE * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000;      // argument of latitude
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
  var jd = _dateToJD(ms);
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

// Where the Sun is drawn (AE_SUN_SHOW_DIST): its true direction, nearer.
function _aeSunShown(scene) {
  return _aeScale(_aeNorm(scene.sun), AE_SUN_SHOW_DIST);
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
  var c2 = SPEED_OF_LIGHT_KM_S * SPEED_OF_LIGHT_KM_S;
  var grav = AE_L_G - AE_GM_EARTH / (rKm * c2);
  var speed = -(vKmS * vKmS) / (2 * c2);
  return { grav: grav, speed: speed, net: grav + speed };
}
// Microseconds a day for a fractional rate, and the ranging error it becomes
// in a day if ignored (the clock error times the speed of light), km.
function _aeMicrosPerDay(rate) { return rate * SECONDS_PER_DAY * AE_MICRO; }
function _aeKmPerDay(rate) { return rate * SECONDS_PER_DAY * SPEED_OF_LIGHT_KM_S; }

// ── Satellites: what the data supports ──
// Elements are drawn only near the instant they describe. GPS orbits hold
// their shape for months at this scale. The ISS's orbit does too (SGP4 keeps
// its plane well), but drag and reboosts move its place along the orbit:
// past AE_ISS_EXACT_DAYS its dot fades and is labelled approximate, and past
// AE_ISS_DOT_DAYS, when that place could be anywhere round the orbit (2-3
// weeks of unmodelled reboosts), only the orbit is drawn, with a dated note.
var AE_SAT_WINDOW_DAYS = 180;
var AE_ISS_EXACT_DAYS = 3;
var AE_ISS_DOT_DAYS = 14;
var AE_MINUTES_PER_DAY = 1440;
var AE_MS_PER_MINUTE = 60000;
var AE_ISS_NORAD_ID = 25544;

// JS time of an element set's epoch, from satellite.js's Julian date.
function _aeSatEpochMs(satrec) { return (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY; }

// How an element set this many days from the displayed instant (either
// direction) is drawn: 'exact', 'approximate' (a faded dot), 'orbit' (the
// ISS's ring alone) or 'none'.
function _aeSatStanding(ageDays, isIss) {
  var a = Math.abs(ageDays);
  if (a > AE_SAT_WINDOW_DAYS) return 'none';
  if (!isIss || a <= AE_ISS_EXACT_DAYS) return 'exact';
  return a <= AE_ISS_DOT_DAYS ? 'approximate' : 'orbit';
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
// A candidate the view's own geometry shows no eclipse at is passed over:
// tens of millennia out the list's series and this view's part ways, and
// the button landed on an ordinary day with nothing to see.
var AE_ECLIPSE_MIN_AHEAD_MS = 60 * 60 * 1000;
var AE_ECLIPSE_CANDIDATES = 6;
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
    if (at <= ms + AE_ECLIPSE_MIN_AHEAD_MS) continue;
    var seen = _aeEclipseNow(_aeSceneAt(at));
    if (seen && seen.solar === list[i].solar) return { ms: at, solar: list[i].solar, type: list[i].type };
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
var AE_STARS_URL = '/static/earth/stars-v1.bin';   // scripts/build_star_catalog.py documents the format
var AE_TEX_DAY = '/static/earth/earth-day-v1.webp';
var AE_TEX_NIGHT = '/static/earth/earth-night-v1.webp';
var AE_TEX_MOON = _MOON_MAP_URL;        // app.js: the 2D Moons' maps, the 1024 one first
var AE_TEX_MOON_HI = _MOON_MAP_HI_URL;
// The 4096 map goes to the GPU as one channel (8 MB, not 32): three's
// RedFormat, which the tree-shaken build does not export by name.
var AE_THREE_RED_FORMAT = 1028;
// Light added without touching the canvas's alpha (_aeAddLight): three's
// CustomBlending, ZeroFactor and OneFactor, not exported by name either.
var AE_THREE_CUSTOM_BLENDING = 5, AE_THREE_ZERO_FACTOR = 200, AE_THREE_ONE_FACTOR = 201;
var AE_SATS_URL = '/almanac-satellites';
// When the server says it is fetching fresher elements, ask again after this:
// its refresh is two CelesTrak requests of up to 20 s each (satellites.py
// FETCH_TIMEOUT_S), and a little over.
var AE_SATS_REFETCH_MS = 45 * 1000;
// "Satellite data from the internet" (satellites.py): the setting, and the
// admin's one fetch under Ask first. Both are /manage writes, admin-gated.
var AE_SATS_SETTING_URL = '/manage/satellites';
var AE_SATS_REFRESH_URL = '/manage/satellites/refresh';
// Each choice is labelled alm_earth_sat_<mode>, and described by <that>_hint
// (Server settings in app.js reads the same labels).
var AE_SAT_MODES = ['ask', 'auto', 'never'];
var AE_SAT_MODE_KEY = 'alm_earth_sat_';
var AE_SAT_ENV = 'ZIMI_SATELLITE_UPDATES';
var AE_HTTP_UNAUTHORIZED = 401, AE_HTTP_FORBIDDEN = 403;

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
var AE_DRAG_RAD_PER_PX = 0.02;        // the fastest a drag turns (a disc too small to follow the finger)
var AE_WHEEL_ZOOM = 0.0015;           // log-distance per wheel unit
var AE_KEY_TURN = _aeRad(5);
var AE_KEY_ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };   // as a one-pixel drag
var AE_KEY_ZOOM = 1.15;
// A flight's length grows with how far it goes, as a multiple of the scale
// it leaves or arrives at (log, so the Moon is not ten times the trip to the
// GPS shell): a nudge between framings is quick, a crossing to the Sun is
// the longest, and nothing takes longer than AE_FLY_FAR_MS.
var AE_FLY_MIN_MS = 500;
var AE_FLY_MS_PER_LOG = 300;
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
// Multisampling smooths edges only below this pixel ratio: at 2x a pixel is
// too small for the jaggies to show, and it would hold four more colour
// samples a pixel (~16 MB more on a phone screen).
var AE_MSAA_BELOW_DPR = 2;
var AE_EARTH_SEGMENTS = [128, 64];
var AE_ATMO_SEGMENTS = [96, 48];
var AE_MOON_SEGMENTS = [64, 32];
var AE_ATMOSPHERE_SCALE = 1.018;      // the glow's shell, ~115 km above the surface
var AE_ANISOTROPY = 8;
var AE_IDLE_RENDER_MS = 250;          // at real-time speed nothing moves faster than this shows
var AE_TEXT_TICK_MS = 100;            // readouts and the GPS counter
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
// The Sun, drawn where it is but not at its distance or size: a disc 3,000
// Earth radii out along its true direction (the real one is ~23,500), about
// three times its true width, so it can be seen, and flown to, from here.
// Its light on the Earth and the Moon comes from the real Sun (sunPos).
var AE_SUN_SHOW_DIST = 3000;
var AE_SUN_SHOW_R = 40;               // ~0.76 degrees as seen from the Earth (real: 0.27)
var AE_SUN_SEGMENTS = [48, 24];
var AE_SUN_GLOW_SCALE = 7;            // the glow's width, in the disc's radii
var AE_GRANULES_PER_RADIUS = 160;     // the granulation's cells (real: ~700, too fine to draw)
var AE_GRANULE_CONTRAST = 0.3;        // bright cells against dark lanes, at the disc's centre
var AE_GRANULE_LIFE_S = 600;          // a granule lives about ten minutes, on the page's clock
var AE_GRANULE_CYCLE = 512;           // the pattern's time, wrapped to keep a float's precision
var AE_SUN_EXPOSURE = [4.5, 2.5, 1.05];   // the photosphere's exposure per colour: golden centre, deep orange limb
var AE_FIT_SUN = AE_SUN_SHOW_R * 2.2; // the disc and the glow nearest it
var AE_MIN_DIST_SUN = AE_SUN_SHOW_R * 1.3;
var AE_MAX_DIST_SUN = 1400;
var AE_FLY_FAR_MS = 1600;             // the longest flight: to or from the Sun, 3,000 Earth radii
var AE_HINT_MS = 4500;
// Show where I am: a crosshair, the mark every map uses for "locate me".
var AE_LOCATE_SVG = typeof ALM_LOCATE_SVG === 'string' ? ALM_LOCATE_SVG : '';   // almanac.js
var AE_LOCATE_TIMEOUT_MS = 15000;
var AE_SPEEDS = [1, 60, 3600];        // real time, a minute a second, an hour a second
var AE_SPEED_KEYS = ['alm_earth_rate_real', 'alm_earth_rate_min', 'alm_earth_rate_hour'];
var AE_GPS_COLOR = [0.55, 0.85, 1.0];
var AE_ISS_COLOR = [1.0, 0.82, 0.35];
var AE_SELECTED_COLOR = [1.0, 0.62, 0.04];
var AE_GPS_RING_COLOR = 0x6fb8ff, AE_GPS_RING_ALPHA = 0.2;
var AE_GPS_SHELL_RE = 4.16;           // GPS orbit radius, 26,560 km, in Earth radii
// Orbits fade in between the view holding half of one and nearly all of it.
var AE_ORBIT_FADE_FROM = 0.5, AE_ORBIT_FADE_TO = 0.85;
var AE_ISS_RING_COLOR = 0xffc861, AE_ISS_RING_ALPHA = 0.5, AE_ISS_RING_FADED = 0.25;
var AE_MOON_PATH_COLOR = 0xffffff, AE_MOON_PATH_ALPHA = 0.16;
// Star dots from magnitude (brighter = bigger, more opaque) and colour index.
// The faintest naked-eye stars (magnitude 5 to 6.5) fall to a one-pixel
// dust at a low alpha, so they texture the dark rather than read as dots.
var AE_STAR_SIZE0 = 3.4, AE_STAR_SIZE_PER_MAG = 0.55, AE_STAR_SIZE_MIN = 1.0;
var AE_STAR_ALPHA0 = 1.05, AE_STAR_ALPHA_PER_MAG = 0.16, AE_STAR_ALPHA_MIN = 0.12;
var AE_STAR_COLOR_DEFAULT = 0.6;      // B-V where a star has none (the Sun's is 0.65)
var AE_STAR_CI_MIN = -0.3, AE_STAR_CI_SPAN = 1.9;   // colour index -0.3 (blue) .. 1.6 (orange)
// stars-v1.bin (scripts/build_star_catalog.py): header, then planar arrays.
var AE_STARS_HEADER_BYTES = 4, AE_STARS_VERSION = 1, AE_STARS_BYTES_EACH = 6;
var AE_STARS_U16_STEPS = 65536, AE_STARS_U16_MAX = 65535;
var AE_STARS_MAG_OFFSET = 2, AE_STARS_MAG_SCALE = 25;
var AE_STARS_BV_SCALE = 50, AE_STARS_BV_NONE = -128;
var AE_HOURS_TO_RAD = Math.PI / 12;

var _ae = null;          // view state, built on first open
var _aeFadeU = { value: 1 };   // how far in from the hero the view has come: what is not the Moon fades by it
var _aeIsOpen = false;

function _aeT(key, vars) { return (typeof t === 'function') ? t(key, vars) : key; }
function _aeReduceMotion() { return (typeof _almReduceMotion === 'function') ? _almReduceMotion() : false; }
function _aeLink(key, html) { return window.AlmanacLinks ? window.AlmanacLinks.wrap(key, html) : html; }
function _aeLinked(key) { return !!(window.AlmanacLinks && window.AlmanacLinks.linkFor(key)); }
function _aeClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function _aeEaseOut(p) { return 1 - Math.pow(1 - p, 3); }
// A flight speeds up, cruises and slows to arrive: cubic in and out.
function _aeEaseInOut(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
// Isolated left-to-right (U+2066 ... U+2069): inside a right-to-left
// sentence the bidi algorithm otherwise reorders its runs ("S, 48.5° W 31.3°").
var AE_LTR_ISOLATE = '\u2066', AE_POP_ISOLATE = '\u2069';
function _aeFmtLatLon(p) {
  var ns = p.lat >= 0 ? 'N' : 'S', ew = p.lon >= 0 ? 'E' : 'W';
  return AE_LTR_ISOLATE + _orrNum(Math.abs(p.lat), null, 1) + '° ' + ns + ', ' + _orrNum(Math.abs(p.lon), null, 1) + '° ' + ew + AE_POP_ISOLATE;
}
// Numbers and dates through the orrery's formatter cache (almanac-orrery.js
// _orrNum, _orrFormatter): the readouts run ten times a second, and building
// a formatter costs about a millisecond on a phone.
var AE_DATE_OPTS = { day: 'numeric', month: 'short', year: 'numeric' };
var AE_WHEN_OPTS = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
function _aeDateFormatter(shape, opts) {
  return _orrFormatter(shape, function (lang) { return new Intl.DateTimeFormat(lang, opts); });
}
function _aeFmtDate(ms) { return _aeDateFormatter('ae-date', AE_DATE_OPTS).format(new Date(ms)); }
function _aeFmtWhen(ms) {
  var d = new Date(ms);
  // A year before 1 needs the era spelled out (almanac.js _almEraOpts).
  if (d.getFullYear() <= 0 && typeof _almEraOpts === 'function') {
    return _aeDateFormatter('ae-when-era', _almEraOpts(d, AE_WHEN_OPTS)).format(d);
  }
  return _aeDateFormatter('ae-when', AE_WHEN_OPTS).format(d);
}
function _aeById(id) { return document.getElementById(id); }

// The styles live with the view (injected on first open), so a device that
// never opens it never parses them.
var AE_CSS = [
  '.ae-view{position:absolute;inset:0;z-index:40;background:#000;display:none;overflow:hidden;color:var(--text);touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',
  '.ae-view.open{display:block}',
  '.almanac-view.ae-covered>.almanac-content{visibility:hidden}',
  // Mid-swap with the hero: the page shows through, dimming as the view
  // opens (_aeHandApply), and the controls come up at the end.
  '.ae-view.ae-hand{background:transparent}',
  '.ae-top,.ae-bottom,.ae-status,.ae-labels{opacity:var(--ae-ui,1)}',
  '.ae-view.ae-hand .ae-top>*,.ae-view.ae-hand .ae-row,.ae-view.ae-hand .ae-note{pointer-events:none}',
  '.ae-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;outline:none}',
  '.ae-canvas.ae-dragging{cursor:grabbing}',
  '.ae-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 16px 28px;background:linear-gradient(rgba(0,0,0,.6),transparent);pointer-events:none}',
  '.ae-top>*{pointer-events:auto}',
  '.ae-btn{font:inherit;font-size:13px;line-height:1;padding:8px 12px;min-height:34px;border-radius:999px;border:1px solid var(--border);background:rgba(18,18,20,.82);color:var(--text2);cursor:pointer;white-space:nowrap}',
  // Hover only where there is one: on a phone a tapped button kept the hover
  // look, and Next eclipse read as pressed beside the real toggles.
  '.ae-btn:focus-visible{color:var(--amber);border-color:var(--amber-border);background:var(--amber-glow);outline:none}',
  '@media (hover:hover){.ae-btn:hover{color:var(--amber);border-color:var(--amber-border);background:var(--amber-glow)}}',
  '.ae-btn[disabled]{opacity:.45;cursor:default;pointer-events:none}',
  '.ae-btn[aria-pressed="true"]{color:var(--amber);border-color:var(--amber-border);background:rgba(245,158,11,.14)}',
  '.ae-btn[hidden]{display:none}',
  '.ae-back{color:var(--text);flex:0 0 auto}',
  '[dir="rtl"] .ae-chev{display:inline-block;transform:scaleX(-1)}',
  '.ae-when{text-align:end;font-size:11px;color:var(--text2);font-variant-numeric:tabular-nums;line-height:1.35;min-width:0}',
  '.ae-when b{display:block;font-size:13px;color:var(--text);font-weight:600}',
  '.ae-top-end{display:flex;align-items:flex-start;gap:8px;min-width:0}',
  '.ae-when-col{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}',
  '.ae-tools{display:flex;flex-direction:column;gap:6px}',
  '.ae-view.ae-away .ae-when b{color:var(--amber)}',
  // Away from now, Now stands under the date: the eclipse line steps below it.
  '.ae-view.ae-away .ae-status{top:96px}',
  '.ae-btn.ae-now,.ae-btn.ae-now:focus-visible{color:#000;background:var(--amber);border-color:var(--amber);font-weight:600}',
  '@media (hover:hover){.ae-btn.ae-now:hover{color:#000;background:var(--amber);filter:brightness(1.1)}}',
  '.ae-round{flex:0 0 auto;width:34px;padding:0;display:inline-flex;align-items:center;justify-content:center}',
  '.ae-gear[aria-expanded="true"]{color:var(--amber);border-color:var(--amber-border)}',
  '.ae-set{position:absolute;top:56px;inset-inline-end:16px;width:min(300px,calc(100% - 32px));box-sizing:border-box;background:rgba(14,14,16,.96);border:1px solid var(--border);border-radius:12px;padding:12px 10px 10px;font-size:13px;line-height:1.45;color:var(--text2);z-index:1}',
  '.ae-set[hidden]{display:none}',
  '.ae-set h3{margin:0 4px 6px;font-size:13px;font-weight:600;color:var(--text)}',
  '.ae-set-choice{display:flex;gap:10px;align-items:flex-start;padding:7px 4px;border-radius:8px;cursor:pointer}',
  '.ae-set-choice:hover{background:rgba(255,255,255,.04)}',
  '.ae-set-choice input{margin:3px 0 0;flex:0 0 auto;accent-color:var(--amber)}',
  '.ae-set-choice b{display:block;font-weight:500;color:var(--text)}',
  '.ae-set-choice small{display:block;font-size:11.5px;color:var(--text2)}',
  '.ae-set-choice.ae-off{cursor:default}',
  '.ae-set-choice.ae-off:hover{background:none}',
  '.ae-set-why{margin:6px 4px 0;font-size:11.5px;color:var(--text2)}',
  '.ae-live{color:#6ec56e}',
  '.ae-status{position:absolute;left:16px;right:16px;top:66px;text-align:center;font-size:13px;line-height:1.4;color:#f5c16c;pointer-events:none;text-shadow:0 1px 3px #000}',
  '.ae-bottom{position:absolute;left:0;right:0;bottom:0;padding:28px 16px calc(12px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;align-items:center;background:linear-gradient(transparent,rgba(0,0,0,.72));pointer-events:none}',
  '.ae-row{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;pointer-events:auto}',
  '.ae-orient{font-size:11px;line-height:1;color:var(--text3);letter-spacing:.02em;text-shadow:0 1px 2px #000}',
  '.ae-orient[hidden]{display:none}',
  '.ae-note{font-size:10.5px;line-height:1.4;color:var(--text3);text-align:center;pointer-events:auto;max-width:560px}',
  '.ae-ask-text{color:var(--text2)}',
  '.ae-fresh{font:inherit;font-size:11px;line-height:1;padding:6px 10px;min-height:26px;margin:2px 0;margin-inline-start:6px;border-radius:999px;border:1px solid var(--amber-border);background:var(--amber-glow);color:var(--amber);cursor:pointer;vertical-align:middle}',
  '.ae-fresh:focus-visible{background:rgba(245,158,11,.18);outline:none}',
  '@media (hover:hover){.ae-fresh:hover{background:rgba(245,158,11,.18)}}',
  '@media (pointer:coarse){.ae-fresh{min-height:32px;padding:8px 12px}}',
  '.ae-fresh[disabled]{opacity:.7;cursor:default}',
  '.ae-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}',
  '.ae-label{position:absolute;left:0;top:0;font-size:11px;color:#dfe6f0;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 4px #000}',
  '.ae-label[hidden]{display:none}',
  '.ae-label.ae-faded{opacity:.62}',
  '.ae-label-sub{display:block;font-size:10px;color:var(--text2)}',
  '.ae-label-you{color:#f5c16c}',
  '.ae-label-shadow{color:#ffb4a0}',
  // A label that marks a place carries its dot ON the place: the dot hangs
  // off the label by the label's own gap (AE_LABEL_DX), on whichever side
  // the label hangs from its point, in either writing direction.
  '.ae-mark{position:absolute;top:50%;left:-' + AE_LABEL_DX + 'px;width:8px;height:8px;box-sizing:border-box;border-radius:50%;background:currentColor;transform:translate(-50%,-50%);box-shadow:0 0 3px #000}',
  '.ae-hang-left .ae-mark{left:auto;right:-' + AE_LABEL_DX + 'px;transform:translate(50%,-50%)}',
  '.ae-label-shadow .ae-mark{width:10px;height:10px;border:1.5px solid currentColor;background:radial-gradient(currentColor 30%,transparent 38%)}',
  // The card and the hint stand just above the controls, however tall the
  // controls and the note under them grow (a two-line note overlapped them).
  '.ae-card{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - 18px);width:min(420px,calc(100% - 32px));box-sizing:border-box;background:rgba(14,14,16,.94);border:1px solid var(--border);border-radius:12px;padding:12px 40px 12px 14px;font-size:13px;line-height:1.5;color:var(--text2);pointer-events:auto}',
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
  '.ae-view.ae-blank .ae-bottom,.ae-view.ae-blank .ae-status{display:none}',
  '.ae-hint{position:absolute;left:50%;bottom:calc(100% - 18px);transform:translateX(-50%);box-sizing:border-box;width:max-content;max-width:calc(100% - 32px);padding:8px 14px;border-radius:16px;background:rgba(0,0,0,.6);color:var(--text2);font-size:12px;line-height:1.4;text-align:center;pointer-events:none;opacity:0;transition:opacity .6s}',
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
  var gearLabel = _aeT('alm_earth_sat_setting');
  var locateLabel = _aeT('alm_earth_where_i_am');
  var speeds = AE_SPEEDS.map(function (s, i) {
    return '<button type="button" class="ae-btn" data-ae-speed="' + s + '" aria-pressed="' + (i === 0) + '">' +
      _almEsc(_aeT(AE_SPEED_KEYS[i])) + '</button>';
  }).join('');
  el.innerHTML =
    '<canvas class="ae-canvas" id="ae-canvas" tabindex="0" role="img"></canvas>' +
    '<div class="ae-labels" id="ae-labels">' +
      '<span class="ae-label" id="ae-lbl-moon" hidden>' + _almEsc(_aeT('alm_moon')) + '</span>' +
      '<span class="ae-label" id="ae-lbl-iss" hidden></span>' +
      '<span class="ae-label ae-label-you" id="ae-lbl-you" hidden><i class="ae-mark" aria-hidden="true"></i>' + _almEsc(_aeT('alm_earth_you')) + '</span>' +
      '<span class="ae-label ae-label-shadow" id="ae-lbl-shadow" hidden><i class="ae-mark" aria-hidden="true"></i>' + _almEsc(_aeT('alm_earth_shadow')) + '</span>' +
    '</div>' +
    '<div class="ae-msg" id="ae-msg"></div>' +
    '<div class="ae-top">' +
      '<button type="button" class="ae-btn ae-back" id="ae-back"><span class="ae-chev" aria-hidden="true">‹</span> <span id="ae-back-text">' + _almEsc(_aeT('alm_solar_system')) + '</span></button>' +
      '<div class="ae-top-end">' +
        // Now stands under the date it corrects, lit, whenever the view is
        // away from now (after Next eclipse it sat at the end of a row of
        // look-alike buttons, easy to miss).
        '<div class="ae-when-col" id="ae-when-col">' +
          '<div class="ae-when" id="ae-when"></div>' +
          '<button type="button" class="ae-btn ae-now" id="ae-now" hidden>' + _almEsc(_aeT('alm_now')) + '</button>' +
        '</div>' +
        // The round tools stand in a column, so the date keeps its one line.
        '<div class="ae-tools">' +
          '<button type="button" class="ae-btn ae-round ae-gear" id="ae-gear" aria-expanded="false" aria-controls="ae-set"' +
            ' aria-label="' + _almEsc(gearLabel) + '" title="' + _almEsc(gearLabel) + '">' +
            (typeof _gearSvg === 'string' ? _gearSvg : '⚙') + '</button>' +
          '<button type="button" class="ae-btn ae-round" id="ae-locate" aria-pressed="false"' +
            ' aria-label="' + _almEsc(locateLabel) + '" title="' + _almEsc(locateLabel) + '">' + AE_LOCATE_SVG + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="ae-set" id="ae-set" role="group" aria-labelledby="ae-set-title" hidden></div>' +
    '<div class="ae-status" id="ae-status" aria-live="polite"></div>' +
    '<div class="ae-bottom">' +
      '<div class="ae-hint" id="ae-hint">' + _almEsc(_aeT('alm_earth_hint')) + '</div>' +
      '<div class="ae-card" id="ae-card" hidden></div>' +
      '<div class="ae-orient" id="ae-orient" hidden>' + _almEsc(_aeT('alm_moon_north_up')) + '</div>' +
      '<div class="ae-orient" id="ae-sunnote" hidden></div>' +
      '<div class="ae-row" role="group" id="ae-views">' +
        // Outward from home: the Earth, its satellites, the Moon, the Sun.
        '<button type="button" class="ae-btn" data-ae-view="earth" aria-pressed="true">' + _almEsc(_tp('Earth')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="sats" aria-pressed="false">' + _almEsc(_aeT('alm_earth_view_sats')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="moon" aria-pressed="false">' + _almEsc(_aeT('alm_moon')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="sun" aria-pressed="false">' + _almEsc(_aeT('alm_sun')) + '</button>' +
      '</div>' +
      '<div class="ae-row" role="group" id="ae-time">' + speeds +
        '<button type="button" class="ae-btn" id="ae-eclipse">' + _almEsc(_aeT('alm_earth_next_eclipse')) + '</button>' +
      '</div>' +
      '<div class="ae-note">' +
        '<span id="ae-ask" hidden><span class="ae-ask-text" id="ae-ask-text"></span>' +
          '<button type="button" class="ae-fresh" id="ae-fresh"></button><span aria-hidden="true"> · </span></span>' +
        '<span id="ae-note"></span>' +
      '</div>' +
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
var AE_ECL_LINES = 4;        // lines at every quarter of the Sun covered
var AE_ECL_EDGE = 0.004;     // covered share from which the shadow's edge is drawn
var AE_ECL_LINE_W = 0.08;    // a line's half-width, in quarters
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
  // Where the Moon covers some of the Sun, the map says so, as an eclipse
  // map does: the shadow's edge and a line at every quarter of the Sun
  // covered, on the day side. The dimming alone is the truth, and at a
  // partial eclipse's tenth or third of the Sun it cannot be seen from here.
  '  float cover = 1.0 - light;',
  '  float quarter = abs(fract(cover * ' + AE_ECL_LINES.toFixed(1) + ' + 0.5) - 0.5);',
  '  float contour = step(' + AE_ECL_EDGE.toFixed(3) + ', cover) * (1.0 - smoothstep(0.0, ' + AE_ECL_LINE_W.toFixed(2) + ', quarter));',
  '  col = mix(col, vec3(1.0, 0.72, 0.35), contour * 0.65 * smoothstep(-0.05, 0.1, mu));',
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
  '  gl_FragColor = vec4(vec3(0.32, 0.58, 1.0) * edge * lit * 0.8, 0.0);',
  '}'
].join('\n');

// The Moon's light: app.js _moonLunarL, _moonLunarLambert and _moonDisplay,
// the model every 2D Moon is drawn with, in GLSL from the same constants.
function _aeGlslNum(x) { return x.toExponential(6); }
var AE_GLSL_MOONLIGHT = [
  'float aeLunarL(float cosA) {',
  '  float a = degrees(acos(clamp(cosA, -1.0, 1.0)));',
  '  return clamp(' + _aeGlslNum(_MOON_LUNAR_L[0]) + ' + a * (' + _aeGlslNum(_MOON_LUNAR_L[1]) + ' + a * (' +
    _aeGlslNum(_MOON_LUNAR_L[2]) + ' + a * ' + _aeGlslNum(_MOON_LUNAR_L[3]) + ')), 0.0, 1.0);',
  '}',
  'float aeLunarLambert(float mu0, float mu, float L) {',
  '  if (mu0 <= 0.0) return 0.0;',
  '  return (2.0 * L * mu0 / (mu0 + max(mu, 0.0)) + (1.0 - L) * mu0) * smoothstep(0.0, ' + _aeGlslNum(_MOON_ROUGH_MU) + ', mu0);',
  '}',
  'vec3 aeMoonDisplay(vec3 lin) { return pow(max(lin, vec3(0.0)), vec3(' + _aeGlslNum(1 / _MOON_DISPLAY_GAMMA) + ')); }'
].join('\n');

// The Moon: the 2D Moons' picture (app.js _moonSpriteCanvas) in GLSL, from
// the same constants: the map toned as they tone it, sunlight by lunar-
// Lambert, earthshine (app.js _moonEarthshine, set each frame for the
// Earth's phase) over the hemisphere facing the Earth, encoded for the
// screen, sunlight a touch warm and earthshine cool. Seen from the Earth the
// hero disc and this Moon are the same pixels (the handoff between them is
// tests/test_moon_handoff_live.py). The Earth's shadow adds what the 2D Moons
// do not draw: an eclipse, with the dim copper light the Earth's atmosphere
// bends into it. Until its map is in (or if it never comes) the Moon is the
// 2D Moons' plain grey, so it still shows its phase instead of black on black.
// The umbra's copper, linear: (0.62, 0.24, 0.10) x 0.75 on the screen.
var AE_MOON_UMBRA_LIN = [0.62, 0.24, 0.10].map(function (c) { return Math.pow(0.75 * c, _MOON_DISPLAY_GAMMA); });
var AE_BYTE = 255;
var AE_MOON_FRAG = [
  'precision highp float;',
  'uniform sampler2D moonMap; uniform float moonMapped;',
  'uniform vec3 sunPos; uniform float sunR; uniform float earthR; uniform float earthshine;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_OVERLAP,
  AE_GLSL_MOONLIGHT,
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  vec3 L = normalize(sunPos - vWorld);',
  '  vec3 V = normalize(cameraPosition - vWorld);',
  '  vec3 E = normalize(-vWorld);',
  '  float mu = dot(N, V);',
  '  float light = aeSunlight(vWorld, sunPos, sunR, vec3(0.0), earthR);',
  '  float toned = min(1.0, ' + _aeGlslNum(_MOON_ALBEDO_LIFT / AE_BYTE) + ' + ' + _aeGlslNum(_MOON_ALBEDO_GAIN) + ' * texture2D(moonMap, vUv).r);',
  '  float albedo = mix(' + _aeGlslNum(_MOON_PLAIN_GREY / AE_BYTE) + ', toned, moonMapped);',
  '  float sun = aeLunarLambert(dot(N, L), mu, aeLunarL(dot(L, V)));',
  // Earthshine as the 2D Moons light it: seen from the Earth, even across
  // the disc (lunar-Lambert with the light behind the eye is 1 everywhere).
  '  float mu0e = dot(N, E), Le = aeLunarL(dot(E, V));',
  '  float es = mu0e > 0.0 ? earthshine * (2.0 * Le * mu0e / (mu0e + max(mu, 0.0)) + (1.0 - Le) * mu0e) : 0.0;',
  '  float lit = sun * light;',
  '  vec3 umbra = vec3(' + AE_MOON_UMBRA_LIN.map(_aeGlslNum).join(', ') + ');',
  '  vec3 lin = vec3(lit + es) + umbra * sun * (1.0 - light);',
  '  float warm = lit / max(lit + es, 1e-6);',
  '  vec3 tint = vec3(' + _aeGlslNum(_MOON_TINT_R[0]) + ' + ' + _aeGlslNum(_MOON_TINT_R[1]) + ' * warm, 1.0, ' +
    _aeGlslNum(_MOON_TINT_B[0]) + ' + ' + _aeGlslNum(_MOON_TINT_B[1]) + ' * warm);',
  '  gl_FragColor = vec4(min(vec3(1.0), albedo * aeMoonDisplay(lin) * tint), 1.0);',
  '}'
].join('\n');

// Hash noise for the Sun's surface and corona (no texture): smooth value
// noise in the plane, and cellular noise (the nearest and second-nearest of
// a jittered lattice's points, and a value for the nearest cell).
var AE_GLSL_NOISE = [
  'vec3 aeHash3(vec3 p) {',
  '  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));',
  '  return fract(sin(p) * 43758.5453);',
  '}',
  'vec3 aeCells(vec3 p) {',
  '  vec3 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0, id = 0.0;',
  '  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {',
  '    vec3 o = vec3(float(x), float(y), float(z)), h = aeHash3(i + o);',
  '    vec3 q = o + h - f; float d = dot(q, q);',
  '    if (d < d1) { d2 = d1; d1 = d; id = h.x; } else if (d < d2) { d2 = d; }',
  '  }',
  '  return vec3(sqrt(d1), sqrt(d2), id);',
  '}',
  'float aeNoise2(vec2 p) {',
  '  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);',
  '  float a = fract(sin(dot(i, vec2(12.9898, 78.233))) * 43758.5453);',
  '  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(12.9898, 78.233))) * 43758.5453);',
  '  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(12.9898, 78.233))) * 43758.5453);',
  '  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(12.9898, 78.233))) * 43758.5453);',
  '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
  '}'
].join('\n');

// The limb-darkening polynomials (SUN_LIMB_POLY, almanac-orrery.js) as one
// GLSL function, by Horner's rule.
function _aeLimbGlsl() {
  var k = SUN_LIMB_POLY[0].length - 1;
  var coef = function (j) { return 'vec3(' + SUN_LIMB_POLY.map(function (ch) { return _aeGlslNum(ch[j]); }).join(', ') + ')'; };
  var expr = coef(k);
  while (k-- > 0) expr = coef(k) + ' + mu * (' + expr + ')';
  return 'vec3 aeLimb(float mu) { return ' + expr + '; }';
}

// ── Sunspots: illustrative spots, the real cycle ──
// No one can say offline where a spot will be, so the spots are made up, but
// made up by the Sun's own rules, and the same date always shows the same Sun:
//   - how many: the sunspot number of the date's place in the solar cycle,
//     from each cycle's minimum and peak (SILSO, sunspot number v2, cycles
//     1 to 25) on one cycle shape; before 1755 and after Cycle 25 the cycles
//     repeat at the mean length and peak, quiet through the Maunder minimum;
//   - where: Sporer's law, each cycle's spots born near 30 degrees and
//     lower as it ages (the butterfly diagram), never near the poles; a pair
//     per group, the follower a little poleward (Joy's law);
//   - how they move: the Sun's differential rotation (Snodgrass and Ulrich
//     1990, sidereal), 24.5 days at the equator, slower toward the poles,
//     from the IAU prime meridian (W = 84.176 + 14.1844 d), on the page's clock;
//   - how long: each group grows in a day or two and fades over one to three
//     weeks, born on a day seeded by that day, so time running shows them
//     form, turn and decay.
var AE_CYCLE_MINIMA = [1755.2, 1766.5, 1775.5, 1784.7, 1798.3, 1810.6, 1823.3, 1833.9, 1843.5, 1855.9, 1867.2, 1878.9, 1890.2,
  1902.0, 1913.6, 1923.6, 1933.8, 1944.2, 1954.3, 1964.9, 1976.5, 1986.8, 1996.4, 2008.9, 2019.9];
var AE_CYCLE_PEAKS = [144.1, 193.0, 264.3, 235.3, 82.0, 81.2, 119.2, 244.9, 219.9, 186.2, 234.0, 124.4, 146.5,
  107.1, 175.7, 130.2, 198.6, 218.7, 285.0, 156.6, 232.9, 212.5, 180.3, 116.4, 160.9];
var AE_CYCLE_YEARS = 11.0;           // the mean cycle, for cycles outside the record
var AE_CYCLE_MEAN_PEAK = 179;        // the record's mean peak
var AE_CYCLE_RISE_YEARS = 4.6;       // minimum to peak
var AE_CYCLE_SPAN_YEARS = 16;        // a cycle's spots, from its minimum (cycles overlap)
var AE_MAUNDER = [1645, 1715, 8];    // years, and the peak through them
var AE_SPOT_LAT0_DEG = 30, AE_SPOT_LAT_DECAY_YEARS = 8, AE_SPOT_LAT_SPREAD_DEG = 5;
var AE_SPOT_LAT_RANGE_DEG = [3, 42];
var AE_SPOT_GROUP_PER_R = 0.1;       // groups on the whole Sun per unit of sunspot number
var AE_SPOT_LIFE_DAYS = [4, 26];     // a group's life, shortest to longest
var AE_SPOT_GROW_DAYS = 1.5;
var AE_SPOT_R_DEG = [2.2, 5.5];      // a leader's radius (penumbra), heliographic degrees: drawn larger than life, to be seen
var AE_SPOT_PAIR_DEG = [7, 13];       // leader to follower, in longitude
var AE_SPOT_JOY_DEG = 32;            // Joy's law: a pair's tilt, this times sin(latitude), follower poleward
var AE_SPOT_MAX = 40;                // spots drawn at once (the shader's array)
var AE_SUN_POLE_RA_DEG = 286.13, AE_SUN_POLE_DEC_DEG = 63.87;   // IAU
var AE_SUN_W0_DEG = 84.176, AE_SUN_CARRINGTON_DEG_DAY = 14.1844;
var AE_SNODGRASS = [14.713, -2.396, -1.787];   // deg/day: A + B sin^2 + C sin^4 of latitude

// Cycle j (0 is Cycle 1): its minimum and peak, the record's, else the mean's.
function _aeCycle(j) {
  var n = AE_CYCLE_MINIMA.length, m, peak = AE_CYCLE_MEAN_PEAK;
  if (j < 0) m = AE_CYCLE_MINIMA[0] + j * AE_CYCLE_YEARS;
  else if (j >= n) m = AE_CYCLE_MINIMA[n - 1] + (j - n + 1) * AE_CYCLE_YEARS;
  else { m = AE_CYCLE_MINIMA[j]; peak = AE_CYCLE_PEAKS[j]; }
  if (m + AE_CYCLE_RISE_YEARS > AE_MAUNDER[0] && m < AE_MAUNDER[1]) peak = AE_MAUNDER[2];
  return { min: m, peak: peak };
}
// The cycles with spots in a year: the one it is in, and the one before.
// The index of the cycle a year is in (0 is Cycle 1; negative before it).
function _aeCycleIndex(year) {
  var n = AE_CYCLE_MINIMA.length, j;
  if (year < AE_CYCLE_MINIMA[0]) return Math.floor((year - AE_CYCLE_MINIMA[0]) / AE_CYCLE_YEARS);
  if (year >= AE_CYCLE_MINIMA[n - 1]) return n - 1 + Math.floor((year - AE_CYCLE_MINIMA[n - 1]) / AE_CYCLE_YEARS);
  j = 0;
  while (AE_CYCLE_MINIMA[j + 1] <= year) j++;
  return j;
}
function _aeCyclesNear(year) {
  var j = _aeCycleIndex(year);
  return [_aeCycle(j - 1), _aeCycle(j)];
}
// One cycle's shape, 1 at its peak: (x/tr)^4 e^(4(1 - x/tr)), x years from
// its minimum, its tail eased out across the next minimum (real minima fall
// to a sunspot number of a few).
var AE_CYCLE_TAIL_YEARS = [9, 14];
function _aeCycleShape(x) {
  if (x <= 0 || x > AE_CYCLE_SPAN_YEARS) return 0;
  var u = x / AE_CYCLE_RISE_YEARS, u2 = u * u;
  var tail = Math.max(0, Math.min(1, (x - AE_CYCLE_TAIL_YEARS[0]) / (AE_CYCLE_TAIL_YEARS[1] - AE_CYCLE_TAIL_YEARS[0])));
  return u2 * u2 * Math.exp(4 * (1 - u)) * (1 - tail * tail * (3 - 2 * tail));
}
// The sunspot number at a decimal year, and each cycle's share of it.
function _aeSunspotNumber(year) {
  var cs = _aeCyclesNear(year), total = 0, parts = [];
  for (var i = 0; i < cs.length; i++) {
    var x = year - cs[i].min, r = cs[i].peak * _aeCycleShape(x);
    if (r > 0) { parts.push({ age: x, r: r }); total += r; }
  }
  return { r: total, parts: parts };
}
// The orrery's seeded generator (_lcgRand) from any number: the same day,
// the same spots.
function _aeSeeded(seed) {
  return _lcgRand((Math.floor(seed) % 2147483646 + 2147483646) % 2147483646 + 1);
}
// Sidereal rotation (deg/day) at a heliographic latitude (degrees).
function _aeSunRotation(latDeg) {
  var s2 = Math.pow(Math.sin(latDeg * DEG_TO_RAD), 2);
  return AE_SNODGRASS[0] + AE_SNODGRASS[1] * s2 + AE_SNODGRASS[2] * s2 * s2;
}
var AE_MS_PER_YEAR = 365.25 * MS_PER_DAY;
function _aeDecimalYear(ms) { return 2000 + (ms - Date.UTC(2000, 0, 1, 12)) / AE_MS_PER_YEAR; }
// The groups alive at ms: [{lat, lon (inertial, degrees from the solar
// equator's node), r (degrees), born, life}], each a leader and a follower.
function _aeSunSpots(ms) {
  var day = Math.floor(ms / MS_PER_DAY), out = [];
  for (var d = day - AE_SPOT_LIFE_DAYS[1]; d <= day; d++) {
    var rnd = _aeSeeded(d * 7919 + 13);
    var ssn = _aeSunspotNumber(_aeDecimalYear(d * MS_PER_DAY));
    // Births enough to keep R x AE_SPOT_GROUP_PER_R groups alive at once
    // (lives are min + span x u x u: a quarter of the span on average).
    var rate = ssn.r * AE_SPOT_GROUP_PER_R / (AE_SPOT_LIFE_DAYS[0] + (AE_SPOT_LIFE_DAYS[1] - AE_SPOT_LIFE_DAYS[0]) / 4);
    // Births that day: Poisson by Knuth's product of uniforms.
    var L = Math.exp(-rate), p = rnd(), n = 0;
    while (p > L && n < 12) { p *= rnd(); n++; }
    for (var b = 0; b < n; b++) {
      // Which cycle it belongs to, by each cycle's share that day.
      var pick = rnd() * ssn.r, part = ssn.parts[0];
      for (var c = 0; c < ssn.parts.length; c++) { part = ssn.parts[c]; if ((pick -= part.r) <= 0) break; }
      var u1 = Math.max(rnd(), 1e-9), u2 = rnd();
      var gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      var lat = AE_SPOT_LAT0_DEG * Math.exp(-part.age / AE_SPOT_LAT_DECAY_YEARS) + AE_SPOT_LAT_SPREAD_DEG * gauss;
      lat = Math.max(AE_SPOT_LAT_RANGE_DEG[0], Math.min(AE_SPOT_LAT_RANGE_DEG[1], Math.abs(lat))) * (rnd() < 0.5 ? -1 : 1);
      var born = (d + rnd()) * MS_PER_DAY;
      var life = AE_SPOT_LIFE_DAYS[0] + (AE_SPOT_LIFE_DAYS[1] - AE_SPOT_LIFE_DAYS[0]) * rnd() * rnd();
      var carr = rnd() * 360, size = AE_SPOT_R_DEG[0] + (AE_SPOT_R_DEG[1] - AE_SPOT_R_DEG[0]) * Math.pow(rnd(), 1.5);
      var sep = AE_SPOT_PAIR_DEG[0] + (AE_SPOT_PAIR_DEG[1] - AE_SPOT_PAIR_DEG[0]) * rnd();
      var age = (ms - born) / MS_PER_DAY;
      if (age < 0 || age > life) continue;
      var grow = Math.min(1, age / AE_SPOT_GROW_DAYS) * (1 - age / life);
      // Born at a Carrington longitude, then carried round at its own latitude's rate.
      var bornDays = (born - Date.UTC(2000, 0, 1, 12)) / MS_PER_DAY;
      var lon0 = AE_SUN_W0_DEG + AE_SUN_CARRINGTON_DEG_DAY * bornDays + carr;
      out.push({ lat: lat, lon: (lon0 + _aeSunRotation(lat) * age) % 360, r: size * Math.sqrt(grow), born: born, life: life,
        sep: sep, followerLat: lat + Math.sign(lat) * sep * Math.tan(AE_SPOT_JOY_DEG * Math.abs(Math.sin(lat * DEG_TO_RAD)) * DEG_TO_RAD) });
    }
  }
  return out;
}
// The spots as the shader takes them: unit vectors in the scene's equatorial
// frame and a radius (radians), leaders and followers, the largest first.
var _aeSpotPole = null;
function _aeSpotVectors(ms) {
  if (!_aeSpotPole) {
    var ra = AE_SUN_POLE_RA_DEG * DEG_TO_RAD, dec = AE_SUN_POLE_DEC_DEG * DEG_TO_RAD;
    var P = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    var Q = _aeNorm(_aeCross([0, 0, 1], P));                 // the solar equator's ascending node
    _aeSpotPole = { P: P, Q: Q, R: _aeCross(P, Q) };
  }
  var F = _aeSpotPole, groups = _aeSunSpots(ms), spots = [];
  function vec(latDeg, lonDeg, rDeg) {
    var la = latDeg * DEG_TO_RAD, lo = lonDeg * DEG_TO_RAD, cl = Math.cos(la);
    return [cl * Math.cos(lo) * F.Q[0] + cl * Math.sin(lo) * F.R[0] + Math.sin(la) * F.P[0],
      cl * Math.cos(lo) * F.Q[1] + cl * Math.sin(lo) * F.R[1] + Math.sin(la) * F.P[1],
      cl * Math.cos(lo) * F.Q[2] + cl * Math.sin(lo) * F.R[2] + Math.sin(la) * F.P[2], rDeg * DEG_TO_RAD];
  }
  groups.sort(function (a, b) { return b.r - a.r; });
  for (var i = 0; i < groups.length && spots.length < AE_SPOT_MAX; i++) {
    var g = groups[i];
    if (g.r <= 0) continue;
    spots.push(vec(g.lat, g.lon, g.r));
    // The follower trails (rotation carries spots toward increasing longitude).
    if (spots.length < AE_SPOT_MAX) spots.push(vec(g.followerLat, g.lon - g.sep, g.r * 0.7));
    // Between them, a few small pores, as a group has.
    var rnd = _aeSeeded(g.born / 1000), pores = Math.floor(rnd() * 3);
    for (var k = 0; k < pores && spots.length < AE_SPOT_MAX; k++) {
      var f = 0.3 + 0.4 * rnd();
      spots.push(vec(g.lat + (g.followerLat - g.lat) * f + (rnd() - 0.5) * 2, g.lon - g.sep * f, g.r * (0.25 + 0.2 * rnd())));
    }
  }
  return spots;
}

// Into the Sun's shader: again whenever the shown time has moved on by more
// than a spot turns in a fraction of a pixel (a few minutes), so real time
// costs nothing and an hour a second turns them smoothly.
var AE_SPOT_STEP_MS = 5 * 60000;
function _aeUpdateSpots(S, ms) {
  if (S.spotsAt != null && Math.abs(ms - S.spotsAt) < AE_SPOT_STEP_MS) return;
  S.spotsAt = ms;
  var v = _aeSpotVectors(ms), u = S.sunSpots.value;
  u.fill(0);
  for (var i = 0; i < v.length; i++) u.set(v[i], i * 4);
}

// The photosphere, as a filtered camera sees it: limb darkening in each
// colour (the same as the sky's Sun), through a soft exposure, so the centre
// burns yellow-white and the limb falls to deep orange. Over it the
// granulation: bright polygonal cells parted by dark lanes, each cell its own
// brightness, faded where a cell would be smaller than a pixel (so it never
// shimmers) and toward the limb. It turns over on the page's clock: still at
// real time, boiling at an hour a second.
var AE_SUN_FRAG = [
  'precision highp float;',
  'uniform float fade; uniform float uT;',
  'uniform vec4 uSpots[' + AE_SPOT_MAX + '];',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_NOISE,
  _aeLimbGlsl(),
  'void main() {',
  '  vec3 n = normalize(vNormal);',
  '  float mu = max(dot(n, normalize(cameraPosition - vWorld)), 0.0);',
  '  vec3 q = n * ' + AE_GRANULES_PER_RADIUS.toFixed(1) + ' + vec3(0.0, 0.0, uT * 0.37);',
  '  vec3 c = aeCells(q);',
  '  float lane = smoothstep(0.0, 0.25, c.y - c.x);',
  '  float cell = lane * (1.2 - 0.9 * c.x) * (0.8 + 0.4 * c.z) - 0.6;',
  '  float fine = clamp(1.6 - 0.9 * length(fwidth(q)), 0.0, 1.0);',
  // The spots: a dark umbra in a grey penumbra, its edge frayed by noise;
  // round them the faculae, bright only toward the limb (as they are seen).
  '  float spot = 1.0, fac = 0.0, quiet = 1.0;',
  '  for (int i = 0; i < ' + AE_SPOT_MAX + '; i++) {',
  '    vec4 s = uSpots[i];',
  '    if (s.w <= 0.0) continue;',
  '    float d = length(n - s.xyz) / s.w;',
  '    if (d > 3.2) continue;',
  '    float fray = 0.12 * (aeNoise2(vec2(atan(n.y - s.y, n.x - s.x) * 3.0, float(i))) - 0.5);',
  '    float pen = 1.0 - smoothstep(0.85, 1.0, d + fray);',
  '    float umb = 1.0 - smoothstep(0.32, 0.42, d + fray);',
  '    spot = min(spot, 1.0 - 0.5 * pen - 0.42 * umb);',
  '    quiet = min(quiet, 1.0 - pen);',
  '    fac = max(fac, (1.0 - smoothstep(1.2, 3.2, d)) * (1.0 - pen));',
  '  }',
  '  float gran = 1.0 + ' + AE_GRANULE_CONTRAST.toFixed(2) + ' * fine * sqrt(mu) * cell * (0.3 + 0.7 * quiet);',
  '  gran *= spot * (1.0 + 0.9 * fac * pow(1.0 - mu, 1.5));',
  '  vec3 e = vec3(' + AE_SUN_EXPOSURE.map(_aeGlslNum).join(', ') + ') * aeLimb(mu) * gran;',
  '  gl_FragColor = vec4(1.0 - exp(-e), fade);',
  '}'
].join('\n');

// The light round the Sun, the inside of a wider shell added over the sky:
// each pixel asks how near its line of sight passes the Sun's centre, in the
// disc's radii (r), so it is round from anywhere. Nothing over the disc; off
// it, a warm bloom close in, then the pearl corona falling off with r,
// streaming out where noise round the limb says, most along the solar
// equator; and a few faint prominences, pink, standing off the limb.
var AE_SUN_GLOW_FRAG = [
  'precision highp float;',
  'uniform vec3 center; uniform float radius; uniform float fade; uniform float uT;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_NOISE,
  'void main() {',
  '  vec3 ray = normalize(vWorld - cameraPosition);',
  '  vec3 toC = center - cameraPosition;',
  '  float r = length(cross(ray, toC)) / radius;',
  '  float edge = ' + AE_SUN_GLOW_SCALE.toFixed(1) + ';',
  '  if (r > edge || r < 0.98 || dot(ray, toC) < 0.0) discard;',
  // Round the limb: a direction (cos, sin) in the plane of the sky, so the
  // noise has no seam, and its height above the solar (ecliptic) equator.
  '  vec3 off = ray * dot(ray, toC) - toC;',
  '  vec3 side = normalize(cross(toC, vec3(0.0, 0.0, 1.0)) + vec3(1e-6));',
  '  vec2 dir = normalize(vec2(dot(off, side), dot(off, normalize(cross(side, toC)))));',
  '  float fall = 1.0 - r / edge;',
  '  float bloom = 0.5 / (1.0 + 6.0 * (r - 1.0) * (r - 1.0)) * smoothstep(0.98, 1.0, r);',
  '  float streak = aeNoise2(dir * 2.2 + 7.0) * 0.65 + aeNoise2(dir * 6.0 + 3.0) * 0.35;',
  '  float corona = step(1.0, r) * 0.45 * pow(r, -7.0) + 0.3 * pow(r, -2.5) * mix(0.25, 1.0, streak) * mix(1.0, 0.4, dir.y * dir.y);',
  '  float h = aeNoise2(dir * 9.0 + vec2(floor(uT * 0.05), 1.3));',
  '  float prom = smoothstep(0.78, 0.92, h) * (1.0 - smoothstep(1.0, 1.0 + 0.05 * h, r)) * smoothstep(1.0, 1.006, r);',
  '  vec3 col = vec3(1.0, 0.72, 0.42) * bloom + vec3(1.0, 0.95, 0.9) * corona + vec3(1.0, 0.38, 0.45) * prom * 0.6;',
  '  gl_FragColor = vec4(col * fall * fade, 0.0);',
  '}'
].join('\n');

// Points with their own colour, alpha and size: satellites and stars.
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
  'uniform float glow; uniform float fade;',
  'varying vec3 vColor; varying float vAlpha;',
  'void main() {',
  '  vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;',
  '  if (r > 1.0) discard;',
  '  float a = glow > 0.5 ? pow(1.0 - r, 2.2) : 1.0 - smoothstep(0.65, 1.0, r);',
  '  gl_FragColor = vec4(vColor, vAlpha * a * fade);',
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
    uniforms: { dpr: { value: dpr }, glow: { value: glow ? 1 : 0 }, fade: _aeFadeU },
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

// The background, carried with the camera so the stars sit at infinity.
// J2000; the 0.4 degrees of precession since are below what this view shows.
// The first sky is the 2D Almanac's 518 stars to magnitude 4
// (almanac-sky.js), so the view is never empty; _aeLoadStars swaps in the
// whole Bright Star Catalogue. Both are read through at(i, out): RA and Dec
// in radians, magnitude, B-V.
function _aeStarList() {
  var named = (typeof _STARS !== 'undefined') ? _STARS : [];
  var field = (typeof _SKY_FIELD_STARS !== 'undefined') ? _SKY_FIELD_STARS : [];
  var all = named.concat(field);
  return { count: all.length, at: function (i, out) {
    var s = all[i];
    out.ra = s[0] * AE_HOURS_TO_RAD; out.dec = _aeRad(s[1]); out.mag = s[2];
    out.ci = s.length > 3 ? s[3] : AE_STAR_COLOR_DEFAULT;
  } };
}
// stars-v1.bin as typed-array views over the one buffer; null if the bytes
// are not this format.
function _aeDecodeStars(buf) {
  if (!buf || buf.byteLength < AE_STARS_HEADER_BYTES) return null;
  var head = new Uint16Array(buf.slice(0, AE_STARS_HEADER_BYTES)), n = head[0];
  if (head[1] !== AE_STARS_VERSION || buf.byteLength !== AE_STARS_HEADER_BYTES + AE_STARS_BYTES_EACH * n) return null;
  var ra = new Uint16Array(buf, AE_STARS_HEADER_BYTES, n);
  var dec = new Uint16Array(buf, AE_STARS_HEADER_BYTES + 2 * n, n);
  var mag = new Uint8Array(buf, AE_STARS_HEADER_BYTES + 4 * n, n);
  var bv = new Int8Array(buf, AE_STARS_HEADER_BYTES + 5 * n, n);
  return { count: n, at: function (i, out) {
    out.ra = ra[i] / AE_STARS_U16_STEPS * 2 * Math.PI;
    out.dec = (dec[i] / AE_STARS_U16_MAX - 0.5) * Math.PI;
    out.mag = mag[i] / AE_STARS_MAG_SCALE - AE_STARS_MAG_OFFSET;
    out.ci = bv[i] === AE_STARS_BV_NONE ? AE_STAR_COLOR_DEFAULT : bv[i] / AE_STARS_BV_SCALE;
  } };
}
function _aeStarField(THREE, dpr, stars) {
  var cloud = _aePointCloud(THREE, stars.count, dpr, false, { depthTest: true });
  var s = {};
  for (var i = 0; i < stars.count; i++) {
    stars.at(i, s);
    var warm = _aeClamp((s.ci - AE_STAR_CI_MIN) / AE_STAR_CI_SPAN, 0, 1);
    var col = [0.78 + 0.22 * warm, 0.84 + 0.06 * warm, 1.0 - 0.3 * warm];
    _aeSetPoint(cloud, i, _aeEqVec(s.ra, s.dec, AE_STAR_RADIUS), col,
      _aeClamp(AE_STAR_ALPHA0 - AE_STAR_ALPHA_PER_MAG * s.mag, AE_STAR_ALPHA_MIN, 1),
      Math.max(AE_STAR_SIZE_MIN, AE_STAR_SIZE0 - AE_STAR_SIZE_PER_MAG * s.mag));
  }
  _aeCommitPoints(cloud, stars.count);
  return cloud;
}
// The whole catalogue, fetched with the other Earth assets: one fetch, one
// pass over the bytes, one draw call. A failure keeps the first sky and the
// next open asks again. The old points leave in the frame the new ones come.
function _aeLoadStars(S) {
  if (S.starsLoaded || S.starsLoading) return;
  S.starsLoading = true;
  fetch(AE_STARS_URL).then(function (r) {
    if (!r.ok) throw new Error('stars');
    return r.arrayBuffer();
  }).then(function (buf) {
    var stars = _aeDecodeStars(buf);
    if (!stars || _ae.gl !== S) throw new Error('stars');
    var old = S.starCloud;
    S.starCloud = _aeStarField(S.THREE, S.dpr, stars);
    S.sky.add(S.starCloud);
    S.sky.remove(old);
    old.geometry.dispose(); old.material.dispose();
    S.starsLoaded = true;
    _ae.dirty = true;
    _aeKick();
  }).catch(function () {}).then(function () { S.starsLoading = false; });
}

// Light added over what is behind it, as a glow is, leaving the canvas's
// alpha alone: over the page (the Moon still in the hero's place) it is
// light on the page, not a dark patch where the glow is faint.
function _aeAddLight(m) {
  m.blending = AE_THREE_CUSTOM_BLENDING;
  m.blendSrc = m.blendDst = AE_THREE_ONE_FACTOR;
  m.blendSrcAlpha = AE_THREE_ZERO_FACTOR; m.blendDstAlpha = AE_THREE_ONE_FACTOR;
  return m;
}

// Build the three.js scene. Returns null when WebGL is not available. The
// canvas is see-through (the view's own black is behind it), so the Moon
// can stand over the page in the hero's place before the view grows.
function _aeBuildGl(THREE, canvas) {
  var renderer, dpr = Math.min(window.devicePixelRatio || 1, AE_MAX_DPR);
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: dpr < AE_MSAA_BELOW_DPR, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
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
    _aeAddLight(new THREE.ShaderMaterial({
      uniforms: { sunPos: shared.sunPos }, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_ATMO_FRAG,
      side: THREE.BackSide, transparent: true, depthWrite: false
    })));
  scene.add(atmo);

  var moonGeo = new THREE.SphereGeometry(AE_MOON_RADIUS_RE, AE_MOON_SEGMENTS[0], AE_MOON_SEGMENTS[1]);
  moonGeo.rotateX(Math.PI / 2);
  var moonUni = {
    moonMap: { value: null }, moonMapped: { value: 0 },
    sunPos: shared.sunPos, sunR: shared.sunR, earthR: { value: AE_SHADOW_ENLARGE },
    earthshine: { value: 0 }
  };
  var moon = new THREE.Mesh(moonGeo, new THREE.ShaderMaterial({
    uniforms: moonUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_MOON_FRAG
  }));
  moon.matrixAutoUpdate = false;
  scene.add(moon);

  var sky = new THREE.Group();
  var starCloud = _aeStarField(THREE, dpr, _aeStarList());
  sky.add(starCloud);
  scene.add(sky);

  var sun = new THREE.Group();
  var sunT = { value: 0 };   // the granulation's time (_aeUpdate)
  var sunSpots = { value: new Float32Array(AE_SPOT_MAX * 4) };   // the spots, four floats each (_aeUpdateSpots)
  sun.add(new THREE.Mesh(
    new THREE.SphereGeometry(AE_SUN_SHOW_R, AE_SUN_SEGMENTS[0], AE_SUN_SEGMENTS[1]),
    new THREE.ShaderMaterial({ uniforms: { fade: _aeFadeU, uT: sunT, uSpots: sunSpots }, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_SUN_FRAG, transparent: true })));
  var sunGlowUni = { center: { value: new THREE.Vector3() }, radius: { value: AE_SUN_SHOW_R }, fade: _aeFadeU, uT: sunT };
  sun.add(new THREE.Mesh(
    new THREE.SphereGeometry(AE_SUN_SHOW_R * AE_SUN_GLOW_SCALE, AE_SUN_SEGMENTS[0], AE_SUN_SEGMENTS[1]),
    _aeAddLight(new THREE.ShaderMaterial({
      uniforms: sunGlowUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_SUN_GLOW_FRAG,
      side: THREE.BackSide, transparent: true, depthWrite: false
    }))));
  scene.add(sun);

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
    sky: sky, starCloud: starCloud, starsLoaded: false, starsLoading: false, sun: sun, sunGlowUni: sunGlowUni, sunT: sunT, sunSpots: sunSpots, spotsAt: null, moonPath: moonPath, moonPathCount: moonPathCount,
    gpsRings: gpsRings, issRing: issRing, sats: sats,
    basis: new THREE.Matrix4(), vx: new THREE.Vector3(), vy: new THREE.Vector3(), vz: new THREE.Vector3(),
    aniso: Math.min(AE_ANISOTROPY, renderer.capabilities.getMaxAnisotropy()),
    maps: {}, mapFailed: {}               // by URL: the load under way or done, and what failed
  };
}

// ── The maps ──
// The day map is the view: without it the lit side is black, so the view
// waits for it, and when it fails gives the GPU back and says so (the next
// open starts over). The city lights and the Moon's face are drawn without
// when they fail (no lights; the Moon plain grey), the note says so, and the
// next open asks for them again.
function _aeLoadMap(S, uni, url, format, load) {
  if (!S.maps[url]) {
    S.maps[url] = (load ? load() : _aeLoadTexture(S.THREE, url)).then(function (tx) {
      tx.anisotropy = S.aniso;
      if (format) tx.format = format;
      if (uni.value) uni.value.dispose();   // a map it replaces (the Moon's 1024 one)
      uni.value = tx;
      return true;
    }, function () {
      delete S.maps[url];
      return false;
    }).then(function (ok) {
      S.mapFailed[url] = !ok;
      _ae.dirty = true;
      _aeKick();
      // Ready behind the page, a map that comes later is uploaded now too.
      if (ok && _ae.ready) _aeWarm(S);
      return ok;
    });
  }
  return S.maps[url];
}
// The 4096 Moon is the picture the 2D Moons already fetched and decoded
// (app.js _moonLoadHiMap): one fetch, one decode, handed to three as a
// texture of its own kind (the 1024 map's, the build exports no Texture).
function _aeSharedHiMoon(S) {
  if (typeof _moonLoadHiMap !== 'function') return null;
  return function () {
    return _moonLoadHiMap().then(function (img) {
      if (!img || !S.moonUni.moonMap.value) throw new Error('moon map');
      var tx = new S.moonUni.moonMap.value.constructor(img);
      tx.needsUpdate = true;
      return tx;
    });
  };
}
// Loads whatever maps are not in yet; resolves with whether the day map is.
function _aeLoadMaps(S) {
  _aeLoadStars(S);
  _aeLoadMap(S, S.earthUni.nightMap, AE_TEX_NIGHT);
  // The Moon's 1024 map first, then the 4096 one over it (the 2D Moons have
  // usually fetched it by now); without the first the second is not asked.
  _aeLoadMap(S, S.moonUni.moonMap, AE_TEX_MOON).then(function (ok) {
    if (!ok) return;
    S.moonUni.moonMapped.value = 1;
    _aeLoadMap(S, S.moonUni.moonMap, AE_TEX_MOON_HI, AE_THREE_RED_FORMAT, _aeSharedHiMoon(S));
  });
  return _aeLoadMap(S, S.earthUni.dayMap, AE_TEX_DAY);
}

// ── State ──
function _aeNewState(el) {
  return {
    el: el, gl: null, loading: false, failed: false,
    speed: 1, clockRan: false,            // the speed, and whether it ran the page's clock
    target: 'earth', az: 0, el_: 0, dist: AE_FLY_START_DIST,
    fly: null,                            // { start, from:{target pos, dist}, to }
    pointers: {}, pinch: null, drag: null,
    sats: null, satsFailed: false, satsLoading: false,
    satMeta: null,                        // { mode, locked, stale, canChange }: the server's setting
    freshBusy: false, freshFailed: false, // the admin's "Get fresh data", under way / failed
    setOpen: false, setBusy: false, setError: '',   // the gear's panel
    selected: null,                       // { norad, tapMs }: the tapped satellite
    ringsAt: null, issRingAt: null, moonPathAt: null,
    positions: [],                        // projected satellites for tapping
    lastTs: 0, lastRender: 0, lastText: 0, dirty: true,
    raf: 0, idleTimer: 0,
    scene: null
  };
}

// ── The clock ──
// One clock: the Almanac's (almanac.js _almFocus, null for now). The hero
// Moon, the header, the time machine and this view all read it; this view's
// speeds and Next eclipse move it. Closing the view leaves the page at the
// moment the view was showing, and scrubbing the page moves the view's Sun
// and Moon in the same frame (_aeFollowClock).
function _aeDisplayMs() {
  return (typeof _almFocusInstant === 'function') ? _almFocusInstant().getTime() : Date.now();
}
function _aeFocusSet() { return typeof _almFocus !== 'undefined' && !!_almFocus; }
// Live: the clock is now, and running at its own pace.
function _aeIsLive() { return !_aeFocusSet() && !!_ae && _ae.speed === 1; }
// While a faster speed runs the clock, the page's clock text and cards
// follow at this cadence (the view covers them; landing makes them exact).
var AE_PAGE_TICK_MS = 250;
function _aeRunClock(dms) {
  var next = new Date(_aeDisplayMs() + dms);
  if (typeof _almClampInstant === 'function') next = _almClampInstant(next);
  _almFocus = next;
  _ae.clockRan = true;
  if (typeof _almTravelThrottled !== 'function') return;
  _almTravelThrottled('ae-page', AE_PAGE_TICK_MS, function () {
    if (typeof _almScrubClock === 'function') _almScrubClock(next);
    if (typeof _almLiveHeadCards === 'function') _almLiveHeadCards(next);
  });
}
// The clock stopped running (back to real time, or the view closing): the
// whole page lands on the moment, once, exactly.
function _aeLandClock() {
  if (!_ae || !_ae.clockRan) return;
  _ae.clockRan = false;
  _aeSettlePage(new Date(_aeDisplayMs()));
  if (_aeIsOpen && !_ae.hand) _aePauseAlmanac();
}
// The orrery's own clock (its speed slider, a ride) becomes the page's when
// the view opens on it, so the two never disagree.
function _aeAdoptOrreryClock() {
  if (_aeFocusSet() || typeof _orreryClockChosen === 'undefined' || !_orreryClockChosen) return;
  if (typeof _orreryTimeOffset === 'undefined' || !_orreryTimeOffset) return;
  _aeSettlePage(new Date(Date.now() + _orreryTimeOffset));
}
// The page's clock moved (a scrub step, the lever, a settle): this instant
// is drawn now, in the same frame as the page, not at the next idle tick.
function _aeFollowClock() {
  if (!_aeIsOpen || !_ae || !_ae.gl || _ae.clockBusy) return;
  _ae.dirty = true;
  _aeDraw(performance.now());
  _aeUpdateText(_aeDisplayMs());
}

// ── Camera ──
function _aeFitDist(radius) {
  var cam = _ae.gl.camera, aspect = _ae.w && _ae.h ? _ae.w / _ae.h : cam.aspect;
  var half = Math.tan(_aeRad(AE_FOV_DEG) / 2) * Math.min(1, aspect);
  return radius / (half * AE_FIT_FILL);
}
// What the camera can circle: how near and far it may go, and the surface a
// drag's speed is measured from.
var AE_TARGETS = {
  earth: { min: AE_MIN_DIST_EARTH, max: AE_MAX_DIST, surface: 1 },
  moon: { min: AE_MIN_DIST_MOON, max: AE_MAX_DIST, surface: AE_MOON_RADIUS_RE },
  sun: { min: AE_MIN_DIST_SUN, max: AE_MAX_DIST_SUN, surface: AE_SUN_SHOW_R }
};
function _aeClampDist(d) { var t = AE_TARGETS[_ae.target]; return _aeClamp(d, t.min, t.max); }
function _aeTargetPos() {
  if (!_ae.scene || _ae.target === 'earth') return [0, 0, 0];
  return _ae.target === 'moon' ? _ae.scene.moon : _aeSunShown(_ae.scene);
}
// Whose sky the Moon is shown in: the device's place once asked for (the
// crosshair), else the place chosen for the Almanac; null for neither, and
// then the Moon stands celestial north up and the view says so.
function _aeObserver() {
  if (_ae.you) return _ae.you;
  var loc = (typeof _getLocation === 'function') ? _getLocation() : null;
  return loc && loc.stored ? loc : null;
}
// The camera's turn about its line of sight, in degrees from celestial north
// (positive toward east): on the Moon, the parallactic angle at the observer
// (app.js _moonLimbAngles, the same answer the hero disc turns by), so the
// terminator lies as it does in their sky; everywhere else north is up.
function _aeRollDeg(target, ms) {
  var obs = target === 'moon' ? _aeObserver() : null;
  return obs ? _moonLimbAngles(new Date(ms), obs.lat, obs.lon).q : 0;
}
// The camera's up for a line of sight `dir` turned `rollDeg` from celestial
// north toward east. East on the sky, looking along dir, is north x dir.
function _aeViewUp(dir, rollDeg) {
  var d = _aeNorm(dir);
  var n = _aeSub([0, 0, 1], _aeScale(d, d[2]));
  if (_aeLen(n) < 1e-9) return [0, 0, 1];
  n = _aeNorm(n);
  var e = _aeCross(n, d), r = _aeRad(rollDeg);
  return _aeNorm([n[0] * Math.cos(r) + e[0] * Math.sin(r), n[1] * Math.cos(r) + e[1] * Math.sin(r), n[2] * Math.cos(r) + e[2] * Math.sin(r)]);
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
  var from = { pos: _aeTargetPos(), dist: _ae.dist, az: _ae.az, el: _ae.el_, roll: _ae.roll || 0 };
  _ae.target = target;
  if (azel) { _ae.az = azel.az; _ae.el_ = azel.el; }
  var to = { dist: _aeClampDist(dist) };
  if (_aeReduceMotion()) { _ae.dist = to.dist; _ae.fly = null; }
  else {
    // Turn the short way round.
    var daz = ((_ae.az - from.az + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    var ms = _aeFlyMs(from, _aeTargetPos(), to.dist, _ae.az, _ae.el_);
    _ae.fly = { start: performance.now(), ms: ms, from: from, toDist: to.dist, toAz: from.az + daz, toEl: _ae.el_ };
    _ae.az = from.az; _ae.el_ = from.el;
  }
  _aeMarkViews();
  _aeKick();
}
// How long a flight takes: the camera's path, end to end, against the
// nearer of the two distances it stands from what it looks at.
function _aeFlyMs(from, toPos, toDist, toAz, toEl) {
  var a = _aeCameraOffset(from.az, from.el, from.dist), b = _aeCameraOffset(toAz, toEl, toDist);
  var pa = [from.pos[0] + a[0], from.pos[1] + a[1], from.pos[2] + a[2]];
  var pb = [toPos[0] + b[0], toPos[1] + b[1], toPos[2] + b[2]];
  var travel = _aeLen(_aeSub(pb, pa)) / Math.max(1e-6, Math.min(from.dist, toDist));
  return _aeClamp(AE_FLY_MIN_MS + AE_FLY_MS_PER_LOG * Math.log(1 + travel), AE_FLY_MIN_MS, AE_FLY_FAR_MS);
}
// How far along the flight is, eased (1 when there is none).
function _aeFlyEase(now) {
  var f = _ae.fly;
  return f ? _aeEaseInOut(_aeClamp((now - f.start) / f.ms, 0, 1)) : 1;
}
function _aeStepFly(now) {
  var f = _ae.fly;
  if (!f) return false;
  var p = _aeClamp((now - f.start) / f.ms, 0, 1), e = _aeEaseInOut(p);
  _ae.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.toDist) - Math.log(f.from.dist)) * e);
  _ae.az = f.from.az + (f.toAz - f.from.az) * e;
  _ae.el_ = f.from.el + (f.toEl - f.from.el) * e;
  if (p >= 1) _ae.fly = null;
  return true;
}
function _aeFlyTargetPos() {
  var f = _ae.fly, to = _aeTargetPos();
  if (!f) return to;
  var e = _aeFlyEase(performance.now());
  return [f.from.pos[0] + (to[0] - f.from.pos[0]) * e, f.from.pos[1] + (to[1] - f.from.pos[1]) * e, f.from.pos[2] + (to[2] - f.from.pos[2]) * e];
}

// Where the camera stands and how wide it sees, now: the view's own
// (target, turn, distance, a flight between presets), or, while the Moon is
// passing between the hero and the view, a blend of the view's camera and
// the hero's (_aeHandCam).
function _aeViewCam() {
  var tp = _aeFlyTargetPos();
  var roll = _ae.scene ? _aeRollDeg(_ae.target, _ae.scene.ms) : 0;
  if (_ae.fly) roll = _ae.fly.from.roll + _angleDelta(_ae.fly.from.roll, roll) * _aeFlyEase(performance.now());
  return { tp: tp, az: _ae.az, el: _ae.el_, dist: _ae.dist, tanHalf: Math.tan(_aeRad(AE_FOV_DEG) / 2), roll: roll, frame: null };
}
function _aePlaceCamera() {
  var S = _ae.gl, cam = S.camera;
  var c = _aeViewCam();
  if (_ae.hand && _ae.scene) c = _aeHandBlend(_aeHandCam(_ae.scene, _ae.hand), c, _ae.hand.e);
  var tp = c.tp;
  var off = _aeCameraOffset(c.az, c.el, c.dist);
  var pos = [tp[0] + off[0], tp[1] + off[1], tp[2] + off[2]];
  cam.position.set(pos[0], pos[1], pos[2]);
  // Up is the observer's zenith on the Moon, north elsewhere; a flight
  // turns from one to the other on the way.
  _ae.roll = c.roll;
  var up = _aeViewUp(_aeSub(tp, pos), c.roll);
  cam.up.set(up[0], up[1], up[2]);
  cam.lookAt(tp[0], tp[1], tp[2]);
  // The frame the camera fills: the whole view, or a rectangle of it (the
  // hero's, on the way in and out), the rest of the canvas the same camera's
  // view beyond that rectangle's edges.
  cam.fov = _aeDeg(2 * Math.atan(c.tanHalf));
  var f = c.frame;
  if (f && _ae.w && _ae.h) {
    cam.aspect = f.w / f.h;
    cam.setViewOffset(f.w, f.h, -f.x, -f.y, _ae.w, _ae.h);
  } else {
    cam.aspect = _ae.w && _ae.h ? _ae.w / _ae.h : cam.aspect;
    if (cam.view) cam.clearViewOffset();
  }
  // Near plane from the nearest surface, so the Earth's limb never clips
  // and depth precision stays where the eye is.
  var toEarth = _aeLen(pos) - 1;
  var toMoon = _ae.scene ? _aeLen(_aeSub(pos, _ae.scene.moon)) - AE_MOON_RADIUS_RE : Infinity;
  var toSun = _ae.scene ? _aeLen(_aeSub(pos, _aeSunShown(_ae.scene))) - AE_SUN_SHOW_R : Infinity;
  cam.near = Math.max(AE_NEAR_MIN, Math.min(toEarth, toMoon, toSun) * AE_NEAR_FRACTION);
  cam.updateProjectionMatrix();
  S.sky.position.copy(cam.position);
  // An orbit much wider than the screen shows only as arcs through it, a web
  // of straight lines, not a ring: the GPS orbits and the Moon's path fade in
  // as the view widens to hold them.
  var halfView = _aeLen(pos) * c.tanHalf * Math.min(1, _ae.w && _ae.h ? _ae.w / _ae.h : cam.aspect);
  _aeFadeLine(S.gpsRings, AE_GPS_RING_ALPHA, halfView / AE_GPS_SHELL_RE);
  _aeFadeLine(S.moonPath, AE_MOON_PATH_ALPHA, halfView / _aeLen(_ae.scene ? _ae.scene.moon : [AE_MOON_MEAN_DIST_KM / AE_EARTH_RADIUS_KM, 0, 0]));
}
// Opacity from how much of an orbit the view holds (half-view over radius),
// and from how far the view has come in from the hero (_aeFadeU).
function _aeFadeLine(line, alpha, held) {
  var out = _aeClamp((held - AE_ORBIT_FADE_FROM) / (AE_ORBIT_FADE_TO - AE_ORBIT_FADE_FROM), 0, 1) * _aeFadeU.value;
  line.material.opacity = alpha * out;
  line.visible = out > 0;
}

// ── The hero's Moon and this one ──
// The hero disc is the Moon as seen from the Earth, lunar north turned to
// the observer's zenith (or celestial north), 200 CSS pixels wide. This
// view's Moon is the same body in the same light (one clock, one ephemeris,
// one shading model), so seen from the same place, framed the same way, it
// is the same picture: the camera stands just above the Earth on the line to
// the Moon, its frame the hero's rectangle, its field just wide enough that
// the Moon fills the disc. Tapping the hero (or starting to drag it) swaps
// the disc for this camera's first frame, then the camera flies out to the
// Moon as the frame opens to the whole view, the page dimming behind and the
// controls coming up. Leaving, it flies back to the Earth's side and the
// frame closes onto the hero, now showing whatever moment the view left.
var AE_HAND_MS = 420;
var AE_HAND_XFADE_MS = 200;             // reduced motion: a cross-fade instead
var AE_HAND_EARTH_GAP = 1.5;            // the hero's camera, in Earth radii from its centre: over the air and the ISS
var AE_HAND_UI_FROM = 0.55;             // the controls come up over the last part of the way
var AE_HERO_SEL = '#almanac-head .almanac-moon-open';
var AE_FOCUS_MS = 1500;                 // ms the uncovered page has to take focus back
// The hero's rectangle in the view's coordinates, or null when it is not
// on screen (scrolled away, or the head is beyond range).
function _aeHeroFrame() {
  var hero = document.querySelector(AE_HERO_SEL);
  if (!hero || !hero.offsetWidth || !_ae || !_ae.el) return null;
  var r = hero.getBoundingClientRect(), v = _ae.el.getBoundingClientRect();
  if (r.bottom <= v.top || r.top >= v.bottom || !v.width) return null;
  return { x: r.left - v.left, y: r.top - v.top, w: r.width, h: r.height };
}
// The hero's camera at a scene, for `hand` (its frame, and any turn a drag
// has given the Moon since the swap).
function _aeHandCam(sc, hand) {
  var dist = _aeLen(sc.moon) - AE_HAND_EARTH_GAP;
  var azel = _aeAzElOf(_aeScale(sc.moon, -1));
  var f = hand.frame;
  // The disc fills the frame's width: its radius is half of it.
  var tanTheta = Math.tan(Math.asin(AE_MOON_RADIUS_RE / dist));
  return {
    tp: sc.moon, az: azel.az + hand.daz, el: _aeClamp(azel.el + hand.del, -AE_MAX_ELEVATION, AE_MAX_ELEVATION),
    dist: dist, tanHalf: tanTheta * f.h / f.w, roll: _aeRollDeg('moon', sc.ms), frame: f
  };
}
function _aeLerp(a, b, e) { return a + (b - a) * e; }
function _aeLogLerp(a, b, e) { return Math.exp(_aeLerp(Math.log(a), Math.log(b), e)); }
// The camera `e` of the way from a (the hero's) to b (the view's).
function _aeHandBlend(a, b, e) {
  if (e <= 0) return a;
  var full = { x: 0, y: 0, w: _ae.w, h: _ae.h };
  var fa = a.frame, fb = b.frame || full;
  return {
    tp: [_aeLerp(a.tp[0], b.tp[0], e), _aeLerp(a.tp[1], b.tp[1], e), _aeLerp(a.tp[2], b.tp[2], e)],
    az: a.az + _aeAngleDeltaRad(a.az, b.az) * e,
    el: _aeLerp(a.el, b.el, e),
    dist: _aeLogLerp(a.dist, b.dist, e),
    tanHalf: _aeLogLerp(a.tanHalf, b.tanHalf, e),
    roll: a.roll + _angleDelta(a.roll, b.roll) * e,
    frame: e >= 1 ? b.frame : { x: _aeLerp(fa.x, fb.x, e), y: _aeLerp(fa.y, fb.y, e), w: _aeLerp(fa.w, fb.w, e), h: _aeLerp(fa.h, fb.h, e) }
  };
}
function _aeAngleDeltaRad(a, b) { return ((b - a + 3 * Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }

function _aePreset(name) {
  if (!_ae.gl) return;
  if (name === 'moon') {
    // From the Earth's side: the phase (and any eclipse) as seen from home.
    var azel = _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.moon, -1)) : null;
    _aeFlyTo('moon', _aeFitDist(AE_FIT_MOON), azel);
  } else if (name === 'sun') {
    // From the Earth's side too: the Sun as it stands in our sky, ahead.
    _aeFlyTo('sun', _aeFitDist(AE_FIT_SUN), _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.sun, -1)) : null);
  } else {
    // Back from the Sun, arrive over the day side, the Sun behind the camera.
    var fromSun = _ae.target === 'sun' && _ae.scene ? _aeAzElOf(_ae.scene.sun) : null;
    _aeFlyTo('earth', _aeFitDist(name === 'sats' ? AE_FIT_SATS : AE_FIT_EARTH), fromSun);
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
// Asked for at every open. The server answers at once with what it has, and
// with what "Satellite data from the internet" is set to. Set to
// Automatically, a stale answer has the server fetch fresher elements behind
// it and say so (refreshing): then the view asks once more when that fetch
// has had time to land, so an open view gets them too. Set to Ask first, a
// stale answer is offered to a viewer who may fetch (Get fresh data). A
// failed load keeps whatever was drawn before, says so if nothing was, and
// is asked for again at the next open.
//
// Through app.js's authedFetch when it is there, so an admin signed in by
// token is known as one (can_change) and may fetch and change the setting.
function _aeFetch(url, opts) {
  return (typeof authedFetch === 'function' ? authedFetch : fetch)(url, opts);
}
function _aeJson(r) {
  if (r.ok) return r.json();
  var err = new Error('status ' + r.status);
  err.status = r.status;
  throw err;
}
function _aePost(url, body) {
  return _aeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(_aeJson);
}
function _aeDenied(err) { return !!err && (err.status === AE_HTTP_UNAUTHORIZED || err.status === AE_HTTP_FORBIDDEN); }

function _aeLoadSats(again) {
  if (_ae.satsLoading) return;
  _ae.satsLoading = true;
  Promise.all([_aeLoadSgp4(), _aeFetch(AE_SATS_URL).then(_aeJson)]).then(function (res) {
    _aeTakeSats(res[0], res[1], again);
  }).catch(function () {
    _ae.satsFailed = !_ae.sats;
  }).then(function () {
    _ae.satsLoading = false;
    _ae.dirty = true;
    _aeKick();
  });
}
// An answer from the server, a GET's or Get fresh data's: the elements
// (rebuilt only when they changed), the setting as it stands, and one more
// ask when a fetch is under way.
function _aeTakeSats(lib, data, again) {
  if (!_ae.sats || _ae.sats.fetched !== data.fetched) _aeSetSats(lib, data);
  _ae.satsFailed = false;
  _ae.satMeta = { mode: data.mode, locked: data.locked || null, stale: !!data.stale, canChange: !!data.can_change };
  _aeRenderSettings();
  if (data.refreshing && !again) setTimeout(function () { _aeLoadSats(true); }, AE_SATS_REFETCH_MS);
}

// Ask first, stale data, and a viewer who may fetch: the note offers to.
function _aeAsking() {
  var m = _ae.satMeta;
  return !!(m && m.mode === 'ask' && m.stale && m.canChange);
}
// Get fresh data: one fetch on the server, waited for, and the view redrawn
// from its answer. Refused (the viewer is no longer an admin), the offer goes.
function _aeGetFresh() {
  if (_ae.freshBusy) return;
  _ae.freshBusy = true;
  _ae.freshFailed = false;
  _aeRefreshText();
  Promise.all([_aeLoadSgp4(), _aePost(AE_SATS_REFRESH_URL)]).then(function (res) {
    _aeTakeSats(res[0], res[1], false);
  }).catch(function (err) {
    if (_aeDenied(err) && _ae.satMeta) _ae.satMeta.canChange = false;
    else _ae.freshFailed = true;
  }).then(function () {
    _ae.freshBusy = false;
    _aeRefreshText();
    _ae.dirty = true;
    _aeKick();
  });
}

// ── The gear: "Satellite data from the internet" ──
// Everyone sees the choice in force; an admin may change it, unless the
// environment has (ZIMI_SATELLITE_UPDATES, or ZIMI_OFFLINE forcing Never),
// and then the panel says which.
function _aeShowSettings(on) {
  _ae.setOpen = !!on;
  _ae.setError = '';
  var panel = _aeById('ae-set'), gear = _aeById('ae-gear');
  if (panel) panel.hidden = !on;
  if (gear) gear.setAttribute('aria-expanded', String(!!on));
  _aeRenderSettings();
}
function _aeSettingsWhy(m) {
  if (m.locked === 'offline') return _aeT('alm_earth_sat_offline');
  if (m.locked === 'env') return _aeT('env_controlled', { v: AE_SAT_ENV });
  if (!m.canChange) return _aeT('alm_earth_sat_admin_only');
  return _ae.setError;
}
function _aeRenderSettings() {
  var panel = _aeById('ae-set');
  if (!panel || !_ae.setOpen) return;
  var m = _ae.satMeta || {};
  var editable = !!m.canChange && !m.locked && !_ae.setBusy;
  var html = '<h3 id="ae-set-title">' + _almEsc(_aeT('alm_earth_sat_setting')) + '</h3>' +
    '<div role="radiogroup" aria-labelledby="ae-set-title">';
  AE_SAT_MODES.forEach(function (mode) {
    var key = AE_SAT_MODE_KEY + mode;
    html += '<label class="ae-set-choice' + (editable ? '' : ' ae-off') + '">' +
      '<input type="radio" name="ae-sat-mode" value="' + mode + '"' +
        (m.mode === mode ? ' checked' : '') + (editable ? '' : ' disabled') + '>' +
      '<span><b>' + _almEsc(_aeT(key)) + '</b><small>' + _almEsc(_aeT(key + '_hint')) + '</small></span></label>';
  });
  html += '</div>';
  var why = _aeSettingsWhy(m);
  if (why) html += '<p class="ae-set-why">' + _almEsc(why) + '</p>';
  panel.innerHTML = html;
}
// An admin's choice, saved on the server; then the view asks again, since
// the choice changes what a stale answer brings (Automatically fetches
// behind it, Ask first offers to).
function _aeSetMode(mode) {
  var m = _ae.satMeta;
  if (!m || !m.canChange || m.locked || _ae.setBusy || mode === m.mode) return;
  _ae.setBusy = true;
  _ae.setError = '';
  _aePost(AE_SATS_SETTING_URL, { mode: mode }).then(function (d) {
    m.mode = d.mode;
    m.locked = d.locked || null;
  }).catch(function (err) {
    if (_aeDenied(err)) m.canChange = false;
    _ae.setError = _aeT('save_failed');
  }).then(function () {
    _ae.setBusy = false;
    _aeRenderSettings();
    var checked = _aeById('ae-set');
    checked = checked && checked.querySelector && checked.querySelector('input:checked');
    if (checked) checked.focus({ preventScroll: true });
    _aeLoadSats();
  });
}
function _aeSetSats(lib, data) {
  var list = [];
  (data.gps || []).forEach(function (omm) {
    try { var rec = lib.json2satrec(omm); if (!rec.error) list.push({ omm: omm, rec: rec, iss: false }); } catch (e) {}
  });
  if (data.iss) {
    try { var r2 = lib.json2satrec(data.iss); if (!r2.error) list.push({ omm: data.iss, rec: r2, iss: true }); } catch (e) {}
  }
  list = list.slice(0, AE_SAT_CAPACITY);
  list.forEach(function (s) { s.epochMs = _aeSatEpochMs(s.rec); });
  _ae.sats = { lib: lib, list: list, source: data.source || '', fetched: data.fetched };
  _ae.ringsAt = _ae.issRingAt = null;
  // The tapped satellite is kept by its catalogue number, so fresher
  // elements for it keep its card open; one no longer here closes it.
  if (_ae.selected) _aeRenderCard();
}
// The satellite a tap picked, from the elements now drawn, or null.
function _aeSelectedSat() {
  if (!_ae.selected || !_ae.sats) return null;
  for (var i = 0; i < _ae.sats.list.length; i++) {
    if (_ae.sats.list[i].omm.NORAD_CAT_ID === _ae.selected.norad) return _ae.sats.list[i];
  }
  return null;
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
  var issShown = false, selShown = false;
  for (var i = 0; i < sats.list.length; i++) {
    var s = sats.list[i];
    var standing = _aeSatStanding((ms - s.epochMs) / MS_PER_DAY, s.iss);
    s.standing = standing;
    if (standing === 'none') continue;
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
      // Faded beside a faded (approximate) dot. Past that the ring is all
      // that is drawn, and it is right (the orbit's shape and tilt hold), so
      // it is drawn in full: at the faded strength it all but vanished and
      // the note's "orbit only" pointed at nothing.
      S.issRing.material.opacity = (standing === 'approximate' ? AE_ISS_RING_FADED : AE_ISS_RING_ALPHA) * _aeFadeU.value;
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
    if (standing === 'orbit') continue;
    var st = _aeSatAt(s, ms, eqeq);
    if (!st) continue;
    var sel = !!_ae.selected && _ae.selected.norad === s.omm.NORAD_CAT_ID;
    selShown = selShown || sel;
    var color = sel ? AE_SELECTED_COLOR : (s.iss ? AE_ISS_COLOR : AE_GPS_COLOR);
    var alpha = standing === 'approximate' ? AE_ISS_FADED_ALPHA : 1;
    var size = sel ? AE_SAT_SELECTED_PX : (s.iss ? AE_ISS_POINT_PX : AE_SAT_POINT_PX);
    _aeSetPoint(S.sats, count++, st.pos, color, alpha, size);
    _ae.positions.push({ idx: i, pos: st.pos, st: st });
  }
  _aeCommitPoints(S.sats, count);
  if (refreshRings) {
    S.gpsRings.geometry.attributes.position.needsUpdate = true;
    S.gpsRings.geometry.setDrawRange(0, ringN);
    _ae.ringsAt = ms;
  }
  if (!issShown) { S.issRing.geometry.setDrawRange(0, 0); _ae.issRingAt = null; }
  // A card belongs to a dot: when the tapped satellite's dot goes (its data
  // too far from the shown instant), its card goes with it.
  if (_ae.selected && !selShown) { _ae.selected = null; _aeRenderCard(); }
}

// ── Per-frame scene update ──
function _aeUpdateMoonPath(ms) {
  if (_ae.moonPathAt !== null && Math.abs(ms - _ae.moonPathAt) < AE_MOON_PATH_REFRESH_MS) return;
  var S = _ae.gl, arr = S.moonPath.geometry.attributes.position.array;
  var step = AE_MOON_PATH_STEP_HOURS * 3600 * 1000, t0 = ms - AE_MOON_PATH_HALF_DAYS * MS_PER_DAY;
  for (var i = 0; i < S.moonPathCount; i++) {
    var sc = _aeSceneAt(t0 + i * step);
    arr[i * 3] = sc.moon[0]; arr[i * 3 + 1] = sc.moon[1]; arr[i * 3 + 2] = sc.moon[2];
  }
  S.moonPath.geometry.attributes.position.needsUpdate = true;
  S.moonPath.geometry.setDrawRange(0, S.moonPathCount);
  _ae.moonPathAt = ms;
}

// The Moon keeps one face to the Earth, give or take its libration: its pole
// stands 1.54 degrees from the ecliptic's, on the side opposite its orbit's
// pole (Cassini), and the map's longitude l (app.js _moonView, the optical
// libration the hero disc is drawn with) points home, so both show the same
// face turned the same way.
function _aeMoonBasis(sc) {
  var eps = _aeRad(sc.sunEq.nut.eps);
  var v = _moonView(new Date(sc.ms), null, null);
  var I = _aeRad(_MOON_EQUATOR_TILT_DEG), node = _aeRad(v.node);
  var ex = -Math.sin(I) * Math.sin(node), ey = Math.sin(I) * Math.cos(node), ez = Math.cos(I);
  var z = [ex, ey * Math.cos(eps) - ez * Math.sin(eps), ey * Math.sin(eps) + ez * Math.cos(eps)];
  var home = _aeNorm(_aeScale(sc.moon, -1));
  var h = _aeNorm(_aeSub(home, _aeScale(z, _aeDot(home, z))));
  var e = _aeCross(z, h), l = _aeRad(v.l);
  var x = _aeSub(_aeScale(h, Math.cos(l)), _aeScale(e, Math.sin(l)));
  return { x: x, y: _aeCross(z, x), z: z };
}
function _aeOrientMoon(sc) {
  var S = _ae.gl;
  var m = _aeMoonBasis(sc), x = m.x, y = m.y, z = m.z;
  S.vx.set(x[0], x[1], x[2]); S.vy.set(y[0], y[1], y[2]); S.vz.set(z[0], z[1], z[2]);
  S.basis.makeBasis(S.vx, S.vy, S.vz);
  S.basis.setPosition(sc.moon[0], sc.moon[1], sc.moon[2]);
  S.moon.matrix.copy(S.basis);
  S.moon.matrixWorldNeedsUpdate = true;
}

function _aeUpdate(ms) {
  var S = _ae.gl;
  var sc = _aeSceneAt(ms);
  _ae.scene = sc;
  S.earth.rotation.z = sc.gast;
  S.shared.sunPos.value.set(sc.sun[0], sc.sun[1], sc.sun[2]);
  S.earthUni.moonPos.value.set(sc.moon[0], sc.moon[1], sc.moon[2]);
  // The Moon's phase angle, Sun-Moon-Earth, sets the earthshine.
  S.moonUni.earthshine.value = _moonEarthshine(_aeDot(_aeNorm(_aeSub(sc.sun, sc.moon)), _aeNorm(_aeScale(sc.moon, -1))));
  _aeOrientMoon(sc);
  var sd = _aeSunShown(sc);
  S.sun.position.set(sd[0], sd[1], sd[2]);
  S.sunGlowUni.center.value.set(sd[0], sd[1], sd[2]);
  S.sunT.value = (ms / 1000 / AE_GRANULE_LIFE_S) % AE_GRANULE_CYCLE;
  _aeUpdateSpots(S, ms);
  _aeUpdateMoonPath(ms);
  _aeUpdateSats(ms, sc);
  _aePlaceCamera();
}

function _aeResize() {
  if (!_ae || !_ae.gl) return;
  var el = _ae.el, S = _ae.gl;
  var w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  // Kept for the per-frame projections: reading clientWidth there, after the
  // labels' style writes, forced a layout for every label, every frame.
  _ae.w = w; _ae.h = h;
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / h;
  S.camera.updateProjectionMatrix();
  _ae.dirty = true;
  _aeKick();
}

// ── Screen positions (labels, taps) ──
var _aeProjV = null;
function _aeProject(v) {
  var S = _ae.gl;
  if (!_aeProjV) _aeProjV = new S.THREE.Vector3();
  _aeProjV.set(v[0], v[1], v[2]).project(S.camera);
  if (_aeProjV.z > 1 || _aeProjV.z < -1) return null;
  return { x: (_aeProjV.x + 1) / 2 * _ae.w, y: (1 - _aeProjV.y) / 2 * _ae.h };
}
// Is a scene point hidden behind the Earth (a unit sphere, near enough)?
function _aeBehindEarth(p) {
  var c = _ae.gl.camera.position, o = [c.x, c.y, c.z];
  var d = _aeSub(p, o), len = _aeLen(d);
  d = _aeScale(d, 1 / len);
  var b = _aeDot(o, d), cc = _aeDot(o, o) - 1, disc = b * b - cc;
  if (disc < 0) return false;
  var tHit = -b - Math.sqrt(disc);
  return tHit > 0 && tHit < len - 1e-3;
}
// Is a point on the Earth's surface on the side facing the camera?
function _aeFacing(p) {
  var c = _ae.gl.camera.position;
  return _aeDot(p, [c.x - p[0], c.y - p[1], c.z - p[2]]) > 0;
}
// Pin a label beside a scene point, or hide it. The label's own size never
// needs measuring: the second translate is in percent of itself.
function _aePlaceLabel(id, p, show) {
  var el = _aeById(id);
  if (!el) return;
  var s = show && p ? _aeProject(p) : null;
  if (!s || s.x < 0 || s.y < 0 || s.x > _ae.w || s.y > _ae.h) { if (!el.hidden) el.hidden = true; return; }
  if (el.hidden) el.hidden = false;
  // The label hangs toward the middle of the screen, so it never runs off
  // the edge nearest its point.
  var toLeft = s.x > _ae.w / 2;
  el.style.textAlign = toLeft ? 'right' : 'left';
  el.classList.toggle('ae-hang-left', toLeft);   // where a place label's dot goes (.ae-mark)
  el.style.transform = 'translate(' + Math.round(s.x) + 'px,' + Math.round(s.y) + 'px) translate(' +
    (toLeft ? 'calc(-100% - ' + AE_LABEL_DX + 'px)' : AE_LABEL_DX + 'px') + ',-50%)';
}
function _aeSetText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

function _aeUpdateLabels() {
  var sc = _ae.scene;
  if (!sc) return;
  _aePlaceLabel('ae-lbl-moon', sc.moon, !_aeBehindEarth(sc.moon) && _ae.target !== 'moon');
  // The tapped satellite is named by its card and marked by its colour, so
  // only the ISS carries a label of its own.
  var iss = null;
  for (var i = 0; i < _ae.positions.length; i++) {
    var p = _ae.positions[i], s = _ae.sats.list[p.idx];
    if (s.iss) iss = { p: p, s: s };
  }
  var issEl = _aeById('ae-lbl-iss');
  if (iss) {
    var approx = iss.s.standing === 'approximate';
    var html = _almEsc(_aeT('alm_earth_iss_short')) +
      (approx ? '<span class="ae-label-sub">' + _almEsc(_aeT('alm_earth_approx', { date: _aeFmtDate(iss.s.epochMs) })) + '</span>' : '');
    if (issEl._aeHtml !== html) { issEl.innerHTML = html; issEl._aeHtml = html; }
    issEl.classList.toggle('ae-faded', approx);
  }
  _aePlaceLabel('ae-lbl-iss', iss && iss.p.pos, !!iss && !_aeBehindEarth(iss.p.pos));
  // You: only where the device says it is, once the person asked
  // (_aeLocateMe). A guess, from the time zone or a city picked for the
  // Almanac, drew "You" far from anyone (Eric).
  var you = _ae.you ? _aeFixedToScene(_aeGeodeticToFixed(_ae.you.lat, _ae.you.lon), sc.gast) : null;
  _aePlaceLabel('ae-lbl-you', you, !!you && _aeFacing(you) && _ae.target === 'earth');
  var ecl = _ae.eclipse;
  var sh = ecl && ecl.solar && ecl.hit ? _aeFixedToScene(_aeGeodeticToFixed(ecl.hit.lat, ecl.hit.lon), sc.gast) : null;
  _aePlaceLabel('ae-lbl-shadow', sh, !!sh && _aeFacing(sh) && _ae.target === 'earth');
}

// "GPS BIII-3  (PRN 23)" -> "PRN 23"; anything else as given.
function _aeSatShortName(s) {
  var m = /PRN\s*(\d+)/.exec(s.omm.OBJECT_NAME || '');
  return m ? 'GPS PRN ' + m[1] : String(s.omm.OBJECT_NAME || '').replace(/\s+/g, ' ');
}

// ── Taps ──
function _aeTap(x, y) {
  var best = null, bestD = AE_TAP_RADIUS_PX;
  // Satellites are picked at the Earth; from the Moon or the Sun they are a
  // speck on it, and a tap there means the Earth.
  var n = _ae.target === 'earth' ? _ae.positions.length : 0;
  for (var i = 0; i < n; i++) {
    var p = _ae.positions[i];
    if (_aeBehindEarth(p.pos)) continue;
    var s = _aeProject(p.pos);
    if (!s) continue;
    var d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) {
    _ae.selected = { norad: _ae.sats.list[best.idx].omm.NORAD_CAT_ID, tapMs: _aeDisplayMs() };
    _aeRenderCard();
    _ae.dirty = true;
    _aeKick();
    return;
  }
  // The Earth, the Moon or the Sun: fly to it, as its chip does. A tap on
  // the one already in view falls through (it puts a satellite's card away).
  var body = _aeBodyAt(x, y);
  if (body && body !== _ae.target) { _aePreset(body); return; }
  if (_ae.selected) { _ae.selected = null; _aeRenderCard(); _ae.dirty = true; _aeKick(); }
}

// The body under a point on the screen: its disc, or a finger's width
// around a small one; the nearest to the camera where one covers another
// (the Moon before the Sun in an eclipse). Null for none.
var AE_TAP_BODY_PX = AE_TAP_RADIUS_PX * 1.5;
function _aeBodyAt(x, y) {
  var sc = _ae.scene;
  if (!sc || !_ae.h) return null;
  var cam = _ae.gl.camera, eye = [cam.position.x, cam.position.y, cam.position.z];
  var pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  var bodies = [['earth', [0, 0, 0], 1], ['moon', sc.moon, AE_MOON_RADIUS_RE], ['sun', _aeSunShown(sc), AE_SUN_SHOW_R]];
  var best = null, bestD = Infinity;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i];
    if (b[0] !== 'earth' && _aeBehindEarth(b[1])) continue;
    var s = _aeProject(b[1]);
    if (!s) continue;
    var d = _aeLen(_aeSub(b[1], eye));
    var reach = Math.max(b[2] / d * pxPerRad, AE_TAP_BODY_PX);
    if (Math.hypot(s.x - x, s.y - y) <= reach && d < bestD) { bestD = d; best = b[0]; }
  }
  return best;
}

// ── The card for a tapped satellite ──
function _aeRenderCard() {
  var card = _aeById('ae-card');
  if (!card) return;
  var s = _aeSelectedSat();
  if (!s) { _ae.selected = null; card.hidden = true; card.innerHTML = ''; return; }
  var html = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>';
  if (s.iss) {
    html += '<h3>' + _aeLink('term:iss', _almEsc(_aeT('alm_earth_iss_name'))) + '</h3>' +
      '<p id="ae-card-body"></p>' + '<p id="ae-card-age"></p>';
  } else {
    html += '<h3>' + _aeLink('term:gps', _almEsc(_aeSatShortName(s))) + '</h3>' +
      '<p id="ae-card-body"></p>' + '<p class="ae-counter" id="ae-card-count"></p>' +
      (_aeLinked('term:time_dilation') ? '<p>' + _aeLink('term:time_dilation', _almEsc(_aeT('alm_earth_time_dilation'))) + '</p>' : '');
  }
  card.innerHTML = html;
  card.hidden = false;
  _aeById('ae-card-x').onclick = function () { _ae.selected = null; _aeRenderCard(); _ae.dirty = true; _aeKick(); };
  _aeUpdateCard(_aeDisplayMs());
}

function _aeUpdateCard(ms) {
  var s = _aeSelectedSat();
  if (!s) return;
  var body = _aeById('ae-card-body');
  if (!body) return;
  var eqeq = _ae.scene ? _aeEqEq(_ae.scene) : 0;
  var st = _aeSatAt(s, ms, eqeq);
  if (!st) return;
  var rKm = Math.sqrt(st.posKm.x * st.posKm.x + st.posKm.y * st.posKm.y + st.posKm.z * st.posKm.z);
  var v = Math.sqrt(st.velKmS.x * st.velKmS.x + st.velKmS.y * st.velKmS.y + st.velKmS.z * st.velKmS.z);
  if (s.iss) {
    var alt = rKm - AE_EARTH_RADIUS_KM;
    var lap = AE_MINUTES_PER_DAY / s.omm.MEAN_MOTION;
    body.textContent = _aeT('alm_earth_iss_line', { alt: _orrNum(alt, null, 0), v: _orrNum(v, null, 2), min: _orrNum(lap, null, 0) });
    var age = _aeById('ae-card-age');
    if (age) age.textContent = s.standing === 'approximate'
      ? _aeT('alm_earth_approx', { date: _aeFmtDate(s.epochMs) })
      : _aeT('alm_earth_data_from', { date: _aeFmtDate(s.epochMs) });
    return;
  }
  var rates = _aeGpsClockRates(rKm, v);
  body.textContent = _aeT('alm_earth_gps_sentence', {
    net: _orrNum(_aeMicrosPerDay(rates.net), null, 1),
    grav: _orrNum(_aeMicrosPerDay(rates.grav), null, 1),
    speed: _orrNum(-_aeMicrosPerDay(rates.speed), null, 1),
    v: _orrNum(v, null, 2),
    km: _orrNum(_aeKmPerDay(rates.net), null, 0)
  });
  // The satellite's clock pulls ahead at the net rate for as long as the
  // shown time runs; the counter starts at the tap. The rate wanders a
  // little round an orbit that is not quite circular, so the gain is summed
  // step by step: elapsed time times the rate of the moment ran backwards
  // whenever the rate dipped.
  var sel = _ae.selected;
  if (sel.lastMs === undefined || ms < sel.tapMs) { sel.tapMs = Math.min(sel.tapMs, ms); sel.lastMs = ms; sel.gainedS = 0; }
  sel.gainedS = Math.max(0, sel.gainedS + (ms - sel.lastMs) / 1000 * rates.net);
  sel.lastMs = ms;
  var count = _aeById('ae-card-count');
  if (count) count.textContent = _aeT('alm_earth_since_tap', { t: _aeFmtGain(sel.gainedS) });
}

// The counter's reading: nanoseconds to two places while it is young, then
// the unit that keeps the number short (at an hour a second it passes a
// microsecond within a second, and a clock jump makes milliseconds).
var AE_GAIN_FINE_NS = 100;
function _aeFmtGain(sec) {
  var ns = sec * AE_NANO;
  if (ns < 1000) return _orrNum(ns, 'nanosecond', ns < AE_GAIN_FINE_NS ? 2 : 0);
  return _orrFmtSpan(sec);
}

// The note under the controls: where the drawn orbits come from, or why
// none are drawn, and the images' credit. When the view offers fresh data
// (Ask first), the data's date moves out of the note to stand before the
// offer: { ask, note }.
function _aeNoteParts() {
  var parts = [], dated = '', sats = _ae.sats;
  if (sats && sats.list.length) {
    var newest = 0, anyShown = false, issOrbit = null;
    sats.list.forEach(function (s) {
      newest = Math.max(newest, s.epochMs);
      if (s.standing && s.standing !== 'none') anyShown = true;
      if (s.iss && s.standing === 'orbit') issOrbit = s;
    });
    var line = _aeT(anyShown ? 'alm_earth_data_from' : 'alm_earth_no_sat_data', { date: _aeFmtDate(newest) });
    if (anyShown && _aeAsking()) dated = line;
    else parts.push(line);
    if (issOrbit) parts.push(_aeT('alm_earth_iss_orbit_only', { date: _aeFmtDate(issOrbit.epochMs) }));
  } else if (sats) {
    parts.push(_aeT('alm_earth_no_orbital_data'));
  } else if (_ae.satsFailed) {
    parts.push(_aeT('alm_earth_sats_unavailable'));
  }
  var S = _ae.gl;
  if (S && (S.mapFailed[AE_TEX_NIGHT] || S.mapFailed[AE_TEX_MOON])) parts.push(_aeT('alm_earth_maps_failed'));
  parts.push(_aeT('alm_earth_credit'));
  return { ask: dated, note: parts.join(' · ') };
}

// The offer before the note: the data's date, whether the last try failed,
// and the button.
function _aeRenderAsk(dated) {
  var box = _aeById('ae-ask'), btn = _aeById('ae-fresh');
  if (!box || !btn) return;
  var on = _aeAsking();
  if (box.hidden === on) box.hidden = !on;
  if (!on) return;
  var parts = dated ? [dated] : [];
  if (_ae.freshFailed) parts.push(_aeT('alm_earth_fresh_failed'));
  _aeSetText(_aeById('ae-ask-text'), parts.join(' · '));
  _aeSetText(btn, _aeT(_ae.freshBusy ? 'alm_earth_getting_fresh' : 'alm_earth_get_fresh'));
  btn.disabled = !!_ae.freshBusy;
}

// ── Text: the clock, the eclipse line, the data note ──
function _aeRefreshText() { if (_aeIsOpen) _aeUpdateText(_aeDisplayMs()); }
function _aeUpdateText(ms) {
  var when = _aeById('ae-when');
  var whenText = _aeFmtWhen(ms);
  if (when) {
    var whenHtml = '<b>' + _almEsc(whenText) + '</b>' +
      (_aeIsLive() ? '<span class="ae-live">● ' + _almEsc(_aeT('alm_earth_live')) + '</span>' : '');
    if (whenHtml !== _ae.whenHtml) { when.innerHTML = whenHtml; _ae.whenHtml = whenHtml; }
  }
  var nowBtn = _aeById('ae-now'), live = _aeIsLive();
  if (nowBtn && nowBtn.hidden !== live) {
    nowBtn.hidden = live;
    _ae.el.classList.toggle('ae-away', !live);
  }
  var sc = _ae.scene;
  var status = _aeById('ae-status');
  if (sc && status) {
    var e = _aeEclipseNow(sc);
    _ae.eclipse = e;
    var txt = '';
    if (e && e.solar) {
      if (e.central) txt = _aeT(e.total ? 'alm_earth_ecl_total_solar' : 'alm_earth_ecl_annular_solar', { place: _aeFmtLatLon(e.hit) });
      else txt = _aeT('alm_earth_ecl_partial_solar');
    } else if (e) {
      txt = _aeT(e.total ? 'alm_earth_ecl_total_lunar' : (e.partial ? 'alm_earth_ecl_partial_lunar' : 'alm_earth_ecl_penumbral_lunar'));
    }
    if (status.textContent !== txt) status.textContent = txt;
  }
  // On the Moon with no place to stand, up is celestial north: said, not guessed.
  var orient = _aeById('ae-orient');
  var northUp = _ae.target === 'moon' && !_aeObserver();
  if (orient && orient.hidden === northUp) orient.hidden = !northUp;
  // On the Sun, its line: the cycle's real sunspot number, the spots' honesty.
  var sunNote = _aeById('ae-sunnote');
  if (sunNote) {
    var onSun = _ae.target === 'sun';
    if (sunNote.hidden === onSun) sunNote.hidden = !onSun;
    if (onSun) {
      var yr = _aeDecimalYear(ms), cyc = _aeCycleIndex(yr) + 1;
      _aeSetText(sunNote, _aeT(cyc >= 1 ? 'alm_earth_sun_spots' : 'alm_earth_sun_spots_old',
        { n: _orrNum(Math.round(_aeSunspotNumber(yr).r), null, 0), c: _orrNum(cyc, null, 0) }));
    }
  }
  var note = _aeNoteParts();
  _aeRenderAsk(note.ask);
  _aeSetText(_aeById('ae-note'), note.note);
  var canvas = _aeById('ae-canvas');
  if (canvas && sc) {
    var aria = _aeT('alm_earth_aria', { when: whenText, place: _aeFmtLatLon(_aeSubsolarPoint(sc)) });
    if (canvas.getAttribute('aria-label') !== aria) canvas.setAttribute('aria-label', aria);
  }
  _aeUpdateCard(ms);
}

// ── The loop ──
// Renders every frame while something moves (a drag, a flight, a faster
// clock), otherwise a few times a second: at real time the fastest thing on
// screen, the ISS, crosses a pixel in several seconds.
function _aeKick() {
  if (!_aeIsOpen) return;
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  if (!_ae.raf) _ae.raf = requestAnimationFrame(_aeFrame);
}
function _aeBusy() {
  return !!(_ae.fly || _ae.drag || _ae.pinch || _ae.speed > 1 || _ae.hand);
}
// Draw the scene at the clock's instant when something changed, something
// moves, or the idle interval has passed.
function _aeDraw(now, busy) {
  if (!_ae.gl || !(_ae.dirty || busy || now - _ae.lastRender >= AE_IDLE_RENDER_MS)) return;
  _aeUpdate(_aeDisplayMs());
  _ae.gl.renderer.render(_ae.gl.scene, _ae.gl.camera);
  _aeUpdateLabels();
  _ae.lastRender = now;
  _ae.dirty = false;
}
function _aeFrame() {
  _ae.raf = 0;
  if (!_aeIsOpen || document.hidden) return;
  if (typeof _almanacOpen !== 'undefined' && !_almanacOpen) { _aeFinishClose(); return; }
  var now = performance.now();
  var dt = _ae.lastTs ? Math.min(now - _ae.lastTs, 1000) : 0;
  _ae.lastTs = now;
  if (_ae.speed > 1 && dt) _aeRunClock(dt * _ae.speed);
  var handDone = _aeStepHand(now);
  var busy = _aeStepFly(now) || _aeBusy() || !!handDone;
  _aeDraw(now, busy);
  if (now - _ae.lastText >= AE_TEXT_TICK_MS) { _aeUpdateText(_aeDisplayMs()); _ae.lastText = now; }
  // The last frame of a swap is drawn; what follows it (the page covered,
  // or the view gone and the hero back) happens on it, not a frame later.
  if (handDone) handDone();
  if (!_aeIsOpen) return;
  if (busy) _ae.raf = requestAnimationFrame(_aeFrame);
  else {
    _ae.lastTs = 0;
    _ae.idleTimer = setTimeout(function () { _ae.idleTimer = 0; _aeKick(); }, AE_TEXT_TICK_MS);
  }
}

// ── Input ──
function _aeZoomBy(factor) {
  // Mid-flight, a zoom rescales the flight and lets it finish turning.
  var f = _ae.fly;
  if (f) {
    f.toDist = _aeClampDist(f.toDist * factor);
    f.from.dist = _aeClampDist(f.from.dist * factor);
  }
  _ae.dist = _aeClampDist(_ae.dist * factor);
  _ae.preset = null;
  _aeMarkViews();
  _ae.dirty = true;
  _aeKick();
}
function _aeTurnBy(dAz, dEl) {
  _ae.fly = null;
  _ae.az += dAz;
  _ae.el_ = _aeClamp(_ae.el_ + dEl, -AE_MAX_ELEVATION, AE_MAX_ELEVATION);
  // Mid-swap the turn is the Moon's at both ends of the way, so it shows at
  // once, even while the Moon still stands in the hero's place.
  if (_ae.hand) { _ae.hand.daz += dAz; _ae.hand.del += dEl; }
  _ae.dirty = true;
  _aeKick();
}
// A drag that began on the hero disc (almanac.js), carried on into the view.
function _aeHandDrag(dx, dy) {
  if (!_aeIsOpen || !_ae.gl) return;
  _aeDragBy(dx, dy);
}
// A finger's move, in screen pixels (right, down), as the camera's turn: the
// surface under the finger goes with it ("it moves when I drag but I can't
// figure out how to intentionally get it a direction", Eric, 2026-10-03).
// The screen is turned from celestial north by the view's roll (on the Moon,
// its tilt in the observer's sky), so the move is first turned back into the
// north-up frame the azimuth and elevation live in; then right is west of
// the camera (the globe turns right) and down is up (the globe turns down).
// Away from the equator a turn in azimuth runs round a smaller circle, so it
// is that much larger for the same move.
function _aeDragTurn(dx, dy, rollDeg, k, el) {
  var r = _aeRad(rollDeg || 0), c = Math.cos(r), s = Math.sin(r);
  var nx = dx * c + dy * s, ny = dy * c - dx * s;
  var circle = Math.max(Math.cos(el || 0), Math.cos(AE_MAX_ELEVATION));
  return { daz: -nx * k / circle, del: ny * k };
}
// Radians of turn per pixel that keep the point under the finger under it:
// a turn of a moves the near surface R*a across, seen from D - R away with a
// focal length of f pixels, so a = px * (D - R) / (R * f). From far out a
// small disc would spin wildly; it turns no faster than AE_DRAG_RAD_PER_PX.
function _aeDragRadPerPx(dist, surface, focalPx) {
  if (!(focalPx > 0) || !(surface > 0)) return AE_DRAG_RAD_PER_PX;
  return Math.min(AE_DRAG_RAD_PER_PX, Math.max(0, dist - surface) / (surface * focalPx));
}
function _aeFocalPx() {
  var cam = _ae.gl && _ae.gl.camera;
  return cam && _ae.h ? (_ae.h / 2) / Math.tan(_aeRad(cam.fov) / 2) : 0;
}
function _aeDragK() { return _aeDragRadPerPx(_ae.dist, AE_TARGETS[_ae.target].surface, _aeFocalPx()); }
function _aeDragBy(dx, dy) {
  var turn = _aeDragTurn(dx, dy, _ae.roll, _aeDragK(), _ae.el_);
  _aeTurnBy(turn.daz, turn.del);
}
// Take over a drag that began on the hero disc, once the view is up: the
// pointer is captured by this canvas and becomes its own drag, so the same
// finger keeps turning the Moon however the page under it is hidden or
// redrawn (WebKit ends a capture held by an element that stops being drawn).
// False while the view is not open yet (the disc forwards the drag till then).
function _aeAdoptPointer(id, x, y) {
  var canvas = _aeById('ae-canvas');
  if (!_aeIsOpen || !_ae.gl || !canvas) return false;
  try { canvas.setPointerCapture(id); } catch (e) { return false; }
  _ae.pointers[id] = { x: x, y: y };
  _ae.drag = { x: x, y: y, x0: x, y0: y, moved: true };
  canvas.classList.add('ae-dragging');
  return true;
}
// The canvas's own listeners: bound again to the fresh canvas that replaces
// one whose context was given back (_aeDisposeGl).
function _aeBindCanvas(canvas) {
  canvas.addEventListener('pointerdown', function (e) {
    if (_ae.setOpen) _aeShowSettings(false);   // a touch on the globe puts the panel away
    _aeHideHint();                              // and the hint has done its job
    canvas.setPointerCapture(e.pointerId);
    _ae.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(_ae.pointers);
    if (ids.length === 1) _ae.drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
    else if (ids.length === 2) {
      var a = _ae.pointers[ids[0]], b = _ae.pointers[ids[1]];
      _ae.pinch = { span: Math.hypot(a.x - b.x, a.y - b.y) };
      _ae.drag = null;
    }
    canvas.classList.add('ae-dragging');
    _aeKick();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!_ae.pointers[e.pointerId]) return;
    _ae.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(_ae.pointers);
    if (_ae.pinch && ids.length >= 2) {
      var a = _ae.pointers[ids[0]], b = _ae.pointers[ids[1]];
      var span = Math.hypot(a.x - b.x, a.y - b.y);
      if (span > 0 && _ae.pinch.span > 0) _aeZoomBy(_ae.pinch.span / span);
      _ae.pinch.span = span;
    } else if (_ae.drag) {
      var dx = e.clientX - _ae.drag.x, dy = e.clientY - _ae.drag.y;
      _ae.drag.x = e.clientX; _ae.drag.y = e.clientY;
      if (Math.hypot(e.clientX - _ae.drag.x0, e.clientY - _ae.drag.y0) > AE_TAP_SLOP_PX) _ae.drag.moved = true;
      _aeDragBy(dx, dy);
    }
  });
  function end(e) {
    if (!_ae.pointers[e.pointerId]) return;
    delete _ae.pointers[e.pointerId];
    var left = Object.keys(_ae.pointers).length;
    if (_ae.drag && !_ae.drag.moved && left === 0 && e.type === 'pointerup') {
      var r = canvas.getBoundingClientRect();
      _aeTap(e.clientX - r.left, e.clientY - r.top);
    }
    if (left < 2) _ae.pinch = null;
    if (left === 0) { _ae.drag = null; canvas.classList.remove('ae-dragging'); }
    else if (left === 1) {
      var p = _ae.pointers[Object.keys(_ae.pointers)[0]];
      _ae.drag = { x: p.x, y: p.y, x0: p.x, y0: p.y, moved: true };
    }
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    _aeZoomBy(Math.exp(e.deltaY * AE_WHEEL_ZOOM));
  }, { passive: false });
}
function _aeBindKeys() {
  _ae.el.addEventListener('keydown', function (e) {
    // Escape shuts the gear's panel first, then leaves this view only; the
    // Almanac underneath stays open.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (_ae.setOpen) { _aeShowSettings(false); _aeById('ae-gear').focus({ preventScroll: true }); return; }
      _ae.closedByKey = true;
      _aeClose();
      return;
    }
    if (e.target !== _aeById('ae-canvas')) return;
    var handled = true, arrow = AE_KEY_ARROWS[e.key];
    // An arrow turns the globe as a drag that way on the screen would.
    if (arrow) { var turn = _aeDragTurn(arrow[0], arrow[1], _ae.roll, AE_KEY_TURN); _aeTurnBy(turn.daz, turn.del); }
    else if (e.key === '+' || e.key === '=') _aeZoomBy(1 / AE_KEY_ZOOM);
    else if (e.key === '-' || e.key === '_') _aeZoomBy(AE_KEY_ZOOM);
    else handled = false;
    if (handled) e.preventDefault();
  });
}

// A speed runs the page's clock (_aeRunClock); back at real time the page
// lands on the moment it ran to.
function _aeSetSpeed(speed) {
  _ae.speed = speed;
  var btns = document.querySelectorAll('#ae-time [data-ae-speed]');
  for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(+btns[i].getAttribute('data-ae-speed') === speed));
  if (speed === 1) _aeLandClock();
  _ae.dirty = true;
  _aeKick();
}

// After the clock jumps: this view's own run-up is spent, the cached orbits
// belong to the old instant, and the Almanac's loops (its repaint restarts
// them) stay paused under the view.
function _aeEclipseButton(on) {
  var b = _aeById('ae-eclipse');
  if (b) b.disabled = !on;
}
function _aeJumped() {
  _aeEclipseButton(true);
  _ae.clockRan = false;
  _ae.ringsAt = _ae.issRingAt = _ae.moonPathAt = null;
  _aePauseAlmanac();
  _aeSetSpeed(1);
}
// The page lands on `date` (null: now). Under the view its hero needs no
// sweep from the moment before: it is covered, and when the view closes the
// Moon flies back into it at this moment.
function _aeSettlePage(date) {
  if (typeof _almPrevFocusTime !== 'undefined') _almPrevFocusTime = null;
  if (date) { if (typeof _almScrubSettle === 'function') _almScrubSettle(date); }
  else if (_aeFocusSet() && typeof _almBackToToday === 'function') _almBackToToday();
}
// Hand a new instant to the Almanac itself: the header, the calendar, the
// orrery and this view all read the one clock.
function _aeGoTo(ms) {
  _ae.clockRan = false;
  _aeSettlePage(new Date(ms));
  _aeJumped();
}
// Now for everything the clock is made of: the time machine and the orrery
// (its offset, its rides) go back to now with it.
function _aeNow() {
  _ae.clockRan = false;
  _aeSettlePage(null);
  if (typeof _orrerySnapToNow === 'function') _orrerySnapToNow();
  _aeJumped();
}
function _aeJumpToNextEclipse() {
  var next = _aeNextEclipse(_aeDisplayMs());
  // None found (far outside the centuries the series hold): say so by
  // standing down until the clock jumps, rather than doing nothing.
  if (!next) { _aeEclipseButton(false); return; }
  _aeGoTo(next.ms);
  var sc = _aeSceneAt(next.ms);
  _ae.scene = sc;
  if (next.solar) {
    // Face the Moon's shadow: look down the shadow's axis onto the Earth.
    var sh = _aeSolarShadow(sc);
    var aim = sh.hit ? _aeFixedToScene(_aeGeodeticToFixed(sh.hit.lat, sh.hit.lon), sc.gast) : _aeScale(sc.moon, 1);
    _ae.preset = 'earth';
    _aeFlyTo('earth', _aeFitDist(AE_FIT_EARTH), _aeAzElOf(aim));
  } else {
    _aePreset('moon');
  }
}

function _aeBindControls() {
  _aeById('ae-back').onclick = _aeClose;
  var views = document.querySelectorAll('#ae-views [data-ae-view]');
  for (var i = 0; i < views.length; i++) {
    views[i].onclick = function () { _aePreset(this.getAttribute('data-ae-view')); };
  }
  var speeds = document.querySelectorAll('#ae-time [data-ae-speed]');
  for (var j = 0; j < speeds.length; j++) {
    speeds[j].onclick = function () { _aeSetSpeed(+this.getAttribute('data-ae-speed')); };
  }
  _aeById('ae-eclipse').onclick = _aeJumpToNextEclipse;
  _aeById('ae-now').onclick = _aeNow;
  _aeById('ae-locate').onclick = _aeLocateMe;
  _aeById('ae-gear').onclick = function () { _aeShowSettings(!_ae.setOpen); };
  _aeById('ae-fresh').onclick = _aeGetFresh;
  // The panel's radios are drawn afresh with each answer: one listener.
  _aeById('ae-set').onchange = function (e) {
    var input = e && e.target;
    if (input && input.name === 'ae-sat-mode') _aeSetMode(input.value);
  };
  // Article links in the card need no binding of their own: the view sits
  // inside #almanac-view, where AlmanacLinks already listens.
  if (typeof ResizeObserver === 'function') new ResizeObserver(_aeResize).observe(_ae.el);
  else window.addEventListener('resize', _aeResize);
  document.addEventListener('visibilitychange', function () {
    if (!_aeIsOpen || document.hidden) return;
    // The Almanac resumes its own loops on return; the view covers them.
    setTimeout(_aePauseAlmanac, 0);
    _ae.dirty = true;
    _aeKick();
  });
}

// The Almanac's own loops (orrery, sky, clocks) run underneath; covered by
// this view they would only compete with it for the frame.
function _aePauseAlmanac() { if (typeof _cancelAllRAF === 'function') _cancelAllRAF(); }
function _aeResumeAlmanac() { if (typeof _resumeAllRAF === 'function') _resumeAllRAF(); }
// Covered by the view, the Almanac's page need not be painted at all
// (visibility keeps its layout, so its scroll position survives).
// A class on the Almanac, not a style on its content: the content's own
// attributes stay as they were.
function _aeCoverAlmanac(on) {
  var v = _aeById('almanac-view');
  if (v) v.classList.toggle('ae-covered', on);
}
// Take a style off as if it was never set: no empty style attribute left.
function _aeStyleOff(el, prop) {
  el.style.removeProperty(prop);
  if (!el.getAttribute('style')) el.removeAttribute('style');
}

// A message stands in for the view (loading, no WebGL, no maps): the
// controls and the notes under them belong to a view that is not there,
// so they step aside with it (ae-blank) instead of doing nothing when tapped.
function _aeMessage(text) {
  var m = _aeById('ae-msg');
  if (!m) return;
  m.textContent = text || '';
  m.hidden = !text;
  if (_ae && _ae.el) _ae.el.classList.toggle('ae-blank', !!text);
}

// ── Ready, before anyone asks ──
// three.js, the scene and its maps are made ready behind the page once it
// has painted (and gone idle), or as soon as someone points at or touches
// the hero, so a tap on the Moon swaps it for this one in the same frame.
// Never on the page's first paint: this file itself loads after it. Ready
// means a context with its shaders compiled and its maps uploaded, drawing
// to a single pixel until the view opens.
var _aePreparing = null;
function _aeEnsure() {
  if (_ae) return true;
  _aeEnsureStyles();
  var el = _aeBuildDom();
  if (!el) return false;
  _ae = _aeNewState(el);
  _aeBindControls();
  _aeBindKeys();
  _aeBindCanvas(_aeById('ae-canvas'));
  return true;
}
function _aeReady() { return !!(_ae && _ae.gl && _ae.ready); }
// Resolves true when the view can draw; false when it cannot (no WebGL, or
// the day map, without which there is no view, did not load).
function _aePrepare() {
  if (!_aeEnsure()) return Promise.resolve(false);
  if (_aeReady()) return Promise.resolve(true);
  if (_ae.failed) return Promise.resolve(false);
  if (_aePreparing) return _aePreparing;
  _ae.loading = true;
  _aePreparing = _aeLoadThree().then(function (THREE) {
    var S = _ae.gl;
    if (!S) {
      S = _aeBuildGl(THREE, _aeById('ae-canvas'));
      if (!S) {
        _ae.failed = true;
        // The orrery stops offering what this browser cannot draw (its glow
        // and Earth's button go; Earth opens its article again).
        openAlmanacEarth.unsupported = true;
        return false;
      }
      _ae.gl = S;
    }
    return _aeLoadMaps(S).then(function (dayMapIn) {
      if (_ae.gl !== S) return false;     // the Almanac closed while it loaded
      if (!dayMapIn) { _aeDisposeGl(); return false; }
      _ae.ready = true;
      _aeWarm(S);
      return true;
    });
  }).catch(function () { return false; }).then(function (ok) {
    _ae.loading = false;
    _aePreparing = null;
    return ok;
  });
  return _aePreparing;
}
// Compile every shader and upload every map now, at a pixel's cost, so the
// first frame the view shows does neither.
function _aeWarm(S) {
  if (_aeIsOpen || !S || _ae.gl !== S) return;
  _ae.scene = _aeSceneAt(_aeDisplayMs());
  _aeUpdate(_ae.scene.ms);
  S.renderer.compile(S.scene, S.camera);
  S.renderer.render(S.scene, S.camera);
}
// Behind the page, once it has painted and the browser is idle.
var AE_IDLE_PREPARE_TIMEOUT_MS = 4000;
function _aePrepareWhenIdle() {
  var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 1); };
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      idle(function () {
        if (typeof _almanacOpen !== 'undefined' && !_almanacOpen) return;
        _aePrepare();
      }, { timeout: AE_IDLE_PREPARE_TIMEOUT_MS });
    });
  });
}

// ── Open and close ──
// The swap's frames: e is how far the camera has come from the hero's (0)
// to the view's (1). The page dims behind the Moon by it, what is not the
// Moon (the stars, the Sun, orbits, satellites) comes in by it, and the
// controls come up over its last part. Under reduced motion the view does
// not fly: it fades in over the page, and out.
function _aeHandApply(h, e) {
  h.e = h.xfade ? 1 : e;
  _aeFadeU.value = h.xfade ? 1 : e;
  var st = _ae.el.style;
  if (h.xfade) st.opacity = String(e);
  st.backgroundColor = 'rgba(0,0,0,' + (h.xfade ? 1 : e).toFixed(3) + ')';
  st.setProperty('--ae-ui', h.xfade ? '1' : String(_smoothstep(AE_HAND_UI_FROM, 1, e)));
  _ae.dirty = true;
}
function _aeHandReset() {
  _aeFadeU.value = 1;
  ['opacity', 'background-color', '--ae-ui'].forEach(function (p) { _aeStyleOff(_ae.el, p); });
  _ae.el.classList.remove('ae-hand');
}
// Advance a swap; returns what to do once this frame is drawn, on its last.
function _aeStepHand(now) {
  var h = _ae.hand;
  if (!h) return null;
  var p = _aeClamp((now - h.start) / h.ms, 0, 1), k = _aeEaseOut(p);
  _aeHandApply(h, h.dir > 0 ? h.e0 + (1 - h.e0) * k : h.e0 * (1 - k));
  if (p < 1) return null;
  return function () {
    if (_ae.hand !== h) return;
    _ae.hand = null;
    _aeHandReset();
    h.done();
  };
}
// The hero disc steps aside while this Moon stands in for it (a class on the
// Almanac, so a header the clock rebuilds meanwhile stays aside too).
function _aeLiftHero(on) {
  var v = _aeById('almanac-view');
  if (v) v.classList.toggle('alm-moon-lifted', on);
}
// In: the hero's Moon becomes this one, then the view opens around it.
function _aeHandIn(frame) {
  var sc = _ae.scene = _aeSceneAt(_aeDisplayMs());
  var azel = _aeAzElOf(_aeScale(sc.moon, -1));
  _ae.target = 'moon';
  _ae.az = azel.az; _ae.el_ = azel.el;
  _ae.fly = null;
  _ae.dist = _aeClampDist(_aeFitDist(AE_FIT_MOON));
  _ae.preset = 'moon';
  _aeMarkViews();
  var xfade = _aeReduceMotion();
  var h = _ae.hand = {
    dir: 1, start: performance.now(), ms: xfade ? AE_HAND_XFADE_MS : AE_HAND_MS,
    frame: frame, daz: 0, del: 0, e0: 0, e: 0, xfade: xfade,
    done: function () {
      _aeCoverAlmanac(true);
      if (!_ae.hinted) { _ae.hinted = true; _aeShowHint(); }
    }
  };
  _ae.el.classList.add('ae-hand');
  _aeHandApply(h, 0);
  // The first frame now, and the disc aside in the same task: the swap lands
  // in one composite, the Moon never in two places or none.
  _aeDraw(performance.now(), true);
  if (!xfade) _aeLiftHero(true);
  _aeKick();
}
// Out: the view closes onto the hero, the Moon flying back into its place.
function _aeHandOut(frame) {
  var was = _ae.hand, xfade = _aeReduceMotion();
  _ae.hand = {
    dir: -1, start: performance.now(), ms: xfade ? AE_HAND_XFADE_MS : AE_HAND_MS,
    frame: frame, daz: 0, del: 0, e0: was ? was.e : 1, e: was ? was.e : 1, xfade: xfade,
    done: _aeFinishClose
  };
  _ae.pointers = {}; _ae.drag = _ae.pinch = null;
  _ae.el.classList.add('ae-hand');
  _aeShowSettings(false);
  _aeCoverAlmanac(false);
  if (!xfade) _aeLiftHero(true);
  _aeKick();
}

// Where the opening flight arrives: over the chosen place (or the Almanac's
// stand-in for it), so the first thing seen is here, lit as it is now.
function _aeEnter() {
  // From the hero, its Moon becomes this one where it stands.
  var frame = _ae.fromHero ? _aeHeroFrame() : null;
  if (frame) { _aeHandIn(frame); return; }
  _aeCoverAlmanac(true);
  var ms = _aeDisplayMs();
  _ae.scene = _aeSceneAt(ms);
  var loc = (typeof _getLocation === 'function') ? _getLocation() : { lat: 0, lon: 0 };
  var here = _aeFixedToScene(_aeGeodeticToFixed(_aeClamp(loc.lat, -_aeDeg(AE_START_MAX_LAT), _aeDeg(AE_START_MAX_LAT)), loc.lon), _ae.scene.gast);
  var azel = _aeAzElOf(here);
  _ae.target = 'earth';
  _ae.az = azel.az; _ae.el_ = azel.el;
  _ae.dist = _aeReduceMotion() ? _aeFitDist(AE_FIT_EARTH) : AE_FLY_START_DIST;
  _aePreset(_aeOpenTarget);
  if (!_ae.hinted) { _ae.hinted = true; _aeShowHint(); }
}

function _aeHideHint() {
  var hint = _aeById('ae-hint');
  if (hint) hint.classList.remove('ae-show');
  clearTimeout(_ae.hintTimer);
}
// The hint over the controls, for a moment: the first open's, or `text`.
function _aeShowHint(text) {
  var hint = _aeById('ae-hint');
  if (!hint) return;
  if (text) hint.textContent = text;
  hint.classList.add('ae-show');
  clearTimeout(_ae.hintTimer);
  _ae.hintTimer = setTimeout(function () { hint.classList.remove('ae-show'); }, AE_HINT_MS);
}

// Show where I am. The position is asked for only here, when the person
// taps for it, as the Maps app asks: opening the view asks nothing. Granted,
// "You" marks the device's own position and the view turns to it; denied or
// unavailable, nothing is drawn and the hint says so. A second tap hides it.
function _aeLocateMe() {
  var btn = _aeById('ae-locate');
  if (_ae.you) { _ae.you = null; btn.setAttribute('aria-pressed', 'false'); _aeKick(); return; }
  var fail = function () {
    btn.disabled = false;
    _aeShowHint(_aeT('alm_earth_where_unknown'));
  };
  if (!navigator.geolocation) { fail(); return; }
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(function (pos) {
    btn.disabled = false;
    var lat = pos.coords.latitude, lon = pos.coords.longitude;
    if (!_almValidLatLon(lat, lon)) { fail(); return; }
    _ae.you = { lat: lat, lon: lon };
    // Where I am is the place the Almanac follows from now on: its tides,
    // sky and times take it up when the view closes.
    if (typeof _saveLocation === 'function') { _saveLocation(lat, lon, ''); _ae.placeChanged = true; }
    btn.setAttribute('aria-pressed', 'true');
    var sc = _ae.scene || _aeSceneAt(_aeDisplayMs());
    _ae.preset = 'earth';
    _aeFlyTo('earth', _aeFitDist(AE_FIT_EARTH), _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(lat, lon), sc.gast)));
  }, fail, { timeout: AE_LOCATE_TIMEOUT_MS, maximumAge: 60000 });
}

// Open the view. `opts.target` 'moon' or 'sun' opens on that body, else the
// Earth (the orrery's way in, flying down to it). `opts.fromHero`: the hero
// disc was tapped or dragged, and its Moon becomes this one (_aeHandIn); if
// the view is not ready yet the disc waits, breathing, until it is.
// `opts.from` 'sky': the live sky's Sun or Moon was tapped; the view keeps
// the page's clock and Back says Almanac. Otherwise it came from the orrery.
var _aeOpenTarget = 'earth';
var _aeFrom = 'orrery';
function openAlmanacEarth(opts) {
  if (_aeIsOpen || !_aeEnsure()) return;
  _aeOpenTarget = opts && AE_TARGETS[opts.target] ? opts.target : 'earth';
  var fromHero = !!(opts && opts.fromHero);
  _aeFrom = fromHero ? 'hero' : (opts && opts.from === 'sky' ? 'sky' : 'orrery');
  if (!fromHero || _aeReady() || _ae.failed) { _aeShow(fromHero); return; }
  var hero = document.querySelector(AE_HERO_SEL);
  if (hero) hero.classList.add('alm-moon-waking');
  _ae.wanted = true;
  _aePrepare().then(function () {
    if (hero) hero.classList.remove('alm-moon-waking');
    if (!_ae.wanted) return;
    _ae.wanted = false;
    if (_aeIsOpen || (typeof _almanacOpen !== 'undefined' && !_almanacOpen)) return;
    _aeShow(true);
  });
}
function _aeShow(fromHero) {
  // From the orrery, its chosen moment; from the hero or the sky, the moment
  // they show.
  if (_aeFrom === 'orrery') _aeAdoptOrreryClock();
  _aeIsOpen = true;
  _ae.fromHero = fromHero;
  _ae.el.classList.add('open');
  _ae.selected = null;
  _aeRenderCard();
  _aeShowSettings(false);
  _ae.freshFailed = false;
  _ae.clockRan = false;
  _aeEclipseButton(true);
  _aeSetSpeed(1);
  _aePauseAlmanac();
  // Back goes where the view was opened from: the Almanac's page (the hero,
  // the sky) or its solar system (the orrery).
  var back = _aeById('ae-back'), backText = _aeById('ae-back-text');
  if (backText) _aeSetText(backText, _aeT(_aeFrom === 'orrery' ? 'alm_solar_system' : 'almanac'));
  if (back) back.focus({ preventScroll: true });
  _aeLoadSats();
  if (_aeReady()) { _aeLoadMaps(_ae.gl); _aeResize(); _aeEnter(); _aeKick(); return; }
  _aeCoverAlmanac(true);
  if (_ae.failed) { _aeMessage(_aeT('alm_earth_nogl')); return; }
  _aeMessage(_aeT('alm_earth_loading'));
  _aePrepare().then(function (ok) {
    if (!_aeIsOpen) return;
    if (!ok) { _aeMessage(_aeT(_ae.failed ? 'alm_earth_nogl' : 'alm_earth_unavailable')); return; }
    _aeMessage('');
    _aeResize();
    _aeEnter();
    _aeKick();
  });
}

// Close: back into the hero when the view came from it and it is there to
// go back to, else at once. The page has the view's moment first, so the
// hero it lands in shows it.
function _aeClose() {
  if (!_aeIsOpen || (_ae.hand && _ae.hand.dir < 0)) return;
  _aeLandClock();
  var frame = _ae.fromHero && _aeReady() && !_ae.el.classList.contains('ae-blank') &&
    (typeof _almanacOpen === 'undefined' || _almanacOpen) ? _aeHeroFrame() : null;
  if (frame) _aeHandOut(frame);
  else _aeFinishClose();
}
function _aeFinishClose() {
  if (!_aeIsOpen) return;
  _aeLandClock();
  _aeIsOpen = false;
  if (_ae.raf) { cancelAnimationFrame(_ae.raf); _ae.raf = 0; }
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  _ae.hand = null;
  _aeHandReset();
  _ae.el.classList.remove('open');
  _ae.pointers = {}; _ae.drag = _ae.pinch = null;
  // The drawing buffer is the most the view holds (a screen of pixels, tens
  // of MB on a phone, where iOS ends tabs that hold too much). Closed, it
  // shrinks to a pixel; the scene and its maps stay, so coming back is
  // instant, and _aeResize gives the buffer its size again.
  if (_ae.gl) {
    _ae.gl.renderer.setSize(1, 1, false);
    if (_ae.gl.camera.view) _ae.gl.camera.clearViewOffset();
  }
  _aeLiftHero(false);
  _aeCoverAlmanac(false);
  if (typeof _almanacOpen === 'undefined' || _almanacOpen) {
    _aeResumeAlmanac();
    if (_ae.placeChanged && typeof _almRepaintFocus === 'function') _almRepaintFocus();
  }
  _ae.placeChanged = false;
  // Focus goes back where the view came from; its ring shows only to someone
  // who left by the keyboard (a ring round the Moon after a tap is noise).
  var fromHero = _ae.fromHero, from = _aeFrom;
  var backEl = function () { return fromHero ? document.querySelector(AE_HERO_SEL) : _aeById(from === 'sky' ? 'almanac-sky-canvas' : 'almanac-orrery'); };
  var focusOpts = { preventScroll: true, focusVisible: !!_ae.closedByKey };
  // Under reduced motion every property eases over 0.01 ms (app.css), the
  // visibility each element inherits too, one level a frame: the page
  // uncovered this instant is hidden to focus for a few frames yet. On a
  // loaded machine that is more frames than a count covers, and the hero
  // may be drawn again meanwhile (a new element): so it is looked up on
  // every try, for a time rather than a number of frames, and a focus the
  // reader has put somewhere else in the meantime is left where it is.
  var until = performance.now() + AE_FOCUS_MS;
  (function land() {
    if (_aeIsOpen) return;
    var a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement && !_ae.el.contains(a)) {
      var b0 = backEl();
      if (a !== b0) return;
    }
    var back = backEl();
    if (back && back.focus) back.focus(focusOpts);
    if ((!back || document.activeElement !== back) && performance.now() < until) requestAnimationFrame(land);
  })();
  _ae.closedByKey = false;
  // Found unsupported, the orrery drops its Earth glow; a paused orrery
  // (1x) draws nothing by itself, so give it the frame without.
  if (openAlmanacEarth.unsupported && typeof _orrerySyncToFocus === 'function') _orrerySyncToFocus();
  if (openAlmanacEarth.unsupported && typeof _orreryRenderHint === 'function') _orreryRenderHint();
}

// Give the GPU back: every geometry, material and map, then the context
// itself (a live context counts against the tab even when nothing draws).
// A lost context cannot be had again from the same canvas, so a fresh one
// takes its place; the next open builds the scene afresh on it.
function _aeDisposeGl() {
  var S = _ae && _ae.gl;
  if (!S) return;
  _ae.gl = null;
  _ae.ready = false;
  _ae.scene = null;
  _ae.ringsAt = _ae.issRingAt = _ae.moonPathAt = null;
  S.scene.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (!o.material) return;
    var u = o.material.uniforms || {};
    for (var k in u) if (u[k].value && u[k].value.isTexture) u[k].value.dispose();
    o.material.dispose();
  });
  S.renderer.dispose();
  S.renderer.forceContextLoss();
  // The labels were pinned to that scene; the next one's frames pin them again.
  ['ae-lbl-moon', 'ae-lbl-iss', 'ae-lbl-you', 'ae-lbl-shadow'].forEach(function (id) {
    var label = _aeById(id);
    if (label) label.hidden = true;
  });
  var old = _aeById('ae-canvas');
  if (old && old.parentNode) {
    var fresh = old.cloneNode(false);
    old.parentNode.replaceChild(fresh, old);
    _aeBindCanvas(fresh);
  }
}

// Leaving the Almanac (almanac.js _almanacTeardown): the view closes and
// gives the GPU back.
function _aeRelease() {
  if (!_ae) return;
  _ae.wanted = false;
  _aeFinishClose();
  _aeDisposeGl();
}

window.openAlmanacEarth = openAlmanacEarth;
// The orrery, drawn before this file ran, can now say Earth opens in 3D.
if (typeof _orreryRenderHint === 'function') _orreryRenderHint();
// This file loads after the Almanac has painted; the view gets ready behind it.
if (typeof requestAnimationFrame === 'function' && (typeof _almanacOpen === 'undefined' || _almanacOpen)) _aePrepareWhenIdle();
