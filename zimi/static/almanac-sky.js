// ── Almanac: sky scene + star chart ──
// Split out of almanac.js, which had grown past 5,900 lines.
// The animated horizon scene and the interactive planisphere, plus the bright-star catalogue they share.
// Loaded before almanac.js; all almanac scripts share one global scope.

var _almanacSkyRAF = null;

var _activeSkyLoop = null;  // reference to the closure-bound _skyLoop inside _initSkyScene

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
  _skyLabelText = sunPos.altitude > 0 ? t('alm_sun') + ' ' + altStr + '\u00b0' : t('alm_sun') + ' ' + t('alm_below_horizon') + ' (' + altStr + '\u00b0)';
  var moonPos0 = _moonPosition(now, lat, lon);
  var moonM0 = _moonPhase(now);
  if (moonPos0.altitude > -2) {
    _skyLabelText += ' \u00b7 ' + t('alm_moon') + ' ' + moonPos0.altitude.toFixed(1) + '\u00b0 (' + moonM0.illumination + '%)';
  } else {
    _skyLabelText += ' \u00b7 ' + t('alm_moon') + ' ' + t('alm_below_horizon');
  }

  var projStars = _projectStars(now, lat, lon, canvas.width, canvas.height);

  // Pre-compute moon data (constant for this sky scene — now is frozen)
  var moonData = { pos: moonPos0, phase: moonM0 };

  // Screen-reader description of the sky scene. Updates once per
  // render — the animation visuals are decorative; the values
  // they're derived from are what matter.
  var srEl = document.getElementById('almanac-sky-desc');
  if (srEl) {
    var when = now.toLocaleString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    // _tLookup falls back to English when a stale cached i18n file lacks
    // these keys — raw key names must never be spoken or shown (issue #25).
    var sunDesc = sunPos.altitude > 0
      ? _tLookup('alm_sun', 'Sun') + ' ' + sunPos.altitude.toFixed(0) + '° ' + _tLookup('alm_a11y_above_horizon', 'above the horizon')
      : _tLookup('alm_sun', 'Sun') + ' ' + _tLookup('alm_a11y_below_horizon', 'below the horizon');
    var moonDesc;
    if (moonPos0.altitude > -2) {
      moonDesc = _tLookup('alm_moon', 'Moon') + ' ' + moonM0.illumination + '% ' + _tLookup('alm_a11y_illuminated', 'illuminated') +
        ', ' + moonPos0.altitude.toFixed(0) + '° ' + _tLookup('alm_a11y_altitude', 'high');
    } else {
      moonDesc = _tLookup('alm_moon', 'Moon') + ' ' + _tLookup('alm_a11y_below_horizon', 'below the horizon');
    }
    var starsVisible = (projStars || []).filter(function(s) { return s.alt > 0; }).length;
    var starsDesc = starsVisible > 0
      ? starsVisible + ' ' + _tLookup('alm_a11y_stars_visible', 'stars visible')
      : _tLookup('alm_a11y_no_stars', 'No stars currently above the horizon');
    var skyFor = _tLookup('alm_a11y_sky_for', 'Almanac sky for {when}.').replace('{when}', when);
    srEl.textContent = skyFor + ' ' + sunDesc + '. ' + moonDesc + '. ' + starsDesc + '.';
  }

  function _skyLoop(ts) {
    var elapsed = (ts - _skyStartTime) / 1000;
    _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, elapsed, _skyLabelText, projStars, moonData);
    _almanacSkyRAF = requestAnimationFrame(_skyLoop);
  }
  _activeSkyLoop = _skyLoop;  // expose to _resumeAllRAF
  if (_almanacSkyRAF) cancelAnimationFrame(_almanacSkyRAF);
  _almanacSkyRAF = requestAnimationFrame(_skyLoop);
}

var _STARS = [
  // Orion (0-6): Betelgeuse, Rigel, Bellatrix, Mintaka, Alnilam, Alnitak, Saiph
  [5.92,7.41,.42],[5.24,-8.20,.13],[5.42,6.35,1.64],[5.53,-.30,2.23],[5.60,-1.20,1.69],[5.68,-1.94,1.77],[5.80,-9.67,2.06],
  // Ursa Major (7-13): Dubhe, Merak, Phecda, Megrez, Alioth, Mizar, Alkaid
  [11.06,61.75,1.79],[11.03,56.38,2.37],[11.90,53.69,2.44],[12.26,57.03,3.31],[12.90,55.96,1.77],[13.40,54.93,2.27],[13.79,49.31,1.86],
  // Cassiopeia (14-18): Caph, Schedar, Gamma, Ruchbah, Segin
  [.15,59.15,2.27],[.68,56.54,2.23],[.95,60.72,2.47],[1.43,60.24,2.68],[1.91,63.67,3.38],
  // Scorpius (19-25): Antares, Pi, Dschubba, Graffias, Epsilon, Shaula, Sargas
  [16.49,-26.43,1.09],[15.98,-26.11,2.89],[16.01,-22.62,2.32],[16.09,-19.81,2.62],[16.84,-34.29,2.29],[17.56,-37.10,1.63],[17.62,-43.00,1.87],
  // Leo (26-29): Regulus, Algieba, Zosma, Denebola
  [10.14,11.97,1.35],[10.33,19.84,2.01],[11.24,20.52,2.56],[11.82,14.57,2.14],
  // Cygnus (30-34): Deneb, Sadr, Delta, Gienah, Albireo
  [20.69,45.28,1.25],[20.37,40.26,2.23],[19.75,45.13,2.87],[20.77,33.97,2.48],[19.51,27.96,3.08],
  // Crux (35-38): Acrux, Mimosa, Gacrux, Delta
  [12.44,-63.10,.77],[12.80,-59.69,1.25],[12.52,-57.11,1.63],[12.25,-58.75,2.80],
  // Gemini (39-40): Castor, Pollux
  [7.58,31.89,1.58],[7.76,28.03,1.14],
  // Canis Major (41-44): Sirius, Mirzam, Adhara, Wezen
  [6.75,-16.72,-1.46],[6.38,-17.96,1.98],[6.98,-28.97,1.50],[7.14,-26.39,1.84],
  // Taurus (45-46): Aldebaran, Elnath
  [4.60,16.51,.85],[5.44,28.61,1.65],
  // Field stars (47-58): Canopus, Arcturus, Rigil Kent, Vega, Capella, Procyon,
  // Altair, Spica, Fomalhaut, Polaris, Hamal, Epsilon Leo
  [6.40,-52.70,-.72],[14.26,19.18,-.05],[14.66,-60.84,-.04],[18.62,38.78,.03],
  [5.28,46.00,.08],[7.66,5.22,.34],[19.85,8.87,.77],[13.42,-11.16,.98],
  [22.96,-29.62,1.16],[2.53,89.26,1.98],[2.12,23.46,2.00],[9.76,23.77,2.98]
];

// Constellation connecting lines — pairs of _STARS indices
var _CONST_LINES = [
  [0,2],[0,5],[2,3],[3,4],[4,5],[3,1],[5,6],           // Orion
  [7,8],[8,9],[9,10],[10,7],[10,11],[11,12],[12,13],    // Big Dipper
  [14,15],[15,16],[16,17],[17,18],                      // Cassiopeia
  [22,21],[21,20],[21,19],[19,23],[23,24],[24,25],      // Scorpius
  [26,27],[27,28],[28,29],[27,58],                      // Leo
  [30,31],[31,34],[32,31],[31,33],                      // Cygnus
  [35,37],[36,38],                                      // Crux
  [39,40],                                              // Gemini
  [41,42],[41,43],[43,44],                              // Canis Major
  [45,46]                                               // Taurus
];

// Red/orange giants and supergiants — warm color rendering
var _WARM_STARS = {0:1, 19:1, 40:1, 45:1, 48:1};

// Proper names for the brightest catalog stars, keyed by _STARS index. Used to
// label the star chart. Proper star names are effectively international, so
// they are not localized.
var _STAR_NAMES = {
  0: 'Betelgeuse', 1: 'Rigel', 7: 'Dubhe', 19: 'Antares', 25: 'Shaula',
  26: 'Regulus', 30: 'Deneb', 35: 'Acrux', 40: 'Pollux', 41: 'Sirius',
  45: 'Aldebaran', 47: 'Canopus', 48: 'Arcturus', 49: 'Rigil Kent.',
  50: 'Vega', 51: 'Capella', 52: 'Procyon', 53: 'Altair', 54: 'Spica',
  55: 'Fomalhaut', 56: 'Polaris'
};

// Project catalog stars to canvas coordinates for current time/location
function _projectStars(now, lat, lon, W, H) {
  var JD = _dateToJD(now.getTime());
  var GMST = (280.46061837 + 360.98564736629 * (JD - JD_J2000)) % 360;
  var LST = (GMST + lon) * DEG_TO_RAD;
  var latR = lat * DEG_TO_RAD;
  var result = [];
  for (var i = 0; i < _STARS.length; i++) {
    var s = _STARS[i];
    var ra = s[0] * 15 * DEG_TO_RAD;
    var dec = s[1] * DEG_TO_RAD;
    var HA = LST - ra;
    HA = ((HA % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    var sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(HA);
    var altitude = Math.asin(sinAlt) * 180 / Math.PI;
    if (altitude < -2) continue;
    var cosAz = (Math.sin(dec) - Math.sin(latR) * sinAlt) / (Math.cos(latR) * Math.cos(Math.asin(sinAlt)));
    cosAz = Math.max(-1, Math.min(1, cosAz));
    if (isNaN(cosAz)) cosAz = 0;
    var azimuth = Math.acos(cosAz) * 180 / Math.PI;
    if (HA > 0) azimuth = 360 - azimuth;
    var xFrac = (azimuth - 60) / 240;
    if (xFrac < -0.05 || xFrac > 1.05) continue;
    xFrac = Math.max(0, Math.min(1, xFrac));
    result.push({ x: xFrac * W, y: Math.max(0, Math.min(H * 0.66, H * 0.66 - (altitude / 90) * H * 0.56)), mag: s[2], idx: i });
  }
  return result;
}

function _drawConstellations(ctx, alpha, t, projStars) {
  var byIdx = {};
  for (var i = 0; i < projStars.length; i++) byIdx[projStars[i].idx] = projStars[i];
  ctx.save();
  ctx.strokeStyle = 'rgba(100,130,180,' + (alpha * 0.08).toFixed(3) + ')';
  ctx.lineWidth = 0.5;
  for (var i = 0; i < _CONST_LINES.length; i++) {
    var a = byIdx[_CONST_LINES[i][0]], b = byIdx[_CONST_LINES[i][1]];
    if (a && b) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, elapsed, labelText, projStars, moonData) {
  var t = elapsed || 0;  // 't' is animation time in seconds — not the i18n t() function
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

  // Stars — real catalog positions + dim background fill
  if (alt < 8) {
    var starOpacity = alt < -14 ? 1 : alt < -2 ? (-2 - alt) / 12 : Math.max(0, (8 - alt) / 20);

    // Dim background stars — seeded PRNG for faint ambiance
    var _seed = 42;
    function _srand() { _seed = (_seed * 16807 + 0) % 2147483647; return _seed / 2147483647; }
    for (var si = 0; si < 45; si++) {
      var sx = _srand() * W;
      var sy = _srand() * H * 0.55;
      _srand();
      var sr = 0.4 * dpr;
      var twinkleFreq = 0.8 + _srand() * 2.0;
      var twinklePhase = _srand() * 6.28;
      var twinkle = Math.sin(t * twinkleFreq + twinklePhase) * 0.15;
      var bsa = starOpacity * Math.max(0.03, 0.15 + twinkle);
      _srand();
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200,210,230,' + bsa.toFixed(3) + ')';
      ctx.fill();
    }

    // Catalog stars at astronomically correct positions
    if (projStars) {
      for (var si = 0; si < projStars.length; si++) {
        var ps = projStars[si];
        var sr = Math.max(0.5, (3.5 - ps.mag) * 0.5) * dpr;
        var twinkle = Math.sin(t * (1.2 + si * 0.37) + si * 2.1) * 0.12;
        var sa = starOpacity * Math.max(0.1, 0.4 + (3.5 - ps.mag) / 5 + twinkle);
        var warm = _WARM_STARS[ps.idx];
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, sr, 0, Math.PI * 2);
        ctx.fillStyle = warm
          ? 'rgba(255,210,160,' + sa.toFixed(3) + ')'
          : 'rgba(220,230,255,' + sa.toFixed(3) + ')';
        ctx.fill();
        // Subtle glow for very bright stars (mag < 0.5)
        if (ps.mag < 0.5 && starOpacity > 0.3) {
          var glowR = sr * 3;
          var ga = starOpacity * 0.06;
          var gg = ctx.createRadialGradient(ps.x, ps.y, sr, ps.x, ps.y, glowR);
          gg.addColorStop(0, warm ? 'rgba(255,210,160,' + ga.toFixed(3) + ')' : 'rgba(200,210,240,' + ga.toFixed(3) + ')');
          gg.addColorStop(1, 'transparent');
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.arc(ps.x, ps.y, glowR, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Constellation lines — visible when dark enough
      if (alt < -2) {
        _drawConstellations(ctx, starOpacity, t, projStars);
      }
    }

  }

  // Moon — visible day and night when above the horizon (pre-computed in _initSkyScene)
  var moonPos = moonData ? moonData.pos : _moonPosition(now, lat, lon);
  var moonAlt = moonPos.altitude;
  var moonAz = moonPos.azimuth;
  if (moonAlt > -2) {
    var m = moonData ? moonData.phase : _moonPhase(now);
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
      // Subtle centered atmospheric glow — no offset (scatter is omnidirectional)
      var glowAlpha = (m.illumination / 800).toFixed(3);
      var mgOuter = ctx.createRadialGradient(moonX, moonY, moonR, moonX, moonY, moonR * 2.5);
      mgOuter.addColorStop(0, 'rgba(220,215,200,' + glowAlpha + ')');
      mgOuter.addColorStop(1, 'transparent');
      ctx.fillStyle = mgOuter;
      ctx.beginPath(); ctx.arc(moonX, moonY, moonR * 2.5, 0, Math.PI * 2); ctx.fill();
    }
    // Rotate entire moon (texture + terminator) by parallactic angle
    var pAngleBody = (moonPos.parallactic || 0) * DEG_TO_RAD;
    ctx.save();
    ctx.globalAlpha = moonAlpha;
    ctx.translate(moonX, moonY);
    ctx.rotate(pAngleBody);
    ctx.beginPath(); ctx.arc(0, 0, moonR, 0, Math.PI * 2); ctx.clip();
    if (_moonTexLoaded) {
      ctx.drawImage(_moonTexImg, -moonR, -moonR, moonR * 2, moonR * 2);
      var brighten = isDaytime ? 0.25 + (m.illumination / 100) * 0.15 : 0.10 + (m.illumination / 100) * 0.30;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(220,210,195,' + brighten.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(0, 0, moonR, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      var moonGrad = ctx.createRadialGradient(-moonR * 0.25, -moonR * 0.2, 0, 0, 0, moonR);
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
      // Rotated by parallactic angle so terminator tilt matches real sky.
      var pAngle = (moonPos.parallactic || 0) * DEG_TO_RAD;
      ctx.save();
      ctx.globalAlpha = moonAlpha;
      // Rotate around moon center for parallactic tilt
      ctx.translate(moonX, moonY);
      ctx.rotate(pAngle);
      var shadowCol = isDaytime ? 'rgba(135,170,210,0.65)' : 'rgba(5,8,12,0.82)';
      var illumF = m.illumination / 100;
      var R = moonR;
      var waxing = m.phase <= 0.5;
      var termScaleX = Math.max(0.01, Math.abs(illumF * 2 - 1));
      var termCCW = (illumF < 0.5) === waxing;
      // Penumbral softening — blur the terminator edge
      var termBlur = Math.max(0.5, (1 - Math.abs(illumF * 2 - 1)) * 4);
      ctx.shadowColor = shadowCol;
      ctx.shadowBlur = termBlur * dpr;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, waxing);
      ctx.ellipse(0, 0, termScaleX * R, R, 0, Math.PI / 2, -Math.PI / 2, termCCW);
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

// Star chart — a circular planisphere of the sky above the chosen location at
// this moment. Zenith at the center, horizon at the rim; N is up and E is to
// the left, the way the sky reads when you hold a chart overhead. All positions
// come from the same offline RA/Dec → alt/az math as the rest of the almanac.
// Star-chart interactivity. Scrubbing re-runs the same offline alt/az math at
// the scrubbed instant (nothing is fetched), and every drawn body is recorded
// in _starChartBodies so a tap can identify it.
var _starChartBase = null;    // the focused moment (driven by the pinned scrubber)

var _starChartBodies = [];    // hit-test targets collected during the draw

var _starChartViewLat = null; // null = use the saved location; set by dragging

var _starChartViewLon = null;

var _starChartDragged = false; // suppresses the tap-to-identify after a drag

function _starChartResetLoc() {
  _starChartViewLat = null;
  _starChartViewLon = null;
  _drawStarChart(_starChartTime());
}

// Drag the chart to stand somewhere else on Earth. This is a preview only —
// it never overwrites the saved location the rest of the almanac uses.
function _initStarChartDrag(canvas) {
  var dragging = false, lastX = 0, lastY = 0, moved = 0;
  canvas.onpointerdown = function (e) {
    dragging = true; moved = 0;
    lastX = e.clientX; lastY = e.clientY;
    _starChartDragged = false;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
  };
  canvas.onpointermove = function (e) {
    if (!dragging) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved < 4) return; // still a tap
    _starChartDragged = true;
    var loc = _getLocation();
    var lat = (_starChartViewLat === null ? loc.lat : _starChartViewLat) + dy * 0.4;
    var lon = (_starChartViewLon === null ? loc.lon : _starChartViewLon) - dx * 0.6;
    // Carry over the poles rather than hitting a wall: walking north past the
    // North Pole is walking south down the opposite meridian. Longitude wraps
    // at the date line, so panning is continuous in both axes.
    if (lat > 90) { lat = 180 - lat; lon += 180; }
    else if (lat < -90) { lat = -180 - lat; lon += 180; }
    // A hair short of the pole itself, where azimuth is undefined.
    _starChartViewLat = Math.max(-89.9, Math.min(89.9, lat));
    _starChartViewLon = ((lon + 180) % 360 + 360) % 360 - 180;
    _drawStarChart(_starChartTime());
  };
  canvas.onpointerup = canvas.onpointercancel = function (e) {
    dragging = false;
    if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
  };
}

function _starChartTime() {
  return _starChartBase ? new Date(_starChartBase.getTime()) : new Date();
}

// Azimuth to an 8-point compass label, reusing the localized cardinals.
function _azCompass(az) {
  var N = t('alm_dir_n'), E = t('alm_dir_e'), S = t('alm_dir_s'), W = t('alm_dir_w');
  var pts = [N, N + E, E, S + E, S, S + W, W, N + W];
  return pts[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

function _starChartClick(ev) {
  if (_starChartDragged) { _starChartDragged = false; return; } // that was a pan
  var canvas = document.getElementById('almanac-starchart');
  var info = document.getElementById('alm-sc-info');
  if (!canvas || !info) return;
  var r = canvas.getBoundingClientRect();
  var x = ev.clientX - r.left, y = ev.clientY - r.top;
  var best = null, bestD = 18;
  for (var i = 0; i < _starChartBodies.length; i++) {
    var b = _starChartBodies[i];
    var d = Math.sqrt((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y));
    if (d < bestD) { bestD = d; best = b; }
  }
  info.innerHTML = best ? _almEsc(best.label) : '';
}

function _renderStarChart(baseNow) {
  _starChartBase = baseNow;
  _starChartViewLat = null;
  _starChartViewLon = null;
  var cv = document.getElementById('almanac-starchart');
  if (cv) _initStarChartDrag(cv);
  var info = document.getElementById('alm-sc-info');
  if (info) info.innerHTML = '';
  _drawStarChart(baseNow);
}

function _drawStarChart(now) {
  var canvas = document.getElementById('almanac-starchart');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var size = Math.min(wrap.clientWidth, 360);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  _starChartBodies = [];

  var loc = _getLocation();
  var panned = _starChartViewLat !== null;
  var lat = panned ? _starChartViewLat : loc.lat;
  var lon = panned ? _starChartViewLon : loc.lon;
  var cx = size / 2, cy = size / 2;
  var R = size / 2 - 16; // leave room for cardinal labels

  // Shared alt/az from apparent local sidereal time.
  var JD = _dateToJD(now.getTime());
  var GMST = (280.46061837 + 360.98564736629 * (JD - JD_J2000)) % 360;
  var LST = (GMST + lon) * DEG_TO_RAD;
  var latR = lat * DEG_TO_RAD;
  function altAz(raRad, decRad) {
    var HA = LST - raRad;
    HA = ((HA % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    var sinAlt = Math.sin(latR) * Math.sin(decRad) + Math.cos(latR) * Math.cos(decRad) * Math.cos(HA);
    var alt = Math.asin(sinAlt);
    var cosAz = (Math.sin(decRad) - Math.sin(latR) * sinAlt) / (Math.cos(latR) * Math.cos(alt));
    cosAz = Math.max(-1, Math.min(1, cosAz));
    if (isNaN(cosAz)) cosAz = 0;
    var az = Math.acos(cosAz);
    if (HA > 0) az = 2 * Math.PI - az;
    return { alt: alt * 180 / Math.PI, az: az * 180 / Math.PI };
  }
  // Azimuthal (zenith-centered) projection with N up, E left (looking up).
  function project(altDeg, azDeg) {
    var r = (90 - altDeg) / 90 * R;
    var a = azDeg * DEG_TO_RAD;
    return { x: cx - r * Math.sin(a), y: cy - r * Math.cos(a) };
  }

  var styles = getComputedStyle(document.documentElement);
  var amber = (styles.getPropertyValue('--amber') || '#e0b060').trim();

  // Label helper — anchor toward the center so names near the rim grow inward
  // and never clip off the disc.
  function drawLabel(txt, x, y, off) {
    var leftHalf = x <= cx;
    ctx.textAlign = leftHalf ? 'left' : 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(txt, x + (leftHalf ? off : -off), y - 3);
  }

  // Sky disc + horizon rim.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  var sky = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  sky.addColorStop(0, '#0a1228');
  sky.addColorStop(1, '#05060d');
  ctx.fillStyle = sky;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();
  ctx.strokeStyle = 'rgba(120,140,180,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  // Altitude ring at 30° and 60°.
  ctx.strokeStyle = 'rgba(120,140,180,0.12)';
  ctx.beginPath(); ctx.arc(cx, cy, R * 2 / 3, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R / 3, 0, Math.PI * 2); ctx.stroke();

  // Cardinal labels (N up, E left — planisphere convention).
  ctx.fillStyle = amber;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t('alm_dir_n'), cx, cy - R - 7);
  ctx.fillText(t('alm_dir_s'), cx, cy + R + 7);
  ctx.fillText(t('alm_dir_e'), cx - R - 7, cy);
  ctx.fillText(t('alm_dir_w'), cx + R + 7, cy);

  // Precompute star projections.
  var proj = {};
  for (var i = 0; i < _STARS.length; i++) {
    var aa = altAz(_STARS[i][0] * 15 * DEG_TO_RAD, _STARS[i][1] * DEG_TO_RAD);
    if (aa.alt < 0) continue;
    proj[i] = project(aa.alt, aa.az);
    proj[i].alt = aa.alt; proj[i].az = aa.az;
  }
  // Constellation lines (both endpoints up).
  ctx.strokeStyle = 'rgba(120,150,210,0.28)';
  ctx.lineWidth = 0.8;
  for (var c = 0; c < _CONST_LINES.length; c++) {
    var a = proj[_CONST_LINES[c][0]], b = proj[_CONST_LINES[c][1]];
    if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  }
  // Stars — radius and brightness by magnitude.
  var starCount = 0;
  for (var i = 0; i < _STARS.length; i++) {
    var p = proj[i]; if (!p) continue;
    starCount++;
    var mag = _STARS[i][2];
    var rad = Math.max(0.8, 2.6 - mag * 0.42);
    ctx.fillStyle = _WARM_STARS[i] ? '#ffd0a0' : '#eef2ff';
    ctx.globalAlpha = Math.max(0.5, 1 - mag * 0.13);
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    if (_STAR_NAMES[i] && mag < 1.6) {
      ctx.fillStyle = 'rgba(200,210,235,0.7)';
      ctx.font = '9px system-ui, sans-serif';
      drawLabel(_STAR_NAMES[i], p.x, p.y, rad + 2);
    }
    _starChartBodies.push({
      x: p.x, y: p.y,
      label: (_STAR_NAMES[i] || t('alm_star')) + ' \u00b7 ' + p.alt.toFixed(0) + '\u00b0 ' +
             _azCompass(p.az) + ' \u00b7 mag ' + mag.toFixed(1)
    });
  }

  // Planets on the ecliptic (latitude ~0, as elsewhere in the almanac).
  var T = _jdToJulianCentury(JD);
  var earth = _planetPosition('Earth', T);
  var eps = 23.44 * DEG_TO_RAD;
  var planetsUp = [];
  for (var pi = 0; pi < _VISIBLE_PLANETS.length; pi++) {
    var nm = _VISIBLE_PLANETS[pi];
    var pos = _planetPosition(nm, T);
    var geoLon = Math.atan2(pos.y - earth.y, pos.x - earth.x); // ecliptic longitude, lat≈0
    var raP = Math.atan2(Math.sin(geoLon) * Math.cos(eps), Math.cos(geoLon));
    var decP = Math.asin(Math.sin(eps) * Math.sin(geoLon));
    var aa = altAz(raP, decP);
    if (aa.alt < 0) continue;
    var pp = project(aa.alt, aa.az);
    var col = _PLANETS[nm] ? _PLANETS[nm].color : amber;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(pp.x, pp.y, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
    ctx.font = 'bold 9px system-ui, sans-serif';
    drawLabel(_tp(nm), pp.x, pp.y, 5);
    _starChartBodies.push({
      x: pp.x, y: pp.y,
      label: _tp(nm) + ' \u00b7 ' + aa.alt.toFixed(0) + '\u00b0 ' + _azCompass(aa.az)
    });
    planetsUp.push(_tp(nm));
  }

  // The Moon.
  var mp = _moonPosition(now, lat, lon);
  var moonUp = mp.altitude > 0;
  if (moonUp) {
    var mpp = project(mp.altitude, mp.azimuth);
    ctx.fillStyle = '#f4f4e8';
    ctx.beginPath(); ctx.arc(mpp.x, mpp.y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 0.5; ctx.stroke();
    _starChartBodies.push({
      x: mpp.x, y: mpp.y,
      label: t('alm_the_moon') + ' \u00b7 ' + mp.altitude.toFixed(0) + '\u00b0 ' +
             _azCompass(mp.azimuth) + ' \u00b7 ' + _moonPhase(now).illumination + '%'
    });
  }

  var cap = document.getElementById('almanac-starchart-caption');
  if (cap) {
    var coords = Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' +
      Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
    var where = (!panned && loc.name) ? _almEsc(loc.name) : coords;
    cap.innerHTML = '<div class="alm-starchart-now">' + t('alm_stars_above') + ' ' + where +
      (panned ? ' <button class="alm-sc-reset" onclick="_starChartResetLoc()">' + _almEsc(t('alm_my_location')) + '</button>' : '') + '</div>' +
      '<div class="alm-starchart-desc">' + starCount + ' ' + t('alm_stars_up') +
      (planetsUp.length ? ' · ' + planetsUp.join(', ') : '') +
      (moonUp ? ' · ' + t('alm_the_moon') : '') + '</div>';
  }
}
