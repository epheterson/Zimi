// ── Almanac: Stand at the pad ──
// Stand on the ground near a launch pad at T minus 30 seconds and watch the vehicle go: the count, ignition with flame and a
// ground cloud, hold-down release, the climb past the tower, the pitch-over and the plume lengthening into the sky.
//
// Nothing here is a second copy of anything. The ground, the sky, the light and the hand-off are the site visits' (almanac-sites.js
// over Stand's ground, almanac-standhost.js); the vehicle is the mission player's (almanac-missions.js: its parts, its flames,
// its event times and, above all, its trajectory: where the rocket is at each second is the mission's own table, read here in
// the pad's east-north-up frame); the pad is the site models (craft-site-pad39a, the slab) or, for a pad without one, a few boxes
// (_pvTowerGeometry). This file holds only what joins them: the viewing spot and its camera, the first seconds of the climb the
// table is too coarse for, the count, the exhaust and the controls. It loads when someone taps "Stand at the pad", never with the view.
//
// Shares the Almanac's global scope; every name here is _pv*, PV_* or _aePad*.

var PV_MISSIONS_JS = _almAsset('/static/almanac-missions.js'), PV_LAUNCH_JS = _almAsset('/static/almanac-sites-launch.js');
var PV_COUNT_S = 30;                       // the view opens this long before zero
var PV_TOWER_CLEAR_M = 122;                // the umbilical tower's height at LC-39A: the vehicle clears it when its base passes this (published, in the Almanac's constants)
var PV_VEHICLE_FRAME_SHARE = 0.13;         // the vehicle fills this share of the screen's height at the start
var PV_FOV_MIN_DEG = 1.5, PV_FOV_MAX_DEG = 70, PV_FOV_REF_DIST = 100;   // the field's range; a pinch scales it (the site's own distance is the zoom)
var PV_FOLLOW_EASE = 1.7, PV_FOLLOW_RETURN_S = 2.5;   // 1/s: how the view turns after the vehicle; seconds after a finger before it does again
var PV_FOLLOW_LOW_SHARE = 0.16;            // the vehicle rides this share of the field below the middle, the sky ahead of it above
var PV_HORIZON_SHARE = 0.1;               // at the start the horizon stands this share of the field above the bottom
var PV_EARLY_AFTER_S = 15;                 // the climb is fitted up to the first table row this long after lift-off
var PV_STILL_MS = [4, 60];                 // below the first speed the vehicle points up, above the second along its path (the mission player's rule, in m/s)
var PV_CORE_RGB = [1, 0.97, 0.84], PV_CORE_WIDTH = 0.42, PV_CORE_LENGTH = 0.9;   // the flame's white-hot core: its colour, and its width and length against the outer flame's
var PV_FLAME_FALLOFF = '1.1';              // the flame's brightness along its length (the mission's cone: 2)
var PV_FLAME_RAMP_S = 2.5;                 // the engines come up to full flame over this long after ignition
var PV_SMOKE_MAX = 3000, PV_FLAME_MAX = 600;
var PV_FLAME_RATE = 280, PV_PAD_CLOUD_RATE = 70;   // puffs a second at full flame
var PV_CLOUD_ALT_M = [25, 300];            // the cloud at the pad gives way to a trail between these heights
var PV_CLOUD_SPREAD_RAD = 0.55;             // how far the cloud's directions scatter about the line across the view
var PV_LOW_TRAIL_M = 1500, PV_LOW_TRAIL_EXTRA = 1.2;   // near the ground the trail is denser and its puffs bigger (the smoke before it thins to a contrail)
var PV_GLOW_S = 14;                         // the flame lights the cloud at the pad for this long after lift-off
var PV_BACK_TOL_S = 2, PV_JUMP_S = 12, PV_STEP_MAX_S = 3;   // a step back in time under the first, or forward under the second, is the clock running (a hitch at 4x, or the pause dropping the clock's extrapolated step), not a jump; one frame advances the exhaust by at most the third
var PV_TRAIL_JUMP_M = 5000;                // a flame this far from where it was last frame was moved, not flown: no trail between
var PV_TRAIL_END_ALT_M = 30000, PV_TRAIL_SPACING_M = 12, PV_TRAIL_MAX_MS = 700;
var PV_SHAKE_S = 14, PV_SHAKE_SHARE = 0.006;   // seconds of tremor after lift-off, and its size as a share of the field
var PV_HUD_ID = 'pv-hud', PV_CSS_ID = 'pv-css', PV_WATCH_MS = 500, PV_EVENT_SHOW_S = 4;
var PV_PACES = [1, 0.25, 4];
var PV_STEPS_M = [1, 0.5, 0.2, 2];            // the viewing distance as a share of the pad's, each press of "closer"
var PV_THREE_NORMAL = 1, PV_THREE_ADDITIVE = 2, PV_FLAME_DAY_LIT = 0.15;   // three's blending constants; the Sun's share of light above which a flame is drawn over the sky
var PV_CLEAR_SEARCH_S = 60, PV_CLEAR_STEP_S = 0.1;   // where to look for the moment the tower is cleared
var PV_PRELOAD_S = 400;                    // the models of what flies in the first minutes load with the pad, not at their stage

// ── The pads ──
// One row per launch that can be stood at. viewM: where to stand (the press site's distance for a vehicle of that class: about
// 5 km for a Saturn V, nearer for the smaller ones); bearing: from the pad to the viewer, degrees from north; deckM: the vehicle's
// base over the ground; cloud: the size of the cloud at the pad against a Saturn V's; heightM: the stack, for the field of view; midM: its middle along the nose from the vehicle's own origin (the
// Atlas V's origin is its spacecraft, at the top); tower: which pad (the site models, or boxes).
var PV_PADS = {
  apollo11: { mission: 'apollo11', name: 'Apollo 11', pad: 'LC-39A', deckM: 5, heightM: 111, midM: 50, baseM: -3.5, towerM: AE_SITE_FACTS.launchTowerM, viewM: 2500, fieldM: 5000, bearing: 200, tower: 'lc39a', cloud: 1, shake: 1, flameK: 3.6, flameW: 2.2 },
  perseverance: { mission: 'perseverance', name: 'Perseverance', pad: 'SLC-41', deckM: 14.3, heightM: 58, midM: -24, baseM: -49, towerM: 68, viewM: 4000, bearing: 215, tower: 'slc41', cloud: 0.45, shake: 0.4, flameK: 1.3, flameW: 1.3 }
};
var PV_SITE_TOWERS = {   // the site models of a pad (almanac-sites.js): parts of the visit's own definition
  lc39a: [{ m: 'pad-slab', x: 0, y: 0, h: 0, noShadow: 1 }, { m: 'pad39a', x: 0, y: 0, h: 0 }],
  slc41: []
};

var _pv = null;   // the view being shown: { id, cfg, m, P (the pad's frame and fit), st (the site), ... }

// ── Loading ──
function _pvLoadScript(src, ready) {
  if (ready()) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = function () { s.remove(); reject(new Error(src)); };
    document.head.appendChild(s);
  });
}
var PV_WAIT_MS = 50, PV_WAIT_TRIES = 400;
function _pvWaitFor(test) {
  return new Promise(function (resolve) { var n = 0; (function wait() { if (test()) resolve(); else if (++n < PV_WAIT_TRIES) setTimeout(wait, PV_WAIT_MS); else resolve(); })(); });
}
// What the view stands on: the mission player's tables and functions, the exhaust's puff helpers, the site visits (almanac-sites.js
// with the Earth's landmark rows they key on) and Stand's ground.
function _pvLoadAll() {
  return _pvLoadScript(PV_MISSIONS_JS, function () { return typeof _amLoad === 'function'; })
    .then(function () { return new Promise(function (r) { _amLoad(r); }); })
    .then(function () { return _pvLoadScript(PV_LAUNCH_JS, function () { return typeof _asPuffs === 'function'; }); })
    .then(function () { _aeSitesLoad(); _aeLmLoad(); return _aeStandReady(); })
    .then(function () { return _pvWaitFor(function () { return typeof _asData !== 'undefined' && _asData && _aeLm; }); });
}

// ── Geometry: the pad's frame ──
var PV_WGS_A = 6378.137, PV_WGS_F = 1 / 298.257223563;
// A point in the Earth-fixed frame (km) to its geodetic latitude and longitude (degrees): Bowring's iteration.
function _pvGeodetic(p) {
  var e2 = PV_WGS_F * (2 - PV_WGS_F), r = Math.hypot(p[0], p[1]), lat = Math.atan2(p[2], r * (1 - e2)), h = 0;
  for (var i = 0; i < 6; i++) { var s = Math.sin(lat), n = PV_WGS_A / Math.sqrt(1 - e2 * s * s); h = r / Math.cos(lat) - n; lat = Math.atan2(p[2] + e2 * n * s, r); }
  return { lat: lat * 180 / Math.PI, lon: Math.atan2(p[1], p[0]) * 180 / Math.PI, h: h };   // h: km over the ellipsoid
}
// East, north and up (unit, Earth-fixed) at a geodetic place.
function _pvEnuAxes(lat, lon) {
  var a = lat * Math.PI / 180, o = lon * Math.PI / 180, sa = Math.sin(a), ca = Math.cos(a), so = Math.sin(o), co = Math.cos(o);
  return { e: [-so, co, 0], n: [-sa * co, -sa * so, ca], u: [ca * co, ca * so, sa] };
}
function _pvToEnu(P, v, scale) {
  var a = P.axes;
  return [_aeDot(v, a.e) * scale, _aeDot(v, a.n) * scale, _aeDot(v, a.u) * scale];
}

// ── The trajectory: the mission's table, and the first seconds ──
// The leg of the vehicle that holds the pad (an Earth-fixed table) at table time t, in the pad's frame (metres over the ground
// under the pad, m/s). A vehicle's own origin is not always its foot (the Atlas V's is its spacecraft, 47 m up), so the table
// begins where it begins, z0 over the pad's ground, and its parts hang from there.
function _pvTable(P, leg, t) {
  var s = leg.s, r = _amTable(s, Math.min(s[s.length - 1][0], Math.max(s[0][0], t)));
  return { p: _pvToEnu(P, _aeSub(r.p, P.foot), 1000), v: _pvToEnu(P, r.v, 1000) };
}
// The table is a row every ten to twenty seconds: right for the climb, too coarse for the moment the vehicle leaves the pad (a cubic
// through its first rows lifts it before the engines are lit). From lift-off to the first row after PV_EARLY_AFTER_S the climb is
// fitted to that row's position and speed: straight up with a constant jerk, and the downrange drift a power of the time that is
// still near nothing at the tower and meets the table's drift where the pitch program has taken hold.
function _pvEarlyFit(P, leg) {
  var s = leg.s, i = 0;
  while (i < s.length - 1 && s[i][0] < P.tLift + PV_EARLY_AFTER_S) i++;
  var t1 = s[i][0], r = _pvTable(P, leg, t1), tau = t1 - P.tLift, up = r.p[2] - P.z0;
  var fit = { t1: t1, tau: tau, A: 6 * up / (tau * tau) - 2 * r.v[2] / tau, J: 6 * (r.v[2] - 2 * up / tau) / (tau * tau), h: [r.p[0], r.p[1]], m: 0 };
  var ph2 = r.p[0] * r.p[0] + r.p[1] * r.p[1];
  if (ph2 > 1) fit.m = Math.max(3, Math.min(8, (r.v[0] * r.p[0] + r.v[1] * r.p[1]) / ph2 * tau));
  return fit;
}
function _pvEarlyAt(P, t) {
  var f = P.fit, tau = t - P.tLift, u = tau / f.tau, k = f.m ? Math.pow(u, f.m) : 0, dk = f.m ? f.m * Math.pow(u, f.m - 1) / f.tau : 0;
  return { p: [f.h[0] * k, f.h[1] * k, P.z0 + 0.5 * f.A * tau * tau + f.J * tau * tau * tau / 6], v: [f.h[0] * dk, f.h[1] * dk, f.A * tau + 0.5 * f.J * tau * tau] };
}
// Where a vehicle is at mission time t in the pad's frame: { p (m), v (m/s) } or null when it is not in the first leg's frame.
function _pvVehicleAt(P, veh, t) {
  if (veh === P.stack && t < veh.on) t = veh.on;   // it stands on the pad before its table begins
  if (t < veh.on || t > veh.off) return null;
  var leg = _amLegAt(veh, t);
  if (leg.frame !== 'ecef') return null;
  if (veh === P.stack && t < P.fit.t1) return t <= P.tLift ? { p: [0, 0, P.z0], v: [0, 0, 0] } : _pvEarlyAt(P, t);
  return _pvTable(P, leg, t);
}
// The vehicle's basis (x across, y along its nose, z the way its belly looks) in the pad's frame: the nose along the path once it is
// moving, up while it stands; z is up turned away from the nose, and when the nose is vertical the way back along the launch azimuth.
function _pvBasis(P, v) {
  var sp = Math.hypot(v[0], v[1], v[2]), go = _amSmooth(PV_STILL_MS[0], PV_STILL_MS[1], sp), up = [0, 0, 1];
  var f = sp > 1e-9 ? _aeNorm(_aeAdd(_aeScale(v, go / sp), _aeScale(up, 1 - go))) : up;
  var z = _aeSub(up, _aeScale(f, _aeDot(up, f)));
  z = _aeLen(z) < 1e-6 ? _aeScale(P.heading, -1) : _aeNorm(z);
  return { x: _aeCross(f, z), y: f, z: z };
}
function _pvLocal(b, v) {
  return [b.x[0] * v[0] + b.y[0] * v[1] + b.z[0] * v[2], b.x[1] * v[0] + b.y[1] * v[1] + b.z[1] * v[2], b.x[2] * v[0] + b.y[2] * v[1] + b.z[2] * v[2]];
}

// The count as the clock reads it: T-0:30 before zero, T+0:12 after (hours only when there are some).
function _pvCountText(t) {
  var s = Math.abs(Math.round(t)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60, two = function (n) { return (n < 10 ? '0' : '') + n; };
  return (t < 0 ? 'T−' : 'T+') + (h ? h + ':' + two(m) : m) + ':' + two(sec);
}

// The mission's pieces for the pad: the vehicles that begin in the Earth-fixed frame, the pad's own place, the lift-off.
function _pvPrepare(cfg) {
  var m = _amData.missions[cfg.mission], stack = m.vehicles[0], leg0 = stack.legs[0];
  var p0 = [leg0.s[0][1], leg0.s[0][2], leg0.s[0][3]], g = _pvGeodetic(p0), ax = _pvEnuAxes(g.lat, g.lon);
  var lift = m.events.filter(function (e) { return e.k === 'alm_ms_ev_liftoff'; }).pop();
  var P = { m: m, stack: stack, p0: p0, foot: _aeSub(p0, _aeScale(ax.u, g.h)), z0: g.h * 1000, lat: g.lat, lon: g.lon, axes: ax, tLift: lift ? lift.t : 0, heading: [1, 0, 0] };
  P.fit = _pvEarlyFit(P, leg0);
  // The launch azimuth from the table itself: the downrange direction of the first rows after the climb has begun.
  var r = _pvTable(P, leg0, P.fit.t1 + 60), hl = Math.hypot(r.p[0], r.p[1]);
  if (hl > 1) P.heading = [r.p[0] / hl, r.p[1] / hl, 0];
  P.azimuth = (Math.atan2(P.heading[0], P.heading[1]) * 180 / Math.PI + 360) % 360;
  P.vehicles = m.vehicles.filter(function (v) { return v.legs[0].frame === 'ecef' && v.legs[0].ref === 'earth'; });
  // The mission's own events, and one of the pad's: the moment the vehicle's foot passes the top of the tower.
  P.events = m.events.map(function (e) { return { t: e.t, text: e.en === 'Ignition' ? 'alm_pad_ignition' : e.k, en: e.en }; });
  for (var t = P.tLift; t < P.tLift + PV_CLEAR_SEARCH_S; t += PV_CLEAR_STEP_S) {
    var s = _pvVehicleAt(P, stack, t);
    if (s && cfg.deckM + s.p[2] - P.z0 + cfg.baseM >= cfg.towerM) { P.events.push({ t: t, text: 'alm_pad_cleared', en: 'Tower cleared' }); P.clearS = t; break; }
  }
  P.events.sort(function (a, b) { return a.t - b.t; });
  return P;
}

// ── Entry ──
// Stand at the pad of a mission's launch: id is a PV_PADS key; opts: { back: { where: the name the Back arrow gives, go: function }, atS: seconds from zero (default -PV_COUNT_S) }.
function _aePadStart(id, opts) {
  var cfg = PV_PADS[id];
  if (!cfg || (_pv && _pv.id === id && _ae && _ae.site === _pv.st)) return Promise.resolve(false);
  if (typeof _aeIsOpen === 'undefined' || !_aeIsOpen) { openAlmanacEarth({ target: 'earth' }); }
  return _pvWaitOpen().then(function () { return _pvLoadAll(); }).then(function () {
    if (!_ae || !_ae.gl || typeof _asData === 'undefined' || !_asData) return false;
    if (_ae.mission) _amStop(true);
    if (_ae.stand && typeof _aeStandClose === 'function') _aeStandClose();
    _pvTeardown();
    var P = _pvPrepare(cfg), o = opts || {}, t0 = o.atS == null ? -PV_COUNT_S : o.atS;
    P.vehicles.forEach(function (veh) { veh.parts.forEach(function (pd) { if (pd.from == null || pd.from < t0 + PV_PRELOAD_S) _aeCraftLoad(pd.m); }); });
    var def = { name: cfg.name + ' ' + cfg.pad, body: 'earth', pad: { lat: P.lat, lon: P.lon }, flat: [95, 170], parts: (PV_SITE_TOWERS[cfg.tower] || []).map(function (p) { return Object.assign({}, p); }),
      view: { dist: 100, el: 0.1, focus: cfg.heightM / 2 } };
    _asData.sites = _asData.sites.filter(function (s) { return s.name !== def.name; });
    _asData.sites.push(def);
    var row = [def.name, P.lat, P.lon, 'launch', '', 0, 5, 10050];
    _pv = { id: id, cfg: cfg, m: P.m, P: P, def: def, row: row, t0: t0, zeroMs: P.m.zeroMs, back: o.back || null, parts: [], flames: [], fx: null, ready: false, started: false, lastT: null, eventAt: -1e9,
      eye: { dist: cfg.viewM, step: 0 }, userAt: -1e9, pace: 0, last: 0 };
    _aeGoTo(_pv.zeroMs + t0 * 1000);
    if (typeof _almClockSetRate === 'function') _almClockSetRate(0);
    _aeSiteVisit('earth', row, false);
    var st = _pv.st = _ae.site;
    if (!st) return false;
    st.camOverride = _pvCamera;
    st.pvActive = true;
    st.camera.dist = PV_FOV_REF_DIST; st.distMax = PV_FOV_REF_DIST * PV_FOV_MAX_DEG / 6;
    _pvHud(true);
    _pv.watch = setInterval(_pvWatch, PV_WATCH_MS);
    return true;
  });
}
function _pvWaitOpen() {
  return new Promise(function (resolve) {
    var n = 0;
    (function wait() { if (typeof _aeReady === 'function' && _aeReady() && _aeIsOpen && !_ae.fly) resolve(); else if (++n < 600) setTimeout(wait, 100); else resolve(); })();
  });
}
// The view is the site's: when the site is gone (the close button, the Back arrow, the 3D view shut), so is everything here.
function _pvWatch() {
  if (!_pv) return;
  if (!_ae || !_ae.site || _ae.site !== _pv.st) _pvTeardown();
}
function _pvTeardown() {
  var v = _pv;
  if (!v) return;
  _pv = null;
  clearInterval(v.watch);
  var hud = _aeById(PV_HUD_ID);
  if (hud) hud.remove();
  if (_ae && _ae.el) _ae.el.classList.remove('ae-pad');
  [v.fx && v.fx.flame, v.fx && v.fx.smoke].forEach(function (P) { if (P && P.mesh.parent) P.mesh.parent.remove(P.mesh); if (P) P.geo.dispose(); });
  v.flames.forEach(function (f) { if (f.parent) f.parent.remove(f); f.geometry.dispose(); f.material.dispose(); });
  if (v.tower && v.tower.parent) { v.tower.parent.remove(v.tower); v.tower.geometry.dispose(); v.tower.material.dispose(); }
  if (v.st && v.st.camOverride === _pvCamera) v.st.camOverride = null;
  if (v.st) v.st.pvActive = false;
  if (_asData && v.def) _asData.sites = _asData.sites.filter(function (s) { return s !== v.def; });
}
// Leave for where the person came from: the Back arrow's own act.
function _pvBack() {
  var v = _pv;
  if (!v) return;
  var go = v.back && v.back.go;
  _aeSiteLeave(true);
  _pvTeardown();
  if (go) go(); else { _aePreset('earth'); }
}
function _pvBackLabel() {
  var where = _pv && _pv.back && _pv.back.where || _aeInfoName('earth');
  return _aeT('alm_pad_back', { where: where });
}

// ── The parts: the vehicle's, from the mission, standing in the site's group ──
// Each frame: every vehicle's part placed where the mission says, the flames after it.
function _pvPlace(t) {
  var v = _pv, st = v.st, P = v.P, ground = _asGroundAt(st, 0, 0, false), base = ground + v.cfg.deckM;
  v.flameAt = null;
  P.vehicles.forEach(function (veh) {
    var state = _pvVehicleAt(P, veh, t);
    if (veh === P.stack && state) { var bs = _pvBasis(P, state.v), c = _pvLocal(bs, [0, v.cfg.midM, 0]); v.follow = [state.p[0] + c[0], state.p[1] + c[1], base + state.p[2] + c[2]]; }
    veh.parts.forEach(function (pd, i) {
      var key = veh.id + ':' + i, e = v.parts[key];
      var live = !!(state && (pd.from == null || t >= pd.from) && (pd.to == null || t < pd.to));
      if (e) e.live = live;
      if (!live) return;
      if (!e) {
        if (!_asModelReady(st, pd.m)) { v.waiting = true; return; }
        e = v.parts[key] = { p: _asPartAdd(st, pd.m, 0, 0, 0, {}), live: true };
      }
      var b = _pvBasis(P, state.v), pa = _amPartPose(pd, t), bp = pa.rx ? _amTurnX(b, pa.rx) : b;
      var o = _pvLocal(b, pa.at), h = e.p.holder;
      h.position.set(state.p[0] + o[0], state.p[1] + o[1], base + state.p[2] + o[2]);
      h.quaternion.setFromRotationMatrix(new _ae.gl.THREE.Matrix4().makeBasis(_pvV3(bp.x), _pvV3(bp.y), _pvV3(bp.z)));
      h.updateMatrix();
      var m = e.p.su.model.value, el = m.elements, mid = e.p.mid;
      m.copy(h.matrix);
      el[12] += el[0] * mid[0] + el[4] * mid[1] + el[8] * mid[2]; el[13] += el[1] * mid[0] + el[5] * mid[1] + el[9] * mid[2]; el[14] += el[2] * mid[0] + el[6] * mid[1] + el[10] * mid[2];
      e.p.su.ground.value = ground;
    });
    (veh.flames || []).forEach(function (f, fi) { _pvFlame(veh, f, fi, state, t, base); });
  });
}
// Called as the site draws (almanac-sites-ground.js _asPartsByTime): the parts that are not there at this instant are hidden.
function _pvShow(st) {
  var v = _pv;
  if (!v || v.st !== st) return;
  Object.keys(v.parts).forEach(function (k) {
    var e = v.parts[k];
    e.p.holder.visible = e.live;
    e.p.shadow.visible = e.live && st.shared.lit.value > 0.02;
  });
}
function _pvV3(a) { var T = _ae.gl.THREE; return new T.Vector3(a[0], a[1], a[2]); }
// A flame: the mission's cone, grown over PV_FLAME_RAMP_S from ignition and longer as the air thins.
function _pvFlame(veh, f, fi, state, t, base) {
  var v = _pv, st = v.st, key = veh.id + '#' + fi, F = v.flames[key], on = state && t >= f.from && t < f.to;
  if (!on) { if (F) F.visible = false; return; }
  if (!F) {
    F = v.flames[key] = _amFlameMesh(_ae.gl);
    _ae.gl.scene.remove(F); st.group.add(F);
    var core = F.userData.core = _amFlameMesh(_ae.gl);   // a narrower, whiter cone inside it: the flame's bright core
    core.material.uniforms.hot.value.set(PV_CORE_RGB[0], PV_CORE_RGB[1], PV_CORE_RGB[2]);
    _ae.gl.scene.remove(core); st.group.add(core);
    [F, core].forEach(function (m) {   // the mission's cone fades out within the first half of its length; a flame holds its brightness to near the tip
      m.material.fragmentShader = m.material.fragmentShader.replace('(1.0 - vK) * (1.0 - vK) * 0.7', 'pow(1.0 - vK, ' + PV_FLAME_FALLOFF + ') * 0.85').replace('vec3(1.0, 0.85, 0.55)', 'vec3(1.0, 0.97, 0.88)');   // white at the nozzles
      m.material.needsUpdate = true;
    });
    v.flames.push(F, core);
  }
  var b = _pvBasis(v.P, state.v), bf = f.rx ? _amTurnX(b, f.rx) : b, alt = Math.max(0, state.p[2]) / 1000;
  var ramp = _amSmooth(f.from, f.from + PV_FLAME_RAMP_S, t) * (0.9 + 0.1 * _amSmooth(f.from, f.from + 8, t));
  var vac = 1 + (f.vac || 0) * _amSmooth(0, 1, alt / (f.vacAlt || 120)), len = f.len * v.cfg.flameK * vac * ramp * (0.88 + 0.24 * Math.random());
  var o = _pvLocal(b, f.at);
  F.position.set(state.p[0] + o[0], state.p[1] + o[1], base + state.p[2] + o[2]);
  F.quaternion.setFromRotationMatrix(new _ae.gl.THREE.Matrix4().makeBasis(_pvV3(bf.x), _pvV3(bf.y), _pvV3(bf.z)));
  var core = F.userData.core, blend = st.shared.lit.value > PV_FLAME_DAY_LIT ? PV_THREE_NORMAL : PV_THREE_ADDITIVE;   // by day over the sky, by night added to it
  [[F, 1, 1], [core, PV_CORE_WIDTH, PV_CORE_LENGTH]].forEach(function (m) {
    var M = m[0], w = f.r * v.cfg.flameW * (0.6 + 0.4 * ramp) * m[1];
    M.position.copy(F.position); M.quaternion.copy(F.quaternion);
    M.scale.set(w, len * m[2], w);
    M.visible = ramp > 0.01;
    M.material.uniforms.fade.value = st.shared.fade.value;
    M.material.blending = blend;
    M.updateMatrix(); M.updateMatrixWorld();
  });
  if (veh === v.P.stack && fi === 0) v.flameAt = { p: F.position.clone(), power: ramp, dir: bf.y, speed: Math.hypot(state.v[0], state.v[1], state.v[2]), alt: Math.max(0, F.position.z - base) };
}

// ── The exhaust: flame sparks, the cloud at the pad, the trail ──
var PV_SMOKE_FRAG = [
  'uniform float fade, lit, ambient, glow; varying float vLife;',
  'void main() {',
  '  vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0;',
  '  if (r > 1.0) discard;',
  '  float a = (1.0 - r) * (1.0 - r);',
  '  vec3 col = vec3(0.93, 0.92, 0.9) * (0.32 + 0.68 * lit + ambient);',
  '  col = mix(col, vec3(1.0, 0.74, 0.46), 0.7 * glow * pow(vLife, 4.0));',   // a young puff is lit by the flame, an old one is just cloud
  '  gl_FragColor = vec4(sqrt(min(col, vec3(1.0))), fade * a * min(1.0, vLife * 1.7) * 0.55);',
  '}'
].join('\n');
// The flame's sparks: drawn over the sky, not added to it (against a morning sky an added flame vanishes into white).
var PV_FLAME_FRAG = [
  'uniform float fade; varying float vLife;',
  'void main() {',
  '  vec2 q = gl_PointCoord - 0.5; float r = dot(q, q) * 4.0;',
  '  if (r > 1.0) discard;',
  '  vec3 hot = mix(vec3(1.0, 0.36, 0.05), vec3(1.0, 0.92, 0.66), vLife * vLife);',
  '  gl_FragColor = vec4(hot, fade * pow(1.0 - r, 1.6) * min(1.0, vLife * 2.0) * 0.9);',
  '}'
].join('\n');
function _pvFx() {
  var v = _pv, st = v.st;
  if (v.fx) return v.fx;
  var rich = typeof ZimiCap === 'undefined' || ZimiCap.get('materialDetail') >= 1;   // a light device draws the flames and no cloud
  var smoke = rich ? _asPuffs(st, PV_SMOKE_MAX, PV_SMOKE_FRAG, false) : null;
  if (smoke) smoke.uni.glow = { value: 0 };
  var flame = _asPuffs(st, PV_FLAME_MAX, PV_FLAME_FRAG, false);
  v.fx = { smoke: smoke, flame: flame, acc: { flame: 0, cloud: 0, trail: 0 } };
  return v.fx;
}
function _pvFxReset() {
  var fx = _pv && _pv.fx;
  if (!fx) return;
  [fx.smoke, fx.flame].forEach(function (P) {
    if (!P) return;
    for (var i = 0; i < P.max; i++) { P.life[i] = 0; P.pos[i * 3 + 2] = -1e6; }
    P.geo.attributes.position.needsUpdate = true; P.geo.attributes.life.needsUpdate = true;
  });
}
// One puff of the cloud at the pad: it leaves the trench out to the left or right of the view (never toward the viewer, never in front of the
// vehicle), low and wide, a little way from the centre line, and stays under about a third of the stack.
function _pvPadPuff(P, v, ground) {
  var k = v.cfg.cloud, rr = Math.random, side = rr() < 0.5 ? 1 : -1, across = (v.cfg.bearing + 90 * side) * Math.PI / 180;
  var a = across + (rr() + rr() + rr() - 1.5) * PV_CLOUD_SPREAD_RAD, sp = (14 + rr() * 34) * k, off = (14 + rr() * 40) * k;
  _asPuffEmit(P, Math.sin(across) * off, Math.cos(across) * off, ground + 2 + rr() * 8 * k, Math.sin(a) * sp, Math.cos(a) * sp, (0.2 + rr() * 1.2) * k, (28 + rr() * 42) * k, (1.5 + rr() * 2.5) * k, 20 + rr() * 22);
}
// Advance the exhaust by sd simulated seconds with the flame as it stands now.
function _pvExhaust(sd, t) {
  var v = _pv, fx = _pvFx(), fa = v.flameAt;
  if (sd > 0 && fa && fa.power > 0.02) {
    var pw = fa.power, alt = fa.alt, dir = fa.dir, pos = fa.p, thin = 1 - Math.exp(-alt / 9000);
    fx.acc.flame += sd * PV_FLAME_RATE * pw; fx.acc.cloud += sd * PV_PAD_CLOUD_RATE * pw * (1 - _amSmooth(PV_CLOUD_ALT_M[0], PV_CLOUD_ALT_M[1], alt));
    // The trail: a puff every PV_TRAIL_SPACING_M of the way, from where the cloud at the pad gives way up to PV_TRAIL_END_ALT_M.
    fx.acc.trail += sd * Math.min(fa.speed, PV_TRAIL_MAX_MS) / PV_TRAIL_SPACING_M * pw * (1 + PV_LOW_TRAIL_EXTRA * (1 - _amSmooth(0, PV_LOW_TRAIL_M, alt))) * _amSmooth(PV_CLOUD_ALT_M[0], PV_CLOUD_ALT_M[1], alt) * (1 - _amSmooth(PV_TRAIL_END_ALT_M * 0.7, PV_TRAIL_END_ALT_M, alt));
    while (fx.acc.flame >= 1) {
      fx.acc.flame -= 1;
      var life = 0.25 + Math.random() * 0.3, sp = 120 + 300 * thin + Math.random() * 60, sd2 = 12 + 26 * thin, r = Math.random;
      _asPuffEmit(fx.flame, pos.x + (r() - 0.5) * 8, pos.y + (r() - 0.5) * 8, pos.z + (r() - 0.5) * 3, -dir[0] * sp + (r() - 0.5) * sd2, -dir[1] * sp + (r() - 0.5) * sd2, -dir[2] * sp + (r() - 0.5) * sd2, 7 + 6 * r(), -12, life);
    }
    if (fx.smoke) {
      var ground = _asGroundAt(v.st, 0, 0, false);
      while (fx.acc.cloud >= 1) {
        fx.acc.cloud -= 1;
        _pvPadPuff(fx.smoke, v, ground);
      }
      // Spread along the way the flame came this frame, each as old as the time since the vehicle was there: a fast frame is not a clump.
      var n = Math.floor(fx.acc.trail), from = fx.last && pos.distanceTo(fx.last) < PV_TRAIL_JUMP_M ? fx.last : pos;
      for (var j = 1; j <= n; j++) {
        var f = j / n, age = (1 - f) * sd, rr = Math.random;
        _asPuffEmit(fx.smoke, from.x + (pos.x - from.x) * f + (rr() - 0.5) * 6, from.y + (pos.y - from.y) * f + (rr() - 0.5) * 6, from.z + (pos.z - from.z) * f - dir[2] * 8, (rr() - 0.5) * 8, (rr() - 0.5) * 8, (rr() - 0.5) * 3, (26 + 18 * rr()) * (1 + 0.6 * (1 - _amSmooth(0, PV_LOW_TRAIL_M, alt))), 3.2 + 2 * rr(), 26 + 16 * rr());
        var i = (fx.smoke.next - 1) % fx.smoke.max;
        fx.smoke.age[i] = age; fx.smoke.life[i] = 1 - age / fx.smoke.maxLife[i]; fx.smoke.size[i] += fx.smoke.grow[i] * age;
      }
      fx.acc.trail -= n;
    }
  }
  fx.last = fa && fa.power > 0.02 ? fa.p : null;
  if (sd > 0) {
    _asPuffStep(fx.flame, sd, 0.8);
    if (fx.smoke) _asPuffStep(fx.smoke, sd, 0.12);
  }
  var pxr = _ae.h / 2 / Math.tan(_aeRad(_ae.gl.camera.fov) / 2) * _ae.gl.renderer.getPixelRatio();   // a point's size is in the drawing buffer's pixels
  fx.flame.uni.pxPerRad.value = pxr;
  if (fx.smoke) { fx.smoke.uni.pxPerRad.value = pxr; fx.smoke.uni.glow.value = _amSmooth(PV_GLOW_S, 0, t - v.P.tLift) * (fa ? Math.min(1, fa.power) : 0); }
}

// ── The camera and the step: once a frame ──
// The eye stands PV_.. from the pad on the bearing; a drag turns the head (the site's eye level), a pinch is the field of view. The
// head follows the vehicle up, easing, and leaves it to a finger for a few seconds.
function _pvEyePlace(v) {
  var st = v.st, c = v.cfg, d = v.eye.dist, b = c.bearing * Math.PI / 180, x = Math.sin(b) * d, y = Math.cos(b) * d;
  return { x: x, y: y, z: _asGroundAt(st, x, y, false) + AE_STAND_EYE_M };
}
function _pvFieldDeg(v) { return 2 * Math.atan(v.cfg.heightM / (2 * PV_VEHICLE_FRAME_SHARE * (v.cfg.fieldM || v.cfg.viewM))) * 180 / Math.PI; }   // from the pad's own viewing distance: walking nearer makes the vehicle larger, not the field wider
function _pvCamera(st, dt) {
  var v = _pv;
  if (!v || v.st !== st) return { pos: [0, 0, 20], focus: [0, 100, 20] };
  var e = st.eye, now = performance.now(), place = _pvEyePlace(v);
  if (!e || !e.on) e = st.eye = { on: true, x: place.x, y: place.y, yaw: 0, pitch: 0, motion: null };
  e.on = true;
  var t = (_aeDisplayMs() - v.zeroMs) / 1000;
  _pvTick(st, t, dt, now);
  // Where the head faces: the pad's stack at first (the horizon low in the picture), then the vehicle.
  var fov = _aeClamp(_pvFieldDeg(v) * st.camera.dist / PV_FOV_REF_DIST, PV_FOV_MIN_DEG, PV_FOV_MAX_DEG);
  var tgt = v.follow || [0, 0, v.cfg.heightM * 0.45], dx = tgt[0] - e.x, dy = tgt[1] - e.y, dz = tgt[2] - place.z;
  var wantYaw = Math.atan2(dx, dy), wantPitch = Math.atan2(dz, Math.hypot(dx, dy)) + (fov * Math.PI / 180) * PV_FOLLOW_LOW_SHARE;
  if (!v.aimed) { e.yaw = wantYaw; e.pitch = Math.max(wantPitch, (fov * Math.PI / 180) * (0.5 - PV_HORIZON_SHARE)); v.aimed = true; v.lastYaw = e.yaw; v.lastPitch = e.pitch; }
  if (Math.abs(e.yaw - v.lastYaw) > 1e-6 || Math.abs(e.pitch - v.lastPitch) > 1e-6) v.userAt = now;   // a finger (or the phone) turned it
  if (now - v.userAt > PV_FOLLOW_RETURN_S * 1000 && !e.motion) {
    var k = 1 - Math.exp(-PV_FOLLOW_EASE * dt * Math.max(1, Math.abs(typeof _almRate === 'number' ? _almRate : 1))), floor = (fov * Math.PI / 180) * (0.5 - PV_HORIZON_SHARE);
    e.yaw += _aeAngleDeltaRad(e.yaw, wantYaw) * k;
    e.pitch += (Math.max(wantPitch, floor) - e.pitch) * k;
  }
  v.lastYaw = e.yaw; v.lastPitch = e.pitch;
  e.x = place.x; e.y = place.y;
  var sh = _pvShake(v, t, fov * Math.PI / 180), yaw = e.yaw + sh[0], pitch = e.pitch + sh[1], cp = Math.cos(pitch), f = 100;
  return { pos: [e.x, e.y, place.z], focus: [e.x + Math.sin(yaw) * cp * f, e.y + Math.cos(yaw) * cp * f, place.z + Math.sin(pitch) * f], fov: fov };
}
// The ground's tremor in the view for the first seconds of the climb, a share of the field so it reads the same at any zoom; none for a person who asked for less motion.
function _pvShake(v, t, fovRad) {
  var s = t - v.P.tLift;
  if (s < 0 || s > PV_SHAKE_S || _aeReduceMotion()) return [0, 0];
  var a = PV_SHAKE_SHARE * fovRad * v.cfg.shake * _amSmooth(0, 0.8, s) * (1 - _amSmooth(PV_SHAKE_S * 0.3, PV_SHAKE_S, s));
  return [a * (Math.sin(s * 41) + 0.6 * Math.sin(s * 67.3)), a * (Math.sin(s * 47.7 + 1) + 0.6 * Math.sin(s * 59 + 2))];
}
// What the frame does besides the camera: the vehicle, the exhaust, the count, the clock's start.
function _pvTick(st, t, dt, now) {
  var v = _pv;
  if (st.phase !== 'stand' || !st.placed || !st.host || !st.host.live) return;
  if (!v.ready) {
    v.waiting = false;
    _pvPlace(t);
    if (!v.waiting) {
      v.ready = true;
      st.host.st.handoff = Object.assign(st.host.st.handoff || {}, { clouds: 'clear' });   // no weather is invented over a launch: the sky is the clear one
      if (!v.tower && !PV_SITE_TOWERS[v.cfg.tower].length) _pvTowerBuild(v);
      if (typeof _almClockSetRate === 'function') _almClockSetRate(PV_PACES[v.pace]);
      _ae.el.classList.add('ae-pad');
    }
    return;
  }
  _pvPlace(t);
  var sd = v.lastT == null ? 0 : t - v.lastT;
  if (sd < -PV_BACK_TOL_S || sd > PV_JUMP_S) { _pvFxReset(); sd = 0; v.flameAt = null; }   // a jump in time starts the exhaust over
  else sd = Math.max(0, Math.min(sd, PV_STEP_MAX_S));
  v.lastT = t;
  _pvExhaust(sd, t);
  _pvHudTick(t, now);
}

// ── A pad of boxes ──
// For a pad with no model of its own: the structures as boxes with published proportions, one mesh, lit by the site's Sun.
var PV_TOWER_VERT = 'attribute vec3 col; varying vec3 vCol; varying vec3 vN; void main() { vCol = col; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
var PV_TOWER_FRAG = 'uniform vec3 sun; uniform float lit, ambient, fade; varying vec3 vCol; varying vec3 vN; void main() { float d = max(dot(normalize(vN), sun), 0.0);' +
  ' vec3 c = vCol * (0.28 + ambient * 0.6 + 0.85 * d * lit); gl_FragColor = vec4(sqrt(min(c, vec3(1.0))), fade); }';
function _pvBox(out, cx, cy, z0, sx, sy, sz, col) {
  var x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z1 = z0 + sz;
  var faces = [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]],
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]]];
  faces.forEach(function (f) {
    var n = out.pos.length / 3;
    for (var i = 0; i < 4; i++) { out.pos.push(f[i][0], f[i][1], f[i][2]); out.nor.push(f[4][0], f[4][1], f[4][2]); out.col.push(col[0], col[1], col[2]); }
    out.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  });
}
// SLC-41 as it stands for an Atlas V: the mobile platform's deck and the umbilical tower on it, the four lightning masts round the pad. The
// figures are approximate and published in the Almanac's constants; a pad of its own model replaces this.
function _pvTowerGeometry(kind) {
  var out = { pos: [], nor: [], col: [], idx: [] }, steel = [0.55, 0.55, 0.57], conc = [0.62, 0.61, 0.58], red = [0.62, 0.2, 0.14];
  if (kind === 'slc41') {
    _pvBox(out, 0, 0, 0, 48, 40, 9, conc);          // the pad's apron
    _pvBox(out, 0, 0, 9, 22, 22, 3, steel);         // the mobile platform's deck, under the vehicle
    _pvBox(out, -9.5, 0, 12, 4.2, 4.2, 56, red);   // the umbilical tower beside it
    for (var k = 0; k < 5; k++) _pvBox(out, -9.5, 0, 22 + k * 10, 7, 6, 1, steel);   // its working levels
    [[-60, -50], [60, -50], [-60, 50], [60, 50]].forEach(function (p) { _pvBox(out, p[0], p[1], 0, 1.2, 1.2, 100, steel); });   // lightning masts
  }
  return out;
}
function _pvTowerBuild(v) {
  var st = v.st, T = _ae.gl.THREE, g = _pvTowerGeometry(v.cfg.tower), geo = new T.BufferGeometry();
  if (!g.idx.length) return;
  geo.setAttribute('position', new T.BufferAttribute(new Float32Array(g.pos), 3));
  geo.setAttribute('normal', new T.BufferAttribute(new Float32Array(g.nor), 3));
  geo.setAttribute('col', new T.BufferAttribute(new Float32Array(g.col), 3));
  geo.setIndex(g.idx);
  var mat = new T.ShaderMaterial({ uniforms: { sun: st.shared.sun, lit: st.shared.lit, ambient: st.shared.ambient, fade: st.shared.fade }, vertexShader: PV_TOWER_VERT, fragmentShader: PV_TOWER_FRAG });
  var mesh = new T.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.position.z = _asGroundAt(st, 0, 0, false);
  st.group.add(mesh);
  v.tower = mesh;
}

// ── The count and the controls ──
var PV_ICON = {
  restart: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5v14M19 6l-10 6 10 6z"/></svg>',
  closer: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  follow: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  pad: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5c2.6 2.6 3.4 6 2.4 9.5H9.6C8.6 8.5 9.4 5.1 12 2.5zM9.6 12l-2.1 4.5h9L14.4 12M8 20h8"/></svg>'
};
var PV_CSS = [
  '.ae-view.ae-pad #as-exit,.ae-view.ae-pad #as-rate,.ae-view.ae-pad #as-eye,.ae-view.ae-pad #as-cap,.ae-view.ae-pad #as-landing{display:none!important}',
  '.pv-hud{position:absolute;inset:0;z-index:60;pointer-events:none;display:none;font-variant-numeric:tabular-nums}',
  '.ae-view.ae-site .pv-hud{display:block}',
  '.pv-back{position:absolute;left:calc(12px + env(safe-area-inset-left));top:calc(env(safe-area-inset-top) + 12px);display:flex;align-items:center;gap:2px;height:34px;padding:0 14px 0 8px;border-radius:999px;border:1px solid var(--border);background:rgba(18,18,20,.82);color:var(--text2);font:inherit;font-size:13px;pointer-events:auto;cursor:pointer;max-width:calc(100% - 96px);white-space:nowrap}',
  '.pv-back span{overflow:hidden;text-overflow:ellipsis}',
  '.pv-clock{position:absolute;left:0;right:0;top:calc(env(safe-area-inset-top) + 60px);text-align:center;color:rgba(255,255,255,.92);text-shadow:0 1px 14px rgba(0,0,0,.65);pointer-events:none}',
  '.pv-clock b{display:block;font-size:42px;font-weight:300;letter-spacing:.02em;line-height:1.05}',
  '.pv-clock span{display:inline-block;margin-top:4px;padding:3px 12px;border-radius:999px;background:rgba(14,14,16,.6);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#fff;text-shadow:none}',
  '.pv-clock span:empty{display:none}',
  '.pv-ctl{position:absolute;left:0;right:0;bottom:calc(16px + env(safe-area-inset-bottom));display:flex;justify-content:center;align-items:center;gap:10px;pointer-events:none}',
  '.pv-ctl>*{pointer-events:auto}',
  '.pv-ctl .pv-pace{font-size:12px;min-width:44px;font-variant-numeric:tabular-nums}',
  '.pv-ctl .pv-follow{padding:0 14px}',
  '@media (orientation:landscape) and (max-height:520px){.pv-clock{top:calc(env(safe-area-inset-top) + 8px)}.pv-clock b{font-size:30px}}'
].join('');
function _pvHud(on) {
  var el = _ae && _ae.el;
  if (!el || !on) return;
  if (!document.getElementById(PV_CSS_ID)) { var css = document.createElement('style'); css.id = PV_CSS_ID; css.textContent = PV_CSS; document.head.appendChild(css); }
  var old = _aeById(PV_HUD_ID);
  if (old) old.remove();
  var hud = document.createElement('div'), lab = function (k) { return _almEsc(_aeT(k)); };
  hud.className = 'pv-hud'; hud.id = PV_HUD_ID;
  hud.innerHTML = '<button type="button" class="pv-back" id="pv-back">' + PV_ICON.back + '<span>' + _almEsc(_pvBackLabel()) + '</span></button>' +
    '<div class="pv-clock"><b id="pv-clock">T−0:30</b><span id="pv-event"></span></div>' +
    '<div class="pv-ctl"><button type="button" class="ae-btn ae-round" id="pv-restart" aria-label="' + lab('alm_pad_restart') + '" title="' + lab('alm_pad_restart') + '">' + PV_ICON.restart + '</button>' +
    '<button type="button" class="ae-btn ae-round" id="pv-play" aria-label="' + lab('alm_ms_play') + '"></button>' +
    '<button type="button" class="ae-btn ae-round pv-pace" id="pv-pace" aria-label="' + lab('alm_ms_pace') + '">×1</button>' +
    '<button type="button" class="ae-btn ae-round" id="pv-closer" aria-label="' + lab('alm_pad_closer') + '" title="' + lab('alm_pad_closer') + '">' + PV_ICON.closer + '</button>' +
    '<button type="button" class="ae-btn pv-follow" id="pv-follow" aria-label="' + lab('alm_pad_follow') + '" title="' + lab('alm_pad_follow') + '" hidden>' + PV_ICON.follow + '</button></div>';
  el.appendChild(hud);
  _aeById('pv-back').onclick = _pvBack;
  _aeById('pv-restart').onclick = function () { _pvRestart(); };
  _aeById('pv-play').onclick = function () { var r = typeof _almRate === 'number' ? _almRate : 1; _almClockSetRate(r === 0 ? PV_PACES[_pv.pace] : 0); _pvHudPlay(); };
  _aeById('pv-pace').onclick = function () { _pv.pace = (_pv.pace + 1) % PV_PACES.length; _almClockSetRate(PV_PACES[_pv.pace]); _pvHudPlay(); };
  _aeById('pv-closer').onclick = function () { _pvCloser(); };
  _aeById('pv-follow').onclick = function () { _pvFollowOn(); };
  _pvHudPlay();
}
function _pvHudPlay() {
  var p = _aeById('pv-play'), r = _aeById('pv-pace');
  if (p && typeof AM_ICONS !== 'undefined') p.innerHTML = (typeof _almRate === 'number' && _almRate === 0) ? AM_ICONS.play : AM_ICONS.pause;
  if (r && _pv) r.textContent = '×' + PV_PACES[_pv.pace];
}
function _pvRestart() {
  var v = _pv;
  if (!v) return;
  _aeGoTo(v.zeroMs + v.t0 * 1000);
  _almClockSetRate(PV_PACES[v.pace]);
  _pvFxReset(); v.lastT = null; v.flameAt = null; v.aimed = false; v.userAt = -1e9;
  _pvHudPlay();
}
// Walk nearer: the viewing distance steps down by PV_STEPS_M and the field widens to hold the vehicle.
function _pvCloser() {
  var v = _pv;
  if (!v) return;
  v.eye.step = (v.eye.step + 1) % PV_STEPS_M.length;
  v.eye.dist = v.cfg.viewM * PV_STEPS_M[v.eye.step];
  v.aimed = false;
  _ae.dirty = true; _aeKick();
}
var PV_FOLLOW_AFTER_S = 15;
function _pvEventText(e) { var s = _aeT(e.text); return s && s !== e.text ? s : e.en; }
function _pvHudTick(t, now) {
  var v = _pv, c = _aeById('pv-clock');
  if (!c) return;
  var txt = _pvCountText(t < 0 ? Math.ceil(t) : Math.floor(t));
  if (c.textContent !== txt) c.textContent = txt;
  // The mission's own event, quietly, for a few seconds after it.
  var ev = v.P.events.filter(function (e) { return e.t <= t && t - e.t < PV_EVENT_SHOW_S && e.t > v.t0; }).pop(), el = _aeById('pv-event');
  if (el) { var s = ev ? _pvEventText(ev) : ''; if (el.textContent !== s) el.textContent = s; }
  var fol = _aeById('pv-follow');
  if (fol) fol.hidden = t < v.P.tLift + PV_FOLLOW_AFTER_S;
  if (now - (v.hudAt || 0) > 400) { v.hudAt = now; _pvHudPlay(); }
}
// On from the pad into the mission's own flight: the player opens at this second, the way back the Back arrow's.
function _pvFollowOn() {
  var v = _pv;
  if (!v) return;
  var t = (_aeDisplayMs() - v.zeroMs) / 1000, id = v.cfg.mission, back = v.back;
  _aeSiteLeave(true);
  _pvTeardown();
  if (typeof _aeMissionOpen === 'function') _aeMissionOpen(id, t, true);
  if (back && typeof _ae !== 'undefined' && _ae) _ae.backLabel = back.where;
}
