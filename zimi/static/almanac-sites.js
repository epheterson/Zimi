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
var AS_DATA_URL = _almAsset('/static/earth/sites-v1.json');
var AS_MRE = 1 / (AE_EARTH_RADIUS_KM * 1000);            // one metre, in Earth radii
var AS_CORNER_PX = 12 + 44, AS_CORNER_GAP_PX = 8, AS_MENU_DROP_PX = 2, AS_STRIP_FADE_PX = 20;   // the corner's disc with its inset (almanac-earth.js AH_EDGE_PX, AE_HIT_PX), the gap beside it, and what centres a 40 px disc on a 44 px one
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
var AS_FAR_MS_PER_DECADE = 450, AS_FAR_MS_MAX = 4000, AS_FAR_FROM_R = 3;   // a visit to another body: its length grows by this per decade of distance (in body radii beyond a few), to this most
var AS_FAR_APART = 1.6;   // the look is on the destination when the two worlds are this many half-widths of the picture apart (and in between, between them: one or the other is always in the picture)
var AS_FAR_TURN = [0.3, 0.55, 1];       // its look turns to the destination's centre by this share of the move, holds, and is on the site by the end
var AS_EYE_DROP_MS = 1400;                                  // from Stand's eye pose to the drive's camera: a short slide, the same place
var AS_DROP_MS = 2400;                                     // from the flight's end, down to the ground
var AS_MIN_SUN_Z = 0.03;                                   // the Sun's sine over the horizon below which a visit starts at the landing instead
var AS_SHADOW_MIN_SUN_Z = 0.05;                            // a Sun lower than this throws shadows twenty heights long, no longer
var AS_SHADOW_LIFT_M = 0.03;                               // a shadow lies this far over the ground, so the bumps do not hide it
var AS_TERRAIN_LOD_PER_M = 0.0005;                         // km of the shortest wavelength a far vertex holds, per metre out (the ground's own mesh: almanac-terrain.js)
var AS_FLAT_FROM_M = 10, AS_FLAT_TO_M = 45;                // the ground is level at the lander and gains its relief by here
var AS_ROCK_CELL_M = 5, AS_ROCK_REACH_M = 70, AS_ROCK_MAX = 420;
var AS_CRATER_CELL_M = 48;
var AS_ORBIT_EL = [0.03, 1.45];                            // how far down and up a visit's camera goes (radians over the horizon)
var AS_ORBIT_DIST_M = [2.5, 400];
var AS_ORBIT_FOCUS_Z_M = 1.3;
var AS_FOCUS_EASE = 5, AS_TAP_PX = 56, AS_TAP_SLOP_PX = 8;   // a tap on a part brings it to the middle; a finger that moved more than this was a drag
var AS_TAP_MS = 500;
var AS_START_FACE_MIN_M = 5;                               // a vehicle this near the lander keeps its own heading
var AS_STEER_DRAG = 0.006, AS_STEER_DRAG_V = 0.05;   // a drag's turn of the heading per pixel (as a look's), and the speed (m/s) above which a drag steers instead of looking
var AS_STICK_R_PX = AE_STICK_R_PX, AS_STICK_ZONE = AE_STICK_ZONE, AS_STICK_OUTER = 1.5, AS_STICK_FAST_AT = 1.1, AS_REST_X_PX = 104,
  AS_REST_Y_PX = AH_EDGE_PX + AE_HIT_PX + 2 * AH_INFO_GAP_PX + AH_INFO_LINES * AH_INFO_LINE_PX + AS_STICK_R_PX * AS_STICK_OUTER + 2;   // (the rest ring's dotted edge stands just over the info corner at its fullest, as the flight's levers do: almanac-earth.js AH_CSS)
// The dotted ring is this many times the solid one; a push this far past the solid ring is 'further'; the drive's ring is a little larger than the other vehicles' (AE_STICK_R_PX), the rest ring's centre is the second pair. (almanac-earth.js: the stick the ship shares) the lower half of the picture is the stick: a press anywhere there
var AS_EDGE_PX = 22, AS_TAP_AREA_PX = 44, AS_DOT_PX = 12, AS_WALK_MAX_M = 250, AS_ARRIVAL_EL = 0.55, AS_ARRIVAL_FILL = 1.25;   // a part answers a tap this near its bounds; under DOT px wide it also wears a dot; the walk goes this far from the lander; the arrival view's height and how much room it leaves round the cluster
var AS_ASCENT = { thrustN: 15570, massKg: 4500, burnKgS: 5.1, riseS: 10, pitchPerDeg: 1.5, pitchMaxDeg: 60, leadS: 8, endS: 70, stepS: 0.1 };   // the ascent engine: 15.6 kN (3,500 lbf), about 4.5 t at liftoff, 5.1 kg/s (Isp 311 s); a vertical rise of 10 s, then pitched forward
var AS_ITEM_PX = 104, AS_NAME_PX = 12;   // a thing's width in the strip (its name takes two lines of it, never cut) and the size of every name at a site
var AS_STRIP_H_PX = 108, AS_LAUNCH_GAP_PX = 8, AS_THUMB_PX = 56, AS_THUMBS_URL = _almAsset('/static/earth/site-thumbs-v1.webp');   // the strip of what is here: its height, a picture's size, the sheet of pictures
var AS_SPAN_PARTS_M = 45;                                  // the first view holds what stands within this of the lander; an ALSEP or a parked rover far off is a tap away
var AS_CAM_FOLLOW = { pos: 6, az: 2.2, yawBack: 0.7 };    // 1/s
var AS_CHASE_EL = 0.36;
var AS_VIEW_CHASE_K = [1.5, 0.6];                          // the chase camera's distance, a share of the vehicle's row: wide, near
var AS_CAM_PULL = 0.35, AS_CAM_PULL_EASE = 2.5;   // the chase camera's drop back at full speed (a share of its distance), and how fast it follows the speed
// The keys: W A S D move, the arrows look (the shared mode language), E jumps, C switches the camera, Shift is the speed-up, Esc leaves.
// Space is not here: it is the 3D view's controls toggle.
// A driving game's keys: W S drive, A D steer, the arrows the same, Space a wheelie, Shift the next speed stage, V the camera, Esc leaves; the mouse drags to look.
var AS_KEYS = { w: 'f', W: 'f', s: 'b', S: 'b', a: 'l', A: 'l', d: 'r', D: 'r', ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'l', ArrowRight: 'r' };
// Per body: the ground's colour, gravity (m/s^2), how rough it is (relief amplitude, m), how many craters and rocks, the
// light its sky adds (ambient, fill) and the haze at the horizon, the sky's colours, and the rover it has.
// The vehicles: a row each (its models, how fast, how high a hop, camera distance, the driver's eye in its frame: x right, y
// ahead, z up from the ground; where its lamps are). A body's row names its own, and a solid body without one gets the
// vehicle of its kind (AS_VEHICLE_ON: the Mars rover where there is air, the Lunar Roving Vehicle everywhere else).
var AS_VEHICLES = {
  lrv: { body: 'lrv-body', wheel: 'lrv-wheel', vmax: AE_SITE_FACTS.lrvSpeedMs, jump: AE_SITE_FACTS.jumpMs.moon, cam: 11, seat: [-0.45, -0.9, 2.4], seatDown: 0.2, lamps: [[-0.8, 1.6, 0.9], [0.8, 1.6, 0.9]] },
  mars: { body: 'perseverance-body', wheel: 'perseverance-wheel', vmax: AE_SITE_FACTS.marsDriveSpeedMs, fast: AE_SITE_FACTS.marsDriveFastRate, jump: AE_SITE_FACTS.jumpMs.mars, cam: 11, seat: [-0.35, 0.9, 2.1], seatDown: 0.35, lamps: [[-0.7, 1.5, 1.1], [0.7, 1.5, 1.1]] }
};
var AS_VEHICLE_ON = { earth: 'mars', venus: 'mars', mars: 'mars', titan: 'mars' };
var AS_BODY = {
  moon: { albedo: [0.5, 0.48, 0.45], g: AE_BODY_FACTS.moon.gravity, relief: 0.45, craters: 1, rocks: 1, ambient: 0.012, fill: 0.04, sky: null, haze: null,
    rover: AS_VEHICLES.lrv },
  mars: { albedo: [0.5, 0.27, 0.15], g: AE_BODY_FACTS.mars.gravity, relief: 0.3, craters: 0.5, rocks: 1, ambient: 0.07, fill: 0.06, haze: [0.6, 0.42, 0.3],
    sky: { day: [0.78, 0.55, 0.38], high: [0.42, 0.3, 0.24], dusk: [0.25, 0.32, 0.5] },
    rover: AS_VEHICLES.mars,
    air: { sun: [1, 0.8, 0.6], sky: [0.55, 0.34, 0.24], dust: [0.84, 0.52, 0.34], dustAmt: 0.8 } },   // Mars: a dusty rose sky, the Sun a little yellow, red dust settled on what faces up
  venus: { albedo: [0.42, 0.33, 0.22], g: AE_BODY_FACTS.venus.gravity, relief: 0.2, craters: 0, rocks: 0.7, ambient: 0.2, fill: 0.12, haze: [0.65, 0.42, 0.18],
    sky: { day: [0.75, 0.5, 0.2], high: [0.6, 0.38, 0.15], dusk: [0.4, 0.22, 0.08] }, rover: AS_VEHICLES.mars },
  titan: { albedo: [0.3, 0.22, 0.13], g: AE_BODY_FACTS.titan.gravity, relief: 0.2, craters: 0, rocks: 0.6, ambient: 0.08, fill: 0.06, haze: [0.4, 0.24, 0.08],
    sky: { day: [0.5, 0.3, 0.1], high: [0.3, 0.18, 0.06], dusk: [0.15, 0.09, 0.03] }, rover: AS_VEHICLES.mars },
  earth: { albedo: [0.2, 0.25, 0.12], g: AE_BODY_FACTS.earth.gravity, relief: 0.12, craters: 0, rocks: 0.12, ambient: 0.22, fill: 0.1, haze: [0.62, 0.74, 0.9],
    sky: { day: [0.62, 0.76, 0.95], high: [0.16, 0.38, 0.82], dusk: [0.9, 0.5, 0.3] }, rover: AS_VEHICLES.mars }
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
var AS_DRIVE_JS = _almAsset('/static/almanac-sites-drive.js'), AS_LAUNCH_JS = _almAsset('/static/almanac-sites-launch.js'), AS_TRAIL_JS = _almAsset('/static/almanac-sites-trail.js');
function _asDriveLoad(then) { _aeLoadJsOnce(AS_DRIVE_JS, then); }
// The site of a landmark row: by the row's name on its body, or null.
function _asDefFor(body, row) {
  if (!_asData || !row) return null;
  for (var i = 0; i < _asData.sites.length; i++) if (_asData.sites[i].body === body && _asData.sites[i].name === row[0]) return _asData.sites[i];
  return null;
}
// A body's ground and its vehicle: its own row, else (a solid body Stand here stands on, with a gravity on file) the Moon's ground
// at its gravity and the vehicle of its kind.
var _asBodyGeneric = {};
// The site's own parked vehicle of the kind the drive uses: { n: its place in the parts, pd }, or null.
function _asParkedOwn(st) {
  var parts = st.def ? st.def.parts : [];
  for (var n = 0; n < parts.length; n++) {
    var asm = _asData.rovers && _asData.rovers[parts[n].m];
    if (asm && asm.body === st.info.rover.body) return { n: n, pd: parts[n] };
  }
  return null;
}
function _asBodyInfo(body) {
  if (Object.prototype.hasOwnProperty.call(AS_BODY, body)) return AS_BODY[body];
  var f = AE_BODY_FACTS[body];
  if (!_aeStandable(body) || !f || !f.gravity) return null;
  return _asBodyGeneric[body] || (_asBodyGeneric[body] = Object.assign({}, AS_BODY.moon, { g: f.gravity, rover: AS_VEHICLES[AS_VEHICLE_ON[body] || 'lrv'] }));
}
// Where a landing can be driven from: a body that has a rover, on any of its landing sites.
// Whether a site's own mission had a rover on its ground (a rover part among its models: the LRV, Lunokhod, Yutu, Sojourner...).
var AS_ROVER_PARTS = ['lrv', 'lunokhod', 'yutu', 'sojourner', 'mer', 'curiosity', 'perseverance', 'zhurong', 'pragyan'];
function _asHadRover(def) { return !!(def.rover || (def.parts || []).some(function (p) { return AS_ROVER_PARTS.indexOf(p.m) >= 0; })); }
function _asCanDrive(body, row) { var b = _asBodyInfo(body); return !!(b && b.rover && row && row[3] === 'landing'); }

// Soft round points (the wheels' dust, the launch's flame and smoke): sized in metres, seen no nearer than nearM, at most maxPx
// across; their fragment shaders start with AS_GLSL_ROUND_POINT (r: 0 at the centre, 1 at the rim).
function _asPointVert(nearM, maxPx, minPx) {
  return [
    'attribute float size; attribute float life;',
    'uniform float metre; uniform float pxPerRad;',
    'varying float vLife;',
    'void main() {',
    '  vLife = life;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float dist = max(length(mv.xyz) / metre, ' + nearM.toFixed(1) + ');',
    '  gl_PointSize = clamp(max(size * pxPerRad / dist, ' + (minPx || 0).toFixed(1) + '), 0.0, ' + maxPx.toFixed(1) + ');',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');
}
var AS_GLSL_ROUND_POINT = '  vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0;\n  if (r > 1.0) discard;';
// The points themselves on the site's group: P gets pos, vel, size and life for `max` of them, its geo, uni (with metre and
// pxPerRad added) and mesh.
function _asPoints(st, P, max, uni, vert, frag, additive) {
  var THREE = _ae.gl.THREE, geo = new THREE.BufferGeometry();
  P.pos = new Float32Array(max * 3); P.vel = new Float32Array(max * 3); P.size = new Float32Array(max); P.life = new Float32Array(max); P.next = 0; P.geo = geo;
  geo.setAttribute('position', new THREE.BufferAttribute(P.pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(P.size, 1));
  geo.setAttribute('life', new THREE.BufferAttribute(P.life, 1));
  uni.metre = st.shared.metre; uni.pxPerRad = { value: 800 };
  var mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false });
  if (additive) mat.blending = AE_THREE_ADDITIVE;
  var pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  st.group.add(pts);
  P.uni = uni; P.mesh = pts;
  return P;
}

// ── The frame: where the site is and which way is up, east and north ──
function _asBody(key) { return _aeLmBodies(true).filter(function (b) { return b.key === key; })[0] || null; }
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
  // (Stand's file may still be on its way at the first tap of a cold page: the sphere's point serves for those frames, and every
  // frame reads this again. Calling it unloaded threw, and the first Stand here tap did nothing.)
  if (st.body === 'earth' && typeof _aeStPlaceVec === 'function') {   // the Earth's globe is flattened: the origin is the map's point on it, the up its true vertical
    var sv = _aeStPlaceVec('earth', st.lat, st.lon);
    var on = [ax[0][0] * sv[0] + ax[1][0] * sv[1] + ax[2][0] * sv[2], ax[0][1] * sv[0] + ax[1][1] * sv[1] + ax[2][1] * sv[2], ax[0][2] * sv[0] + ax[1][2] * sv[1] + ax[2][2] * sv[2]];
    origin = _aeAdd(_aeAdd(b.center, _aeScale(on, b.r)), _aeScale(up, AS_PATCH_LIFT_M * AS_MRE));
  }
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
  if (st.body === 'earth') { var g = _aeSphereLatLon(n[0], n[1], n[2] / (1 - AE_EARTH_FLATTENING), AE_EARTH_FLATTENING); return { lat: g.lat, lon: g.lon }; }   // the flattened globe's own latitude
  return _aeLatLonOf(n);
}

// ── The visit's state ──
// The arrival view: the whole cluster at the lander (what stands within AS_SPAN_PARTS_M) in frame, from a three-quarter height,
// the middle of its bounds the centre. The camera's distance fits its widest side to the picture's narrower one.
function _asArrival(st, parts, size) {
  var near = parts.filter(function (pd) { return Math.hypot((pd.x || 0) - st.focusXY[0], (pd.y || 0) - st.focusXY[1]) <= AS_SPAN_PARTS_M; });
  if (near.length < 2) return;
  var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  near.forEach(function (pd) { var r = size(pd) / 2; x0 = Math.min(x0, (pd.x || 0) - r); x1 = Math.max(x1, (pd.x || 0) + r); y0 = Math.min(y0, (pd.y || 0) - r); y1 = Math.max(y1, (pd.y || 0) + r); });
  st.focusXY = [(x0 + x1) / 2, (y0 + y1) / 2];
  var reach = Math.max(x1 - x0, y1 - y0) / 2, aspect = Math.min(1, _ae && _ae.w && _ae.h ? _ae.w / _ae.h : 0.6);
  st.camera.el = AS_ARRIVAL_EL;
  st.camera.dist = _aeClamp(reach * AS_ARRIVAL_FILL / (_aeTanHalf(AS_FOV_DEG) * aspect), 12, AS_ORBIT_DIST_M[1]);
}
// The clock as it stands, to be put back later: the moment, and whether it was the real one. "Now" is decided here, when the mark is made: a visit
// can last far longer than AS_NOW_TOL_MS, and a clock that was live when it began goes back to live, not to the minute it began.
function _asClockMark(ms) {
  if (ms === undefined) ms = _aeDisplayMs();
  return { ms: ms, live: Math.abs(ms - Date.now()) < AS_NOW_TOL_MS };
}
function _asClockBack(mark) {
  if (mark.live) _aeNow(); else _aeGoTo(mark.ms);
  if (mark.rate != null && typeof _almClockSetRate === 'function') _almClockSetRate(mark.rate);   // (a visit that also changed the clock's pace: the pad)
}
function _asNewState(def, body, row, drive) {
  var info = _asBodyInfo(body), b = _asBody(body);
  var pad = def && def.pad;
  var st = { def: def, body: body, row: row, lat: pad ? pad.lat : row[1], lon: pad ? pad.lon : row[2], drive: !!drive, info: info, phase: 'fly', siteParts: [], keepOut: [], radiusM: b ? b.r * AE_EARTH_RADIUS_KM * 1000 : 1737400,
    camera: { az: 3.5, el: 0.32, dist: 16 }, look: { yaw: 0, pitch: 0, touched: 0 }, input: { sx: 0, sy: 0, keys: {}, look: { yaw: 0, pitch: 0 }, jump: false, fast: false }, last: 0, t0: 0, from: null, fr: null, rate: 0 };
  st.terrain = _asTerrainFn(st);
  st.clock0 = _asClockMark();   // the clock as the visit found it: leaving puts it back
  // A site whose rover is its own (Curiosity drives as Curiosity) gives the drive that rover's meshes.
  var own = def && def.rover && _asData.rovers[def.rover];
  if (own && info.rover) st.info = Object.assign({}, info, { rover: Object.assign({}, info.rover, { body: own.body, wheel: own.wheel }) });
  // A site that has its own parked vehicle of the kind driven: that one is driven, and leaves its spot (there is not a second copy).
  if (drive && st.info.rover) {
    var pk = _asParkedOwn(st);
    if (pk) { st.parkedIdx = pk.n; st.start = { x: pk.pd.x || 0, y: pk.pd.y || 0, hdg: pk.pd.h || 0 }; }
  }
  // What the visit looks at: its biggest part (the lander), and a distance that holds the rest too.
  var size = function (pd) { var md = _asData.models[pd.m] || _asData.models[(_asData.rovers[pd.m] || {}).body]; return md ? Math.max.apply(null, md.size) : 1; };
  var parts = def ? def.parts : [], main = parts.slice().sort(function (a, b) { return size(b) - size(a); })[0];
  st.focusXY = main ? [main.x || 0, main.y || 0] : [0, 0];
  var span = 0;
  parts.forEach(function (pd) {
    var off = Math.hypot((pd.x || 0) - st.focusXY[0], (pd.y || 0) - st.focusXY[1]);
    if (off <= AS_SPAN_PARTS_M) span = Math.max(span, off + size(pd) / 2);
  });
  st.span = Math.max(6, span, main ? size(main) / 2 : 0);
  // The vehicle starts facing the lander (the ground ahead, the lander in view), not an arbitrary way.
  if (drive && st.info.rover && parts.length) {
    var s0 = Object.assign({}, st.start || AS_ROVER_START), fx = st.focusXY[0] - s0.x, fy = st.focusXY[1] - s0.y;
    if (Math.hypot(fx, fy) > AS_START_FACE_MIN_M) s0.hdg = -_aeDeg(Math.atan2(-fx, fy));   // (a heading in degrees, the way sites-v1.json gives them)
    st.start = s0;
  }
  st.camera.dist = Math.max(10, st.span * 1.8);
  _asArrival(st, parts, size);
  if (def && def.relief) st.relief = def.relief;   // the site's named craters, as the data has them (sites-v1.json)
  if (def && def.flat) { st.flatFrom = def.flat[0]; st.flatTo = def.flat[1]; }
  if (def && def.view) { st.camera.dist = def.view.dist; st.camera.el = def.view.el; st.focusZ = def.view.focus; st.distMax = def.view.dist * 4; }
  st.home = { xy: st.focusXY.slice(), z: st.focusZ, dist: st.camera.dist };   // the first view, for a tap on nothing to come back to
  return st;
}
// Come to the site: the existing flight over it, then the drop to the ground. `drive`: and a rover to drive.
// fromTrip: the arrival of a journey: the clock keeps what the journey made of it, and goes back to what it was before the whole visit on leaving.
// `eye`: the camera was standing on this ground (Stand here): the visit starts from that very pose, never by way of the orbit view.
function _aeSiteVisit(body, row, drive, fromTrip, eye, ground) {
  if (!_asData || !_ae || !_ae.gl || !_asBodyInfo(body)) { if (ground) _aeStandDispose(ground); return; }
  if (drive && typeof _asRoverBuild !== 'function') { _asDriveLoad(function () { _aeSiteVisit(body, row, drive, fromTrip, eye, ground); }); return; }
  var prev = _ae.site;
  if (prev) _aeSiteLeave(true, true, fromTrip);
  var def = _asDefFor(body, row) || { name: row[0], body: body, parts: [], adHoc: true };   // (no site of that name: a drive anywhere, named for its body)
  var st = _ae.site = _asNewState(def, body, row, drive);
  st.eye0 = eye || null;
  st.adopt = ground || null;   // Stand here's ground, already drawn round where one stood: the visit goes on in it (almanac-standhost.js _aeHostAdopt)
  if (ground) { st.start = { x: eye.x + Math.sin(eye.yaw) * AS_CALL_AHEAD_M, y: eye.y + Math.cos(eye.yaw) * AS_CALL_AHEAD_M, hdg: _aeDeg(eye.yaw) + AS_CALL_TURN_DEG }; }
  // Over the same body with its terrain in already, there is no flight to a stop and then a drop: the drop is the whole move, from the camera as it is.
  st.direct = !eye && _ae.target === body && !_ae.fly && typeof _aeTerr !== 'undefined' && !!_aeTerr[body] && _aeTerr[body].state === 'ready';
  // Another body: no zoom out and back in either. The camera stays where it is while the terrain comes in, then goes the whole way (round the
  // destination, its height falling on a log scale) in one move, the destination in the picture from early on.
  st.far = !eye && _ae.target !== body;
  _aeSiteLinkTake(st);
  if (prev && fromTrip) st.clock0 = prev.clock0;
  // The end of a journey: the vehicle comes in to the lander (or, a hand taking the wheel mid-way, carries on) the way it was heading.
  if (fromTrip && st.drive && fromTrip.bearing !== undefined) {
    var hd = _aeDeg(fromTrip.bearing), toward = !fromTrip.mid && def.parts && def.parts.length && st.focusXY;
    st.start = toward ? { x: st.focusXY[0] - Math.sin(fromTrip.bearing) * AS_ARRIVE_M, y: st.focusXY[1] - Math.cos(fromTrip.bearing) * AS_ARRIVE_M, hdg: hd } : { x: 0, y: 0, hdg: hd };
  }
  // A site in the dark opens at the landing, the Sun up, from the first moment (not after the flight: the picture would open
  // dark and jump to day), and the clock button goes back.
  var b0 = _asBody(body), fr0 = b0 && _ae.scene ? _asFrame(st, b0, _ae.scene) : null;
  if (fr0 && fr0.sunLocal[2] < AS_MIN_SUN_Z && def.ms && !st.linked) { st.nowMark = _asClockMark(); st.atLanding = true; _aeGoTo(def.ms); }
  // The phone's back leaves the visit (one history step, taken back by leaving by any other way).
  st.stepped = prev ? prev.stepped : false;
  if (!st.stepped && typeof _aeFullStepIn === 'function' && !_aeFullStepped && _aeStepped) { _aeFullStepIn(); st.stepped = _aeFullStepped; }
  _aeLmFly(body, row, !!eye || st.direct ? true : 'hold');   // (never a flight to a stop first and then the drop: the camera holds while the terrain comes, then goes the whole way in one move)
  if (ground) {   // its terrain is in (it was stood on): the visit has its ground in this very frame, so nothing else is drawn between
    st.terrain = _asTerrainFn(st);
    st.groundReady = true;
    _aeHostAdopt(st, ground);
    _aeKick();
    return;
  }
  // The ground's terrain (and the scripts that hold it) first: the parts are put down once it is in, never twice.
  _aeSiteGround(body).then(function () {
    if (_ae.site !== st) return;
    st.terrain = _asTerrainFn(st);   // the ground's heights now that they are in (the first visit had no terrain scripts when it began)
    st.groundReady = true;
    if (typeof _aeHostPrepare === 'function') _aeHostPrepare(st);
    _aeKick();
  });
  _aeKick();
}
function _aeSiteGround(body) {
  if (typeof _aeStandReady !== 'function') return Promise.resolve();
  return _aeStandReady().then(function () { return typeof _aeTerrainLoad === 'function' ? _aeTerrainLoad(body) : null; }).catch(function () {});
}
// handover: another visit follows at once (the history step goes on to it); keepClock: it keeps the clock as it is.
function _aeSiteLeave(quiet, handover, keepClock) {
  var st = _ae && _ae.site;
  if (!st) return;
  _ae.site = null;
  _ae.move = null;
  if (!keepClock && st.clock0 && typeof _aeGoTo === 'function') {   // the visit moved the clock (to the landing day): back to where it was
    _asClockBack(st.clock0);
  }
  if (st.stepped && !handover) { st.stepped = false; if (typeof _aeFullStepOut === 'function') _aeFullStepOut(); }
  if (typeof _aeHostDrop === 'function') _aeHostDrop(st);
  if (st.def.adHoc && _ae.lm && _ae.lm.row === st.row) { _ae.lm = null; _aeRenderCard(); }   // a drive anywhere leaves no card of a "site" behind (it was the Moon's, with a rover on it)
  _asDispose(st);
  _asHud(false);
  var S = _ae.gl;
  if (S) { S.moon.visible = true; S.earth.visible = true; if (st.atmo) st.atmo.visible = true; if (S.sky) S.sky.visible = true; }
  if (_ae.el) _ae.el.classList.remove('ae-site');
  if (!quiet) _aeRedraw();
}
function _asDispose(st) {
  var S = _ae && _ae.gl;
  if (!S || !st.group) return;
  if (st.launch) _asLaunchReset(st);
  if (st.trail) _asTrailStop(st);
  S.scene.remove(st.group);
  if (st.dome) S.scene.remove(st.dome);
  // Everything the site hung on its group: the ground, rocks, shadow, tracks, tread marks, lamps and the drive's line and pillar.
  st.group.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) [].concat(o.material).forEach(function (m) { m.dispose(); });
  });
  st.groundGeo.dispose(); st.rockGeo.dispose();
  if (st.dome) { st.dome.geometry.dispose(); st.dome.material.dispose(); }
  Object.keys(st.models).forEach(function (m) { st.models[m].root.children.forEach(function (c) { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); });
  st.lamps = st.autoLine = st.autoMark = st.tracksMesh = null;
  st.group = null;
}

// ── The ascent stage's liftoff: the Lunar Module's own engine against the Moon's gravity, from the site's `liftoff` instant ──
function _asAscentFlight(g) {
  var A = AS_ASCENT, rows = [], d = 0, z = 0, vd = 0, vz = 0, maxP = A.pitchMaxDeg * Math.PI / 180;
  for (var t = 0; t <= A.endS + 1e-9; t += A.stepS) {
    var a = A.thrustN / (A.massKg - A.burnKgS * t), p = t < A.riseS ? 0 : Math.min(maxP, (t - A.riseS) * A.pitchPerDeg * Math.PI / 180);
    rows.push([t, d, z, p]);
    vd += a * Math.sin(p) * A.stepS; vz += (a * Math.cos(p) - g) * A.stepS;
    d += vd * A.stepS; z = Math.max(0, z + vz * A.stepS);
  }
  return rows;
}
function _asAscentStart(st) {
  var def = st.def, lm = def && def.parts.filter(function (p) { return p.m === 'lm-ascent'; })[0];
  if (!lm || !def.liftoff || st.drive) return;
  st.ascent = { t0: performance.now(), t: -AS_ASCENT.leadS, ms: def.liftoff - AS_ASCENT.leadS * 1000, rows: _asAscentFlight(st.info.g), front: _aeRad(lm.h || 0) };
  if (typeof _aeGoTo === 'function') _aeGoTo(st.ascent.ms);
  _asWholeSite(st);
  _aeKick();
}
// The row of the flight at the ascent's own time (t < 0: still on the descent stage).
function _asAscentRow(a) { return a.t < 0 ? [0, 0, 0, 0] : a.rows[Math.min(a.rows.length - 1, Math.floor(a.t / AS_ASCENT.stepS))]; }
function _asAscentStep(st) {
  var a = st.ascent;
  if (!a) return;
  a.t = (performance.now() - a.t0) / 1000 - AS_ASCENT.leadS;
  a.ms = st.def.liftoff + a.t * 1000;
  if (a.t > AS_ASCENT.endS) { st.ascent = null; if (typeof _aeGoTo === 'function') _aeGoTo(st.def.liftoff + AS_ASCENT.endS * 1000); _asAscentRest(st); _asWholeSite(st); return; }
  var row = _asAscentRow(a);
  st.focusZ = row[2] * 0.5 + AS_ORBIT_FOCUS_Z_M;
  st.distTo = Math.max(st.home.dist, row[2] * 1.6 + 8);
  _aeKick();
}
// The ascent stage back on its descent stage (the flight is over or was cut off).
function _asAscentRest(st) {
  st.def.parts.forEach(function (pd, n) {
    var got = st.siteParts[n];
    if (pd.m !== 'lm-ascent' || !got) return;
    var z = _asGroundAt(st, pd.x || 0, pd.y || 0, false);
    _asPartPlace(st, got, pd.x || 0, pd.y || 0, z + (pd.z || 0), got.hdg, 0, 0, 0, z);
  });
}
// Follow the whole mission: the replay of the mission the site belongs to, from this site's liftoff (the missions module owns the replay).
function _aeSiteFollowMission(st) {
  var m = st && st.def && st.def.mission;
  if (!m || typeof _aeMissionStart !== 'function') return false;
  var at = (st.def.liftoff - m.launchMs) / 1000;
  _aeSiteLeave(true);
  _aeMissionStart(m.id, at);
  return true;
}
// ── The camera ──
// The visit's camera orbits the lander; a drive's follows the rover from behind. Either is a pose in the site's frame, then in the scene's.
function _asCameraLocal(st, dt) {
  if (st.camOverride) return st.camOverride(st, dt);
  if (st.drive && st.rover && st.seat && typeof _asSeatLocal === 'function') return _asSeatLocal(st, dt);
  var c = st.camera, r = st.rover, focus, az = c.az, el = c.el, dist = c.dist;
  if (st.drive && r) {
    var want = [r.x, r.y, r.z + 0.9];
    st.focus = st.focus || want;
    if (st.holdLook && (Math.abs(r.v) > 0.05 || performance.now() - st.look.touched < 50)) { st.holdLook = false; st.look.touched = performance.now(); }   // let go of the eye's picture once it drives or is looked about
    var kf = st.holdLook ? 0 : 1 - Math.exp(-AS_CAM_FOLLOW.pos * dt);
    st.focus = _aeLerp3(st.focus, want, kf);
    // Behind the rover (its heading's opposite) unless a thumb has turned the look away; the look comes back when let go.
    var back = r.hdg + Math.PI + st.look.yaw;
    if (!st.holdLook && performance.now() - st.look.touched > 900) st.look.yaw *= Math.exp(-AS_CAM_FOLLOW.yawBack * dt);
    c.az += _aeAngleDeltaRad(c.az, back) * (1 - Math.exp(-AS_CAM_FOLLOW.az * dt));
    az = c.az; el = st.holdLook ? st.holdEl : _aeClamp(AS_CHASE_EL + st.look.pitch, AS_ORBIT_EL[0], AS_ORBIT_EL[1]);
    focus = st.focus;
    // The camera drops back with speed and comes forward at rest, so going fast looks it.
    st.pull = (st.pull || 0) + (Math.min(1, Math.abs(r.v) / st.info.rover.vmax) - (st.pull || 0)) * (1 - Math.exp(-AS_CAM_PULL_EASE * dt));
    dist = c.dist * (1 + AS_CAM_PULL * st.pull);
  } else {
    // The middle of what is looked at eases to a new one (a tap on a part), the distance with it.
    var want2 = st.followPos ? [st.followPos[0], st.followPos[1], st.followPos[2] + AS_ORBIT_FOCUS_Z_M] : [st.focusXY[0], st.focusXY[1], st.focusZ || AS_ORBIT_FOCUS_Z_M];
    st.fcur = st.fcur || want2;
    var k2 = st.followPos ? 1 : 1 - Math.exp(-AS_FOCUS_EASE * dt);
    st.fcur = _aeLerp3(st.fcur, want2, k2);
    if (st.distTo) { c.dist += (st.distTo - c.dist) * k2; dist = c.dist; if (Math.abs(st.distTo - c.dist) < 0.01 * c.dist) st.distTo = 0; }
    focus = st.fcur;
  }
  // az is measured from north, counterclockwise through west like heading: the offset is behind that bearing.
  var ch = Math.cos(el), pos = [focus[0] - Math.sin(az) * ch * dist, focus[1] + Math.cos(az) * ch * dist, focus[2] + Math.sin(el) * dist];
  if (!st.drive) _asKeepOutOfParts(st, pos);
  // Over the ground there, never under it.
  var gz = _asGroundAt(st, pos[0], pos[1], false) + 0.6;
  if (pos[2] < gz) pos[2] = gz;
  return { pos: pos, focus: focus, fov: st.adopt ? st.eyeFov : undefined };   // (on the ground one stood on, Stand here's field of view throughout: nothing changes as the drive begins)
}
// The orbit camera never goes inside a part: round the middle of each (a sphere of AS_PART_CLEAR of its size) it is pushed out.
var AS_LOOK_EL = 0.1, AS_LOOK_M = 25;   // looking toward a far crater: the camera's height, and how far the lander's side the view's centre is
var AS_PART_CLEAR = 0.55, AS_PART_CLEAR_MAX_M = 40;   // (a launch tower or a pad is a place to stand in, not a thing to stand off)
function _asKeepOutOfParts(st, pos) {
  st.siteParts.forEach(function (sp) {
    var part = sp.body || sp;
    if (!part.holder.visible || part.size > AS_PART_CLEAR_MAX_M) return;
    var c = [part.x, part.y, part.z + part.size * 0.3], r = part.size * AS_PART_CLEAR, d = [pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]], len = Math.hypot(d[0], d[1], d[2]);
    if (len >= r) return;
    if (len < 1e-6) { d = [0, 0, 1]; len = 1; }
    pos[0] = c[0] + d[0] / len * r; pos[1] = c[1] + d[1] / len * r; pos[2] = c[2] + d[2] / len * r;
  });
}
// Where Stand's camera was, as a pose over this ground: its eye height, heading and pitch, in the visit's frame.
function _asEyePose(st) {
  var e = st.eye0, fr = st.fr, pos = _asToWorld(fr, [0, 0, e.alt]), f = [Math.cos(e.pitch) * Math.sin(e.yaw), Math.cos(e.pitch) * Math.cos(e.yaw), Math.sin(e.pitch)];
  var ahead = _asToWorld(fr, [f[0], f[1], e.alt + f[2]]), look = _aeNorm(_aeSub(ahead, pos));
  return { pos: pos, up: fr.u, look: look, tp: _aeAdd(pos, look), altRe: e.alt * AS_MRE, fov: e.fov, nearRe: Math.max(0.05, e.alt * 0.01) * AS_MRE };
}
var AS_MIN_HEIGHT_RE = 1 / AE_EARTH_RADIUS_KM / 1000;   // a metre (Earth radii): the lowest height the descent's log scale goes to
// A direction turned from unit `a` to unit `b` by the share t of the angle between them, along the great circle.
function _asSlerp(a, b, t) {
  var th = Math.acos(_aeClamp(_aeDot(a, b), -1, 1)), sn = Math.sin(th);
  if (sn < 1e-6) return _aeNorm(_aeAdd(_aeScale(a, 1 - t), _aeScale(b, t)));
  return _aeAdd(_aeScale(a, Math.sin((1 - t) * th) / sn), _aeScale(b, Math.sin(t * th) / sn));
}
function _asPose(st, dt) {
  var fr = st.fr, loc = _asCameraLocal(st, dt), world = _asToWorld(fr, loc.pos), focusW = _asToWorld(fr, loc.focus);
  var look = _aeNorm(_aeSub(focusW, world)), up = fr.u;
  if (st.from && (st.phase === 'drop' || st.phase === 'rise')) {
    var e = _smoothstep(0, 1, (performance.now() - st.t0) / (st.dropMs || AS_DROP_MS)), from = st.from;
    if (st.phase === 'rise') e = 1 - e;   // the way out is the way in backwards: the same path, the same heights
    if (st.getIn) {   // into the seat: a few metres over the ground, straight there (the path round the body is for coming down from orbit: from eye height it flew up past the reference sphere)
      var fromW = _asToWorld(fr, from.posM), toLook = _aeNorm(_aeSub(focusW, world)), fromLook = _aeNorm(_aeSub(_asToWorld(fr, from.focusM), fromW));   // (in the ground's own frame: the body moves on under the scene's)
      world = _aeLerp3(fromW, world, e);
      look = _aeNorm(_aeLerp3(fromLook, toLook, e));
      st.dropE = e;
      return _asPoseOut(st, loc, world, look, fr.u, focusW);
    }
    // Down from where the camera was, round the body and never through it: its direction from the body's centre turns to the site's along the
    // great circle while its height over the surface eases on a log scale (a height under the sphere, over a low place, is carried in at the end).
    var dFrom = _aeSub(from.pos, fr.center), dTo = _aeSub(world, fr.center), rFrom = Math.max(_aeLen(dFrom), 1e-12), rTo = Math.max(_aeLen(dTo), 1e-12);
    var hFrom = Math.max(rFrom - fr.r, AS_MIN_HEIGHT_RE), hTo = Math.max(rTo - fr.r, AS_MIN_HEIGHT_RE), hNow = Math.exp(Math.log(hFrom) + (Math.log(hTo) - Math.log(hFrom)) * e);
    var below = (rTo - fr.r - hTo) * e * e;   // (the final height under the sphere, if any)
    world = _aeAdd(fr.center, _aeScale(_asSlerp(_aeScale(dFrom, 1 / rFrom), _aeScale(dTo, 1 / rTo), e), fr.r + hNow + below));
    if (st.far && st.phase === 'drop') {
      var ahead = from.focus ? _aeNorm(_aeSub(from.focus, world)) : _aeNorm(_aeSub(from.look, from.pos)), toC = _aeNorm(_aeSub(fr.center, world)), toFocus = _aeNorm(_aeSub(focusW, world));
      // The look leans from the world it leaves to the one it goes to by how far apart they are in the picture (the more apart, the sooner it is on the destination), never by a clock:
      // each stays within a share of the picture's half-width of the look while the angle between them is small, and the departed one leaves the frame as it passes the destination's side.
      var half = Math.min(_aeRad(AS_FOV_DEG) / 2, Math.atan(_aeTanHalf(AS_FOV_DEG) * Math.min(1, _ae.w / Math.max(_ae.h, 1)))), apart = Math.acos(_aeClamp(_aeDot(ahead, toC), -1, 1));
      var lean = _aeClamp(apart / (AS_FAR_APART * half), 0, 1);
      var lookC = apart < 1e-6 ? toC : _asSlerp(ahead, toC, lean);
      look = _aeNorm(_aeAdd(_aeScale(lookC, 1 - _smoothstep(AS_FAR_TURN[1], AS_FAR_TURN[2], e)), _aeScale(toFocus, _smoothstep(AS_FAR_TURN[1], AS_FAR_TURN[2], e))));
    } else look = _aeNorm(_aeAdd(_aeScale(_aeNorm(_aeSub(from.focus || from.look, world)), 1 - e), _aeScale(_aeNorm(_aeSub(focusW, world)), e)));   // (from the body it looked at: a point just ahead of the eye swung the look off the body as the eye moved)
    up = _aeNorm(_aeAdd(_aeScale(from.up, 1 - e), _aeScale(fr.u, e)));
    // The field of view goes the way the camera does: from the orbit view's to the ground's (and back on the way out), never a snap of the lens at either end.
    var fovTo = loc.fov || AS_FOV_DEG, fovFrom = st.eye0 ? fovTo : AE_FOV_DEG;
    loc = { pos: loc.pos, focus: loc.focus, fov: _aeDeg(2 * Math.atan(_aeLogLerp(_aeTanHalf(fovFrom), _aeTanHalf(fovTo), e))) };
    st.dropE = e;
  }
  return _asPoseOut(st, loc, world, look, up, focusW);
}
// The pose from a place, a look and an up, with the near plane for what is looked at.
function _asPoseOut(st, loc, world, look, up, focusW) {
  var fr = st.fr;
  up = _aeSub(up, _aeScale(look, _aeDot(up, look)));
  up = _aeLen(up) < 1e-6 ? fr.e : _aeNorm(up);
  var alt = _aeLen(_aeSub(world, fr.center)) - fr.r;
  // The near plane stands off in proportion to what is looked at: a lander's feet from a few metres, a launch from half a kilometre.
  var camHeight = loc.pos[2] - _asGroundAt(st, loc.pos[0], loc.pos[1], true);
  var nearM = _aeClamp(_aeLen(_aeSub(focusW, world)) / AS_MRE * AS_NEAR_PER_FOCUS, AS_NEAR_M, _aeClamp(camHeight * 0.8, AS_NEAR_M, AS_NEAR_MAX_M));
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
  if (st.phase === 'fly' && st.adopt) {   // on the ground stood on: no drop, the visit begins where one stands
    st.phase = 'stand'; st.from = null; st.t0 = now;
    _asAdoptEye(st);   // the eye where one stood, from this very frame
    _ae.el.classList.add('ae-site');
    _asHud(true);
  }
  if (st.phase === 'fly') {
    if (st.eye0) st.pose = _asEyePose(st);   // from Stand: the camera holds where it stood while the terrain arrives (no orbit view in between)
    else if (!st.far) {
      if (_ae.fly) return;
      if (_ae.target !== st.body) { _aeSiteLeave(); return; }
    }
    if (!st.groundReady) return;   // the terrain is still arriving
    if (st.host && !st.host.live && !st.host.pend.ready && now - (st.hostWait || (st.hostWait = now)) < AS_HOST_WAIT_MS) return;   // and Stand here's ground for it: the drop is in that one ground from the top
    var cam = S.camera;
    var look = new S.THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), upv = new S.THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    st.from = st.eye0 ? { pos: st.pose.pos, look: st.pose.tp, up: st.pose.up } : { pos: _aeXyz(cam.position), look: [cam.position.x + look.x, cam.position.y + look.y, cam.position.z + look.z], up: _aeXyz(upv), focus: _aeTargetPos().slice() };   // focus: the body it was looking at, which the camera keeps in view while it leaves
    if (st.eye0) st.dropMs = AS_EYE_DROP_MS;
    else if (!st.far) st.dropMs = AE_MOVE_MS;
    else if (st.far) {
      // The longer the way, the longer the move (a decade of distance more is AS_FAR_MS_PER_DECADE), never past AS_FAR_MS_MAX.
      st.dropMs = Math.min(AS_FAR_MS_MAX, AE_MOVE_MS + AS_FAR_MS_PER_DECADE * Math.log10(Math.max(1, _aeLen(_aeSub(st.from.pos, st.fr.center)) / (AS_FAR_FROM_R * st.fr.r))));
      _ae.target = st.body; _ae.pan = null; _ae.preset = null;   // the visit's camera has the picture from here
    }
    st.from0 = st.from;   // where the way down began: the way out ends there
    st.phase = st.linked ? 'stand' : 'drop';   // a link lands on the ground at once
    st.t0 = now;
    if (_aeReduceMotion()) st.t0 = now - (st.dropMs || AS_DROP_MS);
    _ae.el.classList.add('ae-site');
    _asHud(true);
    // A site in the dark opens at the landing, the Sun up (the clock button goes back).
    if (st.fr.sunLocal[2] < AS_MIN_SUN_Z && st.def && st.def.ms && !st.linked) { st.nowMark = _asClockMark(sc.ms); st.atLanding = true; _aeGoTo(st.def.ms); }
  }
  if (!st.group) { _asGroupBuild(st); }
  if (st.phase === 'drop' && now - st.t0 >= (st.dropMs || AS_DROP_MS)) { st.phase = 'stand'; st.from = null; st.getIn = false; }
  if (st.phase === 'rise' && now - st.t0 >= (st.dropMs || AS_DROP_MS)) { _asWholeEnd(st, st.from0); return; }
  _asPlaceSiteParts(st);
  if (st.drive && typeof _asRoverBuild === 'function') _asRoverBuild(st);
  if (st.adopt && st.rover && st.drive && !st.outOf && !st.calledUp) { st.calledUp = true; st.calledAt = performance.now(); st.drive = false; st.outOf = true; _asHud(true); _aeHudRender(); }
  if (st.adopt && st.outOf && st.calledUp && !st.atEye && st.rover && !st.rover.airborne) _asDriveAtEye(st);   // down: driving it, the picture as it was   // the rover is there: one is on foot beside it until it has come down
  if (st.rover) _asRoverStep(st, dt);
  if (_ae.site !== st) return;   // steering took over a journey and opened a new visit: this one is disposed
  // The ground follows what is looked at.
  var mx = st.rover ? st.rover.x : st.followPos ? st.followPos[0] : 0, my = st.rover ? st.rover.y : st.followPos ? st.followPos[1] : 0;
  if (Math.hypot(mx - st.cx, my - st.cy) > AS_RECENTRE_M || st.cx === 1e9) _asRebuildGround(st, mx, my);
  if (st.launch) _asLaunchStep(st, dt);
  if (st.ascent) _asAscentStep(st);
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
  var hide = down && st.pose.altRe < AS_HIDE_SHARE * AS_PATCH_R_M * AS_PATCH_R_M / (2 * st.radiusM) * AS_MRE;
  if (!!st.bodyHid !== hide) { st.bodyHid = hide; _asBodyShown(st, S, !hide); }   // (on a change only: the rest of the time the sphere is the view's own)
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
  if (typeof _asPartsByTime === 'function') _asPartsByTime(st);
  sh.fade.value = _aeFadeU.value;
  // The Sun low: shadows are long and not longer.
  var ss = Math.max(AS_SHADOW_MIN_SUN_Z, sunZ), sl = Math.hypot(fr.sunLocal[0], fr.sunLocal[1]) || 1, k = Math.sqrt(Math.max(0, 1 - ss * ss)) / sl;
  st.shadowSun = [fr.sunLocal[0] * k, fr.sunLocal[1] * k, ss];
  st.parts.forEach(function (p) {
    p.su.sun.value.set(st.shadowSun[0], st.shadowSun[1], st.shadowSun[2]);
    p.shadow.visible = lit > 0.02 && down && !p.opts.noShadow && p.timeOn !== false;
    p.holder.visible = down && p.timeOn !== false;
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
    var air = st.info.air;   // the light of a world with an atmosphere: a tinted Sun, the sky's own light from above, dust on top faces
    if (air) { I.uni.sunTint.value.set(air.sun[0], air.sun[1], air.sun[2]); I.uni.skyAmb.value.set(air.sky[0] * lit, air.sky[1] * lit, air.sky[2] * lit); I.uni.dustCol.value.set(air.dust[0], air.dust[1], air.dust[2]); I.uni.dustAmt.value = air.dustAmt; }
  });
  if (st.dust) { st.dust.uni.lit.value = lit; st.dust.uni.pxPerRad.value = _aePxPerRad(cam); }
}
// The view's camera in place of the orbit camera: the pose the visit worked out, as the base's own camera description.
function _aeSiteCam(c) {
  var st = _ae.site;
  return { tp: st.pose.tp, az: 0, el: 0, dist: 1, tanHalf: _aeTanHalf(st.pose.fov || AS_FOV_DEG), roll: 0, frame: null, pose: st.pose };
}
// The body's own sphere (and an atmosphere's shell round the Earth) give way to the patch of ground, and come back above it (the way up draws the globe under the ground).
function _asBodyShown(st, S, on) {
  if (st.body === 'moon') S.moon.visible = on;
  else if (st.body === 'earth') {
    S.earth.visible = on;
    if (st.atmo === undefined) st.atmo = S.scene.children.filter(function (o) { return o.material && o.material.fragmentShader === AE_ATMO_FRAG; })[0] || null;
    if (st.atmo) st.atmo.visible = on;
  } else if (S.planets && S.planets[st.body]) S.planets[st.body].mesh.visible = on;
}
// The camera's near plane close to the ground: the nearest thing is metres off.
function _aeSiteNear(near) {
  var st = _ae.site;
  if (!st || !st.pose) return near;
  return _aeClamp(st.pose.altRe * 0.05, st.pose.nearRe, near);
}

// ── Interface: the pointer surface, the buttons, the caption ──
var AS_CSS = [
  '.ae-view.ae-site .ae-top,.ae-view.ae-site .ae-bottom,.ae-view.ae-site .ae-labels,.ae-view.ae-site .ae-lms{display:none!important}',
  '.as-hud{position:absolute;inset:0;z-index:50;pointer-events:none;display:none}',
  '.ae-view.ae-site .as-hud{display:block}',
  '.as-layer{position:absolute;inset:0;pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none}',
  '.as-tools{position:absolute;top:calc(max(var(--ae-pin-h,0px), env(safe-area-inset-top)) + 28px);inset-inline:12px;display:flex;justify-content:flex-end;gap:8px;pointer-events:none}',
  '.as-tools>*{pointer-events:auto}',
  '.as-tools-end{display:flex;gap:' + AS_CORNER_GAP_PX + 'px}',   // the controls layer's small discs (ah-minor), a finger's pitch apart
  '.as-tools .ae-btn{position:relative;overflow:visible}',
  // The stick: a solid ring (cruise) and, beyond it, a faint dotted one (push further: time runs faster, the knob turns amber).
  '.as-stick,.as-rest{position:absolute;width:' + (AS_STICK_R_PX * 2) + 'px;height:' + (AS_STICK_R_PX * 2) + 'px;margin:-' + AS_STICK_R_PX + 'px 0 0 -' + AS_STICK_R_PX + 'px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.07);pointer-events:none}',
  '.as-stick:before,.as-rest:before{content:"";position:absolute;inset:-' + (AS_STICK_R_PX * (AS_STICK_OUTER - 1) + 2) + 'px;border-radius:50%;border:2px dotted rgba(255,255,255,.45)}',
  '.as-stick i,.as-rest i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,.5);border:2px solid rgba(255,255,255,.6)}',
  '.as-rest i{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.3)}',
  // The drive's one small button, bottom right, collapsed; tapped it opens the views by name and the two ways out (no cycling circle, no arrow).
  // It stands left of the corner's way back to space, a rank below it (the controls layer's smaller disc); its menu opens above the corner.
  '.as-menu-btn,.as-menu{position:absolute;z-index:52;pointer-events:auto}',
  '.as-menu-btn{inset-inline-end:calc(' + (AS_CORNER_PX + AS_CORNER_GAP_PX) + 'px + env(safe-area-inset-right));bottom:calc(' + (12 + AS_MENU_DROP_PX) + 'px + env(safe-area-inset-bottom))}',
  '.as-menu{inset-inline-end:calc(12px + env(safe-area-inset-right));bottom:calc(' + (AS_CORNER_PX + AS_CORNER_GAP_PX) + 'px + env(safe-area-inset-bottom))}',
  '.as-hud:not(.as-driving) .as-menu-btn,.as-hud:not(.as-driving) .as-menu{display:none}',
  '@keyframes as-in{from{opacity:0}}.as-hud.as-driving>*{animation:as-in .6s ease-out .2s backwards}',   // the drive's controls fade in as it starts (and on getting back in)
  '@media (prefers-reduced-motion:reduce){.as-hud.as-driving>*{animation:none}}',
  '.as-menu[hidden]{display:none}',
  '.as-menu{width:220px;box-sizing:border-box;padding:6px 0;background:var(--sheet-bg,#141416);border:1px solid var(--border);border-radius:var(--r-sheet,14px);box-shadow:var(--shadow-popup,0 8px 32px rgba(0,0,0,.5));color:var(--text);font-size:var(--fs-body,15px)}',
  '.as-menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:0 16px;border:0;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer}',
  '.as-menu button[aria-checked="true"]{color:var(--amber);font-weight:600}',
  '.as-menu button[aria-checked="true"]::after{content:"";margin-inline-start:auto;width:8px;height:8px;border-radius:50%;background:var(--amber)}',
  '.as-menu .as-mi{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.as-menu .as-mi .ae-rim-lit{fill:var(--amber);stroke:none}.as-menu .as-mi .ae-rim-dim{fill:currentColor;stroke:none}',
  '.as-menu button span{flex:1;min-width:0}',
  '.as-menu button:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
  '.as-menu hr{border:0;border-top:1px solid var(--border);margin:4px 0}',
  '.ae-view.ae-bare .as-menu-btn,.ae-view.ae-bare .as-menu{opacity:0;visibility:hidden}',
  '.ae-view.ae-bare .as-rest,.ae-view.ae-bare .as-tools,.ae-view.ae-bare .as-strip{opacity:0;visibility:hidden}',   // hiding the controls only fades them: nothing is removed, nothing reflows
  '.as-hud.as-holding .as-rest{opacity:0}',   // one ring at a time: the thumb's own, once it is down
  '.as-stick.as-fast i{background:var(--amber);border-color:var(--amber)}',
  '.as-rest{left:calc(' + AS_REST_X_PX + 'px + env(safe-area-inset-left));top:auto;bottom:calc(' + AS_REST_Y_PX + 'px + env(safe-area-inset-bottom));margin:0 0 -' + AS_STICK_R_PX + 'px -' + AS_STICK_R_PX + 'px;opacity:.55}',
  // Driving shows the picture, the stick, one pill and the view's own camera and rim buttons: what belongs to the site view stays off it.
  '.as-hud.as-driving .as-tools,.as-hud.as-driving .as-launch,.as-hud.as-driving .as-strip{display:none}',
  '.as-earthhint{position:absolute;left:0;top:0;width:38px;height:38px;padding:0;pointer-events:none;display:flex;align-items:center;justify-content:center}',
  '.as-earthhint b{width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#8fb8ff,#2f5fc4 70%,#1b3a7a)}',
  '.as-earthhint-arrow{position:absolute;inset:0;pointer-events:none}',
  '.as-earthhint-arrow:before{content:"";position:absolute;left:50%;top:-5px;margin-left:-5px;border:5px solid transparent;border-bottom:7px solid rgba(255,255,255,.85);border-top:0}',
  '.as-hud.as-wait>*:not(.as-tools){visibility:hidden}.as-hud.as-wait .as-tools-end{visibility:hidden}',   // over a blank screen during the drop only the way out shows
  // Red light: the stick, its resting ring and the thumbnails take the red, as the fly and walk sticks do.
  '.night-red .as-stick,.night-red .as-rest{border-color:rgba(200,40,40,.45)}',
  '.night-red .as-stick:before,.night-red .as-rest:before{border-color:rgba(200,40,40,.45)}',
  '.night-red .as-stick i{background:rgba(200,40,40,.6);border-color:rgba(255,90,90,.6)}',
  '.night-red .as-rest i{background:rgba(200,40,40,.25);border-color:rgba(200,40,40,.35)}',
  '.night-red .as-feats b{color:var(--text)}',
  '.night-red .as-pic{filter:var(--red-picture)}',
  '.as-go .ae-btn{min-width:44px;min-height:44px}',
  '.ae-sitecard .ae-sc-face .ae-go-disc{--s:44px;display:block;width:44px;height:44px;border-radius:50%;background-color:var(--cc);background-image:var(--g);background-size:100% 100%;background-position:0 0}',   // the body's disc on the card: its own gradient (the sheet's sprite is drawn only once the Go to sheet has opened)
  '.ae-sitecard .ae-sc-face .ae-sent-img{display:block;width:44px;height:44px}.ae-sc-text b{color:var(--text)}',   // the craft's render at the card's size (the Sent list's own rule comes with that list); the name in the text colour   // the body's disc on the card: the sprite at the card's size (it showed a crescent of the sheet)
  '.ae-sitecard{display:flex;align-items:center;gap:10px;min-height:62px}.ae-sitecard .ae-sc-face{flex:none;width:44px;height:44px;border-radius:50%;overflow:hidden}.ae-sc-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.ae-sc-text b{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ae-sc-text small{font-size:12px;color:var(--text2)}',
  'html .ae-sitecard .ae-btn.ae-round,html .ae-sitecard.as-go .ae-btn.ae-round.as-drive-main{--round:44px;width:44px;height:44px;min-width:44px;padding:0}',
  'html .as-go .ae-btn.as-visit-main{flex:none;height:44px;padding:0 18px;border-radius:22px;background:var(--amber);border-color:var(--amber);color:#17130a;font:inherit;font-size:var(--fs-body,15px);font-weight:600;white-space:nowrap}',   // the card's one action: solid amber, a word
  'html .as-go .ae-btn.ae-round.as-drive-main{width:auto;height:52px;min-width:52px;padding:0 20px 0 14px;gap:8px;border-radius:26px;background:var(--amber);border-color:var(--amber);color:#17130a;font:inherit;font-size:var(--fs-body,15px);font-weight:600}',   // the view's one action: solid amber, over the round buttons' glass
  'html .ae-btn.ae-round.as-launch{width:64px;height:64px;min-width:64px}',
  // The strip ends beside the corner's disc (the way back to space keeps its place there) and fades into it.
  '.as-strip{position:absolute;inset-inline:0 calc(' + AS_CORNER_PX + 'px + env(safe-area-inset-right));bottom:calc(8px + env(safe-area-inset-bottom));height:' + AS_STRIP_H_PX + 'px;display:flex;gap:6px;overflow-x:auto;padding:0 ' + AS_STRIP_FADE_PX + 'px 0 12px;pointer-events:auto;-webkit-overflow-scrolling:touch;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - ' + AS_STRIP_FADE_PX + 'px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - ' + AS_STRIP_FADE_PX + 'px),transparent)}',
  '[dir="rtl"] .as-strip{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - ' + AS_STRIP_FADE_PX + 'px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - ' + AS_STRIP_FADE_PX + 'px),transparent)}',
  '.as-item{flex:0 0 auto;width:' + AS_ITEM_PX + 'px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 0 0;background:none;border:0;color:var(--text2);font:inherit;cursor:pointer;touch-action:pan-x}',
  '.as-pic{width:' + AS_THUMB_PX + 'px;height:' + AS_THUMB_PX + 'px;border-radius:50%;background:rgba(14,14,16,.72);border:1px solid var(--border);background-repeat:no-repeat}',
  '.as-item b,.as-item small,.as-feats b{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.95),0 0 7px rgba(0,0,0,.75)}',
  // A name stands on a dark plate (the ground it is over can be as bright as the Moon's), 12 px, whole words (a word longer than the line is the only thing that breaks).
  '.as-item b,.as-feats b{font-weight:600;font-size:' + AS_NAME_PX + 'px;background:rgba(0,0,0,.55);border-radius:6px;padding:1px 5px}',
  '.as-item b{line-height:1.15;max-width:' + AS_ITEM_PX + 'px;box-sizing:border-box;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:break-word;text-align:center}',   // a name takes two lines, not an ellipsis after ten letters (the corner names the tapped part in full)
  '.as-pic.as-crater{background:radial-gradient(ellipse 48% 30% at 50% 50%,rgba(0,0,0,.55) 60%,rgba(255,255,255,.35) 66%,transparent 70%),rgba(14,14,16,.72)}',
  '.as-item small{font-size:var(--fs-caption,11px);color:var(--text3)}',
  '.as-item.as-on b:after{content:"";display:block;width:16px;height:2px;margin:2px auto 0;border-radius:1px;background:var(--amber)}',
  '.as-hud.as-lifting .as-strip{opacity:.35}',
  '.as-strip{padding-top:6px}.as-hud.as-has-strip:not(.as-driving)::after{content:"";position:absolute;inset-inline:0;bottom:0;height:calc(' + (AS_STRIP_H_PX + 14) + 'px + env(safe-area-inset-bottom));z-index:-1;background:linear-gradient(to top,rgba(0,0,0,.45),transparent);pointer-events:none}',   // the shade under the strip spans the view's width
  '.as-strip[hidden]{display:none}',   // (its own display would keep a put-away strip on screen)
  '.as-feats b{position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none}',
  '.as-dots i{position:absolute;left:0;top:0;width:28px;height:28px;pointer-events:none}',
  '.as-dots i:after{content:"";position:absolute;left:10px;top:10px;width:5px;height:5px;border-radius:50%;border:1.5px solid rgba(255,255,255,.6);background:rgba(255,255,255,.2)}',
  '.as-launch{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(' + (8 + AS_STRIP_H_PX + AS_LAUNCH_GAP_PX) + 'px + env(safe-area-inset-bottom));width:64px;height:64px;pointer-events:auto}',   // above the strip, not over it
  '.as-count{position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:center;padding-top:26%;box-sizing:border-box;font-size:84px;font-weight:700;color:rgba(255,255,255,.85);text-shadow:0 2px 18px rgba(0,0,0,.6);pointer-events:none;font-variant-numeric:tabular-nums}'
].join('');
var AS_EYE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5.5" r="2.3"/><path d="M12 8.5v6M8.5 11.5l3.5-1 3.5 1M12 14.5l-2.5 5.5M12 14.5l2.5 5.5"/></svg>';
var AS_PHONE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/></svg>';
var AS_LAUNCH_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c3 2.5 4 6 4 9l-2 3h-4l-2-3c0-3 1-6.5 4-9z"/><circle cx="12" cy="9" r="1.4"/><path d="M10 15l-2 3.5M14 15l2 3.5M12 17v4"/></svg>';
var AS_ROUTE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/></svg>';
var AS_FOLLOW_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21V4M6 5h11l-2.5 3.5L17 12H6"/></svg>';   // the mission's flag: follow it
var AS_WHOLE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="2"/></svg>';
// The three views, drawn: brackets round a small vehicle (wide), round a big one (near), an eye (the seat).
var AS_VIEW_SVGS = [
  '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4"/><rect x="9" y="10.5" width="6" height="3" rx=".8"/></svg>',
  '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4"/><rect x="6" y="8.5" width="12" height="7" rx="1.4"/></svg>',
  '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>'
];
var AS_FF_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-inline-end:6px"><path d="M4 6l7 6-7 6zM13 6l7 6-7 6z"/></svg>';   // time sped up
var AS_VIEW_KEYS = ['alm_site_view_wide', 'alm_site_view_near', 'alm_site_view_seat'];
var AS_DRIVE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="17" r="2.6"/><circle cx="17.5" cy="17" r="2.6"/><path d="M4 14.2h16M8.5 14.2V9.5h3.5v4.7M15.5 14.2V6.5M13.3 6.5h4.4"/></svg>';   // the rover, side on: its wheels, its seat, its dish on its mast

// The seat's view or the chase's: one button, one flag; the look is square again so neither starts turned away.
// The camera button: wide chase, near chase, the seat, and round again (the vehicle's table row gives the chase distances and the eye).
function _asViewSet(st, view) {
  var info = st.info.rover;
  st.view = view; st.seat = view === 2 && !!info.seat;
  if (st.seat) st.view = 2; else st.camera.dist = info.cam * AS_VIEW_CHASE_K[Math.min(view, 1)];
  st.look.yaw = 0; st.look.pitch = 0;
  _aeRedraw();
}
function _asSeatToggle(st) {
  if (!st || !st.drive || !st.info.rover) return;
  var n = st.info.rover.seat ? 3 : 2, next = ((st.view || 0) + 1) % n;
  _asViewSet(st, next);
  if (typeof _aeRimSync === 'function') _aeRimSync(true);
  if (typeof _aeShowHint === 'function') _aeShowHint(_aeT(AS_VIEW_KEYS[next]));   // its name, for a moment, and only then
}
// The ground's styles, put in the page once: by the landing card (whose amber Drive button is one of them) or by the first visit, whichever is first.
function _asStyle() { _aeCss('as-css', AS_CSS); }
function _asHud(on) {
  var el = _ae && _ae.el;
  if (!el) return;
  var hud = _aeById('as-hud');
  if (!on) {   // leaving takes all the drive's chrome with it: nothing of it is left to show when the view comes back
    if (hud) {
      hud.classList.remove('as-driving', 'as-holding');
      _asMenuOpen(false);
      if (typeof _almStripCap === 'function') _almStripCap(0);   // the rate cap a steering thumb or key set goes with the drive
      _ae.el.classList.remove('ae-driving');
      ['as-stick', 'as-rest'].forEach(function (id) { var e = _aeById(id); if (e) e.hidden = true; });
      _aeHudRead(''); _aeHudSub('');
      ['ah-read', 'ah-sub'].forEach(function (id) { var e = _aeById(id); if (e) e.textContent = ''; });   // (with a card up the corner is not painted again: its last words would wait there, hidden, for the next drive)
    }
    _asKeys(false);
    return;
  }
  if (!hud) {
    _asStyle();
    hud = document.createElement('div');
    hud.className = 'as-hud'; hud.id = 'as-hud';
    var routeL = _almEsc(_aeT('alm_site_trail')), eyeL = _almEsc(_aeT('alm_stand_eye')), motionL = _almEsc(_aeT('alm_stand_motion'));
    hud.innerHTML = '<div class="as-layer" id="as-layer"></div><div class="as-rest" id="as-rest" hidden><i></i></div><div class="as-stick" id="as-stick" hidden><i></i></div>' +
      '<div class="as-tools">' +
      '<div class="as-tools-end"><button type="button" class="ae-btn ae-round" id="as-trailbtn" aria-label="' + routeL + '" title="' + routeL + '" hidden>' + AS_ROUTE_SVG + '</button><button type="button" class="ae-btn ae-round" id="as-liftoff" aria-label="' + _almEsc(_aeT('alm_site_liftoff')) + '" title="' + _almEsc(_aeT('alm_site_liftoff')) + '" hidden>' + AS_LAUNCH_SVG + '</button><button type="button" class="ae-btn ae-round" id="as-follow" aria-label="' + _almEsc(_aeT('alm_site_follow')) + '" title="' + _almEsc(_aeT('alm_site_follow')) + '" hidden>' + AS_FOLLOW_SVG + '</button><button type="button" class="ae-btn ae-round" id="as-whole" aria-label="' + _almEsc(_aeT('alm_site_whole')) + '" title="' + _almEsc(_aeT('alm_site_whole')) + '">' + AS_WHOLE_SVG + '</button><button type="button" class="ae-btn ae-round" id="as-eye" aria-label="' + eyeL + '" title="' + eyeL + '" hidden>' + AS_EYE_SVG + '</button><button type="button" class="ae-btn ae-round" id="as-motion" aria-label="' + motionL + '" title="' + motionL + '" aria-pressed="false" hidden>' + AS_PHONE_SVG + '</button></div></div>' +
      '<div class="as-count" id="as-count" aria-hidden="true"></div>' +
      '<button type="button" class="ae-btn ae-round as-launch" id="as-launch" aria-label="' + _almEsc(_aeT('alm_site_launch')) + '" title="' + _almEsc(_aeT('alm_site_launch')) + '" hidden>' + AS_LAUNCH_SVG + '</button>' + _asMenuHtml();
    Array.prototype.forEach.call(hud.querySelectorAll('.as-tools .ae-round'), function (b) { b.classList.add('ah-minor'); });
    el.appendChild(hud);
    _asBindHud(hud);
    _asMenuBind(hud);
  }
  hud.classList.toggle('as-driving', !!(_ae.site && _ae.site.drive));
  _ae.el.classList.toggle('ae-driving', !!(_ae.site && _ae.site.drive));
  _aeById('as-rest').hidden = !(_ae.site && _ae.site.drive);
  _aeById('as-launch').hidden = !(_ae.site && _ae.site.def && _ae.site.def.launch);
  _aeById('as-liftoff').hidden = !(_ae.site && _ae.site.def && _ae.site.def.liftoff && !_ae.site.drive);
  _aeById('as-follow').hidden = !(_ae.site && _ae.site.def && _ae.site.def.mission && typeof _aeMissionStart === 'function');
  _asEyeSync(_ae.site);
  _aeById('as-trailbtn').hidden = !(_ae.site && _ae.site.def && _ae.site.def.trail);
  _asKeys(true);
  _asCaption(_ae.site);
}
// The drive's menu: the views by name (the seat only where the vehicle has one), get out and walk (Stand here's ground where the vehicle
// is), zoom back out (the body's orbit view). Closed by a tap outside it, Escape or the button.
var AS_DOTS_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';   // the menu opener: three lines
function _asMenuHtml() {
  var lab = _almEsc(_aeT('alm_drive_menu'));
  // A row's glyph: the icon's own svg, sized by the menu (.as-mi), whatever attributes it came with.
  var ic = function (svg) {
    return String(svg).replace(/<svg\b([^>]*)>/, function (m, attrs) {
      attrs = attrs.replace(/\s(?:class|width|height)="[^"]*"/g, '');
      return '<svg class="as-mi"' + attrs + '>';
    });
  };
  return '<button type="button" class="ae-btn ae-round ah-minor as-menu-btn" id="as-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="as-menu" aria-label="' + lab + '" title="' + lab + '">' + AS_DOTS_SVG + '</button>' +
    '<div class="as-menu" id="as-menu" role="menu" aria-label="' + lab + '" hidden>' +
    AS_VIEW_KEYS.map(function (k, i) { return '<button type="button" role="menuitemradio" aria-checked="false" data-as-view="' + i + '">' + ic(AS_VIEW_SVGS[i]) + '<span>' + _almEsc(_aeT(k)) + '</span></button>'; }).join('') +
    '<hr><button type="button" role="menuitem" data-as-go="walk">' + ic(typeof ALM_STAND_SVG === 'string' ? ALM_STAND_SVG : '') + '<span>' + _almEsc(_aeT('alm_drive_walk')) + '</span></button>' +
    '<button type="button" role="menuitem" data-as-go="out">' + ic(typeof ALM_RIM_SVG === 'string' ? ALM_RIM_SVG : '') + '<span>' + _almEsc(_aeT('alm_drive_out')) + '</span></button></div>';
}
function _asMenuOpen(on) {
  var m = _aeById('as-menu'), b = _aeById('as-menu-btn');
  if (!m || !b) return;
  if (on) _asMenuSync(_ae.site);
  m.hidden = !on; b.setAttribute('aria-expanded', String(!!on)); b.style.visibility = on ? 'hidden' : '';
  if (on) { var first = m.querySelector('[aria-checked="true"]') || m.querySelector('button'); if (first) first.focus(); }
}
function _asMenuSync(st) {
  var m = _aeById('as-menu');
  if (!m || !st || !st.info || !st.info.rover) return;
  Array.prototype.forEach.call(m.querySelectorAll('[data-as-view]'), function (b) {
    var i = +b.getAttribute('data-as-view');
    b.hidden = i === 2 && !st.info.rover.seat;
    b.setAttribute('aria-checked', String((st.view || 0) === i));
  });
}
function _asMenuBind(hud) {
  var m = _aeById('as-menu'), b = _aeById('as-menu-btn');
  b.onclick = function () { _asMenuOpen(m.hidden); };
  m.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null, st = _ae.site;
    if (!t || !st) return;
    if (t.hasAttribute('data-as-view')) { _asViewSet(st, +t.getAttribute('data-as-view')); _asMenuSync(st); _asMenuOpen(false); b.focus(); return; }
    _asMenuOpen(false);
    var go = t.getAttribute('data-as-go'), body = st.body;
    if (go === 'out') { _aeSiteRise(); return; }
    if (_asGetOut(st)) return;
    var ll = _asLatLon(st, _asBody(body), _aeXyz(st.rover));   // walk: Stand here's ground, where the vehicle stands, facing where it faced; the drive's picture stays until the ground is there
    _aeStandAt(body, ll.lat, ll.lon, { heading: ((-st.rover.hdg * 180 / Math.PI) % 360 + 360) % 360, pitch: AE_STAND_PITCH_DEG, zoom: 1, fromSite: true });
  });
  document.addEventListener('pointerdown', function (e) { if (!m.hidden && !m.contains(e.target) && !b.contains(e.target)) _asMenuOpen(false); }, true);
  document.addEventListener('keydown', function (e) {
    if (m.hidden) return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); _asMenuOpen(false); b.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;   // a menu is walked with the arrows
    var items = Array.prototype.filter.call(m.querySelectorAll('button'), function (x) { return !x.hidden && x.offsetParent; });
    if (!items.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var at = items.indexOf(document.activeElement), to = e.key === 'ArrowDown' ? at + 1 : at - 1;
    items[(to + items.length) % items.length].focus();
  }, true);
}
// Walk around: out of the driver's seat onto the ground beside it, at eye height, facing where the rover faces; the rover stays where it stopped.
// The same picture and ground go on (no trip out to Stand here's): the drive's own on-foot eye (almanac-standhost.js). The eye button gets back in.
var AS_OUT_SIDE_M = 1.0;   // how far out from the seat, on the driver's side
function _asGetOut(st) {
  _aeDbg('rover', 'menu: get out and walk');
  var R = st.rover, seat = st.info.rover && st.info.rover.seat;
  if (!R || !seat || !st.drive || !(st.host && st.host.live) || typeof _aeHostEyeToggle !== 'function') return false;
  var was = st.phase === 'stand' && !_aeReduceMotion() ? _asCameraLocal(st, 0) : null;   // the drive's camera, to ease from (local metres)
  R.v = 0;
  st.input.keys = {}; st.input.sx = st.input.sy = 0; st.input.fast = false;
  if (st.auto) st.auto = null;
  st.drive = false; st.outOf = true;
  st.focusXY = [R.x, R.y];   // (a walk keeps near here: where the rover stands now)
  _aeHostEyeToggle(st);
  var fx = -Math.sin(R.hdg), fy = Math.cos(R.hdg), lx = seat[0] - AS_OUT_SIDE_M, ly = seat[1];   // ahead, and the seat's side (x: right of the rover)
  st.eye.x = R.x + fy * lx + fx * ly; st.eye.y = R.y - fx * lx + fy * ly;
  st.eye.yaw = Math.atan2(fx, fy); st.eye.pitch = AE_HOST_EYE_PITCH;
  if (was) _asGroundMove(st, was);
  _asHud(true); _aeHudRender(); _aeKick();
  return true;
}
// On the ground one stood on, with the rover just called up: the picture does not change at all, the rover falls in ahead of it
// from over the top of the screen and waits; the button (Get in) puts one in the seat, the camera easing round.
var AS_CALL_WAIT_MS = 20000;   // the most a called rover waits overhead for the camera to come down before it falls anyway (after time travel it never came, and moving walked the view about)
function _asCallWaitOver(st) { return !!st.calledAt && performance.now() - st.calledAt > AS_CALL_WAIT_MS; }
var AS_HOST_WAIT_MS = 15000;   // the most a visit holds at the top of its drop for its ground to be built (else the site's own patch shows until it comes)
var AS_CALL_AHEAD_M = 12, AS_CALL_TURN_DEG = 30, AS_GETIN_MS = 1100;   // where it comes down: this far ahead, turned a little across the view so it reads as a vehicle
function _asAdoptEye(st) {
  var e0 = st.eye0;
  st.focusXY = [e0.x, e0.y];
  st.eyeFov = e0.fov;   // the very field of view one stood with: the picture does not change
  st.eye = { on: true, x: e0.x, y: e0.y, yaw: e0.yaw, pitch: _aeClamp(e0.pitch, -1.2, 1.2), motion: null };   // (made here, not by the eye's toggle: the rover is still being built, so the visit is still a drive)
  st.camOverride = _aeHostEyeCam;
}
// One eased move of the camera over the ground, from `was` ({ pos, focus } in the ground's metres) to wherever the camera now wants to be.
function _asGroundMove(st, was) {
  st.from = { posM: was.pos, focusM: was.focus }; st.phase = 'drop'; st.t0 = performance.now(); st.dropMs = AS_GETIN_MS; st.getIn = true;
}
// The rover called up has come down: one drives it from here, the picture exactly as it was ("view doesn't change at all"). The drive's
// following camera is set to the eye's own place and look (the point it looked at, at the rover's distance, its centre; its height over the
// horizon unclamped), and holds there until the rover first moves or a finger turns the look; then it follows as it always does.
function _asDriveAtEye(st) {
  _aeDbg('rover', 'called rover has landed: driving at the eye');
  st.atEye = true;
  var e = st.eye, r = st.rover, c = st.camera;
  if (!e || !r) return;
  var eyeZ = _asGroundAt(st, e.x, e.y, false) + AE_STAND_EYE_M, cp = Math.cos(e.pitch), d = Math.max(1, Math.hypot(r.x - e.x, r.y - e.y));
  st.focus = [e.x + Math.sin(e.yaw) * cp * d, e.y + Math.cos(e.yaw) * cp * d, eyeZ + Math.sin(e.pitch) * d];
  c.dist = d; c.az = Math.PI - e.yaw;
  st.look.yaw = _aeAngleDeltaRad(r.hdg + Math.PI, c.az); st.look.pitch = -e.pitch - AS_CHASE_EL;
  st.holdLook = true; st.holdEl = -e.pitch;
  e.on = false; st.camOverride = null;
  st.outOf = false; st.drive = true; st.everIn = true;
  _asHud(true); _aeHudRender(); _aeKick();
}
// Back in the seat from walking round it: the drive as it was.
function _asGetIn(st) {
  _aeDbg('rover', 'get in');
  if (!st || !st.outOf || !st.rover) return false;
  var was = st.camOverride === _aeHostEyeCam ? _aeHostEyeCam(st, 0) : null;   // the eye, in the ground's own metres (a world place from the last frame is off by how far the body has moved since)
  if (_aeHostEyeOn(st)) _aeHostEyeToggle(st);
  st.outOf = false; st.drive = true; st.everIn = true;
  if (was && st.phase === 'stand' && !_aeReduceMotion()) _asGroundMove(st, was);   // from the eye to the drive's camera in one eased move, not a cut
  _asHud(true); _aeHudRender(); _aeKick();
  return true;
}
// Eye level and the phone: the buttons that belong to a visit with Stand here's ground under it (almanac-standhost.js).
function _asEyeSync(st) {
  var eye = _aeById('as-eye'), mot = _aeById('as-motion'), whole = _aeById('as-whole');
  if (!eye || !mot) return;
  var can = !!(st && st.host && st.host.live && !st.drive && !st.launch), on = can && _aeHostEyeOn(st);
  if (eye.hidden === can) eye.hidden = !can;
  // One toggle between the two ways of being there: on the ground it offers the observer's view (the site's glyph), above
  // it the ground (the walker's). Without the ground, the site's button shows only to come back to the arrival view.
  eye.setAttribute('aria-pressed', 'false');
  var label = _aeT(st && st.outOf ? 'alm_drive_in' : on ? 'alm_site_whole' : 'alm_stand_eye');
  if (eye.title !== label) { eye.title = label; eye.setAttribute('aria-label', label); eye.innerHTML = st && st.outOf ? AS_DRIVE_SVG : on ? AS_WHOLE_SVG : AS_EYE_SVG; }
  // Whole site: away from the arrival view (a part tapped, the view walked) in the observer's view, ground or not ("I liked a button
  // to see the whole site at once, missing that now?"); on the ground the eye button itself is the way back.
  if (whole) { var w = !on && !!st && (!!st.tapped || !!(st.home && st.focusXY && (st.focusXY[0] !== st.home.xy[0] || st.focusXY[1] !== st.home.xy[1]))); if (whole.hidden === w) whole.hidden = !w; }   // (away from the arrival view)
  var showMot = on && typeof _aeMotionAvailable === 'function' && _aeMotionAvailable() && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  if (mot.hidden === showMot) mot.hidden = !showMot;
  mot.setAttribute('aria-pressed', st && st.eye && st.eye.motion ? 'true' : 'false');
}
// What a part is called: the visit's names are alm_site_p_<model>, a rover's body and wheel under the rover's.
function _asPartNameKey(model) { return 'alm_site_p_' + model.replace(/-(body|wheel)$/, '').replace(/-\d+$/, '').replace(/-/g, '_'); }
// Its name in the reader's language; never the key itself (a part without one is called by its visit's name).
function _asPartName(st, model) { var k = _asPartNameKey(model), n = _aeT(k); return n && n !== k ? n : (st.def && st.def.name) || st.row[0]; }
// What the visit is (its name, a link to its article where the library has one), the part tapped, and when it landed: said
// by the controls layer's info corner (almanac-earth.js _ahInfoGround), not a box of the site's own.
function _asCaption(st) {
  if (!st) return;
  var row = st.row;
  if (row[4] && !st.hit && !st.hitAsked && window.AlmanacLinks && AlmanacLinks.resolve) {
    st.hitAsked = true;
    AlmanacLinks.resolve([row[4]]).then(function (links) { if (_ae.site === st && links[row[4]]) { st.hit = links[row[4]]; _asCaption(st); } });
  }
  _asEyeSync(st);
  if (typeof _aeHudInfoPaint === 'function') _aeHudInfoPaint(true);
}
// The info corner's lines for a visit: [name, world and where, the part tapped or when it landed].
function _asInfoLines(st) {
  var def = st.def, row = st.row, tapName = st.tapped ? _aeT(st.tapped) : '';
  var at = isFinite(row[1]) ? _aeFmtLatLon({ lat: row[1], lon: row[2] }) : '';
  var when = def.ms ? _aeT(def.launch ? 'alm_site_launched' : 'alm_site_landed', { date: _aeFmtDate(def.ms) }) : '';   // (the day: the corner is a line, not a card)
  return [def.name || row[0], def.adHoc ? at : [_aeGoName(st.body), at].filter(Boolean).join(' \u00b7 '), tapName && tapName !== st.tapped ? tapName : when];   // (a drive anywhere is named for its body already: "Moon", then where)
}
// The visit's own sheet (the facts sheet, almanac-earth.js, opened from the corner's name): what is there, when it came, and where; its article, where the library has one.
function _asInfoHtml(st) {
  var def = st.def || {}, row = st.row, seen = {}, names = (def.parts || []).map(function (p) { return _asPartName(st, p.m); }).filter(function (n) { return seen[n] ? false : (seen[n] = true); });
  var at = isFinite(row[1]) ? _aeFmtLatLon({ lat: row[1], lon: row[2] }) : '', when = def.ms ? _aeT(def.launch ? 'alm_site_launched' : 'alm_site_landed', { date: _aeFmtDate(def.ms) }) : '';
  var p = function (cls, text) { return text ? '<p class="' + cls + '">' + _almEsc(text) + '</p>' : ''; };
  return '<button type="button" class="ae-card-x" id="ae-info-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
    '<div class="ae-info-grab" aria-hidden="true"></div><div class="ae-info-body"><h2 id="ae-info-title">' + _almEsc(def.name || row[0]) + '</h2>' +
    p('ae-info-now', when) + p('ae-info-blurb', names.join(' · ')) + p('ae-info-now', [_aeGoName(st.body), at].filter(Boolean).join(' · ')) +
    (st.hit ? '<p class="ae-info-read"><a href="#" data-as-read>' + _almEsc(_aeT('alm_bi_read', { body: def.name || row[0] })) + '</a></p>' : '') + '</div>';
}
// A faint dot on every part too small to see on the picture, and at the edge of the picture on every part that is off it: each is
// a place to tap for that part (the picture's own taps need the part to be seen).
function _asDots(st) {
  var hud = _aeById('as-hud');
  if (!hud || !st.placed || st.drive) return;
  var box = _aeById('as-dots');
  if (!box) {
    box = document.createElement('div'); box.id = 'as-dots'; box.className = 'as-dots';
    box.addEventListener('click', function (e) { var d = e.target.closest && e.target.closest('i'); if (d && d._part && _ae.site) { _asFocusPart(_ae.site, d._part); e.stopPropagation(); } });
    hud.insertBefore(box, hud.firstChild);
  }
  var parts = st.siteParts.map(function (sp) { return sp.body || sp; }).filter(function (p) { return p.holder.visible; });
  while (box.children.length < parts.length) box.appendChild(document.createElement('i'));
  for (var i = 0; i < box.children.length; i++) {
    var el = box.children[i], p = parts[i], sc = p && _asPartScreen(st, p), on = false;
    if (sc) {
      var inside = sc.front && sc.x > 0 && sc.x < _ae.w && sc.y > 0 && sc.y < _ae.h;
      on = inside ? sc.r * 2 < AS_DOT_PX : true;
      if (on) {
        var cx = _ae.w / 2, cy = (AS_EDGE_PX + 50 + _ae.h - AS_STRIP_H_PX - AS_EDGE_PX - 24) / 2, hx = _ae.w / 2 - AS_EDGE_PX, hy = (_ae.h - AS_STRIP_H_PX - AS_EDGE_PX - 24 - AS_EDGE_PX - 50) / 2;
        var dx = sc.x - cx, dy = sc.y - cy, t = Math.max(Math.abs(dx) / hx, Math.abs(dy) / hy);
        var px = t > 1 ? cx + dx / t : sc.x, py = t > 1 ? cy + dy / t : sc.y;   // off the picture: where the line from its middle to the part meets its edge
        el.style.transform = 'translate(' + (px - 14) + 'px,' + (py - 14) + 'px)';
      }
    }
    el._part = on ? p : null;
    el.style.display = on ? '' : 'none';
    if (on) el.title = _asPartName(st, p.model);
  }
}
// "What is here": every thing standing at the site as a small picture with its short name and how far it is, nearest first.
// A tap goes to it; the one being looked at wears an amber bar.
var AS_STRIP_MS = 200;   // how often the strip checks that its list of parts still stands
function _asStripParts(st) {
  return st.siteParts.map(function (sp) { return sp.body || sp; }).filter(function (p) { return p.holder.visible; })
    .sort(function (a, b) { return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y); });
}
function _asStripPic(model) {
  var th = _asData && _asData.thumbs, at = th ? th.models.indexOf(model) : -1;
  if (at < 0) return '';
  var rows = Math.ceil(th.models.length / th.cols), c = at % th.cols, r = Math.floor(at / th.cols);
  return 'background-image:url(' + AS_THUMBS_URL + ');background-size:' + th.cols * 100 + '% ' + rows * 100 + '%;background-position:' + (th.cols > 1 ? c / (th.cols - 1) * 100 : 0) + '% ' + (rows > 1 ? r / (rows - 1) * 100 : 0) + '%';
}
function _asStrip(st) {
  var hud = _aeById('as-hud');
  if (!hud) return;
  var show = !!(st.placed && !st.drive && !st.launch && !st.pvActive);   // (the pad's foot is its transport; its slab and tower are not things to walk to)
  hud.classList.toggle('as-has-strip', show);
  hud.classList.toggle('as-lifting', !!st.ascent);
  var box = _aeById('as-strip');
  if (!show) { if (box) box.hidden = true; return; }
  if (!box) {
    box = document.createElement('div'); box.id = 'as-strip'; box.className = 'as-strip';
    box.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.as-item');
      if (!b || !_ae.site) return;
      if (b._part) _asFocusPart(_ae.site, b._part); else if (b._feat) _asLookToward(_ae.site, b._feat.x, b._feat.y);
    });
    hud.appendChild(box);
  }
  box.hidden = false;
  var parts = _asStripParts(st), feats = _asFeatures(st), key = parts.map(function (p) { return p.model; }).concat(feats.map(function (f) { return f.n; })).join(',');
  if (box.dataset.k !== key) {
    box.dataset.k = key;
    var items = parts.map(function (p) { return { part: p, d: Math.hypot(p.x, p.y), name: _asPartName(st, p.model), pic: _asStripPic(p.model.replace(/-wheel$/, '')) }; })
      .concat(feats.map(function (f) { return { feat: f, d: Math.hypot(f.x, f.y), name: f.n.replace(/ Crater$/, ''), pic: '', crater: true }; }))
      .sort(function (a, b) { return a.d - b.d; });
    box.innerHTML = items.map(function (it) {
      var d = Math.round(it.d), far = d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d ? d + ' m' : '';
      return '<button type="button" class="as-item"><i class="as-pic' + (it.crater ? ' as-crater' : '') + '" style="' + it.pic + '"></i><b>' + _almEsc(it.name) + '</b><small>' + far + '</small></button>';
    }).join('');
    Array.prototype.forEach.call(box.children, function (el, i) { el._part = items[i].part || null; el._feat = items[i].feat || null; });
  }
  Array.prototype.forEach.call(box.children, function (el) { el.classList.toggle('as-on', el._part === st.tappedPart); });
}
function _asHudTick(st, sc) {
  _asEyeSync(st);
  if (st.drive) _asMenuSync(st);
  _asDots(st);
  _asFeatureLabels(st);
  if (!st.stripAt || performance.now() - st.stripAt > AS_STRIP_MS || !_aeById('as-strip')) { st.stripAt = performance.now(); _asStrip(st); }   // the strip's parts change a few times a visit, not a frame
  var hud = _aeById('as-hud');
  if (hud) hud.classList.toggle('as-wait', st.phase !== 'stand' || !st.placed);
}
// A tap on a part of the site: it comes to the middle of the picture and the camera to a few of its widths.
// The part under a tap that is standing now (a part before its time or after it is not there to be tapped).
// Where a place of the site is on the screen, in pixels, and whether it is in front of the camera (one behind it still has the
// direction it lies in: x and y are then far off the picture on that side); d is its distance in metres.
function _asScreenOf(st, local) {
  var pose = st.pose;
  if (!pose) return null;
  var rel = _aeSub(_asToWorld(st.fr, local), pose.pos), right = _aeNorm(_aeCross(pose.look, pose.up)), up = _aeCross(right, pose.look);
  var xc = _aeDot(rel, right), yc = _aeDot(rel, up), zc = _aeDot(rel, pose.look), f = _ae.h / 2 / _aeTanHalf(AS_FOV_DEG);
  var front = zc > 1e-12, k = front ? f / zc : 1e9 / Math.max(1e-12, Math.hypot(xc, yc));
  return { x: _ae.w / 2 + xc * k, y: _ae.h / 2 - yc * k, front: front, d: Math.hypot(rel[0], rel[1], rel[2]) / AS_MRE, f: f };
}
// A part's middle and the radius of its bounds on the screen.
function _asPartScreen(st, part) {
  var sc = _asScreenOf(st, [part.x, part.y, part.z + part.size * 0.3]);
  if (sc) sc.r = part.size * 0.5 * sc.f / Math.max(sc.d, 0.01);
  return sc;
}
// A named crater too far or too big to be a part, labelled on the picture where its rim is, when the picture has it.
var AS_FEATURE_MIN_M = 60;
function _asFeatures(st) {   // (the named craters big enough to show: worked out once for a site's relief)
  if (!st.feats || st.featFor !== st.relief) { st.featFor = st.relief; st.feats = (st.relief || []).filter(function (r) { return 2 * r.r >= AS_FEATURE_MIN_M && /Crater$/.test(r.n); }).sort(function (a, b) { return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y); }); }   // (nearest first: the nearer crater keeps its name)
  return st.feats;
}
// Look toward a place far off: the camera at the lander, low, turned that way (the horizon then holds it at its true bearing).
function _asLookToward(st, x, y) {
  var b = Math.atan2(x, y);
  st.tapped = st.tappedPart = null;
  st.camera.az = Math.PI - b; st.camera.el = AS_LOOK_EL;
  st.focusXY = [Math.sin(b) * AS_LOOK_M, Math.cos(b) * AS_LOOK_M]; st.focusZ = _asGroundAt(st, st.focusXY[0], st.focusXY[1], false) + AS_ORBIT_FOCUS_Z_M;
  st.distTo = AS_LOOK_M * 1.2;
  _asCaption(st);
  _aeKick();
}
function _asFeatureLabels(st) {
  var hud = _aeById('as-hud'), rows = _asFeatures(st), box = _aeById('as-feats');
  if (!hud || !rows.length || st.drive) { if (box) box.hidden = true; return; }   // none to name here (or a drive): the last visit's labels go
  if (box) box.hidden = false;
  if (!box) { box = document.createElement('div'); box.id = 'as-feats'; box.className = 'as-feats'; hud.insertBefore(box, hud.firstChild); }
  while (box.children.length < rows.length) box.appendChild(document.createElement('b'));
  for (var k = rows.length; k < box.children.length; k++) box.children[k].style.display = 'none';   // a smaller site than the last: its surplus labels
  var placed = [];   // the boxes of the names standing so far: a name never lies across another (the nearer crater keeps its name)
  rows.forEach(function (r, i) {
    var el = box.children[i], sc = _asScreenOf(st, [r.x, r.y, _asGroundAt(st, r.x, r.y, true) + r.w]), on = !!sc && sc.front && sc.x > 30 && sc.x < _ae.w - 30 && sc.y > 70 && sc.y < _ae.h - AS_STRIP_H_PX - 30;
    if (on) {
      if (el.textContent !== r.n || !el._w) {   // (measured when its words change, not every frame)
        el.textContent = r.n; el.style.display = '';   // (a name laid out has a width to measure)
        el._w = el.offsetWidth || r.n.length * AS_NAME_PX * 0.6;
      }
      var w = el._w, h = AS_NAME_PX * 1.6, box2 = [sc.x - w / 2, sc.y - h * 1.3, sc.x + w / 2, sc.y - h * 0.3];
      on = !placed.some(function (q) { return box2[0] < q[2] && box2[2] > q[0] && box2[1] < q[3] && box2[3] > q[1]; });
      if (on) { placed.push(box2); el.style.transform = 'translate(' + sc.x + 'px,' + sc.y + 'px) translate(-50%,-130%)'; }
    }
    el.style.display = on ? '' : 'none';
  });
}
// The part a tap is for: the one standing now whose bounds the tap is within AS_TAP_AREA_PX of; the nearest wins.
function _asPartAt(st, x, y) {
  var best = null, bd = AS_TAP_AREA_PX, bc = 1e9;
  st.siteParts.forEach(function (sp) {
    var part = sp.body || sp;
    if (!part.holder.visible) return;
    var sc = _asPartScreen(st, part);
    if (!sc || !sc.front) return;
    var mid = Math.hypot(sc.x - x, sc.y - y), d = Math.max(0, mid - sc.r);
    if (d < bd || (d === bd && mid < bc)) { bd = d; bc = mid; best = part; }   // the nearest bounds; of parts the tap is inside, the one whose middle is nearest
  });
  return best;
}
// Where the ground is under a point of the picture, as a place of the site (x east, y north), or null (the sky).
function _asGroundPick(st, px, py) {
  var pose = st.pose, fr = st.fr;
  if (!pose || !fr) return null;
  var tanV = _aeTanHalf(AS_FOV_DEG), tanH = tanV * _ae.w / _ae.h, look = pose.look;
  var right = _aeNorm(_aeCross(look, pose.up)), up = _aeCross(right, look);
  var nx = (px / _ae.w * 2 - 1) * tanH, ny = (1 - py / _ae.h * 2) * tanV;
  var dir = _aeNorm(_aeAdd(look, _aeAdd(_aeScale(right, nx), _aeScale(up, ny))));
  var o = _asWorldToLocal(fr, pose.pos), q = _asWorldToLocal(fr, _aeAdd(pose.pos, _aeScale(dir, AS_MRE))), dl = _aeNorm([q[0] - o[0], q[1] - o[1], q[2] - o[2]]);
  if (dl[2] >= -1e-4) return null;
  var t = 0, prev = 0;
  for (var i = 0; i < 400; i++) {
    t += Math.max(0.4, t * 0.03);
    var x = o[0] + dl[0] * t, y = o[1] + dl[1] * t, z = o[2] + dl[2] * t;
    if (z < _asGroundAt(st, x, y, true)) {
      var lo = prev, hi = t;
      for (var k = 0; k < 14; k++) { var mid = (lo + hi) / 2; if (o[2] + dl[2] * mid < _asGroundAt(st, o[0] + dl[0] * mid, o[1] + dl[1] * mid, true)) hi = mid; else lo = mid; }
      return [o[0] + dl[0] * hi, o[1] + dl[1] * hi];
    }
    prev = t;
    if (t > AE_HOST_WALK_MAX_M) return null;
  }
  return null;
}
// The view's centre goes to a place of the ground (eased by the camera's own follow), at most AS_WALK_MAX_M from the lander.
function _asWalkTo(st, x, y) {
  var r = Math.hypot(x, y);
  if (r > AS_WALK_MAX_M) { x *= AS_WALK_MAX_M / r; y *= AS_WALK_MAX_M / r; }
  st.tapped = st.tappedPart = null;
  st.focusXY = [x, y];
  st.focusZ = _asGroundAt(st, x, y, false) + AS_ORBIT_FOCUS_Z_M;
  _asCaption(st);
  _aeKick();
}
// Two fingers drag the ground: the centre moves the other way across the ground, in the camera's own right and ahead.
function _asPan(st, dx, dy) {
  // The camera looks along (sin az, -cos az) over the ground (the az of the orbit: from north through west), its right is (-cos az, -sin az).
  var scale = 2 * st.camera.dist * _aeTanHalf(AS_FOV_DEG) / _ae.h, az = st.camera.az;
  var x = st.focusXY[0] + Math.cos(az) * dx * scale + Math.sin(az) * dy * scale, y = st.focusXY[1] + Math.sin(az) * dx * scale - Math.cos(az) * dy * scale;
  _asWalkTo(st, x, y);
  st.fcur = [st.focusXY[0], st.focusXY[1], st.focusZ];   // a drag is followed at once, not eased
}
// The whole site again: the arrival view.
function _asWholeSite(st) {
  st.tapped = st.tappedPart = null;
  st.focusXY = st.home.xy.slice(); st.focusZ = st.home.z; st.distTo = st.home.dist;
  st.camera.el = AS_ARRIVAL_EL;
  _asCaption(st);
  _aeKick();
}
// A tap on the ground, anywhere in sight: the person walks there (almanac-standhost.js _aeHostWalkTo) where the visit stands on a ground of Stand here's; else the view's centre goes there.
function _asTapGround(st, x, y, thing) {
  var at = thing ? [thing.x, thing.y] : _asGroundPick(st, x, y);
  if (!at) return;
  if (typeof _aeHostWalkTo === 'function' && _aeHostWalkTo(st, at[0], at[1], thing ? thing.size * 0.5 + AE_TAPWALK_STANDOFF_M : 0)) { _asEyeSync(st); return; }
  _asWalkTo(st, at[0], at[1]);
}
// A tap on a part brings it to the middle, named; a second tap on it goes back to the whole site; a tap on the ground walks the
// view there.
function _asTapPart(st, x, y) {
  if (typeof _aeHostEyeOn === 'function' && _aeHostEyeOn(st)) { _asTapGround(st, x, y, _asPartAt(st, x, y)); return; }   // on foot a tap is a place to walk to: up to a thing it hit (not past it), else the ground under it
  var best = _asPartAt(st, x, y);
  if (best === st.tappedPart && best) { _asWholeSite(st); return; }
  if (!best) { _asTapGround(st, x, y); return; }
  _asFocusPart(st, best);
}
// A part to the middle, named, the camera a few of its widths off.
function _asFocusPart(st, best) {
  st.tappedPart = best;
  st.tapped = _asPartNameKey(best.model);
  _asCaption(st);
  st.focusXY = [best.x, best.y];
  st.focusZ = best.z + best.size * 0.3;
  st.distTo = _aeClamp(best.size * 2.6, AS_ORBIT_DIST_M[0], AS_ORBIT_DIST_M[1]);
  _aeKick();
}
function _asBindHud(hud) {
  _aeById('as-liftoff').onclick = function () { if (_ae.site) _asAscentStart(_ae.site); };
  _aeById('as-follow').onclick = function () { _aeSiteFollowMission(_ae.site); };
  _aeById('as-whole').onclick = function () { if (_ae.site) { _asWholeSite(_ae.site); _aeShowHint(_aeT('alm_site_whole_said')); } };   // each says what it did: an eased camera move alone read as "nothing happened"
  _aeById('as-eye').onclick = function () {
    var st = _ae.site;
    if (!st || _asGetIn(st)) return;
    var was = _aeHostEyeOn(st);
    _aeHostEyeToggle(st);
    if (was) _asWholeSite(st);
    _asEyeSync(st);
    _aeShowHint(_aeT(was ? 'alm_site_eye_off_said' : 'alm_site_eye_on_said'));
  };
  _aeById('as-motion').onclick = function () { _aeHostMotionToggle(_ae.site).then(function () { _asEyeSync(_ae.site); }); };
  _aeById('as-trailbtn').onclick = function () {
    var st = _ae.site;
    if (!st || !st.def.trail) return;
    if (st.trail) { _asTrailStop(st); return; }
    var go = function () { _asTraversesLoad(function () { _asTrailStart(st); }); };
    if (typeof _asTrailStart !== 'function') _aeLoadJsOnce(AS_TRAIL_JS, go); else go();
  };
  _aeById('as-launch').onclick = function () {
    var st = _ae.site;
    if (!st || !st.def.launch) return;
    if (typeof _asLaunchStart !== 'function') { _aeLoadJsOnce(AS_LAUNCH_JS, function () { _asLaunchStart(st); }); return; }
    _asLaunchStart(st);
  };
  var layer = _aeById('as-layer'), ptrs = {}, pinch = null;
  var stickEl = _aeById('as-stick');
  layer.addEventListener('pointerdown', function (e) {
    var st = _ae.site;
    if (!st) return;
    layer.setPointerCapture(e.pointerId);
    var r = layer.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    ptrs[e.pointerId] = { x: x, y: y, x0: x, y0: y, cx: e.clientX, cy: e.clientY, role: 'look', t0: e.timeStamp, solo: Object.keys(ptrs).length === 0 };   // solo: the only finger down (a tap is a place only then)
    var onFoot = !st.drive && typeof _aeHostEyeOn === 'function' && _aeHostEyeOn(st) && x < r.width * 0.5;   // eye level: the lower-left is the walking stick
    if ((st.drive || onFoot) && y > r.height * AS_STICK_ZONE && !Object.keys(ptrs).some(function (k) { return ptrs[k].role === 'stick'; })) {
      ptrs[e.pointerId].role = 'stick';
      stickEl.hidden = false;
      _aeById('as-hud').classList.add('as-holding');
      stickEl.style.left = x + 'px'; stickEl.style.top = y + 'px';
      stickEl.firstElementChild.style.transform = '';
    } else if (Object.keys(ptrs).length === 2 && !st.drive) {
      var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]];
      pinch = { span: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
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
      var ox = x - p.x0, oy = y - p.y0, len = Math.hypot(ox, oy), k = len > AS_STICK_R_PX ? AS_STICK_R_PX / len : 1, kk = len > AS_STICK_R_PX * AS_STICK_OUTER ? AS_STICK_R_PX * AS_STICK_OUTER / len : 1;
      st.input.sx = ox * k / AS_STICK_R_PX; st.input.sy = -oy * k / AS_STICK_R_PX;
      st.input.fast = len > AS_STICK_R_PX * AS_STICK_FAST_AT;   // past the solid ring: time runs faster, the knob is amber
      stickEl.classList.toggle('as-fast', st.input.fast);
      stickEl.firstElementChild.style.transform = 'translate(' + (ox * kk) + 'px,' + (oy * kk) + 'px)';
    } else if (pinch && Object.keys(ptrs).length >= 2) {
      var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]], span = Math.hypot(a.x - b.x, a.y - b.y);
      if (span > 0 && pinch.span > 0) st.camera.dist = _aeClamp(st.camera.dist * pinch.span / span, AS_ORBIT_DIST_M[0], st.distMax || AS_ORBIT_DIST_M[1]);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (!st.drive) _asPan(st, mx - pinch.mx, my - pinch.my);   // two fingers also drag the ground
      pinch.span = span; pinch.mx = mx; pinch.my = my;
    } else if (st.drive && st.rover && (Math.abs(st.rover.v) > AS_STEER_DRAG_V || Object.keys(ptrs).some(function (k) { return ptrs[k].role === 'stick'; }))) {
      st.rover.hdg += dx * AS_STEER_DRAG;   // driving (a thumb on the stick, or rolling): the other thumb steers by dragging the scene round, the heading following it (the camera follows the heading)
    } else if (st.drive) {
      st.look.yaw -= dx * 0.006; st.look.pitch = _aeClamp(st.look.pitch + dy * 0.004, -0.25, 1.0); st.look.touched = performance.now();
    } else if (typeof _aeHostEyeOn === 'function' && _aeHostEyeOn(st)) {
      _aeHostEyeLook(st, dx, dy);   // at eye level a drag turns the head
    } else {
      st.camera.az -= dx * 0.006; st.camera.el = _aeClamp(st.camera.el + dy * 0.005, AS_ORBIT_EL[0], AS_ORBIT_EL[1]);
    }
    _aeKick();
  });
  var end = function (e) {
    var st = _ae.site, p = ptrs[e.pointerId];
    if (!p) return;
    delete ptrs[e.pointerId];
    var tap = e.type === 'pointerup' && p.solo && Math.hypot(p.x - p.x0, p.y - p.y0) < AS_TAP_SLOP_PX && e.timeStamp - p.t0 < AS_TAP_MS;   // a press that did not move (the events' own times: a slow frame between them is not the finger's)
    if (p.role === 'stick' && st) { st.input.sx = st.input.sy = 0; st.input.fast = false; stickEl.classList.remove('as-fast'); stickEl.hidden = true; _aeById('as-hud').classList.remove('as-holding'); }
    var tag = p.role !== 'stick' && st && e.type === 'pointerup' && p.solo && Math.hypot(p.x - p.x0, p.y - p.y0) < AS_TAP_SLOP_PX ? _aeSceneTapAt(p.cx, p.cy) : null;   // a part's dot or the Earth chip under a still press is its (they take no pointer, so a drag from one looks)
    if (tag) tag.click();
    else if (st && st.drive) { if (tap && typeof _asAutoTap === 'function') _asAutoTap(st, p.x, p.y, layer.clientWidth, layer.clientHeight); }   // a tap anywhere is a place to drive to; a press that moves is the stick
    else if (p.role !== 'stick' && st && !st.drive && e.type === 'pointerup' && Math.hypot(p.x - p.x0, p.y - p.y0) < AS_TAP_SLOP_PX) _asTapPart(st, p.x, p.y);
    if (Object.keys(ptrs).length < 2) pinch = null;
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  layer.addEventListener('lostpointercapture', end);   // a capture lost without a pointerup is a finger up
  layer.addEventListener('wheel', function (e) {
    var st = _ae.site;
    if (!st) return;
    e.preventDefault();
    st.camera.dist = _aeClamp(st.camera.dist * Math.exp(e.deltaY * 0.0012), AS_ORBIT_DIST_M[0], st.distMax || AS_ORBIT_DIST_M[1]);
    _aeKick();
  }, { passive: false });
}
var _asKeyDown = null, _asKeyUp = null, _asFocusOff = null;
function _asKeys(on) {
  if (on && !_asKeyDown) {
    _asKeyDown = function (e) {
      var st = _ae && _ae.site, k = AS_KEYS[e.key], used = true;
      if (!st || _aeTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;   // a text field keeps its keys, and a shortcut its own
      if (e.key === 'Escape') _aeBack();
      else if (st.calledUp && !st.atEye && k) st.input.keys[k] = true;   // the rover called up is still coming down: a driving key is kept for the moment it is down (it was walked with, or dropped)
      else if (!st.drive) {   // on foot at a site (eye level): the walking keys; a key to walk with puts the eye on the ground first
        var wk = AE_WALK_KEYS[e.key];
        if (e.key === 'Shift') { if (st.eye) st.eye.run = true; used = false; }
        else if ((wk || e.key === ' ') && st.host && st.host.live && typeof _aeHostEyeToggle === 'function') {
          if (!_aeHostEyeOn(st)) _aeHostEyeToggle(st);
          if (e.key === ' ') st.eye.hop = true; else (st.eye.keys || (st.eye.keys = {}))[wk] = true;
        } else used = false;
      }
      else if (e.key === 'Shift') { st.input.fast = true; used = false; }
      else if (e.key === 'v' || e.key === 'V') { if (!e.repeat) _asSeatToggle(st); }
      else if (e.key === ' ') { if (!e.repeat) st.input.wheelie = true; }
      else if (k) st.input.keys[k] = true;
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); }
      _aeKick();
    };
    _asKeyUp = function (e) { var st = _ae && _ae.site, k = AS_KEYS[e.key]; if (st && e.key === 'Shift') st.input.fast = false; if (st && k) st.input.keys[k] = false; if (st && st.eye) { var wn = AE_WALK_KEYS[e.key]; if (wn && st.eye.keys) st.eye.keys[wn] = false; if (e.key === 'Shift') st.eye.run = false; } };
    document.addEventListener('keydown', _asKeyDown, true);
    document.addEventListener('keyup', _asKeyUp, true);
    _asFocusOff = _aeOnFocusLost(function () { var st = _ae && _ae.site; if (st) { st.input.keys = {}; st.input.fast = false; if (st.eye) { st.eye.keys = {}; st.eye.run = false; } } });
  } else if (!on && _asKeyDown) {
    document.removeEventListener('keydown', _asKeyDown, true);
    document.removeEventListener('keyup', _asKeyUp, true);
    _asKeyDown = _asKeyUp = null;
    if (_asFocusOff) { _asFocusOff(); _asFocusOff = null; }
  }
}

// ── The landmark card's way in: two icon buttons under a landing's line ──
// Whether a landmark's row is a site that can be visited (the rim's way down there is the visit's own: the way out of it, backwards).
function _aeSiteCan(body, row) { return !!(_asData && row && (row[3] === 'landing' || row[3] === 'launch') && _asDefFor(body, row)); }
function _aeSiteCardHtml(lm) {
  if (!_asData || typeof _asGroupBuild !== 'function' || (lm.row[3] !== 'landing' && lm.row[3] !== 'launch')) return '';
  var def = _asDefFor(lm.body, lm.row), drive = _asCanDrive(lm.body, lm.row) && (!def || _asHadRover(def));
  if (!def && !drive) return '';
  var dr = _almEsc(_aeT('alm_site_drive'));
  _asStyle();
  // One word, the primary (of a lander glyph and a rover glyph: "that horrible cone thing and rover icon"): See it takes the
  // view down to the site in one tap. A site whose mission had a rover (Apollo 15 to 17, Lunokhod, the Mars rovers) has its rover beside it, quiet.
  return (def ? '<button type="button" class="ae-btn as-visit-main" id="as-visit">' + _almEsc(_aeT('alm_site_visit')) + '</button>' : '') +
    (drive ? '<button type="button" class="ae-btn ae-round" id="as-drive" aria-label="' + dr + '" title="' + dr + '">' + AS_DRIVE_SVG + '</button>' : '');
}
// The year the site was landed on or launched from, for the card's one muted line.
function _aeSiteYear(lm) {
  var def = _asDefFor(lm.body, lm.row);
  return def && def.ms ? String(new Date(def.ms).getUTCFullYear()) : '';
}
function _aeSiteCardBind(card, lm) {
  var v = card.querySelector('#as-visit'), d = card.querySelector('#as-drive');
  if (v) v.onclick = function () { _aeSiteVisit(lm.body, lm.row, false); };
  if (d) d.onclick = function () { _aeSiteVisit(lm.body, lm.row, true); };
}

// Out of a visit to the 3D view at its body: the button, Escape and the phone's back all end here.
// The way out by hand (the exit button, Esc, the rim, the menu): one move straight up, out to the whole body with the spot the visit was at in the middle
// of the picture: the body's own view, on the same clock (the visit's day, when it moved to it: the site stays lit and nothing jumps on the way). Nothing
// follows it (it used to rise to where the way down began, then fly again to the zoom the view had before). No path to rise on (reduced motion, nothing
// built yet): there at once.
function _aeSiteRise() {
  var st = _ae && _ae.site;
  if (!st || st.phase === 'rise') return;
  var whole = st.fr ? _asWholeView(st) : null;
  if (!whole || st.phase !== 'stand' || _aeReduceMotion() || !st.group) { _asWholeEnd(st, whole); return; }
  st.from = st.from0 = whole; st.phase = 'rise'; st.t0 = performance.now(); st.dropMs = AE_MOVE_MS;
  if (st.eye && st.eye.on) { st.eye.on = false; st.camOverride = null; }
  _aeKick();
}
// The body's own view over the site: the whole of it, its middle straight under the spot, its own way up. As a pose the visit's move can end on (`look` a point).
function _asWholeView(st) {
  var fr = st.fr, azel = _aeAzElOf(fr.u), dist = _aeClampDist(_aeBodyFitDist(st.body)), roll = _ae.scene ? _aeRollDeg(st.body, _ae.scene.ms) : 0;
  var p = _aePoseOf({ tp: fr.center, az: azel.az, el: azel.el, dist: dist, roll: roll });
  return { pos: p.pos, look: fr.center, up: p.up, az: azel.az, el: azel.el, dist: dist };
}
// Out of the visit onto the body's own view (`whole`, else the body's chip): the orbit view takes the picture where the move left it.
function _asWholeEnd(st, whole) {
  var body = st.body;
  _aeSiteLeave(false, false, true);
  if (!whole) { _aePreset(body); return; }
  _ae.target = body; _ae.pan = null; _ae.fly = null; _ae.twist = 0;
  _ae.dist = whole.dist; _ae.az = whole.az; _ae.el_ = whole.el;
  _ae.preset = body;
  _aeMarkViews();
  _aeRedraw();
}
// How far down a visit is, for the rim's dot: the flight to the body and the wait are the first share, the drop the rest; the way out runs it backwards.
function _aeSiteProgress() {
  var st = _ae.site;
  if (!st) return null;
  var w1 = AE_MOVE_MS / (AE_MOVE_MS + (st.dropMs || AS_DROP_MS)), d = st.dropMs || AS_DROP_MS, u = _smoothstep(0, 1, (performance.now() - st.t0) / d);
  if (st.phase === 'fly') return st.eye0 ? 0 : w1 * (_ae.fly ? _aeClamp((performance.now() - _ae.fly.start) / Math.max(_ae.fly.ms, 1), 0, 1) : 1);
  if (st.phase === 'drop' && st.getIn) return 1;   // (a move over the ground: on the ground all the while)
  if (st.phase === 'drop') return w1 + (1 - w1) * u;
  if (st.phase === 'rise') return 1 - (1 - w1) * u;
  return 1;
}
function _aeSiteExit() {
  var st = _ae && _ae.site;
  if (!st) return;
  var body = st.body;
  _aeSiteLeave();
  _aePreset(body);
}
// What the ship code and the Go sheet call (the entry and the way out of a visit, and a destination for the vehicle): enter the
// drive on a body's landing row (or any [name, lat, lon, 'landing'] row), leave it, and drive to a place. goTo answers { ok, distM, seconds } or { ok: false, reason }.
function _aeDriveGoTo(target) { return _ae && _ae.site && typeof _asGoTo === 'function' ? _asGoTo(_ae.site, target) : { ok: false, reason: 'not driving' }; }
function _aeSiteState() {
  var st = _ae && _ae.site;
  if (!st) return null;
  var b = _asBody(st.body), out = { body: st.body, name: st.def.name, phase: st.phase, drive: st.drive, seat: !!st.seat, view: st.view || 0, auto: st.auto ? { x: st.auto.x, y: st.auto.y, go: st.auto.go, name: st.auto.name, trip: st.auto.trip ? { left: st.auto.trip.left } : null } : null, fast: !!(st.input && st.input.fast), lat: st.lat, lon: st.lon, parts: [], sunZ: st.fr ? st.fr.sunLocal[2] : null,
    altM: st.pose ? st.pose.altRe / AS_MRE : null, ready: !!st.group && st.placed, visible: !!(st.group && st.group.visible) };
  if (b && st.fr) {
    (st.parts || []).forEach(function (p) {
      var ll = _asLatLon(st, b, _aeXyz(p));
      out.parts.push({ model: p.model, x: p.x, y: p.y, z: p.z, lat: ll.lat, lon: ll.lon, ground: _asGroundAt(st, p.x, p.y, false) });
    });
    if (st.rover) {
      var r = st.rover, ll2 = _asLatLon(st, b, _aeXyz(r));
      out.rover = { x: r.x, y: r.y, z: r.z, hdg: r.hdg, v: r.v, pitch: r.pitch, roll: r.roll, airborne: r.airborne, mean: r.mean, lat: ll2.lat, lon: ll2.lon,
        wheels: r.wheels.map(function (w) { return { x: w.x, y: w.y, z: w.z, ground: _asGroundAt(st, w.x, w.y, false) }; }) };
    }
  }
  return out;
}

// The rover's seat is the view's camera button (almanac-earth.js _aeCamRegister), above the rim button, while a rover is driven.
if (typeof _aeCamRegister === 'function') {
  _aeCamRegister({
    active: function () { return !!(_ae.site && _ae.site.drive && _ae.site.info.rover); },
    get label() { return _aeT(AS_VIEW_KEYS[(_ae.site && _ae.site.view) || 0]); },
    get svg() { return AS_VIEW_SVGS[(_ae.site && _ae.site.view) || 0]; },
    run: function () { _asSeatToggle(_ae.site); }
  });
}

// (The rim button no longer doubles as Drive at a landing: the card's own Drive button is the one way, and the rim keeps its surface/space meaning.)

// ── The address (almanac-earth.js, "The address"): site and drive modes ──
// A link opens the visit where it was written: the landing's row when one stands at that latitude and longitude, else the spot as a
// drive-anywhere row; the orbit camera, or the rover's place and heading and the seat. The clock is the link's t (the landing day's
// jump is not made). Written while a visit is open; a rover not yet built still says what the link asked of it.
var AS_LINK_ROW_TOL = 1e-5;   // degrees: a link's spot is a landmark's own row within this (about a metre)
var AS_LINK_KINDS = ['landing', 'launch'];
var _aeSiteLinkWant = null;   // { drive, cam: {az, el, dist}, rover: {x, y, hdg, seat, dist} } for the visit that is about to be made
function _asLinkNum(x, digits) { return Number(x.toFixed(digits)); }
function _asLinkWrite() {
  var st = _ae && _ae.site;
  if (!st || !st.row) return null;
  var head = [_asLinkNum(st.row[1], 6), _asLinkNum(st.row[2], 6)];
  if (st.drive) {
    var r = st.rover ? { x: st.rover.x, y: st.rover.y, hdg: st.rover.hdg, seat: !!st.seat, dist: st.camera.dist } : st.linked && st.linked.rover;
    if (!r) return null;
    return head.concat([_asLinkNum(r.x, 2), _asLinkNum(r.y, 2), _asLinkNum(((_aeDeg(r.hdg) + 540) % 360) - 180, 1), r.seat ? 1 : 0, _asLinkNum(r.dist, 2)]).join(',');
  }
  var c = st.camera;
  return head.concat([_asLinkNum(((_aeDeg(c.az) + 540) % 360) - 180, 1), _asLinkNum(_aeDeg(c.el), 1), _asLinkNum(c.dist, 2)]).join(',');
}
// The landmark row at a latitude and longitude on a body (a landing or a launch), else a drive-anywhere row.
function _asLinkRow(body, lat, lon) {
  var rows = (_aeLm && _aeLm[body]) || [];
  for (var i = 0; i < rows.length; i++) {
    if (AS_LINK_KINDS.indexOf(rows[i][3]) >= 0 && Math.abs(rows[i][1] - lat) < AS_LINK_ROW_TOL && Math.abs(rows[i][2] - lon) < AS_LINK_ROW_TOL) return rows[i];
  }
  return [_aeInfoName(body), lat, lon, 'landing'];
}
function _aeSiteLinkOpen(body, v, drive) {
  if (!_asBodyInfo(body) || !_asValidSpot(v[0], v[1])) return;
  var row = _asLinkRow(body, v[0], v[1]);
  if (drive && !_asCanDrive(body, row)) drive = false;
  _aeSiteLinkWant = drive ? { rover: { x: v[2], y: v[3], hdg: _aeRad(v[4]), seat: v[5] === 1, dist: v[6] } }
    : { cam: { az: _aeRad(v[2]), el: _aeRad(v[3]), dist: v[4] } };
  if (_ae.stand || _ae.standPending) _aeStandDrop(true);
  _aeSiteVisit(body, row, drive);
  _ae.fly = null;
}
function _asValidSpot(lat, lon) { return Math.abs(lat) <= 90 && Math.abs(lon) <= 360; }
function _aeSiteLinkTake(st) {
  var w = _aeSiteLinkWant;
  _aeSiteLinkWant = null;
  if (!w) return;
  st.linked = w;
  if (w.cam) {
    st.camera.az = w.cam.az;
    st.camera.el = _aeClamp(w.cam.el, AS_ORBIT_EL[0], AS_ORBIT_EL[1]);
    if (w.cam.dist > 0) st.camera.dist = Math.min(w.cam.dist, st.distMax || w.cam.dist);
    st.fcur = null;
  }
}
// Called as the rover stands on the ground: where the link put it.
function _asLinkRoverPlace(st, R) {
  var w = st.linked && st.linked.rover;
  if (!w) return;
  R.x = w.x; R.y = w.y; R.hdg = w.hdg;
  R.z = R.mean = _asGroundAt(st, R.x, R.y, false);
  R.lastTrack = [R.x, R.y];
  st.camera.az = R.hdg + Math.PI;
  if (w.dist > 0) st.camera.dist = w.dist;
  st.focus = [R.x, R.y, R.z + 1];
  _asViewSet(st, w.seat && st.info.rover.seat ? 2 : 0);
}
if (typeof _aeLinkModes !== 'undefined') {
  _aeLinkModes.drive = function () { var st = _ae && _ae.site; return st && st.drive ? _asLinkWrite() : null; };
  _aeLinkModes.site = function () { var st = _ae && _ae.site; return st && !st.drive ? _asLinkWrite() : null; };
}
