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
var AE_STAND_NEAR_SUN_SHARE = 0.5;        // the exposure is set by the brightest sky short of the Sun's own glare: this much of the sky a little over it
var AE_STAND_NEAR_SUN_ABOVE_DEG = 8, AE_STAND_NEAR_SUN_MIN_DEG = 6;
var AE_STAND_AMBIENT_GAIN = 1.6;
var AE_STAND_BOUNCE = 0.03;                // an airless ground in shadow, over the Sun-lit ground's radiance (alb x this): light from the terrain round it             // the sky's light on the ground, over its light overhead (it comes from the whole dome and the ground)
var AE_STAND_HORIZON_GAIN = 1.8;           // the horizon's sky over the zenith's
var AE_STAND_MOON_NAME = 'moon';
var AE_STAND_CHARON_R_KM = 606;   // Charon's radius (NASA New Horizons); its orbit's is in almanac-earth.js
var AE_STAND_MAP_GAIN_ALBEDO = 0.25;   // the albedo a map's linear mean stands for; a body's own albedo scales it
var AE_STAND_RING_PX = 6;              // a ringed planet's rings are read from this many pixels across
var AE_STAND_CRAFT_RANGE = 5e4;        // metres out at which a spacecraft's mark is projected
var AE_STAND_SUN_KM = AE_SUN_RADIUS_KM;
// Geometric albedo of each body seen as a light in another's sky (a disc or a point).
var AE_STAND_ALBEDO = { earth: 0.3, moon: 0.12, mercury: 0.14, venus: 0.7, mars: 0.17, jupiter: 0.5, saturn: 0.47, uranus: 0.5, neptune: 0.41,
  pluto: 0.5, charon: 0.35, ceres: 0.09, io: 0.6, europa: 0.67, ganymede: 0.43, callisto: 0.19, titan: 0.22 };
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
    // A body with no place for this date (a dwarf planet whose table does not reach it) has no sky to stand under.
    var frame = _aeStBodyNow(key);
    if (!frame) return false;
    var pend = _ae.standPending = { key: key, lat: lat, lon: lon, ready: false, t0: performance.now(), builder: null, mesh: null, tex: null };
    _ae.pick = null; _ae.lm = null; _ae.place = null; _ae.selected = null;
    _aeRenderCard();
    var body = AE_STAND_BODIES[key];
    // The flight comes to the nearest the orbit view lets the camera go over the place, looking straight down at it; the
    // ground is built meanwhile, and the swap to it happens where that flight ends.
    var minDist = AE_TARGETS[key].min, surface = AE_TARGETS[key].surface;
    pend.alt0 = Math.max(30, (minDist - surface) * AE_EARTH_RADIUS_KM);
    _aeStandBuild(pend, body);
    _aeFlyTo(key, minDist, _aeAzElOf(_aeStToScene(frame, _aeUnitVec(lat, lon))));
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
// A pending ground is wanted while it is the view's own, or a site's (almanac-standhost.js) that has not been dropped.
function _aeStandPendAlive(pend) { return !pend.dead && (pend.host || _ae.standPending === pend); }
function _aeStandBuild(pend, body) {
  _aeTerrainLoad(pend.key).then(function () {
    if (!_aeStandPendAlive(pend)) return;
    var man = _ae.gl && _ae.gl.hd && _ae.gl.hd.man, layer = man && man.layers && man.layers[AE_TERRAIN_HD_LAYER + pend.key];
    return layer ? _aeTerrainHdLoad(pend.key, pend.lat, pend.lon, _aeHdBase(), layer.max) : null;
  }).catch(function () {}).then(function () {
    if (!_aeStandPendAlive(pend)) return;
    pend.builder = _aeMeshBuilder(pend.key, pend.lat, pend.lon, _aeMeshCap(body.km, pend.alt0), pend.flat);
    var work = function (step, then) { (function slice() { if (!_aeStandPendAlive(pend)) return; if (step(AE_STAND_SLICE_MS)) then(); else setTimeout(slice, 0); })(); };
    work(pend.builder.step, function () {
      pend.mesh = pend.builder; pend.finished = pend.builder.finish();
      // The relief's heights on the shadow grids, then every vertex against the Sun of this moment: the ground is whole when it is shown.
      pend.grids = _aeShadeGrids(function (x, y, cell) { return _aeTerrainLocal(pend.key, pend.lat, pend.lon, pend.mesh.h0, x, y, cell / 1000 * AE_STAND_SHADE_LOD, pend.flat); });
      work(pend.grids.step, function () {
        var fr0 = _aeStFrame({ key: pend.key, lat: pend.lat, lon: pend.lon, b: body, h0: pend.mesh.h0 }, _aeDisplayMs());
        pend.shade = { arr: new Float32Array(pend.mesh.count).fill(1), sun: fr0.sun.slice(), job: null, at: performance.now() };
        var job = _aeShadeJob(pend.grids, pend.mesh.pos, pend.mesh.count, pend.shade.sun, Math.tan(fr0.sunRho), pend.shade.arr);
        work(job.step, function () { _aeStandMapFor(pend).then(function () { pend.ready = true; _aeKick(); }); });
      });
    });
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
    grids: pend.grids, meshPos: pend.mesh.pos, meshCount: pend.mesh.count, shade: pend.shade,
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
  if (st.motion) _aeMotionStop(st, true);   // the choice is kept: it comes back next time
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
  var S = _ae.gl, THREE = S.THREE, scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1e7);
  camera.up.set(0, 0, 1);
  var a = st.atmo, air = a && !a.diffuse ? a : null, U = st.uni = _aeStandAirUniforms(st.b.km, st.h0 / 1000, air);
  var mat = function (vert, frag, uni, opts) {
    var m = new THREE.ShaderMaterial(Object.assign({ uniforms: uni, vertexShader: vert, fragmentShader: frag }, opts || {}));
    st.mats = (st.mats || []).concat([m]);
    return m;
  };
  st.geo = [];
  scene.add(_aeStandSkyMesh(st, U, mat));
  // The stars: the Bright Star Catalogue as it arrives (the page's 518 first).
  st.starUni = { uRot: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, uLim: { value: 7 }, uExtinct: { value: 0 }, uDpr: { value: S.renderer.getPixelRatio() }, uStarScale: { value: 1 } };
  st.starMat = mat(AE_ST_STARS_VERT, AE_ST_STARS_FRAG, st.starUni, { depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  _aeStandStars(st, _aeStarList());
  scene.add(st.stars);
  _sgLoadStars().then(function (cat) { if (st.scene) _aeStandStars(st, _sgStarList(cat)); }).catch(function () {});
  _aeStandSpriteMeshes(st, mat).forEach(function (m) { scene.add(m); });
  if (typeof _aeRingCanvas === 'function') _aeLoadTexture(S.THREE, _aeRingCanvas().toDataURL()).then(function (tx) { if (st.scene) st.ringTex = tx; else tx.dispose(); }, function () {});
  scene.add(_aeStandGroundMesh(st, pend, U, mat));
  st.scene = scene; st.camera = camera;
  // Compile before the first frame (the driver does it off the main thread where it can).
  if (S.renderer.compileAsync) S.renderer.compileAsync(scene, camera).catch(function () {});
}
// The air's numbers as the uniforms every shader shares: the body's radius, the ground's, and its air if it has rays and dust.
function _aeStandAirUniforms(km, groundKm, air) {
  return {
    uR: { value: km }, uRc: { value: km + groundKm }, uH0: { value: groundKm }, uTop: { value: air ? air.top : 1 }, uAtmo: { value: air ? 1 : 0 },
    uRay: { value: air ? air.ray : [0, 0, 0] }, uHR: { value: air ? air.hR : 8 },
    uMieExt: { value: air ? air.mie.ext : [0, 0, 0] }, uMieAlb: { value: air ? air.mie.alb : [0, 0, 0] }, uMieG: { value: air ? air.mie.g : [0, 0, 0] }, uHM: { value: air ? air.mie.h : 1.2 },
    uOzone: { value: air ? air.ozone : [0, 0, 0] }, uMs: { value: air ? air.ms : 0 }, uGainS: { value: air && air.gain ? air.gain : 1 },
    uSunDir: { value: [0, 0, 1] }, uSunE: { value: [1, 1, 1] }, uK: { value: 1 }
  };
}
// The sky: one triangle over the screen, and the Milky Way's panorama once it is in.
function _aeStandSkyMesh(st, U, mat) {
  var THREE = _ae.gl.THREE, tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  var uni = st.sky = Object.assign({
    uCam: { value: [0, 0, 0] }, uFwd: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uTan: { value: [1, 1] },
    uDiffuse: { value: st.atmo && st.atmo.diffuse ? 1 : 0 }, uDiffSky: { value: [0, 0, 0] }, uMilky: { value: null }, uMw: { value: 0 }, uToGal: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] }
  }, U);
  var sky = st.skyMesh = new THREE.Mesh(tri, mat(AE_ST_SKY_VERT, AE_ST_SKY_FRAG, uni, { depthTest: false, depthWrite: false }));
  sky.frustumCulled = false; sky.renderOrder = -3;
  st.geo.push(tri);
  _aeLoadTexture(THREE, SG_MILKYWAY_URL).then(function (t) { uni.uMilky.value = t; st.dirty = true; if (_ae) { _ae.dirty = true; _aeKick(); } }, function () {});
  return sky;
}
// The Sun and the others: a quad each, shown as the sky needs them.
function _aeStandSpriteMeshes(st, mat) {
  var THREE = _ae.gl.THREE, quad = new THREE.BufferGeometry(), out = [];
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  st.geo.push(quad);
  st.sprites = [];
  for (var i = 0; i < AE_STAND_SPRITES; i++) {
    var uni = { uDir: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uSunFrom: { value: [0, 0, 1] }, uTint: { value: [1, 1, 1] }, uTrans: { value: [1, 1, 1] },
      uHalf: { value: 0.01 }, uRho: { value: 0.001 }, uPix: { value: 0.001 }, uE: { value: 1 }, uK: { value: 1 }, uEmit: { value: 0 }, uVis: { value: 0 }, uGlow: { value: 0 }, uSkyLit: { value: 1 },
      uMap: { value: null }, uMapped: { value: 0 }, uGrey: { value: 0 }, uMapGain: { value: 1 }, uBody: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      uRingMap: { value: null }, uRings: { value: 0 }, uRp: { value: 1 }, uRingN: { value: [0, 0, 1] }, uCen: { value: [0, 1, 0] }, uRing: { value: [0, 1] } };
    var mesh = new THREE.Mesh(quad, mat(AE_ST_BODY_VERT, AE_ST_BODY_FRAG, uni, { depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    mesh.frustumCulled = false; mesh.renderOrder = -1; mesh.visible = false;
    st.sprites.push({ mesh: mesh, uni: uni });
    out.push(mesh);
  }
  return out;
}
// The ground: the mesh the terrain built, with its colour map and what the shader needs of the body.
function _aeStandGroundMesh(st, pend, U, mat) {
  var THREE = _ae.gl.THREE, fin = pend.finished, m = pend.mesh, g = new THREE.BufferGeometry(), a = st.atmo, d = a && a.diffuse;
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(m.dir, 3));
  g.setAttribute('aNrm', new THREE.BufferAttribute(fin.nrm, 3));
  g.setAttribute('aH', new THREE.BufferAttribute(m.hgt, 1));
  g.setAttribute('aSea', new THREE.BufferAttribute(m.sea, 1));
  st.shadeAttr = new THREE.BufferAttribute(pend.shade.arr, 1);
  g.setAttribute('aShade', st.shadeAttr);
  g.setIndex(new THREE.BufferAttribute(fin.idx, 1));
  st.geo.push(g);
  var gu = st.ground = Object.assign({
    uCam: { value: [0, 0, 0] }, uPixAng: { value: 0.001 }, uTime: { value: 0 },
    uMap: { value: pend.tex || null }, uMapped: { value: pend.tex ? 1 : 0 }, uGrey: { value: AE_STAND_GREY_MAP[st.key] ? 1 : 0 },
    uBase: { value: AE_STAND_BASE[st.key] || [0.5, 0.5, 0.5] }, uGain: { value: AE_STAND_TINT[st.key] || [1, 1, 1] },
    uAmbient: { value: [0, 0, 0] }, uSkyHor: { value: [0, 0, 0] }, uSkyZen: { value: [0, 0, 0] }, uE2: { value: [0, 0, 0] }, uDir2: { value: [0, 0, 1] },
    uLommel: { value: a ? 0 : 1 }, uRough: { value: st.b.fbm.amp > 100 ? 1.3 : 1 }, uRock: { value: AE_STAND_ROCK[st.key] || 0.25 },
    uDiffuse: { value: d ? 1 : 0 }, uVis: { value: d ? d.vis : 1 }, uDirect: { value: 1 }, uDiffSky: { value: [0, 0, 0] }
  }, U);
  var ground = st.groundMesh = new THREE.Mesh(g, mat(AE_ST_GROUND_VERT, AE_ST_GROUND_FRAG, gu, {}));
  ground.frustumCulled = false; ground.renderOrder = 0;
  return ground;
}
// Fallback colour where a body has no map (grey ice, dust), and how rocky its ground is (0..1, the share of ground with rocks).
var AE_STAND_GREY_MAP = { moon: true };   // maps of one channel (the Moon's), read as grey
// What the ground's colour map is multiplied by (linear): the Mars map is a salmon grey where the ground is rust, Titan's is grey
// under orange light and a darker ground than it.
var AE_STAND_TINT = { mars: [1.55, 0.92, 0.55], titan: [4.2, 3.0, 1.6] };
var AE_STAND_SLICE_MS = 8;                 // a slice of building between breaths of the page
var AE_STAND_SHADE_LOD = 1.5;              // the shadow grids hold wavelengths down to this many cells
var AE_STAND_SHADE_MOVE = 0.0044, AE_STAND_SHADE_EVERY_MS = 300, AE_STAND_SHADE_SLICE_MS = 5;   // the Sun has moved a quarter degree; not again sooner than this; the work a frame
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
  if (st.ringTex) st.ringTex.dispose();
  Object.keys(st.discMaps || {}).forEach(function (k) { var m = st.discMaps[k]; if (m && m !== true) m.dispose(); });
  if (st.craftHost && st.craftHost.parentNode) st.craftHost.parentNode.removeChild(st.craftHost);
  if (st.stars) st.stars.geometry.dispose();
  st.geo = st.mats = null; st.scene = st.camera = null;
}

// ── The sky and the bodies in it, for an instant ──
// Positions are heliocentric, in km, in the equator of date the orbit view's scene uses; the viewer's body turns under them.
function _aeStToScene(frame, v) {   // a body-fixed vector to the scene
  var f = frame.f;
  return [f.x[0] * v[0] + f.y[0] * v[1] + f.z[0] * v[2], f.x[1] * v[0] + f.y[1] * v[1] + f.z[1] * v[2], f.x[2] * v[0] + f.y[2] * v[1] + f.z[2] * v[2]];
}
// The orbit view's body now: its frame (body-fixed to scene) from what the view has drawn.
function _aeStBodyNow(key) {
  var S = _ae.gl, e;
  if (key === 'moon') e = S.moon.matrix.elements;
  else if (key === 'earth') {
    var c = Math.cos(S.earth.rotation.z), sn = Math.sin(S.earth.rotation.z);
    return { f: { x: [c, sn, 0], y: [-sn, c, 0], z: [0, 0, 1] } };
  } else if (S.planets[key] && S.planets[key].pos) e = S.planets[key].mesh.matrix.elements;
  if (!e) return null;
  return { f: { x: _aeNorm([e[0], e[1], e[2]]), y: _aeNorm([e[4], e[5], e[6]]), z: _aeNorm([e[8], e[9], e[10]]) } };
}
function _aeStMoonOffset(b, jd, toScene) {   // a big moon's place round its planet, km, scene frame (almanac-earth.js _aeUpdatePlanets)
  var pb = _aePlanetBody(b.parent), o = b.orbit, pole = _aePlanetFrameEcl(pb, jd).z;
  var ax = _aeNorm(_aeCross([0, 0, 1], pole)), ay = _aeCross(pole, ax), lam = _aeRad(o[1] + o[2] * (jd - JD_J2000));
  var off = _aeAdd(_aeScale(ax, Math.cos(lam)), _aeScale(ay, Math.sin(lam)));
  return { off: _aeScale(toScene(off), o[0]), pole: toScene(pole), toward: _aeScale(toScene(off), -1) };
}
function _aeStBodies(sc) {
  var jd = sc.jd, jde = sc.jde, toScene = function (v) { return _ephEclJ2000ToEqOfDate(v, jde); }, out = {};
  var ePos = _aeScale(toScene(_ephBodyJ2000('Earth', jd)), AU_KM), cg = Math.cos(sc.gast), sg = Math.sin(sc.gast);
  out.earth = { pos: ePos, km: AE_STAND_BODIES.earth.km, f: { x: [cg, sg, 0], y: [-sg, cg, 0], z: [0, 0, 1] }, color: [0.45, 0.58, 0.8] };
  out.moon = { pos: _aeAdd(ePos, _aeScale(sc.moon, AE_EARTH_RADIUS_KM)), km: AE_MOON_RADIUS_KM, f: _aeMoonBasis(sc), color: [1, 1, 1] };
  AE_PLANETS.forEach(function (b) {
    if (b.parent) return;
    var h = b.track ? _aeTracked(b, jd) : _ephBodyJ2000(b.eph, jd);
    if (!h) return;
    var f = _aePlanetFrameEcl(b, jd);
    out[b.key] = { pos: _aeScale(toScene(h), AU_KM), km: b.km, f: { x: toScene(f.x), y: toScene(f.y), z: toScene(f.z) }, color: b.color };
  });
  // Charon hangs over Pluto's 0 degrees of longitude and turns with it (they are tidally locked).
  if (out.pluto) out.charon = { pos: _aeAdd(out.pluto.pos, _aeScale(out.pluto.f.x, AE_STAND_CHARON_KM)), km: AE_STAND_CHARON_R_KM, f: out.pluto.f, color: [0.56, 0.5, 0.46] };
  AE_PLANETS.forEach(function (b) {
    if (!b.parent || !out[b.parent]) return;
    var m = _aeStMoonOffset(b, jd, toScene), xx = _aeNorm(m.toward);
    out[b.key] = { pos: _aeAdd(out[b.parent].pos, m.off), km: b.km, f: { x: xx, y: _aeCross(m.pole, xx), z: m.pole }, color: b.color };
  });
  return out;
}
function _aeStTrans3(a, b) { return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; }
function _aeStFrame(st, ms) {
  var sc = _aeSceneAt(ms), all = _aeStBodies(sc), B = all[st.key], lat = _aeRad(st.lat), lon = _aeRad(st.lon);
  var u = _aeUnitVec(st.lat, st.lon), e = [-Math.sin(lon), Math.cos(lon), 0], n = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  var up = _aeStToScene(B, u), east = _aeStToScene(B, e), north = _aeStToScene(B, n);
  var O = _aeAdd(B.pos, _aeScale(up, st.b.km + st.h0 / 1000));
  var local = function (v) { return [_aeDot(v, east), _aeDot(v, north), _aeDot(v, up)]; };
  var fr = { ms: ms, east: east, north: north, up: up, objs: [] };
  var sunV = _aeScale(O, -1), sunDist = _aeLen(sunV);
  fr.sun = _aeNorm(local(sunV));
  fr.S = Math.pow(AU_KM / sunDist, 2);
  fr.sunAlt = _aeDeg(Math.asin(_aeClamp(fr.sun[2], -1, 1)));
  fr.sunAz = Math.atan2(fr.sun[0], fr.sun[1]);
  fr.sunMu = fr.sun[2];
  fr.sunRho = Math.asin(AE_STAND_SUN_KM / sunDist);
  var light2 = null;
  Object.keys(all).forEach(function (k) {
    if (k === st.key) return;
    var P = all[k], d = _aeSub(P.pos, O), dist = _aeLen(d), rho = Math.asin(Math.min(1, P.km / dist));
    var sunFrom = _aeNorm(_aeScale(P.pos, -1)), toObs = _aeNorm(_aeScale(d, -1)), cosA = _aeClamp(_aeDot(sunFrom, toObs), -1, 1);
    var alpha = Math.acos(cosA), phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI, E = Math.pow(AU_KM / _aeLen(P.pos), 2);
    var alb = AE_STAND_ALBEDO[k] || 0.3, flux = 2 / 3 * alb * E * rho * rho * phase, mean = (P.color[0] + P.color[1] + P.color[2]) / 3;
    var tint = k === AE_STAND_MOON_NAME ? [alb, alb, alb] : [P.color[0] / mean * alb, P.color[1] / mean * alb, P.color[2] / mean * alb];
    var o = { key: k, dir: _aeNorm(local(d)), dist: dist, rho: rho, E: E, sunFrom: _aeNorm(local(sunFrom)), tint: tint, flux: flux, mag: AE_STAND_MAG_SUN - 2.5 * Math.log10(Math.max(flux, 1e-30)), alb: alb, km: P.km,
      rows: [P.f.x, P.f.y, P.f.z].map(function (ax) { return [_aeDot(ax, east), _aeDot(ax, north), _aeDot(ax, up)]; }) };
    o.pole = [_aeDot(P.f.z, east), _aeDot(P.f.z, north), _aeDot(P.f.z, up)];
    fr.objs.push(o);
    if (flux > AE_STAND_LIGHT2_MIN && (!light2 || flux > light2.flux)) light2 = { dir: o.dir, flux: flux, rgb: tint.map(function (c) { return flux * c / Math.max(alb, 1e-6); }) };
  });
  fr.light2 = light2;
  fr.crafts = _aeStCrafts(sc, all, O, local, ms);
  return fr;
}
// Spacecraft where they are: the probes from the Horizons tables, the station from its orbit, each as a direction and a name.
function _aeStCrafts(sc, all, O, local, ms) {
  var out = [], toScene = function (v) { return _ephEclJ2000ToEqOfDate(v, sc.jde); };
  if (typeof _aeTracks !== 'undefined' && _aeTracks && _aeTracks.probes) {
    _aeTracks.probes.forEach(function (k) {
      var h = _aeTrackAt(_aeTracks.tracks[k], sc.jd);
      if (!h) return;
      var d = _aeSub(_aeScale(toScene(h), AU_KM), O), dist = _aeLen(d);
      if (dist > 1) out.push({ key: k, name: _aeTracks.tracks[k].name || k, dir: _aeNorm(local(d)), dist: dist });
    });
  }
  var iss = _ae.sats && _ae.sats.lib && _ae.sats.list.filter(function (s) { return s.iss; })[0];
  var r = iss ? _aeSatAt(iss, ms, _aeEqEq(sc)) : null;
  if (r) {
    var di = _aeSub(_aeAdd(all.earth.pos, _aeScale(r.pos, AE_EARTH_RADIUS_KM)), O);
    out.push({ key: 'iss', name: _aeT('alm_earth_iss_short'), dir: _aeNorm(local(di)), dist: _aeLen(di) });
  }
  return out;
}
// The sky in the Sun's own bearing, a little above it (the exposure is not set by the dark zenith when the Sun is low).
function _aeStNearSun(a, R, hG, fr) {
  var e = Math.max(_aeRad(fr.sunAlt + AE_STAND_NEAR_SUN_ABOVE_DEG), _aeRad(AE_STAND_NEAR_SUN_MIN_DEG)), c = Math.cos(e), az = fr.sunAz;
  return _aeStInscatter(a, R, hG, 0, [c * Math.sin(az), c * Math.cos(az), Math.sin(e)], fr.sun, null);
}
// What the air and the light make of that instant: the sky overhead, the exposure, how faint a star shows.
function _aeStPhoto(st, fr) {
  var a = st.atmo, d = a && a.diffuse, R = st.b.km, hG = st.h0 / 1000, S = fr.S, mu = fr.sunMu;
  var p = { zen: [0, 0, 0], hor: [0, 0, 0], amb: [0, 0, 0], sunE: [S, S, S], diffSky: [0, 0, 0], trans: null, lim: AE_ST_LM_MAX, extinct: 0, mw: 1 };
  var e2 = fr.light2 ? fr.light2.flux : 0;
  var directG = S * Math.max(mu, 0);   // airless: all of the Sun
  if (!a) p.amb = [S * AE_STAND_BOUNCE, S * AE_STAND_BOUNCE, S * AE_STAND_BOUNCE];   // and what the ground's own surroundings send back
  if (d) {
    var day = 0.03 + 0.97 * _smoothstep(-0.2, 0.45, mu), lum = d.frac * S / Math.PI * 0.9 * day;
    p.diffSky = [d.sky[0] * lum, d.sky[1] * lum, d.sky[2] * lum];
    p.amb = p.diffSky.slice(); p.hor = p.diffSky.slice(); p.zen = p.diffSky.slice();
    var sd = S * d.frac * d.direct * day;
    p.sunE = [sd, sd, sd];
    directG = sd * Math.max(mu, 0);
    p.lim = AE_ST_LM_MIN; p.mw = 0;
  } else if (a) {
    var zen = _aeStZenith(a, R, hG, mu).map(function (x) { return x * S; }), od = _aeStOdUp(a, R, hG, mu);
    p.zen = zen;
    p.near = _aeStNearSun(a, R, hG, fr).map(function (x) { return x * S; });
    p.hor = zen.map(function (x) { return x * AE_STAND_HORIZON_GAIN; });
    p.amb = zen.map(function (x) { return x * AE_STAND_AMBIENT_GAIN; });
    directG = od ? S * Math.max(mu, 0) * Math.exp(-Math.min(od[0], od[1], od[2])) : 0;
    var lcd = Math.max(zen[0], zen[1], zen[2]) * AE_ST_LUX_PER_UNIT;
    p.lim = _aeClamp(AE_ST_LM_DARK - AE_ST_LM_PER_DECADE * Math.log10((lcd + AE_ST_DARK_LUM) / AE_ST_DARK_LUM), AE_ST_LM_MIN, AE_ST_LM_MAX);
    p.extinct = 0.2;
  }
  // Light of other bodies as a second sun for the ground.
  var ref = Math.max(AE_ST_GROUND_ALBEDO_REF * ((directG + e2) / Math.PI + AE_STAND_GROUND_AMBIENT_SHARE * Math.max(p.amb[0], p.amb[1], p.amb[2])),
    1.2 * Math.max(p.zen[0], p.zen[1], p.zen[2]), AE_STAND_NEAR_SUN_SHARE * Math.max(p.near ? p.near[0] : 0, p.near ? p.near[1] : 0, p.near ? p.near[2] : 0), AE_ST_NIGHT_FLOOR);
  p.k = AE_ST_EXPOSURE_TARGET / ref;
  p.e2 = e2;
  p.mwStrength = _aeClamp((p.lim - 5.2) / 2.5, 0, 1) * p.mw;
  return p;
}
function _aeStStarVis(mag, lim) {   // almanac-skygl.js _sgStarVisibility
  var dm = lim - mag;
  if (dm <= 0) return 0;
  var f = Math.min(1, dm / 0.6);
  return f * f * (3 - 2 * f) * Math.min(1, 0.12 * Math.pow(10, 0.2 * dm));
}
function _aeStMat3(rows) {   // three rows -> the column-major array a mat3 uniform takes
  return [rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]];
}

// ── Drawing ──
function _aeStandView(st, now) {
  var span = st.mode === 'ascend' ? AE_STAND_ASCENT_MS : AE_STAND_DESCENT_MS;
  var u = _aeReduceMotion() ? 1 : _aeSmoother(_aeClamp((now - st.t0) / span, 0, 1));   // reduced motion: there at once
  var lo = Math.log(AE_STAND_EYE_M / 1000), hi = Math.log(st.alt0), pitchLook = st.userPitch + _aeRad(AE_STAND_PITCH_DEG), down = -_aeRad(AE_STAND_PITCH_MAX_DEG);
  if (st.mode === 'descend') {
    st.altKm = Math.exp(hi + (lo - hi) * u);
    st.pitch = down + (pitchLook - down) * _aeSmoother(_aeClamp((u - 0.1) / 0.9, 0, 1));
    if (u >= 1) { st.mode = 'ground'; st.pitch = pitchLook; }
  } else if (st.mode === 'ascend') {
    st.altKm = Math.exp(lo + (hi - lo) * u);
    st.pitch = st.fromPitch + (down - st.fromPitch) * _aeSmoother(_aeClamp(u / 0.9, 0, 1));
    if (u >= 1 && !st.fading) _aeStandFinishLeave(st);
  } else { st.altKm = AE_STAND_EYE_M / 1000; st.pitch = pitchLook; }
}
function _aeStandFov() {
  var aspect = _ae.w / _ae.h, v = _aeClamp(2 * Math.atan(Math.tan(_aeRad(AE_STAND_HFOV_DEG) / 2) / aspect), _aeRad(AE_STAND_FOV_MIN_DEG), _aeRad(AE_STAND_FOV_MAX_DEG));
  return v * _ae.stand.zoom;
}
function _aeStandDraw(now) {
  var st = _ae.stand;
  if (!st || !st.live || !st.scene) return;
  var ms = _aeDisplayMs();
  _aeStandView(st, now);
  if (!st.scene) return;
  if (st.motion && st.mode === 'ground') {
    var mv = _aeMotionView(st, now);
    if (mv) { st.userYaw = _aeRad(mv.az) - st.yaw; st.userPitch = _aeRad(mv.alt) - _aeRad(AE_STAND_PITCH_DEG); st.dirty = true; }
  }
  _aeStandPaint(st, now, st.mode !== 'ground', _aeStandPlaceCamera);
}
// One picture: the sky worked out again if the clock has moved, every shader's uniforms, the draw. `place(st)` puts the camera
// (this view's own, or a site's: almanac-standhost.js) and says where it is. Nothing is drawn if nothing changed.
function _aeStandPaint(st, now, moving, place) {
  var ms = _aeDisplayMs();
  var fast = _aeClockRuns() && typeof _almRate !== 'undefined' && _almRate !== 1;
  var stale = !st.fr || Math.abs(ms - st.fr.at) >= (fast ? 1 : AE_STAND_FRAME_MS);
  if (!(moving || st.dirty || stale || st.size !== _ae.w + 'x' + _ae.h)) return;   // nothing changed: the last picture stands
  st.size = _ae.w + 'x' + _ae.h;
  if (stale) { st.fr = _aeStFrame(st, ms); st.fr.at = ms; st.photo = _aeStPhoto(st, st.fr); }
  var view = place(st);
  _aeStandApplyAir(st, st.fr, st.photo, view);
  _aeStandApplyGround(st, st.fr, st.photo, view, now);
  _aeStandShadeTick(st, st.fr, now);
  _aeStandSprites(st, st.fr, st.photo, view.pixAng, view.pos[2]);
  _aeStandCraftMarks(st, st.fr, view);
  _ae.gl.renderer.render(st.scene, st.camera);
  st.dirty = false;
  if (st.hud && now - st.hudAt > AE_STAND_HUD_MS) { st.hudAt = now; _aeStandHudText(st); }
}
// The camera at its height and heading: returns what the shaders want of it (height in metres, the view's axes, the tangent of
// half the field, the angle a pixel covers).
function _aeStandPlaceCamera(st) {
  var cam = st.camera, W = _ae.w, H = _ae.h, vfov = _aeStandFov(), yaw = st.yaw + st.userYaw, pitch = st.pitch, alt = st.altKm * 1000;
  var f = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
  cam.fov = _aeDeg(vfov); cam.aspect = W / H;
  cam.near = Math.max(0.05, alt * 0.01); cam.far = Math.max(1e5, st.b.km * 1000 * 3);
  cam.position.set(0, 0, alt);
  cam.lookAt(f[0], f[1], alt + f[2]);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  var e = cam.matrixWorld.elements, tanV = Math.tan(vfov / 2);
  return { pos: [0, 0, alt], e: e, tanV: tanV, aspect: W / H, pixAng: 2 * tanV / (H * _ae.gl.renderer.getPixelRatio()) };
}
// The sky, the stars and the air every shader shares.
function _aeStandApplyAir(st, fr, ph, view) {
  var U = st.uni, sk = st.sky, e = view.e;
  U.uSunDir.value = fr.sun; U.uSunE.value = ph.sunE; U.uK.value = ph.k;
  sk.uCam.value = [view.pos[0] / 1000, view.pos[1] / 1000, view.pos[2] / 1000];
  sk.uFwd.value = [-e[8], -e[9], -e[10]]; sk.uRight.value = [e[0], e[1], e[2]]; sk.uUp.value = [e[4], e[5], e[6]];
  sk.uTan.value = [view.tanV * view.aspect, view.tanV];
  sk.uDiffSky.value = ph.diffSky;
  var local = [fr.east, fr.north, fr.up], G = typeof SG_EQ_TO_GAL !== 'undefined' ? SG_EQ_TO_GAL : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // Galactic coordinates of a local vector: G (eq -> gal) times the local axes expressed in the scene.
  var toGal = [0, 1, 2].map(function (r) { return [0, 1, 2].map(function (c) { return G[3 * r] * local[c][0] + G[3 * r + 1] * local[c][1] + G[3 * r + 2] * local[c][2]; }); });
  sk.uToGal.value = _aeStMat3(toGal);
  sk.uMw.value = sk.uMilky.value ? ph.mwStrength * 0.9 : 0;
  st.starUni.uRot.value = _aeStMat3(local);
  st.starUni.uLim.value = ph.lim; st.starUni.uExtinct.value = ph.extinct;
}
// The shadows follow the Sun: a new pass over the vertices once it has moved, a few at a time.
function _aeStandShadeTick(st, fr, now) {
  var sh = st.shade;
  if (!sh) return;
  var cos = fr.sun[0] * sh.sun[0] + fr.sun[1] * sh.sun[1] + fr.sun[2] * sh.sun[2];
  if (!sh.job && Math.acos(Math.min(1, cos)) > AE_STAND_SHADE_MOVE && now - sh.at > AE_STAND_SHADE_EVERY_MS) {
    sh.sun = fr.sun.slice(); sh.at = now;
    sh.job = _aeShadeJob(st.grids, st.meshPos, st.meshCount, sh.sun, Math.tan(fr.sunRho), sh.arr);
  }
  if (sh.job) {
    var done = sh.job.step(AE_STAND_SHADE_SLICE_MS);
    st.shadeAttr.needsUpdate = true;
    if (done) sh.job = null;
    st.dirty = true; _ae.dirty = true;
  }
}
function _aeStandApplyGround(st, fr, ph, view, now) {
  var g = st.ground;
  g.uCam.value = view.pos; g.uPixAng.value = view.pixAng; g.uTime.value = now / 1000;
  g.uAmbient.value = ph.amb; g.uSkyHor.value = ph.hor; g.uSkyZen.value = ph.zen; g.uDiffSky.value = ph.diffSky;
  if (fr.light2) { g.uDir2.value = fr.light2.dir; g.uE2.value = fr.light2.rgb; }
  else g.uE2.value = [0, 0, 0];
}
function _aeStandSprites(st, fr, ph, pixAng, alt) {
  var a = st.atmo, d = a && a.diffuse, air = a && !d ? a : null, hG = st.h0 / 1000, R = st.b.km;
  var list = [{ sun: true, dir: fr.sun, rho: fr.sunRho, E: fr.S, sunFrom: fr.sun, tint: [1, 1, 1], mag: AE_STAND_MAG_SUN }].concat(fr.objs);
  var Z = [0, 0, 1], Y = [0, 1, 0];
  list.forEach(function (o, i) {
    var sp = st.sprites[i];
    if (!sp) return;
    var m = sp.mesh, uni = sp.uni, mu = o.dir[2];
    var trans = [1, 1, 1];
    if (d) { var g = o.sun ? 0 : d.ghost || 0; trans = [g, g, g]; }   // a thick haze hides all but what it is told to let through
    else if (air) {
      var od = _aeStOdUp(air, R, hG, Math.max(mu, 0.0));
      trans = od ? od.map(function (x) { return Math.exp(-x); }) : [0, 0, 0];
      if (mu < 0) trans = [1, 1, 1];   // below the horizon: the ground hides it (from orbit there is only the thin edge of air)
    }
    var right = _aeNorm(_aeCross(o.dir, Math.abs(o.dir[2]) > 0.999 ? Y : Z)), up = _aeCross(right, o.dir);
    var lim = ph.lim, vis = o.sun ? 1 : _aeStStarVis(o.mag + (air ? 0.2 * 1 / (Math.max(mu, 0) + 0.025 * Math.exp(-11 * Math.max(mu, 0))) : 0), lim);
    var ringed = !o.sun && o.key === 'saturn' && st.ringTex, ringRho = ringed ? Math.asin(Math.min(1, AE_STAND_SATURN_RINGS[1] / o.dist)) : 0;
    if (!o.sun && o.rho <= pixAng * 1.2 && vis <= 0.004 && ringRho < pixAng * AE_STAND_RING_PX) { m.visible = false; return; }
    m.visible = true;
    uni.uDir.value = o.dir; uni.uRight.value = right; uni.uUp.value = up; uni.uSunFrom.value = o.sunFrom;
    uni.uTint.value = o.tint; uni.uTrans.value = trans;
    uni.uHalf.value = o.sun ? Math.max(o.rho * 16, pixAng * 8) : Math.max(o.rho * 1.2, ringRho * 1.1, pixAng * 5);
    uni.uRho.value = o.rho; uni.uPix.value = pixAng; uni.uE.value = o.E; uni.uK.value = ph.k;
    uni.uEmit.value = o.sun ? 1 : 0; uni.uVis.value = vis;
    uni.uGlow.value = o.sun ? (air || d ? 0 : 0.18) : 0;
    uni.uSkyLit.value = 1;
    // The body's own map, once it has been looked at long enough to ask for it (a disc of a few pixels is its tint).
    var tex = !o.sun && o.rho > pixAng * AE_STAND_MAP_PX ? _aeStandDiscMap(st, o.key) : null;
    uni.uMap.value = tex; uni.uMapped.value = tex ? 1 : 0; uni.uGrey.value = o.key === AE_STAND_MOON_NAME ? 1 : 0;
    uni.uMapGain.value = (o.alb || 0.3) / AE_STAND_MAP_GAIN_ALBEDO;
    if (o.rows) uni.uBody.value = _aeStMat3(o.rows);
    uni.uRings.value = ringed ? 1 : 0;
    if (ringed) {
      uni.uRingMap.value = st.ringTex; uni.uRp.value = o.km; uni.uRingN.value = o.pole;
      uni.uCen.value = [o.dir[0] * o.dist, o.dir[1] * o.dist, o.dir[2] * o.dist]; uni.uRing.value = AE_STAND_SATURN_RINGS;
    }
  });
  for (var j = list.length; j < st.sprites.length; j++) st.sprites[j].mesh.visible = false;
}
var AE_STAND_MAP_PX = 3;                       // a disc this many pixels across (radius) or more is drawn from its map
var AE_STAND_SATURN_RINGS = [74500, 140220];   // km, the C ring's inside to the A ring's outside (as almanac-earth.js AE_PLANETS)
// The map of a body seen as a disc: the orbit view's own once it has it, else fetched (once; the disc shows it when it is in).
function _aeStandDiscMap(st, key) {
  var S = _ae.gl, tex = null;
  if (key === 'earth') tex = S.earthUni.dayMap.value;
  else if (key === AE_STAND_MOON_NAME) tex = S.moonUni.moonMap.value;
  else if (S.planets && S.planets[key]) tex = S.planets[key].uni.map.value;
  if (tex) return tex;
  var b = _aePlanetBody(key);
  st.discMaps = st.discMaps || {};
  if (b && b.map && !st.discMaps[key]) {
    st.discMaps[key] = true;
    _aeLoadTexture(S.THREE, _aePlanetMapUrl(b)).then(function (t) { if (_ae.stand === st) { st.discMaps[key] = t; st.dirty = true; _ae.dirty = true; _aeKick(); } else t.dispose(); }, function () {});
  }
  return st.discMaps[key] && st.discMaps[key] !== true ? st.discMaps[key] : null;
}
// Where the spacecraft are: a ring and the name, over the picture where they stand in the sky.
function _aeStandCraftMarks(st, fr, view) {
  var host = st.craftHost || (st.craftHost = (function () { var h = document.createElement('div'); h.className = 'ae-stand-crafts'; _ae.el.appendChild(h); return h; })());
  var cam = st.camera, V = _ae.gl.THREE.Vector3, shown = 0, W = _ae.w, H = _ae.h;
  (fr.crafts || []).forEach(function (c) {
    var p = new V(view.pos[0] + c.dir[0] * AE_STAND_CRAFT_RANGE, view.pos[1] + c.dir[1] * AE_STAND_CRAFT_RANGE, view.pos[2] + c.dir[2] * AE_STAND_CRAFT_RANGE).project(cam);
    var on = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && (c.dir[2] > -0.02 || st.altKm > 1);
    var el = host.children[shown];
    if (!on) return;
    if (!el) { el = document.createElement('span'); el.className = 'ae-stand-craft'; host.appendChild(el); }
    if (el._name !== c.name) { el._name = c.name; el.innerHTML = '<i></i>' + _almEsc(c.name); }
    el.hidden = false;
    el.style.transform = 'translate(' + ((p.x + 1) / 2 * W).toFixed(1) + 'px,' + ((1 - p.y) / 2 * H).toFixed(1) + 'px)';
    shown++;
  });
  for (var i = shown; i < host.children.length; i++) host.children[i].hidden = true;
}

// ── Looking around ──
function _aeStandLook(dx, dy) {
  var st = _ae.stand;
  if (!st || !st.live) return;
  if (st.motion && _aeMotionTrim(st, dx, dy, _aeDeg(_aeStandFov()), _ae.h)) { st.dirty = true; _ae.dirty = true; _aeKick(); return; }   // the phone says where; a finger trims
  var k = _aeStandFov() / _ae.h;
  st.userYaw -= dx * k;
  st.userPitch = _aeClamp(st.userPitch + dy * k, -_aeRad(AE_STAND_PITCH_MAX_DEG) - _aeRad(AE_STAND_PITCH_DEG), _aeRad(AE_STAND_PITCH_MAX_DEG) - _aeRad(AE_STAND_PITCH_DEG));
  st.dirty = true; _ae.dirty = true; _aeKick();
}
function _aeStandZoom(factor) {
  var st = _ae.stand;
  if (!st || !st.live) return;
  st.zoom = _aeClamp(st.zoom * factor, AE_STAND_ZOOM_MIN, AE_STAND_ZOOM_MAX);
  st.dirty = true; _ae.dirty = true; _aeKick();
}
var AE_STAND_KEY_TURN_PX = 40, AE_STAND_KEY_ZOOM = 0.9;
function _aeStandKey(e) {
  var turn = { ArrowLeft: [-AE_STAND_KEY_TURN_PX, 0], ArrowRight: [AE_STAND_KEY_TURN_PX, 0], ArrowUp: [0, AE_STAND_KEY_TURN_PX], ArrowDown: [0, -AE_STAND_KEY_TURN_PX] }[e.key];
  if (turn) { _aeStandLook(-turn[0], -turn[1]); return true; }
  if (e.key === '+' || e.key === '=') { _aeStandZoom(AE_STAND_KEY_ZOOM); return true; }
  if (e.key === '-' || e.key === '_') { _aeStandZoom(1 / AE_STAND_KEY_ZOOM); return true; }
  return false;
}

// ── What is on the screen besides the picture ──
var AE_STAND_PHONE_SVG = '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/><path d="M3.5 9v6M20.5 9v6" opacity=".55"/></svg>';
var AE_STAND_BACK_SVG = '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/><path d="M5 4h14" opacity=".55"/></svg>';
var AE_STAND_CSS = [
  '.ae-standing .ae-labels,.ae-standing .ae-lms,.ae-standing .ae-mini,.ae-standing .ae-top,.ae-standing .ae-row,.ae-standing .ae-card,.ae-standing .ae-hint,.ae-standing .ae-orient,.ae-standing .ae-status,.ae-standing .ae-note,.ae-standing .ae-go,.ae-standing .ae-info,.ae-standing .ae-set,.ae-standing .ae-spin,.ae-standing .ae-fullbar{display:none!important}',
  '.ae-standing .ae-canvas{cursor:grab}',
  '.ae-stand-hud{position:absolute;top:0;left:0;right:0;display:flex;align-items:flex-start;gap:10px;padding:12px 16px 24px;background:linear-gradient(rgba(0,0,0,.5),transparent);pointer-events:none;z-index:2}',
  '.ae-stand-hud>*{pointer-events:auto}',
  '.ae-stand-text{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:6px;font-size:13px;line-height:1.3;color:#fff;text-shadow:0 0 4px #000,0 1px 3px #000;pointer-events:none}',
  '.ae-stand-text b{font-weight:600}',
  '.ae-stand-text span{color:rgba(255,255,255,.88)}',
  '.ae-stand-hud .ae-tool-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
  '.ae-stand-crafts{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}',
  '.ae-stand-craft{position:absolute;left:0;top:0;font-size:11px;line-height:1;color:#fff;text-shadow:0 0 3px #000,0 1px 2px #000;white-space:nowrap;will-change:transform}',
  '.ae-stand-craft i{position:absolute;left:-5px;top:-5px;width:10px;height:10px;border:1.5px solid '+"' + AE_AMBER_HEX + '"+';border-radius:50%;box-sizing:border-box}',
  '.ae-stand-craft{padding-left:9px;margin-top:-5px}',
  '.ae-stand-craft[hidden]{display:none}',
  '.ae-pick{position:absolute;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid ' + AE_AMBER_HEX + ';border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.6);pointer-events:none;will-change:transform}',
  '.ae-pick[hidden]{display:none}'
].join('\n');
function _aeStandCss() {
  if (_aeById('ae-stand-style')) return;
  var s = document.createElement('style');
  s.id = 'ae-stand-style';
  s.textContent = AE_STAND_CSS;
  document.head.appendChild(s);
}
_aeStandCss();
function _aeStandHud(st) {
  var hud = document.createElement('div');
  hud.className = 'ae-stand-hud';
  var back = _aeT('alm_stand_back');
  hud.innerHTML = '<button type="button" class="ae-btn ae-round" id="ae-stand-back" aria-label="' + _almEsc(back) + '" title="' + _almEsc(back) + '">' + AE_STAND_BACK_SVG + '</button>' +
    '<div class="ae-stand-text" id="ae-stand-text" aria-live="off"></div>';
  _ae.el.appendChild(hud);
  st.hud = hud;
  _aeById('ae-stand-back').onclick = function () { _aeStandLeave(); };
  _aeStandMotionButton(st, hud);
  _aeStandHudText(st);
  var cv = _aeById('ae-canvas');
  if (cv) cv.setAttribute('aria-label', _aeT('alm_stand_aria', { body: _aeInfoName(st.key) }));
}
// The phone as the way to look round (almanac-standlook.js): a button where the phone has sensors; kept, and where nothing asks, on again.
function _aeStandMotionButton(st, hud) {
  if (typeof _aeMotionAvailable !== 'function' || !_aeMotionAvailable() || !('ontouchstart' in window || navigator.maxTouchPoints > 0)) return;
  var label = _aeT('alm_stand_motion'), b = document.createElement('button');
  b.type = 'button'; b.className = 'ae-btn ae-round ae-stand-motion'; b.id = 'ae-stand-motion';
  b.setAttribute('aria-label', label); b.setAttribute('title', label); b.setAttribute('aria-pressed', 'false');
  b.innerHTML = AE_STAND_PHONE_SVG;
  hud.appendChild(b);
  var set = function (on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); };
  b.onclick = function () {
    if (st.motion) { _aeMotionStop(st); set(false); st.userYaw = st.userPitch = 0; st.dirty = true; _ae.dirty = true; _aeKick(); return; }
    _aeMotionStart(st).then(set);
  };
  if (_aeMotionKept() && !_aeMotionAsks()) _aeMotionStart(st).then(set);
}
function _aeStandHudText(st) {
  var el = _aeById('ae-stand-text'), fr = st.fr;
  if (!el) return;
  var line2 = (fr ? '☀ ' + Math.round(fr.sunAlt) + '°' : '') + ' · ' + Math.round(((st.yaw + st.userYaw) * 180 / Math.PI % 360 + 360) % 360) + '°';
  var html = '<b>' + _almEsc(_aeInfoName(st.key)) + '</b><span>' + _almEsc(_aeFmtLatLon({ lat: st.lat, lon: st.lon })) + ' · ' + _almEsc(_aeStHeightText(st.h0)) + '</span><span>' + _almEsc(line2) + '</span>';
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}
// A height above the mean radius, short: metres under a kilometre.
function _aeStHeightText(m) {
  var mi = _aeImperial();
  if (Math.abs(m) < 1000) return _orrNum(mi ? m * 3.28084 : m, mi ? 'foot' : 'meter', 0);
  return _aeLenText(m / 1000, 1);
}

// ── The card for a tapped spot ──
// A tap on the body already in view, on its surface: the place, its height, and the way down.
function _aeStandPick(body, x, y) {
  if (!_aeStandable(body) || body !== _ae.target || _ae.fly) return false;
  var hit = _aeStHit(body, x, y);
  if (!hit) return false;
  _ae.lm = null; _ae.place = null;
  _ae.pick = { body: body, lat: hit.lat, lon: hit.lon };
  _aeTerrainLoad(body).then(function () { if (_ae && _ae.pick && _ae.pick.body === body) _aeRenderCard(); });
  if (_ae.arrived !== body) _aeArrive(body);
  else _aeRenderCard();
  _ae.dirty = true; _aeKick();
  return true;
}
// Where the ray through a point of the screen meets the body: latitude and longitude, or null.
function _aeStHit(body, x, y) {
  var S = _ae.gl, cam = S.camera, V = S.THREE.Vector3, frame = _aeStBodyNow(body), centre = _aeBodyPos(body);
  if (!frame || !centre) return null;
  var o = [cam.position.x, cam.position.y, cam.position.z];
  var p = new V((x / _ae.w) * 2 - 1, -(y / _ae.h) * 2 + 1, 0.5).unproject(cam);
  var d = _aeNorm([p.x - o[0], p.y - o[1], p.z - o[2]]);
  var toFixed = function (v) { var f = frame.f; return [_aeDot(f.x, v), _aeDot(f.y, v), _aeDot(f.z, v)]; };
  var oc = _aeSub(o, centre);
  if (body === 'earth') {
    var h = _aeRayEllipsoid(toFixed(oc), toFixed(d));
    return h ? _aeFixedToGeodetic(h) : null;
  }
  var r = AE_TARGETS[body].surface, b = _aeDot(oc, d), c = _aeDot(oc, oc) - r * r, D = b * b - c;
  if (D < 0) return null;
  var t = -b - Math.sqrt(D);
  if (t < 0) return null;
  var q = _aeNorm(toFixed(_aeAdd(oc, _aeScale(d, t))));
  return { lat: _aeDeg(Math.asin(_aeClamp(q[2], -1, 1))), lon: _aeDeg(Math.atan2(q[1], q[0])) };
}
function _aeRenderPickCard(card) {
  var pk = _ae.pick, h = _aeStandHeight(pk.body, pk.lat, pk.lon);
  var t = _aeTerr[pk.body], known = t && t.state === 'ready';
  card.innerHTML = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
    '<h3>' + _almEsc(_aeFmtLatLon(pk)) + '</h3>' +
    '<p class="ae-lm-line"><span>' + _almEsc(known ? _aeStHeightText(h) : '') + '</span></p>' +
    '<p>' + _aeStandButtonHtml() + '</p>';
  card.hidden = false;
  _aeById('ae-card-x').onclick = function () { _ae.pick = null; _aeRenderCard(); _aeStandMarkPick(); };
  _aeStandBindButtons(card, function () { return pk; });
  _aeStandMarkPick();
}
// The ring on the surface where the tap landed, kept there as the view moves.
function _aeStandMarkPick() {
  var host = _aeById('ae-labels') || (_ae && _ae.el), dot = _aeById('ae-pick');
  if (!_ae || !_ae.pick || _ae.stand) { if (dot) dot.hidden = true; return; }
  if (!dot) {
    dot = document.createElement('i');
    dot.className = 'ae-pick'; dot.id = 'ae-pick';
    host.appendChild(dot);
  }
  var pk = _ae.pick, frame = _aeStBodyNow(pk.body), centre = _aeBodyPos(pk.body);
  if (!frame || !centre) { dot.hidden = true; return; }
  var n = _aeStToScene(frame, _aeUnitVec(pk.lat, pk.lon)), r = AE_TARGETS[pk.body].surface, p = _aeAdd(centre, _aeScale(n, r));
  var cam = _ae.gl.camera, eye = [cam.position.x, cam.position.y, cam.position.z], s = _aeProject(p);
  if (!s || _aeDot(n, _aeSub(eye, p)) <= 0) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.style.transform = 'translate(' + s.x.toFixed(1) + 'px,' + s.y.toFixed(1) + 'px)';
}
