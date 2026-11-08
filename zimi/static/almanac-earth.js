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
var AE_TWO_PI = 2 * Math.PI;
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
// `watched`: time running fast, or the view on the station. Then the ISS keeps its (approximate) dot past
// AE_ISS_DOT_DAYS: at an hour a second a fortnight passes in six minutes and the station went out like a light, and a
// flight to it had nothing to follow. Where along its orbit is the guess the faded dot and its label already own.
function _aeSatStanding(ageDays, isIss, watched) {
  var a = Math.abs(ageDays);
  if (a > AE_SAT_WINDOW_DAYS) return 'none';
  if (!isIss || a <= AE_ISS_EXACT_DAYS) return 'exact';
  return a <= AE_ISS_DOT_DAYS || watched ? 'approximate' : 'orbit';
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
var AE_FLY_MS_PER_LOG = 300;
// No flight turns the picture faster than this, in degrees a frame at 60 fps: a flight that would is stretched.
var AE_FLY_MAX_TURN_DEG = 4, AE_FLY_MAX_STRETCH = 4, AE_FRAME_MS = 1000 / 60, AE_FLY_PLAN_STEPS = 60;
// A body drawn smaller than this across is marked with a ring and its name; the mark fades out by the second size.
var AE_MARK_SMALL_PX = 24, AE_MARK_GONE_PX = 64, AE_MARK_SAME_PX = 6;   // marks closer than this: only the first
// Through a flight between bodies both ends wear a ring the size of the body as drawn (the Sun from the Moon's night
// side is nearly black, and a ring is all that outlines it): its radius plus this margin, never under the minimum,
// gone by the time the camera has arrived (the last share of the arrival).
var AE_RING_MARGIN_PX = 5, AE_RING_MIN_R_PX = 11, AE_RING_FADE_FROM = 0.7;
var AE_MARKED = [
  { body: 'earth', name: function () { return _tp('Earth'); } },
  { body: 'moon', name: function () { return _aeT('alm_moon'); } },
  { body: 'sun', name: function () { return _aeT('alm_sun'); } }
];
var AE_FLY_START_DIST = 40;           // the zoom in from the orrery starts this far out
var AE_TAP_SLOP_PX = 6;               // a pointer that moved less than this was a tap
var AE_TAP_RADIUS_PX = 22;            // how near a tap must land to pick something
var AE_MINI_PX = 96;                   // the minimap's size (CSS px)
var AE_NAME_DIAG = 0.75;               // a mark's corner name stands off its ring this share of the radius each way
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
var AE_MAX_DIST_SUN = 100000;         // out from the Sun far enough to hold every planet's orbit as shown, on a phone
var AE_FLY_FAR_MS = 1600;             // the longest flight: to or from the Sun, 3,000 Earth radii
var AE_HINT_MS = 4500;
// Show where I am: a crosshair, the mark every map uses for "locate me".
var AE_LOCATE_SVG = typeof ALM_LOCATE_SVG === 'string' ? ALM_LOCATE_SVG : '';   // almanac.js
var AE_INFO_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 10.5v7"/><circle cx="12" cy="6.6" r="1.5" fill="currentColor" stroke="none"/></svg>';
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
function _aeReduceMotion() { return (typeof _almReduceMotion === 'function') ? _almReduceMotion() : false; }
function _aeLink(key, html) { return window.AlmanacLinks ? window.AlmanacLinks.wrap(key, html) : html; }
function _aeLinked(key) { return !!(window.AlmanacLinks && window.AlmanacLinks.linkFor(key)); }
function _aeClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function _aeEaseOut(p) { return 1 - Math.pow(1 - p, 3); }
// A flight speeds up, cruises and slows to arrive: cubic in and out.
// Zero speed and zero acceleration at both ends: a turn eased with it starts and stops without a step in its rate.
function _aeSmoother(p) { p = _aeClamp(p, 0, 1); return p * p * p * (p * (6 * p - 15) + 10); }
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
// The view's two marking colours: the spacecraft's teal (AE_PROBE_COLOR is it as GL floats) and the amber of
// places it names (a landing, you, the status line).
var AE_PROBE_HEX = '#6ee7d8', AE_AMBER_HEX = '#f5c16c';
// The view's sheets and cards (Go to, settings, a body's card) are solid: the scene and the labels under them never
// show through what is being read.
var AE_PANEL_BG = '#0e0e10', AE_PANEL_BG_RED = '#000';
var AE_CSS = [
  '.ae-view{position:absolute;inset:0;z-index:40;background:#000;display:none;overflow:hidden;color:var(--text);touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',
  '.ae-view.open{display:block}',
  '.almanac-view.ae-covered>.almanac-content{visibility:hidden}',
  // Mid-swap with the hero: the page shows through, dimming as the view
  // opens (_aeHandApply), and the controls come up at the end.
  '.ae-view.ae-hand{background:transparent}',
  '.ae-top,.ae-bottom,.ae-status,.ae-labels{opacity:var(--ae-ui,1)}',
  '.ae-view.ae-hand .ae-top>*,.ae-view.ae-hand .ae-row,.ae-view.ae-hand .ae-clock,.ae-view.ae-hand .ae-note{pointer-events:none}',
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
  '#ae-map{display:inline-flex;align-items:center;gap:6px}',
  '[dir="rtl"] .ae-chev{display:inline-block;transform:scaleX(-1)}',
  '.ae-top-end{display:flex;align-items:flex-start;gap:8px;min-width:0;margin-inline-start:auto}',   // alone in the top row: at its end
  '.ae-tools{display:flex;flex-direction:column;gap:6px}',
  '.ae-round{flex:0 0 auto;width:34px;padding:0;display:inline-flex;align-items:center;justify-content:center}',
  '.ae-gear[aria-expanded="true"]{color:var(--amber);border-color:var(--amber-border)}',
  '.ae-set{position:absolute;top:56px;inset-inline-end:16px;width:min(300px,calc(100% - 32px));box-sizing:border-box;background:' + AE_PANEL_BG + ';border:1px solid var(--border);border-radius:12px;padding:12px 10px 10px;font-size:13px;line-height:1.45;color:var(--text2);z-index:1}',
  '.ae-set[hidden]{display:none}',
  '.ae-set h3{margin:0 4px 6px;font-size:13px;font-weight:600;color:var(--text)}',
  '@media (pointer:coarse){.ae-set h3{padding-inline-end:40px}}',
  '.ae-set-choice{display:flex;gap:10px;align-items:flex-start;padding:7px 4px;border-radius:8px;cursor:pointer}',
  '.ae-set-choice:hover{background:rgba(255,255,255,.04)}',
  '.ae-set-orbits{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:7px 4px}',
  '.ae-set-orbits b{font-weight:500;color:var(--text);margin-right:auto}',
  '.ae-set-orbits label{display:flex;gap:5px;align-items:center;cursor:pointer;color:var(--text2)}',
  '.ae-set-orbits input{margin:0;accent-color:var(--amber)}',
  '.ae-set-choice input{margin:3px 0 0;flex:0 0 auto;accent-color:var(--amber)}',
  '.ae-set-choice b{display:block;font-weight:500;color:var(--text)}',
  '.ae-set-choice small a{color:var(--amber);text-decoration:none}',
  '.ae-set-choice small{display:block;font-size:11.5px;color:var(--text2)}',
  '.ae-set-choice.ae-off{cursor:default}',
  '.ae-set-choice.ae-off:hover{background:none}',
  '.ae-set-why{margin:6px 4px 0;font-size:11.5px;color:var(--text2)}',
  '.ae-set-data{margin:8px 4px 0;padding-top:8px;border-top:1px solid var(--border);font-size:11.5px;color:var(--text2)}',
  '.ae-set-data[hidden]{display:none}',
  '.ae-set-data .ae-fresh{margin-inline-start:0}',
  '.ae-set-hd{margin-top:4px;border-top:0;padding-top:0}',
  '.ae-set-hd b{color:var(--text);font-weight:600}',
  '.ae-set-sep{height:1px;margin:6px 4px;background:var(--border)}',
  '.ae-status{position:absolute;left:16px;right:16px;top:66px;text-align:center;font-size:13px;line-height:1.4;color:' + AE_AMBER_HEX + ';pointer-events:none;text-shadow:0 1px 3px #000}',
  '.ae-bottom{position:absolute;left:0;right:0;bottom:0;padding:28px 16px calc(12px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;align-items:center;background:linear-gradient(transparent,rgba(0,0,0,.72));pointer-events:none}',
  '.ae-row{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;pointer-events:auto}',
  // Go to: a compact sheet over the controls (the field at its foot, under the thumb; above the keyboard when it is up), its places in groups, each with its small disc.
  '.ae-go{position:absolute;left:12px;right:12px;bottom:calc(8px + env(safe-area-inset-bottom));max-height:min(50vh,440px,var(--sheet-room,100vh));overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;background:' + AE_PANEL_BG + ';border:1px solid var(--border);border-radius:14px;padding:6px 6px 8px;pointer-events:auto;z-index:2}',
  '.ae-go[hidden]{display:none}',
  // On a narrow phone the row's chips draw in a little so the five places and Go to stay one line.
  '#ae-views{flex-wrap:nowrap;align-items:center;max-width:calc(100vw - 24px);margin-inline:auto}',
  '#ae-views .ae-round{flex:none}',
  '.ae-spintools{display:flex;flex:none;gap:inherit}',
  '.ae-spintools[hidden]{display:none}',
  '.ae-chips{display:flex;flex:0 1 auto;gap:inherit;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:none;min-width:0}',
  '.ae-chips::-webkit-scrollbar{display:none}',
  '.ae-chips .ae-btn{flex:none}',
  '@media (max-width:400px){#ae-views,.ae-chips{gap:4px}#ae-views .ae-btn:not(.ae-round){padding-inline:10px}}',
  '@media (max-width:370px){#ae-views,.ae-chips{gap:3px}#ae-views .ae-btn{font-size:12px}#ae-views .ae-btn:not(.ae-round){padding-inline:5px}#ae-views .ae-round{width:30px}}',
  '.ae-go-find{position:sticky;bottom:-8px;z-index:1;display:flex;align-items:center;gap:8px;margin:4px -6px -8px;padding:8px 14px;background:' + AE_PANEL_BG + ';border-top:1px solid var(--border);color:var(--text3)}',
  '.ae-go-find input{flex:1;min-width:0;height:32px;border:0;background:none;color:var(--text);font:inherit;font-size:16px;outline:none;-webkit-user-select:text;user-select:text;-webkit-appearance:none;appearance:none}',
  '.ae-go-find input::-webkit-search-cancel-button{-webkit-appearance:none}',
  '.ae-go-find:focus-within{color:var(--amber)}',
  '.ae-go-found .ae-go-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ae-go-town{background:var(--text3);color:var(--text3)}',
  '.ae-go-wait{grid-column:1/-1;padding:10px 12px;font-size:13px;color:var(--text3)}',
  '.ae-go h4{margin:10px 10px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text3)}',
  '.ae-go-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px}',
  '.ae-go-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 10px;border:0;border-radius:10px;background:none;font:inherit;font-size:14px;color:var(--text);text-align:start;cursor:pointer}',
  '.ae-go-row:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '@media (hover:hover){.ae-go-row:hover{background:rgba(255,255,255,.06)}}',
  '.ae-go-row[aria-current="true"]{color:var(--amber)}',
  '.ae-go-list.ae-go-found{grid-template-columns:minmax(0,1fr)}',
  '.ae-go-list.ae-go-found[hidden]{display:none}',
  '.ae-go-dot{flex:0 0 auto;width:14px;height:14px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.08)}',
  '.ae-go-probe{width:6px;height:6px;margin:0 4px;box-shadow:0 0 6px currentColor;color:' + AE_PROBE_HEX + '}',
  '.night-red .ae-go,.night-red .ae-go-find{background:' + AE_PANEL_BG_RED + '}',
  // Where you are among the planets, in a corner while near one: tap for the whole system.
  '.ae-mini{position:absolute;left:12px;top:calc(env(safe-area-inset-top) + 12px);width:' + AE_MINI_PX + 'px;height:' + AE_MINI_PX + 'px;padding:0;border:1px solid var(--border);border-radius:50%;background:rgba(0,0,0,.55);overflow:hidden;cursor:pointer}',
  '.ae-mini[hidden]{display:none}',
  '.ae-mini canvas{width:100%;height:100%;display:block}',
  '.ae-mini:focus-visible{outline:2px solid var(--amber);outline-offset:2px}',
  '.ae-row[hidden]{display:none}',
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
  // Planets side by side: a button over each planet's place carries its names; the globe's own labels and notes step aside.
  '.ae-spin{position:absolute;inset:0;pointer-events:none;display:none}',
  '.ae-spinning .ae-spin{display:block}',
  '.ae-spinning .ae-canvas{cursor:default}',
  '.ae-spinning .ae-labels,.ae-spinning .ae-lms,.ae-spinning .ae-mini,.ae-spinning .ae-hint,.ae-spinning .ae-card,.ae-spinning .ae-orient,.ae-spinning .ae-status,.ae-spinning #ae-maprow{display:none!important}',
  '.ae-sp{position:absolute;box-sizing:border-box;pointer-events:auto;display:flex;flex-direction:column;justify-content:flex-start;align-items:center;gap:1px;padding:0 2px;margin:0;border:0;background:none;font:inherit;color:#dfe6f0;text-align:center;cursor:pointer;border-radius:10px;overflow:hidden}',
  '.ae-sp b{font-size:13px;font-weight:600;color:#f1f4f9;line-height:1.3}',
  '.ae-sp span{font-size:10.5px;line-height:1.25;color:rgba(223,230,240,.72)}',
  '.ae-sp .ae-sp-back{color:' + AE_AMBER_HEX + '}',
  '.ae-sp:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '.night-red .ae-sp,.night-red .ae-sp b,.night-red .ae-sp span{color:var(--text)}',
  // Full screen: the planets and their short names, nothing else but the two small tools in the corner. The Fullscreen API
  // where the browser has it; this covering the viewport where it does not (an iPhone), inside its safe areas (_aeSpinRoom).
  '.ae-spin-full{position:fixed;inset:0;z-index:10000}',
  '.ae-spin-full>*:not(.ae-canvas):not(.ae-spin):not(.ae-fullbar):not(.ae-safe){display:none!important}',
  'html.ae-full-on .topbar{display:none!important}',   // the page's own bar stands above any covering view
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
  '.ae-lm{position:absolute;left:0;top:0;margin:0;padding:6px 8px 6px 18px;border:0;background:none;font:inherit;font-size:11px;color:#dfe6f0;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 4px #000;pointer-events:auto;cursor:pointer}',
  '.ae-lm::before{content:"";position:absolute;left:6px;top:50%;width:6px;height:6px;border-radius:50%;background:currentColor;transform:translateY(-50%);box-shadow:0 0 3px #000}',
  '.ae-lm.ae-lm-left{padding:6px 18px 6px 8px}.ae-lm.ae-lm-left::before{left:auto;right:6px}',
  '.ae-lm:focus-visible{outline:2px solid var(--amber);outline-offset:-2px;border-radius:6px}',
  '.ae-lm[hidden]{display:none}',
  '.ae-lm-landing{color:' + AE_AMBER_HEX + '}',
  '.night-red .ae-lm,.night-red .ae-lm-landing{color:var(--text)}',
  '.ae-card .ae-lm-line{display:flex;align-items:center;justify-content:space-between;gap:10px}',
  '.ae-card .ae-lm-fly{flex:none;min-height:28px;padding:5px 12px;font-size:12px}',
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
  '.ae-label-shadow{color:#ffb4a0}',
  // Red night light (the Red theme, app.css): the labels' warm and cool tints are one red, the views' bright
  // overlays go black, and the globe is recoloured by the canvas filter.
  '.night-red .ae-label,.night-red .ae-label-you,.night-red .ae-label-shadow,.night-red .ae-status{color:var(--text)}',
  '.night-red .ae-btn,.night-red .ae-set,.night-red .ae-card{background:' + AE_PANEL_BG_RED + '}',
  '.night-red .ae-btn[aria-pressed="true"]{background:var(--amber-glow)}',
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
  '.ae-card h3{margin:0 0 4px;font-size:14px;font-weight:600;color:var(--text)}',
  '.ae-card p{margin:0}',
  '.ae-card p+p{margin-top:2px}',
  // A third of an upright phone at most: the card is read in a glance, the view stays the picture.
  '.ae-card{max-height:25vh;overflow-y:auto;overscroll-behavior:contain}',
  // The clock at the foot: the shared one (almanac.js _almClockHtml), on the view's dark. A card open on a phone sends it
  // away (it comes back with the card's ×), so card and chips leave the view most of the screen.
  '.ae-clock{width:100%;max-width:560px;pointer-events:auto}',
  '@media (max-width:500px){.ae-view.ae-carded .ae-clock{display:none}}',
  '.ae-card .ae-card-note{color:var(--amber)}',
  // A body's facts: a sheet up from the foot on a phone, a panel down the right on a wide screen (the gear's panel and
  // the card stand in the same solid colour). Hidden by its transform and visibility, so it can slide.
  '.ae-info{position:absolute;z-index:4;inset-inline:0;bottom:0;max-height:min(62%,520px);box-sizing:border-box;display:flex;flex-direction:column;background:' + AE_PANEL_BG + ';border:1px solid var(--border);border-bottom:0;border-radius:16px 16px 0 0;color:var(--text2);font-size:13px;line-height:1.45;transform:translateY(105%);visibility:hidden;transition:transform .25s ease,visibility 0s .25s;touch-action:pan-y;-webkit-user-select:text;user-select:text}',
  '.ae-info.in{transform:none;visibility:visible;transition:transform .25s ease}',
  '@media (prefers-reduced-motion:reduce){.ae-info,.ae-info.in{transition:none}}',
  '.ae-info-grab{flex:none;width:36px;height:4px;margin:8px auto 0;border-radius:2px;background:var(--border)}',
  '@media (min-width:760px){.ae-info-grab{display:none}}',
  '.ae-info-body{overflow-y:auto;overscroll-behavior:contain;padding:16px 18px calc(18px + env(safe-area-inset-bottom,0px))}',
  '.ae-info h2{margin:0 36px 10px 0;font-size:17px;font-weight:600;color:var(--text)}',
  '[dir="rtl"] .ae-info h2{margin:0 0 10px 36px}',
  '.ae-info-dl{margin:0;display:block}',
  '.ae-info-row{display:grid;grid-template-columns:minmax(96px,36%) 1fr;gap:4px 14px;padding:7px 0;border-top:1px solid var(--border)}',
  '.ae-info-row dt{color:var(--text3);font-size:12px;padding-top:1px}',
  '.ae-info-row dd{margin:0;color:var(--text);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  '.ae-info-row dd span{display:block;color:var(--text2);font-size:12px}',
  '.ae-info-read{margin:12px 0 0;font-size:13px}',
  '.ae-info-blurb{margin:-4px 0 10px;font-size:14px;line-height:1.45;color:var(--text2)}',
  '.ae-info-now{margin:0 0 8px;font-size:13px;color:var(--text3)}',
  '.ae-info-now+.ae-info-read{margin:0 0 10px}',
  '.ae-info-read a[data-ae-open]{color:var(--amber);text-decoration:none}',
  '.ae-same{font-size:18px;font-weight:600;line-height:1}',
  '.ae-info .alm-link{color:var(--amber);text-decoration:none;cursor:pointer}',
  '.ae-info .alm-link:hover,.ae-info .alm-link:focus-visible{text-decoration:underline}',
  '@media (min-width:760px){.ae-info{inset-inline:auto 0;top:140px;bottom:0;width:380px;max-height:none;border-radius:12px 0 0 0;border-inline-end:0;transform:translateX(105%)}[dir="rtl"] .ae-info{transform:translateX(-105%);border-radius:0 12px 0 0}.ae-info.in,[dir="rtl"] .ae-info.in{transform:none}}',
  '.night-red .ae-info{background:' + AE_PANEL_BG_RED + '}',
  '.ae-card .ae-card-more,.ae-card .ae-lm-dark{margin-top:6px;font-size:12px}',
  '.ae-card .ae-lm-dark a,.ae-card .ae-card-more a{color:var(--amber);text-decoration:none}',
  '.ae-card .ae-lm-dark a:hover,.ae-card .ae-lm-dark a:focus-visible{text-decoration:underline}',
  '@media (max-width:420px){.ae-card{padding:9px 36px 9px 12px;font-size:12.5px;line-height:1.4}.ae-card h3{font-size:13.5px;margin-bottom:2px}}',
  '.ae-place-preview{display:flex;gap:10px;align-items:flex-start;margin-top:6px;color:inherit;text-decoration:none}',
  '.ae-card h3 .ae-place-open{color:var(--amber);text-decoration:none}',
  '.ae-card .ae-place-open:hover,.ae-card .ae-place-open:focus-visible{text-decoration:underline}',
  '.ae-place-preview img{flex:0 0 auto;width:56px;height:56px;object-fit:cover;border-radius:8px;background:var(--surface2)}',
  '.ae-place-preview b{display:block;color:var(--text);font-weight:600}',
  '.ae-place-snip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
  '.ae-counter{color:var(--amber);font-variant-numeric:tabular-nums}',
  '.ae-card-x{position:absolute;top:4px;right:4px;width:36px;height:36px;border:0;background:none;color:var(--text3);font-size:20px;line-height:1;cursor:pointer;border-radius:8px}',
  '.ae-card-x:hover,.ae-card-x:focus-visible{color:var(--amber);outline:none}',
  '[dir="rtl"] .ae-card{padding:12px 14px 12px 40px}',
  '[dir="rtl"] .ae-card-x{right:auto;left:4px}',
  '.ae-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--text2);font-size:14px;pointer-events:none}',
  '.ae-msg[hidden]{display:none}',
  '.ae-view.ae-blank .ae-bottom,.ae-view.ae-blank .ae-status{display:none}',
  '.ae-hint{position:absolute;left:50%;bottom:calc(100% - 18px);transform:translateX(-50%);box-sizing:border-box;width:max-content;max-width:calc(100% - 32px);padding:8px 14px;border-radius:16px;background:rgba(0,0,0,.86);color:var(--text2);font-size:12px;line-height:1.4;text-align:center;pointer-events:none;opacity:0;transition:opacity .6s}',
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

// ── Go to ──
// Every place the view can fly to, in groups: Earth and Moon, the planets, their big moons, the dwarf planets, the
// spacecraft (once their table has come: opening the sheet asks for it). A row is the body's small disc and its name;
// a tap flies there and puts the sheet away.
var AE_GO_PROBE_COLOR = AE_PROBE_HEX;
var AE_GO_LM = 'lm:';   // a landing site's row: lm:<body>:<its index in that body's landmarks>
// The landing site a Go to row stands for ({ body, row }), once the landmarks are in.
function _aeGoLmRow(key) {
  if (!_aeLm || key.indexOf(AE_GO_LM) !== 0) return null;
  var at = key.split(':'), rows = _aeLm[at[1]], row = rows && rows[+at[2]];
  return row ? { body: at[1], row: row } : null;
}
// A compass: Go to sits in the row as one round button, so the row stays one line on a phone.
var AE_GO_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9.5"/><path d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z" fill="currentColor" stroke-width="1.4"/></svg>';
function _aeGoDot(key) {
  if (_aeGoLmRow(key)) return '<i class="ae-go-dot ae-go-probe" style="background:' + AE_AMBER_HEX + ';color:' + AE_AMBER_HEX + '"></i>';
  if (key === 'iss') return '<i class="ae-go-dot ae-go-probe" style="background:rgb(255,209,89);color:rgb(255,209,89)"></i>';
  if (key === AE_SPIN_KEY) return '<i class="ae-go-dot" style="background:var(--amber)"></i>';
  if (_aeIsProbe(key)) return '<i class="ae-go-dot ae-go-probe" style="background:' + AE_GO_PROBE_COLOR + '"></i>';
  var b = _aePlanetBody(key), hex = null, rgb = b ? b.color : key === 'moon' ? [0.78, 0.78, 0.78] : [0.29, 0.56, 0.85];
  if (b && !b.parent && typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]) hex = _PLANETS[b.eph].color;
  if (key === 'earth' && typeof _PLANETS !== 'undefined') hex = _PLANETS.Earth.color;
  var c = hex || 'rgb(' + rgb.map(function (v) { return Math.round(v * 255); }).join(',') + ')';
  return '<i class="ae-go-dot" style="background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.5),' + c + ' 45%,rgba(0,0,0,.55) 100%),' + c + '"></i>';
}
var AE_GO_LOADING = '…';   // a group's place while its table loads (never a body's key)
function _aeGoGroups() {
  var planets = [AE_SPIN_KEY].concat(AE_PLANETS.filter(function (b) { return !b.parent && !b.track; }).map(function (b) { return b.key; }));
  var moons = AE_PLANETS.filter(function (b) { return b.parent; }).map(function (b) { return b.key; });
  var dwarfs = AE_PLANETS.filter(function (b) { return b.track; }).map(function (b) { return b.key; });
  // The spacecraft flying on the shown date: one whose table ends (Cassini into Saturn, Galileo into Jupiter) or has
  // not begun is not a place to go then.
  var jd = (_ae.scene ? _ae.scene.ms : Date.now()) / MS_PER_DAY + JD_UNIX_EPOCH;
  var craft = (_ae.issPos ? ['iss'] : []).concat(_aeTracks ? _aeTracks.probes.filter(function (k) { return !!_aeTrackAt(_aeTracks.tracks[k], jd); }) : []);
  // Every landing site by name (the Moon's first, then Mars's, Venus's and Titan's): flown to, each shows its own label
  // and card whether or not Landmarks is on.
  var landings = [];
  if (_aeLm) _aeLmBodyKeys().forEach(function (k) {
    _aeLm[k].forEach(function (r, i) { if (r[3] === 'landing') landings.push(AE_GO_LM + k + ':' + i); });
  });
  // A group whose table is still on its way shows where it will be, quietly, rather than being missing until it lands.
  if (!_aeTracks && _aeTracksLoading) craft.push(AE_GO_LOADING);
  if (!_aeLm && _aeLmLoading) landings.push(AE_GO_LOADING);
  return [['alm_go_earth_moon', ['earth', 'moon']], ['alm_go_planets', planets], ['alm_go_moons', moons], ['alm_go_dwarfs', dwarfs], ['alm_go_craft', craft], ['alm_go_landings', landings]]
    .filter(function (g) { return g[1].length; });
}
function _aeGoName(key) {
  var lmRow = _aeGoLmRow(key);
  if (lmRow) return lmRow.row[0];
  if (key === 'earth') return _tp('Earth');
  if (key === AE_SPIN_KEY) return _aeT('alm_spin_view');
  if (key === 'iss') return _aeT('alm_earth_iss_short');
  if (key === 'moon') return _aeT('alm_moon');
  if (_aeIsProbe(key)) return _aeTracks.tracks[key].name;
  var b = _aePlanetBody(key);
  return b ? _aeBodyName(b) : key;
}
function _aeGoRender() {
  var sheet = _aeById('ae-go'), host = _aeById('ae-go-groups');
  if (!sheet || sheet.hidden || !host) return;
  host.innerHTML = _aeGoGroups().map(function (g) {
    return '<h4 data-g="' + g[0] + '">' + _almEsc(_aeT(g[0])) + '</h4><div class="ae-go-list">' + g[1].map(function (k) {
      if (k === AE_GO_LOADING) return '<span class="ae-go-wait" role="status">' + _almEsc(_aeT('loading')) + '</span>';
      return '<button type="button" class="ae-go-row" data-ae-go="' + k + '" aria-current="' + (k === _ae.target) + '">' + _aeGoDot(k) +
        '<span>' + _almEsc(_aeGoName(k)) + '</span></button>';
    }).join('') + '</div>';
  }).join('');
  // Opened at a group whose table was still coming (Landings on a first tap): scrolled there once it is drawn.
  var h = _ae.goGroup ? sheet.querySelector('h4[data-g="' + _ae.goGroup + '"]') : null;
  if (h) { sheet.scrollTop = h.offsetTop; _ae.goGroup = null; }
}
// `group`: open scrolled to that group's heading (the Moon's Landings chip), now or as soon as it is there.
function _aeShowGo(on, group) {
  var sheet = _aeById('ae-go'), btn = _aeById('ae-go-btn');
  if (!sheet) return;
  sheet.hidden = !on;
  if (btn) btn.setAttribute('aria-expanded', String(!!on));
  _ae.goGroup = on ? group || null : null;
  if (group === 'alm_go_landings' && on) _ae.allLandings = true;   // every landing site named on the Moon, not only Apollo's
  if (on) { _aeGoShell(sheet); _aeTracksLoad(); _aeLmLoad(); _aeGoRender(); }
}
var AE_SEARCH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/></svg>';
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
  ((_aeLm && _aeLm.earth) || []).forEach(function (r, i) {
    var m = _aePlaceMatch(typed, r[0]);
    if (m >= 0) out.push({ name: r[0], label: r[0], lat: r[1], lon: r[2], kind: 'landmark', qid: r[4], match: m, at: i });
  });
  return out;
}
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
    if (!out.some(function (q) { return _aePlaceNorm(q.name) === _aePlaceNorm(p.name) && _aePlaceKm(q, p) < AE_PLACE_ARTICLE_KM; })) out.push(p);
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
  _aePlaceShow(_aePlaceMerge(typed, _aePlaceLandmarks(typed), []));
  _ae.placeAbort = typeof AbortController === 'function' ? new AbortController() : null;
  _aeFetch(AE_PLACE_SUGGEST_URL + '?q=' + encodeURIComponent(typed) + '&limit=' + AE_PLACE_MAX, _ae.placeAbort ? { signal: _ae.placeAbort.signal } : undefined)
    .then(_aeJson).then(function (d) {
      if (seq !== _ae.placeSeq) return;
      _ae.placeTowns = (d.places || []).filter(function (p) { return _almValidLatLon(p.lat, p.lng); });
      _aePlaceRefresh();
    }).catch(function () {});
}
// What is found for what is in the field now, from the landmarks and the towns last offered (the landmarks' file may
// arrive after the first keys).
function _aePlaceRefresh() {
  var q = _aeById('ae-go-q'), typed = q ? q.value.trim() : '';
  if (typed) _aePlaceShow(_aePlaceMerge(typed, _aePlaceLandmarks(typed), _ae.placeTowns || []));
}
function _aePlaceShow(list) {
  _ae.placeFound = list;
  var box = _aeById('ae-go-found'), groups = _aeById('ae-go-groups'), q = _aeById('ae-go-q');
  if (!box) return;
  box.hidden = !list.length;
  box.innerHTML = list.map(function (p, i) {
    var dot = '<i class="ae-go-dot ae-go-probe' + (p.kind === 'landmark' ? '' : ' ae-go-town') + '"></i>';
    return '<button type="button" class="ae-go-row" data-ae-place="' + i + '">' + dot + '<span>' + _almEsc(p.label) + '</span></button>';
  }).join('');
  // The groups give way while something is typed.
  if (groups) groups.hidden = !!list.length || !!(q && q.value.trim());
}
// The sheet's two places (what was found; the groups) and the search field under them: made once, the groups drawn
// afresh by _aeGoRender without taking the field's focus.
function _aeGoShell(sheet) {
  if (_aeById('ae-go-q')) return;
  sheet.innerHTML = '<div class="ae-go-list ae-go-found" id="ae-go-found" hidden></div><div id="ae-go-groups"></div>' +
    '<div class="ae-go-find">' + AE_SEARCH_SVG + '<input type="search" id="ae-go-q" autocomplete="off" autocapitalize="off" ' +
    'spellcheck="false" enterkeyhint="go" placeholder="' + _almEsc(_aeT('search')) + '" aria-label="' + _almEsc(_aeT('search')) + '"></div>';
  var q = _aeById('ae-go-q'), timer = 0;
  q.oninput = function () {
    clearTimeout(timer);
    var typed = q.value.trim();
    // The landmarks show with the keystroke; the towns after a short pause.
    _ae.placeTowns = null;
    _aePlaceShow(_aePlaceMerge(typed, _aePlaceLandmarks(typed), []));
    timer = setTimeout(function () { _aePlaceSearch(typed); }, AE_PLACE_DELAY_MS);
  };
  q.onkeydown = function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (_ae.placeFound && _ae.placeFound.length) _aePlacePick(_ae.placeFound[0]);
  };
  // A phone's keyboard covers the foot of the screen: while the field has the focus, the foot stands above it.
  q.onfocus = function () {
    var foot = _ae.el.querySelector('.ae-bottom');
    if (foot && typeof _sheetAboveKeyboard === 'function' && !_ae.placeUnfit) _ae.placeUnfit = _sheetAboveKeyboard(foot);
  };
  q.onblur = function () {
    var foot = _ae.el.querySelector('.ae-bottom');
    if (_ae.placeUnfit) { _ae.placeUnfit(); _ae.placeUnfit = null; }
    if (foot) { foot.style.bottom = ''; foot.style.maxHeight = ''; }
  };
}
// A place picked: down over it, marked, its card up.
function _aePlacePick(p) {
  _aeShowGo(false);
  var sc = _ae.scene || _aeSceneAt(_aeDisplayMs());
  _ae.place = { name: p.name, label: p.label, lat: p.lat, lon: p.lon, kind: p.kind, qid: p.qid || null, article: null };
  _ae.lm = null; _ae.selected = null; _ae.arrived = null;
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
  _aeById('ae-card-x').onclick = function () { _ae.place = null; _aeRenderCard(); _ae.dirty = true; _aeKick(); };
  Array.prototype.forEach.call(card.querySelectorAll('[data-ae-place-open]'), function (open) {
    open.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(a); };
  });
}
// THE QUICK ROW: one rule, the same for every selection (Eric 2026-11-06). Left to right:
//   Sun  ·  the way down from the Sun to the body in view, ending on it  ·  its own satellites  ·  recents  ·
//   Planets  ·  Side by side  ·  Go to
// - Sun is always first and Earth is always one tap from it: at the Sun (and in the Planets view and Side by side,
//   which stand at the Sun) the way down is Earth.
// - The way down names each parent before the body, so the body never follows the Sun straight: the Moon is Sun, Earth,
//   Moon; Io is Sun, Jupiter, Io. Satellites are what circle the body (the Earth's Satellites chip, a planet's moons,
//   Io's sister moons) and what has landed on it (the Landings chip: the Moon, Mars, Venus). A probe's "satellite"
//   is the body it is near.
// - Recents are the last bodies left (two at most, newest first), kept as shortcuts back; one already on the row is
//   not repeated. Planets and Side by side are views, not bodies: they never become recents.
// - Side by side stands beside Planets wherever the planets are in view as a whole (the Sun, the Planets view, itself).
// - Past its width the row scrolls sideways; Go to stays at its end.
// Examples: Earth: Sun Earth Satellites Moon Planets. Moon: Sun Earth Moon Landings Planets. Mars (from the Moon): Sun
// Mars Landings Moon Planets. Io: Sun Jupiter Io Europa Ganymede Callisto Planets. Voyager 1: Sun Voyager1 (the body
// it is near) Planets. Sun: Sun Earth Planets Side-by-side.
var AE_ROW_LANDINGS = 'landings';
var AE_ROW_RECENTS = 2, AE_ROW_LONG = 4;   // places left behind kept as shortcuts; one only in the planets' views or beside a long family
// Where a target sits on the way out from the Sun ('sun' at the Sun): the ISS and the satellites are the Earth's.
function _aeRowBody() {
  var t = _ae && _ae.target;
  if (!t || t === 'earth' || t === 'iss') return 'earth';
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
function _aeRowPath(c) {
  var b = _aePlanetBody(c);
  if (c === 'earth') return ['earth', 'sats', 'moon'];
  if (c === 'moon') return ['earth', 'moon', AE_ROW_LANDINGS];
  if (AE_LM_LANDERS[c]) return [c, AE_ROW_LANDINGS];   // Mars and Venus: the sites landers have reached
  if (c === 'sun') return ['earth'];
  if (_aeIsProbe(c)) { var n = _aeRowNear(c); return n ? [c, _aeHostOf(n)] : [c]; }   // near Ganymede is at Jupiter
  var host = b && b.parent ? b.parent : c;
  var moons = AE_PLANETS.filter(function (m) { return m.parent === host; }).map(function (m) { return m.key; });
  return [host].concat(moons);   // a moon is among its planet's moons, in their order
}
function _aeRowKeys() {
  var spin = !!(_ae && _ae.spin), c = spin ? 'sun' : _aeRowBody();   // Side by side stands at the Sun
  if (_ae && !spin && c !== _ae.rowCurrent) {
    if (_ae.rowCurrent && _ae.rowCurrent !== 'sun') {
      _ae.rowRecents = [_ae.rowCurrent].concat((_ae.rowRecents || []).filter(function (k) { return k !== _ae.rowCurrent; }));
    }
    _ae.rowCurrent = c;
    if (c !== 'moon') _ae.allLandings = false;
    if (c === 'moon' || AE_LM_LANDERS[c]) _aeLmLoad();   // the Landings chip's table, there before it is tapped
  }
  var mid = _aeRowPath(c), on = mid.concat('sun', c), wide = spin || (_ae && _aeWideView());
  var room = wide || mid.length > AE_ROW_LONG ? 1 : AE_ROW_RECENTS;   // Planets (and Side by side) stay in view on a phone
  var recents = ((_ae && _ae.rowRecents) || []).filter(function (k) { return on.indexOf(k) < 0; }).slice(0, room);
  if (_ae) _ae.rowShortcuts = recents;
  recents.forEach(function (k) { mid.push(k); });
  if (spin) return ['sun', AE_SPIN_KEY];   // its tools take the room (Side by side again goes back to Planets)
  return ['sun'].concat(mid, ['planets'], wide ? [AE_SPIN_KEY] : []);
}
function _aeRowName(k) {
  if (k === 'sats') return _aeT('alm_earth_view_sats');
  if (k === 'sun') return _aeT('alm_sun');
  if (k === 'planets') return _aeT('alm_earth_view_planets');
  if (k === AE_SPIN_KEY) return _aeT('alm_spin_view');
  if (k === AE_ROW_LANDINGS) return _aeT('alm_row_landings');
  return _aeGoName(k);
}
function _aeRowHtml() {
  var keys = _aeRowKeys();
  if (_ae) _ae.rowKeys = keys.join(',');
  return keys.map(function (k) { return _aeChipHtml(k, _aeRowName(k), !!_ae && k === _ae.preset); }).join('');
}
function _aeRenderRow() {
  var chips = _aeById('ae-chips');
  if (!chips || _ae.rowKeys === _aeRowKeys().join(',')) return;
  chips.innerHTML = _aeRowHtml();
  chips.scrollLeft = 0;
  // Where the planets are in view as a whole, Planets and Side by side must not be scrolled out of sight: the
  // shortcuts (the oldest first) give way until the row fits.
  if (!_aeWideView() && !_ae.spin) return;
  (_ae.rowShortcuts || []).slice().reverse().forEach(function (k) {
    var b = chips.scrollWidth > chips.clientWidth + 1 ? chips.querySelector('[data-ae-view="' + k + '"]') : null;
    if (b) b.remove();
  });
}
function _aeChipHtml(key, name, on) {
  return '<button type="button" class="ae-btn" data-ae-view="' + key + '" aria-pressed="' + !!on + '">' + _almEsc(name) + '</button>';
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
    '<button type="button" class="ae-mini" id="ae-mini" hidden aria-label="' + _almEsc(_aeT('alm_earth_view_planets')) + '"><canvas id="ae-mini-c"></canvas></button>' +
    '<div class="ae-msg" id="ae-msg"></div>' +
    '<div class="ae-top">' +
      '<div class="ae-top-end">' +
        // The round tools stand in a column, so the date keeps its one line.
        '<div class="ae-tools">' +
          '<button type="button" class="ae-btn ae-round ae-gear" id="ae-gear" aria-expanded="false" aria-controls="ae-set"' +
            ' aria-label="' + _almEsc(gearLabel) + '" title="' + _almEsc(gearLabel) + '">' +
            (typeof _gearSvg === 'string' ? _gearSvg : '⚙') + '</button>' +
          '<button type="button" class="ae-btn ae-round" id="ae-locate" aria-pressed="false"' +
            ' aria-label="' + _almEsc(locateLabel) + '" title="' + _almEsc(locateLabel) + '">' + AE_LOCATE_SVG + '</button>' +
          // Where the view has flown to, everything about it waits behind this: the picture stays clear.
          '<button type="button" class="ae-btn ae-round" id="ae-info-btn" hidden aria-haspopup="dialog" aria-expanded="false"' +
            ' aria-label="' + _almEsc(_aeT('alm_bi_more')) + '" title="' + _almEsc(_aeT('alm_bi_more')) + '">' + AE_INFO_SVG + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    // The gear's sheet: the view's own switches and the satellite setting (drawn afresh), then the data's date and,
    // for an admin under Ask first with stale data, Get fresh data.
    '<div class="ae-set" id="ae-set" role="group" aria-labelledby="ae-set-title" hidden><div id="ae-set-body"></div>' +
      '<p class="ae-set-data" id="ae-ask" hidden><span id="ae-ask-text"></span><span id="ae-fresh-sep" aria-hidden="true"> · </span>' +
      '<button type="button" class="ae-fresh" id="ae-fresh"></button></p></div>' +
    '<div class="ae-info" id="ae-info" role="dialog" aria-labelledby="ae-info-title"></div>' +
    '<div class="ae-status" id="ae-status" aria-live="polite"></div>' +
    '<div class="ae-bottom">' +
      '<div class="ae-hint" id="ae-hint"></div>' +
      '<div class="ae-card" id="ae-card" hidden></div>' +
      '<div class="ae-orient" id="ae-orient" hidden>' + _almEsc(_aeT('alm_moon_north_up')) + '</div>' +
      '<div class="ae-orient" id="ae-sunnote" hidden></div>' +
      '<div class="ae-orient" id="ae-scale" hidden>' + _almEsc(_aeT('alm_earth_not_to_scale')) + '</div>' +
      '<div class="ae-row" id="ae-maprow" hidden><button type="button" class="ae-btn" id="ae-map">' +
        (typeof _MAPS_SVG === 'string' ? _MAPS_SVG.replace('width="26" height="26"', 'width="16" height="16"') + ' ' : '') +
        _almEsc(_aeT('alm_earth_map_here')) + '</button></div>' +
      // Outward from home: the Earth, its satellites, the Moon, the Sun, the whole system; everywhere else is Go to.
      '<div class="ae-go" id="ae-go" role="dialog" aria-label="' + _almEsc(_aeT('alm_go_to')) + '" hidden></div>' +
      '<div class="ae-row" role="group" id="ae-views">' +
        '<div class="ae-chips" id="ae-chips">' + _aeRowHtml() + '</div>' +
        // Side by side's own tools stand in the row, where Earth and Planets were.
        '<span class="ae-spintools" id="ae-spinrow" hidden><button type="button" class="ae-btn ae-round ae-same" id="ae-spin-same" aria-pressed="false" aria-label="' + _almEsc(_aeT('alm_spin_same')) + '" title="' + _almEsc(_aeT('alm_spin_same')) + '">=</button>' + _aeSpinToolsHtml(true) + '</span>' +
        '<button type="button" class="ae-btn ae-round" id="ae-go-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="' +
          _almEsc(_aeT('alm_go_to')) + '" title="' + _almEsc(_aeT('alm_go_to')) + '">' + AE_GO_SVG + '</button>' +
      '</div>' +
      '<div class="ae-clock" id="ae-clock">' + _almClockHtml('foot') + '</div>' +
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
  return fetch(url).then(function (r) { if (!r.ok) throw new Error(url); return r.blob(); }).then(function (blob) {
    // Flipped as it is decoded: WebGL's flipY does not apply to an ImageBitmap.
    return createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }).then(function (bmp) {
    var Tex = _aeTextureClass(THREE), tx = new Tex(bmp);
    tx.flipY = false;
    tx.needsUpdate = true;
    return tx;
  }).catch(viaLoader);
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
  '  float prom = smoothstep(0.78, 0.92, h) * (1.0 - smoothstep(1.0, 1.0 + 0.05 * h + 1e-4, r)) * smoothstep(1.0, 1.006, r);',
  '  vec3 col = vec3(1.0, 0.72, 0.42) * bloom + vec3(1.0, 0.95, 0.9) * corona + vec3(1.0, 0.38, 0.45) * prom * 0.6;',
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
// The catalogue as the 3D views read it (count and at(i, out)), from the sky's one
// decoder and request (almanac-skygl.js _sgLoadStars); rejects if it is not there.
function _aeFetchStars() {
  return _sgLoadStars().then(_sgStarList);
}
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
    moonPos: { value: new THREE.Vector3() }, moonR: { value: AE_MOON_RADIUS_RE },
    dim: { value: 1 }
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
  var S0 = { THREE: THREE, scene: scene, pv: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] };
  _aeBuildPlanets(S0);

  return {
    THREE: THREE, renderer: renderer, scene: scene, camera: camera, dpr: dpr,
    earth: earth, earthUni: earthUni, moon: moon, moonUni: moonUni, shared: shared,
    sky: sky, starCloud: starCloud, starsLoaded: false, starsLoading: false, sun: sun, sunGlowUni: sunGlowUni, sunT: sunT, sunSpots: sunSpots, spotsAt: null, moonPath: moonPath, moonPathCount: moonPathCount,
    gpsRings: gpsRings, issRing: issRing, sats: sats,
    basis: new THREE.Matrix4(), vx: new THREE.Vector3(), vy: new THREE.Vector3(), vz: new THREE.Vector3(), planets: S0.planets, pv: S0.pv,
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
      if (ok && _ae.ready) _aeWarmSliced(S);
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
var AE_HD_TILE_PX = 512;
var AE_HD_SPLIT = 1.0;           // a tile gives way to its four once it covers more device pixels than it has
var AE_HD_GPU_TILES = 120;       // textures kept on the GPU (day ~1.4 MB with mipmaps, night and Moon a quarter), least recently used go first
var AE_HD_LOADS = 6;             // tiles fetched at once
var AE_HD_KEEP_LEVEL = 1;        // levels 0 and 1 (10 tiles a layer) stay: there is always something to draw
var AE_HD_MIN_BODY_PX = 40;      // a body smaller than this (radius, CSS px) keeps its one map and asks for no tile
var AE_HD_SEG_DEG = 2.8;         // a tile's mesh no coarser than the base sphere's (AE_EARTH_SEGMENTS)
var AE_HD_MIN_SEG = 8;
var AE_HD_SKIRT = 0.002;         // each tile's edges hang this far below the surface (of its radius): no crack shows where levels meet
var AE_HD_TILE_REACH = 0.75;     // a tile's angular radius, as a share of its side (half its diagonal, and a margin)
// With HD, the Earth's closest approach: its 610 m texels are then about two CSS pixels on a phone (three device
// pixels at 2x); nearer, the picture only blurs. The Moon's 670 m texels already reach that at its own closest
// approach (AE_MIN_DIST_MOON), so it keeps it: the Blue Marble and LRO mosaics, not the view, are the limit.
var AE_HD_MIN_ALT_KM = 400;
// A place on a body (latitude, longitude in degrees) as a unit vector in the body's own frame.
function _aeLatLonVec(lat, lon) { return _aeEqVec(_aeRad(lon), _aeRad(lat), 1); }

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
  fetch(_aeHdBase() + 'hd.json').then(function (r) { if (!r.ok) throw new Error('hd'); return r.json(); }).then(function (man) {
    if (_ae.gl !== S || !man || !man.layers) return;
    var bodies = _aeHdBodies(S).filter(function (b) {
      b.maps = b.maps.filter(function (m) { return man.layers[m.layer] || !m.optional; });
      return b.maps.every(function (m) { return man.layers[m.layer]; });
    });
    if (!bodies.length) return;
    S.hd = { man: man, bodies: bodies, queue: [], loading: 0, gpu: 0, frame: 0 };
    bodies.forEach(function (b) {
      b.max = man.layers[b.maps[0].layer].max;
      b.maps.forEach(function (m) {
        m.max = man.layers[m.layer].max;
        // Inserts: tiles past the layer's max, only round some places (the Apollo sites), by level.
        m.ins = {};
        (man.layers[m.layer].inserts || []).forEach(function (e) { (m.ins[e.z] = m.ins[e.z] || []).push(e); });
      });
      b.nodes = {};
      b.drawn = [];
      b.frag = _aeHdFrag(b.relief && b.maps.some(function (m) { return m.uni === 'reliefMap'; }) ? _aeReliefFrag(b.frag) : b.frag, b.maps);
      AE_TARGETS[b.key].min = Math.min(AE_TARGETS[b.key].min, b.minDist);
    });
    _ae.dirty = true;
    _aeKick();
  }).catch(function () {});
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
function _aeHdKey(z, x, y) { return z + '/' + x + '/' + y; }
function _aeHdSpan(z) { return 180 / Math.pow(2, z); }
// A tile's box in the whole map's uv (u from longitude -180, v from latitude -90).
function _aeHdBox(z, x, y) {
  var w = 1 / Math.pow(2, z + 1), h = 1 / Math.pow(2, z);
  return [x * w, 1 - (y + 1) * h, w, h];
}
// One tile's patch of sphere, with the whole map's uv (the shader picks the tile's part), and a skirt round its edges.
function _aeHdGeometry(THREE, z, x, y, radius) {
  var span = _aeHdSpan(z), n = Math.max(AE_HD_MIN_SEG, Math.ceil(span / AE_HD_SEG_DEG));
  var lon0 = -180 + x * span, lat0 = 90 - y * span;
  var pos = [], nor = [], uv = [], idx = [];
  var vert = function (lat, lon, r) {
    var p = _aeLatLonVec(lat, lon);
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
  var min = _aeHdMinOver(b, _aeDeg(Math.asin(c.z / r)), _aeDeg(Math.atan2(c.y, c.x)));
  AE_TARGETS[b.key].min = min;
  if (_ae.dist < min) { _ae.dist = min; _ae.dirty = true; }
}
// How near the camera may come over a place: the closest at which the deepest tile there is still two or three device
// pixels a texel, or the body's own limit where there is no insert.
var AE_HD_TEXEL_PX = 2.5, AE_HD_INSERT_MIN_ALT_KM = 0.5;
function _aeHdMinOver(b, lat, lon) {
  var m = b.maps[0], deepest = -1;
  for (var z in m.ins) {
    var span = 180 / Math.pow(2, +z), x = Math.floor((lon + 180) / span), y = Math.floor((90 - lat) / span);
    if (+z > deepest && _aeHdInInsert(m, +z, x, y)) deepest = +z;
  }
  if (deepest < 0) return b.minDist;
  var texelKm = _aeRad(180 / Math.pow(2, deepest) / AE_HD_TILE_PX) * b.radius * AE_EARTH_RADIUS_KM;
  var cam = _ae.gl.camera, hPx = _ae.h * _ae.gl.dpr;
  var altKm = Math.max(AE_HD_INSERT_MIN_ALT_KM, texelKm * hPx / (AE_HD_TEXEL_PX * _aeRad(cam.fov)));
  return Math.min(b.minDist, b.radius + altKm / AE_EARTH_RADIUS_KM);
}
function _aeHdTileUrl(m, n) { return _aeHdBase() + m.layer + '/' + n.z + '/' + n.x + '/' + n.y + '.webp'; }
function _aeHdReady(b, n) {
  return b.maps.every(function (m) { var t = _aeHdLayerNode(b, n, m).tex[m.layer]; return t && t.isTexture; });
}
function _aeHdWant(S, b, n, pri) {
  b.maps.forEach(function (m) {
    var ln = _aeHdLayerNode(b, n, m);
    if (ln.tex[m.layer] === undefined) { ln.tex[m.layer] = 'queued'; S.hd.queue.push({ b: b, n: ln, m: m, pri: pri }); }
    else if (ln.tex[m.layer] === 'queued') S.hd.queue.forEach(function (q) { if (q.n === ln && q.m === m) q.pri = Math.min(q.pri, pri); });
  });
}
function _aeHdPump(S) {
  var hd = S.hd;
  hd.queue.sort(function (a, b) { return a.pri - b.pri; });
  while (hd.loading < AE_HD_LOADS && hd.queue.length) {
    var q = hd.queue.shift();
    hd.loading++;
    (function (q) {
      _aeLoadTexture(S.THREE, _aeHdTileUrl(q.m, q.n)).then(function (tx) {
        if (_ae.gl !== S) { tx.dispose(); return; }
        tx.anisotropy = S.aniso;
        if (q.m.red) tx.format = AE_THREE_RED_FORMAT;   // one channel on the GPU: a quarter of the memory
        q.n.tex[q.m.layer] = tx;
        hd.gpu++;
      }, function () { q.n.tex[q.m.layer] = 'failed'; }).then(function () {
        hd.loading--;
        if (_ae.gl !== S) return;
        _ae.dirty = true;
        _aeKick();
      });
    })(q);
  }
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
  n.mesh = new S.THREE.Mesh(_aeHdGeometry(S.THREE, n.z, n.x, n.y, b.radius),
    new S.THREE.ShaderMaterial({ uniforms: uniforms, vertexShader: AE_SPHERE_VERT, fragmentShader: b.frag }));
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
function _aeHdSelect(S, b) {
  var cam = S.camera, inv = new S.THREE.Matrix4().copy(b.parent.matrixWorld).invert();
  var P = cam.position.clone().applyMatrix4(inv);
  var fwd = cam.position.clone().add(cam.getWorldDirection(new S.THREE.Vector3())).applyMatrix4(inv).sub(P).normalize();
  var p = [P.x / b.radius, P.y / b.radius, P.z / b.radius], d = _aeLen(p);
  var horizon = d > 1 ? Math.acos(Math.min(1, 1 / d)) : Math.PI;
  var focal = _aeFocalPx() * S.dpr;
  var halfDiag = Math.atan(Math.tan(_aeRad(cam.fov) / 2) * Math.sqrt(1 + cam.aspect * cam.aspect));
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
// In use this frame: the node, and the tiles of its other layers it reads (an ancestor's, past their deepest level).
function _aeHdTouch(b, n, frame) {
  b.maps.forEach(function (m) { _aeHdLayerNode(b, n, m).used = frame; });
}
function _aeHdUpdate(S) {
  var hd = S.hd;
  hd.frame++;
  var cam = S.camera, eye = [cam.position.x, cam.position.y, cam.position.z], pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  hd.bodies.forEach(function (b) {
    var e = b.parent.matrixWorld.elements, c = [e[12], e[13], e[14]];
    if (!b.parent.visible || b.radius / Math.max(1e-9, _aeLen(_aeSub(c, eye))) * pxPerRad < AE_HD_MIN_BODY_PX) {
      b.drawn.forEach(function (n) { if (n.mesh) n.mesh.visible = false; });
      b.drawn = [];
      b.parent.material.visible = true;
      return;
    }
    b.parent.updateMatrixWorld(true);
    // Levels 0 and 1 first, wanted always: the stand-ins for everything else.
    for (var z = 0; z <= AE_HD_KEEP_LEVEL; z++) {
      for (var y = 0; y < Math.pow(2, z); y++) for (var x = 0; x < Math.pow(2, z + 1); x++) _aeHdWant(S, b, _aeHdNode(b, z, x, y), z - 10);
    }
    var draw = {};
    _aeHdSelect(S, b).forEach(function (l) {
      var n = _aeHdNode(b, l.z, l.x, l.y);
      _aeHdWant(S, b, n, l.pri);
      _aeHdTouch(b, n, hd.frame);
      while (n && !_aeHdReady(b, n)) n = n.z ? _aeHdNode(b, n.z - 1, n.x >> 1, n.y >> 1) : null;
      if (n) draw[n.key] = n;
    });
    // An ancestor stood in for a tile: none of its descendants is drawn over it.
    var keys = Object.keys(draw);
    keys.forEach(function (k) {
      var n = draw[k];
      for (var zz = n.z - 1; zz >= 0; zz--) {
        var up = draw[_aeHdKey(zz, n.x >> (n.z - zz), n.y >> (n.z - zz))];
        if (up) { delete draw[k]; break; }
      }
    });
    b.drawn.forEach(function (n) { if (!draw[n.key] && n.mesh) n.mesh.visible = false; });
    b.drawn = [];
    for (var k in draw) {
      var n = draw[k];
      _aeHdMesh(S, b, n).visible = true;
      _aeHdTouch(b, n, hd.frame);
      b.drawn.push(n);
    }
    // The body's one map steps aside once its tiles cover it.
    b.parent.material.visible = !b.drawn.length;
    if (_ae.target === b.key && !_ae.fly) _aeHdKeepAbove(S, b);
  });
  _aeHdPump(S);
  _aeHdEvict(S);
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
function _aeShownDist(au) {
  if (typeof _solarSqueeze === 'function') return AE_SUN_SHOW_DIST * _solarSqueeze(au) / _solarSqueeze(1);
  return AE_SUN_SHOW_DIST * Math.pow(au, AE_PLANET_DIST_POW);
}
var AE_PLANETS_OUTER_AU = 30.5;        // Neptune's farthest: what the Planets overview fits
var AE_ORBIT_POINTS = 180, AE_ORBIT_REDRAW_DAYS = 30;
var AE_PLANET_ORBIT_COLOR = 0x9aa8c8, AE_PLANET_ORBIT_ALPHA = 0.32;
var AE_PLANET_SEGMENTS = [64, 32];
var AE_PLANET_MAP_MIN_PX = 3;          // a disc smaller than this (radius) is its mark; its map is asked for past it
var AE_PLANET_CREDIT_PX = 12;          // a map is credited once its disc shows it (a few pixels of Saturn is not Saturn's map)
var AE_PLANET_MIN_RADII = 1.3, AE_PLANET_FIT = 1.5;
var AE_RING_SEGMENTS = 160;
var AE_THREE_DOUBLE_SIDE = 2;          // three's DoubleSide, not exported by name by the tree-shaken build
// IAU WGCCRE 2015 poles and turning (J2000 equatorial; W0 at J2000 and Wd a day, degrees).
var AE_PLANETS = [
  { key: 'mercury', eph: 'Mercury', ccHd: true, km: 2439.7, map: 'mercury', color: [0.69, 0.63, 0.56], pole: [281.0103, 61.4155, 329.5988, 6.1385108] },
  { key: 'venus', eph: 'Venus', ccHd: true, km: 6051.8, map: 'venus', color: [0.91, 0.78, 0.48], atmo: [1, 0.82, 0.5], pole: [272.76, 67.16, 160.20, -1.4813688] },
  { key: 'mars', eph: 'Mars', km: 3396.2, flat: 0.00589, map: 'mars', color: [0.77, 0.38, 0.25], atmo: [0.9, 0.55, 0.4], pole: [317.269202, 54.432516, 176.049863, 350.891982443297] },
  { key: 'jupiter', eph: 'Jupiter', ccHd: true, km: 71492, flat: 0.06487, map: 'jupiter', color: [0.77, 0.6, 0.41], pole: [268.056595, 64.495303, 284.95, 870.536] },
  { key: 'saturn', eph: 'Saturn', ccHd: true, km: 60268, flat: 0.09796, map: 'saturn', color: [0.83, 0.72, 0.47], pole: [40.589, 83.537, 38.90, 810.7939024], rings: [74500, 140220], cc: true },
  { key: 'uranus', eph: 'Uranus', km: 25559, flat: 0.0229, map: 'uranus', color: [0.47, 0.78, 0.78], atmo: [0.5, 0.85, 0.9], pole: [257.311, -15.175, 203.81, -501.1600928], cc: true },
  { key: 'neptune', eph: 'Neptune', km: 24764, flat: 0.0171, map: 'neptune', color: [0.22, 0.41, 0.78], atmo: [0.3, 0.45, 1], pole: [299.36, 43.46, 249.978, 541.1397757], cc: true },
  // The dwarf planets the probes visited, from the Horizons table (space-tracks-v1.json) while it covers the date.
  { key: 'pluto', eph: 'Pluto', track: 'planets', km: 1188.3, map: 'pluto', color: [0.78, 0.72, 0.66], pole: [132.993, -6.163, 302.695, 56.3625225] },
  { key: 'ceres', eph: 'Ceres', track: 'tracks', trackKey: 'ceres', km: 469.7, color: [0.63, 0.6, 0.56], pole: [291.418, 66.764, 170.65, 952.1532] },
  // The big moons' mean circular orbits (scripts/fit_moon_orbits.py, against JPL Horizons 1990-2060): radius km,
  // longitude in the planet's equator at J2000 from the node of that equator on the ecliptic, degrees a day.
  { key: 'io', parent: 'jupiter', km: 1821.6, map: 'io', color: [0.91, 0.85, 0.44], orbit: [421769, 40.361, 203.488958] },
  { key: 'europa', parent: 'jupiter', km: 1560.8, map: 'europa', color: [0.85, 0.81, 0.75], orbit: [671090, 234.918, 101.374724] },
  { key: 'ganymede', parent: 'jupiter', km: 2634.1, map: 'ganymede', color: [0.66, 0.63, 0.58], orbit: [1070432, 242.196, 50.317608] },
  { key: 'callisto', parent: 'jupiter', km: 2410.3, map: 'callisto', color: [0.49, 0.45, 0.41], orbit: [1882794, 101.383, 21.571073] },
  { key: 'titan', parent: 'saturn', km: 2574.7, map: 'titan', color: [0.85, 0.65, 0.31], atmo: [1, 0.65, 0.2], orbit: [1222375, 327.598, 22.576976] }
];
// Saturn's rings outward from the planet (km): alpha and brightness. C ring faint, B bright, the Cassini Division
// nearly empty, the A ring between, the Encke gap near its edge.
var AE_RING_PROFILE = [
  [74500, 92000, 0.12, 0.55], [92000, 117500, 0.82, 0.95], [117500, 122200, 0.05, 0.6],
  [122200, 133300, 0.55, 0.85], [133300, 133700, 0.06, 0.6], [133700, 136800, 0.5, 0.8], [136800, 140220, 0.07, 0.6]
];
var AE_PLANET_FRAG = [
  'precision highp float;',
  'uniform sampler2D map; uniform float mapped; uniform vec3 color; uniform vec3 sunDir; uniform vec3 atmo; uniform float dim;',
  'uniform float rings; uniform vec3 ringN; uniform vec3 center; uniform vec2 ringR; uniform sampler2D ringMap;',
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  'void main() {',
  '  vec3 N = normalize(vNormal);',
  '  float ndl = dot(N, sunDir);',
  '  vec3 base = mapped > 0.5 ? texture2D(map, vUv).rgb : color;',
  '  float light = max(ndl, 0.0);',
  // The rings' shadow: the line from here toward the Sun crosses the ring plane inside the rings.
  '  if (rings > 0.5) {',
  '    float den = dot(sunDir, ringN);',
  '    float t = abs(den) > 1e-5 ? -dot(vWorld - center, ringN) / den : -1.0;',
  '    if (t > 0.0) {',
  '      float u = (length(vWorld + sunDir * t - center) - ringR.x) / (ringR.y - ringR.x);',
  '      if (u > 0.0 && u < 1.0) light *= 1.0 - 0.9 * texture2D(ringMap, vec2(u, 0.5)).a;',
  '    }',
  '  }',
  '  vec3 V = normalize(cameraPosition - vWorld);',
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
  'varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal;',
  'void main() {',
  '  float u = (length(vWorld - center) - ringR.x) / (ringR.y - ringR.x);',
  '  if (u < 0.0 || u > 1.0) discard;',
  '  vec4 p = texture2D(ringMap, vec2(u, 0.5));',
  '  vec3 toC = center - vWorld;',
  '  float b = dot(toC, sunDir);',
  '  float miss = sqrt(max(0.0, dot(toC, toC) - b * b));',
  '  float shade = (b > 0.0 && miss < radius) ? 0.08 : 1.0;',
  '  vec3 V = normalize(cameraPosition - vWorld);',
  '  float sameSide = step(0.0, dot(ringN, sunDir) * dot(ringN, V));',
  '  float lit = mix(0.35, 1.0, sameSide) * max(abs(dot(ringN, sunDir)), 0.12);',
  '  gl_FragColor = vec4(p.rgb * lit * 1.6 * shade * dim, p.a);',
  '}'
].join('\n');
function _aePlanetBody(key) { for (var i = 0; i < AE_PLANETS.length; i++) if (AE_PLANETS[i].key === key) return AE_PLANETS[i]; return null; }
function _aeIsPlanet(key) { return !!_aePlanetBody(key); }
function _aePlanetMapUrl(b) { return '/static/earth/' + b.map + '-v1.webp'; }
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
// A square of side 2 * half, in the xy plane, uv 0..1.
function _aeQuadGeometry(THREE, half) {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
function _aeBuildPlanets(S) {
  _aeKnowPlanets();
  var THREE = S.THREE;
  var ringMap = { value: null };   // drawn from AE_RING_PROFILE the first time Saturn is near enough to show
  S.planets = {};
  AE_PLANETS.forEach(function (b) {
    var geo = new THREE.SphereGeometry(b.r, AE_PLANET_SEGMENTS[0], AE_PLANET_SEGMENTS[1]);
    geo.rotateX(Math.PI / 2);
    var uni = {
      map: { value: null }, mapped: { value: 0 }, color: { value: b.color }, sunDir: { value: new THREE.Vector3(1, 0, 0) },
      atmo: { value: b.atmo || [0, 0, 0] }, dim: { value: 1 }, rings: { value: b.rings ? 1 : 0 }, ringN: { value: new THREE.Vector3(0, 0, 1) },
      center: { value: new THREE.Vector3() }, ringR: { value: [0, 1] }, ringMap: ringMap
    };
    var mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_PLANET_FRAG }));
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    S.scene.add(mesh);
    var p = { b: b, mesh: mesh, uni: uni, pos: [0, 0, 0], sun: [1, 0, 0], frame: null, asked: false };
    if (b.rings) {
      uni.ringR.value = [b.rings[0] / AE_EARTH_RADIUS_KM, b.rings[1] / AE_EARTH_RADIUS_KM];
      var ringUni = { ringMap: uni.ringMap, ringR: uni.ringR, sunDir: uni.sunDir, center: uni.center, radius: { value: b.r }, ringN: uni.ringN, dim: uni.dim };
      p.ring = new THREE.Mesh(_aeRingGeometry(THREE, b.rings[0] / b.km * b.r, b.rings[1] / b.km * b.r, AE_RING_SEGMENTS),
        new THREE.ShaderMaterial({ uniforms: ringUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_RING_FRAG, transparent: true, depthWrite: false, side: AE_THREE_DOUBLE_SIDE }));
      p.ring.matrixAutoUpdate = false;
      p.ring.visible = false;
      S.scene.add(p.ring);
    }
    if (!b.parent && typeof _PLANETS !== 'undefined' && _PLANETS[b.eph]) {
      p.orbit = _aeLine(THREE, THREE.LineLoop, AE_ORBIT_POINTS, AE_PLANET_ORBIT_COLOR, AE_PLANET_ORBIT_ALPHA);
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
}
// A planet's path round the Sun, as shown: a year of its own, redrawn when the shown date has moved a month.
function _aeWideView() { return _ae.preset === 'planets' || _ae.target === 'sun'; }
// Orbits, a setting in the gear (kept with the person): While flying (the default) shows the orbits of the
// bodies a flight involves (where it left, where it goes, and their systems) during it, fading out shortly after it
// lands; Always keeps those of the body in view and its system; Off shows none. The Planets view always shows the
// planets' orbits.
var AE_ORBITS_KEY = SK.ALM_ORBITS, AE_ORBITS_MODES = ['flying', 'always', 'off'], AE_ORBITS_FADE_MS = 1500;
// The orbit lines, the landmarks layer or the settings panel changed underneath the view (almanac.js
// _almPrefsApplied): drawn again from storage.
function _aePrefsApplied(keys) {
  if (keys.indexOf(AE_SPIN_FACES_KEY) >= 0 && _ae && _ae.spin) _aeSpinMarkFaces();
  if (keys.indexOf(AE_ORBITS_KEY) < 0 && keys.indexOf(AE_LM_LAYER_KEY) < 0) return;
  if (keys.indexOf(AE_LM_LAYER_KEY) >= 0 && _aeLmLayerOn()) _aeLmLoad();
  if (_ae) { _ae.dirty = true; _aeKick(); if (_ae.setOpen) _aeRenderSettings(); }
}
function _aeOrbitsMode() {
  try { var m = localStorage.getItem(AE_ORBITS_KEY); return AE_ORBITS_MODES.indexOf(m) >= 0 ? m : 'flying'; } catch (e) { return 'flying'; }
}
function _aeHostOf(k) { var b = _aePlanetBody(k); return b ? b.parent || b.key : k === 'moon' || k === 'iss' ? 'earth' : k; }
// How much of an orbit line shows now, 0..1, for every line the scene draws: `key` a planet (its path round the Sun),
// a moon (round its planet), a probe (its path and ellipse), or 'moon' for the Earth's own (the Moon's path, the GPS
// and station rings). Off is off everywhere, the Planets view too (the minimap keeps its own little rings).
function _aeOrbitShow(key) {
  var b = _aePlanetBody(key), mode = _aeOrbitsMode();
  // The Planets view is a map of the orbits: the planets' always show there, whatever the setting (Eric: Off hiding them
  // there "is dumb"); the moons' never (they are drawn on their planets). The setting governs the scene near a body.
  if (_aeWideView()) return b && !b.parent ? 1 : 0;
  if (mode === 'off') return 0;
  var host = _aeHostOf(key);
  var mine = function (k) { return !!k && (k === key || _aeHostOf(k) === host); };
  if (mode === 'always') return mine(_ae.target) ? 1 : 0;
  var o = _ae.orbitFly;
  if (!o || !(mine(o.from) || mine(o.to))) return 0;
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
  if (!wanted || (p.orbitAt != null && Math.abs(jd - p.orbitAt) < AE_ORBIT_REDRAW_DAYS) || !_aeMayRedraw()) return;
  p.orbitAt = jd;
  var arr = p.orbit.geometry.attributes.position.array;
  for (var k = 0; k < AE_ORBIT_POINTS; k++) {
    var q = around(_ephBodyJ2000(p.b.eph, jd + p.period * k / AE_ORBIT_POINTS));
    arr[k * 3] = q[0]; arr[k * 3 + 1] = q[1]; arr[k * 3 + 2] = q[2];
  }
  p.orbit.geometry.attributes.position.needsUpdate = true;
  p.orbit.geometry.setDrawRange(0, AE_ORBIT_POINTS);
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
  if (_aeIsPlanet(_ae.target) || _ae.target === 'sun' || _ae.dist > AE_AST_WIDE_DIST || _aeIsProbe(_ae.target)) _aeTracksLoad();

  var cam = S.camera, eye = [cam.position.x, cam.position.y, cam.position.z];
  var pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
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
    if (show && px >= AE_PLANET_MAP_MIN_PX && !p.asked) {
      p.asked = true;
      if (p.ring && !p.uni.ringMap.value) {
        _aeLoadTexture(S.THREE, _aeRingCanvas().toDataURL()).then(function (tx) { p.uni.ringMap.value = tx; _ae.dirty = true; _aeKick(); });
      }
      _aeLoadTexture(S.THREE, _aePlanetMapUrl(b)).then(function (tx) {
        if (_ae.gl !== S) { tx.dispose(); return; }
        tx.anisotropy = S.aniso;
        p.uni.map.value = tx;
        p.uni.mapped.value = 1;
        _ae.dirty = true;
        _aeKick();
      }, function () { p.asked = false; });
    }
  });
  _aeUpdateProbes(jd, placeNear, near);
}
// ── Planets side by side ──
// Mercury to Neptune in rows, each turning at its real sidereal rate (the IAU rotation AE_PLANETS places the maps by) for
// the shown date, which the time row runs: an hour a second shows Jupiter and the Earth spinning, Venus barely moving.
// Every planet stands in one frame, up the normal of its own orbit, so each tilt is drawn as it is to that orbit, leaning
// right: a thin line through the poles (the north end, by the right-hand rule of its turn, in amber with an arrowhead)
// and a ring in the plane of its orbit. Venus' and Uranus' spin vectors lie below that plane (177 and 98 degrees from its
// normal), their turn backwards; the sense of every turn is the one seen from the north ecliptic pole. Sizes are true
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
var AE_SPIN_LABEL_W = 84, AE_SPIN_LABEL_H = 88, AE_SPIN_GAP = 8;   // px: a cell's least width, the names' height under it, between cells
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
  return '<button type="button" class="ae-btn ae-round" data-ae-faces aria-pressed="false" aria-label="' + faces + '" title="' + faces + '">' + AE_FACES_SVG + '</button>' +
    '<button type="button" class="ae-btn ae-round" data-ae-full="' + (inRow ? 'enter' : 'exit') + '" aria-label="' + full + '" title="' + full + '">' + (inRow ? AE_FULL_SVG : AE_FULL_EXIT_SVG) + '</button>';
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
function _aeSpinLines(b, jd) {
  var f = _aeSpinFacts(b, jd), d = f.tiltDeg < 1 ? 2 : 1;
  var tilt = typeof fmtNum === 'function' ? fmtNum(f.tiltDeg, { minimumFractionDigits: d, maximumFractionDigits: d }) : f.tiltDeg.toFixed(d);
  var lines = [_aeT('alm_spin_day', { v: _aeSpinDuration(Math.abs(f.periodS)) })];
  if (_aeSpinOrbits()) lines.push(_aeT('alm_spin_year', { v: _aeSpinDuration(f.yearDays * SECONDS_PER_DAY) }));
  lines.push(_aeT('alm_spin_tilt', { v: tilt + '°' }));
  if (f.periodS < 0) lines.push(_aeT('alm_spin_retro'));
  return lines;
}
// The orbits shown by the gear's setting, here as the planets' orbital planes and years (While flying has no flight to
// show them in, so only Off hides them).
function _aeSpinOrbits() { return _aeOrbitsMode() !== 'off'; }
function _aeSpinSame() {
  try { var v = localStorage.getItem(AE_SPIN_SAME_KEY); if (v === '1' || v === '0') return v === '1'; } catch (e) {}
  return _ae.w < AE_SPIN_NARROW_PX || _aeFullOn();   // a phone's width cannot hold the true sizes: the small planets would be specks
}
function _aeSpinSetSame(on) {
  try { localStorage.setItem(AE_SPIN_SAME_KEY, on ? '1' : '0'); } catch (e) {}
  _aeSpinMarkSame();
  _ae.dirty = true;
  _aeKick();
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
  try { var v = localStorage.getItem(AE_SPIN_FACES_KEY); if (v === '1' || v === '0') return v === '1'; } catch (e) {}
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
  if (_ae) { _ae.dirty = true; _aeKick(); }
}
// A blink now and then, one planet at a time (not under reduced motion): a timer, not a frame loop, so the view stays idle between.
function _aeSpinBlinkStop() { var s = _ae && _ae.spin; if (s && s.blinkTimer) { clearTimeout(s.blinkTimer); s.blinkTimer = 0; } }
function _aeSpinBlink(c) {
  c.blinkUntil = performance.now() + AE_FACE_BLINK_MS;
  _ae.dirty = true; _aeKick();
  setTimeout(function () { if (_ae) { _ae.dirty = true; _aeKick(); } }, AE_FACE_BLINK_MS + 20);
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
    var uni = {
      map: { value: null }, mapped: { value: 0 }, color: { value: b.color }, sunDir: { value: sun }, atmo: { value: b.atmo || [0, 0, 0] },
      dim: { value: 1 }, rings: { value: b.rings ? 1 : 0 }, ringN: { value: new V(0, 0, 1) }, center: { value: new V() }, ringR: { value: [0, 1] }, ringMap: ringMap
    };
    var G = new THREE.Group(), lines = new THREE.Group();
    G.rotation.x = _aeRad(AE_SPIN_ELEV_DEG);
    var mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_PLANET_FRAG }));
    mesh.matrixAutoUpdate = false;
    G.add(mesh);
    var cell = { b: b, G: G, mesh: mesh, uni: uni, lines: lines, plane: _aeSpinSize(b, false).plane / b.km };
    if (b.rings) {
      var ringUni = { ringMap: ringMap, ringR: uni.ringR, sunDir: uni.sunDir, center: uni.center, radius: { value: 1 }, ringN: uni.ringN, dim: uni.dim };
      cell.ring = new THREE.Mesh(_aeRingGeometry(THREE, b.rings[0] / b.km, b.rings[1] / b.km, AE_RING_SEGMENTS),
        new THREE.ShaderMaterial({ uniforms: ringUni, vertexShader: AE_SPHERE_VERT, fragmentShader: AE_RING_FRAG, transparent: true, depthWrite: false, side: AE_THREE_DOUBLE_SIDE }));
      cell.ring.matrixAutoUpdate = false;
      cell.ring.renderOrder = AE_FACE_RING_ORDER;
      G.add(cell.ring);
    }
    // The face: its own silly one (open eyes, shut eyes), on a shell that turns with the planet; the rings cross it.
    cell.faceTex = [null, null];
    [false, true].forEach(function (blink, i) {
      _aeLoadTexture(THREE, _aeFaceCanvas(AE_FACE_LOOKS[key], blink).toDataURL()).then(function (tx) {
        if (_ae.gl !== S) { tx.dispose(); return; }
        tx.anisotropy = S.aniso;
        cell.faceTex[i] = tx; _ae.dirty = true; _aeKick();
      });
    });
    cell.faceUni = { map: { value: null }, tint: { value: 1 }, sunDir: uni.sunDir, lon: { value: 0 }, up: { value: b.pole[3] < 0 ? -1 : 1 } };   // up: toward the drawn north arrow (Venus and Uranus turn backwards)
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
      _ae.dirty = true; _aeKick();
    }, function () {});
  });
  _aeLoadTexture(THREE, _aeRingCanvas().toDataURL()).then(function (tx) {
    if (_ae.gl !== S) { tx.dispose(); return; }
    ringMap.value = tx; _ae.dirty = true; _aeKick();
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
function _aeSpinRoom() {
  if (_aeFullOn()) return _aeSpinFullRoom();
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
  var room = _aeSpinRoom(), same = _aeSpinSame(), orbits = _aeSpinOrbits();
  var full = _aeFullOn(), m = full ? AE_SPIN_FULL_METRICS : AE_SPIN_METRICS;
  var key = [room.x, room.y, room.w, room.h, same, orbits, full, _orrLang()].join('|');
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
    var l = fit.cells[i], b = c.b, name = _aeBodyName(b), lines = _aeSpinLines(b, jd);
    c.r = l.r;
    c.G.position.set(room.x + l.cx, _ae.h - (room.y + l.cy), 0);
    c.lines.scale.set(l.r, l.r, l.r);
    c.orbit.visible = orbits;
    c.axisDay = null;
    c.uni.center.value.copy(c.G.position);
    c.uni.ringR.value = b.rings ? [b.rings[0] / b.km * l.r, b.rings[1] / b.km * l.r] : [0, 1];
    html += '<button type="button" class="ae-sp" data-ae-spin="' + b.key + '" style="left:' + Math.round(room.x + l.left) + 'px;top:' + Math.round(room.y + l.top) +
      'px;width:' + Math.round(l.width) + 'px;height:' + Math.round(l.height) + 'px;padding-top:' + Math.round(l.height - m.labelH) + 'px" aria-label="' + _almEsc([name].concat(lines).join(', ')) + '"><b>' +
      _almEsc(name) + '</b>' + (full ? [] : lines).map(function (t, k) { return '<span' + (b.pole[3] < 0 && k === lines.length - 1 ? ' class="ae-sp-back"' : '') + '>' + _almEsc(t) + '</span>'; }).join('') + '</button>';
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
  if (c.axisDay !== g.day) { c.axisDay = g.day; _aeSpinSetAxis(c, g.axis); }
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
function _aeEnterSpin() {
  if (_ae.spin || !_ae.gl) return;
  _ae.spin = { autoRun: false, prevFocus: null };
  // From real time the clock starts at an hour a second, or nothing would seem to turn (not under reduced motion); leaving
  // puts the date back.
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
// Out of full screen by the person (the tool, Escape, the browser's own way out): ``history`` false when the back step has gone already.
function _aeFullExit(history) {
  if (!_aeFullOn()) return;
  _aeFullApply(false);
  if (document.fullscreenElement === _ae.el && document.exitFullscreen) { var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {}); }
  if (history !== false) _aeFullStepOut();
}
// The view leaving Side by side or closing: full screen undone without touching history (the caller does).
function _aeFullDrop() {
  if (!_aeFullOn()) return;
  _ae.spin.full = false;
  _ae.el.classList.remove('ae-spin-full');
  document.documentElement.classList.remove(AE_FULL_ROOT_CLASS);
  if (document.fullscreenElement === _ae.el && document.exitFullscreen) { var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {}); }
}
// The browser's own way out (its Escape) ends full screen here too. Listened for from the first entry, not at load.
var _aeFullHeard = false;
function _aeFullChanged() {
  if (!_ae || !_ae.spin) return;
  if (document.fullscreenElement === _ae.el) _ae.spin.api = true;
  else if (_ae.spin.api && _ae.spin.full) _aeFullExit();
}
function _aeLeaveSpin() {
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
var AE_SUN_POLE = [286.13, 63.87, 84.176, 14.1844];   // IAU WGCCRE 2015: RA, Dec of the pole, W0, degrees a day
// A body's north pole as a unit vector in the scene (the equator of date), or null where it has none. `sc`: _aeSceneAt.
function _aeAxisDir(key, sc) {
  var S = _ae.gl;
  if (key === 'earth') return [0, 0, 1];
  if (key === 'moon') return _aeNorm([S.vz.x, S.vz.y, S.vz.z]);
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
  var cam = S.camera, eye = [cam.position.x, cam.position.y, cam.position.z], pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  // `orbit`: whose orbit line the axis keeps company with (the Earth's own and the Moon's are one set: 'moon').
  var add = function (key, orbit, pos, r) {
    var show = pos ? _aeOrbitShow(orbit) : 0;
    if (show <= 0 || r / Math.max(1e-9, _aeLen(_aeSub(pos, eye))) * pxPerRad < AE_AXIS_MIN_PX) return;
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
function _aeSetAxisLines(o, a, eye) {
  var R = AE_SPIN_AXIS_R * a.r, tip = _aeAdd(a.pos, _aeScale(a.dir, R)), ang = _aeRad(AE_SPIN_BARB_DEG);
  var side = _aeCross(a.dir, _aeSub(eye, tip));
  side = _aeLen(side) > 1e-12 ? _aeNorm(side) : _aeNorm(_aeCross(a.dir, Math.abs(a.dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  var barb = function (sign) {
    return _aeAdd(tip, _aeScale(_aeAdd(_aeScale(a.dir, -Math.cos(ang)), _aeScale(side, sign * Math.sin(ang))), AE_SPIN_BARB * a.r));
  };
  var n = o.north.geometry.attributes.position, s = o.south.geometry.attributes.position;
  n.array.set([].concat(a.pos, tip, tip, barb(1), tip, barb(-1)));
  s.array.set([].concat(a.pos, _aeSub(a.pos, _aeScale(a.dir, R))));
  n.needsUpdate = true; s.needsUpdate = true;
  o.north.material.opacity = AE_SPIN_AXIS_ALPHA * a.show * _aeFadeU.value;
  o.south.material.opacity = AE_SPIN_AXIS_S_ALPHA * a.show * _aeFadeU.value;
}
function _aeDrawAxes(S, sc) {
  var shown = _aeAxisBodies(S, sc), cam = S.camera, eye = [cam.position.x, cam.position.y, cam.position.z], on = {};
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
var AE_AST_URL = '/static/earth/asteroids-v1.bin';
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
    if (_ae) { _ae.dirty = true; _aeKick(); }
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
var AE_TRACKS_URL = '/static/earth/space-tracks-v1.json';
// How far round a planet (AU) a probe is placed in that planet's own frame rather than by the drawn scale.
var AE_PROBE_REACH_AU = { earth: 0.05, mercury: 0.01, venus: 0.02, mars: 0.02, jupiter: 0.5, saturn: 0.4, uranus: 0.2, neptune: 0.3, pluto: 0.05 };
var AE_PROBE_COLOR = [0.43, 0.9, 0.85] /* AE_PROBE_HEX */, AE_PROBE_PX = 5, AE_PROBE_CAPACITY = 16;
var AE_PROBE_SURFACE = 0.02;          // a probe is a point: the camera circles it this far in, at most
var AE_PROBE_VIEW_DIST = 60;          // Earth radii: a flight to a probe ends this far from it
var AE_PROBE_VIEW_LIFT = 0.35;        // and looks at it from this far above its path (tan of the angle)
var AE_PROBE_FRAME_NEAR = 1.15, AE_PROBE_FRAME_MAX = 4000;   // a body this near the probe is framed with it, up to this far
var AE_TRAIL_POINTS = 240, AE_TRAIL_REDRAW_DAYS = 10, AE_TRAIL_ALPHA = 0.55, AE_TRAIL_FAINT = 0.12;
var _aeTracks = null, _aeTracksLoading = null, _aeProbePos = {}, _aeProbeHeading = {};
var AE_PROBE_HEADING_DAYS = 30;
function _aeTracksLoad() {
  if (_aeTracks || _aeTracksLoading || typeof fetch !== 'function') return;
  _aeTracksLoading = fetch(AE_TRACKS_URL).then(function (r) { if (!r.ok) throw new Error('tracks'); return r.json(); }).then(function (d) {
    _aeTracks = { tracks: d.tracks || {}, planets: d.planets || {}, probes: [] };
    _aeTracks.probes = Object.keys(_aeTracks.tracks).filter(function (k) { return k !== 'ceres'; });
    _aeTracks.probes.forEach(function (k) {
      AE_TARGETS[k] = { min: AE_PROBE_SURFACE * 2, max: AE_PROBE_FRAME_MAX, surface: AE_PROBE_SURFACE };
      var m = { body: k, name: function () { return _aeTracks.tracks[k].name; } };
      AE_MARKED.push(m);
      _aeAddMark(m);

    });
    if (_ae) { _ae.dirty = true; _aeKick(); }
    _aeGoRender();
    if (_ae && _ae.pendingPreset) { var go = _ae.pendingPreset; _ae.pendingPreset = null; _aePreset(go); }
  }).catch(function () { _aeTracksLoading = null; _aeGoRender(); });   // no loading row left behind a failed table
}
function _aeHermite(a, b, jd) {
  var h = b[0] - a[0], t = (jd - a[0]) / h, t2 = t * t, t3 = t2 * t;
  var h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2, out = [0, 0, 0];
  for (var k = 0; k < 3; k++) out[k] = h00 * a[1 + k] + h10 * h * a[4 + k] + h01 * b[1 + k] + h11 * h * b[4 + k];
  return out;
}
// A table's place at jd (TDB, near enough the view's UT for a probe), or null outside its years.
function _aeTrackAt(track, jd) {
  if (!track || jd < track.jd0 || jd > track.jd1) return null;
  var s = track.s, lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s[mid][0] <= jd) lo = mid; else hi = mid; }
  return _aeHermite(s[lo], s[hi], jd);
}
function _aeTracked(b, jd) {
  if (!_aeTracks) { _aeTracksLoad(); return null; }
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
function _aeKeplerAt(o, E) {
  return _aeAdd(_aeScale(o.p, o.a * (Math.cos(E) - o.e)), _aeScale(o.q, o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E)));
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
    var t = _aeTracks.tracks[k], h = _aeTrackAt(t, jd), trail = out.trails[k], ring = out.orbits[k];
    if (!trail) {
      trail = out.trails[k] = _aeLine(S.THREE, S.THREE.Line, AE_TRAIL_POINTS, 0xffffff, AE_TRAIL_ALPHA);
      trail.geometry.setAttribute('color', new S.THREE.BufferAttribute(new Float32Array(AE_TRAIL_POINTS * 4), 4));
      trail.material.vertexColors = true;
      S.scene.add(trail);
      ring = out.orbits[k] = _aeLine(S.THREE, S.THREE.LineLoop, AE_ORBIT_POINTS, 0x6ee7d8, AE_TRAIL_ALPHA);
      S.scene.add(ring);
    }
    if (!h) { trail.visible = ring.visible = false; return; }
    var pos = _aeProbePos[k] = place(h);
    var ahead = _aeTrackAt(t, jd + AE_PROBE_HEADING_DAYS);   // where it will be: its heading as drawn
    _aeProbeHeading[k] = ahead ? _aeSub(place(ahead), pos) : null;
    _aeSetPoint(out.cloud, n++, pos, AE_PROBE_COLOR, _aeProbeCraftDot(k), AE_PROBE_PX);
    // Only the path of the probe gone to: others' paths crossed the Planets view as stray lines, and near a body they
    // run past the camera. Not its own either once its model fills the view (the path runs through it).
    var line = _aeOrbitShow(k), shown = _ae.target === k && _aeProbeCraftDot(k) > 0.5 && line > 0;
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
      for (var i = 0; i < AE_TRAIL_POINTS; i++) {
        var f = i / (AE_TRAIL_POINTS - 1), q = place(_aeTrackAt(t, from + (jd - from) * f) || h);
        arr[i * 3] = q[0]; arr[i * 3 + 1] = q[1]; arr[i * 3 + 2] = q[2];
        col[i * 4] = AE_PROBE_COLOR[0]; col[i * 4 + 1] = AE_PROBE_COLOR[1]; col[i * 4 + 2] = AE_PROBE_COLOR[2];
        col[i * 4 + 3] = o ? f * f : 1;   // in orbit: fading out behind it
      }
      trail.geometry.attributes.position.needsUpdate = true;
      trail.geometry.attributes.color.needsUpdate = true;
      trail.geometry.setDrawRange(0, AE_TRAIL_POINTS);
      if (o && o.period) {
        // Round the body it circles as that body stands now.
        var hub = near.filter(function (c) { return c.key === o.round; })[0], centre = hub ? hub.h : [0, 0, 0];
        var ra = ring.geometry.attributes.position.array;
        for (var j = 0; j < AE_ORBIT_POINTS; j++) {
          var p = place(_aeAdd(centre, _aeKeplerAt(o, 2 * Math.PI * j / AE_ORBIT_POINTS)));
          ra[j * 3] = p[0]; ra[j * 3 + 1] = p[1]; ra[j * 3 + 2] = p[2];
        }
        ring.geometry.attributes.position.needsUpdate = true;
        ring.geometry.setDrawRange(0, AE_ORBIT_POINTS);
      }
    }
    trail.visible = shown;
    ring.visible = shown && !!(o && o.period);
  });
  _aeCommitPoints(out.cloud, n);
}
function _aeIsProbe(key) { return !!(_aeTracks && _aeTracks.tracks[key] && key !== 'ceres'); }
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
function _aeIssSunlightIn(ms) {
  var s = _ae.sats && _ae.sats.list.filter(function (x) { return x.iss; })[0], sc = _ae.scene;
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
  if (k === 'iss') {
    if (!_ae.issPos) return out;
    var r = _aeLen(_ae.issPos) * AE_EARTH_RADIUS_KM, period = 2 * Math.PI * Math.sqrt(r * r * r / AE_GM_EARTH_KM3_S2);
    out.fact = _aeT('alm_card_round_earth', { t: _orrFmtSpan(period) });
    out.where = _aeT('alm_card_up', { d: _aeKmText(r - AE_EARTH_RADIUS_KM) });
    if (sc && _aeInShadow(_ae.issPos, sc.sun)) {
      var back = _aeIssSunlightIn(ms);
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
  if (_aeIsProbe(k)) return 'probe:' + k;
  return 'planet:' + k;
}
// More to read from a card than its name: Voyager's record.
// More from a card than its name: Voyager's record opens the Almanac's own Golden Record (its pictures and sounds),
// the article only where that section is not here.
var AE_GOLDEN_RECORD = { key: 'ev:goldenrecord', label: 'alm_card_golden_record', open: '_scrollToGoldenRecord' };
var AE_ARRIVAL_EXTRA = { voyager1: AE_GOLDEN_RECORD, voyager2: AE_GOLDEN_RECORD };
function _aeArrivalName(k) {
  var b = _aePlanetBody(k);
  var name = _aeIsProbe(k) ? _aeTracks.tracks[k].name : k === 'iss' ? _aeT('alm_earth_iss_name') : k === 'sun' ? _aeT('alm_sun') :
    k === 'moon' ? _aeT('alm_moon') : b ? _aeBodyName(b) : k;
  return _aeLink(_aeArrivalKey(k), _almEsc(name));
}

// ── A body's facts ──
// "All facts" on a place's card opens its sheet (a bottom sheet on a phone, a side panel on a wide screen): size, mass,
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
  titan: { mass: 1.345e23, gravity: 1.35, escape: 2.64, tempC: -179, atmo: 'thick_n2', found: { by: 'Christiaan Huygens', year: 1655 } }
};
var AE_KM_PER_MILE = 1.609344, AE_G0 = 9.80665, AE_EARTH_MASS_KG = 5.9722e24;
var AE_ISS_LAUNCH_MS = Date.UTC(1998, 10, 20, 12);   // Zarya, the first module (a day is told at its noon, so it reads the same in every zone)
// Miles where the Almanac's units are feet (the tides' setting, SK.ALM_UNITS, or its guess), kilometres elsewhere.
function _aeImperial() {
  try { var v = localStorage.getItem(SK.ALM_UNITS); if (v === 'ft' || v === 'm') return v === 'ft'; } catch (e) {}
  if (typeof _atUnits === 'function') return _atUnits() === 'ft';
  return /-(US|LR|MM)$/i.test((typeof navigator !== 'undefined' && navigator.language) || '');
}
function _aeLenText(km, frac) {
  var mi = _aeImperial();
  return _orrNum(mi ? km / AE_KM_PER_MILE : km, mi ? 'mile' : 'kilometer', frac || 0);
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
function _aeHasFacts(k) { return !!k && (k === 'iss' || _aeIsProbe(k) || !!_aeFactBase(k)); }
function _aeInfoName(k) {
  if (k === 'iss') return _aeT('alm_earth_iss_name');
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
  if (k === 'iss' || _aeIsProbe(k)) { _aeProbeRows(k, jd, earthH, add, esc, line, far, fromEarth); return rows; }
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
  if (k === 'iss') {
    if (_ae.issPos) {
      var r = _aeLen(_ae.issPos) * AE_EARTH_RADIUS_KM, speed = Math.sqrt(AE_GM_EARTH_KM3_S2 / r);
      add('mission', _aeT('alm_bi_mission'), esc(_aeT('alm_bi_mission_iss')));
      add('launched', _aeT('alm_bi_launched'), esc(_aeFmtDate(AE_ISS_LAUNCH_MS)));
      add('height', _aeT('alm_bi_height'), esc(_aeLenText(r - AE_EARTH_RADIUS_KM)), true);
      add('speed', _aeT('alm_bi_speed'), esc(_aeSpeedText(speed, 2)), true);
      add('orbit', _aeT('alm_bi_orbit_of', { body: _tp('Earth') }), esc(_orrFmtSpan(2 * Math.PI * Math.sqrt(r * r * r / AE_GM_EARTH_KM3_S2))), true);
      var sat = _ae.sats && _ae.sats.list.filter(function (x) { return x.iss; })[0];
      if (sat) add('data', _aeT('alm_bi_iss_data'), esc(_aeT(sat.standing === 'approximate' ? 'alm_earth_approx' : 'alm_earth_data_from', { date: _aeFmtDate(sat.epochMs) })));
    }
    return;
  }
  var t = _aeTracks.tracks[k], ev = (t.events || []).filter(function (e) { return e[1] === 'launch'; })[0];
  add('mission', _aeT('alm_bi_mission'), esc(_aeT('alm_bi_mission_' + k)));
  if (ev) add('launched', _aeT('alm_bi_launched'), esc(_aeFmtDate((ev[0] + 0.5 - JD_UNIX_EPOCH) * MS_PER_DAY)));
  var h = _aeTrackAt(t, jd);
  if (h) {
    add('from_sun', _aeT('alm_bi_from_sun'), esc(_aeAuText(_aeLen(h))) + ' · ' + far(_aeLen(h) * AU_KM), true);
    if (earthH) add('from_earth', _aeT('alm_bi_from_earth'), fromEarth(_aeLen(_aeSub(h, earthH))), true);
    var st = _aeStateOf(function (x) { return _aeTrackAt(t, x); }, jd);
    if (st) add('speed', _aeT('alm_bi_speed'), esc(_aeSpeedText(_aeLen(st.v) * AU_KM / SECONDS_PER_DAY, 1)) + line(_aeT('alm_bi_speed_sun')), true);
  }
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
    p('ae-info-blurb', blurb) + (_aeIsProbe(k) ? p('ae-info-now', a.fact) : '') + p('ae-info-now ae-card-note', a.note) + links + '<dl class="ae-info-dl">' +
    rows.map(function (r) {
      return '<div class="ae-info-row" data-bi="' + r.id + '"><dt>' + _almEsc(r.label) + '</dt><dd>' + r.html + '</dd></div>';
    }).join('') + '</dl>' +
    (_aeLinked(_aeArrivalKey(k)) ? '<p class="ae-info-read">' + _aeLink(_aeArrivalKey(k), _almEsc(_aeT('alm_bi_read', { body: _aeInfoName(k) }))) + '</p>' : '') +
    '</div>';
}
function _aeRenderInfo() {
  var el = _aeById('ae-info'), k = _ae && _ae.info;
  if (!el || !k) return;
  if (k !== 'iss' && _aeIsProbe(k) && !_aeTracks) return;
  var ms = _aeDisplayMs(), body = el.querySelector('.ae-info-body'), scroll = body ? body.scrollTop : 0;
  el.innerHTML = _aeInfoHtml(k, _aeInfoRows(k, ms));
  if (el.querySelector('.ae-info-body')) el.querySelector('.ae-info-body').scrollTop = scroll;
  _ae.infoAt = ms;
  _aeById('ae-info-x').onclick = function () { _aeCloseInfo(true); };
  var a = _aeArrival(k, ms);
  Array.prototype.forEach.call(el.querySelectorAll('[data-ae-open]'), function (x) {
    var l = a.links[+x.getAttribute('data-ae-open')];
    x.onclick = function (e) { e.preventDefault(); _aeClose(); window[l.open](); };
  });
}
// The "now" rows redrawn in place (the focus and the scroll stay where they are).
function _aeUpdateInfoLive(ms) {
  var el = _aeById('ae-info');
  if (!el || !_ae.info || Math.abs(ms - (_ae.infoAt || 0)) < AE_ARRIVAL_REFRESH_MS) return;
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
function _aeBindInfo() {
  var el = _aeById('ae-info'), y0 = null, dy = 0;
  el.addEventListener('touchstart', function (e) {
    var body = el.querySelector('.ae-info-body');
    y0 = body && body.scrollTop > 0 ? null : e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  el.addEventListener('touchmove', function (e) {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) { el.style.transition = 'none'; el.style.transform = 'translateY(' + dy + 'px)'; }
  }, { passive: true });
  el.addEventListener('touchend', function () {
    if (y0 == null) return;
    var shut = dy > AE_INFO_SWIPE_PX;
    y0 = null;
    el.style.transition = el.style.transform = '';
    if (shut) _aeCloseInfo(false);
  });
  _ae.el.addEventListener('pointerdown', function (e) {
    if (!_ae.info || el.contains(e.target) || (e.target.closest && e.target.closest('#ae-info-btn'))) return;
    _aeCloseInfo(false);
  }, true);
}
// The sheet on a phone covers the foot of the picture: while it is up the view's centre rides up by half its height
// (smoothly, and back when it goes), at any zoom. A side panel on a wide screen covers no centre, so nothing moves.
var AE_INFO_SHIFT_TAU_MS = 90, AE_INFO_SHIFT_SNAP_PX = 0.5, AE_INFO_SIDE_PANEL_PX = 760;
function _aeInfoShiftTarget() {
  var el = _aeById('ae-info');
  return (_ae.info && el && _ae.w < AE_INFO_SIDE_PANEL_PX ? el.offsetHeight / 2 : 0) + _aeClockShift();
}
// The date and speed slider along the foot cover the picture's lowest part as well: the centre rides up by half their height.
function _aeClockShift() {
  var el = _aeById('ae-clock');
  return el ? el.offsetHeight / 2 : 0;
}
// One frame of that glide; true while it still moves.
function _aeStepInfoShift(dt) {
  var to = _aeInfoShiftTarget(), from = _ae.infoShift || 0;
  if (from === to) return false;
  var next = Math.abs(to - from) < AE_INFO_SHIFT_SNAP_PX || _aeReduceMotion() ? to : from + (to - from) * Math.min(1, dt / AE_INFO_SHIFT_TAU_MS);
  _ae.infoShift = next;
  _ae.dirty = true;
  return next !== to;
}
function _aeOpenInfo(k) {
  if (!_aeHasFacts(k)) return;
  var el = _aeById('ae-info');
  if (!el) return;
  _ae.info = k;
  _ae.infoFrom = document.activeElement;
  if (_ae.setOpen) _aeShowSettings(false);
  _aeRenderInfo();
  el.classList.add('in');
  _aeMarkInfoBtn();
  _ae.dirty = true;
  _aeKick();
  var x = _aeById('ae-info-x');
  if (x) x.focus({ preventScroll: true });
}
function _aeCloseInfo(refocus) {
  var el = _aeById('ae-info');
  if (!_ae || !_ae.info) return;
  _ae.info = null;
  if (el) el.classList.remove('in');
  _aeMarkInfoBtn();
  _ae.dirty = true;
  _aeKick();
  var back = _ae.infoFrom;
  _ae.infoFrom = null;
  if (refocus && back && back.isConnected && back.focus) back.focus({ preventScroll: true });
}
// The card changed under the sheet: it goes with its place.
function _aeSyncInfo() {
  if (!_ae || !_ae.info) return;
  var k = _ae.arrived;
  if (k && k !== _ae.info && _aeHasFacts(k)) { _ae.info = k; _aeRenderInfo(); return; }
  if (!k) setTimeout(function () { if (_ae && _ae.info && !_ae.arrived) _aeCloseInfo(false); }, 0);   // a flight clears the card, then arrives
}

// ── The sheet's numbers, listed ──
// The Almanac's Constants pages "Bodies" and "Axes and orbits" (almanac-tables.js) list every number a sheet shows and
// every constant the axes are drawn from, each with its source: rows [name key, value, digits, unit, source, name, id].
// _aeInfoRefNeeds says, for each row of a sheet, which listed rows it stands on; the test fails on a row it cannot place or
// a need the pages do not list.
var AE_REF_ORDER = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'ceres',
  'io', 'europa', 'ganymede', 'callisto', 'titan'];
var AE_REF_SRC_FACTS = 'NASA fact sheet', AE_REF_SRC_MOONCOUNT = 'NASA Science, read 2026-11-06', AE_REF_SRC_POLE = 'IAU WGCCRE 2015';
var AE_REF_SRC_ELEMENTS = 'JPL (Standish) mean motion', AE_REF_SRC_MOONS = 'JPL Horizons fit';
function _aeRefMass(kg) { var e = Math.floor(Math.log10(kg)); return (kg / Math.pow(10, e)).toFixed(3) + ' × 10^' + e; }
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
    case 'launched': return [k === 'iss' ? 'iss.launch' : 'probes.launch'];
    case 'speed': return [k === 'iss' ? 'live.iss' : 'live.tracks'];
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
  add('live.planets', _aeT('tb_kn_live_planets'), 'VSOP87D · Keplerian elements', '', 'Bretagnon & Francou; JPL (Standish)');
  add('live.moon', _aeT('tb_kn_live_moon'), 'ELP / Meeus 47', '', 'Meeus 47');
  add('live.tracks', _aeT('tb_kn_live_tracks'), 'JPL Horizons tables', '', 'JPL Horizons');
  add('live.iss', _aeT('tb_kn_live_iss'), 'SGP4', '', 'CelesTrak');
  add('probes.launch', _aeT('tb_kn_probe_launch'), 'JPL Horizons tables', '', 'JPL Horizons');
  add('iss.launch', _aeT('tb_kn_iss_launch'), _aeFmtDate(AE_ISS_LAUNCH_MS), '', 'NASA');
  add('axis.reach', _aeT('tb_kn_axis_reach'), AE_SPIN_AXIS_R, '×', 'Zimi');
  add('axis.min_px', _aeT('tb_kn_axis_min'), AE_AXIS_MIN_PX, 'px', 'Zimi');
  // Go to by name, and the flights to a spacecraft's model.
  add('place.towns', _aeT('tb_kn_place_towns'), 'Kiwix maps · OpenMapTiles', '', 'OpenStreetMap contributors');
  add('place.landmarks', _aeT('tb_kn_place_landmarks'), 'landmarks-v1.json', '', 'Wikidata (CC0)');
  add('place.alt', _aeT('tb_kn_place_alt'), (AE_PLACE_DIST - 1) * AE_EARTH_RADIUS_KM, 'km', 'Zimi');
  add('place.match', _aeT('tb_kn_place_match'), AE_PLACE_ARTICLE_KM, 'km', 'Zimi');
  add('place.map', _aeT('tb_kn_place_map'), AE_MAP_PLACE_ZOOM, '', 'Zimi');
  add('craft.view', _aeT('tb_kn_craft_view'), AE_CRAFT_VIEW_SPANS, '×', 'Zimi');
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
  return _aeProbePos[key] || null;   // a probe, while its table covers the date; null for anything not there
}
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

// ── The minimap ──
// Everywhere but the Planets view itself (where it would be the view twice), a corner disc shows the whole system from
// above the ecliptic: every orbit, every planet as the 2D orrery draws it (its painters, almanac-orrery.js), and you,
// an arrow where the camera is, pointing the way it looks; at the Earth or the Moon, the arrow on the Earth.
var AE_MINI_FILL = 0.46, AE_MINI_SHIP_PX = 6, AE_MINI_ORBIT_ALPHA = 0.28;
function _aeMiniShown() {
  return !!(_ae.gl && _ae.gl.ecl) && _ae.preset !== 'planets' && !_ae.hand;
}
function _aeDrawMini() {
  var btn = _aeById('ae-mini'), on = _aeMiniShown() && typeof _orreryPaintPlanets === 'function';
  if (!btn) return;
  if (btn.hidden === on) btn.hidden = !on;
  if (!on) return;
  var S = _ae.gl, e = S.ecl, cv = _aeById('ae-mini-c'), dpr = S.dpr, size = AE_MINI_PX * dpr;
  if (cv.width !== size) { cv.width = cv.height = size; }
  var g = cv.getContext('2d'), half = size / 2, W = size * AE_MINI_FILL / _AU_VIS_Y[_AU_VIS_Y.length - 1];
  var jd = _ae.scene.ms / MS_PER_DAY + JD_UNIX_EPOCH;
  var names = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  // The orrery's own picture of the system (its painters), at this size: one drawing for both.
  g.clearRect(0, 0, size, size);
  _orreryPaintOrbits(g, half, half, W, 0, dpr, names, AE_MINI_ORBIT_ALPHA);
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
  var cam = S.camera, d = _aeSub([cam.position.x, cam.position.y, cam.position.z], e.sun), y = _aeCross(e.z, e.x);
  var px = _aeDot(d, e.x), py = _aeDot(d, y), dist = Math.hypot(px, py);
  var vis = Math.min(half * 0.98, dist / AE_SUN_SHOW_DIST * _solarSqueeze(1) * W);
  var c0 = [half + (dist ? px / dist * vis : 0), half - (dist ? py / dist * vis : 0)];
  var f = cam.getWorldDirection(new S.THREE.Vector3()), fv = [f.x, f.y, f.z];
  var a = Math.atan2(-_aeDot(fv, y), _aeDot(fv, e.x)), L = AE_MINI_SHIP_PX * dpr;
  g.save();
  g.translate(c0[0], c0[1]); g.rotate(a);
  g.fillStyle = AE_PROBE_HEX;
  g.beginPath(); g.moveTo(L, 0); g.lineTo(-L * 0.7, L * 0.6); g.lineTo(-L * 0.35, 0); g.lineTo(-L * 0.7, -L * 0.6); g.closePath(); g.fill();
  g.restore();
}

// ── Past the pictures: the map ──
// Come down close over the Earth and an installed map takes over from the globe: Map here opens it at the place under
// the middle of the screen, at the scale the view was showing (a StreetZim or Kiwix map, the last one used first).
var AE_MAP_HANDOFF_DIST = 1.25;            // Earth radii from the centre: ~1,600 km up, a region on screen
var AE_MAP_M_PER_PX_Z0 = 156543.034;       // a web map's metres per pixel at zoom 0, at the equator
var AE_MAP_ZOOM_RANGE = [2, 17];
var AE_MAP_PLACE_ZOOM = 12;                // a place picked in Go to opens the map here: a town and its streets on screen
function _aeMapZims() { return typeof _installedMaps === 'function' ? _installedMaps() : []; }
// Where Map here would open and how close: a place picked in Go to, else the point under the middle of the screen at
// the scale the view shows.
function _aeMapHereAim() {
  if (_ae.place) return { g: { lat: _ae.place.lat, lon: _ae.place.lon }, zoom: AE_MAP_PLACE_ZOOM };
  var cam = _ae.gl.camera, pos = [cam.position.x, cam.position.y, cam.position.z];
  var g = _aeFixedToGeodeticDirection(_aeSceneToFixed(pos, _ae.scene.gast));   // the camera looks at the centre: the point below it
  var altKm = (_aeLen(pos) - 1) * AE_EARTH_RADIUS_KM;
  var mPerPx = 2 * altKm * 1000 * Math.tan(_aeRad(cam.fov) / 2) / _ae.h;
  return { g: g, zoom: _aeClamp(Math.log2(AE_MAP_M_PER_PX_Z0 * Math.cos(_aeRad(g.lat)) / mPerPx), AE_MAP_ZOOM_RANGE[0], AE_MAP_ZOOM_RANGE[1]) };
}
// The installed map to open there: one whose ground includes the point (the last one used first), none when every
// map's bounds rule it out. A map whose bounds are not known is not ruled out.
function _aeMapHereZim(g) {
  var here = _aeMapZims().filter(function (z) { return _mapCovers(z, { lat: g.lat, lng: g.lon }) !== false; });
  var last = typeof _lastMapVisit === 'function' ? _lastMapVisit() : null;
  return here.filter(function (z) { return last && last.zim && z.name === last.zim.name; })[0] || here[0] || null;
}
function _aeShowMapHere() {
  var row = _aeById('ae-maprow');
  if (!row) return;
  // Close enough that the globe is a blur, or a place picked (its flight stops higher, where the Earth's map ends).
  var near = _ae.dist <= AE_MAP_HANDOFF_DIST || !!_ae.place;
  var on = _ae.target === 'earth' && !_ae.fly && !_ae.hand && near && _aeMapZims().length > 0 && !!_aeMapHereZim(_aeMapHereAim().g);
  if (row.hidden === on) row.hidden = !on;
}
function _aeOpenMapHere() {
  if (!_ae.scene || !window.AlmanacLinks || typeof mapPositionHash !== 'function') return;
  var aim = _aeMapHereAim(), z = _aeMapHereZim(aim.g);
  if (!z) return;
  AlmanacLinks.openHit({ zim: z.name, path: z.main_path, title: typeof _mapName === 'function' ? _mapName(z) : z.title },
    { pos: mapPositionHash(aim.zoom, aim.g.lat, aim.g.lon) });
}

// ── Landmarks: named places on a body, at their true coordinates ──
// landmarks-v1.json (scripts/build_landmarks.py): per body, rows of [name, lat, lon, kind, qid, size_km]. A body's
// places are named as the view comes near enough to read them: a feature once it spans AE_LM_MIN_PX on screen, a landing
// once the body is AE_LM_LANDING_MIN_R_PX in radius, the biggest first and none on top of another. A tap opens its card:
// what it is, its article when the library has it, and Fly there, down to the surface over it. A body is a key, so Mars
// and the rest slot in beside the Moon (with a placement in _aeLmBodies).
var AE_LM_URL = '/static/earth/landmarks-v1.json';
var AE_LM_MAX = 18;
var AE_LM_MIN_PX = 28;
var AE_LM_LANDING_MIN_R_PX = 80;
var AE_LM_BOX_H = 26;                        // a label's box is this tall (its padding and line), centred on its dot
var AE_LM_PAD_X = 26, AE_LM_FONT_PX = 11;   // its padding either side of the name (.ae-lm), and the name's size
var AE_LM_DOT_X = 9;                         // the dot's centre, from the label's left edge (.ae-lm::before)
var AE_LM_EDGE_PX = 8;                       // a name keeps this clear of the screen's right edge
var AE_LM_FACING = 0.05;                     // how far round the limb a place still faces the camera (cosine)
// A row's kind as its card names it (alm_lm_kind_<name>): the Moon's own kinds fold into the few every body shares.
var AE_LM_KINDS = {
  landing: 'landing', statio: 'landing', crater: 'crater', mare: 'mare', lacus: 'mare', sinus: 'mare', palus: 'mare',
  mons: 'mons', volcano: 'volcano', plain: 'plain', highland: 'highland', promontorium: 'highland', region: 'region',
  valley: 'valley', vallis: 'valley', ridge: 'ridge', rupes: 'ridge', chain: 'chain', catena: 'chain', sea: 'sea',
  wonder: 'wonder', launch: 'launch', landing_feature: 'other'
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
// Off until this viewer turns them on in the gear (kept with the person); a landmark flown to by choice (its card,
// a landing site) still shows, alone.
var AE_LM_LAYER_KEY = SK.ALM_LANDMARKS;
function _aeLmLayerOn() { try { return localStorage.getItem(AE_LM_LAYER_KEY) === '1'; } catch (e) { return false; } }
function _aeLmSetLayer(on) {
  _prefWrite(AE_LM_LAYER_KEY, on ? '1' : null);
  if (on) _aeLmLoad();
  if (_ae) { _ae.dirty = true; _aeKick(); }
}
function _aeLmLoad() {
  if (_aeLm || _aeLmLoading || typeof fetch !== 'function') return;
  _aeLmLoading = fetch(AE_LM_URL).then(function (r) { if (!r.ok) throw new Error('landmarks'); return r.json(); }).then(function (d) {
    _aeLm = d;
    if (_ae) { _ae.dirty = true; _aeKick(); }
    _aeGoRender();
    _aePlaceRefresh();
  }).catch(function () { _aeLmLoading = null; _aeGoRender(); });
}
// The bodies the landmarks file lists, in its order (the Moon first).
function _aeLmBodyKeys() { return Object.keys(_aeLm).filter(function (k) { return Array.isArray(_aeLm[k]) && Array.isArray(_aeLm[k][0]); }); }
// Where each body with landmarks stands: its centre, radius and turn (the rotation part of its matrix, column-major,
// squashed along its pole by its flattening where it is drawn so).
function _aeLmBodies() {
  var S = _ae.gl, sc = _ae.scene;
  if (!S || !sc || !_aeLm) return [];
  var out = [];
  _aeLmBodyKeys().forEach(function (k) {
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
function _aeLmDir(b, lat, lon) {
  var v = _aeLatLonVec(lat, lon), e = b.m;
  return [e[0] * v[0] + e[4] * v[1] + e[8] * v[2], e[1] * v[0] + e[5] * v[1] + e[9] * v[2], e[2] * v[0] + e[6] * v[1] + e[10] * v[2]];
}
// With Landmarks off, the Moon still names where people landed, quietly: Apollo's six (all the landings once the
// Landings group has been opened), and the place chosen. Landmarks on names everything.
var AE_LM_APOLLO = /^Apollo (11|12|14|15|16|17)$/;
function _aeLmQuietRows(body, chosen) {
  var rows = body === 'moon' && _ae.target === 'moon' ? _aeLm[body].filter(function (r) {
    return r[3] === 'landing' && (_ae.allLandings || AE_LM_APOLLO.test(r[0]));
  }) : [];
  if (chosen && chosen.body === body && rows.indexOf(chosen.row) < 0) rows.push(chosen.row);
  return rows.length ? rows : null;
}
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
  var w = AE_LM_PAD_X + _aeLmTextW(c.row[0]), left = c.s.x - AE_LM_DOT_X + w > _ae.w - AE_LM_EDGE_PX;
  var x0 = left ? c.s.x + AE_LM_DOT_X - w : c.s.x - AE_LM_DOT_X;
  return { x0: x0, x1: x0 + w, y0: c.s.y - AE_LM_BOX_H / 2, y1: c.s.y + AE_LM_BOX_H / 2, left: left };
}
function _aeUpdateLandmarks() {
  var host = _aeById('ae-lms');
  if (!host) return;
  var placed = [];
  if (_aeLm && !_ae.fly && !_ae.hand) {
    var cam = _ae.gl.camera, eye = [cam.position.x, cam.position.y, cam.position.z];
    var pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
    var cands = [], layer = _aeLmLayerOn(), chosen = _ae.lm;
    _aeLmBodies().forEach(function (b) {
      var rows = layer ? _aeLm[b.key] : _aeLmQuietRows(b.key, chosen);
      if (!rows) return;
      var rPx = b.r / _aeLen(_aeSub(b.center, eye)) * pxPerRad;
      if (rPx < AE_LM_LANDING_MIN_R_PX / 2) { if (rPx > 4 && layer) _aeLmLoad(); return; }
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i], d = _aeLmDir(b, row[1], row[2]), n = _aeNorm(d);
        var p = [b.center[0] + d[0] * b.r, b.center[1] + d[1] * b.r, b.center[2] + d[2] * b.r];
        var toEye = _aeSub(eye, p), dist = _aeLen(toEye);
        if (_aeDot(n, toEye) < AE_LM_FACING * dist) continue;
        var landing = row[3] === 'landing', point = !row[5];   // a point has no extent to measure: it shows with the body
        var px = row[5] / AE_EARTH_RADIUS_KM / dist * pxPerRad * (AE_LM_KIND_WEIGHT[row[3]] || 1);
        if (point ? rPx < AE_LM_LANDING_MIN_R_PX : px < AE_LM_MIN_PX) continue;
        var s = _aeProject(p);
        if (!s || s.x < 0 || s.y < 0 || s.x > _ae.w || s.y > _ae.h) continue;
        cands.push({ b: b.key, row: row, s: s, fame: row[7] || 0, pri: landing ? Infinity : point ? AE_LM_POINT_PRI : px });
      }
    });
    // Landing sites first, then the best known (row[7]: how many Wikipedias have an article, the body's top few ahead of
    // all), then the biggest on screen: a name that must give way to another is the more obscure one.
    cands.sort(function (a, c) {
      if (a.pri === Infinity || c.pri === Infinity) return a.pri === c.pri ? c.fame - a.fame : a.pri === Infinity ? -1 : 1;
      return c.fame - a.fame || c.pri - a.pri;
    });
    for (var k = 0; k < cands.length && placed.length < AE_LM_MAX; k++) {
      var c = cands[k], bx = c.box = _aeLmBox(c);
      if (placed.some(function (q) { return bx.x0 < q.box.x1 && q.box.x0 < bx.x1 && bx.y0 < q.box.y1 && q.box.y0 < bx.y1; })) continue;
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
  // One way there; in the lunar night a quiet second way, at sunrise, under it (not a second button beside it). Once
  // there, no way there: the card says what the place is, and the night (with sunrise as the link) if it is dark.
  var here = !!lm.flown;
  var night = lm.morning ? '<p class="ae-lm-dark"><a href="#" id="ae-lm-morning">' +
    _almEsc(_aeT('alm_lm_night_until', { date: _aeFmtWhen(lm.morning) })) + '</a></p>' : '';
  card.innerHTML = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
    '<h3>' + (lm.hit ? '<a href="#" id="ae-lm-read">' + name + '</a>' : name) + '</h3>' +
    '<p class="ae-lm-line"><span>' + _almEsc(line) + '</span>' +
    (here ? '' : '<button type="button" class="ae-btn ae-lm-fly" id="ae-lm-fly">' + _almEsc(_aeT('alm_lm_fly')) + '</button>') + '</p>' + night;
  card.hidden = false;
  _aeById('ae-card-x').onclick = function () { _ae.lm = null; _aeRenderCard(); };
  var fly = _aeById('ae-lm-fly');
  if (fly) fly.onclick = function () { _aeLmFly(lm.body, row); };
  var morning = _aeById('ae-lm-morning');
  if (morning) morning.onclick = function (e) { e.preventDefault(); var at = lm.morning; lm.morning = null; _aeGoTo(at); _aeLmFly(lm.body, row); _aeRenderCard(); };
  var read = _aeById('ae-lm-read');
  if (read) read.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(lm.hit); };
}
// Down to the place: the camera comes over it, as near as the body's tiles allow, looking straight down.
function _aeLmFly(body, row) {
  var b = _aeLmBodies().filter(function (x) { return x.key === body; })[0];
  if (!b) return;
  if (!_ae.lm || _ae.lm.row !== row) _ae.lm = { body: body, row: row, hit: null };   // its name shows there, layer on or off
  _ae.lm.flown = true;
  _aeRenderCard();
  // Over an Apollo site with Almanac HD, all the way down to the inserts' half-metre tiles.
  var hdb = _ae.gl.hd && _ae.gl.hd.bodies.filter(function (x) { return x.key === body; })[0];
  if (hdb) AE_TARGETS[body].min = _aeHdMinOver(hdb, row[1], row[2]);
  _aeFlyTo(body, AE_TARGETS[body].min, _aeAzElOf(_aeLmDir(b, row[1], row[2])));
  _ae.preset = null;
}

// The offer, in the data note's quiet line: shown to someone who may download (can_change) while the setting is Ask
// first and they have not said Not now for this person; under Automatically the server's first answer already started it.
// It comes with the view's satellite data (_aeTakeSats); while the download runs, /almanac-hd is asked how far it got,
// and once it is in the library the view draws from it without a reload.
var AE_HD_URL = '/almanac-hd', AE_HD_SET_URL = '/manage/almanac-hd';
var AE_HD_LATER_KEY = SK.ALM_HD_LATER;
var AE_HD_POLL_MS = 3000;
function _aeHdLater() { try { return localStorage.getItem(AE_HD_LATER_KEY) === '1'; } catch (e) { return false; } }
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
  if (_ae.hdInstalled && S && !S.hd && !S.hdAsked) { S.hdAsked = true; _aeHdLoad(S); }
  var text = '', offer = false;
  if (st && st.downloading) {
    text = _aeT('alm_hd_getting', { pct: Math.floor(100 * st.downloading.done / Math.max(1, st.downloading.size)) });
    if (_aeIsOpen) _ae.hdPoll = setTimeout(_aeHdPollNow, AE_HD_POLL_MS);
  } else if (st && st.offer && st.can_change && st.mode === 'ask' && !_aeHdLater()) {
    var size = _aeHdOfferSize(st.offer);
    text = _aeT('alm_hd_offer') + ': ' + _aeT('alm_hd_offer_sub', { size: size });
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
  if (offer.approx || typeof fmtBytes !== 'function') return (offer.approx ? '~' : '') + Math.round(offer.size / 1e6) + ' MB';
  return fmtBytes(offer.size);
}
// Almanac HD in the gear, whatever the line under the controls says: after Not now this is where it is found again.
// Installed; downloading and how far; a Download with its size for someone who may; for anyone else, who can.
// Nothing under Never (or ZIMI_OFFLINE), or when this version names no file.
function _aeHdRowHtml() {
  var st = _ae.hdSt;
  if (!st || (!st.installed && (!st.offer || st.mode === 'never'))) return '';
  var head = '<b>' + _almEsc(_aeT('alm_hd_offer')) + '</b>', tail;
  if (st.installed || _ae.hdInstalled) tail = _almEsc(_aeT('alm_hd_installed'));
  else if (st.downloading) tail = _almEsc(_aeT('alm_hd_getting', { pct: Math.floor(100 * st.downloading.done / Math.max(1, st.downloading.size)) }));
  else {
    var size = _aeHdOfferSize(st.offer);
    tail = st.can_change ? _almEsc(size) + ' · <button type="button" class="ae-fresh" id="ae-set-hd-get">' + _almEsc(_aeT('alm_hd_get')) + '</button>'
      : _almEsc(size) + ' · ' + _almEsc(_aeT('alm_hd_ask_admin'));
  }
  return '<p class="ae-set-data ae-set-hd">' + head + '<br>' + tail + '</p>';
}
function _aeHdGet() {
  _aeById('ae-hd-get').disabled = true;
  var row = _aeById('ae-set-hd-get');
  if (row) row.disabled = true;
  _aePost(AE_HD_SET_URL, { start: true }).then(function (st) {
    st.can_change = true;
    _aeHdShow(st);
  }).catch(function () { _aeHdShow(null); }).then(function () { _aeById('ae-hd-get').disabled = false; });
}
function _aeHdNotNow() {
  _prefWrite(AE_HD_LATER_KEY, '1');
  _aeHdShow(null);
}

// Over budget: the least recently drawn tiles below level 2 give their GPU memory back (and are fetched again if needed).
function _aeHdEvict(S) {
  var hd = S.hd;
  if (hd.gpu <= AE_HD_GPU_TILES) return;
  var all = [];
  hd.bodies.forEach(function (b) {
    for (var k in b.nodes) {
      var n = b.nodes[k];
      if (n.z > AE_HD_KEEP_LEVEL && n.used !== hd.frame && Object.keys(n.tex).some(function (l) { return n.tex[l] && n.tex[l].isTexture; })) all.push(n);
    }
  });
  all.sort(function (a, b) { return a.used - b.used; });
  for (var i = 0; i < all.length && hd.gpu > AE_HD_GPU_TILES; i++) {
    var n = all[i];
    _aeHdFreeMesh(n);
    for (var l in n.tex) {
      // Only what is on the GPU: a tile still on its way keeps its place in the queue.
      if (n.tex[l] && n.tex[l].isTexture) { n.tex[l].dispose(); hd.gpu--; delete n.tex[l]; }
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
    ringsAt: null, issRingAt: null, moonPathAt: null,
    positions: [],                        // projected satellites for tapping
    lastTs: 0, lastRender: 0, lastText: 0, dirty: true,
    raf: 0, idleTimer: 0,
    scene: null,
    spin: null                            // Planets side by side while it is up: { autoRun, prevFocus }
  };
}

// ── The clock ──
// One clock: the Almanac's (almanac.js _almFocus and _almRate, null for now). The hero Moon, the header, the pinned strip
// and this view all read it, and this view's foot carries the same date and speed slider (_almClockHtml): there is no
// speed of its own. The page's loop advances it (_almClockFrame), and draws this view in the same frame (_aeFollowClock).
function _aeDisplayMs() {
  return (typeof _almFocusInstant === 'function') ? _almFocusInstant().getTime() : Date.now();
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
  return Math.tan(_aeRad(AE_FOV_DEG) / 2) * Math.min(1, aspect);
}
function _aeFitDist(radius) {
  return radius / (_aeNarrowTanHalf() * AE_FIT_FILL);
}
// What the camera can circle: how near and far it may go, and the surface a
// drag's speed is measured from.
var AE_TARGETS = {
  earth: { min: AE_MIN_DIST_EARTH, max: AE_MAX_DIST, surface: 1 },
  moon: { min: AE_MIN_DIST_MOON, max: AE_MAX_DIST, surface: AE_MOON_RADIUS_RE },
  sun: { min: AE_MIN_DIST_SUN, max: AE_MAX_DIST_SUN, surface: AE_SUN_SHOW_R }
};
function _aeClampDist(d) { var t = AE_TARGETS[_ae.target]; return _aeClamp(d, t.min, t.max); }
function _aeTargetPos() { return _aeBodyPos(_ae.target) || [0, 0, 0]; }
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
var AE_ROLL_SETTLE = 0.85;
function _aeFlightUp(dir, nominal, f) {
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
function _aeFlyTo(target, dist, azel, overview) {
  var from = { pos: _aeTargetPos(), dist: _ae.dist, az: _ae.az, el: _ae.el_, roll: _ae.roll || 0, target: _ae.target };
  _ae.orbitFly = { from: from.target, to: target, endAt: null };   // whose orbits show while it flies
  _ae.pan = null;
  _ae.target = target;
  if (azel) { _ae.az = azel.az; _ae.el_ = azel.el; }
  var to = { dist: _aeClampDist(dist) };
  if (_aeReduceMotion()) { _ae.dist = to.dist; _ae.fly = null; _ae.orbitFly.endAt = performance.now(); }
  else {
    // Turn the short way round.
    var daz = ((_ae.az - from.az + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    var ms = overview ? AE_FLY_OVERVIEW_MS : _aeFlyMs(from, _aeTargetPos(), to.dist, _ae.az, _ae.el_);
    var hold = !overview && !!_ae.scene && target !== from.target;
    _ae.fly = { start: performance.now(), ms: ms, hold: hold, from: from, toDist: to.dist, toAz: from.az + daz, toEl: _ae.el_, lead: AE_FLY_APPROACH_MS };
    if (hold) {
      var sh = _aeShoulder(from, AE_TARGETS[from.target].surface, _aeTargetPos());
      _ae.fly.shoulder = sh;
      _aeFlyTables(_ae.fly);
      _ae.fly.bend = _aeBendAfter(_ae.fly);
      _aeFarFor(sh.far);
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
  f.rollEnd = null;
  run(function () {});
  f.rollEnd = _ae.flightOff;
  var prev = null;
  run(function (pose) {
    var right = _aeCross(pose.look, pose.up);
    if (prev) {
      // The angle of the turn between two orthonormal frames, from the trace of the matrix taking one to the other.
      var trace = _aeDot(prev.look, pose.look) + _aeDot(prev.up, pose.up) + _aeDot(prev.right, right);
      peak = Math.max(peak, _aeDeg(Math.acos(_aeClamp((trace - 1) / 2, -1, 1))) * AE_FRAME_MS / dt);
    }
    prev = { look: pose.look, up: pose.up, right: right };
  });
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
function _aeShoulder(from, rOld, dest) {
  var a = from.pos, ab = _aeSub(dest, a), len = _aeLen(ab), u = _aeScale(ab, 1 / len);
  var up = _aeViewUp(u, from.roll), side = _ae.w > _ae.h ? up : _aeCross(u, up);
  if (_aeDot(_aeCameraOffset(from.az, from.el, 1), side) < 0) side = _aeScale(side, -1);
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
  var travel = _aeLen(_aeSub(pb, pa)) / Math.max(1e-6, Math.min(from.dist, toDist));
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
  if (!f.hold) return _aeEaseInOut(_aeClamp((now - f.start) / f.ms, 0, 1));
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
    _ae.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.toDist) - Math.log(f.from.dist)) * arrive);
    _ae.az = f.from.az + (f.toAz - f.from.az) * arrive;
    _ae.el_ = f.from.el + (f.toEl - f.from.el) * arrive;
  }
  if (now - f.start >= _aeFlyLead(f) + f.ms + (f.hold ? AE_FLY_TAIL_MS : 0)) { _ae.fly = null; _aeFarFor(0); if (_ae.orbitFly) _ae.orbitFly.endAt = now; }
  return true;
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
  }
  return _aeLerp3(f.from.pos, to, e);
}

// Where the camera stands and how wide it sees, now: the view's own
// (target, turn, distance, a flight between presets), or, while the Moon is
// passing between the hero and the view, a blend of the view's camera and
// the hero's (_aeHandCam).
function _aeViewCam() {
  var tp = _aePanned(_aeFlyTargetPos());
  var roll = _ae.scene ? _aeRollDeg(_ae.target, _ae.scene.ms) : 0;
  if (_ae.fly) roll = _ae.fly.from.roll + _angleDelta(_ae.fly.from.roll, roll) * _aeSmoother(_ae.fly.prog || 0);
  return { tp: tp, az: _ae.az, el: _ae.el_, dist: _ae.dist, tanHalf: Math.tan(_aeRad(AE_FOV_DEG) / 2), roll: roll, frame: null };
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
  // The far plane reaches the shoulder only while a flight with one is under way: a drag or a hand-in that ends the
  // flight early must not leave it out at the Sun (it costs every later view its depth precision).
  _aeFarFor(Math.max(_ae.fly && _ae.fly.shoulder ? _ae.fly.shoulder.far : 0, _ae.dist + AE_FAR));   // far out, the far side of the planets too
  var c = _aeViewCam();
  if (_ae.hand && _ae.scene) c = _aeHandBlend(_aeHandCam(_ae.scene, _ae.hand), c, _ae.hand.e);
  var tp = c.tp, pose = _aePoseOf(c), pos = pose.pos, up = pose.up;
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
    if (_ae.infoShift && _ae.w && _ae.h) cam.setViewOffset(_ae.w, _ae.h, 0, _ae.infoShift, _ae.w, _ae.h);
    else if (cam.view) cam.clearViewOffset();
  }
  // Near plane from the nearest surface, so the Earth's limb never clips
  // and depth precision stays where the eye is.
  var toEarth = _aeLen(pos) - 1;
  var toMoon = _ae.scene ? _aeLen(_aeSub(pos, _ae.scene.moon)) - AE_MOON_RADIUS_RE : Infinity;
  var toSun = _ae.scene ? _aeLen(_aeSub(pos, _aeSunShown(_ae.scene))) - AE_SUN_SHOW_R : Infinity;
  // And from every planet and moon, and the probe in view: in a flight the body left behind stands in the foreground,
  // and a near plane set by the Earth or the Sun alone cut it away (its ring went with it).
  var craftSpan = _aeIsProbe(_ae.target) && AE_CRAFT_MODEL[_ae.target] ? _aeCraftSpanRe(AE_CRAFT_MODEL[_ae.target]) : 0;
  var toBody = _aeIsProbe(_ae.target) ? _aeLen(_aeSub(pos, _aeTargetPos())) - (craftSpan ? craftSpan / 2 : AE_PROBE_SURFACE) : Infinity;
  // The station too, drawn or not yet (the first frame close by would put it in front of the near plane).
  if (_ae.issPos) toBody = Math.min(toBody, _aeLen(_aeSub(pos, _ae.issPos)) - AE_ISS_SPAN_RE / 2);
  var pl = _ae.gl.planets;
  for (var pk in pl) {
    if (!pl[pk].pos) continue;
    toBody = Math.min(toBody, _aeLen(_aeSub(pos, pl[pk].pos)) - pl[pk].b.r * (1 + (pl[pk].b.rings ? 1.4 : 0)));
  }
  cam.near = Math.max(craftSpan ? AE_CRAFT_NEAR_MIN : AE_NEAR_MIN, Math.min(toEarth, toMoon, toSun, toBody) * AE_NEAR_FRACTION);
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
  var out = _aeClamp((held - AE_ORBIT_FADE_FROM) / (AE_ORBIT_FADE_TO - AE_ORBIT_FADE_FROM), 0, 1) * _aeFadeU.value * _aeOrbitShow('moon');
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

// A flight to a probe's model: it fills the picture from AE_CRAFT_VIEW_SPANS of its span, lit three-quarter from the
// Sun's side, and a body it is near (Jupiter for Juno) stands behind it.
// How far off a flight to a craft of this span ends (the station too): the whole span inside the narrower side of the screen.
function _aeCraftViewDist(span) { return Math.max(span * AE_CRAFT_VIEW_SPANS, _aeFitDist(span * AE_CRAFT_FIT_R)); }
// `waitModel`: the span is a guess, the model (loading) will correct it (_aeRefitCraftFlight).
function _aeFlyToCraft(name, pp, span, waitModel) {
  AE_TARGETS[name].min = span * 0.9;
  AE_TARGETS[name].surface = span / 2;
  var toSun = _ae.scene ? _aeNorm(_aeSub(_aeSunShown(_ae.scene), pp)) : [1, 0, 0];
  var near = null, nearD = Infinity;
  AE_MARKED.forEach(function (m) {
    if (m.body === name || _aeIsProbe(m.body)) return;
    var q = _aeBodyPos(m.body), d = q ? _aeLen(_aeSub(q, pp)) : Infinity;
    if (d < nearD) { nearD = d; near = q; }
  });
  var side = _aeNorm(_aeCross(toSun, [0, 0, 1])), dir;
  if (AE_CRAFT_POINTS[AE_CRAFT_MODEL[name]] === 'sun') dir = _aeAdd(_aeAdd(_aeScale(side, 0.85), _aeScale(toSun, 0.35)), [0, 0, 0.3]);   // a shield in profile, lit
  else if (near && nearD < AE_PROBE_FRAME_MAX) dir = _aeAdd(_aeScale(_aeNorm(_aeSub(pp, near)), 0.8), _aeScale(toSun, 0.5));
  else dir = _aeAdd(_aeScale(toSun, 0.6), _aeScale(side, 0.8));
  // Its whole span inside the narrower side of the screen (a phone held upright is narrow across: three spans along
  // the view left Voyager's booms off both edges).
  _aeFlyTo(name, _aeCraftViewDist(span), _aeAzElOf(_aeNorm(dir)));
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
  f.ms = _aeFlyMs(f.from, _aeTargetPos(), f.toDist, f.toAz, f.toEl);
  _aeFlyTables(f);
  f.bend = _aeBendAfter(f);
}
// A flight to one place: its card comes with it, and any other card goes.
function _aeArrive(name) { _ae.arrived = name; _ae.lm = null; _ae.selected = null; _aeRenderCard(); }
function _aePreset(name) {
  if (!_ae.gl) return;
  if (_ae.spin && name !== AE_SPIN_KEY) { _aeLeaveSpin(); _aeFullStepOut(); }   // its full-screen step too, if it made one
  if (_ae.arrived && name !== _ae.arrived) { _ae.arrived = null; _aeRenderCard(); }
  if (_ae.lm && name !== _ae.lm.body) { _ae.lm = null; _aeRenderCard(); }   // a site's card stays at its body
  if (_ae.place) { _ae.place = null; _aeRenderCard(); }   // a place picked in Go to is left behind by any other place
  // The row says where the view is going at once, also for a destination that flies from a callback (a probe's model
  // loading first): the last chip pressed no longer stays lit over Voyager.
  _ae.preset = name;
  _aeMarkViews();
  if (name === AE_SPIN_KEY) {
    _aeEnterSpin();
  } else if (name === 'moon') {
    // From the Earth's side: the phase (and any eclipse) as seen from home.
    var azel = _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.moon, -1)) : null;
    _aeFlyTo('moon', _aeFitDist(AE_FIT_MOON), azel);
    _aeArrive('moon');
  } else if (name === 'planets') {
    // The whole system from above the ecliptic's north: every orbit round, the belt a ring, each planet a name to tap.
    var jd = (_ae.scene ? _ae.scene.ms : Date.now()) / MS_PER_DAY + JD_UNIX_EPOCH;
    var up = typeof _ephEclJ2000ToEqOfDate === 'function' ? _ephEclJ2000ToEqOfDate([0, 0, 1], jd + _aeDeltaTDays(jd)) : [0, 0, 1];
    _aeFlyTo('sun', _aeFitDist(_aeShownDist(AE_PLANETS_OUTER_AU)), _aeAzElOf(up), true);
  } else if (_aeIsProbe(name)) {
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
    _aeFlyTo(name, _aeFitDist(AE_TARGETS[name].surface * AE_PLANET_FIT * (_aePlanetBody(name).rings ? 1.6 : 1)), _ae.scene ? _aeAzElOf(_aeScale(at, -1)) : null);
    _aeArrive(name);
  } else if (name === 'iss') {
    if (!_ae.issPos || !_ae.issBasis) return;
    // From above, behind and to starboard: the truss across the picture, the Earth below it to the horizon.
    var B = _ae.issBasis, dir = [0, 1, 2].reduce(function (acc, k) { return _aeAdd(acc, _aeScale(B[k], AE_ISS_VIEW_DIR[k])); }, [0, 0, 0]);
    // On the Sun's side of the arrays (they face it), so their faces are lit and can glint: the other way round
    // horizontally if the Sun is behind.
    if (_ae.scene && _aeDot(dir, _ae.scene.sun) < 0) dir = _aeAdd(_aeScale(B[0], AE_ISS_VIEW_DIR[0]), _aeAdd(_aeScale(B[1], -AE_ISS_VIEW_DIR[1]), _aeScale(B[2], -AE_ISS_VIEW_DIR[2])));
    _aeCraftLoad('iss');
    _aeFlyTo('iss', _aeCraftViewDist(_aeCraftSpanRe('iss') || AE_ISS_SPAN_RE), _aeAzElOf(dir));
    _aeWaitForModel('iss');
    _aeArrive('iss');
  } else if (name === 'sun') {
    // From the Earth's side too: the Sun as it stands in our sky, ahead.
    _aeFlyTo('sun', _aeFitDist(AE_FIT_SUN), _ae.scene ? _aeAzElOf(_aeScale(_ae.scene.sun, -1)) : null);
    _aeArrive('sun');
  } else {
    // Back from the Sun, arrive over the day side, the Sun behind the camera.
    var fromSun = _ae.target === 'sun' && _ae.scene ? _aeAzElOf(_ae.scene.sun) : null;
    _aeFlyTo('earth', _aeFitDist(name === 'sats' ? AE_FIT_SATS : AE_FIT_EARTH), fromSun);
  }
  _ae.preset = name;
  _aeMarkViews();
}
function _aeMarkViews() {
  _aeRenderRow();
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
// A choice's hint; where it names the source, the name links to it.
var AE_SAT_SOURCE_URL = 'https://celestrak.org/';
function _aeSetHint(key) {
  var mark = '\u0001';
  return _almEsc(_aeT(key, { src: mark })).replace(mark,
    '<a href="' + AE_SAT_SOURCE_URL + '" target="_blank" rel="noopener">CelesTrak</a>');
}
// Orbits: one line, three choices (this viewer's own, kept with the person).
function _aeOrbitsRowHtml() {
  var mode = _aeOrbitsMode();
  return '<div class="ae-set-orbits" role="radiogroup" aria-labelledby="ae-orbits-title"><b id="ae-orbits-title">' + _almEsc(_aeT('alm_orbits')) + '</b>' +
    AE_ORBITS_MODES.map(function (m) {
      return '<label><input type="radio" name="ae-orbits" value="' + m + '"' + (m === mode ? ' checked' : '') + '>' +
        '<span>' + _almEsc(_aeT('alm_orbits_' + m)) + '</span></label>';
    }).join('') + '</div>';
}
function _aeSetOrbits(m) {
  _prefWrite(AE_ORBITS_KEY, m === 'flying' ? null : m);
  // Chosen while standing still, While flying hides the lines at once: no flight is on, so none of them belongs.
  if (_ae && m === 'flying' && !_ae.fly) _ae.orbitFly = null;
  if (_ae) { _ae.dirty = true; _aeKick(); }
}
function _aeRenderSettings() {
  var panel = _aeById('ae-set-body');
  if (!panel || !_ae.setOpen) return;
  var m = _ae.satMeta || {};
  var editable = !!m.canChange && !m.locked && !_ae.setBusy;
  var html = (typeof _almDismissX === 'function' ? _almDismissX() : '') +
    // This viewer's own: names of places on the bodies (off until turned on, kept with the person).
    '<label class="ae-set-choice"><input type="checkbox" name="ae-lm-layer"' + (_aeLmLayerOn() ? ' checked' : '') + '>' +
      '<span><b>' + _almEsc(_aeT('alm_lm_layer')) + '</b><small>' + _almEsc(_aeT('alm_lm_layer_hint')) + '</small></span></label>' +
    _aeOrbitsRowHtml() +
    _aeHdRowHtml() +
    '<div class="ae-set-sep" aria-hidden="true"></div>' +
    '<h3 id="ae-set-title">' + _almEsc(_aeT('alm_earth_sat_setting')) + '</h3>' +
    '<div role="radiogroup" aria-labelledby="ae-set-title">';
  AE_SAT_MODES.forEach(function (mode) {
    var key = AE_SAT_MODE_KEY + mode;
    html += '<label class="ae-set-choice' + (editable ? '' : ' ae-off') + '">' +
      '<input type="radio" name="ae-sat-mode" value="' + mode + '"' +
        (m.mode === mode ? ' checked' : '') + (editable ? '' : ' disabled') + '>' +
      '<span><b>' + _almEsc(_aeT(key)) + '</b><small>' + _aeSetHint(key + '_hint') + '</small></span></label>';
  });
  html += '</div>';
  var why = _aeSettingsWhy(m);
  if (why) html += '<p class="ae-set-why">' + _almEsc(why) + '</p>';
  panel.innerHTML = html;
  var get = _aeById('ae-set-hd-get');
  if (get) get.onclick = _aeHdGet;
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
    var standing = _aeSatStanding((ms - s.epochMs) / MS_PER_DAY, s.iss, _aeClockRuns() || _ae.target === 'iss');
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
      var issLine = _aeOrbitShow('iss');
      S.issRing.material.opacity = (standing === 'approximate' ? AE_ISS_RING_FADED : AE_ISS_RING_ALPHA) * _aeFadeU.value * issLine;
      S.issRing.visible = issLine > 0;
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
    if (s.iss) alpha *= _aeIssAt(st, eqeq, standing);   // its dot gives way to the station itself, close up
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
  if (!issShown || !_ae.issPos) _aeIssAt(null);
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

// ── The ISS, close up ──
// iss-v1.bin (scripts/build_craft_models.py, from NASA 3D Resources' "International Space Station (ISS) (B)", NASA/Michael D.
// Carbajal, free and without copyright): fetched when the view first goes to the station or near it. Held the way the
// station flies (LVLH: the truss across the direction of travel, the Russian segment behind, the truss on the zenith
// side), its main solar arrays turned about the truss toward the Sun. Lit by the Sun (the arrays glint), by the Earth
// below in daylight, and dark in the Earth's shadow. Under AE_CRAFT_MODEL_PX across it is not drawn: the dot is.
var AE_ISS_URL = '/static/earth/iss-v1.bin';
var AE_ISS_SPAN_RE = 109 / 1000 / AE_EARTH_RADIUS_KM;     // the station's 109 m along its truss, in Earth radii
var AE_ISS_VIEW_DIR = [-0.42, -0.55, 0.72];                 // from it, in its own axes (nadir, forward, starboard): above, behind, to starboard; the Earth below to the horizon
var AE_ISS_EARTHSHINE = 0.3;                                // the day side below, as a light from the nadir
// Shading per class (structure, truss, turning array, radiator, fixed array): colour, specular strength, sharpness.
var AE_ISS_LOOK = [[[0.86, 0.85, 0.82], 0.25, 24], [[0.62, 0.62, 0.6], 0.3, 30], [[0.5, 0.34, 0.14], 1.8, 90],
  [[0.94, 0.94, 0.96], 0.15, 12], [[0.12, 0.15, 0.3], 1.2, 70]];
AE_TARGETS.iss = { min: AE_ISS_SPAN_RE * 0.9, max: 0.5, surface: AE_ISS_SPAN_RE / 2 };
// A mark for the flights' circles (and a tap on the model close up), never a name: its own label (ae-lbl-iss) has that.
AE_MARKED.push({ body: 'iss', flightOnly: true, name: function () { return _aeT('alm_earth_iss_short'); } });

// ── Spacecraft models ──
// The ISS (iss-v1.bin, "ZISS": five shading classes, its main arrays turning about the truss) and the probes
// (craft-<model>-v1.bin, "ZCRF": their materials' colours as a palette, the axis that points stored), all from NASA 3D
// Resources (free and without copyright) and built by scripts/build_craft_models.py. Each is fetched the first time
// the view goes to it or comes near, and drawn from AE_CRAFT_MODEL_PX across, its dot giving way to it.
var AE_CRAFT_PAL = 8;
// A gentle fill from the camera beside the Sun's key light: far out the Sun is a bright star, and a probe lit only by it
// read as a dim grey shape. The station keeps less, so the Earth's shadow still reads as night.
var AE_CRAFT_FILL = 0.3, AE_ISS_FILL = 0.08;                                       // palette entries a model may use
var AE_CRAFT_MODEL_PX = [6, 14];                            // the model fades in across these widths, the dot out
var AE_CRAFT_NEAR_MIN = 0.3 / 1000 / AE_EARTH_RADIUS_KM;    // 30 cm: a craft a few metres across, framed close
// A probe's table key and its model (one model for both Voyagers and both Pioneers); one without a model stays a dot.
var AE_CRAFT_MODEL = { voyager1: 'voyager', voyager2: 'voyager', pioneer10: 'pioneer', pioneer11: 'pioneer',
  parker: 'parker', juno: 'juno', jwst: 'webb', cassini: 'cassini', galileo: 'galileo' };
// What each points: its high-gain antenna at the Earth, or (Parker, Webb) its shield at the Sun.
var AE_CRAFT_POINTS = { parker: 'sun', webb: 'sun' };
var AE_CRAFT_VIEW_SPANS = 3;                                // a flight to a probe ends at least this many of its spans off
var AE_CRAFT_FIT_R = 0.6;                                   // and far enough that this share of its span fits the narrow side
var _aeCraft = {};                                          // model -> { data, loading }
// A flight to a craft starts at once, the model loading as it goes (its span is not known until it is here): planned for
// a craft this wide, then fitted to the model's own span, and held at the corner of its approach, the old place still in
// view, for a model that is late: at most AE_CRAFT_WAIT_MS, after which it arrives as planned.
var AE_CRAFT_PROVISIONAL_SPAN_RE = 15 / 1000 / AE_EARTH_RADIUS_KM;
var AE_CRAFT_WAIT_MS = 4000;
var AE_CRAFT_VERT = [
  'attribute float cls;',
  'varying vec3 vView;',
  'varying float vCls;',
  'void main() {',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  vView = mv.xyz; vCls = cls;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var AE_CRAFT_FRAG = [
  'uniform vec3 sunView;',
  'uniform vec3 nadirView;',
  'uniform float lit;',
  'uniform float earthLight;',
  'uniform float fade;',
  'uniform float fill;',
  'uniform vec3 albedo[' + AE_CRAFT_PAL + '];',
  'uniform vec3 shine[' + AE_CRAFT_PAL + '];',
  'varying vec3 vView;',
  'varying float vCls;',
  'void main() {',
  '  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));',   // flat: a spacecraft is panels, dishes and cylinders
  '  vec3 v = normalize(-vView);',
  '  if (dot(n, v) < 0.0) n = -n;',
  '  int k = int(vCls + 0.5);',
  '  vec3 a = albedo[0]; vec3 sp = shine[0];',
  '  for (int i = 1; i < ' + AE_CRAFT_PAL + '; i++) { if (i == k) { a = albedo[i]; sp = shine[i]; } }',
  '  float d = max(dot(n, sunView), 0.0) * lit;',
  '  vec3 h = normalize(sunView + v);',
  '  float s = sp.x * pow(max(dot(n, h), 0.0), sp.y) * lit * step(0.0, dot(n, sunView));',
  '  float e = max(dot(n, nadirView), 0.0) * earthLight;',
  '  vec3 lin = a * (d + e * vec3(0.55, 0.7, 1.0) + 0.02 + fill * max(dot(n, v), 0.0)) + vec3(s);',   // fill: from the camera, gentle
  '  gl_FragColor = vec4(sqrt(min(lin, vec3(1.0))), fade);',
  '}'
].join('\n');
function _aeCraftUrl(model) { return model === 'iss' ? AE_ISS_URL : '/static/earth/craft-' + model + '-v1.bin'; }
// Either format into one shape: positions centred on the box, a class (shading entry) per vertex, the look per class,
// metres per unit and the widest extent in units; the ISS's turning axis, or a probe's pointing and across axes.
function _aeCraftParse(buf) {
  var dv = new DataView(buf), f = function (o) { return dv.getFloat32(o, true); };
  var zcrf = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) === 'ZCRF';
  var lo = [f(12), f(16), f(20)], hi = [f(24), f(28), f(32)], mid = [0, 1, 2].map(function (k) { return (lo[k] + hi[k]) / 2; });
  var d = { metres: f(8), span: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) }, o;
  if (zcrf) {
    var np = dv.getUint32(60, true);
    d.aim = [f(36), f(40), f(44)]; d.across = [f(48), f(52), f(56)]; d.look = [];
    for (o = 64; d.look.length < np; o += 20) d.look.push([[f(o), f(o + 4), f(o + 8)], f(o + 12), f(o + 16)]);
  } else {
    d.axis = [f(36) - mid[0], f(40) - mid[1]]; d.span = hi[2] - lo[2]; d.look = AE_ISS_LOOK; o = 44;
  }
  var nv = dv.getUint32(o, true), nt = dv.getUint32(o + 4, true);
  var pos = new Float32Array(nv * 3), cls = new Float32Array(nv);
  o += 8;
  for (var i = 0; i < nv; i++, o += 8) {
    for (var k = 0; k < 3; k++) pos[i * 3 + k] = lo[k] + (dv.getInt16(o + 2 * k, true) + 32767) / 65534 * (hi[k] - lo[k]) - mid[k];
    cls[i] = dv.getUint8(o + 6);
  }
  d.pos = pos; d.cls = cls;
  d.idx = nv > 65535 ? new Uint32Array(buf.slice(o, o + nt * 12)) : new Uint16Array(buf.slice(o, o + nt * 6));
  return d;
}
// then: a flight waiting on the model (Go to a probe before its model is here), flown when it comes or fails.
function _aeCraftLoad(model, then) {
  var c = _aeCraft[model] = _aeCraft[model] || {};
  if (then) c.then = then;
  if (c.data || c.loading || typeof fetch !== 'function') return;
  c.loading = true;
  var done = function () { var t = c.then; c.then = null; if (t && _ae) t(); };
  fetch(_aeCraftUrl(model)).then(function (r) { if (!r.ok) throw new Error(model); return r.arrayBuffer(); }).then(function (buf) {
    c.data = _aeCraftParse(buf);
    if (_ae) { _ae.dirty = true; _aeKick(); }
    done();
  }).catch(function () { c.loading = false; c.failed = true; done(); });
}
function _aeCraftData(model) { return (_aeCraft[model] && _aeCraft[model].data) || null; }
// Its span in Earth radii, once loaded (0 before).
function _aeCraftSpanRe(model) { var d = _aeCraftData(model); return d ? d.span * d.metres / 1000 / AE_EARTH_RADIUS_KM : 0; }
function _aeCraftBuild(S, model) {
  var THREE = S.THREE, d = _aeCraftData(model);
  var position = new THREE.BufferAttribute(d.pos, 3), cls = new THREE.BufferAttribute(d.cls, 1);
  var geo = function (list) {
    var gg = new THREE.BufferGeometry();
    gg.setAttribute('position', position); gg.setAttribute('cls', cls);
    gg.setIndex(new THREE.BufferAttribute(d.pos.length / 3 > 65535 ? new Uint32Array(list) : new Uint16Array(list), 1));
    return gg;
  };
  var pal = [];
  for (var i = 0; i < AE_CRAFT_PAL; i++) pal.push(d.look[Math.min(i, d.look.length - 1)]);
  var uni = { sunView: { value: new THREE.Vector3(1, 0, 0) }, nadirView: { value: new THREE.Vector3(0, -1, 0) }, lit: { value: 1 },
    fill: { value: model === 'iss' ? AE_ISS_FILL : AE_CRAFT_FILL },
    earthLight: { value: 0 }, fade: { value: 1 },
    albedo: { value: pal.map(function (l) { return new THREE.Vector3(l[0][0], l[0][1], l[0][2]); }) },
    shine: { value: pal.map(function (l) { return new THREE.Vector3(l[1], l[2], 0); }) } };   // (the build has no Vector2)
  var mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_CRAFT_VERT, fragmentShader: AE_CRAFT_FRAG, transparent: true, side: THREE.DoubleSide });
  var root = new THREE.Group(), pivot = new THREE.Group(), body = [], turning = [];
  // The ISS's main arrays (class 2) turn about the truss to the Sun; a probe is one rigid body.
  for (var t = 0; t < d.idx.length; t += 3) (d.axis && d.cls[d.idx[t]] === 2 ? turning : body).push(d.idx[t], d.idx[t + 1], d.idx[t + 2]);
  var main = new THREE.Mesh(geo(body), mat);
  main.frustumCulled = false;
  root.add(main);
  if (d.axis) {
    var arr = new THREE.Mesh(geo(turning), mat);
    pivot.position.set(d.axis[0], d.axis[1], 0);
    arr.position.set(-d.axis[0], -d.axis[1], 0);
    arr.frustumCulled = false;
    pivot.add(arr);
    root.add(pivot);
  }
  var record = AE_CRAFT_RECORD[model] ? _aeRecordMesh(THREE, d, AE_CRAFT_RECORD[model], uni) : null;
  if (record) root.add(record);
  root.scale.setScalar(d.metres / 1000 / AE_EARTH_RADIUS_KM);
  root.visible = false;
  S.scene.add(root);
  return { root: root, pivot: pivot, uni: uni, model: model, record: record };
}
// Voyager's Golden Record where it is on the craft: on the face of the bus beside its plate, 30 cm across, facing out
// (+x in NASA's model; the plate is the white panel there, the record the gilded disc on it). Its face is the
// Almanac's own picture of the record's cover (static/golden-record/cover.jpg); a tap on it opens that section.
var AE_CRAFT_RECORD = { voyager: { at: [1.257, -1.95, -2.33], r: 0.155 } };   // metres in the model's frame
var AE_RECORD_IMG = '/static/golden-record/cover.jpg', AE_RECORD_IMG_R = 0.47;   // the disc's radius in the picture (of its width)
var AE_RECORD_VERT = [
  'varying vec2 vUv;',
  'void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
].join('\n');
var AE_RECORD_FRAG = [
  'uniform sampler2D map; uniform float mapped; uniform float lit; uniform float fill; uniform float fade;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec2 q = vUv - 0.5;',
  '  if (dot(q, q) > ' + (AE_RECORD_IMG_R * AE_RECORD_IMG_R).toFixed(4) + ') discard;',
  '  vec3 c = mapped > 0.5 ? texture2D(map, vUv).rgb : vec3(0.78, 0.58, 0.24);',   // gold until its picture is in
  '  gl_FragColor = vec4(min(c * 1.3, vec3(1.0)) * min(1.0, 0.35 + 0.65 * lit + fill), fade);',
  '}'
].join('\n');
function _aeRecordMesh(THREE, d, rec, craftUni) {
  var u = 1 / d.metres, half = rec.r / AE_RECORD_IMG_R * 0.5 * u, c = rec.at.map(function (x) { return x * u; });
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    c[0], c[1] - half, c[2] - half, c[0], c[1] + half, c[2] - half, c[0], c[1] + half, c[2] + half, c[0], c[1] - half, c[2] + half]), 3));
  gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  gg.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  var uni = { map: { value: null }, mapped: { value: 0 }, lit: craftUni.lit, fill: craftUni.fill, fade: craftUni.fade };
  var mesh = new THREE.Mesh(gg, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_RECORD_VERT, fragmentShader: AE_RECORD_FRAG, transparent: true, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.userData.at = c; mesh.userData.metres = rec.r;
  _aeLoadTexture(THREE, AE_RECORD_IMG).then(function (tx) { uni.map.value = tx; uni.mapped.value = 1; if (_ae) { _ae.dirty = true; _aeKick(); } }).catch(function () {});
  return mesh;
}
// A tap on Voyager's record (drawn as itself, close up): the Almanac's Golden Record. True when it took the tap.
var AE_RECORD_TAP_PX = 22;
function _aeRecordTap(x, y) {
  var S = _ae.gl, I = S && S.crafts && S.crafts[_ae.target];
  if (!I || !I.record || !I.root.visible || typeof window._scrollToGoldenRecord !== 'function') return false;
  var c = I.record.userData.at, w = new S.THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(I.root.matrixWorld);
  var p = [w.x, w.y, w.z], s = _aeProject(p);
  if (!s) return false;
  var cam = S.camera, pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  var rPx = I.record.userData.metres / 1000 / AE_EARTH_RADIUS_KM / Math.max(1e-12, _aeLen(_aeSub(p, [cam.position.x, cam.position.y, cam.position.z]))) * pxPerRad;
  if (Math.hypot(s.x - x, s.y - y) > Math.max(rPx, AE_RECORD_TAP_PX)) return false;
  _aeClose();
  window._scrollToGoldenRecord();
  return true;
}
// A model's light: the Sun (dark in the Earth's shadow), and the Earth's day side below when it flies over it (nadir),
// both turned into the camera's frame for the shader.
function _aeCraftLight(I, pos, nadir, show) {
  var cam = _ae.gl.camera, sun = _aeNorm(_aeSub(_aeSunShown(_ae.scene), pos));
  var along = _aeDot(pos, sun), perp = _aeLen(_aeSub(pos, _aeScale(sun, along)));
  I.uni.lit.value = along > 0 || !nadir ? 1 : _smoothstep(0.995, 1.005, perp);
  I.uni.earthLight.value = nadir ? AE_ISS_EARTHSHINE * _aeClamp(0.5 + 0.5 * _aeDot(_aeNorm(pos), sun), 0, 1) : 0;
  I.uni.fade.value = show * _aeFadeU.value;
  I.root.updateMatrixWorld();
  var vInv = cam.matrixWorldInverse.elements;
  var toView = function (u, out) { out.set(vInv[0] * u[0] + vInv[4] * u[1] + vInv[8] * u[2], vInv[1] * u[0] + vInv[5] * u[1] + vInv[9] * u[2], vInv[2] * u[0] + vInv[6] * u[1] + vInv[10] * u[2]).normalize(); };
  toView(sun, I.uni.sunView.value);
  toView(nadir || sun, I.uni.nadirView.value);
}
// How wide a craft of span (Earth radii) at pos stands on screen, in CSS px.
function _aeCraftPx(span, pos) {
  var cam = _ae.gl.camera, dist = _aeLen(_aeSub([cam.position.x, cam.position.y, cam.position.z], pos));
  return span / Math.max(dist, 1e-12) * (_ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2));
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
  for (var key in AE_CRAFT_MODEL) _aeProbeCraftAt(key, _aeProbePos[key] || null);
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
  var goal = AE_CRAFT_POINTS[model] === 'sun' ? _aeSunShown(_ae.scene) : [0, 0, 0];
  var jd = _ae.scene.ms / MS_PER_DAY + JD_UNIX_EPOCH, to = _aeNorm(_aeSub(goal, pos));
  var north = typeof _ephEclJ2000ToEqOfDate === 'function' ? _ephEclJ2000ToEqOfDate([0, 0, 1], jd + _aeDeltaTDays(jd)) : [0, 0, 1];
  var side = _aeCross(to, north);
  if (_aeLen(side) < 1e-6) side = _aeCross(to, [1, 0, 0]);
  side = _aeNorm(side);
  // Model axes (aim, across, aim x across) onto world (to, side, to x side).
  var mA = new S.THREE.Matrix4().makeBasis(new V(d.aim[0], d.aim[1], d.aim[2]), new V(d.across[0], d.across[1], d.across[2]),
    new V(d.aim[0], d.aim[1], d.aim[2]).cross(new V(d.across[0], d.across[1], d.across[2])));
  var third = _aeCross(to, side);
  var mW = new S.THREE.Matrix4().makeBasis(new V(to[0], to[1], to[2]), new V(side[0], side[1], side[2]), new V(third[0], third[1], third[2]));
  I.root.quaternion.setFromRotationMatrix(mW.multiply(mA.transpose()));
  _aeCraftLight(I, pos, null, show);
  return 1 - show;
}
// The station's place and attitude now, from its SGP4 state; null hides it. Returns how much of its dot to draw.
function _aeIssAt(st, eqeq, standing) {
  var S = _ae.gl;
  if (!st) {
    _ae.issPos = _ae.issBasis = null;
    if (S.iss) S.iss.root.visible = false;
    return 1;
  }
  var pos = st.pos, vel = _aeRotZ([st.velKmS.x, st.velKmS.y, st.velKmS.z], eqeq);
  var nadir = _aeNorm(_aeScale(pos, -1)), fwd = _aeNorm(_aeSub(vel, _aeScale(nadir, _aeDot(vel, nadir)))), star = _aeCross(nadir, fwd);
  var prev = _ae.issBasis;
  _ae.issPos = pos; _ae.issBasis = [nadir, fwd, star];
  // Close by, the camera rides along with the station (its place in the station's own axes held), so the Earth stays
  // below it as it goes round; a drag turns about it as anywhere else.
  if (prev && _ae.target === 'iss' && !_ae.fly) {
    var off = _aeCameraOffset(_ae.az, _ae.el_, 1), loc = [_aeDot(off, prev[0]), _aeDot(off, prev[1]), _aeDot(off, prev[2])];
    var azel = _aeAzElOf(_aeAdd(_aeAdd(_aeScale(nadir, loc[0]), _aeScale(fwd, loc[1])), _aeScale(star, loc[2])));
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

function _aeUpdate(ms) {
  var S = _ae.gl;
  var sc = _aeSceneAt(ms);
  _ae.scene = sc;
  S.earth.rotation.z = sc.gast;
  S.shared.sunPos.value.set(sc.sun[0], sc.sun[1], sc.sun[2]);
  S.earthUni.moonPos.value.set(sc.moon[0], sc.moon[1], sc.moon[2]);
  S.earthUni.dim.value = _aeRedOn() ? AE_RED_EARTH_LIGHT : 1;
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
  // The planets and probes before the camera: a probe framed from tens of metres moves hundreds in a frame (Voyager
  // 17 km/s), so the camera is placed on where it is now, not where it was (their sizes on screen use the last frame's
  // camera, which is near enough).
  _aeUpdatePlanets(sc);
  _aePlaceCamera();
  _aePlaceCrafts();
  _aeDrawAxes(S, sc);
}

function _aeResize() {
  if (!_ae || !_ae.gl) return;
  var el = _ae.el, S = _ae.gl;
  var w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  // Kept for the per-frame projections: reading clientWidth there, after the
  // labels' style writes, forced a layout for every label, every frame.
  _ae.w = w; _ae.h = h;
  var foot = el.querySelector ? el.querySelector('.ae-bottom') : null;
  _ae.footPx = foot ? foot.offsetHeight : 0;
  _aeMeasureTop();
  if (!_ae.infoShift) _ae.infoShift = _aeInfoShiftTarget();
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
  if (body === t || !tg || t === 'iss' || _aeIsProbe(t)) return false;
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
  var cam = _ae.gl.camera, c = cam.position, eye = [c.x, c.y, c.z], d = _aeLen(_aeSub(p, eye));
  var pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2), sp = marks ? _aeProject(p) : null;
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
  return key === 'moon' || key === 'iss' ? 'earth' : key;
}
// Close in, the body in view fills the picture: only it and its own are named (a far planet's dot in the corner
// read as something on its surface).
var AE_CLOSE_FILL = 1;   // the body in view this many screen widths across (the narrower side) is close in
function _aeCloseIn(eye, pxPerRad) {
  var t = _ae.target, tg = AE_TARGETS[t];
  if (!tg || t === 'iss' || _aeIsProbe(t)) return false;
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
  _aePlaceLabel('ae-lbl-you', you, !!you && _aeFacing(you) && _ae.target === 'earth');
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
  var cam = _ae.gl.camera, d = Math.max(1e-9, _aeLen([cam.position.x, cam.position.y, cam.position.z]));
  return 2 / d * _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
}
// The controls at the top (the way back, the date and Live, the gear, the minimap): boxes in the view's own px, kept with
// the foot's height, so no mark or name sits under them.
var AE_TOP_CONTROLS = ['ae-gear', 'ae-locate', 'ae-mini', 'ae-hint'], AE_TOP_CLEAR_PX = 10;   // the hint too while it shows: no mark under its words
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
  var cam = _ae.gl.camera, eye = [cam.position.x, cam.position.y, cam.position.z];
  var pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  var pos = {}, shown = [];
  AE_MARKED.forEach(function (m) { pos[m.body] = _aeBodyPos(m.body, sc); });
  // The destination first, so a body standing on top of it (the Moon from the Sun) gives way.
  var f = _ae.fly, flying = !!f && f.hold, source = flying ? f.from.target : null;
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
    if (!s || crowded || alpha <= 0 || s.x < -reach || s.y < -reach || s.x > _ae.w + reach || s.y > (ringed ? _ae.h + reach : foot) || (!ringed && _aeUnderTop(s))) { if (!el.hidden) el.hidden = true; continue; }
    if (away) alpha *= AE_MARK_AWAY_ALPHA;
    shown.push({ x: s.x, y: s.y, r: r, el: el, ringed: ringed, body: body });
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
  var cam = _ae.gl.camera, pxPerRad = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
  var d = _aeLen(_aeSub(_aeSunShown(_ae.scene), [cam.position.x, cam.position.y, cam.position.z]));
  return AE_SUN_SHOW_R / Math.max(1e-9, d) * pxPerRad < _aeMarkDiscR('sun');
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
    g.globalAlpha = m.el.classList && m.el.classList.contains('ae-bm-quiet') ? Math.min(1, parseFloat(m.el.style.opacity) || 1) : 1;   // faint: away from home
    m.pts.forEach(function (q) {
      var x = q.x * dpr, y = q.y * dpr, r = _aeMarkDiscR(q.body) * dpr, b = _aePlanetBody(q.body);
      if (!isFinite(x) || !isFinite(y)) return;
      if (q.body === 'sun') return;   // the view's own, or painted below in the Planets view
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
// Whether the leader from a dot to its name passes clear of every other body (a line through Venus read as Venus's).
var AE_LEADER_CLEAR_PX = 10;
function _aeLeaderClear(m, box, rings) {
  var e = _aeLeaderEnd(m, box), dx = e[0] - m.x, dy = e[1] - m.y, len2 = dx * dx + dy * dy || 1;
  return rings.every(function (rb) {
    if (rb.x === m.x && rb.y === m.y) return true;
    var t = Math.min(1, Math.max(0, ((rb.x - m.x) * dx + (rb.y - m.y) * dy) / len2));
    return Math.hypot(m.x + t * dx - rb.x, m.y + t * dy - rb.y) > AE_LEADER_CLEAR_PX;
  });
}
// The point of a name's box nearest the dot: where its leader ends.
function _aeLeaderEnd(m, box) { return [Math.min(Math.max(m.x, box[0]), box[2]), Math.min(Math.max(m.y, box[1]), box[3])]; }
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
      rings.push({ i: i, own: q === m, box: [q.x - r, q.y - r, q.x + r, q.y + r], x: q.x, y: q.y });
    });
  });
  // In the Planets view the Sun's disc is drawn on the planets' scale: no name on it either.
  var sunAt = _aeSunAsMark() && _ae.scene ? _aeProject(_aeSunShown(_ae.scene)) : null;
  if (sunAt) { var sr = _aeMarkDiscR('sun') + AE_MARK_NAME_PAD; rings.push({ i: -1, own: false, box: [sunAt.x - sr, sunAt.y - sr, sunAt.x + sr, sunAt.y + sr], x: sunAt.x, y: sunAt.y }); }
  var names = [];
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
    var w = el._aeNameW || 0, out = m.x > _ae.w / 2 ? 'l' : 'r', inn = out === 'l' ? 'r' : 'l';
    var sides = m.ringed ? ['t'] : AE_NAME_SIDES.map(function (sd) { return sd.replace('out', out).replace('in', inn); });
    var wideNamed = !m.ringed && _aeWideView() && _aeNamedPlanet(m.body), chosen = null;
    var slots = _aeNameSlots(m, w, sides, wideNamed);
    var onScreen = function (box) { return box[0] >= AE_NAME_EDGE && box[2] <= _ae.w - AE_NAME_EDGE && box[1] >= 0 && box[3] <= _ae.h; };
    var onName = function (box) { return names.some(function (n) { return _aeBoxesMeet(n, box); }); };
    var onDisc = function (box) { return rings.some(function (rb) { return !(rb.i === i && rb.own) && _aeBoxesMeet(rb.box, box); }); };
    var tie = wideNamed ? AE_NAME_TIE_WIDE_PX : AE_NAME_TIE_PX;
    // Never across the screen's edge: a name that would be is tried on the inward side, then above and below.
    var passes = m.ringed ? [function () { return true; }] : [
      function (t) { return !t.leader && onScreen(t.box) && !onName(t.box) && !onDisc(t.box) && _aeNameIsItsOwn(t.box, m, rings, tie, wideNamed ? AE_NAME_TIE_WIDE_RATIO : 1); },
      function (t) { return wideNamed && t.leader && onScreen(t.box) && !onName(t.box) && !onDisc(t.box) && _aeLeaderClear(m, t.box, rings); },
      // Two dots close together (Venus beside the Earth near conjunction): a leader that grazes the other is still drawn
      // from its own dot, where a name merely beside it would read as the nearer one's.
      function (t) { return wideNamed && t.leader && onScreen(t.box) && !onName(t.box) && !onDisc(t.box); },
      function (t) { return wideNamed && !t.leader && onScreen(t.box) && !onName(t.box); },
      function (t) { return wideNamed && onScreen(t.box) && !onName(t.box); },
      function () { return wideNamed; }
    ];
    for (var pi = 0; pi < passes.length && !chosen; pi++) chosen = slots.filter(passes[pi])[0] || null;
    if (m.ringed && !chosen) chosen = slots[0];
    if (chosen) names.push(chosen.box);
    var far = !!chosen && chosen.leader;
    if (far) {
      var end = _aeLeaderEnd(m, chosen.box), lx = end[0] - m.x, ly = end[1] - m.y, ll = Math.hypot(lx, ly) || 1;
      m.leader = [m.x + lx / ll * (m.r - AE_MARK_NAME_PAD), m.y + ly / ll * (m.r - AE_MARK_NAME_PAD), end[0], end[1]];
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
  if (best && _ae.sats.list[best.idx].iss && _ae.issBasis) { _aePreset('iss'); return; }
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
  if (_ae.selected) { _ae.selected = null; _aeRenderCard(); _ae.dirty = true; _aeKick(); return; }
  // The one in view, its model or its disc, tapped: its card (put away with ×, or by flying elsewhere).
  if (body && _ae.arrived !== body) _aeArrive(body);
}
// On a mouse, something to tap shows a hand: the craft's model as much as its little circle.
function _aeHover(e) {
  var canvas = _aeById('ae-canvas');
  if (!canvas || e.pointerType !== 'mouse' || _ae.drag || _ae.fly) return;
  var r = canvas.getBoundingClientRect(), on = !!_aeBodyAt(e.clientX - r.left, e.clientY - r.top);
  if (canvas.style.cursor !== (on ? 'pointer' : '')) canvas.style.cursor = on ? 'pointer' : '';
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
  // The ISS only where it is big enough to be drawn as itself (from afar its dot is the satellites' to pick, and from
  // the Sun it stood on the Earth and took the Earth's taps): its size from this camera, not the last frame's.
  var issDrawn = !!_ae.issPos && AE_ISS_SPAN_RE / Math.max(1e-12, _aeLen(_aeSub(_ae.issPos, eye))) * pxPerRad >= AE_CRAFT_MODEL_PX[0];
  // The Planets view: a moon sits on its planet at that scale and is not a target; a tap there is the planet's.
  var wide = _aeWideView();
  var bodies = AE_MARKED.filter(function (m) { var b = _aePlanetBody(m.body); return (!m.flightOnly || issDrawn) && !(wide && b && b.parent); })
    .map(function (m) { return [m.body, _aeBodyPos(m.body, sc), AE_TARGETS[m.body].surface]; })
    .filter(function (b) { return !!b[1]; });
  var best = null, bestD = Infinity, bestRank = Infinity;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i];
    if (b[0] !== 'earth' && _aeBehindEarth(b[1])) continue;
    var s = _aeProject(b[1]);
    if (!s) continue;
    var d = _aeLen(_aeSub(b[1], eye));
    var reach = Math.max(b[2] / d * pxPerRad, AE_TAP_BODY_PX);
    if (Math.hypot(s.x - x, s.y - y) > reach) continue;
    // A planet wins over anything else under the same finger; then the nearest.
    var rank = _aeIsPlanet(b[0]) && !_aePlanetBody(b[0]).parent ? 0 : 1;
    if (best === null || rank < bestRank || (rank === bestRank && d < bestD)) { bestD = d; best = b[0]; bestRank = rank; }
  }
  return best;
}

// ── The card for a tapped satellite ──
function _aeRenderCard() {
  _aeRenderCardBody();
  var card = _aeById('ae-card'), view = _aeById('ae-view');
  if (card && view && view.classList) view.classList.toggle('ae-carded', !card.hidden);
  _aeSyncInfo();
  _aeMarkInfoBtn();
}
// The i in the corner: there while the view is at a place that has a sheet, pressed while the sheet is up.
function _aeMarkInfoBtn() {
  var b = _aeById('ae-info-btn'), k = _ae && _ae.arrived;
  if (!b) return;
  var on = !!k && _aeHasFacts(k) && (!_aeIsProbe(k) || !!_aeTracks);
  if (b.hidden === on) b.hidden = !on;
  b.setAttribute('aria-expanded', String(!!_ae.info));
}
function _aeRenderCardBody() {
  var card = _aeById('ae-card');
  if (!card) return;
  var s = _aeSelectedSat();
  if (!s && _ae.place) { _aeRenderPlaceCard(card); return; }
  if (!s && _ae.lm) { _aeRenderLmCard(card); return; }
  if (!s) { _ae.selected = null; card.hidden = true; card.innerHTML = ''; return; }
  _ae.lm = null;
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
  var parts = [], dated = '', stale = false, sats = _ae.sats;
  // What the satellites' data is like is said where satellites are drawn: the Earth (and its Satellites view) and the
  // ISS. At Saturn or Voyager it was a line about something not on the screen. The gear keeps the data's date anywhere.
  var aboutSats = _ae.target === 'earth' || _ae.target === 'iss';
  if (sats && sats.list.length) {
    var newest = 0, anyShown = false, issOrbit = null;
    sats.list.forEach(function (s) {
      newest = Math.max(newest, s.epochMs);
      if (s.standing && s.standing !== 'none') anyShown = true;
      if (s.iss && s.standing === 'orbit') issOrbit = s;
    });
    // The data's date is in the gear (with Get fresh data); the line under the controls says only that it may be out
    // of date.
    if (anyShown) dated = _aeT('alm_earth_sat_data_from', { date: _aeFmtDate(newest) });
    else if (aboutSats) parts.push(_aeT('alm_earth_no_sat_data'));
    stale = aboutSats && anyShown && !!(_ae.satMeta && _ae.satMeta.stale);
    if (stale) parts.push(_aeT('alm_earth_data_stale'));
    if (aboutSats && issOrbit) parts.push(_aeT('alm_earth_iss_orbit_only', { date: _aeFmtDate(issOrbit.epochMs) }));
  } else if (aboutSats && sats) {
    parts.push(_aeT('alm_earth_no_orbital_data'));
  } else if (aboutSats && _ae.satsFailed) {
    parts.push(_aeT('alm_earth_sats_unavailable'));
  }
  var S = _ae.gl;
  if (S && (S.mapFailed[AE_TEX_NIGHT] || S.mapFailed[AE_TEX_MOON])) parts.push(_aeT('alm_earth_maps_failed'));
  parts.push(_aeT('alm_earth_credit'));
  var sss = _aePlanetCredit();
  if (sss) parts.push(sss);
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
  _aeShowMapHere();
  var foot = _ae.el && _ae.el.querySelector ? _ae.el.querySelector('.ae-bottom') : null;
  if (foot) _ae.footPx = foot.offsetHeight;   // the controls' height changes with their notes; marks keep above them
  _aeMeasureTop();
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
    var onSun = _ae.target === 'sun' && _ae.preset !== 'planets';   // the overview is about the planets, not the Sun's spots
    if (sunNote.hidden === onSun) sunNote.hidden = !onSun;
    if (onSun) {
      var yr = _aeDecimalYear(ms), cyc = _aeCycleIndex(yr) + 1;
      _aeSetText(sunNote, _aeT(cyc >= 1 ? 'alm_earth_sun_spots' : 'alm_earth_sun_spots_old',
        { n: _orrNum(Math.round(_aeSunspotNumber(yr).r), null, 0), c: _orrNum(cyc, null, 0) }));
    }
  }
  // Out among the planets, said once and quietly: their directions are true, their distances squeezed.
  var scale = _aeById('ae-scale');
  if (scale) {
    var squeezed = _ae.preset === 'planets';   // near a body the minimap says it
    if (scale.hidden === squeezed) scale.hidden = !squeezed;
  }
  var note = _aeNoteParts();
  _aeRenderAsk(note.ask);
  _aeSetText(_aeById('ae-note'), note.note);
  _aeRenderNoteFresh(note.stale);
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
// Renders every frame while something moves (a drag, a flight, a faster
// clock), otherwise a few times a second: at real time the fastest thing on
// screen, the ISS, crosses a pixel in several seconds.
function _aeKick() {
  if (!_aeIsOpen) return;
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  if (!_ae.raf) _ae.raf = requestAnimationFrame(_aeFrame);
}
function _aeBusy() {
  var fading = !!_ae.orbitFly && !!_ae.orbitFly.endAt && performance.now() - _ae.orbitFly.endAt < AE_ORBITS_FADE_MS;   // orbits going out
  return !!(_ae.fly || _ae.drag || _ae.pinch || _ae.hand || fading);
}
// Draw the scene at the clock's instant when something changed, something
// moves, or the idle interval has passed.
function _aeDraw(now, busy) {
  if (!_ae.gl || !(_ae.dirty || busy || now - _ae.lastRender >= AE_IDLE_RENDER_MS)) return;
  if (_ae.spin) {   // Planets side by side: its own scene, nothing of the main one moves
    _aeSpinDraw();
    _ae.lastRender = now;
    _ae.dirty = false;
    return;
  }
  _aeUpdate(_aeDisplayMs());
  if (_ae.gl.hd) _aeHdUpdate(_ae.gl);
  _ae.gl.renderer.render(_ae.gl.scene, _ae.gl.camera);
  _aeDrawMini();
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
  var handDone = _aeStepHand(now);
  var shifting = _aeStepInfoShift(dt);
  var busy = _aeStepFly(now) || _aeBusy() || !!handDone || shifting;
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
  if (_ae.preset !== 'planets') _ae.preset = null;   // closer or farther from a body is still that body (_aeMarkViews); the planets stay the planets
  _aeMarkViews();
  _ae.dirty = true;
  _aeKick();
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
  if (!_aeIsOpen || !_ae.gl) { _aeWaitDrag(dx, dy); return; }
  _aeDragBy(dx, dy);
}
// The view is not up yet (its parts are still being made): the disc follows the finger at once, in 2D, and the
// drag so far is kept to turn the Moon by when the view lifts it. Shown as the disc leaning toward the finger.
var AE_WAIT_DRAG_LEAN = 0.35, AE_WAIT_DRAG_MAX_PX = 48;
var _aeWaitDragPx = null;
function _aeWaitDrag(dx, dy) {
  // No view is coming (no WebGL here): nothing would let the disc go again.
  if (_ae && _ae.failed) return;
  var hero = document.querySelector(AE_HERO_SEL);
  if (!hero) return;
  var p = _aeWaitDragPx || (_aeWaitDragPx = { x: 0, y: 0 });
  p.x += dx; p.y += dy;
  var lean = function (v) { return _aeClamp(v * AE_WAIT_DRAG_LEAN, -AE_WAIT_DRAG_MAX_PX, AE_WAIT_DRAG_MAX_PX); };
  hero.style.transition = 'none';
  hero.style.transform = 'translate(' + lean(p.x).toFixed(1) + 'px,' + lean(p.y).toFixed(1) + 'px)';
}
// The disc is let go (before the view lifts it, which reads where it stands); returns the drag kept, if any.
function _aeWaitDragRelease() {
  var p = _aeWaitDragPx;
  _aeWaitDragPx = null;
  var hero = document.querySelector(AE_HERO_SEL);
  if (hero) { hero.style.transition = ''; hero.style.transform = ''; }
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
    if (_ae.spin) return;                       // side by side: nothing to turn
    _aeHideHint();                              // and the hint has done its job
    canvas.setPointerCapture(e.pointerId);
    _ae.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(_ae.pointers);
    if (ids.length === 1) {
      // A right or shift drag with a mouse slides the view as two fingers do (never a tap).
      var slide = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey);
      _ae.drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: slide, pan: slide };
    } else if (ids.length === 2) {
      var a = _ae.pointers[ids[0]], b = _ae.pointers[ids[1]];
      _ae.pinch = { span: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      _ae.drag = null;
    }
    canvas.classList.add('ae-dragging');
    _aeKick();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!_ae.pointers[e.pointerId]) { if (!_ae.spin) _aeHover(e); return; }
    _ae.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(_ae.pointers);
    if (_ae.pinch && ids.length >= 2) {
      var a = _ae.pointers[ids[0]], b = _ae.pointers[ids[1]];
      var span = Math.hypot(a.x - b.x, a.y - b.y);
      if (span > 0 && _ae.pinch.span > 0) _aeZoomBy(_ae.pinch.span / span);
      _ae.pinch.span = span;
      // The midpoint slides the view, whether or not the fingers also spread or close.
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      _aePanBy(mx - _ae.pinch.mx, my - _ae.pinch.my);
      _ae.pinch.mx = mx; _ae.pinch.my = my;
    } else if (_ae.drag) {
      var dx = e.clientX - _ae.drag.x, dy = e.clientY - _ae.drag.y;
      _ae.drag.x = e.clientX; _ae.drag.y = e.clientY;
      if (Math.hypot(e.clientX - _ae.drag.x0, e.clientY - _ae.drag.y0) > AE_TAP_SLOP_PX) _ae.drag.moved = true;
      if (_ae.drag.pan) _aePanBy(dx, dy);
      else _aeDragBy(dx, dy);
    }
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
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
    if (!_ae.spin) _aeZoomBy(Math.exp(e.deltaY * AE_WHEEL_ZOOM));
  }, { passive: false });
}
function _aeBindKeys() {
  _ae.el.addEventListener('keydown', function (e) {
    // Escape shuts the gear's panel first, then leaves this view only; the
    // Almanac underneath stays open.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (_aeFullOn()) { _aeFullExit(); return; }
      if (_ae.info) { _aeCloseInfo(true); return; }
      if (_ae.setOpen) { _aeShowSettings(false); _aeById('ae-gear').focus({ preventScroll: true }); return; }
      _ae.closedByKey = true;
      _aeClose();
      return;
    }
    if (e.target !== _aeById('ae-canvas') || _ae.spin) return;   // side by side has no camera to move
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
  _ae.ringsAt = _ae.issRingAt = _ae.moonPathAt = null;
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

function _aeBindControls() {
  // A press outside the settings puts them away (the gear is its own toggle).
  if (typeof _almDismissable === 'function') {
    _almDismissable('ae-set', function () { _aeShowSettings(false); },
      function (target) { return !!target.closest && !!target.closest('#ae-gear'); }, 'ae-gear');
  }
  _aeById('ae-views').onclick = function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ae-view]') : null;
    var k = b && b.getAttribute('data-ae-view');
    if (!k) return;
    if (k === AE_ROW_LANDINGS) { _aeShowGo(true, 'alm_go_landings'); return; }
    _aePreset(k === AE_SPIN_KEY && _ae.spin ? 'planets' : k);   // Side by side again: back to the planets
  };
  _aeById('ae-go-btn').onclick = function () { _aeShowGo(_aeById('ae-go').hidden); };
  _aeById('ae-go').onclick = function (e) {
    var pl = e.target && e.target.closest ? e.target.closest('[data-ae-place]') : null;
    if (pl) { _aePlacePick(_ae.placeFound[+pl.getAttribute('data-ae-place')]); return; }
    var b = e.target && e.target.closest ? e.target.closest('[data-ae-go]') : null;
    if (!b) return;
    _aeShowGo(false);
    var key = b.getAttribute('data-ae-go'), lmRow = _aeGoLmRow(key);
    if (lmRow) { _aeLmOpen(lmRow.body, lmRow.row); _aeLmFly(lmRow.body, lmRow.row); return; }
    _aePreset(key);
  };
  if (typeof _almDismissable === 'function') {
    _almDismissable('ae-go', function () { _aeShowGo(false); },
      function (target) { return !!target.closest && !!target.closest('#ae-go-btn'); }, 'ae-go-btn');
  }
  // The person's own speed (the foot's slider): leaving the Planets view leaves the date where it ran to.
  _aeById('ae-clock').addEventListener('pointerdown', function () { if (_ae.spin) _ae.spin.autoRun = false; });
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
  _aeById('ae-locate').onclick = _aeLocateMe;
  _aeById('ae-info-btn').onclick = function () { if (_ae.info) _aeCloseInfo(false); else _aeOpenInfo(_ae.arrived); };
  _aeById('ae-gear').onclick = function () { _aeShowSettings(!_ae.setOpen); };
  _aeById('ae-fresh').onclick = _aeGetFresh;
  _aeById('ae-note-fresh').onclick = _aeGetFresh;
  _aeById('ae-hd-get').onclick = _aeHdGet;
  _aeById('ae-map').onclick = _aeOpenMapHere;
  _aeById('ae-mini').onclick = function () { _aePreset('planets'); };
  _aeById('ae-hd-later').onclick = _aeHdNotNow;
  // The panel's radios are drawn afresh with each answer: one listener.
  _aeById('ae-set').onchange = function (e) {
    var input = e && e.target;
    if (input && input.name === 'ae-sat-mode') _aeSetMode(input.value);
    if (input && input.name === 'ae-lm-layer') _aeLmSetLayer(input.checked);
    if (input && input.name === 'ae-orbits') _aeSetOrbits(input.value);
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

// ── Ready, when the Moon is touched ──
// three.js, the scene and its maps are made ready as soon as someone points at or touches the hero (or opens the
// view), so a tap on the Moon swaps it for this one in the same frame. Not behind the page: a page that is only looked
// at never loads them (almanac.js _almMoonPrepare). Ready means a context with its shaders compiled and its maps
// uploaded, drawing to a single pixel until the view opens.
var _aePreparing = null;
function _aeEnsure() {
  if (_ae) return true;
  _aeEnsureStyles();
  var el = _aeBuildDom();
  if (!el) return false;
  _ae = _aeNewState(el);
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
    return slice(function () { S.renderer.render(S.scene, S.camera); });
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
}

function _aeHideHint() {
  var hint = _aeById('ae-hint');
  if (hint) hint.classList.remove('ae-show');
  clearTimeout(_ae.hintTimer);
  _aeMeasureTop();
}
// A line over the controls, for a moment (where you are could not be found).
function _aeShowHint(text) {
  var hint = _aeById('ae-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.add('ae-show');
  _aeMeasureTop();
  clearTimeout(_ae.hintTimer);
  _ae.hintTimer = setTimeout(_aeHideHint, AE_HINT_MS);
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
  _aePrepare(true).then(function () {
    if (hero) hero.classList.remove('alm-moon-waking');
    var kept = _aeWaitDragRelease();
    if (!_ae.wanted) return;
    _ae.wanted = false;
    if (_aeIsOpen || (typeof _almanacOpen !== 'undefined' && !_almanacOpen)) return;
    _aeShow(true);
    // What the finger did while the view was being made turns the Moon now it is up.
    if (kept && _aeIsOpen && _ae.gl) _aeDragBy(kept.x, kept.y);
  });
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
  if (_aeFullStepped && !(e.state && e.state.aeFull)) { _aeFullStepped = false; _aeFullExit(false); return true; }
  if (_aeStepped && !(e.state && e.state.aeView)) {
    _aeStepped = false;
    if (_aeIsOpen) _aeClose();
    return true;
  }
  return false;
}
window._aeStepPop = _aeStepPop;
function _aeShow(fromHero) {
  _aeStepIn();
  // From the orrery, its chosen moment; from the hero or the sky, the moment
  // they show.
  _aeIsOpen = true;
  _ae.fromHero = fromHero;
  _ae.el.classList.add('open');
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
  _aeLoadSats();
  if (_aeReady()) { _aeLoadMaps(_ae.gl); _aeResize(); _aeEnter(); _aeKick(); return; }
  _aeCoverAlmanac(true);
  if (_ae.failed) { _aeMessage(_aeT('alm_earth_nogl')); return; }
  _aeMessage(_aeT('alm_earth_loading'));
  _aePrepare(true).then(function (ok) {
    if (!_aeIsOpen) return;
    if (!ok) {
      // "Reconnect" only when the device is offline; connected, the files did not load, and the way on is to try again.
      _aeMessage(_aeT(_ae.failed ? 'alm_earth_nogl' : navigator.onLine === false ? 'alm_earth_unavailable' : 'alm_earth_failed'));
      return;
    }
    _aeMessage('');
    _aeResize();
    _aeEnter();
    _aeKick();
  });
}

// Close: back into the hero when the view came from it and it is there to
// go back to, else at once. The page has the view's moment first, so the
// hero it lands in shows it.
// Where the header's arrow goes back to: the Almanac's page (the hero, the sky) or its solar system (the orrery).
function _aeBackLabel() { return _aeT(_aeFrom === 'orrery' ? 'alm_solar_system' : 'almanac'); }
function _aeClose() {
  if (!_aeIsOpen || (_ae.hand && _ae.hand.dir < 0)) return;
  _aeLeaveSpin();
  var frame = _ae.fromHero && _aeReady() && !_ae.el.classList.contains('ae-blank') &&
    (typeof _almanacOpen === 'undefined' || _almanacOpen) ? _aeHeroFrame() : null;
  if (frame) _aeHandOut(frame);
  else _aeFinishClose();
}
function _aeFinishClose() {
  if (!_aeIsOpen) return;
  _aeLeaveSpin();
  _aeIsOpen = false;
  if (typeof updateTopbar === 'function') updateTopbar();   // the header's arrow is the Almanac's own again
  if (typeof _almClockUncover === 'function') _almClockUncover();   // the page lands on the moment the clock reached
  _aeStepOut();
  if (_ae.raf) { cancelAnimationFrame(_ae.raf); _ae.raf = 0; }
  if (_ae.idleTimer) { clearTimeout(_ae.idleTimer); _ae.idleTimer = 0; }
  _ae.hand = null;
  _ae.place = null;
  _aeHandReset();
  _aeCloseInfo(false);
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
}

window.openAlmanacEarth = openAlmanacEarth;
// The orrery, drawn before this file ran, can now say Earth opens in 3D.
if (typeof _orreryRenderHint === 'function') _orreryRenderHint();
// This file loads once the Almanac is shown and quiet (almanac.js _almLoadEarth); the view itself (three.js, its maps and
// shaders) is made ready only when the Moon is touched or the view opened, never behind the page.
