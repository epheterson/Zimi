// Driving a rover on a landing site (almanac-sites.js): the Lunar Roving Vehicle on the Moon, a Curiosity-class rover on
// Mars. Loaded the first time Drive is pressed. The stick and the jump button are the site's own (almanac-sites.js
// _asBindHud); here are what they move: the rover, the ground under its wheels, the tracks it leaves and the dust it
// throws, all in the site's frame (x east, y north, z up, metres).

// ── Constants ──
var AS_ROVER_START = { x: 12, y: -11, hdg: 0 };            // beside the lander, the open ground ahead
var AS_DRIVE_DEAD = 0.08;
var AS_TURN_RATE = 1.5;                                    // rad/s at the stick's end
var AS_ACCEL = 5;                                          // m/s^2: full speed in under a second, so a touch is answered at once
var AS_BOUNCE_MIN_MS = 1.2, AS_BOUNCE_KEEP = 0.3;          // a landing harder than this (m/s) rebounds with this share of its speed
var AS_DROP_IN_CLEAR_M = 3;                                // a rover called up from Stand here falls in from above the top of the picture, by this much more
var AS_SPEED_SHOW_MS = 120;                                // the speed readout's refresh
var AS_LAMP_LEN_M = 24, AS_LAMP_WIDE_M = 14, AS_LAMP_AHEAD_M = 0, AS_LAMP_LIFT_M = 0.06;   // the headlights' pool of light on the ground: its length, its far width, where it starts (at the lamp), over the ground
var AS_LAMP_COLS = 8, AS_LAMP_ROWS = 24, AS_LAMP_MOVE_M = 0.05;   // the pool is a sheet laid over the ground's own bumps, this many cells; it is laid again when the lamp moves this far
var AS_KMH_PER_MS = 3.6, AS_MPH_PER_MS = 2.23694;
var AS_WHEELIE_MS = 900, AS_WHEELIE_PITCH = 0.42, AS_WHEELIE_LURCH = 0.6, AS_WHEELIE_LIFT_M = 0.2;   // a wheelie: its length, how far the nose comes up (rad), the lurch forward (a share of the top speed at the peak), the body's lift
var AS_WHEEL_TAP_Z_M = 0.8, AS_WHEEL_TAP_PX = 64;           // a tap this near the vehicle's middle (above the ground, on screen) is a wheelie
var AS_DRIVE_FAST_RATE = AE_SITE_FACTS.driveFastRate, AS_HELD_RATE_CAP = AE_SITE_FACTS.driveHeldRateCap, AS_BOOST_AFTER_S = AE_SITE_FACTS.driveBoostAfterS, AS_BOOST_RAMP_S = AE_SITE_FACTS.driveBoostRampS, AS_BOOST_MAX = AE_SITE_FACTS.driveBoostMax, AS_BOOST_STICK = 0.95;              // the rate the clock holds at while the stick is pushed further; the most a rate may be while a thumb steers
var AS_TILT_MAX = 0.5;                                     // rad: the body follows the slope this far and no further, so it never turns over and is always upright again
var AS_BUMP_FOOT = 0.4, AS_BUMP_MIN_SIZE_M = 1, AS_BUMP_SLOW = 1.5, AS_BUMP_TURN = 2;   // a part's footprint is this share of its span (parts under this size are not in the way); how fast a head-on press loses speed (1/s), and how hard it turns round it (times the part's own curve)
var AS_LOOK_KEY_RATE = 1.6;                                // rad/s a held arrow turns the view
var AS_TREAD_RING = 900, AS_TREAD_STEP_M = 0.4, AS_TREAD_HALF_M = 0.1;   // tread marks: points kept a side, one every this far, the width of a tyre's mark
var AS_TREAD_ALPHA = 0.3, AS_TREAD_PITCH_M = 0.06, AS_TREAD_AGE_S = [90, 300], AS_TREAD_FAR_M = [60, 400], AS_TREAD_SHARP_M = [6, 30];   // how dark, the lugs' spacing along the mark, when it fades with age (s) and with distance (m), when the lugs blur to their mean
var AS_DUST_MAX = 160;

// Dust kicked up by the wheels: soft round points, lit like the ground, falling under the body's own gravity.
var AS_DUST_VERT = _asPointVert(0.3, 90);
var AS_DUST_FRAG = [
  'uniform vec3 albedo; uniform float lit; uniform float ambient; uniform float fade;',
  'varying float vLife;',
  'void main() {',
  AS_GLSL_ROUND_POINT,
  '  vec3 col = albedo * (lit + ambient);',
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade * vLife * (1.0 - r) * 0.6);',
  '}'
].join('\n');

// Headlights: a cone of warm light from each lamp, as it falls on the ground ahead: a point at the lamp, opening forward, every edge soft, the
// sheet laid over the ground's bumps (a flat quad cut through them in straight lines: blocks). In vacuum there is no beam in the air,
// only the light where it lands. On when the Sun is low or down (added to what is there).
var AS_LAMP_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
var AS_LAMP_FRAG = [
  'uniform float k; varying vec2 vUv;',
  'void main() {',
  '  float d = vUv.y, w = abs(vUv.x - 0.5) * 2.0;',
  '  float cone = 1.0 - smoothstep(0.55, 1.0, w / max(d, 0.001));',   // the beam's half-angle: the sheet's width at its far end, from a point at the lamp
  '  float a = cone * smoothstep(0.0, 0.12, d) * pow(1.0 - d, 1.6) * k;',   // brightest a little ahead of the lamp, gone at the sheet's far edge
  '  if (a < 0.002) discard;',
  '  gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * a * 0.9, 1.0);',   // added to the ground: the colour alone carries the light
  '}'
].join('\n');
function _asLampBuild(st) {
  var THREE = _ae.gl.THREE, hw = AS_LAMP_WIDE_M / 2;
  // One pool of light for each of the vehicle's lamps (its table row says where they are), starting at the lamp and opening forward.
  st.lamps = (st.info.rover.lamps || [[0, 1.5, 1]]).map(function (at) {
    var geo = new THREE.BufferGeometry(), C = AS_LAMP_COLS, R = AS_LAMP_ROWS, n = (C + 1) * (R + 1), uv = new Float32Array(n * 2), idx = [];   // a grid (the build has no PlaneGeometry), laid on the ground by _asLampStep
    for (var j = 0; j <= R; j++) for (var i = 0; i <= C; i++) { var o = j * (C + 1) + i; uv[2 * o] = i / C; uv[2 * o + 1] = j / R; }
    for (j = 0; j < R; j++) for (i = 0; i < C; i++) { var a = j * (C + 1) + i, b = a + 1, c = a + C + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    var mat = new THREE.ShaderMaterial({ uniforms: { k: { value: 0 } }, vertexShader: AS_LAMP_VERT, fragmentShader: AS_LAMP_FRAG, transparent: true, depthWrite: false, blending: AE_THREE_ADDITIVE_BLENDING });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.visible = false;
    st.group.add(mesh);
    return { mesh: mesh, at: at };
  });
}
function _asLampStep(st) {
  var r = st.rover;
  if (!st.lamps) _asLampBuild(st);
  var k = 1 - _smoothstep(AE_SITE_LAMP_SUN[0], AE_SITE_LAMP_SUN[1], st.fr.sunLocal[2]), c = Math.cos(r.hdg), s = Math.sin(r.hdg);
  st.lamps.forEach(function (lamp) {
    var m = lamp.mesh;
    m.visible = k > 0.01 && !r.airborne;   // the lamps are the rover's: no pool on the ground while it is still falling in or bouncing
    if (!m.visible) { lamp.laid = null; return; }
    m.material.uniforms.k.value = k;
    var x = r.x + lamp.at[0] * c - lamp.at[1] * s - s * AS_LAMP_AHEAD_M, y = r.y + lamp.at[0] * s + lamp.at[1] * c + c * AS_LAMP_AHEAD_M;   // under the lamp
    if (lamp.laid && Math.hypot(x - lamp.laid[0], y - lamp.laid[1]) < AS_LAMP_MOVE_M && Math.abs(r.hdg - lamp.laid[2]) < 0.005) return;
    lamp.laid = [x, y, r.hdg];
    var pos = m.geometry.attributes.position, C = AS_LAMP_COLS, R = AS_LAMP_ROWS, hw = AS_LAMP_WIDE_M / 2;
    for (var j = 0; j <= R; j++) for (var i = 0; i <= C; i++) {   // each point of the sheet in the site's frame, on the ground there
      var lx = (i / C * 2 - 1) * hw * (j / R), ly = j / R * AS_LAMP_LEN_M, wx = x + lx * c - ly * s, wy = y + lx * s + ly * c;
      pos.setXYZ(j * (C + 1) + i, wx, wy, _asGroundAt(st, wx, wy, false) + AS_LAMP_LIFT_M);
    }
    pos.needsUpdate = true;
    m.position.set(0, 0, 0); m.rotation.z = 0;
  });
}
// ── Drive to a place ──
// goTo(target): the vehicle drives itself to a place on this ground at its top speed (the held speed-up and the clock's rates
// still apply), along a dotted line, with what is left and the time at the real top speed; any stick or key, or a tap on
// the chip, takes the wheel back at once. A target is { x, y } (metres in the site's frame) or { lat, lon } (degrees), with
// an optional name; a place beyond AS_AUTO_REACH_M is refused, because the site's flat frame stops being true out there
// (the answer says how far it is, so a caller can say so). A tap on the ground names a place first (marker and chip), a second
// tap on it, or on the chip, sets off.
var AS_AUTO_ARRIVE_M = 3, AS_AUTO_REACH_M = 20000, AS_AUTO_TAP_REACH_M = 4000, AS_AUTO_MARK_M = 14, AS_AUTO_STEER = 2.2, AS_AUTO_SLOW_S = 1.2, AS_AUTO_TURN_FIRST = 0.9;
var AS_AUTO_DOTS = 70, AS_AUTO_DOT_MIN_M = 2, AS_AUTO_DOT_PX = 400;
var AS_AUTO_DOT_FRAG = 'varying float vLife; void main() { vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0; if (r > 1.0) discard; gl_FragColor = vec4(vec3(1.0, 0.72, 0.25) * (1.0 - r) * vLife, 1.0); }';
function _asLocalOf(st, t) {
  if (isFinite(t.x) && isFinite(t.y)) return [t.x, t.y];
  if (!isFinite(t.lat) || !isFinite(t.lon)) return null;
  var k = Math.PI / 180, dl = ((t.lon - st.lon + 540) % 360) - 180;
  return [dl * k * st.radiusM * Math.cos(st.lat * k), (t.lat - st.lat) * k * st.radiusM];
}
function _asGoTo(st, t) {
  var at = _asLocalOf(st, t || {});
  if (!st || !st.rover || !at) return { ok: false, reason: 'target' };
  var d = Math.hypot(at[0] - st.rover.x, at[1] - st.rover.y);
  if (d > AS_AUTO_REACH_M) return isFinite(t.lat) && isFinite(t.lon) ? _asTripStart(st, t) : { ok: false, reason: 'far', distM: d };
  _asAutoGo(st, at[0], at[1], t.name);
  return { ok: true, distM: d, seconds: d / st.info.rover.vmax };
}
// A place beyond the flat frame's reach is a journey (the Martian): the vehicle sets off along the great circle at its real top
// speed, the distance left counts down at that speed times the clock's rate, and the clock is sped up to the stop that makes the
// trip last about a minute (day and night go by, the lamps come on at night), said on the chip with a progress fill. Any input
// takes the wheel back where the vehicle has got to; on arrival the drive begins again at the place, with its hardware standing.
var AS_TRIP_TARGET_S = 60, AS_TRIP_RATES = [10, 60, 300, 3600, 21600, 86400, 604800], AS_TRIP_LOCAL_MAX_M = 15000, AS_TRIP_RESUME_MIN_M = 200, AS_ARRIVE_M = 20;
function _asGreatCircle(la1, lo1, la2, lo2, R) {
  var k = Math.PI / 180, p1 = la1 * k, p2 = la2 * k, dl = (lo2 - lo1) * k;
  var a = Math.sin((p2 - p1) / 2) * Math.sin((p2 - p1) / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return { d: 2 * R * Math.asin(Math.min(1, Math.sqrt(a))), bearing: Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) };
}
// The place `d` metres from (lat, lon) along `bearing` (radians clockwise from north).
function _asAlongCircle(lat, lon, bearing, d, R) {
  var k = Math.PI / 180, p1 = lat * k, l1 = lon * k, g = d / R;
  var p2 = Math.asin(Math.sin(p1) * Math.cos(g) + Math.cos(p1) * Math.sin(g) * Math.cos(bearing));
  var l2 = l1 + Math.atan2(Math.sin(bearing) * Math.sin(g) * Math.cos(p1), Math.cos(g) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / k, lon: ((l2 / k + 540) % 360) - 180 };
}
function _asTripStart(st, t) {
  var b = _asBody(st.body);
  if (!b) return { ok: false, reason: 'target' };
  var here = _asLatLon(st, b, _aeXyz(st.rover)), gc = _asGreatCircle(here.lat, here.lon, t.lat, t.lon, st.radiusM);
  if (gc.d < AS_AUTO_REACH_M) return { ok: false, reason: 'target' };
  st.auto = { x: st.rover.x, y: st.rover.y, go: true, name: t.name || '', trip: { lat: t.lat, lon: t.lon, from: here, total: gc.d, left: gc.d, bearing: gc.bearing, mult: 1 } };
  if (st.autoMark) st.autoMark.visible = false;
  var seconds = gc.d / st.info.rover.vmax, rate = typeof _almRate === 'number' ? Math.max(1, _almRate) : 1;
  if (seconds / rate > AS_TRIP_TARGET_S) {   // a long trip runs the drive faster (its own multiple: the shared clock is the person's)
    rate = AS_TRIP_RATES[AS_TRIP_RATES.length - 1];
    for (var i = 0; i < AS_TRIP_RATES.length; i++) if (seconds / AS_TRIP_RATES[i] <= AS_TRIP_TARGET_S) { rate = AS_TRIP_RATES[i]; break; }
  }
  st.auto.trip.mult = rate;
  st.autoAt = 0; _aeRedraw();
  return { ok: true, trip: true, distM: gc.d, seconds: seconds };
}
function _asTripStep(st, dt) {
  var T = st.auto.trip, r = st.rover;
  T.left -= Math.abs(r.v) * dt * T.mult;
  if (T.left > 0 && Math.hypot(r.x, r.y) < AS_TRIP_LOCAL_MAX_M) return;
  if (T.left <= 0) _asTripLand(st, false);
  else _asAutoStop(st);
}
// The drive begins again where the journey has got to: at the place it was going to (arrived, the vehicle coming in to the lander
// the way it was heading) or, when a hand takes the wheel, wherever the great circle has brought it.
function _asTripLand(st, mid) {
  var T = st.auto.trip, body = st.body, p = mid ? _asAlongCircle(T.from.lat, T.from.lon, T.bearing, T.total - T.left, st.radiusM) : { lat: T.lat, lon: T.lon }, name = mid ? '' : st.auto.name;
  _asAutoStop(st);   // puts the clock back
  _aeSiteVisit(body, [name || _aeInfoName(body), p.lat, p.lon, 'landing'], true, { bearing: T.bearing, mid: mid });
}
// A touch of the stick, a key or the chip: the wheel is taken back. A journey under way lands where it has got to.
// True when that landing replaced the visit: the caller's `st` is then gone (its group disposed) and its frame is over.
function _asAutoCancel(st) {
  var T = st.auto && st.auto.trip;
  if (T && T.total - T.left > AS_TRIP_RESUME_MIN_M) { _asTripLand(st, true); return _ae.site !== st; }
  _asAutoStop(st);
  return false;
}
// A tap: the place under it, named (marker, chip) the first time, driven to the second.
function _asAutoTap(st, px, py, w, h) {
  var rv = _aeProject(_asToWorld(st.fr, [st.rover.x, st.rover.y, st.rover.z + AS_WHEEL_TAP_Z_M]));
  if (rv && Math.hypot(rv.x - px, rv.y - py) < AS_WHEEL_TAP_PX) { st.input.wheelie = true; _aeKick(); return; }   // a tap on the vehicle itself is a wheelie
  var cam = _asCameraLocal(st, 0), S = _ae.gl.camera, f = _aeNorm(_aeSub(cam.focus, cam.pos));
  var right = _aeCross(f, [0, 0, 1]);
  if (_aeLen(right) < 1e-6) return;
  right = _aeNorm(right);
  var up = _aeCross(right, f), th = _aeTanHalf(S.fov), ny = 1 - 2 * py / h, nx = (2 * px / w - 1) * th * (w / h);
  var d = _aeNorm([f[0] + right[0] * nx + up[0] * ny * th, f[1] + right[1] * nx + up[1] * ny * th, f[2] + right[2] * nx + up[2] * ny * th]);
  if (d[2] > -0.005) return;   // the sky is not a place
  for (var t = 1; t < AS_AUTO_TAP_REACH_M * 2; t *= 1.06) {
    var x = cam.pos[0] + d[0] * t, y = cam.pos[1] + d[1] * t, z = cam.pos[2] + d[2] * t;
    if (z > _asGroundAt(st, x, y, false)) continue;
    if (Math.hypot(x - st.rover.x, y - st.rover.y) > AS_AUTO_TAP_REACH_M) return;
    _asAutoGo(st, x, y);   // one tap is enough: the vehicle sets off at once (a touch of the stick or a key stops it)
    st.autoAt = 0; _asAutoShow(st);
    return;
  }
}
function _asAutoGo(st, x, y, name, pending) {
  st.auto = { x: x, y: y, name: name || '', go: !pending };
  if (!st.autoLine) _asAutoBuild(st);
  st.autoMark.position.set(x, y, _asGroundAt(st, x, y, false)); st.autoMark.scale.set(1, 1, 1); st.autoMark.visible = true; st.walkMarked = false;
  _aeRedraw();
}
function _asAutoBuild(st) {
  _asAutoMarkBuild(st);
  var THREE = _ae.gl.THREE;
  // the dotted line to it: points laid on the ground between the vehicle and the place
  var dg = new THREE.BufferGeometry(), pos = new Float32Array(AS_AUTO_DOTS * 3), size = new Float32Array(AS_AUTO_DOTS).fill(0.6), life = new Float32Array(AS_AUTO_DOTS).fill(1);
  dg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); dg.setAttribute('size', new THREE.BufferAttribute(size, 1)); dg.setAttribute('life', new THREE.BufferAttribute(life, 1));
  var pts = new THREE.Points(dg, new THREE.ShaderMaterial({ uniforms: { metre: st.shared.metre, pxPerRad: { value: AS_AUTO_DOT_PX } }, vertexShader: AS_DUST_VERT, fragmentShader: AS_AUTO_DOT_FRAG,
    transparent: true, depthWrite: false, blending: AE_THREE_ADDITIVE_BLENDING }));
  pts.frustumCulled = false; st.group.add(pts);
  st.autoLine = { pts: pts, pos: pos };
}
// The pillar of light over a place: the drive's destination, and where a walk is going (almanac-standhost.js).
function _asAutoMarkBuild(st) {
  if (st.autoMark) return;
  var THREE = _ae.gl.THREE, geo = new THREE.BufferGeometry(), hw = 0.8, H = AS_AUTO_MARK_M;   // two crossed strips of light, brightest at the foot
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-hw, 0, 0, hw, 0, 0, hw, 0, H, -hw, 0, H, 0, -hw, 0, 0, hw, 0, 0, hw, H, 0, -hw, H]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), 1));
  var mat = new THREE.ShaderMaterial({ vertexShader: AS_LAMP_VERT, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: AE_THREE_ADDITIVE_BLENDING,
    fragmentShader: 'varying vec2 vUv; void main() { float a = (1.0 - vUv.y) * (1.0 - abs(vUv.x - 0.5) * 2.0) * 0.8; gl_FragColor = vec4(vec3(1.0, 0.7, 0.2) * a, 1.0); }' });
  st.autoMark = new THREE.Mesh(geo, mat); st.autoMark.frustumCulled = false;
  st.group.add(st.autoMark);
}
function _asAutoLineUpdate(st) {
  var L = st.autoLine, r = st.rover, a = st.auto;
  if (!L) return;
  var dx = a.x - r.x, dy = a.y - r.y, d = Math.hypot(dx, dy), step = Math.max(AS_AUTO_DOT_MIN_M, d / AS_AUTO_DOTS), n = Math.min(AS_AUTO_DOTS, Math.floor(d / step));
  for (var i = 0; i < AS_AUTO_DOTS; i++) {
    var t = i < n ? (i + 1) * step / d : 0, x = r.x + dx * t, y = r.y + dy * t;
    L.pos[i * 3] = x; L.pos[i * 3 + 1] = y; L.pos[i * 3 + 2] = i < n ? _asGroundAt(st, x, y, false) + 0.15 : -1e5;
  }
  L.pts.geometry.attributes.position.needsUpdate = true;
}
function _asAutoStop(st) {
  st.auto = null;
  if (st.autoMark) st.autoMark.visible = false;
  if (st.autoLine) st.autoLine.pts.visible = false;
  _aeHudSub('');
}
// The stick the autopilot holds: turn toward the place first, then go, easing off to stop on it. Named but not yet sent: nothing.
function _asAutoSteer(st) {
  var r = st.rover, a = st.auto;
  if (a.trip) { a.x = r.x + Math.sin(a.trip.bearing) * 500; a.y = r.y + Math.cos(a.trip.bearing) * 500; }   // always a point ahead on the great circle
  var dx = a.x - r.x, dy = a.y - r.y, dist = Math.hypot(dx, dy);
  if (!a.go) return [0, 0];
  if (dist < AS_AUTO_ARRIVE_M) { _asAutoStop(st); return [0, 0]; }
  var diff = _aeAngleDeltaRad(r.hdg, Math.atan2(-dx, dy)), sy = Math.min(1, dist / (st.info.rover.vmax * AS_AUTO_SLOW_S));
  if (Math.abs(diff) > AS_AUTO_TURN_FIRST) sy = Math.min(sy, 0.3);
  return [_aeClamp(-diff * AS_AUTO_STEER, -1, 1), sy];
}
// "4.2 km · 19 min": what is left, and the time it takes at the top speed (no speed-up). Dashed until it is sent.
function _asDurText(s) {
  if (s < 90) return _orrNum(s, 'second', 0);
  if (s < 5400) return _orrNum(s / 60, 'minute', 0);
  if (s < 172800) return _orrNum(s / 3600, 'hour', 1);
  var days = Math.floor(s / 86400), hours = Math.round((s - days * 86400) / 3600);
  return _orrNum(days, 'day', 0) + ' ' + _orrNum(hours, 'hour', 0);
}
function _asAutoShow(st) {
  var now = performance.now();
  if (!st.auto || now - (st.autoAt || 0) < AS_SPEED_SHOW_MS) return;
  st.autoAt = now;
  var T = st.auto.trip, left = T ? T.left : Math.hypot(st.auto.x - st.rover.x, st.auto.y - st.rover.y), s = left / st.info.rover.vmax;
  // the thing's name, what is left and the time at the vehicle's real top speed; the clock's speed-up is a picture, not a sentence
  _aeHudSub((T ? AS_FF_SVG : '') + _almEsc((st.auto.name ? st.auto.name + '  \u00b7  ' : '') + _aeStHeightText(left) + '  \u00b7  ' + _asDurText(s)), T ? 1 - T.left / T.total : 0, !st.auto.go);
  if (T) { if (st.autoLine) st.autoLine.pts.visible = false; return; }
  if (st.autoLine) st.autoLine.pts.visible = true;
  _asAutoLineUpdate(st);
}

// ── The driver's seat ──
// The camera at the vehicle's own eye point (a row of the vehicle table: x right, y ahead, z up from the ground under it),
// turned with the vehicle and by a thumb, which comes back to dead ahead when let go. The ground's slope tips the view only
// a little (and not at all when motion is reduced); the vehicle's own pitch is what is felt, not shown in full.
var AS_SEAT_TILT = 0.5, AS_SEAT_TILT_EASE = 6, AS_SEAT_AHEAD_M = 4;
function _asSeatLocal(st, dt) {
  var r = st.rover, s = st.info.rover.seat, c = Math.cos(r.hdg), sn = Math.sin(r.hdg);
  if (performance.now() - st.look.touched > 900) st.look.yaw *= Math.exp(-AS_CAM_FOLLOW.yawBack * dt);
  st.seatTilt = (st.seatTilt || 0) + ((_aeReduceMotion() ? 0 : r.pitch) - (st.seatTilt || 0)) * (1 - Math.exp(-AS_SEAT_TILT_EASE * dt));
  var pos = [r.x + s[0] * c - s[1] * sn, r.y + s[0] * sn + s[1] * c, r.z + s[2]];
  var hd = r.hdg - st.look.yaw, p = _aeClamp(st.look.pitch + st.seatTilt * AS_SEAT_TILT - (st.info.rover.seatDown || 0), -0.5, 1.2), cp = Math.cos(p);
  st.focus = [pos[0] - Math.sin(hd) * cp * AS_SEAT_AHEAD_M, pos[1] + Math.cos(hd) * cp * AS_SEAT_AHEAD_M, pos[2] + Math.sin(p) * AS_SEAT_AHEAD_M];
  return { pos: pos, focus: st.focus };
}
// ── The bumper ──
// The vehicle is a circle and so is each part of the site (the lander, an experiment package, a parked rover): where they
// overlap it is moved out along the line between them, so it slides round what it presses on and cannot end up inside.
function _asBump(st, r, dt) {
  var own = r.wheels.concat(r.body), reach = Math.max.apply(null, r.hubs.map(function (h) { return Math.abs(h[0]); })) + 0.5;
  for (var i = 0; i < st.parts.length; i++) {
    var p = st.parts[i];
    if (p.size < AS_BUMP_MIN_SIZE_M || own.indexOf(p) >= 0 || p.hubs) continue;
    var dx = r.x - p.x, dy = r.y - p.y, d = Math.hypot(dx, dy), min = reach + p.size * AS_BUMP_FOOT;
    if (d >= min || d < 1e-6) continue;
    var nx = dx / d, ny = dy / d;
    r.x = p.x + nx * min; r.y = p.y + ny * min;
    var hx = -Math.sin(r.hdg), hy = Math.cos(r.hdg), head = hx * nx + hy * ny;   // how squarely it was driving into it (negative: toward)
    if (head >= 0) continue;
    // Pressing on it, it is turned toward the side it is already leaning to (the left if dead centre) so a thumb held forward goes round, never stops.
        var tx = -ny, ty = nx, lat = hx * tx + hy * ty, sgn = lat >= 0 ? 1 : -1;   // the tangent the heading leans to
    tx *= sgn; ty *= sgn;
    // A glancing press costs almost no speed (the square of how squarely it presses): at a rover's true pace (centimetres a second on Mars) a slowing that
    // went with the press itself left it grinding along the part's side, never getting past.
    // The turn goes with the ground covered, not with time: AS_BUMP_TURN times the part's own curve (1 / min radians a metre), so a slow vehicle and a fast
    // one take the same line round it. (A turn in radians a second swung a Mars rover, at centimetres a second, a quarter turn aside before it had moved.)
    r.hdg += (hx * ty - hy * tx >= 0 ? 1 : -1) * AS_BUMP_TURN * -head * Math.abs(r.v) * dt / min;
    r.v *= 1 - Math.min(1, head * head * AS_BUMP_SLOW * dt);
  }
}

// ── The rover ──
// How high a rover called up from where one stands starts: out of the picture over its top edge, seen from the eye ("it drops in
// from off the top of the screen"; from 3 m it was already in view, just above the ground).
function _asDropInHeight(st, s0) {
  var e = st.eye0, d = Math.hypot(s0.x - (e.x || 0), s0.y - (e.y || 0)), up = _aeClamp((e.pitch || 0) + _aeRad(e.fov || 60) / 2, 0, _aeRad(75));
  return AE_STAND_EYE_M + d * Math.tan(up) + AS_DROP_IN_CLEAR_M;
}
function _asRoverBuild(st) {
  if (st.rover || !st.drive || !st.info.rover || !st.group) return;
  var s0 = st.start || AS_ROVER_START, R = _asRoverPartsAdd(st, _asRoverModels(st.info.rover), s0.x, s0.y, s0.hdg);
  if (!R) return;
  var ground = _asGroundAt(st, s0.x, s0.y, false);
  R.x = s0.x; R.y = s0.y; R.hdg = _aeRad(-s0.hdg); R.v = 0; R.vz = 0; R.z = ground; R.airborne = false;
  if (st.eye0 && !_aeReduceMotion()) { R.z = ground + _asDropInHeight(st, s0); R.airborne = true; }   // called up from where one stood: it falls in from above and bounces, in the body's own gravity
  R.pitch = R.roll = R.spin = 0; R.lastTrack = [R.x, R.y]; R.jumpAt = 0; R.mean = ground;
  st.rover = R;
  st.cx = 1e9;
  st.view = 0;
  st.camera.dist = st.info.rover.cam * AS_VIEW_CHASE_K[0];   // opens in the wide chase
  st.camera.az = R.hdg + Math.PI;
  st.camera.el = AS_CHASE_EL;
  st.focus = [R.x, R.y, ground + 1];
  _asLinkRoverPlace(st, R);
}
function _asStick(st) {
  var i = st.input, sx = i.sx, sy = i.sy, k = i.keys;
  if (k.f) sy += 1;
  if (k.b) sy -= 1;
  if (k.r) sx += 1;
  if (k.l) sx -= 1;
  return [_aeClamp(sx, -1, 1), _aeClamp(sy, -1, 1)];
}
// The factor the picture's motion is scaled by: the clock's rate (1 where it is paused, backwards or slow), and while a thumb
// steers no more than AS_HELD_RATE_CAP. Pushing the stick further runs the drive at AS_DRIVE_FAST_RATE (its own, the clock is left alone).
function _asTimeScale(st, held) {
  var rate = typeof _almRate === 'number' ? Math.max(1, _almRate) : 1;
  if (st.input.fast) rate = Math.max(rate, (st.info && st.info.rover && st.info.rover.fast) || AS_DRIVE_FAST_RATE);   // each vehicle's own turbo: a Mars rover at its real 0.04 m/s needs ×100 to cross a landscape   // the drive's own turbo: the shared clock is the person's, never set here
  return (held ? Math.min(rate, AS_HELD_RATE_CAP) : rate) * _asBoost(st);
}
// Holding the stick full for a while speeds the ground covered up, a step at a time to AS_BOOST_MAX (the rover "moves super slow"); it ends the moment the stick eases.
function _asBoost(st) {
  var t = (st.input.fullS || 0) - AS_BOOST_AFTER_S;
  return t <= 0 ? 1 : 1 + (AS_BOOST_MAX - 1) * Math.min(1, t / AS_BOOST_RAMP_S);
}
function _asRoverStep(st, dt) {
  var r = st.rover, info = st.info.rover;
  if (!r) return;
  // (on foot, the walking thumb is not the rover's driver)
  var s = !st.drive || (r.airborne && st.calledUp && !st.atEye) ? [0, 0] : _asStick(st), sx = Math.abs(s[0]) < AS_DRIVE_DEAD ? 0 : s[0], sy = Math.abs(s[1]) < AS_DRIVE_DEAD ? 0 : s[1];
  var lk = st.input.look;
  if (lk.yaw || lk.pitch) {   // the arrows look round; let go and the view comes back by itself
    st.look.yaw += lk.yaw * AS_LOOK_KEY_RATE * dt; st.look.pitch = _aeClamp(st.look.pitch + lk.pitch * AS_LOOK_KEY_RATE * dt, -0.25, 1.0); st.look.touched = performance.now();
  }
  if (st.auto) {
    if (sx || sy) { if (_asAutoCancel(st)) return; }   // a touch on the stick or a key is the driver taking over
    else { var a = _asAutoSteer(st); sx = a[0]; sy = a[1]; }
  }
  // One time, one speed: the vehicle has its real top speed, the stick says how much of it; what is shown is that times the
  // clock's rate (pushed past the solid ring, or Shift, the rate holds at the next stop; held by a thumb it is capped).
  st.input.fullS = Math.hypot(st.input.sx, st.input.sy) >= AS_BOOST_STICK && !st.auto ? (st.input.fullS || 0) + dt : 0;   // (the thumb's stick; the keys have Shift)
  var held = !!(sx || sy), k = st.auto && st.auto.trip ? 1 : _asTimeScale(st, held);
  if (typeof _almStripCap === 'function') _almStripCap(held && !st.auto ? AS_HELD_RATE_CAP : 0);   // the slider's far ends are dimmed while a thumb steers   // (a journey counts its distance down by the rate itself)
  var ts = k;   // (the picture's time scale; k is used again below for the ease)
  r.v += _aeClamp(sy * info.vmax - r.v, -AS_ACCEL * dt * 1.5, AS_ACCEL * dt);
  r.hdg += -sx * AS_TURN_RATE * (0.45 + 0.55 * Math.min(1, Math.abs(r.v) / info.vmax)) * dt;
  r.x += -Math.sin(r.hdg) * r.v * dt * k; r.y += Math.cos(r.hdg) * r.v * dt * k;
  _asBump(st, r, dt);
  var gnd = _asWheelsGround(st, r.hubs, r.x, r.y, r.hdg), ease = 1 - Math.exp(-10 * dt), g = st.info.g;   // (k stays the motion's scale: the wheels, the odometer and the reported speed use it)
  r.pitch += (_aeClamp(gnd.pitch, -AS_TILT_MAX, AS_TILT_MAX) - r.pitch) * ease; r.roll += (_aeClamp(gnd.roll, -AS_TILT_MAX, AS_TILT_MAX) - r.roll) * ease;
  // Space (or a tap on it): a wheelie, the nose comes up and the vehicle lurches forward a little, then settles.
  var now = performance.now();
  if (st.input.wheelie && !(r.wheelie && now - r.wheelie < AS_WHEELIE_MS)) r.wheelie = now;
  st.input.wheelie = false;
  var wt = r.wheelie ? (now - r.wheelie) / AS_WHEELIE_MS : 1, wo = wt < 1 ? Math.sin(Math.PI * wt) : 0;
  if (wt >= 1) r.wheelie = 0;
  if (wo) { r.x += -Math.sin(r.hdg) * info.vmax * AS_WHEELIE_LURCH * wo * dt * ts; r.y += Math.cos(r.hdg) * info.vmax * AS_WHEELIE_LURCH * wo * dt * ts; }
  if (r.airborne && st.eye0 && st.phase !== 'stand' && !_asCallWaitOver(st)) r.vz = 0;   // called up from Stand here: it waits overhead until the camera has come down (never past AS_CALL_WAIT_MS: a clock jump or a stalled ground must not leave one on foot), then falls in view
  else if (r.airborne) {
    r.vz -= g * dt; r.z += r.vz * dt;
    if (r.z <= gnd.mean) {
      var hit = -r.vz;
      r.z = gnd.mean;
      if (hit > AS_BOUNCE_MIN_MS) { _asDustBurst(st, 14, Math.min(1.5, hit * 0.3)); r.vz = hit * AS_BOUNCE_KEEP; }   // it bounces, lower each time
      else { r.vz = 0; r.airborne = false; }
    }
  } else r.z += (gnd.mean - r.z) * (1 - Math.exp(-14 * dt));
  r.spin += r.v * dt * k / r.rm.radius;
  r.mean = gnd.mean; r.wheelGround = gnd.hs;
  _asRoverPlace(st, r, r.x, r.y, r.hdg, r.z + AS_WHEELIE_LIFT_M * wo, r.pitch + AS_WHEELIE_PITCH * wo, r.roll, r.spin, gnd, r.airborne || wo > 0.15);   // (the wheels hang from the body at the top of a wheelie)
  _asTrackStep(st);
  _asDustStep(st, dt);
  r.odo = (r.odo || 0) + Math.abs(r.v) * dt * k;
  var a = st.auto, T = a && a.trip, ll = st.fr && typeof _asLatLon === 'function' ? _asLatLon(st, _asBody(st.body), [r.x, r.y, 0]) : null;
  _aeMoveTell('rover', st.body, Math.abs(r.v) * k, { place: ll, coveredM: r.odo, to: a ? a.name || null : null, toM: a ? (T ? T.left : Math.hypot(a.x - r.x, a.y - r.y)) : null });
  _asLampStep(st);
  _asSpeedShow(st);
  if (st.auto) { if (st.auto.trip && st.auto.go) _asTripStep(st, dt); if (st.auto) _asAutoShow(st); }
}
// The speed, a number and its unit, in the time chip (the vehicle's own; the rate it is run at beside it).
function _asSpeedShow(st) {
  var now = performance.now();
  if (now - (st.speedAt || 0) < AS_SPEED_SHOW_MS) return;
  st.speedAt = now;
  // The vehicle's own (true) speed, and the time it is run at when that is not 1: "0.15 km/h · ×100".
  var mi = _aeImperial(), k = _asTimeScale(st, !!(st.input.sx || st.input.sy || st.input.keys.f || st.input.keys.b)), v = Math.abs(st.rover.v) * (mi ? AS_MPH_PER_MS : AS_KMH_PER_MS);
  _aeHudRead(_orrNum(v, mi ? 'mile-per-hour' : 'kilometer-per-hour', v < 10 ? 2 : 0) + (k > 1 ? ' \u00b7 \u00d7' + _orrNum(k, null, 0) : ''));
}
// Tread marks: under each side's wheels a ribbon of points one every AS_TREAD_STEP_M (the path the wheels really took, curves included), each side a
// ring of AS_TREAD_RING points whose oldest are forgotten. A tyre's mark is a slight darkening with chevron lugs across it, broken up like pressed dust,
// soft at its edges, fading with its age and with distance.
var AS_TREAD_VERT = 'uniform float metre; attribute float aU; attribute float aV; attribute float aT; varying float vU; varying float vV; varying float vT; varying float vDist;\nvoid main() { vU = aU; vV = aV; vT = aT; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz) / metre; gl_Position = projectionMatrix * mv; }';
var AS_TREAD_FRAG = 'uniform float alpha; uniform float now; uniform float pitch; uniform vec2 ageFade; uniform vec2 farFade; uniform vec2 sharp; varying float vU; varying float vV; varying float vT; varying float vDist;\n' +
  'float hh(float x) { return fract(sin(x * 127.1) * 43758.5453); }\n' +
  'void main() {\n' +
  '  float x = abs(vU), edge = 1.0 - smoothstep(0.55, 1.0, x);\n' +
  '  float t = fract(vV / pitch + x * 0.7), lug = smoothstep(0.3, 0.45, t) - smoothstep(0.78, 0.95, t);\n' +   // chevrons: a lug's line leans back toward the edges
  '  float pat = mix(0.62, 0.35 + 0.65 * lug, 1.0 - smoothstep(sharp.x, sharp.y, vDist));\n' +
  '  float broken = 0.7 + 0.3 * hh(floor(vV * 7.0) + floor(vU * 3.0) * 13.0);\n' +   // dust pressed unevenly: a slow patchwork along the mark
  '  float a = alpha * edge * pat * broken * (1.0 - smoothstep(ageFade.x, ageFade.y, now - vT)) * (1.0 - smoothstep(farFade.x, farFade.y, vDist));\n' +
  '  gl_FragColor = vec4(0.03, 0.03, 0.035, a);\n}';
function _asTrackInit(st) {
  var THREE = _ae.gl.THREE, M = AS_TREAD_RING, geo = new THREE.BufferGeometry(), n = 2 * M * 2;   // two sides, a ring each, a pair of vertices a point
  var T = st.tracks = { geo: geo, pos: new Float32Array(n * 3), u: new Float32Array(n), v: new Float32Array(n), t: new Float32Array(n), head: [0, 0], count: [0, 0], run: 0, t0: performance.now() };
  for (var i = 0; i < n; i++) { T.pos[i * 3 + 2] = -1e5; T.u[i] = i % 2 ? 1 : -1; }
  var idx = [];
  for (var side = 0; side < 2; side++) for (var q = 0; q < M - 1; q++) { var b = (side * M + q) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  geo.setAttribute('position', new THREE.BufferAttribute(T.pos, 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(T.u, 1));
  geo.setAttribute('aV', new THREE.BufferAttribute(T.v, 1));
  geo.setAttribute('aT', new THREE.BufferAttribute(T.t, 1));
  geo.setIndex(idx);
  T.uni = { alpha: { value: AS_TREAD_ALPHA }, now: { value: 0 }, pitch: { value: AS_TREAD_PITCH_M }, ageFade: { value: new THREE.Vector2(AS_TREAD_AGE_S[0], AS_TREAD_AGE_S[1]) },
    farFade: { value: new THREE.Vector2(AS_TREAD_FAR_M[0], AS_TREAD_FAR_M[1]) }, sharp: { value: new THREE.Vector2(AS_TREAD_SHARP_M[0], AS_TREAD_SHARP_M[1]) }, metre: st.shared.metre };
  var mat = new THREE.ShaderMaterial({ uniforms: T.uni, vertexShader: AS_TREAD_VERT, fragmentShader: AS_TREAD_FRAG, side: AE_THREE_DOUBLE_SIDE, transparent: true, depthWrite: false });
  mat.polygonOffset = true; mat.polygonOffsetFactor = -3; mat.polygonOffsetUnits = -6;
  var mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  st.group.add(mesh);
  T.mesh = mesh;
}
function _asTrackStep(st) {
  var r = st.rover;
  if (!st.tracks) _asTrackInit(st);
  var T = st.tracks, M = AS_TREAD_RING, now = (performance.now() - T.t0) / 1000;
  T.uni.now.value = now;
  if (r.airborne || Math.hypot(r.x - r.lastTrack[0], r.y - r.lastTrack[1]) < AS_TREAD_STEP_M) return;
  T.run += Math.hypot(r.x - r.lastTrack[0], r.y - r.lastTrack[1]);
  r.lastTrack = [r.x, r.y];
  var c = Math.cos(r.hdg), s = Math.sin(r.hdg), wid = r.hubs.reduce(function (m, a) { return Math.max(m, Math.abs(a[0])); }, 0), hw = AS_TREAD_HALF_M;
  [-1, 1].forEach(function (side, k) {
    var q = T.head[k], base = (k * M + q) * 2;
    // This point's two edges: across the heading, each side of the wheel's line (the path the wheel took: the ribbon bends as the vehicle turns).
    for (var e = 0; e < 2; e++) {
      var lx = side * wid + (e ? hw : -hw), x = r.x + lx * c, y = r.y + lx * s, o = (base + e);
      T.pos[o * 3] = x; T.pos[o * 3 + 1] = y; T.pos[o * 3 + 2] = _asGroundAt(st, x, y, false) + 0.02;
      T.v[o] = T.run; T.t[o] = now;
    }
    // The slot after the newest folds onto it, so the newest and the oldest points are not joined by a quad across the whole track.
    var nb = (k * M + (q + 1) % M) * 2;
    for (var f = 0; f < 2; f++) { var d = nb + f, sIdx = base + f; T.pos[d * 3] = T.pos[sIdx * 3]; T.pos[d * 3 + 1] = T.pos[sIdx * 3 + 1]; T.pos[d * 3 + 2] = T.pos[sIdx * 3 + 2]; T.v[d] = T.v[sIdx]; T.t[d] = now; }
    T.head[k] = (q + 1) % M;
  });
  var A = T.geo.attributes; A.position.needsUpdate = A.aV.needsUpdate = A.aT.needsUpdate = true;
}
// Dust: points thrown from the rear wheels, falling at the body's gravity.
function _asDustInit(st) {
  st.dust = _asPoints(st, {}, AS_DUST_MAX, { albedo: st.shared.albedo, lit: st.shared.lit, ambient: st.shared.ambient, fade: st.shared.fade }, AS_DUST_VERT, AS_DUST_FRAG);
}
function _asDustBurst(st, n, power) {
  var r = st.rover;
  if (!r) return;
  if (!st.dust) _asDustInit(st);
  var D = st.dust, c = Math.cos(r.hdg), s = Math.sin(r.hdg);
  for (var k = 0; k < n; k++) {
    var i = D.next++ % AS_DUST_MAX, side = k % 2 ? 1 : -1, wid = 0.9 * side, back = -1.0 + Math.random() * 0.4;
    D.pos[i * 3] = r.x + wid * c - back * s; D.pos[i * 3 + 1] = r.y + wid * s + back * c; D.pos[i * 3 + 2] = r.mean + 0.2;
    D.vel[i * 3] = (Math.random() - 0.5) * power - s * (-r.v) * 0.25; D.vel[i * 3 + 1] = (Math.random() - 0.5) * power + c * (-r.v) * 0.25; D.vel[i * 3 + 2] = (0.4 + Math.random()) * power;
    D.size[i] = 0.14 + Math.random() * 0.24; D.life[i] = 1;
  }
}
function _asDustStep(st, dt) {
  var r = st.rover;
  if (!st.dust && Math.abs(r.v) > 0.8) _asDustInit(st);
  var D = st.dust;
  if (!D) return;
  var g = st.info.g, i;
  if (!r.airborne && Math.abs(r.v) > 0.8) { st.dustAcc = (st.dustAcc || 0) + dt * Math.abs(r.v) * 5; while (st.dustAcc >= 1) { st.dustAcc -= 1; _asDustBurst(st, 2, 0.4 + Math.abs(r.v) * 0.15); } }
  for (i = 0; i < AS_DUST_MAX; i++) {
    if (D.life[i] <= 0) { D.pos[i * 3 + 2] = -1e5; continue; }
    D.vel[i * 3 + 2] -= g * dt;
    D.pos[i * 3] += D.vel[i * 3] * dt; D.pos[i * 3 + 1] += D.vel[i * 3 + 1] * dt; D.pos[i * 3 + 2] += D.vel[i * 3 + 2] * dt;
    var floor = _asGroundAt(st, D.pos[i * 3], D.pos[i * 3 + 1], true);
    if (D.pos[i * 3 + 2] < floor) { D.pos[i * 3 + 2] = floor; D.vel[i * 3] *= 0.3; D.vel[i * 3 + 1] *= 0.3; D.vel[i * 3 + 2] = 0; }
    D.life[i] -= dt * (g < 2 ? 0.45 : 0.9);
    D.size[i] += dt * 0.12;
  }
  D.geo.attributes.position.needsUpdate = true; D.geo.attributes.size.needsUpdate = true; D.geo.attributes.life.needsUpdate = true;
}

// ── For the tests: where everything stands, and the rover run on a fixed step (a software renderer draws a frame a second) ──
function _aeSiteAdvance(seconds) {
  var st = _ae && _ae.site;
  if (!st || !st.rover) return;
  for (var t = 0; t < seconds && _ae.site === st; t += 1 / 60) _asRoverStep(st, 1 / 60);   // (a visit replaced along the way is not stepped on)
  _aeRedraw();
}