// The mission planner (almanac-missions.js): choose a planet and the planner draws a porkchop plot, the launch energy (C3) and arrival speed of
// every transfer from the Earth to it over a window of departure and arrival dates, each cell the conic that Lambert's problem gives between where the two
// planets are on those days. A tap on the plot picks a transfer; Fly it plays it on the timeline of the 3D view, the probe going round the Sun along the arc.
// The planets are the orrery's own (_ephBodyJ2000); the maths is scripts/mission_lambert.py, line for line.

// ── Constants ──
var AP_BODIES = [['mercury', 'Mercury'], ['venus', 'Venus'], ['mars', 'Mars'], ['jupiter', 'Jupiter'], ['saturn', 'Saturn']];
var AP_GM_SUN = 2.9591220828559115e-4;       // AU^3/day^2 (IAU 2015)
var AP_AU_KM = 149597870.7, AP_AU_DAY_KMS = AP_AU_KM / 86400;
var AP_GRID = 44;                            // cells either way
var AP_TOF_RANGE = [0.55, 1.9];
var AP_WINDOW_SHARE = 0.55;                   // the departure window, as a share of the synodic period              // flight times searched, as a share of the Hohmann transfer's
var AP_ARC_POINTS = 140;
var AP_C3_SPAN = 6;                          // the colour scale runs from the best C3 to this many times it
var AP_PLOT_H = 190;
var AP_ARC_COLOR = 0xffb454;
var AP_OVERVIEW_RE = 9000;                    // Earth radii above the Sun: the inner planets' orbits as the view draws them fit

// ── Lambert's problem (universal variables, Bate, Mueller and White 5.2) ──
function _apStumpff(z) {
  if (z > 1e-6) { var s = Math.sqrt(z); return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * s * s)]; }
  if (z < -1e-6) { var q = Math.sqrt(-z); return [(Math.cosh(q) - 1) / (-z), (Math.sinh(q) - q) / (q * q * q)]; }
  return [0.5 - z / 24, 1 / 6 - z / 120];
}
// Velocities at r1 and r2 of the conic joining them in tof (the GM's own time unit), going the way `pro` says about `normal`; null if there is none.
function _apLambert(r1, r2, tof, mu, pro, normal) {
  var n1 = _aeLen(r1), n2 = _aeLen(r2), c = _aeDot(r1, r2) / (n1 * n2), dnu = Math.acos(Math.max(-1, Math.min(1, c)));
  if ((_aeDot(_aeCross(r1, r2), normal) >= 0) !== pro) dnu = 2 * Math.PI - dnu;
  var A = Math.sin(dnu) * Math.sqrt(n1 * n2 / (1 - Math.cos(dnu)));
  if (!isFinite(A) || Math.abs(A) < 1e-12) return null;
  var sq = Math.sqrt(mu);
  var yOf = function (z) { var cs = _apStumpff(z); return n1 + n2 + A * (z * cs[1] - 1) / Math.sqrt(cs[0]); };
  var f = function (z) { var cs = _apStumpff(z), y = yOf(z); return Math.pow(y / cs[0], 1.5) * cs[1] + A * Math.sqrt(y) - sq * tof; };
  var hi = 4 * Math.PI * Math.PI - 1e-6, lo = -50;
  while (yOf(lo) < 0 && lo < hi) lo += 0.05;
  if (lo >= hi) return null;
  for (var i = 0; i < 200; i++) {
    var mid = 0.5 * (lo + hi);
    if (yOf(mid) < 0 || f(mid) < 0) lo = mid; else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  var z = 0.5 * (lo + hi), y = yOf(z), fl = 1 - y / n1, g = A * Math.sqrt(y / mu), gd = 1 - y / n2;
  if (!isFinite(g) || g === 0) return null;
  return { v1: _aeScale(_aeSub(r2, _aeScale(r1, fl)), 1 / g), v2: _aeScale(_aeSub(_aeScale(r2, gd), r1), 1 / g) };
}
function _apPlanet(name, jd) { return _ephBodyJ2000(name, jd); }
function _apVel(name, jd) {   // by a central difference of the orrery's place (AU/day)
  var a = _apPlanet(name, jd - 0.5), b = _apPlanet(name, jd + 0.5);
  return _aeSub(b, a);
}
// One transfer: the launch C3 (km^2/s^2), the arrival v-infinity (km/s) and the conic's departure state, or null.
function _apTransfer(dest, depJd, arrJd) {
  var r1 = _apPlanet('Earth', depJd), r2 = _apPlanet(dest, arrJd), nrm = _aeCross(r1, _apVel('Earth', depJd));
  var L = _apLambert(r1, r2, arrJd - depJd, AP_GM_SUN, true, nrm);
  if (!L) return null;
  var ve = _apVel('Earth', depJd), vp = _apVel(dest, arrJd);
  var dv1 = _aeLen(_aeSub(L.v1, ve)) * AP_AU_DAY_KMS, dv2 = _aeLen(_aeSub(L.v2, vp)) * AP_AU_DAY_KMS;
  if (!isFinite(dv1) || !isFinite(dv2)) return null;
  return { c3: dv1 * dv1, vinf: dv2, r1: r1, v1: L.v1 };
}
// How long between one launch window to a planet and the next: its synodic period with the Earth, in days (from the mean motions).
var AP_SYNODIC_D = { Mercury: 115.88, Venus: 583.92, Mars: 779.94, Jupiter: 398.88, Saturn: 378.09 };
function _apSynodic(dest) { return AP_SYNODIC_D[dest]; }
function _apHohmannDays(dest, jd) {
  var a1 = _aeLen(_apPlanet('Earth', jd)), a2 = _aeLen(_apPlanet(dest, jd)), a = (a1 + a2) / 2;
  return Math.PI * Math.sqrt(a * a * a / AP_GM_SUN);
}
// The grid of transfers: departures over a window centred on the cheapest launch of the next synodic period, arrivals across the flight times searched.
function _apCell(dest, dep, tof) {
  var tr = _apTransfer(dest, dep, dep + tof);
  return { dep: dep, arr: dep + tof, tof: tof, c3: tr ? tr.c3 : null, vinf: tr ? tr.vinf : null };
}
function _apCost(c) { return c.c3 === null ? Infinity : c.c3 + 4 * c.vinf * c.vinf; }
function _apPorkchop(dest, jd0) {
  var syn = _apSynodic(dest), tof0 = _apHohmannDays(dest, jd0), N = AP_GRID, i, j, coarse = null;
  for (i = 0; i < 60; i++) {   // the cheapest launch of the coming synodic period, from a coarse sweep
    for (j = 0; j < 8; j++) {
      var c = _apCell(dest, jd0 + syn * i / 59, tof0 * (AP_TOF_RANGE[0] + (AP_TOF_RANGE[1] - AP_TOF_RANGE[0]) * j / 7));
      if (!coarse || _apCost(c) < _apCost(coarse)) coarse = c;
    }
  }
  var span = syn * AP_WINDOW_SHARE, start = coarse.dep - span / 2, cells = [], best = null;
  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) {
      var cell = _apCell(dest, start + span * i / (N - 1), tof0 * (AP_TOF_RANGE[0] + (AP_TOF_RANGE[1] - AP_TOF_RANGE[0]) * j / (N - 1)));
      cell.i = i; cell.j = j;
      cells.push(cell);
      if (!best || _apCost(cell) < _apCost(best)) best = cell;
    }
  }
  return { dest: dest, jd0: start, span: span, tof0: tof0, N: N, cells: cells, best: best };
}
// The arc of a transfer as rows [t (s), x, y, z (AU), vx, vy, vz (AU/s)] by propagating its conic (Kepler's problem by universal variables).
function _apArc(dest, depJd, arrJd, tr) {
  var rows = [], T = (arrJd - depJd) * 86400, mu = AP_GM_SUN / 86400 / 86400;   // AU^3/s^2
  var r0 = tr.r1, v0 = _aeScale(tr.v1, 1 / 86400);
  for (var k = 0; k <= AP_ARC_POINTS; k++) {
    var t = T * k / AP_ARC_POINTS, st = _apKepler(r0, v0, t, mu);
    rows.push([t, st.r[0], st.r[1], st.r[2], st.v[0], st.v[1], st.v[2]]);
  }
  return rows;
}
function _apKepler(r0, v0, dt, mu) {
  var rn = _aeLen(r0), vr = _aeDot(r0, v0) / rn, alpha = 2 / rn - _aeDot(v0, v0) / mu, sm = Math.sqrt(mu);
  var chi = sm * Math.abs(alpha) * dt;
  for (var it = 0; it < 60; it++) {
    var z = alpha * chi * chi, cs = _apStumpff(z), F = rn * vr / sm * chi * chi * cs[0] + (1 - alpha * rn) * chi * chi * chi * cs[1] + rn * chi - sm * dt;
    var dF = rn * vr / sm * chi * (1 - alpha * chi * chi * cs[1]) + (1 - alpha * rn) * chi * chi * cs[0] + rn;
    var d = F / dF;
    chi -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  var zz = alpha * chi * chi, c = _apStumpff(zz), f = 1 - chi * chi / rn * c[0], g = dt - chi * chi * chi / sm * c[1];
  var r = _aeAdd(_aeScale(r0, f), _aeScale(v0, g)), rl = _aeLen(r);
  var fd = sm / (rl * rn) * (alpha * chi * chi * chi * c[1] - chi), gd = 1 - chi * chi / rl * c[0];
  return { r: r, v: _aeAdd(_aeScale(r0, fd), _aeScale(v0, gd)) };
}

// ── The sheet ──
var AP_CSS = [
  '.ap{position:absolute;inset-inline:0;bottom:0;z-index:55;padding:12px 12px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(to top,rgba(0,0,0,.9),rgba(0,0,0,.72) 85%,rgba(0,0,0,0));color:var(--text);display:none}',
  '.ae-view.ae-plan .ap{display:block}',
  '.ae-view.ae-plan .ae-top,.ae-view.ae-plan .ae-bottom{display:none!important}',
  '.ap-row{display:flex;gap:6px;overflow-x:auto;margin-bottom:8px;scrollbar-width:none}',
  '.ap-row::-webkit-scrollbar{display:none}',
  '.ap-chip{flex:none;padding:6px 12px;border-radius:999px;background:rgba(14,14,16,.78);border:1px solid var(--border);color:var(--text2);font-size:13px;cursor:pointer}',
  '.ap-chip[aria-pressed="true"]{color:var(--text);border-color:var(--amber-border);background:var(--amber-glow)}',
  '.ap canvas{display:block;width:100%;height:' + AP_PLOT_H + 'px;border-radius:10px;border:1px solid var(--border);touch-action:none;cursor:crosshair}',
  '.ap-read{display:flex;justify-content:space-between;gap:8px;margin:8px 0;font-size:13px;color:var(--text2);font-variant-numeric:tabular-nums}',
  '.ap-read b{color:var(--text);font-weight:600}',
  '.ap-ctl{display:flex;gap:8px;align-items:center}',
  '.ap-ctl .ap-fly{flex:1;min-height:40px;border-radius:12px;background:var(--amber);color:#111;font-weight:600;border:0;font-size:15px}',
  '.ap-axes{display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-top:3px}'
].join('');
var _ap = null;
function _apOpen() {
  if (!_ae || !_ae.el) return;
  if (_ae.mission) _amStop(true);
  _aeShowGo(false);
  if (!document.getElementById('ap-css')) { var st = document.createElement('style'); st.id = 'ap-css'; st.textContent = AP_CSS; document.head.appendChild(st); }
  var el = _aeById('ap');
  if (el) el.remove();
  el = document.createElement('div');
  el.className = 'ap'; el.id = 'ap';
  var lab = function (k) { return _almEsc(_aeT(k)); };
  el.innerHTML = '<div class="ap-row" id="ap-dest">' + AP_BODIES.map(function (b) {
    return '<button type="button" class="ap-chip" data-d="' + b[1] + '" aria-pressed="false">' + _almEsc(_tp(b[1])) + '</button>';
  }).join('') + '</div><canvas id="ap-plot" aria-label="' + lab('alm_ms_plan_plot') + '"></canvas><div class="ap-axes"><span id="ap-ax0"></span><span>' + lab('alm_ms_plan_axes') + '</span><span id="ap-ax1"></span></div>' +
    '<div class="ap-read" id="ap-read"></div><div class="ap-ctl"><button type="button" class="ae-btn ae-round" id="ap-x" aria-label="' + lab('alm_ms_close') + '">' + AM_ICONS.close + '</button>' +
    '<button type="button" class="ap-fly" id="ap-fly" disabled>' + lab('alm_ms_plan_fly') + '</button></div>';
  _ae.el.appendChild(el);
  _ae.el.classList.add('ae-plan');
  _ap = { dest: null, grid: null, pick: null, jd0: _aeDisplayMs() / 86400000 + JD_UNIX_EPOCH };
  _aeById('ap-x').onclick = _apClose;
  _aeById('ap-dest').onclick = function (e) { var b = e.target.closest ? e.target.closest('[data-d]') : null; if (b) _apChoose(b.getAttribute('data-d')); };
  _aeById('ap-fly').onclick = _apFly;
  var cv = _aeById('ap-plot');
  var tap = function (e) {
    if (!_ap.grid) return;
    var r = cv.getBoundingClientRect(), g = _ap.grid, x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
    var i = Math.min(g.N - 1, Math.max(0, Math.round(x * (g.N - 1)))), j = Math.min(g.N - 1, Math.max(0, Math.round(y * (g.N - 1))));
    _apPick(g.cells[i * g.N + j]);
  };
  cv.addEventListener('pointerdown', tap);
  cv.addEventListener('pointermove', function (e) { if (e.buttons) tap(e); });
  _apChoose('Mars');
}
function _apClose() {
  var el = _aeById('ap');
  if (el) el.remove();
  if (_ae && _ae.el) _ae.el.classList.remove('ae-plan');
  _ap = null;
}
function _apChoose(dest) {
  _ap.dest = dest;
  var chips = _aeById('ap-dest').querySelectorAll('[data-d]');
  for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', String(chips[i].getAttribute('data-d') === dest));
  _ap.grid = _apPorkchop(dest, _ap.jd0);
  _apDraw();
  _apPick(_ap.grid.best);
}
function _apDate(jd) { return _aeFmtDate((jd - JD_UNIX_EPOCH) * 86400000); }
function _apDraw() {
  var cv = _aeById('ap-plot'), g = _ap.grid;
  if (!cv || !g) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = AP_PLOT_H;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  var c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  var cw = W / g.N, ch = H / g.N, best = g.best ? g.best.c3 : 1, lim = best * AP_C3_SPAN;
  c.fillStyle = '#05060a'; c.fillRect(0, 0, W, H);
  g.cells.forEach(function (cell) {
    if (cell.c3 === null || cell.c3 > lim) return;
    var u = Math.max(0, Math.min(1, (cell.c3 - best) / (lim - best)));
    // from amber at the best to a dark blue where it is dear
    c.fillStyle = 'rgb(' + Math.round(245 - 205 * u) + ',' + Math.round(170 - 120 * u) + ',' + Math.round(60 + 20 * u) + ')';
    c.fillRect(cell.i * cw, H - (cell.j + 1) * ch, cw + 0.6, ch + 0.6);
  });
  if (_ap.pick) {
    var p = _ap.pick;
    c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    c.beginPath(); c.arc((p.i + 0.5) * cw, H - (p.j + 0.5) * ch, 6, 0, 6.2832); c.stroke();
  }
  _aeById('ap-ax0').textContent = _apDate(g.jd0);
  _aeById('ap-ax1').textContent = _apDate(g.jd0 + g.span);
}
function _apPick(cell) {
  if (!cell) return;
  _ap.pick = cell;
  _apDraw();
  var rd = _aeById('ap-read'), fly = _aeById('ap-fly');
  if (cell.c3 === null) { rd.textContent = ''; fly.disabled = true; return; }
  fly.disabled = false;
  rd.innerHTML = '<span>' + _almEsc(_apDate(cell.dep)) + ' → ' + _almEsc(_apDate(cell.arr)) + '</span><span>C3 <b>' + _orrNum(cell.c3, null, 1) + '</b> km²/s²</span><span>v∞ <b>' + _aeSpeedText(cell.vinf, 1) + '</b></span>';
}

// ── Fly it ──
function _apFly() {
  var cell = _ap && _ap.pick;
  if (!cell || cell.c3 === null) return;
  var tr = _apTransfer(_ap.dest, cell.dep, cell.arr), rows = _apArc(_ap.dest, cell.dep, cell.arr, tr), T = rows[rows.length - 1][0], dest = _ap.dest;
  var day = 86400;
  var m = {
    name: _tp('Earth') + ' → ' + _tp(dest), zeroMs: (cell.dep - JD_UNIX_EPOCH) * 86400000, start: -2 * day, end: T + 2 * day, follow: 'probe', ref: { moon: [] }, source: 'Lambert',
    vehicles: [{ id: 'probe', on: 0, off: T + 2 * day, dot: true, parts: [], flames: [], legs: [{ frame: 'helio', s: rows }] }],
    phases: [
      { t: -2 * day, k: 'alm_ms_ph_launch', en: 'Launch', w: 0.6, rate: day / 2, follow: 'probe', ref: 'sun', cam: { overview: true, d: AP_OVERVIEW_RE } },
      { t: 0, k: 'alm_ms_ph_cruise', en: 'Cruise', w: 3, rate: T / 40, follow: 'probe', ref: 'sun', cam: { overview: true, d: AP_OVERVIEW_RE } },
      { t: T - 2 * day, k: 'alm_ms_ph_approach', en: 'Approach', w: 0.6, rate: day / 2, follow: 'probe', ref: 'sun', cam: { overview: true, d: AP_OVERVIEW_RE } }
    ],
    events: [{ t: 0, k: 'alm_ms_ev_liftoff', en: 'Liftoff', icon: 'burn' }, { t: T, k: null, en: _tp(dest), icon: 'dot' }]
  };
  _apClose();
  _amLoad(function () {
    _amPrepare(m);
    _amData.missions.plan_run = m;
    _aeMissionOpen('plan_run');
    if (_ae.mission) _apArcLine(_ae.mission, rows);
  });
}

// The transfer's arc as a line, drawn on the view's scale round the Sun as it is shown each frame.
function _apArcLine(s, rows) {
  var S = _ae.gl, THREE = S.THREE, n = rows.length, geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  var line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: AP_ARC_COLOR, transparent: true, opacity: 0.8 }));
  line.frustumCulled = false;
  S.scene.add(line);
  s.onDraw = function () {
    var sc = _ae.scene, arr = geo.attributes.position.array, sun = _aeSunShown(sc);
    for (var i = 0; i < n; i++) {
      var h = [rows[i][1], rows[i][2], rows[i][3]], p = _aeAdd(sun, _aeScale(_aeNorm(_ephEclJ2000ToEqOfDate(h, sc.jde)), _aeShownDist(_aeLen(h))));
      arr[i * 3] = p[0]; arr[i * 3 + 1] = p[1]; arr[i * 3 + 2] = p[2];
    }
    geo.attributes.position.needsUpdate = true;
  };
  s.cleanup = function () { S.scene.remove(line); geo.dispose(); line.material.dispose(); };
}
