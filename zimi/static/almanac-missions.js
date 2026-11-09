// Missions flown end to end on the 3D view's own clock (almanac-earth.js): a list of them, a player with a timeline of named
// phases you can scrub and jump between, the vehicle drawn with its stages and burns, and a camera that tells each phase
// until a finger takes it over. Loaded the first time a mission is asked for, never with the view.
//
// A mission is data (static/earth/missions-v1.json, built by scripts/build_missions.py from the flight reports and JPL
// Horizons): vehicles, each a set of model parts on one or more legs of a path table, a window it exists in, the phases and the
// events. The path of a leg is [t, x, y, z, vx, vy, vz] (km, km/s, seconds from the mission's zero), cubic Hermite between
// rows, in one frame:
//   ecef   Earth-fixed (the climb from the pad and the fall to the sea: the pad stays under the rocket)
//   eci    Earth-centred, ecliptic J2000 (orbits, the translunar coast); near the Moon corrected onto the Moon as drawn
//   mcmf   Moon-fixed (the descent, the ground, the ascent: the landing site stays under the lander)
//   rel    centred on a planet (ecliptic J2000), `body` names it
//   mfix   fixed to a planet (`body`), for its entry and landing
//   probe  heliocentric, the probes' own tables (space-tracks-v1.json) by `key`
// A leg's rows may carry an up vector (cols 7-9) for the vehicles whose pointing is not along their velocity.

// ── Constants ──
var AM_DATA_URL = '/static/earth/missions-v1.json';
var AM_MRE = 1 / (AE_EARTH_RADIUS_KM * 1000);               // one metre, in Earth radii
var AM_MOON_FIX_NEAR_KM = 40000, AM_MOON_FIX_FAR_KM = 150000;   // the Moon's correction is all the way in by the first, gone by the second
var AM_SEAM_DECAY_S = 600;                                  // a leg that begins off the end of the last one (two models of the Earth's turn) closes the gap over this long
var AM_CAM_EASE = 2.4;                                      // 1/s: the camera's pull to the shot of the phase
var AM_FOV_DEG = 40;
var AM_DOT_PX = 4.5;
var AM_MODEL_PX = [5, 14];                                  // a model fades in across these widths, its dot out
var AM_TEXT_MS = 100;
var AM_SPEEDS = [0.25, 1, 4];                               // the person's pace against the phase's own
var AM_FLAME_SEGS = 14;
var AM_FLAME_COLOR = [1.0, 0.5, 0.12];
var AM_ORBIT_EL = 1.45;                                     // how far over or under the camera may go (radians)
var AM_DRAG_RAD_PX = 0.0065, AM_WHEEL_ZOOM = 0.0015, AM_PINCH_MIN = 0.02;
var AM_DIST_MIN_M = 3;
var AM_NEAR_PER_FOCUS = 0.04;                               // the near plane stands off this share of the way to what is looked at
var AM_END_HOLD_S = 4;
var AM_THREE_ADDITIVE = 2;                                  // three's AdditiveBlending
var AM_THREE_DOUBLE_SIDE = 2;
var AM_STILL_KMS = [0.004, 0.06];                          // below the first speed (km/s) it points up, above the second along its path
var AM_KM_RE = 1 / AE_EARTH_RADIUS_KM;                     // one kilometre, in Earth radii
var AM_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
var AM_CSS_ID = 'am-css';

// Missions in the order of the list. Names are in the interface's languages (alm_ms_<id>).
var AM_LIST = ['apollo11', 'voyager1', 'voyager2'];

var _amData = null, _amLoading = null;

// ── Pure maths (also run by the node tests) ──
function _amHerm(a, b, t) {
  var h = b[0] - a[0], u = h > 0 ? (t - a[0]) / h : 0, u2 = u * u, u3 = u2 * u, hh = h || 1;
  var h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  var d00 = (6 * u2 - 6 * u) / hh, d10 = 3 * u2 - 4 * u + 1, d01 = (-6 * u2 + 6 * u) / hh, d11 = 3 * u2 - 2 * u;
  var p = [0, 0, 0], v = [0, 0, 0];
  for (var k = 0; k < 3; k++) {
    p[k] = h00 * a[1 + k] + h10 * h * a[4 + k] + h01 * b[1 + k] + h11 * h * b[4 + k];
    v[k] = d00 * a[1 + k] + d10 * a[4 + k] + d01 * b[1 + k] + d11 * b[4 + k];
  }
  return { p: p, v: v };
}
// The pair of rows of a table that bracket t.
function _amBracket(s, t) {
  var lo = 0, hi = s.length - 1;
  if (hi < 1) return [s[0], s[0]];
  if (t <= s[0][0]) return [s[0], s[1]];
  if (t >= s[hi][0]) return [s[hi - 1], s[hi]];
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s[mid][0] <= t) lo = mid; else hi = mid; }
  return [s[lo], s[hi]];
}
function _amTable(s, t) {
  var ab = _amBracket(s, t), r = _amHerm(ab[0], ab[1], t);
  if (ab[0].length >= 10) {
    var h = ab[1][0] - ab[0][0], u = h > 0 ? Math.min(1, Math.max(0, (t - ab[0][0]) / h)) : 0;
    r.up = [0, 1, 2].map(function (k) { return ab[0][7 + k] + (ab[1][7 + k] - ab[0][7 + k]) * u; });
  }
  return r;
}
function _amSmooth(a, b, x) { var u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); }
// The mission's phase at time t: the last that began.
function _amPhaseAt(m, t) {
  var at = 0;
  for (var i = 0; i < m.phases.length; i++) if (m.phases[i].t <= t + 1e-6) at = i;
  return at;
}
function _amPhaseEnd(m, i) { return i + 1 < m.phases.length ? m.phases[i + 1].t : m.end; }
// The timeline's position (0..1) of a time, and back: every phase takes a share of the width by its weight, so a minute of landing
// is not lost beside three days of coast.
function _amWidths(m) {
  var w = m.phases.map(function (p) { return Math.max(0.01, p.w || 1); }), sum = w.reduce(function (a, b) { return a + b; }, 0);
  return w.map(function (x) { return x / sum; });
}
function _amPosOf(m, t) {
  var w = _amWidths(m), i = _amPhaseAt(m, t), acc = 0, k;
  for (k = 0; k < i; k++) acc += w[k];
  var t0 = m.phases[i].t, t1 = _amPhaseEnd(m, i);
  return acc + w[i] * Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
}
function _amTimeOf(m, pos) {
  var w = _amWidths(m), acc = 0;
  for (var i = 0; i < w.length; i++) {
    if (pos <= acc + w[i] || i === w.length - 1) {
      var t0 = m.phases[i].t, t1 = _amPhaseEnd(m, i);
      return t0 + (t1 - t0) * Math.min(1, Math.max(0, (pos - acc) / w[i]));
    }
    acc += w[i];
  }
  return m.end;
}
// Mission elapsed time as T+h:mm:ss, with its sign.
function _amMet(t) {
  var neg = t < 0, s = Math.floor(Math.abs(t)), h = Math.floor(s / 3600), mi = Math.floor(s / 60) % 60, sec = s % 60;
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  return (neg ? 'T−' : 'T+') + h + ':' + two(mi) + ':' + two(sec);
}
function _amLegAt(veh, t) {
  var legs = veh.legs;
  for (var i = 0; i < legs.length; i++) if (t <= legs[i].s[legs[i].s.length - 1][0]) return legs[i];
  return legs[legs.length - 1];
}
// The text of a phase or an event: the interface's own if it has one, else the data's English.
function _amLabel(item) {
  var vars = item.planet && typeof _tp === 'function' ? { planet: _tp(item.planet) } : undefined;
  var s = typeof _aeT === 'function' && item.k ? _aeT(item.k, vars) : item.k;
  return s && s !== item.k ? s : item.en;
}

// ── Where a vehicle is, in the scene ──
// A leg's frame this frame: the matrix and centre a body-fixed or body-centred leg is drawn from.
function _amLegFrame(leg, sc) {
  var fr = leg.frame;
  if (fr === 'mcmf') { leg.basis = _ae.gl.moon.matrix.elements; leg.centre = sc.moon; }
  else if (fr === 'mfix' || fr === 'rel') {
    var p = _ae.gl.planets && _ae.gl.planets[leg.body];
    if (!p || !p.pos) { leg.centre = null; return; }
    leg.centre = p.pos; leg.basis = fr === 'mfix' ? p.mesh.matrix.elements : AM_IDENTITY;
  }
}
// A frame's vector (km) into the scene's axes (Earth radii).
function _amAxes(leg, v, sc) {
  var er = AE_EARTH_RADIUS_KM, fr = leg.frame;
  if (fr === 'ecef') return _aeFixedToScene(_aeScale(v, 1 / er), sc.gast);
  if (fr === 'eci' || fr === 'rel') return _aeScale(_ephEclJ2000ToEqOfDate(v, sc.jde), 1 / er);
  var e = leg.basis, q = _aeScale(v, 1 / er);
  return [e[0] * q[0] + e[4] * q[1] + e[8] * q[2], e[1] * q[0] + e[5] * q[1] + e[9] * q[2], e[2] * q[0] + e[6] * q[1] + e[10] * q[2]];
}
// The Moon as drawn against the Moon as the table has it: a craft near the Moon is moved by the difference, so it flies over the
// Moon that is drawn, not a Moon some kilometres off.
function _amMoonShift(M, t, p, sc) {
  var ref = _amTable(M.ref.moon, t), d = _aeLen(_aeSub(p, ref.p)), w = 1 - _amSmooth(AM_MOON_FIX_NEAR_KM, AM_MOON_FIX_FAR_KM, d);
  if (w <= 0) return null;
  var tabled = _aeScale(_ephEclJ2000ToEqOfDate(ref.p, sc.jde), 1 / AE_EARTH_RADIUS_KM);
  return _aeScale(_aeSub(sc.moon, tabled), w);
}
// A leg's scene position and axes-turned velocity at table time t, before any seam.
function _amLegRaw(M, leg, t, sc) {
  var r = _amTable(leg.s, Math.min(leg.s[leg.s.length - 1][0], Math.max(leg.s[0][0], t)));
  _amLegFrame(leg, sc);
  var fr = leg.frame, pos = _amAxes(leg, r.p, sc), vel = _amAxes(leg, r.v, sc);
  if (fr === 'mcmf' || fr === 'mfix' || fr === 'rel') { if (!leg.centre) return null; pos = _aeAdd(pos, leg.centre); }
  else if (fr === 'eci') { var sh = _amMoonShift(M, t, r.p, sc); if (sh) pos = _aeAdd(pos, sh); }
  return { pos: pos, vel: vel, up: r.up ? _amAxes(leg, r.up, sc) : null, km: r };
}
// A vehicle's state at mission time t: scene position, the direction it points and its up, its speed (km/s) in its leg's frame.
// null when it is not there.
function _amVehicleAt(M, veh, t, sc) {
  if (t < veh.on || t > veh.off) return null;
  var leg = _amLegAt(veh, t), raw = leg.frame === 'probe' ? _amProbeRaw(leg) : _amLegRaw(M, leg, t, sc);
  if (!raw) return null;
  var pos = raw.pos;
  if (leg.prev) {   // a leg that begins off the end of the last one closes the gap
    var gone = 1 - _amSmooth(0, 1, (t - leg.s[0][0]) / (leg.sd || AM_SEAM_DECAY_S));
    if (gone > 0) {
      var a = _amLegRaw(M, leg.prev, leg.prev.s[leg.prev.s.length - 1][0], sc), b = _amLegRaw(M, leg, leg.s[0][0], sc);
      if (a && b) pos = _aeAdd(pos, _aeScale(_aeSub(a.pos, b.pos), gone));
    }
  }
  var up = raw.up || _aeSub(pos, leg.ref === 'moon' ? sc.moon : [0, 0, 0]);
  up = _aeLen(up) < 1e-12 ? [0, 0, 1] : _aeNorm(up);
  var fwd = _aeLen(raw.vel) > 1e-12 ? _aeNorm(raw.vel) : up;
  if (leg.att === 'retro') {
    fwd = _aeScale(fwd, -1);
    if (leg.turn) fwd = _aeRotateAbout(fwd, up, Math.PI * _amSmooth(leg.turn[0], leg.turn[1], t));   // turning round to point the engine the other way
  }
  if (leg.att === 'level') {   // a lander, a rover: standing, facing the way it moves over the ground
    var hv = _aeSub(raw.vel, _aeScale(up, _aeDot(raw.vel, up)));
    fwd = _aeLen(hv) > 1e-12 * 0 + 1e-14 ? _aeNorm(hv) : _aeNorm(_aeCross(up, [0, 0, 1]));
  }
  // On the pad, and for the first seconds, nothing yet says which way it points: up.
  if (raw.km && leg.frame === 'ecef') { var go = _amSmooth(AM_STILL_KMS[0], AM_STILL_KMS[1], _aeLen(raw.km.v)); fwd = _aeNorm(_aeAdd(_aeScale(fwd, go), _aeScale(up, 1 - go))); }
  return { pos: pos, fwd: fwd, up: up, speed: raw.km ? _aeLen(raw.km.v) : 0, vehicle: veh, leg: leg, km: raw.km };
}
function _amProbeRaw(leg) {
  var pos = _aeProbePos[leg.key], hd = _aeProbeHeading[leg.key];
  return pos ? { pos: pos, vel: hd || [1, 0, 0], up: null, km: null } : null;
}
// The right-handed basis of a state: x right, y the way it points, z up (the models' own).
function _amBasis(st) {
  var y = st.fwd, z = _aeSub(st.up, _aeScale(y, _aeDot(st.up, y)));
  z = _aeLen(z) < 1e-9 ? _aeCross(y, Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]) : z;
  z = _aeNorm(z);
  return { x: _aeCross(y, z), y: y, z: z };
}
function _amLocal(b, v) {   // a vehicle-frame vector (metres) into the scene (Earth radii)
  return [(b.x[0] * v[0] + b.y[0] * v[1] + b.z[0] * v[2]) * AM_MRE, (b.x[1] * v[0] + b.y[1] * v[1] + b.z[1] * v[2]) * AM_MRE, (b.x[2] * v[0] + b.y[2] * v[1] + b.z[2] * v[2]) * AM_MRE];
}

// A part's place in its vehicle's frame at time t: fixed, or along keyframes ({t, at, rx}: eased between).
function _amPartPose(p, t) {
  var k = p.anim;
  if (!k || !k.length) return { at: p.at, rx: p.rx || 0 };
  if (t <= k[0].t) return { at: k[0].at, rx: k[0].rx || 0 };
  for (var i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      var u = _amSmooth(k[i - 1].t, k[i].t, t), a = k[i - 1].at, b = k[i].at;
      return { at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], rx: (k[i - 1].rx || 0) + ((k[i].rx || 0) - (k[i - 1].rx || 0)) * u };
    }
  }
  var e = k[k.length - 1];
  return { at: e.at, rx: e.rx || 0 };
}
// A vector turned about the vehicle's x axis by deg (y toward z), and a basis turned the same way.
function _amRotX(v, deg) {
  var c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function _amTurnX(b, deg) {
  var c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return { x: b.x, y: _aeAdd(_aeScale(b.y, c), _aeScale(b.z, s)), z: _aeSub(_aeScale(b.z, c), _aeScale(b.y, s)) };
}

// ── Loading ──
function _amLoad(then) {
  if (_amData) { then(); return; }
  if (!_amLoading) {
    _amLoading = fetch(AM_DATA_URL).then(function (r) { if (!r.ok) throw new Error('missions'); return r.json(); }).then(function (d) {
      Object.keys(d.missions).forEach(function (k) { _amPrepare(d.missions[k]); });
      _amData = d;
    }).catch(function () { _amLoading = null; });
  }
  _amLoading.then(function () { if (_amData) then(); });
}
// Links each vehicle's legs to the one before and stands the models it needs in a list.
function _amPrepare(m) {
  m.models = {};
  m.vehicles.forEach(function (v) {
    v.legs.forEach(function (leg, i) { leg.prev = i > 0 && v.legs[i - 1].frame !== leg.frame ? v.legs[i - 1] : null; });
    v.parts.forEach(function (p) { m.models[p.m] = true; });
  });
  m.models = Object.keys(m.models);
}

// ── Models ──
function _amPartMesh(S, key) {
  var d = _aeCraftData(key);
  if (!d) return null;
  var I = _aeCraftBuild(S, key);
  I.data = d;
  I.root.children.forEach(function (c) { if (c.material) c.material.side = AM_THREE_DOUBLE_SIDE; });
  return I;
}
function _amFlameMesh(S) {
  var THREE = S.THREE, n = AM_FLAME_SEGS, pos = [], k = [], idx = [];
  pos.push(0, 0, 0); k.push(0);   // the apex-less base centre
  for (var i = 0; i < n; i++) { var a = i / n * Math.PI * 2; pos.push(Math.cos(a), 0, Math.sin(a)); k.push(0); }
  pos.push(0, -1, 0); k.push(1);
  for (var j = 0; j < n; j++) idx.push(1 + j, 1 + (j + 1) % n, n + 1);
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('k', new THREE.BufferAttribute(new Float32Array(k), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  var mat = new THREE.ShaderMaterial({
    uniforms: { fade: { value: 1 }, hot: { value: new THREE.Vector3(AM_FLAME_COLOR[0], AM_FLAME_COLOR[1], AM_FLAME_COLOR[2]) } },
    vertexShader: 'attribute float k; varying float vK; void main() { vK = k; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float fade; uniform vec3 hot; varying float vK; void main() { vec3 c = mix(vec3(1.0, 0.85, 0.55), hot, smoothstep(0.0, 0.7, vK)); gl_FragColor = vec4(c * (1.0 - vK * 0.6), (1.0 - vK) * (1.0 - vK) * 0.7 * fade); }',
    transparent: true, depthWrite: false, side: AM_THREE_DOUBLE_SIDE
  });
  mat.blending = AM_THREE_ADDITIVE;
  var mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  S.scene.add(mesh);
  return mesh;
}

// ── The state of a mission being played ──
function _amState() { return _ae && _ae.mission; }
function _amMission() { var s = _amState(); return s && _amData ? _amData.missions[s.id] : null; }
function _amNowS() { var s = _amState(); return s ? (_aeDisplayMs() - s.zeroMs) / 1000 : 0; }

// Open a mission by id. The view flies there when it is not yet in the mission's space.
function _aeMissionOpen(id) {
  if (!_ae || !_ae.gl) return;
  if (_ae.site) _aeSiteLeave(true);
  if (typeof _aeTracksLoad === 'function') _aeTracksLoad();   // a probe's flight is drawn from its table
  _amLoad(function () {
    var m = _amData.missions[id];
    if (!m) return;
    if (_ae.mission) _amStop(true);
    m.models.forEach(function (k) { _aeCraftLoad(k); });
    m.vehicles.forEach(function (v) { v.legs.forEach(function (l) { if (l.frame === 'probe' && AE_CRAFT_MODEL[l.key]) _aeCraftLoad(AE_CRAFT_MODEL[l.key]); }); });   // a probe's own model, drawn by the view itself
    var s = _ae.mission = {
      id: id, zeroMs: m.zeroMs, parts: {}, flames: {}, dot: null, speedIdx: 1, userCam: false, phaseIdx: -1,
      camAz: 0, camEl: 0.3, camDist: 100, camSet: false, shot: null, back: { ms: _aeDisplayMs(), rate: typeof _almRate === 'number' ? _almRate : 1, live: !_aeFocusSet() },
      lastText: 0, ended: 0, state: {}, fov: AM_FOV_DEG, pose: null, focus: null, trackAt: -1
    };
    _ae.el.classList.add('ae-mission');
    _aeShowGo(false);
    _amHud(true);
    _amJump(m, m.start);
    _aeKick();
  });
}
function _amStop(quiet) {
  var s = _ae && _ae.mission;
  if (!s) return;
  var S = _ae.gl;
  Object.keys(s.parts).forEach(function (k) { var I = s.parts[k]; if (I.root.parent) I.root.parent.remove(I.root); });
  Object.keys(s.flames).forEach(function (k) { var f = s.flames[k]; if (f.parent) f.parent.remove(f); f.geometry.dispose(); f.material.dispose(); });
  if (s.dot) { if (s.dot.parent) s.dot.parent.remove(s.dot); }
  _ae.mission = null;
  _ae.el.classList.remove('ae-mission');
  _amHud(false);
  if (!quiet) {
    if (s.back.live && typeof _aeNow === 'function') _aeNow(); else if (typeof _aeGoTo === 'function') _aeGoTo(s.back.ms);
    if (typeof _almClockSetRate === 'function') _almClockSetRate(s.back.rate);
    _ae.dirty = true; _aeKick();
  }
}
// Jump to a mission time: the page's clock goes there at the phase's own pace.
function _amJump(m, t, keepCam) {
  var s = _ae.mission;
  if (!s) return;
  var ms = s.zeroMs + t * 1000;
  _aeSettlePage(new Date(ms));
  var i = _amPhaseAt(m, t);
  _amSetRate(m, i);
  if (!keepCam) { s.userCam = false; s.camSet = false; }
  s.phaseIdx = -1;
  _ae.ringsAt = _ae.issRingAt = _ae.moonPathAt = null;
  _ae.dirty = true; _aeKick();
}
function _amRateOf(m, i) { return (m.phases[i].rate || 1) * AM_SPEEDS[_ae.mission.speedIdx]; }
function _amSetRate(m, i) {
  var s = _ae.mission, r = s.paused ? 0 : _amRateOf(m, i);
  if (typeof _almClockSetRate === 'function') _almClockSetRate(r);
}

// ── The frame hooks (almanac-earth.js _aeUpdate) ──
// Before the camera: the time, every vehicle's state, and the camera's pose.
function _aeMissionStep(sc) {
  var s = _ae.mission, m = _amMission();
  if (!s || !m) return;
  var t = (sc.ms - s.zeroMs) / 1000, now = performance.now(), dt = s.last ? Math.min(0.1, (now - s.last) / 1000) : 0.016;
  s.last = now;
  s.t = t;
  var pi = _amPhaseAt(m, Math.max(t, m.phases[0].t));
  if (pi !== s.phaseIdx) { s.phaseIdx = pi; s.camSet = false; if (!s.paused) _amSetRate(m, pi); _amPhaseChanged(m, pi); }
  if (t >= m.end && !s.paused) { s.paused = true; if (typeof _almClockSetRate === 'function') _almClockSetRate(0); _amSyncPlay(); }
  var states = {};
  m.vehicles.forEach(function (v) { var st = _amVehicleAt(m, v, t, sc); if (st) states[v.id] = st; });
  s.state = states;
  var ph = m.phases[pi], follow = states[ph.follow || m.follow] || states[m.follow] || null;
  if (!follow) { var any = Object.keys(states)[0]; follow = any ? states[any] : null; }
  s.follow = follow;
  if (follow) _amCamera(m, s, follow, ph, dt, sc);
  _amHudTick(m, s, follow, t, now);
}
// After the camera (its matrices are this frame's): the models, flames and dots.
function _aeMissionDraw() {
  var s = _ae.mission, m = _amMission();
  if (!s || !m || !s.state) return;
  var S = _ae.gl, cam = S.camera, t = s.t, any = false;
  if (!s.dot) {
    s.dot = _aePointCloud(S.THREE, m.vehicles.length + 2, S.dpr, true, { depthTest: true });
    S.scene.add(s.dot);
  }
  var nDots = 0;
  m.vehicles.forEach(function (v) {
    var st = s.state[v.id], show = 0;
    v.parts.forEach(function (p, pi) {
      var key = v.id + ':' + pi, I = s.parts[key];
      var live = st && (p.from == null || t >= p.from) && (p.to == null || t < p.to);
      if (!live) { if (I) I.root.visible = false; return; }
      if (!I) { I = _amPartMesh(S, p.m); if (!I) return; s.parts[key] = I; }
      var b = _amBasis(st), pa = _amPartPose(p, t), rot = pa.rx;
      var mid = [I.data.mid[0] * I.data.metres, I.data.mid[1] * I.data.metres, I.data.mid[2] * I.data.metres];
      if (rot) mid = _amRotX(mid, rot);
      var at = [pa.at[0] + mid[0], pa.at[1] + mid[1], pa.at[2] + mid[2]];
      var o = _amLocal(b, at), pos = _aeAdd(st.pos, o);
      var bp = rot ? _amTurnX(b, rot) : b;
      var span = Math.max(I.data.span * I.data.metres, 1) * AM_MRE, dist = _aeLen(_aeSub(pos, [cam.position.x, cam.position.y, cam.position.z]));
      var px = span / Math.max(dist, 1e-12) * _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
      var sh = _amSmooth(AM_MODEL_PX[0], AM_MODEL_PX[1], px);
      show = Math.max(show, sh);
      I.root.position.set(pos[0], pos[1], pos[2]);
      var M = new S.THREE.Matrix4().makeBasis(new S.THREE.Vector3(bp.x[0], bp.x[1], bp.x[2]), new S.THREE.Vector3(bp.y[0], bp.y[1], bp.y[2]), new S.THREE.Vector3(bp.z[0], bp.z[1], bp.z[2]));
      I.root.quaternion.setFromRotationMatrix(M);
      I.root.visible = sh > 0;
      if (sh > 0) _aeCraftLight(I, pos, v.ref === 'moon' ? null : _aeNorm(_aeScale(pos, -1)), sh);
    });
    (v.flames || []).forEach(function (f, fi) {
      var key = v.id + '#' + fi, F = s.flames[key], on = st && t >= f.from && t < f.to;
      if (!on) { if (F) F.visible = false; return; }
      if (!F) F = s.flames[key] = _amFlameMesh(S);
      var b = _amBasis(st), vac = 1 + (f.vac || 0) * _amSmooth(0, 1, (st.km ? _aeLen(st.pos) - 1 : 1) * 6378 / (f.vacAlt || 120)), len = f.len * vac * (0.88 + 0.24 * Math.random());
      var pos = _aeAdd(st.pos, _amLocal(b, f.at)), bf = f.rx ? _amTurnX(b, f.rx) : b;
      F.position.set(pos[0], pos[1], pos[2]);
      var Mf = new S.THREE.Matrix4().makeBasis(new S.THREE.Vector3(bf.x[0], bf.x[1], bf.x[2]), new S.THREE.Vector3(bf.y[0], bf.y[1], bf.y[2]), new S.THREE.Vector3(bf.z[0], bf.z[1], bf.z[2]));
      F.quaternion.setFromRotationMatrix(Mf);
      F.scale.set(f.r * AM_MRE, len * AM_MRE, f.r * AM_MRE);
      F.visible = true;
      F.material.uniforms.fade.value = _aeFadeU.value;
      F.updateMatrixWorld();
    });
    if (st && v.dot !== false) {
      _aeSetPoint(s.dot, nDots++, st.pos, [1, 0.82, 0.4], Math.max(0, 1 - show) * _aeFadeU.value, AM_DOT_PX);
    }
  });
  _aeCommitPoints(s.dot, nDots);
}
function _amPhaseChanged(m, pi) {
  var hud = _aeById('am-hud');
  if (hud) hud.dataset.phase = String(pi);
  _amPaintPhase(m, pi);
}

// ── The camera ──
// A phase's shot is relative to the vehicle it follows: a distance (metres), an azimuth about its axis (degrees: 0 from its up
// side, 90 from its right) and how far toward its tail the camera leans (degrees). A hand on the picture takes the camera until a phase is jumped to.
function _amCamera(m, s, st, ph, dt, sc) {
  var shot = ph.cam || { d: 200, az: 150, el: 15 };
  var want = { az: _aeRad(shot.az), el: _aeRad(shot.el), dist: shot.d };
  if (!s.camSet) {
    // A shot begins where the camera is, in this vehicle's frame, so it eases there rather than cutting.
    s.camSet = true;
    if (!s.cam) s.cam = { az: want.az, el: want.el, dist: want.dist };
    s.shot = want;
  }
  if (!s.userCam && !_aeReduceMotion()) {
    var k = 1 - Math.exp(-AM_CAM_EASE * dt);
    s.cam.az += _aeAngleDeltaRad(s.cam.az, s.shot.az) * k;
    s.cam.el += (s.shot.el - s.cam.el) * k;
    s.cam.dist *= Math.pow(s.shot.dist / s.cam.dist, k);
  } else if (!s.userCam) { s.cam.az = s.shot.az; s.cam.el = s.shot.el; s.cam.dist = s.shot.dist; }
  var b = _amBasis(st), c = s.cam, ch = Math.cos(c.el);
  if (shot.body) { _amBodyShot(s, st, shot, c); return; }
  // The shot turns about the vehicle's axis (az 0: from its up side, 90: from its right) and leans toward its tail by el.
  var off = [Math.sin(c.az) * ch * c.dist, -Math.sin(c.el) * c.dist, Math.cos(c.az) * ch * c.dist];
  var pos = _aeAdd(st.pos, _amLocal(b, off));
  var focus = _aeAdd(st.pos, _amLocal(b, shot.look || [0, 0, 0]));
  var look = _aeNorm(_aeSub(focus, pos)), up = st.up;
  up = _aeSub(up, _aeScale(look, _aeDot(up, look)));
  up = _aeLen(up) < 1e-9 ? b.z : _aeNorm(up);
  s.pose = { pos: pos, up: up, look: look, tp: focus, fov: AM_FOV_DEG, nearRe: Math.max(0.2 * AM_MRE, c.dist * AM_MRE * AM_NEAR_PER_FOCUS) };
}
// A shot of a probe against a body it is passing (shot.body: a planet's key; shot.d: metres, shot.mix: how far toward the body the
// camera looks): from beyond the probe, the body behind it, turned about the line between them by az and lifted by el.
function _amBodyShot(s, st, shot, c) {
  var bp = _aeBodyPos(shot.body);
  if (!bp) return;
  var away = _aeNorm(_aeSub(st.pos, bp)), side = _aeCross(away, st.up);
  side = _aeLen(side) < 1e-9 ? _aeCross(away, [0, 0, 1]) : _aeNorm(side);
  var upv = _aeCross(side, away), d = c.dist * AM_MRE;
  var off = _aeAdd(_aeAdd(_aeScale(away, Math.cos(c.el) * Math.cos(c.az) * d), _aeScale(side, Math.cos(c.el) * Math.sin(c.az) * d)), _aeScale(upv, Math.sin(c.el) * d));
  var pos = _aeAdd(st.pos, off), focus = _aeAdd(st.pos, _aeScale(_aeSub(bp, st.pos), shot.mix == null ? 0.5 : shot.mix));
  var look = _aeNorm(_aeSub(focus, pos));
  s.pose = { pos: pos, up: upv, look: look, tp: focus, fov: AM_FOV_DEG, nearRe: Math.max(1e-9, d * AM_NEAR_PER_FOCUS) };
}
function _aeAngleDeltaRad(a, b) { return ((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI; }
// The view's camera description in place of the orbit camera's (almanac-earth.js _aePlaceCamera).
function _aeMissionCam(c) {
  var s = _ae.mission;
  return { tp: s.pose.tp, az: 0, el: 0, dist: 1, tanHalf: Math.tan(_aeRad(s.pose.fov) / 2), roll: 0, frame: null, pose: s.pose };
}
function _aeMissionNear(near) {
  var s = _ae.mission;
  return s && s.pose ? Math.max(1e-10, Math.min(near, s.pose.nearRe)) : near;
}

// ── The interface ──
var AM_ICONS = {
  alt: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V5M6 11l6-6 6 6M5 21h14"/></svg>',
  speed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-6"/></svg>',
  range: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M8 12h8"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  speedBtn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6l6 6-6 6M12 6l6 6-6 6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg>',
  recentre: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',
  burn: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2c4 4 5 8 3 12l-3 6-3-6c-2-4-1-8 3-12z"/></svg>',
  split: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 3l10 18H2z"/></svg>',
  dot: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>'
};
var AM_CSS = [
  '.ae-view.ae-mission .ae-top,.ae-view.ae-mission .ae-bottom,.ae-view.ae-mission .ae-labels,.ae-view.ae-mission .ae-lms,.ae-view.ae-mission .ae-mini,.ae-view.ae-mission .ae-info,.ae-view.ae-mission .ae-set{display:none!important}',
  '.am-hud{position:absolute;inset:0;z-index:50;pointer-events:none;display:none;-webkit-user-select:none;user-select:none}',
  '.ae-view.ae-mission .am-hud{display:block}',
  '.am-layer{position:absolute;inset:0;pointer-events:auto;touch-action:none}',
  '.am-bar{position:absolute;top:calc(env(safe-area-inset-top) + 12px);inset-inline:12px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;pointer-events:none}',
  '.am-bar>*{pointer-events:auto}',
  '.am-title{flex:1;min-width:0;padding:6px 12px;border-radius:12px;background:rgba(14,14,16,.7);border:1px solid var(--border);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:var(--text2);font-size:12px;line-height:1.35;pointer-events:none}',
  '.am-title b{display:block;color:var(--text);font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.am-met{font-variant-numeric:tabular-nums;letter-spacing:.02em}',
  '.am-read{display:flex;gap:6px;pointer-events:none}',
  '.am-read span{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:10px;background:rgba(14,14,16,.7);border:1px solid var(--border);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-size:13px;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.am-read svg{color:var(--amber);flex:none}',
  '.am-read-wrap{position:absolute;top:calc(env(safe-area-inset-top) + 68px);inset-inline:12px;display:flex;flex-wrap:wrap;gap:6px}',
  '.am-dock{position:absolute;inset-inline:0;bottom:0;padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(to top,rgba(0,0,0,.72),rgba(0,0,0,0));pointer-events:none}',
  '.am-dock>*{pointer-events:auto}',
  '.am-phase{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 6px;color:var(--text)}',
  '.am-phase-t{flex:1;min-width:0;text-align:center}',
  '.am-phase-t b{display:block;font-size:17px;font-weight:600;text-shadow:0 1px 8px rgba(0,0,0,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.am-phase-t span{font-size:12px;color:var(--text2)}',
  '.am-track{position:relative;display:flex;gap:2px;height:30px;touch-action:none;cursor:pointer}',
  '.am-seg{position:relative;flex:1 1 0;min-width:0;border-radius:4px;background:rgba(255,255,255,.14);overflow:hidden}',
  '.am-seg i{position:absolute;inset:0 auto 0 0;background:var(--amber);opacity:.85;width:0}',
  '.am-seg[data-on="1"]{background:rgba(255,255,255,.26)}',
  '.am-thumb{position:absolute;top:-3px;bottom:-3px;width:3px;margin-left:-1.5px;border-radius:2px;background:#fff;box-shadow:0 0 6px rgba(0,0,0,.6);pointer-events:none}',
  '.am-ev{display:flex;gap:6px;overflow-x:auto;margin:8px -12px 0;padding:0 12px 2px;scrollbar-width:none}',
  '.am-ev::-webkit-scrollbar{display:none}',
  '.am-chip{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(14,14,16,.72);border:1px solid var(--border);color:var(--text2);font-size:12px;white-space:nowrap;cursor:pointer}',
  '.am-chip svg{color:var(--amber)}',
  '.am-chip[data-near="1"]{color:var(--text);border-color:var(--amber-border)}',
  '.am-ctl{display:flex;align-items:center;gap:8px;margin-top:8px}',
  '.am-ctl .am-gap{flex:1}',
  '.am-rate{font-size:12px;min-width:44px;font-variant-numeric:tabular-nums}'
].join('');
function _amHud(on) {
  var el = _ae && _ae.el;
  if (!el) return;
  var hud = _aeById('am-hud');
  if (!on) { if (hud) hud.remove(); return; }
  if (!document.getElementById(AM_CSS_ID)) { var css = document.createElement('style'); css.id = AM_CSS_ID; css.textContent = AM_CSS; document.head.appendChild(css); }
  if (hud) hud.remove();
  var m = _amMission(), s = _ae.mission;
  hud = document.createElement('div');
  hud.className = 'am-hud'; hud.id = 'am-hud';
  var lab = function (k) { return _almEsc(_aeT(k)); };
  var w = _amWidths(m);
  hud.innerHTML = '<div class="am-layer" id="am-layer"></div>' +
    '<div class="am-bar"><button type="button" class="ae-btn ae-round" id="am-exit" aria-label="' + lab('alm_ms_close') + '" title="' + lab('alm_ms_close') + '">' + AM_ICONS.close + '</button>' +
    '<div class="am-title"><b>' + _almEsc(_aeT('alm_ms_' + s.id) === 'alm_ms_' + s.id ? m.name : _aeT('alm_ms_' + s.id)) + '</b><span class="am-met" id="am-met"></span></div>' +
    '<button type="button" class="ae-btn ae-round" id="am-recentre" aria-label="' + lab('alm_ms_recentre') + '" title="' + lab('alm_ms_recentre') + '">' + AM_ICONS.recentre + '</button></div>' +
    '<div class="am-read-wrap"><div class="am-read"><span id="am-alt">' + AM_ICONS.alt + '<b></b></span><span id="am-speed">' + AM_ICONS.speed + '<b></b></span><span id="am-range">' + AM_ICONS.range + '<b></b></span></div></div>' +
    '<div class="am-dock"><div class="am-phase"><button type="button" class="ae-btn ae-round" id="am-prev" aria-label="' + lab('alm_ms_prev') + '">' + AM_ICONS.prev + '</button><div class="am-phase-t"><b id="am-phase-name"></b><span id="am-phase-sub"></span></div><button type="button" class="ae-btn ae-round" id="am-next" aria-label="' + lab('alm_ms_next') + '">' + AM_ICONS.next + '</button></div>' +
    '<div class="am-track" id="am-track">' + m.phases.map(function (p, i) { return '<div class="am-seg" data-i="' + i + '" style="flex-grow:' + (w[i] * 1000).toFixed(1) + '"><i></i></div>'; }).join('') + '<div class="am-thumb" id="am-thumb"></div></div>' +
    '<div class="am-ev" id="am-ev"></div>' +
    '<div class="am-ctl"><button type="button" class="ae-btn ae-round" id="am-play" aria-label="' + lab('alm_ms_play') + '">' + AM_ICONS.pause + '</button><button type="button" class="ae-btn ae-round am-rate" id="am-speedbtn" aria-label="' + lab('alm_ms_pace') + '"></button></div></div>';
  el.appendChild(hud);
  _amBind(hud, m);
  _amSyncPlay();
}
function _amSyncPlay() {
  var s = _ae.mission, b = _aeById('am-play'), r = _aeById('am-speedbtn');
  if (b) b.innerHTML = s.paused ? AM_ICONS.play : AM_ICONS.pause;
  if (r) r.textContent = '×' + AM_SPEEDS[s.speedIdx];
}
function _amBind(hud, m) {
  var s = _ae.mission;
  _aeById('am-exit').onclick = function () { _amStop(false); };
  _aeById('am-recentre').onclick = function () { s.userCam = false; s.camSet = false; _ae.dirty = true; _aeKick(); };
  _aeById('am-play').onclick = function () {
    s.paused = !s.paused;
    if (!s.paused && s.t >= m.end) _amJump(m, m.start);
    _amSetRate(m, Math.max(0, s.phaseIdx));
    _amSyncPlay();
  };
  _aeById('am-speedbtn').onclick = function () { s.speedIdx = (s.speedIdx + 1) % AM_SPEEDS.length; _amSetRate(m, Math.max(0, s.phaseIdx)); _amSyncPlay(); };
  // The timeline: a press on a phase's tab goes to its start; dragging along the track scrubs.
  var track = _aeById('am-track'), drag = null;
  var scrubTo = function (e) {
    var r = track.getBoundingClientRect(), pos = _aeClamp((e.clientX - r.left) / r.width, 0, 1);
    var t = _amTimeOf(m, pos);
    s.paused = true; _amSyncPlay();
    if (typeof _almClockNudge === 'function') _almClockNudge(new Date(s.zeroMs + t * 1000));
    if (typeof _almClockSetRate === 'function') _almClockSetRate(0);
    _ae.dirty = true; _aeKick();
  };
  track.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, moved: false, id: e.pointerId }; track.setPointerCapture(e.pointerId); });
  track.addEventListener('pointermove', function (e) { if (!drag) return; if (Math.abs(e.clientX - drag.x) > 5) drag.moved = true; if (drag.moved) scrubTo(e); });
  track.addEventListener('pointerup', function (e) {
    if (!drag) return;
    if (!drag.moved) {
      var seg = document.elementFromPoint(e.clientX, e.clientY), i = seg && seg.closest ? seg.closest('.am-seg') : null;
      if (i) { s.paused = false; _amJump(m, m.phases[+i.getAttribute('data-i')].t); _amSyncPlay(); }
    }
    drag = null;
  });
  var step = function (d) {
    var i = _aeClamp(Math.max(0, s.phaseIdx) + d, 0, m.phases.length - 1);
    s.paused = false; _amJump(m, m.phases[i].t); _amSyncPlay();
  };
  _aeById('am-prev').onclick = function () { step(-1); };
  _aeById('am-next').onclick = function () { step(1); };
  _aeById('am-ev').addEventListener('click', function (e) {
    var c = e.target.closest ? e.target.closest('[data-t]') : null;
    if (c) { s.paused = false; _amJump(m, +c.getAttribute('data-t') - 2, true); _amSyncPlay(); }
  });
  // The picture: a drag turns the camera round the vehicle, a pinch or the wheel brings it nearer.
  var layer = _aeById('am-layer'), ptrs = {}, last = null;
  var take = function () { s.userCam = true; };
  layer.addEventListener('pointerdown', function (e) { ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; layer.setPointerCapture(e.pointerId); last = null; });
  layer.addEventListener('pointermove', function (e) {
    var p = ptrs[e.pointerId];
    if (!p || !s.cam) return;
    var ids = Object.keys(ptrs);
    if (ids.length === 1) {
      take();
      s.cam.az += (e.clientX - p.x) * AM_DRAG_RAD_PX;
      s.cam.el = _aeClamp(s.cam.el + (e.clientY - p.y) * AM_DRAG_RAD_PX, -AM_ORBIT_EL, AM_ORBIT_EL);
    } else if (ids.length === 2) {
      var o = ptrs[ids.filter(function (k) { return +k !== e.pointerId; })[0]], before = Math.hypot(p.x - o.x, p.y - o.y), after = Math.hypot(e.clientX - o.x, e.clientY - o.y);
      if (before > 4 && after > 4) { take(); s.cam.dist = _amClampDist(s.cam.dist * before / after); }
    }
    p.x = e.clientX; p.y = e.clientY;
    _ae.dirty = true; _aeKick();
  });
  var up = function (e) { delete ptrs[e.pointerId]; };
  layer.addEventListener('pointerup', up); layer.addEventListener('pointercancel', up);
  layer.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!s.cam) return;
    take();
    s.cam.dist = _amClampDist(s.cam.dist * Math.exp(e.deltaY * AM_WHEEL_ZOOM));
    _ae.dirty = true; _aeKick();
  }, { passive: false });
}
function _amClampDist(d) { return Math.max(AM_DIST_MIN_M, Math.min(d, 4e9)); }

// The text that moves with the clock: elapsed time, the phase's name and where along it, the readouts, the timeline.
function _amHudTick(m, s, st, t, now) {
  var thumb = _aeById('am-thumb'), track = _aeById('am-track');
  if (thumb && track) thumb.style.left = (_amPosOf(m, Math.max(m.start, Math.min(t, m.end))) * 100).toFixed(2) + '%';
  if (now - s.lastText < AM_TEXT_MS) return;
  s.lastText = now;
  var met = _aeById('am-met'); if (met) met.textContent = _amMet(t);
  _amPaintProgress(m, t);
  var rd = _amReadings(m, st, t, m.phases[Math.max(0, s.phaseIdx)]);
  var set = function (id, txt) {
    var e = _aeById(id);
    if (!e) return;
    e.hidden = txt === null;
    if (txt !== null && e.lastChild && e.lastChild.textContent !== txt) e.lastChild.textContent = txt;
  };
  set('am-alt', rd.alt === null ? null : rd.altAu ? _aeAuText(rd.alt) : _aeLenText(Math.max(0, rd.alt), rd.alt < 100 ? 1 : 0));
  set('am-speed', rd.speed === null ? null : _aeSpeedText(rd.speed, rd.speed < 1 ? 3 : 2));
  set('am-range', rd.far === null ? null : _aeFarText(rd.far));
}
// The three figures of the picture: how high over the body the phase reads against, how fast, how far from home.
var AM_AU_KM = 149597870.7, AM_AU_DAY_KMS = AM_AU_KM / 86400;
function _amReadings(m, st, t, ph) {
  var out = { alt: null, speed: null, far: null, altAu: false };
  if (!st) return out;
  if (st.leg.frame === 'probe') {   // a probe on its own table: its distance from the Sun, its speed, and how far the Earth is
    var tr = _aeTracks && _aeTracks.tracks[st.leg.key], jd = _ae.scene.jd;
    if (!tr) return out;
    var h = _aeTrackAt(tr, jd), e = _ephBodyJ2000('Earth', jd), h2 = _aeTrackAt(tr, jd + 0.01), h1 = _aeTrackAt(tr, jd - 0.01);
    if (!h) return out;
    out.alt = _aeLen(h); out.altAu = true;
    out.speed = h1 && h2 ? _aeLen(_aeSub(h2, h1)) / 0.02 * AM_AU_DAY_KMS : null;
    out.far = _aeLen(_aeSub(h, e)) * AM_AU_KM;
    return out;
  }
  var km = st.km, p = km.p, ref = ph.ref || 'earth', fr = st.leg.frame, moon = _amTable(m.ref.moon, t);
  if (fr === 'ecef') { out.alt = _aeLen(p) - _amEarthR(p); out.speed = _aeLen(km.v); out.far = _aeLen(moon.p); }
  else if (fr === 'eci') {
    var rel = ref === 'moon' ? _aeSub(p, moon.p) : p;
    out.alt = _aeLen(rel) - (ref === 'moon' ? AE_MOON_RADIUS_KM : AE_EARTH_RADIUS_KM);
    out.speed = _aeLen(ref === 'moon' ? _aeSub(km.v, moon.v) : km.v);
    out.far = ref === 'moon' ? _aeLen(moon.p) : _aeLen(_aeSub(p, moon.p));
  } else if (fr === 'mcmf') { out.alt = _aeLen(p) - AE_MOON_RADIUS_KM; out.speed = _aeLen(km.v); out.far = _aeLen(moon.p); }
  else {   // a planet's: its radius from the view's own table
    var b = _aePlanetBody(st.leg.body);
    out.alt = _aeLen(p) - (b ? b.km : 0); out.speed = _aeLen(km.v);
  }
  if (ph.far === false) out.far = null;
  if (ph.alt === false) out.alt = null;
  return out;
}
function _amEarthR(p) { return AE_EARTH_RADIUS_KM * (1 - AE_EARTH_FLATTENING * Math.pow(p[2] / (_aeLen(p) || 1), 2)); }
function _amEarthDistKm(m, t, sc) { return _aeLen(_amTable(m.ref.moon, t).p); }
function _amPaintPhase(m, pi) {
  var ph = m.phases[pi];
  var n = _aeById('am-phase-name'); if (n) n.textContent = _amLabel(ph);
  var sub = _aeById('am-phase-sub'); if (sub) sub.textContent = ph.dist ? _aeFmtDate(m.zeroMs + ph.at * 1000) + ' \u00b7 ' + _aeFarText(ph.dist) : '';
  var segs = document.querySelectorAll('#am-track .am-seg');
  for (var i = 0; i < segs.length; i++) segs[i].dataset.on = i === pi ? '1' : '0';
  var t0 = ph.t, t1 = _amPhaseEnd(m, pi), ev = _aeById('am-ev');
  if (ev) {
    ev.innerHTML = m.events.filter(function (e) { return e.t >= t0 - 1e-6 && e.t < t1 - 1e-6; }).map(function (e) {
      return '<button type="button" class="am-chip" data-t="' + e.t + '">' + (AM_ICONS[e.icon || 'dot'] || AM_ICONS.dot) + '<span>' + _almEsc(_amLabel(e)) + '</span></button>';
    }).join('');
  }
}
// Progress through the phases: each segment fills as the time passes through it.
function _amPaintProgress(m, t) {
  var segs = document.querySelectorAll('#am-track .am-seg i');
  for (var i = 0; i < segs.length; i++) {
    var a = m.phases[i].t, b = _amPhaseEnd(m, i);
    segs[i].style.width = (100 * _aeClamp((t - a) / (b - a), 0, 1)) + '%';
  }
}

// For the tests: the mission advanced by seconds of its own time, the frame drawn.
function _aeMissionAdvance(seconds) {
  var s = _ae && _ae.mission, m = _amMission();
  if (!s || !m) return;
  _amJump(m, s.t + seconds, true);
}
