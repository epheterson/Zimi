// ── Almanac ephemeris: where the Sun, the Moon and the planets are ──
// One source of positions for every Almanac view. Pure functions and tables:
// no WebGL, no DOM, no clock, so the numbers can be tested alone and the scenes
// on top (the Earth view, the live sky) can change
// without touching them. Loaded after almanac-orrery.js (its Keplerian planets,
// AU_KM) and before almanac-earth.js; the Julian Day
// helpers are almanac.js's, called only when a position is asked for.
//
//   Sun    VSOP87D (Bretagnon & Francou), apparent place of date: _aeSun
//   Moon   Meeus ch. 47, the full tables, apparent place of date: _aeMoon
//   Planets  JPL's approximate Keplerian elements (Standish): _planetHelio3D
//
// Two frames, one conversion between them:
//   of date    the true equator and equinox of the instant (what the Earth view
//              and the sky use: RA/Dec, sidereal time)
//   J2000      the heliocentric ecliptic of 2000 January 1.5 (what the flown
//              solar system draws: AU, x toward the J2000 equinox)
// _ephMoonGeoJ2000, _ephEarthHelioJ2000 and _ephBodyJ2000 are the J2000 frame;
// _ephEqOfDateToEclJ2000 and its inverse are the conversion.

// ── Constants and angles ──
var AE_ARCSEC_TO_DEG = 1 / 3600;
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

// ── Small vector helpers ──
function _aeDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _aeAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function _aeSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _aeLen(a) { return Math.sqrt(_aeDot(a, a)); }
function _aeScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function _aeNorm(a) { return _aeScale(a, 1 / _aeLen(a)); }
function _aeCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
// Angle between two directions, stable for tiny angles (atan2 of the cross and
// dot products; acos loses everything below ~1e-4 rad in float arithmetic).
function _aeAngle(a, b) { return Math.atan2(_aeLen(_aeCross(a, b)), _aeDot(a, b)); }

// ── Turning a vector (active rotations, right-handed) ──
function _aeRotX(v, ang) {
  var c = Math.cos(ang), s = Math.sin(ang);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
function _aeRotY(v, ang) {
  var c = Math.cos(ang), s = Math.sin(ang);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}
function _aeRotZ(v, ang) {
  var c = Math.cos(ang), s = Math.sin(ang);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

// ── One frame: the heliocentric ecliptic of J2000, AU ──
// Moving between the two frames takes the Lieske / IAU 2006 precession angles
// (Meeus 21.2: zeta, z, theta from J2000, arcseconds, as polynomial coefficients
// in T Julian centuries), the mean obliquity of date, and the nutation that the
// apparent places above carry. The equator and the ecliptic of J2000 are one
// turn apart by the J2000 obliquity.
var EPH_OBLIQUITY_DEG = AE_OBLIQUITY_J2000_ARCSEC / 3600;
var EPH_PREC_ZETA = [2306.2181, 0.30188, 0.017998];    // arcseconds: T, T^2, T^3
var EPH_PREC_Z = [2306.2181, 1.09468, 0.018203];
var EPH_PREC_THETA = [2004.3109, -0.42665, -0.041833];

function _ephPrecAngle(c, T) { return _aeRad((c[0] * T + c[1] * T * T + c[2] * T * T * T) * AE_ARCSEC_TO_DEG); }

// A vector on the mean equator of J2000 -> the mean equator of date (T from J2000, centuries), and back.
function _ephPrecess(v, T) {
  return _aeRotZ(_aeRotY(_aeRotZ(v, _ephPrecAngle(EPH_PREC_ZETA, T)), -_ephPrecAngle(EPH_PREC_THETA, T)), _ephPrecAngle(EPH_PREC_Z, T));
}
function _ephUnprecess(v, T) {
  return _aeRotZ(_aeRotY(_aeRotZ(v, -_ephPrecAngle(EPH_PREC_Z, T)), _ephPrecAngle(EPH_PREC_THETA, T)), -_ephPrecAngle(EPH_PREC_ZETA, T));
}

// A vector on the mean ecliptic and equinox of date -> the J2000 ecliptic, and back.
function _ephMeanEclDateToEclJ2000(v, T) {
  var eps0 = _aeRad(_aeNutation(T).eps0);
  return _aeRotX(_ephUnprecess(_aeRotX(v, eps0), T), -_aeRad(EPH_OBLIQUITY_DEG));
}
function _ephEclJ2000ToMeanEclDate(v, T) {
  var eps0 = _aeRad(_aeNutation(T).eps0);
  return _aeRotX(_ephPrecess(_aeRotX(v, _aeRad(EPH_OBLIQUITY_DEG)), T), -eps0);
}

// A vector on the true equator and equinox of date (what the Earth view and
// the sky use) -> the J2000 ecliptic, and back. jde is TT.
function _ephEqOfDateToEclJ2000(v, jde) {
  var T = (jde - JD_J2000) / JULIAN_CENTURY, nut = _aeNutation(T);
  var trueEcl = _aeRotX(v, -_aeRad(nut.eps));
  return _ephMeanEclDateToEclJ2000(_aeRotZ(trueEcl, -_aeRad(nut.dpsi)), T);
}
function _ephEclJ2000ToEqOfDate(v, jde) {
  var T = (jde - JD_J2000) / JULIAN_CENTURY, nut = _aeNutation(T);
  var trueEcl = _aeRotZ(_ephEclJ2000ToMeanEclDate(v, T), _aeRad(nut.dpsi));
  return _aeRotX(trueEcl, _aeRad(nut.eps));
}

// Spherical (longitude and latitude in degrees, radius) to a vector.
function _ephSphericalVec(lonDeg, latDeg, r) {
  var lo = _aeRad(lonDeg), la = _aeRad(latDeg);
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
}

// The Moon from the Earth's centre, AU, J2000 ecliptic, at UT Julian Day jd:
// _aeMoon's apparent longitude and latitude of date, turned to J2000.
function _ephMoonGeoJ2000(jd) {
  var jde = jd + _aeDeltaTDays(jd), T = (jde - JD_J2000) / JULIAN_CENTURY, q = _aeMoon(jde);
  var trueEcl = _ephSphericalVec(q.lon, q.lat, q.distKm / AU_KM);
  return _ephMeanEclDateToEclJ2000(_aeRotZ(trueEcl, -_aeRad(_aeNutation(T).dpsi)), T);
}

// The Earth from the Sun, AU, J2000 ecliptic: VSOP87D's heliocentric longitude,
// latitude and radius (the Sun's place above, the other way round), mean equinox
// of date turned back to J2000. The Earth itself, not the Earth-Moon barycentre
// the planets' Keplerian elements describe (4700 km off).
function _ephEarthHelioJ2000(jd) {
  var jde = jd + _aeDeltaTDays(jd), tau = (jde - JD_J2000) / AE_DAYS_PER_JULIAN_MILLENNIUM;
  var v = _ephSphericalVec(_aeDeg(_aeVsopSum(AE_VSOP_L, tau)), _aeDeg(_aeVsopSum(AE_VSOP_B, tau)), _aeVsopSum(AE_VSOP_R, tau));
  return _ephMeanEclDateToEclJ2000(v, (jde - JD_J2000) / JULIAN_CENTURY);
}

// A body from the Sun, AU, J2000 ecliptic: 'Sun', 'Earth' and 'Moon' from the
// series above, the planets from their elements.
function _ephBodyJ2000(name, jd) {
  if (name === 'Sun') return [0, 0, 0];
  if (name === 'Earth') return _ephEarthHelioJ2000(jd);
  if (name === 'Moon') {
    var e = _ephEarthHelioJ2000(jd), m = _ephMoonGeoJ2000(jd);
    return [e[0] + m[0], e[1] + m[1], e[2] + m[2]];
  }
  var p = _planetHelio3D(name, _jdToJulianCentury(jd));
  return [p.x, p.y, p.z];
}
