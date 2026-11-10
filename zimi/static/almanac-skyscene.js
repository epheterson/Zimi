// ── Almanac: the beach scene's helicopter ──
// A helicopter that crosses low with its real lights: red and green steady, a red beacon and a white strobe that blink. (The clouds
// are not drawn here: the day's one cloud field is the sky's own shader, almanac-skygl.js SG_GLSL_CLOUDS, the same in the card and in
// Stand here.)
// Loaded after almanac-sky.js, whose painters call in here (they check that
// this file is there); all almanac scripts share one global scope.

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
