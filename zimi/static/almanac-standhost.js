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

var AE_HOST_EYE_BACK = 1.6;       // eye level opens this many lander widths from the lander
var AE_HOST_EYE_MIN_M = 6;
var AE_HOST_EYE_PITCH = 0.06;     // radians over the level
var AE_HOST_FOCUS_M = 10;         // how far the eye's look is taken to be

function _aeHostPrepare(site) {
  var key = site.body;
  if (!_aeStandable(key) || site.host) return;
  var tgt = AE_TARGETS[key];
  var pend = { key: key, lat: site.lat, lon: site.lon, ready: false, t0: performance.now(), host: true, tex: null,
    flat: [site.flatFrom || AS_FLAT_FROM_M, site.flatTo || AS_FLAT_TO_M, site.relief ? function (x, y) { return _asRelief(site.relief, x, y); } : null], alt0: Math.max(30, (tgt.min - tgt.surface) * AE_EARTH_RADIUS_KM) };
  site.host = { pend: pend, live: false, st: null, swapping: false };
  _aeStandBuild(pend, AE_STAND_BODIES[key]);
}

// Stand here's ground, kept as it was dropped (_aeStandDrop with keep): the visit's host from the start, nothing built again. It takes the
// site's group on the visit's first frame on the ground (_aeHostRender, through _aeHostSwapNow with no dark).
function _aeHostAdopt(site, ground) {
  ground.walk = null; ground.stepOut = null;
  site.host = { pend: ground.pend || { ready: true, alt0: ground.alt0 }, live: false, st: ground, swapping: false, adopted: true };
  site.host.pend.ready = true;
}
// The visit's ground, drawn this frame in place of the orbit scene: false while it is not ready (or not wanted yet).
function _aeHostRender() {
  var site = _ae.site, h = site && site.host;
  if (!h || !site.group) return false;
  if (!h.live) {
    // One view: the ground takes over within this very frame, never through a dark. On the way down it is laid over the
    // orbit view's picture by height (below), so taken at the top of the drop it is not yet seen at all; the visit waits for it before dropping
    // (_aeSiteStep), and only a ground slower than AS_HOST_WAIT_MS comes in part way, still with no dark.
    if (!h.pend.ready || site.phase === 'fly') return false;
    _aeHostSwapNow(site, h);
    if (!h.live) return false;
  }
  if (!site.pose || !site.fr) return false;
  var hst = h.st, g = site.group;
  // On the way down and up the ground is laid over the orbit view's own picture by height alone, as Stand's fall does (_aeStandAlphaAt): high up the globe
  // is the orbit view's, lit as it is there (the ground's own picture of the whole body, drawn to the top, was another light that went dark at the hand-over).
  var moving = (site.phase === 'drop' || site.phase === 'rise') && !site.getIn;   // (getting into the rover is a move on the ground: the ground stays whole)
  hst.alpha = moving ? _aeStandAlphaAt(h.pend.alt0, site.pose.altRe * AE_EARTH_RADIUS_KM) : 1;
  if (hst.alpha <= 0) return false;
  if (hst.alpha < 1) _ae.gl.renderer.render(_ae.gl.scene, _ae.gl.camera);
  // The group's own transform put it in the orbit scene's units; here it is in metres, as it was built.
  g.matrix.identity();
  g.matrixWorldNeedsUpdate = true;
  g.updateMatrixWorld(true);
  site.ground.visible = false;   // the ground's own mesh replaces the site's flat patch
  if (site.eye && site.eye.on && !site.launch && !site.camOverride) site.camOverride = _aeHostEyeCam;   // a launch's camera gave way
  if (typeof _asPartsByTime === 'function') _asPartsByTime(site);   // what stands there at this instant (the ascent stage until its liftoff)
  _aeStandPaint(hst, performance.now(), true, _aeHostPlaceCamera);
  _aeHostEarthHint(site, hst);
  return true;
}
// The ground's scene made (or the one adopted) and the site's group moved into it, at once (false: the visit or the ground went meanwhile).
function _aeHostSwapNow(site, h) {
  if (_ae.site !== site || site.host !== h) return false;
  var st = h.st || (h.st = _aeStandNew(h.pend));
  if (!st) { site.host = null; return false; }
  st.host = true; st.live = true;
  st.scene.add(site.group);
  site.shared.metre.value = 1;   // the site's shaders measure distance in metres here
  if (!h.adopted) _aeStandTakeCanvas(st, _ae.gl);   // (an adopted ground has the canvas already, as it was stood on)
  h.live = true;
  return true;
}
// The site's camera (the orbit camera's pose, placed by the site) in the ground's frame: position in metres, the view's axes.
function _aeHostPlaceCamera(hst) { return _aeHostCameraIn(hst, _ae.site.fr); }
// The main camera's pose carried into a ground's frame `fr` ({ origin, e, n, u } in the main scene: a visit's, or the flight's).
function _aeHostCameraIn(hst, fr) {
  var S = _ae.gl, cam = S.camera, mc = hst.camera, W = _ae.w, H = _ae.h;
  cam.updateMatrixWorld();   // (the globe's own draw may not have run this frame: the ground's picture alone)
  var loc = function (w) { return _aeRigDir(fr, w); };
  var pos = _aeRigLocal(fr, _aeXyz(cam.position)), me = cam.matrixWorld.elements;
  var fwd = loc([-me[8], -me[9], -me[10]]), up = loc([me[4], me[5], me[6]]);
  mc.fov = cam.fov; mc.aspect = W / H;
  var eyeLevel = _ae.site && (_ae.site.camOverride === _aeHostEyeCam || _ae.site.adopt);   // on foot, and on the ground one stood on, the picture is Stand here's: centred as it was stood in (no shift for the foot's controls), so nothing moves as the drive begins
  var vo = cam.view && cam.view.enabled && !eyeLevel ? cam.view : null;   // the picture's centre moved (a sheet over its foot): the ground's is moved the same
  if (vo) mc.setViewOffset(vo.fullWidth, vo.fullHeight, vo.offsetX, vo.offsetY, vo.width, vo.height); else if (mc.view) mc.clearViewOffset();
  mc.near = Math.max(0.05, cam.near * AE_RIG_M_PER_RE); mc.far = Math.max(1e5, hst.b.km * 3000, (hst.b.km * 1000 + Math.max(0, pos[2])) * 1.05);
  mc.position.set(pos[0], pos[1], pos[2]);
  mc.up.set(up[0], up[1], up[2]);
  mc.lookAt(pos[0] + fwd[0], pos[1] + fwd[1], pos[2] + fwd[2]);
  mc.updateProjectionMatrix(); mc.updateMatrixWorld();
  var tanV = _aeTanHalf(cam.fov);
  return { pos: pos, e: mc.matrixWorld.elements, tanV: tanV, aspect: W / H, pixAng: 2 * tanV / (H * _aeStandRatio(hst)) };
}
function _aeHostDrop(site) {
  var h = site && site.host;
  if (!h) return;
  site.host = null;
  h.pend.dead = true;
  if (h.st) {
    if (h.st.scene) h.st.scene.remove(site.group);   // the site's own disposal takes its meshes
    if (site.eye && (site.eye.motion || site.eye.motionPending)) _aeMotionStop(site.eye, true);
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
    if (eye.motion || eye.motionPending) _aeMotionStop(eye, true);
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
// Where the walking head is off the level line of its eye: up and down once a step, left and right once a stride (two steps).
function _aeHostGait(e) {
  var a = e.gaitAmp || 0, p = (e.gait || 0) * 2 * Math.PI;
  return { rise: a * AE_GAIT_BOB_M * Math.sin(p), side: a * AE_GAIT_SWAY_M * Math.sin(p / 2) };
}
function _aeHostEyeCam(st, dt) {
  var e = st.eye, mv = e.motion ? _aeMotionView(e, performance.now()) : null;
  if (mv) {
    // The phone sets the heading, and a turn made by anything else since (the tap-walk's, a finger's) is kept as an offset
    // from it: a still phone never undoes it, so the eye does reach a destination to the side.
    e.senseOff = (e.senseOff || 0) + (e.senseSet == null ? 0 : _aeAngleDeltaRad(e.senseSet, e.yaw));
    e.yaw = _aeRad(mv.az) + e.senseOff; e.senseSet = e.yaw; e.pitch = _aeRad(mv.alt);
  } else { e.senseSet = null; e.senseOff = 0; }
  _aeHostEyeWalk(st, e, dt);
  if (e.goto || st.walkMarked) _aeHostWalkMark(st);
  var g = _aeHostGait(e), x = e.x + Math.cos(e.yaw) * g.side, y = e.y - Math.sin(e.yaw) * g.side;
  var z = _asGroundAt(st, e.x, e.y, false) + AE_STAND_EYE_M + (e.jump || 0) + g.rise, cp = Math.cos(e.pitch);
  return { pos: [x, y, z], focus: [x + Math.sin(e.yaw) * cp * AE_HOST_FOCUS_M, y + Math.cos(e.yaw) * cp * AE_HOST_FOCUS_M, z + Math.sin(e.pitch) * AE_HOST_FOCUS_M], fov: st.eyeFov };   // (the field Stand here had, where the eye came from it)
}
// On foot at a site: the same keys and stick as Stand here's walk (almanac-stand.js, AE_WALK_*): W S A D and the arrows, Space jumps in the site's own gravity,
// Shift (or the stick past the dotted ring) runs; the eye follows the ground. A walk stays within AE_HOST_WALK_MAX_M of the lander.
var AE_HOST_WALK_MAX_M = 4000;   // as far as a tap picks the ground (almanac-sites.js _asGroundPick) and a walk goes from the lander
// A tap on the ground is a walk there: the head turns to it first (as fast as the keys turn it), then the person sets off, builds up to the pace of a walk, eases in over the last
// steps and stops. Far enough that a true pace would take minutes, it runs time forward the way pushing the stick past its ring does, never a faster person. Any key or the stick takes
// the walk back. The gait is the body's: the head rises and falls once a step and sways once a stride, only while it walks at a person's pace.
var AE_TAPWALK_ARRIVE_M = 0.5, AE_TAPWALK_EASE_M = 2, AE_TAPWALK_FAR_M = 150, AE_TAPWALK_TURN_FIRST_RAD = 0.5, AE_TAPWALK_RAMP_PER_S = 2.5, AE_TAPWALK_MIN_V = 0.2;
var AE_GAIT_STEP_M = 0.74, AE_GAIT_BOB_M = 0.022, AE_GAIT_SWAY_M = 0.02, AE_GAIT_MAX_MS = 3, AE_GAIT_FADE_PER_S = 6;   // a step's length, the head's rise and fall, its sway, the speed past which it is not a gait, how fast the gait comes and goes
// A tap on a thing walks up to it and stops short of it by its own half width and a pace or two, never past it (standoff, metres beyond its middle).
var AE_TAPWALK_STANDOFF_M = 1.5, AE_TAPWALK_MARK_PER_M = 1 / 150;
function _aeHostWalkTo(st, x, y, standoff) {
  if (!st || st.drive || st.launch || !st.host || !st.host.live) return false;
  if (!_aeHostEyeOn(st)) _aeHostEyeToggle(st);
  if (!_aeHostEyeOn(st)) return false;
  var e = st.eye, fx = st.focusXY[0], fy = st.focusXY[1], r = Math.hypot(x - fx, y - fy), mx, my;
  if (r > AE_HOST_WALK_MAX_M) { x = fx + (x - fx) * AE_HOST_WALK_MAX_M / r; y = fy + (y - fy) * AE_HOST_WALK_MAX_M / r; }
  mx = x; my = y;   // (the pillar stands on the place tapped)
  var d = Math.hypot(x - e.x, y - e.y);
  if (standoff && d > standoff) { x = mx + (e.x - mx) * standoff / d; y = my + (e.y - my) * standoff / d; }
  else if (standoff) { x = e.x; y = e.y; }
  e.goto = { x: x, y: y, mx: mx, my: my }; e.v = e.v || 0;
  _asDriveLoad(function () { _aeHostWalkMark(st); });
  _aeKick();
  return true;
}
// The pillar of light stands over where a walk is going (the drive's own, almanac-sites-drive.js) and goes when the walk does; wider the farther off, so it can be seen.
function _aeHostWalkMark(st) {
  var e = st.eye, g = e && e.goto;
  if (!g) { if (st.autoMark && st.walkMarked) { st.autoMark.visible = false; st.walkMarked = false; _aeRedraw(); } return; }
  if (typeof _asAutoMarkBuild !== 'function') return;   // (the drive's file is still on its way)
  _asAutoMarkBuild(st);
  var k = Math.max(1, Math.hypot(g.mx - e.x, g.my - e.y) * AE_TAPWALK_MARK_PER_M);
  st.autoMark.position.set(g.mx, g.my, _asGroundAt(st, g.mx, g.my, false));
  st.autoMark.scale.set(k, k, 1);
  st.autoMark.visible = st.walkMarked = true;
}
// The tap's turn to head for the place, and how much of a walk's pace the legs are at: a stick's forward push (0..1), and whether the way is long enough to run time.
function _aeHostWalkSteer(e, dt) {
  var g = e.goto, rx = g.x - e.x, ry = g.y - e.y, d = Math.hypot(rx, ry);
  if (d < AE_TAPWALK_ARRIVE_M) { e.goto = null; e.v = 0; return null; }
  var off = _aeAngleDeltaRad(e.yaw, Math.atan2(rx, ry)), turn = AE_WALK_TURN * dt;
  e.yaw += _aeClamp(off, -turn, turn);
  var ahead = Math.abs(off) < AE_TAPWALK_TURN_FIRST_RAD ? 1 : 0, ease = _aeClamp(d / AE_TAPWALK_EASE_M, AE_TAPWALK_MIN_V, 1);
  e.v = _aeClamp(e.v + (Math.min(ahead, ease) - e.v) * Math.min(1, AE_TAPWALK_RAMP_PER_S * dt * 2), 0, 1);
  return { stick: { x: 0, y: e.v }, run: d > AE_TAPWALK_FAR_M, left: d };
}
function _aeHostEyeWalk(st, e, dt) {
  e.keys = e.keys || {};
  var stick = { x: st.input.sx, y: st.input.sy }, run = e.run || st.input.fast;
  if (e.goto && (stick.x || stick.y || ['f', 'b', 'l', 'r', 'tl', 'tr'].some(function (k) { return e.keys[k]; }))) e.goto = null;   // a hand on the controls takes the walk back
  var steer = e.goto ? _aeHostWalkSteer(e, dt) : null;
  if (steer) { stick = steer.stick; run = steer.run; }
  var plan = _aeWalkPlan(e, stick, run, e.yaw, dt, st.body);
  if (plan.turn && !steer) e.yaw += plan.turn * AE_WALK_TURN * dt;
  var span = Math.hypot(plan.dx, plan.dy);
  if (steer && span > steer.left) { plan.dx *= steer.left / span; plan.dy *= steer.left / span; span = steer.left; }   // (never past the place)
  var pace = dt > 0 ? span / dt : 0, want = plan.moved && pace <= AE_GAIT_MAX_MS ? 1 : 0;
  e.gaitAmp = _aeClamp((e.gaitAmp || 0) + (want - (e.gaitAmp || 0)) * Math.min(1, AE_GAIT_FADE_PER_S * dt), 0, 1);
  e.gait = (e.gait || 0) + span / AE_GAIT_STEP_M;   // steps taken
  if (e.gaitAmp > 0.01 || e.goto) _aeKick();
  if (plan.moved) {
    var nx = e.x + plan.dx, ny = e.y + plan.dy, fx = st.focusXY[0], fy = st.focusXY[1], r = Math.hypot(nx - fx, ny - fy);
    if (r > AE_HOST_WALK_MAX_M) { nx = fx + (nx - fx) * AE_HOST_WALK_MAX_M / r; ny = fy + (ny - fy) * AE_HOST_WALK_MAX_M / r; }
    e.x = nx; e.y = ny;
  }
  if (plan.active) _aeKick();
}
// A finger's move at eye level: the phone's trim when it is on, else the heading and height themselves.
function _aeHostEyeLook(st, dx, dy) {
  var e = st.eye, fov = _ae.gl.camera.fov;
  if (e.motion && _aeMotionTrim(e, dx, dy, fov, _ae.h)) return;
  var k = _aeRad(fov) / _ae.h;
  e.yaw -= dx * k;
  e.pitch = _aeClamp(e.pitch + dy * k, -_aeRad(AE_MOTION_ALT_MAX), _aeRad(AE_MOTION_ALT_MAX));
}
// The Earth from another body's ground is the picture people want and it is small and high: when it is up but out of the field, a
// round chip at the edge points to it, and a tap turns the head to it.
var AE_HOST_HINT_EDGE_PX = [112, 132, 34];   // from the top bar, from the bottom card, from the sides
var AE_HOST_HINT_MARGIN = 0.85;              // a share of the half field inside which it counts as in view
var AE_HOST_HINT_BEHIND = 0.85;              // past this share of a half turn away the Earth is behind you, and its side holds
var AE_HOST_HINT_HALF_PX = 19;               // half the chip
function _aeHostEarthHint(site, hst) {
  var el = _aeById('as-earthhint'), eye = site.eye, fr = hst.fr, o = fr && site.body !== 'earth' && eye && eye.on ? fr.objs.filter(function (x) { return x.key === 'earth'; })[0] : null;
  if (!el) {
    var hud = _aeById('as-hud');
    if (!hud) return;
    el = document.createElement('button'); el.type = 'button'; el.id = 'as-earthhint'; el.className = 'ae-btn ae-round as-earthhint'; el.hidden = true;
    el.innerHTML = '<i class="as-earthhint-arrow"></i><b></b>';
    el.onclick = function () {
      var st = _ae.site, t = st && st.eye && st.host && st.host.st.fr && st.host.st.fr.objs.filter(function (x) { return x.key === 'earth'; })[0];
      if (t) { st.eye.yaw = Math.atan2(t.dir[0], t.dir[1]); st.eye.pitch = _aeClamp(Math.asin(_aeClamp(t.dir[2], -1, 1)), -_aeRad(AE_MOTION_ALT_MAX), _aeRad(AE_MOTION_ALT_MAX)); _aeKick(); }
    };
    hud.appendChild(el);
  }
  if (!o || o.dir[2] < 0) { if (!el.hidden) el.hidden = true; return; }
  var vf = _aeRad(_ae.gl.camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * _ae.w / _ae.h);
  var dy = _aeAngleDeltaRad(eye.yaw, Math.atan2(o.dir[0], o.dir[1])), dp = Math.asin(_aeClamp(o.dir[2], -1, 1)) - eye.pitch;
  // Behind you the left or right is a coin toss a degree decides: the side it was on holds there, so the chip neither
  // jumps across the screen nor spins as the head (or the phone in the hand) wavers.
  if (Math.abs(dy) > AE_HOST_HINT_BEHIND * Math.PI && el._side && Math.sign(dy) !== el._side) dy = el._side * Math.abs(dy);
  el._side = Math.sign(dy) || el._side || 1;
  var nx = dy / (hf / 2), ny = dp / (vf / 2);
  if (Math.abs(nx) < AE_HOST_HINT_MARGIN && Math.abs(ny) < AE_HOST_HINT_MARGIN) { if (!el.hidden) el.hidden = true; return; }
  el.hidden = false;
  var cx = _aeClamp(nx, -1, 1), cy = _aeClamp(ny, -1, 1), W = _ae.w, H = _ae.h;
  var x = W / 2 + cx * (W / 2 - AE_HOST_HINT_EDGE_PX[2]), y = H / 2 - cy * ((H - AE_HOST_HINT_EDGE_PX[0] - AE_HOST_HINT_EDGE_PX[1]) / 2) + (AE_HOST_HINT_EDGE_PX[0] - AE_HOST_HINT_EDGE_PX[1]) / 2;
  var at = typeof _aeHudClear === 'function' ? _aeHudClear(x - AE_HOST_HINT_HALF_PX, y - AE_HOST_HINT_HALF_PX, 2 * AE_HOST_HINT_HALF_PX, 2 * AE_HOST_HINT_HALF_PX) : { x: x - AE_HOST_HINT_HALF_PX, y: y - AE_HOST_HINT_HALF_PX };   // clear of the controls, the corner's words and the strip
  el.style.transform = 'translate(' + at.x.toFixed(0) + 'px,' + at.y.toFixed(0) + 'px)';
  el.firstChild.style.transform = 'rotate(' + (Math.atan2(nx, ny) * 180 / Math.PI).toFixed(0) + 'deg)';
  var label = _aeInfoName('earth');
  if (el.title !== label) { el.title = label; el.setAttribute('aria-label', label); }
}
function _aeHostEyeOn(st) { return !!(st && st.eye && st.eye.on); }
// The phone as the way to look at eye level.
function _aeHostMotionToggle(site) {
  var eye = site && site.eye;
  if (!eye || !eye.on) return Promise.resolve(false);
  if (eye.motion) { _aeMotionStop(eye); return Promise.resolve(false); }
  return _aeMotionStart(eye);
}

// ── The flight's ground ──
// The UFO (almanac-fly.js) flies down to a ground the way a visit is shown on one: the flight keeps the frame and its own camera, and the ground's scene is
// drawn with that same camera carried into its frame. Height alone says how much of the picture is the ground's (the curve Stand here's fall uses,
// _aeStandAlphaAt): above the top the globe's, through the band both, below it the ground's alone. Nothing waits on a clock, so the craft can stop in the
// band, hang there, or climb out of it again. The craft is drawn in both pictures at the one place.
//
//   _aeRigGroundStep(sh, now)        every step of the flight: build the ground under the craft when it is near, let it go when it is far
//   _aeRigGroundFrame(sh)            every step, first: where that ground stands in the main scene now
//   _aeRigGroundDraw(sh, now, main)  the frame, in place of the globe's own draw (`main` draws that, when any of it still shows)
//   _aeRigLift(sh, b)                metres the craft is under its lowest height over that ground (null where no ground is drawn)
var AE_RIG_M_PER_RE = AE_EARTH_RADIUS_KM * 1000;
var AE_RIG_PREP = AE_GROUND_REF.prep;            // the ground is built once the craft is within this many times the height it starts to show at
var AE_RIG_KEEP = AE_GROUND_REF.keep;            // and let go once it is this many times farther than that again (so the edge is not built and dropped in turn)
var AE_RIG_HOVER_M = AE_FLY_REF.hoverM;   // the craft's underside is never nearer the ground than this
var AE_RIG_LATE_MS = AE_GROUND_REF.lateMs;       // a ground that was built late (the craft already in the band) comes in over this long, not at once
var AE_RIG_UFO_HALF_H = 0.27;   // the craft's underside below its middle, in half-widths (almanac-fly.js AF_UFO_PROFILE)
// A place of the main scene (Earth radii) in a ground's frame (metres: east, north, up from its origin), and a direction.
function _aeRigLocal(fr, w) { var d = _aeSub(w, fr.origin); return [_aeDot(d, fr.e) * AE_RIG_M_PER_RE, _aeDot(d, fr.n) * AE_RIG_M_PER_RE, _aeDot(d, fr.u) * AE_RIG_M_PER_RE]; }
function _aeRigDir(fr, v) { return [_aeDot(v, fr.e), _aeDot(v, fr.n), _aeDot(v, fr.u)]; }
// The frame of a latitude and longitude on a body as the main scene draws it now: the origin on its sphere, east, north and up.
// `liftM`: the origin stands this far over the sphere (a ground built again under a craft that has flown on keeps its hills at the height the last one had them).
function _aeRigFrame(key, lat, lon, liftM) {
  var f = _aeStBodyNow(key), at = _aeBodyPos(key), t = AE_TARGETS[key];
  if (!f || !at || !t) return null;
  var la = _aeRad(lat), lo = _aeRad(lon), up = _aeStToScene(f, _aeUnitVec(lat, lon));
  return { origin: _aeAdd(_aeAdd(at, _aeScale(_aeStToScene(f, _aeStPlaceVec(key, lat, lon)), t.surface)), _aeScale(up, (liftM || 0) / AE_RIG_M_PER_RE)), u: up,
    e: _aeStToScene(f, [-Math.sin(lo), Math.cos(lo), 0]), n: _aeStToScene(f, [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)]) };
}
// The latitude and longitude under a place of the main scene, on the body as it is turned now.
function _aeRigLatLon(key, pos) {
  var f = _aeStBodyNow(key), at = _aeBodyPos(key);
  if (!f || !at) return null;
  var rel = _aeSub(pos, at), q = _aeNorm([_aeDot(f.f.x, rel), _aeDot(f.f.y, rel), _aeDot(f.f.z, rel)]);
  if (key === 'earth') { var g = _aeSphereLatLon(q[0], q[1], q[2] / (1 - AE_EARTH_FLATTENING), AE_EARTH_FLATTENING); return { lat: g.lat, lon: g.lon }; }   // the flattened globe's own latitude (the map's), not the angle from its middle: 20 km apart at 45 degrees
  return _aeLatLonOf(q);
}
// The height the ground starts to show at under a craft: where the globe's own map stops being sharp (Stand here's own figure), but no higher than a share of
// the body's radius. A fall passes the heights between in a second, looking down; a craft may hang there looking at the horizon, and from tens of kilometres
// up the globe's map, soft as it is, says more than the ground's haze.
var AE_RIG_TOP_SHARE = AE_FLY_REF.bandShare;   // 40 km over the Earth, 11 over the Moon
function _aeRigTopKm(key) {
  var t = AE_TARGETS[key];
  return _aeClamp(t.surface * AE_EARTH_RADIUS_KM * AE_RIG_TOP_SHARE, AE_STAND_CUT_KM, (_aeStandSharpAt(key) - t.surface) * AE_EARTH_RADIUS_KM);
}
function _aeRigGroundStep(sh, now) {
  var g = sh.gnd, b = sh.near.body, key = b.key, altKm = sh.near.alt * AE_EARTH_RADIUS_KM;
  if (g && (g.key !== key || altKm > g.top * AE_RIG_PREP * AE_RIG_KEEP)) { _aeRigGroundDrop(sh); g = null; }
  if (!g) {
    if (!_aeStandable(key) || (sh.auto && sh.auto !== key)) return;
    var top = _aeRigTopKm(key), ll = altKm <= top * AE_RIG_PREP ? _aeRigLatLon(key, sh.pos) : null;
    if (!ll) return;
    var pend = { key: key, lat: ll.lat, lon: ll.lon, ready: false, t0: now, host: true, tex: null, alt0: top };
    sh.gnd = { key: key, lat: ll.lat, lon: ll.lon, top: top, pend: pend, st: null, live: false, liveAt: 0, fr: null, craft: null };
    _aeStandBuild(pend, AE_STAND_BODIES[key]);
    return;
  }
  if (!g.live && g.pend.ready && !g.st) {   // built: its programs compiled off screen first, so its first picture costs the flight nothing
    var st = g.st = _aeStandNew(g.pend);
    if (!st) { _aeRigGroundDrop(sh); return; }
    st.host = true; st.flown = true; st.live = true;
    if (sh.craft) g.craft = _aeRigCraft(g, sh.craft);   // (in the scene before it is warmed: the craft's programs for the ground's target are compiled with the rest)
    _aeStandWarm(st).then(function () {
      if (sh.gnd !== g || _ae.ship !== sh) return;
      var S = _ae.gl;
      // The ground's sky is worked out per pixel: its own cap on the picture's sharpness. Drawn into its own target it takes that there and the canvas keeps
      // its size; drawn straight to the canvas (no such target here) the canvas takes it, where the ground first shows (nothing of it yet).
      var own = Math.min(S.dpr, _aeStandRatioCap());
      if (_aeStandOffscreen(true)) st.ownRatio = own;
      else { g.prevRatio = S.renderer.getPixelRatio(); S.renderer.setPixelRatio(own); _aeResize(); }
      st.starUni.uDpr.value = own;
      _aeRigHd(sh, g, performance.now());   // the tiles' picture of the place, before the ground first shows
      g.live = true; g.liveAt = performance.now();
      _aeStandTrees(st);   // the Earth's trees and grass, built in slices beside the flight: there on the way down
      _aeRedraw();
    });
  }
  if (g.live) _aeRigReanchor(sh, g, now);
}
// A ground is built round one place: fine at its middle, coarser by the distance from it (its rings are spaced by about 7% of that). A craft that flies on,
// low, comes to where the ground under it is coarse. So once it is farther from the middle than a few of its own heights (and than AE_RIG_REANCHOR_M), the
// ground is built again round where it is now, in the background, and takes the old one's place when it is whole: the same hills at the same heights
// (liftM carries the difference of the two middles' own heights), only finer.
var AE_RIG_REANCHOR_M = AE_FLY_REF.reanchorM, AE_RIG_REANCHOR_HEIGHTS = AE_FLY_REF.reanchorHeights;
function _aeRigReanchor(sh, g, now) {
  var n = g.next;
  if (!n) {
    if (!g.fr || !g.craft) return;
    var p = _aeRigLocal(g.fr, sh.pos);
    if (Math.hypot(p[0], p[1]) < Math.max(AE_RIG_REANCHOR_M, AE_RIG_REANCHOR_HEIGHTS * Math.max(0, p[2]))) return;
    var ll = _aeRigLatLon(g.key, sh.pos);
    if (!ll) return;
    n = g.next = { pend: { key: g.key, lat: ll.lat, lon: ll.lon, ready: false, t0: now, host: true, tex: null, alt0: g.top }, st: null, whole: false };
    _aeStandBuild(n.pend, AE_STAND_BODIES[g.key]);
    return;
  }
  if (n.pend.ready && !n.st) {
    n.st = _aeStandNew(n.pend);
    if (!n.st) { g.next = null; return; }
    n.st.host = true; n.st.flown = true; n.st.live = true;
    _aeStandWarm(n.st).then(function () { n.whole = true; _aeStandTrees(n.st); _aeKick(); });
  }
  if (!n.whole || g.next !== n) return;
  var old = g.st;
  g.liftM = (g.liftM || 0) + n.st.h0 - old.h0;
  if (g.craft && old.scene) old.scene.remove(g.craft.root);
  g.craft = null;   // (made again in the new ground's scene by its next picture)
  g.pend.dead = true;
  _aeStandDispose(old);
  n.st.ownRatio = old.ownRatio;
  g.pend = n.pend; g.st = n.st; g.lat = n.pend.lat; g.lon = n.pend.lon; g.next = null;
  g.fr = _aeRigFrameOf(g);
}
// A ground being built to take another's place, let go unfinished (the craft set down, or left).
function _aeRigNextDrop(g) {
  var n = g && g.next;
  if (!n) return;
  g.next = null;
  n.pend.dead = true;
  if (n.st) _aeStandDispose(n.st);
}
// The ground's frame for this step, from the bodies as they stand now: asked before the craft is moved or stopped against that ground (a body's own move in
// one frame is metres to kilometres; a frame one step old would put the craft that far off its ground).
function _aeRigGroundFrame(sh) {
  var g = sh.gnd;
  if (g && g.live) g.fr = _aeRigFrameOf(g);
}
function _aeRigFrameOf(g) { return _aeRigFrame(g.key, g.lat, g.lon, g.liftM); }
function _aeRigGroundDrop(sh) {
  var g = sh && sh.gnd;
  if (!g) return;
  sh.gnd = null;
  g.pend.dead = true;
  _aeRigNextDrop(g);
  if (g.match) { g.match.globeRt.rt.dispose(); g.match.groundRt.rt.dispose(); }
  if (g.hd) { g.hd.far.rt.dispose(); g.hd.near.rt.dispose(); g.hd.quad.dispose(); (g.hd.pool || []).forEach(function (q) { q.material.dispose(); }); }
  if (g.st) { if (g.craft && g.st.scene) g.st.scene.remove(g.craft.root); _aeStandDispose(g.st); }
  var S = _ae.gl;
  if (S && g.prevRatio) { S.renderer.setPixelRatio(g.prevRatio); _aeResize(); }
}
// A place of a ground's frame back in the main scene, and a direction.
function _aeRigWorld(fr, p) { return _aeAdd(fr.origin, _aeAdd(_aeAdd(_aeScale(fr.e, p[0] / AE_RIG_M_PER_RE), _aeScale(fr.n, p[1] / AE_RIG_M_PER_RE)), _aeScale(fr.u, p[2] / AE_RIG_M_PER_RE))); }
function _aeRigWorldDir(fr, v) { return _aeAdd(_aeAdd(_aeScale(fr.e, v[0]), _aeScale(fr.n, v[1])), _aeScale(fr.u, v[2])); }
// The ground's camera as it stands (the chase camera's last picture, or the eye's): its place, its look and its field, in the ground's own frame.
function _aeRigCamNow(st) {
  var c = st.camera, e = c.matrixWorld.elements;
  return { pos: _aeXyz(c.position), fwd: [-e[8], -e[9], -e[10]], up: [e[4], e[5], e[6]], fov: _aeRad(c.fov) };
}
// The craft's own meshes a second time, for the ground's scene (the same geometry and material: one craft, lit once).
function _aeRigCraft(g, I) {
  var T = _ae.gl.THREE, root = new T.Group(), body = new T.Mesh(I.body.geometry, I.body.material), halo = new T.Mesh(I.halo.geometry, I.halo.material);
  halo.renderOrder = I.halo.renderOrder;
  body.frustumCulled = halo.frustumCulled = false;
  root.add(body); root.add(halo);
  g.st.scene.add(root);
  return { root: root, body: body, halo: halo };
}
// Metres the craft is under its lowest height over the ground drawn for this body (negative: clear of it); null where none is drawn.
function _aeRigLift(sh, b) {
  var g = sh.gnd;
  if (!g || !g.live || !g.fr || g.key !== b.key) return null;
  var p = _aeRigLocal(g.fr, sh.pos), half = sh.span / 2 * AE_RIG_M_PER_RE;
  return _aeTerrainLocal(g.key, g.lat, g.lon, g.st.h0, p[0], p[1], 0, null) + AE_RIG_HOVER_M + half * AE_RIG_UFO_HALF_H - p[2];
}
// The chase camera never under the ground it looks over: metres to raise it by (0 when it is clear).
function _aeRigCamLift(sh, pos) {
  var g = sh.gnd;
  if (!g || !g.live || !g.fr) return 0;
  var p = _aeRigLocal(g.fr, pos);
  return Math.max(0, _aeTerrainLocal(g.key, g.lat, g.lon, g.st.h0, p[0], p[1], 0, null) + AE_STAND_EYE_M - p[2]);
}
function _aeRigGroundDraw(sh, now, main) {
  var g = sh.gnd, st = g.st, S = _ae.gl, cam = S.camera, I = sh.craft;
  var fr = g.fr = _aeRigFrameOf(g), eye = fr ? _aeRigLocal(fr, _aeXyz(cam.position)) : null;
  if (!fr || !I) { main(); return; }
  st.altKm = Math.max(AE_STAND_EYE_M, eye[2]) / 1000;
  var own = _aeStandAlphaAt(g.top, st.altKm);   // how far down the band: the ground's share of the picture, and of its own colour
  st.alpha = Math.min(own, _aeReduceMotion() ? 1 : _aeClamp((now - g.liveAt) / AE_RIG_LATE_MS, 0, 1));
  _aeRigHd(sh, g, now);
  var matched = 1 - _aeRigSettled(g.top, st.altKm);
  st.kMatch = g.match ? Math.pow(g.match.k, matched) : 1;
  st.ground.uMatch.value = g.match ? g.match.hue.map(function (x) { return Math.pow(x, matched); }) : [1, 1, 1];
  if (st.alpha < 1) main();
  if (st.alpha <= 0) return;
  var c = g.craft || (g.craft = _aeRigCraft(g, I)), p = _aeRigLocal(fr, _aeXyz(I.root.position)), ax = _aeRigDir(fr, I.axis || sh.up), V = S.THREE.Vector3;
  c.root.position.set(p[0], p[1], p[2]);
  c.body.scale.setScalar(I.body.scale.x * AE_RIG_M_PER_RE);
  c.halo.scale.setScalar(I.halo.scale.x * AE_RIG_M_PER_RE);
  c.body.quaternion.setFromUnitVectors(new V(0, 1, 0), new V(ax[0], ax[1], ax[2]));
  _aeStandPaint(st, now, true, function (hst) { return _aeHostCameraIn(hst, fr); });
  if (own < 1 && (!g.match || now - g.match.at >= AE_RIG_MATCH_EVERY_MS)) _aeRigMatch(sh, g, now);   // (below the band the globe is not drawn: the last measure stands)
}
// ── One picture where the two meet ──
// The globe draws a place as its map shows it; the ground works the same place out from light, air and an eye's exposure, set for ground of a middling
// albedo. Both are right and they differ: sunlit sand and snow are far brighter than that middling ground (a flown-over desert came in near white), and
// Mars is salmon from orbit and rust underfoot. A ground that faded in at its own brightness and colour was a second picture laid over the first. The
// two are measured, not modelled: each scene is drawn straight down on the place from the top of the band into a few pixels and read back. The ground's
// exposure is then the one that gives it the globe's brightness there, and what is left of the difference in hue is a multiplier on its colour. Down the
// band both give way to the ground's own, as an eye settles.
var AE_RIG_MATCH_PX = AE_GROUND_REF.matchPx;            // the side of the square each scene is read from
var AE_RIG_MATCH_EVERY_MS = AE_GROUND_REF.matchEveryMs;   // measured again this often while the globe still shows (the Sun and the clock move)
var AE_RIG_MATCH_FLOOR = AE_GROUND_REF.matchFloor;   // added to both before a ratio: night's near-black is not a ratio of noise
var AE_RIG_MATCH_K = AE_GROUND_REF.matchK;   // the exposure is changed by no more than this, either way
var AE_RIG_MATCH_HUE = AE_GROUND_REF.matchHue;           // and the colour left over by no more than this
var AE_RIG_MATCH_WHITE = AE_GROUND_REF.matchWhite;      // a mean brighter than this is clipped: its true brightness cannot be read from it
var AE_RIG_LUMA = AE_GROUND_REF.luma;   // Rec. 709
var AE_RIG_SETTLE_DECADES = AE_GROUND_REF.settleDecades;      // the ground is at its own exposure and colour this many tenfolds of height below the top of the band (400 m over the Earth)
// How far the eye has settled on the ground's own picture at a height: 0 at the top of the band, 1 from AE_RIG_SETTLE_DECADES below it.
function _aeRigSettled(topKm, altKm) { return _aeSmoother(_aeClamp(Math.log10(topKm / Math.max(altKm, 1e-9)) / AE_RIG_SETTLE_DECADES, 0, 1)); }
// A few pixels of a scene, read back without stopping the frame for them (the GPU's answer is waited for, not forced): their mean colour, 0 to 1.
function _aeRigMean(rt, buf) {
  var r = _ae.gl.renderer, n = AE_RIG_MATCH_PX * AE_RIG_MATCH_PX, mean = function () {
    var sum = [0, 0, 0];
    for (var i = 0; i < n; i++) for (var c = 0; c < 3; c++) sum[c] += buf[4 * i + c];
    return sum.map(function (x) { return x / n / AE_BYTE; });
  };
  if (r.readRenderTargetPixelsAsync) return r.readRenderTargetPixelsAsync(rt, 0, 0, AE_RIG_MATCH_PX, AE_RIG_MATCH_PX, buf).then(mean);
  r.readRenderTargetPixels(rt, 0, 0, AE_RIG_MATCH_PX, AE_RIG_MATCH_PX, buf);
  return Promise.resolve(mean());
}
// The ground's tone curve (almanac-standgl.js tone: 1 - exp(-L k), then the display's gamma) turned round: the light a shown value stands for, times k.
function _aeRigExposed(shown) { return -Math.log(1 - Math.pow(Math.min(shown, AE_RIG_MATCH_WHITE), AE_ST_GAMMA_N)); }
function _aeRigShown(exposed) { return Math.pow(1 - Math.exp(-exposed), 1 / AE_ST_GAMMA_N); }
function _aeRigLuma(c) { return c[0] * AE_RIG_LUMA[0] + c[1] * AE_RIG_LUMA[1] + c[2] * AE_RIG_LUMA[2]; }
function _aeRigMatch(sh, g, now) {
  var S = _ae.gl, r = S.renderer, T = S.THREE, st = g.st, fr = g.fr, I = sh.craft, top = g.top * 1000, gu = st.ground, px = AE_RIG_MATCH_PX;
  var target = function (screen) { return { rt: screen ? _aeScreenLikeTarget(T, px, px) : new T.WebGLRenderTarget(px, px), buf: new Uint8Array(px * px * 4) }; };   // each scene with the programs it is drawn with already: the globe's are the screen's, the ground's (laid over the globe) a target's
  var M = g.match || (g.match = { globeRt: target(true), groundRt: target(!_aeStandOffscreen(true)), cam: new T.PerspectiveCamera(), k: 1, hue: [1, 1, 1], at: 0, busy: false });
  if (M.busy) return;
  var cam = M.cam, prev = r.getRenderTarget(), look = function (eye, at, up, near, far) {
    cam.fov = S.camera.fov; cam.aspect = 1; cam.near = near; cam.far = far;
    cam.position.set(eye[0], eye[1], eye[2]); cam.up.set(up[0], up[1], up[2]); cam.lookAt(at[0], at[1], at[2]);
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  };
  M.at = now; M.busy = true;
  // The globe's picture of the place, without the craft over it.
  var seen = I.root.visible, h = top / AE_RIG_M_PER_RE;
  I.root.visible = false;
  look(_aeAdd(fr.origin, _aeScale(fr.u, h)), fr.origin, fr.n, h * AE_NEAR_FRACTION, S.camera.far);
  r.setRenderTarget(M.globeRt.rt); r.clear(); r.render(S.scene, cam);
  I.root.visible = seen;
  // The ground's, from the same place, at its own exposure and colour.
  var was = { cam: gu.uCam.value, pix: gu.uPixAng.value, hue: gu.uMatch.value, k: gu.uKg.value, craft: g.craft && g.craft.root.visible };
  if (g.craft) g.craft.root.visible = false;
  gu.uCam.value = [0, 0, top]; gu.uPixAng.value = 2 * _aeTanHalf(cam.fov) / px; gu.uMatch.value = [1, 1, 1]; gu.uKg.value = was.k / (st.kMatch || 1);
  look([0, 0, top], [0, 0, 0], [0, 1, 0], top * AE_NEAR_FRACTION, top * AE_RIG_KEEP);
  r.setRenderTarget(M.groundRt.rt); r.clear(); r.render(st.scene, cam);
  gu.uCam.value = was.cam; gu.uPixAng.value = was.pix; gu.uMatch.value = was.hue; gu.uKg.value = was.k;
  if (g.craft) g.craft.root.visible = was.craft;
  r.setRenderTarget(prev);
  Promise.all([_aeRigMean(M.globeRt.rt, M.globeRt.buf), _aeRigMean(M.groundRt.rt, M.groundRt.buf)]).then(function (seenAs) {
    M.busy = false;
    if (sh.gnd !== g) return;
    M.globe = seenAs[0]; M.ground = seenAs[1];
    // The exposure that shows the ground as bright as the globe; then each channel as that exposure would show it, against the globe's.
    M.k = _aeClamp(_aeRigExposed(_aeRigLuma(M.globe)) / Math.max(_aeRigExposed(_aeRigLuma(M.ground)), 1e-6), AE_RIG_MATCH_K[0], AE_RIG_MATCH_K[1]);
    M.hue = M.globe.map(function (x, c) {
      return _aeClamp((x + AE_RIG_MATCH_FLOOR) / (_aeRigShown(_aeRigExposed(M.ground[c]) * M.k) + AE_RIG_MATCH_FLOOR), 1 / AE_RIG_MATCH_HUE, AE_RIG_MATCH_HUE);
    });
    _aeRedraw();
  }, function () { M.busy = false; });
}

// ── Almanac HD's tiles under the craft ──
// The globe is drawn from Almanac HD's tiles where they are installed; the ground had only the body's one map, so the picture lost its detail as the
// ground took it over. The tiles the globe holds round the place are drawn into two local pictures the ground's shader reads in place of the one map:
// a far one out to the horizon, and a near one, an eighth of that across, that follows the craft. Each is the one map with every ready tile over it,
// coarse to fine, in the map's own uv (so a tile sits where the globe draws it). They are drawn again when a tile arrives or the craft has moved on.
// The globe asks only for the tiles its own camera sees, and a craft looking down sees a few kilometres: so each picture asks for its own, the level
// whose tiles are about the picture's size (nine of them at most), and keeps them from the tiles' clear-out while it stands.
var AE_RIG_HD_PX = AE_GROUND_REF.hdPx;           // each picture, a side
var AE_RIG_HD_FAR = AE_GROUND_REF.hdFar;           // the far picture reaches this many times the horizon's angle from the top of the band
var AE_RIG_HD_NEAR_SHARE = AE_GROUND_REF.hdNearShare;  // the near one this share of that
var AE_RIG_HD_EVERY_MS = AE_GROUND_REF.hdEveryMs;      // looked at again this often
var AE_RIG_HD_RECENTRE = AE_GROUND_REF.hdRecentre;      // the near picture is drawn again once the craft is this share of its half-width from its middle
var AE_RIG_HD_MIN_COS = AE_GROUND_REF.hdMinCos;       // a window's width in longitude grows with latitude no further than this cosine's
var AE_RIG_HD_PRI = -5;            // asked for after the globe's first two levels (-10, -9), before the tiles of its own view
// The tiles a picture is drawn from: the level at which one tile is no bigger than the window is high, every tile of it the window touches.
function _aeRigHdTiles(b, win) {
  var level = Math.min(b.maps[0].max, Math.max(0, Math.ceil(Math.log(0.5 / win[3]) / Math.LN2))), rows = Math.pow(2, level), cols = 2 * rows, out = [];
  var x0 = Math.floor((win[0] - win[2]) * cols), x1 = Math.floor((win[0] + win[2]) * cols);
  var y0 = Math.max(0, Math.floor((1 - win[1] - win[3]) * rows)), y1 = Math.min(rows - 1, Math.floor((1 - win[1] + win[3]) * rows));
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= Math.min(x1, x0 + cols - 1); x++) out.push(_aeHdNode(b, level, ((x % cols) + cols) % cols, y));
  return out;
}
// Asked for, and marked as in use for the frame to come (the clear-out spares what the frame it runs in has used).
function _aeRigHdKeep(g) {
  var S = _ae.gl, hd = S.hd, H = g.hd;
  if (!hd || !H || !H.keep) return;
  H.keep.forEach(function (n) { _aeHdWant(S, H.body, n, AE_RIG_HD_PRI, hd.frame + 1); _aeHdTouch(H.body, n, hd.frame + 1); });
}
var AE_RIG_HD_VERT = 'uniform vec4 uBox, uWin; uniform float uShift; varying vec2 vQ; void main() { vQ = position.xy; vec2 uv = uBox.xy + position.xy * uBox.zw; uv.x += uShift; gl_Position = vec4((uv - uWin.xy) / uWin.zw, 0.0, 1.0); }';
var AE_RIG_HD_FRAG = 'precision highp float; uniform sampler2D uTex; uniform float uGrey; varying vec2 vQ; void main() { vec3 c = texture2D(uTex, vQ).rgb; gl_FragColor = vec4(uGrey > 0.5 ? vec3(c.r) : c, 1.0); }';
function _aeRigUv(lat, lon) { return [lon / 360 + 0.5, lat / 180 + 0.5]; }
function _aeRigHd(sh, g, now) {
  var S = _ae.gl, T = S.THREE, hd = S.hd, gu = g.st.ground, b = hd && _aeCapGet('hdTiles', true) ? hd.bodies.filter(function (x) { return x.key === g.key; })[0] : null;
  if (!b || !gu.uMap.value) { gu.uHd.value = 0; return; }
  var H = g.hd;
  if (!H) {
    var quad = new T.BufferGeometry();
    quad.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
    var picture = function () {
      var rt = new T.WebGLRenderTarget(AE_RIG_HD_PX, AE_RIG_HD_PX, { minFilter: T.LinearMipmapLinearFilter, magFilter: T.LinearFilter, generateMipmaps: true, depthBuffer: false });
      rt.texture.anisotropy = S.aniso;
      return { rt: rt, win: null };
    };
    var ang = Math.acos(1 / (1 + g.top / g.st.b.km)) * AE_RIG_HD_FAR, half = function (lat, k) { return [Math.min(0.5, ang * k / (2 * Math.PI) / Math.max(Math.cos(_aeRad(lat)), AE_RIG_HD_MIN_COS)), ang * k / Math.PI]; };
    H = g.hd = { quad: quad, far: picture(), near: picture(), cam: new T.PerspectiveCamera(), half: half, at: -Infinity, tiles: -1 };
    H.far.win = _aeRigUv(g.lat, g.lon).concat(half(g.lat, 1));
  }
  _aeRigHdKeep(g);
  if (H.tiles > 0) { gu.uHdFar.value = H.far.rt.texture; gu.uHdNear.value = H.near.rt.texture; gu.uHdFarWin.value = H.far.win; gu.uHdNearWin.value = H.near.win; gu.uHd.value = 1; }   // (the ground may be a new one, built round where the craft has got to)
  if (now - H.at < AE_RIG_HD_EVERY_MS) return;
  H.at = now; H.body = b;
  var layer = b.maps[0].layer, ready = [];
  for (var k in b.nodes) { var n = b.nodes[k], tx = n.tex[layer]; if (tx && tx.isTexture && hd.fresh.indexOf(tx) < 0) ready.push(n); }   // (in, and on the GPU already: a tile still waiting its turn there would be uploaded by this draw, several in one frame)
  var ll = _aeRigLatLon(g.key, sh.pos), at = ll ? _aeRigUv(ll.lat, ll.lon) : H.far.win, nw = H.near.win, du = nw ? at[0] - nw[0] : 0;
  du -= Math.floor(du + 0.5);
  var moved = !nw || Math.abs(du) > nw[2] * AE_RIG_HD_RECENTRE || Math.abs(at[1] - nw[1]) > nw[3] * AE_RIG_HD_RECENTRE;
  if (ready.length === H.tiles && !moved) return;
  if (moved) H.near.win = at.concat(H.half(ll ? ll.lat : g.lat, AE_RIG_HD_NEAR_SHARE));
  if (moved || !H.keep) { H.keep = _aeRigHdTiles(b, H.far.win).concat(_aeRigHdTiles(b, H.near.win)); _aeRigHdKeep(g); }
  var far = ready.length !== H.tiles;
  H.tiles = ready.length;
  ready.sort(function (a, c) { return a.z - c.z; });
  if (far) _aeRigHdDraw(H, H.far, gu, b, ready);
  _aeRigHdDraw(H, H.near, gu, b, ready);
  gu.uHdFar.value = H.far.rt.texture; gu.uHdNear.value = H.near.rt.texture;
  gu.uHdFarWin.value = H.far.win; gu.uHdNearWin.value = H.near.win;
  gu.uHd.value = ready.length ? 1 : 0;
  _ae.dirty = true;
}
// One local picture: the body's one map, then every ready tile that touches the window, coarse to fine (each also a whole turn east and west: the window may
// lie across the map's edge). The quads are kept from one drawing to the next: only what each shows changes.
function _aeRigHdDraw(H, pic, gu, b, ready) {
  var S = _ae.gl, T = S.THREE, r = S.renderer, win = pic.win, m = b.maps[0], used = 0;
  var scene = H.scene || (H.scene = new T.Scene()), pool = H.pool || (H.pool = []);
  var add = function (tex, box, grey, order) {
    for (var shift = -1; shift <= 1; shift++) {
      var u0 = box[0] + shift;
      if (u0 > win[0] + win[2] || u0 + box[2] < win[0] - win[2] || box[1] > win[1] + win[3] || box[1] + box[3] < win[1] - win[3]) continue;
      var mesh = pool[used++];
      if (!mesh) {
        mesh = new T.Mesh(H.quad, new T.ShaderMaterial({ uniforms: { uTex: { value: null }, uBox: { value: null }, uWin: { value: null }, uShift: { value: 0 }, uGrey: { value: 0 } }, vertexShader: AE_RIG_HD_VERT, fragmentShader: AE_RIG_HD_FRAG, depthTest: false, depthWrite: false }));
        mesh.frustumCulled = false;
        scene.add(mesh); pool.push(mesh);
      }
      var u = mesh.material.uniforms;
      u.uTex.value = tex; u.uBox.value = box; u.uWin.value = win; u.uShift.value = shift; u.uGrey.value = grey ? 1 : 0;
      mesh.renderOrder = order; mesh.visible = true;
    }
  };
  add(gu.uMap.value, [0, 0, 1, 1], gu.uGrey.value > 0.5, -1);
  ready.forEach(function (n) { add(n.tex[m.layer], _aeHdBox(n.z, n.x, n.y), !!m.red, n.z); });
  for (var i = used; i < pool.length; i++) pool[i].visible = false;
  var prev = r.getRenderTarget();
  r.setRenderTarget(pic.rt); r.clear(); r.render(scene, H.cam); r.setRenderTarget(prev);
}
