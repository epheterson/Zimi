// ── Almanac: look around by turning the phone ──
// On the ground (almanac-stand.js, and a site's own camera: almanac-stand-host.js) a phone held up shows the view in the
// direction it points, as the Almanac's Look does for the sky: the heading and height come from almanac-look.js's own
// sensor reading (_lookReadOrientation: the compass on iOS, the absolute orientation elsewhere), loaded when the person
// first asks. iOS asks permission, and only in answer to a tap, so the choice is a button; it is kept, and a phone that
// needs no asking starts as it did last time. A finger still turns the view a little (a trim over what the phone says).
//
//   _aeMotionStart(owner)   begin reading; owner is an object with .motion put on it
//   _aeMotionView(owner)    { az, alt } in degrees as the view should face, or null before the first reading
//   _aeMotionTrim(owner, dx, dy, fovDeg, heightPx)   a finger's move, as a trim
//   _aeMotionStop(owner)

var AE_MOTION_KEY = 'zimi_ae_stand_motion';
var AE_MOTION_ALT_MAX = 89;
var AE_MOTION_LOOK_JS = '/static/almanac-look.js';
var _aeMotionLoading = null;

function _aeMotionAvailable() { return typeof DeviceOrientationEvent !== 'undefined' && window.isSecureContext !== false; }
function _aeMotionAsks() { return _aeMotionAvailable() && typeof DeviceOrientationEvent.requestPermission === 'function'; }
function _aeMotionKept() { try { return localStorage.getItem(AE_MOTION_KEY) === '1'; } catch (e) { return false; } }
function _aeMotionKeep(on) { try { localStorage.setItem(AE_MOTION_KEY, on ? '1' : '0'); } catch (e) {} }
// almanac-look.js (its sensor reading and smoothing), once.
function _aeMotionLoad() {
  if (typeof _lookReadOrientation === 'function') return Promise.resolve(true);
  if (_aeMotionLoading) return _aeMotionLoading;
  _aeMotionLoading = new Promise(function (resolve) {
    var load = typeof _loadScript === 'function' ? _loadScript(AE_MOTION_LOOK_JS) : new Promise(function (ok) {
      var s = document.createElement('script');
      s.src = AE_MOTION_LOOK_JS; s.onload = function () { ok(true); }; s.onerror = function () { ok(false); };
      document.head.appendChild(s);
    });
    load.then(function (ok) { resolve(!!ok && typeof _lookReadOrientation === 'function'); });
  });
  _aeMotionLoading.then(function (ok) { if (!ok) _aeMotionLoading = null; });
  return _aeMotionLoading;
}
// Ask (in the tap's own turn where the phone must be asked), then listen. Resolves true when the phone is being read.
function _aeMotionStart(owner) {
  if (owner.motion) return Promise.resolve(true);
  if (!_aeMotionAvailable()) return Promise.resolve(false);
  var asked = _aeMotionAsks() ? DeviceOrientationEvent.requestPermission().then(function (r) { return r === 'granted'; }, function () { return false; }) : Promise.resolve(true);
  return Promise.all([asked, _aeMotionLoad()]).then(function (r) {
    if (!r[0] || !r[1]) return false;
    var m = owner.motion = { sn: _lookNewSensing(), target: null, smooth: null, trim: { az: 0, alt: 0 }, last: 0, got: false };
    m.onAbs = function (e) { _aeMotionRead(m, e, true); };
    m.onRel = function (e) { _aeMotionRead(m, e, false); };
    window.addEventListener('deviceorientationabsolute', m.onAbs);
    window.addEventListener('deviceorientation', m.onRel);
    _aeMotionKeep(true);
    return true;
  });
}
function _aeMotionRead(m, e, absolute) {
  var r = _lookReadOrientation(m.sn, e, absolute);
  if (!r) return;
  m.target = r.view; m.got = true;
  if (typeof _ae !== 'undefined' && _ae) { _ae.dirty = true; if (typeof _aeKick === 'function') _aeKick(); }
}
function _aeMotionStop(owner, keep) {
  var m = owner.motion;
  if (!m) return;
  window.removeEventListener('deviceorientationabsolute', m.onAbs);
  window.removeEventListener('deviceorientation', m.onRel);
  owner.motion = null;
  if (!keep) _aeMotionKeep(false);
}
// Where the view should face now: the reading smoothed (a step per call, `now` in ms), plus the finger's trim.
function _aeMotionView(owner, now) {
  var m = owner.motion;
  if (!m || !m.got) return null;
  var dt = m.last ? Math.min(now - m.last, LOOK_MAX_STEP_MS) : 0;
  m.last = now;
  m.smooth = _lookSmooth(m.smooth, m.target, dt, LOOK_SMOOTH_TAU_MS);
  return { az: _lookNorm360(m.smooth.az + m.trim.az), alt: _lookClamp(m.smooth.alt + m.trim.alt, -AE_MOTION_ALT_MAX, AE_MOTION_ALT_MAX) };
}
function _aeMotionTrim(owner, dx, dy, fovDeg, heightPx) {
  var m = owner.motion;
  if (!m) return false;
  var k = fovDeg / heightPx;
  m.trim.az -= dx * k; m.trim.alt += dy * k;
  return true;
}
