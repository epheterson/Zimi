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
function _skySelectHtml(id, labelKey, values, keyOf) {
  var h = '<label class="alm-sky-set-row"><span>' + _almEsc(t(labelKey)) + '</span><select data-sky-set="' + id + '">';
  for (var i = 0; i < values.length; i++) h += '<option value="' + values[i] + '">' + _almEsc(t(keyOf(values[i]))) + '</option>';
  return h + '</select></label>';
}
function _skySettingsHtml() {
  return '<div class="alm-sky-set-title">' + _almEsc(t('alm_sky_set')) + '</div>' +
    '<label class="alm-sky-set-row"><span>' + _almEsc(t('alm_sky_set_dark')) + '</span>' +
    '<span class="alm-sky-dial"><small>' + _almEsc(t('alm_sky_set_dark_lo')) + '</small>' +
    '<input type="range" min="0" max="' + SKY_DIAL_STEPS + '" step="1" data-sky-set="dial" aria-label="' + _almEsc(t('alm_sky_set_dark')) + '">' +
    '<small>' + _almEsc(t('alm_sky_set_dark_hi')) + '</small></span></label>' +
    _skySelectHtml('lines', 'alm_sky_set_lines', SKY_SETTING_VALUES.lines, function (v) { return 'alm_sky_lines_' + v; }) +
    _skySelectHtml('size', 'alm_sky_set_size', SKY_SETTING_VALUES.size, function (v) { return 'alm_sky_size_' + v; }) +
    _skySelectHtml('skin', 'alm_sky_set_skin', SKY_SETTING_VALUES.skin, function (v) { return 'alm_sky_skin_' + v; });
}
// The gear opens the panel over the sky and closes it again; so does a tap anywhere else, and Escape.
function _skyToggleSettings(open) {
  var box = document.getElementById('almanac-sky-set'), gear = document.getElementById('almanac-sky-gear');
  if (!box || !gear) return;
  if (open === undefined) open = box.hidden;
  box.hidden = !open;
  gear.setAttribute('aria-expanded', String(open));
  var off = open ? 'addEventListener' : 'removeEventListener';
  document[off]('pointerdown', _skySettingsOutside, true);
  document[off]('keydown', _skySettingsKey, true);
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
      if (k === 'dial') el.value = Math.round(_skySetting('dial') * SKY_DIAL_STEPS);
      else el.value = _skySetting(k);
      el.addEventListener(k === 'dial' ? 'input' : 'change', function () {
        _skySet(k, k === 'dial' ? el.value / SKY_DIAL_STEPS : el.value);
      });
    })(controls[i]);
  }
}
