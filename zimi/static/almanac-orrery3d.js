// The solar system, 2D and 3D, as one view: the orrery lifts into the Earth view and settles back onto the page.
//
// The page's orrery (almanac-orrery.js) and the view's Planets overview (almanac-earth.js) draw the same picture: every
// body in its true direction from the Sun, at the one squeeze of its distance (_solarSqueeze), from above the ecliptic's
// north, north up. So the orrery is one position of the 3D camera: straight above the Sun, a distance and a field of
// view that give its scale, its frame the canvas's rectangle on the screen. A tap on a body opens the view on exactly
// that camera (the first 3D frame is the last flat frame, the body at the same point of the screen), the flat canvas
// is covered as the 3D drawing fades in over it, and then the camera tilts and flies in to the body, the frame opening
// to the whole view and the page dimming behind. Leaving the Planets view (the way back, or pulling out far enough)
// flies the other way and fades onto the canvas. Both views read one clock, so no moment or pace changes in between.
// Loaded with the Earth view (almanac-earth.js _aeOrreryLoad); its hooks there are _aeHandCam, _aeHandBlend, _aeHandApply,
// _aeEnter, _aeClose and _aeZoomBy, the way the hero Moon's hand-over uses them.

var AE_ORR_HAND_MS = 1100;          // the whole lift (and the settle back)
var AE_ORR_FADE = 0.16;             // the share of it the 3D drawing takes to fade in over the flat one, the camera still
var AE_ORR_CAM_FROM = 0.10;         // and where the camera starts to move
var AE_ORR_PULL_FIT = 1.25;         // the Planets view pulled out to this many times its own fit settles onto the orrery
var AE_ORR_FRAME_LEAD = 2;          // the frame opens to the whole view this many times faster than the camera goes
var AE_ORR_CORNER_PX = 12;          // the canvas's rounded corners (almanac-orrery.js _initOrrery)

// The page's orrery as a frame of the view: its canvas rectangle in the view's coordinates, and its camera. Null when
// it is not on the screen to be lifted from or settled onto.
function _aeOrreryFrame(state) {
  var st = state || (typeof _orreryFrameState === 'function' ? _orreryFrameState() : null);
  if (!st || !_ae || !_ae.el) return null;
  var v = _ae.el.getBoundingClientRect();
  if (!v.width || st.top + st.size <= v.top || st.top >= v.bottom) return null;
  return { frame: { x: st.left - v.left, y: st.top - v.top, w: st.size, h: st.size }, cam: st.cam };
}

// The ecliptic's axes in the scene (the view's equator-of-date coordinates), at a scene's moment.
function _aeOrreryAxes(sc) {
  var jd = sc.ms / MS_PER_DAY + JD_UNIX_EPOCH, jde = jd + _aeDeltaTDays(jd);
  var z = _aeNorm(_ephEclJ2000ToEqOfDate([0, 0, 1], jde)), x = _aeNorm(_ephEclJ2000ToEqOfDate([1, 0, 0], jde));
  return { x: x, y: _aeCross(z, x), z: z };
}

// The camera that is the orrery's drawing (hand.orrery = { cam }): over the Sun on the ecliptic's pole, the field of view
// the view's own, the distance that puts a drawn radius (a share of the canvas's width, _solarSqueeze) where the flat
// drawing has it (the canvas is `frame.h` tall in the camera's frame, so a share w of it is w * h / 2 / (dist * tanHalf)
// px: dist * tanHalf = K / (2 zoom), K the scene's length of a share of one), and the point looked at the one the
// drawing's camera centres (the ride's follow, its zoom).
function _aeOrreryCam(sc, hand) {
  var o = hand.orrery, ax = _aeOrreryAxes(sc), K = AE_SUN_SHOW_DIST / _solarSqueeze(1), azel = _aeAzElOf(ax.z);
  var tanHalf = Math.tan(_aeRad(AE_FOV_DEG) / 2);
  var shift = _aeAdd(_aeScale(ax.x, (o.cam.x - 0.5) * K), _aeScale(ax.y, -(o.cam.y - 0.5) * K));
  return { tp: _aeAdd(_aeSunShown(sc), shift), az: azel.az, el: azel.el, dist: K / (2 * tanHalf * o.cam.zoom), tanHalf: tanHalf, roll: 0, frame: hand.frame, orrery: true };
}
// The camera `e` of the way from the orrery's (a) to the view's (b). The body the view is at goes from where the drawing
// has it to the middle of the picture in a straight line on the screen while the distance shrinks (the look-at point is
// placed so that: its offset from the body is the distance's share of the way, times what is left of the trip), the
// picture tilts from above the ecliptic to the view's own side, and the frame opens from the canvas to the whole view.
function _aeOrreryBlend(a, b, e) {
  var dist = _aeLogLerp(a.dist, b.dist, e), k = (1 - e) * dist / a.dist;
  return {
    tp: [b.tp[0] + (a.tp[0] - b.tp[0]) * k, b.tp[1] + (a.tp[1] - b.tp[1]) * k, b.tp[2] + (a.tp[2] - b.tp[2]) * k],
    az: a.az + _aeAngleDeltaRad(a.az, b.az) * e,
    el: _aeLerp(a.el, b.el, e),
    dist: dist,
    tanHalf: _aeLogLerp(a.tanHalf, b.tanHalf, e),
    roll: a.roll + _angleDelta(a.roll, b.roll) * e,
    frame: e >= 1 ? b.frame : _aeLerpFrame(a.frame, b.frame, _aeOrreryFrameE(e))
  };
}
// How open the frame is when the camera is `e` of the way: ahead of it, so the picture fills the screen while the body is
// still coming near, not after.
function _aeOrreryFrameE(e) { return _aeSmoother(Math.min(1, e * AE_ORR_FRAME_LEAD)); }

// A frame of the lift or the settle, `t` of the way (0 the flat drawing, 1 the view): the 3D drawing fades in over the flat
// one in the first part with the camera still; then the camera goes (h.e, what the blend reads), the page dims behind
// the frame as it opens, and the controls come up at the end. The view is clipped to the frame, rounded as the canvas is.
// Under reduced motion it is a cross-fade of the whole view over the page, no flight.
function _aeOrreryApply(h, t) {
  h.t = t;
  var st = _ae.el.style, camE = h.xfade ? 1 : _aeSmoother(_aeClamp((t - AE_ORR_CAM_FROM) / (1 - AE_ORR_CAM_FROM), 0, 1));
  h.e = camE;
  _aeFadeU.value = 1;
  st.opacity = String(h.xfade ? t : _smoothstep(0, AE_ORR_FADE, t));
  st.backgroundColor = 'rgba(0,0,0,' + _aeOrreryFrameE(camE).toFixed(3) + ')';
  st.setProperty('--ae-ui', h.xfade ? '1' : String(_smoothstep(AE_HAND_UI_FROM, 1, camE)));
  if (h.xfade) _aeStyleOff(_ae.el, 'clip-path');
  else {
    var f = _aeLerpFrame(h.frame, null, _aeOrreryFrameE(camE));
    st.clipPath = 'inset(' + [f.y, _ae.w - f.x - f.w, _ae.h - f.y - f.h, f.x].map(function (n) { return Math.max(0, n).toFixed(2) + 'px'; }).join(' ') +
      ' round ' + (AE_ORR_CORNER_PX * (1 - _aeOrreryFrameE(camE))).toFixed(2) + 'px)';
  }
  _ae.dirty = true;
}

// A hand-over with the orrery's frame and camera, `dir` 1 in and -1 out; its `done` runs when the last frame is drawn.
function _aeOrreryHand(o, dir, t0, done) {
  var xfade = _aeReduceMotion();
  var h = {
    dir: dir, start: performance.now(), ms: xfade ? AE_HAND_XFADE_MS : AE_ORR_HAND_MS, frame: o.frame, orrery: { cam: o.cam },
    daz: 0, del: 0, e0: t0, e: 0, t: t0, xfade: xfade, farHint: 0, done: done
  };
  _ae.hand = h;
  h.farHint = _aeOrreryCam(_ae.scene, h).dist;   // the far plane reaches the camera's distance over the Sun, and past it
  _ae.el.classList.add('ae-hand');
  return h;
}

// In: the view opens on the body the orrery was tapped at (`_aeOpenTarget`), its final camera taken at once (no flight:
// the lift is the flight), and the first frame is the drawing's. Returns false when the drawing is not there to lift from
// (the view then opens as it always did).
function _aeOrreryIn() {
  var o = _aeOrreryFrame();
  if (!o) return false;
  _aeStartAtHere();
  _ae.dist = _aeFitDist(AE_FIT_EARTH);
  _ae.snapFly = true;
  try {
    _aePreset(_aeOpenTarget);
    // A body not known yet (a dwarf planet before its table has come): the view ends on the whole system, and goes on
    // to the body when it has come.
    if (_ae.target !== _aeOpenTarget && _aeOpenTarget !== 'earth') _aePreset('planets');
  } finally { _ae.snapFly = false; }
  _ae.fly = null;
  var h = _aeOrreryHand(o, 1, 0, function () { _aeCoverAlmanac(true); });
  _aeOrreryApply(h, 0);
  // The first frame now: the flat drawing's, over the same pixels; the page stays under the clipped view until the end.
  _aeDraw(performance.now(), true);
  _aeKick();
  return true;
}

// Out: the view settles onto the page's orrery, which is brought on screen first, at rest and at the page's moment. False
// when it is not there (the view then closes as it would).
function _aeOrreryOut() {
  var o = typeof _orreryHandBack === 'function' ? _aeOrreryFrame(_orreryHandBack()) : null;
  if (!o) return false;
  var was = _ae.hand;
  _aeFrom = 'orrery';
  _ae.fromHero = false;
  _aeOrreryHand(o, -1, was ? was.t : 1, _aeFinishClose);
  _ae.pointers = {}; _ae.drag = _ae.pinch = null;
  _aeShowSettings(false);
  _aeCoverAlmanac(false);
  _aeKick();
  return true;
}

// Pulling the Planets view out past its own fit: it settles onto the orrery (it is the same picture, further away).
function _aeOrreryPullCheck() {
  if (_ae.hand || _ae.fly || _ae.preset !== 'planets' || _ae.target !== 'sun') return;
  if (_ae.dist < _aeFitDist(_aeShownDist(AE_PLANETS_OUTER_AU)) * AE_ORR_PULL_FIT) return;
  _aeClose(true);
}
