// A launch watched from the ground (almanac-sites.js): the Saturn V on Launch Complex 39A as Apollo 11 left it, a
// countdown, ignition, the climb and the pitch-over, flame and smoke thrown from the engines, and a camera that stays
// where you stood and follows it up. Loaded at the first press of the launch button.
//
// The flight is the rocket's own equations, not a drawing of one: thrust over a mass that burns away, gravity and
// air drag, the thrust held along the nose and the nose pitched over to the east on a program (all the numbers are in
// AS_SATURN below and in the Almanac's reference). Stepped once at the start; the picture reads the result.

// ── Constants ──
var AS_SATURN = {
  thrustSeaN: 34.5e6, thrustVacN: 39.0e6,   // the five F-1 engines of the first stage, at the pad and in a vacuum
  massKg: 2.97e6, burnKgS: 13300,           // lift-off mass and what the first stage burns each second
  cutoffS: 161,                              // the outboard engines' cut-off
  dragCd: 0.5, areaM2: 80,                  // across its 10.1 m body
  tiltStartS: 12, tiltPerS: 1.2, tiltPow: 0.78, tiltMaxDeg: 62,   // the pitch program: degrees from vertical after the tower is clear
  scaleHeightM: 7200, rho0: 1.225
};
var AS_LAUNCH_COUNT_S = 5;                  // the count, in seconds
var AS_LAUNCH_IGNITION_S = 1.6;             // the engines light this long before lift-off
var AS_LAUNCH_STEP_S = 0.05;
var AS_LAUNCH_MAX_S = 175;
var AS_LAUNCH_WATCH_M = 900;                // the nearest the watcher stands to the pad
var AS_LAUNCH_VIEW_DEG = [58, 16];          // the camera's field of view, wide at the pad and drawn in as the rocket climbs
var AS_LAUNCH_ZOOM_S = 55;
var AS_LAUNCH_WARP = [28, 70, 3.5];         // after this many seconds of flight, up to this many, the clock runs this much faster
var AS_LAUNCH_SHAKE = { s: 9, deg: 0.22 };  // the ground's tremor in the camera at lift-off, and how long it lasts
var AS_FLAME_MAX = 360, AS_SMOKE_MAX = 520;
var AS_FLAME_LIFE_S = [0.25, 0.55];
var AS_SMOKE_LIFE_S = [30, 46];
var AS_LAUNCH_AZIMUTH_FALLBACK = 72;

var AS_PUFF_VERT = [
  'attribute float size; attribute float life;',
  'uniform float pxPerRad; uniform float metre;',
  'varying float vLife;',
  'void main() {',
  '  vLife = life;',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  float dist = max(length(mv.xyz) / metre, 1.0);',
  '  gl_PointSize = clamp(size * pxPerRad / dist, 0.0, 320.0);',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var AS_FLAME_FRAG = [
  'uniform float fade;',
  'varying float vLife;',
  'void main() {',
  '  vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0;',
  '  if (r > 1.0) discard;',
  '  vec3 hot = mix(vec3(1.0, 0.45, 0.1), vec3(1.0, 0.95, 0.75), vLife);',
  '  gl_FragColor = vec4(hot * (1.0 - r) * vLife * 1.4, fade);',
  '}'
].join('\n');
var AS_SMOKE_FRAG = [
  'uniform float fade; uniform float lit; uniform float ambient;',
  'varying float vLife;',
  'void main() {',
  '  vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0;',
  '  if (r > 1.0) discard;',
  '  vec3 col = vec3(0.92, 0.9, 0.88) * (0.25 + 0.75 * lit + ambient);',
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade * (1.0 - r) * (1.0 - r) * min(1.0, vLife * 1.6) * 0.5);',
  '}'
].join('\n');

// ── The flight, once, as a table of states every AS_LAUNCH_STEP_S seconds ──
function _asLaunchFlight(azimuthDeg, padZ) {
  var S = AS_SATURN, az = _aeRad(azimuthDeg), ex = Math.sin(az), ey = Math.cos(az), g0 = 9.80665;
  var pos = [0, 0, padZ], vel = [0, 0, 0], rows = [], t = 0, tiltDeg = 0;
  var mass = S.massKg;
  while (t <= AS_LAUNCH_MAX_S) {
    rows.push({ t: t, x: pos[0], y: pos[1], z: pos[2], tilt: _aeRad(tiltDeg), v: Math.hypot(vel[0], vel[1], vel[2]) });
    var alt = Math.max(0, pos[2] - padZ), burning = t < S.cutoffS;
    // The nose: straight up till the tower is clear, then pitched over to the east on the program.
    tiltDeg = t < S.tiltStartS ? 0 : Math.min(S.tiltMaxDeg, S.tiltPerS * Math.pow(t - S.tiltStartS, S.tiltPow));
    var th = _aeRad(tiltDeg), dir = [Math.sin(th) * ex, Math.sin(th) * ey, Math.cos(th)];
    var air = Math.exp(-alt / S.scaleHeightM), thrust = burning ? S.thrustSeaN + (S.thrustVacN - S.thrustSeaN) * (1 - air) : 0;
    var sp = Math.hypot(vel[0], vel[1], vel[2]) || 1e-9, drag = 0.5 * S.rho0 * air * sp * sp * S.dragCd * S.areaM2;
    var g = g0 * Math.pow(6371000 / (6371000 + alt), 2);
    var a = [(thrust * dir[0] - drag * vel[0] / sp) / mass, (thrust * dir[1] - drag * vel[1] / sp) / mass, (thrust * dir[2] - drag * vel[2] / sp) / mass - g];
    // Held on the pad until the thrust beats the weight.
    if (t === 0 && a[2] <= 0) a = [0, 0, 0];
    for (var k = 0; k < 3; k++) { vel[k] += a[k] * AS_LAUNCH_STEP_S; pos[k] += vel[k] * AS_LAUNCH_STEP_S; }
    if (pos[2] < padZ) { pos[2] = padZ; vel[2] = Math.max(0, vel[2]); }
    if (burning) mass -= S.burnKgS * AS_LAUNCH_STEP_S;
    t += AS_LAUNCH_STEP_S;
  }
  return rows;
}
function _asLaunchAt(rows, t) {
  var i = Math.min(rows.length - 2, Math.max(0, Math.floor(t / AS_LAUNCH_STEP_S))), a = rows[i], b = rows[i + 1], f = Math.min(1, Math.max(0, (t - a.t) / AS_LAUNCH_STEP_S));
  var out = {};
  Object.keys(a).forEach(function (k) { out[k] = a[k] + (b[k] - a[k]) * f; });
  return out;
}

// ── Flame and smoke ──
function _asPuffs(st, max, frag, additive) {
  var THREE = _ae.gl.THREE, geo = new THREE.BufferGeometry();
  var P = { pos: new Float32Array(max * 3), vel: new Float32Array(max * 3), size: new Float32Array(max), life: new Float32Array(max), age: new Float32Array(max), maxLife: new Float32Array(max),
    grow: new Float32Array(max), next: 0, geo: geo, max: max };
  for (var i = 0; i < max; i++) P.pos[i * 3 + 2] = -1e6;
  geo.setAttribute('position', new THREE.BufferAttribute(P.pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(P.size, 1));
  geo.setAttribute('life', new THREE.BufferAttribute(P.life, 1));
  var uni = { fade: st.shared.fade, lit: st.shared.lit, ambient: st.shared.ambient, metre: st.shared.metre, pxPerRad: { value: 800 } };
  var mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AS_PUFF_VERT, fragmentShader: frag, transparent: true, depthWrite: false });
  if (additive) { mat.blending = AE_THREE_ADDITIVE; }
  var pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  st.group.add(pts);
  P.uni = uni; P.mesh = pts;
  return P;
}
var AE_THREE_ADDITIVE = 2;   // three's AdditiveBlending
function _asPuffEmit(P, x, y, z, vx, vy, vz, size, grow, life) {
  var i = P.next++ % P.max;
  P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z;
  P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
  P.size[i] = size; P.grow[i] = grow; P.maxLife[i] = life; P.age[i] = 0; P.life[i] = 1;
}
function _asPuffStep(P, dt, drag) {
  for (var i = 0; i < P.max; i++) {
    if (P.life[i] <= 0) continue;
    P.age[i] += dt;
    P.life[i] = 1 - P.age[i] / P.maxLife[i];
    if (P.life[i] <= 0) { P.life[i] = 0; P.pos[i * 3 + 2] = -1e6; continue; }
    var k = Math.exp(-drag * dt);
    P.vel[i * 3] *= k; P.vel[i * 3 + 1] *= k; P.vel[i * 3 + 2] *= k;
    P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
    P.size[i] += P.grow[i] * dt;
  }
  P.geo.attributes.position.needsUpdate = true; P.geo.attributes.size.needsUpdate = true; P.geo.attributes.life.needsUpdate = true;
}

// ── The launch, as the visit sees it ──
function _asLaunchRocket(st) { return st.siteParts.filter(function (p) { return p.model === st.def.launch.model; })[0] || null; }
// Start the count. The camera keeps the bearing it had, no nearer than AS_LAUNCH_WATCH_M, and stands there.
function _asLaunchStart(st) {
  var rocket = _asLaunchRocket(st);
  if (!rocket) return false;
  var L = st.def.launch, was = st.launch;
  if (was) { _asLaunchReset(st); }
  var cur = _asCameraLocal(st, 0).pos, bearing = Math.atan2(cur[1], cur[0]), dist = Math.max(AS_LAUNCH_WATCH_M, Math.hypot(cur[0], cur[1]));
  var vx = dist * Math.cos(bearing), vy = dist * Math.sin(bearing), vz = _asGroundAt(st, vx, vy, false) + 3;
  st.launch = { phase: 'count', t: -AS_LAUNCH_COUNT_S, rows: _asLaunchFlight(L.azimuth || AS_LAUNCH_AZIMUTH_FALLBACK, L.z || 0), rocket: rocket, padZ: L.z || 0, az: _aeRad(L.azimuth || AS_LAUNCH_AZIMUTH_FALLBACK),
    view: [vx, vy, vz], focus: [0, 0, 60], flame: _asPuffs(st, AS_FLAME_MAX, AS_FLAME_FRAG, true), smoke: _asPuffs(st, AS_SMOKE_MAX, AS_SMOKE_FRAG, false), fov: AS_LAUNCH_VIEW_DEG[0], acc: { flame: 0, smoke: 0 }, shake: 0, last: 0 };
  st.camOverride = _asLaunchCamera;
  _asLaunchHud(st);
  return true;
}
function _asLaunchReset(st) {
  var l = st.launch;
  if (!l) return;
  st.group.remove(l.flame.mesh); st.group.remove(l.smoke.mesh);
  l.flame.geo.dispose(); l.smoke.geo.dispose();
  st.launch = null; st.camOverride = null;
  _asPartPlace(st, l.rocket, 0, 0, l.padZ, 0, 0, 0, 0, l.padZ);
}
function _asLaunchCamera(st, dt) {
  var l = st.launch, k = 1 - Math.exp(-3 * dt), r = l.focus;
  var tgt = l.phase === 'fly' || l.phase === 'done' ? l.rocketPos || [0, 0, 60] : [0, 0, 60];
  l.focus = [r[0] + (tgt[0] - r[0]) * k, r[1] + (tgt[1] - r[1]) * k, r[2] + (tgt[2] - r[2]) * k];
  var shake = l.shake > 0 ? AS_LAUNCH_SHAKE.deg * l.shake : 0, jx = shake * (Math.random() - 0.5) * 30, jz = shake * (Math.random() - 0.5) * 30;
  var zoom = _smoothstep(0, AS_LAUNCH_ZOOM_S, Math.max(0, l.t));
  return { pos: l.view, focus: [l.focus[0] + jx, l.focus[1], l.focus[2] + jz], fov: AS_LAUNCH_VIEW_DEG[0] + (AS_LAUNCH_VIEW_DEG[1] - AS_LAUNCH_VIEW_DEG[0]) * zoom };
}
// One frame of the launch: the clock of the flight (faster once the rocket is far), the rocket's place, flame and smoke.
function _asLaunchStep(st, dt) {
  var l = st.launch;
  if (!l) return;
  var warp = l.t > AS_LAUNCH_WARP[0] ? 1 + (AS_LAUNCH_WARP[2] - 1) * _smoothstep(AS_LAUNCH_WARP[0], AS_LAUNCH_WARP[1], l.t) : 1;
  var sd = dt * warp;
  l.t += sd;
  l.shake = l.phase === 'fly' && l.t < AS_LAUNCH_SHAKE.s ? 1 - l.t / AS_LAUNCH_SHAKE.s : 0;
  var rocket = l.rocket, gz = st.shared;
  if (l.phase === 'count' && l.t >= 0) { l.phase = 'fly'; _asLaunchHud(st); }
  var ign = l.phase === 'count' && l.t > -AS_LAUNCH_IGNITION_S, flying = l.phase === 'fly';
  var s = flying ? _asLaunchAt(l.rows, Math.min(l.t, AS_LAUNCH_MAX_S - 0.2)) : { x: 0, y: 0, z: l.padZ, tilt: 0, v: 0, t: 0 };
  if (flying) {
    l.rocketPos = [s.x, s.y, s.z + 30];
    // The nose pitched toward the heading: tilt about the heading's axis; the model's heading turns it to the east.
    _asPartPlace(st, rocket, s.x, s.y, s.z, -l.az, -s.tilt, 0, 0, l.padZ);
    if (l.t > AS_LAUNCH_MAX_S - 1) { l.phase = 'done'; _asLaunchHud(st); }
  }
  _asLaunchPlume(st, l, s, ign || flying, sd, flying);
  _asPuffStep(l.flame, sd, 0.8);
  _asPuffStep(l.smoke, sd, 0.25);
  var pxr = _ae.h / 2 / Math.tan(_aeRad(_ae.gl.camera.fov) / 2);
  l.flame.uni.pxPerRad.value = l.smoke.uni.pxPerRad.value = pxr;
  _asLaunchCount(st, l);
}
// Flame: bright points from the nozzle, longer as the air thins. Smoke: at the pad a cloud thrown out along the ground, then a trail that stays where it was left.
function _asLaunchPlume(st, l, s, on, sd, flying) {
  if (!on) return;
  var alt = Math.max(0, s.z - l.padZ), thin = 1 - Math.exp(-alt / 9000), th = s.tilt, az = l.az;
  var dir = [Math.sin(th) * Math.sin(az), Math.sin(th) * Math.cos(az), Math.cos(th)], base = [s.x - dir[0] * 2, s.y - dir[1] * 2, s.z - dir[2] * 2];
  var power = flying ? 1 : 0.5 + 0.5 * _smoothstep(-AS_LAUNCH_IGNITION_S, 0, l.t);
  l.acc.flame += sd * 190 * power; l.acc.smoke += sd * 15 * power;
  while (l.acc.flame >= 1) {
    l.acc.flame -= 1;
    var life = AS_FLAME_LIFE_S[0] + Math.random() * (AS_FLAME_LIFE_S[1] - AS_FLAME_LIFE_S[0]), speed = 140 + 360 * thin + Math.random() * 60, spread = 14 + 30 * thin;
    _asPuffEmit(l.flame, base[0] + (Math.random() - 0.5) * 8, base[1] + (Math.random() - 0.5) * 8, base[2], -dir[0] * speed + (Math.random() - 0.5) * spread, -dir[1] * speed + (Math.random() - 0.5) * spread, -dir[2] * speed + (Math.random() - 0.5) * spread, 14 + 12 * thin, 22 + 40 * thin, life * (1 + 1.2 * thin));
  }
  while (l.acc.smoke >= 1) {
    l.acc.smoke -= 1;
    var low = alt < 120, life2 = AS_SMOKE_LIFE_S[0] + Math.random() * (AS_SMOKE_LIFE_S[1] - AS_SMOKE_LIFE_S[0]);
    if (low) {
      var a = Math.random() * 6.2832, sp = 25 + Math.random() * 45;
      _asPuffEmit(l.smoke, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, l.padZ + 2 + Math.random() * 8, Math.cos(a) * sp, Math.sin(a) * sp, 2 + Math.random() * 4, 22 + Math.random() * 14, 7 + Math.random() * 4, life2);
    } else {
      _asPuffEmit(l.smoke, base[0] + (Math.random() - 0.5) * 6, base[1] + (Math.random() - 0.5) * 6, base[2], (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, 16 + 8 * (1 - thin), 2.2 + 1.5 * thin, life2);
    }
  }
}
// The count, as figures on the picture: 5 4 3 2 1, nothing after.
function _asLaunchCount(st, l) {
  var el = _aeById('as-count');
  if (!el) return;
  var n = l.phase === 'count' ? Math.ceil(-l.t) : 0, txt = n > 0 && n <= AS_LAUNCH_COUNT_S ? String(n) : '';
  if (el.textContent !== txt) el.textContent = txt;
}
function _asLaunchHud(st) {
  var b = _aeById('as-launch'), l = st.launch;
  if (b) b.hidden = !!l && l.phase !== 'done';
}
