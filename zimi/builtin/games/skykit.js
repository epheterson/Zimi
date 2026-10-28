/* ZimiGames: the sky, worked out on the page. Where the Sun, Moon, naked-eye planets and the brightest stars are in the sky of a
   place and a moment, from low-precision formulas (good to about a degree, which is all a game that asks "which one is that?"
   needs): the Sun and Moon from mean elements and their main terms, Mercury to Saturn from the mean Keplerian elements of
   JPL's "Approximate Positions of the Planets" (valid 1800 to 2050), the stars from a list of positions. Nothing is fetched,
   so it works the same in Zimi, Kiwix and from a folder. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Sky = {};
  var RAD = Math.PI / 180, DEG = 180 / Math.PI, J2000 = 2451545, DAY_MS = root.ZimiUtil.DAY_MS, UNIX_JD = 2440587.5, OBLIQUITY = 23.43928;
  function norm(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  Sky.julian = function (ms) { return ms / DAY_MS + UNIX_JD; };
  Sky.msOf = function (jd) { return (jd - UNIX_JD) * DAY_MS; };

  // Ecliptic longitude and latitude (degrees) to right ascension and declination (degrees) at obliquity eps.
  function equatorial(lon, lat, eps) {
    var l = lon * RAD, b = lat * RAD, e = eps * RAD;
    var ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    var dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    return { ra: norm(ra * DEG), dec: dec * DEG };
  }
  // Positions given for J2000 (planets, stars) moved to the date by precession: about 50 arcseconds a year.
  var PREC_RA = 0.01281, PREC_DEC = 0.005565;   // degrees a year (the constants m and n of the low-precision formula, in degrees)
  function precess(ra, dec, jd) {
    var years = (jd - J2000) / 365.25, a = ra * RAD, d = dec * RAD;
    return { ra: norm(ra + (PREC_RA + PREC_DEC * Math.sin(a) * Math.tan(d)) * years), dec: dec + PREC_DEC * Math.cos(a) * years };
  }

  // The Sun: mean longitude and anomaly, the equation of centre, of the date.
  Sky.sun = function (jd) {
    var n = jd - J2000, L = norm(280.46 + 0.9856474 * n), g = norm(357.528 + 0.9856003 * n) * RAD;
    var lon = L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g), eps = OBLIQUITY - 0.0000004 * n;
    var e = equatorial(lon, 0, eps);
    e.lon = norm(lon); e.mag = -26.7;
    return e;
  };

  // The Moon: the largest terms of its longitude and latitude (about a third of a degree), and its phase from the elongation.
  Sky.moon = function (jd) {
    var n = jd - J2000, L = norm(218.316 + 13.176396 * n), M = norm(134.963 + 13.064993 * n) * RAD, F = norm(93.272 + 13.22935 * n) * RAD;
    var D = norm(297.85 + 12.190749 * n) * RAD, Ms = norm(357.529 + 0.98560028 * n) * RAD;
    var lon = L + 6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * M) - 0.186 * Math.sin(Ms) - 0.114 * Math.sin(2 * F);
    var lat = 5.128 * Math.sin(F) + 0.281 * Math.sin(M + F) + 0.278 * Math.sin(M - F);
    var e = equatorial(lon, lat, OBLIQUITY - 0.0000004 * n);
    var elong = norm(lon - Sky.sun(jd).lon);
    e.lon = norm(lon); e.mag = -12.5; e.elongation = elong;
    e.illumination = (1 - Math.cos(elong * RAD)) / 2;   // the lit share of the disc
    e.waxing = elong < 180;
    return e;
  };

  // Mean elements at J2000 and their change a century: a, e, I, L, longitude of perihelion, longitude of the node.
  var ELEMENTS = {
    mercury: [[0.38709927, 0.00000037], [0.20563593, 0.00001906], [7.00497902, -0.00594749], [252.2503235, 149472.67411175], [77.45779628, 0.16047689], [48.33076593, -0.12534081]],
    venus: [[0.72333566, 0.0000039], [0.00677672, -0.00004107], [3.39467605, -0.0007889], [181.9790995, 58517.81538729], [131.60246718, 0.00268329], [76.67984255, -0.27769418]],
    earth: [[1.00000261, 0.00000562], [0.01671123, -0.00004392], [-0.00001531, -0.01294668], [100.46457166, 35999.37244981], [102.93768193, 0.32327364], [0, 0]],
    mars: [[1.52371034, 0.00001847], [0.0933941, 0.00007882], [1.84969142, -0.00813131], [-4.55343205, 19140.30268499], [-23.94362959, 0.44441088], [49.55953891, -0.29257343]],
    jupiter: [[5.202887, -0.00011607], [0.04838624, -0.00013253], [1.30439695, -0.00183714], [34.39644051, 3034.74612775], [14.72847983, 0.21252668], [100.47390909, 0.20469106]],
    saturn: [[9.53667594, -0.0012506], [0.05386179, -0.00050991], [2.48599187, 0.00193609], [49.95424423, 1222.49362201], [92.59887831, -0.41897216], [113.66242448, -0.28867794]]
  };
  // The apparent magnitude at one astronomical unit from both Sun and Earth (the planet's own brightness); distances scale it.
  var ABS_MAG = { mercury: -0.42, venus: -4.4, mars: -1.52, jupiter: -9.4, saturn: -8.9 };
  // A planet's brightness changes with its phase and distance by more than this simple formula knows (Venus is never -7.9): the
  // range each really keeps.
  var MAG_RANGE = { mercury: [-1.5, 1.5], venus: [-4.8, -3.3], mars: [-2.9, 1.8], jupiter: [-2.9, -1.6], saturn: [-0.3, 1.3] };
  var KEPLER_STEPS = 12;

  function heliocentric(name, jd) {
    var T = (jd - J2000) / 36525, el = ELEMENTS[name].map(function (p) { return p[0] + p[1] * T; });
    var a = el[0], e = el[1], I = el[2] * RAD, L = el[3], peri = el[4], node = el[5] * RAD;
    var M = norm(L - peri) * RAD, w = (peri - el[5]) * RAD, E = M;
    for (var i = 0; i < KEPLER_STEPS; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    var xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    var cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(I), si = Math.sin(I);
    return {
      x: (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
      y: (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
      z: (sw * si) * xp + (cw * si) * yp
    };
  }
  // A planet as seen from the Earth: right ascension and declination of the date, distance (AU), magnitude and elongation.
  Sky.planet = function (name, jd) {
    var p = heliocentric(name, jd), e = heliocentric('earth', jd);
    var x = p.x - e.x, y = p.y - e.y, z = p.z - e.z, eps = OBLIQUITY * RAD;
    // heliocentric J2000 ecliptic -> geocentric equatorial J2000
    var xe = x, ye = y * Math.cos(eps) - z * Math.sin(eps), ze = y * Math.sin(eps) + z * Math.cos(eps);
    var d = Math.sqrt(x * x + y * y + z * z), r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    var ra = norm(Math.atan2(ye, xe) * DEG), dec = Math.asin(ze / d) * DEG, now = precess(ra, dec, jd);
    var sun = Sky.sun(jd), cosElong = Math.sin(dec * RAD) * Math.sin(sun.dec * RAD) + Math.cos(dec * RAD) * Math.cos(sun.dec * RAD) * Math.cos((ra - sun.ra) * RAD);
    return { ra: now.ra, dec: now.dec, distance: d, mag: clamp(ABS_MAG[name] + 5 * Math.log10(r * d), MAG_RANGE[name][0], MAG_RANGE[name][1]), elongation: Math.acos(clamp(cosElong, -1, 1)) * DEG };
  };

  // Right ascension (hours), declination, magnitude: the brightest stars, J2000.
  Sky.STARS = [
    ['Sirius', 6.752, -16.716, -1.46], ['Canopus', 6.399, -52.696, -0.74], ['Rigil Kentaurus', 14.66, -60.834, -0.01], ['Arcturus', 14.261, 19.182, -0.05],
    ['Vega', 18.616, 38.784, 0.03], ['Capella', 5.278, 45.998, 0.08], ['Rigel', 5.242, -8.202, 0.13], ['Procyon', 7.655, 5.225, 0.34], ['Achernar', 1.629, -57.237, 0.46],
    ['Betelgeuse', 5.919, 7.407, 0.5], ['Hadar', 14.064, -60.373, 0.61], ['Altair', 19.846, 8.868, 0.76], ['Acrux', 12.443, -63.099, 0.76], ['Aldebaran', 4.599, 16.509, 0.86],
    ['Antares', 16.49, -26.432, 0.96], ['Spica', 13.42, -11.161, 0.97], ['Pollux', 7.755, 28.026, 1.14], ['Fomalhaut', 22.961, -29.622, 1.16], ['Deneb', 20.69, 45.28, 1.25],
    ['Mimosa', 12.795, -59.689, 1.25], ['Regulus', 10.14, 11.967, 1.35], ['Adhara', 6.977, -28.972, 1.5], ['Castor', 7.577, 31.888, 1.58], ['Gacrux', 12.519, -57.113, 1.6],
    ['Shaula', 17.56, -37.104, 1.62], ['Bellatrix', 5.419, 6.35, 1.64], ['Elnath', 5.438, 28.608, 1.65], ['Miaplacidus', 9.22, -69.717, 1.68], ['Alnilam', 5.604, -1.202, 1.69],
    ['Alnair', 22.137, -46.961, 1.74], ['Alioth', 12.9, 55.96, 1.77], ['Alnitak', 5.679, -1.943, 1.77], ['Dubhe', 11.062, 61.751, 1.79], ['Mirfak', 3.405, 49.861, 1.8],
    ['Wezen', 7.14, -26.393, 1.84], ['Kaus Australis', 18.403, -34.385, 1.85], ['Alkaid', 13.792, 49.313, 1.86], ['Menkalinan', 5.992, 44.948, 1.9], ['Polaris', 2.53, 89.264, 1.98],
    ['Hamal', 2.12, 23.462, 2.0], ['Alphard', 9.46, -8.659, 2.0], ['Rasalhague', 17.582, 12.56, 2.08], ['Kochab', 14.845, 74.156, 2.08], ['Algol', 3.136, 40.956, 2.1]
  ];

  Sky.gmst = function (jd) { return norm(280.46061837 + 360.98564736629 * (jd - J2000)); };
  // Altitude and azimuth (degrees, azimuth from north through east) of a right ascension and declination, for a place (degrees, east positive).
  Sky.altaz = function (ra, dec, jd, lat, lon) {
    var ha = (Sky.gmst(jd) + lon - ra) * RAD, d = dec * RAD, f = lat * RAD;
    var sinAlt = Math.sin(d) * Math.sin(f) + Math.cos(d) * Math.cos(f) * Math.cos(ha);
    var alt = Math.asin(clamp(sinAlt, -1, 1));
    var az = Math.atan2(-Math.cos(d) * Math.sin(ha), Math.sin(d) * Math.cos(f) - Math.cos(d) * Math.sin(f) * Math.cos(ha));
    return { alt: alt * DEG, az: norm(az * DEG) };
  };

  // Everything bright enough to name, with where it is in a place's sky at a moment: [{id, kind, mag, alt, az, ...}], brightest first.
  Sky.objects = function (ms, lat, lon, starMag) {
    var jd = Sky.julian(ms), out = [], limit = starMag === undefined ? 2.2 : starMag;
    function add(id, kind, pos, extra) {
      var h = Sky.altaz(pos.ra, pos.dec, jd, lat, lon), o = { id: id, kind: kind, mag: pos.mag, alt: h.alt, az: h.az, ra: pos.ra, dec: pos.dec };
      for (var k in extra) o[k] = extra[k];
      out.push(o);
    }
    add('sun', 'sun', Sky.sun(jd));
    var m = Sky.moon(jd); add('moon', 'moon', m, { illumination: m.illumination, waxing: m.waxing });
    Object.keys(ELEMENTS).forEach(function (n) { if (n !== 'earth') { var p = Sky.planet(n, jd); add(n, 'planet', p, { elongation: p.elongation }); } });
    Sky.STARS.forEach(function (s) {
      if (s[3] > limit) return;
      var p = precess(s[1] * 15, s[2], jd);
      add(s[0].toLowerCase().replace(/ /g, '-'), 'star', { ra: p.ra, dec: p.dec, mag: s[3] }, { name: s[0] });
    });
    return out.sort(function (a, b) { return a.mag - b.mag; });
  };

  // The dome a person looks at, flat: zenith at the centre, horizon at radius 1, north up, east to the left as on the sky
  // seen from below. Returns {x, y} in [-1, 1].
  Sky.dome = function (alt, az) {
    var r = (90 - alt) / 90, a = az * RAD;
    return { x: -r * Math.sin(a), y: -r * Math.cos(a) };
  };

  root.SkyKit = Sky;
})(this);
