// Missions flown end to end on the 3D view's own clock (almanac-earth.js): a list of them, a player with a timeline of named
// phases you can scrub and jump between, the vehicle drawn with its stages and burns, and a camera that tells each phase
// until a finger takes it over. Loaded the first time a mission is asked for, never with the view.
//
// A mission is data (static/earth/missions-v1.json, built by scripts/build_missions.py from the flight reports and JPL
// Horizons): vehicles, each a set of model parts on one or more legs of a path table, a window it exists in, the phases and the
// events. The path of a leg is [t, x, y, z, vx, vy, vz] (km, km/s, seconds from the mission's zero), cubic Hermite between
// rows, in one frame:
//   ecef   Earth-fixed (the climb from the pad and the fall to the sea: the pad stays under the rocket)
//   eci    Earth-centred, ecliptic J2000 (orbits, the translunar coast); near the Moon corrected onto the Moon as drawn
//   mcmf   Moon-fixed (the descent, the ground, the ascent: the landing site stays under the lander)
//   rel    centred on a planet (ecliptic J2000), `body` names it
//   mfix   fixed to a planet (`body`), for its entry and landing
//   probe  heliocentric, the probes' own tables (space-tracks-v1.json) by `key`
// A leg's rows may carry an up vector (cols 7-9) for the vehicles whose pointing is not along their velocity.

// ── Constants ──
var AM_DATA_URL = _almAsset('/static/earth/missions-v1.json');
var AM_MRE = 1 / (AE_EARTH_RADIUS_KM * 1000);               // one metre, in Earth radii
var AM_MOON_FIX_NEAR_KM = 40000, AM_MOON_FIX_FAR_KM = 150000;   // the Moon's correction is all the way in by the first, gone by the second
var AM_SEAM_DECAY_S = 600;                                  // a leg that begins off the end of the last one (two models of the Earth's turn) closes the gap over this long
var AM_CAM_EASE = 2.4;                                      // 1/s: the camera's pull to the shot of the phase
var AM_FOV_DEG = 40;
var AM_MARK_DX = 9, AM_MARK_DY = -7;                  // where the probe's name stands from its dot, in pixels
var AM_DOT_PX = 4.5, AM_DOT_OVERVIEW_PX = 9;   // the probe's dot: larger in the overview, where the arc is all there is to see it by
var AM_MODEL_PX = [5, 14];                                  // a model fades in across these widths, its dot out
var AM_TEXT_MS = 100;
var AM_TAP_PX = 8, AM_TAP_MS = 500;                       // a touch that moves less than the first and lets go sooner than the second is a tap
var AM_LINK_PACE = 1;                                      // an address's last field, once the speed button's step: kept at 1 so earlier links still open
var AM_FLAME_SEGS = 14;
var AM_FLAME_COLOR = [1.0, 0.5, 0.12];
var AM_ORBIT_EL = 1.45;                                     // how far over or under the camera may go (radians)
var AM_DRAG_RAD_PX = 0.0065, AM_WHEEL_ZOOM = 0.0015, AM_PINCH_MIN = 0.02;
var AM_DIST_MIN_M = 3;
var AM_NEAR_PER_FOCUS = 0.04;                               // the near plane stands off this share of the way to what is looked at
var AM_END_HOLD_S = 4;
var AM_THREE_ADDITIVE = 2;                                  // three's AdditiveBlending
var AM_THREE_DOUBLE_SIDE = 2;
var AM_STILL_KMS = [0.004, 0.06];                          // below the first speed (km/s) it points up, above the second along its path
var AM_KM_RE = 1 / AE_EARTH_RADIUS_KM;                     // one kilometre, in Earth radii
var AM_ORIGIN = [0, 0, 0];
var AM_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
var AM_CSS_ID = 'am-css';

// Missions in the order of the list. Names are in the interface's languages (alm_ms_<id>).
var AM_LIST = ['apollo11', 'perseverance', 'voyager1', 'voyager2'];   // and 'plan', the planner

var _amData = null, _amLoading = null;

// ── Pure maths (also run by the node tests) ──
function _amHerm(a, b, t) {
  var h = b[0] - a[0], u = h > 0 ? (t - a[0]) / h : 0, u2 = u * u, u3 = u2 * u, hh = h || 1;
  var h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  var d00 = (6 * u2 - 6 * u) / hh, d10 = 3 * u2 - 4 * u + 1, d01 = (-6 * u2 + 6 * u) / hh, d11 = 3 * u2 - 2 * u;
  var p = [0, 0, 0], v = [0, 0, 0];
  for (var k = 0; k < 3; k++) {
    p[k] = h00 * a[1 + k] + h10 * h * a[4 + k] + h01 * b[1 + k] + h11 * h * b[4 + k];
    v[k] = d00 * a[1 + k] + d10 * a[4 + k] + d01 * b[1 + k] + d11 * b[4 + k];
  }
  return { p: p, v: v };
}
// The pair of rows of a table that bracket t.
function _amBracket(s, t) {
  var lo = 0, hi = s.length - 1;
  if (hi < 1) return [s[0], s[0]];
  if (t <= s[0][0]) return [s[0], s[1]];
  if (t >= s[hi][0]) return [s[hi - 1], s[hi]];
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (s[mid][0] <= t) lo = mid; else hi = mid; }
  return [s[lo], s[hi]];
}
function _amTable(s, t) {
  var ab = _amBracket(s, t), r = _amHerm(ab[0], ab[1], t);
  if (ab[0].length >= 10) {
    var h = ab[1][0] - ab[0][0], u = h > 0 ? Math.min(1, Math.max(0, (t - ab[0][0]) / h)) : 0;
    r.up = [0, 1, 2].map(function (k) { return ab[0][7 + k] + (ab[1][7 + k] - ab[0][7 + k]) * u; });
  }
  return r;
}
function _amSmooth(a, b, x) { var u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); }
// The mission's phase at time t: the last that began.
function _amPhaseAt(m, t) {
  var at = 0;
  for (var i = 0; i < m.phases.length; i++) if (m.phases[i].t <= t + 1e-6) at = i;
  return at;
}
function _amPhaseEnd(m, i) { return i + 1 < m.phases.length ? m.phases[i + 1].t : m.end; }
// The timeline's position (0..1) of a time, and back: every phase takes a share of the width by its weight, so a minute of landing
// is not lost beside three days of coast.
function _amWidths(m) {
  var w = m.phases.map(function (p) { return Math.max(0.01, p.w || 1); }), sum = w.reduce(function (a, b) { return a + b; }, 0);
  return w.map(function (x) { return x / sum; });
}
function _amPosOf(m, t) {
  var w = _amWidths(m), i = _amPhaseAt(m, t), acc = 0, k;
  for (k = 0; k < i; k++) acc += w[k];
  var t0 = m.phases[i].t, t1 = _amPhaseEnd(m, i);
  return acc + w[i] * Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
}
function _amTimeOf(m, pos) {
  var w = _amWidths(m), acc = 0;
  for (var i = 0; i < w.length; i++) {
    if (pos <= acc + w[i] || i === w.length - 1) {
      var t0 = m.phases[i].t, t1 = _amPhaseEnd(m, i);
      return t0 + (t1 - t0) * Math.min(1, Math.max(0, (pos - acc) / w[i]));
    }
    acc += w[i];
  }
  return m.end;
}
// Mission elapsed time as T+h:mm:ss, with its sign.
function _amMet(t) {
  var neg = t < 0, s = Math.floor(Math.abs(t)), h = Math.floor(s / 3600), mi = Math.floor(s / 60) % 60, sec = s % 60;
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  return (neg ? 'T−' : 'T+') + h + ':' + two(mi) + ':' + two(sec);
}
// The real instant a mission time stands for, as it happened: the date and the minute, in UTC (the clock the missions kept).
function _amUtcText(m, t) {
  return _orrFormatter('am-utc', function (lang) {
    var o = { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' };
    try { return new Intl.DateTimeFormat(lang, o); } catch (e) { return { format: function (d) { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } }; }
  }).format(new Date(m.zeroMs + t * 1000));
}
// The pace beside the mission's clock, while it is not the real one ("T+102:45:40 · 10×").
function _amRateTail() { var r = typeof _almRate === 'number' ? _almRate : 1; return r && r !== 1 && typeof _almRateText === 'function' ? ' \u00b7 ' + _almRateText(r) : ''; }
function _amLegAt(veh, t) {
  var legs = veh.legs;
  for (var i = 0; i < legs.length; i++) if (t <= legs[i].s[legs[i].s.length - 1][0]) return legs[i];
  return legs[legs.length - 1];
}
// The text of a phase or an event: the interface's own if it has one, else the data's English.
function _amLabel(item) {
  var vars = item.planet && typeof _tp === 'function' ? { planet: _tp(item.planet) } : undefined;
  var s = typeof _aeT === 'function' && item.k ? _aeT(item.k, vars) : item.k;
  return s && s !== item.k ? s : item.en;
}

// ── The strip: the events along a line through NOW ──
// The line is laid out by event, not by time: each event stands one step from the next, however far apart they fell, and NOW stands between two of them, so the scale
// eases through a second of cutoff and ignition and a day of coast alike. The events that fell at the same moment keep the order the data gives them.
var AM_STRIP_LEAD_S = 10;     // before the first event the line begins this long before it (or at the mission's own start, if that is earlier)
var AM_STRIP_SNAP_STEP = 0.2; // a drag let go within this share of a step of an event lands on it
function _amStripEvents(m) { return m.strip || (m.strip = m.events.slice().sort(function (a, b) { return a.t - b.t; })); }
// The times either side of the place after event i: where the stretch between it and the next begins and ends (the line's lead before the first, the mission's end after the last).
function _amStripSpan(m, i) {
  var ev = _amStripEvents(m), n = ev.length;
  var a = i < 0 ? Math.min(m.start, m.phases[0].t, ev[0].t - AM_STRIP_LEAD_S) : ev[i].t;
  return [a, i + 1 < n ? ev[i + 1].t : Math.max(m.end, a + 1)];
}
// Where NOW stands: i the last event that has happened (-1 before the first), u how far toward the next, 0 to 1.
function _amStripAt(m, t) {
  var ev = _amStripEvents(m), lo = -1, hi = ev.length - 1;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ev[mid].t <= t) lo = mid; else hi = mid - 1; }
  var s = _amStripSpan(m, lo);
  return { i: lo, u: s[1] > s[0] ? Math.min(1, Math.max(0, (t - s[0]) / (s[1] - s[0]))) : 0 };
}
// The time at a place on the line (i + u steps): the inverse of _amStripAt.
function _amStripTime(m, f) {
  var n = _amStripEvents(m).length;
  f = Math.min(n, Math.max(-1, f));
  var i = Math.min(n - 1, Math.floor(f)), s = _amStripSpan(m, i);
  return s[0] + (s[1] - s[0]) * (f - i);
}
// One event's step along the strip, in pixels, for a window this wide (a quarter of it, between the stops).
function _amStripStep(w) { return Math.min(AE_MISSION_REF.stripStepPx[1], Math.max(AE_MISSION_REF.stripStepPx[0], w * 0.24)); }
// How far off an event is, in whole units: {n, unit} for Intl.RelativeTimeFormat, from the seconds between (unsigned).
function _amRelUnit(sec) {
  var R = AE_MISSION_REF.relS;
  if (sec < R[0]) return { n: Math.round(sec), unit: 'second' };
  if (sec < R[1]) return { n: Math.round(sec / 60), unit: 'minute' };
  if (sec < R[2]) return { n: Math.round(sec / 3600), unit: 'hour' };
  return { n: Math.round(sec / 86400), unit: 'day' };
}

// The shot of a phase at this moment. A coast's (cam.coast) stands AE_MISSION_REF.coastM off the craft whatever its data says of distance, and, when it names a second body
// (cam.then), looks back at cam.body for the first AE_MISSION_REF.turnShare of the phase, then ahead at that one.
function _amShotAt(m, s, ph) {
  var shot = ph.cam || { d: 200, az: 150, el: 15 };
  if (shot.moments) {   // a phase's shot may hold moments ({t0, t1, and the fields of a shot}): the stage that has just come away, the tower going. In one, its fields lie over the phase's own.
    var mo = shot.moments.filter(function (x) { return s.t >= x.t0 && s.t < x.t1; })[0];
    if (mo) shot = Object.assign({}, shot, mo);
  }
  if (!shot.coast) return shot;
  var pi = Math.max(0, s.phaseIdx), p = _aeClamp((s.t - ph.t) / ((_amPhaseEnd(m, pi) - ph.t) || 1), 0, 1);
  var out = Object.assign({}, shot, { d: AE_MISSION_REF.coastM });
  if (shot.then && p >= AE_MISSION_REF.turnShare) out.body = shot.then;
  return out;
}

// Where in a mission a request means: a time (seconds from its zero, T+), or the key of an event ('liftoff_moon', 'touchdown') or a phase ('ascent'), with or without the interface's prefix.
// A named event is entered AM_AT_LEAD_S before it, so it is seen happening. Null when the mission has no such thing.
var AM_AT_LEAD_S = 2;
function _amResolveAt(m, at) {
  if (typeof at === 'number') return isFinite(at) ? at : null;
  if (typeof at !== 'string' || !at) return null;
  var ev = m.events.filter(function (e) { return e.k === at || e.k === 'alm_ms_ev_' + at; })[0];
  if (ev) return ev.t - AM_AT_LEAD_S;
  var ph = m.phases.filter(function (p) { return p.k === at || p.k === 'alm_ms_ph_' + at; })[0];
  return ph ? ph.t : null;
}

// ── Where a vehicle is, in the scene ──
// A leg's frame this frame: the matrix and centre a body-fixed or body-centred leg is drawn from.
function _amLegFrame(leg, sc) {
  var fr = leg.frame;
  if (fr === 'mcmf') { leg.basis = _ae.gl.moon.matrix.elements; leg.centre = sc.moon; }
  else if (fr === 'mfix' || fr === 'rel') {
    var p = _ae.gl.planets && _ae.gl.planets[leg.body];
    if (!p || !p.pos) { leg.centre = null; return; }
    leg.centre = p.pos; leg.basis = fr === 'mfix' ? _amTurnOnly(p.mesh.matrix.elements) : AM_IDENTITY;
  }
}
// A body mesh's turn without its size or flattening: its three columns as unit axes, the way a site stands on the body (almanac-sites.js _asAxes).
function _amTurnOnly(e) {
  var out = e.slice(), c;
  for (c = 0; c < 3; c++) {
    var n = Math.hypot(e[c * 4], e[c * 4 + 1], e[c * 4 + 2]) || 1;
    out[c * 4] = e[c * 4] / n; out[c * 4 + 1] = e[c * 4 + 1] / n; out[c * 4 + 2] = e[c * 4 + 2] / n;
  }
  return out;
}
// A frame's vector (km) into the scene's axes (Earth radii).
function _amAxes(leg, v, sc) {
  var er = AE_EARTH_RADIUS_KM, fr = leg.frame;
  if (fr === 'ecef') return _aeFixedToScene(_aeScale(v, 1 / er), sc.gast);
  if (fr === 'eci' || fr === 'rel') return _aeScale(_ephEclJ2000ToEqOfDate(v, sc.jde), 1 / er);
  var e = leg.basis, q = _aeScale(v, 1 / er);
  return [e[0] * q[0] + e[4] * q[1] + e[8] * q[2], e[1] * q[0] + e[5] * q[1] + e[9] * q[2], e[2] * q[0] + e[6] * q[1] + e[10] * q[2]];
}
// The Moon as drawn against the Moon as the table has it: a craft near the Moon is moved by the difference, so it flies over the
// Moon that is drawn, not a Moon some kilometres off.
function _amMoonShift(M, t, p, sc) {
  var ref = _amTable(M.ref.moon, t), d = _aeLen(_aeSub(p, ref.p)), w = 1 - _amSmooth(AM_MOON_FIX_NEAR_KM, AM_MOON_FIX_FAR_KM, d);
  if (w <= 0) return null;
  var tabled = _aeScale(_ephEclJ2000ToEqOfDate(ref.p, sc.jde), 1 / AE_EARTH_RADIUS_KM);
  return _aeScale(_aeSub(sc.moon, tabled), w);
}
// A leg's scene position and axes-turned velocity at table time t, before any seam.
function _amLegRaw(M, leg, t, sc) {
  if (leg.frame === 'helio') return _amHelioRaw(leg, t, sc);
  var r = _amTable(leg.s, Math.min(leg.s[leg.s.length - 1][0], Math.max(leg.s[0][0], t)));
  _amLegFrame(leg, sc);
  var fr = leg.frame, pos = _amAxes(leg, r.p, sc), vel = _amAxes(leg, r.v, sc);
  if (fr === 'mcmf' || fr === 'mfix' || fr === 'rel') { if (!leg.centre) return null; pos = _aeAdd(pos, leg.centre); }
  else if (fr === 'eci') { var sh = _amMoonShift(M, t, r.p, sc); if (sh) pos = _aeAdd(pos, sh); }
  return { pos: pos, vel: vel, up: r.up ? _amAxes(leg, r.up, sc) : null, km: r };
}
// A heliocentric leg (the planner's transfer arcs): AU and AU/s in the ecliptic, drawn on the view's own squeezed scale round the Sun as shown.
function _amHelioRaw(leg, t, sc) {
  var r = _amTable(leg.s, Math.min(leg.s[leg.s.length - 1][0], Math.max(leg.s[0][0], t))), toS = function (h) { return _ephEclJ2000ToEqOfDate(h, sc.jde); };
  // the probes' place (almanac-earth.js placeNear): the squeezed scale far out, the true distance from a planet near it, so the leg meets
  // the planet-centred legs either side of it where they hand over (on the squeezed scale alone it stood 127,000 km off the Earth-centred one)
  var S = _ae.gl, pos = S && S.placeNear ? S.placeNear(r.p) : _aeAdd(_aeSunShown(sc), _aeScale(_aeNorm(toS(r.p)), _aeShownDist(_aeLen(r.p))));
  return { pos: pos, vel: toS(r.v), up: toS([0, 0, 1]), km: { p: r.p, v: r.v } };
}
// A vehicle's state at mission time t: scene position, the direction it points and its up, its speed (km/s) in its leg's frame.
// null when it is not there.
function _amVehicleAt(M, veh, t, sc) {
  if (t < veh.on || t > veh.off) return null;
  var leg = _amLegAt(veh, t), raw = leg.frame === 'probe' ? _amProbeRaw(leg) : _amLegRaw(M, leg, t, sc);
  if (!raw) return null;
  var pos = raw.pos;
  if (leg.prev) {   // a leg that begins off the end of the last one closes the gap
    var gone = 1 - _amSmooth(0, 1, (t - leg.s[0][0]) / (leg.sd || AM_SEAM_DECAY_S));
    if (gone > 0) {
      var gap = _amSeamGap(M, leg, sc);
      if (gap) pos = _aeAdd(pos, _aeScale(gap, gone));
    }
  }
  var up = raw.up || _aeSub(pos, leg.ref === 'moon' ? sc.moon : [0, 0, 0]);
  up = _aeLen(up) < 1e-12 ? [0, 0, 1] : _aeNorm(up);
  var fwd = _aeLen(raw.vel) > 1e-12 ? _aeNorm(raw.vel) : up;
  if (leg.att === 'retro') {
    fwd = _aeScale(fwd, -1);
    if (leg.turn) fwd = _aeRotateAbout(fwd, up, Math.PI * _amSmooth(leg.turn[0], leg.turn[1], t));   // turning round to point the engine the other way
  }
  if (leg.att === 'level') {   // a lander, a rover: standing, facing the way it moves over the ground
    var hv = _aeSub(raw.vel, _aeScale(up, _aeDot(raw.vel, up)));
    fwd = _aeLen(hv) > 1e-12 * 0 + 1e-14 ? _aeNorm(hv) : _aeNorm(_aeCross(up, [0, 0, 1]));
  }
  // On the pad, and for the first seconds, nothing yet says which way it points: up.
  if (raw.km && leg.frame === 'ecef' && leg.att !== 'level') { var go = _amSmooth(AM_STILL_KMS[0], AM_STILL_KMS[1], _aeLen(raw.km.v)); fwd = _aeNorm(_aeAdd(_aeScale(fwd, go), _aeScale(up, 1 - go))); }
  return { pos: pos, fwd: fwd, up: up, speed: raw.km ? _aeLen(raw.km.v) : 0, vehicle: veh, leg: leg, km: raw.km };
}
// Where a leg hands over, the last leg's end less this one's start (scene axes, Earth radii). A hand-over to or from a Sun-centred leg is
// measured from the Sun with each end at its own instant (the planet's place then, from the view's ephemeris): drawn in the present
// scene, the Sun-centred end stood where it was while the planet had moved on, and the gap grew with the time since (54,000 km after
// half an hour by the Earth).
function _amSeamGap(M, leg, sc) {
  var prev = leg.prev, t0 = prev.s[prev.s.length - 1][0], t1 = leg.s[0][0];
  if (leg.frame === 'helio' || prev.frame === 'helio') {
    var ha = _amHelioKm(M, prev, t1), hb = _amHelioKm(M, leg, t1);   // both at the hand-over (the last leg carried on past its end)
    if (ha && hb) return _aeScale(_ephEclJ2000ToEqOfDate(_aeSub(ha, hb), sc.jde), 1 / AE_EARTH_RADIUS_KM);
  }
  var a = _amLegRaw(M, prev, t0, sc), b = _amLegRaw(M, leg, t1, sc);
  return a && b ? _aeSub(a.pos, b.pos) : null;
}
// A leg's place from the Sun at mission time t (km, J2000 ecliptic; a Sun-centred leg's table is in AU): its own for a Sun-centred leg, the centre's from the view's
// ephemeris added for an Earth- or planet-centred inertial one; null for a turning frame.
function _amHelioKm(M, leg, t) {
  var end = leg.s[leg.s.length - 1][0], q = _amTable(leg.s, Math.min(end, Math.max(leg.s[0][0], t))), jd = (M.zeroMs + t * 1000) / MS_PER_DAY + JD_UNIX_EPOCH;
  var r = t > end ? _aeAdd(q.p, _aeScale(q.v, t - end)) : q.p;   // past its last row: on along its last velocity (minutes, between tables)
  if (leg.frame === 'helio') return _aeScale(r, AU_KM);
  var body = leg.frame === 'eci' ? { eph: 'Earth' } : leg.frame === 'rel' ? AE_PLANETS.filter(function (b) { return b.key === leg.body; })[0] : null;
  return body && body.eph ? _aeAdd(r, _aeScale(_ephBodyJ2000(body.eph, jd), AU_KM)) : null;
}
// A probe's table begins hours after its launch (Voyager 2: 9.5 h), yet the mission's Launch phase begins at the launch itself.
// In that gap the view (almanac-earth.js _aeUpdateProbes) asks where the probe stands: lifting away from the Earth along the line to
// its first row, p0 (scene axes, Earth radii), from the pad it stood on (turning with the Earth), slowly at first; null outside the mission
// that follows this probe, or once its table has begun.
var AM_PAD_LAT = 28.5833, AM_PAD_LON = -80.5828, AM_PARK_KM = 170;   // Cape Canaveral's Launch Complex 41, where both Voyagers left (Titan IIIE); the Titan-Centaur's parking orbit height
function _amProbeLift(key, p0) {
  var s = _ae.mission, m = s && _amMission(), veh = m && m.vehicles.filter(function (v) { return v.legs[0].frame === 'probe' && v.legs[0].key === key; })[0];
  if (!veh) return null;
  var first = veh.legs[0].s[0][0], sec = (_ae.scene.ms - s.zeroMs) / 1000;
  if (sec < 0 || sec >= first) return null;
  var pad = _aeFixedToScene(_aeGeodeticToFixed(AM_PAD_LAT, AM_PAD_LON), _ae.scene.gast), u = sec / first;
  var park = _aeScale(_aeNorm(pad), 1 + AM_PARK_KM / AE_EARTH_RADIUS_KM);   // no rocket is modelled: it starts in the parking orbit, high enough that the Earth is a world under it, not a floor at the camera
  return _aeAdd(park, _aeScale(_aeSub(p0, park), u * u));   // from there to the first row
}
function _amProbeRaw(leg) {
  var pos = _aeProbePos[leg.key], hd = _aeProbeHeading[leg.key];
  return pos ? { pos: pos, vel: hd || [1, 0, 0], up: null, km: null } : null;
}
// The right-handed basis of a state: x right, y the way it points, z up (the models' own).
function _amBasis(st) {
  var y = st.fwd, z = _aeSub(st.up, _aeScale(y, _aeDot(st.up, y)));
  z = _aeLen(z) < 1e-9 ? _aeCross(y, Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]) : z;
  z = _aeNorm(z);
  return { x: _aeCross(y, z), y: y, z: z };
}
function _amLocal(b, v) {   // a vehicle-frame vector (metres) into the scene (Earth radii)
  return [(b.x[0] * v[0] + b.y[0] * v[1] + b.z[0] * v[2]) * AM_MRE, (b.x[1] * v[0] + b.y[1] * v[1] + b.z[1] * v[2]) * AM_MRE, (b.x[2] * v[0] + b.y[2] * v[1] + b.z[2] * v[2]) * AM_MRE];
}

// A part's place in its vehicle's frame at time t: fixed, or along keyframes ({t, at, rx}: eased between).
function _amPartPose(p, t) {
  var k = p.anim;
  if (!k || !k.length) return { at: p.at, rx: p.rx || 0 };
  if (t <= k[0].t) return { at: k[0].at, rx: k[0].rx || 0 };
  for (var i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      var u = _amSmooth(k[i - 1].t, k[i].t, t), a = k[i - 1].at, b = k[i].at;
      return { at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], rx: (k[i - 1].rx || 0) + ((k[i].rx || 0) - (k[i - 1].rx || 0)) * u };
    }
  }
  var e = k[k.length - 1];
  return { at: e.at, rx: e.rx || 0 };
}
// A vector turned about the vehicle's x axis by deg (y toward z), and a basis turned the same way.
function _amRotX(v, deg) {
  var c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function _amTurnX(b, deg) {
  var c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return { x: b.x, y: _aeAdd(_aeScale(b.y, c), _aeScale(b.z, s)), z: _aeSub(_aeScale(b.z, c), _aeScale(b.y, s)) };
}

// The planner is its own file, fetched when asked for.
var AM_PLAN_JS = _almAsset('/static/almanac-missions-plan.js'), _amPlanLoading = false;
function _amPlanLoad(then) {
  if (typeof _apOpen === 'function') { then(); return; }
  if (_amPlanLoading) return;
  _amPlanLoading = true;
  var sc = document.createElement('script');
  sc.src = AM_PLAN_JS;
  sc.onload = function () { _amPlanLoading = false; then(); };
  sc.onerror = function () { _amPlanLoading = false; sc.remove(); };
  document.head.appendChild(sc);
}

// ── Loading ──
function _amLoad(then) {
  if (_amData) { then(); return; }
  if (!_amLoading) {
    _amLoading = fetch(AM_DATA_URL).then(function (r) { if (!r.ok) throw new Error('missions'); return r.json(); }).then(function (d) {
      Object.keys(d.missions).forEach(function (k) { _amPrepare(d.missions[k]); });
      _amData = d;
    }).catch(function () { _amLoading = null; });
  }
  _amLoading.then(function () { if (_amData) then(); });
}
// Links each vehicle's legs to the one before and stands the models it needs in a list.
function _amPrepare(m) {
  m.models = {};
  m.vehicles.forEach(function (v) {
    v.legs.forEach(function (leg, i) { leg.prev = i > 0 && v.legs[i - 1].frame !== leg.frame ? v.legs[i - 1] : null; });
    v.parts.forEach(function (p) { m.models[p.m] = true; });
  });
  m.models = Object.keys(m.models);
}

// ── Models ──
function _amPartMesh(S, key) {
  var d = _aeCraftData(key);
  if (!d) return null;
  var I = _aeCraftBuild(S, key);
  I.data = d;
  I.root.children.forEach(function (c) { if (c.material) c.material.side = AM_THREE_DOUBLE_SIDE; });
  return I;
}
function _amFlameMesh(S) {
  var THREE = S.THREE, n = AM_FLAME_SEGS, pos = [], k = [], idx = [];
  pos.push(0, 0, 0); k.push(0);   // the apex-less base centre
  for (var i = 0; i < n; i++) { var a = i / n * Math.PI * 2; pos.push(Math.cos(a), 0, Math.sin(a)); k.push(0); }
  pos.push(0, -1, 0); k.push(1);
  for (var j = 0; j < n; j++) idx.push(1 + j, 1 + (j + 1) % n, n + 1);
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('k', new THREE.BufferAttribute(new Float32Array(k), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  var mat = new THREE.ShaderMaterial({
    uniforms: { fade: { value: 1 }, hot: { value: new THREE.Vector3(AM_FLAME_COLOR[0], AM_FLAME_COLOR[1], AM_FLAME_COLOR[2]) } },
    vertexShader: 'attribute float k; varying float vK; void main() { vK = k; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float fade; uniform vec3 hot; varying float vK; void main() { vec3 c = mix(vec3(1.0, 0.85, 0.55), hot, smoothstep(0.0, 0.7, vK)); gl_FragColor = vec4(c * (1.0 - vK * 0.6), (1.0 - vK) * (1.0 - vK) * 0.7 * fade); }',
    transparent: true, depthWrite: false, side: AM_THREE_DOUBLE_SIDE
  });
  mat.blending = AM_THREE_ADDITIVE;
  var mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  S.scene.add(mesh);
  return mesh;
}

// ── The state of a mission being played ──
function _amState() { return _ae && _ae.mission; }
// The mission's own name, in the person's language where it has one.
function _amName() {
  var s = _amState(), m = _amMission();
  if (!s || !m) return '';
  var key = 'alm_ms_' + s.id, said = _aeT(key);
  return said === key ? m.name : said;
}
// Recentre, the mission's one button in the corner (the camera's place): back to the view the mission itself keeps.
if (typeof _aeCamRegister === 'function') {
  _aeCamRegister({
    active: function () { return !!_ae.mission; },
    get label() { return _aeT('alm_ms_recentre'); },
    get svg() { return AM_ICONS.recentre; },
    run: function () { var s = _ae.mission; if (s) { s.userCam = false; s.camSet = false; _ae.dirty = true; _aeKick(); } }
  });
}
function _amMission() { var s = _amState(); return s && _amData ? _amData.missions[s.id] : null; }

// Open a mission by id. The view flies there when it is not yet in the mission's space.
function _aeMissionOpen(id, atT, back, link) {
  if (!_ae || !_ae.gl) return;
  if (id === 'plan') { _amPlanLoad(function () { _apOpen(); }); return; }
  if (_ae.site) _aeSiteLeave(true);
  _amBackChip(false);
  if (typeof _aeTracksLoad === 'function') _aeTracksLoad();   // a probe's flight is drawn from its table
  _amLoad(function () {
    var m = _amData.missions[id];
    if (!m) { _aeLinkModeDone(); return; }
    if (_ae.mission) _amStop(true);
    m.models.forEach(function (k) { _aeCraftLoad(k); });
    m.vehicles.forEach(function (v) { v.legs.forEach(function (l) { if (l.frame === 'probe' && AE_CRAFT_MODEL[l.key]) _aeCraftLoad(AE_CRAFT_MODEL[l.key]); }); });   // a probe's own model, drawn by the view itself
    var s = _ae.mission = {
      id: id, zeroMs: m.zeroMs, parts: {}, flames: {}, dot: null, userCam: false, phaseIdx: -1,
      camAz: 0, camEl: 0.3, camDist: 100, camSet: false, shot: null, back: _ae.missionBack || (_ae.missionBack = { ms: _aeDisplayMs(), rate: typeof _almRate === 'number' ? _almRate : 1, live: !_aeFocusSet() }),
      lastText: 0, ended: 0, state: {}, fov: AM_FOV_DEG, pose: null, focus: null, trackAt: -1, noHandoff: !!back
    };
    s.paused = link ? !!link.paused : true;   // a mission opens paused (a link says its own): it starts when the person presses play
    _aeLinkModeDone();
    _ae.el.classList.add('ae-mission');
    _ae.el.classList.toggle('am-no-time', !AE_MISSION_REF.timeStrip);   // the view's own time strip stays under the mission's bar, or goes
    _aeMeasureFoot();
    _aeShowGo(false);
    _amHud(true);
    var at = _amResolveAt(m, atT);
    _amJump(m, at == null ? m.start : at);
    if (m.arc) _amArc(m);
    _aeKick();
  });
}

// A mission whose cruise is a Sun-centred table (m.arc: the vehicle whose helio leg it is) draws that arc and fits its overview shots to it.
function _amArc(m) {
  var leg = null;
  m.vehicles.forEach(function (v) { v.legs.forEach(function (l) { if (!leg && l.frame === 'helio') leg = l; }); });
  if (!leg) return;
  m.fitD = _amOverviewDist(leg.s);
  _amPlanLoad(function () { if (_ae.mission && _amMission() === m && typeof _apArcLine === 'function') _apArcLine(_ae.mission, leg.s); });
}
function _amStop(quiet) {
  var s = _ae && _ae.mission;
  if (!s) return;
  var S = _ae.gl;
  Object.keys(s.parts).forEach(function (k) { var I = s.parts[k]; if (I.root.parent) I.root.parent.remove(I.root); });
  Object.keys(s.flames).forEach(function (k) { var f = s.flames[k]; if (f.parent) f.parent.remove(f); f.geometry.dispose(); f.material.dispose(); });
  if (s.dot) { if (s.dot.parent) s.dot.parent.remove(s.dot); }
  if (s.cleanup) s.cleanup();
  if (s.pad) {   // the pad's ground and sky go, the globe comes back
    S.scene.remove(s.pad.group); s.pad.ground.geometry.dispose(); s.pad.ground.material.dispose(); s.pad.dome.geometry.dispose(); s.pad.dome.material.dispose();
    S.earth.visible = true; if (s.padAtmo) s.padAtmo.visible = true;
  }
  if (typeof _almStripLead === 'function') _almStripLead('');
  _ae.mission = null;
  _ae.el.classList.remove('ae-mission', 'am-no-time', 'am-steps-up');
  _aeMeasureFoot();
  _amHud(false);
  if (!quiet) { _amRestoreTime(); _ae.dirty = true; _aeKick(); }
}
// The reader's own moment from before the first mission (their chosen date, else now) and the clock's pace, given back
// once: by the mission's own exit, or by the view closing (almanac-earth.js), whichever comes first. A mission that hands
// over to a landing site, or gives way to another, keeps the moment from before the first.
function _amRestoreTime() {
  var b = _ae && _ae.missionBack;
  if (!b) return;
  _ae.missionBack = null;
  if (b.live && typeof _aeNow === 'function') _aeNow(); else if (typeof _aeGoTo === 'function') _aeGoTo(b.ms);
  if (typeof _almClockSetRate === 'function') _almClockSetRate(b.rate);
}
// Jump to a mission time: the page's clock goes there at the phase's own pace.
function _amJump(m, t, keepCam) {
  var s = _ae.mission;
  if (!s) return;
  var ms = s.zeroMs + t * 1000;
  _aeSettlePage(new Date(ms));
  var i = _amPhaseAt(m, t);
  _amSetRate(m, i);
  if (!keepCam) { s.userCam = false; s.camSet = false; }
  s.phaseIdx = -1;
  _ae.ringsAt = _ae.issRingAt = _ae.moonPathAt = null;
  _ae.dirty = true; _aeKick();
}
var AM_SCRUB_HOLD_MS = 700;   // a phase reached within this long of a drag was scrubbed to, not played to
function _amRateOf(m, i) { return m.phases[i].rate || 1; }   // each phase's own pace from the mission's data; the one slider moves it from there
// Fast forward ("would like a fast forward button"): the phase's own pace times one of these, a press steps along them.
var AM_FF_STEPS = [1, 10, 100];
function _amSetRate(m, i) {
  var s = _ae.mission, r = s.paused ? 0 : _amRateOf(m, i) * (s.ff || 1);
  if (typeof _almClockSetRate === 'function') _almClockSetRate(r);
}

// ── The frame hooks (almanac-earth.js _aeUpdate) ──
// Before the camera: the time, every vehicle's state, and the camera's pose.
function _aeMissionStep(sc) {
  var s = _ae.mission, m = _amMission();
  if (!s || !m) return;
  var t = (sc.ms - s.zeroMs) / 1000, now = performance.now(), dt = s.last ? Math.min(0.1, (now - s.last) / 1000) : 0.016;
  s.last = now;
  s.t = t;
  var pi = _amPhaseAt(m, Math.max(t, m.phases[0].t));
  if (pi !== s.phaseIdx) { s.phaseIdx = pi; s.camSet = false; if (!s.paused) _amSetRate(m, pi); _amPhaseChanged(m, pi); }
  if (t >= m.end && !s.paused) { s.paused = true; if (typeof _almClockSetRate === 'function') _almClockSetRate(0); _amSyncPlay(); }
  var states = {};
  m.vehicles.forEach(function (v) { var st = _amVehicleAt(m, v, t, sc); if (st) states[v.id] = st; });
  s.state = states;
  var ph = m.phases[pi], follow = states[ph.follow || m.follow] || states[m.follow] || null;
  if (!follow) { var any = Object.keys(states)[0]; follow = any ? states[any] : null; }
  s.follow = follow;
  if (follow) _amCamera(m, s, follow, ph, dt, sc);
  _amHudTick(m, s, follow, t, now);
  _amDawn(s, follow, sc);
}
// After the camera (its matrices are this frame's): the models, flames and dots.
function _aeMissionDraw() {
  var s = _ae.mission, m = _amMission();
  if (!s || !m || !s.state) return;
  var S = _ae.gl, cam = S.camera, t = s.t, any = false;
  if (!s.dot) {
    s.dot = _aePointCloud(S.THREE, m.vehicles.length + 2, S.dpr, true, { depthTest: true });
    S.scene.add(s.dot);
  }
  var nDots = 0;
  m.vehicles.forEach(function (v) {
    var st = s.state[v.id], show = 0;
    v.parts.forEach(function (p, pi) {
      var key = v.id + ':' + pi, I = s.parts[key];
      var live = st && (p.from == null || t >= p.from) && (p.to == null || t < p.to);
      if (!live) { if (I) I.root.visible = false; return; }
      if (!I) { I = _amPartMesh(S, p.m); if (!I) return; s.parts[key] = I; }
      var b = _amBasis(st), pa = _amPartPose(p, t), rot = pa.rx;
      var mid = [I.data.mid[0] * I.data.metres, I.data.mid[1] * I.data.metres, I.data.mid[2] * I.data.metres];
      if (rot) mid = _amRotX(mid, rot);
      var at = [pa.at[0] + mid[0], pa.at[1] + mid[1], pa.at[2] + mid[2]];
      var o = _amLocal(b, at), pos = _aeAdd(st.pos, o);
      var bp = rot ? _amTurnX(b, rot) : b;
      var span = Math.max(I.data.span * I.data.metres, 1) * AM_MRE, dist = _aeLen(_aeSub(pos, [cam.position.x, cam.position.y, cam.position.z]));
      var px = span / Math.max(dist, 1e-12) * _ae.h / 2 / Math.tan(_aeRad(cam.fov) / 2);
      var sh = _amSmooth(AM_MODEL_PX[0], AM_MODEL_PX[1], px);
      show = Math.max(show, sh);
      I.root.position.set(pos[0], pos[1], pos[2]);
      var M = new S.THREE.Matrix4().makeBasis(new S.THREE.Vector3(bp.x[0], bp.x[1], bp.x[2]), new S.THREE.Vector3(bp.y[0], bp.y[1], bp.y[2]), new S.THREE.Vector3(bp.z[0], bp.z[1], bp.z[2]));
      I.root.quaternion.setFromRotationMatrix(M);
      I.root.visible = sh > 0;
      if (sh > 0) _aeCraftLight(I, pos, v.ref === 'moon' ? null : _aeNorm(_aeScale(pos, -1)), sh);
    });
    (v.flames || []).forEach(function (f, fi) {
      var key = v.id + '#' + fi, F = s.flames[key], on = st && t >= f.from && t < f.to;
      if (!on) { if (F) F.visible = false; return; }
      if (!F) F = s.flames[key] = _amFlameMesh(S);
      var b = _amBasis(st), vac = 1 + (f.vac || 0) * _amSmooth(0, 1, (st.km ? _aeLen(st.pos) - 1 : 1) * 6378 / (f.vacAlt || 120)), len = f.len * vac * (0.88 + 0.24 * Math.random());
      var pos = _aeAdd(st.pos, _amLocal(b, f.at)), bf = f.rx ? _amTurnX(b, f.rx) : b;
      F.position.set(pos[0], pos[1], pos[2]);
      var Mf = new S.THREE.Matrix4().makeBasis(new S.THREE.Vector3(bf.x[0], bf.x[1], bf.x[2]), new S.THREE.Vector3(bf.y[0], bf.y[1], bf.y[2]), new S.THREE.Vector3(bf.z[0], bf.z[1], bf.z[2]));
      F.quaternion.setFromRotationMatrix(Mf);
      F.scale.set(f.r * AM_MRE, len * AM_MRE, f.r * AM_MRE);
      F.visible = true;
      F.material.uniforms.fade.value = _aeFadeU.value;
      F.updateMatrixWorld();
    });
    if (st && v.dot !== false) {
      var over = !!(m.phases[Math.max(0, s.phaseIdx)].cam || {}).overview;
      _aeSetPoint(s.dot, nDots++, st.pos, [1, 0.82, 0.4], (over ? 1 : Math.max(0, 1 - show)) * _aeFadeU.value, over ? AM_DOT_OVERVIEW_PX : AM_DOT_PX);
    }
  });
  _aeCommitPoints(s.dot, nDots);
  if (s.onDraw) s.onDraw();
  _amMark(m, s);
  _amPad(s, s.follow, _ae.scene);
}


// ── The dawn glow ──
// Near the Earth with the Sun a few degrees below the horizon, a warm band lies along the horizon the camera sees (the picture's own atmosphere is too thin a glow
// for twilight): at its strongest with the Sun about AM_DAWN_PEAK_DEG down, gone by AM_DAWN_SPAN_DEG either side of that.
var AM_DAWN_PEAK_DEG = -4, AM_DAWN_SPAN_DEG = 6, AM_DAWN_MAX = 0.4, AM_DAWN_ALT_KM = 300, AM_DAWN_BAND = 0.35;
function _amDawn(s, st, sc) {
  var el = _aeById('am-dawn');
  if (!el) return;
  var pose = s.pose, on = false;
  if (st && pose && st.leg.ref !== 'moon' && st.leg.frame !== 'probe' && st.leg.frame !== 'helio' && !s.fly) {
    var up = _aeNorm(st.pos), alt = _aeLen(st.pos) * AE_EARTH_RADIUS_KM - AE_EARTH_RADIUS_KM;
    if (alt < AM_DAWN_ALT_KM) {
      var elev = _aeDeg(Math.asin(_aeClamp(_aeDot(_aeNorm(sc.sun), up), -1, 1))), z = (elev - AM_DAWN_PEAK_DEG) / AM_DAWN_SPAN_DEG, k = Math.exp(-z * z);
      if (k > 0.02) {
        var look = pose.look, right = _aeNorm(_aeCross(look, pose.up)), upc = _aeCross(right, look);
        var dip = Math.acos(_aeClamp(AE_EARTH_RADIUS_KM / (AE_EARTH_RADIUS_KM + Math.max(alt, 0)), 0, 1)), pitch = Math.asin(_aeClamp(_aeDot(look, up), -1, 1));
        var a = -dip - pitch, half = Math.tan(_aeRad(pose.fov) / 2), y = _ae.h / 2 - Math.tan(a) / half * _ae.h / 2, hgt = _ae.h * AM_DAWN_BAND;
        var roll = Math.atan2(_aeDot(up, right), _aeDot(up, upc));
        el.style.height = hgt + 'px';
        el.style.top = (y - hgt / 2) + 'px';
        el.style.transform = 'rotate(' + roll + 'rad)';
        el.style.opacity = (AM_DAWN_MAX * k).toFixed(3);
        on = true;
      }
    }
  }
  if (!on) el.style.opacity = '0';
}
// ── The pad's ground and sky ──
// Over the launch pad the Earth is a flat blue wall at this scale. While the vehicle is in the first kilometres of its first leg, the globe is put away and the pad's own
// surroundings stand in: a ground of the Cape's tones fading to haze, a sky from the haze at the horizon to blue overhead (dimmer as the Sun goes down), both thinning out
// with height until the globe takes over.
var AM_PAD_HIDE_KM = 4, AM_PAD_FADE_KM = [3, 45], AM_PAD_GROUND_RE = 0.008, AM_PAD_DOME_RE = 0.2;
// The same stands in under a vehicle's last leg on the Earth (the command module under its chutes): the ground is the sea it comes down on
// ("splashdown didn't drop it into the ocean it's still in a sky scene").
var AM_SEA = [0.05, 0.17, 0.27];
var AM_PAD_GROUND = [0.34, 0.40, 0.27], AM_PAD_HAZE = [0.80, 0.86, 0.93], AM_PAD_SKY = [0.27, 0.48, 0.84];
var AM_PAD_VERT = 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
var AM_PAD_FRAG = 'varying vec3 vP; uniform vec3 up, haze, sky; uniform float k, lit;' +
  'void main() { float h = dot(normalize(vP), up); float t = smoothstep(0.0, 0.45, h);' +
  'vec3 c = mix(haze, sky, t) * lit; gl_FragColor = vec4(c, k); }';
var AM_PAD_GROUND_FRAG = 'varying vec3 vP; uniform vec3 colour; uniform float k, rad;' +
  'void main() { float r = length(vP.xy) / rad; gl_FragColor = vec4(colour, k * (1.0 - smoothstep(0.45, 1.0, r))); }';
function _amPadBuild(S) {
  var T = S.THREE, g = new T.Group(), n = 48, pos = new Float32Array((n + 1) * 3), idx = [];
  for (var i = 0; i < n; i++) { var a = i / n * Math.PI * 2; pos[(i + 1) * 3] = Math.cos(a) * AM_PAD_GROUND_RE; pos[(i + 1) * 3 + 1] = Math.sin(a) * AM_PAD_GROUND_RE; idx.push(0, i + 1, (i + 1) % n + 1); }
  var geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  var gu = { colour: { value: new T.Vector3(AM_PAD_GROUND[0], AM_PAD_GROUND[1], AM_PAD_GROUND[2]) }, k: { value: 1 }, rad: { value: AM_PAD_GROUND_RE } };
  var ground = new T.Mesh(geo, new T.ShaderMaterial({ uniforms: gu, vertexShader: AM_PAD_VERT, fragmentShader: AM_PAD_GROUND_FRAG, transparent: true, depthWrite: true, side: T.DoubleSide }));   // (it writes depth: the stars behind it, round the camera, are under the ground, not on it)
  ground.frustumCulled = false;
  var uni = { up: { value: new T.Vector3(0, 0, 1) }, haze: { value: new T.Vector3(AM_PAD_HAZE[0], AM_PAD_HAZE[1], AM_PAD_HAZE[2]) }, sky: { value: new T.Vector3(AM_PAD_SKY[0], AM_PAD_SKY[1], AM_PAD_SKY[2]) }, k: { value: 1 }, lit: { value: 1 } };
  var dome = new T.Mesh(new T.SphereGeometry(AM_PAD_DOME_RE, 32, 16), new T.ShaderMaterial({ uniforms: uni, vertexShader: AM_PAD_VERT, fragmentShader: AM_PAD_FRAG, side: T.BackSide, transparent: true, depthTest: false, depthWrite: false }));
  dome.frustumCulled = false; dome.renderOrder = -100;
  ground.renderOrder = -90;
  g.add(dome); g.add(ground);
  g.visible = false;
  S.scene.add(g);
  return { group: g, ground: ground, dome: dome, uni: uni, gu: gu };
}
function _amPad(s, st, sc) {
  var legs = st && st.vehicle && st.leg.frame === 'ecef' ? st.vehicle.legs : null;
  var sea = !!legs && legs.length > 1 && legs[legs.length - 1] === st.leg;   // the last leg, home: the sea
  var S = _ae.gl, first = !!legs && (legs[0] === st.leg || sea);
  var alt = first && st.km ? _aeLen(st.km.p) - _amEarthR(st.km.p) : Infinity;
  if (!s.pad && first && alt < AM_PAD_FADE_KM[1]) s.pad = _amPadBuild(S);
  var P = s.pad;
  if (!P) return;
  var k = first ? 1 - _amSmooth(AM_PAD_FADE_KM[0], AM_PAD_FADE_KM[1], alt) : 0;
  if (!(k > 0.01)) { P.group.visible = false; _amPadEarth(s, true); return; }
  var up = _aeNorm(st.pos), sub = _aeSub(st.pos, _aeScale(up, (sea ? Math.max(0, alt) : alt) / AE_EARTH_RADIUS_KM));   // (the table's last rows run a few metres under the ellipsoid: the sea is where the capsule floats)
  P.group.visible = true;
  P.group.position.set(sub[0], sub[1], sub[2]);
  P.group.quaternion.setFromUnitVectors(new S.THREE.Vector3(0, 0, 1), new S.THREE.Vector3(up[0], up[1], up[2]));
  // the dome's up is in the group's own frame: +z
  P.uni.up.value.set(0, 0, 1);
  P.uni.k.value = k * _aeFadeU.value;
  P.uni.lit.value = 0.25 + 0.75 * _aeClamp(_aeDot(_aeNorm(sc.sun), up) * 3 + 0.5, 0, 1);
  P.gu.k.value = k * _aeFadeU.value;
  var gc = sea ? AM_SEA : AM_PAD_GROUND;
  P.gu.colour.value.set(gc[0] * P.uni.lit.value, gc[1] * P.uni.lit.value, gc[2] * P.uni.lit.value);
  _amPadEarth(s, alt >= AM_PAD_HIDE_KM);
}
// The globe and its atmosphere: put away while the pad's ground stands in, given back above it (and when the mission closes).
function _amPadEarth(s, show) {
  var S = _ae.gl;
  if (s.padShown === show) return;
  s.padShown = show;
  if (s.padAtmo === undefined) s.padAtmo = S.scene.children.filter(function (o) { return o.material && o.material.fragmentShader === AE_ATMO_FRAG; })[0] || null;
  S.earth.visible = show;
  if (s.padAtmo) s.padAtmo.visible = show;
}


// The probe's name beside its dot in an overview, the way the planets are named: placed over the picture where the dot is drawn.
function _amMark(m, s) {
  var el = _aeById('am-mark');
  if (!el) return;
  var ph = m.phases[Math.max(0, s.phaseIdx)], st = s.follow, at = st && (ph.cam || {}).overview ? _aeProject(st.pos) : null;
  if (!at) { el.hidden = true; return; }
  if (!el.textContent) el.textContent = m.name;
  el.hidden = false;
  el.style.transform = 'translate(' + (at.x + AM_MARK_DX).toFixed(1) + 'px,' + (at.y + AM_MARK_DY).toFixed(1) + 'px)';
}

// ── The hand-off at touchdown ──
// On the Moon the mission gives way to the ground's site visit (almanac-sites.js), at the landing instant, with a chip that comes back to the mission at lift-off.
var AM_SITE_WAIT_MS = 6000, AM_BACK_ID = 'am-back', AM_BACK_WATCH_MS = 600, AM_POLL_MS = 100, AM_RESUME_PAST_S = 25;   // the ascent phase begins 20 s before lift-off: the way back lands just after it
function _amLandingRow(name, body) {
  var rows = (typeof _aeLm !== 'undefined' && _aeLm && _aeLm[body || 'moon']) || [];
  return rows.filter(function (r) { return r[3] === 'landing' && r[0] === name; })[0] || null;
}
function _amHandoff(m, pi) {
  if (!_ae || !_ae.mission || _amMission() !== m) return;   // closed or changed in the meantime
  var id = _ae.mission.id, resume = m.phases[pi + 1] ? m.phases[pi + 1].t + AM_RESUME_PAST_S : m.end, landed = m.phases[pi].t, zero = _ae.mission.zeroMs;
  if (typeof _aeSitesLoad !== 'function') return;
  _aeSitesLoad();
  if (typeof _aeLmLoad === 'function') _aeLmLoad();
  var waited = 0, began = performance.now();
  var go = function () {
    if (!_ae || !_ae.mission || _amMission() !== m) return;
    if ((_ae.mission.scrubAt || 0) >= began) return;   // a drag since it began (the site's data was still loading): the user took the clock back
    var row = _amLandingRow(m.handoff.site, m.handoff.body);
    if (!row || typeof _aeSiteVisit !== 'function' || typeof _asData === 'undefined' || !_asData) {
      if ((waited += AM_POLL_MS) < AM_SITE_WAIT_MS) setTimeout(go, AM_POLL_MS);
      return;
    }
    var body = m.handoff.body || 'moon', def = _asDefFor(body, row), at = def && def.ms ? def.ms : zero + landed * 1000;
    _amStop(true);
    if (typeof _almClockSetRate === 'function') _almClockSetRate(1);
    if (typeof _aeGoTo === 'function' && at) _aeGoTo(at);
    _aeSiteVisit(body, row, false);
    _amBackChip(true, id, resume);
  };
  go();
}
// The way back: one chip, there while the visit is. It resumes the mission at lift-off.
function _amBackChip(on, id, t) {
  var old = document.getElementById(AM_BACK_ID);
  if (old) { clearInterval(old._watch); old.remove(); }
  if (!on || !_ae || !_ae.el) return;
  var b = document.createElement('button');
  b.type = 'button'; b.id = AM_BACK_ID; b.className = 'am-back';
  b.textContent = _aeT('alm_ms_back');
  b.onclick = function () { _amBackChip(false); _aeSiteLeave(true); _aeMissionOpen(id, t, true); };
  b._watch = setInterval(function () { if (!_ae || !_ae.el || !_ae.site) _amBackChip(false); }, AM_BACK_WATCH_MS);
  _ae.el.appendChild(b);
}
function _amPhaseChanged(m, pi) {
  var hud = _aeById('am-hud');
  if (hud) hud.dataset.phase = String(pi);
  _amPaintPhase(m, pi);
  var s = _ae.mission, there = m.handoff && m.phases[pi].k === m.handoff.phase;
  if (!there && s) s.noHandoff = false;   // come back to it later (by replay or a jump) and it hands over again
  if (there && s && !s.noHandoff && !(performance.now() - (s.scrubAt || 0) < AM_SCRUB_HOLD_MS)) setTimeout(function () { _amHandoff(m, pi); }, 0);   // after this frame's work: the hand-off takes the mission away
}

var AM_OVERVIEW_MARGIN = 1.35;               // the overview holds the whole arc (as the view draws it) with this much room round it
var AM_OVERVIEW_FAR_RE = 36000;              // the camera's far plane stands at about 40000 Earth radii
// How far above the Sun the overview stands to hold the whole arc, on the view's squeezed scale, in this window's narrower side.
function _amOverviewDist(rows) {
  var far = 0;
  rows.forEach(function (r) { far = Math.max(far, _aeShownDist(Math.hypot(r[1], r[2], r[3]))); });
  var side = Math.tan(_aeRad(AM_FOV_DEG) / 2) * Math.min(1, (_ae.w || 1) / (_ae.h || 1));
  return Math.min(AM_OVERVIEW_FAR_RE, far * AM_OVERVIEW_MARGIN / side);
}
// ── The camera ──
// A phase's shot is relative to the vehicle it follows: a distance (metres), an azimuth about its axis (degrees: 0 from its up
// side, 90 from its right) and how far toward its tail the camera leans (degrees). A hand on the picture takes the camera until a phase is jumped to.
function _amCamera(m, s, st, ph, dt, sc) {
  var shot = _amShotAt(m, s, ph);
  var want = { az: _aeRad(shot.az), el: _aeRad(shot.el), dist: shot.fit ? (m.fitD || AM_OVERVIEW_FAR_RE / 4) : shot.d, look: shot.look || AM_ORIGIN };
  if (!s.camSet) {
    // A shot begins where the camera is, in this vehicle's frame, so it eases there rather than cutting.
    s.camSet = true;
    if (!s.cam) s.cam = { az: want.az, el: want.el, dist: want.dist, look: want.look.slice() };
  }
  s.shot = want;   // the shot may change within a phase (its moments), so the camera eases to this moment's
  if (!s.userCam && !_aeReduceMotion()) {
    var k = 1 - Math.exp(-AM_CAM_EASE * dt);
    s.cam.az += _aeAngleDeltaRad(s.cam.az, s.shot.az) * k;
    s.cam.el += (s.shot.el - s.cam.el) * k;
    s.cam.dist *= Math.pow(s.shot.dist / s.cam.dist, k);
    for (var i = 0; i < 3; i++) s.cam.look[i] += (s.shot.look[i] - s.cam.look[i]) * k;
  } else if (!s.userCam) { s.cam.az = s.shot.az; s.cam.el = s.shot.el; s.cam.dist = s.shot.dist; s.cam.look = s.shot.look.slice(); }
  var b = _amBasis(st), c = s.cam, ch = Math.cos(c.el);
  if (shot.overview) { s.shotBody = null; _amOverviewShot(s, st, c); return; }
  if (shot.body) { _amBodyShot(s, st, shot, c, dt); return; }
  s.shotBody = null;
  // The shot turns about the vehicle's axis (az 0: from its up side, 90: from its right) and leans toward its tail by el.
  var off = [Math.sin(c.az) * ch * c.dist, -Math.sin(c.el) * c.dist, Math.cos(c.az) * ch * c.dist];
  var pos = _aeAdd(st.pos, _amLocal(b, off));
  var focus = _aeAdd(st.pos, _amLocal(b, c.look));
  var look = _aeNorm(_aeSub(focus, pos)), up = st.up;
  up = _aeSub(up, _aeScale(look, _aeDot(up, look)));
  up = _aeLen(up) < 1e-9 ? b.z : _aeNorm(up);
  s.pose = { pos: pos, up: up, look: look, tp: focus, fov: AM_FOV_DEG, nearRe: Math.max(0.2 * AM_MRE, c.dist * AM_MRE * AM_NEAR_PER_FOCUS) };
}
// The whole inner system from above the ecliptic: the camera over the Sun (c.dist Earth radii), looking down at it.
function _amOverviewShot(s, st, c) {
  var sun = _aeSunShown(_ae.scene), north = _aeNorm(_ephEclJ2000ToEqOfDate([0, 0, 1], _ae.scene.jde));
  var east = _aeNorm(_ephEclJ2000ToEqOfDate([1, 0, 0], _ae.scene.jde)), pos = _aeAdd(sun, _aeAdd(_aeScale(north, c.dist * 0.94), _aeScale(east, -c.dist * 0.34)));
  var look = _aeNorm(_aeSub(sun, pos));
  s.pose = { pos: pos, up: north, look: look, tp: sun, fov: AM_FOV_DEG, nearRe: c.dist * 1e-3 };
}
// A shot of a probe against a body it is passing (shot.body: a planet's key; shot.d: metres, shot.mix: how far toward the body the
// camera looks): from beyond the probe, the body behind it, turned about the line between them by az and lifted by el.
function _amBodyPose(st, body, shot, c) {
  var bp = _aeBodyPos(body);
  if (!bp) return null;
  var away = _aeNorm(_aeSub(st.pos, bp)), side = _aeCross(away, st.up);
  side = _aeLen(side) < 1e-9 ? _aeCross(away, [0, 0, 1]) : _aeNorm(side);
  var upv = _aeCross(side, away), d = c.dist * AM_MRE;
  var off = _aeAdd(_aeAdd(_aeScale(away, Math.cos(c.el) * Math.cos(c.az) * d), _aeScale(side, Math.cos(c.el) * Math.sin(c.az) * d)), _aeScale(upv, Math.sin(c.el) * d));
  var pos = _aeAdd(st.pos, off), focus = _aeAdd(st.pos, _aeScale(_aeSub(bp, st.pos), shot.mix == null ? 0.5 : shot.mix));
  return { pos: pos, up: upv, look: _aeNorm(_aeSub(focus, pos)), tp: focus, fov: AM_FOV_DEG, nearRe: Math.max(1e-9, d * AM_NEAR_PER_FOCUS) };
}
function _amBodyShot(s, st, shot, c, dt) {
  var pose = _amBodyPose(st, shot.body, shot, c);
  if (!pose) return;
  // Looking from one body to the other turns the camera about the craft, over AE_MISSION_REF.turnS, in place of a cut.
  if (s.shotBody !== shot.body) { s.turn = s.shotBody && !_aeReduceMotion() ? { from: s.shotBody, k: 0 } : null; s.shotBody = shot.body; }
  if (s.turn) {
    s.turn.k += dt / AE_MISSION_REF.turnS;
    var from = s.turn.k < 1 ? _amBodyPose(st, s.turn.from, shot, c) : null;
    if (from) pose = _amTurnPose(st, from, pose, _amSmooth(0, 1, s.turn.k)); else s.turn = null;
  }
  s.pose = pose;
}
// Two poses of one camera on one craft, k of the way from a to b: a turned about the craft's up, so the craft stays in view, and the small difference left at the end spread across the way.
function _amTurnPose(st, a, b, k) {
  var ax = _aeNorm(b.up), flat = function (v) { return _aeNorm(_aeSub(v, _aeScale(ax, _aeDot(v, ax)))); };
  var la = flat(a.look), lb = flat(b.look);
  var ang = Math.atan2(_aeDot(_aeCross(la, lb), ax), _aeDot(la, lb));
  var rot = function (v, th) {   // v about ax by th (Rodrigues)
    return _aeAdd(_aeAdd(_aeScale(v, Math.cos(th)), _aeScale(_aeCross(ax, v), Math.sin(th))), _aeScale(ax, _aeDot(ax, v) * (1 - Math.cos(th))));
  };
  var oa = _aeSub(a.pos, st.pos), ob = _aeSub(b.pos, st.pos);
  var off = _aeAdd(rot(oa, ang * k), _aeScale(_aeSub(ob, rot(oa, ang)), k));
  var look = _aeNorm(_aeAdd(rot(a.look, ang * k), _aeScale(_aeSub(b.look, rot(a.look, ang)), k)));
  var pos = _aeAdd(st.pos, off);
  return { pos: pos, up: b.up, look: look, tp: _aeAdd(pos, _aeScale(look, _aeLen(_aeSub(b.tp, b.pos)))), fov: b.fov, nearRe: b.nearRe };
}
// The view's camera description in place of the orbit camera's (almanac-earth.js _aePlaceCamera).
function _aeMissionCam(c) {
  var s = _ae.mission;
  return { tp: s.pose.tp, az: 0, el: 0, dist: 1, tanHalf: Math.tan(_aeRad(s.pose.fov) / 2), roll: 0, frame: null, pose: s.pose };
}
function _aeMissionNear(near) {
  var s = _ae.mission;
  return s && s.pose ? Math.max(1e-10, Math.min(near, s.pose.nearRe)) : near;
}

// ── The interface ──
var AM_ICONS = {
  alt: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V5M6 11l6-6 6 6M5 21h14"/></svg>',
  speed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-6"/></svg>',
  range: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M8 12h8"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  speedBtn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6l6 6-6 6M12 6l6 6-6 6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6l6 6-6 6"/></svg>',
  recentre: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',
  burn: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2c4 4 5 8 3 12l-3 6-3-6c-2-4-1-8 3-12z"/></svg>',
  pad: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2.2"/><path d="M12 8v7M8 11l4-1 4 1M9.5 21l2.5-6 2.5 6"/></svg>',
  split: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>',
  alarm: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 3l10 18H2z"/></svg>',
  dot: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>'
};
var AM_CSS = [
  '.am-mark{position:absolute;left:0;top:0;font-size:12px;color:#ffd166;white-space:nowrap;pointer-events:none;text-shadow:0 1px 2px #000,0 0 4px #000}.am-mark[hidden]{display:none}',
  '.am-dawn{position:absolute;left:-30%;right:-30%;pointer-events:none;opacity:0;background:linear-gradient(to bottom,rgba(255,120,50,0),rgba(255,150,70,.85) 48%,rgba(255,200,120,.55) 52%,rgba(255,120,50,0));mix-blend-mode:screen}',
  '.am-back{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 64px);transform:translateX(-50%);z-index:60;border:1px solid var(--amber-border);background:rgba(20,20,20,.82);color:var(--amber);border-radius:999px;padding:8px 16px;font:600 13px/1 inherit;cursor:pointer}',
  '.ae-view.ae-mission .ae-top,.ae-view.ae-mission .ae-bottom,.ae-view.ae-mission .ae-labels,.ae-view.ae-mission .ae-lms,.ae-view.ae-mission .ae-info,.ae-view.ae-mission .ae-set{display:none!important}',
  '.am-hud{position:absolute;inset:0;z-index:50;pointer-events:none;display:none;-webkit-user-select:none;user-select:none}',
  '.ae-view.ae-mission .am-hud{display:block}',
  '.am-layer{position:absolute;inset:0;pointer-events:auto;touch-action:none}',
  '.am-read{display:flex;gap:6px;pointer-events:none}',
  '.am-read span{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:10px;background:rgba(14,14,16,.7);border:1px solid var(--border);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-size:13px;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.am-read svg{color:var(--amber);flex:none}',
  '.ae-view.ae-mission.am-no-time .ae-pin{display:none}',
  '.am-dock{position:absolute;inset-inline:0;bottom:0;padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(to top,rgba(0,0,0,.72),rgba(0,0,0,0));pointer-events:none}',
  '.am-dock>*{pointer-events:auto}',
  '.am-phase{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 6px;color:var(--text)}',
  '.am-phase-t{flex:1;min-width:0;text-align:center}',
  '.am-phase-t b{display:block;font-size:17px;font-weight:600;text-shadow:0 1px 8px rgba(0,0,0,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.am-phase-t span{font-size:12px;color:var(--text2)}',
  '.am-track{position:relative;display:flex;gap:2px;height:30px;touch-action:none;cursor:pointer}',
  '.am-seg{position:relative;flex:1 1 0;min-width:0;border-radius:4px;background:rgba(255,255,255,.14);overflow:hidden}',
  '.am-seg i{position:absolute;inset:0 auto 0 0;background:var(--amber);opacity:.85;width:0}',
  '.am-seg[data-on="1"]{background:rgba(255,255,255,.26)}',
  '.am-thumb{position:absolute;top:-3px;bottom:-3px;width:3px;margin-left:-1.5px;border-radius:2px;background:#fff;box-shadow:0 0 6px rgba(0,0,0,.6);pointer-events:none}',
  '.am-ev{display:flex;gap:6px;overflow-x:auto;margin:8px -12px 0;padding:0 12px 2px}',
  '.am-strip{position:relative;height:84px;margin:2px 0 4px;touch-action:none;cursor:ew-resize;overflow:hidden}',
  '.am-sline{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none}.am-sline path{fill:none;stroke:rgba(255,255,255,.55);stroke-width:1}',
  '.am-snow{position:absolute;left:50%;top:0;transform:translateX(-50%);pointer-events:none;text-align:center}',
  '.am-snow i{display:block;font-style:normal;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);line-height:12px}',
  '.am-snow b{display:block;width:2px;height:17px;margin:9px auto 0;background:var(--amber);position:relative}',
  '.am-snow b::before{content:"";position:absolute;left:-4px;top:-5px;border:4px solid transparent;border-top-color:var(--amber);border-bottom:0}',
  '.am-smark{position:absolute;left:0;top:21px;width:14px;height:14px;margin-left:-7px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#0b0b0d;color:var(--text);pointer-events:none;will-change:transform}.am-smark[hidden]{display:none}.am-smark svg{width:11px;height:11px}',
  '.am-slab{position:absolute;top:40px;width:max-content;max-width:calc(50% - var(--am-step,90px) - 8px);padding:0;border:0;background:none;font:inherit;color:var(--text);cursor:pointer;display:block;text-shadow:0 1px 6px #000}.am-slab[hidden]{display:none}',
  '.am-slab::after{content:"";position:absolute;inset:-9px -6px}',
  '.am-slab b{display:block;font-size:12px;font-weight:600;line-height:14px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
  '.am-slab span{display:block;font-size:11px;line-height:13px;color:var(--text2);font-variant-numeric:tabular-nums}',
  '.am-slab-l{right:50%;text-align:right}.am-slab-r{left:50%;text-align:left}.am-slab-r span{color:var(--amber)}',
  '.am-fade{transition:opacity .25s,visibility 0s}',
  '.ae-view.ae-bare .am-fade{opacity:0;visibility:hidden;transition:opacity .25s,visibility 0s .25s}',
  '.am-hud.am-still .am-fade,.am-hud.am-still .am-line{transition:none!important}',
  '@media (prefers-reduced-motion:reduce){.am-fade,.ae-view.ae-bare .am-fade,.am-line{transition:none!important}}',
  '.am-line{position:absolute;inset-inline:12px;bottom:calc(env(safe-area-inset-bottom) + 4px);height:2px;border-radius:1px;background:rgba(255,255,255,.22);opacity:0;pointer-events:none;transition:opacity .25s}',
  '.am-line i{display:block;height:100%;width:0;border-radius:1px;background:var(--amber)}',
  '.ae-view.ae-bare .am-line{opacity:1}',
  '.am-chip{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(14,14,16,.72);border:1px solid var(--border);color:var(--text2);font-size:12px;white-space:nowrap;cursor:pointer}',
  '.am-chip svg{color:var(--amber)}',
  '.am-chip[data-near="1"]{color:var(--text);border-color:var(--amber-border)}',
  // A finger's hit area: the track's box takes 7px above and below and the chips 9px, so the gap between them is 16px (was 8); the chips scroll sideways and so clip theirs, so their row takes the room and gives it back in margin.
  '@media (pointer:coarse){.am-track::before{content:"";position:absolute;inset:-7px 0}.am-ev{padding-block:9px 11px;margin-block:7px -9px}.am-chip{position:relative}.am-chip::after{content:"";position:absolute;inset:-9px 0}}',
  '.am-ctl{display:flex;align-items:center;gap:8px;margin-top:8px}',
  '.am-ctl .am-gap{flex:1}',
  '.ae-view.am-steps-up .ah-info,.ae-view.am-steps-up #ae-cam{visibility:hidden}',
  '.am-ff{display:flex;align-items:center;gap:4px;height:' + AE_HIT_PX + 'px;padding:0 14px;border-radius:' + AE_HIT_PX / 2 + 'px;font:inherit;font-size:13px;font-variant-numeric:tabular-nums}.am-ff.am-ff-on{color:var(--amber);border-color:var(--amber-border)}',
  // The list of steps: over the dock, its rows the phases (name, when it began in UTC, how long), the one in progress marked.
  '.am-steps{position:absolute;left:50%;transform:translateX(-50%);width:min(520px,calc(100% - 24px));box-sizing:border-box;bottom:calc(100% + 6px);max-height:min(52vh,420px);overflow-y:auto;border-radius:16px;background:rgba(14,14,16,.92);border:1px solid var(--border);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);padding:6px}',
  '.am-steps ol{list-style:none;margin:0;padding:0}.am-steps button{display:grid;grid-template-columns:1fr auto;gap:2px 12px;width:100%;padding:8px 10px;border:0;border-radius:10px;background:none;color:var(--text);font:inherit;text-align:start;cursor:pointer}',
  '.am-steps button:hover{background:rgba(255,255,255,.06)}.am-steps button[aria-current="true"]{background:var(--amber-glow);color:var(--amber)}',
  '.am-steps b{font-size:14px;font-weight:600}.am-steps span{grid-column:1;font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums}.am-steps em{grid-column:2;grid-row:1/3;align-self:center;font-style:normal;font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums}',
  '@media (orientation:landscape) and (max-height:520px){.am-ev,.am-strip{display:none}.am-track{height:18px}.am-phase{margin:0 0 4px}.am-phase-t b{font-size:14px}.am-ctl{margin-top:4px}.am-dock{padding-top:4px}}'
].join('');
// The strip's parts: the line, NOW, a mark for every event (shown where it is near), and the two labels (the event just gone, hung to the left of its mark; the next, to the right of its).
function _amStripHtml(m) {
  return '<svg class="am-sline" aria-hidden="true"><path d=""/></svg><div class="am-snow"><i>' + _almEsc(_aeT('alm_now')) + '</i><b></b></div>' +
    _amStripEvents(m).map(function (e, j) { return '<i class="am-smark" data-j="' + j + '" hidden>' + (AM_ICONS[e.icon || 'dot'] || AM_ICONS.dot) + '</i>'; }).join('') +
    '<button type="button" class="am-slab am-slab-l" id="am-slab-l" hidden><b></b><span></span></button><button type="button" class="am-slab am-slab-r" id="am-slab-r" hidden><b></b><span></span></button>';
}
var AM_STRIP_REACH = 3, AM_STRIP_LINE_Y = 28;   // marks this many steps from NOW or nearer are drawn; the line crosses NOW this far down
// The line is an arc that curves up: its ends stand AE_MISSION_REF.stripSagPx lower than the middle, where NOW is. How far below the middle a place dx from it falls, in a strip w wide.
function _amArcY(w, dx) { var u = dx / (w / 2); return AE_MISSION_REF.stripSagPx * u * u; }   // marks this many steps from NOW or nearer are drawn
// How long light takes from a planet to the Earth at an instant (seconds; the view's own ephemeris): when an event there was heard.
function _amLightSec(planet, ms) {
  var jd = ms / MS_PER_DAY + JD_UNIX_EPOCH;
  return _aeLen(_aeSub(_ephBodyJ2000(planet, jd), _ephBodyJ2000('Earth', jd))) * AU_KM / SPEED_OF_LIGHT_KM_S;
}
// How long to an event, as the reader's language says it ("in 6 min", "55 sec. ago"); sign -1 for one that has happened.
function _amRelText(sec, sign) {
  var r = _amRelUnit(sec);
  return _orrFormatter('rel', function (lang) {
    try { return new Intl.RelativeTimeFormat(lang, { numeric: 'always', style: 'narrow' }); }
    catch (e) { return { format: function (n, u) { return (n < 0 ? '−' : '+') + Math.abs(n) + ' ' + u; } }; }
  }).format(sign < 0 ? -r.n : r.n, r.unit);
}
// Every frame: the marks and labels slide so that NOW stays in the middle; the labels' words change with the clock.
function _amStripTick(m, s, t, words) {
  var strip = s.stripEl || (s.stripEl = _aeById('am-strip'));
  if (!strip) return;
  if (!s.stripW || words) s.stripW = strip.clientWidth;
  var W = s.stripW, step = _amStripStep(W), at = _amStripAt(m, t), ev = _amStripEvents(m), f = at.i + at.u;
  var marks = s.marksEl || (s.marksEl = strip.querySelectorAll('.am-smark'));
  for (var j = 0; j < marks.length; j++) {
    var pos = j - f, near = Math.abs(pos) <= AM_STRIP_REACH;
    if (marks[j].hidden === near) marks[j].hidden = !near;
    if (near) marks[j].style.transform = 'translate(' + (W / 2 + pos * step).toFixed(1) + 'px,' + _amArcY(W, pos * step).toFixed(1) + 'px)';
  }
  s.stripStep = step;
  if (words) {
    strip.style.setProperty('--am-step', step + 'px');
    var sag = AE_MISSION_REF.stripSagPx;
    strip.querySelector('.am-sline path').setAttribute('d', 'M0,' + (AM_STRIP_LINE_Y + sag) + ' Q' + (W / 2) + ',' + (AM_STRIP_LINE_Y - sag) + ' ' + W + ',' + (AM_STRIP_LINE_Y + sag));
  }
  [['am-slab-l', at.i, -1, -at.u * step], ['am-slab-r', at.i + 1, 1, (1 - at.u) * step]].forEach(function (d) {
    var el = _aeById(d[0]), e = ev[d[1]];
    if (!el) return;
    if (el.hidden === !!e) el.hidden = !e;
    if (!e) return;
    el.style.transform = 'translate(' + d[3].toFixed(1) + 'px,' + _amArcY(W, d[3]).toFixed(1) + 'px)';
    if (!words && el.dataset.j === String(d[1])) return;
    var name = _amLabel(e), when = _amRelText(Math.abs(e.t - t), d[2]);
    if (e.heard && t >= e.t) {   // an event on another world: until its signal reaches the Earth, the time left for it
      var lt = _amLightSec(e.heard, s.zeroMs + e.t * 1000);
      if (t - e.t < lt) when = _aeT('alm_ms_on_earth', { when: _amRelText(lt - (t - e.t), 1) });
    }
    el.dataset.j = String(d[1]); el.dataset.t = String(e.t);
    if (el.firstChild.textContent !== name) el.firstChild.textContent = name;
    if (el.lastChild.textContent !== when) el.lastChild.textContent = when;
  });
}
// The clock goes to a mission time and stays: the scrubber's and the strip's drag.
function _amScrubTo(m, t) {
  var s = _ae.mission;
  s.scrubAt = performance.now();   // a drag through the hand-off's phase does not take the mission away: only playing into it does
  s.paused = true; _amSyncPlay();
  if (typeof _almClockNudge === 'function') _almClockNudge(new Date(s.zeroMs + t * 1000));
  if (typeof _almClockSetRate === 'function') _almClockSetRate(0);
  _ae.dirty = true; _aeKick();
}
// A drag along the strip moves the line under the finger: NOW slides through the events, and a drag let go near one lands on it.
function _amStripBind(m) {
  var s = _ae.mission, strip = _aeById('am-strip'), drag = null;
  var at = function (e) { return drag.f - (e.clientX - drag.x) / (s.stripStep || _amStripStep(strip.clientWidth)); };
  var jump = function (b) { s.paused = false; _amJump(m, +b.dataset.t - 2, true); _amSyncPlay(); };   // an event's name: the mission goes to a moment before it
  strip.addEventListener('pointerdown', function (e) {
    var a = _amStripAt(m, s.t), slab = e.target.closest ? e.target.closest('.am-slab') : null;
    // A finger that lands on an event's name holds and drags the line like one beside it (the names cover much of the line): only let go where it landed is it the name's tap.
    drag = { x: e.clientX, f: a.i + a.u, moved: false, playing: !s.paused, slab: slab && slab.dataset.t ? slab : null };
    s.paused = true; if (typeof _almClockSetRate === 'function') _almClockSetRate(0); _amSyncPlay();   // touching the line holds the mission where it is
    strip.setPointerCapture(e.pointerId);
  });
  strip.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 5) drag.moved = true;
    if (drag.moved) _amScrubTo(m, _amStripTime(m, at(e)));
  });
  var end = function (e) {
    if (!drag) return;
    if (drag.moved) {
      var f = at(e), j = Math.round(f);
      if (j >= 0 && j < _amStripEvents(m).length && Math.abs(f - j) < AM_STRIP_SNAP_STEP) _amScrubTo(m, _amStripEvents(m)[j].t);
    }
    var playing = drag.playing, tapped = !drag.moved && e.type === 'pointerup' ? drag.slab : null;
    drag = null;
    if (tapped) { jump(tapped); return; }
    if (playing) { s.paused = false; _amSetRate(m, _amPhaseAt(m, Math.max(s.t, m.phases[0].t))); _amSyncPlay(); }   // let go: it carries on from there
  };
  strip.addEventListener('pointerup', end); strip.addEventListener('pointercancel', end);
  strip.addEventListener('click', function (e) {   // (a key on the name; a pointer's tap is taken where the pointer lifts)
    var b = e.detail === 0 && e.target.closest ? e.target.closest('.am-slab') : null;
    if (b && b.dataset.t) jump(b);
  });
}
function _amHud(on) {
  var el = _ae && _ae.el;
  if (!el) return;
  var hud = _aeById('am-hud');
  if (!on) { if (hud) { hud.remove(); _aeHudOwn(null); } return; }
  if (!document.getElementById(AM_CSS_ID)) { var css = document.createElement('style'); css.id = AM_CSS_ID; css.textContent = AM_CSS; document.head.appendChild(css); }
  if (hud) hud.remove();
  var m = _amMission(), s = _ae.mission;
  hud = document.createElement('div');
  hud.className = 'am-hud' + (_aeReduceMotion() ? ' am-still' : ''); hud.id = 'am-hud';
  var lab = function (k) { return _almEsc(_aeT(k)); };
  var w = _amWidths(m);
  hud.innerHTML = '<div class="am-mark" id="am-mark" hidden></div><div class="am-dawn" id="am-dawn"></div><div class="am-layer" id="am-layer"></div>' +
    '<div class="am-read" id="am-read"><span id="am-alt">' + AM_ICONS.alt + '<b></b></span><span id="am-speed">' + AM_ICONS.speed + '<b></b></span><span id="am-range">' + AM_ICONS.range + '<b></b></span></div>' +
    '<div class="am-dock"><div class="am-line" id="am-line"><i></i></div><div class="am-phase"><button type="button" class="ae-btn ae-round am-fade" id="am-prev" aria-label="' + lab('alm_ms_prev') + '">' + AM_ICONS.prev + '</button><div class="am-phase-t"><b id="am-phase-name"></b><span id="am-phase-sub"></span></div><button type="button" class="ae-btn ae-round am-fade" id="am-next" aria-label="' + lab('alm_ms_next') + '">' + AM_ICONS.next + '</button></div>' +
    '<div class="am-strip" id="am-strip" role="group" aria-label="' + lab('alm_ms_events') + '">' + _amStripHtml(m) + '</div>' +
    '<div class="am-track am-fade" id="am-track">' + m.phases.map(function (p, i) { return '<div class="am-seg" data-i="' + i + '" title="' + _almEsc(_amLabel(p) + ' \u00b7 ' + _orrFmtSpan(_amPhaseEnd(m, i) - p.t)) + '" style="flex-grow:' + (w[i] * 1000).toFixed(1) + '"><i></i></div>'; }).join('') + '<div class="am-thumb" id="am-thumb"></div></div>' +
    '<div class="am-ev am-fade" id="am-ev"></div>' +
    '<div class="am-steps" id="am-steps" role="dialog" aria-label="' + lab('alm_ms_events') + '" hidden></div>' +
    '<div class="am-ctl am-fade"><button type="button" class="ae-btn ae-round" id="am-play" aria-label="' + lab('alm_ms_play') + '">' + AM_ICONS.pause + '</button>' +
    '<button type="button" class="ae-btn am-ff" id="am-ff" aria-label="' + lab('alm_ms_pace') + '">' + AM_ICONS.speedBtn + '<span></span></button><span class="am-gap"></span>' +
    '<button type="button" class="ae-btn ae-round" id="am-list" aria-label="' + lab('alm_ms_events') + '" aria-expanded="false">' + AM_ICONS.list + '</button></div></div>';
  el.appendChild(hud);
  _aeHudOwn(_aeById('am-read'));   // the readings stand in the info corner, bottom left
  _amBind(hud, m);
  _amSyncPlay();
}
function _amSyncPlay() {
  var s = _ae.mission, b = _aeById('am-play'), f = _aeById('am-ff');
  if (!s) return;
  if (b) b.innerHTML = s.paused ? AM_ICONS.play : AM_ICONS.pause;
  if (f) { f.lastChild.textContent = '\u00d7' + (s.ff || 1); f.classList.toggle('am-ff-on', (s.ff || 1) > 1); }
}
// Every phase in order, as a list: its name, when it began (UTC) and how long it lasted; a row goes there.
function _amStepsHtml(m, s) {
  return '<ol>' + m.phases.map(function (p, i) {
    var heard = m.events.filter(function (e) { return e.heard && e.t >= p.t && e.t < _amPhaseEnd(m, i) + 1; })[0], when = _amUtcText(m, p.t);
    if (heard) when += ' \u00b7 ' + _aeT('alm_ms_heard_later', { span: _orrFmtSpan(_amLightSec(heard.heard, m.zeroMs + heard.t * 1000)) });
    return '<li><button type="button" data-i="' + i + '" aria-current="' + (i === s.phaseIdx) + '"><b>' + _almEsc(_amLabel(p)) + '</b><span>' + _almEsc(when) + '</span><em>' + _almEsc(_orrFmtSpan(_amPhaseEnd(m, i) - p.t)) + '</em></button></li>';
  }).join('') + '</ol>';
}
function _amSteps(m, on) {
  var box = _aeById('am-steps'), b = _aeById('am-list'), s = _ae.mission;
  if (!box || !s) return;
  box.hidden = !on;
  if (b) b.setAttribute('aria-expanded', String(on));
  _ae.el.classList.toggle('am-steps-up', on);   // the info corner's readings stand aside while the list is up
  if (!on) return;
  box.innerHTML = _amStepsHtml(m, s);
  var cur = box.querySelector('[aria-current="true"]');
  if (cur) cur.scrollIntoView({ block: 'center' });
}
function _amBind(hud, m) {
  var s = _ae.mission;
  _aeById('am-play').onclick = function () {
    s.paused = !s.paused;
    if (!s.paused && s.t >= m.end) _amJump(m, m.start);
    _amSetRate(m, Math.max(0, s.phaseIdx));
    _amSyncPlay();
  };
  // The timeline: a press on a phase's tab goes to its start; dragging along the track scrubs.
  var track = _aeById('am-track'), drag = null;
  var scrubTo = function (e) {
    var r = track.getBoundingClientRect(), pos = _aeClamp((e.clientX - r.left) / r.width, 0, 1);
    _amScrubTo(m, _amTimeOf(m, pos));
  };
  track.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, moved: false, id: e.pointerId }; track.setPointerCapture(e.pointerId); });
  track.addEventListener('pointermove', function (e) { if (!drag) return; if (Math.abs(e.clientX - drag.x) > 5) drag.moved = true; if (drag.moved) scrubTo(e); });
  track.addEventListener('pointerup', function (e) {
    if (!drag) return;
    if (!drag.moved) {
      var seg = document.elementFromPoint(e.clientX, e.clientY), i = seg && seg.closest ? seg.closest('.am-seg') : null;
      if (i) { s.paused = false; _amJump(m, m.phases[+i.getAttribute('data-i')].t); _amSyncPlay(); }
    }
    drag = null;
  });
  _amStripBind(m);
  var step = function (d) {
    var i = _aeClamp(Math.max(0, s.phaseIdx) + d, 0, m.phases.length - 1);
    s.paused = false; _amJump(m, m.phases[i].t); _amSyncPlay();
  };
  _aeById('am-ff').onclick = function () {
    s.ff = AM_FF_STEPS[(AM_FF_STEPS.indexOf(s.ff || 1) + 1) % AM_FF_STEPS.length];
    if (s.paused) { s.paused = false; if (s.t >= m.end) _amJump(m, m.start); }   // fast forward plays
    _amSetRate(m, Math.max(0, s.phaseIdx));
    _amSyncPlay();
  };
  _aeById('am-list').onclick = function () { _amSteps(m, _aeById('am-steps').hidden); };
  _aeById('am-steps').onclick = function (e) {
    var row = e.target.closest('[data-i]');
    if (!row) return;
    _amSteps(m, false);
    s.paused = false; _amJump(m, m.phases[+row.getAttribute('data-i')].t); _amSyncPlay();
  };
  _aeById('am-prev').onclick = function () { step(-1); };
  _aeById('am-next').onclick = function () { step(1); };
  // The picture: a drag turns the camera round the vehicle, a pinch or the wheel brings it nearer.
  var layer = _aeById('am-layer'), ptrs = {}, last = null, tap = null;
  var take = function () { s.userCam = true; };
  hud.addEventListener('pointerdown', function (e) { if (e.target === layer) return; if (_aeBareOn()) _aeBare(false); }, true);
  layer.addEventListener('pointerdown', function (e) {
    tap = Object.keys(ptrs).length ? null : { x: e.clientX, y: e.clientY, at: performance.now() };
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; layer.setPointerCapture(e.pointerId); last = null;
  });
  layer.addEventListener('pointermove', function (e) {
    var p = ptrs[e.pointerId];
    if (!p || !s.cam) return;
    var ids = Object.keys(ptrs);
    if (ids.length === 1) {
      take();
      s.cam.az += (e.clientX - p.x) * AM_DRAG_RAD_PX;
      s.cam.el = _aeClamp(s.cam.el + (e.clientY - p.y) * AM_DRAG_RAD_PX, -AM_ORBIT_EL, AM_ORBIT_EL);
    } else if (ids.length === 2) {
      var o = ptrs[ids.filter(function (k) { return +k !== e.pointerId; })[0]], before = Math.hypot(p.x - o.x, p.y - o.y), after = Math.hypot(e.clientX - o.x, e.clientY - o.y);
      if (before > 4 && after > 4) { take(); s.cam.dist = _amClampDist(s.cam.dist * before / after); }
    }
    p.x = e.clientX; p.y = e.clientY;
    _ae.dirty = true; _aeKick();
  });
  var up = function (e) {
    delete ptrs[e.pointerId];
    if (e.type === 'pointerup' && tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < AM_TAP_PX && performance.now() - tap.at < AM_TAP_MS) {
      if (_aeBareOn()) _aeBare(false);   // (the controls never hide: a tap only brings back what another view hid)
    }
    tap = null;
  };
  layer.addEventListener('pointerup', up); layer.addEventListener('pointercancel', up); layer.addEventListener('lostpointercapture', up);
  layer.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!s.cam) return;
    take();
    s.cam.dist = _amClampDist(s.cam.dist * Math.exp(e.deltaY * AM_WHEEL_ZOOM));
    _ae.dirty = true; _aeKick();
  }, { passive: false });
}
function _amClampDist(d) { return Math.max(AM_DIST_MIN_M, Math.min(d, 4e9)); }

// The text that moves with the clock: elapsed time, the phase's name and where along it, the readouts, the timeline.
function _amHudTick(m, s, st, t, now) {
  var thumb = _aeById('am-thumb'), track = _aeById('am-track'), words = now - s.lastText >= AM_TEXT_MS;
  if (thumb && track) thumb.style.left = (_amPosOf(m, Math.max(m.start, Math.min(t, m.end))) * 100).toFixed(2) + '%';
  _amStripTick(m, s, t, words);
  var line = s.lineEl || (s.lineEl = _aeById('am-line'));
  if (line) line.firstChild.style.width = (_amPosOf(m, Math.max(m.start, Math.min(t, m.end))) * 100).toFixed(2) + '%';
  if (!words) return;
  s.lastText = now;
  if (typeof _almStripLead === 'function') _almStripLead(_amMet(t) + _amRateTail(), _amUtcText(m, t));   // the strip's first part is the mission's clock and its pace, then the real date and time
  _amPaintProgress(m, t);
  var rd = _amReadings(m, st, t, m.phases[Math.max(0, s.phaseIdx)]);
  var set = function (id, txt) {
    var e = _aeById(id);
    if (!e) return;
    e.hidden = txt === null;
    if (txt !== null && e.lastChild && e.lastChild.textContent !== txt) e.lastChild.textContent = txt;
  };
  set('am-alt', rd.alt === null ? null : rd.altAu ? _aeAuText(rd.alt) : _aeLenText(Math.max(0, rd.alt), rd.alt < 100 ? 1 : 0));
  set('am-speed', rd.speed === null ? null : _aeSpeedHourText(rd.speed));
  set('am-range', rd.far === null ? null : _aeFarText(rd.far));
}
// The three figures of the picture: how high over the body the phase reads against, how fast, how far from home.
var AM_AU_KM = 149597870.7, AM_AU_DAY_KMS = AM_AU_KM / 86400;
function _amReadings(m, st, t, ph) {
  var out = { alt: null, speed: null, far: null, altAu: false };
  if (!st) return out;
  if (st.leg.frame === 'probe') {   // a probe on its own table: its distance from the Sun, its speed, and how far the Earth is
    var tr = _aeTracks && _aeTracks.tracks[st.leg.key], jd = _ae.scene.jd;
    if (!tr) return out;
    var h = _aeTrackAt(tr, jd), e = _ephBodyJ2000('Earth', jd), h2 = _aeTrackAt(tr, jd + 0.01), h1 = _aeTrackAt(tr, jd - 0.01);
    if (!h) return out;
    out.alt = _aeLen(h); out.altAu = true;
    out.speed = h1 && h2 ? _aeLen(_aeSub(h2, h1)) / 0.02 * AM_AU_DAY_KMS : null;
    out.far = _aeLen(_aeSub(h, e)) * AM_AU_KM;
    return out;
  }
  if (st.leg.frame === 'helio') {
    var hp = st.km.p, he = _ephBodyJ2000('Earth', _ae.scene.jd);
    out.alt = _aeLen(hp); out.altAu = true; out.speed = _aeLen(st.km.v) * AM_AU_KM; out.far = _aeLen(_aeSub(hp, he)) * AM_AU_KM;
    return out;
  }
  var km = st.km, p = km.p, ref = ph.ref || 'earth', fr = st.leg.frame, moon = _amTable(m.ref.moon, t);
  if (fr === 'ecef') { out.alt = _aeLen(p) - _amEarthR(p); out.speed = _aeLen(km.v); out.far = _aeLen(moon.p); }
  else if (fr === 'eci') {
    var rel = ref === 'moon' ? _aeSub(p, moon.p) : p;
    out.alt = _aeLen(rel) - (ref === 'moon' ? AE_MOON_RADIUS_KM : AE_EARTH_RADIUS_KM);
    out.speed = _aeLen(ref === 'moon' ? _aeSub(km.v, moon.v) : km.v);
    out.far = ref === 'moon' ? _aeLen(moon.p) : _aeLen(_aeSub(p, moon.p));
  } else if (fr === 'mcmf') { out.alt = _aeLen(p) - AE_MOON_RADIUS_KM; out.speed = _aeLen(km.v); out.far = _aeLen(moon.p); }
  else {   // a planet's: its radius from the view's own table
    var b = _aePlanetBody(st.leg.body);
    out.alt = _aeLen(p) - (b ? b.km : 0); out.speed = _aeLen(km.v);
  }
  if (ph.far === false) out.far = null;
  if (ph.alt === false) out.alt = null;
  return out;
}
function _amEarthR(p) { return AE_EARTH_RADIUS_KM * (1 - AE_EARTH_FLATTENING * Math.pow(p[2] / (_aeLen(p) || 1), 2)); }
function _amPaintPhase(m, pi) {
  var ph = m.phases[pi];
  var n = _aeById('am-phase-name'); if (n) n.textContent = _amLabel(ph);
  var sub = _aeById('am-phase-sub'); if (sub) sub.textContent = ph.dist ? _aeFmtDate(m.zeroMs + ph.at * 1000) + ' \u00b7 ' + _aeFarText(ph.dist) : '';
  var segs = document.querySelectorAll('#am-track .am-seg');
  for (var i = 0; i < segs.length; i++) segs[i].dataset.on = i === pi ? '1' : '0';
  var ev = _aeById('am-ev');
  if (ev) {
    ev.innerHTML = '';
    if (pi === 0 && AM_PAD_IDS.indexOf(_ae.mission.id) >= 0) _amPadChip(ev, m);
    if (m.handoff && pi + 1 < m.phases.length && m.phases[pi + 1].k === m.handoff.phase) _amSiteChip(ev, m, pi + 1);
  }
}
// The phase before the landing offers to stand at the site at the landing instant, in place of waiting for the hand-off.
function _amSiteChip(ev, m, hi) {
  ev.insertAdjacentHTML('beforeend', '<button type="button" class="am-chip" id="am-site">' + AM_ICONS.pad + '<span>' + _almEsc(_aeT('alm_ms_site')) + '</span></button>');
  _aeById('am-site').onclick = function () { _amHandoff(m, hi); };
}
// The launch phase's way down to the pad (almanac-padview.js, fetched when it is pressed): a chip at the head of the phase's own.
var AM_PAD_IDS = AE_PAD_IDS;   // (the 3D view's: the Go to sheet lists the same pads)
function _amPadChip(ev, m) {
  var id = _ae.mission.id;
  ev.insertAdjacentHTML('afterbegin', '<button type="button" class="am-chip" id="am-pad">' + AM_ICONS.pad + '<span>' + _almEsc(_aeT('alm_pad_at')) + '</span></button>');
  _aeById('am-pad').onclick = function () {
    _aePadOpen(id, { back: { where: _aeT('alm_ms_' + id) === 'alm_ms_' + id ? m.name : _aeT('alm_ms_' + id), go: function () { _aeMissionOpen(id, m.start); } } });
  };
}
// Progress through the phases: each segment fills as the time passes through it.
function _amPaintProgress(m, t) {
  var segs = document.querySelectorAll('#am-track .am-seg i');
  for (var i = 0; i < segs.length; i++) {
    var a = m.phases[i].t, b = _amPhaseEnd(m, i);
    segs[i].style.width = (100 * _aeClamp((t - a) / (b - a), 0, 1)) + '%';
  }
}


// The address: mission is id,t,paused,pace: the mission, its T+ in seconds, 1 while paused, and a pace field that is always 1 now.
if (typeof _aeLinkModes !== 'undefined') {
  _aeLinkModes.mission = function () {
    var s = _ae && _ae.mission;
    if (!s || !_amMission() || s.t === undefined) return null;
    return [s.id, Number(s.t.toFixed(1)), s.paused ? 1 : 0, AM_LINK_PACE].join(',');
  };
}
