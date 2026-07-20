// ── Almanac: solar-system orrery ──
// Split out of almanac.js, which had grown past 5,900 lines.
// Keplerian planet positions, the canvas orrery, its speed/date controls and the rocket transits.
// Loaded before almanac.js; all almanac scripts share one global scope.

var _almanacOrreryRAF = null;

// Planet visual radius is now a fraction of canvas width — much bigger, Apple Watch style
var _PLANETS = {
  Mercury: { a: 0.38710, e: 0.20563, I: 7.005, L: 252.251, LP: 77.457, N: 48.331, da: 0, de: 0.00002, dI: -0.0060, dL: 149472.674, dLP: 0.160, dN: -0.125, color: '#b0a090', glow: '#c4b8a8', vr: 0.008 },
  Venus:   { a: 0.72333, e: 0.00677, I: 3.395, L: 181.980, LP: 131.564, N: 76.680, da: 0, de: -0.00005, dI: -0.0008, dL: 58517.816, dLP: 0.013, dN: -0.278, color: '#e8c87a', glow: '#f0d890', vr: 0.014 },
  Earth:   { a: 1.00000, e: 0.01671, I: 0.000, L: 100.464, LP: 102.937, N: 0, da: 0, de: -0.00004, dI: -0.0131, dL: 35999.373, dLP: 0.323, dN: 0, color: '#4a90d9', glow: '#6ab0ff', vr: 0.015 },
  Mars:    { a: 1.52368, e: 0.09340, I: 1.850, L: 355.453, LP: 336.060, N: 49.558, da: 0, de: 0.00008, dI: -0.0013, dL: 19140.300, dLP: 0.444, dN: -0.293, color: '#c46040', glow: '#e07050', vr: 0.011 },
  Jupiter: { a: 5.20260, e: 0.04849, I: 1.303, L: 34.351, LP: 14.331, N: 100.464, da: -0.00002, de: 0.00018, dI: -0.0055, dL: 3034.906, dLP: 0.215, dN: 0.177, color: '#c49868', glow: '#e0b888', vr: 0.032 },
  Saturn:  { a: 9.55491, e: 0.05551, I: 2.489, L: 50.077, LP: 93.057, N: 113.665, da: -0.00003, de: -0.00035, dI: 0.0033, dL: 1222.114, dLP: 0.752, dN: -0.250, color: '#d4b878', glow: '#f0da98', vr: 0.026, rings: true },
  Uranus:  { a: 19.1884, e: 0.04638, I: 0.773, L: 314.055, LP: 173.005, N: 74.006, da: -0.00002, de: -0.00002, dI: -0.0023, dL: 428.467, dLP: 0.009, dN: 0.074, color: '#78c8c8', glow: '#a0e8e8', vr: 0.018 },
  Neptune: { a: 30.0699, e: 0.00895, I: 1.770, L: 304.223, LP: 46.682, N: 131.784, da: 0.00003, de: 0.00001, dI: 0.0001, dL: 218.460, dLP: 0.010, dN: -0.005, color: '#3868c8', glow: '#5888f0', vr: 0.016 }
};

function _planetPosition(name, T) {
  var p = _PLANETS[name];
  var a = p.a + p.da * T;
  var e = p.e + p.de * T;
  var L = (p.L + p.dL * T) % 360;
  var LP = (p.LP + p.dLP * T) % 360;
  var M = ((L - LP) % 360 + 360) % 360;
  var Mrad = M * DEG_TO_RAD;
  var E = _solveKepler(Mrad, e);
  var xp = a * (Math.cos(E) - e);
  var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  var LPrad = LP * DEG_TO_RAD;
  var x = xp * Math.cos(LPrad) - yp * Math.sin(LPrad);
  var y = xp * Math.sin(LPrad) + yp * Math.cos(LPrad);
  return { x: x, y: y, r: Math.sqrt(x * x + y * y) };
}

var _orreryPlanetPositions = []; // [{name, x, y, r}] in CSS pixels for hover

function _initOrrery() {
  var canvas = document.getElementById('almanac-orrery');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth;
  canvas.width = w * dpr;
  canvas.height = w * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = w + 'px';
  canvas.style.borderRadius = '12px';
  // Cache DOM refs for RAF loop (avoids getElementById per frame)
  _orreryCanvas = canvas;
  _orreryDpr = dpr;
  _orrerySpeedLabel = document.getElementById('orrery-speed-label');
  _orrerySliderEl = document.getElementById('orrery-slider');
  _drawOrrery(canvas, dpr);

  // Hover tooltip for planet names
  var tooltip = document.getElementById('orrery-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'orrery-tooltip';
    tooltip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(0,0,0,0.75);color:#ccc;font-size:11px;padding:3px 8px;border-radius:4px;display:none;white-space:nowrap;z-index:10;backdrop-filter:blur(4px)';
    wrap.style.position = 'relative';
    wrap.appendChild(tooltip);
  }
  // Helper: find hit target (planet or voyager) at mouse position
  function _orreryHitTest(mx, my, tolerance) {
    for (var i = 0; i < _orreryPlanetPositions.length; i++) {
      var p = _orreryPlanetPositions[i];
      var dx = mx - p.x, dy = my - p.y;
      if (dx * dx + dy * dy < (p.r + tolerance) * (p.r + tolerance)) return { type: 'planet', data: p };
    }
    for (var i = 0; i < _voyagerPositions.length; i++) {
      var v = _voyagerPositions[i];
      var dx = mx - v.x, dy = my - v.y;
      if (dx * dx + dy * dy < (v.r + tolerance + 6) * (v.r + tolerance + 6)) return { type: 'voyager', data: v };
    }
    return null;
  }

  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var hit = _orreryHitTest(mx, my, 8);
    if (hit && hit.type === 'planet') {
      var label = _tp(hit.data.name);
      if (hit.data.name !== 'Earth') {
        var days = Math.round(_hohmannDays(_PLANETS['Earth'].a, _PLANETS[hit.data.name].a));
        if (days < 365) label += ' · ' + t('alm_transfer_days', { n: days });
        else label += ' · ' + t('alm_transfer_years', { n: (days / 365.25).toFixed(1) });
      }
      tooltip.textContent = label;
      tooltip.style.display = 'block';
      tooltip.style.left = (hit.data.x + hit.data.r + 8) + 'px';
      tooltip.style.top = (hit.data.y - 10) + 'px';
      canvas.style.cursor = hit.data.name !== 'Earth' ? 'pointer' : 'default';
    } else if (hit && hit.type === 'voyager') {
      var d = hit.data.dist;
      var sig = _signalDelay(d);
      tooltip.textContent = hit.data.name + ' · ' + d.toFixed(1) + ' AU · ' + _fmtDuration(sig.h, sig.m) + ' ' + t('alm_signal_delay');
      tooltip.style.display = 'block';
      tooltip.style.left = (hit.data.x + hit.data.r + 8) + 'px';
      tooltip.style.top = (hit.data.y - 10) + 'px';
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  };
  canvas.onmouseleave = function() { tooltip.style.display = 'none'; };

  // Click planet to launch rocket, or Voyager to show detail card
  canvas.onclick = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var hit = _orreryHitTest(mx, my, 10);
    if (hit && hit.type === 'planet' && hit.data.name !== 'Earth') {
      _orreryLaunchRocket(hit.data.name);
      tooltip.style.display = 'none';
    } else if (hit && hit.type === 'voyager') {
      _showVoyagerCard(hit.data.idx);
      tooltip.style.display = 'none';
    } else {
      _hideVoyagerCard();
    }
  };

  // Touch support for mobile — tap planet to launch, tap Voyager for detail
  canvas.addEventListener('touchend', function(e) {
    if (e.changedTouches.length === 0) return;
    var touch = e.changedTouches[0];
    var rect = canvas.getBoundingClientRect();
    var mx = touch.clientX - rect.left, my = touch.clientY - rect.top;
    var hit = _orreryHitTest(mx, my, 14);
    if (hit && hit.type === 'planet') {
      e.preventDefault();
      _orreryLaunchRocket(hit.data.name);
    } else if (hit && hit.type === 'voyager') {
      e.preventDefault();
      _showVoyagerCard(hit.data.idx);
    }
  });

  // Initial date display
  _orreryUpdateDate();
}

// Pre-computed orrery background stars (computed once, not per frame)
var _orreryBgStars = null;

function _ensureOrreryStars(W, dpr) {
  if (_orreryBgStars && _orreryBgStars.W === W) return _orreryBgStars.stars;
  var ss = 73;
  function sr() { ss = (ss * 16807) % 2147483647; return ss / 2147483647; }
  var stars = [];
  for (var i = 0; i < 40; i++) {
    stars.push({ x: sr() * W, y: sr() * W, b: 0.03 + sr() * 0.06, r: (0.3 + sr() * 0.4) * dpr });
  }
  _orreryBgStars = { W: W, stars: stars };
  return stars;
}

function _drawOrrery(canvas, dpr) {
  var ctx = canvas.getContext('2d');
  var W = canvas.width;
  var cx = W / 2, cy = W / 2;

  var simTime = Date.now() + _orreryTimeOffset;
  var JD = _dateToJD(simTime);
  var T = _jdToJulianCentury(JD);

  ctx.clearRect(0, 0, W, W);

  // Match page background
  ctx.fillStyle = '#0a0a0b';
  ctx.fillRect(0, 0, W, W);

  // Background stars — pre-computed positions, drawn every frame
  var bgStars = _ensureOrreryStars(W, dpr);
  for (var si = 0; si < bgStars.length; si++) {
    var st = bgStars[si];
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + st.b.toFixed(3) + ')';
    ctx.fill();
  }

  var names = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

  // z: how far the view has glided out toward the probes (0 = clean planet view
  // at "now", 1 = full deep space after scrubbing years away).
  var z = _orreryDeepFactor();

  // Orbit rings — Apple Watch style: visible but understated
  for (var i = 0; i < names.length; i++) {
    var orbitR = _orreryPlanetR(names[i], z) * W;
    ctx.beginPath();
    ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.7 * dpr;
    ctx.stroke();
  }

  // Asteroid belt — a faint stippled band in the Mars–Jupiter gap.
  (function () {
    var aIn = _orrR(2.1, z) * W, aOut = _orrR(3.3, z) * W;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, aOut, 0, Math.PI * 2);
    ctx.arc(cx, cy, aIn, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(200,190,170,0.06)';
    ctx.fill('evenodd');
    ctx.restore();
  })();

  // Deep-space reference rings — fade in as the view eases out (z), giving the
  // probes something to be "beyond".
  if (z > 0.02) {
    ctx.save();
    ctx.globalAlpha = z;
    var _refRing = function (au, col, dash, label) {
      var rr = _orrR(au, z) * W;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = col; ctx.lineWidth = 0.8 * dpr;
      ctx.setLineDash(dash ? [3 * dpr, 4 * dpr] : []);
      ctx.stroke();
      if (label) {
        ctx.setLineDash([]);
        ctx.font = (8 * dpr) + 'px -apple-system, system-ui, sans-serif';
        ctx.fillStyle = col; ctx.textAlign = 'center';
        ctx.fillText(label, cx, cy - rr - 3 * dpr);
      }
      ctx.restore();
    };
    var kIn = _orrR(_KUIPER_INNER_AU, z) * W, kOut = _orrR(_KUIPER_OUTER_AU, z) * W;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, kOut, 0, Math.PI * 2); ctx.arc(cx, cy, kIn, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(120,160,220,0.05)'; ctx.fill('evenodd');
    ctx.restore();
    _refRing(_HELIO_TERMINATION_AU, 'rgba(255,180,60,0.22)', true, null);
    _refRing(_HELIOPAUSE_AU, 'rgba(120,200,255,0.30)', true, t('alm_heliopause'));
    ctx.restore();
  }

  // Sun — large luminous glow, Apple Watch style
  var sunR = W * 0.022;

  // Wide outer haze
  var haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.14);
  haze.addColorStop(0, 'rgba(255,210,100,0.10)');
  haze.addColorStop(0.2, 'rgba(255,180,60,0.04)');
  haze.addColorStop(0.6, 'rgba(255,150,40,0.01)');
  haze.addColorStop(1, 'transparent');
  ctx.fillStyle = haze;
  ctx.beginPath(); ctx.arc(cx, cy, W * 0.14, 0, Math.PI * 2); ctx.fill();

  // Inner corona
  var corona = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR * 4);
  corona.addColorStop(0, 'rgba(255,240,200,0.25)');
  corona.addColorStop(0.3, 'rgba(255,200,100,0.10)');
  corona.addColorStop(0.7, 'rgba(255,160,60,0.03)');
  corona.addColorStop(1, 'transparent');
  ctx.fillStyle = corona;
  ctx.beginPath(); ctx.arc(cx, cy, sunR * 4, 0, Math.PI * 2); ctx.fill();

  // Sun disc
  var sd = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR);
  sd.addColorStop(0, '#fffff4');
  sd.addColorStop(0.4, '#fff0c0');
  sd.addColorStop(0.8, '#ffc840');
  sd.addColorStop(1, '#e08820');
  ctx.fillStyle = sd;
  ctx.beginPath(); ctx.arc(cx, cy, sunR, 0, Math.PI * 2); ctx.fill();

  // Planets — big, no labels, Apple Watch proportions
  _orreryPlanetPositions = [];
  for (var i = 0; i < names.length; i++) {
    var pos = _planetPosition(names[i], T);
    var angle = Math.atan2(pos.y, pos.x);
    var visR = _orreryPlanetR(names[i], z) * W;
    var px = cx + Math.cos(angle) * visR;
    var py = cy - Math.sin(angle) * visR;
    var p = _PLANETS[names[i]];
    var pr = p.vr * W; // planet radius as fraction of canvas

    // Glow halo
    var halo = ctx.createRadialGradient(px, py, pr * 0.5, px, py, pr * 2.5);
    halo.addColorStop(0, _hexToRgba(p.glow, 0.10));
    halo.addColorStop(1, 'transparent');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(px, py, pr * 2.5, 0, Math.PI * 2); ctx.fill();

    // Saturn's rings — drawn BEHIND planet body on far side, IN FRONT on near side
    if (p.rings) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-0.4);
      // A-ring (outer)
      var ringGrad = ctx.createLinearGradient(-pr * 3, 0, pr * 3, 0);
      ringGrad.addColorStop(0, 'rgba(200,180,120,0.10)');
      ringGrad.addColorStop(0.3, 'rgba(210,190,140,0.35)');
      ringGrad.addColorStop(0.5, 'rgba(220,200,150,0.40)');
      ringGrad.addColorStop(0.7, 'rgba(210,190,140,0.35)');
      ringGrad.addColorStop(1, 'rgba(200,180,120,0.10)');
      ctx.strokeStyle = ringGrad;
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath(); ctx.ellipse(0, 0, pr * 2.8, pr * 0.75, 0, 0, Math.PI * 2); ctx.stroke();
      // B-ring (inner, brighter)
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.ellipse(0, 0, pr * 2.2, pr * 0.58, 0, 0, Math.PI * 2); ctx.stroke();
      // Cassini division (dark gap)
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.5 * dpr;
      ctx.beginPath(); ctx.ellipse(0, 0, pr * 2.5, pr * 0.66, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Planet body — sphere with directional lighting from sun
    var lightAngle = Math.atan2(py - cy, px - cx);
    var hlX = px - Math.cos(lightAngle) * pr * 0.3;
    var hlY = py - Math.sin(lightAngle) * pr * 0.3;
    var pg = ctx.createRadialGradient(hlX, hlY, 0, px, py, pr);
    pg.addColorStop(0, _lighten(p.color, 50));
    pg.addColorStop(0.4, p.color);
    pg.addColorStop(1, _darken(p.color, 70));
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();

    // Jupiter bands
    if (names[i] === 'Jupiter') {
      ctx.save();
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.clip();
      var bands = [-0.55, -0.25, 0.1, 0.4, 0.65];
      for (var bi = 0; bi < bands.length; bi++) {
        ctx.fillStyle = bi % 2 === 0 ? 'rgba(140,90,50,0.22)' : 'rgba(190,150,90,0.15)';
        ctx.fillRect(px - pr, py + bands[bi] * pr - pr * 0.06, pr * 2, pr * 0.12);
      }
      // Great Red Spot hint
      ctx.beginPath();
      ctx.ellipse(px + pr * 0.25, py + pr * 0.3, pr * 0.15, pr * 0.1, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(180,80,50,0.20)';
      ctx.fill();
      ctx.restore();
    }

    // Earth — blue with green hints and white polar
    if (names[i] === 'Earth') {
      ctx.save();
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(40,130,60,0.30)';
      ctx.beginPath(); ctx.ellipse(px - pr * 0.15, py - pr * 0.1, pr * 0.45, pr * 0.35, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(px + pr * 0.3, py + pr * 0.25, pr * 0.3, pr * 0.2, -0.2, 0, Math.PI * 2); ctx.fill();
      // Polar ice
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.ellipse(px, py - pr * 0.85, pr * 0.5, pr * 0.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Mars — rusty with polar cap
    if (names[i] === 'Mars') {
      ctx.save();
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.beginPath(); ctx.ellipse(px, py - pr * 0.8, pr * 0.3, pr * 0.15, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Record position for hover (in CSS pixels)
    _orreryPlanetPositions.push({ name: names[i], x: px / dpr, y: py / dpr, r: pr / dpr });

    // No labels — clean Apple Watch aesthetic, hover tooltip on desktop
  }

  // ── Interstellar probes — amber diamonds out past Neptune, revealed as the
  // view eases into deep space (z) where they have room to visibly crawl. ──
  _voyagerPositions = [];
  ctx.save();
  ctx.globalAlpha = z;
  for (var vi = 0; z > 0.02 && vi < _VOYAGERS.length; vi++) {
    var v = _VOYAGERS[vi];
    var dist = _voyagerDist(v, simTime);
    if (dist <= 0) continue; // pre-launch
    var angle = v.lon * DEG_TO_RAD;
    var visR = _orrR(dist, z) * W;
    var vx = cx + Math.cos(angle) * visR;
    // Match the planets' Y convention (cy − sin): the probes were mirrored
    // across the horizontal axis, plotting each one 2×longitude off.
    var vy = cy - Math.sin(angle) * visR;
    var vs = 2.5 * dpr;
    // Subtle amber glow
    var vGlow = ctx.createRadialGradient(vx, vy, 0, vx, vy, vs * 4);
    vGlow.addColorStop(0, 'rgba(255,180,60,0.15)');
    vGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = vGlow;
    ctx.beginPath(); ctx.arc(vx, vy, vs * 4, 0, Math.PI * 2); ctx.fill();
    // Diamond shape (rotated square)
    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#ffb83c';
    ctx.fillRect(-vs, -vs, vs * 2, vs * 2);
    ctx.restore();
    // Small label
    ctx.font = (8 * dpr) + 'px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,184,60,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText(v.label || ('V' + (vi + 1)), vx + vs * 2.5, vy + vs * 0.5);
    _voyagerPositions.push({ name: v.name, x: vx / dpr, y: vy / dpr, r: vs * 1.5 / dpr, dist: dist, idx: vi });
  }
  ctx.restore();

  // ── Draw Hohmann transfer orbits + rockets (supports multiple simultaneous) ──
  for (var ri = 0; ri < _orreryRockets.length; ri++) {
    var rk = _orreryRockets[ri];
    var progress = Math.min(1, rk.elapsed / rk.duration);

    // Angular sweep
    var angSweep = rk.arrivalAngle - rk.launchAngle;
    if (rk.outbound) {
      while (angSweep <= 0) angSweep += 2 * Math.PI;
    } else {
      while (angSweep >= 0) angSweep -= 2 * Math.PI;
    }

    // Smooth visual-space path: cosine-eased radius between orbits.
    // The orrery uses compressed distances, so a physical Kepler ellipse looks
    // warped. Instead, interpolate directly in visual space with cosine easing
    // (tangent to both orbits at endpoints — matches real Hohmann geometry).
    var earthVisR = _orreryPlanetR('Earth', z) * W;
    var targetVisR = _orreryPlanetR(rk.target, z) * W;
    var _rocketPoint = (function(angSweep, rk, earthVisR, targetVisR, cx, cy) {
      return function(frac) {
        var angle = rk.launchAngle + frac * angSweep;
        var t = 0.5 - 0.5 * Math.cos(frac * Math.PI);
        var vr = earthVisR + (targetVisR - earthVisR) * t;
        return { x: cx + Math.cos(angle) * vr, y: cy - Math.sin(angle) * vr };
      };
    })(angSweep, rk, earthVisR, targetVisR, cx, cy);

    // Draw transfer path (fades after arrival)
    var pathAlpha = (rk.pathFade !== undefined ? rk.pathFade : 1) * 0.18;
    if (pathAlpha > 0.001) {
      ctx.save();
      ctx.setLineDash([4 * dpr, 6 * dpr]);
      ctx.strokeStyle = 'rgba(255,180,60,' + pathAlpha.toFixed(3) + ')';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (var ai = 0; ai <= 80; ai++) {
        var pt = _rocketPoint(ai / 80);
        if (ai === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // In-flight rocket
    if (!rk.arrived) {
      var rp = _rocketPoint(progress);
      var rkX = rp.x, rkY = rp.y;

      // Trail
      rk.trail.push({ x: rkX, y: rkY, age: 0 });
      for (var ti = rk.trail.length - 1; ti >= 0; ti--) {
        rk.trail[ti].age++;
        if (rk.trail[ti].age > 80) rk.trail.splice(ti, 1);
      }
      for (var ti = 0; ti < rk.trail.length; ti++) {
        var dot = rk.trail[ti];
        var tAlpha = (1 - dot.age / 80) * 0.55;
        var tR2 = (1 - dot.age / 80) * 2.5 * dpr;
        ctx.beginPath(); ctx.arc(dot.x, dot.y, tR2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,180,60,' + tAlpha.toFixed(3) + ')';
        ctx.fill();
      }

      // Heading
      var rpPrev = _rocketPoint(Math.max(0, progress - 0.005));
      var hdx = rkX - rpPrev.x, hdy = rkY - rpPrev.y;
      var heading = Math.atan2(-hdy, hdx);

      // Exhaust glow
      var exBX = rkX - Math.cos(heading) * 6 * dpr;
      var exBY = rkY + Math.sin(heading) * 6 * dpr;
      var exGlow = ctx.createRadialGradient(exBX, exBY, 0, exBX, exBY, 10 * dpr);
      exGlow.addColorStop(0, 'rgba(255,200,80,0.35)');
      exGlow.addColorStop(0.5, 'rgba(255,140,40,0.12)');
      exGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = exGlow;
      ctx.beginPath(); ctx.arc(exBX, exBY, 10 * dpr, 0, Math.PI * 2); ctx.fill();

      // Rocket body + flame
      ctx.save();
      ctx.translate(rkX, rkY);
      ctx.rotate(-heading + Math.PI / 2);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(0, -5 * dpr);
      ctx.lineTo(-2.2 * dpr, 3.5 * dpr);
      ctx.lineTo(2.2 * dpr, 3.5 * dpr);
      ctx.closePath();
      ctx.fill();
      var flameLen = (7 + Math.random() * 4) * dpr;
      ctx.fillStyle = 'rgba(255,160,40,0.85)';
      ctx.beginPath();
      ctx.moveTo(-1.5 * dpr, 3.5 * dpr); ctx.lineTo(0, flameLen); ctx.lineTo(1.5 * dpr, 3.5 * dpr);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,180,0.6)';
      ctx.beginPath();
      ctx.moveTo(-0.8 * dpr, 3.5 * dpr); ctx.lineTo(0, flameLen * 0.6); ctx.lineTo(0.8 * dpr, 3.5 * dpr);
      ctx.closePath(); ctx.fill();
      ctx.restore();

      // Transit label (only for the newest in-flight rocket)
      if (ri === _orreryRockets.length - 1 && progress > 0.05 && progress < 0.95) {
        var daysElapsed = Math.round(rk.elapsed / MS_PER_DAY);
        var totalDays = Math.round(rk.duration / MS_PER_DAY);
        ctx.font = (10 * dpr) + 'px -apple-system, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,200,100,0.6)';
        ctx.textAlign = 'left';
        ctx.fillText(daysElapsed + 'd / ' + totalDays + 'd', rkX + 10 * dpr, rkY + 4 * dpr);
      }
    }

    // Arrived — orbiting target planet
    if (rk.arrived) {
      var targetPos = null;
      for (var pi = 0; pi < _orreryPlanetPositions.length; pi++) {
        if (_orreryPlanetPositions[pi].name === rk.target) { targetPos = _orreryPlanetPositions[pi]; break; }
      }
      if (targetPos) {
        var tpx = targetPos.x * dpr, tpy = targetPos.y * dpr;
        var glowColor = _PLANETS[rk.target] ? _PLANETS[rk.target].glow : '#ffffff';

        if (rk.arrivalGlow > 0) {
          var glowR = (targetPos.r * dpr + 25 * dpr) * rk.arrivalGlow;
          ctx.beginPath(); ctx.arc(tpx, tpy, glowR * 0.8, 0, Math.PI * 2);
          ctx.strokeStyle = _hexToRgba(glowColor, 0.4 * rk.arrivalGlow);
          ctx.lineWidth = 2 * dpr; ctx.stroke();
          var arrGlow = ctx.createRadialGradient(tpx, tpy, targetPos.r * dpr * 0.5, tpx, tpy, glowR);
          arrGlow.addColorStop(0, _hexToRgba(glowColor, 0.5 * rk.arrivalGlow));
          arrGlow.addColorStop(0.4, _hexToRgba(glowColor, 0.2 * rk.arrivalGlow));
          arrGlow.addColorStop(1, 'transparent');
          ctx.fillStyle = arrGlow;
          ctx.beginPath(); ctx.arc(tpx, tpy, glowR, 0, Math.PI * 2); ctx.fill();
          for (var si = 0; si < 8; si++) {
            var sa = (si / 8) * Math.PI * 2 + rk.arrivalGlow * 3;
            var sd = glowR * (0.5 + 0.5 * rk.arrivalGlow);
            ctx.beginPath(); ctx.arc(tpx + Math.cos(sa) * sd, tpy + Math.sin(sa) * sd, 1.5 * dpr * rk.arrivalGlow, 0, Math.PI * 2);
            ctx.fillStyle = _hexToRgba(glowColor, 0.6 * rk.arrivalGlow); ctx.fill();
          }
        }

        // Rocket orbits the planet — small circular orbit, no flame
        var orbitDist = (targetPos.r * dpr + 8 * dpr);
        var orbAngle = rk.orbitAngle || 0;
        var orbX = tpx + Math.cos(orbAngle) * orbitDist;
        var orbY = tpy + Math.sin(orbAngle) * orbitDist;

        ctx.beginPath(); ctx.arc(tpx, tpy, orbitDist, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 0.5 * dpr; ctx.stroke();

        var orbHeading = orbAngle + Math.PI / 2;
        ctx.save();
        ctx.translate(orbX, orbY);
        ctx.rotate(-orbHeading + Math.PI / 2);
        ctx.fillStyle = '#ddd';
        ctx.beginPath();
        ctx.moveTo(0, -4 * dpr);
        ctx.lineTo(-1.8 * dpr, 3 * dpr);
        ctx.lineTo(1.8 * dpr, 3 * dpr);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

}

var _orreryPlaying = true;

var _orrerySpeed = 100000;

var _orreryTimeOffset = 0;       // milliseconds offset from real time

var _orreryLastFrame = 0;        // last rAF timestamp

// The orrery always shows the interstellar probes out past Neptune — the view
// sits at full "deep space" so they're always there and always creeping outward
// as the clock runs. (Kept as a factor, not a hard-coded scale, so the planet-
// vs-deep balance stays a one-line tuning knob.)
function _orreryDeepFactor() { return 1; }

// Planet orbit radius (fraction of half-width), blended between the hand-tuned
// planet view (_ORBIT_VIS) and the log deep-space map by the zoom factor z.
function _orreryPlanetR(name, z) {
  var near = _ORBIT_VIS[name] != null ? _ORBIT_VIS[name] : _auToVis(_PLANETS[name].a);
  return near * (1 - z) + _orrDeepRadius(_PLANETS[name].a) * z;
}

// Same blend for an arbitrary distance (rings, belts, probes): near-view uses
// the planet map (which pins everything past Neptune to the rim), deep uses log.
function _orrR(au, z) { return _auToVis(au) * (1 - z) + _orrDeepRadius(au) * z; }

var _orreryRockets = [];         // all rocket missions (in-flight + orbiting)

var _orreryAutoTransit = false;  // true when rocket launch controls speed profile

var _orreryCanvas = null;        // cached DOM refs for RAF loop

var _orrerySpeedLabel = null;

var _orrerySliderEl = null;

var _orreryDpr = 1;

// Hohmann transfer transit time in days
// Half-period of transfer ellipse: t = (T/2) where T = a^(3/2) years (Kepler's 3rd law)
function _hohmannDays(r1, r2) {
  return (365.25 / 2) * Math.pow((r1 + r2) / 2, 1.5);
}

function _transitEffectiveSpeed(rk) {
  var p = Math.max(0, Math.min(1, rk.elapsed / rk.duration));
  var rampUp = _smoothstep(0, 0.05, p);
  var rampDown = 1 - _smoothstep(0.95, 1.0, p);
  var blend = Math.min(rampUp, rampDown);
  return rk.departSpeed + blend * (rk.cruiseSpeed - rk.departSpeed);
}

function _orrerySliderInput(val) {
  _orreryAutoTransit = false; // Manual control disengages auto-transit
  var intVal = parseInt(val);
  // Manual input always wins — auto-transit was overwriting the slider
  // every frame, making speed unadjustable during a rocket flight.
  _orreryAutoTransit = false;
  _orrerySpeed = _sliderToSpeed(intVal);
  var label = document.getElementById('orrery-speed-label');
  if (label) label.textContent = _formatSpeed(_orrerySpeed);
  // Always animating — start if not already
  if (Math.abs(_orrerySpeed) > 1 && !_orreryPlaying) {
    _orreryPlaying = true;
    _orreryLastFrame = performance.now();
    _orreryAnimate();
  }
  // Back to 1× = stop fast-forwarding but keep real-time ticking
  if (Math.abs(_orrerySpeed) <= 1) {
    _orrerySpeed = 1;
    _orreryPlaying = false;
  }
}

function _orrerySetSlider(speed) {
  _orrerySpeed = speed;
  var slider = document.getElementById('orrery-slider');
  if (slider) slider.value = _speedToSlider(speed);
  var label = document.getElementById('orrery-speed-label');
  if (label) label.textContent = _formatSpeed(speed);
}

function _orrerySnapToNow() {
  _orreryAutoTransit = false;
  _orreryTimeOffset = 0;
  _orreryRockets = [];
  _orrerySetSlider(1);
  _orreryPlaying = false;
  var nowBtn = document.getElementById('orrery-now');
  if (nowBtn) nowBtn.style.display = 'none';
  _orreryShowTransit(false);
  _orreryUpdateDate();
  var canvas = document.getElementById('almanac-orrery');
  if (canvas) _drawOrrery(canvas, window.devicePixelRatio || 1);
}

function _orreryShowTransit(show) {
  var wrap = document.getElementById('orrery-transit-wrap');
  if (wrap) wrap.style.display = show ? 'flex' : 'none';
}

// Get the newest in-flight rocket (for transit slider control)
function _orreryGetActiveRocket() {
  for (var i = _orreryRockets.length - 1; i >= 0; i--) {
    if (!_orreryRockets[i].arrived) return _orreryRockets[i];
  }
  return null;
}

function _orreryTransitSlider(val) {
  var rk = _orreryGetActiveRocket();
  if (!rk) return;
  var frac = val / 1000;
  rk.elapsed = frac * rk.duration;
  var simLaunchTime = rk._launchRealTime || Date.now();
  _orreryTimeOffset = (simLaunchTime - Date.now()) + rk.elapsed;
  _orreryUpdateDate();
  _orreryUpdateTransitLabel();
  if (!_orreryPlaying) {
    var canvas = document.getElementById('almanac-orrery');
    if (canvas) _drawOrrery(canvas, window.devicePixelRatio || 1);
  }
}

function _orreryUpdateTransitLabel() {
  var label = document.getElementById('orrery-transit-label');
  var slider = document.getElementById('orrery-transit-slider');
  var rk = _orreryGetActiveRocket();
  if (!label || !rk) return;
  var daysElapsed = Math.round(rk.elapsed / MS_PER_DAY);
  var totalDays = Math.round(rk.duration / MS_PER_DAY);
  label.textContent = rk.target + ' · ' + daysElapsed + 'd / ' + totalDays + 'd';
  if (slider) {
    slider.value = Math.round((rk.elapsed / rk.duration) * 1000);
  }
}

function _orreryUpdateMissions() {
  var el = document.getElementById('orrery-missions');
  if (!el || _orreryRockets.length === 0) { if (el) el.style.display = 'none'; return; }
  el.style.display = 'block';
  var html = '';
  for (var i = 0; i < _orreryRockets.length; i++) {
    var rk = _orreryRockets[i];
    var totalD = Math.round(rk.duration / MS_PER_DAY);
    var color = _PLANETS[rk.target] ? _PLANETS[rk.target].color : '#888';
    if (rk.arrived) {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:2px 0">' +
        '<span style="color:' + color + '">●</span> ' + rk.target + ' \u2014 ' + t('alm_orbiting') +
        ' <span style="color:var(--text3);font-size:10px">(' + totalD + 'd transit)</span></div>';
    } else {
      var elapsedD = Math.round(rk.elapsed / MS_PER_DAY);
      var pct = Math.round((rk.elapsed / rk.duration) * 100);
      html += '<div style="display:flex;align-items:center;gap:6px;padding:2px 0">' +
        '<span style="color:' + color + '">●</span> → ' + rk.target +
        ' <span style="color:var(--amber)">' + pct + '%</span>' +
        ' <span style="color:var(--text3);font-size:10px">' + elapsedD + 'd / ' + totalD + 'd</span></div>';
    }
  }
  el.innerHTML = html;
}

function _orreryUpdateDate() {
  var el = document.getElementById('orrery-date');
  if (!el) return;
  var d = new Date(Date.now() + _orreryTimeOffset);
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  el.textContent = d.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });
  var nowBtn = document.getElementById('orrery-now');
  if (nowBtn) nowBtn.style.display = Math.abs(_orreryTimeOffset) > MS_PER_DAY ? '' : 'none';
}

function _orreryAnimate() {
  if (!_orreryPlaying || !_almanacOpen) {
    _almanacOrreryRAF = null;
    return;
  }
  var now = performance.now();
  var dt = now - _orreryLastFrame;
  _orreryLastFrame = now;

  // Auto-transit: modulate speed based on active rocket's flight progress
  if (_orreryAutoTransit) {
    var autoRk = _orreryGetActiveRocket();
    if (autoRk && !autoRk.arrived) {
      _orrerySpeed = _transitEffectiveSpeed(autoRk);
      if (_orrerySpeedLabel) _orrerySpeedLabel.textContent = _formatSpeed(_orrerySpeed);
      if (_orrerySliderEl) _orrerySliderEl.value = Math.min(_speedToSlider(_orrerySpeed), parseInt(_orrerySliderEl.max) || 60);
    }
  }

  // Advance simulated time
  _orreryTimeOffset += dt * _orrerySpeed;

  // Update all rocket missions
  var hasInFlight = false;
  for (var ri = 0; ri < _orreryRockets.length; ri++) {
    var rk = _orreryRockets[ri];
    rk.elapsed += dt * _orrerySpeed;
    if (rk.elapsed < 0) rk.elapsed = 0;
    var prog = rk.elapsed / rk.duration;
    // Un-arrive if rewinding past arrival
    if (prog < 1 && rk.arrived) { rk.arrived = false; rk.pathFade = 1.0; }
    if (prog >= 1 && !rk.arrived) {
      rk.arrived = true;
      rk.arrivalGlow = 1.0;
      rk.orbitAngle = 0;
      rk.trail = [];
    }
    if (rk.arrived) {
      if (rk.arrivalGlow > 0) {
        rk.arrivalGlow -= dt / 1500;
        if (rk.arrivalGlow < 0) rk.arrivalGlow = 0;
      }
      if (rk.pathFade > 0) {
        rk.pathFade -= dt / 3000;
        if (rk.pathFade < 0) rk.pathFade = 0;
      }
      rk.orbitAngle += dt * 0.001;
    } else {
      hasInFlight = true;
    }
  }
  // Transit slider tracks the newest in-flight rocket
  var activeRocket = _orreryGetActiveRocket();
  if (activeRocket) {
    _orreryUpdateTransitLabel();
  }
  if (!hasInFlight && _orreryRockets.length > 0) {
    _orreryShowTransit(false);
    if (_orreryAutoTransit) {
      _orreryAutoTransit = false;
      _orrerySetSlider(100000); // Return to default speed after arrival
    }
  }

  _orreryUpdateDate();
  _orreryUpdateMissions();

  if (_orreryCanvas) _drawOrrery(_orreryCanvas, _orreryDpr);

  // Live-update Voyager stats card if open
  if (_voyagerCardIdx >= 0) _updateVoyagerCard();

  _almanacOrreryRAF = requestAnimationFrame(_orreryAnimate);
}

function _orreryLaunchRocket(targetName) {
  if (targetName === 'Earth') return;

  var earthA = _PLANETS['Earth'].a;
  var targetA = _PLANETS[targetName].a;
  var transitDays = _hohmannDays(earthA, targetA);
  var transitMs = transitDays * MS_PER_DAY;

  // Compute launch and arrival positions
  var simNow = Date.now() + _orreryTimeOffset;
  var JD = _dateToJD(simNow);
  var T = _jdToJulianCentury(JD);
  var earthPos = _planetPosition('Earth', T);
  var launchAngle = Math.atan2(earthPos.y, earthPos.x);

  // Compute where the target planet will be at arrival time
  var arrivalJD = JD + transitDays;
  var T_arr = _jdToJulianCentury(arrivalJD);
  var targetPosArr = _planetPosition(targetName, T_arr);
  var arrivalAngle = Math.atan2(targetPosArr.y, targetPosArr.x);

  // Don't allow duplicate missions to the same planet
  for (var ri = _orreryRockets.length - 1; ri >= 0; ri--) {
    if (_orreryRockets[ri].target === targetName && !_orreryRockets[ri].arrived) {
      _orreryRockets.splice(ri, 1); // replace in-flight mission to same target
    }
  }
  // Speed profile: departure covers 2% of distance in ~1.5s, cruise covers 96% in ~9s
  var departSpeed = Math.max(10, Math.round(0.02 * transitMs / 1500));
  var cruiseSpeed = Math.max(departSpeed, Math.round(0.96 * transitMs / 9000));

  _orreryRockets.push({
    target: targetName,
    earthOrbit: earthA,
    targetOrbit: targetA,
    duration: transitMs,
    elapsed: 0,
    launchAngle: launchAngle,
    arrivalAngle: arrivalAngle,
    outbound: targetA > earthA,
    arrived: false,
    arrivalGlow: 0,
    pathFade: 1.0,
    trail: [],
    _launchRealTime: Date.now() + _orreryTimeOffset,
    departSpeed: departSpeed,
    cruiseSpeed: cruiseSpeed
  });
  _orreryShowTransit(true);
  _orreryUpdateTransitLabel();

  // Enable auto-transit speed profile
  _orreryAutoTransit = true;
  if (!_orreryPlaying) {
    _orrerySpeed = departSpeed;
    _orrerySetSlider(departSpeed);
    _orreryPlaying = true;
    _orreryLastFrame = performance.now();
    _orreryAnimate();
  }
}

var _PLANET_V0 = { Mercury: -0.61, Venus: -4.40, Mars: -1.60, Jupiter: -9.40, Saturn: -8.88, Uranus: -7.19, Neptune: -6.87 };

var _VISIBLE_PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
