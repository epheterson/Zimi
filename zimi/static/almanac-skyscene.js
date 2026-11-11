// ── Almanac: the beach scene's clouds and its helicopter ──
// Clouds in three layers, drawn new each day for the place (not weather: Zimi
// has none), each lit by where the Sun is *as that cloud sees it*. A cloud
// h km up, rho km away, is lit while the Sun is above the horizon seen from
// there, so after sunset the high ones and the far ones toward the Sun keep
// its light, reddened by the long way it came, and the rest stand dark against
// the sky. And a helicopter that crosses low with its real lights: red and
// green steady, a red beacon and a white strobe that blink.
// Loaded after almanac-sky.js, whose painters call in here (they check that
// this file is there); all almanac scripts share one global scope.

// ── Clouds ──
// Height, ground distance and puff radius in km; the puffs in a cloud; how far
// the cloud spreads, in puff radii; how flat the puffs are (height over width);
// how opaque; how many clouds a day of full cover draws.
var SKY_CLOUD_LAYERS = [
  { key: 'cumulus', h: [1.2, 2.4], d: [2.5, 60], r: [0.3, 0.8], puffs: [5, 9], span: 2.4, flat: 0.55, alpha: 0.92, n: [7, 15] },
  { key: 'alto', h: [3.2, 5.6], d: [4, 160], r: [0.8, 1.9], puffs: [6, 11], span: 2.8, flat: 0.38, alpha: 0.7, n: [7, 13] },
  { key: 'cirrus', h: [8.5, 11], d: [6, 330], r: [2, 4.8], puffs: [4, 7], span: 3.4, flat: 0.14, alpha: 0.6, n: [5, 10] }
];
var SKY_CLOUD_COVER_POW = 1;          // the day's cover is a random number to this power (1: evenly from thin to heavy)
var SKY_CLOUD_MIN_SHARE = 0.8;        // a clear day still draws this share of the fewest
var SKY_CLOUD_CLEAR_DEG = 4;          // the clouds part this far round the Sun and the Moon: the sky stays the real one
var SKY_CLOUD_MIN_ALT = -0.5;         // a puff whose centre is lower than this is under the horizon
var SKY_CLOUD_SEED_PLACE = 10;        // the place enters the day's seed to this many parts of a degree
var SKY_CLOUD_LIT_FROM = -0.25, SKY_CLOUD_LIT_TO = 0.6;   // the Sun's apparent height at the cloud over which it goes from in shade to in full light
var SKY_CLOUD_FULL_SUN_DEG = 12;      // and the height at which it is as bright as the cloud will be
var SKY_CLOUD_SHADE_DAY = [118, 128, 146], SKY_CLOUD_SHADE_NIGHT_MIX = 0.6;   // a cloud's shade by day; by night the sky's horizon colour this much darker
var SKY_CLOUD_SHADE_NIGHT = [30, 34, 62];   // the cool dark an unlit cloud sinks toward
var SKY_CLOUD_MOONLIT = [205, 215, 235], SKY_CLOUD_MOON_SHARE = 0.55;          // a bright Moon's light on the cloud
var SKY_CLOUD_GLOW_MIN = 0.85;         // how much of its light's colour a cloud takes with the Sun at the horizon: the evening glow
var SKY_CLOUD_HIGHLIGHT = 0.32;       // how far toward the light the bright part sits, in puff radii
var SKY_CLOUD_SIDE_SPREAD = 0.3;      // and sideways
var SKY_CLOUD_LIGHT_FULL_DEG = 20;    // the Sun this far above or below the cloud's own height puts the bright part fully top or bottom
var SKY_CLOUD_EDGE = 0.55;            // the puff stays solid to this share of its radius, then fades
var SKY_CLOUD_PUFF_MIN_PX = 2;        // smaller than this is not worth a gradient

// A small seeded generator (mulberry32): the same day and place draw the same clouds.
function _skyMulberry(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The day's seed: the local solar date and the place to a tenth of a degree.
function _skyCloudSeed(nowMs, lat, lon) {
  var day = Math.floor(nowMs / 86400000 + lon / 360 + 0.5);
  return (Math.imul(day, 73856093) ^ Math.imul(Math.round(lat * SKY_CLOUD_SEED_PLACE), 19349663) ^ Math.imul(Math.round(lon * SKY_CLOUD_SEED_PLACE), 83492791)) >>> 0;
}

// The Sun's apparent height (degrees) seen from a cloud h km up, rho km away on
// bearing az, when the Sun stands at sunGeoAlt, sunAz from the observer: at the
// cloud's ground point the Sun is lower by the way round the Earth toward it,
// and from h km up the horizon has dipped by acos(R / (R + h)).
function _skyCloudSunAlt(sunGeoAlt, sunAz, az, rho, h) {
  var depression = -sunGeoAlt - rho / SKY_EARTH_KM / DEG_TO_RAD * Math.cos((az - sunAz) * DEG_TO_RAD);
  var dip = Math.acos(SKY_EARTH_KM / (SKY_EARTH_KM + h)) / DEG_TO_RAD;
  return _skyRefract(dip - depression);
}
function _skySmooth(x, lo, hi) { var t = _skyClamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); }

// The clouds of a day at a place: [{layer, az, rho, h, puffs: [{dx, dy, r}]}], far ones first.
function _skyCloudField(nowMs, lat, lon) {
  var rand = _skyMulberry(_skyCloudSeed(nowMs, lat, lon)), cover = Math.pow(rand(), SKY_CLOUD_COVER_POW), out = [];
  SKY_CLOUD_LAYERS.forEach(function (L) {
    var n = Math.round(_skyLerp(L.n[0] * SKY_CLOUD_MIN_SHARE, L.n[1], cover));
    for (var i = 0; i < n; i++) {
      var r = _skyRandIn(rand, L.r), np = Math.round(_skyRandIn(rand, L.puffs)), puffs = [];
      // Distance is spread evenly in its logarithm: many far clouds, a few overhead.
      var rho = Math.exp(_skyRandIn(rand, [Math.log(L.d[0]), Math.log(L.d[1])]));
      for (var k = 0; k < np; k++) {
        var f = rand() * 2 - 1, pr = r * (0.55 + 0.7 * rand()) * (1 - 0.35 * Math.abs(f));
        puffs.push({ dx: f * L.span * r, dy: pr * L.flat * (0.3 + 0.9 * (1 - Math.abs(f))) * rand() * 1.5, r: pr });
      }
      out.push({ layer: L, az: rand() * 360, rho: rho, h: _skyRandIn(rand, L.h), puffs: puffs });
    }
  });
  return out.sort(function (a, b) { return b.rho - a.rho; });
}

// The light on a cloud: the Sun as it sees it, and the two colours that follow.
function _skyCloudLight(s, az, rho, h) {
  var e = s.eph, sunAlt = _skyCloudSunAlt(e.sunGeoAlt, e.sun.az, az, rho, h);
  var lit = _skySmooth(sunAlt, SKY_CLOUD_LIT_FROM, SKY_CLOUD_LIT_TO);
  var tone = _skyTone(e.sunGeoAlt), day = _skyDaylight(e.sunGeoAlt);
  var shade = _skyMix(_skyMix(tone.hor, SKY_CLOUD_SHADE_NIGHT, SKY_CLOUD_SHADE_NIGHT_MIX), SKY_CLOUD_SHADE_DAY, day);
  var moonUp = e.moon.altitude > 0 ? s.moonData.phase.illumination / 100 : 0;
  shade = _skyMix(shade, SKY_CLOUD_MOONLIT, SKY_CLOUD_MOON_SHARE * moonUp * (1 - day) * (1 - lit));
  var tint = _skySunTint(Math.max(sunAlt, -0.5)).map(function (v) { return 255 * v; });
  var strength = SKY_CLOUD_GLOW_MIN + (1 - SKY_CLOUD_GLOW_MIN) * _skyClamp(sunAlt / SKY_CLOUD_FULL_SUN_DEG, 0, 1);
  return { sunAlt: sunAlt, lit: lit, shade: shade, direct: _skyMix(shade, tint, strength), strength: strength };
}

// One puff: its shade as a soft disc, and over it the lit part, set toward the
// light (below the cloud while the Sun is lower than it, above when higher).
function _skyPaintPuff(ctx, x, y, rx, ry, L, alpha, light, toward) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  var base = ctx.createRadialGradient(0, 0, rx * SKY_CLOUD_EDGE * 0.4, 0, 0, rx);
  base.addColorStop(0, _skyRgb(light.shade, alpha));
  base.addColorStop(SKY_CLOUD_EDGE, _skyRgb(light.shade, alpha * 0.8));
  base.addColorStop(1, _skyRgb(light.shade, 0));
  ctx.fillStyle = base;
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
  if (light.lit > 0.01) {
    var hx = toward.x * SKY_CLOUD_SIDE_SPREAD * rx, hy = toward.y * SKY_CLOUD_HIGHLIGHT * rx;
    var g = ctx.createRadialGradient(hx, hy, 0, hx, hy, rx);
    g.addColorStop(0, _skyRgb(light.direct, alpha * light.lit));
    g.addColorStop(SKY_CLOUD_EDGE, _skyRgb(light.direct, alpha * light.lit * 0.55));
    g.addColorStop(1, _skyRgb(light.direct, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Paint the day's clouds into the still picture, over the stars and bodies and
// under the ground. Not where the Sun or the Moon is. Records what a tap on a
// cloud says (almanac-sky.js _skyLifeLines).
function _skyPaintClouds(ctx, s) {
  var e = s.eph, field = _skyCloudField(s.nowTime, s.lat, s.lon), dpr = s.dpr, ppdX = _skyPxPerDeg(s), ppdY = _skyPxPerDegY(s);
  var sun = _skyEnu(e.sun.az, e.sunGeoAlt), moon = _skyEnu(e.moon.azimuth, e.moon.altitude), clear = Math.cos(SKY_CLOUD_CLEAR_DEG * DEG_TO_RAD);
  field.forEach(function (c) {
    var E = c.rho * Math.sin(c.az * DEG_TO_RAD), N = c.rho * Math.cos(c.az * DEG_TO_RAD);
    var mid = _skyPlaneFromEN(E, N, c.h);
    var v = _skyEnu(mid.az, mid.alt);
    if (e.sunGeoAlt > -3 && _skyDot3(v, sun) > clear || e.moon.altitude > -3 && _skyDot3(v, moon) > clear) return;
    var light = _skyCloudLight(s, c.az, c.rho, c.h);
    var sunSide = Math.sin((e.sun.az - c.az) * DEG_TO_RAD);
    // Light from below while the Sun is under the cloud's own height, from above when over it.
    var below = _skyClamp((mid.alt - light.sunAlt) / SKY_CLOUD_LIGHT_FULL_DEG, -1, 1);
    var toward = { x: sunSide, y: below };
    var seen = false, sx = 0, sy = 0, sr = 0;
    c.puffs.forEach(function (p) {
      var pE = E + p.dx * Math.cos(c.az * DEG_TO_RAD), pN = N - p.dx * Math.sin(c.az * DEG_TO_RAD);
      var rho = Math.max(1, Math.sqrt(pE * pE + pN * pN)), at = _skyPlaneFromEN(pE, pN, c.h + p.dy);
      if (at.alt < SKY_CLOUD_MIN_ALT) return;
      var x = _skyX(s, at.az), y = _skyY(s, at.alt), degRadius = p.r / rho / DEG_TO_RAD;
      var rx = degRadius * ppdX, ry = rx * c.layer.flat;
      if (!_skyInView(s, x, rx) || rx < SKY_CLOUD_PUFF_MIN_PX * dpr) return;
      _skyPaintPuff(ctx, x, y, rx, Math.max(ry, 1), c.layer, c.layer.alpha, light, toward);
      if (!seen) { seen = true; sx = x; sy = y; }
      sr = Math.max(sr, rx);
    });
    if (seen) s.bodies.push({ type: 'cloud', x: sx / dpr, y: sy / dpr, r: Math.max(8, sr / dpr), layer: c.layer.key, h: c.h, rho: c.rho, sunAlt: light.sunAlt, lit: light.lit });
  });
}

// What a tap on a cloud says besides its name: its height and distance, and,
// with the Sun below the horizon, whether the Sun still reaches it.
function _skyCloudLines(b) {
  var s = _skyState, lines = [t('alm_sky_cloud_' + b.layer, { h: _orrNum(b.h, 'kilometer', 1), d: _orrNum(Math.round(b.rho), 'kilometer', 0) })];
  if (s && s.eph.sunGeoAlt < 0) {
    lines.push(t(b.lit > 0.5 ? 'alm_sky_cloud_lit' : 'alm_sky_cloud_dark', { deg: _skyDeg(-s.eph.sunGeoAlt) }));
  }
  lines.push(t('alm_sky_cloud_note'));
  return lines;
}

// ── The helicopter ──
// A helicopter crosses low and slow: a few hundred metres up, a hundred and
// fifty to two hundred and fifty km/h, near enough to hear. It shows by its
// lights at dusk and after: red on the left, green on the right, a white tail
// light, and the red beacon and white strobe that blink.
var SKY_HELI = { km: [0.3, 1.2], pass: [0.6, 4], kms: [0.04, 0.07] };   // height, nearest approach and ground speed (km a second) of a crossing
var SKY_HELI_GAP_S = [150, 480];       // one every few minutes, at dusk and after
var SKY_HELI_DAY_SHARE = 0.25;         // by day only this share of the times one is due
var SKY_HELI_NAV_LIGHT = [0.45, 0.55], SKY_HELI_TAIL = [0.4, 0.4];
var SKY_HELI_BEACON = [0.65, 0.8], SKY_HELI_BEACON_MS = 900, SKY_HELI_BEACON_PULSE_MS = 140;   // the red beacon: a flash a little faster than once a second
var SKY_HELI_STROBE = [0.7, 0.85], SKY_HELI_STROBE_MS = 1500, SKY_HELI_STROBE_PULSES = [[0, 50], [130, 180]];   // the white strobe: a double flash
var SKY_HELI_SEPARATION_KM = 0.012;    // its nav lights stand this far apart, seen end on
var SKY_HELI_SPECK_KM = 2;             // by day it is the full speck at this range

function _skyHeli(s, flying) { return _skyPlane(s, flying, SKY_HELI, 'heli'); }
function _skyPaintHeli(ctx, s, a, ts) {
  var p = _skyActorAt(a, ts), pos = _skyPlaneAt(a, p), dpr = s.dpr, u = s.scale * dpr, e = s.eph;
  var x = _skyX(s, pos.az), y = _skyY(s, pos.alt), light = _skyDaylight(e.sunGeoAlt);
  if (!_skyInView(s, x, 30 * dpr)) return;
  var haze = _skyClamp((pos.alt - SKY_PLANE_MIN_ALT) / SKY_PLANE_FADE_DEG, 0, 1);   // out of the haze as an airliner comes
  if (haze <= 0) return;
  ctx.save();
  ctx.globalAlpha = haze;
  if (light > 0.15) {
    // By day a speck with a thin line for the rotor.
    var sp = _skyClamp(SKY_HELI_SPECK_KM / pos.rho, 0.4, 1.6) * u;
    ctx.fillStyle = 'rgba(40,46,58,' + (0.75 * light).toFixed(3) + ')';
    ctx.fillRect(-1 * sp + x, y - 0.3 * sp, 2 * sp, 0.6 * sp);
    ctx.fillRect(x - 0.12 * sp, y - 0.8 * sp, 0.24 * sp, 0.5 * sp);
    ctx.fillRect(x - 1.4 * sp, y - 0.8 * sp, 2.8 * sp, 0.12 * sp);
  }
  if (light < 0.8) {
    var on = (1 - light) * _skyClamp(SKY_PLANE_NEAR_KM / 4 / pos.rho, SKY_PLANE_DIM_MIN, 1), ms = ts - a.start + a.phase;
    var lt = _skyPlaneLights(a, pos), nav = SKY_HELI_NAV_LIGHT;
    // The side lights, one red and one green, apart by the width of the machine seen end on.
    var sep = Math.abs(lt.cosPsi) * 0.5 * SKY_HELI_SEPARATION_KM / pos.rho / DEG_TO_RAD * _skyPxPerDeg(s);
    if (lt.red > 0.02) _skyLight(ctx, x + lt.cosPsi * sep, y, nav[0] * dpr, [255, 60, 50], nav[1] * on * lt.red);
    if (lt.green > 0.02) _skyLight(ctx, x - lt.cosPsi * sep, y, nav[0] * dpr, [70, 255, 110], nav[1] * on * lt.green);
    if (lt.tail > 0.02) _skyLight(ctx, x, y, SKY_HELI_TAIL[0] * dpr, [255, 255, 255], SKY_HELI_TAIL[1] * on * lt.tail);
    if (_skyPulse(ms, SKY_HELI_BEACON_MS, [[0, SKY_HELI_BEACON_PULSE_MS]])) _skyLight(ctx, x, y - 0.6 * u, SKY_HELI_BEACON[0] * dpr, [255, 40, 30], SKY_HELI_BEACON[1] * on);
    if (_skyPulse(ms, SKY_HELI_STROBE_MS, SKY_HELI_STROBE_PULSES)) _skyLight(ctx, x, y + 0.4 * u, SKY_HELI_STROBE[0] * dpr, [255, 255, 255], SKY_HELI_STROBE[1] * on);
  }
  ctx.restore();
  s.bodies.push({ type: 'heli', x: x / dpr, y: y / dpr, r: 6 });
}
