// ── Almanac: sky scene + star chart ──
// Split out of almanac.js, which had grown past 5,900 lines.
// The animated horizon scene and the interactive planisphere, plus the bright-star catalogue they share.
// Loaded before almanac.js; all almanac scripts share one global scope.

var _almanacSkyRAF = null;

var _activeSkyLoop = null;  // reference to the closure-bound _skyLoop inside _initSkyScene

var _skyStartTime = 0;

// Live scene state the RAF loop reads each frame. Split out of the old closure
// so the time scrubber can swap in a new instant (sun/moon/stars for a scrubbed
// datetime) without tearing down the loop or reallocating the canvas -- only
// these few astronomical values are recomputed per scrub frame. See
// _skySetInstant: that is the whole per-frame cost of dragging through time.
var _skyState = null;

// Moon glide — when the focus time jumps (scrub, wheel/key step, "Go", Back to
// Now), the moon eases to its new sky position instead of snapping there.
// Duration is fixed regardless of jump size, so scrubbing years ahead still
// takes MOON_TWEEN_MS -- a graceful sweep rather than a blur -- and small steps
// (one wheel notch, one arrow key) get the same easing so mixed inputs feel
// consistent.
var MOON_TWEEN_MS = 500;

function _moonEaseOut(p) { return 1 - Math.pow(1 - p, 3); }

// Shortest signed delta (degrees) from `from` to `to`, wrapping at 360 -- so
// azimuth/parallactic tweening sweeps the short way around the 0/360 seam
// instead of the long way when a jump straddles it.
function _angleDelta(from, to) { return ((to - from) % 360 + 540) % 360 - 180; }

// Sample the moon's tweened state at time `ts` (a performance.now()/rAF
// timestamp). Position (altitude/azimuth/parallactic) eases geometrically;
// phase is sampled from REAL astronomy at the interpolated instant via
// _moonAnimPhaseAt, so the lit fraction sweeps its true path across the jump
// rather than snapping. The re-shade this costs is bounded by
// _moonSpriteCanvas's cache (illumination rounded to 1%): at the sky moon's
// ~14 px radius a full sweep is a few dozen tiny sprites, generated once.
function _skyMoonAt(s, ts) {
  var anim = s.moonAnim;
  if (!anim) return s.moonData;
  var p = (ts - anim.start) / MOON_TWEEN_MS;
  if (p >= 1) { s.moonAnim = null; return s.moonData; }
  var e = _moonEaseOut(Math.max(0, p));
  var fp = anim.from.pos, tp = anim.to.pos;
  return {
    pos: {
      altitude: fp.altitude + (tp.altitude - fp.altitude) * e,
      azimuth: fp.azimuth + _angleDelta(fp.azimuth, tp.azimuth) * e,
      parallactic: fp.parallactic + _angleDelta(fp.parallactic, tp.parallactic) * e
    },
    phase: _moonAnimPhaseAt(anim.fromTime, anim.toTime, e)
  };
}

// (Re)target the moon's glide toward `toMoonData` (the focus instant `toTime`),
// sampling the CURRENT interpolated position as the new start. A rapid sequence
// of scrub frames or key/wheel steps thus glides continuously toward whatever
// the latest target is, instead of snapping back and re-launching each time.
// The phase sweep restarts from the previous focus time so it, too, chains.
function _skyMoonRetarget(s, toMoonData, ts, fromTime, toTime) {
  s.moonAnim = { from: _skyMoonAt(s, ts), to: toMoonData, start: ts, fromTime: fromTime, toTime: toTime };
  s.moonData = toMoonData;
  s.nowTime = toTime;
}

// Recompute the frozen celestial values (sun, moon, stars, horizon label) for
// an instant. The RAF loop's `elapsed` still drives the decorative twinkle and
// waves; everything astronomical comes from here. Cheap: a handful of trig
// calls plus one pass over the bright-star catalogue.
function _skyFrame(now, lat, lon, cw, ch) {
  var sunPos = _sunPosition(now, lat, lon);
  var moonPos0 = _moonPosition(now, lat, lon);
  var moonM0 = _moonPhase(now);
  var projStars = _projectStars(now, lat, lon, cw, ch);
  var projField = _projectFieldStars(now, lat, lon, cw, ch);
  var altStr = sunPos.altitude.toFixed(1);
  var labelText = sunPos.altitude > 0
    ? t('alm_sun') + ' ' + altStr + '°'
    : t('alm_sun') + ' ' + t('alm_below_horizon') + ' (' + altStr + '°)';
  if (moonPos0.altitude > -2) {
    labelText += ' · ' + t('alm_moon') + ' ' + moonPos0.altitude.toFixed(1) + '° (' + moonM0.illumination + '%)';
  } else {
    labelText += ' · ' + t('alm_moon') + ' ' + t('alm_below_horizon');
  }
  return { sunPos: sunPos, moonData: { pos: moonPos0, phase: moonM0 }, projStars: projStars, projField: projField, labelText: labelText };
}

// `animateMoon` -- true only for a repaint that reinitializes this same canvas
// for a NEW focus instant (scrub settle, wheel/key-step settle, "Go", Back to
// Now). Live loads/resizes (no focus change, or a canvas that didn't exist a
// moment ago) omit it and get the moon's real position immediately -- there is
// nothing to glide from, and per-minute live drift must look exactly as it did
// before this feature existed.
function _initSkyScene(now, lat, lon, animateMoon) {
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

  var f = _skyFrame(now, lat, lon, canvas.width, canvas.height);
  var ts = performance.now();
  // Carry any in-flight glide across the reinit boundary -- read from the
  // OLD state (which _skySetInstant may have already been easing) before it's
  // replaced, so a scrub's settle continues the same motion rather than
  // reading as a second, smaller snap right after the drag's own motion.
  var priorMoon = (animateMoon && _skyState) ? _skyMoonAt(_skyState, ts) : null;
  var priorTime = (_skyState && _skyState.nowTime != null) ? _skyState.nowTime : now.getTime();
  _skyStartTime = ts;
  _skyState = {
    canvas: canvas, dpr: dpr, now: now, nowTime: now.getTime(), lat: lat, lon: lon,
    sunPos: f.sunPos, moonData: f.moonData, projStars: f.projStars, projField: f.projField, labelText: f.labelText,
    moonAnim: null
  };
  if (priorMoon) _skyState.moonAnim = { from: priorMoon, to: f.moonData, start: ts, fromTime: priorTime, toTime: now.getTime() };
  _skyUpdateDesc(_skyState);

  function _skyLoop(ts) {
    var s = _skyState;
    if (!s) return;
    var elapsed = (ts - _skyStartTime) / 1000;
    var moonNow = _skyMoonAt(s, ts);
    _drawSkyScene(s.canvas, s.dpr, s.sunPos, s.now, s.lat, s.lon, elapsed, s.labelText, s.projStars, moonNow, s.projField);
    // Drive the hero moon's time-travel sweep from this same loop (no second
    // rAF). Defined in almanac.js, which loads after this file.
    if (typeof _heroMoonTick === 'function') _heroMoonTick(ts);
    _almanacSkyRAF = requestAnimationFrame(_skyLoop);
  }
  _activeSkyLoop = _skyLoop;  // expose to _resumeAllRAF
  if (_almanacSkyRAF) cancelAnimationFrame(_almanacSkyRAF);
  _almanacSkyRAF = requestAnimationFrame(_skyLoop);
}

// Repaint the sky for a scrubbed instant WITHOUT restarting the loop or
// resizing the canvas -- the running RAF picks up the new state on its next
// frame. This is the efficiency contract of the time scrubber: per drag frame
// we recompute only the sky's astronomical values (via _skyFrame); the heavy
// almanac panels wait for release.
function _skySetInstant(now) {
  var s = _skyState;
  if (!s) return;
  var f = _skyFrame(now, s.lat, s.lon, s.canvas.width, s.canvas.height);
  var fromTime = (s.nowTime != null) ? s.nowTime : now.getTime();
  s.now = now;
  s.sunPos = f.sunPos;
  _skyMoonRetarget(s, f.moonData, performance.now(), fromTime, now.getTime());
  s.projStars = f.projStars;
  s.projField = f.projField;
  s.labelText = f.labelText;
}

// Screen-reader description of the sky scene. Updates on (re)init and on scrub
// release -- the animation visuals are decorative; the values they're derived
// from are what matter. _tLookup falls back to English when a stale cached
// i18n file lacks these keys -- raw key names must never be spoken (issue #25).
function _skyUpdateDesc(s) {
  var srEl = document.getElementById('almanac-sky-desc');
  if (!srEl) return;
  var sunPos = s.sunPos, moonPos0 = s.moonData.pos, moonM0 = s.moonData.phase, projStars = s.projStars;
  var when = s.now.toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
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
  var starsVisible = (projStars || []).filter(function(st) { return st.alt > 0; }).length;
  var starsDesc = starsVisible > 0
    ? starsVisible + ' ' + _tLookup('alm_a11y_stars_visible', 'stars visible')
    : _tLookup('alm_a11y_no_stars', 'No stars currently above the horizon');
  var skyFor = _tLookup('alm_a11y_sky_for', 'Almanac sky for {when}.').replace('{when}', when);
  srEl.textContent = skyFor + ' ' + sunDesc + '. ' + moonDesc + '. ' + starsDesc + '.';
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

// Real background field — the naked-eye sky beyond the named catalog above.
// Bright-star catalogue (HYG v41), every star to magnitude 4.0, culled of the
// ~58 already in _STARS; each row is [RA hours, Dec degrees, magnitude, colour
// index]. Projected by the SAME horizon geometry as the named stars
// (_projectFieldStars) so the whole scene is astronomically real and drifts
// with time/location — this REPLACES the old procedural _ensureSkyBgStars
// filler, which had no real position and did not move with the sky. Colour
// index tints each star warm (high B–V) to blue-white (low B–V).
var _SKY_FIELD_STARS = [
  [1.63,-57.24,0.45,-0.16],[14.06,-60.37,0.61,-0.23],[9.22,-69.72,1.67,0.07],[22.14,-46.96,1.73,-0.07],
  [8.16,-47.34,1.75,-0.14],[3.41,49.86,1.79,0.48],[18.40,-34.38,1.79,-0.03],[8.38,-59.51,1.86,1.20],
  [5.99,44.95,1.90,0.08],[16.81,-69.03,1.91,1.45],[6.63,16.40,1.93,0.00],[8.75,-54.71,1.93,0.04],
  [20.43,-56.74,1.94,-0.12],[9.46,-8.66,1.99,1.44],[0.73,-17.99,2.04,1.02],[18.92,-26.30,2.05,-0.13],
  [14.11,-36.37,2.06,1.01],[0.14,29.09,2.07,-0.04],[1.16,35.62,2.07,1.58],[14.85,74.16,2.07,1.47],
  [22.71,-46.88,2.07,1.61],[17.58,12.56,2.08,0.15],[3.14,40.96,2.09,-0.00],[2.06,42.33,2.10,1.37],
  [12.69,-48.96,2.20,-0.02],[8.06,-40.00,2.21,-0.27],[9.28,-59.28,2.21,0.19],[15.58,26.71,2.22,0.03],
  [9.13,-43.43,2.23,1.67],[17.94,51.49,2.24,1.52],[13.66,-53.47,2.29,-0.17],[14.70,-47.39,2.30,-0.15],
  [14.59,-42.16,2.33,-0.16],[14.75,27.07,2.35,0.97],[21.74,9.88,2.38,1.52],[17.71,-39.03,2.39,-0.17],
  [0.44,-42.31,2.40,1.08],[17.17,-15.72,2.43,0.06],[23.06,28.08,2.44,1.66],[7.40,-29.30,2.45,-0.08],
  [21.31,62.59,2.45,0.26],[9.37,-55.01,2.47,-0.14],[23.08,15.21,2.49,-0.00],[3.04,4.09,2.54,1.63],
  [16.62,-10.57,2.54,0.04],[13.93,-47.29,2.55,-0.18],[5.55,-17.82,2.58,0.21],[12.14,-50.72,2.58,-0.13],
  [12.26,-17.54,2.58,-0.11],[19.04,-29.88,2.60,0.06],[15.28,-9.38,2.61,-0.07],[15.74,6.43,2.63,1.17],
  [1.91,20.81,2.64,0.17],[5.66,-34.07,2.65,-0.12],[6.00,37.21,2.65,-0.08],[12.57,-23.40,2.65,0.89],
  [13.91,18.40,2.68,0.58],[14.98,-43.13,2.68,-0.18],[4.95,33.17,2.69,1.49],[10.78,-49.42,2.69,0.90],
  [12.62,-69.14,2.69,-0.18],[17.51,-37.30,2.70,-0.18],[7.29,-37.10,2.71,1.62],[18.35,-29.83,2.72,1.38],
  [19.77,10.61,2.72,1.51],[16.24,-3.69,2.73,1.58],[16.40,61.51,2.73,0.91],[10.72,-64.39,2.74,-0.22],
  [12.69,-1.45,2.74,0.37],[5.59,-5.91,2.75,-0.21],[13.34,-36.71,2.75,0.07],[14.85,-16.04,2.75,0.15],
  [17.72,4.57,2.76,1.17],[5.13,-5.09,2.78,0.16],[16.50,21.49,2.78,0.95],[17.24,14.39,2.78,1.16],
  [17.51,52.30,2.79,0.95],[15.59,-41.17,2.80,-0.22],[5.47,-20.76,2.81,0.81],[16.69,31.60,2.81,0.65],
  [0.43,-77.25,2.82,0.62],[16.60,-28.22,2.82,-0.21],[18.47,-25.42,2.82,1.02],[0.22,15.18,2.83,-0.19],
  [8.13,-24.30,2.83,0.46],[15.92,-63.43,2.83,0.32],[3.90,31.88,2.84,0.27],[17.42,-55.53,2.84,1.48],
  [17.53,-49.88,2.84,-0.14],[3.79,24.11,2.85,-0.09],[13.04,10.96,2.85,0.93],[21.78,-16.13,2.85,0.18],
  [1.98,-61.57,2.86,0.29],[6.38,22.51,2.87,1.62],[15.32,-68.68,2.87,0.01],[22.31,-60.26,2.87,1.39],
  [2.97,-40.30,2.88,0.13],[19.16,-21.02,2.88,0.38],[7.45,8.29,2.89,-0.10],[12.93,38.32,2.89,-0.12],
  [3.96,40.01,2.90,-0.20],[16.35,-25.59,2.90,0.30],[21.53,-5.57,2.90,0.83],[3.08,53.51,2.91,0.72],
  [9.79,-65.07,2.92,0.27],[22.72,30.22,2.93,0.85],[6.83,-50.61,2.94,1.21],[12.50,-16.52,2.94,-0.01],
  [22.10,-0.32,2.95,0.97],[3.97,-13.51,2.97,1.59],[5.63,21.14,2.97,-0.15],[18.10,-30.42,2.98,0.98],
  [13.32,-23.17,2.99,0.92],[17.79,-40.13,2.99,0.51],[19.09,13.86,2.99,0.01],[2.16,34.99,3.00,0.14],
  [11.16,44.50,3.00,1.14],[15.35,71.83,3.00,0.06],[16.86,-38.05,3.00,-0.20],[21.90,-37.36,3.00,-0.08],
  [3.72,47.79,3.01,-0.12],[6.34,-30.06,3.02,-0.16],[7.05,-23.83,3.02,-0.08],[12.17,-22.62,3.02,1.33],
  [5.03,43.82,3.03,0.54],[12.77,-68.11,3.04,-0.18],[14.53,38.31,3.04,0.19],[20.35,-14.78,3.05,0.79],
  [6.73,25.13,3.06,1.38],[10.37,41.50,3.06,1.60],[19.21,67.66,3.07,0.99],[18.29,-36.76,3.10,1.58],
  [8.92,5.95,3.11,0.98],[10.83,-16.19,3.11,1.23],[11.60,-63.02,3.11,-0.04],[20.63,-47.29,3.11,1.00],
  [5.85,-35.77,3.12,1.15],[8.99,48.04,3.12,0.22],[16.98,-55.99,3.12,1.55],[17.25,24.84,3.12,0.08],
  [14.99,-42.10,3.13,-0.21],[9.35,34.39,3.14,1.55],[9.52,-57.03,3.16,1.54],[17.25,36.81,3.16,1.44],
  [6.63,-43.20,3.17,-0.10],[9.55,51.68,3.17,0.47],[17.15,65.71,3.17,-0.12],[18.76,-26.99,3.17,-0.11],
  [5.11,41.23,3.18,-0.15],[14.71,-64.98,3.18,0.26],[4.83,6.96,3.19,0.48],[5.09,-22.37,3.19,1.46],
  [16.96,9.38,3.19,1.16],[17.83,-37.04,3.19,1.19],[21.22,30.23,3.21,0.99],[23.66,77.63,3.21,1.03],
  [15.36,-40.65,3.22,-0.23],[16.31,-4.69,3.23,0.97],[18.36,-2.90,3.23,0.94],[21.48,70.56,3.23,-0.20],
  [6.80,-61.94,3.24,0.23],[20.19,-0.82,3.24,-0.07],[7.49,-43.30,3.25,1.51],[14.11,-26.68,3.25,1.09],
  [15.07,-25.28,3.25,1.67],[18.98,32.69,3.25,-0.05],[3.79,-74.24,3.26,1.59],[0.66,30.86,3.27,1.27],
  [17.37,-25.00,3.27,-0.19],[22.91,-15.82,3.27,0.07],[5.22,-16.21,3.29,-0.11],[10.23,-70.04,3.29,-0.07],
  [15.42,58.97,3.29,1.17],[4.57,-55.04,3.30,-0.08],[10.53,-61.69,3.30,-0.09],[6.25,22.51,3.31,1.60],
  [17.42,-56.38,3.31,-0.15],[1.10,-46.72,3.32,0.89],[3.09,38.84,3.32,1.53],[17.20,-43.24,3.32,0.44],
  [17.98,-9.77,3.32,0.99],[19.12,-27.67,3.32,1.17],[4.24,-62.47,3.33,0.92],[11.24,15.43,3.33,-0.00],
  [7.82,-24.86,3.34,1.22],[5.41,-2.40,3.35,-0.24],[6.75,12.90,3.35,0.44],[8.50,60.72,3.35,0.86],
  [19.42,3.11,3.36,0.32],[15.38,-44.69,3.37,-0.19],[8.78,6.42,3.38,0.69],[13.58,-0.60,3.38,0.11],
  [5.59,9.93,3.39,-0.16],[10.28,-61.33,3.39,1.54],[12.93,3.40,3.39,1.57],[22.18,58.20,3.39,1.56],
  [4.48,15.87,3.40,0.18],[17.17,-15.73,3.40,0.60],[1.47,-43.32,3.41,1.54],[4.01,12.49,3.41,-0.10],
  [13.83,-41.69,3.41,-0.23],[15.20,-52.10,3.41,0.92],[20.75,61.84,3.41,0.91],[22.69,10.83,3.41,-0.09],
  [1.88,29.58,3.42,0.49],[16.00,-38.40,3.42,-0.21],[17.77,27.72,3.42,0.75],[20.75,-66.20,3.42,0.16],
  [9.18,-58.97,3.43,-0.19],[10.28,23.42,3.43,0.31],[19.10,-4.88,3.43,-0.10],[10.28,42.91,3.45,0.03],
  [0.82,57.82,3.46,0.59],[1.14,-10.18,3.46,1.16],[7.95,-52.98,3.46,-0.18],[15.26,33.31,3.46,0.96],
  [2.72,3.24,3.47,0.09],[13.83,-42.47,3.47,-0.17],[10.12,16.76,3.48,-0.03],[16.71,38.92,3.48,0.92],
  [1.73,-15.94,3.49,0.73],[7.03,-27.93,3.49,1.73],[11.31,33.09,3.49,1.40],[15.03,40.39,3.49,0.96],
  [18.45,-45.97,3.49,-0.18],[22.81,-51.32,3.49,0.08],[6.83,-32.51,3.50,-0.12],[7.34,21.98,3.50,0.37],
  [22.83,66.20,3.50,1.05],[19.98,19.49,3.51,1.57],[22.83,24.60,3.51,0.93],[3.72,-9.76,3.52,0.92],
  [9.69,9.89,3.52,0.52],[9.95,-54.57,3.52,-0.07],[18.83,33.36,3.52,0.00],[18.96,-21.11,3.52,1.15],
  [22.17,6.20,3.52,0.09],[12.69,-1.45,3.52,0.60],[4.48,19.18,3.53,1.01],[8.28,9.19,3.53,1.48],
  [11.55,-31.86,3.54,0.95],[15.83,-3.43,3.54,-0.04],[17.63,-15.40,3.54,0.26],[4.30,-33.80,3.55,-0.11],
  [5.78,-14.82,3.55,0.10],[14.32,-46.06,3.55,-0.18],[18.35,72.73,3.55,0.49],[20.15,-66.18,3.55,0.75],
  [0.32,-8.82,3.56,1.21],[2.28,-51.51,3.56,-0.12],[11.32,-14.78,3.56,1.11],[16.87,-38.02,3.56,-0.21],
  [7.74,24.40,3.57,0.93],[9.06,47.16,3.57,0.01],[14.53,30.37,3.57,1.30],[15.36,-36.26,3.57,1.53],
  [7.30,16.54,3.58,0.11],[20.30,-12.54,3.58,0.88],[1.63,48.63,3.59,1.27],[5.29,-6.84,3.59,-0.12],
  [5.74,-22.45,3.59,0.48],[11.84,1.76,3.59,0.52],[12.36,-60.40,3.59,1.39],[1.40,-8.18,3.60,1.06],
  [6.88,33.96,3.60,0.10],[8.67,-52.92,3.60,-0.17],[9.51,-40.47,3.60,0.37],[15.62,-28.14,3.60,1.36],
  [17.52,-60.68,3.60,-0.10],[2.83,27.26,3.61,-0.10],[3.41,9.03,3.61,0.89],[10.18,-12.35,3.61,1.01],
  [13.04,-71.55,3.61,1.19],[17.76,-64.72,3.61,1.16],[1.52,15.35,3.62,0.97],[3.82,24.05,3.62,-0.07],
  [7.75,-37.97,3.62,1.71],[16.91,-42.36,3.62,1.39],[23.03,42.33,3.62,-0.10],[11.76,-66.73,3.63,0.16],
  [20.63,14.60,3.64,0.42],[4.33,15.63,3.65,0.98],[9.53,63.06,3.65,0.36],[15.77,15.42,3.65,0.07],
  [18.11,-50.09,3.65,-0.10],[22.48,-0.02,3.65,0.41],[15.46,29.11,3.66,0.32],[15.64,-29.78,3.66,-0.18],
  [14.07,64.38,3.67,-0.05],[20.91,-58.45,3.67,1.25],[4.85,5.61,3.68,-0.16],[8.73,-33.19,3.68,-0.18],
  [19.79,18.53,3.68,1.31],[23.16,-21.17,3.68,1.20],[0.62,53.90,3.69,-0.20],[1.93,-51.61,3.69,0.84],
  [5.04,41.08,3.69,1.15],[9.75,-62.51,3.69,1.01],[11.77,47.78,3.69,1.18],[21.67,-16.66,3.69,0.32],
  [3.33,-21.76,3.70,1.61],[17.96,29.25,3.70,0.94],[23.29,3.28,3.70,0.92],[4.90,2.44,3.71,-0.18],
  [5.94,-14.17,3.71,0.34],[7.87,-40.58,3.71,1.01],[15.85,4.48,3.71,0.15],[18.12,9.56,3.71,0.16],
  [19.92,6.41,3.71,0.85],[3.55,-9.46,3.72,0.88],[3.75,24.11,3.72,-0.10],[5.99,54.28,3.72,1.01],
  [21.08,43.93,3.72,1.61],[3.45,9.73,3.73,-0.08],[14.77,1.89,3.73,-0.01],[17.89,56.87,3.73,1.18],
  [21.69,-77.39,3.73,1.01],[22.88,-7.58,3.73,1.63],[1.86,-10.34,3.74,1.14],[16.37,19.15,3.74,0.30],
  [21.25,38.05,3.74,0.39],[9.07,-47.10,3.75,1.17],[17.80,2.71,3.75,0.04],[5.56,-62.49,3.76,0.64],
  [5.86,-20.88,3.76,0.98],[6.48,-7.03,3.76,-0.11],[19.08,-21.74,3.76,1.01],[19.50,51.73,3.76,0.15],
  [22.52,50.28,3.76,0.03],[2.84,55.90,3.77,1.69],[3.75,42.58,3.77,0.42],[4.38,17.54,3.77,0.98],
  [5.65,-2.60,3.77,-0.19],[8.43,-66.14,3.77,1.13],[8.68,-46.65,3.77,0.67],[16.83,-59.04,3.77,1.56],
  [20.66,15.91,3.77,-0.06],[21.44,-22.41,3.77,1.00],[22.12,25.35,3.77,0.43],[7.15,-70.50,3.78,1.01],
  [7.43,27.80,3.78,1.02],[9.85,59.04,3.78,0.29],[10.89,-58.85,3.78,0.94],[14.69,13.73,3.78,0.04],
  [20.79,-9.50,3.78,0.00],[3.16,44.86,3.79,0.98],[10.89,34.21,3.79,1.04],[3.20,-28.99,3.80,0.54],
  [7.65,-26.80,3.80,-0.16],[15.58,10.54,3.80,0.27],[19.29,53.37,3.80,0.95],[20.23,46.74,3.80,1.27],
  [4.59,-30.56,3.81,0.96],[10.46,-58.74,3.81,0.32],[15.71,26.30,3.81,0.02],[23.63,46.46,3.81,0.98],
  [2.03,2.76,3.82,0.02],[9.31,36.80,3.82,0.07],[11.52,69.33,3.82,1.61],[16.52,1.98,3.82,0.02],
  [17.66,46.01,3.82,-0.18],[10.43,-16.84,3.83,1.46],[13.97,-42.10,3.83,-0.22],[14.80,-79.04,3.83,1.43],
  [3.74,-64.81,3.84,1.13],[3.74,32.29,3.84,0.02],[4.48,15.96,3.84,0.95],[8.92,-60.64,3.84,-0.10],
  [10.55,9.31,3.84,-0.15],[10.62,-48.23,3.84,0.30],[12.54,-72.13,3.84,-0.16],[18.13,28.76,3.84,-0.02],
  [18.23,-21.06,3.84,0.20],[19.80,70.27,3.84,0.89],[4.23,-42.29,3.85,1.08],[5.79,-51.07,3.85,0.17],
  [6.37,-33.44,3.85,0.86],[10.25,-42.12,3.85,0.05],[12.56,69.79,3.85,-0.12],[12.63,-48.54,3.85,0.05],
  [15.94,15.66,3.85,0.48],[18.39,21.77,3.85,1.17],[18.59,-8.24,3.85,1.32],[0.95,38.50,3.86,0.13],
  [4.64,-14.30,3.86,1.08],[5.52,-35.47,3.86,1.13],[16.26,-63.69,3.86,1.10],[16.56,-78.90,3.86,0.92],
  [17.94,37.25,3.86,1.35],[22.36,-1.39,3.86,-0.06],[3.76,24.37,3.87,-0.06],[8.77,-46.04,3.87,0.01],
  [13.98,-44.80,3.87,-0.21],[14.72,-5.66,3.87,0.39],[15.95,-29.21,3.87,-0.20],[19.87,1.01,3.87,0.63],
  [0.16,-45.75,3.88,1.01],[1.89,19.29,3.88,-0.05],[9.88,26.01,3.88,1.22],[15.20,-48.74,3.88,-0.03],
  [23.17,-45.25,3.88,1.00],[2.94,-8.90,3.89,1.09],[6.90,-24.18,3.89,1.74],[9.24,2.31,3.89,-0.06],
  [12.33,-0.67,3.89,0.03],[19.94,35.08,3.89,1.02],[9.66,-1.14,3.90,1.31],[11.35,-54.49,3.90,-0.16],
  [13.52,-39.41,3.90,1.19],[4.05,5.99,3.91,0.03],[8.43,-3.91,3.91,-0.01],[12.47,-50.23,3.91,-0.19],
  [15.09,-47.05,3.91,-0.14],[15.59,-14.79,3.91,1.01],[16.33,46.31,3.91,-0.15],[17.00,30.93,3.92,-0.02],
  [19.36,-17.85,3.92,0.23],[21.26,5.25,3.92,0.55],[0.44,-43.68,3.93,0.17],[1.52,-49.07,3.93,0.97],
  [2.90,52.76,3.93,0.76],[4.61,-3.35,3.93,-0.21],[7.70,-72.61,3.93,1.03],[11.14,-58.98,3.93,1.23],
  [16.11,-20.67,3.93,-0.05],[18.01,2.93,3.93,0.03],[1.14,-55.25,3.94,-0.12],[7.69,-9.55,3.94,1.02],
  [7.73,-28.95,3.94,0.16],[8.74,18.15,3.94,1.08],[20.95,41.17,3.94,0.03],[2.06,72.42,3.95,-0.00],
  [6.61,-19.26,3.95,1.04],[4.14,47.71,3.96,-0.03],[5.99,-42.82,3.96,1.15],[9.01,41.78,3.96,0.46],
  [9.19,-62.32,3.96,-0.18],[19.38,-44.46,3.96,-0.09],[19.40,-40.62,3.96,-0.10],[20.26,47.71,3.96,1.45],
  [23.38,-20.10,3.96,1.08],[4.40,-34.02,3.97,1.47],[5.86,39.15,3.97,1.13],[7.28,-67.96,3.97,0.76],
  [8.67,-35.31,3.97,0.94],[12.19,-52.37,3.97,-0.16],[15.85,-33.63,3.97,-0.04],[20.01,-72.91,3.97,-0.03],
  [22.49,-43.50,3.97,1.02],[22.78,23.57,3.97,1.07],[3.98,35.79,3.98,0.02],[21.57,45.59,3.98,0.89],
  [2.00,-21.08,3.99,1.55],[6.25,-6.27,3.99,1.32],[10.41,-74.03,3.99,0.37],[23.29,-58.24,3.99,0.41],
  [9.04,-66.40,4.00,0.14],[11.40,10.53,4.00,0.42],[16.20,-19.46,4.00,0.08],
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

// A few catalog labels don't normalize onto their AlmanacLinks key (which uses
// the full proper name); map those explicitly. Everything else is the label
// lowercased with non-alphanumerics collapsed to underscores.
var _STAR_LINK_OVERRIDES = { 'Rigil Kent.': 'star:rigil_kentaurus' };

// AlmanacLinks key for a catalog star index, or null if it has no proper name.
function _starLinkKey(idx) {
  var nm = _STAR_NAMES[idx];
  if (!nm) return null;
  if (_STAR_LINK_OVERRIDES[nm]) return _STAR_LINK_OVERRIDES[nm];
  return 'star:' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
}

// Local sidereal time (radians) for an instant + longitude — the one value
// every star projection in the scene shares.
function _skyLST(now, lon) {
  var JD = _dateToJD(now.getTime());
  var GMST = (280.46061837 + 360.98564736629 * (JD - JD_J2000)) % 360;
  return (GMST + lon) * DEG_TO_RAD;
}

// Project one star (RA hours, Dec degrees) onto the horizon-scene canvas for a
// precomputed LST and observer latitude (sin/cos passed in so a whole catalogue
// pass computes them once). Returns {x, y, alt} or null when the star falls
// below the scene's horizon band or outside its 60°–300° azimuth window. Shared
// by the named catalog (_projectStars) and the real field (_projectFieldStars)
// so both use byte-for-byte identical geometry.
function _projectStarXY(raHours, decDeg, LST, sinLat, cosLat, W, H) {
  var ra = raHours * 15 * DEG_TO_RAD;
  var dec = decDeg * DEG_TO_RAD;
  var sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  var HA = LST - ra;
  HA = ((HA % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  var sinAlt = sinLat * sinDec + cosLat * cosDec * Math.cos(HA);
  var altitude = Math.asin(sinAlt) * 180 / Math.PI;
  if (altitude < -2) return null;
  var cosAz = (sinDec - sinLat * sinAlt) / (cosLat * Math.cos(Math.asin(sinAlt)));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  if (isNaN(cosAz)) cosAz = 0;
  var azimuth = Math.acos(cosAz) * 180 / Math.PI;
  if (HA > 0) azimuth = 360 - azimuth;
  var xFrac = (azimuth - 60) / 240;
  if (xFrac < -0.05 || xFrac > 1.05) return null;
  xFrac = Math.max(0, Math.min(1, xFrac));
  return { x: xFrac * W, y: Math.max(0, Math.min(H * 0.66, H * 0.66 - (altitude / 90) * H * 0.56)), alt: altitude };
}

// Project the named catalog stars to canvas coordinates for current
// time/location. `alt` rides along so the a11y description can count how many
// are truly above the horizon.
function _projectStars(now, lat, lon, W, H) {
  var LST = _skyLST(now, lon);
  var latR = lat * DEG_TO_RAD, sinLat = Math.sin(latR), cosLat = Math.cos(latR);
  var result = [];
  for (var i = 0; i < _STARS.length; i++) {
    var s = _STARS[i];
    var p = _projectStarXY(s[0], s[1], LST, sinLat, cosLat, W, H);
    if (p) result.push({ x: p.x, y: p.y, alt: p.alt, mag: s[2], idx: i });
  }
  return result;
}

// Project the real background field (_SKY_FIELD_STARS) the same way. Only stars
// genuinely above the horizon are kept; each survivor carries a warm/cool tint
// from its colour index and a deterministic twinkle phase seeded from its RA, so
// the shimmer is stable across rebuilds. Rebuilt only when _skyFrame recomputes
// (init / time jump / drift cadence), never per animation frame.
function _projectFieldStars(now, lat, lon, W, H) {
  var LST = _skyLST(now, lon);
  var latR = lat * DEG_TO_RAD, sinLat = Math.sin(latR), cosLat = Math.cos(latR);
  var out = [];
  for (var i = 0; i < _SKY_FIELD_STARS.length; i++) {
    var fs = _SKY_FIELD_STARS[i];
    var p = _projectStarXY(fs[0], fs[1], LST, sinLat, cosLat, W, H);
    if (!p || p.alt < 0) continue;
    out.push({ x: p.x, y: p.y, mag: fs[2], ci: fs[3], phase: (fs[0] * 137.508) % 6.2832 });
  }
  return out;
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

// "r,g,b" tint for a star from its B–V colour index: hot blue-white stars have
// a low (even negative) index, cool amber stars a high one. Buckets, not a
// gradient — plenty at this scale, and cheap. Shared by the field draw.
function _starTint(ci) {
  if (ci == null) return '220,230,255';
  if (ci < 0.0)  return '202,222,255';  // blue-white (O/B)
  if (ci < 0.3)  return '226,236,255';  // white (A)
  if (ci < 0.6)  return '248,248,235';  // yellow-white (F)
  if (ci < 1.0)  return '255,240,208';  // yellow (G/K)
  return '255,214,170';                 // orange-red (K/M)
}

function _drawSkyScene(canvas, dpr, sunPos, now, lat, lon, elapsed, labelText, projStars, moonData, projField) {
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

    // Real background field — the naked-eye sky at astronomically correct
    // positions (_projectFieldStars, mag ≤ 4.0), replacing the old procedural
    // filler that never moved with the sky. Positions are cached (rebuilt only
    // on a time/location change, never per frame); only the twinkle recomputes
    // each RAF tick, and each star's colour-index tint makes hot stars blue and
    // cool stars amber, as the real sky is.
    if (projField) {
      for (var si = 0; si < projField.length; si++) {
        var fp = projField[si];
        var fr = Math.max(0.35, (4.5 - fp.mag) * 0.28) * dpr;
        var ftw = Math.sin(t * (1.0 + (si % 7) * 0.3) + fp.phase) * 0.12;
        var fbase = 0.1 + (4.5 - fp.mag) / 4.5 * 0.5;
        var fsa = starOpacity * Math.max(0.05, Math.min(0.85, fbase + ftw));
        ctx.beginPath();
        ctx.arc(fp.x, fp.y, fr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + _starTint(fp.ci) + ',' + fsa.toFixed(3) + ')';
        ctx.fill();
      }
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
    // The moon IS the hero's shaded sprite now — a soft terminator and a dim,
    // visible earthshine dark side, not a black cut-out — rotated by the
    // parallactic angle so its tilt matches the real sky.
    var pAngleBody = (moonPos.parallactic || 0) * DEG_TO_RAD;
    var spr = (typeof _moonSpriteCanvas === 'function' && _moonTexReady)
      ? _moonSpriteCanvas(m.illumination / 100, m.phase <= 0.5, moonR / dpr) : null;
    ctx.save();
    ctx.globalAlpha = moonAlpha;
    ctx.translate(moonX, moonY);
    ctx.rotate(pAngleBody);
    if (spr) {
      ctx.drawImage(spr, -moonR, -moonR, moonR * 2, moonR * 2);
      if (isDaytime) {
        // Wash the disc pale-blue by day so it reads as faint against the sky.
        ctx.beginPath(); ctx.arc(0, 0, moonR, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = 'rgba(150,175,205,0.4)';
        ctx.fillRect(-moonR, -moonR, moonR * 2, moonR * 2);
      }
    } else {
      // Before the texture loads: a soft lit disc (no black terminator).
      ctx.beginPath(); ctx.arc(0, 0, moonR, 0, Math.PI * 2); ctx.clip();
      var moonGrad = ctx.createRadialGradient(-moonR * 0.25, -moonR * 0.2, 0, 0, 0, moonR);
      moonGrad.addColorStop(0, isDaytime ? '#d8dce6' : '#f0ead8');
      moonGrad.addColorStop(1, isDaytime ? '#a8acb6' : '#c0b498');
      ctx.fillStyle = moonGrad;
      ctx.fill();
    }
    ctx.restore();
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

var _starChartSelectedKey = null; // the currently selected body's link key (2nd
                                  // tap on the same one opens its article)

var _scTouchPanning = false;      // a touch gesture began inside the disc

function _starChartResetLoc() {
  _starChartViewLat = null;
  _starChartViewLon = null;
  _drawStarChart(_starChartTime());
}

// True when a client point falls within the inscribed disc of the square canvas
// — the only region that owns the pan gesture. Corners belong to the page.
function _insideChartDisc(canvas, clientX, clientY) {
  var rect = canvas.getBoundingClientRect();
  var px = clientX - rect.left - rect.width / 2;
  var py = clientY - rect.top - rect.height / 2;
  var R = Math.min(rect.width, rect.height) / 2;
  return px * px + py * py <= R * R;
}

// Drag the chart to stand somewhere else on Earth. This is a preview only —
// it never overwrites the saved location the rest of the almanac uses.
function _initStarChartDrag(canvas) {
  var dragging = false, lastX = 0, lastY = 0, moved = 0;
  // touch-action is `auto`, so a touch that starts in the square's corners
  // scrolls the page normally. Containment lives in these listeners, not
  // clip-path (which only clips hit-testing in some browsers, not Safari):
  //   - touchstart records only whether the gesture began inside the disc; it
  //     does NOT preventDefault, so a stationary tap still yields its click
  //     (tap-to-identify / open the article).
  //   - touchmove (non-passive) preventDefaults only for an inside-started
  //     gesture, cancelling the page scroll so the pan owns it. A corner-started
  //     gesture is left to scroll the page.
  // Bound once — _initStarChartDrag re-runs per render, and addEventListener
  // would otherwise stack duplicates (unlike the reassigned pointer handlers).
  if (!canvas._scTouchBound) {
    canvas._scTouchBound = true;
    canvas.addEventListener('touchstart', function (e) {
      var tt = e.touches[0];
      _scTouchPanning = !!tt && _insideChartDisc(canvas, tt.clientX, tt.clientY);
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (_scTouchPanning) e.preventDefault();
    }, { passive: false });
    var _scTouchClear = function () { _scTouchPanning = false; };
    canvas.addEventListener('touchend', _scTouchClear);
    canvas.addEventListener('touchcancel', _scTouchClear);
  }
  canvas.onpointerdown = function (e) {
    // Only the circular disc is interactive. A press in the square's corners
    // (outside the inscribed circle) must not start a rotation or capture the
    // pointer — it belongs to the page (scroll). This mirrors the touch guard
    // above and keeps mouse/stylus honest.
    if (!_insideChartDisc(canvas, e.clientX, e.clientY)) return;
    dragging = true; moved = 0;
    lastX = e.clientX; lastY = e.clientY;
    _starChartDragged = false;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
  };
  canvas.onpointermove = function (e) {
    if (!dragging) {
      // Hover affordance: pointer cursor only over a body that resolves to an
      // installed article. Plain (grab) cursor everywhere else.
      var hr = canvas.getBoundingClientRect();
      var over = _starChartBodyAt(e.clientX - hr.left, e.clientY - hr.top);
      canvas.style.cursor = _starChartLinkFor(over) ? 'pointer' : '';
      return;
    }
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

// Nearest drawn body within the tap radius of a canvas point, or null.
function _starChartBodyAt(x, y) {
  var best = null, bestD = 18;
  for (var i = 0; i < _starChartBodies.length; i++) {
    var b = _starChartBodies[i];
    var d = Math.sqrt((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y));
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

// The resolved article for a body, or null (no key / not in the installed
// library / batch not yet landed).
function _starChartLinkFor(body) {
  return (body && body.key && window.AlmanacLinks) ? window.AlmanacLinks.linkFor(body.key) : null;
}

function _starChartClick(ev) {
  if (_starChartDragged) { _starChartDragged = false; return; } // that was a pan
  var canvas = document.getElementById('almanac-starchart');
  var info = document.getElementById('alm-sc-info');
  if (!canvas || !info) return;
  var r = canvas.getBoundingClientRect();
  var best = _starChartBodyAt(ev.clientX - r.left, ev.clientY - r.top);
  if (!best) { info.innerHTML = ''; _starChartSelectedKey = null; return; }
  var link = _starChartLinkFor(best);
  // Second tap on the same, already-selected linkable body opens its installed
  // article (closed-set authority — same open path the name-link hint uses).
  if (link && best.key && best.key === _starChartSelectedKey) {
    window.AlmanacLinks.open(best.key);
    return;
  }
  // First tap selects: name it in the info line, carrying the dotted-amber link
  // hint ONLY when its curated Q-ID actually resolved (no link → no hint, never
  // a search). A resolved body is remembered so a second tap can open it.
  var label = _almEsc(best.label);
  info.innerHTML = link ? window.AlmanacLinks.wrap(best.key, label) : label;
  _starChartSelectedKey = link ? best.key : null;
}

function _renderStarChart(baseNow) {
  _starChartBase = baseNow;
  _starChartViewLat = null;
  _starChartViewLon = null;
  var cv = document.getElementById('almanac-starchart');
  if (cv) _initStarChartDrag(cv);
  var info = document.getElementById('alm-sc-info');
  if (info) info.innerHTML = '';
  _starChartSelectedKey = null;
  _drawStarChart(baseNow);
}

// Decorative dim background starfield for the planisphere disc — a cached,
// deterministic field (not astronomically real, not linkable) so the schematic
// chart disc reads as a dense night sky rather than the ~25-35 catalog stars
// typically above the horizon at once. (The horizon SCENE uses real positions —
// see _projectFieldStars — but the planisphere is a labelled diagram, where an
// even ambient fill behind the named stars reads better than 460 mag dots.)
// Cached by disc size only (not lat/lon/time), so panning/scrubbing is free.
var _starChartBgStars = null;

function _ensureStarChartBgStars(size) {
  if (_starChartBgStars && _starChartBgStars.size === size) return _starChartBgStars.stars;
  var sr = _lcgRand(137);
  var count = 150;
  var half = size / 2;
  var stars = [];
  for (var i = 0; i < count; i++) {
    var ang = sr() * Math.PI * 2;
    var rad = Math.sqrt(sr()) * (half - 16); // area-uniform over the disc, clear of the rim labels
    stars.push({
      x: half + Math.cos(ang) * rad,
      y: half + Math.sin(ang) * rad,
      r: 0.3 + sr() * 0.45,
      a: 0.06 + sr() * 0.13
    });
  }
  _starChartBgStars = { size: size, stars: stars };
  return stars;
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

  // Faint decorative background stars, clipped to the disc — ambiance only,
  // drawn under the constellation lines and the real (linkable) catalog stars.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  var bgStars = _ensureStarChartBgStars(size);
  for (var bgi = 0; bgi < bgStars.length; bgi++) {
    var bg = bgStars[bgi];
    ctx.beginPath(); ctx.arc(bg.x, bg.y, bg.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(210,220,240,' + bg.a.toFixed(3) + ')';
    ctx.fill();
  }
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
      x: p.x, y: p.y, key: _starLinkKey(i),
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
      x: pp.x, y: pp.y, key: 'planet:' + nm.toLowerCase(),
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
      x: mpp.x, y: mpp.y, key: 'planet:moon',
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
