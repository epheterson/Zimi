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
var AE_STAND_TILT_TOP_KM = 30;   // the view comes up from straight down to the horizon between this height and the eye on the ground (log scale). It was 3 km to 70 m, which turned 90 degrees in 0.2 s on the way up (a whip); spread over the whole range it peaks near 150 degrees a second
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
var AE_STAND_EXPOSURE_MU_FLOOR = 0.2;   // the sine of the Sun's height under which an airless ground's exposure stops opening up (about 11.5 degrees)
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

// ── The way in ──
// Called by the Stand here button, and by anything that wants a body's ground (the models code). Opens the 3D view if it
// is not up, flies to the place, and drops to the ground once the terrain's mesh is built; resolves true when it started.
function _aeStandStart(key, lat, lon, handoff, link) {
  if (!_aeStandable(key)) return Promise.resolve(false);
  if (_ae && _ae.stand) _aeStandDrop();
  return _aeStandViewUp().then(function (up) { return up && _aeNeedsTracks(key) ? _aeBodyPlaced(key).then(function () { return up; }) : up; }).then(function (up) {
    if (!up) return false;
    if (handoff && handoff.ms !== undefined && handoff.ms !== null && typeof _aeGoTo === 'function') _aeGoTo(handoff.ms);
    // A body with no place for this date (a dwarf planet whose table does not reach it) has no sky to stand under.
    var frame = _aeStBodyNow(key);
    if (!frame) return false;
    var pend = _ae.standPending = { key: key, lat: lat, lon: lon, ready: false, t0: performance.now(), builder: null, mesh: null, tex: null, handoff: handoff || null, link: link || null, prev: _aeStandViewNow() };
    _ae.pick = null; _ae.lm = null; _ae.place = null; _ae.selected = null;
    _aeRenderCard();
    var body = AE_STAND_BODIES[key];
    // The flight comes to the nearest the orbit view lets the camera go over the place, looking straight down at it; the
    // ground is built meanwhile, and the swap to it happens where that flight ends.
    // The flight stops where the built-in colour map is still sharp (a texel about AE_STAND_SHARP_TEXEL_PX pixels), not at the nearest the view allows,
    // where its texels are blocks the size of a hand; the ground picks up from there at a few kilometres, over matching colour, by a cross-fade.
    var minDist = AE_TARGETS[key].min, dist = _aeStandSharpDist(key);
    if (_ae.target === key && !_ae.fly && _ae.dist < dist) dist = Math.max(minDist, _ae.dist);   // already nearer (Almanac HD's tiles): down from where the camera is, never out first
    pend.alt0 = Math.max(AE_STAND_CUT_KM, (dist - AE_TARGETS[key].surface) * AE_EARTH_RADIUS_KM); pend.sharp = dist;   // the ground takes the camera over exactly where the orbit view's flight ends, and falls from there: one continuous descent
    _aeStandBuild(pend, body);
    if (link && link.fromSite) { _aeKick(); return true; }   // from a visit's ground: that stays on screen until the ground is built, then Stand takes over where it stands (no trip out to orbit and back)
    _aeFlyTo(key, dist, _aeAzElOf(_aeStToScene(frame, _aeStPlaceVec(key, lat, lon))), false, AE_MOVE_MS);
    if (_ae.fly && !_ae.fly.hold) _ae.fly.endSlope = AE_STAND_FLIGHT_END_SLOPE;   // it ends at speed: the ground's fall takes it up from there, with no stop between
    _ae.preset = null;
    _aeMarkViews();
    _aeKick();
    return true;
  });
}
var AE_STAND_CUT_KM = 3, AE_STAND_SHARP_TEXEL_PX = 1.5;   // the height the view starts to look up from straight down (the ground's own range, below it); how many pixels a texel of the colour map may span
var AE_STAND_FLIGHT_END_SLOPE = 1.4;
var AE_STAND_SLOPE_MAX = 2.5;   // the steepest start a fall may have (a Hermite curve with a first slope past 3 overshoots)
var AE_STAND_DECADE_DESCENT_MS = 600, AE_STAND_DECADE_ASCENT_MS = 350;   // each tenfold of height above AE_STAND_CUT_KM that the ground's view falls through or climbs
// The width of the body's colour map as the orbit view holds it.
function _aeStandMapWidth(key) {
  var S = _ae.gl, tex = key === 'earth' ? S.earthUni.dayMap.value : key === 'moon' ? S.moonUni.moonMap.value : S.planets && S.planets[key] ? S.planets[key].uni.map.value : null;
  return tex && tex.image && tex.image.width ? tex.image.width : AE_STAND_MAP_FALLBACK_W;
}
var AE_STAND_MAP_FALLBACK_W = 2048;
// How far from the body's centre the camera stands when one texel of its map is AE_STAND_SHARP_TEXEL_PX pixels: never nearer than the view's own nearest.
function _aeStandSharpAt(key) {   // (the body's own figure, whatever body the view is on)
  var surface = AE_TARGETS[key].surface, focal = _aeFocalPx(), w = _aeStandMapWidth(key);
  return Math.max(AE_TARGETS[key].min, surface + 2 * Math.PI * surface * focal / (AE_STAND_SHARP_TEXEL_PX * w));
}
function _aeStandSharpDist(key) { return _aeClampDist(_aeStandSharpAt(key)); }
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
// The 3D view's camera as the person left it (where it is flying to, if it is flying): Back from the ground returns to it.
function _aeStandViewNow() {
  var f = _ae.fly;
  return { target: _ae.target, dist: f ? f.toDist : _ae.dist, az: f ? f.toAz : _ae.az, el: f ? f.toEl : _ae.el_, preset: _ae.preset, arrived: _ae.arrived };
}
// Back from the ground: the camera is over the place at the height the descent began from (the same picture the ground's last one fades into),
// the place marked, and it flies out the way it came to the view as it was, the body whole (never nearer than its own framing, where the map is sharp).
function _aeStandRestoreView(prev, st) {
  if (!prev || !_aeIsOpen || !_ae.gl || _ae.stand || _ae.standPending) return;
  var key = st.key, frame = _aeStBodyNow(key), t = AE_TARGETS[key];
  _ae.fly = null; _ae.pan = null;
  _ae.target = key; _ae.arrived = prev.arrived;
  if (frame && t) {
    var azel = _aeAzElOf(_aeStToScene(frame, _aeStPlaceVec(key, st.lat, st.lon)));
    _ae.dist = st.pend && st.pend.sharp ? st.pend.sharp : _aeClampDist(t.min); _ae.az = azel.az; _ae.el_ = azel.el;
    _ae.pick = { body: key, lat: st.lat, lon: st.lon };   // the place, as a dot
  }
  _ae.preset = prev.target === key ? prev.preset : null;
  if (st.altTop > st.alt0 && prev.target === key) {   // the climb ended at the view it came from: nothing more to fly
    _ae.dist = _aeClampDist(prev.dist); _ae.az = prev.az; _ae.el_ = prev.el; _ae.arrived = prev.arrived;
    _aeMarkViews(); _aeRedraw();
    return;
  }
  _aeMarkViews();
  _aeRedraw();
  var sharp = key === 'earth' ? _aeFitDist(AE_FIT_EARTH) : key === 'moon' ? _aeFitDist(AE_FIT_MOON) : 0;
  var far = prev.dist, same = prev.target === key;   // exactly the distance it left from (the planet the size it was)   // exactly the distance it left from (the planet the size it was)
  var out = function () {
    if (_ae.stand || _ae.standPending || !_aeIsOpen) return;
    // The view as it was if it was of this body; else (the ground was entered from another view) the body itself, whole.
    if (same) _aeFlyTo(key, far, { az: prev.az, el: prev.el }); else _aeFlyTo(key, sharp || _aeClampDist(t.min * AE_STAND_BACK_WHOLE), _ae.az != null ? { az: _ae.az, el: _ae.el_ } : null);
    _ae.preset = same ? prev.preset : null; _aeMarkViews();
  };
  if (_aeReduceMotion()) { if (same) { _ae.dist = _aeClampDist(far); _ae.az = prev.az; _ae.el_ = prev.el; } else _ae.dist = _aeClampDist(sharp || t.min * AE_STAND_BACK_WHOLE); _ae.dirty = true; return; }
  out();
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
    var work = function (step, then) { _aeStandSliced(step, function () { return _aeStandPendAlive(pend); }).then(function (done) { if (done) then(); }); };
    var fin = null, built = function () {
      pend.mesh = pend.builder; pend.finished = fin.result;
      // The relief's heights on the shadow grids, then every vertex against the Sun of this moment: the ground is whole when it is shown.
      pend.grids = _aeShadeGrids(function (x, y, cell) { return _aeTerrainLocal(pend.key, pend.lat, pend.lon, pend.mesh.h0, x, y, cell / 1000 * AE_STAND_SHADE_LOD, pend.flat); });
      work(pend.grids.step, function () {
        var fr0 = _aeStFrame({ key: pend.key, lat: pend.lat, lon: pend.lon, b: body, h0: pend.mesh.h0 }, _aeDisplayMs());
        pend.shade = { arr: new Float32Array(pend.mesh.count).fill(1), sun: fr0.sun.slice(), job: null, at: performance.now() };
        var job = _aeShadeJob(pend.grids, pend.mesh.pos, pend.mesh.count, pend.shade.sun, Math.tan(fr0.sunRho), pend.shade.arr);
        work(job.step, function () { _aeStandMapFor(pend).then(function () { pend.ready = true; _aeKick(); }); });
      });
    };
    work(pend.builder.step, function () { fin = _aeMeshFinisher(pend.builder); work(fin.step, built); });
  });
}
// A job in slices (step(ms) -> done) run to its end beside the picture: while anything is flying a slice follows each frame (slices one after another
// with no frame between made the frame after them late by all of them), a job's first slice included; with nothing moving, longer slices back to back.
// Resolves true when the job is done, false if its owner went first.
function _aeStandSliced(step, alive) {
  return new Promise(function (res) {
    var moving = function () { return !!(_ae && (_ae.fly || _ae.ship)); }, after = _aeAfterFrame;
    var slice = function () {
      if (!alive()) { res(false); return; }
      if (step(moving() ? AE_STAND_SLICE_MS : AE_STAND_SLICE_IDLE_MS)) res(true);
      else if (moving()) after(slice);
      else setTimeout(slice, 0);
    };
    if (moving()) after(slice); else slice();
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
  if (now - pend.t0 > AE_STAND_GIVE_UP_MS) { _ae.standPending = null; _aeLinkModeDone(); return; }
  if (!_ae.fly && pend.ready && !pend.swapping) { _aeStandSwap(pend); return; }
  // The flight is over and the ground is not built (a slow phone): the camera does not stop, it goes on down at a pace that builds up from nothing, and the ground takes it over from there.
  var h = Math.log(Math.max(1e-6, (_ae.dist - AE_TARGETS[pend.key].surface) * AE_EARTH_RADIUS_KM));
  if (!_ae.fly && !pend.swapping) {
    if (!pend.creepAt) { pend.creepAt = now; pend.creepT0 = now; }
    var dt = Math.min(0.05, (now - pend.creepAt) / 1000), r = AE_STAND_CREEP_RATE * _smoothstep(0, 1, (now - pend.creepT0) / AE_STAND_CREEP_RAMP_MS);
    pend.creepAt = now;
    if (r > 0 && dt > 0) { _ae.dist = Math.max(_aeClampDist(AE_TARGETS[pend.key].min), _ae.dist - (_ae.dist - AE_TARGETS[pend.key].surface) * (1 - Math.exp(-r * dt))); _ae.dirty = true; }
  }
  var prevH = pend.hAt;   // the speed it goes down at now (the ground's fall starts at it)
  if (prevH && now > prevH[0]) pend.vIn = _aeClamp((prevH[1] - h) / ((now - prevH[0]) / 1000), 0, 10);
  pend.hAt = [now, h];
}
var AE_STAND_CREEP_RATE = 0.1, AE_STAND_CREEP_RAMP_MS = 1500;   // the ln-height a second the camera goes on down at while the ground is built, and how slowly that starts

// ── Going down, and back ──
// The two views share one canvas, so the way between them is a cross-fade of a copy of the last picture of the one over the first
// of the other: never a black frame. The ground's shaders are compiled and its geometry uploaded while the flight's last picture is
// still on screen (a first frame that compiled in the open was a black one).
var AE_STAND_BACK_WHOLE = 8;   // a body with no framing of its own is left at this many times its nearest distance
var AE_STAND_WARM_MS = AE_GROUND_REF.warmMs, AE_STAND_WARM_PX = AE_GROUND_REF.warmPx;
// Compile the ground's programs and draw it once into a few pixels, so its first picture on screen costs nothing.
// A target three draws into exactly as it draws to the screen: the same programs and the same values. A plain target takes each material's second set of
// programs (three keys them by where the colour goes), compiled the first time a scene is drawn into one: 240 ms for the Moon's whole scene.
function _aeScreenLikeTarget(T, w, h) {
  var rt = new T.WebGLRenderTarget(w, h);
  rt.isXRRenderTarget = true;            // (three's own switch for "this target is the display": the screen's programs, the screen's colour space)
  rt.texture.colorSpace = T.SRGBColorSpace;
  rt.texture.internalFormat = 'RGBA8';   // kept as written: an sRGB store would encode the shaders' finished colours a second time
  return rt;
}
// The programs a ground was warmed with are kept for the life of the view. three gives a program (and its two shaders' numbers, which are part of how it
// finds the program again) back when the last material that used it is disposed, and every ground is the same shaders: without this each new ground
// compiled them all again, and compiling stalls the picture (the GPU's own process is busy with it, wherever it is asked from) while the craft is still
// coming down. So one copy of each of a warmed ground's materials stays in a scene that is never drawn or disposed: only the first ground of a view compiles.
function _aeStandKeep(W, forTarget, forScreen) {   // materials, or scenes of them: those drawn into a target, those drawn as to the screen
  var S = _ae.gl, T = S.THREE, K = S.standKeep;
  if (!K) {
    K = S.standKeep = { seen: {}, plain: new T.Scene(), like: new T.Scene(), geo: new T.BufferGeometry() };
    K.geo.setAttribute('position', new T.BufferAttribute(new Float32Array(9), 3));
  }
  var one = function (m, into) {
    if (!m || !m.isShaderMaterial) return;
    var key = [into, m.side, m.transparent, m.vertexShader, m.fragmentShader].join('\n');
    if (K.seen[key]) return;
    K.seen[key] = true;
    var mesh = new T.Mesh(K.geo, m.clone());
    mesh.frustumCulled = false;
    K[into].add(mesh);
  };
  var all = function (list, into) { list.forEach(function (x) { if (x && x.isScene) x.traverse(function (o) { one(o.material, into); }); else one(x, into); }); };
  all(forTarget, 'plain'); all(forScreen, 'like');
  return Promise.all([W.compile(K.plain, W.plain), W.compile(K.like, W.like)]);   // (found, not compiled: the ground's own are the same programs)
}
// What a warm-up works with: a small plain target and a small one that is like the screen, a scene's programs compiled for one of them (off the main
// thread where the browser can), and a scene drawn once into one.
function _aeStandWarmer(st) {
  var S = _ae.gl, r = S.renderer, T = S.THREE, px = AE_STAND_WARM_PX, plain = new T.WebGLRenderTarget(px, px), like = _aeScreenLikeTarget(T, px, px);
  return { plain: plain, like: like,
    small: function (target, scene) { try { r.setRenderTarget(target); r.render(scene, st.camera); } catch (e) {} r.setRenderTarget(null); },
    compile: function (scene, target) {   // (the programs are chosen as compile() runs, for the target bound then)
      if (!r.compileAsync) return Promise.resolve();
      r.setRenderTarget(target);
      var done = r.compileAsync(scene, st.camera).catch(function () {});
      r.setRenderTarget(null);
      return done;
    },
    dispose: function () { plain.dispose(); like.dispose(); } };
}
// Meshes made after the ground was warmed (the Earth's grass and trees), brought into its scene without stopping a frame: their programs compiled for both
// places the ground is drawn into, then each mesh drawn once small in a frame of its own (its first use, and its buffers' way to the GPU), then all of
// them shown together.
function _aeStandWarmIn(st, meshes) {
  var W = _aeStandWarmer(st), T = _ae.gl.THREE, tmp = new T.Scene(), alive = function () { return !!st.scene; };
  meshes.forEach(function (m) { tmp.add(m); });
  var only = function (mesh, target) { meshes.forEach(function (m) { m.visible = m === mesh; }); W.small(target, tmp); };
  var steps = [function () { return W.compile(tmp, W.plain); }, function () { return W.compile(tmp, W.like); }];
  meshes.forEach(function (mesh) { steps.push(function () { only(mesh, W.plain); }); });
  var seen = [];
  meshes.forEach(function (mesh) { if (seen.indexOf(mesh.material) < 0) { seen.push(mesh.material); steps.push(function () { only(mesh, W.like); }); } });
  return steps.reduce(function (before, step) {
    return before.then(function () { return alive() ? Promise.resolve(step()).then(_aeStandNextFrame) : null; });
  }, Promise.resolve()).then(function () { return alive() ? _aeStandKeep(W, seen, seen) : null; }).catch(function () {}).then(function () {
    W.dispose();
    meshes.forEach(function (m) { m.visible = true; tmp.remove(m); });
    if (!alive()) return false;
    meshes.forEach(function (m) { st.scene.add(m); });
    st.dirty = true; _aeRedraw();
    return true;
  });
}
function _aeStandNextFrame() { return new Promise(function (res) { requestAnimationFrame(function () { res(); }); }); }
// Everything the ground's first pictures would otherwise stop a frame for, done ahead and a step a frame: each scene's programs compiled off the main
// thread (where the browser can) for the place they will be drawn into, then drawn once small; the full-size multisampled target made and drawn into; the
// sky's small target; the Earth's own air (its tables, its sky). Measured in one go on a desktop GPU these came to about 130 ms, 60 of them the air's
// tables: the hitch a flight down had where the ground first showed, and again 3 km up where the Earth's air comes in.
function _aeStandWarm(st) {
  var S = _ae.gl, r = S.renderer, W = _aeStandWarmer(st), plain = W.plain, like = W.like;
  var cut = false, alive = function () { return !cut && !!st.scene && !!_ae && _ae.gl === S; };
  // Steps are worth their frames only where programs are compiled off the main thread. Where they are compiled where they stand (a software renderer,
  // seconds each), the scene is compiled and drawn once small, as it always was, and its first pictures pay for the rest.
  var parallel = !!(r.extensions && r.extensions.get && r.extensions.get('KHR_parallel_shader_compile'));
  var steps = !parallel ? [function () { return W.compile(st.scene, plain).then(function () { W.small(plain, st.scene); }); }] : [
    function () { return W.compile(st.skyScene, plain).then(function () { if (alive()) _aeStandSkyPass(st); }); },   // the sky's own small picture, where the level draws it small (and which of the sky's two meshes shows)
    function () { return W.compile(st.scene, plain); }
  ].concat(S.standWarmed ? [] : _aeStandWarmUses(st, W, plain, st.scene, !st.flown)).concat([   // (a later ground of the view finds every program made and used already: only what is its own is left, its targets)
    function () {   // the multisampled target at the size it will have, drawn into once; and the copy of it out to the screen
      if (!_aeStandOffscreen(true)) return;
      var m = _aeStandMsaa(st, Math.min(S.dpr, _aeStandRatioCap()));
      r.setRenderTarget(m.rt); r.clear(); r.render(st.scene, st.camera); r.setRenderTarget(null);
      return W.compile(m.scene, like).then(function () { W.small(like, m.scene); });
    },
    function () { if (!_aeStandOffscreen(false)) return W.compile(st.scene, like); }   // drawn straight to the screen once it is all of the picture
  ]).concat(_aeStandOffscreen(false) || S.standWarmed ? [] : _aeStandWarmUses(st, W, like, st.scene, !st.flown)).concat(_aeStandWarmAir(st, W));
  var run = steps.reduce(function (before, step, i) {
    return before.then(function () { st.warmStep = i; return alive() ? Promise.resolve(step()).then(_aeStandNextFrame) : null; });
  }, Promise.resolve()).catch(function () {}).then(function () { return alive() && parallel ? _aeStandKeep(W, [st.scene, st.skyScene, st.skyMatAir], [st.msaa && st.msaa.scene].concat(_aeStandOffscreen(false) ? [] : [st.scene])).then(function () { S.standWarmed = true; }) : null; }).catch(function () {}).then(function () { st.warmStep = -1; W.dispose(); });
  // No longer than AE_STAND_WARM_MS: past that (a renderer that compiles where it stands, every step seconds long) the ground is shown as it is, and
  // the steps left are dropped: its first pictures pay for what they need, as they did before there were steps.
  return Promise.race([run, new Promise(function (res) { setTimeout(function () { cut = true; res(); }, AE_STAND_WARM_MS); })]);
}
// A program's first use is not free even compiled: three asks the GPU for its log, and the answer is waited for (tens of milliseconds for a scene's
// dozen programs at once). So under a craft, where the picture is moving all the while, each of the scene's materials is used once, alone, in a frame of its own.
function _aeStandWarmUses(st, W, target, scene, together) {
  if (together) return [function () { W.small(target, scene); }];   // (a ground stood on from a still camera: one step, so the wait for it is short)
  var meshes = [], seen = [];
  scene.traverse(function (o) { if (o.material && seen.indexOf(o.material) < 0) { seen.push(o.material); meshes.push(o); } });
  return meshes.map(function (mesh) {
    return function () {
      var hidden = [];
      scene.traverse(function (o) { if (o.material && o !== mesh && o.visible) { o.visible = false; hidden.push(o); } });
      var was = mesh.visible;
      mesh.visible = true;
      W.small(target, scene);
      mesh.visible = was;
      hidden.forEach(function (o) { o.visible = true; });
    };
  });
}
// The Earth's own air (a provider: almanac-oneair.js) comes in 3 km up: its tables built ahead, then its sky's material compiled where the sky is drawn.
function _aeStandWarmAir(st, W) {
  var P = _aeStandAir;
  if (!P || !P.glsl || !P.warm || !P.covers || !P.covers(st.key)) return [];
  return [
    function () { return P.warm(st); },
    function () {
      if (!_aeStandAirMat(st)) return;
      var own = st.skyMesh.material, set = function (m) { st.skyMesh.material = m; if (st.skyLowMesh) st.skyLowMesh.material = m; };
      set(st.skyMatAir);
      var done = Promise.all([W.compile(st.skyScene, W.plain), W.compile(st.scene, W.plain)]);
      set(own);   // (the programs were chosen as compile() ran)
      return done.then(function () {   // and used once: a program's first use asks the GPU for its log, and waits for the answer
        if (!st.scene || _ae.gl.standWarmed) return;
        set(st.skyMatAir); W.small(W.plain, st.skyScene); W.small(W.plain, st.scene); set(own);
      });
    }
  ];
}
function _aeStandSwap(pend) {
  pend.swapping = true;
  pend.alt0 = Math.min(pend.alt0, Math.max(AE_STAND_CUT_KM, (_ae.dist - AE_TARGETS[pend.key].surface) * AE_EARTH_RADIUS_KM));   // the ground takes the camera where it is now
  var st = _aeStandNew(pend);
  if (!st) { _ae.standPending = null; _aeLinkModeDone(); return; }
  _aeStandWarm(st).then(function () {
    if (_ae.standPending !== pend || !_ae.gl) { _aeStandDispose(st); return; }
    _ae.standPending = null;
    if (pend.link && pend.link.fromSite && _ae.site) _aeSiteLeave(true, true, true);   // (the visit's own picture was the one on screen, at its own day: the walk goes on in the same light)
    var blend = !_aeReduceMotion() && !st.direct && !(pend.handoff && pend.handoff.direct) && _aeStandOffscreen(true);   // the ground comes up over the orbit view's own picture (no copy to fade)
    var still = blend ? null : _aeStandStill();
    st.blendOn = blend;
    _ae.stand = st;
    st.t0 = performance.now();   // the descent starts now, not when the ground was built
    _aeStandEnter(st);
    _aeStandDraw(performance.now());   // the ground's first picture is on the canvas under the copy of the last of the flight
    _aeStandStillFade(still);
  });
}
function _aeStandNew(pend) {
  var S = _ae.gl, b = AE_STAND_BODIES[pend.key];
  var st = {
    grids: pend.grids, meshPos: pend.mesh.pos, meshCount: pend.mesh.count, shade: pend.shade,
    vIn: pend.vIn || 0, key: pend.key, lat: pend.lat, lon: pend.lon, b: b, h0: pend.mesh.h0, alt0: pend.alt0, mode: 'descend', t0: performance.now(),
    altKm: pend.alt0, yaw: 0, pitch: -AE_STAND_PITCH_MAX_DEG * Math.PI / 180, userYaw: 0, userPitch: 0, zoom: 1, live: false,
    direct: !!pend.link, atmo: AE_ST_ATMO[pend.key] || null, fr: null, photo: null, drawnMs: 0, dirty: true, hudAt: 0, pend: pend
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
  _aeLinkModeDone();
  el.classList.add('ae-standing');
  _aeStandClockZone(st);
  _aeStandHud(st);
  _aeStandWalkKeys(true);
  _aeStandWalkHint(st);
  _aeFullStepIn();
  _aeStandTakeCanvas(st, S);
  var fr = _aeStFrame(st, _aeDisplayMs());
  st.yaw = st.key === 'earth' ? _aeRad(_aeStandDefaultHeading(st.lat)) : fr.sunAlt > AE_STAND_SUN_FACE_DEG ? fr.sunAz : 0;   // on Earth the card's own rule (toward the equator), elsewhere the Sun's side; a hand-off's heading, below, wins
  var ho = st.pend && st.pend.handoff;
  if (ho) {   // a hand-off from the live sky card: its facing, not the Sun's
    st.handoff = ho;
    if (typeof ho.heading === 'number') st.yaw = _aeRad(ho.heading);
    if (typeof ho.pitch === 'number') st.userPitch = _aeRad(ho.pitch) - _aeRad(AE_STAND_PITCH_DEG);
  }
  var lk = st.pend && st.pend.link;   // a link's facing, as the address wrote it (see "The address", almanac-earth.js)
  if (lk) { st.yaw = _aeRad(lk.heading); st.userPitch = _aeRad(lk.pitch) - _aeRad(AE_STAND_PITCH_DEG); st.zoom = _aeClamp(lk.zoom, AE_STAND_ZOOM_MIN, AE_STAND_ZOOM_MAX); }
  st.yaw0 = 0;
  st.orbitAz = _ae.az; st.orbitEl = _ae.el_;   // the orbit view's turn where the flight ended
  if (!st.direct && !(ho && ho.direct)) st.orbit = _aeStandOrbitLook(st, fr);   // the orbit view's camera as the flight left it: its turn and its lens, given up as the view tilts
  // (stepping out of a craft, the trees wait until the eye is at rest: building them holds the picture for a moment, which a camera on the move would show)
  if (st.key === 'earth') setTimeout(function () { if (_ae.stand === st || (_ae.site && _ae.site.host && _ae.site.host.st === st)) _aeStandTrees(st); }, AE_STAND_TREES_DELAY_MS + (st.stepOut ? AE_STAND_STEP_MS : 0));
  _aeRedraw();
}
// The orbit view's picture at the end of its flight, as turns of the ground view's own: the heading its screen-up points to over the place (taken from the one Stand starts with), its lens.
function _aeStandOrbitLook(st, fr) {
  var cam = _ae.gl.camera, e = cam.matrixWorld.elements, upv = [e[4], e[5], e[6]];
  var hdg = Math.atan2(_aeDot(upv, fr.east), _aeDot(upv, fr.north)), d = hdg - st.yaw;
  return { yaw: Math.atan2(Math.sin(d), Math.cos(d)), fov: cam.fov };
}
// Back to orbit: the camera climbs the way it came, then the orbit view is shown again where the flight left it.
function _aeStandLeave(history) {
  if (_ae.standPending) {   // asked back before the fall has begun (the flight down to it, or its ground still being built): back to the view it began from
    var pend = _ae.standPending;
    _ae.standPending = null;
    if (history !== false) { _aeStandBackOut(pend); return; }
  }
  var st = _ae.stand;
  if (!st || st.mode === 'ascend') return;
  if (history !== false) _aeFullStepOut();
  // The climb starts from the height the view is at: the ground's, or part way down a fall that is turned back (it used to start from the ground whatever the
  // height, so a fall left half way jumped to the ground first).
  st.fromPitch = st.mode === 'descend' ? st.userPitch + _aeRad(AE_STAND_PITCH_DEG) : st.pitch;
  st.mode = 'ascend'; st.t0 = performance.now(); st.fromAlt = st.altKm; st.downFrom = 0;
  // The climb goes on up to the height the view it came from stood at (not stopping at the orbit flight's end and starting another move there): over the orbit view's own picture, which
  // takes the ground's place as it thins out, and whose turn is eased from the place-facing one to the view's.
  var back = st.pend && st.pend.prev && !st.handoff && !st.direct ? st.pend.prev : null;
  st.altTop = back && back.target === st.key && !_aeReduceMotion() ? Math.max(st.alt0, (back.dist - AE_TARGETS[st.key].surface) * AE_EARTH_RADIUS_KM) : st.alt0;
  if (_aeReduceMotion()) _aeStandFinishLeave(st);
  _aeRedraw();
}
// A way down given up before its fall began. It used to stop where the flight had got to (low over the place, in the orbit view's own controls): the button
// pressed twice did not end where it began. The view flies back to the one it left; and pressed a third time while it does, it goes down to the same place.
function _aeStandBackOut(pend) {
  var prev = pend.prev;
  _ae.standUndo = { key: pend.key, lat: pend.lat, lon: pend.lon };
  if (prev && prev.target === pend.key && _aeIsOpen && _ae.gl) {
    _aeFlyTo(pend.key, _aeClampDist(prev.dist), { az: prev.az, el: prev.el });
    _ae.preset = prev.preset;
  }
  _aeMarkViews();
  _aeRedraw();
}
// The place a way down was given up for, while the view is still on its way back from it (else null: a new way down starts where the view looks).
function _aeStandUndone(key) {
  var u = _ae.standUndo;
  _ae.standUndo = null;
  return u && u.key === key && _ae.fly ? u : null;
}
// The way up turned back: the same view falls again from the height it had reached (the one button goes either way at any moment of the move).
function _aeStandTurnBack(st) {
  if (st.mode !== 'ascend' || st.fading) return;
  st.mode = 'descend'; st.t0 = performance.now(); st.downFrom = st.altKm; st.vIn = 0;
  _aeFullStepIn();
  _aeRedraw();
}
function _aeStandFinishLeave(st) {
  st.fading = true;
  // The copy of the ground's last picture is read off the canvas, which is blank unless it was drawn in this same task (the step that ends the climb runs before the
  // frame's own picture): draw the ground once more, then copy, or the picture that fades out is black and the Moon seems to appear out of nothing.
  if (_ae.gl && _aeIsOpen && typeof _aeStandDraw === 'function') { try { _aeStandDraw(performance.now()); } catch (e) {} }
  var still = _aeStandStill(), prev = st.pend && st.pend.prev && !st.handoff ? st.pend.prev : null;   // a card's hand-off goes back to the card (_aeStandAfterClose), not to a view
  var then = st.then;   // a tapped body in the sky: the view, once it is back, flies to it (_aeStandGoTo)
  _aeStandDrop();
  _aeStandRestoreView(prev, st);
  if (then && _ae.gl && _aeIsOpen) _aePreset(then);
  if (_ae.gl && _aeIsOpen) _aeDraw(performance.now(), true);   // its first picture is on the canvas under the copy of the ground's last
  _aeStandStillFade(still);
}
// keep: only the standing ends; the ground itself goes on, drawn under a craft lifting off from it (_aeStandRelease).
function _aeStandDrop(closing, keep) {
  var st = _ae && _ae.stand;
  _aeStandWalkKeys(false);
  if (_ae) _ae.walkPtr = null;
  ['ae-walk-stick', 'ae-walk-hint'].forEach(function (i) { var el = _aeById(i); if (el) el.remove(); });
  _aeStandClockZone(null);
  _aeStandRedDay(null, false);
  if (_ae) _ae.standPending = null;
  if (!closing && !keep) setTimeout(_aeStandAfterClose, 0);   // the way back, when _aeStandClose asked for it
  _ae.shipLanded = null;   // the landing's ground is left
  if (!st) return;
  _ae.stand = null;
  _ae.move = null;
  var S = _ae.gl;
  if (S && S.hd) S.hd.ahead = null;
  if (_ae.el) _ae.el.classList.remove('ae-standing');
  if (st.hud && st.hud.parentNode) st.hud.parentNode.removeChild(st.hud);
  if (st.motion || st.motionPending) _aeMotionStop(st, true);   // the choice is kept: it comes back next time
  if (!keep) _aeStandDispose(st);
  if (S) {
    S.renderer.setClearColor(0x000000, 0);
    if (!keep) { S.renderer.setPixelRatio(st.prevRatio || S.dpr); _aeResize(); }
  }
  if (!closing) _aeFullStepOut();
  _aeStandMarkPick();
  _aeRedraw();
}

// A ground already drawn under a craft flown down to it (almanac-standhost.js, the flight's ground) becomes the ground stood on: no second build and no trip
// out to orbit and back. `at`: where the eye stands on it (x, y metres from its origin), the way it faces (heading, radians from north), and `from`, the
// camera it had a moment ago ({ pos, fwd, fov }), which the eye's own view is eased from over AE_STAND_STEP_MS (stepping out of the craft).
var AE_STAND_STEP_MS = 900;
function _aeStandAdopt(st, pend, at) {
  if (_ae.stand) _aeStandDrop();
  _ae.standPending = null;
  pend.prev = _aeStandViewNow();
  pend.link = { heading: _aeDeg(at.heading), pitch: 0, zoom: 1 };
  st.host = false; st.flown = false; st.alpha = undefined; st.direct = true; st.mode = 'ground'; st.tilt = 1; st.pend = pend;
  st.stepOut = at.from ? { pos: at.from.pos, fwd: at.from.fwd, fov: at.from.fov, t0: performance.now() } : null;
  _ae.stand = st;
  _aeStandEnter(st);
  var w = _aeStandWalkOf(st);
  w.x = w.x0 = at.x; w.y = w.y0 = at.y; w.h = _aeStandWalkGround(st, at.x, at.y);
}
// The other way: the standing ends and the ground is handed back as it is (its scene, its meshes), for the craft that lifts off over it.
function _aeStandRelease(st) {
  if (_ae.stand !== st) return false;
  _aeStandDrop(false, true);
  st.host = true; st.flown = true; st.walk = null; st.stepOut = null;
  return true;
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
  _aeStandRings(S).then(function (tx) { if (st.scene) st.ringTex = tx; });
  scene.add(_aeStandGroundMesh(st, pend, U, mat));
  st.scene = scene; st.camera = camera;
  // Compiled and warmed by _aeStandWarm before the first picture (almanac-standhost.js draws its own).
}
// Saturn's rings as a texture, made once for the view and shared by every ground it draws (each ground made its own, written out and read back: 40 ms).
function _aeStandRings(S) {
  if (S.standRings) return S.standRings;
  S.standRings = typeof _aeRingCanvas === 'function' ? _aeCanvasTexture(S.THREE, _aeRingCanvas()).catch(function () { return null; }) : Promise.resolve(null);
  return S.standRings;
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
  _aeLoadTexture(THREE, SG_MILKYWAY_URL).then(function (t) { uni.uMilky.value = t; st.dirty = true; if (_ae) _aeRedraw(); }, function () {});
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
    uMap: { value: pend.tex || null }, uMapped: { value: pend.tex ? 1 : 0 }, uMapW: { value: 1 }, uPlaceUv: { value: [pend.lon / 360 + 0.5, pend.lat / 180 + 0.5] }, uGrey: { value: AE_STAND_GREY_MAP[st.key] ? 1 : 0 },
    uBase: { value: AE_STAND_BASE[st.key] || [0.5, 0.5, 0.5] }, uGain: { value: AE_STAND_TINT[st.key] || [1, 1, 1] },
    uAmbient: { value: [0, 0, 0] }, uSkyHor: { value: [0, 0, 0] }, uSkyZen: { value: [0, 0, 0] }, uE2: { value: [0, 0, 0] }, uDir2: { value: [0, 0, 1] },
    uLommel: { value: a ? 0 : 1 }, uRough: { value: AE_STAND_ROUGH[st.key] || (st.b.fbm.amp > 100 ? 1.3 : 1) }, uRock: { value: st.key in AE_STAND_ROCK ? AE_STAND_ROCK[st.key] : 0.25 }, uDetail: { value: st.key === 'earth' ? 1 : 0 }, uKg: { value: 1 }, uGrass: { value: 0 }, uTundra: { value: 0 }, uCanopy: { value: 0 }, uCover: { value: st.key === 'earth' ? 1 : 0 }, uMatch: { value: [1, 1, 1] },
    uHd: { value: 0 }, uHdFar: { value: null }, uHdNear: { value: null }, uHdFarWin: { value: [0.5, 0.5, 1, 1] }, uHdNearWin: { value: [0.5, 0.5, 1, 1] },
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
var AE_STAND_TINT = { moon: [0.6, 0.6, 0.6], mars: [1.9, 0.85, 0.34], titan: [4.2, 3.0, 1.6], earth: [2.2, 2.2, 2.2] };
var AE_STAND_SKY_SCALE = 0.5;              // the sky is drawn at this share of the screen's size and stretched (the ground is not)
var AE_STAND_SKY_BY_LEVEL = [0.33, 0.5, 1];   // ... by capability level's skyQuality (capability.js): a light device draws it smaller, a roomy one sharper
function _aeStandSkyScale() { return typeof ZimiCap !== 'undefined' ? AE_STAND_SKY_BY_LEVEL[ZimiCap.get('skyQuality')] : AE_STAND_SKY_SCALE; }
// How much of the instanced detail (grass tufts, trees) this device draws, 0..1, by the level's materialDetail (all of it without capability.js).
var AE_STAND_DETAIL_BY_LEVEL = [0.3, 0.7, 1];
function _aeStandDetail() { return typeof ZimiCap !== 'undefined' ? AE_STAND_DETAIL_BY_LEVEL[ZimiCap.get('materialDetail')] : 1; }
var AE_STAND_DPR_STEPS = [1.5, 1.25, 1, 0.75];   // the pixel ratios the ground view steps down through if frames run long
var AE_STAND_SLOW_MS = [20, 250], AE_STAND_SLOW_RUN = 3;   // a frame this slow (not an idle gap) three times running drops a step
var _aeStandDprCap = AE_STAND_DPR_MAX;     // for the rest of the session: it goes down, never back up (without capability.js)
// The pixel ratio Stand here draws at: the capability level's, under the one governor (capability.js), else the steps below.
// The ground takes the canvas: an opaque clear and its own pixel ratio, the view's kept to give back on leaving.
function _aeStandTakeCanvas(st, S) {
  S.renderer.setClearColor(0x000000, 1);
  st.prevRatio = S.renderer.getPixelRatio();
  S.renderer.setPixelRatio(Math.min(S.dpr, _aeStandRatioCap()));
  _aeResize();
}
function _aeStandRatioCap() { return typeof ZimiCap !== 'undefined' ? ZimiCap.dprCap('stand') : _aeStandDprCap; }
var AE_STAND_STATION_MIN_LIM = 3;           // the station is marked once the sky is dark enough for stars of this magnitude
var AE_STAND_PROBE_MARKS = false;          // deep-space probes are pinpoints nobody could see: not marked (the station's pass is, near Earth)
var AE_STAND_SKY_MATCH_SHARE = 0.55;      // and how far (in log) toward it: a view with sunlit ground in it cannot be exposed for the sky alone
var AE_STAND_SKY_MATCH_DEG = [-20, 6];     // the Sun's height over which the Earth's exposure goes from this view's own to the 2D sky's
var AE_STAND_GROUND_OWN_K_DEG = [-6, 10];   // the Sun heights between which the ground's exposure goes from the provider's to this view's own
var AE_STAND_NIGHT_GLOW = AE_GROUND_REF.nightGlow;           // the least light the Earth's ground has (starlight and airglow, in this view's units: the Sun at the Earth is 1): a dark-adapted eye makes out the ground and its horizon
var AE_STAND_SLICE_IDLE_MS = AE_GROUND_REF.sliceIdleMs;           // and once the flight is over nothing else moves: the building takes longer breaths of work (a slow phone waited many seconds with nothing to show)
var AE_STAND_SLICE_MS = AE_GROUND_REF.sliceMs;                 // a slice of building between breaths of the page
var AE_STAND_SHADE_LOD = 1.5;              // the shadow grids hold wavelengths down to this many cells
var AE_STAND_SHADE_MOVE = 0.0044, AE_STAND_SHADE_EVERY_MS = 300, AE_STAND_SHADE_SLICE_MS = 5;   // the Sun has moved a quarter degree; not again sooner than this; the work a frame
var AE_STAND_BASE = { ceres: [0.5, 0.48, 0.45] };
var AE_STAND_ROUGH = { earth: 0.25 };   // the fine bumps' scale: the Earth's ground is turf and soil, not regolith
// Stones: none on the Earth (its grass and dry plains are not stony ground, and the land cover cannot say where it is bare per pixel).
var AE_STAND_ROCK = { earth: 0, moon: 0.28, mercury: 0.28, venus: 0.4, mars: 0.4, io: 0.2, europa: 0.08, ganymede: 0.22, callisto: 0.3, titan: 0.3, pluto: 0.15 };
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
  st.ringTex = null;   // (one for every ground of the view: _aeStandRings)
  Object.keys(st.discMaps || {}).forEach(function (k) { var m = st.discMaps[k]; if (m && m !== true) m.dispose(); });
  if (st.craftHost && st.craftHost.parentNode) st.craftHost.parentNode.removeChild(st.craftHost);
  if (st.stars) st.stars.geometry.dispose();
  if (st.skyRT) st.skyRT.dispose();
  if (st.msaa) { st.msaa.rt.dispose(); st.msaa.mat.dispose(); st.msaa = null; }
  if (st.skyMatAir) st.skyMatAir.dispose();
  if (st.skyPts) st.skyPts.mesh.geometry.dispose();
  if (st.skyLines) st.skyLines.mesh.geometry.dispose();
  if (st.skyTag && st.skyTag.parentNode) st.skyTag.parentNode.removeChild(st.skyTag);
  clearTimeout(st.skyTagTimer);
  st.geo = st.mats = null; st.scene = st.camera = null;
}

// ── Trees ──
// Where the Blue Marble says forest (a dark green), below the trees' line, not in the sea: dark cones scattered in rings out to a few
// kilometres, a tree to a few metres at the feet and a wood at the horizon. The same trees every visit to a place (seeded by it).
var AE_STAND_TREES_DELAY_MS = 40, AE_STAND_TREES_MAX = AE_GROUND_REF.treesMax, AE_STAND_TREES_TRIES = 18000;
var AE_STAND_TREES_RANGE_M = AE_GROUND_REF.treesRangeM, AE_STAND_TREES_THIN_M = [60, 380];   // out to here; thinner near the viewer (nothing at all inside the first number's reach)
var AE_STAND_TREE_KINDS = { conifer: 0, broadleaf: 1, palm: 2, trunk: 3, shrub: 4 };   // what the shader colours by
function _aeStCoverPixels(tex) {   // the colour map's pixels, read once for the view (drawing the map to a canvas and reading it back is 20 ms and more)
  if (!tex || !tex.image) return null;
  var S = _ae.gl, had = S.coverPixels;
  if (had && had.tex === tex) return had.px;
  var im = tex.image, w = im.width || im.naturalWidth, h = im.height || im.naturalHeight;
  if (!w || !h) return null;
  var c = document.createElement('canvas'), mw = Math.min(w, 2048), mh = Math.round(mw * h / w);
  c.width = mw; c.height = mh;
  var cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(im, 0, 0, mw, mh);
  var px = { w: mw, h: mh, d: cx.getImageData(0, 0, mw, mh).data };
  S.coverPixels = { tex: tex, px: px };
  return px;
}
// Where a place's pixel starts in the cover map's bytes.
function _aeStPixelAt(px, lat, lon) {
  var x = Math.min(px.w - 1, Math.max(0, Math.floor((lon + 180) / 360 * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor((lat + 90) / 180 * px.h)));
  return 4 * (y * px.w + x);
}
// Grass blades' or trees' triangles as a geometry: positions, normals and each vertex's tree (or blade) data.
function _aeStVegGeometry(THREE, P, N, T) {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3)); g.setAttribute('aNrm', new THREE.BufferAttribute(new Float32Array(N), 3)); g.setAttribute('aTree', new THREE.BufferAttribute(new Float32Array(T), 3));
  return g;
}
function _aeStForest(px, lat, lon) {   // 0..1: how much of this place the map shows as forest (the bitmap is flipped, south first, as the ground's own lookup assumes)
  var i = _aeStPixelAt(px, lat, lon), r = px.d[i] / 255, g = px.d[i + 1] / 255, b = px.d[i + 2] / 255, lum = 0.3 * r + 0.59 * g + 0.11 * b;
  if (g < r * 1.02 || g < b * 1.08) return 0;
  return _aeClamp((0.42 - lum) / 0.2, 0, 1);
}
// What grows where: firs and spruce in the north and the mountains (20 to 40 m), round-crowned broadleaves in the temperate lowlands
// (10 to 25 m), palms in the tropics (8 to 18 m); nothing where the map is not green, above the tree line or beyond the high latitudes.
var AE_STAND_GRASS_TREES = 0.08, AE_STAND_FOREST_TREES = 0.6;   // the share of a grass cell's sites that hold a tree, and the least of a forest cell's
// Bare ground the map shows dark and grey (lava, scree, burn): 0..1. Grass and trees thin out on it whatever the class says.
function _aeStRock(px, lat, lon) {
  var i = _aeStPixelAt(px, lat, lon), r = px.d[i] / 255, g = px.d[i + 1] / 255, b = px.d[i + 2] / 255, hi = Math.max(r, g, b), lo = Math.min(r, g, b), lum = 0.3 * r + 0.59 * g + 0.11 * b, sat = hi > 0.02 ? (hi - lo) / hi : 0;
  return _aeClamp((0.3 - lum) / 0.15, 0, 1) * _aeClamp((0.28 - sat) / 0.14, 0, 1);
}
function _aeStTreeKind(lat, h, rnd, cls) {
  var a = Math.abs(lat);
  if (a > 66) return null;
  if (a < 24) return rnd() < 0.3 ? 'palm' : 'broadleaf';
  if (cls === 'conifer') return rnd() < 0.92 ? 'conifer' : 'broadleaf';   // the grid's own word for the cell, over the latitude's guess
  if (cls === 'broadleaf') return rnd() < 0.97 ? 'broadleaf' : 'conifer';
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
// The class's ground now (the shader's own numbers), and how thick its grass is to stand (0: none).
function _aeStandGround(st, land, px) {
  var g = st.ground, cls = land && land.cls;
  var rock = px ? _aeStRock(px, st.lat, st.lon) : 0;   // lava and scree under a green class: next to no grass
  g.uGrass.value = cls === 'grass' ? 1 - rock : 0;
  g.uTundra.value = cls === 'tundra' ? 1 : 0;
  g.uCanopy.value = cls === 'broadleaf' ? 0.9 : cls === 'conifer' ? 1 : cls === 'grass' ? 0.3 : 0;
  return (land ? (AE_STAND_GRASS_DENSITY[cls] || 0) * (land.coast ? 0.6 : 1) : 0.4) * (1 - 0.95 * rock);
}
// The tufts round the feet, in slices (step(ms) -> done; .mesh when done, null if there are none): the same tufts in the same places as when they were
// made in one go.
function _aeStandGrassJob(st, dens, cls, px) {
  var THREE = _ae.gl.THREE, lat0 = st.lat, lon0 = st.lon, h0 = st.h0;
  var seed = (Math.round(lat0 * 1e4) * 19349663) ^ (Math.round(lon0 * 1e4) * 83492791), rnd = function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  var n = Math.round(AE_STAND_GRASS_COUNT * dens * _aeStandDetail()), P = [], N = [], T = [], lo = AE_STAND_GRASS_RANGE_M[0], hi = AE_STAND_GRASS_RANGE_M[1], i = 0;
  var job = { mesh: null, step: function (ms) {
    var t0 = ms ? performance.now() : 0;
    for (; i < n; i++) {
      if (ms && (i & 31) === 0 && performance.now() - t0 > ms) return false;
      var r = lo + (hi - lo) * Math.pow(rnd(), 0.8), th = rnd() * 2 * Math.PI, x0 = r * Math.sin(th), y0 = r * Math.cos(th);
      var fade = 1 - Math.min(1, Math.max(0, (r - 8) / (hi - 8))), tall = (cls === 'tundra' ? 0.04 : 0.05 + 0.1 * rnd()) * fade;   // the tufts shrink away into the texture by the range's end
      if (tall < 0.03) continue;
      var z0 = _aeTerrainLocal('earth', lat0, lon0, h0, x0, y0, r * 0.0005, st.pend && st.pend.flat), sd = rnd(), blades = 4;
      for (var b = 0; b < blades; b++) {
        var ang = rnd() * 2 * Math.PI, w = 0.008 + 0.007 * rnd(), hh = tall * (0.6 + 0.6 * rnd()), lean = 0.08 + 0.25 * rnd(), lx = Math.cos(ang) * lean * hh, ly = Math.sin(ang) * lean * hh;
        var bx = x0 + (rnd() - 0.5) * 0.25, by = y0 + (rnd() - 0.5) * 0.25, px2 = -Math.sin(ang + 1.2) * w, py2 = Math.cos(ang + 1.2) * w;
        var nx = Math.cos(ang) * 0.3, ny = Math.sin(ang) * 0.3;
        P.push(bx - px2, by - py2, z0, bx + px2, by + py2, z0, bx + lx, by + ly, z0 + hh);
        N.push(nx, ny, 0.95, nx, ny, 0.95, nx, ny, 0.95);
        T.push(0, sd, 0, 0, sd, 0, 1, sd, 0);
      }
    }
    if (!P.length || !st.scene) return true;
    var g = _aeStVegGeometry(THREE, P, N, T);
    // The blades take the ground's own colour at the place (the Blue Marble's, pulled green for a grass cell, as the ground's shader does) in linear light.
    var rgb = _aeStGrassColour(st, px, cls);
    var uni = Object.assign({}, st.ground, { uGrassAlb: { value: rgb }, uSway: { value: _aeReduceMotion() ? 0 : 1 } });
    var m = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: AE_ST_GRASS_VERT, fragmentShader: AE_ST_GRASS_FRAG, side: AE_THREE_DOUBLE_SIDE });
    job.mesh = new THREE.Mesh(g, m);
    job.mesh.frustumCulled = false; job.mesh.renderOrder = 1;
    job.count = P.length / 9;
    return true;
  } };
  return job;
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
var AE_STAND_TREE_CHUNK = AE_GROUND_REF.treeChunk;   // trees a mesh: each is a megabyte or two of corners, handed to the GPU in a frame of its own
function _aeStandTrees(st) {
  if (!st || !st.scene || st.trees || st.treesJob || st.key !== 'earth') return;
  // What the land is comes from the one grid the live sky card reads too (almanac-oneland.js); wait for it once, then go on without it if it cannot be had.
  if (typeof _osLandCoverLoad === 'function' && _osLandCover(st.lat, st.lon) === null && !st.landWait) {
    st.landWait = true;
    _osLandCoverLoad().then(function () { _aeStandTrees(st); });
    return;
  }
  var job = st.treesJob = _aeStandTreesJob(st), alive = function () { return !!st.scene; };
  _aeStandSliced(job.step, alive).then(function (done) {
    if (!done || !alive()) return;
    var meshes = (job.grass ? [job.grass] : []).concat(job.meshes);
    if (!meshes.length) return;
    return _aeStandWarmIn(st, meshes).then(function (shown) {
      if (!shown) { meshes.forEach(function (m) { m.geometry.dispose(); m.material.dispose(); }); return; }
      meshes.forEach(function (m) { st.geo.push(m.geometry); if (st.mats.indexOf(m.material) < 0) st.mats.push(m.material); });
      if (job.grass) st.grass = { mesh: job.grass, count: job.grassCount };
      if (job.meshes.length) st.trees = { meshes: job.meshes, count: job.count };
    });
  });
}
// The Earth's trees round a place, and its grass, in slices (step(ms) -> done): where each tree stands, then the grass, then each tree's shape, a few
// hundred trees to a mesh. In one go this was 330 to 630 ms, so a flight down had no trees until it had landed and stood still. The same trees in the same
// places as then: the draws of chance come in the same order.
function _aeStandTreesJob(st) {
  var px = null, job = { meshes: [], grass: null, grassCount: 0, count: 0, step: null }, phase = 0;
  var nothing = function () { return true; };
  var R = st.b.km * 1000, h0 = st.h0, lat0 = st.lat, lon0 = st.lon, THREE = _ae.gl.THREE;
  var seed = (Math.round(lat0 * 1e4) * 73856093) ^ (Math.round(lon0 * 1e4) * 19349663), rnd = function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  var landAt = typeof _osLandCover === 'function' ? _osLandCover(lat0, lon0) : null;
  var dry = !!landAt && landAt.cls === 'desert', lo = dry ? AE_STAND_SHRUB_NEAR_M[0] : AE_STAND_TREES_RANGE_M[0];   // shrubs are low: seen from 15 m, not 60
  var list = [], ratio = AE_STAND_TREES_RANGE_M[1] / lo, thin = dry ? AE_STAND_SHRUB_NEAR_M : landAt && landAt.cls === 'grass' ? AE_STAND_SAVANNA_THIN_M : AE_STAND_TREES_THIN_M;
  var k = 0, maxTrees = Math.round(AE_STAND_TREES_MAX * _aeStandDetail()), landHere = null, grassJob = null, ti = 0, mat = null;
  var P = [], N = [], T = [];   // flat arrays: positions, normals, (height fraction, seed, kind), a chunk of trees at a time
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
  var shape = function (t) {
    var K = AE_STAND_TREE_KINDS;
    if (t.kind === 'shrub') { _aeStCrown(tri, { x: t.x, y: t.y, z: t.z - 0.4 * t.h, h: t.h * 1.15, w: t.w * 2.3, lean: 0 }, t.seed, K.shrub); return; }   // no trunk: a squat ball with its lower half in the ground
    var c0 = _aeXyz(t), lean = t.lean, cx = function (f) { return t.x + lean * t.h * f; }, sd = t.seed;
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
  };
  var chunk = function () {   // the trees shaped so far become a mesh (one material for them all)
    if (!P.length) return;
    var g = _aeStVegGeometry(THREE, P, N, T);
    mat = mat || new THREE.ShaderMaterial({ uniforms: st.ground, vertexShader: AE_ST_TREE_VERT, fragmentShader: AE_ST_TREE_FRAG, side: AE_THREE_DOUBLE_SIDE });
    var mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 1;
    job.meshes.push(mesh);
    P = []; N = []; T = [];
  };
  job.step = function (ms) {
    var t0 = ms ? performance.now() : 0, late = function () { return !!ms && performance.now() - t0 > ms; };
    if (!st.scene) return true;
    if (phase === 0) {   // the map's pixels (read once for the view): a slice of its own
      try { px = _aeStCoverPixels(st.pend && st.pend.tex); } catch (e) { px = null; }
      if (!px) { job.step = nothing; return true; }
      phase = 1;
      return false;
    }
    if (phase === 1) {   // where the trees stand
      for (; k < AE_STAND_TREES_TRIES && list.length < maxTrees; k++) {
        if ((k & 15) === 0 && late()) return false;
        var r = lo * Math.pow(ratio, rnd()), th = rnd() * 2 * Math.PI, d = _aeDestination(lat0, lon0, r / R, th);
        var near = _aeClamp((r - thin[0]) / (thin[1] - thin[0]), 0, 1);
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
      phase = 2;
    }
    if (phase === 2) {
      // Open country always has some near: a few oaks within 300 m, wherever the clumps happen to fall.
      landHere = typeof _osLandCover === 'function' ? _osLandCover(lat0, lon0) : null;
      var nearTrees = list.filter(function (t) { return Math.hypot(t.x, t.y) < 300; }).length;
      var cx0 = 0, cy0 = 0;   // the fill-in comes in clumps of five or six round a centre 70 to 260 m out
      for (var fz = 0; landHere && landHere.cls === 'grass' && nearTrees < AE_STAND_GRASS_NEAR_MIN && fz < 80; fz++) {
        if (fz % 6 === 0) { var cr = 70 + 190 * rnd(), ca = rnd() * 2 * Math.PI; cx0 = cr * Math.sin(ca); cy0 = cr * Math.cos(ca); }
        var fx = cx0 + (rnd() - 0.5) * 50, fy = cy0 + (rnd() - 0.5) * 50, fr2 = Math.hypot(fx, fy), fh = 6 + 7 * Math.pow(rnd(), 1.3);
        if (fr2 < 55) continue;
        var fzz = _aeTerrainLocal('earth', lat0, lon0, h0, fx, fy, fr2 * 0.0005, st.pend && st.pend.flat);
        list.push({ kind: 'broadleaf', x: fx, y: fy, z: fzz, h: fh, seed: rnd(), lean: (rnd() - 0.5) * 0.12, w: 0.8 + rnd() * 0.5 }); nearTrees++;
      }
      var dens = _aeStandGround(st, landHere, px);
      if (dens > 0 && !st.grass) grassJob = _aeStandGrassJob(st, dens, landHere && landHere.cls, px);
      job.count = list.length;
      phase = 3;
      if (late()) return false;
    }
    if (phase === 3) {   // the grass round the feet
      if (grassJob && !grassJob.step(ms ? Math.max(1, ms - (performance.now() - t0)) : 0)) return false;
      if (grassJob) { job.grass = grassJob.mesh; job.grassCount = grassJob.count || 0; }
      phase = 4;
      if (late()) return false;
    }
    for (; ti < list.length; ti++) {   // each tree's shape
      if (ti && ti % AE_STAND_TREE_CHUNK === 0 && P.length) { chunk(); return false; }
      if ((ti & 7) === 0 && late()) return false;
      shape(list[ti]);
    }
    chunk();
    job.step = nothing;
    return true;
  };
  return job;
}

// ── The sky and the bodies in it, for an instant ──
// Positions are heliocentric, in km, in the equator of date the orbit view's scene uses; the viewer's body turns under them.
function _aeStToScene(frame, v) {   // a body-fixed vector to the scene
  var f = frame.f;
  return [f.x[0] * v[0] + f.y[0] * v[1] + f.z[0] * v[2], f.x[1] * v[0] + f.y[1] * v[1] + f.z[1] * v[2], f.x[2] * v[0] + f.y[2] * v[1] + f.z[2] * v[2]];
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
      rows: _aeXyz(P.f).map(function (ax) { return [_aeDot(ax, east), _aeDot(ax, north), _aeDot(ax, up)]; }) };
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
  var expoG = S * Math.max(mu, a ? 0 : AE_STAND_EXPOSURE_MU_FLOOR);   // the exposure's own: a grazing Sun on airless ground lights the slopes that face it fully, so the eye does not open for the flat ground's sliver of it
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
  var ref = Math.max(AE_ST_GROUND_ALBEDO_REF * ((Math.max(directG, expoG) + e2) / Math.PI + AE_STAND_GROUND_AMBIENT_SHARE * Math.max(p.amb[0], p.amb[1], p.amb[2])),
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
  var top = st.mode === 'ascend' && st.altTop ? st.altTop : st.alt0, up = Math.log10(Math.max(1, top / AE_STAND_CUT_KM));   // the decades of height above the ground view's own range: the fall from the orbit view's end
  var span = st.mode === 'ascend' ? AE_STAND_ASCENT_MS + up * AE_STAND_DECADE_ASCENT_MS : AE_STAND_DESCENT_MS + up * AE_STAND_DECADE_DESCENT_MS;
  var tt = _aeClamp((now - st.t0) / span, 0, 1), lnSpan = Math.max(1e-6, Math.log(top * 1000 / AE_STAND_EYE_M)), slope = st.mode === 'descend' ? _aeClamp(st.vIn * span / 1000 / lnSpan, 0, AE_STAND_SLOPE_MAX) : 0;
  // The fall begins at the speed the camera came down at (the Hermite curve with that first slope and none at the end), not from rest: no stop where the flight and the fall meet.
  var u = _aeReduceMotion() || (st.handoff && st.handoff.direct) || st.direct ? 1 : slope > 0 ? (tt * tt * tt - 2 * tt * tt + tt) * slope + (-2 * tt * tt * tt + 3 * tt * tt) : _aeSmoother(tt);   // direct: no flight down, the ground at once   // reduced motion: there at once
  var lo = Math.log(st.mode === 'ascend' && st.fromAlt ? st.fromAlt : AE_STAND_EYE_M / 1000), hi = Math.log(st.mode === 'descend' && st.downFrom ? st.downFrom : top), pitchLook = st.userPitch + _aeRad(AE_STAND_PITCH_DEG), down = -_aeRad(AE_STAND_PITCH_MAX_DEG);
  st.prog = u;   // (how far the fall or the climb has gone, by the clock: the rim's dot follows it)
  // The tilt (0 straight down, 1 the view up on the horizon) is a function of height, spread from AE_STAND_TILT_TOP_KM down to the eye on the ground.
  var tiltOf = function (h) { return _aeSmoother(_aeClamp(Math.log(AE_STAND_TILT_TOP_KM / h) / Math.log(AE_STAND_TILT_TOP_KM * 1000 / AE_STAND_EYE_M), 0, 1)); };
  if (st.mode === 'descend') {
    st.altKm = Math.exp(hi + (lo - hi) * u);
    st.tilt = tiltOf(st.altKm);
    st.pitch = down + (pitchLook - down) * st.tilt;   // the view is up on the horizon by the time the air is thick, not a downward view of grey
    if (u >= 1) { st.mode = 'ground'; st.pitch = pitchLook; st.tilt = 1; st.downFrom = 0; }
  } else if (st.mode === 'ascend') {
    st.altKm = Math.exp(lo + (hi - lo) * u);
    st.tilt = tiltOf(st.altKm);
    st.pitch = down + (st.fromPitch - down) * st.tilt;   // the way down, backwards: the view tips down over the last half
    if (u >= 1 && !st.fading) _aeStandFinishLeave(st);
  } else { st.altKm = AE_STAND_EYE_M / 1000; st.pitch = pitchLook; st.tilt = 1; }
}
function _aeStandFov() {
  var aspect = _ae.w / _ae.h, v = _aeClamp(2 * Math.atan(_aeTanHalf(AE_STAND_HFOV_DEG) / aspect), _aeRad(AE_STAND_FOV_MIN_DEG), _aeRad(AE_STAND_FOV_MAX_DEG));
  return v * _ae.stand.zoom;
}
function _aeStandDraw(now) {
  var st = _ae.stand;
  if (!st || !st.live || !st.scene) return;
  var ms = _aeDisplayMs();
  _aeStandView(st, now);
  if (!st.scene) return;
  _aeRimDot();   // (the last frame of the fall: the dot is put at the ground's end now, there may be no frame after it)
  st.alpha = _aeStandBlendAlpha(st);
  if (st.alpha < 1) _aeStandOrbitUnder(st, now);
  else if (st.mode === 'ascend') { _aeStandAskAhead(st); if (_ae.gl.hd) _aeHdWarm(_ae.gl); }
  _aeStandWalkStep(st, now);
  if (st.motion && st.mode === 'ground') {
    var mv = _aeMotionView(st, now);
    if (mv) { st.userYaw = _aeRad(mv.az) - st.yaw; st.userPitch = _aeRad(mv.alt) - _aeRad(AE_STAND_PITCH_DEG); st.dirty = true; }
  }
  if (st.onDraw) st.onDraw(st, now);   // something of another file's stands on this ground (a craft set down on it): its own light, every picture
  _aeStandPaint(st, now, st.mode !== 'ground' || !!st.stepOut, _aeStandPlaceCamera);   // (stepOut: the eye is still coming from the camera that followed a craft down; _aeStandBusy keeps the frames coming)
}
// One picture: the sky worked out again if the clock has moved, every shader's uniforms, the draw. `place(st)` puts the camera
// (this view's own, or a site's: almanac-standhost.js) and says where it is. Nothing is drawn if nothing changed.
// The eye is not yet the ground's when the view is still far above it: the first picture of the fall has the orbit view's exposure (a sunlit surface as bright as
// the globe's day side, the night side as dark; AE_STAND_ORBIT_GAIN was found by taking the mean of the orbit view's last frame and the ground's first, noon and midnight over San Francisco), and the eye's own (set by the light at the place, so a night is opened wide) takes over as the air thickens.
var AE_STAND_ADAPT_KM = [2000, 30], AE_STAND_ORBIT_GAIN = 0.055, AE_STAND_ORBIT_STARS = 4;   // above the first the exposure is the orbit's; below the second it is the place's own (between, by height on a log scale)
function _aeStandAdapt(st) {
  var ph = st.photo;
  if (!ph || ph.k0 === undefined || !st.fr) return;
  if (!st.kOrbit || st.kOrbitAt !== ph.k0) {   // the exposure the same place would have with the Sun overhead, once
    var f2 = Object.assign({}, st.fr, { sunMu: 1, sunAlt: 90, light2: null }), p2 = _aeStPhoto(st, f2);
    st.kOrbit = p2.k * AE_STAND_ORBIT_GAIN; st.kOrbitAt = ph.k0;
  }
  var own = _aeSmoother(_aeClamp(Math.log(AE_STAND_ADAPT_KM[0] / Math.max(st.altKm, 1e-9)) / Math.log(AE_STAND_ADAPT_KM[0] / AE_STAND_ADAPT_KM[1]), 0, 1));
  ph.k = own >= 1 ? ph.k0 : Math.exp(Math.log(st.kOrbit) * (1 - own) + Math.log(ph.k0) * own);
  ph.mw = ph.mw0 * own * own;   // and the sky behind it: the orbit view's black with a few stars, the Milky Way and the faint stars coming up as the eye opens
  ph.lim = Math.min(ph.lim0, AE_STAND_ORBIT_STARS + (ph.lim0 - AE_STAND_ORBIT_STARS) * own);
}
function _aeStandPaint(st, now, moving, place) {
  var ms = _aeDisplayMs();
  var fast = _aeClockRuns() && typeof _almRate !== 'undefined' && _almRate !== 1;
  var stale = !st.fr || Math.abs(ms - st.fr.at) >= (fast ? 1 : AE_STAND_FRAME_MS);
  if (!(moving || st.dirty || stale || st.size !== _ae.w + 'x' + _ae.h)) return;   // nothing changed: the last picture stands
  st.size = _ae.w + 'x' + _ae.h;
  if (stale) { st.fr = _aeStFrame(st, ms); st.fr.at = ms; st.photo = _aeStPhoto(st, st.fr); st.photo.k0 = st.photo.k; st.photo.mw0 = st.photo.mw; st.photo.lim0 = st.photo.lim; }
  if (!st.host || st.flown) _aeStandAdapt(st);   // (a visit's ground is always at the ground: the eye's own exposure, night included; a craft's is flown down to from space)
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
// In Red, a Surface view with the Sun up is drawn dimmer (app.css --red-daylight, the card's own share).
function _aeStandRedDay(st, on) { var cv = _ae.gl && _ae.gl.renderer && _ae.gl.renderer.domElement; if (cv && cv.hasAttribute('data-red-day') !== on) cv.toggleAttribute('data-red-day', on); }
// The multisampled target path (below) is also the one that can lay the ground over the orbit view's own picture with an opacity.
function _aeStandOffscreen(laid) {   // laid: the picture goes over another, which needs the target whatever the canvas or the device's level says
  var r = _ae.gl.renderer, THREE = _ae.gl.THREE, gl = r.getContext(), attrs = gl && gl.getContextAttributes ? gl.getContextAttributes() : null;
  var plain = !!attrs && !attrs.antialias && !(typeof ZimiCap !== 'undefined' && ZimiCap.get('skyQuality') < 1);   // (a canvas with its own multisampling, or a light device, draws straight)
  return (laid || plain) && typeof THREE.WebGLRenderTarget === 'function' && !!(r.capabilities && r.capabilities.isWebGL2);
}
// The pixel ratio a ground is drawn at: the canvas's, or its own where it is drawn into its own target and copied out (a craft's ground: its sky is
// worked out per pixel, so it is drawn less sharp than the globe, and giving the canvas itself a new size stopped the frame for 40 to 70 ms).
function _aeStandRatio(st) { return st.ownRatio || _ae.gl.renderer.getPixelRatio(); }
// The multisampled target the ground is drawn into, at the canvas's size for a pixel ratio, and the scene that copies it out.
function _aeStandMsaa(st, ratio) {
  var THREE = _ae.gl.THREE, W = Math.max(1, Math.round(_ae.w * ratio)), H = Math.max(1, Math.round(_ae.h * ratio));
  if (!st.msaa || st.msaa.w !== W || st.msaa.h !== H) {
    if (st.msaa) { st.msaa.rt.dispose(); st.msaa.mat.dispose(); }
    var rt = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, samples: AE_STAND_MSAA_SAMPLES });
    var mat = new THREE.ShaderMaterial({ uniforms: { tMs: { value: rt.texture }, uAlpha: { value: 1 } }, vertexShader: AE_ST_SKY_VERT, fragmentShader: AE_ST_COPY_FRAG, depthTest: false, depthWrite: false, transparent: true });
    var scene = new THREE.Scene(), mesh = new THREE.Mesh(st.skyBlit.geometry, mat);
    mesh.frustumCulled = false; scene.add(mesh);
    st.msaa = { rt: rt, mat: mat, scene: scene, w: W, h: H };
  }
  return st.msaa;
}
function _aeStandRender(st) {
  _aeStandRedDay(st, !!(st.fr && st.fr.sunAlt > 0));
  var S = _ae.gl, r = S.renderer, THREE = S.THREE;
  var under = st.alpha !== undefined && st.alpha < 1;   // the orbit view's picture is on the canvas: the ground is laid over it, not over black
  if (!_aeStandOffscreen(under || !!st.ownRatio)) { r.render(st.scene, st.camera); return; }
  _aeStandMsaa(st, _aeStandRatio(st));
  st.msaa.mat.uniforms.uAlpha.value = under ? st.alpha : 1;
  r.setRenderTarget(st.msaa.rt); r.clear(); r.render(st.scene, st.camera); r.setRenderTarget(null);
  if (under) r.autoClear = false;
  r.render(st.msaa.scene, st.camera);
  r.autoClear = true;
}
// The fall from orbit is one picture: while the view is still high the orbit view keeps drawing the globe at the ground camera's own height and the ground is
// laid over it, more and more opaque as it falls, so the two looks (the globe's and the air's) are a mix of the two in motion, never a freeze and a fade.
var AE_STAND_BLEND_DECADES = 1.1;   // the height over which the ground comes up from nothing to all of the picture, in tenfolds below where the orbit's flight ended
function _aeStandBlendAlpha(st) {
  if (!st.orbit || st.mode === 'ground' || !st.blendOn) return 1;
  return _aeStandAlphaAt(st.alt0, st.altKm);
}
// How much of the picture is the ground's at a height, under a top where it starts to show: a function of height alone (the fall's, and a craft's flown down by hand).
function _aeStandAlphaAt(topKm, altKm) { return _aeSmoother(_aeClamp(Math.log10(topKm / Math.max(altKm, 1e-9)) / AE_STAND_BLEND_DECADES, 0, 1)); }
// The orbit view's frame under the ground's: its camera follows the ground camera's height.
// How far down the whole move is, 0 (in space) to 1 (the eye on the ground), for the rim's dot: the flight is its first share, the fall the rest.
function _aeStandProgress() {
  var w1 = AE_MOVE_MS / (AE_MOVE_MS + AE_STAND_DESCENT_MS), st = _ae.stand, pend = _ae.standPending, f = _ae.fly;
  if (st && st.live) {
    if (st.mode === 'ground') return 1;
    var u = typeof st.prog === 'number' ? st.prog : 0;
    return st.mode === 'ascend' ? (st.altTop > st.alt0 ? 1 - u : 1 - (1 - w1) * u) : w1 + (1 - w1) * u;
  }
  if (st) return w1;   // (the frame between the ground being made and its first picture)
  if (pend) {   // (never back: a stalled frame holds the flight's own clock back, and the dot went back with it)
    pend.prog = Math.max(pend.prog || 0, pend.link && pend.link.fromSite ? 0 : w1 * (f ? _aeClamp((performance.now() - f.start) / Math.max(f.ms, 1), 0, 1) : 1));
    return pend.prog;
  }
  return null;
}
// The camera the climb ends at, for the tiles to be asked for before the hand-over: the orbit view at the height the ascent reaches, turned the way it ends.
function _aeStandAheadCam(st, back) {
  var T = _ae.gl.THREE, cam = new T.PerspectiveCamera(), c = _aeViewCam();
  c.dist = _aeClampDist((st.b.km + (st.altTop || st.alt0)) / AE_EARTH_RADIUS_KM);
  if (back) { c.az = back.az; c.el = back.el; }
  var pose = _aePoseOf(c);
  cam.fov = _ae.gl.camera.fov; cam.aspect = _ae.gl.camera.aspect;
  cam.position.set(pose.pos[0], pose.pos[1], pose.pos[2]); cam.up.set(pose.up[0], pose.up[1], pose.up[2]);
  cam.lookAt(c.tp[0], c.tp[1], c.tp[2]); cam.updateMatrixWorld();
  return cam;
}
// The globe's tiles for where the climb ends are asked for from its first moment, in the frames the globe is not drawn too (the ground covers it), so they are in
// before the hand-over.
function _aeStandAskAhead(st, back) {
  var S = _ae.gl, hd = S.hd;
  if (!hd) return;
  hd.ahead = st.mode === 'ascend' ? (st.aheadCam || (st.aheadCam = _aeStandAheadCam(st, back || st.pend && st.pend.prev && st.altTop > st.alt0 && st.pend.prev))) : (st.aheadCam = null);
}
function _aeStandOrbitUnder(st, now) {
  var keep = _ae.stand, back = st.mode === 'ascend' && st.altTop > st.alt0 && st.pend && st.pend.prev;
  _aeStandAskAhead(st, back);
  _ae.dist = _aeClampDist((st.b.km + st.altKm) / AE_EARTH_RADIUS_KM);
  if (back && st.altKm > st.alt0 && st.orbitAz !== undefined) {   // above where the flight ended: the turn goes from the place-facing view to the one it left
    var w = _aeSmoother(_aeClamp(Math.log(st.altKm / st.alt0) / Math.log(st.altTop / st.alt0), 0, 1));
    _ae.az = st.orbitAz + _aeAngleDeltaRad(st.orbitAz, back.az) * w; _ae.el_ = st.orbitEl + (back.el - st.orbitEl) * w;
  }
  var r = _ae.gl.renderer;
  _ae.stand = null;   // the frame is the orbit view's own, in every part
  _ae.standUnder = true;   // (and still the ground's: what waits for the plain view, a parked craft, is not let in by it)
  r.setClearColor(0x000000, 0);   // and on its own clear (the orbit view's canvas is transparent: its stars and glows are added on that, not on black)
  try { _aeDraw(now, true); } finally { _ae.stand = keep; _ae.standUnder = false; r.setClearColor(0x000000, 1); }
}
function _aeStandSkyPass(st) {
  _aeStandAirSelect(st);
  var S = _ae.gl, r = S.renderer, THREE = S.THREE, use = _aeStandSkyScale() < 1 && !!st.skyBlit && typeof THREE.WebGLRenderTarget === 'function';
  st.skyMesh.visible = !use; st.skyBlit.visible = use;
  if (!use) return;
  var ratio = _aeStandRatio(st), W = Math.max(1, Math.round(_ae.w * ratio)), H = Math.max(1, Math.round(_ae.h * ratio));
  var w = Math.max(1, Math.round(W * _aeStandSkyScale())), h = Math.max(1, Math.round(H * _aeStandSkyScale()));
  if (!st.skyRT || st.skyRT.width !== w || st.skyRT.height !== h) {
    if (st.skyRT) st.skyRT.dispose();
    st.skyRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
  }
  var u = st.skyBlit.material.uniforms;
  u.tSky.value = st.skyRT.texture; u.uRes.value = [W, H]; u.uTexel.value = [1 / w, 1 / h];
  r.setRenderTarget(st.skyRT); r.render(st.skyScene, st.camera); r.setRenderTarget(null);
}
// Frames that run long step the pixel ratio down; under the shared governor (capability.js) easy frames step it back up. Without it the steps below are for good.
function _aeStandBudget(st, now) {
  if (typeof ZimiCap !== 'undefined') {   // the governor is shared with every 3D scene; Stand only applies what it decides
    if (!ZimiCap.frame('stand', now)) return;
    var S0 = _ae.gl, cap = Math.min(S0.dpr, ZimiCap.dprCap('stand'));
    if (st.ownRatio) st.ownRatio = cap;   // (its own target takes the new size; the canvas is left as it is)
    else { S0.renderer.setPixelRatio(cap); _aeResize(); }
    st.starUni.uDpr.value = _aeStandRatio(st);
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
  var cam = st.camera, W = _ae.w, H = _ae.h, vfov = _aeStandFov(), pitch = st.pitch, alt = st.altKm * 1000;
  var open = st.orbit ? 1 - (st.tilt === undefined ? 1 : st.tilt) : 0;   // how much of the orbit view's own turn and lens is still in the picture (it ends where the view comes up from straight down)
  var yaw = st.yaw + st.userYaw + (open ? st.orbit.yaw * open : 0);
  if (open) vfov += (_aeRad(st.orbit.fov) - vfov) * open;
  var f = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
  var w = st.walk, wx = w ? w.x : 0, wy = w ? w.y : 0, wz = w && st.mode === 'ground' ? w.h + w.jump : 0;   // on foot: where it has walked to, the ground there and the height of a jump
  var pos = [wx, wy, alt + wz], so = st.stepOut;
  if (so) {   // stepping out of a craft: the eye's view is come to from the camera that followed it, not cut to
    var u = _aeReduceMotion() ? 1 : _aeSmoother((performance.now() - so.t0) / AE_STAND_STEP_MS);
    if (u >= 1) st.stepOut = null;
    else { pos = _aeAdd(_aeScale(so.pos, 1 - u), _aeScale(pos, u)); f = _aeNorm(_aeAdd(_aeScale(so.fwd, 1 - u), _aeScale(f, u))); vfov = so.fov + (vfov - so.fov) * u; }
  }
  cam.fov = _aeDeg(vfov); cam.aspect = W / H;
  cam.near = Math.max(0.05, alt * 0.01); cam.far = Math.max(1e5, st.b.km * 1000 * 3, (st.b.km * 1000 + alt) * 1.05);
  if (cam.view) cam.clearViewOffset();   // (a ground flown down to took the flight's own framing)
  cam.up.set(0, 0, 1);
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.lookAt(pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  var e = cam.matrixWorld.elements, tanV = Math.tan(vfov / 2);
  return { pos: pos, e: e, tanV: tanV, aspect: W / H, pixAng: 2 * tanV / (H * _aeStandRatio(st)) };
}
// The sky, the stars and the air every shader shares.
function _aeStandApplyAir(st, fr, ph, view) {
  var U = st.uni, sk = st.sky, e = view.e;
  U.uSunDir.value = fr.sun; U.uSunE.value = ph.sunE; U.uK.value = ph.k; if (st.ground) st.ground.uKg.value = _aeStandKg(st, ph);   // (kMatch: a flown ground coming in at the globe's own brightness, almanac-standhost.js _aeRigMatch)
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
// How much of the body's colour map the ground shows, 1 down to 0: from high above it is the map; as the camera comes down the map's texels, which no
// map holds finer than its own, would fill the screen as blocks, so it gives way to the map's local colour (a coarse average at the place) before they do.
// The map's own picture of the ground is worth drawing while the ground in sight holds more than a texel of it: the distance to the horizon over a texel's
// size. Standing (the horizon 5 km off, an Earth texel 20 km) the place has one colour, the map's mean there; from a few hundred metres up the map is the
// picture of the country below, as it is on the globe, so a fall or a flight down keeps the place it was looking at.
var AE_STAND_MAP_TEXELS = AE_GROUND_REF.mapTexels;   // the horizon this many texels away: the map is gone, and it is all there
function _aeStandMapShare(st) {
  var R = st.b.km, horizonKm = Math.sqrt(2 * R * Math.max(st.altKm, 0)), texelKm = 2 * Math.PI * R / _aeStandMapWidth(st.key);
  return _aeSmoother(_aeClamp((horizonKm / texelKm - AE_STAND_MAP_TEXELS[0]) / (AE_STAND_MAP_TEXELS[1] - AE_STAND_MAP_TEXELS[0]), 0, 1));
}
// The ground's exposure: the picture's, or the ground's own where a provider's sky is exposed apart, times a flown ground's match to the globe.
function _aeStandKg(st, ph) { return (ph.kGround || ph.k) * (st.kMatch || 1); }
function _aeStandApplyGround(st, fr, ph, view, now) {
  var g = st.ground;
  g.uMapW.value = _aeStandMapShare(st);
  g.uCam.value = view.pos; g.uPixAng.value = view.pixAng;
  g.uTime.value = now / 1000;
  // The least light, under the provider's own sky light too (at night it is nothing, and the ground must still be readable). It is what a dark-adapted eye
  // makes out, so it is never opened up further than this view's own widest exposure: under a provider's night exposure of millions (or a flown ground's
  // match to the globe) the same floor would glow.
  var glow = AE_STAND_NIGHT_GLOW * Math.min(1, AE_ST_EXPOSURE_TARGET / AE_ST_NIGHT_FLOOR / _aeStandKg(st, ph));
  g.uAmbient.value = ph.amb.map(function (x) { return Math.max(x, glow); });
  g.uSkyHor.value = ph.hor; g.uSkyZen.value = ph.zen; g.uDiffSky.value = ph.diffSky;
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
// The Sun's name over the ring while an eclipse is total and the view is wide (the ring is 7 px across).
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
    _aeLoadTexture(S.THREE, AE_STAND_MOON_HI_URL).then(function (t) { if (_ae.stand === st) { st.discMaps[hiKey] = t; st.dirty = true; _aeRedraw(); } else t.dispose(); }, function () {});
  }
  if (st.discMaps[hiKey] && st.discMaps[hiKey] !== true) return st.discMaps[hiKey];
  if (tex) return tex;
  var b = _aePlanetBody(key), url = b && b.map ? _aePlanetMapUrl(b) : key === AE_STAND_MOON_NAME ? AE_STAND_MOON_URL : null;
  if (url && !st.discMaps[key]) {
    st.discMaps[key] = true;
    _aeLoadTexture(S.THREE, url).then(function (t) { if (_ae.stand === st) { st.discMaps[key] = t; st.dirty = true; _aeRedraw(); } else t.dispose(); }, function () {});
  }
  return st.discMaps[key] && st.discMaps[key] !== true ? st.discMaps[key] : null;
}
var AE_STAND_MOON_URL = _almAsset('/static/earth/moon-v1.webp'), AE_STAND_MOON_HI_URL = _almAsset('/static/earth/moon-4k-v1.webp'), AE_STAND_MOON_CLOSE_PX = 24;   // the disc's radius in pixels from which the 4k map is used
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
  if (_ae.stand && _ae.stand.mode === 'ascend') _aeStandTurnBack(_ae.stand);   // (asked again on the way up: back down)
  else if (_ae.stand || _ae.standPending) _aeStandLeave(); else _aeStandAfterClose();
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
// The chunk is compiled on first use; a provider whose glsl changes is rebuilt.
var _aeStandAir = (typeof _aeStandAir !== 'undefined') ? _aeStandAir : null;
function _aeStandAirOn(st) {
  var P = _aeStandAir;
  try { return !!(P && P.glsl && P.wants && P.wants(st)); } catch (e) { return false; }
}
// The sky's material with the provider's air in it (its uniforms are there once its tables are): made once, and again if the provider's shader changes.
function _aeStandAirMat(st) {
  var THREE = _ae.gl.THREE, P = _aeStandAir;
  if (!P || !P.glsl || !P.uniforms) return null;
  if (!st.skyMatAir || st.skyAirSrc !== P.glsl) {
    if (st.skyMatAir) st.skyMatAir.dispose();
    var own = {};
    Object.keys(P.uniforms || {}).forEach(function (k) { own[k] = { value: P.uniforms[k] }; });
    st.skyMatAir = new THREE.ShaderMaterial({ uniforms: Object.assign({}, st.sky, own), vertexShader: AE_ST_SKY_VERT, fragmentShader: _aeStSkyAirFrag(P.glsl), depthTest: false, depthWrite: false });
    st.skyAirSrc = P.glsl;
  }
  return st.skyMatAir;
}
function _aeStandAirSelect(st) {
  var on = _aeStandAirOn(st), P = _aeStandAir;
  if (on) _aeStandAirMat(st);
  var m = on ? st.skyMatAir : st.skyMatOwn;
  if (st.skyMesh.material !== m) { st.skyMesh.material = m; if (st.skyLowMesh) st.skyLowMesh.material = m; }
  if (on && P.update) { try { P.update(st, st.fr, st.photo, st.skyMatAir.uniforms); } catch (e) {} }
  st.airOn = on;
}

// ── Objects in the sky from other modules ──
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
// A soft additive billboard in angular units; whether it is lit (sunlit thing, observer in twilight) is the caller's `lum`.
var AE_STAND_BOARD_MAX = 6;   // the most boards
function _aeStandSkyBoards(st, boards) {
  var THREE = _ae.gl.THREE, fr = st.fr, tw = 1;   // (the caller's `lum` already says whether the thing is sunlit and the observer in twilight: not gated twice)
  if (!st.boards) st.boards = [];
  boards.slice(0, AE_STAND_BOARD_MAX).forEach(function (o, i) {
    var b = st.boards[i];
    if (!b) {
      var uni = { uDir: { value: [0, 1, 0] }, uRight: { value: [1, 0, 0] }, uUp: { value: [0, 0, 1] }, uHalf: { value: 0.1 }, uAxis: { value: [1, 0] }, uSize: { value: [0.1, 0.05] }, uSunTan: { value: [0, -1] }, uCol: { value: [1, 1, 1] }, uColBase: { value: [1, 0.82, 0.62] }, uLum: { value: 0 }, uSeed: { value: 0 } };
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
    u.uCol.value = o.rgb || [0.82, 0.9, 1]; u.uColBase.value = o.rgbBase || [1, 0.82, 0.62]; u.uSeed.value = ((o.az * 7.3 + o.el * 3.1) % 1 + 1) % 1;
    var sv = fr ? [fr.sun[0] - d[0] * _aeDot(fr.sun, d), fr.sun[1] - d[1] * _aeDot(fr.sun, d), fr.sun[2] - d[2] * _aeDot(fr.sun, d)] : [0, 0, -1], sl = Math.hypot(sv[0], sv[1], sv[2]) || 1;
    u.uSunTan.value = [_aeDot(sv, right) / sl, _aeDot(sv, up) / sl];   // which way the Sun lies across the plume
    u.uLum.value = (o.lum === undefined ? 1 : o.lum) * tw;
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
// A tap in the sky names what it lands on, a second tap on the same name leaves the ground for it, a tap on empty sky clears the name.
// What can be named: the objects other modules put there (satellites, a train, a plume), the Sun, the Moon and the planets, and the named stars.
// A body is named while it is above the horizon and, but for the Sun and the Moon, bright enough for the sky to show it. The Sun and Moon
// are a few pixels across: their target is AE_STAND_BODY_TAP_PX. The telescope on the Sun or the Moon is the pinch's alone.
// Flying to a thing is the 3D view's own flight to it (`fly`: a Go to key, 'mars', 'iss'); a star, and a satellite with no key of its own, are named only.
var AE_STAND_BODY_TAP_PX = 44, AE_STAND_ZOOMED_IN = 0.3;   // (a zoom this far in is a telescope's field, not the sky's)
function _aeStandSkyPoint(st, d) {
  var p = new (_ae.gl.THREE.Vector3)(d[0] * AE_STAND_SKY_AT_M, d[1] * AE_STAND_SKY_AT_M, d[2] * AE_STAND_SKY_AT_M).project(st.camera);
  return p.z < -1 || p.z > 1 ? null : { x: (p.x + 1) / 2 * _ae.w, y: (1 - p.y) / 2 * _ae.h };
}
function _aeStandShines(st, mag) { return st.photo && st.photo.lim - (mag === undefined ? 3 : mag) > 0; }
// The stars with a proper name (almanac-sky.js _STAR_NAMES, keyed by the index in _STARS), each { name, eq (unit vector in the scene's equatorial frame), mag }.
var _aeStandNamedStarsList = null;
function _aeStandNamedStars() {
  if (!_aeStandNamedStarsList) {
    _aeStandNamedStarsList = typeof _STARS === 'undefined' || typeof _STAR_NAMES === 'undefined' ? [] : Object.keys(_STAR_NAMES).map(function (i) {
      var s = _STARS[i];
      return { name: _STAR_NAMES[i], eq: _aeEqVec(s[0] * AE_HOURS_TO_RAD, _aeRad(s[1]), 1), mag: s[2] };
    });
  }
  return _aeStandNamedStarsList;
}
// The named things in the sky now, each { id, name, dir, px (its target), fly }.
function _aeStandNamed(st) {
  var out = [];
  (st.skyObjs || []).forEach(function (o) {
    if (o.name && o.dir[2] >= -0.02 && _aeStandShines(st, o.mag)) out.push({ id: 'obj:' + o.name, name: o.name, dir: o.dir, px: AE_STAND_SKY_TAP_PX, fly: o.fly || (o.name === _aeT('alm_earth_iss_short') || o.name === _aeT('alm_earth_iss_name') ? 'iss' : null) });
  });
  var fr = st.fr;
  if (fr) {
    var body = function (key, dir, mag) { if (dir[2] >= -0.02 && (mag === undefined || _aeStandShines(st, mag))) out.push({ id: 'body:' + key, name: _aeInfoName(key), dir: dir, px: AE_STAND_BODY_TAP_PX, fly: key }); };
    body('sun', fr.sun);
    fr.objs.forEach(function (o) { if (o.key === AE_STAND_MOON_NAME) body(o.key, o.dir); else if (_aePlanetBody(o.key)) body(o.key, o.dir, o.mag); });
    _aeStandNamedStars().forEach(function (s) {
      var d = [_aeDot(s.eq, fr.east), _aeDot(s.eq, fr.north), _aeDot(s.eq, fr.up)];
      if (d[2] >= -0.02 && _aeStandShines(st, s.mag)) out.push({ id: 'star:' + s.name, name: s.name, dir: d, px: AE_STAND_SKY_TAP_PX, fly: null });
    });
  }
  return out;
}
function _aeStandNameTag(st) {
  return st.skyTag || (st.skyTag = (function () { var h = document.createElement('div'); h.className = 'ae-stand-crafts'; var sp = document.createElement('span'); sp.className = 'ae-stand-craft'; h.appendChild(sp); _ae.el.appendChild(h); return h; })());
}
function _aeStandNameClear(st) {
  clearTimeout(st.skyTagTimer);
  st.skyNamed = null;
  if (st.skyTag) st.skyTag.firstChild.hidden = true;
}
function _aeStandSkyTap(x, y) {
  var st = _ae.stand;
  if (!st || !st.live || !st.camera || !st.photo || st.mode !== 'ground') return false;
  var best = null, bestD = Infinity;
  _aeStandNamed(st).forEach(function (n) {
    var p = _aeStandSkyPoint(st, n.dir), d = p ? Math.hypot(p.x - x, p.y - y) : Infinity;
    if (d < n.px && d < bestD) { bestD = d; best = n; n.at = p; }
  });
  if (!best) { _aeStandNameClear(st); return false; }
  if (st.skyNamed === best.id && best.fly) { _aeStandNameClear(st); _aeStandGoTo(st, best.fly); return true; }   // the second tap on the same name
  var sp = _aeStandNameTag(st).firstChild;
  sp.innerHTML = '<i></i>' + _almEsc(best.name);
  sp.style.transform = 'translate(' + best.at.x.toFixed(1) + 'px,' + best.at.y.toFixed(1) + 'px)';
  sp.hidden = false;
  st.skyNamed = best.id;
  clearTimeout(st.skyTagTimer); st.skyTagTimer = setTimeout(function () { _aeStandNameClear(st); }, AE_STAND_SKY_TAG_MS);
  return true;
}
// Off the ground and on to `key` in the 3D view: the ground is left as it is when Back is pressed, then the view flies to it.
function _aeStandGoTo(st, key) {
  st.then = key;
  _aeStandLeave();
}

// ── Looking around ──
function _aeStandLook(dx, dy) {
  var st = _ae.stand;
  if (!st || !st.live) return;
  if (st.motion && _aeMotionTrim(st, dx, dy, _aeDeg(_aeStandFov()), _ae.h)) { st.dirty = true; _aeRedraw(); return; }   // the phone says where; a finger trims
  var k = _aeStandFov() / _ae.h;
  st.userYaw -= dx * k;
  st.userPitch = _aeClamp(st.userPitch + dy * k, -_aeRad(AE_STAND_PITCH_MAX_DEG) - _aeRad(AE_STAND_PITCH_DEG), _aeRad(AE_STAND_PITCH_MAX_DEG) - _aeRad(AE_STAND_PITCH_DEG));
  st.dirty = true; _aeRedraw();
}
function _aeStandZoom(factor) {
  var st = _ae.stand;
  if (!st || !st.live) return;
  st.zoom = _aeClamp(st.zoom * factor, AE_STAND_ZOOM_MIN, AE_STAND_ZOOM_MAX);
  st.dirty = true; _aeRedraw();
}
var AE_STAND_KEY_ZOOM = 0.9;
function _aeStandKey(e) {
  if (e.key === '+' || e.key === '=') { _aeStandZoom(AE_STAND_KEY_ZOOM); return true; }
  if (e.key === '-' || e.key === '_') { _aeStandZoom(1 / AE_STAND_KEY_ZOOM); return true; }
  return false;
}


// ── On foot ──
// Anywhere on a ground one can walk: W S forward and back, A D turn, Q E step aside, the arrows the same (Up and Down move, Left and Right turn), Space jumps, Shift runs;
// on touch the left thumb is a stick (up and down walk, sideways turns, past the dotted ring runs) and a drag elsewhere looks. The eye stays over the ground,
// the jump is the body's own gravity, and one cannot walk into the sea. The ground is the mesh built round where one stood: a walk is kept inside AE_WALK_MAX_M of it.
var AE_WALK_MS = AE_WALK_PACE_MS, AE_WALK_FAST_RATE = (typeof AE_SITE_FACTS === 'object' && AE_SITE_FACTS.driveFastRate) || 10, AE_WALK_TURN = 1.6, AE_WALK_MAX_M = 80, AE_WALK_STICK_MAX = 1.5, AE_WALK_RUN_AT = 1.12;   // walking pace (m/s), the run's multiple, turning (rad/s), how far from its origin, the stick's reach (the jump's launch speed: AE_WALK_JUMP_MS, almanac-earth.js) and the run's start
// The jump: an average adult's standing jump leaves the ground at about 2.6 m/s, the same legs on every world, so it rises v0^2 / 2g: 0.34 m on the Earth,
// 0.92 m on Mercury and Mars, 2.1 m on the Moon (no spacesuit's weight counted).
var AE_WALK_KEYS = { w: 'f', W: 'f', s: 'b', S: 'b', a: 'tl', A: 'tl', d: 'tr', D: 'tr', q: 'l', Q: 'l', e: 'r', E: 'r', ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'tl', ArrowRight: 'tr' };   // (A D turn and Q E step aside)
var AE_WALK_HINT_KEY = 'zimi_walk_hint_seen';
var _aeWalkKeyDown = null, _aeWalkKeyUp = null, _aeWalkFocusOff = null;
function _aeStandWalkOf(st) {
  return st.walk || (st.walk = { x: 0, y: 0, h: 0, jump: 0, vz: 0, keys: {}, stick: { x: 0, y: 0 }, run: false, hop: false, at: 0, active: false });
}
// The ground's height at a place walked to (over the ground at the origin), the body's curve in it: the very z the mesh's vertices have.
function _aeStandWalkGround(st, x, y) {
  return typeof _aeTerrainLocal === 'function' ? _aeTerrainLocal(st.key, st.lat, st.lon, st.h0, x, y, 0, null) : 0;
}
function _aeStandWalkWet(st, x, y) {
  if (st.key !== 'earth' || typeof _aeDestination !== 'function') return false;
  var R = st.b.km * 1000, d = _aeDestination(st.lat, st.lon, Math.hypot(x, y) / R, Math.atan2(x, y));
  return _aeStOnWater(st.key, d.lat, d.lon);
}
// One step of a walk, for Stand here and for a site's eye alike: the move on the ground (x, y in metres), the turn (rad) and the jump, which it advances in
// `w` (jump: the height, vz: its speed, hop: asked for) under the body's own gravity; w.keys are f b l r tl tr, `stick` the thumb's {x, y}, `run` the pace.
function _aeWalkPlan(w, stick, run, yaw, dt, body) {
  var k = w.keys, fwd = _aeClamp((k.f ? 1 : 0) - (k.b ? 1 : 0) + stick.y, -1, 1), strafe = (k.r ? 1 : 0) - (k.l ? 1 : 0);
  // A person's true pace (5 km/h): pushing the ball past its ring (or Shift) does not run faster than that, it runs time forward, as the rover's drive does (its time scale: the clock's rate, or the fast rate).
  var rate = typeof _almRate === 'number' ? Math.max(1, _almRate) : 1, speed = AE_WALK_MS * (run ? Math.max(rate, AE_WALK_FAST_RATE) : rate), sx = Math.sin(yaw), cy = Math.cos(yaw);
  var plan = { dx: (fwd * sx + strafe * cy) * speed * dt, dy: (fwd * cy - strafe * sx) * speed * dt, turn: ((k.tr ? 1 : 0) - (k.tl ? 1 : 0)) + stick.x };
  var g = (AE_BODY_FACTS[body] && AE_BODY_FACTS[body].gravity) || 9.81;
  if (w.hop && !(w.jump > 0) && !(w.vz > 0)) { w.vz = AE_WALK_JUMP_MS; w.jump = 1e-6; }
  w.hop = false;
  if (w.jump > 0 || w.vz > 0) {
    w.vz -= g * dt; w.jump += w.vz * dt;
    if (w.jump <= 0) { w.jump = 0; w.vz = 0; }
  }
  plan.moved = !!(plan.dx || plan.dy);
  plan.active = plan.moved || !!plan.turn || w.jump > 0 || w.vz > 0;
  return plan;
}
function _aeStandWalkStep(st, now) {
  var w = st.walk;
  if (!w) return;
  var dt = w.at ? _aeClamp((now - w.at) / 1000, 0, 0.05) : 0;   // never back in time
  w.at = now;
  if (st.mode !== 'ground' || st.fading) { w.active = false; return; }
  var plan = _aeWalkPlan(w, w.stick, w.run || Math.hypot(w.stick.x, w.stick.y) > AE_WALK_RUN_AT, st.yaw + st.userYaw, dt, st.key);
  if (plan.turn) { st.userYaw += plan.turn * AE_WALK_TURN * dt; st.dirty = true; }
  if (plan.moved) {
    var ox = w.x0 || 0, oy = w.y0 || 0, nx = w.x + plan.dx, ny = w.y + plan.dy, r = Math.hypot(nx - ox, ny - oy);   // (a walk is kept round where it began: the ground's origin, or where a craft set one down)
    if (r > AE_WALK_MAX_M) { nx = ox + (nx - ox) * AE_WALK_MAX_M / r; ny = oy + (ny - oy) * AE_WALK_MAX_M / r; }
    if (!_aeStandWalkWet(st, nx, ny)) { w.x = nx; w.y = ny; }
    st.dirty = true;
  }
  w.h = _aeStandWalkGround(st, w.x, w.y);   // the eye follows the ground there
  var step = plan.moved ? Math.hypot(plan.dx, plan.dy) : 0, R = st.b.km * 1000, at = typeof _aeDestination === 'function' ? _aeDestination(st.lat, st.lon, Math.hypot(w.x, w.y) / R, Math.atan2(w.x, w.y)) : null;
  w.covered = (w.covered || 0) + step;
  _aeMoveTell('walk', st.key, dt > 0 ? step / dt : 0, { place: at ? { lat: at.lat, lon: at.lon } : null, coveredM: w.covered });
  if (w.jump > 0) st.dirty = true;
  w.active = plan.active;
  if (w.active) _aeRedraw();
}
function _aeStandWalkHintDone() { var el = _aeById('ae-walk-hint'); _aeHintDone(el, AE_WALK_HINT_KEY); if (el) el.remove(); }
function _aeStandWalkHint(st) {
  if (!_ae.el) return;
  var el = document.createElement('div');
  el.id = 'ae-walk-hint'; el.className = 'ae-walk-hint';
  if (_aeHintShow(el, AE_WALK_HINT_KEY, 'alm_walk_hint')) _ae.el.appendChild(el);
}
function _aeStandWalkKeys(on) {
  if (on && !_aeWalkKeyDown) {
    _aeWalkKeyDown = function (e) {
      var st = _ae && _ae.stand;
      if (!st || !st.live || st.mode !== 'ground' || _aeTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      var name = AE_WALK_KEYS[e.key], w = _aeStandWalkOf(st);
      if (e.key === ' ') w.hop = true;
      else if (e.key === 'Shift') { w.run = true; return; }
      else if (name) w.keys[name] = true;
      else return;
      _aeStandWalkHintDone();
      e.preventDefault(); e.stopPropagation();
      st.dirty = true; _aeRedraw();
    };
    _aeWalkKeyUp = function (e) {
      var st = _ae && _ae.stand, name = AE_WALK_KEYS[e.key];
      if (!st || !st.walk) return;
      if (e.key === 'Shift') st.walk.run = false;
      if (name) st.walk.keys[name] = false;
    };
    document.addEventListener('keydown', _aeWalkKeyDown, true);
    document.addEventListener('keyup', _aeWalkKeyUp, true);
    _aeWalkFocusOff = _aeOnFocusLost(function () { var w = _ae && _ae.stand && _ae.stand.walk; if (w) { w.keys = {}; w.run = false; } });
  } else if (!on && _aeWalkKeyDown) {
    document.removeEventListener('keydown', _aeWalkKeyDown, true);
    document.removeEventListener('keyup', _aeWalkKeyUp, true);
    _aeWalkKeyDown = _aeWalkKeyUp = null;
    if (_aeWalkFocusOff) { _aeWalkFocusOff(); _aeWalkFocusOff = null; }
  }
}
// The left thumb (touch only, the lower-left quarter): a stick that walks; the canvas's own handlers ask first (almanac-earth.js _aeBindCanvas).
function _aeStandWalkDown(e) {
  var st = _ae.stand;
  if (!st || !st.live || st.mode !== 'ground' || e.pointerType === 'mouse' || (_ae.walkPtr !== undefined && _ae.walkPtr !== null)) return false;
  var r = _ae.el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (!(x < r.width * AE_STICK_ZONE && y > r.height * AE_STICK_ZONE)) return false;
  var w = _aeStandWalkOf(st), el = _aeById('ae-walk-stick');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ae-walk-stick'; el.className = 'ae-walk-stick'; el.innerHTML = '<i></i>';
    _ae.el.appendChild(el);
  }
  el.hidden = false; el.style.left = x + 'px'; el.style.top = y + 'px'; el.firstElementChild.style.transform = ''; el.classList.remove('ae-walk-fast');
  _ae.walkPtr = e.pointerId; _ae.walkOrigin = [e.clientX, e.clientY];
  w.stick.x = w.stick.y = 0;
  _aeStandWalkHintDone();
  return true;
}
function _aeStandWalkMove(e) {
  var st = _ae.stand;
  if (!st || _ae.walkPtr !== e.pointerId) return false;
  var w = _aeStandWalkOf(st), el = _aeById('ae-walk-stick'), reach = AE_STICK_R_PX * AE_WALK_STICK_MAX, ox = e.clientX - _ae.walkOrigin[0], oy = e.clientY - _ae.walkOrigin[1], m = Math.hypot(ox, oy), k = m > reach ? reach / m : 1;
  if (el) { el.firstElementChild.style.transform = 'translate(' + (ox * k) + 'px,' + (oy * k) + 'px)'; el.classList.toggle('ae-walk-fast', Math.hypot(ox * k, oy * k) / AE_STICK_R_PX > AE_WALK_RUN_AT); }
  w.stick.x = ox * k / AE_STICK_R_PX; w.stick.y = -oy * k / AE_STICK_R_PX;
  st.dirty = true; _aeRedraw();
  return true;
}
function _aeStandWalkEnd(e) {
  if (_ae.walkPtr !== e.pointerId) return false;
  _ae.walkPtr = null;
  var st = _ae.stand, el = _aeById('ae-walk-stick');
  if (st && st.walk) st.walk.stick.x = st.walk.stick.y = 0;
  if (el) el.hidden = true;
  return true;
}

// ── What is on the screen besides the picture ──
var AE_STAND_PHONE_SVG = '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/><path d="M3.5 9v6M20.5 9v6" opacity=".55"/></svg>';
var AS_DRIVE_ICON_SVG = '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="17" r="2.6"/><circle cx="17.5" cy="17" r="2.6"/><path d="M4 14.2h16M8.5 14.2V9.5h3.5v4.7M15.5 14.2V6.5M13.3 6.5h4.4"/></svg>';
var AE_STAND_BACK_SVG = '<svg class="ae-tool-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/><path d="M5 4h14" opacity=".55"/></svg>';
var AE_STAND_CSS = [
  '.ae-walk-stick{position:absolute;z-index:3;width:' + AE_STICK_R_PX * 2 + 'px;height:' + AE_STICK_R_PX * 2 + 'px;margin:-' + AE_STICK_R_PX + 'px 0 0 -' + AE_STICK_R_PX + 'px;border-radius:50%;border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.07);pointer-events:none}',
  '.ae-walk-stick::before{content:"";position:absolute;inset:-' + AE_STICK_R_PX * (AE_WALK_STICK_MAX - 1) + 'px;border-radius:50%;border:2px dotted rgba(255,255,255,.5)}',
  '.ae-walk-stick i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(245,158,11,.55);border:2px solid rgba(255,255,255,.6)}',
  '.ae-walk-stick.ae-walk-fast i{background:rgba(245,158,11,.9)}',
  '.ae-walk-hint{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(120px + env(safe-area-inset-bottom));max-width:80%;text-align:center;font-size:13px;line-height:1.35;padding:8px 14px;border-radius:14px;background:rgba(0,0,0,.6);color:#fff;text-shadow:0 1px 3px #000;pointer-events:none;z-index:3}',
  '.night-red .ae-walk-stick{border-color:rgba(200,40,40,.45);background:rgba(200,40,40,.08)}',
  '.night-red .ae-walk-stick i{background:rgba(200,40,40,.6);border-color:rgba(255,90,90,.6)}',
  '.ae-standing .ae-labels,.ae-standing .ae-lms,.ae-standing .ae-top,.ae-standing .ae-row,.ae-standing .ae-card,.ae-standing .ae-hint,.ae-standing .ae-status,.ae-standing .ae-note,.ae-standing .ae-go,.ae-standing .ae-spin,.ae-standing .ae-fullbar{display:none!important}',
  '.ae-standing .ae-canvas{cursor:grab}',
  '.ae-view.ae-bare .ae-stand-drive,.ae-view.ae-bare .ae-stand-motion{opacity:0;visibility:hidden}',   // Hide controls hides the rover and the phone's too
  '.ae-stand-hud{position:absolute;top:0;left:0;right:0;display:flex;align-items:flex-start;gap:10px;padding:12px 16px 24px;pointer-events:none;z-index:2}',
  '.ae-stand-hud>*{pointer-events:auto}',
  '.ae-stand-hud #ae-stand-back,.ae-stand-hud .ae-stand-text{display:none}',   // the rim leaves, and the where line (in the capsule) says where you stand: no arrow and no text block of its own
  '.ae-stand-text{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:6px;font-size:13px;line-height:1.3;color:#fff;text-shadow:0 0 4px #000,0 1px 3px #000;pointer-events:none}',
  '.ae-stand-text b{font-weight:600}',
  '.ae-stand-text .ae-stand-sunrise{color:var(--amber);text-decoration:underline;pointer-events:auto;font-weight:600}',
  // A finger's hit area: the line's box takes the room above and below it (the text round it takes no touch).
  '@media (pointer:coarse){.ae-stand-text .ae-stand-sunrise{position:relative}.ae-stand-text .ae-stand-sunrise::after{content:"";position:absolute;inset:-6px 0}}',
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
_aeCss('ae-stand-style', AE_STAND_CSS);
function _aeStandHud(st) {
  var hud = document.createElement('div');
  hud.className = 'ae-stand-hud';
  var back = _aeT('alm_stand_back');
  hud.innerHTML = '<button type="button" class="ae-btn ae-round" id="ae-stand-back" aria-label="' + _almEsc(back) + '" title="' + _almEsc(back) + '">' + AE_STAND_BACK_SVG + '</button>' +
    '<div class="ae-stand-text" id="ae-stand-text" aria-live="off"></div>';
  _ae.el.appendChild(hud);
  st.hud = hud;
  _aeById('ae-stand-back').onclick = function () { _aeStandClose(); };   // the one way back: the card that handed the ground over, else the view as it was
  _aeById('ae-stand-text').addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('[data-ae-sunrise]');
    if (!a) return;
    e.preventDefault();
    if (st.rise) { _aeGoTo(st.rise.at); st.fr = null; st.dirty = true; _aeRedraw(); }
  });
  var tools = document.createElement('div');   // drive and the phone: the ground's own small discs, on the controls layer's line (AH_CSS .ae-stand-tools)
  tools.className = 'ae-stand-tools as-tools-end';
  hud.appendChild(tools);
  _aeStandDriveButton(st, tools);
  _aeStandMotionButton(st, tools);
  _aeStandHudText(st);
  var cv = _aeById('ae-canvas');
  if (cv) cv.setAttribute('aria-label', _aeT('alm_stand_aria', { body: _aeInfoName(st.key) }));
}
function _aeStOnWater(key, lat, lon) { return key === 'earth' && typeof _aeTerrainHeight === 'function' && !!_aeTerrainHeight(key, lat, lon, 0).sea; }
// Drive: the rover that suits this ground, put down where one stands (almanac-earth.js _aeDriveHere); where WebGL2 is not there is no ground view to drive on.
function _aeStandDriveButton(st, hud) {
  if (AE_DRIVE_BODIES.indexOf(st.key) < 0 || _aeStOnWater(st.key, st.lat, st.lon)) return;   // no vehicle on the sea
  var label = _aeT('alm_site_drive'), b = document.createElement('button');
  b.type = 'button'; b.className = 'ae-btn ae-round ah-minor ae-stand-drive'; b.id = 'ae-stand-drive';
  b.setAttribute('aria-label', label); b.setAttribute('title', label);
  b.innerHTML = AS_DRIVE_ICON_SVG;
  hud.appendChild(b);
  b.onclick = function () { _aeDriveHere(st.key, st.lat, st.lon); };
}
// The phone as the way to look round (almanac-standlook.js): a button where the phone has sensors; kept, and where nothing asks, on again.
function _aeStandMotionButton(st, hud) {
  if (typeof _aeMotionAvailable !== 'function' || !_aeMotionAvailable() || !('ontouchstart' in window || navigator.maxTouchPoints > 0)) return;
  var label = _aeT('alm_stand_motion'), b = document.createElement('button');
  b.type = 'button'; b.className = 'ae-btn ae-round ah-minor ae-stand-motion'; b.id = 'ae-stand-motion';
  b.setAttribute('aria-label', label); b.setAttribute('title', label); b.setAttribute('aria-pressed', 'false');
  b.innerHTML = AE_STAND_PHONE_SVG;
  hud.appendChild(b);
  var set = function (on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); };
  b.onclick = function () {
    if (st.motion) { _aeMotionStop(st); set(false); st.userYaw = st.userPitch = 0; st.dirty = true; _aeRedraw(); return; }
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
  var line2 = (fr ? '☀ ' + Math.abs(Math.round(fr.sunAlt)) + '°' + (fr.sunAlt < 0 ? ' ↓' : ' ↑') + ' · ' + _aeCompassPoint(_aeDeg(fr.sunAz)) + '    ' : '') + '⌖ ' + Math.round(head) + '° ' + _aeCompassPoint(head);   // the Sun: its height (an arrow, no compass letter) and then its bearing (the letter); the glyph: which way the view faces
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
  if (_ae.pick) { _aeCardClear(); return true; }   // any tap while a spot is picked puts it away (it never moves it); the next tap picks a new spot
  var hit = _aeStHit(body, x, y);
  if (!hit) return false;
  _ae.lm = null; _ae.place = null;
  _ae.pick = { body: body, lat: hit.lat, lon: hit.lon };
  _aeTerrainLoad(body).then(function () { if (_ae && _ae.pick && _ae.pick.body === body) _aeRenderCard(); });
  if (_ae.arrived !== body) _aeArrive(body);
  else _aeRenderCard();
  _aeRedraw();
  return true;
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
  var cam = _ae.gl.camera, eye = _aeXyz(cam.position), s = _aeProject(p);
  if (!s || _aeDot(n, _aeSub(eye, p)) <= 0) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.style.transform = 'translate(' + s.x.toFixed(1) + 'px,' + s.y.toFixed(1) + 'px)';
}

// The address: Stand here is lat,lon,heading,pitch,zoom (degrees; the view's own pitch above the horizon; the zoom factor).
if (typeof _aeLinkModes !== 'undefined') {
  _aeLinkModes.stand = function () {
    var st = _ae && _ae.stand;
    if (!st || !st.live || st.mode === 'ascend') return null;
    var n = function (x, d) { return Number(x.toFixed(d)); };
    return [n(st.lat, 6), n(st.lon, 6), n(((_aeDeg(st.yaw + st.userYaw) + 540) % 360) - 180, 1), n(_aeDeg(st.userPitch) + AE_STAND_PITCH_DEG, 1), n(st.zoom, 3)].join(',');
  };
}
