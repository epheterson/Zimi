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
// The Earth's shadow is wider than the solid Earth: the atmosphere blocks
// sunlight too. Chauvenet's rule enlarges it by 1/50 (Meeus ch. 54).
var AE_SHADOW_ENLARGE = 1.02;
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

// (These two are the orbit view's own: the info corner reads the place under the picture's centre before the ground's code is in.)
// The orbit view's body now: its frame (body-fixed to scene) from what the view has drawn.
function _aeStBodyNow(key) {
  var S = _ae.gl, e;
  if (key === 'moon') e = S.moon.matrix.elements;
  else if (key === 'earth') {
    var c = Math.cos(S.earth.rotation.z), sn = Math.sin(S.earth.rotation.z);
    return { f: { x: [c, sn, 0], y: [-sn, c, 0], z: [0, 0, 1] } };
  } else if (S.planets[key] && S.planets[key].pos) e = S.planets[key].mesh.matrix.elements;
  if (!e) return null;
  return { f: { x: _aeNorm([e[0], e[1], e[2]]), y: _aeNorm([e[4], e[5], e[6]]), z: _aeNorm([e[8], e[9], e[10]]) } };
}
// Where the ray through a point of the screen meets the body: latitude and longitude, or null.
function _aeStHit(body, x, y) {
  var S = _ae.gl, cam = S.camera, V = S.THREE.Vector3, frame = _aeStBodyNow(body), centre = _aeBodyPos(body);
  if (!frame || !centre) return null;
  var o = _aeXyz(cam.position);
  var p = new V((x / _ae.w) * 2 - 1, -(y / _ae.h) * 2 + 1, 0.5).unproject(cam);
  var d = _aeNorm([p.x - o[0], p.y - o[1], p.z - o[2]]);
  var toFixed = function (v) { var f = frame.f; return [_aeDot(f.x, v), _aeDot(f.y, v), _aeDot(f.z, v)]; };
  var oc = _aeSub(o, centre);
  if (body === 'earth') {
    var h = _aeRayEllipsoid(toFixed(oc), toFixed(d));
    return h ? _aeFixedToGeodetic(h) : null;
  }
  var r = AE_TARGETS[body].surface, b = _aeDot(oc, d), c = _aeDot(oc, oc) - r * r, D = b * b - c;
  if (D < 0) return null;
  var t = -b - Math.sqrt(D);
  if (t < 0) return null;
  var q = _aeNorm(toFixed(_aeAdd(oc, _aeScale(d, t))));
  return _aeLatLonOf(q);
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
  var a1 = r1 * r1 * Math.acos(_aeClamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1));
  var a2 = r2 * r2 * Math.acos(_aeClamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1));
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
// Past that a GPS satellite keeps its dot, faded and marked approximate, rather than vanishing, out to AE_SAT_APPROX_DAYS. The window is SGP4's error growth: with no drag at 20,000 km
// what grows is the along-track error of the mean motion, about 1.5 km a day (the unmodelled slot changes of a constellation that keeps station add to it), so 1,100 days is about
// 1,650 km, a hundredth of the orbit's circumference, 0.26 Earth radii on the screen: still where the constellation was, to a dot's eye. Past it the planes have changed more than that
// (satellites retired, others launched) and nothing is drawn. The dot's strength falls in a straight line between the two.
var AE_SAT_APPROX_DAYS = 1100, AE_SAT_APPROX_ALPHA_FROM = 0.6, AE_SAT_APPROX_ALPHA_TO = 0.12;
function _aeSatApproxAlpha(ageDays) { return AE_SAT_APPROX_ALPHA_FROM + (AE_SAT_APPROX_ALPHA_TO - AE_SAT_APPROX_ALPHA_FROM) * _aeClamp((Math.abs(ageDays) - AE_SAT_WINDOW_DAYS) / (AE_SAT_APPROX_DAYS - AE_SAT_WINDOW_DAYS), 0, 1); }
var AE_ISS_EXACT_DAYS = 3;
var AE_ISS_DOT_DAYS = 14;
var AE_MINUTES_PER_DAY = 1440;
var AE_MS_PER_MINUTE = 60000;

// JS time of an element set's epoch, from satellite.js's Julian date.
function _aeSatEpochMs(satrec) { return (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY; }

// How an element set this many days from the displayed instant (either
// direction) is drawn: 'exact', 'approximate' (a faded dot), 'orbit' (the
// ISS's ring alone) or 'none'.
// `watched`: time running fast, or the view on the station. Then the ISS keeps its (approximate) dot past
// AE_ISS_DOT_DAYS: at an hour a second a fortnight passes in six minutes and the station went out like a light, and a
// flight to it had nothing to follow. Where along its orbit is the guess the faded dot and its label already own.
function _aeSatStanding(ageDays, isIss, watched) {
  var a = Math.abs(ageDays);
  if (!isIss) return a <= AE_SAT_WINDOW_DAYS ? 'exact' : a <= AE_SAT_APPROX_DAYS ? 'approximate' : 'none';
  if (a > AE_SAT_WINDOW_DAYS) return 'none';
  if (a <= AE_ISS_EXACT_DAYS) return 'exact';
  return a <= AE_ISS_DOT_DAYS || watched ? 'approximate' : 'orbit';
}

// SGP4 answers in TEME (true equator, mean equinox); the scene is on the
// true equinox, a turn of the equation of the equinoxes away. km -> Earth radii.
function _aeTemeToScene(pKm, eqeq) {
  return _aeScale(_aeRotZ(_aeXyz(pKm), eqeq), 1 / AE_EARTH_RADIUS_KM);
}
// The equation of the equinoxes (radians) for a scene.
function _aeEqEq(scene) {
  return _aeRad(scene.sunEq.nut.dpsi * Math.cos(_aeRad(scene.sunEq.nut.eps)));
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
var AE_THREE_URL = _almAsset('/static/earth/three-r186.min.js');
var AE_SGP4_URL = _almAsset('/static/earth/satellite-7.1.0.min.js');
var AE_TEX_DAY = _almAsset('/static/earth/earth-day-v1.webp');
var AE_TEX_NIGHT = _almAsset('/static/earth/earth-night-v1.webp');
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
var AE_NEAR_MIN = 2e-6;              // 13 m: over an Apollo site the camera comes within a kilometre of the ground
var AE_FAR = 40000;                   // Earth radii: past Neptune and the near probes as shown (_aeShownDist)
var AE_STAR_RADIUS = 25000;           // the star sphere, carried with the camera: behind every planet
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
// A flight between two bodies is one continuous move through an over-the-shoulder view: the camera eases back behind
// the body it leaves, off to one side so that body stands large in the foreground (its diameter this fraction of the
// narrower side of the frame, its centre this far out toward that side, in half-frames), turned to the destination,
// which is framed on the open side (centred this far out the other way), and carries on in without a stop.
var AE_FLY_APPROACH_MS = 1500, AE_FLY_TAIL_MS = 900;   // the leg to the shoulder, and what the leg in adds to the flight's own length
// The camera crawls through the shoulder view: its apparent speed (how fast the picture changes, a share of the
// nearer body's distance per second) holds at a small share of the pace either leg cruises at for AE_FLY_CRAWL_MS
// either side of it, and rises smoothly from there over AE_FLY_CRAWL_RAMP_MS. The leg to the shoulder eases in from rest
// over AE_FLY_EASE_IN_MS, and the leg in eases out to rest over AE_FLY_EASE_OUT_MS.
var AE_FLY_CRAWL_MS = 350, AE_FLY_CRAWL_RAMP_MS = 600, AE_FLY_CRAWL_SHARE = 0.04;
var AE_FLY_EASE_IN_MS = 500, AE_FLY_EASE_OUT_MS = 800, AE_FLY_TABLE_N = 240;
var AE_FLY_BEND_MS = 200, AE_FLY_BEND_REACH = 0.5;   // half the span over which the camera rounds the corner at the shoulder
var AE_SHOULDER_FILL = 1 / 3, AE_SHOULDER_OLD_AT = 0.55, AE_SHOULDER_DEST_AT = -0.3;
var AE_FLY_CLEAR = 1.6, AE_FLY_CLEAR_STEPS = 400;   // the nearest a planned flight's camera comes to any body, in its radii (planned to this; the test holds it to 1.35), and the steps the flight is checked at
var AE_FLY_MS_PER_LOG = 300;
// No flight turns the picture faster than this, in degrees a frame at 60 fps: a flight that would is stretched.
var AE_FLY_MAX_TURN_DEG = 4, AE_FLY_MAX_STRETCH = 4, AE_FRAME_MS = 1000 / 60, AE_FLY_PLAN_STEPS = 60;
// A body drawn smaller than this across is marked with a ring and its name; the mark fades out by the second size.
var AE_MARK_SMALL_PX = 24, AE_MARK_GONE_PX = 64, AE_MARK_SAME_PX = 6;   // marks closer than this: only the first
// Through a flight between bodies both ends wear a ring the size of the body as drawn (the Sun from the Moon's night
// side is nearly black, and a ring is all that outlines it): its radius plus this margin, never under the minimum,
// gone by the time the camera has arrived (the last share of the arrival).
var AE_RING_MARGIN_PX = 5, AE_RING_MIN_R_PX = 11, AE_RING_FADE_FROM = 0.7;
// A flight's ring eases toward shown or not with this time constant (it popped on and off while the camera swung round the
// corner of the approach), and the dot and name take over from it over AE_RING_HANDOFF_MS (they popped in at arrival).
var AE_RING_EASE_MS = 90, AE_RING_HANDOFF_MS = 350;
function _aeRingEase(el, want) {
  var now = performance.now(), gap = now - (el._aeEaseAt || 0), dt = gap < 250 ? gap : 16, op = el._aeRingOp || 0;   // (a ring begun after a pause starts from nothing)
  if (gap >= 250) op = 0;
  el._aeEaseAt = now;
  op += (want - op) * (1 - Math.exp(-dt / AE_RING_EASE_MS));
  if (Math.abs(want - op) < 0.01) op = want; else _ae.dirty = true;
  return (el._aeRingOp = op);
}
// A name hangs toward the middle of the screen; the mark it hangs from sits on the middle itself when the camera is on it, so
// the side it chose holds until the mark is this far over the middle the other way (it flapped left and right on arrival).
var AE_NAME_SIDE_HOLD_PX = 40;
// How much of a mark's dot and name shows after a flight's ring lets go of it: 0 as the ring goes, 1 once AE_RING_HANDOFF_MS has passed.
function _aeRingHandoff(el, ringed) {
  var now = performance.now();
  if (ringed) { el._aeRinged = true; el._aeHandAt = 0; return 1; }
  if (el._aeRinged) { el._aeRinged = false; el._aeHandAt = now; }
  if (!el._aeHandAt) return 1;
  var k = _smoothstep(0, AE_RING_HANDOFF_MS, now - el._aeHandAt);
  if (k >= 1) el._aeHandAt = 0; else _ae.dirty = true;
  return k;
}
function _aeNameOutLeft(el, x) {
  var half = _ae.w / 2, was = el._aeOutLeft;
  if (was === undefined || (was && x < half - AE_NAME_SIDE_HOLD_PX) || (!was && x > half + AE_NAME_SIDE_HOLD_PX)) was = x > half;
  return (el._aeOutLeft = was);
}
var AE_MARKED = [
  { body: 'earth', name: function () { return _tp('Earth'); } },
  { body: 'moon', name: function () { return _aeT('alm_moon'); } },
  { body: 'sun', name: function () { return _aeT('alm_sun'); } }
];
var AE_FLY_START_DIST = 40;           // the zoom in from the orrery starts this far out
var AE_STICK_R_PX = 56, AE_STICK_ZONE = 0.5;   // the thumb stick every vehicle shares: its reach, and the share of the picture (from the left, from the bottom) that is its
var AE_TAP_SLOP_PX = 6;               // a pointer that moved less than this was a tap
var AE_TAP_RADIUS_PX = 22;            // how near a tap must land to pick something
var AE_NAME_DIAG = 0.75;               // a mark's corner name stands off its ring this share of the radius each way
var AE_LABEL_DX = 8;                  // labels sit this far right of their point (CSS px)
var AE_YOU_GAP_PX = 8;                // You's ringed marker is wider than a dot: its word stands this much further off, clear of the ring
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
// It is chosen once, with the context, and the governor (capability.js) may later step the ratio well under where the
// view began: a limb drawn at 1x on a 3x screen with no multisampling is a staircase. An Apple GPU resolves the samples
// inside each tile, at little cost, so there a view that begins at up to this ratio is multisampled all along.
var AE_MSAA_APPLE_DPR = 2, AE_APPLE_GPU_RE = /apple/i;
function _aeMsaa(dpr) {
  if (dpr < AE_MSAA_BELOW_DPR) return true;
  return dpr <= AE_MSAA_APPLE_DPR && typeof ZimiCap !== 'undefined' && AE_APPLE_GPU_RE.test(ZimiCap.signals().renderer || '');
}
var AE_EARTH_SEGMENTS = [128, 64];
var AE_ATMO_SEGMENTS = [96, 48];
var AE_MOON_SEGMENTS = [64, 32];
var AE_ATMOSPHERE_SCALE = 1.018;      // the glow's shell, ~115 km above the surface
var AE_ANISOTROPY = 8;
var AE_TEXT_TICK_MS = 100;            // readouts and the GPS counter, while frames are drawn
// Nothing moving, the view asks for no frames: a timer this often (no animation frame) keeps the readouts on time and
// asks for a picture only when something changed or the clock has moved something on screen by AE_IDLE_MOVE_PX.
var AE_IDLE_TICK_MS = 1000;
var AE_IDLE_MOVE_PX = 0.5;
// The fastest thing the view draws near a body at real time, in Earth radii a second: Jupiter's equator (12.6 km/s;
// the ISS, 7.7 km/s, is next). Seen from `dist` it crosses this many px a second; the clock at a faster pace, faster.
var AE_IDLE_FASTEST_RE_S = 12.6 / 6371;
var AE_IDLE_SKY_RAD_S = 7.292e-5;      // on the ground (Stand here, side by side), the sky's turn: the Earth's rate
var AE_IDLE_NEAR_RE = 1e-4;           // the nearest a surface is taken to be (Earth radii), so a close-up is not infinite
var AE_IDLE_SMOOTH_PX_S = 4;           // the clock moving the picture this fast is drawn every frame, as any motion is
var AE_SAT_CAPACITY = 80;
var AE_GPS_RING_POINTS = 72;
var AE_ISS_RING_POINTS = 180;   // finest at the station (0.02 degrees apart), 4 degrees at the far side: a chord stands 4 km off its arc at most (the station is the middle vertex)
// Riding the station: the Earth turns under the camera as fast as the clock runs, the station standing still in the frame. An hour a
// second is 235 degrees of its orbit a second and is still a ride (the model still, the Earth turning under it); past
// AE_ISS_FAR_DEG_S of the orbit a second (a day a second flickers) the view eases out to the whole orbit (the ring in view, the
// station moving along it, the camera still) in AE_ISS_FAR_MS; it comes back under AE_ISS_NEAR_DEG_S.
var AE_FLY_STRAIGHT_FRAME = 0.85;   // (the station stays inside this share of the frame's narrower half-width on the way in)
var AE_FLY_STRAIGHT_KEEP = 2;   // (a flight in to the station: its look has gone over to it by the time the camera is this many gaps from the Earth)
var AE_ISS_FAR_DEG_S = 600, AE_ISS_NEAR_DEG_S = 450, AE_ISS_FAR_MS = 1500, AE_ISS_FAR_STEP_MAX_MS = 100, AE_ISS_FAR_FIT = 1.15, AE_ISS_FAR_SLIDE_FROM = 0.8, AE_ISS_FAR_CLEAR_RE = 1.02;
var AE_ORBIT_E_MIN = 1e-7;   // below this an orbit is round: no perigee to start from
var AE_RING_REFRESH_MS = 6 * 3600 * 1000;   // GPS orbits barely turn in six hours
var AE_MOON_PATH_HALF_DAYS = 13.66;   // half a sidereal month either side
var AE_MOON_PATH_STEP_HOURS = 6;
// Near the Moon the path is drawn in short steps: a 6-hour chord is about 3.5 Earth radii, thirteen times the Moon's
// radius, and up close it showed as corners. 10 minutes (0.09 degrees of its orbit) within half a day either side.
var AE_MOON_PATH_FINE_HOURS = 12, AE_MOON_PATH_FINE_STEP_MIN = 10;
var AE_MOON_PATH_REFRESH_MS = AE_MOON_PATH_FINE_HOURS * 3600 * 1000 / 2;   // the Moon never leaves the fine stretch
var AE_SAT_POINT_PX = 4;
var AE_SAT_SELECTED_PX = 9;
var AE_ISS_POINT_PX = 6;
var AE_ISS_FADED_ALPHA = 0.45;
// The Sun, drawn where it is but not at its distance or size: a disc 3,000
// Earth radii out along its true direction (the real one is ~23,500), about
// three times its true width, so it can be seen, and flown to, from here.
// Its light on the Earth and the Moon comes from the real Sun (sunPos).
var AE_SUN_SHOW_DIST = 3000;
var AE_SUN_SHOW_R = 40;               // ~0.76 degrees as seen from the Earth (real: 0.27); the Sun's true radius is 109 Earth radii (AE_SUN_RADIUS_RE): drawn at this size until decided
var AE_SUN_SEGMENTS = [48, 24];
var AE_SUN_GLOW_SCALE = 7;            // the glow's width, in the disc's radii
var AE_GRANULES_PER_RADIUS = 160;     // the granulation's cells (real: ~700, too fine to draw)
var AE_GRANULE_CONTRAST = 0.24;       // bright cells against dark lanes, at the disc's centre
var AE_GRANULE_LIFE_S = 600;          // a granule lives about ten minutes, on the page's clock
var AE_GRANULE_CYCLE = 512;           // the pattern's time, wrapped to keep a float's precision
var AE_SUN_EXPOSURE = [3.0, 1.9, 0.85];   // the photosphere's exposure per colour: pale gold centre (burnt out, the limb darkening is lost), deep orange limb
var AE_FIT_SUN = AE_SUN_SHOW_R * 2.2; // the disc and the glow nearest it
var AE_MIN_DIST_SUN = AE_SUN_SHOW_R * 1.3;
var AE_MAX_DIST_SUN = 100000;         // out from the Sun far enough to hold every planet's orbit as shown, on a phone
var AE_FLY_FAR_MS = 1600;             // the longest flight: to or from the Sun, 3,000 Earth radii
var AE_HINT_MS = 4500;
var AE_SHEET_SHUT_MS = 300;   // a tap this soon after a sheet closed is the tap that closed it
var AE_NORTH_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="ae-north-needle"><path d="M12 3l4 9h-8z" fill="currentColor"/><path d="M12 21l-4-9h8z" fill="currentColor" opacity=".45"/></svg>', AE_NORTH_MIN_RAD = 0.05;   // a way back to north-up after a twist: a white needle (its north end solid) that turns with it
var AE_MINI_PX = 96;   // the minimap's size (CSS px), as v1.15.7 ships it
var AE_ROW_DISC_PX = 40, AE_ROW_RING_PX = 3, AE_ROW_CLIP_PX = 8;   // the row's discs (almanac-earth.js _aeRowKeys): every one this size, the room the selected one's ring needs, and how many
var AE_RIM_ROOM_PX = 72, AE_RIM_GAP_PX = 16;   // what the row leaves at its end for the corner's one disc (12 + 44 + a gap); the controls layer says more (--ah-end) when more stands there
var AE_FOOT_PAD_PX = 16, AE_FIND_GAP_PX = 8;
var AE_FIND_ROOM_PX = 12 + 44 + AE_FIND_GAP_PX - AE_FOOT_PAD_PX;   // what the row leaves at its start for search: the corner's 12 px inset, its 44 px disc and a gap, less the foot's own padding
var AE_TRACK_RING_PX = 4;   // room at the track's start for the ring round the world in view
var AE_TRACK_FADE_PX = 28;   // a world passing either end of the track fades out over this, so none is cut by a hard edge
var AE_DRAWER_MAX = '40%';   // the drawer reaches this far down the view, and scrolls beyond
var AE_GO_STRIP_PX = 80;   // the search sheet on a portrait phone opens tall: this much of the 3D view stays under the band, above the sheet's top edge ("open that view way more")
var AE_HIT_PX = 44, AE_BAR_PX = 56;   // a finger's reach: every control of the 3D screen is at least this
var AE_TOPBAR_PX = 56;   // the page header's own height (app.css --under-topbar, less the notch)
var AE_BODY_CLASS = 'ae-3d';   // on the page's body while the view is open: the header floats over the picture
var AE_BARE_CLASS = 'ae-bare', AE_BARE_ANIM_CLASS = 'ae-bare-anim', AE_BARE_FADE_MS = 220;
// Show where I am: a crosshair, the mark every map uses for "locate me".
var AE_LOCATE_SVG = typeof ALM_LOCATE_SVG === 'string' ? ALM_LOCATE_SVG : '';   // almanac.js
// The info i as a type designer draws it: a dot, a flag to the left at the top of the stem, and a foot (a bare stroke
// read as a tick, Eric 2026-11-08: "the I button still doesn't feel right").
var AE_INFO_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12.4" cy="5.6" r="1.6" fill="currentColor" stroke="none"/><path d="M9.6 10h3v8.6M9.4 18.6h6"/></svg>';
// The view's two switches, as round buttons: a pin for the names of places, a ringed circle for the orbits.
var AE_PIN_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.5s-6.5-6.2-6.5-11.3a6.5 6.5 0 0 1 13 0c0 5.1-6.5 11.3-6.5 11.3z"/><circle cx="12" cy="10.2" r="2.3"/></svg>';
// Orbits as a gyroscope: the body, its ring, and the axis straight up through them (Eric 2026-11-08).
var AE_ORBIT_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6"/><ellipse cx="12" cy="12" rx="10" ry="3.2"/><path d="M12 1.5v21"/></svg>';
// Every active satellite (almanac-sats.js, loaded on the button's first press): a ring with dots on it.
var AE_SATS_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".55"/><circle cx="6.5" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="5.8" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.2" cy="14.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="9.5" cy="17.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="11.8" cy="11.2" r="1.5" fill="currentColor" stroke="none"/></svg>';
var AE_SATS_JS = _almAsset('/static/almanac-sats.js');
// What the all-satellites layer decides by (almanac-sats.js), kept here so the Almanac's constants pages can show it.
var AE_SATS_REF = {
  ageFreshDays: 3, ageGoneDays: 45,     // elements this young are drawn in full; past the second the satellite is not drawn
  leoMaxKm: 2000, geoMinKm: 35000,      // the orbit classes, by mean altitude
  passMinEl: 10, passSunAlt: -6,        // a pass counts above this elevation (degrees), with the Sun below this (civil twilight)
  passMag: 4.0,                         // and is listed to this estimated magnitude
  skyMag: 4.5,                          // a scene drawing the whole sky (almanac-sats.js _asSkyAsk) shows what a dark sky shows, to this magnitude
  albedo: 0.25, sunMag: -26.74,         // the brightness estimate: a diffuse sphere's reflectance, and the Sun's apparent magnitude
  areaM2: { iss: 6400, starlink: 3, oneweb: 2, iridium: 4 },   // the size assumed where SATCAT gives no radar cross-section; the ISS's is fitted: -1.8 at 1,000 km, half lit (McCants), about -3.8 overhead at dusk
  passMax: 16, loneStarlinks: 3,        // the list is cut to the most noticeable: single Starlinks to the brightest few, the rest by brightness and height
  minRcsM2: 1,                          // a satellite whose radar cross-section is below this is not offered as a pass
  trainGapS: 150, trainRaanDeg: 3,      // Starlinks this close in time and orbital plane (RAAN) are one train
  gpsMinEl: 5,                          // a GPS satellite is "overhead" above this elevation
  leoGoneDays: 14                       // a low-orbit satellite's elements run back to a date older than this are not drawn (drag and manoeuvres), well before the 45 days
};
// Fly (almanac-fly.js, loaded on the button's first press): a ship you steer through the solar system.
// The corner glyphs are one family: a 24 box, a stroke of 2 with round ends, the ink centred on the box (AH_CSS draws them at one size).
var AE_FLY_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="12.4" rx="9" ry="3.6"/><path d="M6.4 9.6C7.8 4.1 16.2 4.1 17.6 9.6"/><path d="M8.6 16l-1.3 2.4M15.4 16l1.3 2.4"/></svg>';   // the UFO: a lens with its dome, on two legs
var AE_FLY_JS = _almAsset('/static/almanac-fly.js');
// What the ship flies by (almanac-fly.js), kept here so the Almanac's constants pages can show it.
var AE_FLY_REF = {
  tauS: 0.5,                            // full throttle: seconds from the nearest surface (its speed is its height over that, a second): the time to contact, the same at every scale
  hugPitchDeg: 10, hugEps: 0.05,        // throttling forward at the lowest height over a world, the craft circles it unless its nose is up past this many degrees (or it is over the floor by this share)
  hoverM: 2,                            // the craft's underside over a ground that is drawn (almanac-standhost.js)
  bandShare: 0.0063,                    // the ground starts to show under a craft no higher than this share of the body's radius (40 km over the Earth)
  skimKm: 5,                            // the lowest it goes over a surface (the sphere is drawn without relief)
  deckShare: 0.01,                      // over a world of gas: the share of its radius it stops over the cloud tops, where the horizon and the bands still read
  arriveSpan: 2 / 3,                    // the autopilot stops where the world spans this share of the picture's shorter side
  arriveEase: 0.05,                     // its last approach is never slower than this share of the goal's radius in tauS (a pace that only halved would never arrive)
  clearRadii: 1.5,                      // it goes round a world in its way no nearer than this many of that world's radii from its middle
  craftM: 12.756,                       // the craft's width at its smallest (two millionths of the Earth's radius); near a drawn ground its speed is never figured from less height than this
  detent: 0.14,                         // the throttle within this share of its travel of the middle is at stop
  flareFrom: 0.5, flareLevel: 0.05,     // the lever's attitude: from the first height (body radii) the nose may point less and less down, level by the second; the craft rides a world's spin over the same heights
  flareDegS: 60,                        // and turns no faster than this
  reanchorM: 300, reanchorHeights: 4    // flown on low, the ground is built again under the craft once it is this far, and this many of its own heights, from where the last was built
};
// What the ground under a craft is drawn by (almanac-stand.js, almanac-standgl.js, almanac-standhost.js), kept here for the same pages.
var AE_GROUND_REF = {
  prep: 3, keep: 2,                     // built once the craft is within this many times the height it starts to show at, and let go this many times farther again
  lateMs: 700,                          // a ground built late (the craft already in the band) comes in over this long
  mapTexels: [0.5, 2],                  // the horizon this many of the map's texels away: the map is gone from the ground's picture, and it is all there
  snowLineM: 5000, snowLinePow: 1.5,    // the Earth's snow line: this high at the equator, times the latitude's cosine to this power (2,900 m at 46 degrees: the Alps' is 2,700 to 3,100 m)
  treeBelowM: 600,                      // and its trees end this far below it
  gamma: 2.2,                           // the ground's tone curve: shown = (1 - exp(-L k))^(1 / gamma)
  exposureTarget: 0.5,                  // 1 - exp(-L k) of the reference ground: about 0.65 on screen
  nightFloor: 1.5e-6,                   // the faintest light the eye is set to (the Sun at the Earth being 1)
  nightGlow: 9e-7,                      // the least light the ground has (starlight and airglow): a dark-adapted eye makes out the ground and its horizon
  matchPx: 8, matchEveryMs: 3000,       // the globe's picture of the place and the ground's are each read from a square of this side, again this often while the globe still shows
  matchFloor: 4 / 255,                  // added to both before a ratio: night's near-black is not a ratio of noise
  matchK: [1 / 32, 4], matchHue: 2,     // the match changes the exposure by no more than this either way, and the colour left over by no more than this
  matchWhite: 0.98,                     // a mean brighter than this is clipped: its true brightness cannot be read from it
  luma: [0.2126, 0.7152, 0.0722],       // Rec. 709
  settleDecades: 2,                     // the ground is at its own exposure and colour this many tenfolds of height below the top of the band (400 m over the Earth)
  hdPx: 1024,                           // Almanac HD's tiles round the place, as two pictures of this side
  hdFar: 1.5, hdNearShare: 1 / 8,       // the far one reaches this many times the horizon's angle from the top of the band, the near one this share of that
  hdEveryMs: 500, hdRecentre: 0.5,      // looked at again this often, the near one drawn again once the craft is this share of its half-width from its middle
  hdMinCos: 0.2,                        // a picture's width in longitude grows with latitude no further than this cosine's
  warmPx: 8, warmMs: 4000,              // what a ground's first pictures need is made ahead on targets of this side, a step a frame, for no longer than this
  sliceMs: 8, sliceIdleMs: 40,          // building is done in slices of this long beside a flight, and this long once nothing else moves
  treesMax: 3200, treeChunk: 400,       // the Earth's trees round a place: at most, and to a mesh
  treesRangeM: [60, 4500]               // and how near and how far they stand
};
// What is being moved, told in one shape whatever moves it (the craft, a walk, a rover), for the view's own readouts: `_ae.move`, null when nothing is.
// vehicle 'ufo' | 'walk' | 'rover'; near: the world it is at (and nearM, its height over it); to and toM: where it is going and how far is left (null with no
// destination); speedMS, and speedC the same over light's; lightS: light's own time over what is left; place: the latitude and longitude under it; coveredM:
// the ground covered since it set out (null in flight).
function _aeMoveTell(vehicle, near, speedMS, more) {
  var m = { vehicle: vehicle, from: null, to: null, near: near, nearM: 0, toM: null, speedMS: speedMS, speedC: speedMS / SPEED_OF_LIGHT_M_S, lightS: null, place: null, coveredM: null };
  for (var k in more) m[k] = more[k];
  if (m.toM !== null) m.lightS = m.toM / SPEED_OF_LIGHT_M_S;
  _ae.move = m;
}
// The mission player's own figures (almanac-missions.js), kept here so the Almanac's constants pages can show them.
var AE_MISSION_REF = {
  coastM: 120,                          // on a coast the camera stands this far from the craft, so the craft is seen large
  turnShare: 0.3,                       // it looks back at where the craft came from for this share of a coast (the Earth is still 4 degrees wide at 183,000 km: big enough to read as leaving), then ahead at where it is going
  turnS: 2,                             // and takes this long to turn about the craft
  stripSagPx: 14,                       // the strip's line is an arc, curving up: its ends stand this far below the middle
  timeStrip: true,                      // the view's own time strip (date, time, slider) stays at the top during a mission; false takes it away
  stripStepPx: [90, 160],               // the mission strip: one event's step along the line, between these, a quarter of the window's width
  relS: [90, 5400, 129600]              // the time to an event reads in seconds under the first of these, minutes under the second, hours under the third, then days
};
var AE_LOCATE_TIMEOUT_MS = 15000;
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
var AE_STAR_ALPHA0 = 1.15, AE_STAR_ALPHA_PER_MAG = 0.14, AE_STAR_ALPHA_MIN = 0.24;
var AE_STAR_CI_MIN = -0.3, AE_STAR_CI_SPAN = 1.9;   // colour index -0.3 (blue) .. 1.6 (orange)
var AE_HOURS_TO_RAD = Math.PI / 12;

var _ae = null;          // view state, built on first open
var _aeFadeU = { value: 1 };   // how far in from the hero the view has come: what is not the Moon fades by it
var _aeIsOpen = false;

function _aeT(key, vars) { return (typeof t === 'function') ? t(key, vars) : key; }
function _aeReduceMotion() { return _ae && _ae.snapFly ? true : (typeof _almReduceMotion === 'function') ? _almReduceMotion() : false; }   // snapFly: a preset taken at once, no flight (the orrery's lift sets its end)
function _aeLink(key, html) { return window.AlmanacLinks ? window.AlmanacLinks.wrap(key, html) : html; }
function _aeLinked(key) { return !!(window.AlmanacLinks && window.AlmanacLinks.linkFor(key)); }
function _aeClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
// A three.js vector as an array; a unit vector's latitude and longitude (degrees).
function _aeXyz(v) { return [v.x, v.y, v.z]; }
function _aeLatLonOf(q) { return { lat: _aeDeg(Math.asin(_aeClamp(q[2], -1, 1))), lon: _aeDeg(Math.atan2(q[1], q[0])) }; }
function _aeEaseOut(p) { return 1 - Math.pow(1 - p, 3); }
// A flight speeds up, cruises and slows to arrive: cubic in and out.
// Zero speed and zero acceleration at both ends: a turn eased with it starts and stops without a step in its rate.
function _aeSmoother(p) { p = _aeClamp(p, 0, 1); return p * p * p * (p * (6 * p - 15) + 10); }
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
// A stylesheet put in the page once, by its id.
function _aeCss(id, text) {
  if (_aeById(id)) return;
  var st = document.createElement('style');
  st.id = id; st.textContent = text;
  document.head.appendChild(st);
}
// A file of the view's fetched when first needed: one <script> per file however many ask, resolving true once it ran and
// false when it could not be fetched (and the next ask tries again).
var _aeScripts = {};
function _aeLoadJs(src) {
  if (!_aeScripts[src]) _aeScripts[src] = new Promise(function (resolve) {
    var el = document.createElement('script');
    el.src = src;
    el.onload = function () { resolve(true); };
    el.onerror = function () { delete _aeScripts[src]; el.remove(); resolve(false); };
    document.head.appendChild(el);
  });
  return _aeScripts[src];
}
// The same for a file whose first ask alone acts on it: an ask while it loads (or once it ran) is dropped.
function _aeLoadJsOnce(src, then, failed) {
  if (_aeScripts[src]) return;
  _aeLoadJs(src).then(function (ok) { if (ok) then(); else if (failed) failed(); });
}
// The picture held where the ship left it (almanac-fly.js) lets go when the view is touched, zoomed, turned or sent somewhere.
function _aeLetGo() { if (_ae && _ae.shipExit && typeof _afExitRelease === 'function') _afExitRelease(); }
// ── The 3D debug log: off by default, one flag. Open Zimi with ?debug3d=1 once to turn it on on this device (?debug3d=0 turns it off); while on, the Almanac keeps the
// last AE_DEBUG_MAX changes of the UFO, rover, camera and mode with the call that made each, and a small pill (almanac-debug3d.js) shows and copies them. Off, each call is one test.
var AE_DEBUG_KEY = 'zimi.debug3d', AE_DEBUG_MAX = 400, AE_DEBUG_TICK_MS = 250, AE_DEBUG_JS = _almAsset('/static/almanac-debug3d.js');
function _aeDbgFlag() {
  try {
    var q = /[?&]debug3d=([01])/.exec(location.search || '');
    if (q) { if (q[1] === '1') localStorage.setItem(AE_DEBUG_KEY, '1'); else localStorage.removeItem(AE_DEBUG_KEY); }
    return localStorage.getItem(AE_DEBUG_KEY) === '1';
  } catch (e) { return false; }
}
var _aeDbgDevice = _aeDbgFlag(), _aeDbgOn = _aeDbgDevice || !!window._dblOn, _aeDbgLog = [], _aeDbgLast = '', _aeDbgAt = 0;
function _aeDbg(kind, note) {
  if (!_aeDbgOn) return;
  _aeDbgLog.push({ t: Date.now(), k: kind, n: note });
  if (_aeDbgLog.length > AE_DEBUG_MAX) _aeDbgLog.shift();
  if (window._dbl) _dbl.rec('3d', { w: kind, n: note }); // the server's debug log (debuglog.js) takes it too
}
// What the log tells of the view now, in one line: whatever differs from the last line is logged with the function that was running.
function _aeDbgSnap() {
  var a = _ae, b = _aeById('ae-fly-btn'), sh = a.ship, cr = (sh && sh.craft) || (a.shipParked && a.shipParked.craft), mv = a.move, cam = a.gl && a.gl.camera, st = a.stand || a.standPending;
  return [
    'mode=' + _aeMode(), 'target=' + a.target, 'preset=' + a.preset,
    'ship=' + (sh ? 1 : 0), 'parked=' + (a.shipParked ? 1 : 0), 'landed=' + (a.shipLanded ? 1 : 0),
    'craft=' + (cr ? (cr.root.visible ? 'shown' : 'hidden') + (cr.root.parent ? '' : '/detached') : 'none'),
    'ufoBtn=' + (b ? (b.hidden ? 'hidden' : 'shown') : 'none') + '/can' + (_aeHudCanNow(AH_UFO_BTN) ? 1 : 0) + '/able' + (_aeFlyAble() ? 1 : 0),
    'stand=' + (st ? st.key + (st.mode ? ':' + st.mode : '') : '-'), 'site=' + (a.site ? a.site.body + ':' + a.site.phase + (a.site.drive ? ':drive' : '') + (a.site.outOf ? ':outOf' : '') + (a.site.calledUp ? ':calledUp' : '') + (a.site.atEye ? ':atEye' : '') + (a.site.rover ? (a.site.rover.airborne ? ':air' : ':grounded') : '') : '-'),
    'rate=' + (typeof _almRate === 'number' ? _almRate : '-'),
    'mission=' + (a.mission ? 1 : 0), 'hand=' + (a.hand ? 1 : 0), 'spin=' + (a.spin ? 1 : 0),
    'move=' + (mv ? mv.vehicle + '@' + Math.round(mv.speedMS) + 'm/s' : '-'),
    'cam=' + (cam ? [cam.position.x, cam.position.y, cam.position.z].map(function (v) { return v.toPrecision(3); }).join(',') : '-'),
    'time=' + new Date(_aeDisplayMs()).toISOString().slice(0, 19)
  ].join(' ');
}
// What a fit was made of, so a view that opens on a body too far to see says why.
function _aeDbgFit(what) {
  if (!_aeDbgOn || !_ae) return;
  var t = AE_TARGETS[_ae.target] || {};
  _aeDbg('fit', what + ' ' + _ae.target + ' w=' + _ae.w + ' h=' + _ae.h + ' aspect=' + (_ae.w && _ae.h ? (_ae.w / _ae.h).toFixed(3) : '-') +
    ' dist=' + (+_ae.dist).toFixed(2) + ' min=' + t.min + ' stop=' + t.stop);
}
function _aeDbgState(why) {
  if (!_aeDbgOn || typeof _ae === 'undefined' || !_ae) return;
  try {
    var s = _aeDbgSnap(), cur = s.split(' '), prev = _aeDbgLast ? _aeDbgLast.split(' ') : [], quiet = function (f) { return f.indexOf('cam=') === 0 || f.indexOf('time=') === 0; };
    var changed = cur.filter(function (f, i) { return f !== prev[i] && !quiet(f); });
    if (prev.length && !changed.length) return;   // (only the camera and the clock moved: that is the frame's business, not a change)
    var from = why === 'frame' ? '' : ' <' + String(new Error().stack || '').split('\n').slice(2, 5).map(function (l) { return l.trim().replace(/^at /, '').replace(/\(?https?:[^)]*\/([^/)]+)\)?/, '$1'); }).join(' < ');   // (what called: the log says why, not only what)
    _aeDbg('state', (why || '') + from + ' | ' + (prev.length ? changed.join(' ') + ' ' + cur.filter(quiet).join(' ') : s));
    _aeDbgLast = s;
  } catch (e) { _aeDbg('error', String(e && e.message)); }
}
// The frame's own look, a few times a second: a change nothing announced (the UFO that vanished) shows here, with the camera that moved.
function _aeDbgFrame(now) {
  if (!_aeDbgOn || now - _aeDbgAt < AE_DEBUG_TICK_MS) return;
  _aeDbgAt = now;
  _aeDbgState('frame');
}
function _aeDbgText() {
  return _aeDbgLog.map(function (e) { return new Date(e.t).toISOString().slice(11, 23) + ' ' + e.k + ' ' + e.n; }).join('\n') + (_aeDbgOn ? '\n' + _aeDbgSnap() : '');
}
// A key held when the window loses the focus (Alt-Tab, another tab) never sends its keyup here: whoever listens for keys lets go of them all then. Returns the way to stop listening.
function _aeOnFocusLost(letGo) {
  var gone = function () { if (document.visibilityState !== 'visible' || !document.hasFocus || !document.hasFocus()) letGo(); };
  window.addEventListener('blur', letGo);
  document.addEventListener('visibilitychange', gone);
  return function () { window.removeEventListener('blur', letGo); document.removeEventListener('visibilitychange', gone); };
}

// The styles live with the view (injected on first open), so a device that
// never opens it never parses them.
// The view's two marking colours: the spacecraft's teal (AE_PROBE_COLOR is it as GL floats) and the amber of
// places it names (a landing, you, the status line).
var AE_PROBE_HEX = '#6ee7d8', AE_AMBER_HEX = '#f5c16c';
// The view's sheets and cards (Go to, settings, a body's card) are solid: the scene and the labels under them never
// show through what is being read.
var AE_PANEL_BG = '#0e0e10', AE_PANEL_BG_RED = '#000';
var AH_TOP_Z = 60;   // the top bar, the band and the drawer: over a mode's touch layer (50) and the sheet (59). Declared here because the sheets' CSS below reads it at load; declared later it was undefined, the band had no z-index, and a site's touch layer took the gear's taps
// The Go to sheet's little bodies: one sprite sheet of lit discs drawn from the base maps (scripts/build_go_discs.py), asked
// for only when the sheet is first opened. The order is the script's.
var AE_GO_DISC_URL = _almAsset('/static/earth/go-discs-v2.webp');
var AE_GO_DISC_KEYS = ['sun', 'earth', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'ceres', 'vesta', 'io', 'europa',
  'ganymede', 'callisto', 'titan', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'iapetus', 'triton', 'charon', 'phobos'];
var AE_GO_DISC_COLS = 7, AE_GO_DISC_ROWS = 4;   // the sprite's disc is 116 px of its 120 px cell, the row's 40 px at 3x (scripts/build_go_discs.py)
var AE_NAME_ROOM_PX = 28;   // under the time chip: the name's one line (16) with its gap above (4) and clear air below (8)
var AE_CSS = [
  // The glass every control stands on: dark enough to read over a bright sky (Mars, the Moon's day side), with the hairline edge.
  '.ae-view{--ae-chip-bg:rgba(20,20,24,.8);--ae-chip-line:rgba(255,255,255,.26)}',
  '.ae-view{position:absolute;inset:0;z-index:40;background:#000;display:none;overflow:hidden;overflow:clip;color:var(--text);touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',
  '.ae-view.open{display:block}',
  '.almanac-view.ae-covered>.almanac-content{visibility:hidden}',
  // Mid-swap with the hero: the page shows through, dimming as the view
  // opens (_aeHandApply), and the controls come up at the end.
  '.ae-view.ae-hand{background:transparent}',
  '.ae-top,.ae-bottom,.ae-status,.ae-labels,.ae-pin{opacity:var(--ae-ui,1)}',
  // Controls put away by a tap on empty space (or the space bar): they fade out and cannot be reached or focused; the picture and its labels stay.
  '.ae-view.ae-bare .ae-top,.ae-view.ae-bare .ae-bottom,.ae-view.ae-bare .ae-status,.ae-view.ae-bare .ae-pin{opacity:0;visibility:hidden}',
  '.ae-view.ae-bare-anim .ae-top,.ae-view.ae-bare-anim .ae-bottom,.ae-view.ae-bare-anim .ae-status,.ae-view.ae-bare-anim .ae-pin{transition:opacity .2s,visibility 0s}',
  '.ae-view.ae-bare-anim.ae-bare .ae-top,.ae-view.ae-bare-anim.ae-bare .ae-bottom,.ae-view.ae-bare-anim.ae-bare .ae-status,.ae-view.ae-bare-anim.ae-bare .ae-pin{transition:opacity .2s,visibility 0s .2s}',
  '.ae-view.ae-hand .ae-top>*,.ae-view.ae-hand .ae-row,.ae-view.ae-hand .ae-pin,.ae-view.ae-hand .ae-note{pointer-events:none}',
  '.ae-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;outline:none}',
  '.ae-canvas.ae-dragging{cursor:grabbing}',
  '.ae-top{position:absolute;top:var(--ae-pin-h,0px);left:0;right:0;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 16px 28px;background:linear-gradient(rgba(0,0,0,.6),transparent);pointer-events:none}',
  '.ae-top>*{pointer-events:auto}',
  '.ae-btn{font:inherit;font-size:13px;line-height:1;padding:8px 12px;min-height:34px;border-radius:999px;border:1px solid var(--border);background:rgba(18,18,20,.82);color:var(--text2);cursor:pointer;white-space:nowrap}',
  // Hover only where there is one: on a phone a tapped button kept the hover
  // look, and Next eclipse read as pressed beside the real toggles.
  '.ae-btn:focus-visible{color:var(--amber);border-color:var(--amber-border);background:var(--amber-glow);outline:none}',
  '@media (hover:hover){.ae-btn:hover{color:var(--amber);border-color:var(--amber-border);background:var(--amber-glow)}}',
  '.ae-btn[disabled]{opacity:.45;cursor:default;pointer-events:none}',
  '.ae-btn[aria-pressed="true"]{color:var(--amber);border-color:var(--amber-border);background:rgba(245,158,11,.14)}',
  '.ae-btn[hidden]{display:none}',
  // A finger's hit area (the look and the layout stay): an invisible box up to 44px; the round column is 6px apart, so there the gap is 10px (a 44px pitch) instead of 6.
  // The chooser scrolls sideways and so clips its own box: it takes the room above and below its chips and gives it back in margin.
  '@media (pointer:coarse){.ae-btn{position:relative}.ae-btn::after{content:"";position:absolute;inset:calc(max(0px,44px - 100%)/-2)}.ae-view .ae-tools{gap:10px}.ae-chips{padding-block:6px;margin-block:-6px}}',
  '.ae-top-end{display:flex;align-items:flex-start;gap:8px;min-width:0;margin-inline-start:auto}',   // alone in the top row: at its end
  '.ae-tools{display:flex;flex-direction:column;gap:6px}',
  '.ae-round{flex:0 0 auto;width:var(--round,32px);height:var(--round,32px);min-height:0;box-sizing:border-box;padding:0;display:inline-flex;align-items:center;justify-content:center}',
  '.ae-round>svg{flex:none}',
  '.ae-gear[aria-expanded="true"]{color:var(--amber);border-color:var(--amber-border)}',
  // Beside the round tools, not over them.
  '.ae-set{font-size:13px;line-height:1.45;color:var(--text2)}',
  '.ae-set[hidden]{display:none}',
  '.ae-set h3{margin:0 4px 6px;font-size:var(--fs-body,15px);font-weight:600;color:var(--text)}',
  '@media (pointer:coarse){.ae-set h3{padding-inline-end:40px}}',
  '.ae-set-choice{display:flex;gap:10px;align-items:flex-start;padding:7px 4px;border-radius:8px;cursor:pointer}',
  '.ae-set-choice:hover{background:rgba(255,255,255,.04)}',
  '.ae-set-choice input{margin:3px 0 0;flex:0 0 auto;accent-color:var(--amber)}',
  '.ae-set-choice{align-items:center}',
  '@media (pointer:coarse){.ae-set-choice{min-height:44px;box-sizing:border-box}}',
  '.ae-set-choice b{font-weight:500;color:var(--text)}',
  '.ae-set-choice input{margin:0}',
  '.ae-set-ico{flex:none;color:var(--text2)}',
  '.ae-set-why a{color:var(--amber);text-decoration:none}',
  '.ae-set-choice b{display:block;font-weight:500;color:var(--text)}',
  '.ae-set-choice small a{color:var(--amber);text-decoration:none}',
  '.ae-set-choice small{display:block;font-size:var(--fs-small,13px);color:var(--text2)}',
  '.ae-set-ultra{display:flex;flex-direction:column;gap:2px;margin-top:6px}',
  '.ae-set-choice.ae-off{cursor:default}',
  '.ae-set-choice.ae-off:hover{background:none}',
  '.ae-set-why{margin:6px 4px 0;font-size:var(--fs-small,13px);color:var(--text2)}',
  // The credit is a 44px row; its link takes the room in padding and gives it back in margin.
  '@media (pointer:coarse){.ae-set-why{min-height:44px;display:flex;align-items:center;margin-block:0}.ae-set-why a{display:inline-block;padding:15px 4px;margin:-15px -4px}}',
  '.ae-set-data{margin:8px 4px 0;padding-top:8px;border-top:1px solid var(--border);font-size:var(--fs-small,13px);color:var(--text2)}',
  '.ae-set-data[hidden]{display:none}',
  '.ae-set-data .ae-fresh{margin-inline-start:0}',
  '.ae-set-hd{margin-top:4px;border-top:0;padding-top:0}',
  '.ae-set-hd b{color:var(--text);font-weight:600}',
  '.ae-set-sep{height:1px;margin:6px 4px;background:var(--border)}',
  '.ae-status{position:absolute;left:16px;right:16px;top:calc(66px + var(--ae-pin-h,0px));text-align:center;font-size:13px;line-height:1.4;color:' + AE_AMBER_HEX + ';pointer-events:none;text-shadow:0 1px 3px #000}',
  '.ae-bottom{position:absolute;left:0;right:0;bottom:0;padding:28px ' + AE_FOOT_PAD_PX + 'px calc(12px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;align-items:center;background:linear-gradient(transparent,rgba(0,0,0,.72));pointer-events:none}',
  // A phone on its side in Safari has about 250 px under its bars (Eric 2026-11-08: "line interactive things along left
  // edge instead of bottom keep only time on the bottom"): the row stands down the left edge, the foot is the date and
  // time alone (the slider with the clock opened by a tap), and the minimap and the satellite note stand aside.
  '@media (orientation:landscape) and (max-height:460px){' +
    '.ae-bottom{top:0;justify-content:flex-end;padding:8px 12px calc(8px + env(safe-area-inset-bottom));gap:3px;background:linear-gradient(transparent 75%,rgba(0,0,0,.6))}' +
    '.ae-bottom>#ae-views{position:absolute;inset-inline-start:calc(' + (12 + (AE_HIT_PX - AE_ROW_DISC_PX) / 2 - 5) + 'px + env(safe-area-inset-left));padding-inline:5px;box-sizing:content-box;top:calc(' + (8 + AE_HIT_PX + 16) + 'px + var(--sat,0px));bottom:calc(' + (12 + AE_HIT_PX + AE_FIND_GAP_PX) + 'px + env(safe-area-inset-bottom));align-self:normal;min-height:0;max-height:none;flex-direction:column;align-items:flex-start;gap:4px;max-width:none;margin:0;overflow-y:auto;overscroll-behavior:contain}' +
    '#ae-views .ae-chips{flex-direction:column;align-items:flex-start;justify-content:flex-start;overflow-x:hidden;overflow-y:auto;gap:4px;max-height:100%;padding:' + AE_ROW_CLIP_PX + 'px 5px;margin-inline:-5px;--ah-way:to bottom}' +
    '.ae-spintools{flex-direction:column;gap:4px}' +
    '.ae-bottom .ae-note{display:none}' +
    '.ae-bottom .ae-card{bottom:auto;top:calc(var(--ae-pin-h,0px) + ' + AE_NAME_ROOM_PX + 'px);max-height:min(55vh,calc(100vh - 130px))}' +   // the foot row fills the view here, so a card hung from its top edge went up under the bar: it sits just under the bar instead
    // The strip is one row, the clock alone, between the chips down the left and the tools down the right.
    '.alm-pin.ae-pin{display:flex;align-items:center;padding-inline:calc(112px + env(safe-area-inset-left)) calc(76px + env(safe-area-inset-right))}' +
    '.ae-pin .alm-pin-clock,.ae-pin .alm-pin-clock:has(.alm-ck-rest){flex:1 1 auto;min-width:0;height:auto;min-height:44px;padding:0;display:flex;flex-direction:column;justify-content:center}' +
    '.ae-bottom .ae-hint{top:calc(var(--ae-pin-h,0px) + ' + AE_NAME_ROOM_PX + 'px);bottom:auto}' +
  '}',
  '.ae-row{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;pointer-events:auto}',
  // The row's discs: the body in view is larger, and marked by a thin ring.
  '.ae-bottom .ae-note{display:none}',   // its lines are said in the caption slot and the world sheet
  '.ae-disc{--s:' + AE_ROW_DISC_PX + 'px;position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:var(--s);height:var(--s);padding:0;border:0;border-radius:50%;background:none;color:var(--text);cursor:pointer}',
  '.ae-disc::after{content:"";position:absolute;inset:min(0px,calc((var(--s) - 44px) / 2))}',   // a finger's 44 px
  '.ae-disc .ae-go-thumb{--s:inherit;width:100%;height:100%;pointer-events:none;border-radius:50%;overflow:hidden}',   // clipped by a circle of its own
  '.ae-disc .ae-go-disc,.ae-disc .ae-go-glyph{display:block;width:100%;height:100%;border-radius:50%}',
  // A world lit as it is now (_aeRowLitPaint) stands over its sprite once drawn, and the sprite goes.
  '.ae-disc .ae-disc-lit{position:absolute;inset:0;width:100%;height:100%;opacity:0}.ae-disc .ae-disc-lit.ae-lit-on{opacity:1}',
  '.ae-disc .ae-go-thumb:has(.ae-lit-on) .ae-go-disc{visibility:hidden}',
  '.night-red .ae-disc-lit{filter:var(--red-picture)}',
  // The worlds' track: clipped at its start (nothing shows beside or behind search), a world on its way out fading there once the track has moved; it fades at its end where it meets the corner column.
  '.ae-chips{position:relative;--ah-way:to right;--ah-in:0px;--ah-out:' + AE_TRACK_FADE_PX + 'px;-webkit-mask-image:linear-gradient(var(--ah-way),transparent,#000 var(--ah-in),#000 calc(100% - var(--ah-out)),transparent);mask-image:linear-gradient(var(--ah-way),transparent,#000 var(--ah-in),#000 calc(100% - var(--ah-out)),transparent);scroll-snap-type:both mandatory;scroll-padding:' + AE_TRACK_RING_PX + 'px}',
  '.ae-chips [data-ae-view]{scroll-snap-align:start}',   // the track comes to rest with a whole world at its start, never half of one
  '[dir="rtl"] .ae-chips{--ah-way:to left}',
  '.ae-chips.ah-end{--ah-out:0px}',   // scrolled to its end (or nothing to scroll to): the last world is not faded, there is no more behind it
  '.ae-chips.ah-run{--ah-in:' + AE_TRACK_FADE_PX + 'px}',
  '.ae-disc-moon{--s:32px;margin-inline:6px 2px}',   // a moon: smaller, joined to the world before it by a thin amber line (the margins leave its 44 px finger room beside its neighbours')
  '.ae-disc-moon::before{content:"";position:absolute;inset-inline-end:100%;top:50%;width:8px;height:2px;margin-top:-1px;background:var(--amber);opacity:.8}',
  '.ae-mini{position:absolute;inset-inline-start:12px;bottom:calc(var(--ae-rim-b,calc(12px + env(safe-area-inset-bottom))) + ' + (AE_HIT_PX + 16) + 'px);z-index:1;width:' + AE_MINI_PX + 'px;height:' + AE_MINI_PX + 'px;padding:0;border:1px solid var(--border);border-radius:50%;background:rgba(0,0,0,.55);overflow:hidden;cursor:pointer;opacity:var(--ae-ui,1)}',
  '.ae-mini[hidden]{display:none}.ae-mini canvas{width:100%;height:100%;display:block}.ae-mini:focus-visible{outline:2px solid var(--amber);outline-offset:2px}',
  '@media (orientation:landscape) and (max-height:460px){.ae-mini{inset-inline-start:76px;bottom:calc(12px + env(safe-area-inset-bottom));width:72px;height:72px}}',   // landscape: beside the strip's column, not over it
  '.ae-flying .ae-mini,.ae-driving .ae-mini,.ae-spinning .ae-mini,.ae-view.ae-bare .ae-mini{opacity:0;visibility:hidden}',
  '.ae-standing .ae-mini,.ae-site .ae-mini,.ae-mission .ae-mini{display:none}',
  '.ae-disc:focus-visible{outline:2px solid var(--amber);outline-offset:2px}',
  '.ae-disc-now{box-shadow:0 0 0 2px var(--amber)}',
  '.ae-chips{align-items:center}',
  // Go to: a sheet over the controls, tall enough that where you are, the search, the pills and the first row (Sun, Solar system, Side by side) all show as it opens; its places in groups, each with its small disc.
  '.ae-go{position:absolute;left:12px;right:12px;bottom:calc(' + (AE_ROW_DISC_PX + 28) + 'px + env(safe-area-inset-bottom));height:min(60vh,560px,var(--sheet-room,100vh));display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;background:var(--ae-sheet-bg,rgba(18,18,22,.66));border:1px solid var(--ae-chip-line,rgba(255,255,255,.24));border-radius:22px;-webkit-backdrop-filter:blur(22px) saturate(1.4);backdrop-filter:blur(22px) saturate(1.4);box-shadow:0 2px 16px rgba(0,0,0,.5);pointer-events:auto;z-index:2}',
  '.ae-go[hidden]{display:none}',
  // On a narrow phone the row's chips draw in a little so the five places and Go to stay one line.
  '#ae-views{flex-wrap:nowrap;align-items:center;min-height:' + AE_HIT_PX + 'px;max-width:calc(100vw - ' + (AE_FOOT_PAD_PX + AE_FIND_ROOM_PX) + 'px - var(--ah-end,' + AE_RIM_ROOM_PX + 'px));margin-inline:' + AE_FIND_ROOM_PX + 'px 0}',   // search stands before it, the rim button at its end; a finger tall, so its worlds centre on both
  '#ae-views .ae-round{flex:none}',
  '.ae-spintools{display:flex;flex:none;gap:inherit}',
  '.ae-spintools[hidden]{display:none}',
  // Side by side's tools (Same size, Faces, Full screen) stand bottom left, above the strip, and stay there whatever the view does.
  // Side by side's tools stand in the foot as three labelled buttons beside the Sun (nothing floats over the planets); the
  // planets' room is what is left above.
  '.ae-chip-l{display:none}',
  '@media not all and (orientation:landscape) and (max-height:460px){.ae-spinning #ae-spinrow{display:flex;flex:1 1 auto;flex-wrap:wrap;justify-content:center;gap:8px}' +
    'html .ae-spinning #ae-spinrow .ae-btn.ae-round{width:auto;height:' + AE_HIT_PX + 'px;min-width:' + AE_HIT_PX + 'px;padding:0 14px;border-radius:' + (AE_HIT_PX / 2) + 'px;font-size:var(--fs-small,13px);font-weight:500}' +
    '.ae-spinning #ae-spinrow .ae-chip-l{display:none}' +
    '.ae-spinning #ae-chips [data-ae-view="spin"]{display:none}.ae-spinning #ae-views{max-width:none;margin-inline:' + AE_FIND_ROOM_PX + 'px 0;width:calc(100vw - ' + (2 * AE_FOOT_PAD_PX + AE_FIND_ROOM_PX) + 'px)}.ae-spinning #ae-spinrow{flex-wrap:nowrap;gap:6px}html .ae-spinning #ae-spinrow .ae-btn.ae-round{padding:0}}',
  '.ae-chips{padding:' + AE_ROW_CLIP_PX + 'px ' + AE_ROW_RING_PX + 'px;margin:-' + AE_ROW_CLIP_PX + 'px -' + AE_ROW_RING_PX + 'px;display:flex;flex:0 1 auto;gap:inherit;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;min-width:0}',
  '.ae-chips .ae-btn{flex:none}',
  '@media (max-width:400px){#ae-views,.ae-chips{gap:4px}#ae-views .ae-btn:not(.ae-round){padding-inline:10px}}',
  '@media (max-width:370px){#ae-views,.ae-chips{gap:3px}#ae-views .ae-btn{font-size:12px}#ae-views .ae-btn:not(.ae-round){padding-inline:5px}#ae-views .ae-round{width:30px;height:30px}}',
  // Short landscape (a phone on its side, 390 high): the sheet takes the height, short of the control column, so a list of places shows
  // six rows, not one and a half.
  '@media (orientation:landscape) and (max-height:460px){.ae-go{inset-inline:68px 68px;top:calc(8px + var(--sat,0px));bottom:calc(8px + env(safe-area-inset-bottom));height:auto}.ae-go-head{display:flex;align-items:center}.ae-go-find{flex:0 0 min(300px,40%)}.ae-go-pills.pills-row{flex:1;min-width:0;width:auto;padding-bottom:0}}',
  '.ae-go-head{flex:none;border-bottom:1px solid var(--border);padding:0 6px 6px}',
  '.ae-go-body>.ae-go-head{position:sticky;top:-4px;z-index:2;margin:0 -12px 4px;padding:6px 12px;background:' + AE_PANEL_BG + '}',   // opaque: the rows scroll under it and must not show through   // the field and the pills stay at the top as the rows scroll under them; edge to edge, so no band is cut at the sheet's sides  '.night-red .ae-go-body>.ae-go-head{background:' + AE_PANEL_BG_RED + '}',
  // A wide screen: the sheet is a tall column over the search button, not a band across the whole width.
  '@media (min-width:760px) and (min-height:600px){.ae-go{right:auto;width:min(560px,calc(100% - 24px));height:min(85vh,880px,var(--sheet-room,100vh))}[dir="rtl"] .ae-go{left:auto;right:12px}}',
  '.ae-go-pills.pills-row{flex-wrap:nowrap;overflow-x:auto}',   // one row, scrolled sideways like every other in Zimi
  '.ae-go-head>.ae-go-find{margin:0 -2px 6px}',
  '@media (orientation:landscape) and (max-height:460px){.ae-go-body>.ae-go-head{padding-block:2px;margin-bottom:0}.ae-go-head>.ae-go-find{margin-bottom:0}}',   // (field and pills share one line there: the head is as tall as the field)
  '.ae-go h4:has(.ae-go-seg){display:flex;align-items:center;justify-content:space-between;gap:8px;margin-block:6px 4px}.ae-go h4 .ae-go-seg{text-transform:none;letter-spacing:0}',   // the selector on the first section's line, at its end
  '.ae-go-find{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 4px 0 12px;color:var(--text3);background:rgba(255,255,255,.07);border-radius:14px}',
  '.ae-go-find input{flex:1;min-width:0;height:44px;border:0;background:none;color:var(--text);font:inherit;font-size:16px;outline:none;-webkit-user-select:text;user-select:text;-webkit-appearance:none;appearance:none}',
  '.ae-go-find input::-webkit-search-cancel-button{-webkit-appearance:none}',
  '.ae-go-find:focus-within{color:var(--amber)}',
  '.ae-go-seg{display:inline-flex;flex:none;border:1px solid var(--border);border-radius:20px;overflow:hidden}',
  '.ae-go-seg button{width:40px;height:32px;border:0;background:none;color:var(--text3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}',
  '.ae-go-seg button[aria-pressed="true"]{background:rgba(255,255,255,.12);color:var(--text)}',   // (amber means one thing: drawn now, or where you are)
  '.ae-go-pills .pill.active{background:var(--amber-glow);border-color:var(--amber-border);color:var(--amber);font-weight:600}',
  '.ae-go-seg button:focus-visible,.ae-go-pills .pill:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '.ae-go-pills.pills-row{padding:0 2px 2px}',
  // A finger's hit area: the pills clip their own box as they scroll, so the row takes the room above and below and gives it back in margin; the Grid and List buttons grow outward, past the frame they sit in.
  '@media (pointer:coarse){.ae-go-pills.pills-row{padding:8px 2px 10px;margin-block:-8px}.ae-go-find{min-height:58px}.ae-go-seg{overflow:visible}.ae-go-seg button{position:relative}.ae-go-seg button:first-child{border-radius:19px 0 0 19px}.ae-go-seg button:last-child{border-radius:0 19px 19px 0}.ae-go-seg button::after{content:"";position:absolute;inset:-6px 0}.ae-go-seg button:first-child::after{inset-inline-start:-4px}.ae-go-seg button:last-child::after{inset-inline-end:-4px}}',
  '.ae-go-pills .pill{flex:none;position:relative}',
  '.ae-go-pills .pill::after{content:"";position:absolute;inset:-8px -3px}',
  '.ae-go-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 12px 8px}',
  '.ae-go-pills.pills-row{-webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);mask-image:linear-gradient(90deg,#000 88%,transparent)}',   // more to scroll to: the last pill fades, not cut
  '.ae-go-found .ae-go-row span:not(.ae-go-thumb){min-width:0;overflow-wrap:break-word;hyphens:auto}',   // a name wraps, never cut
  '.ae-go-town{background:var(--text3);color:var(--text3)}',
  '.ae-go-wait{grid-column:1/-1;padding:10px 12px;font-size:13px;color:var(--text3)}',
  '.ae-go h4{margin:10px 10px 4px;font-size:var(--fs-caption,11px);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text3)}',
  '.ae-go h4.ae-go-sec{margin-block:14px 2px;padding-top:8px;border-top:1px solid var(--border);color:var(--text);font-size:var(--fs-small,13px)}',   // a part of the sheet (fly to, stand at, launches) over the groups inside it
  '.ae-go-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px}',
  '.ae-go-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 10px;border:0;border-radius:10px;background:none;font:inherit;font-size:var(--fs-body,15px);color:var(--text);text-align:start;cursor:pointer}',
  '.ae-go-row:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '@media (hover:hover){.ae-go-row:hover{background:rgba(255,255,255,.06)}}',
  '.ae-go-row[aria-current="true"]{color:var(--amber)}',
  '.ae-go-list.ae-go-found{grid-template-columns:minmax(0,1fr)}',
  '.ae-go-list.ae-go-found[hidden]{display:none}',
  '.ae-go-dot{flex:0 0 auto;width:14px;height:14px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.08)}',
  '.ae-go-probe{width:6px;height:6px;margin:0 4px;box-shadow:0 0 6px currentColor;color:' + AE_PROBE_HEX + '}',
  // A body's thumbnail: its disc from the sprite sheet, over its own mean-colour gradient (what shows until the sheet
  // is in, and for good on a low level or if it never comes). --s is its size; --c and --r its cell in the sheet.
  '.ae-go-thumb{--s:28px;flex:none;position:relative;width:var(--s);height:var(--s)}',
  '.ae-go-disc,.ae-go-glyph{display:block;width:100%;height:100%;border-radius:50%}',
  // The ball is the sprite alone: a gradient laid under it as a fallback was a square that showed round the Sun's and the Moon's bright edge (an octagon).
  '.ae-go-disc{box-shadow:0 0 0 1px rgba(255,255,255,.08);background-image:url(' + AE_GO_DISC_URL + ');background-repeat:no-repeat;' +
    'background-size:calc(var(--s) * ' + AE_GO_DISC_COLS + ') calc(var(--s) * ' + AE_GO_DISC_ROWS + ');background-position:calc(var(--s) * var(--c) * -1) calc(var(--s) * var(--r) * -1)}',
  // The one selection mark of the app: amber, round, the same for every body.
  '.ae-go-row[aria-current="true"] .ae-go-thumb{border-radius:50%;box-shadow:0 0 0 2px var(--amber)}',
  '.ae-go-flat .ae-go-disc{border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.08);background-color:var(--cc);background-image:var(--g);background-size:100% 100%;background-position:0 0}',
  '.ae-go-glyph{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);color:var(--gc,' + AE_PROBE_HEX + ')}',
  '.ae-go-glyph svg{width:62%;height:62%}',
  '.ae-go-thumb .ae-sent-img{display:block;width:100%;height:100%}',
  '.ae-sent-top{display:flex;align-items:center;gap:8px}.ae-sent-top b{margin-inline-start:auto;font-weight:600;color:var(--text3)}',
  '.ae-sent-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}',
  '.ae-sent-tile[aria-expanded="true"]{color:var(--amber)}.ae-sent-choose{grid-column:1/-1;margin:0 0 6px;padding:4px 0;border-block:1px solid var(--border)}',   // a tile of several, opened: its rows under it
  '.ae-sent-tile{flex-direction:column;align-items:center;justify-content:flex-start;gap:4px;text-align:center;padding:6px 2px;min-height:' + (AE_HIT_PX + 36) + 'px;font-size:var(--fs-caption,11px)}',
  '.ae-sent-tile .ae-sent-img,.ae-sent-tile .ae-sent-sil{width:56px;height:56px}',
  '.ae-go-top3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:4px 0 2px}',
  '.ae-go-top3 .ae-go-cell{flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;text-align:center;min-height:' + (AE_HIT_PX + 40) + 'px;padding:6px 4px}',
  '.ae-go-top3 .ae-go-thumb{--s:48px;width:48px;height:48px}',
  '.ae-go-orrery{display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid var(--border);color:var(--amber)}',
  '.ae-go-orrery svg{width:100%;height:100%}',
  '.ae-go-three{display:flex;align-items:center;justify-content:center;gap:2px;width:48px}',
  '.ae-go-three .ae-go-thumb{--s:14px;width:14px;height:14px}',
  '.ae-go-mark{position:absolute;inset-inline-end:-3px;bottom:-3px;width:max(15px,40%);height:max(15px,40%);box-sizing:border-box;padding:2px;border-radius:50%;display:flex;color:var(--text);background:var(--ae-chip-bg,rgba(20,20,24,.8));border:1px solid var(--ae-chip-line,rgba(255,255,255,.26));pointer-events:none}',
  '.ae-go-mark svg{width:100%;height:100%}',
  '.ae-go-grid .ae-go-list{grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:4px 2px}',
  '.ae-go-grid .ae-go-thumb{--s:56px}',
  '.ae-go-grid .ae-go-row{flex-direction:column;justify-content:flex-start;gap:5px;min-height:84px;padding:6px 0;text-align:center;font-size:var(--fs-small,13px);line-height:1.2}',
  '.ae-go-grid .ae-go-row span:not(.ae-go-thumb){min-width:0;overflow-wrap:break-word;hyphens:auto}',   // a name wraps, never cut
  '.ae-go-grid .ae-go-wait,.ae-go-grid h4{grid-column:1/-1}',
  '.ae-sent-choose{display:flex;flex-wrap:wrap;gap:6px;padding:8px 2px}.ae-sent-pick span{color:var(--text2);font-variant-numeric:tabular-nums}',   // a tile's several, chosen from: a chip each, name and year
  '#ae-go-groups:not(.ae-go-grid) .ae-go-row>span:not(.ae-go-thumb){min-width:0;overflow-wrap:break-word;hyphens:auto;padding-block:4px}',   // two lines or more, never an ellipsis
  // Short landscape: the head is tighter and the list's rows touch, so six of them show.
  '@media (orientation:landscape) and (max-height:460px){.ae-go-head{padding-bottom:2px}.ae-go-find{min-height:44px}.ae-go-body{padding-top:0}#ae-go-groups:not(.ae-go-grid) .ae-go-list{gap:0}}',
  '.night-red .ae-go,.night-red .ae-go-find{background:' + AE_PANEL_BG_RED + '}',
  // Where you are among the planets, in a corner while near one: tap for the whole system.
  // On a phone the sheet lifts the picture into the minimap's corner: the minimap steps aside while it is up.
  '.ae-row[hidden]{display:none}',
  '.ae-info-credit{font-size:var(--fs-caption,11px);color:var(--text3);margin-top:14px}',
  '.ae-note{font-size:var(--fs-small,13px);line-height:1.4;color:var(--text3);text-align:center;pointer-events:auto;max-width:560px}',
  '.ae-ask-text{color:var(--text2)}',
  '.ae-fresh{font:inherit;font-size:11px;line-height:1;padding:6px 10px;min-height:26px;margin:2px 0;margin-inline-start:6px;border-radius:999px;border:1px solid var(--amber-border);background:var(--amber-glow);color:var(--amber);cursor:pointer;vertical-align:middle}',
  '.ae-hd-rm-row{display:flex;flex-wrap:wrap;gap:6px;padding:0 4px 4px 28px}',
  '.ae-hd-line{display:flex;align-items:center;gap:6px}',
  '.ae-hd-line .ae-set-choice{flex:1 1 auto;min-width:0}',
  '.ae-hd-rm{flex:none;min-height:' + AE_HIT_PX + 'px;min-width:' + AE_HIT_PX + 'px;padding:0 6px;border:0;background:none;color:var(--text2);font:inherit;font-size:var(--fs-caption,11px);text-decoration:underline;cursor:pointer}',
  '.ae-hd-rm:hover{color:var(--text)}',
  '.ae-hd-rm-row .ae-fresh,#ae-set-hd-cancel{min-height:44px;padding:0 14px;margin:0}',
  '.ae-fresh:focus-visible{background:rgba(245,158,11,.18);outline:none}',
  '@media (hover:hover){.ae-fresh:hover{background:rgba(245,158,11,.18)}}',
  '@media (pointer:coarse){.ae-fresh{min-height:32px;padding:8px 12px}}',
  '.ae-fresh[disabled]{opacity:.7;cursor:default}',
  '.ae-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}',
  // Planets side by side: a button over each planet's place carries its names; the globe's own labels and notes step aside.
  '.ae-spin{position:absolute;inset:0;pointer-events:none;display:none}',
  '.ae-spinning .ae-spin{display:block}',
  '.ae-spinning .ae-canvas{cursor:default}',
  '.ae-spinning .ae-labels,.ae-spinning .ae-lms,.ae-spinning .ae-hint,.ae-spinning .ae-card,.ae-spinning .ae-status{display:none!important}',
  '.ae-sp{position:absolute;box-sizing:border-box;pointer-events:auto;display:flex;flex-direction:column;justify-content:flex-start;align-items:center;gap:1px;padding:0 2px;margin:0;border:0;background:none;font:inherit;color:#dfe6f0;text-align:center;cursor:pointer;border-radius:10px;overflow:hidden}',
  '.ae-sp b{font-size:13px;font-weight:600;color:#f1f4f9;line-height:1.3}',
  '.ae-sp span{font-size:10.5px;line-height:1.25;color:rgba(223,230,240,.72)}',
  '.ae-sp .ae-sp-back{color:' + AE_AMBER_HEX + '}',
  '.ae-sp i{font-style:normal}',
  '.ae-sp span{white-space:nowrap;letter-spacing:-.01em}',
  '.ae-sp:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '.night-red .ae-sp,.night-red .ae-sp b,.night-red .ae-sp span{color:var(--text)}',
  // Full screen: the planets and their short names, nothing else but the two small tools in the corner. The Fullscreen API
  // where the browser has it; this covering the viewport where it does not (an iPhone), inside its safe areas (_aeSpinRoom).
  '.ae-spin-full{position:fixed;inset:0;z-index:10000}',
  '.ae-spin-full>*:not(.ae-canvas):not(.ae-spin):not(.ae-fullbar):not(.ae-safe){display:none!important}',
  'html.ae-full-on .topbar{display:none!important}',
  // The header floats over the picture, whole screen under it: hiding the controls fades it (and the rest), it never moves or resizes a box,
  // so the body stays exactly where it was. The view's own things stand below it (--ae-hdr, _aeMeasureFoot).
  'html body.ae-3d{--under-topbar:calc(var(--sat) + var(--conn-h))}',
  'body.ae-3d #almanac-content{margin-top:' + AE_TOPBAR_PX + 'px}',   // the page under the view stays where it was: the view takes the header's room, the drawing it lifts out of does not jump up by it
  'body.ae-3d .topbar{background:linear-gradient(rgba(0,0,0,.72),rgba(0,0,0,0));border-bottom-color:transparent;transform:none!important;transition:opacity .2s,visibility 0s}',
  'body.ae-3d.chrome-held .topbar:not(:focus-within){opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s,visibility 0s .2s}',
  'body.ae-3d .almanac-view{transition:none}',
  '@media (prefers-reduced-motion:reduce){body.ae-3d .topbar,body.ae-3d.chrome-held .topbar{transition:none}}',
  '.ae-spin-full .ae-sp b{font-size:15px}',
  '.ae-spin-full .ae-sp span{display:none}',
  '.ae-fullbar{position:absolute;top:calc(8px + env(safe-area-inset-top));right:calc(8px + env(safe-area-inset-right));display:none;gap:8px;z-index:3;opacity:.8}',
  '.ae-spin-full .ae-fullbar{display:flex}',
  '.ae-safe{position:absolute;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}',
  '.ae-tool-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
  '.ae-tool-svg .ae-dot{fill:currentColor;stroke:none}',
  '.ae-bm-quiet b{display:none}',
  // Landmarks: a dot and a name each, tappable (the dot sits on the place, AE_LM_DOT_X from the button's edge).
  '.ae-lms{position:absolute;inset:0;pointer-events:none;overflow:hidden}',
  '.ae-lm{position:absolute;left:0;top:0;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;margin:0;padding:calc(6px + var(--hit,0px)) 8px calc(6px + var(--hit,0px)) 18px;border:0;background:none;font:inherit;font-size:11px;color:#dfe6f0;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 4px #000;pointer-events:none;cursor:pointer}',
  '.ae-lm::before{content:"";position:absolute;left:6px;top:50%;width:6px;height:6px;border-radius:50%;background:currentColor;transform:translateY(-50%);box-shadow:0 0 3px #000}',
  '.ae-lm.ae-lm-left{padding:calc(6px + var(--hit,0px)) 18px calc(6px + var(--hit,0px)) 8px}.ae-lm.ae-lm-left::before{left:auto;right:6px}',
  '.ae-lm:focus-visible{outline:2px solid var(--amber);outline-offset:-2px;border-radius:6px}',
  '.ae-lm[hidden]{display:none}',
  '.ae-lm-landing{color:' + AE_AMBER_HEX + '}',
  '.night-red .ae-lm,.night-red .ae-lm-landing{color:var(--text)}',
  '.ae-card .ae-lm-line{display:flex;align-items:center;justify-content:space-between;gap:10px}',
  '.ae-label{position:absolute;left:0;top:0;font-size:11px;color:#dfe6f0;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 4px #000}',
  '.ae-label[hidden]{display:none}',
  // A small body's mark: a ring on it and its name beside (the ring is centred on the point, the name hangs off it).
  '.ae-bm{position:absolute;left:0;top:0;color:#dfe6f0;pointer-events:none}',
  '.ae-bm[hidden]{display:none}',
  // A mark is the body itself, small (drawn on .ae-marks-c by the orrery's painter), its name small and quiet beside it.
  '.ae-marks-c{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
  // Rings only in a flight: the fly-between's circles on the body it leaves and the one it goes to (1.15.2's shot).
  '.ae-bm:not(.ae-bm-ringed) .ae-ring{display:none}',
  '.ae-ring{position:absolute;left:0;top:0;width:calc(var(--ae-r,11px)*2);height:calc(var(--ae-r,11px)*2);margin:calc(var(--ae-r,11px)*-1) 0 0 calc(var(--ae-r,11px)*-1);box-sizing:border-box;border:1.5px solid currentColor;border-radius:50%;box-shadow:0 0 3px #000}',
  '.ae-bm b{position:absolute;left:calc(var(--ae-r,11px) + 7px);top:0;transform:translateY(-50%);font:inherit;font-size:10.5px;font-weight:400;color:rgba(223,230,240,.78);white-space:nowrap;text-shadow:0 1px 2px #000,0 0 4px #000}',
  '.ae-bm-l b{left:auto;right:calc(var(--ae-r,11px) + 7px)}',
  '.ae-bm-t b{left:0;right:auto;top:calc(var(--ae-r,11px) * -1 - 4px);transform:translate(calc(-50% + var(--ae-nx,0px)),-100%)}',
  '.ae-bm-b b{left:0;right:auto;top:calc(var(--ae-r,11px) + 4px);transform:translate(calc(-50% + var(--ae-nx,0px)),0)}',
  '.ae-bm-n b{display:none}',
  '.ae-bm-pos b{left:var(--ae-bx);right:auto;top:var(--ae-by);transform:translateY(-50%)}',
  '.ae-bm-tr b{left:calc(var(--ae-r,11px) * ' + AE_NAME_DIAG + ' + 2px);right:auto;top:calc(var(--ae-r,11px) * -' + AE_NAME_DIAG + ' - 2px);transform:translate(0,-100%)}',
  '.ae-bm-tl b{left:auto;right:calc(var(--ae-r,11px) * ' + AE_NAME_DIAG + ' + 2px);top:calc(var(--ae-r,11px) * -' + AE_NAME_DIAG + ' - 2px);transform:translate(0,-100%)}',
  '.ae-bm-br b{left:calc(var(--ae-r,11px) * ' + AE_NAME_DIAG + ' + 2px);right:auto;top:calc(var(--ae-r,11px) * ' + AE_NAME_DIAG + ' + 2px);transform:none}',
  '.ae-bm-bl b{left:auto;right:calc(var(--ae-r,11px) * ' + AE_NAME_DIAG + ' + 2px);top:calc(var(--ae-r,11px) * ' + AE_NAME_DIAG + ' + 2px);transform:none}',
  '.night-red .ae-bm{color:var(--text)}',
  '.ae-label.ae-faded{opacity:.62}',
  '.ae-label-sub{display:block;margin-top:3px;font-size:10px;line-height:1.3;color:var(--text2)}',
  '.ae-label-you{color:' + AE_AMBER_HEX + '}',
  '.ae-label-you{z-index:4;text-shadow:0 0 4px #000,0 0 8px #000,0 1px 2px #000;font-weight:700}',
  '.ae-label-you{padding-left:' + AE_YOU_GAP_PX + 'px}.ae-label-you.ae-hang-left{padding-left:0;padding-right:' + AE_YOU_GAP_PX + 'px}',
  '.ae-label-you .ae-mark{width:16px;height:16px;background:rgba(0,0,0,.55);border:3px solid currentColor;box-shadow:0 0 0 2px rgba(0,0,0,.7),0 0 10px 2px currentColor}',   // a ringed marker with a dark halo: it stays found among the satellites
  '.ae-label-shadow{color:#ffb4a0}',
  // Red night light (the Red theme, app.css): the labels' warm and cool tints are one red, the views' bright
  // overlays go black, and the globe is recoloured by the canvas filter.
  '.night-red .ae-label,.night-red .ae-label-you,.night-red .ae-label-shadow,.night-red .ae-status{color:var(--text)}',
  '.night-red .ae-btn,.night-red .ae-card{background:' + AE_PANEL_BG_RED + '}',
  '.night-red .ae-btn[aria-pressed="true"]{background:var(--amber-glow)}',
  '.night-red .ae-go-pills .pill.active{background:var(--amber-glow);border-color:var(--amber);color:var(--text)}',
  '.night-red .ae-go-glyph{color:var(--text)}',
  '.night-red .ae-go-disc{filter:var(--red-picture)}',
  '.night-red .ae-set-choice:hover{background:var(--amber-glow)}',
  // A label that marks a place carries its dot ON the place: the dot hangs
  // off the label by the label's own gap (AE_LABEL_DX), on whichever side
  // the label hangs from its point, in either writing direction.
  '.ae-mark{position:absolute;top:50%;left:-' + AE_LABEL_DX + 'px;width:8px;height:8px;box-sizing:border-box;border-radius:50%;background:currentColor;transform:translate(-50%,-50%);box-shadow:0 0 3px #000}',
  '.ae-hang-left .ae-mark{left:auto;right:-' + AE_LABEL_DX + 'px;transform:translate(50%,-50%)}',
  '.ae-label-shadow .ae-mark{width:10px;height:10px;border:1.5px solid currentColor;background:radial-gradient(currentColor 30%,transparent 38%)}',
  // The card and the hint stand just above the controls, however tall the
  // controls and the note under them grow (a two-line note overlapped them).
  '.ae-card{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - 18px);width:min(420px,calc(100% - 32px));box-sizing:border-box;background:' + AE_PANEL_BG + ';border:1px solid var(--border);border-radius:12px;padding:12px 40px 12px 14px;font-size:13px;line-height:1.5;color:var(--text2);pointer-events:auto}',
  '.ae-card[hidden]{display:none}',
  '.ae-card h3{margin:0 0 4px;font-size:var(--fs-body,15px);font-weight:600;color:var(--text);-webkit-user-select:text;user-select:text}',   // a name can be selected and copied, though the view it stands over cannot
  '.ae-card p{margin:0}',
  '.ae-card p+p{margin-top:2px}',
  // A third of an upright phone at most: the card is read in a glance, the view stays the picture.
  '.ae-card{max-height:25vh;overflow-y:auto;overscroll-behavior:contain}',
  '.ae-card.ae-card-site{padding:8px 12px}',
  // The strip along the top (almanac.js _almPinHtml, the page's own pinned strip): the shared clock, then a search pill that
  // opens Go to. The picture shows through it; it does not mind a card, which stands at the foot.
  '.alm-pin.ae-pin{position:absolute;top:var(--ae-hdr,0px);inset-inline:0;z-index:1;background:linear-gradient(rgba(0,0,0,.72),rgba(0,0,0,0));border:0;box-shadow:none;animation:none}',
  '.ae-pin .alm-pin-clock:has(.alm-ck-rest){height:36px}',
  '.ae-pin .alm-spd{--spd-up:9px;--spd-down:9px}',   // 26 drawn, 44 to a finger: nothing under it in the 3D view takes the taps
  // One time bar in every mode, the same whole strip: standing and flying have the ground's caption or the readout under it.
  '.ae-view.ae-bare .af-read{opacity:0;visibility:hidden}',
  '.ae-flying .af-read{top:calc(var(--ae-pin-h,0px) + 6px);inset-inline:16px}',   // under the strip, not under the header   // the ship's own speed readout: the strip's is the only one
  '.alm-spd.alm-spd-capped::before,.alm-spd.alm-spd-capped::after{content:"";position:absolute;top:calc(var(--spd-h) / 2 - 3px);height:6px;border-radius:3px;background:rgba(0,0,0,.72);pointer-events:none;z-index:1}',
  '.alm-spd.alm-spd-capped::before{inset-inline-start:calc(var(--spd-thumb) / 2);width:calc(var(--dim-l) * (100% - var(--spd-thumb)))}',
  '.alm-spd.alm-spd-capped::after{inset-inline-end:calc(var(--spd-thumb) / 2);width:calc(var(--dim-r) * (100% - var(--spd-thumb)))}',
  '.ae-standing .ae-stand-hud{top:var(--ae-pin-h,0px)}',
  // The rim button and the camera button above it: one way in and out of the ground and the air (almanac-earth.js _aeRimState),
  // at the foot's end, level with the row. The row leaves them their room.
  '.ae-rim .ae-tool-svg,.ae-cam .ae-tool-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
  '.ae-rim .ae-rim-glyph{width:24px;height:24px}',
  '.ae-rim-glyph path{stroke:var(--amber)}',
  '.ae-rim-glyph circle{stroke:none}',
  '.ae-rim-glyph .ae-rim-dim{fill:var(--text2);opacity:.55}',   // the place you are not in: grey, never lit
  '.ae-rim-glyph .ae-rim-lit{fill:var(--amber);transition:transform var(--ae-move-ms,2200ms) ease-in-out}',   // where you are; the move's own length, set by _aeRimPaint
  '.ae-rim-glyph.ae-rim-ground .ae-rim-lit{transform:translate(10px,10px)}',   // from (6,6) in space to (16,16) on the ground, leaving the dim one behind
  '@media (prefers-reduced-motion:reduce){.ae-rim-glyph .ae-rim-lit{transition:none}}',
  // The 3D screen laid out again: no page bar inside the view (it keeps its place, only unseen, so nothing under it moves); the time bar is
  // pinned to the top edge between the way out and the search, two 44 px circles.
  'body.ae-3d .topbar{opacity:0;visibility:hidden;pointer-events:none}',
  // The corner column: the rim at the bottom, the UFO above it. Everything the old right-hand column held (layers, settings, locate, facts) lives
  // in the name pill's sheet; those buttons stay in the page for their code, unseen.
  '.ae-view:not(.ae-static) .ae-top{display:none}',   // (set aside, the view keeps its gear: Performance)
  // The name pill: where you are, bottom left above the strip; tap it for the world's sheet.
  // The band (the top row while the search sheet is up) and the split: the picture is the square under it, the sheet is everything below.
  '.ae-band{position:absolute;top:calc(8px + var(--sat,0px));inset-inline:calc(12px + env(safe-area-inset-left)) calc(12px + env(safe-area-inset-right));height:' + AE_HIT_PX + 'px;display:flex;align-items:center;gap:6px;z-index:' + AH_TOP_Z + '}',
  '.ae-band[hidden]{display:none}',
  // The one drawer, under the band: the satellites' filters and passes, or the settings, one at a time (the sheet drops to its search row while it is up).
  '.ae-drawer{position:absolute;z-index:' + AH_TOP_Z + ';top:calc(var(--sat,0px) + ' + (AE_HIT_PX + 16) + 'px);inset-inline:calc(12px + env(safe-area-inset-left)) calc(12px + env(safe-area-inset-right));max-height:' + AE_DRAWER_MAX + ';overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;padding:var(--sp-3,12px);font-size:var(--fs-small,13px);line-height:1.45;color:var(--text2)}',
  '.ae-drawer[hidden]{display:none}',
  '@media (min-width:760px) and (min-height:600px){.ae-drawer{inset-inline-end:auto;width:min(560px,calc(100% - 24px))}}',
  '.ae-drawer-up .ae-go :is(.ae-go-pills,#ae-go-groups,#ae-go-top,#ae-go-found,#ae-go-none){display:none}',
  // Under a drawer the sheet is its search bar and nothing else, on every screen; a tap on the bar brings the rest back (_aeGoBarTap).
  '.ae-go-up.ae-drawer-up .ae-go{height:auto}.ae-go-up.ae-drawer-up .ae-go-body{padding-bottom:0;overflow:hidden}',
  '@media (max-width:759px) and (orientation:portrait){.ae-go-up.ae-drawer-up .ae-go-body>.ae-go-head{padding-inline-start:' + (12 + AE_HIT_PX + 8) + 'px}}',   // (the sheet's X circle stands at its foot's start: the bar begins beside it)
  '@media (max-width:759px) and (orientation:portrait){.ae-go-up.ae-drawer-up .ae-go{top:auto}.ae-go-up.ae-typing .ae-go{top:calc(var(--sat,0px) + ' + (AE_HIT_PX + 16) + 'px)}}',
  '@media (orientation:landscape) and (max-height:460px){html .ae-view.ae-go-up.ae-drawer-up .ae-go:not([hidden]){display:none!important}.ae-drawer{max-height:calc(100% - var(--sat,0px) - ' + (AE_HIT_PX + 24) + 'px - env(safe-area-inset-bottom))}}',   // (too little height for a search row too: the drawer has the room)
  '.ae-band .ae-round{--round:' + AE_HIT_PX + 'px;flex:none}',
  '.ae-band-name{flex:1;min-width:0;height:' + AE_HIT_PX + 'px;border:0;background:none;color:var(--text);font:inherit;font-size:20px;font-weight:650;letter-spacing:-.01em;text-align:start;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 6px rgba(0,0,0,.8);cursor:pointer}',
  '.ae-band-name[data-long]{font-size:17px}',
  '.ae-band-name:disabled{cursor:default;color:var(--text)}',
  '.ae-band-name:focus-visible{outline:2px solid var(--amber);outline-offset:2px;border-radius:8px}',
  '.ae-band-tiles{display:flex;align-items:center;gap:6px;flex:none}',
  '.ae-band-tiles [hidden]{display:none}',
  '.ae-band .ae-band-cv{--round:30px;margin-inline-start:-2px}',
  '.ae-band-cv[aria-expanded="true"] svg{transform:rotate(180deg)}',
  // Loading: an arc turns round the tile; failed: the tile is dimmed (its label says so, a tap tries again).
  '.ae-band [data-state=loading]::after{content:"";position:absolute;inset:-1px;border-radius:50%;border:2px solid transparent;border-top-color:var(--amber);animation:ae-band-spin 900ms linear infinite;pointer-events:none}',
  '.ae-band [data-state=failed]{opacity:.5}',
  '@keyframes ae-band-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion:reduce){.ae-band [data-state=loading]::after{animation:none;border-color:var(--amber)}}',
  '.ae-band .ae-dot::after{content:"";position:absolute;top:3px;inset-inline-end:3px;width:8px;height:8px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 1.5px rgba(0,0,0,.6)}',
  '.ae-band .ae-round{position:relative}',
  // With the sheet up, the rest of the chrome steps aside (the sheet covers the planets row; the band stands where the corner buttons were).
  '.ae-go-up .ae-top,.ae-go-up .ae-back,.ae-go-up .ae-ufo,.ae-go-up .ae-youbtn,.ae-go-up .ae-cam,.ae-go-up .ae-north,.ae-go-up .ae-sbs,.ae-go-up .ae-rim,.ae-go-up .ae-pin,.ae-go-up .ae-row,.ae-go-up .ae-note,.ae-go-up .ae-hint,.ae-go-up .ae-mini,.ae-go-up #ah-info,.ae-go-up #ae-clock,.ae-go-up .af-lever,.ae-go-up .af-hint,.ae-go-up #af-refs{opacity:0;visibility:hidden;transition:opacity 120ms,visibility 0s 120ms}',
  '.ae-go-up :is(.ae-top,.ae-back,.ae-ufo,.ae-youbtn,.ae-cam,.ae-north,.ae-sbs,.ae-rim,.ae-pin,.ae-row,.ae-note,.ae-hint,.ae-mini,#ah-info,#ae-clock,.af-lever,.af-hint,#af-refs),.ae-go-up :is(.ae-top,.ae-pin,#ae-clock,.ae-row,.ae-note) *,.ae-go-up #ae-clock{pointer-events:none}',
  '@media (prefers-reduced-motion:reduce){.ae-go-up .ae-top,.ae-go-up .ae-back,.ae-go-up .ae-ufo,.ae-go-up .ae-row{transition:none}}',
  // The search circle stays while the sheet is up and is its way out: the magnifier turns into an X (they trade places, turning, in the tokens' settle time).
  '.ae-find svg{transition:opacity var(--dur-settle,200ms) var(--ease-settle,ease-out),transform var(--dur-settle,200ms) var(--ease-settle,ease-out)}',
  '.ae-find .ae-find-x{position:absolute;opacity:0;transform:rotate(-90deg) scale(.6)}',
  '.ae-go-up .ae-find .ae-find-x{opacity:1;transform:none}.ae-go-up .ae-find .ae-find-mag{opacity:0;transform:rotate(90deg) scale(.6)}',
  '@media (prefers-reduced-motion:reduce){.ae-find svg{transition:none}}',
  // Under the circle, the portrait sheet's last row can scroll clear of it.
  '@media (max-width:759px) and (orientation:portrait){.ae-go-up .ae-go-body{padding-bottom:' + (AE_HIT_PX + 24) + 'px}}',
  '@media (max-width:759px) and (orientation:portrait){.ae-go-up .ae-bottom{top:0;background:none;padding:0}.ae-go-up .ae-go{left:0;right:0;bottom:0;top:calc(var(--sat,0px) + ' + (AE_HIT_PX + 16 + AE_GO_STRIP_PX) + 'px);height:auto;border-radius:22px 22px 0 0;border-inline:0;border-bottom:0;padding-bottom:env(safe-area-inset-bottom)}}',
  '.ae-pin .alm-ck-z,.ae-pin .alm-ck-zn,.ae-pin .alm-ck-pl{display:none!important}',   // the bar is the date, the time, Now and the slider: the zone does not fit between the circles
  // The rate (while the time runs or is not real time) stands beside Now on the date and time's line, as in the collapsed chip.
  'html .ae-pin .alm-clock .alm-ck-l{flex-wrap:wrap;justify-content:center;row-gap:0;height:auto;overflow:visible;align-content:center}',
  '.ae-pin .alm-ck-r{order:1;flex:none;margin:0;margin-inline-start:12px;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:16px;color:var(--amber)}',
  '.ae-pin .alm-ck-now,.ae-pin .alm-ck-r:not(:empty)+.alm-ck-now{order:2;margin-inline-start:8px}',
  // The top unit is one glass capsule: back, the date and time, search, the slider directly under the time (as on the Almanac page), the
  // where line at its foot. The two circles stand inside it, 44 px, with no material of their own.
  '@media not all and (orientation:landscape) and (max-height:460px){.alm-pin.ae-pin{top:calc(8px + var(--sat,0px));inset-inline:12px;padding:0 ' + AE_HIT_PX + 'px;border-radius:24px;border:1px solid var(--glass-line,rgba(255,255,255,.14));background:var(--glass-bg,rgba(14,14,16,.62));-webkit-backdrop-filter:var(--glass-blur,none);backdrop-filter:var(--glass-blur,none)}.ae-pin .alm-pin-clock,.ae-pin .alm-pin-clock:has(.alm-ck-rest){height:auto;min-height:0;padding:0}}',
  '.ae-pin .alm-ck-d,.ae-pin .alm-ck-t{font-size:13px}.ae-pin .alm-ck-now{margin-inline-start:10px}',   // room for Now beside the time
  // Surface tiles loading for more than half a second: a small spinner after the body's name, no words (a tap on the name says
  // what it is: _ahNameTap). It takes the place of the picked spot's dot while it turns.
  '.ae-view .ah-info.ae-loading>b::after{content:"";display:inline-block;width:11px;height:11px;margin-inline-start:8px;background:none;box-sizing:border-box;border:2px solid var(--border-strong,rgba(255,255,255,.25));border-top-color:var(--amber);border-radius:50%;vertical-align:-1px;animation:ae-spin .8s linear infinite}',
  '@keyframes ae-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion:reduce){.ah-info.ae-loading>b::after{animation:none}}',
  '.ae-pin .alm-ck-l{min-height:' + AE_HIT_PX + 'px;display:flex;align-items:center;justify-content:center}',   // the date and time are a 44 px tall tap area
  // The time unit is a glass chip (capsule B): live the time alone; off now or running the date, the rate and Now; a tap on it opens the
  // capsule (slider, where line, rate) for scrubbing, a tap away or on it closes it again. The two circles stand beside it, glass too.
  '.alm-pin.ae-pin:not(.ae-pin-open){background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;pointer-events:none;padding:0!important;top:calc(8px + var(--sat,0px));inset-inline:0;display:flex;justify-content:center;align-items:flex-start}',
  '.ae-pin:not(.ae-pin-open) .alm-pin-clock,.ae-pin:not(.ae-pin-open) .alm-pin-clock:has(.alm-ck-rest){pointer-events:auto;flex:0 1 auto;width:max-content;min-width:0;max-width:calc(100% - ' + (2 * (12 + AE_HIT_PX + 6)) + 'px);height:auto;min-height:' + AE_HIT_PX + 'px;padding:0 15px;border-radius:' + (AE_HIT_PX / 2) + 'px;border:1px solid var(--ae-chip-line,rgba(255,255,255,.24));background:var(--ae-chip-bg,rgba(255,255,255,.08));-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 1px 8px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;cursor:pointer}',
  '.ae-pin:not(.ae-pin-open) .alm-clock{width:auto}',
  '.ae-pin:not(.ae-pin-open) .alm-clock .ep{text-decoration:none!important;pointer-events:none}.ae-pin:not(.ae-pin-open) .alm-clock .ep::before{display:none}',   // the chip is one tap; its parts are typed only in the open capsule (nor do their finger-wide hit areas stand past its end)
  '.ae-pin:not(.ae-pin-open) .alm-ck-note,.ae-pin:not(.ae-pin-open) .alm-spd{display:none!important}',
  'html .ae-pin:not(.ae-pin-open) .alm-clock .alm-ck-l{flex-wrap:wrap;justify-content:center;align-items:center;column-gap:5px;row-gap:2px;min-height:' + (AE_HIT_PX - 2) + 'px;height:auto;margin:0;padding:3px 0;overflow:visible}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-l .alm-ck-d,.ae-pin:not(.ae-pin-open) .alm-ck-l .alm-ck-t{font-size:13px;white-space:nowrap}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-d{font-weight:600;color:var(--text)}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-d:empty,.ae-pin:not(.ae-pin-open) .alm-ck-fast .alm-ck-t{display:none}',   // (the date is as long as the chip has room for: almanac.js _almChipFit)
  '.ae-pin:not(.ae-pin-open) .alm-ck-live .alm-ck-t{font-weight:600;color:var(--text)}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-live .alm-ck-d{font-weight:500;color:var(--text2)}',   // live, the time leads; away from now, the date
  '.ae-pin .alm-clock{font-variant-numeric:tabular-nums}',   // the figures keep their width while the time runs
  '.ae-pin:not(.ae-pin-open) .alm-ck-r{order:0;flex:none;display:inline-flex;align-items:center;gap:4px;margin:0;font-size:12px;font-weight:600;line-height:16px;color:var(--amber)}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-r:empty{display:none}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-now,.ae-pin:not(.ae-pin-open) .alm-ck-r:not(:empty)+.alm-ck-now{order:0;margin:0;min-height:28px;padding:0 9px;display:inline-flex;align-items:center;font-size:12px;font-weight:600;line-height:1}',
  '.ae-pin:not(.ae-pin-open) .alm-ck-now[hidden]{display:none}',
  '.ae-pin:not(.ae-pin-open) .alm-pin-clock:has(.alm-ck-now:not([hidden])){padding-inline-end:7px}',
  '.ae-mission .ae-pin:not(.ae-pin-open) .alm-pin-clock{padding-inline-end:15px!important}',
  '.ae-mission .ae-pin .alm-ck-r{display:none}',   // one play state in a mission: the bar's own play button; the chip keeps the time and its speed   // the Now pill sits as far in from the edge as it does from the top: the capsule's insets match on every side
  '.ae-mission .ae-pin .alm-ck-now{display:none!important}',   // in a mission the timeline says NOW: the chip's own Now (today) is not offered beside it
  '@media (orientation:landscape) and (max-height:460px){.alm-pin.ae-pin.ae-pin-open{top:calc(8px + var(--sat,0px));margin-inline:auto;width:min(calc(100% - 232px),760px);inset-inline:0;padding-inline:14px;background:var(--ae-sheet-bg,rgba(18,18,22,.66));border:1px solid var(--ae-chip-line,rgba(255,255,255,.26));border-radius:22px;-webkit-backdrop-filter:blur(22px);backdrop-filter:blur(22px)}}',   // open, the clock reads on any sky: a glass backing the strip's and corner buttons' width clear
  '@keyframes ae-pin-grow{from{opacity:.35;transform:scaleY(.6)}to{opacity:1;transform:none}}',
  '@keyframes ae-chip-in{from{opacity:.4;transform:scale(.92)}to{opacity:1;transform:none}}',
  '.alm-pin.ae-pin.ae-pin-growing{transform-origin:50% 0;animation:ae-pin-grow .18s ease-out}',
  '.alm-pin.ae-pin.ae-pin-shrinking .alm-pin-clock{transform-origin:50% 0;animation:ae-chip-in .18s ease-out}',
  '@media (prefers-reduced-motion:reduce){.alm-pin.ae-pin.ae-pin-growing,.alm-pin.ae-pin.ae-pin-shrinking .alm-pin-clock{animation:none}}',
  ':root.night-red #almanac-view .alm-pin.ae-pin{background:linear-gradient(rgba(0,0,0,.72),rgba(0,0,0,0))}',
  '.ae-card .ae-card-note{color:var(--amber)}',
  // A body's facts: a sheet up from the foot on a phone, a panel down the right on a wide screen (the gear's panel and
  // the card stand in the same solid colour). Hidden by its transform and visibility, so it can slide.
  '.ae-info{position:absolute;z-index:4;inset-inline:0;bottom:0;max-height:min(62%,520px);box-sizing:border-box;display:flex;flex-direction:column;background:' + AE_PANEL_BG + ';border:1px solid var(--border);border-bottom:0;border-radius:16px 16px 0 0;color:var(--text2);font-size:13px;line-height:1.45;transform:translateY(105%);visibility:hidden;transition:transform .25s ease,visibility 0s .25s;touch-action:pan-y;-webkit-user-select:text;user-select:text}',
  '.ae-info.in{transform:none;visibility:visible;transition:transform .25s ease}',
  '@media (prefers-reduced-motion:reduce){.ae-info,.ae-info.in{transition:none}}',
  '.ae-info-grab{flex:none;width:36px;height:4px;margin:8px auto 0;border-radius:2px;background:var(--border)}',
  '@media (min-width:760px){.ae-info-grab{display:none}}',
  // The list fades out under the grab bar as it scrolls, rather than being cut under it.
  '.ae-info-body{overflow-y:auto;overscroll-behavior:contain;-webkit-mask-image:linear-gradient(transparent,#000 14px);mask-image:linear-gradient(transparent,#000 14px);padding:16px 18px calc(18px + env(safe-area-inset-bottom,0px))}',
  '.ae-info h2{margin:0 36px 10px 0;font-size:17px;font-weight:600;color:var(--text)}',
  '[dir="rtl"] .ae-info h2{margin:0 0 10px 36px}',
  '.ae-info-dl{margin:0;display:block}',
  '.ae-info-row{display:grid;grid-template-columns:minmax(96px,36%) 1fr;gap:4px 14px;padding:7px 0;border-top:1px solid var(--border)}',
  '.ae-info-row dt{color:var(--text3);font-size:var(--fs-small,13px);padding-top:1px}',
  '.ae-info-row dd{margin:0;color:var(--text);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  '.ae-info-row dd span{display:block;color:var(--text2);font-size:var(--fs-small,13px)}',
  '.ae-info-read{margin:12px 0 0;font-size:13px}',
  '.ae-info-blurb{margin:-4px 0 10px;font-size:var(--fs-body,15px);line-height:1.45;color:var(--text2)}',
  '.ae-info-now{margin:0 0 8px;font-size:13px;color:var(--text3)}',
  '.ae-info-now+.ae-info-read{margin:0 0 10px}',
  '.ae-info-read a[data-ae-open]{color:var(--amber);text-decoration:none}',
  '.ae-same{font-size:18px;font-weight:600;line-height:1}',
  '.ae-info .alm-link{color:var(--amber);text-decoration:none;cursor:pointer}',
  '.ae-info .alm-link:hover,.ae-info .alm-link:focus-visible{text-decoration:underline}',
  '@media (min-width:760px){.ae-info{inset-inline:0;margin-inline:auto;width:min(480px,100%);top:auto;bottom:0;max-height:min(62%,520px);border-radius:16px 16px 0 0;border-inline-end:1px solid var(--border);transform:translateY(105%)}.ae-info.in{transform:none}}',
  '.night-red .ae-info{background:' + AE_PANEL_BG_RED + '}',
    '.ae-place-preview{display:flex;gap:10px;align-items:flex-start;margin-top:6px;color:inherit;text-decoration:none}',
  '.ae-card h3 .ae-place-open{color:var(--amber);text-decoration:none}',
  '.ae-card .ae-place-open:hover,.ae-card .ae-place-open:focus-visible{text-decoration:underline}',
  '.ae-place-preview img{flex:0 0 auto;width:56px;height:56px;object-fit:cover;border-radius:8px;background:var(--surface2)}',
  '.ae-place-preview b{display:block;color:var(--text);font-weight:600}',
  '.ae-place-snip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
  '.ae-counter{color:var(--amber);font-variant-numeric:tabular-nums}',
  '.ae-card-x{position:absolute;z-index:1;top:4px;right:4px;width:36px;height:36px;border:0;background:none;color:var(--text3);font-size:20px;line-height:1;cursor:pointer;border-radius:8px}',
  '.ae-card-x:hover,.ae-card-x:focus-visible{color:var(--amber);outline:none}',
  '.ae-card-map{position:absolute;top:4px;right:40px;width:36px;height:36px;min-width:0;padding:0;color:var(--text3)}',
  '.ae-card-map[hidden]{display:none}',
  '[dir="rtl"] .ae-card-map{right:auto;left:40px}',
  '.ae-card:has(.ae-card-map:not([hidden])){padding-right:76px}',
  '[dir="rtl"] .ae-card:has(.ae-card-map:not([hidden])){padding-right:14px;padding-left:76px}',
  '.ae-go-item{display:flex;align-items:center}',
  '.ae-go-item .ae-go-row{flex:1;min-width:0}',
  '.ae-go-map{flex:none;width:44px;height:44px;border:0;border-radius:10px;background:none;color:var(--text3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
  '.ae-go-map:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '@media (hover:hover){.ae-go-map:hover{color:var(--amber)}}',
  '[dir="rtl"] .ae-card{padding:12px 14px 12px 40px}',
  '[dir="rtl"] .ae-card-x{right:auto;left:4px}',
  '.ae-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--text2);font-size:14px;pointer-events:none}',
  '.ae-msg[hidden]{display:none}',
  '.ae-static .ae-tools .ae-btn:not(.ae-gear),.ae-static .ae-bottom,.ae-static .ae-labels,.ae-static .ae-fullbar{display:none}',
  '.ae-static .ae-msg{justify-content:flex-end;padding-bottom:16vh}',
  '.ae-static-globe{position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);width:min(66vw,46vh,440px);height:auto;aspect-ratio:1;pointer-events:none}',
  '.ae-msg{flex-direction:column;gap:14px}',
  '.ae-msg-line{margin:0;max-width:30em}',
  '.ae-msg-try{pointer-events:auto;font-size:13px;padding:9px 16px;min-height:36px}',
  '.ae-view.ae-blank .ae-bottom,.ae-view.ae-blank .ae-status{display:none}',
  '.ae-hint{position:absolute;left:50%;bottom:calc(100% - 18px);transform:translateX(-50%);box-sizing:border-box;width:max-content;max-width:calc(100% - 232px);padding:8px 14px;border-radius:16px;background:rgba(0,0,0,.86);color:var(--text2);font-size:12px;line-height:1.4;text-align:center;pointer-events:none;opacity:0;transition:opacity .6s}',
  '.ae-hint.ae-show{opacity:1}',
  '.ae-hint.ae-tap.ae-show{pointer-events:auto;cursor:pointer;min-height:44px;display:flex;align-items:center;text-align:start}',
  '@media (prefers-reduced-motion: reduce){.ae-hint{transition:none}}',
  '@media (max-width:420px){.ae-btn{font-size:12px;padding:7px 10px;min-height:32px}.ae-status{top:60px;font-size:12px}}',
  // The round buttons, one look from the tokens (tokens.css): 32 drawn, a 44 hit area (a transparent box, so nothing drawn or laid out moves),
  // glass over the scene, the glass ink. Selected is an outline in amber; solid amber is only for a view's one action (.at-primary).
  // html raises the specificity over a module's own size for its round buttons (the launches' 38, the drive buttons' 44).
  ':where(.ae-btn.ae-round){position:relative}',   // the hit area's box, at no specificity: a button placed in a corner (the rim, the camera, home...) keeps its own position
  'html .ae-btn.ae-round{width:var(--round,32px);height:var(--round,32px);min-width:var(--round,32px);padding:0;border-radius:var(--r-full,999px);border:1px solid var(--glass-line,rgba(255,255,255,.14));background:var(--glass-bg,rgba(14,14,16,.62));-webkit-backdrop-filter:var(--glass-blur,none);backdrop-filter:var(--glass-blur,none);color:var(--glass-ink,#e8e8ed)}',
  'html .ae-btn.ae-round::after{content:"";position:absolute;inset:calc((var(--round,32px) - var(--target,44px)) / 2 - 1px)}',
  'html .ae-btn.ae-round[aria-pressed="true"],html .ae-btn.ae-round[aria-expanded="true"]{color:var(--amber);border-color:var(--amber);background:var(--glass-bg,rgba(14,14,16,.62))}',
  '@media (hover:hover){html .ae-btn.ae-round:hover{color:var(--amber);border-color:var(--amber-border);background:var(--glass-bg,rgba(14,14,16,.62))}}',
  'html .ae-btn.ae-round:focus-visible{color:var(--amber);border-color:var(--amber);background:var(--glass-bg,rgba(14,14,16,.62));outline:2px solid var(--amber);outline-offset:2px}',
  '.ae-view .ae-tools{gap:calc(var(--target,44px) - var(--round,32px))}',
  // The bottom row's chips are Zimi's pill (app.css .pill: 28 drawn, 12/500, radius 20, a 44 hit area from the coarse rule above), in glass because
  // they float over the scene. Selected is the pill's own solid amber (Red: an outline, the scene is already dim).
  'html .ae-chips .ae-btn:not(.ae-round){min-height:var(--pill-h,28px);padding:6px 14px;font-size:12px;line-height:1;font-weight:500;border-radius:20px;border:1px solid var(--glass-line,rgba(255,255,255,.14));background:var(--glass-bg,rgba(14,14,16,.62));-webkit-backdrop-filter:var(--glass-blur,none);backdrop-filter:var(--glass-blur,none);color:var(--glass-ink,#e8e8ed)}',
  '@media (max-width:400px){html .ae-chips .ae-btn:not(.ae-round){padding-inline:10px}}',
  '@media (hover:hover){html .ae-chips .ae-btn:not(.ae-round):hover{color:var(--amber);border-color:var(--amber-border)}}',
  'html .ae-chips .ae-btn[aria-pressed="true"]:not(.ae-round){background:linear-gradient(135deg,var(--amber),var(--amber2));color:var(--on-amber);border-color:transparent;font-weight:600}',
  'html.night-red .ae-chips .ae-btn[aria-pressed="true"]:not(.ae-round){background:var(--glass-bg);border-color:var(--amber);color:var(--amber)}',
  // One sheet: the Go to sheet, the body and landing card, the sky settings and the info sheet are one solid panel colour (the Go to sheet's pinned head is opaque, so a glass sheet beside it showed two greys), the chip's edge, radius 22, one close in the same corner,
  // no grabber, and their type is the scale's (tokens.css).
  '.ae-go,.ae-card,.ae-drawer,.ae-info{background:' + AE_PANEL_BG + ';border:1px solid var(--ae-chip-line,rgba(255,255,255,.24));border-radius:22px;-webkit-backdrop-filter:blur(22px) saturate(1.4);backdrop-filter:blur(22px) saturate(1.4);box-shadow:0 2px 16px rgba(0,0,0,.5)}',
  '.ae-info{border-bottom:0;border-radius:22px 22px 0 0}',  '.ae-go::before{content:"";display:block;flex:none;width:36px;height:4px;margin:0 auto var(--sp-2,8px);border-radius:2px;background:var(--border)}',
  '.ae-go::before{margin-top:var(--sp-2,8px)}',
  '.ae-info-grab{margin-top:var(--sp-2,8px)}',
  '.ae-card{padding:var(--sp-3,12px) var(--target,44px) var(--sp-3,12px) var(--sp-4,16px);font-size:var(--fs-small,13px)}',
  '.ae-card-x,.ae-set .alm-dismiss-x{display:flex;align-items:center;justify-content:center;position:absolute;top:0;inset-inline-end:0;width:var(--target,44px);height:var(--target,44px);padding:0;border:0;border-radius:0;background:none;color:var(--text2);font:inherit;font-size:18px;line-height:1;cursor:pointer}',
  '.ae-card-x:hover,.ae-card-x:focus-visible,.ae-set .alm-dismiss-x:hover,.ae-set .alm-dismiss-x:focus-visible{color:var(--amber);outline:none}',

  '.ae-card-map{inset-inline-end:var(--target,44px);top:4px}',
  '.ae-card:has(.ae-card-map:not([hidden])){padding-inline-end:calc(var(--target,44px) * 2)}',
  // The segmented control a sheet uses for a choice of two to four (no radio circles, no native select): selected is an amber outline and amber words.
  // The large round button (the drive buttons): 44 drawn, the same glass.
  '#ae-views{align-self:flex-start}',   // the row stands at the start (left; the right in RTL), the rim button at its end
  '.night-red .ae-go,.night-red .ae-card,.night-red .ae-drawer,.night-red .ae-info{background:var(--sheet-bg)}'
].join('\n');


// ── Go to ──
// Every place the view can fly to, in groups: Earth and Moon, the planets, their big moons, the dwarf planets, the
// spacecraft (once their table has come: opening the sheet asks for it). A row is the body's small disc and its name;
// a tap flies there and puts the sheet away.
var AE_GO_LM = 'lm:';   // a landing site's row: lm:<body>:<its index in that body's landmarks>
// The landing site a Go to row stands for ({ body, row }), once the landmarks are in.
function _aeGoLmRow(key) {
  if (!_aeLm || key.indexOf(AE_GO_LM) !== 0) return null;
  var at = key.split(':'), rows = _aeLm[at[1]], row = rows && rows[+at[2]];
  return row ? { body: at[1], row: row } : null;
}
// A compass: Go to sits in the row as one round button, so the row stays one line on a phone.
// A glyph is drawn for what has no disc: a stroke picture, 24 units square.
function _aeGlyph(inner) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
}
var AE_GLYPH_CRAFT = _aeGlyph('<rect x="9" y="9" width="6" height="8" rx="1"/><path d="M3 11h4M17 11h4M3 14h4M17 14h4M12 9V6M9 6a3 3 0 0 0 6 0z"/>');
var AE_GLYPHS = {
  iss: _aeGlyph('<path d="M12 5v14M4 8h5v4H4zM15 8h5v4h-5zM4 15h5M15 15h5"/>'),
  perseverance: _aeGlyph('<rect x="6" y="9" width="12" height="4" rx="1"/><circle cx="7" cy="17" r="2"/><circle cx="12" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M15 9V5h3"/>'),
  plan: _aeGlyph('<path d="M5 18c4-1 3-7 7-7s3-6 7-6"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="5" r="1.5"/>'),
  spin: _aeGlyph('<circle cx="8" cy="12" r="4.5"/><circle cx="17" cy="12" r="3"/>'),
  pad: _aeGlyph('<path d="M12 3c1.8 1.8 2.6 4.6 2.6 8v5H9.4v-5c0-3.4.8-6.2 2.6-8z"/><path d="M9.4 13l-2.4 3v2M14.6 13l2.4 3v2M12 19v2.5M4 21.5h16"/>')
};
// The mode marks on a row's picture (the one place a row says what a tap does besides orbit): a walking figure for the ground (walk or
// drive), a rocket for a launch you watch (a mission, a pad). A craft's model, a body's disc and the rest carry none.
var AE_GO_MARKS = {
  walk: _aeGlyph('<circle cx="12" cy="4.5" r="1.8"/><path d="M12 8v6M8.5 11l3.5-2.5 3.5 2.5M12 14l-3 6M12 14l3 6"/>'),
  launch: AE_GLYPHS.pad
};
// A mark promises what a tap does: a landing gets its walker once the sites are in and say there is a ground to stand on or drive.
// One cue per part of the sheet: the rocket on a launch to watch, the walker on a place to stand (a landing site, a pad); a thing to fly to is its own picture.
function _aeGoMarkKind(key) {
  if (key.indexOf(AE_GO_MS) === 0) return 'launch';
  return _aeGoPadId(key) || key.indexOf(AE_GO_LM) === 0 ? 'walk' : '';
}
function _aeGoMark(key) {
  var kind = _aeGoMarkKind(key);
  return kind ? '<span class="ae-go-mark" data-mark="' + kind + '">' + AE_GO_MARKS[kind] + '</span>' : '';
}
var AE_GO_ISS_HEX = 'rgb(255,209,89)', AE_GO_SUN_HEX = 'rgb(255,184,74)';
// A body's mean colour as a CSS colour: its planet's own where the view draws one, else its table colour.
function _aeGoColor(key) {
  if (key === 'sun') return AE_GO_SUN_HEX;
  var b = _aePlanetBody(key), hex = null, rgb = b ? b.color : key === 'moon' ? [0.78, 0.78, 0.78] : [0.29, 0.56, 0.85];
  if (b && !b.parent && typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]) hex = _PLANETS[b.eph].color;
  if (key === 'earth' && typeof _PLANETS !== 'undefined') hex = _PLANETS.Earth.color;
  return hex || 'rgb(' + rgb.map(function (v) { return Math.round(v * 255); }).join(',') + ')';
}
// The body a landing row is on (lm:<body>:<i>), for the disc its flag stands on.
function _aeGoLmBody(key) { return key.split(':')[1]; }
function _aeGoDisc(body) {
  var i = AE_GO_DISC_KEYS.indexOf(body), c = _aeGoColor(body);
  return '<i class="ae-go-disc" style="--c:' + (i < 0 ? 0 : i % AE_GO_DISC_COLS) + ';--r:' + (i < 0 ? 0 : Math.floor(i / AE_GO_DISC_COLS)) +
    ';--cc:' + c + ';--g:radial-gradient(circle at 35% 35%,rgba(255,255,255,.5),' + c + ' 45%,rgba(0,0,0,.55) 100%)"></i>';
}
function _aeGoGlyph(inner, color) { return '<i class="ae-go-glyph"' + (color ? ' style="--gc:' + color + '"' : '') + '>' + inner + '</i>'; }
// A craft's picture is its model's render (sent-v1.json's `model`, the sheet earth/sent-thumbs-v1.webp), wherever the view shows the craft:
// the row, the grid, the Sent list. The index is asked for the first time one is needed (the sheet draws again when it is in). A craft with
// no render yet keeps its glyph; none is drawn as an icon where a render exists.
var AE_GO_MS_SENT = { apollo11: 'apollo-11', perseverance: 'perseverance', voyager1: 'voyager1', voyager2: 'voyager2' };   // a mission's id to its object's
function _aeGoCraftObj(key) {
  if (!_aeSent) return null;
  var id = key === 'iss' || _aeIsOrbiter(key) ? key : key.indexOf(AE_GO_MS) === 0 ? AE_GO_MS_SENT[key.slice(AE_GO_MS.length)] : null, o = id ? _aeSent.byId[id] : null, i, rows, row;
  if (o) return o;
  if (_aeIsProbe(key)) { for (i = 0; i < _aeSent.objects.length; i++) if (_aeSent.objects[i].where && _aeSent.objects[i].where.track === key) return _aeSent.objects[i]; }
  if (_aeGoLmRow(key) && _aeLm) {
    rows = _aeLm[_aeGoLmBody(key)]; row = rows && rows[+key.split(':')[2]];
    for (i = 0; row && i < _aeSent.objects.length; i++) { var w = _aeSent.objects[i].where; if (w && w.body === _aeGoLmBody(key) && w.site === row[0]) return _aeSent.objects[i]; }
  }
  return null;
}
function _aeGoCraftPic(key) {
  var craft = key === 'iss' || key.indexOf(AE_GO_MS) === 0 || _aeIsCraft(key) || _aeGoLmRow(key);
  if (!craft) return '';
  if (!_aeSent) { _aeSentStart(); return ''; }
  var o = _aeGoCraftObj(key);
  return o && _aeSent.pics && _aeSent.pics[o.model] !== undefined && typeof _aeSentPicture === 'function' ? _aeSentPicture(o) : '';
}
// What a row leads with: the body's disc, a craft's model render (else its glyph; a landing's disc with its flag), a spacecraft's glyph.
function _aeGoThumb(key) {
  return '<span class="ae-go-thumb">' + (_aeGoCraftPic(key) || _aeGoThumbArt(key)) + _aeGoMark(key) + '</span>';
}
// What a row draws when it has no render: a spacecraft's glyph, a landing's disc with its flag, the body's disc.
function _aeGoThumbArt(key) {
  if (key.indexOf(AE_GO_MS) === 0) return _aeGoGlyph(AE_GLYPHS[key.slice(AE_GO_MS.length)] || AE_GLYPH_CRAFT);
  if (_aeGoPadId(key)) return _aeGoGlyph(AE_GLYPHS.pad);
  if (_aeGoLmRow(key)) return _aeGoDisc(_aeGoLmBody(key));
  if (key === 'iss') return _aeGoGlyph(AE_GLYPHS.iss, AE_GO_ISS_HEX);
  if (key === AE_SPIN_KEY) return _aeGoGlyph(AE_GLYPHS.spin, 'var(--amber)');
  if (_aeIsCraft(key)) return _aeGoGlyph(AE_GLYPH_CRAFT);
  return _aeGoDisc(key);
}
var AE_GO_LOADING = '…';   // a group's place while its table loads (never a body's key)
// The pills: what each shows. 'all' keeps the groups under their headings.
var AE_GO_PILLS = [['all', 'all'], ['planets', 'alm_go_planets'], ['moons', 'alm_go_moons'], ['small', 'alm_go_small'], ['sent', 'alm_go_sent'], ['landings', 'alm_go_landings']];
var AE_GO_GROUP_PILL = { alm_go_landings: 'landings' };   // the Moon's Landings chip opens the sheet on that pill
var AE_GO_VIEW_KEY = 'zimi_go_view';                       // 'grid' (little models) or 'list'; the device's own
var AE_GO_VIEWS = ['grid', 'list'];
var _aeGoFilter = 'all';                                   // 'all' (the one list, its pills its sections) or 'sent' (that pill's own list), kept for as long as the page lives
function _aeGoView() {
  var v = _rawGet(AE_GO_VIEW_KEY);
  return AE_GO_VIEWS.indexOf(v) >= 0 ? v : AE_GO_VIEWS[0];
}
function _aeGoSetView(v) { try { localStorage.setItem(AE_GO_VIEW_KEY, v); } catch (e) {} }
// [group label key, its keys, its pill when the whole group has one]; Earth and Moon split across Planets and Moons.
function _aeGoGroups() {
  // The Sun first, Side by side last: a view of them all, not a body, so it closes the list.
  var planets = ['sun'].concat(AE_PLANETS.filter(function (b) { return !b.parent && !b.track; }).map(function (b) { return b.key; }), [AE_SPIN_KEY]);
  var moons = AE_PLANETS.filter(function (b) { return b.parent; }).map(function (b) { return b.key; });
  var dwarfs = AE_PLANETS.filter(function (b) { return b.track; }).map(function (b) { return b.key; });
  // The spacecraft flying on the shown date: one whose table ends (Cassini into Saturn, Galileo into Jupiter) or has
  // not begun is not a place to go then.
  var jd = (_ae.scene ? _ae.scene.ms : Date.now()) / MS_PER_DAY + JD_UNIX_EPOCH;
  var craft = (_ae.issPos ? ['iss'] : []).concat(Object.keys(AE_ORBITERS).filter(function (k) { return !!_aeOrbiter[k]; }), _aeTracks ? _aeTracks.probes.filter(function (k) { return !!AE_CRAFT_MODEL[k] && !!_aeTrackAt(_aeTracks.tracks[k], jd); }) : []);
  // Every landing site by name (the Moon's first, then Mars's, Venus's and Titan's): flown to, each shows its own label
  // and card whether or not Landmarks is on.
  var landings = [];
  if (_aeLm) _aeLmBodyKeys().forEach(function (k) {
    _aeLm[k].forEach(function (r, i) { if (r[3] === 'landing') landings.push(AE_GO_LM + k + ':' + i); });
  });
  // A group whose table is still on its way shows where it will be, quietly, rather than being missing until it lands.
  if (!_aeTracks && _aeTracksLoading) craft.push(AE_GO_LOADING);
  if (!_aeLm && _aeLmLoading) landings.push(AE_GO_LOADING);
  var missions = AE_MISSION_IDS.map(function (id) { return AE_GO_MS + id; }), pads = AE_PAD_IDS.map(function (id) { return AE_GO_PAD + id; });
  // Three plain parts, each one outcome: things to fly to and see (the bodies, then the spacecraft; the Sent grid closes them), places to
  // stand (landing sites, then the launch pads), launches to watch (a mission opens at its liftoff).
  return [['alm_go_earth_moon', ['earth', 'moon'], null], ['alm_go_planets', planets, 'planets'], ['alm_go_moons', moons, 'moons'],
    ['alm_go_dwarfs', dwarfs, 'small'], ['alm_go_craft', craft, null], ['alm_go_landings', landings, 'landings'], ['alm_pad_at', pads, null], ['alm_go_missions', missions, null]]   // (the pills' order)
    .filter(function (g) { return g[1].length; });
}
function _aeGoName(key) {
  if (key.indexOf(AE_SENT) === 0) return _aeSentObj(key).name;
  if (key.indexOf(AE_GO_MS) === 0) return _aeT('alm_ms_' + key.slice(AE_GO_MS.length));
  if (_aeGoPadId(key)) return _aeT('alm_ms_' + _aeGoPadId(key));
  var lmRow = _aeGoLmRow(key);
  if (lmRow) return lmRow.row[0];
  if (key === 'earth') return _tp('Earth');
  if (key === 'sun') return _aeT('alm_sun');
  if (key === AE_SPIN_KEY) return _aeT('alm_spin_view');
  if (key === 'iss') return _aeT('alm_earth_iss_short');
  if (key === 'moon') return _aeT('alm_moon');
  if (_aeIsOrbiter(key)) return AE_ORBITERS[key].name;
  if (_aeIsProbe(key)) return _aeTracks.tracks[key].name;
  var b = _aePlanetBody(key);
  return b ? _aeBodyName(b) : key;
}
// The name a body has in English whatever the language: what is typed in one language still finds it by the other.
function _aeGoEnglish(key) {
  if (key.indexOf(AE_SENT) === 0) return _aeSentObj(key).name;
  if (key.indexOf(AE_GO_MS) === 0) return key.slice(AE_GO_MS.length);
  if (_aeGoPadId(key)) return _aeGoPadId(key) + ' launch pad';
  if (key.indexOf(AE_GO_LM) === 0) return _aeGoName(key);
  var b = _aePlanetBody(key);
  return b ? b.eph || key : key === 'iss' ? 'ISS' : key;
}
// The rows (keys) that answer what is typed, best match first: by the name in the language shown or the English one.
function _aeGoFind(typed) {
  if (_aeGoFilter === 'sent') { _aeSentStart(); return _aeSent ? _aeSentFind(typed) : []; }   // typed inside the Sent pill: its rows, by name, year and world
  var hits = [];
  var take = function (k) {
    if (k === AE_GO_LOADING) return;
    var m = Math.min.apply(null, [_aeGoName(k), _aeGoEnglish(k)].map(function (n) { var r = _aePlaceMatch(typed, n); return r < 0 ? 99 : r; }));
    if (m < 99) hits.push({ key: k, match: m, at: hits.length });
  };
  _aeGoGroups().forEach(function (g) { g[1].forEach(take); });
  _aeSentGone().forEach(take);   // what ended or was lost has no other row
  hits.sort(function (a, b) { return a.match - b.match || a.at - b.at; });
  return hits.map(function (h) { return h.key; });
}
var AE_GRID_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>';
var AE_LIST_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>';
// Two rows of one name (the mission and its landing site) say which is which, in the group names the sheet already uses.
function _aeGoKindTag(k) { return k.indexOf(AE_GO_MS) === 0 ? _aeT('alm_go_launches') : _aeGoPadId(k) ? _aeT('alm_pad_at') : k.indexOf(AE_GO_LM) === 0 ? _aeT('alm_go_landings') : ''; }
function _aeGoRow(k, tagged) {
  if (k === AE_GO_LOADING) return '<span class="ae-go-wait" role="status">' + _almEsc(_aeT('loading')) + '</span>';
  if (k.indexOf(AE_SENT) === 0) return _aeSentRow(k);
  return '<button type="button" class="ae-go-row" data-ae-go="' + k + '" aria-current="' + (k === _ae.target) + '">' + _aeGoThumb(k) + '<span>' + _almEsc(_aeGoName(k) + (tagged ? ' \u00b7 ' + _aeGoKindTag(k) : '')) + '</span></button>';
}
function _aeGoLow() { return typeof ZimiCap !== 'undefined' && ZimiCap.level() === 'low'; }
// The bodies' place in the sheet: what is typed (every row that answers), else the pill showing (All: the groups under
// their headings; any other: that kind alone).
// The grid's first row, unlabelled by a heading: the Sun, the Solar system (the overview the little orrery opened) and Side by side.
var AE_ORRERY_SVG = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="3.5" fill="currentColor" stroke="none"/><circle cx="20" cy="20" r="9" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".7"/><circle cx="20" cy="20" r="15.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/><circle cx="29" cy="20" r="1.8" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>';
function _aeGoTop3Html() {
  var cells = [
    ['sun', _aeGoName('sun'), _aeGoThumb('sun')],
    ['planets', _aeT('alm_earth_view_planets'), '<span class="ae-go-thumb ae-go-orrery">' + AE_ORRERY_SVG + '</span>'],
    [AE_SPIN_KEY, _aeT('alm_spin_view'), '<span class="ae-go-thumb ae-go-three">' + ['mercury', 'earth', 'jupiter'].map(function (b) { return '<span class="ae-go-thumb">' + _aeGoDisc(b) + '</span>'; }).join('') + '</span>']
  ];
  return '<div class="ae-go-top3">' + cells.map(function (c) {
    return '<button type="button" class="ae-go-row ae-go-cell" data-ae-go="' + c[0] + '" aria-current="' + (c[0] === _ae.target) + '">' + c[2] + '<span>' + _almEsc(c[1]) + '</span></button>';
  }).join('') + '</div>';
}
function _aeGoRender() {
  var sheet = _aeById('ae-go'), host = _aeById('ae-go-groups');
  if (!sheet || sheet.hidden || !host) return;
  var typed = _aeGoTyped(), html = '', groups = _aeGoGroups();
  host.className = (_aeGoView() === 'grid' && _aeGoFilter !== 'sent' ? 'ae-go-grid' : '') + (_aeGoLow() ? ' ae-go-flat' : '');
  _ae.goHits = [];
  sheet.classList.toggle('ae-go-listonly', _aeGoFilter === 'sent');   // the Sent pill is a list: its rows are read by name and place
  if (typed) {
    _ae.goHits = _aeGoFind(typed);
    var seen = {};
    _ae.goHits.forEach(function (k) { var n = _aeGoName(k); seen[n] = (seen[n] || 0) + 1; });
    html = _ae.goHits.length ? '<div class="ae-go-list">' + _ae.goHits.map(function (k) { return _aeGoRow(k, seen[_aeGoName(k)] > 1); }).join('') + '</div>' : '';
  } else if (_aeGoFilter === 'all') {
    var gridded = _aeGoView() === 'grid';
    var sent = '', sentSites = '';
    if (gridded) { if (_aeSent && typeof _aeSentGrid === 'function') { sent = _aeSentGrid(); sentSites = _aeSentGrid(true); } else _aeSentStart(); }
    html = '<h4 class="ae-go-sec"><span>' + _almEsc(_aeT('alm_go_fly')) + '</span></h4>' + groups.map(function (g) {
      if (gridded && g[0] === 'alm_go_planets') g = [g[0], g[1].filter(function (k) { return k !== 'sun' && k !== AE_SPIN_KEY; }), g[2]];   // the first row has them
      var sec = AE_GO_SECTION_HEAD[g[0]];   // the places to stand and the launches each start their part under its own heading
      return (g[0] === 'alm_go_landings' ? sent : '') + '<h4 data-g="' + g[0] + '"' + (sec ? ' class="ae-go-sec"' : '') + '><span>' + _almEsc(_aeT(sec || g[0])) + '</span></h4><div class="ae-go-list">' + g[1].map(function (k) { return _aeGoRow(k); }).join('') + '</div>' + (g[0] === 'alm_go_landings' ? sentSites : '');   // (the landers standing on their worlds close the places to stand)
    }).join('') + (groups.some(function (g) { return g[0] === 'alm_go_landings'; }) ? '' : sent);   // (the Sent grid closes the things to fly to, before the places to stand: the pills light in their own order as the list scrolls)
  } else html = _aeGoSentList();   // (Sent is the one pill that is a list of its own; the rest are places in this one)
  host.innerHTML = html;
  var top = _aeById('ae-go-top'), showTop = !typed && _aeGoFilter === 'all' && _aeGoView() === 'grid';   // the Sun, the Solar system and Side by side lead the sheet, above this place's own rows
  if (top) { top.hidden = !showTop; top.innerHTML = showTop ? _aeGoTop3Html() : ''; }
  _aeBandPaint();
  _aeGoNone();
  _aeGoLight(_aeGoFilter === 'all' ? _aeGoSectionNow() : _aeGoFilter);
  Array.prototype.forEach.call(sheet.querySelectorAll('[data-ae-gomode]'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-ae-gomode') === _aeGoView())); });
}
// The pills are the list's sections, as on the Almanac's own page: a tap goes to that section of the one list (Sent is a
// list of its own), and as the list scrolls the pill of the section under the head is lit. The section is whichever
// heading last crossed the body's top (read on scroll, at most once a frame by the browser's own pace).
var AE_GO_SECTION_PILL = { alm_go_earth_moon: 'all', alm_go_planets: 'planets', alm_go_moons: 'moons', alm_go_dwarfs: 'small', alm_go_craft: 'sent', alm_go_landings: 'landings', alm_pad_at: 'landings', alm_go_missions: 'landings' };   // (the pads and the launches follow the places to stand: no pill of their own)
var AE_GO_SECTION_HEAD = { alm_go_landings: 'alm_go_landings', alm_go_missions: 'alm_go_launches' };   // the group that opens a part of the sheet: its heading's words
var AE_GO_LINE_PX = 24;   // a heading this close under the body's top (about its own height) counts as reached
function _aeGoBody() { var sheet = _aeById('ae-go'); return sheet ? sheet.querySelector('.ae-go-body') : null; }
// Where the list shows from: under the pills where they stick, else the body's top.
function _aeGoUnder(body) { var h = body.querySelector('.ae-go-head'), b = body.getBoundingClientRect().top; return h ? Math.max(b, h.getBoundingClientRect().bottom) : b; }
function _aeGoHeads(body) {
  return Array.prototype.filter.call(body.querySelectorAll('#ae-go-groups h4'), function (h) { return h.hasAttribute('data-g') && AE_GO_SECTION_PILL[h.getAttribute('data-g')] || h.classList.contains('ae-sent-top'); });
}
function _aeGoPillOf(h) { return h.classList.contains('ae-sent-top') ? 'sent' : AE_GO_SECTION_PILL[h.getAttribute('data-g')]; }
function _aeGoSectionNow() {
  var body = _aeGoBody(), pill = 'all';
  if (!body || _aeGoTyped()) return pill;
  var line = _aeGoUnder(body) + AE_GO_LINE_PX;
  _aeGoHeads(body).forEach(function (h) { if (h.getBoundingClientRect().top <= line) pill = _aeGoPillOf(h); });
  if (body.scrollTop + body.clientHeight >= body.scrollHeight - 1 && _aeGoHeads(body).length) pill = _aeGoPillOf(_aeGoHeads(body).slice(-1)[0]);   // the end reached: its section, however short
  return pill;
}
function _aeGoLight(pill) {
  var sheet = _aeById('ae-go'), typed = _aeGoTyped();
  if (!sheet) return;
  Array.prototype.forEach.call(sheet.querySelectorAll('[data-ae-pill]'), function (b) {
    var on = b.getAttribute('data-ae-pill') === pill && !typed;
    if (b.classList.contains('active') === on) return;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    if (on) { var row = b.parentNode, l = b.offsetLeft - row.offsetLeft; if (l < row.scrollLeft || l + b.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = l - (row.clientWidth - b.offsetWidth) / 2; }   // the lit pill kept in the row's sight
  });
}
function _aeGoTrack() { if (_aeGoFilter === 'all') _aeGoLight(_aeGoSectionNow()); }
// A pill taken: its section of the one list to the top (the field and the selector scroll away above it), or the Sent list.
function _aeGoJump(pill) {
  var q = _aeGoField();
  if (q && q.value) { q.value = ''; _aePlaceShow([]); }   // a pill taken ends the search
  _aeGoFilter = pill === 'sent' ? 'sent' : 'all';
  _aeGoRender();
  var body = _aeGoBody();
  if (!body) return;
  if (pill === 'sent' || pill === 'all') { body.scrollTop = 0; _aeGoLight(pill); return; }
  var to = _aeGoHeads(body).filter(function (h) { return _aeGoPillOf(h) === pill; })[0];
  if (!to) { body.scrollTop = 0; _aeGoLight(pill); return; }
  body.scrollTop += to.getBoundingClientRect().top - body.getBoundingClientRect().top;   // its heading to the top, then out from under the pills that stick there
  body.scrollTop += to.getBoundingClientRect().top - _aeGoUnder(body);
  _aeGoLight(pill);
}
// A body or landing or mission picked: the sheet put away, the view flies there.
function _aeGoPick(key) {
  _aeShowGo(false);
  _aeHudLeaveGround();
  var lmRow = _aeGoLmRow(key);
  if (key.indexOf(AE_SENT) === 0) { _aeSentPick(key); return; }
  if (key.indexOf(AE_GO_MS) === 0) { _aeMissionStart(key.slice(AE_GO_MS.length)); return; }
  if (_aeGoPadId(key)) { _aeGoPad(_aeGoPadId(key)); return; }
  if (lmRow) { _aeGoVisit(lmRow); return; }
  _aePreset(key);
}
// A landing site picked: the view comes to its world with the site in the middle and its card up ("give me context
// even showing the entire body would be fine I can always zoom in myself or pop to surface in one click"): the card's Visit is the one tap down.
function _aeGoVisit(lmRow) {
  _aeLmOpen(lmRow.body, lmRow.row);
  _aeLmFly(lmRow.body, lmRow.row, 'wide');
}
// `group`: open on that group's pill (the Moon's Landings chip), now or as soon as its table is there. `focus`: the field is raised at once (a tap on the search pill is a touch on a field).
function _aeShowGo(on, group, focus) {
  var sheet = _aeById('ae-go'), q = _aeGoField();
  if (!sheet) return;
  if (on) _aeSheetClaim('go'); else _aeDrawerShut();   // (the drawer hangs under the band: it goes with it)
  sheet.hidden = !on;
  _aeBandShow(!!on);
  _aeHudRender();
  _aeMeasureFoot();
  _ae.dirty = true; _aeKick();   // (the picture glides to the room above the sheet, or back)
  if (on) _aeBare(false); else _ae.sheetShutAt = performance.now();
  if (!on) {
    _aeFootDown();
  }
  if (on) {
    _aeGoShell(sheet);
    q = _aeGoField();   // (the field is made with the sheet, the first time)
    if (group) _aeGoFilter = 'all';
    // A sheet opened afresh shows the bodies, not the last search.
    if (q && q.value) { q.value = ''; _aePlaceShow([]); }
    _aeTracksLoad(); _aeLmLoad(); _aeGoRender();
    if (group && AE_GO_GROUP_PILL[group]) _aeGoJump(AE_GO_GROUP_PILL[group]);
    // The keyboard is the phone's to raise: on a touch screen the sheet never focuses the field (not even for the search pill); only a finger on it does.
    if (q && !(window.matchMedia && matchMedia('(pointer:coarse)').matches) && document.activeElement !== q) q.focus();
  }
}
// The page's header over the picture (hidden by CSS) for as long as the view is open (_aeChromeOn). The view's search is its own field in the Go sheet.
function _aeChromeOn(on) {
  document.body.classList.toggle(AE_BODY_CLASS, on);
  _aeMeasureFoot();
}
function _aeGoField() { return _aeById('ae-go-q'); }
function _aeGoTyped() { var q = _aeGoField(); return q ? q.value.trim() : ''; }
var _aeGoTimer = 0;
function _aeGoInput() {
  var typed = _aeGoTyped();
  if (typed && _aeById('ae-go') && _aeById('ae-go').hidden) _aeShowGo(true);
  clearTimeout(_aeGoTimer);
  // The landmarks show with the keystroke; the towns after a short pause. An answer still coming for what was typed
  // before is dropped now, not when the next question goes.
  _ae.placeTowns = null;
  _ae.placeSeq = (_ae.placeSeq || 0) + 1;
  if (_ae.placeAbort) _ae.placeAbort.abort();
  _aePlaceShow(_aePlaceMerge(typed, _aePlaceLocal(typed), []));
  _aeGoRender();
  _aeGoTimer = setTimeout(function () { _aePlaceSearch(typed); }, AE_PLACE_DELAY_MS);
}
// Enter takes the best answer; Escape (with the sheet up) puts it away. True when the key was spent here.
function _aeGoKey(e) {
  var sheet = _aeById('ae-go');
  if (e.key === 'Escape' && sheet && !sheet.hidden) { _aeShowGo(false); return true; }
  if (e.key !== 'Enter') return false;
  e.preventDefault();
  if (_ae.goHits && _ae.goHits.length) _aeGoPick(_ae.goHits[0]);   // a body by that name first, then a place
  else if (_ae.placeFound && _ae.placeFound.length) _aePlacePick(_ae.placeFound[0]);
  return true;
}
// A phone's keyboard covers the foot of the screen: while the field has the focus, the foot stands above it.
// The sheet rises to the band while typing (the picture has little room left, the answers all of it).
// It lets go a moment after the field does: the touch that blurs the field is often a tap on a row, which must still be under the finger.
var AE_TYPING_HOLD_MS = 400, _aeTypingTimer = 0;
function _aeGoTyping(on) {
  clearTimeout(_aeTypingTimer);
  var set = function () { if (_ae.el) _ae.el.classList.toggle('ae-typing', !!on); _ae.dirty = true; _aeKick(); };
  if (on) set(); else _aeTypingTimer = setTimeout(set, AE_TYPING_HOLD_MS);
}
function _aeGoFieldFocus() {
  var sheet = _aeById('ae-go');
  _aeGoBarTap();   // (the field is the bar's heart: a finger on it under a drawer brings the sheet back)
  _aeGoTyping(true);
  if (sheet && typeof _sheetAboveKeyboard === 'function' && !_ae.placeUnfit) {
    var off = _sheetAboveKeyboard(sheet);
    _ae.placeUnfit = function () { off(); sheet.style.bottom = ''; sheet.style.maxHeight = ''; };   // the sheet back to the foot
  }
}
var AE_MAP_SVG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>';
var AE_BACK_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11.5 5.5 5 12l6.5 6.5"/></svg>';
var AE_FIND_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.75" cy="10.75" r="6.25"/><path d="M15.4 15.4 19.5 19.5"/></svg>';
var AE_FIND_X_SVG = '<svg class="ae-find-x" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
var AE_SEARCH_SVG ='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/></svg>';
// ── Go to, by name: any town or landmark on the Earth ──
// A search field heads the sheet. What is typed asks the installed maps' towns (/places/suggest: "Springfield, Illinois,
// United States" with where it is) and the Earth's landmarks (landmarks-v1.json), merged best match first (a landmark
// before a town of the same match: it is the one asked for by name). A pick flies down over the place and marks it;
// its card shows its article from the library, when there is one (_aePlaceArticle).
var AE_PLACE_SUGGEST_URL = '/places/suggest', AE_PLACE_SEARCH_URL = '/search', AE_PLACE_SNIPPET_URL = '/snippet';
var AE_PLACE_DELAY_MS = 150;       // after the last key, before the towns are asked
var AE_PLACE_MAX = 8;              // rows offered
var AE_PLACE_DIST = 1.5;           // a flight to a place ends this far from the Earth's centre (Earth radii, ~3,200 km up): the place and its country round it; the Earth's map is no finer
var AE_PLACE_ARTICLE_KM = 60;      // an article that says it stands this near the place is about it (not Paris, Texas)
var AE_PLACE_CANDIDATES = 4;       // articles of the place's name looked into
var AE_PLACE_MATCH = { exact: 0, prefix: 1, word: 2, inside: 3 };   // how a name meets what was typed, best first
var AE_PLACE_ACCENTS = /[̀-ͯ]/g;
function _aePlaceNorm(s) { return String(s || '').normalize('NFD').replace(AE_PLACE_ACCENTS, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
// How `name` meets what was typed (both folded: no accents, no case), or -1.
function _aePlaceMatch(typed, name) {
  var q = _aePlaceNorm(typed), n = _aePlaceNorm(name);
  if (!q || !n) return -1;
  if (n === q) return AE_PLACE_MATCH.exact;
  if (n.indexOf(q) === 0) return AE_PLACE_MATCH.prefix;
  if (n.indexOf(' ' + q) >= 0) return AE_PLACE_MATCH.word;
  return n.indexOf(q) >= 0 ? AE_PLACE_MATCH.inside : -1;
}
// The Earth's landmarks that answer `typed`, as places: { name, label, lat, lon, kind: 'landmark', qid, match }.
function _aePlaceLandmarks(typed) {
  var out = [];
  if (_aePlaceNorm(typed)) _aeLmEarthLoad();
  ((_aeLm && _aeLm.earth) || []).forEach(function (r, i) {
    var m = _aePlaceMatch(typed, r[0]);
    if (m >= 0) out.push({ name: r[0], label: r[0], lat: r[1], lon: r[2], kind: 'landmark', qid: r[4], match: m, at: i });
  });
  return out;
}
// The world's big cities the Almanac carries for its place picker (almanac.js _MAP_CITIES), as places: found with no map
// installed ("Los Angeles, California, United States" answers "Los Angeles").
function _aePlaceCities(typed) {
  var out = [];
  (typeof _MAP_CITIES !== 'undefined' ? _MAP_CITIES : []).forEach(function (c, i) {
    var name = c.name.split(',')[0], m = _aePlaceMatch(typed, name);
    if (m >= 0) out.push({ name: name, label: c.name, lat: c.lat, lon: c.lon, kind: 'town', match: m, at: i });
  });
  return out;
}
// What answers `typed` without asking the server: the Earth's landmarks, then the big cities.
function _aePlaceLocal(typed) { return _aePlaceLandmarks(typed).concat(_aePlaceCities(typed)); }
// A town the server offered, as a place. A name the typed words reach through where it is ("Springfield, IL") has no
// match of its own: the server's answer stands for it as a prefix.
function _aePlaceTown(typed, p, i) {
  var m = _aePlaceMatch(typed, p.name);
  return { name: p.name, label: p.label, lat: p.lat, lon: p.lng, kind: 'town', match: m < 0 ? AE_PLACE_MATCH.prefix : m, at: i };
}
// Landmarks and towns together: best match first; at an equal match a landmark first; then each list's own order (the
// towns largest first, as the server gives them). Two of one name and spot are one.
function _aePlaceMerge(typed, landmarks, towns) {
  var all = landmarks.concat(towns.map(function (p, i) { return _aePlaceTown(typed, p, i); }));
  all.sort(function (a, b) {
    return a.match - b.match || (a.kind === b.kind ? 0 : a.kind === 'landmark' ? -1 : 1) || a.at - b.at;
  });
  var out = [];
  all.forEach(function (p) {
    var same = null;
    out.forEach(function (q) { if (!same && _aePlaceNorm(q.name) === _aePlaceNorm(p.name) && _aePlaceKm(q, p) < AE_PLACE_ARTICLE_KM) same = q; });
    if (!same) out.push(p);
    else if (p.label.length > same.label.length) out[out.indexOf(same)] = p;   // a city the landmarks also list: the town, in the landmark's place (its name says where it is, its card previews its article)
  });
  return out.slice(0, AE_PLACE_MAX);
}
// Kilometres between two places (haversine, on the mean sphere).
function _aePlaceKm(a, b) {
  var la = _aeRad(a.lat), lb = _aeRad(b.lat), dl = _aeRad(b.lon - a.lon);
  var h = Math.pow(Math.sin((lb - la) / 2), 2) + Math.cos(la) * Math.cos(lb) * Math.pow(Math.sin(dl / 2), 2);
  return 2 * AE_EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
// What is typed: the landmarks at once, the towns when the server has answered (none: no map, offline, or none by that name).
function _aePlaceSearch(typed) {
  var seq = _ae.placeSeq = (_ae.placeSeq || 0) + 1;
  if (_ae.placeAbort) _ae.placeAbort.abort();
  typed = typed.replace(/\s+/g, ' ').trim();
  if (!typed) { _aePlaceShow([]); return; }
  _aePlaceShow(_aePlaceMerge(typed, _aePlaceLocal(typed), []));
  _ae.placeAbort = typeof AbortController === 'function' ? new AbortController() : null;
  _aeFetch(AE_PLACE_SUGGEST_URL + '?q=' + encodeURIComponent(typed) + '&limit=' + AE_PLACE_MAX, _ae.placeAbort ? { signal: _ae.placeAbort.signal } : undefined)
    .then(_aeJson).then(function (d) {
      if (seq !== _ae.placeSeq) return;
      _ae.placeTowns = (d.places || []).filter(function (p) { return _almValidLatLon(p.lat, p.lng); });
      _aePlaceRefresh();
    }).catch(function (e) {
      if (seq !== _ae.placeSeq || (e && e.name === 'AbortError')) return;
      _ae.placeTowns = [];   // no answer (offline, no maps): what was found here is all there is
      _aePlaceRefresh();
    });
}
// What is found for what is in the field now, from the landmarks and the towns last offered (the landmarks' file may
// arrive after the first keys).
function _aePlaceRefresh() {
  var typed = _aeGoTyped();
  if (typed) _aePlaceShow(_aePlaceMerge(typed, _aePlaceLocal(typed), _ae.placeTowns || []));
}
function _aePlaceShow(list) {
  _ae.placeFound = list;
  var box = _aeById('ae-go-found');
  if (!box) return;
  box.hidden = !list.length;
  box.innerHTML = list.map(function (p, i) {
    var dot = '<i class="ae-go-dot ae-go-probe' + (p.kind === 'landmark' ? '' : ' ae-go-town') + '"></i>';
    return '<span class="ae-go-item"><button type="button" class="ae-go-row" data-ae-place="' + i + '">' + dot + '<span>' + _almEsc(p.label) + '</span></button>' + _aeGoMapBtn(i) + '</span>';
  }).join('');
  _aeGoNone();
}
// Nothing by that name, once the towns have answered too (no body, landmark, city or town): one line says so, not a
// blank sheet. While something is typed the groups give way to what it finds (_aeGoRender).
function _aeGoNone() {
  var none = _aeById('ae-go-none'), typed = _aeGoTyped();
  if (none) none.hidden = !typed || !_ae.placeTowns || !!(_ae.placeFound && _ae.placeFound.length) || !!(_ae.goHits && _ae.goHits.length);
}
// A place's map (mapflow.js through the app shell: its installed map, or the one worth downloading), as an icon beside
// the row; absent where the shell is (the Almanac ZIM on its own).
function _aeGoMapBtn(i) {
  return _aeMapsShell() ? '<button type="button" class="ae-go-map" data-ae-map="' + i + '" aria-label="' + _almEsc(_aeT('map_here')) + '">' + AE_MAP_SVG + '</button>' : '';
}
function _aePlaceSpot(p) { return { lat: p.lat, lng: p.lon, label: p.name }; }
// The place card's map button: added once the shared flow is in, shown once the place has a map to open or offer.
function _aeCardMapBtn(card, p) {
  if (!_aeMapsShell()) return;
  _mapHere().then(function (m) {
    if (!m || _ae.place !== p || card.querySelector('.ae-card-map')) return;
    card.insertAdjacentHTML('afterbegin', m.buttonHtml('ae-card-map'));
    m.bind(card.querySelector('.ae-card-map'), _aePlaceSpot(p));
  });
}
// The sheet's two places (what was found; the groups) and the search field under them: made once, the groups drawn
// afresh by _aeGoRender without taking the field's focus.
function _aeGoShell(sheet) {
  if (_aeById('ae-go-groups')) return;
  var pills = AE_GO_PILLS.map(function (p) {
    return '<button type="button" class="pill" data-ae-pill="' + p[0] + '" aria-pressed="false">' + _almEsc(_aeT(p[1])) + '</button>';
  }).join('');
  var seg = [['grid', AE_GRID_SVG, 'go_view_grid'], ['list', AE_LIST_SVG, 'go_view_list']].map(function (v) {
    return '<button type="button" data-ae-gomode="' + v[0] + '" aria-pressed="false" aria-label="' + _almEsc(_aeT(v[2])) + '">' + v[1] + '</button>';
  }).join('');
  var own = AE_SEARCH_SVG + '<input type="search" id="ae-go-q" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="' + _almEsc(_aeT('search')) + '" aria-label="' + _almEsc(_aeT('search')) + '">';
  var segHtml = '<div class="ae-go-seg" role="group">' + seg + '</div>';   // Grid or List, at the search field's end: with the field it scrolls away, and it is never half under the pills that stick
  // Top to bottom: where you are, the search and the pills (both stay at the top once the list scrolls under them; "I should always be somewhere in that order and list"), the rows.
  sheet.innerHTML = '<div class="ae-go-body"><div class="ae-go-head"><div class="ae-go-find">' + own + segHtml + '</div><div class="pills-row ae-go-pills">' + pills + '</div></div>' +
    '<div id="ae-go-top" hidden></div><div class="ae-go-wait" id="ae-go-none" role="status" hidden>' + _almEsc(_aeT('no_results')) + '</div><div id="ae-go-groups"></div><div class="ae-go-list ae-go-found" id="ae-go-found" hidden></div></div>';
  var q = _aeById('ae-go-q');
  var gobody = sheet.querySelector('.ae-go-body');
  gobody.addEventListener('scroll', _aeGoTrack, { passive: true });
  _aeSwipeShut(sheet, function () { return gobody.scrollTop > 0 || (document.activeElement && document.activeElement.id === 'ae-go-q'); }, function () { _aeShowGo(false); });
  if (!q) return;
  q.oninput = _aeGoInput;
  q.onkeydown = function (e) { _aeGoKey(e); };
  q.onfocus = _aeGoFieldFocus;
  q.onblur = _aeFootDown;
  gobody.querySelector('.ae-go-head').addEventListener('click', _aeGoBarTap);
}
// Under a drawer the sheet is only its search bar: a tap on it puts the drawer away and the whole sheet is back.
function _aeGoBarTap() { if (_aeGoDrawerUp()) _aeDrawerShut(); }
// The foot back at the bottom: the field left, or the sheet put away with the field still focused (a hidden field is
// not always told it lost the focus, and the foot stayed raised over a keyboard that had gone).
function _aeFootDown() {
  _aeGoTyping(false);
  var foot = _ae.el && _ae.el.querySelector ? _ae.el.querySelector('.ae-bottom') : null;
  if (_ae.placeUnfit) { _ae.placeUnfit(); _ae.placeUnfit = null; }
  if (foot) { foot.style.bottom = ''; foot.style.maxHeight = ''; }
}
// A place picked: down over it, marked, its card up.
function _aePlacePick(p) {
  _aeShowGo(false);
  _aeHudLeaveGround();
  var sc = _ae.scene || _aeSceneAt(_aeDisplayMs());
  _ae.place = { name: p.name, label: p.label, lat: p.lat, lon: p.lon, kind: p.kind, qid: p.qid || null, article: null };
  _ae.lm = null; _ae.sent = null; _ae.selected = null; _ae.arrived = null; _ae.pick = null;
  if (_ae.spin) _aeLeaveSpin();
  _ae.preset = 'earth';
  _aeFlyTo('earth', AE_PLACE_DIST, _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(p.lat, p.lon), sc.gast)));
  _aeMarkViews();
  _aeRenderCard();
  _aePlaceArticle(_ae.place);
}
// The place's article in the library: a landmark's by its Q-ID (the Almanac's own links), a town's by its name among the
// search's first answers, the one whose page says it stands near the place. { zim, path, title, snippet, thumbnail }
// into place.article, the card drawn again. None (no library, no such page, one about another place) is no preview.
function _aePlaceArticle(place) {
  var done = function (a) { if (_ae.place === place) { place.article = a || false; _aeRenderCard(); } };
  var snippet = function (hit) {
    return _aeFetch(AE_PLACE_SNIPPET_URL + '?zim=' + encodeURIComponent(hit.zim) + '&path=' + encodeURIComponent(hit.path)).then(_aeJson).then(function (s) {
      return { zim: hit.zim, path: hit.path, title: hit.title, snippet: s.snippet || '', thumbnail: s.thumbnail || '', position: s.position || null };
    });
  };
  var found;
  if (place.qid && window.AlmanacLinks && AlmanacLinks.resolve) {
    found = AlmanacLinks.resolve([place.qid]).then(function (links) { return links[place.qid] ? snippet(links[place.qid]) : null; });
  } else {
    found = _aeFetch(AE_PLACE_SEARCH_URL + '?q=' + encodeURIComponent(place.name) + '&limit=' + AE_PLACE_CANDIDATES * 2).then(_aeJson).then(function (d) {
      var want = _aePlaceNorm(place.name);
      // Pages named for the place (the name alone, or with what tells it from others: "Paris (Texas)"), each looked into.
      var named = (d.results || []).filter(function (r) { var n = _aePlaceNorm(r.title); return n === want || n.indexOf(want + ' (') === 0 || n.indexOf(want + ',') === 0; })
        .slice(0, AE_PLACE_CANDIDATES);
      return Promise.all(named.map(function (r) { return snippet(r).catch(function () { return null; }); })).then(function (list) {
        return _aePlaceBest(place, list.filter(Boolean));
      });
    });
  }
  found.then(done).catch(function () { done(null); });
}
// Of the candidate articles, the one that stands nearest the place within AE_PLACE_ARTICLE_KM; if none says where it
// stands, the first, unless another says it is elsewhere.
function _aePlaceBest(place, list) {
  var best = null, bestKm = Infinity, unplaced = null;
  list.forEach(function (a) {
    if (!a.position) { unplaced = unplaced || a; return; }
    var km = _aePlaceKm(place, { lat: a.position.lat, lon: a.position.lng });
    if (km < AE_PLACE_ARTICLE_KM && km < bestKm) { best = a; bestKm = km; }
  });
  return best || (list.every(function (a) { return !a.position; }) ? unplaced : null);
}
function _aeRenderPlaceCard(card) {
  var p = _ae.place, a = p.article;
  // A town's label is its name and where it is: the name is the heading, where it is the line under it.
  var where = p.kind === 'landmark' ? '' : p.label.slice(p.name.length).replace(/^,\s*/, '');
  var head = '<h3>' + (a ? '<a href="#" class="ae-place-open" data-ae-place-open>' + _almEsc(p.name) + '</a>' : _almEsc(p.name)) + '</h3>' + (where ? '<p class="ae-lm-line"><span>' + _almEsc(where) + '</span></p>' : '');
  // The preview: its picture and the start of the article (its title too, when it is not the place's own name).
  var named = a && _aePlaceNorm(a.title) !== _aePlaceNorm(p.name);
  var body = a && (a.thumbnail || a.snippet) ? '<a href="#" class="ae-place-open ae-place-preview" data-ae-place-open>' + (a.thumbnail ? '<img src="' + _almEsc(a.thumbnail) + '" alt="" loading="lazy">' : '') +
    '<span>' + (named ? '<b>' + _almEsc(a.title) + '</b>' : '') + (a.snippet ? '<span class="ae-place-snip">' + _almEsc(a.snippet) + '</span>' : '') + '</span></a>' : '';
  card.innerHTML = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' + head + body;
  card.hidden = false;
  _aeById("ae-card-x").onclick = _aeCardClear;
  _aeCardMapBtn(card, p);
  Array.prototype.forEach.call(card.querySelectorAll('[data-ae-place-open]'), function (open) {
    open.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(a); };
  });
}
// THE ROW is the system as a line (the owner, 2026-11-12): the Sun first, then the body in view (larger), then its own moons in
// order of distance, smaller. A moon in view has its planet before it, so the way up is one tap. At the Sun the line is the planets.
// A thin ring marks the body in view; its name is the where line's. A disc is a hop: a tap goes there.
var AE_ROW_PLANETS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
// Where a target sits on the way out from the Sun ('sun' at the Sun): the ISS and the satellites are the Earth's.
// Whose sheet the view is on: the place arrived at, else the craft the camera is with (at the ISS the row marks the Earth, but
// the sheet is the station's), else the row's world.
// The body one stands on, when on the ground (a visit's or Stand here's): its sheet is that body's, whatever the orbit view last arrived at.
function _aeGroundBody() {
  var st = _ae && (_ae.stand || _ae.standPending), site = _ae && _ae.site;
  return (site && site.body) || (st && st.key) || null;
}
function _aeFactsKey() {
  var t = _ae && _ae.target, g = _aeGroundBody();
  if (g && _aeHasFacts(g)) return g;
  return _ae.arrived || (t && (t === 'iss' || _aeIsCraft(t)) && _aeHasFacts(t) ? t : _aeRowBody());
}
function _aeRowBody() {
  var t = _ae && _ae.target;
  if (!t || t === 'earth' || t === 'iss' || _aeIsOrbiter(t)) return 'earth';
  return t;
}
// The body a probe is near (Juno: Ganymede or Jupiter), or none: the same reach its flight frames by.
function _aeRowNear(k) {
  var pp = _aeBodyPos(k), near = null, nearD = Infinity;
  if (!pp) return null;
  AE_MARKED.forEach(function (m) {
    if (m.body === k || m.flightOnly || _aeIsProbe(m.body) || m.body === 'sun') return;
    var q = _aeBodyPos(m.body), d = q ? _aeLen(_aeSub(q, pp)) : Infinity;
    if (d < nearD) { nearD = d; near = m.body; }
  });
  return nearD < AE_PROBE_FRAME_MAX ? near : null;
}
// The row is one strip of every world in order from the Sun, the lit one scrolled into view; the four-faces opener of the grid stands at its start. Moons
// appear only for the planet in view, right after it, smaller and joined to it by a thin amber line (a probe goes after the world it is near).
function _aeRowHost(c) {
  if (_aeIsProbe(c)) { var n = _aeRowNear(c); return n ? _aeHostOf(n) : null; }
  return _aeHostOf(c);   // a moon's planet; Earth for its Moon, the station and what stands on the Moon
}
// A planet's moons in the strip, nearest the planet first (by the size of the orbit, its semi-major axis): the order of the sky, not of the table.
function _aeMoonsOf(host) {
  return AE_PLANETS.filter(function (m) { return m.parent === host; }).sort(function (a, b) { return a.orbit[0] - b.orbit[0]; });
}
function _aeRowKeys() {
  var spin = !!(_ae && _ae.spin), c = spin ? 'sun' : _aeRowBody();   // Side by side stands at the Sun
  if (_ae && !spin && c !== _ae.rowCurrent) {
    _ae.rowCurrent = c;
    if (c === 'moon' || AE_LM_LANDERS[c]) _aeLmLoad();   // the Landings table, there before the Go sheet asks for it
  }
  if (spin) return ['sun', AE_SPIN_KEY];   // its tools take the room (Side by side again goes back to the Sun)
  var host = _aeRowHost(c), keys = ['sun'];
  AE_ROW_PLANETS.forEach(function (p) {
    keys.push(p);
    if (p === host) {
      if (host === 'earth') keys.push('moon');   // the Moon is the Earth's own, outside AE_PLANETS
      _aeMoonsOf(host).forEach(function (m) { keys.push(m.key); });
      if (_aeIsProbe(c)) keys.push(c);
    }
  });
  return keys;
}
function _aeRowName(k) {
  if (k === 'sats') return _aeT('alm_earth_view_sats');
  if (k === 'sun') return _aeT('alm_sun');
  if (k === 'planets') return _aeT('alm_earth_view_planets');
  if (k === AE_SPIN_KEY) return _aeT('alm_spin_view');
  return _aeGoName(k);
}
function _aeRowHtml() {
  var keys = _aeRowKeys(), c = _ae && _ae.spin ? 'sun' : _aeRowBody();
  if (_ae) _ae.rowKeys = keys.join(',');
  return keys.map(function (k) { return _aeChipHtml(k, _aeRowName(k), !!_ae && k === _ae.preset, k === c); }).join('');
}
// The lit world fully in view, with its next neighbour, scrolling no further than that needs.
function _aeRowReveal(chips) {
  var lit = chips.querySelector ? chips.querySelector('[aria-current="true"]') : null;
  if (!lit) return;
  var col = getComputedStyle(chips).flexDirection === 'column', pad = AE_ROW_DISC_PX + 8;   // standing on its side the strip runs down the left edge
  var l = col ? lit.offsetTop : lit.offsetLeft, r = l + (col ? lit.offsetHeight : lit.offsetWidth), room = col ? chips.clientHeight : chips.clientWidth, at = col ? chips.scrollTop : chips.scrollLeft, to = at;
  if (r + pad > at + room) to = r + pad - room;
  if (l - pad < to) to = Math.max(0, l - pad);
  if (col) chips.scrollTop = to; else chips.scrollLeft = to;
}
// The name of the world the strip stands at (the world sheet's heading).
function _aeRowNameNow() { return _ae.spin ? _aeT('alm_earth_view_planets') : _aeRowName(_aeRowBody()); }
// Where I am, always in view: the world (or the site) the view is at; it is the strip's first control, with the search glass.
function _aeWhereName() {
  var st = _ae && _ae.site;
  if (st) return (st.def && st.def.name) || (st.row && st.row[0]) || _aeRowNameNow();
  if (_ae && _ae.mission && typeof _amName === 'function') return _amName();
  if (_ae && _ae.preset === 'planets' && !_ae.spin) return _aeT('alm_earth_view_planets');   // the whole solar system view
  return _ae && _ae.spin ? _aeT('alm_earth_view_planets') : _aeRowName(_aeRowBody());
}
function _aeRenderRow() {
  var chips = _aeById('ae-chips');
  if (!chips) return;
  var c = _ae.spin ? 'sun' : _aeRowBody(), keys = _aeRowKeys().join(',');
  if (_ae.rowKeys === keys) {   // the same worlds: only which one is lit and which view is on move, on the discs already there (a rebuilt disc shows unlit until repainted)
    var moved = false;
    chips.querySelectorAll('[data-ae-view]').forEach(function (b) {
      var k = b.getAttribute('data-ae-view'), now = k === c && k !== AE_SPIN_KEY, on = k === _ae.preset;
      if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', on);
      if (b.classList.contains('ae-disc-now') !== now && k !== AE_SPIN_KEY) {
        b.classList.toggle('ae-disc-now', now);
        if (now) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
        moved = true;
      }
    });
    if (moved) _aeRowReveal(chips);
    _aeChipsEdge(chips);
    return;
  }
  var wasL = chips.scrollLeft, wasT = chips.scrollTop;
  chips.innerHTML = _aeRowHtml();
  chips.scrollLeft = wasL; chips.scrollTop = wasT;
  _aeRowReveal(chips);
  _aeChipsEdge(chips);
  _aeRowLitSoon(true);   // the new discs, lit as they are now
}
// ── The row's worlds, lit as they are ──
// Each world in the row is drawn as it stands at the shown moment: lit from where the Sun really is as seen from the Earth (the Moon, Mercury and
// Venus go through their phases, Mars is a little gibbous, the outer planets nearly full), north (the ecliptic's) up, and turned to the face
// it shows then, at its own rate (IAU, as the view turns them: _aePlanetFrameEcl). The Earth's own disc is seen from the ecliptic
// AE_ROW_EARTH_PHASE_DEG east of the Sun, so it is gibbous with its evening edge dark, turned as it is. The Moon and the other moons keep the
// face toward us (no libration); Saturn's rings open as seen from here, its shadow across their far side. A canvas a disc, over the sprite
// (which shows until it is drawn), per pixel from a small map of each world (go-maps-v1.webp, scripts/build_go_discs.py), asked for once
// the view is up. A disc is drawn again only when its light or its turn moved by about a pixel at its size, and the row at most
// AE_ROW_LIT_HZ times a second however fast time runs; at the low capability level, the light alone (its own colour, no map, no turn).
var AE_ROW_MAP_URL = _almAsset('/static/earth/go-maps-v1.webp');
var AE_ROW_MAP_KEYS = ['earth', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'io', 'europa', 'ganymede', 'callisto', 'titan',
  'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'iapetus', 'triton', 'phobos'];
var AE_ROW_MAP_W = 256, AE_ROW_MAP_H = 128, AE_ROW_MAP_COLS = 4;
var AE_ROW_LIT_HZ = 4, AE_ROW_LIT_MS = 1000 / AE_ROW_LIT_HZ;
var AE_ROW_EARTH_PHASE_DEG = 50;
var AE_ROW_AMBIENT = 0.07;               // the night side, dim, so the ball still reads whole against the black
var AE_ROW_MINNAERT = { earth: 0.8, venus: 0.9, mars: 0.65, jupiter: 0.9, saturn: 0.9, uranus: 0.95, neptune: 0.95, titan: 0.95 }, AE_ROW_MINNAERT_ROCK = 0.55;
var AE_ROW_LIT_MAX = 1.2;                // airless rock's limb a touch brighter than its middle, no more
// Air seen edge-on: its colour on the lit limb and how strongly it shows (as scripts/build_go_discs.py AIR).
var AE_ROW_AIR = { earth: [0.42, 0.66, 1, 0.75], venus: [1, 0.96, 0.86, 0.55], titan: [1, 0.7, 0.35, 0.6], mars: [0.85, 0.82, 0.95, 0.22],
  jupiter: [0.95, 0.9, 0.82, 0.18], saturn: [0.95, 0.9, 0.78, 0.18], uranus: [0.75, 0.95, 1, 0.25], neptune: [0.55, 0.7, 1, 0.25] };
var AE_ROW_AIR_WIDTH = 4;
var AE_ROW_GLINT = 0.35, AE_ROW_GLINT_POW = 80;   // the Sun on the Earth's sea
// Saturn's rings in planet radii (C ring's inner edge, B's, B's outer, the Cassini division's far side, A's outer edge) and each band's opacity.
var AE_ROW_RING_R = [1.239, 1.527, 1.951, 2.027, 2.269], AE_ROW_RING_A = [0.25, 0.9, 0.08, 0.65], AE_ROW_RING_TONE = [0.86, 0.78, 0.6];
var AE_ROW_RING_UNLIT = 0.35;            // their face away from the Sun, lit only through them
var AE_ROW_RING_OPEN_MIN = 0.05;         // edge-on (as in 2025), they stay a solid line a couple of pixels thick rather than vanish into dots
var AE_ROW_NORTH = [0, 0, 1];            // the ecliptic's north, up in every disc
var _aeRowMaps = null, _aeRowMapsLoading = false, _aeRowGrids = {}, _aeRowLitT = 0, _aeRowLitAt = 0;
function _aeRowLitKey(k) { return AE_ROW_MAP_KEYS.indexOf(k) >= 0; }
function _aeRowMapsLoad() {
  if (_aeRowMaps || _aeRowMapsLoading) return;
  _aeRowMapsLoading = true;
  var img = new Image();
  img.onload = function () {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    _aeRowMaps = g.getImageData(0, 0, c.width, c.height);
    _aeRowMapsLoading = false;
    _aeRowLitSoon(true);
  };
  img.onerror = function () { _aeRowMapsLoading = false; };
  img.src = AE_ROW_MAP_URL;
}
// A disc's pixels once per size: where each stands on the ball (x right, y up, z toward the viewer, in radii) and its edge's cover.
function _aeRowGrid(n, rf) {
  var key = n + ':' + rf, g = _aeRowGrids[key];
  if (g) return g;
  var R = n / 2 * rf, px = new Float32Array(n * n), py = new Float32Array(n * n), pz = new Float32Array(n * n), cover = new Float32Array(n * n);
  for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
    var o = i * n + j, x = (j + 0.5 - n / 2) / R, y = -(i + 0.5 - n / 2) / R, d2 = x * x + y * y;
    px[o] = x; py[o] = y;
    pz[o] = d2 < 1 ? Math.sqrt(1 - d2) : -1;
    cover[o] = d2 < 1 ? _aeClamp((1 - Math.sqrt(d2)) * R, 0, 1) : 0;
  }
  return (_aeRowGrids[key] = { n: n, R: R, px: px, py: py, pz: pz, cover: cover });
}
// A world as seen now: the Sun's direction in its picture (x right, y up toward ecliptic north, z toward us), its axes there, the turn that
// decides when it is drawn again. earthH: the Earth from the Sun (AU, J2000 ecliptic).
function _aeRowGeom(k, jd, earthH, low) {
  var b = k === 'earth' ? AE_SPIN_EARTH : k === 'moon' ? null : _aePlanetBody(k), h, z, s;
  if (k === 'earth') {
    s = _aeNorm(_aeScale(earthH, -1));
    var a = _aeRad(AE_ROW_EARTH_PHASE_DEG), c = Math.cos(a), sn = Math.sin(a);
    z = [s[0] * c - s[1] * sn, s[0] * sn + s[1] * c, s[2]];   // the Sun's direction turned east about the ecliptic pole
  } else {
    h = k === 'moon' ? _ephBodyJ2000('Moon', jd) : b && b.parent ? _ephBodyJ2000(_aePlanetBody(b.parent).eph, jd) : b && !b.track ? _ephBodyJ2000(b.eph, jd) : null;
    if (!h) return null;
    z = _aeNorm(_aeSub(earthH, h));
    s = _aeNorm(_aeScale(h, -1));
  }
  var up = _aeNorm(_aeSub(AE_ROW_NORTH, _aeScale(z, _aeDot(AE_ROW_NORTH, z)))), x = _aeCross(up, z);
  var img = function (v) { return [_aeDot(v, x), _aeDot(v, up), _aeDot(v, z)]; };
  var spins = !low && b && !b.parent && b.pole, f;
  if (spins) f = _aePlanetFrameEcl(b, jd);
  else {   // the face toward us held still: a moon's near side, or a world at the low level
    var fx = _aeNorm(_aeSub(z, _aeScale(AE_ROW_NORTH, _aeDot(z, AE_ROW_NORTH))));
    f = { x: fx, y: _aeCross(AE_ROW_NORTH, fx), z: AE_ROW_NORTH };
  }
  var M = [img(f.x), img(f.y), img(f.z)];
  return { L: img(s), M: M, lon0: Math.atan2(M[1][2], M[0][2]), ring: k === 'saturn' ? img(f.z) : null };
}
// What a disc was drawn for, to a pixel at its radius: the Sun's direction and the face turned toward us.
function _aeRowLitState(g, R) {
  var q = function (v) { return Math.round(v * R); };
  return [q(g.L[0]), q(g.L[1]), q(g.L[2]), q(g.lon0), g.ring ? q(g.ring[0] * 4) + ',' + q(g.ring[1] * 4) + ',' + q(g.ring[2] * 4) : ''].join(',');
}
function _aeRowLitDraw(cv, k, g, low) {
  var n = cv.width, ring = g.ring, rf = ring ? 1 / (AE_ROW_RING_R[4] + 0.04) : 1, G = _aeRowGrid(n, rf), ctx = cv.getContext('2d');
  var out = ctx.createImageData(n, n), d = out.data, L = g.L, M = g.M, kk = AE_ROW_MINNAERT[k] || AE_ROW_MINNAERT_ROCK, air = AE_ROW_AIR[k];
  var maps = !low && _aeRowMaps, mi = AE_ROW_MAP_KEYS.indexOf(k), mx0 = (mi % AE_ROW_MAP_COLS) * AE_ROW_MAP_W, my0 = Math.floor(mi / AE_ROW_MAP_COLS) * AE_ROW_MAP_H;
  var md = maps ? maps.data : null, mw = maps ? maps.width : 0, base = _aeRowFlat(k);
  var hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.sqrt(hx * hx + hy * hy + hz * hz); hx /= hl; hy /= hl; hz /= hl;
  var TWO_PI = 2 * Math.PI, rp = ring ? [ring[0], ring[1], Math.abs(ring[2]) < AE_ROW_RING_OPEN_MIN ? (ring[2] < 0 ? -1 : 1) * AE_ROW_RING_OPEN_MIN : ring[2]] : null;
  var ringLit = ring ? ((L[0] * ring[0] + L[1] * ring[1] + L[2] * ring[2]) * ring[2] > 0 ? 1 : AE_ROW_RING_UNLIT) : 0;
  for (var o = 0, N = n * n; o < N; o++) {
    var x = G.px[o], y = G.py[o], z = G.pz[o], r = 0, gg = 0, bb = 0, a = 0;
    if (z >= 0) {
      var tr = base[0], tg = base[1], tb = base[2];
      if (md) {
        var lat = Math.asin(_aeClamp(M[2][0] * x + M[2][1] * y + M[2][2] * z, -1, 1)), lon = Math.atan2(M[1][0] * x + M[1][1] * y + M[1][2] * z, M[0][0] * x + M[0][1] * y + M[0][2] * z);
        var u = ((lon / TWO_PI + 0.5) % 1 + 1) % 1, v = 0.5 - lat / Math.PI;
        var ti = ((my0 + _aeClamp(Math.floor(v * AE_ROW_MAP_H), 1, AE_ROW_MAP_H - 2)) * mw + mx0 + _aeClamp(Math.floor(u * AE_ROW_MAP_W), 1, AE_ROW_MAP_W - 2)) * 4;   // (a cell's outer texels carry its neighbour's colour through the encoder)
        tr = md[ti] / 255; tg = md[ti + 1] / 255; tb = md[ti + 2] / 255;
      }
      var mu0 = x * L[0] + y * L[1] + z * L[2], lit = mu0 > 0 ? Math.min(AE_ROW_LIT_MAX, Math.pow(mu0, kk) * Math.pow(Math.max(z, 1e-4), kk - 1)) : 0;
      var e = AE_ROW_AMBIENT + (1 - AE_ROW_AMBIENT) * lit;
      r = tr * e; gg = tg * e; bb = tb * e;
      if (k === 'earth' && md && mu0 > 0) {
        var sea = _aeClamp((tb - Math.max(tr, tg)) * 4, 0, 1), sp = AE_ROW_GLINT * sea * Math.pow(Math.max(0, x * hx + y * hy + z * hz), AE_ROW_GLINT_POW);
        r += sp; gg += sp; bb += sp;
      }
      if (air) {
        var w = air[3] * Math.exp(-AE_ROW_AIR_WIDTH * z) * Math.pow(_aeClamp(mu0 * 2.5 + 0.15, 0, 1), 0.8);
        r = r * (1 - w) + air[0] * w; gg = gg * (1 - w) + air[1] * w; bb = bb * (1 - w) + air[2] * w;
      }
      a = G.cover[o];
    }
    if (rp) {   // the ring plane under this pixel: in front of the ball (t > 0) or behind it
      var t = -(x * rp[0] + y * rp[1]) / rp[2], rr = Math.sqrt(x * x + y * y + t * t), band = -1;
      for (var bi = 0; bi < 4; bi++) if (rr >= AE_ROW_RING_R[bi] && rr < AE_ROW_RING_R[bi + 1]) band = bi;
      if (band >= 0 && (z < 0 || t > 0)) {
        var pl = x * L[0] + y * L[1] + t * L[2], qx = x - pl * L[0], qy = y - pl * L[1], qz = t - pl * L[2];
        var shade = ringLit * (pl < 0 && qx * qx + qy * qy + qz * qz < 1 ? AE_ROW_AMBIENT : 1), ra = AE_ROW_RING_A[band];
        r = r * (1 - ra) + AE_ROW_RING_TONE[0] * shade * ra; gg = gg * (1 - ra) + AE_ROW_RING_TONE[1] * shade * ra; bb = bb * (1 - ra) + AE_ROW_RING_TONE[2] * shade * ra;
        if (z < 0) { r = AE_ROW_RING_TONE[0] * shade; gg = AE_ROW_RING_TONE[1] * shade; bb = AE_ROW_RING_TONE[2] * shade; }
        a = Math.max(a, ra);
      }
    }
    var p = o * 4;
    d[p] = r * 255; d[p + 1] = gg * 255; d[p + 2] = bb * 255; d[p + 3] = a * 255;
  }
  ctx.putImageData(out, 0, 0);
}
// A world's own colour at the low level, as the sheet's flat balls have it.
function _aeRowFlat(k) {
  var b = k === 'earth' ? AE_SPIN_EARTH : _aePlanetBody(k);
  return b ? b.color : [0.78, 0.78, 0.78];
}
// Ask for the row to be lit again, no sooner than AE_ROW_LIT_MS after it last was (each frame may ask; one timer stands).
function _aeRowLitSoon(now) {
  if (_aeRowLitT) return;
  var wait = now ? 0 : Math.max(0, _aeRowLitAt + AE_ROW_LIT_MS - performance.now());
  _aeRowLitT = setTimeout(function () { _aeRowLitT = 0; _aeRowLitAt = performance.now(); _aeRowLitPaint(); }, wait);
}
function _aeRowLitPaint() {
  var chips = _aeIsOpen && _aeById('ae-chips'), sc = _ae && _ae.scene;
  if (!chips || !sc || typeof _ephBodyJ2000 !== 'function') return;
  var t0 = performance.now(), low = _aeGoLow();
  if (!low) _aeRowMapsLoad();
  var jd = sc.ms / MS_PER_DAY + JD_UNIX_EPOCH, earthH = _ephBodyJ2000('Earth', jd), dpr = window.devicePixelRatio || 1;
  var cvs = chips.querySelectorAll('canvas[data-lit]');
  for (var i = 0; i < cvs.length; i++) {
    var cv = cvs[i], k = cv.getAttribute('data-lit'), css = cv.parentNode.clientWidth, n = Math.round(css * dpr);
    if (!n) continue;
    var g = _aeRowGeom(k, jd, earthH, low);
    if (!g) continue;
    var mode = (low ? 'l' : _aeRowMaps ? 'm' : 'f') + n, st = mode + '|' + _aeRowLitState(g, n / 2);
    if (cv._lit === st) continue;
    if (!low && !_aeRowMaps) continue;   // the sprite stands until the maps have come
    if (cv.width !== n) { cv.width = n; cv.height = n; }
    _aeRowLitDraw(cv, k, g, low);
    cv._lit = st;
    cv.classList.add('ae-lit-on');
  }
  _ae.rowLitMs = (_ae.rowLitMs || 0) + performance.now() - t0;   // the row's own cost and how often it was looked at, kept for the tests
  _ae.rowLitN = (_ae.rowLitN || 0) + 1;
}
// Side by side is a grid of dots, round like the other tools (Eric 2026-11-08); its name is its label.
// Eight dots in two rows of four: the eight planets.
// Side by side as a corner glyph: six dots, three across and two down.
var AE_SBS_SVG = '<svg class="ah-solid" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' +
  [8.5, 15.5].map(function (y) { return [5, 12, 19].map(function (x) { return '<circle cx="' + x + '" cy="' + y + '" r="2"/>'; }).join(''); }).join('') + '</svg>';
var AE_SPIN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
  [9, 15].map(function (y) { return [4.5, 9.5, 14.5, 19.5].map(function (x) { return '<circle cx="' + x + '" cy="' + y + '" r="1.9"/>'; }).join(''); }).join('') + '</svg>';
function _aeChipHtml(key, name, on, now) {
  if (key === AE_SPIN_KEY) {
    return '<button type="button" class="ae-btn ae-round" data-ae-view="' + key + '" aria-pressed="' + !!on + '" aria-label="' + _almEsc(name) +
      '" title="' + _almEsc(name) + '">' + AE_SPIN_SVG + '</button>';
  }
  var moon = key === 'moon' || (_aePlanetBody(key) || {}).parent ? ' ae-disc-moon' : '';
  return '<button type="button" class="ae-disc' + moon + (now ? ' ae-disc-now' : '') + '" data-ae-view="' + key + '" aria-pressed="' + !!on + '"' + (now ? ' aria-current="true"' : '') +
    ' aria-label="' + _almEsc(name) + '" title="' + _almEsc(name) + '">' + _aeGoThumb(key).replace(/<\/span>$/, _aeRowLitKey(key) ? '<canvas class="ae-disc-lit" data-lit="' + key + '" aria-hidden="true"></canvas></span>' : '</span>') + '</button>';
}
function _aeBodyName(b) { return b.parent ? b.key.charAt(0).toUpperCase() + b.key.slice(1) : _tp(b.eph); }
function _aeMarkHtml(m) {
  return '<span class="ae-bm" id="ae-bm-' + m.body + '" hidden><i class="ae-ring" aria-hidden="true"></i><b>' + _almEsc(m.name()) + '</b></span>';
}
// A mark for a body known after the view was built (a probe, once its table has come).
function _aeAddMark(m) {
  var host = _aeById('ae-labels');
  if (host && !_aeById('ae-bm-' + m.body)) host.insertAdjacentHTML('beforeend', _aeMarkHtml(m));
}
function _aeBuildDom() {
  _aeKnowPlanets();
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
  el.innerHTML =
    '<canvas class="ae-canvas" id="ae-canvas" tabindex="0" role="img"></canvas>' +
    '<div class="ae-labels" id="ae-labels">' +
      '<canvas class="ae-marks-c" id="ae-marks-c"></canvas>' +
      AE_MARKED.map(_aeMarkHtml).join('') +
      '<span class="ae-label" id="ae-lbl-iss" hidden></span>' +
      '<span class="ae-label ae-label-you" id="ae-lbl-you" hidden><i class="ae-mark" aria-hidden="true"></i>' + _almEsc(_aeT('alm_earth_you')) + '</span>' +
      '<span class="ae-label ae-label-you ae-label-place" id="ae-lbl-place" hidden><i class="ae-mark" aria-hidden="true"></i><span id="ae-lbl-place-text"></span></span>' +
      '<span class="ae-label ae-label-shadow" id="ae-lbl-shadow" hidden><i class="ae-mark" aria-hidden="true"></i>' + _almEsc(_aeT('alm_earth_shadow')) + '</span>' +
    '</div>' +
    '<div class="ae-lms" id="ae-lms"></div>' +
    '<div class="ae-spin" id="ae-spin" role="group" aria-label="' + _almEsc(_aeT('alm_spin_title')) + '"></div>' +
    '<div class="ae-fullbar" id="ae-fullbar">' + _aeSpinToolsHtml(false) + '</div><div class="ae-safe" id="ae-safe"></div>' +
    '<div class="ae-msg" id="ae-msg"></div>' +
    '<button type="button" class="ae-btn ae-round ae-cam" id="ae-cam" hidden></button>' +
        '<button type="button" class="ae-btn ae-round ah-hero ah-tr ae-ufo" id="ae-fly-btn" aria-pressed="false" aria-label="' + _almEsc(_aeT('alm_fly')) + '" title="' + _almEsc(_aeT('alm_fly')) + '">' + AE_FLY_SVG + '</button>' +
    '<button type="button" class="ae-btn ae-round ae-youbtn" id="ae-locate" hidden aria-pressed="false"' +
      ' aria-label="' + _almEsc(locateLabel) + '" title="' + _almEsc(locateLabel) + '">' + AE_LOCATE_SVG + '</button>' +
    _almPinHtml(' ae-pin', ' id="ae-pin"', ' id="ae-clock"', '') +
      '<button type="button" class="ae-btn ae-round ae-north" id="ae-north" hidden aria-label="' + _almEsc(_aeT('alm_north_up')) + '" title="' + _almEsc(_aeT('alm_north_up')) + '">' + AE_NORTH_SVG + '</button>' +
      '<button type="button" class="ae-mini" id="ae-mini" hidden aria-label="' + _almEsc(_aeT('alm_earth_view_planets')) + '"><canvas id="ae-mini-c"></canvas></button>' +
      '<button type="button" class="ae-btn ae-round ae-sbs" id="ae-sbs" data-ae-sbs hidden aria-label="' + _almEsc(_aeT('alm_spin_view')) + '" title="' + _almEsc(_aeT('alm_spin_view')) + '">' + AE_SBS_SVG + '</button>' +
    // The page's own bar is not drawn in here: the way out and the search are two 44 px circles at the ends of the time row.
    '<button type="button" class="ae-btn ae-round ah-hero ah-tl ae-back" id="ae-back" aria-label="' + _almEsc(_aeT('go_back')) + '">' + AE_BACK_SVG + '</button>' +
    '<button type="button" class="ae-btn ae-round ah-hero ae-find" id="ae-find" data-ae-find aria-haspopup="dialog" aria-label="' + _almEsc(_aeT('search')) + '" title="' + _almEsc(_aeT('search')) + '">' + AE_FIND_SVG.replace('<svg ', '<svg class="ae-find-mag" ') + AE_FIND_X_SVG + '</button>' +
    '<button type="button" class="ae-btn ae-round ae-rim" id="ae-rim" hidden>' + (typeof _almRimSvg === 'function' ? _almRimSvg(false) : '') + '</button>' +
    '<div class="ae-top">' +
      '<div class="ae-top-end">' +
        // The round tools stand in a column, so the date keeps its one line.
        '<div class="ae-tools">' +
          '<button type="button" class="ae-btn ae-round ae-gear" id="ae-gear" aria-expanded="false" aria-controls="ae-set"' +
            (_aeFromZim() ? ' hidden' : '') + ' aria-label="' + _almEsc(gearLabel) + '" title="' + _almEsc(gearLabel) + '">' +
            (typeof _gearSvg === 'string' ? _gearSvg : '⚙') + '</button>' +
          AE_LAYERS.map(_aeToggleHtml).join('') +
          // Where the view has flown to, everything about it waits behind this: the picture stays clear.
          '<button type="button" class="ae-btn ae-round" id="ae-info-btn" hidden aria-haspopup="dialog" aria-expanded="false"' +
            ' aria-label="' + _almEsc(_aeT('alm_bi_more')) + '" title="' + _almEsc(_aeT('alm_bi_more')) + '">' + AE_INFO_SVG + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    // The gear's sheet: the view's own switches and the satellite setting (drawn afresh), then the data's date and,
    // for an admin under Ask first with stale data, Get fresh data.
    '<div class="ae-drawer" id="ae-drawer" hidden><div class="ae-set" id="ae-set" role="group" aria-labelledby="ae-set-title" hidden><div id="ae-set-body"></div>' +
      '<p class="ae-set-data" id="ae-ask" hidden><span id="ae-ask-text"></span><span id="ae-fresh-sep" aria-hidden="true"> · </span>' +
      '<button type="button" class="ae-fresh" id="ae-fresh"></button></p></div></div>' +
    '<div class="ae-info" id="ae-info" role="dialog" aria-labelledby="ae-info-title"></div>' +
    '<div class="ae-status" id="ae-status" aria-live="polite"></div>' +
    '<div class="ae-bottom">' +
      '<div class="ae-hint" id="ae-hint"></div>' +
      '<div class="ae-card" id="ae-card" hidden></div>' +
      // Outward from home: the Earth, its satellites, the Moon, the Sun, the whole system; everywhere else is Go to.
      '<div class="ae-go" id="ae-go" role="dialog" aria-label="' + _almEsc(_aeT('alm_go_to')) + '" hidden></div>' +
      '<div class="ae-row" role="group" id="ae-views">' +
        '<div class="ae-chips" id="ae-chips">' + _aeRowHtml() + '</div>' +
        // Side by side's own tools stand in the row, where Earth and Planets were.
        '<span class="ae-spintools" id="ae-spinrow" hidden><button type="button" class="ae-btn ae-round ae-same" id="ae-spin-same" aria-pressed="false" aria-label="' + _almEsc(_aeT('alm_spin_same')) + '" title="' + _almEsc(_aeT('alm_spin_same')) + '"><span class="ae-chip-g">=</span><span class="ae-chip-l">' + _almEsc(_aeT('alm_spin_same')) + '</span></button>' + _aeSpinToolsHtml(true) + '</span>' +
      '</div>' +
      '<div class="ae-note">' +
        '<span id="ae-hd" hidden><span class="ae-ask-text" id="ae-hd-text"></span> <span id="ae-hd-act">' +
          '<button type="button" class="ae-fresh" id="ae-hd-get">' + _almEsc(_aeT('alm_hd_get')) + '</button><span aria-hidden="true"> · </span>' +
          '<button type="button" class="ae-fresh" id="ae-hd-later">' + _almEsc(_aeT('alm_hd_later')) + '</button></span><br></span>' +
        '<span id="ae-note"></span><button type="button" class="ae-fresh" id="ae-note-fresh" hidden></button>' +
      '</div>' +
    '</div>';
  host.appendChild(el);
  return el;
}

// ── Loading: three.js as a module, the propagator as a classic script ──
var _aeThreePromise = null;
function _aeLoadThree() {
  if (!_aeThreePromise) {
    // import() takes a URL, not a path: against the page, so it is the same file under Zimi ("/static/...") and in the
    // Almanac's ZIM, where the stage made the path relative ("earth/..." would be read as a module name and refused).
    _aeThreePromise = import(new URL(AE_THREE_URL, document.baseURI).href);
    _aeThreePromise.catch(function () { _aeThreePromise = null; });
  }
  return _aeThreePromise;
}
function _aeLoadSgp4() {
  if (window.SatelliteJS) return Promise.resolve(window.SatelliteJS);
  return _aeLoadJs(AE_SGP4_URL).then(function (ok) { if (ok && window.SatelliteJS) return window.SatelliteJS; throw new Error('sgp4'); });
}
// A map is fetched and decoded off the main thread (createImageBitmap) and handed to three as a texture of its own
// kind (the build exports no Texture: its class is the one a TextureLoader hands back). Without createImageBitmap, or
// where it fails, three's own loader decodes it where it is first used.
var AE_BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
function _aeTextureClass(THREE) {
  var probe = new THREE.TextureLoader().load(AE_BLANK_GIF);
  probe.dispose();
  return probe.constructor;
}
function _aeLoadTexture(THREE, url) {
  var viaLoader = function () {
    return new Promise(function (resolve, reject) {
      new THREE.TextureLoader().load(url, resolve, undefined, reject);
    });
  };
  if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function') return viaLoader();
  return fetch(url).then(function (r) { if (!r.ok) { var e = new Error(url); e.status = r.status; throw e; } return r.blob(); }).then(function (blob) {
    // Flipped as it is decoded: WebGL's flipY does not apply to an ImageBitmap.
    return createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }).then(function (bmp) {
    var Tex = _aeTextureClass(THREE), tx = new Tex(bmp);
    tx.flipY = false;
    tx.needsUpdate = true;
    return tx;
  }).catch(function (e) { if (e && e.status) throw e; return viaLoader(); });   // the server's answer stands; anything else, the loader tries
}

// A canvas as a texture, as _aeLoadTexture would give its picture: without writing it out as a PNG and reading it back (40 ms for the rings' strip).
function _aeCanvasTexture(THREE, canvas) {
  if (typeof createImageBitmap !== 'function') return _aeLoadTexture(THREE, canvas.toDataURL());
  return createImageBitmap(canvas, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(function (bmp) {
    var Tex = _aeTextureClass(THREE), tx = new Tex(bmp);
    tx.flipY = false;
    tx.needsUpdate = true;
    return tx;
  }).catch(function () { return _aeLoadTexture(THREE, canvas.toDataURL()); });
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
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView; varying vec3 vRel;',
  'void main() {',
  '  vUv = uv;',
  '  vec4 w = modelMatrix * vec4(position, 1.0);',
  '  vWorld = w.xyz;',
  // The two vectors a far body's shading needs, made without the big numbers: from the surface point to the eye (the camera-relative matrix is
  // made in double precision on the CPU) and from the body's centre to the point (the matrix's rotation alone). A world position thousands of
  // Earth radii out carries float32 steps of a few kilometres, which showed as a surface shimmering as the date ran.
  // (In the world's axes, as the Sun's direction and a ring's normal are: the eye vector in the camera's own axes lit a ring as if seen from the wrong side, and dimmed it.)
  '  vec3 eye = -(modelViewMatrix * vec4(position, 1.0)).xyz; mat3 R = mat3(viewMatrix);',
  '  vView = vec3(dot(R[0], eye), dot(R[1], eye), dot(R[2], eye));',
  '  vRel = mat3(modelMatrix) * position;',
  '  vNormal = normalize(mat3(modelMatrix) * normal);',
  // Placed by the camera-relative matrix (the CPU makes it in double precision): through the world position a body
  // thousands of Earth radii out and a few thousandths of one across (Phobos) lost its shape to float32.
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

// The Earth: the day map where the Sun is up, city lights where it is down,
// a soft twilight band between, sun glint on the oceans, and the Moon's
// shadow wherever the Moon covers some of the Sun.
var AE_ECL_LINES = 4;        // lines at every quarter of the Sun covered
var AE_ECL_EDGE = 0.004;     // covered share from which the shadow's edge is drawn
var AE_ECL_LINE_W = 0.08;    // a line's half-width, in quarters
// The Earth's mesh is the flattened sphere; its picture's rows are geodetic latitude, so each vertex looks the row up by
// the geodetic latitude of its point (atan2 of the pole's height over the flattened ring, no pole singularity).
var AE_EARTH_VERT = [
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  'void main() {',
  '  float lat = atan(position.z, ' + _aeGlslNum(1 - AE_EARTH_FLATTENING) + ' * length(position.xy));',
  '  vUv = vec2(uv.x, 0.5 + lat / 3.14159265);',
  '  vec4 w = modelMatrix * vec4(position, 1.0);',
  '  vWorld = w.xyz;',
  '  vNormal = normalize(mat3(modelMatrix) * normal);',
  '  gl_Position = projectionMatrix * viewMatrix * w;',
  '}'
].join('\n');

// The shore: the sea within reach of land is lit like shallow water, a pale turquoise that fades out to the open sea's navy over
// a few hundred km, read from a small map of how much land lies near (_aeEarthCoast, built once from the day map). It reads at
// any scale and smooths the coast where a close map's own pixels or its water mask show as steps.
var AE_COAST_SHALLOW = [0.11, 0.46, 0.51];   // the shallows' colour, in the day map's own units
var AE_COAST_STRENGTH = 0.7;                 // the most of it, at the shore
var AE_COAST_NEAR = 0.04, AE_COAST_AT_SHORE = 0.5;   // land share round a point (blurred) at which the tint starts, and is whole
var AE_SEA_DARK_FROM = 0.03, AE_SEA_DARK_TO = 0.07;   // the day map paints the sea near a coast black: a pixel this dark is sea, whatever its hue
var AE_COAST_SEA_MAX_BLUE = 0.3;                     // bluer than this is no sea (ice, cloud)
var AE_COAST_W = 512, AE_COAST_H = 256, AE_COAST_BLUR = 2, AE_COAST_PASSES = 2;   // the near-land map: cells (a cell is 4 day-map pixels, ~80 km), the box blur's radius in cells and passes
var AE_EARTH_FRAG = [
  'precision highp float;',
  'uniform sampler2D dayMap; uniform sampler2D nightMap; uniform sampler2D coastMap;',
  'uniform vec3 sunPos; uniform float sunR; uniform vec3 moonPos; uniform float moonR; uniform float dim;',
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
  // The sea is where the map is blue (an edge a few percent wide, so a coarse map's pixels do not show as steps); the sea near
  // land is shallow: lighter and greener toward the shore.
  '  float ocean = smoothstep(-0.02, 0.02, day.b - (day.r * 1.25 + 0.02)) * smoothstep(-0.02, 0.02, day.b - day.g) * (1.0 - smoothstep(0.12, 0.3, day.b));',
  '  ocean = max(ocean, 1.0 - smoothstep(' + AE_SEA_DARK_FROM.toFixed(2) + ', ' + AE_SEA_DARK_TO.toFixed(2) + ', max(day.r, max(day.g, day.b))));',
  '  float shore = smoothstep(' + AE_COAST_NEAR.toFixed(2) + ', ' + AE_COAST_AT_SHORE.toFixed(2) + ', texture2D(coastMap, vUv).r) * ocean;',
  '  day = mix(day, ' + _aeGlslVec3(AE_COAST_SHALLOW) + ', shore * ' + AE_COAST_STRENGTH.toFixed(2) + ');',
  // Lambert shading, softened (the air scatters light round the limb), over
  // a twilight band ~7 degrees wide, times what the Moon leaves of the Sun.
  '  float sun = smoothstep(-0.05, 0.12, mu) * (0.4 + 0.6 * max(mu, 0.0)) * light;',
  '  float night = 1.0 - smoothstep(-0.18, 0.02, mu);',
  '  vec3 H = normalize(L + V);',
  '  float glint = pow(max(dot(N, H), 0.0), 80.0) * 0.35 * ocean;',
  // The air's own blue glow (sunlight scattered toward us) lies over the
  // day side; it is what makes the Moon's shadow show over dark ocean too.
  // One strength everywhere, as 1.15.4 drew it: thickening it toward the limb (up to four air masses) put a
  // glow twice as bright round the whole globe, and the rim shell already gives the limb its edge.
  '  vec3 haze = vec3(0.05, 0.09, 0.16);',
  '  vec3 col = day * (0.035 + 1.05 * sun) + haze * sun + vec3(1.0, 0.92, 0.8) * glint * sun;',
  '  col += vec3(1.0, 0.78, 0.45) * pow(lights, 1.6) * 1.25 * night;',
  // Dimmed in Red (AE_RED_EARTH_LIGHT): the ground, not the air's glow at the limb, which keeps its edge.
  '  col *= dim;',
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

// In Red the Earth's ground is drawn at this share of its light: a night light's red is kept for what is read, and a
// sunlit Earth filling half the screen would be the brightest thing on it. Its limb and the air's glow stay as they are.
var AE_RED_EARTH_LIGHT = 0.1;
// Red is on: the page's class, which is what the CSS reads too (a page without a root, as in the tests, is not Red).
function _aeRedOn() { var r = document.documentElement; return !!r && r.classList.contains('night-red'); }

var AE_GLSL_LIGHT_OUT ='  gl_FragColor = vec4(light, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));';   // added light: its brightest channel is its alpha
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
  '  vec3 light = vec3(0.32, 0.58, 1.0) * edge * lit * 0.8;',
  AE_GLSL_LIGHT_OUT,
  '}'
].join('\n');

// The Moon's light: app.js _moonLunarL, _moonLunarLambert and _moonDisplay,
// the model every 2D Moon is drawn with, in GLSL from the same constants.
function _aeGlslNum(x) { return x.toExponential(6); }
function _aeGlslVec3(v) { return 'vec3(' + v.map(_aeGlslNum).join(', ') + ')'; }
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
// The close-up Sun's made-up features (almanac-sun.js), here so the reference (almanac-tables.js) can show them too.
var AE_PROM_HEIGHT = [0.05, 0.2];              // solar radii off the limb (real prominences reach about 0.15)
var AE_FLARE_RISE_MIN = 6, AE_FLARE_DECAY_MIN = 40;

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
  var tail = _aeClamp((x - AE_CYCLE_TAIL_YEARS[0]) / (AE_CYCLE_TAIL_YEARS[1] - AE_CYCLE_TAIL_YEARS[0]), 0, 1);
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
      lat = _aeClamp(Math.abs(lat), AE_SPOT_LAT_RANGE_DEG[0], AE_SPOT_LAT_RANGE_DEG[1]) * (rnd() < 0.5 ? -1 : 1);
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
// The solar frame in the scene's equatorial coordinates: the pole, the equator's ascending node, and the third axis.
function _aeSolarFrame() {
  if (!_aeSpotPole) {
    var ra = AE_SUN_POLE_RA_DEG * DEG_TO_RAD, dec = AE_SUN_POLE_DEC_DEG * DEG_TO_RAD;
    var P = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    var Q = _aeNorm(_aeCross([0, 0, 1], P));                 // the solar equator's ascending node
    _aeSpotPole = { P: P, Q: Q, R: _aeCross(P, Q) };
  }
  return _aeSpotPole;
}
// A heliographic place (latitude, longitude from the node, degrees) as a unit vector in that frame, with a radius
// (degrees) turned to radians as the fourth number.
function _aeSolarVec(latDeg, lonDeg, rDeg) {
  var F = _aeSolarFrame(), la = latDeg * DEG_TO_RAD, lo = lonDeg * DEG_TO_RAD, cl = Math.cos(la);
  return [cl * Math.cos(lo) * F.Q[0] + cl * Math.sin(lo) * F.R[0] + Math.sin(la) * F.P[0],
    cl * Math.cos(lo) * F.Q[1] + cl * Math.sin(lo) * F.R[1] + Math.sin(la) * F.P[1],
    cl * Math.cos(lo) * F.Q[2] + cl * Math.sin(lo) * F.R[2] + Math.sin(la) * F.P[2], rDeg * DEG_TO_RAD];
}
function _aeSpotVectors(ms) {
  var groups = _aeSunSpots(ms), spots = [], vec = _aeSolarVec;
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

// ── The Sun close up: prominences, flares and a finer surface (almanac-sun.js) ──
// Loaded the first time the Sun is wide on screen (never with the view's first frame: from the Earth it is a small
// disc the plain shaders draw); it swaps the Sun's two shaders for fuller ones and feeds them each frame.
var AE_SUNFX_JS = _almAsset('/static/almanac-sun.js');
var AE_SUNFX_MIN_PX = 28;            // the Sun's disc, radius in CSS px, past which its close-up is asked for
function _aeSunFxWanted(S, ms) {
  if (typeof _aeSunFxTick === 'function') { _aeSunFxTick(S, ms); return; }
  if (S.sunFxAsked || typeof document === 'undefined' || !_ae.ready || !_aeIsOpen) return;   // nor while the scene is being built (the default camera has the Sun in frame)
  var to = _aeSub(_aeXyz(S.sun.position), _aeXyz(S.camera.position)), d = _aeLen(to);
  if (AE_SUN_SHOW_R / Math.max(1e-9, d) * _aePxPerRad(S.camera) < AE_SUNFX_MIN_PX) return;
  // Wide on screen is not enough: on a phone the Sun is "wide" from the first frame, looking the other way. It is asked for when
  // the view is on the Sun, or the Sun is within the picture (the angle to it inside the corner of the frame).
  if (_ae.target !== 'sun') {
    var f = S.camera.getWorldDirection(S.sunFxDir || (S.sunFxDir = new S.THREE.Vector3())), cosA = (to[0] * f.x + to[1] * f.y + to[2] * f.z) / Math.max(1e-9, d);
    var tanV = _aeTanHalf(S.camera.fov), corner = Math.atan(tanV * Math.hypot(1, _ae.w / Math.max(1, _ae.h)));
    if (Math.acos(_aeClamp(cosA, -1, 1)) > corner + AE_SUN_SHOW_R / Math.max(1e-9, d)) return;
  }
  S.sunFxAsked = true;
  _aeLoadJs(AE_SUNFX_JS).then(function (ok) { if (ok && _ae.gl === S) _aeRedraw(); });
}

// A Sun that fills the picture is paid for in every pixel (the surface's two octaves of cells, the spots and flares), at a phone's 3x
// ratio more than 3 million of them: it was enough to slow an iPhone's frames until the governor stepped its level down. Its
// granulation is smooth and glowing, so that view draws at most at AE_SUN_DPR_MAX (and back to the level's ratio when the Sun is small).
var AE_SUN_DPR_MAX = 2, AE_SUN_FILL_PX = 110, AE_SUN_FILL_LEAVE_PX = 80;   // the Sun's disc radius in CSS px: big from here, ordinary again under there
function _aeSunRatio(S) {
  if (typeof ZimiCap === 'undefined') return;
  var to = _aeSub(_aeXyz(S.sun.position), _aeXyz(S.camera.position));
  var px = AE_SUN_SHOW_R / Math.max(1e-9, _aeLen(to)) * _aePxPerRad(S.camera);
  var big = px > (_ae.sunBig ? AE_SUN_FILL_LEAVE_PX : AE_SUN_FILL_PX);
  var cap = Math.min(S.dpr, ZimiCap.dprCap(_ae.stand ? 'stand' : 'earth')), want = big ? Math.min(cap, AE_SUN_DPR_MAX) : cap;
  _ae.sunBig = big;
  if (Math.abs(S.renderer.getPixelRatio() - want) > 1e-3 && !_ae.stand) { S.renderer.setPixelRatio(want); _aeResize(); }
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
  '// @sunfx-uniforms',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  AE_GLSL_NOISE,
  '// @sunfx-functions',
  _aeLimbGlsl(),
  'void main() {',
  '  vec3 n = normalize(vNormal);',
  '  float mu = max(dot(n, normalize(cameraPosition - vWorld)), 0.0);',
  '  vec3 q = n * ' + AE_GRANULES_PER_RADIUS.toFixed(1) + ' + vec3(0.0, 0.0, uT * 0.37);',
  '  vec3 c = aeCells(q);',
  '  float lane = smoothstep(0.0, 0.32, c.y - c.x);',
  '  float cell = lane * (1.2 - 0.9 * c.x) * (0.8 + 0.4 * c.z) - 0.6;',
  '  float fine = clamp(1.6 - 0.9 * length(fwidth(q)), 0.0, 1.0);',
  '  // @sunfx-cells',
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
  '  // @sunfx-surface',
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
  '// @sunfx-uniforms',
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
  '  float prom = smoothstep(0.78, 0.92, h) * (1.0 - smoothstep(1.0, 1.0 + 0.05 * h + 1e-4, r)) * smoothstep(1.0, 1.006, r);',
  '  vec3 col = vec3(1.0, 0.72, 0.42) * bloom + vec3(1.0, 0.95, 0.9) * corona + vec3(1.0, 0.38, 0.45) * prom * 0.6;',
  '  // @sunfx-prominences',
  '  vec3 light = col * fall * fade;',
  AE_GLSL_LIGHT_OUT,
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
    out.ci = s.length > 3 ? s[3] : SG_STAR_BV_DEFAULT;
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
  _sgRetryLoads();   // an open asks again for what failed before
  // The catalogue's one decoder and one request are the sky's (almanac-skygl.js _sgLoadStars).
  _sgLoadStars().then(function (stars) {
    if (_ae.gl !== S) throw new Error('stars');
    var old = S.starCloud;
    S.starCloud = _aeStarField(S.THREE, S.dpr, _sgStarList(stars));
    S.sky.add(S.starCloud);
    S.sky.remove(old);
    old.geometry.dispose(); old.material.dispose();
    S.starsLoaded = true;
    _aeRedraw();
  }).catch(function () {}).then(function () { S.starsLoading = false; });
}

// Light added over what is behind it, as a glow is, leaving the canvas's
// alpha alone: over the page (the Moon still in the hero's place) it is
// light on the page, not a dark patch where the glow is faint.
function _aeAddLight(m) {
  m.blending = AE_THREE_CUSTOM_BLENDING;
  m.blendSrc = m.blendDst = AE_THREE_ONE_FACTOR;
  // The canvas is see-through: the light carries its own brightness as alpha (see AE_GLSL_LIGHT_OUT), so over empty
  // sky the premultiplied pixel is valid (colour never above alpha). Safari and WebKit drop colour where alpha is
  // zero, which showed the Sun's corona and the Earth's rim only where something else had been drawn.
  m.blendSrcAlpha = AE_THREE_ONE_FACTOR; m.blendDstAlpha = AE_THREE_ONE_FACTOR;
  return m;
}

// Build the three.js scene. Returns null when WebGL is not available. The
// canvas is see-through (the view's own black is behind it), so the Moon
// can stand over the page in the hero's place before the view grows.
function _aeBuildGl(THREE, canvas) {
  var renderer, dpr = Math.min(window.devicePixelRatio || 1, typeof ZimiCap !== 'undefined' ? ZimiCap.dprCap('earth') : AE_MAX_DPR);   // the level's ratio (2 on a standard device, as 1.15.4 drew)
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, stencil: true, antialias: _aeMsaa(dpr), powerPreference: 'high-performance' });   // stencil: a body's tiles mark what they cover (_aeHdMask)
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
    dayMap: { value: null }, nightMap: { value: null }, coastMap: { value: null },
    sunPos: shared.sunPos, sunR: shared.sunR,
    moonPos: { value: new THREE.Vector3() }, moonR: { value: AE_MOON_RADIUS_RE },
    dim: { value: 1 }
  };
  var earth = new THREE.Mesh(earthGeo, new THREE.ShaderMaterial({
    uniforms: earthUni, vertexShader: AE_EARTH_VERT, fragmentShader: AE_EARTH_FRAG
  }));
  earth.scale.set(1, 1, 1 - AE_EARTH_FLATTENING);
  scene.add(earth);

  var atmo = new THREE.Mesh(
    new THREE.SphereGeometry(AE_ATMOSPHERE_SCALE, AE_ATMO_SEGMENTS[0], AE_ATMO_SEGMENTS[1]),
    _aeAddLight(new THREE.ShaderMaterial({
      uniforms: { sunPos: shared.sunPos }, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_ATMO_FRAG,
      side: AE_THREE_BACK_SIDE, transparent: true, depthWrite: false   // the shell is its far side: a glow at the limb, not a wash over the disc
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
  var sunMat = new THREE.ShaderMaterial({ uniforms: { fade: _aeFadeU, uT: sunT, uSpots: sunSpots }, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_SUN_FRAG, transparent: true });
  sun.add(new THREE.Mesh(new THREE.SphereGeometry(AE_SUN_SHOW_R, AE_SUN_SEGMENTS[0], AE_SUN_SEGMENTS[1]), sunMat));
  var sunGlowUni = { center: { value: new THREE.Vector3() }, radius: { value: AE_SUN_SHOW_R }, fade: _aeFadeU, uT: sunT };
  var sunGlowMat = _aeAddLight(new THREE.ShaderMaterial({
    uniforms: sunGlowUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_SUN_GLOW_FRAG,
    side: THREE.BackSide, transparent: true, depthWrite: false
  }));
  sun.add(new THREE.Mesh(new THREE.SphereGeometry(AE_SUN_SHOW_R * AE_SUN_GLOW_SCALE, AE_SUN_SEGMENTS[0], AE_SUN_SEGMENTS[1]), sunGlowMat));
  scene.add(sun);

  var moonPathCount = _aeMoonPathTimes(0).length;
  var moonPath = _aeLine(THREE, THREE.Line, moonPathCount, AE_MOON_PATH_COLOR, AE_MOON_PATH_ALPHA);
  scene.add(moonPath);
  var gpsRings = _aeLine(THREE, THREE.LineSegments, AE_SAT_CAPACITY * AE_GPS_RING_POINTS * 2, AE_GPS_RING_COLOR, AE_GPS_RING_ALPHA);
  scene.add(gpsRings);
  var issRing = _aeLine(THREE, THREE.LineLoop, AE_ISS_RING_POINTS, AE_ISS_RING_COLOR, AE_ISS_RING_ALPHA);
  scene.add(issRing);
  var sats = _aePointCloud(THREE, AE_SAT_CAPACITY, dpr, false, { depthTest: true });
  scene.add(sats);
  var S0 = { THREE: THREE, scene: scene, pv: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] };
  _aeBuildPlanets(S0);

  return {
    THREE: THREE, renderer: renderer, scene: scene, camera: camera, dpr: dpr,
    earth: earth, earthUni: earthUni, moon: moon, moonUni: moonUni, shared: shared,
    sky: sky, starCloud: starCloud, starsLoaded: false, starsLoading: false, sun: sun, sunGlowUni: sunGlowUni, sunMat: sunMat, sunGlowMat: sunGlowMat, sunT: sunT, sunSpots: sunSpots, spotsAt: null, moonPath: moonPath, moonPathCount: moonPathCount,
    gpsRings: gpsRings, issRing: issRing, sats: sats,
    basis: new THREE.Matrix4(), vx: new THREE.Vector3(), vy: new THREE.Vector3(), vz: new THREE.Vector3(), planets: S0.planets, earthOrbit: S0.earthOrbit, pv: S0.pv,
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
    if (typeof ZimiCap !== 'undefined') ZimiCap.hold();   // the frames around a map's load and upload are not the device's pace
    S.maps[url] = (load ? load() : _aeLoadTexture(S.THREE, url)).then(function (tx) {
      tx.anisotropy = S.aniso;
      if (format) tx.format = format;
      if (uni.value) uni.value.dispose();   // a map it replaces (the Moon's 1024 one)
      uni.value = tx;
      if (S.earthUni && uni === S.earthUni.dayMap) _aeLater(function () { if (_ae && _ae.gl === S) { _aeEarthCoast(S, tx); _aeRedraw(); } });   // the shore map is two million pixels of work: after the picture is up, not before it
      if (typeof ZimiCap !== 'undefined' && tx.image && tx.image.width) {   // the capability level's memory budget (capability.js)
        if (uni.__capKey) ZimiCap.gpuFree(uni.__capKey);
        uni.__capKey = 'map:' + url;
        ZimiCap.gpuTrack(uni.__capKey, tx.image.width * tx.image.height * 4 * 1.34);
      }
      return true;
    }, function () {
      delete S.maps[url];
      return false;
    }).then(function (ok) {
      S.mapFailed[url] = !ok;
      if (typeof ZimiCap !== 'undefined') ZimiCap.hold();
      _aeRedraw();
      // Ready behind the page, a map that comes later is uploaded now too.
      if (ok && _ae.ready) _aeWarmSliced(S);
      return ok;
    });
  }
  return S.maps[url];
}
// The near-land map the shore tint reads: for every 4 x 4 pixels of the day map, the share that is not sea (by the shader's own
// blue test), blurred by a box a few cells wide, twice, so it is smooth and a few hundred km broad. Built once from the day map the
// view already has (nothing fetched), a canvas of AE_COAST_W x AE_COAST_H cells in its red channel, its rows in the day map's order
// (the map is decoded flipped, so its first row is the south's: the texture takes the day map's flipY).
// A hint shown the first time only (a mode's keys or thumbs), taken away by the first touch of anything and never back: the text is `textKey`, and
// `textKey_keys` on a mouse. The seen mark is kept per mode in `storeKey`. Untouched, it goes by itself after AE_HINT_MS (a trip the
// autopilot flies touches nothing) and stays away while the page lives; it is only the first use that settles it for good.
var AE_HINT_MS = 6000, _aeHintOut = {};
function _aeHintShow(el, storeKey, textKey) {
  var seen = !!_aeHintOut[storeKey] || !!_rawGet(storeKey);
  if (!el || seen) return false;
  el.textContent = _aeT(window.matchMedia && matchMedia('(pointer: fine)').matches ? textKey + '_keys' : textKey);
  el.hidden = false;
  setTimeout(function () { _aeHintOut[storeKey] = true; el.hidden = true; }, AE_HINT_MS);   // read or not, it has had its say
  return true;
}
function _aeHintDone(el, storeKey) {
  if (!el || (el.hidden && !_aeHintOut[storeKey])) return;   // (timed out, the first use still settles it for good)
  el.hidden = true;
  try { localStorage.setItem(storeKey, '1'); } catch (e) {}
}
// When the browser has nothing else to do (the first frames come first), within two seconds at the latest.
function _aeLater(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 }); else setTimeout(fn, 300);
}
function _aeEarthCoast(S, dayTx) {
  try {
    var img = dayTx.image, W = img.width, H = img.height, k = W / AE_COAST_W, cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
    cv.width = W; cv.height = H;
    g.drawImage(img, 0, 0);
    var px = g.getImageData(0, 0, W, H).data, land = new Float32Array(AE_COAST_W * AE_COAST_H), cell = k * k;
    for (var y = 0; y < H; y++) {
      var row = Math.floor(y / k) * AE_COAST_W;
      for (var x = 0; x < W; x++) {
        var i = 4 * (y * W + x), r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
        var sea = (b > r * 1.25 + 0.02 && b >= gg && b < AE_COAST_SEA_MAX_BLUE) || Math.max(r, gg, b) < (AE_SEA_DARK_FROM + AE_SEA_DARK_TO) / 2;
        if (!sea) land[row + Math.floor(x / k)] += 1 / cell;
      }
    }
    for (var p = 0; p < AE_COAST_PASSES; p++) land = _aeBoxBlur(land, AE_COAST_W, AE_COAST_H, AE_COAST_BLUR);
    cv.width = AE_COAST_W; cv.height = AE_COAST_H;
    var out = g.createImageData(AE_COAST_W, AE_COAST_H);
    for (var n = 0; n < land.length; n++) { out.data[4 * n] = out.data[4 * n + 1] = out.data[4 * n + 2] = Math.round(land[n] * 255); out.data[4 * n + 3] = 255; }
    g.putImageData(out, 0, 0);
    var tx = new S.THREE.Texture(cv);
    tx.minFilter = tx.magFilter = S.THREE.LinearFilter; tx.wrapS = S.THREE.RepeatWrapping; tx.wrapT = S.THREE.ClampToEdgeWrapping;
    tx.flipY = dayTx.flipY; tx.generateMipmaps = false; tx.needsUpdate = true;
    if (S.earthUni.coastMap.value) S.earthUni.coastMap.value.dispose();
    S.earthUni.coastMap.value = tx;
  } catch (e) { /* no canvas to read the map with: the sea stays one colour */ }
}
// A box blur of radius r (cells) on a w x h field, longitudes wrapping round, latitudes held at the poles.
function _aeBoxBlur(a, w, h, r) {
  var n = 2 * r + 1, tmp = new Float32Array(a.length), out = new Float32Array(a.length), x, y, d;
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) { var s = 0; for (d = -r; d <= r; d++) s += a[y * w + (x + d + w) % w]; tmp[y * w + x] = s / n; }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) { var t = 0; for (d = -r; d <= r; d++) t += tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x]; out[y * w + x] = t / n; }
  return out;
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
// The 4096 Moon (730 KB, 43 MB of texture memory once on the GPU) is asked for when the 1024 map can no longer show the Moon: the
// Moon is what the view is on (opened from Go to, or a flight there), or its disc is wide enough that a texel of the small map
// is bigger than a pixel, less a lead (AE_MOON_HI_LEAD) for the file to arrive (a hemisphere of the map, W / 2 texels, across a disc 2R pixels wide: W / 4R texels to a pixel). Until
// then the 3D Moon is drawn from the small map, and the Earth opens without this file.
var AE_MOON_LO_MAP_W = 1024;          // the width of the small map (AE_TEX_MOON)
var AE_MOON_HI_LEAD = 4;              // the big map is asked for when its disc is this many times smaller than where the small map runs out: it is on the GPU by the time it shows
function _aeMoonDiscPx(S) {
  var e = S.moon.matrixWorld.elements, cam = S.camera.position, d = Math.hypot(cam.x - e[12], cam.y - e[13], cam.z - e[14]);
  return AE_MOON_RADIUS_RE / Math.max(1e-9, d) * _aePxPerRad(S.camera) * (typeof window !== 'undefined' && window.devicePixelRatio || 1);
}
function _aeMoonHiWanted(S) {
  // Not while the scene is being built: until the view is ready and open the camera sits at its default distance, where the Moon's disc is wide.
  // The hero Moon touched (_aeMoonNext) is the exception: the lift needs the big map on the GPU before the view opens.
  if (S.moonHiAsked || !S.moonUni.moonMapped.value || (!_ae.moonNext && (!_ae.ready || !_aeIsOpen))) return;
  var bound = !!_ae.orbitFly && _ae.orbitFly.to === 'moon' && !_ae.orbitFly.endAt;   // a flight to the Moon is on: the file is wanted on arrival, and takes a while to come
  if (_ae.target !== 'moon' && !bound && !_ae.moonNext && _aeMoonDiscPx(S) < AE_MOON_LO_MAP_W / 4 / AE_MOON_HI_LEAD) return;
  S.moonHiAsked = true;
  _aeLoadMap(S, S.moonUni.moonMap, AE_TEX_MOON_HI, AE_THREE_RED_FORMAT, _aeSharedHiMoon(S));
}
// The hero Moon was touched or pointed at: the view will open on the Moon, so its 4096 map is asked for now, while the view is prepared.
function _aeMoonNext() {
  if (!_ae) return;
  _ae.moonNext = true;
  if (_ae.gl) _aeMoonHiWanted(_ae.gl);
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
    _aeMoonHiWanted(S);   // the 4096 one at once if the Moon is what the view opens on; else when it is wanted (each frame)
  });
  if (_ae.hdInstalled && !S.hdAsked) { S.hdAsked = true; _aeHdLoad(S); }   // a view built again (it gives the GPU back)
  return _aeLoadMap(S, S.earthUni.dayMap, AE_TEX_DAY);
}

// ── Almanac HD: the Earth and the Moon in tiles, as sharp as the view ──
// Almanac HD (scripts/build_almanac_hd.py) is a ZIM of its own: each body's map cut into 512 px tiles, level by level
// (level z: 2^(z+1) columns by 2^z rows, 180 / 2^z degrees a side, from longitude -180 and latitude +90). Installed,
// the view draws each body as the tiles in sight instead of its one map, each at the level whose texels are no smaller
// than the screen's pixels, and lets the camera nearer. Without it nothing here runs: the one map is the view.
// Where the tiles are: the server says (the HD flavour of the Almanac, /w/zimi_almanac_maxi/hd/, or the 1.15.3 tile
// ZIM, below) or the Almanac ZIM's own answer (hd/, a path from its page, so Kiwix finds them beside it).
var AE_HD_BASE_LEGACY = '/w/zimi_almanac_hd/';
function _aeHdBase() { return (_ae.hdSt && _ae.hdSt.base) || AE_HD_BASE_LEGACY; }
// The ZIMs that hold the tiles: the main one (the Almanac's HD flavour, or 1.15.3's tile ZIM) and, when the set is split
// (a layer too big for one file), each part installed beside it. Each layer's folder is read from the ZIM that lists it.
function _aeHdBases() {
  var parts = (_ae.hdSt && _ae.hdSt.parts) || {};
  return [_aeHdBase()].concat(Object.keys(parts).sort().map(function (k) { return parts[k]; }));
}
// The lists of layers of every ZIM in the set as one: each layer remembers whose folder it is in (``base``). A part that
// does not answer leaves its layers out, so its bodies keep their one map; the main ZIM's list is required.
function _aeHdManifest() {
  var bases = _aeHdBases();
  return Promise.all(bases.map(function (base, i) {
    return fetch(base + 'hd.json').then(function (r) { if (!r.ok) throw new Error('hd'); return r.json(); }).then(function (man) {
      Object.keys((man && man.layers) || {}).forEach(function (k) { man.layers[k].base = base; });
      return man;
    }).catch(function (e) { if (i === 0) throw e; return null; });
  })).then(function (mans) {
    var man = mans[0];
    mans.slice(1).forEach(function (x) {
      if (!x || !x.layers) return;
      Object.keys(x.layers).forEach(function (k) {
        var core = man.layers[k], deep = x.layers[k];
        // A layer split between the core and a part (levels from ``from`` on): the core's folder for the levels it holds, the
        // part's from there, to the part's deepest; and its inserts, which only the part has.
        man.layers[k] = core && deep.from != null ? { max: deep.max, px: deep.px, base: core.base, deep: { from: deep.from, base: deep.base }, inserts: deep.inserts } : deep;
      });
    });
    return man;
  });
}
// The set's list, read once per view: the tiles and the craft (hd.json "craft") both go by it.
function _aeHdManifestOnce() { return _ae.hdManP || (_ae.hdManP = _aeHdManifest()); }
var AE_HD_TILE_PX = 512;
var AE_HD_WANT_MAX = 48;         // the most tiles a body asks to load newly in one frame (nearest first)
var AE_HD_SPLIT = 1.0;          // a tile gives way to its four once it covers more device pixels than it has
// What the tiles may hold on the GPU, in bytes (a tile of 512 px: 1.4 MB with mipmaps, a one-channel one a quarter of
// that): the least recently drawn go first, any level, once it is over. A phone gets less than a desktop.
var AE_HD_GPU_MB_PHONE = 96, AE_HD_GPU_MB_DESKTOP = 256;
var AE_HD_MIP_FACTOR = 4 / 3, AE_HD_RGBA_BYTES = 4;
var AE_HD_UPLOADS = 2;           // decoded tiles handed to the GPU a frame: a burst of them in one frame is a stall
var AE_HD_LOADS = 6;             // tiles fetched at once
var AE_HD_KEEP_LEVEL = 1;        // levels 0 and 1 (10 tiles a layer) stay: there is always something to draw
var AE_HD_KEEP_TILES = 10;       // 2 at level 0 and 8 at level 1 (a level z is 2^(z+1) by 2^z tiles)
var AE_HD_MIN_BODY_PX = 40;      // a body smaller than this (radius, CSS px) keeps its one map and asks for no tile
var AE_HD_SEG_DEG = 2.8;         // a tile's mesh no coarser than the base sphere's (AE_EARTH_SEGMENTS)
var AE_HD_MIN_SEG = 8;
var AE_HD_SKIRT = 0.002;         // each tile's edges hang this far below the surface (of its radius): no crack shows where levels meet
var AE_HD_TILE_REACH = 0.75;     // a tile's angular radius, as a share of its side (half its diagonal, and a margin)
var AE_HD_Z_ORDER = 0.01;       // each level's step in the draw order, finer last
var AE_HD_TILE_ORDER = -1;       // tiles are drawn before their body's one map, which fills in round them (_aeHdMask)
var AE_HD_RETRY_MS = 2000, AE_HD_RETRY_MAX_MS = 60000;   // a tile that did not come is asked for again after this long, doubling up to the most
// With HD, the Earth's closest approach at the least (its deepest level may let it nearer); nearer than a body's
// deepest texels at about two CSS pixels the picture only blurs. Every body's is worked out from its deepest level
// as if its tiles were AE_HD_TILE_PX (_aeHdTexelMin): a deepest level stored at its source's own, smaller size (the
// build's native_px) is the same picture, so the camera comes as near as it did when the file magnified it.
var AE_HD_MIN_ALT_KM = 400;
// A place on a body (latitude, longitude in degrees) as a unit vector in the body's own frame.
// The point of a body's drawn sphere (squashed along its pole by `flat`) at a latitude and longitude. A map's rows follow
// the geodetic latitude, so with a flattening the sphere's own (reduced) latitude is the one whose tan is (1 - f) tan(lat):
// then a texture, tile, pin or road at (lat, lon) lands on the true ellipsoid point. Pass AE_EARTH_FLATTENING for Earth
// surface points, and never read a latitude off the Earth mesh's uv (its picture row is looked up in AE_EARTH_VERT).
function _aeLatLonVec(lat, lon, flat) {
  var la = _aeRad(lat), k = flat ? 1 - flat : 1;
  return _aeEqVec(_aeRad(lon), Math.atan2(k * Math.sin(la), Math.cos(la)), 1);
}
// The inverse, for a point of the drawn sphere (unit, local): its geodetic latitude and longitude in degrees.
function _aeSphereLatLon(x, y, z, flat) {
  var k = flat ? 1 - flat : 1;
  return { lat: _aeDeg(Math.atan2(z, k * Math.hypot(x, y))), lon: _aeDeg(Math.atan2(y, x)) };
}

// Each body's tiled layers: the sampler each fills in the body's own shader, and the layer's folder in the ZIM.
function _aeHdBodies(S) {
  return [
    { key: 'earth', parent: S.earth, radius: 1, frag: AE_EARTH_FRAG, uni: S.earthUni,
      maps: [{ uni: 'dayMap', layer: 'earth/day' }, { uni: 'nightMap', layer: 'earth/night', red: true }],
      minDist: 1 + AE_HD_MIN_ALT_KM / AE_EARTH_RADIUS_KM },
    { key: 'moon', parent: S.moon, radius: AE_MOON_RADIUS_RE, frag: AE_MOON_FRAG, uni: S.moonUni,
      maps: [{ uni: 'moonMap', layer: 'moon/albedo', red: true }, { uni: 'reliefMap', layer: 'moon/relief', optional: true }],
      extra: { moonMapped: { value: 1 }, moonPole: { value: S.vz } }, relief: true,
      minDist: AE_MIN_DIST_MOON }
  ].concat(AE_PLANETS.filter(function (b) { return S.planets && S.planets[b.key]; }).map(function (b) {
    var p = S.planets[b.key];
    return { key: b.key, parent: p.mesh, radius: b.r, frag: AE_PLANET_FRAG, uni: p.uni, cc: !!b.ccHd,
      maps: [{ uni: 'map', layer: 'planets/' + b.key }], extra: { mapped: { value: 1 } }, minDist: AE_TARGETS[b.key].min };
  }));
}
// Reads the ZIM's list of layers once the server says it is installed (the satellites answer, _aeHdShow: the library
// lists it nowhere, server.DATA_PACKS); a body whose layers are all there is drawn in tiles from then on.
function _aeHdLoad(S) {
  if (S.hd) return;
  S.hd = null;
  if (typeof fetch !== 'function') return;
  _aeHdManifestOnce().then(function (man) {
    if (_ae.gl !== S || !man || !man.layers) return;
    var bodies = _aeHdBodies(S).filter(function (b) {
      b.maps = b.maps.filter(function (m) { return man.layers[m.layer] || !m.optional; });
      return b.maps.every(function (m) { return man.layers[m.layer]; });
    });
    if (!bodies.length) return;
    S.hd = { man: man, bodies: bodies, queue: [], loading: 0, gpu: 0, frame: 0, fresh: [], budget: _aeHdBudget() };   // gpu: bytes held
    bodies.forEach(function (b) {
      b.max = man.layers[b.maps[0].layer].max;
      b.maps.forEach(function (m) {
        m.max = man.layers[m.layer].max;
        m.base = man.layers[m.layer].base;
        m.deep = man.layers[m.layer].deep;
        // Inserts: tiles past the layer's max, only round some places (the Apollo sites), by level.
        m.ins = {};
        (man.layers[m.layer].inserts || []).forEach(function (e) { (m.ins[e.z] = m.ins[e.z] || []).push(e); });
      });
      b.nodes = {};
      b.drawn = [];
      b.holes = 0;
      b.ref = bodies.indexOf(b) + 1;
      _aeHdMask(b.parent.material, b.ref, false);
      b.frag = _aeHdFrag(b.relief && b.maps.some(function (m) { return m.uni === 'reliefMap'; }) ? _aeReliefFrag(b.frag) : b.frag, b.maps);
      AE_TARGETS[b.key].min = Math.min(AE_TARGETS[b.key].min, b.minDist);
    });
    _aeRedraw();
  }).catch(function () {});
}
// A body's one map is always drawn, under its tiles: a tile marks the pixels it covers with its body's number (the
// stencil) and the one map is refused exactly those. So the globe is closed whatever the tiles are doing: on their way,
// failed, chosen for a camera that has since moved, or turned off.
var AE_THREE_NOT_EQUAL_STENCIL = 517, AE_THREE_ALWAYS_STENCIL = 519, AE_THREE_KEEP_STENCIL = 7680, AE_THREE_REPLACE_STENCIL = 7681;   // three's, not exported by name by the tree-shaken build
function _aeHdMask(mat, ref, tile) {
  mat.stencilWrite = ref > 0;   // three's switch for the stencil test
  mat.stencilRef = ref;
  mat.stencilFunc = tile ? AE_THREE_ALWAYS_STENCIL : AE_THREE_NOT_EQUAL_STENCIL;
  mat.stencilZPass = tile ? AE_THREE_REPLACE_STENCIL : AE_THREE_KEEP_STENCIL;
}
// The body's shader with each map read through its tile's box: (offset u, offset v, width, height) of the tile in the
// whole map's uv, so a tile is drawn by the same lighting as the one map was.
function _aeHdFrag(frag, maps) {
  var decl = maps.map(function (m) { return 'uniform vec4 uBox_' + m.uni + ';'; }).join(' ');
  var out = frag.replace('precision highp float;', 'precision highp float;\n' + decl);
  maps.forEach(function (m) {
    out = out.split('texture2D(' + m.uni + ', vUv)').join('texture2D(' + m.uni + ', (vUv - uBox_' + m.uni + '.xy) / uBox_' + m.uni + '.zw)');
  });
  return out;
}
// The Moon's relief (LOLA, as normals: east and north tilt in red and green): each pixel's surface turned by its
// slope before the light is reckoned, so crater walls and ridges catch the Sun of the moment and cast no light past
// the terminator (the sphere's own horizon still decides day and night: a tilt does not raise a peak into sunlight).
var AE_RELIEF_TWILIGHT = 0.02;
function _aeReliefFrag(frag) {
  var out = frag.replace('uniform float earthshine;', 'uniform float earthshine; uniform sampler2D reliefMap; uniform vec3 moonPole;');
  out = out.replace('  vec3 N = normalize(vNormal);',
    '  vec3 N0 = normalize(vNormal);\n' +
    '  vec3 E0 = normalize(cross(moonPole, N0) + vec3(1e-6, 0.0, 0.0));\n' +
    // Stored square-root companded (scripts/build_almanac_hd.py normals_map), so a mare's gentle slopes keep their
    // steps under a low Sun: squared back here.
    '  vec2 e = texture2D(reliefMap, vUv).rg * 2.0 - 1.0;\n' +
    '  vec2 tilt = sign(e) * e * e;\n' +
    '  vec3 N = normalize(E0 * tilt.x + cross(N0, E0) * tilt.y + N0 * sqrt(max(1.0 - dot(tilt, tilt), 0.0025)));');
  out = out.replace('  float sun = aeLunarLambert(dot(N, L), mu, aeLunarL(dot(L, V)));',
    '  float sun = aeLunarLambert(max(dot(N, L), 0.0), mu, aeLunarL(dot(L, V))) * smoothstep(-' + AE_RELIEF_TWILIGHT + ', ' + AE_RELIEF_TWILIGHT + ', dot(N0, L));');
  return out;
}
// A phone-sized device (a touch screen, or little memory) keeps fewer tiles.
function _aeHdBudget() {
  var phone = false;
  try { phone = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || (navigator.deviceMemory || 8) <= 4; } catch (e) {}
  return Math.min(phone ? AE_HD_GPU_MB_PHONE : AE_HD_GPU_MB_DESKTOP, _aeCapGet('hdMemMB', 1e9)) * 1048576;
}
// A layer's deepest level may be stored at its source's own size, smaller than AE_HD_TILE_PX (build_almanac_hd.py
// native_px): a tile is mapped by its box, so only what it holds on the GPU is counted from its own size.
function _aeHdTexBytes(tx, red) {
  var px = (tx.image && tx.image.width) || AE_HD_TILE_PX;
  return Math.round(px * px * (red ? 1 : AE_HD_RGBA_BYTES) * AE_HD_MIP_FACTOR);
}
function _aeHdKey(z, x, y) { return z + '/' + x + '/' + y; }
function _aeHdSpan(z) { return 180 / Math.pow(2, z); }
// A tile's box in the whole map's uv (u from longitude -180, v from latitude -90).
function _aeHdBox(z, x, y) {
  var w = 1 / Math.pow(2, z + 1), h = 1 / Math.pow(2, z);
  return [x * w, 1 - (y + 1) * h, w, h];
}
// One tile's patch of sphere, with the whole map's uv (the shader picks the tile's part), and a skirt round its edges.
function _aeHdGeometry(THREE, z, x, y, radius, flat) {
  var span = _aeHdSpan(z), n = Math.max(AE_HD_MIN_SEG, Math.ceil(span / AE_HD_SEG_DEG));
  var lon0 = -180 + x * span, lat0 = 90 - y * span;
  var pos = [], nor = [], uv = [], idx = [];
  var vert = function (lat, lon, r) {
    var p = _aeLatLonVec(lat, lon, flat);
    pos.push(p[0] * r, p[1] * r, p[2] * r);
    nor.push(p[0], p[1], p[2]);
    uv.push((lon + 180) / 360, (lat + 90) / 180);
    return pos.length / 3 - 1;
  };
  var grid = [];
  for (var i = 0; i <= n; i++) {
    grid.push([]);
    for (var j = 0; j <= n; j++) grid[i].push(vert(lat0 - span * i / n, lon0 + span * j / n, radius));
  }
  for (i = 0; i < n; i++) {
    for (j = 0; j < n; j++) {
      var a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
      idx.push(a, b, d, b, c, d);
    }
  }
  // The skirt: each edge again, hung below the surface, joined to the edge.
  var edges = [
    grid[0].slice(),
    grid.map(function (row) { return row[n]; }),
    grid[n].slice().reverse(),
    grid.map(function (row) { return row[0]; }).reverse()
  ];
  var low = radius * (1 - AE_HD_SKIRT);
  edges.forEach(function (edge) {
    var under = edge.map(function (k) {
      var u = uv[2 * k], v = uv[2 * k + 1];
      return vert(v * 180 - 90, u * 360 - 180, low);
    });
    for (var k = 0; k < edge.length - 1; k++) idx.push(edge[k], under[k], edge[k + 1], under[k], under[k + 1], edge[k + 1]);
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}
function _aeHdNode(b, z, x, y) {
  var key = _aeHdKey(z, x, y), n = b.nodes[key];
  if (!n) n = b.nodes[key] = { z: z, x: x, y: y, key: key, tex: {}, mesh: null, used: 0 };
  return n;
}
// A layer's tile for node n: the node's own, or (past the layer's deepest level) the ancestor's at that level.
function _aeHdLayerNode(b, n, m) {
  if (n.z <= m.max || _aeHdInInsert(m, n.z, n.x, n.y)) return n;
  var up = n.z - m.max;
  return _aeHdNode(b, m.max, n.x >> up, n.y >> up);
}
function _aeHdInInsert(m, z, x, y) {
  var list = m.ins && m.ins[z];
  if (!list) return false;
  for (var i = 0; i < list.length; i++) { var e = list[i]; if (x >= e.x0 && x <= e.x1 && y >= e.y0 && y <= e.y1) return e; }
  return false;
}
// A tile gives way to its four when they are there: below the layer's max everywhere, past it inside an insert.
function _aeHdCanSplit(b, z, x, y) {
  var m = b.maps[0];
  if (z < b.max) return true;
  for (var k = 0; k < 4; k++) if (!_aeHdInInsert(m, z + 1, 2 * x + (k & 1), 2 * y + (k >> 1))) return false;
  return true;
}
// The body in view: its closest approach is the one over the point below the camera, and a camera that has moved off
// an insert is eased back out to the body's own limit.
function _aeHdKeepAbove(S, b) {
  var inv = new S.THREE.Matrix4().copy(b.parent.matrixWorld).invert();
  var c = S.camera.position.clone().applyMatrix4(inv), r = Math.hypot(c.x, c.y, c.z);
  if (!(r > 0)) return;   // the camera has no place yet (the first frames): there is no point below it
  var min = _aeHdMinOver(b, _aeDeg(Math.asin(_aeClamp(c.z / r, -1, 1))), _aeDeg(Math.atan2(c.y, c.x)));
  if (!isFinite(min)) return;
  if (b.key === 'earth') min = Math.min(min, _aeMapsMin());
  min = Math.min(min, _aeStopCap(b.key));
  AE_TARGETS[b.key].min = min;
  if (_ae.dist < min) { _ae.dist = min; _ae.dirty = true; }
}
// ── The installed map on the Earth (almanac-maps.js, fetched the first time the camera is this low) ──
// An installed map's roads and names fade in over the globe as the camera comes down, and over such a map the camera may
// come much nearer: the lines stay sharp where the picture of the ground blurs. Needs the app shell (the map is a ZIM
// of the library); the Almanac ZIM on its own has none, and then nothing here runs.
var AE_MAPS_SRC = _almAsset('/static/almanac-maps.js');
// Off in 1.16: the roads on the globe, the map chip and the 3D view's map buttons wait for 1.16.1 (the code stays, unreached).
var AE_MAPS_ON = false;
// The shared map flow (app.js _mapHere), where the 3D view may use it: the shell is there and the maps are on.
function _aeMapsShell() { return AE_MAPS_ON && typeof _mapHere === 'function'; }
var AE_MAPS = {
  loadDist: 1.6,        // Earth radii from the centre: the module is fetched below this (or held at the one map's stop: _aeCloseStop)
  startKm: 3000,        // altitude where the roads and names begin to show ...
  fullKm: 1200,         // ... and are fully there
  hintKm: 1500,         // the chip (the map here, or the one to get) is offered below this
  minKm: 50,            // the nearest the camera may come over an installed map
  tilePx: 320           // CSS pixels a map tile is drawn across
};
var _aeMapsAsked = false;
function _aeMapsFrame(S) {
  if (window.AlmanacMaps) {
    AlmanacMaps.frame(S);
    if (!S.hd) AE_TARGETS.earth.min = _aeMapsMin();
    return;
  }
  if (_aeMapsAsked || _ae.target !== 'earth' || (_ae.dist >= AE_MAPS.loadDist && !_ae.mapsWatch) || !_aeMapsShell() || typeof _loadScript !== 'function') return;
  _aeMapsAsked = true;
  Promise.all([_mapHere(), _loadScript(AE_MAPS_SRC)]).then(function (got) {
    if (!got[0] || !got[1]) { _aeMapsAsked = false; return; }
    _aeRedraw();
  });
}
// The Earth's closest approach: the usual, or over an installed map the map's own.
// The closest stop over a body drawn from its one base map: its texels (a map W across the equator) are AE_CLOSE_TEXEL_PX pixels
// across, never nearer than the body's own limit (so an installed HD or map, which sets its own, goes closer: _aeHdMinOver, _aeMapsMin).
var AE_EARTH_MAP_W = 2048, AE_BODY_MAP_W = 1024;
function _aeBaseMapW(key, S) {
  if (key === 'earth') return AE_EARTH_MAP_W;
  if (key === 'moon') { var m = S.moonUni && S.moonUni.moonMap && S.moonUni.moonMap.value, w = m && m.image && m.image.width; return w || AE_MOON_LO_MAP_W; }
  return AE_BODY_MAP_W;
}
function _aeSharpMin(key, S) {
  var t = AE_TARGETS[key], texel = 2 * Math.PI * t.surface / _aeBaseMapW(key, S);   // Earth radii
  return t.surface + texel * _ae.h * (S.dpr || 1) / (AE_CLOSE_TEXEL_PX * _aeRad(S.camera.fov));
}
var AE_NEAR_STOP = 1.3;   // within this share of the stop is "near it": landmarks show by themselves, the hint may say more is there
var AE_AT_STOP = 1.02;    // within this share the camera is held at it: what would let it nearer is offered (a sharper size, a map of here)
function _aeCloseStop(S) {
  var key = _ae.target, t = AE_TARGETS[key];
  _ae.nearStop = _ae.atStop = _ae.mapsWatch = false;
  if (!t || !t.surface || key === 'sun' || key === 'iss' || _aeIsProbe(key) || AE_CRAFT_MODEL[key] || _ae.fly || _ae.site || _ae.stand || _ae.spin) return;
  if (t.floor === undefined) t.floor = t.min;   // the body's own limit, before any map sets a nearer one
  var hdBody = !!(S.hd && S.hd.bodies && S.hd.bodies.some(function (b) { return b.key === key; })), covered = key === 'earth' && window.AlmanacMaps && AlmanacMaps.under();
  if (!hdBody && (key === 'earth' || key === 'moon' || _aePlanetBody(key))) {
    var min = Math.min(Math.max(t.floor, _aeSharpMin(key, S)), _aeStopCap(key));
    // The Earth's one map stops the camera far above where an installed map's roads begin: near that stop the map under
    // the camera is looked up (almanac-maps.js), and over one the stop gives way to it.
    _ae.mapsWatch = key === 'earth' && isFinite(min) && _ae.dist <= min * AE_NEAR_STOP;
    if (!covered && isFinite(min)) { t.min = min; if (_ae.dist < min) { _ae.dist = min; _ae.dirty = true; } }
    t.stop = !covered && isFinite(min) ? min : undefined;
  } else t.stop = undefined;
  _ae.nearStop = isFinite(t.min) && _ae.dist <= t.min * AE_NEAR_STOP;
  _ae.atStop = isFinite(t.min) && _ae.dist <= t.min * AE_AT_STOP;
  _aeCloseHint(key, t);
}
// At the stop, with a sharper size that this person does not have: one quiet line, once a session for each body. A tap on it opens
// the choice in the gear.
function _aeHdSharper() {
  var st = _ae.hdSt;
  if (!st || st.downloading || st.mode === 'never' || !st.can_change) return false;
  var rank = { hd: 1, max: 2 }, have = rank[st.kind] || 0, offers = st.offers || {};
  return Object.keys(offers).some(function (k) { return (rank[k] || 0) > have; });
}
function _aeCloseHint(key, t) {
  if (!_ae.atStop || !_aeHdSharper()) return;
  var seen = _ae.closeHinted || (_ae.closeHinted = {});
  if (seen[key]) return;
  seen[key] = true;
  _aeShowHint(_aeT('alm_hd_closer_hint'), function () { _aeShowSettings(true); });
}
function _aeMapsMin() {
  return window.AlmanacMaps && AlmanacMaps.covers() ? Math.min(AE_MIN_DIST_EARTH, 1 + AE_MAPS.minKm / AE_EARTH_RADIUS_KM) : AE_MIN_DIST_EARTH;
}
// How near the camera may come over a place: the closest at which the deepest tile there is still two or three device
// pixels a texel (the body's own deepest level where there is no insert), never nearer than the body's own limit.
var AE_CLOSE_TEXEL_PX = 1.5;   // the closest stop: a texel of the best map loaded is this many device pixels across (the owner: stop where it is still sharp)
var AE_HD_TEXEL_PX = AE_CLOSE_TEXEL_PX, AE_HD_INSERT_MIN_ALT_KM = 0.5;
function _aeHdTexelMin(b, level) {
  var texelKm = _aeRad(180 / Math.pow(2, level) / AE_HD_TILE_PX) * b.radius * AE_EARTH_RADIUS_KM;
  var cam = _ae.gl.camera, hPx = _ae.h * _ae.gl.dpr;
  var altKm = Math.max(AE_HD_INSERT_MIN_ALT_KM, texelKm * hPx / (AE_HD_TEXEL_PX * _aeRad(cam.fov)));
  return Math.min(b.minDist, b.radius + altKm / AE_EARTH_RADIUS_KM);
}
function _aeHdMinOver(b, lat, lon) {
  var m = b.maps[0], deepest = m.max;
  for (var z in m.ins) {
    var span = 180 / Math.pow(2, +z), x = Math.floor((lon + 180) / span), y = Math.floor((90 - lat) / span);
    if (+z > deepest && _aeHdInInsert(m, +z, x, y)) deepest = +z;
  }
  return _aeHdTexelMin(b, deepest);
}
function _aeHdTileUrl(m, n) { return (m.deep && n.z >= m.deep.from ? m.deep.base : m.base || _aeHdBase()) + m.layer + '/' + n.z + '/' + n.x + '/' + n.y + '.webp'; }
function _aeHdReady(b, n) {
  return b.maps.every(function (m) { var t = _aeHdLayerNode(b, n, m).tex[m.layer]; return t && t.isTexture; });
}
// `until`: the last frame the ask holds for (the globe's own: this one). A keeper that asks before the frame's count moves on
// (the ground under a craft, almanac-standhost.js) asks through the next, as it marks the tiles in use: its entries were
// dropped as stale every frame and the ground never had its HD tiles.
function _aeHdWant(S, b, n, pri, until) {
  var seen = until === undefined ? S.hd.frame : until;
  b.maps.forEach(function (m) {
    var ln = _aeHdLayerNode(b, n, m);
    var qe = ln.qe || (ln.qe = {});
    if (ln.tex[m.layer] === undefined) {
      ln.tex[m.layer] = 'queued';
      qe[m.layer] = { b: b, n: ln, m: m, pri: pri, seen: seen };
      S.hd.queue.push(qe[m.layer]);
    } else if (ln.tex[m.layer] === 'queued' && qe[m.layer]) {
      qe[m.layer].pri = Math.min(qe[m.layer].pri, pri);
      qe[m.layer].seen = Math.max(qe[m.layer].seen, seen);
    }
  });
}
// Whether asking for this tile would add to the queue or keep an entry in it (not one already in, or failed, or missing).
function _aeHdNeedsLoad(b, n) {
  return b.maps.some(function (m) { var t = _aeHdLayerNode(b, n, m).tex[m.layer]; return t === undefined || t === 'queued'; });
}
// What the camera no longer wants is not loaded: an entry nobody asked for this frame goes (and is asked for again if the
// view comes back to it). Near the horizon from the station the queue held 900 tiles for 28 s, most of them from where the
// camera had been.
function _aeHdDropStale(hd) {
  hd.queue = hd.queue.filter(function (q) {
    if (q.seen >= hd.frame) return true;
    if (q.n.tex[q.m.layer] === 'queued') delete q.n.tex[q.m.layer];
    if (q.n.qe) delete q.n.qe[q.m.layer];
    return false;
  });
}
// The server out of reach (the phone offline, the server down): no tile is asked for, and none spins, until it may be back.
// navigator.onLine false waits for the browser's own 'online'; a network failure while online waits a doubling while.
function _aeHdAway(hd) { return (typeof navigator !== 'undefined' && navigator.onLine === false) || performance.now() < (hd.waitUntil || 0); }
function _aeHdUnreachable(hd) {
  if (performance.now() < (hd.waitUntil || 0)) return;   // the other tiles of the same burst: one wait for all of them, not one doubling each
  hd.away = Math.min(AE_HD_RETRY_MAX_MS, hd.away ? hd.away * 2 : AE_HD_RETRY_MS);
  hd.waitUntil = performance.now() + hd.away;
  setTimeout(function () { if (_ae && _ae.gl && _ae.gl.hd === hd) _aeRedraw(); }, hd.away + 30);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('online', function () {
    var hd = _ae && _ae.gl && _ae.gl.hd;
    if (hd) { hd.waitUntil = 0; hd.away = 0; }
    if (_ae && _ae.gl) _aeRedraw();
  });
}
function _aeHdPump(S) {
  var hd = S.hd;
  _aeHdDropStale(hd);
  if (_aeHdAway(hd)) return;
  hd.queue.sort(function (a, b) { return a.pri - b.pri; });
  while (hd.loading < AE_HD_LOADS && hd.queue.length) {
    var q = hd.queue.shift();
    hd.loading++;
    (function (q) {
      _aeLoadTexture(S.THREE, _aeHdTileUrl(q.m, q.n)).then(function (tx) {
        if (_ae.gl !== S) { tx.dispose(); return; }
        tx.anisotropy = S.aniso;
        if (q.m.red) tx.format = AE_THREE_RED_FORMAT;   // one channel on the GPU: a quarter of the memory
        tx.userData = { bytes: _aeHdTexBytes(tx, q.m.red) };
        q.n.tex[q.m.layer] = tx;
        hd.gpu += tx.userData.bytes;
        hd.fresh.push(tx);
        if (q.n.fails) q.n.fails[q.m.layer] = 0;
        hd.away = 0;
      }, function (e) {
        if (e && e.status === 404) q.n.tex[q.m.layer] = 'missing';   // not there: its parent's picture stands, and it is not asked for again
        else {
          _aeHdRetryLater(S, q.n, q.m);
          if (!(e && e.status)) _aeHdUnreachable(hd);   // no answer at all: the server is out of reach, not this tile
        }
      }).then(function () {
        hd.loading--;
        if (_ae.gl !== S) return;
        _aeRedraw();
      });
    })(q);
  }
}
// A tile that did not come (the server restarting under a deploy, a dropped connection) is not gone for the session:
// it is forgotten after a wait that doubles each time, and asked for again if the view still wants it then.
function _aeHdRetryLater(S, n, m) {
  var fails = n.fails || (n.fails = {});
  fails[m.layer] = (fails[m.layer] || 0) + 1;
  n.tex[m.layer] = 'failed';
  setTimeout(function () {
    if (n.tex[m.layer] === 'failed') delete n.tex[m.layer];
    if (_ae && _ae.gl === S) _aeRedraw();
  }, Math.min(AE_HD_RETRY_MAX_MS, AE_HD_RETRY_MS * Math.pow(2, fails[m.layer] - 1)));
}
function _aeHdMesh(S, b, n) {
  if (n.mesh) return n.mesh;
  var uniforms = {};
  for (var k in b.uni) uniforms[k] = b.uni[k];
  for (k in b.extra || {}) uniforms[k] = b.extra[k];
  b.maps.forEach(function (m) {
    var ln = _aeHdLayerNode(b, n, m);
    uniforms[m.uni] = { value: ln.tex[m.layer] };
    uniforms['uBox_' + m.uni] = { value: _aeHdBox(ln.z, ln.x, ln.y) };
  });
  n.mesh = new S.THREE.Mesh(_aeHdGeometry(S.THREE, n.z, n.x, n.y, b.radius, b.key === 'earth' ? AE_EARTH_FLATTENING : 0),
    new S.THREE.ShaderMaterial({ uniforms: uniforms, vertexShader: AE_SPHERE_VERT, fragmentShader: b.frag }));
  _aeHdMask(n.mesh.material, b.ref, true);
  n.mesh.renderOrder = AE_HD_TILE_ORDER + n.z * AE_HD_Z_ORDER;   // (a finer tile drawn over a coarser one that stands in under it while it is not in)
  n.mesh.visible = false;
  b.parent.add(n.mesh);
  return n.mesh;
}
function _aeHdFreeMesh(n) {
  if (!n.mesh) return;
  n.mesh.parent.remove(n.mesh);
  n.mesh.geometry.dispose();
  n.mesh.material.dispose();
  n.mesh = null;
}
// The tiles to draw this frame for one body: walk down from level 0, past what is behind the body or off screen,
// giving way to the four below while a tile covers more device pixels than it holds. A tile not in yet is stood in for
// by its nearest ancestor that is (levels 0 and 1 always are, once in).
function _aeHdSelect(S, b, ahead) {
  var cam = ahead || S.camera, inv = new S.THREE.Matrix4().copy(b.parent.matrixWorld).invert();
  var P = cam.position.clone().applyMatrix4(inv);
  var fwd = cam.position.clone().add(cam.getWorldDirection(new S.THREE.Vector3())).applyMatrix4(inv).sub(P).normalize();
  var p = [P.x / b.radius, P.y / b.radius, P.z / b.radius], d = _aeLen(p);
  var horizon = d > 1 ? Math.acos(Math.min(1, 1 / d)) : Math.PI;
  var focal = _aeFocalPx() * S.dpr;
  var halfDiag = Math.atan(_aeTanHalf(cam.fov) * Math.sqrt(1 + cam.aspect * cam.aspect));
  var leaves = [];
  var visit = function (z, x, y) {
    var span = _aeHdSpan(z), lon = _aeRad(-180 + (x + 0.5) * span), lat = _aeRad(90 - (y + 0.5) * span);
    var c = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    var reach = _aeRad(span) * AE_HD_TILE_REACH, chord = 2 * Math.sin(Math.min(reach, Math.PI / 2) / 2);
    var ang = Math.acos(_aeClamp(_aeDot(c, p) / d, -1, 1));
    if (z > 0 && ang - reach > horizon) return;                       // over the horizon
    var v = _aeSub(c, p), dist = _aeLen(v);
    if (z > 0 && dist > chord) {
      var off = Math.acos(_aeClamp((v[0] * fwd.x + v[1] * fwd.y + v[2] * fwd.z) / dist, -1, 1)) - Math.asin(Math.min(1, chord / dist));
      if (off > halfDiag) return;                                     // off the screen
    }
    var near = Math.max(dist - chord, (d - 1) * 0.5, 1e-6);
    var px = _aeRad(span) / near * focal;
    if (px > AE_HD_TILE_PX * AE_HD_SPLIT && _aeHdCanSplit(b, z, x, y)) {
      for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) visit(z + 1, 2 * x + dx, 2 * y + dy);
      return;
    }
    leaves.push({ z: z, x: x, y: y, pri: z * 10 + near });
  };
  visit(0, 0, 0);
  visit(0, 1, 0);
  return leaves;
}
// What the last frame drew, by each ancestor it sits under: the finer tiles a coarser one that is not in yet must not take away.
function _aeHdDrawnUnder(b) {
  var under = {};
  b.drawn.forEach(function (d) {
    if (!d.mesh || !d.mesh.visible || !_aeHdReady(b, d)) return;
    for (var z = d.z - 1; z >= 0; z--) {
      var k = _aeHdKey(z, d.x >> (d.z - z), d.y >> (d.z - z));
      (under[k] || (under[k] = [])).push(d);
    }
  });
  return under;
}
// The tiles a camera that is not here yet will want (the one a move is flying to), asked for after every tile of this frame's own view, so
// that they are in when it gets there and nothing pops in at the end of the move.
var AE_HD_AHEAD_PRI = 1000;
function _aeHdWantAhead(S, b, camera) {
  var asked = 0;
  _aeHdSelect(S, b, camera).sort(function (p, q) { return p.pri - q.pri; }).forEach(function (l) {
    var n = _aeHdNode(b, l.z, l.x, l.y);
    if (_aeHdNeedsLoad(b, n) && ++asked > AE_HD_WANT_MAX) return;
    _aeHdWant(S, b, n, AE_HD_AHEAD_PRI + l.pri);
    _aeHdTouch(b, n, S.hd.frame);
  });
}
// A frame that asks for the tiles of the camera a move is flying to and loads them, with the globe itself not drawn (the ground covers it).
function _aeHdWarm(S) {
  var hd = S.hd;
  if (!hd.ahead || !_aeCapGet('hdTiles', true)) return;
  hd.frame++;
  hd.bodies.forEach(function (b) {
    if (b.key !== _ae.target || b.broken) return;
    b.parent.updateMatrixWorld(true);
    _aeHdWantAhead(S, b, hd.ahead);
  });
  _aeHdPump(S);
}
// In use this frame: the node, and the tiles of its other layers it reads (an ancestor's, past their deepest level).
function _aeHdTouch(b, n, frame) {
  b.maps.forEach(function (m) { _aeHdLayerNode(b, n, m).used = frame; });
}
// Whether the mesh's program has been tried and cannot run (three keeps what the driver said once it has drawn it).
function _aeHdProgramBad(S, mesh) {
  var pr = S.renderer.properties.get(mesh.material), cp = pr && pr.currentProgram;
  return !!(cp && cp.diagnostics && cp.diagnostics.runnable === false);
}
// A body's tiles out of the picture: its one map, drawn under them all along, is what is left.
function _aeHdHide(b) {
  b.drawn.forEach(function (n) { if (n.mesh) n.mesh.visible = false; });
  b.drawn = [];
  b.holes = 0;
}
// The frame's tiles, or none: with the tiles turned off (the device's level stepped down, capability.js) they leave in
// that frame. They are kept in memory, so they are back as soon as the level is.
function _aeHdFrame(S) {
  if (!S.hd || (_ae.site && _ae.site.pose)) return;   // on the ground at a landing site the tiles stay as they were
  if (_aeCapGet('hdTiles', true)) _aeHdUpdate(S);
  else S.hd.bodies.forEach(_aeHdHide);
}
function _aeHdUpdate(S) {
  var hd = S.hd;
  hd.frame++;
  var cam = S.camera, eye = _aeXyz(cam.position), pxPerRad = _aePxPerRad(cam);
  hd.bodies.forEach(function (b) {
    var e = b.parent.matrixWorld.elements, c = [e[12], e[13], e[14]];
    // A tile program the GPU would not link draws nothing: the body's one map, which the tiles replace, stays (a planet with only its grid showed).
    if (!b.broken && b.drawn.some(function (n) { return n.mesh && _aeHdProgramBad(S, n.mesh); })) b.broken = true;
    if (b.broken || !b.parent.visible || b.radius / Math.max(1e-9, _aeLen(_aeSub(c, eye))) * pxPerRad < AE_HD_MIN_BODY_PX) {
      _aeHdHide(b);
      return;
    }
    b.parent.updateMatrixWorld(true);
    // Levels 0 and 1 first, wanted always: the stand-ins for everything else.
    for (var z = 0; z <= AE_HD_KEEP_LEVEL; z++) {
      for (var y = 0; y < Math.pow(2, z); y++) {
        for (var x = 0; x < Math.pow(2, z + 1); x++) {
          var keep = _aeHdNode(b, z, x, y);
          _aeHdWant(S, b, keep, z - 10);
          _aeHdTouch(b, keep, hd.frame);
        }
      }
    }
    var draw = {};
    b.holes = 0;   // tiles in sight with nothing of their own to draw yet: the body's one map shows there
    var asked = 0, held = null;
    _aeHdSelect(S, b).sort(function (p, q) { return p.pri - q.pri; }).forEach(function (l) {
      var n = _aeHdNode(b, l.z, l.x, l.y);
      // Only so many new tiles asked for in a frame, the nearest and shallowest first: from the station the horizon alone
      // wants hundreds, and the ones under the camera waited behind them.
      if (!_aeHdNeedsLoad(b, n) || ++asked <= AE_HD_WANT_MAX) _aeHdWant(S, b, n, l.pri);
      _aeHdTouch(b, n, hd.frame);
      if (!_aeHdReady(b, n)) {
        // A coarser tile that is not in yet does not take the finer ones drawn there away: they stay until it is.
        var kept = (held || (held = _aeHdDrawnUnder(b)))[n.key];
        if (kept) { kept.forEach(function (k) { draw[k.key] = k; _aeHdTouch(b, k, hd.frame); }); return; }
      }
      while (n && !_aeHdReady(b, n)) n = n.z ? _aeHdNode(b, n.z - 1, n.x >> 1, n.y >> 1) : null;
      if (n) draw[n.key] = n;
      else b.holes++;
    });
    if (hd.ahead) _aeHdWantAhead(S, b, hd.ahead);
    // (An ancestor that stands in for a tile not in yet is drawn under the finer ones of its neighbours and the ones held over it: finer last, AE_HD_Z_ORDER.)
    b.drawn.forEach(function (n) { if (!draw[n.key] && n.mesh) n.mesh.visible = false; });
    b.drawn = [];
    for (var k in draw) {
      var n = draw[k];
      _aeHdMesh(S, b, n).visible = true;
      _aeHdTouch(b, n, hd.frame);
      b.drawn.push(n);
    }
    if (_ae.target === b.key && !_ae.fly) _aeHdKeepAbove(S, b);
  });
  _aeHdPump(S);
  _aeHdUpload(S);
  _aeHdEvict(S);
}
// Decoded tiles reach the GPU a few a frame, in the order they came (three would upload each at the first frame that
// draws it, all together): the pictures are already decoded off the main thread (createImageBitmap).
function _aeHdUpload(S) {
  var hd = S.hd, left = AE_HD_UPLOADS;
  while (left-- > 0 && hd.fresh.length) {
    var tx = hd.fresh.shift();
    if (S.renderer.initTexture) S.renderer.initTexture(tx);
  }
  if (hd.fresh.length) _aeRedraw();
}
// ── The planets and their big moons ──
// Each planet stands in its true direction from the Sun, lit by it, at its true size, but nearer to it, as the Sun is
// drawn nearer the Earth: at the Almanac's one squeeze of its distance (_aeShownDist, the 2D orrery's radii). The Earth, at 1 AU, lands where it is, at the middle; the orbits stay round the Sun, the belt a ring; Neptune
// at 30 AU stands under 8,000 Earth radii from the Sun, so a flight between any two takes seconds. Seen from the
// Earth a planet is near, not exactly on, its place in the sky (the live sky has that); its phase is its own. Moons stand round their planet at their true distance. Tap one, or its
// name, to fly there. Maps: NASA, USGS and JPL mosaics (public domain); Saturn, Uranus and Neptune from Solar System
// Scope (CC BY 4.0), credited on the view. Saturn's rings are its measured radial structure, with the planet's shadow
// on them and theirs on it.
var AE_PLANET_DIST_POW = 0.4;          // the squeeze where the Almanac's own (almanac.js _solarSqueeze) is not loaded
// A distance from the Sun (AU) as drawn (Earth radii): the Almanac's one squeeze, the orrery's, scaled so the Earth's
// 1 AU is the Sun's drawn distance (the Earth stays at the middle).
var _aeSqueezeAtOne = 0;   // the squeeze at one AU: a constant, asked for in the thousands while flying
function _aeShownDist(au) {
  if (typeof _solarSqueeze === 'function') return AE_SUN_SHOW_DIST * _solarSqueeze(au) / (_aeSqueezeAtOne || (_aeSqueezeAtOne = _solarSqueeze(1)));
  return AE_SUN_SHOW_DIST * Math.pow(au, AE_PLANET_DIST_POW);
}
var AE_PLANETS_OUTER_AU = 30.5;        // Neptune's farthest: what the Planets overview fits
var AE_ORBIT_POINTS = 180, AE_ORBIT_REDRAW_DAYS = 30;
// A planet's orbit is drawn in fine steps about where the planet is: 2-degree steps showed as corners where the line
// runs past the camera (Earth's orbit beside the Moon). AE_ORBIT_FINE_POINTS steps across AE_ORBIT_FINE_SHARE of the
// orbit centred on the planet (Earth: 3.7 days either side, 0.08 degrees a step), drawn again once the planet has
// gone a quarter of that, so it never leaves the fine stretch.
var AE_ORBIT_FINE_POINTS = 96, AE_ORBIT_FINE_SHARE = 0.02;
var AE_PLANET_ORBIT_POINTS = AE_ORBIT_POINTS + AE_ORBIT_FINE_POINTS;
var AE_PLANET_ORBIT_COLOR = 0x9aa8c8, AE_PLANET_ORBIT_ALPHA = 0.32;
var AE_PLANET_SEGMENTS = [64, 32];
var AE_PLANET_MAP_MIN_PX = 3;          // a disc smaller than this (radius) is its mark; its map is asked for past it
var AE_PLANET_CREDIT_PX = 12;          // a map is credited once its disc shows it (a few pixels of Saturn is not Saturn's map)
var AE_PLANET_MIN_RADII = 1.3, AE_PLANET_FIT = 1.5;
var AE_RING_SEGMENTS = 160;
var AE_THREE_DOUBLE_SIDE = 2;          // three's DoubleSide and BackSide, not exported by name by the tree-shaken build
var AE_THREE_BACK_SIDE = 1;
var AE_THREE_ADDITIVE_BLENDING = 2;
var AE_SITE_LAMP_SUN = [0, 0.12];       // the rover headlights fade out as the Sun's sine of height goes over this
// IAU WGCCRE 2015 poles and turning (J2000 equatorial; W0 at J2000 and Wd a day, degrees).
var AE_PLANETS = [
  { key: 'mercury', eph: 'Mercury', km: 2439.7, map: 'mercury', color: [0.69, 0.63, 0.56], pole: [281.0103, 61.4155, 329.5988, 6.1385108] },
  { key: 'venus', eph: 'Venus', km: 6051.8, map: 'venus', color: [0.91, 0.78, 0.48], atmo: [1, 0.82, 0.5], pole: [272.76, 67.16, 160.20, -1.4813688] },
  { key: 'mars', eph: 'Mars', km: 3396.2, flat: 0.00589, map: 'mars', color: [0.77, 0.38, 0.25], atmo: [0.9, 0.55, 0.4], whiteFill: true, pole: [317.269202, 54.432516, 176.049863, 350.891982443297] },
  { key: 'jupiter', eph: 'Jupiter', ccHd: true, km: 71492, flat: 0.06487, map: 'jupiter', color: [0.77, 0.6, 0.41], pole: [268.056595, 64.495303, 284.95, 870.536] },
  { key: 'saturn', eph: 'Saturn', ccHd: true, km: 60268, flat: 0.09796, map: 'saturn', color: [0.83, 0.72, 0.47], pole: [40.589, 83.537, 38.90, 810.7939024], rings: [74500, 140220], cc: true },
  { key: 'uranus', eph: 'Uranus', km: 25559, flat: 0.0229, map: 'uranus', color: [0.47, 0.78, 0.78], atmo: [0.5, 0.85, 0.9], pole: [257.311, -15.175, 203.81, -501.1600928], cc: true },
  { key: 'neptune', eph: 'Neptune', km: 24764, flat: 0.0171, map: 'neptune', color: [0.22, 0.41, 0.78], atmo: [0.3, 0.45, 1], pole: [299.36, 43.46, 249.978, 541.1397757], cc: true },
  // The dwarf planets the probes visited, from the Horizons table (space-tracks-v1.json) while it covers the date.
  { key: 'pluto', eph: 'Pluto', track: 'planets', km: 1188.3, map: 'pluto', color: [0.78, 0.72, 0.66], pole: [132.993, -6.163, 302.695, 56.3625225] },
  { key: 'ceres', eph: 'Ceres', track: 'tracks', trackKey: 'ceres', km: 469.7, map: 'ceres', color: [0.63, 0.6, 0.56], pole: [291.418, 66.764, 170.65, 952.1532] },
  { key: 'vesta', eph: 'Vesta', track: 'tracks', trackKey: 'vesta', km: 262.7, map: 'vesta', color: [0.6, 0.58, 0.55], pole: [309.031, 42.235, 285.39, 1617.3331] },
  // The big moons' mean circular orbits (scripts/fit_moon_orbits.py, against JPL Horizons 1990-2060): radius km,
  // longitude in the planet's equator at J2000 from the node of that equator on the ecliptic, degrees a day.
  { key: 'io', parent: 'jupiter', km: 1821.6, map: 'io', color: [0.91, 0.85, 0.44], orbit: [421769, 40.361, 203.488958] },
  { key: 'europa', parent: 'jupiter', km: 1560.8, map: 'europa', color: [0.85, 0.81, 0.75], orbit: [671090, 234.918, 101.374724] },
  { key: 'ganymede', parent: 'jupiter', km: 2634.1, map: 'ganymede', color: [0.66, 0.63, 0.58], orbit: [1070432, 242.196, 50.317608] },
  { key: 'callisto', parent: 'jupiter', km: 2410.3, map: 'callisto', color: [0.49, 0.45, 0.41], orbit: [1882794, 101.383, 21.571073] },
  { key: 'titan', parent: 'saturn', km: 2574.7, map: 'titan', color: [0.85, 0.65, 0.31], atmo: [1, 0.65, 0.2], orbit: [1222375, 327.598, 22.576976] },
  // The small moons, with the same fit (scripts/fit_moon_orbits.py; worst miss in degrees over 1990-2060 beside each).
  { key: 'mimas', parent: 'saturn', km: 198.2, map: 'mimas', color: [0.78, 0.78, 0.77], orbit: [185572, 120.969, 381.994386] },   // 46.8: its swing against Tethys (a resonance) outruns a mean orbit
  { key: 'enceladus', parent: 'saturn', km: 252.1, map: 'enceladus', color: [0.92, 0.94, 0.96], orbit: [238038, 142.287, 262.731899] },   // 1.0
  { key: 'tethys', parent: 'saturn', km: 531.1, map: 'tethys', color: [0.8, 0.8, 0.78], orbit: [294673, 148.408, 190.697916] },   // 2.2
  { key: 'dione', parent: 'saturn', km: 561.4, map: 'dione', color: [0.78, 0.78, 0.76], orbit: [377416, 136.952, 131.53493] },   // 0.3
  { key: 'rhea', parent: 'saturn', km: 763.8, map: 'rhea', color: [0.74, 0.74, 0.72], orbit: [527068, 12.214, 79.690046] },   // 0.1
  { key: 'iapetus', parent: 'saturn', km: 734.5, map: 'iapetus', color: [0.55, 0.5, 0.45], orbit: [3562324, 49.952, 4.537947] },   // 4.2
  { key: 'triton', parent: 'neptune', km: 1353.4, map: 'triton', color: [0.78, 0.74, 0.7], orbit: [354759, 94.748, -61.25726] },   // 2.4, retrograde
  { key: 'charon', parent: 'pluto', km: 606, map: 'charon', color: [0.62, 0.6, 0.58], orbit: [19596, 321.235, 56.362531] },   // 0.0
  { key: 'phobos', parent: 'mars', km: 11.1, map: 'phobos', color: [0.42, 0.38, 0.35], orbit: [9376, 172.311, 1128.844929] }   // 2.8
];
// Saturn's rings outward from the planet (km): alpha and brightness. C ring faint, B bright, the Cassini Division
// nearly empty, the A ring between, the Encke gap near its edge.
var AE_RING_SHALLOW = 0.7;   // the share of its light the lit face of the rings keeps with the Sun at the ring plane's edge
var AE_RING_PROFILE = [
  [74500, 92000, 0.12, 0.55], [92000, 117500, 0.82, 0.95], [117500, 122200, 0.05, 0.6],
  [122200, 133300, 0.55, 0.85], [133300, 133700, 0.06, 0.6], [133700, 136800, 0.5, 0.8], [136800, 140220, 0.07, 0.6]
];
// The Viking colour mosaic Mars's maps come from wrote every pixel that clipped (caldera walls, scarps, polar ice) as one
// fill colour, an icy blue: too bright to measure is white, so the shader lays white over it, and over the rim where the
// fill was blended into its neighbours only the blue cast goes (to a grey of the pixel's own brightness). The tiles built
// before the build did the same still carry the fill, so this reads right for both.
var AE_FILL_RGB = [207, 231, 255], AE_FILL_WHITE_NEAR = 14, AE_FILL_CAST_NEAR = 70;
var AE_PLANET_FRAG = [
  'precision highp float;',
  'uniform sampler2D map; uniform float mapped; uniform vec3 color; uniform vec3 sunDir; uniform vec3 atmo; uniform float dim; uniform float whiteFill;',
  'vec3 whitenFill(vec3 c) {',
  '  float d = distance(c * 255.0, vec3(' + AE_FILL_RGB.map(_aeGlslNum).join(', ') + '));',
  '  float grey = dot(c, vec3(0.299, 0.587, 0.114));',
  '  vec3 to = vec3(mix(1.0, grey, smoothstep(0.0, ' + _aeGlslNum(AE_FILL_WHITE_NEAR) + ', d)));',
  '  return mix(c, to, whiteFill * (1.0 - smoothstep(6.0, ' + _aeGlslNum(AE_FILL_CAST_NEAR) + ', d)));',
  '}',
  'uniform float rings; uniform vec3 ringN; uniform vec3 center; uniform vec2 ringR; uniform sampler2D ringMap;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView; varying vec3 vRel;',
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  float ndl = dot(N, sunDir);',
  '  vec3 base = mapped > 0.5 ? whitenFill(texture2D(map, vUv).rgb) : color;',
  '  float light = max(ndl, 0.0);',
  // The rings' shadow: the line from here toward the Sun crosses the ring plane inside the rings.
  '  if (rings > 0.5) {',
  '    float den = dot(sunDir, ringN);',
  '    float t = abs(den) > 1e-5 ? -dot(vRel, ringN) / den : -1.0;',
  '    if (t > 0.0) {',
  '      float u = (length(vRel + sunDir * t) - ringR.x) / (ringR.y - ringR.x);',
  '      if (u > 0.0 && u < 1.0) light *= 1.0 - 0.9 * texture2D(ringMap, vec2(u, 0.5)).a;',
  '    }',
  '  }',
  '  vec3 V = normalize(vView);',
  '  vec3 col = base * (light * 0.96 + 0.03);',
  '  col += atmo * pow(1.0 - max(dot(N, V), 0.0), 3.0) * (0.1 + 0.9 * smoothstep(-0.1, 0.3, ndl)) * 0.6;',
  '  gl_FragColor = vec4(col * dim, 1.0);',
  '}'
].join('\n');
// The rings: their profile by radius, lit on the Sun's side and through from behind (they scatter forward), dark in
// the planet's shadow.
var AE_RING_FRAG = [
  'precision highp float;',
  'uniform sampler2D ringMap; uniform vec2 ringR; uniform vec3 sunDir; uniform vec3 center; uniform float radius; uniform vec3 ringN; uniform float dim;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView; varying vec3 vRel;',
  'void main() {',
  '  float u = (length(vRel) - ringR.x) / (ringR.y - ringR.x);',
  '  if (u < 0.0 || u > 1.0) discard;',
  '  vec4 p = texture2D(ringMap, vec2(u, 0.5));',
  '  vec3 toC = -vRel;',
  '  float b = dot(toC, sunDir);',
  '  float miss = sqrt(max(0.0, dot(toC, toC) - b * b));',
  '  float shade = (b > 0.0 && miss < radius) ? 0.08 : 1.0;',
  '  vec3 V = normalize(vView);',
  '  float sameSide = step(0.0, dot(ringN, sunDir) * dot(ringN, V));',
  // Their particles scatter, so a shallow Sun dims them far less than a flat sheet's cosine (which left them charcoal near edge-on).
  '  float lit = mix(0.35, 1.0, sameSide) * (' + _aeGlslNum(AE_RING_SHALLOW) + ' + (1.0 - ' + _aeGlslNum(AE_RING_SHALLOW) + ') * abs(dot(ringN, sunDir)));',
  '  gl_FragColor = vec4(p.rgb * lit * 1.6 * shade * dim, p.a);',
  '}'
].join('\n');
function _aePlanetBody(key) { for (var i = 0; i < AE_PLANETS.length; i++) if (AE_PLANETS[i].key === key) return AE_PLANETS[i]; return null; }
function _aeIsPlanet(key) { return !!_aePlanetBody(key); }
function _aePlanetMapUrl(b) { return _almAsset('/static/earth/' + b.map + '-v1.webp'); }
// Each planet and moon becomes a place the view knows: a target to circle, a mark with its name. Once, before the
// view's markup is built (the marks are made from AE_MARKED).
var _aePlanetsKnown = false;
function _aeKnowPlanets() {
  if (_aePlanetsKnown) return;
  _aePlanetsKnown = true;
  AE_PLANETS.forEach(function (b) {
    b.r = b.km / AE_EARTH_RADIUS_KM;
    AE_TARGETS[b.key] = { min: b.r * AE_PLANET_MIN_RADII, max: AE_MAX_DIST, surface: b.r };
    AE_MARKED.push({ body: b.key, name: function () { return _aeBodyName(b); } });
  });
}
function _aeRingCanvas() {
  var w = 256, cv = document.createElement('canvas');
  cv.width = w; cv.height = 1;
  var g = cv.getContext('2d'), lo = AE_RING_PROFILE[0][0], hi = AE_RING_PROFILE[AE_RING_PROFILE.length - 1][1];
  for (var x = 0; x < w; x++) {
    var km = lo + (hi - lo) * (x + 0.5) / w, row = AE_RING_PROFILE[AE_RING_PROFILE.length - 1];
    for (var i = 0; i < AE_RING_PROFILE.length; i++) if (km < AE_RING_PROFILE[i][1]) { row = AE_RING_PROFILE[i]; break; }
    var ripple = 0.88 + 0.12 * Math.sin(km / 160), v = row[3] * ripple;
    g.fillStyle = 'rgba(' + Math.round(235 * v) + ',' + Math.round(215 * v) + ',' + Math.round(180 * v) + ',' + (row[2] * ripple).toFixed(3) + ')';
    g.fillRect(x, 0, 1, 1);
  }
  return cv;
}
// A flat annulus in a body's xy plane (its equator), radii in its own units: three's RingGeometry is not in the build.
function _aeRingGeometry(THREE, rin, rout, segs) {
  var pos = new Float32Array((segs + 1) * 6), idx = [];
  for (var i = 0; i <= segs; i++) {
    var a = i / segs * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    pos.set([c * rin, sn * rin, 0, c * rout, sn * rout, 0], i * 6);
    if (i < segs) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array((segs + 1) * 6).fill(0).map(function (v, k) { return k % 3 === 2 ? 1 : 0; }), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((segs + 1) * 4), 2));
  g.setIndex(idx);
  return g;
}
// A planet's sphere (AE_PLANET_FRAG, on geo, `radius` across) and its rings when it has them, sharing one set of uniforms;
// ringMap is the ring texture's slot every planet shares.
function _aePlanetMesh(THREE, b, geo, radius, sunDir, ringMap) {
  var uni = {
    map: { value: null }, mapped: { value: 0 }, color: { value: b.color }, sunDir: { value: sunDir },
    atmo: { value: b.atmo || [0, 0, 0] }, dim: { value: 1 }, whiteFill: { value: b.whiteFill ? 1 : 0 }, rings: { value: b.rings ? 1 : 0 }, ringN: { value: new THREE.Vector3(0, 0, 1) },
    center: { value: new THREE.Vector3() }, ringR: { value: [0, 1] }, ringMap: ringMap
  };
  var mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_PLANET_FRAG })), ring = null;
  mesh.matrixAutoUpdate = false;
  if (b.rings) {
    var ringUni = { ringMap: ringMap, ringR: uni.ringR, sunDir: uni.sunDir, center: uni.center, radius: { value: radius }, ringN: uni.ringN, dim: uni.dim };
    ring = new THREE.Mesh(_aeRingGeometry(THREE, b.rings[0] / b.km * radius, b.rings[1] / b.km * radius, AE_RING_SEGMENTS),
      new THREE.ShaderMaterial({ uniforms: ringUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_RING_FRAG, transparent: true, depthWrite: false, side: AE_THREE_DOUBLE_SIDE }));
    ring.matrixAutoUpdate = false;
  }
  return { uni: uni, mesh: mesh, ring: ring };
}
function _aeBuildPlanets(S) {
  _aeKnowPlanets();
  var THREE = S.THREE;
  var ringMap = { value: null };   // drawn from AE_RING_PROFILE the first time Saturn is near enough to show
  S.planets = {};
  AE_PLANETS.forEach(function (b) {
    var geo = new THREE.SphereGeometry(b.r, AE_PLANET_SEGMENTS[0], AE_PLANET_SEGMENTS[1]);
    geo.rotateX(Math.PI / 2);
    var pm = _aePlanetMesh(THREE, b, geo, b.r, new THREE.Vector3(1, 0, 0), ringMap), mesh = pm.mesh, uni = pm.uni;
    mesh.visible = false;
    S.scene.add(mesh);
    var p = { b: b, mesh: mesh, uni: uni, pos: [0, 0, 0], sun: [1, 0, 0], frame: null, asked: false };
    if (pm.ring) {
      uni.ringR.value = [b.rings[0] / AE_EARTH_RADIUS_KM, b.rings[1] / AE_EARTH_RADIUS_KM];
      p.ring = pm.ring;
      p.ring.visible = false;
      S.scene.add(p.ring);
    }
    if (!b.parent && typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]) {
      p.orbit = _aeLine(THREE, THREE.LineLoop, AE_PLANET_ORBIT_POINTS, AE_PLANET_ORBIT_COLOR, AE_PLANET_ORBIT_ALPHA);
      p.period = _aeYearDays(b.eph);
      S.scene.add(p.orbit);
    } else if (b.parent) {
      // A moon's orbit round its planet, drawn when the row's Orbits is on.
      p.orbit = _aeLine(THREE, THREE.LineLoop, AE_ORBIT_POINTS, AE_PLANET_ORBIT_COLOR, AE_PLANET_ORBIT_ALPHA);
      p.orbit.visible = false;
      S.scene.add(p.orbit);
    }
    S.planets[b.key] = p;
  });
  // The Earth is not one of AE_PLANETS (it is the scene's own globe), but its year round the Sun is a line like theirs.
  S.earthOrbit = { b: { key: 'earth', eph: 'Earth' }, orbit: _aeLine(THREE, THREE.LineLoop, AE_PLANET_ORBIT_POINTS, AE_PLANET_ORBIT_COLOR, AE_PLANET_ORBIT_ALPHA), period: _aeYearDays('Earth') };
  S.scene.add(S.earthOrbit.orbit);
}
// A planet's path round the Sun, as shown: a year of its own, redrawn when the shown date has moved a month.
function _aeWideView() { return _ae.preset === 'planets' || _ae.target === 'sun'; }
// Orbits, a round switch (kept with the person): off (the default), a flight shows the orbits of the bodies it involves
// (where it left, where it goes, and their systems) while it flies, fading out shortly after it lands; on, those of the
// body in view and its system stay. The Planets view and Side by side always show the planets' orbits.
var AE_ORBITS_KEY = SK.ALM_ORBITS, AE_ORBITS_ON = 'always', AE_ORBITS_FADE_MS = 1500;
// The orbit lines, the landmarks layer or the settings panel changed underneath the view (almanac.js
// _almPrefsApplied): drawn again from storage.
function _aePrefsApplied(keys) {
  if (keys.indexOf(AE_SPIN_FACES_KEY) >= 0 && _ae && _ae.spin) _aeSpinMarkFaces();
  if (keys.indexOf(AE_ORBITS_KEY) < 0 && keys.indexOf(AE_LM_LAYER_KEY) < 0) return;
  _aeOrbitsKept = null;
  if (keys.indexOf(AE_LM_LAYER_KEY) >= 0 && _aeLmLayerOn()) _aeLmLoad();
  if (_ae) { _aeRedraw(); _aeMarkToggles(); }
}
// Read once and kept: every orbit line asks every frame. A change here or from elsewhere (_aePrefsApplied) drops it.
var _aeOrbitsKept = null;
function _aeOrbitsOn() {
  if (_aeOrbitsKept === null) _aeOrbitsKept = _rawGet(AE_ORBITS_KEY) === AE_ORBITS_ON;
  return _aeOrbitsKept;
}
function _aeHostOf(k) { var b = _aePlanetBody(k); return b ? b.parent || b.key : k === 'moon' || k === 'iss' || _aeIsOrbiter(k) ? 'earth' : k; }
// How much of an orbit line shows now, 0..1, for every line the scene draws: `key` a planet (its path round the Sun),
// a moon (round its planet), a probe (its path and ellipse), or 'moon' for the Earth's own (the Moon's path, the GPS
// and station rings). Off is off everywhere, the Planets view too (the minimap keeps its own little rings).
function _aeOrbitShow(key) { return _aeOrbitShowRaw(key) * _aeSunLineFade(); }   // (in transit they always show: only the satellites' web fades, _aeTransitK)
// Close to the Sun its disc fills the view and the orbit lines (and the trails) cross it edge-on as thin white strokes:
// they are a far-view aid, out before the Sun fills the screen, never drawn over its disc.
var AE_SUN_LINES_GONE = 24, AE_SUN_LINES_FULL = 60;   // the Sun's radii from it: the Sun's own view (about 17) has none, the Planets view (hundreds) all
// The Moon seen from a few kilometres up: the base sphere's facets (5.6 degrees, 170 km chords) lie up to 2 km inside the true
// surface, so a camera 1.3 km up is below the plane of the facet under it and sees a flat slab with a hard edge. Near the
// surface the Moon is drawn from a finer sphere (0.7 degree facets, 130 m inside), built when first needed and put back
// when the camera goes away; the HD tiles' own meshes are finer still and take over where they are.
var AE_MOON_FINE_SEGMENTS = [512, 256], AE_MOON_FINE_ALT_KM = 300, AE_MOON_COARSE_ALT_KM = 600;
function _aeMoonMesh(S, sc) {
  var e = S.moon.matrixWorld.elements, cam = S.camera.position;
  var altKm = (Math.hypot(cam.x - e[12], cam.y - e[13], cam.z - e[14]) - AE_MOON_RADIUS_RE) * AE_EARTH_RADIUS_KM;
  if (!S.moonCoarse) S.moonCoarse = S.moon.geometry;
  if (altKm < AE_MOON_FINE_ALT_KM && S.moon.geometry === S.moonCoarse) {
    if (!S.moonFine) S.moonFine = new S.THREE.SphereGeometry(AE_MOON_RADIUS_RE, AE_MOON_FINE_SEGMENTS[0], AE_MOON_FINE_SEGMENTS[1]);
    S.moon.geometry = S.moonFine;
  } else if (altKm > AE_MOON_COARSE_ALT_KM && S.moon.geometry !== S.moonCoarse) {
    S.moon.geometry = S.moonCoarse;
  }
}
// The same for a planet or moon: its 64 x 32 sphere is 5.6 degree facets, and low over one (the craft at Uranus's cloud deck) the
// limb shows a corner. Within AE_PLANET_FINE_ALT of its radius the nearest one is drawn from a fine sphere (one kept, for one body
// at a time), and the coarse one is put back past AE_PLANET_COARSE_ALT.
var AE_PLANET_FINE_SEGMENTS = [384, 192], AE_PLANET_FINE_ALT = 0.25, AE_PLANET_COARSE_ALT = 0.4;   // altitudes in the body's radii
function _aePlanetFine(S) {
  var cam = S.camera.position, fine = S.planetFine, best = null, bestAlt = Infinity;
  for (var k in S.planets) {
    var p = S.planets[k];
    if (!p.mesh.visible) continue;
    var e = p.mesh.matrixWorld.elements, alt = Math.hypot(cam.x - e[12], cam.y - e[13], cam.z - e[14]) / p.b.r - 1;
    if (alt < bestAlt) { bestAlt = alt; best = p; }
  }
  if (fine && (fine.p !== best || bestAlt > AE_PLANET_COARSE_ALT)) {
    fine.p.mesh.geometry = fine.coarse;
    fine.geo.dispose();
    S.planetFine = fine = null;
  }
  if (!fine && best && bestAlt < AE_PLANET_FINE_ALT) {
    var geo = new S.THREE.SphereGeometry(best.b.r, AE_PLANET_FINE_SEGMENTS[0], AE_PLANET_FINE_SEGMENTS[1]);
    geo.rotateX(Math.PI / 2);   // (as the coarse one: _aeBuildPlanets)
    S.planetFine = { p: best, geo: geo, coarse: best.mesh.geometry };
    best.mesh.geometry = geo;
  }
}
function _aeSunLineFade() {
  if (_ae.target !== 'sun') return 1;
  return _aeClamp((_ae.dist / AE_SUN_SHOW_R - AE_SUN_LINES_GONE) / (AE_SUN_LINES_FULL - AE_SUN_LINES_GONE), 0, 1);
}
function _aeOrbitShowRaw(key) {
  var b = _aePlanetBody(key);
  // The Planets view is a map of the orbits: the planets' always show there, whatever the setting (Eric: Off hiding them
  // there "is dumb"); the moons' never (they are drawn on their planets). The setting governs the scene near a body.
  if (_aeWideView()) return (b && !b.parent) || key === 'earth' ? 1 : 0;
  var host = _aeHostOf(key);
  var mine = function (k) { return !!k && (k === key || _aeHostOf(k) === host); };
  // A flight shows the planets' own paths round the Sun too, wherever it goes (the map the camera is crossing), as well as the lines of the bodies it leaves and reaches.
  var o = _ae.orbitFly, flying = !!o && (mine(o.from) || mine(o.to) || (!!b && !b.parent) || key === 'earth');
  if (_aeOrbitsOn() && mine(_ae.target)) return 1;
  if (!flying) return 0;
  // While flying means while a flight is on: one that ended any other way (a drag, a follow, another preset) starts its
  // fade the moment no flight is running, so the lines never stay.
  if (!o.endAt) { if (_ae.fly) return 1; o.endAt = performance.now(); }
  return _aeClamp(1 - (performance.now() - o.endAt) / AE_ORBITS_FADE_MS, 0, 1);
}
function _aeDrawOrbit(p, jd, around, sunAt) {
  if (!p || !p.orbit) return;
  p.orbit.position.set(sunAt[0], sunAt[1], sunAt[2]);   // the line is round the Sun, wherever the Sun is drawn this frame
  // The Planets view always, elsewhere by the setting (near a body an orbit runs past the camera as a line, so it is
  // not there unasked). They are still worked out, for the minimap.
  var held = _aeOrbitShow(p.b.key), wanted = held > 0 || (_ae.target !== 'earth' && _ae.target !== 'moon');
  p.orbit.material.opacity = AE_PLANET_ORBIT_ALPHA * held * _aeFadeU.value;
  p.orbit.visible = held > 0;
  var redraw = Math.min(AE_ORBIT_REDRAW_DAYS, p.period * AE_ORBIT_FINE_SHARE / 4);
  if (!wanted || (p.orbitAt != null && Math.abs(jd - p.orbitAt) < redraw) || !_aeMayRedraw()) return;
  p.orbitAt = jd;
  var arr = p.orbit.geometry.attributes.position.array, days = _aeOrbitDays(p.period);
  for (var k = 0; k < days.length; k++) {
    var q = around(_ephBodyJ2000(p.b.eph, jd + days[k]));
    arr[k * 3] = q[0]; arr[k * 3 + 1] = q[1]; arr[k * 3 + 2] = q[2];
  }
  p.orbit.geometry.attributes.position.needsUpdate = true;
  p.orbit.geometry.setDrawRange(0, days.length);
}
// The days from now an orbit is drawn through, once round in order: fine steps across the stretch centred on now,
// then the 2-degree steps for the rest of the way. Always AE_PLANET_ORBIT_POINTS of them.
function _aeOrbitDays(period) {
  var half = period * AE_ORBIT_FINE_SHARE / 2, fine = 2 * half / AE_ORBIT_FINE_POINTS, out = [], k;
  for (k = 0; k < AE_ORBIT_FINE_POINTS; k++) out.push(-half + k * fine);
  for (k = 0; k < AE_ORBIT_POINTS; k++) out.push(half + (period - 2 * half) * k / AE_ORBIT_POINTS);
  return out;
}
// A moon's orbit: a circle in its planet's equator (the orbits are fitted as circles), round where the planet is now.
// Shown by the Orbits setting (_aeOrbitShow).
function _aeDrawMoonOrbit(p, b, centre, ax, ay, r, toScene) {
  var show = _aeOrbitShow(b.key);
  p.orbit.visible = show > 0;
  if (!(show > 0)) return;
  p.orbit.material.opacity = AE_PLANET_ORBIT_ALPHA * show * _aeFadeU.value;
  var arr = p.orbit.geometry.attributes.position.array;
  for (var k = 0; k < AE_ORBIT_POINTS; k++) {
    var a = 2 * Math.PI * k / AE_ORBIT_POINTS, q = _aeAdd(centre, _aeScale(toScene(_aeAdd(_aeScale(ax, Math.cos(a)), _aeScale(ay, Math.sin(a)))), r));
    arr[k * 3] = q[0]; arr[k * 3 + 1] = q[1]; arr[k * 3 + 2] = q[2];
  }
  p.orbit.geometry.attributes.position.needsUpdate = true;
  p.orbit.geometry.setDrawRange(0, AE_ORBIT_POINTS);
}
// A body's axes in the J2000 ecliptic at jd: x toward its prime meridian on its equator, z its north pole.
function _aeEqToEclJ2000(v) {
  var e = _aeRad(EPH_OBLIQUITY_DEG), c = Math.cos(e), sn = Math.sin(e);
  return [v[0], c * v[1] + sn * v[2], -sn * v[1] + c * v[2]];
}
function _aePlanetFrameEcl(b, jd) {
  var ra = _aeRad(b.pole[0]), dec = _aeRad(b.pole[1]);
  var z = _aeEqToEclJ2000(_aeEqVec(ra, dec, 1));
  var node = _aeEqToEclJ2000([-Math.sin(ra), Math.cos(ra), 0]);
  var w = _aeRad(_aeNormDeg(b.pole[2] + b.pole[3] * (jd - JD_J2000)));
  var perp = _aeCross(z, node);
  var x = _aeAdd(_aeScale(node, Math.cos(w)), _aeScale(perp, Math.sin(w)));
  return { x: x, y: _aeCross(z, x), z: z };
}
// Where each planet and moon stands this frame (scene units: Earth radii, equator of date) and its turn and light.
function _aeUpdatePlanets(sc) {
  var S = _ae.gl;
  if (!S || !S.planets || typeof _ephBodyJ2000 !== 'function' || typeof _planetHelio3D !== 'function' || typeof _jdToJulianCentury !== 'function') return;   // the orrery's elements (almanac-orrery.js)
  var jd = sc.ms / MS_PER_DAY + JD_UNIX_EPOCH, jde = jd + _aeDeltaTDays(jd);
  var toScene = function (v) { return _ephEclJ2000ToEqOfDate(v, jde); };
  var helio = {}, sunAt = _aeSunShown(sc);
  S.ecl = { sun: sunAt, x: _aeNorm(toScene([1, 0, 0])), z: _aeNorm(toScene([0, 0, 1])) };
  // `around`: where a heliocentric place is drawn from the Sun. Whatever is kept for more than a frame (an orbit line, the
  // belt) is stored this way and carried to the Sun each frame: the Sun swings round the Earth a degree a day, and a
  // line stored beside where the Sun was left the planets behind as the date ran.
  var around = function (h) { return _aeScale(_aeNorm(toScene(h)), _aeShownDist(_aeLen(h))); };
  var place = function (h) { return _aeAdd(sunAt, around(h)); };
  _aeRedrawsLeft = AE_REDRAWS_PER_FRAME;
  _aeUpdateAsteroids(jde, around, sunAt);
  // A probe near a planet stands at its true distance from it, as the moons do (the drawn scale squeezes space round
  // a planet tens of times: Juno would orbit inside Jupiter, Webb inside the GPS shell): within a planet's reach it
  // goes from the scale's place to the planet's own frame, all the way in by half that reach.
  var earthH = _ephBodyJ2000('Earth', jd);
  var near = [{ key: 'earth', h: earthH, at: [0, 0, 0], reach: AE_PROBE_REACH_AU.earth, hAt: function (t) { return _ephBodyJ2000('Earth', t); } }];
  var placeNear = function (h) {
    var out = place(h);
    for (var i = 0; i < near.length; i++) {
      var d = _aeSub(h, near[i].h), dl = _aeLen(d), w = _smoothstep(near[i].reach, near[i].reach / 2, dl);
      if (w > 0) out = _aeLerp3(out, _aeAdd(near[i].at, _aeScale(toScene(d), AU_KM / AE_EARTH_RADIUS_KM)), w);
    }
    return out;
  };
  if (_aeTracksNeeded()) _aeTracksLoad();

  var cam = S.camera, eye = _aeXyz(cam.position);
  var pxPerRad = _aePxPerRad(cam);
  // The Earth stands at the middle while the Sun is drawn a fixed distance off (AE_SUN_SHOW_DIST) whatever the season, but the
  // line's radius squeezes the Earth's true distance (0.983 to 1.017 AU): carried to the Sun it ran tens of Earth radii off the
  // Earth, a long thin line beside it. So it is carried to the Earth instead: it runs through her, and the Moon's ring round her.
  if (S.earthOrbit) _aeDrawOrbit(S.earthOrbit, jd, around, _aeScale(around(earthH), -1));
  AE_PLANETS.forEach(function (b) {
    var p = S.planets[b.key], f, pos, sun;
    if (!b.parent) {
      var h = helio[b.key] = b.track ? _aeTracked(b, jd) : _ephBodyJ2000(b.eph, jd);
      if (!h) { p.pos = null; p.mesh.visible = false; return; }   // a dwarf before its table has come, or past its years
      pos = place(h);
      if (AE_PROBE_REACH_AU[b.key]) near.push({ key: b.key, h: h, at: pos, reach: AE_PROBE_REACH_AU[b.key], hAt: _aeHelioOf(b) });
      _aeDrawOrbit(S.planets[b.key], jd, around, sunAt);
      sun = _aeNorm(toScene(_aeScale(h, -1)));
      f = _aePlanetFrameEcl(b, jd);
    } else {
      var par = S.planets[b.parent], pb = par.b, o = b.orbit;
      if (!par.pos) { p.pos = null; p.mesh.visible = false; return; }   // its planet is a dwarf whose table has not come (Pluto, for Charon)
      var pole = _aePlanetFrameEcl(pb, jd).z, ax = _aeNorm(_aeCross([0, 0, 1], pole)), ay = _aeCross(pole, ax);
      var lam = _aeRad(o[1] + o[2] * (jd - JD_J2000)), r = o[0] / AE_EARTH_RADIUS_KM;
      var off = _aeAdd(_aeScale(ax, Math.cos(lam)), _aeScale(ay, Math.sin(lam)));
      pos = _aeAdd(par.pos, _aeScale(toScene(off), r));
      sun = par.sun;
      _aeDrawMoonOrbit(p, b, par.pos, ax, ay, r, toScene);
      // Locked to its planet: its prime meridian faces the planet.
      var zz = toScene(pole), xx = _aeNorm(_aeScale(toScene(off), -1));
      f = { x: xx, y: _aeCross(zz, xx), z: zz, scene: true };
    }
    var x = f.scene ? f.x : toScene(f.x), y = f.scene ? f.y : toScene(f.y), z = f.scene ? f.z : toScene(f.z);
    p.pos = pos; p.sun = sun;
    var v = S.pv;   // its own: S.vz carries the Moon's pole to its relief
    v[0].set(x[0], x[1], x[2]); v[1].set(y[0], y[1], y[2]); v[2].set(z[0], z[1], z[2]);
    var m = p.mesh.matrix;
    m.makeBasis(v[0], v[1], v[2]);
    if (b.flat) { var e = m.elements; e[8] *= 1 - b.flat; e[9] *= 1 - b.flat; e[10] *= 1 - b.flat; }
    m.setPosition(pos[0], pos[1], pos[2]);
    p.mesh.matrixWorldNeedsUpdate = true;
    p.uni.sunDir.value.set(sun[0], sun[1], sun[2]);
    p.uni.center.value.set(pos[0], pos[1], pos[2]);
    p.uni.ringN.value.set(z[0], z[1], z[2]);
    p.uni.dim.value = _aeRedOn() ? AE_RED_EARTH_LIGHT : 1;
    if (p.ring) {
      p.ring.matrix.makeBasis(v[0], v[1], v[2]).setPosition(pos[0], pos[1], pos[2]);
      p.ring.matrixWorldNeedsUpdate = true;
    }
    var px = p.px = b.r / Math.max(1e-9, _aeLen(_aeSub(pos, eye))) * pxPerRad;
    var show = (px >= AE_PLANET_MAP_MIN_PX / 3 || _ae.target === b.key) && !_aeBehindAny(b.key, pos);
    p.mesh.visible = show;
    if (p.ring) p.ring.visible = show;
    var bound = !!_ae.orbitFly && _ae.orbitFly.to === b.key && !_ae.orbitFly.endAt;   // the flight's goal: its map is fetched while the way is crossed, not on arrival
    if (((show && px >= AE_PLANET_MAP_MIN_PX) || bound) && !p.asked) {
      p.asked = true;
      if (p.ring && !p.uni.ringMap.value) {
        _aeLoadTexture(S.THREE, _aeRingCanvas().toDataURL()).then(function (tx) { p.uni.ringMap.value = tx; _aeRedraw(); });
      }
      _aeLoadTexture(S.THREE, _aePlanetMapUrl(b)).then(function (tx) {
        if (_ae.gl !== S) { tx.dispose(); return; }
        tx.anisotropy = S.aniso;
        p.uni.map.value = tx;
        p.uni.mapped.value = 1;
        _aeRedraw();
      }, function () { p.asked = false; });
    }
  });
  S.placeNear = placeNear;   // this frame's: a mission's Sun-centred leg is drawn the probes' way (almanac-missions.js _amHelioRaw)
  _aeUpdateProbes(jd, placeNear, near);
}
// ── Planets side by side ──
// Mercury to Neptune in rows, each turning at its real sidereal rate (the IAU rotation AE_PLANETS places the maps by) for
// the shown date, which the time row runs: an hour a second shows Jupiter and the Earth spinning, Venus barely moving.
// Every planet stands in one frame, up the normal of its own orbit, so each tilt is drawn as it is to that orbit, leaning
// right: a thin line through the poles (the north end, the IAU pole the maps are placed by, as in the main view, in amber
// with an arrowhead) and a ring in the plane of its orbit. Seen from its arrowhead each planet turns counter-clockwise,
// except Venus and Uranus, which turn backwards (their spin vectors lie 177 and 98 degrees from the orbit's normal); the
// sense of every turn is the one seen from the north ecliptic pole. Sizes are true
// (equatorial radii), or the same for all; the rows are packed to make the planets biggest (_aeSpinLayout).
var AE_SPIN_KEY = 'spin';
var AE_SPIN_ORDER = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
// The Earth is not among AE_PLANETS (it has its own scene), so its pole and turn stand here in the same form: the pole on the
// celestial pole; W0 is Greenwich mean sidereal time at J2000.0 (280.46061837 degrees) less the 90 of the node; the rate is
// the mean sidereal one, 360.98564736629 degrees a day (23 h 56 min 4.09 s).
var AE_SPIN_EARTH = {
  key: 'earth', eph: 'Earth', km: AE_EARTH_RADIUS_KM, flat: AE_EARTH_FLATTENING, mapUrl: AE_TEX_DAY,
  color: [0.29, 0.56, 0.85], atmo: [0.35, 0.55, 1], pole: [0, 90, 190.46061837, 360.98564736629]
};
var AE_SPIN_SPEED = 3600;                // what the view starts at from real time: an hour a second
var AE_SPIN_ELEV_DEG = 20;               // the camera stands this far above every orbital plane
var AE_SPIN_CAM_DIST = 20000;            // px: far enough that the perspective camera is, for a sphere, an orthographic one
var AE_SPIN_SUN = [-0.35, 0.3, 0.89];    // the light, one for all, from the camera's side so the art shows whole
var AE_SPIN_NORMAL_DAYS = 2;             // an orbit's normal is the cross product of the planet's places this far either side
var AE_SPIN_AXIS_R = 1.45, AE_SPIN_PLANE_R = 1.3;   // the axis line's and the orbital-plane line's reach, in planet radii
var AE_SPIN_RING_PAD = 1.08, AE_SPIN_RING_TILT = 0.75;   // the plane line beyond Saturn's rings; their share of a cell's height
var AE_SPIN_BARB = 0.14, AE_SPIN_BARB_DEG = 25;
var AE_SPIN_AXIS_COLOR = 0xffb347, AE_SPIN_AXIS_ALPHA = 0.95, AE_SPIN_AXIS_S_ALPHA = 0.6, AE_SPIN_PLANE_ALPHA = 0.55;
var AE_SPIN_LABEL_W = 112, AE_SPIN_LABEL_H = 46, AE_SPIN_GAP = 8;   // px: a cell's least width, the name and its line under it, between cells
var AE_SPIN_MAX_ROWS = 4, AE_SPIN_NARROW_PX = 600, AE_SPIN_TOP_MIN_PX = 48;
var AE_SPIN_FIT_ITER = 50, AE_SPIN_FIT_MAX = 1e4;
var AE_SPIN_ROW_TOLERANCE = 0.08;       // a layout this near the biggest is as good: fewer rows, then more even ones, are preferred
var AE_SPIN_SAME_KEY = 'zimi_ae_spin_same';
var AE_SPIN_HOURS_BELOW = 100;           // a day shorter than this many hours is told in hours, else in days
var AE_SPIN_YEARS_ABOVE_DAYS = 730;      // a year longer than this is told in years
var AE_SPIN_DECIMALS_BELOW = 30;         // years are told with a decimal below this many
var AE_SPIN_FACES_KEY = SK.ALM_SPIN_FACES, AE_FULL_ROOT_CLASS = 'ae-full-on';
var AE_SPIN_METRICS = { labelW: AE_SPIN_LABEL_W, labelH: AE_SPIN_LABEL_H, gap: AE_SPIN_GAP };
var AE_SPIN_FULL_METRICS = { labelW: 56, labelH: 30, gap: 6 };   // full screen: the name alone under each planet
var AE_SPIN_FULL_TOOL_PX = 46;           // the corner tools' strip, taken from the side with room to spare
var AE_FACE_PX = 512;                     // the face texture's side; it spans the planet's disc (2 radii) seen square on
var AE_FACE_LIFT = 1.004;                 // the face's shell, in radii: just off the surface it is painted on
var AE_FACE_ORDER = 1, AE_FACE_RING_ORDER = 2;   // drawn after the planet, before the rings: painted on it, under the ring that crosses it
var AE_FACE_BLINK_MS = 150, AE_FACE_BLINK_GAP_MS = [2200, 5200];
// Each planet's own silly face: eyes (round, googly, crossed, wink, spiral) and mouth (smile, tongue, o, teeth).
var AE_FACE_LOOKS = {
  mercury: { eyes: 'googly', mouth: 'teeth' }, venus: { eyes: 'round', mouth: 'tongue' }, earth: { eyes: 'round', mouth: 'smile' },
  mars: { eyes: 'cross', mouth: 'tongue' }, jupiter: { eyes: 'googly', mouth: 'o' }, saturn: { eyes: 'wink', mouth: 'smile' },
  uranus: { eyes: 'spiral', mouth: 'o' }, neptune: { eyes: 'round', mouth: 'teeth' }
};
var AE_FACE_INK = '#2a1620', AE_FACE_MOUTH = '#6a2233', AE_FACE_TONGUE = '#f08aa0', AE_FACE_CHEEK = 'rgba(255,120,150,.55)';
var AE_TOOL_SVG_OPEN = '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true">';
var AE_FACES_SVG = AE_TOOL_SVG_OPEN + '<circle cx="12" cy="12" r="9"/><circle class="ae-dot" cx="9" cy="10" r="1.2"/><circle class="ae-dot" cx="15" cy="10" r="1.2"/><path d="M8 14.2c1 1.9 2.4 2.8 4 2.8s3-.9 4-2.8"/></svg>';
var AE_FULL_SVG = AE_TOOL_SVG_OPEN + '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>';
var AE_FULL_EXIT_SVG = AE_TOOL_SVG_OPEN + '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>';
// The two small tools: faces on or off, and full screen (in the full-screen corner, the way out instead). Icons only.
function _aeSpinToolsHtml(inRow) {
  var faces = _almEsc(_aeT('alm_spin_faces')), full = _almEsc(_aeT(inRow ? 'alm_spin_full' : 'alm_spin_full_exit'));
  return '<button type="button" class="ae-btn ae-round" data-ae-faces aria-pressed="false" aria-label="' + faces + '" title="' + faces + '">' + AE_FACES_SVG + (inRow ? '<span class="ae-chip-l">' + faces + '</span>' : '') + '</button>' +
    '<button type="button" class="ae-btn ae-round" data-ae-full="' + (inRow ? 'enter' : 'exit') + '" aria-label="' + full + '" title="' + full + '">' + (inRow ? AE_FULL_SVG + '<span class="ae-chip-l">' + full + '</span>' : AE_FULL_EXIT_SVG) + '</button>';
}
function _aeSpinBody(key) { return key === 'earth' ? AE_SPIN_EARTH : _aePlanetBody(key); }
function _aeYearDays(eph) { return 36525 * 360 / _PLANETS[eph].dL; }   // days, from the orrery's mean motion
function _aeSpinMapUrl(b) { return b.mapUrl || _aePlanetMapUrl(b); }
// What the labels say, from the same numbers the view turns by: the sidereal turn in seconds (negative: backwards, as the
// fact sheets sign it), the tilt of the spin vector from its orbit's normal, the year in days.
function _aeSpinFacts(b, jd) {
  var g = _aeSpinGeometry(b, jd);
  return { periodS: 360 / b.pole[3] * SECONDS_PER_DAY, tiltDeg: g.tiltDeg, yearDays: _aeYearDays(b.eph) };
}
// A planet's axes in the frame all stand in (x: its spin vector leaning right, y: its orbit's normal, z: toward the
// viewer), kept for the day: the poles do not move, the orbit's plane barely.
var _aeSpinCache = {};
function _aeSpinGeometry(b, jd) {
  var day = Math.floor(jd), c = _aeSpinCache[b.key];
  if (c && c.day === day) return c;
  var f = _aePlanetFrameEcl(b, jd), spin = _aeScale(f.z, b.pole[3] < 0 ? -1 : 1);
  var up = _aeNorm(_aeCross(_ephBodyJ2000(b.eph, jd - AE_SPIN_NORMAL_DAYS), _ephBodyJ2000(b.eph, jd + AE_SPIN_NORMAL_DAYS)));
  var lean = _aeSub(spin, _aeScale(up, _aeDot(spin, up)));
  var X = _aeLen(lean) > 1e-9 ? _aeNorm(lean) : _aeNorm(_aeCross(up, Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  var Z = _aeCross(X, up);
  var to = function (v) { return [_aeDot(v, X), _aeDot(v, up), _aeDot(v, Z)]; };
  return (_aeSpinCache[b.key] = {
    day: day, to: to, pole: to(f.z), axis: to(spin), tiltDeg: _aeDeg(Math.acos(_aeClamp(_aeDot(spin, up), -1, 1)))
  });
}
// A span as it reads on a label: hours with a decimal, days, or years.
function _aeSpinDuration(sec) {
  var h = sec / SECONDS_PER_HOUR, d = sec / SECONDS_PER_DAY;
  if (h < AE_SPIN_HOURS_BELOW) return _orrNum(h, 'hour', 1);
  if (d < AE_SPIN_YEARS_ABOVE_DAYS) return _orrNum(d, 'day');
  var y = d / 365.25;
  return _orrNum(y, 'year', y < AE_SPIN_DECIMALS_BELOW ? 1 : 0);
}
// The words (for a screen reader) and the one short line under the planet: the turn, the year, the tilt, as
// "23.9h · 365d · 23.4°"; a planet that turns backwards ends it with ↺ in amber instead of saying so.
var AE_SPIN_TURN_BACK = '↺';
function _aeSpinNarrow(sec) {
  var h = sec / SECONDS_PER_HOUR, d = sec / SECONDS_PER_DAY, y = d / 365.25;
  var v = h < AE_SPIN_HOURS_BELOW ? [h, 'hour', 1] : d < AE_SPIN_YEARS_ABOVE_DAYS ? [d, 'day', 0] : [y, 'year', y < AE_SPIN_DECIMALS_BELOW ? 1 : 0];
  try { return new Intl.NumberFormat(_orrLang(), { style: 'unit', unit: v[1], unitDisplay: 'narrow', maximumFractionDigits: v[2] }).format(v[0]); }
  catch (e) { return _aeSpinDuration(sec); }
}
function _aeSpinLines(b, jd) {
  var f = _aeSpinFacts(b, jd), d = f.tiltDeg < 1 ? 2 : 1, back = f.periodS < 0;
  var tilt = (typeof fmtNum === 'function' ? fmtNum(f.tiltDeg, { minimumFractionDigits: d, maximumFractionDigits: d }) : f.tiltDeg.toFixed(d)) + '°';
  var words = [_aeT('alm_spin_day', { v: _aeSpinDuration(Math.abs(f.periodS)) })];
  words.push(_aeT('alm_spin_year', { v: _aeSpinDuration(f.yearDays * SECONDS_PER_DAY) }));
  words.push(_aeT('alm_spin_tilt', { v: tilt }));
  if (back) words.push(_aeT('alm_spin_retro'));
  var parts = [_almEsc(_aeSpinNarrow(Math.abs(f.periodS))), _almEsc(_aeSpinNarrow(f.yearDays * SECONDS_PER_DAY)), _almEsc(tilt)];
  var html = parts.join('\u2009·\u2009') + (back ? '\u2009<i class="ae-sp-back">' + AE_SPIN_TURN_BACK + '</i>' : '');
  return { words: words, html: html };   // thin spaces: one line under a phone's cell
}
function _aeSpinSame() {
  var v = _rawGet(AE_SPIN_SAME_KEY);
  if (v === '1' || v === '0') return v === '1';
  return _ae.w < AE_SPIN_NARROW_PX || _aeFullOn();   // a phone's width cannot hold the true sizes: the small planets would be specks
}
function _aeSpinSetSame(on) {
  try { localStorage.setItem(AE_SPIN_SAME_KEY, on ? '1' : '0'); } catch (e) {}
  _aeSpinMarkSame();
  _aeRedraw();
}
function _aeSpinMarkSame() {
  var btn = _aeById('ae-spin-same');
  if (btn) btn.setAttribute('aria-pressed', String(_aeSpinSame()));
}
// What a planet occupies, in the layout's unit (km, or radii when all are the same size): its radius, its rings, and the
// half width and height of the picture round it (the plane line, the axis line, the rings).
function _aeSpinSize(b, same) {
  var rad = same ? 1 : b.km, ring = b.rings ? b.rings[1] / b.km * rad : 0;
  return { rad: rad, ring: ring, plane: Math.max(AE_SPIN_PLANE_R * rad, ring * AE_SPIN_RING_PAD),
    hh: Math.max(AE_SPIN_AXIS_R * rad, ring * AE_SPIN_RING_TILT) };
}
// Whether rows (lists of sizes) fit the room at s px a unit.
function _aeSpinFits(rows, s, W, H, m) {
  var total = -m.gap;
  for (var r = 0; r < rows.length; r++) {
    var w = -m.gap, tall = 0;
    for (var i = 0; i < rows[r].length; i++) {
      w += Math.max(2 * rows[r][i].plane * s, m.labelW) + m.gap;
      tall = Math.max(tall, 2 * rows[r][i].hh * s);
    }
    if (w > W) return false;
    total += tall + m.labelH + m.gap;
  }
  return total <= H;
}
// The planets, in order, in rows: of every split of the order into up to AE_SPIN_MAX_ROWS runs, those that make the planets
// biggest (within AE_SPIN_ROW_TOLERANCE of the most), then the fewest rows, then the most even. Returns the scale (px a
// unit) and a cell per planet: { left, top, width, height, cx, cy, r, labelTop } in px from the room's corner (r: the
// planet's radius). A row's planets stand on one line; each name hangs under its own planet.
function _aeSpinLayout(sizes, W, H, m) {
  var n = sizes.length, found = [];
  for (var mask = 0; mask < 1 << (n - 1); mask++) {
    var runs = [[0]];
    for (var i = 1; i < n; i++) { if ((mask >> (i - 1)) & 1) runs.push([i]); else runs[runs.length - 1].push(i); }
    if (runs.length > AE_SPIN_MAX_ROWS) continue;
    var rows = runs.map(function (run) { return run.map(function (k) { return sizes[k]; }); });
    var lo = 0, hi = AE_SPIN_FIT_MAX;
    for (var it = 0; it < AE_SPIN_FIT_ITER; it++) {
      var mid = (lo + hi) / 2;
      if (_aeSpinFits(rows, mid, W, H, m)) lo = mid; else hi = mid;
    }
    var lens = runs.map(function (r) { return r.length; });
    found.push({ s: lo, runs: runs, uneven: Math.max.apply(null, lens) - Math.min.apply(null, lens) });
  }
  var top = Math.max.apply(null, found.map(function (f) { return f.s; }));
  var best = found.filter(function (f) { return f.s >= top * (1 - AE_SPIN_ROW_TOLERANCE); }).sort(function (a, b) {
    return a.runs.length - b.runs.length || a.uneven - b.uneven || b.s - a.s;
  })[0];
  var s = best.s || 1 / AE_SPIN_FIT_MAX, cells = [];
  var heights = best.runs.map(function (run) { return Math.max.apply(null, run.map(function (k) { return 2 * sizes[k].hh * s; })); });
  var total = heights.reduce(function (a, h) { return a + h + m.labelH; }, 0) + m.gap * (best.runs.length - 1);
  var y = Math.max(0, (H - total) / 2);
  best.runs.forEach(function (run, r) {
    var widths = run.map(function (k) { return Math.max(2 * sizes[k].plane * s, m.labelW); });
    var x = (W - widths.reduce(function (a, w) { return a + w; }, 0) - m.gap * (run.length - 1)) / 2;
    run.forEach(function (k, j) {
      var half = sizes[k].hh * s, cy = y + heights[r] / 2;
      cells[k] = { left: x, top: cy - half, width: widths[j], height: 2 * half + m.labelH, cx: x + widths[j] / 2, cy: cy, r: sizes[k].rad * s };
      x += widths[j] + m.gap;
    });
    y += heights[r] + m.labelH + m.gap;
  });
  return { s: s, cells: cells };
}
// The scene (once, with the context): a planet's sphere, its rings, its axis and its orbital plane, in a group tipped to
// the camera's elevation; its label a button over it. Maps come as the planets' own do.
// A face, as a square canvas that spans a planet's disc seen square on (a radius is half the side): `look` from
// AE_FACE_LOOKS. White eyes with dark pupils read on pale Venus and deep Neptune alike. ``blink``: the eyes shut.
function _aeFaceCanvas(look, blink) {
  var c = document.createElement('canvas'), n = AE_FACE_PX, k = n / 2;
  c.width = c.height = n;
  var g = c.getContext('2d');
  var X = function (u) { return k + u * k; }, Y = function (v) { return k - v * k; };   // in radii from the middle, up positive
  var ink = function (w) { g.strokeStyle = AE_FACE_INK; g.lineWidth = w * k; g.lineCap = g.lineJoin = 'round'; };
  var dot = function (x, y, r, fill) { g.fillStyle = fill; g.beginPath(); g.arc(X(x), Y(y), r * k, 0, 2 * Math.PI); g.fill(); };
  g.fillStyle = AE_FACE_CHEEK;
  [-1, 1].forEach(function (sx) { g.beginPath(); g.ellipse(X(sx * 0.5), Y(-0.1), 0.11 * k, 0.075 * k, 0, 0, 2 * Math.PI); g.fill(); });
  [-1, 1].forEach(function (sx) {
    var ex = sx * 0.3, ey = 0.17, big = look.eyes === 'googly' ? 0.21 : 0.17;
    var shut = blink || (look.eyes === 'wink' && sx > 0);
    if (shut) { ink(0.06); g.beginPath(); g.arc(X(ex), Y(ey + 0.04), 0.13 * k, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); return; }
    g.fillStyle = '#fff'; ink(0.03);
    g.beginPath(); g.arc(X(ex), Y(ey), big * k, 0, 2 * Math.PI); g.fill(); g.stroke();
    if (look.eyes === 'spiral') {
      ink(0.028); g.beginPath();
      for (var a = 0; a < 5.5 * Math.PI; a += 0.2) { var rr = 0.012 + a * 0.0085; g.lineTo(X(ex + sx * rr * Math.cos(a)), Y(ey + rr * Math.sin(a))); }
      g.stroke(); return;
    }
    // Where each pupil looks: in the middle, crossed toward the nose, or googly (each its own way).
    var px = look.eyes === 'cross' ? -sx * 0.07 : look.eyes === 'googly' ? (sx < 0 ? -0.07 : 0.05) : sx * -0.02;
    var py = look.eyes === 'googly' ? (sx < 0 ? 0.06 : -0.08) : -0.015;
    dot(ex + px, ey + py, 0.095, AE_FACE_INK);
    dot(ex + px - 0.035, ey + py + 0.04, 0.032, '#fff');
  });
  var mouth = function () {
    g.beginPath();
    if (look.mouth === 'o') { g.ellipse(X(0), Y(-0.3), 0.12 * k, 0.15 * k, 0, 0, 2 * Math.PI); return; }
    g.moveTo(X(-0.27), Y(-0.17)); g.quadraticCurveTo(X(0), Y(-0.2), X(0.27), Y(-0.17));
    g.bezierCurveTo(X(0.25), Y(-0.45), X(-0.25), Y(-0.45), X(-0.27), Y(-0.17)); g.closePath();
  };
  mouth(); g.fillStyle = AE_FACE_MOUTH; g.fill();
  g.save(); g.clip();
  if (look.mouth === 'teeth') { g.fillStyle = '#fff'; g.fillRect(X(-0.12), Y(-0.17), 0.11 * k, 0.11 * k); g.fillRect(X(0.01), Y(-0.17), 0.11 * k, 0.11 * k); }
  else if (look.mouth !== 'tongue') { g.fillStyle = AE_FACE_TONGUE; g.beginPath(); g.ellipse(X(0), Y(-0.42), 0.15 * k, 0.1 * k, 0, 0, 2 * Math.PI); g.fill(); }
  g.restore();
  ink(0.04); mouth(); g.stroke();
  if (look.mouth === 'teeth') { ink(0.025); g.beginPath(); g.moveTo(X(0.005), Y(-0.18)); g.lineTo(X(0.005), Y(-0.28)); g.stroke(); }
  if (look.mouth === 'tongue') {
    // Sticking out, past the lip: a raspberry.
    g.fillStyle = AE_FACE_TONGUE; ink(0.03);
    g.beginPath(); g.moveTo(X(-0.12), Y(-0.33)); g.lineTo(X(-0.12), Y(-0.48)); g.arc(X(0), Y(-0.48), 0.12 * k, Math.PI, 0, true); g.lineTo(X(0.12), Y(-0.33)); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(X(0), Y(-0.36)); g.lineTo(X(0), Y(-0.5)); g.stroke();
  }
  return c;
}
// The face is painted on the planet: a shell just off its surface, turning with it about its axis, upright to its north.
// Seen square on at its longitude (lon, from +x in the sphere's own frame, north +z) it is the canvas; it slides round the limb
// and away as the planet turns. Lit as the surface is, never quite dark, so it can be found on the night side.
var AE_FACE_VERT = 'varying vec3 vLocal; varying vec3 vNormal; void main() { vLocal = position; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
var AE_FACE_FRAG = [
  'uniform sampler2D map; uniform float tint; uniform vec3 sunDir; uniform float lon; uniform float up; varying vec3 vLocal; varying vec3 vNormal;',
  'void main() {',
  '  vec3 n = normalize(vLocal), d = vec3(cos(lon) * n.x + sin(lon) * n.y, (-sin(lon) * n.x + cos(lon) * n.y) * up, n.z * up);',
  '  if (d.x <= 0.0) discard;',
  '  vec4 t = texture2D(map, vec2(d.y, d.z) * 0.5 + 0.5);',
  '  float light = 0.45 + 0.55 * max(dot(normalize(vNormal), sunDir), 0.0);',
  '  gl_FragColor = vec4(t.rgb * light * tint, t.a * smoothstep(0.0, 0.15, d.x));',
  '}'
].join('\n');
// Faces: the person's own choice (kept with them), else on in full screen only: a kid's view of the planets wants them, the
// reference for the numbers (Day, Year, Tilt) does not.
function _aeSpinFacesOn() {
  var v = _rawGet(AE_SPIN_FACES_KEY);
  if (v === '1' || v === '0') return v === '1';
  return _aeFullOn();
}
function _aeSpinSetFaces(on) {
  _prefWrite(AE_SPIN_FACES_KEY, on ? '1' : '0');
  _aeSpinMarkFaces();
}
function _aeSpinMarkFaces() {
  var on = String(_aeSpinFacesOn());
  Array.prototype.forEach.call(document.querySelectorAll('[data-ae-faces]'), function (b) { b.setAttribute('aria-pressed', on); });
  _aeSpinBlinkStart();
  if (_ae) _aeRedraw();
}
// A blink now and then, one planet at a time (not under reduced motion): a timer, not a frame loop, so the view stays idle between.
function _aeSpinBlinkStop() { var s = _ae && _ae.spin; if (s && s.blinkTimer) { clearTimeout(s.blinkTimer); s.blinkTimer = 0; } }
function _aeSpinBlink(c) {
  c.blinkUntil = performance.now() + AE_FACE_BLINK_MS;
  _aeRedraw();
  setTimeout(function () { if (_ae) _aeRedraw(); }, AE_FACE_BLINK_MS + 20);
}
function _aeSpinBlinkStart() {
  var s = _ae && _ae.spin, sp = _ae && _ae.gl && _ae.gl.spin;
  _aeSpinBlinkStop();
  if (!s || !sp || !_aeSpinFacesOn() || _aeReduceMotion()) return;
  var gap = AE_FACE_BLINK_GAP_MS;
  s.blinkTimer = setTimeout(function () {
    s.blinkTimer = 0;
    _aeSpinBlink(sp.cells[Math.floor(Math.random() * sp.cells.length)]);
    _aeSpinBlinkStart();
  }, gap[0] + Math.random() * (gap[1] - gap[0]));
}
function _aeSpinBuild(S) {
  var THREE = S.THREE, V = THREE.Vector3;
  var sp = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(30, 1, AE_SPIN_CAM_DIST / 2, AE_SPIN_CAM_DIST * 1.5), cells: [], key: '', faces: false };
  var geo = new THREE.SphereGeometry(1, AE_PLANET_SEGMENTS[0], AE_PLANET_SEGMENTS[1]);
  geo.rotateX(Math.PI / 2);
  var ringMap = { value: null }, sun = new V(AE_SPIN_SUN[0], AE_SPIN_SUN[1], AE_SPIN_SUN[2]).normalize();
  sp.v = [new V(), new V(), new V()];
  AE_SPIN_ORDER.forEach(function (key) {
    var b = _aeSpinBody(key);
    var G = new THREE.Group(), lines = new THREE.Group();
    G.rotation.x = _aeRad(AE_SPIN_ELEV_DEG);
    var pm = _aePlanetMesh(THREE, b, geo, 1, sun, ringMap), mesh = pm.mesh, uni = pm.uni;
    G.add(mesh);
    var cell = { b: b, G: G, mesh: mesh, uni: uni, lines: lines, plane: _aeSpinSize(b, false).plane / b.km };
    if (pm.ring) {
      cell.ring = pm.ring;
      cell.ring.renderOrder = AE_FACE_RING_ORDER;
      G.add(cell.ring);
    }
    // The face: its own silly one (open eyes, shut eyes), on a shell that turns with the planet; the rings cross it.
    cell.faceTex = [null, null];
    [false, true].forEach(function (blink, i) {
      _aeLoadTexture(THREE, _aeFaceCanvas(AE_FACE_LOOKS[key], blink).toDataURL()).then(function (tx) {
        if (_ae.gl !== S) { tx.dispose(); return; }
        tx.anisotropy = S.aniso;
        cell.faceTex[i] = tx; _aeRedraw();
      });
    });
    cell.faceUni = { map: { value: null }, tint: { value: 1 }, sunDir: uni.sunDir, lon: { value: 0 }, up: { value: 1 } };   // up: toward the drawn north arrow (the IAU pole, for Venus and Uranus too)
    cell.face = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: cell.faceUni, vertexShader: AE_FACE_VERT, fragmentShader: AE_FACE_FRAG,
      transparent: true, depthWrite: false }));
    cell.face.matrixAutoUpdate = false;
    cell.face.renderOrder = AE_FACE_ORDER;
    cell.face.visible = false;
    G.add(cell.face);
    // The orbital plane, edge on: one line through the planet in it (y is the orbit's normal), hidden where the planet
    // stands in front. A ring here read as rings on Jupiter, Uranus and Neptune (Eric, 2026-11-06).
    cell.orbit = _aeLine(THREE, THREE.Line, 2, AE_PLANET_ORBIT_COLOR, AE_SPIN_PLANE_ALPHA);
    var pts = cell.orbit.geometry.attributes.position.array;
    pts[0] = -cell.plane; pts[3] = cell.plane;
    cell.orbit.geometry.setDrawRange(0, 2);
    cell.south = _aeLine(THREE, THREE.Line, 2, AE_PLANET_ORBIT_COLOR, AE_SPIN_AXIS_S_ALPHA);
    cell.north = _aeLine(THREE, THREE.LineSegments, 6, AE_SPIN_AXIS_COLOR, AE_SPIN_AXIS_ALPHA);
    cell.south.geometry.setDrawRange(0, 2);
    cell.north.geometry.setDrawRange(0, 6);
    lines.add(cell.orbit); lines.add(cell.south); lines.add(cell.north);
    G.add(lines);
    sp.scene.add(G);
    sp.cells.push(cell);
    _aeLoadTexture(THREE, _aeSpinMapUrl(b)).then(function (tx) {
      if (_ae.gl !== S) { tx.dispose(); return; }
      tx.anisotropy = S.aniso;
      uni.map.value = tx; uni.mapped.value = 1;
      _aeRedraw();
    }, function () {});
  });
  _aeLoadTexture(THREE, _aeRingCanvas().toDataURL()).then(function (tx) {
    if (_ae.gl !== S) { tx.dispose(); return; }
    ringMap.value = tx; _aeRedraw();
  });
  return sp;
}
// The axis line through a planet's poles and its north arrowhead, in planet radii, for the axis a (unit, in the frame's
// xy plane).
function _aeSpinSetAxis(cell, a) {
  var R = AE_SPIN_AXIS_R, tip = [a[0] * R, a[1] * R], rad = _aeRad(AE_SPIN_BARB_DEG);
  var barb = function (sign) {
    var c = Math.cos(sign * rad), s = Math.sin(sign * rad);
    return [tip[0] + AE_SPIN_BARB * (-a[0] * c + a[1] * s), tip[1] + AE_SPIN_BARB * (-a[0] * s - a[1] * c), 0];
  };
  cell.north.geometry.attributes.position.array.set([0, 0, 0, tip[0], tip[1], 0, tip[0], tip[1], 0].concat(barb(1), tip[0], tip[1], 0, barb(-1)));
  cell.south.geometry.attributes.position.array.set([0, 0, 0, -tip[0], -tip[1], 0]);
  cell.north.geometry.attributes.position.needsUpdate = true;
  cell.south.geometry.attributes.position.needsUpdate = true;
}
// The room the planets have: under the controls at the top, above the foot.
// The foot's height, and where the row stands at the side (a phone on its side): its right edge, else 0.
function _aeSetVar(name, v) {   // written only when it changes (a style write is a style recalculation)
  var k = '_v' + name;
  if (_ae[k] !== v) { _ae[k] = v; if (v) _ae.el.style.setProperty(name, v); else _ae.el.style.removeProperty(name); }
}
// The page's top safe-area inset in px (--sat), 0 where it is not set.
function _aeSatPx() { return typeof getComputedStyle === 'function' && document.body ? parseFloat(getComputedStyle(document.body).getPropertyValue('--sat')) || 0 : 0; }
function _aeMeasureFoot() {
  var foot = _ae.el && _ae.el.querySelector ? _ae.el.querySelector('.ae-bottom') : null, views = _aeById('ae-views'), pin = _aeById('ae-pin');
  _ae.sidePx = 0;
  _ae.hdrPx = 0;   // the page's header is not drawn over the view (body.ae-3d .topbar): the time bar stands at the top edge
  _ae.pinPx = _ae.hdrPx + Math.max(pin && _ae.el ? Math.ceil(_aeHudPinFoot(pin)) : 0, 8 + AE_HIT_PX + 8 + _aeSatPx());   // the capsule's foot (it stands 8 px down), under the two circles at least
  if (_ae.el) { _aeSetVar('--ae-bar', 'calc(' + AE_BAR_PX + 'px + var(--sat,0px))'); _aeSetVar('--ae-hdr', _ae.hdrPx + 'px'); _aeSetVar('--ae-pin-h', _ae.pinPx + 'px'); }   // the controls under it stand below it
  _aeSetVar('--ae-rim-b', !_aeGoUp() && views && views.offsetParent && getComputedStyle(views).position !== 'absolute' ? Math.round(_ae.el.getBoundingClientRect().bottom - views.getBoundingClientRect().bottom) + 'px' : '');   // the rim button stands level with the row (the sheet up, the row is put away, and the search circle's X stands at the foot)
  if (!foot) { _ae.footPx = 0; return; }
  if (views && views.offsetParent && getComputedStyle(views).position === 'absolute') {
    _ae.sidePx = views.offsetLeft + views.offsetWidth;
    var note = _aeById('ae-note'), box = note && note.parentNode;
    _ae.footPx = box && box.offsetParent ? foot.offsetHeight - box.offsetTop : 0;
  } else _ae.footPx = foot.offsetHeight;
}
function _aeSpinRoom() {
  if (_aeFullOn()) return _aeSpinFullRoom();
  // On its side the round tools are a strip at the right, not a band over the planets.
  if (_ae.w > _ae.h) {
    var right = Math.max.apply(null, [0].concat((_ae.topBoxes || []).filter(function (b) { return b[0] > _ae.w / 2; }).map(function (b) { return _ae.w - b[0]; })));
    var left = (_ae.sidePx || 0) + AE_SPIN_GAP;
    var under = Math.max(AE_SPIN_GAP, _ae.pinPx || 0);   // the strip runs along the top
    return { x: left, y: under, w: Math.max(1, _ae.w - left - Math.max(AE_SPIN_GAP, right)), h: Math.max(1, _ae.h - _ae.footPx - under) };
  }
  var top = Math.max.apply(null, [AE_SPIN_TOP_MIN_PX].concat((_ae.topBoxes || []).filter(function (b) { return b[1] < _ae.h / 3; }).map(function (b) { return b[3]; })));
  return { x: AE_SPIN_GAP, y: top, w: _ae.w - 2 * AE_SPIN_GAP, h: Math.max(1, _ae.h - _ae.footPx - top) };
}
// Full screen: the whole view inside its safe areas, less the corner tools' strip on the side with room (the top in
// portrait, the right in landscape).
function _aeSpinFullRoom() {
  var m = AE_SPIN_FULL_METRICS, safe = _aeById('ae-safe'), cs = safe && getComputedStyle(safe), inset = function (side) { return cs ? parseFloat(cs['padding' + side]) || 0 : 0; };
  var x = inset('Left') + m.gap, y = inset('Top'), w = _ae.w - x - inset('Right') - m.gap, h = _ae.h - y - inset('Bottom');
  if (_ae.w > _ae.h) w -= AE_SPIN_FULL_TOOL_PX; else { y += AE_SPIN_FULL_TOOL_PX; h -= AE_SPIN_FULL_TOOL_PX; }
  return { x: x, y: y, w: w, h: Math.max(1, h) };
}
// Lay the planets out again when what decides it has changed (size, setting, language), and write the labels.
function _aeSpinFit(sp, jd) {
  var room = _aeSpinRoom(), same = _aeSpinSame();
  var full = _aeFullOn(), m = full ? AE_SPIN_FULL_METRICS : AE_SPIN_METRICS;
  var key = [room.x, room.y, room.w, room.h, same, full, _orrLang()].join('|');
  if (key === sp.key) return;
  sp.key = key;
  var fit = _aeSpinLayout(sp.cells.map(function (c) { return _aeSpinSize(c.b, same); }), room.w, room.h, m);
  var cam = sp.camera;
  cam.fov = _aeDeg(2 * Math.atan(_ae.h / 2 / AE_SPIN_CAM_DIST));
  cam.aspect = _ae.w / _ae.h;
  cam.position.set(_ae.w / 2, _ae.h / 2, AE_SPIN_CAM_DIST);
  cam.updateProjectionMatrix();
  var host = _aeById('ae-spin'), html = '';
  sp.cells.forEach(function (c, i) {
    var l = fit.cells[i], b = c.b, name = _aeBodyName(b), said = _aeSpinLines(b, jd);
    c.r = l.r;
    c.G.position.set(room.x + l.cx, _ae.h - (room.y + l.cy), 0);
    c.lines.scale.set(l.r, l.r, l.r);
    c.orbit.visible = true;
    c.axisDay = null;
    c.uni.center.value.copy(c.G.position);
    c.uni.ringR.value = b.rings ? [b.rings[0] / b.km * l.r, b.rings[1] / b.km * l.r] : [0, 1];
    html += '<button type="button" class="ae-sp" data-ae-spin="' + b.key + '" style="left:' + Math.round(room.x + l.left) + 'px;top:' + Math.round(room.y + l.top) +
      'px;width:' + Math.round(l.width) + 'px;height:' + Math.round(l.height) + 'px;padding-top:' + Math.round(l.height - m.labelH) + 'px" aria-label="' + _almEsc([name].concat(said.words).join(', ')) + '"><b>' +
      _almEsc(name) + '</b>' + (full ? '' : '<span aria-hidden="true">' + said.html + '</span>') + '</button>';
  });
  if (host) host.innerHTML = html;
}
// One planet this frame: its turn at the shown date, in the frame all stand in.
function _aeSpinPlace(sp, c, jd) {
  var b = c.b, g = _aeSpinGeometry(b, jd), f = _aePlanetFrameEcl(b, jd), v = sp.v, r = c.r;
  var x = g.to(f.x), y = g.to(f.y), z = g.pole;
  v[0].set(x[0], x[1], x[2]); v[1].set(y[0], y[1], y[2]); v[2].set(z[0], z[1], z[2]);
  var m = c.mesh.matrix;
  m.makeBasis(v[0], v[1], v[2]);
  var e = m.elements, squash = b.flat ? 1 - b.flat : 1;
  for (var i = 0; i < 3; i++) { e[i] *= r; e[4 + i] *= r; e[8 + i] *= r * squash; }
  c.mesh.matrixWorldNeedsUpdate = true;
  c.face.matrix.copy(m);
  for (var j = 0; j < 12; j++) if (j % 4 !== 3) c.face.matrix.elements[j] *= AE_FACE_LIFT;
  c.face.matrixWorldNeedsUpdate = true;
  // Each face starts where the planet faces you when faces come on, then turns away with it (slow Venus keeps hers in view).
  if (sp.faces && c.faceLon == null) {
    var ce0 = Math.cos(_aeRad(AE_SPIN_ELEV_DEG)), se0 = Math.sin(_aeRad(AE_SPIN_ELEV_DEG));
    var toCam = [0, se0, ce0];   // the camera's way (+z on screen) in the planet's tipped group
    c.faceLon = Math.atan2(toCam[0] * v[1].x + toCam[1] * v[1].y + toCam[2] * v[1].z, toCam[0] * v[0].x + toCam[1] * v[0].y + toCam[2] * v[0].z);
    c.faceUni.lon.value = c.faceLon;
  }
  if (!sp.faces) c.faceLon = null;
  if (c.ring) {
    c.ring.matrix.makeBasis(v[0], v[1], v[2]);
    var re = c.ring.matrix.elements;
    for (var k = 0; k < 12; k++) if (k % 4 !== 3) re[k] *= r;
    c.ring.matrixWorldNeedsUpdate = true;
  }
  var ce = Math.cos(_aeRad(AE_SPIN_ELEV_DEG)), se = Math.sin(_aeRad(AE_SPIN_ELEV_DEG));
  c.uni.ringN.value.set(z[0], z[1] * ce - z[2] * se, z[1] * se + z[2] * ce);
  c.uni.dim.value = _aeRedOn() ? AE_RED_EARTH_LIGHT : 1;
  if (c.axisDay !== g.day) { c.axisDay = g.day; _aeSpinSetAxis(c, g.pole); }   // the IAU north, as the main view draws it: Venus visibly turns backwards about it
  var tx = c.faceTex[c.blinkUntil > performance.now() ? 1 : 0] || c.faceTex[0];
  c.face.visible = sp.faces && !!tx;
  c.faceUni.tint.value = c.uni.dim.value;
  c.faceUni.map.value = tx;
}
function _aeSpinDraw() {
  var S = _ae.gl, sp = S.spin || (S.spin = _aeSpinBuild(S));
  var jd = _aeDisplayMs() / MS_PER_DAY + JD_UNIX_EPOCH;
  sp.jd = jd;   // the date this was drawn at
  _aeSpinFit(sp, jd);
  sp.faces = _aeSpinFacesOn();
  if (sp.faces && !_ae.spin.blinkTimer) _aeSpinBlinkStart();
  sp.cells.forEach(function (c) { _aeSpinPlace(sp, c, jd); });
  S.renderer.render(sp.scene, sp.camera);
}
// A copy of the canvas's last picture laid over it and faded away, so a change of view on the one canvas is a cross-fade, never a black
// frame (the ground's way in and out, almanac-stand.js, and Side by side). It lives here, not in the ground's lazy file.
var AE_STILL_XFADE_MS = 420;
// A copy of what the canvas shows now (taken in the task that drew it, before it is presented), laid over it.
function _aeStandStill() {
  var cv = _aeById('ae-canvas');
  if (!cv || !cv.width || !cv.parentNode) return null;
  try {
    var el = document.createElement('canvas');
    el.width = cv.width; el.height = cv.height;
    el.getContext('2d').drawImage(cv, 0, 0);
    el.className = 'ae-stand-still';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    cv.parentNode.insertBefore(el, cv.nextSibling);
    return el;
  } catch (e) { return null; }
}
// The copy fades away over the new picture (the Web Animations API, which the reduced-motion rule for CSS transitions does not cut short).
function _aeStandStillFade(el, ms) {
  if (!el) return;
  ms = ms || AE_STILL_XFADE_MS;
  var done = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  if (!el.animate) { done(); return; }
  var a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
  a.onfinish = done; a.oncancel = done;
  setTimeout(done, ms + 200);
}
// Side by side opens and closes as a cross-fade of that copy over the first picture of the other layout: not a flight, the grid is a
// layout and not a place. Reduced motion keeps the cut.
var AE_SPIN_XFADE_MS = 300;
function _aeSpinCross(change) {
  var still = null;
  if (_aeIsOpen && _ae.gl && !_aeReduceMotion()) {
    try { _aeDraw(performance.now(), true); } catch (e) {}   // the copy is read off the canvas, blank unless drawn in this task
    still = _aeStandStill();
  }
  change();
  _aeStillFadeByFrames(still, AE_SPIN_XFADE_MS);
}
// The same fade, counted in frames: a frame that takes longer than AE_XFADE_MAX_STEP_MS (the change builds a scene, and on a slow
// device or software GL that one frame is a quarter of a second) counts as that much, so the blend is seen, not skipped. A clock-timed
// fade is over before the first frame of the new layout. (A hidden page gets no frames: the timer removes the copy.)
var AE_XFADE_MAX_STEP_MS = 50;
function _aeStillFadeByFrames(el, ms) {
  if (!el) return;
  var elapsed = 0, last = null;
  var done = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  var step = function (now) {
    if (!el.parentNode) return;
    if (last !== null) elapsed += Math.min(now - last, AE_XFADE_MAX_STEP_MS);
    last = now;
    if (elapsed >= ms) { done(); return; }
    var t = elapsed / ms;
    el.style.opacity = String(1 - t * t * (3 - 2 * t));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(done, ms * 4 + 1000);
}
// `from`: the place the view stood at when it was chosen, where the way back goes.
function _aeEnterSpin(from) {
  if (_ae.spin || !_ae.gl) return;
  _aeSpinCross(function () { _aeEnterSpinNow(from); });
}
function _aeEnterSpinNow(from) {
  _ae.spin = { autoRun: false, prevFocus: null, from: from || 'planets' };
  // From real time the clock starts at an hour a second, or nothing would seem to turn (the grid's default speed from real time;
  // a speed the person already set, time travel included, stays as it is). Not under reduced motion. Leaving puts the date back unless
  // the person touched the clock meanwhile.
  if (_almRate === 1 && !_aeReduceMotion()) {
    _ae.spin.prevFocus = _aeFocusSet() ? new Date(_almFocus) : null;
    _ae.spin.autoRun = true;
    _almClockSetRate(AE_SPIN_SPEED);
  }
  _ae.el.classList.add('ae-spinning');
  _aeById('ae-spinrow').hidden = false;
  _aeSpinMarkSame();
  _aeSpinMarkFaces();
  if (_ae.gl.spin) _ae.gl.spin.key = '';
  _aeResize();   // the foot has a row more
}
// Full screen: the planets and their names, the chrome gone. The view's own class always (it covers the viewport where the
// Fullscreen API is missing, as on an iPhone); the API too where there is one. Escape, the corner tool and the system back all leave.
function _aeFullOn() { return !!(_ae && _ae.spin && _ae.spin.full); }
function _aeFullApply(on) {
  var s = _ae.spin;
  s.full = on;
  _ae.el.classList.toggle('ae-spin-full', on);
  document.documentElement.classList.toggle(AE_FULL_ROOT_CLASS, on);
  if (_ae.gl && _ae.gl.spin) _ae.gl.spin.key = '';
  _aeSpinMarkFaces();
  _aeSpinMarkSame();
  _aeResize();
  var focusId = on ? 'ae-fullbar' : 'ae-spin-same', target = on ? _ae.el.querySelector('#ae-fullbar [data-ae-full]') : _aeById(focusId);
  if (target) target.focus({ preventScroll: true });
}
function _aeFullEnter() {
  if (!_ae.spin || _ae.spin.full) return;
  _aeShowSettings(false);
  _aeFullApply(true);
  _aeFullStepIn();
  if (!_aeFullHeard) { _aeFullHeard = true; document.addEventListener('fullscreenchange', _aeFullChanged); }
  try {
    if (document.fullscreenEnabled && _ae.el.requestFullscreen) {
      var p = _ae.el.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.catch) p.catch(function () {});
    }
  } catch (e) {}
}
// The browser's own full screen let go of, if the view holds it.
function _aeFullscreenLeave() {
  if (document.fullscreenElement === _ae.el && document.exitFullscreen) { var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {}); }
}
// Out of full screen by the person (the tool, Escape, the browser's own way out): ``history`` false when the back step has gone already.
function _aeFullExit(history) {
  if (!_aeFullOn()) return;
  _aeFullApply(false);
  _aeFullscreenLeave();
  if (history !== false) _aeFullStepOut();
}
// The view leaving Side by side or closing: full screen undone without touching history (the caller does).
function _aeFullDrop() {
  if (!_aeFullOn()) return;
  _ae.spin.full = false;
  _ae.el.classList.remove('ae-spin-full');
  document.documentElement.classList.remove(AE_FULL_ROOT_CLASS);
  _aeFullscreenLeave();
}
// The browser's own way out (its Escape) ends full screen here too. Listened for from the first entry, not at load.
var _aeFullHeard = false;
function _aeFullChanged() {
  if (!_ae || !_ae.spin) return;
  if (document.fullscreenElement === _ae.el) _ae.spin.api = true;
  else if (_ae.spin.api && _ae.spin.full) _aeFullExit();
}
function _aeLeaveSpin(cut) {   // cut: the view is closing, which has its own way out
  if (!(_ae && _ae.spin)) return;
  if (cut) _aeLeaveSpinNow(); else _aeSpinCross(_aeLeaveSpinNow);
}
function _aeLeaveSpinNow() {
  var s = _ae && _ae.spin;
  if (!s) return;
  _aeSpinBlinkStop();
  _aeFullDrop();
  _ae.spin = null;
  if (_ae.preset === AE_SPIN_KEY) _ae.preset = null;
  _ae.el.classList.remove('ae-spinning');
  _aeById('ae-spinrow').hidden = true;
  if (s.autoRun && _almRate === AE_SPIN_SPEED) { if (s.prevFocus) _aeGoTo(s.prevFocus.getTime()); else _aeNow(); }
  if (_ae.gl) _aeResize();
}
// ── Axes ──
// Each body's rotation axis in the main view, as Side by side draws it: a thin line through the poles, the north end in
// amber with an arrowhead, the south end a quiet blue-grey. North is the IAU pole the maps are placed by (the top of the
// map), so for Venus and Uranus, which turn backwards about it, the arrowhead stands at the top of the picture and not
// at the end the right-hand rule gives (Side by side marks that one). They are light lines "not in the real system", so
// they are shown exactly when the body's orbit is (the Orbits setting in the gear: While flying, Always, Off, and the
// Planets view's rule), once its disc is AE_AXIS_MIN_PX across. The Sun's pole is the IAU's (7.25 degrees from the ecliptic's).
var AE_AXIS_MIN_PX = 14;                     // a body this many pixels in radius shows its axis
var AE_AXIS_NEAR_R = 1.6;                    // and none from closer than this many of its radii to its centre: you are in its sky
var AE_SUN_POLE = [286.13, 63.87, 84.176, 14.1844];   // IAU WGCCRE 2015: RA, Dec of the pole, W0, degrees a day
// A body's north pole as a unit vector in the scene (the equator of date), or null where it has none. `sc`: _aeSceneAt.
function _aeAxisDir(key, sc) {
  var S = _ae.gl;
  if (key === 'earth') return [0, 0, 1];
  if (key === 'moon') return _aeNorm(_aeXyz(S.vz));
  if (key === 'sun') return _aeNorm(_ephEclJ2000ToEqOfDate(_aePlanetFrameEcl({ pole: AE_SUN_POLE }, sc.jd).z, sc.jde));
  var p = S.planets && S.planets[key];
  if (!p) return null;
  var e = p.mesh.matrix.elements;   // the mesh's z column is its pole (squashed by the flattening, so not unit)
  return _aeNorm([e[8], e[9], e[10]]);
}
// Which bodies show an axis this frame: { key, pos, r, dir } for each.
function _aeAxisBodies(S, sc) {
  var out = [];
  if (_ae.spin) return out;
  var cam = S.camera, eye = _aeXyz(cam.position), pxPerRad = _aePxPerRad(cam);
  // `orbit`: whose orbit line the axis keeps company with (the Earth's own and the Moon's are one set: 'moon').
  var add = function (key, orbit, pos, r) {
    var show = pos ? _aeOrbitShow(orbit) : 0, d = show > 0 ? _aeLen(_aeSub(pos, eye)) : 0;
    if (show <= 0 || d < AE_AXIS_NEAR_R * r || r / Math.max(1e-9, d) * pxPerRad < AE_AXIS_MIN_PX) return;   // (close over a world its axis would stand over the horizon as three lines)
    var dir = _aeAxisDir(key, sc);
    if (dir) out.push({ key: key, pos: pos, r: r, dir: dir, show: show });
  };
  add('earth', 'moon', [0, 0, 0], 1);
  add('moon', 'moon', sc.moon, AE_MOON_RADIUS_KM / AE_EARTH_RADIUS_KM);
  add('sun', 'sun', _aeSunShown(sc), AE_SUN_SHOW_R);
  AE_PLANETS.forEach(function (b) {
    var p = S.planets[b.key];
    if (p && p.pos && p.mesh.visible) add(b.key, b.key, p.pos, b.r);
  });
  return out;
}
// The north line with its arrowhead (the barbs turned to face the camera) and the south line, for one body.
// The points are written about the body's centre and the lines placed there: a world position thousands of Earth
// radii out, rounded to float32 in the buffer, snaps by about 1.5 km at Mars, more than Phobos's whole arrowhead, so
// the arrow shook as the view moved. The object's position is a double, and three makes the view matrix from it on the CPU.
function _aeSetAxisLines(o, a, eye) {
  var R = AE_SPIN_AXIS_R * a.r, tip = _aeScale(a.dir, R), ang = _aeRad(AE_SPIN_BARB_DEG);
  var side = _aeCross(a.dir, _aeSub(eye, _aeAdd(a.pos, tip)));
  side = _aeLen(side) > 1e-12 ? _aeNorm(side) : _aeNorm(_aeCross(a.dir, Math.abs(a.dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  var barb = function (sign) {
    return _aeAdd(tip, _aeScale(_aeAdd(_aeScale(a.dir, -Math.cos(ang)), _aeScale(side, sign * Math.sin(ang))), AE_SPIN_BARB * a.r));
  };
  var n = o.north.geometry.attributes.position, s = o.south.geometry.attributes.position, c = [0, 0, 0];
  n.array.set([].concat(c, tip, tip, barb(1), tip, barb(-1)));
  s.array.set([].concat(c, _aeScale(a.dir, -R)));
  o.north.position.set(a.pos[0], a.pos[1], a.pos[2]); o.south.position.copy(o.north.position);
  n.needsUpdate = true; s.needsUpdate = true;
  o.north.material.opacity = AE_SPIN_AXIS_ALPHA * a.show * _aeFadeU.value;
  o.south.material.opacity = AE_SPIN_AXIS_S_ALPHA * a.show * _aeFadeU.value;
}
function _aeDrawAxes(S, sc) {
  var shown = _aeAxisBodies(S, sc), cam = S.camera, eye = _aeXyz(cam.position), on = {};
  S.axes = S.axes || {};
  shown.forEach(function (a) {
    var o = S.axes[a.key];
    if (!o) {   // made the first time a body shows one
      o = S.axes[a.key] = {
        north: _aeLine(S.THREE, S.THREE.LineSegments, 6, AE_SPIN_AXIS_COLOR, AE_SPIN_AXIS_ALPHA),
        south: _aeLine(S.THREE, S.THREE.Line, 2, AE_PLANET_ORBIT_COLOR, AE_SPIN_AXIS_S_ALPHA)
      };
      o.north.geometry.setDrawRange(0, 6); o.south.geometry.setDrawRange(0, 2);
      S.scene.add(o.north); S.scene.add(o.south);
    }
    on[a.key] = true;
    o.north.visible = o.south.visible = true;
    o.dir = a.dir; o.pos = a.pos;   // where the test (and the next frame) can read them
    _aeSetAxisLines(o, a, eye);
  });
  Object.keys(S.axes).forEach(function (k) { if (!on[k]) S.axes[k].north.visible = S.axes[k].south.visible = false; });
}
// ── The asteroid belt ──
// asteroids-v1.bin (scripts/build_asteroids.py, JPL's Small-Body Database): the ~18,000 main-belt asteroids brighter
// than H 14, as orbital elements, each moved along its ellipse to the shown date and placed as the planets are. Fetched the first time the view stands out among the planets
// or wide enough to hold the belt; placed again when the shown date has moved a day.
var AE_AST_URL = _almAsset('/static/earth/asteroids-v1.bin');
var AE_AST_AU_SPAN = 6, AE_AST_Q = 65535, AE_AST_HEADER = 12;
var AE_AST_GAUSS_K = 0.01720209895;             // radians a day at 1 AU (Kepler's third law)
var AE_AST_REPLACE_DAYS = 1;
var AE_AST_PER_FRAME = 1500;                     // asteroids placed a frame
// Work that can wait a frame (an orbit, a probe's path): this many such redraws a frame, the rest the next.
var AE_REDRAWS_PER_FRAME = 3, _aeRedrawsLeft = AE_REDRAWS_PER_FRAME;
function _aeMayRedraw() { return _aeRedrawsLeft-- > 0; }
var AE_AST_WIDE_DIST = 60;                       // Earth radii from the Earth: past this the belt is worth drawing
// A faint dust ring, never brighter than the orbits: every third asteroid, small and dim.
var AE_AST_COLOR = [0.62, 0.62, 0.66], AE_AST_ALPHA = 0.16, AE_AST_PX = 1.0, AE_AST_STRIDE = 3;
var _aeAst = null, _aeAstLoading = null;
function _aeAstLoad() {
  if (_aeAst || _aeAstLoading || typeof fetch !== 'function') return;
  _aeAstLoading = fetch(AE_AST_URL).then(function (r) { if (!r.ok) throw new Error('asteroids'); return r.arrayBuffer(); }).then(function (buf) {
    var dv = new DataView(buf), n = dv.getUint32(8, true), q = new Uint16Array(buf.slice(AE_AST_HEADER, AE_AST_HEADER + n * 12));
    var el = new Float64Array(n * 6);
    for (var i = 0; i < n; i++) {
      el[i * 6] = q[i * 6] / AE_AST_Q * AE_AST_AU_SPAN;
      el[i * 6 + 1] = q[i * 6 + 1] / AE_AST_Q;
      el[i * 6 + 2] = _aeRad(q[i * 6 + 2] / AE_AST_Q * 180);
      for (var k = 3; k < 6; k++) el[i * 6 + k] = _aeRad(q[i * 6 + k] / AE_AST_Q * 360);
    }
    _aeAst = { epoch: dv.getFloat64(0, true), n: n, el: el, at: null, cloud: null };
    if (_ae) _aeRedraw();
  }).catch(function () { _aeAstLoading = null; });
}
// One asteroid's place from the Sun (AU, J2000 ecliptic) at a JD (TT).
function _aeAstHelio(el, i, jde, epoch) {
  var a = el[i * 6], e = el[i * 6 + 1], inc = el[i * 6 + 2], om = el[i * 6 + 3], w = el[i * 6 + 4];
  var M = el[i * 6 + 5] + AE_AST_GAUSS_K / Math.pow(a, 1.5) * (jde - epoch), E = M;
  for (var k = 0; k < 5; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  var xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  var cw = Math.cos(w), sw = Math.sin(w), co = Math.cos(om), so = Math.sin(om), ci = Math.cos(inc), si = Math.sin(inc);
  var xp = xv * cw - yv * sw, yp = xv * sw + yv * cw;
  return [xp * co - yp * so * ci, xp * so + yp * co * ci, yp * si];
}
function _aeUpdateAsteroids(jde, around, sunAt) {
  var S = _ae.gl, wide = _aeIsPlanet(_ae.target) || _ae.target === 'sun' || _ae.dist > AE_AST_WIDE_DIST;
  if (!wide && !(_aeAst && _aeAst.cloud && _aeAst.cloud.visible)) return;
  if (!_aeAst) { _aeAstLoad(); return; }
  if (!_aeAst.cloud || _aeAst.cloud.parent !== S.scene) {   // a view built again (it gives the GPU back) gets its own
    _aeAst.at = null; _aeAst.fill = null; _aeAst.drawn = 0;
    _aeAst.cloud = _aePointCloud(S.THREE, Math.ceil(_aeAst.n / AE_AST_STRIDE), S.dpr, false, { depthTest: true });
    S.scene.add(_aeAst.cloud);
  }
  _aeAst.cloud.visible = wide;
  if (!wide) return;
  _aeAst.cloud.position.set(sunAt[0], sunAt[1], sunAt[2]);
  // Placed a share a frame (a Kepler solve each: all at once held one frame for 60 ms on a slow phone), the belt
  // filling in over the first frames of the pull back while it is still small.
  if (_aeAst.fill == null) {
    if (_aeAst.at !== null && Math.abs(jde - _aeAst.at) < AE_AST_REPLACE_DAYS) return;
    _aeAst.at = jde; _aeAst.fill = 0;
  }
  var total = Math.ceil(_aeAst.n / AE_AST_STRIDE), end = Math.min(total, _aeAst.fill + AE_AST_PER_FRAME);
  for (var k = _aeAst.fill; k < end; k++) {
    _aeSetPoint(_aeAst.cloud, k, around(_aeAstHelio(_aeAst.el, k * AE_AST_STRIDE, _aeAst.at, _aeAst.epoch)), AE_AST_COLOR, AE_AST_ALPHA, AE_AST_PX);
  }
  _aeAst.drawn = Math.max(_aeAst.drawn || 0, end);
  _aeCommitPoints(_aeAst.cloud, _aeAst.drawn);
  _aeAst.fill = end < total ? end : null;
  if (_aeAst.fill != null) _ae.dirty = true;
}
// ── The probes ──
// space-tracks-v1.json (scripts/build_space_tracks.py, JPL Horizons): Voyager 1 and 2, Pioneer 10 and 11, New
// Horizons, Parker, Juno, Webb, Cassini, Galileo and Europa Clipper as state vectors (AU, AU a day, heliocentric J2000
// ecliptic) at their own steps, a cubic Hermite curve through them within the table's tolerance; Pluto and Ceres
// beside them. Fetched when first out among the planets. Each probe flying on the shown date is a dot with its name
// and the path it has flown, placed as the planets are; a tap flies there and its card says where it is and what it
// last did.
var AE_TRACKS_URL = _almAsset('/static/earth/space-tracks-v1.json');
// How far round a planet (AU) a probe is placed in that planet's own frame rather than by the drawn scale.
var AE_PROBE_REACH_AU = { earth: 0.05, mercury: 0.01, venus: 0.02, mars: 0.02, jupiter: 0.5, saturn: 0.4, uranus: 0.2, neptune: 0.3, pluto: 0.05 };
var AE_PROBE_COLOR = [0.43, 0.9, 0.85] /* AE_PROBE_HEX */, AE_PROBE_PX = 5, AE_PROBE_CAPACITY = 16;
var AE_PROBE_SURFACE = 0.02;          // a probe is a point: the camera circles it this far in, at most
var AE_PROBE_VIEW_DIST = 60;          // Earth radii: a flight to a probe ends this far from it
var AE_PROBE_VIEW_LIFT = 0.35;        // and looks at it from this far above its path (tan of the angle)
var AE_PROBE_FRAME_NEAR = 1.15, AE_PROBE_FRAME_MAX = 4000;   // a body this near the probe is framed with it, up to this far
var AE_TRAIL_TAIL = 0.1;               // how faint a probe's path is at its start (it fades up to the probe)
var AE_TRAIL_POINTS = 240, AE_TRAIL_REDRAW_DAYS = 10, AE_TRAIL_ALPHA = 0.55, AE_TRAIL_FAINT = 0.12;
var _aeTracks = null, _aeTracksLoading = null, _aeProbePos = {}, _aeProbeHeading = {};
var AE_PROBE_HEADING_DAYS = 30;
function _aeTracksLoad() {
  if (_aeTracks || _aeTracksLoading || typeof fetch !== 'function') return;
  _aeTracksLoading = fetch(AE_TRACKS_URL).then(function (r) { if (!r.ok) throw new Error('tracks'); return r.json(); }).then(function (d) {
    _aeTracks = { tracks: d.tracks || {}, planets: d.planets || {}, probes: [] };
    _aeTracks.probes = Object.keys(_aeTracks.tracks).filter(function (k) { return !_aePlanetBody(k); });
    _aeTracks.probes.forEach(function (k) {
      AE_TARGETS[k] = { min: AE_PROBE_SURFACE * 2, max: AE_PROBE_FRAME_MAX, surface: AE_PROBE_SURFACE };
      var m = { body: k, name: function () { return _aeTracks.tracks[k].name; } };
      AE_MARKED.push(m);
      _aeAddMark(m);

    });
    if (_ae) _aeRedraw();
    _aeGoRender();
    if (_ae && _ae.pendingPreset) { var go = _ae.pendingPreset; _ae.pendingPreset = null; _aePreset(go); }
    _aeLinkResume();
  }).catch(function () { _aeTracksLoading = null; _aeGoRender(); });   // no loading row left behind a failed table
}
// Resolves once the table is in and the view has drawn the body in its place (or after AE_PLACED_GIVE_UP_MS): a body whose place comes from
// the table (Pluto and Charon, Ceres, Vesta) has none before, and the draw that gives it one is a frame after the table arrives.
var AE_PLACED_GIVE_UP_MS = 10000, AE_PLACED_POLL_MS = 50;
function _aeBodyPlaced(key) {
  var t0 = performance.now();
  if (!_aeTracks) _aeTracksLoad();
  return new Promise(function (resolve) {
    (function wait() {
      if ((_aeTracks && _aeStBodyNow(key)) || performance.now() - t0 > AE_PLACED_GIVE_UP_MS) { resolve(); return; }
      setTimeout(wait, AE_PLACED_POLL_MS);
    })();
  });
}
// Whether a body's place is read from the table (a dwarf, or a moon of one).
function _aeNeedsTracks(key) {
  var b = _aePlanetBody(key);
  return !!b && !!(b.track || (b.parent && _aeNeedsTracks(b.parent)));
}
function _aeHermite(a, b, jd) {
  var h = b[0] - a[0], t = (jd - a[0]) / h, t2 = t * t, t3 = t2 * t;
  var h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2, out = [0, 0, 0];
  for (var k = 0; k < 3; k++) out[k] = h00 * a[1 + k] + h10 * h * a[4 + k] + h01 * b[1 + k] + h11 * h * b[4 + k];
  return out;
}
// A table's place at jd (TDB, near enough the view's UT for a probe), or null outside its years.
// A retired craft's table has "hold": past its end it stays at the place it ended (its last known place), unless `strict`.
function _aeTrackAt(track, jd, strict) {
  if (!track || jd < track.jd0) return null;
  if (jd > track.jd1) { if (!track.hold || strict) return null; jd = track.jd1; }
  var s = track.s, lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s[mid][0] <= jd) lo = mid; else hi = mid; }
  return _aeHermite(s[lo], s[hi], jd);
}
// Whether the view is somewhere the table is needed: among the planets, on the Sun or a probe, or wide enough to see the belt. The Earth and
// the Moon opened on do not need it (Pluto's place is asked for every frame, so a frame by itself does not count as a reason).
function _aeTracksNeeded() {
  return _aeIsPlanet(_ae.target) || _ae.target === 'sun' || _ae.dist > AE_AST_WIDE_DIST || _aeIsProbe(_ae.target);
}
function _aeTracked(b, jd) {
  if (!_aeTracks) { if (_aeTracksNeeded()) _aeTracksLoad(); return null; }
  return _aeTrackAt(b.track === 'planets' ? _aeTracks.planets[b.eph] : _aeTracks.tracks[b.trackKey], jd);
}
// Where a planet is (heliocentric AU) at any date: the ephemeris, or the table for Pluto.
function _aeHelioOf(b) {
  return function (t) { return b.track ? _aeTracked(b, t) : _ephBodyJ2000(b.eph, t); };
}
// GM in AU^3 a day^2: the Sun's, and each planet's as a fraction of it (IAU 2015 mass ratios).
var AE_GM_SUN = 2.9591220828559115e-4;
var AE_GM_RATIO = { earth: 1 / 332946.05, mercury: 1 / 6023657, venus: 1 / 408523.7, mars: 1 / 3098703.6, jupiter: 1 / 1047.3486,
  saturn: 1 / 3497.902, uranus: 1 / 22902.98, neptune: 1 / 19412.26, pluto: 1 / 136047200 };
var AE_VEL_STEP_DAYS = 0.01;
var AE_TRAIL_ORBIT_FRAC = 0.3;     // a probe going round and round leaves this much of an orbit behind it, fading
var AE_TRAIL_LOOPED = 1.2;          // round its body at least this many times since its table began: it is in orbit
var AE_TRAIL_HELD_DAYS = 180;      // Webb's halo round L2 is about half a year
var AE_FIT_WINDOW_DAYS = 120, AE_FIT_STEPS = 120;   // the stretch searched for its farthest point: longer than Parker's 88-day year
var AE_KEPLER_CLOSE = 0.15;        // one period back within this share of the orbit's far side: it is that ellipse
// A path's place and velocity (AU, AU a day) at jd, by a central difference of its curve.
function _aeStateOf(at, jd) {
  var a = at(jd - AE_VEL_STEP_DAYS), b = at(jd + AE_VEL_STEP_DAYS), h = at(jd);
  return a && b && h ? { r: h, v: _aeScale(_aeSub(b, a), 1 / (2 * AE_VEL_STEP_DAYS)) } : null;
}
// The orbit a state is on round a body of this GM (two-body): null unless it is bound.
function _aeKepler(r, v, mu) {
  var rl = _aeLen(r), v2 = _aeDot(v, v), inv = 2 / rl - v2 / mu;
  if (inv <= 0) return null;
  var a = 1 / inv, hv = _aeCross(r, v), ev = _aeSub(_aeScale(_aeCross(v, hv), 1 / mu), _aeScale(r, 1 / rl)), e = _aeLen(ev);
  if (e >= 1) return null;
  var pdir = e > 1e-9 ? _aeScale(ev, 1 / e) : _aeScale(r, 1 / rl), qdir = _aeNorm(_aeCross(hv, pdir));
  return { a: a, e: e, p: pdir, q: qdir, period: 2 * Math.PI * Math.sqrt(a * a * a / mu) };
}
// A probe's path, drawn the way a person reads it: one going round and round (Parker round the Sun, Juno round
// Jupiter) is its present orbit as one clean ellipse and a short trail of where it has just been, fading behind it;
// one on its way out (the Voyagers, New Horizons) is the whole road it has come. The body it goes round is the
// planet it is within reach of, or the Sun.
function _aeProbeOrbit(t, jd, near) {
  var c = null;
  for (var i = 0; i < (near || []).length; i++) {
    var hp = _aeTrackAt(t, jd);
    if (hp && _aeLen(_aeSub(hp, near[i].h)) < near[i].reach / 2 && AE_GM_RATIO[near[i].key]) { c = near[i]; break; }
  }
  var at = c ? function (x) { var a = _aeTrackAt(t, x), b = c.hAt(x); return a && b ? _aeSub(a, b) : null; } : function (x) { return _aeTrackAt(t, x); };
  // The table is thinned to a tolerance (Juno's to ~0.002 AU, a tenth of its orbit), so a state worked out near the
  // close pass is off by more than the orbit can bear: Juno's period came out anywhere from 20 days to 20 years. Far
  // out, where it moves slowly, the same table is exact enough: the ellipse is fitted at the farthest point of the
  // last stretch of its path.
  var far = jd, farR = -1;
  for (var k = 0; k <= AE_FIT_STEPS; k++) {
    var x = jd - AE_FIT_WINDOW_DAYS * k / AE_FIT_STEPS, q = at(x), rq = q ? _aeLen(q) : -1;
    if (rq > farR) { farR = rq; far = x; }
  }
  var st = _aeStateOf(at, far);
  if (!st) return null;
  var o = _aeKepler(st.r, st.v, AE_GM_SUN * (c ? AE_GM_RATIO[c.key] : 1));
  if (!o || (jd - t.jd0) < AE_TRAIL_LOOPED * o.period) {
    // Not on a two-body orbit, but held near a planet all the same (Webb round the Sun-Earth L2 point): a trail of its
    // last loop, no ellipse.
    return c && (jd - t.jd0) > AE_TRAIL_HELD_DAYS ? { trail: AE_TRAIL_HELD_DAYS, round: c.key } : null;
  }
  // Two-body, nearly: one period before that far point it was there too (Parker, Juno). If not, the ellipse would be a
  // guess.
  var back = at(far - o.period);
  if (!back || _aeLen(_aeSub(back, st.r)) > AE_KEPLER_CLOSE * o.a * (1 + o.e)) return c ? { trail: AE_TRAIL_HELD_DAYS, round: c.key } : null;
  o.round = c ? c.key : 'sun'; o.trail = o.period * AE_TRAIL_ORBIT_FRAC;
  return o;
}
function _aeUpdateProbes(jd, place, near) {
  var S = _ae.gl;
  if (!_aeTracks) return;
  if (!S.probes || S.probes.cloud.parent !== S.scene) {
    S.probes = { cloud: _aePointCloud(S.THREE, AE_PROBE_CAPACITY, S.dpr, true, { depthTest: true }), trails: {}, orbits: {} };
    S.scene.add(S.probes.cloud);
  }
  var out = S.probes, n = 0;
  _aeProbePos = {};
  _aeTracks.probes.forEach(function (k) {
    var t = _aeTracks.tracks[k], h = _aeTrackAt(t, jd), trail = out.trails[k], ring = out.orbits[k], lift = null;
    if (!h && _ae.mission && typeof _amProbeLift === 'function') {   // before its table, a mission's Launch has the probe lifting off the Earth
      var h0 = _aeTrackAt(t, t.jd0), p0 = h0 && place(h0);
      lift = p0 && _amProbeLift(k, p0);
      if (lift) h = h0;
    }
    if (!trail) {
      trail = out.trails[k] = _aeLine(S.THREE, S.THREE.Line, AE_TRAIL_POINTS, 0xffffff, AE_TRAIL_ALPHA);
      trail.geometry.setAttribute('color', new S.THREE.BufferAttribute(new Float32Array(AE_TRAIL_POINTS * 4), 4));
      trail.material.vertexColors = true;
      S.scene.add(trail);
      ring = out.orbits[k] = _aeLine(S.THREE, S.THREE.LineLoop, AE_ORBIT_POINTS, 0x6ee7d8, AE_TRAIL_ALPHA);
      S.scene.add(ring);
    }
    if (!h) { trail.visible = ring.visible = false; return; }
    var pos = _aeProbePos[k] = lift || place(h);
    var ahead = _aeTrackAt(t, (lift ? t.jd0 : jd) + AE_PROBE_HEADING_DAYS, true);   // where it will be: its heading as drawn (none for a retired craft held at its last place)
    _aeProbeHeading[k] = ahead ? _aeSub(place(ahead), lift ? place(h) : pos) : null;
    _aeSetPoint(out.cloud, n++, pos, AE_PROBE_COLOR, _aeProbeCraftDot(k), AE_PROBE_PX);
    if (t.hold && jd > t.jd1) { trail.visible = ring.visible = false; return; }   // retired: it goes nowhere, so there is no path to draw
    // Only the path of the probe gone to: others' paths crossed the Planets view as stray lines, and near a body they
    // run past the camera. Its own stays beside its model, fading out as every orbit does (_aeOrbitShow).
    // The probe in view (flown to or selected) always shows the road it has travelled, whatever the Orbits setting; the Planets view and the Sun's own view are the exceptions.
    var line = _aeOrbitShow(k) || (_ae.target === k && !_aeWideView() ? _aeSunLineFade() : 0), shown = _ae.target === k && line > 0;
    var alpha = (_ae.target === k ? AE_TRAIL_ALPHA : AE_TRAIL_FAINT) * _aeFadeU.value * line;
    trail.material.opacity = ring.material.opacity = alpha;
    // Which orbit it is on is worked out as it moves (a probe in a tight orbit, Juno's is a month, every fiftieth of it);
    // the lines themselves are placed afresh each frame they are shown: they run through the drawn scale's squeeze and
    // the near-a-planet blend, both of which move with the date, so lines kept from an earlier date drifted off the probe.
    var o = trail.orbit;
    var every = o ? Math.min(AE_TRAIL_REDRAW_DAYS, o.trail / 15) : AE_TRAIL_REDRAW_DAYS;
    if ((trail.at == null || Math.abs(jd - trail.at) >= every) && _aeMayRedraw()) {
      trail.at = jd;
      o = trail.orbit = _aeProbeOrbit(t, jd, near);
    }
    if (shown) {
      var arr = trail.geometry.attributes.position.array, col = trail.geometry.attributes.color.array;
      var from = o ? Math.max(t.jd0, jd - o.trail) : t.jd0;
      // Only the road already travelled, from `from` (its launch, or a stretch of its orbit) to now: the last point is the probe itself (the very place
      // its marker and model stand), and nothing is drawn beyond it. Fading back toward the start.
      // The points are kept relative to the craft (the line itself stands at the craft, in doubles): the GPU holds them as
      // 32-bit numbers, and at a probe's distance from the Sun one of those steps is hundreds of kilometres, so beside the
      // craft the line stuttered and slid off it when turned.
      var times = trail.times || (trail.times = new Float64Array(AE_TRAIL_POINTS));
      trail.position.set(pos[0], pos[1], pos[2]);
      for (var i = 0; i < AE_TRAIL_POINTS; i++) {
        var f = i / (AE_TRAIL_POINTS - 1), tv = i === AE_TRAIL_POINTS - 1 ? jd : from + (jd - from) * f, q = i === AE_TRAIL_POINTS - 1 ? pos : place(_aeTrackAt(t, tv) || h);
        times[i] = tv;
        arr[i * 3] = q[0] - pos[0]; arr[i * 3 + 1] = q[1] - pos[1]; arr[i * 3 + 2] = q[2] - pos[2];
        col[i * 4] = AE_PROBE_COLOR[0]; col[i * 4 + 1] = AE_PROBE_COLOR[1]; col[i * 4 + 2] = AE_PROBE_COLOR[2];
        col[i * 4 + 3] = o ? f * f : AE_TRAIL_TAIL + (1 - AE_TRAIL_TAIL) * f;
      }
      trail.geometry.attributes.position.needsUpdate = true;
      trail.geometry.attributes.color.needsUpdate = true;
      trail.geometry.setDrawRange(0, AE_TRAIL_POINTS);
    }
    trail.visible = shown;
    ring.visible = false;   // (the ellipse it is on is the way ahead: not drawn)
  });
  _aeCommitPoints(out.cloud, n);
  if (_ae.linkHeld) setTimeout(_aeLinkResume, 0);   // a link to a probe waits for its place, which only a frame gives
}
function _aeIsProbe(key) { return !!(_aeTracks && _aeTracks.tracks[key] && !_aePlanetBody(key)); }
// The card a flight arrives with, the same for every destination: its name, one line of what it is (its size and how
// long it takes to go round), and where it is from here (how far, and how long light takes). A probe adds where it is
// from the Sun and the last things it did; the ISS, whether it is in the Earth's shadow and when the Sun comes back.
var AE_GM_EARTH_KM3_S2 = 398600.4418;   // the Earth's GM, km^3/s^2: the ISS's period from its height
var AE_MOON_SIDEREAL_DAYS = 27.321661;  // the Moon round the Earth, against the stars
var AE_ISS_SUN_STEP_MS = 30000, AE_ISS_SUN_LOOK_MS = 2 * 3600000;   // how finely, and how far ahead, the ISS's next sunlight is looked for
function _aeKmText(km) { return _aeLenText(km); }
function _aeAuText(au) { return _orrNum(au, null, au < 10 ? 2 : 1) + ' AU'; }
// The ISS is in the Earth's shadow when it is behind the Earth from the Sun and within its cylinder (Earth radii).
function _aeInShadow(pos, sun) {
  var s = _aeNorm(sun), along = _aeDot(pos, s);
  return along < 0 && _aeLen(_aeSub(pos, _aeScale(s, along))) < 1;
}
// The satellite for the station, or a craft (`key`, AE_ORBITERS) among the elements now drawn.
function _aeSatOf(key) { return _ae.sats && _ae.sats.list.filter(function (x) { return key ? x.craft === key : x.iss; })[0]; }
// How long from ms until the satellite is out of the Earth's shadow (0 when it is in sunlight), or null when it is not within the look-ahead.
function _aeSunlightIn(s, ms) {
  var sc = _ae.scene;
  if (!s || !sc) return null;
  var eqeq = _aeEqEq(sc);
  for (var t = ms; t <= ms + AE_ISS_SUN_LOOK_MS; t += AE_ISS_SUN_STEP_MS) {
    var st = _aeSatAt(s, t, eqeq);
    if (!st) return null;
    if (!_aeInShadow(st.pos, sc.sun)) return t - ms;
  }
  return null;
}
// What a place's card says, compact on a phone (a third of the screen at most): its name, one line of what it is, one
// of where it is from here, and what to do there. Every name links to its article where the library has it.
function _aeArrival(k, ms) {
  var jd = ms / MS_PER_DAY + JD_UNIX_EPOCH, sc = _ae.scene, out = { fact: '', where: '', note: '', links: [] };
  var earthAU = typeof _ephBodyJ2000 === 'function' ? _ephBodyJ2000('Earth', jd) : null;
  var far = function (au) { return _aeT('alm_card_from_earth', { d: _aeAuText(au) }) + ' · ' + _aeT('alm_card_light', { t: _orrFmtSpan(_lightDelaySeconds(au)) }); };
  if (_aeIsProbe(k)) {
    var t = _aeTracks.tracks[k], h = _aeTrackAt(t, jd), last = (t.events || []).filter(function (e) { return e[0] <= jd; }).slice(-1)[0];
    if (last) out.fact = _aeT('alm_probe_ev_' + last[1], { body: last[2] ? (_tLookup('alm_planet_' + last[2].toLowerCase(), last[2])) : '' }) + ' · ' +
      _aeFmtDate((last[0] - JD_UNIX_EPOCH) * MS_PER_DAY);
    if (h) out.where = _aeT('alm_probe_from_sun', { au: _aeAuText(_aeLen(h)) });
    if (AE_ARRIVAL_EXTRA[k]) out.links.push(AE_ARRIVAL_EXTRA[k]);
    return out;
  }
  if (k === 'iss' || _aeIsOrbiter(k)) {   // the station, or a craft round the Earth: how long a lap takes, how high it is, whether the Earth shades it
    var pos = k === 'iss' ? _ae.issPos : _aeCraftPosOf(k), sat = k === 'iss' ? _aeSatOf() : _aeSatOf(k);
    if (!pos) return out;
    var r = _aeLen(pos) * AE_EARTH_RADIUS_KM, period = sat && k !== 'iss' ? AE_MINUTES_PER_DAY * 60 / sat.omm.MEAN_MOTION : 2 * Math.PI * Math.sqrt(r * r * r / AE_GM_EARTH_KM3_S2);
    out.fact = _aeT('alm_card_round_earth', { t: _orrFmtSpan(period) });
    out.where = _aeT('alm_card_up', { d: _aeKmText(r - AE_EARTH_RADIUS_KM) });
    if (sc && _aeInShadow(pos, sc.sun)) {
      var back = _aeSunlightIn(sat, ms);
      out.note = back == null ? _aeT('alm_card_shadow') : _aeT('alm_card_shadow_until', { t: _orrFmtSpan(back / 1000) });
    }
    return out;
  }
  if (k === 'moon') {
    out.fact = _aeT('alm_card_across', { d: _aeKmText(2 * AE_MOON_RADIUS_KM) }) + ' · ' +
      _aeT('alm_card_round_earth', { t: _orrFmtSpan(AE_MOON_SIDEREAL_DAYS * SECONDS_PER_DAY) });
    if (sc) {
      var km = _aeLen(sc.moon) * AE_EARTH_RADIUS_KM;
      out.where = _aeT('alm_card_from_earth', { d: _aeKmText(km) }) + ' · ' + _aeT('alm_card_light', { t: _orrFmtSpan(km / AU_KM * LIGHT_SECONDS_PER_AU) });
    }
    return out;
  }
  if (k === 'earth') {
    out.fact = _aeT('alm_card_across', { d: _aeKmText(2 * AE_EARTH_RADIUS_KM) }) + ' · ' +
      _aeT('alm_card_round_sun', { t: _orrFmtSpan(_aeYearDays('Earth') * SECONDS_PER_DAY) });
    if (earthAU) out.where = _aeT('alm_probe_from_sun', { au: _aeAuText(_aeLen(earthAU)) });
    return out;
  }
  if (k === 'sun') {
    out.fact = _aeT('alm_card_across', { d: _aeKmText(2 * AE_SUN_RADIUS_KM) });
    if (earthAU) out.where = far(_aeLen(earthAU));
    return out;
  }
  var b = _aePlanetBody(k);
  if (!b) return out;
  var parent = b.parent ? _aePlanetBody(b.parent) : null, orb = parent ? null : (typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]);
  out.fact = _aeT('alm_card_across', { d: _aeKmText(2 * b.km) });
  if (parent) out.fact += ' · ' + _aeT('alm_card_circles', { body: _aeBodyName(parent), t: _orrFmtSpan(360 / b.orbit[2] * SECONDS_PER_DAY) });
  else if (orb) out.fact += ' · ' + _aeT('alm_card_round_sun', { t: _orrFmtSpan(Math.pow(orb.a, 1.5) * SECONDS_PER_JULIAN_YEAR) });
  var hh = _aeHelioOf(parent || b)(jd);
  if (hh && earthAU) out.where = far(_aeLen(_aeSub(hh, earthAU)));
  return out;
}
// A place's own article key: the planets, moons, dwarf planets, the Sun and Moon under planet:, the probes under probe:.
function _aeArrivalKey(k) {
  if (k === 'iss') return 'term:iss';
  if (_aeIsOrbiter(k)) return AE_ORBITERS[k].link || 'probe:' + k;   // (its article, where the library has one)
  if (_aeIsProbe(k)) return 'probe:' + k;
  return 'planet:' + k;
}
// More to read from a card than its name: Voyager's record.
// More from a card than its name: Voyager's record opens the Almanac's own Golden Record (its pictures and sounds),
// the article only where that section is not here.
var AE_GOLDEN_RECORD = { key: 'ev:goldenrecord', label: 'alm_card_golden_record', open: '_scrollToGoldenRecord' };
var AE_ARRIVAL_EXTRA = { voyager1: AE_GOLDEN_RECORD, voyager2: AE_GOLDEN_RECORD };

// ── A body's facts ──
// The i opens a place's sheet (a bottom sheet on a phone, a side panel on a wide screen): size, mass,
// gravity, escape velocity, day, year, tilt, where it is now, moons, temperature, air, who found it, and its article in
// the library. Nothing is repeated that the view already knows: radii, poles, turning rates, orbits and the year are the
// view's own constants, where it is now comes from the ephemeris for the shown date, and what only a table can say
// (mass, gravity, escape velocity, temperatures, counts) is AE_BODY_FACTS: NASA's NSSDC Planetary, Sun, Moon, Pluto and
// Satellite Fact Sheets (read 2026-11-06: planetary sheet updated 2025-03-18, Galilean sheet 2016-04-18, Moon 2024-01-11) and
// NASA Science's moon pages for Jupiter 115, Saturn 293 and Uranus 29 (as of August to September 2026; the planetary sheet's
// own 95, 274 and 28 are older), Neptune 16, Pluto 5, Mars 2. Public domain. Every number the sheet shows is
// listed, with its source, in the Almanac's Constants (the Bodies and Axes pages: almanac-tables.js), and
// tests/test_almanac_bodyinfo_browser.py fails when the sheet shows one the pages do not.
// Fields: mass kg, gravity m/s2, escape km/s, solarDayH hours noon to noon, periKm/apoKm closest and farthest from the
// Sun (the Moon: from the Earth), tilt degrees where the view does not work it out, tempC mean, yearDays where the
// orrery has no elements, moons known, atmo a phrase's key, found who and when.
var AE_BODY_FACTS = {
  sun: { mass: 1.9885e30, gravity: 274, escape: 617.6, solarDayH: 654.6, tilt: 7.25, tempC: 5499, atmo: 'plasma' },
  mercury: { moons: 0, mass: 3.301e23, gravity: 3.7, escape: 4.3, solarDayH: 4222.6, periKm: 46000000, apoKm: 69800000, tempC: 167, atmo: 'exo' },
  venus: { moons: 0, mass: 4.867e24, gravity: 8.9, escape: 10.4, solarDayH: 2802, periKm: 107500000, apoKm: 108900000, tempC: 464, atmo: 'thick_co2' },
  earth: { mass: 5.972e24, gravity: 9.8, escape: 11.2, solarDayH: 24, periKm: 147100000, apoKm: 152100000, tempC: 15, moons: 1, atmo: 'air' },
  moon: { mass: 7.346e22, gravity: 1.62, escape: 2.38, solarDayH: 708.7, periKm: 363300, apoKm: 405500, tilt: 6.68, tempC: -20, atmo: 'exo' },
  mars: { mass: 6.417e23, gravity: 3.7, escape: 5, solarDayH: 24.7, periKm: 206700000, apoKm: 249300000, tempC: -65, moons: 2, atmo: 'thin_co2' },
  jupiter: { mass: 1.898e27, gravity: 23.1, escape: 59.5, periKm: 740600000, apoKm: 816400000, tempC: -110, moons: 115, atmo: 'h2he' },
  saturn: { mass: 5.683e26, gravity: 9, escape: 35.5, periKm: 1357600000, apoKm: 1506500000, tempC: -140, moons: 293, atmo: 'h2he' },
  uranus: { mass: 8.681e25, gravity: 8.7, escape: 21.3, periKm: 2732700000, apoKm: 3001400000, tempC: -195, moons: 29, atmo: 'h2he_ch4', found: { by: 'William Herschel', year: 1781 } },
  neptune: { mass: 1.024e26, gravity: 11, escape: 23.5, periKm: 4471100000, apoKm: 4558900000, tempC: -200, moons: 16, atmo: 'h2he_ch4', found: { by: 'Le Verrier, Galle', year: 1846 } },
  pluto: { mass: 1.303e22, gravity: 0.7, escape: 1.3, periKm: 4435800000, apoKm: 7304300000, tempC: -225, moons: 5, tilt: 122.5, yearDays: 90560, atmo: 'thin_n2', found: { by: 'Clyde Tombaugh', year: 1930 } },
  ceres: { mass: 9.38e20, gravity: 0.27, escape: 0.51, periKm: 381400000, apoKm: 445800000, tempC: -105, tilt: 4, yearDays: 1680.5, atmo: 'exo', found: { by: 'Giuseppe Piazzi', year: 1801 } },
  io: { mass: 8.932e22, gravity: 1.8, escape: 2.56, tempC: -155, atmo: 'thin_so2', found: { by: 'Galileo Galilei', year: 1610 } },
  europa: { mass: 4.8e22, gravity: 1.31, escape: 2.02, tempC: -170, atmo: 'thin_o2', found: { by: 'Galileo Galilei', year: 1610 } },
  ganymede: { mass: 1.482e23, gravity: 1.43, escape: 2.74, tempC: -160, atmo: 'thin_o2', found: { by: 'Galileo Galilei', year: 1610 } },
  callisto: { mass: 1.076e23, gravity: 1.24, escape: 2.44, tempC: -155, atmo: 'thin_co2', found: { by: 'Galileo Galilei', year: 1610 } },
  titan: { mass: 1.345e23, gravity: 1.35, escape: 2.64, tempC: -179, atmo: 'thick_n2', found: { by: 'Christiaan Huygens', year: 1655 } },
  vesta: { mass: 2.59e20, gravity: 0.25, escape: 0.36, periKm: 322000000, apoKm: 384500000, tilt: 29, yearDays: 1325.5, atmo: 'exo', found: { by: 'Heinrich Olbers', year: 1807 } },
  mimas: { mass: 3.75e19, gravity: 0.064, escape: 0.159, tempC: -209, atmo: 'exo', found: { by: 'William Herschel', year: 1789 } },
  enceladus: { mass: 1.08e20, gravity: 0.113, escape: 0.239, tempC: -198, atmo: 'exo', found: { by: 'William Herschel', year: 1789 } },
  tethys: { mass: 6.18e20, gravity: 0.145, escape: 0.394, tempC: -187, atmo: 'exo', found: { by: 'Giovanni Cassini', year: 1684 } },
  dione: { mass: 1.095e21, gravity: 0.232, escape: 0.51, tempC: -186, atmo: 'exo', found: { by: 'Giovanni Cassini', year: 1684 } },
  rhea: { mass: 2.306e21, gravity: 0.264, escape: 0.635, tempC: -174, atmo: 'exo', found: { by: 'Giovanni Cassini', year: 1672 } },
  iapetus: { mass: 1.806e21, gravity: 0.223, escape: 0.573, tempC: -143, atmo: 'exo', found: { by: 'Giovanni Cassini', year: 1671 } },
  triton: { mass: 2.14e22, gravity: 0.779, escape: 1.455, tempC: -235, atmo: 'thin_n2', found: { by: 'William Lassell', year: 1846 } },
  charon: { mass: 1.586e21, gravity: 0.288, escape: 0.58, tempC: -220, atmo: 'exo', found: { by: 'James Christy', year: 1978 } },
  phobos: { mass: 1.0659e16, gravity: 0.0057, escape: 0.0114, tempC: -4, atmo: 'exo', found: { by: 'Asaph Hall', year: 1877 } }
};
var AE_KM_PER_MILE = 1.609344, AE_G0 = 9.80665, AE_EARTH_MASS_KG = 5.9722e24;
var AE_ISS_LAUNCH_MS = Date.UTC(1998, 10, 20, 12);   // Zarya, the first module (a day is told at its noon, so it reads the same in every zone)
// Miles where the Almanac's units are feet (the tides' setting, SK.ALM_UNITS, or its guess), kilometres elsewhere.
function _aeImperial() {
  var v = _rawGet(SK.ALM_UNITS);
  if (v === 'ft' || v === 'm') return v === 'ft';
  if (typeof _atUnits === 'function') return _atUnits() === 'ft';
  return /-(US|LR|MM)$/i.test((typeof navigator !== 'undefined' && navigator.language) || '');
}
function _aeLenText(km, frac) {
  var mi = _aeImperial();
  return _orrNum(mi ? km / AE_KM_PER_MILE : km, mi ? 'mile' : 'kilometer', frac || 0);
}
// A distance as a person reads it aloud, for a figure that changes as it is watched (the craft's readout): exact under
// AE_READ_EXACT, then two significant figures ("150,000 mi"), and from a million the word ("1.5 million mi", in the reader's language).
var AE_READ_EXACT = 10000, AE_READ_WORD = 1e6, AE_READ_SIG = 2;
function _aeLenRead(km) {
  var mi = _aeImperial(), n = mi ? km / AE_KM_PER_MILE : km, a = Math.abs(n);
  if (a < AE_READ_EXACT) return _aeLenText(km);
  var frac = a / Math.pow(1000, Math.floor(Math.log10(a) / 3)) < 10 ? 1 : 0;   // "1.5 million", "612 million": a decimal only on a single figure
  return _orrFormatter('read|' + (a < AE_READ_WORD ? 'sig' : 'word' + frac) + '|' + (mi ? 'mi' : 'km'), function (lang) {
    var opts = { style: 'unit', unit: mi ? 'mile' : 'kilometer', unitDisplay: 'short' };
    if (a < AE_READ_WORD) opts.maximumSignificantDigits = AE_READ_SIG;
    else { opts.notation = 'compact'; opts.compactDisplay = 'long'; opts.maximumFractionDigits = frac; }
    try { return new Intl.NumberFormat(lang, opts); }
    catch (e) { return { format: function (x) { return _orrNum(x, null, 0) + (mi ? ' mi' : ' km'); } }; }
  }).format(n);
}
// A long distance short: "809M km" (kilometre or mile, compact in the reader's language).
function _aeFarText(km) {
  var mi = _aeImperial();
  return _orrFormatter('far|' + (mi ? 'mi' : 'km'), function (lang) {
    var opts = { style: 'unit', unit: mi ? 'mile' : 'kilometer', unitDisplay: 'short', notation: 'compact', maximumFractionDigits: 1 };
    try { return new Intl.NumberFormat(lang, opts); }
    catch (e) { return { format: function (x) { return _orrNum(x, null, 0) + (mi ? ' mi' : ' km'); } }; }
  }).format(mi ? km / AE_KM_PER_MILE : km);
}
// A day's length: hours and minutes below ten days, then days with a decimal (the Moon's 29.5, Mercury's 58.6).
function _aeDayText(sec) { return sec < 10 * SECONDS_PER_DAY ? _orrFmtSpan(sec) : _orrNum(sec / SECONDS_PER_DAY, 'day', 1); }
function _aeSigText(n, digits) {
  return _orrFormatter('sig|' + digits, function (lang) {
    try { return new Intl.NumberFormat(lang, { maximumSignificantDigits: digits }); }
    catch (e) { return { format: function (x) { return String(+x.toPrecision(digits)); } }; }
  }).format(n);
}
// A speed (km/s as the sheets give it), in the person's units.
function _aeSpeedText(kms, frac) {
  var mi = _aeImperial();
  return _orrNum(mi ? kms / AE_KM_PER_MILE : kms, mi ? 'mile-per-second' : 'kilometer-per-second', frac);
}
// A speed in the person's units, an hour at a time (the picture's own: 36,000 km/h reads where 10 km/s does not).
function _aeSpeedHourText(kms) {
  var mi = _aeImperial();
  return _orrNum((mi ? kms / AE_KM_PER_MILE : kms) * SECONDS_PER_HOUR, mi ? 'mile-per-hour' : 'kilometer-per-hour', 0);
}
function _aeTempText(c) {
  var f = _aeImperial();
  return _orrNum(f ? c * 9 / 5 + 32 : c, f ? 'fahrenheit' : 'celsius', 0);
}
// A mass: 5.97 x 10^24 kg (the exponent raised), and in Earths.
function _aeMassHtml(kg) {
  var e = Math.floor(Math.log10(kg)), m = kg / Math.pow(10, e);
  var earths = kg / AE_EARTH_MASS_KG;
  var txt = _orrFormatter('mass', function (lang) {
    try { return new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (x) { return { format: function (v) { return v.toFixed(2); } }; }
  }).format(m) + ' × 10<sup>' + e + '</sup> kg';
  return txt + (Math.abs(earths - 1) < 0.005 ? '' : '<span>' + _almEsc(_aeT('alm_bi_earths', { n: _aeSigText(earths, earths < 10 ? 3 : earths < 1000 ? 4 : 3) })) + '</span>');
}
// What a key's facts stand on: a radius and, for those that turn, the IAU pole and rate (the view's own).
function _aeFactBase(k) {
  if (k === 'sun') return { km: AE_SUN_RADIUS_KM, pole: AE_SUN_POLE };
  if (k === 'earth') return AE_SPIN_EARTH;
  if (k === 'moon') return { km: AE_MOON_RADIUS_KM, siderealDays: AE_MOON_SIDEREAL_DAYS };
  return _aePlanetBody(k);
}
// Whether a key has a sheet: the Sun, the Earth and Moon, the planets, moons and dwarfs, the probes, the station.
var AE_INFO_SITE = 'site-facts';   // the facts sheet's key for a visit's own (almanac-sites.js _asInfoHtml), not a body's
function _aeHasFacts(k) { return !!k && (k === AE_INFO_SITE ? !!(_ae.site && _ae.site.def) : k === 'iss' || _aeIsCraft(k) || !!_aeFactBase(k)); }
function _aeInfoName(k) {
  if (k === 'iss') return _aeT('alm_earth_iss_name');
  if (_aeIsOrbiter(k)) return AE_ORBITERS[k].name;
  if (_aeIsProbe(k)) return _aeTracks.tracks[k].name;
  if (k === 'sun') return _aeT('alm_sun');
  if (k === 'moon') return _aeT('alm_moon');
  if (k === 'earth') return _tp('Earth');
  var b = _aePlanetBody(k);
  return b ? _aeBodyName(b) : k;
}
// The rows of a body's sheet at ms: [{ id, label, html, live }] (html is built here, escaped; live: it changes with the date).
function _aeInfoRows(k, ms) {
  var rows = [], jd = ms / MS_PER_DAY + JD_UNIX_EPOCH;
  var add = function (id, label, html, live) { if (html) rows.push({ id: id, label: label, html: html, live: !!live }); };
  var esc = _almEsc, line = function (t) { return '<span>' + esc(t) + '</span>'; };
  var far = function (km) { return esc(_aeFarText(km)); };
  // How far it is from the Earth now, and what that is in light.
  var fromEarth = function (au) {
    return esc(_aeAuText(au)) + ' · ' + far(au * AU_KM) + line(_aeT('alm_card_light', { t: _orrFmtSpan(_lightDelaySeconds(au)) }));
  };
  var earthH = typeof _ephBodyJ2000 === 'function' ? _ephBodyJ2000('Earth', jd) : null;
  if (k === 'iss' || _aeIsCraft(k)) { _aeProbeRows(k, jd, earthH, add, esc, line, far, fromEarth); return rows; }
  var b = _aeFactBase(k), parent = b.parent ? _aePlanetBody(b.parent) : null, f = AE_BODY_FACTS[k] || {};
  add('diameter', _aeT('alm_bi_diameter'), esc(_aeLenText(2 * b.km)));
  if (f.mass) add('mass', _aeT('alm_bi_mass'), _aeMassHtml(f.mass));
  if (f.gravity) add('gravity', _aeT('alm_bi_gravity'), esc(_aeSigText(f.gravity, 3) + ' m/s²') + line(_aeSigText(f.gravity / AE_G0, 3) + ' g'));
  if (f.escape) add('escape', _aeT('alm_bi_escape'), esc(_aeSpeedText(f.escape, 1)));
  // The day: the turn against the stars (a moon keeps one face to its planet: its orbit), and noon to noon where it differs.
  var dayS = b.pole ? 360 / Math.abs(b.pole[3]) * SECONDS_PER_DAY : b.siderealDays ? b.siderealDays * SECONDS_PER_DAY : b.orbit ? 360 / b.orbit[2] * SECONDS_PER_DAY : 0;
  if (dayS) {
    var back = b.pole && b.pole[3] < 0;
    add('day', _aeT('alm_bi_day'), esc(_aeT('alm_bi_day_sidereal', { t: _aeDayText(dayS) })) +
      (f.solarDayH ? line(_aeT('alm_bi_day_solar', { t: _aeDayText(f.solarDayH * SECONDS_PER_HOUR) })) : '') + (back ? line(_aeT('alm_spin_retro')) : ''));
  }
  // The year, or for a moon its orbit: from the orrery's own elements, the table for the dwarfs.
  if (parent) add('year', _aeT('alm_bi_orbit_of', { body: _aeBodyName(parent) }), esc(_orrFmtSpan(360 / b.orbit[2] * SECONDS_PER_DAY)));
  else if (k === 'moon') add('year', _aeT('alm_bi_orbit_of', { body: _tp('Earth') }), esc(_orrFmtSpan(AE_MOON_SIDEREAL_DAYS * SECONDS_PER_DAY)));
  else if (b.eph && typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]) add('year', _aeT('alm_bi_year'), esc(_orrFmtSpan(_aeYearDays(b.eph) * SECONDS_PER_DAY)));
  else if (f.yearDays) add('year', _aeT('alm_bi_year'), esc(_orrFmtSpan(f.yearDays * SECONDS_PER_DAY)));
  // The tilt of the spin from the orbit's normal: worked out for the eight (the view's own, as Side by side), else the table's.
  var tilt = f.tilt;
  if (AE_SPIN_ORDER.indexOf(k) >= 0) { try { tilt = _aeSpinFacts(_aeSpinBody(k), jd).tiltDeg; } catch (e) {} }
  if (typeof tilt === 'number') add('tilt', _aeT('alm_bi_tilt'), esc(_orrNum(tilt, null, tilt < 1 ? 2 : 1) + '°'));
  // Where it is now. A moon is its planet's distance from the Sun and Earth, as its card says; its own is from the planet.
  var host = parent || b, hh = k === 'moon' || k === 'earth' ? earthH : k === 'sun' ? [0, 0, 0] : _aeHelioOf(host)(jd);
  if (parent) add('from_parent', _aeT('alm_bi_from_parent', { body: _aeBodyName(parent) }), esc(_aeLenText(b.orbit[0])));
  if (k === 'moon' && _ae.scene) {
    add('from_earth', _aeT('alm_bi_from_earth'), esc(_aeLenText(_aeLen(_ae.scene.moon) * AE_EARTH_RADIUS_KM)), true);
    if (f.periKm) add('range', _aeT('alm_bi_range_earth'), esc(_aeLenText(f.periKm) + ' – ' + _aeLenText(f.apoKm)));
  } else if (k === 'sun' && earthH) {
    add('from_earth', _aeT('alm_bi_from_earth'), fromEarth(_aeLen(earthH)), true);
  } else if (hh && k !== 'sun') {
    add('from_sun', _aeT('alm_bi_from_sun'), esc(_aeAuText(_aeLen(hh))) + ' · ' + far(_aeLen(hh) * AU_KM), true);
    if (f.periKm) add('range', _aeT('alm_bi_range_sun'), esc(_aeFarText(f.periKm) + ' – ' + _aeFarText(f.apoKm)));
    if (k !== 'earth' && earthH) add('from_earth', _aeT('alm_bi_from_earth'), fromEarth(_aeLen(_aeSub(hh, earthH))), true);
  }
  if (typeof f.moons === 'number') add('moons', _aeT('alm_bi_moons'), esc(_orrNum(f.moons, null, 0)));
  if (typeof f.tempC === 'number') add('temp', _aeT('alm_bi_temp'), esc(_aeTempText(f.tempC)));
  if (f.atmo) add('atmo', _aeT('alm_bi_atmo'), esc(_aeT('alm_bi_atmo_' + f.atmo)));
  if (f.found) add('found', _aeT('alm_bi_found'), esc(_aeT('alm_bi_found_by', { by: f.found.by, year: f.found.year })));
  return rows;
}
// A probe's or the station's rows: launch, mission, where it is and how fast it goes now.
function _aeProbeRows(k, jd, earthH, add, esc, line, far, fromEarth) {
  if (k === 'iss' || _aeIsOrbiter(k)) {   // the station (a circle at its height) and the craft round the Earth (their own speed and lap)
    var iss = k === 'iss', orb = iss ? null : _aeOrbiter[k], at = iss ? _ae.issPos : orb && orb.pos, sat = iss ? _aeSatOf() : _aeSatOf(k);
    add('mission', _aeT('alm_bi_mission'), esc(_aeT('alm_bi_mission_' + k)));
    _aeCraftRows(k, iss ? AE_ISS_LAUNCH_MS : AE_ORBITERS[k].launchMs, jd, add, esc);
    if (at) {
      var r = _aeLen(at) * AE_EARTH_RADIUS_KM, round = 2 * Math.PI * Math.sqrt(r * r * r / AE_GM_EARTH_KM3_S2);
      add('height', _aeT('alm_bi_height'), esc(_aeLenText(r - AE_EARTH_RADIUS_KM)), true);
      add('speed', _aeT('alm_bi_speed'), esc(_aeSpeedText(iss ? Math.sqrt(AE_GM_EARTH_KM3_S2 / r) : orb.speed, 2)), true);
      add('orbit', _aeT('alm_bi_orbit_of', { body: _tp('Earth') }), esc(_orrFmtSpan(iss || !sat ? round : AE_MINUTES_PER_DAY * 60 / sat.omm.MEAN_MOTION)), true);
      if (sat) add('data', _aeT('alm_bi_iss_data'), esc(sat.standing === 'approximate' ? _aeT('alm_earth_approx', { date: _aeFmtDate(sat.epochMs) }) : _aeFmtDate(sat.epochMs)));   // (its row is already named "Orbital data": the date alone, not the words again)
    }
    return;
  }
  var t = _aeTracks.tracks[k], ev = (t.events || []).filter(function (e) { return e[1] === 'launch'; })[0];
  add('mission', _aeT('alm_bi_mission'), esc(_aeT('alm_bi_mission_' + k)));
  if (ev) _aeCraftRows(k, (ev[0] + 0.5 - JD_UNIX_EPOCH) * MS_PER_DAY, jd, add, esc);
  var h = _aeTrackAt(t, jd);
  if (h) {
    add('from_sun', _aeT('alm_bi_from_sun'), esc(_aeAuText(_aeLen(h))) + ' · ' + far(_aeLen(h) * AU_KM), true);
    if (earthH) add('from_earth', _aeT('alm_bi_from_earth'), fromEarth(_aeLen(_aeSub(h, earthH))), true);
    var st = _aeStateOf(function (x) { return _aeTrackAt(t, x); }, jd);
    if (st) add('speed', _aeT('alm_bi_speed'), esc(_aeSpeedText(_aeLen(st.v) * AU_KM / SECONDS_PER_DAY, 1)) + line(_aeT('alm_bi_speed_sun')), true);
  }
}

// What a craft's sheet says of the craft itself, as its Sent row has it (sent-v1.json: who flies it, its mass at launch): who, when
// it went up and how long it has been gone at the shown date, and its mass. The Sent index is fetched the first time a sheet wants it.
function _aeCraftRows(k, launchMs, jd, add, esc) {
  var o = _aeSent ? _aeGoCraftObj(k) : (_aeSentStart(), null), ms = (jd - JD_UNIX_EPOCH) * MS_PER_DAY;
  if (o) add('operator', _aeT('alm_bi_operator'), esc(o.agency));
  add('launched', _aeT('alm_bi_launched'), esc(_aeFmtDate(launchMs)));
  if (ms > launchMs) add('age', _aeT('alm_bi_age'), esc(_orrFmtSpan((ms - launchMs) / 1000)), true);
  if (o && o.kg) add('craft_mass', _aeT('alm_bi_mass'), esc(_aeImperial() ? _orrNum(o.kg / AE_KG_PER_LB, 'pound') : _orrNum(o.kg, 'kilogram')));
}
var AE_KG_PER_LB = 0.45359237;
// A probe's flight from its launch, played: the clock goes to its launch day and runs a year in AE_REPLAY_YEAR_S seconds, the
// view stands over the whole system (the planets as they were and the probe on its real path, tables from JPL Horizons).
var AE_REPLAY_YEAR_S = 12;
function _aeLaunchMs(k) {
  var t = _aeTracks && _aeTracks.tracks[k], ev = t && (t.events || []).filter(function (e) { return e[1] === 'launch'; })[0];
  return ev ? (ev[0] + 0.5 - JD_UNIX_EPOCH) * MS_PER_DAY : null;
}
function _aeReplayLink(k) {
  if (!_aeIsProbe(k) || _aeLaunchMs(k) === null) return '';
  return '<p class="ae-info-read"><a href="#" data-ae-replay>' + _almEsc(_aeT('alm_probe_replay')) + '</a></p>';
}
// A probe with a mission (Voyager) replays from its launch phase, on the pad and followed; the others start at the first place of their
// track with the probe itself in view and followed, the clock slow enough to watch the departure, then at the replay's own pace.
var AE_REPLAY_START_RATE = 3600, AE_REPLAY_RAMP_MS = 20000;   // one hour a second to begin with, for twenty seconds
function _aeReplayFrom(k) {
  var ms = _aeLaunchMs(k);
  if (ms === null) return;
  _aeCloseInfo(true);
  if (AE_MISSION_IDS.indexOf(k) >= 0) { _aeMissionStart(k, 0, { paused: false }); return; }
  var t = _aeTracks.tracks[k];
  _aeGoTo(Math.max(ms, (t.jd0 - JD_UNIX_EPOCH) * MS_PER_DAY));
  _aePreset(k);
  if (typeof _almClockSetRate !== 'function') return;
  _almClockSetRate(AE_REPLAY_START_RATE);
  setTimeout(function () {
    if (_ae && _ae.target === k && _ae.preset === k && _almRate === AE_REPLAY_START_RATE) _almClockSetRate(AE_MS_PER_YEAR / 1000 / AE_REPLAY_YEAR_S);   // unless they have taken the clock since
  }, AE_REPLAY_RAMP_MS);
}

// The sheet itself. It follows the place whose card is up (another body tapped or flown to takes it there; the card's × or
// leaving for the satellites takes it away) and keeps its "now" rows up with the clock.
function _aeInfoHtml(k, rows) {
  var name = _almEsc(_aeInfoName(k)), a = _aeArrival(k, _aeDisplayMs()), blurb = _tLookup('alm_blurb_' + k, '');
  var p = function (cls, text) { return text ? '<p class="' + cls + '">' + _almEsc(text) + '</p>' : ''; };
  var links = a.links.map(function (l, i) {
    if (l.open && typeof window[l.open] === 'function') return '<p class="ae-info-read"><a href="#" data-ae-open="' + i + '">' + _almEsc(_aeT(l.label)) + '</a></p>';
    return _aeLinked(l.key) ? '<p class="ae-info-read">' + _aeLink(l.key, _almEsc(_aeT(l.label))) + '</p>' : '';
  }).join('');
  return '<button type="button" class="ae-card-x" id="ae-info-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
    '<div class="ae-info-grab" aria-hidden="true"></div><div class="ae-info-body"><h2 id="ae-info-title">' + _aeLink(_aeArrivalKey(k), name) + '</h2>' +
    p('ae-info-blurb', blurb) + (_aeIsProbe(k) ? p('ae-info-now', a.fact) : '') + p('ae-info-now ae-card-note', a.note) + links + _aeReplayLink(k) + '<dl class="ae-info-dl">' +
    rows.map(function (r) {
      return '<div class="ae-info-row" data-bi="' + r.id + '"><dt>' + _almEsc(r.label) + '</dt><dd>' + r.html + '</dd></div>';
    }).join('') + '</dl>' +
    (_aeLinked(_aeArrivalKey(k)) ? '<p class="ae-info-read">' + _aeLink(_aeArrivalKey(k), _almEsc(_aeT('alm_bi_read', { body: _aeInfoName(k) }))) + '</p>' : '') +
    (k === 'jwst' ? p('ae-info-credit', _aeT('alm_earth_webb_lit')) : '') +
    p('ae-info-credit', [_aeT('alm_earth_credit'), _aePlanetCredit()].filter(Boolean).join(' · ')) + '</div>';
}
function _aeRenderInfo() {
  var el = _aeById('ae-info'), k = _ae && _ae.info;
  if (!el || !k) return;
  if (k === AE_INFO_SITE) { _aeRenderSiteInfo(el); return; }
  if (k !== 'iss' && _aeIsProbe(k) && !_aeTracks) return;
  var ms = _aeDisplayMs(), body = el.querySelector('.ae-info-body'), scroll = body ? body.scrollTop : 0;
  el.innerHTML = _aeInfoHtml(k, _aeInfoRows(k, ms));
  if (el.querySelector('.ae-info-body')) el.querySelector('.ae-info-body').scrollTop = scroll;
  _ae.infoAt = ms;
  _aeById('ae-info-x').onclick = function () { _aeCloseInfo(true); };
  var a = _aeArrival(k, ms);
  var replay = el.querySelector('[data-ae-replay]');
  if (replay) replay.onclick = function (e) { e.preventDefault(); _aeReplayFrom(k); };
  Array.prototype.forEach.call(el.querySelectorAll('[data-ae-open]'), function (x) {
    var l = a.links[+x.getAttribute('data-ae-open')];
    x.onclick = function (e) { e.preventDefault(); _aeClose(); window[l.open](); };
  });
}
// The visit's own sheet: drawn once (nothing in it moves with the clock), its article link opening the reader.
function _aeRenderSiteInfo(el) {
  var st = _ae.site;
  if (!st || typeof _asInfoHtml !== 'function') return;
  el.innerHTML = _asInfoHtml(st);
  _aeById('ae-info-x').onclick = function () { _aeCloseInfo(true); };
  var read = el.querySelector('[data-as-read]');
  if (read) read.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(st.hit); };
}
// The "now" rows redrawn in place (the focus and the scroll stay where they are).
function _aeUpdateInfoLive(ms) {
  var el = _aeById('ae-info');
  if (!el || !_ae.info || _ae.info === AE_INFO_SITE || Math.abs(ms - (_ae.infoAt || 0)) < AE_ARRIVAL_REFRESH_MS) return;
  _ae.infoAt = ms;
  var note = el.querySelector('.ae-card-note'), said = _aeArrival(_ae.info, ms).note;
  if (note ? note.textContent !== said : said) { _aeRenderInfo(); return; }
  _aeInfoRows(_ae.info, ms).forEach(function (r) {
    if (!r.live) return;
    var dd = el.querySelector('[data-bi="' + r.id + '"] dd');
    if (dd && dd.innerHTML !== r.html) dd.innerHTML = r.html;
  });
}
// A swipe down on the sheet (from its top, or with its list at the top) shuts it, the sheet following the finger; a tap
// anywhere in the view outside it and its button shuts it too.
var AE_INFO_SWIPE_PX = 70;
// A sheet that follows a downward drag and shuts past AE_INFO_SWIPE_PX. `scrolled()` says its list is not at the top, where a drag is a scroll.
function _aeSwipeShut(el, scrolled, shut) {
  var y0 = null, dy = 0;
  el.addEventListener('touchstart', function (e) { y0 = scrolled() ? null : e.touches[0].clientY; dy = 0; }, { passive: true });
  el.addEventListener('touchmove', function (e) {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) { el.style.transition = 'none'; el.style.transform = 'translateY(' + dy + 'px)'; }
  }, { passive: true });
  el.addEventListener('touchend', function () {
    if (y0 == null) return;
    var done = dy > AE_INFO_SWIPE_PX;
    y0 = null;
    el.style.transition = el.style.transform = '';
    if (done) shut();
  });
}
function _aeBindInfo() {
  var el = _aeById('ae-info');
  _aeSwipeShut(el, function () { var body = el.querySelector('.ae-info-body'); return !!body && body.scrollTop > 0; }, function () { _aeCloseInfo(false); });
  _ae.el.addEventListener('pointerdown', function (e) {
    if (!_ae.info || el.contains(e.target) || (e.target.closest && e.target.closest('#ae-info-btn'))) return;
    _aeCloseInfo(false);
  }, true);
}
// The picture's centre stands in the room between the strip along the top and the foot's controls, or the facts sheet where it
// covers the foot on a phone (smoothly, and back when it goes), at any zoom. A side panel on a wide screen covers no centre.
var AE_INFO_SHIFT_TAU_MS = 90, AE_INFO_SHIFT_SNAP_PX = 0.5, AE_INFO_SIDE_PANEL_PX = 760;
// Where the room for the body begins with the search sheet up: under the band, or under the drawer when one is open (px from the view's top).
function _aeGoTopEdge() {
  var base = AE_HIT_PX + 16 + _aeSatPx(), d = _aeDrawerHost();
  if (!d || d.hidden || !_ae.el) return base;
  return Math.max(base, d.getBoundingClientRect().bottom - _ae.el.getBoundingClientRect().top + 8);
}
// With a drawer up (the satellites' filters, the settings) the sheet is its search bar: the Earth and every satellite shown stand centred
// in the room the band, the drawer and the bar leave. Browsing the sheet moves nothing: the picture stays where it was.
var AE_GO_FRAME_GAP_PX = 12, AE_GO_FRAME_MIN = 0.12, AE_GO_SIDE_MQ = '(min-width:760px) and (min-height:600px)';
function _aeGoDrawerUp() { return _aeGoUp() && !!_ae.el && _ae.el.classList.contains('ae-drawer-up'); }
// The free room, in the view's px: a drawer or bar that spans the view takes the top or the foot; a column at the side (a wide screen) takes the side.
function _aeGoFreeRect() {
  var at = _ae.el.getBoundingClientRect(), r = { l: 0, t: AE_HIT_PX + 16 + _aeSatPx(), r: _ae.w, b: _ae.h };
  [_aeById('ae-drawer'), _aeById('ae-go')].forEach(function (e) {
    if (!e || e.hidden || !e.offsetHeight) return;
    var b = e.getBoundingClientRect(), l = b.left - at.left, t = b.top - at.top, rr = b.right - at.left, bb = b.bottom - at.top;
    if (b.width > _ae.w * 0.7) { if (t > _ae.h / 2) r.b = Math.min(r.b, t - AE_GO_FRAME_GAP_PX); else r.t = Math.max(r.t, bb + AE_GO_FRAME_GAP_PX); }
    else r.l = Math.max(r.l, rr + AE_GO_FRAME_GAP_PX);
  });
  return r;
}
// How far out from the Earth's centre the drawn satellites reach (in Earth radii; 1 where none are shown), read once for each sampling and filter.
function _aeGoSatReach() {
  if (typeof _as === 'undefined' || !_as.on || !_as.data || !_as.cloud || !_as.cloud.visible || _ae.target !== 'earth') return 1;
  var key = [_as.sampleMs, _as.shown, JSON.stringify(_as.filter)].join('|');
  if (_ae.satReachKey === key) return _ae.satReach;
  var pos = _as.cloud.geometry.attributes.position.array, r2 = 1, n = _as.data.n;
  for (var i = 0; i < n; i++) {
    if (!_as.ok || !_as.ok[i] || !_asVisible(i)) continue;
    var d2 = pos[3 * i] * pos[3 * i] + pos[3 * i + 1] * pos[3 * i + 1] + pos[3 * i + 2] * pos[3 * i + 2];
    if (d2 > r2) r2 = d2;
  }
  _ae.satReachKey = key;
  return (_ae.satReach = Math.sqrt(r2));
}
// The picture as the drawer frames it: where its centre goes (px from the view's centre) and how much of its size is drawn; null when nothing frames it.
function _aeGoFrame() {
  if (!_aeGoDrawerUp() || !_ae.gl || !_ae.w || !_ae.h) return null;
  var f = _aeGoFreeRect(), cam = _ae.gl.camera, reach = Math.max(1, _aeGoSatReach()), focal = _aePxPerRad(cam), room = Math.max(1, Math.min(f.r - f.l, f.b - f.t) / 2 - AE_GO_FRAME_GAP_PX);
  // The sphere that holds them all must stand at least this far from the camera for its radius to be no more than the room (a satellite behind the camera is not drawn at all).
  var need = _aeClampDist(reach / Math.sin(Math.atan(room / focal))), d = Math.max(_ae.goDist0 || _ae.dist, need);
  return { x: _ae.w / 2 - (f.l + f.r) / 2, y: _ae.h / 2 - (f.t + f.b) / 2, s: _aeClamp(room / (focal * Math.tan(Math.asin(Math.min(1, reach / d)))), AE_GO_FRAME_MIN, 1), dist: need };
}
function _aeInfoShiftTarget() {
  var el = _aeById('ae-info'), sheet = _ae.info && el && _ae.w < AE_INFO_SIDE_PANEL_PX ? el.offsetHeight : 0, fr = _aeGoFrame();
  if (fr) return fr.y;
  return (Math.max(sheet, _aeHudFootPx()) - (_ae.pinPx || 0)) / 2;   // up when the foot is the taller
}
// One frame of that glide; true while it still moves. The drawer's frame (_aeGoFrame) glides with the shift: down or sideways, and smaller.
var AE_GO_SCALE_SNAP = 0.004;
function _aeGoScaleTarget() { var fr = _aeGoFrame(); return fr ? fr.s : 1; }
function _aeGoShiftXTarget() { var fr = _aeGoFrame(); return fr ? fr.x : 0; }
// The camera stands back while the frame needs it (the satellites reach past where it is) and returns to where it was when the drawer goes.
var AE_GO_DIST_SNAP = 0.002;
function _aeStepGoDist(k, fr) {
  if (_ae.fly || (!fr && !_ae.goDist0)) return false;
  if (fr && !_ae.goDist0) _ae.goDist0 = _ae.dist;   // (where the person had it: the drawer never brings the camera nearer than that)
  var goal = fr ? Math.max(_ae.goDist0, fr.dist) : _ae.goDist0;
  var snap = _aeReduceMotion() || Math.abs(Math.log(goal / _ae.dist)) < AE_GO_DIST_SNAP;
  if (_ae.dist !== goal) { _ae.dist = snap ? goal : Math.exp(Math.log(_ae.dist) + (Math.log(goal) - Math.log(_ae.dist)) * k); _ae.dirty = true; }
  if (!fr && snap) _ae.goDist0 = 0;
  return !snap;
}
function _aeStepInfoShift(dt) {
  var fr = _aeGoFrame(), to = fr ? fr.y : _aeInfoShiftTarget(), from = _ae.infoShift || 0, sTo = fr ? fr.s : 1, sFrom = _ae.goS || 1, xTo = fr ? fr.x : 0, xFrom = _ae.goX || 0;
  var farther = _aeStepGoDist(Math.min(1, dt / AE_INFO_SHIFT_TAU_MS), fr);
  if (from === to && sFrom === sTo && xFrom === xTo) return farther;
  var snap = _aeReduceMotion(), k = Math.min(1, dt / AE_INFO_SHIFT_TAU_MS);
  var next = snap || Math.abs(to - from) < AE_INFO_SHIFT_SNAP_PX ? to : from + (to - from) * k;
  var sNext = snap || Math.abs(sTo - sFrom) < AE_GO_SCALE_SNAP ? sTo : sFrom + (sTo - sFrom) * k;
  var xNext = snap || Math.abs(xTo - xFrom) < AE_INFO_SHIFT_SNAP_PX ? xTo : xFrom + (xTo - xFrom) * k;
  _ae.infoShift = next;
  _ae.goS = sNext;
  _ae.goX = xNext;
  _ae.dirty = true;
  return farther || next !== to || sNext !== sTo || xNext !== xTo;
}
function _aeOpenInfo(k) {
  if (!_aeHasFacts(k)) return;
  _aeSheetClaim('info');
  var el = _aeById('ae-info');
  if (!el) return;
  _ae.info = k;
  _ae.infoFrom = document.activeElement;
  if (_ae.setOpen) _aeShowSettings(false);
  _aeRenderInfo();
  el.classList.add('in');
  _aeMarkInfoBtn();
  _aeRedraw();
  var x = _aeById('ae-info-x');
  if (x) x.focus({ preventScroll: true });
  document.addEventListener('pointerdown', _aeInfoAway, true);
}
// A press outside the card only puts it away: the first one is the card's, and the scene under it does not get it (nor the click that follows).
function _aeInfoAway(e) {
  var el = _aeById('ae-info');
  if (!_ae || !_ae.info || !el || el.contains(e.target) || (e.target.closest && e.target.closest('#ae-info-btn, #ae-find'))) return;
  e.stopPropagation(); e.preventDefault();
  _aeCloseInfo(false);
  var eat = function (c) { c.stopPropagation(); c.preventDefault(); };
  document.addEventListener('click', eat, { capture: true, once: true });
  setTimeout(function () { document.removeEventListener('click', eat, true); }, 600);
}
function _aeCloseInfo(refocus) {
  var el = _aeById('ae-info');
  if (!_ae || !_ae.info) return;
  _ae.info = null;
  document.removeEventListener('pointerdown', _aeInfoAway, true);
  if (el) el.classList.remove('in');
  _aeMarkInfoBtn();
  _aeRedraw();
  var back = _ae.infoFrom;
  _ae.infoFrom = null;
  if (refocus && back && back.isConnected && back.focus) back.focus({ preventScroll: true });
}
// The card changed under the sheet: it goes with its place.
function _aeSyncInfo() {
  if (!_ae || !_ae.info) return;
  if (_ae.info === AE_INFO_SITE) { if (!_ae.site) _aeCloseInfo(false); return; }   // (a visit's sheet goes with the visit)
  var k = _aeGroundBody() || _ae.arrived;
  if (k && k !== _ae.info && _aeHasFacts(k)) { _ae.info = k; _aeRenderInfo(); return; }
  if (!k) setTimeout(function () { if (_ae && _ae.info && !_aeGroundBody() && !_ae.arrived) _aeCloseInfo(false); }, 0);   // a flight clears the card, then arrives
}

// ── The sheet's numbers, listed ──
// The Almanac's Constants pages "Bodies" and "Axes and orbits" (almanac-tables.js) list every number a sheet shows and
// every constant the axes are drawn from, each with its source: rows [name key, value, digits, unit, source, name, id].
// _aeInfoRefNeeds says, for each row of a sheet, which listed rows it stands on; the test fails on a row it cannot place or
// a need the pages do not list.
var AE_REF_ORDER = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'ceres', 'vesta',
  'io', 'europa', 'ganymede', 'callisto', 'titan', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'iapetus', 'triton', 'charon', 'phobos'];
var AE_REF_SRC_FACTS = 'NASA fact sheet', AE_REF_SRC_MOONCOUNT = 'NASA Science, read 2026-11-06', AE_REF_SRC_POLE = 'IAU WGCCRE 2015';
var AE_REF_SRC_ELEMENTS = 'JPL (Standish) mean motion', AE_REF_SRC_MOONS = 'JPL Horizons fit';
// A mass as scientific notation ("4.867e+24"): the constants tables set the power of ten as a real superscript (_tbConstVal).
var AE_REF_MASS_DIGITS = 3;
function _aeRefMass(kg) { var e = Math.floor(Math.log10(kg)); return (kg / Math.pow(10, e)).toFixed(AE_REF_MASS_DIGITS) + 'e' + (e < 0 ? '' : '+') + e; }
function _aeRefName(k, nameKey) { return _aeInfoName(k) + ' · ' + _aeT(nameKey); }
// What a sheet row stands on: the listed rows' ids, or null for a row nothing is known of.
function _aeInfoRefNeeds(k, rowId) {
  var b = _aeFactBase(k), f = AE_BODY_FACTS[k] || {}, probe = k === 'iss' || _aeIsProbe(k);
  var own = function (s) { return [k + '.' + s]; };
  var live = k === 'moon' ? 'live.moon' : b && b.track ? 'live.tracks' : 'live.planets';
  switch (rowId) {
    case 'diameter': return own('radius');
    case 'mass': case 'gravity': case 'escape': case 'tilt': case 'moons': case 'temp': case 'atmo': case 'found': return own(rowId);
    case 'day': return (b.pole ? own('rotation_rate') : k === 'moon' ? own('orbit_period') : own('orbit_rate')).concat(f.solarDayH ? own('solar_day') : []);
    case 'year': return own('orbit_period');
    case 'from_parent': return own('orbit_radius');
    case 'range': return own('peri').concat(own('apo'));
    case 'from_sun': case 'from_earth': return [probe ? 'live.tracks' : live];
    case 'launched': return [k === 'iss' ? 'iss.launch' : _aeIsOrbiter(k) ? 'craft.sent' : 'probes.launch'];
    case 'age': return [k === 'iss' ? 'iss.launch' : _aeIsOrbiter(k) ? 'craft.sent' : 'probes.launch'];   // the shown date less the launch
    case 'operator': case 'craft_mass': return ['craft.sent'];
    case 'speed': return [k === 'iss' || _aeIsOrbiter(k) ? 'live.iss' : 'live.tracks'];
    case 'height': case 'orbit': case 'data': return ['live.iss'];
    case 'mission': return [];   // prose, not a quantity
  }
  return null;
}
// "Bodies": the fact sheet's numbers, and the radius, orbit and day they stand beside.
function _aeRefBodiesRows() {
  var rows = [], jd = Date.now() / MS_PER_DAY + JD_UNIX_EPOCH;
  var add = function (k, id, nameKey, value, unit, src) { rows.push([null, value, null, unit, src, _aeRefName(k, nameKey), k + '.' + id]); };
  AE_REF_ORDER.forEach(function (k) {
    var b = _aeFactBase(k), f = AE_BODY_FACTS[k] || {}, parent = b.parent;
    add(k, 'radius', 'tb_kn_eq_radius', b.km, 'km', k === 'sun' ? 'IAU 2015' : 'IAU');
    if (f.mass) add(k, 'mass', 'alm_bi_mass', _aeRefMass(f.mass), 'kg', AE_REF_SRC_FACTS);
    if (f.gravity) add(k, 'gravity', 'alm_bi_gravity', f.gravity, 'm/s²', AE_REF_SRC_FACTS);
    if (f.escape) add(k, 'escape', 'alm_bi_escape', f.escape, 'km/s', AE_REF_SRC_FACTS);
    if (f.solarDayH) add(k, 'solar_day', 'tb_kn_solar_day', f.solarDayH, 'h', AE_REF_SRC_FACTS);
    if (f.periKm) add(k, 'peri', 'tb_kn_peri', f.periKm, 'km', AE_REF_SRC_FACTS);
    if (f.apoKm) add(k, 'apo', 'tb_kn_apo', f.apoKm, 'km', AE_REF_SRC_FACTS);
    if (AE_SPIN_ORDER.indexOf(k) >= 0) {
      var g = _aeSpinFacts(_aeSpinBody(k), jd);
      add(k, 'tilt', 'alm_bi_tilt', g.tiltDeg, '°', 'IAU pole, orbit plane (worked out)');
    } else if (typeof f.tilt === 'number') add(k, 'tilt', 'alm_bi_tilt', f.tilt, '°', AE_REF_SRC_FACTS);
    if (parent) {
      add(k, 'orbit_radius', 'tb_kn_orbit_radius', b.orbit[0], 'km', AE_REF_SRC_MOONS);
      add(k, 'orbit_rate', 'tb_kn_orbit_rate', b.orbit[2], '°/d', AE_REF_SRC_MOONS);
      add(k, 'orbit_period', 'tb_kn_orbit_period', 360 / b.orbit[2], 'd', AE_REF_SRC_MOONS);
    } else if (k === 'moon') add(k, 'orbit_period', 'tb_kn_orbit_period', AE_MOON_SIDEREAL_DAYS, 'd', 'Meeus 47');
    else if (b.eph && typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]) add(k, 'orbit_period', 'tb_kn_orbit_period', _aeYearDays(b.eph), 'd', AE_REF_SRC_ELEMENTS);
    else if (f.yearDays) add(k, 'orbit_period', 'tb_kn_orbit_period', f.yearDays, 'd', AE_REF_SRC_FACTS);
    if (typeof f.tempC === 'number') add(k, 'temp', 'alm_bi_temp', f.tempC, '°C', AE_REF_SRC_FACTS);
    if (typeof f.moons === 'number') add(k, 'moons', 'alm_bi_moons', f.moons, '', k === 'earth' || k === 'mars' ? AE_REF_SRC_FACTS : AE_REF_SRC_MOONCOUNT);
    if (f.atmo) add(k, 'atmo', 'alm_bi_atmo', _aeT('alm_bi_atmo_' + f.atmo), '', AE_REF_SRC_FACTS);
    if (f.found) add(k, 'found', 'alm_bi_found', _aeT('alm_bi_found_by', { by: f.found.by, year: f.found.year }), '', 'IAU Minor Planet Center');
  });
  return rows;
}
// "Axes and orbits": the IAU poles and turning rates the maps and axes stand on, what draws them, and where positions come from.
function _aeRefAxesRows() {
  var rows = [];
  var add = function (id, name, value, unit, src) { rows.push([null, value, null, unit, src, name, id]); };
  AE_REF_ORDER.forEach(function (k) {
    var b = _aeFactBase(k);
    if (!b.pole) return;
    add(k + '.pole_ra', _aeRefName(k, 'tb_kn_pole_ra'), b.pole[0], '°', k === 'earth' ? 'IAU, Meeus 12.4' : AE_REF_SRC_POLE);
    add(k + '.pole_dec', _aeRefName(k, 'tb_kn_pole_dec'), b.pole[1], '°', k === 'earth' ? 'IAU, Meeus 12.4' : AE_REF_SRC_POLE);
    add(k + '.pole_w0', _aeRefName(k, 'tb_kn_pole_w0'), b.pole[2], '°', k === 'earth' ? 'IAU, Meeus 12.4' : AE_REF_SRC_POLE);
    add(k + '.rotation_rate', _aeRefName(k, 'tb_kn_rotation'), b.pole[3], '°/d', k === 'earth' ? 'Meeus 12.4' : AE_REF_SRC_POLE);
  });
  add('moon.pole_tilt', _aeRefName('moon', 'tb_kn_pole_tilt'), _MOON_EQUATOR_TILT_DEG, '°', 'IAU (Cassini)');
  add('live.planets', _aeT('tb_kn_live_planets'), 'VSOP87D (1″, 1500–2500)', '', 'Bretagnon & Francou 1988, IMCCE (almanac-vsop87.js: the 3D view, the solar system and the sky draw every planet from it); Pluto: JPL (Standish) elements');
  add('live.moon', _aeT('tb_kn_live_moon'), 'ELP / Meeus 47', '', 'Meeus 47');
  add('live.tracks', _aeT('tb_kn_live_tracks'), 'JPL Horizons tables', '', 'JPL Horizons');
  add('live.iss', _aeT('tb_kn_live_iss'), 'SGP4', '', 'CelesTrak');
  add('probes.launch', _aeT('tb_kn_probe_launch'), 'JPL Horizons tables', '', 'JPL Horizons');
  add('craft.sent', _aeT('tb_kn_craft_facts'), 'sent-v1.json', '', 'each craft\'s operator (NASA, ESA, JAXA...), launch mass as published; the row\'s own source link');
  add('iss.launch', _aeT('tb_kn_iss_launch'), _aeFmtDate(AE_ISS_LAUNCH_MS), '', 'NASA');
  add('axis.reach', _aeT('tb_kn_axis_reach'), AE_SPIN_AXIS_R, '×', 'Zimi');
  add('axis.min_px', _aeT('tb_kn_axis_min'), AE_AXIS_MIN_PX, 'px', 'Zimi');
  add('axis.barb', _aeT('tb_kn_axis_barb'), AE_SPIN_BARB + ' · ' + AE_SPIN_BARB_DEG + '°', '', 'Zimi');
  add('axis.plane', _aeT('tb_kn_axis_plane'), AE_SPIN_PLANE_R, '×', 'Zimi (its direction: the cross product of the planet\'s places ' + AE_SPIN_NORMAL_DAYS + ' days either side)');
  // The picture itself: the camera, and what is drawn nearer or bigger than it is.
  add('view.fov', _aeT('tb_kn_view_fov'), AE_FOV_DEG, '°', 'Zimi');
  add('view.near', _aeT('tb_kn_view_near'), AE_NEAR_FRACTION * 100, '%', 'Zimi (depth is sharpest where the camera is closest)');
  add('view.sun', _aeT('tb_kn_view_sun'), AE_SUN_SHOW_DIST + ' · ' + AE_SUN_SHOW_R, 'R⊕', 'Zimi (true: ' + Math.round(AU_KM / AE_EARTH_RADIUS_KM) + ' · ' + Math.round(AE_SUN_RADIUS_RE) + '; drawn nearer and smaller so the Earth, the Moon and the Sun fit one view; its direction is true)');
  add('view.squeeze', _aeT('tb_kn_view_squeeze'), 'd = ' + AE_SUN_SHOW_DIST + ' · s(a) / s(1)', 'R⊕', 'Zimi (a: the true distance in AU; s: the orrery\'s log map of distance; direction and size are true)');
  add('view.glow', _aeT('tb_kn_view_glow'), AE_ATMOSPHERE_SCALE, '×', 'Zimi (about ' + Math.round((AE_ATMOSPHERE_SCALE - 1) * AE_EARTH_RADIUS_KM) + ' km above the surface)');
  // The lines: orbits and the Moon's path, and how finely each is stepped.
  add('orbit.points', _aeT('tb_kn_orbit_points'), AE_ORBIT_POINTS + ' · ' + AE_ORBIT_REDRAW_DAYS + ' d', '', 'Zimi (' + 360 / AE_ORBIT_POINTS + '° a step)');
  add('orbit.fine', _aeT('tb_kn_orbit_fine'), AE_ORBIT_FINE_POINTS + ' · ' + AE_ORBIT_FINE_SHARE * 100 + ' %', '', 'Zimi (' + +(360 * AE_ORBIT_FINE_SHARE / AE_ORBIT_FINE_POINTS).toFixed(3) + '° a step: coarser steps show as corners where the line runs past the camera)');
  add('orbit.fade', _aeT('tb_kn_orbit_fade'), AE_ORBIT_FADE_FROM + '–' + AE_ORBIT_FADE_TO, '', 'Zimi');
  add('moonpath.span', _aeT('tb_kn_moonpath'), AE_MOON_PATH_HALF_DAYS + ' d · ' + AE_MOON_PATH_STEP_HOURS + ' h', '', 'Zimi (half a sidereal month, Meeus 47)');
  add('moonpath.fine', _aeT('tb_kn_moonpath_fine'), AE_MOON_PATH_FINE_STEP_MIN + ' min · ' + AE_MOON_PATH_FINE_HOURS + ' h', '', 'Zimi (a 6-hour chord is thirteen Moon radii long; 10 minutes is 0.09° of its orbit)');
  add('iss.ring', _aeT('tb_kn_iss_ring'), AE_ISS_RING_POINTS, '', 'Zimi (0.02° apart at the station, 4° at the far side: a chord stands 4 km off its arc at most)');
  add('gps.shell', _aeT('tb_kn_gps_shell'), AE_GPS_SHELL_RE, 'R⊕', 'GPS Interface Specification IS-GPS-200 (26,560 km)');
  add('stand.walk', _aeT('tb_kn_walk_pace'), AE_WALK_PACE_MS, 'm/s', 'Zimi (a person\'s usual pace, 5 km/h)');
  add('stand.move', _aeT('tb_kn_move_ms'), AE_MOVE_MS, 'ms', 'Zimi (long enough that the ground is built by the time it ends)');
  // Go to by name, and the flights to a spacecraft's model.
  add('place.towns', _aeT('tb_kn_place_towns'), 'Kiwix maps · OpenMapTiles', '', 'OpenStreetMap contributors');
  add('maps.fade', _aeT('tb_kn_maps_fade'), AE_MAPS.fullKm + '-' + AE_MAPS.startKm, 'km', 'Zimi');
  add('maps.min_alt', _aeT('tb_kn_maps_min'), AE_MAPS.minKm, 'km', 'Zimi');
  add('maps.tile_px', _aeT('tb_kn_maps_tile'), AE_MAPS.tilePx, 'px', 'Zimi');
  add('maps.ride', _aeT('tb_kn_maps_ride'), AE_MAPS.startKm, 'km', 'Zimi');
  add('maps.data', _aeT('tb_kn_maps_data'), 'Kiwix maps · OpenMapTiles', '', 'OpenStreetMap contributors');
  add('place.landmarks', _aeT('tb_kn_place_landmarks'), 'landmarks-v1.json', '', 'Wikidata (CC0)');
  add('place.alt', _aeT('tb_kn_place_alt'), (AE_PLACE_DIST - 1) * AE_EARTH_RADIUS_KM, 'km', 'Zimi');
  add('place.match', _aeT('tb_kn_place_match'), AE_PLACE_ARTICLE_KM, 'km', 'Zimi');
  add('craft.view', _aeT('tb_kn_craft_view'), AE_CRAFT_VIEW_SPANS, '×', 'Zimi');
  // Almanac HD's tiles, how near the camera comes, and the edges' smoothing.
  add('hd.split', _aeT('tb_kn_hd_split'), AE_HD_TILE_PX * AE_HD_SPLIT, 'px', 'Zimi (a tile holds ' + AE_HD_TILE_PX + ' px a side)');
  add('hd.min_body', _aeT('tb_kn_hd_min_body'), AE_HD_MIN_BODY_PX, 'px', 'Zimi');
  add('hd.keep', _aeT('tb_kn_hd_keep'), '0–' + AE_HD_KEEP_LEVEL, '', 'Zimi (' + AE_HD_KEEP_TILES + ' tiles a layer: the stand-ins for every other)');
  add('hd.memory', _aeT('tb_kn_hd_memory'), AE_HD_GPU_MB_PHONE + ' · ' + AE_HD_GPU_MB_DESKTOP, 'MB', 'Zimi (and never more than the capability level allows)');
  add('hd.loads', _aeT('tb_kn_hd_loads'), AE_HD_LOADS + ' · ' + AE_HD_UPLOADS, '', 'Zimi');
  add('hd.skirt', _aeT('tb_kn_hd_skirt'), AE_HD_SKIRT * 100, '%', 'Zimi (no crack shows where two levels meet)');
  add('hd.retry', _aeT('tb_kn_hd_retry'), 'min(' + AE_HD_RETRY_MAX_MS + ', ' + AE_HD_RETRY_MS + ' × 2^(n − 1))', 'ms', 'Zimi (n: its failures in a row)');
  add('hd.mask', _aeT('tb_kn_hd_mask'), 'stencil: tile = k, map where ≠ k', '', 'Zimi (k: the body\'s number; the WebGL stencil test, Khronos WebGL 2.0)');
  add('hd.min_alt', _aeT('tb_kn_hd_min_alt'), AE_HD_MIN_ALT_KM, 'km', 'Zimi');
  add('stop.texel', _aeT('tb_kn_stop_texel'), AE_CLOSE_TEXEL_PX, 'px', 'Zimi (nearer, the picture only blurs)');
  add('stop.formula', _aeT('tb_kn_stop_formula'), 'd = R + (2πR / W) · H / (' + AE_CLOSE_TEXEL_PX + ' · θ)', '', 'Zimi (R: radius; W: the map\'s texels round the equator, ' + AE_EARTH_MAP_W + ' for the Earth, ' + AE_BODY_MAP_W + ' for a planet; H: the screen\'s height in device pixels; θ: the field of view in radians)');
  add('stop.near', _aeT('tb_kn_stop_near'), AE_NEAR_STOP + ' · ' + AE_AT_STOP, '×', 'Zimi');
  add('maps.lookup', _aeT('tb_kn_maps_lookup'), AE_NEAR_STOP, '×', 'Zimi (over an installed map the stop gives way to the map\'s own)');
  add('gl.msaa', _aeT('tb_kn_gl_msaa'), AE_MSAA_BELOW_DPR + ' · ' + AE_MSAA_APPLE_DPR, '×', 'Zimi (chosen once, with the WebGL context; 4 samples a pixel)');
  // Stand here: its ground and the air over it.
  add('stand.eye', _aeT('tb_kn_stand_eye'), AE_STAND_EYE_M, 'm', 'Zimi');
  add('stand.terrain', _aeT('tb_kn_stand_terrain'), 'LOLA · MOLA · Magellan · MESSENGER · ETOPO 2022 · Dawn · New Horizons · HRSC · Cassini', '', 'NASA, USGS, NOAA, ESA/DLR (public domain)');
  add('stand.detail', _aeT('tb_kn_stand_detail'), 'seeded by the place', '', 'Zimi');
  add('stand.dust', _aeT('tb_kn_stand_dust'), AE_STAND_MARS_TAU, '', 'Lemmon et al. 2015');
  add('stand.haze', _aeT('tb_kn_stand_haze'), AE_STAND_HAZE_VIS_KM.venus + ' · ' + AE_STAND_HAZE_VIS_KM.titan, 'km', 'Zimi, after Venera and Huygens');
  add('stand.charon', _aeT('tb_kn_stand_charon'), AE_STAND_CHARON_KM, 'km', 'NASA/JPL (New Horizons)');
  add('stand.coast', _aeT('tb_kn_stand_coast'), 'Natural Earth 1:10m land · 8192 × 4096', '', 'Natural Earth (public domain)');
  add('stand.shadow', _aeT('tb_kn_stand_shadow'), AE_STAND_SHADE_GRIDS, 'm', 'Zimi');
  add('stand.stars', _aeT('tb_kn_stand_stars'), 'none with the Sun above ' + Math.round(_aeDeg(Math.asin(AE_STAND_AIRLESS_DAY_MU[1]))) + '° (fading from ' + Math.round(_aeDeg(Math.asin(AE_STAND_AIRLESS_DAY_MU[0]))) + '°)', '', 'Zimi, after the Apollo crews');
  add('site.lamps', _aeT('tb_kn_site_lamps'), 'Sun below ' + Math.round(_aeDeg(Math.asin(AE_SITE_LAMP_SUN[1]))) + '° (fading out from 0°)', '', 'Zimi');
  add('craft.models', _aeT('tb_kn_craft_models'), 'NASA 3D Resources · scripts/build_craft_models.py, build_craft_hd.py', '', 'NASA (public domain)');
  add('craft.sun', _aeT('tb_kn_craft_sun'), AE_CRAFT_SUN_E, '', 'Zimi (a Lambert albedo of 0.8 head on reads 0.76)');
  add('craft.shine', _aeT('tb_kn_craft_shine'), AE_CRAFT_SHINE_REFLECT, '', 'Zimi (a world\'s albedo, disc size and phase seen from the craft)');
  // The landing sites: where the models, the sol and the Saturn V's flight come from.
  add('site.models', _aeT('tb_kn_site_models'), 'NASA 3D Resources · scripts/build_site_models.py', '', 'NASA (public domain); the rest written for Zimi');
  add('site.sol', _aeT('tb_kn_site_sol'), AE_SITE_FACTS.solSeconds, 's', 'NASA/JPL');
  add('site.msd', _aeT('tb_kn_site_msd'), 'MSD = (JD(TT) − ' + AE_SITE_FACTS.msdEpochJd + ') / ' + AE_SITE_FACTS.marsSolDays + ' + 44796 − 0.0009626', '', 'Allison & McEwen 2000, NASA GISS Mars24');
  add('site.drive_hour', _aeT('tb_kn_site_drive_hour'), AE_SITE_FACTS.driveLmstH.msl + ' (Curiosity) · ' + AE_SITE_FACTS.driveLmstH.m20 + ' (Perseverance)', 'h', 'Zimi: the waypoints carry no times; the mission\'s usual hour, local mean solar time');
  add('site.traverse', _aeT('tb_kn_site_traverse'), 'MMGIS waypoints · traverses-v1.json', '', 'NASA/JPL-Caltech/MSL and Mars 2020 teams');
  add('site.lrv_speed', _aeT('tb_kn_site_lrv_speed'), AE_SITE_FACTS.lrvSpeedMs, 'm/s', 'NASA (13 km/h)');
  add('site.fast_rate', _aeT('tb_kn_site_fast_rate'), '×' + AE_SITE_FACTS.driveFastRate + ' (×' + AE_SITE_FACTS.marsDriveFastRate + ' on Mars)', '', 'Zimi (the clock\'s rate while the stick is pushed further: time runs forward, the vehicle keeps its real top speed)');
  add('site.rate_cap', _aeT('tb_kn_site_rate_cap'), '×' + AE_SITE_FACTS.driveHeldRateCap, '', 'Zimi (the most a rate may be while a thumb steers)');
  add('site.boost', _aeT('tb_kn_site_boost'), '×' + AE_SITE_FACTS.driveBoostMax + ' after ' + AE_SITE_FACTS.driveBoostAfterS + ' s, over ' + AE_SITE_FACTS.driveBoostRampS + ' s', '', 'Zimi (the stick held full: the vehicle covers ground faster, its own speed and the clock unchanged)');
  add('site.apollo_pos', _aeT('tb_kn_site_apollo_pos'), 'LROC NAC · ALSJ photogrammetry · site maps (sites-v1.json)', '', 'Wagner et al. 2017 (ASU/PDS); Pustynski and Jones, ALSJ; NASA Preliminary Science Reports; USGS 1978 Apollo 11 map');
  add('site.apollo_relief', _aeT('tb_kn_site_apollo_relief'), 'depth 0.196 D^1.01 · rim 0.036 D^1.014 (D in km)', 'km', 'Lunar Sourcebook, table 4.1 (as the ALSJ quotes it)');
  add('site.mars_landed', _aeT('tb_kn_site_mars_landed'), _aeT('tb_kn_site_mars_landed_v'), '', 'NSSDCA (Viking 1 and 2, Mars Pathfinder: spacecraft time); NASA/JPL (Curiosity 05:17:57, Phoenix 23:38:24, InSight 19:44:52, Perseverance 20:43:38: spacecraft time); Spirit and Opportunity from their Earth-received 04:35 and 05:05 UTC, less the light time; Wei et al. and Hu et al. 2022, Astrodynamics 6(1) (Zhurong 23:18, the landing itself, reconstructed from the vehicle\'s own measurements; heard on Earth near 23:36); checked by scripts/missions/mars_landings.json');
  add('site.mars_speed', _aeT('tb_kn_site_mars_speed'), AE_SITE_FACTS.marsDriveSpeedMs, 'm/s', 'NASA (Perseverance and Curiosity: about 0.04 m/s, 152 m/h)');
  add('site.saturn_mass', _aeT('tb_kn_site_saturn_mass'), AE_SITE_FACTS.saturnMassKg, 'kg', 'NASA Saturn V flight manual');
  add('site.saturn_thrust', _aeT('tb_kn_site_saturn_thrust'), AE_SITE_FACTS.saturnThrustN, 'N', 'NASA Saturn V flight manual');
  add('site.saturn_burn', _aeT('tb_kn_site_saturn_burn'), AE_SITE_FACTS.saturnBurnKgS, 'kg/s', 'NASA Saturn V flight manual');
  add('site.saturn_cutoff', _aeT('tb_kn_site_saturn_cutoff'), AE_SITE_FACTS.saturnCutoffS, 's', 'NASA Apollo 11 flight report');
  add('site.launch_azimuth', _aeT('tb_kn_site_azimuth'), AE_SITE_FACTS.launchAzimuthDeg, '°', 'NASA Apollo 11 flight report');
  add('site.saturn_vac', _aeT('tb_kn_site_saturn_vac'), AE_SITE_FACTS.saturnThrustVacN, 'N', 'NASA Saturn V flight manual');
  add('site.saturn_drag', _aeT('tb_kn_site_saturn_drag'), 'Cd ' + AE_SITE_FACTS.saturnDragCd + ' × ' + AE_SITE_FACTS.saturnAreaM2 + ' m²', '', 'Zimi (10.1 m across)');
  add('site.saturn_pitch', _aeT('tb_kn_site_saturn_pitch'), AE_SITE_FACTS.saturnTilt.perS + ' · (t − ' + AE_SITE_FACTS.saturnTilt.startS + ' s)^' + AE_SITE_FACTS.saturnTilt.pow + ', ≤ ' + AE_SITE_FACTS.saturnTilt.maxDeg, '°', 'Zimi, fitted to the Apollo 11 flight report');
  add('site.jump', _aeT('tb_kn_site_jump'), AE_SITE_FACTS.jumpMs.moon + ' (' + _tp('Moon') + ') · ' + AE_SITE_FACTS.jumpMs.mars + ' (' + _tp('Mars') + ')', 'm/s', 'Zimi');
  add('site.tower', _aeT('tb_kn_site_tower'), AE_SITE_FACTS.launchTowerM, 'm', 'NASA Launch Complex 39');
  // The missions' (almanac-missions.js): the report's numbers the Apollo 11 flight is fitted to, and the fit's one allowance.
  var MR = 'NASA Apollo 11 Mission Report MSC-00171';
  add('ms.a11_zero', _aeT('tb_kn_ms_a11_zero'), '1969-07-16 13:32:00', 'UT', MR + ', table 3-I');
  add('ms.a11_park', _aeT('tb_kn_ms_park'), '186.5 × 183.7 · 32.521', 'km · °', MR);
  add('ms.a11_tli', _aeT('tb_kn_ms_tli'), '2:44:16.2 – 2:50:03.2', 'h:mm:ss', MR + ', table 3-I');
  add('ms.a11_loi', _aeT('tb_kn_ms_loi'), '75:49:50.4 + 357.6 s · 314.3 × 111.1', 'km', MR + ', table 7-II');
  add('ms.a11_pdi', _aeT('tb_kn_ms_pdi'), '102:33:05 · 7,129 ft at 125 ft/s (P64, 102:41:32)', '', MR + ', tables 5-I and 5-III');
  add('ms.a11_land', _aeT('tb_kn_ms_land'), '102:45:39.9 · 0.67408 N 23.473 E', '', MR + ', table 5-I; LROC');
  add('ms.a11_chain', _aeT('tb_kn_ms_chain'), '23 report states · coasts land on each · burns fitted to their cut-off', '', 'Zimi (scripts/mission_fit.py, scripts/missions/apollo11.json: ' + MR + ', tables 7-II and 7-VII; every event within its tolerance, tests/test_mission_events.py)');
  add('ms.a11_ei', _aeT('tb_kn_ms_ei'), '195:03:05.7 · 3.19 S 171.96 E · 36,194 ft/s · −6.48', 'h:mm:ss · ° · °', MR + ', table 7-VII');
  add('ms.a11_entry_note', _aeT('tb_kn_ms_entry'), _aeT('tb_kn_ms_entry_v'), '', MR + ', table 7-VII');
  add('ms.m20_launch', _aeT('tb_kn_ms_m20_launch'), _aeT('tb_kn_ms_m20_launch_v'), '', 'NASA/JPL Mars 2020 press kit; ULA Atlas V Launch Services User\'s Guide; JPL Horizons -168');
  add('ms.m20_edl', _aeT('tb_kn_ms_m20'), _aeT('tb_kn_ms_m20_v'), '', 'NASA/JPL Mars 2020 press kit (touchdown 20:55:00 UTC as received on Earth, less its 11 min 22 s one-way light time: 20:43:38 on Mars); JPL Horizons -168 (the place at the entry, 20:36:46 UTC)');
  add('ms.a11_rendezvous', _aeT('tb_kn_ms_rdv'), _aeT('tb_kn_ms_rdv_v'), '', MR + ', table 3-I');
  add('ms.a11_splash', _aeT('tb_kn_ms_splash'), '195:18:35 · 13.30 N 169.15 W', '', MR + ', table 7-VII');
  add('ms.a11_fit', _aeT('tb_kn_ms_fit'), '× 1.055 (first stage), × 0.983 (second and third)', '', 'Zimi (scripts/mission_ascent_fit.py), fitted to the first-stage cut-off of the Saturn V AS-506 flight evaluation (67 km, 2.4 km/s)');
  add('ms.voyager_flybys', _aeT('tb_kn_ms_voyager'), 'Jupiter 348,435 · Saturn 184,030 km (Voyager 1)', 'km', 'NASA/JPL Horizons; checked against NSSDCA\'s Voyager trajectory tables (closest-approach times read as ephemeris time, TT, which is how they sit against Horizons\' UT)');
  // Stand at the pad (almanac-padview.js): what is assumed in it.
  add('pv.view', _aeT('tb_kn_pv_view'), _aeT('tb_kn_pv_view_v'), '', 'Zimi (almanac-padview.js PV_PADS)');
  add('pv.climb', _aeT('tb_kn_pv_climb'), _aeT('tb_kn_pv_climb_v'), '', 'Zimi, fitted to the mission\'s own table (static/earth/missions-v1.json)');
  add('pv.pad', _aeT('tb_kn_pv_pad'), _aeT('tb_kn_pv_pad_v'), '', 'NASA Apollo Saturn V Launch Vehicle Flight Handbook (the launch umbilical tower); ULA Atlas V Launch Services User\'s Guide; approximate');
  add('pv.exhaust', _aeT('tb_kn_pv_exhaust'), _aeT('tb_kn_pv_exhaust_v'), '', 'Zimi (the mission player\'s flame lengths, almanac-missions.js)');
  return rows;
}

// A body's place now: the Earth at the middle, the Moon, the Sun as shown, a planet or moon as shown.
function _aeBodyPos(key, sc) {
  sc = sc || _ae.scene;
  if (!sc || key === 'earth') return [0, 0, 0];
  if (key === 'moon') return sc.moon;
  if (key === 'sun') return _aeSunShown(sc);
  if (key === 'iss') return _ae.issPos || null;
  var p = _ae.gl && _ae.gl.planets && _ae.gl.planets[key];
  if (p) return p.pos;
  return _aeCraftPosOf(key);   // a probe while its table covers the date, or a craft orbiting the Earth; null for anything not there
}
function _aeCraftPosOf(key) { return _aeProbePos[key] || (_aeOrbiter[key] && _aeOrbiter[key].pos) || null; }
// Credit for the maps on show: Solar System Scope's licence asks for it.
function _aePlanetCredit() {
  var S = _ae.gl;
  if (!S || !S.planets) return '';
  if (_ae.spin && S.spin) return S.spin.cells.some(function (c) { return c.b.cc && c.uni.mapped.value; }) ? _aeT('alm_earth_credit_sss') : '';
  for (var k in S.planets) {
    var p = S.planets[k];   // a map is drawn when its disc is big enough to have asked for it
    if (p.b.cc && p.uni.mapped.value && p.mesh.visible && p.px >= AE_PLANET_CREDIT_PX) return _aeT('alm_earth_credit_sss');
  }
  var hdCc = S.hd && S.hd.bodies.some(function (b) { return b.cc && b.drawn.length; });   // Almanac HD's planets
  return hdCc ? _aeT('alm_earth_credit_sss') : '';
}

// ── Landmarks: named places on a body, at their true coordinates ──
// landmarks-v1.json (scripts/build_landmarks.py): per body, rows of [name, lat, lon, kind, qid, size_km]. A body's
// places are named as the view comes near enough to read them: a feature once it spans AE_LM_MIN_PX on screen, a landing
// once the body is AE_LM_LANDING_MIN_R_PX in radius, the biggest first and none on top of another. A tap opens its card:
// what it is, its article when the library has it, and Fly there, down to the surface over it. A body is a key, so Mars
// and the rest slot in beside the Moon (with a placement in _aeLmBodies).
var AE_LM_URL = _almAsset('/static/earth/landmarks-v1.json');
var AE_LM_MAX = 18;
var AE_LM_MIN_PX = 28;
var AE_LM_LANDING_MIN_R_PX = 80;
var AE_LM_HIT_PX = 9;                        // a label's hit area reaches this far above and below its drawn box (44 = 26 + 2 x 9); it is the label's padding (--hit), the text stays where it is
var AE_LM_BOX_H = 26;                        // a label's box is this tall (its padding and line), centred on its dot
var AE_LM_PAD_X = 26, AE_LM_FONT_PX = 11;   // its padding either side of the name (.ae-lm), and the name's size
var AE_LM_DOT_X = 9;                         // the dot's centre, from the label's left edge (.ae-lm::before)
var AE_LM_MIN_W_PX = 48;
var AE_LM_EDGE_PX = 8;                       // a name keeps this clear of the screen's right edge
// The Earth's many names (ranked rows) also keep clear of the bars: the top two (the clock and the search), the bottom row, the buttons' column down the right.
var AE_LM_INSET_TOP_PX = 140, AE_LM_INSET_BOTTOM_PX = 100, AE_LM_CONTROLS_PX = 64;
function _aeLmRight(row) { return _ae.w - AE_LM_EDGE_PX - (row[8] === undefined ? 0 : AE_LM_CONTROLS_PX); }   // where a name must end
var AE_LM_FACING = 0.05;                     // how far round the limb a place still faces the camera (cosine)
// A row's kind as its card names it (alm_lm_kind_<name>): the Moon's own kinds fold into the few every body shares.
var AE_LM_KINDS = {
  landing: 'landing', statio: 'landing', crater: 'crater', mare: 'mare', lacus: 'mare', sinus: 'mare', palus: 'mare',
  mons: 'mons', volcano: 'volcano', plain: 'plain', highland: 'highland', promontorium: 'highland', region: 'region',
  valley: 'valley', vallis: 'valley', ridge: 'ridge', rupes: 'ridge', chain: 'chain', catena: 'chain', sea: 'sea',
  wonder: 'wonder', launch: 'launch', landing_feature: 'other',
  range: 'range', cape: 'cape', island: 'island', river: 'river', lake: 'lake', ocean: 'ocean', bay: 'bay', strait: 'strait', desert: 'desert', city: 'city'
};
var AE_LM_LANDERS = { mars: 1, venus: 1 };      // bodies whose quick row has a Landings chip (the Moon's is its own)
// A long thin feature (a ridge, a trough) is long, not prominent: its length counts for less when names compete for room;
// a mountain is the opposite, small for its fame.
var AE_LM_KIND_WEIGHT = { ridge: 0.15, rupes: 0.15, valley: 0.5, chain: 0.5, mons: 2.5 };
var AE_LM_POINT_PRI = 1e6;                       // a place with no extent (a peak, a launch site) ranks after a landing, before any feature
// A place in the lunar night is black: its card says when the Sun comes up there, and offers that morning instead, with
// the Sun this high (low light: every crater's rim casts its shadow).
var AE_LM_MORNING_SUN_DEG = 8;
var AE_LM_DAWN_STEP_MS = 3 * 3600 * 1000, AE_LM_DAWN_LOOK_MS = 31 * MS_PER_DAY, AE_LM_DAWN_TOL_MS = 10 * 60 * 1000;
var _aeLm = null, _aeLmLoading = null;
// The Earth's natural and human features (landmarks-earth-v1.json, scripts/build_landmarks_earth.py): rows like the others'
// plus a rank, Natural Earth's own label zoom. A row with a rank is named once the view is close enough that a feature of
// that zoom spans AE_LM_MIN_PX (AE_LM_RANK_KM halves with every zoom), the lower ranks first. Fetched the first time the
// Landmarks layer is on with the Earth in view, or a name is searched for, and merged after the hand-checked list; names
// in the reader's language come with it (landmarks-earth-names-<lang>-v1.json, parallel to the rows, "" = the English).
var AE_LM_EARTH_URL = _almAsset('/static/earth/landmarks-earth-v1.json');
var AE_LM_EARTH_LANGS = ['ar', 'de', 'es', 'fr', 'he', 'hi', 'pt', 'ru', 'zh'];
var AE_LM_RANK_KM = 4383, AE_LM_RANK_TOP = 10, AE_LM_RANK_STEP = 1000, AE_LM_MAX_EARTH = 10;
var _aeLmEarthLoading = false;
function _aeLmEarthLoad() {
  if (_aeLmEarthLoading || !_aeLm || typeof fetch !== 'function') return;
  _aeLmEarthLoading = true;
  var lang = typeof _uiLangPrimary === 'function' ? _uiLangPrimary() : 'en';
  var json = function (url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url); return r.json(); }); };
  var names = AE_LM_EARTH_LANGS.indexOf(lang) < 0 ? Promise.resolve(null) : json(_almAsset('/static/earth/landmarks-earth-names-' + lang + '-v1.json')).catch(function () { return null; });
  Promise.all([json(AE_LM_EARTH_URL), names]).then(function (got) {
    var rows = got[0].earth, local = got[1];
    rows.forEach(function (r, i) { if (local && local[i]) r[0] = local[i]; _aeLm.earth.push(r); });
    if (_ae) _aeRedraw();
  }).catch(function () { _aeLmEarthLoading = false; });
}
// Off until this viewer turns them on with the pin (kept with the person); a landmark chosen (its card, a landing site
// from Go to) still shows, alone.
var AE_LM_LAYER_KEY = SK.ALM_LANDMARKS;
// Never set, they come on by themselves near the closest stop (the owner); once set either way the choice stands ('0' is off, chosen).
function _aeLmLayerOn() {
  var v = _rawGet(AE_LM_LAYER_KEY);
  return v === '1' || (v === null && !!(_ae && _ae.nearStop));
}
function _aeLmSetLayer(on) {
  _prefWrite(AE_LM_LAYER_KEY, on ? '1' : '0');   // '0': turned off by the person, so near the stop they stay off
  if (on) _aeLmLoad();
  if (_ae) { _aeRedraw(); _aeMarkToggles(); }
}
function _aeLmLoad() {
  if (_aeLm || _aeLmLoading || typeof fetch !== 'function') return;
  _aeLmLoading = fetch(AE_LM_URL).then(function (r) { if (!r.ok) throw new Error('landmarks'); return r.json(); }).then(function (d) {
    _aeLm = d;
    if (_ae) _aeRedraw();
    _aeGoRender();
    _aePlaceRefresh();
  }).catch(function () { _aeLmLoading = null; _aeGoRender(); });
}
// The landing sites' models, ground and rover (almanac-sites.js, -ground.js; the rover's own file loads at the first
// Drive): fetched the first time a landing's card opens, never with the view. The card shows its date and its two
// ways down once they are in.
// The numbers the sites' scenes (almanac-sites*.js) run on that a person is shown or can feel, kept here so the reference
// lists them (_aeRefAxesRows) and the code reads the same ones: a sol, how fast the rovers go, the Saturn V's.
var AE_SITE_FACTS = { solSeconds: 88775.244, marsSolDays: 1.0274912517, msdEpochJd: 2451549.5, msdOffset: 44796.0 - 0.0009626, ttMinusUtcS: 69.184,
  driveLmstH: { msl: 13, m20: 14 }, lrvSpeedMs: 3.61, marsDriveSpeedMs: 0.042, driveFastRate: 10, marsDriveFastRate: 100, driveHeldRateCap: 60, driveBoostAfterS: 1.5, driveBoostRampS: 3, driveBoostMax: 8, saturnMassKg: 2.97e6, saturnThrustN: 34.5e6, saturnBurnKgS: 13300, saturnCutoffS: 161, launchAzimuthDeg: 72, launchTowerM: 122,
  saturnThrustVacN: 39.0e6, saturnDragCd: 0.5, saturnAreaM2: 80, saturnTilt: { startS: 12, perS: 1.2, pow: 0.78, maxDeg: 62 }, jumpMs: { moon: 3.0, mars: 4.4 } };
var AE_SITES_JS = [_almAsset('/static/almanac-sites.js'), _almAsset('/static/almanac-sites-ground.js')];
// Missions flown end to end (almanac-missions.js): fetched the first time one is asked for, never with the view. The
// ids are in the order of the Go to list; their names are alm_ms_<id>.
var AE_MISSIONS_JS = _almAsset('/static/almanac-missions.js'), AE_MISSION_IDS = ['apollo11', 'perseverance', 'voyager1', 'voyager2'], AE_GO_MS = 'ms:';
// The missions whose launch can be watched from the pad (almanac-padview.js): each has a row of its own under Missions, pad:<id>.
var AE_PAD_IDS = ['apollo11', 'perseverance'], AE_GO_PAD = 'pad:';
function _aeGoPadId(key) { return key.indexOf(AE_GO_PAD) === 0 ? key.slice(AE_GO_PAD.length) : null; }
// Standing at a mission's pad from the Go to sheet: Back returns to the Earth (the pad's own way out when nothing opened it).
function _aeGoPad(id) { _aePadOpen(id, {}); }
// Sent (almanac-sent.js): everything people have sent away from Earth, its index fetched by that file. Asked for the first time the
// Sent pill is shown (or a search finds nothing yet), never with the view.
var AE_SENT_JS = _almAsset('/static/almanac-sent.js'), AE_SENT = 'sent:', _aeSent = null, _aeSentScript = false;
function _aeSentStart() {
  if (_aeSentScript) return;
  _aeSentScript = true;
  _aeLoadJs(AE_SENT_JS).then(function (ok) { if (!ok) _aeGoRender(); });   // it stays asked for: a failed load is not retried by every render (the craft rows keep their glyphs)
}
// The Sent pill: every object, one row each (the flown missions stay in All, under Missions: Apollo 11, Perseverance and the Voyagers are rows here).
function _aeGoSentList() {
  _aeSentStart();
  return '<div class="ae-go-list ae-sent-list">' + (_aeSent ? _aeSentRows() : _aeGoRow(AE_GO_LOADING)) + '</div>';
}
function _aeSentGone() { return _aeSent ? _aeSentEndedKeys() : []; }
function _aeMissionStart(id, atT, link) {
  if (typeof _aeMissionOpen === 'function') { _aeMissionOpen(id, atT, false, link); return; }
  _aeLoadJsOnce(AE_MISSIONS_JS, function () { _aeMissionOpen(id, atT, false, link); }, function () { _aeLinkModeDone(); });
}
// The one way into a mission from outside (the landing site's "Follow the mission", an address, a card): at a time (seconds from its zero, T+) or at a named event
// ('liftoff_moon') or phase ('ascent'); no `at` is the start. Opens the 3D view first if it is not open.
function openAlmanacMission(id, at) {
  var go = function () { _aeMissionStart(id, at); };
  if (_aeIsOpen && _ae && _ae.gl) { go(); return; }
  if (typeof openAlmanacEarth === 'function') openAlmanacEarth({ target: 'moon' });
  _aeLinkWait(function () { return _aeIsOpen && !!_ae && !!_ae.gl && _aeReady(); }, go);
}
// Stand at a launch pad (almanac-padview.js): fetched the first time it is asked for, never with the view. opts: { back: { where, go }, atS }.
var AE_PADVIEW_JS = _almAsset('/static/almanac-padview.js');
function _aePadOpen(id, opts) {
  if (typeof _aePadStart === 'function') return _aePadStart(id, opts);
  return _aeLoadJs(AE_PADVIEW_JS).then(function (ok) { return ok ? _aePadStart(id, opts) : false; });
}
// Drive from Stand here: the ground view is put down and the rover set on it, at the place it stood (the sites' own files and
// the landmarks that give it a frame are fetched first, here, the first time).
var AE_DRIVE_WAIT_MS = 120000, AE_DRIVE_POLL_MS = 150;
// Calls back (true) once the sites' files and the landmarks are in, or (false) if they never came.
function _aeWhenSites(cb) {
  _aeSitesLoad();
  _aeLmLoad();
  var waited = 0, go = function () {
    if (!_ae) return;
    if (typeof _aeSiteVisit !== 'function' || !_asData || !_aeLm) {
      if ((waited += AE_DRIVE_POLL_MS) < AE_DRIVE_WAIT_MS) setTimeout(go, AE_DRIVE_POLL_MS); else cb(false);
      return;
    }
    cb(true);
  };
  go();
}
function _aeDriveHere(key, lat, lon) {
  if (AE_DRIVE_BODIES.indexOf(key) < 0 || (typeof _aeStOnWater === 'function' && _aeStOnWater(key, lat, lon))) return;
  _aeWhenSites(function (ok) {
    if (!ok) return;
    var sd = _ae.stand, eye = sd && sd.key === key && sd.live ? { alt: sd.altKm * 1000, yaw: sd.yaw + sd.userYaw, pitch: sd.pitch, fov: _aeDeg(_aeStandFov()) } : null;   // Stand's camera: the drive starts from it
    // Standing on this ground already: the visit takes the very ground stood on (no second build, no move of the camera), the eye where one stood,
    // and the rover is called up beside it ("walking and standing should be the same viewport and adding rover shouldn't cost anything").
    var keep = eye && sd.mode === 'ground' && !sd.fading && typeof _aeHostAdopt === 'function' ? sd : null;
    if (keep) { var w = sd.walk; eye.x = w ? w.x : 0; eye.y = w ? w.y : 0; lat = sd.lat; lon = sd.lon; }
    var go = function () {
      if (keep && _ae.stand !== keep) return;   // (left meanwhile)
      if (!keep && (_ae.stand || _ae.standPending)) _aeStandDrop(true);   // (kept, it stays on screen until the visit's first frame takes it: _aeDraw)
      _aeSiteVisit(key, [_aeInfoName(key), lat, lon, 'landing'], true, null, eye, keep);
    };
    if (typeof _asRoverBuild !== 'function' && typeof _asDriveLoad === 'function') _asDriveLoad(go); else go();   // the drive's scripts first, while one still stands
  });
}
var _aeSitesLoading = false;
function _aeSitesLoad() {
  if (_aeSitesLoading) return;
  _aeSitesLoading = true;
  Promise.all(AE_SITES_JS.map(function (src) { return _aeLoadJs(src); })).then(function (ok) {
    if (ok.indexOf(false) >= 0) _aeSitesLoading = false;
    else {
      if (_ae && _ae.lm) _aeRenderCard();
      if (_aeGoUp()) _aeGoRender();   // (the landings' marks)
    }
  });
}
// The bodies the landmarks file lists, in its order (the Moon first).
function _aeLmBodyKeys() { return Object.keys(_aeLm).filter(function (k) { return Array.isArray(_aeLm[k]) && Array.isArray(_aeLm[k][0]); }); }
// Where each body with landmarks stands: its centre, radius and turn (the rotation part of its matrix, column-major,
// squashed along its pole by its flattening where it is drawn so).
// `withGrounds`: the bodies a ground can be stood on besides (the visits and the drive want a frame of every one, whatever the landmarks file lists of it).
function _aeLmBodies(withGrounds) {
  var S = _ae.gl, sc = _ae.scene;
  if (!S || !sc || !_aeLm) return [];
  var out = [], keys = _aeLmBodyKeys();
  if (withGrounds) AE_STAND_KEYS.forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
  keys.forEach(function (k) {
    if (k === 'moon') out.push({ key: k, center: sc.moon, r: AE_MOON_RADIUS_RE, m: S.moon.matrix.elements });
    else if (k === 'earth') {
      var c = Math.cos(S.earth.rotation.z), sn = Math.sin(S.earth.rotation.z), f = 1 - AE_EARTH_FLATTENING;
      out.push({ key: k, center: [0, 0, 0], r: 1, m: [c, sn, 0, 0, -sn, c, 0, 0, 0, 0, f, 0] });
    } else {
      var p = S.planets && S.planets[k];
      if (p && p.pos) out.push({ key: k, center: p.pos, r: p.b.r, m: p.mesh.matrix.elements });
    }
  });
  return out;
}
function _aeLmVecDir(b, v) { var e = b.m; return [e[0] * v[0] + e[4] * v[1] + e[8] * v[2], e[1] * v[0] + e[5] * v[1] + e[9] * v[2], e[2] * v[0] + e[6] * v[1] + e[10] * v[2]]; }
function _aeLmVec(b, lat, lon) { return _aeLatLonVec(lat, lon, b.key === 'earth' ? AE_EARTH_FLATTENING : 0); }
function _aeLmDir(b, lat, lon) { return _aeLmVecDir(b, _aeLmVec(b, lat, lon)); }
function _aeLmRowDir(b, row) { return _aeLmVecDir(b, row.vec || (row.vec = _aeLmVec(b, row[1], row[2]))); }   // (a row's vector in its body's frame is worked out once: it is asked for every row at every frame)
// With Landmarks off only the place chosen is named. Landmarks on names everything, landing sites first.
function _aeLmQuietRows(body, chosen) { return chosen && chosen.body === body ? [chosen.row] : null; }
// A label's box on screen: the dot and the name's whole width, which runs to the right of the dot or, when it would run off
// the right edge, to the left. A label whose box meets a placed label's box waits for a closer view.
var _aeLmCtx = null, _aeLmWidths = {};
function _aeLmTextW(text) {
  if (_aeLmWidths[text] === undefined) {
    if (!_aeLmCtx) {
      _aeLmCtx = document.createElement('canvas').getContext('2d');
      _aeLmCtx.font = AE_LM_FONT_PX + 'px ' + getComputedStyle(_aeById('ae-lms')).fontFamily;
    }
    _aeLmWidths[text] = _aeLmCtx.measureText(text).width;
  }
  return _aeLmWidths[text];
}
function _aeLmBox(c) {
  var w = AE_LM_PAD_X + _aeLmTextW(c.row[0]), left = c.s.x - AE_LM_DOT_X + w > _aeLmRight(c.row);
  var x0 = left ? c.s.x + AE_LM_DOT_X - w : c.s.x - AE_LM_DOT_X;
  return { x0: x0, x1: x0 + w, y0: c.s.y - AE_LM_BOX_H / 2, y1: c.s.y + AE_LM_BOX_H / 2, left: left };
}
// How far a label's hit area reaches above and below its text (its padding): the finger's 44 px where there is room, else half of what is
// between it and the placed label above or below it (the nearer label wins the gap; drawn boxes never overlap).
function _aeLmHitRoom(c, placed) {
  var up = AE_LM_HIT_PX, down = AE_LM_HIT_PX, b = c.box;
  placed.forEach(function (q) {
    if (q === c || b.x0 >= q.box.x1 || q.box.x0 >= b.x1) return;
    if (q.box.y1 <= b.y0) up = Math.min(up, (b.y0 - q.box.y1) / 2);
    else if (q.box.y0 >= b.y1) down = Math.min(down, (q.box.y0 - b.y1) / 2);
  });
  return Math.floor(Math.min(up, down));
}
// Where the You marker and its word stand on screen, so a name gives way to it (a city's name under "You" read as one muddle).
function _aeYouBox() {
  if (!_ae.you || _ae.target !== 'earth' || !_ae.scene) return null;
  var p = _aeFixedToScene(_aeGeodeticToFixed(_ae.you.lat, _ae.you.lon), _ae.scene.gast);
  if (!_aeFacing(p)) return null;
  var s = _aeProject(p);
  if (!s) return null;
  var w = AE_LABEL_DX + AE_YOU_GAP_PX + _aeLmTextW(_aeT('alm_earth_you')) + AE_LM_PAD_X, toLeft = s.x > _ae.w / 2;
  return { x0: toLeft ? s.x - w : s.x - AE_LABEL_DX, x1: toLeft ? s.x + AE_LABEL_DX : s.x + w, y0: s.y - AE_LM_BOX_H / 2, y1: s.y + AE_LM_BOX_H / 2 };
}
// The craft being flown stands over the names: a name never runs under it (its picture is above the labels).
var AE_SHIP_CLEAR_PX = 56;
function _aeShipBox() {
  var sh = _ae.ship;
  if (!sh || !sh.pos || !_ae.gl) return null;
  var s = _aeProject(sh.pos);
  return s ? { x0: s.x - AE_SHIP_CLEAR_PX, x1: s.x + AE_SHIP_CLEAR_PX, y0: s.y - AE_SHIP_CLEAR_PX * 0.7, y1: s.y + AE_SHIP_CLEAR_PX * 0.7 } : null;
}
function _aeUpdateLandmarks() {
  var host = _aeById('ae-lms');
  if (!host) return;
  var placed = [];
  if (_aeLm && !_ae.fly && !_ae.hand) {
    var cam = _ae.gl.camera, eye = _aeXyz(cam.position);
    var pxPerRad = _aePxPerRad(cam);
    var cands = [], layer = _aeLmLayerOn(), chosen = _ae.lm || (_ae.sent && _ae.sent.spot);   // a site, or where something sent came down
    _aeLmBodies().forEach(function (b) {
      var rows = layer ? _aeLm[b.key] : _aeLmQuietRows(b.key, chosen);
      if (layer && chosen && chosen.body === b.key && rows && rows.indexOf(chosen.row) < 0) rows = rows.concat([chosen.row]);   // (a spot is no row of the layer's)
      if (!rows) return;
      if (b.key === 'earth' && layer) _aeLmEarthLoad();
      var rPx = b.r / _aeLen(_aeSub(b.center, eye)) * pxPerRad;
      if (rPx < AE_LM_LANDING_MIN_R_PX / 2) { if (rPx > 4 && layer) _aeLmLoad(); return; }
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i], d = _aeLmRowDir(b, row), n = _aeNorm(d);
        var p = [b.center[0] + d[0] * b.r, b.center[1] + d[1] * b.r, b.center[2] + d[2] * b.r];
        var toEye = _aeSub(eye, p), dist = _aeLen(toEye);
        if (_aeDot(n, toEye) < AE_LM_FACING * dist) continue;
        var rank = row[8], ext = rank === undefined ? row[5] : AE_LM_RANK_KM * Math.pow(2, -rank);   // a ranked row's extent is its zoom's
        var landing = row[3] === 'landing', point = !ext;   // a point has no extent to measure: it shows with the body
        var px = ext / AE_EARTH_RADIUS_KM / dist * pxPerRad * (rank === undefined ? AE_LM_KIND_WEIGHT[row[3]] || 1 : 1);
        var mine = !!chosen && chosen.row === row;   // the place chosen is named however small it is on screen, and before any other
        if (!mine && (point ? rPx < AE_LM_LANDING_MIN_R_PX : px < AE_LM_MIN_PX)) continue;
        var s = _aeProject(p);
        if (!s || s.x < 0 || s.y < 0 || s.x > _ae.w || s.y > _ae.h) continue;
        if (rank !== undefined && (s.y < AE_LM_INSET_TOP_PX || s.y > _ae.h - AE_LM_INSET_BOTTOM_PX)) continue;
        cands.push({ b: b.key, row: row, s: s, mine: mine, fame: (row[7] || 0) + (rank === undefined ? 0 : (AE_LM_RANK_TOP - rank) * AE_LM_RANK_STEP), pri: landing || mine ? Infinity : point ? AE_LM_POINT_PRI : px });
      }
    });
    // Landing sites first, then the best known (row[7]: how many Wikipedias have an article, the body's top few ahead of
    // all), then the biggest on screen: a name that must give way to another is the more obscure one.
    cands.sort(function (a, c) {
      if (a.mine !== c.mine) return a.mine ? -1 : 1;
      if (a.pri === Infinity || c.pri === Infinity) return a.pri === c.pri ? c.fame - a.fame : a.pri === Infinity ? -1 : 1;
      return c.fame - a.fame || c.pri - a.pri;
    });
    var youBox = _aeYouBox(), shipBox = _aeShipBox(), cap = cands.length && cands[0].b === 'earth' ? AE_LM_MAX_EARTH : AE_LM_MAX;   // the Earth's names are many: a handful at a time
    for (var k = 0; k < cands.length && placed.length < cap; k++) {
      var c = cands[k], bx = c.box = _aeLmBox(c);
      if (bx.x0 < 0 || bx.x1 > _ae.w || bx.y0 < (_ae.pinPx || 0) || bx.y1 > _ae.h) continue;   // a name is never drawn partly off the screen or under the bars   // a name is never drawn partly off the screen or under the bars
      if (shipBox && bx.x0 < shipBox.x1 && shipBox.x0 < bx.x1 && bx.y0 < shipBox.y1 && shipBox.y0 < bx.y1) continue;
      if (youBox && bx.x0 < youBox.x1 && youBox.x0 < bx.x1 && bx.y0 < youBox.y1 && youBox.y0 < bx.y1) continue;   // the You marker has the place
      if (placed.some(function (q) { return bx.x0 < q.box.x1 + 1 && q.box.x0 < bx.x1 + 1 && bx.y0 < q.box.y1 && q.box.y0 < bx.y1; })) continue;   // (a pixel of room: the drawn name is a hair wider than the canvas measured it)
      placed.push(c);
    }
  } else if (_ae.target === 'moon' || (_aeLmLayerOn() && (_ae.target === 'earth' || _aeIsPlanet(_ae.target)))) _aeLmLoad();   // at the Moon its names come with it (the Landings chip works first time); with Landmarks on, at any body
  while (host.children.length < placed.length) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ae-lm';
    btn.onclick = function () { if (this._aeLm) _aeLmOpen(this._aeLm.b, this._aeLm.row); };
    host.appendChild(btn);
  }
  for (var j = 0; j < host.children.length; j++) {
    var el = host.children[j], c2 = placed[j];
    if (!c2) { if (!el.hidden) el.hidden = true; el._aeLm = null; continue; }
    el.hidden = false;
    el._aeLm = c2;
    _aeSetText(el, c2.row[0]);
    el.classList.toggle('ae-lm-landing', c2.row[3] === 'landing');
    // A name that would run off the right edge reads to the left of its dot.
    var left = c2.box.left;
    el.classList.toggle('ae-lm-left', left);
    // A name longer than the room it has (a long landing's, any language) is cut with an ellipsis inside the screen, never off it.
    el.style.maxWidth = Math.max(AE_LM_MIN_W_PX, Math.floor(left ? c2.s.x + AE_LM_DOT_X - AE_LM_EDGE_PX : _aeLmRight(c2.row) - (c2.s.x - AE_LM_DOT_X))) + 'px';
    el.style.setProperty('--hit', _aeLmHitRoom(c2, placed) + 'px');
    el.style.transform = left ? 'translate(' + Math.round(c2.s.x + AE_LM_DOT_X) + 'px,' + Math.round(c2.s.y) + 'px) translate(-100%,-50%)' :
      'translate(' + Math.round(c2.s.x - AE_LM_DOT_X) + 'px,' + Math.round(c2.s.y) + 'px) translateY(-50%)';
  }
}
// The Sun's height (its sine) over a place on the Moon at a time.
function _aeLmSunAt(row, ms) {
  var sc = _aeSceneAt(ms), m = _aeMoonBasis(sc);
  var v = _aeLatLonVec(row[1], row[2]);
  var n = [m.x[0] * v[0] + m.y[0] * v[1] + m.z[0] * v[2], m.x[1] * v[0] + m.y[1] * v[1] + m.z[1] * v[2], m.x[2] * v[0] + m.y[2] * v[1] + m.z[2] * v[2]];
  var p = _aeAdd(sc.moon, _aeScale(n, AE_MOON_RADIUS_RE));
  return _aeDot(n, _aeNorm(_aeSub(sc.sun, p)));
}
// The next lunar morning there after ms: when the Sun climbs past AE_LM_MORNING_SUN_DEG. Null if none within a month.
function _aeLmMorning(row, ms) {
  var want = Math.sin(_aeRad(AE_LM_MORNING_SUN_DEG)), a = ms, fa = _aeLmSunAt(row, a) - want;
  for (var t = ms + AE_LM_DAWN_STEP_MS; t <= ms + AE_LM_DAWN_LOOK_MS; t += AE_LM_DAWN_STEP_MS) {
    var ft = _aeLmSunAt(row, t) - want;
    if (fa < 0 && ft >= 0) {
      var lo = a, hi = t;
      while (hi - lo > AE_LM_DAWN_TOL_MS) { var mid = (lo + hi) / 2; if (_aeLmSunAt(row, mid) - want < 0) lo = mid; else hi = mid; }
      return hi;
    }
    a = t; fa = ft;
  }
  return null;
}
function _aeLmOpen(body, row) {
  _ae.selected = null;
  _ae.sent = null;
  _ae.pick = null;
  _ae.lm = { body: body, row: row, hit: null };
  var lm = _ae.lm;
  if (row[4] && window.AlmanacLinks && AlmanacLinks.resolve) {
    AlmanacLinks.resolve([row[4]]).then(function (links) {
      if (_ae.lm !== lm || !links[row[4]]) return;
      lm.hit = links[row[4]];
      _aeRenderCard();
    });
  }
  _aeRenderCard();
}
function _aeRenderLmCard(card) {
  var lm = _ae.lm, row = lm.row;
  var kind = _aeT('alm_lm_kind_' + (AE_LM_KINDS[row[3]] || 'other'));
  var line = row[5] ? kind + ' · ' + _aeT('alm_lm_size', { km: _orrNum(row[5], null, 0) }) : kind;
  var name = _almEsc(row[0]);
  var now = _aeDisplayMs();
  if (lm.morning === undefined) lm.morning = lm.body === 'moon' && _aeLmSunAt(row, now) < 0 ? _aeLmMorning(row, now) : null;
  // The card says what the place is, and the night (with sunrise as the link, which goes there then) if it is dark.
  var morningLine = lm.morning ? _aeT('alm_lm_night_until', { date: _aeFmtWhen(lm.morning) }) : '';
  var night = '';
  var site = typeof _aeSiteCardHtml === 'function' ? _aeSiteCardHtml(lm) : '';   // a landing's date, and the way down to it (almanac-sites.js)
  if (!site && (row[3] === 'landing' || row[3] === 'launch')) _aeSitesLoad();   // a launch pad has its way down too (Cape Canaveral)
  var sites = !!site;
  aeCaption('night', morningLine, { prio: AE_CAP_PRIO_SUN, onTap: morningLine ? function () { var at = lm.morning; lm.morning = null; _aeGoTo(at); _aeLmFly(lm.body, row); _aeRenderCard(); } : null });   // the night is said above the card, not in it
  if (sites) {
    // A site: its face, its name and year, and the two verbs. No X and no long date: the rim or a tap on the picture puts it away.
    var face = typeof _aeSentFaceFor === 'function' ? _aeSentFaceFor(lm) : '';
    card.innerHTML = '<div class="ae-sitecard as-go"><span class="ae-sc-face">' + (face || _aeGoDisc(lm.body)) + '</span><span class="ae-sc-text"><b>' + name + '</b><small>' + _almEsc(typeof _aeSiteYear === 'function' ? _aeSiteYear(lm) : '') + '</small></span>' + site + '</div>';
    card.classList.add('ae-card-site');
  } else {
    card.classList.remove('ae-card-site');
    card.innerHTML = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
      '<h3>' + (lm.hit ? '<a href="#" id="ae-lm-read">' + name + '</a>' : name) + '</h3>' +
      '<p class="ae-lm-line"><span>' + _almEsc(line) + '</span></p>' + (lm.note ? '<p class="ae-lm-line"><span>' + _almEsc(lm.note) + '</span></p>' : '');
  }
  card.hidden = false;
  if (site) _aeSiteCardBind(card, lm);
  var cardX = _aeById('ae-card-x');
  if (cardX) cardX.onclick = function () { _ae.lm = null; _aeRenderCard(); };
  var read = _aeById('ae-lm-read');
  if (read) read.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(lm.hit); };
}
// Down to the place: the camera comes over it, as near as the body's tiles allow, looking straight down.
// A landmark opened from elsewhere (an article's Almanac button, an address): the camera goes down until the place fills about a
// third of the picture, where the picture is sharp enough to show it (Almanac HD over its body, or the place at least
// AE_LM_SHARP_TEXELS of the body's own map across) and that is nearer than the whole world; else the whole world, the place
// centred and named.
var AE_LM_SHARP_TEXELS = 6, AE_LM_FRAME_SHARE = 1 / 3;
function _aeLmSharpEnough(body, row) {
  var S = _ae.gl, t = AE_TARGETS[body];
  if (S && S.hd && S.hd.bodies.some(function (x) { return x.key === body; })) return true;
  if (!S || !t || !(row[5] > 0)) return false;
  var texelKm = 2 * Math.PI * t.surface * AE_EARTH_RADIUS_KM / _aeBaseMapW(body, S);
  return row[5] >= AE_LM_SHARP_TEXELS * texelKm;
}
function _aeLmFlyFramed(body, row) {
  if (!Object.prototype.hasOwnProperty.call(AE_TARGETS, body)) return;
  var b = _aeLmBodies(true).filter(function (x) { return x.key === body; })[0], t = AE_TARGETS[body], S = _ae.gl;
  if (!b || !t) return;
  // The closest stop as the map now in hand makes it (_aeCloseStop keeps it each frame, but not during a flight or before the
  // view's first frames on this body: the one left from the small map would hold the camera far off).
  var hdBody = !!(S.hd && S.hd.bodies && S.hd.bodies.some(function (x) { return x.key === body; }));
  if (!hdBody && (body === 'earth' || body === 'moon' || _aePlanetBody(body))) t.min = t.stop = Math.max(t.floor !== undefined ? t.floor : t.min, _aeSharpMin(body, S));
  var fit = _aeClampDist(_aeBodyFitDist(body));
  var near = _aeClampDist(t.surface + _aeFitDist(row[5] / AE_EARTH_RADIUS_KM / 2 / AE_LM_FRAME_SHARE));
  if (!_aeLmSharpEnough(body, row) || near >= fit) { _aeLmFly(body, row, 'wide'); return; }
  _aeLmFly(body, row, 'hold');   // the card and the name, no flight of its own
  _aeFlyTo(body, near, _aeAzElOf(_aeLmRowDir(b, row)));
  _ae.preset = null;
}
function _aeLmFly(body, row, still) {
  if (!Object.prototype.hasOwnProperty.call(AE_TARGETS, body)) return;
  var b = _aeLmBodies(true).filter(function (x) { return x.key === body; })[0];
  if (!b) return;
  if (!_ae.lm || _ae.lm.row !== row) _ae.lm = { body: body, row: row, hit: null };   // its name shows there, layer on or off
  _aeRenderCard();
  // Over an Apollo site with Almanac HD, all the way down to the inserts' half-metre tiles.
  var hdb = _ae.gl.hd && _ae.gl.hd.bodies.filter(function (x) { return x.key === body; })[0];
  if (hdb) AE_TARGETS[body].min = _aeHdMinOver(hdb, row[1], row[2]);
  if (still === 'wide') { _aeFlyTo(body, _aeBodyFitDist(body), _aeAzElOf(_aeLmRowDir(b, row))); _ae.preset = null; return; }   // the whole world, the place in its middle
  if (still === 'hold') _ae.fly = null;   // another body: the camera stays as it is until the visit's own move takes it there
  else if (still) { _ae.target = body; _ae.pan = null; _ae.fly = null; }   // the camera is already on the ground there: no flight
  else _aeFlyTo(body, AE_TARGETS[body].min, _aeAzElOf(_aeLmRowDir(b, row)));
  _ae.preset = null;
}

// The offer, in the data note's quiet line: shown to someone who may download (can_change) while the setting is Ask
// first and they have not said Not now for this person; under Automatically the server's first answer already started it.
// It comes with the view's satellite data (_aeTakeSats); while the download runs, /almanac-hd is asked how far it got,
// and once it is in the library the view draws from it without a reload.
var AE_HD_URL = '/almanac-hd', AE_HD_SET_URL = '/manage/almanac-hd', AE_HD_DELETE_URL = '/manage/delete';
var AE_HD_LATER_KEY = SK.ALM_HD_LATER;
var AE_HD_POLL_MS = 3000;
function _aeHdLater() { return _rawGet(AE_HD_LATER_KEY) === '1'; }
function _aeHdPollNow() {
  _aeFetch(AE_HD_URL).then(_aeJson).then(_aeHdShow).catch(function () { _aeHdShow(null); });
}
function _aeHdShow(st) {
  var box = _aeById('ae-hd');
  if (!box) return;
  clearTimeout(_ae.hdPoll);
  var S = _ae.gl;
  if (st) _ae.hdSt = st;   // what the gear's row says (Not now hides only the line, never the row)
  if (st && st.installed) _ae.hdInstalled = true;
  else if (st && _ae.hdInstalled) _aeHdUnload(S);   // taken off the disk (here or from Manage): the standard maps again
  if (_ae.hdInstalled && S && !S.hd && !S.hdAsked) { S.hdAsked = true; _aeHdLoad(S); }
  var text = '', offer = false;
  if (st && st.downloading) {
    text = _aeT('alm_hd_getting', { pct: Math.floor(100 * st.downloading.done / Math.max(1, st.downloading.size)) });
    if (_aeIsOpen) _ae.hdPoll = setTimeout(_aeHdPollNow, AE_HD_POLL_MS);
  } else if (st && st.offer && st.can_change && st.mode === 'ask' && !_aeHdLater()) {
    var size = _aeHdOfferSize(st.offer);
    text = size ? _aeT('alm_hd_offer') + ': ' + _aeT('alm_hd_offer_sub', { size: size }) : _aeT('alm_hd_offer');
    offer = true;
  }
  box.hidden = !text;
  _aeSetText(_aeById('ae-hd-text'), text);
  var act = _aeById('ae-hd-act');
  if (act) act.hidden = !offer;
  _aeRenderSettings();
}
// The offer's size: the release's own figure, or "~210 MB" for the offline estimate made before it is known
// (a whole number: "~210.0 MB" claimed a precision the estimate does not have).
function _aeHdOfferSize(offer) {
  if (!offer || !offer.size) return '';   // not known before the release is read: no figure is claimed
  if (offer.approx || typeof fmtBytes !== 'function') return (offer.approx ? '~' : '') + Math.round(offer.size / 1e6) + ' MB';
  return fmtBytes(offer.size);
}
// Almanac HD in the gear, whatever the line under the controls says: after Not now this is where it is found again.
// Two sizes, one installed at a time (almanachd.py): HD and Maximum, each with its size; the one in use is checked,
// the other one replaces it once it is in. Downloading, how far. Nothing under Never (or ZIMI_OFFLINE), or when this
// version names no file and none is installed.
var AE_HD_KINDS = ['hd', 'max'];
var AE_HD_ERR = { missing: 'alm_hd_missing', checksum: 'alm_hd_err_damaged', disk: 'alm_hd_err_space', network: 'alm_hd_err_stopped', failed: 'alm_hd_err_stopped' };
function _aeHdRowHtml() {
  var st = _ae.hdSt;
  var offers = (st && st.offers) || {};
  if (st && !st.installed && st.missing && st.mode !== 'never')   // this version's release has no Almanac HD
    return '<div class="ae-set-data ae-set-hd"><b>' + _almEsc(_aeT('alm_hd_offer')) + '</b><small>' + _almEsc(_aeT('alm_hd_missing')) + '</small></div>';
  if (!st || (!st.installed && (st.mode === 'never' || !Object.keys(offers).length))) return '';
  var busy = st.downloading, edit = !!st.can_change && !busy;
  var sizes = st.sizes || {}, absent = st.absent || {};
  var rows = AE_HD_KINDS.map(function (k) {
    var mine = st.kind === k, o = offers[k], onDisk = sizes[k];
    var gone = !mine && !o && !onDisk && absent[k];   // this version's release is known not to carry it: said, not left out
    if (!mine && !o && !onDisk && !gone) return '';
    var tail = busy && busy.kind === k ? Math.floor(100 * busy.done / Math.max(1, busy.size)) + '%'
      : gone ? _aeT('alm_hd_missing')
      : mine || onDisk ? _aeT('alm_hd_installed') + (onDisk ? ' \u00b7 ' + _aeHdBytes(onDisk) : '')
      : _aeHdOfferSize(o);
    // The one in use stays a checked, enabled radio (a disabled one reads as off); choosing it again does nothing.
    var radio = '<label class="ae-set-choice' + (edit && !mine && !gone && !onDisk ? '' : ' ae-off') + '"><input type="radio" name="ae-hd-kind" class="ae-hd-kind" value="' + k + '"' +
      (mine ? ' checked' : '') + (edit && !gone ? '' : ' disabled') + '><span><b>' + _almEsc(_aeT('alm_hd_kind_' + k)) + '</b><small>' + _almEsc(tail) + '</small></span></label>';
    return '<div class="ae-hd-line">' + radio + (onDisk && edit && _ae.hdConfirm !== k ? _aeHdRemoveHtml(k, onDisk) : '') + '</div>' + (onDisk && edit && _ae.hdConfirm === k ? _aeHdRemoveHtml(k, onDisk) : '');
  }).join('');
  var who = st.can_change || st.installed ? '' : '<small>' + _almEsc(_aeT('alm_hd_ask_admin')) + '</small>';
  // A size that did not come, and why (almanachd status ``error``); choosing it again resumes what is missing.
  var err = st.error && !busy ? '<small role="status">' + _almEsc(_aeT('alm_hd_kind_' + st.error.kind)) + ': ' +
    _almEsc(_aeT(AE_HD_ERR[st.error.reason] || AE_HD_ERR.failed)) + '</small>' : '';
  // While a size comes in, Cancel stops it and leaves the one in use as it is.
  var stop = busy && st.can_change ? '<button type="button" class="ae-fresh" id="ae-set-hd-cancel">' + _almEsc(_aeT('cancel')) + '</button>' : '';
  return '<div class="ae-set-data ae-set-hd ae-set-ultra" role="radiogroup" aria-label="' + _almEsc(_aeT('alm_hd_offer')) + '"><b>' + _almEsc(_aeT('alm_hd_offer')) + '</b>' + rows + stop + err + who + '</div>';
}
// Remove, with one confirm step in the gear itself: the first press names what it frees, the second does it.
function _aeHdBytes(n) { return typeof fmtBytes === 'function' ? fmtBytes(n) : Math.round(n / 1e6) + ' MB'; }
function _aeHdRemoveHtml(k, bytes) {
  if (_ae.hdConfirm === k)
    return '<div class="ae-hd-rm-row"><button type="button" class="ae-fresh ae-hd-rm-yes" data-kind="' + k + '">' + _almEsc(_aeT('alm_hd_remove_sure', { size: _aeHdBytes(bytes) })) + '</button>' +
      '<button type="button" class="ae-fresh ae-hd-rm-no">' + _almEsc(_aeT('cancel')) + '</button></div>';
  return '<button type="button" class="ae-hd-rm" data-kind="' + k + '">' + _almEsc(_aeT('alm_hd_remove')) + '</button>';   // a small text button at the row's end
}
function _aeHdRemoveAsk(k) { _ae.hdConfirm = k; _aeRenderSettings(); }
function _aeHdRemoveNo() { _ae.hdConfirm = null; _aeRenderSettings(); }
function _aeHdRemoveDo(k) {
  _ae.hdConfirm = null;
  _aePost(AE_HD_SET_URL, { remove: true, kind: k }).then(function (st) {
    st.can_change = true;
    _prefWrite(AE_HD_LATER_KEY, '0');   // the offer to get it again is shown again
    _aeHdShow(st);
  }, function () { _aeHdPollNow(); });
}
// Almanac HD is gone from the disk: the view goes back to its standard maps now, without a reload. Its tiles, their
// meshes and textures are given back and each body's one map is drawn again.
function _aeHdUnload(S) {
  _ae.hdInstalled = false;
  _ae.hdManP = null;
  if (!S) return;
  S.hdAsked = false;
  var hd = S.hd;
  if (!hd) return;
  S.hd = null;
  hd.bodies.forEach(function (b) {
    for (var k in b.nodes) {
      var n = b.nodes[k];
      _aeHdFreeMesh(n);
      for (var l in n.tex) if (n.tex[l] && n.tex[l].isTexture) n.tex[l].dispose();
    }
    b.nodes = {}; b.drawn = [];
    _aeHdMask(b.parent.material, 0, false);
  });
  AE_TARGETS.earth.min = _aeMapsMin();
  AE_TARGETS.moon.min = AE_MIN_DIST_MOON;
  _ae.dist = _aeClampDist(_ae.dist);   // nearer than the standard maps allow: back to where they do
  _aeRedraw();
}
// A size chosen: its download starts; it replaces the one installed once it is in and checked.
function _aeHdKind(input) {
  if (input.disabled || (_ae.hdSt && _ae.hdSt.kind === input.value)) return;
  Array.prototype.forEach.call(document.querySelectorAll('.ae-hd-kind'), function (r) { r.disabled = true; });
  var done = function () { _aeHdPollNow(); };
  _aePost(AE_HD_SET_URL, { start: true, kind: input.value }).then(done, done);
}
function _aeHdCancel() {
  var done = function () { _aeHdPollNow(); };
  _aePost(AE_HD_SET_URL, { cancel: true }).then(done, done);
}
function _aeHdGet() {
  _aeById('ae-hd-get').disabled = true;
  var row = _aeById('ae-set-hd-get');
  if (row) row.disabled = true;
  _aePost(AE_HD_SET_URL, { start: true }).then(function (st) {
    st.can_change = true;
    _aeHdShow(st);
  }).catch(function () { _aeHdPollNow(); }).then(function () { _aeById('ae-hd-get').disabled = false; });   // refused (no Almanac HD in this release): the status says why
}
function _aeHdNotNow() {
  _prefWrite(AE_HD_LATER_KEY, '1');
  _aeHdShow(null);
}

// Over budget: the least recently drawn tiles give their GPU memory back (and are fetched again if needed). What was
// in sight this frame stays; a body left behind loses even its first two levels, which it asks for again on return.
function _aeHdEvict(S) {
  var hd = S.hd;
  if (hd.gpu <= hd.budget) return;
  var all = [];
  hd.bodies.forEach(function (b) {
    for (var k in b.nodes) {
      var n = b.nodes[k];
      if (n.used !== hd.frame && Object.keys(n.tex).some(function (l) { return n.tex[l] && n.tex[l].isTexture; })) all.push(n);
    }
  });
  all.sort(function (a, b) { return a.used - b.used || b.z - a.z; });
  for (var i = 0; i < all.length && hd.gpu > hd.budget; i++) {
    var n = all[i];
    _aeHdFreeMesh(n);
    for (var l in n.tex) {
      // Only what is on the GPU: a tile still on its way keeps its place in the queue.
      if (n.tex[l] && n.tex[l].isTexture) {
        hd.gpu -= n.tex[l].userData.bytes;
        hd.fresh = hd.fresh.filter(function (t) { return t !== n.tex[l]; });
        n.tex[l].dispose();
        delete n.tex[l];
      }
    }
    // A deeper tile's mesh may read this one's night or Moon map: it is built again with what is there.
    hd.bodies.forEach(function (b) {
      for (var k in b.nodes) {
        var m = b.nodes[k];
        if (m.mesh && m !== n && b.maps.some(function (mp) { return _aeHdLayerNode(b, m, mp) === n; })) _aeHdFreeMesh(m);
      }
    });
  }
}

// ── State ──
function _aeNewState(el) {
  return {
    el: el, gl: null, loading: false, failed: false,
    target: 'earth', az: 0, el_: 0, dist: AE_FLY_START_DIST,
    pan: null,                            // the slide across the target ({ t: its name, v: scene offset }), _aePanBy
    issRoll: null,                        // the station view's roll as last drawn (_aeRollDeg holds it near the zenith line)
    flightUp: null, flightOff: 0,         // up carried along a flight (_aeFlightUp)
    fly: null,                            // { start, from:{target pos, dist}, to }
    pointers: {}, pinch: null, drag: null,
    sats: null, satsFailed: false, satsLoading: false,
    satMeta: null,                        // { mode, locked, stale, canChange }: the server's setting
    freshBusy: false, freshFailed: false, // the admin's "Get fresh data", under way / failed
    setOpen: false, setBusy: false, setError: '',   // the gear's panel
    selected: null,                       // { norad, tapMs }: the tapped satellite
    ringsAt: null, moonPathAt: null,
    issFar: 0, issFast: false, issFarAt: 0,   // the station ride's pull out to the whole orbit (0 close .. 1 out), and what asked for it
    positions: [],                        // projected satellites for tapping
    lastTs: 0, lastRender: 0, lastText: 0, dirty: true,
    raf: 0, idleTimer: 0,
    scene: null,
    spin: null                            // Planets side by side while it is up
  };
}

// ── The clock ──
// One clock: the Almanac's (almanac.js _almFocus and _almRate, null for now). The hero Moon, the header, the pinned strip
// and this view all read it, and this view's foot carries the same date and speed slider (_almClockHtml): there is no
// speed of its own. The page's loop advances it (_almClockFrame), and draws this view in the same frame (_aeFollowClock).
// Between two ticks of the page's slow clock (ALM_CLOCK_SLOW_MS, four a second at real time) the instant carries on at
// the clock's rate, so a view drawn every frame moves smoothly instead of in quarter-second steps.
function _aeDisplayMs() {
  var ms = (typeof _almFocusInstant === 'function') ? _almFocusInstant().getTime() : Date.now();
  if (typeof _almClockRunning !== 'undefined' && _almClockRunning && _almClockLast && !_almClockFast()) {
    ms += _almRate * _aeClamp(performance.now() - _almClockLast, 0, ALM_CLOCK_SLOW_MS);
  }
  return ms;
}
function _aeFocusSet() { return typeof _almFocus !== 'undefined' && !!_almFocus; }
// Whether the clock is running faster or slower than a second a second, or backwards: what a still view does not assume.
function _aeClockRuns() { return typeof _almClockRunning !== 'undefined' && _almClockRunning; }
// The page's clock moved (a run of it, a settle): this instant is drawn now, in the same frame as the page, not at the next
// idle tick.
function _aeFollowClock() {
  if (!_aeIsOpen || !_ae || !_ae.gl || _ae.clockBusy) return;
  _ae.dirty = true;
  _aeDraw(performance.now());
  _aeUpdateText(_aeDisplayMs());
}

// ── Camera ──
// The tangent of the narrower half field of view: the vertical one, or on a portrait screen the horizontal one
// (2·atan(tan(vfov/2)·aspect)), which is what a thing must fit inside.
function _aeNarrowTanHalf() {
  var aspect = _ae.w && _ae.h ? _ae.w / _ae.h : _ae.gl.camera.aspect;
  return _aeTanHalf(AE_FOV_DEG) * _aeClamp(aspect, AE_MIN_ASPECT, 1);   // (a screen measured as a sliver mid-layout must not send a fit out to 170 radii: seen on a phone, the Moon)
}
var AE_MIN_ASPECT = 0.25;   // narrower than any phone held upright (a 9:21 one is 0.43)
// The farthest a body's nearest stop may be: its own fit. Whatever raises a stop (the tiles' closest approach, a sharper
// size, a map) never puts the camera beyond the whole body in frame, which is where it would be selected and not seen.
function _aeStopCap(key) {
  return key === 'earth' || key === 'moon' || _aePlanetBody(key) ? _aeBodyFitDist(key) : Infinity;
}
function _aeFitDist(radius) {
  return radius / (_aeNarrowTanHalf() * AE_FIT_FILL);
}
// The distance a body's own view stands at: the whole of it in the picture (its chip's view; a site's way out ends there).
function _aeBodyFitDist(name) {
  if (name === 'moon') return _aeFitDist(AE_FIT_MOON);
  if (name === 'earth') return _aeFitDist(AE_FIT_EARTH);
  var pb = _aePlanetBody(name);
  return _aeFitDist(AE_TARGETS[name].surface * AE_PLANET_FIT * (pb && pb.rings ? 1.6 : 1));
}
// What the camera can circle: how near and far it may go, and the surface a
// drag's speed is measured from.
var AE_TARGETS = {
  earth: { min: AE_MIN_DIST_EARTH, max: AE_MAX_DIST, surface: 1 },
  moon: { min: AE_MIN_DIST_MOON, max: AE_MAX_DIST, surface: AE_MOON_RADIUS_RE },
  sun: { min: AE_MIN_DIST_SUN, max: AE_MAX_DIST_SUN, surface: AE_SUN_SHOW_R }
};
// (Not nearer than the close stop either (_aeCloseStop's, kept apart as t.stop): the maps' own frame put the Earth's min back to theirs between frames, so a pinch
// or a wheel went in past the stop and the next frame threw it back out: a jump.)
function _aeClampDist(d) {
  var t = AE_TARGETS[_ae.target], lo = Math.min(Math.max(isFinite(t.min) ? t.min : 0, isFinite(t.stop) ? t.stop : 0), _aeStopCap(_ae.target));
  return _aeClamp(d, lo, _ae.target === 'iss' && _ae.issWide ? Math.max(t.max, _ae.issWide) : t.max);   // (a flight to the station on a fast clock ends out at its orbit: _ae.issWide)
}
// (Out at the station's orbit, on a clock too fast to follow it, the view looks at the Earth's middle: the whole ring in the picture.)
function _aeTargetPos() { return _ae.target === 'iss' && _ae.issWide ? [0, 0, 0] : _aeBodyPos(_ae.target) || [0, 0, 0]; }
// Whose sky the Moon is shown in: the device's place once asked for (the
// crosshair), else the place chosen for the Almanac; null for neither, and
// then the Moon stands celestial north up and the view says so.
function _aeObserver() {
  if (_ae.you) return _ae.you;
  var loc = (typeof _getLocation === 'function') ? _getLocation() : null;
  return loc && loc.stored ? loc : null;
}
var AE_ISS_UP_EASE_SIN = Math.sin(_aeRad(25));   // sine of the angle from the zenith line within which the station's up is held, not followed
// The camera's turn about its line of sight, in degrees from celestial north
// (positive toward east): on the Moon, the parallactic angle at the observer
// (app.js _moonLimbAngles, the same answer the hero disc turns by), so the
// terminator lies as it does in their sky; everywhere else north is up.
function _aeRollDeg(target, ms) {
  if (target !== 'iss') _ae.issRoll = null;
  // By the station, up is away from the Earth (its zenith), so the horizon lies across the picture. Looking along
  // the zenith (straight down at the Earth, or up from under the station) that up has no direction, and the picture
  // would turn a half turn across a degree or two of a drag: near that line the picture stays as it was and takes
  // up the horizon again as the line leaves it (AE_ISS_UP_EASE_SIN).
  if (target === 'iss' && _ae.issPos) {
    var d = _aeNorm(_aeScale(_aeCameraOffset(_ae.az, _ae.el_, 1), -1)), z = _aeNorm(_ae.issPos);
    var n = _aeSub([0, 0, 1], _aeScale(d, d[2])), u = _aeSub(z, _aeScale(d, _aeDot(z, d)));
    if (_aeLen(n) < 1e-9 || _aeLen(u) < 1e-9) return _ae.issRoll || 0;
    n = _aeNorm(n);
    var raw = _aeDeg(Math.atan2(_aeDot(u, _aeCross(n, d)), _aeDot(u, n))), kept = _ae.issRoll;
    _ae.issRoll = kept == null ? raw : kept + _angleDelta(kept, raw) * _aeSmoother(_aeLen(u) / AE_ISS_UP_EASE_SIN);
    return _ae.issRoll;
  }
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
// `v` turned `ang` radians about the unit vector `axis` (Rodrigues).
function _aeRotateAbout(v, axis, ang) {
  var c = Math.cos(ang), sn = Math.sin(ang), k = _aeCross(axis, v), dk = _aeDot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * sn + axis[0] * dk, v[1] * c + k[1] * sn + axis[1] * dk, v[2] * c + k[2] * sn + axis[2] * dk];
}
// The camera's up during a flight. North-up (`nominal`) spins the picture about the line of sight, without bound,
// wherever that line sweeps past the celestial pole, so up is carried along the flight instead (the previous frame's,
// turned only as far as the line of sight turned) and turned onto north-up over the whole flight, not at its arrival
// alone (the picture would roll half a turn in the last second). The turn is `f.rollEnd` (what the planning pass found
// it to be at the arrival) eased by `prog`, how far through the flight in time: the carried up's distance from
// north-up swings wildly as the line passes the pole, and following it would leak that swing into the picture. Only in
// the last stretch, where the line has settled, is the turn corrected to the distance itself, so the flight lands on
// north-up exactly.
// A flight whose line of sight never comes within 70 degrees of elevation (no pole in the way) needs no carrying: north-up, with the
// view's own roll eased from the old body's to the new one's, is steady all the way. Carrying up round such a swing leaves the
// picture rolled by the path's own curl (59 degrees by the middle of Earth to Mars) and unwinds it over the rest of the flight.
var AE_NORTH_UP_SIN_EL = Math.sin(_aeRad(70));var AE_ROLL_SETTLE = 0.85;
function _aeFlightUp(dir, nominal, f) {
  if (f.northUp) { _ae.flightUp = null; _ae.flightOff = 0; return nominal; }
  var kept = _ae.flightUp, d = _aeNorm(dir), prog = f.prog || 0;
  var up = kept ? _aeSub(kept, _aeScale(d, _aeDot(kept, d))) : null;
  up = up && _aeLen(up) > 1e-6 ? _aeNorm(up) : nominal;
  _ae.flightUp = up;
  // How far north-up is from the carried up, kept on the branch the last frame was on (never a half turn either way).
  var off = Math.atan2(_aeDot(_aeCross(up, nominal), d), _aeDot(up, nominal));
  off = _ae.flightOff + Math.atan2(Math.sin(off - _ae.flightOff), Math.cos(off - _ae.flightOff));
  _ae.flightOff = off;
  var turn = off * _aeSmoother(prog);
  if (f.rollEnd != null) {
    var settle = _aeSmoother((prog - AE_ROLL_SETTLE) / (1 - AE_ROLL_SETTLE));
    turn = f.rollEnd * _aeSmoother(prog) + settle * Math.atan2(Math.sin(off - f.rollEnd), Math.cos(off - f.rollEnd));
  }
  return _aeRotateAbout(up, d, turn);
}
function _aeCameraOffset(az, el, dist) {
  return [dist * Math.cos(el) * Math.cos(az), dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el)];
}
// Direction (az, el) from which the camera looks down on a scene vector.
function _aeAzElOf(v) {
  var n = _aeNorm(v);
  return { az: Math.atan2(n[1], n[0]), el: _aeClamp(Math.asin(n[2]), -AE_MAX_ELEVATION, AE_MAX_ELEVATION) };
}

// `overview`: a pull back to the whole system rather than a flight to a body. No shoulder (there is no one body to
// arrive at): the camera draws straight back on the same eased profile, AE_FLY_OVERVIEW_MS however far it starts.
var AE_FLY_OVERVIEW_MS = 2000, AE_FLY_OVERVIEW_STRETCH = 1.25, AE_FLY_OVERVIEW_KEEP = [0.3, 5];
// ── Stand here ──
// Tap a spot on a body, stand on it: the camera drops to the ground there, at eye height, and looks at the horizon
// (almanac-stand.js, with its terrain almanac-terrain.js and its sky and ground shaders almanac-standgl.js, loaded
// the first time a spot is tapped). The two names below are the way in for anything else that wants the ground.
//   _aeStandAt(body, lat, lon)         enter the view: a promise of whether it started
//   _aeGroundHeight(body, lat, lon)    metres above the body's mean radius; 0 until the body's terrain is loaded
var AE_STAND_KEYS = ['earth', 'moon', 'mercury', 'venus', 'mars', 'io', 'europa', 'ganymede', 'callisto', 'titan', 'pluto', 'ceres', 'vesta', 'charon', 'phobos', 'enceladus', 'mimas', 'tethys', 'dione', 'rhea', 'iapetus', 'triton'];
var AE_DRIVE_BODIES = AE_STAND_KEYS;   // every solid body has a rover and a walk (the gas giants have no ground: the UFO is theirs)
var AE_STAND_SRCS = [_almAsset('/static/almanac-terrain.js'), _almAsset('/static/almanac-terrainshade.js'), _almAsset('/static/almanac-standlook.js'), _almAsset('/static/almanac-standgl.js'), _almAsset('/static/almanac-oneland.js'), _almAsset('/static/almanac-stand.js'), _almAsset('/static/almanac-standhost.js'), _almAsset('/static/almanac-oneair.js')];
var AE_STAND_EYE_M = 1.7;                      // an eye above the ground
var AE_WALK_PACE_MS = 1.4;                     // a person's usual walking pace, m/s (5 km/h): almanac-stand.js walks by it
var AE_WALK_JUMP_MS = 2.6;                     // a standing jump's take-off speed, m/s (about 0.34 m high on the Earth): almanac-stand.js jumps by it in the body's own gravity
var AE_STAND_AIRLESS_DAY_MU = [-0.05, 0.12], AE_STAND_AIRLESS_DAY_LIM = 0.5;   // the Sun's sine of height where the stars go (-3 to 7 degrees), and the faintest star left
var AE_STAND_MARS_TAU = 0.47;                  // the dust in Mars's air, optical depth straight up (red light); Lemmon et al. 2015 find 0.3 to 1 outside storms
var AE_STAND_HAZE_VIS_KM = { venus: 28, titan: 18 };
var AE_STAND_CHARON_KM = 19591;                  // Charon's circular orbit about Pluto (and its radius is in almanac-stand.js)
var AE_STAND_SHADE_GRIDS = '±1500 · ±6000 · ±150000';    // the relief's shadow grids, half-widths in metres (almanac-terrainshade.js)   // how far one sees through the haze at the ground
var _aeStandLoading = null;
var _aeStandLoaded = false;   // every one of Stand's files is in (they load in order: the first's names exist while the last is coming)
var AE_MOVE_MS = 2200;   // a move between space and a ground (Stand here's way down): the same length everywhere, long enough that the ground is built by the time it ends
function _aeStandable(key) { return AE_STAND_KEYS.indexOf(key) >= 0; }
function _aeStandReady() {
  if (_aeStandLoaded) return Promise.resolve();
  if (_aeStandLoading) return _aeStandLoading;
  _aeStandLoading = new Promise(function (resolve, reject) {
    AE_STAND_SRCS.forEach(function (src, i) {
      var el = document.createElement('script');
      el.src = src;
      el.async = false;   // in order, as one scope
      el.onerror = function () { _aeStandLoading = null; reject(new Error(src)); };
      if (i === AE_STAND_SRCS.length - 1) el.onload = function () { _aeStandLoaded = true; resolve(); };
      document.head.appendChild(el);
    });
  });
  _aeStandLoading.catch(function () {});
  return _aeStandLoading;
}
function _aeStandAt(key, lat, lon, link) {
  if (!_aeStandable(key)) return Promise.resolve(false);
  return _aeStandReady().then(function () { return _aeStandStart(key, lat, lon, null, link); }, function () { return false; });
}
// The 2D sky's hand-off (almanac-stand.js has the real ones, which replace these once it is loaded): open Stand here from a card, and the way back.
function _aeStandOpen(h) { return _aeStandReady().then(function () { return _aeStandOpenNow(h); }, function () { return false; }); }
function _aeStandClose() { if (typeof _aeStandCloseNow === 'function') _aeStandCloseNow(); }   // nothing of Stand loaded: nothing of it open
function _aeGroundHeight(key, lat, lon) {
  if (typeof _aeStandHeight !== 'function') { _aeStandReady().catch(function () {}); return 0; }
  return _aeStandHeight(key, lat, lon);
}
function _aeStandBusy() { return !!_ae.standPending || !!(_ae.stand && (_ae.stand.mode !== 'ground' || _ae.stand.fading || _ae.stand.motion || (_ae.stand.walk && _ae.stand.walk.active) || (_ae.stand.shade && _ae.stand.shade.job) || _ae.stand.stepOut)); }

function _aeFlyTo(target, dist, azel, overview, ms) {
  _aeLetGo();
  var from = { pos: _aeTargetPos(), dist: _ae.dist, az: _ae.az, el: _ae.el_, roll: _ae.roll || 0, target: _ae.target };
  _ae.twist = 0;   // (the flight eases the turn the fingers gave back to the view's own, from `from.roll`, which has it)
  _ae.orbitFly = { from: from.target, to: target, endAt: null };   // whose orbits show while it flies
  _ae.pan = null;
  _ae.target = target;
  if (azel) { _ae.az = azel.az; _ae.el_ = azel.el; }
  var to = { dist: _aeClampDist(dist) };
  if (_aeReduceMotion()) { _ae.dist = to.dist; _ae.fly = null; _ae.orbitFly.endAt = performance.now(); }
  else {
    // Turn the short way round.
    var daz = ((_ae.az - from.az + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    ms = ms || (overview ? AE_FLY_OVERVIEW_MS : _aeFlyMs(from, _aeTargetPos(), to.dist, _ae.az, _ae.el_));
    // The station and the Earth it circles are one place, not two bodies a trip apart: the way between them is one straight zoom (in
    // or out), not a swing out over the old body's shoulder (which took the camera out to 2.5 times its distance and back, and
    // crammed half a turn round a station 1e-4 Earth radii across into 200 ms, stretched by the turn limit to 13 s).
    var hold = !overview && !!_ae.scene && target !== from.target && !(from.target === 'iss' && target === 'earth') && !(from.target === 'earth' && target === 'iss') && _aeLen(_aeSub(_aeTargetPos(), from.pos)) > 0;
    var straight = !hold && !overview && from.target === 'earth' && target === 'iss';
    _ae.fly = { start: performance.now(), ms: ms, hold: hold, straight: straight, from: from, toDist: to.dist, toAz: from.az + daz, toEl: _ae.el_, lead: AE_FLY_APPROACH_MS };
    if (hold) {
      var f = _ae.fly;
      _aeSetShoulder(f, false);
      // The leg in swings round the destination toward its view, and can swing across the old body (the Sun's far side, a
      // camera that came out beside it): the shoulder on the other side, when it keeps the camera further from every body.
      var near = _aeFlightClearance(f);
      if (near < AE_FLY_CLEAR) { _aeSetShoulder(f, true); if (_aeFlightClearance(f) <= near) _aeSetShoulder(f, false); }
      _aeShoulderOffPole(f);
      _aeFarFor(f.shoulder.far);
    }
    _ae.az = from.az; _ae.el_ = from.el;
    if (overview) { _ae.fly.maxStretch = AE_FLY_OVERVIEW_STRETCH; _ae.fly.overview = true; }   // spread a fast turn, by a quarter at most
    _aeEaseTurn(_ae.fly);
  }
  _aeMarkViews();
  _aeKick();
}
// The most the picture turns between two frames anywhere in flight `f`, in degrees a frame at 60 fps: the camera is
// stepped through the whole flight as it will be drawn, and the angle between the frames' orientations is taken.
function _aeFlightTurnPeak(f) {
  var saved = { fly: _ae.fly, hand: _ae.hand, dist: _ae.dist, az: _ae.az, el: _ae.el_, up: _ae.flightUp, off: _ae.flightOff, roll: _ae.roll,
    start: f.start, arrive: f.arrive, prog: f.prog, look: f.look };
  var total = _aeFlyLead(f) + f.ms + (f.hold ? AE_FLY_TAIL_MS : 0), dt = total / AE_FLY_PLAN_STEPS, peak = 0;
  var run = function (onFrame) {
    _ae.fly = f; _ae.hand = null; _ae.flightUp = null; _ae.flightOff = 0; f.start = 0;
    for (var i = 0; i <= AE_FLY_PLAN_STEPS; i++) {
      _aeStepFly(Math.min(i * dt, total - 1e-6));
      onFrame(_aePoseOf(_aeViewCam()));
    }
  };
  // The first run finds how far the flight turns up in all (f.rollEnd, _aeFlightUp); the second measures the turn.
  // How close the line of sight comes to the celestial pole over the flight decides how up is kept (f.northUp, _aeFlightUp).
  f.rollEnd = null; f.northUp = false;
  var maxEl = 0;
  run(function (pose) { maxEl = Math.max(maxEl, Math.abs(pose.look[2])); });
  f.rollEnd = _ae.flightOff;
  var measure = function () {
    var prev = null, top = 0;
    run(function (pose) {
      var right = _aeCross(pose.look, pose.up);
      if (prev) {
        // The angle of the turn between two orthonormal frames, from the trace of the matrix taking one to the other.
        var trace = _aeDot(prev.look, pose.look) + _aeDot(prev.up, pose.up) + _aeDot(prev.right, right);
        top = Math.max(top, _aeDeg(Math.acos(_aeClamp((trace - 1) / 2, -1, 1))) * AE_FRAME_MS / dt);
      }
      prev = { look: pose.look, up: pose.up, right: right };
    });
    return top;
  };
  f.poleSin = maxEl;
  f.northUp = maxEl < AE_NORTH_UP_SIN_EL;
  peak = measure();   // (north-up turns the picture faster than carrying does, and the flight is stretched for it)
  _ae.fly = saved.fly; _ae.hand = saved.hand; _ae.dist = saved.dist; _ae.az = saved.az; _ae.el_ = saved.el;
  _ae.flightUp = saved.up; _ae.flightOff = saved.off; _ae.roll = saved.roll;
  f.start = saved.start; f.arrive = saved.arrive; f.prog = saved.prog; f.look = saved.look;
  f.lastNow = null;   // the planning frames' times are not the clock's
  return peak;
}
// Stretch a flight that would turn the picture faster than AE_FLY_MAX_TURN_DEG (the camera swinging half way round a
// body, or its line of sight sweeping past the pole), so the turn is spread over the flight instead of crammed into it.
function _aeEaseTurn(f) {
  for (var pass = 0; pass < 2; pass++) {
    var k = _aeFlightTurnPeak(f) / AE_FLY_MAX_TURN_DEG;
    var most = f.maxStretch || AE_FLY_MAX_STRETCH;
    if (k <= 1.02 || f.stretch >= most) return;
    k = Math.min(k, most / (f.stretch || 1));
    f.stretch = (f.stretch || 1) * k;
    f.ms *= k;
    if (f.hold) { f.lead *= k; _aeFlyTables(f); f.bend = _aeBendAfter(f); }
  }
}
// The over-the-shoulder camera: where it stands (behind the body at `from`, away from `dest`, off to one side) and
// the point it looks at, so the old body fills AE_SHOULDER_FILL of the narrower side of the frame at AE_SHOULDER_OLD_AT
// and the destination stands at AE_SHOULDER_DEST_AT. The side is the one the camera is already on.
// In the plane of the line between the two (u) and the side (s): the camera is `dOld` from the old body along
// -(cos(phi) u + sin(phi) s); phi is found so the two land where they should.
function _aeShoulder(from, rOld, dest, flip) {
  var a = from.pos, ab = _aeSub(dest, a), len = _aeLen(ab), u = _aeScale(ab, 1 / len);
  var up = _aeViewUp(u, from.roll), side = _ae.w > _ae.h ? up : _aeCross(u, up);
  if ((_aeDot(_aeCameraOffset(from.az, from.el, 1), side) < 0) !== !!flip) side = _aeScale(side, -1);
  var tn = _aeNarrowTanHalf(), fill = AE_SHOULDER_FILL * tn;
  var dOld = rOld * Math.hypot(1, 1 / fill);
  var destTilt = Math.atan(AE_SHOULDER_DEST_AT * tn);
  // Where the old body lands on the narrow axis (in tangents), for a given phi.
  function oldAt(phi) {
    var thetaDest = Math.atan2(dOld * Math.sin(phi), dOld * Math.cos(phi) + len);
    return Math.tan(phi - thetaDest + destTilt);
  }
  var lo = 0, hi = Math.PI / 2 - 0.01;
  for (var i = 0; i < 40; i++) {
    var mid = (lo + hi) / 2;
    if (oldAt(mid) < AE_SHOULDER_OLD_AT * tn) lo = mid; else hi = mid;
  }
  var phi = (lo + hi) / 2, c = Math.cos(phi), sn = Math.sin(phi);
  var pos = _aeSub(a, _aeAdd(_aeScale(u, dOld * c), _aeScale(side, dOld * sn)));
  var toDest = _aeSub(dest, pos), gamma = Math.atan2(dOld * sn, dOld * c + len) + (-destTilt);
  var axis = _aeAdd(_aeScale(u, Math.cos(gamma)), _aeScale(side, Math.sin(gamma)));
  // The turn away from the old body the look-at carries, and the one axis it turns about: held through the swing
  // back, so the old body slides from the middle of the frame to its place and never leaves it.
  var dA = _aeNorm(_aeSub(a, pos)), dD = _aeNorm(toDest);
  return { pos: pos, look: _aeAdd(pos, _aeScale(axis, _aeLen(toDest))), far: dOld + len * 1.5,
    turn: _aeAngle(dA, axis), turnAxis: _aeTurnAxis(dA, axis), destTurn: _aeAngle(dD, axis), destTurnAxis: _aeTurnAxis(dD, axis) };
}
// Every body drawn: the Earth at the middle, the Moon, the Sun as shown, each planet and big moon.
function _aeBodySpheres(sc) {
  var list = [{ key: 'earth', pos: [0, 0, 0], r: 1 }, { key: 'moon', pos: sc.moon, r: AE_MOON_RADIUS_RE }, { key: 'sun', pos: _aeSunShown(sc), r: AE_SUN_SHOW_R }];
  var pl = _ae.gl.planets || {};
  for (var k in pl) if (pl[k].pos && pl[k].b) list.push({ key: k, pos: pl[k].pos, r: pl[k].b.r });
  return list;
}
// A flight's shoulder, its paces and its corner, on the side the camera is on (or the other: `flip`).
// A flight whose line of sight sweeps past the celestial pole turns the picture right round (north swings half a turn across
// a degree of the sweep), and carrying up to avoid a snap leaves it rolled off north-up for the rest of the flight. The
// shoulder on the other side often keeps clear of the pole: it is taken when it does, and still clears every body.
function _aeShoulderOffPole(f) {
  _aeFlightTurnPeak(f);
  if (f.poleSin < AE_NORTH_UP_SIN_EL) return;
  var was = f.flipped, sin = f.poleSin;
  _aeSetShoulder(f, !was);
  _aeFlightTurnPeak(f);
  if (f.poleSin >= sin || _aeFlightClearance(f) < AE_FLY_CLEAR) { _aeSetShoulder(f, was); f.poleSin = sin; }
}
function _aeSetShoulder(f, flip) {
  f.flipped = !!flip;
  f.shoulder = _aeShoulder(f.from, AE_TARGETS[f.from.target].surface, _aeTargetPos(), flip);
  _aeFlyTables(f);
  f.bend = _aeBendAfter(f);
}
// How near, in a body's radii, the camera of flight `f` comes to any body, stepped through the flight as it will be
// drawn. The leg out starts at the old body and the flight ends at the new one: each is left out where it is the subject.
function _aeFlightClearance(f) {
  var bodies = _aeBodySpheres(_ae.scene), total = _aeFlyLead(f) + f.ms + AE_FLY_TAIL_MS, near = Infinity;
  for (var i = 0; i <= AE_FLY_CLEAR_STEPS; i++) {
    var t = Math.min(total * i / AE_FLY_CLEAR_STEPS, total - 1e-6), pos = _aeShoulderCam(f, f.start + t).pos;
    for (var b = 0; b < bodies.length; b++) {
      var body = bodies[b];
      if (body.key !== (t < f.lead ? f.from.target : _ae.target)) near = Math.min(near, _aeLen(_aeSub(pos, body.pos)) / body.r);
    }
  }
  return near;
}
// The unit axis that turns direction `a` toward direction `b` (any one across `a` when they coincide or oppose).
function _aeTurnAxis(a, b) {
  var c = _aeCross(a, b);
  return _aeLen(c) > 1e-9 ? _aeNorm(c) : _aeNorm(_aeCross(a, Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
}
// The look-at that is `turn` radians off the direction to `target`, from `pos`, turned about the fixed `axis`: the
// direction to the body sweeps round as the camera moves, and an axis taken across it (not held) would flip where the two
// line up, snapping the picture for a frame.
function _aeLookOff(pos, target, axis, turn) {
  var to = _aeSub(target, pos);
  return _aeAdd(pos, _aeScale(_aeRotateAbout(_aeNorm(to), axis, turn), _aeLen(to)));
}
// A point on the way from offset `p` to offset `q` (both from the same centre) at e in 0..1: the direction turns the
// short way and the distance changes by its ratio, so a camera swinging round a body neither cuts through it nor
// flings out.
function _aeSlerpOffset(p, q, e) {
  var lp = _aeLen(p), lq = _aeLen(q), np = _aeScale(p, 1 / lp), nq = _aeScale(q, 1 / lq);
  var d = _aeClamp(_aeDot(np, nq), -1, 1), ang = Math.acos(d), dir;
  if (ang < 1e-6) dir = np;
  else {
    // Straight back on itself: swing round the vertical (or any axis across it).
    var perp = ang > Math.PI - 1e-6 ? _aeNorm(_aeCross(np, Math.abs(np[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])) : null;
    if (perp) dir = _aeAdd(_aeScale(np, Math.cos(Math.PI * e)), _aeScale(perp, Math.sin(Math.PI * e)));
    else dir = _aeAdd(_aeScale(np, Math.sin((1 - e) * ang) / Math.sin(ang)), _aeScale(nq, Math.sin(e * ang) / Math.sin(ang)));
  }
  return _aeScale(dir, Math.exp(Math.log(lp) + (Math.log(lq) - Math.log(lp)) * e));
}
// The far plane reaches past a shot wider than the scene's usual widest view, and comes back after.
function _aeFarFor(reach) {
  var cam = _ae.gl && _ae.gl.camera, far = Math.max(AE_FAR, reach || 0);
  if (cam && cam.far !== far) { cam.far = far; cam.updateProjectionMatrix(); }
}
// How long a flight takes: the camera's path, end to end, against the
// nearer of the two distances it stands from what it looks at.
function _aeFlyMs(from, toPos, toDist, toAz, toEl) {
  var a = _aeCameraOffset(from.az, from.el, from.dist), b = _aeCameraOffset(toAz, toEl, toDist);
  var pa = [from.pos[0] + a[0], from.pos[1] + a[1], from.pos[2] + a[2]];
  var pb = [toPos[0] + b[0], toPos[1] + b[1], toPos[2] + b[2]];
  var travel = _aeLen(_aeSub(pb, pa)) / _aeClamp(toDist, 1e-6, from.dist);
  return _aeClamp(AE_FLY_MIN_MS + AE_FLY_MS_PER_LOG * Math.log(1 + travel), AE_FLY_MIN_MS, AE_FLY_FAR_MS);
}
// How long the flight is before its arrival begins: the leg to the shoulder, when it has one.
function _aeFlyLead(f) { return f.hold ? f.lead : 0; }
// The pace shape of a leg: `floor` of its cruise while within AE_FLY_CRAWL_MS of the shoulder (d ms away), rising
// smoothly to the cruise.
function _aeCrawlShape(d, floor) {
  return floor + (1 - floor) * _smoothstep(AE_FLY_CRAWL_MS, AE_FLY_CRAWL_MS + AE_FLY_CRAWL_RAMP_MS, d);
}
// The running share (0..1) of a pace over 0..len ms, sampled: lookups interpolate it, so a leg's progress follows its
// pace exactly and arrives at 1.
function _aeRunningShare(rate, len) {
  var n = AE_FLY_TABLE_N, tab = new Array(n + 1), sum = 0, prev = rate(0);
  tab[0] = 0;
  for (var i = 1; i <= n; i++) { var r = rate(len * i / n); sum += (prev + r) / 2; prev = r; tab[i] = sum; }
  for (i = 0; i <= n; i++) tab[i] /= sum;
  tab.total = sum * len / n;
  return tab;
}
function _aeShareAt(tab, t, len) {
  var x = _aeClamp(t / len, 0, 1) * AE_FLY_TABLE_N, i = Math.min(AE_FLY_TABLE_N - 1, Math.floor(x));
  return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
}
// How far along the flight's arrival is, eased (1 when there is none). With the shoulder view the arrival is the leg
// after it: the camera's distance to the destination goes down in log space, which is a steady apparent zoom, driven
// by the crawl-then-rise pace (_aeFlyTables).
function _aeFlyArrival(f, now) {
  if (!f.hold) return _aeSmoother((now - f.start) / f.ms);   // (C2: the cubic ease-in-out this was jumps in acceleration at its middle, a spike in the turn's jerk)
  var q = _aeShareAt(f.inTab, now - f.start - f.lead, f.ms + AE_FLY_TAIL_MS);
  if (!f.logIn) return q;
  // g is the log of (distance from the old body over distance to the destination): it carries both ends' apparent
  // zoom, and one eased run of it is the whole leg in.
  var e = Math.exp(f.g0 + (f.g1 - f.g0) * q), x = (f.r0 * e - f.dOld) / (1 + e);
  return _aeClamp(Math.log(Math.max(1e-12, f.r0 - x) / f.r0) / f.logRatio, 0, 1);
}
// How far along the leg to the shoulder the camera is.
function _aeFlyPull(now, f) { return _aeShareAt(f.outTab, now - f.start, f.lead); }
function _aeFlyEase(now) {
  var f = _ae.fly;
  return f ? _aeFlyArrival(f, now) : 1;
}
// The paces of the two legs, set so the camera's apparent speed is the same either side of the shoulder: the leg to
// the shoulder has the crawl share of its cruise at the end, and the leg in is given whatever share of its own makes the
// apparent speed there equal (the leg in is thousands of times as long to the Sun, so its share is tiny).
function _aeFlyTables(f) {
  var from = f.from, sh = f.shoulder, dest = _aeTargetPos(), e = 0.01, T2 = f.ms + AE_FLY_TAIL_MS;
  var start = _aeCameraOffset(from.az, from.el, from.dist), end = _aeCameraOffset(f.toAz, f.toEl, f.toDist);
  var shOff = _aeSub(sh.pos, from.pos);
  f.dOld = _aeLen(shOff);
  var legA = _aeLen(_aeSub(shOff, _aeSlerpOffset(start, shOff, 1 - e))) / e;
  var easeIn = function (t) { return _smoothstep(0, AE_FLY_EASE_IN_MS, t); };
  var outRate = function (t) { return _aeCrawlShape(f.lead - t, AE_FLY_CRAWL_SHARE) * easeIn(t); };
  f.outTab = _aeRunningShare(outRate, f.lead);
  // Apparent speed at the shoulder: the leg's length per ms over the old body's distance.
  var apparent = legA * AE_FLY_CRAWL_SHARE / f.outTab.total / f.dOld;
  f.r0 = _aeLen(_aeSub(sh.pos, dest));
  var r1 = _aeLen(end);
  f.logIn = r1 < f.r0 * 0.9;
  f.g0 = Math.log(f.dOld / f.r0); f.g1 = Math.log((f.dOld + f.r0 - r1) / r1); f.logRatio = Math.log(r1 / f.r0);
  var G = f.logIn ? f.g1 - f.g0 : 1;
  var share = AE_FLY_CRAWL_SHARE;
  for (var i = 0; i < 12; i++) {
    var inRate = function (t) { return _aeCrawlShape(t, share) * _smoothstep(0, AE_FLY_EASE_OUT_MS, T2 - t); };
    var tab = _aeRunningShare(inRate, T2);
    // Apparent speed of the leg in at its start is G (the log ratio's travel) times its share's rate per ms.
    share = _aeClamp(apparent * tab.total / G, 1e-5, 0.6);
  }
  f.inTab = _aeRunningShare(function (t) { return _aeCrawlShape(t, share) * _smoothstep(0, AE_FLY_EASE_OUT_MS, T2 - t); }, T2);
}
// How long after the shoulder the corner is rounded for: until the leg in has carried the camera about half the old
// body's distance away (the leg in begins very slowly, and across a flight's own scale any longer span would throw the
// camera far from the shoulder before the corner was turned).
function _aeBendAfter(f) {
  var near = _aeLen(_aeSub(f.shoulder.pos, f.from.pos)) * AE_FLY_BEND_REACH, at = f.start + f.lead;
  f.bend = AE_FLY_BEND_MS;
  var lo = 20, hi = AE_FLY_BEND_MS, sh = f.shoulder.pos;
  if (_aeLen(_aeSub(_aeLegPos(f, at + hi), sh)) < near) return hi;
  for (var i = 0; i < 24; i++) {
    var mid = (lo + hi) / 2;
    if (_aeLen(_aeSub(_aeLegPos(f, at + mid), sh)) < near) lo = mid; else hi = mid;
  }
  return lo;
}
// The camera's place and the point it looks at, along a shoulder shot: back and round the old body, through the shoulder view without stopping, then
// in to the destination's own view.
function _aeShoulderCam(f, now) {
  var j = f.lead, t = now - f.start;
  var pos = t <= j - AE_FLY_BEND_MS || t >= j + f.bend ? _aeLegPos(f, now) : _aeBend(f, now);
  // Looking at the old body, turned off it by the share of the leg done, then at the destination, framed, then at its
  // middle: the two looks are the same at the shoulder, and are blended across the bend.
  var dest = _aeTargetPos(), sh = f.shoulder;
  var look1 = _aeLookOff(pos, f.from.pos, sh.turnAxis, sh.turn * _aeClamp(_aeFlyPull(now, f), 0, 1));
  var look2 = _aeLookOff(pos, dest, sh.destTurnAxis, sh.destTurn * (1 - _aeFlyArrival(f, now)));
  var k = _smoothstep(j - AE_FLY_BEND_MS, j + f.bend, t);
  var d1 = _aeNorm(_aeSub(look1, pos)), d2 = _aeNorm(_aeSub(look2, pos)), d = _aeNorm(_aeAdd(_aeScale(d1, 1 - k), _aeScale(d2, k)));
  var r = _aeLen(_aeSub(look1, pos)) * (1 - k) + _aeLen(_aeSub(look2, pos)) * k;
  return { pos: pos, look: _aeAdd(pos, _aeScale(d, r)) };
}
// Where the camera is on the leg to the shoulder (round the old body), then on the leg in (round the destination).
function _aeLegPos(f, now) {
  var from = f.from, sh = f.shoulder, dest = _aeTargetPos();
  if (now - f.start >= f.lead) {
    var end = _aeCameraOffset(f.toAz, f.toEl, f.toDist);
    return _aeAdd(dest, _aeSlerpOffset(_aeSub(sh.pos, dest), end, _aeFlyArrival(f, now)));
  }
  var start = _aeCameraOffset(from.az, from.el, from.dist);
  return _aeAdd(from.pos, _aeSlerpOffset(start, _aeSub(sh.pos, from.pos), _aeFlyPull(now, f)));
}
// The two legs meet at the shoulder going different ways (out from the old body, then in toward the new): across a
// short span the camera follows a cubic Hermite curve between the legs' own places and velocities, so it turns
// round the corner instead of stopping at it.
function _aeBend(f, now) {
  var j = f.start + f.lead, w = AE_FLY_BEND_MS + f.bend, h = 1;
  var t0 = j - AE_FLY_BEND_MS, t1 = j + f.bend;
  var p0 = _aeLegPos(f, t0), p1 = _aeLegPos(f, t1);
  var v0 = _aeScale(_aeSub(_aeLegPos(f, t0 + h), p0), w / h), v1 = _aeScale(_aeSub(p1, _aeLegPos(f, t1 - h)), w / h);
  var u = (now - t0) / w, u2 = u * u, u3 = u2 * u;
  var out = _aeScale(p0, 2 * u3 - 3 * u2 + 1);
  out = _aeAdd(out, _aeScale(v0, u3 - 2 * u2 + u));
  out = _aeAdd(out, _aeScale(p1, -2 * u3 + 3 * u2));
  return _aeAdd(out, _aeScale(v1, u3 - u2));
}
function _aeLerp3(a, b, e) { return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e]; }
// From rest to the end at `slope` times the average speed (Hermite: no speed at the start, `slope` at the end).
function _aeHermiteEnd(t, slope) { return -2 * t * t * t + 3 * t * t + (t * t * t - t * t) * slope; }
// A flight to the station ends in a view fixed in the station's axes: turn its end (az, el) with them, the short way round from where it was.
function _aeHoldIssEnd(f) {
  var B = _ae.issBasis, dir = [0, 1, 2].reduce(function (acc, k) { return _aeAdd(acc, _aeScale(B[k], f.issLoc[k])); }, [0, 0, 0]), azel = _aeAzElOf(dir);
  f.toAz += _angleDelta(f.toAz, azel.az); f.toEl = azel.el;
}
function _aeStepFly(now) {
  var f = _ae.fly;
  if (!f) return false;
  var dt = f.lastNow == null ? 0 : now - f.lastNow;
  f.lastNow = now;
  if (f.waitModel) {
    var wm = f.waitModel, wc = _aeCraft[wm];
    if (_aeCraftData(wm) || (wc && wc.failed)) _aeRefitCraftFlight(f, _ae.target, wm);
    else if (now - f.start >= f.lead - AE_FLY_BEND_MS) {
      // Not here yet at the corner: the clock of the flight stands still, for no longer than AE_CRAFT_WAIT_MS.
      f.start += dt;
      f.held = (f.held || 0) + dt;
      if (f.held > AE_CRAFT_WAIT_MS) f.waitModel = null;
    }
  }
  if (f.issLoc && _ae.issBasis) _aeHoldIssEnd(f);
  f.arrive = _aeFlyArrival(f, now);
  f.prog = _aeClamp((now - f.start) / (_aeFlyLead(f) + f.ms + (f.hold ? AE_FLY_TAIL_MS : 0)), 0, 1);
  if (f.hold) {
    // The orbit model (a point looked at, a direction and a distance) holds any camera and look-at pair.
    var c = _aeShoulderCam(f, now), v = _aeSub(c.pos, c.look), d = _aeLen(v);
    f.look = c.look;
    // How much of the camera's place goes with the destination: none on the leg out, all of it on the leg in once the camera
    // is a small share of the way from the shoulder (its place is the destination's plus an offset that shrinks).
    f.destAt = _aeTargetPos();
    f.carry = _smoothstep(f.lead - AE_FLY_BEND_MS, f.lead + f.bend, now - f.start) * (1 - _aeClamp(_aeLen(_aeSub(c.pos, f.destAt)) / f.r0, 0, 1));
    _ae.dist = d; _ae.az = Math.atan2(v[1], v[0]); _ae.el_ = Math.asin(v[2] / d);
  } else {
    var arrive = _aeFlyArrival(f, now);
    var tt = _aeClamp((now - f.start) / f.ms, 0, 1), arriveD = f.endSlope ? _aeHermiteEnd(tt, f.endSlope) : arrive;   // (a flight that another motion takes up arrives at speed: its distance does)
    _ae.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.toDist) - Math.log(f.from.dist)) * arriveD);
    _ae.az = f.from.az + (f.toAz - f.from.az) * arrive;
    _ae.el_ = f.from.el + (f.toEl - f.from.el) * arrive;
  }
  if (now - f.start >= _aeFlyLead(f) + f.ms + (f.hold ? AE_FLY_TAIL_MS : 0)) { _ae.fly = null; _aeFarFor(0); if (_ae.orbitFly) _ae.orbitFly.endAt = now; }
  return true;
}
// How far the look-at may have gone over to `to` (0..1) with the body the flight left still inside the picture: that body is
// `e` of the way back from the look-at to where it stood, and what shows of it across the view is the part of that offset
// at right angles to the line of sight, which may be at most AE_FLY_KEEP_IN of the narrower half-width at the camera's distance.
// (The schedule alone let the Earth swing off the screen on the way out to the planets, at the pull out's middle.)
var AE_FLY_KEEP_IN = 0.7;
function _aeOverviewKeepIn(f, to) {
  var way = _aeSub(to, f.from.pos), dir = _aeNorm(_aeCameraOffset(_ae.az, _ae.el_, 1));
  var across = _aeSub(way, _aeScale(dir, _aeDot(way, dir)));
  var len = _aeLen(across);
  return len > 1e-9 ? AE_FLY_KEEP_IN * _aeNarrowTanHalf() * _ae.dist / len : 1;
}
function _aeFlyTargetPos() {
  var f = _ae.fly, to = _aeTargetPos();
  if (!f) return to;
  if (f.hold) {
    // The look-at was worked out where the destination stood at the step; it has moved since (Voyager 280 m in a
    // frame, the camera 80 m off it at the end), so the camera is carried along by that (f.carry).
    var look = f.look || f.from.pos;
    return f.destAt ? _aeAdd(look, _aeScale(_aeSub(to, f.destAt), f.carry || 0)) : look;
  }
  var e = _aeFlyEase(performance.now());
  if (f.overview) {
    // Pulling back, the body it left stays in the picture, shrinking: the look-at goes over to the Sun as the distance
    // grows past the gap between them (on a log scale, eased at both ends), all the way by the end.
    var gap = _aeLen(_aeSub(to, f.from.pos)) || 1;
    var lo = Math.log(Math.max(gap * AE_FLY_OVERVIEW_KEEP[0], f.from.dist)), hi = Math.log(Math.min(gap * AE_FLY_OVERVIEW_KEEP[1], f.toDist));
    e = hi > lo ? _aeSmoother(_aeClamp((Math.log(_ae.dist) - lo) / (hi - lo), 0, 1)) : e;
    e = Math.min(e, _aeOverviewKeepIn(f, to));
  } else if (f.straight) {
    // In from the Earth to its station: the look goes over to the station while the camera is still out at the distance the two stand
    // apart, so the station is in the picture all the way in (going over with the zoom, it left the frame half way, hundreds of its
    // own widths off to the side).
    var hi0 = Math.log(Math.min(_aeLen(_aeSub(to, f.from.pos)) * AE_FLY_STRAIGHT_KEEP, f.from.dist * 0.5)), lo0 = Math.log(f.from.dist);
    e = Math.max(_aeSmoother(_aeClamp((lo0 - Math.log(_ae.dist)) / (lo0 - hi0), 0, 1)), _aeStationInFrameE(f.from.pos, to));
  }
  return _aeLerp3(f.from.pos, to, e);
}
// How far the look must already have gone over to the station (0 Earth .. 1 station) for the station to stand inside the picture from
// where the camera is now: the station seen from the Earth's side can sit on the limb, a frame's edge away (or past it, at some
// points of its orbit), and the distance alone does not slide the look over until the camera is well in.
function _aeStationInFrameE(from, to) {
  var c = _aeCameraOffset(_ae.az, _ae.el_, _ae.dist), tan = _aeTanHalf(AE_FOV_DEG) * Math.min(1, _ae.w / (_ae.h || 1)) * AE_FLY_STRAIGHT_FRAME;
  var inFrame = function (e) {
    var at = _aeLerp3(from, to, e), look = _aeNorm(_aeScale(c, -1)), d = _aeSub(to, _aeAdd(at, c)), ahead = _aeDot(d, look);
    return ahead > 0 && _aeLen(_aeSub(d, _aeScale(look, ahead))) / ahead <= tan;
  };
  if (inFrame(0)) return 0;
  var lo = 0, hi = 1;
  for (var i = 0; i < 24; i++) { var mid = (lo + hi) / 2; if (inFrame(mid)) hi = mid; else lo = mid; }
  return hi;
}

// Where the camera stands and how wide it sees, now: the view's own
// (target, turn, distance, a flight between presets), or, while the Moon is
// passing between the hero and the view, a blend of the view's camera and
// the hero's (_aeHandCam).
// Two fingers turning (not a spread or a slide): the picture turns with them about the line of sight, so a body can be put any way up. The first few degrees are the
// fingers' own wobble in a pinch and are not taken; not on a surface (the horizon stays level there).
var AE_TWIST_DEAD_DEG = 4;
function _aeTwist(pinch, ang) {
  if (_ae.stand || _ae.spin || _ae.fly) { pinch.ang = ang; return; }
  var d = _aeDeg(Math.atan2(Math.sin(ang - pinch.ang), Math.cos(ang - pinch.ang)));
  pinch.ang = ang;
  var before = pinch.turned;
  pinch.turned += d;
  var took = (Math.abs(pinch.turned) > AE_TWIST_DEAD_DEG ? pinch.turned - Math.sign(pinch.turned) * AE_TWIST_DEAD_DEG : 0) - (Math.abs(before) > AE_TWIST_DEAD_DEG ? before - Math.sign(before) * AE_TWIST_DEAD_DEG : 0);
  if (took) { _ae.twist = (_ae.twist || 0) + took; _aeRedraw(); }
}
function _aeViewCam() {
  var tp = _aePanned(_aeFlyTargetPos());
  var roll = _ae.scene ? _aeRollDeg(_ae.target, _ae.scene.ms) : 0;
  if (_ae.fly) roll = _ae.fly.from.roll + _angleDelta(_ae.fly.from.roll, roll) * _aeSmoother(_ae.fly.prog || 0);
  else roll += _ae.twist || 0;   // two fingers turned: the picture is turned about the line of sight, any way up (a flight takes it back to the view's own)
  var iss = _ae.target === 'iss' && !_ae.fly ? _aeIssFarCam(tp, _ae.dist, _ae.issPos) : { tp: tp, dist: _ae.dist };
  return { tp: iss.tp, az: _ae.az, el: _ae.el_, dist: iss.dist, tanHalf: _aeTanHalf(AE_FOV_DEG), roll: roll, frame: null };
}
// Where the camera stands and which way is up for a view `c`. Up is the observer's zenith on the Moon, north
// elsewhere; a flight turns from one to the other on the way, carrying up along as it goes (_aeFlightUp).
function _aePoseOf(c) {
  var off = _aeCameraOffset(c.az, c.el, c.dist), pos = [c.tp[0] + off[0], c.tp[1] + off[1], c.tp[2] + off[2]];
  var look = _aeSub(c.tp, pos), up = _aeViewUp(look, c.roll);
  if (_ae.fly && !_ae.hand) up = _aeFlightUp(look, up, _ae.fly);
  else { _ae.flightUp = null; _ae.flightOff = 0; }
  return { pos: pos, up: up, look: _aeNorm(look) };
}
function _aePlaceCamera() {
  var S = _ae.gl, cam = S.camera;
  var c = _aeViewCam();
  if (_ae.hand && _ae.scene) c = _aeHandBlend(_aeHandCam(_ae.scene, _ae.hand), c, _ae.hand.e);
  if (_ae.site && _ae.site.pose) c = _aeSiteCam(c);   // on the ground at a landing site: its own camera
  // The far plane reaches the shoulder only while a flight with one is under way: a drag or a hand-in that ends the
  // flight early must not leave it out at the Sun (it costs every later view its depth precision). From the distance
  // the view stands at, not the one it was asked for (the station's view pulled out to its orbit stands far from it).
  _aeFarFor(Math.max(_ae.fly && _ae.fly.shoulder ? _ae.fly.shoulder.far : 0, Math.max(_ae.dist, c.dist) + AE_FAR + (_ae.hand && _ae.hand.farHint || 0)));   // far out, the far side of the planets too
  if (_ae.ship) c = _aeShipCam(c);   // flying the ship (almanac-fly.js): its view from behind
  else if (_ae.shipExit) c = _afExitCam(c);   // the way out of it: the chase view eased into the orbit view
  if (_ae.mission && _ae.mission.pose) c = _aeMissionCam(c);   // flying a mission (almanac-missions.js): the shot of its phase
  var tp = c.tp, pose = c.pose || _aePoseOf(c), pos = pose.pos, up = pose.up;
  cam.position.set(pos[0], pos[1], pos[2]);
  _ae.roll = c.roll;
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
    // A bottom sheet over the picture: the view's centre moves up by half of it, so the body stands in what is left above.
    var gs = _ae.goS || 1;   // (a full frame smaller than the screen draws the body smaller, about the same centre)
    if ((_ae.infoShift || _ae.goX || gs !== 1) && _ae.w && _ae.h) cam.setViewOffset(_ae.w * gs, _ae.h * gs, (_ae.w * gs - _ae.w) / 2 + (_ae.goX || 0), (_ae.h * gs - _ae.h) / 2 + (_ae.infoShift || 0), _ae.w, _ae.h);
    else if (cam.view) cam.clearViewOffset();
  }
  // Near plane from the nearest surface, so the Earth's limb never clips
  // and depth precision stays where the eye is.
  var toEarth = _aeLen(pos) - 1;
  var toMoon = _ae.scene ? _aeLen(_aeSub(pos, _ae.scene.moon)) - AE_MOON_RADIUS_RE : Infinity;
  var toSun = _ae.scene ? _aeLen(_aeSub(pos, _aeSunShown(_ae.scene))) - AE_SUN_SHOW_R : Infinity;
  // And from every planet and moon, and the probe in view: in a flight the body left behind stands in the foreground,
  // and a near plane set by the Earth or the Sun alone cut it away (its ring went with it).
  var craftSpan = _aeIsCraft(_ae.target) && AE_CRAFT_MODEL[_ae.target] ? _aeCraftSpanRe(AE_CRAFT_MODEL[_ae.target]) : 0;
  var toBody = _aeIsCraft(_ae.target) ? _aeLen(_aeSub(pos, _aeTargetPos())) - (craftSpan ? craftSpan / 2 : AE_PROBE_SURFACE) : Infinity;
  // The station too, drawn or not yet (the first frame close by would put it in front of the near plane).
  if (_ae.issPos) toBody = Math.min(toBody, _aeLen(_aeSub(pos, _ae.issPos)) - AE_ISS_SPAN_RE / 2);
  var pl = _ae.gl.planets;
  for (var pk in pl) {
    if (!pl[pk].pos) continue;
    toBody = Math.min(toBody, _aeLen(_aeSub(pos, pl[pk].pos)) - pl[pk].b.r * (1 + (pl[pk].b.rings ? 1.4 : 0)));
  }
  cam.near = Math.max(craftSpan ? AE_CRAFT_NEAR_MIN : AE_NEAR_MIN, Math.min(toEarth, toMoon, toSun, toBody) * AE_NEAR_FRACTION);
  if (_ae.site) cam.near = _aeSiteNear(cam.near);
  if (_ae.mission) cam.near = _aeMissionNear(cam.near);
  if (_ae.ship) cam.near = _aeShipNear(cam.near);
  else if (_ae.shipExit) cam.near = _afExitNear(cam.near);
  cam.updateProjectionMatrix();
  S.sky.position.copy(cam.position);
  // An orbit much wider than the screen shows only as arcs through it, a web
  // of straight lines, not a ring: the GPS orbits and the Moon's path fade in
  // as the view widens to hold them.
  var halfView = _aeLen(pos) * c.tanHalf * Math.min(1, _ae.w && _ae.h ? _ae.w / _ae.h : cam.aspect);
  var k = _aeTransitK();   // the satellites' web is not shown in transit: a flight between worlds crosses it as a cage (orbits always show)
  _aeFadeLine(S.gpsRings, AE_GPS_RING_ALPHA, halfView / AE_GPS_SHELL_RE, k);
  var moonR = _aeLen(_ae.scene ? _ae.scene.moon : [AE_MOON_MEAN_DIST_KM / AE_EARTH_RADIUS_KM, 0, 0]);
  _aeFadeLine(S.moonPath, AE_MOON_PATH_ALPHA, halfView / moonR, undefined, Math.abs(_aeLen(pos) - moonR) / halfView);   // an orbit: it shows in transit; and wherever the view stands on it (at the Moon)
  if (!S.sats.material.uniforms.fadeOwn) S.sats.material.uniforms.fadeOwn = S.sats.material.uniforms.fade = { value: 1 };
  S.sats.material.uniforms.fade.value = _aeFadeU.value * k;
}
// 1 at rest, 0 while a flight is on, eased both ways over AE_TRANSIT_FADE_S so nothing pops.
var AE_TRANSIT_FADE_S = 0.35;
function _aeTransitK() {
  var now = performance.now(), dt = _ae.transitAt ? Math.min((now - _ae.transitAt) / 1000, 0.1) : 0, want = _ae.fly && !_ae.stand && !_ae.site ? 0 : 1, k = _ae.transitK == null ? 1 : _ae.transitK;
  _ae.transitAt = now;
  k += _aeClamp(want - k, -dt / AE_TRANSIT_FADE_S, dt / AE_TRANSIT_FADE_S);
  _ae.transitK = k;
  if (k !== want) _ae.dirty = true;
  return k;
}
// Opacity from how much of an orbit the view holds (half-view over radius),
// and from how far the view has come in from the hero (_aeFadeU).
// `onIt` (optional): how many half-views the camera stands from the line; a view the line runs through shows it whole, fading out by AE_ORBIT_ON_FAR of them
// (at the Moon the Earth-wide fraction held is tiny, yet its own path passes through the picture).
var AE_ORBIT_ON_NEAR = 1, AE_ORBIT_ON_FAR = 3;
function _aeFadeLine(line, alpha, held, k, onIt) {
  var seen = _aeClamp((held - AE_ORBIT_FADE_FROM) / (AE_ORBIT_FADE_TO - AE_ORBIT_FADE_FROM), 0, 1);
  if (onIt != null) seen = Math.max(seen, _aeClamp((AE_ORBIT_ON_FAR - onIt) / (AE_ORBIT_ON_FAR - AE_ORBIT_ON_NEAR), 0, 1));
  var out = seen * _aeFadeU.value * _aeOrbitShow('moon') * (k == null ? 1 : k);
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
  if (hand.orrery) return _aeOrreryCam(sc, hand);   // the orrery's lift (almanac-orrery3d.js)
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
  if (a.orrery) return _aeOrreryBlend(a, b, e);
  return {
    tp: [_aeLerp(a.tp[0], b.tp[0], e), _aeLerp(a.tp[1], b.tp[1], e), _aeLerp(a.tp[2], b.tp[2], e)],
    az: a.az + _aeAngleDeltaRad(a.az, b.az) * e,
    el: _aeLerp(a.el, b.el, e),
    dist: _aeLogLerp(a.dist, b.dist, e),
    tanHalf: _aeLogLerp(a.tanHalf, b.tanHalf, e),
    roll: a.roll + _angleDelta(a.roll, b.roll) * e,
    frame: e >= 1 ? b.frame : _aeLerpFrame(a.frame, b.frame, e)
  };
}
// The rectangle of the canvas a camera fills, `e` of the way from frame a to frame b (null: the whole view).
function _aeLerpFrame(a, b, e) {
  var full = { x: 0, y: 0, w: _ae.w, h: _ae.h }, fa = a || full, fb = b || full;
  return { x: _aeLerp(fa.x, fb.x, e), y: _aeLerp(fa.y, fb.y, e), w: _aeLerp(fa.w, fb.w, e), h: _aeLerp(fa.h, fb.h, e) };
}
function _aeAngleDeltaRad(a, b) { return ((b - a + 3 * Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }

// A flight to a probe's model: it fills the picture from AE_CRAFT_VIEW_SPANS of its span, lit three-quarter from the
// Sun's side, and a body it is near (Jupiter for Juno) stands behind it.
// How far off a flight to a craft of this span ends (the station too): the whole span inside the narrower side of the screen.
function _aeCraftViewDist(span) { return Math.max(span * AE_CRAFT_VIEW_SPANS, _aeFitDist(span * AE_CRAFT_FIT_R)); }
// `waitModel`: the span is a guess, the model (loading) will correct it (_aeRefitCraftFlight).
// The world axes (toward what it points at, across, and the third) its model axes (aim, across, aim x across) turn onto at pos.
function _aeCraftWorldBasis(model, pos) {
  if (AE_CRAFT_POINTS[model] === 'orbit') { var o = _aeOrbiter[model]; if (o) return o.basis; }   // along the orbit, across it, and the Earth's side
  var goal = AE_CRAFT_POINTS[model] === 'sun' ? _aeSunShown(_ae.scene) : [0, 0, 0];
  var jd = _ae.scene.ms / MS_PER_DAY + JD_UNIX_EPOCH, to = _aeNorm(_aeSub(goal, pos));
  var north = typeof _ephEclJ2000ToEqOfDate === 'function' ? _ephEclJ2000ToEqOfDate([0, 0, 1], jd + _aeDeltaTDays(jd)) : [0, 0, 1];
  var side = _aeCross(to, north);
  if (_aeLen(side) < 1e-6) side = _aeCross(to, [1, 0, 0]);
  side = _aeNorm(side);
  return [to, side, _aeCross(to, side)];
}
// A craft's authored view: the direction to look from, in its own model axes (what the picture is of: Webb's mirror seen
// three-quarter from the cold side, the sunshield edge-on below). Null for a craft without one, or before its model is here.
// Webb's primary mirror: the middle of its 18 hexagonal segments in the model's units (y, z; the mirror faces x) and a
// segment's 1.32 m flat to flat. The shader draws the lattice in the mirror material's object space, the centre one missing.
var AE_CRAFT_MIRROR = { webb: { c: [6.275, 0.0], pitchM: 1.32 } };
function _aeCraftMirrorHex(THREE, d, model) {
  var m = AE_CRAFT_MIRROR[model];
  return m ? new THREE.Vector3(m.c[0] * d.metres, m.c[1] * d.metres, m.pitchM) : new THREE.Vector3(0, 0, 0);
}
var AE_CRAFT_HERO_FRAME = { cassini: [0.35, 0.85, 0.5] };   // the same, in the world axes the craft's pointing sets (to its target, across, third)
var AE_CRAFT_HERO = { webb: [1.0, 0.55, 0.45] };
function _aeCraftHeroDir(name, pp) {
  var model = AE_CRAFT_MODEL[name], hero = AE_CRAFT_HERO[model], frame = AE_CRAFT_HERO_FRAME[model];
  if (frame && _ae.scene && pp) {   // along what it points at, across and the third: its dish is never seen end-on
    var B = _aeCraftWorldBasis(model, pp);
    return _aeNorm(_aeAdd(_aeAdd(_aeScale(B[0], frame[0]), _aeScale(B[1], frame[1])), _aeScale(B[2], frame[2])));
  }
  return hero ? _aeCraftModelToWorld(model, pp, hero) : null;
}
// A direction in a craft's model axes as the world sees it at pp (null before its model is here).
function _aeCraftModelToWorld(model, pp, v) {
  var d = _aeCraftData(model);
  if (!d || !_ae.scene || !pp) return null;
  var B = _aeCraftWorldBasis(model, pp), t = [d.aim[1] * d.across[2] - d.aim[2] * d.across[1], d.aim[2] * d.across[0] - d.aim[0] * d.across[2], d.aim[0] * d.across[1] - d.aim[1] * d.across[0]];
  var c = [_aeDot(v, d.aim), _aeDot(v, d.across), _aeDot(v, t)];
  return _aeNorm(_aeAdd(_aeAdd(_aeScale(B[0], c[0]), _aeScale(B[1], c[1])), _aeScale(B[2], c[2])));
}
function _aeFlyToCraft(name, pp, span, waitModel) {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') return;   // a name from a link is never a way into Object
  var target = Object.prototype.hasOwnProperty.call(AE_TARGETS, name) ? AE_TARGETS[name] : null;
  if (!target) return;
  target.min = span * 0.9;
  target.surface = span / 2;
  var toSun = _ae.scene ? _aeNorm(_aeSub(_aeSunShown(_ae.scene), pp)) : [1, 0, 0];
  var near = null, nearD = Infinity;
  AE_MARKED.forEach(function (m) {
    if (m.body === name || _aeIsProbe(m.body)) return;
    var q = _aeBodyPos(m.body), d = q ? _aeLen(_aeSub(q, pp)) : Infinity;
    if (d < nearD) { nearD = d; near = q; }
  });
  var side = _aeNorm(_aeCross(toSun, [0, 0, 1])), dir;
  if (AE_CRAFT_POINTS[AE_CRAFT_MODEL[name]] === 'sun') dir = _aeAdd(_aeAdd(_aeScale(side, 0.85), _aeScale(toSun, AE_CRAFT_SHIELD_VIEW_SUN)), [0, 0, 0.3]);   // a shield in profile
  else if (near && nearD < AE_PROBE_FRAME_MAX) dir = _aeAdd(_aeScale(_aeNorm(_aeSub(pp, near)), 0.8), _aeScale(toSun, 0.5));
  else dir = _aeAdd(_aeScale(toSun, 0.6), _aeScale(side, 0.8));
  // Its whole span inside the narrower side of the screen (a phone held upright is narrow across: three spans along
  // the view left Voyager's booms off both edges).
  _aeFlyTo(name, _aeCraftViewDist(span), _aeAzElOf(_aeCraftHeroDir(name, pp) || _aeNorm(dir)));
  if (waitModel) _aeWaitForModel(waitModel);
  _aeArrive(name);
}
// A flight that ends on a model it has not got yet: it holds before its last leg until the model is here.
function _aeWaitForModel(model) {
  var c = _aeCraft[model];
  if (_ae.fly && _ae.fly.hold && !_aeCraftData(model) && !(c && c.failed)) _ae.fly.waitModel = model;
}
// The model is here: the flight's last leg is fitted to its real span, before the leg begins (the paces and the
// corner are made again; the leg out does not depend on where it ends). A model that never came ends as planned.
function _aeRefitCraftFlight(f, name, model) {
  f.waitModel = null;
  var span = _aeCraftSpanRe(model);
  if (!span) return;
  if (AE_CRAFT_MODEL[name]) { AE_TARGETS[name].min = span * 0.9; AE_TARGETS[name].surface = span / 2; }
  f.toDist = _aeClampDist(_aeCraftViewDist(span));
  var hero = _aeCraftHeroDir(name, _aeBodyPos(name));
  if (hero) { var ae = _aeAzElOf(hero); f.toAz = ae.az; f.toEl = ae.el; }
  f.ms = _aeFlyMs(f.from, _aeTargetPos(), f.toDist, f.toAz, f.toEl);
  _aeFlyTables(f);
  f.bend = _aeBendAfter(f);
}
// A flight to one place: its card comes with it, and any other card goes.
// The gas giants have no ground to stand on or drive: the surface button takes the UFO down to their cloud tops (turning it on if need be).
var AE_NO_GROUND_BODIES = ['jupiter', 'saturn', 'uranus', 'neptune'];
function _aeArrive(name) {
  _ae.arrived = name; _ae.lm = null; _ae.selected = null; _aeRenderCard();
}
function _aePreset(name) {
  if (!_ae.gl) return;
  if (_ae.ship && _afPreset(name)) return;   // flying: a body chosen is where the ship goes
  if (_ae.spin && name !== AE_SPIN_KEY) { _aeLeaveSpin(); _aeFullStepOut(); }   // its full-screen step too, if it made one
  if (_ae.arrived && name !== _ae.arrived) { _ae.arrived = null; _aeRenderCard(); }
  if (_ae.sent) { _ae.sent = null; _aeRenderCard(); }   // a card of something sent gives way to any other place
  if (_ae.lm && name !== _ae.lm.body) { _ae.lm = null; _aeRenderCard(); }   // a site's card stays at its body
  if (_ae.place) { _ae.place = null; _aeRenderCard(); }   // a place picked in Go to is left behind by any other place
  if (_ae.pick && name !== _ae.pick.body) { _ae.pick = null; _aeRenderCard(); }
  if (name !== 'earth' && name !== 'iss' && (_ae.selected || (typeof _asHasSel === 'function' && _asHasSel()))) _aeCardClear();   // a satellite is chosen at the Earth: leaving it leaves the choice
  _ae.standPending = null;
  // The row says where the view is going at once, also for a destination that flies from a callback (a probe's model
  // loading first): the last chip pressed no longer stays lit over Voyager.
  var was = _ae.preset;
  _ae.preset = name;
  _ae.linkHeld = null;   // somewhere chosen before a link's place had come: the link gives way
  _aeLinkModePending = null;
  _aeMarkViews();
  if (name === AE_SPIN_KEY) {
    _aeEnterSpin(was !== AE_SPIN_KEY && was);
  } else if (name === 'moon') {
    // From the Earth's side: the phase (and any eclipse) as seen from home.
    var azel = _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.moon, -1)) : null;
    _aeFlyTo('moon', _aeBodyFitDist('moon'), azel);
    _aeArrive('moon');
  } else if (name === 'planets') {
    // The whole system from above the ecliptic's north: every orbit round, the belt a ring, each planet a name to tap.
    // Pulling out of it settles onto the orrery (almanac-orrery3d.js), which the globe's cold open no longer fetches: asked for here, where it can be wanted.
    _aeOrreryLoad();
    var jd = (_ae.scene ? _ae.scene.ms : Date.now()) / MS_PER_DAY + JD_UNIX_EPOCH;
    var up = typeof _ephEclJ2000ToEqOfDate === 'function' ? _ephEclJ2000ToEqOfDate([0, 0, 1], jd + _aeDeltaTDays(jd)) : [0, 0, 1];
    _aeFlyTo('sun', _aeFitDist(_aeShownDist(AE_PLANETS_OUTER_AU)), _aeAzElOf(up), true);
  } else if (_aeIsCraft(name)) {
    var pp = _aeBodyPos(name), craft = AE_CRAFT_MODEL[name];
    if (!pp) return;
    if (craft && !_aeCraftData(craft) && !(_aeCraft[craft] && _aeCraft[craft].failed)) {
      // Flown while it loads when the flight has an old place to leave and may move (the view comes to the model as it
      // arrives); with reduced motion, or already there, it waits for the model and then goes.
      if (_ae.scene && _ae.target !== name && !_aeReduceMotion()) { _aeCraftLoad(craft); _aeFlyToCraft(name, pp, AE_CRAFT_PROVISIONAL_SPAN_RE, craft); }
      else _aeCraftLoad(craft, function () { _aePreset(name); });
      return;
    }
    if (craft && _aeCraftData(craft)) { _aeFlyToCraft(name, pp, _aeCraftSpanRe(craft)); return; }
    // From the side of its path round the Sun, a little above: the probe against the dark, the Sun off to one side.
    var fromSun = _ae.scene ? _aeNorm(_aeSub(pp, _aeSunShown(_ae.scene))) : [1, 0, 0];
    var side = _aeNorm(_aeAdd(_aeNorm(_aeCross(fromSun, [0, 0, 1])), _aeScale([0, 0, 1], AE_PROBE_VIEW_LIFT)));
    // Near a planet (Juno, Webb), far enough out to have the planet in the picture too.
    var near = AE_MARKED.reduce(function (best, m) {
      var q = m.body === name || m.flightOnly || _aeIsProbe(m.body) ? null : _aeBodyPos(m.body);
      var d = q ? _aeLen(_aeSub(q, pp)) : Infinity;
      return d < best ? d : best;
    }, Infinity);
    _aeFlyTo(name, _aeClamp(_aeFitDist(near * AE_PROBE_FRAME_NEAR), AE_PROBE_VIEW_DIST, AE_PROBE_FRAME_MAX), _aeAzElOf(side));
    _aeArrive(name);
  } else if (_aeIsPlanet(name)) {
    if (_ae.scene) _aeUpdatePlanets(_ae.scene);   // opened straight onto it (the orrery): placed before the flight
    // From the Earth's side too, a little off it so the phase shows its edge: as a telescope sees it, nearer.
    var at = _aeBodyPos(name);
    // Pluto and Ceres come with the probes' table: not here yet, the tap waits for it and then flies.
    if (!at) { _ae.pendingPreset = name; _aeTracksLoad(); return; }
    _aeFlyTo(name, _aeBodyFitDist(name), _ae.scene ? _aeAzElOf(_aeScale(at, -1)) : null);
    _aeArrive(name);
  } else if (name === 'iss') {
    if (!_ae.issPos || !_ae.issBasis) return;
    // From above, behind and to starboard: the truss across the picture, the Earth below it to the horizon.
    var B = _ae.issBasis, dir = [0, 1, 2].reduce(function (acc, k) { return _aeAdd(acc, _aeScale(B[k], AE_ISS_VIEW_DIR[k])); }, [0, 0, 0]);
    // On the Sun's side of the arrays (they face it), so their faces are lit and can glint: the other way round
    // horizontally if the Sun is behind.
    if (_ae.scene && _aeDot(dir, _ae.scene.sun) < 0) dir = _aeAdd(_aeScale(B[0], AE_ISS_VIEW_DIR[0]), _aeAdd(_aeScale(B[1], -AE_ISS_VIEW_DIR[1]), _aeScale(B[2], -AE_ISS_VIEW_DIR[2])));
    _aeCraftLoad('iss');
    // A clock too fast to follow the station's close ride (time travel) ends at the whole orbit, where the view pulls out to anyway:
    // flown straight there, not in to the station and back out as the clock catches up (the flight takes seconds, the station goes round it many times).
    var closeDist = _aeCraftViewDist(_aeCraftSpanRe('iss') || AE_ISS_SPAN_RE), tooFast = _aeIssTooFast(_ae.issPos, false);
    _ae.issWide = tooFast ? _aeFitDist(_aeLen(_ae.issPos) * AE_ISS_FAR_FIT) : 0;
    _aeFlyTo('iss', tooFast ? _ae.issWide : closeDist, _aeAzElOf(dir));
    // The way in is the station's own: where the camera ends is fixed in the station's axes, so on a fast clock the camera goes round with the station (the model still in the frame, the Earth turning under it) and lands in the view it flew toward.
    if (!tooFast && _ae.fly) _ae.fly.issLoc = [0, 1, 2].map(function (k) { return _aeDot(dir, B[k]); });
    if (!tooFast) _aeWaitForModel('iss');
    _aeArrive('iss');
  } else if (name === 'sun') {
    // From the Earth's side too: the Sun as it stands in our sky, ahead.
    _aeFlyTo('sun', _aeFitDist(AE_FIT_SUN), _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.sun, -1)) : null);
    _aeArrive('sun');
  } else {
    // Back from the Sun, arrive over the day side, the Sun behind the camera.
    var fromSun = _ae.target === 'sun' && _ae.scene ? _aeAzElOf(_ae.scene.sun) : null;
    _aeFlyTo('earth', _aeFitDist(name === 'sats' ? AE_FIT_SATS : AE_FIT_EARTH), fromSun);
    // The chip is named for what it shows: choosing it brings the layer up too (the camera alone showed an empty shell).
    if (name === 'sats' && !_aeSatsAllOn()) _aeSatsAllSet(true);
  }
  _ae.preset = name;
  _aeMarkViews();
}
function _aeMarkViews() {
  _aeRenderRow();
  _aeMarkFly();
  var btns = document.querySelectorAll('#ae-views [data-ae-view]');
  for (var i = 0; i < btns.length; i++) {
    // The chip pressed, or else the body the view is at: whatever the way there (a zoom, a site, a tap on the body), one is lit.
    var k = btns[i].getAttribute('data-ae-view'), on = k === (_ae.preset || _aeRowBody());
    btns[i].setAttribute('aria-pressed', String(on));
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
    _aeRedraw();
    _aeSatsAllBoot();
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
  // Almanac HD's offer rides on the same answer (http.py): no request of its own on the way in.
  if (data.hd) _aeHdShow(Object.assign({ can_change: !!data.can_change }, data.hd));
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
    _aeRedraw();
  });
}

// ── Every active satellite ──
// A layer of its own (almanac-sats.js), fetched and started on the button's first press, or at the view's open when it was
// left on; the choice is kept (SK.ALM_SATS_ALL). Nothing of it is on the page's first load, nor in the view's first frame.
function _aeSatsAllOn() { return typeof _asSet === 'function' ? _as.on : _aeSatsAllKept(); }
function _aeSatsAllKept() { return _rawGet(SK.ALM_SATS_ALL) === '1'; }
function _aeSatsAllLoad() {
  if (typeof _asSet === 'function') return Promise.resolve();
  return _aeLoadJs(AE_SATS_JS).then(function (ok) { if (!ok) throw new Error('sats'); });
}
function _aeSatsAllSet(on) {
  _aeSatsAllLoad().then(function () { _asSet(on); _ae.ringsAt = null; _aeMarkToggles(); _aeRedraw(); }).catch(function () {});   // (the constellation's dots and rings are this layer's: drawn afresh)
}
// At the view's open, once its satellites are in: the layer comes back if it was left on.
function _aeSatsAllBoot() {
  if (_aeSatsAllKept()) {
    _aeSatsAllLoad().then(function () { _asSet(true); _ae.ringsAt = null; _aeMarkToggles(); }).catch(function () {});
  }
}
// The live sky (almanac-sky.js _skyPaintActors): the passes over the place, once the layer is on; it is brought up from
// here when the sky is shown and the choice was kept.
function _aeSatsAllSky(ctx, s) {
  if (typeof _asSkyPrime === 'function') { _asSkyPrime(s); return; }
  if (!_aeSatsAllKept() || _aeScripts[AE_SATS_JS]) return;
  _aeSatsAllLoad().then(function () { _asSet(true); _skyKickNow(); }).catch(function () {});
}

// Run from the ZIM file (zimi/builtin/almanac), not from Zimi's server: the page's data answers come from files inside it
// (local.js), so everything the gear holds (Zimi's satellite-data setting, the HD download, who may change them) has nothing
// to act on there, and the gear is not drawn.
function _aeFromZim() { return typeof ZimiAlmanacLocal !== 'undefined'; }
// ── The gear: "Satellite data from the internet" ──
// Everyone sees the choice in force; an admin may change it, unless the
// environment has (ZIMI_SATELLITE_UPDATES, or ZIMI_OFFLINE forcing Never),
// and then the panel says which.
function _aeShowSettings(on) {
  if (on && !_aeGoUp()) _aeShowGo(true);   // the drawer hangs under the band, which is the search sheet's
  if (on) { _aeDrawerClaim('set'); _asBarShut(); }
  _ae.setOpen = !!on;
  if (on) _aeBare(false); else _ae.sheetShutAt = performance.now();
  _ae.setError = '';
  var panel = _aeById('ae-set'), gear = _aeById('ae-gear');
  if (panel) panel.hidden = !on;
  if (gear) gear.setAttribute('aria-expanded', String(!!on));
  _aeRenderSettings();
  _aeDrawerSync();
}
// ── The one drawer ──
// Under the band, a single slot for what the band's chevron and gear open: the satellites' filters and passes (almanac-sats.js hosts them
// here), or the settings. One at a time; while it is up the search sheet drops to its search row. The sheet stays: a drawer claims as 'go'.
function _aeDrawerClaim(kind) { _aeSheetClaim(_aeGoUp() ? 'go' : kind); }
function _aeDrawerHost() { return _aeById('ae-drawer'); }
function _aeDrawerKind() {
  if (_ae.setOpen) return 'set';
  return typeof _asBarUp === 'function' && _asBarUp() ? 'sats' : '';
}
function _asBarShut() { if (typeof _asShutBar === 'function') _asShutBar(); }
function _aeDrawerShut() {
  if (_ae.setOpen) _aeShowSettings(false);
  _asBarShut();
}
// The band's two openers: the same control shuts what it opened.
function _aeDrawerToggle(kind) {
  if (_aeDrawerKind() === kind) { _aeDrawerShut(); return; }
  if (kind === 'set') _aeShowSettings(true); else _asSet(true, true);
}
// The drawer shows while a child does; the view and the band follow (the picture re-fits to the room the drawer leaves).
function _aeDrawerSync() {
  var d = _aeDrawerHost();
  if (!d) return;
  var up = Array.prototype.some.call(d.children, function (c) { return !c.hidden; });
  if (d.hidden === up) d.hidden = !up;
  if (_ae.el) _ae.el.classList.toggle('ae-drawer-up', up);
  _aeBandPaint();
  _aeMeasureFoot();
  _ae.dirty = true; _aeKick();
}
function _aeSettingsWhy(m) {
  if (m.locked === 'offline') return _aeT('alm_earth_sat_offline');
  if (m.locked === 'env') return _aeT('env_controlled', { v: AE_SAT_ENV });
  if (!m.canChange) return _aeT('alm_earth_sat_admin_only');
  return _ae.setError;
}
// A choice's hint is its tooltip, in words with the source's name; the source is credited once, as a link, under the choices.
var AE_SAT_SOURCE_URL = 'https://celestrak.org/', AE_SAT_SOURCE_NAME = 'CelesTrak';
function _aeSetHint(key) { return _aeT(key, { src: AE_SAT_SOURCE_NAME }); }
// One small picture for each way (the label beside it says it): ask is a question, automatic is the two arrows, offline is the disc with a bar through it.
var AE_SAT_MODE_ICONS = {
  ask: '<circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.7"/><path d="M12 17v.1"/>',
  auto: '<path d="M20 11a8 8 0 0 0-14-4.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4.5l2-2.5"/><path d="M20 20v-5h-5"/>',
  never: '<circle cx="12" cy="12" r="9.5"/><path d="M5.3 18.7l13.4-13.4"/>',
};
function _aeSatIcon(mode) {
  return '<svg class="ae-set-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + AE_SAT_MODE_ICONS[mode] + '</svg>';
}
// The two round switches: pressed shows the layer. Neither does anything in the Planets view or Side by side (their
// orbits always show, and no body is near enough to name its places), so there they stand aside.
// `edge`: stands as a round button on the right edge over the locate button (the HUD's), not in the search sheet's band.
// The layers the view can show, the one list: the corner's round buttons, the world sheet's rows and the state of both read it (and
// write through it), so a layer is added here and nowhere else. `can(target)` is whether the layer means anything at that body.
var AE_LAYERS = [
  { id: 'lm', edge: true, btn: 'ae-lm-btn', hud: 'lm', key: 'alm_lm_layer', glyph: AE_PIN_SVG, on: function () { return _aeLmLayerOn(); }, set: function (on) { _aeLmSetLayer(on); },
    can: function (t) { return !!AE_LM_HAS[t]; } },
  { id: 'orbits', edge: true, btn: 'ae-orbits-btn', hud: 'orbits', key: 'alm_orbits', glyph: AE_ORBIT_SVG, on: function () { return _aeOrbitsOn(); }, set: function (on) { _aeSetOrbits(on); },
    can: function () { return true; } },
  // Its filters and passes are the band's chevron, in the one drawer.
  { id: 'sats', drawer: 'sats', btn: 'ae-sats-btn', hud: 'sats', key: 'alm_sats_all', glyph: AE_SATS_SVG, on: function () { return _aeSatsAllOn(); }, set: function (on) { _aeSatsAllSet(on); },
    // 'loading' while its catalogue comes in, 'failed' when it did not (a tap tries again).
    state: function () { return typeof _as === 'undefined' || !_as.on ? '' : _as.state === 'loading' ? 'loading' : _as.state === 'failed' ? 'failed' : ''; },
    retry: function () { _aeSatsAllLoad().then(function () { _asSatLoad(); }).catch(function () {}); },
    can: function (t) { return t === 'earth'; } }
];
function _aeLayerById(btnId) { for (var i = 0; i < AE_LAYERS.length; i++) if (AE_LAYERS[i].btn === btnId) return AE_LAYERS[i]; return null; }
function _aeToggleHtml(L) {
  var label = _almEsc(_aeT(L.key));
  return '<button type="button" class="ae-btn ae-round" id="' + L.btn + '" aria-pressed="false" aria-label="' + label + '" title="' + label + '">' + L.glyph + '</button>';
}
// The bodies landmarks-v1.json names places on (tests/test_almanac_lm_bodies.py holds the two to the same list): the
// pin shows only where it would name something.
var AE_LM_HAS = { moon: 1, mars: 1, venus: 1, titan: 1, mercury: 1, earth: 1, io: 1, europa: 1, ganymede: 1, callisto: 1, pluto: 1, ceres: 1 };
function _aeOnSurface() { return !!(_ae.stand || _ae.standPending || _ae.site); }
// Whether a layer means anything in the view now: none does in the Planets view, Side by side, or on a surface.
function _aeLayerCan(L) { return !(_aeWideView() || !!_ae.spin || _aeOnSurface()) && !!L.can(_ae.target); }
function _aeMarkToggles() {
  AE_LAYERS.forEach(function (L) {
    var b = _aeById(L.btn), hide = !_aeLayerCan(L);
    if (!b) return;
    if (b.hidden !== hide) b.hidden = hide;
    b._can = !hide;   // (whether it means anything here: the corner may still keep it out of its row)
    if (_ae.hudCan) _ae.hudCan[L.hud] = !hide;   // (the corner's render below shows it where it has a place)
    var on = String(!!L.on());
    if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
  });
  _aeBandPaint();
  _aeMarkFly();  _aeHudRender();   // a change of view is a change of mode: the corner follows at once, not at the next frame
}
// The Fly button in the column: the way in from a view centred on a body, where the rim button offers Stand here (the rim offers Fly over empty space).
function _aeMarkFly() {   // the UFO button stays while the ship flies: lit (pressed), and the way out
  if (_aeDbgOn) _aeDbgState('markFly');
  var b = _aeById('ae-fly-btn'), landed = !!(_ae.shipLanded && _ae.stand), on = !!_ae.ship || landed, show = on || _aeFlyOffer();
  if (!b) return;
  if (_ae.el) _ae.el.classList.toggle('ae-landed', landed);   // (on the ground it came down to, the lit UFO button stays: it lifts off)
  _aeHudCan(AH_UFO_BTN, show);
  if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
  var label = _aeT(landed ? 'alm_fly_liftoff' : on ? 'alm_fly_leave' : 'alm_fly');   // landed, the lit button lifts off (it does not leave the UFO)
  if (b.getAttribute('aria-label') !== label) { b.setAttribute('aria-label', label); b.title = label; }
}
// Fly is offered where the view is the plain one and WebGL2 is here (the rim button's way in, empty space at the centre).
function _aeFlyAble() {
  return !!(_ae.gl && _ae.gl.renderer && _ae.gl.renderer.capabilities.isWebGL2) && !(_ae.ship || _ae.spin || _ae.stand || _ae.standPending || _ae.site || _ae.mission || _ae.hand);
}
// The UFO button is offered in every view that has the corner ("I want the UFO button always"): over a ground, a visit, a mission or the
// side-by-side view it takes the craft up from there (_aeFlyToggle), so only WebGL2 and a view not changing hands decide.
function _aeFlyOffer() {
  return !!(_ae.gl && _ae.gl.renderer && _ae.gl.renderer.capabilities.isWebGL2) && !_ae.hand;
}
function _aeFlyToggle() {
  _aeDbg('ufo', 'button tapped, mode ' + _aeMode() + (_ae.ship ? ', flying' : _ae.shipParked ? ', parked' : ''));
  if (_ae.ship) { _afStop(); return; }
  if (_ae.shipLanded && _ae.stand) { _afTakeOff(); return; }   // landed from the UFO: the lit button lifts off
  _aeSheetClaim('fly');   // the one sheet: flight closes any that is open and opens none
  if (!_aeFlyAble()) { _aeFlyFromAway(); return; }
  if (typeof _afStart === 'function') { _afStart(); return; }
  _aeLoadJsOnce(AE_FLY_JS, function () { _afStart(); });
}
// The UFO asked for from a view that is not the plain one: that view lets go (the ground, the visit or mission, the side-by-side), and the craft is parked
// for the plain view to wake once it has settled (_aeShipWake asks every frame: no mode has to remember to bring it back).
function _aeFlyFromAway() {
  if (typeof _afStart !== 'function') { _aeLoadJsOnce(AE_FLY_JS, _aeFlyFromAway); return; }   // (the craft's file first: the wake below starts it)
  _aeHudLeaveGround();
  _aeLeaveSpin();
  _ae.shipParked = _ae.shipParked || { landing: false, clear: false };
  _ae.dirty = true; _aeKick();
  _aeMarkFly();
}
// The rim's way down from the orbit view: the craft's file, the flight, then the dive.
function _aeUfoDown(key) {
  var go = function () { if (!_ae.ship) _afStart(); if (_ae.ship) _afDive(key); };
  if (typeof _afStart === 'function') go(); else _aeLoadJsOnce(AE_FLY_JS, go);
}
// The names the rim button uses.
function enterFly() { if (!_ae.ship) _aeFlyToggle(); }
function leaveFly() { if (_ae.ship) _afStop(); }
function _aeSetOrbits(on) {
  _prefWrite(AE_ORBITS_KEY, on ? AE_ORBITS_ON : null);
  _aeOrbitsKept = null;
  // Turned off standing still, the lines go at once: no flight is on, so none of them belongs.
  if (_ae && !on && !_ae.fly) _ae.orbitFly = null;
  if (_ae) { _aeRedraw(); _aeMarkToggles(); }
}
function _aeRenderSettings() {
  var panel = _aeById('ae-set-body');
  if (!panel || !_ae.setOpen) return;
  var m = _ae.satMeta || {};
  var editable = !!m.canChange && !m.locked && !_ae.setBusy, admin = !!m.canChange, hd = _ae.hdSt && _ae.hdSt.can_change ? _aeHdRowHtml() : '';   // data and downloads are the owner's (Manage); anyone else sees the display rows only
  var html = (typeof _almDismissX === 'function' ? _almDismissX() : '') +
    (hd ? hd + '<div class="ae-set-sep" aria-hidden="true"></div>' : '') +
    (admin ? '<h3 id="ae-set-title">' + _almEsc(_aeT('alm_earth_sat_setting')) + '</h3>' +
    '<div role="radiogroup" aria-labelledby="ae-set-title">' : '<div hidden>');
  (admin ? AE_SAT_MODES : []).forEach(function (mode) {
    var key = AE_SAT_MODE_KEY + mode;
    html += '<label class="ae-set-choice' + (editable ? '' : ' ae-off') + '" title="' + _almEsc(_aeSetHint(key + '_hint')) + '">' +
      '<input type="radio" name="ae-sat-mode" value="' + mode + '"' +
        (m.mode === mode ? ' checked' : '') + (editable ? '' : ' disabled') + '>' +
      _aeSatIcon(mode) + '<b>' + _almEsc(_aeT(key)) + '</b></label>';
  });
  html += '</div>' + (admin ? '<p class="ae-set-why"><a href="' + AE_SAT_SOURCE_URL + '" target="_blank" rel="noopener">' + AE_SAT_SOURCE_NAME + '</a></p>' : '');
  var why = admin ? _aeSettingsWhy(m) : '';
  if (why) html += '<p class="ae-set-why">' + _almEsc(why) + '</p>';
  if (typeof ZimiCap !== 'undefined') html += ZimiCap.gearHtml();   // Auto / Light / Full, and what the network adds (capability.js)
  panel.innerHTML = html;
  if (typeof ZimiCap !== 'undefined') ZimiCap.gearBind(panel);
  var get = _aeById('ae-set-hd-get');
  if (get) get.onclick = _aeHdGet;
  var stop = _aeById('ae-set-hd-cancel');
  if (stop) stop.onclick = _aeHdCancel;
  if (panel.querySelectorAll) {
    Array.prototype.forEach.call(panel.querySelectorAll('.ae-hd-rm'), function (b) { b.onclick = function () { _aeHdRemoveAsk(b.getAttribute('data-kind')); }; });
    Array.prototype.forEach.call(panel.querySelectorAll('.ae-hd-rm-yes'), function (b) { b.onclick = function () { _aeHdRemoveDo(b.getAttribute('data-kind')); }; });
    Array.prototype.forEach.call(panel.querySelectorAll('.ae-hd-rm-no'), function (b) { b.onclick = _aeHdRemoveNo; });
  }
  if (panel.querySelectorAll) Array.prototype.forEach.call(panel.querySelectorAll('.ae-hd-kind'), function (r) { r.onchange = function () { _aeHdKind(r); }; });
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
    var checked = _aeById('ae-set-body');
    checked = checked && checked.querySelector && checked.querySelector('input[name="ae-sat-mode"]:checked');
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
  (data.craft || []).forEach(function (omm) {   // Hubble, Chandra: kept by their key whatever the elements' order
    var key = Object.keys(AE_ORBITERS).filter(function (k) { return AE_ORBITERS[k].norad === omm.NORAD_CAT_ID; })[0];
    try { var r3 = key && lib.json2satrec(omm); if (r3 && !r3.error) list.push({ omm: omm, rec: r3, iss: false, craft: key }); } catch (e) {}
  });
  list = list.slice(0, AE_SAT_CAPACITY);
  list.forEach(function (s) { s.epochMs = _aeSatEpochMs(s.rec); });
  _ae.sats = { lib: lib, list: list, source: data.source || '', fetched: data.fetched };
  _ae.ringsAt = null;
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

// The orbit a satellite is on at this instant as an ellipse (the conic of its position and velocity), written into `out` as
// n scene points (Earth radii) round from the satellite itself. False when it is not a closed orbit.
// The ring's vertices are kept relative to the station (the line itself stands at it, in doubles): the GPU holds them as 32-bit numbers, and at the
// Earth's radius one of those steps is most of a metre, so beside the station the ring jittered. Their spacing is finest at the station and grows with the
// square of the distance round the orbit (a sharp bend at the station was two long chords meeting there), the station the middle vertex of the loop.
// Returns the station's place (in Earth radii), or null.
function _aeOrbitRing(st, eqeq, out, n) {
  var r = _aeXyz(st.posKm), v = _aeRotZ(_aeXyz(st.velKmS), eqeq);
  r = _aeRotZ(r, eqeq);
  var rl = _aeLen(r), h = _aeCross(r, v), hl = _aeLen(h);
  if (!(rl > 0) || !(hl > 0)) return false;
  var ev = _aeSub(_aeScale(_aeCross(v, h), 1 / AE_GM_EARTH_KM3_S2), _aeScale(r, 1 / rl)), e = _aeLen(ev);
  if (!(e < 1)) return false;
  var p = hl * hl / AE_GM_EARTH_KM3_S2, hu = _aeScale(h, 1 / hl);
  var px = e > AE_ORBIT_E_MIN ? _aeScale(ev, 1 / e) : _aeScale(r, 1 / rl), py = _aeCross(hu, px);
  var nu0 = Math.atan2(_aeDot(r, py), _aeDot(r, px));
  var at = _aeScale(r, 1 / AE_EARTH_RADIUS_KM), half = n / 2;
  for (var i = 0; i < n; i++) {
    var u = (i - half) / half, nu = nu0 + Math.PI * u * Math.abs(u), rad = p / (1 + e * Math.cos(nu)) / AE_EARTH_RADIUS_KM, c = Math.cos(nu), sn = Math.sin(nu);
    out[i * 3] = rad * (c * px[0] + sn * py[0]) - at[0];
    out[i * 3 + 1] = rad * (c * px[1] + sn * py[1]) - at[1];
    out[i * 3 + 2] = rad * (c * px[2] + sn * py[2]) - at[2];
  }
  return at;
}

// A satellite's orbit as it is now, drawn on `ring` (AE_ISS_RING_POINTS round, the satellite its first vertex); nothing when it is not a closed one.
function _aeRingPlace(ring, st, eqeq) {
  var at = st && _aeOrbitRing(st, eqeq, ring.geometry.attributes.position.array, AE_ISS_RING_POINTS);
  if (at) {
    ring.position.set(at[0], at[1], at[2]);
    ring.geometry.attributes.position.needsUpdate = true;
    ring.geometry.setDrawRange(0, AE_ISS_RING_POINTS);
  } else ring.geometry.setDrawRange(0, 0);
}
// How a satellite flies, in its own axes: toward the Earth (nadir), along its path (forward, level), and across it (starboard), from its place and velocity.
function _aeLvlh(pos, vel) {
  var nadir = _aeNorm(_aeScale(pos, -1)), fwd = _aeNorm(_aeSub(vel, _aeScale(nadir, _aeDot(vel, nadir))));
  return [nadir, fwd, _aeCross(nadir, fwd)];
}
function _aeRingsOff(rings) { for (var k in rings || {}) rings[k].visible = false; }
// A telescope's place and bearing now from its SGP4 state: its model is a probe's (AE_CRAFT_MODEL, drawn by _aePlaceCrafts after the camera), held with
// its long axis along its orbit and its third axis to the Earth's side; its orbit's ring stands while it is the place in view or orbits are on.
// Returns how much of its dot to draw (the model's, last frame, takes the rest).
function _aeOrbiterAt(s, st, eqeq, sc) {
  var key = s.craft, S = _ae.gl, pos = st.pos, vel = _aeRotZ(_aeXyz(st.velKmS), eqeq);
  var lv = _aeLvlh(pos, vel), fwd = lv[1], star = lv[2];
  _aeOrbiter[key] ={ pos: pos, speed: _aeLen(vel), basis: [fwd, star, _aeCross(fwd, star)] };
  var rings = S.craftRings || (S.craftRings = {}), ring = rings[key];
  if (!ring) { ring = rings[key] = _aeLine(S.THREE, S.THREE.LineLoop, AE_ISS_RING_POINTS, AE_ISS_RING_COLOR, AE_ISS_RING_ALPHA); S.scene.add(ring); }
  var line = Math.max(_aeOrbitShow(key), _ae.target === key ? 1 : 0);
  ring.visible = line > 0;
  if (ring.visible) {
    _aeRingPlace(ring, st, eqeq);
    ring.material.opacity = AE_ISS_RING_ALPHA * _aeFadeU.value * line;
  }
  return _aeProbeCraftDot(key);
}
function _aeUpdateSats(ms, sc) {
  var S = _ae.gl, sats = _ae.sats;
  _ae.positions = [];
  _aeOrbiter = {};
  _aeRingsOff(S.craftRings);   // (those with a place this frame come back on)
  if (!sats) { _aeCommitPoints(S.sats, 0); S.gpsRings.geometry.setDrawRange(0, 0); S.issRing.geometry.setDrawRange(0, 0); return; }
  var eqeq = _aeEqEq(sc);
  var count = 0, gpsOn = _aeSatsAllOn();
  var refreshRings = _ae.ringsAt === null || Math.abs(ms - _ae.ringsAt) > AE_RING_REFRESH_MS;
  var ringArr = S.gpsRings.geometry.attributes.position.array, ringN = 0;
  var issShown = false, selShown = false, issState = null, craftState = null;
  for (var i = 0; i < sats.list.length; i++) {
    var s = sats.list[i];
    craftState = null;
    var standing = _aeSatStanding((ms - s.epochMs) / MS_PER_DAY, s.iss, _aeClockRuns() || _ae.target === 'iss');
    s.standing = standing;
    if (standing === 'none' || (!s.iss && !s.craft && !gpsOn)) continue;   // the GPS constellation is the Satellites layer's (the station and the telescopes are their own)
    if (s.iss) {
      issShown = true;
      // Its orbit as it is now: the ellipse through the station's own position and velocity, the station its first vertex,
      // drawn again every frame so the station is on it (SGP4's path over one period is a spiral, 15 km from closing, and
      // a ring drawn a minute ago stood a chord's sag off the station).
      issState = _aeSatAt(s, ms, eqeq);
      _aeRingPlace(S.issRing, issState, eqeq);
      // Faded beside a faded (approximate) dot. Past that the ring is all
      // that is drawn, and it is right (the orbit's shape and tilt hold), so
      // it is drawn in full: at the faded strength it all but vanished and
      // the note's "orbit only" pointed at nothing.
      var issLine = Math.max(_aeOrbitShow('iss'), _ae.target === 'iss' ? _aeSmoother(_ae.issFar) : 0);   // out at the orbit, the ring is what it is looking at
      S.issRing.material.opacity = (standing === 'approximate' ? AE_ISS_RING_FADED : AE_ISS_RING_ALPHA) * _aeFadeU.value * issLine;
      S.issRing.visible = issLine > 0;
    } else if (s.craft) {
      craftState = _aeSatAt(s, ms, eqeq);
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
    var st = s.iss ? issState : s.craft ? craftState : _aeSatAt(s, ms, eqeq);
    if (!st) continue;
    var sel = !!_ae.selected && _ae.selected.norad === s.omm.NORAD_CAT_ID;
    selShown = selShown || sel;
    var own = s.iss || !!s.craft;   // the station and the telescopes: a dot of their own colour, and a model close up
    var color = sel ? AE_SELECTED_COLOR : (own ? AE_ISS_COLOR : AE_GPS_COLOR);
    var alpha = standing === 'approximate' ? (own ? AE_ISS_FADED_ALPHA : _aeSatApproxAlpha((ms - s.epochMs) / MS_PER_DAY)) : 1;
    var size = sel ? AE_SAT_SELECTED_PX : (own ? AE_ISS_POINT_PX : AE_SAT_POINT_PX);
    if (s.iss) alpha *= _aeIssAt(st, eqeq, standing);   // its dot gives way to the station itself, close up
    else if (s.craft) alpha *= _aeOrbiterAt(s, st, eqeq, sc);   // and the telescope's to its model
    _aeSetPoint(S.sats, count++, st.pos, color, alpha, size);
    _ae.positions.push({ idx: i, pos: st.pos, st: st });
  }
  _aeCommitPoints(S.sats, count);
  if (refreshRings) {
    S.gpsRings.geometry.attributes.position.needsUpdate = true;
    S.gpsRings.geometry.setDrawRange(0, ringN);
    _ae.ringsAt = ms;
  }
  if (!issShown) S.issRing.geometry.setDrawRange(0, 0);
  if (!issShown || !_ae.issPos) _aeIssAt(null);
  // A card belongs to a dot: when the tapped satellite's dot goes (its data
  // too far from the shown instant), its card goes with it.
  if (_ae.selected && !selShown) { _ae.selected = null; _aeRenderCard(); }
}

// ── Per-frame scene update ──
// The instants the Moon's path is drawn through about `ms`: 6-hour steps out to half a sidereal month either side,
// 10-minute steps within half a day of `ms`. The same count for any `ms`, so one buffer holds it.
function _aeMoonPathTimes(ms) {
  var H = 3600 * 1000, coarse = AE_MOON_PATH_STEP_HOURS * H, fine = AE_MOON_PATH_FINE_STEP_MIN * 60 * 1000;
  var half = AE_MOON_PATH_HALF_DAYS * MS_PER_DAY, near = AE_MOON_PATH_FINE_HOURS * H, out = [], t;
  for (t = -half; t < -near; t += coarse) out.push(ms + t);
  for (t = -near; t < near; t += fine) out.push(ms + t);
  for (t = near; t < half; t += coarse) out.push(ms + t);
  out.push(ms + half);
  return out;
}
function _aeUpdateMoonPath(ms) {
  if (_ae.moonPathAt !== null && Math.abs(ms - _ae.moonPathAt) < AE_MOON_PATH_REFRESH_MS) return;
  var S = _ae.gl, arr = S.moonPath.geometry.attributes.position.array, times = _aeMoonPathTimes(ms);
  for (var i = 0; i < S.moonPathCount; i++) {
    var sc = _aeSceneAt(times[i]);
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

// ── The ISS, close up ──
// iss-v1.bin (scripts/build_craft_models.py, from NASA 3D Resources' "International Space Station (ISS) (B)", NASA/Michael D.
// Carbajal, free and without copyright): fetched when the view first goes to the station or near it. Held the way the
// station flies (LVLH: the truss across the direction of travel, the Russian segment behind, the truss on the zenith
// side), its main solar arrays turned about the truss toward the Sun. Lit by the Sun (the arrays glint), by the Earth
// below in daylight, and dark in the Earth's shadow. Under AE_CRAFT_MODEL_PX across it is not drawn: the dot is.
var AE_ISS_URL = _almAsset('/static/earth/iss-v1.bin');
var AE_ISS_SPAN_RE = 109 / 1000 / AE_EARTH_RADIUS_KM;     // the station's 109 m along its truss, in Earth radii
var AE_ISS_VIEW_DIR = [-0.42, -0.55, 0.72];                 // from it, in its own axes (nadir, forward, starboard): above, behind, to starboard; the Earth below to the horizon
AE_TARGETS.iss = { min: AE_ISS_SPAN_RE * 0.9, max: 0.5, surface: AE_ISS_SPAN_RE / 2 };
// A mark for the flights' circles (and a tap on the model close up), never a name: its own label (ae-lbl-iss) has that.
AE_MARKED.push({ body: 'iss', flightOnly: true, name: function () { return _aeT('alm_earth_iss_short'); } });

// ── Spacecraft models ──
// The ISS (iss-v1.bin, five classes, its main arrays turning about the truss) and the probes (craft-<model>-v1.bin: their
// materials as a palette of colour, roughness and metalness, smooth normals, the axis that points stored; "ZCR2"), all
// from NASA 3D Resources (free and without copyright) and built by scripts/build_craft_models.py. The landing sites'
// models (craft-site-*.bin) may still be the older "ZCRF" (no normals: shaded flat). Each is fetched the first time
// the view goes to it or comes near, and drawn from AE_CRAFT_MODEL_PX across, its dot giving way to it.
var AE_CRAFT_PAL = 12;                                      // palette entries a model may use
// A gentle fill from the camera beside the Sun's key light: far out the Sun is a bright star, and a probe lit only by it
// read as a dim grey shape. The station keeps less, so the Earth's shadow still reads as night.
var AE_CRAFT_FILL = 0.1, AE_ISS_FILL = 0.04;
var AE_CRAFT_FILL_OF = { webb: 0.22 };                       // Webb's telescope lives in its sunshield's shade: lit by the camera, as every picture of it is
var AE_CRAFT_MODEL_PX = [6, 14];                            // the model fades in across these widths, the dot out
var AE_CRAFT_NEAR_MIN = 0.3 / 1000 / AE_EARTH_RADIUS_KM;    // 30 cm: a craft a few metres across, framed close
// A probe's table key and its model (one model for both Voyagers and both Pioneers); one without a model stays a dot.
var AE_CRAFT_MODEL = { voyager1: 'voyager', voyager2: 'voyager', pioneer10: 'pioneer', pioneer11: 'pioneer',
  parker: 'parker', juno: 'juno', jwst: 'webb', cassini: 'cassini', galileo: 'galileo', kepler: 'kepler',
  newhorizons: 'newhorizons', europaclipper: 'clipper', osirisapex: 'osirisrex', psyche: 'psyche', lucy: 'lucy',
  hubble: 'hubble', chandra: 'chandra' };
// The craft that orbit the Earth and have a model: a probe's model, flight and card with the place SGP4 gives (the satellites' elements, `craft`,
// worked out in _aeUpdateSats). Held with its long axis along the orbit, its far side toward the Earth ('orbit' in AE_CRAFT_POINTS below).
// The key is the Sent object's id (sent-v1.json), `norad` the elements', `model` the file (craft-<model>-v1.bin, scripts/build_craft_models.py).
var AE_ORBITERS = { hubble: { norad: 20580, model: 'hubble', name: 'Hubble Space Telescope', max: 120, link: 'ev:hubble', launchMs: Date.UTC(1990, 3, 24, 12) },
  chandra: { norad: 25867, model: 'chandra', name: 'Chandra X-ray Observatory', max: 400, launchMs: Date.UTC(1999, 6, 23, 12) } };
var _aeOrbiter = {};   // key -> { pos (Earth radii), vel (km/s, scene frame), basis: [along, across, nadir-ish] }, as the last frame left it
function _aeOrbiterOf(norad) { return Object.keys(AE_ORBITERS).filter(function (k) { return AE_ORBITERS[k].norad === norad; })[0] || null; }
function _aeIsOrbiter(key) { return Object.prototype.hasOwnProperty.call(AE_ORBITERS, key); }
function _aeIsCraft(key) { return _aeIsProbe(key) || _aeIsOrbiter(key); }
Object.keys(AE_ORBITERS).forEach(function (k) {
  AE_TARGETS[k] = { min: 0.001, max: AE_ORBITERS[k].max, surface: 0.001 };   // (the model's own span sets min and surface: _aeProbeCraftAt)
});
// Probes whose model only the Almanac HD pack carries (hd/craft/<model>.zcr2): a key joins AE_CRAFT_MODEL once the pack's craft
// index lists its model (_aeCraftHdOnlyJoin), so without the pack, or on any failure, the probe stays a dot as it always was.
var AE_CRAFT_HD_MODEL = { solarorbiter: 'solarorbiter', juice: 'juice', hayabusa2: 'hayabusa2' };
var AE_CRAFT_HD_ONLY = {};
Object.keys(AE_CRAFT_HD_MODEL).forEach(function (k) { AE_CRAFT_HD_ONLY[AE_CRAFT_HD_MODEL[k]] = true; });
// What each points: its high-gain antenna at the Earth, or (Parker, Webb) its shield at the Sun.
var AE_CRAFT_POINTS = { parker: 'sun', webb: 'sun', hubble: 'orbit', chandra: 'orbit' };
var AE_CRAFT_SHIELD_VIEW_SUN = 0.35;                       // the shield in profile, from the Sun's side so it is lit
var AE_CRAFT_VIEW_SPANS = 3;                                // a flight to a probe ends at least this many of its spans off
var AE_CRAFT_FIT_R = 0.6;                                   // and far enough that this share of its span fits the narrow side
var _aeCraft = {};                                          // model -> { data, loading }
// A flight to a craft starts at once, the model loading as it goes (its span is not known until it is here): planned for
// a craft this wide, then fitted to the model's own span, and held at the corner of its approach, the old place still in
// view, for a model that is late: at most AE_CRAFT_WAIT_MS, after which it arrives as planned.
var AE_CRAFT_PROVISIONAL_SPAN_RE = 15 / 1000 / AE_EARTH_RADIUS_KM;
var AE_CRAFT_WAIT_MS = 4000;
// ── Shading ──
// Physically based, and small: the Sun a hard key light (GGX highlight and a Lambert body), the nearest world's light a
// coloured fill from its side (its albedo's colour), a faint sky, the camera's gentle fill; a procedural environment (that
// world's glow) for foil and mirrors to reflect; one tight shadow map around the craft in view; a soft shoulder, then the
// same gamma as the planets. A mesh without normals (the landing sites' older models) is shaded flat, as it always was.
var AE_CRAFT_SUN_E = 3.4;                                   // the Sun's irradiance (so an albedo of 0.8 head on reads 0.76)
var AE_CRAFT_SKY = 0.03;                                    // the faint ambient and the dark of the environment
var AE_CRAFT_ENV_FILL = 3.0;                                // the camera's fill, as the light foil and mirrors reflect (they have no diffuse to light)
var AE_CRAFT_EXPOSURE = 1.5;                                // the tone curve 1 - exp(-k c): a sunlit white reads near white, shade stays readable
var AE_CRAFT_AMBER = 'vec3(0.5, 0.26, 0.06)';              // a solar array's back: Kapton, amber
var AE_CRAFT_GAMMA = 2.2;
var AE_CRAFT_SHADOW_PX = 1024;                              // the shadow map, one for the craft in view
var AE_CRAFT_SHADOW_MIN_PX = 90;                            // a craft narrower than this on screen casts none
var AE_CRAFT_SHADOW_BIAS = 0.0012;                          // in the map's depth (a craft's radius is 1)
var AE_CRAFT_SHADOW_NORMAL = 0.012;                         // the surface moved along its normal for the lookup, of the craft's radius
var AE_CRAFT_ROUGH_MIN = 0.08;
var AE_CRAFT_MAX_SHINE = 1.0;                               // the strongest planetshine
var AE_CRAFT_SHINE_REFLECT = 1.7;                           // a world's own light, as a share of what lands on a surface facing it
var AE_CRAFT_SOFTBOX = 'normalize(vec3(0.4, 0.5, 0.75))', AE_CRAFT_SOFTBOX_K = 0.9;   // a studio's soft light in the world, for shiny things to reflect (every picture of these has one)
var AE_CRAFT_STARS = 0.35;                                  // the star field a mirror reflects, faintly
var AE_CRAFT_KIND_STEP = 8;                                 // surf.z = flags + 8 * kind (cells, foil, quilt, radiator, metal: scripts/craftmesh.py KIND_*)
var AE_CRAFT_CELL_M = 0.35, AE_CRAFT_CRINKLE_M = [0.15, 0.05], AE_CRAFT_SEAM_M = 0.6, AE_CRAFT_RIB_M = 0.04;   // the patterns' scales, in metres
// Noise for the procedural surfaces: a hash, value noise, a vector of it, and a few stars on the reflection's direction.
var AE_CRAFT_GLSL_NOISE = [
  'float aeH13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }',
  'float aeVn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
  '  return mix(mix(mix(aeH13(i), aeH13(i + vec3(1, 0, 0)), f.x), mix(aeH13(i + vec3(0, 1, 0)), aeH13(i + vec3(1, 1, 0)), f.x), f.y),',
  '             mix(mix(aeH13(i + vec3(0, 0, 1)), aeH13(i + vec3(1, 0, 1)), f.x), mix(aeH13(i + vec3(0, 1, 1)), aeH13(i + vec3(1, 1, 1)), f.x), f.y), f.z); }',
  'vec3 aeVnv(vec3 p) { return vec3(aeVn(p), aeVn(p + 17.3), aeVn(p + 41.7)) - 0.5; }',
  'float aeOctave(float pw, float scale) { return 1.0 - smoothstep(scale / 6.0, scale / 3.0, pw); }',   // 1 while a pixel is well under the pattern's period, 0 once it is a third of it
  'vec3 aeStars(vec3 r) {',
  '  float band = exp(-pow(dot(normalize(r), normalize(vec3(0.3, 0.8, 0.5))) * 3.0, 2.0)) * (0.4 + 0.6 * aeVn(r * 5.0));',
  '  float star = step(0.985, aeH13(floor(r * 70.0))) * (0.5 + aeH13(floor(r * 70.0) + 3.0));',
  '  return vec3(0.9, 0.95, 1.0) * (0.25 * band + star);',
  '}'
].join('\n');
// The procedural surface of a palette entry, in the craft's own (object) space so it stays on the model: the cells of a
// solar array, the crinkle of foil, a blanket's seams, a radiator's ribs, the grain of bare metal. Each fades to its mean
// where its detail is under a pixel (the pattern's scale against how far an object-space step is per pixel).
var AE_CRAFT_GLSL_SURFACE = [
  '  float kd = floor(sp.z / ' + AE_CRAFT_KIND_STEP.toFixed(1) + ');',
  '  float envMul = 1.0;',
  '  vec3 po = vObj * unitM;',
  '  float pw = length(fwidth(po));',
  '  vec3 on = abs(vONrm);',
  '  vec2 q = on.x > max(on.y, on.z) ? po.yz : (on.y > on.z ? po.xz : po.xy);',
  '  if (kd > 0.5 && kd < 1.5) {',   // cells
  '    float fadeC = clamp(pw / ' + AE_CRAFT_CELL_M.toFixed(2) + ' * 2.5, 0.0, 1.0);',
  '    vec2 g = q / ' + AE_CRAFT_CELL_M.toFixed(2) + ';',
  '    vec2 f = fract(g);',
  '    float line = min(1.0, step(f.x, 0.06) + step(0.94, f.x) + step(f.y, 0.06) + step(0.94, f.y));',
  '    float bus = step(abs(f.x - 0.5), 0.02);',
  '    float hc = aeH13(vec3(floor(g), 1.0));',
  '    vec3 cell = a * (0.7 + 0.6 * hc);',
  '    vec3 pat = mix(cell, vec3(0.42, 0.44, 0.5), max(line * 0.75, bus * 0.5));',
  '    a = mix(pat, a, fadeC);',
  '    rough = mix(0.12, rough, fadeC);',
  '    metal = mix(0.35, metal, fadeC);',
  '  } else if (kd > 1.5 && kd < 2.5) {',   // foil: each octave of crinkle has its own share, gone before its period is under ~3 pixels (a bump finer than that shimmers as the view moves)
  '    float w1 = aeOctave(pw, ' + AE_CRAFT_CRINKLE_M[0].toFixed(2) + '), w2 = aeOctave(pw, ' + AE_CRAFT_CRINKLE_M[1].toFixed(2) + '), w3 = aeOctave(pw, 0.9), w4 = aeOctave(pw, 0.1);',
  '    vec3 bump = w1 * 1.1 * aeVnv(po / ' + AE_CRAFT_CRINKLE_M[0].toFixed(2) + ') + w2 * 0.7 * aeVnv(po / ' + AE_CRAFT_CRINKLE_M[1].toFixed(2) + ') + w3 * 0.4 * aeVnv(po / 0.9);',
  '    n = normalize(n + bump);',
  '    a *= 1.0 + w4 * 0.3 * (aeVn(po / 0.1) - 0.5);',
  '    rough = mix(rough, rough * 0.8, w1);',
  '  } else if (kd > 2.5 && kd < 3.5) {',   // quilted blanket
  '    float fadeQ = clamp(pw / ' + AE_CRAFT_SEAM_M.toFixed(2) + ' * 2.0, 0.0, 1.0);',
  '    vec2 e = abs(fract(q / ' + AE_CRAFT_SEAM_M.toFixed(2) + ') - 0.5) * 2.0;',
  '    float seam = smoothstep(0.9, 1.0, max(e.x, e.y));',
  '    a *= 1.0 - 0.22 * seam * (1.0 - fadeQ);',
  '    n = normalize(n + (1.0 - fadeQ) * 0.12 * aeVnv(po / 0.2));',
  '  } else if (kd > 3.5 && kd < 4.5) {',   // radiator
  '    float fadeR = clamp(pw / ' + AE_CRAFT_RIB_M.toFixed(2) + ' * 2.0, 0.0, 1.0);',
  '    float rib = 0.5 + 0.5 * sin(q.x / ' + AE_CRAFT_RIB_M.toFixed(2) + ' * 6.2832);',
  '    a *= 1.0 - 0.08 * rib * (1.0 - fadeR);',
  '  } else if (kd > 6.5) {',   // a sunshield layer: smooth, billowed, magenta-silver
  '    float fadeS = clamp(pw / 0.3 * 1.5, 0.0, 1.0);',
  '    n = normalize(n + 0.45 * aeVnv(po / 1.4) + (1.0 - fadeS) * 0.1 * aeVnv(po / 0.3));',
  '    a = mix(vec3(0.7, 0.7, 0.76), vec3(0.85, 0.35, 0.7), pow(1.0 - abs(facing), 2.2)) * (0.9 + 0.2 * aeVn(po / 0.6));',
  '    metal = 0.65; rough = 0.28;',
  '  } else if (kd > 5.5) {',   // a telescope mirror: a near perfect reflector, in hexagonal segments with gaps, the middle one missing
  '    rough = 0.05; a *= 0.85;',
  AE_CRAFT_GLSL_HEX,
  '  } else if (kd > 4.5) {',   // bare metal
  '    float fadeM = clamp(pw / 0.05 * 2.0, 0.0, 1.0);',
  '    float streak = aeVn(vec3(q.x * 40.0, q.y * 1.5, 0.0));',
  '    a *= 1.0 + (streak - 0.5) * 0.14 * (1.0 - fadeM);',
  '    rough = mix(rough * (0.8 + 0.4 * streak), rough, fadeM);',
  '  }'
].join('\n');
// The mirror's hexagonal segments (flat to flat mirrorHex.z, centred on mirrorHex.xy in the mirror's plane): a dark gap between
// them, a hair's tilt for each (so each catches the sky differently), and the middle segment gone.
var AE_CRAFT_GLSL_HEX = [
  '  if (mirrorHex.z > 0.0) {',
  '    vec2 pc = q - mirrorHex.xy; float P = mirrorHex.z;',
  '    vec2 e1 = vec2(1.0, 0.0), e2 = vec2(0.5, 0.8660254);',
  '    float hv = pc.y / (P * 0.8660254); float hu = pc.x / P - 0.5 * hv; float hy = -hu - hv;',
  '    float rx = floor(hu + 0.5), ry = floor(hy + 0.5), rz = floor(hv + 0.5);',
  '    float dx = abs(rx - hu), dy = abs(ry - hy), dz = abs(rz - hv);',
  '    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;',
  '    if (rx == 0.0 && rz == 0.0) discard;',
  '    vec2 dd = pc - P * (rx * e1 + rz * e2);',
  '    float edge = 0.5 * P - max(max(abs(dot(dd, e1)), abs(dot(dd, e2))), abs(dot(dd, vec2(-0.5, 0.8660254))));',
  '    float gw = max(0.012, pw * 1.2);',
  '    a = mix(a, vec3(0.012), 1.0 - smoothstep(0.35 * gw, gw, edge));',
  '    n = normalize(n + 0.05 * (vec3(aeH13(vec3(rx, rz, 1.0)), aeH13(vec3(rx, rz, 2.0)), aeH13(vec3(rx, rz, 3.0))) - 0.5));',
  '    envMul = 1.0 - 0.8 * smoothstep(0.9, 0.99, dot(n, v));',   // looking straight in, it mirrors its own secondary
  '  }'
].join('\n');
var AE_CRAFT_VERT = [
  'attribute float cls;',
  'uniform mat4 shadowMat;',
  'uniform mat4 localMat;',
  'uniform float shadowOffset;',
  'varying vec3 vView;',
  'varying vec3 vNrm;',
  'varying float vCls;',
  'varying vec2 vUv;',
  'varying vec3 vShadow;',
  'varying vec3 vObj;',
  'varying vec3 vONrm;',
  'void main() {',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  vView = mv.xyz; vCls = cls;',
  '  vec3 lp = (localMat * vec4(position, 1.0)).xyz;',
  '#ifdef CRAFT_NRM',
  '  vNrm = normalMatrix * normal;',
  '  lp += normalize((localMat * vec4(normal, 0.0)).xyz) * shadowOffset;',
  '#else',
  '  vNrm = vec3(0.0);',
  '#endif',
  '#ifdef CRAFT_UV',
  '  vUv = uv;',
  '#else',
  '  vUv = vec2(0.0);',
  '#endif',
  '  vShadow = (shadowMat * vec4(lp, 1.0)).xyz;',
  '  vObj = position;',
  '#ifdef CRAFT_NRM',
  '  vONrm = normal;',
  '#else',
  '  vONrm = vec3(0.0, 0.0, 1.0);',
  '#endif',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var AE_CRAFT_FRAG = [
  'uniform vec3 sunView;',
  'uniform vec3 nadirView;',
  'uniform vec3 shineCol;',
  'uniform vec3 sunTint; uniform vec3 skyAmb; uniform vec3 dustCol; uniform float dustAmt;',
  'uniform float lit;',
  'uniform float earthLight;',
  'uniform float fade;',
  'uniform float fill;',
  'uniform float sel;',
  'uniform float shadowOn;',
  'uniform float shadowTexel;',
  'uniform sampler2D shadowMap;',
  'uniform vec3 albedo[' + AE_CRAFT_PAL + '];',
  'uniform vec3 surf[' + AE_CRAFT_PAL + '];',   // roughness, metalness, flags
  '#ifdef CRAFT_MAP',
  'uniform sampler2D map;',
  '#endif',
  '#ifdef CRAFT_MR',
  'uniform sampler2D mrMap;',
  '#endif',
  'varying vec3 vView;',
  'varying vec3 vNrm;',
  'varying float vCls;',
  'varying vec2 vUv;',
  'varying vec3 vShadow;',
  'varying vec3 vObj;',
  'varying vec3 vONrm;',
  'uniform float unitM;',
  'uniform vec3 mirrorHex;',
  'const float PI = 3.14159265;',
  AE_CRAFT_GLSL_NOISE,
  'float aeShadow() {',
  '  if (shadowOn < 0.5) return 1.0;',
  '  vec3 p = vShadow * 0.5 + 0.5;',
  '  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;',
  '  float s = 0.0;',
  '  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++)',
  '    s += step(p.z - ' + AE_CRAFT_SHADOW_BIAS.toFixed(4) + ', texture2D(shadowMap, p.xy + vec2(float(x), float(y)) * shadowTexel).r);',
  '  return s / 9.0;',
  '}',
  'void main() {',
  '  vec3 v = normalize(-vView);',
  '#ifdef CRAFT_NRM',
  '  vec3 n = normalize(vNrm);',
  '#else',
  '  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));',   // flat: panels, dishes and boxes
  '#endif',
  '  float facing = dot(n, v);',
  '  if (facing < 0.0) n = -n;',
  '  int k = int((sel >= 0.0 ? sel : vCls) + 0.5);',
  '  vec3 a = albedo[0]; vec3 sp = surf[0];',
  '  for (int i = 1; i < ' + AE_CRAFT_PAL + '; i++) { if (i == k) { a = albedo[i]; sp = surf[i]; } }',
  '  float rough = sp.x, metal = sp.y;',
  '  if (facing < 0.0 && floor(mod(sp.z, 8.0) / 4.0) > 0.5) { a = ' + AE_CRAFT_AMBER + '; rough = 0.5; metal = 0.15; }',
  '#ifdef CRAFT_MAP',
  '  vec4 tc = texture2D(map, vUv);',
  '  if (tc.a < 0.5 && mod(floor(mod(sp.z, 8.0) / 2.0), 2.0) > 0.5) discard;',
  '  a *= pow(tc.rgb, vec3(' + AE_CRAFT_GAMMA.toFixed(1) + '));',
  '#endif',
  '#ifdef CRAFT_MR',
  '  vec3 mr = texture2D(mrMap, vUv).rgb;',
  '  rough *= mr.g; metal *= mr.b;',
  '#endif',
  '  a = mix(a, a * dustCol, dustAmt * (0.35 + 0.65 * clamp(dot(n, nadirView), 0.0, 1.0)));',
  AE_CRAFT_GLSL_SURFACE,
  '  rough = clamp(rough, ' + AE_CRAFT_ROUGH_MIN.toFixed(2) + ', 1.0);',
  '  vec3 f0 = mix(vec3(0.04), a, metal);',
  '  vec3 diff = a * (1.0 - metal);',
  '  float nv = max(dot(n, v), 1e-3);',
  '  float nl = max(dot(n, sunView), 0.0);',
  '  vec3 h = normalize(sunView + v);',
  '  float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);',
  '  float al = rough * rough, a2 = al * al;',
  '  float dd = nh * nh * (a2 - 1.0) + 1.0;',
  '  float D = a2 / (PI * dd * dd);',
  '  float kk = (rough + 1.0) * (rough + 1.0) / 8.0;',
  '  float vis = 1.0 / (4.0 * (nl * (1.0 - kk) + kk) * (nv * (1.0 - kk) + kk));',
  '  vec3 F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);',
  '  float sun = lit * aeShadow() * step(0.0, dot(n, sunView));',
  '  vec3 col = (diff * nl * sun * ' + (AE_CRAFT_SUN_E / Math.PI).toFixed(4) + ' + D * F * vis * nl * sun * ' + AE_CRAFT_SUN_E.toFixed(2) + ') * sunTint;',
  '  col += diff * skyAmb * (0.5 + 0.5 * dot(n, nadirView));',
  '  vec3 ps = shineCol * earthLight;',                       // the nearest world's light: from its side, in its colour
  '  col += diff * ps * (0.5 + 0.5 * dot(n, nadirView));',
  '  vec3 r = reflect(-v, n);',
  '  vec3 env = ps * (0.2 + 1.1 * smoothstep(-0.4, 1.0, dot(r, nadirView))) + vec3(' + AE_CRAFT_SKY.toFixed(3) + ' + fill * ' + AE_CRAFT_ENV_FILL.toFixed(1) + ') ;',
  '  vec3 rw = transpose(mat3(viewMatrix)) * r;',
  '  vec3 soft = pow(max(dot(rw, ' + AE_CRAFT_SOFTBOX + '), 0.0), 3.0) * vec3(1.0, 0.92, 0.78) * ' + AE_CRAFT_SOFTBOX_K.toFixed(2) + ' * (1.0 - rough);',
  '  env = env * envMul + (aeStars(rw) * ' + AE_CRAFT_STARS.toFixed(2) + ' * (rough < 0.1 ? 4.0 : 1.0) + soft) * envMul;',
  '  vec3 fe = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);',
  '  col += fe * env * (1.0 - 0.5 * rough);',
  '  col += diff * (' + AE_CRAFT_SKY.toFixed(3) + ' + fill * nv);',   // fill: from the camera, gentle
  '  vec3 c = 1.0 - exp(-' + AE_CRAFT_EXPOSURE.toFixed(2) + ' * col);',
  '  gl_FragColor = vec4(pow(c, vec3(' + (1 / AE_CRAFT_GAMMA).toFixed(4) + ')), fade);',
  '}'
].join('\n');
var AE_CRAFT_DEPTH_VERT = [
  'uniform mat4 shadowMat;',
  'uniform mat4 localMat;',
  'void main() { gl_Position = shadowMat * localMat * vec4(position, 1.0); }'
].join('\n');
var AE_CRAFT_DEPTH_FRAG = 'void main() { gl_FragColor = vec4(1.0); }';
var AE_CRAFT_FLAT_ROUGH_REF = 110, AE_CRAFT_FLAT_ROUGH_MIN = 0.15, AE_CRAFT_FLAT_ROUGH_MAX = 0.8;   // the older meshes' sharpness as a roughness
var AE_CRAFT_FLAT_METAL_FROM = 0.5, AE_CRAFT_FLAT_METAL_SPAN = 1.5;                                  // and their specular strength as a metalness
var AE_CRAFT_MAT_DOUBLE = 1, AE_CRAFT_MAT_CUTOUT = 2;
var AE_CRAFT_NO_TURN = 255;
// A model the app does not ship (the Sent chooser's other craft, scripts/build_craft_models.py --hd) is the Almanac HD pack's:
// its file is hd/craft/<model>.zcr2, named by the pack's craft index.
function _aeCraftUrl(model) {
  if (AE_CRAFT_HD_ONLY[model]) { var e = _aeCraftHd.index && _aeCraftHd.index[model]; return _aeCraftHdUrl(e ? e.file : model + '.zcr2'); }
  return model === 'iss' ? AE_ISS_URL : _almAsset('/static/earth/craft-' + model + '-v1.bin');
}
// Either format into one shape: positions centred on the box, normals (ZCR2) or none (ZCRF: flat), a class (palette
// entry) per vertex, the look per class ({ rgb, rough, metal, flags, tex, mr }), metres per unit, the widest extent in
// units and the box's radius; a probe's pointing and across axes, the ISS's turning class and axis.
function _aeCraftParse(buf) {
  var dv = new DataView(buf), f = function (o) { return dv.getFloat32(o, true); };
  var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  var v2 = magic === 'ZCR2';
  if (!v2 && magic !== 'ZCRF') throw new Error('craft format ' + magic);   // another format (a file kept from an older release): not read as this one
  var lo = [f(12), f(16), f(20)], hi = [f(24), f(28), f(32)], mid = [0, 1, 2].map(function (k) { return (lo[k] + hi[k]) / 2; });
  var d = { metres: f(8), span: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), mid: mid, look: [],   // mid: where the box's middle was (the sites' models are placed by their own frame, almanac-sites.js)
    radius: 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) }, o, i, k;
  d.aim = [f(36), f(40), f(44)]; d.across = [f(48), f(52), f(56)];
  var np = dv.getUint32(60, true), nv, nt, flags = 0, stride = 8;
  if (v2) {
    nv = dv.getUint32(64, true); nt = dv.getUint32(68, true); flags = dv.getUint32(72, true);
    if (dv.getUint32(84, true) !== AE_CRAFT_NO_TURN) d.axis = [f(76) - mid[0], f(80) - mid[1]], d.turn = dv.getUint32(84, true);
    for (o = 88, i = 0; i < np; i++, o += 24) {
      d.look.push({ rgb: [f(o), f(o + 4), f(o + 8)], rough: dv.getUint8(o + 12) / 255, metal: dv.getUint8(o + 13) / 255, flags: dv.getUint8(o + 14),
        tex: dv.getInt16(o + 16, true), mr: dv.getInt16(o + 20, true), kind: dv.getUint8(o + 15) });
    }
    if (flags & 2) {
      var nn = dv.getUint16(o, true), names = [];
      o += 2;
      for (i = 0; i < nn; i++) { var len = dv.getUint8(o++); names.push(String.fromCharCode.apply(null, new Uint8Array(buf, o, len))); o += len; }
      d.textures = names;
    }
    stride = 9 + (flags & 1 ? 8 : 0);
  } else {
    for (o = 64, i = 0; i < np; i++, o += 20) {
      var spec = f(o + 12), sharp = f(o + 16);
      d.look.push({ rgb: [f(o), f(o + 4), f(o + 8)],
        rough: _aeClamp(1 - sharp / AE_CRAFT_FLAT_ROUGH_REF, AE_CRAFT_FLAT_ROUGH_MIN, AE_CRAFT_FLAT_ROUGH_MAX),
        metal: _aeClamp((spec - AE_CRAFT_FLAT_METAL_FROM) / AE_CRAFT_FLAT_METAL_SPAN, 0, 1), flags: AE_CRAFT_MAT_DOUBLE, tex: -1, mr: -1 });
    }
  }
  if (!v2) { nv = dv.getUint32(o, true); nt = dv.getUint32(o + 4, true); o += 8; }
  var pos = new Float32Array(nv * 3), cls = new Float32Array(nv), nrm = v2 ? new Float32Array(nv * 3) : null, uv = flags & 1 ? new Float32Array(nv * 2) : null;
  for (i = 0; i < nv; i++, o += stride) {
    for (k = 0; k < 3; k++) pos[i * 3 + k] = lo[k] + (dv.getInt16(o + 2 * k, true) + 32767) / 65534 * (hi[k] - lo[k]) - mid[k];
    if (v2) {
      var ex = dv.getInt8(o + 6) / 127, ey = dv.getInt8(o + 7) / 127, ez = 1 - Math.abs(ex) - Math.abs(ey), x = ex, y = ey;
      if (ez < 0) { x = (1 - Math.abs(ey)) * (ex >= 0 ? 1 : -1); y = (1 - Math.abs(ex)) * (ey >= 0 ? 1 : -1); }
      var il = 1 / (Math.hypot(x, y, ez) || 1);
      nrm[i * 3] = x * il; nrm[i * 3 + 1] = y * il; nrm[i * 3 + 2] = ez * il;
      cls[i] = dv.getUint8(o + 8);
      if (uv) { uv[i * 2] = dv.getFloat32(o + 9, true); uv[i * 2 + 1] = dv.getFloat32(o + 13, true); }
    } else cls[i] = dv.getUint8(o + 6);
  }
  d.pos = pos; d.cls = cls; d.nrm = nrm; d.uv = uv;
  d.idx = nv > 65535 ? new Uint32Array(buf.slice(o, o + nt * 12)) : new Uint16Array(buf.slice(o, o + nt * 6));
  return d;
}
// then: a flight waiting on the model (Go to a probe before its model is here), flown when it comes or fails.
// A model that is slow to come says so (the hint line), and one that does not come says it will be a dot: never a blank view.
var AE_CRAFT_SLOW_MS = 400;
function _aeCraftLoad(model, then) {
  var c = _aeCraft[model] = _aeCraft[model] || {};
  if (then) c.then = then;
  if (c.data || c.loading || c.bad || typeof fetch !== 'function') return;   // c.bad: a file this parser does not read is not asked for again
  c.loading = true;
  c.slow = setTimeout(function () { if (c.loading && _ae && typeof _aeShowHint === 'function') { c.said = true; _aeShowHint(_aeT('alm_craft_loading')); } }, AE_CRAFT_SLOW_MS);
  var done = function () {
    clearTimeout(c.slow);
    if (c.said && c.data && _ae && typeof _aeHideHint === 'function') _aeHideHint();
    c.said = false;
    var t = c.then; c.then = null; if (t && _ae) t();
  };
  fetch(_aeCraftUrl(model)).then(function (r) { if (!r.ok) throw new Error(model); return r.arrayBuffer(); }).then(function (buf) {
    try { c.data = _aeCraftParse(buf); } catch (e) { c.bad = true; throw e; }
    if (_ae) _aeRedraw();
    done();
  }).catch(function () {
    c.loading = false; c.failed = true;
    if (_ae && !AE_CRAFT_HD_ONLY[model] && typeof _aeShowHint === 'function') _aeShowHint(_aeT('alm_craft_failed'));   // an HD model that is not there is the dot, quietly
    done();
  });
}
function _aeCraftData(model) { return (_aeCraft[model] && _aeCraft[model].data) || null; }
// Its span in Earth radii, once loaded (0 before).
function _aeCraftSpanRe(model) { var d = _aeCraftData(model); return d ? d.span * d.metres / 1000 / AE_EARTH_RADIUS_KM : 0; }
// The shared uniforms of one craft's materials: the light (set each frame by _aeCraftLight, and by the sites for theirs),
// the palette, the shadow's matrix and map.
function _aeCraftUniforms(S, d, model) {
  var THREE = S.THREE, pal = [], i;
  for (i = 0; i < AE_CRAFT_PAL; i++) pal.push(d.look[Math.min(i, d.look.length - 1)]);
  return { sunView: { value: new THREE.Vector3(1, 0, 0) }, nadirView: { value: new THREE.Vector3(0, -1, 0) }, shineCol: { value: new THREE.Vector3(0.55, 0.7, 1.0) },
    sunTint: { value: new THREE.Vector3(1, 1, 1) }, skyAmb: { value: new THREE.Vector3(0, 0, 0) }, dustCol: { value: new THREE.Vector3(1, 1, 1) }, dustAmt: { value: 0 },   // air: the Sun's colour, the sky's light from above, dust that settles on top faces (a site's own; space has none)
    lit: { value: 1 }, fill: { value: model === 'iss' ? AE_ISS_FILL : AE_CRAFT_FILL_OF[model] || AE_CRAFT_FILL }, earthLight: { value: 0 }, fade: { value: 1 }, sel: { value: -1 },
    shadowOn: { value: 0 }, shadowTexel: { value: 1 / AE_CRAFT_SHADOW_PX }, shadowMap: { value: null }, shadowMat: { value: new THREE.Matrix4() },
    shadowOffset: { value: d.radius * AE_CRAFT_SHADOW_NORMAL }, unitM: { value: d.metres || 1 }, mirrorHex: { value: _aeCraftMirrorHex(THREE, d, model) },
    albedo: { value: pal.map(function (l) { return new THREE.Vector3(l.rgb[0], l.rgb[1], l.rgb[2]); }) },
    surf: { value: pal.map(function (l) { return new THREE.Vector3(l.rough, l.metal, l.flags + AE_CRAFT_KIND_STEP * (l.kind || 0)); }) } };
}
// One mesh of a craft: its triangles `list`, its own place relative to the craft (`local`, a Matrix4: a turning array's),
// `sel` the palette entry it is all of (-1: each vertex says), `maps` its textures ({ map, mr }).
function _aeCraftMesh(S, d, uni, list, local, sel, maps) {
  var THREE = S.THREE, gg = new THREE.BufferGeometry(), defines = {};
  gg.setAttribute('position', d.gpos || (d.gpos = new THREE.BufferAttribute(d.pos, 3)));
  gg.setAttribute('cls', d.gcls || (d.gcls = new THREE.BufferAttribute(d.cls, 1)));
  if (d.nrm) { gg.setAttribute('normal', d.gnrm || (d.gnrm = new THREE.BufferAttribute(d.nrm, 3))); defines.CRAFT_NRM = 1; }
  if (d.uv) { gg.setAttribute('uv', d.guv || (d.guv = new THREE.BufferAttribute(d.uv, 2))); defines.CRAFT_UV = 1; }
  gg.setIndex(new THREE.BufferAttribute(d.pos.length / 3 > 65535 ? new Uint32Array(list) : new Uint16Array(list), 1));
  var uniforms = {}, key;
  for (key in uni) uniforms[key] = uni[key];
  uniforms.localMat = { value: local };
  uniforms.sel = { value: sel };
  if (maps && maps.map) { uniforms.map = { value: maps.map }; defines.CRAFT_MAP = 1; }
  if (maps && maps.mr) { uniforms.mrMap = { value: maps.mr }; defines.CRAFT_MR = 1; }
  var mat = new THREE.ShaderMaterial({ uniforms: uniforms, defines: defines, vertexShader: AE_CRAFT_VERT, fragmentShader: AE_CRAFT_FRAG, transparent: true, side: AE_THREE_DOUBLE_SIDE });
  var mesh = new THREE.Mesh(gg, mat);
  mesh.frustumCulled = false;
  return mesh;
}
function _aeCraftBuild(S, model) {
  var THREE = S.THREE, d = _aeCraftData(model), uni = _aeCraftUniforms(S, d, model);
  var root = new THREE.Group(), pivot = new THREE.Group(), body = [], turning = [];
  // The ISS's main arrays (its turning class) turn about the truss to the Sun; a probe is one rigid body.
  for (var t = 0; t < d.idx.length; t += 3) (d.axis && d.cls[d.idx[t]] === d.turn ? turning : body).push(d.idx[t], d.idx[t + 1], d.idx[t + 2]);
  var identity = new THREE.Matrix4(), parts = [];
  var main = _aeCraftMesh(S, d, uni, body, identity, -1);
  root.add(main);
  parts.push({ mesh: main, local: identity });
  var arrLocal = null;
  if (d.axis) {
    var arr = _aeCraftMesh(S, d, uni, turning, arrLocal = new THREE.Matrix4(), -1);
    pivot.position.set(d.axis[0], d.axis[1], 0);
    arr.position.set(-d.axis[0], -d.axis[1], 0);
    pivot.add(arr);
    root.add(pivot);
    parts.push({ mesh: arr, local: arrLocal });
  }
  var record = AE_CRAFT_RECORD[model] ? _aeRecordMesh(THREE, d, AE_CRAFT_RECORD[model], uni) : null;
  if (record) root.add(record);
  root.scale.setScalar(d.metres / 1000 / AE_EARTH_RADIUS_KM);
  root.visible = false;
  S.scene.add(root);
  return { root: root, pivot: pivot, uni: uni, model: model, record: record, parts: parts, stock: parts, d: d };
}
// Voyager's Golden Record where it is on the craft: on the face of the bus, filling its round white plate, facing out
// (+x in NASA's model; the plate is a disc 0.234 m in radius centred at y -1.961, z -2.372, its face at x 1.252: a circle
// fitted to the model's own vertices). Its face is the
// Almanac's own picture of the record's cover (static/golden-record/cover.jpg); a tap on it opens that section.
var AE_CRAFT_RECORD = { voyager: { at: [1.2535, -2.011, -2.371], r: 0.235 } };   // metres in the model's frame
var AE_RECORD_IMG = _almAsset('/static/golden-record/cover.jpg'), AE_RECORD_IMG_R = 0.445;   // the disc's radius in the picture (of its width)
var AE_RECORD_IMG_C = [0.501, 0.51];   // and its centre (u, v), measured on the picture: a little right of the middle and above it
var AE_RECORD_VERT = [
  'varying vec2 vUv;',
  'void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
].join('\n');
var AE_RECORD_FRAG = [
  'uniform sampler2D map; uniform float mapped; uniform float lit; uniform float fill; uniform float fade;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec2 q = vUv - vec2(' + AE_RECORD_IMG_C[0] + ', ' + AE_RECORD_IMG_C[1] + ');',
  '  if (dot(q, q) > ' + (AE_RECORD_IMG_R * AE_RECORD_IMG_R).toFixed(4) + ') discard;',
  '  vec3 c = mapped > 0.5 ? texture2D(map, vUv).rgb : vec3(0.78, 0.58, 0.24);',   // gold until its picture is in
  '  gl_FragColor = vec4(min(c * 1.3, vec3(1.0)) * min(1.0, 0.35 + 0.65 * lit + fill), fade);',
  '}'
].join('\n');
function _aeRecordMesh(THREE, d, rec, craftUni) {
  var u = 1 / d.metres, half = rec.r * u, c = rec.at.map(function (x) { return x * u; });
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    c[0], c[1] - half, c[2] - half, c[0], c[1] + half, c[2] - half, c[0], c[1] + half, c[2] + half, c[0], c[1] - half, c[2] + half]), 3));
  var u0 = AE_RECORD_IMG_C[0] - AE_RECORD_IMG_R, u1 = AE_RECORD_IMG_C[0] + AE_RECORD_IMG_R, v0 = AE_RECORD_IMG_C[1] - AE_RECORD_IMG_R, v1 = AE_RECORD_IMG_C[1] + AE_RECORD_IMG_R;
  gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1]), 2));   // the quad is the disc's own box
  gg.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  var uni = { map: { value: null }, mapped: { value: 0 }, lit: craftUni.lit, fill: craftUni.fill, fade: craftUni.fade };
  var mesh = new THREE.Mesh(gg, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_RECORD_VERT, fragmentShader: AE_RECORD_FRAG, transparent: true, side: AE_THREE_DOUBLE_SIDE }));
  mesh.frustumCulled = false;
  mesh.userData.at = c; mesh.userData.metres = rec.r;
  _aeLoadTexture(THREE, AE_RECORD_IMG).then(function (tx) { uni.map.value = tx; uni.mapped.value = 1; if (_ae) _aeRedraw(); }).catch(function () {});
  return mesh;
}
// A tap on Voyager's record (drawn as itself, close up): the Almanac's Golden Record. True when it took the tap.
var AE_RECORD_TAP_PX = 22;
function _aeRecordTap(x, y) {
  var S = _ae.gl, I = S && S.crafts && S.crafts[_ae.target];
  if (!I || !I.record || !I.root.visible || typeof window._scrollToGoldenRecord !== 'function') return false;
  var c = I.record.userData.at, w = new S.THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(I.root.matrixWorld);
  var p = _aeXyz(w), s = _aeProject(p);
  if (!s) return false;
  var cam = S.camera, pxPerRad = _aePxPerRad(cam);
  var rPx = I.record.userData.metres / 1000 / AE_EARTH_RADIUS_KM / Math.max(1e-12, _aeLen(_aeSub(p, _aeXyz(cam.position)))) * pxPerRad;
  if (Math.hypot(s.x - x, s.y - y) > Math.max(rPx, AE_RECORD_TAP_PX)) return false;
  _aeClose();
  window._scrollToGoldenRecord();
  return true;
}
// The nearest world's light on a craft at pos: where it is (the way to it), its colour and how strong (its disc's size
// from here, its phase as the craft sees it, its albedo's colour). Earth, the Moon, then each planet drawn.
var AE_SHINE_EARTH = [0.45, 0.58, 0.8], AE_SHINE_MOON = [0.42, 0.4, 0.38];   // linear albedo colours: the blue marble, grey regolith
var AE_SHINE_FAR = 0.002;                                                    // a world under this share of the craft's sky (r / d, squared) casts nothing
function _aePlanetshine(pos, sunAt) {
  var S = _ae.gl, sc = _ae.scene, best = null, bestK = 0;
  var consider = function (center, r, col) {
    var to = _aeSub(center, pos), dist = _aeLen(to);
    if (dist < r * 1.0001 || (r / dist) * (r / dist) < AE_SHINE_FAR) return;
    var away = _aeScale(to, -1 / dist), phase = 0.5 + 0.5 * _aeDot(away, _aeNorm(_aeSub(sunAt, center)));
    var lum = 0.3 * col[0] + 0.55 * col[1] + 0.15 * col[2];
    var k = lum * (r / dist) * (r / dist) * phase * AE_CRAFT_SHINE_REFLECT;
    if (k > bestK) { bestK = k; best = { dir: _aeScale(to, 1 / dist), col: col }; }
  };
  consider([0, 0, 0], 1, AE_SHINE_EARTH);
  consider(sc.moon, AE_MOON_RADIUS_RE, AE_SHINE_MOON);
  for (var key in S.planets || {}) {
    var p = S.planets[key];
    if (p && p.pos) consider(p.pos, p.b.r, p.b.color.map(function (c) { return c * c; }));
  }
  if (best) { var m = Math.max(best.col[0], best.col[1], best.col[2]) || 1; best.col = best.col.map(function (c) { return c / m; }); best.k = Math.min(bestK, AE_CRAFT_MAX_SHINE); }
  return best;
}
// The shadow map of the craft in view: a depth target, and a scene of one depth-only mesh for each of its parts (sharing
// their geometry), drawn from the Sun in the craft's own frame, so its resolution is spent on the craft alone.
function _aeCraftShadowTarget(S, I) {
  var THREE = S.THREE, N = AE_CRAFT_SHADOW_PX;
  var rt = new THREE.WebGLRenderTarget(N, N, { depthBuffer: true, depthTexture: new THREE.DepthTexture(N, N), minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  return { rt: rt, scene: new THREE.Scene(), parts: null };
}
function _aeCraftShadowScene(S, I, sh) {
  var THREE = S.THREE;
  if (sh.parts === I.parts) return;
  sh.scene.children.slice().forEach(function (m) { sh.scene.remove(m); m.material.dispose(); });
  I.parts.forEach(function (p) {
    var m = new THREE.Mesh(p.mesh.geometry, new THREE.ShaderMaterial({ uniforms: { shadowMat: I.uni.shadowMat, localMat: { value: p.local } },
      vertexShader: AE_CRAFT_DEPTH_VERT, fragmentShader: AE_CRAFT_DEPTH_FRAG, side: AE_THREE_DOUBLE_SIDE }));
    m.frustumCulled = false;
    sh.scene.add(m);
  });
  sh.parts = I.parts;
}
// The turning arrays' place in the craft's frame (the pivot's turn, then their own offset), for the light and its shadow.
function _aeCraftLocals(I) {
  I.parts.forEach(function (p) {
    if (p.mesh.parent === I.root || !p.mesh.parent) { p.local.identity(); return; }
    p.mesh.parent.updateMatrix(); p.mesh.updateMatrix();
    p.local.copy(p.mesh.parent.matrix).multiply(p.mesh.matrix);
  });
}
// Light from the Sun (unit, toward it, in the world) into the craft's shadow, when it is big enough to show it.
function _aeCraftShadow(I, sun, px) {
  var S = _ae.gl, uni = I.uni, THREE = S.THREE, R = I.shadowR || I.d.radius;
  var on = I.root.visible && px >= AE_CRAFT_SHADOW_MIN_PX && uni.lit.value > 0.5 && !!I.d.nrm && typeof THREE.WebGLRenderTarget === 'function';
  uni.shadowOn.value = on ? 1 : 0;
  uni.shadowOffset.value = R * AE_CRAFT_SHADOW_NORMAL;
  if (!on) return;
  var V = THREE.Vector3, q = I.root.quaternion.clone().invert();
  var s = new V(sun[0], sun[1], sun[2]).applyQuaternion(q).normalize();   // the Sun in the craft's own frame
  var up = Math.abs(s.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
  var u = new V().crossVectors(up, s).normalize(), w = new V().crossVectors(s, u), k = 1 / R;
  uni.shadowMat.value.set(u.x * k, u.y * k, u.z * k, 0, w.x * k, w.y * k, w.z * k, 0, -s.x * k, -s.y * k, -s.z * k, 0, 0, 0, 0, 1);
  _aeCraftLocals(I);
  var sh = I.shadow || (I.shadow = _aeCraftShadowTarget(S, I));
  _aeCraftShadowScene(S, I, sh);
  var r = S.renderer, prev = r.getRenderTarget();
  r.setRenderTarget(sh.rt);
  r.clear();
  r.render(sh.scene, S.camera);
  r.setRenderTarget(prev);
  uni.shadowMap.value = sh.rt.depthTexture;
}
// A model's light: the Sun (dark in the Earth's shadow), the nearest world's glow from its side (the Earth's day side
// below the station, Jupiter's beside Juno), turned into the camera's frame for the shader, and its shadow on itself.
function _aeCraftLight(I, pos, nadir, show) {
  var cam = _ae.gl.camera, sun = _aeNorm(_aeSub(_aeSunShown(_ae.scene), pos));
  var along = _aeDot(pos, sun), perp = _aeLen(_aeSub(pos, _aeScale(sun, along)));
  I.uni.lit.value = along > 0 || !nadir ? 1 : _smoothstep(0.995, 1.005, perp);
  var shine = _aePlanetshine(pos, _aeSunShown(_ae.scene));
  I.uni.earthLight.value = shine ? shine.k : 0;
  if (shine) I.uni.shineCol.value.set(shine.col[0], shine.col[1], shine.col[2]);
  I.uni.fade.value = show * _aeFadeU.value;
  I.root.updateMatrixWorld();
  var vInv = cam.matrixWorldInverse.elements;
  var toView = function (u, out) { out.set(vInv[0] * u[0] + vInv[4] * u[1] + vInv[8] * u[2], vInv[1] * u[0] + vInv[5] * u[1] + vInv[9] * u[2], vInv[2] * u[0] + vInv[6] * u[1] + vInv[10] * u[2]).normalize(); };
  toView(sun, I.uni.sunView.value);
  toView(shine ? shine.dir : sun, I.uni.nadirView.value);
  _aeCraftShadow(I, sun, _aeCraftPx(I.d.span * I.d.metres / 1000 / AE_EARTH_RADIUS_KM, pos));
  _aeCraftHdRequest(I, pos);
}

// ── Almanac HD craft ──
// With the Almanac HD ZIM, the craft it holds are drawn from NASA's own full models (scripts/build_craft_hd.py): their
// triangles untouched, their textures and materials (gold foil, cells, blankets), one mesh to a material, in the stock
// model's frame so the pointing and the size hold. Fetched the first time a craft is close enough to show it, drawn in
// place of the stock mesh when ready; without the ZIM (or for a craft it lacks) nothing changes. craft/index.json lists
// them: { models: { <key>: { file } } }.
var AE_CRAFT_SHARED_UNIFORMS = ['unitM', 'mirrorHex', 'sunView', 'nadirView', 'shineCol', 'lit', 'fill', 'earthLight', 'fade', 'shadowOn', 'shadowMap', 'shadowMat', 'shadowTexel', 'shadowOffset'];
var AE_CRAFT_HD_DIR = 'craft/';
var AE_CRAFT_HD_PX = 120;                                   // a craft this wide on screen asks for its full model
var AE_CRAFT_HD_ANISO = 4;
var _aeCraftHd = { index: undefined, loading: false };      // index: undefined (not asked), null (none), or the file's models
function _aeCraftHdUrl(name) { return _aeHdBase() + AE_CRAFT_HD_DIR + name; }
function _aeCraftHdTexture(S, name) {
  var THREE = S.THREE;
  return fetch(_aeCraftHdUrl(name)).then(function (r) { if (!r.ok) throw new Error(name); return r.blob(); }).then(function (blob) {
    return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });   // glTF's UVs run from the top
  }).then(function (bmp) {
    var tx = new THREE.Texture(bmp);
    tx.flipY = false; tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.minFilter = THREE.LinearMipmapLinearFilter; tx.anisotropy = AE_CRAFT_HD_ANISO;
    tx.needsUpdate = true;
    return tx;
  });
}
function _aeCraftHdMeshes(I, d2, textures) {
  var S = _ae.gl, THREE = S.THREE, d = I.d;
  var shift = [0, 1, 2].map(function (k) { return d2.mid[k] - d.mid[k]; });   // HD positions are about HD's own box middle: into the stock model's
  for (var i = 0; i < d2.pos.length; i += 3) for (var k = 0; k < 3; k++) d2.pos[i + k] += shift[k];
  var lists = {}, t;
  for (t = 0; t < d2.idx.length; t += 3) (lists[d2.cls[d2.idx[t]]] = lists[d2.cls[d2.idx[t]]] || []).push(d2.idx[t], d2.idx[t + 1], d2.idx[t + 2]);
  var group = new THREE.Group(), pivot = new THREE.Group(), parts = [], turning = false;
  Object.keys(lists).forEach(function (key) {
    var k = +key, look = d2.look[k], maps = { map: look.tex >= 0 ? textures[look.tex] : null, mr: look.mr >= 0 ? textures[look.mr] : null };
    var uni = _aeCraftUniforms(S, { look: [look], radius: d2.radius, metres: d.metres }, I.model);   // each mesh is one material: the palette is its own
    AE_CRAFT_SHARED_UNIFORMS.forEach(function (n) { uni[n] = I.uni[n]; });
    var local = new THREE.Matrix4(), mesh = _aeCraftMesh(S, d2, uni, lists[key], local, 0, maps);
    if (d2.axis && k === d2.turn) { mesh.position.set(-(d2.axis[0] + shift[0]), -(d2.axis[1] + shift[1]), 0); pivot.add(mesh); turning = true; }
    else group.add(mesh);
    parts.push({ mesh: mesh, local: local });
  });
  if (turning) { pivot.position.set(d2.axis[0] + shift[0], d2.axis[1] + shift[1], 0); group.add(pivot); }
  return { group: group, pivot: pivot, parts: parts, turning: turning, shift: shift };
}
function _aeCraftHdBuild(I, d2, textures) {
  var S = _ae.gl, d = I.d, m = _aeCraftHdMeshes(I, d2, textures), group = m.group, pivot = m.pivot, parts = m.parts, turning = m.turning, shift = m.shift;
  I.stock.forEach(function (p) { p.mesh.visible = false; });
  I.root.add(group);
  I.hdGroup = group; I.hdPivot = turning ? pivot : null; I.parts = parts; I.hd = true;
  I.shadowR = Math.max(d.radius, d2.radius + Math.hypot(shift[0], shift[1], shift[2]));
  if (turning) I.pivot = pivot;
  if (_ae) _aeRedraw();
}
// craft/index.json once (null: the HD ZIM is not there, or has no craft). Asked only when the set's list says it carries
// craft (hd.json "craft", scripts/build_almanac_maxi.py): a set without them, or none, asks nothing (it was a 404 on
// every open). Callers wait for the server to say the set is installed (_ae.hdInstalled).
function _aeCraftHdIndexLoad() {
  var H = _aeCraftHd;
  if (H.index !== undefined) return Promise.resolve();
  if (!H.promise) {
    H.promise = (_ae.hdInstalled ? _aeHdManifestOnce() : Promise.resolve(null)).then(function (man) {
      if (!man || !man.craft) return null;
      return fetch(_aeCraftHdUrl('index.json')).then(function (r) { if (!r.ok) throw new Error('hd'); return r.json(); });
    }).then(function (j) { H.index = j && j.models ? j.models : null; }, function () { H.index = null; });
  }
  return H.promise;
}
// A landing site's model with the HD ZIM's full one (almanac-sites-ground.js clones one root for every place the model
// stands and calls this on each clone): the stock meshes stay in the clone, hidden, and the full model is added; the clones
// that were made before the file arrived get it when it does. Without the file nothing changes.
function _aeCraftSiteHd(I, root) {
  var c = I.siteHd = I.siteHd || { roots: [], group: null, state: 0 };
  c.roots.push(root);
  if (c.group) { _aeCraftSiteHdAttach(c, root); return; }
  if (c.state || typeof fetch !== 'function' || !_ae.hdInstalled) return;   // no set (yet): a clone made later asks again
  c.state = 1;
  var S = _ae.gl;
  _aeCraftHdIndexLoad().then(function () {
    var entry = _aeCraftHd.index && _aeCraftHd.index[I.model];
    if (!entry) return null;
    return fetch(_aeCraftHdUrl(entry.file)).then(function (r) { if (!r.ok) throw new Error(I.model); return r.arrayBuffer(); }).then(function (buf) {
      var d2 = _aeCraftParse(buf);
      return Promise.all((d2.textures || []).map(function (name) { return _aeCraftHdTexture(S, name); })).then(function (tx) { return _aeCraftHdMeshes(I, d2, tx).group; });
    });
  }).then(function (group) {
    if (!group) { c.state = 2; return; }
    c.group = group; c.state = 3;
    c.roots.forEach(function (r) { _aeCraftSiteHdAttach(c, r); });
    if (_ae) _aeRedraw();
  }).catch(function () { c.state = 2; });
}
function _aeCraftSiteHdAttach(c, root) {
  root.children.slice().forEach(function (ch) { if (ch.isMesh) ch.visible = false; });
  root.add(c.group.clone());
}
function _aeCraftHdRequest(I, pos) {
  if (AE_CRAFT_HD_ONLY[I.model]) { I.hd = null; return; }   // the pack's own model is the one drawn: there is no fuller one
  if (I.hd !== undefined || I.hdLoading || typeof fetch !== 'function' || !_ae.hdInstalled) return;
  if (_aeCraftPx(I.d.span * I.d.metres / 1000 / AE_EARTH_RADIUS_KM, pos) < AE_CRAFT_HD_PX) return;
  var H = _aeCraftHd;
  if (H.index === undefined) {
    _aeCraftHdIndexLoad().then(function () { if (_ae) _aeRedraw(); });
    return;
  }
  var entry = H.index && H.index[I.model];
  if (!entry) { I.hd = null; return; }
  I.hdLoading = true;
  var S = _ae.gl;
  fetch(_aeCraftHdUrl(entry.file)).then(function (r) { if (!r.ok) throw new Error(I.model); return r.arrayBuffer(); }).then(function (buf) {
    var d2 = _aeCraftParse(buf);
    return Promise.all((d2.textures || []).map(function (name) { return _aeCraftHdTexture(S, name); })).then(function (tx) {
      if (I.root.parent === S.scene) _aeCraftHdBuild(I, d2, tx);
      I.hdLoading = false;
    });
  }).catch(function () { I.hd = null; I.hdLoading = false; });
}
// How wide a craft of span (Earth radii) at pos stands on screen, in CSS px.
function _aeCraftPx(span, pos) {
  var cam = _ae.gl.camera, dist = _aeLen(_aeSub(_aeXyz(cam.position), pos));
  return span / Math.max(dist, 1e-12) * _aePxPerRad(cam);
}
// How much of a probe's dot to draw: none once its model shows (as the last frame placed it).
function _aeProbeCraftDot(key) {
  var I = _ae.gl.crafts && _ae.gl.crafts[key];
  return I && I.root.visible ? 1 - I.show : 1;
}
// Every probe's model, after the camera: where the probe is now and how wide it stands from where the camera is now
// (a probe framed from tens of metres has moved hundreds since the last frame).
function _aePlaceCrafts() {
  if (!_ae.scene) return;
  _ae.gl.camera.updateMatrixWorld();
  _aeCraftHdOnlyJoin();
  for (var key in AE_CRAFT_MODEL) _aeProbeCraftAt(key, _aeCraftPosOf(key));
}
// With the HD pack installed, the probes whose model only it carries take it once its craft index is here (asked for once);
// without the pack they are taken out again (it was removed from Manage).
function _aeCraftHdOnlyJoin() {
  var H = _aeCraftHd, k;
  if (!_ae.hdInstalled) {
    for (k in AE_CRAFT_HD_MODEL) { delete AE_CRAFT_MODEL[k]; var I = _ae.gl && _ae.gl.crafts && _ae.gl.crafts[k]; if (I) I.root.visible = false; }
    if (H.index === null) { H.index = undefined; H.promise = null; H.joinAsked = false; }   // an index that failed or was not there: the next install asks again
    return;
  }
  if (H.index === undefined) {
    if (!H.joinAsked) { H.joinAsked = true; _aeCraftHdIndexLoad().then(function () { if (_ae) _aeRedraw(); }); }
    return;
  }
  for (k in AE_CRAFT_HD_MODEL) { if (H.index && H.index[AE_CRAFT_HD_MODEL[k]]) AE_CRAFT_MODEL[k] = AE_CRAFT_HD_MODEL[k]; else delete AE_CRAFT_MODEL[k]; }
}
// A probe's model at pos, its pointing axis on the Earth (or, Parker and Webb, the Sun) and its long dimension in the
// ecliptic; hidden when it would be under a few px. Returns how much of its dot to draw.
function _aeProbeCraftAt(key, pos) {
  var S = _ae.gl, model = AE_CRAFT_MODEL[key], I = S.crafts && S.crafts[key];
  if (!model || !pos) { if (I) I.root.visible = false; return 1; }
  var span = _aeCraftSpanRe(model);
  var show = span ? _smoothstep(AE_CRAFT_MODEL_PX[0], AE_CRAFT_MODEL_PX[1], _aeCraftPx(span, pos)) : 0;
  if (show > 0 || _ae.target === key) _aeCraftLoad(model);
  if (!_aeCraftData(model)) return 1;
  if (!I || I.root.parent !== S.scene) { S.crafts = S.crafts || {}; I = S.crafts[key] = _aeCraftBuild(S, model); }
  AE_TARGETS[key].min = span * 0.9;
  AE_TARGETS[key].surface = span / 2;
  I.show = show;
  I.root.visible = show > 0;
  if (!I.root.visible) return 1;
  I.root.position.set(pos[0], pos[1], pos[2]);
  var d = _aeCraftData(model), V = S.THREE.Vector3;
  var basis = _aeCraftWorldBasis(model, pos), to = basis[0], side = basis[1], third = basis[2];
  // Model axes (aim, across, aim x across) onto world (to, side, to x side).
  var mA = new S.THREE.Matrix4().makeBasis(new V(d.aim[0], d.aim[1], d.aim[2]), new V(d.across[0], d.across[1], d.across[2]),
    new V(d.aim[0], d.aim[1], d.aim[2]).cross(new V(d.across[0], d.across[1], d.across[2])));
  var mW = new S.THREE.Matrix4().makeBasis(new V(to[0], to[1], to[2]), new V(side[0], side[1], side[2]), new V(third[0], third[1], third[2]));
  I.root.quaternion.setFromRotationMatrix(mW.multiply(mA.transpose()));
  _aeCraftLight(I, pos, AE_CRAFT_POINTS[model] === 'orbit' ? _aeNorm(_aeScale(pos, -1)) : null, show);   // (a craft at the Earth goes dark in its shadow)
  return 1 - show;
}
// The station's place and attitude now, from its SGP4 state; null hides it. Returns how much of its dot to draw.
// How fast the clock takes the station round its orbit, in degrees of it a real second, decides whether the close ride can
// be followed; _ae.issFar ramps toward 1 (the whole orbit) while it cannot and back to 0 while it can. From the clock's
// own rate, not from the frames' gaps: a slow device's uneven frames would tip it back and forth.
// Whether the clock takes the station round its orbit too fast for the close ride to be followed (`was`: it already is, which holds it to a lower bar).
function _aeIssTooFast(pos, was) {
  var r = _aeLen(pos) * AE_EARTH_RADIUS_KM, degPerS = 360 / (2 * Math.PI * Math.sqrt(r * r * r / AE_GM_EARTH_KM3_S2));
  var rate = typeof _almRate === 'number' ? Math.abs(_almRate) : 1;
  return rate * degPerS > (was ? AE_ISS_NEAR_DEG_S : AE_ISS_FAR_DEG_S);
}
function _aeStepIssFar(pos) {
  var now = performance.now(), dt = _ae.issFarAt ? Math.max(0, now - _ae.issFarAt) : 0;
  _ae.issFarAt = now;
  if (_ae.target !== 'iss') { _ae.issFar = 0; _ae.issFast = false; _ae.issWide = 0; return; }
  if (_ae.fly) { _ae.issFar = _ae.issWide ? 1 : 0; _ae.issFast = !!_ae.issWide; return; }   // (a flight out to the orbit lands already pulled out: no second move after it)
  _ae.issFast = _aeIssTooFast(pos, _ae.issFast);
  if (!_ae.issFast) _ae.issWide = 0;
  var to = _ae.issFast ? 1 : 0, step = Math.min(dt, AE_ISS_FAR_STEP_MAX_MS) / AE_ISS_FAR_MS;   // a steady ramp (a stalled frame is not a leap)
  _ae.issFar = _aeReduceMotion() ? to : _ae.issFar < to ? Math.min(to, _ae.issFar + step) : Math.max(to, _ae.issFar - step);
}
// The station view's camera, pulled out toward the whole orbit: first straight out from the station (one steady zoom, on a
// log scale), and only once it stands well clear of the Earth does the point looked at slide to the Earth's middle (earlier,
// the camera would pass through the Earth with it).
function _aeIssFarCam(tp, dist, issPos) {
  if (!(_ae.issFar > 0) || !issPos) return { tp: tp, dist: dist };
  var out = Math.max(dist, _aeFitDist(_aeLen(issPos) * AE_ISS_FAR_FIT)), zoom = _aeSmoother(_ae.issFar);
  var slide = _aeSmoother((_ae.issFar - AE_ISS_FAR_SLIDE_FROM) / (1 - AE_ISS_FAR_SLIDE_FROM));
  return { tp: _aeScale(tp, 1 - slide), dist: Math.exp(Math.log(dist) + (Math.log(out) - Math.log(dist)) * zoom) };
}
function _aeIssAt(st, eqeq, standing) {
  var S = _ae.gl;
  if (!st) {
    _ae.issPos = _ae.issBasis = null;
    _ae.issFar = 0; _ae.issFast = false; _ae.issFarAt = 0;
    if (S.iss) S.iss.root.visible = false;
    return 1;
  }
  var pos = st.pos, vel = _aeRotZ(_aeXyz(st.velKmS), eqeq);
  var lv = _aeLvlh(pos, vel), nadir = lv[0], fwd = lv[1], star = lv[2];
  var prev = _ae.issBasis;
  _aeStepIssFar(pos);
  _ae.issPos = pos; _ae.issBasis = [nadir, fwd, star];
  if (!prev && _ae.linkHeld) setTimeout(_aeLinkResume, 0);   // a link to the station, waiting for it
  // Close by, the camera rides along with the station (its place in the station's own axes held), so the Earth stays
  // below it as it goes round; a drag turns about it as anywhere else. Pulled out to the orbit it keeps its direction
  // in space instead, so the orbit stands still while the station goes round it.
  if (prev && _ae.target === 'iss' && !_ae.fly) {
    var off = _aeCameraOffset(_ae.az, _ae.el_, 1), loc = [_aeDot(off, prev[0]), _aeDot(off, prev[1]), _aeDot(off, prev[2])];
    var held = _aeAdd(_aeAdd(_aeScale(nadir, loc[0]), _aeScale(fwd, loc[1])), _aeScale(star, loc[2])), far = _aeSmoother(_ae.issFar);
    if (far > 0) held = _aeNorm(_aeAdd(_aeScale(held, 1 - far), _aeScale(off, far)));
    // On the way out the camera's line from the station comes to stand still in space while the station goes round, so for part of the way it can point at
    // the Earth, and the camera on it passed through the ground. Until the look has slid to the Earth's middle (the camera far out by then), the line is kept
    // off the Earth: no nearer the way down than the tangent from the station to AE_ISS_FAR_CLEAR_RE.
    if (far > 0 && _ae.issFar < AE_ISS_FAR_SLIDE_FROM) {
      var most = Math.sqrt(Math.max(0, 1 - Math.pow(AE_ISS_FAR_CLEAR_RE / _aeLen(pos), 2))), dn = _aeDot(held, nadir);
      if (dn > most) { var side = _aeSub(held, _aeScale(nadir, dn)); if (_aeLen(side) < 1e-6) side = fwd; held = _aeAdd(_aeScale(nadir, most), _aeScale(_aeNorm(side), Math.sqrt(1 - most * most))); }
    }
    var azel = _aeAzElOf(held);
    _ae.az = azel.az; _ae.el_ = azel.el;
  }
  var show = _smoothstep(AE_CRAFT_MODEL_PX[0], AE_CRAFT_MODEL_PX[1], _aeCraftPx(AE_ISS_SPAN_RE, pos));
  if (show > 0 || _ae.target === 'iss') _aeCraftLoad('iss');
  if (!_aeCraftData('iss')) return 1;
  if (!S.iss || S.iss.root.parent !== S.scene) S.iss = _aeCraftBuild(S, 'iss');
  var I = S.iss;
  I.root.visible = show > 0;
  if (!I.root.visible) return 1;
  I.root.position.set(pos[0], pos[1], pos[2]);
  var m = new S.THREE.Matrix4().makeBasis(new S.THREE.Vector3(nadir[0], nadir[1], nadir[2]),
    new S.THREE.Vector3(fwd[0], fwd[1], fwd[2]), new S.THREE.Vector3(star[0], star[1], star[2]));
  I.root.quaternion.setFromRotationMatrix(m);
  var sun = _aeNorm(_ae.scene.sun), sm = [_aeDot(sun, nadir), _aeDot(sun, fwd)];
  I.pivot.rotation.z = Math.atan2(sm[1], sm[0]);   // the arrays' faces (+x) toward the Sun, about the truss
  _aeCraftLight(I, pos, nadir, show);
  return 1 - show;
}

// Low over the Earth the camera rides the ground: the clock turns the planet at 0.46 km a second, and a place or a map
// held in view would slide away at that speed (the camera is fixed in space, not to the Earth). Far out the spin shows.
var _aeRideGast = null;
function _aeRideGround(gast) {
  var low = _ae.target === 'earth' && !_ae.fly && (_ae.dist - 1) * AE_EARTH_RADIUS_KM < AE_MAPS.startKm;
  if (low && _aeRideGast !== null) _ae.az += ((gast - _aeRideGast + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  _aeRideGast = gast;
}

// A point the person holds (You, or a spot they tapped) stays where it is on the screen while the clock turns its body: the camera
// turns with the body about its spin axis, so the Sun's light crosses the surface and the sky moves, and the held point does not.
// Letting go (You hidden, the tap cleared, a drag, a flight, a ground view) is the ordinary view again.
var _aeLockPrev = null;
function _aeLockedPoint(sc) {
  var pk = _ae.pick, held = null, key = null;
  if (_ae.you && _ae.target === 'earth') { held = { dir: _aeFixedToScene(_aeGeodeticToFixed(_ae.you.lat, _ae.you.lon), sc.gast), axis: [0, 0, 1] }; key = 'you:' + _ae.you.lat + ',' + _ae.you.lon; }
  else if (pk && pk.body === _ae.target && typeof _aeStBodyNow === 'function') {
    var frame = _aeStBodyNow(pk.body);
    if (frame) { held = { dir: _aeStToScene(frame, _aeStPlaceVec(pk.body, pk.lat, pk.lon)), axis: _aeStToScene(frame, [0, 0, 1]) }; key = 'pick:' + pk.body + ',' + pk.lat + ',' + pk.lon; }
  }
  if (!held) { _ae.lockFree = null; return null; }
  if (_ae.drag && _ae.drag.moved) _ae.lockFree = key;   // a drag lets go of it, until the held point is another one (a tap, such as the one that hides the controls, does not)
  if (_ae.lockFree && _ae.lockFree !== key) _ae.lockFree = null;
  if (_ae.lockFree === key || _ae.fly || _ae.hand || _ae.site || _ae.stand) return null;
  held.key = key;
  return held;
}
function _aeRideLock(sc) {
  var pt = _aeLockedPoint(sc), prev = _aeLockPrev;
  _aeLockPrev = pt ? { dir: _aeNorm(pt.dir), axis: _aeNorm(pt.axis), key: pt.key } : null;
  if (!pt) return false;
  if (!prev || prev.key !== _aeLockPrev.key) return true;
  var a = _aeLockPrev.axis, d0 = prev.dir, d1 = _aeLockPrev.dir;
  var p0 = _aeSub(d0, _aeScale(a, _aeDot(a, d0))), p1 = _aeSub(d1, _aeScale(a, _aeDot(a, d1)));
  var ang = Math.atan2(_aeDot(a, _aeCross(p0, p1)), _aeDot(p0, p1));
  if (!isFinite(ang) || ang === 0) return true;
  var off = _aeCameraOffset(_ae.az, _ae.el_, 1), c = Math.cos(ang), sn = Math.sin(ang);   // Rodrigues: the offset turned by ang about the axis
  var rot = _aeAdd(_aeAdd(_aeScale(off, c), _aeScale(_aeCross(a, off), sn)), _aeScale(a, _aeDot(a, off) * (1 - c)));
  var azel = _aeAzElOf(rot);
  _ae.az = azel.az; _ae.el_ = azel.el;
  return true;
}

// A visit whose ground is on screen draws that ground, not the orbit scene: what only the orbit picture shows (the Sun's surface, the Moon's path, the
// satellites, launches, the axes) is not worked out for it.
function _aeGroundDrawn() {
  var site = _ae.site, h = site && site.host;
  return !!(h && h.live && site.pose && site.fr && site.group);
}
function _aeUpdate(ms) {
  var S = _ae.gl, grounded = _aeGroundDrawn();
  var sc = _aeSceneAt(ms);
  _ae.scene = sc;
  S.earth.rotation.z = sc.gast;
  if (!_aeRideLock(sc)) _aeRideGround(sc.gast); else _aeRideGast = sc.gast;
  S.shared.sunPos.value.set(sc.sun[0], sc.sun[1], sc.sun[2]);
  S.earthUni.moonPos.value.set(sc.moon[0], sc.moon[1], sc.moon[2]);
  S.earthUni.dim.value = _aeRedOn() ? AE_RED_EARTH_LIGHT : 1;
  // The Moon's phase angle, Sun-Moon-Earth, sets the earthshine.
  S.moonUni.earthshine.value = _moonEarthshine(_aeDot(_aeNorm(_aeSub(sc.sun, sc.moon)), _aeNorm(_aeScale(sc.moon, -1))));
  _aeOrientMoon(sc);
  _aeMoonMesh(S, sc);
  _aePlanetFine(S);
  var sd = _aeSunShown(sc);
  S.sun.position.set(sd[0], sd[1], sd[2]);
  S.sunGlowUni.center.value.set(sd[0], sd[1], sd[2]);
  S.sunT.value = (ms / 1000 / AE_GRANULE_LIFE_S) % AE_GRANULE_CYCLE;
  if (!grounded) {
    _aeUpdateSpots(S, ms);
    _aeSunFxWanted(S, ms);
    _aeSunRatio(S);
    _aeMoonHiWanted(S);
    _aeUpdateMoonPath(ms);
    _aeUpdateSats(ms, sc);
    if (typeof _asSatFrame === 'function') _asSatFrame(ms, sc);   // every active satellite (almanac-sats.js)
  }
  // The planets and probes before the camera: a probe framed from tens of metres moves hundreds in a frame (Voyager
  // 17 km/s), so the camera is placed on where it is now, not where it was (their sizes on screen use the last frame's
  // camera, which is near enough).
  _aeUpdatePlanets(sc);
  _aeRowLitSoon();   // the row's worlds follow the date, a few times a second at most
  if (_ae.site) _aeSiteStep(sc);   // standing on a landing site (almanac-sites.js): its frame and camera, before the camera is placed
  if (_ae.ship) _aeShipStep(sc);   // the ship (almanac-fly.js): its flight and camera, before the camera is placed
  else if (_ae.shipParked) _aeShipWake(sc);   // parked while another mode had the camera: it flies again once the view is the plain one
  if (_ae.mission) _aeMissionStep(sc);   // a mission being flown (almanac-missions.js): its vehicles and shot, before the camera is placed
  _aePlaceCamera();
  _aePlaceCrafts();
  if (_ae.site) _aeSiteLight(sc);
  if (_ae.mission) _aeMissionDraw();
  if (_ae.ship) _aeShipDraw();
  if (!grounded) _aeDrawAxes(S, sc);
}

function _aeResize() {
  if (!_ae || !_ae.gl) return;
  var el = _ae.el, S = _ae.gl;
  var w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  // Kept for the per-frame projections: reading clientWidth there, after the
  // labels' style writes, forced a layout for every label, every frame.
  _ae.w = w; _ae.h = h;
  _aeHudRender();   // (the corner's row and stack follow the width)
  _aeMeasureFoot();
  _aeMeasureTop();
  if (!_ae.infoShift) _ae.infoShift = _aeInfoShiftTarget();
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / h;
  S.camera.updateProjectionMatrix();
  _aeRedraw();
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
function _aeBehindEarth(p) { return _aeBehindSphere(p, [0, 0, 0], 1); }
// Whether the line from the camera to p passes through a sphere first.
function _aeBehindSphere(p, centre, r) {
  var c = _ae.gl.camera.position, o = [c.x - centre[0], c.y - centre[1], c.z - centre[2]];
  var d = _aeSub(_aeSub(p, centre), o), len = _aeLen(d);
  d = _aeScale(d, 1 / len);
  var b = _aeDot(o, d), cc = _aeDot(o, o) - r * r, disc = b * b - cc;
  if (disc < 0) return false;
  var tHit = -b - Math.sqrt(disc);
  return tHit > 0 && tHit < len - 1e-3 * r;
}
// Behind the body in view: a planet, a moon, the Moon or the Sun (Callisto was named on the Moon's face close up).
function _aeBehindTarget(body, p) {
  var t = _ae.target, tg = AE_TARGETS[t];
  if (body === t || !tg || t === 'iss' || _aeIsCraft(t)) return false;
  return _aeBehindSphere(p, _aeTargetPos(), tg.surface);
}
// Behind any nearer body: the Sun, the Earth, the Moon, a planet or a moon (as drawn now). Nothing is drawn through a
// nearer disc: a planet through the Sun, a moon through its planet; their marks and names follow the same rule.
// `marks`: for a mark, also behind a nearer body's painted disc (a body too small to see is painted larger than
// itself, and the Sun in the Planets view on the planets' scale).
// Geometric, never "A is behind B": a nearer body hides a farther one only where its disc covers it, and a smaller
// body never hides a bigger one (Io in front of Jupiter's middle hides nothing of Jupiter: its sphere is drawn by the
// depth buffer and its name stays).
function _aeBehindAny(body, p, marks) {
  var cam = _ae.gl.camera, c = cam.position, eye = _aeXyz(c), d = _aeLen(_aeSub(p, eye));
  var pxPerRad = _aePxPerRad(cam), sp = marks ? _aeProject(p) : null;
  var rFar = (AE_TARGETS[body] ? AE_TARGETS[body].surface : 0) / Math.max(1e-9, d) * pxPerRad;
  for (var i = 0; i < AE_MARKED.length; i++) {
    var k = AE_MARKED[i].body;
    if (k === body || k === 'iss' || _aeIsProbe(k) || !AE_TARGETS[k]) continue;
    var q = _aeBodyPos(k), dq = q ? _aeLen(_aeSub(q, eye)) : Infinity;
    if (dq >= d) continue;
    var rq = AE_TARGETS[k].surface / Math.max(1e-9, dq) * pxPerRad;
    if (rq >= rFar && _aeBehindSphere(p, q, AE_TARGETS[k].surface)) return true;
    if (!sp) continue;
    var sq = _aeProject(q);
    // A painted disc hides only what is painted no bigger: Io's speck never hides Jupiter, the planet wins.
    var painted = k === 'sun' ? (_aeSunAsMark() ? _aeMarkDiscR('sun') : 0) : rq < AE_MARK_GONE_PX / 2 && _aeMarkDiscR(k) >= _aeMarkDiscR(body) ? _aeMarkDiscR(k) : 0;
    if (sq && Math.hypot(sq.x - sp.x, sq.y - sp.y) < Math.max(rq >= rFar ? rq : 0, painted)) return true;
  }
  return false;
}
// A body and its own: a planet and its moons, the Earth and the Moon.
function _aeGroupOf(key) {
  var b = _aePlanetBody(key);
  if (b) return b.parent || b.key;
  return key === 'moon' || key === 'iss' || _aeIsOrbiter(key) ? 'earth' : key;
}
// Close in, the body in view fills the picture: only it and its own are named (a far planet's dot in the corner
// read as something on its surface).
var AE_CLOSE_FILL = 1;   // the body in view this many screen widths across (the narrower side) is close in
function _aeCloseIn(eye, pxPerRad) {
  var t = _ae.target, tg = AE_TARGETS[t];
  if (!tg || t === 'iss' || _aeIsCraft(t)) return false;
  var px = 2 * tg.surface / Math.max(1e-9, _aeLen(_aeSub(_aeTargetPos(), eye))) * pxPerRad;
  return px >= AE_CLOSE_FILL * Math.min(_ae.w, _ae.h);
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
  var toLeft = _aeNameOutLeft(el, s.x);
  el.style.textAlign = toLeft ? 'right' : 'left';
  el.classList.toggle('ae-hang-left', toLeft);   // where a place label's dot goes (.ae-mark)
  el.style.transform = 'translate(' + Math.round(s.x) + 'px,' + Math.round(s.y) + 'px) translate(' +
    (toLeft ? 'calc(-100% - ' + AE_LABEL_DX + 'px)' : AE_LABEL_DX + 'px') + ',-50%)';
}
function _aeSetText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

function _aeUpdateLabels() {
  var sc = _ae.scene;
  if (!sc || (_ae.site && _ae.site.pose) || _ae.mission) return;   // on the ground, or in a mission, the labels are not drawn
  _aeUpdateMarks(sc);
  _aeUpdateLandmarks();
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
    var html = _almEsc(_aeT('alm_earth_iss_short'));   // just its name: how old its data is lives in the status line and its sheet
    if (issEl._aeHtml !== html) { issEl.innerHTML = html; issEl._aeHtml = html; }
    issEl.classList.toggle('ae-faded', approx);
  }
  // Not while the Earth is a small ringed disc (the ISS is a speck on it, and its label would sit on the Earth's), nor
  // through a flight between bodies, whose two names are the only words.
  var issNear = !!(_ae.gl.iss && _ae.gl.iss.root.visible);   // the station itself is drawn: no name on it
  _aePlaceLabel('ae-lbl-iss', iss && iss.p.pos, !!iss && !_ae.fly && !issNear && !_aeBehindEarth(iss.p.pos) && _aeEarthPx() >= 2 * AE_MARK_GONE_PX);
  // You: only where the device says it is, once the person asked
  // (_aeLocateMe). A guess, from the time zone or a city picked for the
  // Almanac, drew "You" far from anyone (Eric).
  var you = _ae.you ? _aeFixedToScene(_aeGeodeticToFixed(_ae.you.lat, _ae.you.lon), sc.gast) : null;
  _aePlaceLabel('ae-lbl-you', you, !!you && !_ae.pick && _aeFacing(you) && _ae.target === 'earth');   // a tapped spot replaces You as the marker
  // The place picked in Go to: its name at its spot.
  var pl = _ae.place ? _aeFixedToScene(_aeGeodeticToFixed(_ae.place.lat, _ae.place.lon), sc.gast) : null;
  if (pl) _aeSetText(_aeById('ae-lbl-place-text'), _ae.place.name);
  _aePlaceLabel('ae-lbl-place', pl, !!pl && _aeFacing(pl) && _ae.target === 'earth');
  var ecl = _ae.eclipse;
  var sh = ecl && ecl.solar && ecl.hit ? _aeFixedToScene(_aeGeodeticToFixed(ecl.hit.lat, ecl.hit.lon), sc.gast) : null;
  _aePlaceLabel('ae-lbl-shadow', sh, !!sh && _aeFacing(sh) && _ae.target === 'earth');
}

// A body drawn small is ringed and named, so it can be found: the mark is full under AE_MARK_SMALL_PX across and
// gone by AE_MARK_GONE_PX. The flight's destination is always marked while it is small, even behind the Earth.
// How wide the Earth is drawn, in CSS pixels.
function _aeEarthPx() {
  var cam = _ae.gl.camera, d = Math.max(1e-9, _aeLen(_aeXyz(cam.position)));
  return 2 / d * _aePxPerRad(cam);
}
// The controls at the top (the way back, the date and Live, the gear, the minimap): boxes in the view's own px, kept with
// the foot's height, so no mark or name sits under them.
// ── The minimap ──
// Everywhere but the Planets view itself (where it would be the view twice), a corner disc shows the whole system from
// above the ecliptic: every orbit, every planet as the 2D orrery draws it (its painters, almanac-orrery.js), and you,
// an arrow where the camera is, pointing the way it looks; at the Earth or the Moon, the arrow on the Earth.
var AE_MINI_FILL = 0.46, AE_MINI_SHIP_PX = 6, AE_MINI_ORBIT_ALPHA = 0.28;
function _aeMiniShown() {
  return !!(_ae.gl && _ae.gl.ecl) && _ae.preset !== 'planets' && !(typeof _asBarAcross === 'function' && _asBarAcross()) && !_ae.hand && !_ae.spin && !_ae.stand && !_ae.standPending && !_ae.site && !_ae.mission && !(window.matchMedia && matchMedia('(max-width:759px)').matches && Object.keys(AE_SHEETS).some(function (k) { return AE_SHEETS[k].up(); }));   // a sheet lifts it away on a phone
}
function _aeDrawMini() {
  var btn = _aeById('ae-mini'), on = _aeMiniShown() && typeof _orreryPaintPlanets === 'function';
  if (!btn) return;
  if (btn.hidden === on) btn.hidden = !on;
  if (!on) return;
  var S = _ae.gl, e = S.ecl, cv = _aeById('ae-mini-c'), dpr = S.dpr, size = AE_MINI_PX * dpr;
  if (cv.width !== size) { cv.width = cv.height = size; }
  var g = cv.getContext('2d'), half = size / 2, W = size * AE_MINI_FILL / _solarSqueeze(AE_PLANETS_OUTER_AU);
  var jd = _ae.scene.ms / MS_PER_DAY + JD_UNIX_EPOCH;
  var names = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  // The orrery's own picture of the system (its painters), at this size: one drawing for both.
  g.clearRect(0, 0, size, size);
  _orreryPaintOrbits(g, half, half, W, _jdToJulianCentury(jd), dpr, names, AE_MINI_ORBIT_ALPHA);
  // The Sun on the minimap's planets' own scale: as much bigger than Jupiter as the marks' gentle log makes it.
  if (!_ae.miniSun || _ae.miniSun.size !== size) {   // worked out once per size: Jupiter's disc there, off screen
    var jup = _orreryPaintPlanets(document.createElement('canvas').getContext('2d'), half, half, W, _jdToJulianCentury(jd), 0, dpr, dpr, ['Jupiter'], { plain: true })[0];
    _ae.miniSun = { size: size, r: jup ? jup.r * dpr * _aeMarkDiscR('sun') / _aeMarkDiscR('jupiter') : 0 };
  }
  _orreryPaintSun(g, half, half, W, _ae.miniSun.r);
  var placed = _orreryPaintPlanets(g, half, half, W, _jdToJulianCentury(jd), 0, dpr, dpr, names, { plain: true });
  var ringed = _ae.target === 'moon' || _ae.target === 'iss' ? 'earth' : _aeHostOf(_ae.target);   // the planet whose system you are in
  placed.forEach(function (r) {
    if (r.name.toLowerCase() !== ringed) return;
    g.strokeStyle = AE_AMBER_HEX; g.lineWidth = dpr;
    g.beginPath(); g.arc(r.x * dpr, r.y * dpr, r.r * dpr + 2.5 * dpr, 0, 2 * Math.PI); g.stroke();
  });
  // You: the camera's place on the ecliptic, at the same squeeze, and the way it faces.
  var cam = S.camera, d = _aeSub(_aeXyz(cam.position), e.sun), y = _aeCross(e.z, e.x);
  var px = _aeDot(d, e.x), py = _aeDot(d, y), dist = Math.hypot(px, py);
  var vis = Math.min(half * 0.98, dist / AE_SUN_SHOW_DIST * _solarSqueeze(1) * W);
  var c0 = [half + (dist ? px / dist * vis : 0), half - (dist ? py / dist * vis : 0)];
  var f = cam.getWorldDirection(new S.THREE.Vector3()), fv = _aeXyz(f);
  var a = Math.atan2(-_aeDot(fv, y), _aeDot(fv, e.x)), L = AE_MINI_SHIP_PX * dpr;
  g.save();
  g.translate(c0[0], c0[1]); g.rotate(a);
  g.fillStyle = AE_PROBE_HEX;
  g.beginPath(); g.moveTo(L, 0); g.lineTo(-L * 0.7, L * 0.6); g.lineTo(-L * 0.35, 0); g.lineTo(-L * 0.7, -L * 0.6); g.closePath(); g.fill();
  g.restore();
}


var AE_TOP_CONTROLS = ['ae-pin', 'ae-gear', 'ae-lm-btn', 'ae-orbits-btn', 'ae-sats-btn', 'ae-fly-btn', 'ae-locate', 'ae-info-btn', 'ae-hint'], AE_TOP_CLEAR_PX = 10;   // the hint too while it shows: no mark under its words
function _aeMeasureTop() {
  var el = _ae.el;
  if (!el || !el.getBoundingClientRect) { _ae.topBoxes = []; return; }
  var o = el.getBoundingClientRect();
  _ae.topBoxes = AE_TOP_CONTROLS.map(function (id) {
    var c = _aeById(id);
    if (!c || c.hidden || !c.getBoundingClientRect || (id === 'ae-hint' && !c.classList.contains('ae-show'))) return null;
    var r = c.getBoundingClientRect();
    return r.width ? [r.left - o.left - AE_TOP_CLEAR_PX, r.top - o.top - AE_TOP_CLEAR_PX, r.right - o.left + AE_TOP_CLEAR_PX, r.bottom - o.top + AE_TOP_CLEAR_PX] : null;
  }).filter(Boolean);
}
function _aeUnderTop(s) {
  return (_ae.topBoxes || []).some(function (b) { return s.x >= b[0] && s.x <= b[2] && s.y >= b[1] && s.y <= b[3]; });
}
function _aeUpdateMarks(sc) {
  var cam = _ae.gl.camera, eye = _aeXyz(cam.position);
  var pxPerRad = _aePxPerRad(cam);
  var pos = {}, shown = [];
  AE_MARKED.forEach(function (m) { pos[m.body] = _aeBodyPos(m.body, sc); });
  // The destination first, so a body standing on top of it (the Moon from the Sun) gives way.
  var f = _ae.fly, flying = !!f && (f.hold || f.straight), source = flying ? f.from.target : null;   // (the straight zoom from the Earth to the station is a flight too: the station is marked on the way, its dot there until the model is)
  var ringFade = flying ? 1 - _smoothstep(AE_RING_FADE_FROM, 1, _aeFlyArrival(f, performance.now())) : 1;
  var rank = function (b) { return b === _ae.target ? 2 : flying && b === source ? 1 : 0; };
  var order = AE_MARKED.slice().sort(function (a, b) { return rank(b.body) - rank(a.body); });
  var close = !flying && _aeCloseIn(eye, pxPerRad), group = _aeGroupOf(_ae.target), wide = _aeWideView();
  var home = !wide && group === 'earth';
  for (var i = 0; i < order.length; i++) {
    var body = order[i].body, el = _aeById('ae-bm-' + body);
    if (!el) continue;
    var dest = !!_ae.fly && body === _ae.target, ringed = flying && (dest || body === source);
    if (close && _aeGroupOf(body) !== group) { if (!el.hidden) el.hidden = true; continue; }
    // The Planets view: the planets named, the probes and the dwarf planets points without names, the moons (on their
    // planets at that scale) not drawn.
    var bb = _aePlanetBody(body);
    if (wide && bb && bb.parent && !ringed) { if (!el.hidden) el.hidden = true; continue; }
    // At home (the Earth, the Moon, the station) only the Earth and the Moon are named: another planet is a faint point,
    // its moons not drawn, a probe a point.
    if (bb && bb.parent && !ringed && !wide && _aeGroupOf(body) !== group) { if (!el.hidden) el.hidden = true; continue; }   // a moon is named only in its own planet's view (Callisto is not named beside Mars)
    var away = home && !ringed && _aeGroupOf(body) !== 'earth';
    if (away && bb && bb.parent) { if (!el.hidden) el.hidden = true; continue; }
    var quiet = away || (wide && !ringed && !(bb && !bb.parent && !bb.track) && body !== 'earth');
    if (el.classList) el.classList.toggle('ae-bm-quiet', quiet);
    if (!ringed && el.classList) el.classList.remove('ae-bm-ringed');   // a flight's ring goes with it, shown or not
    if (!pos[body] || (order[i].flightOnly && !ringed)) { if (!el.hidden) el.hidden = true; continue; }
    // A probe is a point: its mark stays on it in view (a body in view is its own picture and needs none).
    var s = (_ae.target === 'iss' && !ringed) || (body === _ae.target && !dest && !_aeIsProbe(body)) || (!dest && !ringed && _aeBehindAny(body, pos[body], true)) ? null : _aeProject(pos[body]);
    var px = 2 * AE_TARGETS[body].surface / Math.max(1e-9, _aeLen(_aeSub(pos[body], eye))) * pxPerRad;
    var alpha = ringed ? ringFade : _aeClamp((AE_MARK_GONE_PX - px) / (AE_MARK_GONE_PX - AE_MARK_SMALL_PX), 0, 1);
    // The name stands off the body's drawn disc (or, in a flight, off the body itself as the view shows it).
    var r = ringed ? Math.max(AE_RING_MIN_R_PX, px / 2 + AE_RING_MARGIN_PX) : _aeMarkDiscR(body) + AE_MARK_NAME_PAD;
    if (r > Math.max(_ae.w, _ae.h)) alpha = 0;
    var crowded = !!s && !(wide && _aeNamedPlanet(body)) && shown.some(function (o) { return Math.hypot(o.x - s.x, o.y - s.y) < AE_MARK_SAME_PX; });
    // A ringed body counts while any of its ring is on screen: the old body at the edge of the shot, its night side dark.
    var reach = ringed ? r : 0;
    // Not under the controls at the foot: a mark there could not be tapped and would sit on their words.
    var foot = _ae.h - (_ae.footPx || 0);
    var gone = !s || crowded || alpha <= 0 || s.x < -reach || s.y < -reach || s.x > _ae.w + reach || s.y > (ringed ? _ae.h + reach : foot) || (!ringed && _aeUnderTop(s));
    // A ring eases in and out (the camera swings round the corner of the approach and carries it across the screen's edge in a frame or two):
    // one that has just left fades where it was.
    if (ringed && alpha > 0) {
      var op = _aeRingEase(el, gone ? 0 : 1);
      if (gone && op > 0.02) { el.hidden = false; el.style.opacity = (alpha * op).toFixed(2); continue; }
      alpha *= op;
    }
    if (gone) { if (!el.hidden) el.hidden = true; continue; }
    if (!ringed) el._aeEaseAt = 0;
    if (away) alpha *= AE_MARK_AWAY_ALPHA;
    var fade = _aeRingHandoff(el, ringed);
    if (!ringed) alpha *= fade;
    shown.push({ x: s.x, y: s.y, r: r, el: el, ringed: ringed, body: body, px: px, fade: fade });
    if (el.hidden) el.hidden = false;
    el.style.opacity = alpha.toFixed(2);
    el.style.setProperty('--ae-r', r.toFixed(1) + 'px');
    el.style.transform = 'translate(' + Math.round(s.x) + 'px,' + Math.round(s.y) + 'px)';
    if (el.classList) el.classList.toggle('ae-bm-ringed', ringed);
  }
  var kept = _aeClusterMarks(shown);
  _aePlaceMarkNames(kept);
  _aePaintMarks(kept);
}
// The marks' bodies: each planet as the orrery draws it (_orreryPaintPlanet), sized by a gentle log of its true size
// so Jupiter reads bigger than Mercury; a moon or a dwarf a small shaded disc of its colour; a probe a bright point
// with a tick the way it is heading; a crowd every member's disc where it is, overlapping. Not the Sun (the view draws
// it) and not a body the view shows big enough to see (in a flight).
var AE_MARK_DISC = [2.4, 7], AE_MARK_KM = [1188, 71492], AE_MARK_NAME_PAD = 3;
var AE_MARK_AWAY_ALPHA = 0.55;   // a planet seen from home: a faint point
var AE_PROBE_DOT_PX = 1.6, AE_PROBE_TICK_PX = 7;
function _aeMarkDiscR(body) {
  if (_aeIsProbe(body)) return AE_PROBE_DOT_PX;
  var b = _aePlanetBody(body), km = b ? b.km : body === 'earth' ? AE_EARTH_RADIUS_KM : body === 'moon' ? AE_MOON_RADIUS_KM : body === 'sun' ? AE_SUN_RADIUS_KM : 0;
  if (!km) return AE_MARK_DISC[1];
  // The same gentle log for every body: the Sun carries on past Jupiter on it (not clamped to the planets' range).
  var t = Math.max(0, Math.log(km / AE_MARK_KM[0]) / Math.log(AE_MARK_KM[1] / AE_MARK_KM[0]));
  if (body !== 'sun') t = Math.min(1, t);
  return AE_MARK_DISC[0] + (AE_MARK_DISC[1] - AE_MARK_DISC[0]) * t;
}
// The Sun is painted as a mark while the view's own Sun is smaller than that disc would be (the Planets view, and
// the Sun from far off); close to it the view's own Sun is the picture.
function _aeSunAsMark() {
  if (!_aeWideView() || !_ae.scene || !_ae.gl) return false;
  var cam = _ae.gl.camera, pxPerRad = _aePxPerRad(cam);
  var d = _aeLen(_aeSub(_aeSunShown(_ae.scene), _aeXyz(cam.position)));
  return AE_SUN_SHOW_R / Math.max(1e-9, d) * pxPerRad < _aeMarkDiscR('sun');
}
// How much of a mark's disc shows (0..1): it stands in for a body only as the body's own picture shrinks under the disc,
// fading in as it goes from the disc's width down to its radius. Before, it covered a body tens of pixels across with a flat dot
// ("we shouldn't be swapping objects out"). A probe is a point and keeps its disc.
function _aeDiscStandIn(m) {
  if (_aeIsProbe(m.body)) return 1;
  var r = _aeMarkDiscR(m.body);
  return _aeClamp((2 * r - m.px) / r, 0, 1);
}
function _aePaintMarks(kept) {
  var cv = _aeById('ae-marks-c');
  if (!cv || !cv.getContext) return;
  var dpr = _ae.gl.dpr, w = Math.round(_ae.w * dpr), h = Math.round(_ae.h * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  var g = cv.getContext('2d'), sun = _ae.scene ? _aeProject(_aeSunShown(_ae.scene)) : null;
  if (sun && !(isFinite(sun.x) && isFinite(sun.y))) sun = null;
  g.clearRect(0, 0, w, h);
  _ae.marksDrawn = [];   // what is on the screen (CSS px): the tests read it
  // The Planets view: the Sun as a disc on the planets' scale (the gentle log of true size), not the view's own speck.
  if (_aeSunAsMark() && sun && typeof _orreryPaintSun === 'function') {
    var sr = _aeMarkDiscR('sun');
    _orreryPaintSun(g, sun.x * dpr, sun.y * dpr, 0, sr * dpr);
    _ae.marksDrawn.push({ body: 'sun', x: sun.x, y: sun.y, r: sr, lead: 'sun', el: '' });
  }
  kept.forEach(function (m) {
    m.pts.forEach(function (q) { _ae.marksDrawn.push({ body: q.body, x: q.x, y: q.y, r: _aeMarkDiscR(q.body), lead: m.body, el: m.el.id }); });
    if (m.ringed) return;
    if (m.leader) {   // a name set off from its dot: a short line back to it
      g.strokeStyle = 'rgba(223,230,240,0.55)'; g.lineWidth = dpr;
      g.beginPath(); g.moveTo(m.leader[0] * dpr, m.leader[1] * dpr); g.lineTo(m.leader[2] * dpr, m.leader[3] * dpr); g.stroke();
    }
    var base = m.el.classList && m.el.classList.contains('ae-bm-quiet') ? Math.min(1, parseFloat(m.el.style.opacity) || 1) : 1;   // faint: away from home
    m.pts.forEach(function (q) {
      var x = q.x * dpr, y = q.y * dpr, r = _aeMarkDiscR(q.body) * dpr, b = _aePlanetBody(q.body);
      if (!isFinite(x) || !isFinite(y)) return;
      if (q.body === 'sun') return;   // the view's own, or painted below in the Planets view
      var stand = _aeDiscStandIn(q);
      if (stand <= 0) return;   // its own picture is wider than the disc would be: no stand-in
      g.globalAlpha = base * stand * (m.fade == null ? 1 : m.fade);
      if (_aeIsProbe(q.body)) {
        g.fillStyle = AE_PROBE_HEX;
        g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill();
        var v = _aeProbeHeading[q.body], tip = v ? _aeProject(_aeAdd(_aeProbePos[q.body], v)) : null;
        if (tip) {
          var dx = tip.x - q.x, dy = tip.y - q.y, l = Math.hypot(dx, dy) || 1;
          g.strokeStyle = 'rgba(110,231,216,0.8)'; g.lineWidth = dpr;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx / l * AE_PROBE_TICK_PX * dpr, y + dy / l * AE_PROBE_TICK_PX * dpr); g.stroke();
        }
        return;
      }
      var name = q.body === 'earth' ? 'Earth' : b && !b.parent ? b.eph : null;
      if (name && typeof _orreryPaintPlanet === 'function' && typeof _PLANETS !== 'undefined' && _PLANETS[name]) {
        _orreryPaintPlanet(g, name, x, y, r, sun ? sun.x * dpr : x, sun ? sun.y * dpr : y - 1, dpr, dpr, { plain: true });
        return;
      }
      var col = b ? b.color : [0.78, 0.78, 0.78];
      var gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
      gr.addColorStop(0, 'rgb(' + col.map(function (c) { return Math.round(Math.min(1, c * 1.25) * 255); }).join(',') + ')');
      gr.addColorStop(1, 'rgb(' + col.map(function (c) { return Math.round(c * 0.45 * 255); }).join(',') + ')');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill();
    });
  });
  g.globalAlpha = 1;
}
// Each mark stands for itself (its own disc, its own name). The Planets view had crowds ("Earth +2") for marks whose
// rings met; it names the planets only now, so there is nothing to gather.
function _aeClusterMarks(shown) {
  shown.forEach(function (m) { m.members = [m.body]; m.pts = [m]; });
  return shown;
}
// Each shown mark's name, beside its ring where it covers no other ring and no name already placed: the side away from
// the middle first, then the other, then above, then below; with nowhere free the ring goes unnamed (a tap still
// flies there). In a flight the two bodies' names sit over their rings, so the pair's names never meet.
var AE_NAME_SIDES = ['out', 'in', 't', 'b', 'tout', 'bout', 'tin', 'bin'];
var AE_NAME_GAP = 7, AE_NAME_H = 16, AE_NAME_CHAR_PX = 6.6, AE_NAME_EDGE = 6;   // a name keeps this far in from the screen's sides
// Above or below, a name is centred on its ring, slid sideways to stay on the screen (dx, read by the CSS as --ae-nx).
function _aeNameBox(m, side, w) {
  var r = m.r, h = AE_NAME_H;
  if (side === 't' || side === 'b') {
    var x0 = _aeClamp(m.x - w / 2, AE_NAME_EDGE, Math.max(AE_NAME_EDGE, _ae.w - w - AE_NAME_EDGE)), y0 = side === 't' ? m.y - r - 4 - h : m.y + r + 4;
    var box = [x0, y0, x0 + w, y0 + h];
    box.dx = x0 - (m.x - w / 2);
    return box;
  }
  if (side.length === 2) {   // a corner: tr, tl, br, bl
    var dx = r * AE_NAME_DIAG + 2, dy = r * AE_NAME_DIAG + 2, rx = side[1] === 'r';
    var cx0 = rx ? m.x + dx : m.x - dx - w, cy0 = side[0] === 't' ? m.y - dy - h : m.y + dy;
    return [cx0, cy0, cx0 + w, cy0 + h];
  }
  var left = side === 'l';
  return left ? [m.x - r - AE_NAME_GAP - w, m.y - h / 2, m.x - r - AE_NAME_GAP, m.y + h / 2] : [m.x + r + AE_NAME_GAP, m.y - h / 2, m.x + r + AE_NAME_GAP + w, m.y + h / 2];
}
function _aeBoxesMeet(a, b) { return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }
// A name belongs to its own body: no other body's centre is as near to it as its own (a name beside Venus's dot read as
// Mercury's). Where nothing near enough is free, it goes unnamed rather than land beside another body.
var AE_NAME_TIE_PX = 3, AE_NAME_TIE_WIDE_PX = 4, AE_NAME_TIE_WIDE_RATIO = 2;   // another body's centre must be this much farther (px, and times the own dot's distance)
function _aeBoxDist(box, x, y) { return Math.hypot(Math.max(box[0] - x, 0, x - box[2]), Math.max(box[1] - y, 0, y - box[3])); }
function _aeNameIsItsOwn(box, m, rings, margin, ratio) {
  var own = _aeBoxDist(box, m.x, m.y);
  return rings.every(function (rb) { return rb.x === m.x && rb.y === m.y || _aeBoxDist(box, rb.x, rb.y) > own * (ratio || 1) + margin; });
}
// The Planets view names the eight planets, always: "it's just the planets labeled". A planet's name tries the slots
// round its own dot (right, left, above, below, the four diagonals) for the first that covers no name, no disc and not
// the Sun and where its own dot is the nearest by a clear margin; failing that, the same slots further out with a short
// leader line back to the dot; failing that, a slot that only keeps clear of other names. It is never dropped. The
// smaller bodies (dwarfs, probes) carry no names and drop first (their marks are only obstacles).
var AE_LEADER_STEPS = [14, 26, 40, 60];   // how far past the disc a name on a leader stands (px)
function _aeNamedPlanet(body) {
  var b = _aePlanetBody(body);
  return body === 'earth' || (!!b && !b.parent && !b.track);
}
// The slots for a name: {side, box, leader}, nearest first; a leader slot's box stands off the dot by a step.
function _aeNameSlots(m, w, sides, wideNamed) {
  var slots = sides.map(function (sd) { return { side: sd, box: _aeNameBox(m, sd, w), leader: false }; });
  if (wideNamed) AE_LEADER_STEPS.forEach(function (step) {
    sides.forEach(function (sd) { slots.push({ side: sd, box: _aeNameBox({ x: m.x, y: m.y, r: m.r + step }, sd, w), leader: true }); });
  });
  return slots;
}
// How near the leader from a dot to its name comes to any other body's centre (px): a line through Venus read as
// Venus's. The line is the one drawn, from the dot's edge, so a probe beside the dot does not bar every way out of it.
var AE_LEADER_CLEAR_PX = 6;   // px between a leader and the edge of any other body's disc
function _aeLeaderClearance(m, box, rings) {
  var seg = _aeLeaderSeg(m, box), dx = seg[2] - seg[0], dy = seg[3] - seg[1], len2 = dx * dx + dy * dy || 1, near = Infinity;
  rings.forEach(function (rb) {
    if (rb.x === m.x && rb.y === m.y) return;
    var t = Math.min(1, Math.max(0, ((rb.x - seg[0]) * dx + (rb.y - seg[1]) * dy) / len2));
    near = Math.min(near, Math.hypot(seg[0] + t * dx - rb.x, seg[1] + t * dy - rb.y) - (rb.r || 0));
  });
  return near;
}
function _aeLeaderClear(m, box, rings) { return _aeLeaderClearance(m, box, rings) > AE_LEADER_CLEAR_PX; }
// The point of a name's box nearest the dot: where its leader ends.
function _aeLeaderEnd(m, box) { return [Math.min(Math.max(m.x, box[0]), box[2]), Math.min(Math.max(m.y, box[1]), box[3])]; }
// The leader as drawn: from the dot's edge to its name, [x0, y0, x1, y1].
function _aeLeaderSeg(m, box) {
  var end = _aeLeaderEnd(m, box), lx = end[0] - m.x, ly = end[1] - m.y, ll = Math.hypot(lx, ly) || 1, r = m.r - AE_MARK_NAME_PAD;
  return [m.x + lx / ll * r, m.y + ly / ll * r, end[0], end[1]];
}
// Whether a line [x0, y0, x1, y1] passes through a box (Liang-Barsky): a leader through another body's name.
function _aeSegMeetsBox(seg, box) {
  var t0 = 0, t1 = 1, dx = seg[2] - seg[0], dy = seg[3] - seg[1];
  var p = [-dx, dx, -dy, dy], q = [seg[0] - box[0], box[2] - seg[0], seg[1] - box[1], box[3] - seg[1]];
  for (var i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] <= 0) return false; continue; }
    var r = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 >= t1) return false;
  }
  return true;
}
// The order names are placed in: the body in view or in flight first, then the bigger discs (Venus before Mercury), so
// the crowded inner planets lose the smaller name, not the brighter.
function _aeNameOrder(shown) {
  var prio = function (m) { return m.ringed ? 1e6 : m.body === _ae.target ? 1e3 : _aeMarkDiscR(m.body); };
  return shown.map(function (m, i) { return i; }).sort(function (a, b) { return prio(shown[b]) - prio(shown[a]) || a - b; });
}
function _aePlaceMarkNames(shown) {
  // What a name may not cover: every body drawn (a crowd's every member too), but its own.
  var rings = [];
  shown.forEach(function (m, i) {
    (m.pts || [m]).forEach(function (q) {
      var r = q === m ? m.r : _aeMarkDiscR(q.body) + AE_MARK_NAME_PAD;
      rings.push({ i: i, own: q === m, box: [q.x - r, q.y - r, q.x + r, q.y + r], x: q.x, y: q.y, r: q === m ? m.r : _aeMarkDiscR(q.body) });
    });
  });
  // In the Planets view the Sun's disc is drawn on the planets' scale: no name on it either.
  var sunAt = _aeSunAsMark() && _ae.scene ? _aeProject(_aeSunShown(_ae.scene)) : null;
  if (sunAt) { var sr = _aeMarkDiscR('sun') + AE_MARK_NAME_PAD; rings.push({ i: -1, own: false, box: [sunAt.x - sr, sunAt.y - sr, sunAt.x + sr, sunAt.y + sr], x: sunAt.x, y: sunAt.y, r: _aeMarkDiscR('sun') }); }
  var names = [], leaders = [];   // the names placed so far, and the leader lines drawn to them
  _aeNameOrder(shown).forEach(function (i) {
    var m = shown[i];
    var el = m.el, label = el.querySelector ? el.querySelector('b') : null;
    if (el.classList && el.classList.contains('ae-bm-quiet')) return;   // a point, no name (the Planets view's probes)
    // Measured once it has been laid out (a hidden name has no width: until then, a generous guess by its letters).
    if (el._aeNameW == null || el._aeNameGuess) {
      var meas = label && label.offsetWidth;
      el._aeNameGuess = !meas;
      el._aeNameW = meas || String((label || el).textContent || '').length * AE_NAME_CHAR_PX;
    }
    var w = el._aeNameW || 0, out = _aeNameOutLeft(el, m.x) ? 'l' : 'r', inn = out === 'l' ? 'r' : 'l';
    var sides = m.ringed ? ['t'] : AE_NAME_SIDES.map(function (sd) { return sd.replace('out', out).replace('in', inn); });
    var wideNamed = !m.ringed && _aeWideView() && _aeNamedPlanet(m.body), chosen = null;
    var slots = _aeNameSlots(m, w, sides, wideNamed);
    var onScreen = function (box) { return box[0] >= AE_NAME_EDGE && box[2] <= _ae.w - AE_NAME_EDGE && box[1] >= 0 && box[3] <= _ae.h; };
    // A name meets no name and no leader already placed; a leader of its own crosses no name.
    var onName = function (box) {
      return names.some(function (n) { return _aeBoxesMeet(n, box); }) || leaders.some(function (l) { return _aeSegMeetsBox(l, box); });
    };
    var leaderFree = function (t) { var sg = _aeLeaderSeg(m, t.box); return !names.some(function (n) { return _aeSegMeetsBox(sg, n); }); };
    var onDisc = function (box) { return rings.some(function (rb) { return !(rb.i === i && rb.own) && _aeBoxesMeet(rb.box, box); }); };
    var tie = wideNamed ? AE_NAME_TIE_WIDE_PX : AE_NAME_TIE_PX;
    // Never across the screen's edge: a name that would be is tried on the inward side, then above and below.
    var passes = m.ringed ? [function () { return true; }] : [
      function (t) { return !t.leader && onScreen(t.box) && !onName(t.box) && !onDisc(t.box) && _aeNameIsItsOwn(t.box, m, rings, tie, wideNamed ? AE_NAME_TIE_WIDE_RATIO : 1); },
      function (t) { return wideNamed && t.leader && onScreen(t.box) && !onName(t.box) && !onDisc(t.box) && leaderFree(t) && _aeLeaderClear(m, t.box, rings); },
      // Two dots close together (Venus beside the Earth near conjunction): a leader that grazes the other is still drawn
      // from its own dot, where a name merely beside it would read as the nearer one's; of those, the one that keeps
      // farthest from every other dot (never the first that came, which ran through Venus).
      'widest',
      function (t) { return wideNamed && !t.leader && onScreen(t.box) && !onName(t.box); },
      function (t) { return wideNamed && onScreen(t.box) && !onName(t.box); },
      function () { return wideNamed; }
    ];
    for (var pi = 0; pi < passes.length && !chosen; pi++) {
      if (passes[pi] === 'widest') {
        var best = -Infinity;
        slots.forEach(function (t) {
          if (!(wideNamed && t.leader && onScreen(t.box) && !onName(t.box) && !onDisc(t.box) && leaderFree(t))) return;
          var c = _aeLeaderClearance(m, t.box, rings);
          if (c > best + 0.5) { best = c; chosen = t; }
        });
      } else chosen = slots.filter(passes[pi])[0] || null;
    }
    if (m.ringed && !chosen) chosen = slots[0];
    if (chosen) names.push(chosen.box);
    var far = !!chosen && chosen.leader;
    if (far) {
      m.leader = _aeLeaderSeg(m, chosen.box);
      leaders.push(m.leader);
      el.style.setProperty('--ae-bx', (chosen.box[0] - m.x).toFixed(1) + 'px');
      el.style.setProperty('--ae-by', ((chosen.box[1] + chosen.box[3]) / 2 - m.y).toFixed(1) + 'px');
    }
    el.classList.toggle('ae-bm-pos', far);
    var side = far ? null : chosen && chosen.side;
    el.classList.toggle('ae-bm-l', side === 'l');
    el.classList.toggle('ae-bm-t', side === 't');
    el.classList.toggle('ae-bm-b', side === 'b');
    ['tr', 'tl', 'br', 'bl'].forEach(function (c) { el.classList.toggle('ae-bm-' + c, side === c); });
    el.classList.toggle('ae-bm-n', !chosen);
    el.style.setProperty('--ae-nx', ((chosen && chosen.box.dx) || 0).toFixed(1) + 'px');
  });
}

// "GPS BIII-3  (PRN 23)" -> "PRN 23"; anything else as given.
function _aeSatShortName(s) {
  var m = /PRN\s*(\d+)/.exec(s.omm.OBJECT_NAME || '');
  return m ? 'GPS PRN ' + m[1] : String(s.omm.OBJECT_NAME || '').replace(/\s+/g, ' ');
}

// ── Taps ──
function _aeTap(x, y) {
  if (_ae.stand) {   // on the ground a tap is for what hangs in the sky (a name, then the way there: almanac-stand.js), and for nothing of the orbit view
    if (_ae.stand.live && typeof _aeStandSkyTap === 'function' && _aeStandSkyTap(x, y)) return;
    _aeBareTap();   // empty sky
    return;
  }   // an object other modules put in the sky
  if (_aeRecordTap(x, y)) return;
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
  // The ISS: go to it, as Go to does (close up, following it round).
  if (!best && typeof _asTap === 'function' && _asTap(x, y)) return;   // a satellite of the all-satellites layer
  if (best && _ae.sats.list[best.idx].iss && _ae.issBasis) { _aePreset('iss'); return; }
  if (best && _ae.sats.list[best.idx].craft && _aeOrbiter[_ae.sats.list[best.idx].craft]) { _aePreset(_ae.sats.list[best.idx].craft); return; }
  if (best) {
    _ae.selected = { norad: _ae.sats.list[best.idx].omm.NORAD_CAT_ID, tapMs: _aeDisplayMs() };
    _aeRenderCard();
    _aeRedraw();
    return;
  }
  // The Earth, the Moon or the Sun: fly to it, as its chip does. A tap on
  // the one already in view falls through (it puts a satellite's card away).
  var body = _aeBodyAt(x, y);
  if (body && (body !== _ae.target || (body === 'sun' && _ae.preset === 'planets'))) { _aePreset(body); return; }   // (the solar system view is centred on the Sun: tapping it goes in to it)
  if (_ae.selected || (typeof _asHasSel === 'function' && _asHasSel())) {
    _ae.selected = null;
    if (typeof _asSelect === 'function') _asSelect(-1);
    _aeRenderCard(); _aeRedraw();
    return;
  }
  // The one in view, its surface tapped: the spot, with the way down to it (almanac-stand.js); else its card (put away
  // with ×, or by flying elsewhere).
  if (body && body === _ae.target && _aeStandable(body)) {
    if (typeof _aeStandPick === 'function') { if (_aeStandPick(body, x, y)) return; }
    else { _aeStandReady().then(function () { if (!_aeStandPick(body, x, y) && _ae.arrived !== body) _aeArrive(body); }); return; }
  }
  if (body && _ae.arrived !== body) _aeArrive(body);
  if (!body && _ae.pick) { _aeCardClear(); return; }   // empty sky clears a tapped spot, as a tap on the spot itself does
  if (!body) _aeBareTap();   // nothing under the finger: the controls go away, or come back
}
// On a mouse, something to tap shows a hand: the craft's model as much as its little circle.
// The names in the picture that a tap opens. They take no pointer (a press anywhere is the globe's); the canvas finds the one under a tap.
var AE_SCENE_TAPS = '#ae-lms .ae-lm:not([hidden]),#af-refs .af-ref:not([hidden]),#as-dots i,#as-earthhint:not([hidden])';
function _aeSceneTapAt(x, y) {
  var view = _ae && _ae.el, hit = null;
  if (!view) return null;
  Array.prototype.forEach.call(view.querySelectorAll(AE_SCENE_TAPS), function (el) {
    var b = el.getBoundingClientRect();
    if (b.width && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) hit = el;   // (the last drawn is on top)
  });
  return hit;
}
function _aeHover(e) {
  var canvas = _aeById('ae-canvas');
  if (!canvas || e.pointerType !== 'mouse' || _ae.drag || _ae.fly) return;
  var r = canvas.getBoundingClientRect(), on = !!_aeSceneTapAt(e.clientX, e.clientY) || !!_aeBodyAt(e.clientX - r.left, e.clientY - r.top);
  if (canvas.style.cursor !== (on ? 'pointer' : '')) canvas.style.cursor = on ? 'pointer' : '';
}

// The body under a point on the screen: its disc, or a finger's width
// around a small one; the nearest to the camera where one covers another
// (the Moon before the Sun in an eclipse). Null for none.
var AE_TAP_BODY_PX = AE_TAP_RADIUS_PX * 1.5;
function _aeBodyAt(x, y) {
  var sc = _ae.scene;
  if (!sc || !_ae.h) return null;
  var cam = _ae.gl.camera, eye = _aeXyz(cam.position);
  var pxPerRad = _aePxPerRad(cam);
  // The ISS only where it is big enough to be drawn as itself (from afar its dot is the satellites' to pick, and from
  // the Sun it stood on the Earth and took the Earth's taps): its size from this camera, not the last frame's.
  var issDrawn = !!_ae.issPos && AE_ISS_SPAN_RE / Math.max(1e-12, _aeLen(_aeSub(_ae.issPos, eye))) * pxPerRad >= AE_CRAFT_MODEL_PX[0];
  // The Planets view: a moon sits on its planet at that scale and is not a target; a tap there is the planet's.
  var wide = _aeWideView();
  var bodies = AE_MARKED.filter(function (m) { var b = _aePlanetBody(m.body); return (!m.flightOnly || issDrawn) && !(wide && b && b.parent); })
    .map(function (m) { return [m.body, _aeBodyPos(m.body, sc), AE_TARGETS[m.body].surface]; })
    .filter(function (b) { return !!b[1]; });
  var best = null, bestD = Infinity, bestOff = Infinity, bestRank = Infinity, under = [];
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i];
    if (b[0] !== 'earth' && _aeBehindEarth(b[1])) continue;
    var s = _aeProject(b[1]);
    if (!s) continue;
    var d = _aeLen(_aeSub(b[1], eye));
    var disc = b[2] / d * pxPerRad, reach = Math.max(disc, AE_TAP_BODY_PX), off = Math.hypot(s.x - x, s.y - y);
    if (off > reach) continue;
    under.push(b[0]);
    // A disc that covers the point wins (the Moon in view over a far dwarf planet that lines up behind it); then a planet
    // wins over anything else under the same finger; then the nearest.
    // In the solar system view the Sun stands with the planets, and the one nearest the finger on the screen wins (Mercury's finger-wide reach
    // used to cover the Sun's, so the Sun could not be tapped).
    var rank = off <= disc && disc >= AE_TAP_BODY_PX ? -1 : (_aeIsPlanet(b[0]) && !_aePlanetBody(b[0]).parent) || (wide && (b[0] === 'sun' || b[0] === 'earth')) ? 0 : 1;   // the Earth stands with the planets there
    var nearer = wide && rank === 0 ? off < bestOff : d < bestD;
    if (best === null || rank < bestRank || (rank === bestRank && nearer)) { bestD = d; bestOff = off; best = b[0]; bestRank = rank; }
  }
  // A planet under the same finger as its own moon is the one tapped, always ("never take me to its moon. It's always the planet first").
  var home = _aeMoonOf(best);
  return home && under.indexOf(home) >= 0 ? home : best;
}
// The planet a moon belongs to (the Earth for the Moon), or null.
function _aeMoonOf(key) {
  if (key === 'moon') return 'earth';
  var b = key && _aePlanetBody(key);
  return b && b.parent ? b.parent : null;
}

// ── The card for a tapped satellite ──
// ONE SHEET AT A TIME: every sheet is listed here once, with how to tell it is up and how to put it away; whatever opens claims
// its kind, and the rest close. (A card counts: a pin, a place, a satellite, a landmark.)
var AE_SHEETS = {
  go: { up: function () { var e = _aeById('ae-go'); return !!e && !e.hidden; }, close: function () { _aeShowGo(false); } },
  set: { up: function () { return !!_ae.setOpen; }, close: function () { _aeShowSettings(false); } },
  info: { up: function () { return !!_ae.info; }, close: function () { _aeCloseInfo(false); } },
  sats: { up: function () { return typeof _as !== 'undefined' && !!_as.sheet; }, close: function () { _asCloseSheet(); } },
  card: { up: function () { var c = _aeById('ae-card'); return !!c && !c.hidden; }, close: function () { _aeCardClear(); } }
};
function _aeSheetClaim(kind) {
  Object.keys(AE_SHEETS).forEach(function (k) { if (k !== kind && AE_SHEETS[k].up()) AE_SHEETS[k].close(); });
}
// Every selection a card shows, cleared: the pin, the place, the landmark, the thing sent, the satellite.
function _aeCardClear() {
  _aeCardForget();
  _aeRenderCard();
  _aeRedraw();
}
function _aeCardForget() {
  _ae.place = _ae.lm = _ae.sent = _ae.pick = null;
  _ae.selected = null;
  if (typeof _asHasSel === 'function' && _asHasSel() && typeof _asSelect === 'function') _asSelect(-1);
}
function _aeRenderCard() {
  if (!_ae.lm) aeCaption('night', '');   // the site's night line goes with its card
  _aeRenderCardBody();
  var card = _aeById('ae-card'), view = _aeById('ae-view');
  // A mode with no room for a card has none, whatever a tap in its picture chose (in flight the foot is the levers' and the info corner's).
  if (card && !card.hidden && (AH_CORNER[_aeMode()] || {}).nocard) { _aeCardForget(); _aeRenderCardBody(); }
  if (card && view && view.classList) { view.classList.toggle('ae-carded', !card.hidden); _aeHudRender(); }
  if (card && !card.hidden) { _aeBare(false); if (!_ae.cardUp) _aeSheetClaim('card'); }   // a card is something to read, and the one sheet
  _ae.cardUp = !!card && !card.hidden;
  _aeSyncInfo();
  _aeMarkInfoBtn();
}
// The i in the corner: there while the view is at a place that has a sheet, pressed while the sheet is up.
function _aeMarkInfoBtn() {
  var b = _aeById('ae-info-btn'), k = _ae && (_aeGroundBody() || _ae.arrived);
  if (!b) return;
  var on = !!k && _aeHasFacts(k) && (!_aeIsProbe(k) || !!_aeTracks);
  if (b.hidden === on) b.hidden = !on;
  b.setAttribute('aria-expanded', String(!!_ae.info));
  if (_ae.el && _ae.el.classList) { _ae.el.classList.toggle('ae-info-up', !!_ae.info); _aeHudRender(); }
  _aeMarkToggles();
}
function _aeRenderCardBody() {
  var card = _aeById('ae-card');
  if (!card) return;
  var s = _aeSelectedSat();
  if (!s && _ae.pick) { card.hidden = true; card.innerHTML = ''; if (typeof _aeStandMarkPick === 'function') _aeStandMarkPick(); _aeHudInfoPaint(true); return; }   // a tapped spot is the info corner's, and its ring: no card
  if (!s && _ae.place) { _aeRenderPlaceCard(card); return; }   // a place that was searched for: its article where it has one, and its map
  if (!s && _ae.lm) { _aeRenderLmCard(card); return; }
  if (!s && _ae.sent) { _aeRenderSentCard(card); return; }
  if (!s && typeof _asRenderCard === 'function' && _asRenderCard(card)) return;   // a satellite of the all-satellites layer
  if (!s) { _ae.selected = null; card.hidden = true; card.innerHTML = ''; return; }
  _ae.lm = null;
  var html = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>';
  if (s.iss) {
    html += '<h3>' + _aeLink('term:iss', _almEsc(_aeT('alm_earth_iss_name'))) + '</h3>' +
      '<p id="ae-card-body"></p>' + '<p id="ae-card-age"></p>';
  } else {
    html += '<h3>' + _aeLink('term:gps', _almEsc(_aeSatShortName(s))) + '</h3>' +
      '<p id="ae-card-body"></p>' + '<p class="ae-counter" id="ae-card-count"></p>' + '<p id="ae-card-age"></p>' +
      (_aeLinked('term:time_dilation') ? '<p>' + _aeLink('term:time_dilation', _almEsc(_aeT('alm_earth_time_dilation'))) + '</p>' : '');
  }
  card.innerHTML = html;
  card.hidden = false;
  _aeById("ae-card-x").onclick = _aeCardClear;
  _aeUpdateCard(_aeDisplayMs());
}

function _aeUpdateCard(ms) {
  var s = _aeSelectedSat();
  if (!s) { if (typeof _asUpdateCard === 'function') _asUpdateCard(ms); return; }
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
  var gpsAge = _aeById('ae-card-age');
  if (gpsAge) gpsAge.textContent = s.standing === 'approximate' ? _aeT('alm_earth_approx', { date: _aeFmtDate(s.epochMs) }) : '';
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
  var parts = [], dated = '', stale = false, sats = _ae.sats;
  // What the satellites' data is like is said where satellites are drawn: the Earth (and its Satellites view) and the
  // ISS. At Saturn or Voyager it was a line about something not on the screen. The gear keeps the data's date anywhere.
  var aboutSats = _ae.target === 'earth' || _ae.target === 'iss';
  if (sats && sats.list.length) {
    var newest = 0, anyShown = false, issOrbit = null, gpsApprox = false;
    sats.list.forEach(function (s) {
      newest = Math.max(newest, s.epochMs);
      if (s.standing && s.standing !== 'none') anyShown = true;
      if (s.iss && s.standing === 'orbit') issOrbit = s;
      if (!s.iss && s.standing === 'approximate') gpsApprox = true;
    });
    // The data's date is in the gear (with Get fresh data); the line under the controls says only that it may be out
    // of date.
    if (anyShown) dated = _aeT('alm_earth_sat_data_from', { date: _aeFmtDate(newest) });
    else if (aboutSats) parts.push(_aeT('alm_earth_no_sat_data'));
    stale = aboutSats && anyShown && !!(_ae.satMeta && _ae.satMeta.stale);
    if (stale) parts.push(_aeT('alm_earth_data_stale'));
    if (aboutSats && gpsApprox) parts.push(_aeT('alm_earth_approx', { date: _aeFmtDate(newest) }));   // (the dots faded: the constellation as it was at the data's date)
    if (aboutSats && issOrbit) parts.push(_aeT('alm_earth_iss_orbit_only', { date: _aeFmtDate(issOrbit.epochMs) }));
  } else if (aboutSats && sats) {
    parts.push(_aeT('alm_earth_no_orbital_data'));
  } else if (aboutSats && _ae.satsFailed) {
    parts.push(_aeT('alm_earth_sats_unavailable'));
  }
  var S = _ae.gl;
  if (S && (S.mapFailed[AE_TEX_NIGHT] || S.mapFailed[AE_TEX_MOON])) parts.push(_aeT('alm_earth_maps_failed'));
  return { ask: dated, note: parts.join(' · '), stale: stale };
}

// The offer before the note: the data's date, whether the last try failed,
// and the button.
function _aeRenderAsk(dated) {
  var box = _aeById('ae-ask'), btn = _aeById('ae-fresh'), sep = _aeById('ae-fresh-sep');
  if (!box || !btn) return;
  var on = !!dated, asking = on && _aeAsking();
  if (box.hidden === on) box.hidden = !on;
  if (!on) return;
  var parts = [dated];
  if (asking && _ae.freshFailed) parts.push(_aeT('alm_earth_fresh_failed'));
  _aeSetText(_aeById('ae-ask-text'), parts.join(' · '));
  if (btn.hidden === asking) btn.hidden = !asking;
  if (sep && sep.hidden === asking) sep.hidden = !asking;
  _aeSetText(btn, _aeT(_ae.freshBusy ? 'alm_earth_getting_fresh' : 'alm_earth_get_fresh'));
  btn.disabled = !!_ae.freshBusy;
}

// Under Ask first, the line that says the satellites may be out of date carries the update itself: one tap, no trip
// into the gear.
function _aeRenderNoteFresh(stale) {
  var btn = _aeById('ae-note-fresh');
  if (!btn) return;
  var on = !!stale && _aeAsking();
  if (btn.hidden === on) btn.hidden = !on;
  if (!on) return;
  _aeSetText(btn, _aeT(_ae.freshBusy ? 'alm_earth_getting_fresh' : 'update'));
  btn.disabled = !!_ae.freshBusy;
}

// ── Text: the clock, the eclipse line, the data note ──
function _aeRefreshText() { if (_aeIsOpen) _aeUpdateText(_aeDisplayMs()); }
function _aeUpdateText(ms) {
  var whenText = _aeFmtWhen(ms);   // the view's aria line says the moment in words
  _aeMeasureFoot();   // the controls' height changes with their notes; marks keep above them
  _aeMarkToggles();
  _aeMeasureTop();
  _aeRimSync();
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
  // The caption slot's quiet lines, by priority: on the Moon with no place to
  // stand that up is celestial north (said, not guessed), then out among the planets that their directions are true and their distances squeezed.
  aeCaption('north', _ae.target === 'moon' && !_aeObserver() ? _aeT('alm_moon_north_up') : '', { prio: AE_CAP_PRIO_NOTE });
  _aeWherePaint();
  var note = _aeNoteParts();
  _aeRenderAsk(note.ask);
  _aeSetText(_aeById('ae-note'), note.note);
  _aeRenderNoteFresh(note.stale);
  // The offers and notes that stood at the foot (Almanac HD: Download / Not now; the satellites' date: Update) are said in the caption slot
  // when nothing more pressing is, a tap on the line doing the first action; both actions are also rows in the world sheet.
  var hdBox = _aeById('ae-hd'), hdLine = hdBox && !hdBox.hidden ? _aeById('ae-hd-text').textContent.trim() : '', fresh = _aeById('ae-note-fresh');
  aeCaption('hd', hdLine, { prio: AE_CAP_PRIO_OFFER, onTap: function () { _aeById('ae-hd-get').click(); } });
  aeCaption('satnote', _aeById('ae-note') ? _aeById('ae-note').textContent.trim() : '', { prio: AE_CAP_PRIO_FOOT, onTap: fresh && !fresh.hidden ? function () { fresh.click(); } : null });
  // No orbital data reached this device (offline before it was ever kept):
  // the Satellites view would frame an empty shell, so it is not offered;
  // the note says why.
  var satsBtn = document.querySelector('#ae-views [data-ae-view="sats"]');
  var noSats = !!(_ae.satsFailed || (_ae.sats && !_ae.sats.list.length));
  if (satsBtn && satsBtn.disabled !== noSats) satsBtn.disabled = noSats;
  var canvas = _aeById('ae-canvas');
  if (canvas && sc) {
    var aria = _aeT('alm_earth_aria', { when: whenText, place: _aeFmtLatLon(_aeSubsolarPoint(sc)) });
    if (canvas.getAttribute('aria-label') !== aria) canvas.setAttribute('aria-label', aria);
  }
  _aeUpdateCard(ms);
  _aeUpdateInfoLive(ms);
}
var AE_ARRIVAL_REFRESH_MS = 10000;   // display time between refreshes of the sheet's "now" rows

// ── The loop ──
// Renders every frame while something moves (a drag, a flight, a clock fast
// enough to move the picture visibly); otherwise no frame at all until input,
// a tile or a model arriving (dirty), or the clock has moved something on
// screen by half a pixel, and then at most one a second.
// A frame asked for and never delivered (a browser that drops the callback, a GPU that was busy for seconds) leaves the loop
// believing one is on its way, and then nothing kicks it: a flight waiting on a model stands at its first frame for good.
// Anything that kicks after this long without the frame asks again.
var AE_RAF_STALL_MS = 1500;
function _aeAskFrame() { _ae.rafAt = performance.now(); _ae.raf = _aeRaf(); }
// Something on screen changed: draw the next frame.
function _aeRedraw() { _ae.dirty = true; _aeKick(); }
function _aeKick() {
  if (!_aeIsOpen) return;
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  if (_ae.raf && performance.now() - _ae.rafAt > AE_RAF_STALL_MS) { cancelAnimationFrame(_ae.raf); _ae.raf = 0; }
  if (!_ae.raf) _aeAskFrame();
}
function _aeBusy() {
  var fading = !!_ae.orbitFly && !!_ae.orbitFly.endAt && performance.now() - _ae.orbitFly.endAt < AE_ORBITS_FADE_MS;   // orbits going out
  return !!(_ae.fly || _ae.drag || _ae.pinch || _ae.hand || fading || _aeStationMoves() || _ae.site || _ae.mission || _ae.ship || (_ae.shipExit && !_ae.shipExit.hold) || _aeStandBusy() || !!_ae.sentGhost ||
    _aeClockPxPerS() >= AE_IDLE_SMOOTH_PX_S);
}
// How many px a second the clock moves the fastest thing on screen (0 when it is stopped).
function _aeClockPxPerS() {
  var rate = typeof _almRate === 'number' ? Math.abs(_almRate) : 1, t = AE_TARGETS[_ae.target];
  if (!rate || !t) return 0;
  var focal = _aeFocalPx();
  if (_ae.stand || _ae.spin) return rate * AE_IDLE_SKY_RAD_S * focal;
  return rate * AE_IDLE_FASTEST_RE_S * focal / Math.max(_ae.dist - t.surface, AE_IDLE_NEAR_RE);
}
// Whether the clock has moved something on screen by half a pixel since the last picture (and a second has passed).
function _aeClockMoved(now) {
  var since = now - (_ae.lastRender || 0);
  return since >= AE_IDLE_TICK_MS && since / 1000 * _aeClockPxPerS() >= AE_IDLE_MOVE_PX;
}
// Idle: a timer, not a frame. It keeps the readouts on time while the clock runs and asks for a frame only when one
// would show something new.
function _aeIdleWait() {
  _ae.idleTimer = setTimeout(function () {
    _ae.idleTimer = 0;
    if (!_aeIsOpen || document.hidden) return;   // shown again, the view is kicked (visibilitychange)
    var now = performance.now();
    if (typeof _almRate !== 'number' || _almRate !== 0) { _aeUpdateText(_aeDisplayMs()); _ae.lastText = now; }
    if (_ae.dirty || _aeBusy() || _aeClockMoved(now)) _aeKick(); else _aeIdleWait();
  }, AE_IDLE_TICK_MS);
}
// The camera rides the station (7.7 km/s, the Earth turning under it) while the clock is not stopped: drawn every frame,
// not at the idle interval. A paused clock leaves it as still as any other view.
function _aeStationMoves() {
  return _ae.target === 'iss' && !!_ae.issPos && (typeof _almRate === 'undefined' || _almRate !== 0);
}
// Draw the scene at the clock's instant when something changed, something
// moves, or the idle interval has passed.
function _aeDraw(now, busy) {
  if (!_ae.gl || !(_ae.dirty || busy || _aeClockMoved(now))) return;
  if (_ae.drawTs && now - _ae.drawTs > AE_STALL_MS) _aeStallGuard(_ae.drawTs, now);   // (by whatever path a picture is asked for: the frame loop's, the page clock's)
  _ae.drawTs = now;
  _aeRimDot();
  if (_ae.spin) {   // Planets side by side: its own scene, nothing of the main one moves
    _aeSpinDraw();
    _ae.lastRender = now;
    _ae.dirty = false;
    return;
  }
  if (_ae.stand && _ae.stand.live && _ae.site && _ae.site.adopt === _ae.stand) _aeStandDrop(true, true);   // a visit takes this ground over: within this frame (its first step and picture follow), never a frame of nothing between
  if (_ae.stand && _ae.stand.live) {   // Stand here: its own scene on the ground (almanac-stand.js)
    _aeStandDraw(now);
    _ae.lastRender = now;
    _ae.dirty = false;
    return;
  }
  _aeUpdate(_aeDisplayMs());
  _ae.readAt = performance.now();   // (the moves have read the clock by now: _aeStallGuard)
  if (_ae.sent || _ae.sentGhost) _aeSentGhostDraw(now);   // a lost thing's faint stand-in (almanac-sent.js)
  _aeHdFrame(_ae.gl);
  _aeMapsFrame(_ae.gl);
  _aeCloseStop(_ae.gl);
  var drawMain = function () { _ae.gl.renderer.render(_ae.gl.scene, _ae.gl.camera); };
  if (_ae.site && typeof _aeHostRender === 'function' && _aeHostRender()) { /* a landing site is drawn on Stand here's ground once that is ready */ }
  else if (_ae.ship && _ae.ship.gnd && _ae.ship.gnd.live) _aeRigGroundDraw(_ae.ship, now, drawMain);   // the UFO low over a ground: the ground's own picture over the globe's, by height (almanac-standhost.js)
  else drawMain();
  _aeDrawMini();
  _aeUpdateLabels();
  if (_ae.pick && (_ae.site || _ae.ship || _ae.mission || _ae.stand || _ae.standPending)) { _ae.pick = null; _aeRenderCard(); }   // a tapped spot belongs to the globe: any other mode takes it with it
  var tapRing = _aeById('ae-pick');
  if (_ae.pick || (tapRing && !tapRing.hidden)) _aeStandMarkPick();   // a pick cleared by any path takes its ring with it
  _ae.lastRender = now;
  _ae.dirty = false;
}
// One chain of frames. A kick made while a frame is being drawn used to start a second chain beside the one that frame was about to
// continue, and chains never died, so a long visit drew several times for every picture shown (a drive was 8 draws a frame, 11 a
// second on a phone-sized screen). Now the frame that is asked for last is the only one that runs: _ae.raf names it, and any other
// callback still waiting (an older chain) does nothing and ends.
function _aeRaf() {
  var id = requestAnimationFrame(function (ts) { if (id === _ae.raf) _aeFrame(ts); });
  return id;
}
// A frame that took far longer than any (a shader compiled, a map uploaded) is not a stretch of the move: every move that runs by the clock is held back by the time
// the stall cost beyond a slow frame, so the camera goes on from where it was instead of jumping to where the clock says.
var AE_STALL_MS = 70, AE_STALL_KEEP_MS = 35, AE_STALL_RUN_MAX = 3;   // (a stall is given back for at most this many slow frames in a row)
function _aeStallGuard(prevTs, now) {   // the part of the stall that fell inside a move is what the move gives back (never more than that: a move does not start over)
  if (_ae.stallAt === now) return;   // (once for a frame: asked by the frame loop and again by its draw)
  _ae.stallAt = now;
  // A device whose every frame is slow (software GL, an old phone) has no stall to give back: held to AE_STALL_KEEP_MS a frame its moves
  // would run at that many ms per frame, a descent to the ground taking minutes. After a few frames in a row the clock runs.
  _ae.stallRun = _ae.stallLast === prevTs ? _ae.stallRun + 1 : 1;
  _ae.stallLast = now;
  if (_ae.stallRun > AE_STALL_RUN_MAX) return;
  // From when the last frame read its moves, not only its timestamp: a frame slow inside (a ground built, a shader compiled) read them well after it began,
  // and taking back from its start gave a move less time than it had already shown: the camera stepped back (a visit's drop rose in its first frames).
  var back = function (t0) { return Math.max(0, now - Math.max(t0, prevTs, _ae.readAt || 0) - AE_STALL_KEEP_MS); };
  if (_ae.fly) _ae.fly.start += back(_ae.fly.start);
  var st = _ae.stand;
  if (st && (st.mode === 'descend' || st.mode === 'ascend')) st.t0 += back(st.t0);
  var site = _ae.site;
  if (site && (site.phase === 'drop' || site.phase === 'rise')) site.t0 += back(site.t0);
  if (_ae.shipExit && !_ae.shipExit.hold) _ae.shipExit.t0 += back(_ae.shipExit.t0);
}
function _aeFrame() {
  _ae.raf = 0;
  if (!_aeIsOpen || document.hidden) return;
  if (typeof _almanacOpen !== 'undefined' && !_almanacOpen) { _aeFinishClose(); return; }
  var now = performance.now();
  var fpsMax = _aeCapGet('fpsMax', 0);   // a light device draws 30 a second, not 60
  if (fpsMax && _ae.lastDraw && now - _ae.lastDraw < 1000 / fpsMax - AE_FPS_SLACK_MS) { _aeAskFrame(); return; }
  var dt = _ae.lastTs ? Math.min(now - _ae.lastTs, 1000) : 0;
  _ae.lastTs = now;
  if (_ae.drawTs && now - _ae.drawTs > AE_STALL_MS) _aeStallGuard(_ae.drawTs, now);   // (before the flight steps: the frame that stalled must not take the whole stall in one step)
  var handDone = _aeStepHand(now);
  _aeDbgFrame(now);
  var shifting = _aeStepInfoShift(dt);
  var catching = _aeStepCatchUp();
  var busy = _aeStepFly(now) || _aeBusy() || !!handDone || shifting || catching;
  if (_ae.standPending) _aeStandStep();
  _aeDraw(now, busy);
  _ae.lastDraw = busy ? now : 0;
  if (busy && !_ae.stand && typeof ZimiCap !== 'undefined') ZimiCap.frame('earth', now);   // the governor sees every frame that was really painted
  if (now - _ae.lastText >= AE_TEXT_TICK_MS) { _aeUpdateText(_aeDisplayMs()); _ae.lastText = now; }
  // The last frame of a swap is drawn; what follows it (the page covered,
  // or the view gone and the hero back) happens on it, not a frame later.
  if (handDone) handDone();
  if (!_aeIsOpen) return;
  if (busy) { if (!_ae.raf) _aeAskFrame(); }   // (a kick made during the frame has already asked for the next)
  else {
    _ae.lastTs = 0;
    _aeIdleWait();
  }
}

// ── Input ──
// Zooming on in at the closest stop over a world with ground goes on down to it ("I should be able to keep
// scrolling and smoothly go down to the surface same as if I was in the UFO"): once the zoom asked for past the stop adds up to
// this (log distance: three or four wheel notches, a pinch's spread), the way in at the middle of the picture is taken, as the
// rim button takes it. Zooming out, or anything else, starts the count again.
var AE_PUSH_IN_LAND = 0.45;
function _aeZoomPast(factor, before) {
  if (factor > 1 || _ae.fly || !_ae.atStop || _ae.dist < before) { _ae.pushIn = 0; return; }
  _ae.pushIn = (_ae.pushIn || 0) - Math.log(factor);
  if (_ae.pushIn < AE_PUSH_IN_LAND) return;
  _ae.pushIn = 0;
  _aeRimPressKey();
}
function _aeZoomBy(factor) {
  _aeLetGo();
  // Mid-flight, a zoom rescales the flight and lets it finish turning.
  var f = _ae.fly, before = _ae.dist;
  if (f) {
    f.toDist = _aeClampDist(f.toDist * factor);
    f.from.dist = _aeClampDist(f.from.dist * factor);
  }
  _ae.dist = _aeClampDist(_ae.dist * factor);
  _aeZoomPast(factor, before);
  if (factor > 1 && typeof _aeOrreryPullCheck === 'function') _aeOrreryPullCheck();   // the Planets view pulled out far enough settles onto the orrery
  if (_ae.preset !== 'planets') _ae.preset = null;   // closer or farther from a body is still that body (_aeMarkViews); the planets stay the planets
  _aeMarkViews();
  _aeRedraw();
}
// Two fingers (or a right or shift drag) slide the view across the body instead of turning it: the point looked at
// moves in the screen's plane, no further from the body's middle than its radius (a craft's half-span), so it can
// never be lost; it is let go as the view leaves the body (AE_PAN_NEAR..AE_PAN_FAR radii out) and when it flies on.
var AE_PAN_NEAR = 3, AE_PAN_FAR = 8;
function _aePanWeight() {
  var r = _ae.dist / AE_TARGETS[_ae.target].surface;
  return 1 - _aeSmoother((r - AE_PAN_NEAR) / (AE_PAN_FAR - AE_PAN_NEAR));
}
// `pos`, the target's place, moved by the slide that belongs to it (none while flying to something else).
function _aePanned(pos) {
  var p = _ae.pan;
  if (!p || p.t !== _ae.target || _ae.fly) return pos;
  var w = _aePanWeight();
  return [pos[0] + p.v[0] * w, pos[1] + p.v[1] * w, pos[2] + p.v[2] * w];
}
// A move of the fingers' midpoint, in screen pixels: the body follows it, so the point looked at goes the other way.
function _aePanBy(dx, dy) {
  var focal = _aeFocalPx(), e = _ae.gl && _ae.gl.camera.matrixWorld.elements;
  if (!(focal > 0) || !e) return;
  var k = _ae.dist / focal, p = _ae.pan && _ae.pan.t === _ae.target ? _ae.pan.v : [0, 0, 0];
  var v = [0, 1, 2].map(function (i) { return p[i] + (e[4 + i] * dy - e[i] * dx) * k; });
  var reach = AE_TARGETS[_ae.target].surface, len = _aeLen(v);
  if (len > reach) v = _aeScale(v, reach / len);
  _ae.fly = null;
  _ae.pan = { t: _ae.target, v: v };
  _aeRedraw();
}
// A drag that lifts the hero Moon into the view: while the Moon travels from the disc's place to the view's it only travels (a turn
// on top of that read as the Moon sliding about, not turning), the finger's turn is held, and once it has arrived it turns in
// place, caught up over a few frames, not in one jump.
var AE_HAND_CATCHUP = 0.3, AE_HAND_CATCHUP_END_RAD = 0.002;   // the share of the held turn made each frame; below this much left, all of it
function _aeTurnBy(dAz, dEl) {
  _aeLetGo();
  var h = _ae.hand;
  if (h && h.dir > 0 && !h.orrery) {
    var held = h.held || (h.held = { az: 0, el: 0 });
    held.az += dAz; held.el += dEl;
    _aeRedraw();
    return;
  }
  _ae.fly = null;
  _ae.az += dAz;
  _ae.el_ = _aeClamp(_ae.el_ + dEl, -AE_MAX_ELEVATION, AE_MAX_ELEVATION);
  if (h) { h.daz += dAz; h.del += dEl; }   // mid-swap out: the turn is the Moon's at both ends of the way
  _aeRedraw();
}
// One frame of the held turn being made; true while some is left.
function _aeStepCatchUp() {
  var c = _ae.catchUp;
  if (!c) return false;
  var last = Math.abs(c.az) + Math.abs(c.el) < AE_HAND_CATCHUP_END_RAD, az = last ? c.az : c.az * AE_HAND_CATCHUP, el = last ? c.el : c.el * AE_HAND_CATCHUP;
  c.az -= az; c.el -= el;
  if (last) _ae.catchUp = null;
  _aeTurnBy(az, el);
  return !last;
}
// A drag that began on the hero disc (almanac.js), carried on into the view.
function _aeHandDrag(dx, dy) {
  if (!_aeIsOpen || !_ae.gl) { _aeWaitDrag(dx, dy); return; }
  _aeDragBy(dx, dy);
}
// The view is not up yet (its parts are still being made): the disc is a picture, with nothing to turn, so it stays where it
// is (breathing, alm-moon-waking) and the drag so far is kept, to turn the Moon by once the view lifts it. It never slides
// under the finger: that read as the Moon being pushed across the page, not turned.
var _aeWaitDragPx = null;
function _aeWaitDrag(dx, dy) {
  if (_ae && _ae.failed) return;   // no view is coming (no WebGL here): nothing to keep the drag for
  var p = _aeWaitDragPx || (_aeWaitDragPx = { x: 0, y: 0 });
  p.x += dx; p.y += dy;
}
// The disc is let go (before the view lifts it, which reads where it stands); returns the drag kept, if any.
function _aeWaitDragRelease() {
  var p = _aeWaitDragPx;
  _aeWaitDragPx = null;
  return p;
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
// The tangent of half a field of view (degrees), and a camera's pixels per radian at the view's height.
function _aeTanHalf(fovDeg) { return Math.tan(_aeRad(fovDeg) / 2); }
function _aePxPerRad(cam) { return _ae.h / 2 / _aeTanHalf(cam.fov); }
function _aeFocalPx() {
  var cam = _ae.gl && _ae.gl.camera;
  return cam && _ae.h ? _aePxPerRad(cam) : 0;
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
// Two fingers `span` px apart: the zoom is the one their spread since the pinch began asks for, not the product of each
// move's, so the order a frame's touches arrive in cannot change where it ends (a step clamped at the nearest the view
// goes, then the other finger's step out by its full ratio, ended a spreading pinch farther than it began). Mid-flight
// (the flight sets the distance) the step's own ratio rescales the flight, as before.
function _aePinchZoom(p, span) {
  var k = p.span0 / span;
  if (_ae.stand) {
    var st = _ae.stand;
    if (p.zoom0 != null && st.zoom > 0) _aeStandZoom(p.zoom0 * k / st.zoom); else _aeStandZoom(p.span / span);
  } else if (_ae.fly || !(_ae.dist > 0)) _aeZoomBy(p.span / span);
  else { var before = _ae.dist; _aeZoomBy(_aeClampDist(p.dist0 * k) / _ae.dist); _aeZoomPast(p.span / span, before); }   // (held at the stop the zoom asked is 1: the fingers' own step is what goes on down)
}
// A pinch that starts on the body looked at holds the ground under the fingers: the point of the body under their midpoint stays under it, and the height over the
// surface (not the distance from the middle) goes as the spread, so a place a finger is on stays under that finger the whole gesture. Close in, scaling the distance
// from the middle closed the height far faster than the fingers did (a jump in), and the zoom was about the picture's middle, so the place slid away from them.
var AE_PINCH_FIX_STEPS = 4;   // rounds of the turn that brings the held point back under the midpoint (each closes most of what is left)
var AE_PINCH_SPAN_STEPS = 3;  // rounds of the height that puts the two fingers' places their spread apart (the drawn size goes as one over the height, near enough)
// Where the ray through a pixel of the picture (canvas pixels) meets the sphere of `r` round `c`, or null.
function _aeRayHit(x, y, c, r) {
  var S = _ae.gl, cam = S.camera, v = new S.THREE.Vector3(x / _ae.w * 2 - 1, 1 - y / _ae.h * 2, 0.5).unproject(cam);
  var o = _aeXyz(cam.position), d = _aeNorm([v.x - o[0], v.y - o[1], v.z - o[2]]), oc = _aeSub(o, c);
  var b = _aeDot(oc, d), q = b * b - (_aeDot(oc, oc) - r * r);
  if (q < 0) return null;
  var t = -b - Math.sqrt(q);
  return t > 0 ? _aeAdd(o, _aeScale(d, t)) : null;
}
// The pinch's hold on the body: the points under each finger at its start (from the body's middle), or null when one is off the body (it zooms and slides as before).
function _aePinchHold(a, b) {
  if (_ae.fly || _ae.stand || _ae.spin || _ae.hand || !_ae.gl || !AE_TARGETS[_ae.target] || _ae.target === 'iss' || _ae.target === 'sun' || _ae.preset === 'planets' || _aeIsCraft(_ae.target)) return null;   // (a craft is slid across, the Sun and the Planets view zoomed, not held)
  var c = _aeTargetPos(), R = AE_TARGETS[_ae.target].surface, ha = _aeRayHit(a[0], a[1], c, R), hb = _aeRayHit(b[0], b[1], c, R);
  return ha && hb ? { a: _aeSub(ha, c), b: _aeSub(hb, c) } : null;
}
// The view turned until the fingers' two places stand either side of the midpoint again (their own midpoint on it: in a slanting view the place under the
// midpoint is not halfway between them), and turned about the line of sight until the line between them lies as the fingers' does (a turn of the view
// slants that line); answers how far apart they are drawn (px), or 0.
function _aePinchTurnTo(p, mx, my, ang) {
  var cam = _ae.gl.camera, sa, sb;
  for (var i = 0; i <= AE_PINCH_FIX_STEPS; i++) {
    _aePlaceCamera(); cam.updateMatrixWorld(true);
    var c = _aeTargetPos();
    sa = _aeProject(_aeAdd(c, p.hold.a)); sb = _aeProject(_aeAdd(c, p.hold.b));
    if (!sa || !sb || i === AE_PINCH_FIX_STEPS) break;
    var turn = _aeDragTurn(mx - (sa.x + sb.x) / 2, my - (sa.y + sb.y) / 2, _ae.roll, _aeDragK(), _ae.el_), off = ang - Math.atan2(sb.y - sa.y, sb.x - sa.x);
    _ae.twist = (_ae.twist || 0) + _aeDeg(Math.atan2(Math.sin(off), Math.cos(off)));
    _ae.az += turn.daz;
    _ae.el_ = _aeClamp(_ae.el_ + turn.del, -AE_MAX_ELEVATION, AE_MAX_ELEVATION);
  }
  return sa && sb ? Math.hypot(sa.x - sb.x, sa.y - sb.y) : 0;
}
// One move of a held pinch: the height until the fingers' places stand their spread apart, the view turned each time to keep the midpoint's place under it.
function _aePinchHeld(p, span, mx, my, ang) {
  var R = AE_TARGETS[_ae.target].surface;
  if (_ae.preset !== 'planets') _ae.preset = null;
  for (var k = 0; k < AE_PINCH_SPAN_STEPS; k++) {
    var apart = _aePinchTurnTo(p, mx, my, ang);
    if (!(apart > 0)) break;
    var d = _aeClampDist(R + (_ae.dist - R) * apart / span);
    if (Math.abs(d - _ae.dist) < 1e-12) break;
    _ae.dist = d;
  }
  _aePinchTurnTo(p, mx, my, ang);
  _aeMarkViews();
  _aeRedraw();
}
// Every finger forgotten: a mode change under a live touch can leave none to lift it.
function _aeInputReset() {
  _ae.pointers = {}; _ae.drag = null; _ae.pinch = null;
  var c = _aeById('ae-canvas');
  if (c) c.classList.remove('ae-dragging');
}
// The canvas's own listeners: bound again to the fresh canvas that replaces
// one whose context was given back (_aeDisposeGl).
function _aeBindCanvas(canvas) {
  if (typeof ZimiCap !== 'undefined') ZimiCap.watchContext(canvas, _aeContextLost);   // a context taken away: rebuilt, or the plain line
  // A press on a name in the picture is the globe's: the names take no pointer at all (AE_SCENE_TAPS: pointer-events none), so every
  // touch lands on the canvas, the one element that holds its pointers. Rerouting a press that landed on a label (a synthetic pointerdown and
  // a capture moved to the canvas) worked with a mouse and Chromium's touch but not on an iPhone, where a touch stays with the element it
  // started on: the drag never reached the globe. A tap (no movement past AE_TAP_SLOP_PX) is the name's under the finger (_aeSceneTapAt); Enter on
  // a focused name still clicks it.
  canvas.addEventListener('pointerdown', function (e) {
    _aeLetGo();
    if (_ae.stand && typeof _aeStandWalkDown === 'function' && _aeStandWalkDown(e)) { canvas.setPointerCapture(e.pointerId); return; }   // on foot the left thumb is a stick
    // A touch that only puts a sheet away (its outside-tap handler runs first) does not put the controls away too.
    _ae.tapBare = _aeBareAllowed() && performance.now() - (_ae.sheetShutAt || -Infinity) > AE_SHEET_SHUT_MS;
    if (_ae.setOpen) _aeShowSettings(false);   // a touch on the globe puts the panel away
    if (_ae.spin) return;                       // side by side: nothing to turn
    _aeHideHint();                              // and the hint has done its job
    canvas.setPointerCapture(e.pointerId);
    Object.keys(_ae.pointers).forEach(function (id) { if (!canvas.hasPointerCapture(+id)) delete _ae.pointers[id]; });   // a finger the canvas no longer holds is gone, not a ghost second finger
    _ae.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(_ae.pointers);
    if (ids.length === 1) {
      // A right or shift drag with a mouse slides the view as two fingers do (never a tap).
      var slide = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey);
      _ae.drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: slide, pan: slide, tag: _aeSceneTapAt(e.clientX, e.clientY) };
      if (_ae.drag.tag) _ae.drag.lm = _ae.drag.tag._aeLm || null;   // the place the label named as it was pressed (the labels are a pool, renamed as the globe turns)
    } else if (ids.length === 2) {
      var a = _ae.pointers[ids[0]], b = _ae.pointers[ids[1]];
      var span0 = Math.hypot(a.x - b.x, a.y - b.y);
      var cr = canvas.getBoundingClientRect();
      _ae.pinch = { span: span0, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, span0: span0, dist0: _ae.dist, zoom0: _ae.stand ? _ae.stand.zoom : null, ang: Math.atan2(b.y - a.y, b.x - a.x), turned: 0,
        left: cr.left, top: cr.top, hold: _aePinchHold([a.x - cr.left, a.y - cr.top], [b.x - cr.left, b.y - cr.top]) };
      _ae.drag = null;
    }
    canvas.classList.add('ae-dragging');
    _aeKick();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (_ae.stand && typeof _aeStandWalkMove === 'function' && _aeStandWalkMove(e)) return;
    if (!_ae.pointers[e.pointerId]) { if (!_ae.spin) _aeHover(e); return; }
    _ae.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(_ae.pointers);
    if (_ae.pinch && ids.length >= 2) {
      var a = _ae.pointers[ids[0]], b = _ae.pointers[ids[1]];
      var span = Math.hypot(a.x - b.x, a.y - b.y), P = _ae.pinch;
      if (P.hold && !_ae.fly && span > 0) {   // on the body: the ground under the fingers stays under them (their turn too: the picture turns with them, no dead zone)
        _aePinchHeld(P, span, (a.x + b.x) / 2 - P.left, (a.y + b.y) / 2 - P.top, Math.atan2(b.y - a.y, b.x - a.x));
        P.span = span; P.mx = (a.x + b.x) / 2; P.my = (a.y + b.y) / 2;
        return;
      }
      if (span > 0 && _ae.pinch.span > 0) _aePinchZoom(_ae.pinch, span);
      if (!_ae.pinch) return;   // the zoom pulled the Planets view out onto the orrery: the view, and its pinch, are gone
      _ae.pinch.span = span;
      // The midpoint slides the view, whether or not the fingers also spread or close; not mid-flight, where a zoom
      // lets the flight finish (a pan would end it where it stands).
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (!_ae.fly && !_ae.stand) _aePanBy(mx - _ae.pinch.mx, my - _ae.pinch.my);
      _ae.pinch.mx = mx; _ae.pinch.my = my;
      _aeTwist(_ae.pinch, Math.atan2(b.y - a.y, b.x - a.x));
    } else if (_ae.drag) {
      var dx = e.clientX - _ae.drag.x, dy = e.clientY - _ae.drag.y;
      _ae.drag.x = e.clientX; _ae.drag.y = e.clientY;
      if (Math.hypot(e.clientX - _ae.drag.x0, e.clientY - _ae.drag.y0) > AE_TAP_SLOP_PX) _ae.drag.moved = true;
      if (_ae.stand) _aeStandLook(dx, dy);   // on the ground a drag turns the head
      else if (_ae.drag.pan) _aePanBy(dx, dy);
      else _aeDragBy(dx, dy);
    }
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  function end(e) {
    if (typeof _aeStandWalkEnd === 'function' && _aeStandWalkEnd(e)) return;
    if (!_ae.pointers[e.pointerId]) return;
    delete _ae.pointers[e.pointerId];
    var left = Object.keys(_ae.pointers).length;
    if (left < 2) _ae.pinch = null;
    if (left === 0) canvas.classList.remove('ae-dragging');
    var tapped = _ae.drag && !_ae.drag.moved && left === 0 && e.type === 'pointerup' ? _ae.drag : null;
    if (left === 0) _ae.drag = null;   // (let go before the tap acts: a tap that throws leaves nothing held)
    if (tapped) {
      var r = canvas.getBoundingClientRect();
      if (tapped.lm) _aeLmOpen(tapped.lm.b, tapped.lm.row);   // a tap on a name is that name's, as it was when the finger came down
      else if (tapped.tag) tapped.tag.click();
      else _aeTap(e.clientX - r.left, e.clientY - r.top);
    }
    if (left === 1) {
      var p = _ae.pointers[Object.keys(_ae.pointers)[0]];
      _ae.drag = { x: p.x, y: p.y, x0: p.x, y0: p.y, moved: true };
    }
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);   // a capture ended without a pointerup (iOS, when what is under the finger stops being drawn): that finger is up
  canvas.addEventListener('wheel', function (e) {
    _aeLetGo();
    e.preventDefault();
    if (_ae.stand) _aeStandZoom(Math.exp(e.deltaY * AE_WHEEL_ZOOM));
    else if (!_ae.spin) _aeZoomBy(Math.exp(e.deltaY * AE_WHEEL_ZOOM));
  }, { passive: false });
}
function _aeRimPressKey() {
  var b = _aeById('ae-rim'), st = b && !b.hidden && b._st;
  if (!st || st.kind !== 'enter') return false;
  _aeRimPress('ae-rim');
  return true;
}
// Space puts the controls away or brings them back from anywhere in the view (the canvas need not have been clicked), except in a
// field, or on a button, link or menu that has focus (they keep their own Space).
var AE_OWN_SPACE = 'input,textarea,select,button,a,summary,[contenteditable],[role=button],[role=switch],[role=checkbox],[role=radio],[role=menuitem],[role=option]';
function _aeSpaceKey(e) {
  if ((e.key !== 'h' && e.key !== 'H') || !_aeIsOpen || e.ctrlKey || e.metaKey || e.altKey) return;   // H hides the controls (Space is the vehicles': jump, hop, rise)
  var t = e.target;
  if (t && t.closest && t.closest(AE_OWN_SPACE)) return;
  e.preventDefault();
  e.stopPropagation();
  _aeBare(!_aeBareOn());
}
// Time from the keyboard, anywhere in the view: ] faster and [ slower, a stop of the slider at a time (through real time and backwards), K pause or
// play, N back to now. Said in the slider's tooltip and once, the first time the capsule opens on a machine with a keyboard.
var AE_TIME_KEYS = { ']': 'up', '[': 'down', k: 'pause', K: 'pause', n: 'now', N: 'now' }, AE_TIME_KEYS_SEEN = 'zimi_time_keys_seen';
function _aeTimeStep(dir) {
  var S = ALM_RATE_STOPS, pos = _almRate === 0 ? ALM_RATE_REAL : _almPosOfRate(_almRate);
  var i = _aeClamp(dir > 0 ? Math.floor(pos + 1e-6) + 1 : Math.ceil(pos - 1e-6) - 1, 0, S.length - 1);
  _almClockSetRate(i === ALM_RATE_REAL ? 1 : S[i]);
}
// Whether a key goes to a field the person is typing in. Only a text field that is on the screen keeps its keys: a slider, a checkbox or a button
// that was clicked last (or a text field left hidden behind a closed sheet) must not swallow W A S D.
var AE_TEXT_INPUT_TYPES = /^(text|search|number|email|url|password|tel|date|datetime-local|time|month|week)$/;
function _aeTyping(t) {
  if (!t) return false;
  if (t.isContentEditable || t.tagName === 'SELECT') return true;
  if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') return false;
  if (t.tagName === 'INPUT' && !AE_TEXT_INPUT_TYPES.test(t.type)) return false;
  return !!(t.getClientRects && t.getClientRects().length);
}
function _aeTimeKey(e) {
  var act = AE_TIME_KEYS[e.key], t = e.target;
  if (!act || !_aeIsOpen || e.ctrlKey || e.metaKey || e.altKey || _ae.mission || typeof _almClockSetRate !== 'function') return;   // (a mission's clock is its own bar's)
  if (_aeTyping(t)) return;
  e.preventDefault(); e.stopPropagation();
  if (act === 'up' || act === 'down') _aeTimeStep(act === 'up' ? 1 : -1);
  else if (act === 'pause') { if (_almRate === 0) _almClockSetRate(_ae.keyRate || 1); else { _ae.keyRate = _almRate; _almClockSetRate(0); } }   // a stop, and play again at the rate it had
  else _aeNow();
}
// The first time the capsule opens where there is a keyboard and a pointer, one line says the keys.
function _aeTimeKeysOnce() {
  if (!(window.matchMedia && matchMedia('(hover:hover) and (pointer:fine)').matches) || _rawGet(AE_TIME_KEYS_SEEN)) return;
  try { localStorage.setItem(AE_TIME_KEYS_SEEN, '1'); } catch (e) {}
  _aeShowHint(_aeT('alm_time_keys'));
}
function _aeBindKeys() {
  document.addEventListener('keydown', _aeSpaceKey, true);
  document.addEventListener('keydown', _aeTimeKey, true);
  _ae.el.addEventListener('keydown', function (e) {
    _aeLetGo();
    // Escape shuts the gear's panel first, then leaves this view only; the
    // Almanac underneath stays open.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (_aeFullOn()) { _aeFullExit(); return; }
      if (_ae.site) { _aeSiteRise(); return; }
      if (_ae.info) { _aeCloseInfo(true); return; }
      if (_ae.setOpen) { _aeShowSettings(false); _aeById('ae-gear').focus({ preventScroll: true }); return; }
      var lv = _aeRimState();
      if (lv && lv.kind === 'leave' && !(_ae.stand || _ae.standPending)) { lv.run(); return; }   // one level back out of a mode that registered
      if (!(_ae.stand || _ae.standPending || _ae.spin)) _ae.closedByKey = true;
      _aeBack();
      return;
    }
    if (e.target !== _aeById('ae-canvas') || _ae.spin) return;   // side by side has no camera to move
    if (_ae.stand) { if (_aeStandKey(e)) e.preventDefault(); return; }
    if (/^[wasd]$/i.test(e.key) && !(e.ctrlKey || e.metaKey || e.altKey) && _aeRimPressKey()) { e.preventDefault(); return; }   // W A S D while just looking: the rim button's way in
    var handled = true, arrow = AE_KEY_ARROWS[e.key];
    // An arrow turns the globe as a drag that way on the screen would.
    if (arrow) { var turn = _aeDragTurn(arrow[0], arrow[1], _ae.roll, AE_KEY_TURN); _aeTurnBy(turn.daz, turn.del); }
    else if (e.key === '+' || e.key === '=') _aeZoomBy(1 / AE_KEY_ZOOM);
    else if (e.key === '-' || e.key === '_') _aeZoomBy(AE_KEY_ZOOM);
    else handled = false;
    if (handled) e.preventDefault();
  });
}

// After the clock jumps: the cached orbits belong to the old instant, and the Almanac's loops (its repaint restarts
// them) stay paused under the view. A jump to a place or an event is a jump at real pace: the clock goes back to it.
function _aeJumped() {
  _ae.ringsAt = _ae.moonPathAt = null;
  _aePauseAlmanac();
  if (typeof _almClockSetRate === 'function') _almClockSetRate(1);
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
  _aeSettlePage(new Date(ms));
  _aeJumped();
}
// Now for everything the clock is made of: the page, the orrery (its rides) and this view go back to now with it.
function _aeNow() {
  if (typeof _orreryClockReset === 'function') _orreryClockReset();
  _aeSettlePage(null);
  _aeJumped();
}

// ── The band: the top row while the search sheet is up ──
// Where you are and what is shown there, in one row: the way out, the name (a tap opens its facts), a round control for each layer
// (they read and write AE_LAYERS, so they are never a second copy of the corner's buttons), a chevron for the satellites' filters, and
// the gear. The picture above the sheet is the body in view; the sheet below it is where to go next.
var AE_BAND_LONG_NAME = 16;   // a name longer than this is set smaller before it ellipsizes
function _aeGoUp() { var e = _aeById('ae-go'); return !!e && !e.hidden; }
function _aeBandBuild() {
  var band = _aeById('ae-band');
  if (band || !_ae || !_ae.el) return band;
  band = document.createElement('div');
  band.id = 'ae-band'; band.className = 'ae-band'; band.hidden = true;
  band.setAttribute('role', 'group'); band.setAttribute('aria-label', _aeT('alm_world_layers'));
  var close = _almEsc(_aeT('alm_tm_close')), gear = _almEsc(_aeT('alm_world_settings'));
  band.innerHTML = '<button type="button" class="ae-btn ae-round ae-band-out" id="ae-band-out" aria-label="' + close + '" title="' + close + '">' + AE_BACK_SVG + '</button>' +
    '<button type="button" class="ae-band-name" id="ae-band-name"></button><div class="ae-band-tiles" id="ae-band-tiles">' +
    AE_LAYERS.filter(function (L) { return !L.edge; }).map(function (L) {
      var label = _almEsc(_aeT(L.key));
      return '<button type="button" class="ae-btn ae-round" data-ae-layer="' + L.id + '" aria-pressed="false" aria-label="' + label + '" title="' + label + '">' + L.glyph + '</button>' +
        (L.drawer ? '<button type="button" class="ae-btn ae-round ae-band-cv" data-ae-drawer="' + L.drawer + '" aria-expanded="false" aria-label="' + _almEsc(_aeT('alm_sats_filters')) + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' : '');
    }).join('') + '</div>' +
    '<button type="button" class="ae-btn ae-round ae-band-gear" id="ae-band-gear" aria-expanded="false" aria-label="' + gear + '" title="' + gear + '">' + (typeof _gearSvg === 'string' ? _gearSvg : '⚙') + '</button>';
  _ae.el.appendChild(band);
  _aeById('ae-band-out').onclick = function () { _aeShowGo(false); };
  _aeById('ae-band-name').onclick = function () { var k = _aeFactsKey(); _aeShowGo(false); if (_ae.info) _aeCloseInfo(false); _aeOpenInfo(k); };
  _aeById('ae-band-gear').onclick = function () { _aeDrawerToggle('set'); };
  AE_LAYERS.filter(function (L) { return !L.edge; }).forEach(function (L) {
    band.querySelector('[data-ae-layer="' + L.id + '"]').onclick = function () { if (L.state && L.state() === 'failed') L.retry(); else L.set(!L.on()); };
    var cv = L.drawer && band.querySelector('[data-ae-drawer="' + L.drawer + '"]');
    if (cv) cv.onclick = function () { _aeDrawerToggle(L.drawer); };
  });
  return band;
}
// The band says what is true now: the name, which layers mean something here and which are on, the gear's dot while an offer waits.
function _aeBandPaint() {
  var band = _aeById('ae-band');
  if (!band || band.hidden) return;
  var name = _aeById('ae-band-name'), where = _aeWhereName(), factsOf = _aeFactsKey();
  if (name.textContent !== where) name.textContent = where;
  name.toggleAttribute('data-long', where.length > AE_BAND_LONG_NAME);
  var facts = _aeHasFacts(factsOf) && (!_aeIsProbe(factsOf) || !!_aeTracks);
  name.disabled = !facts;
  AE_LAYERS.filter(function (L) { return !L.edge; }).forEach(function (L) {
    var t = band.querySelector('[data-ae-layer="' + L.id + '"]'), can = _aeLayerCan(L), on = String(!!L.on());
    if (t.hidden === can) t.hidden = !can;
    if (t.getAttribute('aria-pressed') !== on) t.setAttribute('aria-pressed', on);
    var st = L.state ? L.state() : '';
    if ((t.getAttribute('data-state') || '') !== st) {
      t.toggleAttribute('data-state', !!st); if (st) t.setAttribute('data-state', st);
      t.setAttribute('aria-busy', String(st === 'loading'));
      var label = _aeT(st === 'failed' ? 'alm_sats_failed' : L.key);
      t.setAttribute('aria-label', label); t.title = label;
    }
    var cv = L.drawer && band.querySelector('[data-ae-drawer="' + L.drawer + '"]');
    if (cv) {
      var show = can && on === 'true', open = String(_aeDrawerKind() === L.drawer);
      if (cv.hidden === show) cv.hidden = !show;
      if (cv.getAttribute('aria-expanded') !== open) cv.setAttribute('aria-expanded', open);
    }
  });
  var gearOpen = String(!!_ae.setOpen), bg = _aeById('ae-band-gear');
  if (bg.getAttribute('aria-expanded') !== gearOpen) bg.setAttribute('aria-expanded', gearOpen);
  var hd = _aeById('ae-hd'), fr = _aeById('ae-note-fresh');
  _aeById('ae-band-gear').classList.toggle('ae-dot', !!((hd && !hd.hidden) || (fr && !fr.hidden)));   // an action waits behind the gear: HD offered, data stale
}
function _aeBandShow(on) {
  var band = on ? _aeBandBuild() : _aeById('ae-band');
  if (!band) return;
  band.hidden = !on;
  if (_ae.el) _ae.el.classList.toggle('ae-go-up', !!on);
  var find = _aeById('ae-find');   // the search circle is the sheet's X while it is up
  if (find) {
    var name = _aeT(on ? 'alm_tm_close' : 'search');
    find.setAttribute('aria-label', name); find.title = name; find.setAttribute('aria-expanded', String(!!on));
  }
  _aeBandPaint();
}
function _aeWorldShow(on) { _aeShowGo(!!on); }
var AE_TILES_SPIN_MS = 500;   // loading this long shows the spinner
// Surface tiles on their way: in flight, not merely queued. A queue is only drained while the orbit scene draws it, so one left behind by a
// walk on the surface (or a parked view) kept the spinner turning for good (Mercury and the Earth).
function _aeTilesBusy() { var S = _ae && _ae.gl; return !!(S && S.hd && S.hd.loading > 0 && !_aeHdAway(S.hd)); }
function _aeWherePaint() {
  if (_ae.el && _ae.el.classList) _ae.el.classList.toggle('ae-solar', _ae.preset === 'planets' && !_ae.spin);   // the solar system view: no UFO, Side by side offered
  var nb = _aeById('ae-north'), tw = _ae.twist || 0;
  if (nb) {
    var showN = Math.abs(tw) > AE_NORTH_MIN_RAD;   // only after a twist (and only where the layer has a place for it)
    _aeHudCan(AH_NORTH, showN);
    if (showN && nb.firstChild && nb.firstChild.style) nb.firstChild.style.transform = 'rotate(' + tw + 'rad)';
  }
  _aeHudInfoPaint();
  var el = _aeById('ah-info');
  if (!el || !el.classList) return;
  // A small spinner at the line's foot, no words, while surface tiles have been loading for more than half a second.
  var busy = _aeTilesBusy() || !!_ae.standPending, now = performance.now();   // (the ground being built after the flight is a wait the spinner says)
  if (busy) { if (!_ae.tilesSince) _ae.tilesSince = now; } else _ae.tilesSince = 0;
  var spin = !!_ae.tilesSince && now - _ae.tilesSince > AE_TILES_SPIN_MS;
  if (el.classList.contains('ae-loading') !== spin) el.classList.toggle('ae-loading', spin);
  if (busy && !spin) { clearTimeout(_ae.spinTimer); _ae.spinTimer = setTimeout(function () { _ae && _aeRedraw(); }, AE_TILES_SPIN_MS + 30); }   // a parked view asks for the frame that shows it
}
// The time chip opens into the capsule (slider, rate) and shuts again: ~180 ms, none under reduced motion.
var AE_PIN_ANIM_MS = 180;
function _aePinSet(on) {
  var pin = _aeById('ae-pin');
  if (!pin || !!_ae.pinOpen === !!on) return;
  _ae.pinOpen = !!on;
  pin.classList.toggle('ae-pin-open', !!on);
  var l = pin.querySelector('.alm-ck-l');
  if (l) { l.setAttribute('aria-expanded', String(!!on)); l.setAttribute('aria-label', _aeT(on ? 'alm_chip_close' : 'alm_chip_open')); }
  if (typeof _almReduceMotion === 'function' && !_almReduceMotion()) {
    pin.classList.remove('ae-pin-growing', 'ae-pin-shrinking');
    void pin.offsetWidth;   // the animation starts afresh
    pin.classList.add(on ? 'ae-pin-growing' : 'ae-pin-shrinking');
    clearTimeout(_ae.pinAnim);
    _ae.pinAnim = setTimeout(function () { pin.classList.remove('ae-pin-growing', 'ae-pin-shrinking'); if (_ae.gl) { _aeMeasureFoot(); if (_ae.infoShift) _ae.infoShift = _aeInfoShiftTarget(); _aeRedraw(); } }, AE_PIN_ANIM_MS + 30);
  }
  if (typeof _almClockOpenUp === 'function') _almClockOpenUp(!!on);   // (it paints the clock in the form the chip or the capsule wants)
  if (on) { _aeTimeKeysOnce(); var rng = pin.querySelector('.alm-spd-range'); if (rng && !rng.title) rng.title = _aeT('alm_time_keys'); }
  _aeMeasureFoot();
  if (_ae.infoShift) _ae.infoShift = _aeInfoShiftTarget();   // the picture's centre follows the room the bar leaves
  _aeRedraw();
}
// A tap on the chip opens it; on the open capsule's own face, or anywhere away from it, shuts it. Now, the slider, the where line and a
// part of the date being typed are their own taps.
function _aePinClick(e) {
  var pin = _aeIsOpen && _ae.el ? _aeById('ae-pin') : null, t = e.target;
  if (!pin || !t || !t.closest) return;
  if (!pin.contains(t)) { if (_ae.pinOpen) _aePinSet(false); return; }
  if (t.closest('.alm-ck-now, .alm-spd, .alm-ck-pop')) return;
  if (_ae.pinOpen && t.closest('.ep')) return;
  e.stopPropagation(); e.preventDefault();
  _aePinSet(!_ae.pinOpen);
}
function _aePinKey(e) {
  if (!_aeIsOpen || !_ae.pinOpen || e.defaultPrevented) return;   // (Escape in a date being typed was the editor's: it has dealt with it)
  if (e.key === 'Escape') { _aePinSet(false); e.stopPropagation(); }
}
function _aePinBind() {
  var pin = _aeById('ae-pin'), l = pin && pin.querySelector ? pin.querySelector('.alm-ck-l') : null;
  if (l) { l.setAttribute('role', 'button'); l.setAttribute('tabindex', '0'); l.setAttribute('aria-expanded', 'false'); l.setAttribute('aria-label', _aeT('alm_chip_open')); }
  document.addEventListener('click', _aePinClick, true);
  document.addEventListener('keydown', _aePinKey, true);
  if (l) l.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === l) { e.preventDefault(); _aePinSet(!_ae.pinOpen); } });
}
function _aeBindControls() {
  _aeHudBuild();
  _aePinBind();
  // A press outside the settings puts them away (the gear is its own toggle).
  if (typeof _almDismissable === 'function') {
    _almDismissable('ae-set', function () { _aeShowSettings(false); },
      function (target) { return !!target.closest && !!target.closest('#ae-gear, #ae-band-gear'); }, 'ae-gear');
  }
  _aeById('ae-back').onclick = function () { var b = _aeById('back-btn'); if (b) b.click(); else _aeClose(); };   // the page's own way back (it names where it goes), else close
  _aeById('ae-sbs').onclick = function () { _aeGoPick(AE_SPIN_KEY); };
  _aeById('ae-north').onclick = _aeNorthUp;
  _aeById('ae-chips').addEventListener('scroll', _aeHudTrack, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(function () { _aeChipsEdge(_aeById('ae-chips')); }).observe(_aeById('ae-chips'));
  _aeById('ae-find').onclick = function () { if (_aeGoUp()) _aeShowGo(false); else _aeShowGo(true, undefined, true); };   // search: the Go sheet, its field raised; with it up, the X puts it away
  _aeById('ae-mini').onclick = function () { _aePreset('planets'); };
  _aeById('ae-views').onclick = function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ae-view]') : null;
    var k = b && b.getAttribute('data-ae-view');
    if (!k) return;
    _aePreset(k === AE_SPIN_KEY && _ae.spin ? 'planets' : k);   // Side by side again: back to the planets
  };
  _aeById('ae-go').onclick = function (e) {
    var mp = e.target && e.target.closest ? e.target.closest('[data-ae-map]') : null;
    if (mp) {
      var found = _ae.placeFound[+mp.getAttribute('data-ae-map')];
      _mapHere().then(function (m) { if (m && found) m.go(found.lat, found.lon, found.name); });
      return;
    }
    var pl = e.target && e.target.closest ? e.target.closest('[data-ae-place]') : null;
    if (pl) { _aePlacePick(_ae.placeFound[+pl.getAttribute('data-ae-place')]); return; }
    var pill = e.target && e.target.closest ? e.target.closest('[data-ae-pill]') : null;
    if (pill) { _aeGoJump(pill.getAttribute('data-ae-pill')); return; }
    var several = e.target && e.target.closest ? e.target.closest('[data-ae-choose]') : null;
    if (several) { if (typeof _aeSentChoose === 'function') _aeSentChoose(several); return; }
    var mode = e.target && e.target.closest ? e.target.closest('[data-ae-gomode]') : null;
    if (mode) { _aeGoSetView(mode.getAttribute('data-ae-gomode')); _aeGoRender(); return; }
    var b = e.target && e.target.closest ? e.target.closest('[data-ae-go]') : null;
    if (b) _aeGoPick(b.getAttribute('data-ae-go'));
  };
  if (typeof _almDismissable === 'function') {
    _almDismissable('ae-go', function () { _aeShowGo(false); },
      function (target) { return !!target.closest && !!target.closest('.topbar-search, #ae-band, #ae-drawer, #ae-find'); }, 'q');   // (the band is the sheet's top row, the drawer hangs under it, the search circle is its X and shuts it by its own click)
  }
  _aeById('ae-clock').addEventListener('pointerdown', function () { if (_ae.spin) _ae.spin.autoRun = false; });   // the person's own speed: leaving leaves the date where it ran to
  _aeById('ae-spin-same').onclick = function () { _aeSpinSetSame(!_aeSpinSame()); };
  _aeById('ae-spin').onclick = function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ae-spin]') : null;
    if (!b) return;
    // A planet tapped: flown to; in full screen, where there is nothing to read, it blinks.
    if (!_aeFullOn()) { _aePreset(b.getAttribute('data-ae-spin')); return; }
    var c = _ae.gl.spin.cells.filter(function (x) { return x.b.key === b.getAttribute('data-ae-spin'); })[0];
    if (c && _aeSpinFacesOn()) _aeSpinBlink(c);
  };
  _ae.el.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-ae-faces],[data-ae-full]') : null;
    if (!t || !_ae.spin) return;
    if (t.hasAttribute('data-ae-faces')) _aeSpinSetFaces(!_aeSpinFacesOn());
    else if (t.getAttribute('data-ae-full') === 'enter') _aeFullEnter();
    else _aeFullExit();
  });
  _aeById('ae-fly-btn').onclick = _aeFlyToggle;   // in or out: it is lit while the ship flies
  _aeById('ae-locate').onclick = _aeLocateMe;
  _aeById('ae-rim').onclick = function (e) { _aeRimPress('ae-rim', e); };
  _aeById('ae-cam').onclick = function (e) { _aeRimPress('ae-cam', e); };
  _aeById('ae-info-btn').onclick = function () { if (_ae.info) _aeCloseInfo(false); else _aeOpenInfo(_aeFactsKey()); };   // (the arrival is marked a frame after the flight ends: the world in view is the same one)
  _aeById('ae-gear').onclick = function () { _aeShowSettings(!_ae.setOpen); };
  AE_LAYERS.forEach(function (L) { _aeById(L.btn).onclick = L.press || function () { L.set(!L.on()); }; });
  _aeById('ae-fresh').onclick = _aeGetFresh;
  _aeById('ae-note-fresh').onclick = _aeGetFresh;
  _aeById('ae-hd-get').onclick = _aeHdGet;
  _aeById('ae-hd-later').onclick = _aeHdNotNow;
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
    // Hidden with the view closed, the Almanac keeps no 3D scene, maps or context: a phone discards a page that holds them
    // (the next open builds the scene afresh, as it does after the Almanac was left).
    if (document.hidden && !_aeIsOpen) { _aeDisposeGl(); return; }
    if (document.hidden && _aeIsOpen) { _aeParkGl(); return; }   // open and away: the page's weight goes back too (a phone may discard it)
    if (!_aeIsOpen) return;
    if (!_ae.gl) { _aeUnparkGl(); return; }
    // The Almanac resumes its own loops on return; the view covers them.
    setTimeout(_aePauseAlmanac, 0);
    if (typeof _almFocus !== 'undefined' && !_almFocus) _almClockPaint();   // back at real time: the pill reads now, not when the page was left
    _aeRedraw();
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
  if (text && _ae && _ae.capStatic && typeof ZimiCap !== 'undefined') { ZimiCap.staticLine(m); _aeStaticGlobe(); }   // the reason and the one tap (Full), over the Earth lit as it is now
  if (_ae && _ae.el) _ae.el.classList.toggle('ae-blank', !!text);
}

// ── Ready, when the Moon is touched ──
// three.js, the scene and its maps are made ready as soon as someone points at or touches the hero (or opens the
// view), so a tap on the Moon swaps it for this one in the same frame. Not behind the page: a page that is only looked
// at never loads them (almanac.js _almMoonPrepare). Ready means a context with its shaders compiled and its maps
// uploaded, drawing to a single pixel until the view opens.
var _aePreparing = null;
// ── Capability levels (capability.js) ──
var AE_FPS_SLACK_MS = 3;   // a frame this early is still on time (the display's rate does not divide the cap evenly)
function _aeCapGet(key, dflt) { return typeof ZimiCap !== 'undefined' ? ZimiCap.get(key) : dflt; }
var AE_STATICGLOBE_JS = _almAsset('/static/almanac-staticglobe.js');
// The view set aside shows only its line, its one button and the way back, over the Earth drawn once (almanac-staticglobe.js).
function _aeStaticGlobe() {
  if (!_ae || !_ae.el) return;
  _ae.el.classList.add('ae-static');
  _aeHudRender();   // set aside, the corner keeps nothing of the live view's
  if (typeof _asgDraw === 'function') { _asgDraw(_ae.el); return; }
  _aeLoadJsOnce(AE_STATICGLOBE_JS, function () { if (_ae.capStatic && typeof _asgDraw === 'function') _asgDraw(_ae.el); });
}
function _aeNoGlText() { return _aeT(_ae && _ae.capStatic ? 'cap_static' : 'alm_earth_nogl'); }
// What the 3D scenes on the canvas give up before the GL behind them goes.
function _aeDropScenes() {
  try {
    if (_ae.site) _aeSiteLeave(true);
    if (_ae.mission) _amStop(true);
    if (_ae.ship || _ae.shipParked) _afStop(true);
    if (_ae.stand || _ae.standPending) _aeStandDrop(true);
  } catch (e) {}
}
// The scenes and the GL behind them go back, and nothing is left half prepared.
function _aeGlLetGo() {
  _aeDropScenes();
  try { _aeDisposeGl(); } catch (e) { _ae.gl = null; _ae.ready = false; }
  _aePreparing = null;
}
// The view sets itself aside (software drawing, a device too slow, a GPU that keeps resetting): the GPU goes back, the plain
// line says so, and the gear (Full) is the way to try again.
function _aeCapAside() {
  if (!_ae) return;
  _ae.failed = _ae.capStatic = true;
  _aeGlLetGo();
  if (_aeIsOpen) { _aeCoverAlmanac(true); _aeMessage(_aeNoGlText()); }
}
// The GPU took the context back. The scene is rebuilt on a fresh canvas and the view opens again where it was; losses in a
// row mean this device cannot hold it, and the view gives way.
function _aeContextLost(give) {
  if (!_ae || !_ae.gl) return;
  if (give) { _aeCapAside(); return; }
  if (document.hidden && _aeIsOpen) { _aeParkGl(true); return; }   // a phone takes its contexts as it goes away: the view waits and is built on return, not now
  // It comes back to the view it was in (the station, a planet), the way a return from the background does, not on the Earth.
  if (_aeIsOpen) _ae.parked = _aeLinkParts();
  _aeGlLetGo();
  if (_aeIsOpen) { if (_ae.parked) _aeUnparkGl(); else _aeOpenWhenReady(); }
}
// A phone keeps a page alive in the background only while the whole device has memory to spare: iOS discards a heavy one and Safari
// reloads it on return. The open view holds the maps, the scene and a GPU context, the bulk of the page's weight, so
// on a touch device it is given back while hidden and built again, at the same place, on return. A desktop tab keeps it (it is not
// discarded for memory the way a phone's is, and a rebuild on each switch would cost more than it saves).
function _aeMemoryTight() { return typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches; }
// What parks is the view's address (_aeLinkParts: the view, the camera, the mode): the page's own address says it while the view is away
// (a reload then lands back in it), and the same words put it back on return, with no flight.
function _aeParkGl(force) {
  if (!_ae || !_ae.gl || !(force || _aeMemoryTight())) return;
  _ae.parked = _aeLinkParts();
  _aeGlLetGo();
}
function _aeUnparkGl() {
  if (!_ae || _ae.gl || !_ae.parked || _ae.failed) return;
  var parts = _ae.parked;
  _ae.parked = null;
  _ae.fromHero = _ae.fromOrrery = false;   // it was opened that way once: the return is not that opening's hand-in
  _aeLinkWant = _almLinkParse('#almanac?' + parts.join('&'));
  if (typeof ZimiCap !== 'undefined') { ZimiCap.hold(); ZimiCap.resetFrames('earth'); }   // building again is not the device being slow
  _aeOpenWhenReady();
}
// Prepare the scene, then enter it (the view is open and covers the page): the end of _aeShow, and a rebuild's.
function _aeOpenWhenReady() {
  _aeMessage(_aeT('alm_earth_loading'));
  _aePrepare(true).then(function (ok) {
    if (!_aeIsOpen) return;
    if (!ok) {
      _aeMessage(_ae.failed ? _aeNoGlText() : _aeT(navigator.onLine === false ? 'alm_earth_unavailable' : 'alm_earth_failed'));
      return;
    }
    _aeMessage('');
    _aeResize();
    _aeEnter();
    _aeKick();
  });
}
function _aeCapEvent(evt) {
  if (!_ae) return;
  if (evt === 'fallback') { _aeCapAside(); return; }
  if (evt === 'setting' && _ae.capStatic && ZimiCap.view3d() === 'open') {   // Full or Light on a device Auto set the view aside on: it tries
    _ae.failed = _ae.capStatic = false;
    _ae.el.classList.remove('ae-static');
    _aeHudRender();
    var pic = _aeById('ae-static-globe');
    if (pic) pic.remove();
    if (_aeIsOpen) _aeOpenWhenReady();
    return;
  }
  if (evt === 'setting' && !_ae.capStatic && ZimiCap.view3d() === 'static') { _aeCapAside(); return; }
  var S = _ae.gl;
  if (!S) return;
  S.renderer.setPixelRatio(Math.min(S.dpr, ZimiCap.dprCap(_ae.stand ? 'stand' : 'earth'), _ae.sunBig ? AE_SUN_DPR_MAX : Infinity));
  _aeResize();
}

function _aeEnsure() {
  if (_ae) return true;
  _aeCss('ae-style', AE_CSS);
  var el = _aeBuildDom();
  if (!el) return false;
  _ae = _aeNewState(el);
  if (typeof ZimiCap !== 'undefined') {
    ZimiCap.on(_aeCapEvent);
    if (ZimiCap.view3d() === 'static') _ae.failed = _ae.capStatic = true;
    if (ZimiCap.webgl2 && !ZimiCap.webgl2()) openAlmanacEarth.unsupported = true;   // no WebGL at all: the orrery says so and stays, as when the context itself could not be made
  }
  _aeBindControls();
  _aeBindKeys();
  _aeBindInfo();
  _aeBindCanvas(_aeById('ae-canvas'));
  return true;
}
function _aeReady() { return !!(_ae && _ae.gl && _ae.ready); }
// Resolves true when the view can draw; false when it cannot (no WebGL, or
// the day map, without which there is no view, did not load).
// Prepared in slices, a breath between (app.js quietBreath), so no one task holds the main thread: three.js, the
// context and scene, the maps (decoded off the main thread; uploaded one to a slice below), the shaders. `urgent`
// (the person touched the Moon, or the view is opening) takes the breaths out: the next task, not the next quiet.
var _aeUrgent = false;
function _aeBreath() { return _aeUrgent ? new Promise(function (r) { setTimeout(r, 0); }) : quietBreath(); }
function _aePrepare(urgent) {
  if (!_aeEnsure()) return Promise.resolve(false);
  if (_aeReady()) return Promise.resolve(true);
  if (_ae.failed) return Promise.resolve(false);
  // Only while there is preparing to hurry: a hurry left over would take the breaths out of the next Almanac's.
  if (urgent) _aeUrgent = true;
  if (_aePreparing) return _aePreparing;
  _ae.loading = true;
  _aePreparing = _aeLoadThree().then(function (THREE) {
    return _aeBreath().then(function () { return THREE; });
  }).then(function (THREE) {
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
    _aeResize();   // the canvas is the shape it is shown at before anything is drawn on it (a default-sized first frame is stretched tall)
    return _aeLoadMaps(S).then(function (dayMapIn) {
      if (_ae.gl !== S) return false;     // the Almanac closed while it loaded
      if (!dayMapIn) { _aeDisposeGl(); return false; }
      return _aeWarmSliced(S, true);
    });
  }).catch(function () { return false; }).then(function (ok) {
    _ae.loading = false;
    _aePreparing = null;
    _aeUrgent = false;
    return ok;
  });
  return _aePreparing;
}
// Compile every shader and upload every map before the view shows, at a pixel's cost, so its first frame does neither,
// a task each: the scene set, the shaders (compileAsync where three has it: the driver compiles them off
// the main thread), the first render, then each map's upload.
function _aeWarmSliced(S, first) {
  // The first preparation carries on when the view opens meanwhile (a cold Orrery or sky open waits on it: that is
  // what the warming is for). A later one (a sharper map landing) stops once the view is open, which draws it anyway.
  var live = function () { return _ae.gl === S && (first || !_aeIsOpen); };
  var slice = function (fn) { return _aeBreath().then(function () { if (live()) fn(); }); };
  if (!live()) { _ae.ready = true; return Promise.resolve(true); }
  return slice(function () {
    _ae.scene = _aeSceneAt(_aeDisplayMs());
    _aeUpdate(_ae.scene.ms);
  }).then(function () {
    return _aeBreath().then(function () {
      if (!live()) return;
      return S.renderer.compileAsync ? S.renderer.compileAsync(S.scene, S.camera) : S.renderer.compile(S.scene, S.camera);
    });
  }).then(function () {
    return slice(function () { _aeResize(); S.renderer.render(S.scene, S.camera); });
  }).then(function () {
    // three uploads a texture when a mesh using it is drawn, and the Moon is out of the frustum at the warm render: its
    // 4096 map (8 MB) went up in the swap's first frame (WebKit, real GPU: a 155 ms frame mid-drag). Each map goes up here.
    var maps = [S.earthUni.dayMap, S.earthUni.nightMap, S.moonUni.moonMap], chain = Promise.resolve();
    maps.forEach(function (u) {
      chain = chain.then(function () { return slice(function () { if (u.value && S.renderer.initTexture) S.renderer.initTexture(u.value); }); });
    });
    return chain;
  }).then(function () {
    if (_ae.gl !== S) return false;
    _ae.ready = true;
    return true;
  });
}
// ── Open and close ──
// The swap's frames: e is how far the camera has come from the hero's (0)
// to the view's (1). The page dims behind the Moon by it, what is not the
// Moon (the stars, the Sun, orbits, satellites) comes in by it, and the
// controls come up over its last part. Under reduced motion the view does
// not fly: it fades in over the page, and out.
function _aeHandApply(h, e) {
  if (h.orrery) { _aeOrreryApply(h, e); return; }
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
  ['opacity', 'background-color', '--ae-ui', 'clip-path'].forEach(function (p) { _aeStyleOff(_ae.el, p); });
  _ae.el.classList.remove('ae-hand');
}
// Advance a swap; returns what to do once this frame is drawn, on its last.
function _aeStepHand(now) {
  var h = _ae.hand;
  if (!h) return null;
  var p = _aeClamp((now - h.start) / h.ms, 0, 1), k = h.orrery ? p : _aeEaseOut(p);   // the orrery's lift paces its own phases
  _aeHandApply(h, h.dir > 0 ? h.e0 + (1 - h.e0) * k : h.e0 * (1 - k));
  if (p < 1) return null;
  return function () {
    if (_ae.hand !== h) return;
    _ae.hand = null;
    _aeHandReset();
    h.done();
    if (h.held) _ae.catchUp = h.held;   // the turn the finger made on the way (_aeTurnBy)
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
  _aeDbgFit('hand-in');
  _ae.preset = 'moon';
  _aeMarkViews();
  var xfade = _aeReduceMotion();
  var h = _ae.hand = {
    dir: 1, start: performance.now(), ms: xfade ? AE_HAND_XFADE_MS : AE_HAND_MS,
    frame: frame, daz: 0, del: 0, e0: 0, e: 0, xfade: xfade,
    done: function () {
      _aeCoverAlmanac(true);
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
  _aeInputReset();
  _ae.el.classList.add('ae-hand');
  _aeShowSettings(false);
  _aeCoverAlmanac(false);
  if (!xfade) _aeLiftHero(true);
  _aeKick();
}

// Opened on the Moon or the Sun (a tap on the sky, a card): the first frame is that body, seen from the Earth's side at the same
// share of its own fit as the Earth's opening, and the move is a zoom in on it. It began on the Earth and flew over, so the first
// thing shown was the Earth ("when I went to the moon from the main Almanac page, they were showing earth the first time").
function _aeStartAtOpenBody() {
  var key = _aeOpenTarget, sc = _ae.scene;
  if ((key !== 'moon' && key !== 'sun') || !sc) return;
  var azel = _aeAzElOf(_aeScale(sc[key], -1));
  _ae.target = key;
  _ae.az = azel.az; _ae.el_ = azel.el;
  var fit = key === 'sun' ? _aeFitDist(AE_FIT_SUN) : _aeBodyFitDist(key);
  _ae.dist = _aeClampDist(fit * _ae.dist / _aeFitDist(AE_FIT_EARTH));
}
// The scene at the view's moment, the camera on the Earth over the chosen place (or the Almanac's stand-in for it).
function _aeStartAtHere() {
  _ae.scene = _aeSceneAt(_aeDisplayMs());
  var loc = (typeof _getLocation === 'function') ? _getLocation() : { lat: 0, lon: 0 };
  var here = _aeFixedToScene(_aeGeodeticToFixed(_aeClamp(loc.lat, -_aeDeg(AE_START_MAX_LAT), _aeDeg(AE_START_MAX_LAT)), loc.lon), _ae.scene.gast);
  var azel = _aeAzElOf(here);
  _ae.target = 'earth';
  _ae.az = azel.az; _ae.el_ = azel.el;
}
// Where the opening flight arrives: over the chosen place (or the Almanac's
// stand-in for it), so the first thing seen is here, lit as it is now.
function _aeEnter() {
  // From the hero, its Moon becomes this one where it stands.
  var frame = _ae.fromHero ? _aeHeroFrame() : null;
  if (frame) { _aeHandIn(frame); return; }
  // From the orrery, the drawing lifts into the view (almanac-orrery3d.js; the page stays under it until then).
  if (_ae.fromOrrery && !_aeLinkWant && typeof _aeOrreryIn === 'function' && _aeOrreryIn()) return;
  _aeCoverAlmanac(true);
  _aeStartAtHere();
  _ae.dist = _aeReduceMotion() ? _aeFitDist(AE_FIT_EARTH) : AE_FLY_START_DIST;
  if (!_aeLinkWant) _aeStartAtOpenBody();
  var link = _aeLinkWant;
  _aeLinkWant = null;
  if (link && !_aeLinkReady(link.v)) {
    // The station and the probes are not known at the first frame (their data comes after): the view opens as it
    // would, and goes to the link's place once that has come (_aeLinkResume).
    _aePreset(_aeOpenTarget);
    _ae.linkHeld = link;
    _aeTracksLoad();
    return;
  }
  _aePreset(link ? link.v : _aeOpenTarget);
  if (link) _aeLinkApply(link);
  _aeDbgFit('enter');
}

// Every control put away, or brought back: a tap on empty space or the space bar. The page's own header goes with them
// (held away, as a book being read holds it: the page takes its room), so the picture has the whole screen. It will not hide what is in use: Side by side has no camera to
// tap, and an open sheet or the info page is a state, not clutter.
function _aeBareOn() { return !!(_ae && _ae.el && _ae.el.classList.contains(AE_BARE_CLASS)); }
function _aeBareAllowed() {
  var go = _aeById('ae-go');
  return !_ae.spin && !_ae.setOpen && !_ae.info && !(go && !go.hidden);
}
function _aeBare(on) {
  if (!_ae || !_ae.el || on === _aeBareOn() || (on && !_aeBareAllowed())) return;
  if (!_aeReduceMotion()) {
    _ae.el.classList.add(AE_BARE_ANIM_CLASS);
    clearTimeout(_ae.bareTimer);
    _ae.bareTimer = setTimeout(function () { _ae.el.classList.remove(AE_BARE_ANIM_CLASS); }, AE_BARE_FADE_MS);
  }
  _ae.el.classList.toggle(AE_BARE_CLASS, on);
  if (typeof _chromeImmersive === 'function') _chromeImmersive(on);
  if (on) _aeHideHint();
}
function _aeBareTap() { if (_aeBareOn() || _ae.tapBare) _aeBare(!_aeBareOn()); }
// ── The one caption slot ──
// Every line of text that is not the time, the vehicle's readout or the name is said here, one at a time: the highest priority that is still
// alive. A line with a ttl goes by itself (a hint); one without stays while its owner keeps saying it. Two texts cannot meet because there is
// one place for them. aeCaption(id, text, { prio, ttl, onTap }); an empty text takes the line away.
var AE_CAP_PRIO_HINT = 3, AE_CAP_PRIO_SUN = 2, AE_CAP_PRIO_NOTE = 1, AE_CAP_PRIO_OFFER = 0.5, AE_CAP_PRIO_FOOT = 0.2;
var _aeCaps = {}, _aeCapTimer = 0;
function aeCaption(id, text, o) {
  o = o || {};
  var was = _aeCaps[id];
  if (!text) { if (!was) return; delete _aeCaps[id]; }
  else {
    if (was && was.text === text && !o.ttl && (!!o.onTap === !!was.onTap)) { if (o.onTap) was.onTap = o.onTap; return; }   // the same line said again each frame: nothing to do
    _aeCaps[id] = { text: text, prio: o.prio || 0, until: o.ttl ? performance.now() + o.ttl : 0, onTap: o.onTap || null };
  }
  _aeCapPaint();
}
function _aeCapPick() {
  var now = performance.now(), best = null;
  Object.keys(_aeCaps).forEach(function (k) {
    var c = _aeCaps[k];
    if (c.until && c.until <= now) { delete _aeCaps[k]; return; }
    if (!best || c.prio > best.prio) best = c;
  });
  return best;
}
function _aeCapPaint() {
  var el = _aeById('ae-hint'), c = _aeCapPick();
  clearTimeout(_aeCapTimer);
  if (!el) return;
  var live = Object.keys(_aeCaps).map(function (k) { return _aeCaps[k].until; }).filter(Boolean);
  if (live.length) _aeCapTimer = setTimeout(_aeCapPaint, Math.max(30, Math.min.apply(null, live) - performance.now() + 20));
  if (c) _aeSetText(el, c.text);
  el.classList.toggle('ae-tap', !!(c && c.onTap));
  el._capTap = c && c.onTap || null;
  if (!el._tapBound) { el._tapBound = true; el.addEventListener('click', function () { var f = el._capTap; if (f) { aeCaption('hint', ''); f(); } }); }
  el.classList.toggle('ae-show', !!c);
  _aeMeasureTop();
}
function _aeCapNow() { var c = _aeCapPick(); return c ? c.text : ''; }
function _aeHideHint() { aeCaption('hint', ''); }
// A line over the controls, for a moment (where you are could not be found).
function _aeShowHint(text, onTap) {   // `onTap`: the line is a button for as long as it shows
  _aeBare(false);
  aeCaption('hint', text, { prio: AE_CAP_PRIO_HINT, ttl: AE_HINT_MS, onTap: onTap });
}

// Show where I am. The position is asked for only here, when the person
// taps for it, as the Maps app asks: opening the view asks nothing. Granted,
// "You" marks the device's own position and the view turns to it; denied or
// unavailable, nothing is drawn and the hint says so. A second tap hides it.
// ── The rim button and the camera button: the one way in and out ──
// What the rim button does is read from where the view is, never stored: on the ground or in the air (a mode that has
// registered) it leaves; else it goes in at the middle of the picture: a body there is landed on, and a mode may offer to
// go in at a craft or at empty space (the flying one). A mode registers { leave(): state|null, enter(centre): state|null };
// a state is { label, svg, run }. The camera button is for the modes that have a camera switch: { active(), pressed()?, label, svg, run }.
// The approved glyph (almanac.js ALM_RIM_SVG), in two forms on a 24 box and its 2 px grid: outside (the way in) the edge of a world across
// the diagonal and a dot on the ground side, both amber; on the surface or in a craft (the way out) the same glyph with the dot on the
// space side. The button keeps one glyph and the dot travels between its two places in the time of the move itself.
var AE_RIM_SPACE_SVG = typeof ALM_RIM_SVG === 'string' ? ALM_RIM_SVG : '';   // the way in (the page's script is always there before this one)
var AE_RIM_GROUND_SVG = typeof _almRimSvg === 'function' ? _almRimSvg(true) : '';   // you are on the ground (or at a site): the lit dot is the ground one
var AE_RIM_MS = 150;   // the longest the button's reading is kept
var _aeRimModes = [], _aeCamModes = [];
function _aeRimRegister(mode) { _aeRimModes.push(mode); if (typeof _ae === 'object' && _ae) _ae.rimAt = 0; }
function _aeCamRegister(mode) { _aeCamModes.push(mode); if (typeof _ae === 'object' && _ae) _ae.rimAt = 0; }
function _aeRimCentre() {
  var x = _ae.w / 2 - (_ae.goX || 0), y = _ae.h / 2 - (_ae.infoShift || 0);
  return { x: x, y: y, body: _ae.fly || _ae.spin ? null : _aeBodyAt(x, y) };
}
_aeRimRegister({
  leave: function () {
    if (_ae.stand || _ae.standPending) return { label: _aeT('alm_stand_back'), svg: AE_RIM_GROUND_SVG, run: _aeStandClose };
    if (_ae.site) return { label: _aeT('alm_site_leave'), svg: AE_RIM_GROUND_SVG, run: _aeSiteRise };
    return null;
  },
  enter: function (c) {
    // (While the view flies back from a way down that was given up, the button still goes down, to the same place: the centre names no body during a flight.)
    var undo = _ae.standUndo && _ae.fly && _ae.standUndo.key === _ae.target ? _ae.standUndo : null, body = undo ? undo.key : c.body;
    if (!body || body !== _ae.target || !_aeStandable(body)) return null;
    return { label: _aeT('alm_stand_here'), svg: AE_RIM_SPACE_SVG, run: function () {
      var undone = typeof _aeStandUndone === 'function' ? _aeStandUndone(body) : null;   // a way down given up: down again goes to the same place
      if (undone) { _aeStandAt(body, undone.lat, undone.lon); return; }
      if (_ae.lm && _ae.lm.body === body && !_ae.pick && typeof _aeSiteCan === 'function' && _aeSiteCan(body, _ae.lm.row)) { _aeSiteVisit(body, _ae.lm.row, false); return; }   // a site's card is up: down into the visit, the way Space came out of it
      var lm = _ae.lm && _ae.lm.body === body ? { lat: _ae.lm.row[1], lon: _ae.lm.row[2] } : null;
      var fixed = _ae.pick && _ae.pick.body === body ? _ae.pick : _ae.place && body === 'earth' ? _ae.place : lm;   // the spot the corner is fixed on, or the landmark whose card is up
      if (fixed) { _aeStandAt(body, fixed.lat, fixed.lon); return; }
      var hit = typeof _aeStHit === 'function' ? _aeStHit(body, c.x, c.y) : null;
      if (hit) _aeStandAt(body, hit.lat, hit.lon);
      else _aeStandReady().then(function () { var h = _aeStHit(body, c.x, c.y); if (h) _aeStandAt(body, h.lat, h.lon); }, function () {});
    } };
  }
});
_aeRimRegister({   // a world with no ground to stand on: the surface button turns the UFO on if it is not and takes it down to the surface (a gas giant's cloud tops)
  enter: function (c) {
    var body = c.body;
    if (!body || body !== _ae.target || _aeStandable(body) || !_aeFlyOffer()) return null;
    return { label: _aeT('alm_fly_down'), svg: AE_RIM_SPACE_SVG, run: function () { _aeUfoDown(body); } };
  }
});
_aeRimRegister({   // the flying mode (almanac-fly.js), once it is there
  enter: function (c) { return !c.body && _aeFlyAble() ? { label: _aeT('alm_rim_fly'), svg: AE_RIM_SPACE_SVG, run: enterFly } : null; }
});
function _aeRimState() {
  if (!_ae || !_ae.el || _ae.spin || _ae.hand || _ae.preset === 'planets') return null;   // (not on the planets page: nothing to go in or out of)
  var i, d;
  for (i = 0; i < _aeRimModes.length; i++) if (_aeRimModes[i].leave && (d = _aeRimModes[i].leave())) { d.kind = 'leave'; return d; }
  var c = _aeRimCentre();
  for (i = 0; i < _aeRimModes.length; i++) if (_aeRimModes[i].enter && (d = _aeRimModes[i].enter(c))) { d.kind = 'enter'; return d; }
  return null;
}
function _aeCamState() {
  for (var i = 0; i < _aeCamModes.length; i++) if (_aeCamModes[i].active()) return _aeCamModes[i];
  return null;
}
// Both buttons show what the view allows now: written when the reading changes.
// The back circle says where the page's own back goes ("Back to Solar System"), as the page's arrow did.
function _aeSyncBack() {
  var b = _aeById('ae-back'), src = _aeById('back-btn');
  if (!b) return;
  var said = _aeT('back_to', { place: _aeBackLabel() });   // where this step goes, in the mode this now is
  var label = said && said !== 'back_to' ? said : src ? src.getAttribute('aria-label') || src.title : '';
  if (label && b.getAttribute('aria-label') !== label) { b.setAttribute('aria-label', label); b.title = label; }
}
// The rim glyph's lit dot travels from space to the ground with the move itself, not by a clock of its own: its place is the share of the whole way down the camera
// has made (the flight, the wait for the ground, the fall), so it arrives as the eye touches the ground, and goes back the same way. null when no move is on.
function _aeRimProgress() {
  if ((_ae.stand || _ae.standPending) && typeof _aeStandProgress === 'function') return _aeStandProgress();
  if (_ae.site && typeof _aeSiteProgress === 'function') return _aeSiteProgress();
  return null;
}
var _aeRimDotOn = false;
function _aeRimDot() {
  var rim = _aeById('ae-rim'), p = _aeRimProgress(), lit = rim && typeof rim.querySelector === 'function' ? rim.querySelector('.ae-rim-lit') : null;
  if (!lit) return;
  if (p === null) { if (_aeRimDotOn) { _aeRimDotOn = false; lit.style.transition = ''; lit.style.transform = ''; } return; }
  _aeRimDotOn = true;
  lit.style.transition = 'none';
  p = Math.min(1, p);   // (at the end it stands at the glyph's own ground place, and goes on standing there)
  lit.style.transform = 'translate(' + (10 * p).toFixed(2) + 'px,' + (10 * p).toFixed(2) + 'px)';
}
function _aeRimSync(force) {
  var now = performance.now();
  if (!force && _ae.rimAt && now - _ae.rimAt < AE_RIM_MS) return;
  _ae.rimAt = now;
  _aeSyncBack();
  _aeStripSync();
  _aeRimPaint('ae-rim', _aeRimState());
  _aeRimPaint('ae-cam', _aeCamState());
  _aeMarkFly();   // the UFO button with them: a mode that ends without saying so (a visit, a mission, a hand-over) still gets it back
  _aeHudRender();   // and the corner, for the mode this now is
  _aeHudInfoPaint();
}
// What stands under the strip stands below wherever it now ends; the strip itself is the same in every mode.
function _aeStripSync() {
  if (!_ae.el) return;
  var key = (_ae.site ? 1 : 0) + (_ae.mission ? 2 : 0) + (_ae.site && _ae.site.drive ? 4 : 0) + (_ae.el.classList.contains('ae-flying') ? 8 : 0);
  if (_ae.stripKey !== key) { _ae.stripKey = key; _aeMeasureFoot(); }
}
function _aeRimPaint(id, st) {
  var b = _aeById(id);
  if (!b) return;
  var key = st ? st.label + '|' + (st.kind || '') : '';
  if (st && st.pressed) b.setAttribute('aria-pressed', String(!!st.pressed()));   // a mode's own toggle: its state shows on the button
  var slot = id === 'ae-rim' ? AH_RIM : AH_CAM;
  if (_aeHudCanNow(slot) === !!st && b._key === key) { b._st = st; return; }
  b._st = st; b._key = key;
  _aeHudCan(slot, !!st);
  b.style.setProperty('--ae-move-ms', AE_MOVE_MS + 'ms');
  var glyph = st && b.querySelector('.ae-rim-glyph');
  if (glyph && st.svg.indexOf('ae-rim-glyph') > -1) glyph.classList.toggle('ae-rim-ground', st.svg.indexOf('ae-rim-ground') > -1);   // the same glyph: the lit dot travels
  else if (st) b.innerHTML = st.svg;
  if (st) { b.setAttribute('aria-label', st.label); b.title = st.label; b.setAttribute('data-kind', st.kind || ''); }
  if (id === 'ae-rim') _aeRimDot();   // (a glyph made anew has no place of its own yet)
}
function _aeRimPress(id, e) {
  var b = _aeById(id), st = b && b._st;
  if (e && e.detail && b) b.blur();   // a click leaves the button's focus: the next Space is the controls', not this button's
  if (st && st.run) { st.run(); _aeRimSync(true); }
  else if (b && e) _aeShowHint(_aeT('alm_rim_none'));   // the dim button says why it does nothing
}
// North-up again after a twist: the turn the fingers gave eases back to the view's own.
function _aeNorthUp() {
  var step = function () {
    if (!_ae || !_aeIsOpen) return;
    _ae.twist = (_ae.twist || 0) * 0.82;
    if (Math.abs(_ae.twist) < 0.002) _ae.twist = 0;
    _aeRedraw();
    if (_ae.twist) requestAnimationFrame(step);
  };
  if (_aeReduceMotion && _aeReduceMotion()) { _ae.twist = 0; _aeRedraw(); return; }
  requestAnimationFrame(step);
}
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
    // On the Earth's ground: stand where you are. In the craft: out of it, then the way there.
    if (_aeHudGroundKey() === 'earth') { _aeHudLeaveGround(); _aeStandAt('earth', lat, lon); return; }
    if (_ae.ship) leaveFly();
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
  var fromHero = !!(opts && opts.fromHero), fromOrrery = !fromHero && !!(opts && opts.fromOrrery);
  _aeFrom = fromHero ? 'hero' : (opts && opts.from === 'sky' ? 'sky' : 'orrery');
  var lifts = fromHero || fromOrrery;
  // The orrery's lift needs its file (almanac-orrery3d.js) as well as the view: both come before the swap.
  if (!lifts || (_aeReady() && (!fromOrrery || typeof _aeOrreryIn === 'function')) || _ae.failed) {
    if (fromOrrery && _ae.failed) { _aeOrreryNoGl(); return; }
    _aeShow(fromHero, fromOrrery);
    return;
  }
  var hero = fromHero ? document.querySelector(AE_HERO_SEL) : null;
  if (hero) hero.classList.add('alm-moon-waking');
  if (fromOrrery && typeof _orreryWake === 'function') _orreryWake(true);
  _ae.wanted = true;
  Promise.all([_aePrepare(true), fromOrrery ? _aeOrreryLoad() : null]).then(function () {
    if (hero) hero.classList.remove('alm-moon-waking');
    if (fromOrrery && typeof _orreryWake === 'function') _orreryWake(false);
    var kept = fromHero ? _aeWaitDragRelease() : null;
    if (!_ae.wanted) return;
    _ae.wanted = false;
    if (_aeIsOpen || (typeof _almanacOpen !== 'undefined' && !_almanacOpen)) return;
    if (fromOrrery && (_ae.failed || !_aeReady())) { _aeOrreryNoGl(); return; }
    _aeShow(fromHero, fromOrrery);
    // What the finger did while the view was being made turns the Moon now it is up.
    if (kept && _aeIsOpen && _ae.gl) _aeDragBy(kept.x, kept.y);
  });
}
// ── The address ──
// The view's part of the URL (almanac.js, "The address"): v the view (a preset or a body), c the camera (distance in Earth radii,
// then azimuth and elevation in degrees), n the slide across the body, f=1 for full screen in Side by side. Read once, when the
// view is made ready: it opens on the view and snaps to the camera, with no flight.
var AE_LINK_VIEW_RE = /^[a-z0-9_-]{1,32}$/;
var _aeLinkWant = null;
// What a link can open besides the globe: m=<mode> and k=<its values, comma-separated>, v still the body. Only the mode's own
// values are written (the globe's camera is not); a value that does not parse, or a mode this build does not know, leaves the
// plain view of the body. Each lazy file puts its mode's writer in _aeLinkModes (key -> function returning the csv, or null when
// that mode is not the place); the way in is _aeLinkModeOpen. While a link's mode is still being opened its own address stands.
//   site   lat,lon,az,el,dist           a landing visit: the landing (its row, else the spot), the orbit camera (degrees; metres)
//   drive  lat,lon,x,y,hdg,seat,dist    the rover driven: the frame's origin, the rover's place (m east, m north of it) and heading
//                                       (degrees from north, counterclockwise), seat 1 or 0, the chase camera's distance
//   mission id,t,paused,speed           a mission replay: its id, the T+ in seconds, 1 while paused, the speed button's step
//   fly    px,py,pz,fx,fy,fz,0   the ship: its place (Earth radii), where it faces (the last value is read and ignored)
//   stand  lat,lon,heading,pitch,zoom   Stand here on the body in v: the place, the facing (degrees), the view's pitch, the zoom
var _aeLinkModes = {};
var _aeLinkModePending = null;
function _aeLinkModeNow() {
  if (_aeLinkModePending) return [_aeLinkModePending.m, _aeLinkModePending.k];
  for (var key in _aeLinkModes) { var v = _aeLinkModes[key](); if (v) return [key, v]; }
  return null;
}
function _aeLinkModeDone() { _aeLinkModePending = null; }
// What is selected, x=<kind>:<what>: lm:<body>:<name> a landmark's card, sent:<id> a row of Sent, sat:<NORAD id> a satellite. The Go
// sheet is not part of it; an x that names nothing this build has leaves the view as it is.
var AE_LINK_SEL_RE = /^(lm|sent|sat):(.{1,80})$/, AE_LINK_WAIT_MS = 150, AE_LINK_WAIT_TRIES = 200;
function _aeLinkSelWrite() {
  if (_ae.lm && _ae.lm.row) return 'lm:' + _ae.lm.body + ':' + _ae.lm.row[0];
  if (_ae.sent && _ae.sent.o) return 'sent:' + _ae.sent.o.id;
  var s = _aeSelectedSat();
  return s ? 'sat:' + s.omm.NORAD_CAT_ID : '';
}
// Calls go() once test() holds (the file or the data it needs has come), for as long as the view stays open.
function _aeLinkWait(test, go, giveUp) {
  var tries = 0;
  (function poll() {
    if (!_aeIsOpen) return;
    if (test()) { go(); return; }
    if (++tries < AE_LINK_WAIT_TRIES) setTimeout(poll, AE_LINK_WAIT_MS); else if (giveUp) giveUp();
  })();
}
function _aeLinkSelect(link) {
  var m = AE_LINK_SEL_RE.exec(link.x);
  if (!m) return;
  if (m[1] === 'lm') {
    var at = m[2].indexOf(':'), body = m[2].slice(0, at), name = m[2].slice(at + 1);
    if (at < 0 || !AE_TARGETS[body]) return;
    _aeLmLoad();
    // (The Moon's sharp map, which the view on the Moon always asks for, decides how near the camera may go: it is waited for.)
    var lmGo = function () {
      var rows = (_aeLm && _aeLm[body]) || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i][0] !== name) continue;
        _aeLmOpen(body, rows[i]);
        if (!link.c) _aeLmFlyFramed(body, rows[i]);
        return;
      }
    };
    _aeLinkWait(function () {
      return !!_aeLm && !!_aeLmBodies(true).filter(function (b) { return b.key === body; }).length &&
        (body !== 'moon' || _aeBaseMapW('moon', _ae.gl) > AE_MOON_LO_MAP_W);
    }, lmGo, lmGo);
  } else if (m[1] === 'sent') {
    // A row of Sent opens as its row in the Go sheet does (_aeSentPick: the clock brought to when it can be there, then the
    // craft followed, the lander at its site, the orbiter marked in the satellites layer), once the craft's tracks are in.
    _aeSentStart();
    _aeTracksLoad();
    var sentGo = function () {
      if (!_aeSent || !_aeSent.byId[m[2]]) return;
      _aeSentPick(AE_SENT + m[2]);
      _aeLinkCamera(link);   // the card is this row's; the camera, where the link has one, is the link's
    };
    // A lander's row finds its site in the landmarks: they are waited for too, or the row falls through to a generic card.
    var sentNeedsSite = function () { var o = _aeSent && _aeSent.byId[m[2]]; return !!(o && o.where && o.where.site && o.where.body); };
    _aeLmLoad();
    _aeLinkWait(function () { return !!_aeSent && !!_aeTracks && (!sentNeedsSite() || !!(_aeLm && _aeLm[_aeSent.byId[m[2]].where.body])); }, sentGo, sentGo);
  } else {
    _aeLinkWait(function () { return !!(_ae.sats && _ae.sats.list.length); }, function () {
      var l = _ae.sats.list;
      for (var i = 0; i < l.length; i++) if (String(l[i].omm.NORAD_CAT_ID) === m[2]) { _ae.selected = { norad: l[i].omm.NORAD_CAT_ID, tapMs: _aeDisplayMs() }; _aeRenderCard(); return; }
    });
  }
}
var AE_LINK_ID_RE = /^[a-z0-9_]{1,32}$/;
function _aeLinkModeOpen(link) {
  if (link.m === 'fly') {
    var fv = _almLinkNums(link.k, 7);
    if (!fv || (fv[6] !== 0 && fv[6] !== 1)) return false;
    _aeLinkModePending = link;
    enterFly();
    _aeLinkWait(function () { return !!_ae.ship && typeof _afLinkPlace === 'function'; }, function () { _afLinkPlace(fv); _aeLinkModeDone(); }, _aeLinkModeDone);
    return true;
  }
  if (link.m === 'mission') {
    var mv = link.k.split(','), t = Number(mv[1]), sp = Number(mv[3]);
    if (mv.length !== 4 || !AE_LINK_ID_RE.test(mv[0]) || mv[0] === 'plan' || !isFinite(t) || !(sp >= 0 && sp < 8) || sp % 1) return false;
    _aeLinkModePending = link;
    _aeMissionStart(mv[0], t, { paused: mv[2] === '1' });
    return true;
  }
  if (link.m === 'stand') {
    var sv = _almLinkNums(link.k, 5);
    if (!sv || !_aeStandable(link.v) || Math.abs(sv[0]) > 90) return false;
    _aeLinkModePending = link;
    _aeStandAt(link.v, sv[0], sv[1], { heading: sv[2], pitch: sv[3], zoom: sv[4] }).then(function (ok) {
      if (ok && _ae.standPending) _ae.fly = null;   // straight to the ground: no flight to the place first
      else _aeLinkModeDone();
    });
    return true;
  }
  if (link.m === 'site' || link.m === 'drive') {
    var drive = link.m === 'drive', vals = _almLinkNums(link.k, drive ? 7 : 5);
    if (!vals || AE_DRIVE_BODIES.indexOf(link.v) < 0) return false;
    _aeLinkModePending = link;
    _aeWhenSites(function (ok) {
      if (_aeLinkModePending === link) _aeLinkModePending = null;
      if (ok) _aeSiteLinkOpen(link.v, vals, drive);
    });
    return true;
  }
  return false;
}
function _aeLinkParts() {
  if (_aeIsOpen && _ae && _ae.parked) return _ae.parked.slice();   // given its GPU back while away: the address stays where it was
  if (!_aeIsOpen || !_ae || !_ae.gl) return [];
  var out = ['v=' + (_ae.preset || _ae.target)];
  var mode = _aeLinkModeNow();   // a mode the person is in says its own place; the globe's camera is not part of it
  if (mode) return out.concat(['m=' + mode[0], 'k=' + mode[1]]);
  if (_ae.spin) { if (_ae.spin.full) out.push('f=1'); return out; }
  var turn = function (rad) { return Number((((_aeDeg(rad) + 540) % 360) - 180).toFixed(1)); };
  out.push('c=' + [Number(_ae.dist.toPrecision(4)), turn(_ae.az), Number(_aeDeg(_ae.el_).toFixed(1))].join(','));
  var sel = _aeLinkSelWrite();
  if (sel) out.push('x=' + encodeURIComponent(sel));
  var p = _ae.pan;
  if (p && p.t === _ae.target && !_ae.fly) out.push('n=' + p.v.map(function (x) { return Number(x.toPrecision(3)); }).join(','));
  return out;
}
function _aeLinkOpen(link) {
  if (_aeIsOpen || !AE_LINK_VIEW_RE.test(link.v)) return;
  _aeLinkWant = link;
  openAlmanacEarth({ from: 'sky' });
}
function _aeLinkReady(v) {
  if (_aeIsCraft(v)) return !!_aeCraftPosOf(v);   // its place is worked out in a frame: until then _aePreset has nowhere to go
  return v === 'iss' ? !!_ae.issPos : !!AE_TARGETS[v] || v === 'planets' || v === 'sats' || v === AE_SPIN_KEY;
}
function _aeLinkResume() {
  var link = _ae && _ae.linkHeld;
  if (!link || !_aeIsOpen || !_aeLinkReady(link.v)) return;
  _ae.linkHeld = null;
  _aePreset(link.v);
  _aeLinkApply(link);
}
function _aeLinkApply(link) {
  if (link.m && _aeLinkModeOpen(link)) return;
  if (link.f && _ae.spin) _aeFullEnter();
  _aeLinkCamera(link);
  if (link.x) _aeLinkSelect(link);
}
function _aeLinkCamera(link) {
  if (!link.c || _ae.spin || _ae.pendingPreset) return;
  _ae.fly = null;
  if (_ae.orbitFly) _ae.orbitFly.endAt = performance.now();
  var t = AE_TARGETS[_ae.target];
  if (link.c[0] > 0) _ae.dist = t ? _aeClampDist(link.c[0]) : link.c[0];
  _ae.az = _aeRad(link.c[1]);
  _ae.el_ = _aeClamp(_aeRad(link.c[2]), -AE_MAX_ELEVATION, AE_MAX_ELEVATION);
  if (link.n && t) {
    var len = _aeLen(link.n), v = len > t.surface ? _aeScale(link.n, t.surface / len) : link.n;
    _ae.pan = { t: _ae.target, v: v };
  }
  _aeRedraw();
}
// The view is a step in history, as Look's overlay is: the phone's back
// gesture closes it and the Almanac stays; a second one leaves the Almanac.
var _aeStepped = false, _aeStepSwallow = false, _aeFullStepped = false;
function _aeStepIn() {
  if (_aeStepped) return;
  history.pushState({ mode: 'almanac', aeView: 1 }, '', location.href);
  _aeStepped = true;
}
// Closed by the person (its button, Escape): the step it made is taken back,
// and the router is told (_aeStepPop) to let that one go by.
function _aeStepOut() {
  if (!_aeStepped) return;
  var full = _aeFullStepped;   // closed from full screen: both steps go, in one move
  _aeStepped = _aeFullStepped = false;
  if (history.state && history.state.aeView) { _aeStepSwallow = true; if (full && history.state.aeFull) history.go(-2); else history.back(); }
}
// Full screen is a step on top of the view's, so the phone's back leaves it first.
function _aeFullStepIn() {
  if (_aeFullStepped || !_aeStepped) return;
  history.pushState({ mode: 'almanac', aeView: 1, aeFull: 1 }, '', location.href);
  _aeFullStepped = true;
}
function _aeFullStepOut() {
  if (!_aeFullStepped) return;
  _aeFullStepped = false;
  if (history.state && history.state.aeFull) { _aeStepSwallow = true; history.back(); }
}
// The router (app.js) asks first of every history step: true when it was this
// view's, which is then not the router's to act on.
function _aeStepPop(e) {
  if (_aeStepSwallow) { _aeStepSwallow = false; return true; }
  if (_aeFullStepped && !(e.state && e.state.aeFull)) { _aeFullStepped = false; if (_ae && _ae.stand) _aeStandLeave(false); else if (_ae && _ae.site && typeof _aeSiteExit === 'function') _aeSiteExit(); else _aeFullExit(false); return true; }
  if (_aeStepped && !(e.state && e.state.aeView)) {
    _aeStepped = false;
    if (_aeIsOpen) _aeClose();
    return true;
  }
  return false;
}
window._aeStepPop = _aeStepPop;
function _aeShow(fromHero, fromOrrery) {
  _aeStepIn();
  // From the orrery, its chosen moment; from the hero or the sky, the moment
  // they show.
  _aeIsOpen = true;
  if (_aeDbgOn) _aeDbg('open', 'the view opens');
  if (_aeDbgDevice) { _aeLoadJsOnce(AE_DEBUG_JS, function () { if (typeof _aeDbgPill === 'function') _aeDbgPill(); }); }
  _ae.fromHero = fromHero;
  _ae.fromOrrery = !!fromOrrery;
  _ae.parked = null;
  _ae.el.classList.add('open');
  _aeChromeOn(true);
  _ae.selected = null;
  _aeRenderCard();
  _aeShowSettings(false);
  _ae.freshFailed = false;
  _almClockPaint();
  _aePauseAlmanac();
  // The way back is Zimi's own arrow in the header (app.js goBack), named for where the view was opened from.
  if (typeof updateTopbar === 'function') updateTopbar();
  var cv = _aeById('ae-canvas');
  if (cv) cv.focus({ preventScroll: true });
  if (!_ae.capStatic) _aeLoadSats();
  if (_aeReady()) { _aeLoadMaps(_ae.gl); _aeResize(); _aeEnter(); _aeKick(); return; }
  _aeCoverAlmanac(true);
  if (_ae.failed) { _aeMessage(_aeNoGlText()); return; }
  _aeOpenWhenReady();   // "Reconnect" shows only when the device is offline; connected, the files did not load and the way on is to try again
}

// Close: back into the hero when the view came from it and it is there to
// go back to, else at once. The page has the view's moment first, so the
// hero it lands in shows it.
// Where the header's arrow goes back to: the Almanac's page (the hero, the sky) or its solar system (the orrery).
// Where the arrow really goes: a module that put the view here names it (`_ae.backLabel`: a mission, Look); on the ground, the card that handed the sky over (`handoff.backLabel`,
// else the page's) or the view of the body it stands on; otherwise where the view was opened from: the Solar System, the sky card, or the Almanac page.
function _aeBackLabel() {
  if (_ae && _ae.backLabel) return _ae.backLabel;
  var m = _aeMode();
  if (m === AH_PAD && typeof _pvBackWhere === 'function') return _pvBackWhere();
  if (m === AH_MISSION || m === AH_PLAN) return _aeInfoName('earth');
  if (_ae && _ae.spin) return _aeRowName(_ae.spin.from);
  if (_ae && _ae.site) return _aeInfoName(_ae.site.body);
  var st = _ae && (_ae.stand || _ae.standPending);
  if (st) {
    var h = st.handoff || st.pend && st.pend.handoff || st.handoff;
    if (h) return h.backLabel || _aeT('almanac');   // a card's hand-off goes back to the card, which is on the Almanac page
    return _aeInfoName(st.key || (st.pend && st.pend.key) || 'earth');
  }
  return _aeFrom === 'orrery' ? _aeT('alm_solar_system') : _aeT('almanac');   // opened from the sky card or the hero: the arrow lands on the Almanac page
}
// `toOrrery`: settle onto the page's orrery whatever the view was opened from (the Planets view pulled out far enough).
// The arrow is the one way out and steps out one level: out of a mission, a launch pad, a landing site or a drive to the
// view they were opened from; off the ground to the globe of the body stood on (or, when the sky card handed the ground
// over, back to that card); and from anywhere else out of the view.
function _aeBack() {
  var m = _aeMode();
  if (m === AH_PLAN) { _apClose(); return; }
  if (m === AH_PAD) { _pvBack(); return; }
  if (m === AH_MISSION) { _amStop(false); return; }
  if (m === AH_SITE || m === AH_DRIVE) { _aeSiteRise(); return; }
  if (_ae.stand || _ae.standPending) { _aeStandClose(); return; }
  if (_ae.spin) { if (_aeFullOn()) _aeFullExit(); else _aePreset(_ae.spin.from); return; }   // side by side steps back to where it was chosen from
  _aeClose();
}
function _aeClose(toOrrery) {
  if (!_aeIsOpen || (_ae.hand && _ae.hand.dir < 0)) return;
  if (_ae.site) _aeSiteLeave(true);   // the ground's camera gives way before the view is handed back to the page
  if (_ae.mission) _amStop(true);
  if (_ae.ship || _ae.shipParked) _afStop(true);
  if (typeof _almStripCap === 'function') _almStripCap(0);
  _ae.pick = null; if (typeof _aeStandMarkPick === 'function') _aeStandMarkPick();   // the tap ring does not outlive the view
  if (typeof _amRestoreTime === 'function') _amRestoreTime();   // the page goes back to the moment it had before a mission, not the mission's
  _aeLeaveSpin(true);
  var frame = _ae.fromHero && toOrrery !== true && _aeReady() && !_ae.el.classList.contains('ae-blank') &&
    (typeof _almanacOpen === 'undefined' || _almanacOpen) ? _aeHeroFrame() : null;
  if (frame) _aeHandOut(frame);
  else if ((toOrrery === true || _aeFrom === 'orrery') && typeof _aeOrreryOut === 'function' && _aeOrreryOut()) return;
  else _aeFinishClose();
}
function _aeFinishClose() {
  if (!_aeIsOpen) return;
  _aeLeaveSpin(true);
  if (_ae.stand || _ae.standPending) _aeStandDrop(true);   // the ground goes with the view (its history step with the view's)
  _aeIsOpen = false;
  if (_ae.pinOpen) _aePinSet(false);   // the chip, not the open capsule, is what the next opening starts with
  _aeBare(false);   // the page's header comes back with the page
  _aeChromeOn(false);
  _aeHideHint();   // a line said on the way in is not still up on the way back
  if (window.AlmanacMaps) AlmanacMaps.release();
  if (_ae.site) _aeSiteLeave(true);
  if (_ae.mission) _amStop(true);
  if (_ae.ship || _ae.shipParked) _afStop(true);
  if (typeof _amRestoreTime === 'function') _amRestoreTime();
  if (typeof updateTopbar === 'function') updateTopbar();   // the header's arrow is the Almanac's own again
  if (typeof _almClockUncover === 'function') _almClockUncover();   // the page lands on the moment the clock reached
  _aeStepOut();
  if (_ae.raf) { cancelAnimationFrame(_ae.raf); _ae.raf = 0; }
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  _ae.hand = null;
  _ae.fromOrrery = false;
  _ae.place = null;
  _aeHandReset();
  _aeCloseInfo(false);
  _ae.el.classList.remove('open');
  _aeInputReset();
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
  if (typeof _asGlGone === 'function') _asGlGone();
  if (typeof _oaGlGone === 'function') _oaGlGone();
  _aeFreeGl(S);
  // The labels were pinned to that scene; the next one's frames pin them again.
  ['ae-bm-earth', 'ae-bm-moon', 'ae-bm-sun', 'ae-lbl-iss', 'ae-lbl-you', 'ae-lbl-place', 'ae-lbl-shadow'].forEach(function (id) {
    var label = _aeById(id);
    if (label) label.hidden = true;
  });
  _aeFreshCanvas('ae-canvas', _aeBindCanvas);
}
// Every geometry, material and map of a scene, then the context itself.
function _aeDisposeTree(scene) {
  scene.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (!o.material) return;
    var u = o.material.uniforms || {};
    for (var k in u) if (u[k].value && u[k].value.isTexture) u[k].value.dispose();
    o.material.dispose();
  });
}
function _aeFreeGl(S) {
  _aeDisposeTree(S.scene);
  if (S.spin) _aeDisposeTree(S.spin.scene);
  S.renderer.dispose();
  if (typeof ZimiCap !== 'undefined') ZimiCap.giveBack(S.renderer.domElement);   // our own letting go, not the GPU's taking: it is no strike against the view
  S.renderer.forceContextLoss();
}
// A lost context cannot be had again from its canvas: a clone takes its place, with the same listeners bound.
function _aeFreshCanvas(id, bind) {
  var old = _aeById(id);
  if (old && old.parentNode) {
    var fresh = old.cloneNode(false);
    old.parentNode.replaceChild(fresh, old);
    bind(fresh);
  }
}

// Leaving the Almanac (almanac.js _almanacTeardown): the view closes and
// gives the GPU back.
function _aeRelease() {
  if (!_ae) return;
  _ae.wanted = false;
  // Released with the Almanac: its history step is not its to take back.
  _aeStepped = false;
  _aeFinishClose();
  _aeDisposeGl();
  if (typeof _asRelease === 'function') _asRelease();
}

window.openAlmanacEarth = openAlmanacEarth;
// The orrery's lift into this view and back is its own small file (almanac-orrery3d.js), asked for with the page's first
// tap on the orrery (openAlmanacEarth waits for it); the globe's cold open does not fetch it.
var AE_ORRERY_JS = _almAsset('/static/almanac-orrery3d.js');
function _aeOrreryLoad() {
  return typeof _aeOrreryIn === 'function' ? Promise.resolve() : _aeLoadJs(AE_ORRERY_JS);   // without it the orrery opens the view as it always did
}
// No 3D here: the orrery says so where its hint stands, and goes on as it was.
function _aeOrreryNoGl() {
  if (typeof _orreryNote === 'function') _orreryNote(_aeT('alm_earth_nogl'));
  if (typeof _orreryRenderHint === 'function') setTimeout(_orreryRenderHint, 0);
}
// ── The controls layer ─────────────────────────────────────────────────────────────────────────────────────────────
// One answer to "which mode is this", and one reading of what is on screen, for every mode (the modes themselves are
// almanac-stand.js, almanac-sites.js, almanac-missions.js, almanac-padview.js, almanac-fly.js): what stands where is
// decided here, not by each mode's own stylesheet. It lives in this file, not one of its own, because the view's first
// open is held to a count of requests (tests/test_perf_budgets.py).
// The view's modes. Exactly one holds at a time; a mode's own facts (a card up, the time chip open, the controls hidden)
// are not modes.
var AH_ORBIT = 'orbit', AH_SYSTEM = 'system', AH_SBS = 'sbs', AH_UFO = 'ufo', AH_STAND = 'stand', AH_DRIVE = 'drive',
  AH_SITE = 'site', AH_MISSION = 'mission', AH_PAD = 'pad', AH_PLAN = 'plan';
function _aeMode() {
  if (typeof _ae === 'undefined' || !_ae || !_ae.el) return '';
  var c = _ae.el.classList;
  if (c.contains('ae-plan')) return AH_PLAN;
  if (c.contains('ae-pad')) return AH_PAD;
  if (_ae.mission) return AH_MISSION;
  if (_ae.site) return _ae.site.drive ? AH_DRIVE : AH_SITE;
  if (_ae.stand || _ae.standPending) return AH_STAND;
  if (_ae.ship) return AH_UFO;
  if (_ae.spin) return AH_SBS;
  if (_ae.preset === 'planets') return AH_SYSTEM;
  return AH_ORBIT;
}
// The four corners are one family, each in its own place in every mode that has a use for it: the way out (top left),
// the UFO (top right), search (bottom left, never in the worlds' track, which starts beside it and is clipped there) and
// the way down or up (bottom right: the rim; on the planets page, Side by side). A mode says which it has (`ufo`, `find`,
// `foot`); the smaller glyphs stand in a row to the left of the foot (`row`, edge inward) and read a rank below it.
// A control with nothing to do now is not drawn, whatever the mode allows. Where you are (`you`) is offered anywhere in
// space; on the ground only on the body `youOn` names (the Earth: your place is on no other).
var AH_RIM = 'rim', AH_YOU = 'you', AH_SBS_BTN = 'sbs', AH_NORTH = 'north', AH_CAM = 'cam', AH_UFO_BTN = 'ufo', AH_FIND = 'find', AH_LM = 'lm', AH_ORBITS = 'orbits', AH_SATS = 'sats';
var AH_IDS = { rim: 'ae-rim', you: 'ae-locate', sbs: 'ae-sbs', north: 'ae-north', cam: 'ae-cam', ufo: 'ae-fly-btn', find: 'ae-find', lm: 'ae-lm-btn', orbits: 'ae-orbits-btn', sats: 'ae-sats-btn' };
var AH_KEYS = [AH_RIM, AH_SBS_BTN, AH_YOU, AH_LM, AH_ORBITS, AH_SATS, AH_NORTH, AH_CAM], AH_FEET = [AH_RIM, AH_SBS_BTN];   // (the rest are the small glyphs' row)
// Landmarks, Orbits and (at the Earth) Satellites stand by the locate button where the screen has the room, and stay in the world sheet everywhere; a phone keeps
// its row short (the info corner beside it needs the width).
var AH_LAYERS = [AH_SATS], AH_LAYERS_MQ = '(min-width:700px)';
// Landmarks and Orbits stand on the right edge in a column right over the locate button, on any screen, and go where it goes.
var AH_EDGE_LAYERS = [AH_LM, AH_ORBITS];
var AH_CORNER = {
  orbit: { foot: AH_RIM, row: [AH_YOU, AH_LM, AH_ORBITS, AH_SATS, AH_NORTH, AH_CAM], find: true, ufo: true },
  system: { foot: AH_SBS_BTN, row: [AH_YOU, AH_NORTH, AH_CAM], find: true, ufo: true },
  sbs: { row: [], find: true, ufo: true },
  ufo: { foot: AH_RIM, row: [AH_YOU, AH_CAM], find: true, ufo: true, nocard: true },
  stand: { foot: AH_RIM, row: [AH_YOU, AH_CAM], find: true, ufo: true, youOn: 'earth' },   // (the UFO from the ground too: it takes the craft up, _aeFlyFromAway; landed, the lit button lifts off)
  drive: { foot: AH_RIM, row: [], find: true, ufo: true },
  site: { foot: AH_RIM, row: [AH_YOU, AH_CAM], find: true, ufo: true, youOn: 'earth' },
  mission: { foot: AH_RIM, row: [AH_CAM], find: true, ufo: true },
  pad: { foot: AH_RIM, row: [AH_CAM] },   // (no search: the pad's foot is its own strip and transport, and its way out is one step back to where search is)
  plan: { row: [] }   // (a sheet over the whole view)
};
var AH_GAP_PX = 8, AH_EDGE_PX = 12, AH_OVER_Z = 51;   // over a mode's touch layer (50), under its own menus (52)
var AH_MINOR_PX = AE_HIT_PX, AH_GLYPH_PX = 22, AH_MINOR_GLYPH_PX = 18, AH_INFO_GAP_PX = 10;
var AH_SHEET_Z = 59, AH_MID_OVER_Z = 58;   // the time chip over a mode's touch layer and buttons, under the top bar's two circles (60)
var AH_TOUCH_LAYER = [AH_DRIVE, AH_SITE, AH_MISSION, AH_PAD];   // the modes that lay a touch layer of their own over the whole view
var AH_NAME_GAP_PX = 4;
// A very wide screen: the small glyphs stack up the corner's column over the foot's button, not out to its left (a phone has no height to spare,
// a wide screen no planets under them there).
var AH_STACK_MQ = '(min-width:1100px) and (min-height:600px)';
// On a wide screen the open time capsule is a pill of its own between the two corner circles (each keeping its glass), as wide as the clock and a
// slider long enough to aim with: the capsule across the whole view was a long bordered band with nothing in most of it.
var AH_PILL_MIN_W_PX = 700, AH_PILL_W_PX = 560, AH_PILL_PAD_PX = 20;
var AH_PILL_MQ = '(min-width:' + AH_PILL_MIN_W_PX + 'px) and (min-height:461px)';   // (a phone on its side keeps its own open capsule)
var AH_INFO_REACH_BLOCK_PX = 14;   // how far the info corner's tap reaches above and below its glass
var AH_BAND_GAP_PX = 16;  // the band above the corners' row (the minimap, the info corner, the small glyphs) stands this far over it
var AH_INFO_LINES = 3, AH_INFO_LINE_PX = 17;   // the info corner at its fullest, and a line of it
var AH_FOOT = 'var(--ae-rim-b,calc(' + AH_EDGE_PX + 'px + env(safe-area-inset-bottom)))';
var AH_DISC = 'html .ae-view .ae-btn.ae-round.ah-hero', AH_SMALL = 'html .ae-view .ae-btn.ae-round.ah-minor';
var AH_CSS = [
  // One disc: dark glass that reads over black space and over a bright world alike (the blur carries what is behind, the
  // tint keeps the glyph's contrast), one hairline, one soft shadow, no square behind it. Red is Red here too (the tokens).
  // Where the small discs' line stands (--ah-band0: just above the corners' row; on a phone on its side, on that row beside
  // the foot, the worlds being a column there) and where its first disc starts (--ah-row-x0).
  '.ae-view{--ah-band0:calc(' + AH_FOOT + ' + ' + (AE_HIT_PX + AH_BAND_GAP_PX) + 'px);--ah-row-x0:' + (AH_EDGE_PX + (AE_HIT_PX - AH_MINOR_PX) / 2) + 'px}',
  '@media (orientation:landscape) and (max-height:460px){.ae-view{--ah-band0:' + AH_FOOT + ';--ah-row-x0:' + (AH_EDGE_PX + AE_HIT_PX + AH_GAP_PX) + 'px}}',
  '.ae-view{--ah-bg:var(--glass-bg,rgba(14,14,16,.62));--ah-line:var(--glass-line,rgba(255,255,255,.14));--ah-blur:var(--glass-blur,blur(16px) saturate(140%));--ah-ink:#f4f4f6;--ah-ink2:rgba(244,244,246,.74)}',
  'html.night-red .ae-view{--ah-ink:var(--glass-ink);--ah-ink2:var(--glass-ink)}',
  AH_DISC + ',' + AH_SMALL + '{box-sizing:border-box;padding:0;border-radius:50%;border:1px solid var(--ah-line);background:var(--ah-bg);-webkit-backdrop-filter:var(--ah-blur);backdrop-filter:var(--ah-blur);box-shadow:0 1px 8px rgba(0,0,0,.4);color:var(--ah-ink);-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .14s ease-out,background-color .14s ease-out}',
  AH_DISC + '{--round:' + AE_HIT_PX + 'px;width:' + AE_HIT_PX + 'px;height:' + AE_HIT_PX + 'px;min-width:' + AE_HIT_PX + 'px}',
  AH_SMALL + '{--round:' + AH_MINOR_PX + 'px;width:' + AH_MINOR_PX + 'px;height:' + AH_MINOR_PX + 'px;min-width:' + AH_MINOR_PX + 'px;color:var(--ah-ink2)}',   // (a rank below in its glyph and ink only: one disc, one size, one glass)
  // One glyph size and weight; a glyph of dots (Side by side) is filled, not stroked.
  AH_DISC + '>svg{display:block;width:' + AH_GLYPH_PX + 'px;height:' + AH_GLYPH_PX + 'px}' + AH_SMALL + '>svg{display:block;width:' + AH_MINOR_GLYPH_PX + 'px;height:' + AH_MINOR_GLYPH_PX + 'px}',
  AH_DISC + '>svg:not(.ah-solid){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
  // The rim's glyph: the world's edge in the family's ink, the dot that says where you are the one thing lit; its ink
  // (the arc ends past its dots) sits half a pixel right and down of its box, so it is drawn that much back.
  AH_DISC + ' .ae-rim-glyph{transform:translate(-.5px,-.5px)}' + AH_DISC + ' .ae-rim-glyph path{stroke:currentColor}',
  // Lit: on. Pressed: under the finger, in the same frame (a class the layer sets as the finger lands, _aeHudPress: a
  // browser's own :active waits to see whether the touch is a scroll), with no easing on the way down.
  AH_DISC + '[aria-pressed="true"],' + AH_SMALL + '[aria-pressed="true"]{color:var(--amber);border-color:var(--amber)}',
  AH_DISC + '.ah-down,' + AH_SMALL + '.ah-down{transform:scale(.92);background-color:rgba(72,72,80,.7);transition:none}',
  '@media (prefers-reduced-motion:reduce){' + AH_DISC + ',' + AH_SMALL + '{transition:none}' + AH_DISC + '.ah-down,' + AH_SMALL + '.ah-down{transform:none}}',
  // Their places. The top two stand in the open time capsule's ends and share its glass there (it is not open across the view on a phone on its side).
  '.ah-tl,.ah-tr,.ae-find{position:absolute;opacity:var(--ae-ui,1)}',
  '.ah-tl,.ah-tr{top:calc(8px + var(--sat,0px));z-index:' + AH_TOP_Z + '}',
  '.ah-tl{inset-inline-start:calc(' + AH_EDGE_PX + 'px + env(safe-area-inset-left))}.ah-tr{inset-inline-end:calc(' + AH_EDGE_PX + 'px + env(safe-area-inset-right))}',
  '.ae-find{inset-inline-start:calc(' + AH_EDGE_PX + 'px + env(safe-area-inset-left));bottom:' + AH_FOOT + ';z-index:' + AH_OVER_Z + '}',
  '.ae-go-up .ae-find{z-index:' + AH_TOP_Z + '}',   // the sheet up, the circle is its X: over the sheet, like the band's circles
  '.ah-hero[hidden],.ah-minor[hidden]{display:none}',
  '.ae-view.ae-bare .ah-tl,.ae-view.ae-bare .ah-tr,.ae-view.ae-bare .ae-find{opacity:0;visibility:hidden}',
  '@media not all and (orientation:landscape) and (max-height:460px){@media (max-width:' + (AH_PILL_MIN_W_PX - 1) + 'px){html .ae-view:has(.ae-pin.ae-pin-open) .ae-btn.ae-round.ah-tl,html .ae-view:has(.ae-pin.ae-pin-open) .ae-btn.ae-round.ah-tr{background:none;border-color:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}}}',
  '.ah-corner{position:absolute;inset-inline-end:calc(' + AH_EDGE_PX + 'px + env(safe-area-inset-right));bottom:' + AH_FOOT + ';z-index:' + AH_OVER_Z + ';display:flex;flex-direction:row-reverse;align-items:center;gap:' + AH_GAP_PX + 'px;min-height:' + AE_HIT_PX + 'px;pointer-events:none;opacity:var(--ae-ui,1)}',
  '.ah-corner .ae-btn,.ah-row .ae-btn{pointer-events:auto}',
  // The small glyphs stand in a row of their own just above the foot's row, at its right end, the first centred over the
  // foot's column: the worlds' track below has the width, and the band holds the minimap and the info corner on its left.
  '.ah-row{position:absolute;inset-inline-end:calc(var(--ah-row-x0) + env(safe-area-inset-right));bottom:var(--ah-band-b,var(--ah-band0));z-index:' + AH_OVER_Z + ';display:flex;flex-direction:row-reverse;align-items:flex-end;gap:' + AH_GAP_PX + 'px;pointer-events:none;opacity:var(--ae-ui,1)}',
  '.ae-view.ae-bare .ah-corner,.ae-view.ae-bare .ah-row{opacity:0;visibility:hidden}',
  '@media ' + AH_STACK_MQ + '{.ah-row{flex-direction:column-reverse;align-items:center}}',
  // Landmarks and Orbits stand over the locate button on the row's end, a column of two (the row keeps its end wherever the first disc is, so the column keeps its place).
  '@media not all and ' + AH_STACK_MQ + '{.ah-row{min-width:' + AH_MINOR_PX + 'px;min-height:' + AH_MINOR_PX + 'px}.ah-row>#ae-lm-btn,.ah-row>#ae-orbits-btn{position:absolute;inset-inline-end:0}.ah-row>#ae-lm-btn{bottom:calc(100% + ' + AH_GAP_PX + 'px)}.ah-row>#ae-orbits-btn{bottom:calc(100% + ' + (2 * AH_GAP_PX + AH_MINOR_PX) + 'px)}}',
  '.ah-row .ae-north svg{transition:none}',
  // The top's middle, one column in the page's own flow: the time chip, then the name under it, wherever the chip ends.
  // The chip is whatever the mode needs: the time, and beside it a mode's own reading; under those a second line (a journey).
  '.ah-mid{position:absolute;top:calc(8px + var(--sat,0px));inset-inline:0;z-index:1;display:flex;flex-direction:column;align-items:center;gap:' + AH_NAME_GAP_PX + 'px;pointer-events:none}',
  '.ah-mid.ah-over{z-index:' + AH_MID_OVER_Z + '}',
  '.ae-view .ah-mid>.alm-pin.ae-pin{position:relative;top:auto;inset-inline:auto;z-index:auto;align-self:stretch}',
  '.ae-view .ah-mid>.alm-pin.ae-pin.ae-pin-open{pointer-events:auto}',   // the open capsule takes its own taps (the column round it lets them through)
  '@media not all and (orientation:landscape) and (max-height:460px){.ae-view .ah-mid>.alm-pin.ae-pin.ae-pin-open{margin-inline:' + AH_EDGE_PX + 'px}}',
  '@media (orientation:landscape) and (max-height:460px){.ae-view .ah-mid>.alm-pin.ae-pin.ae-pin-open{align-self:center}}',
  '@media ' + AH_PILL_MQ + '{.ae-view .ah-mid>.alm-pin.ae-pin.ae-pin-open{align-self:center;box-sizing:border-box;width:min(' + AH_PILL_W_PX + 'px,calc(100% - ' + 2 * (AH_EDGE_PX + AE_HIT_PX + AH_GAP_PX) + 'px));margin-inline:0;padding-inline:' + AH_PILL_PAD_PX + 'px}}',
  // The info corner: where you are and how you are moving, bottom left (time is top centre). Two lines, a third only
  // while moving; quiet type with fixed-width figures on a quiet glass chip (a dark halo round each letter read as a smudge on a bright
  // ground), legible over black and over Mercury's or the Moon's day side alike. Its last line sits on the band's foot, beside the minimap where there is one, the small glyphs
  // across from it; a long name gives way before them (_aeHudInfoPaint).
  '.ah-info{position:absolute;inset-inline-start:calc(' + AH_EDGE_PX + 'px + env(safe-area-inset-left));bottom:calc(' + AH_FOOT + ' + ' + (AE_HIT_PX + AH_BAND_GAP_PX) + 'px);z-index:1;box-sizing:border-box;max-width:calc(100% - ' + 2 * AH_EDGE_PX + 'px);display:flex;flex-direction:column;justify-content:flex-end;pointer-events:none;opacity:var(--ae-ui,1);font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,.45);padding:5px 9px;border-radius:12px;background:rgba(12,12,14,.34);-webkit-backdrop-filter:blur(10px) saturate(1.2);backdrop-filter:blur(10px) saturate(1.2)}',
  '@keyframes ah-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}.ah-info>.ah-in{animation:ah-in .25s ease-out}',
  '.ah-info>*{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:' + AH_INFO_LINE_PX + 'px;font-weight:500;color:rgba(255,255,255,.8)}',
  '.ah-info>b{font-size:13px;font-weight:600;color:#fff;letter-spacing:.01em}',
  '.ah-info>:empty,.ah-info[hidden],.ah-info>:has(>#ah-read:empty+#ah-sub:empty){display:none}',
  // A mode's own line: its words in the corner's type, side by side, with none of the chips or the big figures it had elsewhere.
  '.ae-view .ah-own,.ae-view .ah-own>*{display:flex;align-items:center;gap:10px;margin:0;padding:0;text-align:start}',
  '.ae-view .ah-own span,.ae-view .ah-own b{display:inline-flex;align-items:center;gap:4px;margin:0;padding:0;border:0;border-radius:0;background:none;-webkit-backdrop-filter:none;backdrop-filter:none;font:inherit;letter-spacing:0;text-transform:none;color:inherit;text-shadow:inherit}',
  '.ae-view .ah-own [hidden],.ae-view .ah-own span:empty{display:none}.ae-view .ah-own svg{margin:0}',
  '.ah-info svg{width:11px;height:11px;margin-inline-end:4px;vertical-align:-1px}',
  '.ae-view .ah-info{z-index:' + AH_OVER_Z + '}',
  '.ah-info.ah-pinned>b::after{content:"";display:inline-block;width:5px;height:5px;margin-inline-start:6px;border-radius:50%;background:var(--amber);vertical-align:2px}',   // fixed on a picked spot
  '.ah-info.ah-by-mini{inset-inline-start:calc(' + (AH_EDGE_PX + AE_MINI_PX + AH_INFO_GAP_PX) + 'px + env(safe-area-inset-left));max-width:calc(100% - ' + (2 * AH_EDGE_PX + AE_MINI_PX + AH_INFO_GAP_PX) + 'px)}',
  '@media (orientation:landscape) and (max-height:460px){.ah-info{inset-inline-start:calc(' + (AH_EDGE_PX + AE_HIT_PX + AH_INFO_GAP_PX) + 'px + env(safe-area-inset-left));bottom:' + AH_FOOT + ';height:' + AE_HIT_PX + 'px;justify-content:center;max-width:40%}' +
    '.ah-info.ah-by-mini{inset-inline-start:calc(' + (76 + 72 + AH_INFO_GAP_PX) + 'px + env(safe-area-inset-left));bottom:' + AH_FOOT + ';height:72px;max-width:40%}}',
  '.ae-view.ae-bare .ah-info{opacity:0;visibility:hidden}',
  'html.night-red .ah-info>*{color:var(--glass-ink)}',
  // The caption stands above the minimap's band, on one line, so nothing crosses the info corner.
  '@media not all and (orientation:landscape) and (max-height:460px){.ae-view.ah-band .ae-bottom .ae-hint{bottom:calc(100% + ' + (AE_MINI_PX - 2) + 'px);max-width:calc(100% - ' + 2 * AE_FOOT_PAD_PX + 'px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}',
  // The flight's own line by the craft says the same body and speed: the corner says them, once. (Its note stays.)
  '.ae-view .af-read .af-line{display:none}',
  // Flying: the two levers stand over the corners' row and clear of the info corner's three lines above search (on a
  // phone on its side the lines are beside search, so the levers come down to the row); the first-flight words stand
  // under the time, never on the craft; the caption about satellites waits for the orbit view.
  '.ae-view .af-lever{bottom:calc(' + AH_FOOT + ' + ' + (AE_HIT_PX + 2 * AH_INFO_GAP_PX + AH_INFO_LINES * AH_INFO_LINE_PX) + 'px)}',
  // The levers and the first-flight words are the corners' glass: they read over black space and over a bright world alike.
  '.ae-view .af-lever,.ae-view .af-hint{background:var(--ah-bg);border:1px solid var(--ah-line);-webkit-backdrop-filter:var(--ah-blur);backdrop-filter:var(--ah-blur);box-shadow:0 1px 8px rgba(0,0,0,.4);color:var(--ah-ink)}',
  '.ae-view .af-lever i{background:rgba(255,255,255,.14);border:1.5px solid var(--ah-ink2)}.ae-view .af-lever.af-lever-on i{background:var(--amber);border-color:var(--amber)}',
  '.ae-view #af-throttle::after{background:var(--ah-ink2)}.ae-view .af-hint{text-shadow:none}',
  '.ae-view .af-hint{bottom:auto;top:calc(' + (2 * 8 + AE_HIT_PX) + 'px + var(--sat,0px))}',
  '.ae-view:has(.ae-pin.ae-pin-open) .af-hint{display:none}',   // (the open time capsule stands there)
  '.ae-view[data-mode="' + AH_UFO + '"] .ae-bottom .ae-hint{display:none}',
  // Search stands bottom left in the ground's modes and a mission too: what a mode has along the foot starts beside it.
  '.ae-view .as-strip{inset-inline-start:calc(' + (AH_EDGE_PX + AE_HIT_PX) + 'px + env(safe-area-inset-left))}',
  // A visit's own tools stand on the small glyphs' line, just before them; nothing of a site floats over the picture.
  '.ae-view .as-tools{top:auto;bottom:var(--ah-band-b,var(--ah-band0));inset-inline-start:auto;inset-inline-end:calc(var(--ah-row-end,var(--ah-row-x0)) + env(safe-area-inset-right))}',
  // The drive's menu is a mode's own small disc too: on that line, over the rim's column; its menu opens above it.
  '.ae-view .as-menu-btn{inset-inline-end:calc(var(--ah-row-end,var(--ah-row-x0)) + env(safe-area-inset-right));bottom:var(--ah-band-b,var(--ah-band0))}',
  '.ae-view .as-menu{bottom:calc(var(--ah-band-b,var(--ah-band0)) + ' + (AH_MINOR_PX + AH_GAP_PX) + 'px)}',
  // The ground's own tools (drive, the phone) too: the stand's layer spans the view so they stand on that line.
  '.ae-view .ae-stand-hud{inset:0;padding:0;display:block}.ae-view .ae-stand-tools{position:absolute;display:flex;gap:' + AH_GAP_PX + 'px;bottom:var(--ah-band-b,var(--ah-band0));inset-inline-end:calc(var(--ah-row-end,var(--ah-row-x0)) + env(safe-area-inset-right))}',
  '.ae-view .ah-info.ah-has-link{pointer-events:auto;cursor:pointer}',   // the chip is the name's tap, its lines untouched
  '.ae-view .ah-info.ah-has-link::after{content:"";position:absolute;inset-block:-' + AH_INFO_REACH_BLOCK_PX + 'px;inset-inline-start:-' + AH_INFO_GAP_PX + 'px;inset-inline-end:-' + (AH_INFO_GAP_PX - 2) + 'px}',   // the name's tap reaches past the glass on every side (a finger lands beside a 13 px word), up to what lies there: a disc's gap at the sides (the lines end that far short of the first disc, and the minimap stands that far off), the band's gap under it
  // A name that opens its facts carries a small i after it (the spinner stands there instead while tiles load); amber under a pointer.
  '@media (hover:hover){.ah-info.ah-has-link:hover>b.ah-link{color:var(--amber)}}',
  // The mission's foot is one row with search: its play button, pace pill and list button are all a finger tall, on search's own centre line (the dock ends where search's bottom does), a gap apart; its phase arrows are as tall.
  '.ae-view .am-ctl{padding-inline-start:' + (AE_HIT_PX + AH_GAP_PX) + 'px;margin-bottom:0;gap:' + AH_GAP_PX + 'px}',
  '.ae-view .am-dock{padding-bottom:' + AH_FOOT + '}',
  '.ae-view .am-dock .ae-round{--round:' + AE_HIT_PX + 'px}',
  'html .ae-view .ae-go:not([hidden]){display:flex!important;z-index:' + AH_SHEET_Z + '}',   // the sheet it opens, over whatever layer the mode has laid over the view (and whatever the mode put away along the foot)
  '.ae-view .ah-under{visibility:hidden}',
  'html .ae-view .ae-info,html .ae-view .ae-card,html .ae-view .ae-set{z-index:' + AH_SHEET_Z + '}',   // the facts sheet, a card and the settings are sheets too: over the joystick, the readout chip and the round buttons of a mode's layers, which sit at 50 to 52
  '@media (orientation:landscape) and (max-height:460px){.ae-view .af-lever{bottom:calc(' + AH_FOOT + ' + ' + (AE_HIT_PX + AH_GAP_PX) + 'px)}' +
    '.ae-view #af-throttle{inset-inline-start:calc(' + (AH_EDGE_PX + AE_HIT_PX + AH_INFO_GAP_PX) + 'px + env(safe-area-inset-left))}}'   // (the worlds are a column down that edge there)
].join('\n');
function _aeHudBuild() {
  var view = _ae && _ae.el;
  if (!view) return;
  _aeCss('ah-style', AH_CSS);
  if (!_aeById('ah-corner')) {
    var corner = document.createElement('div');
    corner.className = 'ah-corner'; corner.id = 'ah-corner';
    var row = document.createElement('div');
    row.className = 'ah-row'; row.id = 'ah-row';
    AH_KEYS.forEach(function (k) { var b = _aeById(AH_IDS[k]); if (b) (AH_FEET.indexOf(k) >= 0 ? corner : row).appendChild(b); });
    view.appendChild(corner); view.appendChild(row);
    var go = _aeById('ae-go');
    if (go) view.appendChild(go);   // search's sheet is the view's own, not the foot's: a mode that puts the foot away keeps search
    view.addEventListener('pointerdown', _aeHudPress, true);
    ['pointerup', 'pointercancel'].forEach(function (t) { window.addEventListener(t, _aeHudRelease, true); });
  }
  var pin = _aeById('ae-pin');
  if (pin && !_aeById('ah-mid')) {
    var mid = document.createElement('div');
    mid.className = 'ah-mid'; mid.id = 'ah-mid';
    pin.parentNode.insertBefore(mid, pin);
    mid.appendChild(pin);
    view.insertAdjacentHTML('beforeend', '<div class="ah-info" id="ah-info"><b></b><span></span><span></span><div class="ah-own" id="ah-own"></div></div>');
  }
  if (!_ae.hudCan) _ae.hudCan = { you: true, sbs: true, find: true };
  _aeHudRender();
}
// A finger lands on one of the layer's discs: it shows pressed at once, until the finger lifts or the touch is taken away.
function _aeHudPress(e) {
  var b = e.target && e.target.closest ? e.target.closest('.ah-hero,.ah-minor') : null;
  _aeHudRelease();
  if (b && _ae) { b.classList.add('ah-down'); _ae.hudDown = b; }
}
function _aeHudRelease() {
  if (typeof _ae === 'undefined' || !_ae || !_ae.hudDown) return;
  _ae.hudDown.classList.remove('ah-down'); _ae.hudDown = null;
}
// Where the time strip ends, from the view's top (the strip stands in the layer's column, not on the view itself).
function _aeHudPinFoot(pin) {
  var mid = pin.offsetParent;
  return (mid && mid !== _ae.el ? mid.offsetTop : 0) + pin.offsetTop + pin.offsetHeight;
}
// The one line of a mode's own in the info corner (a mission's height and speed, the pad's countdown): the mode hands
// its element over and writes in it at its own pace (null takes it away again); the type and the place are the corner's.
function _aeHudOwn(el) {
  var box = _aeById('ah-own');
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  if (el) box.appendChild(el);
}
// A mode's own reading (a rover's speed) and its journey (what is left, with a glyph of its own): the mode says them,
// the info corner shows them as its third line, and they go when the mode does.
function _aeHudRead(text) { _aeHudSay('hudRead', text); }
function _aeHudSub(html) { _aeHudSay('hudSub', html); }
function _aeHudSay(key, v) {
  if (!_ae || _ae[key] === (v || '')) return;
  _ae[key] = v || '';
  _aeHudInfoPaint(true);   // (a mode says a reading only when it changes, at its own pace)
}
// ── The info corner ──
// One function per mode gives up to three lines: [what, where, moving]. What is the body (or the craft, or the way:
// "Earth → Mars"); where is the place under the view's centre, or the spot that was tapped (`pinned`); the third line
// is only there while something moves. `html` marks a third line a mode wrote itself, already escaped.
var AH_INFO_MS = 100, AH_EASE_TAU_MS = 220, AH_EASE_SNAP = 0.002, AH_MOVING_KM_S = 0.005, AH_ARROW = ' → ', AH_DOT = ' · ', AH_LIGHT_MIN_S = 1;   // (light's own time over what is left is said from a second up)
// A reading that glides to its new value instead of jumping (and lands exactly once it is within a fifth of a percent).
function _ahEase(key, v, now) {
  var e = _ae.hudEase || (_ae.hudEase = {}), was = e[key];
  if (!was || !isFinite(v) || _aeReduceMotion()) { e[key] = { v: v, at: now }; return v; }
  var k = 1 - Math.exp(-(now - was.at) / AH_EASE_TAU_MS), next = was.v + (v - was.v) * k;
  if (Math.abs(v - next) <= Math.abs(v) * AH_EASE_SNAP) next = v;
  e[key] = { v: next, at: now };
  return next;
}
function _ahSpeedText(kmS) {
  var c = SPEED_OF_LIGHT_KM_S;
  return kmS >= c ? '×' + _orrNum(kmS / c, null, kmS / c < 10 ? 1 : 0) + ' c' : (kmS < 10 ? _aeLenText(kmS, 1) : _aeLenRead(kmS)) + '/s';   // (in the reader's own unit of length, as the distance beside it)
}
// The place under the middle of the picture on the body in view (null off its disc). While the view flies the last one read stays, so a
// flight within a body does not drop the card to its bare name (not "Moon" and nothing else).
var _ahLastCentre = {};
function _ahCentrePlace(key) {
  if (!_ae.gl || !AE_TARGETS[key] || !AE_TARGETS[key].surface) return null;
  if (_ae.fly) return _ahLastCentre[key] || null;
  var c = _aeRimCentre(), at = _aeStHit(key, c.x, c.y);
  _ahLastCentre[key] = at;
  return at;
}
// A body's place from the Sun (AU, J2000 ecliptic) for the corner's distance: a moon at its planet's, the Moon its own; null for craft.
function _ahHelio(key, jd) {
  if (key === 'sun') return [0, 0, 0];
  if (key === 'earth') return _ephBodyJ2000('Earth', jd);
  if (key === 'moon') return _ephBodyJ2000('Moon', jd);
  var b = _aePlanetBody(key);
  if (!b) return null;
  if (b.parent) return _ahHelio(b.parent, jd);
  return b.track ? _aeTracked(b, jd) : _ephBodyJ2000(b.eph, jd);
}
// On the way from one body to another the corner says so, "Mercury → Earth", and how far is left: the real distance between them, shrinking
// with the camera's share of the way still to go. The name and place swap in when it arrives.
function _ahInfoTrip(f, now) {
  var from = f.from.target, to = _ae.target, sc = _ae.scene;
  if (!f.hold || from === to || !sc || !f.look || typeof _ephBodyJ2000 !== 'function') return null;
  var jd = sc.ms / MS_PER_DAY + JD_UNIX_EPOCH, a = _ahHelio(from, jd), b = _ahHelio(to, jd);
  var cam = _ae.gl && _ae.gl.camera, dest = f.destAt || _aeTargetPos();
  var lines = [_aeGoName(from) + AH_ARROW + _aeGoName(to), ''];
  if (a && b && cam) {
    var d = _aeLen(_aeSub(_aeXyz(cam.position), dest));
    if (!f.d0 || d > f.d0) f.d0 = d;
    lines[1] = _aeFarText(_ahEase('trip', _aeLen(_aeSub(a, b)) * AU_KM * d / f.d0, now));
  }
  return { lines: lines };
}
function _ahInfoOrbit(now) {
  if (_ae.fly) { var trip = _ahInfoTrip(_ae.fly, now); if (trip) return trip; }
  var key = _ae.target, pk = _ae.pick && _ae.pick.body === key ? _ae.pick : null, where = '';
  if (pk) {
    var t = typeof _aeTerr !== 'undefined' && _aeTerr[key], h = t && t.state === 'ready' ? _aeStandHeight(key, pk.lat, pk.lon) : 0;
    where = _aeFmtLatLon(pk) + (Math.abs(h) >= 1 ? AH_DOT + _aeStHeightText(h) : '');
  } else if (_ae.place && key === 'earth') where = _ae.place.label || _ae.place.name;
  else { var at = _ahCentrePlace(key); where = at ? _aeFmtLatLon(at) : ''; }
  return { lines: [_aeGoName(key), where], pinned: !!pk || !!(_ae.place && key === 'earth') };
}
// How long light takes over what is left, as one short rounded line: "~13 light minutes" (the unit that fits, whole numbers, a year to a tenth under ten).
var AH_LIGHT_UNITS = [[SECONDS_PER_JULIAN_YEAR, 'year'], [SECONDS_PER_DAY, 'day'], [SECONDS_PER_HOUR, 'hour'], [SECONDS_PER_MINUTE, 'minute'], [1, 'second']], AH_LIGHT_ROUND_UP = 0.95;
function _ahLightSpan(sec) {
  var u = AH_LIGHT_UNITS[AH_LIGHT_UNITS.length - 1];
  for (var i = 0; i < AH_LIGHT_UNITS.length; i++) if (sec >= AH_LIGHT_UNITS[i][0] * AH_LIGHT_ROUND_UP) { u = AH_LIGHT_UNITS[i]; break; }
  var n = sec / u[0], dec = u[1] === 'year' && n < 10 ? 1 : 0, f = Math.pow(10, dec), r = Math.round(n * f) / f;
  return tPlural('alm_light_' + u[1], r, { n: _orrNum(r, null, dec) });
}
function _ahInfoFly(now) {
  var m = _ae.move, sh = _ae.ship;
  if (m && m.vehicle) {   // the movement layer's own state, where it is there
    var what = m.to ? _aeGoName(m.from || m.near) + AH_ARROW + _aeGoName(m.to) : _aeGoName(m.near), far = m.to ? m.toM : m.nearM;
    var kmS = m.speedC >= 1 ? m.speedC * SPEED_OF_LIGHT_KM_S : (m.speedMS || 0) / 1000;
    return { lines: [what, [isFinite(far) ? _aeLenRead(_ahEase('far', far / 1000, now)) : '', kmS > AH_MOVING_KM_S ? _ahSpeedText(_ahEase('v', kmS, now)) : ''].filter(Boolean).join(AH_DOT),
      m.lightS >= AH_LIGHT_MIN_S ? _ahLightSpan(m.lightS) : ''] };
  }
  if (!sh || !sh.near) return null;
  var v = sh.kmS || 0, moving = v > AH_MOVING_KM_S;
  return { lines: [_aeGoName(sh.near.body.key), _aeLenRead(_ahEase('far', sh.near.alt * AE_EARTH_RADIUS_KM, now)), moving ? _ahSpeedText(_ahEase('v', v, now)) : ''] };
}
function _ahInfoGround() {
  var st = _ae.stand || _ae.standPending, site = _ae.site, m = _ae.move;
  if (site) {
    var place = (site.def && site.def.name) || (site.row && site.row[0]) || '', go = '<span id="ah-read">' + _almEsc(_ae.hudRead || '') + '</span>' + (_ae.hudRead && _ae.hudSub ? AH_DOT : '') + '<span id="ah-sub">' + (_ae.hudSub || '') + '</span>';   // the rover's speed, then its journey
    var at = site.row && isFinite(site.row[1]) ? _aeFmtLatLon({ lat: site.row[1], lon: site.row[2] }) : '';
    if (!site.drive) return typeof _asInfoLines === 'function' && site.def ? { lines: _asInfoLines(site), open: _ahFactsOpen(AE_INFO_SITE) } : { lines: [_aeGoName(site.body), at] };
    return { lines: [_aeGoName(site.body), place === _aeGoName(site.body) ? at : place, go], html: true };
  }
  if (!st) return null;
  var walk = m && m.speedMS > 0 ? [_aeStHeightText(m.speedMS) + '/s', m.coveredM ? _aeStHeightText(m.coveredM) : ''].filter(Boolean).join(AH_DOT) : '';
  return { lines: [_aeGoName(st.key), st.lat !== undefined ? _aeFmtLatLon(st) : '', walk] };
}
function _ahInfoNamed() { return { lines: [_aeWhereName(), ''], open: _ahMissionArticle() }; }
// A mission's name in the corner opens its article in the reader's encyclopedia, where it has one: its craft's Q-ID (Sent's row,
// AE_GO_MS_SENT), asked once a mission. One opener a mission, so the corner's "is it the same" test holds from frame to frame.
var _ahMissionOpeners = {};
function _ahMissionArticle() {
  var s = _ae && _ae.mission, id = s && s.id;
  if (!id || !window.AlmanacLinks || !AlmanacLinks.resolve) return null;
  if (!(id in _ahMissionOpeners)) {
    _ahMissionOpeners[id] = null;
    var sentId = AE_GO_MS_SENT[id];
    if (sentId) {
      _aeSentStart();
      _aeLinkWait(function () { return !!_aeSent; }, function () {
        var o = _aeSent.byId[sentId];
        if (!o || !o.qid) return;
        AlmanacLinks.resolve([o.qid]).then(function (links) {
          var hit = links[o.qid];
          if (hit) { _ahMissionOpeners[id] = function () { AlmanacLinks.openHit(hit); }; _aeHudInfoPaint(true); }
        });
      });
    }
  }
  return _ahMissionOpeners[id];
}
var AH_INFO = { orbit: _ahInfoOrbit, ufo: _ahInfoFly, stand: _ahInfoGround, drive: _ahInfoGround, site: _ahInfoGround, mission: _ahInfoNamed, pad: _ahInfoNamed };
// The body the corner names, in any mode: the ground stood on, the site's body, the world flown near, the body in view.
function _ahBodyNow() {
  var st = _ae.stand || _ae.standPending, sh = _ae.ship;
  if (st) return st.key;
  if (_ae.site) return _ae.site.body;
  if (_ae.mission) return null;   // (a mission's name is its own)
  if (sh && sh.near) return sh.near.body.key;
  return _ae.fly ? null : _ae.target;
}
// The name opens its body's facts (the card a tap on the world opens), on the ground as in orbit: one opener a body, so the corner's
// "is it the same" test holds from frame to frame.
var _ahOpeners = {};
function _ahFactsOpen(k) {
  if (!k || !_aeHasFacts(k)) return null;
  return _ahOpeners[k] || (_ahOpeners[k] = function () { if (_ae.info === k) _aeCloseInfo(true); else _aeOpenInfo(k); });
}
// The name in the info corner tapped: while tiles load, what the spinner after it means; else its article, where it has one.
function _ahNameTap() {
  var el = _aeById('ah-info');
  if (el && el.classList.contains('ae-loading')) { _aeShowHint(_aeT('alm_tiles_loading')); return; }
  if (this._open) this._open();
}
// Whatever a mode docks along the foot: the corner's lines stand above it (the first of these that is drawn).
var AH_BAND_DISCS = '#ah-row>.ae-btn:not([hidden]),.as-tools-end>.ae-btn:not([hidden])';
var AH_DOCK = { mission: '.am-dock', pad: '.as-strip', site: '.as-strip' };
function _aeHudInfoPaint(force) {
  var el = _aeById('ah-info');
  if (!el || !el.children || !_ae || !_ae.el) return;   // (not built yet)
  var now = performance.now();
  if (!force && _ae.hudInfoAt && now - _ae.hudInfoAt < AH_INFO_MS) return;
  _ae.hudInfoAt = now;
  var m = _aeMode(), fn = AH_INFO[m], up = AH_TOUCH_LAYER.indexOf(m) < 0 && _aeHudSheetUp();   // (a mode with its own layer over the view has put the cards away already)
  var d = fn && !up && !_ae.el.classList.contains('ae-static') ? fn(now) : null;
  var mini = _aeById('ae-mini'), byMini = !!d && m === AH_ORBIT && !!mini && !mini.hidden, cls = 'ah-info' + (byMini ? ' ah-by-mini' : '') + (d && d.pinned ? ' ah-pinned' : '') + (el.classList.contains('ae-loading') ? ' ae-loading' : '') + (el.classList.contains('ah-has-link') ? ' ah-has-link' : '');
  if (el.hidden !== !d) el.hidden = !d;
  if (el.className !== cls) el.className = cls;
  if (_ae.el.classList.contains('ah-band') !== byMini) _ae.el.classList.toggle('ah-band', byMini);
  if (m !== _ae.hudInfoMode) { _ae.hudInfoMode = m; _ae.hudEase = null; }   // a new mode: nothing glides in from the last one's numbers
  var docks = d && AH_DOCK[m] ? _ae.el.querySelectorAll(AH_DOCK[m]) : [], top = Infinity;   // (a mode builds its dock after it starts: looked for until it is there)
  for (var k = 0; k < docks.length; k++) if (docks[k].offsetParent && docks[k].textContent) top = Math.min(top, docks[k].getBoundingClientRect().top);
  var over = isFinite(top) ? Math.round(_ae.el.getBoundingClientRect().bottom - top) + AH_INFO_GAP_PX + 'px' : '';
  if (el.style.bottom !== over) el.style.bottom = over;
  _aeSetVar('--ah-band-b', over);   // (the small glyphs' row, and a mode's own tools beside it, stand on the same line)
  if (!d) return;
  // The lines end short of the first small disc on their line (the glyphs' row, a visit's own tools before it).
  var first = Infinity, discs = document.documentElement.dir === 'rtl' ? [] : _ae.el.querySelectorAll(AH_BAND_DISCS);
  for (var q = 0; q < discs.length; q++) if (discs[q].offsetParent) first = Math.min(first, discs[q].getBoundingClientRect().left);
  var room = isFinite(first) ? Math.max(0, Math.round(first - el.getBoundingClientRect().left - AH_INFO_GAP_PX)) + 'px' : '';
  if (el.style.maxWidth !== room) el.style.maxWidth = room;
  var name = el.children[0], open = d.open || _ahFactsOpen(_ahBodyNow()) || null;
  if (name._open !== open) { name._open = open; name.classList.toggle('ah-link', !!open); }
  if (!el.onclick) el.onclick = function () { _ahNameTap.call(name); };   // the whole chip is the name's tap: a finger's 44 px, its lines left as they are
  if (el.classList.contains('ah-has-link') !== (!!open || el.classList.contains('ae-loading'))) el.classList.toggle('ah-has-link');
  for (var i = 0; i < AH_INFO_LINES; i++) {
    var line = d.lines[i] || '', c = el.children[i];
    if (c._t === line) continue;
    if (i === 0 && c._t && line && !_aeReduceMotion()) { c.classList.remove('ah-in'); void c.offsetWidth; c.classList.add('ah-in'); }   // a new name eases in
    c._t = line;
    if (d.html && i === 2) c.innerHTML = line; else c.textContent = line;
  }
}
// How much of the view's foot the layer's controls weigh on, for the picture's centre (_aeInfoShiftTarget, the one place
// it is used): the corners' row across the whole width, and half of the minimap's band above it, which holds only the
// left (the minimap and the info corner). One figure in every mode, band or none: the picture does not step when a
// mode changes under it (leaving the craft moves nothing).
var AH_BAND_SHARE = 0.5;
function _aeHudFootPx() { return 2 * AH_EDGE_PX + AE_HIT_PX + AH_BAND_SHARE * (AE_MINI_PX + AH_BAND_GAP_PX); }
// The worlds' track is moving: what passes its start fades there, as at its end (AH_CSS .ah-run). At rest it stands on a
// whole world (the track snaps to one), so nothing is left half faded.
var AH_TRACK_REST_MS = 160;
// The track fades at its end only while there is more to scroll to (the strip runs down the side when the phone stands on its side).
function _aeChipsEdge(c) {
  var col = getComputedStyle(c).flexDirection === 'column';
  var left = col ? c.scrollHeight - c.clientHeight - c.scrollTop : c.scrollWidth - c.clientWidth - Math.abs(c.scrollLeft);
  c.classList.toggle('ah-end', left <= 1);
}
function _aeHudTrack() {
  var c = _aeById('ae-chips');
  if (!c) return;
  _aeChipsEdge(c);
  c.classList.add('ah-run');
  clearTimeout(_ae.hudTrackT);
  _ae.hudTrackT = setTimeout(function () { c.classList.remove('ah-run'); }, AH_TRACK_REST_MS);
}
// Somewhere else was chosen in search from a mode on the ground or in a mission: that mode is left at once and quietly
// (its clock put back, as the way out does), and the choice goes on from the orbit view.
function _aeHudLeaveGround() {
  if (_ae.mission && typeof _amStop === 'function') { _amStop(true); if (typeof _amRestoreTime === 'function') _amRestoreTime(); }
  if (_ae.site && typeof _aeSiteLeave === 'function') _aeSiteLeave(true);
  if ((_ae.stand || _ae.standPending) && typeof _aeStandDrop === 'function') _aeStandDrop();
}
// A control's own word on whether it has something to do now (the rim with nowhere to go has not).
function _aeHudCan(key, on) {
  if (!_ae || !_ae.hudCan || _ae.hudCan[key] === !!on) return;
  _ae.hudCan[key] = !!on;
  _aeHudRender();
}
function _aeHudCanNow(key) { return !!(_ae && _ae.hudCan && _ae.hudCan[key]); }
// The body under your feet in a mode on the ground ('' in space).
function _aeHudGroundKey() {
  var st = _ae.stand || _ae.standPending;
  return _ae.site ? _ae.site.body : st ? st.key : '';
}
// Something to read stands over the foot (a card, the facts, the Go sheet): only the column's foot stays beside it.
function _aeHudSheetUp() {
  var c = _ae.el.classList, go = _aeById('ae-go');
  return c.contains('ae-carded') || c.contains('ae-info-up') || !!(go && !go.hidden);
}
// A box as laid out (its transform, a sheet still sliding up, left out), in the view's own px.
function _aeLaidBox(el, view) {
  var l = 0, t = 0;
  for (var p = el; p && p !== view; p = p.offsetParent) { l += p.offsetLeft; t += p.offsetTop; }
  return { l: l, t: t, r: l + el.offsetWidth, b: t + el.offsetHeight };
}
// A sheet is over the controls: those it covers are put away (kept in place, so they come back where they were), the way out stays.
var AH_SHEET_IDS = ['ae-go', 'ae-info', 'ae-card', 'ae-set'], AH_COVERABLE = '.ah-hero,.ah-minor,#ae-find';
function _aeHudUnderSheets(up) {
  if (!up && !_ae.hudUnder) return;   // nothing up and nothing put away: no layout read (this runs on every change of view, a held pinch's every move)
  var view = _ae.el, any = false, boxes = AH_SHEET_IDS.map(function (id) {
    var el = _aeById(id), on = id === 'ae-info' ? !!_ae.info : id === 'ae-set' ? !!_ae.setOpen : !!el && !el.hidden;
    return on && el ? _aeLaidBox(el, view) : null;
  }).filter(Boolean);
  Array.prototype.forEach.call(view.querySelectorAll(AH_COVERABLE), function (c) {
    var q = c.hidden || (c.id === 'ae-find' && _aeGoUp()) ? null : _aeLaidBox(c, view), under = !!q && boxes.some(function (b) { return q.l < b.r && q.r > b.l && q.t < b.b && q.b > b.t; });
    if (c.classList.contains('ah-under') !== under) c.classList.toggle('ah-under', under);
    any = any || under;
  });
  _ae.hudUnder = any;
}
// The mode's name on the view, and the corner as that mode has it. The one place a corner control is shown or put away.
function _aeHudRender() {
  if (typeof _ae === 'undefined' || !_ae || !_ae.el || !_ae.hudCan) return;
  var m = _aeMode(), d = AH_CORNER[m] || AH_CORNER.plan, up = _aeHudSheetUp(), still = _ae.el.classList.contains('ae-static');
  if (_ae.el.getAttribute('data-mode') !== m) { _ae.el.setAttribute('data-mode', m); _aeInputReset(); _aeHudRead(''); _aeHudSub(''); _aeHudInfoPaint(true); }   // a mode's words go with it
  var mid = _aeById('ah-mid');
  if (mid) mid.classList.toggle('ah-over', AH_TOUCH_LAYER.indexOf(m) >= 0);
  [AH_FIND, AH_UFO_BTN].forEach(function (k) {
    var b = _aeById(AH_IDS[k]), gone = !d[k] || !_ae.hudCan[k] || still;
    if (b && b.hidden !== gone) b.hidden = gone;
  });
  var foot = false, layersOut = !!(window.matchMedia && matchMedia(AH_LAYERS_MQ).matches);
  AH_KEYS.forEach(function (k) {
    var b = _aeById(AH_IDS[k]), isFoot = k === d.foot, inRow = k === AH_YOU && d.youOn && _aeHudGroundKey() !== d.youOn ? -1 : d.row.indexOf(k);
    var edge = AH_EDGE_LAYERS.indexOf(k) >= 0;
    if (AH_LAYERS.indexOf(k) >= 0 && !layersOut) inRow = -1;
    if (edge && !(_ae.hudCan[AH_YOU] && d.row.indexOf(AH_YOU) >= 0 && !(d.youOn && _aeHudGroundKey() !== d.youOn))) inRow = -1;   // (no locate button, no column over it)
    if (!b) return;
    var show = !!_ae.hudCan[k] && !(still && k !== AH_RIM) && (isFoot || (!up && inRow >= 0));   // (the column goes where the locate button goes: a sheet or card up puts it away)
    if (b.hidden === show) b.hidden = !show;
    foot = foot || (isFoot && show);
    if (b.classList.contains('ah-hero') !== isFoot) { b.classList.toggle('ah-hero', isFoot); b.classList.toggle('ah-minor', !isFoot); }   // its rank is its place's
    if (!b.classList.contains('ah-hero') && !b.classList.contains('ah-minor')) b.classList.add('ah-minor');
    var order = String(isFoot ? 0 : inRow + 1);
    if (b.style.order !== order) b.style.order = order;
  });
  // The worlds' track ends short of the foot; the info corner short of the small glyphs' row above it.
  var stacked = !!(window.matchMedia && matchMedia(AH_STACK_MQ).matches);
  var small = AH_KEYS.filter(function (k) { var b = _aeById(AH_IDS[k]); return b && !b.hidden && AH_FEET.indexOf(k) < 0 && (stacked || AH_EDGE_LAYERS.indexOf(k) < 0); }).length;   // (the edge column is over the row, not in it, unless the row stands up as a column)
  _aeHudUnderSheets(up || !!_ae.setOpen);
  _aeSetVar('--ah-end', (foot ? AH_EDGE_PX + AE_HIT_PX + AE_RIM_GAP_PX : AE_FOOT_PAD_PX) + 'px');
  if (small && stacked) small = 1;   // stacked up the corner's column, they take one column's width
  _aeSetVar('--ah-row-end', 'calc(var(--ah-row-x0) + ' + small * (AH_MINOR_PX + AH_GAP_PX) + 'px)');
}
// What floats in the picture (a pointer to a world out of sight) keeps clear of the controls: the levers, the discs, the
// info corner, the time and the worlds' row. Their boxes are read at most every AH_KEEP_MS, never once a frame.
var AH_KEEP = '.af-lever,.ah-hero,.ah-minor,#ah-info,#ae-pin,#ae-views,.as-strip', AH_KEEP_MS = 400, AH_KEEP_PAD_PX = 4;
function _aeHudKeepOut(now) {
  if (_ae.hudKeep && now - _ae.hudKeepAt < AH_KEEP_MS) return _ae.hudKeep;
  var view = _ae.el, at = view.getBoundingClientRect(), keep = [];
  Array.prototype.forEach.call(view.querySelectorAll(AH_KEEP), function (el) {
    var b = _ahSeenBox(el, view);
    if (b) keep.push({ l: b.l - at.left - AH_KEEP_PAD_PX, t: b.t - at.top - AH_KEEP_PAD_PX, r: b.r - at.left + AH_KEEP_PAD_PX, b: b.b - at.top + AH_KEEP_PAD_PX });
  });
  _ae.hudKeepAt = now;
  return (_ae.hudKeep = keep);
}
// Where a box of this size (the view's own px) may stand: where it was asked, or else the nearest place in the view that covers
// no control (against the edge of one of them: the candidates are each control's four sides).
function _aeHudCovers(l, t, w, h) {
  return _aeHudKeepOut(performance.now()).some(function (k) { return l < k.r && l + w > k.l && t < k.b && t + h > k.t; });
}
function _aeHudClear(l, t, w, h) {
  var keep = _aeHudKeepOut(performance.now());
  var covers = function (x, y) { return _aeHudCovers(x, y, w, h); };
  if (!covers(l, t)) return { x: l, y: t };
  var best = null, bestD = Infinity;
  keep.forEach(function (k) {
    [[k.r, t], [k.l - w, t], [l, k.b], [l, k.t - h]].forEach(function (c) {
      var d = Math.abs(c[0] - l) + Math.abs(c[1] - t);
      if (d < bestD && c[0] >= 0 && c[1] >= 0 && c[0] + w <= _ae.w && c[1] + h <= _ae.h && !covers(c[0], c[1])) { best = c; bestD = d; }
    });
  });
  return best ? { x: best[0], y: best[1] } : { x: l, y: t };
}
// What is on screen now, for the contract every mode keeps (tests/test_almanac_hud_contract_browser.py): each control a
// finger can reach and each line of words the layer shows, with its box.
var AH_PROBE_TAPS = '#ae-pin:not(.ae-pin-open) #ae-clock,button,a[href],input,[role="button"],[role="slider"]';   // (shut, the whole time chip is one tap)
var AH_PROBE_WORDS = '#ah-info>:not(.ah-own),#ae-hint,.as-cap,.am-read,.pv-clock,.af-read,.ae-walk-hint,.af-hint';
var AH_PROBE_OUT = '#ae-back,#as-exit,#am-exit,.pv-back,#ae-stand-back';   // the way out, and any second one a mode might draw
var AH_PROBE_SCENE = '#ae-labels,#ae-lms,#ae-spin,.ae-stand-crafts,#af-refs,.am-mark';   // names in the picture: the scene's, not the layer's
var AH_LINE_EM = 1.3;   // a line's height where the stylesheet leaves it to the font
var AH_HIT_PX = 44, AH_ALPHA_SEEN = 0.02;
function _ahAlpha(color) {
  var m = /rgba?\(([^)]+)\)/.exec(color || ''), p = m ? m[1].split(',') : [];
  return !m ? 0 : p.length > 3 ? parseFloat(p[3]) : 1;
}
// The part of an element a person sees: its box cut by every scroller it stands in; null when it is not drawn.
function _ahSeenBox(el, view) {
  var r = el.getBoundingClientRect(), box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  for (var p = el; p && p !== view.parentElement; p = p.parentElement) {
    var cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < AH_ALPHA_SEEN) return null;
    if (p !== el && cs.overflow !== 'visible') {
      var c = p.getBoundingClientRect();
      box.l = Math.max(box.l, c.left); box.t = Math.max(box.t, c.top); box.r = Math.min(box.r, c.right); box.b = Math.min(box.b, c.bottom);
    }
  }
  return box.r - box.l < 1 || box.b - box.t < 1 ? null : box;
}
function _aeHudProbe() {
  var view = _ae && _ae.el, out = [], seen = [];
  if (!view) return null;
  function add(el, kind) {
    if (seen.indexOf(el) >= 0 || el.closest(AH_PROBE_SCENE)) return;
    var box = _ahSeenBox(el, view), cs = getComputedStyle(el);
    if (!box || (kind === 'tap' && cs.pointerEvents === 'none')) return;
    seen.push(el);
    var cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2, top = document.elementFromPoint(cx, cy), half = AH_HIT_PX / 2 - 1;
    function mine(x, y) { var t = document.elementFromPoint(x, y); return !!t && (el === t || el.contains(t)); }
    out.push({
      id: el.id || (el.parentElement.id === 'ah-info' ? 'ah-info-' + Array.prototype.indexOf.call(el.parentElement.children, el) : '') || (el.getAttribute('class') || '').split(' ').filter(function (c) { return c.indexOf('ae-btn') < 0 && c.indexOf('ae-round') < 0; })[0] || el.tagName,
      kind: kind, box: [box.l, box.t, box.r - box.l, box.b - box.t].map(Math.round),
      top: kind !== 'tap' || !top || el === top || el.contains(top) ? '' : (top.id || top.getAttribute('class') || top.tagName),   // what takes the tap in its place
      hit: kind === 'tap' && mine(cx - half, cy) && mine(cx + half, cy) && mine(cx, cy - half) && mine(cx, cy + half),   // a finger's width each way
      round: kind === 'tap' && el.classList.contains('ae-round'), rank: el.classList.contains('ah-hero') ? 'hero' : el.classList.contains('ah-minor') ? 'minor' : '',
      disc: _ahAlpha(cs.backgroundColor) > AH_ALPHA_SEEN,
      inPill: !!el.closest('#ae-pin'), inRow: !!el.closest('#ae-views'), inDock: !!el.closest('.as-strip,.am-dock,.pv-ctl,.ap,#ae-card,#ae-go,#ae-info,#ae-set,#ae-maps-chip'),
      out: el.matches(AH_PROBE_OUT), lines: kind === 'words' ? Math.round((el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * AH_LINE_EM)) : 0,
      pressed: el.getAttribute('aria-pressed') === 'true', text: kind === 'words' ? el.textContent.trim() : ''
    });
  }
  Array.prototype.forEach.call(view.querySelectorAll(AH_PROBE_TAPS), function (el) { add(el, 'tap'); });
  Array.prototype.forEach.call(view.querySelectorAll(AH_PROBE_WORDS), function (el) { if (el.textContent.trim()) add(el, 'words'); });
  var pin = _aeById('ae-pin'), pinBox = pin && _ae.pinOpen ? _ahSeenBox(pin, view) : null;
  return {
    mode: _aeMode(), pillOpen: !!_ae.pinOpen, bare: view.classList.contains('ae-bare'), named: !!_aeById('ae-bodyname'),
    pill: pinBox ? [pinBox.l, pinBox.t, pinBox.r - pinBox.l, pinBox.b - pinBox.t].map(Math.round) : null,
    controls: out
  };
}

// The orrery, drawn before this file ran, can now say Earth opens in 3D.
if (typeof _orreryRenderHint === 'function') _orreryRenderHint();
// This file loads once the Almanac is shown and quiet (almanac.js _almLoadEarth); the view itself (three.js, its maps and
// shaders) is made ready only when the Moon is touched or the view opened, never behind the page.
