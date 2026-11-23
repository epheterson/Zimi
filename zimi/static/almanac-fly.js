// Fly: a flying saucer you fly through the solar system in the 3D view (almanac-earth.js). Loaded on the first press of Fly (or
// enterFly), never with the view. The planets stand where the view's clock has them and nothing of theirs is moved; the
// craft is built here (a profile turned about its axis, lit by the Sun and the world it is over) and drawn at a size that follows its
// height over the nearest surface, so it is as big in the picture over a planet as between two.
//
// One law for its speed at every scale: at full throttle it is always AF_TAU_S from the nearest thing (v = height / tau, the time to contact the eye itself
// steers by: Lee 1976), so the ground streams by at the same rate ten metres up and ten AU out. It never touches the clock: the worlds are where the view's
// clock has them, and the craft crosses between them in real time, faster than light when it must (its speed and the light's own time are shown).
//
// Keys: W S forward and back, A D turn, Space up, Ctrl or C down, Q E roll, the arrows the same as WASD, L levels, H hides the controls (the view's), Esc
// leaves; a mouse drag looks. Phone: one lever a thumb. The left is the throttle (it springs back to stop), the right comes in to the
// world below or leaves it (it springs back); a drag anywhere else looks, and a tap on a world flies there.
//
// The hooks in almanac-earth.js are the mission player's: _aeShipStep (before the camera), _aeShipCam, _aeShipNear and
// _aeShipDraw, _afPreset (a body chosen is where the ship goes) and _afStop when the view closes.

var AF_SPAN_PER_ALT = 0.03;           // the craft's drawn width, as a share of its height over the nearest surface
var AF_SPAN_MIN_RE = AE_FLY_REF.craftM / (AE_EARTH_RADIUS_KM * 1000);   // Earth radii (about 12 m): never smaller than this
var AF_CHASE_BACK = 16.5, AF_CHASE_UP = 2;   // craft widths: how far behind and above the camera stands (the craft is about a fifth of the picture's width)
var AF_HORIZON_UP = 0.5, AF_HORIZON_FROM = 0.5, AF_HORIZON_TO = 2;   // the horizon stands this share of the way to the top of the picture; the pitch is the horizon's below this height (body radii), the world's centre's above
var AF_RELEASE_KEEP = 0.7;           // while the held picture turns to the framing the craft stays within this share of the picture's half-width of its middle
var AF_FRAME_SHIFT = 0.55;            // the craft may stand this share of the way to the picture's edge, so the world it flies over shows below or behind it
var AF_CAM_SPRING_S = 6;              // the camera's up closes this share of the gap a second (exponential)
var AF_TAU_S = AE_FLY_REF.tauS;        // full throttle: the craft is this long from the nearest surface (its speed is its height over that, in this time)
var AF_SKIM_RE = AE_FLY_REF.skimKm / AE_EARTH_RADIUS_KM;   // the lowest it goes over a surface (Earth radii); the Sun is kept at AF_SUN_WALL body radii
var AF_SUN_WALL = 1.3;
var AF_STEP_MAX_S = 0.05;             // a long frame is taken as this, never more
var AF_LOOK_KEY_DEG_S = 75, AF_LOOK_DRAG_DEG_PX = 0.22;   // turning the view: the arrows, and a thumb on the right half
var AF_TURN_AUTO_DEG_S = 70;          // the view's turn toward where the autopilot goes
var AF_ARRIVE_SPAN = AE_FLY_REF.arriveSpan, AF_ARRIVE_NEAREST = 1.2;   // the autopilot stops where the world spans this share of the picture's shorter side (its limb and the sky round it in the picture, the craft before it); never nearer than this many radii from its middle
// How far from a world's middle the autopilot stops: where its disc is AF_ARRIVE_SPAN of the picture's shorter side, from the picture's own field.
function _afStopAt(b) {
  var half = _aeRad(AE_FOV_DEG) / 2, short = Math.atan(Math.tan(half) * Math.min(1, _ae.w / Math.max(_ae.h, 1)));
  return b.r * Math.max(AF_ARRIVE_NEAREST, 1 / Math.sin(AF_ARRIVE_SPAN * short));
}
var AF_ROW_HYST = 0.7;                // a world takes the row's mark when its height (in its radii) is under this share of the marked one's
var AF_HINT_KEY = 'zimi_fly_hint_seen';   // set once the first flight's hint has been touched away
var AF_TURN_DEG_S = 80;   // turning on the keys
var AF_AUTOLEVEL_S = 1.2;   // a rolled or tipped craft levels itself this long after the hand leaves it
var AF_TILT_DEG_PX = 0.3, AF_PITCH_KEY_DEG_S = 60, AF_ROLL_KEY_DEG_S = 70;   // a thumb in Tilt mode: degrees of nose or roll a pixel; the keys' rates
var AF_ENTRY_LEVEL_SIN = 0.08, AF_ENTRY_ROLL_DEG = 6;   // a view that is further from level than this at entry is kept as it is (Level puts it right); a level one stays level
var AF_LEVEL_RATE = 4;                // the craft eases level at this rate a second (level: the horizon of the nearest world, the sky's north far out)
var AF_LEVER_H = 190, AF_LEVER_W = 48, AF_LEVER_FOOT_PX = 110;   // a lever's height and width (px), and how far its foot stands over the picture's (over the row of worlds)
var AF_DETENT = AE_FLY_REF.detent, AF_THROTTLE_STOP_MS = 220;   // the throttle within this share of its travel of the middle is at stop; let go, it springs back to stop in this long
var AF_START_ITER = 12;               // the craft's place from the camera's is worked out by this many rounds (its distance follows its own height)
var AF_RELEASE_MS = 600, AF_LIFT_MS = 1500;              // when a hand first takes the craft, the picture turns from the way it was to the chase framing in this long; lifting off, from the eye beside the craft to that framing in the second
var AF_ARRIVE_EPS = 1e-4;             // body radii: the autopilot counts as arrived this near its stopping place (the geometric slowing never quite reaches it)
var AF_ARRIVE_EASE = AE_FLY_REF.arriveEase;            // the autopilot's last approach is never slower than this share of the goal's radius in AF_TAU_S (a pace that only halved would never arrive)
var AF_UP_NEAR = 6;                   // within this many body radii its surface is the floor, and up is away from it
var AF_SEE_MIN_DEG = 0.6, AF_SEE_FIT = 0.8;   // a body counts as in the picture when it spans this many degrees and lies inside this share of the picture's half-width
var AF_ASSIST_DONE_DEG = 8;   // a world within this many degrees of the nose counts as in the picture even when it is a speck
var AF_LAND_S = 0.5;                  // pushing down this long at the lowest height over a ground lands there (Stand here)
var AF_ZONE_NEAR_RE = 300, AF_ZONE_FAR_RE = 1200;          // within the first the drawing is true to size and distance; beyond the second it is the Sun's squeeze (almanac-earth.js _aeShownDist)
var AF_HUD_TICK_MS = 120;
var AF_DECK_SHARE = AE_FLY_REF.deckShare;   // a world with no ground (AE_NO_GROUND_BODIES): the craft stops this share of its radius over the cloud tops, where its horizon and bands still read
var AF_DECK_EPS = 1e-6;               // a craft within this share of the cloud-deck height of it is held there
var AF_RISE_RADII = 1, AF_LOW_FLOORS = 2;   // the rim's way up climbs to this many body radii over the surface; a craft within this many floors of it is down at the surface
var AF_FLARE_FROM = AE_FLY_REF.flareFrom, AF_FLARE_LEVEL = AE_FLY_REF.flareLevel, AF_FLARE_DEG_S = AE_FLY_REF.flareDegS;   // coming in on the lever the nose lifts to the horizon: from this height (body radii) it may point less and less down, level by the second; at most this fast
// A flight game's keys: W S forward and back, A D turn, the arrows the same (Up and Down pitch when Tilt is on), Space rises, Ctrl or C sinks, Q and E roll,
// L levels, Esc leaves. The mouse drags to look.
var AF_KEYS = { w: 'f', s: 'b', a: 'l', d: 'r', arrowleft: 'l', arrowright: 'r', arrowup: 'au', arrowdown: 'ad', ' ': 'up', control: 'dn', c: 'dn', q: 'rl', e: 'rr' };
var _afKeys = {}, _afOnKey = null, _afFocusOff = null;

// ── The bodies ──
// Every body drawn: the Earth at the middle, the Moon, the Sun as shown, each planet and big moon.
function _afBodies(sc) { return _aeBodySpheres(sc); }
// The nearest surface: { body, d (centre distance), alt (over its surface) }.
function _afNearest(bodies, pos) {
  var best = null;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i], rel = _aeSub(pos, b.pos), d = _aeLen(rel), alt = d - _afSurface(b, rel, d);
    if (!best || alt < best.alt) best = { body: b, d: d, alt: alt };
  }
  return best;
}
// The world the craft is over: down, the horizon and the name are its. It is the one the craft was over (`held`, a key: at first the view's own) until
// another is both the nearest surface and looms clearly larger in the sky (less height in its own radii). The nearest surface alone is the wrong
// answer beside a giant: from Jupiter's view a moon is often nearer while Jupiter fills the picture, and from the Moon's the Earth looms larger.
function _afOver(bodies, pos, held) {
  var nearest = _afNearest(bodies, pos), b = held && held !== nearest.body.key ? _afBody(bodies, held) : null;
  if (!b) return nearest;
  var mine = _afAt(b, pos);
  return nearest.alt / nearest.body.r < mine.alt / b.r * AF_ROW_HYST ? nearest : mine;
}
function _afAt(b, pos) { var rel = _aeSub(pos, b.pos), d = _aeLen(rel); return { body: b, d: d, alt: d - _afSurface(b, rel, d) }; }
// The craft's world: the one the autopilot goes to or has brought it to, or a way down is to (from Jupiter's stop a moon may be nearer, and down went to
// that moon: stuck on Io's floor, the dive never reached the cloud tops), else _afOver's.
function _afOverShip(sh, bodies) {
  var key = sh.auto || sh.dive || sh.arrived, goal = key && _afBody(bodies, key);
  return goal ? _afAt(goal, sh.pos) : _afOver(bodies, sh.pos, sh.near ? sh.near.body.key : sh.hold && sh.hold.key);   // (a craft just let into the view is over the view's own world, as _afOver says, even where a moon is the nearer surface)
}
// How far a body's surface stands from its centre, along the way to a place (`rel`, `d` its length): its radius, and for the Earth the flattened globe the
// view draws (21 km less at the poles: a craft kept over the round one hung that far above the ground there).
function _afSurface(b, rel, d) {
  if (b.key !== 'earth' || !(d > 0)) return b.r;
  var s = rel[2] / d;   // (the Earth's pole is the scene's own z)
  return b.r * (1 - AE_EARTH_FLATTENING * s * s);
}
// How near the nearest body that is not the Sun stands (centre to centre): what decides the drawing's true-to-size zone.
function _afNonSunNear(bodies, pos) {
  var m = 1e30;
  for (var i = 0; i < bodies.length; i++) if (bodies[i].key !== 'sun') m = Math.min(m, _aeLen(_aeSub(pos, bodies[i].pos)));
  return m;
}
// The lowest the craft goes over a body: a few km (the sphere is drawn without relief), the Sun well clear, a world of gas at its cloud deck.
// Over a body with Almanac HD loaded and no ground to come down to, no lower than the closest stop the view itself keeps there (where a texel of its
// deepest tiles is still sharp: AE_TARGETS[..].min, held by almanac-earth.js for the body the craft is nearest); under that the picture only blurs. A body
// with a ground (almanac-standhost.js builds it from three times the height it shows at) is flown down to: held at the HD stop, 400 km over the Earth,
// the craft never came near enough for that ground to be built, so with Almanac HD installed there was no landing.
function _afFloor(b) {
  if (b.key === 'sun') return b.r * (AF_SUN_WALL - 1);
  if (AE_NO_GROUND_BODIES.indexOf(b.key) >= 0) return b.r * AF_DECK_SHARE;
  var t = AE_TARGETS[b.key], hd = !_aeStandable(b.key) && _ae.gl && _ae.gl.hd && _ae.gl.hd.bodies && _ae.gl.hd.bodies.some(function (x) { return x.key === b.key; });
  return hd && t && isFinite(t.min) && t.surface ? Math.max(AF_SKIM_RE, t.min - t.surface) : AF_SKIM_RE;
}
// The height the speed is figured from: the height over the nearest surface, never less than the lowest it flies at there (over a ground that is drawn, the
// craft's own width: one width a second at the last).
function _afPaceAlt(alt, ground) { return Math.max(alt, ground ? AF_SPAN_MIN_RE : AF_SKIM_RE); }
// The speed law (Earth radii a second at full throttle): the height over the nearest surface covered in AF_TAU_S.
function _afSpeed(alt, ground) { return _afPaceAlt(alt, ground) / AF_TAU_S; }
// The autopilot's: the same law, and coming in, what is left of the way to its stop covered in the same time (it leaves a world as slowly as it came to it),
// with a floor on that last approach so it arrives.
function _afAutoSpeed(alt, left, goalR) { return Math.min(_afSpeed(alt), Math.max(left, goalR * AF_ARRIVE_EASE) / AF_TAU_S); }
// The way the autopilot heads from a place to its goal: straight at it, unless a world stands in the way (the Moon asked for from the far side of the
// Earth: straight is through the Earth, and a craft that slows as it nears a surface would never get past). Then it heads for the edge of that world's
// keep-out (AF_CLEAR radii), and inside the keep-out along it and outward, so it goes round at a height where it still has speed.
var AF_CLEAR = AE_FLY_REF.clearRadii, AF_CLEAR_CLIMB = 3;
function _afWay(bodies, pos, goal) {
  var span = _aeSub(goal.pos, pos), dist = _aeLen(span), to = _aeScale(span, 1 / Math.max(dist, 1e-12)), block = null, at = Infinity;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i], c = _aeSub(b.pos, pos), along = _aeDot(c, to);
    if (b.key === goal.key || along <= 0 || along >= dist || along >= at) continue;
    if (_aeLen(_aeSub(c, _aeScale(to, along))) < b.r * AF_CLEAR) { block = b; at = along; }
  }
  if (!block) return to;
  var c2 = _aeSub(block.pos, pos), d = _aeLen(c2), inward = _aeScale(c2, 1 / d), keep = block.r * AF_CLEAR;
  var side = _aeSub(to, _aeScale(inward, _aeDot(to, inward)));
  if (_aeLen(side) < 1e-6) side = _aeCross(inward, Math.abs(inward[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);   // dead ahead: either way round is as good
  side = _aeNorm(side);
  if (d <= keep) return _aeNorm(_aeAdd(side, _aeScale(inward, -Math.min(1, AF_CLEAR_CLIMB * (1 - d / keep)))));   // (outward as much as along, low down: its speed is its height, so it climbs to go round)
  var a = Math.asin(keep / d);   // the tangent to the keep-out, on the goal's side
  return _aeAdd(_aeScale(inward, Math.cos(a)), _aeScale(side, Math.sin(a)));
}
function _afBody(bodies, key) { for (var i = 0; i < bodies.length; i++) if (bodies[i].key === key) return bodies[i]; return null; }
function _afRot(v, axis, a) {   // v turned about the unit axis by a radians
  var c = Math.cos(a), s = Math.sin(a), d = _aeDot(axis, v) * (1 - c), x = _aeCross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d, v[1] * c + x[1] * s + axis[1] * d, v[2] * c + x[2] * s + axis[2] * d];
}

// ── Starting and stopping ──
function _afStart() {
  _aeDbg('fly', 'start asked' + (_ae.ship ? ' (already flying)' : !_ae.gl ? ' (no gl)' : !_aeIsOpen ? ' (view closed)' : ''));
  if (_ae.ship || !_ae.gl || !_ae.scene || !_aeIsOpen) return;   // (the script can arrive after the view was left)
  if (_ae.fly) _ae.fly = null;
  _ae.shipExit = null;
  if (_ae.info && typeof _aeCloseInfo === 'function') _aeCloseInfo(true);
  var cam = _ae.gl.camera, e = cam.matrixWorld.elements, bodies = _afBodies(_ae.scene);
  var pos = _aeXyz(cam.position), look = _aeNorm([-e[8], -e[9], -e[10]]), upv = [e[4], e[5], e[6]];
  var camUp = _aeNorm(_aeSub(upv, _aeScale(look, _aeDot(upv, look))));
  // Getting in moves nothing: the picture stays exactly as it was (the camera's place, its way of looking, its field) with the saucer in it,
  // in front of the view; only a hand on the controls sets anything going (sh.hold, until then). The craft stands where the chase camera,
  // which keeps its distance by the craft's own height, is the camera that was.
  var craft = pos, span = _afSpan(_afNearest(bodies, pos).alt);
  for (var i = 0; i < AF_START_ITER; i++) {
    craft = _aeAdd(pos, _aeSub(_aeScale(look, span * AF_CHASE_BACK), _aeScale(camUp, span * AF_CHASE_UP)));
    span = _afSpan(_afNearest(bodies, craft).alt);
  }
  var key = _ae.target, at = _aeBodyPos(key) || [0, 0, 0], nearAt = _afOver(bodies, pos, key), ref0 = nearAt.d < nearAt.body.r * AF_UP_NEAR ? _aeNorm(_aeSub(pos, nearAt.body.pos)) : [0, 0, 1];
  var offLevel = Math.abs(_aeDot(look, ref0)) > AF_ENTRY_LEVEL_SIN || _aeDot(camUp, ref0) < Math.cos(_aeRad(AF_ENTRY_ROLL_DEG));
  var sh = _ae.ship = _afNewShip(craft, look, camUp);
  sh.ref = ref0; sh.free = offLevel; sh.span = span;
  sh.hold = { key: key, at: at, off: _aeSub(pos, at), look: look, up: camUp, fov: cam.fov, nearRe: cam.near };
  _afBegin();
}
// A craft is being flown from now: its keys and thumbs, its controls on the view.
function _afBegin() {
  _afBind(true);
  _afHud(true);
  _aeRimSync(true);
  _aeMarkFly();
  _aeRedraw();
}
// A new craft at a place, facing a way (not held in front of the view's own camera: one that lifts off from where it was set down).
function _afNewShip(pos, view, up) {
  return { pos: pos, view: view, up: up, camUp: up, ref: up, free: false, tilt: false, lyaw: 0, lpitch: 0, lever: 0, throttle: 0, hand: false, twist: 0, lookDown: 0, vel: [0, 0, 0], span: AF_SPAN_MIN_RE,
    last: 0, pose: null, auto: null, arrived: null, look: { x: 0, y: 0 }, hudAt: 0, blind: 0, lookAt: 0, landT: 0, hold: null, release: null };
}
function _afStop(quiet) {
  _aeDbg('fly', 'stop' + (quiet ? ' quiet' : '') + (_ae.ship ? '' : ' (no ship)'));
  var sh = _ae.ship;
  if (_ae.shipParked) { _ae.shipParked = null; _aeMarkFly(); }
  if (!sh) return;
  _afGroundDrop(sh);
  _afBind(false);
  _afHud(false);
  if (sh.craft && sh.craft.root.parent) sh.craft.root.parent.remove(sh.craft.root);
  if (!quiet && sh.pose && !_aeReduceMotion()) {   // the picture stays exactly as it was (held with the nearest world) until a hand touches the view
    var nb = _afOver(_afBodies(_ae.scene), sh.pos, sh.near && sh.near.body.key).body;
    _ae.shipExit = { from: sh.pose, t0: performance.now(), hold: true, key: nb.key, bodyAt: nb.pos.slice() };
  }
  _ae.ship = null;
  _ae.move = null;
  _aeRimSync(true);
  _aeMarkFly();
  if (sh.arrived) { _ae.arrived = null; if (!quiet) _aeRenderCard(); }
  if (quiet || !_ae.gl) return;
  _afOrbitFromCraft(sh);
  _aeMarkViews();
  _aeRedraw();
}
// The orbit camera takes over where the craft was: it looks at the nearest body from the craft's side.
function _afOrbitFromCraft(sh) {
  var near = _afOver(_afBodies(_ae.scene), sh.pos, sh.near && sh.near.body.key), key = near.body.key;
  if (!AE_TARGETS[key]) return;
  _ae.target = key;
  _ae.pan = null;
  var off = _aeSub(sh.pos, near.body.pos);
  _ae.dist = _aeClampDist(_aeLen(off));
  var azel = _aeAzElOf(off);
  _ae.az = azel.az; _ae.el_ = azel.el;
}
// The way out: the orbit camera is where the craft was, and the picture eases from the chase view to it (position, look, up, field) so
// leaving is not a cut. Called from the view's camera while _ae.shipExit stands.
var AF_EXIT_MS = 1400;
// A hand on the view (a touch, the wheel, a key, a flight asked for) lets the held picture go: it eases to the orbit view then.
function _afExitRelease() {
  var x = _ae && _ae.shipExit;
  if (!x || !x.hold) return;
  x.hold = false; x.t0 = performance.now();
  _aeRedraw();
}
function _afExitCam(c) {
  var x = _ae.shipExit;
  if (x.hold) {   // leaving the ship moves nothing: the same camera, riding with the world it was nearest
    var d = _aeSub(_aeBodyPos(x.key), x.bodyAt), q = x.from;
    x.near = _aeClamp(1e-3, 1e-12, q.nearRe);
    return { tp: _aeAdd(_aeAdd(q.tp, d), [0, 0, 0]), az: c.az, el: c.el, dist: c.dist, tanHalf: _aeTanHalf(q.fov), roll: c.roll, frame: c.frame, pose: { pos: _aeAdd(q.pos, d), up: q.up, look: q.look, tp: _aeAdd(q.tp, d), fov: q.fov, nearRe: x.near } };
  }
  var e = _smoothstep(0, 1, (performance.now() - x.t0) / AF_EXIT_MS);
  if (e >= 1) { _ae.shipExit = null; return c; }
  var p0 = x.from, p1 = c.pose || _aePoseOf(c), mix = function (a, b) { return _aeAdd(_aeScale(a, 1 - e), _aeScale(b, e)); };
  var pos = mix(p0.pos, p1.pos), look = _aeNorm(mix(p0.look, p1.look)), up = _aeNorm(mix(p0.up, p1.up)), fov = _aeDeg(2 * Math.atan(_aeTanHalf(p0.fov) * (1 - e) + c.tanHalf * e));
  x.near = Math.max(1e-12, Math.min(p0.nearRe, 1e-3) * (1 - e) + 1e-3 * e);
  return { tp: _aeAdd(pos, look), az: c.az, el: c.el, dist: c.dist, tanHalf: _aeTanHalf(fov), roll: c.roll, frame: c.frame, pose: { pos: pos, up: up, look: look, tp: _aeAdd(pos, look), fov: fov, nearRe: x.near } };
}
function _afExitNear(near) { var x = _ae.shipExit; return x && x.near ? Math.min(near, x.near) : near; }
function _afSpan(alt) { return Math.max(AF_SPAN_MIN_RE, alt * AF_SPAN_PER_ALT); }

// ── Speed: what the craft does, in real units ──
// The inverse of the view's squeeze: the real distance from the Sun (AU) for a drawn one (Earth radii), by bisection.
function _afAuOf(shown) {
  var lo = 0, hi = 200;
  for (var i = 0; i < 30; i++) { var mid = (lo + hi) / 2; if (_aeShownDist(mid) < shown) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
var AF_AU_RE = AU_KM / AE_EARTH_RADIUS_KM;   // an AU in Earth radii
// Real kilometres a drawn Earth radius stands for, for a move along `dir` at `pos`: true to size within a body's own
// neighbourhood; between them the planets are drawn closer to the Sun than they are, and a move toward or away from it
// is that much longer in fact (the radial stretch), a move across it the ratio of the real circle to the drawn one.
function _afRealKmPerRe(sh, sc, near, dir, sunAt) {
  var rel = _aeSub(sh.pos, sunAt), rs = _aeLen(rel);
  if (rs < 1e-6) return AE_EARTH_RADIUS_KM;
  var au = _afAuOf(rs), h = Math.max(1e-3, rs * 1e-3);
  var radial = (_afAuOf(rs + h) - _afAuOf(rs - h)) / (2 * h) * AF_AU_RE, across = au * AF_AU_RE / rs;
  var cr = Math.abs(_aeDot(dir, _aeScale(rel, 1 / rs))), helio = Math.sqrt(radial * radial * cr * cr + across * across * (1 - cr * cr));
  var zone = 1 - _smoothstep(AF_ZONE_NEAR_RE, AF_ZONE_FAR_RE, near.nonSun);
  return AE_EARTH_RADIUS_KM * (helio + (1 - helio) * zone);
}

// ── The frame hooks ──
function _aeShipStep(sc, fixedDt) {
  var sh = _ae.ship, now = performance.now();
  var dt = fixedDt || (sh.last ? Math.min(AF_STEP_MAX_S, (now - sh.last) / 1000) : 0);
  sh.last = now;
  if (_afTaken()) { _afPark(sh); return; }   // standing, a visit, a mission and a hand-over each take the camera: the craft waits for it to come back
  var bodies = _afBodies(sc);
  if (sh.hold) _afHoldStep(sh); else _afRide(sh, bodies);
  if (sh.gnd) _aeRigGroundFrame(sh);
  if (sh.lifted) _afLiftPlace(sh);
  _afInput(sh, dt);
  _afMove(sh, bodies, dt);
  _afLevelStep(sh, dt);
  var near = _afOverShip(sh, bodies);
  sh.near = near;
  sh.span = _afSpan(_afNearest(bodies, sh.pos).alt);
  if (typeof _aeRigGroundStep === 'function') _aeRigGroundStep(sh, now);   // the ground under the craft, when it is low over one (almanac-standhost.js)
  else if (near.alt < near.body.r * AF_FLARE_FROM && _aeStandable(near.body.key)) _aeStandReady().catch(function () {});   // its scripts, before they are needed
  _afCamera(sh, bodies, dt);
  _afCamClear(sh);
  if (now - sh.hudAt >= AF_HUD_TICK_MS) { sh.hudAt = now; _afReadout(sh, sc, bodies, near); _afRowFollow(sh, near); }
  if (sh.landing) _afLand(sh);
}
// The picture before a hand has touched anything: the camera and the craft go with the body the view was on (its place moves with the clock), so
// nothing in the picture moves. The first input (or a body chosen to fly to) lets it go, and the picture turns to the chase framing over AF_RELEASE_MS.
function _afHoldStep(sh) {
  var h = sh.hold, at = _aeBodyPos(h.key) || h.at, d = _aeSub(at, h.at);
  sh.pos = _aeAdd(sh.pos, d);
  h.at = at;
}
function _afRelease(sh) {
  var h = sh.hold;
  if (!h) return;
  sh.release = { t0: performance.now(), look: h.look, up: h.up, fov: h.fov };
  sh.hold = null;
}
// The keys and levers as one move (forward, turn, up, in shares of full throttle) and one look.
function _afInput(sh, dt) {
  var k = _afKeys, now = performance.now();
  var keyF = (k.f ? 1 : 0) - (k.b ? 1 : 0) + (sh.tilt ? 0 : (k.au ? 1 : 0) - (k.ad ? 1 : 0)), f = keyF + sh.throttle, turn = (k.r ? 1 : 0) - (k.l ? 1 : 0), u = (k.up ? 1 : 0) - (k.dn ? 1 : 0) + sh.lever;
  _afThrottleEase(sh, now);
  // The right thumb and the arrows: the look (springs back behind the craft, never steers), or in Tilt mode the nose and the roll (stay as they are).
  var ax = 0, ay = sh.tilt ? ((k.au ? 1 : 0) - (k.ad ? 1 : 0)) * dt : 0;   // (no keys look: the mouse and the right thumb do; in Tilt the arrows pitch)
  var dx = sh.look.x * _aeRad(AF_LOOK_DRAG_DEG_PX), dy = sh.look.y * _aeRad(AF_LOOK_DRAG_DEG_PX);
  sh.look.x = sh.look.y = 0;
  var yawLook = 0, pitchLook = 0, pitch = 0, roll = ((k.rr ? 1 : 0) - (k.rl ? 1 : 0)) * _aeRad(AF_ROLL_KEY_DEG_S) * dt + sh.twist;
  sh.twist = 0;
  if (sh.tilt) { pitch = ay * _aeRad(AF_PITCH_KEY_DEG_S) + dy * AF_TILT_DEG_PX / AF_LOOK_DRAG_DEG_PX; roll -= ax * _aeRad(AF_ROLL_KEY_DEG_S) - dx * AF_TILT_DEG_PX / AF_LOOK_DRAG_DEG_PX; }
  else { yawLook = ax * _aeRad(AF_LOOK_KEY_DEG_S) + dx; pitchLook = ay * _aeRad(AF_LOOK_KEY_DEG_S) + dy; }
  sh.ask = { f: _aeClamp(f, -1, 1), t: _aeClamp(turn, -1, 1), u: _aeClamp(u, -1, 1) };
  _afKeysShow(sh, keyF, (k.up ? 1 : 0) - (k.dn ? 1 : 0));
  // A hand on a control: a key, either lever held (both spring back to stop, so a lever off its middle has a thumb on it).
  var looked = yawLook || pitchLook, steered = pitch || roll, asked = keyF || turn || u || sh.throttle || sh.hand;
  sh.hand = false;
  if (looked || steered || asked) sh.assist = false;   // a hand on the controls ends the view's own turning to a world
  if (sh.hold && (looked || steered || asked)) _afRelease(sh);
  if (looked || steered || turn) sh.leveling = false;   // a hand on the steering ends a Level
  // No Level button: a craft the hand has rolled or tipped puts its horizon back by itself once the hand has been off it a moment.
  if (sh.tipped && !steered && !looked) { sh.tippedIdle = (sh.tippedIdle || 0) + dt; if (sh.tippedIdle > AF_AUTOLEVEL_S) { sh.tipped = false; sh.tippedIdle = 0; sh.leveling = true; sh.rollOnly = true; sh.free = false; sh.blind = 0; } } else sh.tippedIdle = 0;
  if (looked) sh.lookAt = now;
  if (!sh.hold) {
    // The right thumb (or the mouse) points the nose: it turns and tips as the finger drags and stays where it is left (no spring back, nothing levels it).
    if (yawLook) _afYaw(sh, yawLook);
    if (pitchLook) _afPitchNose(sh, pitchLook);
    if (turn) _afYaw(sh, -_aeClamp(turn, -1, 1) * _aeRad(AF_TURN_DEG_S) * dt);   // A and D turn, like a car (the nose follows)
    if (pitch) { _afPitchNose(sh, pitch); sh.free = true; sh.tipped = true; }
    if (roll) { _afRollNose(sh, roll); sh.free = true; sh.tipped = true; }
  }
  if (asked && sh.auto) sh.auto = null;   // any hand on the controls takes the craft back
  if (asked) sh.dive = sh.rise = null;   // (so does it end a way down or up)
  else if (sh.dive && !sh.auto) { sh.ask.u = -1; if (sh.arrived) _afLeaveArrival(sh); }   // the autopilot's way down: the lever pushed all the way, as a thumb would
  else if (sh.rise && !sh.auto) sh.ask.u = 1;   // the way up: the same lever pushed the other way, until _afMove sees the craft clear of the world
  if (asked && sh.arrived) _afLeaveArrival(sh);
}
// The craft goes with the world it is over: that world's own move since the last step (the Moon covers a kilometre a second), and, low over it, its
// turn too (the Earth's ground passes at up to 465 m/s under a craft that only hangs in space). The turn comes in with the flare's heights: none above
// AF_FLARE_FROM, all of it under AF_FLARE_LEVEL, so a craft near a ground stands still over it and one far out sees the world turn.
function _afRide(sh, bodies) {
  var b = sh.near && sh.near.body ? _afBody(bodies, sh.near.body.key) : _afNearest(bodies, sh.pos).body, f = b && typeof _aeStBodyNow === 'function' ? _aeStBodyNow(b.key) : null, r = sh.ride;   // (a craft's first step: the nearest)
  if (b && r && r.key === b.key) {
    var rel = _aeSub(sh.pos, r.at), w = sh.gnd ? 1 : 1 - _smoothstep(AF_FLARE_LEVEL, AF_FLARE_FROM, (_aeLen(rel) - b.r) / b.r);   // (a ground being drawn under it: the craft is that ground's)
    if (f && r.x && w > 0) {
      var pole = f.f.z, ang = Math.atan2(_aeDot(_aeCross(r.x, f.f.x), pole), _aeDot(r.x, f.f.x)) * w;
      rel = _afRot(rel, pole, ang);
      _afTurnAtt(sh, pole, ang);
      sh.ref = _afRot(sh.ref, pole, ang);
    }
    sh.pos = _aeAdd(b.pos, rel);
  }
  sh.ride = b ? { key: b.key, at: b.pos, x: f ? f.f.x : null } : null;
}
var AF_M_PER_RE = AE_EARTH_RADIUS_KM * 1000;
// The chase camera stays over the ground it flies over (it stands well behind the craft, where a hill may be).
function _afCamClear(sh) {
  var up = typeof _aeRigCamLift === 'function' && sh.pose && !sh.hold ? _aeRigCamLift(sh, sh.pose.pos) : 0;
  if (!up) return;
  var P = sh.pose, away = _aeNorm(_aeSub(P.pos, sh.near.body.pos));
  P.pos = _aeAdd(P.pos, _aeScale(away, up / AF_M_PER_RE));
  P.look = _aeNorm(_aeSub(P.tp, P.pos));
}
function _afGroundDrop(sh) { if (sh.gnd && typeof _aeRigGroundDrop === 'function') _aeRigGroundDrop(sh); }
// The craft's attitude: its nose (sh.view) and its up (sh.up). Turning is about its up, pitching about its right, rolling about its nose.
function _afYaw(sh, a) { sh.view = _aeNorm(_afRot(sh.view, sh.up, a)); }
function _afPitchNose(sh, a) {
  var right = _aeNorm(_aeCross(sh.view, sh.up));
  sh.view = _aeNorm(_afRot(sh.view, right, a)); sh.up = _aeNorm(_afRot(sh.up, right, a));
}
function _afRollNose(sh, a) { sh.up = _aeNorm(_afRot(sh.up, sh.view, a)); }
// The whole attitude turned about an axis.
function _afTurnAtt(sh, axis, a) { sh.view = _aeNorm(_afRot(sh.view, axis, a)); sh.up = _aeNorm(_afRot(sh.up, axis, a)); }
// Level (unless the user has pitched or rolled it): the up eases to the reference up and the nose lies flat to it.
function _afLevelStep(sh, dt) {
  if (!sh.leveling || sh.hold) return;   // only after the Level button: nothing in flight ever turns the craft by itself
  var k = 1 - Math.exp(-dt * AF_LEVEL_RATE);
  if (sh.rollOnly) {   // after a hand's roll: the up eases round the nose to the horizon, the nose stays on what it was pointing at
    var tgt = _aeSub(sh.ref, _aeScale(sh.view, _aeDot(sh.ref, sh.view)));
    if (_aeLen(tgt) < 1e-4) { sh.leveling = false; sh.rollOnly = false; return; }
    var ru = _aeNorm(_aeAdd(sh.up, _aeScale(_aeSub(_aeNorm(tgt), sh.up), k)));
    sh.up = _aeNorm(_aeSub(ru, _aeScale(sh.view, _aeDot(ru, sh.view))));
    if (_aeLen(_aeSub(sh.up, _aeNorm(tgt))) < 1e-3) { sh.leveling = false; sh.rollOnly = false; }
    return;
  }
  var up = _aeNorm(_aeAdd(sh.up, _aeScale(_aeSub(sh.ref, sh.up), k)));
  var flat = _aeSub(sh.view, _aeScale(up, _aeDot(sh.view, up)));
  if (_aeLen(flat) < 0.2) flat = _aeSub(sh.up, _aeScale(up, _aeDot(sh.up, up)));   // looking straight up or down: what was up on the screen is ahead
  if (_aeLen(flat) < 1e-4) return;
  sh.view = _aeNorm(flat); sh.up = up;
  if (_aeLen(_aeSub(up, sh.ref)) < 1e-3) sh.leveling = false;
}
// The camera's own frame: the craft's nose and up with the look turned aside (the look is the camera's, it never steers the craft).
function _afLookFrame(sh) {
  var dir = sh.view, up = sh.up;
  if (sh.lyaw) dir = _afRot(dir, up, sh.lyaw);
  if (sh.lpitch) { var r = _aeNorm(_aeCross(dir, up)); dir = _afRot(dir, r, sh.lpitch); up = _afRot(up, r, sh.lpitch); }
  return { dir: dir, up: up };
}
// Toward a direction at no more than `rate` radians a second.
function _afTurnToward(sh, want, rate, dt) {
  var ang = Math.acos(_aeClamp(_aeDot(sh.view, want), -1, 1));
  if (ang < 1e-4) return;
  var axis = _aeCross(sh.view, want);
  if (_aeLen(axis) < 1e-9) axis = sh.up;
  _afTurnAtt(sh, _aeNorm(axis), Math.min(ang, rate * dt));
}
// Throttling along at the lowest height over a world ("never move without user doing it ... if I'm on the sun and keep moving forward with throttle I fly
// off, by orbit I meant maintain min height and circle object"): the forward lever then takes the craft round the world at that height, not off it in a straight line. Only
// the lever moves the craft. A nose pulled up past AF_HUG_PITCH leaves; the autopilot, a way down and a drawn ground (its height is its own) are not this.
// The down lever held at the floor changes nothing: there is no lower to go, and it must not turn the circling into a straight flight off the world ("pulled lever
// to go down into sun it took me out of the low surface stick and flew me to space going forward"). Only the up lever (u > 0) leaves. The Sun is where it showed: its floor stands
// 0.3 radii (33 Earth radii) over the photosphere and the pace is the height, so a straight tangent that a down lever of a third did not outweigh grew its own speed and was gone.
var AF_HUG_PITCH = Math.sin(_aeRad(AE_FLY_REF.hugPitchDeg)), AF_HUG_EPS = AE_FLY_REF.hugEps;
function _afHugging(sh, near, ask, over, away) {
  return over === null && !sh.hold && !sh.dive && !sh.landing && ask.u <= 0 && ask.f !== 0 && near.alt <= _afFloor(near.body) * (1 + AF_HUG_EPS) && Math.abs(_aeDot(sh.view, away)) <= AF_HUG_PITCH;   // (a nose still down at the world is flying in: it holds at the floor and comes up to level first, only then does it go round)
}
function _afHugVel(sh, away, ask, scale) {   // along the heading, round the world: the nose's own way, level with the ground it hugs
  var t = _aeSub(sh.view, _aeScale(away, _aeDot(sh.view, away)));
  if (_aeLen(t) < 1e-3) t = _aeCross(sh.up, away);   // looking straight along the way up or down: along the wing instead
  return _aeScale(_aeNorm(t), ask.f * scale);
}
// The craft moves at once and stops dead: no inertia, no banking. Forward is where the view looks, up is away from the nearest
// ground. Nothing passes below its lowest height over a surface.
function _afMove(sh, bodies, dt) {
  var near = _afOverShip(sh, bodies), ask = sh.ask, over = typeof _aeRigLift === 'function' ? _aeRigLift(sh, near.body) : null;
  // The pace follows the height over the nearest surface; over a ground that is drawn, the height over that ground itself (its hills and hollows, not the smooth globe).
  var scale = over === null ? _afSpeed(_afNearest(bodies, sh.pos).alt) : _afSpeed(-over / AF_M_PER_RE, true), away = _aeNorm(_aeSub(sh.pos, near.body.pos));
  if (sh.auto) {
    var goal = _afBody(bodies, sh.auto);
    if (!goal) sh.auto = null;
    else {
      var to = _afWay(bodies, sh.pos, goal);
      _afTurnToward(sh, to, _aeRad(AF_TURN_AUTO_DEG_S), dt);
      ask = { f: 0, t: 0, u: 0 };
      var left = _aeLen(_aeSub(goal.pos, sh.pos)) - _afStopAt(goal);
      if (left <= goal.r * AF_ARRIVE_EPS) _afArrive(sh, goal);
      else sh.vel = _aeScale(to, Math.min(_afAutoSpeed(_afNearest(bodies, sh.pos).alt, left, goal.r), left / Math.max(dt, 1e-3)));
    }
  }
  var orbit = !sh.auto && _afHugging(sh, near, ask, over, away), r0 = _aeLen(_aeSub(sh.pos, near.body.pos));
  if (!sh.auto) {
    if (ask.u) _afFlare(sh, near, away, dt, ask.u > 0);
    sh.vel = orbit ? _afHugVel(sh, away, ask, scale) : _aeScale(_aeAdd(_aeScale(sh.view, ask.f), _aeScale(away, ask.u)), scale);   // forward is where the nose points, at any height   // up and down are away from and toward the nearest world, whatever the craft's tilt
  }
  var before = sh.pos;
  sh.pos = _aeAdd(sh.pos, _aeScale(sh.vel, dt));
  if (orbit) {   // (round it, not away from it: the same height, and the nose and the dome go round with it, the horizon stays as it was)
    var to = _aeNorm(_aeSub(sh.pos, near.body.pos)), turn = _aeCross(away, to), sin = _aeLen(turn);
    sh.pos = _aeAdd(near.body.pos, _aeScale(to, r0));
    if (sin > 1e-12) { var ax = _aeScale(turn, 1 / sin), ang = Math.asin(Math.min(1, sin)); sh.view = _aeNorm(_afRot(sh.view, ax, ang)); sh.up = _aeNorm(_afRot(sh.up, ax, ang)); }
  }
  var low = false;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i], rel = _aeSub(sh.pos, b.pos), d = _aeLen(rel), lift = typeof _aeRigLift === 'function' ? _aeRigLift(sh, b) : null;
    var wall = lift === null ? _afSurface(b, rel, d) + _afFloor(b) : d + lift / AF_M_PER_RE;   // over a ground that is drawn, the ground itself is the floor
    if (d < wall) {   // the lowest height: the craft is stood back on it and keeps its slide
      sh.pos = _aeAdd(b.pos, _aeScale(rel, wall / Math.max(d, 1e-12)));
      if (b === near.body) low = true;
    }
  }
  var atFloor = _afAt(near.body, sh.pos).alt <= _afFloor(near.body) * (1 + AF_DECK_EPS);   // (at its floor, pushed there or resting)
  var deck = AE_NO_GROUND_BODIES.indexOf(near.body.key) >= 0 && atFloor;
  if (deck && sh.dive) sh.dive = null;   // (down at the cloud tops: the way down is done)
  if (sh.rise && near.alt >= near.body.r * AF_RISE_RADII) sh.rise = null;   // (a radius clear of it: the way up is done)
  _afDeckLever(sh, deck);
  if ((low || atFloor) && !ask.u && !sh.auto && !sh.dive && !sh.landing) _afFlare(sh, near, away, dt, false);   // down at the surface with no lever: the nose comes up to the horizon and the craft stays near it ("pitch up and start orbiting"), round it hands off (_afOrbiting), along it on the thumb
  if (low && dt > 0) sh.vel = _aeScale(_aeSub(sh.pos, before), 1 / dt);   // held at its lowest height: the speed shown is what it does, not what the lever asks (it read hundreds of km/s standing still)
  // Flying down at the lowest height over a ground that can be stood on lands there: the nose toward the ground and moving on, or pushing down.
  // Setting down is the right lever's own act (or its key), held at the lowest height. The throttle never does it: a craft flown
  // at the ground on it comes to its hover and holds there (its speed going to nothing by the law), whatever the thumb is doing meanwhile.
  var down = ask.u < 0;
  sh.landT = low && down && !sh.auto && _aeStandable(near.body.key) ? sh.landT + dt : 0;
  if (sh.landT >= AF_LAND_S) sh.landing = near.body;
}
// The lever's own attitude, by height alone. Coming in, the craft flares like anything that lands: high up the nose may point straight at the world, and the nearer
// the ground the less far down it may point, level at the last. Leaving is the same curve the other way: the nose drops back toward the world as it climbs, so the
// world is seen to fall away and not lost under the picture. Only the lever does it (a hand on a control), never the craft by itself.
function _afFlare(sh, near, away, dt, leaving) {
  var down = -_aeDot(sh.view, away), most = Math.sin(Math.PI / 2 * _smoothstep(AF_FLARE_LEVEL, AF_FLARE_FROM, near.alt / near.body.r));
  if (sh.lookDown || (leaving ? down >= most : down <= most)) return;   // (a finger on the look has the nose: the lever leaves it alone)
  // The nose turns the way a pilot moves it: about the craft's own wings, so the ground stays under its belly and the sky over its dome (turning it the short way to
  // level could leave it level and upside down). A craft whose up points at the ground is pitched the other way and rights itself after.
  var level = Math.asin(_aeClamp(down, -1, 1)), need = level - Math.asin(most), over = _aeDot(sh.up, away) * Math.cos(level) + down * Math.sin(level) >= 0;   // (over: pulled all the way up to level, its dome ends toward the sky)
  _afPitchNose(sh, (over ? 1 : -1) * _aeClamp(need, -_aeRad(AF_FLARE_DEG_S) * dt, _aeRad(AF_FLARE_DEG_S) * dt));
  if (!over) { sh.free = true; sh.tipped = true; }
}
// Held at a gas world's cloud tops (no ground under them) the right lever's way down is dimmed: there is nothing further down to go to.
function _afDeckLever(sh, on) {
  if (sh.deck === on) return;
  sh.deck = on;
  var el = _aeById('af-lever');
  if (el) el.classList.toggle('af-lever-floor', on);
}
// Another mode has the camera: standing, a visit, a mission, a hand-over.
function _afTaken() { return !!(_ae.stand || _ae.standUnder || _ae.standPending || _ae.site || _ae.mission || _ae.hand); }   // (standUnder: the ground drawing the orbit view under itself)
// The craft outlives the mode that takes the camera from it: it is parked (its controls put away, nothing drawn of it), and flies again when the
// view is the plain one once more (_aeShipWake, asked every frame of the main picture: no mode has to remember to bring it back).
function _afPark(sh) {
  _aeDbg('fly', 'park');
  _afGroundDrop(sh);
  _afBind(false);
  _afHud(false);
  if (sh.craft) sh.craft.root.visible = false;
  if (sh.arrived) _ae.arrived = null;
  _ae.ship = null;
  _ae.move = null;
  _ae.shipExit = null;
  var parked = _ae.shipParked = { landing: false, clear: false };   // landing: its ground is still being asked for; clear: the plain view has drawn a frame since the mode let go
  _aeRimSync(true);
  _aeMarkFly();
  return parked;
}
function _aeShipWake(sc) {
  var p = _ae.shipParked;
  if (!p || p.landing || _afTaken()) { if (p) p.clear = false; return; }
  // The craft comes in in front of the plain view's own camera, at rest: not while that is still on its way back, and not in the first frame
  // after a mode let go (the camera is still where the mode left it until this frame has placed it).
  if (_ae.fly || !p.clear) { p.clear = !_ae.fly; _ae.dirty = true; return; }
  _ae.shipParked = null;
  if (_aeFlyAble()) _afStart();
  _aeMarkFly();
  if (_ae.ship) _aeShipStep(sc);   // this frame draws it: its first step is this frame's
}
// Stopped where the autopilot was sent: the craft holds still and the body's card opens.
function _afArrive(sh, b) {
  sh.auto = null;
  sh.vel = [0, 0, 0];
  sh.arrived = b.key;
  if (AE_TARGETS[b.key]) { _ae.target = b.key; _aeArrive(b.key); }
  _aeMarkViews();
}
function _afLeaveArrival(sh) {
  sh.arrived = null;
  _ae.arrived = null;
  _aeRenderCard();
  _aeMarkViews();
}
// Down to the ground: the way out to Stand here at the point under the craft.
function _afLand(sh) {
  var body = sh.landing, key = body.key;
  sh.landing = null;
  if (sh.gnd && sh.gnd.key === key) {   // a ground is drawn under it, or about to be: the craft sets down on that one, once it is the picture and the craft is in it (and waits at its lowest height until then; the old way down would leave the craft behind)
    if (sh.gnd.live && sh.gnd.fr && sh.gnd.craft) _afSetDown(sh);   // (else the lever, still held, asks again next step)
    return;
  }
  if (typeof _aeRigLatLon !== 'function') { _aeStandReady().catch(function () {}); return; }   // Stand's files load in order and this name is in the last but one (almanac-standhost.js); the next push lands
  var under = _aeRigLatLon(key, sh.pos);   // (almanac-standhost.js, one of Stand's files)
  if (!under) return;
  var lat = under.lat, lon = under.lon;
  _afOrbitFromCraft(sh);   // the landing's flight starts from where the craft was, not from where the orbit camera was before the flight
  _ae.target = key;
  _ae.shipLanded = key;   // the ground's view came in a UFO: the lit UFO button (and Space) lifts off again
  _afPark(sh).landing = true;   // it waits on the ground, and flies again when the ground is left (by any way out)
  _aeStandAt(key, lat, lon).then(function (ok) {   // (the ground is asked for and comes a moment later: until it answers, nothing wakes the craft)
    if (_ae.shipParked) _ae.shipParked.landing = false;
    if (!ok) { _ae.shipLanded = null; _aeKick(); }
  });
  _afLandedKeys(true);
}
// Set down on a ground that is already the picture (the flight's ground, almanac-standhost.js): the craft stays where it hovers, on that ground, and the eye
// steps out behind it. The same ground, the same picture: Stand here takes it over as it is, and the camera goes from the chase view to the eye's.
var AF_STEP_BACK_M = 22;   // the eye stands this far behind the craft's rim (the whole craft in its picture)
function _afSetDown(sh) {
  _aeRigNextDrop(sh.gnd);   // (a finer ground on its way is not waited for: this one is stood on)
  var g = sh.gnd, st = g.st, fr = g.fr, p = _aeRigLocal(fr, sh.pos), v = _aeRigDir(fr, sh.view), heading = Math.atan2(v[0], v[1]);
  var back = sh.span / 2 * AF_M_PER_RE + AF_STEP_BACK_M, from = _aeRigCamNow(st);
  _afOrbitFromCraft(sh);   // the view the ground is left for, by the way out that is not the craft: over this place
  _ae.target = g.key;
  sh.gnd = null;   // (the ground is not let go with the flight: it is the one stood on)
  if (g.craft) g.craft.root.position.set(p[0], p[1], p[2]);   // (its drawn place was the hover's bob: set down it stands still at its own place, which is the one it lifts off from)
  var parked = _afPark(sh);
  parked.gnd = g; parked.craft = sh.craft;
  _ae.shipLanded = g.key;
  st.onDraw = _afParkedLight;
  st.parkedCraft = { I: sh.craft, copy: g.craft };
  _aeStandAdopt(st, g.pend, { x: p[0] - Math.sin(heading) * back, y: p[1] - Math.cos(heading) * back, heading: heading, from: from });
  st.prevRatio = g.prevRatio || st.prevRatio;   // (the picture's own sharpness, from before the ground first showed: what leaving the ground goes back to)
  _aeMarkFly();
  _afLandedKeys(true);
}
// The craft on the ground it was set down on, while its pilot walks about: lit by that ground's own Sun, for the eye's camera (its shader works in view space).
function _afParkedLight(st) {
  var pc = st.parkedCraft, fr = st.fr;
  if (!pc || !fr || !st.camera) return;
  var inv = st.camera.quaternion.clone().invert(), V = _ae.gl.THREE.Vector3, sun = new V(fr.sun[0], fr.sun[1], fr.sun[2]).applyQuaternion(inv), down = new V(0, 0, -1).applyQuaternion(inv);
  _afCraftLight(pc.I, sun, down, st.key, _aeClamp(0.35 + 0.65 * fr.sun[2], 0, 1));
}
// Lifting off. From a ground the craft was set down on, the craft takes its ground back and flies from where it stands (the lever climbs: no timed way up);
// from a ground reached the old way, the ground's own climb, and the parked craft flies again where that ends.
function _afTakeOff() {
  _aeDbg('fly', 'take off asked');
  var st = _ae.stand, parked = _ae.shipParked, g = parked && parked.gnd;
  if (!_ae.shipLanded || !st || !st.live || st.mode === 'ascend') return;
  if (!g || g.st !== st || !g.craft) { _aeStandLeave(); return; }
  var fr = _aeRigFrameOf(g), eye = _aeRigCamNow(st), c = g.craft.root.position, hd = st.yaw + st.userYaw;
  if (!fr || !_aeStandRelease(st)) { _aeStandLeave(); return; }
  st.onDraw = null; st.parkedCraft = null;
  _ae.shipParked = null;
  var sh = _ae.ship = _afNewShip(fr.origin, fr.e, fr.u);
  sh.gnd = g; g.fr = fr;
  sh.craft = parked.craft;
  // Everything of the lift-off is kept in the ground's own frame until the flight's first step: the main scene stood still while the ground was stood on (the
  // Moon has gone kilometres since), and only that step knows where the ground is now.
  sh.lifted = { p: _aeXyz(c), view: [Math.sin(hd), Math.cos(hd), 0], eye: eye, t0: performance.now() };
  _afLiftPlace(sh);
  _afLandedKeys(false);
  _afBegin();
}
function _afLiftPlace(sh) {
  var L = sh.lifted, fr = sh.gnd && sh.gnd.fr;
  if (!fr) { sh.lifted = null; return; }
  sh.pos = _aeRigWorld(fr, L.p);
  sh.view = _aeNorm(_aeRigWorldDir(fr, L.view));
  sh.up = sh.camUp = sh.ref = fr.u;
  sh.release = { t0: L.t0, look: _aeNorm(_aeRigWorldDir(fr, L.eye.fwd)), up: _aeNorm(_aeRigWorldDir(fr, L.eye.up)), fov: _aeDeg(L.eye.fov), pos: _aeRigWorld(fr, L.eye.pos) };
  if (sh.last) sh.lifted = null;   // (placed again by the first step, on the scene as it is then; not after)
}
var _afLandedOn = null;
function _afLandedKeys(on) {
  if (_afLandedOn) { window.removeEventListener('keydown', _afLandedOn, true); _afLandedOn = null; }
  if (!on) return;
  _afLandedOn = function (e) {
    if (!_ae.shipLanded || !_ae.stand) { _afLandedKeys(false); return; }
    if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || _aeTyping(e.target)) return;   // a slider holding the focus is not typing
    e.preventDefault(); _afTakeOff();
  };
  window.addEventListener('keydown', _afLandedOn, true);
}

// ── The camera: it stands off the craft, looks at it, and always finds a world to show ──
// Which bodies are in the picture from here: those that span a few pixels and lie inside the picture's width.
function _afSeen(sh, bodies, camPos, dir) {
  var tall = _aeRad(AE_FOV_DEG) / 2, half = Math.min(tall, Math.atan(Math.tan(tall) * (_ae.w / Math.max(_ae.h, 1)))) * AF_SEE_FIT;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i], rel = _aeSub(b.pos, camPos), d = _aeLen(rel);
    if (_aeDeg(Math.asin(Math.min(1, b.r / d))) * 2 < AF_SEE_MIN_DEG) continue;
    var disc = Math.asin(Math.min(1, b.r / d));   // (a camera skimming the ground may be inside the round figure of a flattened world: its horizon still shows)   // (a world wider than the picture shows as a horizon right across it: the picture's height is what it must reach into)
    if (Math.acos(_aeClamp(_aeDot(dir || sh.view, _aeScale(rel, 1 / d)), -1, 1)) - disc < (disc > tall ? tall * AF_SEE_FIT : half)) return b;   // its disc reaches into the picture (a world seen as a horizon has its centre far below)
  }
  return null;
}
// The world that shows biggest from a point.
function _afBiggest(bodies, pos) {
  var pick = null, pd = 0;
  for (var i = 0; i < bodies.length; i++) { var b = bodies[i], a = b.r / Math.max(_aeLen(_aeSub(b.pos, pos)), 1e-9); if (a > pd) { pd = a; pick = b; } }
  return pick;
}
// Is there a world in the picture: one that shows, or the biggest one, even a speck, held in the middle (there is no better one to turn to).
function _afHasWorld(sh, bodies, pos, pick, dir) {
  return !!_afSeen(sh, bodies, pos, dir) || !!(pick && _aeDot(sh.view, _aeNorm(_aeSub(pick.pos, pos))) > Math.cos(_aeRad(AF_ASSIST_DONE_DEG)));
}
// The camera looks a little past the craft toward the world it flies over (the one it goes to, else the nearest): the craft stands in the
// upper part of the picture and the world fills what is below or behind it. Answers the point looked at, or null.
function _afFrame(sh, pos, near, dt) {
  var subj = sh.auto ? _afBody(_afBodies(_ae.scene), sh.auto) : near.body;
  if (!subj) return null;
  var toCraft = _aeNorm(_aeSub(sh.pos, pos)), toSubj = _aeNorm(_aeSub(subj.pos, pos)), right = _aeNorm(_aeCross(toCraft, sh.camUp)), up = _aeNorm(_aeCross(right, toCraft));
  var half = _aeRad(AE_FOV_DEG) / 2, halfW = Math.atan(Math.tan(half) * (_ae.w / Math.max(_ae.h, 1)));
  var fwd = _aeDot(toSubj, toCraft), ax = Math.atan2(_aeDot(toSubj, right), fwd), ay = Math.atan2(_aeDot(toSubj, up), fwd);
  var tx = _aeClamp(ax, -AF_FRAME_SHIFT * halfW, AF_FRAME_SHIFT * halfW), ty = _aeClamp(ay, -AF_FRAME_SHIFT * half, AF_FRAME_SHIFT * half);
  if (fwd < -0.3) tx = ty = 0;   // behind the camera: nothing to show that way
  // Low over a surface the horizon is what to show: the view is pitched so it stands a share of the way up the picture, whatever the height.
  if (subj === near.body) {
    var w = 1 - _smoothstep(AF_HORIZON_FROM, AF_HORIZON_TO, near.alt / subj.r), rel = _aeSub(pos, subj.pos), dc = Math.max(_aeLen(rel), subj.r), away = _aeScale(rel, 1 / dc);
    var dip = Math.acos(_aeClamp(subj.r / dc, -1, 1)), want = _aeClamp(-(dip + AF_HORIZON_UP * half) - Math.asin(_aeClamp(_aeDot(toCraft, away), -1, 1)), -AF_FRAME_SHIFT * half, AF_FRAME_SHIFT * half);
    ty += (want - ty) * w;
  }
  var k = 1 - Math.exp(-dt * AF_CAM_SPRING_S);
  sh.frameX = (sh.frameX || 0) + (tx - (sh.frameX || 0)) * k;
  sh.frameY = (sh.frameY || 0) + (ty - (sh.frameY || 0)) * k;
  var dir = _afRot(_afRot(toCraft, up, -sh.frameX), right, sh.frameY);
  return _aeAdd(pos, _aeScale(dir, _aeLen(_aeSub(sh.pos, pos))));
}
function _afCamera(sh, bodies, dt) {
  if (sh.hold) {   // nothing moves until a hand does
    var h = sh.hold, hp = _aeAdd(h.at, h.off);
    sh.camUp = h.up;
    sh.pose = { pos: hp, up: h.up, look: h.look, tp: _aeAdd(hp, h.look), fov: h.fov, nearRe: h.nearRe };
    sh.shown = _afShown(sh, sh.near.body);
    return;
  }
  var k = 1 - Math.exp(-dt * AF_CAM_SPRING_S), s = sh.span, still = _aeReduceMotion(), near = sh.near, pos, look;
  // Up is away from the ground when the craft is near one, the sky's north far out; it eases, so a turn over a world is smooth.
  var upWant = near.d < near.body.r * AF_UP_NEAR ? _aeNorm(_aeSub(sh.pos, near.body.pos)) : [0, 0, 1];
  sh.ref = still ? upWant : _aeNorm(_aeAdd(sh.ref, _aeScale(_aeSub(upWant, sh.ref), k)));
  var lf = _afLookFrame(sh);
  sh.camUp = lf.up;
  pos = _aeAdd(_aeSub(sh.pos, _aeScale(lf.dir, s * AF_CHASE_BACK)), _aeScale(sh.camUp, s * AF_CHASE_UP));   // flying is one view: behind the craft
  look = sh.pos;
  var ahead = _afFrame(sh, pos, near, dt);
  if (ahead) look = ahead;
  // Never an empty picture: with no world in it for a moment and no hand on the look, the view turns to the one that shows biggest
  // (the one the autopilot goes to, when it flies).
  var pick = _afBiggest(bodies, pos), seen = sh.auto || _afHasWorld(sh, bodies, pos, pick, _aeNorm(_aeSub(look, pos)));   // (where the picture looks, not the nose: low over a world it is tipped to the horizon)
  sh.blind = seen ? 0 : sh.blind + dt;
  if (seen) sh.assist = false;
  _afFind(sh, pos, look, pick, seen);
  var fov = AE_FOV_DEG;
  sh.pose = { pos: pos, up: sh.camUp, look: _aeNorm(_aeSub(look, pos)), tp: look, fov: fov, nearRe: Math.max(1e-12, s * 0.05) };
  if (sh.release) {   // the picture was held as it was: it turns to this framing, not at once
    var rl = sh.release, e = _aeReduceMotion() ? 1 : _aeSmoother((performance.now() - rl.t0) / (rl.pos ? AF_LIFT_MS : AF_RELEASE_MS));
    if (e >= 1) sh.release = null;
    else {
      var P = sh.pose;
      if (rl.pos) P.pos = _aeAdd(_aeScale(rl.pos, 1 - e), _aeScale(P.pos, e));   // (lifting off: from the eye that stood beside the craft)
      var lk = _aeNorm(_aeAdd(_aeScale(rl.look, 1 - e), _aeScale(P.look, e)));
      // The craft may fly off while the picture is still turning to its framing: the look is never more than a share of the picture's width from it.
      // (Lifting off, the eye may have been looking anywhere: the craft is brought into the picture as the move goes, not at its first frame.)
      var toC = _aeNorm(_aeSub(sh.pos, P.pos)), halfW = Math.atan(_aeTanHalf(P.fov) * (_ae.w / Math.max(_ae.h, 1))), keep = AF_RELEASE_KEEP * Math.min(halfW, _aeRad(P.fov) / 2) + (rl.pos ? Math.PI * (1 - e) : 0), angC = Math.acos(_aeClamp(_aeDot(lk, toC), -1, 1));
      if (angC > keep) lk = _aeNorm(_aeAdd(_aeScale(toC, Math.sin(angC - keep) / Math.sin(angC)), _aeScale(lk, Math.sin(keep) / Math.sin(angC))));
      P.look = lk; P.up = _aeNorm(_aeAdd(_aeScale(rl.up, 1 - e), _aeScale(P.up, e))); P.fov = rl.fov + (P.fov - rl.fov) * e;
      P.tp = _aeAdd(P.pos, _aeScale(lk, _aeLen(_aeSub(look, pos))));
    }
  }
  sh.shown = _afShown(sh, sh.auto ? _afBody(bodies, sh.auto) : near.body);
}
// With no world in the picture an arrow at its middle points the way to the biggest one (the craft is never turned to it: the nose stays where the hand left it).
var AF_FIND_S = 0.4, AF_FIND_R_PX = 110;
function _afFind(sh, pos, look, pick, seen) {
  var el = _aeById('af-find');
  if (!el) return;
  var show = !seen && !!pick && sh.blind > AF_FIND_S;
  if (el.hidden !== !show) el.hidden = !show;
  if (!show) return;
  var rel = _aeSub(pick.pos, pos), dir = _aeNorm(_aeSub(look, pos)), up = sh.camUp, right = _aeNorm(_aeCross(dir, up));
  var ang = Math.atan2(_aeDot(rel, right), _aeDot(rel, up));
  el.style.transform = 'rotate(' + ang + 'rad) translateY(-' + AF_FIND_R_PX + 'px)';
}
// What the picture shows of the world the craft flies over: whether its centre is in the picture, and how much of the picture's height it
// covers (its disc, or the horizon of a near one).
function _afShown(sh, b) {
  var P = sh.pose, rel = _aeSub(b.pos, P.pos), d = _aeLen(rel), half = _aeRad(P.fov) / 2;
  var off = Math.acos(_aeClamp(_aeDot(_aeScale(rel, 1 / d), P.look), -1, 1)), diam = 2 * Math.asin(Math.min(1, b.r / Math.max(d, 1e-12)));
  return { key: b.key, inPicture: off < half || (d > b.r && off - diam / 2 < half * 0.9), cover: Math.min(1, diam / (2 * half)) };
}
function _aeShipCam(c) {
  var s = _ae.ship;
  if (!s.pose) return c;
  return { tp: s.pose.tp, az: 0, el: 0, dist: 1, tanHalf: _aeTanHalf(s.pose.fov), roll: 0, frame: null, pose: s.pose };
}
function _aeShipNear(near) {
  var s = _ae.ship;
  return s && s.pose ? _aeClamp(s.pose.nearRe, 1e-12, near) : near;
}
// ── The craft: our own UFO ──
// One smooth lens, pale and featureless, with a glowing seam round its edge and a soft halo, built here from a profile (no file):
// it reads against black, is lit by the Sun, and is the same from every side, so it needs no heading and no banking.
var AF_THREE_ADDITIVE = 2;   // three's AdditiveBlending
var AF_UFO_SEGS = 48, AF_UFO_Y0 = 0.1325;   // segments round; the profile is shifted down this much so the whole craft is centred
// The saucer's profile (radius, height), a section each: the underside, the flange at the seam, the hull, the dome. A section's own vertices keep its
// edges crisp. The lens width is 2 (radius 1 at the flange), as before, so it is as wide on the screen.
var AF_UFO_PROFILE = [
  [[0, -0.27], [0.3, -0.27], [0.5, -0.25], [0.7, -0.2], [0.86, -0.13], [0.96, -0.07]],
  [[0.96, -0.07], [0.995, -0.04], [1, -0.012], [1, 0.016], [0.985, 0.04], [0.96, 0.062]],
  [[0.96, 0.062], [0.84, 0.11], [0.7, 0.16], [0.58, 0.2], [0.5, 0.225]],
  [[0.49, 0.225], [0.475, 0.29], [0.44, 0.36], [0.375, 0.43], [0.285, 0.485], [0.16, 0.52], [0, 0.535]]
];
var AF_UFO_BOB = 0.05, AF_UFO_BOB_HZ = 0.35;   // hovering, the lens rides up and down by this share of its width, this many times a second (drawn only: the craft's place is unmoved)
var AF_UFO_RED_BASE = 0.4;   // in Red mode the lens's own light is dimmed so the seam still stands out from it
var AF_UFO_HALO = 3.4, AF_UFO_GLOW = [0.55, 0.82, 1.0], AF_UFO_GLOW_RED = [1.0, 0.25, 0.2];   // the halo's width in lens radii; the glow's colour
var AF_UFO_VERT = 'attribute float sec; varying vec3 vP; varying vec3 vNV; varying vec3 vV; varying float vSec;' +
  'void main() { vP = position; vSec = sec; vNV = normalize(normalMatrix * normal);' +
  ' vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }';
// Four materials by section: the underside (pearl, a darker ring round the middle), the flange (bright metal with the running lights that chase round
// it), the hull (pearl, brushed in rings) and the dome (glass, lit faintly from inside). All in view space (directions come in as uniforms).
var AF_LAP_S = 3;   // seconds for the lights' colours and chase to go once round the rim
var AF_UFO_FRAG = 'uniform vec3 sunDir; uniform vec3 worldDir; uniform vec3 worldCol; uniform float worldAmt; uniform vec3 glow; uniform float base; uniform float time; uniform float rainbow;' +
  'varying vec3 vP; varying vec3 vNV; varying vec3 vV; varying float vSec;' +
  'vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }' +
  'void main() { vec3 n = normalize(vNV), v = normalize(vV), L = normalize(sunDir), W = normalize(worldDir);' +
  ' float nv = max(dot(n, v), 0.0), fres = pow(1.0 - nv, 3.0), rad = length(vP.xz);' +
  ' float under = step(vSec, 0.5), flange = step(0.5, vSec) * step(vSec, 1.5), dome = step(2.5, vSec);' +
  ' float ring = 0.5 + 0.5 * sin(rad * 150.0 + sin(atan(vP.z, vP.x) * 3.0) * 0.6);' +
  ' float sunLit = max(dot(n, L), 0.0), lowW = max(dot(n, W) * 0.5 + 0.5, 0.0) * worldAmt;' +
  ' vec3 pearl = vec3(0.80, 0.82, 0.88) * (0.9 + 0.1 * ring);' +
  ' pearl *= 1.0 - under * (0.35 + 0.35 * smoothstep(0.42, 0.5, rad) * smoothstep(0.76, 0.66, rad));' +   // the darker ring on the underside
  ' pearl = mix(pearl, vec3(0.9, 0.92, 0.96), flange * 0.6);' +
  ' vec3 col = pearl * (0.10 + 0.78 * sunLit) + worldCol * pearl * lowW * 0.55;' +
  ' vec3 H = normalize(L + v); float nh = max(dot(n, H), 0.0), sp = pow(nh, 70.0) * 1.1 + pow(nh, 12.0) * 0.18 * (0.6 + 0.4 * ring);' +
  ' col += vec3(1.0, 0.97, 0.92) * sp * step(0.0, dot(n, L)) * (1.0 - dome * 0.3);' +
  ' vec3 R = reflect(-v, n); float toW = smoothstep(-0.3, 0.9, dot(R, W));' +
  ' col += (worldCol * toW * worldAmt * 0.5 + vec3(0.02, 0.025, 0.04)) * (0.12 + 0.88 * fres);' +
  ' col += (0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + (1.0 - nv) * 1.4))) * fres * 0.10 * (0.3 + 0.7 * sunLit) * (1.0 - dome);' +
  // The glass dome: dark tint, a soft light from inside that breathes, a sharp Sun glint and a strong edge reflection.
  ' float breathe = 0.65 + 0.35 * sin(time * 0.9);' +
  ' vec3 glass = glow * (0.20 + 0.50 * nv) * breathe + vec3(0.02, 0.04, 0.07) + (worldCol * toW * worldAmt * 0.35 + vec3(0.05, 0.07, 0.1)) * (0.2 + 0.8 * fres) + vec3(1.0) * pow(nh, 160.0) * 1.4 * step(0.0, dot(n, L));' +
  ' col = mix(col, glass, dome);' +
  ' float a = atan(vP.z, vP.x), cell = (a / 6.2831853 + 0.5) * 12.0, idx = floor(cell), local = fract(cell) - 0.5;' +
  ' float lampBand = flange * smoothstep(0.075, 0.0, abs(vP.y + ' + AF_UFO_Y0 + ' - 0.002));' +
  // Twelve lights, each its own hue, red round to violet; the colours and the bright one travel round the rim (a lap in a few seconds, both the same way), so the
  // rainbow is seen to run (full saturation); in Red mode every one is red.
  ' float spot = smoothstep(0.5, 0.08, abs(local)), pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * cos(idx * 0.5236 - time * ' + (2 * Math.PI / AF_LAP_S).toFixed(4) + '), 2.0);' +
  ' vec3 lampCol = mix(glow, hue(idx / 12.0 - time * ' + (1 / AF_LAP_S).toFixed(4) + '), rainbow);' +
  ' lampCol = lampCol * 1.15 + pow(spot, 3.0) * 0.35;' +
  ' col = col * base + (lampCol * lampBand * (0.3 + 1.7 * spot * pulse)) * breathe + glow * fres * 0.12 * (1.0 - dome);' +
  ' col += hue(time * 0.05 + 0.5) * rainbow * dome * 0.10 * (0.2 + 0.8 * nv) * breathe;' +
  ' gl_FragColor = vec4(col, 1.0); }';
var AF_HALO_VERT = 'varying vec2 vUv; void main() { vUv = position.xy; gl_Position = projectionMatrix * (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0) + vec4(position.xy * modelMatrix[0][0], 0.0, 0.0)); }';
var AF_HALO_FRAG = 'uniform vec3 glow; varying vec2 vUv; void main() { float r = length(vUv); if (r > 1.0) discard; float a = pow(1.0 - r, 2.6) * 0.55; gl_FragColor = vec4(glow * a, a); }';
function _afUfoGeometry(THREE) {
  var pos = [], nrm = [], sec = [], idx = [], base = 0, row = AF_UFO_SEGS + 1;
  AF_UFO_PROFILE.forEach(function (pts, si) {
    pts.forEach(function (pt, i) {
      var a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)], dx = b[0] - a[0], dy = b[1] - a[1], nl = Math.hypot(dx, dy) || 1;
      var nr = dy / nl, ny = -dx / nl;   // outward: the profile runs from the underside out and up and in over the top
      for (var j = 0; j <= AF_UFO_SEGS; j++) {
        var an = 2 * Math.PI * j / AF_UFO_SEGS, ca = Math.cos(an), sa = Math.sin(an);
        pos.push(pt[0] * ca, pt[1] - AF_UFO_Y0, pt[0] * sa);
        nrm.push(nr * ca, ny, nr * sa);
        sec.push(si);
      }
    });
    for (var i = 0; i < pts.length - 1; i++) for (var j = 0; j < AF_UFO_SEGS; j++) {
      var p = base + i * row + j;
      idx.push(p, p + row, p + 1, p + 1, p + row, p + row + 1);
    }
    base += pts.length * row;
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('sec', new THREE.BufferAttribute(new Float32Array(sec), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  return g;
}
var AF_PLANETSHINE = { earth: [0.35, 0.55, 1.0], moon: [0.72, 0.72, 0.74], mars: [1.0, 0.55, 0.38], venus: [1.0, 0.9, 0.6], mercury: [0.7, 0.65, 0.6], jupiter: [0.95, 0.78, 0.6], saturn: [0.95, 0.88, 0.65], uranus: [0.6, 0.85, 0.9], neptune: [0.4, 0.55, 1.0] };
var AF_PLANETSHINE_DEFAULT = [0.7, 0.7, 0.75];
var AF_UFO_LEAN = 0.09, AF_UFO_LEAN_EASE = 6;            // the lens leans into a slide or a turn by at most this (radians) and settles at this rate a second
var AF_UFO_HALO_COL = [0.62, 0.74, 0.95];   // the halo and the rim (the dome's glow turns through the hues in the shader)
function _afUfoBuild(S) {
  var T = S.THREE, V3 = T.Vector3, glow = { value: new V3(AF_UFO_GLOW[0], AF_UFO_GLOW[1], AF_UFO_GLOW[2]) }, sun = { value: new V3(1, 0, 0) }, base = { value: 1 };
  var world = { value: new V3(0, -1, 0) }, worldCol = { value: new V3(0.7, 0.7, 0.75) }, worldAmt = { value: 0 }, time = { value: 0 }, rainbow = { value: 1 };
  var body = new T.Mesh(_afUfoGeometry(T), new T.ShaderMaterial({ uniforms: { sunDir: sun, worldDir: world, worldCol: worldCol, worldAmt: worldAmt, glow: glow, base: base, time: time, rainbow: rainbow }, vertexShader: AF_UFO_VERT, fragmentShader: AF_UFO_FRAG }));
  var q = new T.BufferGeometry();
  q.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  q.setIndex(new T.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  var halo = new T.Mesh(q, new T.ShaderMaterial({ uniforms: { glow: glow }, vertexShader: AF_HALO_VERT, fragmentShader: AF_HALO_FRAG, transparent: true, depthWrite: false, blending: AF_THREE_ADDITIVE }));
  halo.renderOrder = 2;
  body.frustumCulled = halo.frustumCulled = false;
  var root = new T.Group();
  root.add(body); root.add(halo);
  S.scene.add(root);
  return { root: root, body: body, halo: halo, sun: sun, glow: glow, base: base, world: world, worldCol: worldCol, worldAmt: worldAmt, time: time, rainbow: rainbow, lean: [0, 0] };
}
// A world-space direction in the camera's own frame (the shader works in view space).
function _afViewDir(S, d) {
  var v = new S.THREE.Vector3(d[0], d[1], d[2]);
  return v.applyQuaternion(S.camera.quaternion.clone().invert());
}
// After the camera: the lens at the ship's place, its axis along up, lit from the Sun and by the world below.
function _aeShipDraw() {
  var sh = _ae.ship, S = _ae.gl;
  _afRefs(sh);
  if (!sh.craft) sh.craft = S.ufo || (S.ufo = _afUfoBuild(S));   // built once for the view: a new craft at every flight left two geometries and their programs behind
  var I = sh.craft, V = S.THREE.Vector3, still = _aeReduceMotion();
  if (I.root.parent !== S.scene) S.scene.add(I.root);   // (_afStop takes it out of the scene, and the next flight reuses the same craft: on, off, on drew nothing)
  I.root.visible = true;
  var r = sh.span / 2, now = performance.now() / 1000, near = sh.near, sun = _aeNorm(_aeSub(_aeSunShown(_ae.scene), sh.pos));
  var bob = still || _aeLen(sh.vel) > 0 ? 0 : sh.span * AF_UFO_BOB * Math.sin(2 * Math.PI * AF_UFO_BOB_HZ * now);
  I.root.position.set(sh.pos[0] + sh.up[0] * bob, sh.pos[1] + sh.up[1] * bob, sh.pos[2] + sh.up[2] * bob);
  I.body.scale.setScalar(r);
  I.halo.scale.setScalar(r * AF_UFO_HALO);
  var ax = sh.up;   // the lens's axis is the craft's up: seen from behind and a little above it never shows its flat face end-on
  // It leans a little into a slide (and the way it goes), eased, never banked far: the same lens from every side, so only the light shows it.
  var ask = sh.ask || { f: 0, t: 0 }, right = _aeNorm(_aeCross(sh.view, ax)), k = 1 - Math.exp(-AF_UFO_LEAN_EASE * Math.min(0.05, now - (I.at || now - 0.016)));
  I.lean[0] += ((still || sh.auto ? 0 : ask.t * AF_UFO_LEAN) - I.lean[0]) * k;
  I.lean[1] += ((still || sh.auto ? 0 : ask.f * AF_UFO_LEAN * 0.6) - I.lean[1]) * k;
  I.at = now;
  var tilted = _aeNorm(_aeAdd(_aeAdd(ax, _aeScale(right, I.lean[0])), _aeScale(sh.view, I.lean[1])));
  I.body.quaternion.setFromUnitVectors(new V(0, 1, 0), new V(tilted[0], tilted[1], tilted[2]));
  I.axis = tilted;   // (the ground's own copy of the craft stands the same way: almanac-standhost.js)
  var sv = _afViewDir(S, sun), wd = _aeNorm(_aeSub(near.body.pos, sh.pos)), wv = _afViewDir(S, wd);
  // How much the world below lights the craft: the share of its disc the Sun lights as seen from here, and how much of the sky it fills.
  var toCraft = _aeNorm(_aeSub(sh.pos, near.body.pos)), sunFromBody = _aeNorm(_aeSub(_aeSunShown(_ae.scene), near.body.pos));
  var phase = _aeClamp(0.35 + 0.65 * _aeDot(toCraft, sunFromBody), 0, 1), fill = _aeClamp(Math.asin(Math.min(1, near.body.r / Math.max(near.d, 1e-9))) / 1.2, 0, 1);
  _afCraftLight(I, sv, wv, near.body.key, near.body.key === 'sun' ? 0 : phase * (0.25 + 0.75 * fill));
}
// The craft's light, for the camera that draws it: the Sun's way and the way to the world below (both in that camera's own frame), which world, and how much it lights.
function _afCraftLight(I, sunView, worldView, key, worldAmt) {
  var red = document.documentElement.classList.contains('night-red'), col = AF_PLANETSHINE[key] || AF_PLANETSHINE_DEFAULT;
  I.sun.value.set(sunView.x, sunView.y, sunView.z);
  I.world.value.set(worldView.x, worldView.y, worldView.z);
  I.worldCol.value.set(col[0], col[1], col[2]);
  I.worldAmt.value = worldAmt;
  I.time.value = performance.now() / 1000;   // (seconds; a wrap would jump the lights' pulse)
  var hc = red ? AF_UFO_GLOW_RED : AF_UFO_HALO_COL;   // the halo and the rim are a pale cool white: the colour is the lights'
  I.glow.value.set(hc[0], hc[1], hc[2]);
  I.base.value = red ? AF_UFO_RED_BASE : 1;
  I.rainbow.value = red ? 0 : 1;   // Jack's rainbow; Red mode keeps to red
}


// The flight run ahead by `seconds` of its own time without drawing (a slow device, or a test that asks where the ship ends up).
function _afAdvance(seconds) {
  for (var t = 0; t < seconds && _ae.ship; t += AF_STEP_MAX_S) _aeShipStep(_ae.scene, AF_STEP_MAX_S);
}

// Down to a world's surface (a ground it lands on, else the cloud tops of a world with none): the autopilot goes to it, then the lever is held down for the
// craft, until it sets down or a hand takes the controls ("the surface button should work on any planet and take the UFO down there").
function _afDive(key) {
  var sh = _ae.ship;
  if (!sh || !_aeFlyGoTo(key).ok) return false;
  sh.dive = key;
  return true;
}
// ── Where to: a body chosen (a chip, a name, a tap) is where the ship goes ──
// The one contract every vehicle keeps (the rover's _aeDriveGoTo): _aeFlyGoTo(target) sets the ship off and answers
// { ok, distM, seconds } or { ok: false, reason }; any hand on the controls takes the ship back. A target is a body's key
// or { body: key }. distM is the real distance, seconds how long the flight takes at the ship's own pace.
function _aeFlyGoTo(target) {
  var sh = _ae.ship, key = target && typeof target === 'object' ? target.body : target;
  if (!sh || !_ae.scene) return { ok: false, reason: 'not flying' };
  var bodies = _afBodies(_ae.scene), b = _afBody(bodies, key);
  if (!b) return { ok: false, reason: 'target' };
  _afRelease(sh);
  sh.free = true;   // the autopilot points the nose where it goes, and it stays so: Level puts the horizon back
  if (sh.arrived) _afLeaveArrival(sh);
  sh.auto = key;
  sh.from = sh.near ? sh.near.body.key : null;
  _afThrottleSet(sh, 0);   // the autopilot flies it: the throttle is at stop when it hands the craft back
  _ae.preset = key;
  _aeMarkViews();
  _aeKick();
  var distM = _afRealKm(sh, bodies, b.pos) * 1000;
  return { ok: true, distM: distM, seconds: _afEta(sh, bodies, b) };
}
// The real kilometres of a straight run from the ship to a point: the drawing's stretch changes along the way, so it is summed in steps.
var AF_PATH_STEPS = 48;
function _afRealKm(sh, bodies, to) {
  var span = _aeSub(to, sh.pos), dir = _aeNorm(span), sunAt = _aeSunShown(_ae.scene), km = 0;
  for (var i = 0; i < AF_PATH_STEPS; i++) {
    var mid = _aeAdd(sh.pos, _aeScale(span, (i + 0.5) / AF_PATH_STEPS)), at = { pos: mid, nonSun: _afNonSunNear(bodies, mid) };
    km += _aeLen(span) / AF_PATH_STEPS * _afRealKmPerRe(at, _ae.scene, at, dir, sunAt);
  }
  return km;
}
// How long the autopilot takes: the pace (it follows the height over the nearest surface) run straight at the body, the bodies
// where they stand now.
var AF_ETA_STEP_S = 0.1, AF_ETA_MAX_S = 600;
function _afEta(sh, bodies, goal) {
  var pos = sh.pos, t = 0, stop = _afStopAt(goal);
  while (t < AF_ETA_MAX_S) {
    var left = _aeLen(_aeSub(goal.pos, pos)) - stop;
    if (left <= goal.r * AF_ARRIVE_EPS) break;
    pos = _aeAdd(pos, _aeScale(_afWay(bodies, pos, goal), Math.min(_afAutoSpeed(_afNearest(bodies, pos).alt, left, goal.r) * AF_ETA_STEP_S, left)));
    t += AF_ETA_STEP_S;
  }
  return Math.max(1, Math.round(t));
}
// While flying the Planets chip opens the Go sheet (its rows are the planets' own pictures); any other body chosen is where the ship goes.
// A world picked while flying is where the ship goes. The two whole views (the solar system, Side by side) are not places
// to fly to: the ship is left and the view opens, as it would from anywhere else.
function _afPreset(name) {
  if (name === 'planets' || name === AE_SPIN_KEY) { _afStop(true); return false; }
  _aeFlyGoTo(name);
  return true;
}


// ── The worlds it is flying among, named: the one it goes to (or the nearest) and the Sun, and the few nearest the middle of the picture ──
// The first two are a small tag where the world stands in the picture, or held at the edge of the picture, pointing, when it is out of it. The others are named
// only where they stand in the picture, at any distance (a point far off is a world with a name: heading for Jupiter, it said nothing), the nearest the middle first.
var AF_REF_MARGIN_PX = 14, AF_REF_STACK_PX = 24, AF_REF_BOTTOM_PX = 160, AF_REF_UNDER_PX = 14, AF_REF_ARROWS = ['\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196', '\u2191', '\u2197'];
var AF_REF_FEW = 3, AF_REF_APART_X_PX = 70, AF_REF_APART_Y_PX = 22;   // how many more worlds in the picture are named, and how far apart two names stand at least (else the farther from the middle goes)
// The worlds in the picture to name besides `taken`: projected inside it and not behind another, nearest the middle first; none the view itself already names, and
// a moon only beside its own planet (its planet is `taken`: from Mars, Jupiter is the name, not Ganymede's).
function _afRefFew(bodies, taken) {
  var w = _ae.w, h = _ae.h, list = [];
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i], mark = _aeById('ae-bm-' + b.key);
    var pb = _aePlanetBody(b.key);
    if (taken.indexOf(b.key) >= 0 || (pb && pb.parent && taken.indexOf(pb.parent) < 0) || (mark && !mark.hidden && !mark.classList.contains('ae-bm-quiet'))) continue;
    var p = _aeProject(b.pos);
    if (!p || p.x < AF_REF_MARGIN_PX || p.x > w - AF_REF_MARGIN_PX || p.y < AF_REF_MARGIN_PX + 64 || p.y > h - AF_REF_BOTTOM_PX || _aeBehindAny(b.key, b.pos, true)) continue;
    list.push({ key: b.key, p: p, off: Math.hypot(p.x - w / 2, p.y - h / 2) });
  }
  list.sort(function (a, b) { return a.off - b.off; });
  var out = [];
  for (i = 0; i < list.length && out.length < AF_REF_FEW; i++) {
    if (out.some(function (o) { return Math.abs(o.p.x - list[i].p.x) < AF_REF_APART_X_PX && Math.abs(o.p.y - list[i].p.y) < AF_REF_APART_Y_PX; })) continue;
    out.push(list[i]);
  }
  return out.map(function (o) { return o.key; });
}
var AF_REF_RING_MIN_PX = 14, AF_REF_RING_PAD_PX = 6;   // a world's ring stands this far off its drawn disc, and is never smaller than this
var AF_REF_DISC_MAX_PX = 60, AF_REF_DISC_MIN_PX = 1.5;   // a ring only where the world is far off ("ring only at a distance"): none once its disc is this big, and none round a point with no disc to ring (but the goal's)
function _afDiscR(b) {   // the radius, in px, of a world's drawn disc
  var cam = _ae.gl.camera, d = Math.max(1e-9, _aeLen(_aeSub(b.pos, _aeXyz(cam.position))));
  return b.r / d * _aePxPerRad(cam);
}
function _afRingR(b) {   // the radius, in px, of the ring round a world as the view draws it
  return Math.min(Math.max(_ae.w, _ae.h), Math.max(AF_REF_RING_MIN_PX, _afDiscR(b) + AF_REF_RING_PAD_PX));
}
function _afRefs(sh) {
  var host = _aeById('af-refs');
  if (!host || !_ae.scene) return;
  var bodies = _afBodies(_ae.scene), now = performance.now(), i;
  var goal = sh.auto ? sh.auto : sh.near.body.key !== 'sun' ? sh.near.body.key : null;
  if (!(now - sh.refAt < AF_HUD_TICK_MS)) { sh.refAt = now; sh.refFew = _afRefFew(bodies, [goal, 'sun', sh.near.body.key]); }   // which few: chosen at the readout's pace, placed every frame
  var keys = [goal, goal !== 'sun' ? 'sun' : null].concat(sh.refFew.filter(function (k) { return k !== goal; }));
  var stacked = 0;
  for (i = 0; i < host.children.length; i++) {
    var el = host.children[i], key = keys[i], b = key && _afBody(bodies, key);
    if (b && key === sh.near.body.key && !sh.auto && sh.near.alt < b.r * AF_HORIZON_FROM) b = null;   // low over a world it is the whole picture: the readout names it, and nothing points at its middle
    if (!b) { el.hidden = true; continue; }
    var p = _aeProject(b.pos), w = _ae.w, h = _ae.h, ang = 0, out = false, x, y;
    if (!p) { out = true; p = { x: w / 2, y: h - AF_REF_BOTTOM_PX + stacked++ * AF_REF_STACK_PX }; ang = Math.PI / 2; }   // behind the eye: pointing down, held above the row of worlds, never under it
    else {
      x = _aeClamp(p.x, AF_REF_MARGIN_PX, w - AF_REF_MARGIN_PX); y = _aeClamp(p.y, AF_REF_MARGIN_PX + 64, h - AF_REF_BOTTOM_PX);
      out = x !== p.x || y !== p.y;
      if (out) { ang = Math.atan2(p.y - y, p.x - x); y += stacked++ * AF_REF_STACK_PX; }
      p = { x: x, y: y };
    }
    if (!out) { var disc = _afDiscR(b); if (disc > AF_REF_DISC_MAX_PX || (key !== goal && disc < AF_REF_DISC_MIN_PX)) { el.hidden = true; continue; } }   // (near, the world is the picture and its ring stuck round it; a point is nothing to ring)
    el.hidden = false;
    var t = _aeGoName(key);   // the name only: how far it is, is the view's own readout's to say (_ae.move), once
    el.dataset.key = key;
    var ringR = out ? 0 : _afRingR(b), under = !out && _aeHudCovers(p.x - ringR, p.y - ringR, 2 * ringR, 2 * ringR);   // a ring would sit over a control (a world up in the corner): it is named, clear of them, instead
    if (!out && !under) {   // in the picture a world is ringed, never named across its face: the goal's ring is bright, the others' faint ("circle and highlight the planet")
      var ringKey = 'ring ' + t;
      el.classList.add('af-ring'); el.classList.toggle('af-goal', key === goal);
      if (el._said !== ringKey) { _aeSetText(el, ''); el._said = ringKey; el.setAttribute('aria-label', _aeT('alm_go_to') + ': ' + t); }
      el.style.width = el.style.height = Math.round(2 * ringR) + 'px';
      el.style.transform = 'translate(' + Math.round(p.x - ringR) + 'px,' + Math.round(p.y - ringR) + 'px)';
      continue;
    }
    el.classList.remove('af-ring', 'af-goal'); el.style.width = el.style.height = '';
    var said = under ? t : AF_REF_ARROWS[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8] + ' ' + t;   // (a name hung under its world needs no arrow)
    if (el._said !== said) { _aeSetText(el, said); el._said = said; el._w = el.offsetWidth; el._h = el.offsetHeight; el.setAttribute('aria-label', _aeT('alm_go_to') + ': ' + t); }   // (measured when its words change, not every frame)
    // Held at the edge it lies along that edge; in the picture it hangs centred under its world. Either way it stands clear of the controls (the layer's word).
    var at = _aeHudClear(out ? (p.x < w / 2 ? p.x : p.x - el._w) : p.x - el._w / 2, out ? p.y - el._h / 2 : p.y + AF_REF_UNDER_PX, el._w, el._h);
    el.style.transform = 'translate(' + Math.round(at.x) + 'px,' + Math.round(at.y) + 'px)';
  }
}

// A world's name tapped is the hint taken: the craft flies there (the autopilot, as a world chosen in the row). The press is the name's, not the look's.
function _afRefsBind(host) {
  host.addEventListener('click', function (e) {
    var el = e.target.closest('.af-ref'), key = el && el.dataset.key;
    if (!key) return;
    e.stopPropagation();
    _afHintDone();
    _afPreset(key);
  });
}

// The view's row of worlds marks the one the craft is nearest (the one it goes to, while the autopilot flies), never one it has left. A
// world must be clearly nearer than the marked one to take the mark (in body radii of height), so it does not flicker between two.
function _afRowFollow(sh, near) {
  var key = near.body.key, cur = _afBody(_afBodies(_ae.scene), _ae.target);
  if (sh.auto || !AE_TARGETS[key] || key === _ae.target) return;
  var curAlt = cur ? (_aeLen(_aeSub(sh.pos, cur.pos)) - cur.r) / cur.r : Infinity;
  if (near.alt / near.body.r > curAlt * AF_ROW_HYST) return;
  _ae.target = key;
  _ae.preset = null;
  _aeMarkViews();
  _aeRenderCard();
}
// ── The readout: speed in real units, how long the Sun's light takes, where it is ──
function _afReadout(sh, sc, bodies, near) {
  var v = _aeLen(sh.vel), dir = v > 1e-12 ? _aeScale(sh.vel, 1 / v) : sh.view, sunAt = _aeSunShown(sc);
  near.nonSun = _afNonSunNear(bodies, sh.pos);
  var kmS = v * _afRealKmPerRe(sh, sc, near, dir, sunAt), c = SPEED_OF_LIGHT_KM_S, text;
  if (kmS >= c) text = '×' + _orrNum(kmS / c, null, kmS / c < 10 ? 1 : 0) + ' c';
  else text = _orrNum(kmS, null, kmS < 10 ? 1 : 0) + ' km/s';
  _aeSetText(_aeById('af-note'), kmS >= c ? _aeT('alm_fly_impossible') : '');
  sh.kmS = kmS; sh.speedText = text;   // (drawn by the view's own readouts; the plain line that past light is only for fun is read aloud here)
  // What is being moved, for the view's own readouts (one plain object, written here while a craft flies): where from and to, what is nearest and how far, how
  // far is left, the speed, the speed over light's, and how long light itself takes over what is left.
  var toB = sh.auto ? _afBody(bodies, sh.auto) : null, toKm = toB ? Math.max(0, _afRealKm(sh, bodies, toB.pos) - (sh.auto === 'sun' ? 0 : toB.r * AE_EARTH_RADIUS_KM)) : null;
  var under = near.body.key !== 'sun' && typeof _aeRigLatLon === 'function' && near.alt < near.body.r * AF_FLARE_FROM ? _aeRigLatLon(near.body.key, sh.pos) : null;
  _aeMoveTell('ufo', near.body.key, kmS * 1000, { from: sh.auto ? sh.from : null, to: sh.auto || null, nearM: Math.max(0, near.alt) * AF_M_PER_RE, toM: toKm === null ? null : toKm * 1000, place: under });
}

// ── Keys and the thumbs ──
function _afBind(on) {
  if (!on) {
    if (_afOnKey) { window.removeEventListener('keydown', _afOnKey, true); window.removeEventListener('keyup', _afOnKey, true); }
    _afOnKey = null; _afKeys = {};
    if (_afFocusOff) { _afFocusOff(); _afFocusOff = null; }
    return;
  }
  _afOnKey = function (e) {
    var sh = _ae.ship, key = (e.key || '').toLowerCase(), name = AF_KEYS[key];
    if (e.type === 'keyup') { if (name) delete _afKeys[name]; return; }   // a key is let go whatever else is held (Ctrl is the way down)
    if (!sh || !key || _aeTyping(e.target) ||(e.ctrlKey && key !== 'control') || e.metaKey || e.altKey) return;
    if (key === 'escape') { if (_ae.info || _ae.setOpen) return; e.preventDefault(); e.stopPropagation(); if (!_afSheetsShut()) return; _afStop(); return; }   // the info and the settings take their own Esc (the view's); a sheet is put away first, then the flight
    if (key === 'l') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) _afLevel(); return; }
    if (!name) return;   // the rest are the view's own
    e.preventDefault(); e.stopPropagation();
    _afHintDone();
    _afKeys[name] = true;
    _aeKick();
  };
  window.addEventListener('keydown', _afOnKey, true);   // (the window's capture runs before any document-level handler: a sheet's own Esc included)
  window.addEventListener('keyup', _afOnKey, true);
  _afFocusOff = _aeOnFocusLost(function () { _afKeys = {}; });
}
// Put away the Go to or the worlds sheet if one is up: true when none was, so the flight can end.
function _afSheetsShut() {
  var go = _aeById('ae-go'), ws = _aeById('ae-wsheet');
  if (go && !go.hidden) { _aeShowGo(false); return false; }
  if (ws && !ws.hidden) { _aeWorldShow(false); return false; }
  return true;
}
// The address (almanac-earth.js, "The address"): fly is px,py,pz,fx,fy,fz,0: the ship's place (Earth radii, the view's frame), where it
// looks (a direction), and a last 0 or 1 that an address kept from the days of a cockpit view (read, and ignored). A link puts the craft there, hovering.
if (typeof _aeLinkModes !== 'undefined') {
  _aeLinkModes.fly = function () {
    var sh = _ae && _ae.ship;
    if (!sh) return null;
    return sh.pos.map(function (x) { return Number(x.toPrecision(9)); }).concat(sh.view.map(function (x) { return Number(x.toFixed(5)); }), [0]).join(',');
  };
}
function _afLinkPlace(v) {
  var sh = _ae.ship, fwd = [v[3], v[4], v[5]];
  if (!sh || _aeLen(fwd) < 1e-6) return;
  sh.pos = [v[0], v[1], v[2]];
  sh.view = _aeNorm(fwd);
  var keep = _aeSub(sh.ref, _aeScale(sh.view, _aeDot(sh.ref, sh.view)));   // a link says where it faces
  sh.up = _aeLen(keep) > 1e-3 ? _aeNorm(keep) : _aeNorm(_aeCross(sh.view, [1, 0, 0]));
  sh.free = true; sh.hold = null; sh.release = null;   // faces exactly as the address says; Level puts it level
  sh.vel = [0, 0, 0];
  sh.auto = sh.arrived = null;
  _ae.dirty = true;
}
// A tap on any world is the way there, the one the view is on included (the view's own tap only opens that one's card); a world the craft is already
// in at (nearer than the autopilot's stop) is not flown out to.
function _afTap(sh, x, y) {
  var key = _aeBodyAt(x, y), b = key && _afBody(_afBodies(_ae.scene), key);
  if (b && sh.auto !== key && _aeLen(_aeSub(sh.pos, b.pos)) > _afStopAt(b) * (1 + AF_ARRIVE_EPS) && _aeFlyGoTo(key).ok) return;
  _aeTap(x, y);
}
// One layer over the picture takes every touch that is not on a lever: a drag looks (it points the nose, and the nose stays), two fingers roll, and a touch
// that does not move is a tap on the view (a world's name or disc, which the craft flies to).
function _afBindLayer(layer) {
  var ptrs = {}, twistAt = null;
  var all = function () { return Object.keys(ptrs).map(function (i) { return ptrs[i]; }); };
  // Moves are kept in the page's own px, not the layer's: the page's header may slide away while a thumb is down.
  layer.addEventListener('pointerdown', function (e) {
    var sh = _ae.ship;
    if (!sh) return;
    _afHintDone();
    layer.setPointerCapture(e.pointerId);
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
    sh.lookDown = all().length;
    twistAt = null;
    _aeKick();
  });
  layer.addEventListener('pointermove', function (e) {
    var sh = _ae.ship, p = ptrs[e.pointerId];
    if (!sh || !p) return;
    if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > AE_TAP_SLOP_PX) p.moved = true;
    var lk = all(), prevX = p.x, prevY = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (lk.length >= 2) {   // two fingers: a twist rolls the craft (its sense: clockwise rolls right)
      var a = Math.atan2(lk[1].y - lk[0].y, lk[1].x - lk[0].x);
      if (twistAt !== null) { var d = a - twistAt; d = Math.atan2(Math.sin(d), Math.cos(d)); sh.twist += d; }
      twistAt = a;
    } else { sh.look.x += e.clientX - prevX; sh.look.y += e.clientY - prevY; twistAt = null; }   // the world follows the thumb: a drag to the right looks left
    _aeKick();
  });
  var end = function (e) {
    var sh = _ae.ship, p = ptrs[e.pointerId];
    if (!p) return;
    delete ptrs[e.pointerId];
    twistAt = null;
    if (sh) sh.lookDown = all().length;
    if (!p.moved && e.type === 'pointerup' && sh) {   // a world's tag under the tap is its (the tags take no pointer, so a drag from one looks: almanac-earth.js _aeSceneTapAt)
      var tag = typeof _aeSceneTapAt === 'function' ? _aeSceneTapAt(p.x0, p.y0) : null, r = layer.getBoundingClientRect();
      if (tag) tag.click(); else _afTap(sh, e.clientX - r.left, e.clientY - r.top);
    }
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  layer.addEventListener('lostpointercapture', end);   // a capture lost without a pointerup is a finger up
  layer.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

// ── The controls on the view ──
// Leaving is the view's rim button (almanac-earth.js _aeRimModes); the rest is two levers, one a thumb, and the readout.
var AF_ARC = '<path d="M3 21c4-4 14-4 18 0"/>';   // a world's limb under an arrow: the lever that comes in to it and leaves it
function _afSvg(paths) { return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'; }
var AF_FWD_SVG = _afSvg('<path d="M6 12l6-6 6 6M6 18l6-6 6 6"/>'), AF_BACK_SVG = _afSvg('<path d="M6 9l6 6 6-6"/>');
var AF_LEAVE_SVG = _afSvg('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/>' + AF_ARC), AF_COME_SVG = _afSvg('<path d="M12 3v11M7.5 9.5L12 14l4.5-4.5"/>' + AF_ARC);
// While the craft flies, the surface/space button moves the craft ("the surface space button isn't doing anything it should move the UFO"): high up it takes
// the craft down to the nearest world's surface, down at the surface it takes it back up to space. Leaving the UFO is the UFO button's own act.
function _afRimWay() {
  var sh = _ae.ship;
  if (!sh || !_ae.scene) return null;
  var near = _afOverShip(sh, _afBodies(_ae.scene));
  if (near.alt <= _afFloor(near.body) * AF_LOW_FLOORS) return { label: _aeT('alm_fly_up'), svg: AE_RIM_GROUND_SVG, run: function () { if (_ae.ship) { _ae.ship.dive = _ae.ship.auto = null; _ae.ship.rise = true; } } };
  return { label: _aeT('alm_fly_down'), svg: AE_RIM_SPACE_SVG, run: function () { _afDive(near.body.key); } };
}
if (typeof _aeRimModes !== 'undefined') _aeRimModes.unshift({ enter: _afRimWay });
var AF_LEVER_TRAVEL = (AF_LEVER_H - 44) / 2;   // px the knob moves each way from the middle
// A lever shown at a value (-1 to 1): its knob, whether it is off the middle (lit), and what a reader hears.
function _afLeverShow(el, v) {
  if (!el) return;
  el.firstElementChild.style.transform = 'translateY(' + (-v * AF_LEVER_TRAVEL) + 'px)';
  el.classList.toggle('af-lever-on', !!v);
  el.setAttribute('aria-valuenow', v.toFixed(2));
}
function _afLeverAt(el, e) { var r = el.getBoundingClientRect(); return _aeClamp((r.top + r.height / 2 - e.clientY) / AF_LEVER_TRAVEL, -1, 1); }
// The right lever: in to the world below, or away from it. Analog, the farther the faster, and it springs to the middle when let go.
function _afLeverBind(el) {
  var id = null;
  var set = function (v) { var sh = _ae.ship; if (sh) sh.lever = v; _afLeverShow(el, v); el.classList.toggle('af-lever-held', id !== null); _aeKick(); };
  el.onpointerdown = function (e) { _afHintDone(); e.stopPropagation(); e.preventDefault(); id = e.pointerId; el.setPointerCapture(id); set(_afLeverAt(el, e)); };
  el.onpointermove = function (e) { if (e.pointerId === id) set(_afLeverAt(el, e)); };
  el.onpointerup = el.onpointercancel = el.onlostpointercapture = function () { id = null; set(0); };
}
// The keys move the levers a person sees: W and S take the throttle to full ahead or back (what they ask for), Space and C the right
// lever up or down, and both come back to where the thumbs hold them when the keys let go. Written only when a key changes.
function _afKeysShow(sh, keyF, keyU) {
  var said = keyF + ',' + keyU;
  if (sh.keysShown === said) return;
  var was = sh.keysShown;
  sh.keysShown = said;
  if (was === undefined && !keyF && !keyU) return;
  var t = _aeById('af-throttle'), l = _aeById('af-lever');
  _afLeverShow(t, _aeClamp(sh.throttle + keyF, -1, 1));
  _afLeverShow(l, _aeClamp(sh.lever + keyU, -1, 1));
  if (t) t.classList.toggle('af-lever-held', !!keyF);
  if (l) l.classList.toggle('af-lever-held', !!keyU);
}
// The left lever: the throttle. Like the right one it springs back to stop when the thumb lets go (eased over AF_THROTTLE_STOP_MS): the craft goes while a
// thumb holds it and stands still when none does. Near its middle it is at stop (AF_DETENT), so a resting thumb does not creep.
function _afThrottleSet(sh, v) {
  sh.throttle = Math.abs(v) < AF_DETENT ? 0 : v;
  sh.stopEase = null;
  _afLeverShow(_aeById('af-throttle'), sh.throttle);
}
function _afThrottleEase(sh, now) {
  var z = sh.stopEase;
  if (!z) return;
  var u = _aeReduceMotion() ? 1 : _aeSmoother((now - z.t0) / AF_THROTTLE_STOP_MS);
  sh.throttle = u >= 1 ? 0 : z.from * (1 - u);
  if (u >= 1) sh.stopEase = null;
  _afLeverShow(_aeById('af-throttle'), sh.throttle);
  _aeKick();
}
function _afThrottleBind(el) {
  var id = null;
  var set = function (e) { var sh = _ae.ship; if (!sh) return; _afThrottleSet(sh, _afLeverAt(el, e)); sh.hand = true; _aeKick(); };
  el.onpointerdown = function (e) { _afHintDone(); e.stopPropagation(); e.preventDefault(); id = e.pointerId; el.setPointerCapture(id); el.classList.add('af-lever-held'); set(e); };
  el.onpointermove = function (e) { if (e.pointerId === id) set(e); };
  el.onpointerup = el.onlostpointercapture = el.onpointercancel = function () {
    var sh = _ae.ship;
    if (id === null) return;
    id = null;
    el.classList.remove('af-lever-held');
    if (sh && sh.throttle) { sh.stopEase = { from: sh.throttle, t0: performance.now() }; _aeKick(); }   // let go: back to stop
  };
}
// Level (the L key, and by itself after a roll): the horizon put back.
function _afLevel() { var sh = _ae.ship; if (!sh) return; _afHintDone(); sh.leveling = true; sh.rollOnly = false; sh.free = false; sh.lookAt = performance.now(); sh.blind = 0; _afRelease(sh); _aeKick(); }
// The first flight only: one short line that the first touch (or key) takes away, and never comes back.
function _afHintShow() { _aeHintShow(_aeById('af-hint'), AF_HINT_KEY, 'alm_fly_hint'); }
function _afHintDone() { _aeHintDone(_aeById('af-hint'), AF_HINT_KEY); }
function _afHud(on) {
  var hud = _aeById('af-hud');
  _ae.el.classList.toggle('ae-flying', !!on);
  if (!on) { if (hud) hud.remove(); return; }
  _afStyle();
  hud = document.createElement('div');
  hud.id = 'af-hud';
  hud.innerHTML = '<div class="af-layer" id="af-layer"></div>' +
    '<div class="af-read"><em id="af-note" role="status"></em></div><div class="af-hint" id="af-hint" hidden></div><div class="af-findbox" aria-hidden="true"><i class="af-find" id="af-find" hidden></i></div><div id="af-refs">' + new Array(2 + AF_REF_FEW + 1).join('<button type="button" class="af-ref" hidden></button>') + '</div>' + [
    ['af-throttle', 'alm_fly_throttle', AF_FWD_SVG, AF_BACK_SVG], ['af-lever', 'alm_fly_lever', AF_LEAVE_SVG, AF_COME_SVG]].map(function (L) {
      return '<div class="af-lever" id="' + L[0] + '" role="slider" aria-orientation="vertical" aria-label="' + _almEsc(_aeT(L[1])) + '" aria-valuemin="-1" aria-valuemax="1" aria-valuenow="0"><i></i><span class="af-up" aria-hidden="true">' + L[2] + '</span><span class="af-dn" aria-hidden="true">' + L[3] + '</span></div>';
    }).join('');
  // Right after the canvas: the view's own controls (the chips, the buttons) stay over it and keep working.
  var cv = _aeById('ae-canvas');
  _ae.el.insertBefore(hud, cv ? cv.nextSibling : null);
  _afLeverBind(_aeById('af-lever'));
  _afThrottleBind(_aeById('af-throttle'));
  _afBindLayer(_aeById('af-layer'));
  _afRefsBind(_aeById('af-refs'));
  _afHintShow();
}
function _afStyle() {
  _aeCss('af-style', [
    '#af-hud{position:absolute;inset:0;pointer-events:none}',
    '.af-layer{position:absolute;inset:0;pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none}',
    // The levers: a slot each side, over the row of worlds, a knob in each. Both spring back to the middle; the throttle's (left) middle is marked, and its knob is lit when it is off it.
    '.af-lever{position:absolute;bottom:calc(' + AF_LEVER_FOOT_PX + 'px + env(safe-area-inset-bottom));width:' + AF_LEVER_W + 'px;height:' + AF_LEVER_H + 'px;border-radius:' + AF_LEVER_W / 2 + 'px;background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.3);pointer-events:auto;touch-action:none;z-index:1;display:flex;flex-direction:column;justify-content:space-between;align-items:center;color:var(--text2)}',
    '#af-lever{inset-inline-end:12px}',
    '#af-throttle{inset-inline-start:12px}',
    // The info corner (name, distance, speed, light) stands clear of the throttle's slot, not over its foot (it covers the bottom of the slider).
    '.ae-flying .ah-info{inset-inline-start:calc(' + (12 + AF_LEVER_W + 10) + 'px + env(safe-area-inset-left));max-width:calc(100% - ' + 2 * (12 + AF_LEVER_W + 10) + 'px)}',
    '#af-throttle::after{content:"";position:absolute;left:8px;right:8px;top:50%;height:2px;margin-top:-1px;border-radius:1px;background:rgba(255,255,255,.45)}',
    '.af-lever i{position:absolute;z-index:1;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgba(255,255,255,.22);border:2px solid rgba(255,255,255,.6);transition:transform .12s ease-out,background .12s}',
    '.af-lever.af-lever-on i{background:rgba(245,158,11,.9)}',
    '.af-lever.af-lever-held i{transition:none}',
    '.af-lever span{display:block;line-height:0;opacity:.7;margin:7px 0}',
    '.af-lever.af-lever-floor .af-dn{opacity:.2}',
    '.night-red .af-lever{border-color:rgba(200,40,40,.45);background:rgba(200,40,40,.08)}',
    '.night-red .af-lever i{background:rgba(200,40,40,.3);border-color:rgba(255,90,90,.6)}',
    '.night-red .af-lever.af-lever-on i{background:rgba(220,50,50,.9)}',
    '.af-read{z-index:1;position:absolute;inset-inline:108px 50px;top:calc(64px + env(safe-area-inset-top));display:flex;flex-direction:column;align-items:flex-start;gap:2px;font-size:12px;color:var(--text2);text-shadow:0 1px 3px #000;pointer-events:none}',
    '#af-refs .af-ref{position:absolute;z-index:3;left:0;top:0;font:inherit;font-style:normal;font-size:12px;white-space:nowrap;padding:3px 9px;margin:0;border:0;border-radius:999px;background:rgba(0,0,0,.72);color:var(--text);text-shadow:0 1px 3px #000;pointer-events:none;touch-action:manipulation}',
    '#af-refs .af-ref.af-ring{padding:0;background:transparent;border:1.5px solid rgba(223,230,240,.45);border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,.6)}',
    '#af-refs .af-ref.af-ring.af-goal{border-color:var(--amber);box-shadow:0 0 10px rgba(255,191,64,.45)}',
    '#af-refs .af-ref:hover{background:rgba(0,0,0,.85);color:var(--amber)}',
    '.af-read em{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',   // the plain line that past light is only for fun: read aloud, not drawn (the readout is one short line)
    '.af-findbox{position:absolute;left:50%;top:44%;width:0;height:0}',
    '.af-find{position:absolute;left:-14px;top:-14px;width:28px;height:28px;background:rgba(245,158,11,.9);clip-path:polygon(50% 0,100% 100%,50% 75%,0 100%);filter:drop-shadow(0 0 4px rgba(0,0,0,.6));transition:transform .15s linear}',
    '.night-red .af-find{background:rgba(200,40,40,.9)}',
    '.af-hint{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--ae-rim-b,calc(12px + env(safe-area-inset-bottom))) + 150px);max-width:78%;text-align:center;font-size:13px;line-height:1.35;padding:8px 14px;border-radius:14px;background:rgba(0,0,0,.6);color:var(--text);text-shadow:0 1px 3px #000;pointer-events:none;z-index:1}',
  ].join('\n'));
}
