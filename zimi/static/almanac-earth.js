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
var AE_TEX_DAY = '/static/earth/earth-day-v1.webp';
var AE_TEX_NIGHT = '/static/earth/earth-night-v1.webp';
var AE_TEX_MOON = '/static/earth/moon-v1.webp';
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
var AE_SUN_POINT_PX = 30;
var AE_HINT_MS = 4500;
// Show where I am: a crosshair, the mark every map uses for "locate me".
var AE_LOCATE_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
var AE_LOCATE_TIMEOUT_MS = 15000;
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

function _aeT(key, vars) { return (typeof t === 'function') ? t(key, vars) : key; }
function _aeReduceMotion() { return (typeof _almReduceMotion === 'function') ? _almReduceMotion() : false; }
function _aeLink(key, html) { return window.AlmanacLinks ? window.AlmanacLinks.wrap(key, html) : html; }
function _aeLinked(key) { return !!(window.AlmanacLinks && window.AlmanacLinks.linkFor(key)); }
function _aeClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function _aeEaseOut(p) { return 1 - Math.pow(1 - p, 3); }
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
  '.ae-hint{position:absolute;left:50%;bottom:calc(100% - 18px);transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(0,0,0,.6);color:var(--text2);font-size:12px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .6s}',
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
      '<button type="button" class="ae-btn ae-back" id="ae-back"><span class="ae-chev" aria-hidden="true">‹</span> ' + _almEsc(_aeT('alm_solar_system')) + '</button>' +
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
      '<div class="ae-row" role="group" id="ae-views">' +
        '<button type="button" class="ae-btn" data-ae-view="earth" aria-pressed="true">' + _almEsc(_tp('Earth')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="sats" aria-pressed="false">' + _almEsc(_aeT('alm_earth_view_sats')) + '</button>' +
        '<button type="button" class="ae-btn" data-ae-view="moon" aria-pressed="false">' + _almEsc(_aeT('alm_moon')) + '</button>' +
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
  '  gl_FragColor = vec4(vec3(0.32, 0.58, 1.0) * edge * lit * 0.8, 1.0);',
  '}'
].join('\n');

// The Moon: sunlight, the Earth's shadow (with the dim copper light the
// Earth's atmosphere bends into it), and a little earthshine. Until its map
// is in (or if it never comes) the Moon is a plain grey of about the map's
// mean brightness, so it still shows its phase instead of black on black.
var AE_MOON_PLAIN_ALBEDO = 0.5;
var AE_MOON_FRAG = [
  'precision highp float;',
  'uniform sampler2D moonMap; uniform float moonMapped;',
  'uniform vec3 sunPos; uniform float sunR; uniform float earthR;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_OVERLAP,
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  vec3 L = normalize(sunPos - vWorld);',
  '  float mu = max(dot(N, L), 0.0);',
  '  float light = aeSunlight(vWorld, sunPos, sunR, vec3(0.0), earthR);',
  '  float albedo = mix(' + AE_MOON_PLAIN_ALBEDO.toFixed(2) + ', texture2D(moonMap, vUv).r, moonMapped);',
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
  var renderer, dpr = Math.min(window.devicePixelRatio || 1, AE_MAX_DPR);
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: dpr < AE_MSAA_BELOW_DPR, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);
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
  var moonUni = {
    moonMap: { value: null }, moonMapped: { value: 0 },
    sunPos: shared.sunPos, sunR: shared.sunR, earthR: { value: AE_SHADOW_ENLARGE }
  };
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
function _aeLoadMap(S, uni, url) {
  if (!S.maps[url]) {
    S.maps[url] = _aeLoadTexture(S.THREE, url).then(function (tx) {
      tx.anisotropy = S.aniso;
      uni.value = tx;
      return true;
    }, function () {
      delete S.maps[url];
      return false;
    }).then(function (ok) {
      S.mapFailed[url] = !ok;
      _ae.dirty = true;
      _aeKick();
      return ok;
    });
  }
  return S.maps[url];
}
// Loads whatever maps are not in yet; resolves with whether the day map is.
function _aeLoadMaps(S) {
  _aeLoadMap(S, S.earthUni.nightMap, AE_TEX_NIGHT);
  _aeLoadMap(S, S.moonUni.moonMap, AE_TEX_MOON).then(function (ok) { if (ok) S.moonUni.moonMapped.value = 1; });
  return _aeLoadMap(S, S.earthUni.dayMap, AE_TEX_DAY);
}

// ── State ──
function _aeNewState(el) {
  return {
    el: el, gl: null, loading: false, failed: false,
    speed: 1, offset: 0,                  // this view's own clock on top of the Almanac's
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

// The instant on display: the orrery's, since this view is a close-up of its
// Earth (almanac-orrery.js _orrerySimTime: the Almanac's time machine when it
// is set, else now plus what the orrery's speed and rides have run up), plus
// whatever this view's own speed has run up.
function _aeDisplayMs() {
  var base = (typeof _orrerySimTime === 'function') ? _orrerySimTime() : Date.now();
  return base + (_ae ? _ae.offset : 0);
}
// Live: nothing has moved the clock off now (the view's own offset may
// cancel the orrery's scenery spin, _aeOpenOffset).
function _aeIsLive() {
  var focus = typeof _almFocus !== 'undefined' && _almFocus;
  var orrery = typeof _orreryTimeOffset !== 'undefined' ? _orreryTimeOffset : 0;
  return !focus && !!_ae && _ae.offset + orrery === 0 && _ae.speed === 1;
}
// Where the view's clock starts: the moment the Almanac or the orrery was
// set to when someone set one (the time machine, the speed slider, a ride),
// now otherwise. The orrery spins fast from the start as scenery, so a first
// open landed weeks ahead and was rarely live.
function _aeOpenOffset() {
  if (typeof _almFocus !== 'undefined' && _almFocus) return 0;
  return typeof _orreryAmbientOffset === 'function' ? -_orreryAmbientOffset() : 0;
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

// The Moon keeps one face to the Earth: its map's longitude 0 (local +x)
// points home, its pole along the ecliptic's (the 1.5 degree tilt and the
// librations are left out).
function _aeOrientMoon(sc) {
  var S = _ae.gl;
  var eps = _aeRad(sc.sunEq.nut.eps);
  var z = [0, -Math.sin(eps), Math.cos(eps)];
  var home = _aeNorm(_aeScale(sc.moon, -1));
  var x = _aeNorm(_aeSub(home, _aeScale(z, _aeDot(home, z))));
  var y = _aeCross(z, x);
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
  _aeOrientMoon(sc);
  var sd = _aeScale(_aeNorm(sc.sun), AE_STAR_RADIUS * 0.98);
  _aeSetPoint(S.sunDot, 0, sd, AE_SUN_COLOR, 1, AE_SUN_POINT_PX);
  _aeCommitPoints(S.sunDot, 1);
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
  for (var i = 0; i < _ae.positions.length; i++) {
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
  var sc = _ae.scene;
  if (sc && _ae.target !== 'moon' && !_aeBehindEarth(sc.moon)) {
    var m = _aeProject(sc.moon);
    if (m && Math.hypot(m.x - x, m.y - y) < AE_TAP_RADIUS_PX * 1.5) { _aePreset('moon'); return; }
  }
  if (_ae.selected) { _ae.selected = null; _aeRenderCard(); _ae.dirty = true; _aeKick(); }
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
  return !!(_ae.fly || _ae.drag || _ae.pinch || _ae.speed > 1);
}
function _aeFrame() {
  _ae.raf = 0;
  if (!_aeIsOpen || document.hidden) return;
  if (typeof _almanacOpen !== 'undefined' && !_almanacOpen) { _aeClose(); return; }
  var now = performance.now();
  var dt = _ae.lastTs ? Math.min(now - _ae.lastTs, 1000) : 0;
  _ae.lastTs = now;
  if (_ae.speed > 1) _ae.offset += dt * (_ae.speed - 1);
  var ms = _aeDisplayMs();
  var busy = _aeStepFly(now) || _aeBusy();
  if (_ae.gl && (_ae.dirty || busy || now - _ae.lastRender >= AE_IDLE_RENDER_MS)) {
    _aeUpdate(ms);
    _ae.gl.renderer.render(_ae.gl.scene, _ae.gl.camera);
    _aeUpdateLabels();
    _ae.lastRender = now;
    _ae.dirty = false;
  }
  if (now - _ae.lastText >= AE_TEXT_TICK_MS) { _aeUpdateText(ms); _ae.lastText = now; }
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
    f.toDist = _aeClamp(f.toDist * factor, _aeMinDist(), AE_MAX_DIST);
    f.from.dist = _aeClamp(f.from.dist * factor, _aeMinDist(), AE_MAX_DIST);
  }
  _ae.dist = _aeClamp(_ae.dist * factor, _aeMinDist(), AE_MAX_DIST);
  _ae.preset = null;
  _aeMarkViews();
  _ae.dirty = true;
  _aeKick();
}
function _aeTurnBy(dAz, dEl) {
  _ae.fly = null;
  _ae.az += dAz;
  _ae.el_ = _aeClamp(_ae.el_ + dEl, -AE_MAX_ELEVATION, AE_MAX_ELEVATION);
  _ae.dirty = true;
  _aeKick();
}
function _aeDragScale() {
  var surface = _ae.target === 'moon' ? AE_MOON_RADIUS_RE : 1;
  return _aeClamp((_ae.dist - surface) / _ae.dist, AE_DRAG_MIN_SCALE, 1);
}
// The canvas's own listeners: bound again to the fresh canvas that replaces
// one whose context was given back (_aeDisposeGl).
function _aeBindCanvas(canvas) {
  canvas.addEventListener('pointerdown', function (e) {
    if (_ae.setOpen) _aeShowSettings(false);   // a touch on the globe puts the panel away
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
      var k = AE_DRAG_RAD_PER_PX * _aeDragScale();
      _aeTurnBy(-dx * k, dy * k);
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
      _aeClose();
      return;
    }
    if (e.target !== _aeById('ae-canvas')) return;
    var handled = true;
    if (e.key === 'ArrowLeft') _aeTurnBy(AE_KEY_TURN, 0);
    else if (e.key === 'ArrowRight') _aeTurnBy(-AE_KEY_TURN, 0);
    else if (e.key === 'ArrowUp') _aeTurnBy(0, AE_KEY_TURN);
    else if (e.key === 'ArrowDown') _aeTurnBy(0, -AE_KEY_TURN);
    else if (e.key === '+' || e.key === '=') _aeZoomBy(1 / AE_KEY_ZOOM);
    else if (e.key === '-' || e.key === '_') _aeZoomBy(AE_KEY_ZOOM);
    else handled = false;
    if (handled) e.preventDefault();
  });
}

function _aeSetSpeed(speed) {
  _ae.speed = speed;
  var btns = document.querySelectorAll('#ae-time [data-ae-speed]');
  for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(+btns[i].getAttribute('data-ae-speed') === speed));
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
  _ae.offset = 0;
  _ae.ringsAt = _ae.issRingAt = _ae.moonPathAt = null;
  _aePauseAlmanac();
  _aeSetSpeed(1);
}
// Hand a new instant to the Almanac itself, so the rest of it (the header,
// the calendar, the orrery) reads the same moment when the view closes.
function _aeGoTo(ms) {
  if (typeof _almScrubSettle === 'function') _almScrubSettle(new Date(ms));
  _aeJumped();
}
// Now for everything the view's clock is made of: the time machine and the
// orrery (its offset, its rides) go back to now with it.
function _aeNow() {
  if (typeof _almFocus !== 'undefined' && _almFocus && typeof _almBackToToday === 'function') _almBackToToday();
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
function _aeCoverAlmanac(on) {
  var c = _aeById('almanac-content');
  if (c) c.style.visibility = on ? 'hidden' : '';
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

// ── Open and close ──
function _aeStartView(THREE) {
  var S = _aeBuildGl(THREE, _aeById('ae-canvas'));
  if (!S) {
    _ae.failed = true;
    // The orrery stops offering what this browser cannot draw (its glow and
    // Earth's button go; Earth opens its article again).
    openAlmanacEarth.unsupported = true;
    _aeMessage(_aeT('alm_earth_nogl'));
    return;
  }
  _ae.gl = S;
  return _aeLoadMaps(S).then(function (dayMapIn) {
    if (_ae.gl !== S) return;   // the Almanac closed while it loaded
    if (!dayMapIn) { _aeDisposeGl(); _aeMessage(_aeT('alm_earth_unavailable')); return; }
    _aeMessage('');
    _aeResize();
    _aeEnter();
  });
}

// Where the opening flight arrives: over the chosen place (or the Almanac's
// stand-in for it), so the first thing seen is here, lit as it is now.
function _aeEnter() {
  var ms = _aeDisplayMs();
  _ae.scene = _aeSceneAt(ms);
  var loc = (typeof _getLocation === 'function') ? _getLocation() : { lat: 0, lon: 0 };
  var here = _aeFixedToScene(_aeGeodeticToFixed(_aeClamp(loc.lat, -_aeDeg(AE_START_MAX_LAT), _aeDeg(AE_START_MAX_LAT)), loc.lon), _ae.scene.gast);
  var azel = _aeAzElOf(here);
  _ae.target = 'earth';
  _ae.az = azel.az; _ae.el_ = azel.el;
  _ae.dist = _aeReduceMotion() ? _aeFitDist(AE_FIT_EARTH) : AE_FLY_START_DIST;
  _aePreset('earth');
  if (!_ae.hinted) { _ae.hinted = true; _aeShowHint(); }
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
    btn.setAttribute('aria-pressed', 'true');
    var sc = _ae.scene || _aeSceneAt(_aeDisplayMs());
    _ae.preset = 'earth';
    _aeFlyTo('earth', _aeFitDist(AE_FIT_EARTH), _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(lat, lon), sc.gast)));
  }, fail, { timeout: AE_LOCATE_TIMEOUT_MS, maximumAge: 60000 });
}

function openAlmanacEarth() {
  if (_aeIsOpen) return;
  _aeEnsureStyles();
  if (!_ae) {
    var el = _aeBuildDom();
    if (!el) return;
    _ae = _aeNewState(el);
    _aeBindControls();
    _aeBindKeys();
    _aeBindCanvas(_aeById('ae-canvas'));
  }
  _aeIsOpen = true;
  _ae.el.classList.add('open');
  _ae.offset = _aeOpenOffset();
  _ae.selected = null;
  _aeRenderCard();
  _aeShowSettings(false);
  _ae.freshFailed = false;
  _aeEclipseButton(true);
  _aeSetSpeed(1);
  _aePauseAlmanac();
  _aeCoverAlmanac(true);
  var back = _aeById('ae-back');
  if (back) back.focus({ preventScroll: true });
  _aeLoadSats();
  if (_ae.gl) { _aeLoadMaps(_ae.gl); _aeResize(); _aeEnter(); _aeKick(); return; }
  if (_ae.failed) { _aeMessage(_aeT('alm_earth_nogl')); return; }
  if (_ae.loading) return;
  _ae.loading = true;
  _aeMessage(_aeT('alm_earth_loading'));
  _aeLoadThree().then(function (THREE) {
    _ae.loading = false;
    if (!_aeIsOpen) return;
    return _aeStartView(THREE);
  }).catch(function () {
    _ae.loading = false;
    _aeMessage(_aeT('alm_earth_unavailable'));
  });
}

function _aeClose() {
  if (!_aeIsOpen) return;
  _aeIsOpen = false;
  if (_ae.raf) { cancelAnimationFrame(_ae.raf); _ae.raf = 0; }
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  _ae.el.classList.remove('open');
  _ae.pointers = {}; _ae.drag = _ae.pinch = null;
  // The drawing buffer is the most the view holds (a screen of pixels, tens
  // of MB on a phone, where iOS ends tabs that hold too much). Closed, it
  // shrinks to a pixel; the scene and its maps stay, so coming back from the
  // orrery is instant, and _aeResize gives the buffer its size again.
  if (_ae.gl) _ae.gl.renderer.setSize(1, 1, false);
  _aeCoverAlmanac(false);
  if (typeof _almanacOpen === 'undefined' || _almanacOpen) _aeResumeAlmanac();
  var orr = _aeById('almanac-orrery');
  if (orr && orr.focus) orr.focus({ preventScroll: true });
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
  _aeClose();
  _aeDisposeGl();
}

window.openAlmanacEarth = openAlmanacEarth;
// The orrery, drawn before this file ran, can now say Earth opens in 3D.
if (typeof _orreryRenderHint === 'function') _orreryRenderHint();
