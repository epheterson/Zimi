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
var AE_STAND_FOV_MIN_DEG = 50, AE_STAND_FOV_MAX_DEG = 85, AE_STAND_HFOV_DEG = 64, AE_STAND_ZOOM_MIN = 0.06, AE_STAND_ZOOM_MAX = 1.6;
var AE_STAND_PITCH_MAX_DEG = 89;
var AE_STAND_DPR_MAX = 1.5;                // the sky is computed per pixel: a phone draws it at most this sharp
var AE_STAND_FRAME_MS = 1500;              // the sky is worked out again when the clock has moved this much (sooner while it runs fast)
var AE_STAND_HUD_MS = 400;
var AE_STAND_SUN_FACE_DEG = -6;            // the view faces the Sun when it is above this
var AE_STAND_GROUND_AMBIENT_SHARE = 0.8;   // the ground takes this much of the sky's light at its brightest
var AE_STAND_NEAR_SUN_SHARE = 0.35;       // the exposure is set by the brightest sky short of the Sun's own glare: this much of the sky a little over it
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
function _aeStandStart(key, lat, lon, handoff) {
  if (!_aeStandable(key)) return Promise.resolve(false);
  if (_ae && _ae.stand) _aeStandDrop();
  return _aeStandViewUp().then(function (up) {
    if (!up) return false;
    if (handoff && handoff.ms !== undefined && handoff.ms !== null && typeof _aeGoTo === 'function') _aeGoTo(handoff.ms);
    // A body with no place for this date (a dwarf planet whose table does not reach it) has no sky to stand under.
    var frame = _aeStBodyNow(key);
    if (!frame) return false;
    var pend = _ae.standPending = { key: key, lat: lat, lon: lon, ready: false, t0: performance.now(), builder: null, mesh: null, tex: null, handoff: handoff || null };
    _ae.pick = null; _ae.lm = null; _ae.place = null; _ae.selected = null;
    _aeRenderCard();
    var body = AE_STAND_BODIES[key];
    // The flight comes to the nearest the orbit view lets the camera go over the place, looking straight down at it; the
    // ground is built meanwhile, and the swap to it happens where that flight ends.
    var minDist = AE_TARGETS[key].min, surface = AE_TARGETS[key].surface;
    pend.alt0 = Math.max(30, (minDist - surface) * AE_EARTH_RADIUS_KM);
    _aeStandBuild(pend, body);
    _aeFlyTo(key, minDist, _aeAzElOf(_aeStToScene(frame, _aeStPlaceVec(key, lat, lon))));
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
var AE_STAND_HD_WAIT_MS = 1500;   // the most the ground waits for HD terrain tiles before it is built on what it has
function _aeStandPendAlive(pend) { return !pend.dead && (pend.host || _ae.standPending === pend); }
function _aeStandBuild(pend, body) {
  _aeTerrainLoad(pend.key).then(function () {
    if (!_aeStandPendAlive(pend)) return;
    var man = _ae.gl && _ae.gl.hd && _ae.gl.hd.man, layer = man && man.layers && man.layers[AE_TERRAIN_HD_LAYER + pend.key];
    // Each ZIM of the set stamps its layers with its own folder. The first frame never waits on the finer tiles: what has arrived by AE_STAND_HD_WAIT_MS is used, and the rest
    // fills the cache (a slow or dead tile server leaves the core's heights, not a ground that never comes).
    if (!layer) return null;
    var hdLoad = _aeTerrainHdLoad(pend.key, pend.lat, pend.lon, layer, layer.max);
    return Promise.race([hdLoad, new Promise(function (res) { setTimeout(res, AE_STAND_HD_WAIT_MS); })]);
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
// A place (geodetic latitude, longitude) in the body's own frame, in the body's equatorial radii: for the Earth the point of
// its flattened globe, the very point a landmark's pin and a visit's origin (almanac-sites.js _asFrame) take, so the flight
// aims at what the map shows; for a round body the unit vector.
function _aeStPlaceVec(key, lat, lon) {
  if (key !== 'earth') return _aeUnitVec(lat, lon);
  var v = _aeLatLonVec(lat, lon, AE_EARTH_FLATTENING);
  return [v[0], v[1], v[2] * (1 - AE_EARTH_FLATTENING)];
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
// The Almanac's clock chip tells the time where one stands, the same zone as the header's (almanac.js _almClockParts asks _almClockZone).
function _aeStandClockZone(st) {
  if (typeof window === 'undefined') return;
  var tz = null;
  if (st && st.key === 'earth' && typeof _almTzForLocation === 'function') { try { tz = _almTzForLocation(st.lat, st.lon); } catch (e) {} }
  window._almClockZone = tz ? function () { return { tz: tz }; } : null;
  if (typeof _almClockPaint === 'function') { try { _almClockPaint(); } catch (e) {} }
}
function _aeStandEnter(st) {
  var S = _ae.gl, el = _ae.el;
  st.live = true;
  el.classList.add('ae-standing');
  _aeStandClockZone(st);
  _aeStandHud(st);
  _aeFullStepIn();
  S.renderer.setClearColor(0x000000, 1);
  st.prevRatio = S.renderer.getPixelRatio();
  S.renderer.setPixelRatio(Math.min(S.dpr, _aeStandRatioCap()));
  _aeResize();
  var fr = _aeStFrame(st, _aeDisplayMs());
  st.yaw = st.key === 'earth' ? _aeRad(_aeStandDefaultHeading(st.lat)) : fr.sunAlt > AE_STAND_SUN_FACE_DEG ? fr.sunAz : 0;   // on Earth the card's own rule (toward the equator), elsewhere the Sun's side; a hand-off's heading, below, wins
  var ho = st.pend && st.pend.handoff;
  if (ho) {   // a hand-off from the live sky card: its facing, not the Sun's
    st.handoff = ho;
    if (typeof ho.heading === 'number') st.yaw = _aeRad(ho.heading);
    if (typeof ho.pitch === 'number') st.userPitch = _aeRad(ho.pitch) - _aeRad(AE_STAND_PITCH_DEG);
  }
  st.yaw0 = 0;
  if (st.key === 'earth') setTimeout(function () { if (_ae.stand === st || (_ae.site && _ae.site.host && _ae.site.host.st === st)) _aeStandTrees(st); }, AE_STAND_TREES_DELAY_MS);
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
  _aeStandClockZone(null);
  if (_ae) _ae.standPending = null;
  if (!closing) setTimeout(_aeStandAfterClose, 0);   // the way back, when _aeStandClose asked for it
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
  scene.add(st.skyBlit);
  // The stars: the Bright Star Catalogue as it arrives (the page's 518 first).
  st.starUni = { uRot: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, uLim: { value: 7 }, uExtinct: { value: 0 }, uDpr: { value: S.renderer.getPixelRatio() }, uStarScale: { value: 1 } };
  st.skyPtMat = mat(AE_ST_SKYOBJ_VERT, AE_ST_STARS_FRAG, st.starUni, { depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  st.skyLineMat = mat(AE_ST_SKYOBJ_VERT, AE_ST_SKYLINE_FRAG, st.starUni, { depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
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
  // The same sky drawn small into a target, and a triangle that stretches it back: the air is smooth, the ground stays sharp.
  var low = new THREE.Mesh(tri, sky.material);
  low.frustumCulled = false;
  st.skyLowMesh = low; st.skyMatOwn = sky.material;
  st.skyScene = new THREE.Scene(); st.skyScene.add(low);
  var blit = st.skyBlit = new THREE.Mesh(tri, new THREE.ShaderMaterial({ uniforms: { tSky: { value: null }, uRes: { value: [1, 1] }, uTexel: { value: [1, 1] } }, vertexShader: AE_ST_SKY_VERT, fragmentShader: AE_ST_BLIT_FRAG, depthTest: false, depthWrite: false }));
  blit.frustumCulled = false; blit.renderOrder = -3; blit.visible = false;
  st.mats.push(blit.material);
  _aeLoadTexture(THREE, SG_MILKYWAY_URL).then(function (t) { uni.uMilky.value = t; st.dirty = true; if (_ae) { _ae.dirty = true; _aeKick(); } }, function () {});
  return sky;
}
// The Sun and the others: a quad each, shown as the sky needs them.
function _aeStandSpriteMeshes(st, mat) {
  var THREE = _ae.gl.THREE, quad = new THREE.BufferGeometry(), out = [];
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  st.geo.push(quad);
  st.sprites = [];
  var ouni = { uDir: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uHalf: { value: 0.01 }, uRho: { value: 0.001 }, uPix: { value: 0.001 }, uDark: { value: 0 } };
  st.moonOcc = new THREE.Mesh(quad, new THREE.ShaderMaterial({ uniforms: ouni, vertexShader: AE_ST_BODY_VERT, fragmentShader: AE_ST_OCC_FRAG, transparent: true, depthTest: false, depthWrite: false }));
  st.moonOcc.frustumCulled = false; st.moonOcc.renderOrder = -1.2; st.moonOcc.visible = false; st.moonOccUni = ouni;
  out.push(st.moonOcc); st.mats.push(st.moonOcc.material);
  for (var i = 0; i < AE_STAND_SPRITES; i++) {
    var uni = { uDir: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uSunFrom: { value: [0, 0, 1] }, uTint: { value: [1, 1, 1] }, uTrans: { value: [1, 1, 1] },
      uHalf: { value: 0.01 }, uRho: { value: 0.001 }, uPix: { value: 0.001 }, uE: { value: 1 }, uK: { value: 1 }, uEmit: { value: 0 }, uVis: { value: 0 }, uGlow: { value: 0 }, uSkyLit: { value: 1 },
      uMap: { value: null }, uMapped: { value: 0 }, uGrey: { value: 0 }, uMapGain: { value: 1 }, uBody: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      uPointScale: { value: 1 }, uOcc: { value: [0, 0, 0] }, uCorona: { value: 0 }, uSeed: { value: 0 }, uRingMap: { value: null }, uRings: { value: 0 }, uRp: { value: 1 }, uRingN: { value: [0, 0, 1] }, uCen: { value: [0, 1, 0] }, uRing: { value: [0, 1] } };
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
    uLommel: { value: a ? 0 : 1 }, uRough: { value: AE_STAND_ROUGH[st.key] || (st.b.fbm.amp > 100 ? 1.3 : 1) }, uRock: { value: AE_STAND_ROCK[st.key] || 0.25 }, uDetail: { value: st.key === 'earth' ? 1 : 0 }, uCloudDim: { value: 1 }, uKg: { value: 1 }, uGrass: { value: 0 }, uTundra: { value: 0 }, uCanopy: { value: 0 }, uHead: { value: [0, 1] }, uCover: { value: st.key === 'earth' ? 1 : 0 },
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
var AE_STAND_TINT = { mars: [1.9, 0.85, 0.34], titan: [4.2, 3.0, 1.6], earth: [2.2, 2.2, 2.2] };
var AE_STAND_SKY_SCALE = 0.5;              // the sky is drawn at this share of the screen's size and stretched (the ground is not)
var AE_STAND_SKY_BY_LEVEL = [0.33, 0.5, 0.75];   // ... by capability level's skyQuality (capability.js): a light device draws it smaller, a roomy one sharper
function _aeStandSkyScale() { return typeof ZimiCap !== 'undefined' ? AE_STAND_SKY_BY_LEVEL[ZimiCap.get('skyQuality')] : AE_STAND_SKY_SCALE; }
// How much of the instanced detail (grass tufts, trees) this device draws, 0..1, by the level's materialDetail (all of it without capability.js).
var AE_STAND_DETAIL_BY_LEVEL = [0.3, 0.7, 1];
function _aeStandDetail() { return typeof ZimiCap !== 'undefined' ? AE_STAND_DETAIL_BY_LEVEL[ZimiCap.get('materialDetail')] : 1; }
var AE_STAND_DPR_STEPS = [1.5, 1.25, 1, 0.75];   // the pixel ratios the ground view steps down through if frames run long
var AE_STAND_SLOW_MS = [20, 250], AE_STAND_SLOW_RUN = 3;   // a frame this slow (not an idle gap) three times running drops a step
var _aeStandDprCap = AE_STAND_DPR_MAX;     // for the rest of the session: it goes down, never back up (without capability.js)
// The pixel ratio Stand here draws at: the capability level's, under the one governor (capability.js), else the steps below.
function _aeStandRatioCap() { return typeof ZimiCap !== 'undefined' ? ZimiCap.dprCap('stand') : _aeStandDprCap; }
var AE_STAND_STATION_MIN_LIM = 3;           // the station is marked once the sky is dark enough for stars of this magnitude
var AE_STAND_PROBE_MARKS = false;          // deep-space probes are pinpoints nobody could see: not marked (the station's pass is, near Earth)
var AE_STAND_SKY_MATCH_SHARE = 0.55;      // and how far (in log) toward it: a view with sunlit ground in it cannot be exposed for the sky alone
var AE_STAND_SKY_MATCH_DEG = [-20, 6];     // the Sun's height over which the Earth's exposure goes from this view's own to the 2D sky's
var AE_STAND_GROUND_OWN_K_DEG = [-6, 10];   // the Sun heights between which the ground's exposure goes from the provider's to this view's own
var AE_STAND_NIGHT_GLOW = 9e-7;           // the least light the Earth's ground has (starlight and airglow, in this view's units: the Sun at the Earth is 1): a dark-adapted eye makes out the ground and its horizon
var AE_STAND_SLICE_MS = 8;                 // a slice of building between breaths of the page
var AE_STAND_SHADE_LOD = 1.5;              // the shadow grids hold wavelengths down to this many cells
var AE_STAND_SHADE_MOVE = 0.0044, AE_STAND_SHADE_EVERY_MS = 300, AE_STAND_SHADE_SLICE_MS = 5;   // the Sun has moved a quarter degree; not again sooner than this; the work a frame
var AE_STAND_BASE = { ceres: [0.5, 0.48, 0.45] };
var AE_STAND_ROUGH = { earth: 0.25 };   // the fine bumps' scale: the Earth's ground is turf and soil, not regolith
var AE_STAND_ROCK = { earth: 0.015, moon: 0.28, mercury: 0.28, venus: 0.4, mars: 0.4, io: 0.2, europa: 0.08, ganymede: 0.22, callisto: 0.3, titan: 0.3, pluto: 0.15 };
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
  if (st.skyRT) st.skyRT.dispose();
  if (st.msaa) { st.msaa.rt.dispose(); st.msaa.mat.dispose(); st.msaa = null; }
  if (st.skyMatAir) st.skyMatAir.dispose();
  if (st.cloudMesh) st.cloudMesh.material.dispose();
  if (st.skyPts) st.skyPts.mesh.geometry.dispose();
  if (st.skyLines) st.skyLines.mesh.geometry.dispose();
  if (st.skyTag && st.skyTag.parentNode) st.skyTag.parentNode.removeChild(st.skyTag);
  clearTimeout(st.skyTagTimer);
  st.geo = st.mats = null; st.scene = st.camera = null;
}

// ── Trees ──
// Where the Blue Marble says forest (a dark green), below the trees' line, not in the sea: dark cones scattered in rings out to a few
// kilometres, a tree to a few metres at the feet and a wood at the horizon. The same trees every visit to a place (seeded by it).
var AE_STAND_TREES_DELAY_MS = 40, AE_STAND_TREES_MAX = 3200, AE_STAND_TREES_TRIES = 18000;
var AE_STAND_TREES_RANGE_M = [60, 4500], AE_STAND_TREES_THIN_M = [60, 380];   // out to here; thinner near the viewer (nothing at all inside the first number's reach)
var AE_STAND_TREE_KINDS = { conifer: 0, broadleaf: 1, palm: 2, trunk: 3, shrub: 4 };   // what the shader colours by
function _aeStCoverPixels(tex) {   // the colour map's pixels, once
  if (!tex || !tex.image) return null;
  var im = tex.image, w = im.width || im.naturalWidth, h = im.height || im.naturalHeight;
  if (!w || !h) return null;
  var c = document.createElement('canvas'), mw = Math.min(w, 2048), mh = Math.round(mw * h / w);
  c.width = mw; c.height = mh;
  var cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(im, 0, 0, mw, mh);
  return { w: mw, h: mh, d: cx.getImageData(0, 0, mw, mh).data };
}
function _aeStForest(px, lat, lon) {   // 0..1: how much of this place the map shows as forest (the bitmap is flipped, south first, as the ground's own lookup assumes)
  var x = Math.min(px.w - 1, Math.max(0, Math.floor((lon + 180) / 360 * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor((lat + 90) / 180 * px.h))), i = 4 * (y * px.w + x);
  var r = px.d[i] / 255, g = px.d[i + 1] / 255, b = px.d[i + 2] / 255, lum = 0.3 * r + 0.59 * g + 0.11 * b;
  if (g < r * 1.02 || g < b * 1.08) return 0;
  return Math.max(0, Math.min(1, (0.42 - lum) / 0.2));
}
// What grows where: firs and spruce in the north and the mountains (20 to 40 m), round-crowned broadleaves in the temperate lowlands
// (10 to 25 m), palms in the tropics (8 to 18 m); nothing where the map is not green, above the tree line or beyond the high latitudes.
var AE_STAND_GRASS_TREES = 0.08, AE_STAND_FOREST_TREES = 0.6;   // the share of a grass cell's sites that hold a tree, and the least of a forest cell's
// Bare ground the map shows dark and grey (lava, scree, burn): 0..1. Grass and trees thin out on it whatever the class says.
function _aeStRock(px, lat, lon) {
  var x = Math.min(px.w - 1, Math.max(0, Math.floor((lon + 180) / 360 * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor((lat + 90) / 180 * px.h))), i = 4 * (y * px.w + x);
  var r = px.d[i] / 255, g = px.d[i + 1] / 255, b = px.d[i + 2] / 255, hi = Math.max(r, g, b), lo = Math.min(r, g, b), lum = 0.3 * r + 0.59 * g + 0.11 * b, sat = hi > 0.02 ? (hi - lo) / hi : 0;
  return Math.max(0, Math.min(1, (0.3 - lum) / 0.15)) * Math.max(0, Math.min(1, (0.28 - sat) / 0.14));
}
function _aeStTreeKind(lat, h, rnd, cls) {
  var a = Math.abs(lat);
  if (a > 66) return null;
  if (a < 24) return rnd() < 0.3 ? 'palm' : 'broadleaf';
  if (cls === 'conifer') return rnd() < 0.92 ? 'conifer' : 'broadleaf';   // the grid's own word for the cell, over the latitude's guess
  if (cls === 'broadleaf') return rnd() < 0.92 ? 'broadleaf' : 'conifer';
  if (cls === 'grass') return 'broadleaf';   // the tropics: broadleaves and palms up to the tree line (the caller stops there), never firs
  if (a > 44 || h > 1100) return rnd() < 0.9 ? 'conifer' : 'broadleaf';
  return rnd() < 0.7 ? 'broadleaf' : 'conifer';
}
// A round crown: two or three overlapping lobes, each a squat ball of rings whose normals point away from its centre (so it shades as a
// ball, not a gem), the lobes at slightly different heights and widths.
function _aeStCrown(tri, t, sd, kind) {
  var lobes = sd > 0.5 ? 3 : 2, n = 6;
  for (var l = 0; l < lobes; l++) {
    var ang = (l / lobes) * 2 * Math.PI + sd * 9, off = l === 0 ? 0 : t.h * 0.11 * t.w;
    var cx = t.x + t.lean * t.h * 0.6 + Math.cos(ang) * off, cy = t.y + Math.sin(ang) * off, cz = t.z + t.h * (0.64 + (l ? (l % 2 ? 0.08 : -0.06) : 0.03));
    var rx = t.h * (l ? 0.2 : 0.27) * t.w, rz = rx * 0.82, ctr = [cx, cy, cz];
    var lv = [[0.0, 1.0], [0.5, 0.88], [-0.15, 1.0], [-0.65, 0.62]], rings = [];   // (height share of rz, radius share of rx)
    lv.forEach(function (q, ri) {
      var ring = [];
      for (var s = 0; s < n; s++) { var an = s / n * 2 * Math.PI + sd * 6 + ri * 0.3, w = 0.82 + 0.3 * ((s * 5 + ri * 3 + Math.floor(sd * 60)) % 5) / 4; ring.push([cx + Math.cos(an) * rx * q[1] * w, cy + Math.sin(an) * rx * q[1] * w, cz + rz * q[0]]); }
      rings.push(ring);
    });
    var top = [cx, cy, cz + rz * 1.05], bot = [cx, cy, cz - rz * 0.8], f = [1.0, 0.85, 0.62, 0.4];
    var smooth = function (a, b, c, fa, fb, fc) { tri(a, b, c, ctr, kind, sd, fa, fb, fc, true); };
    for (var s = 0; s < n; s++) {
      var s2 = (s + 1) % n;
      smooth(rings[0][s], rings[0][s2], top, f[1], f[1], 1.0);
      for (var r = 0; r < 3; r++) {
        smooth(rings[r][s], rings[r + 1][s], rings[r][s2], f[r + 1], f[r + 2 > 3 ? 3 : r + 2], f[r + 1]);
        smooth(rings[r][s2], rings[r + 1][s], rings[r + 1][s2], f[r + 1], f[r + 2 > 3 ? 3 : r + 2], f[r + 2 > 3 ? 3 : r + 2]);
      }
      smooth(rings[3][s2], rings[3][s], bot, f[3], f[3], 0.3);
    }
  }
}
// Open country's trees stand in clumps and along draws, not scattered: a density (0..1) at a place round the viewer from two slow noises.
var AE_STAND_SHRUB_NEAR_M = [15, 60];
var AE_STAND_SHRUBS = 0.05;   // the share of a dry cell's sites that hold a shrub, in clumps
function _aeStShrubs(x, y) { var clump = Math.max(0, _aeNoise3(x / 90, y / 90, 7.5, 61)); return Math.min(0.6, AE_STAND_SHRUBS * (0.5 + 10 * clump * clump)); }
var AE_STAND_GRASS_NEAR_MIN = 24, AE_STAND_SAVANNA_THIN_M = [60, 130];   // open country: trees from 60 m, in their full number by 130
function _aeStSavanna(x, y) {
  var clump = Math.max(0, _aeNoise3(x / 140, y / 140, 0.5, 31)), draw = Math.exp(-Math.pow(_aeNoise3(x / 260, y / 260, 3.5, 47) / 0.07, 2));
  return Math.min(0.85, AE_STAND_GRASS_TREES * (0.25 + 9 * clump * clump) + 0.5 * draw);
}
// The class's ground: grass pulled green and the distant woods' texture, by the cell the viewer stands in; and the tufts of grass round the feet.
var AE_STAND_GRASS_COUNT = 18000, AE_STAND_GRASS_RANGE_M = [1.0, 15], AE_STAND_GRASS_DENSITY = { grass: 1, broadleaf: 0.5, conifer: 0.35, tundra: 0.2, desert: 0.22 };
function _aeStandGround(st, land, px) {
  var g = st.ground, cls = land && land.cls;
  var rock = px ? _aeStRock(px, st.lat, st.lon) : 0;   // lava and scree under a green class: next to no grass
  g.uGrass.value = cls === 'grass' ? 1 - rock : 0;
  g.uTundra.value = cls === 'tundra' ? 1 : 0;
  g.uCanopy.value = cls === 'broadleaf' ? 0.9 : cls === 'conifer' ? 1 : cls === 'grass' ? 0.3 : 0;
  var dens = (land ? (AE_STAND_GRASS_DENSITY[cls] || 0) * (land.coast ? 0.6 : 1) : 0.4) * (1 - 0.95 * rock);
  if (dens > 0) _aeStandGrass(st, dens, cls, px);
}
function _aeStandGrass(st, dens, cls, px) {
  if (st.grass) return;
  var THREE = _ae.gl.THREE, R = st.b.km * 1000, lat0 = st.lat, lon0 = st.lon, h0 = st.h0;
  var seed = (Math.round(lat0 * 1e4) * 19349663) ^ (Math.round(lon0 * 1e4) * 83492791), rnd = function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  var n = Math.round(AE_STAND_GRASS_COUNT * dens * _aeStandDetail()), P = [], N = [], T = [], lo = AE_STAND_GRASS_RANGE_M[0], hi = AE_STAND_GRASS_RANGE_M[1];
  for (var i = 0; i < n; i++) {
    var r = lo + (hi - lo) * Math.pow(rnd(), 0.8), th = rnd() * 2 * Math.PI, x0 = r * Math.sin(th), y0 = r * Math.cos(th);
    var fade = 1 - Math.min(1, Math.max(0, (r - 8) / (hi - 8))), tall = (cls === 'tundra' ? 0.04 : 0.05 + 0.1 * rnd()) * fade;   // the tufts shrink away into the texture by the range's end
    if (tall < 0.03) continue;
    var z0 = _aeTerrainLocal('earth', lat0, lon0, h0, x0, y0, r * 0.0005, st.pend && st.pend.flat), sd = rnd(), blades = 4;
    for (var b = 0; b < blades; b++) {
      var ang = rnd() * 2 * Math.PI, w = 0.008 + 0.007 * rnd(), hh = tall * (0.6 + 0.6 * rnd()), lean = 0.08 + 0.25 * rnd(), lx = Math.cos(ang) * lean * hh, ly = Math.sin(ang) * lean * hh;
      var bx = x0 + (rnd() - 0.5) * 0.25, by = y0 + (rnd() - 0.5) * 0.25, px2 = -Math.sin(ang + 1.2) * w, py2 = Math.cos(ang + 1.2) * w;
      var nx = Math.cos(ang) * 0.3, ny = Math.sin(ang) * 0.3;
      [[bx - px2, by - py2, z0, 0], [bx + px2, by + py2, z0, 0], [bx + lx, by + ly, z0 + hh, 1]].forEach(function (q) { P.push(q[0], q[1], q[2]); N.push(nx, ny, 0.95); T.push(q[3], sd, 0); });
    }
  }
  if (!P.length) return;
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3)); g.setAttribute('aNrm', new THREE.BufferAttribute(new Float32Array(N), 3)); g.setAttribute('aTree', new THREE.BufferAttribute(new Float32Array(T), 3));
  // The blades take the ground's own colour at the place (the Blue Marble's, pulled green for a grass cell, as the ground's shader does) in linear light.
  var rgb = _aeStGrassColour(st, px, cls);
  var uni = Object.assign({}, st.ground, { uGrassAlb: { value: rgb }, uSway: { value: _aeReduceMotion() ? 0 : 1 } });
  var m = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_ST_GRASS_VERT, fragmentShader: AE_ST_GRASS_FRAG, side: AE_THREE_DOUBLE_SIDE });
  var mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.renderOrder = 1;
  st.scene.add(mesh); st.grass = { mesh: mesh, count: P.length / 9 };
  st.geo.push(g); st.mats.push(m);
  st.dirty = true; _ae.dirty = true; _aeKick();
}
function _aeStGrassColour(st, px, cls) {
  var c = cls === 'desert' ? [0.3, 0.24, 0.12] : [0.2, 0.28, 0.1];   // a green meadow's albedo (a dry cell's tufts are straw), linear
  if (cls === 'desert') return c;
  if (px) {
    var x = Math.min(px.w - 1, Math.max(0, Math.floor((st.lon + 180) / 360 * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor((st.lat + 90) / 180 * px.h))), i = 4 * (y * px.w + x);
    var lin = [px.d[i] / 255, px.d[i + 1] / 255, px.d[i + 2] / 255].map(function (v) { return Math.pow(v, 2.2); }), l = 0.3 * lin[0] + 0.59 * lin[1] + 0.11 * lin[2];
    var dull = lin[1] < Math.max(lin[0], lin[2]) * 1.05;
    c = dull || cls === 'grass' ? [0.72 * l * 0.85, 1.0 * l * 0.85, 0.42 * l * 0.85].map(function (v, k) { return 0.5 * v + 0.5 * [0.2, 0.28, 0.1][k] * Math.min(1, l / 0.25 + 0.4); }) : lin;
  }
  return c.map(function (v) { return Math.min(0.5, Math.max(0.01, v * 1.3)); });   // blades are lit: paler than the soil and the matted turf round their roots
}
function _aeStandTrees(st) {
  if (!st || !st.scene || st.trees || st.key !== 'earth') return;
  var px = null;
  try { px = _aeStCoverPixels(st.pend && st.pend.tex); } catch (e) { px = null; }
  if (!px) return;
  // What the land is comes from the one grid the live sky card reads too (almanac-oneland.js); wait for it once, then go on without it if it cannot be had.
  if (typeof _osLandCoverLoad === 'function' && _osLandCover(st.lat, st.lon) === null && !st.landWait) {
    st.landWait = true;
    _osLandCoverLoad().then(function () { _aeStandTrees(st); });
    return;
  }
  var R = st.b.km * 1000, h0 = st.h0, lat0 = st.lat, lon0 = st.lon, THREE = _ae.gl.THREE;
  var seed = (Math.round(lat0 * 1e4) * 73856093) ^ (Math.round(lon0 * 1e4) * 19349663), rnd = function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  var landAt = typeof _osLandCover === 'function' ? _osLandCover(lat0, lon0) : null;
  var dry = !!landAt && landAt.cls === 'desert', lo = dry ? AE_STAND_SHRUB_NEAR_M[0] : AE_STAND_TREES_RANGE_M[0];   // shrubs are low: seen from 15 m, not 60
  var list = [], ratio = AE_STAND_TREES_RANGE_M[1] / lo, thin = dry ? AE_STAND_SHRUB_NEAR_M : landAt && landAt.cls === 'grass' ? AE_STAND_SAVANNA_THIN_M : AE_STAND_TREES_THIN_M;
  for (var k = 0, maxTrees = Math.round(AE_STAND_TREES_MAX * _aeStandDetail()); k < AE_STAND_TREES_TRIES && list.length < maxTrees; k++) {
    var r = lo * Math.pow(ratio, rnd()), th = rnd() * 2 * Math.PI, d = _aeDestination(lat0, lon0, r / R, th);
    var near = Math.max(0, Math.min(1, (r - thin[0]) / (thin[1] - thin[0])));
    if (rnd() > near * near) continue;   // thinner near the viewer: the first frame is not a wall
    var wood = _aeStForest(px, d.lat, d.lon), land = typeof _osLandCover === 'function' ? _osLandCover(d.lat, d.lon) : null;
    if (land) {   // the grid's class decides whether, and what: forests are wooded whatever one pixel's green says, grass has clumps and rows, the rest none
      if (land.cls === 'sea' || land.cls === 'snow' || land.cls === 'tundra') continue;
      wood = land.cls === 'grass' ? _aeStSavanna(r * Math.sin(th), r * Math.cos(th)) : land.cls === 'desert' ? _aeStShrubs(r * Math.sin(th), r * Math.cos(th)) : Math.max(wood, AE_STAND_FOREST_TREES);
    }
    if (land && land.cls !== 'desert') wood *= 1 - _aeStRock(px, d.lat, d.lon);
    if (wood <= 0 || rnd() > wood) continue;
    var ht = _aeTerrainHeight('earth', d.lat, d.lon, r * 0.0005);
    if (ht.sea || ht.h > AE_ST_SNOW_LINE_M * Math.pow(Math.cos(_aeRad(d.lat)), AE_ST_SNOW_LINE_POW) - AE_ST_TREE_BELOW_M) continue;
    var kind = _aeStTreeKind(d.lat, ht.h, rnd, land && land.cls);
    if (!kind) continue;
    var x = r * Math.sin(th), y = r * Math.cos(th), z = _aeTerrainLocal('earth', lat0, lon0, h0, x, y, r * 0.0005, st.pend && st.pend.flat);
    if (land && land.cls === 'desert') kind = 'shrub';   // the dry country's few woody plants: low, wide, sage-coloured, half sunk in the ground
    var sz = land && land.cls === 'desert' ? [0.7, 1.7] : kind === 'conifer' ? [20, 40] : kind === 'broadleaf' ? (land && land.cls === 'grass' ? [6, 13] : [10, 25]) : [8, 18], u = Math.pow(rnd(), 1.3);
    list.push({ kind: kind, x: x, y: y, z: z, h: sz[0] + (sz[1] - sz[0]) * u, seed: rnd(), lean: (rnd() - 0.5) * 0.12, w: 0.8 + rnd() * 0.5 });
  }
  // Open country always has some near: a few oaks within 300 m, wherever the clumps happen to fall.
  var landHere = typeof _osLandCover === 'function' ? _osLandCover(lat0, lon0) : null, nearTrees = list.filter(function (t) { return Math.hypot(t.x, t.y) < 300; }).length;
  var cx0 = 0, cy0 = 0;   // the fill-in comes in clumps of five or six round a centre 70 to 260 m out
  for (var fz = 0; landHere && landHere.cls === 'grass' && nearTrees < AE_STAND_GRASS_NEAR_MIN && fz < 80; fz++) {
    if (fz % 6 === 0) { var cr = 70 + 190 * rnd(), ca = rnd() * 2 * Math.PI; cx0 = cr * Math.sin(ca); cy0 = cr * Math.cos(ca); }
    var fx = cx0 + (rnd() - 0.5) * 50, fy = cy0 + (rnd() - 0.5) * 50, fr2 = Math.hypot(fx, fy), fh = 6 + 7 * Math.pow(rnd(), 1.3);
    if (fr2 < 55) continue;
    var fzz = _aeTerrainLocal('earth', lat0, lon0, h0, fx, fy, fr2 * 0.0005, st.pend && st.pend.flat);
    list.push({ kind: 'broadleaf', x: fx, y: fy, z: fzz, h: fh, seed: rnd(), lean: (rnd() - 0.5) * 0.12, w: 0.8 + rnd() * 0.5 }); nearTrees++;
  }
  _aeStandGround(st, landHere, px);
  if (!list.length) return;
  var P = [], N = [], T = [];   // flat arrays: positions, normals, (height fraction, seed, kind)
  var tri = function (a, b, c, ax, kind, seedv, fa, fb, fc, smooth) {   // one face, its normal pointing away from the axis point ax (smooth: each corner's own, away from ax)
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz) || 1;
    var mx = (a[0] + b[0] + c[0]) / 3 - ax[0], my = (a[1] + b[1] + c[1]) / 3 - ax[1], mz = (a[2] + b[2] + c[2]) / 3 - ax[2];
    if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    [[a, fa], [b, fb], [c, fc]].forEach(function (q) {
      P.push(q[0][0], q[0][1], q[0][2]);
      if (smooth) { var sx = q[0][0] - ax[0], sy = q[0][1] - ax[1], sz = q[0][2] - ax[2], sl = Math.hypot(sx, sy, sz) || 1; N.push(sx / sl, sy / sl, sz / sl); } else N.push(nx / nl, ny / nl, nz / nl);
      T.push(q[1], seedv, kind);
    });
  };
  var cone = function (cx, cy, z0, z1, rad, sides, droop, ax, kind, seedv, f0, f1) {   // a tier: a ring at z0 (the nearer half of it drooping), its tip at z1
    var ring = [], tip = [cx, cy, z1];
    for (var q = 0; q < sides; q++) { var an = q / sides * 2 * Math.PI + seedv * 6, w = 0.85 + 0.3 * ((q * 7 + Math.floor(seedv * 50)) % 5) / 4; ring.push([cx + Math.cos(an) * rad * w, cy + Math.sin(an) * rad * w, z0 - (q % 2 ? droop : 0)]); }
    for (var f = 0; f < sides; f++) tri(ring[f], ring[(f + 1) % sides], tip, ax, kind, seedv, f0, f0, f1);
  };
  list.forEach(function (t) {
    var K = AE_STAND_TREE_KINDS;
    if (t.kind === 'shrub') { _aeStCrown(tri, { x: t.x, y: t.y, z: t.z - 0.4 * t.h, h: t.h * 1.15, w: t.w * 2.3, lean: 0 }, t.seed, K.shrub); return; }   // no trunk: a squat ball with its lower half in the ground
    var c0 = [t.x, t.y, t.z], lean = t.lean, cx = function (f) { return t.x + lean * t.h * f; }, sd = t.seed;
    // the trunk: a dark sliver
    var tr = Math.max(0.18, t.h * 0.012), tz = t.z + t.h * (t.kind === 'palm' ? 0.85 : t.kind === 'broadleaf' ? 0.55 : 0.22);
    var tk = [[cx(0) - tr, t.y - tr], [cx(0) + tr, t.y - tr], [cx(0) + tr, t.y + tr], [cx(0) - tr, t.y + tr]];
    for (var e = 0; e < 4; e++) { var A = tk[e], B = tk[(e + 1) % 4]; tri([A[0], A[1], t.z], [B[0], B[1], t.z], [B[0] + lean * t.h * 0.2, B[1], tz], c0, K.trunk, sd, 0, 0, 0.2); }
    if (t.kind === 'conifer') {
      var rad = t.h * 0.13 * t.w;   // three tiers, each narrower, each a little drooped, the lowest well off the ground
      cone(cx(0.4), t.y, t.z + t.h * 0.14, t.z + t.h * 0.58, rad * 1.15, 7, t.h * 0.03, [cx(0.5), t.y, t.z + t.h * 0.4], K.conifer, sd, 0.14, 0.58);
      cone(cx(0.65), t.y, t.z + t.h * 0.36, t.z + t.h * 0.82, rad * 0.85, 7, t.h * 0.025, [cx(0.7), t.y, t.z + t.h * 0.6], K.conifer, sd, 0.36, 0.82);
      cone(cx(0.9), t.y, t.z + t.h * 0.6, t.z + t.h, rad * 0.55, 6, t.h * 0.02, [cx(0.9), t.y, t.z + t.h * 0.8], K.conifer, sd, 0.6, 1.0);
    } else if (t.kind === 'broadleaf') {
      _aeStCrown(tri, t, sd, K.broadleaf);
    } else if (t.kind === 'broadleaf-old') {
      var cr = t.h * 0.3 * t.w, cz = t.z + t.h * 0.62, top = [cx(0.7), t.y, t.z + t.h], bot = [cx(0.5), t.y, t.z + t.h * 0.3];   // a crown: a squat bipyramid of seven irregular points
      var ring = [];
      for (var q = 0; q < 7; q++) { var an = q / 7 * 2 * Math.PI + sd * 6, w = 0.75 + 0.5 * ((q * 5 + Math.floor(sd * 40)) % 4) / 3; ring.push([cx(0.6) + Math.cos(an) * cr * w, t.y + Math.sin(an) * cr * w, cz + (q % 2 ? 0.05 : -0.04) * t.h]); }
      for (var g = 0; g < 7; g++) { var A2 = ring[g], B2 = ring[(g + 1) % 7]; tri(A2, B2, top, [cx(0.6), t.y, cz], K.broadleaf, sd, 0.62, 0.62, 1.0); tri(B2, A2, bot, [cx(0.6), t.y, cz], K.broadleaf, sd, 0.62, 0.62, 0.3); }
    } else {   // a palm: a few long drooping fronds from the top of the trunk
      var tip2 = [cx(0.85), t.y, t.z + t.h * 0.95], fl = t.h * 0.32;
      for (var fr = 0; fr < 7; fr++) {
        var an2 = fr / 7 * 2 * Math.PI + sd * 6, ex = tip2[0] + Math.cos(an2) * fl, ey = tip2[1] + Math.sin(an2) * fl, ez = tip2[2] - fl * 0.45, px2 = -Math.sin(an2) * fl * 0.09, py2 = Math.cos(an2) * fl * 0.09;
        tri([tip2[0], tip2[1], tip2[2]], [ex + px2, ey + py2, ez], [ex - px2, ey - py2, ez], [tip2[0], tip2[1], tip2[2] - 3], K.palm, sd, 1.0, 0.85, 0.85);
      }
    }
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3)); g.setAttribute('aNrm', new THREE.BufferAttribute(new Float32Array(N), 3)); g.setAttribute('aTree', new THREE.BufferAttribute(new Float32Array(T), 3));
  var m = new THREE.ShaderMaterial({ uniforms: st.ground, vertexShader: AE_ST_TREE_VERT, fragmentShader: AE_ST_TREE_FRAG, side: AE_THREE_DOUBLE_SIDE });
  var mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.renderOrder = 1;
  st.scene.add(mesh); st.trees = { mesh: mesh, count: list.length };
  st.geo.push(g); st.mats.push(m);
  st.dirty = true; _ae.dirty = true; _aeKick();
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
// A craft in the Earth's shadow (its cylinder, away from the Sun) is dark: nothing to mark. earthPos: the Earth's heliocentric place (km); rel: the craft from the Earth's centre in Earth radii.
function _aeStationSunlit(earthPos, rel) {
  var sun = _aeNorm(_aeScale(earthPos, -1)), along = _aeDot(rel, sun);
  if (along >= 0) return true;
  return _aeLen(_aeSub(rel, _aeScale(sun, along))) > 1;
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
  if (r && _aeLen(_aeSub(_aeAdd(all.earth.pos, _aeScale(r.pos, AE_EARTH_RADIUS_KM)), O)) < AE_STAND_STATION_REACH_KM && _aeStationSunlit(all.earth.pos, r.pos)) {
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
  // No air: the eye is set by the sunlit ground it sees, not by the black sky, so with the Sun up the stars are lost (as the Apollo crews found).
  if (!a) {
    var dayLoss = _smoothstep(AE_STAND_AIRLESS_DAY_MU[0], AE_STAND_AIRLESS_DAY_MU[1], mu);
    p.lim = AE_ST_LM_MAX - (AE_ST_LM_MAX - AE_STAND_AIRLESS_DAY_LIM) * dayLoss; p.mw = 1 - dayLoss;
  }
  // Light of other bodies as a second sun for the ground.
  var ref = Math.max(AE_ST_GROUND_ALBEDO_REF * ((directG + e2) / Math.PI + AE_STAND_GROUND_AMBIENT_SHARE * Math.max(p.amb[0], p.amb[1], p.amb[2])),
    1.2 * Math.max(p.zen[0], p.zen[1], p.zen[2]), AE_STAND_NEAR_SUN_SHARE * Math.max(p.near ? p.near[0] : 0, p.near ? p.near[1] : 0, p.near ? p.near[2] : 0), AE_ST_NIGHT_FLOOR);
  p.k = AE_ST_EXPOSURE_TARGET / ref;
  // The Earth's sky is the 2D sky's, and so is its exposure there by day (the same eye: almanac-skygl.js _sgExposure, converted to this
  // view's units); through twilight it hands over to this view's own, which sets the exposure by the ground.
  if (a && st.key === 'earth' && typeof _sgExposure === 'function') {
    var w = AE_STAND_SKY_MATCH_SHARE * _smoothstep(AE_STAND_SKY_MATCH_DEG[0], AE_STAND_SKY_MATCH_DEG[1], fr.sunAlt), k2 = _sgExposure(fr.sunAlt, -90, 0, 0, 1, 1) * AE_ST_LUX_PER_UNIT;
    if (w > 0 && k2 > 0) p.k = Math.exp(Math.log(p.k) * (1 - w) + Math.log(k2) * w);
  }
  if (_aeStandAirOn(st) && _aeStandAir.exposureK) {   // a provider's atmosphere brings its own exposure, for everything in the picture
    var kp = null;
    try { kp = _aeStandAir.exposureK(st, fr, p); } catch (e) {}
    if (kp > 0) {
      // The ground is lit in the same units but the 2D sky's exposure is a gentler curve than this view's: by day the ground keeps this view's own exposure (it
      // read a washed pale green under the sky's), through twilight and night the provider's own.
      var wg = _smoothstep(AE_STAND_GROUND_OWN_K_DEG[0], AE_STAND_GROUND_OWN_K_DEG[1], fr.sunAlt);
      p.kGround = Math.exp(Math.log(kp) * (1 - wg) + Math.log(p.k) * wg);
      p.k = kp;
    }
  }
  // The provider's eclipse: the share of the Sun's light that reaches the place (the ground, its shadows and the Sun's sprite), the faintest star the dimmed sky shows, and the disc geometry.
  if (_aeStandAirOn(st)) {
    var P = _aeStandAir, share = _aeStAirCall(P.sunShare, st, fr), lm = _aeStAirCall(P.limitMag, st, fr), ecl = _aeStAirCall(P.eclipse, st, fr);
    var amb = _aeStAirCall(P.ambient, st, fr);   // the provider's own sky light for the ground, at every Sun height (the eclipse is in it already)
    var ownAmb = !(amb && amb.amb && amb.horizon && amb.zenith);
    if (!ownAmb) { p.amb = amb.amb; p.hor = amb.horizon; p.zen = amb.zenith; p.provAmb = true; }
    if (share >= 0 && share < 1) {   // the Sun's light; and, with only this view's own march to go by, every term of the light that comes from the sky it lights
      var dim = function (v) { return v ? v.map(function (x) { return x * share; }) : v; };
      p.sunE = dim(p.sunE); p.sunShare = share; e2 *= share;
      if (ownAmb) { p.amb = dim(p.amb); p.hor = dim(p.hor); p.zen = dim(p.zen); p.near = dim(p.near); p.diffSky = dim(p.diffSky); }
    }
    if (typeof lm === 'number' && isFinite(lm)) p.lim = lm;
    if (ecl && typeof ecl === 'object') p.ecl = ecl;
  }
  p.e2 = e2;
  p.mwStrength = _aeClamp((p.lim - 5.2) / 2.5, 0, 1) * p.mw;
  return p;
}
function _aeStAirCall(fn, st, fr) {   // an optional provider method: its answer, or undefined when it is absent or throws
  if (typeof fn !== 'function') return undefined;
  try { return fn.call(_aeStandAir, st, fr); } catch (e) { return undefined; }
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
// Where Stand faces with nobody having said: the live sky card's default when it is there, else the same rule (toward the equator).
function _aeStandDefaultHeading(lat) {
  var h = typeof _osDefaultHeading === 'function' ? _osDefaultHeading(lat) : NaN;
  return isFinite(h) ? h : (lat >= 0 ? 180 : 0);
}
function _aeStandView(st, now) {
  if (st.zf) _aeStandZoomStep(st, now);
  var span = st.mode === 'ascend' ? AE_STAND_ASCENT_MS : AE_STAND_DESCENT_MS;
  var u = _aeReduceMotion() || (st.handoff && st.handoff.direct) ? 1 : _aeSmoother(_aeClamp((now - st.t0) / span, 0, 1));   // direct: no flight down, the ground at once   // reduced motion: there at once
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
  _aeStandSkyUpdate(st, ms, now);
  var view = place(st);
  _aeStandApplyAir(st, st.fr, st.photo, view);
  _aeStandApplyGround(st, st.fr, st.photo, view, now);
  _aeStandShadeTick(st, st.fr, now);
  _aeStandSprites(st, st.fr, st.photo, view.pixAng, view.pos[2]);
  _aeStandCraftMarks(st, st.fr, view);
  _aeStandSkyPass(st);
  _aeStandRender(st);
  _aeStandBudget(st, now);
  if (st.handoff && st.handoff._firstFrame && st.mode === 'ground' && !st.fading) { var ff = st.handoff._firstFrame; st.handoff._firstFrame = null; ff(true); }
  st.dirty = false;
  if (st.hud && now - st.hudAt > AE_STAND_HUD_MS) { st.hudAt = now; _aeStandHudText(st); }
}
// The sky into its small target (or, with no way to make one, straight to the screen as before).
// The picture drawn with 4x multisampling when the canvas has none (the 3D view's own context drops it from AE_MSAA_BELOW_DPR up): into a multisampled target and
// copied out, so a horizon of bright ground against a black sky is not a staircase. WebGL2 only; a light device (capability level skyQuality 0) keeps the plain draw.
var AE_STAND_MSAA_SAMPLES = 4;
function _aeStandRender(st) {
  var S = _ae.gl, r = S.renderer, THREE = S.THREE, gl = r.getContext(), attrs = gl && gl.getContextAttributes ? gl.getContextAttributes() : null;
  if (!attrs || attrs.antialias || typeof THREE.WebGLRenderTarget !== 'function' || !(r.capabilities && r.capabilities.isWebGL2) || (typeof ZimiCap !== 'undefined' && ZimiCap.get('skyQuality') < 1)) { r.render(st.scene, st.camera); return; }
  var ratio = r.getPixelRatio(), W = Math.max(1, Math.round(_ae.w * ratio)), H = Math.max(1, Math.round(_ae.h * ratio));
  if (!st.msaa || st.msaa.w !== W || st.msaa.h !== H) {
    if (st.msaa) { st.msaa.rt.dispose(); st.msaa.mat.dispose(); }
    var rt = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, samples: AE_STAND_MSAA_SAMPLES });
    var mat = new THREE.ShaderMaterial({ uniforms: { tMs: { value: rt.texture } }, vertexShader: AE_ST_SKY_VERT, fragmentShader: AE_ST_COPY_FRAG, depthTest: false, depthWrite: false });
    var scene = new THREE.Scene(), mesh = new THREE.Mesh(st.skyBlit.geometry, mat);
    mesh.frustumCulled = false; scene.add(mesh);
    st.msaa = { rt: rt, mat: mat, scene: scene, w: W, h: H };
  }
  r.setRenderTarget(st.msaa.rt); r.clear(); r.render(st.scene, st.camera); r.setRenderTarget(null);
  r.render(st.msaa.scene, st.camera);
}
function _aeStandSkyPass(st) {
  _aeStandAirSelect(st);
  _aeStandCloudSelect(st);
  var S = _ae.gl, r = S.renderer, THREE = S.THREE, use = _aeStandSkyScale() < 1 && !!st.skyBlit && typeof THREE.WebGLRenderTarget === 'function';
  st.skyMesh.visible = !use; st.skyBlit.visible = use;
  if (!use) return;
  var ratio = r.getPixelRatio(), W = Math.max(1, Math.round(_ae.w * ratio)), H = Math.max(1, Math.round(_ae.h * ratio));
  var w = Math.max(1, Math.round(W * _aeStandSkyScale())), h = Math.max(1, Math.round(H * _aeStandSkyScale()));
  if (!st.skyRT || st.skyRT.width !== w || st.skyRT.height !== h) {
    if (st.skyRT) st.skyRT.dispose();
    st.skyRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
  }
  var u = st.skyBlit.material.uniforms;
  u.tSky.value = st.skyRT.texture; u.uRes.value = [W, H]; u.uTexel.value = [1 / w, 1 / h];
  r.setRenderTarget(st.skyRT); r.render(st.skyScene, st.camera); r.setRenderTarget(null);
}
// Frames that run long step the pixel ratio down, for good: a phone that cannot keep up is not asked to try again.
function _aeStandBudget(st, now) {
  if (typeof ZimiCap !== 'undefined') {   // the governor is shared with every 3D scene; Stand only applies what it decides
    if (!ZimiCap.frame('stand', now)) return;
    var S0 = _ae.gl;
    S0.renderer.setPixelRatio(Math.min(S0.dpr, ZimiCap.dprCap('stand')));
    st.starUni.uDpr.value = S0.renderer.getPixelRatio();
    _aeResize();
    return;
  }
  var dt = now - (st.paintAt || now);
  st.paintAt = now;
  if (dt > AE_STAND_SLOW_MS[0] && dt < AE_STAND_SLOW_MS[1]) st.slow = (st.slow || 0) + 1; else st.slow = 0;
  if (st.slow < AE_STAND_SLOW_RUN) return;
  st.slow = 0;
  var lower = AE_STAND_DPR_STEPS.filter(function (x) { return x < _aeStandDprCap; })[0];
  if (!lower) return;
  _aeStandDprCap = lower;
  var S = _ae.gl;
  S.renderer.setPixelRatio(Math.min(S.dpr, lower));
  st.starUni.uDpr.value = S.renderer.getPixelRatio();
  _aeResize();
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
  U.uSunDir.value = fr.sun; U.uSunE.value = ph.sunE; U.uK.value = ph.k; if (st.ground) st.ground.uKg.value = ph.kGround || ph.k;
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
  g.uCloudDim.value = st.cloudDim === undefined ? 1 : st.cloudDim;   // the Sun's light on the ground, less under cloud
  g.uCam.value = view.pos; g.uPixAng.value = view.pixAng;
  var hl = Math.hypot(view.e[8], view.e[9]) || 1;
  g.uHead.value = [-view.e[8] / hl, -view.e[9] / hl]; g.uTime.value = now / 1000;
  g.uAmbient.value = !ph.provAmb ? ph.amb.map(function (x) { return Math.max(x, AE_STAND_NIGHT_GLOW); }) : ph.amb; g.uSkyHor.value = ph.hor; g.uSkyZen.value = ph.zen; g.uDiffSky.value = ph.diffSky;
  if (fr.light2) { g.uDir2.value = fr.light2.dir; g.uE2.value = fr.light2.rgb; }
  else g.uE2.value = [0, 0, 0];
}
function _aeStandSprites(st, fr, ph, pixAng, alt) {
  var a = st.atmo, d = a && a.diffuse, air = a && !d ? a : null, hG = st.h0 / 1000, R = st.b.km;
  var list = [{ sun: true, dir: fr.sun, rho: fr.sunRho, E: fr.S, sunFrom: fr.sun, tint: [1, 1, 1], mag: AE_STAND_MAG_SUN }].concat(fr.objs);
  var Z = [0, 0, 1], Y = [0, 1, 0], ecl = ph.ecl, moonO = null;
  if (ecl) {   // the true discs: the Sun's and the Moon's own semi-diameters, the Sun's light as much of it as the place gets
    if (ecl.sunSemiDeg > 0) list[0].rho = _aeRad(ecl.sunSemiDeg);
    list.forEach(function (o) { if (!o.sun && o.key === AE_STAND_MOON_NAME) { moonO = o; if (ecl.moonSemiDeg > 0) o.rho = _aeRad(ecl.moonSemiDeg); } });
  }
  if (ph.sunShare !== undefined) list[0].E *= ph.sunShare;
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
    var coronal = ecl && o === moonO && ecl.corona > 0;
    if (!o.sun && !coronal && o.rho <= pixAng * 1.2 && vis <= 0.004 && ringRho < pixAng * AE_STAND_RING_PX) { m.visible = false; return; }
    m.visible = true;
    uni.uDir.value = o.dir; uni.uRight.value = right; uni.uUp.value = up; uni.uSunFrom.value = o.sunFrom;
    uni.uTint.value = o.tint; uni.uTrans.value = trans;
    // A planet seen as a point is drawn as a star of its magnitude is: bigger the brighter it is, in the colour it looks (not its disc's albedo colour).
    var pscale = 1, magE = o.mag + (air ? 0.2 * 1 / (Math.max(mu, 0) + 0.025 * Math.exp(-11 * Math.max(mu, 0))) : 0);
    if (!o.sun && o.rho <= pixAng * 1.2) {
      pscale = (1.1 + 0.35 * _aeClamp(lim - magE, 0, 6)) / 1.1;
      uni.uTint.value = AE_STAND_POINT_TINT[o.key] || o.tint.map(function (x) { return 0.5 + 0.5 * x; });
    }
    uni.uPointScale.value = pscale;
    uni.uHalf.value = o.sun ? Math.max(o.rho * 16, pixAng * 8) : Math.max(o.rho * 1.2, ringRho * 1.1, pixAng * 5 * pscale);
    uni.uRho.value = o.rho; uni.uPix.value = pixAng; uni.uE.value = o.E; uni.uK.value = ph.k;
    uni.uEmit.value = o.sun ? 1 : 0; uni.uVis.value = vis;
    uni.uGlow.value = o.sun ? (air || d ? 0 : 0.18) : 0;
    uni.uOcc.value = [0, 0, 0];   // the Moon's disc over the Sun's: its centre in the Sun's frame (radians) and its radius
    uni.uCorona.value = 0; uni.uSeed.value = (Math.floor(_aeDisplayMs() / 86400000) % 997) / 997;   // the streamers are the day's own
    if (ecl && o.sun && moonO) uni.uOcc.value = [_aeDot(moonO.dir, right) , _aeDot(moonO.dir, up), moonO.rho];
    if (ecl && o === moonO) _aeStandMoonDark(st, ecl, uni, o);
    if (ecl && o === moonO && ecl.corona > 0) { uni.uCorona.value = ecl.corona; uni.uHalf.value = Math.max(uni.uHalf.value, o.rho * AE_STAND_CORONA_RADII * 1.05); }
    uni.uSkyLit.value = 1;
    // The body's own map, once it has been looked at long enough to ask for it (a disc of a few pixels is its tint).
    var tex = !o.sun && o.rho > pixAng * AE_STAND_MAP_PX ? _aeStandDiscMap(st, o.key, o.rho > pixAng * AE_STAND_MOON_CLOSE_PX) : null;
    uni.uMap.value = tex; uni.uMapped.value = tex ? 1 : 0; uni.uGrey.value = o.key === AE_STAND_MOON_NAME ? 1 : 0;
    uni.uMapGain.value = (o.alb || 0.3) / AE_STAND_MAP_GAIN_ALBEDO;
    if (o.rows) uni.uBody.value = _aeStMat3(o.rows);
    uni.uRings.value = ringed ? 1 : 0;
    if (ringed) {
      uni.uRingMap.value = st.ringTex; uni.uRp.value = o.km; uni.uRingN.value = o.pole;
      uni.uCen.value = [o.dir[0] * o.dist, o.dir[1] * o.dist, o.dir[2] * o.dist]; uni.uRing.value = AE_STAND_SATURN_RINGS;
    }
  });
  _aeStandEclipseLabel(st, ecl);
  for (var j = list.length; j < st.sprites.length; j++) st.sprites[j].mesh.visible = false;
}
// In a total eclipse the Moon's disc is darker than the sky round it (the sky's glow is bright, the Moon near black with a trace of earthshine): a dark disc between the sky and the corona.
var AE_STAND_MOON_DARK = [0.9, 0.995];   // the obscuration over which it comes in
function _aeStandMoonDark(st, ecl, uni, o) {
  var k = _smoothstep(AE_STAND_MOON_DARK[0], AE_STAND_MOON_DARK[1], ecl.obsc || 0), u = st.moonOccUni;
  st.moonOcc.visible = k > 0;
  if (!(k > 0)) return;
  u.uDir.value = uni.uDir.value; u.uRight.value = uni.uRight.value; u.uUp.value = uni.uUp.value;
  u.uHalf.value = o.rho * 1.2; u.uRho.value = o.rho; u.uPix.value = uni.uPix.value; u.uDark.value = k * 0.985;
}
// The Sun's name over the ring while an eclipse is total and the view is wide (the ring is 7 px across): the tap on it goes in.
function _aeStandEclipseLabel(st, ecl) {
  var el = st.eclLabel, show = !!(ecl && ecl.obsc > 0.95 && st.zoom > AE_STAND_ZOOMED_IN && st.camera && st.fr && st.fr.sun[2] > 0);
  if (!show) { if (el) el.hidden = true; return; }
  if (!el) {
    el = st.eclLabel = document.createElement('span'); el.className = 'ae-stand-craft'; el.style.pointerEvents = 'none'; el.innerHTML = '<i></i>';
    el.appendChild(document.createTextNode(_aeInfoName('sun'))); _ae.el.appendChild(el);
  }
  var p = new _ae.gl.THREE.Vector3(st.fr.sun[0] * AE_STAND_SKY_AT_M, st.fr.sun[1] * AE_STAND_SKY_AT_M, st.fr.sun[2] * AE_STAND_SKY_AT_M).project(st.camera);
  el.hidden = p.z < -1 || p.z > 1;
  el.style.transform = 'translate(' + ((p.x + 1) / 2 * _ae.w).toFixed(1) + 'px,' + ((1 - p.y) / 2 * _ae.h).toFixed(1) + 'px)';
}
var AE_STAND_CORONA_RADII = 3.4;   // the corona's reach in Moon radii (almanac-sky.js SKY_CORONA_RADII)
var AE_STAND_POINT_TINT = { mercury: [0.96, 0.93, 0.88], venus: [1, 0.97, 0.9], mars: [1, 0.66, 0.46], jupiter: [1, 0.95, 0.85], saturn: [1, 0.92, 0.76], uranus: [0.8, 0.95, 0.95], neptune: [0.7, 0.8, 1] };   // how the planets look to the eye as points
var AE_STAND_MAP_PX = 3;                       // a disc this many pixels across (radius) or more is drawn from its map
var AE_STAND_SATURN_RINGS = [74500, 140220];   // km, the C ring's inside to the A ring's outside (as almanac-earth.js AE_PLANETS)
// The map of a body seen as a disc: the orbit view's own once it has it, else fetched (once; the disc shows it when it is in).
function _aeStandDiscMap(st, key, close) {
  var S = _ae.gl, tex = null;
  if (key === 'earth') tex = S.earthUni.dayMap.value;
  else if (key === AE_STAND_MOON_NAME) tex = S.moonUni.moonMap.value;
  else if (S.planets && S.planets[key]) tex = S.planets[key].uni.map.value;
  st.discMaps = st.discMaps || {};
  // The Moon seen close (a tap on it): the 4k map, fetched once when the disc is big enough to show it.
  var hiKey = key + '-hi';
  if (key === AE_STAND_MOON_NAME && close && !st.discMaps[hiKey]) {
    st.discMaps[hiKey] = true;
    _aeLoadTexture(S.THREE, AE_STAND_MOON_HI_URL).then(function (t) { if (_ae.stand === st) { st.discMaps[hiKey] = t; st.dirty = true; _ae.dirty = true; _aeKick(); } else t.dispose(); }, function () {});
  }
  if (st.discMaps[hiKey] && st.discMaps[hiKey] !== true) return st.discMaps[hiKey];
  if (tex) return tex;
  var b = _aePlanetBody(key), url = b && b.map ? _aePlanetMapUrl(b) : key === AE_STAND_MOON_NAME ? AE_STAND_MOON_URL : null;
  if (url && !st.discMaps[key]) {
    st.discMaps[key] = true;
    _aeLoadTexture(S.THREE, url).then(function (t) { if (_ae.stand === st) { st.discMaps[key] = t; st.dirty = true; _ae.dirty = true; _aeKick(); } else t.dispose(); }, function () {});
  }
  return st.discMaps[key] && st.discMaps[key] !== true ? st.discMaps[key] : null;
}
var AE_STAND_MOON_URL = '/static/earth/moon-v1.webp', AE_STAND_MOON_HI_URL = '/static/earth/moon-4k-v1.webp', AE_STAND_MOON_CLOSE_PX = 24;   // the disc's radius in pixels from which the 4k map is used
var AE_STAND_CRAFT_TOP_PX = 110, AE_STAND_CRAFT_BOTTOM_PX = 120;   // the bar and the clock keep their own bands
var AE_STAND_CRAFT_CHAR_PX = 7, AE_STAND_CRAFT_LINE_PX = 16;       // a name's width per letter, and a line's height
var AE_STAND_STATION_REACH_KM = 2e4;                                  // the station is a mark only from the Earth's neighbourhood
// Where the spacecraft are: a ring and the name, over the picture where they stand in the sky.
function _aeStandCraftMarks(st, fr, view) {
  var host = st.craftHost || (st.craftHost = (function () { var h = document.createElement('div'); h.className = 'ae-stand-crafts'; _ae.el.appendChild(h); return h; })());
  var cam = st.camera, V = _ae.gl.THREE.Vector3, shown = 0, W = _ae.w, H = _ae.h, placed = [];
  (fr.crafts || []).forEach(function (c) {
    if (c.key !== 'iss' && !AE_STAND_PROBE_MARKS) return;
    if (c.key === 'iss' && st.photo && st.photo.lim < AE_STAND_STATION_MIN_LIM) return;   // by day the station is not a thing to see
    var p = new V(view.pos[0] + c.dir[0] * AE_STAND_CRAFT_RANGE, view.pos[1] + c.dir[1] * AE_STAND_CRAFT_RANGE, view.pos[2] + c.dir[2] * AE_STAND_CRAFT_RANGE).project(cam);
    var x = (p.x + 1) / 2 * W, y = (1 - p.y) / 2 * H;
    var on = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && y > AE_STAND_CRAFT_TOP_PX && y < H - AE_STAND_CRAFT_BOTTOM_PX && (c.dir[2] > -0.02 || st.altKm > 1);
    var el = host.children[shown];
    if (!on) return;
    if (!el) { el = document.createElement('span'); el.className = 'ae-stand-craft'; host.appendChild(el); }
    if (el._name !== c.name) { el._name = c.name; el.innerHTML = '<i></i>' + _almEsc(c.name); }
    el.hidden = false;
    // Names that would sit on one another step down, so each can be read.
    var w = c.name.length * AE_STAND_CRAFT_CHAR_PX + 14;
    for (var again = 0; again < placed.length * 2; again++) {
      var hit = placed.filter(function (q) { return Math.abs(q.y - y) < AE_STAND_CRAFT_LINE_PX && x < q.x + q.w && q.x < x + w; })[0];
      if (!hit) break;
      y = hit.y + AE_STAND_CRAFT_LINE_PX;
    }
    placed.push({ x: x, y: y, w: w });
    el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    shown++;
  });
  for (var i = shown; i < host.children.length; i++) host.children[i].hidden = true;
}

// ── The live sky card's hand-off, and the way back ──
//   window._osHandoff = { body?: 'earth', lat, lon, ms?, heading?, pitch?, back?() }   the card's place, instant, facing (degrees: heading
//                                from north clockwise, pitch up) and a function that puts the card back
//   _aeStandOpen(h?)    (almanac-earth.js loads Stand, then calls _aeStandOpenNow(h)) opens the 3D view if it is not up, goes to that place and instant, drops to the ground facing that way;
//                       h defaults to window._osHandoff (which is then cleared); resolves true when it started
//   _aeStandClose()     (almanac-earth.js; _aeStandCloseNow here) the one way back: climbs out of Stand here, closes the 3D view if _aeStandOpen opened it, then calls h.back()
function _aeStandOpenNow(h) {
  h = h || (typeof window !== 'undefined' ? window._osHandoff : null);
  if (h && !h.firstFrame) h.firstFrame = new Promise(function (res) { h._firstFrame = res; });   // h.firstFrame resolves when Stand's first live picture of the ground is drawn (h.direct: no flight down, the ground at once)
  if (typeof window !== 'undefined' && h && h === window._osHandoff) window._osHandoff = null;
  if (!h || typeof h.lat !== 'number' || typeof h.lon !== 'number') return Promise.resolve(false);
  h.openedView = !(typeof _aeIsOpen !== 'undefined' && _aeIsOpen);
  return _aeStandStart(h.body || 'earth', h.lat, h.lon, h);
}
function _aeStandCloseNow() {
  var st = _ae && _ae.stand, h = (st && st.handoff) || (_ae && _ae.standPending && _ae.standPending.handoff) || null;
  if (!_ae) return;
  _ae.standBack = h;
  if (_ae.stand || _ae.standPending) _aeStandLeave(); else _aeStandAfterClose();
}
function _aeStandAfterClose() {
  var h = _ae && _ae.standBack;
  if (!h) return;
  _ae.standBack = null;
  if (h.openedView && typeof _aeClose === 'function' && typeof _aeIsOpen !== 'undefined' && _aeIsOpen) _aeClose();
  if (typeof h.back === 'function') { try { h.back(); } catch (e) {} }
}

// ── An atmosphere from outside (the 2D sky's, for the Earth) ──
// A provider is an object at `_aeStandAir`; while provider.wants(st) is true (called at every picture) the sky pass is drawn with ITS
// light and ONE exposure for the sky, the ground and the sprites; otherwise, and with no provider, this view's own ray march.
//     wants(st) -> bool        st.key, st.altKm (camera height over the ground), st.lat, st.lon are what it will want to know
//     glsl                     a chunk that defines  vec3 oaSky(vec3 d)  (d: unit view direction in the local frame, x east, y north, z up),
//                              the sky's radiance there in the units its exposureK goes with (tone is 1 - exp(-L * uK), then gamma);
//                              it may read this view's uniforms uCam (km, the camera in the local frame), uSunDir (unit, local frame),
//                              uSunE, uR, uRc, uTop, uAtmo and declare its own `uniform`s, which `uniforms` supplies
//     uniforms                 { name: initial value } for the chunk's own uniforms (numbers, arrays of 2-4 or 9 numbers, textures)
//     update(st, fr, ph, u)    optional, at every picture: set u[name].value from the frame (fr: sun and body positions, ph: its photometry)
//     exposureK(st, fr, ph)    the one uK (a positive number), or null for this view's own
//     clouds                   optional { glsl, uniforms, update(st, fr, ph, u) }: the cloud deck's own chunk (see Clouds below)
// The chunk is compiled on first use; a provider whose glsl changes is rebuilt.
var _aeStandAir = (typeof _aeStandAir !== 'undefined') ? _aeStandAir : null;
function _aeStandAirOn(st) {
  var P = _aeStandAir;
  try { return !!(P && P.glsl && P.wants && P.wants(st)); } catch (e) { return false; }
}
function _aeStandAirSelect(st) {
  var THREE = _ae.gl.THREE, on = _aeStandAirOn(st), P = _aeStandAir;
  if (on && (!st.skyMatAir || st.skyAirSrc !== P.glsl)) {
    if (st.skyMatAir) st.skyMatAir.dispose();
    var own = {};
    Object.keys(P.uniforms || {}).forEach(function (k) { own[k] = { value: P.uniforms[k] }; });
    st.skyMatAir = new THREE.ShaderMaterial({ uniforms: Object.assign({}, st.sky, own), vertexShader: AE_ST_SKY_VERT, fragmentShader: _aeStSkyAirFrag(P.glsl), depthTest: false, depthWrite: false });
    st.skyAirSrc = P.glsl;
  }
  var m = on ? st.skyMatAir : st.skyMatOwn;
  if (st.skyMesh.material !== m) { st.skyMesh.material = m; if (st.skyLowMesh) st.skyLowMesh.material = m; }
  if (on && P.update) { try { P.update(st, st.fr, st.photo, st.skyMatAir.uniforms); } catch (e) {} }
  st.airOn = on;
}

// ── Clouds ──
// One deck over the Earth, from a field of (place, day). onesky owns the definition: `_osCloudField(def)` with def = { lat, lon, ms } returns
// { coverage 0..1, wind: [vx, vy] m/s, base (m over the ground), thickness, seed: [a, b] }; without it, this formula (a hash of the day and the
// place's half-degree cell). A provider (_aeStandAir) may bring `clouds: { glsl, uniforms, update(st, fr, ph, u) }` whose chunk defines
//     vec4 osClouds(vec3 d, vec3 o)   d: unit view direction (local frame), o: the camera in metres; premultiplied radiance + alpha,
//                                     in the units of oaSky, so tone(rgb, uK) is its colour
// and the stand draws it over the sky, the stars and the sprites, under the ground. Earth only; nothing is drawn at coverage under 2 percent.
var AE_STAND_CLOUD_BASE_M = [1800, 3000], AE_STAND_CLOUD_THICK_M = 700;
var AE_STAND_CLOUD_DIM = 0.6;   // the share of the Sun's direct light a full cover takes from the ground
function _aeStHash(a, b, c) { var h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return h - Math.floor(h); }
function _aeStandCloudField(st, ms) {
  if (typeof _osCloudField === 'function') { try { var f = _osCloudField({ lat: st.lat, lon: st.lon, ms: ms }); if (f) return f; } catch (e) {} }
  var day = Math.floor(ms / 86400000), la = Math.round(st.lat * 2) / 2, lo = Math.round(st.lon * 2) / 2;
  var r = function (k) { return _aeStHash(day + k * 13.7, la + k * 3.1, lo - k * 5.3); };
  var ang = r(2) * 2 * Math.PI, sp = 3 + 11 * r(3);
  return { coverage: Math.pow(r(1), 1.3) * 0.85, wind: [Math.cos(ang) * sp, Math.sin(ang) * sp], base: AE_STAND_CLOUD_BASE_M[0] + (AE_STAND_CLOUD_BASE_M[1] - AE_STAND_CLOUD_BASE_M[0]) * r(4), thickness: AE_STAND_CLOUD_THICK_M, seed: [r(5) * 90, r(6) * 90] };
}
function _aeStandCloudSelect(st) {
  var THREE = _ae.gl.THREE;
  if (st.key !== 'earth' || !st.sky) return;
  var P = _aeStandAir, prov = _aeStandAirOn(st) && P.clouds && P.clouds.glsl ? P.clouds : null, chunk = prov ? prov.glsl : AE_ST_CLOUDS_GLSL;
  if (!st.cloudMesh || st.cloudSrc !== chunk) {
    if (st.cloudMesh) { st.scene.remove(st.cloudMesh); st.cloudMesh.material.dispose(); }
    var own = {};
    if (prov) Object.keys(prov.uniforms || {}).forEach(function (k) { own[k] = { value: prov.uniforms[k] }; });
    else own = { uCloudA: { value: [0, 2000, 700, 0] }, uCloudB: { value: [0, 0, 0, 0] } };
    var m = new THREE.ShaderMaterial({ uniforms: Object.assign({}, st.sky, own), vertexShader: AE_ST_SKY_VERT_FAR, fragmentShader: _aeStCloudFrag(chunk), transparent: true, depthTest: true, depthWrite: false });
    st.cloudMesh = new THREE.Mesh(st.skyMesh.geometry, m);
    st.cloudMesh.frustumCulled = false; st.cloudMesh.renderOrder = -0.5;
    st.scene.add(st.cloudMesh); st.cloudSrc = chunk; st.cloudProv = !!prov;
  }
  var u = st.cloudMesh.material.uniforms, clear = !!(st.handoff && st.handoff.clouds === 'clear');
  if (clear) { st.cloudMesh.visible = false; st.cloudDim = 1; return; }   // a visit that asks for a clear sky gets one, whoever's deck it is
  if (prov && typeof _osCloudField === 'function') { var pf = null; try { pf = _osCloudField({ lat: st.lat, lon: st.lon, ms: _aeDisplayMs() }); } catch (e) {} st.cloudDim = pf && pf.coverage > 0 ? 1 - AE_STAND_CLOUD_DIM * Math.pow(Math.min(1, pf.coverage), 1.4) : 1; }
  else if (clear) st.cloudDim = 1;
  if (prov) { st.cloudMesh.visible = true; if (prov.update) { try { prov.update(st, st.fr, st.photo, u); } catch (e) {} } return; }
  if (clear) { st.cloudMesh.visible = false; st.cloudDim = 1; return; }   // the card draws none, nor does this
  var ms = _aeDisplayMs(), f = st.cloudField && Math.abs(ms - st.cloudField.at) < 600000 ? st.cloudField : (st.cloudField = Object.assign(_aeStandCloudField(st, ms), { at: ms }));
  st.cloudMesh.visible = f.coverage >= 0.02;
  st.cloudDim = 1 - AE_STAND_CLOUD_DIM * Math.pow(Math.min(1, f.coverage), 1.4);
  u.uCloudA.value = [f.coverage, f.base, f.thickness, (ms % 86400000) / 1000];
  u.uCloudB.value = [f.wind[0], f.wind[1], f.seed[0], f.seed[1]];
}

// ── Objects in the sky from other lanes ──
// One hook: _aeStandSkySource(src) puts things in the sky Stand here draws (satellites, the station, a train of them, a rocket, a
// plume) and returns a function that takes the source out again. A source is either
//     { ask(lat, lon, tMs) -> Promise | answer,   called about once a second (and when the clock jumps), never overlapping itself:
//                                                 lat, lon are the place's geodetic degrees, tMs the displayed instant;
//       at(answer, tMs) -> [object] }             called at every picture with the latest answer: move things by their rates,
//                                                 drop what has set (cheap; no I/O)
// or, for something that is cheap to work out anywhere, a plain function  fn(body, lat, lon, tMs) -> [object]  called at every picture.
// An object is
//     { az, el,                  degrees: azimuth from north clockwise, elevation over the horizon
//       mag,                     apparent magnitude (smaller is brighter; a plume may be -6 or less)
//       kind,                    'sat' | 'train' | 'rocket' | 'plume': points, a point with its trail, a large soft glow
//       rgb,                     optional [r, g, b] 0..1 (white by default)
//       trail,                   optional path behind it, [[az, el], ...] or [{az, el, mag?}, ...]; a point's own mag dims the tail there
//       name }                   optional: what a tap on it says (while the sky is dark enough to see it)
// They are drawn as stars are: dimmed by the air mass, gone once the sky is brighter than their magnitude (so by day they are
// hidden), gone under the horizon, the same on a phone's small canvas. With no source nothing is drawn and nothing costs.
var AE_STAND_SKY_AT_M = 50000;   // a direction in the sky as a point to project: far enough that the camera's 1.7 m of height is not a parallax of ten degrees
var AE_STAND_SKY_EVERY_MS = 1000, AE_STAND_SKY_TAP_PX = 30, AE_STAND_SKY_TAG_MS = 4000;
// Sky objects with an angular size (optional): { kind, az, el, sizeDeg: n | [along, across], axisAz, axisEl (a point on its track: the long axis points toward it), rgb, lum 0..1 }.
// A soft additive billboard in angular units; whether it is lit (sunlit thing, observer in twilight) is the lane's `lum`.
var AE_STAND_BOARD_MAX = 6;   // the most boards
function _aeStandSkyBoards(st, boards) {
  var THREE = _ae.gl.THREE, tw = 1;   // (the lane's `lum` already says whether the thing is sunlit and the observer in twilight: not gated twice)
  if (!st.boards) st.boards = [];
  boards.slice(0, AE_STAND_BOARD_MAX).forEach(function (o, i) {
    var b = st.boards[i];
    if (!b) {
      var uni = { uDir: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uHalf: { value: 0.1 }, uAxis: { value: [1, 0] }, uSize: { value: [0.1, 0.05] }, uCol: { value: [1, 1, 1] }, uLum: { value: 0 } };
      var m = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_ST_BODY_VERT, fragmentShader: AE_ST_BOARD_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: AE_THREE_ADDITIVE_BLENDING });
      var mesh = new THREE.Mesh(st.sprites[0].mesh.geometry, m);
      mesh.frustumCulled = false; mesh.renderOrder = -1;
      st.scene.add(mesh); st.mats.push(m);
      b = st.boards[i] = { mesh: mesh, uni: uni };
    }
    var d = o.dir, Z = [0, 0, 1], Y = [0, 1, 0], right = _aeNorm(_aeCross(d, Math.abs(d[2]) > 0.999 ? Y : Z)), up = _aeCross(right, d);
    var sz = typeof o.sizeDeg === 'number' ? [o.sizeDeg, o.sizeDeg] : o.sizeDeg, A = _aeRad(sz[0]) / 2, B = _aeRad(sz[1] !== undefined ? sz[1] : sz[0]) / 2, ax = [1, 0];
    if (o.axisAz !== undefined && o.axisEl !== undefined) {
      var t = _aeStandSkyDir(o.axisAz, o.axisEl), k = _aeDot(t, d), tv = [t[0] - d[0] * k, t[1] - d[1] * k, t[2] - d[2] * k], l = Math.hypot(tv[0], tv[1], tv[2]) || 1;
      ax = [_aeDot(tv, right) / l, _aeDot(tv, up) / l];
    }
    var u = b.uni;
    u.uDir.value = d; u.uRight.value = right; u.uUp.value = up; u.uHalf.value = Math.max(A, B) * 1.05; u.uAxis.value = ax; u.uSize.value = [A, B];
    u.uCol.value = o.rgb || [1, 0.85, 0.7]; u.uLum.value = (o.lum === undefined ? 1 : o.lum) * tw;
    b.mesh.visible = u.uLum.value > 0.002 && o.el > -3;
  });
  for (var j = boards.length; j < st.boards.length; j++) st.boards[j].mesh.visible = false;
}
var AE_STAND_SKYOBJ_SIZE = { sat: 1, train: 1.2, rocket: 1.6, plume: 7 };   // a point's size by kind
var _aeStandSkySources = [];
function _aeStandSkySource(src) {
  var entry = typeof src === 'function' ? { fn: src } : { ask: src.ask, at: src.at, answer: null, pending: false, askedAt: 0 };
  _aeStandSkySources.push(entry);
  var st = _ae && _ae.stand;
  if (st) { st.skyDirty = true; st.dirty = true; _ae.dirty = true; if (typeof _aeKick === 'function') _aeKick(); }
  return function () { var k = _aeStandSkySources.indexOf(entry); if (k >= 0) _aeStandSkySources.splice(k, 1); if (_ae && _ae.stand) { _ae.stand.skyDirty = true; _ae.stand.dirty = true; _ae.dirty = true; } };
}
function _aeStandSkyDir(az, el) {   // the local frame: x east, y north, z up
  var a = _aeRad(az), e = _aeRad(el), c = Math.cos(e);
  return [Math.sin(a) * c, Math.cos(a) * c, Math.sin(e)];
}
function _aeStandSkyAsk(st, ms, now) {
  _aeStandSkySources.forEach(function (e) {
    if (!e.ask || e.pending || (now - e.askedAt < AE_STAND_SKY_EVERY_MS && !st.skyJump)) return;
    e.pending = true; e.askedAt = now;
    var done = function (a) { e.answer = a; e.pending = false; st.dirty = true; if (_ae) { _ae.dirty = true; if (typeof _aeKick === 'function') _aeKick(); } };
    try { Promise.resolve(e.ask(st.lat, st.lon, ms)).then(done, function () { e.pending = false; }); } catch (x) { e.pending = false; }
  });
  st.skyJump = false;
}
function _aeStandSkyUpdate(st, ms, now) {
  if (!_aeStandSkySources.length && !st.skyObjs) return;
  _aeStandSkyAsk(st, ms, now);
  var list = [];
  _aeStandSkySources.forEach(function (e) {
    try {
      var r = e.fn ? e.fn(st.key, st.lat, st.lon, ms) : (e.at && e.answer ? e.at(e.answer, ms) : null);
      if (r && r.length) for (var i = 0; i < r.length; i++) list.push(r[i]);
    } catch (x) {}
  });
  st.skyObjs = list.length ? list : null;
  var THREE = _ae.gl.THREE, n = list.length, pos = new Float32Array(3 * n), mag = new Float32Array(n), scl = new Float32Array(n), col = new Float32Array(3 * n), tr = [];
  var boards = [];
  list.forEach(function (o, i) {
    var d = _aeStandSkyDir(o.az, o.el), c = o.rgb || [1, 1, 1];
    o.dir = d;
    if (o.sizeDeg) boards.push(o);   // an extended thing is a billboard, not a point
    pos.set(d, 3 * i); mag[i] = o.sizeDeg ? 99 : o.mag === undefined ? 3 : o.mag; scl[i] = AE_STAND_SKYOBJ_SIZE[o.kind] || 1; col.set(c, 3 * i);
    if (o.trail && o.trail.length) {
      var prev = d, pm = mag[i];
      o.trail.forEach(function (q) { var az = q.az !== undefined ? q.az : q[0], el = q.el !== undefined ? q.el : q[1], v = _aeStandSkyDir(az, el), qm = q.mag !== undefined ? q.mag : mag[i]; tr.push([prev, v, c, pm, qm]); prev = v; pm = qm; });
    }
  });
  var m = tr.length, lp = new Float32Array(6 * m), lm = new Float32Array(2 * m), ls = new Float32Array(2 * m).fill(1), lc = new Float32Array(6 * m);
  tr.forEach(function (t, i) { lp.set(t[0], 6 * i); lp.set(t[1], 6 * i + 3); lm[2 * i] = t[3]; lm[2 * i + 1] = t[4]; lc.set(t[2], 6 * i); lc.set(t[2], 6 * i + 3); });
  // The same count as the picture before: the buffers are filled in place; a different one makes new geometry.
  var put = function (key, make, arrays, count) {
    var cur = st[key];
    if (cur && cur.count === count && count > 0) {
      var at = cur.mesh.geometry.attributes;
      Object.keys(arrays).forEach(function (a) { at[a].array.set(arrays[a]); at[a].needsUpdate = true; });
      return;
    }
    if (cur) { st.scene.remove(cur.mesh); cur.mesh.geometry.dispose(); st[key] = null; }
    if (count > 0) { var mesh = make(); st.scene.add(mesh); st[key] = { mesh: mesh, count: count }; }
  };
  var geo = function (a) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.position, 3)); g.setAttribute('aMag', new THREE.BufferAttribute(a.aMag, 1));
    g.setAttribute('aScale', new THREE.BufferAttribute(a.aScale, 1)); g.setAttribute('aColor', new THREE.BufferAttribute(a.aColor, 3));
    return g;
  };
  var pa = { position: pos, aMag: mag, aScale: scl, aColor: col }, la = { position: lp, aMag: lm, aScale: ls, aColor: lc };
  put('skyPts', function () { var p = new THREE.Points(geo(pa), st.skyPtMat); p.frustumCulled = false; p.renderOrder = -1; return p; }, pa, n);
  _aeStandSkyBoards(st, boards);
  put('skyLines', function () { var l = new THREE.LineSegments(geo(la), st.skyLineMat); l.frustumCulled = false; l.renderOrder = -1; return l; }, la, m);
}
// A tap on one of them names it (while it can be seen): true if the tap was theirs.
// A tap on the Sun or the Moon goes in on it: a field of AE_STAND_BODY_FOV_DEG, glided to; a tap on it again (or any pinch out) comes back.
var AE_STAND_BODY_FOV_DEG = 6, AE_STAND_BODY_TAP_PX = 44, AE_STAND_ZOOM_FLY_MS = 700, AE_STAND_ZOOMED_IN = 0.3;
function _aeStandBodyAt(st, x, y) {
  var V = _ae.gl.THREE.Vector3, best = null, bestD = AE_STAND_BODY_TAP_PX;
  [{ dir: st.fr.sun, name: 'sun' }].concat(st.fr.objs.filter(function (o) { return o.key === AE_STAND_MOON_NAME; }).map(function (o) { return { dir: o.dir, name: 'moon' }; })).forEach(function (o) {
    if (o.dir[2] < -0.02) return;
    var p = new V(o.dir[0] * AE_STAND_SKY_AT_M, o.dir[1] * AE_STAND_SKY_AT_M, o.dir[2] * AE_STAND_SKY_AT_M).project(st.camera);
    if (p.z < -1 || p.z > 1) return;
    var d = Math.hypot((p.x + 1) / 2 * _ae.w - x, (1 - p.y) / 2 * _ae.h - y);
    if (d < bestD) { bestD = d; best = o; }
  });
  return best;
}
function _aeStandFlyTo(st, zoom, yaw, pitch) {
  var dy = yaw - st.userYaw; dy = ((dy + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;   // the short way round
  st.zf = { t0: performance.now(), z0: st.zoom, z1: _aeClamp(zoom, AE_STAND_ZOOM_MIN, AE_STAND_ZOOM_MAX), y0: st.userYaw, y1: st.userYaw + dy, p0: st.userPitch, p1: pitch };
  if (_aeReduceMotion()) st.zf.t0 -= AE_STAND_ZOOM_FLY_MS;
  st.dirty = true; _ae.dirty = true; _aeKick();
}
function _aeStandZoomStep(st, now) {
  var f = st.zf, e = _aeSmoother(_aeClamp((performance.now() - f.t0) / AE_STAND_ZOOM_FLY_MS, 0, 1));
  st.zoom = f.z0 * Math.pow(f.z1 / f.z0, e); st.userYaw = f.y0 + (f.y1 - f.y0) * e; st.userPitch = f.p0 + (f.p1 - f.p0) * e;
  st.dirty = true; _ae.dirty = true;
  if (e >= 1) st.zf = null; else _aeKick();
}
function _aeStandBodyTap(x, y) {
  var st = _ae.stand;
  if (!st || !st.live || !st.fr || !st.camera || st.mode !== 'ground') return false;
  var b = _aeStandBodyAt(st, x, y);
  if (!b) return false;
  if (st.zoom <= AE_STAND_ZOOMED_IN && st.zoomBack) { var z = st.zoomBack; st.zoomBack = null; _aeStandFlyTo(st, z.zoom, z.yaw, z.pitch); return true; }
  if (st.zoom <= AE_STAND_ZOOMED_IN) return false;
  st.zoomBack = { zoom: st.zoom, yaw: st.userYaw, pitch: st.userPitch };
  var base = _aeStandFov() / st.zoom, az = Math.atan2(b.dir[0], b.dir[1]), alt = Math.asin(_aeClamp(b.dir[2], -1, 1));
  _aeStandFlyTo(st, _aeRad(AE_STAND_BODY_FOV_DEG) / base, az - st.yaw, alt - _aeRad(AE_STAND_PITCH_DEG));
  return true;
}
function _aeStandSkyTap(x, y) {
  var st = _ae.stand;
  if (!st || !st.live || !st.skyObjs || !st.camera || !st.photo) return false;
  var V = _ae.gl.THREE.Vector3, best = null, bestD = AE_STAND_SKY_TAP_PX, W = _ae.w, H = _ae.h;
  st.skyObjs.forEach(function (o) {
    if (!o.name || o.dir[2] < -0.02 || st.photo.lim - (o.mag === undefined ? 3 : o.mag) <= 0) return;
    var p = new V(o.dir[0] * AE_STAND_SKY_AT_M, o.dir[1] * AE_STAND_SKY_AT_M, o.dir[2] * AE_STAND_SKY_AT_M).project(st.camera);
    if (p.z < -1 || p.z > 1) return;
    var d = Math.hypot((p.x + 1) / 2 * W - x, (1 - p.y) / 2 * H - y);
    if (d < bestD) { bestD = d; best = o; }
  });
  if (!best) return false;
  var tag = st.skyTag || (st.skyTag = (function () { var h = document.createElement('div'); h.className = 'ae-stand-crafts'; var sp = document.createElement('span'); sp.className = 'ae-stand-craft'; h.appendChild(sp); _ae.el.appendChild(h); return h; })());
  var sp = tag.firstChild, p2 = new V(best.dir[0] * AE_STAND_SKY_AT_M, best.dir[1] * AE_STAND_SKY_AT_M, best.dir[2] * AE_STAND_SKY_AT_M).project(st.camera);
  sp.innerHTML = '<i></i>' + _almEsc(best.name);
  sp.style.transform = 'translate(' + ((p2.x + 1) / 2 * W).toFixed(1) + 'px,' + ((1 - p2.y) / 2 * H).toFixed(1) + 'px)';
  sp.hidden = false;
  clearTimeout(st.skyTagTimer); st.skyTagTimer = setTimeout(function () { sp.hidden = true; }, AE_STAND_SKY_TAG_MS);
  return true;
}

// ── Looking around ──
function _aeStandLook(dx, dy) {
  var st = _ae.stand;
  if (!st || !st.live) return;
  if (st.motion && _aeMotionTrim(st, dx, dy, _aeDeg(_aeStandFov()), _ae.h)) { st.dirty = true; _ae.dirty = true; _aeKick(); return; }   // the phone says where; a finger trims
  st.zf = null;
  var k = _aeStandFov() / _ae.h;
  st.userYaw -= dx * k;
  st.userPitch = _aeClamp(st.userPitch + dy * k, -_aeRad(AE_STAND_PITCH_MAX_DEG) - _aeRad(AE_STAND_PITCH_DEG), _aeRad(AE_STAND_PITCH_MAX_DEG) - _aeRad(AE_STAND_PITCH_DEG));
  st.dirty = true; _ae.dirty = true; _aeKick();
}
function _aeStandZoom(factor) {
  var st = _ae.stand;
  if (!st || !st.live) return;
  st.zf = null;
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
  '.ae-stand-text .ae-stand-sunrise{color:var(--amber);text-decoration:underline;pointer-events:auto;font-weight:600}',
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
  _aeById('ae-stand-text').addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('[data-ae-sunrise]');
    if (!a) return;
    e.preventDefault();
    if (st.rise) { _aeGoTo(st.rise.at); st.fr = null; st.dirty = true; _ae.dirty = true; _aeKick(); }
  });
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
// The time at the place itself (its zone, by the Almanac's own nearest-city table), for the Earth: the clock below is the person's.
function _aeStPlaceTime(st) {
  if (st.key !== 'earth' || typeof _almTzForLocation !== 'function') return '';
  try {
    var tz = _almTzForLocation(st.lat, st.lon), twelve = typeof _almClock12h === 'function' ? _almClock12h() : false;
    return new Intl.DateTimeFormat(typeof _currentLang !== 'undefined' ? _currentLang : undefined, { hour: 'numeric', minute: '2-digit', hour12: twelve, timeZone: tz, timeZoneName: 'short' }).format(_aeDisplayMs());
  } catch (e) { return ''; }
}
function _aeStandHudText(st) {
  var el = _aeById('ae-stand-text'), fr = st.fr;
  if (!el) return;
  var head = ((st.yaw + st.userYaw) * 180 / Math.PI % 360 + 360) % 360;   // where the view faces; the Sun's own bearing follows its height
  var line2 = (fr ? '☀ ' + Math.round(fr.sunAlt) + '°' + (fr.sunAlt < 0 ? ' ↓' : '') + ' ' + _aeCompassPoint(_aeDeg(fr.sunAz)) + '    ' : '') + '⌖ ' + Math.round(head) + '° ' + _aeCompassPoint(head);   // the Sun: its height and where it stands; the glyph: which way the view faces
  var local = _aeStPlaceTime(st), html = '<b>' + _almEsc(_aeInfoName(st.key)) + '</b><span>' + _almEsc(_aeFmtLatLon({ lat: st.lat, lon: st.lon })) + ' · ' + _almEsc(_aeStHeightText(st.h0)) + '</span><span>' + _almEsc(line2) + '</span>' + (local ? '<span>' + _almEsc(local) + '</span>' : '');
  var rise = fr && fr.sunAlt < -AE_STAND_RISE_OFFER_DEG && st.key !== 'earth' ? _aeStNextSunrise(st, _aeDisplayMs()) : null;
  if (rise) html += '<span><a href="#" class="ae-stand-sunrise" data-ae-sunrise>' + _almEsc(_aeT('alm_lm_night_until', { date: _aeFmtWhen(rise) })) + '</a></span>';
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}
// The Moon's and the planets' night is long and black: the way to the next sunrise is one tap in the corner. Found by stepping the Sun's height forward.
var AE_STAND_RISE_OFFER_DEG = 1, AE_STAND_RISE_STEPS = 420, AE_STAND_RISE_STEP_MS = { moon: 4 * 3600000 };
function _aeStNextSunrise(st, ms) {
  var c = st.rise;
  if (c && ms >= c.from && ms < c.at) return c.at;
  var step = AE_STAND_RISE_STEP_MS[st.key] || 20 * 60000, prev = _aeStFrame(st, ms).sunAlt;
  for (var k = 1; k <= AE_STAND_RISE_STEPS; k++) {
    var t = ms + k * step, a = _aeStFrame(st, t).sunAlt;
    if (prev < 0 && a >= 0) {
      var lo = t - step, hi = t;
      while (hi - lo > 60000) { var mid = (lo + hi) / 2; if (_aeStFrame(st, mid).sunAlt < 0) lo = mid; else hi = mid; }
      st.rise = { from: ms, at: hi };
      return hi;
    }
    prev = a;
  }
  return null;
}
// The eight points of the compass, from the app's own cardinal letters (NE = N then E).
var AE_POINT_KEYS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
function _aeCompassPoint(az) {
  return AE_POINT_KEYS[Math.round(((az % 360) + 360) % 360 / 45) % 8].split('').map(function (c) { return _aeT('alm_dir_' + c); }).join('');
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
  var n = _aeStToScene(frame, _aeStPlaceVec(pk.body, pk.lat, pk.lon)), r = AE_TARGETS[pk.body].surface, p = _aeAdd(centre, _aeScale(n, r));
  var cam = _ae.gl.camera, eye = [cam.position.x, cam.position.y, cam.position.z], s = _aeProject(p);
  if (!s || _aeDot(n, _aeSub(eye, p)) <= 0) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.style.transform = 'translate(' + s.x.toFixed(1) + 'px,' + s.y.toFixed(1) + 'px)';
}
