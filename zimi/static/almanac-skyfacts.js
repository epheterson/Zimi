// ── Almanac: what the sky tells a person who needs to act on it ──
// Beside the live sky (almanac-sky.js): how much daylight is left, when it is
// fully dark, when the Moon rises and how lit it is, where true north is, the
// time by the Sun, and, when the place is only a guess from the time zone,
// that it is a guess and where. Then the sky's settings. All from the
// Almanac's own functions, offline; nothing here asks for a place.
// Loaded after almanac-sky.js, before almanac.js.

// ══ The Sun's and the Moon's rising and setting ═════════════════════════
var SKY_EVENT_STEP_MS = 10 * 60000;        // stepping an altitude forward to bracket a crossing
var SKY_EVENT_TOL_MS = 1000;               // and bisected to this
var SKY_EVENT_HORIZON_MS = 36 * 3600000;   // looking ahead this far for the next
var SKY_MOON_RISE_ALT = -0.27;             // the Moon's apparent centre when its upper limb touches the horizon

// The next instant after fromMs that altOf(ms) (degrees) crosses level going
// down (dir -1) or up (dir +1), or null within maxMs.
function _skyNextCrossing(altOf, fromMs, level, dir, maxMs) {
  var a0 = altOf(fromMs) - level;
  for (var t = fromMs + SKY_EVENT_STEP_MS; t <= fromMs + maxMs + SKY_EVENT_STEP_MS; t += SKY_EVENT_STEP_MS) {
    var a1 = altOf(t) - level;
    if ((dir < 0 && a0 > 0 && a1 <= 0) || (dir > 0 && a0 < 0 && a1 >= 0)) {
      var lo = t - SKY_EVENT_STEP_MS, hi = t;
      while (hi - lo > SKY_EVENT_TOL_MS) {
        var mid = (lo + hi) / 2, am = altOf(mid) - level;
        if ((dir < 0 && am > 0) || (dir > 0 && am < 0)) lo = mid; else hi = mid;
      }
      return hi;
    }
    a0 = a1;
  }
  return null;
}
// The Sun's geometric altitude (degrees) at an instant and a place.
function _skySunAltAt(ms, lat, lon) {
  var d = new Date(ms), sq = _skySunRaDec(_jdToJulianCentury(_dateToJD(ms)));
  return _skyHorizontal(sq.ra, sq.dec, _skyLST(d, lon), Math.sin(lat * DEG_TO_RAD), Math.cos(lat * DEG_TO_RAD)).alt;
}
function _skyMoonAltAt(ms, lat, lon) { return _moonPosition(new Date(ms), lat, lon).altitude; }
function _skySunAzAt(ms, lat, lon) {
  var d = new Date(ms), sq = _skySunRaDec(_jdToJulianCentury(_dateToJD(ms)));
  return _skyHorizontal(sq.ra, sq.dec, _skyLST(d, lon), Math.sin(lat * DEG_TO_RAD), Math.cos(lat * DEG_TO_RAD)).az;
}
function _skyMoonAzAt(ms, lat, lon) { return _moonPosition(new Date(ms), lat, lon).azimuth; }

// Everything the facts say, as numbers (instants in ms, null where there is none).
function _skyFactsAt(ms, lat, lon) {
  var sunAlt = function (t) { return _skySunAltAt(t, lat, lon); }, now = sunAlt(ms), horizon = SKY_EVENT_HORIZON_MS;
  var sunUp = now > SKY_DAY_ALT, dark = now < SKY_ASTRO_ALT;
  var out = {
    sunUp: sunUp,
    sunset: _skyNextCrossing(sunAlt, ms, SKY_DAY_ALT, -1, horizon), sunrise: _skyNextCrossing(sunAlt, ms, SKY_DAY_ALT, 1, horizon),
    fullyDark: dark,
    darkFrom: dark ? null : _skyNextCrossing(sunAlt, ms, SKY_ASTRO_ALT, -1, horizon),
    darkUntil: dark ? _skyNextCrossing(sunAlt, ms, SKY_ASTRO_ALT, 1, horizon) : null
  };
  var moonAlt = function (t) { return _skyMoonAltAt(t, lat, lon); };
  out.moonUp = moonAlt(ms) > SKY_MOON_RISE_ALT;
  out.moonrise = _skyNextCrossing(moonAlt, ms, SKY_MOON_RISE_ALT, 1, horizon);
  out.moonset = _skyNextCrossing(moonAlt, ms, SKY_MOON_RISE_ALT, -1, horizon);
  // Where on the horizon each one happens.
  if (out.sunset) out.sunsetAz = _skySunAzAt(out.sunset, lat, lon);
  if (out.sunrise) out.sunriseAz = _skySunAzAt(out.sunrise, lat, lon);
  if (out.moonrise) out.moonriseAz = _skyMoonAzAt(out.moonrise, lat, lon);
  if (out.moonset) out.moonsetAz = _skyMoonAzAt(out.moonset, lat, lon);
  return out;
}
// The time by the Sun's own reckoning, minutes into the solar day (the
// equation of time and the longitude, as the Sun's position uses them).
function _skySolarMinutes(date, lon) {
  var EoT = _eqOfTime(_solarB(_dayOfYear(date)));
  var utc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  return (((utc + EoT + lon * 4) % 1440) + 1440) % 1440;
}

// ══ In words ════════════════════════════════════════════════════════════
var SKY_GUESS_ROUND_MS = 15 * 60000;   // while the place is a guess, times are given to the quarter hour, and the line under the tiles says the place is a guess
// A guessed time is given to the quarter hour in the direction that does no
// harm: dir -1 rounds down (the light ends, no later than said), +1 up (the
// dark lasts, no less than said). The span and the clock are cut from the same
// instant, so "10 min . 7:00 PM" adds up.
function _skyRoundMs(ms, guess, dir) {
  if (!guess) return ms;
  var q = ms / SKY_GUESS_ROUND_MS;
  return (dir < 0 ? Math.floor(q) : dir > 0 ? Math.ceil(q) : Math.round(q)) * SKY_GUESS_ROUND_MS;
}
function _skyClock(ms, guess, dir) {
  ms = _skyRoundMs(ms, guess, dir);
  var tz = typeof _almDisplayTz === 'function' ? _almDisplayTz() : null;
  try { return _tzFmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
  catch (e) { return _tzFmt(null, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
}
// "Los Angeles" from "America/Los_Angeles": the zone's own name for its city.
function _skyZoneCity() {
  var tz = typeof _almDeviceTz === 'function' ? _almDeviceTz() : null;
  return tz && tz.indexOf('/') > 0 ? tz.split('/').pop().replace(/_/g, ' ') : '';
}
// The span from now to an instant, the instant rounded as _skyClock rounds it.
function _skySpan(at, now, guess, dir) { return _orrFmtSpan(Math.max(0, _skyRoundMs(at, guess, dir) - now) / 1000); }

// "SW 252°": the point of the compass and the bearing it stands for (the Field Guide's card uses it).
function _skyBearing(az) { return _azCompass(az) + ' ' + Math.round(az) + '\u00b0'; }

// The tiles, [label, value, key]: the Moon, then the Sun, three of each in the hero's one grid (almanac.css orders
// them), every tile a label and one value and none taller than its neighbours. The Moon: how lit it is and when it is
// next full (the hero's), and when it rises or sets, whichever comes next (with neither in the next day and a half,
// how lit it is). The Sun: its rise, its set, and the length of the day between, in the place's own zone (a polar
// day or night says so in one tile). A guessed place is said once, under the grid. Where north is, the Look view
// and the star chart show.
function _skyFactRows(s, f) {
  var guess = !s.stored, at = function (ms, dir) { return _skyClock(ms, guess, dir); };
  var up = f.moonUp, here = up ? f.moonset : f.moonrise;
  var rows = [here ? [t(up ? 'tb_moonset' : 'tb_moonrise'), at(here, up ? -1 : 1), 'moon']
    : [t('alm_moon'), t('alm_sky_f_moon_lit', { p: _orrNum(s.moonData.phase.illumination, null, 0) + '%' }), 'moon']];
  var sun = _almSunTimesAt(new Date(s.nowTime), { lat: s.lat, lon: s.lon, stored: s.stored });
  if (sun.polar) rows.push([t('alm_sun'), sun.polar, 'sunrise']);
  else rows.push([t('alm_sunrise'), sun.sunrise, 'sunrise'], [t('alm_sunset'), sun.sunset, 'sunset'], [t('alm_daylight'), sun.dayLength, 'daylight']);
  return rows;
}
// The cards in the hero's own grammar (a label over a value, two columns).
function _skyFactCards(rows) {
  var html = '<div class="alm-sky-cards">';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += '<div class="alm-card alm-sf-' + r[2] + '"><div class="alm-card-lbl">' + _almEsc(r[0]) + '</div><div class="alm-card-val">' + _almEsc(r[1]) + '</div></div>';
  }
  return html + '</div>';
}
// The tiles worked out from the clock and the place alone, for the hero's first paint: the sky's own state (which
// _skyFacts reads) comes a frame or more later, and a grid drawn with an empty slot grew by a row when it came,
// pushing the sky down under the reader (Eric, 2026-11-04: "the tiles go away and the sky jumps"). Sums only, no
// sky: the same rows the sky writes a moment later, so its write changes nothing on the screen.
function _skyFactsPrimeHtml(focus, loc, moon) {
  try {
    var s = { nowTime: focus.getTime(), lat: loc.lat, lon: loc.lon, stored: loc.stored, moonData: { phase: moon || _moonPhase(focus) } };
    return _skyFactCards(_skyFactRows(s, _skyFactsNear(s.nowTime, s.lat, s.lon)));
  } catch (e) { return ''; }
}
var SKY_FACTS_MS = 30000;      // the rows are rewritten at most this often
// The facts for a place within the rewrite interval of the last ones: the hero's first paint (_skyFactsPrimeHtml) and the
// sky's first frame ask for the same crossing search, which is done once.
var _skyFactsMemo = null;
function _skyFactsNear(ms, lat, lon) {
  var m = _skyFactsMemo;
  if (!m || m.lat !== lat || m.lon !== lon || Math.abs(ms - m.ms) >= SKY_FACTS_MS) m = _skyFactsMemo = { ms: ms, lat: lat, lon: lon, facts: _skyFactsAt(ms, lat, lon) };
  return m.facts;
}
function _skyFacts(s) {
  var el = document.getElementById('almanac-sky-facts');
  if (!el || !s.eph) return;
  var key = s.lat + ',' + s.lon, due = !s.factsAt || Math.abs(s.nowTime - s.factsAt) >= SKY_FACTS_MS || s.factsKey !== key;
  if (due) { s.facts = _skyFactsNear(s.nowTime, s.lat, s.lon); s.factsAt = s.nowTime; s.factsKey = key; }
  var html = _skyFactCards(_skyFactRows(s, s.facts));
  if (el._html !== html && el.innerHTML !== html) el.innerHTML = html;
  el._html = html;
}
// The word that the place is a guess, said in the ask for a place under the tiles (_almSkyInviteHtml).
function _skyGuessText() {
  var city = _skyZoneCity();
  return city ? t('alm_sky_f_guess', { city: city }) : t('alm_sky_f_guess_nocity');
}

// ══ The settings ════════════════════════════════════════════════════════
var SKY_DIAL_STEPS = 100;
// A choice among a few, as a segmented control in the settings row's style (never a native dropdown).
function _skySegHtml(id, labelKey, values, keyOf) {
  var cap = 'alm-sky-seg-' + id, h = '<div class="alm-sky-set-row"><span id="' + cap + '">' + _almEsc(t(labelKey)) + '</span><div class="alm-sky-seg" role="radiogroup" aria-labelledby="' + cap + '">';
  for (var i = 0; i < values.length; i++) h += '<button type="button" role="radio" aria-checked="false" data-sky-seg="' + id + '" data-v="' + values[i] + '">' + _almEsc(t(keyOf(values[i]))) + '</button>';
  return h + '</div></div>';
}
var SKY_SET_MS = 200, SKY_SET_OPEN_MS = 320;   // the sheet comes up in 320 ms (CSS) and goes back in 200: by transform alone
var SKY_SET_SWIPE_PX = 80;   // a drag down on the handle this far closes it
// What a scene draws here, in a few words under its card: the place's own says the terrain it resolves to (from the land cover: grass,
// forest, desert, a coast..., or that the land is being read or is not mapped), the beach and the horizon say what they are.
var SKY_LAND_NAMES = ['grass', 'broadleaf', 'conifer', 'desert', 'snow', 'tundra', 'beach'];
function _skySceneKey(v) {
  if (v !== 'local') return v;
  var sc = typeof _osPlaceScene === 'function' && _skyState ? _osPlaceScene(_skyState) : 'plain';
  if (sc === 'plain') return typeof _osLandFailed !== 'undefined' && _osLandFailed ? 'nomap' : 'plain';
  if (sc === 'beach') return 'coast';   // the place's own is a coast: it says so, the Beach card keeps "Sea and sand"
  return SKY_LAND_NAMES.indexOf(sc) >= 0 ? sc : 'plain';
}
function _skySceneName(v) { return t('alm_sky_scene_' + _skySceneKey(v)); }
// The scene, as three small pictures to choose from: the place's own, the beach, the true horizon. Each is drawn in CSS from a
// sky and a ground colour (nothing is rendered or fetched to show them); the place's own wears the colour of the scene it has.
var SKY_SKIN_GROUND = { grass: '#4f7a3a', broadleaf: '#3f6b32', conifer: '#2f5a3a', desert: '#b79868', snow: '#d9e2ea', tundra: '#7d8a78', beach: '#c9b27c', plain: '#3a3d44' };
function _skySkinSwatch(v) {
  var ground = v === 'beach' ? SKY_SKIN_GROUND.beach : v === 'horizon' ? '#15171b' : SKY_SKIN_GROUND[typeof _osPlaceScene === 'function' && _skyState ? _osPlaceScene(_skyState) : 'plain'] || SKY_SKIN_GROUND.plain;
  var land = v === 'beach' ? '#2d6f9e 60%,#2d6f9e 78%,' + ground + ' 78%' : ground + ' 70%';
  return 'linear-gradient(#1d3557,#6c8fb5 ' + (v === 'beach' ? '60' : '70') + '%,' + land + ')';
}
function _skySkinCardsHtml() {
  var h = '<div class="alm-sky-set-cap" id="alm-sky-skin-cap">' + _almEsc(t('alm_sky_set_skin')) + '</div><div class="alm-sky-skins" role="radiogroup" aria-labelledby="alm-sky-skin-cap">';
  SKY_SETTING_VALUES.skin.forEach(function (v) {
    h += '<button type="button" role="radio" class="alm-sky-skin" data-sky-skin="' + v + '" aria-checked="false">' +
      '<span class="alm-sky-skin-pic" style="background:' + _skySkinSwatch(v) + '"></span><span>' + _almEsc(t('alm_sky_skin_' + v)) + '</span>' +
      '<small class="alm-sky-skin-sub" data-sky-sub="' + v + '">' + _almEsc(_skySceneName(v)) + '</small></button>';
  });
  return h + '</div>';
}
function _skySettingsHtml() {
  return '<div class="alm-sky-set-grip" id="alm-sky-set-grip"><i></i></div>' + _skySkinCardsHtml() +
    '<label class="alm-sky-set-row" id="alm-sky-life-row"><span class="alm-sky-set-lbl">' + _almEsc(t('alm_sky_set_life')) + '<small class="alm-sky-set-sub" id="alm-sky-life-sub"></small></span><input type="checkbox" role="switch" data-sky-set="life" aria-describedby="alm-sky-life-sub"></label>' +
    _skySegHtml('lines', 'alm_sky_set_lines', SKY_SETTING_VALUES.lines, function (v) { return 'alm_sky_seg_lines_' + v; }) +
    _skySegHtml('size', 'alm_sky_set_size', SKY_SETTING_VALUES.size, function (v) { return 'alm_sky_size_' + v; }) +
    '<label class="alm-sky-set-row"><span>' + _almEsc(t('alm_sky_set_dark')) + '</span>' +
    '<span class="alm-sky-dial"><small>' + _almEsc(t('alm_sky_set_dark_lo')) + '</small>' +
    '<input type="range" min="0" max="' + SKY_DIAL_STEPS + '" step="1" data-sky-set="dial" aria-label="' + _almEsc(t('alm_sky_set_dark')) + '">' +
    '<small>' + _almEsc(t('alm_sky_set_dark_hi')) + '</small></span></label>' +
    '<button type="button" class="alm-sky-open3d" id="alm-sky-open3d">' + ALM_RIM_SVG + '<span>' + _almEsc(t('alm_sky_open3d')) + '</span></button>';
}
// The gear opens the sheet from the foot of the screen and closes it again; so does a tap anywhere else, a swipe down on its handle, and
// Escape. It moves by transform alone (320 ms up, 200 ms back; with reduced motion it appears and goes): the card is scrolled to the top
// first, so it stands in view above the sheet, and nothing behind changes size or place while the sheet is open.
function _skyToggleSettings(open) {
  var box = document.getElementById('almanac-sky-set'), gear = document.getElementById('almanac-sky-gear');
  if (!box || !gear) return;
  if (open === undefined) open = !box.classList.contains('in');
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  clearTimeout(box._skyShut);
  box.style.transform = box.style.transition = '';   // a swipe's own drag is over
  if (open) {
    var card = document.querySelector('#almanac-view .almanac-sky-wrap');
    if (card && card.getBoundingClientRect().top > 1) card.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
    box.hidden = false;
    _skySyncSettings(box);   // the light-pollution dial starts where the place's own night lights say, which may arrive after the sheet was built
    if (!still) void box.offsetWidth;   // the closed state is drawn once, so the move has somewhere to start
    box.classList.add('in');
  } else {
    box.classList.remove('in');
    if (still) box.hidden = true; else box._skyShut = setTimeout(function () { box.hidden = true; }, SKY_SET_MS);
  }
  gear.setAttribute('aria-expanded', String(open));
  var off = open ? 'addEventListener' : 'removeEventListener';
  document[off]('pointerdown', _skySettingsOutside, true);
  document[off]('keydown', _skySettingsKey, true);
}
// Leaving the Almanac with the sheet open takes its document listeners with it, so its Escape handler never outlives the view.
function _skySettingsOff() {
  clearTimeout((document.getElementById('almanac-sky-set') || {})._skyShut);
  document.removeEventListener('pointerdown', _skySettingsOutside, true);
  document.removeEventListener('keydown', _skySettingsKey, true);
}
// A drag down on the handle follows the finger and closes the sheet past SKY_SET_SWIPE_PX, else it springs back.
function _skyBindSwipe(box) {
  var grip = box.querySelector('#alm-sky-set-grip'), y0 = null;
  if (!grip) return;
  grip.addEventListener('pointerdown', function (e) { y0 = e.clientY; grip.setPointerCapture(e.pointerId); box.style.transition = 'none'; });
  grip.addEventListener('pointermove', function (e) { if (y0 !== null) box.style.transform = 'translateY(' + Math.max(0, e.clientY - y0) + 'px)'; });
  var end = function (e) {
    if (y0 === null) return;
    var dy = e.clientY - y0;
    y0 = null;
    box.style.transition = '';
    if (dy > SKY_SET_SWIPE_PX) { box.style.transform = ''; _skyToggleSettings(false); } else box.style.transform = '';
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}
function _skySettingsOutside(e) {
  var box = document.getElementById('almanac-sky-set'), gear = document.getElementById('almanac-sky-gear');
  if (box && !box.contains(e.target) && !(gear && gear.contains(e.target))) _skyToggleSettings(false);
}
function _skySettingsKey(e) {
  if (e.key !== 'Escape') return;
  // Closes the panel, never the Almanac behind it (app.js closes that on an Escape that reaches it).
  e.preventDefault(); e.stopImmediatePropagation();
  _skyToggleSettings(false);
  var gear = document.getElementById('almanac-sky-gear');
  if (gear) gear.focus();
}
// Each control shows what the sky is drawn with.
function _skySyncSettings(box) {
  var controls = box.querySelectorAll('[data-sky-set]'), i;
  for (i = 0; i < controls.length; i++) {
    var el = controls[i], k = el.getAttribute('data-sky-set');
    if (el.type === 'checkbox') el.checked = _skySetting(k) === 'on';
    else el.value = k === 'dial' ? Math.round(_skySetting('dial') * SKY_DIAL_STEPS) : _skySetting(k);
  }
  var cards = box.querySelectorAll('[data-sky-skin]');
  for (i = 0; i < cards.length; i++) {
    var v = cards[i].getAttribute('data-sky-skin'), pic = cards[i].querySelector('.alm-sky-skin-pic'), sub = cards[i].querySelector('[data-sky-sub]');
    cards[i].setAttribute('aria-checked', String(v === _skySetting('skin')));
    if (pic) pic.style.background = _skySkinSwatch(v);   // the place's own wears the scene it has now
    if (sub) sub.textContent = _skySceneName(v);
  }
  var segs = box.querySelectorAll('[data-sky-seg]');
  for (i = 0; i < segs.length; i++) segs[i].setAttribute('aria-checked', String(segs[i].getAttribute('data-v') === _skySetting(segs[i].getAttribute('data-sky-seg'))));
  var sub = document.getElementById('alm-sky-life-sub');   // Life: what it draws, on every scene
  if (sub) sub.textContent = t('alm_sky_life_sub');
}
// The panel and its controls, set to what is chosen; once per panel.
function _skyBindSettings() {
  var box = document.getElementById('almanac-sky-set');
  if (!box) return;
  _skyWatchNight();
  _skyRedSeen = _skyRedOn();
  _skyRedScope(_skyRedSeen);
  if (box._skyBound) return;
  box._skyBound = true;
  box.innerHTML = _skySettingsHtml();
  var controls = box.querySelectorAll('[data-sky-set]');
  for (var i = 0; i < controls.length; i++) {
    (function (el) {
      var k = el.getAttribute('data-sky-set');
      el.addEventListener(k === 'dial' ? 'input' : 'change', function () {
        _skySet(k, k === 'dial' ? el.value / SKY_DIAL_STEPS : el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value);
      });
    })(controls[i]);
  }
  var cards = box.querySelectorAll('[data-sky-skin]');
  for (i = 0; i < cards.length; i++) {
    cards[i].addEventListener('click', function () { _skySet('skin', this.getAttribute('data-sky-skin')); _skySyncSettings(box); });
  }
  var segs = box.querySelectorAll('[data-sky-seg]');
  for (i = 0; i < segs.length; i++) {
    segs[i].addEventListener('click', function () { _skySet(this.getAttribute('data-sky-seg'), this.getAttribute('data-v')); _skySyncSettings(box); });
  }
  var open3d = box.querySelector('#alm-sky-open3d');
  if (open3d) open3d.hidden = typeof _os3DAvailable === 'function' && !_os3DAvailable();   // no WebGL2, no 3D
  if (open3d) open3d.addEventListener('click', function () { _skyToggleSettings(false); if (typeof _osStandHere === 'function') _osStandHere(); });
  _skyBindSwipe(box);
  _skySyncSettings(box);
}
