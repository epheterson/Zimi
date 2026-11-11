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
var AS_SPEED_SHOW_MS = 120;                                // the speed readout's refresh
var AS_KMH_PER_MS = 3.6, AS_MPH_PER_MS = 2.23694;
var AS_JUMP_COOLDOWN_MS = 250;
var AS_TRACK_MAX = 1400, AS_TRACK_STEP_M = 0.45;
var AS_DUST_MAX = 160;

// Dust kicked up by the wheels: soft round points, lit like the ground, falling under the body's own gravity.
var AS_DUST_VERT = [
  'attribute float size; attribute float life;',
  'uniform float metre; uniform float pxPerRad;',
  'varying float vLife;',
  'void main() {',
  '  vLife = life;',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  float dist = max(length(mv.xyz) / metre, 0.3);',
  '  gl_PointSize = clamp(size * pxPerRad / dist, 0.0, 90.0);',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var AS_DUST_FRAG = [
  'uniform vec3 albedo; uniform float lit; uniform float ambient; uniform float fade;',
  'varying float vLife;',
  'void main() {',
  '  vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0;',
  '  if (r > 1.0) discard;',
  '  vec3 col = albedo * (lit + ambient);',
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade * vLife * (1.0 - r) * 0.6);',
  '}'
].join('\n');

// ── The rover ──
function _asRoverBuild(st) {
  if (st.rover || !st.drive || !st.info.rover || !st.group) return;
  var R = _asRoverPartsAdd(st, _asRoverModels(st.info.rover), AS_ROVER_START.x, AS_ROVER_START.y, AS_ROVER_START.hdg);
  if (!R) return;
  var ground = _asGroundAt(st, AS_ROVER_START.x, AS_ROVER_START.y, false);
  R.x = AS_ROVER_START.x; R.y = AS_ROVER_START.y; R.hdg = _aeRad(-AS_ROVER_START.hdg); R.v = 0; R.vz = 0; R.z = ground; R.airborne = false;
  R.pitch = R.roll = R.spin = 0; R.lastTrack = [R.x, R.y]; R.jumpAt = 0; R.mean = ground;
  st.rover = R;
  st.cx = 1e9;
  st.camera.dist = st.info.rover.cam;
  st.camera.az = R.hdg + Math.PI;
  st.camera.el = AS_CHASE_EL;
  st.focus = [R.x, R.y, ground + 1];
}
function _asStick(st) {
  var i = st.input, sx = i.sx, sy = i.sy, k = i.keys;
  if (k.f) sy += 1;
  if (k.b) sy -= 1;
  if (k.r) sx += 1;
  if (k.l) sx -= 1;
  return [_aeClamp(sx, -1, 1), _aeClamp(sy, -1, 1)];
}
function _asRoverStep(st, dt) {
  var r = st.rover, info = st.info.rover;
  if (!r) return;
  var s = _asStick(st), sx = Math.abs(s[0]) < AS_DRIVE_DEAD ? 0 : s[0], sy = Math.abs(s[1]) < AS_DRIVE_DEAD ? 0 : s[1];
  r.v += _aeClamp(sy * info.vmax - r.v, -AS_ACCEL * dt * 1.5, AS_ACCEL * dt);
  r.hdg += -sx * AS_TURN_RATE * (0.45 + 0.55 * Math.min(1, Math.abs(r.v) / info.vmax)) * dt;
  r.x += -Math.sin(r.hdg) * r.v * dt; r.y += Math.cos(r.hdg) * r.v * dt;
  var gnd = _asWheelsGround(st, r.hubs, r.x, r.y, r.hdg), k = 1 - Math.exp(-10 * dt), g = st.info.g;
  r.pitch += (gnd.pitch - r.pitch) * k; r.roll += (gnd.roll - r.roll) * k;
  if (st.input.jump && !r.airborne && performance.now() - r.jumpAt > AS_JUMP_COOLDOWN_MS) { r.vz = info.jump; r.airborne = true; r.jumpAt = performance.now(); }
  st.input.jump = false;
  if (r.airborne) {
    r.vz -= g * dt; r.z += r.vz * dt;
    if (r.z <= gnd.mean) {
      var hit = -r.vz;
      r.z = gnd.mean;
      if (hit > AS_BOUNCE_MIN_MS) { _asDustBurst(st, 14, Math.min(1.5, hit * 0.3)); r.vz = hit * AS_BOUNCE_KEEP; }   // it bounces, lower each time
      else { r.vz = 0; r.airborne = false; }
    }
  } else r.z += (gnd.mean - r.z) * (1 - Math.exp(-14 * dt));
  r.spin += r.v * dt / r.rm.radius;
  r.mean = gnd.mean; r.wheelGround = gnd.hs;
  _asRoverPlace(st, r, r.x, r.y, r.hdg, r.z, r.pitch, r.roll, r.spin, gnd, r.airborne);
  _asTrackStep(st);
  _asDustStep(st, dt);
  _asSpeedShow(st);
}
// The speed, as a number and its unit, in the corner of the picture.
function _asSpeedShow(st) {
  var el = _aeById('as-speed'), now = performance.now();
  if (!el || now - (st.speedAt || 0) < AS_SPEED_SHOW_MS) return;
  st.speedAt = now;
  var mi = _aeImperial(), v = Math.abs(st.rover.v);
  el.textContent = _orrNum(v * (mi ? AS_MPH_PER_MS : AS_KMH_PER_MS), mi ? 'mile-per-hour' : 'kilometer-per-hour', 1);
}
// Tracks: a dark mark every AS_TRACK_STEP_M under the wheels on each side, the oldest forgotten past AS_TRACK_MAX.
function _asTrackInit(st) {
  var THREE = _ae.gl.THREE, geo = new THREE.BufferGeometry();
  st.trackPos = new Float32Array(AS_TRACK_MAX * 4 * 3); st.trackNor = new Float32Array(AS_TRACK_MAX * 4 * 3);
  for (var i = 0; i < AS_TRACK_MAX; i++) for (var v = 0; v < 4; v++) { st.trackNor[(i * 4 + v) * 3 + 2] = 1; st.trackPos[(i * 4 + v) * 3 + 2] = -1e5; }
  var idx = new Uint16Array(AS_TRACK_MAX * 6);
  for (var q = 0; q < AS_TRACK_MAX; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  geo.setAttribute('position', new THREE.BufferAttribute(st.trackPos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(st.trackNor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  var uni = { sun: st.shared.sun, lit: st.shared.lit, albedo: st.shared.albedo, ambient: st.shared.ambient, fade: st.shared.fade, tint: { value: 0.5 }, haze: st.groundUni.haze, metre: st.shared.metre };
  var mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AS_GROUND_VERT, fragmentShader: AS_GROUND_FRAG }));
  mesh.frustumCulled = false;
  mesh.material.polygonOffset = true; mesh.material.polygonOffsetFactor = -1; mesh.material.polygonOffsetUnits = -2;
  st.group.add(mesh);
  st.tracks = { geo: geo, n: 0 };
}
function _asTrackStep(st) {
  var r = st.rover;
  if (!st.tracks) _asTrackInit(st);
  if (r.airborne || Math.hypot(r.x - r.lastTrack[0], r.y - r.lastTrack[1]) < AS_TRACK_STEP_M) return;
  r.lastTrack = [r.x, r.y];
  var c = Math.cos(r.hdg), s = Math.sin(r.hdg), half = 0.13, len = AS_TRACK_STEP_M * 1.25, wid = r.hubs.reduce(function (m, a) { return Math.max(m, Math.abs(a[0])); }, 0);
  [-1, 1].forEach(function (side) {
    var q = (st.tracks.n++) % AS_TRACK_MAX, corners = [[-half, -len / 2], [half, -len / 2], [half, len / 2], [-half, len / 2]];
    for (var v = 0; v < 4; v++) {
      var lx = side * wid + corners[v][0], ly = corners[v][1];
      var x = r.x + lx * c - ly * s, y = r.y + lx * s + ly * c, o = (q * 4 + v) * 3;
      st.trackPos[o] = x; st.trackPos[o + 1] = y; st.trackPos[o + 2] = _asGroundAt(st, x, y, false) + 0.02;
    }
  });
  st.tracks.geo.attributes.position.needsUpdate = true;
}
// Dust: points thrown from the rear wheels, falling at the body's gravity.
function _asDustInit(st) {
  var THREE = _ae.gl.THREE, geo = new THREE.BufferGeometry();
  st.dust = { pos: new Float32Array(AS_DUST_MAX * 3), vel: new Float32Array(AS_DUST_MAX * 3), size: new Float32Array(AS_DUST_MAX), life: new Float32Array(AS_DUST_MAX), next: 0, geo: geo };
  geo.setAttribute('position', new THREE.BufferAttribute(st.dust.pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(st.dust.size, 1));
  geo.setAttribute('life', new THREE.BufferAttribute(st.dust.life, 1));
  var uni = { albedo: st.shared.albedo, lit: st.shared.lit, ambient: st.shared.ambient, fade: st.shared.fade, metre: st.shared.metre, pxPerRad: { value: 800 } };
  var pts = new THREE.Points(geo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AS_DUST_VERT, fragmentShader: AS_DUST_FRAG, transparent: true, depthWrite: false }));
  pts.frustumCulled = false;
  st.group.add(pts);
  st.dust.uni = uni;
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
  for (var t = 0; t < seconds; t += 1 / 60) _asRoverStep(st, 1 / 60);
  _ae.dirty = true; _aeKick();
}