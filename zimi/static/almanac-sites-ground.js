// The ground a site stands on and what stands on it (almanac-sites.js): the height of the ground at any place (swell,
// craters, the body's curve), the shaders that light it by the Sun's real direction, the patch of ground itself, the
// rocks, and the models placed on it with the shadows they throw. Loaded with almanac-sites.js.

// ── Noise and ground (the one height every wheel, rock and vertex reads) ──
function _asHash(ix, iy, seed) {
  var h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function _asValueNoise(x, y, seed) {
  var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  var a = _asHash(ix, iy, seed), b = _asHash(ix + 1, iy, seed), c = _asHash(ix, iy + 1, seed), d = _asHash(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
// The shallow bowls and low rims of old craters, one to a cell of AS_CRATER_CELL_M, in the cell and its neighbours.
function _asCraters(x, y, density) {
  if (!density) return 0;
  var cx = Math.floor(x / AS_CRATER_CELL_M), cy = Math.floor(y / AS_CRATER_CELL_M), z = 0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      var ix = cx + i, iy = cy + j;
      if (_asHash(ix, iy, 11) > 0.55 * density) continue;
      var px = (ix + _asHash(ix, iy, 12)) * AS_CRATER_CELL_M, py = (iy + _asHash(ix, iy, 13)) * AS_CRATER_CELL_M;
      var r = 4 + 12 * Math.pow(_asHash(ix, iy, 14), 2), t = Math.hypot(x - px, y - py) / r;
      if (t > 1.6) continue;
      var depth = 0.16 * r;
      z += t < 1 ? -depth * (1 - t * t) * (1 - t * t) : 0.22 * depth * Math.exp(-Math.pow((t - 1) * 4, 2));
    }
  }
  return z;
}
// The body's own height at a place of the site (metres up from the tangent plane): the swell and craters of the
// ground, level at the lander, and the curve of the body away from the site. The stand lane's terrain, when it is
// there, adds its own relief over this.
function _asGroundAt(st, x, y, far) {
  if (st.terrainHere) return st.terrainHere(x, y, far);   // Stand here's ground, when this body has one (almanac-standhost.js): the one height everything reads
  var r2 = x * x + y * y, info = st.info;
  var h = -r2 / (2 * st.radiusM);
  var fade = _smoothstep(st.flatFrom || AS_FLAT_FROM_M, st.flatTo || AS_FLAT_TO_M, Math.sqrt(r2));
  if (fade > 0) {
    var rel = (_asValueNoise(x / 31, y / 31, 3) - 0.5) * 2.2 + (_asValueNoise(x / 9.7, y / 9.7, 5) - 0.5) * 0.7;
    if (!far) rel += (_asValueNoise(x / 3.1, y / 3.1, 7) - 0.5) * 0.18 + _asCraters(x, y, info.craters) * 1.0;
    h += rel * info.relief * fade;
  }
  if (st.terrain) h += st.terrain(x, y);
  return h;
}
// The stand lane's terrain (a function of lat/lon, m above the reference radius), as a function of the local frame
// relative to the site's own height: absent, the ground is the procedural one alone.
function _asTerrainFn(st) {
  if (typeof _aeGroundHeight !== 'function') return null;
  if (typeof _aeTerrainLocal === 'function' && typeof _aeStandable === 'function' && _aeStandable(st.body)) {
    // The ground of Stand here, levelled round the lander as the site's own was: the height at a local place, the body's curve in it.
    var h0 = _aeTerrainHeight(st.body, st.lat, st.lon, 0).h, lod = function (x, y, far) { return far ? Math.hypot(x, y) * AS_TERRAIN_LOD_PER_M : 0; };
    st.terrainHere = function (x, y, far) { return _aeTerrainLocal(st.body, st.lat, st.lon, h0, x, y, lod(x, y, far), [st.flatFrom || AS_FLAT_FROM_M, st.flatTo || AS_FLAT_TO_M]); };
    return null;
  }
  var lat0 = st.lat, lon0 = st.lon, R = st.radiusM, cosLat = Math.max(0.05, Math.cos(_aeRad(lat0)));
  var at = function (x, y) { return _aeGroundHeight(st.body, lat0 + _aeDeg(y / R), lon0 + _aeDeg(x / (R * cosLat))) || 0; };
  var base = at(0, 0);
  return function (x, y) { return at(x, y) - base; };
}

// ── Shaders ──
var AS_GROUND_NOISE = [
  'float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
  'float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
  '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }',
  // The ground's grain: pebbles near, swell far; each octave fades before it would shimmer.
  'vec3 groundAlbedo(vec2 q, float dist, vec3 base) {',
  '  float g = 0.5 * vn(q * 0.35);',
  '  if (dist < 600.0) g += 0.25 * vn(q * 1.7) * (1.0 - smoothstep(120.0, 600.0, dist));',
  '  if (dist < 140.0) g += 0.25 * vn(q * 7.0) * (1.0 - smoothstep(25.0, 140.0, dist));',
  '  if (dist < 35.0) g += 0.18 * vn(q * 31.0) * (1.0 - smoothstep(6.0, 35.0, dist));',
  '  return base * (0.62 + 0.75 * g);',
  '}'
].join('\n');
var AS_GROUND_VERT = [
  'uniform float metre;',
  'varying vec3 vP; varying vec3 vN; varying float vDist;',
  'void main() {',
  '  vP = position; vN = normal;',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  vDist = length(mv.xyz) / metre;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
// Lit by the Sun in the site's own frame; `fade` is the view's own (the hero hand-in), `tint` darkens a wheel's track.
var AS_GROUND_FRAG = [
  'uniform vec3 sun; uniform float lit; uniform vec3 albedo; uniform float ambient; uniform float fade; uniform float tint; uniform vec3 haze;',
  'varying vec3 vP; varying vec3 vN; varying float vDist;',
  AS_GROUND_NOISE,
  'void main() {',
  '  vec3 n = normalize(vN);',
  '  float d = max(dot(n, sun), 0.0) * lit;',
  '  vec3 col = groundAlbedo(vP.xy, vDist, albedo) * tint * (d + ambient);',
  '  col = mix(col, haze * (0.15 + 0.85 * lit), smoothstep(2000.0, 20000.0, vDist) * step(0.001, dot(haze, haze)));',
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade);',
  '}'
].join('\n');
// A shadow: the model's own triangles flattened along the Sun onto the ground, painted as the ground without the
// Sun, so overlapping triangles never darken twice.
var AS_SHADOW_VERT = [
  'uniform mat4 model; uniform vec3 sun; uniform float ground; uniform float lift; uniform float metre;',
  'varying vec3 vP; varying float vDist;',
  'void main() {',
  '  vec3 p = (model * vec4(position, 1.0)).xyz;',
  '  float k = max(p.z - ground, 0.0) / sun.z;',
  '  p -= sun * k;',
  '  p.z = ground + lift;',
  '  vP = p;',
  '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
  '  vDist = length(mv.xyz) / metre;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var AS_SHADOW_FRAG = [
  'uniform vec3 albedo; uniform float ambient; uniform float fade; uniform vec3 haze;',
  'varying vec3 vP; varying float vDist;',
  AS_GROUND_NOISE,
  'void main() {',
  '  vec3 col = groundAlbedo(vP.xy, vDist, albedo) * ambient;',
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade);',
  '}'
].join('\n');
var AS_ROCK_VERT = [
  'attribute float tone;',
  'uniform float metre;',
  'varying vec3 vP; varying float vTone; varying float vDist;',
  'void main() {',
  '  vP = position; vTone = tone;',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  vDist = length(mv.xyz) / metre;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');
var AS_ROCK_FRAG = [
  'uniform vec3 sun; uniform float lit; uniform vec3 albedo; uniform float ambient; uniform float fade;',
  'varying vec3 vP; varying float vTone; varying float vDist;',
  'void main() {',
  '  vec3 n = normalize(cross(dFdx(vP), dFdy(vP)));',
  '  if (n.z < 0.0) n = -n;',
  '  float d = max(dot(n, sun), 0.0) * lit;',
  '  vec3 col = albedo * vTone * (d + ambient);',
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade);',
  '}'
].join('\n');
// An atmosphere's sky: a colour from the Sun's height, the horizon's brighter than overhead. Drawn first, the rest over it.
var AS_SKY_VERT = [
  'varying vec3 vDir;',
  'void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
].join('\n');
var AS_SKY_FRAG = [
  'uniform vec3 day; uniform vec3 high; uniform vec3 dusk; uniform float sunZ; uniform float fade;',
  'varying vec3 vDir;',
  'void main() {',
  '  float up = clamp(normalize(vDir).z, 0.0, 1.0);',
  '  float lightness = smoothstep(-0.12, 0.25, sunZ);',
  '  vec3 col = mix(day, high, pow(up, 0.55));',
  '  col = mix(dusk * 0.4, col, lightness);',
  '  col *= 0.05 + 0.95 * smoothstep(-0.25, 0.1, sunZ);',
  '  gl_FragColor = vec4(sqrt(col), fade);',
  '}'
].join('\n');

// ── The scene: a group in the site's frame, built when the first frame of a visit needs it ──
function _asGroupBuild(st) {
  var S = _ae.gl, THREE = S.THREE, info = st.info;
  var grp = new THREE.Group();
  grp.matrixAutoUpdate = false;
  grp.frustumCulled = false;
  S.scene.add(grp);
  var shared = {
    sun: { value: new THREE.Vector3(0, 0, 1) }, lit: { value: 1 }, ambient: { value: info.ambient }, fade: { value: 1 },
    albedo: { value: new THREE.Vector3(info.albedo[0], info.albedo[1], info.albedo[2]) }, metre: { value: AS_MRE }
  };
  st.shared = shared;
  st.group = grp;
  // The ground: rings spaced growing outward (fine at your feet, a long reach to the horizon), turned about the middle.
  var nv = (AS_PATCH_RINGS + 1) * AS_PATCH_SEGS, geo = new THREE.BufferGeometry();
  st.ringR = [];
  var g = Math.pow(AS_PATCH_R_M / AS_PATCH_R0_M, 1 / AS_PATCH_RINGS);
  for (var i = 0; i <= AS_PATCH_RINGS; i++) st.ringR.push(i === 0 ? 0 : AS_PATCH_R0_M * Math.pow(g, i - 1) * (i === 1 ? 1 : 1));
  st.ringR[AS_PATCH_RINGS] = AS_PATCH_R_M;
  st.gpos = new Float32Array(nv * 3); st.gnor = new Float32Array(nv * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(st.gpos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(st.gnor, 3));
  var idx = [];
  for (var r = 0; r < AS_PATCH_RINGS; r++) {
    for (var s = 0; s < AS_PATCH_SEGS; s++) {
      var a = r * AS_PATCH_SEGS + s, b = r * AS_PATCH_SEGS + (s + 1) % AS_PATCH_SEGS, c = a + AS_PATCH_SEGS, d = b + AS_PATCH_SEGS;
      idx.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  st.groundGeo = geo;
  var uni = { sun: shared.sun, lit: shared.lit, albedo: shared.albedo, ambient: shared.ambient, fade: shared.fade, tint: { value: 1 }, haze: { value: new THREE.Vector3(info.haze ? info.haze[0] : 0, info.haze ? info.haze[1] : 0, info.haze ? info.haze[2] : 0) }, metre: shared.metre };
  st.groundUni = uni;
  var ground = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AS_GROUND_VERT, fragmentShader: AS_GROUND_FRAG }));
  ground.frustumCulled = false;
  grp.add(ground);
  st.ground = ground;
  st.cx = st.cy = 1e9;   // forces the first build
  // Rocks: one merged mesh, rebuilt with the ground.
  st.rockGeo = new THREE.BufferGeometry();
  st.rockPos = new Float32Array(AS_ROCK_MAX * 12 * 3); st.rockTone = new Float32Array(AS_ROCK_MAX * 12);
  st.rockGeo.setAttribute('position', new THREE.BufferAttribute(st.rockPos, 3));
  st.rockGeo.setAttribute('tone', new THREE.BufferAttribute(st.rockTone, 1));
  var rIdx = new Uint16Array(AS_ROCK_MAX * 20 * 3);
  for (var k = 0; k < AS_ROCK_MAX; k++) for (var t = 0; t < 20; t++) for (var v = 0; v < 3; v++) rIdx[(k * 20 + t) * 3 + v] = k * 12 + AS_ICO_F[t * 3 + v];
  st.rockGeo.setIndex(new THREE.BufferAttribute(rIdx, 1));
  st.rockGeo.setDrawRange(0, 0);
  var rocks = new THREE.Mesh(st.rockGeo, new THREE.ShaderMaterial({ uniforms: { sun: shared.sun, lit: shared.lit, albedo: { value: new THREE.Vector3(info.albedo[0] * 0.8, info.albedo[1] * 0.8, info.albedo[2] * 0.8) },
    ambient: shared.ambient, fade: shared.fade, metre: shared.metre }, vertexShader: AS_ROCK_VERT, fragmentShader: AS_ROCK_FRAG }));
  rocks.frustumCulled = false;
  grp.add(rocks);
  st.rocks = rocks;
  // An atmosphere's sky, when the body has one.
  if (info.sky) {
    var sk = info.sky;
    st.skyUni = { day: { value: new THREE.Vector3(sk.day[0], sk.day[1], sk.day[2]) }, high: { value: new THREE.Vector3(sk.high[0], sk.high[1], sk.high[2]) },
      dusk: { value: new THREE.Vector3(sk.dusk[0], sk.dusk[1], sk.dusk[2]) }, sunZ: { value: 1 }, fade: shared.fade };
    var domeGeo = new THREE.SphereGeometry(1, 24, 12);
    domeGeo.rotateX(Math.PI / 2);
    var dome = new THREE.Mesh(domeGeo, new THREE.ShaderMaterial({ uniforms: st.skyUni, vertexShader: AS_SKY_VERT, fragmentShader: AS_SKY_FRAG,
      side: AE_THREE_BACK_SIDE, depthWrite: false, depthTest: false }));
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    dome.matrixAutoUpdate = false;
    st.dome = dome;
    S.scene.add(dome);
  }
  st.parts = [];
  st.models = {};
  st.tracks = null;
}
var AE_THREE_BACK_SIDE = 1;
// The 12 corners and 20 faces of the icosahedron a rock is made from.
var AS_ICO_T = (1 + Math.sqrt(5)) / 2;
var AS_ICO_V = [[-1, AS_ICO_T, 0], [1, AS_ICO_T, 0], [-1, -AS_ICO_T, 0], [1, -AS_ICO_T, 0], [0, -1, AS_ICO_T], [0, 1, AS_ICO_T],
  [0, -1, -AS_ICO_T], [0, 1, -AS_ICO_T], [AS_ICO_T, 0, -1], [AS_ICO_T, 0, 1], [-AS_ICO_T, 0, -1], [-AS_ICO_T, 0, 1]].map(function (v) { var l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
var AS_ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];

// What stands on the ground now (the site's own parts and the rover's); rebuilt around a new middle when the view moves off.
function _asRebuildGround(st, cx, cy) {
  st.cx = cx; st.cy = cy;
  var pos = st.gpos, nor = st.gnor, nr = AS_PATCH_RINGS + 1, ns = AS_PATCH_SEGS, i, s;
  for (i = 0; i < nr; i++) {
    var r = st.ringR[i], far = r > AS_PATCH_NEAR_RINGS_M;
    for (s = 0; s < ns; s++) {
      var a = s / ns * 2 * Math.PI, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a), o = (i * ns + s) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = _asGroundAt(st, x, y, far);
    }
  }
  // Normals from the neighbours in the grid: along the ring and across it.
  for (i = 0; i < nr; i++) {
    for (s = 0; s < ns; s++) {
      var o2 = (i * ns + s) * 3, ip = Math.min(nr - 1, i + 1), im = Math.max(0, i - 1);
      var o3 = (i * ns + (s + 1) % ns) * 3, o4 = (i * ns + (s + ns - 1) % ns) * 3, o5 = (ip * ns + s) * 3, o6 = (im * ns + s) * 3;
      var t1 = [pos[o3] - pos[o4], pos[o3 + 1] - pos[o4 + 1], pos[o3 + 2] - pos[o4 + 2]];
      var t2 = i === 0 ? [pos[o5] - pos[o2], pos[o5 + 1] - pos[o2 + 1], pos[o5 + 2] - pos[o2 + 2]] : [pos[o5] - pos[o6], pos[o5 + 1] - pos[o6 + 1], pos[o5 + 2] - pos[o6 + 2]];
      var n = _aeCross(t1, t2);
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
      n = _aeLen(n) < 1e-12 ? [0, 0, 1] : _aeNorm(n);
      nor[o2] = n[0]; nor[o2 + 1] = n[1]; nor[o2 + 2] = n[2];
    }
  }
  st.groundGeo.attributes.position.needsUpdate = true;
  st.groundGeo.attributes.normal.needsUpdate = true;
  _asRebuildRocks(st, cx, cy);
}
function _asRebuildRocks(st, cx, cy) {
  var pos = st.rockPos, tone = st.rockTone, count = 0, cell = AS_ROCK_CELL_M, reach = AS_ROCK_REACH_M;
  var i0 = Math.floor((cx - reach) / cell), i1 = Math.floor((cx + reach) / cell), j0 = Math.floor((cy - reach) / cell), j1 = Math.floor((cy + reach) / cell);
  for (var j = j0; j <= j1 && count < AS_ROCK_MAX; j++) {
    for (var i = i0; i <= i1 && count < AS_ROCK_MAX; i++) {
      var n = _asHash(i, j, 21) > 0.5 * st.info.rocks ? 0 : _asHash(i, j, 22) < 0.7 ? 1 : 2;
      for (var k = 0; k < n && count < AS_ROCK_MAX; k++) {
        var x = (i + _asHash(i, j, 30 + k)) * cell, y = (j + _asHash(i, j, 40 + k)) * cell;
        if (Math.hypot(x - cx, y - cy) > reach) continue;
        var keep = true;
        for (var p = 0; p < st.keepOut.length; p++) if (Math.hypot(x - st.keepOut[p][0], y - st.keepOut[p][1]) < st.keepOut[p][2]) keep = false;
        if (!keep) continue;
        var size = 0.07 + 0.55 * Math.pow(_asHash(i, j, 50 + k), 3.2), z = _asGroundAt(st, x, y, false) - size * 0.3;
        var sx = size * (0.8 + 0.6 * _asHash(i, j, 60 + k)), sy = size * (0.8 + 0.6 * _asHash(i, j, 70 + k)), sz = size * (0.5 + 0.4 * _asHash(i, j, 80 + k));
        var rot = _asHash(i, j, 90 + k) * 6.2832, c = Math.cos(rot), s = Math.sin(rot), tn = 0.7 + 0.5 * _asHash(i, j, 100 + k);
        for (var v = 0; v < 12; v++) {
          var w = 0.85 + 0.3 * _asHash(i + v * 7, j + v * 13, 110 + k), q = AS_ICO_V[v], o = (count * 12 + v) * 3;
          var lx = q[0] * sx * w, ly = q[1] * sy * w;
          pos[o] = x + lx * c - ly * s; pos[o + 1] = y + lx * s + ly * c; pos[o + 2] = z + sz * (q[2] * w + 0.3);
          tone[count * 12 + v] = tn * (0.85 + 0.3 * _asHash(i + v, j, 120 + k));
        }
        count++;
      }
    }
  }
  st.rockGeo.setDrawRange(0, count * 20 * 3);
  st.rockGeo.attributes.position.needsUpdate = true;
  st.rockGeo.attributes.tone.needsUpdate = true;
}

// ── Parts: a model standing in the frame, with its shadow ──
function _asModelUrlKey(m) { return 'site-' + m; }
function _asModelReady(st, m) {
  var key = _asModelUrlKey(m);
  if (st.models[m]) return st.models[m];
  _aeCraftLoad(key);
  var d = _aeCraftData(key);
  if (!d) return null;
  var S = _ae.gl, I = _aeCraftBuild(S, key);
  S.scene.remove(I.root);
  I.root.visible = true;
  I.uni.fill.value = 0.1;
  I.root.children.forEach(function (c) { if (c.material) c.material.side = AE_THREE_DOUBLE_SIDE; });   // the written models are not wound one way
  st.models[m] = I;
  I.data = d;
  return I;
}
// A part of `model` at (x, y) heading hdg (degrees from north, clockwise), standing on the ground there.
function _asPartAdd(st, model, x, y, hdgDeg, opts) {
  var I = _asModelReady(st, model);
  if (!I) return null;
  var S = _ae.gl, THREE = S.THREE, d = I.data;
  var holder = new THREE.Group();
  holder.rotation.order = 'ZXY';
  var root = I.root.clone();
  root.scale.setScalar(d.metres);
  root.position.set(d.mid[0], d.mid[1], d.mid[2]);
  holder.add(root);
  st.group.add(holder);
  var su = { model: { value: new THREE.Matrix4() }, sun: { value: new THREE.Vector3(0, 0, 1) }, ground: { value: 0 }, lift: { value: AS_SHADOW_LIFT_M }, metre: st.shared.metre,
    albedo: st.shared.albedo, ambient: st.shared.ambient, fade: st.shared.fade, haze: st.groundUni.haze };
  var shadow = new THREE.Mesh(I.root.children[0].geometry, new THREE.ShaderMaterial({ uniforms: su, vertexShader: AS_SHADOW_VERT, fragmentShader: AS_SHADOW_FRAG }));
  shadow.frustumCulled = false;
  shadow.material.polygonOffset = true; shadow.material.polygonOffsetFactor = -2; shadow.material.polygonOffsetUnits = -4;
  st.group.add(shadow);
  var part = { model: model, holder: holder, shadow: shadow, su: su, mid: d.mid, x: x, y: y, z: 0, hdg: _aeRad(-hdgDeg), pitch: 0, roll: 0, spin: 0, opts: opts || {}, size: Math.max(d.span * d.metres, 0.5) };
  st.parts.push(part);
  return part;
}
function _asPartPlace(st, p, x, y, z, hdg, pitch, roll, spin, groundZ) {
  p.x = x; p.y = y; p.z = z; p.hdg = hdg; p.pitch = pitch || 0; p.roll = roll || 0; p.spin = spin || 0;
  var h = p.holder;
  h.position.set(x, y, z);
  h.rotation.set(p.pitch + p.spin, p.roll, hdg);
  h.updateMatrix();
  // The shadow's matrix: the holder's own placement, then the box's centre (the model is stored centred on its box).
  var m = p.su.model.value;
  m.copy(h.matrix);
  var e = m.elements, mx = p.mid[0], my = p.mid[1], mz = p.mid[2];
  e[12] += e[0] * mx + e[4] * my + e[8] * mz; e[13] += e[1] * mx + e[5] * my + e[9] * mz; e[14] += e[2] * mx + e[6] * my + e[10] * mz;
  p.su.ground.value = groundZ == null ? z : groundZ;
}
// A rover's meshes: its body and a wheel for each hub (the assemblies table of sites-v1.json, or the rover this body drives).
function _asRoverModels(rover) {
  var bm = _asData.models[rover.body], wm = _asData.models[rover.wheel];
  return { body: rover.body, wheel: rover.wheel, at: wm && wm.at ? wm.at : bm.wheels.at, radius: wm && wm.radius ? wm.radius : bm.wheels.radius };
}
function _asRoverPartsAdd(st, rm, x, y, hdgDeg) {
  var body = _asPartAdd(st, rm.body, x, y, hdgDeg), wheels = [];
  if (!body) return null;
  for (var i = 0; i < rm.at.length; i++) {
    var w = _asPartAdd(st, rm.wheel, x, y, hdgDeg);
    if (!w) { _asPartRemove(st, body); wheels.forEach(function (q) { _asPartRemove(st, q); }); return null; }
    wheels.push(w);
  }
  return { body: body, wheels: wheels, rm: rm, hubs: rm.at };
}
function _asPartRemove(st, p) {
  p.holder.parent.remove(p.holder); p.shadow.parent.remove(p.shadow);
  st.parts.splice(st.parts.indexOf(p), 1);
}
// Where a rover's wheels stand: the ground under each hub, the body's height (their mean) and the plane through them.
function _asWheelsGround(st, at, x, y, hdg) {
  var n = at.length, c = Math.cos(hdg), sn = Math.sin(hdg), hs = [], mean = 0, i;
  for (i = 0; i < n; i++) {
    var wx = x + at[i][0] * c - at[i][1] * sn, wy = y + at[i][0] * sn + at[i][1] * c;
    hs.push(_asGroundAt(st, wx, wy, false));
    mean += hs[i] / n;
  }
  var sf = 0, sr = 0, df = 0, dr = 0;
  for (i = 0; i < n; i++) { sf += at[i][1] * (hs[i] - mean); df += at[i][1] * at[i][1]; sr += at[i][0] * (hs[i] - mean); dr += at[i][0] * at[i][0]; }
  return { hs: hs, mean: mean, pitch: Math.atan(df ? sf / df : 0), roll: -Math.atan(dr ? sr / dr : 0) };
}
// Put a rover's meshes down: body at z tilted by pitch and roll, each wheel on its ground (or, airborne, hanging from the body).
function _asRoverPlace(st, R, x, y, hdg, z, pitch, roll, spin, gnd, airborne) {
  var at = R.hubs, c = Math.cos(hdg), sn = Math.sin(hdg);
  _asPartPlace(st, R.body, x, y, z, hdg, pitch, roll, 0, gnd.mean);
  for (var i = 0; i < at.length; i++) {
    var wx = x + at[i][0] * c - at[i][1] * sn, wy = y + at[i][0] * sn + at[i][1] * c;
    var base = airborne ? Math.max(gnd.hs[i], z) : gnd.hs[i];
    _asPartPlace(st, R.wheels[i], wx, wy, base + at[i][2], hdg, 0, 0, spin, gnd.mean);
  }
}
// The parts the site stands: each where sites-v1.json says, on the ground there.
function _asPlaceSiteParts(st) {
  if (st.placed) return;
  var defs = st.def ? st.def.parts : [], ok = true;
  defs.forEach(function (pd, n) {
    if (st.siteParts[n]) return;
    var asm = _asData.rovers && _asData.rovers[pd.m];
    var got = asm ? _asRoverPartsAdd(st, _asRoverModels(asm), pd.x || 0, pd.y || 0, pd.h || 0) : _asPartAdd(st, pd.m, pd.x || 0, pd.y || 0, pd.h || 0, pd);
    if (!got) { ok = false; return; }
    st.siteParts[n] = got;
  });
  if (!ok) return;
  st.keepOut = [];
  defs.forEach(function (pd, n) {
    var got = st.siteParts[n], x = pd.x || 0, y = pd.y || 0, hdg = _aeRad(-(pd.h || 0));
    if (got.hubs) {
      var g = _asWheelsGround(st, got.hubs, x, y, hdg);
      _asRoverPlace(st, got, x, y, hdg, g.mean, g.pitch, g.roll, 0, g, false);
      st.keepOut.push([x, y, 3.5]);
    } else {
      var z = _asGroundAt(st, x, y, false);
      _asPartPlace(st, got, x, y, z + (pd.z || 0), got.hdg, 0, 0, 0, z);
      st.keepOut.push([x, y, got.size * 0.6 + 1.5]);
    }
  });
  st.placed = true;
  st.cx = 1e9;   // the rocks keep clear of them
}

