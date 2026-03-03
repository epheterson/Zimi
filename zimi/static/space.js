// ── Space mini-app — astronomy easter egg ──
// Lazy-loaded when user clicks the Today card in Discover.
// _spaceOpen is declared in index.html (shared state).

var _spaceOrreryRAF = null;
var _spaceSkyRAF = null;
var _moonTexImg = new Image();
_moonTexImg.src = '/static/moon.png?v=1';

function _openSpaceInner() {
  _spaceOpen = true;
  history.pushState({ mode: 'space' }, '', location.pathname + location.search);
  var el = document.getElementById('space');
  el.classList.add('open');
  mainView.classList.add('hidden');
  _setWindowTitle('Space');
  _renderSpaceContent();
}

function closeSpace() {
  if (!_spaceOpen) return;
  _spaceOpen = false;
  if (_spaceOrreryRAF) { cancelAnimationFrame(_spaceOrreryRAF); _spaceOrreryRAF = null; }
  if (_spaceSkyRAF) { cancelAnimationFrame(_spaceSkyRAF); _spaceSkyRAF = null; }
  document.getElementById('space').classList.remove('open');
  mainView.classList.remove('hidden');
  _setWindowTitle('Zimi');
}

// ── Timezone formatting ──
function _formatTimezone() {
  try {
    // Try short timezone name first (e.g., "PST", "EST")
    var short = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' });
    var match = short.match(/[A-Z]{2,5}$/);
    if (match) return match[0];
    // Fall back to long name, extract readable part
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    // "America/Los_Angeles" → "Los Angeles"
    var parts = tz.split('/');
    return parts[parts.length - 1].replace(/_/g, ' ');
  } catch(e) { return ''; }
}

function _renderSpaceContent() {
  var now = new Date();
  var m = _moonPhase(now);
  var dist = _moonDistance(m.phase);
  var age = (m.phase * 29.53).toFixed(1);
  var untilNew = ((1 - m.phase) * 29.53).toFixed(1);

  var html = '<div class="space-inner">';
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var dateStr = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
  var timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  var tzName = _formatTimezone();
  html += '<div style="text-align:center;margin-bottom:24px">';
  html += '<div style="font-size:22px;font-weight:600;color:var(--text)">' + dateStr + '</div>';
  html += '<div style="font-size:16px;color:var(--text2);margin-top:4px">' + timeStr + (tzName ? ' &middot; ' + tzName : '') + '</div>';
  html += '</div>';

  // Hero moon
  html += '<div class="space-hero">';
  html += _renderSpaceMoon(m);
  html += '<div class="space-moon-name">' + m.name + '</div>';
  html += '<div class="space-moon-data">';
  html += '<div class="space-stat"><div class="space-stat-val">' + m.illumination + '%</div><div class="space-stat-lbl">Illumination</div></div>';
  html += '<div class="space-stat"><div class="space-stat-val">' + age + '</div><div class="space-stat-lbl">Moon Age (days)</div></div>';
  html += '<div class="space-stat"><div class="space-stat-val">' + Math.round(dist).toLocaleString() + '</div><div class="space-stat-lbl">Distance (km)</div></div>';
  html += '<div class="space-stat"><div class="space-stat-val">' + untilNew + '</div><div class="space-stat-lbl">Until New Moon</div></div>';
  html += '</div></div>';

  // Live sky scene
  html += '<div class="space-section">';
  html += '<div class="space-section-title">Live Sky</div>';
  html += '<div class="space-sky-wrap"><canvas id="space-sky-canvas"></canvas></div>';
  html += '<div class="space-sky-label" id="space-sky-label">Calculating...</div>';
  html += '</div>';

  // Orrery
  html += '<div class="space-section">';
  html += '<div class="space-section-title">Solar System</div>';
  html += '<div class="space-orrery-wrap"><canvas id="space-orrery"></canvas></div>';
  html += '</div>';

  // Astro data
  html += '<div class="space-section">';
  html += '<div class="space-section-title">Astronomical Data</div>';
  html += '<div id="space-astro"></div>';
  html += '</div>';

  // Sunrise/Sunset
  html += '<div class="space-section">';
  html += '<div class="space-section-title">Sun &amp; Daylight</div>';
  html += '<div id="space-sun">Loading location...</div>';
  html += '</div>';

  html += '</div>';
  document.getElementById('space-content').innerHTML = html;

  _renderAstroPanel(now);
  _initOrrery();
  _loadSunData(now);
}

// ── Moon rendering ──

function _renderSpaceMoon(m) {
  var litColor = '#e8e0d0', darkColor = '#0a0e1a';
  var illumFrac = m.illumination / 100;
  var leftColor, rightColor, overlayColor, overlayScaleX;
  if (m.phase <= 0.25) {
    leftColor = darkColor; rightColor = litColor;
    overlayColor = darkColor; overlayScaleX = 1 - illumFrac * 2;
  } else if (m.phase <= 0.5) {
    leftColor = darkColor; rightColor = litColor;
    overlayColor = litColor; overlayScaleX = (illumFrac - 0.5) * 2;
  } else if (m.phase <= 0.75) {
    leftColor = litColor; rightColor = darkColor;
    overlayColor = litColor; overlayScaleX = (illumFrac - 0.5) * 2;
  } else {
    leftColor = litColor; rightColor = darkColor;
    overlayColor = darkColor; overlayScaleX = 1 - illumFrac * 2;
  }
  var glowOpacity = (illumFrac * 0.3 + 0.05).toFixed(2);
  return '<div class="space-moon-glow" style="background:radial-gradient(circle, rgba(232,224,208,' + glowOpacity + ') 0%, transparent 70%)"></div>' +
    '<div class="space-moon">' +
    '<div class="dc-moon-half left" style="background:' + leftColor + '"></div>' +
    '<div class="dc-moon-half right" style="background:' + rightColor + '"></div>' +
    '<div class="dc-moon-term" style="background:' + overlayColor + ';transform:scaleX(' + overlayScaleX.toFixed(3) + ')"></div>' +
    '<div class="space-moon-texture" style="background:url(\'/static/moon.png?v=1\') center/cover;mix-blend-mode:soft-light;opacity:1"></div>' +
    '</div>';
}

function _moonDistance(phase) {
  return 384400 - 25150 * Math.cos(phase * 4 * Math.PI);
}

// ── Orrery: JPL Keplerian elements (J2000 epoch) ──

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

function _solveKepler(M, e) {
  var E = M;
  for (var i = 0; i < 10; i++) {
    var dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

function _planetPosition(name, T) {
  var p = _PLANETS[name];
  var a = p.a + p.da * T;
  var e = p.e + p.de * T;
  var L = (p.L + p.dL * T) % 360;
  var LP = (p.LP + p.dLP * T) % 360;
  var M = ((L - LP) % 360 + 360) % 360;
  var Mrad = M * Math.PI / 180;
  var E = _solveKepler(Mrad, e);
  var xp = a * (Math.cos(E) - e);
  var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  var LPrad = LP * Math.PI / 180;
  var x = xp * Math.cos(LPrad) - yp * Math.sin(LPrad);
  var y = xp * Math.sin(LPrad) + yp * Math.cos(LPrad);
  return { x: x, y: y, r: Math.sqrt(x * x + y * y) };
}

var _orreryPlanetPositions = []; // [{name, x, y, r}] in CSS pixels for hover

function _initOrrery() {
  var canvas = document.getElementById('space-orrery');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth;
  canvas.width = w * dpr;
  canvas.height = w * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = w + 'px';
  canvas.style.borderRadius = '12px';
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
  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var hit = null;
    for (var i = 0; i < _orreryPlanetPositions.length; i++) {
      var p = _orreryPlanetPositions[i];
      var dx = mx - p.x, dy = my - p.y;
      if (dx * dx + dy * dy < (p.r + 8) * (p.r + 8)) { hit = p; break; }
    }
    if (hit) {
      tooltip.textContent = hit.name;
      tooltip.style.display = 'block';
      tooltip.style.left = (hit.x + hit.r + 8) + 'px';
      tooltip.style.top = (hit.y - 10) + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  };
  canvas.onmouseleave = function() { tooltip.style.display = 'none'; };
}

// Orbit radii as fraction of canvas half-width (max ~0.46 to fit within square)
var _ORBIT_VIS = {
  Mercury: 0.06, Venus: 0.10, Earth: 0.14, Mars: 0.19,
  Jupiter: 0.27, Saturn: 0.34, Uranus: 0.41, Neptune: 0.47
};

function _drawOrrery(canvas, dpr) {
  var ctx = canvas.getContext('2d');
  var W = canvas.width;
  var cx = W / 2, cy = W / 2;

  var now = new Date();
  var JD = 2440587.5 + now.getTime() / 86400000;
  var T = (JD - 2451545.0) / 36525;

  ctx.clearRect(0, 0, W, W);

  // Match page background
  ctx.fillStyle = '#0a0a0b';
  ctx.fillRect(0, 0, W, W);

  // Background stars — very faint
  var _ss = 73;
  function _sr() { _ss = (_ss * 16807) % 2147483647; return _ss / 2147483647; }
  for (var si = 0; si < 40; si++) {
    var sx = _sr() * W, sy = _sr() * W;
    var sb = 0.03 + _sr() * 0.06;
    ctx.beginPath();
    ctx.arc(sx, sy, (0.3 + _sr() * 0.4) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + sb.toFixed(3) + ')';
    ctx.fill();
  }

  var names = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

  // Orbit rings — Apple Watch style: visible but understated
  for (var i = 0; i < names.length; i++) {
    var orbitR = _ORBIT_VIS[names[i]] * W;
    ctx.beginPath();
    ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.7 * dpr;
    ctx.stroke();
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
    var visR = _ORBIT_VIS[names[i]] * W;
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
  }

}

// ── Color helpers ──

function _hexToRgba(hex, alpha) {
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function _lighten(hex, amount) {
  var r = Math.min(255, parseInt(hex.slice(1,3), 16) + amount);
  var g = Math.min(255, parseInt(hex.slice(3,5), 16) + amount);
  var b = Math.min(255, parseInt(hex.slice(5,7), 16) + amount);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function _darken(hex, amount) {
  var r = Math.max(0, parseInt(hex.slice(1,3), 16) - amount);
  var g = Math.max(0, parseInt(hex.slice(3,5), 16) - amount);
  var b = Math.max(0, parseInt(hex.slice(5,7), 16) - amount);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ── Astro data panel ──

function _renderAstroPanel(now) {
  var el = document.getElementById('space-astro');
  if (!el) return;

  var y = now.getFullYear();
  var startOfYear = new Date(y, 0, 1);
  var dayOfYear = Math.floor((now - startOfYear) / 86400000) + 1;
  var daysInYear = ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;

  var seasonBounds = [
    { name: 'Winter', start: new Date(y - 1, 11, 21), end: new Date(y, 2, 20), next: 'Spring Equinox' },
    { name: 'Spring', start: new Date(y, 2, 20), end: new Date(y, 5, 21), next: 'Summer Solstice' },
    { name: 'Summer', start: new Date(y, 5, 21), end: new Date(y, 8, 22), next: 'Autumn Equinox' },
    { name: 'Autumn', start: new Date(y, 8, 22), end: new Date(y, 11, 21), next: 'Winter Solstice' },
    { name: 'Winter', start: new Date(y, 11, 21), end: new Date(y + 1, 2, 20), next: 'Spring Equinox' }
  ];
  var season = null;
  for (var si = 0; si < seasonBounds.length; si++) {
    if (now >= seasonBounds[si].start && now < seasonBounds[si].end) {
      season = seasonBounds[si];
      season.progress = (now - season.start) / (season.end - season.start);
      season.daysUntilNext = Math.ceil((season.end - now) / 86400000);
      break;
    }
  }

  var perihelion = new Date(y, 0, 3);
  var daysSincePeri = (now - perihelion) / 86400000;
  var earthSunDist = 149598023 * (1 - 0.0167 * Math.cos(daysSincePeri / 365.25 * 2 * Math.PI));
  var earthSunAU = (earthSunDist / 149597870.7).toFixed(4);

  var JD = 2440587.5 + now.getTime() / 86400000;
  var T = (JD - 2451545.0) / 36525;
  var sunLon = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
  if (sunLon < 0) sunLon += 360;
  var zodiac = [
    { name: 'Pisces', start: 351.6 }, { name: 'Aries', start: 28.7 },
    { name: 'Taurus', start: 53.4 }, { name: 'Gemini', start: 90.4 },
    { name: 'Cancer', start: 118.1 }, { name: 'Leo', start: 138.2 },
    { name: 'Virgo', start: 174.2 }, { name: 'Libra', start: 217.8 },
    { name: 'Scorpius', start: 241.1 }, { name: 'Sagittarius', start: 266.6 },
    { name: 'Capricornus', start: 300.0 }, { name: 'Aquarius', start: 327.9 }
  ];
  var constellation = zodiac[zodiac.length - 1].name;
  for (var zi = zodiac.length - 1; zi >= 0; zi--) {
    if (sunLon >= zodiac[zi].start) { constellation = zodiac[zi].name; break; }
  }

  var eclipses = [
    { date: '2026-03-03', type: 'Total Lunar', region: 'Americas, Europe, Africa' },
    { date: '2026-08-12', type: 'Total Solar', region: 'N. Russia, Greenland' },
    { date: '2026-08-28', type: 'Partial Lunar', region: 'Americas, Europe, Africa' },
    { date: '2027-02-06', type: 'Annular Solar', region: 'S. America, Africa' },
    { date: '2027-08-02', type: 'Total Solar', region: 'N. Africa, Middle East' },
    { date: '2028-01-12', type: 'Partial Lunar', region: 'Americas, Europe' },
    { date: '2028-07-22', type: 'Total Solar', region: 'Australia, NZ' }
  ];
  var nextEclipses = eclipses.filter(function(ec) {
    return new Date(ec.date + 'T00:00:00') >= now;
  }).slice(0, 3);

  var html = '<div class="space-info-grid">';
  html += '<div class="space-info-item"><div class="space-info-val">' + dayOfYear + ' / ' + daysInYear + '</div><div class="space-info-lbl">Day of Year</div></div>';
  if (season) {
    html += '<div class="space-info-item"><div class="space-info-val">' + season.name + '</div><div class="space-info-lbl">' + season.daysUntilNext + ' days to ' + season.next + '</div>' +
      '<div class="space-progress"><div class="space-progress-bar" style="width:' + Math.round(season.progress * 100) + '%"></div></div></div>';
  }
  html += '<div class="space-info-item"><div class="space-info-val">' + earthSunAU + ' AU</div><div class="space-info-lbl">Earth\u2013Sun Distance</div></div>';
  html += '<div class="space-info-item"><div class="space-info-val">' + constellation + '</div><div class="space-info-lbl">Sun Constellation</div></div>';
  html += '</div>';

  if (nextEclipses.length > 0) {
    html += '<div style="margin-top:16px">';
    html += '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">Upcoming Eclipses</div>';
    for (var ei = 0; ei < nextEclipses.length; ei++) {
      var ec = nextEclipses[ei];
      var ecDate = new Date(ec.date + 'T00:00:00');
      var daysUntil = Math.ceil((ecDate - now) / 86400000);
      var untilStr = daysUntil === 0 ? 'Today!' : daysUntil === 1 ? 'Tomorrow' : daysUntil + ' days';
      html += '<div class="space-eclipse-row">' +
        '<div><span class="space-eclipse-type">' + ec.type + '</span><br><span class="space-eclipse-date">' + ec.region + '</span></div>' +
        '<div class="space-eclipse-until">' + untilStr + '</div></div>';
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

// ── Sun & daylight ──

function _loadSunData(now) {
  var el = document.getElementById('space-sun');
  if (!el) return;
  var stored = localStorage.getItem('zimi_space_location');
  if (stored) {
    try {
      var loc = JSON.parse(stored);
      _renderSunInfo(el, now, loc.lat, loc.lon, loc.name);
      _initSkyScene(now, loc.lat, loc.lon);
      return;
    } catch(e) {}
  }
  var tzOffsetHours = -now.getTimezoneOffset() / 60;
  var estLon = tzOffsetHours * 15;
  var estLat = 34; // LA-ish default
  _renderSunInfo(el, now, estLat, estLon, null);
  _initSkyScene(now, estLat, estLon);
}

function _useGPSLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude, lon = pos.coords.longitude;
    localStorage.setItem('zimi_space_location', JSON.stringify({ lat: lat, lon: lon }));
    _renderSpaceContent();
  }, function() {}, { timeout: 8000 });
}

function _promptSpaceLocation() {
  var input = prompt('Enter latitude, longitude (e.g. 34.05, -118.25 for LA):');
  if (!input) return;
  var parts = input.split(',').map(function(s) { return parseFloat(s.trim()); });
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    localStorage.setItem('zimi_space_location', JSON.stringify({ lat: parts[0], lon: parts[1] }));
    _renderSpaceContent();
  }
}

function _renderSunInfo(el, now, lat, lon, locName) {
  var y = now.getFullYear();
  var start = new Date(y, 0, 1);
  var dayOfYear = Math.floor((now - start) / 86400000) + 1;
  var B = (dayOfYear - 1) * 2 * Math.PI / 365;
  var EoT = 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B) - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
  var decl = 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B) - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B) - 0.002697 * Math.cos(3 * B) + 0.00148 * Math.sin(3 * B);
  var latRad = lat * Math.PI / 180;
  var cosHA = (Math.cos(90.833 * Math.PI / 180) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));

  var html = '';
  if (cosHA > 1) {
    html = '<div class="space-info-grid"><div class="space-info-item" style="grid-column:1/-1;text-align:center"><div class="space-info-val">Polar Night</div><div class="space-info-lbl">The sun does not rise at this latitude today</div></div></div>';
  } else if (cosHA < -1) {
    html = '<div class="space-info-grid"><div class="space-info-item" style="grid-column:1/-1;text-align:center"><div class="space-info-val">Midnight Sun</div><div class="space-info-lbl">24 hours of daylight at this latitude today</div></div></div>';
  } else {
    var HA = Math.acos(cosHA) * 180 / Math.PI;
    var sunrise = 720 - 4 * (lon + HA) - EoT;
    var sunset = 720 - 4 * (lon - HA) - EoT;
    var tzOffset = -now.getTimezoneOffset();
    sunrise += tzOffset;
    sunset += tzOffset;
    var dayLength = sunset - sunrise;

    var cosGH = (Math.cos(84 * Math.PI / 180) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));
    var goldenStart = '';
    if (cosGH >= -1 && cosGH <= 1) {
      var HAgh = Math.acos(cosGH) * 180 / Math.PI;
      var ghEveningStart = 720 - 4 * (lon - HAgh) - EoT + tzOffset;
      goldenStart = _fmtMinutes(ghEveningStart);
    }

    var dayH = Math.floor(dayLength / 60);
    var dayM = Math.round(dayLength % 60);

    html = '<div class="space-info-grid">';
    html += '<div class="space-info-item"><div class="space-info-val">' + _fmtMinutes(sunrise) + '</div><div class="space-info-lbl">Sunrise</div></div>';
    html += '<div class="space-info-item"><div class="space-info-val">' + _fmtMinutes(sunset) + '</div><div class="space-info-lbl">Sunset</div></div>';
    html += '<div class="space-info-item"><div class="space-info-val">' + dayH + 'h ' + dayM + 'm</div><div class="space-info-lbl">Day Length</div></div>';
    if (goldenStart) {
      html += '<div class="space-info-item"><div class="space-info-val">' + goldenStart + '</div><div class="space-info-lbl">Golden Hour</div></div>';
    }
    html += '</div>';
  }

  // Location footer — clean, minimal
  var hasStored = localStorage.getItem('zimi_space_location');
  if (hasStored) {
    var locStr = lat.toFixed(2) + '\u00b0, ' + lon.toFixed(2) + '\u00b0';
    if (locName && locName !== 'Estimated from timezone') locStr = locName.replace(/</g, '&lt;');
    html += '<div style="margin-top:12px;text-align:center;font-size:11px;color:var(--text3)">' +
      locStr + ' &middot; <a class="space-location-link" onclick="_promptSpaceLocation()">change</a></div>';
  } else {
    html += '<div style="margin-top:12px;text-align:center;font-size:11px;color:var(--text3)">' +
      '<a class="space-location-link" onclick="' + (navigator.geolocation ? '_useGPSLocation()' : '_promptSpaceLocation()') + '">Set your location</a></div>';
  }
  el.innerHTML = html;
}

function _fmtMinutes(m) {
  m = ((m % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60);
  var min = Math.round(m % 60);
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + (min < 10 ? '0' : '') + min + ' ' + ampm;
}

// ── Live Sky Scene ──

var _skyStartTime = 0;

function _initSkyScene(now, lat, lon) {
  var canvas = document.getElementById('space-sky-canvas');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth;
  var h = Math.round(w / 2.5);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  var sunPos = _sunPosition(now, lat, lon);
  _skyStartTime = performance.now();

  var label = document.getElementById('space-sky-label');
  if (label) {
    var altStr = sunPos.altitude.toFixed(1);
    var desc = sunPos.altitude > 0 ? 'Sun altitude: ' + altStr + '\u00b0' : 'Sun below horizon (' + altStr + '\u00b0)';
    label.textContent = desc;
  }

  function _skyLoop(ts) {
    var t = (ts - _skyStartTime) / 1000;
    _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, t);
    _spaceSkyRAF = requestAnimationFrame(_skyLoop);
  }
  if (_spaceSkyRAF) cancelAnimationFrame(_spaceSkyRAF);
  _spaceSkyRAF = requestAnimationFrame(_skyLoop);
}

function _sunPosition(date, lat, lon) {
  var y = date.getFullYear();
  var start = new Date(y, 0, 1);
  var dayOfYear = Math.floor((date - start) / 86400000) + 1;
  var B = (dayOfYear - 1) * 2 * Math.PI / 365;
  var EoT = 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B) - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
  var decl = 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B) - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B) - 0.002697 * Math.cos(3 * B) + 0.00148 * Math.sin(3 * B);
  var solarTime = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + EoT + lon * 4;
  var hourAngle = (solarTime / 4 - 180) * Math.PI / 180;
  var latRad = lat * Math.PI / 180;
  var sinAlt = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  var altitude = Math.asin(sinAlt) * 180 / Math.PI;
  var cosAz = (Math.sin(decl) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(Math.asin(sinAlt)));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  var azimuth = Math.acos(cosAz) * 180 / Math.PI;
  if (hourAngle > 0) azimuth = 360 - azimuth;
  return { altitude: altitude, azimuth: azimuth };
}

// ── Constellation data — star positions + connecting lines ──
// Coordinates are [x%, y%] within the sky area (0-100, 0-55% of canvas height)

var _CONSTELLATIONS = [
  { name: 'Orion', stars: [
    [18, 12], [22, 10], [25, 14],  // shoulders + head
    [20, 22], [20, 26], [20, 30],  // belt
    [16, 38], [24, 36]             // feet
  ], lines: [[0,2],[2,1],[0,3],[2,3],[3,4],[4,5],[5,6],[5,7]] },
  { name: 'Big Dipper', stars: [
    [55, 8], [58, 6], [62, 7], [65, 10],  // bowl
    [68, 12], [73, 10], [78, 8]            // handle
  ], lines: [[0,1],[1,2],[2,3],[3,0],[3,4],[4,5],[5,6]] },
  { name: 'Cassiopeia', stars: [
    [82, 18], [85, 12], [88, 16], [91, 10], [94, 15]
  ], lines: [[0,1],[1,2],[2,3],[3,4]] },
  { name: 'Scorpius', stars: [
    [38, 32], [40, 28], [42, 24], [44, 22],  // body
    [43, 18], [45, 16],                        // claws
    [36, 36], [34, 40], [33, 44]               // tail
  ], lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[0,6],[6,7],[7,8]] },
  { name: 'Leo', stars: [
    [65, 30], [68, 26], [72, 28], [70, 32],  // head
    [74, 34], [78, 36]                         // body
  ], lines: [[0,1],[1,2],[2,3],[3,0],[3,4],[4,5]] }
];

function _drawConstellations(ctx, W, H, alpha, t) {
  var skyH = H * 0.55;
  ctx.save();
  for (var ci = 0; ci < _CONSTELLATIONS.length; ci++) {
    var c = _CONSTELLATIONS[ci];
    var pts = [];
    for (var si = 0; si < c.stars.length; si++) {
      pts.push({ x: c.stars[si][0] / 100 * W, y: c.stars[si][1] / 100 * skyH });
    }
    // Connecting lines — barely perceptible, only visible on close inspection
    ctx.strokeStyle = 'rgba(100,130,180,' + (alpha * 0.06).toFixed(3) + ')';
    ctx.lineWidth = 0.5;
    for (var li = 0; li < c.lines.length; li++) {
      var a = c.lines[li][0], b = c.lines[li][1];
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    }
    // Stars — slightly brighter than background, subtle twinkle
    for (var si = 0; si < pts.length; si++) {
      var twinkle = Math.sin(t * (1.5 + si * 0.3 + ci * 0.7)) * 0.1;
      var starAlpha = alpha * (0.25 + twinkle);
      ctx.beginPath();
      ctx.arc(pts[si].x, pts[si].y, 1.0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(160,180,220,' + starAlpha.toFixed(3) + ')';
      ctx.fill();
    }
  }
  ctx.restore();
}

function _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, t) {
  t = t || 0;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var alt = sunPos.altitude;
  var az = sunPos.azimuth;

  // Sky gradient
  var skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.68);
  if (alt > 15) {
    skyGrad.addColorStop(0, '#0e3158');
    skyGrad.addColorStop(0.35, '#1c5a8a');
    skyGrad.addColorStop(0.7, '#5ca0c8');
    skyGrad.addColorStop(1, '#a0d4e8');
  } else if (alt > 3) {
    skyGrad.addColorStop(0, '#132a4a');
    skyGrad.addColorStop(0.25, '#1e4a6e');
    skyGrad.addColorStop(0.55, '#8a7060');
    skyGrad.addColorStop(0.8, '#d4946a');
    skyGrad.addColorStop(1, '#e8b07a');
  } else if (alt > -2) {
    skyGrad.addColorStop(0, '#0a1828');
    skyGrad.addColorStop(0.3, '#1a2a40');
    skyGrad.addColorStop(0.6, '#804838');
    skyGrad.addColorStop(0.85, '#d06840');
    skyGrad.addColorStop(1, '#e8884a');
  } else if (alt > -8) {
    skyGrad.addColorStop(0, '#060c1a');
    skyGrad.addColorStop(0.4, '#0e1830');
    skyGrad.addColorStop(0.75, '#30202e');
    skyGrad.addColorStop(1, '#804838');
  } else if (alt > -14) {
    skyGrad.addColorStop(0, '#040810');
    skyGrad.addColorStop(0.5, '#08101e');
    skyGrad.addColorStop(1, '#1a1220');
  } else {
    skyGrad.addColorStop(0, '#030508');
    skyGrad.addColorStop(0.5, '#060910');
    skyGrad.addColorStop(1, '#080c14');
  }
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, H);

  // Atmospheric haze
  if (alt > -8) {
    var hazeY = H * 0.45;
    var hazeGrad = ctx.createLinearGradient(0, hazeY, 0, H * 0.68);
    var hazeOpacity = alt > 10 ? 0.08 : alt > 0 ? 0.15 : 0.06;
    hazeGrad.addColorStop(0, 'transparent');
    hazeGrad.addColorStop(1, 'rgba(255,200,150,' + hazeOpacity + ')');
    ctx.fillStyle = hazeGrad;
    ctx.fillRect(0, hazeY, W, H * 0.68 - hazeY);
  }

  // Stars — with real twinkling
  if (alt < 8) {
    var starOpacity = alt < -14 ? 1 : alt < -2 ? (-2 - alt) / 12 : Math.max(0, (8 - alt) / 20);
    var _seed = 42;
    function _srand() { _seed = (_seed * 16807 + 0) % 2147483647; return _seed / 2147483647; }
    for (var si = 0; si < 100; si++) {
      var sx = _srand() * W;
      var sy = _srand() * H * 0.55;
      var brightness = _srand();
      var sr = (0.4 + brightness * 1.0) * dpr;
      // Twinkling: each star has its own frequency and phase
      var twinkleFreq = 0.8 + _srand() * 2.0;
      var twinklePhase = _srand() * 6.28;
      var twinkle = Math.sin(t * twinkleFreq + twinklePhase) * 0.25;
      var alpha = starOpacity * Math.max(0.05, 0.3 + brightness * 0.5 + twinkle);
      var warm = _srand() > 0.7;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fillStyle = warm
        ? 'rgba(255,235,210,' + alpha.toFixed(3) + ')'
        : 'rgba(220,230,255,' + alpha.toFixed(3) + ')';
      ctx.fill();
    }

    // Constellations — visible when dark enough
    if (alt < -2) {
      _drawConstellations(ctx, W, H, starOpacity, t);
    }

    // Moon at night
    if (alt < 0) {
      var m = _moonPhase(now);
      var moonX = W * 0.78, moonY = H * 0.14;
      var moonR = 14 * dpr;
      var mgOuter = ctx.createRadialGradient(moonX, moonY, moonR, moonX, moonY, moonR * 4);
      mgOuter.addColorStop(0, 'rgba(220,215,200,' + (m.illumination / 500).toFixed(3) + ')');
      mgOuter.addColorStop(1, 'transparent');
      ctx.fillStyle = mgOuter;
      ctx.beginPath(); ctx.arc(moonX, moonY, moonR * 4, 0, Math.PI * 2); ctx.fill();
      // Draw moon with NASA texture
      ctx.save();
      ctx.beginPath(); ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2); ctx.clip();
      if (_moonTexImg && _moonTexImg.complete) {
        ctx.drawImage(_moonTexImg, moonX - moonR, moonY - moonR, moonR * 2, moonR * 2);
        // Brighten proportional to illumination — full moon should be bright
        var brighten = 0.10 + (m.illumination / 100) * 0.30;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(220,210,195,' + brighten.toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // Fallback while loading
        var moonGrad = ctx.createRadialGradient(moonX - moonR * 0.2, moonY - moonR * 0.2, 0, moonX, moonY, moonR);
        moonGrad.addColorStop(0, '#f0e8d8');
        moonGrad.addColorStop(0.8, '#e0d4c0');
        moonGrad.addColorStop(1, '#c8bca8');
        ctx.fillStyle = moonGrad;
        ctx.fill();
      }
      ctx.restore();
      if (m.illumination < 95) {
        var shadowOffset = moonR * (1 - m.illumination / 50);
        ctx.beginPath(); ctx.arc(moonX + shadowOffset, moonY, moonR * 0.97, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(5,8,12,0.92)';
        ctx.fill();
      }
    }
  }

  // Sun
  var sunX, sunY;
  if (alt > -8) {
    var sunXFrac = Math.max(0.1, Math.min(0.9, (az - 60) / 240));
    sunX = sunXFrac * W;
    sunY = H * 0.66 - (alt / 90) * H * 0.56;
    sunY = Math.max(H * 0.04, Math.min(H * 0.68, sunY));
    var sunR = (alt > 5 ? 12 : alt > 0 ? 14 : 10) * dpr;

    // God rays
    if (alt > -4 && alt < 20) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var rayOpacity = alt > 5 ? 0.03 : alt > 0 ? 0.06 : 0.04;
      for (var ri = 0; ri < 12; ri++) {
        var rayAngle = (ri / 12) * Math.PI - Math.PI / 2;
        var rayLen = H * 0.5;
        var rayW = sunR * (2 + ri % 3);
        ctx.beginPath();
        ctx.moveTo(sunX, sunY);
        ctx.lineTo(sunX + Math.cos(rayAngle) * rayLen - rayW, sunY + Math.sin(rayAngle) * rayLen);
        ctx.lineTo(sunX + Math.cos(rayAngle) * rayLen + rayW, sunY + Math.sin(rayAngle) * rayLen);
        ctx.closePath();
        var rayGrad = ctx.createRadialGradient(sunX, sunY, sunR, sunX, sunY, rayLen);
        var rayColor = alt > 5 ? '255,248,220' : '255,180,100';
        rayGrad.addColorStop(0, 'rgba(' + rayColor + ',' + rayOpacity + ')');
        rayGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = rayGrad;
        ctx.fill();
      }
      ctx.restore();
    }

    // Sun glow
    var glowR = (alt > 5 ? 80 : 100) * dpr;
    var sg = ctx.createRadialGradient(sunX, sunY, sunR * 0.5, sunX, sunY, glowR);
    var glowColor = alt > 10 ? '255,245,210' : alt > 0 ? '255,200,120' : '255,140,70';
    var glowOpacity = alt > 10 ? 0.2 : alt > 0 ? 0.3 : 0.2;
    sg.addColorStop(0, 'rgba(' + glowColor + ',' + glowOpacity + ')');
    sg.addColorStop(0.4, 'rgba(' + glowColor + ',' + (glowOpacity * 0.3) + ')');
    sg.addColorStop(1, 'transparent');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(sunX, sunY, glowR, 0, Math.PI * 2); ctx.fill();

    // Sun disc
    if (alt > -3) {
      var sd = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
      if (alt > 10) {
        sd.addColorStop(0, '#fffef5'); sd.addColorStop(0.6, '#fff3c4'); sd.addColorStop(1, '#ffe082');
      } else if (alt > 0) {
        sd.addColorStop(0, '#fff4d0'); sd.addColorStop(0.5, '#ffc864'); sd.addColorStop(1, '#ff9030');
      } else {
        sd.addColorStop(0, '#ff9050'); sd.addColorStop(0.5, '#e06030'); sd.addColorStop(1, '#b03820');
      }
      ctx.fillStyle = sd;
      ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Clouds
  if (alt > -6) {
    var _cs = 17;
    function _cr() { _cs = (_cs * 16807) % 2147483647; return _cs / 2147483647; }
    var cloudAlpha = alt > 10 ? 0.18 : alt > 0 ? 0.14 : 0.06;
    var cloudColor = alt > 5 ? '255,255,255' : alt > 0 ? '255,220,180' : '200,160,140';
    var clouds = [[0.15, 0.18, 0.18], [0.45, 0.08, 0.12], [0.65, 0.22, 0.1], [0.82, 0.12, 0.14], [0.28, 0.28, 0.08]];
    for (var ci = 0; ci < clouds.length; ci++) {
      var ccx = clouds[ci][0] * W, ccy = clouds[ci][1] * H, ccw = clouds[ci][2] * W;
      var cch = ccw * 0.2;
      for (var ce = 0; ce < 4; ce++) {
        var ex = ccx + (_cr() - 0.5) * ccw * 0.6;
        var ey = ccy + (_cr() - 0.5) * cch;
        var ew = ccw * (0.3 + _cr() * 0.5);
        var eh = cch * (0.5 + _cr() * 0.5);
        var cg = ctx.createRadialGradient(ex, ey, 0, ex, ey, Math.max(ew, eh));
        cg.addColorStop(0, 'rgba(' + cloudColor + ',' + (cloudAlpha * 0.8).toFixed(3) + ')');
        cg.addColorStop(0.5, 'rgba(' + cloudColor + ',' + (cloudAlpha * 0.3).toFixed(3) + ')');
        cg.addColorStop(1, 'transparent');
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.ellipse(ex, ey, ew, eh, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // Ocean
  var oceanTop = H * 0.66;
  var oceanGrad = ctx.createLinearGradient(0, oceanTop, 0, H);
  if (alt > 10) {
    oceanGrad.addColorStop(0, '#1e7090'); oceanGrad.addColorStop(0.3, '#186080');
    oceanGrad.addColorStop(0.6, '#124e68'); oceanGrad.addColorStop(1, '#0e3a50');
  } else if (alt > 0) {
    oceanGrad.addColorStop(0, '#184060'); oceanGrad.addColorStop(0.5, '#123450'); oceanGrad.addColorStop(1, '#0c2438');
  } else if (alt > -8) {
    oceanGrad.addColorStop(0, '#0c1e30'); oceanGrad.addColorStop(1, '#081420');
  } else {
    oceanGrad.addColorStop(0, '#060e18'); oceanGrad.addColorStop(1, '#040a10');
  }
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, oceanTop, W, H - oceanTop);

  // Water reflection
  if (alt > -6 && sunX !== undefined) {
    var refTop = oceanTop, refBot = H * 0.88;
    var refWidth = (alt > 5 ? 30 : 50) * dpr;
    var refColor = alt > 10 ? '255,248,220' : alt > 0 ? '255,200,120' : '255,140,80';
    var refAlpha = alt > 10 ? 0.12 : alt > 0 ? 0.18 : 0.08;
    for (var ri = 0; ri < 12; ri++) {
      var ry = refTop + (ri / 12) * (refBot - refTop);
      var rh = (refBot - refTop) / 14;
      var rw = refWidth * (0.5 + Math.sin(ri * 1.3 + t * 0.5) * 0.3);
      var rx = sunX - rw / 2 + Math.sin(ri * 2.1 + t * 0.3) * 4 * dpr;
      var ra = refAlpha * (1 - ri / 14);
      ctx.fillStyle = 'rgba(' + refColor + ',' + ra.toFixed(3) + ')';
      ctx.fillRect(rx, ry, rw, rh * 0.6);
    }
  }

  // Waves — animated
  var waveAlpha = alt > 5 ? 0.07 : alt > 0 ? 0.05 : 0.025;
  for (var wi = 0; wi < 8; wi++) {
    var wy = oceanTop + (wi + 1) * (H * 0.88 - oceanTop) / 9;
    var waveFreq = 20 + wi * 5;
    var waveAmp = (1.5 + wi * 0.3) * dpr;
    var waveSpeed = (0.3 + wi * 0.08) * t;
    ctx.beginPath();
    ctx.moveTo(0, wy);
    for (var wx = 0; wx < W; wx += 2 * dpr) {
      ctx.lineTo(wx, wy + Math.sin(wx / (waveFreq * dpr) + wi * 1.7 + waveSpeed) * waveAmp);
    }
    ctx.strokeStyle = 'rgba(255,255,255,' + (waveAlpha * (1 - wi * 0.08)).toFixed(3) + ')';
    ctx.lineWidth = (1 + wi * 0.1) * dpr;
    ctx.stroke();
  }

  // Beach
  var beachTop = H * 0.88;
  var sandGrad = ctx.createLinearGradient(0, beachTop, 0, H);
  if (alt > 10) {
    sandGrad.addColorStop(0, '#c8a870'); sandGrad.addColorStop(0.3, '#b89860'); sandGrad.addColorStop(1, '#a08050');
  } else if (alt > 0) {
    sandGrad.addColorStop(0, '#8a704a'); sandGrad.addColorStop(1, '#6a5438');
  } else {
    sandGrad.addColorStop(0, '#2e2418'); sandGrad.addColorStop(1, '#1e1810');
  }
  ctx.fillStyle = sandGrad;
  ctx.beginPath();
  ctx.moveTo(0, beachTop);
  for (var bx = 0; bx <= W; bx += 2 * dpr) {
    var by = beachTop + Math.sin(bx / (80 * dpr) + t * 0.2) * 2 * dpr + Math.sin(bx / (30 * dpr) + 0.5 + t * 0.35) * 1.5 * dpr;
    ctx.lineTo(bx, by);
  }
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fill();

  // Wet sand
  var wetGrad = ctx.createLinearGradient(0, beachTop - 2 * dpr, 0, beachTop + 6 * dpr);
  wetGrad.addColorStop(0, 'transparent');
  wetGrad.addColorStop(0.5, alt > 0 ? 'rgba(100,140,160,0.15)' : 'rgba(40,60,70,0.1)');
  wetGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = wetGrad;
  ctx.fillRect(0, beachTop - 2 * dpr, W, 8 * dpr);

  // Palm trees — lush filled fronds
  _drawPalmTree(ctx, W * 0.06, beachTop + 3 * dpr, H * 0.42, dpr, alt, -0.12, t);
  _drawPalmTree(ctx, W * 0.14, beachTop + 5 * dpr, H * 0.32, dpr, alt, 0.08, t);
  _drawPalmTree(ctx, W * 0.90, beachTop + 3 * dpr, H * 0.38, dpr, alt, 0.10, t);
  _drawPalmTree(ctx, W * 0.95, beachTop + 6 * dpr, H * 0.25, dpr, alt, -0.05, t);

  // Birds
  if (alt > -8) {
    var birdAlpha = alt > 5 ? 0.35 : alt > 0 ? 0.25 : 0.08;
    var birdColor = alt > 3 ? '20,20,30' : '200,200,220';
    ctx.lineWidth = 1.2 * dpr;
    ctx.lineCap = 'round';
    var birds = [
      [0.0, 0.14, 7, 0.015, 4.0, 0.0], [0.1, 0.10, 5, 0.012, 4.5, 1.2],
      [0.05, 0.17, 6, 0.013, 3.8, 2.4], [0.3, 0.08, 8, 0.018, 3.5, 0.8],
      [0.35, 0.12, 5.5, 0.016, 4.2, 3.0], [0.5, 0.15, 6, 0.014, 3.9, 1.6],
      [0.6, 0.06, 5, 0.011, 4.8, 4.0], [0.7, 0.11, 7, 0.017, 3.6, 2.0]
    ];
    for (var bi = 0; bi < birds.length; bi++) {
      var b = birds[bi];
      var bx = ((b[0] + b[3] * t) % 1.2 - 0.1) * W;
      var by = b[1] * H + Math.sin(t * 0.5 + b[5]) * 3 * dpr;
      var bw = b[2] * dpr;
      var flap = Math.sin(t * b[4] + b[5]) * 2.5 * dpr;
      ctx.strokeStyle = 'rgba(' + birdColor + ',' + birdAlpha + ')';
      ctx.beginPath();
      ctx.moveTo(bx - bw, by + flap);
      ctx.quadraticCurveTo(bx - bw * 0.3, by - 1.5 * dpr, bx, by + 0.5 * dpr);
      ctx.quadraticCurveTo(bx + bw * 0.3, by - 1.5 * dpr, bx + bw, by + flap);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
}

// ── Palm tree — lush filled fronds ──

function _drawPalmTree(ctx, x, baseY, height, dpr, sunAlt, lean, t) {
  t = t || 0;
  var windSway = Math.sin(t * 0.8 + x * 0.01) * 0.03 + Math.sin(t * 1.3 + x * 0.02) * 0.015;
  var activeLean = lean + windSway;
  var isDark = sunAlt <= 0;
  var trunkBase = isDark ? '#12100a' : '#3a2e1a';
  var trunkTop = isDark ? '#0a0806' : '#2a2010';
  var leafDark = isDark ? '#0a140a' : '#1a4a20';
  var leafLight = isDark ? '#0c1a0c' : '#286830';

  // Trunk: tapered bezier curve
  var topX = x + activeLean * height;
  var topY = baseY - height;
  var cp1x = x + activeLean * height * 0.2;
  var cp1y = baseY - height * 0.4;
  var cp2x = x + activeLean * height * 0.8;
  var cp2y = baseY - height * 0.75;

  var baseWidth = 3.5 * dpr;
  var topWidth = 1.2 * dpr;
  var segments = 16;
  for (var si = 0; si < segments; si++) {
    var t1 = si / segments, t2 = (si + 1) / segments;
    var w1 = baseWidth + (topWidth - baseWidth) * t1;
    var w2 = baseWidth + (topWidth - baseWidth) * t2;
    var mt1 = 1 - t1, mt2 = 1 - t2;
    var x1 = mt1*mt1*mt1*x + 3*mt1*mt1*t1*cp1x + 3*mt1*t1*t1*cp2x + t1*t1*t1*topX;
    var y1 = mt1*mt1*mt1*baseY + 3*mt1*mt1*t1*cp1y + 3*mt1*t1*t1*cp2y + t1*t1*t1*topY;
    var x2 = mt2*mt2*mt2*x + 3*mt2*mt2*t2*cp1x + 3*mt2*t2*t2*cp2x + t2*t2*t2*topX;
    var y2 = mt2*mt2*mt2*baseY + 3*mt2*mt2*t2*cp1y + 3*mt2*t2*t2*cp2y + t2*t2*t2*topY;
    ctx.beginPath();
    ctx.moveTo(x1 - w1/2, y1); ctx.lineTo(x2 - w2/2, y2);
    ctx.lineTo(x2 + w2/2, y2); ctx.lineTo(x1 + w1/2, y1);
    ctx.closePath();
    ctx.fillStyle = si < segments/2 ? trunkBase : trunkTop;
    ctx.fill();
  }

  // Coconuts at crown
  if (!isDark) {
    for (var co = 0; co < 3; co++) {
      var cox = topX + (co - 1) * 2.5 * dpr;
      var coy = topY + 2 * dpr;
      ctx.beginPath(); ctx.arc(cox, coy, 1.8 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#5a4020';
      ctx.fill();
    }
  }

  // Fronds: filled leaf shapes with tapered width
  var fronds = [
    { angle: -2.3, len: 0.65, droop: 0.40, width: 0.08 },
    { angle: -1.5, len: 0.58, droop: 0.20, width: 0.09 },
    { angle: -0.7, len: 0.52, droop: -0.05, width: 0.10 },
    { angle: 0.0, len: 0.48, droop: -0.15, width: 0.09 },
    { angle: 0.7, len: 0.52, droop: -0.05, width: 0.10 },
    { angle: 1.4, len: 0.58, droop: 0.15, width: 0.09 },
    { angle: 2.2, len: 0.65, droop: 0.35, width: 0.08 }
  ];

  for (var fi = 0; fi < fronds.length; fi++) {
    var f = fronds[fi];
    var fLen = f.len * height;
    var frondWind = Math.sin(t * 1.2 + fi * 0.7 + x * 0.01) * 0.06;
    var fAngle = f.angle + activeLean * 0.5 + frondWind;
    var tipX = topX + Math.cos(fAngle) * fLen;
    var tipY = topY + Math.sin(fAngle) * fLen * 0.5 + f.droop * fLen;
    var midX = (topX + tipX) / 2 + Math.cos(fAngle + 0.3) * fLen * 0.08;
    var midY = (topY + tipY) / 2 - fLen * 0.06;

    // Draw filled leaf shape — wide in the middle, tapered to tip
    // Use quadratic bezier for the spine, then draw width perpendicular
    var leafSegs = 10;
    var pts = [];
    for (var li = 0; li <= leafSegs; li++) {
      var lt = li / leafSegs;
      var mt = 1 - lt;
      // Quadratic bezier point
      var lx = mt*mt*topX + 2*mt*lt*midX + lt*lt*tipX;
      var ly = mt*mt*topY + 2*mt*lt*midY + lt*lt*tipY;
      // Width: bell curve, widest at 30-50%, tapers at both ends
      var widthFrac = Math.sin(lt * Math.PI) * (1 - lt * 0.3);
      var leafW = f.width * fLen * widthFrac;
      // Perpendicular direction
      var dx, dy;
      if (li < leafSegs) {
        var nextT = (li + 1) / leafSegs;
        var nmt = 1 - nextT;
        dx = (nmt*nmt*topX + 2*nmt*nextT*midX + nextT*nextT*tipX) - lx;
        dy = (nmt*nmt*topY + 2*nmt*nextT*midY + nextT*nextT*tipY) - ly;
      } else {
        dx = lx - pts[pts.length - 1].x;
        dy = ly - pts[pts.length - 1].y;
      }
      var norm = Math.sqrt(dx*dx + dy*dy) || 1;
      var px = -dy/norm, py = dx/norm;
      pts.push({ x: lx, y: ly, px: px, py: py, w: leafW });
    }

    // Fill the leaf as a closed shape
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    // One side
    for (var li = 0; li < pts.length; li++) {
      ctx.lineTo(pts[li].x + pts[li].px * pts[li].w, pts[li].y + pts[li].py * pts[li].w);
    }
    // Back along other side
    for (var li = pts.length - 1; li >= 0; li--) {
      ctx.lineTo(pts[li].x - pts[li].px * pts[li].w, pts[li].y - pts[li].py * pts[li].w);
    }
    ctx.closePath();
    ctx.fillStyle = leafDark;
    ctx.fill();

    // Midrib line
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.quadraticCurveTo(midX, midY, tipX, tipY);
    ctx.strokeStyle = leafLight;
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();

    // Leaf veins (subtle lines branching from midrib)
    for (var vi = 1; vi < leafSegs; vi += 2) {
      var p = pts[vi];
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.px * p.w * 0.85, p.y + p.py * p.w * 0.85);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.px * p.w * 0.85, p.y - p.py * p.w * 0.85);
      ctx.strokeStyle = leafLight;
      ctx.lineWidth = 0.5 * dpr;
      ctx.stroke();
    }
  }
}

// ── Resize handler ──
var _spaceResizeTimer = null;
window.addEventListener('resize', function() {
  if (!_spaceOpen) return;
  clearTimeout(_spaceResizeTimer);
  _spaceResizeTimer = setTimeout(function() {
    _initOrrery();
    var stored = localStorage.getItem('zimi_space_location');
    var lat = 34, lon = -new Date().getTimezoneOffset() / 60 * 15;
    if (stored) { try { var loc = JSON.parse(stored); lat = loc.lat; lon = loc.lon; } catch(e) {} }
    _initSkyScene(new Date(), lat, lon);
  }, 200);
});
