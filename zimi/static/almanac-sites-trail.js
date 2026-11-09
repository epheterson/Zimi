// A rover's whole journey, played on the timeline (almanac-sites.js): Curiosity's drives from Bradbury Landing to where it
// is now, Perseverance's from Jezero's floor, taken from NASA/JPL's waypoints (traverses-v1.json,
// scripts/build_traverses.py). A slider is the sol, a play button runs it; the rover stands where it stood at the end of
// that sol's drive, turned the way the track goes, the track drawn on the ground behind it and ahead of it, and the
// Almanac's clock moves to that sol at the hour the rover landed, so the Sun and the shadows are the ones it had.
// Loaded at the first press of the journey button.

// ── Constants ──
var AS_TRAVERSES_URL = '/static/earth/traverses-v1.json';
var AS_TRAIL_SECONDS = 70;                  // a replay from landing to now takes this long at its slowest setting
var AS_TRAIL_SPEEDS = [1, 3, 10];           // times that
var AS_TRAIL_CLOCK_MS = 450;                // the Almanac's clock moves to the sol at most this often
var AS_TRAIL_VIEW = { dist: 140, el: 0.55, distMax: 120000 };
var AS_TRAIL_LINE_UP_M = 0.8;               // the track lies this far over the ground
var AS_TRAIL_LINE_COLORS = [0xff8f3a, 0x5fd0ff];   // ahead, behind
var AS_TRAIL_TURN_K = 5;                    // 1/s: how fast the rover swings round to the way the track goes

var _asTraverses = null, _asTraversesLoading = null;
function _asTraversesLoad(then) {
  if (_asTraverses) { then(); return; }
  if (_asTraversesLoading) return;
  _asTraversesLoading = fetch(AS_TRAVERSES_URL).then(function (r) { if (!r.ok) throw new Error('traverses'); return r.json(); }).then(function (d) { _asTraverses = d; then(); }).catch(function () { _asTraversesLoading = null; });
}

// The track in the site's own frame: [sol, x, y] with x east and y north of the landing, metres.
function _asTrailLocal(st, pts) {
  var lat0 = st.lat, lon0 = st.lon, R = st.radiusM, k = Math.PI / 180, cosLat = Math.cos(lat0 * k);
  return pts.map(function (p) { return [p[0], (p[2] - lon0) * k * R * cosLat, (p[1] - lat0) * k * R]; });
}
// Where the rover is on its legs at a sol (fractional): its place and the way it faces there.
function _asTrailAt(legs, sol) {
  var lo = 0, hi = legs.length - 1;
  if (sol <= legs[0][0]) return { x: legs[0][1], y: legs[0][2], dx: 0, dy: 1, i: 0 };
  if (sol >= legs[hi][0]) { var q = legs[hi], p = legs[Math.max(0, hi - 1)]; return { x: q[1], y: q[2], dx: q[1] - p[1], dy: q[2] - p[2], i: hi }; }
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (legs[mid][0] <= sol) lo = mid; else hi = mid; }
  var a = legs[lo], b = legs[hi], f = (sol - a[0]) / (b[0] - a[0]);
  return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f, dx: b[1] - a[1], dy: b[2] - a[2], i: lo };
}
function _asTrailLines(st, legs) {
  var THREE = _ae.gl.THREE, n = legs.length, mk = function (color) {
    var geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: color }));
    line.frustumCulled = false;
    st.group.add(line);
    return { geo: geo, pos: pos, line: line };
  };
  var ahead = mk(AS_TRAIL_LINE_COLORS[0]), behind = mk(AS_TRAIL_LINE_COLORS[1]);
  legs.forEach(function (p, i) {
    var z = _asGroundAt(st, p[1], p[2], true) + AS_TRAIL_LINE_UP_M;
    [ahead, behind].forEach(function (L) { L.pos[i * 3] = p[1]; L.pos[i * 3 + 1] = p[2]; L.pos[i * 3 + 2] = z; });
  });
  behind.geo.setDrawRange(0, 0);
  return { ahead: ahead, behind: behind };
}

// ── The visit's trail ──
function _asTrailStart(st) {
  var rover = st.siteParts.filter(function (p) { return p.hubs; })[0], data = _asTraverses && _asTraverses[st.def.trail];
  if (!rover || !data || st.trail) return;
  var legs = _asTrailLocal(st, data.points), first = legs[0][0], last = legs[legs.length - 1][0];
  var t = st.trail = { data: data, legs: legs, rover: rover, sol: first, sols: [first, last], playing: true, speed: 0, hdg: rover.body.hdg, spin: 0, lastX: legs[0][1], lastY: legs[0][2], clockAt: 0, clockSol: null,
    lines: _asTrailLines(st, legs) };
  st.followPos = [legs[0][1], legs[0][2], 0];
  st.camera.dist = AS_TRAIL_VIEW.dist; st.camera.el = AS_TRAIL_VIEW.el; st.distMax = AS_TRAIL_VIEW.distMax;
  st.cx = 1e9;
  _asTrailUi(st);
}
function _asTrailStop(st) {
  var t = st.trail;
  if (!t) return;
  st.group.remove(t.lines.ahead.line); st.group.remove(t.lines.behind.line);
  t.lines.ahead.geo.dispose(); t.lines.behind.geo.dispose();
  st.trail = null; st.followPos = null;
  var bar = _aeById('as-trail');
  if (bar) bar.hidden = true;
}
// A frame: the sol moves on when playing, the rover is put where it was, the clock is told.
function _asTrailStep(st, dt) {
  var t = st.trail;
  if (!t) return;
  var span = t.sols[1] - t.sols[0];
  if (t.playing) {
    t.sol += dt * span / AS_TRAIL_SECONDS * AS_TRAIL_SPEEDS[t.speed];
    if (t.sol >= t.sols[1]) { t.sol = t.sols[1]; t.playing = false; _asTrailUi(st); }
  }
  var at = _asTrailAt(t.legs, t.sol), moved = Math.hypot(at.x - t.lastX, at.y - t.lastY);
  var want = Math.hypot(at.dx, at.dy) > 1e-6 ? Math.atan2(-at.dx, at.dy) : t.hdg;
  t.hdg += _aeAngleDeltaRad(t.hdg, want) * (1 - Math.exp(-AS_TRAIL_TURN_K * dt));
  t.spin += moved / t.rover.rm.radius;
  t.lastX = at.x; t.lastY = at.y;
  var gnd = _asWheelsGround(st, t.rover.hubs, at.x, at.y, t.hdg);
  _asRoverPlace(st, t.rover, at.x, at.y, t.hdg, gnd.mean, gnd.pitch, gnd.roll, t.spin, gnd, false);
  st.followPos = [at.x, at.y, gnd.mean];
  t.lines.behind.geo.setDrawRange(0, at.i + 1);
  var now = performance.now(), whole = Math.round(t.sol);
  if (whole !== t.clockSol && now - t.clockAt > AS_TRAIL_CLOCK_MS) {
    t.clockSol = whole; t.clockAt = now;
    _aeGoTo(t.data.landingMs + whole * _asTraverses.solSeconds * 1000);   // the hour it landed, that sol: the afternoon light
  }
  _asTrailUi(st);
}
// The bar: play and pause, the slider, the sol's number, the speed.
var AS_PLAY_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
var AS_PAUSE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
function _asTrailUi(st) {
  var t = st.trail, bar = _aeById('as-trail'), hud = _aeById('as-hud');
  if (!t || !hud) return;
  if (!bar) {
    var lbl = _almEsc(_aeT('alm_site_trail'));
    bar = document.createElement('div');
    bar.className = 'as-trail'; bar.id = 'as-trail';
    bar.innerHTML = '<button type="button" class="ae-btn ae-round" id="as-play" aria-label="' + lbl + '" title="' + lbl + '"></button>' +
      '<input type="range" id="as-sol" aria-label="' + lbl + '" min="0" max="1" step="1"><button type="button" class="ae-btn as-speed" id="as-speed"></button><span class="as-sol-n" id="as-sol-n"></span>';
    hud.appendChild(bar);
    if (!document.getElementById('as-trail-css')) {
      var css = document.createElement('style');
      css.id = 'as-trail-css';
      css.textContent = '.as-trail{position:absolute;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:10px;pointer-events:auto}' +
        '.as-trail input{flex:1;min-width:0;accent-color:#f59e0b;height:32px}.as-sol-n{min-width:44px;text-align:end;font-size:13px;color:var(--text2);font-variant-numeric:tabular-nums}' +
        '.as-speed{font-size:12px;min-width:38px}';
      document.head.appendChild(css);
    }
    var slider = _aeById('as-sol');
    slider.min = t.sols[0]; slider.max = t.sols[1];
    slider.oninput = function () { t.sol = +slider.value; t.playing = false; _asTrailUi(st); _aeKick(); };
    _aeById('as-play').onclick = function () { if (t.sol >= t.sols[1]) t.sol = t.sols[0]; t.playing = !t.playing; _asTrailUi(st); _aeKick(); };
    _aeById('as-speed').onclick = function () { t.speed = (t.speed + 1) % AS_TRAIL_SPEEDS.length; _asTrailUi(st); };
  }
  bar.hidden = false;
  var play = _aeById('as-play'), icon = t.playing ? AS_PAUSE_SVG : AS_PLAY_SVG;
  if (play.dataset.i !== icon) { play.dataset.i = icon; play.innerHTML = icon; }
  var slider2 = _aeById('as-sol'), whole = Math.round(t.sol);
  if (!t.dragging && +slider2.value !== whole) slider2.value = whole;
  var n = _aeById('as-sol-n'), txt = String(whole);
  if (n.textContent !== txt) n.textContent = txt;
  var sp = _aeById('as-speed'), spTxt = '×' + AS_TRAIL_SPEEDS[t.speed];
  if (sp.textContent !== spTxt) sp.textContent = spTxt;
}
