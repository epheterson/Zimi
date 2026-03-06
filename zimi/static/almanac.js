// ── Almanac — astronomy & calendar mini-app ──
// Lazy-loaded when user clicks the Today card in Discover.
// _almanacOpen is declared in index.html (shared state).

function _almEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

var _almanacOrreryRAF = null;
var _almanacSkyRAF = null;
var _moonTexImg = new Image();
var _moonTexLoaded = false;
_moonTexImg.onload = function() { _moonTexLoaded = true; };
_moonTexImg.onerror = function() { _moonTexLoaded = false; };
_moonTexImg.src = '/static/moon.png?v=1';

function _openAlmanacInner(replaceState) {
  _almanacOpen = true;
  var url = location.pathname + location.search + '#almanac';
  if (replaceState) history.replaceState({ mode: 'almanac' }, '', url);
  else history.pushState({ mode: 'almanac' }, '', url);
  var el = document.getElementById('almanac-view');
  el.classList.add('open');
  var mv = document.getElementById('main-view');
  if (mv) mv.classList.add('hidden');
  _setWindowTitle('Almanac');
  // Integrate with topbar like manage view
  if (typeof updateTopbar === 'function') updateTopbar();
  var qEl = document.getElementById('q');
  if (qEl) qEl.placeholder = 'Almanac';
  _renderAlmanacContent();
}

function closeAlmanac() {
  if (!_almanacOpen) return;
  _almanacOpen = false;
  if (_almanacOrreryRAF) { cancelAnimationFrame(_almanacOrreryRAF); _almanacOrreryRAF = null; }
  if (_almanacSkyRAF) { cancelAnimationFrame(_almanacSkyRAF); _almanacSkyRAF = null; }
  if (_tzClockRAF) { cancelAnimationFrame(_tzClockRAF); _tzClockRAF = null; }
  _almSelectedTz = null;
  document.getElementById('almanac-view').classList.remove('open');
  var mv = document.getElementById('main-view');
  if (mv) mv.classList.remove('hidden');
  // Remove #almanac hash without adding history entry
  if (location.hash === '#almanac') {
    history.replaceState(history.state, '', location.pathname + location.search);
  }
  _setWindowTitle('Zimi');
  if (typeof updateTopbar === 'function') updateTopbar();
  var qEl = document.getElementById('q');
  if (qEl) qEl.placeholder = 'Search everything...';
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

function _renderAlmanacContent() {
  var now = new Date();
  var m = _moonPhase(now);
  var dist = _moonDistance(m.phase);
  var age = (m.phase * 29.53).toFixed(1);
  var untilNew = ((1 - m.phase) * 29.53).toFixed(1);

  var html = '<div class="almanac-inner">';

  // Date header
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var dateStr = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
  var timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  var tzName = _formatTimezone();
  html += '<div style="text-align:center;margin-bottom:16px">';
  html += '<div style="font-size:22px;font-weight:600;color:var(--text)">' + dateStr + '</div>';
  html += '<div style="font-size:16px;color:var(--text2);margin-top:4px">' + timeStr + (tzName ? ' &middot; ' + tzName : '') + '</div>';
  html += '</div>';

  // Hero moon
  html += '<div class="almanac-hero">';
  html += _renderAlmanacMoon(m);
  html += '<div class="almanac-moon-name">' + m.name + '</div>';
  html += '</div>';

  // Sun + Moon data cards — all below the moon
  var stored0 = localStorage.getItem('zimi_almanac_location');
  var lat0 = 34, lon0 = -new Date().getTimezoneOffset() / 60 * 15;
  if (stored0) { try { var l0 = JSON.parse(stored0); lat0 = l0.lat; lon0 = l0.lon; } catch(e) {} }
  var sunInfo0 = _computeSunTimes(now, lat0, lon0);

  // Moon data cards (right under moon hero), then sun data cards (right above sky scene)
  html += '<div class="alm-cards">';
  html += '<div class="alm-card"><div class="alm-card-lbl">illuminated</div><div class="alm-card-val">' + m.illumination + '%</div></div>';
  html += '<div class="alm-card"><div class="alm-card-lbl">moon age</div><div class="alm-card-val">' + age + ' days</div></div>';
  html += '<div class="alm-card"><div class="alm-card-lbl">distance</div><div class="alm-card-val">' + Math.round(dist).toLocaleString() + ' km</div></div>';
  html += '<div class="alm-card"><div class="alm-card-lbl">new moon</div><div class="alm-card-val">' + untilNew + ' days</div></div>';
  if (sunInfo0.polar) {
    html += '<div class="alm-card" style="grid-column:span 4"><div class="alm-card-val">' + sunInfo0.polar + '</div></div>';
  } else {
    html += '<div class="alm-card"><div class="alm-card-lbl">sunrise</div><div class="alm-card-val">' + sunInfo0.sunrise + '</div></div>';
    html += '<div class="alm-card"><div class="alm-card-lbl">sunset</div><div class="alm-card-val">' + sunInfo0.sunset + '</div></div>';
    html += '<div class="alm-card"><div class="alm-card-lbl">daylight</div><div class="alm-card-val">' + sunInfo0.dayLength + '</div></div>';
    if (sunInfo0.goldenHour) {
      html += '<div class="alm-card"><div class="alm-card-lbl">golden</div><div class="alm-card-val" style="color:#d4aa64">' + sunInfo0.goldenHour + '</div></div>';
    }
  }
  html += '</div>';

  // Sky scene + calendar — wall calendar: art above, month grid below
  html += '<div class="almanac-sky-wrap"><canvas id="almanac-sky-canvas"></canvas></div>';
  html += '<div id="almanac-calendar"></div>';

  // Sun map — inline world map with day/night terminator + location picker
  html += '<div id="almanac-sunmap"></div>';

  // Orrery
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">Solar System</div>';
  html += '<div class="almanac-orrery-wrap"><canvas id="almanac-orrery"></canvas></div>';
  html += '</div>';

  // Tonight's sky — planet visibility
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">Tonight\u2019s Sky</div>';
  html += '<div id="almanac-tonight"></div>';
  html += '</div>';

  // Meteor showers
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">Meteor Showers</div>';
  html += '<div id="almanac-meteors"></div>';
  html += '</div>';

  // Celestial events — conjunctions, oppositions
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">Celestial Events</div>';
  html += '<div id="almanac-events"></div>';
  html += '</div>';

  // Astro data
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">Astronomical Data</div>';
  html += '<div id="almanac-astro"></div>';
  html += '</div>';

  // Deep time
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">Deep Time</div>';
  html += '<div id="almanac-deeptime"></div>';
  html += '</div>';

  // Footer
  html += '<div style="margin-top:40px;text-align:center;font-size:11px;color:var(--text3)">' +
    'All calculations are math-driven and work offline forever.' +
    '</div>';

  html += '</div>';
  document.getElementById('almanac-content').innerHTML = html;

  _renderAlmanacCalendar(now);
  _renderSunMap(now);
  _renderTonightSky(now);
  _renderAstroPanel(now);
  _renderMeteorShowers(now, m);
  _renderCelestialEvents(now);
  _renderDeepTime(now);
  _initOrrery();
  _loadSunData(now);
  _startTzClock();
}

// ── Moon rendering ──

function _renderAlmanacMoon(m) {
  var litColor = '#e8e0d0', darkColor = 'rgba(10,14,26,0.82)';
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
  return '<div class="almanac-moon-glow" style="background:radial-gradient(circle, rgba(232,224,208,' + glowOpacity + ') 0%, transparent 70%)"></div>' +
    '<div class="almanac-moon">' +
    // Earthshine: faint texture always visible on the dark side
    '<div class="almanac-moon-texture" style="background:url(\'/static/moon.png?v=1\') center/cover;opacity:0.12"></div>' +
    '<div class="dc-moon-half left" style="background:' + leftColor + '"></div>' +
    '<div class="dc-moon-half right" style="background:' + rightColor + '"></div>' +
    '<div class="dc-moon-term" style="background:' + overlayColor + ';transform:scaleX(' + overlayScaleX.toFixed(3) + ')"></div>' +
    // Bright texture on the lit portion via soft-light blend
    '<div class="almanac-moon-texture" style="background:url(\'/static/moon.png?v=1\') center/cover;mix-blend-mode:soft-light;opacity:1"></div>' +
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

    // No labels — clean Apple Watch aesthetic, hover tooltip on desktop
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
  var el = document.getElementById('almanac-astro');
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

  var html = '<div class="almanac-info-grid">';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + dayOfYear + ' / ' + daysInYear + '</div><div class="almanac-info-lbl">Day of Year</div></div>';
  if (season) {
    html += '<div class="almanac-info-item"><div class="almanac-info-val">' + season.name + '</div><div class="almanac-info-lbl">' + season.daysUntilNext + ' days to ' + season.next + '</div>' +
      '<div class="almanac-progress"><div class="almanac-progress-bar" style="width:' + Math.round(season.progress * 100) + '%"></div></div></div>';
  }
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + earthSunAU + ' AU</div><div class="almanac-info-lbl">Earth\u2013Sun Distance</div></div>';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + constellation + '</div><div class="almanac-info-lbl">Sun Constellation</div></div>';
  html += '</div>';

  if (nextEclipses.length > 0) {
    html += '<div style="margin-top:16px">';
    html += '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">Upcoming Eclipses</div>';
    for (var ei = 0; ei < nextEclipses.length; ei++) {
      var ec = nextEclipses[ei];
      var ecDate = new Date(ec.date + 'T00:00:00');
      var daysUntil = Math.ceil((ecDate - now) / 86400000);
      var untilStr = daysUntil === 0 ? 'Today!' : daysUntil === 1 ? 'Tomorrow' : daysUntil + ' days';
      html += '<div class="almanac-eclipse-row">' +
        '<div><span class="almanac-eclipse-type">' + ec.type + '</span><br><span class="almanac-eclipse-date">' + ec.region + '</span></div>' +
        '<div class="almanac-eclipse-until">' + untilStr + '</div></div>';
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

// ── Sun Map — world map with day/night terminator ──

var _sunMapImg = new Image();
var _sunMapLoaded = false;
_sunMapImg.onload = function() { _sunMapLoaded = true; _drawSunMap(); };
_sunMapImg.onerror = function() { _sunMapLoaded = false; };
_sunMapImg.src = '/static/world-map.svg?v=1';

var _sunMapCanvas = null;
var _sunMapNow = null;
var _sunMapLat = 34;
var _sunMapLon = -118;
var _sunMapLocName = '';
var _sunMapHasLocation = false;

function _renderSunMap(now) {
  var el = document.getElementById('almanac-sunmap');
  if (!el) return;
  _sunMapNow = now;

  // Get location
  var stored = localStorage.getItem('zimi_almanac_location');
  if (stored) {
    try {
      var loc = JSON.parse(stored);
      _sunMapLat = loc.lat; _sunMapLon = loc.lon;
      _sunMapLocName = loc.name || '';
      _sunMapHasLocation = true;
    } catch(e) { _sunMapHasLocation = false; }
  } else {
    _sunMapLat = 34; _sunMapLon = -new Date().getTimezoneOffset() / 60 * 15;
    _sunMapLocName = '';
    _sunMapHasLocation = false;
  }

  // Compute sun info for the info line
  var sunInfo = _computeSunTimes(_sunMapNow, _sunMapLat, _sunMapLon);

  var html = '<div style="margin-top:16px">';
  html += '<div style="position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--border);cursor:crosshair">';
  html += '<canvas id="almanac-sunmap-canvas" style="display:block;width:100%;height:auto"></canvas>';
  html += '</div>';

  // Location line — click city name to search, locate icon for GPS
  html += '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:6px;position:relative">';
  if (_sunMapHasLocation) {
    var locStr = _sunMapLocName ? _sunMapLocName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : _sunMapLat.toFixed(1) + '\u00b0, ' + _sunMapLon.toFixed(1) + '\u00b0';
    html += '<span id="almanac-loc-name" style="font-size:12px;color:var(--text2);cursor:pointer" onclick="_almShowCitySearch()" title="Change location">' + locStr + '</span>';
  } else {
    html += '<span id="almanac-loc-name" style="font-size:12px;color:var(--text3);cursor:pointer" onclick="_almShowCitySearch()" title="Set location">Set location</span>';
  }
  html += '<span onclick="_shareAlmanacLocation()" style="cursor:pointer;font-size:13px;color:var(--text3);opacity:0.7" title="Use browser location">\uD83D\uDCCD</span>';
  // Hidden city search — revealed on click
  html += '<div id="almanac-city-search-wrap" style="display:none;position:absolute;top:-2px;left:50%;transform:translateX(-50%);z-index:10">';
  html += '<input id="almanac-city-search" type="text" placeholder="Search city\u2026" ' +
    'style="width:180px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px" autocomplete="off">';
  html += '<div id="almanac-city-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-top:2px;max-height:160px;overflow-y:auto;z-index:10"></div>';
  html += '</div>';
  html += '</div>';

  // Timezone UI — analog clock left, city list right
  html += '<div class="alm-tz-wrap">';
  html += '<div class="alm-tz-clock-side">';
  html += '<canvas id="almanac-tz-clock" width="240" height="240"></canvas>';
  html += '<div id="almanac-tz-label"></div>';
  html += '</div>';
  html += '<div class="alm-tz-list" id="almanac-tz-pills"></div>';
  html += '</div>';

  html += '</div>';
  el.innerHTML = html;

  // Set up canvas
  _sunMapCanvas = document.getElementById('almanac-sunmap-canvas');
  if (_sunMapCanvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = _sunMapCanvas.parentElement.clientWidth;
    var h = Math.round(w * 0.5);
    _sunMapCanvas.width = w * dpr;
    _sunMapCanvas.height = h * dpr;
    _sunMapCanvas.style.height = h + 'px';
    _drawSunMap();

    // Click to set location
    _sunMapCanvas.onclick = function(e) {
      var rect = _sunMapCanvas.getBoundingClientRect();
      var clickX = e.clientX - rect.left, clickY = e.clientY - rect.top;
      var lon = (clickX / rect.width) * 360 - 180;
      var lat = 90 - (clickY / rect.height) * 180;

      // Snap to nearby city
      var snapDist = 15 / rect.width * 360;
      var snappedName = '';
      for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
        var c = _MAP_CITIES[ci];
        var dlat = lat - c.lat, dlon = lon - c.lon;
        if (Math.sqrt(dlat * dlat + dlon * dlon) < snapDist) {
          lat = c.lat; lon = c.lon;
          snappedName = c.name;
          break;
        }
      }
      var locData = { lat: lat, lon: lon };
      if (snappedName) locData.name = snappedName;
      localStorage.setItem('zimi_almanac_location', JSON.stringify(locData));
      _renderAlmanacContent();
    };
  }

  // City search (revealed via _almShowCitySearch)
  var searchInput = document.getElementById('almanac-city-search');
  var resultsDiv = document.getElementById('almanac-city-results');
  if (searchInput && resultsDiv) {
    searchInput.oninput = function() {
      var q = searchInput.value.toLowerCase().trim();
      if (q.length < 2) { resultsDiv.style.display = 'none'; return; }
      var matches = [];
      for (var i = 0; i < _MAP_CITIES.length && matches.length < 8; i++) {
        if (_MAP_CITIES[i].name.toLowerCase().indexOf(q) !== -1) matches.push(_MAP_CITIES[i]);
      }
      if (matches.length === 0) { resultsDiv.style.display = 'none'; return; }
      var rhtml = '';
      for (var i = 0; i < matches.length; i++) {
        rhtml += '<div data-ci="' + i + '" style="padding:6px 10px;font-size:12px;color:var(--text);cursor:pointer;border-bottom:1px solid var(--border)" ' +
          'onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'transparent\'">' +
          matches[i].name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
      }
      resultsDiv.innerHTML = rhtml;
      resultsDiv.style.display = 'block';
      // Click handlers
      var items = resultsDiv.children;
      for (var i = 0; i < items.length; i++) {
        (function(city) {
          items[i].onclick = function() {
            localStorage.setItem('zimi_almanac_location', JSON.stringify({ lat: city.lat, lon: city.lon, name: city.name }));
            _renderAlmanacContent();
          };
        })(matches[i]);
      }
    };
    searchInput.onblur = function() {
      setTimeout(function() {
        resultsDiv.style.display = 'none';
        var wrap = document.getElementById('almanac-city-search-wrap');
        if (wrap) wrap.style.display = 'none';
      }, 200);
    };
  }

  // Timezone analog clock + pills
  _initTzClock(now);
}

// ── Timezone analog clock ──

var _TZ_CITIES = [
  { label: 'Honolulu', tz: 'Pacific/Honolulu', lat: 21.31, lon: -157.86 },
  { label: 'Los Angeles', tz: 'America/Los_Angeles', lat: 34.05, lon: -118.24 },
  { label: 'Denver', tz: 'America/Denver', lat: 39.74, lon: -104.98 },
  { label: 'Chicago', tz: 'America/Chicago', lat: 41.88, lon: -87.63 },
  { label: 'New York', tz: 'America/New_York', lat: 40.71, lon: -74.01 },
  { label: 'São Paulo', tz: 'America/Sao_Paulo', lat: -23.55, lon: -46.63 },
  { label: 'London', tz: 'Europe/London', lat: 51.51, lon: -0.13 },
  { label: 'Cairo', tz: 'Africa/Cairo', lat: 30.04, lon: 31.24 },
  { label: 'Moscow', tz: 'Europe/Moscow', lat: 55.76, lon: 37.62 },
  { label: 'Dubai', tz: 'Asia/Dubai', lat: 25.20, lon: 55.27 },
  { label: 'Mumbai', tz: 'Asia/Kolkata', lat: 19.08, lon: 72.88 },
  { label: 'Bangkok', tz: 'Asia/Bangkok', lat: 13.76, lon: 100.50 },
  { label: 'Shanghai', tz: 'Asia/Shanghai', lat: 31.23, lon: 121.47 },
  { label: 'Tokyo', tz: 'Asia/Tokyo', lat: 35.68, lon: 139.69 },
  { label: 'Sydney', tz: 'Australia/Sydney', lat: -33.87, lon: 151.21 },
  { label: 'Auckland', tz: 'Pacific/Auckland', lat: -36.85, lon: 174.76 }
];

var _almSelectedTz = null; // null = local timezone

function _initTzClock(now) {
  var pillsEl = document.getElementById('almanac-tz-pills');
  if (!pillsEl) return;

  // Detect user's current timezone and find matching pill
  var userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var localMatch = -1;
  for (var i = 0; i < _TZ_CITIES.length; i++) {
    if (_TZ_CITIES[i].tz === userTz) { localMatch = i; break; }
  }

  // Render city cards with times
  var html = '';
  for (var i = 0; i < _TZ_CITIES.length; i++) {
    var tzc = _TZ_CITIES[i];
    var isActive = (i === localMatch && _almSelectedTz === null) || (_almSelectedTz === tzc.tz);
    var tzTime = '';
    try { tzTime = now.toLocaleTimeString('en-US', { timeZone: tzc.tz, hour: 'numeric', minute: '2-digit', hour12: true }); } catch(e) { continue; }
    // Compute UTC offset for this timezone
    var utcOff = '';
    try {
      var here = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      var there = new Date(now.toLocaleString('en-US', { timeZone: tzc.tz }));
      var diffMin = Math.round((there - here) / 60000);
      var sign = diffMin >= 0 ? '+' : '\u2212';
      var absH = Math.floor(Math.abs(diffMin) / 60);
      var absM = Math.abs(diffMin) % 60;
      utcOff = 'UTC' + sign + absH + (absM ? ':' + (absM < 10 ? '0' : '') + absM : '');
    } catch(e) {}
    var tzHour = 0;
    try { tzHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: tzc.tz, hour: 'numeric', hour12: false })); } catch(e) {}
    var isNight = tzHour < 6 || tzHour >= 20;
    html += '<div class="alm-tz-city-card' + (isActive ? ' alm-tz-city-active' : '') + (isNight ? ' alm-tz-city-night' : '') + '" onclick="_almSelectTz(\'' + tzc.tz + '\',' + i + ')">';
    html += '<span class="alm-tz-city-name">' + tzc.label + '</span>';
    html += '<span class="alm-tz-city-time">' + tzTime + '</span>';
    html += '<span class="alm-tz-city-offset">' + utcOff + '</span>';
    html += '</div>';
  }
  pillsEl.innerHTML = html;

  // Draw the clock
  _drawTzClock(now);
}

function _almSelectTz(tz, idx) {
  _almSelectedTz = tz;
  // Also set location to this city for sun/map calculations
  var city = _TZ_CITIES[idx];
  localStorage.setItem('zimi_almanac_location', JSON.stringify({ lat: city.lat, lon: city.lon, name: city.label }));
  _renderAlmanacContent();
}

function _drawTzClock(now) {
  var canvas = document.getElementById('almanac-tz-clock');
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var size = 160;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var tz = _almSelectedTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  var tzLabel = '';
  for (var i = 0; i < _TZ_CITIES.length; i++) {
    if (_TZ_CITIES[i].tz === tz) { tzLabel = _TZ_CITIES[i].label; break; }
  }

  // Get time in selected timezone — use fractional seconds for smooth hand
  var h24 = 0, mins = 0, secs = 0;
  try {
    h24 = parseInt(now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
    mins = parseInt(now.toLocaleTimeString('en-US', { timeZone: tz, minute: '2-digit' }).replace(/[^0-9]/g, ''));
    secs = now.getSeconds() + now.getMilliseconds() / 1000;
  } catch(e) { return; }
  var isNight = h24 < 6 || h24 >= 20;

  var cx = size / 2, cy = size / 2, r = size / 2 - 12;

  // Clock face
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = isNight ? 'rgba(10,14,26,0.8)' : 'rgba(30,35,50,0.6)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(245,158,11,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hour markers
  for (var i = 0; i < 12; i++) {
    var angle = (i * 30 - 90) * Math.PI / 180;
    var isMajor = i % 3 === 0;
    var outerR = r - 4;
    var innerR = isMajor ? r - 14 : r - 9;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
    ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
    ctx.strokeStyle = isMajor ? 'rgba(245,158,11,0.6)' : 'rgba(200,200,200,0.25)';
    ctx.lineWidth = isMajor ? 2 : 1;
    ctx.stroke();
  }

  // Resolve CSS colors for canvas
  var textColor = '#e0e0e0';
  var amberColor = '#f59e0b';
  try {
    var cs = getComputedStyle(canvas);
    var t = cs.getPropertyValue('--text').trim();
    if (t) textColor = t;
    var a = cs.getPropertyValue('--amber').trim();
    if (a) amberColor = a;
  } catch(e) {}

  // Hour hand
  var hourAngle = ((h24 % 12) + mins / 60) * 30 - 90;
  var hourRad = hourAngle * Math.PI / 180;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(hourRad) * (r * 0.5), cy + Math.sin(hourRad) * (r * 0.5));
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Minute hand
  var minAngle = (mins + secs / 60) * 6 - 90;
  var minRad = minAngle * Math.PI / 180;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(minRad) * (r * 0.72), cy + Math.sin(minRad) * (r * 0.72));
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Second hand
  var secAngle = secs * 6 - 90;
  var secRad = secAngle * Math.PI / 180;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(secRad) * (r * 0.78), cy + Math.sin(secRad) * (r * 0.78));
  ctx.strokeStyle = 'rgba(245,158,11,0.6)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = amberColor;
  ctx.fill();

  // Time text below clock
  var labelEl = document.getElementById('almanac-tz-label');
  if (labelEl) {
    var timeStr = '';
    try {
      timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    } catch(e) {}
    var dateStr = '';
    try {
      dateStr = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
    } catch(e) {}
    labelEl.innerHTML = '<div style="font-size:18px;font-weight:500;color:var(--text)">' + timeStr + '</div>' +
      (tzLabel ? '<div style="font-size:12px;color:var(--text3);margin-top:2px">' + tzLabel + (dateStr ? ' \u00b7 ' + dateStr : '') + '</div>' : '');
  }
}

// Smooth clock animation using requestAnimationFrame
var _tzClockRAF = null;
function _startTzClock() {
  if (_tzClockRAF) cancelAnimationFrame(_tzClockRAF);
  function tick() {
    if (!_almanacOpen) { _tzClockRAF = null; return; }
    _drawTzClock(new Date());
    _tzClockRAF = requestAnimationFrame(tick);
  }
  _tzClockRAF = requestAnimationFrame(tick);
}

function _computeSunTimes(now, lat, lon) {
  var y = now.getFullYear();
  var start = new Date(y, 0, 1);
  var dayOfYear = Math.floor((now - start) / 86400000) + 1;
  var B = (dayOfYear - 1) * 2 * Math.PI / 365;
  var EoT = 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B) - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
  var decl = 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B) - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B) - 0.002697 * Math.cos(3 * B) + 0.00148 * Math.sin(3 * B);
  var latRad = lat * Math.PI / 180;
  var cosHA = (Math.cos(90.833 * Math.PI / 180) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));

  if (cosHA > 1) return { polar: 'Polar Night \u2014 the sun does not rise today' };
  if (cosHA < -1) return { polar: 'Midnight Sun \u2014 24 hours of daylight' };

  var HA = Math.acos(cosHA) * 180 / Math.PI;
  var sunrise = 720 - 4 * (lon + HA) - EoT;
  var sunset = 720 - 4 * (lon - HA) - EoT;
  var tzOffset = -now.getTimezoneOffset();
  sunrise += tzOffset; sunset += tzOffset;
  var dayLength = sunset - sunrise;
  var dayH = Math.floor(dayLength / 60);
  var dayM = Math.round(dayLength % 60);

  var result = {
    sunrise: _fmtMinutes(sunrise),
    sunset: _fmtMinutes(sunset),
    dayLength: dayH + 'h ' + dayM + 'm'
  };

  var cosGH = (Math.cos(84 * Math.PI / 180) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));
  if (cosGH >= -1 && cosGH <= 1) {
    var HAgh = Math.acos(cosGH) * 180 / Math.PI;
    result.goldenHour = _fmtMinutes(720 - 4 * (lon - HAgh) - EoT + tzOffset);
  }
  return result;
}

function _drawSunMap() {
  if (!_sunMapCanvas || !_sunMapNow) return;
  var ctx = _sunMapCanvas.getContext('2d');
  var W = _sunMapCanvas.width, H = _sunMapCanvas.height;
  var dpr = window.devicePixelRatio || 1;

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Draw map image if loaded
  if (_sunMapLoaded) {
    ctx.globalAlpha = 0.4;
    ctx.drawImage(_sunMapImg, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // Compute sun subsolar point
  var now = _sunMapNow;
  var y = now.getFullYear();
  var start = new Date(y, 0, 1);
  var dayOfYear = Math.floor((now - start) / 86400000) + 1;
  var B = (dayOfYear - 1) * 2 * Math.PI / 365;
  var decl = 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B) - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B) - 0.002697 * Math.cos(3 * B) + 0.00148 * Math.sin(3 * B);
  var declDeg = decl * 180 / Math.PI;
  var utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  var sunLon = -(utcH - 12) * 15;

  // Draw day/night terminator
  var termPoints = [];
  for (var px = 0; px < W; px++) {
    var lon = (px / W) * 360 - 180;
    var dlon = (lon - sunLon) * Math.PI / 180;
    var termLat = Math.atan(-Math.cos(dlon) / Math.tan(decl)) * 180 / Math.PI;
    var termY = (90 - termLat) / 180 * H;
    termPoints.push({ x: px, y: termY });
  }

  // Fill night side
  ctx.beginPath();
  if (declDeg >= 0) {
    ctx.moveTo(0, termPoints[0].y);
    for (var i = 0; i < termPoints.length; i++) ctx.lineTo(termPoints[i].x, termPoints[i].y);
    ctx.lineTo(W, H); ctx.lineTo(0, H);
  } else {
    ctx.moveTo(0, termPoints[0].y);
    for (var i = 0; i < termPoints.length; i++) ctx.lineTo(termPoints[i].x, termPoints[i].y);
    ctx.lineTo(W, 0); ctx.lineTo(0, 0);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();

  // Terminator line
  ctx.beginPath();
  ctx.moveTo(termPoints[0].x, termPoints[0].y);
  for (var i = 1; i < termPoints.length; i++) ctx.lineTo(termPoints[i].x, termPoints[i].y);
  ctx.strokeStyle = 'rgba(245,158,11,0.3)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();

  // Sub-solar point — where the sun is directly overhead right now
  var sunX = ((sunLon + 180 + 360) % 360) / 360 * W;
  var sunY = (90 - declDeg) / 180 * H;
  // Sun rays
  ctx.strokeStyle = 'rgba(251,191,36,0.25)';
  ctx.lineWidth = 1 * dpr;
  for (var ri = 0; ri < 8; ri++) {
    var ra = ri * Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(sunX + Math.cos(ra) * 5 * dpr, sunY + Math.sin(ra) * 5 * dpr);
    ctx.lineTo(sunX + Math.cos(ra) * 10 * dpr, sunY + Math.sin(ra) * 10 * dpr);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(sunX, sunY, 3 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();

  // City dots
  for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
    var c = _MAP_CITIES[ci];
    var cx = (c.lon + 180) / 360 * W;
    var cy = (90 - c.lat) / 180 * H;
    ctx.beginPath();
    ctx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(210,180,120,0.5)';
    ctx.fill();
  }

  // Current location marker — only if explicitly set
  if (_sunMapHasLocation) {
    var locX = (_sunMapLon + 180) / 360 * W;
    var locY = (90 - _sunMapLat) / 180 * H;
    ctx.beginPath();
    ctx.arc(locX, locY, 5 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(245,158,11,0.8)';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(locX, locY, 2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
  }
}

// ── Sky scene init (uses location for sun/moon position) ──

function _loadSunData(now) {
  var stored = localStorage.getItem('zimi_almanac_location');
  var lat, lon;
  if (stored) {
    try {
      var loc = JSON.parse(stored);
      lat = loc.lat; lon = loc.lon;
    } catch(e) {
      lat = 34; lon = -new Date().getTimezoneOffset() / 60 * 15;
    }
  } else {
    lat = 34; lon = -new Date().getTimezoneOffset() / 60 * 15;
  }
  _initSkyScene(now, lat, lon);
}

function _almShowCitySearch() {
  var wrap = document.getElementById('almanac-city-search-wrap');
  if (wrap) {
    wrap.style.display = 'block';
    var input = document.getElementById('almanac-city-search');
    if (input) { input.value = ''; input.focus(); }
  }
}

function _shareAlmanacLocation() {
  // Try GPS first (works in browsers, fails silently in pywebview/desktop)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      localStorage.setItem('zimi_almanac_location', JSON.stringify({ lat: lat, lon: lon }));
      _renderAlmanacContent();
    }, function() {
      // GPS denied or unavailable — fall back to manual entry
      _promptAlmanacLocation();
    }, { timeout: 5000 });
  } else {
    _promptAlmanacLocation();
  }
}

// ── Cities for map picker (200+ world cities) ──
var _MAP_CITIES = [
  // North America
  { name: 'New York', lat: 40.71, lon: -74.01 },
  { name: 'Los Angeles', lat: 34.05, lon: -118.24 },
  { name: 'Chicago', lat: 41.88, lon: -87.63 },
  { name: 'Houston', lat: 29.76, lon: -95.37 },
  { name: 'Phoenix', lat: 33.45, lon: -112.07 },
  { name: 'Philadelphia', lat: 39.95, lon: -75.17 },
  { name: 'San Antonio', lat: 29.42, lon: -98.49 },
  { name: 'San Diego', lat: 32.72, lon: -117.16 },
  { name: 'Dallas', lat: 32.78, lon: -96.80 },
  { name: 'San Francisco', lat: 37.77, lon: -122.42 },
  { name: 'Seattle', lat: 47.61, lon: -122.33 },
  { name: 'Denver', lat: 39.74, lon: -104.99 },
  { name: 'Washington DC', lat: 38.91, lon: -77.04 },
  { name: 'Boston', lat: 42.36, lon: -71.06 },
  { name: 'Atlanta', lat: 33.75, lon: -84.39 },
  { name: 'Miami', lat: 25.76, lon: -80.19 },
  { name: 'Minneapolis', lat: 44.98, lon: -93.27 },
  { name: 'Portland', lat: 45.52, lon: -122.68 },
  { name: 'Las Vegas', lat: 36.17, lon: -115.14 },
  { name: 'Honolulu', lat: 21.31, lon: -157.86 },
  { name: 'Anchorage', lat: 61.22, lon: -149.90 },
  { name: 'Toronto', lat: 43.65, lon: -79.38 },
  { name: 'Montreal', lat: 45.50, lon: -73.57 },
  { name: 'Vancouver', lat: 49.28, lon: -123.12 },
  { name: 'Mexico City', lat: 19.43, lon: -99.13 },
  { name: 'Guadalajara', lat: 20.67, lon: -103.35 },
  { name: 'Havana', lat: 23.11, lon: -82.37 },
  { name: 'San Juan', lat: 18.47, lon: -66.11 },
  // South America
  { name: 'S\u00e3o Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Rio de Janeiro', lat: -22.91, lon: -43.17 },
  { name: 'Buenos Aires', lat: -34.60, lon: -58.38 },
  { name: 'Bogot\u00e1', lat: 4.71, lon: -74.07 },
  { name: 'Lima', lat: -12.05, lon: -77.04 },
  { name: 'Santiago', lat: -33.45, lon: -70.67 },
  { name: 'Caracas', lat: 10.49, lon: -66.90 },
  { name: 'Quito', lat: -0.18, lon: -78.47 },
  { name: 'Montevideo', lat: -34.88, lon: -56.17 },
  { name: 'Medell\u00edn', lat: 6.25, lon: -75.56 },
  // Europe
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Paris', lat: 48.86, lon: 2.35 },
  { name: 'Berlin', lat: 52.52, lon: 13.40 },
  { name: 'Madrid', lat: 40.42, lon: -3.70 },
  { name: 'Rome', lat: 41.90, lon: 12.50 },
  { name: 'Amsterdam', lat: 52.37, lon: 4.90 },
  { name: 'Vienna', lat: 48.21, lon: 16.37 },
  { name: 'Prague', lat: 50.08, lon: 14.44 },
  { name: 'Brussels', lat: 50.85, lon: 4.35 },
  { name: 'Stockholm', lat: 59.33, lon: 18.07 },
  { name: 'Oslo', lat: 59.91, lon: 10.75 },
  { name: 'Copenhagen', lat: 55.68, lon: 12.57 },
  { name: 'Helsinki', lat: 60.17, lon: 24.94 },
  { name: 'Dublin', lat: 53.35, lon: -6.26 },
  { name: 'Lisbon', lat: 38.72, lon: -9.14 },
  { name: 'Barcelona', lat: 41.39, lon: 2.17 },
  { name: 'Munich', lat: 48.14, lon: 11.58 },
  { name: 'Milan', lat: 45.46, lon: 9.19 },
  { name: 'Zurich', lat: 47.38, lon: 8.54 },
  { name: 'Warsaw', lat: 52.23, lon: 21.01 },
  { name: 'Budapest', lat: 47.50, lon: 19.04 },
  { name: 'Athens', lat: 37.98, lon: 23.73 },
  { name: 'Bucharest', lat: 44.43, lon: 26.10 },
  { name: 'Moscow', lat: 55.76, lon: 37.62 },
  { name: 'St. Petersburg', lat: 59.93, lon: 30.32 },
  { name: 'Kyiv', lat: 50.45, lon: 30.52 },
  { name: 'Istanbul', lat: 41.01, lon: 28.98 },
  { name: 'Edinburgh', lat: 55.95, lon: -3.19 },
  { name: 'Reykjavik', lat: 64.15, lon: -21.94 },
  // Middle East
  { name: 'Dubai', lat: 25.20, lon: 55.27 },
  { name: 'Riyadh', lat: 24.71, lon: 46.67 },
  { name: 'Doha', lat: 25.29, lon: 51.53 },
  { name: 'Tehran', lat: 35.69, lon: 51.39 },
  { name: 'Baghdad', lat: 33.31, lon: 44.37 },
  { name: 'Tel Aviv', lat: 32.09, lon: 34.78 },
  { name: 'Jerusalem', lat: 31.77, lon: 35.23 },
  { name: 'Amman', lat: 31.95, lon: 35.93 },
  { name: 'Beirut', lat: 33.89, lon: 35.50 },
  { name: 'Muscat', lat: 23.59, lon: 58.54 },
  // Africa
  { name: 'Cairo', lat: 30.04, lon: 31.24 },
  { name: 'Lagos', lat: 6.52, lon: 3.38 },
  { name: 'Nairobi', lat: -1.29, lon: 36.82 },
  { name: 'Cape Town', lat: -33.93, lon: 18.42 },
  { name: 'Johannesburg', lat: -26.20, lon: 28.04 },
  { name: 'Casablanca', lat: 33.59, lon: -7.62 },
  { name: 'Accra', lat: 5.56, lon: -0.19 },
  { name: 'Addis Ababa', lat: 9.02, lon: 38.75 },
  { name: 'Dar es Salaam', lat: -6.79, lon: 39.28 },
  { name: 'Kinshasa', lat: -4.32, lon: 15.31 },
  { name: 'Algiers', lat: 36.75, lon: 3.04 },
  { name: 'Tunis', lat: 36.81, lon: 10.18 },
  { name: 'Dakar', lat: 14.69, lon: -17.44 },
  { name: 'Kampala', lat: 0.35, lon: 32.58 },
  // South Asia
  { name: 'Mumbai', lat: 19.08, lon: 72.88 },
  { name: 'Delhi', lat: 28.61, lon: 77.21 },
  { name: 'Bangalore', lat: 12.97, lon: 77.59 },
  { name: 'Chennai', lat: 13.08, lon: 80.27 },
  { name: 'Kolkata', lat: 22.57, lon: 88.36 },
  { name: 'Karachi', lat: 24.86, lon: 67.01 },
  { name: 'Lahore', lat: 31.55, lon: 74.35 },
  { name: 'Dhaka', lat: 23.81, lon: 90.41 },
  { name: 'Colombo', lat: 6.93, lon: 79.85 },
  { name: 'Kathmandu', lat: 27.72, lon: 85.32 },
  // East & Southeast Asia
  { name: 'Beijing', lat: 39.90, lon: 116.40 },
  { name: 'Shanghai', lat: 31.23, lon: 121.47 },
  { name: 'Guangzhou', lat: 23.13, lon: 113.26 },
  { name: 'Shenzhen', lat: 22.54, lon: 114.06 },
  { name: 'Hong Kong', lat: 22.32, lon: 114.17 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Osaka', lat: 34.69, lon: 135.50 },
  { name: 'Seoul', lat: 37.57, lon: 126.98 },
  { name: 'Taipei', lat: 25.03, lon: 121.57 },
  { name: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Bangkok', lat: 13.76, lon: 100.50 },
  { name: 'Jakarta', lat: -6.21, lon: 106.85 },
  { name: 'Manila', lat: 14.60, lon: 120.98 },
  { name: 'Ho Chi Minh', lat: 10.82, lon: 106.63 },
  { name: 'Hanoi', lat: 21.03, lon: 105.85 },
  { name: 'Kuala Lumpur', lat: 3.14, lon: 101.69 },
  { name: 'Yangon', lat: 16.87, lon: 96.20 },
  { name: 'Phnom Penh', lat: 11.56, lon: 104.93 },
  // Central Asia
  { name: 'Tashkent', lat: 41.30, lon: 69.28 },
  { name: 'Almaty', lat: 43.24, lon: 76.95 },
  { name: 'Tbilisi', lat: 41.69, lon: 44.80 },
  { name: 'Baku', lat: 40.41, lon: 49.87 },
  // Oceania
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
  { name: 'Melbourne', lat: -37.81, lon: 144.96 },
  { name: 'Brisbane', lat: -27.47, lon: 153.03 },
  { name: 'Perth', lat: -31.95, lon: 115.86 },
  { name: 'Auckland', lat: -36.85, lon: 174.76 },
  { name: 'Wellington', lat: -41.29, lon: 174.78 },
  { name: 'Fiji', lat: -17.77, lon: 177.97 }
];

// Coastline data removed — using Natural Earth SVG map (/static/world-map.svg)

function _promptAlmanacLocation() {
  var overlay = document.createElement('div');
  overlay.id = 'almanac-map-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.88);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)';

  var gpsBtn = navigator.geolocation
    ? '<button id="almanac-map-gps" style="padding:6px 14px;background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:6px;font-size:12px;cursor:pointer;opacity:0.8">\uD83D\uDCCD Use GPS</button>'
    : '';

  // Map uses Natural Earth 110m SVG (public domain) as background
  overlay.innerHTML = '<div style="color:var(--text);font-size:16px;font-weight:600;margin-bottom:4px">Set Your Location</div>' +
    '<div style="color:var(--text3);font-size:12px;margin-bottom:12px">Tap a city or click the map</div>' +
    '<div id="almanac-map-wrap" style="position:relative;max-width:560px;width:100%;border-radius:10px;overflow:hidden;border:1px solid var(--border);cursor:crosshair">' +
      '<img src="/static/world-map.svg?v=1" style="display:block;width:100%;height:auto" draggable="false" alt="World map">' +
      '<div id="almanac-map-marker" style="display:none;position:absolute;pointer-events:none">' +
        '<div style="width:20px;height:20px;border:2px solid rgba(210,170,100,0.7);border-radius:50%;position:absolute;left:-10px;top:-10px"></div>' +
        '<div style="width:6px;height:6px;background:#d4aa64;border-radius:50%;position:absolute;left:-3px;top:-3px"></div>' +
      '</div>' +
      '<div id="almanac-map-cities" style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none"></div>' +
    '</div>' +
    '<div id="almanac-map-hint" style="color:var(--text2);font-size:12px;margin-top:8px;min-height:18px"></div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center">' +
      '<input id="almanac-map-lat" type="text" placeholder="Latitude" style="width:90px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;text-align:center">' +
      '<input id="almanac-map-lon" type="text" placeholder="Longitude" style="width:90px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;text-align:center">' +
      '<button id="almanac-map-ok" style="padding:6px 18px;background:var(--accent);color:#000;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Set</button>' +
      gpsBtn +
      '<button id="almanac-map-cancel" style="padding:6px 14px;background:transparent;color:var(--text3);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer">Cancel</button>' +
    '</div>';
  document.body.appendChild(overlay);

  var wrap = document.getElementById('almanac-map-wrap');
  var marker = document.getElementById('almanac-map-marker');
  var citiesEl = document.getElementById('almanac-map-cities');

  // Draw city dots on the map
  function drawCities() {
    var rect = wrap.getBoundingClientRect();
    var w = rect.width, h = rect.height;
    var html = '';
    for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
      var c = _MAP_CITIES[ci];
      var x = ((c.lon + 180) / 360 * 100).toFixed(2);
      var y = ((90 - c.lat) / 180 * 100).toFixed(2);
      html += '<div style="position:absolute;left:' + x + '%;top:' + y + '%;pointer-events:auto;cursor:pointer;padding:6px;margin:-6px" data-city="' + ci + '">' +
        '<div style="width:4px;height:4px;background:rgba(210,180,120,0.6);border-radius:50%;box-shadow:0 0 6px rgba(210,170,100,0.2)"></div></div>';
    }
    citiesEl.innerHTML = html;
  }
  drawCities();

  function showMarker(lat, lon) {
    var x = (lon + 180) / 360 * 100;
    var y = (90 - lat) / 180 * 100;
    marker.style.display = 'block';
    marker.style.left = x + '%';
    marker.style.top = y + '%';
  }

  // Click map or city dot
  wrap.onclick = function(e) {
    var cityIdx = e.target.closest('[data-city]');
    var rect = wrap.getBoundingClientRect();
    var lat, lon;
    if (cityIdx) {
      var c = _MAP_CITIES[parseInt(cityIdx.dataset.city)];
      lat = c.lat; lon = c.lon;
      document.getElementById('almanac-map-hint').textContent = c.name + ' (' + c.lat.toFixed(2) + '\u00b0, ' + c.lon.toFixed(2) + '\u00b0)';
    } else {
      var clickX = e.clientX - rect.left, clickY = e.clientY - rect.top;
      lon = (clickX / rect.width) * 360 - 180;
      lat = 90 - (clickY / rect.height) * 180;
      // Snap to nearby city
      var snapDist = 15 / rect.width * 360;
      var snapped = false;
      for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
        var c = _MAP_CITIES[ci];
        var dlat = lat - c.lat, dlon = lon - c.lon;
        if (Math.sqrt(dlat * dlat + dlon * dlon) < snapDist) {
          lat = c.lat; lon = c.lon;
          document.getElementById('almanac-map-hint').textContent = c.name + ' (' + c.lat.toFixed(2) + '\u00b0, ' + c.lon.toFixed(2) + '\u00b0)';
          snapped = true;
          break;
        }
      }
      if (!snapped) {
        document.getElementById('almanac-map-hint').textContent = lat.toFixed(2) + '\u00b0, ' + lon.toFixed(2) + '\u00b0';
      }
    }
    document.getElementById('almanac-map-lat').value = lat.toFixed(2);
    document.getElementById('almanac-map-lon').value = lon.toFixed(2);
    showMarker(lat, lon);
  };

  document.getElementById('almanac-map-ok').onclick = function() {
    var lat = parseFloat(document.getElementById('almanac-map-lat').value);
    var lon = parseFloat(document.getElementById('almanac-map-lon').value);
    if (!isNaN(lat) && !isNaN(lon)) {
      var locData = { lat: lat, lon: lon };
      var hint = document.getElementById('almanac-map-hint').textContent;
      for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
        if (hint.indexOf(_MAP_CITIES[ci].name) === 0) { locData.name = _MAP_CITIES[ci].name; break; }
      }
      localStorage.setItem('zimi_almanac_location', JSON.stringify(locData));
      document.body.removeChild(overlay);
      _renderAlmanacContent();
    }
  };

  // GPS button
  var gpsEl = document.getElementById('almanac-map-gps');
  if (gpsEl) {
    gpsEl.onclick = function() {
      gpsEl.textContent = 'Locating\u2026';
      navigator.geolocation.getCurrentPosition(function(pos) {
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        document.getElementById('almanac-map-lat').value = lat.toFixed(2);
        document.getElementById('almanac-map-lon').value = lon.toFixed(2);
        document.getElementById('almanac-map-hint').textContent = 'GPS: ' + lat.toFixed(2) + '\u00b0, ' + lon.toFixed(2) + '\u00b0';
        gpsEl.textContent = '\uD83D\uDCCD GPS';
        showMarker(lat, lon);
      }, function() {
        gpsEl.textContent = 'GPS unavailable';
        setTimeout(function() { gpsEl.textContent = '\uD83D\uDCCD Use GPS'; }, 2000);
      }, { timeout: 8000 });
    };
  }

  document.getElementById('almanac-map-cancel').onclick = function() {
    document.body.removeChild(overlay);
  };

  overlay.onclick = function(e) {
    if (e.target === overlay) document.body.removeChild(overlay);
  };
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
  var canvas = document.getElementById('almanac-sky-canvas');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth;
  var h = Math.round(w / 1.8);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  var sunPos = _sunPosition(now, lat, lon);
  _skyStartTime = performance.now();

  // Build sky label text (rendered on the beach inside canvas)
  var _skyLabelText = '';
  var altStr = sunPos.altitude.toFixed(1);
  _skyLabelText = sunPos.altitude > 0 ? 'Sun ' + altStr + '\u00b0' : 'Sun below horizon (' + altStr + '\u00b0)';
  var moonPos0 = _moonPosition(now, lat, lon);
  var moonM0 = _moonPhase(now);
  if (moonPos0.altitude > -2) {
    _skyLabelText += ' \u00b7 Moon ' + moonPos0.altitude.toFixed(1) + '\u00b0 (' + moonM0.illumination + '%)';
  } else {
    _skyLabelText += ' \u00b7 Moon below horizon';
  }

  function _skyLoop(ts) {
    var t = (ts - _skyStartTime) / 1000;
    _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, t, _skyLabelText);
    _almanacSkyRAF = requestAnimationFrame(_skyLoop);
  }
  if (_almanacSkyRAF) cancelAnimationFrame(_almanacSkyRAF);
  _almanacSkyRAF = requestAnimationFrame(_skyLoop);
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
  if (isNaN(cosAz)) cosAz = 0; // zenith/nadir at poles — azimuth undefined
  var azimuth = Math.acos(cosAz) * 180 / Math.PI;
  if (hourAngle > 0) azimuth = 360 - azimuth;
  return { altitude: altitude, azimuth: azimuth };
}

// ── Moon position — simplified lunar alt/az ──
// Uses mean orbital elements to estimate the Moon's equatorial position,
// then converts to horizontal coordinates (same pipeline as the sun).
function _moonPosition(date, lat, lon) {
  var JD = 2440587.5 + date.getTime() / 86400000;
  var T = (JD - 2451545.0) / 36525;
  var D2R = Math.PI / 180;

  // Mean orbital elements (degrees)
  var L0 = (218.3165 + 481267.8813 * T) % 360;         // mean longitude
  var M  = (134.9634 + 477198.8676 * T) % 360;          // mean anomaly
  var Ms = (357.5291 +  35999.0503 * T) % 360;          // sun mean anomaly
  var F  = (93.2720  + 483202.0175 * T) % 360;          // argument of latitude
  var D  = (297.8502 + 445267.1115 * T) % 360;          // mean elongation

  // Ecliptic longitude (principal terms only)
  var lng = L0
    + 6.289 * Math.sin(M * D2R)
    - 1.274 * Math.sin((2*D - M) * D2R)
    - 0.658 * Math.sin(2*D * D2R)
    - 0.214 * Math.sin(2*M * D2R)
    - 0.186 * Math.sin(Ms * D2R);

  // Ecliptic latitude
  var lat_ec = 5.128 * Math.sin(F * D2R)
    + 0.281 * Math.sin((M + F) * D2R)
    + 0.278 * Math.sin((F - M) * D2R);

  // Ecliptic to equatorial (obliquity ≈ 23.44°)
  var eps = 23.44 * D2R;
  var lngR = lng * D2R, latR = lat_ec * D2R;
  var sinDec = Math.sin(latR) * Math.cos(eps) + Math.cos(latR) * Math.sin(eps) * Math.sin(lngR);
  var dec = Math.asin(sinDec);
  var ra = Math.atan2(
    Math.sin(lngR) * Math.cos(eps) - Math.tan(latR) * Math.sin(eps),
    Math.cos(lngR)
  );

  // Local sidereal time
  var GMST = (280.46061837 + 360.98564736629 * (JD - 2451545.0)) % 360;
  var LST = (GMST + lon) * D2R;
  var HA = LST - ra;
  HA = ((HA % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // normalize to [-pi, pi]

  // Horizontal coordinates
  var latR2 = lat * D2R;
  var sinAlt = Math.sin(latR2) * Math.sin(dec) + Math.cos(latR2) * Math.cos(dec) * Math.cos(HA);
  var altitude = Math.asin(sinAlt) * 180 / Math.PI;
  var cosAz = (Math.sin(dec) - Math.sin(latR2) * sinAlt) / (Math.cos(latR2) * Math.cos(Math.asin(sinAlt)));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  if (isNaN(cosAz)) cosAz = 0; // zenith/nadir at poles — azimuth undefined
  var azimuth = Math.acos(cosAz) * 180 / Math.PI;
  if (HA > 0) azimuth = 360 - azimuth;
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

function _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, t, labelText) {
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

  }

  // Moon — visible day and night when above the horizon
  var moonPos = _moonPosition(now, lat, lon);
  var moonAlt = moonPos.altitude;
  var moonAz = moonPos.azimuth;
  if (moonAlt > -2) {
    var m = _moonPhase(now);
    // Position from actual alt/az (same projection as the sun)
    var moonXFrac = Math.max(0.05, Math.min(0.95, (moonAz - 60) / 240));
    var moonX = moonXFrac * W;
    var moonY = H * 0.66 - (moonAlt / 90) * H * 0.56;
    moonY = Math.max(H * 0.04, Math.min(H * 0.68, moonY));
    var moonR = 14 * dpr;
    // Daytime: moon is faint and pale; nighttime: bright and glowing
    var isDaytime = alt > 0;
    var moonAlpha = isDaytime ? Math.max(0.15, 0.5 - alt / 60) : 1.0;
    if (!isDaytime) {
      var mgOuter = ctx.createRadialGradient(moonX, moonY, moonR, moonX, moonY, moonR * 4);
      mgOuter.addColorStop(0, 'rgba(220,215,200,' + (m.illumination / 500).toFixed(3) + ')');
      mgOuter.addColorStop(1, 'transparent');
      ctx.fillStyle = mgOuter;
      ctx.beginPath(); ctx.arc(moonX, moonY, moonR * 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save();
    ctx.globalAlpha = moonAlpha;
    ctx.beginPath(); ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2); ctx.clip();
    if (_moonTexLoaded) {
      ctx.drawImage(_moonTexImg, moonX - moonR, moonY - moonR, moonR * 2, moonR * 2);
      var brighten = isDaytime ? 0.25 + (m.illumination / 100) * 0.15 : 0.10 + (m.illumination / 100) * 0.30;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(220,210,195,' + brighten.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      var moonGrad = ctx.createRadialGradient(moonX - moonR * 0.25, moonY - moonR * 0.2, 0, moonX, moonY, moonR);
      moonGrad.addColorStop(0, isDaytime ? '#d8dce6' : '#f0ead8');
      moonGrad.addColorStop(0.5, isDaytime ? '#c8ccd6' : '#e4dcc8');
      moonGrad.addColorStop(0.85, isDaytime ? '#b8bcc6' : '#d4c8b0');
      moonGrad.addColorStop(1, isDaytime ? '#a8acb6' : '#c0b498');
      ctx.fillStyle = moonGrad;
      ctx.fill();
    }
    ctx.restore();
    if (m.illumination < 95) {
      // Draw proper terminator shadow matching the hero moon's half+ellipse technique.
      // Semicircle on the shadow side + elliptical terminator arc closing the shape.
      ctx.save();
      ctx.globalAlpha = moonAlpha;
      var shadowCol = isDaytime ? 'rgba(135,170,210,0.65)' : 'rgba(5,8,12,0.78)';
      var illumF = m.illumination / 100;
      var R = moonR * 0.97;
      var waxing = m.phase <= 0.5;
      var termScaleX = Math.max(0.01, Math.abs(illumF * 2 - 1));
      // Terminator direction: matches arc direction when illum<50%, reverses when >=50%
      var termCCW = (illumF < 0.5) === waxing;
      ctx.beginPath();
      // Semicircle: waxing→left (CCW), waning→right (CW)
      ctx.arc(moonX, moonY, R, -Math.PI / 2, Math.PI / 2, waxing);
      // Terminator ellipse from bottom back to top
      ctx.ellipse(moonX, moonY, termScaleX * R, R, 0, Math.PI / 2, -Math.PI / 2, termCCW);
      ctx.closePath();
      ctx.fillStyle = shadowCol;
      ctx.fill();
      ctx.restore();
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

  // Moon reflection on water
  if (moonAlt > 0) {
    var mRefTop = oceanTop, mRefBot = H * 0.86;
    var mRefWidth = (10 + m.illumination * 0.2) * dpr;
    var mRefAlpha = (m.illumination / 100) * 0.15;
    var mRefColor = '220,215,200';
    for (var mri = 0; mri < 10; mri++) {
      var mry = mRefTop + (mri / 10) * (mRefBot - mRefTop);
      var mrh = (mRefBot - mRefTop) / 12;
      var mrw = mRefWidth * (0.4 + Math.sin(mri * 1.5 + t * 0.4) * 0.25);
      var mrx = moonX - mrw / 2 + Math.sin(mri * 2.3 + t * 0.25) * 3 * dpr;
      var mra = mRefAlpha * (1 - mri / 12);
      ctx.fillStyle = 'rgba(' + mRefColor + ',' + mra.toFixed(3) + ')';
      ctx.fillRect(mrx, mry, mrw, mrh * 0.5);
    }
  }

  // Sun water reflection
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

  // Sky info label — on the beach
  if (labelText) {
    ctx.save();
    var labelSize = Math.round(10 * dpr);
    ctx.font = '500 ' + labelSize + 'px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var labelY = beachTop + (H - beachTop) * 0.55;
    // Ensure contrast: dark text on light sand, light text on dark sand
    ctx.fillStyle = alt > 5 ? 'rgba(60,45,25,0.6)' : alt > 0 ? 'rgba(180,160,130,0.5)' : 'rgba(160,150,130,0.35)';
    ctx.fillText(labelText, W / 2, labelY);
    ctx.restore();
  }

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

// ── Tonight's Sky — planet visibility ──

var _PLANET_V0 = { Mercury: -0.61, Venus: -4.40, Mars: -1.60, Jupiter: -9.40, Saturn: -8.88, Uranus: -7.19, Neptune: -6.87 };
var _VISIBLE_PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

function _planetVisibility(now) {
  var JD = 2440587.5 + now.getTime() / 86400000;
  var T = (JD - 2451545.0) / 36525;
  var earth = _planetPosition('Earth', T);
  var sunLon = (Math.atan2(-earth.y, -earth.x) * 180 / Math.PI + 360) % 360;
  var results = [];
  for (var i = 0; i < _VISIBLE_PLANETS.length; i++) {
    var name = _VISIBLE_PLANETS[i];
    var pos = _planetPosition(name, T);
    var dx = pos.x - earth.x, dy = pos.y - earth.y;
    var delta = Math.sqrt(dx * dx + dy * dy);
    var geoLon = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    var elong = ((geoLon - sunLon) + 540) % 360 - 180; // signed, -180 to +180
    var elongAbs = Math.abs(elong);
    var mag = _PLANET_V0[name] + 5 * Math.log10(pos.r * delta);
    // Phase angle correction for inner planets (rough)
    if (name === 'Venus' || name === 'Mercury') {
      var cosPA = (pos.r * pos.r + delta * delta - earth.r * earth.r) / (2 * pos.r * delta);
      cosPA = Math.max(-1, Math.min(1, cosPA));
      var phaseAngle = Math.acos(cosPA);
      var phaseFrac = (1 + Math.cos(phaseAngle)) / 2;
      mag += -2.5 * Math.log10(Math.max(0.01, phaseFrac));
    }
    var visible = mag < 5.5 && elongAbs > 12;
    var sky = elong > 0 ? 'Evening' : 'Morning';
    var dir = elong > 0 ? (elongAbs > 120 ? 'East' : elongAbs > 60 ? 'South' : 'West') :
                          (elongAbs > 120 ? 'West' : elongAbs > 60 ? 'South' : 'East');
    results.push({ name: name, elongation: elongAbs, magnitude: mag, visible: visible, sky: sky, direction: dir, distance: delta, color: _PLANETS[name].color });
  }
  return results;
}

function _renderTonightSky(now) {
  var el = document.getElementById('almanac-tonight');
  if (!el) return;
  var planets = _planetVisibility(now);
  var visible = planets.filter(function(p) { return p.visible; });
  visible.sort(function(a, b) { return a.magnitude - b.magnitude; }); // brightest first
  var notVisible = planets.filter(function(p) { return !p.visible; });
  var html = '';
  if (visible.length === 0) {
    html = '<div class="almanac-info-item" style="text-align:center"><div class="almanac-info-val">No planets visible</div><div class="almanac-info-lbl">All planets are too close to the sun right now</div></div>';
  } else {
    for (var i = 0; i < visible.length; i++) {
      var p = visible[i];
      var magStr = p.magnitude.toFixed(1);
      // Brightness indicator: dots based on magnitude
      var brightness = p.magnitude < -3 ? 'Brilliant' : p.magnitude < -1 ? 'Very bright' : p.magnitude < 1 ? 'Bright' : p.magnitude < 3 ? 'Visible' : 'Faint';
      html += '<div class="almanac-eclipse-row">' +
        '<div>' +
        '<span class="almanac-eclipse-type" style="color:' + p.color + '">' + p.name + '</span>' +
        '<br><span class="almanac-eclipse-date">' + brightness + ' &middot; mag ' + magStr + ' &middot; ' + p.elongation.toFixed(0) + '\u00b0 from Sun</span>' +
        '</div>' +
        '<div class="almanac-eclipse-until" style="font-size:11px">' + p.sky + '<br>' + p.direction + '</div></div>';
    }
    if (notVisible.length > 0) {
      var names = notVisible.map(function(p) { return p.name; });
      html += '<div style="margin-top:8px;font-size:11px;color:var(--text3);text-align:center">' + names.join(', ') + ' \u2014 not visible tonight</div>';
    }
  }
  el.innerHTML = html;
}

// ── Meteor Showers ──

var _METEOR_SHOWERS = [
  { name: 'Quadrantids', peak: [1, 3], zhr: 120, parent: '2003 EH\u2081', radiant: 'Bo\u00f6tes', speed: 'Medium' },
  { name: 'Lyrids', peak: [4, 22], zhr: 18, parent: 'C/1861 G1 Thatcher', radiant: 'Lyra', speed: 'Fast' },
  { name: 'Eta Aquariids', peak: [5, 6], zhr: 50, parent: '1P/Halley', radiant: 'Aquarius', speed: 'Fast' },
  { name: 'Southern Delta Aquariids', peak: [7, 30], zhr: 25, parent: '96P/Machholz', radiant: 'Aquarius', speed: 'Medium' },
  { name: 'Alpha Capricornids', peak: [7, 30], zhr: 5, parent: '169P/NEAT', radiant: 'Capricornus', speed: 'Slow' },
  { name: 'Perseids', peak: [8, 12], zhr: 100, parent: '109P/Swift\u2013Tuttle', radiant: 'Perseus', speed: 'Fast' },
  { name: 'Draconids', peak: [10, 8], zhr: 10, parent: '21P/Giacobini\u2013Zinner', radiant: 'Draco', speed: 'Slow' },
  { name: 'Orionids', peak: [10, 21], zhr: 20, parent: '1P/Halley', radiant: 'Orion', speed: 'Fast' },
  { name: 'Taurids', peak: [11, 5], zhr: 10, parent: '2P/Encke', radiant: 'Taurus', speed: 'Slow' },
  { name: 'Leonids', peak: [11, 17], zhr: 15, parent: '55P/Tempel\u2013Tuttle', radiant: 'Leo', speed: 'Fast' },
  { name: 'Geminids', peak: [12, 14], zhr: 150, parent: '3200 Phaethon', radiant: 'Gemini', speed: 'Medium' },
  { name: 'Ursids', peak: [12, 22], zhr: 10, parent: '8P/Tuttle', radiant: 'Ursa Minor', speed: 'Medium' }
];

function _renderMeteorShowers(now, moon) {
  var el = document.getElementById('almanac-meteors');
  if (!el) return;
  var y = now.getFullYear();
  var upcoming = [];
  // Check this year and next for upcoming showers
  for (var yr = y; yr <= y + 1; yr++) {
    for (var si = 0; si < _METEOR_SHOWERS.length; si++) {
      var s = _METEOR_SHOWERS[si];
      var peakDate = new Date(yr, s.peak[0] - 1, s.peak[1]);
      var daysUntil = Math.round((peakDate - now) / 86400000);
      if (daysUntil >= -1 && daysUntil <= 365) {
        // Moon interference: check moon illumination on peak night
        var peakMoon = _moonPhase(peakDate);
        var moonInterference = peakMoon.illumination > 60 ? 'Poor' : peakMoon.illumination > 30 ? 'Fair' : 'Ideal';
        var moonIcon = peakMoon.illumination > 60 ? '\u{1F315}' : peakMoon.illumination > 30 ? '\u{1F313}' : '\u{1F311}';
        upcoming.push({
          name: s.name, zhr: s.zhr, parent: s.parent, radiant: s.radiant,
          speed: s.speed, date: peakDate, daysUntil: daysUntil,
          moonCondition: moonInterference, moonIcon: moonIcon,
          moonIllum: peakMoon.illumination
        });
      }
    }
  }
  upcoming.sort(function(a, b) { return a.daysUntil - b.daysUntil; });
  upcoming = upcoming.slice(0, 5);

  var html = '';
  for (var i = 0; i < upcoming.length; i++) {
    var s = upcoming[i];
    var untilStr = s.daysUntil < 0 ? 'Peak!' : s.daysUntil === 0 ? 'Tonight!' : s.daysUntil === 1 ? 'Tomorrow' : s.daysUntil + ' days';
    var rateDesc = s.zhr >= 100 ? 'Major' : s.zhr >= 25 ? 'Moderate' : 'Minor';
    var condColor = s.moonCondition === 'Ideal' ? 'var(--accent)' : s.moonCondition === 'Fair' ? 'var(--text2)' : 'var(--text3)';
    html += '<div class="almanac-eclipse-row">' +
      '<div>' +
      '<span class="almanac-eclipse-type">' + s.name + '</span>' +
      '<br><span class="almanac-eclipse-date">~' + s.zhr + '/hr &middot; ' + s.radiant + ' &middot; ' + s.speed +
      ' &middot; <span style="color:' + condColor + '">' + s.moonIcon + ' ' + s.moonCondition + '</span></span>' +
      '</div>' +
      '<div class="almanac-eclipse-until">' + untilStr + '</div></div>';
  }
  html += '<div style="margin-top:10px;font-size:11px;color:var(--text3)">Moon conditions: ' +
    '\u{1F311} Ideal (dark sky) &middot; \u{1F313} Fair &middot; \u{1F315} Poor (moonlight washes out faint meteors)</div>';
  el.innerHTML = html;
}

// ── Celestial Events — conjunctions, oppositions, elongations ──

function _scanCelestialEvents(now) {
  var JD0 = 2440587.5 + now.getTime() / 86400000;
  var scanNames = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
  var events = [];

  // Precompute positions at 2-day intervals for 400 days (speed vs accuracy tradeoff)
  var DAYS = 400, STEP = 2;
  var cache = {};
  for (var d = 0; d <= DAYS; d += STEP) {
    var T = (JD0 + d - 2451545.0) / 36525;
    cache[d] = { Earth: _planetPosition('Earth', T) };
    for (var pi = 0; pi < scanNames.length; pi++) {
      cache[d][scanNames[pi]] = _planetPosition(scanNames[pi], T);
    }
  }

  // Scan for conjunctions (angular separation < 5° between planet pairs)
  for (var i = 0; i < scanNames.length - 1; i++) {
    for (var j = i + 1; j < scanNames.length; j++) {
      var bestSep = 999, bestDay = 0;
      for (var d = STEP; d <= DAYS; d += STEP) {
        var e = cache[d].Earth;
        var p1 = cache[d][scanNames[i]], p2 = cache[d][scanNames[j]];
        var lon1 = Math.atan2(p1.y - e.y, p1.x - e.x);
        var lon2 = Math.atan2(p2.y - e.y, p2.x - e.x);
        var sep = Math.abs(((lon1 - lon2) * 180 / Math.PI + 540) % 360 - 180);
        if (sep < bestSep) { bestSep = sep; bestDay = d; }
      }
      if (bestSep < 5) {
        events.push({ type: 'conjunction', planets: [scanNames[i], scanNames[j]],
          separation: bestSep, daysUntil: bestDay,
          date: new Date(now.getTime() + bestDay * 86400000) });
      }
    }
  }

  // Scan for oppositions (Mars, Jupiter, Saturn — elongation nearest 180°)
  var outerPlanets = ['Mars', 'Jupiter', 'Saturn'];
  for (var pi = 0; pi < outerPlanets.length; pi++) {
    var bestDiff = 999, bestDay = 0;
    for (var d = STEP; d <= DAYS; d += STEP) {
      var e = cache[d].Earth;
      var p = cache[d][outerPlanets[pi]];
      if (!p) continue;
      var sunLon = Math.atan2(-e.y, -e.x);
      var geoLon = Math.atan2(p.y - e.y, p.x - e.x);
      var elong = Math.abs(((geoLon - sunLon) * 180 / Math.PI + 540) % 360 - 180);
      var diff = Math.abs(180 - elong);
      if (diff < bestDiff) { bestDiff = diff; bestDay = d; }
    }
    if (bestDiff < 8 && bestDay > 0) {
      events.push({ type: 'opposition', planet: outerPlanets[pi], daysUntil: bestDay,
        date: new Date(now.getTime() + bestDay * 86400000) });
    }
  }

  // Scan for greatest elongation (Mercury, Venus — max angular distance from sun)
  var innerPlanets = ['Mercury', 'Venus'];
  for (var pi = 0; pi < innerPlanets.length; pi++) {
    // Find local maxima in elongation
    var prevElong = 0, rising = false, bestElong = 0, bestDay = 0, foundCount = 0;
    for (var d = STEP; d <= DAYS && foundCount < 2; d += STEP) {
      var e = cache[d].Earth;
      var p = cache[d][innerPlanets[pi]];
      if (!p) continue;
      var sunLon = Math.atan2(-e.y, -e.x);
      var geoLon = Math.atan2(p.y - e.y, p.x - e.x);
      var elong = Math.abs(((geoLon - sunLon) * 180 / Math.PI + 540) % 360 - 180);
      if (elong > prevElong) {
        rising = true; bestElong = elong; bestDay = d;
      } else if (rising && elong < prevElong && bestElong > 15) {
        // Determine if evening or morning
        var signedElong = ((geoLon - sunLon) * 180 / Math.PI + 540) % 360 - 180;
        var sky = signedElong > 0 ? 'evening' : 'morning';
        events.push({ type: 'elongation', planet: innerPlanets[pi], elongation: bestElong,
          sky: sky, daysUntil: bestDay, date: new Date(now.getTime() + bestDay * 86400000) });
        rising = false; bestElong = 0; foundCount++;
      }
      prevElong = elong;
    }
  }

  events.sort(function(a, b) { return a.daysUntil - b.daysUntil; });
  return events;
}

function _renderCelestialEvents(now) {
  var el = document.getElementById('almanac-events');
  if (!el) return;
  var events = _scanCelestialEvents(now);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  var html = '';
  if (events.length === 0) {
    html = '<div style="text-align:center;color:var(--text3);font-size:13px;padding:12px 0">No notable events in the next year</div>';
  } else {
    var soonEvents = [], laterEvents = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].daysUntil <= 60) soonEvents.push(events[i]);
      else laterEvents.push(events[i]);
    }
    var allVisible = soonEvents.concat(laterEvents);
    for (var i = 0; i < allVisible.length; i++) {
      var ev = allVisible[i];
      var dateStr = months[ev.date.getMonth()] + ' ' + ev.date.getDate() + ', ' + ev.date.getFullYear();
      var untilStr = ev.daysUntil <= 1 ? 'Now!' : ev.daysUntil + ' days';
      var title, detail;
      if (ev.type === 'conjunction') {
        title = ev.planets[0] + ' \u2013 ' + ev.planets[1] + ' Conjunction';
        detail = ev.separation.toFixed(1) + '\u00b0 apart &middot; ' + dateStr;
      } else if (ev.type === 'opposition') {
        title = ev.planet + ' at Opposition';
        detail = 'Closest &amp; brightest &middot; ' + dateStr;
      } else if (ev.type === 'elongation') {
        title = ev.planet + ' Greatest Elongation';
        detail = ev.elongation.toFixed(1) + '\u00b0 &middot; ' + ev.sky + ' sky &middot; ' + dateStr;
      }
      var hidden = (i >= soonEvents.length && laterEvents.length > 0) ? ' style="display:none" class="almanac-eclipse-row almanac-event-later"' : ' class="almanac-eclipse-row"';
      html += '<div' + hidden + '>' +
        '<div><span class="almanac-eclipse-type">' + title + '</span><br>' +
        '<span class="almanac-eclipse-date">' + detail + '</span></div>' +
        '<div class="almanac-eclipse-until">' + untilStr + '</div></div>';
    }
    if (laterEvents.length > 0) {
      html += '<div style="text-align:center;margin-top:8px">' +
        '<a class="almanac-location-link" onclick="var els=document.querySelectorAll(\'.almanac-event-later\');for(var i=0;i<els.length;i++)els[i].style.display=\'\';this.parentElement.style.display=\'none\'">' +
        'Show ' + laterEvents.length + ' more\u2026</a></div>';
    }
  }
  el.innerHTML = html;
}

// ── Almanac Calendar — wall calendar with events ──

// Easter — Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
function _computeEaster(year) {
  var a = year % 19, b = Math.floor(year / 100), c = year % 100;
  var d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4), k = c % 4;
  var l = (32 + 2 * e + 2 * i - h - k) % 7;
  var m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31);
  var day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month: month, day: day };
}

// Nth weekday of month: weekday 0=Sun..6=Sat, n=1..5
function _nthWeekday(year, month, weekday, n) {
  var first = new Date(year, month - 1, 1).getDay();
  var day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return day;
}

// Last weekday of month
function _lastWeekday(year, month, weekday) {
  var last = new Date(year, month, 0); // last day of month
  var lastDay = last.getDate();
  var lastDow = last.getDay();
  var diff = (lastDow - weekday + 7) % 7;
  return lastDay - diff;
}

// Get almanac events for a given calendar system's month, keyed by day number
function _getAlmanacEvents(sys, year, month) {
  var events = {};
  function add(day, label, type, icon) {
    if (day < 1 || day > 31) return;
    if (!events[day]) events[day] = [];
    events[day].push({ label: label, type: type, icon: icon || '' });
  }

  if (sys === 'gregorian') {
    // Fixed holidays
    if (month === 1) { add(1, "New Year's Day", 'holiday'); add(6, 'Epiphany', 'holiday'); }
    if (month === 2) { add(2, 'Groundhog Day', 'holiday'); add(14, "Valentine's Day", 'holiday'); }
    if (month === 3) { add(8, "International Women's Day", 'holiday'); add(17, "St. Patrick's Day", 'holiday'); }
    if (month === 4) { add(1, "April Fools' Day", 'holiday'); add(22, 'Earth Day', 'holiday'); }
    if (month === 5) { add(1, 'May Day', 'holiday'); add(5, 'Cinco de Mayo', 'holiday'); }
    if (month === 6) { add(19, 'Juneteenth', 'holiday'); add(21, 'International Yoga Day', 'holiday'); }
    if (month === 7) { add(4, 'Independence Day', 'holiday'); }
    if (month === 10) { add(31, 'Halloween', 'holiday'); }
    if (month === 11) { add(11, 'Veterans Day', 'holiday'); }
    if (month === 12) { add(24, 'Christmas Eve', 'holiday'); add(25, 'Christmas Day', 'holiday'); add(26, 'Kwanzaa', 'holiday'); add(31, "New Year's Eve", 'holiday'); }
    // Computed holidays
    if (month === 1) { add(_nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day', 'holiday'); }
    if (month === 2) { add(_nthWeekday(year, 2, 1, 3), "Presidents' Day", 'holiday'); }
    if (month === 5) { add(_nthWeekday(year, 5, 0, 2), "Mother's Day", 'holiday'); add(_lastWeekday(year, 5, 1), 'Memorial Day', 'holiday'); }
    if (month === 6) { add(_nthWeekday(year, 6, 0, 3), "Father's Day", 'holiday'); }
    if (month === 9) { add(_nthWeekday(year, 9, 1, 1), 'Labor Day', 'holiday'); }
    if (month === 10) { add(_nthWeekday(year, 10, 1, 2), 'Indigenous Peoples\' Day', 'holiday'); }
    if (month === 11) { add(_nthWeekday(year, 11, 4, 4), 'Thanksgiving', 'holiday'); }
    // Easter and related
    var easter = _computeEaster(year);
    if (easter.month === month) { add(easter.day, 'Easter', 'holiday'); }
    var gfDate = new Date(year, easter.month - 1, easter.day - 2);
    if (gfDate.getMonth() + 1 === month) { add(gfDate.getDate(), 'Good Friday', 'holiday'); }
    var ashWed = new Date(year, easter.month - 1, easter.day - 46);
    if (ashWed.getMonth() + 1 === month) { add(ashWed.getDate(), 'Ash Wednesday', 'holiday'); }
    var palmSun = new Date(year, easter.month - 1, easter.day - 7);
    if (palmSun.getMonth() + 1 === month) { add(palmSun.getDate(), 'Palm Sunday', 'holiday'); }
    var ascension = new Date(year, easter.month - 1, easter.day + 39);
    if (ascension.getMonth() + 1 === month) { add(ascension.getDate(), 'Ascension', 'holiday'); }
    var pentecost = new Date(year, easter.month - 1, easter.day + 49);
    if (pentecost.getMonth() + 1 === month) { add(pentecost.getDate(), 'Pentecost', 'holiday'); }
    // DST (US)
    if (month === 3) { add(_nthWeekday(year, 3, 0, 2), 'Spring Forward', 'seasonal'); }
    if (month === 11) { add(_nthWeekday(year, 11, 0, 1), 'Fall Back', 'seasonal'); }
    // Solstices & Equinoxes
    if (month === 3) { add(20, 'Spring Equinox', 'astro'); }
    if (month === 6) { add(20, 'Summer Solstice', 'astro'); }
    if (month === 9) { add(22, 'Autumn Equinox', 'astro'); }
    if (month === 12) { add(21, 'Winter Solstice', 'astro'); }
  }

  else if (sys === 'hebrew') {
    // Hebrew month indices: 1=Tishrei, 2=Marcheshvan, 3=Kislev, 4=Tevet, 5=Shevat,
    // 6=Adar I (leap), 7=Adar/Adar II, 8=Nisan, 9=Iyar, 10=Sivan, 11=Tammuz, 12=Av, 13=Elul
    var isLeap = _hebrewLeapYear(year);
    var adar = isLeap ? 7 : 6; // Adar (or Adar II in leap year)
    if (month === 1) { add(1, 'Rosh Hashanah', 'holiday'); add(2, 'Rosh Hashanah II', 'holiday'); add(3, 'Tzom Gedaliah', 'holiday'); add(10, 'Yom Kippur', 'holiday'); add(15, 'Sukkot', 'holiday'); add(16, 'Sukkot II', 'holiday'); add(21, 'Hoshana Rabbah', 'holiday'); add(22, "Sh'mini Atzeret", 'holiday'); add(23, 'Simchat Torah', 'holiday'); }
    if (month === 3) { add(25, 'Hanukkah I', 'holiday'); add(26, 'Hanukkah II', 'holiday'); add(27, 'Hanukkah III', 'holiday'); add(28, 'Hanukkah IV', 'holiday'); add(29, 'Hanukkah V', 'holiday'); }
    if (month === 4) { add(1, 'Hanukkah VII', 'holiday'); add(2, 'Hanukkah VIII', 'holiday'); add(10, 'Asara B\'Tevet', 'holiday'); }
    if (month === 5) { add(15, "Tu BiShvat", 'holiday'); }
    if (month === adar) { add(13, 'Fast of Esther', 'holiday'); add(14, 'Purim', 'holiday'); add(15, 'Shushan Purim', 'holiday'); }
    if (month === 8) { add(14, 'Erev Pesach', 'holiday'); add(15, 'Passover', 'holiday'); add(16, 'Passover II', 'holiday'); add(21, 'Passover VII', 'holiday'); add(22, 'Passover VIII', 'holiday'); add(27, 'Yom HaShoah', 'holiday'); }
    if (month === 9) { add(4, 'Yom HaZikaron', 'holiday'); add(5, "Yom Ha'Atzmaut", 'holiday'); add(14, 'Pesach Sheni', 'holiday'); add(18, "Lag BaOmer", 'holiday'); add(28, 'Yom Yerushalayim', 'holiday'); }
    if (month === 10) { add(6, 'Shavuot', 'holiday'); add(7, 'Shavuot II', 'holiday'); }
    if (month === 11) { add(17, "Tzom Tammuz", 'holiday'); }
    if (month === 12) { add(9, "Tisha B'Av", 'holiday'); add(15, "Tu B'Av", 'holiday'); }
    if (month === 13) { add(29, 'Erev Rosh Hash.', 'holiday'); }
  }

  else if (sys === 'islamic') {
    // Islamic months: 1=Muharram..12=Dhu al-Hijjah
    if (month === 1) { add(1, 'Islamic New Year', 'holiday'); add(9, 'Tasu\u2019a', 'holiday'); add(10, 'Ashura', 'holiday'); }
    if (month === 2) { add(20, 'Arba\u2019een', 'holiday'); }
    if (month === 3) { add(1, 'Rabi\u2019 al-Awwal', 'holiday'); add(12, 'Mawlid', 'holiday'); add(17, 'Mawlid (Shia)', 'holiday'); }
    if (month === 7) { add(1, 'Rajab begins', 'holiday'); add(13, '1st White Night', 'holiday'); add(27, "Isra Mi'raj", 'holiday'); }
    if (month === 8) { add(1, "Sha'ban begins", 'holiday'); add(15, "Sha'ban Night", 'holiday'); }
    if (month === 9) { add(1, 'Ramadan begins', 'holiday'); add(17, 'Nuzul al-Quran', 'holiday'); add(21, 'Laylat al-Qadr', 'holiday'); add(27, 'Laylat al-Qadr', 'holiday'); }
    if (month === 10) { add(1, 'Eid al-Fitr', 'holiday'); add(2, 'Eid al-Fitr II', 'holiday'); add(3, 'Eid al-Fitr III', 'holiday'); }
    if (month === 12) { add(1, 'Dhul Hijjah', 'holiday'); add(8, 'Hajj begins', 'holiday'); add(9, 'Day of Arafah', 'holiday'); add(10, 'Eid al-Adha', 'holiday'); add(11, 'Eid al-Adha II', 'holiday'); add(12, 'Eid al-Adha III', 'holiday'); add(13, 'Eid al-Adha IV', 'holiday'); }
  }

  else if (sys === 'persian') {
    // Persian months: 1=Farvardin..12=Esfand
    if (month === 1) { add(1, 'Nowruz', 'holiday'); add(2, 'Nowruz II', 'holiday'); add(3, 'Nowruz III', 'holiday'); add(4, 'Nowruz IV', 'holiday'); add(6, 'Jashn-e Tirgan', 'holiday'); add(12, 'Islamic Republic', 'holiday'); add(13, 'Sizdah Bedar', 'holiday'); }
    if (month === 3) { add(14, 'Khordad Uprising', 'holiday'); }
    if (month === 4) { add(1, 'Tirgan', 'holiday'); }
    if (month === 5) { add(10, 'Mehrgan', 'holiday'); }
    if (month === 7) { add(10, 'Mehregan', 'holiday'); }
    if (month === 8) { add(10, 'Aban Festival', 'holiday'); }
    if (month === 9) { add(1, 'Azar Festival', 'holiday'); add(30, 'Yalda Night', 'holiday'); }
    if (month === 10) { add(5, 'Sadeh', 'holiday'); }
    if (month === 11) { add(22, 'Revolution Day', 'holiday'); add(29, 'Chaharshanbe Suri', 'holiday'); }
    if (month === 12) { add(29, 'Oil Nationalization', 'holiday'); }
  }

  else if (sys === 'chinese') {
    // Chinese months: 1=Zhengyue..12=Layue
    if (month === 1) { add(1, 'Spring Festival', 'holiday'); add(2, 'Spring Festival II', 'holiday'); add(3, 'Spring Festival III', 'holiday'); add(5, 'Po Wu', 'holiday'); add(7, 'Renri', 'holiday'); add(9, 'Jade Emperor', 'holiday'); add(15, 'Lantern Festival', 'holiday'); }
    if (month === 2) { add(2, 'Zhonghe Festival', 'holiday'); }
    if (month === 3) { add(3, 'Shangsi Festival', 'holiday'); add(5, 'Qingming', 'holiday'); }
    if (month === 5) { add(5, 'Dragon Boat', 'holiday'); }
    if (month === 6) { add(6, 'Tiankuang Fest.', 'holiday'); add(24, 'Torch Festival', 'holiday'); }
    if (month === 7) { add(7, 'Qixi (Lovers)', 'holiday'); add(15, 'Ghost Festival', 'holiday'); }
    if (month === 8) { add(15, 'Mid-Autumn', 'holiday'); }
    if (month === 9) { add(9, 'Chongyang', 'holiday'); }
    if (month === 10) { add(1, 'Hanyi Festival', 'holiday'); add(15, 'Xiayuan Fest.', 'holiday'); }
    if (month === 12) { add(8, 'Laba Festival', 'holiday'); add(23, 'Little New Year', 'holiday'); add(30, 'Chuxi (NYE)', 'holiday'); }
  }

  else if (sys === 'buddhist') {
    // Buddhist calendar uses Gregorian months
    if (month === 1) { add(1, "New Year's", 'holiday'); add(25, 'Mahayana NY', 'holiday'); }
    if (month === 2) { add(8, 'Nirvana Day', 'holiday'); add(15, 'Parinirvana', 'holiday'); }
    if (month === 3) { add(1, 'Magha Puja', 'holiday'); }
    if (month === 4) { add(8, "Buddha's Birthday", 'holiday'); add(13, 'Songkran', 'holiday'); add(14, 'Songkran', 'holiday'); add(15, 'Songkran', 'holiday'); }
    if (month === 5) { add(15, 'Vesak', 'holiday'); }
    if (month === 6) { add(4, 'Poson Poya', 'holiday'); }
    if (month === 7) { add(19, 'Dharma Day', 'holiday'); add(24, 'Asalha Puja', 'holiday'); add(25, 'Vassa begins', 'holiday'); }
    if (month === 10) { add(13, 'Vassa ends', 'holiday'); add(24, 'Kathina', 'holiday'); }
    if (month === 11) { add(15, 'Loy Krathong', 'holiday'); }
    if (month === 12) { add(8, 'Bodhi Day', 'holiday'); }
  }

  else if (sys === 'julian') {
    // Julian calendar — Orthodox/Eastern Christianity
    if (month === 1) { add(1, "New Year's Day", 'holiday'); add(5, 'Paramony', 'holiday'); add(6, 'Theophany', 'holiday'); add(7, 'Christmas (Julian)', 'holiday'); add(19, 'Epiphany (Julian)', 'holiday'); }
    if (month === 2) { add(2, 'Presentation of Jesus', 'holiday'); add(15, 'Meatfare Sunday', 'holiday'); }
    if (month === 3) { add(25, 'Annunciation', 'holiday'); }
    if (month === 8) { add(6, 'Transfiguration', 'holiday'); add(15, 'Dormition of the Theotokos', 'holiday'); }
    if (month === 9) { add(8, 'Nativity of Mary', 'holiday'); add(14, 'Exaltation of the Cross', 'holiday'); }
    if (month === 11) { add(21, 'Presentation of Mary', 'holiday'); }
    if (month === 12) { add(25, 'Christmas Day', 'holiday'); add(6, "St. Nicholas Day", 'holiday'); }
  }

  // Meteor shower peaks (only for Gregorian — they use Gregorian dates)
  if (sys === 'gregorian') {
    for (var si = 0; si < _METEOR_SHOWERS.length; si++) {
      var s = _METEOR_SHOWERS[si];
      if (s.peak[0] === month) { add(s.peak[1], s.name, 'meteor', '\u2604'); }
    }
  }

  return events;
}

// Almanac calendar state
var _almSystem = 'gregorian';
var _almYear = 0, _almMonth = 0;
var _almSelectedJDN = 0, _almTodayJDN = 0;

var _ALM_SYSTEMS = [
  { id: 'buddhist', label: 'Buddhist' },
  { id: 'chinese', label: 'Chinese' },
  { id: 'gregorian', label: 'Gregorian' },
  { id: 'hebrew', label: 'Hebrew' },
  { id: 'islamic', label: 'Islamic' },
  { id: 'julian', label: 'Julian' },
  { id: 'persian', label: 'Persian' }
];

function _renderAlmanacCalendar(now) {
  var el = document.getElementById('almanac-calendar');
  if (!el) return;
  var todayJDN = _gregorianToJDN(now.getFullYear(), now.getMonth() + 1, now.getDate());
  _almTodayJDN = todayJDN;
  if (_almSelectedJDN === 0) _almSelectedJDN = todayJDN;
  if (_almYear === 0) {
    var cal = _jdnToCalendar(_almSystem, todayJDN);
    _almYear = cal.year; _almMonth = cal.month;
  }
  _drawAlmanacGrid();
}

function _drawAlmanacGrid() {
  var el = document.getElementById('almanac-calendar');
  if (!el) return;

  var daysInMonth = _calDaysInMonth(_almSystem, _almYear, _almMonth);
  var firstJDN = _calFirstDayJDN(_almSystem, _almYear, _almMonth);
  var firstDow = ((firstJDN + 1) % 7); // 0=Sun
  var monthName = _calMonthName(_almSystem, _almYear, _almMonth);

  // Today's JDN for highlighting
  var today = new Date();
  var todayJDN = _gregorianToJDN(today.getFullYear(), today.getMonth() + 1, today.getDate());

  var events = _getAlmanacEvents(_almSystem, _almYear, _almMonth);

  // Year suffix
  var yearStr = _almYear.toString();
  if (_almSystem === 'islamic') yearStr += ' AH';
  else if (_almSystem === 'persian') yearStr += ' SH';
  else if (_almSystem === 'buddhist') yearStr += ' BE';

  var html = '';

  // Navigation
  html += '<div class="alm-nav">';
  html += '<button class="alm-arrow" onclick="_almPrev()">\u25C0</button>';
  html += '<div class="alm-title">' + monthName + ' ' + yearStr + '</div>';
  html += '<button class="alm-arrow" onclick="_almNext()">\u25B6</button>';
  var todayCal = _jdnToCalendar(_almSystem, todayJDN);
  var isCurrentMonth = (_almYear === todayCal.year && _almMonth === todayCal.month);
  var isToSelected = (_almSelectedJDN === _almTodayJDN);
  html += '<button class="alm-today-btn" onclick="_almToday()"' + (isCurrentMonth && isToSelected ? ' style="visibility:hidden"' : '') + '>Today</button>';
  html += '</div>';

  // Grid
  html += '<div class="alm-grid">';
  var dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (var i = 0; i < 7; i++) {
    html += '<div class="alm-hdr">' + dayLabels[i] + '</div>';
  }
  for (var i = 0; i < firstDow; i++) {
    html += '<div class="alm-cell alm-empty"></div>';
  }
  for (var d = 1; d <= daysInMonth; d++) {
    var cellJDN = firstJDN + d - 1;
    var isToday = (cellJDN === todayJDN);
    var isSelected = (cellJDN === _almSelectedJDN);
    var cls = 'alm-cell alm-day' + (isToday ? ' alm-today' : '') + (isSelected ? ' alm-selected' : '');
    var dayEvents = events[d] || [];
    html += '<div class="' + cls + '" onclick="_almSelectDay(' + cellJDN + ')">';
    html += '<div class="alm-num">' + d + '</div>';
    var shown = Math.min(dayEvents.length, 2);
    for (var ei = 0; ei < shown; ei++) {
      var ev = dayEvents[ei];
      var escapedLabel = ev.label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += '<div class="alm-ev alm-ev-' + ev.type + '">' +
        (ev.icon ? ev.icon + ' ' : '') + escapedLabel + '</div>';
    }
    if (dayEvents.length > 2) {
      html += '<div class="alm-ev alm-ev-more">+' + (dayEvents.length - 2) + '</div>';
    }
    html += '</div>';
  }
  // Trailing empty cells to fill last row
  var totalCells = firstDow + daysInMonth;
  var trailingEmpty = (7 - (totalCells % 7)) % 7;
  for (var i = 0; i < trailingEmpty; i++) {
    html += '<div class="alm-cell alm-empty"></div>';
  }
  html += '</div>';

  // Selected day detail — full event list for the selected day
  var selCal = _jdnToCalendar(_almSystem, _almSelectedJDN);
  if (selCal.year === _almYear && selCal.month === _almMonth) {
    var selEvents = events[selCal.day] || [];
    if (selEvents.length > 0) {
      html += '<div class="alm-day-detail">';
      for (var ei = 0; ei < selEvents.length; ei++) {
        var ev = selEvents[ei];
        html += '<div class="alm-ev alm-ev-' + ev.type + '" style="font-size:12px;padding:2px 0">' +
          (ev.icon ? ev.icon + ' ' : '') + ev.label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
      }
      html += '</div>';
    }
  }

  // Cross-reference — selected date in all calendar systems (replaces pills)
  html += _almRenderCrossRef(_almSelectedJDN);

  el.innerHTML = html;
}

function _almSwitchSystem(sys) {
  // Convert selected day's JDN to the new system
  _almSystem = sys;
  var cal = _jdnToCalendar(sys, _almSelectedJDN);
  _almYear = cal.year;
  _almMonth = cal.month;
  _drawAlmanacGrid();
}

function _almSelectDay(jdn) {
  _almSelectedJDN = jdn;
  // If clicked day is outside current month view, navigate to it
  var cal = _jdnToCalendar(_almSystem, jdn);
  if (cal.year !== _almYear || cal.month !== _almMonth) {
    _almYear = cal.year;
    _almMonth = cal.month;
  }
  _drawAlmanacGrid();
}

function _almRenderCrossRef(jdn) {
  var greg = _jdnToGregorian(jdn);
  var html = '<div class="alm-crossref">';
  for (var i = 0; i < _CAL_SYSTEMS.length; i++) {
    var sys = _CAL_SYSTEMS[i];
    var cal = _jdnToCalendar(sys, jdn);
    var monthName = _calMonthName(sys, cal.year, cal.month);
    var yearStr = cal.year.toString();
    if (sys === 'islamic') yearStr += ' AH';
    else if (sys === 'persian') yearStr += ' SH';
    else if (sys === 'buddhist') yearStr += ' BE';
    var dateStr = monthName + ' ' + cal.day + ', ' + yearStr;
    if (sys === 'chinese') {
      var chinese = _chineseZodiac(greg.year);
      dateStr = monthName + ' ' + cal.day + ' \u00b7 ' + chinese.animal + ' \u00b7 ' + yearStr;
    }
    var isActive = sys === _almSystem ? ' alm-crossref-active' : '';
    html += '<div class="alm-crossref-row' + isActive + '" onclick="_almSwitchSystem(\'' + sys + '\')">' +
      '<span class="alm-crossref-label">' + _CAL_LABELS[sys] + '</span>' +
      '<span class="alm-crossref-date">' + dateStr + '</span>' +
      '</div>';
  }
  html += '</div>';
  return html;
}

function _almPrev() {
  _almMonth--;
  if (_almMonth < 1) { _almYear--; _almMonth = _calMonthCount(_almSystem, _almYear); }
  _drawAlmanacGrid();
}

function _almNext() {
  var max = _calMonthCount(_almSystem, _almYear);
  _almMonth++;
  if (_almMonth > max) { _almYear++; _almMonth = 1; }
  _drawAlmanacGrid();
}

function _almToday() {
  _almSelectedJDN = _almTodayJDN;
  var cal = _jdnToCalendar(_almSystem, _almTodayJDN);
  _almYear = cal.year;
  _almMonth = cal.month;
  _drawAlmanacGrid();
}

// ── World Calendars — every date across civilizations ──

// Shared JDN utilities — used by all calendar conversions
function _gregorianToJDN(year, month, day) {
  var a = Math.floor((14 - month) / 12);
  var y = year + 4800 - a;
  var m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function _jdnToGregorian(jdn) {
  var a = jdn + 32044;
  var b = Math.floor((4 * a + 3) / 146097);
  var c = a - Math.floor(146097 * b / 4);
  var d = Math.floor((4 * c + 3) / 1461);
  var e = c - Math.floor(1461 * d / 4);
  var m = Math.floor((5 * e + 2) / 153);
  var day = e - Math.floor((153 * m + 2) / 5) + 1;
  var month = m + 3 - 12 * Math.floor(m / 10);
  var year = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year: year, month: month, day: day };
}

// Hebrew calendar helpers (module scope — needed for reverse conversion + month grid)
var _HEBREW_EPOCH = 347995.5; // Hebrew epoch in JDN

function _hebrewDelay1(yr) {
  var months = Math.floor((235 * yr - 234) / 19);
  var parts = 12084 + 13753 * months;
  var day0 = months * 29 + Math.floor(parts / 25920);
  if ((3 * (day0 + 1)) % 7 < 3) day0++;
  return day0;
}
function _hebrewDelay2(yr) {
  var last = _hebrewDelay1(yr - 1);
  var present = _hebrewDelay1(yr);
  var next = _hebrewDelay1(yr + 1);
  if (next - present === 356) return 2;
  if (present - last === 382) return 1;
  return 0;
}
function _hebrewNewYear(yr) {
  return _HEBREW_EPOCH + _hebrewDelay1(yr) + _hebrewDelay2(yr);
}
function _hebrewDaysInYear(yr) {
  return Math.round(_hebrewNewYear(yr + 1) - _hebrewNewYear(yr));
}
function _hebrewMonthDays(yr, mo) {
  var diy = _hebrewDaysInYear(yr);
  if (mo === 2) return (diy % 10 === 5) ? 30 : 29;     // Marcheshvan
  if (mo === 3) return (diy % 10 === 3) ? 29 : 30;     // Kislev
  if (mo === 5) return 30;                               // Shevat
  if (mo === 6) return _hebrewLeapYear(yr) ? 30 : 0;   // Adar I
  if (mo === 7) return 29;                               // Adar (or Adar II)
  if (mo === 8) return 30; if (mo === 9) return 29;
  if (mo === 10) return 30; if (mo === 11) return 29;
  if (mo === 12) return 30; if (mo === 13) return 29;
  if (mo === 1) return 30;                               // Tishrei (civil month 1)
  return 29;
}
function _hebrewLeapYear(yr) { return ((7 * yr + 1) % 19) < 7; }

// Hebrew calendar (Maimonides algorithm)
// Persian (Solar Hijri) Calendar — algorithmic
function _gregorianToPersian(gy, gm, gd) {
  // 33-year subcycle algorithm (jalaali-js, well-tested)
  var gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  var gy2 = (gm > 2) ? (gy + 1) : gy;
  var days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];

  var jy = -1595 + 33 * Math.floor(days / 12053);
  days = days % 12053;
  jy += 4 * Math.floor(days / 1461);
  days = days % 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }

  var jm, jd;
  if (days < 186) { jm = 1 + Math.floor(days / 31); jd = 1 + (days % 31); }
  else { jm = 7 + Math.floor((days - 186) / 30); jd = 1 + ((days - 186) % 30); }

  var persianMonths = ['Farvardin','Ordibehesht','Khordad','Tir','Mordad','Shahrivar',
    'Mehr','Aban','Azar','Dey','Bahman','Esfand'];
  return { year: jy, month: persianMonths[jm - 1], day: jd };
}

// Chinese calendar — 60-year cycle (Heavenly Stems + Earthly Branches)
function _chineseZodiac(year) {
  var stems = ['\u7532','\u4e59','\u4e19','\u4e01','\u620a','\u5df1','\u5e9a','\u8f9b','\u58ec','\u7678'];
  var branches = ['\u5b50','\u4e11','\u5bc5','\u536f','\u8fb0','\u5df3','\u5348','\u672a','\u7533','\u9149','\u620c','\u4ea5'];
  var animals = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];
  var elements = ['Wood','Wood','Fire','Fire','Earth','Earth','Metal','Metal','Water','Water'];
  var offset = year - 4; // 4 CE was a Jia-Zi year
  var stemIdx = ((offset % 10) + 10) % 10;
  var branchIdx = ((offset % 12) + 12) % 12;
  var cycleYear = ((offset % 60) + 60) % 60 + 1;
  // Chinese year number (approximate — Chinese New Year is Jan/Feb)
  var chineseYear = year + 2697; // Huang Di epoch (approximate)
  return {
    stem: stems[stemIdx], branch: branches[branchIdx],
    animal: animals[branchIdx], element: elements[stemIdx],
    cycle: stems[stemIdx] + branches[branchIdx],
    cycleYear: cycleYear, year: chineseYear
  };
}

// ── Reverse conversions — calendar date → JDN ──

// Hebrew → JDN: sum days from Tishrei 1
function _hebrewToJDN(year, monthIdx, day) {
  // monthIdx is civil order: 0=Tishrei, 1=Marcheshvan, ...
  var civilOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // internal month codes
  var jdn = Math.floor(_hebrewNewYear(year)) + day - 1;
  for (var i = 0; i < monthIdx; i++) {
    var days = _hebrewMonthDays(year, civilOrder[i]);
    if (days > 0) jdn += days;
  }
  return jdn;
}

// Hebrew month list for a given year — [{name, days, idx}] in civil order
function _hebrewMonthList(year) {
  var names = ['Tishrei','Marcheshvan','Kislev','Tevet','Shevat'];
  if (_hebrewLeapYear(year)) names.push('Adar I', 'Adar II');
  else names.push('Adar');
  names = names.concat(['Nisan','Iyar','Sivan','Tammuz','Av','Elul']);
  var codes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  var result = [];
  var ni = 0;
  for (var i = 0; i < codes.length; i++) {
    var d = _hebrewMonthDays(year, codes[i]);
    if (d > 0) {
      result.push({ name: names[ni], days: d, idx: i });
      ni++;
    }
  }
  return result;
}

// Islamic → JDN: arithmetic tabular formula
var _HIJRI_EPOCH = 1948439.5;
function _hijriToJDN(year, month, day) {
  return Math.floor((11 * year + 3) / 30) + 354 * year + 30 * month - Math.floor((month - 1) / 2) + day + 1948440 - 385;
}
function _hijriDaysInMonth(year, month) {
  // Odd months have 30 days, even months 29, except month 12 in leap years gets 30
  if (month % 2 === 1) return 30;
  if (month === 12 && (11 * year + 14) % 30 < 11) return 30;
  return 29;
}
function _jdnToHijri(jdn) {
  var l = jdn - 1948440 + 10632;
  var n = Math.floor((l - 1) / 10631);
  l = l - 10631 * n + 354;
  var j = Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) + Math.floor(l / 5670) * Math.floor((43 * l) / 15238);
  l = l - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29;
  var m = Math.floor((24 * l) / 709);
  var d = l - Math.floor((709 * m) / 24);
  var y = 30 * n + j - 30;
  return { year: y, month: m, day: d };
}

// Persian → Gregorian (reverse of 33-year subcycle)
function _persianToGregorian(jy, jm, jd) {
  var jy2 = jy + 1595;
  var days = -355668 + (365 * jy2) + Math.floor(jy2 / 33) * 8 + Math.floor((jy2 % 33 + 3) / 4) + jd;
  days += (jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30 + 186);
  var gy = 400 * Math.floor(days / 146097);
  days = days % 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days = days % 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days = days % 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  var gdm = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var isLeap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  gdm[2] = isLeap ? 29 : 28;
  var gm = 0;
  for (gm = 1; gm <= 12; gm++) {
    if (days < gdm[gm]) break;
    days -= gdm[gm];
  }
  return { year: gy, month: gm, day: days + 1 };
}
function _persianDaysInMonth(year, month) {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return _persianLeapYear(year) ? 30 : 29;
}
function _persianLeapYear(year) {
  var breaks = [1, 5, 9, 13, 17, 22, 26, 30];
  var r = ((year + 2346) % 2820 + 2820) % 2820;
  var m33 = r % 33;
  for (var i = 0; i < breaks.length; i++) {
    if (m33 === breaks[i]) return true;
  }
  return false;
}
function _persianToJDN(jy, jm, jd) {
  var g = _persianToGregorian(jy, jm, jd);
  return _gregorianToJDN(g.year, g.month, g.day);
}

// Julian → JDN
function _julianToJDN(year, month, day) {
  var a = Math.floor((14 - month) / 12);
  var y = year + 4800 - a;
  var m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
}
function _jdnToJulian(jdn) {
  var c = jdn + 32082;
  var d = Math.floor((4 * c + 3) / 1461);
  var e = c - Math.floor(1461 * d / 4);
  var m = Math.floor((5 * e + 2) / 153);
  return {
    year: d - 4800 + Math.floor(m / 10),
    month: m + 3 - 12 * Math.floor(m / 10),
    day: e - Math.floor((153 * m + 2) / 5) + 1
  };
}

// ── Calendar dispatchers — uniform interface for any calendar system ──

var _CAL_SYSTEMS = ['gregorian', 'hebrew', 'islamic', 'persian', 'julian', 'buddhist', 'chinese'];
var _CAL_LABELS = { gregorian: t('cal_gregorian'), hebrew: t('cal_hebrew'), islamic: t('cal_islamic'), persian: t('cal_persian'), julian: t('cal_julian'), buddhist: t('cal_buddhist'), chinese: t('cal_chinese') };

var _GREGORIAN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var _HIJRI_MONTHS = ['Muharram','Safar','Rabi\u2019 al-Awwal','Rabi\u2019 al-Thani',
  'Jumada al-Ula','Jumada al-Thani','Rajab','Sha\u2019ban',
  'Ramadan','Shawwal','Dhu al-Qi\u2019dah','Dhu al-Hijjah'];
var _PERSIAN_MONTHS = ['Farvardin','Ordibehesht','Khordad','Tir','Mordad','Shahrivar',
  'Mehr','Aban','Azar','Dey','Bahman','Esfand'];
var _JULIAN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Convert JDN → {year, month, day} in the given calendar system (month is 1-based)
function _jdnToCalendar(sys, jdn) {
  if (sys === 'gregorian') {
    var g = _jdnToGregorian(jdn);
    return { year: g.year, month: g.month, day: g.day };
  }
  if (sys === 'hebrew') {
    // Find Hebrew year
    var approx = Math.floor((jdn - _HEBREW_EPOCH) / 365.25) + 1;
    var hYear = approx;
    while (_hebrewNewYear(hYear) > jdn + 0.5) hYear--;
    while (_hebrewNewYear(hYear + 1) <= jdn + 0.5) hYear++;
    var months = _hebrewMonthList(hYear);
    var dayInYear = Math.round(jdn + 0.5 - _hebrewNewYear(hYear));
    var remaining = dayInYear;
    for (var i = 0; i < months.length; i++) {
      if (remaining < months[i].days) {
        return { year: hYear, month: i + 1, day: remaining + 1 };
      }
      remaining -= months[i].days;
    }
    return { year: hYear, month: months.length, day: remaining + 1 };
  }
  if (sys === 'islamic') {
    var h = _jdnToHijri(jdn);
    return { year: h.year, month: h.month, day: h.day };
  }
  if (sys === 'persian') {
    var g = _jdnToGregorian(jdn);
    var p = _gregorianToPersian(g.year, g.month, g.day);
    return { year: p.year, month: _PERSIAN_MONTHS.indexOf(p.month) + 1, day: p.day };
  }
  if (sys === 'julian') {
    var j = _jdnToJulian(jdn);
    return { year: j.year, month: j.month, day: j.day };
  }
  if (sys === 'buddhist') {
    var g = _jdnToGregorian(jdn);
    return { year: g.year + 543, month: g.month, day: g.day };
  }
  if (sys === 'chinese') {
    return _jdnToChineseLunar(jdn);
  }
  return { year: 0, month: 1, day: 1 };
}

// Chinese lunar calendar — approximate using synodic month cycle
// Reference new moon: Jan 6 2000 18:14 UTC = JDN 2451551.26
var _CHINESE_NEW_MOON_JDN = 2451551.26;
var _SYNODIC_MONTH = 29.53059;
var _CHINESE_MONTHS = ['Zh\u0113ngyue','Eryue','S\u0101nyue','S\u00ecyue','W\u01d4yue','Li\u00f9yue',
  'Q\u012byue','B\u0101yue','Ji\u01d4yue','Sh\u00edyue','Sh\u00edy\u012byue','L\u00e0yue'];

function _jdnToChineseLunar(jdn) {
  // Find which lunation we're in
  var lunationsSinceRef = (jdn - _CHINESE_NEW_MOON_JDN) / _SYNODIC_MONTH;
  var currentLunation = Math.floor(lunationsSinceRef);
  var dayInMonth = Math.floor(jdn - (_CHINESE_NEW_MOON_JDN + currentLunation * _SYNODIC_MONTH)) + 1;
  if (dayInMonth < 1) { currentLunation--; dayInMonth = Math.floor(jdn - (_CHINESE_NEW_MOON_JDN + currentLunation * _SYNODIC_MONTH)) + 1; }
  if (dayInMonth > 30) dayInMonth = 30;
  // Approximate Chinese year and month from Gregorian new year alignment
  // Chinese New Year falls between Jan 21 and Feb 20; month 1 starts at the new moon nearest
  var greg = _jdnToGregorian(jdn);
  var chineseYear = greg.year + 2697; // Huangdi era (approximate)
  // Month within the year: 1-12 based on lunation offset from Chinese New Year
  // Chinese New Year 2000 was Feb 5 = JDN 2451580. Lunation 0 is Jan 6.
  // So CNY 2000 starts at lunation ~1 from our reference.
  var cnyLunation2000 = 1; // lunation index of CNY 2000
  var yearsSince2000 = greg.year - 2000;
  // ~12.37 lunations per solar year; Chinese year has 12 or 13 months
  var cnyLunation = cnyLunation2000 + Math.round(yearsSince2000 * 12.3685);
  var monthInYear = currentLunation - cnyLunation + 1;
  if (monthInYear < 1) { monthInYear += 12; chineseYear--; }
  if (monthInYear > 12) { monthInYear -= 12; chineseYear++; }
  return { year: chineseYear, month: Math.max(1, Math.min(12, monthInYear)), day: dayInMonth };
}

// Get JDN for first day of a given month
function _calFirstDayJDN(sys, year, month) {
  if (sys === 'gregorian') return _gregorianToJDN(year, month, 1);
  if (sys === 'hebrew') {
    var months = _hebrewMonthList(year);
    var jdn = Math.floor(_hebrewNewYear(year));
    for (var i = 0; i < month - 1 && i < months.length; i++) {
      jdn += months[i].days;
    }
    return jdn;
  }
  if (sys === 'islamic') return _hijriToJDN(year, month, 1);
  if (sys === 'persian') return _persianToJDN(year, month, 1);
  if (sys === 'julian') return _julianToJDN(year, month, 1);
  if (sys === 'buddhist') return _gregorianToJDN(year - 543, month, 1);
  if (sys === 'chinese') {
    // Find JDN of first day of this Chinese month
    var yearsSince2000 = (year - 2697) - 2000;
    var cnyLunation = 1 + Math.round(yearsSince2000 * 12.3685);
    var lunation = cnyLunation + month - 1;
    return Math.round(_CHINESE_NEW_MOON_JDN + lunation * _SYNODIC_MONTH);
  }
  return 0;
}

// Get number of days in a given month
function _calDaysInMonth(sys, year, month) {
  if (sys === 'gregorian') {
    var daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
    return daysPerMonth[month - 1];
  }
  if (sys === 'hebrew') {
    var months = _hebrewMonthList(year);
    if (month >= 1 && month <= months.length) return months[month - 1].days;
    return 30;
  }
  if (sys === 'islamic') return _hijriDaysInMonth(year, month);
  if (sys === 'persian') return _persianDaysInMonth(year, month);
  if (sys === 'julian') {
    var daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2 && year % 4 === 0) return 29;
    return daysPerMonth[month - 1];
  }
  if (sys === 'buddhist') {
    var gYear = year - 543;
    var daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2 && ((gYear % 4 === 0 && gYear % 100 !== 0) || gYear % 400 === 0)) return 29;
    return daysPerMonth[month - 1];
  }
  if (sys === 'chinese') return 29 + (month % 2 === 1 ? 1 : 0); // alternating 30/29
  return 30;
}

// Get month name
function _calMonthName(sys, year, month) {
  if (sys === 'gregorian') return _GREGORIAN_MONTHS[month - 1] || '';
  if (sys === 'hebrew') {
    var months = _hebrewMonthList(year);
    if (month >= 1 && month <= months.length) return months[month - 1].name;
    return '';
  }
  if (sys === 'islamic') return _HIJRI_MONTHS[month - 1] || '';
  if (sys === 'persian') return _PERSIAN_MONTHS[month - 1] || '';
  if (sys === 'julian') return _JULIAN_MONTHS[month - 1] || '';
  if (sys === 'buddhist') return _GREGORIAN_MONTHS[month - 1] || '';
  if (sys === 'chinese') return _CHINESE_MONTHS[month - 1] || ('Month ' + month);
  return '';
}

// Get number of months in a year
function _calMonthCount(sys, year) {
  if (sys === 'hebrew') return _hebrewMonthList(year).length;
  if (sys === 'chinese') return 12; // simplified (ignoring leap months)
  return 12;
}

// ── Interactive Calendar Browser ──


// ── Deep Time — facts that transcend centuries ──

function _renderDeepTime(now) {
  var el = document.getElementById('almanac-deeptime');
  if (!el) return;
  var JD = 2440587.5 + now.getTime() / 86400000;
  var T = (JD - 2451545.0) / 36525; // Julian centuries from J2000

  // Axial tilt (obliquity of ecliptic)
  // IAU formula: ε = 23°26'21.448" - 46.8150"T - 0.00059"T² + 0.001813"T³
  var obliquityAS = 84381.448 - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T; // arcseconds
  var obliquityDeg = obliquityAS / 3600;
  var obliquityRate = -46.8150 / 3600; // degrees per century (negative = decreasing)
  // Milankovitch: tilt oscillates between 22.1° and 24.5° over ~41,000 years
  var tiltInCycle = ((obliquityDeg - 22.1) / (24.5 - 22.1) * 100).toFixed(0);

  // Precession — angle of celestial pole from Polaris
  // Polaris is at roughly RA 2h31m, Dec +89°15'50" (J2000)
  // Precession rate: ~50.29"/yr = 1.397°/century
  // Current pole-to-Polaris distance: ~0.7° in 2026, minimum ~0.45° around 2100
  var yearsSince2000 = (now.getFullYear() - 2000) + now.getMonth() / 12;
  // Simplified: distance decreases until ~2100 then increases
  // Rough model: d = 0.45 + 0.003 * |year - 2100|  (good enough for display)
  var polarisDist = (0.45 + 0.003 * Math.abs(now.getFullYear() - 2100)).toFixed(2);
  var precessionCyclePct = ((yearsSince2000 % 25772) / 25772 * 100).toFixed(1);

  // Day length change
  // Earth's rotation slows ~1.8ms per century due to tidal friction (Morrison & Stephenson 2004)
  // Base: 86400.000s in year 2000. Current excess grows at 1.8ms/century.
  var centuriesSince2000 = yearsSince2000 / 100;
  var excessMs = 1.8 * centuriesSince2000; // ms longer than year-2000 day
  var daySeconds = 86400 + excessMs / 1000;
  var dayH = Math.floor(daySeconds / 3600);
  var dayMin = Math.floor((daySeconds % 3600) / 60);
  var daySec = (daySeconds % 60).toFixed(3);

  // Julian Date — universal time reference that survives all calendar reforms
  var julianDate = JD.toFixed(2);

  // Earth's orbital eccentricity
  var earthEcc = (0.0167086 - 0.0000420 * T).toFixed(6);
  // Rate of change: compare eccentricity now vs 1 century ago
  var eccPrev = 0.0167086 - 0.0000420 * (T - 1);
  var eccTrend = parseFloat(earthEcc) < eccPrev ? 'decreasing' : 'increasing';

  // Human-scale season direction
  var tiltDir = obliquityAS < 84381.448 ? 'decreasing' : 'increasing';
  var seasonImpact = tiltDir === 'decreasing' ? 'Seasons are slowly becoming milder' : 'Seasons are slowly becoming more extreme';

  var html = '<div class="almanac-info-grid">';

  // Axial tilt — why it matters: it's what gives us seasons
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + obliquityDeg.toFixed(2) + '\u00b0</div>' +
    '<div class="almanac-info-lbl">Earth\u2019s Tilt</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    'This tilt is why seasons exist. It\u2019s currently ' + tiltDir + ', meaning: ' + seasonImpact.toLowerCase() + '. ' +
    'Cycles between 22.1\u00b0 and 24.5\u00b0 over 41,000 years (Milankovi\u0107 cycle). ' +
    'Currently ' + tiltInCycle + '% through the cycle.</div></div>';

  // North Star — why it matters: navigation for millennia
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + polarisDist + '\u00b0 from true north</div>' +
    '<div class="almanac-info-lbl">Polaris Accuracy</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    'Earth wobbles like a spinning top. Polaris happens to be near the axis right now, but it\u2019s drifting. ' +
    'Closest alignment ~2100 (0.45\u00b0), then it drifts away. In ~' + Math.round((14000 - now.getFullYear()) / 1000) + ',000 years, Vega will be the \u201cNorth Star.\u201d ' +
    'Full wobble cycle: 25,772 years.</div></div>';

  // Day getting longer — why it matters: the moon is stealing our spin
  // Show excess over 24h in microseconds for drama
  var excessUs = excessMs * 1000; // microseconds
  var totalExcessMs = (daySeconds - 86400) * 1000;
  var dayStr = totalExcessMs > 1 ? '+' + totalExcessMs.toFixed(1) + 'ms over 24h' :
               totalExcessMs > 0.01 ? '+' + (totalExcessMs * 1000).toFixed(0) + '\u00b5s over 24h' :
               '~24h (gaining fast)';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + dayStr + '</div>' +
    '<div class="almanac-info-lbl">Today Is Longer Than Yesterday</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    'The Moon\u2019s gravity creates tides that act like brakes on Earth\u2019s spin. Each century, days grow 1.8ms longer. ' +
    'Since the year 2000, days have stretched ' + excessMs.toFixed(1) + 'ms. Doesn\u2019t sound like much \u2014 but ' +
    '600 million years ago, a day was only 21 hours. The Moon drifts 3.8 cm farther each year, slowly releasing its grip.</div></div>';

  // Orbital eccentricity — why it matters: ice ages
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + earthEcc + '</div>' +
    '<div class="almanac-info-lbl">Orbit Shape</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    'How elliptical Earth\u2019s orbit is (0 = perfect circle, 1 = extremely stretched). ' +
    'Currently near-circular and ' + eccTrend + '. This affects how much solar energy Earth receives over a year. ' +
    'Combined with tilt and precession, these three cycles drive ice ages (Milankovi\u0107 theory).</div></div>';

  // Julian Date — why it matters: time that never resets
  html += '<div class="almanac-info-item"><div class="almanac-info-val">JD ' + julianDate + '</div>' +
    '<div class="almanac-info-lbl">Julian Date</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    'A continuous count of days since January 1, 4713 BC. Used by astronomers because it never resets, ' +
    'skips, or changes with calendar reforms. Every event in human history has exactly one Julian Date. ' +
    'Immune to leap seconds, timezone changes, and political calendars.</div></div>';

  // Galactic Year — Sun's orbit around Milky Way
  // Sun formed ~4.6 Gya; advance by elapsed time so this stays accurate forever
  var galacticPeriod = 225; // million years per orbit
  var sunAge = 4600 + (now.getFullYear() - 2000) / 1e6; // million years, advances with time
  var orbitsCompleted = Math.floor(sunAge / galacticPeriod);
  var currentOrbitPct = ((sunAge % galacticPeriod) / galacticPeriod * 100).toFixed(1);

  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + currentOrbitPct + '% through orbit #' + (orbitsCompleted + 1) + '</div>' +
    '<div class="almanac-info-lbl">Galactic Year</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    'The Sun orbits the Milky Way\u2019s center every ~225 million years at 828,000 km/h. ' +
    'In ' + (sunAge / 1000).toFixed(1) + ' billion years, we\u2019ve completed roughly ' + orbitsCompleted + ' orbits. ' +
    'Last time we were here, dinosaurs ruled the Earth.</div></div>';

  html += '</div>';
  el.innerHTML = html;
}

// ── Resize handler ──
var _almanacResizeTimer = null;
window.addEventListener('resize', function() {
  if (!_almanacOpen) return;
  clearTimeout(_almanacResizeTimer);
  _almanacResizeTimer = setTimeout(function() {
    _initOrrery();
    var stored = localStorage.getItem('zimi_almanac_location');
    var lat = 34, lon = -new Date().getTimezoneOffset() / 60 * 15;
    if (stored) { try { var loc = JSON.parse(stored); lat = loc.lat; lon = loc.lon; } catch(e) {} }
    _initSkyScene(new Date(), lat, lon);
  }, 200);
});
