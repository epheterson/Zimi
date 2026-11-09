// ── Almanac: a landing site on the ground of Stand here ──
// A site (almanac-sites.js: the lander, the rover, the flag where they stand; the drive; a launch) is shown in the same
// ground as Stand here: the terrain's heights under its models and wheels (almanac-terrain.js, levelled where the lander
// stands), the body's own sky and the Sun and the other bodies in it, the stars, the cast shadows (almanac-standgl.js).
// The site keeps its camera (orbit the lander, chase the rover) and its models, rocks and shadows; this file draws them
// into the ground's scene instead of the orbit view's: the site's frame is the ground's (x east, y north, z up, metres,
// the origin on the site), so its group goes in as it is and its camera is carried over from the orbit camera's pose.
// Eye level is a second camera of the site: stand on the ground a few lander widths off and look round (a drag, or the
// phone: almanac-standlook.js), one view with the orbit and the drive, switched by a button.
//
//   _aeHostPrepare(site)   called as a visit starts: build the ground for it in the background
//   _aeHostRender()        called by the orbit view's draw: true if the ground drew this frame
//   _aeHostDrop(site)      the visit ends
//   _aeHostEyeToggle(site) eye level, and back to the orbit

var AE_HOST_FADE_MS = 260;
var AE_HOST_EYE_BACK = 1.6;       // eye level opens this many lander widths from the lander
var AE_HOST_EYE_MIN_M = 6;
var AE_HOST_EYE_PITCH = 0.06;     // radians over the level
var AE_HOST_FOCUS_M = 10;         // how far the eye's look is taken to be

function _aeHostPrepare(site) {
  var key = site.body;
  if (!_aeStandable(key) || site.host) return;
  var tgt = AE_TARGETS[key];
  var pend = { key: key, lat: site.lat, lon: site.lon, ready: false, t0: performance.now(), host: true, tex: null,
    flat: [site.flatFrom || AS_FLAT_FROM_M, site.flatTo || AS_FLAT_TO_M], alt0: Math.max(30, (tgt.min - tgt.surface) * AE_EARTH_RADIUS_KM) };
  site.host = { pend: pend, live: false, st: null, swapping: false };
  _aeStandBuild(pend, AE_STAND_BODIES[key]);
}

// The visit's ground, drawn this frame in place of the orbit scene: false while it is not ready (or not wanted yet).
function _aeHostRender() {
  var site = _ae.site, h = site && site.host;
  if (!h || !site.group) return false;
  if (!h.live) {
    if (!h.swapping && h.pend.ready && site.phase !== 'fly') _aeHostSwap(site, h);
    return false;
  }
  if (!site.pose || !site.fr) return false;
  var hst = h.st, g = site.group;
  // The group's own transform put it in the orbit scene's units; here it is in metres, as it was built.
  g.matrix.identity();
  g.matrixWorldNeedsUpdate = true;
  g.updateMatrixWorld(true);
  site.ground.visible = false;   // the ground's own mesh replaces the site's flat patch
  if (site.eye && site.eye.on && !site.launch && !site.camOverride) site.camOverride = _aeHostEyeCam;   // a launch's camera gave way
  _aeStandPaint(hst, performance.now(), true, _aeHostPlaceCamera);
  return true;
}
// To the ground's scene, through a short dark (the orbit view is what the flight showed): the scene is made, the site's group moved in.
function _aeHostSwap(site, h) {
  h.swapping = true;
  var canvas = _aeById('ae-canvas'), reduce = _aeReduceMotion(), go = function () {
    if (_ae.site !== site || site.host !== h) { if (canvas) canvas.style.opacity = ''; return; }
    var st = h.st = _aeStandNew(h.pend);
    if (!st) { site.host = null; if (canvas) canvas.style.opacity = ''; return; }
    st.host = true; st.live = true;
    var S = _ae.gl;
    st.scene.add(site.group);
    site.shared.metre.value = 1;   // the site's shaders measure distance in metres here
    S.renderer.setClearColor(0x000000, 1);
    st.prevRatio = S.renderer.getPixelRatio();
    S.renderer.setPixelRatio(Math.min(S.dpr, AE_STAND_DPR_MAX));
    _aeResize();
    h.live = true;
    _ae.dirty = true; _aeKick();
    if (canvas) { canvas.style.opacity = ''; setTimeout(function () { if (canvas) canvas.style.transition = ''; }, AE_HOST_FADE_MS + 40); }
  };
  if (reduce || !canvas) { go(); return; }
  canvas.style.transition = 'opacity ' + AE_HOST_FADE_MS + 'ms ease';
  canvas.style.opacity = '0';
  setTimeout(go, AE_HOST_FADE_MS);
}
// The site's camera (the orbit camera's pose, placed by the site) in the ground's frame: position in metres, the view's axes.
function _aeHostPlaceCamera(hst) {
  var S = _ae.gl, cam = S.camera, site = _ae.site, fr = site.fr, mc = hst.camera, W = _ae.w, H = _ae.h;
  var loc = function (w) { return [_aeDot(w, fr.e), _aeDot(w, fr.n), _aeDot(w, fr.u)]; };
  var pos = _asWorldToLocal(fr, [cam.position.x, cam.position.y, cam.position.z]), me = cam.matrixWorld.elements;
  var fwd = loc([-me[8], -me[9], -me[10]]), up = loc([me[4], me[5], me[6]]);
  mc.fov = cam.fov; mc.aspect = W / H;
  mc.near = Math.max(0.05, cam.near / AS_MRE); mc.far = Math.max(1e5, hst.b.km * 3000);
  mc.position.set(pos[0], pos[1], pos[2]);
  mc.up.set(up[0], up[1], up[2]);
  mc.lookAt(pos[0] + fwd[0], pos[1] + fwd[1], pos[2] + fwd[2]);
  mc.updateProjectionMatrix(); mc.updateMatrixWorld();
  var tanV = Math.tan(_aeRad(cam.fov) / 2);
  return { pos: pos, e: mc.matrixWorld.elements, tanV: tanV, aspect: W / H, pixAng: 2 * tanV / (H * S.renderer.getPixelRatio()) };
}
function _aeHostDrop(site) {
  var h = site && site.host;
  if (!h) return;
  site.host = null;
  h.pend.dead = true;
  if (h.st) {
    if (h.st.scene) h.st.scene.remove(site.group);   // the site's own disposal takes its meshes
    if (site.eye && site.eye.motion) _aeMotionStop(site.eye, true);
    _aeStandDispose(h.st);
    var S = _ae.gl;
    if (S) { S.renderer.setClearColor(0x000000, 0); S.renderer.setPixelRatio(h.st.prevRatio || S.dpr); _aeResize(); }
  }
  site.camOverride = site.camOverride === _aeHostEyeCam ? null : site.camOverride;
  var canvas = _aeById('ae-canvas');
  if (canvas) { canvas.style.opacity = ''; canvas.style.transition = ''; }
}

// ── Eye level ──
// The site's second camera: on the ground a few widths from the lander, looking at it, turned by a finger or the phone.
function _aeHostEyeToggle(site) {
  if (!site || site.launch || site.drive) return;
  var eye = site.eye;
  if (eye && eye.on) {
    eye.on = false;
    if (eye.motion) _aeMotionStop(eye, true);
    if (site.camOverride === _aeHostEyeCam) site.camOverride = null;
    _aeKick();
    return;
  }
  eye = site.eye = eye || { on: false, x: 0, y: 0, yaw: 0, pitch: AE_HOST_EYE_PITCH, motion: null };
  var c = site.camera, fx = site.focusXY[0], fy = site.focusXY[1], d = Math.max(AE_HOST_EYE_MIN_M, site.span * AE_HOST_EYE_BACK);
  eye.x = fx - Math.sin(c.az) * d; eye.y = fy + Math.cos(c.az) * d;
  eye.yaw = Math.atan2(fx - eye.x, fy - eye.y); eye.pitch = AE_HOST_EYE_PITCH;
  eye.on = true;
  site.camOverride = _aeHostEyeCam;
  _aeKick();
}
function _aeHostEyeCam(st, dt) {
  var e = st.eye, mv = e.motion ? _aeMotionView(e, performance.now()) : null;
  if (mv) { e.yaw = _aeRad(mv.az); e.pitch = _aeRad(mv.alt); }
  var z = _asGroundAt(st, e.x, e.y, false) + AE_STAND_EYE_M, cp = Math.cos(e.pitch);
  return { pos: [e.x, e.y, z], focus: [e.x + Math.sin(e.yaw) * cp * AE_HOST_FOCUS_M, e.y + Math.cos(e.yaw) * cp * AE_HOST_FOCUS_M, z + Math.sin(e.pitch) * AE_HOST_FOCUS_M] };
}
// A finger's move at eye level: the phone's trim when it is on, else the heading and height themselves.
function _aeHostEyeLook(st, dx, dy) {
  var e = st.eye, fov = _ae.gl.camera.fov;
  if (e.motion && _aeMotionTrim(e, dx, dy, fov, _ae.h)) return;
  var k = _aeRad(fov) / _ae.h;
  e.yaw -= dx * k;
  e.pitch = _aeClamp(e.pitch + dy * k, -_aeRad(AE_MOTION_ALT_MAX), _aeRad(AE_MOTION_ALT_MAX));
}
function _aeHostEyeOn(st) { return !!(st && st.eye && st.eye.on); }
// The phone as the way to look at eye level.
function _aeHostMotionToggle(site) {
  var eye = site && site.eye;
  if (!eye || !eye.on) return Promise.resolve(false);
  if (eye.motion) { _aeMotionStop(eye); return Promise.resolve(false); }
  return _aeMotionStart(eye);
}
