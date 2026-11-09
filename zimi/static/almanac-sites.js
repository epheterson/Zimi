// The 3D view on the ground: the landers, rovers and flags where they stand on the Moon and the planets (sites-v1.json,
// the models scripts/build_site_models.py makes), a patch of ground under them lit by the Sun's real direction with the
// shadows it throws, and a rover to drive across it. Loaded the first time a landing site's card opens (almanac-earth.js
// _aeSitesLoad), never with the view; the view's own pieces (the camera, the craft shaders, the landmarks) are used
// as they are.
//
// One local frame per visit: x east, y north, z up, in metres, with its origin on the site, standing on the body's
// true radius (the patch curves away under it). Everything here is in that frame; one Group turns it into the scene's
// (Earth radii) once a frame.

// ── Constants ──
var AS_DATA_URL = '/static/earth/sites-v1.json';
var AS_MRE = 1 / (AE_EARTH_RADIUS_KM * 1000);            // one metre, in Earth radii
var AS_PATCH_R_M = 24000;                                  // the ground patch's reach: past the horizon of anyone standing on it
var AS_PATCH_RINGS = 84, AS_PATCH_SEGS = 72, AS_PATCH_R0_M = 0.4;
var AS_PATCH_NEAR_RINGS_M = 150;                           // inside this the relief is sampled in full, outside only its swell
var AS_RECENTRE_M = 14;                                    // the patch follows what is looked at once it is this far off its middle
var AS_GROUND_ON_ALT_M = 30000;                            // below this altitude the patch is drawn over the body's own sphere
var AS_PATCH_LIFT_M = 2;                                   // and stands this far over it, so the two never fight for a pixel
var AS_HIDE_SHARE = 0.9;                                   // the sphere is left out once the horizon is nearer than this share of the patch's reach
var AS_NEAR_M = 0.05;                                      // the nearest thing drawn on the ground
var AS_NEAR_PER_FOCUS = 0.012, AS_NEAR_MAX_M = 25;         // the near plane stands off this share of the way to what is looked at (depth precision), at most this far
var AS_FOV_DEG = 62;
var AS_NOW_TOL_MS = 120000;                                // a moment this near the real one is "now"
var AS_DROP_MS = 2400;                                     // from the flight's end, down to the ground
var AS_MIN_SUN_Z = 0.03;                                   // the Sun's sine over the horizon below which a visit starts at the landing instead
var AS_SHADOW_MIN_SUN_Z = 0.05;                            // a Sun lower than this throws shadows twenty heights long, no longer
var AS_SHADOW_LIFT_M = 0.03;                               // a shadow lies this far over the ground, so the bumps do not hide it
var AS_FLAT_FROM_M = 10, AS_FLAT_TO_M = 45;                // the ground is level at the lander and gains its relief by here
var AS_ROCK_CELL_M = 5, AS_ROCK_REACH_M = 70, AS_ROCK_MAX = 420;
var AS_CRATER_CELL_M = 48;
var AS_ORBIT_EL = [0.03, 1.45];                            // how far down and up a visit's camera goes (radians over the horizon)
var AS_ORBIT_DIST_M = [2.5, 400];
var AS_ORBIT_FOCUS_Z_M = 1.3;
var AS_FOCUS_EASE = 5, AS_TAP_PX = 56, AS_TAP_SLOP_PX = 8;   // a tap on a part brings it to the middle; a finger that moved more than this was a drag
var AS_STICK_R_PX = 56;
var AS_CAM_FOLLOW = { pos: 6, az: 2.2, yawBack: 0.7 };    // 1/s
var AS_CHASE_EL = 0.36;
var AS_CLOCK_RATES = [1, 300, 3600, 21600];
var AS_KEYS = { ArrowUp: 'f', w: 'f', W: 'f', ArrowDown: 'b', s: 'b', S: 'b', ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r' };
// Per body: the ground's colour, gravity (m/s^2), how rough it is (relief amplitude, m), how many craters and rocks, the
// light its sky adds (ambient, fill) and the haze at the horizon, the sky's colours, and the rover it has.
var AS_BODY = {
  moon: { albedo: [0.5, 0.48, 0.45], g: AE_BODY_FACTS.moon.gravity, relief: 0.45, craters: 1, rocks: 1, ambient: 0.012, fill: 0.04, sky: null, haze: null,
    rover: { body: 'lrv-body', wheel: 'lrv-wheel', vmax: AE_SITE_FACTS.lrvSpeedMs, jump: AE_SITE_FACTS.jumpMs.moon, cam: 11 } },
  mars: { albedo: [0.5, 0.27, 0.15], g: AE_BODY_FACTS.mars.gravity, relief: 0.3, craters: 0.5, rocks: 1, ambient: 0.07, fill: 0.06, haze: [0.6, 0.42, 0.3],
    sky: { day: [0.78, 0.55, 0.38], high: [0.42, 0.3, 0.24], dusk: [0.25, 0.32, 0.5] },
    rover: { body: 'perseverance-body', wheel: 'perseverance-wheel', vmax: AE_SITE_FACTS.marsDriveSpeedMs, jump: AE_SITE_FACTS.jumpMs.mars, cam: 11 } },
  venus: { albedo: [0.42, 0.33, 0.22], g: AE_BODY_FACTS.venus.gravity, relief: 0.2, craters: 0, rocks: 0.7, ambient: 0.2, fill: 0.12, haze: [0.65, 0.42, 0.18],
    sky: { day: [0.75, 0.5, 0.2], high: [0.6, 0.38, 0.15], dusk: [0.4, 0.22, 0.08] }, rover: null },
  titan: { albedo: [0.3, 0.22, 0.13], g: AE_BODY_FACTS.titan.gravity, relief: 0.2, craters: 0, rocks: 0.6, ambient: 0.08, fill: 0.06, haze: [0.4, 0.24, 0.08],
    sky: { day: [0.5, 0.3, 0.1], high: [0.3, 0.18, 0.06], dusk: [0.15, 0.09, 0.03] }, rover: null },
  earth: { albedo: [0.2, 0.25, 0.12], g: AE_BODY_FACTS.earth.gravity, relief: 0.12, craters: 0, rocks: 0.12, ambient: 0.22, fill: 0.1, haze: [0.62, 0.74, 0.9],
    sky: { day: [0.62, 0.76, 0.95], high: [0.16, 0.38, 0.82], dusk: [0.9, 0.5, 0.3] }, rover: null }
};

var _asData = null, _asLoading = null;
function _asLoad() {
  if (_asData || _asLoading || typeof fetch !== 'function') return _asLoading;
  _asLoading = fetch(AS_DATA_URL).then(function (r) { if (!r.ok) throw new Error('sites'); return r.json(); }).then(function (d) {
    _asData = d;
    if (_ae && _ae.lm) _aeRenderCard();
  }).catch(function () { _asLoading = null; });
  return _asLoading;
}
_asLoad();

// The rover's own file, fetched at the first Drive.
var AS_DRIVE_JS = '/static/almanac-sites-drive.js', AS_LAUNCH_JS = '/static/almanac-sites-launch.js', AS_TRAIL_JS = '/static/almanac-sites-trail.js', _asLoadingScripts = {};
function _asLoadScript(src, then) {
  if (_asLoadingScripts[src]) return;
  _asLoadingScripts[src] = true;
  var s = document.createElement('script');
  s.src = src;
  s.onload = then;
  s.onerror = function () { _asLoadingScripts[src] = false; s.remove(); };
  document.head.appendChild(s);
}
function _asDriveLoad(then) { _asLoadScript(AS_DRIVE_JS, then); }
// The site of a landmark row: by the row's name on its body, or null.
function _asDefFor(body, row) {
  if (!_asData || !row) return null;
  for (var i = 0; i < _asData.sites.length; i++) if (_asData.sites[i].body === body && _asData.sites[i].name === row[0]) return _asData.sites[i];
  return null;
}
function _asBodyInfo(body) { return Object.prototype.hasOwnProperty.call(AS_BODY, body) ? AS_BODY[body] : null; }
// Where a landing can be driven from: a body that has a rover, on any of its landing sites.
function _asCanDrive(body, row) { var b = _asBodyInfo(body); return !!(b && b.rover && row && row[3] === 'landing'); }

// ── The frame: where the site is and which way is up, east and north ──
function _asBody(key) { return _aeLmBodies().filter(function (b) { return b.key === key; })[0] || null; }
function _asSunWorld(b, sc) {
  var p = _ae.gl.planets && _ae.gl.planets[b.key];
  if (p && p.sun) return _aeNorm(p.sun);
  return _aeNorm(_aeSub(_aeSunShown(sc), b.center));
}
// The body's turn as three unit axes (the drawn sphere of an oblate planet is squashed along its pole in `m`: not here,
// a site stands on a round body of its mean radius).
function _asAxes(b) {
  var e = b.m;
  return [_aeNorm([e[0], e[1], e[2]]), _aeNorm([e[4], e[5], e[6]]), _aeNorm([e[8], e[9], e[10]])];
}
function _asFrame(st, b, sc) {
  var ax = _asAxes(b), v = _aeLatLonVec(st.lat, st.lon);
  var up = _aeNorm([ax[0][0] * v[0] + ax[1][0] * v[1] + ax[2][0] * v[2], ax[0][1] * v[0] + ax[1][1] * v[1] + ax[2][1] * v[2], ax[0][2] * v[0] + ax[1][2] * v[1] + ax[2][2] * v[2]]);
  var pole = ax[2];
  var east = _aeCross(pole, up);
  east = _aeLen(east) < 1e-6 ? [1, 0, 0] : _aeNorm(east);
  var north = _aeCross(up, east);
  var origin = _aeAdd(b.center, _aeScale(up, b.r + AS_PATCH_LIFT_M * AS_MRE));   // a little over the body's own sphere, whose facets are never above the true radius
  var sun = _asSunWorld(b, sc);
  return { origin: origin, e: east, n: north, u: up, sun: sun, sunLocal: [_aeDot(sun, east), _aeDot(sun, north), _aeDot(sun, up)], center: b.center, r: b.r };
}
function _asToWorld(fr, p) {
  return [fr.origin[0] + (fr.e[0] * p[0] + fr.n[0] * p[1] + fr.u[0] * p[2]) * AS_MRE,
    fr.origin[1] + (fr.e[1] * p[0] + fr.n[1] * p[1] + fr.u[1] * p[2]) * AS_MRE,
    fr.origin[2] + (fr.e[2] * p[0] + fr.n[2] * p[1] + fr.u[2] * p[2]) * AS_MRE];
}
function _asWorldToLocal(fr, w) {
  var d = _aeSub(w, fr.origin);
  return [_aeDot(d, fr.e) / AS_MRE, _aeDot(d, fr.n) / AS_MRE, _aeDot(d, fr.u) / AS_MRE];
}
// The latitude and longitude of a local place (for the tests, and the lander's card): back through the body's turn.
function _asLatLon(st, b, local) {
  var w = _asToWorld(st.fr, local), v = _aeNorm(_aeSub(w, b.center)), ax = _asAxes(b);
  var n = [_aeDot(ax[0], v), _aeDot(ax[1], v), _aeDot(ax[2], v)];
  return { lat: _aeDeg(Math.asin(_aeClamp(n[2], -1, 1))), lon: _aeDeg(Math.atan2(n[1], n[0])) };
}

// ── The visit's state ──
function _asNewState(def, body, row, drive) {
  var info = _asBodyInfo(body), b = _asBody(body);
  var pad = def && def.pad;
  var st = { def: def, body: body, row: row, lat: pad ? pad.lat : row[1], lon: pad ? pad.lon : row[2], drive: !!drive, info: info, phase: 'fly', siteParts: [], keepOut: [], radiusM: b ? b.r * AE_EARTH_RADIUS_KM * 1000 : 1737400,
    camera: { az: 3.5, el: 0.32, dist: 16 }, look: { yaw: 0, pitch: 0, touched: 0 }, input: { sx: 0, sy: 0, keys: {}, jump: false }, last: 0, t0: 0, from: null, fr: null, rate: 0 };
  st.terrain = _asTerrainFn(st);
  // A site whose rover is its own (Curiosity drives as Curiosity) gives the drive that rover's meshes.
  var own = def && def.rover && _asData.rovers[def.rover];
  if (own && info.rover) st.info = Object.assign({}, info, { rover: Object.assign({}, info.rover, { body: own.body, wheel: own.wheel }) });
  // What the visit looks at: its biggest part (the lander), and a distance that holds the rest too.
  var size = function (pd) { var md = _asData.models[pd.m] || _asData.models[(_asData.rovers[pd.m] || {}).body]; return md ? Math.max.apply(null, md.size) : 1; };
  var parts = def ? def.parts : [], main = parts.slice().sort(function (a, b) { return size(b) - size(a); })[0];
  st.focusXY = main ? [main.x || 0, main.y || 0] : [0, 0];
  var span = 0;
  parts.forEach(function (pd) { span = Math.max(span, Math.hypot((pd.x || 0) - st.focusXY[0], (pd.y || 0) - st.focusXY[1]) + size(pd) / 2); });
  st.span = Math.max(6, span, main ? size(main) / 2 : 0);
  st.camera.dist = Math.max(10, st.span * 1.8);
  if (def && def.flat) { st.flatFrom = def.flat[0]; st.flatTo = def.flat[1]; }
  if (def && def.view) { st.camera.dist = def.view.dist; st.camera.el = def.view.el; st.focusZ = def.view.focus; st.distMax = def.view.dist * 4; }
  return st;
}
// Come to the site: the existing flight over it, then the drop to the ground. `drive`: and a rover to drive.
function _aeSiteVisit(body, row, drive) {
  if (!_asData || !_ae || !_ae.gl || !_asBodyInfo(body)) return;
  if (drive && typeof _asRoverBuild !== 'function') { _asDriveLoad(function () { _aeSiteVisit(body, row, drive); }); return; }
  if (_ae.site) _aeSiteLeave(true);
  var def = _asDefFor(body, row) || { name: row[0], body: body, parts: [] };
  _ae.site = _asNewState(def, body, row, drive);
  _aeLmFly(body, row);
  _aeKick();
}
function _aeSiteLeave(quiet) {
  var st = _ae && _ae.site;
  if (!st) return;
  _ae.site = null;
  _asDispose(st);
  _asHud(false);
  var S = _ae.gl;
  if (S) { S.moon.visible = true; S.earth.visible = true; if (st.atmo) st.atmo.visible = true; if (S.sky) S.sky.visible = true; }
  if (_ae.el) _ae.el.classList.remove('ae-site');
  if (!quiet) { _ae.dirty = true; _aeKick(); }
}
function _asDispose(st) {
  var S = _ae && _ae.gl;
  if (!S || !st.group) return;
  if (st.launch) _asLaunchReset(st);
  if (st.trail) _asTrailStop(st);
  S.scene.remove(st.group);
  if (st.dome) S.scene.remove(st.dome);
  st.groundGeo.dispose(); st.rockGeo.dispose();
  if (st.dome) { st.dome.geometry.dispose(); st.dome.material.dispose(); }
  Object.keys(st.models).forEach(function (m) { st.models[m].root.children.forEach(function (c) { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); });
  st.group = null;
}

// ── The camera ──
// The visit's camera orbits the lander; a drive's follows the rover from behind. Either is a pose in the site's frame, then in the scene's.
function _asCameraLocal(st, dt) {
  if (st.camOverride) return st.camOverride(st, dt);
  var c = st.camera, r = st.rover, focus, az = c.az, el = c.el, dist = c.dist;
  if (st.drive && r) {
    var want = [r.x, r.y, r.z + 0.9];
    st.focus = st.focus || want;
    var kf = 1 - Math.exp(-AS_CAM_FOLLOW.pos * dt);
    st.focus = [st.focus[0] + (want[0] - st.focus[0]) * kf, st.focus[1] + (want[1] - st.focus[1]) * kf, st.focus[2] + (want[2] - st.focus[2]) * kf];
    // Behind the rover (its heading's opposite) unless a thumb has turned the look away; the look comes back when let go.
    var back = r.hdg + Math.PI + st.look.yaw;
    if (performance.now() - st.look.touched > 900) st.look.yaw *= Math.exp(-AS_CAM_FOLLOW.yawBack * dt);
    c.az += _aeAngleDeltaRad(c.az, back) * (1 - Math.exp(-AS_CAM_FOLLOW.az * dt));
    az = c.az; el = _aeClamp(AS_CHASE_EL + st.look.pitch, AS_ORBIT_EL[0], AS_ORBIT_EL[1]);
    focus = st.focus;
  } else {
    // The middle of what is looked at eases to a new one (a tap on a part), the distance with it.
    var want2 = st.followPos ? [st.followPos[0], st.followPos[1], st.followPos[2] + AS_ORBIT_FOCUS_Z_M] : [st.focusXY[0], st.focusXY[1], st.focusZ || AS_ORBIT_FOCUS_Z_M];
    st.fcur = st.fcur || want2;
    var k2 = st.followPos ? 1 : 1 - Math.exp(-AS_FOCUS_EASE * dt);
    st.fcur = [st.fcur[0] + (want2[0] - st.fcur[0]) * k2, st.fcur[1] + (want2[1] - st.fcur[1]) * k2, st.fcur[2] + (want2[2] - st.fcur[2]) * k2];
    if (st.distTo) { c.dist += (st.distTo - c.dist) * k2; dist = c.dist; if (Math.abs(st.distTo - c.dist) < 0.01 * c.dist) st.distTo = 0; }
    focus = st.fcur;
  }
  // az is measured from north, counterclockwise through west like heading: the offset is behind that bearing.
  var ch = Math.cos(el), pos = [focus[0] - Math.sin(az) * ch * dist, focus[1] + Math.cos(az) * ch * dist, focus[2] + Math.sin(el) * dist];
  // Over the ground there, never under it.
  var gz = _asGroundAt(st, pos[0], pos[1], false) + 0.6;
  if (pos[2] < gz) pos[2] = gz;
  return { pos: pos, focus: focus };
}
function _asPose(st, dt) {
  var fr = st.fr, loc = _asCameraLocal(st, dt), world = _asToWorld(fr, loc.pos), focusW = _asToWorld(fr, loc.focus);
  var look = _aeNorm(_aeSub(focusW, world)), up = fr.u;
  if (st.from && st.phase === 'drop') {
    var e = _smoothstep(0, 1, (performance.now() - st.t0) / AS_DROP_MS), from = st.from;
    // Down from where the flight left the camera: its place eased along the way (altitude on a log scale), its up turned to the site's.
    var dFrom = _aeSub(from.pos, fr.origin), alt0 = Math.max(_aeLen(dFrom), 1e-12), altTo = Math.max(_aeLen(_aeSub(world, fr.origin)), 1e-12);
    var altNow = Math.exp(Math.log(alt0) + (Math.log(altTo) - Math.log(alt0)) * e);
    var dirFrom = _aeNorm(dFrom), dirTo = _aeNorm(_aeSub(world, fr.origin));
    var dir = _aeNorm(_aeAdd(_aeScale(dirFrom, 1 - e), _aeScale(dirTo, e)));
    world = _aeAdd(fr.origin, _aeScale(dir, altNow));
    look = _aeNorm(_aeAdd(_aeScale(_aeNorm(_aeSub(from.look, world)), 1 - e), _aeScale(_aeNorm(_aeSub(focusW, world)), e)));
    up = _aeNorm(_aeAdd(_aeScale(from.up, 1 - e), _aeScale(fr.u, e)));
    st.dropE = e;
  }
  up = _aeSub(up, _aeScale(look, _aeDot(up, look)));
  up = _aeLen(up) < 1e-6 ? fr.e : _aeNorm(up);
  var alt = _aeLen(_aeSub(world, fr.center)) - fr.r;
  // The near plane stands off in proportion to what is looked at: a lander's feet from a few metres, a launch from half a kilometre.
  var camHeight = loc.pos[2] - _asGroundAt(st, loc.pos[0], loc.pos[1], true);
  var nearM = _aeClamp(_aeLen(_aeSub(focusW, world)) / AS_MRE * AS_NEAR_PER_FOCUS, AS_NEAR_M, Math.max(AS_NEAR_M, Math.min(AS_NEAR_MAX_M, camHeight * 0.8)));
  return { pos: world, up: up, look: look, tp: _aeAdd(world, look), altRe: alt, fov: loc.fov, nearRe: nearM * AS_MRE };
}

// ── The frame hook before the camera: the visit's state of play ──
function _aeSiteStep(sc) {
  var st = _ae.site;
  if (!st) return;
  var S = _ae.gl, b = _asBody(st.body);
  if (!b || !_asData) return;
  var now = performance.now(), dt = st.last ? Math.min(0.05, (now - st.last) / 1000) : 0.016;
  st.last = now;
  st.fr = _asFrame(st, b, sc);
  if (st.phase === 'fly') {
    if (_ae.fly) return;
    if (_ae.target !== st.body) { _aeSiteLeave(); return; }
    var cam = S.camera;
    var look = new S.THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), upv = new S.THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    st.from = { pos: [cam.position.x, cam.position.y, cam.position.z], look: [cam.position.x + look.x, cam.position.y + look.y, cam.position.z + look.z], up: [upv.x, upv.y, upv.z] };
    st.phase = 'drop';
    st.t0 = now;
    if (_aeReduceMotion()) st.t0 = now - AS_DROP_MS;
    _ae.el.classList.add('ae-site');
    _asHud(true);
    // A site in the dark opens at the landing, the Sun up (the clock button goes back).
    if (st.fr.sunLocal[2] < AS_MIN_SUN_Z && st.def && st.def.ms) { st.nowMs = sc.ms; st.atLanding = true; _aeGoTo(st.def.ms); }
  }
  if (!st.group) { _asGroupBuild(st); }
  if (st.phase === 'drop' && now - st.t0 >= AS_DROP_MS) { st.phase = 'stand'; st.from = null; }
  _asPlaceSiteParts(st);
  if (st.drive && typeof _asRoverBuild === 'function') _asRoverBuild(st);
  if (st.rover) _asRoverStep(st, dt);
  // The ground follows what is looked at.
  var mx = st.rover ? st.rover.x : st.followPos ? st.followPos[0] : 0, my = st.rover ? st.rover.y : st.followPos ? st.followPos[1] : 0;
  if (Math.hypot(mx - st.cx, my - st.cy) > AS_RECENTRE_M || st.cx === 1e9) _asRebuildGround(st, mx, my);
  if (st.launch) _asLaunchStep(st, dt);
  if (st.trail) _asTrailStep(st, dt);
  st.pose = _asPose(st, dt);
  _asHudTick(st, sc);
}
// The frame hook after the camera (its matrices are this frame's): light, matrices and what shows.
function _aeSiteLight(sc) {
  var st = _ae.site, S = _ae.gl;
  if (!st || !st.group || !st.fr || !st.pose) return;
  var fr = st.fr, cam = S.camera, down = st.pose.altRe < AS_GROUND_ON_ALT_M * AS_MRE;
  st.group.visible = down;
  if (st.dome) st.dome.visible = down;
  if (down && st.pose.altRe < AS_HIDE_SHARE * AS_PATCH_R_M * AS_PATCH_R_M / (2 * st.radiusM) * AS_MRE) _asHideBody(st, S);
  var e = fr, g = st.group.matrix;
  var s = AS_MRE;
  g.set(e.e[0] * s, e.n[0] * s, e.u[0] * s, e.origin[0], e.e[1] * s, e.n[1] * s, e.u[1] * s, e.origin[1], e.e[2] * s, e.n[2] * s, e.u[2] * s, e.origin[2], 0, 0, 0, 1);
  st.group.matrixWorldNeedsUpdate = true;
  st.group.updateMatrixWorld(true);
  var sunZ = fr.sunLocal[2], lit = _smoothstep(-0.03, 0.03, sunZ);
  var sh = st.shared;
  sh.ambient.value = st.info.ambient;
  sh.sun.value.set(fr.sunLocal[0], fr.sunLocal[1], fr.sunLocal[2]);
  sh.lit.value = lit;
  sh.fade.value = _aeFadeU.value;
  // The Sun low: shadows are long and not longer.
  var ss = Math.max(AS_SHADOW_MIN_SUN_Z, sunZ), sl = Math.hypot(fr.sunLocal[0], fr.sunLocal[1]) || 1, k = Math.sqrt(Math.max(0, 1 - ss * ss)) / sl;
  st.shadowSun = [fr.sunLocal[0] * k, fr.sunLocal[1] * k, ss];
  st.parts.forEach(function (p) {
    p.su.sun.value.set(st.shadowSun[0], st.shadowSun[1], st.shadowSun[2]);
    p.shadow.visible = lit > 0.02 && down && !p.opts.noShadow;
    p.holder.visible = down;
  });
  if (st.skyUni) {
    st.skyUni.sunZ.value = sunZ;
    var m = new S.THREE.Matrix4();
    m.set(e.e[0], e.n[0], e.u[0], cam.position.x, e.e[1], e.n[1], e.u[1], cam.position.y, e.e[2], e.n[2], e.u[2], cam.position.z, 0, 0, 0, 1);
    m.scale({ x: cam.far * 0.5, y: cam.far * 0.5, z: cam.far * 0.5 });
    st.dome.matrix.copy(m);
    st.dome.matrixWorldNeedsUpdate = true;
    // Under a bright atmospheric sky no star shows.
    S.sky.visible = !(down && lit > 0.12);
  }
  // Each model's own light: the Sun in the camera's view, dark when below the horizon; a little fill from the camera.
  var vInv = cam.matrixWorldInverse.elements, sunW = fr.sun;
  var toView = function (u, out) { out.set(vInv[0] * u[0] + vInv[4] * u[1] + vInv[8] * u[2], vInv[1] * u[0] + vInv[5] * u[1] + vInv[9] * u[2], vInv[2] * u[0] + vInv[6] * u[1] + vInv[10] * u[2]).normalize(); };
  Object.keys(st.models).forEach(function (mk) {
    var I = st.models[mk];
    toView(sunW, I.uni.sunView.value);
    I.uni.lit.value = lit;
    I.uni.fill.value = st.info.fill * (0.5 + 0.5 * lit);
    I.uni.earthLight.value = st.info.ambient > 0.05 ? st.info.ambient * 1.4 : 0;   // an atmosphere's light from above
    toView(fr.u, I.uni.nadirView.value);
    I.uni.fade.value = _aeFadeU.value;
  });
  if (st.dust) { st.dust.uni.lit.value = lit; st.dust.uni.pxPerRad.value = _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2); }
}
// The view's camera in place of the orbit camera: the pose the visit worked out, as the base's own camera description.
function _aeSiteCam(c) {
  var st = _ae.site;
  return { tp: st.pose.tp, az: 0, el: 0, dist: 1, tanHalf: Math.tan(_aeRad(st.pose.fov || AS_FOV_DEG) / 2), roll: 0, frame: null, pose: st.pose };
}
// The body's own sphere (and an atmosphere's shell round the Earth) give way to the patch of ground.
function _asHideBody(st, S) {
  if (st.body === 'moon') S.moon.visible = false;
  else if (st.body === 'earth') {
    S.earth.visible = false;
    if (st.atmo === undefined) st.atmo = S.scene.children.filter(function (o) { return o.material && o.material.fragmentShader === AE_ATMO_FRAG; })[0] || null;
    if (st.atmo) st.atmo.visible = false;
  } else if (S.planets && S.planets[st.body]) S.planets[st.body].mesh.visible = false;
}
// The camera's near plane close to the ground: the nearest thing is metres off.
function _aeSiteNear(near) {
  var st = _ae.site;
  if (!st || !st.pose) return near;
  return Math.max(st.pose.nearRe, Math.min(near, st.pose.altRe * 0.05));
}

// ── Interface: the pointer surface, the buttons, the caption ──
var AS_CSS = [
  '.ae-view.ae-site .ae-top,.ae-view.ae-site .ae-bottom,.ae-view.ae-site .ae-labels,.ae-view.ae-site .ae-lms,.ae-view.ae-site .ae-mini,.ae-view.ae-site .ae-info,.ae-view.ae-site .ae-set{display:none!important}',
  '.as-hud{position:absolute;inset:0;z-index:50;pointer-events:none;display:none}',
  '.ae-view.ae-site .as-hud{display:block}',
  '.as-layer{position:absolute;inset:0;pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none}',
  '.as-bar{position:absolute;top:calc(env(safe-area-inset-top) + 12px);inset-inline:12px;display:flex;justify-content:space-between;gap:8px;pointer-events:none}',
  '.as-bar>*{pointer-events:auto}',
  '.as-bar-end{display:flex;gap:8px}',
  '.as-cap{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));max-width:calc(100% - 32px);padding:8px 14px;border-radius:12px;background:rgba(14,14,16,.78);border:1px solid var(--border);font-size:13px;line-height:1.4;color:var(--text2);text-align:center;pointer-events:auto;white-space:nowrap}',
  '.as-cap a{color:var(--amber);text-decoration:none}',
  '.as-cap small{display:block;font-size:11px;color:var(--text3)}',
  '.as-stick{position:absolute;width:' + (AS_STICK_R_PX * 2) + 'px;height:' + (AS_STICK_R_PX * 2) + 'px;margin:-' + AS_STICK_R_PX + 'px 0 0 -' + AS_STICK_R_PX + 'px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.07);pointer-events:none}',
  '.as-stick i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(245,158,11,.55);border:2px solid rgba(255,255,255,.6)}',
  '.as-rest{position:absolute;left:calc(14px + env(safe-area-inset-left));bottom:calc(14px + env(safe-area-inset-bottom));width:' + (AS_STICK_R_PX * 2) + 'px;height:' + (AS_STICK_R_PX * 2) + 'px;border-radius:50%;border:2px dashed rgba(255,255,255,.18);pointer-events:none}',
  '.as-speed{position:absolute;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:22px;font-weight:600;color:rgba(255,255,255,.9);text-shadow:0 1px 8px rgba(0,0,0,.7);pointer-events:none;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.as-jump{position:absolute;right:calc(14px + env(safe-area-inset-right));bottom:calc(14px + env(safe-area-inset-bottom));width:60px;height:60px;pointer-events:auto}',
  '.as-hud.as-driving .as-cap{bottom:auto;top:calc(env(safe-area-inset-top) + 66px)}',
  '.as-rate{font-size:12px;min-width:44px}',
  '.as-launch{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom));width:64px;height:64px;pointer-events:auto}',
  '.as-count{position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:center;padding-top:26%;box-sizing:border-box;font-size:84px;font-weight:700;color:rgba(255,255,255,.85);text-shadow:0 2px 18px rgba(0,0,0,.6);pointer-events:none;font-variant-numeric:tabular-nums}'
].join('');
var AS_LAUNCH_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c3 2.5 4 6 4 9l-2 3h-4l-2-3c0-3 1-6.5 4-9z"/><circle cx="12" cy="9" r="1.4"/><path d="M10 15l-2 3.5M14 15l2 3.5M12 17v4"/></svg>';
var AS_ROUTE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/></svg>';
var AS_EXIT_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
var AS_LANDING_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v6M9 6l3-3 3 3"/><path d="M7 14h10l2 7H5z"/></svg>';
var AS_CLOCK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>';
var AS_JUMP_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 17c3-1 5-6 7-12 2 6 4 11 7 12"/><path d="M4 21h16"/></svg>';
var AS_DRIVE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="6" rx="1.5"/><circle cx="7.5" cy="17" r="2.2"/><circle cx="16.5" cy="17" r="2.2"/><path d="M12 8V4h3"/></svg>';
var AS_VISIT_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18"/><path d="M7 20l2-8h6l2 8"/><path d="M10 12V8h4v4"/><path d="M12 8V4"/></svg>';

function _asHud(on) {
  var el = _ae && _ae.el;
  if (!el) return;
  var hud = _aeById('as-hud');
  if (!on) { if (hud) { hud.classList.remove('as-driving'); } _asKeys(false); return; }
  if (!hud) {
    if (!document.getElementById('as-css')) { var css = document.createElement('style'); css.id = 'as-css'; css.textContent = AS_CSS; document.head.appendChild(css); }
    hud = document.createElement('div');
    hud.className = 'as-hud'; hud.id = 'as-hud';
    var routeL = _almEsc(_aeT('alm_site_trail')), leaveL = _almEsc(_aeT('alm_site_leave')), landL = _almEsc(_aeT('alm_site_landing')), rateL = _almEsc(_aeT('alm_site_pace')), jumpL = _almEsc(_aeT('alm_site_jump'));
    hud.innerHTML = '<div class="as-layer" id="as-layer"></div><div class="as-rest" id="as-rest" hidden></div><div class="as-stick" id="as-stick" hidden><i></i></div>' +
      '<div class="as-bar"><button type="button" class="ae-btn ae-round" id="as-exit" aria-label="' + leaveL + '" title="' + leaveL + '">' + AS_EXIT_SVG + '</button>' +
      '<div class="as-bar-end"><button type="button" class="ae-btn ae-round" id="as-trailbtn" aria-label="' + routeL + '" title="' + routeL + '" hidden>' + AS_ROUTE_SVG + '</button><button type="button" class="ae-btn ae-round" id="as-landing" aria-label="' + landL + '" title="' + landL + '">' + AS_LANDING_SVG + '</button>' +
      '<button type="button" class="ae-btn ae-round as-rate" id="as-rate" aria-label="' + rateL + '" title="' + rateL + '">' + AS_CLOCK_SVG + '</button></div></div>' +
      '<div class="as-speed" id="as-speed" hidden></div><div class="as-cap" id="as-cap"></div><div class="as-count" id="as-count" aria-hidden="true"></div>' +
      '<button type="button" class="ae-btn ae-round as-launch" id="as-launch" aria-label="' + _almEsc(_aeT('alm_site_launch')) + '" title="' + _almEsc(_aeT('alm_site_launch')) + '" hidden>' + AS_LAUNCH_SVG + '</button>' +
      '<button type="button" class="ae-btn ae-round as-jump" id="as-jump" aria-label="' + jumpL + '" title="' + jumpL + '" hidden>' + AS_JUMP_SVG + '</button>';
    el.appendChild(hud);
    _asBindHud(hud);
  }
  hud.classList.toggle('as-driving', !!(_ae.site && _ae.site.drive));
  _aeById('as-rest').hidden = !(_ae.site && _ae.site.drive);
  _aeById('as-jump').hidden = !(_ae.site && _ae.site.drive);
  _aeById('as-speed').hidden = !(_ae.site && _ae.site.drive);
  _aeById('as-landing').hidden = !(_ae.site && _ae.site.def && _ae.site.def.ms);
  _aeById('as-launch').hidden = !(_ae.site && _ae.site.def && _ae.site.def.launch);
  _aeById('as-trailbtn').hidden = !(_ae.site && _ae.site.def && _ae.site.def.trail);
  _asKeys(true);
  _asCaption(_ae.site);
}
function _asCaption(st) {
  var cap = _aeById('as-cap');
  if (!cap || !st) return;
  var def = st.def, row = st.row, name = _almEsc(def.name || row[0]);
  var when = def.ms ? '<small>' + _almEsc(_aeT(def.launch ? 'alm_site_launched' : 'alm_site_landed', { date: _aeFmtWhen(def.ms) })) + '</small>' : '';
  cap.innerHTML = (st.hit ? '<a href="#" id="as-read">' + name + '</a>' : name) + when;
  var read = _aeById('as-read');
  if (read) read.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(st.hit); };
  if (row[4] && !st.hit && !st.hitAsked && window.AlmanacLinks && AlmanacLinks.resolve) {
    st.hitAsked = true;
    AlmanacLinks.resolve([row[4]]).then(function (links) { if (_ae.site === st && links[row[4]]) { st.hit = links[row[4]]; _asCaption(st); } });
  }
}
function _asHudTick(st, sc) {
  var rate = _aeById('as-rate');
  if (rate && typeof _almRate !== 'undefined') {
    var txt = _almRate > 1.5 ? '×' + (_almRate >= 1000 ? Math.round(_almRate / 3600) + 'h' : Math.round(_almRate)) : '';
    if (rate.dataset.t !== txt) { rate.dataset.t = txt; rate.innerHTML = txt || AS_CLOCK_SVG; }
  }
}
// A tap on a part of the site: it comes to the middle of the picture and the camera to a few of its widths.
function _asTapPart(st, x, y) {
  var best = null, bd = AS_TAP_PX;
  st.siteParts.forEach(function (sp) {
    var part = sp.body || sp, h = part.holder.position, w = _asToWorld(st.fr, [h.x, h.y, h.z + part.size * 0.3]), sc = _aeProject(w);
    if (!sc) return;
    var d = Math.hypot(sc.x - x, sc.y - y);
    if (d < bd) { bd = d; best = part; }
  });
  if (!best) return;
  st.focusXY = [best.x, best.y];
  st.focusZ = best.z + best.size * 0.3;
  st.distTo = _aeClamp(best.size * 2.6, AS_ORBIT_DIST_M[0], AS_ORBIT_DIST_M[1]);
  _aeKick();
}
function _asBindHud(hud) {
  _aeById('as-exit').onclick = function () { _aeSiteLeave(); _aePreset(_ae.site ? _ae.site.body : _ae.target); };
  _aeById('as-landing').onclick = function () {
    var st = _ae.site;
    if (!st || !st.def || !st.def.ms) return;
    // The button goes between the landing and the moment the visit came from (now, when it came from now).
    if (st.atLanding) {
      if (Math.abs(st.nowMs - Date.now()) < AS_NOW_TOL_MS) _aeNow(); else _aeGoTo(st.nowMs);
      st.atLanding = false;
    } else { st.nowMs = _aeDisplayMs(); _aeGoTo(st.def.ms); st.atLanding = true; }
  };
  _aeById('as-rate').onclick = function () {
    var cur = typeof _almRate === 'number' ? _almRate : 1, i = 0;
    for (var k = 0; k < AS_CLOCK_RATES.length; k++) if (Math.abs(AS_CLOCK_RATES[k] - cur) < 1e-6) i = k + 1;
    if (typeof _almClockSetRate === 'function') _almClockSetRate(AS_CLOCK_RATES[i % AS_CLOCK_RATES.length]);
  };
  _aeById('as-trailbtn').onclick = function () {
    var st = _ae.site;
    if (!st || !st.def.trail) return;
    if (st.trail) { _asTrailStop(st); return; }
    var go = function () { _asTraversesLoad(function () { _asTrailStart(st); }); };
    if (typeof _asTrailStart !== 'function') _asLoadScript(AS_TRAIL_JS, go); else go();
  };
  _aeById('as-launch').onclick = function () {
    var st = _ae.site;
    if (!st || !st.def.launch) return;
    if (typeof _asLaunchStart !== 'function') { _asLoadScript(AS_LAUNCH_JS, function () { _asLaunchStart(st); }); return; }
    _asLaunchStart(st);
  };
  _aeById('as-jump').onpointerdown = function (e) { e.stopPropagation(); if (_ae.site) _ae.site.input.jump = true; };
  var layer = _aeById('as-layer'), ptrs = {}, pinch = null;
  var stickEl = _aeById('as-stick');
  layer.addEventListener('pointerdown', function (e) {
    var st = _ae.site;
    if (!st) return;
    layer.setPointerCapture(e.pointerId);
    var r = layer.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    ptrs[e.pointerId] = { x: x, y: y, x0: x, y0: y, role: 'look' };
    if (st.drive && x < r.width * 0.5 && y > r.height * 0.3) {
      ptrs[e.pointerId].role = 'stick';
      stickEl.hidden = false;
      stickEl.style.left = x + 'px'; stickEl.style.top = y + 'px';
      stickEl.firstElementChild.style.transform = '';
    } else if (Object.keys(ptrs).length === 2 && !st.drive) {
      var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]];
      pinch = { span: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    st.look.touched = performance.now();
    _aeKick();
  });
  layer.addEventListener('pointermove', function (e) {
    var st = _ae.site, p = ptrs[e.pointerId];
    if (!st || !p) return;
    var r = layer.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (p.role === 'stick') {
      var ox = x - p.x0, oy = y - p.y0, len = Math.hypot(ox, oy), k = len > AS_STICK_R_PX ? AS_STICK_R_PX / len : 1;
      st.input.sx = ox * k / AS_STICK_R_PX; st.input.sy = -oy * k / AS_STICK_R_PX;
      stickEl.firstElementChild.style.transform = 'translate(' + (ox * k) + 'px,' + (oy * k) + 'px)';
    } else if (pinch && Object.keys(ptrs).length >= 2) {
      var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]], span = Math.hypot(a.x - b.x, a.y - b.y);
      if (span > 0 && pinch.span > 0) st.camera.dist = _aeClamp(st.camera.dist * pinch.span / span, AS_ORBIT_DIST_M[0], st.distMax || AS_ORBIT_DIST_M[1]);
      pinch.span = span;
    } else if (st.drive) {
      st.look.yaw -= dx * 0.006; st.look.pitch = _aeClamp(st.look.pitch + dy * 0.004, -0.25, 1.0); st.look.touched = performance.now();
    } else {
      st.camera.az -= dx * 0.006; st.camera.el = _aeClamp(st.camera.el + dy * 0.005, AS_ORBIT_EL[0], AS_ORBIT_EL[1]);
    }
    _aeKick();
  });
  var end = function (e) {
    var st = _ae.site, p = ptrs[e.pointerId];
    if (!p) return;
    delete ptrs[e.pointerId];
    if (p.role === 'stick' && st) { st.input.sx = st.input.sy = 0; stickEl.hidden = true; }
    else if (st && !st.drive && e.type === 'pointerup' && Math.hypot(p.x - p.x0, p.y - p.y0) < AS_TAP_SLOP_PX) _asTapPart(st, p.x, p.y);
    if (Object.keys(ptrs).length < 2) pinch = null;
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  layer.addEventListener('wheel', function (e) {
    var st = _ae.site;
    if (!st) return;
    e.preventDefault();
    st.camera.dist = _aeClamp(st.camera.dist * Math.exp(e.deltaY * 0.0012), AS_ORBIT_DIST_M[0], st.distMax || AS_ORBIT_DIST_M[1]);
    _aeKick();
  }, { passive: false });
}
var _asKeyDown = null, _asKeyUp = null;
function _asKeys(on) {
  if (on && !_asKeyDown) {
    _asKeyDown = function (e) {
      var st = _ae && _ae.site, k = AS_KEYS[e.key];
      if (!st || e.target.tagName === 'INPUT') return;
      if (k) { st.input.keys[k] = true; e.preventDefault(); e.stopPropagation(); }
      else if (e.key === ' ') { st.input.jump = true; e.preventDefault(); e.stopPropagation(); }
      _aeKick();
    };
    _asKeyUp = function (e) { var st = _ae && _ae.site, k = AS_KEYS[e.key]; if (st && k) st.input.keys[k] = false; };
    document.addEventListener('keydown', _asKeyDown, true);
    document.addEventListener('keyup', _asKeyUp, true);
  } else if (!on && _asKeyDown) {
    document.removeEventListener('keydown', _asKeyDown, true);
    document.removeEventListener('keyup', _asKeyUp, true);
    _asKeyDown = _asKeyUp = null;
  }
}

// ── The landmark card's way in: two icon buttons under a landing's line ──
function _aeSiteCardHtml(lm) {
  if (!_asData || typeof _asGroupBuild !== 'function' || (lm.row[3] !== 'landing' && lm.row[3] !== 'launch')) return '';
  var def = _asDefFor(lm.body, lm.row), drive = _asCanDrive(lm.body, lm.row);
  if (!def && !drive) return '';
  var when = def && def.ms ? '<p class="ae-lm-line"><span>' + _almEsc(_aeT(def.launch ? 'alm_site_launched' : 'alm_site_landed', { date: _aeFmtWhen(def.ms) })) + '</span></p>' : '';
  var vis = _almEsc(_aeT('alm_site_visit')), dr = _almEsc(_aeT('alm_site_drive'));
  return when + '<p class="ae-lm-line as-go" style="justify-content:flex-start;gap:10px">' +
    (def ? '<button type="button" class="ae-btn ae-round" id="as-visit" aria-label="' + vis + '" title="' + vis + '">' + AS_VISIT_SVG + '</button>' : '') +
    (drive ? '<button type="button" class="ae-btn ae-round" id="as-drive" aria-label="' + dr + '" title="' + dr + '">' + AS_DRIVE_SVG + '</button>' : '') + '</p>';
}
function _aeSiteCardBind(card, lm) {
  var v = card.querySelector('#as-visit'), d = card.querySelector('#as-drive');
  if (v) v.onclick = function () { _aeSiteVisit(lm.body, lm.row, false); };
  if (d) d.onclick = function () { _aeSiteVisit(lm.body, lm.row, true); };
}

function _aeSiteState() {
  var st = _ae && _ae.site;
  if (!st) return null;
  var b = _asBody(st.body), out = { body: st.body, name: st.def.name, phase: st.phase, drive: st.drive, lat: st.lat, lon: st.lon, parts: [], sunZ: st.fr ? st.fr.sunLocal[2] : null,
    altM: st.pose ? st.pose.altRe / AS_MRE : null, ready: !!st.group && st.placed, visible: !!(st.group && st.group.visible) };
  if (b && st.fr) {
    (st.parts || []).forEach(function (p) {
      var ll = _asLatLon(st, b, [p.x, p.y, p.z]);
      out.parts.push({ model: p.model, x: p.x, y: p.y, z: p.z, lat: ll.lat, lon: ll.lon, ground: _asGroundAt(st, p.x, p.y, false) });
    });
    if (st.rover) {
      var r = st.rover, ll2 = _asLatLon(st, b, [r.x, r.y, r.z]);
      out.rover = { x: r.x, y: r.y, z: r.z, hdg: r.hdg, v: r.v, pitch: r.pitch, roll: r.roll, airborne: r.airborne, mean: r.mean, lat: ll2.lat, lon: ll2.lon,
        wheels: r.wheels.map(function (w) { return { x: w.x, y: w.y, z: w.z, ground: _asGroundAt(st, w.x, w.y, false) }; }) };
    }
  }
  return out;
}
