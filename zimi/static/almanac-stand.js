// ── Almanac: Stand here ──
// Tap a spot on a body in the 3D view, choose Stand here, and the camera flies down to the ground there and looks at the
// horizon: the real terrain (almanac-terrain.js), the body's own sky (almanac-standgl.js), the Sun and every body that
// is up at their true places for the page's clock. Drag to look around, pinch to zoom, Back returns to orbit.
//
//   _aeStandAt(body, lat, lon)       enter the view (almanac-earth.js defines it and loads this file on first use)
//   _aeGroundHeight(body, lat, lon)  metres above the body's mean radius, 0 until its terrain is loaded
//
// The view draws a scene of its own into the 3D view's canvas (as Planets side by side does): a local frame in metres at
// the viewer's feet. The orbit view's scene is not drawn meanwhile; it is updated at the pace the sky needs.

var AE_STAND_DESCENT_MS = 3400, AE_STAND_ASCENT_MS = 1900, AE_STAND_FADE_MS = 260, AE_STAND_GIVE_UP_MS = 25000;
var AE_STAND_PITCH_DEG = 3;                // the horizon sits a little below the middle of the picture
var AE_STAND_FOV_MIN_DEG = 50, AE_STAND_FOV_MAX_DEG = 85, AE_STAND_HFOV_DEG = 64, AE_STAND_ZOOM_MIN = 0.25, AE_STAND_ZOOM_MAX = 1.6;
var AE_STAND_PITCH_MAX_DEG = 89;
var AE_STAND_DPR_MAX = 1.5;                // the sky is computed per pixel: a phone draws it at most this sharp
var AE_STAND_FRAME_MS = 1500;              // the sky is worked out again when the clock has moved this much (sooner while it runs fast)
var AE_STAND_HUD_MS = 400;
var AE_STAND_SUN_FACE_DEG = -6;            // the view faces the Sun when it is above this
var AE_STAND_GROUND_AMBIENT_SHARE = 0.8;   // the ground takes this much of the sky's light at its brightest
var AE_STAND_AMBIENT_GAIN = 3;             // the sky's light on the ground, over its light overhead (it comes from the whole dome and the ground)
var AE_STAND_HORIZON_GAIN = 1.8;           // the horizon's sky over the zenith's
var AE_STAND_MOON_NAME = 'moon';
var AE_STAND_SUN_KM = AE_SUN_RADIUS_KM;
// Geometric albedo of each body seen as a light in another's sky (a disc or a point).
var AE_STAND_ALBEDO = { earth: 0.3, moon: 0.12, mercury: 0.14, venus: 0.7, mars: 0.17, jupiter: 0.5, saturn: 0.47, uranus: 0.5, neptune: 0.41,
  pluto: 0.5, ceres: 0.09, io: 0.6, europa: 0.67, ganymede: 0.43, callisto: 0.19, titan: 0.22 };
var AE_STAND_MAG_SUN = -26.74;             // the Sun from the Earth; a flux of 1 (the Sun's irradiance at the Earth)
var AE_STAND_LIGHT2_MIN = 1e-8;            // a body brighter than this (flux) lights the ground too: the Moon on the Earth, the Earth on the Moon
var AE_STAND_SPRITES = 20;                 // the Sun and the others at most
var AE_STAND_STAR_FLOOR_MS = 400;

// ── The way in ──
// Called by the Stand here button, and by anything that wants a body's ground (the models lane). Opens the 3D view if it
// is not up, flies to the place, and drops to the ground once the terrain's mesh is built; resolves true when it started.
function _aeStandStart(key, lat, lon) {
  if (!_aeStandable(key)) return Promise.resolve(false);
  if (_ae && _ae.stand) _aeStandDrop();
  return _aeStandViewUp().then(function (up) {
    if (!up) return false;
    var pend = _ae.standPending = { key: key, lat: lat, lon: lon, ready: false, t0: performance.now(), builder: null, mesh: null, tex: null, token: {} };
    _ae.pick = null; _ae.lm = null; _ae.place = null; _ae.selected = null;
    _aeRenderCard();
    var body = AE_STAND_BODIES[key];
    // The flight comes to the nearest the orbit view lets the camera go over the place, looking straight down at it; the
    // ground is built meanwhile, and the swap to it happens where that flight ends.
    var minDist = AE_TARGETS[key].min, surface = AE_TARGETS[key].surface;
    pend.alt0 = Math.max(30, (minDist - surface) * AE_EARTH_RADIUS_KM);
    _aeStandBuild(pend, body);
    var frame = _aeStBodyNow(key);
    if (frame) _aeFlyTo(key, minDist, _aeAzElOf(_aeStToScene(frame, _aeUnitVec(lat, lon))));
    _ae.preset = null;
    _aeMarkViews();
    _aeKick();
    return true;
  });
}
// The 3D view open and ready (opening it on the body if it was not).
function _aeStandViewUp() {
  return new Promise(function (resolve) {
    if (!_aeIsOpen) openAlmanacEarth({});
    var t0 = performance.now();
    (function wait() {
      if (_aeIsOpen && _aeReady()) { resolve(true); return; }
      if (performance.now() - t0 > AE_STAND_GIVE_UP_MS / 2 || (_ae && _ae.failed)) { resolve(false); return; }
      setTimeout(wait, 100);
    })();
  });
}
// The terrain and the mesh, built in slices behind the flight.
function _aeStandBuild(pend, body) {
  _aeTerrainLoad(pend.key).then(function () {
    if (_ae.standPending !== pend) return;
    var man = _ae.gl && _ae.gl.hd && _ae.gl.hd.man, layer = man && man.layers && man.layers[AE_TERRAIN_HD_LAYER + pend.key];
    return layer ? _aeTerrainHdLoad(pend.key, pend.lat, pend.lon, _aeHdBase(), layer.max) : null;
  }).catch(function () {}).then(function () {
    if (_ae.standPending !== pend) return;
    pend.builder = _aeMeshBuilder(pend.key, pend.lat, pend.lon, _aeMeshCap(body.km, pend.alt0));
    (function slice() {
      if (_ae.standPending !== pend) return;
      if (pend.builder.step(8)) { pend.mesh = pend.builder; pend.finished = pend.builder.finish(); _aeStandMapFor(pend).then(function () { pend.ready = true; _aeKick(); }); return; }
      setTimeout(slice, 0);
    })();
  });
}
// The body's colour map: the one the orbit view has already, else fetched.
function _aeStandMapFor(pend) {
  var S = _ae.gl, key = pend.key, tex = null;
  if (key === 'earth') tex = S.earthUni.dayMap.value;
  else if (key === 'moon') tex = S.moonUni.moonMap.value;
  else if (S.planets && S.planets[key]) tex = S.planets[key].uni.map.value;
  if (tex) { pend.tex = tex; return Promise.resolve(); }
  var b = _aePlanetBody(key);
  if (!b || !b.map) return Promise.resolve();
  return _aeLoadTexture(S.THREE, _aePlanetMapUrl(b)).then(function (t) { t.anisotropy = S.aniso; pend.tex = t; }, function () {});
}
// Called every frame by the 3D view's loop: where the flight has landed and the ground is ready, go down.
function _aeStandStep() {
  var pend = _ae.standPending;
  if (!pend) return;
  var now = performance.now();
  if (now - pend.t0 > AE_STAND_GIVE_UP_MS) { _ae.standPending = null; return; }
  if (!_ae.fly && pend.ready && !pend.swapping) _aeStandSwap(pend);
}

// ── Going down, and back ──
function _aeStandSwap(pend) {
  pend.swapping = true;
  var canvas = _aeById('ae-canvas'), reduce = _aeReduceMotion(), go = function () {
    if (_ae.standPending !== pend) { if (canvas) canvas.style.opacity = ''; return; }
    _ae.standPending = null;
    var st = _aeStandNew(pend);
    if (!st) { if (canvas) canvas.style.opacity = ''; return; }
    _ae.stand = st;
    _aeStandEnter(st);
    if (canvas) { canvas.style.opacity = ''; setTimeout(function () { if (canvas) canvas.style.transition = ''; }, AE_STAND_FADE_MS + 40); }
  };
  if (reduce || !canvas) { go(); return; }
  canvas.style.transition = 'opacity ' + AE_STAND_FADE_MS + 'ms ease';
  canvas.style.opacity = '0';
  setTimeout(go, AE_STAND_FADE_MS);
}
function _aeStandNew(pend) {
  var S = _ae.gl, b = AE_STAND_BODIES[pend.key];
  var st = {
    key: pend.key, lat: pend.lat, lon: pend.lon, b: b, h0: pend.mesh.h0, alt0: pend.alt0, mode: 'descend', t0: performance.now(),
    altKm: pend.alt0, yaw: 0, pitch: -AE_STAND_PITCH_MAX_DEG * Math.PI / 180, userYaw: 0, userPitch: 0, zoom: 1, live: false,
    atmo: AE_ST_ATMO[pend.key] || null, fr: null, photo: null, drawnMs: 0, dirty: true, hudAt: 0, pend: pend
  };
  try { _aeStandGl(st, pend); } catch (e) { _aeStandDispose(st); return null; }
  return st;
}
function _aeStandEnter(st) {
  var S = _ae.gl, el = _ae.el;
  st.live = true;
  el.classList.add('ae-standing');
  _aeStandHud(st);
  _aeFullStepIn();
  S.renderer.setClearColor(0x000000, 1);
  st.prevRatio = S.renderer.getPixelRatio();
  S.renderer.setPixelRatio(Math.min(S.dpr, AE_STAND_DPR_MAX));
  _aeResize();
  var fr = _aeStFrame(st, _aeDisplayMs());
  st.yaw = fr.sunAlt > AE_STAND_SUN_FACE_DEG ? fr.sunAz : 0;
  st.yaw0 = 0;
  _ae.dirty = true;
  _aeKick();
}
// Back to orbit: the camera climbs the way it came, then the orbit view is shown again where the flight left it.
function _aeStandLeave(history) {
  if (_ae.standPending) { _ae.standPending = null; if (history !== false) return; }
  var st = _ae.stand;
  if (!st || st.mode === 'ascend') return;
  if (history !== false) _aeFullStepOut();
  st.mode = 'ascend'; st.t0 = performance.now(); st.fromAlt = st.altKm; st.fromPitch = st.pitch;
  if (_aeReduceMotion()) _aeStandFinishLeave(st);
  _ae.dirty = true;
  _aeKick();
}
function _aeStandFinishLeave(st) {
  var canvas = _aeById('ae-canvas'), done = function () {
    _aeStandDrop();
    if (canvas) { canvas.style.opacity = ''; setTimeout(function () { canvas.style.transition = ''; }, AE_STAND_FADE_MS + 40); }
  };
  st.fading = true;
  if (_aeReduceMotion() || !canvas) { done(); return; }
  canvas.style.transition = 'opacity ' + AE_STAND_FADE_MS + 'ms ease';
  canvas.style.opacity = '0';
  setTimeout(done, AE_STAND_FADE_MS);
}
function _aeStandDrop(closing) {
  var st = _ae && _ae.stand;
  if (_ae) _ae.standPending = null;
  if (!st) return;
  _ae.stand = null;
  var S = _ae.gl;
  if (_ae.el) _ae.el.classList.remove('ae-standing');
  if (st.hud && st.hud.parentNode) st.hud.parentNode.removeChild(st.hud);
  _aeStandDispose(st);
  if (S) {
    S.renderer.setClearColor(0x000000, 0);
    S.renderer.setPixelRatio(st.prevRatio || S.dpr);
    _aeResize();
  }
  if (!closing) _aeFullStepOut();
  _aeStandMarkPick();
  _ae.dirty = true;
  _aeKick();
}

// ── The scene ──
// Built once per visit: sky, stars, the Sun and the others, the ground. Everything in the local frame, metres.
function _aeStandGl(st, pend) {
  var S = _ae.gl, THREE = S.THREE, b = st.b, a = st.atmo, d = a && a.diffuse;
  var R = b.km, hG = st.h0 / 1000;
  var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1e7);
  camera.up.set(0, 0, 1);
  var air = a && !d ? a : null;
  var U = st.uni = {
    uR: { value: R }, uRc: { value: R + hG }, uH0: { value: hG }, uTop: { value: air ? air.top : 1 }, uAtmo: { value: air ? 1 : 0 },
    uRay: { value: air ? air.ray : [0, 0, 0] }, uHR: { value: air ? air.hR : 8 },
    uMieExt: { value: air ? air.mie.ext : [0, 0, 0] }, uMieAlb: { value: air ? air.mie.alb : [0, 0, 0] }, uMieG: { value: air ? air.mie.g : [0, 0, 0] }, uHM: { value: air ? air.mie.h : 1.2 },
    uOzone: { value: air ? air.ozone : [0, 0, 0] }, uMs: { value: air ? air.ms : 0 },
    uSunDir: { value: [0, 0, 1] }, uSunE: { value: [1, 1, 1] }, uK: { value: 1 }
  };
  function mat(vert, frag, uni, opts) {
    var m = new THREE.ShaderMaterial(Object.assign({ uniforms: uni, vertexShader: vert, fragmentShader: frag }, opts || {}));
    st.mats = (st.mats || []).concat([m]);
    return m;
  }
  // The sky: one triangle over the screen.
  var tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  var skyUni = Object.assign({
    uCam: { value: [0, 0, 0] }, uFwd: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uTan: { value: [1, 1] },
    uDiffuse: { value: d ? 1 : 0 }, uDiffSky: { value: [0, 0, 0] }, uMilky: { value: null }, uMw: { value: 0 }, uToGal: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] }
  }, U);
  var sky = new THREE.Mesh(tri, mat(AE_ST_SKY_VERT, AE_ST_SKY_FRAG, skyUni, { depthTest: false, depthWrite: false }));
  sky.frustumCulled = false; sky.renderOrder = -3;
  scene.add(sky);
  st.sky = skyUni;
  // The stars: the Bright Star Catalogue as it arrives (the page's 518 first).
  st.starUni = { uRot: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, uLim: { value: 7 }, uExtinct: { value: 0 }, uDpr: { value: S.renderer.getPixelRatio() }, uStarScale: { value: 1 } };
  st.starMat = mat(AE_ST_STARS_VERT, AE_ST_STARS_FRAG, st.starUni, { depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  _aeStandStars(st, _aeStarList());
  scene.add(st.stars);
  _sgLoadStars().then(function (cat) { if (st.scene) _aeStandStars(st, _sgStarList(cat)); }).catch(function () {});
  // The Sun and the others: a quad each.
  var quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  st.sprites = [];
  for (var i = 0; i < AE_STAND_SPRITES; i++) {
    var uni = { uDir: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uSunFrom: { value: [0, 0, 1] }, uTint: { value: [1, 1, 1] }, uTrans: { value: [1, 1, 1] },
      uHalf: { value: 0.01 }, uRho: { value: 0.001 }, uPix: { value: 0.001 }, uE: { value: 1 }, uK: { value: 1 }, uEmit: { value: 0 }, uVis: { value: 0 }, uGlow: { value: 0 }, uSkyLit: { value: 1 } };
    var mesh = new THREE.Mesh(quad, mat(AE_ST_BODY_VERT, AE_ST_BODY_FRAG, uni, { depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    mesh.frustumCulled = false; mesh.renderOrder = -1; mesh.visible = false;
    scene.add(mesh);
    st.sprites.push({ mesh: mesh, uni: uni });
  }
  // The ground.
  var fin = pend.finished, m = pend.mesh, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(m.dir, 3));
  g.setAttribute('aNrm', new THREE.BufferAttribute(fin.nrm, 3));
  g.setAttribute('aH', new THREE.BufferAttribute(m.hgt, 1));
  g.setAttribute('aSea', new THREE.BufferAttribute(m.sea, 1));
  g.setIndex(new THREE.BufferAttribute(fin.idx, 1));
  var gu = Object.assign({
    uCam: { value: [0, 0, 0] }, uPixAng: { value: 0.001 }, uTime: { value: 0 },
    uMap: { value: pend.tex || null }, uMapped: { value: pend.tex ? 1 : 0 }, uBase: { value: AE_STAND_BASE[st.key] || [0.5, 0.5, 0.5] }, uGain: { value: 1 },
    uAmbient: { value: [0, 0, 0] }, uSkyHor: { value: [0, 0, 0] }, uSkyZen: { value: [0, 0, 0] }, uE2: { value: [0, 0, 0] }, uDir2: { value: [0, 0, 1] },
    uLommel: { value: air || d ? 0 : 1 }, uRough: { value: b.fbm.amp > 100 ? 1.3 : 1 }, uRock: { value: AE_STAND_ROCK[st.key] || 0.25 },
    uDiffuse: { value: d ? 1 : 0 }, uVis: { value: d ? d.vis : 1 }, uDirect: { value: 1 }, uDiffSky: { value: [0, 0, 0] }
  }, U);
  var ground = new THREE.Mesh(g, mat(AE_ST_GROUND_VERT, AE_ST_GROUND_FRAG, gu, {}));
  ground.frustumCulled = false; ground.renderOrder = 0;
  scene.add(ground);
  st.ground = gu; st.groundMesh = ground; st.geo = [g, tri, quad];
  st.scene = scene; st.camera = camera;
  // The Milky Way's panorama, once it is in.
  _aeLoadTexture(THREE, SG_MILKYWAY_URL).then(function (t) { skyUni.uMilky.value = t; st.dirty = true; if (_ae) { _ae.dirty = true; _aeKick(); } }, function () {});
  // Compile before the first frame (the driver does it off the main thread where it can).
  if (S.renderer.compileAsync) S.renderer.compileAsync(scene, camera).catch(function () {});
}
// Fallback colour where a body has no map (grey ice, dust), and how rocky its ground is (0..1, the share of ground with rocks).
var AE_STAND_BASE = { ceres: [0.5, 0.48, 0.45] };
var AE_STAND_ROCK = { earth: 0.12, moon: 0.28, mercury: 0.28, venus: 0.4, mars: 0.4, io: 0.2, europa: 0.08, ganymede: 0.22, callisto: 0.3, titan: 0.3, pluto: 0.15 };
function _aeStandStars(st, list) {
  var THREE = _ae.gl.THREE, n = list.count, pos = new Float32Array(3 * n), mag = new Float32Array(n), col = new Float32Array(3 * n), s = {};
  for (var i = 0; i < n; i++) {
    list.at(i, s);
    var v = _aeEqVec(s.ra, s.dec, 1), c = _sgBvToRGB(s.ci);
    pos.set(v, 3 * i); mag[i] = s.mag; col.set(c, 3 * i);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  var pts = new THREE.Points(g, st.starMat);
  pts.frustumCulled = false; pts.renderOrder = -2;
  if (st.stars) { st.scene && st.scene.remove(st.stars); st.stars.geometry.dispose(); }
  st.stars = pts;
  if (st.scene) st.scene.add(pts);
  st.dirty = true;
}
function _aeStandDispose(st) {
  (st.geo || []).forEach(function (g) { g.dispose(); });
  (st.mats || []).forEach(function (m) { m.dispose(); });
  if (st.sky && st.sky.uMilky.value) st.sky.uMilky.value.dispose();
  if (st.stars) st.stars.geometry.dispose();
  st.geo = st.mats = null; st.scene = st.camera = null;
}

