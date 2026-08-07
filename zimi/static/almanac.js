// ── Almanac — astronomy & calendar mini-app ──
// Lazy-loaded when user clicks the Today card in Discover.
// _almanacOpen is declared in index.html (shared state).

var JD_UNIX_EPOCH = 2440587.5;
var JD_J2000 = 2451545.0;
var MS_PER_DAY = 86400000;
var JULIAN_CENTURY = 36525;
var DEG_TO_RAD = Math.PI / 180;

function _dateToJD(ms) { return JD_UNIX_EPOCH + ms / MS_PER_DAY; }
function _jdToJulianCentury(JD) { return (JD - JD_J2000) / JULIAN_CENTURY; }

var _ALM_LOC_KEY = 'zimi_almanac_location';

// The almanac is EPHEMERAL: a chosen location lives for the session only, never
// across a refresh. Purge any location persisted by an older build on load —
// this also permanently retires the corrupted-longitude value the v1.7 hero-time
// bug could have written to localStorage.
try { localStorage.removeItem(_ALM_LOC_KEY); } catch (e) {}

// A finite lat/lon inside its real range. A click-math slip or a legacy
// corrupted value is rejected so it can never drive the sun/moon/timezone math.
function _almValidLatLon(lat, lon) {
  return typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lon === 'number' && isFinite(lon) && lon >= -180 && lon <= 180;
}

function _getLocation() {
  var stored = null;
  try { stored = sessionStorage.getItem(_ALM_LOC_KEY); } catch (e) {}
  if (stored) {
    try {
      var loc = JSON.parse(stored);
      if (_almValidLatLon(loc.lat, loc.lon)) {
        return { lat: loc.lat, lon: loc.lon, name: loc.name || '', stored: true };
      }
    } catch(e) {}
  }
  // Synthetic default: mid-northern latitude at the device offset's rough
  // meridian. Good enough for sun/moon shapes — but callers formatting TIMES
  // must check `stored`: resolving this made-up point to a timezone showed a
  // fresh browser Denver's clock instead of its own (the device already
  // KNOWS its zone; deriving one from invented coordinates loses that).
  return { lat: 34, lon: -new Date().getTimezoneOffset() / 60 * 15, name: '', stored: false };
}

// The device's IANA zone, resolved once. It cannot change within a page
// lifetime, but Intl.DateTimeFormat().resolvedOptions() builds a full
// formatter every call — far too heavy for the per-frame travel path that
// reads this (measured ~1ms per construction).
var _almDeviceTzCache;
function _almDeviceTz() {
  if (_almDeviceTzCache === undefined) {
    try { _almDeviceTzCache = Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
    catch (e) { _almDeviceTzCache = null; }
  }
  return _almDeviceTzCache;
}

// Timezone used to DISPLAY times for the almanac's home location: the chosen
// location's zone, or the device's own zone when nothing was ever chosen.
function _almDisplayTz(loc) {
  loc = loc || _getLocation();
  return loc.stored ? _almTzForLocation(loc.lat, loc.lon) : _almDeviceTz();
}

function _saveLocation(lat, lon, name) {
  if (!_almValidLatLon(lat, lon)) return; // reject a bad click/geolocate outright
  var data = { lat: lat, lon: lon };
  if (name) data.name = name;
  // Session-only: a chosen location never survives a refresh (see _ALM_LOC_KEY).
  try { sessionStorage.setItem(_ALM_LOC_KEY, JSON.stringify(data)); } catch (e) {}
  // Keep the timezone city list in sync with the new location — otherwise a
  // map click changes the sun/moon math while a stale city stays highlighted.
  _almSelectedTz = _almTzForLocation(lat, lon);
}

// Holiday scope — 'region' (default: the one national pack for the chosen or
// detected location) or 'worldwide' (all national packs layered at once, each
// entry tagged with its country). Session-scoped like the location itself: the
// almanac is ephemeral, so a refresh returns to the location-following default.
var _ALM_HOLIDAY_SCOPE_KEY = 'zimi_almanac_holiday_scope';
function _almHolidayScope() {
  try { return sessionStorage.getItem(_ALM_HOLIDAY_SCOPE_KEY) === 'worldwide' ? 'worldwide' : 'region'; }
  catch (e) { return 'region'; }
}
function _almSetHolidayScope(scope) {
  if (scope === _almHolidayScope()) return;
  try { sessionStorage.setItem(_ALM_HOLIDAY_SCOPE_KEY, scope); } catch (e) {}
  if (typeof _drawAlmanacGrid === 'function') _drawAlmanacGrid();
}

function _signalDelay(au) {
  var sec = au * 499;
  return { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) };
}

function _fmtDuration(h, m) {
  return h + t('alm_h_abbr') + ' ' + m + t('alm_m_abbr');
}

// Translation helpers — t() returns the key itself for missing translations,
// so we must check result !== key to detect misses and fall back to English name.
function _tLookup(k, fallback) { var v = t(k); return v !== k ? v : fallback; }
function _tp(name) { return _tLookup('alm_planet_' + name.toLowerCase(), name); }
function _th(name) {
  if (!name) return '';
  var k = 'alm_hol_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '');
  return _tLookup(k, name);
}
function _showerName(s) {
  if (!s) return '';
  return _tLookup('alm_shower_' + s.key, s.key.replace(/_/g, ' '));
}
var _CONST_KEYS = {'Pisces':'pisces','Aries':'aries','Taurus':'taurus','Gemini':'gemini','Cancer':'cancer','Leo':'leo','Virgo':'virgo','Libra':'libra','Scorpius':'scorpius','Sagittarius':'sagittarius','Capricornus':'capricornus','Aquarius':'aquarius','Bo\u00f6tes':'bootes','Lyra':'lyra','Perseus':'perseus','Draco':'draco','Orion':'orion','Ursa Minor':'ursa_minor'};
function _tc(name) { var k = _CONST_KEYS[name]; return k ? _tLookup('alm_const_' + k, name) : name; }

// Deep-link wrappers \u2014 turn a localized label into a tappable encyclopedia
// link when the library has a matching ZIM (fail-soft: plain text otherwise).
// Only call these at DOM (innerHTML) render sites, never inside canvas draws.
function _alLink(key, html) {
  return window.AlmanacLinks ? window.AlmanacLinks.wrap(key, html) : html;
}
function _lp(name) { var s = _tp(name); return _alLink('planet:' + name.toLowerCase(), s); }
function _lc(name) { var s = _tc(name); var k = _CONST_KEYS[name]; return k ? _alLink('const:' + k, s) : s; }
// Link an astronomy/timekeeping TERM by its map suffix (key = 'term:<suffix>').
// `html` is the already-localized, already-escaped display text.
function _lterm(suffix, html) { return _alLink('term:' + suffix, html); }
// Link a season by its article key ('winter'|'spring'|'summer'|'autumn').
function _lseason(key, html) { return key ? _alLink('season:' + key, html) : html; }

function _dayOfYear(date) {
  // setFullYear, not new Date(year,…): the constructor folds years 0–99 into
  // 1900–1999, which turns Jan 1 of an ancient/typed year into a date ~2000
  // years off and makes day-of-year wildly negative. Reachable now that the
  // time machine travels to arbitrary years.
  var start = new Date(0);
  start.setFullYear(date.getFullYear(), 0, 1);
  start.setHours(0, 0, 0, 0);
  return Math.floor((date - start) / MS_PER_DAY) + 1;
}

function _solarB(dayOfYear) { return (dayOfYear - 1) * 2 * Math.PI / 365; }

function _solarDeclination(B) {
  return 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B) - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B) - 0.002697 * Math.cos(3 * B) + 0.00148 * Math.sin(3 * B);
}

function _eqOfTime(B) {
  return 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B) - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
}

function _almEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }


function _cancelAllRAF() {
  if (_almanacOrreryRAF) { cancelAnimationFrame(_almanacOrreryRAF); _almanacOrreryRAF = null; }
  if (_almanacSkyRAF) { cancelAnimationFrame(_almanacSkyRAF); _almanacSkyRAF = null; }
  if (_tzClockRAF) { cancelAnimationFrame(_tzClockRAF); _tzClockRAF = null; }
}
function _resumeAllRAF() {
  _orreryLastFrame = performance.now();  // prevent time-jump after tab was hidden
  if (typeof _orreryAnimate === 'function') _orreryAnimate();
  if (_activeSkyLoop) _almanacSkyRAF = requestAnimationFrame(_activeSkyLoop);
  if (typeof _startTzClock === 'function') _startTzClock();
}
// Pause all animation loops when tab is backgrounded
document.addEventListener('visibilitychange', function() {
  if (!_almanacOpen) return;
  if (document.hidden) {
    _cancelAllRAF();
  } else {
    _resumeAllRAF();
  }
});

// When an in-almanac deep link opens an article, we suspend the almanac (hide
// it so the reader shows) but KEEP its #almanac history entry, and stash the
// scroll offset here so Back — browser or in-app — returns to the same spot.
// null means "the open reader did not originate in the almanac".
var _almReturnScroll = null;

function _openAlmanacInner(replaceState) {
  _almanacOpen = true;
  document.body.classList.add('almanac-mode');
  // The reload-into-almanac boot gate (stamped by the head bootstrap before
  // first paint) has done its job once the real almanac chrome is up.
  document.documentElement.classList.remove('almanac-boot');
  var url = location.pathname + location.search + '#almanac';
  if (replaceState) history.replaceState({ mode: 'almanac' }, '', url);
  else history.pushState({ mode: 'almanac' }, '', url);
  var el = document.getElementById('almanac-view');
  el.classList.add('open');
  // Deep-links: fresh library check per open, and one delegated tap handler.
  if (window.AlmanacLinks) { window.AlmanacLinks.reset(); window.AlmanacLinks.bind(el); }
  var mv = document.getElementById('main-view');
  if (mv) mv.classList.add('hidden');
  _setWindowTitle('Almanac');
  // Integrate with topbar like manage view
  if (typeof updateTopbar === 'function') updateTopbar();
  var qEl = document.getElementById('q');
  if (qEl) qEl.placeholder = t('almanac');
  _renderAlmanacContent();
}

// Shared visual/animation teardown for leaving the almanac. Does NOT touch
// history — the caller decides whether to strip the #almanac entry (a real
// close) or preserve it (a deep-link suspend that Back should return to).
function _almanacTeardown() {
  _almanacOpen = false;
  document.body.classList.remove('almanac-mode');
  if (typeof _almTravelUnfreeze === 'function') _almTravelUnfreeze();
  _cancelAllRAF();
  _activeSkyLoop = null;
  _almSelectedTz = null;
  // Reset orrery state
  _orreryPlaying = true;
  _orrerySpeed = 100000;
  _orreryAutoTransit = false;
  _orreryTimeOffset = 0;
  _orreryRockets = [];
  document.getElementById('almanac-view').classList.remove('open');
  var mv = document.getElementById('main-view');
  if (mv) mv.classList.remove('hidden');
  _setWindowTitle('Zimi');
  if (typeof updateTopbar === 'function') updateTopbar();
  var qEl = document.getElementById('q');
  if (qEl) qEl.placeholder = t('search_placeholder');
}

function closeAlmanac() {
  if (!_almanacOpen) return;
  _almReturnScroll = null; // an explicit close cancels any pending return
  _almanacTeardown();
  // Remove #almanac hash without adding history entry
  if (location.hash === '#almanac') {
    history.replaceState(history.state, '', location.pathname + location.search);
  }
}

// Suspend the almanac to open a deep-linked article: tear down the visuals but
// leave the #almanac history entry intact so a Back returns here. Returns the
// scroll offset to restore on return (the caller stamps it into _almReturnScroll
// AFTER openArticle, since openArticle clears the flag for normal opens).
function _suspendAlmanacForLink() {
  var content = document.getElementById('almanac-content');
  var sc = content ? content.scrollTop : 0;
  if (_almanacOpen) _almanacTeardown();
  return sc;
}

// Reopen the almanac after a Back from a deep-linked article and restore the
// scroll offset. The current history entry is already the #almanac one, so we
// reuse it (replaceState) rather than pushing a new one.
function _reopenAlmanacFromLink() {
  var target = _almReturnScroll;
  _almReturnScroll = null;
  _openAlmanacInner(true);
  if (!target) return;
  var content = document.getElementById('almanac-content');
  if (!content) return;
  // The drift bug: a fixed-delay restore could fire while the content was still
  // short (canvases sizing, images decoding), so scrollTop clamped to a smaller
  // maxScroll and landed a few pixels above the saved spot — and each round trip
  // re-saved that drifted value. Instead, re-assert the offset every frame the
  // content height is still changing, then once more when it settles. Bounded to
  // ~1s so it never fights a later user scroll.
  content.scrollTop = target;
  var lastH = -1, stableFrames = 0, frames = 0;
  (function settle() {
    var h = content.scrollHeight;
    if (h !== lastH) { lastH = h; stableFrames = 0; content.scrollTop = target; }
    else { stableFrames++; }
    if (++frames < 60 && stableFrames < 4) requestAnimationFrame(settle);
    else content.scrollTop = target; // final assert once the height has settled
  })();
}

// ── Timezone formatting ──
// Cached per lang|tz: the travel clock reads this every frame, and the name
// was always computed from NOW (not the focused instant), so within a session
// it is constant. (A session running across a live DST switch would keep the
// pre-switch abbreviation until reload — an acceptable trade for dropping a
// formatter construction + formatToParts from the per-frame path.)
var _formatTzCache = {};
function _formatTimezone(lang, tz) {
  var loc = lang || ((typeof _currentLang !== 'undefined') ? _currentLang : 'en');
  var key = loc + '|' + (tz || '');
  if (key in _formatTzCache) return _formatTzCache[key];
  var name = '';
  try {
    // Locale-aware short zone name (e.g. "PST"). An explicit tz names the
    // shown location's zone, not the device's.
    var opts = { timeZoneName: 'short' };
    if (tz) opts.timeZone = tz;
    var fmt = new Intl.DateTimeFormat(loc, opts);
    var parts = fmt.formatToParts(new Date());
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'timeZoneName') { name = parts[i].value; break; }
    }
  } catch(e) { name = ''; }
  _formatTzCache[key] = name;
  return name;
}

// Curated offline "on this day" feed — space & science milestones, keyed by
// "MM-DD" (1-based month, zero-padded). Purely static data so it works forever
// with no network. Kept deliberately tight: iconic, verifiable events only.
var _ON_THIS_DAY = {
  '01-01': [{ y: 1801, t: 'Giuseppe Piazzi discovers Ceres from Palermo — the first asteroid, now a dwarf planet.', w: 'ev:ceres' }],
  '01-02': [{ y: 1959, t: 'The Soviet Luna 1 becomes the first spacecraft to escape Earth’s gravity.', w: 'ev:luna1' }],
  '01-03': [{ y: 2019, t: 'China’s Chang’e 4 makes the first-ever soft landing on the Moon’s far side.', w: 'ev:change4' }],
  '01-04': [{ y: 1643, t: 'Isaac Newton is born in Lincolnshire (New Style calendar).', w: 'ev:newton' }],
  '01-05': [{ y: 2005, t: 'Eris is discovered — the find that got Pluto reclassified as a dwarf planet.', w: 'ev:eris' }],
  '01-07': [{ y: 1610, t: 'Galileo sees four points of light beside Jupiter — the first moons found around another planet.', w: 'ev:jupiter' }],
  '01-14': [{ y: 2005, t: 'ESA’s Huygens probe lands on Titan, the most distant landing ever made.', w: 'ev:titan' }],
  '01-23': [{ y: 1907, t: 'Hideki Yukawa is born in Tokyo; he predicted the meson and won Japan’s first Nobel Prize.', w: 'ev:yukawa' }],
  '01-28': [{ y: 1986, t: 'Space Shuttle Challenger breaks apart 73 seconds after launch, killing all seven crew.', w: 'ev:challenger' }],
  '01-31': [{ y: 1958, t: 'Explorer 1 launches and discovers the Van Allen radiation belts.', w: 'ev:explorer1' }],
  '02-07': [{ y: 1984, t: 'Bruce McCandless makes the first untethered spacewalk, flying free on a jetpack.', w: 'ev:mccandless' }],
  '02-08': [{ y: 1834, t: 'Dmitri Mendeleev is born; his periodic table predicted elements nobody had found yet.', w: 'ev:mendeleev' },
             { y: 1865, t: 'Gregor Mendel presents his pea-plant experiments, founding genetics.', w: 'ev:mendel' }],
  '02-11': [{ y: 2016, t: 'LIGO announces the first direct detection of gravitational waves, from two merging black holes.', w: 'ev:ligo' }],
  '02-12': [{ y: 1809, t: 'Charles Darwin is born.', w: 'ev:darwin' }],
  '02-14': [{ y: 1990, t: 'Voyager 1 turns around and photographs Earth as a pale blue dot, 6 billion km away.', w: 'ev:voyager1' }],
  '02-15': [{ y: 1564, t: 'Galileo Galilei is born in Pisa.', w: 'ev:galileogalilei' }],
  '02-18': [{ y: 1930, t: 'Clyde Tombaugh discovers Pluto.', w: 'ev:pluto' }],
  '02-19': [{ y: 1473, t: 'Nicolaus Copernicus is born in Toruń — he moved the Sun to the centre.', w: 'ev:copernicus' }],
  '02-20': [{ y: 1986, t: 'The Soviet Union launches the core of Mir, humanity’s home in orbit for 15 years.' }],
  '02-24': [{ y: 1968, t: 'Jocelyn Bell Burnell’s discovery of pulsars is announced.', w: 'ev:bellburnell' }],
  '03-13': [{ y: 1781, t: 'William Herschel discovers Uranus — the first planet found with a telescope.', w: 'ev:uranus' }],
  '03-14': [{ y: 1879, t: 'Albert Einstein is born in Ulm.', w: 'ev:einstein' }, { y: 2018, t: 'Stephen Hawking dies.', w: 'ev:hawking' }],
  '03-16': [{ y: 1926, t: 'Robert Goddard launches the first liquid-fuelled rocket.', w: 'ev:goddard' }],
  '03-18': [{ y: 1965, t: 'Alexei Leonov leaves his capsule for 12 minutes — the first spacewalk.', w: 'ev:leonov' }],
  '03-23': [{ y: 1882, t: 'Emmy Noether is born; her theorem ties every symmetry in physics to a conservation law.', w: 'ev:noether' },
             { y: 2001, t: 'Mir is guided to a controlled fiery end over the Pacific.' }],
  '04-12': [{ y: 1961, t: 'Yuri Gagarin orbits the Earth — the first human in space.', w: 'ev:gagarin' },
             { y: 1981, t: 'The first Space Shuttle, Columbia, launches.', w: 'ev:columbia' }],
  '04-13': [{ y: 1970, t: 'An oxygen tank explodes aboard Apollo 13; the crew improvise their way home.', w: 'ev:apollo13' }],
  '04-19': [{ y: 1971, t: 'The Soviet Union launches Salyut 1, the first space station.', w: 'ev:salyut1' }],
  '04-24': [{ y: 1990, t: 'The Hubble Space Telescope launches aboard Discovery.', w: 'ev:hubble' }],
  '04-25': [{ y: 1953, t: 'Watson and Crick publish DNA’s double helix, built on Rosalind Franklin’s X-ray images.', w: 'ev:franklin' }],
  '05-05': [{ y: 1961, t: 'Alan Shepard makes a 15-minute suborbital hop, the first American in space.', w: 'ev:shepard' }],
  '05-08': [{ y: 1980, t: 'The WHO declares smallpox eradicated — the only human disease ever wiped out.', w: 'ev:smallpox' }],
  '05-12': [{ y: 1910, t: 'Dorothy Hodgkin is born; she mapped penicillin, vitamin B12 and insulin by X-ray.', w: 'ev:hodgkin' }],
  '05-14': [{ y: 1796, t: 'Edward Jenner performs the first vaccination, against smallpox.', w: 'ev:jenner' },
             { y: 2021, t: 'China’s Zhurong rover lands on Mars.', w: 'ev:zhurong' }],
  '05-25': [{ y: 1961, t: 'JFK challenges the U.S. to land a man on the Moon before the decade is out.', w: 'ev:jfk' }],
  '05-30': [{ y: 1975, t: 'The European Space Agency is founded, pooling the continent’s space programmes.', w: 'ev:esa' }],
  '06-13': [{ y: 2010, t: 'Japan’s Hayabusa returns the first samples ever collected from an asteroid.', w: 'ev:hayabusa' }],
  '06-16': [{ y: 1963, t: 'Valentina Tereshkova becomes the first woman in space, alone for three days.', w: 'ev:tereshkova' }],
  '06-18': [{ y: 1983, t: 'Sally Ride becomes the first American woman in space.', w: 'ev:sallyride' }],
  '06-23': [{ y: 1912, t: 'Alan Turing is born; he defined what a computer is before one existed.', w: 'ev:turing' }],
  '06-26': [{ y: 2000, t: 'The first draft of the human genome is announced.', w: 'ev:genome' }],
  '06-30': [{ y: 1908, t: 'A meteor explodes over Tunguska, Siberia, flattening 2,000 km² of forest.', w: 'ev:tunguska' }],
  '07-04': [{ y: 1997, t: 'Mars Pathfinder lands, delivering Sojourner — the first rover on another planet.', w: 'ev:pathfinder' },
             { y: 2012, t: 'CERN announces the discovery of the Higgs boson.', w: 'ev:higgs' }],
  '07-14': [{ y: 2015, t: 'New Horizons flies past Pluto, revealing its heart-shaped plain.', w: 'ev:newhorizons' }],
  '07-15': [{ y: 1965, t: 'Mariner 4 sends back the first close-up photographs of Mars.', w: 'ev:mariner4' }],
  '07-16': [{ y: 1969, t: 'Apollo 11 launches from Kennedy Space Center.', w: 'ev:apollo11' }],
  '07-17': [{ y: 1894, t: 'Georges Lemaître is born in Belgium; the priest-physicist who proposed the expanding universe.', w: 'ev:lemaitre' },
             { y: 1975, t: 'Apollo and Soyuz dock in orbit — Cold War rivals shaking hands in space.' }],
  '07-18': [{ y: 1921, t: 'John Glenn, first American to orbit Earth, is born.', w: 'ev:glenn' }],
  '07-20': [{ y: 1969, t: 'Apollo 11 lands on the Moon; Armstrong and Aldrin walk its surface.', w: 'ev:apollo11' },
             { y: 1976, t: 'Viking 1 makes the first successful landing on Mars.', w: 'ev:viking1' }],
  '07-23': [{ y: 1995, t: 'Comet Hale–Bopp is discovered; it would dazzle the sky for 18 months.', w: 'ev:halebopp' }],
  '08-06': [{ y: 2012, t: 'NASA’s Curiosity rover lands in Gale Crater on Mars.', w: 'ev:curiosity' },
             { y: 2014, t: 'ESA’s Rosetta arrives at comet 67P after a ten-year chase.', w: 'ev:rosetta' }],
  '08-12': [{ y: 1877, t: 'Asaph Hall discovers Mars’ moon Deimos; Phobos follows six days later.', w: 'ev:deimos' }],
  '08-23': [{ y: 2023, t: 'India’s Chandrayaan-3 lands near the lunar south pole, a first for any nation.', w: 'ev:chandrayaan3' }],
  '08-25': [{ y: 1989, t: 'Voyager 2 flies past Neptune — humanity’s first and only close visit.', w: 'ev:voyager2' },
             { y: 2012, t: 'Voyager 1 becomes the first spacecraft to enter interstellar space.', w: 'ev:voyager1' }],
  '09-05': [{ y: 1977, t: 'Voyager 1 launches, carrying the Golden Record.', w: 'ev:goldenrecord' }],
  '09-10': [{ y: 2008, t: 'The Large Hadron Collider circulates its first beam beneath the Swiss–French border.', w: 'ev:lhc' }],
  '09-12': [{ y: 1959, t: 'Luna 2 launches; two days later it becomes the first craft to reach the Moon’s surface.', w: 'ev:luna2' }],
  '09-21': [{ y: 2003, t: 'Galileo is deliberately crashed into Jupiter, ending a 14-year mission.', w: 'ev:galileoprobe' }],
  '09-23': [{ y: 1846, t: 'Neptune is found within a degree of where Le Verrier’s maths said it would be.', w: 'ev:neptune' }],
  '09-24': [{ y: 2014, t: 'India’s Mangalyaan reaches Mars orbit on its first attempt, for under $75 million.', w: 'ev:mangalyaan' }],
  '09-28': [{ y: 1928, t: 'Alexander Fleming notices mould killing bacteria on a forgotten dish — penicillin.', w: 'ev:fleming' }],
  '10-04': [{ y: 1957, t: 'The Soviet Union launches Sputnik 1; the Space Age begins with a beep.', w: 'ev:sputnik1' }],
  '10-06': [{ y: 1995, t: 'Michel Mayor and Didier Queloz announce 51 Pegasi b, the first exoplanet at a Sun-like star.', w: 'ev:pegasi' }],
  '10-07': [{ y: 1959, t: 'Luna 3 sends back the first photographs of the Moon’s far side.', w: 'ev:luna3' }],
  '10-15': [{ y: 1997, t: 'Cassini launches on its journey to Saturn.', w: 'ev:cassini' },
             { y: 2003, t: 'Yang Liwei orbits Earth aboard Shenzhou 5 — China’s first human spaceflight.', w: 'ev:shenzhou5' }],
  '10-19': [{ y: 1910, t: 'Subrahmanyan Chandrasekhar is born in Lahore; he found the mass limit that makes black holes.', w: 'ev:chandrasekhar' }],
  '11-02': [{ y: 2000, t: 'The first crew moves into the ISS; humans have lived off Earth ever since.', w: 'ev:iss' }],
  '11-03': [{ y: 1957, t: 'Laika launches aboard Sputnik 2, the first living creature to orbit Earth.', w: 'ev:laika' }],
  '11-07': [{ y: 1867, t: 'Marie Skłodowska-Curie is born in Warsaw; still the only person to win Nobels in two sciences.', w: 'ev:curie_pl' }],
  '11-08': [{ y: 1656, t: 'Edmond Halley is born; he predicted a comet’s return and it kept the appointment.', w: 'ev:halley' },
             { y: 1895, t: 'Wilhelm Röntgen discovers X-rays and photographs his wife’s hand.', w: 'ev:rontgen' }],
  '11-09': [{ y: 1934, t: 'Carl Sagan is born.', w: 'ev:sagan' }],
  '11-12': [{ y: 2014, t: 'ESA’s Philae makes the first-ever soft landing on a comet.', w: 'ev:philae' }],
  '11-20': [{ y: 1998, t: 'Zarya, the first module of the International Space Station, launches from Kazakhstan.', w: 'ev:iss_full' }],
  '11-26': [{ y: 2011, t: 'The Curiosity rover launches toward Mars.', w: 'ev:curiosity' }],
  '12-06': [{ y: 2020, t: 'Japan’s Hayabusa2 drops a capsule of asteroid Ryugu into the Australian outback.', w: 'ev:hayabusa2' }],
  '12-10': [{ y: 1903, t: 'Marie Curie shares the Nobel Prize in Physics — the first awarded to a woman.', w: 'ev:curie' }],
  '12-14': [{ y: 1972, t: 'Apollo 17’s crew leave the Moon — the last humans to walk there, so far.', w: 'ev:apollo17' }],
  '12-15': [{ y: 1970, t: 'Venera 7 transmits from the surface of Venus, the first data from another planet.', w: 'ev:venera7' }],
  '12-17': [{ y: 1903, t: 'The Wright brothers fly for 12 seconds at Kitty Hawk.', w: 'ev:wright' }],
  '12-21': [{ y: 1968, t: 'Apollo 8 launches, carrying the first humans to orbit the Moon.', w: 'ev:apollo8' }],
  '12-22': [{ y: 1887, t: 'Srinivasa Ramanujan is born in Erode, India — self-taught, and still ahead of us.', w: 'ev:ramanujan' }],
  '12-24': [{ y: 1979, t: 'Europe’s first Ariane rocket lifts off from French Guiana.' }],
  '12-25': [{ y: 1642, t: 'Isaac Newton is born (Old Style calendar).', w: 'ev:newton' },
             { y: 2021, t: 'The James Webb Space Telescope launches from French Guiana.', w: 'ev:jwst' }],
  '12-27': [{ y: 1571, t: 'Johannes Kepler is born; he replaced circles with ellipses.', w: 'ev:kepler' },
             { y: 1831, t: 'Darwin sets sail on HMS Beagle.', w: 'ev:beagle' }]
};

// Return today's curated space/science events (array of {y, t}), or [] if none.
function _onThisDay(date) {
  var mm = ('0' + (date.getMonth() + 1)).slice(-2);
  var dd = ('0' + date.getDate()).slice(-2);
  return _ON_THIS_DAY[mm + '-' + dd] || [];
}

// Which principal phase (if any) falls on a given calendar day, or null.
// Marking only the four turning points keeps the month readable: a glyph on
// every day is visual noise, since consecutive days differ by only ~12°.
var _PRINCIPAL_PHASES = [
  { p: 0,    name: 'New Moon' },
  { p: 0.25, name: 'First Quarter' },
  { p: 0.5,  name: 'Full Moon' },
  { p: 0.75, name: 'Last Quarter' }
];

function _principalPhaseOnDay(cellJDN) {
  var noon = (cellJDN - 2440587.5) * 86400000 + 43200000;
  var p0 = _moonPhase(new Date(noon - 43200000)).phase; // day start
  var p1 = _moonPhase(new Date(noon + 43200000)).phase; // day end
  for (var i = 0; i < _PRINCIPAL_PHASES.length; i++) {
    var tg = _PRINCIPAL_PHASES[i].p;
    // The cycle wraps 1 -> 0, so a new moon shows up as p0 > p1.
    var hit = (p0 <= p1) ? (p0 <= tg && tg < p1) : (tg >= p0 || tg < p1);
    if (hit) return _PRINCIPAL_PHASES[i];
  }
  return null;
}

// The moment the header describes. null = live "now"; set by picking a day on
// the calendar. It's a full instant (not just a date) so a time-of-day picker
// can drive the same path later.
var _almFocus = null;
// The focus instant the hero moon last rendered at, so a jump can sweep from
// it. Seeded to "now" when the almanac first renders.
var _almPrevFocusTime = null;
function _almFocusInstant() { return _almFocus || new Date(); }
function _almIsToday(d) {
  var n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// Date, time and timezone strings for the hero header at a given instant,
// plus the resolved location/zone the moon and sun cards reuse. One source of
// truth so the full header render and the lightweight scrub updater
// (_almScrubClock) read time identically.
//
// The header clock always reads the VIEWER's own local time, travelling or
// not. A stored almanac location drives the sky/sun math, but its derived zone
// must never drive this clock: a stale or wrong-hemisphere stored location
// (e.g. a western longitude persisted with the wrong sign) resolves to a
// far-eastern zone and paints tomorrow morning onto today's sky.
//
// It must not switch zones on travel either, which it used to. The rest of the
// instrument reads the focus instant in device-local fields -- the time
// machine's readout via _almTmParts, the calendar grid via
// _almSyncSelectedToFocus, the destination chooser via _almMakeInstant, which
// is also what makes a typed destination round-trip unchanged. A header on the
// location's zone therefore disagreed with all three, by a whole day within a
// zone-offset of midnight: pick 23:50 from Los Angeles with Tokyo stored and
// the grid highlights the 22nd while the header reads the 23rd. One zone for
// the whole instrument, and it is the device's.
function _almClockParts(focus) {
  var loc = _getLocation();
  var locTz = null;
  try { locTz = _almDisplayTz(loc); } catch (e) {}
  var live = _almIsToday(focus);
  var displayTz = _almDeviceTz() || locTz;
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  // Cached formatters (_tzFmt), not toLocale*String: this runs on every travel
  // frame, and each toLocale* call builds a fresh Intl.DateTimeFormat.
  return {
    loc: loc, locTz: locTz, lang: lang, live: live,
    date: _tzFmt(displayTz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(focus),
    time: _tzFmt(displayTz, { hour: 'numeric', minute: '2-digit' }).format(focus),
    tz: _formatTimezone(lang, displayTz)
  };
}

// Header, hero moon and the eight pills for a given instant. Re-rendered in
// place when a calendar day is picked, so there's one set of numbers on the
// page rather than a duplicate panel lower down.
function _almHeadHtml(focus) {
  var m = _moonPhase(focus);
  var dist = _moonDistance(focus);
  var age = (m.phase * 29.53).toFixed(1);

  var cp = _almClockParts(focus);
  var loc = cp.loc, locTz = cp.locTz, lang = cp.lang;

  // Both the big date and the time beneath it summon the time machine — the
  // heading is the almanac's clearest "this is the moment shown" surface, so
  // tapping it is the discoverable way into changing that moment. Shared
  // attributes built once (DRY): only the id and content differ.
  var tmTap = ' class="alm-head-tap" role="button" tabindex="0" onclick="_almTmShow()"' +
    ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();_almTmShow();}"' +
    ' title="' + _almEsc(t('alm_tm_open')) + '" aria-label="' + _almEsc(t('alm_tm_open')) + '"';
  var html = '<div style="text-align:center;margin-bottom:16px">';
  // No inline color: it would outrank .alm-head-tap:hover's amber. The body
  // text color is var(--text) already.
  html += '<div id="almanac-head-date"' + tmTap + ' style="font-size:22px;font-weight:600">' + cp.date + '</div>';
  html += '<div style="font-size:16px;color:var(--text2);margin-top:4px"><span id="almanac-head-time"' + tmTap + '>' + cp.time + '</span>' + (cp.tz ? ' &middot; ' + cp.tz : '') +
    (cp.live ? '' : ' <button class="alm-sc-reset" onclick="_almBackToToday()">' + _almEsc(t('alm_today')) + '</button>') + '</div>';
  html += '</div>';

  // Hero moon — tilted so the bright limb faces the Sun as the observer sees
  // it (see _heroMoonTiltDeg for the sign derivation).
  var moonTilt = _heroMoonTiltDeg(focus, loc);
  html += '<div class="almanac-hero">';
  html += _renderAlmanacMoon(m, moonTilt);
  // The name sits in its own span inside the deep-link wrapper so travel can
  // rewrite the text without tearing out the encyclopedia link around it.
  html += '<div class="almanac-moon-name">' + _lterm('lunar_phase', '<span id="alm-hc-phase">' + _localMoonName(m.name) + '</span>') + '</div>';
  html += '</div>';

  // Sun cards render in the LOCATION's timezone, not the header clock's: a
  // sunrise is a fact about a place, and reading "sunrise 8:07 PM" because the
  // viewer's own zone was applied to somewhere else's sky helps nobody. The two
  // only differ once a location has actually been chosen (_almDisplayTz falls
  // back to the device zone otherwise), and the header states its zone.
  var _locTzOff;
  try { _locTzOff = _tzUtcOffsetMin(locTz, focus); }
  catch (e) { _locTzOff = -focus.getTimezoneOffset(); }
  var sunInfo0 = _computeSunTimes(focus, loc.lat, loc.lon, _locTzOff);

  var _nfm = _nextFullMoon(focus);

  html += '<div class="alm-cards">';
  html += _almHeadCard(t('alm_illuminated'), m.illumination + '%', 'alm-hc-illum');
  html += _almHeadCard(t('alm_moon_age'), age + ' ' + t('alm_days'), 'alm-hc-age');
  html += _almHeadCard(t('alm_distance'), _almFmtNum(Math.round(dist)) + ' ' + t('alm_km'), 'alm-hc-dist');
  html += _almHeadCard(t('alm_next_full'), _almNextFullHtml(_nfm, lang, focus), 'alm-hc-nextfull',
    { cardId: 'alm-hc-nextfull-card', hidden: !_nfm, valClass: _nfm && _nfm.isSuper ? 'alm-card-super' : '' });
  // Both faces of the sun row live in the DOM at once and only their `hidden`
  // flags move. Travel crosses into and out of a polar day mid-scrub, and
  // flipping a flag is something the per-frame updater can do; rebuilding the
  // card grid is not, so the alternative was a stale row contradicting the
  // date beside it.
  html += _almHeadCard('', sunInfo0.polar || '', 'alm-hc-polar',
    { cardId: 'alm-hc-polar-card', span: 4, hidden: !sunInfo0.polar });
  html += _almHeadCard(t('alm_sunrise'), sunInfo0.sunrise || '', 'alm-hc-sunrise',
    { cardId: 'alm-hc-sunrise-card', hidden: !!sunInfo0.polar });
  html += _almHeadCard(t('alm_sunset'), sunInfo0.sunset || '', 'alm-hc-sunset',
    { cardId: 'alm-hc-sunset-card', hidden: !!sunInfo0.polar });
  html += _almHeadCard(t('alm_daylight'), sunInfo0.dayLength || '', 'alm-hc-daylight',
    { cardId: 'alm-hc-daylight-card', hidden: !!sunInfo0.polar });
  html += _almHeadCard(_lterm('golden_hour', t('alm_golden')), sunInfo0.goldenHour || '', 'alm-hc-golden',
    { cardId: 'alm-hc-golden-card', hidden: !sunInfo0.goldenHour, valClass: 'alm-card-golden' });
  html += '</div>';
  return html;
}

// One card in the hero readout grid. Every value node carries an id so the
// per-frame travel updater can rewrite it in place instead of the whole grid.
// opts: cardId (id on the card, for hiding it), span (grid columns), hidden,
// valClass (colour variant).
function _almHeadCard(lbl, valHtml, valId, opts) {
  opts = opts || {};
  return '<div class="alm-card"' + (opts.cardId ? ' id="' + opts.cardId + '"' : '') +
    (opts.span ? ' style="grid-column:span ' + opts.span + '"' : '') +
    (opts.hidden ? ' hidden' : '') + '>' +
    (lbl ? '<div class="alm-card-lbl">' + lbl + '</div>' : '') +
    '<div class="alm-card-val' + (opts.valClass ? ' ' + opts.valClass : '') + '" id="' + valId + '">' +
    valHtml + '</div></div>';
}

// Value markup for the next-full-moon card, shared by the full render and the
// throttled travel refresh so the two can never disagree on format. The year
// shows only when the full moon falls outside the focused year: a bare "Aug 27"
// is unambiguous beside a header reading 2026 and meaningless beside one
// reading 2183, and the card is a quarter of the grid wide.
function _almNextFullHtml(nfm, lang, focus) {
  if (!nfm) return '';
  var opts = { month: 'short', day: 'numeric' };
  if (nfm.date.getFullYear() !== focus.getFullYear()) opts.year = 'numeric';
  return nfm.date.toLocaleDateString(lang, opts) +
    (nfm.isSuper ? ' \u00b7 ' + _lterm('supermoon', t('alm_supermoon')) : '');
}

// Render one panel resiliently. Travel now reaches arbitrary epochs, where a
// given panel's math can go non-finite or throw (a lunisolar conversion, the
// sun-map terminator, a meteor table). Catch it, drop a quiet "beyond range"
// note into that panel's container, and let the rest — crucially the sky,
// orrery and deep-time — carry on. One panel must never abort the repaint.
function _almSafePanel(fn, containerId) {
  try { fn(); }
  catch (e) {
    if (window.console && console.warn) console.warn('almanac: panel skipped at this epoch —', e && e.message);
    if (containerId) {
      var el = document.getElementById(containerId);
      if (el) el.innerHTML = '<div class="alm-beyond">' + _tLookup('alm_tm_beyond_range', "Beyond this calendar's range") + '</div>';
    }
  }
}

// Repaint every panel that describes a moment, in place, for the focused
// instant. Two things deliberately stay out of it: the world clock (it is a
// clock — it should always read now) and the orrery, which carries its own
// date and speed and operates on a completely different time scale.
function _almRepaintFocus() {
  var focus = _almFocusInstant();
  var loc = _getLocation();
  // Every settle path lands here, so this is where live travel ends: drop the
  // scrub overlay before the header is rebuilt, leaving _almHeroMoonSweep free
  // to open a fresh one for the arrival sweep.
  _heroMoonTravelEnd();
  var m;
  try { m = _moonPhase(focus); } catch (e) { m = null; }
  var head = document.getElementById('almanac-head');
  if (head) {
    // Sweep the hero moon from the previous focus to this one (real phases +
    // continuous rotation) after the header rebuilds to the destination.
    var fromTime = (_almPrevFocusTime != null) ? _almPrevFocusTime : focus.getTime();
    _almSafePanel(function () { head.innerHTML = _almHeadHtml(focus); }, 'almanac-head');
    if (!_almReduceMotion()) _almHeroMoonSweep(head, fromTime, focus.getTime(), loc);
  }
  _almPrevFocusTime = focus.getTime();
  _almSafePanel(function () { _renderSunMap(focus); }, 'almanac-sunmap');
  // _renderSunMap re-seeds the world-clock grid off the date it's handed. That
  // grid is a *clock* — it must keep reading now, not the focused instant.
  _initTzClock(new Date());
  _almSafePanel(function () { _renderOnThisDay(focus); }, 'almanac-onthisday');
  _almSafePanel(function () { _renderTonightSky(focus); }, 'almanac-tonight');
  _almSafePanel(function () { _renderStarChart(focus); }, null);
  _almSafePanel(function () { _renderAnalemma(focus); }, null);
  _almSafePanel(function () { _renderAstroPanel(focus); }, 'almanac-astro');
  _almSafePanel(function () { _renderMeteorShowers(focus, m); }, 'almanac-meteors');
  _almSafePanel(function () { _renderCelestialEvents(focus); }, 'almanac-events');
  _almSafePanel(function () { _renderDeepTime(focus); }, 'almanac-deeptime');
  // Re-seeding the sky scene cancels the previous RAF, so loops don't stack.
  // animateMoon=true: this repaint always follows a focus-time change (scrub
  // settle, wheel/key step, "Go", Back to Now) -- let the moon glide onward
  // from wherever it currently is rather than snapping to the settled value.
  _almSafePanel(function () { _initSkyScene(focus, loc.lat, loc.lon, !_almReduceMotion()); }, null);
}

function _almBackToToday() {
  // Reachable mid-hold via the Home key: make sure no height pin outlives it.
  _almTravelUnfreeze();
  _almFocus = null;
  _almSelectedJDN = _almTodayJDN;
  // Snap the browsed month back to the present too — otherwise the grid is
  // left stranded on whatever month you'd wandered to while the rest of the
  // panel returns to now.
  var cal = _jdnToCalendar(_almSystem, _almTodayJDN);
  _almYear = cal.year;
  _almMonth = cal.month;
  _drawAlmanacGrid();
  _almRepaintFocus();
  _almTmMode('rest');
  _almTmSync();
}

// == Time machine — the almanac's skeuomorphic time-travel instrument ========
// Replaces the old velocity scrubber + flux panel. Two faces on one object:
//   REST   — three LED time circuits: DISPLAYED (warm white, what every panel
//            is rendering), DESTINATION (amber, tap its segments to edit the
//            time in place), ACTUAL (dimmed, ticks).
//   MOTION — while the side lever is thrown, the panel collapses to one large
//            readout of the moving position. Landing (the settle) flips it
//            back to the three rows on its own.
// The lever is a *displacement* control: distance from neutral sets a
// directional speed (nonlinear — minutes/sec near the middle, centuries/sec at
// the ends), springing back to neutral on release. All the time-state
// machinery of the old scrubber survives (_almFocus, _almScrubSettle,
// _almRepaintFocus, and the rAF-throttled _skySetInstant redraw at ~0.21ms/
// frame); only the *input* and *chrome* changed.

// Year range. The astronomy stays finite across an enormous span (Julian-day
// polynomials for the sky/sun/moon/deep-time, integer-JDN calendar
// conversions), so travel is clamped only where JS Date itself fails:
// getTime() saturates near ±8.64e15 ms (~±273,785 yr). We stay well inside.
var _ALM_YEAR_MIN = -270000;
var _ALM_YEAR_MAX = 270000;
// Beyond this window the Meeus polynomials the sky/deep-time use lose real
// meaning (they stay finite, just inaccurate) and lunisolar calendar
// conversions drift — panels flag it quietly rather than pretending precision.
var _ALM_PRECISE_SPAN = 13000;         // yr either side of J2000

// Lever speed curve, in simulated-ms advanced per real-ms of hold. Exponential
// so a single throw spans ~2 sim-minutes/sec (fine scrubbing within a day) up
// to ~300 sim-years/sec at the end stops.
var _TM_DEADZONE = 0.06;               // lever slack around neutral — no drift
var _TM_RATE_MIN = 120;                // ~2 simulated minutes per real second
var _TM_RATE_MAX = 9.5e9;              // ~300 simulated years per real second
var _TM_SPRING_MS = 260;               // spring-back + decel-to-stop on release
var _SCRUB_WHEEL_STEP = 3600000;       // 1 hour per wheel notch / arrow key
var _SCRUB_PAGE_STEP = 86400000;       // 1 day per PageUp/PageDown
var _SCRUB_LIVE_EPS = 60000;           // within 1 min of now -> snap back to live

function _almReduceMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
}

// Build an instant from explicit parts. setFullYear (not the Date constructor)
// so years 0–99 and negative (BCE) years land on the real proleptic-Gregorian
// year instead of folding into 1900–1999.
function _almMakeInstant(y, mo, d, h, mi) {
  var dt = new Date(0);
  dt.setFullYear(y, mo - 1, d);
  dt.setHours(h, mi, 0, 0);
  return dt;
}

// Keep an instant inside the range where JS Date is valid; never return NaN.
function _almClampInstant(dt) {
  if (isNaN(dt.getTime())) return new Date();
  var y = dt.getFullYear();
  if (y < _ALM_YEAR_MIN) return _almMakeInstant(_ALM_YEAR_MIN, 1, 1, 0, 0);
  if (y > _ALM_YEAR_MAX) return _almMakeInstant(_ALM_YEAR_MAX, 12, 31, 23, 59);
  return dt;
}

function _almYearBeyondPrecise(y) { return Math.abs(y - 2000) > _ALM_PRECISE_SPAN; }

// Readout fields: MON DD YEAR HH:MM. Month abbreviation localized and
// upper-cased (any trailing locale dot dropped so it sits clean in its
// segment cell), day/time zero-padded, 24-hour. The year is the signed
// proleptic-Gregorian number (negative = BCE), matching the in-place edit
// field so it round-trips exactly. Split into parts because every readout on
// the instrument is a row of per-field LED segment cells, not one string.
var _ALM_TM_FIELDS = ['mon', 'day', 'year', 'hh', 'mi'];
function _almTmParts(d) {
  var mon;
  // Cached formatter (_tzFmt): the motion face re-renders this every frame.
  try { mon = _tzFmt(null, { month: 'short' }).format(d).toUpperCase().replace(/\./g, ''); }
  catch (e) { mon = ('0' + (d.getMonth() + 1)).slice(-2); }
  return {
    mon: mon,
    day: ('0' + d.getDate()).slice(-2),
    year: String(d.getFullYear()),
    hh: ('0' + d.getHours()).slice(-2),
    mi: ('0' + d.getMinutes()).slice(-2)
  };
}

// One LED readout: MON DD YYYY HH:MM as individual recessed segment cells,
// shared by all three circuit rows and the solo travelling face so no two
// readouts can disagree on format. `editable` adds the DESTINATION row's
// in-place inputs, hidden at rest and revealed by .alm-tm-editing with the
// exact geometry of the value they replace: identical view, click, type.
var _ALM_TM_FIELD_LBL = { mon: 'alm_tm_month', day: 'alm_tm_day', year: 'alm_tm_year', hh: 'alm_tm_hour', mi: 'alm_tm_min' };
function _almTmCellHtml(idBase, part, editable) {
  var h = '<span class="alm-tm-cell alm-tm-cell-' + part + '">' +
    '<span class="alm-tm-cval" id="' + idBase + '-' + part + '"></span>';
  if (editable) {
    h += '<input type="text" class="alm-tm-cin" id="alm-tm-in-' + part + '"' +
      (part === 'mon' ? '' : ' inputmode="numeric"') +
      ' autocomplete="off" spellcheck="false" aria-label="' + _almEsc(t(_ALM_TM_FIELD_LBL[part])) + '"' +
      (part === 'year' ? ' title="' + _almEsc(t('alm_tm_year_hint')) + '" oninput="_almTmYearGrew(this)"' : '') +
      ' onkeydown="_almTmEditKey(event, \'' + part + '\')" onfocus="this.select()">';
  }
  return h + '</span>';
}
function _almTmCellsHtml(idBase, editable) {
  return '<span class="alm-tm-cells">' +
    _almTmCellHtml(idBase, 'mon', editable) +
    _almTmCellHtml(idBase, 'day', editable) +
    _almTmCellHtml(idBase, 'year', editable) +
    '<span class="alm-tm-cell-group">' + _almTmCellHtml(idBase, 'hh', editable) +
    '<span class="alm-tm-colon" aria-hidden="true">:</span>' + _almTmCellHtml(idBase, 'mi', editable) + '</span>' +
    '</span>';
}
// Column headers over the primary readout — the one cue borrowed from the film's
// time circuits, where every digit group is labelled MONTH DAY YEAR above the
// lamps. Built from the very same cell classes as the readout, so the headers
// and the figures are one grid: retrack a column and its label moves with it.
// No AM/PM column, the instrument is 24-hour. The words reuse the five field
// labels that already name the edit inputs, so this adds no new strings in any
// locale. aria-hidden: each input already announces the same word as its own
// accessible name, and the readout is read as a whole date, so exposing these
// would make a screen reader say every field twice.
// The word sits in a CHILD of the cell, not in the cell. The column widths are
// in `ch` and `ch` is measured in the element's own font, so a header cell must
// keep the readout's face and size or it would size itself to its label and the
// header grid would come apart from the figures beneath it.
function _almTmColCapHtml(part) {
  return '<span class="alm-tm-cell alm-tm-cell-' + part + '">' +
    '<span class="alm-tm-colcap">' + _almEsc(t(_ALM_TM_FIELD_LBL[part])) + '</span></span>';
}
function _almTmColsHtml() {
  return '<div class="alm-tm-cols" aria-hidden="true"><span class="alm-tm-cells">' +
    _almTmColCapHtml('mon') + _almTmColCapHtml('day') + _almTmColCapHtml('year') +
    '<span class="alm-tm-cell-group">' + _almTmColCapHtml('hh') +
    // The colon rides along invisibly so HOUR and MIN sit over their own drums
    // rather than drifting by the colon's negative margins.
    '<span class="alm-tm-colon alm-tm-colon-ghost">:</span>' + _almTmColCapHtml('mi') +
    '</span></span></div>';
}

function _almTmSetCells(idBase, d) {
  var p = _almTmParts(d);
  for (var i = 0; i < _ALM_TM_FIELDS.length; i++) {
    var el = document.getElementById(idBase + '-' + _ALM_TM_FIELDS[i]);
    if (el) el.textContent = p[_ALM_TM_FIELDS[i]];
  }
  return p;
}

// -- Offset from the present ------------------------------------------------
// The instrument's one live quantity while travelling: how far the readout is
// from real now, in human terms ("+3 days", "-41 years 2 months", "+7 hours").
// Calendar-aware above a day so a year reads as a year rather than 365.2422 of
// them; clock arithmetic below one. At most two units, largest first, and the
// smaller unit is dropped when it is zero — that keeps the lamp short enough to
// share the legend line with the plate's stamped label at 320px.
var _ALM_MS_MIN = 60000;
var _ALM_MS_HOUR = 3600000;
var _ALM_TM_DELTA_UNITS = { y: 'alm_tm_dyear', mo: 'alm_tm_dmonth', d: 'alm_tm_dday', h: 'alm_tm_dhour', mi: 'alm_tm_dmin' };

// Whole calendar years/months/days between two local dates, `a` no later than
// `b`. Borrowing walks back through the real length of the month it lands in,
// so 31 Jan → 1 Mar is "1 month 1 day", not "1 month 4 days".
function _almTmYmdBetween(a, b) {
  var y = b.getFullYear() - a.getFullYear();
  var mo = b.getMonth() - a.getMonth();
  var d = b.getDate() - a.getDate();
  if (d < 0) {
    mo--;
    d += new Date(b.getFullYear(), b.getMonth(), 0).getDate();  // day 0 = last day of previous month
  }
  if (mo < 0) { y--; mo += 12; }
  return { y: y, mo: mo, d: d };
}

// The travelling face repaints this every animation frame, and tPlural builds
// a fresh Intl.PluralRules per call. The rendered string only changes when a
// whole unit does, so memoize on the unit tuple: at 60fps almost every frame is
// a cache hit, and a miss costs what one repaint used to.
var _almTmDeltaMemo = { key: null, text: '', lang: null };

function _almTmDeltaText(d, now) {
  var ms = d.getTime() - now.getTime();
  var abs = Math.abs(ms);
  if (abs < _ALM_MS_MIN) return '';                 // sitting on the present
  var sign = ms < 0 ? '-' : '+';    // ASCII, so it keeps the monospace advance
  var lo = ms < 0 ? d : now, hi = ms < 0 ? now : d;
  var c = _almTmYmdBetween(lo, hi);
  var u1, n1, u2 = null, n2 = 0;
  if (c.y > 0)            { u1 = 'y';  n1 = c.y;  u2 = 'mo'; n2 = c.mo; }
  else if (c.mo > 0)      { u1 = 'mo'; n1 = c.mo; u2 = 'd';  n2 = c.d; }
  else if (c.d > 0)       { u1 = 'd';  n1 = c.d; }
  else if (abs >= _ALM_MS_HOUR) { u1 = 'h';  n1 = Math.floor(abs / _ALM_MS_HOUR); }
  else                    { u1 = 'mi'; n1 = Math.round(abs / _ALM_MS_MIN); }
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var key = sign + u1 + n1 + (u2 && n2 > 0 ? '|' + u2 + n2 : '');
  if (_almTmDeltaMemo.key === key && _almTmDeltaMemo.lang === lang) return _almTmDeltaMemo.text;
  var out = sign + tPlural(_ALM_TM_DELTA_UNITS[u1], n1);
  if (u2 && n2 > 0) out += ' ' + tPlural(_ALM_TM_DELTA_UNITS[u2], n2);
  _almTmDeltaMemo = { key: key, text: out, lang: lang };
  return out;
}

// Paint one offset lamp. Empty text collapses the element (CSS :empty), so a
// readout parked on the present shows a clean plate.
function _almTmSetDelta(id, d) {
  var el = document.getElementById(id);
  if (!el) return;
  var txt = _almTmDeltaText(d, new Date());
  if (el.textContent !== txt) el.textContent = txt;   // no write, no invalidation
}

// Approximate rendered width of a segment value in ch: CJK and other wide
// glyphs occupy two monospace cells, everything else one.
function _almTmChLen(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) n += (s.charCodeAt(i) > 0x2e7f) ? 2 : 1;
  return n;
}

// Cached default-locale number formatter for the km distance readout — it is
// rewritten on every travel frame, and bare Number.toLocaleString builds a
// fresh Intl.NumberFormat per call.
var _almNumFmtCache = null;
function _almFmtNum(n) {
  if (!_almNumFmtCache) {
    try { _almNumFmtCache = new Intl.NumberFormat(); }
    catch (e) { _almNumFmtCache = { format: String }; }
  }
  return _almNumFmtCache.format(n);
}

// Lightweight per-frame clock update while stepping -- just the two hero text
// nodes, no header rebuild. (The moon disc and sun cards settle on release.)
function _almScrubClock(focus) {
  var cp = _almClockParts(focus);
  var d = document.getElementById('almanac-head-date');
  var tmEl = document.getElementById('almanac-head-time');
  if (d) d.textContent = cp.date;
  if (tmEl) tmEl.textContent = cp.time;
}

// Travel updates run in two tiers (the visuals-first rule, see _almTravelLive):
// canvases every frame, DOM text/layout at this cadence. 100ms nominal: the
// throttle fires on the first rAF after the interval elapses, so with frame
// quantization the worst observed gap stays under the ~150ms bound where a
// lagging readout still reads as "with" the visuals (measured max 152ms at
// 120ms nominal — the bound exactly, so one notch tighter). The settle repaint
// makes everything exact the moment motion stops. Leading-edge (first call in
// a quiet period fires immediately), so a single wheel notch or arrow key
// updates the text with no perceptible delay.
var _ALM_TRAVEL_DOM_MS = 100;
// The calendar grid gets its own, coarser cadence: _almSyncSelectedToFocus is
// a full month-grid innerHTML rebuild + style/layout/paint pass, and at full
// lever speed the day moves every DOM tick, so at 100ms it fired 10x/s.
// Measured in Playwright WebKit (warm, fast throw): grid on the 100ms tick =
// p95 52ms frames; grid disabled = p95 31ms. At 300ms the rebuild still flips
// months faster than the eye tracks them, and the settle repaint is exact.
var _ALM_TRAVEL_GRID_MS = 300;
var _almTravelThrottleAt = {};

function _almTravelThrottled(key, ms, fn) {
  var now = performance.now();
  if (now - (_almTravelThrottleAt[key] || 0) < ms) return;
  _almTravelThrottleAt[key] = now;
  fn();
}

// Refresh the next-full-moon card. _nextFullMoon walks up to 45 days an hour at
// a time (~0.3ms), several times the per-frame budget the sky redraw lives
// inside, so it rides the throttle.
function _almLiveNextFull(focus) {
  var card = document.getElementById('alm-hc-nextfull-card');
  var val = document.getElementById('alm-hc-nextfull');
  if (!card || !val) return;
  var nfm = null;
  try { nfm = _nextFullMoon(focus); } catch (e) {}
  card.hidden = !nfm;
  if (!nfm) return;
  val.innerHTML = _almNextFullHtml(nfm, (typeof _currentLang !== 'undefined') ? _currentLang : 'en', focus);
  val.classList.toggle('alm-card-super', !!nfm.isSuper);
}

// Update the moon/sun readout cards in place (text nodes and `hidden` flags, no
// header rebuild). DOM tier only — the hero disc itself is drawn by
// _almTravelLive's visual tier, every frame, from its own _moonPhase call.
//
// Within this tier nothing may contradict anything else in it: the phase NAME
// and the illumination figure come from the one _moonPhase call below, and the
// sun row swaps between its polar and its sunrise/sunset face rather than
// leaving yesterday's face standing. The next-full-moon card updates here too —
// at this cadence its own throttle is redundant.
// _almRepaintFocus recomputes everything exactly on settle.
function _almLiveHeadCards(focus) {
  var set = function (id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
  var show = function (id, on) { var e = document.getElementById(id); if (e) e.hidden = !on; };
  var m;
  try { m = _moonPhase(focus); } catch (e) { return; }
  set('alm-hc-illum', m.illumination + '%');
  set('alm-hc-age', (m.phase * 29.53).toFixed(1) + ' ' + t('alm_days'));
  set('alm-hc-phase', _localMoonName(m.name));
  try { var dist = _moonDistance(focus); if (dist) set('alm-hc-dist', _almFmtNum(Math.round(dist)) + ' ' + t('alm_km')); } catch (e) {}
  _almLiveNextFull(focus);
  try {
    var loc = _getLocation();
    var off;
    try { off = _tzUtcOffsetMin(_almDisplayTz(loc), focus); } catch (e) { off = -focus.getTimezoneOffset(); }
    var s = _computeSunTimes(focus, loc.lat, loc.lon, off);
    show('alm-hc-polar-card', !!s.polar);
    show('alm-hc-sunrise-card', !s.polar);
    show('alm-hc-sunset-card', !s.polar);
    show('alm-hc-daylight-card', !s.polar);
    show('alm-hc-golden-card', !!s.goldenHour);
    if (s.polar) {
      set('alm-hc-polar', s.polar);
    } else {
      set('alm-hc-sunrise', s.sunrise);
      set('alm-hc-sunset', s.sunset);
      set('alm-hc-daylight', s.dayLength);
      if (s.goldenHour) set('alm-hc-golden', s.goldenHour);
    }
  } catch (e) {}
}

// The live update run during time travel — the single hook both the lever loop
// (_almTravelFrame) and the wheel/key stepper (_almScrubStep) share.
//
// Two tiers, by decree (visuals first): what makes travel FEEL fast is the
// picture moving, so the canvases — the hero moon disc here, the sky scene via
// the caller's _skySetInstant — redraw every frame; they cost no style, layout
// or reflow work. DOM text and anything that can move layout (the head clock,
// the readout cards' text and hidden flags, the calendar grid rebuild) update
// together on the _ALM_TRAVEL_DOM_MS cadence instead: per-frame innerHTML
// rebuilds bought per-frame style/layout passes, which is exactly the jank a
// fast throw exposed. The anti-contradiction rule survives in relaxed form —
// every DOM value in the throttled tier updates in the same tick, so text
// always agrees with text, may trail the visuals by at most ~150ms while the
// lever is held, and _almScrubSettle recomputes everything exactly the moment
// motion stops.
//
// Panels below the fold stay deferred to _almScrubSettle: the orrery, meteor
// countdowns, deep-time, tonight's-sky planet ephemeris, sun-map terminator,
// star chart and analemma are each a full innerHTML rebuild and/or resolve Q-ID
// deep-links — and none of them shares a screen with the instrument.
function _almTravelLive(focus) {
  // Visual tier — every frame.
  var m = null;
  try { m = _moonPhase(focus); } catch (e) {}
  if (m) _heroMoonTravelDraw(focus, m);
  // DOM tier — one throttle key for the text, so the clock and cards always
  // move as one and can never disagree with each other mid-scrub. The
  // calendar grid rides its own coarser cadence (see _ALM_TRAVEL_GRID_MS):
  // it is the tier's one full innerHTML rebuild, and in WebKit its layout
  // pass was most of the remaining scrub jank. A month trailing the clock by
  // up to ~300ms at multi-month-per-second speeds is imperceptible, and
  // _almScrubSettle redraws it exactly the moment motion stops.
  _almTravelThrottled('dom', _ALM_TRAVEL_DOM_MS, function () {
    _almScrubClock(focus);
    _almLiveHeadCards(focus);
  });
  _almTravelThrottled('grid', _ALM_TRAVEL_GRID_MS, _almSyncSelectedToFocus);
}

function _almIsLiveNow(d) { return Math.abs(d.getTime() - Date.now()) < _SCRUB_LIVE_EPS; }

// -- Scrub-time layout freeze ------------------------------------------------
// The header card grid and the calendar panel change height as travel crosses
// months (a five- vs six-week grid, a day-detail holiday list growing and
// shrinking, polar sun cards swapping in). Mid-scrub that reflowed the whole
// page every DOM tick — visible jank, and the sticky dock under the lever
// shifted under the user's finger. So travel pins each variable-height section
// at its current height (overflow clipped; a truncated holiday list for the
// duration of a throw is invisible next to the page breathing) and releases the
// pins on settle, when the exact repaint lands.
var _ALM_TRAVEL_FREEZE_IDS = ['almanac-head', 'almanac-calendar'];
var _almTravelFrozen = false;

function _almTravelFreeze() {
  if (_almTravelFrozen) return;
  _almTravelFrozen = true;
  // Record where each pinned section and its next sibling sit BEFORE pinning:
  // the pin itself moves them (below), and these are the positions to restore.
  var marks = [];
  for (var i = 0; i < _ALM_TRAVEL_FREEZE_IDS.length; i++) {
    var el = document.getElementById(_ALM_TRAVEL_FREEZE_IDS[i]);
    if (!el || !el.offsetHeight) continue;
    marks.push({
      el: el, next: el.nextElementSibling,
      top: el.getBoundingClientRect().top,
      nextTop: el.nextElementSibling ? el.nextElementSibling.getBoundingClientRect().top : null
    });
  }
  for (i = 0; i < marks.length; i++) {
    marks[i].el.style.height = marks[i].el.offsetHeight + 'px';
    marks[i].el.style.overflow = 'hidden';
  }
  // Pinning changes margin behaviour: a fixed height plus clipped overflow
  // stops child margins collapsing out of the section (the hero card grid's
  // 20px bottom margin, the calendar nav's 16px top margin), so the gaps those
  // escaped margins formed vanish and the sky scene slides up into the hero
  // cards for the duration of the throw. Give each pinned section explicit
  // margins that put itself and its neighbour back exactly where they were;
  // the extra passes absorb adjacent-sibling margin collapse, which can eat
  // part of a first correction.
  for (var pass = 0; pass < 3; pass++) {
    var moved = false;
    for (i = 0; i < marks.length; i++) {
      var mk = marks[i];
      var dTop = mk.top - mk.el.getBoundingClientRect().top;
      if (Math.abs(dTop) > 0.5) {
        mk.el.style.marginTop = ((parseFloat(getComputedStyle(mk.el).marginTop) || 0) + dTop) + 'px';
        moved = true;
      }
      if (mk.next) {
        var dNext = mk.nextTop - mk.next.getBoundingClientRect().top;
        if (Math.abs(dNext) > 0.5) {
          mk.el.style.marginBottom = ((parseFloat(getComputedStyle(mk.el).marginBottom) || 0) + dNext) + 'px';
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

function _almTravelUnfreeze() {
  if (!_almTravelFrozen) return;
  _almTravelFrozen = false;
  for (var i = 0; i < _ALM_TRAVEL_FREEZE_IDS.length; i++) {
    var el = document.getElementById(_ALM_TRAVEL_FREEZE_IDS[i]);
    if (!el) continue;
    el.style.height = '';
    el.style.overflow = '';
    el.style.marginTop = '';
    el.style.marginBottom = '';
  }
}

// Move the calendar selection + browsed month onto the focused instant's day,
// reading the instant in device-local fields — the same zone the header clock
// and the time machine's readout use, so the three never disagree on the date.
// Redraws only when the day actually moved: the grid is a full innerHTML
// rebuild (~1.5ms), and scrubbing within a single day changes nothing in it.
function _almSyncSelectedToFocus() {
  var f = _almFocusInstant();
  var jdn = _gregorianToJDN(f.getFullYear(), f.getMonth() + 1, f.getDate());
  var cal = _jdnToCalendar(_almSystem, jdn);
  if (jdn === _almSelectedJDN && cal.year === _almYear && cal.month === _almMonth) return;
  _almSelectedJDN = jdn;
  _almYear = cal.year;
  _almMonth = cal.month;
  _drawAlmanacGrid();
}

// Settle the almanac on `target`: snap back to live if within a minute of now,
// otherwise recompute every panel once for the new instant. opts.land plays the
// "zap" (shake + vibration) — used for deliberate arrivals (lever release, a
// chosen destination), not for discrete wheel/key steps.
function _almScrubSettle(target, opts) {
  // Motion is over: release the height pins before the exact repaint below so
  // the landed layout is the true one, and reset the DOM-tier throttle so the
  // next gesture's first frame updates the text immediately.
  _almTravelUnfreeze();
  _almTravelThrottleAt = {};
  if (_almIsLiveNow(target)) {
    _almBackToToday();
  } else {
    _almFocus = _almClampInstant(target);
    _almSyncSelectedToFocus();
    _almRepaintFocus();
    // Landing always returns the dock to the three-row circuit. The motion
    // face used to stay up until tapped, which read as the instrument still
    // "Traveling" after the lever had already been released.
    var tm = document.getElementById('alm-tm');
    if (tm && tm.getAttribute('data-mode') === 'motion') _almTmMode('rest');
    _almTmSync();
  }
  if (opts && opts.land) _almTmLand();
}

// -- Visibility -----------------------------------------------------------
// The instrument is hidden until summoned, so the almanac opens on the sky, not
// a control panel. It appears when the user taps the header date or time (the
// discoverable entries), picks a different calendar day, or engages the lever;
// the × closes it, snapping back to now via the existing back-to-now path so
// the almanac is left reading the present.
function _almTmShow() {
  var el = document.getElementById('alm-tm');
  if (!el) return;
  el.classList.add('alm-tm-open');
  // Land on the three-row circuit unless a lever throw is actively in flight.
  if (el.getAttribute('data-mode') !== 'motion') _almTmMode('rest');
  _almTmSync();
}
function _almTmHide() {
  var el = document.getElementById('alm-tm');
  if (el) el.classList.remove('alm-tm-open');
}
function _almTmClose() { _almTmEditCancel(); _almBackToToday(); _almTmHide(); }

// -- Panel faces & readouts --
function _almTmMode(mode) {
  var el = document.getElementById('alm-tm');
  if (el) el.setAttribute('data-mode', mode);
}
// Tapping the collapsed readout returns to the three-row circuit.
function _almTmToRest() { _almTmMode('rest'); _almTmSync(); }

// Refresh the three-row circuit. DESTINATION mirrors DISPLAYED at rest (and
// is left alone mid-edit — the user's keystrokes own it); the ACTUAL reading
// is live as a return-to-now control only while parked away from the present.
function _almTmSync() {
  var f = _almFocusInstant();
  var traveling = _almFocus != null && !_almIsLiveNow(_almFocus);
  var pf = _almTmSetCells('alm-tm-disp', f);
  if (!_almTmEditing) _almTmSetCells('alm-tm-dest', f);
  var pn = _almTmSetCells('alm-tm-now', new Date());
  var root = document.getElementById('alm-tm');
  if (root) {
    // Shared segment widths (CSS vars, in ch) so the three rows stay one
    // aligned fixed grid even when a BCE year sits above a 4-digit one. The
    // month column is sized to the LONGEST localized abbreviation so arrow-
    // stepping through months mid-edit can never clip or jitter a cell.
    var monCh = 3;
    var abbrs = _almTmMonAbbrs();
    for (var i = 0; i < abbrs.length; i++) monCh = Math.max(monCh, _almTmChLen(abbrs[i]));
    root.style.setProperty('--tm-mon-ch', monCh);
    root.style.setProperty('--tm-year-ch', Math.max(4, pf.year.length, pn.year.length));
    root.classList.toggle('alm-tm-away', traveling);
  }
  _almTmSetDelta('alm-tm-delta', f);
  // The ACTUAL engraving is the way back to the present, so it is only a
  // control while there is somewhere to come back from. `disabled` (not a
  // class) is what drops the pointer cursor, the hover lamp-up and the tab
  // stop in one move, and keeps assistive tech from offering a dead action.
  var ret = document.getElementById('alm-tm-return');
  if (ret) ret.disabled = !traveling;
}

function _almTmSoloUpdate(d) {
  _almTmSetCells('alm-tm-solo', d);
  _almTmSetDelta('alm-tm-solo-delta', d);
}

// -- Landing ("zap to it"): brief shake + a short haptic pulse on arrival. --
function _almTmLand() {
  if (_almReduceMotion()) return;
  try { if (navigator.vibrate) navigator.vibrate([10, 30, 18]); } catch (e) {}
  var el = document.getElementById('alm-tm');
  if (!el) return;
  el.classList.remove('alm-tm-zap');
  void el.offsetWidth;                 // restart the keyframe from zero
  el.classList.add('alm-tm-zap');
  setTimeout(function () { el.classList.remove('alm-tm-zap'); }, 480);
}

// -- Destination edit — in place, in the same cells. -------------------------
// The DESTINATION row IS the editor. Clicking a segment swaps each value for
// an input in the same cell: same order, same geometry, no pencil, no format
// flip. Arrows step a field (months, hours and minutes wrap), typing replaces
// it, Enter or the GO key commits and travels, Esc or the X key reverts. The
// keypad strip carries GO/X while editing (mobile numeric keyboards have no
// Enter) and is absent otherwise.
var _almTmEditing = false;
var _almTmEditPrev = null;              // instant to revert to on cancel
var _almTmMonCache = null;              // localized month abbreviations, by lang

function _almTmMonAbbrs() {
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  if (_almTmMonCache && _almTmMonCache.lang === lang) return _almTmMonCache.list;
  var out = [];
  for (var m = 0; m < 12; m++) out.push(_almTmParts(new Date(2024, m, 15)).mon);
  _almTmMonCache = { lang: lang, list: out };
  return out;
}

// Month field accepts the localized abbreviation (as shown), a typed prefix of
// one, or a plain 1-12.
function _almTmMonParse(v, dflt) {
  v = (v == null ? '' : String(v)).trim();
  if (!v) return dflt;
  var n = parseInt(v, 10);
  if (!isNaN(n)) return Math.min(12, Math.max(1, n));
  var abbrs = _almTmMonAbbrs();
  var up = v.toUpperCase();
  for (var i = 0; i < 12; i++) {
    if (abbrs[i].indexOf(up) === 0 || up.indexOf(abbrs[i]) === 0) return i + 1;
  }
  return dflt;
}

function _almTmEditStart(ev) {
  if (_almTmEditing) return;
  var root = document.getElementById('alm-tm');
  if (!root) return;
  _almTmEditing = true;
  _almTmEditPrev = _almFocusInstant();
  root.classList.add('alm-tm-editing');
  var p = _almTmParts(_almTmEditPrev);
  for (var i = 0; i < _ALM_TM_FIELDS.length; i++) {
    var el = document.getElementById('alm-tm-in-' + _ALM_TM_FIELDS[i]);
    if (el) el.value = p[_ALM_TM_FIELDS[i]];
  }
  // Focus the segment that was tapped; the month cell otherwise.
  var cell = ev && ev.target && ev.target.closest ? ev.target.closest('.alm-tm-cell') : null;
  var input = (cell && cell.querySelector('.alm-tm-cin')) || document.getElementById('alm-tm-in-mon');
  if (input) input.focus();
}

// Keyboard path onto the row itself (role=button). Keystrokes inside the
// field inputs bubble up here too — those belong to _almTmEditKey (a commit's
// Enter must not bounce straight back into a fresh edit).
function _almTmDestKey(e) {
  if (_almTmEditing || (e.target && e.target.tagName === 'INPUT')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _almTmEditStart(e); }
}

// Arrow stepping per field. Month/day/hour/minute wrap; the year clamps to
// the instrument's travel range.
var _ALM_TM_FIELD_RANGE = { day: [1, 31], hh: [0, 23], mi: [0, 59] };
function _almTmEditStep(part, dir) {
  var el = document.getElementById('alm-tm-in-' + part);
  if (!el) return;
  var prev = _almTmEditPrev || new Date();
  if (part === 'mon') {
    var m = _almTmMonParse(el.value, prev.getMonth() + 1) - 1 + dir;
    el.value = _almTmMonAbbrs()[((m % 12) + 12) % 12];
    return;
  }
  var n = parseInt(el.value, 10);
  if (part === 'year') {
    if (isNaN(n)) n = prev.getFullYear();
    el.value = String(Math.max(_ALM_YEAR_MIN, Math.min(_ALM_YEAR_MAX, n + dir)));
    return;
  }
  var r = _ALM_TM_FIELD_RANGE[part];
  if (isNaN(n)) n = r[0];
  var span = r[1] - r[0] + 1;
  n = (((n - r[0] + dir) % span) + span) % span + r[0];
  el.value = ('0' + n).slice(-2);
}

function _almTmEditKey(e, part) {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); _almTmEditCommit(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _almTmEditCancel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _almTmEditStep(part, 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); _almTmEditStep(part, -1); }
}

// A long typed year (5+ digits, BCE sign) widens the shared year column so
// the digits never clip; _almTmSync trues it back up after the trip.
function _almTmYearGrew(el) {
  var root = document.getElementById('alm-tm');
  if (root) {
    var cur = parseInt(root.style.getPropertyValue('--tm-year-ch'), 10) || 4;
    var len = Math.max(4, (el.value || '').length);
    if (len > cur) root.style.setProperty('--tm-year-ch', len);
  }
}

function _almTmEditInt(id, dflt, lo, hi) {
  var el = document.getElementById(id);
  var n = el ? parseInt(el.value, 10) : NaN;
  if (isNaN(n)) n = dflt;
  return Math.max(lo, Math.min(hi, n));
}

function _almTmEditStop() {
  _almTmEditing = false;
  _almTmEditPrev = null;
  var root = document.getElementById('alm-tm');
  if (root) root.classList.remove('alm-tm-editing');
}

function _almTmEditCommit() {
  if (!_almTmEditing) return;
  var prev = _almTmEditPrev || _almFocusInstant();
  var monEl = document.getElementById('alm-tm-in-mon');
  var mo = _almTmMonParse(monEl ? monEl.value : '', prev.getMonth() + 1);
  var y = _almTmEditInt('alm-tm-in-year', prev.getFullYear(), _ALM_YEAR_MIN, _ALM_YEAR_MAX);
  var d = _almTmEditInt('alm-tm-in-day', prev.getDate(), 1, 31);
  var h = _almTmEditInt('alm-tm-in-hh', prev.getHours(), 0, 23);
  var mi = _almTmEditInt('alm-tm-in-mi', prev.getMinutes(), 0, 59);
  _almTmEditStop();
  _almScrubSettle(_almClampInstant(_almMakeInstant(y, mo, d, h, mi)), { land: true });
}

function _almTmEditCancel() {
  if (!_almTmEditing) return;
  _almTmEditStop();
  _almTmSync();
}

// Return-to-now, with the landing zap (the ACTUAL engraving + the Home key).
function _almTmReturnNow() { _almBackToToday(); _almTmLand(); }

// -- Lever: displacement -> directional speed, spring back on release. --
var _almLeverActive = false;
var _almLeverDisp = 0;                  // signed throw, -1 (past) .. +1 (future)
var _almTravelRAF = null;               // the single travel loop (never stacked)
var _almTravelLastTs = 0;
var _almLeverDecel = false;             // easing the throw to zero after release
var _almLeverDecelStart = 0;
var _almLeverDecelFrom = 0;
var _almTmCenterY = 0;                  // track-centre client-Y, measured on grab
var _almTmHalf = 1;                     // px from centre to a full throw
var _almScrubWheelTimer = null;

function _almLeverClientY(e) {
  return (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
}

function _almLeverRate(disp) {
  var a = Math.abs(disp);
  if (a < _TM_DEADZONE) return 0;
  var u = (a - _TM_DEADZONE) / (1 - _TM_DEADZONE);
  var mag = _TM_RATE_MIN * Math.pow(_TM_RATE_MAX / _TM_RATE_MIN, u);
  return disp < 0 ? -mag : mag;
}

// Reflect the throw onto the knob (up = future = negative translateY).
function _almLeverKnob(disp) {
  var k = document.getElementById('alm-tm-lever');
  if (k) k.style.transform = 'translateY(' + (-disp * _almTmHalf) + 'px)';
}

// One rAF, alive only while the lever is held or decelerating. Per frame it
// advances _almFocus by rate·dt and cheaply retargets the running sky loop via
// _skySetInstant — the same redraw contract the scrubber had. When the throw
// reaches zero the loop ends and settles every heavy panel once, with a zap.
function _almTravelFrame(ts) {
  _almTravelRAF = null;
  if (!_almTravelLastTs) _almTravelLastTs = ts;
  var dtReal = Math.min(50, ts - _almTravelLastTs);   // clamp gaps (tab switch)
  _almTravelLastTs = ts;

  if (_almLeverDecel) {
    var p = Math.min(1, (ts - _almLeverDecelStart) / _TM_SPRING_MS);
    _almLeverDisp = _almLeverDecelFrom * (1 - p * p);  // ease-out to a soft stop
    _almLeverKnob(_almLeverDisp);
    if (p >= 1) { _almLeverDisp = 0; _almLeverDecel = false; }
  }

  var rate = _almLeverRate(_almLeverDisp);
  if (rate !== 0) {
    var base = _almFocus || new Date();
    var next = _almClampInstant(new Date(base.getTime() + rate * dtReal));
    _almFocus = next;
    _almTmSoloUpdate(next);
    _almTravelLive(next);
    if (!_almReduceMotion() && typeof _skySetInstant === 'function') _skySetInstant(next);
  }

  if (_almLeverActive || _almLeverDecel) {
    _almTravelRAF = requestAnimationFrame(_almTravelFrame);
  } else {
    _almTravelLastTs = 0;
    _almScrubSettle(_almFocusInstant(), { land: true });
  }
}

function _almTravelStart() {
  if (_almTravelRAF) return;
  _almTravelFreeze();
  _almTravelLastTs = 0;
  _almTravelRAF = requestAnimationFrame(_almTravelFrame);
}

function _almLeverStart(e) {
  if (e.type === 'pointerdown' && e.button != null && e.button !== 0) return;
  var track = document.getElementById('alm-tm-track');
  var knob = document.getElementById('alm-tm-lever');
  if (!track || !knob) return;
  var tr = track.getBoundingClientRect();
  _almTmCenterY = tr.top + tr.height / 2;
  _almTmHalf = Math.max(1, tr.height / 2 - knob.offsetHeight / 2);
  _almLeverActive = true;
  _almLeverDecel = false;
  _almTmEditCancel();                    // a thrown lever outranks a half-typed destination
  _almTmShow();                          // engaging the lever reveals the instrument
  knob.classList.remove('alm-tm-lever-spring');
  if (knob.setPointerCapture && e.pointerId != null) { try { knob.setPointerCapture(e.pointerId); } catch (err) {} }
  _almTmMode('motion');
  _almTmSoloUpdate(_almFocusInstant());
  _almLeverMove(e);
  _almTravelStart();
  e.preventDefault();
}

function _almLeverMove(e) {
  if (!_almLeverActive) return;
  e.preventDefault();
  var disp = -(_almLeverClientY(e) - _almTmCenterY) / _almTmHalf;   // up = future
  disp = Math.max(-1, Math.min(1, disp));
  _almLeverDisp = disp;
  _almLeverKnob(disp);
  var k = document.getElementById('alm-tm-lever');
  if (k) k.setAttribute('aria-valuenow', Math.round(disp * 100));
}

function _almLeverEnd(e) {
  if (!_almLeverActive) return;
  _almLeverActive = false;
  var knob = document.getElementById('alm-tm-lever');
  if (knob) {
    knob.classList.add('alm-tm-lever-spring');
    knob.setAttribute('aria-valuenow', 0);
    if (knob.releasePointerCapture && e && e.pointerId != null) { try { knob.releasePointerCapture(e.pointerId); } catch (err) {} }
  }
  if (_almReduceMotion()) {
    _almLeverDisp = 0; _almLeverKnob(0); _almLeverDecel = false;
  } else {
    _almLeverDecel = true;
    _almLeverDecelStart = performance.now();
    _almLeverDecelFrom = _almLeverDisp;
  }
  // The in-flight travel loop sees !active (and rides the decel to zero), then
  // settles. If it somehow isn't running, settle now.
  if (!_almTravelRAF) _almScrubSettle(_almFocusInstant(), { land: true });
}

// Wheel over the lever (and arrow keys) step time discretely; the heavy repaint
// is debounced so a burst of notches settles once. No zap on a mere step.
function _almScrubStep(deltaMs) {
  var next = _almClampInstant(new Date(_almFocusInstant().getTime() + deltaMs));
  _almFocus = next;
  _almTravelFreeze();                    // released by the debounced settle
  _almTravelLive(next);
  if (!_almReduceMotion() && typeof _skySetInstant === 'function') _skySetInstant(next);
  _almTmSync();
  clearTimeout(_almScrubWheelTimer);
  _almScrubWheelTimer = setTimeout(function () { _almScrubSettle(_almFocusInstant()); }, 220);
}

function _almScrubWheel(e) {
  e.preventDefault();
  _almScrubStep(e.deltaY < 0 ? _SCRUB_WHEEL_STEP : -_SCRUB_WHEEL_STEP);
}

function _almScrubKey(e) {
  var d = 0;
  if (e.key === 'ArrowUp') d = _SCRUB_WHEEL_STEP;
  else if (e.key === 'ArrowDown') d = -_SCRUB_WHEEL_STEP;
  else if (e.key === 'PageUp') d = _SCRUB_PAGE_STEP;
  else if (e.key === 'PageDown') d = -_SCRUB_PAGE_STEP;
  else if (e.key === 'Home') { e.preventDefault(); _almTmReturnNow(); return; }
  else return;
  e.preventDefault();
  _almScrubStep(d);
}

function _almTmInit() {
  var knob = document.getElementById('alm-tm-lever');
  if (knob) {
    if (window.PointerEvent) {
      knob.addEventListener('pointerdown', _almLeverStart);
      knob.addEventListener('pointermove', _almLeverMove);
      knob.addEventListener('pointerup', _almLeverEnd);
      knob.addEventListener('pointercancel', _almLeverEnd);
    } else {
      knob.addEventListener('touchstart', _almLeverStart, { passive: false });
      knob.addEventListener('touchmove', _almLeverMove, { passive: false });
      knob.addEventListener('touchend', _almLeverEnd);
      knob.addEventListener('mousedown', _almLeverStart);
      window.addEventListener('mousemove', _almLeverMove);
      window.addEventListener('mouseup', _almLeverEnd);
    }
    knob.addEventListener('wheel', _almScrubWheel, { passive: false });
    knob.addEventListener('keydown', _almScrubKey);
  }
  _almTmSync();
}



function _renderAlmanacContent() {
  var now = new Date();
  var m = _moonPhase(now);

  var html = '<div class="almanac-inner">';

  html += '<div id="almanac-head">' + _almHeadHtml(now) + '</div>';
  _almPrevFocusTime = now.getTime();   // seed the hero-moon sweep's start

  // Sky scene + calendar — wall calendar: art above, month grid below. Time is
  // driven by the time machine at the top; the sky animates live as you travel.
  html += '<div class="almanac-sky-wrap">' +
    '<canvas id="almanac-sky-canvas" aria-describedby="almanac-sky-desc" role="img"></canvas>' +
    // Inline styles duplicate .sr-only so a stale cached app.css can never
    // expose this text visually (issue #25).
    '<div id="almanac-sky-desc" class="sr-only" style="position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"></div>' +
    '</div>';
  html += '<div id="almanac-calendar"></div>';

  // Sun map — inline world map with day/night terminator + location picker
  html += '<div id="almanac-sunmap"></div>';

  // On this day — curated space & science milestones (only rendered when today has some)
  html += '<div id="almanac-onthisday"></div>';

  // Orrery
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + _lterm('solar_system', t('alm_solar_system')) + '</div>';
  html += '<div class="almanac-orrery-wrap"><canvas id="almanac-orrery"></canvas></div>';
  html += '<div class="orrery-controls">';
  // Bidirectional speed slider: left = rewind, center = 1×, right = fast forward
  html += '<span class="orrery-speed-word">' + _tLookup('alm_speed', 'Speed') + '</span>';
  html += '<span class="orrery-speed-end">◀</span>';
  html += '<input id="orrery-slider" type="range" min="-80" max="80" value="50" class="orrery-slider" oninput="_orrerySliderInput(this.value)" />';
  html += '<span class="orrery-speed-end">▶</span>';
  html += '<span id="orrery-speed-label" class="orrery-speed-label">100K× ▶</span>';
  html += '<span id="orrery-date" class="orrery-date"></span>';
  html += '<button id="orrery-now" class="orrery-ctrl-btn orrery-now" onclick="_orrerySnapToNow()" title="' + t('alm_back_to_now') + '" style="display:none">' + t('alm_now') + '</button>';
  html += '</div>';
  // Transit slider — appears when a rocket is in flight (aligned with main controls)
  html += '<div id="orrery-transit-wrap" class="orrery-transit-wrap">';
  html += '<span class="orrery-transit-end">' + t('alm_transit') + '</span>';
  html += '<input id="orrery-transit-slider" type="range" min="0" max="1000" value="0" class="orrery-slider" style="flex:1" oninput="_orreryTransitSlider(this.value)" />';
  html += '<span id="orrery-transit-label" class="orrery-transit-label"></span>';
  html += '</div>';
  // Missions panel — inline with controls
  html += '<div id="orrery-missions" style="display:none;margin-top:4px;font-size:11px;color:var(--text3)"></div>';
  // Voyager detail card — appears on click
  html += '<div id="voyager-card" style="display:none"></div>';
  html += '</div>';

  // Tonight's sky — planet visibility
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_tonights_sky') + '</div>';
  html += '<div id="almanac-tonight"></div>';
  html += '</div>';

  // Star chart — a circular planisphere of the sky above the chosen location now
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_star_chart') + '</div>';
  html += '<div class="alm-starchart-wrap"><canvas id="almanac-starchart" onclick="_starChartClick(event)"></canvas></div>';
  // Time is driven by the pinned scrubber at the top now; drag the chart to
  // stand elsewhere on Earth, tap a body to identify it.
  html += '<div id="alm-sc-info" class="alm-sc-info"></div>';
  html += '<div id="almanac-starchart-caption" class="alm-starchart-caption"></div>';
  html += '</div>';

  // The Analemma — the Sun's yearly figure-8 (equation of time × declination)
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + _lterm('analemma', t('alm_analemma')) + '</div>';
  html += '<div class="alm-analemma-wrap"><canvas id="almanac-analemma"></canvas></div>';
  html += '<div id="almanac-analemma-caption" class="alm-analemma-caption"></div>';
  html += '</div>';

  // Meteor showers
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + _lterm('meteor_shower', t('alm_meteor_showers')) + '</div>';
  html += '<div id="almanac-meteors"></div>';
  html += '</div>';

  // Celestial events — conjunctions, oppositions
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_celestial_events') + '</div>';
  html += '<div id="almanac-events"></div>';
  html += '</div>';

  // Astro data
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_astro_data') + '</div>';
  html += '<div id="almanac-astro"></div>';
  html += '</div>';

  // Deep time
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_deep_time') + '</div>';
  html += '<div id="almanac-deeptime"></div>';
  html += '</div>';

  // Messages Across Time — enduring inscriptions in every language
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_messages_across_time') + '</div>';
  html += '<div id="almanac-rosetta"></div>';
  html += '</div>';


  // The time machine — the almanac's skeuomorphic time-travel instrument.
  // Docked at the BOTTOM of the layout and sticky to the viewport's bottom edge,
  // so summoning it (hero-clock tap, calendar pick, lever) grows the page only
  // below everything the reader is looking at — no scroll bump — while still
  // riding into view as a dock. Two faces (rest / motion) toggled by its
  // data-mode, plus an in-place destination edit on the rest face; see the
  // engine above.
  html += '<div id="alm-tm" class="alm-tm" data-mode="rest">';
  html +=   '<div class="alm-tm-panel">';
  // Rest face — one lit glass window over two fine engravings, not three equal
  // rows. DESTINATION is the window and the control: its fields carry hidden
  // in-place inputs. The offset-from-now lamp rides the legend line's right
  // half, which was dead space, so all three readings plus the delta fit in
  // roughly two thirds of the height the stacked rows needed.
  html +=     '<div class="alm-tm-rows">';
  html +=       '<div class="alm-tm-caps">';
  html +=         '<span class="alm-tm-cap">' + t('alm_tm_destination') + '</span>';
  html +=         '<span class="alm-tm-delta" id="alm-tm-delta" title="' + _almEsc(t('alm_tm_offset')) + '"></span>';
  html +=       '</div>';
  html +=       _almTmColsHtml();
  html +=       '<div class="alm-tm-glass alm-tm-dest" role="button" tabindex="0" onclick="_almTmEditStart(event)" onkeydown="_almTmDestKey(event)" title="' + _almEsc(t('alm_tm_set_dest')) + '">' + _almTmCellsHtml('alm-tm-dest', true) + '</div>';
  html +=       '<div class="alm-tm-rail" aria-hidden="true"></div>';
  html +=       '<div class="alm-tm-sec">';
  html +=         '<div class="alm-tm-secrow alm-tm-displayed">';
  html +=           '<span class="alm-tm-seccap">' + t('alm_tm_displayed') + '</span>' + _almTmCellsHtml('alm-tm-disp');
  html +=         '</div>';
  // ACTUAL is both the reading of the present AND the way back to it: the
  // engraving itself is the control, so the plate needs no return key. It is a
  // real <button> (keyboard-focusable, Enter/Space) and carries `disabled`
  // whenever the almanac already reads the present — there is nothing to
  // return to then, so it must not take a tab stop or a hover.
  html +=         '<button type="button" class="alm-tm-secrow alm-tm-now" id="alm-tm-return"' +
                    ' onclick="_almTmReturnNow()" title="' + _almEsc(t('alm_back_to_now')) + '"' +
                    ' aria-label="' + _almEsc(t('alm_back_to_now')) + '" disabled>';
  html +=           '<span class="alm-tm-seccap">' + t('alm_tm_actual') + '</span>' + _almTmCellsHtml('alm-tm-now');
  html +=         '</button>';
  // Keypad strip — GO/X only, and only during a destination edit (tap targets
  // for mobile, where numeric keyboards have no Enter key). It lives INSIDE the
  // secondary block and is absolutely positioned over it; the two engravings go
  // visibility:hidden for the duration of the edit. So the keys cost the plate
  // no height of their own, the dock measures the same in rest, edit and
  // motion, and removing the old NOW key made the whole instrument shorter.
  html +=         '<div class="alm-tm-keys">';
  html +=           '<button type="button" class="alm-tm-key alm-tm-key-cancel" onclick="_almTmEditCancel()" title="' + _almEsc(t('alm_tm_cancel')) + '" aria-label="' + _almEsc(t('alm_tm_cancel')) + '">&#10005;</button>';
  html +=           '<button type="button" class="alm-tm-key alm-tm-key-go" onclick="_almTmEditCommit()">' + t('alm_tw_go') + '</button>';
  html +=         '</div>';
  html +=       '</div>';
  html +=     '</div>';
  // Motion face — the same legend line and the same glass window, one size up,
  // overlaid on the (hidden but still laid out) rest face so the dock's size
  // never changes when the lever is grabbed; tap to return to rest. The offset
  // lamp keeps its exact position, so it reads as one instrument counting off
  // the distance travelled rather than a second screen.
  html +=     '<button type="button" class="alm-tm-solo" onclick="_almTmToRest()" aria-label="' + _almEsc(t('alm_tm_traveling')) + '">';
  html +=       '<span class="alm-tm-caps">';
  html +=         '<span class="alm-tm-cap">' + t('alm_tm_traveling') + '</span>';
  html +=         '<span class="alm-tm-delta" id="alm-tm-solo-delta"></span>';
  html +=       '</span>';
  html +=       '<span class="alm-tm-glass">' + _almTmCellsHtml('alm-tm-solo') + '</span>';
  html +=     '</button>';
  html +=   '</div>';
  // Side-mounted lever — a faceted crystal disc on a brass shaft (the 1960 Time
  // Machine's spinning crystal). Throw up for the future, down for the past; the
  // disc is the drag target, mechanics unchanged. The shaft is a static rod the
  // disc rides along.
  html +=   '<div class="alm-tm-lever-col">';
  html +=     '<div class="alm-tm-track" id="alm-tm-track">';
  html +=       '<span class="alm-tm-shaft" aria-hidden="true"></span>';
  html +=       '<span class="alm-tm-endstop alm-tm-endstop-fwd" aria-hidden="true"></span>';
  html +=       '<div class="alm-tm-lever alm-tm-lever-spring" id="alm-tm-lever" role="slider" tabindex="0"' +
                  ' aria-label="' + _almEsc(t('alm_tm_lever_label')) + '" aria-orientation="vertical"' +
                  ' aria-valuemin="-100" aria-valuemax="100" aria-valuenow="0">' +
                  '<span class="alm-tm-crystal" aria-hidden="true"><span class="alm-tm-crystal-facets"></span></span>' +
                '</div>';
  html +=       '<span class="alm-tm-endstop alm-tm-endstop-back" aria-hidden="true"></span>';
  html +=     '</div>';
  html +=   '</div>';
  // Close — returns the almanac to now and hides the instrument again. A small
  // brass-ringed stud on the dock's corner (same material language as the
  // lever shaft); the thin stroked cross scales cleanly where a text × cannot.
  // Its CSS ::after pad extends the 22px stud to a 44px touch target.
  html +=   '<button type="button" class="alm-tm-close" onclick="_almTmClose()" title="' + _almEsc(t('alm_tm_close')) + '" aria-label="' + _almEsc(t('alm_tm_close')) + '">' +
              '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
            '</button>';
  html += '</div>';

  // Footer
  html += '<div style="margin-top:40px;text-align:center;font-size:11px;color:var(--text3)">' +
    t('alm_footer') +
    '</div>';

  html += '</div>';
  document.getElementById('almanac-content').innerHTML = html;

  _renderAlmanacCalendar(now);
  _renderSunMap(now);
  _renderOnThisDay(now);
  _renderTonightSky(now);
  _renderStarChart(now);
  _renderAnalemma(now);
  _renderAstroPanel(now);
  _renderMeteorShowers(now, m);
  _renderCelestialEvents(now);
  _renderDeepTime(now);
  _renderRosettaStone(now);
  _initOrrery();
  // Start orrery at 100K× so planets visibly orbit on load
  _orreryLastFrame = performance.now();
  _orreryAnimate();
  _loadSunData(now);
  _startTzClock();
  _almTmInit();
  _cacheAlmanacHighlights(now, m);
}

// Cache computed almanac highlights for the Today discover card.
// Next time _todayTeaser() runs (in index.html), it picks up this richer data.
function _cacheAlmanacHighlights(now, moon) {
  try {
    var highlights = [];
    var y = now.getFullYear(), mm = now.getMonth(), dd = now.getDate();
    // Meteor showers — next peak within 10 days
    for (var si = 0; si < _METEOR_SHOWERS.length; si++) {
      var s = _METEOR_SHOWERS[si];
      var peak = new Date(y, s.peak[0]-1, s.peak[1]);
      if (peak < now) peak = new Date(y+1, s.peak[0]-1, s.peak[1]);
      var days = Math.ceil((peak - now) / MS_PER_DAY);
      if (days <= 10) highlights.push({ type: 'meteor', name: _showerName(s), days: days, zhr: s.zhr, priority: days === 0 ? 0 : days });
    }
    // Eclipses — check rendered eclipse elements for upcoming dates
    var eclipseEl = document.getElementById('almanac-events');
    if (eclipseEl) {
      var eclRows = eclipseEl.querySelectorAll('.almanac-eclipse-type');
      for (var ei = 0; ei < Math.min(3, eclRows.length); ei++) {
        var untilEl = eclRows[ei].closest('.almanac-eclipse-row');
        if (untilEl) {
          var untilSpan = untilEl.querySelector('.almanac-eclipse-until');
          highlights.push({ type: 'eclipse', name: eclRows[ei].textContent, until: untilSpan ? untilSpan.textContent : '', priority: 5 + ei });
        }
      }
    }
    // Calendar events today. The calendar renders day cells as .alm-day with
    // the number in .alm-num and each holiday/event as .alm-ev (the "+N" more
    // marker is .alm-ev-more — skip it). Older selectors here (.cal-day etc.)
    // matched nothing, so today's holiday never reached the Today card.
    var calEvents = document.querySelectorAll('#almanac-calendar .alm-ev:not(.alm-ev-more)');
    var todayEvents = [];
    calEvents.forEach(function(ev) {
      var dayCell = ev.closest('.alm-day');
      if (dayCell) {
        var dayNum = parseInt(dayCell.querySelector('.alm-num')?.textContent, 10);
        if (dayNum === dd) todayEvents.push(ev.textContent.trim());
      }
    });
    if (todayEvents.length > 0) highlights.push({ type: 'holiday', name: todayEvents[0], days: 0, priority: -1 });
    // Sort by priority (lower = more interesting)
    highlights.sort(function(a, b) { return a.priority - b.priority; });
    // Cache top 3
    var today = now.toISOString().substring(0, 10);
    localStorage.setItem('zimi_almanac_highlights', JSON.stringify({ date: today, items: highlights.slice(0, 3) }));
  } catch(e) { /* non-critical */ }
}

// ── Moon rendering ──

// Screen tilt (degrees) of the hero disc at a given instant: the bright limb
// faces the Sun as the observer sees it. Delegates to the canonical
// _moonScreenTiltDeg in app.js — the ONE derivation the hero, the sky-scene
// moon and the Today discover card all share.
function _heroMoonTiltDeg(date, loc) {
  return _moonScreenTiltDeg(date, loc.lat, loc.lon);
}

// ── Hero moon time-travel sweep ──
// When the focus jumps, the big hero disc doesn't cut to the new phase: a live
// <canvas> overlay draws the moon at successive REAL instants between the two
// times, so the terminator sweeps its true path and the disc rotates from the
// old tilt to the new one -- as if a camera stayed on it. Driven by the sky
// scene's existing rAF (via _heroMoonTick), so there is no second loop. The
// overlay's opaque disc fully covers the crisp resting <img> beneath it, which
// already shows the destination phase; on completion the overlay is removed and
// that img is revealed with no visible seam. Reduced motion snaps (caller +
// CSS guard). Position never changes -- the hero is centred -- so only phase
// and tilt animate.
var _HERO_MOON_ANIM_SIZE = 256;   // sprite pixels while moving (device px, dpr included)
// Motion sprites are capped at 256 real pixels: _moonSpriteCanvas multiplies
// its size argument by devicePixelRatio, and a cold cache shades ~50 phase
// buckets across the first fast throw. 256 was unaffordable when every bucket
// paid a drawImage + getImageData GPU readback (~6.6ms/bucket at 128 in
// WebKit); with the base pixels cached once per size (_moonTexBaseData) a
// bucket is just the shading loop, so motion quality rises from the old chunky
// 128 while the throw stays cheaper than it was. The resting <img> still
// renders at full 200px x dpr; only frames in motion use this.
function _heroMoonAnimGenSize() {
  return _HERO_MOON_ANIM_SIZE / (window.devicePixelRatio || 1);
}
var _HERO_MOON_PHASE_STEP = 0.02; // quantise illum to ~50 buckets so re-shades stay cached
var _HERO_MOON_MIN_SPAN_MS = 1000;// jumps under this (e.g. a location refresh) just snap
var _heroMoonAnim = null;         // active discrete-jump descriptor, or null
var _heroMoonOverlay = null;      // the overlay <canvas>, or null

function _moonEaseInOut(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// The overlay canvas laid over the current hero moon (created lazily, reused).
// Backing store is the motion sprite size — the sprite blits 1:1 and CSS
// scales the element to the 200px disc; rotation is a compositor transform.
function _heroMoonEnsureOverlay(hero) {
  if (_heroMoonOverlay && _heroMoonOverlay.isConnected) return _heroMoonOverlay;
  var cv = document.createElement('canvas');
  cv.className = 'almanac-moon-anim';
  cv.setAttribute('aria-hidden', 'true');
  cv.width = _HERO_MOON_ANIM_SIZE;
  cv.height = _HERO_MOON_ANIM_SIZE;
  hero.appendChild(cv);
  _heroMoonOverlay = cv;
  return cv;
}

function _heroMoonRemoveOverlay() {
  if (_heroMoonOverlay && _heroMoonOverlay.parentNode) {
    _heroMoonOverlay.parentNode.removeChild(_heroMoonOverlay);
  }
  _heroMoonOverlay = null;
}

// Draw the moon into the overlay. The canvas repaints only when the phase
// BUCKET changes (a few times a second at travel speed); the per-frame tilt is
// a CSS transform on the element, which the compositor rotates without
// touching a pixel. The old version cleared + rotated + drawImage'd the full
// 200px x dpr backing every frame — ~4.3ms/frame in WebKit even with a warm
// sprite cache, a quarter of the whole frame budget.
function _heroMoonDrawCanvas(cv, illumFrac, waxing, tiltDeg) {
  var key = Math.round(illumFrac * 100) + (waxing ? 'w' : 'a') + (_moonTexReady ? 't' : '');
  if (cv._moonBucket !== key) {
    cv._moonBucket = key;
    var ctx = cv.getContext('2d');
    var W = cv.width;
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(_moonSpriteCanvas(illumFrac, waxing, _heroMoonAnimGenSize()), 0, 0, W, W);
  }
  // Compose with the stylesheet's translateX(-50%) centring (.almanac-moon-anim).
  cv.style.transform = 'translateX(-50%) rotate(' + tiltDeg.toFixed(2) + 'deg)';
}

// Begin a hero sweep from fromTime to toTime (focus instants, ms). Called right
// after _almHeadHtml has rebuilt the header to the destination phase/tilt.
function _almHeroMoonSweep(head, fromTime, toTime, loc) {
  if (Math.abs(toTime - fromTime) < _HERO_MOON_MIN_SPAN_MS) return; // no real jump
  var hero = head.querySelector('.almanac-hero');
  if (!hero || !hero.querySelector('.almanac-moon')) return;
  _heroMoonEnsureOverlay(hero);
  _heroMoonAnim = {
    fromTime: fromTime, toTime: toTime,
    fromTilt: _heroMoonTiltDeg(new Date(fromTime), loc),
    toTilt: _heroMoonTiltDeg(new Date(toTime), loc),
    start: performance.now(),
    dur: _moonAnimDurMs(fromTime, toTime)
  };
}

// ── Hero moon during live travel ──
// The disc is drawn from the SAME _moonPhase result the readout cards are
// written from, in the same call, so it cannot show a crescent while the
// illumination beside it reads 94% — which is what happened while this hung off
// the sky loop's own rAF: that branch only ran for the lever (never for wheel
// or arrow-key steps) and only while a sky canvas happened to be alive.
// Illumination is quantised to _HERO_MOON_PHASE_STEP so every frame hits the
// sprite cache; a full-resolution re-shade per frame is what makes this
// expensive, and 2% of a disc is far below what an eye resolves.
var _heroMoonTravelOn = false;

function _heroMoonTravelDraw(focus, m) {
  var heroEl = document.querySelector('#almanac-head .almanac-hero');
  if (!heroEl || !heroEl.querySelector('.almanac-moon')) return;
  _heroMoonAnim = null;              // a live scrub supersedes any settle sweep
  _heroMoonTravelOn = true;
  var illumFrac = Math.round(m.illumination / 100 / _HERO_MOON_PHASE_STEP) * _HERO_MOON_PHASE_STEP;
  var tilt = _heroMoonTiltDeg(focus, _getLocation());
  _heroMoonDrawCanvas(_heroMoonEnsureOverlay(heroEl), illumFrac, _moonIsWaxing(m), tilt);
}

// End travel and drop the overlay, revealing the resting <img> beneath.
function _heroMoonTravelEnd() {
  _heroMoonTravelOn = false;
  if (_heroMoonOverlay) _heroMoonRemoveOverlay();
}

// Per-frame hook, called from the sky rAF, for the discrete settle sweep only.
// Live travel draws itself (above) rather than waiting on this loop.
function _heroMoonTick(ts) {
  if (_heroMoonAnim) {
    var a = _heroMoonAnim, cv = _heroMoonOverlay;
    if (!cv || !cv.isConnected) { _heroMoonAnim = null; return; }
    var p = (ts - a.start) / a.dur;
    if (p >= 1) {
      // Removing the overlay reveals the resting <img>, which the header
      // rebuild already rendered at the destination phase and full resolution.
      // (A final full-res canvas draw here was never composited — the removal
      // lands in the same tick — so it was pure waste.)
      _heroMoonRemoveOverlay();
      _heroMoonAnim = null;
      return;
    }
    var e = _moonEaseInOut(p);
    var ph = _moonAnimPhaseAt(a.fromTime, a.toTime, e);
    var illumFrac = Math.round(ph.illumination / 100 / _HERO_MOON_PHASE_STEP) * _HERO_MOON_PHASE_STEP;
    var tilt = a.fromTilt + _angleDelta(a.fromTilt, a.toTilt) * e;
    _heroMoonDrawCanvas(cv, illumFrac, _moonIsWaxing(ph), tilt);
    return;
  }
  // Not sweeping and not travelling: reveal the resting img.
  if (!_heroMoonTravelOn && _heroMoonOverlay) _heroMoonRemoveOverlay();
}

// Almanac hero moon — delegates to _renderMoonHTML (defined in app.js)
// Adds the almanac-specific glow wrapper
function _renderAlmanacMoon(m, tiltDeg) {
  var illumFrac = m.illumination / 100;
  var glowOpacity = (illumFrac * 0.15 + 0.02).toFixed(2);
  return '<div class="almanac-moon-glow" style="background:radial-gradient(circle, rgba(232,224,208,' + glowOpacity + ') 0%, transparent 65%)"></div>' +
    _renderMoonHTML(m, 'almanac-moon', tiltDeg);
}

// Next full moon after fromDate, with its distance and whether it's a
// "supermoon" (full within ~90% of perigee ≈ ≤ 361,500 km).
function _nextFullMoon(fromDate) {
  var t = fromDate.getTime();
  var prev = _moonPhase(new Date(t)).phase - 0.5;
  for (var h = 1; h <= 45 * 24; h++) {
    var tt = t + h * 3600000;
    var delta = _moonPhase(new Date(tt)).phase - 0.5;
    if (prev < 0 && delta >= 0) { // waxing crossing of full
      var lo = tt - 3600000, hi = tt;
      for (var b = 0; b < 22; b++) {
        var mid = (lo + hi) / 2;
        if (_moonPhase(new Date(mid)).phase - 0.5 < 0) lo = mid; else hi = mid;
      }
      var fm = new Date(hi), d = _moonDistance(fm);
      return { date: fm, distance: d, isSuper: d <= 361500 };
    }
    prev = delta;
  }
  return null;
}

// Small inline-SVG moon at a given phase (0=new .. 0.5=full .. 1=new).
// Drawn as the lit limb arc + the terminator half-ellipse: crescent when
// <50% lit, gibbous when >50%. Waxing = lit on the right (N. hemisphere view).
function _moonGlyphSVG(phase, px) {
  var r = 10, cx = 12, cy = 12;
  var frac = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  var tw = Math.abs(Math.cos(2 * Math.PI * phase)) * r; // terminator half-width
  var waxing = phase < 0.5;
  // Lit limb: right semicircle when waxing, left when waning.
  var limbSweep = waxing ? 1 : 0;
  // Terminator sweep: crescent curves toward the lit limb, gibbous bulges past.
  var termSweep = (frac <= 0.5) ? (waxing ? 0 : 1) : (waxing ? 1 : 0);
  var lit = 'M ' + cx + ' ' + (cy - r) +
    ' A ' + r + ' ' + r + ' 0 0 ' + limbSweep + ' ' + cx + ' ' + (cy + r) +
    ' A ' + tw.toFixed(2) + ' ' + r + ' 0 0 ' + termSweep + ' ' + cx + ' ' + (cy - r) + ' Z';
  return '<svg class="cal-moon" viewBox="0 0 24 24" width="' + px + '" height="' + px + '" aria-hidden="true">' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#161821"/>' +
    (frac > 0.005 ? '<path d="' + lit + '" fill="#ede8d6"/>' : '') +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#454956" stroke-width="0.75"/></svg>';
}

function _moonDistance(date) {
  // Meeus Ch. 47 distance (km), leading periodic terms. The old code used
  // cos(2·M') for the 2nd term where Meeus has cos(2D − M'), and dropped
  // the cos(2D) and cos(2M') terms — that compressed perigee/apogee by
  // ~7000 km, so supermoons read too far. Uses elongation D, sun anomaly
  // M and moon anomaly M' / arg-of-latitude F.
  var JD = _dateToJD(date.getTime());
  var T = _jdToJulianCentury(JD);
  var D  = ((297.8501921 + 445267.1114034 * T) % 360) * DEG_TO_RAD;
  var M  = ((357.5291092 + 35999.0502909 * T) % 360) * DEG_TO_RAD;
  var Mp = ((134.9633964 + 477198.8675055 * T) % 360) * DEG_TO_RAD;
  var F  = ((93.2720950 + 483202.0175233 * T) % 360) * DEG_TO_RAD;
  return 385000.56
    - 20905.355 * Math.cos(Mp)
    - 3699.111  * Math.cos(2 * D - Mp)
    - 2955.968  * Math.cos(2 * D)
    - 569.925   * Math.cos(2 * Mp)
    + 246.158   * Math.cos(2 * D - 2 * Mp)
    - 204.586   * Math.cos(2 * D - M)
    - 170.733   * Math.cos(2 * D + Mp)
    - 152.138   * Math.cos(2 * D - M - Mp)
    - 129.620   * Math.cos(M - Mp)
    + 108.743   * Math.cos(D)
    + 104.755   * Math.cos(M + Mp)
    + 48.888    * Math.cos(M)
    - 3.149     * Math.cos(2 * F);
}

// ── Orrery: JPL Keplerian elements (J2000 epoch) ──


// ── Voyager probes — hyperbolic escape trajectories ──
// The interstellar probes — escaping the Sun almost radially along a fixed
// ecliptic direction (physically correct far from the Sun), so a fixed
// longitude + a distance growing linearly with time is the right model.
// Distances/velocities are 2026-epoch, ecliptic longitudes JPL-Horizons-grade.
var _VOYAGERS = [
  { name: 'Voyager 1', label: 'V1', launch: Date.UTC(1977, 8, 5), refEpoch: Date.UTC(2026, 0, 1), refDist: 167.0, vel: 3.57, lon: 260.5 },
  { name: 'Voyager 2', label: 'V2', launch: Date.UTC(1977, 7, 20), refEpoch: Date.UTC(2026, 0, 1), refDist: 141.4, vel: 3.21, lon: 296.2 },
  { name: 'Pioneer 10', label: 'P10', launch: Date.UTC(1972, 2, 3), refEpoch: Date.UTC(2026, 0, 1), refDist: 139.9, vel: 2.49, lon: 72 },
  { name: 'Pioneer 11', label: 'P11', launch: Date.UTC(1973, 3, 6), refEpoch: Date.UTC(2026, 0, 1), refDist: 117.5, vel: 2.34, lon: 277 },
  { name: 'New Horizons', label: 'NH', launch: Date.UTC(2006, 0, 19), refEpoch: Date.UTC(2026, 0, 1), refDist: 63.3, vel: 2.85, lon: 285 }
];
var _voyagerPositions = []; // [{name, x, y, r, dist, idx}] in CSS pixels

function _voyagerDist(v, simTime) {
  var yearsFromRef = (simTime - v.refEpoch) / (365.25 * MS_PER_DAY);
  return Math.max(0, v.refDist + v.vel * yearsFromRef);
}

// Reference distances for the "deep space" view (AU).
var _HELIO_TERMINATION_AU = 94;   // termination shock (V1 crossed 2004)
var _HELIOPAUSE_AU = 120;         // interstellar boundary (V1 crossed 2012)
var _KUIPER_INNER_AU = 30, _KUIPER_OUTER_AU = 50;

// Deep-space radial map: AU → fraction of the canvas half-width, log-scaled so
// the planets cluster near the centre and the probes get room out near the rim
// (where their year-on-year crawl is finally visible). Normal view keeps the
// linear-ish planet map; this only applies when deep space is toggled on.
function _orrDeepRadius(au) {
  return 0.47 * Math.log(1 + au / 0.3) / Math.log(1 + 200 / 0.3);
}

function _solveKepler(M, e) {
  var E = M;
  for (var i = 0; i < 10; i++) {
    var dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}





// Orbit radii as fraction of canvas half-width (max ~0.46 to fit within square)
var _ORBIT_VIS = {
  Mercury: 0.06, Venus: 0.10, Earth: 0.14, Mars: 0.19,
  Jupiter: 0.27, Saturn: 0.34, Uranus: 0.41, Neptune: 0.47
};


// ── Orrery time controls & rocket easter egg ──



// AU → visual radius mapping: monotone cubic Hermite (Fritsch-Carlson) through
// planet data points. Smooth C1 curve with no kinks at planet boundaries, while
// preserving exact planet positions and guaranteeing monotonicity (no overshoot).
var _AU_VIS_X = [0, 0.387, 0.723, 1.000, 1.524, 5.203, 9.555, 19.19, 30.07];
var _AU_VIS_Y = [0, 0.06,  0.10,  0.14,  0.19,  0.27,  0.34,  0.41,  0.47 ];

// Precompute Fritsch-Carlson monotone tangents + cubic coefficients
var _AU_VIS_C = (function() {
  var n = _AU_VIS_X.length;
  var dx = [], dy = [], m = [], t = [];
  for (var i = 0; i < n - 1; i++) {
    dx[i] = _AU_VIS_X[i + 1] - _AU_VIS_X[i];
    dy[i] = (_AU_VIS_Y[i + 1] - _AU_VIS_Y[i]) / dx[i];
  }
  // Tangents at each point
  t[0] = dy[0];
  for (var i = 1; i < n - 1; i++) {
    if (dy[i - 1] * dy[i] <= 0) { t[i] = 0; }
    else { t[i] = (dy[i - 1] + dy[i]) / 2; }
  }
  t[n - 1] = dy[n - 2];
  // Fritsch-Carlson: clamp tangents for monotonicity
  for (var i = 0; i < n - 1; i++) {
    if (Math.abs(dy[i]) < 1e-12) { t[i] = t[i + 1] = 0; continue; }
    var a = t[i] / dy[i], b = t[i + 1] / dy[i];
    var s = a * a + b * b;
    if (s > 9) { var tau = 3 / Math.sqrt(s); t[i] = tau * a * dy[i]; t[i + 1] = tau * b * dy[i]; }
  }
  // Cubic Hermite coefficients per segment: c0 + c1*u + c2*u^2 + c3*u^3
  var segs = [];
  for (var i = 0; i < n - 1; i++) {
    var h = dx[i];
    segs.push({
      x0: _AU_VIS_X[i], h: h,
      c0: _AU_VIS_Y[i],
      c1: t[i] * h,
      c2: 3 * (_AU_VIS_Y[i + 1] - _AU_VIS_Y[i]) - 2 * t[i] * h - t[i + 1] * h,
      c3: 2 * (_AU_VIS_Y[i] - _AU_VIS_Y[i + 1]) + t[i] * h + t[i + 1] * h
    });
  }
  return segs;
})();

function _auToVis(au) {
  if (au <= 0) return 0;
  var segs = _AU_VIS_C;
  if (au >= _AU_VIS_X[_AU_VIS_X.length - 1]) return _AU_VIS_Y[_AU_VIS_Y.length - 1];
  // Binary search for segment
  var lo = 0, hi = segs.length - 1;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (segs[mid].x0 <= au) lo = mid; else hi = mid - 1; }
  var s = segs[lo];
  var u = (au - s.x0) / s.h;
  return s.c0 + u * (s.c1 + u * (s.c2 + u * s.c3));
}

// ── Transit speed profile ──
// Rockets use an adaptive 3-phase speed profile:
//   Departure (first 5%) → smooth ramp up → Cruise (middle 90%) → smooth ramp down → Approach (last 5%)
// Speeds scale to transit duration so every launch feels ~12 seconds regardless of planet.


// ── Bidirectional logarithmic speed slider ──
// Slider range -60 to 60: negative = rewind, 0 = 1× real-time, positive = fast forward
// |val| maps: 0→1×, 10→10×, 20→100×, 30→1K×, 40→10K×, 50→100K×, 60→1M×
function _sliderToSpeed(val) {
  var absVal = Math.abs(val);
  var mag = absVal < 1 ? 1 : Math.round(Math.pow(10, absVal / 10));
  return val < -0.5 ? -mag : mag;
}

function _speedToSlider(speed) {
  var absSpeed = Math.abs(speed);
  var val = absSpeed <= 1 ? 0 : Math.round(Math.log10(absSpeed) * 10);
  return speed < 0 ? -val : val;
}

function _formatSpeed(speed) {
  var abs = Math.abs(speed);
  var prefix = speed < -1 ? '◀ ' : '';
  var suffix = speed > 1 ? ' ▶' : '';
  var num;
  if (abs >= 1000000) num = (abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M×';
  else if (abs >= 1000) num = (abs / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K×';
  else num = abs + '×';
  return prefix + num + suffix;
}










// ── Voyager detail card ──

var _SAGAN_QUOTES = [
  { text: 'Look again at that dot. That\u2019s here. That\u2019s home. That\u2019s us.', src: 'Pale Blue Dot' },
  { text: 'Every saint and sinner in the history of our species lived there \u2014 on a mote of dust suspended in a sunbeam.', src: 'Pale Blue Dot' },
  { text: 'The Earth is a very small stage in a vast cosmic arena.', src: 'Pale Blue Dot' },
  { text: 'For small creatures such as we, the vastness is bearable only through love.', src: 'Contact' },
  { text: 'Somewhere, something incredible is waiting to be known.', src: 'Cosmos' },
  { text: 'We are a way for the cosmos to know itself.', src: 'Cosmos' },
  { text: 'The nitrogen in our DNA, the calcium in our teeth, the iron in our blood, the carbon in our apple pies were made in the interiors of collapsing stars. We are made of starstuff.', src: 'Cosmos' },
  { text: 'If you wish to make an apple pie from scratch, you must first invent the universe.', src: 'Cosmos' },
  { text: 'Extinction is the rule. Survival is the exception.', src: 'The Varieties of Scientific Experience' },
  { text: 'We are like butterflies who flutter for a day and think it is forever.', src: 'Cosmos' },
  { text: 'The cosmos is within us. We are made of star-stuff. We are a way for the universe to know itself.', src: 'Cosmos' },
  { text: 'Science is not only compatible with spirituality; it is a profound source of spirituality.', src: 'The Demon-Haunted World' }
];

var _voyagerCardIdx = -1;
var _voyagerCardQuote = null;

function _showVoyagerCard(idx) {
  _voyagerCardIdx = idx;
  _voyagerCardQuote = _SAGAN_QUOTES[Math.floor(Math.random() * _SAGAN_QUOTES.length)];
  _updateVoyagerCard();
}

function _updateVoyagerCard() {
  if (_voyagerCardIdx < 0) return;
  var el = document.getElementById('voyager-card');
  if (!el) return;
  var v = _VOYAGERS[_voyagerCardIdx];
  var simTime = Date.now() + _orreryTimeOffset;
  var dist = _voyagerDist(v, simTime);
  var yearsInSpace = ((simTime - v.launch) / (365.25 * MS_PER_DAY));
  var speed = v.vel * 149597870.7 / (365.25 * 24 * 3600);
  var sig = _signalDelay(dist);

  var html = '<div class="voyager-card-inner">';
  html += '<div class="voyager-card-header">';
  html += '<span class="voyager-card-name">' + v.name + '</span>';
  html += '<button class="voyager-card-close" onclick="_hideVoyagerCard()">×</button>';
  html += '</div>';
  html += '<div class="voyager-card-stats">';
  html += '<div class="voyager-stat"><span class="voyager-stat-val">' + dist.toFixed(1) + ' AU</span><span class="voyager-stat-lbl">' + t('alm_from_sun') + '</span></div>';
  html += '<div class="voyager-stat"><span class="voyager-stat-val">' + speed.toFixed(1) + ' km/s</span><span class="voyager-stat-lbl">' + t('alm_velocity') + '</span></div>';
  html += '<div class="voyager-stat"><span class="voyager-stat-val">' + _fmtDuration(sig.h, sig.m) + '</span><span class="voyager-stat-lbl">' + t('alm_signal_delay') + '</span></div>';
  html += '<div class="voyager-stat"><span class="voyager-stat-val">' + yearsInSpace.toFixed(1) + '</span><span class="voyager-stat-lbl">' + t('alm_years_in_space') + '</span></div>';
  html += '</div>';
  var q = _voyagerCardQuote;
  html += '<div class="voyager-card-quote">\u201c' + q.text + '\u201d<br><span style="color:var(--text3)">\u2014 Carl Sagan, ' + q.src + '</span></div>';
  html += '<button class="voyager-record-btn" onclick="_scrollToGoldenRecord()">' + t('alm_view_golden_record') + '</button>';
  html += '</div>';
  el.innerHTML = html;
  el.style.display = 'block';
}

function _hideVoyagerCard() {
  _voyagerCardIdx = -1;
  var el = document.getElementById('voyager-card');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}



// ── Color helpers ──

function _parseHex(hex) {
  return [parseInt(hex.slice(1,3), 16), parseInt(hex.slice(3,5), 16), parseInt(hex.slice(5,7), 16)];
}

function _hexToRgba(hex, alpha) {
  var c = _parseHex(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}

function _lighten(hex, amount) {
  var c = _parseHex(hex);
  return 'rgb(' + Math.min(255, c[0] + amount) + ',' + Math.min(255, c[1] + amount) + ',' + Math.min(255, c[2] + amount) + ')';
}

function _darken(hex, amount) {
  var c = _parseHex(hex);
  return 'rgb(' + Math.max(0, c[0] - amount) + ',' + Math.max(0, c[1] - amount) + ',' + Math.max(0, c[2] - amount) + ')';
}

// ── Astro data panel ──

// Compute upcoming eclipses using Meeus's lunation-based algorithm (Ch. 54)
// Works for any date — no hardcoded lists needed
function _computeEclipses(fromDate, count) {
  var JD0 = _dateToJD(fromDate.getTime());
  // Find approximate lunation number (new moon count since J2000)
  var k0 = Math.floor((JD0 - 2451550.1) / 29.530588853);
  var results = [];
  // Check both new moons (solar) and full moons (lunar) for ~100 lunations
  for (var dk = 0; dk < 100 && results.length < count; dk++) {
    for (var half = 0; half < 2; half++) {
      var k = k0 + dk + half * 0.5; // integer=new moon, +0.5=full moon
      var isSolar = (half === 0);
      var T = k / 1236.85;
      var T2 = T * T, T3 = T2 * T, T4 = T3 * T;
      // Mean phase JDE
      var JDE = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;
      // Sun's mean anomaly
      var M = (2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3) % 360;
      // Moon's mean anomaly
      var Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4) % 360;
      // Moon's argument of latitude
      var F = (160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4) % 360;
      // Longitude of ascending node
      var O = (124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3) % 360;
      var Frad = F * DEG_TO_RAD;
      var sinF = Math.sin(Frad);
      // Eclipse condition: |sin(F)| < 0.36 (rough filter)
      if (Math.abs(sinF) > 0.36) continue;
      var Mrad = M * DEG_TO_RAD, Mprad = Mp * DEG_TO_RAD, Orad = O * DEG_TO_RAD;
      var F1 = F - 0.02665 * Math.sin(Orad);
      var F1rad = F1 * DEG_TO_RAD;
      var A1 = (299.77 + 0.107408 * k - 0.009173 * T2) * DEG_TO_RAD;
      // Compute gamma (distance of shadow axis from Earth center)
      var P = 0.2070 * Math.sin(Mrad) + 0.0024 * Math.sin(2 * Mrad)
            - 0.0392 * Math.sin(Mprad) + 0.0116 * Math.sin(2 * Mprad)
            - 0.0073 * Math.sin(Mrad + Mprad) + 0.0067 * Math.sin(Mprad - Mrad)
            + 0.0118 * Math.sin(2 * F1rad);
      var Q = 5.2207 - 0.0048 * Math.cos(Mrad) + 0.0020 * Math.cos(2 * Mrad)
            - 0.3299 * Math.cos(Mprad) + 0.0041 * Math.cos(Mrad + Mprad);
      // gamma = least distance of the shadow axis from Earth's center, in
      // Earth radii (Meeus Ch. 54). The old code dropped P and Q entirely
      // and used |sin F|, so gamma came out ~5x too small: every lunar
      // eclipse read "total", grazing solars lost their "partial" label, and
      // near-miss syzygies (real |gamma|>1.54) slipped through as phantom
      // eclipses (~1/year). Use the actual P·cosF1 + Q·sinF1 formula.
      var W2 = Math.abs(Math.cos(F1rad));
      var gam = Math.abs((P * Math.cos(F1rad) + Q * Math.sin(F1rad)) * (1 - 0.0048 * W2));
      // Must be within eclipse range
      if (isSolar && gam > 1.5433) continue;
      if (!isSolar && gam > 1.0944) continue;
      // Compute JDE corrections for the eclipse
      var dJDE;
      if (isSolar) {
        dJDE = -0.4075 * Math.sin(Mprad) + 0.1721 * Math.sin(Mrad)
             + 0.0161 * Math.sin(2 * Mprad) - 0.0097 * Math.sin(2 * F1rad)
             + 0.0073 * Math.sin(Mprad - Mrad) - 0.0050 * Math.sin(Mprad + Mrad)
             - 0.0023 * Math.sin(Mprad - 2 * F1rad) + 0.0021 * Math.sin(2 * Mrad)
             + 0.0012 * Math.sin(Mprad + 2 * F1rad) + 0.0006 * Math.sin(2 * Mprad + Mrad)
             - 0.0004 * Math.sin(3 * Mprad) - 0.0003 * Math.sin(Mrad + 2 * F1rad)
             + 0.0003 * Math.sin(A1) - 0.0002 * Math.sin(Mrad - 2 * F1rad)
             - 0.0002 * Math.sin(2 * Mprad - Mrad) + 0.0002 * Math.sin(Orad);
      } else {
        dJDE = -0.4065 * Math.sin(Mprad) + 0.1727 * Math.sin(Mrad)
             + 0.0161 * Math.sin(2 * Mprad) - 0.0097 * Math.sin(2 * F1rad)
             + 0.0073 * Math.sin(Mprad - Mrad) - 0.0050 * Math.sin(Mprad + Mrad)
             - 0.0023 * Math.sin(Mprad - 2 * F1rad) + 0.0021 * Math.sin(2 * Mrad)
             + 0.0012 * Math.sin(Mprad + 2 * F1rad) + 0.0006 * Math.sin(2 * Mprad + Mrad)
             - 0.0004 * Math.sin(3 * Mprad) - 0.0003 * Math.sin(Mrad + 2 * F1rad)
             + 0.0003 * Math.sin(A1) - 0.0002 * Math.sin(Mrad - 2 * F1rad)
             - 0.0002 * Math.sin(2 * Mprad - Mrad) + 0.0002 * Math.sin(Orad);
      }
      var eclJDE = JDE + dJDE;
      var eclDate = new Date((eclJDE - JD_UNIX_EPOCH) * MS_PER_DAY);
      if (eclDate < fromDate) continue;
      // Determine type
      var type;
      if (isSolar) {
        if (gam < 0.9972) {
          // Check if annular or total using Moon's horizontal parallax vs semidiameter
          var u = 0.0059 + 0.0046 * Math.cos(Mrad) - 0.0182 * Math.cos(Mprad) + 0.0004 * Math.cos(2 * Mprad) - 0.0005 * Math.cos(Mrad + Mprad);
          if (u < 0) type = t('alm_eclipse_total_solar');
          else if (u > 0.0047) type = t('alm_eclipse_annular_solar');
          else type = (gam < 0.9972 && u > 0 && u < 0.0047) ? t('alm_eclipse_hybrid_solar') : t('alm_eclipse_annular_solar');
        } else {
          type = t('alm_eclipse_partial_solar');
        }
      } else {
        if (gam < 0.4678) type = t('alm_eclipse_total_lunar');
        else if (gam < 1.0128) type = t('alm_eclipse_partial_lunar');
        else type = t('alm_eclipse_penumbral_lunar');
      }
      // No visibility region: naming one from sub-solar longitude alone was
      // wrong more often than right (the Aug 2026 Greenland/Iceland/Spain
      // totality read "Americas"). Real ground tracks need Besselian
      // elements — until then, show only what we can stand behind.
      var dateStr = eclDate.getFullYear() + '-' + String(eclDate.getMonth() + 1).padStart(2, '0') + '-' + String(eclDate.getDate()).padStart(2, '0');
      results.push({ date: dateStr, type: type, solar: isSolar });
    }
  }
  return results.slice(0, count);
}

function _renderAstroPanel(now) {
  var el = document.getElementById('almanac-astro');
  if (!el) return;

  var y = now.getFullYear();
  var dayOfYear = _dayOfYear(now);
  var daysInYear = ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;

  // Hemisphere-aware seasons: flip for southern hemisphere observers
  var obsLat = _getLocation().lat;
  var south = obsLat < 0;
  // Season labels follow the observer's hemisphere; the article key follows the
  // label (a "Summer" label in the south links the Summer article, not Winter).
  var Wk = south ? 'summer' : 'winter', Spk = south ? 'autumn' : 'spring';
  var Suk = south ? 'winter' : 'summer', Auk = south ? 'spring' : 'autumn';
  var W = south ? t('season_summer') : t('season_winter'), Sp = south ? t('season_autumn') : t('season_spring');
  var Su = south ? t('season_winter') : t('season_summer'), Au = south ? t('season_spring') : t('season_autumn');
  var _eq = _lterm('equinox', t('alm_equinox')), _sol = _lterm('solstice', t('alm_solstice'));
  // setFullYear (see _dayOfYear) so season boundaries land on the real year for
  // any epoch the time machine reaches, not the 1900s for years 0–99.
  function _dmy(yy, mo, dd) { var x = new Date(0); x.setFullYear(yy, mo, dd); x.setHours(0, 0, 0, 0); return x; }
  var seasonBounds = [
    { name: W, nameKey: Wk, start: _dmy(y - 1, 11, 21), end: _dmy(y, 2, 20), next: Sp + ' ' + _eq },
    { name: Sp, nameKey: Spk, start: _dmy(y, 2, 20), end: _dmy(y, 5, 21), next: Su + ' ' + _sol },
    { name: Su, nameKey: Suk, start: _dmy(y, 5, 21), end: _dmy(y, 8, 22), next: Au + ' ' + _eq },
    { name: Au, nameKey: Auk, start: _dmy(y, 8, 22), end: _dmy(y, 11, 21), next: W + ' ' + _sol },
    { name: W, nameKey: Wk, start: _dmy(y, 11, 21), end: _dmy(y + 1, 2, 20), next: Sp + ' ' + _eq }
  ];
  var season = null;
  for (var si = 0; si < seasonBounds.length; si++) {
    if (now >= seasonBounds[si].start && now < seasonBounds[si].end) {
      season = seasonBounds[si];
      season.progress = (now - season.start) / (season.end - season.start);
      season.daysUntilNext = Math.ceil((season.end - now) / MS_PER_DAY);
      break;
    }
  }

  var perihelion = _dmy(y, 0, 3);
  var daysSincePeri = (now - perihelion) / MS_PER_DAY;
  var earthSunDist = 149598023 * (1 - 0.0167 * Math.cos(daysSincePeri / 365.25 * 2 * Math.PI));
  var earthSunAU = (earthSunDist / 149597870.7).toFixed(4);

  var JD = _dateToJD(now.getTime());
  var T = _jdToJulianCentury(JD);
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
  var constellation = _lc(zodiac[zodiac.length - 1].name);
  for (var zi = zodiac.length - 1; zi >= 0; zi--) {
    if (sunLon >= zodiac[zi].start) { constellation = _lc(zodiac[zi].name); break; }
  }

  // Compute eclipses algorithmically — works for any date, forever
  var nextEclipses = _computeEclipses(now, 3);

  var html = '<div class="almanac-info-grid">';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + dayOfYear + ' / ' + daysInYear + '</div><div class="almanac-info-lbl">' + t('alm_day_of_year') + '</div></div>';
  if (season) {
    html += '<div class="almanac-info-item"><div class="almanac-info-val">' + _lseason(season.nameKey, season.name) + '</div><div class="almanac-info-lbl">' + t('alm_days_to_next', { n: season.daysUntilNext, next: season.next }) + '</div>' +
      '<div class="almanac-progress"><div class="almanac-progress-bar" style="width:' + Math.round(season.progress * 100) + '%"></div></div></div>';
  }
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + earthSunAU + ' ' + _lterm('astronomical_unit', 'AU') + '</div><div class="almanac-info-lbl">' + t('alm_earth_sun_dist') + '</div></div>';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + constellation + '</div><div class="almanac-info-lbl">' + t('alm_sun_constellation') + '</div></div>';
  html += '</div>';

  // Eclipse rows. The date string uses a plain YYYY-MM-DD that Date can't parse
  // for year 0, five-figure, or BCE years — skip any row that comes back invalid
  // rather than printing "Invalid Date / NaN days", and drop the whole section
  // if none survive. (We can't meaningfully date eclipses millennia out anyway.)
  var eclipseRows = '';
  for (var ei = 0; ei < nextEclipses.length; ei++) {
    var ec = nextEclipses[ei];
    var ecDate = new Date(ec.date + 'T00:00:00');
    if (isNaN(ecDate.getTime())) continue;
    var daysUntil = Math.ceil((ecDate - now) / MS_PER_DAY);
    if (!isFinite(daysUntil)) continue;
    var untilStr = daysUntil <= 0 ? t('alm_today') : daysUntil === 1 ? t('alm_tomorrow') : t('alm_n_days', { n: daysUntil });
    eclipseRows += '<div class="almanac-eclipse-row">' +
      '<div><span class="almanac-eclipse-type">' + _alLink(ec.solar ? 'eclipse:total_solar' : 'eclipse:total_lunar', ec.type) + '</span><br><span class="almanac-eclipse-date">' +
      ecDate.toLocaleDateString((typeof _currentLang !== 'undefined') ? _currentLang : undefined, { month: 'long', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="almanac-eclipse-until">' + untilStr + '</div></div>';
  }
  if (eclipseRows) {
    html += '<div style="margin-top:16px">';
    html += '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">' + t('alm_upcoming_eclipses') + '</div>';
    html += eclipseRows;
    html += '</div>';
  }

  el.innerHTML = html;
}

// ── Sun Map — world map with day/night terminator ──

// Eclipse simulator removed — needs proper Besselian elements for accuracy.
// See git history for the canvas-based eclipse visualization code.

var _sunMapImg = new Image();
var _sunMapLoaded = false;
_sunMapImg.onload = function() { _sunMapLoaded = true; _drawSunMap(); };
_sunMapImg.onerror = function() { _sunMapLoaded = false; };
_sunMapImg.src = '/static/world-map.svg?v=1';

var _sunMapCanvas = null;
var _sunMapCycle = { x: -999, y: -999, list: '', idx: 0 }; // click-cycle overlaps
var _sunMapFlashTimer = 0;

// Equirectangular projection helpers — the map spans the full -180..180 by
// -90..90 rectangle, so both are straight linear maps. Every point plotted on
// the map (cities, the picked location, the subsolar point, the time zone
// borders) goes through these two rather than repeating the arithmetic.
function _sunMapLonToX(lon, W) { return (lon + 180) / 360 * W; }
function _sunMapLatToY(lat, H) { return (90 - lat) / 180 * H; }

// ── Real time zone boundaries ──
// The actual, irregular civil zone borders — China spanning one zone, India's
// half-hour band, Australia's three-way split, the jagged date line — not the
// clean 15-degree solar meridians an almanac prints. Polylines and per-zone
// polygons come from /static/tz-borders.json (built by
// scripts/build-tz-borders.py from Natural Earth's public-domain 10m Time
// Zones; at sea the borders are the straight nautical meridians by
// definition, on land they follow the politics).
//
// The asset is fetched lazily the first time the map draws — never on app
// boot — and a miss is tolerated silently: the map simply has no borders
// until the network returns (the service worker's stale-while-revalidate
// /static/ route caches it after the first successful load, so offline
// visits after that get it from cache).
var _SM_TZ_STEP_HOURS = 3;      // label every N hours, widened when it gets tight
var _SM_TZ_LABEL_PITCH = 40;    // min CSS px between labels before widening

// Height of the strip along the bottom edge that carries the UTC labels. Sized
// off the map so it stays proportional, floored so the type never collides.
function _sunMapGutter(H, dpr) { return Math.max(12 * dpr, H * 0.07); }

// How many hours between labels at this width — 3, then 6, then 12, so the
// labels stay a readable distance apart down to phone widths.
function _sunMapLabelStep(W, dpr) {
  var pxPerHour = W / dpr / 24;
  var step = _SM_TZ_STEP_HOURS;
  while (step < 12 && pxPerHour * step < _SM_TZ_LABEL_PITCH) step += _SM_TZ_STEP_HOURS;
  return step;
}

// The map's unchanging layer: background, world image and the zone borders.
// None of it moves as time travels, so it is rendered once per size into an
// offscreen canvas and blitted each frame — which costs less than the old code
// paid to re-rasterise the SVG on every redraw, borders or not. The key
// carries the border-data flag so the layer rebuilds once when the lazy
// fetch lands.
var _sunMapBase = null;
var _sunMapBaseKey = '';

function _sunMapBaseLayer(W, H, dpr) {
  var key = W + 'x' + H + ':' + dpr + ':' + (_sunMapLoaded ? '1' : '0') + ':' + (_tzBorders ? '1' : '0');
  if (_sunMapBase && _sunMapBaseKey === key) return _sunMapBase;
  var cv = _sunMapBase || document.createElement('canvas');
  cv.width = W; cv.height = H;
  var c = cv.getContext('2d');
  c.fillStyle = '#0d1117';
  c.fillRect(0, 0, W, H);
  if (_sunMapLoaded) {
    // 0.45, up from the 0.40 the map launched with: the hairline zone borders
    // added a competing texture over the land, and at 0.40 the continents read
    // washed out underneath them. One step brighter keeps the muted night-map
    // voice while letting the coastlines win back the mid-ground.
    c.globalAlpha = 0.45;
    c.drawImage(_sunMapImg, 0, 0, W, H);
    c.globalAlpha = 1;
  }
  _sunMapDrawTzBorders(c, W, H, dpr);
  _sunMapBase = cv;
  _sunMapBaseKey = key;
  return cv;
}

// Lazy-loaded border polylines: each entry is a flat [lon, lat, lon, lat, ...]
// array, pre-split in the build script so no segment crosses the antimeridian
// (a crossing would stroke a streak across the whole map).
var _tzBorders = null;
var _tzBordersFetched = false;
var _tzBordersPath = null;
var _tzBordersPathKey = '';

function _tzBordersEnsure() {
  if (_tzBordersFetched) return;
  _tzBordersFetched = true;
  // ?v= matches the world-map.svg convention: /static/ is served immutable
  // for a year, so a regenerated asset must bump the version to bust caches.
  fetch('/static/tz-borders.json?v=2')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.lines || !data.lines.length) return;
      _tzBorders = data.lines;
      _tzZones = (data.zones && data.zones.length) ? data.zones : null;
      _tzZoneIdx = -2;       // re-resolve the highlight for the current pick
      _sunMapBaseKey = '';   // stale key → base layer rebuilds with borders
      _drawSunMap();
    })
    .catch(function () { /* offline before first cache fill — no borders */ });
}

// One Path2D per map size, projected through the shared lon/lat helpers so
// the borders stay registered with the terminator. Built only when the cached
// base layer rebuilds, then stamped with a single stroke — zero per-frame
// geometry cost.
function _tzBordersPathFor(W, H) {
  var key = W + 'x' + H;
  if (_tzBordersPath && _tzBordersPathKey === key) return _tzBordersPath;
  var p = new Path2D();
  for (var i = 0; i < _tzBorders.length; i++) {
    var line = _tzBorders[i];
    p.moveTo(_sunMapLonToX(line[0], W), _sunMapLatToY(line[1], H));
    for (var j = 2; j < line.length; j += 2) {
      p.lineTo(_sunMapLonToX(line[j], W), _sunMapLatToY(line[j + 1], H));
    }
  }
  _tzBordersPath = p;
  _tzBordersPathKey = key;
  return p;
}

// The real zone borders plus the label gutter under them. Hairline and
// low-contrast so the irregular shapes read as texture under the terminator,
// which stays the brightest line on the map.
function _sunMapDrawTzBorders(c, W, H, dpr) {
  var gutter = _sunMapGutter(H, dpr);
  var top = H - gutter;

  if (_tzBorders) {
    c.save();
    c.beginPath();
    c.rect(0, 0, W, top);    // keep strokes out of the label gutter
    c.clip();
    // A single device pixel (0.5 CSS px on 2x backing) at reduced alpha —
    // heavier reads as a grid fighting the terminator for attention.
    c.strokeStyle = 'rgba(210,180,120,0.13)';
    c.lineWidth = Math.max(0.5, 0.5 * dpr);
    c.lineJoin = 'round';
    c.stroke(_tzBordersPathFor(W, H));
    c.restore();
  }

  // Label gutter — a faint dark strip so the offsets read against the map.
  c.fillStyle = 'rgba(4,7,12,0.45)';
  c.fillRect(0, top, W, gutter);
  c.fillStyle = 'rgba(210,180,120,0.10)';
  c.fillRect(0, Math.round(top), W, Math.max(1, Math.round(dpr)));
}

// The UTC offsets. They belong on top of the night shading — sunk underneath it
// the labels on the dark half come out half as bright as the lit half — but
// they never move, so they are cached too. The strip is only as tall as the
// gutter, so this costs a few hundred KB less than a second full-size layer.
var _sunMapLabels = null;
var _sunMapLabelsKey = '';

// An offset's nominal meridian, wrapped into the map's -180..180 span: the
// +13/+14 zones (Tonga, Samoa, the Line Islands) physically sit WEST of the
// date line, so their strip position is the wrapped -165/-150, not an
// off-canvas 195/210. Shared by the minor ticks and the selected-zone label.
function _sunMapOffsetLon(offMin) {
  var lon = offMin / 4;                    // 60 min of offset = 15 deg of lon
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

// "UTC" at zero, otherwise a signed hour with minutes only when fractional:
// +5:30, -9:30, +14. Same voice as the integer strip labels.
function _sunMapOffsetLabel(offMin) {
  if (!offMin) return 'UTC';
  var a = Math.abs(offMin);
  var mm = a % 60;
  return (offMin < 0 ? '-' : '+') + Math.floor(a / 60) + (mm ? ':' + ('0' + mm).slice(-2) : '');
}

function _sunMapLabelStrip(W, H, dpr) {
  var gutter = Math.round(_sunMapGutter(H, dpr));
  // The zones flag mirrors the base layer's key: the minor ticks come from the
  // lazily fetched zone list, so the cached strip rebuilds once when it lands.
  var key = W + 'x' + gutter + ':' + dpr + ':' + (_tzZones ? '1' : '0');
  if (_sunMapLabels && _sunMapLabelsKey === key) return _sunMapLabels;
  var cv = _sunMapLabels || document.createElement('canvas');
  cv.width = W; cv.height = gutter;
  var c = cv.getContext('2d');
  c.clearRect(0, 0, W, gutter);
  c.font = Math.round(8.5 * dpr) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
  c.textBaseline = 'middle';
  var step = _sunMapLabelStep(W, dpr);
  for (var off = -12; off <= 12; off += step) {
    var x = _sunMapLonToX(off * 15, W);
    // The outermost labels straddle the canvas edge; anchor them inward.
    if (off <= -12) { c.textAlign = 'left'; x += 3 * dpr; }
    else if (off >= 12) { c.textAlign = 'right'; x -= 3 * dpr; }
    else c.textAlign = 'center';
    c.fillStyle = off === 0 ? 'rgba(245,158,11,0.80)' : 'rgba(210,180,120,0.45)';
    c.fillText(off === 0 ? 'UTC' : (off > 0 ? '+' + off : String(off)), x, gutter / 2);
  }
  // Minor ticks — one per real zone offset that has no integer label of its
  // own: the fractional zones (+5:30, +5:45, +9:30, -3:30 ...) and the +13/+14
  // extensions at their wrapped date-line positions. Forty labels can't fit as
  // text; a quiet tick marks that a zone lives between the printed hours, and
  // picking one lights its exact offset in amber (see
  // _sunMapDrawSelectedOffset).
  if (_tzZones) {
    c.strokeStyle = 'rgba(210,180,120,0.38)';
    c.lineWidth = Math.max(1, dpr);
    var seen = {};
    for (var zi = 0; zi < _tzZones.length; zi++) {
      var zo = _tzZones[zi][0];
      if (seen[zo] || (zo % 60 === 0 && zo >= -720 && zo <= 720)) continue;
      seen[zo] = 1;
      var tx = Math.round(_sunMapLonToX(_sunMapOffsetLon(zo), W)) + 0.5;
      c.beginPath();
      c.moveTo(tx, 0);
      c.lineTo(tx, gutter * 0.3);
      c.stroke();
    }
  }
  _sunMapLabels = cv;
  _sunMapLabelsKey = key;
  return cv;
}

function _sunMapDrawTzLabels(c, W, H, dpr) {
  var strip = _sunMapLabelStrip(W, H, dpr);
  c.drawImage(strip, 0, H - strip.height);
}

// The picked location's exact offset, amber on the strip: an integer-hour pick
// re-inks its label; a fractional pick gets the small amber "+5:30"-style
// label at its tick, where no text normally fits. The number shown is the LIVE
// offset of the resolved IANA zone (DST included) — the same figure the world
// clock prints for the place — not the polygon's nominal stamp, which for the
// stale-politics shapes (2010s Russia) can be an hour off today's truth.
function _sunMapDrawSelectedOffset(c, W, H, dpr) {
  if (!_sunMapHasLocation || !_sunMapNow) return;
  var off;
  try { off = _tzUtcOffsetMin(_almTzForLocation(_sunMapLat, _sunMapLon), _sunMapNow); }
  catch (e) { return; }
  if (off == null || isNaN(off)) return;
  var gutter = Math.round(_sunMapGutter(H, dpr));
  var top = H - gutter;
  var x = _sunMapLonToX(_sunMapOffsetLon(off), W);
  var label = _sunMapOffsetLabel(off);
  c.save();
  c.font = Math.round(8.5 * dpr) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  var pad = 3 * dpr;
  var tw = c.measureText(label).width;
  // The tick stands at the exact meridian; the label pill clamps inward so it
  // never leaves the canvas at the date-line edges.
  var lx = Math.max(tw / 2 + pad, Math.min(W - tw / 2 - pad, x));
  c.fillStyle = 'rgba(4,7,12,0.85)';
  c.fillRect(lx - tw / 2 - pad, top, tw + pad * 2, gutter);
  c.strokeStyle = 'rgba(245,158,11,0.95)';
  c.lineWidth = Math.max(1, dpr);
  c.beginPath();
  c.moveTo(Math.round(x) + 0.5, top);
  c.lineTo(Math.round(x) + 0.5, top + gutter * 0.3);
  c.stroke();
  c.fillStyle = 'rgba(245,158,11,0.95)';
  c.fillText(label, lx, top + gutter / 2 + gutter * 0.08);
  c.restore();
}

// The picked location's time zone, lit up as its TRUE shape — the polygon
// that CONTAINS the point, found by ray cast. Matching on the live UTC offset
// (the old band) can never be right year-round: in August Los Angeles runs
// UTC-7 under DST while its geographic zone is the standard-time -8 shape, so
// an offset-centred band misses the city for half the year. Containment is
// DST-proof. Natural Earth's zones cover the whole globe — nominal zones at
// sea, both poles — so every pick resolves; the nearest-vertex pass below
// only mops up hairline slivers between independently simplified neighbours.
var _tzZones = null;     // [[offsetMinutes, [flat unclosed ring, ...]], ...]
var _tzZoneIdx = -2;     // index into _tzZones; -1 = no zone, -2 = unresolved
var _tzZoneKey = '';     // "lat,lon" the cached index was resolved for
var _tzZonePath = null;  // cached Path2D of the winning zone's rings
var _tzZonePathKey = '';

// Even-odd ray cast over one zone's rings (flat [lon,lat,...], unclosed — the
// j-wraps-to-last-point seam supplies the closing edge). Holes and multi-part
// zones fall out of the even-odd rule for free.
function _tzZoneContains(rings, lon, lat) {
  var inside = false;
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r];
    for (var i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      var yi = ring[i + 1], yj = ring[j + 1];
      if ((yi > lat) !== (yj > lat) &&
          lon < (ring[j] - ring[i]) * (lat - yi) / (yj - yi) + ring[i]) inside = !inside;
    }
  }
  return inside;
}

// Which zone contains the pick. Runs at location-change time ONLY (the result
// is cached on the lat,lon key), never per frame — a full scan is ~5k vertices
// and the winner is stored until the pick moves. When no polygon contains the
// point (a sliver between simplified neighbours), the nearest ring vertex
// within 2 degrees decides; vertex pitch is ~0.25 deg, plenty for a sliver.
function _tzZoneFor(lat, lon) {
  var key = lat.toFixed(4) + ',' + lon.toFixed(4);
  if (_tzZoneIdx !== -2 && _tzZoneKey === key) return _tzZoneIdx;
  var idx = -1, i, r, ring, j;
  for (i = 0; i < _tzZones.length; i++) {
    if (_tzZoneContains(_tzZones[i][1], lon, lat)) { idx = i; break; }
  }
  if (idx < 0) {
    var best = 4;   // 2 deg squared — beyond that it is a data gap, not a sliver
    var cosLat = Math.cos(lat * DEG_TO_RAD);
    for (i = 0; i < _tzZones.length; i++) {
      var rings = _tzZones[i][1];
      for (r = 0; r < rings.length; r++) {
        ring = rings[r];
        for (j = 0; j < ring.length; j += 2) {
          var dlon = (ring[j] - lon) * cosLat, dlat = ring[j + 1] - lat;
          var dd = dlon * dlon + dlat * dlat;
          if (dd < best) { best = dd; idx = i; }
        }
      }
    }
  }
  _tzZoneIdx = idx;
  _tzZoneKey = key;
  return idx;
}

// One Path2D per zone per map size, through the shared projection helpers so
// the highlight stays registered with the borders and terminator. Rings never
// span the antimeridian (the build source keeps every ring inside -180..180),
// so closePath draws real zone edges, never a wrap streak.
function _tzZonePathFor(idx, W, H) {
  var key = idx + ':' + W + 'x' + H;
  if (_tzZonePath && _tzZonePathKey === key) return _tzZonePath;
  var p = new Path2D();
  var rings = _tzZones[idx][1];
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r];
    p.moveTo(_sunMapLonToX(ring[0], W), _sunMapLatToY(ring[1], H));
    for (var j = 2; j < ring.length; j += 2) {
      p.lineTo(_sunMapLonToX(ring[j], W), _sunMapLatToY(ring[j + 1], H));
    }
    p.closePath();
  }
  _tzZonePath = p;
  _tzZonePathKey = key;
  return p;
}

// A faint amber wash over the containing zone's shape with a slightly firmer
// outline — same voice the old band spoke in. Drawn over the night shading —
// under it the wash all but disappears on the dark half and the shape looks
// broken at the terminator.
function _sunMapDrawZoneHighlight(c, W, H, dpr) {
  if (!_sunMapHasLocation || !_tzZones) return;
  var idx = _tzZoneFor(_sunMapLat, _sunMapLon);
  if (idx < 0) return;
  var p = _tzZonePathFor(idx, W, H);
  c.save();
  c.beginPath();
  c.rect(0, 0, W, H - _sunMapGutter(H, dpr));  // keep out of the label gutter
  c.clip();
  c.fillStyle = 'rgba(245,158,11,0.09)';
  c.fill(p, 'evenodd');
  c.strokeStyle = 'rgba(245,158,11,0.30)';
  c.lineWidth = Math.max(0.75, 0.75 * dpr);
  c.lineJoin = 'round';
  c.stroke(p);
  c.restore();
}

// Brief label over the map naming the city just picked (and the cycle hint when
// several cities overlap). Recreated each time — the map re-renders on a pick.
function _sunMapFlash(text) {
  var wrap = document.getElementById('almanac-sunmap');
  if (!wrap) return;
  var el = document.createElement('div');
  el.className = 'sunmap-flash';
  el.textContent = text;
  wrap.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('show'); });
  clearTimeout(_sunMapFlashTimer);
  _sunMapFlashTimer = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2000);
}
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
  var smLoc = _getLocation();
  _sunMapLat = smLoc.lat; _sunMapLon = smLoc.lon;
  _sunMapLocName = smLoc.name;
  // A free click on open map (or a manual lat/lon entry) stores coordinates
  // with no city name — that pick is every bit as real as a snapped city, so
  // the marker, the zone highlight and the coordinate line key off STORED,
  // not off having a name. Keying off the name left arbitrary-point picks
  // invisible: the location changed but no marker or highlight ever drew.
  _sunMapHasLocation = smLoc.stored;

  // Compute sun info in the CLICKED location's timezone, not the device's
  // (F6) — resolve the point's zone the same way the world clock does.
  var _smOff;
  try { _smOff = _tzUtcOffsetMin(_almTzForLocation(_sunMapLat, _sunMapLon), _sunMapNow); }
  catch (e) { _smOff = -_sunMapNow.getTimezoneOffset(); }
  var sunInfo = _computeSunTimes(_sunMapNow, _sunMapLat, _sunMapLon, _smOff);

  var html = '<div style="margin-top:16px">';
  html += '<div style="position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--border);cursor:crosshair">';
  html += '<canvas id="almanac-sunmap-canvas" style="display:block;width:100%;height:auto"></canvas>';
  html += '</div>';

  // Location line — click city name to search, locate icon for GPS
  html += '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:6px;position:relative">';
  if (_sunMapHasLocation) {
    var locStr = _sunMapLocName ? _sunMapLocName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : _sunMapLat.toFixed(1) + '\u00b0, ' + _sunMapLon.toFixed(1) + '\u00b0';
    html += '<span id="almanac-loc-name" style="font-size:12px;color:var(--text2);cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block" onclick="_almShowCitySearch()" title="' + locStr + '">' + locStr + '</span>';
  } else {
    html += '<span id="almanac-loc-name" style="font-size:12px;color:var(--text3);cursor:pointer" onclick="_almShowCitySearch()" title="' + t('alm_set_location') + '">' + t('alm_set_location') + '</span>';
  }
  html += '<span onclick="_shareAlmanacLocation()" style="cursor:pointer;font-size:13px;color:var(--text3);opacity:0.7" title="' + t('alm_use_location') + '">\uD83D\uDCCD</span>';
  // Hidden city search — revealed on click
  html += '<div id="almanac-city-search-wrap" style="display:none;position:absolute;top:-2px;left:50%;transform:translateX(-50%);z-index:10">';
  html += '<input id="almanac-city-search" type="text" placeholder="' + t('alm_search_city') + '" ' +
    'style="width:260px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px" autocomplete="off">';
  html += '<div id="almanac-city-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-top:2px;max-height:200px;overflow-y:auto;z-index:10"></div>';
  html += '</div>';
  html += '</div>';

  // Timezone UI — analog clock with the digital box beside it (shorter),
  // world grid below
  html += '<div class="alm-tz-wrap">';
  html += '<div class="alm-tz-clock-side">';
  html += '<canvas id="almanac-tz-clock" width="180" height="180"></canvas>';
  html += '<div id="almanac-tz-label" class="alm-clock-info"></div>';
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

      // Collect every city within the snap radius, nearest first — then let
      // repeated clicks on the same spot cycle through them, so overlapping
      // cities (a dense region) are all reachable.
      var snapDist = 15 / rect.width * 360;
      var near = [];
      for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
        var c = _MAP_CITIES[ci];
        var dlat = lat - c.lat, dlon = (lon - c.lon) * Math.cos(lat * DEG_TO_RAD);
        var dd = Math.sqrt(dlat * dlat + dlon * dlon);
        if (dd < snapDist) near.push({ c: c, d: dd });
      }
      near.sort(function (a, b) { return a.d - b.d; });
      var snappedName = '';
      if (near.length) {
        var samePlace = Math.abs(clickX - _sunMapCycle.x) < 6 && Math.abs(clickY - _sunMapCycle.y) < 6;
        var keys = near.map(function (n) { return n.c.name; }).join('|');
        if (samePlace && keys === _sunMapCycle.list) {
          _sunMapCycle.idx = (_sunMapCycle.idx + 1) % near.length;
        } else {
          _sunMapCycle = { x: clickX, y: clickY, list: keys, idx: 0 };
        }
        var pick = near[_sunMapCycle.idx].c;
        lat = pick.lat; lon = pick.lon;
        snappedName = pick.name + (near.length > 1 ? '  (' + (_sunMapCycle.idx + 1) + '/' + near.length + ' · ' + t('alm_click_cycle') + ')' : '');
        _saveLocation(pick.lat, pick.lon, pick.name);
      } else {
        _sunMapCycle = { x: -999, y: -999, list: '', idx: 0 };
        _saveLocation(lat, lon, '');
      }
      // Refresh only the location-dependent panels in place — a full rebuild
      // wipes the scroll container and yanks the page upward on every click.
      _almRepaintFocus();
      // Flash which city we landed on (and the cycle hint) over the map.
      if (snappedName) _sunMapFlash(snappedName);
    };
  }

  // City search (revealed via _almShowCitySearch)
  var searchInput = document.getElementById('almanac-city-search');
  var resultsDiv = document.getElementById('almanac-city-results');
  if (searchInput && resultsDiv) {
    searchInput.oninput = function() {
      var q = searchInput.value.toLowerCase().trim();
      if (q.length < 2) { resultsDiv.style.display = 'none'; return; }
      // Search the plotted cities plus the wider search-only set (no dots).
      var pool = _MAP_CITIES.concat(_SEARCH_CITIES);
      var all = [], seen = {};
      for (var i = 0; i < pool.length; i++) {
        var name = pool[i].name.toLowerCase();
        if (seen[name]) continue; seen[name] = 1;   // dedup overlap between lists
        var idx = name.indexOf(q);
        if (idx === -1) continue;
        // Rank: 0 = city name starts with query, 1 = any part starts with, 2 = substring
        var rank = 2;
        if (idx === 0) rank = 0;
        else if (name.charAt(idx - 1) === ' ' || name.charAt(idx - 1) === ',') rank = 1;
        all.push({ city: pool[i], rank: rank });
      }
      all.sort(function(a, b) { return a.rank - b.rank; });
      var matches = all.slice(0, 8).map(function(m) { return m.city; });
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
            _saveLocation(city.lat, city.lon, city.name);
            _almRepaintFocus();   // location-only refresh, preserves scroll
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

// World coverage, west-to-east — every whole offset plus the common halves
// (Tehran +3:30, India +5:30, Kathmandu +5:45, Adelaide +9:30). Issue #28:
// the original list jumped London -> Cairo, so all of Central Europe and
// West Africa snapped to UK time.
var _TZ_CITIES = [
  { key: 'honolulu', tz: 'Pacific/Honolulu', lat: 21.31, lon: -157.86 },
  { key: 'anchorage', tz: 'America/Anchorage', lat: 61.22, lon: -149.90 },
  { key: 'los_angeles', tz: 'America/Los_Angeles', lat: 34.05, lon: -118.24 },
  { key: 'denver', tz: 'America/Denver', lat: 39.74, lon: -104.98 },
  { key: 'mexico_city', tz: 'America/Mexico_City', lat: 19.43, lon: -99.13 },
  { key: 'chicago', tz: 'America/Chicago', lat: 41.88, lon: -87.63 },
  { key: 'new_york', tz: 'America/New_York', lat: 40.71, lon: -74.01 },
  { key: 'buenos_aires', tz: 'America/Argentina/Buenos_Aires', lat: -34.60, lon: -58.38 },
  { key: 'sao_paulo', tz: 'America/Sao_Paulo', lat: -23.55, lon: -46.63 },
  { key: 'london', tz: 'Europe/London', lat: 51.51, lon: -0.13 },
  { key: 'paris', tz: 'Europe/Paris', lat: 48.86, lon: 2.35 },
  { key: 'lagos', tz: 'Africa/Lagos', lat: 6.52, lon: 3.38 },
  { key: 'cairo', tz: 'Africa/Cairo', lat: 30.04, lon: 31.24 },
  { key: 'johannesburg', tz: 'Africa/Johannesburg', lat: -26.20, lon: 28.05 },
  { key: 'moscow', tz: 'Europe/Moscow', lat: 55.76, lon: 37.62 },
  { key: 'tehran', tz: 'Asia/Tehran', lat: 35.69, lon: 51.39 },
  { key: 'dubai', tz: 'Asia/Dubai', lat: 25.20, lon: 55.27 },
  { key: 'karachi', tz: 'Asia/Karachi', lat: 24.86, lon: 67.01 },
  { key: 'mumbai', tz: 'Asia/Kolkata', lat: 19.08, lon: 72.88 },
  { key: 'kathmandu', tz: 'Asia/Kathmandu', lat: 27.72, lon: 85.32 },
  { key: 'dhaka', tz: 'Asia/Dhaka', lat: 23.81, lon: 90.41 },
  { key: 'bangkok', tz: 'Asia/Bangkok', lat: 13.76, lon: 100.50 },
  { key: 'singapore', tz: 'Asia/Singapore', lat: 1.35, lon: 103.82 },
  { key: 'shanghai', tz: 'Asia/Shanghai', lat: 31.23, lon: 121.47 },
  { key: 'tokyo', tz: 'Asia/Tokyo', lat: 35.68, lon: 139.69 },
  { key: 'adelaide', tz: 'Australia/Adelaide', lat: -34.93, lon: 138.60 },
  { key: 'sydney', tz: 'Australia/Sydney', lat: -33.87, lon: 151.21 },
  { key: 'auckland', tz: 'Pacific/Auckland', lat: -36.85, lon: 174.76 }
];

function _tzUtcOffsetMin(tz, now) {
  // Cached formatters (_tzFmt, en-US so the output stays Date-parseable):
  // this runs per travel frame via the head cards, and building two fresh
  // Intl.DateTimeFormat objects per call dominated that path.
  var fmtOpts = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false };
  var enFmt = function(z) { return _tzFmt(z, fmtOpts, 'en-US').format(now); };
  return Math.round((new Date(enFmt(tz)) - new Date(enFmt('UTC'))) / 60000);
}

// Anchor set for mapping an arbitrary lat/lon to a timezone. There is no
// offline tz database to consult, so resolution is nearest-anchor over real
// IANA zones. The world-clock GRID stays one-city-per-offset (_TZ_CITIES);
// resolution needs many more points, because a wide political zone with only a
// far anchor misroutes everything at its edges — Central European Time spans
// Madrid to Warsaw, and with Paris as the only CET anchor Germany landed on
// London (#28). Several zones therefore carry more than one anchor.
//
// Anchors are chosen so that a change is only ever additive: adding one can
// only alter results near itself, so each is validated against a fixed city
// list (tests/test_almanac_tz_resolution.cjs) that requires the resolved zone
// to match the true zone's UTC offset in BOTH January and July. Checking both
// is what catches a same-offset/different-DST mismatch, e.g. Phoenix standing
// in for Denver.
var _TZ_ANCHORS = [
  // Americas
  [21.31, -157.86, 'Pacific/Honolulu'], [61.22, -149.90, 'America/Anchorage'],
  [34.05, -118.24, 'America/Los_Angeles'], [49.28, -123.12, 'America/Vancouver'],
  [39.74, -104.99, 'America/Denver'], [35.08, -106.65, 'America/Denver'],
  [33.45, -112.07, 'America/Phoenix'], [53.55, -113.49, 'America/Edmonton'],
  [41.88, -87.63, 'America/Chicago'], [32.78, -96.80, 'America/Chicago'],
  [19.43, -99.13, 'America/Mexico_City'],
  [40.71, -74.01, 'America/New_York'], [35.78, -78.64, 'America/New_York'],
  [43.65, -79.38, 'America/Toronto'],
  [4.71, -74.07, 'America/Bogota'], [10.48, -66.90, 'America/Caracas'],
  [-12.05, -77.04, 'America/Lima'], [-16.50, -68.15, 'America/La_Paz'],
  [-33.45, -70.67, 'America/Santiago'], [-23.55, -46.63, 'America/Sao_Paulo'],
  [-34.60, -58.38, 'America/Argentina/Buenos_Aires'],
  [47.56, -52.71, 'America/St_Johns'], [-54.28, -36.51, 'Atlantic/South_Georgia'],
  [37.74, -25.67, 'Atlantic/Azores'],
  // Europe / Africa
  [64.15, -21.94, 'Atlantic/Reykjavik'], [51.51, -0.13, 'Europe/London'],
  [53.35, -6.26, 'Europe/Dublin'], [38.72, -9.14, 'Europe/Lisbon'],
  [40.42, -3.70, 'Europe/Madrid'], [41.39, 2.17, 'Europe/Madrid'],
  [36.72, -4.42, 'Europe/Madrid'], [48.86, 2.35, 'Europe/Paris'],
  [52.52, 13.40, 'Europe/Berlin'], [52.37, 4.90, 'Europe/Amsterdam'],
  [41.90, 12.50, 'Europe/Rome'], [47.37, 8.54, 'Europe/Zurich'],
  [52.23, 21.01, 'Europe/Warsaw'], [59.33, 18.06, 'Europe/Stockholm'],
  [59.91, 10.75, 'Europe/Oslo'], [44.79, 20.45, 'Europe/Belgrade'],
  [37.98, 23.73, 'Europe/Athens'], [60.17, 24.94, 'Europe/Helsinki'],
  [44.43, 26.10, 'Europe/Bucharest'], [50.45, 30.52, 'Europe/Kyiv'],
  [41.01, 28.98, 'Europe/Istanbul'], [55.76, 37.62, 'Europe/Moscow'],
  [59.93, 30.34, 'Europe/Moscow'],
  [6.52, 3.38, 'Africa/Lagos'], [5.60, -0.19, 'Africa/Accra'],
  [30.04, 31.24, 'Africa/Cairo'], [36.75, 3.06, 'Africa/Algiers'],
  [36.81, 10.18, 'Africa/Tunis'],
  [-1.29, 36.82, 'Africa/Nairobi'], [-26.20, 28.05, 'Africa/Johannesburg'],
  [33.57, -7.59, 'Africa/Casablanca'],
  // Asia / Middle East / Oceania
  [35.69, 51.39, 'Asia/Tehran'], [24.71, 46.68, 'Asia/Riyadh'],
  [33.31, 44.36, 'Asia/Baghdad'], [25.29, 51.53, 'Asia/Qatar'],
  [25.20, 55.27, 'Asia/Dubai'], [34.56, 69.21, 'Asia/Kabul'],
  [41.30, 69.24, 'Asia/Tashkent'],
  [24.86, 67.01, 'Asia/Karachi'], [33.68, 73.05, 'Asia/Karachi'],
  [19.08, 72.88, 'Asia/Kolkata'], [28.61, 77.21, 'Asia/Kolkata'],
  [27.72, 85.32, 'Asia/Kathmandu'],
  [23.81, 90.41, 'Asia/Dhaka'], [13.76, 100.50, 'Asia/Bangkok'],
  [21.03, 105.85, 'Asia/Ho_Chi_Minh'],
  [-6.21, 106.85, 'Asia/Jakarta'], [-5.13, 119.42, 'Asia/Makassar'],
  [1.35, 103.82, 'Asia/Singapore'],
  [22.32, 114.17, 'Asia/Hong_Kong'], [31.23, 121.47, 'Asia/Shanghai'],
  [29.56, 106.55, 'Asia/Shanghai'], [41.80, 123.43, 'Asia/Shanghai'],
  [14.60, 120.98, 'Asia/Manila'], [-31.95, 115.86, 'Australia/Perth'],
  [37.57, 126.98, 'Asia/Seoul'], [35.68, 139.69, 'Asia/Tokyo'],
  [-12.46, 130.85, 'Australia/Darwin'],
  [-34.93, 138.60, 'Australia/Adelaide'], [-27.47, 153.03, 'Australia/Brisbane'],
  [-37.81, 144.96, 'Australia/Melbourne'],
  [-33.87, 151.21, 'Australia/Sydney'], [-36.85, 174.76, 'Pacific/Auckland'],
  // Remote and fractional island zones, matching the map's remote-zone city
  // dots. Fiji and Apia carry anchors of their own even without dots: without
  // them Suva would fall to the new Noumea anchor (+11, an hour off) and
  // Samoa to Pago Pago (across a full-day offset gap).
  [-14.28, -170.70, 'Pacific/Pago_Pago'], [-13.83, -171.77, 'Pacific/Apia'],
  [-8.91, -140.10, 'Pacific/Marquesas'], [-31.68, 128.89, 'Australia/Eucla'],
  [-31.55, 159.08, 'Australia/Lord_Howe'], [-22.28, 166.46, 'Pacific/Noumea'],
  [-29.06, 167.96, 'Pacific/Norfolk'], [-17.77, 177.97, 'Pacific/Fiji'],
  [-43.95, -176.56, 'Pacific/Chatham'], [-21.14, -175.20, 'Pacific/Tongatapu'],
  [1.87, -157.43, 'Pacific/Kiritimati'],
  // Per-polygon map dots (Siberian belts, Greenland outposts, Indian Ocean
  // territories, Antarctic stations). Each dot whose nearest pre-existing
  // anchor lands on the wrong offset carries its own anchor here; the Gdansk
  // guard exists because the Kaliningrad anchor would otherwise capture it
  // (same shadow class as Suva/Apia above). Yangon's anchor also fixes a
  // pre-existing miss: without it Myanmar's +6:30 resolved to Bangkok's +7.
  [53.90, 27.56, 'Europe/Minsk'], [54.71, 20.51, 'Europe/Kaliningrad'],
  [54.35, 18.65, 'Europe/Warsaw'],
  [55.03, 82.92, 'Asia/Novosibirsk'], [52.29, 104.28, 'Asia/Irkutsk'],
  [62.03, 129.73, 'Asia/Yakutsk'], [67.55, 133.39, 'Asia/Vladivostok'],
  [43.12, 131.89, 'Asia/Vladivostok'], [53.02, 158.65, 'Asia/Kamchatka'],
  [64.42, -173.23, 'Asia/Anadyr'],
  [70.49, -21.97, 'America/Scoresbysund'], [76.77, -18.67, 'America/Danmarkshavn'],
  [46.78, -56.17, 'America/Miquelon'],
  [11.62, 92.73, 'Asia/Kolkata'], [16.87, 96.20, 'Asia/Yangon'],
  [-7.31, 72.41, 'Indian/Chagos'], [-12.19, 96.83, 'Indian/Cocos'],
  [-13.28, -176.17, 'Pacific/Wallis'], [28.21, -177.38, 'Pacific/Midway'],
  [-77.85, 166.67, 'Antarctica/McMurdo'], [-72.01, 2.53, 'Antarctica/Troll'],
  [-69.00, 39.58, 'Antarctica/Syowa'], [-67.60, 62.87, 'Antarctica/Mawson'],
  [-68.60, 78.20, 'Antarctica/Davis'], [-78.46, 106.84, 'Antarctica/Vostok'],
  [-66.28, 110.53, 'Antarctica/Casey'], [-66.66, 140.00, 'Antarctica/DumontDUrville'],
  [-67.57, -68.13, 'Antarctica/Rothera'], [-64.77, -64.05, 'Antarctica/Palmer']
];

// Longitude is compared in RAW degrees, deliberately not scaled by cos(lat).
// Scaling it is what a true surface distance wants, and it is wrong here:
// timezones are longitude bands, so shrinking the longitude term makes the one
// axis that actually determines the answer count for less, and the shrink grows
// without bound toward the poles. At Tromso's 69.7°N cos(lat) is 0.35, so being
// 6° of longitude adrift — a whole zone and a half — scored as 2°, and pure
// latitude proximity handed northern Norway to Helsinki, an hour east. Removing
// the factor also fixed Kiruna, Beijing and Tashkent, and regressed nothing.
function _almTzForLocation(lat, lon) {
  var best = null, bestD = Infinity;
  for (var i = 0; i < _TZ_ANCHORS.length; i++) {
    var a = _TZ_ANCHORS[i];
    var dlat = lat - a[0];
    var dlon = lon - a[1];
    var d = dlat * dlat + dlon * dlon;
    if (d < bestD) { bestD = d; best = a[2]; }
  }
  return best;
}

var _almSelectedTz = null; // null = local timezone

function _initTzClock(now) {
  var pillsEl = document.getElementById('almanac-tz-pills');
  if (!pillsEl) return;

  // Highlight the card for the user's (or selected) timezone. Match the
  // exact IANA zone first; otherwise the card sharing its current UTC offset
  // — a resolved zone like Europe/Berlin isn't a grid city, but it lines up
  // with the +2 column (Paris), so the right column still lights up.
  var userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var targetTz = _almSelectedTz || userTz;
  var targetOff = null;
  try { targetOff = _tzUtcOffsetMin(targetTz, now); } catch (e) {}
  var localMatch = -1;
  for (var i = 0; i < _TZ_CITIES.length; i++) {
    if (_TZ_CITIES[i].tz === targetTz) { localMatch = i; break; }
  }
  if (localMatch === -1 && targetOff !== null) {
    for (var i = 0; i < _TZ_CITIES.length; i++) {
      try { if (_tzUtcOffsetMin(_TZ_CITIES[i].tz, now) === targetOff) { localMatch = i; break; } } catch (e) {}
    }
  }

  // Render city cards with times
  var html = '';
  for (var i = 0; i < _TZ_CITIES.length; i++) {
    var tzc = _TZ_CITIES[i];
    var isActive = (i === localMatch);
    var tzTime = '';
    try { tzTime = _tzFmt(tzc.tz, { hour: 'numeric', minute: '2-digit', hour12: true }).format(now); } catch(e) { continue; }
    // Compute UTC offset — use en-US with full date+time for accurate diff
    var utcOff = '';
    try {
      var diffMin = _tzUtcOffsetMin(tzc.tz, now);
      var sign = diffMin >= 0 ? '+' : '\u2212';
      var absH = Math.floor(Math.abs(diffMin) / 60);
      var absM = Math.abs(diffMin) % 60;
      utcOff = 'UTC' + sign + absH + (absM ? ':' + (absM < 10 ? '0' : '') + absM : '');
      // Add the short zone name (PST, CET, JST) beside the offset ONLY when
      // it's a real abbreviation — a GMT/UTC offset alias (GMT, GMT+8,
      // UTC-5) just repeats the offset we already show.
      var znp = _tzFmt(tzc.tz, { timeZoneName: 'short', hour: 'numeric' }).formatToParts(now);
      for (var zpi = 0; zpi < znp.length; zpi++) {
        if (znp[zpi].type === 'timeZoneName') {
          var zn = znp[zpi].value;
          if (zn && !/^(GMT|UTC)([+\u2212-]|$)/.test(zn)) utcOff += ' \u00b7 ' + zn;
          break;
        }
      }
    } catch(e) {}
    var tzHour = 0;
    try { tzHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tzc.tz, hour: 'numeric', hour12: false }).format(now)); } catch(e) {}
    var phase = (tzHour < 5 || tzHour >= 21) ? 'night' : tzHour < 8 ? 'dawn' : tzHour < 18 ? 'day' : 'dusk';
    // Sun: solid unicode; moon: CSS crescent (the unicode moons render as
    // thin outlines at small sizes)
    var glyphHtml = phase === 'night'
      ? '<span class="alm-tz-glyph alm-glyph-moon" aria-hidden="true"></span>'
      : '<span class="alm-tz-glyph" aria-hidden="true">\u2600\ufe0e</span>';
    html += '<div class="alm-tz-city-card alm-tz-' + phase + (isActive ? ' alm-tz-city-active' : '') + '" onclick="_almSelectTz(\'' + tzc.tz + '\',' + i + ')">';
    html += glyphHtml;
    html += '<span class="alm-tz-city-name">' + t('alm_city_' + tzc.key) + '</span>';
    html += '<span class="alm-tz-city-time">' + tzTime + '</span>';
    html += '<span class="alm-tz-city-offset">' + utcOff + '</span>';
    html += '</div>';
  }
  pillsEl.innerHTML = html;

  // Draw the clock
  _drawTzClock(now);
}

function _almSelectTz(tz, idx) {
  // Clicking a world-clock city re-homes the almanac there: it drives the
  // analog preview clock AND sets the page location through the same setter the
  // sun-map picker uses, so the header clock, sun times, holidays and sky all
  // follow to that city.
  _almSelectedTz = tz;
  var city = _TZ_CITIES[idx];
  if (city) {
    _saveLocation(city.lat, city.lon, t('alm_city_' + city.key));
    _almRepaintFocus();   // location-only refresh, preserves scroll
  }
  _initTzClock(new Date());
  _drawTzClock(new Date());
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
    if (_TZ_CITIES[i].tz === tz) { tzLabel = t('alm_city_' + _TZ_CITIES[i].key); break; }
  }
  // If the user searched a specific city whose timezone matches, use their city name
  var storedLoc = _getLocation();
  if (storedLoc.name && (!_almSelectedTz || _almSelectedTz === tz)) {
    var cityOnly = storedLoc.name.split(',')[0].trim();
    if (cityOnly) tzLabel = cityOnly;
  }

  // Get time in selected timezone — use fractional seconds for smooth hand
  var h24 = 0, mins = 0, secs = 0;
  try {
    h24 = parseInt(_tzFmt(tz, { hour: 'numeric', hour12: false }).format(now));
    mins = parseInt(_tzFmt(tz, { minute: '2-digit' }).format(now).replace(/[^0-9]/g, ''));
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
    var angle = (i * 30 - 90) * DEG_TO_RAD;
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

  // Resolve CSS colors (cached — theme never changes without page reload)
  if (!_tzClockColors) {
    var textColor = '#e0e0e0', amberColor = '#f59e0b';
    try {
      var cs = getComputedStyle(canvas);
      var cv = cs.getPropertyValue('--text').trim();
      if (cv) textColor = cv;
      var av = cs.getPropertyValue('--amber').trim();
      if (av) amberColor = av;
    } catch(e) {}
    _tzClockColors = { text: textColor, amber: amberColor };
  }
  var textColor = _tzClockColors.text;
  var amberColor = _tzClockColors.amber;

  // Hour hand
  var hourAngle = ((h24 % 12) + mins / 60) * 30 - 90;
  var hourRad = hourAngle * DEG_TO_RAD;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(hourRad) * (r * 0.5), cy + Math.sin(hourRad) * (r * 0.5));
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Minute hand
  var minAngle = (mins + secs / 60) * 6 - 90;
  var minRad = minAngle * DEG_TO_RAD;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(minRad) * (r * 0.72), cy + Math.sin(minRad) * (r * 0.72));
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Second hand
  var secAngle = secs * 6 - 90;
  var secRad = secAngle * DEG_TO_RAD;
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
    var parts = [];
    try {
      parts = _tzFmt(tz, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(now);
    } catch(e) {}
    var hm = '', sec = '', ampm = '';
    for (var pi = 0; pi < parts.length; pi++) {
      var pt = parts[pi];
      if (pt.type === 'second') sec = pt.value;
      else if (pt.type === 'dayPeriod') ampm = pt.value;
      else if (pt.type === 'hour' || pt.type === 'minute') hm += pt.value;
      else if (pt.type === 'literal' && sec === '' && hm) hm += pt.value.trim() === '' ? '' : (pi < parts.length - 1 && parts[pi+1].type !== 'dayPeriod' ? pt.value : '');
    }
    hm = hm.replace(/:$/, '');
    var dateStr = '';
    try {
      dateStr = _tzFmt(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
    } catch(e) {}
    // Timezone abbreviation (PST, CET, GMT+8...) — encyclopedic honesty
    var tzAbbr = '';
    try {
      var tzp = _tzFmt(tz, { timeZoneName: 'short', hour: 'numeric' }).formatToParts(now);
      for (var ti = 0; ti < tzp.length; ti++) if (tzp[ti].type === 'timeZoneName') tzAbbr = tzp[ti].value;
    } catch(e) {}
    // Only a real abbreviation (PST, JST, CET) earns a slot next to the city
    // name; a GMT/UTC offset alias (GMT, GMT+4, UTC-5) says nothing new.
    if (/^(GMT|UTC)([+−-]|$)/.test(tzAbbr)) tzAbbr = '';
    // Only rebuild the shell when needed; the flip card ticks per second
    var secEl = document.getElementById('alm-clock-sec');
    if (!secEl || labelEl.dataset.tz !== tz) {
      labelEl.dataset.tz = tz;
      labelEl.innerHTML =
        '<div class="alm-clock-time"><span class="alm-clock-hm" id="alm-clock-hm"></span>' +
          '<span class="alm-clock-sec" id="alm-clock-sec"></span>' +
          '<span class="alm-clock-ampm" id="alm-clock-ampm">' + ampm + '</span></div>' +
        '<div class="alm-clock-date" id="alm-clock-date">' + dateStr + '</div>' +
        '<div class="alm-clock-sub"><span id="alm-clock-tzname">' + (tzLabel || '') + (tzAbbr ? ' \u00b7 ' + tzAbbr : '') + '</span></div>';
      _rollDigitStr(document.getElementById('alm-clock-hm'), hm);
      _rollDigitStr(document.getElementById('alm-clock-sec'), sec);
    } else {
      _rollDigitStr(document.getElementById('alm-clock-hm'), hm);
      var apEl = document.getElementById('alm-clock-ampm');
      if (apEl && apEl.textContent !== ampm) apEl.textContent = ampm;
      var dEl = document.getElementById('alm-clock-date');
      if (dEl && dEl.textContent !== dateStr) dEl.textContent = dateStr;
      var tnEl = document.getElementById('alm-clock-tzname');
      var tzText = (tzLabel || '') + (tzAbbr ? ' \u00b7 ' + tzAbbr : '');
      if (tnEl && tnEl.textContent !== tzText) tnEl.textContent = tzText;
      _rollDigitStr(document.getElementById('alm-clock-sec'), sec);
    }
  }
}

// Render/roll a clock string (seconds "42", or the hours:minutes "9:07") as
// independent digit columns: each digit is its own clipped roll column, each
// non-digit (the colon) a static separator. Column-count agnostic, so the same
// per-digit roll drives hours, minutes and seconds alike. The shell is rebuilt
// only when the column PATTERN changes -- e.g. 9:59 → 10:00 gains an hour digit
// -- so an ordinary tick just rolls the digits that actually changed, and
// _tickDigit's leak clamp keeps each column at ≤2 layers forever.
function _rollDigitStr(el, str) {
  if (!el) return;
  str = '' + str;
  var pattern = str.replace(/[0-9]/g, '#');
  if (el.dataset.pat !== pattern) {
    el.dataset.pat = pattern;
    var shell = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch >= '0' && ch <= '9') shell += '<span class="alm-clock-sec-col"><span class="alm-clock-sec-d">' + ch + '</span></span>';
      else shell += '<span class="alm-clock-sep">' + ch + '</span>';
    }
    el.innerHTML = shell;
    return;
  }
  var cols = el.querySelectorAll('.alm-clock-sec-col');
  var ci = 0;
  for (var j = 0; j < str.length; j++) {
    var c = str.charAt(j);
    if (c >= '0' && c <= '9') { _tickDigit(cols[ci], c); ci++; }
  }
}

// Animate one clock digit column (seconds, minutes or hours): the old value
// slides/fades up and out, the new value rises in from below — a clean counting
// tick, transform+opacity only (no layout shift; the column clips the vertical
// travel). Honours prefers-reduced-motion by swapping the text instantly.
// Called per digit so a column only animates when ITS value changes.
function _tickDigit(colEl, ch) {
  if (!colEl) return;
  var digits = colEl.querySelectorAll('.alm-clock-sec-d');
  // Leak clamp: at any instant we want at most two layers — the current digit
  // plus one outgoing mid-animation. querySelectorAll returns document order,
  // so the LAST span is always the authoritative current value; earlier spans
  // are outgoing layers. Drop everything older than those two so a missed
  // animationend (backgrounded tab, interrupted transition) can never stack up
  // permanent inline spans and grow the clock horizontally.
  for (var i = 0; i < digits.length - 2; i++) {
    if (digits[i].parentNode) digits[i].parentNode.removeChild(digits[i]);
  }
  var cur = digits.length ? digits[digits.length - 1] : null;
  if (!cur) { colEl.innerHTML = '<span class="alm-clock-sec-d">' + ch + '</span>'; return; }
  // Reading the last span (not the first) is what stops per-frame stacking:
  // once the incoming digit is appended it becomes `cur`, and every remaining
  // RAF frame this second short-circuits here instead of appending again.
  if (cur.textContent === ch) return;
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (reduce) { cur.textContent = ch; return; }
  var incoming = document.createElement('span');
  incoming.className = 'alm-clock-sec-d alm-sec-in';
  incoming.textContent = ch;
  incoming.addEventListener('animationend', function () { incoming.classList.remove('alm-sec-in'); }, { once: true });
  cur.classList.add('alm-sec-out');
  cur.addEventListener('animationend', function () { if (cur.parentNode) cur.parentNode.removeChild(cur); }, { once: true });
  colEl.appendChild(incoming);
}


// Cached Intl.DateTimeFormat objects — avoid 180+ allocations/sec in the RAF
// loop. Constructing a formatter costs ~1ms; .format() on a cached one is
// microseconds, so every per-frame path (travel clock, head cards, the dock's
// readouts) must come through here rather than calling toLocale*String, each
// of which builds a fresh formatter internally. tz may be null/undefined for
// the device zone; lang overrides the UI language (e.g. the offset math needs
// 'en-US' for a parseable date string).
var _tzFmtCache = {};
function _tzFmt(tz, opts, lang) {
  lang = lang || ((typeof _currentLang !== 'undefined') ? _currentLang : 'en');
  // JSON key, not Object.values().join: two option sets with different keys
  // but the same values ("numeric,2-digit") must not share a formatter.
  var key = lang + '|' + (tz || '') + '|' + JSON.stringify(opts);
  if (!_tzFmtCache[key]) {
    var o = Object.assign({}, opts);
    if (tz) o.timeZone = tz;
    _tzFmtCache[key] = new Intl.DateTimeFormat(lang, o);
  }
  return _tzFmtCache[key];
}

// Smooth clock animation using requestAnimationFrame
var _tzClockRAF = null;
var _tzClockColors = null;
var _tzGridMinute = -1;
function _startTzClock() {
  if (_tzClockRAF) cancelAnimationFrame(_tzClockRAF);
  function tick() {
    if (!_almanacOpen) { _tzClockRAF = null; return; }
    var now = new Date();
    _drawTzClock(now);
    // City cards rendered once and went stale within minutes — refresh
    // the grid on each minute rollover (cheap: 28 cards, 1x/min)
    if (now.getMinutes() !== _tzGridMinute) {
      _tzGridMinute = now.getMinutes();
      _initTzClock(now);
      // Keep the time machine's ACTUAL row ticking (HH:MM resolution, so a
      // once-per-minute refresh is enough) while parked in the past/future —
      // and with it the offset lamp, which is measured against that row.
      _almTmSetCells('alm-tm-now', now);
      _almTmSetDelta('alm-tm-delta', _almFocusInstant());
    }
    _tzClockRAF = requestAnimationFrame(tick);
  }
  _tzClockRAF = requestAnimationFrame(tick);
}

// tzOffsetMin: the LOCATION's UTC offset in minutes. Passed by the Sun Map
// (which can click any city) so times render in that city's zone, not the
// device's (F6). Omitted → the device's offset (own-location card).
function _computeSunTimes(now, lat, lon, tzOffsetMin) {
  // Fractional day-of-year near local noon + 365.25 (F7): declination/EoT are
  // evaluated closer to the actual event than local midnight.
  var B = (_dayOfYear(now) - 0.5) * 2 * Math.PI / 365.25;
  var EoT = _eqOfTime(B);
  var decl = _solarDeclination(B);
  var latRad = lat * DEG_TO_RAD, cd = Math.cos(latRad), sd = Math.sin(latRad);
  var tzOffset = (typeof tzOffsetMin === 'number') ? tzOffsetMin : -now.getTimezoneOffset();
  // Minutes-of-day for the morning/evening crossings of a given sun-center
  // depression below the horizon (deg). 0.833 = refraction + semidiameter;
  // negative = above the horizon (golden hour).
  function cross(depressDeg) {
    var cosHA = (Math.cos((90 + depressDeg) * DEG_TO_RAD) - sd * Math.sin(decl)) / (cd * Math.cos(decl));
    if (cosHA > 1 || cosHA < -1) return null;
    var HA = Math.acos(cosHA) * 180 / Math.PI;
    return { rise: 720 - 4 * (lon + HA) - EoT + tzOffset, set: 720 - 4 * (lon - HA) - EoT + tzOffset };
  }
  var sun = cross(0.833);
  if (!sun) {
    var cosH0 = (Math.cos(90.833 * DEG_TO_RAD) - sd * Math.sin(decl)) / (cd * Math.cos(decl));
    return { polar: cosH0 > 1 ? t('alm_polar_night') : t('alm_midnight_sun') };
  }
  var dayLength = sun.set - sun.rise;
  var result = {
    sunrise: _fmtMinutes(sun.rise),
    sunset: _fmtMinutes(sun.set),
    dayLength: _fmtDuration(Math.floor(dayLength / 60), Math.round(dayLength % 60))
  };
  var gold = cross(-6);
  if (gold) result.goldenHour = _fmtMinutes(gold.set);
  // Twilight bands (F8): sun-center 6/12/18 deg below the horizon.
  var civ = cross(6), naut = cross(12), astr = cross(18);
  if (civ)  { result.civilDawn = _fmtMinutes(civ.rise);   result.civilDusk = _fmtMinutes(civ.set); }
  if (naut) { result.nauticalDawn = _fmtMinutes(naut.rise); result.nauticalDusk = _fmtMinutes(naut.set); }
  if (astr) { result.astroDawn = _fmtMinutes(astr.rise);   result.astroDusk = _fmtMinutes(astr.set); }
  return result;
}

function _drawSunMap() {
  if (!_sunMapCanvas || !_sunMapNow) return;
  var ctx = _sunMapCanvas.getContext('2d');
  var W = _sunMapCanvas.width, H = _sunMapCanvas.height;
  var dpr = window.devicePixelRatio || 1;
  // The panel can be rendered before it has been laid out (a hidden ancestor
  // leaves clientWidth at 0), and a zero-area cache layer is an illegal
  // drawImage source — it throws where drawing the map image straight to the
  // context used to be a silent no-op. Bail out instead: there is nothing to
  // paint, and throwing here would abort _renderSunMap before it binds the
  // click-to-set-location handler.
  if (!W || !H) return;

  // First draw kicks off the border fetch; when it lands the base layer is
  // invalidated and this repaints with the borders in place.
  _tzBordersEnsure();

  // Background, world image and the real time zone borders, all cached
  ctx.drawImage(_sunMapBaseLayer(W, H, dpr), 0, 0);

  // Compute sun subsolar point
  var now = _sunMapNow;
  var doy = _dayOfYear(now);
  var B = _solarB(doy);
  var decl = _solarDeclination(B);
  var declDeg = decl * 180 / Math.PI;
  var utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  var sunLon = -(utcH - 12) * 15;

  // Draw day/night terminator
  var termPoints = [];
  for (var px = 0; px < W; px++) {
    var lon = (px / W) * 360 - 180;
    var dlon = (lon - sunLon) * DEG_TO_RAD;
    var termLat = Math.atan(-Math.cos(dlon) / Math.tan(decl)) * 180 / Math.PI;
    termPoints.push({ x: px, y: _sunMapLatToY(termLat, H) });
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

  // Time zone reference — the picked zone's true shape, then the UTC offsets,
  // then the picked zone's exact offset lit amber over the strip. All sit
  // above the night shading so none is swallowed by it.
  _sunMapDrawZoneHighlight(ctx, W, H, dpr);
  _sunMapDrawTzLabels(ctx, W, H, dpr);
  _sunMapDrawSelectedOffset(ctx, W, H, dpr);

  // Sub-solar point — where the sun is directly overhead right now
  var sunX = _sunMapLonToX(((sunLon + 180 + 360) % 360) - 180, W);
  var sunY = _sunMapLatToY(declDeg, H);
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
    var cx = _sunMapLonToX(c.lon, W);
    var cy = _sunMapLatToY(c.lat, H);
    ctx.beginPath();
    ctx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(210,180,120,0.5)';
    ctx.fill();
  }

  // Current location marker — only if explicitly set
  if (_sunMapHasLocation) {
    var locX = _sunMapLonToX(_sunMapLon, W);
    var locY = _sunMapLatToY(_sunMapLat, H);
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
  var loc = _getLocation();
  _initSkyScene(now, loc.lat, loc.lon);
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
      // Find nearest city for a descriptive name
      var locData = { lat: lat, lon: lon };
      var bestDist = Infinity;
      for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
        var dlat = lat - _MAP_CITIES[ci].lat;
        var dlon = (lon - _MAP_CITIES[ci].lon) * Math.cos(lat * DEG_TO_RAD);
        var d = dlat * dlat + dlon * dlon;
        if (d < bestDist) { bestDist = d; locData.name = _MAP_CITIES[ci].name; }
      }
      // Only use city name if reasonably close (within ~2 degrees)
      if (bestDist > 4) delete locData.name;
      _saveLocation(locData.lat, locData.lon, locData.name);
      _almRepaintFocus();   // location-only refresh, preserves scroll
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
  { name: 'New York, New York, United States', lat: 40.71, lon: -74.01 },
  { name: 'Los Angeles, California, United States', lat: 34.05, lon: -118.24 },
  { name: 'Chicago, Illinois, United States', lat: 41.88, lon: -87.63 },
  { name: 'Houston, Texas, United States', lat: 29.76, lon: -95.37 },
  { name: 'Phoenix, Arizona, United States', lat: 33.45, lon: -112.07 },
  { name: 'Philadelphia, Pennsylvania, United States', lat: 39.95, lon: -75.17 },
  { name: 'San Antonio, Texas, United States', lat: 29.42, lon: -98.49 },
  { name: 'San Diego, California, United States', lat: 32.72, lon: -117.16 },
  { name: 'Dallas, Texas, United States', lat: 32.78, lon: -96.80 },
  { name: 'San Francisco, California, United States', lat: 37.77, lon: -122.42 },
  { name: 'Seattle, Washington, United States', lat: 47.61, lon: -122.33 },
  { name: 'Denver, Colorado, United States', lat: 39.74, lon: -104.99 },
  { name: 'Washington DC, United States', lat: 38.91, lon: -77.04 },
  { name: 'Boston, Massachusetts, United States', lat: 42.36, lon: -71.06 },
  { name: 'Atlanta, Georgia, United States', lat: 33.75, lon: -84.39 },
  { name: 'Miami, Florida, United States', lat: 25.76, lon: -80.19 },
  { name: 'Minneapolis, Minnesota, United States', lat: 44.98, lon: -93.27 },
  { name: 'Portland, Oregon, United States', lat: 45.52, lon: -122.68 },
  { name: 'Las Vegas, Nevada, United States', lat: 36.17, lon: -115.14 },
  { name: 'Honolulu, Hawaii, United States', lat: 21.31, lon: -157.86 },
  { name: 'Anchorage, Alaska, United States', lat: 61.22, lon: -149.90 },
  { name: 'Toronto, Ontario, Canada', lat: 43.65, lon: -79.38 },
  { name: 'Montreal, Quebec, Canada', lat: 45.50, lon: -73.57 },
  { name: 'Vancouver, British Columbia, Canada', lat: 49.28, lon: -123.12 },
  { name: 'Mexico City, Mexico', lat: 19.43, lon: -99.13 },
  { name: 'Guadalajara, Jalisco, Mexico', lat: 20.67, lon: -103.35 },
  { name: 'Havana, Cuba', lat: 23.11, lon: -82.37 },
  { name: 'San Juan, Puerto Rico', lat: 18.47, lon: -66.11 },
  { name: 'St. John’s, Newfoundland, Canada', lat: 47.56, lon: -52.71 },
  // South America
  { name: 'S\u00e3o Paulo, Brazil', lat: -23.55, lon: -46.63 },
  { name: 'Rio de Janeiro, Brazil', lat: -22.91, lon: -43.17 },
  { name: 'Buenos Aires, Argentina', lat: -34.60, lon: -58.38 },
  { name: 'Bogot\u00e1, Colombia', lat: 4.71, lon: -74.07 },
  { name: 'Lima, Peru', lat: -12.05, lon: -77.04 },
  { name: 'Santiago, Chile', lat: -33.45, lon: -70.67 },
  { name: 'Caracas, Venezuela', lat: 10.49, lon: -66.90 },
  { name: 'Quito, Ecuador', lat: -0.18, lon: -78.47 },
  { name: 'Montevideo, Uruguay', lat: -34.88, lon: -56.17 },
  { name: 'Medell\u00edn, Colombia', lat: 6.25, lon: -75.56 },
  // Europe
  { name: 'London, England, United Kingdom', lat: 51.51, lon: -0.13 },
  { name: 'Paris, France', lat: 48.86, lon: 2.35 },
  { name: 'Berlin, Germany', lat: 52.52, lon: 13.40 },
  { name: 'Madrid, Spain', lat: 40.42, lon: -3.70 },
  { name: 'Rome, Italy', lat: 41.90, lon: 12.50 },
  { name: 'Amsterdam, Netherlands', lat: 52.37, lon: 4.90 },
  { name: 'Vienna, Austria', lat: 48.21, lon: 16.37 },
  { name: 'Prague, Czech Republic', lat: 50.08, lon: 14.44 },
  { name: 'Brussels, Belgium', lat: 50.85, lon: 4.35 },
  { name: 'Stockholm, Sweden', lat: 59.33, lon: 18.07 },
  { name: 'Oslo, Norway', lat: 59.91, lon: 10.75 },
  { name: 'Copenhagen, Denmark', lat: 55.68, lon: 12.57 },
  { name: 'Helsinki, Finland', lat: 60.17, lon: 24.94 },
  { name: 'Dublin, Ireland', lat: 53.35, lon: -6.26 },
  { name: 'Lisbon, Portugal', lat: 38.72, lon: -9.14 },
  { name: 'Barcelona, Spain', lat: 41.39, lon: 2.17 },
  { name: 'Munich, Bavaria, Germany', lat: 48.14, lon: 11.58 },
  { name: 'Milan, Italy', lat: 45.46, lon: 9.19 },
  { name: 'Zurich, Switzerland', lat: 47.38, lon: 8.54 },
  { name: 'Warsaw, Poland', lat: 52.23, lon: 21.01 },
  { name: 'Budapest, Hungary', lat: 47.50, lon: 19.04 },
  { name: 'Athens, Greece', lat: 37.98, lon: 23.73 },
  { name: 'Bucharest, Romania', lat: 44.43, lon: 26.10 },
  { name: 'Moscow, Russia', lat: 55.76, lon: 37.62 },
  { name: 'St. Petersburg, Russia', lat: 59.93, lon: 30.32 },
  { name: 'Kyiv, Ukraine', lat: 50.45, lon: 30.52 },
  { name: 'Istanbul, Turkey', lat: 41.01, lon: 28.98 },
  { name: 'Edinburgh, Scotland, United Kingdom', lat: 55.95, lon: -3.19 },
  { name: 'Reykjavik, Iceland', lat: 64.15, lon: -21.94 },
  // Middle East
  { name: 'Dubai, United Arab Emirates', lat: 25.20, lon: 55.27 },
  { name: 'Riyadh, Saudi Arabia', lat: 24.71, lon: 46.67 },
  { name: 'Doha, Qatar', lat: 25.29, lon: 51.53 },
  { name: 'Tehran, Iran', lat: 35.69, lon: 51.39 },
  { name: 'Baghdad, Iraq', lat: 33.31, lon: 44.37 },
  { name: 'Tel Aviv, Israel', lat: 32.09, lon: 34.78 },
  { name: 'Jerusalem, Israel', lat: 31.77, lon: 35.23 },
  { name: 'Amman, Jordan', lat: 31.95, lon: 35.93 },
  { name: 'Beirut, Lebanon', lat: 33.89, lon: 35.50 },
  { name: 'Muscat, Oman', lat: 23.59, lon: 58.54 },
  // Africa
  { name: 'Cairo, Egypt', lat: 30.04, lon: 31.24 },
  { name: 'Lagos, Nigeria', lat: 6.52, lon: 3.38 },
  { name: 'Nairobi, Kenya', lat: -1.29, lon: 36.82 },
  { name: 'Cape Town, South Africa', lat: -33.93, lon: 18.42 },
  { name: 'Johannesburg, South Africa', lat: -26.20, lon: 28.04 },
  { name: 'Casablanca, Morocco', lat: 33.59, lon: -7.62 },
  { name: 'Accra, Ghana', lat: 5.56, lon: -0.19 },
  { name: 'Addis Ababa, Ethiopia', lat: 9.02, lon: 38.75 },
  { name: 'Dar es Salaam, Tanzania', lat: -6.79, lon: 39.28 },
  { name: 'Kinshasa, Democratic Republic of the Congo', lat: -4.32, lon: 15.31 },
  { name: 'Algiers, Algeria', lat: 36.75, lon: 3.04 },
  { name: 'Tunis, Tunisia', lat: 36.81, lon: 10.18 },
  { name: 'Dakar, Senegal', lat: 14.69, lon: -17.44 },
  { name: 'Kampala, Uganda', lat: 0.35, lon: 32.58 },
  // South Asia
  { name: 'Mumbai, Maharashtra, India', lat: 19.08, lon: 72.88 },
  { name: 'Delhi, India', lat: 28.61, lon: 77.21 },
  { name: 'Bangalore, Karnataka, India', lat: 12.97, lon: 77.59 },
  { name: 'Chennai, Tamil Nadu, India', lat: 13.08, lon: 80.27 },
  { name: 'Kolkata, West Bengal, India', lat: 22.57, lon: 88.36 },
  { name: 'Karachi, Sindh, Pakistan', lat: 24.86, lon: 67.01 },
  { name: 'Lahore, Punjab, Pakistan', lat: 31.55, lon: 74.35 },
  { name: 'Dhaka, Bangladesh', lat: 23.81, lon: 90.41 },
  { name: 'Colombo, Sri Lanka', lat: 6.93, lon: 79.85 },
  { name: 'Kathmandu, Nepal', lat: 27.72, lon: 85.32 },
  // East & Southeast Asia
  { name: 'Beijing, China', lat: 39.90, lon: 116.40 },
  { name: 'Shanghai, China', lat: 31.23, lon: 121.47 },
  { name: 'Guangzhou, Guangdong, China', lat: 23.13, lon: 113.26 },
  { name: 'Shenzhen, Guangdong, China', lat: 22.54, lon: 114.06 },
  { name: 'Hong Kong, China', lat: 22.32, lon: 114.17 },
  { name: 'Tokyo, Japan', lat: 35.68, lon: 139.69 },
  { name: 'Osaka, Japan', lat: 34.69, lon: 135.50 },
  { name: 'Seoul, South Korea', lat: 37.57, lon: 126.98 },
  { name: 'Taipei, Taiwan', lat: 25.03, lon: 121.57 },
  { name: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Bangkok, Thailand', lat: 13.76, lon: 100.50 },
  { name: 'Jakarta, Indonesia', lat: -6.21, lon: 106.85 },
  { name: 'Manila, Philippines', lat: 14.60, lon: 120.98 },
  { name: 'Ho Chi Minh City, Vietnam', lat: 10.82, lon: 106.63 },
  { name: 'Hanoi, Vietnam', lat: 21.03, lon: 105.85 },
  { name: 'Kuala Lumpur, Malaysia', lat: 3.14, lon: 101.69 },
  { name: 'Yangon, Myanmar', lat: 16.87, lon: 96.20 },
  { name: 'Phnom Penh, Cambodia', lat: 11.56, lon: 104.93 },
  // Central Asia
  { name: 'Kabul, Afghanistan', lat: 34.56, lon: 69.21 },
  { name: 'Tashkent, Uzbekistan', lat: 41.30, lon: 69.28 },
  { name: 'Almaty, Kazakhstan', lat: 43.24, lon: 76.95 },
  { name: 'Tbilisi, Georgia', lat: 41.69, lon: 44.80 },
  { name: 'Baku, Azerbaijan', lat: 40.41, lon: 49.87 },
  // Oceania
  { name: 'Sydney, New South Wales, Australia', lat: -33.87, lon: 151.21 },
  { name: 'Melbourne, Victoria, Australia', lat: -37.81, lon: 144.96 },
  { name: 'Brisbane, Queensland, Australia', lat: -27.47, lon: 153.03 },
  { name: 'Perth, Western Australia, Australia', lat: -31.95, lon: 115.86 },
  { name: 'Adelaide, South Australia, Australia', lat: -34.93, lon: 138.60 },
  { name: 'Auckland, New Zealand', lat: -36.85, lon: 174.76 },
  { name: 'Wellington, New Zealand', lat: -41.29, lon: 174.78 },
  { name: 'Suva, Fiji', lat: -17.77, lon: 177.97 },
  // Remote-zone representatives: with these, every UTC offset the real zone
  // map carries (fractional and island zones included) has at least one
  // clickable dot, except uninhabited UTC-12 open ocean. Each is gated by the
  // per-offset coverage check in tests/test_tz_borders.cjs.
  { name: 'Pago Pago, American Samoa', lat: -14.28, lon: -170.70 },
  { name: 'Taiohae, Marquesas Islands, French Polynesia', lat: -8.91, lon: -140.10 },
  { name: 'Grytviken, South Georgia', lat: -54.28, lon: -36.51 },
  { name: 'Ponta Delgada, Azores, Portugal', lat: 37.74, lon: -25.67 },
  { name: 'Eucla, Western Australia, Australia', lat: -31.68, lon: 128.89 },
  { name: 'Lord Howe Island, New South Wales, Australia', lat: -31.55, lon: 159.08 },
  { name: 'Nouméa, New Caledonia', lat: -22.28, lon: 166.46 },
  { name: 'Kingston, Norfolk Island', lat: -29.06, lon: 167.96 },
  { name: 'Waitangi, Chatham Islands, New Zealand', lat: -43.95, lon: -176.56 },
  { name: 'Nukuʻalofa, Tonga', lat: -21.14, lon: -175.20 },
  { name: 'Kiritimati, Line Islands, Kiribati', lat: 1.87, lon: -157.43 },
  // Per-POLYGON representatives: the offset coverage above still left whole
  // zone polygons with no dot inside them (Siberia's belts, Belarus, the
  // Indian Ocean territories, Greenland's outposts, the Antarctic stations).
  // One settlement per tappable polygon; tests/test_tz_borders.cjs enumerates
  // every polygon and holds the documented exemption list to uninhabited
  // ocean/ice sectors and sub-tap-size slivers.
  { name: 'Minsk, Belarus', lat: 53.90, lon: 27.56 },
  { name: 'Kaliningrad, Russia', lat: 54.71, lon: 20.51 },
  { name: 'Novosibirsk, Russia', lat: 55.03, lon: 82.92 },
  { name: 'Irkutsk, Russia', lat: 52.29, lon: 104.28 },
  { name: 'Yakutsk, Sakha Republic, Russia', lat: 62.03, lon: 129.73 },
  { name: 'Verkhoyansk, Sakha Republic, Russia', lat: 67.55, lon: 133.39 },
  { name: 'Vladivostok, Russia', lat: 43.12, lon: 131.89 },
  { name: 'Petropavlovsk-Kamchatsky, Russia', lat: 53.02, lon: 158.65 },
  { name: 'Provideniya, Chukotka, Russia', lat: 64.42, lon: -173.23 },
  { name: 'Ittoqqortoormiit, Greenland', lat: 70.49, lon: -21.97 },
  { name: 'Danmarkshavn, Greenland', lat: 76.77, lon: -18.67 },
  { name: 'Saint-Pierre, Saint Pierre and Miquelon', lat: 46.78, lon: -56.17 },
  { name: 'Port Blair, Andaman and Nicobar Islands, India', lat: 11.62, lon: 92.73 },
  { name: 'Kavaratti, Lakshadweep, India', lat: 10.57, lon: 72.64 },
  { name: 'Diego Garcia, Chagos Archipelago', lat: -7.31, lon: 72.41 },
  { name: 'Thimphu, Bhutan', lat: 27.47, lon: 89.64 },
  { name: 'West Island, Cocos (Keeling) Islands', lat: -12.19, lon: 96.83 },
  { name: 'Mata-Utu, Wallis and Futuna', lat: -13.28, lon: -176.17 },
  { name: 'Midway Atoll, United States Minor Outlying Islands', lat: 28.21, lon: -177.38 },
  // Antarctic research stations — the year-round settlements of their sectors.
  // Davis is plotted ~0.1° off the station so its dot sits inside the
  // station's own +7 polygon rather than the +5 ocean zone overlapping it.
  { name: 'McMurdo Station, Antarctica', lat: -77.85, lon: 166.67 },
  { name: 'Troll Station, Antarctica', lat: -72.01, lon: 2.53 },
  { name: 'Syowa Station, Antarctica', lat: -69.00, lon: 39.58 },
  { name: 'Mawson Station, Antarctica', lat: -67.60, lon: 62.87 },
  { name: 'Davis Station, Antarctica', lat: -68.60, lon: 78.20 },
  { name: 'Vostok Station, Antarctica', lat: -78.46, lon: 106.84 },
  { name: 'Casey Station, Antarctica', lat: -66.28, lon: 110.53 },
  { name: 'Dumont d’Urville Station, Antarctica', lat: -66.66, lon: 140.00 },
  { name: 'Rothera Station, Antarctica', lat: -67.57, lon: -68.13 },
  { name: 'Palmer Station, Antarctica', lat: -64.77, lon: -64.05 }
];

// Extra cities the location SEARCH can resolve (no map dots — the map plots
// only _MAP_CITIES). Small list, big reach; coords to ~0.1° are plenty for a
// point-on-Earth picker.
var _SEARCH_CITIES = [
  // North America
  { name: 'Seattle, Washington, United States', lat: 47.61, lon: -122.33 },
  { name: 'Denver, Colorado, United States', lat: 39.74, lon: -104.99 },
  { name: 'Boston, Massachusetts, United States', lat: 42.36, lon: -71.06 },
  { name: 'Miami, Florida, United States', lat: 25.76, lon: -80.19 },
  { name: 'Atlanta, Georgia, United States', lat: 33.75, lon: -84.39 },
  { name: 'Dallas, Texas, United States', lat: 32.78, lon: -96.80 },
  { name: 'San Diego, California, United States', lat: 32.72, lon: -117.16 },
  { name: 'Portland, Oregon, United States', lat: 45.52, lon: -122.68 },
  { name: 'Las Vegas, Nevada, United States', lat: 36.17, lon: -115.14 },
  { name: 'Minneapolis, Minnesota, United States', lat: 44.98, lon: -93.27 },
  { name: 'Detroit, Michigan, United States', lat: 42.33, lon: -83.05 },
  { name: 'Nashville, Tennessee, United States', lat: 36.16, lon: -86.78 },
  { name: 'New Orleans, Louisiana, United States', lat: 29.95, lon: -90.07 },
  { name: 'Salt Lake City, Utah, United States', lat: 40.76, lon: -111.89 },
  { name: 'Kansas City, Missouri, United States', lat: 39.10, lon: -94.58 },
  { name: 'St. Louis, Missouri, United States', lat: 38.63, lon: -90.20 },
  { name: 'Pittsburgh, Pennsylvania, United States', lat: 40.44, lon: -79.996 },
  { name: 'Cleveland, Ohio, United States', lat: 41.50, lon: -81.69 },
  { name: 'Baltimore, Maryland, United States', lat: 39.29, lon: -76.61 },
  { name: 'Austin, Texas, United States', lat: 30.27, lon: -97.74 },
  { name: 'Charlotte, North Carolina, United States', lat: 35.23, lon: -80.84 },
  { name: 'Orlando, Florida, United States', lat: 28.54, lon: -81.38 },
  { name: 'Tampa, Florida, United States', lat: 27.95, lon: -82.46 },
  { name: 'Honolulu, Hawaii, United States', lat: 21.31, lon: -157.86 },
  { name: 'Anchorage, Alaska, United States', lat: 61.22, lon: -149.90 },
  { name: 'Ottawa, Canada', lat: 45.42, lon: -75.70 },
  { name: 'Calgary, Canada', lat: 51.05, lon: -114.07 },
  { name: 'Edmonton, Canada', lat: 53.55, lon: -113.49 },
  { name: 'Winnipeg, Canada', lat: 49.90, lon: -97.14 },
  { name: 'Quebec City, Canada', lat: 46.81, lon: -71.21 },
  { name: 'Halifax, Canada', lat: 44.65, lon: -63.58 },
  // Latin America
  { name: 'Guadalajara, Mexico', lat: 20.66, lon: -103.35 },
  { name: 'Monterrey, Mexico', lat: 25.69, lon: -100.32 },
  { name: 'Tijuana, Mexico', lat: 32.51, lon: -117.04 },
  { name: 'Havana, Cuba', lat: 23.11, lon: -82.37 },
  { name: 'Santo Domingo, Dominican Republic', lat: 18.49, lon: -69.93 },
  { name: 'San Juan, Puerto Rico', lat: 18.47, lon: -66.11 },
  { name: 'Guatemala City, Guatemala', lat: 14.63, lon: -90.51 },
  { name: 'San José, Costa Rica', lat: 9.93, lon: -84.08 },
  { name: 'Panama City, Panama', lat: 8.98, lon: -79.52 },
  { name: 'Medellín, Colombia', lat: 6.24, lon: -75.58 },
  { name: 'Cali, Colombia', lat: 3.44, lon: -76.52 },
  { name: 'Quito, Ecuador', lat: -0.18, lon: -78.47 },
  { name: 'Guayaquil, Ecuador', lat: -2.17, lon: -79.92 },
  { name: 'La Paz, Bolivia', lat: -16.50, lon: -68.15 },
  { name: 'Montevideo, Uruguay', lat: -34.90, lon: -56.16 },
  { name: 'Asunción, Paraguay', lat: -25.28, lon: -57.63 },
  { name: 'Belo Horizonte, Brazil', lat: -19.92, lon: -43.94 },
  { name: 'Brasília, Brazil', lat: -15.79, lon: -47.88 },
  { name: 'Porto Alegre, Brazil', lat: -30.03, lon: -51.23 },
  { name: 'Recife, Brazil', lat: -8.05, lon: -34.88 },
  { name: 'Salvador, Brazil', lat: -12.97, lon: -38.51 },
  { name: 'Curitiba, Brazil', lat: -25.43, lon: -49.27 },
  { name: 'Rosario, Argentina', lat: -32.95, lon: -60.64 },
  { name: 'Córdoba, Argentina', lat: -31.42, lon: -64.18 },
  // Europe
  { name: 'Manchester, United Kingdom', lat: 53.48, lon: -2.24 },
  { name: 'Birmingham, United Kingdom', lat: 52.49, lon: -1.89 },
  { name: 'Glasgow, United Kingdom', lat: 55.86, lon: -4.25 },
  { name: 'Edinburgh, United Kingdom', lat: 55.95, lon: -3.19 },
  { name: 'Leeds, United Kingdom', lat: 53.80, lon: -1.55 },
  { name: 'Liverpool, United Kingdom', lat: 53.41, lon: -2.99 },
  { name: 'Bristol, United Kingdom', lat: 51.45, lon: -2.59 },
  { name: 'Belfast, United Kingdom', lat: 54.60, lon: -5.93 },
  { name: 'Dublin, Ireland', lat: 53.35, lon: -6.26 },
  { name: 'Marseille, France', lat: 43.30, lon: 5.37 },
  { name: 'Lyon, France', lat: 45.76, lon: 4.84 },
  { name: 'Nice, France', lat: 43.70, lon: 7.27 },
  { name: 'Toulouse, France', lat: 43.60, lon: 1.44 },
  { name: 'Bordeaux, France', lat: 44.84, lon: -0.58 },
  { name: 'Strasbourg, France', lat: 48.57, lon: 7.75 },
  { name: 'Hamburg, Germany', lat: 53.55, lon: 9.99 },
  { name: 'Munich, Germany', lat: 48.14, lon: 11.58 },
  { name: 'Frankfurt, Germany', lat: 50.11, lon: 8.68 },
  { name: 'Cologne, Germany', lat: 50.94, lon: 6.96 },
  { name: 'Stuttgart, Germany', lat: 48.78, lon: 9.18 },
  { name: 'Naples, Italy', lat: 40.85, lon: 14.27 },
  { name: 'Turin, Italy', lat: 45.07, lon: 7.69 },
  { name: 'Milan, Italy', lat: 45.46, lon: 9.19 },
  { name: 'Florence, Italy', lat: 43.77, lon: 11.26 },
  { name: 'Venice, Italy', lat: 45.44, lon: 12.34 },
  { name: 'Bologna, Italy', lat: 44.49, lon: 11.34 },
  { name: 'Palermo, Italy', lat: 38.12, lon: 13.36 },
  { name: 'Valencia, Spain', lat: 39.47, lon: -0.38 },
  { name: 'Seville, Spain', lat: 37.39, lon: -5.99 },
  { name: 'Bilbao, Spain', lat: 43.26, lon: -2.93 },
  { name: 'Málaga, Spain', lat: 36.72, lon: -4.42 },
  { name: 'Zaragoza, Spain', lat: 41.65, lon: -0.89 },
  { name: 'Porto, Portugal', lat: 41.15, lon: -8.61 },
  { name: 'Rotterdam, Netherlands', lat: 51.92, lon: 4.48 },
  { name: 'The Hague, Netherlands', lat: 52.08, lon: 4.30 },
  { name: 'Antwerp, Belgium', lat: 51.22, lon: 4.40 },
  { name: 'Zurich, Switzerland', lat: 47.37, lon: 8.54 },
  { name: 'Geneva, Switzerland', lat: 46.20, lon: 6.14 },
  { name: 'Gothenburg, Sweden', lat: 57.71, lon: 11.97 },
  { name: 'Bergen, Norway', lat: 60.39, lon: 5.32 },
  { name: 'Kraków, Poland', lat: 50.06, lon: 19.94 },
  { name: 'Gdańsk, Poland', lat: 54.35, lon: 18.65 },
  { name: 'Brno, Czechia', lat: 49.20, lon: 16.61 },
  { name: 'Bratislava, Slovakia', lat: 48.15, lon: 17.11 },
  { name: 'Ljubljana, Slovenia', lat: 46.06, lon: 14.51 },
  { name: 'Zagreb, Croatia', lat: 45.81, lon: 15.98 },
  { name: 'Belgrade, Serbia', lat: 44.79, lon: 20.45 },
  { name: 'Sofia, Bulgaria', lat: 42.70, lon: 23.32 },
  { name: 'Bucharest, Romania', lat: 44.43, lon: 26.10 },
  { name: 'Thessaloniki, Greece', lat: 40.64, lon: 22.94 },
  { name: 'Reykjavík, Iceland', lat: 64.15, lon: -21.94 },
  { name: 'Vilnius, Lithuania', lat: 54.69, lon: 25.28 },
  { name: 'Riga, Latvia', lat: 56.95, lon: 24.11 },
  { name: 'Tallinn, Estonia', lat: 59.44, lon: 24.75 },
  { name: 'Kharkiv, Ukraine', lat: 49.99, lon: 36.23 },
  { name: 'Odesa, Ukraine', lat: 46.48, lon: 30.72 },
  { name: 'Lviv, Ukraine', lat: 49.84, lon: 24.03 },
  { name: 'Kazan, Russia', lat: 55.83, lon: 49.07 },
  { name: 'Yekaterinburg, Russia', lat: 56.84, lon: 60.61 },
  { name: 'Novosibirsk, Russia', lat: 55.01, lon: 82.93 },
  // Middle East
  { name: 'Mecca, Saudi Arabia', lat: 21.42, lon: 39.83 },
  { name: 'Jeddah, Saudi Arabia', lat: 21.49, lon: 39.19 },
  { name: 'Doha, Qatar', lat: 25.29, lon: 51.53 },
  { name: 'Abu Dhabi, United Arab Emirates', lat: 24.45, lon: 54.38 },
  { name: 'Kuwait City, Kuwait', lat: 29.38, lon: 47.99 },
  { name: 'Manama, Bahrain', lat: 26.23, lon: 50.59 },
  { name: 'Muscat, Oman', lat: 23.59, lon: 58.41 },
  { name: 'Amman, Jordan', lat: 31.95, lon: 35.93 },
  { name: 'Beirut, Lebanon', lat: 33.89, lon: 35.50 },
  { name: 'Baghdad, Iraq', lat: 33.32, lon: 44.36 },
  { name: 'Isfahan, Iran', lat: 32.65, lon: 51.67 },
  { name: 'Mashhad, Iran', lat: 36.30, lon: 59.61 },
  { name: 'Izmir, Turkey', lat: 38.42, lon: 27.14 },
  { name: 'Tbilisi, Georgia', lat: 41.72, lon: 44.83 },
  { name: 'Yerevan, Armenia', lat: 40.18, lon: 44.51 },
  { name: 'Baku, Azerbaijan', lat: 40.41, lon: 49.87 },
  { name: 'Jerusalem, Israel', lat: 31.77, lon: 35.21 },
  // Africa
  { name: 'Casablanca, Morocco', lat: 33.57, lon: -7.59 },
  { name: 'Marrakesh, Morocco', lat: 31.63, lon: -7.99 },
  { name: 'Tripoli, Libya', lat: 32.89, lon: 13.19 },
  { name: 'Khartoum, Sudan', lat: 15.50, lon: 32.56 },
  { name: 'Addis Ababa, Ethiopia', lat: 9.03, lon: 38.74 },
  { name: 'Mombasa, Kenya', lat: -4.04, lon: 39.67 },
  { name: 'Dar es Salaam, Tanzania', lat: -6.79, lon: 39.21 },
  { name: 'Kampala, Uganda', lat: 0.35, lon: 32.58 },
  { name: 'Kinshasa, DR Congo', lat: -4.44, lon: 15.27 },
  { name: 'Luanda, Angola', lat: -8.84, lon: 13.23 },
  { name: 'Abuja, Nigeria', lat: 9.06, lon: 7.50 },
  { name: 'Accra, Ghana', lat: 5.60, lon: -0.19 },
  { name: 'Abidjan, Ivory Coast', lat: 5.36, lon: -4.01 },
  { name: 'Dakar, Senegal', lat: 14.72, lon: -17.47 },
  { name: 'Harare, Zimbabwe', lat: -17.83, lon: 31.05 },
  { name: 'Lusaka, Zambia', lat: -15.42, lon: 28.28 },
  { name: 'Windhoek, Namibia', lat: -22.56, lon: 17.08 },
  { name: 'Maputo, Mozambique', lat: -25.97, lon: 32.57 },
  { name: 'Durban, South Africa', lat: -29.86, lon: 31.02 },
  { name: 'Pretoria, South Africa', lat: -25.75, lon: 28.19 },
  { name: 'Alexandria, Egypt', lat: 31.20, lon: 29.92 },
  // Asia
  { name: 'Osaka, Japan', lat: 34.69, lon: 135.50 },
  { name: 'Nagoya, Japan', lat: 35.18, lon: 136.91 },
  { name: 'Sapporo, Japan', lat: 43.06, lon: 141.35 },
  { name: 'Fukuoka, Japan', lat: 33.59, lon: 130.40 },
  { name: 'Kyoto, Japan', lat: 35.01, lon: 135.77 },
  { name: 'Yokohama, Japan', lat: 35.44, lon: 139.64 },
  { name: 'Busan, South Korea', lat: 35.18, lon: 129.08 },
  { name: 'Incheon, South Korea', lat: 37.46, lon: 126.71 },
  { name: 'Pyongyang, North Korea', lat: 39.04, lon: 125.76 },
  { name: 'Guangzhou, China', lat: 23.13, lon: 113.26 },
  { name: 'Shenzhen, China', lat: 22.54, lon: 114.06 },
  { name: 'Chengdu, China', lat: 30.57, lon: 104.07 },
  { name: 'Chongqing, China', lat: 29.56, lon: 106.55 },
  { name: 'Wuhan, China', lat: 30.59, lon: 114.31 },
  { name: "Xi'an, China", lat: 34.34, lon: 108.94 },
  { name: 'Hangzhou, China', lat: 30.27, lon: 120.15 },
  { name: 'Nanjing, China', lat: 32.06, lon: 118.80 },
  { name: 'Tianjin, China', lat: 39.13, lon: 117.20 },
  { name: 'Shenyang, China', lat: 41.81, lon: 123.43 },
  { name: 'Harbin, China', lat: 45.80, lon: 126.53 },
  { name: 'Qingdao, China', lat: 36.07, lon: 120.38 },
  { name: 'Hong Kong, China', lat: 22.32, lon: 114.17 },
  { name: 'Taipei, Taiwan', lat: 25.03, lon: 121.57 },
  { name: 'Kaohsiung, Taiwan', lat: 22.63, lon: 120.30 },
  { name: 'Hanoi, Vietnam', lat: 21.03, lon: 105.85 },
  { name: 'Ho Chi Minh City, Vietnam', lat: 10.82, lon: 106.63 },
  { name: 'Phnom Penh, Cambodia', lat: 11.56, lon: 104.92 },
  { name: 'Vientiane, Laos', lat: 17.97, lon: 102.63 },
  { name: 'Yangon, Myanmar', lat: 16.87, lon: 96.20 },
  { name: 'Chiang Mai, Thailand', lat: 18.79, lon: 98.99 },
  { name: 'George Town, Malaysia', lat: 5.41, lon: 100.34 },
  { name: 'Surabaya, Indonesia', lat: -7.26, lon: 112.75 },
  { name: 'Bandung, Indonesia', lat: -6.92, lon: 107.62 },
  { name: 'Medan, Indonesia', lat: 3.60, lon: 98.67 },
  { name: 'Cebu, Philippines', lat: 10.32, lon: 123.90 },
  { name: 'Davao, Philippines', lat: 7.19, lon: 125.46 },
  { name: 'Colombo, Sri Lanka', lat: 6.93, lon: 79.86 },
  { name: 'Chittagong, Bangladesh', lat: 22.36, lon: 91.78 },
  { name: 'Kathmandu, Nepal', lat: 27.72, lon: 85.32 },
  { name: 'Lahore, Pakistan', lat: 31.55, lon: 74.34 },
  { name: 'Islamabad, Pakistan', lat: 33.68, lon: 73.05 },
  { name: 'Peshawar, Pakistan', lat: 34.02, lon: 71.58 },
  { name: 'Kabul, Afghanistan', lat: 34.56, lon: 69.21 },
  { name: 'Tashkent, Uzbekistan', lat: 41.30, lon: 69.24 },
  { name: 'Almaty, Kazakhstan', lat: 43.24, lon: 76.89 },
  { name: 'Astana, Kazakhstan', lat: 51.17, lon: 71.43 },
  { name: 'Bishkek, Kyrgyzstan', lat: 42.87, lon: 74.59 },
  { name: 'Ulaanbaatar, Mongolia', lat: 47.89, lon: 106.91 },
  { name: 'Bangalore, India', lat: 12.97, lon: 77.59 },
  { name: 'Chennai, India', lat: 13.08, lon: 80.27 },
  { name: 'Hyderabad, India', lat: 17.39, lon: 78.49 },
  { name: 'Kolkata, India', lat: 22.57, lon: 88.36 },
  { name: 'Pune, India', lat: 18.52, lon: 73.86 },
  { name: 'Ahmedabad, India', lat: 23.03, lon: 72.58 },
  { name: 'Jaipur, India', lat: 26.91, lon: 75.79 },
  { name: 'Lucknow, India', lat: 26.85, lon: 80.95 },
  { name: 'Kochi, India', lat: 9.93, lon: 76.27 },
  { name: 'Chandigarh, India', lat: 30.73, lon: 76.78 },
  // Oceania
  { name: 'Melbourne, Australia', lat: -37.81, lon: 144.96 },
  { name: 'Brisbane, Australia', lat: -27.47, lon: 153.03 },
  { name: 'Perth, Australia', lat: -31.95, lon: 115.86 },
  { name: 'Adelaide, Australia', lat: -34.93, lon: 138.60 },
  { name: 'Canberra, Australia', lat: -35.28, lon: 149.13 },
  { name: 'Gold Coast, Australia', lat: -28.02, lon: 153.40 },
  { name: 'Hobart, Australia', lat: -42.88, lon: 147.33 },
  { name: 'Darwin, Australia', lat: -12.46, lon: 130.84 },
  { name: 'Auckland, New Zealand', lat: -36.85, lon: 174.76 },
  { name: 'Wellington, New Zealand', lat: -41.29, lon: 174.78 },
  { name: 'Christchurch, New Zealand', lat: -43.53, lon: 172.64 },
  { name: 'Suva, Fiji', lat: -18.14, lon: 178.44 },
  { name: 'Port Moresby, Papua New Guinea', lat: -9.44, lon: 147.18 },
  // ── Wider world coverage (1.8.1): major cities by population, coordinates
  //    from the GeoNames cities15000 dataset; deduped against the lists above. ──
  { name: 'Aden, Yemen', lat: 12.78, lon: 45.04 },
  { name: 'Al Basrah al Qadimah, Iraq', lat: 30.50, lon: 47.82 },
  { name: 'Al Mawsil al Jadidah, Iraq', lat: 36.33, lon: 43.11 },
  { name: 'Aleppo, Syria', lat: 36.20, lon: 37.16 },
  { name: 'Andijon, Uzbekistan', lat: 40.78, lon: 72.35 },
  { name: 'Ankara, Turkey', lat: 39.92, lon: 32.85 },
  { name: 'Antananarivo, Madagascar', lat: -18.91, lon: 47.54 },
  { name: 'Antsirabe, Madagascar', lat: -19.87, lon: 47.03 },
  { name: 'Arequipa, Peru', lat: -16.40, lon: -71.54 },
  { name: 'Arhus, Denmark', lat: 56.16, lon: 10.21 },
  { name: 'Ashgabat, Turkmenistan', lat: 37.95, lon: 58.38 },
  { name: 'Asmara, Eritrea', lat: 15.34, lon: 38.93 },
  { name: 'Bamako, Mali', lat: 12.61, lon: -7.98 },
  { name: 'Bamenda, Cameroon', lat: 5.96, lon: 10.15 },
  { name: 'Bangui, Central African Republic', lat: 4.36, lon: 18.55 },
  { name: 'Banja Luka, Bosnia and Herzegovina', lat: 44.78, lon: 17.21 },
  { name: 'Benghazi, Libya', lat: 32.11, lon: 20.07 },
  { name: 'Bharatpur, Nepal', lat: 27.68, lon: 84.44 },
  { name: 'Bissau, Guinea-Bissau', lat: 11.86, lon: -15.60 },
  { name: 'Blantyre, Malawi', lat: -15.78, lon: 35.01 },
  { name: 'Bo, Sierra Leone', lat: 7.96, lon: -11.74 },
  { name: 'Bobo-Dioulasso, Burkina Faso', lat: 11.18, lon: -4.29 },
  { name: 'Borama, Somalia', lat: 9.94, lon: 43.18 },
  { name: 'Bouake, Ivory Coast', lat: 7.69, lon: -5.03 },
  { name: 'Bujumbura, Burundi', lat: -3.38, lon: 29.36 },
  { name: 'Bulawayo, Zimbabwe', lat: -20.15, lon: 28.58 },
  { name: 'Bursa, Turkey', lat: 40.20, lon: 29.06 },
  { name: 'Camagueey, Cuba', lat: 21.38, lon: -77.92 },
  { name: 'Chisinau, Moldova', lat: 47.01, lon: 28.86 },
  { name: 'Ciudad del Este, Paraguay', lat: -25.50, lon: -54.65 },
  { name: 'Cochabamba, Bolivia', lat: -17.38, lon: -66.16 },
  { name: 'Conakry, Guinea', lat: 9.54, lon: -13.68 },
  { name: 'Constantine, Algeria', lat: 36.37, lon: 6.61 },
  { name: 'Cork, Ireland', lat: 51.90, lon: -8.47 },
  { name: 'Cotonou, Benin', lat: 6.37, lon: 2.42 },
  { name: 'Cuenca, Ecuador', lat: -2.90, lon: -79.00 },
  { name: 'Damascus, Syria', lat: 33.51, lon: 36.29 },
  { name: 'Danli, Honduras', lat: 14.03, lon: -86.58 },
  { name: 'Dasoguz, Turkmenistan', lat: 41.84, lon: 59.97 },
  { name: 'Djibouti, Djibouti', lat: 11.59, lon: 43.15 },
  { name: 'Dodoma, Tanzania', lat: -6.17, lon: 35.74 },
  { name: 'Douala, Cameroon', lat: 4.05, lon: 9.70 },
  { name: 'Dushanbe, Tajikistan', lat: 38.54, lon: 68.78 },
  { name: 'Fes, Morocco', lat: 34.03, lon: -5.00 },
  { name: 'Freetown, Sierra Leone', lat: 8.49, lon: -13.24 },
  { name: 'Gaborone, Botswana', lat: -24.65, lon: 25.91 },
  { name: 'Ganja, Azerbaijan', lat: 40.68, lon: 46.36 },
  { name: 'Gaza, Palestinian Territory', lat: 31.50, lon: 34.47 },
  { name: 'Georgetown, Guyana', lat: 6.80, lon: -58.16 },
  { name: 'Gonder, Ethiopia', lat: 12.60, lon: 37.47 },
  { name: 'Graz, Austria', lat: 47.07, lon: 15.44 },
  { name: 'Haiphong, Vietnam', lat: 20.86, lon: 106.68 },
  { name: 'Hamhung, North Korea', lat: 39.92, lon: 127.54 },
  { name: 'Hargeysa, Somalia', lat: 9.56, lon: 44.06 },
  { name: 'Herat, Afghanistan', lat: 34.35, lon: 62.20 },
  { name: 'Homs, Syria', lat: 34.72, lon: 36.73 },
  { name: 'Homyel\', Belarus', lat: 52.43, lon: 30.98 },
  { name: 'Hrodna, Belarus', lat: 53.68, lon: 23.83 },
  { name: 'Iasi, Romania', lat: 47.17, lon: 27.60 },
  { name: 'Ibadan, Nigeria', lat: 7.38, lon: 3.91 },
  { name: 'Irbid, Jordan', lat: 32.56, lon: 35.85 },
  { name: 'Isfara, Tajikistan', lat: 40.13, lon: 70.63 },
  { name: 'Istaravshan, Tajikistan', lat: 39.91, lon: 69.00 },
  { name: 'Jijiga, Ethiopia', lat: 9.35, lon: 42.80 },
  { name: 'Juba, South Sudan', lat: 4.85, lon: 31.58 },
  { name: 'Kakamega, Kenya', lat: 0.28, lon: 34.75 },
  { name: 'Kano, Nigeria', lat: 12.00, lon: 8.52 },
  { name: 'Kaunas, Lithuania', lat: 54.90, lon: 23.91 },
  { name: 'Kenema, Sierra Leone', lat: 7.88, lon: -11.19 },
  { name: 'Kigali, Rwanda', lat: -1.95, lon: 30.06 },
  { name: 'Kingston, Jamaica', lat: 18.00, lon: -76.79 },
  { name: 'Kitwe, Zambia', lat: -12.80, lon: 28.21 },
  { name: 'Kosice, Slovakia', lat: 48.71, lon: 21.26 },
  { name: 'Koutiala, Mali', lat: 12.39, lon: -5.47 },
  { name: 'Kumasi, Ghana', lat: 6.69, lon: -1.62 },
  { name: 'Libreville, Gabon', lat: 0.39, lon: 9.45 },
  { name: 'Lilongwe, Malawi', lat: -13.97, lon: 33.79 },
  { name: 'Linz, Austria', lat: 48.31, lon: 14.29 },
  { name: 'Lome, Togo', lat: 6.13, lon: 1.22 },
  { name: 'Lubumbashi, Democratic Republic of the Congo', lat: -11.66, lon: 27.48 },
  { name: 'Macau, Macao', lat: 22.20, lon: 113.55 },
  { name: 'Managua, Nicaragua', lat: 12.13, lon: -86.25 },
  { name: 'Mandalay, Myanmar', lat: 21.97, lon: 96.08 },
  { name: 'Maracaibo, Venezuela', lat: 10.64, lon: -71.61 },
  { name: 'Maradi, Niger', lat: 13.50, lon: 7.10 },
  { name: 'Maseru, Lesotho', lat: -29.32, lon: 27.48 },
  { name: 'Mazar-e Sharif, Afghanistan', lat: 36.71, lon: 67.11 },
  { name: 'Mbuji-Mayi, Democratic Republic of the Congo', lat: -6.14, lon: 23.59 },
  { name: 'Minsk, Belarus', lat: 53.90, lon: 27.57 },
  { name: 'Misratah, Libya', lat: 32.38, lon: 15.09 },
  { name: 'Mogadishu, Somalia', lat: 2.04, lon: 45.34 },
  { name: 'Monrovia, Liberia', lat: 6.30, lon: -10.80 },
  { name: 'Mwanza, Tanzania', lat: -2.52, lon: 32.90 },
  { name: 'Mzuzu, Malawi', lat: -11.47, lon: 34.02 },
  { name: 'N\'Djamena, Chad', lat: 12.11, lon: 15.04 },
  { name: 'Namangan, Uzbekistan', lat: 41.00, lon: 71.67 },
  { name: 'Nampula, Mozambique', lat: -15.12, lon: 39.27 },
  { name: 'Nassau, Bahamas', lat: 25.06, lon: -77.34 },
  { name: 'Nay Pyi Taw, Myanmar', lat: 19.75, lon: 96.13 },
  { name: 'Ndola, Zambia', lat: -12.96, lon: 28.64 },
  { name: 'Niamey, Niger', lat: 13.51, lon: 2.11 },
  { name: 'Nicosia, Cyprus', lat: 35.17, lon: 33.35 },
  { name: 'Nis, Serbia', lat: 43.32, lon: 21.90 },
  { name: 'Nouakchott, Mauritania', lat: 18.09, lon: -15.98 },
  { name: 'Novi Sad, Serbia', lat: 45.25, lon: 19.84 },
  { name: 'Nzerekore, Guinea', lat: 7.76, lon: -8.82 },
  { name: 'Oran, Algeria', lat: 35.70, lon: -0.64 },
  { name: 'Osh, Kyrgyzstan', lat: 40.53, lon: 72.80 },
  { name: 'Ostrava, Czechia', lat: 49.83, lon: 18.28 },
  { name: 'Ouagadougou, Burkina Faso', lat: 12.37, lon: -1.53 },
  { name: 'Paramaribo, Suriname', lat: 5.87, lon: -55.17 },
  { name: 'Plovdiv, Bulgaria', lat: 42.15, lon: 24.75 },
  { name: 'Podgorica, Montenegro', lat: 42.44, lon: 19.26 },
  { name: 'Pointe-Noire, Republic of the Congo', lat: -4.78, lon: 11.86 },
  { name: 'Pokhara, Nepal', lat: 28.27, lon: 83.97 },
  { name: 'Port-au-Prince, Haiti', lat: 18.54, lon: -72.34 },
  { name: 'Pristina, Kosovo', lat: 42.67, lon: 21.17 },
  { name: 'Rabat, Morocco', lat: 34.01, lon: -6.83 },
  { name: 'San Miguel, El Salvador', lat: 13.48, lon: -88.18 },
  { name: 'San Pedro Sula, Honduras', lat: 15.51, lon: -88.03 },
  { name: 'San Salvador, El Salvador', lat: 13.69, lon: -89.19 },
  { name: 'Sanaa, Yemen', lat: 15.35, lon: 44.21 },
  { name: 'Santa Cruz de la Sierra, Bolivia', lat: -17.79, lon: -63.18 },
  { name: 'Santiago de Cuba, Cuba', lat: 20.02, lon: -75.82 },
  { name: 'Santiago de los Caballeros, Dominican Republic', lat: 19.45, lon: -70.69 },
  { name: 'Sarajevo, Bosnia and Herzegovina', lat: 43.85, lon: 18.36 },
  { name: 'Serekunda, Gambia', lat: 13.44, lon: -16.68 },
  { name: 'Sfax, Tunisia', lat: 34.74, lon: 10.76 },
  { name: 'Shymkent, Kazakhstan', lat: 42.31, lon: 69.60 },
  { name: 'Sikasso, Mali', lat: 11.32, lon: -5.67 },
  { name: 'Skopje, North Macedonia', lat: 42.00, lon: 21.43 },
  { name: 'Sousse, Tunisia', lat: 35.83, lon: 10.64 },
  { name: 'Taichung, Taiwan', lat: 24.15, lon: 120.68 },
  { name: 'Taiz, Yemen', lat: 13.58, lon: 44.02 },
  { name: 'Takeo, Cambodia', lat: 10.99, lon: 104.78 },
  { name: 'Tamale, Ghana', lat: 9.40, lon: -0.84 },
  { name: 'Tampere, Finland', lat: 61.50, lon: 23.79 },
  { name: 'Tegucigalpa, Honduras', lat: 14.08, lon: -87.21 },
  { name: 'Tirana, Albania', lat: 41.33, lon: 19.82 },
  { name: 'Toamasina, Madagascar', lat: -18.15, lon: 49.40 },
  { name: 'Touba, Senegal', lat: 14.86, lon: -15.88 },
  { name: 'Trondheim, Norway', lat: 63.43, lon: 10.40 },
  { name: 'Tuerkmenabat, Turkmenistan', lat: 39.07, lon: 63.58 },
  { name: 'Varna, Bulgaria', lat: 43.22, lon: 27.91 },
  { name: 'Winejok, South Sudan', lat: 9.01, lon: 27.57 },
  { name: 'Wroclaw, Poland', lat: 51.10, lon: 17.03 },
  { name: 'Yaounde, Cameroon', lat: 3.87, lon: 11.52 },
  { name: 'Yei, South Sudan', lat: 4.09, lon: 30.68 },
  { name: 'Zinder, Niger', lat: 13.81, lon: 8.99 },
];

// Coastline data removed — using Natural Earth SVG map (/static/world-map.svg)

function _promptAlmanacLocation() {
  var overlay = document.createElement('div');
  overlay.id = 'almanac-map-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.88);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)';

  var gpsBtn = navigator.geolocation
    ? '<button id="almanac-map-gps" style="padding:6px 14px;background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:6px;font-size:12px;cursor:pointer;opacity:0.8">\uD83D\uDCCD ' + t('alm_use_gps') + '</button>'
    : '';

  // Map uses Natural Earth 110m SVG (public domain) as background
  overlay.innerHTML = '<div style="color:var(--text);font-size:16px;font-weight:600;margin-bottom:4px">' + t('alm_set_location_title') + '</div>' +
    '<div style="color:var(--text3);font-size:12px;margin-bottom:12px">' + t('alm_tap_city') + '</div>' +
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
      '<input id="almanac-map-lat" type="text" placeholder="' + t('alm_latitude') + '" style="width:90px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;text-align:center">' +
      '<input id="almanac-map-lon" type="text" placeholder="' + t('alm_longitude') + '" style="width:90px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;text-align:center">' +
      '<button id="almanac-map-ok" style="padding:6px 18px;background:var(--accent);color:#000;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">' + t('alm_set') + '</button>' +
      gpsBtn +
      '<button id="almanac-map-cancel" style="padding:6px 14px;background:transparent;color:var(--text3);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer">' + t('alm_cancel') + '</button>' +
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
        var dlat = lat - c.lat, dlon = (lon - c.lon) * Math.cos(lat * DEG_TO_RAD);
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
      _saveLocation(locData.lat, locData.lon, locData.name);
      document.body.removeChild(overlay);
      _almRepaintFocus();   // location-only refresh, preserves scroll
    }
  };

  // GPS button
  var gpsEl = document.getElementById('almanac-map-gps');
  if (gpsEl) {
    gpsEl.onclick = function() {
      gpsEl.textContent = t('alm_locating');
      navigator.geolocation.getCurrentPosition(function(pos) {
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        document.getElementById('almanac-map-lat').value = lat.toFixed(2);
        document.getElementById('almanac-map-lon').value = lon.toFixed(2);
        document.getElementById('almanac-map-hint').textContent = t('alm_gps_coords', { lat: lat.toFixed(2) + '\u00b0', lon: lon.toFixed(2) + '\u00b0' });
        gpsEl.textContent = '\uD83D\uDCCD ' + t('alm_use_gps');
        showMarker(lat, lon);
      }, function() {
        gpsEl.textContent = t('alm_gps_unavailable');
        setTimeout(function() { gpsEl.textContent = '\uD83D\uDCCD ' + t('alm_use_gps'); }, 2000);
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
  var d = new Date(2023, 0, 1, Math.floor(m / 60), Math.round(m % 60));
  // Cached formatter: sunrise/sunset/golden-hour readouts run per travel frame.
  return _tzFmt(null, { hour: 'numeric', minute: '2-digit' }).format(d);
}

// ── Live Sky Scene ──



function _sunPosition(date, lat, lon) {
  var doy = _dayOfYear(date);
  var B = _solarB(doy);
  var EoT = _eqOfTime(B);
  var decl = _solarDeclination(B);
  var solarTime = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + EoT + lon * 4;
  // Normalize the hour angle to [-180, 180) BEFORE the hemisphere flip below.
  // Unnormalized, western-longitude evenings drove it past -180 and the
  // `> 0` test misfired — reflecting the azimuth east, so the sky scene drew
  // the setting Sun on the wrong side of the sky every evening. Altitude was
  // unaffected (cosine is even), which is why sunrise/sunset times were fine.
  var haDeg = ((solarTime / 4 - 180) % 360 + 540) % 360 - 180;
  var hourAngle = haDeg * DEG_TO_RAD;
  var latRad = lat * DEG_TO_RAD;
  var sinAlt = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  var altitude = Math.asin(sinAlt) * 180 / Math.PI;
  var cosAz = (Math.sin(decl) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(Math.asin(sinAlt)));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  if (isNaN(cosAz)) cosAz = 0; // zenith/nadir at poles — azimuth undefined
  var azimuth = Math.acos(cosAz) * 180 / Math.PI;
  if (haDeg > 0) azimuth = 360 - azimuth;
  return { altitude: altitude, azimuth: azimuth };
}

// ── Moon position — simplified lunar alt/az ──
// Equatorial coordinates come from the canonical _moonEqCoords in app.js (the
// same evaluation every moon renderer derives from); this converts them to
// horizontal coordinates (same pipeline as the sun). The disc's screen tilt is
// NOT here — that is _moonScreenTiltDeg (app.js), shared by the hero, the
// sky-scene moon and the Today card.
function _moonPosition(date, lat, lon) {
  var eq = _moonEqCoords(date);
  var dec = eq.dec, ra = eq.ra;

  // Local sidereal time
  var GMST = (280.46061837 + 360.98564736629 * (eq.JD - JD_J2000)) % 360;
  var LST = (GMST + lon) * DEG_TO_RAD;
  var HA = LST - ra;
  HA = ((HA % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // normalize to [-pi, pi]

  // Horizontal coordinates
  var latR2 = lat * DEG_TO_RAD;
  var sinAlt = Math.sin(latR2) * Math.sin(dec) + Math.cos(latR2) * Math.cos(dec) * Math.cos(HA);
  var altitude = Math.asin(sinAlt) * 180 / Math.PI;
  var cosAz = (Math.sin(dec) - Math.sin(latR2) * sinAlt) / (Math.cos(latR2) * Math.cos(Math.asin(sinAlt)));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  if (isNaN(cosAz)) cosAz = 0; // zenith/nadir at poles — azimuth undefined
  var azimuth = Math.acos(cosAz) * 180 / Math.PI;
  if (HA > 0) azimuth = 360 - azimuth;
  // Geocentric → apparent altitude (F5): topocentric parallax pulls the Moon
  // down (up to ~1° at the horizon), then refraction lifts the apparent disc.
  var hp = Math.asin(6378.14 / _moonDistance(date)) * 180 / Math.PI; // horizontal parallax
  altitude = altitude - hp * Math.cos(altitude * DEG_TO_RAD);
  if (altitude > -1) altitude += (1 / Math.tan((altitude + 7.31 / (altitude + 4.4)) * DEG_TO_RAD)) / 60; // Bennett refraction, deg
  return { altitude: altitude, azimuth: azimuth };
}

// ── Star catalog — bright stars with real RA/Dec coordinates ──
// [RA hours, Dec degrees, visual magnitude]
// 59 stars: major constellations + bright field stars








// ── Palm tree — lush filled fronds ──


// ── Tonight's Sky — planet visibility ──


function _planetVisibility(now) {
  var JD = _dateToJD(now.getTime());
  var T = _jdToJulianCentury(JD);
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
    var sky = elong > 0 ? t('alm_evening') : t('alm_morning');
    var dir = elong > 0 ? (elongAbs > 120 ? t('alm_east') : elongAbs > 60 ? t('alm_south') : t('alm_west')) :
                          (elongAbs > 120 ? t('alm_west') : elongAbs > 60 ? t('alm_south') : t('alm_east'));
    results.push({ name: name, elongation: elongAbs, magnitude: mag, visible: visible, sky: sky, direction: dir, distance: delta, color: _PLANETS[name].color });
  }
  return results;
}












// The Analemma — the figure-8 the Sun traces if photographed at the same clock
// time every day for a year. Laid out horizontally: the long axis is solar
// declination (how high the Sun climbs), the short vertical axis is the
// equation of time (how far ahead/behind the clock the real Sun runs). Both
// come straight from the offline solar math already used for sunrise/sunset —
// no data, works forever.
function _renderAnalemma(now) {
  var canvas = document.getElementById('almanac-analemma');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = Math.min(wrap.clientWidth, 460);
  var h = 260;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Sample the whole year. Horizontal position = declination (deg, the wide
  // ±23° swing); vertical position = equation of time (min, the narrow ±16
  // swing) — so the figure-8 lies on its side.
  var pts = [];
  var minDecl = 99, maxDecl = -99, minEot = 99, maxEot = -99;
  for (var d = 1; d <= 366; d++) {
    var B = _solarB(d);
    var eot = _eqOfTime(B);                          // minutes
    var decl = _solarDeclination(B) * 180 / Math.PI; // degrees
    pts.push({ d: d, eot: eot, decl: decl });
    if (decl < minDecl) minDecl = decl; if (decl > maxDecl) maxDecl = decl;
    if (eot < minEot) minEot = eot; if (eot > maxEot) maxEot = eot;
  }
  var padL = 30, padR = 30, padT = 26, padB = 26;
  var padD = (maxDecl - minDecl) * 0.08, padE = (maxEot - minEot) * 0.14;
  minDecl -= padD; maxDecl += padD; minEot -= padE; maxEot += padE;
  // fx: declination → horizontal (summer/high-Sun to the right).
  function fx(decl) { return padL + (decl - minDecl) / (maxDecl - minDecl) * (w - padL - padR); }
  // fy: equation of time → vertical (Sun ahead of the clock plotted upward).
  function fy(eot) { return padT + (maxEot - eot) / (maxEot - minEot) * (h - padT - padB); }

  var styles = getComputedStyle(document.documentElement);
  var amber = (styles.getPropertyValue('--amber') || '#e0b060').trim();
  var faint = (styles.getPropertyValue('--border') || 'rgba(255,255,255,0.12)').trim();

  // Reference lines: equinox meridian (decl 0, vertical) and mean-time line
  // (EoT 0, horizontal).
  ctx.strokeStyle = faint;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(fx(0), padT); ctx.lineTo(fx(0), h - padB); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(padL, fy(0)); ctx.lineTo(w - padR, fy(0)); ctx.stroke();

  // The figure-8 itself.
  ctx.strokeStyle = amber;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (var i = 0; i < pts.length; i++) {
    var X = fx(pts[i].decl), Y = fy(pts[i].eot);
    if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Month ticks on the 1st of each month, so the loop reads as a calendar you
  // can trace. Label the seasonal turning points with locale-aware month names,
  // placed above the point in the upper half and below in the lower half.
  var seasonMonths = { 0: 1, 3: 1, 5: 1, 8: 1, 11: 1 };
  var loc = (typeof _almLocale !== 'undefined' && _almLocale) || undefined;
  ctx.fillStyle = (styles.getPropertyValue('--text3') || '#888').trim();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (var mo = 0; mo < 12; mo++) {
    var doy = _dayOfYear(new Date(now.getFullYear(), mo, 1));
    var p = pts[doy - 1];
    if (!p) continue;
    var mx = fx(p.decl), my = fy(p.eot);
    ctx.beginPath(); ctx.arc(mx, my, 1.6, 0, Math.PI * 2); ctx.fill();
    if (seasonMonths[mo]) {
      var lbl = new Date(now.getFullYear(), mo, 1).toLocaleDateString(loc, { month: 'short' });
      ctx.fillText(lbl, mx, p.eot >= 0 ? my - 6 : my + 13);
    }
  }
  ctx.textAlign = 'start';

  // Today's Sun.
  var td = pts[Math.min(_dayOfYear(now), 366) - 1];
  var tx = fx(td.decl), ty = fy(td.eot);
  var grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, 9);
  grad.addColorStop(0, amber);
  grad.addColorStop(1, 'rgba(224,176,96,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(tx, ty, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2); ctx.fill();

  // Caption — today's numbers + a one-line explanation.
  var cap = document.getElementById('almanac-analemma-caption');
  if (cap) {
    var mins = Math.abs(td.eot);
    var fastSlow = td.eot >= 0 ? t('alm_sun_ahead') : t('alm_sun_behind');
    cap.innerHTML =
      '<div class="alm-analemma-now">' + t('alm_sun') + ': ' + _lterm('equation_of_time', mins.toFixed(1) + ' ' + t('alm_min') + ' ' + fastSlow) +
      ' · ' + _lterm('declination', t('alm_declination')) + ' ' + td.decl.toFixed(1) + '°</div>' +
      '<div class="alm-analemma-desc">' + t('alm_analemma_desc') + '</div>';
  }
}

// On This Day — render the curated space/science milestones for today's date.
// The wrapping section only appears when the day actually has entries, so the
// almanac never shows an empty "On This Day" box.
function _renderOnThisDay(now) {
  var el = document.getElementById('almanac-onthisday');
  if (!el) return;
  var events = _onThisDay(now);
  if (!events.length) { el.innerHTML = ''; return; }
  var thisYear = now.getFullYear();
  var rows = '';
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var ago = thisYear - ev.y;
    var agoStr = ago > 0 ? String(ago) + ' ' + (ago === 1 ? t('alm_year_ago') : t('alm_years_ago')) : '';
    var evText = (window.AlmanacLinks && window.AlmanacLinks.linkifyEvent)
      ? window.AlmanacLinks.linkifyEvent(ev.t, ev.w) : _almEsc(ev.t);
    rows += '<div class="alm-otd-row">' +
      '<div class="alm-otd-year">' + String(ev.y) + '</div>' +
      '<div class="alm-otd-text">' + evText +
      (agoStr ? ' <span class="alm-otd-ago">' + agoStr + '</span>' : '') + '</div></div>';
  }
  el.innerHTML = '<div class="almanac-section">' +
    '<div class="almanac-section-title">' + t('alm_on_this_day') + '</div>' + rows + '</div>';
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
    html = '<div class="almanac-info-item" style="text-align:center"><div class="almanac-info-val">' + t('alm_no_planets') + '</div><div class="almanac-info-lbl">' + t('alm_planets_near_sun') + '</div></div>';
  } else {
    for (var i = 0; i < visible.length; i++) {
      var p = visible[i];
      var magStr = p.magnitude.toFixed(1);
      // Brightness indicator: dots based on magnitude
      var brightness = p.magnitude < -3 ? t('alm_brightness_brilliant') : p.magnitude < -1 ? t('alm_brightness_very_bright') : p.magnitude < 1 ? t('alm_brightness_bright') : p.magnitude < 3 ? t('alm_brightness_visible') : t('alm_brightness_faint');
      html += '<div class="almanac-eclipse-row">' +
        '<div>' +
        '<span class="almanac-eclipse-type" style="color:' + p.color + '">' + _lp(p.name) + '</span>' +
        '<br><span class="almanac-eclipse-date">' + brightness + ' &middot; ' + _lterm('apparent_magnitude', 'mag') + ' ' + magStr + ' &middot; ' + _lterm('elongation', p.elongation.toFixed(0) + '\u00b0 ' + t('alm_from_sun')) + '</span>' +
        '</div>' +
        '<div class="almanac-eclipse-until" style="font-size:11px">' + p.sky + '<br>' + p.direction + '</div></div>';
    }
    if (notVisible.length > 0) {
      var names = notVisible.map(function(p) { return _lp(p.name); });
      html += '<div style="margin-top:8px;font-size:11px;color:var(--text3);text-align:center">' + names.join(', ') + ' \u2014 ' + t('alm_not_visible_tonight') + '</div>';
    }
  }
  el.innerHTML = html;
}

// ── Meteor Showers ──

var _METEOR_SHOWERS = [
  { key: 'quadrantids', peak: [1, 3], zhr: 120, parent: '2003 EH\u2081', radiant: 'Bo\u00f6tes', speed: 'Medium' },
  { key: 'lyrids', peak: [4, 22], zhr: 18, parent: 'C/1861 G1 Thatcher', radiant: 'Lyra', speed: 'Fast' },
  { key: 'eta_aquariids', peak: [5, 6], zhr: 50, parent: '1P/Halley', radiant: 'Aquarius', speed: 'Fast' },
  { key: 's_delta_aquariids', peak: [7, 30], zhr: 25, parent: '96P/Machholz', radiant: 'Aquarius', speed: 'Medium' },
  { key: 'alpha_capricornids', peak: [7, 30], zhr: 5, parent: '169P/NEAT', radiant: 'Capricornus', speed: 'Slow' },
  { key: 'perseids', peak: [8, 12], zhr: 100, parent: '109P/Swift\u2013Tuttle', radiant: 'Perseus', speed: 'Fast' },
  { key: 'draconids', peak: [10, 8], zhr: 10, parent: '21P/Giacobini\u2013Zinner', radiant: 'Draco', speed: 'Slow' },
  { key: 'orionids', peak: [10, 21], zhr: 20, parent: '1P/Halley', radiant: 'Orion', speed: 'Fast' },
  { key: 'taurids', peak: [11, 5], zhr: 10, parent: '2P/Encke', radiant: 'Taurus', speed: 'Slow' },
  { key: 'leonids', peak: [11, 17], zhr: 15, parent: '55P/Tempel\u2013Tuttle', radiant: 'Leo', speed: 'Fast' },
  { key: 'geminids', peak: [12, 14], zhr: 150, parent: '3200 Phaethon', radiant: 'Gemini', speed: 'Medium' },
  { key: 'ursids', peak: [12, 22], zhr: 10, parent: '8P/Tuttle', radiant: 'Ursa Minor', speed: 'Medium' }
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
      var daysUntil = Math.round((peakDate - now) / MS_PER_DAY);
      if (daysUntil >= -1 && daysUntil <= 365) {
        // Moon interference: check moon illumination on peak night
        var peakMoon = _moonPhase(peakDate);
        var moonInterference = peakMoon.illumination > 60 ? t('alm_moon_poor') : peakMoon.illumination > 30 ? t('alm_moon_fair') : t('alm_moon_ideal');
        var moonIcon = peakMoon.illumination > 60 ? '\u{1F315}' : peakMoon.illumination > 30 ? '\u{1F313}' : '\u{1F311}';
        upcoming.push({
          key: s.key, zhr: s.zhr, parent: s.parent, radiant: s.radiant,
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
    // A shower at (or just past) its peak gets a highlighted chip; everything
    // else is a plain amber countdown value.
    var isPeaking = s.daysUntil < 0;
    var untilStr = isPeaking ? t('alm_peak') : s.daysUntil === 0 ? t('alm_tonight') : s.daysUntil === 1 ? t('alm_tomorrow') : s.daysUntil + ' ' + t('alm_days');
    var untilClass = 'almanac-eclipse-until' + (isPeaking ? ' almanac-eclipse-peak' : '');
    var rateDesc = s.zhr >= 100 ? t('alm_meteor_major') : s.zhr >= 25 ? t('alm_meteor_moderate') : t('alm_meteor_minor');
    var condColor = s.moonCondition === t('alm_moon_ideal') ? 'var(--accent)' : s.moonCondition === t('alm_moon_fair') ? 'var(--text2)' : 'var(--text3)';
    html += '<div class="almanac-eclipse-row">' +
      '<div>' +
      '<span class="almanac-eclipse-type">' + _alLink('shower:' + s.key, t('alm_shower_' + s.key)) + '</span>' +
      '<br><span class="almanac-eclipse-date">~' + s.zhr + t('alm_per_hour') + ' &middot; ' + _lc(s.radiant) + ' &middot; ' + t('alm_speed_' + s.speed.toLowerCase()) +
      ' &middot; <span style="color:' + condColor + '">' + s.moonIcon + ' ' + s.moonCondition + '</span></span>' +
      '</div>' +
      '<div class="' + untilClass + '">' + untilStr + '</div></div>';
  }
  html += '<div style="margin-top:10px;font-size:11px;color:var(--text3)">' + t('alm_moon_conditions') + ': ' +
    '\u{1F311} ' + t('alm_moon_ideal_desc') + ' &middot; \u{1F313} ' + t('alm_moon_fair') + ' &middot; \u{1F315} ' + t('alm_moon_poor_desc') + '</div>';
  el.innerHTML = html;
}

// ── Celestial Events — conjunctions, oppositions, elongations ──

function _scanCelestialEvents(now) {
  var JD0 = _dateToJD(now.getTime());
  var scanNames = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
  var events = [];

  // Precompute positions at 2-day intervals for 400 days (speed vs accuracy tradeoff)
  var DAYS = 400, STEP = 2;
  var cache = {};
  for (var d = 0; d <= DAYS; d += STEP) {
    var T = _jdToJulianCentury(JD0 + d);
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
          date: new Date(now.getTime() + bestDay * MS_PER_DAY) });
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
        date: new Date(now.getTime() + bestDay * MS_PER_DAY) });
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
          sky: sky, daysUntil: bestDay, date: new Date(now.getTime() + bestDay * MS_PER_DAY) });
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
  var _almLocale = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';

  var html = '';
  if (events.length === 0) {
    html = '<div style="text-align:center;color:var(--text3);font-size:13px;padding:12px 0">' + t('alm_no_events') + '</div>';
  } else {
    var soonEvents = [], laterEvents = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].daysUntil <= 60) soonEvents.push(events[i]);
      else laterEvents.push(events[i]);
    }
    var allVisible = soonEvents.concat(laterEvents);
    for (var i = 0; i < allVisible.length; i++) {
      var ev = allVisible[i];
      var dateStr = ev.date.toLocaleDateString(_almLocale, { month: 'short', day: 'numeric', year: 'numeric' });
      var untilStr = ev.daysUntil <= 1 ? t('alm_now_exclaim') : ev.daysUntil + ' ' + t('alm_days');
      var title, detail;
      if (ev.type === 'conjunction') {
        title = _lp(ev.planets[0]) + ' \u2013 ' + _lp(ev.planets[1]) + ' ' + _lterm('conjunction', t('alm_conjunction'));
        detail = ev.separation.toFixed(1) + '\u00b0 ' + t('alm_apart') + ' &middot; ' + dateStr;
      } else if (ev.type === 'opposition') {
        title = _lp(ev.planet) + ' ' + _lterm('opposition', t('alm_at_opposition'));
        detail = t('alm_closest_brightest') + ' &middot; ' + dateStr;
      } else if (ev.type === 'elongation') {
        title = _lp(ev.planet) + ' ' + _lterm('elongation', t('alm_greatest_elongation'));
        var skyLabel = ev.sky === 'evening' ? t('alm_evening') : t('alm_morning');
        detail = ev.elongation.toFixed(1) + '\u00b0 &middot; ' + skyLabel + ' ' + t('alm_sky') + ' &middot; ' + dateStr;
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
        t('alm_show_more', { n: laterEvents.length }) + '</a></div>';
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

// Hindu & Sikh holidays — verified dates from drikpanchang.com (New Delhi panchang)
// Lookup table used for accuracy: Hindu calendar dates depend on tithi-at-sunrise in IST,
// which can't be reliably computed from astronomical data alone (±1 day errors).
// For years outside the table, falls back to lunar approximation.
var _HINDU_SIKH_DATES = {
  //       Holi        Ram Navami  Raksha B.   Janmasht.   Ganesh Ch.  Navratri    Dussehra    Diwali      Guru Nanak
  2024: [[3,25],      [4,17],     [8,19],     [8,26],     [9,7],      [10,3],     [10,12],    [11,1],     [11,15]],
  2025: [[3,14],      [4,6],      [8,9],      [8,15],     [8,27],     [9,22],     [10,2],     [10,20],    [11,5]],
  2026: [[3,4],       [3,26],     [8,28],     [9,4],      [9,14],     [10,11],    [10,20],    [11,8],     [11,24]],
  2027: [[3,22],      [4,15],     [8,17],     [8,25],     [9,3],      [9,30],     [10,9],     [10,28],    [11,14]],
  2028: [[3,11],      [4,3],      [8,5],      [8,13],     [8,23],     [9,19],     [9,27],     [10,17],    [11,2]],
  2029: [[3,1],       [4,23],     [8,23],     [9,1],      [9,11],     [10,8],     [10,16],    [11,5],     [11,21]],
  2030: [[3,20],      [4,12],     [8,13],     [8,21],     [9,1],      [9,28],     [10,6],     [10,25],    [11,10]]
};
var _HINDU_SIKH_NAMES = [
  'Holi', 'Ram Navami', 'Raksha Bandhan', 'Janmashtami', 'Ganesh Chaturthi',
  'Navratri begins', 'Dussehra', 'Diwali', 'Guru Nanak Jayanti'
];
var _hinduSikhCache = { year: 0, holidays: [] };
function _hinduSikhHolidays(year) {
  if (_hinduSikhCache.year === year) return _hinduSikhCache.holidays;
  var h = [];
  // Fixed Gregorian dates (solar, not lunar — same every year)
  h.push({m: 1, d: 14, name: 'Makar Sankranti'});
  h.push({m: 4, d: 14, name: 'Vaisakhi'});
  // Use lookup table for verified years
  var table = _HINDU_SIKH_DATES[year];
  if (table) {
    for (var i = 0; i < table.length; i++) {
      h.push({m: table[i][0], d: table[i][1], name: _HINDU_SIKH_NAMES[i]});
    }
  } else {
    // Fallback for years outside table: approximate from lunar phase
    h = h.concat(_hinduSikhApprox(year));
  }
  _hinduSikhCache = { year: year, holidays: h };
  return h;
}

// Approximate Hindu holidays from lunar phases (fallback for years without verified dates)
function _findMoonNear(year, anchorMonth, anchorDay, type) {
  var target = type === 'full' ? 0.5 : 0;
  var anchor = new Date(year, anchorMonth - 1, anchorDay);
  var best = null, bestDist = 1;
  for (var i = -15; i <= 15; i++) {
    var d = new Date(anchor.getTime() + i * 86400000);
    var p = _moonPhase(d).phase;
    var dist = Math.abs(p - target);
    if (dist > 0.5) dist = 1 - dist;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best ? { month: best.getMonth() + 1, day: best.getDate() } : null;
}
function _hinduSikhApprox(year) {
  var h = [];
  var chaitra = _findMoonNear(year, 3, 29, 'new');
  if (!chaitra) return h;
  var _nmBase = new Date(year, chaitra.month - 1, chaitra.day);
  function _nthNM(n) {
    var approx = new Date(_nmBase.getTime() + Math.round(n * 29.53) * 86400000);
    return _findMoonNear(approx.getFullYear(), approx.getMonth() + 1, approx.getDate(), 'new');
  }
  function _purnima(nm) {
    if (!nm) return null;
    var approx = new Date(year, nm.month - 1, nm.day + 15);
    return _findMoonNear(approx.getFullYear(), approx.getMonth() + 1, approx.getDate(), 'full');
  }
  var preC = new Date(year, chaitra.month - 1, chaitra.day - 15);
  var holi = _findMoonNear(preC.getFullYear(), preC.getMonth() + 1, preC.getDate(), 'full');
  if (holi) h.push({m: holi.month, d: holi.day, name: 'Holi'});
  var rn = new Date(year, chaitra.month - 1, chaitra.day + 9);
  h.push({m: rn.getMonth() + 1, d: rn.getDate(), name: 'Ram Navami'});
  var nm4 = _nthNM(4);
  var sp = _purnima(nm4);
  if (sp) {
    h.push({m: sp.month, d: sp.day, name: 'Raksha Bandhan'});
    var jk = new Date(year, sp.month - 1, sp.day + 8);
    h.push({m: jk.getMonth() + 1, d: jk.getDate(), name: 'Janmashtami'});
  }
  var nm5 = _nthNM(5);
  if (nm5) { var gc = new Date(year, nm5.month - 1, nm5.day + 4); h.push({m: gc.getMonth() + 1, d: gc.getDate(), name: 'Ganesh Chaturthi'}); }
  var nm6 = _nthNM(6);
  if (nm6) {
    var nv = new Date(year, nm6.month - 1, nm6.day + 1); h.push({m: nv.getMonth() + 1, d: nv.getDate(), name: 'Navratri begins'});
    var ds = new Date(year, nm6.month - 1, nm6.day + 10); h.push({m: ds.getMonth() + 1, d: ds.getDate(), name: 'Dussehra'});
  }
  var nm7 = _nthNM(7);
  if (nm7) h.push({m: nm7.month, d: nm7.day, name: 'Diwali'});
  var kp = _purnima(nm7);
  if (kp) h.push({m: kp.month, d: kp.day, name: 'Guru Nanak Jayanti'});
  return h;
}

// ── Region-aware Gregorian holidays (issue #28) ─────────────────────────
// The Gregorian calendar used to show a US-only view of the world. The
// international base always renders; a region pack layers national days on
// top. Region comes from the browser locale's country subtag, then the IANA
// timezone. All offline — data + date math, no APIs.
// fixed: [month, day, label]; nth: [month, weekday(0=Sun), n, label] where
// n=-1 means last; dst: 'us' | 'eu' | 'au' | null.
var _REGION_HOLIDAYS = {
  US: {
    fixed: [[2, 2, 'Groundhog Day'], [4, 15, 'Tax Day'], [5, 5, 'Cinco de Mayo'], [6, 14, 'Flag Day'], [6, 19, 'Juneteenth'], [7, 4, 'Independence Day'], [9, 11, 'Patriot Day'], [11, 11, 'Veterans Day'], [12, 26, 'Kwanzaa']],
    nth: [[1, 1, 3, 'Martin Luther King Jr. Day'], [2, 0, 2, 'Super Bowl Sunday'], [2, 1, 3, "Presidents' Day"], [5, 1, -1, 'Memorial Day'], [9, 1, 1, 'Labor Day'], [10, 1, 2, "Indigenous Peoples' Day"], [11, 4, 4, 'Thanksgiving']],
    dst: 'us'
  },
  CA: {
    fixed: [[7, 1, 'Canada Day'], [9, 30, 'Truth and Reconciliation Day'], [12, 26, 'Boxing Day']],
    nth: [[9, 1, 1, 'Labour Day'], [10, 1, 2, 'Thanksgiving']],
    dst: 'us'
  },
  GB: {
    fixed: [[4, 23, "St. George's Day"], [11, 5, 'Guy Fawkes Night'], [11, 11, 'Remembrance Day'], [12, 26, 'Boxing Day']],
    nth: [[5, 1, 1, 'Early May Bank Holiday'], [5, 1, -1, 'Spring Bank Holiday'], [8, 1, -1, 'Summer Bank Holiday']],
    dst: 'eu'
  },
  IE: { fixed: [[2, 1, "St. Brigid's Day"], [12, 26, "St. Stephen's Day"]], nth: [[10, 1, -1, 'October Bank Holiday']], dst: 'eu' },
  FR: { fixed: [[5, 8, 'Victory in Europe Day'], [7, 14, 'Bastille Day'], [11, 11, 'Armistice Day']], dst: 'eu' },
  DE: { fixed: [[10, 3, 'German Unity Day'], [12, 6, 'Nikolaus'], [12, 26, 'Second Christmas Day']], dst: 'eu' },
  IT: { fixed: [[4, 25, 'Liberation Day'], [6, 2, 'Republic Day'], [8, 15, 'Ferragosto'], [12, 26, "St. Stephen's Day"]], dst: 'eu' },
  ES: { fixed: [[10, 12, 'Fiesta Nacional'], [12, 6, 'Constitution Day'], [12, 8, 'Immaculate Conception']], dst: 'eu' },
  AU: { fixed: [[1, 26, 'Australia Day'], [4, 25, 'ANZAC Day'], [12, 26, 'Boxing Day']], dst: 'au' },
  NZ: { fixed: [[2, 6, 'Waitangi Day'], [4, 25, 'ANZAC Day'], [12, 26, 'Boxing Day']], dst: 'au' },
  IN: { fixed: [[1, 26, 'Republic Day'], [8, 15, 'Independence Day'], [10, 2, 'Gandhi Jayanti']], dst: null },
  BR: { fixed: [[4, 21, 'Tiradentes'], [9, 7, 'Independence Day'], [10, 12, 'Nossa Senhora Aparecida'], [11, 15, 'Republic Day'], [11, 20, 'Black Consciousness Day']], dst: null },
  MX: { fixed: [[2, 5, 'Constitution Day'], [5, 5, 'Cinco de Mayo'], [9, 16, 'Independence Day'], [11, 1, 'Day of the Dead'], [11, 2, 'Day of the Dead II']], dst: null },
  JP: { fixed: [[2, 11, 'National Foundation Day'], [4, 29, 'Showa Day'], [5, 3, 'Constitution Day'], [5, 5, "Children's Day"], [8, 11, 'Mountain Day'], [11, 3, 'Culture Day']], dst: null },
  CN: { fixed: [[5, 4, 'Youth Day'], [10, 1, 'National Day']], dst: null },
  ZA: { fixed: [[3, 21, 'Human Rights Day'], [4, 27, 'Freedom Day'], [6, 16, 'Youth Day'], [9, 24, 'Heritage Day'], [12, 16, 'Day of Reconciliation'], [12, 26, 'Day of Goodwill']], dst: null },
  RU: { fixed: [[1, 7, 'Orthodox Christmas'], [2, 23, 'Defender of the Fatherland Day'], [5, 9, 'Victory Day'], [6, 12, 'Russia Day'], [11, 4, 'Unity Day']], dst: null },
  // Pseudo-region: European locale without its own pack — correct DST rule.
  EU: { fixed: [[12, 26, 'Boxing Day']], dst: 'eu' }
};

// Timezones that pin a region when the locale has no country subtag.
var _TZ_REGION = {
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Adelaide': 'AU', 'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ', 'Asia/Kolkata': 'IN', 'America/Sao_Paulo': 'BR',
  'America/Mexico_City': 'MX', 'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN',
  'Africa/Johannesburg': 'ZA', 'Europe/Moscow': 'RU'
};

// Nearest-anchor country resolution for map clicks. Anchors tagged '' are
// major non-pack countries — they exist so a click on, say, Nigeria gets
// the international set instead of snapping to the nearest pack country.
// Coarse by design: ~80 anchors, borders are approximate.
var _REGION_ANCHORS = [
  [40.7, -74.0, 'US'], [34.1, -118.2, 'US'], [41.9, -87.6, 'US'], [29.8, -95.4, 'US'], [39.7, -105.0, 'US'], [47.6, -122.3, 'US'], [25.8, -80.2, 'US'], [42.4, -71.1, 'US'], [61.2, -149.9, 'US'], [21.3, -157.9, 'US'],
  [49.3, -123.1, 'CA'], [51.0, -114.1, 'CA'], [43.7, -79.4, 'CA'], [45.5, -73.6, 'CA'], [44.6, -63.6, 'CA'], [53.5, -113.5, 'CA'],
  [19.4, -99.1, 'MX'], [25.7, -100.3, 'MX'], [21.2, -86.8, 'MX'],
  [-23.6, -46.6, 'BR'], [-15.8, -47.9, 'BR'], [-3.1, -60.0, 'BR'], [-8.1, -34.9, 'BR'],
  [51.5, -0.1, 'GB'], [53.5, -2.2, 'GB'], [55.9, -3.2, 'GB'], [53.3, -6.3, 'IE'],
  [48.9, 2.4, 'FR'], [45.8, 4.8, 'FR'], [43.6, 1.4, 'FR'],
  [52.5, 13.4, 'DE'], [48.1, 11.6, 'DE'], [50.1, 8.7, 'DE'],
  [41.9, 12.5, 'IT'], [45.5, 9.2, 'IT'], [40.9, 14.3, 'IT'],
  [40.4, -3.7, 'ES'], [41.4, 2.2, 'ES'], [37.4, -6.0, 'ES'],
  [-33.9, 151.2, 'AU'], [-37.8, 145.0, 'AU'], [-27.5, 153.0, 'AU'], [-31.9, 115.9, 'AU'], [-34.9, 138.6, 'AU'], [-12.5, 130.8, 'AU'],
  [-36.8, 174.8, 'NZ'], [-41.3, 174.8, 'NZ'], [-43.5, 172.6, 'NZ'],
  [28.6, 77.2, 'IN'], [19.1, 72.9, 'IN'], [22.6, 88.4, 'IN'], [13.1, 80.3, 'IN'], [12.9, 77.6, 'IN'],
  [35.7, 139.7, 'JP'], [34.7, 135.5, 'JP'], [43.1, 141.4, 'JP'],
  [39.9, 116.4, 'CN'], [31.2, 121.5, 'CN'], [30.6, 104.1, 'CN'], [23.1, 113.3, 'CN'], [43.8, 87.6, 'CN'],
  [55.8, 37.6, 'RU'], [59.9, 30.4, 'RU'], [55.0, 82.9, 'RU'], [56.8, 60.6, 'RU'], [43.1, 131.9, 'RU'],
  [-26.2, 28.0, 'ZA'], [-33.9, 18.4, 'ZA'], [-29.9, 31.0, 'ZA'],
  [64.1, -21.9, ''], [59.9, 10.8, ''], [59.3, 18.1, ''], [60.2, 24.9, ''], [52.2, 21.0, ''], [48.2, 16.4, ''], [47.4, 8.5, ''], [52.4, 4.9, ''], [50.8, 4.4, ''], [38.7, -9.1, ''], [38.0, 23.7, ''], [41.0, 28.9, ''], [50.5, 30.5, ''], [44.4, 26.1, ''], [47.5, 19.0, ''], [50.1, 14.4, ''], [55.7, 12.6, ''],
  [30.0, 31.2, ''], [6.5, 3.4, ''], [-1.3, 36.8, ''], [9.0, 38.7, ''], [33.6, -7.6, ''], [36.8, 10.2, ''], [-4.3, 15.3, ''], [5.6, -0.2, ''],
  [24.7, 46.7, ''], [25.2, 55.3, ''], [35.7, 51.4, ''], [33.3, 44.4, ''], [32.1, 34.8, ''], [24.9, 67.0, ''], [23.8, 90.4, ''], [27.7, 85.3, ''], [6.9, 79.9, ''],
  [13.8, 100.5, ''], [21.0, 105.8, ''], [14.6, 121.0, ''], [-6.2, 106.8, ''], [3.1, 101.7, ''], [1.4, 103.8, ''], [37.6, 127.0, ''], [25.0, 121.6, ''], [47.9, 106.9, ''],
  [-34.6, -58.4, ''], [-33.4, -70.7, ''], [-12.0, -77.0, ''], [4.7, -74.1, ''], [10.5, -66.9, ''], [23.1, -82.4, ''], [14.6, -90.5, '']
];

// Location (map click / city pick / GPS) → holiday region. Nearest anchor
// wins; nothing within ~15 degrees (open ocean) means international-only.
function _almRegionForLocation(lat, lon) {
  var best = '', bestD = Infinity;
  for (var i = 0; i < _REGION_ANCHORS.length; i++) {
    var a = _REGION_ANCHORS[i];
    var dlat = lat - a[0];
    var dlon = (lon - a[1]) * Math.cos(lat * DEG_TO_RAD);
    var d = dlat * dlat + dlon * dlon;
    if (d < bestD) { bestD = d; best = a[2]; }
  }
  return bestD <= 225 ? best : '';
}

// Localized country name for the caption ("Showing United States holidays")
function _almRegionName(region) {
  if (!region || region === 'EU') return '';
  try {
    var lang = (typeof _currentLang !== 'undefined' && _currentLang) ? _currentLang : 'en';
    return new Intl.DisplayNames([lang], { type: 'region' }).of(region) || region;
  } catch (e) { return region; }
}

function _almRegion() {
  // The chosen location is the source of truth: clicking Italy on the map
  // means Italian holidays, whatever the browser locale says.
  var loc = _getLocation();
  if (loc.stored) return _almRegionForLocation(loc.lat, loc.lon);
  try {
    var m = String(navigator.language || '').match(/[-_]([A-Za-z]{2})(\b|$)/);
    if (m) {
      var r = m[1].toUpperCase();
      if (_REGION_HOLIDAYS[r]) return r;
      // Known locale country without a pack: still want the right DST rule
      if (/^(AT|BE|BG|CH|CY|CZ|DK|EE|FI|GR|HR|HU|LT|LU|LV|MT|NL|NO|PL|PT|RO|SE|SI|SK|UA)$/.test(r)) return 'EU';
    }
  } catch (e) {}
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (_TZ_REGION[tz]) return _TZ_REGION[tz];
    if (tz.indexOf('Europe/') === 0) return 'EU';
    if (tz.indexOf('America/') === 0) return 'US';
  } catch (e) {}
  return '';
}

function _applyRegionHolidays(region, year, month, add, worldwide) {
  var pack = _REGION_HOLIDAYS[region];
  if (!pack) return;
  // Region-scoped: the caption already names the country, so each entry's tag is
  // just its colour. Worldwide: 18 packs at once, so every entry carries the
  // full country name ("Bastille Day · France") to say whose day it is — the
  // same ISO→name map the cell tooltip uses, falling back to the ISO code if
  // Intl.DisplayNames is unavailable.
  var src = _almRegionName(region) || region;
  var i;
  for (i = 0; i < (pack.fixed || []).length; i++) {
    var fx = pack.fixed[i];
    if (fx[0] === month) add(fx[1], fx[2], 'holiday', '', src, region);
  }
  for (i = 0; i < (pack.nth || []).length; i++) {
    var nh = pack.nth[i];
    if (nh[0] !== month) continue;
    var day = nh[2] === -1 ? _lastWeekday(year, month, nh[1]) : _nthWeekday(year, month, nh[1], nh[2]);
    add(day, nh[3], 'holiday', '', src, region);
  }
  // Clock changes are location-specific; layering 18 countries' worth would be
  // pure noise, so only the single region-scoped pack contributes them.
  if (worldwide) return;
  // Clock changes: labels hold both hemispheres (October IS spring in AU)
  var dst = pack.dst;
  if (dst === 'us') {
    if (month === 3) add(_nthWeekday(year, 3, 0, 2), 'Spring Forward', 'seasonal');
    if (month === 11) add(_nthWeekday(year, 11, 0, 1), 'Fall Back', 'seasonal');
  } else if (dst === 'eu') {
    if (month === 3) add(_lastWeekday(year, 3, 0), 'Clocks Forward', 'seasonal');
    if (month === 10) add(_lastWeekday(year, 10, 0), 'Clocks Back', 'seasonal');
  } else if (dst === 'au') {
    if (month === 10) add(_nthWeekday(year, 10, 0, 1), 'Clocks Forward', 'seasonal');
    if (month === 4) add(_nthWeekday(year, 4, 0, 1), 'Clocks Back', 'seasonal');
  }
}

// Worldwide scope: layer every national pack (skipping the EU pseudo-region,
// which carries no national days of its own, only a DST rule). Each entry is
// tagged with its full country name (ISO code as fallback) via the worldwide
// path of _applyRegionHolidays.
function _applyAllRegionHolidays(year, month, add) {
  for (var iso in _REGION_HOLIDAYS) {
    if (iso === 'EU') continue;
    _applyRegionHolidays(iso, year, month, add, true);
  }
}

// ── Equinoxes & solstices: computed, not hardcoded (Meeus ch. 27) ──────
// JDE0 mean-instant polynomials (valid 1000-3000 CE) plus the 24-term
// periodic correction — accurate to minutes. The old code pinned fixed
// dates (Mar 20/Jun 20/Sep 22/Dec 21), which drift a day across years.
var _SEASON_JDE0 = [
  [2451623.80984, 365242.37404, -0.05169, 0.00411, 0.00057],   // March eq. (Meeus 27.B; signs were transcribed flipped)
  [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.00030],   // June sol.
  [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],   // Sept eq.
  [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032]   // Dec sol.
];
var _SEASON_PERIODIC = [
  [485, 324.96, 1934.136], [203, 337.23, 32964.467], [199, 342.08, 20.186],
  [182, 27.85, 445267.112], [156, 73.14, 45036.886], [136, 171.52, 22518.443],
  [77, 222.54, 65928.934], [74, 296.72, 3034.906], [70, 243.58, 9037.513],
  [58, 119.81, 33718.147], [52, 297.17, 150.678], [50, 21.02, 2281.226],
  [45, 247.54, 29929.562], [44, 325.15, 31555.956], [29, 60.93, 4443.417],
  [18, 155.12, 67555.328], [17, 288.79, 4562.452], [16, 198.04, 62894.029],
  [14, 199.76, 31436.921], [12, 95.39, 14577.848], [12, 287.11, 31931.756],
  [12, 320.81, 34777.259], [9, 227.73, 1222.114], [8, 15.45, 16859.074]
];

function _seasonInstantJDE(year, k) {
  var Y = (year - 2000) / 1000;
  var c = _SEASON_JDE0[k];
  var J0 = c[0] + c[1] * Y + c[2] * Y * Y + c[3] * Y * Y * Y + c[4] * Y * Y * Y * Y;
  var T = (J0 - 2451545.0) / 36525;
  var W = (35999.373 * T - 2.47) * DEG_TO_RAD;
  var dl = 1 + 0.0334 * Math.cos(W) + 0.0007 * Math.cos(2 * W);
  var S = 0;
  for (var i = 0; i < _SEASON_PERIODIC.length; i++) {
    var t2 = _SEASON_PERIODIC[i];
    S += t2[0] * Math.cos((t2[1] + t2[2] * T) * DEG_TO_RAD);
  }
  return J0 + (0.00001 * S) / dl;
}

var _seasonCache = { year: 0, events: [] };

function _seasonEventsForYear(year) {
  if (_seasonCache.year === year) return _seasonCache.events;
  // Hemisphere-aware names: October IS spring in Sydney. Chosen location
  // decides; no location defaults to the northern names.
  var loc = _getLocation();
  var south = !!(loc.stored && loc.lat < 0);
  var names = south
    ? ['Autumn Equinox', 'Winter Solstice', 'Spring Equinox', 'Summer Solstice']
    : ['Spring Equinox', 'Summer Solstice', 'Autumn Equinox', 'Winter Solstice'];
  var events = [];
  for (var k = 0; k < 4; k++) {
    // JDE (TT ~ UTC at day precision) -> the user's local calendar date
    var d = new Date((_seasonInstantJDE(year, k) - 2440587.5) * 86400000);
    events.push({ month: d.getMonth() + 1, day: d.getDate(), label: names[k] });
  }
  _seasonCache = { year: year, events: events };
  return events;
}

// Get almanac events for a given calendar system's month, keyed by day number
function _getAlmanacEvents(sys, year, month) {
  var events = {};
  function add(day, label, type, icon, src, region) {
    if (day < 1 || day > 31) return;
    if (!events[day]) events[day] = [];
    // Belt-and-suspenders: base set + one region pack should never
    // collide, but a same-day duplicate label renders as noise if they do.
    for (var di = 0; di < events[day].length; di++) {
      if (events[day][di].label === label) return;
    }
    // `region` (ISO code) lets a shared label like "Independence Day" deep-link
    // to the right country's article; '' for worldwide/native events.
    events[day].push({ label: label, type: type, icon: icon || '', src: src || '', region: region || '' });
  }

  // Base worldwide / regional / astronomical events are computed on absolute
  // Gregorian dates and projected onto whatever grid is shown (each display day
  // has a JDN → look up that Gregorian date's events), so switching calendars
  // no longer drops them. Then layer this system's own native table on top.
  var daysInMonth = _calDaysInMonth(sys, year, month);
  var firstJDN = _calFirstDayJDN(sys, year, month);
  var gregMonths = {};
  for (var _pd = 1; _pd <= daysInMonth; _pd++) {
    var _pg = _jdnToGregorian(firstJDN + _pd - 1);
    gregMonths[_pg.year * 100 + _pg.month] = { gy: _pg.year, gm: _pg.month };
  }
  var baseByJDN = {};
  for (var _gk in gregMonths) {
    (function (gy, gm) {
      _gregorianBaseEvents(gy, gm, function (gDay, label, type, icon, src) {
        var jdn = _gregorianToJDN(gy, gm, gDay);
        (baseByJDN[jdn] = baseByJDN[jdn] || []).push({ label: label, type: type, icon: icon || '', src: src || '' });
      });
    })(gregMonths[_gk].gy, gregMonths[_gk].gm);
  }
  for (var _dd = 1; _dd <= daysInMonth; _dd++) {
    var _be = baseByJDN[firstJDN + _dd - 1];
    if (_be) for (var _bi = 0; _bi < _be.length; _bi++) add(_dd, _be[_bi].label, _be[_bi].type, _be[_bi].icon, _be[_bi].src);
  }

  _systemNativeEvents(sys, year, month, add);
  return events;
}

// The rich base event set, keyed by Gregorian day of `month` via add(day,...).
function _gregorianBaseEvents(year, month, add) {
  {
    // International base — observed widely enough to show everywhere. Mix of
    // UN international days, cultural observances, and a few for fun.
    if (month === 1) { add(1, t('hol_new_year_day'), 'holiday'); add(4, 'World Braille Day', 'holiday'); add(6, 'Epiphany', 'holiday'); add(24, 'International Day of Education', 'holiday'); add(27, 'Holocaust Remembrance Day', 'holiday'); }
    if (month === 2) { add(4, 'World Cancer Day', 'holiday'); add(11, 'Intl. Day of Women in Science', 'holiday'); add(12, 'Darwin Day', 'holiday'); add(14, t('hol_valentines'), 'holiday'); add(21, 'International Mother Language Day', 'holiday'); }
    if (month === 3) { add(3, 'World Wildlife Day', 'holiday'); add(8, "International Women's Day", 'holiday'); add(14, 'Pi Day', 'holiday'); add(17, "St. Patrick's Day", 'holiday'); add(20, 'International Day of Happiness', 'holiday'); add(21, 'World Poetry Day', 'holiday'); add(22, 'World Water Day', 'holiday'); add(27, 'World Theatre Day', 'holiday'); }
    if (month === 4) { add(1, "April Fools' Day", 'holiday'); add(7, 'World Health Day', 'holiday'); add(15, 'World Art Day', 'holiday'); add(22, t('hol_earth_day'), 'holiday'); add(23, 'World Book Day', 'holiday'); add(29, 'International Dance Day', 'holiday'); }
    if (month === 5) { add(1, "May Day / Workers' Day", 'holiday'); add(3, 'World Press Freedom Day', 'holiday'); add(4, 'Star Wars Day', 'holiday'); add(15, 'International Day of Families', 'holiday'); add(20, 'World Bee Day', 'holiday'); add(25, 'Towel Day', 'holiday'); }
    if (month === 6) { add(5, 'World Environment Day', 'holiday'); add(8, 'World Oceans Day', 'holiday'); add(20, 'World Refugee Day', 'holiday'); add(21, 'International Yoga Day', 'holiday'); add(21, 'World Music Day', 'holiday'); }
    if (month === 7) { add(11, 'World Population Day', 'holiday'); add(17, 'World Emoji Day', 'holiday'); add(18, 'Nelson Mandela Day', 'holiday'); add(20, 'Moon Landing Day', 'holiday'); add(30, 'International Friendship Day', 'holiday'); }
    if (month === 8) { add(8, 'International Cat Day', 'holiday'); add(12, 'International Youth Day', 'holiday'); add(19, 'World Humanitarian Day', 'holiday'); add(19, 'World Photography Day', 'holiday'); add(26, 'International Dog Day', 'holiday'); }
    if (month === 9) { add(8, 'International Literacy Day', 'holiday'); add(21, 'International Day of Peace', 'holiday'); add(23, 'International Day of Sign Languages', 'holiday'); add(27, 'World Tourism Day', 'holiday'); }
    if (month === 10) { add(1, 'International Coffee Day', 'holiday'); add(4, 'World Animal Day', 'holiday'); add(5, "World Teachers' Day", 'holiday'); add(10, 'World Mental Health Day', 'holiday'); add(16, 'World Food Day', 'holiday'); add(24, 'United Nations Day', 'holiday'); add(31, t('hol_halloween'), 'holiday'); }
    if (month === 11) { add(10, 'World Science Day', 'holiday'); add(13, 'World Kindness Day', 'holiday'); add(19, "International Men's Day", 'holiday'); add(20, "World Children's Day", 'holiday'); add(21, 'World Television Day', 'holiday'); }
    if (month === 12) { add(3, 'Intl. Day of Persons with Disabilities', 'holiday'); add(5, 'International Volunteer Day', 'holiday'); add(10, 'Human Rights Day', 'holiday'); add(11, 'International Mountain Day', 'holiday'); add(24, t('hol_christmas_eve'), 'holiday'); add(25, t('hol_christmas'), 'holiday'); add(31, t('hol_new_year_eve'), 'holiday'); }
    // Mother's/Father's Day on the US dates — the majority convention
    // (US, CA, AU, DE, IT, BR, IN, CN, JP and others)
    if (month === 5) { add(_nthWeekday(year, 5, 0, 2), t('hol_mothers_day'), 'holiday'); }
    if (month === 6) { add(_nthWeekday(year, 6, 0, 3), t('hol_fathers_day'), 'holiday'); }
    // National days: every pack when Worldwide is chosen, else the detected
    // region's (which also contributes its clock changes).
    if (_almHolidayScope() === 'worldwide') _applyAllRegionHolidays(year, month, add);
    else _applyRegionHolidays(_almRegion(), year, month, add);
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
    // Hindu & Sikh holidays (lookup table for 2024-2030, lunar approx fallback)
    var _hsh = _hinduSikhHolidays(year);
    for (var _hi = 0; _hi < _hsh.length; _hi++) {
      if (_hsh[_hi].m === month) add(_hsh[_hi].d, _hsh[_hi].name, 'holiday');
    }
    // Solstices & Equinoxes — computed (Meeus), hemisphere-aware labels
    var seasonEvents = _seasonEventsForYear(year);
    for (var sei = 0; sei < seasonEvents.length; sei++) {
      if (seasonEvents[sei].month === month) {
        add(seasonEvents[sei].day, seasonEvents[sei].label, 'astro');
      }
    }
  }

  // Meteor shower peaks — Gregorian dates, so part of the projected base.
  for (var si = 0; si < _METEOR_SHOWERS.length; si++) {
    var s = _METEOR_SHOWERS[si];
    if (s.peak[0] === month) { add(s.peak[1], _showerName(s), 'meteor', '☄'); }
  }
}

// Each calendar system's own native religious/civil holidays, keyed to that
// system's own month & day (layered on top of the projected Gregorian base).
function _systemNativeEvents(sys, year, month, add) {
  if (sys === 'hebrew') {
    // `month` arrives as a DISPLAY position into the Hebrew month list, which
    // omits Adar I in non-leap years — so from position 6 on it sits one
    // ahead of the internal month code (1=Tishrei … 7=Adar/Adar II, 8=Nisan
    // … 13=Elul). Convert, then key on the code. The old code treated the
    // position AS the code, landing Passover in Iyar, Shavuot in Tammuz, etc.
    // in every non-leap year (12 of 19; 5786/2026 is one).
    var isLeap = _hebrewLeapYear(year);
    var code = (!isLeap && month >= 6) ? month + 1 : month;
    var HAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
    var kislevLen = _hebrewMonthDays(year, 3); // 29 or 30 — shifts Hanukkah's tail into Tevet
    if (code === 1) { add(1, 'Rosh Hashanah', 'holiday'); add(2, 'Rosh Hashanah II', 'holiday'); add(3, 'Tzom Gedaliah', 'holiday'); add(10, 'Yom Kippur', 'holiday'); add(15, 'Sukkot', 'holiday'); add(16, 'Sukkot II', 'holiday'); add(21, 'Hoshana Rabbah', 'holiday'); add(22, "Sh'mini Atzeret", 'holiday'); add(23, 'Simchat Torah', 'holiday'); }
    if (code === 3) { for (var _hk = 25; _hk <= kislevLen; _hk++) add(_hk, 'Hanukkah ' + HAN[_hk - 24], 'holiday'); }
    if (code === 4) { var _ht = 8 - (kislevLen - 24); for (var _td = 1; _td <= _ht; _td++) add(_td, 'Hanukkah ' + HAN[kislevLen - 24 + _td], 'holiday'); add(10, "Asara B'Tevet", 'holiday'); }
    if (code === 5) { add(15, "Tu BiShvat", 'holiday'); }
    if (code === 7) { add(13, 'Fast of Esther', 'holiday'); add(14, 'Purim', 'holiday'); add(15, 'Shushan Purim', 'holiday'); }
    if (code === 8) { add(14, 'Erev Pesach', 'holiday'); add(15, 'Passover', 'holiday'); add(16, 'Passover II', 'holiday'); add(21, 'Passover VII', 'holiday'); add(22, 'Passover VIII', 'holiday'); add(27, 'Yom HaShoah', 'holiday'); }
    if (code === 9) { add(4, 'Yom HaZikaron', 'holiday'); add(5, "Yom Ha'Atzmaut", 'holiday'); add(14, 'Pesach Sheni', 'holiday'); add(18, "Lag BaOmer", 'holiday'); add(28, 'Yom Yerushalayim', 'holiday'); }
    if (code === 10) { add(6, 'Shavuot', 'holiday'); add(7, 'Shavuot II', 'holiday'); }
    if (code === 11) { add(17, "Tzom Tammuz", 'holiday'); }
    if (code === 12) { add(9, "Tisha B'Av", 'holiday'); add(15, "Tu B'Av", 'holiday'); }
    if (code === 13) { add(29, 'Erev Rosh Hash.', 'holiday'); }
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
    if (month === 1) { add(1, 'Nowruz', 'holiday'); add(2, 'Nowruz II', 'holiday'); add(3, 'Nowruz III', 'holiday'); add(4, 'Nowruz IV', 'holiday'); add(12, 'Islamic Republic', 'holiday'); add(13, 'Sizdah Bedar', 'holiday'); }
    if (month === 3) { add(14, 'Khordad Uprising', 'holiday'); }
    if (month === 4) { add(13, 'Tirgan', 'holiday'); }
    if (month === 7) { add(10, 'Mehregan', 'holiday'); }
    if (month === 8) { add(10, 'Aban Festival', 'holiday'); }
    if (month === 9) { add(1, 'Azar Festival', 'holiday'); add(30, 'Yalda Night', 'holiday'); }
    if (month === 10) { add(5, 'Sadeh', 'holiday'); }
    if (month === 11) { add(22, 'Revolution Day', 'holiday'); add(29, 'Chaharshanbe Suri', 'holiday'); }
    if (month === 12) { add(29, 'Oil Nationalization', 'holiday'); }
  }

  else if (sys === 'chinese') {
    // `month` arrives as a display position into the civil year; festivals are
    // keyed by the real month NUMBER and never fall in a leap month.
    var _cm = _cnYearMonths(year - 2697)[month - 1];
    if (!_cm || _cm.leap) return;
    month = _cm.num;
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
    if (month === 1) { add(1, t('hol_new_year_day'), 'holiday'); add(5, 'Paramony', 'holiday'); add(6, 'Theophany', 'holiday'); add(7, 'Christmas (Julian)', 'holiday'); add(19, 'Epiphany (Julian)', 'holiday'); }
    if (month === 2) { add(2, 'Presentation of Jesus', 'holiday'); add(15, 'Meatfare Sunday', 'holiday'); }
    if (month === 3) { add(25, 'Annunciation', 'holiday'); }
    if (month === 8) { add(6, 'Transfiguration', 'holiday'); add(15, 'Dormition of the Theotokos', 'holiday'); }
    if (month === 9) { add(8, 'Nativity of Mary', 'holiday'); add(14, 'Exaltation of the Cross', 'holiday'); }
    if (month === 11) { add(21, 'Presentation of Mary', 'holiday'); }
    if (month === 12) { add(25, t('hol_christmas'), 'holiday'); add(6, "St. Nicholas Day", 'holiday'); }
  }
}

// Almanac calendar state
var _almSystem = 'gregorian';
var _almYear = 0, _almMonth = 0;
var _almSelectedJDN = 0, _almTodayJDN = 0;


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
  var yearStr = _almYear + _calYearSuffix(_almSystem);

  var html = '';

  // Navigation. The year is directly clickable/typable \u2014 jump to any year,
  // including 0, five-figure years, or a negative year for BCE.
  html += '<div class="alm-nav">';
  html += '<button class="alm-arrow" onclick="_almPrev()">\u25C0</button>';
  html += '<div class="alm-title">' +
    '<span class="alm-month" tabindex="0" role="button" aria-haspopup="menu" onclick="_almMonthPick(event)" onkeydown="_almMonthTitleKey(event)" title="' + _almEsc(_tLookup('alm_month_pick', 'Choose month')) + '">' + monthName + '</span> ' +
    '<span class="alm-year" tabindex="0" role="button" onclick="_almYearEdit(event)" onkeydown="_almYearTitleKey(event)" title="' + _almEsc(t('alm_tm_year_hint')) + '">' +
    _almYear + '</span>' + _calYearSuffix(_almSystem) + '</div>';
  html += '<button class="alm-arrow" onclick="_almNext()">\u25B6</button>';
  var todayCal = _jdnToCalendar(_almSystem, todayJDN);
  var isCurrentMonth = (_almYear === todayCal.year && _almMonth === todayCal.month);
  var isToSelected = (_almSelectedJDN === _almTodayJDN);
  html += '<button class="alm-today-btn" onclick="_almToday()"' + (isCurrentMonth && isToSelected ? ' style="visibility:hidden"' : '') + '>' + t('alm_today') + '</button>';
  html += '</div>';

  // Grid
  html += '<div class="alm-grid">';
  var _dlLocale = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var dayLabels = [];
  for (var di = 0; di < 7; di++) {
    var _d = new Date(2023, 0, di + 1); // Jan 1, 2023 = Sunday
    dayLabels.push(_d.toLocaleDateString(_dlLocale, { weekday: 'short' }));
  }
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
    // Moon phase for this calendar day (noon UTC), tucked top-right.
    var _pp = _principalPhaseOnDay(cellJDN);
    if (_pp) {
      html += '<span class="cal-moon-wrap" title="' + _almEsc(_localMoonName(_pp.name)) + '">' +
        _moonGlyphSVG(_pp.p, 16) + '</span>';
    }
    var shown = Math.min(dayEvents.length, 2);
    for (var ei = 0; ei < shown; ei++) {
      var ev = dayEvents[ei];
      var escapedLabel = _th(ev.label).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      // Worldwide entries carry a 2-letter ISO code as src; expand it to the full
      // country name for the tooltip ("France holiday", not "FR holiday").
      var srcName = (ev.src && ev.src.length === 2) ? (_almRegionName(ev.src) || ev.src) : ev.src;
      var srcTitle = ev.src ? ' title="' + _tLookup('alm_region_holiday', '{c} holiday').replace('{c}', srcName).replace(/"/g, '&quot;') + '"' : '';
      // Country-specific holidays (those with a region src) get their own
      // colour so they read apart from the worldwide observances (#33).
      var evCls = 'alm-ev alm-ev-' + ev.type + (ev.src ? ' alm-ev-country' : '');
      html += '<div class="' + evCls + '"' + srcTitle + '>' +
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

  // Holiday scope pill — centered directly under the calendar grid it filters.
  // A two-segment pill (Regional/Worldwide) sets the scope; the location
  // affordance lives on the sun-map, so no caption here. Gregorian only — the
  // national packs are keyed to Gregorian month/day, not other systems.
  if (_almSystem === 'gregorian') {
    var scope = _almHolidayScope();
    html += '<div class="alm-hol-row">' +
      '<div class="alm-scope-seg" role="tablist" aria-label="' +
        _tLookup('alm_scope_toggle_hint', 'Switch between your region and every country').replace(/"/g, '&quot;') + '">' +
        '<button type="button" class="alm-scope-btn' + (scope === 'region' ? ' active' : '') + '" role="tab" aria-selected="' + (scope === 'region') + '" onclick="_almSetHolidayScope(\'region\')">' +
          _tLookup('alm_scope_regional', 'Regional') + '</button>' +
        '<button type="button" class="alm-scope-btn' + (scope === 'worldwide' ? ' active' : '') + '" role="tab" aria-selected="' + (scope === 'worldwide') + '" onclick="_almSetHolidayScope(\'worldwide\')">' +
          _tLookup('alm_scope_worldwide', 'Worldwide') + '</button>' +
      '</div>' +
      '</div>';
  }

  // Selected day detail — full event list for the selected day
  var selCal = _jdnToCalendar(_almSystem, _almSelectedJDN);
  if (selCal.year === _almYear && selCal.month === _almMonth) {
    var selEvents = events[selCal.day] || [];
    if (selEvents.length > 0) {
      html += '<div class="alm-day-detail">';
      for (var ei = 0; ei < selEvents.length; ei++) {
        var ev = selEvents[ei];
        var rawLabel = _th(ev.label);
        var escName = rawLabel.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        // Holidays deep-link into the library (fail-soft); other event types stay plain text.
        var detailLabel = (ev.type === 'holiday' && window.AlmanacLinks)
          ? window.AlmanacLinks.wrapHoliday(escName, rawLabel, ev.region) : escName;
        if (ev.src) detailLabel += ' <span style="color:var(--text3)">\u00b7 ' + ev.src.replace(/</g,'&lt;') + '</span>';
        html += '<div class="alm-ev alm-ev-' + ev.type + (ev.src ? ' alm-ev-country' : '') + '" style="font-size:12px;padding:2px 0">' +
          (ev.icon ? ev.icon + ' ' : '') + detailLabel + '</div>';
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
  // Carry the current time-of-day onto the picked date, so the moon and the
  // instantaneous numbers describe "this time, that day".
  var g = _jdnToGregorian(jdn);
  var nowT = new Date();
  // _almMakeInstant (setFullYear) so a day picked in an arbitrary/ancient year
  // — reachable via the typable year — lands on the real year, not the 1900s.
  var picked = _almMakeInstant(g.year, g.month, g.day, nowT.getHours(), nowT.getMinutes());
  _almFocus = _almIsToday(picked) ? null : _almClampInstant(picked);
  _almTmShow();                          // picking a day reveals the instrument
  _almRepaintFocus();
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
    // Beyond a lunisolar calendar's meaningful span its conversion returns a
    // non-finite or absurd value; show a quiet "beyond range" note rather than
    // NaN or garbage. The Gregorian/Julian arithmetic stays valid throughout.
    var dateStr;
    try {
      var cal = _jdnToCalendar(sys, jdn);
      if (!isFinite(cal.year) || !isFinite(cal.month) || !isFinite(cal.day)) throw 0;
      var monthName = _calMonthName(sys, cal.year, cal.month);
      var yearStr = cal.year + _calYearSuffix(sys);
      dateStr = monthName + ' ' + cal.day + ', ' + yearStr;
      if (sys === 'chinese') {
        // Key the animal to the CHINESE year being displayed (era 2697), which is
        // the Gregorian year of that year's New Year \u2014 so the animal doesn't flip
        // on Jan 1 in the weeks before Chinese New Year.
        var chinese = _chineseZodiac(cal.year - 2697);
        dateStr = monthName + ' ' + cal.day + ' \u00b7 ' + _alLink('zodiac:' + chinese.animalKey, chinese.animal) + ' \u00b7 ' + yearStr;
      }
    } catch (e) {
      dateStr = '<span class="alm-beyond">' + _tLookup('alm_tm_beyond_range', "Beyond this calendar's range") + '</span>';
    }
    var isActive = sys === _almSystem ? ' alm-crossref-active' : '';
    html += '<div class="alm-crossref-row' + isActive + '"' +
      ' onclick="_almSwitchSystem(\'' + sys + '\')">' +
      '<span class="alm-crossref-label">' + _alLink('cal:' + sys, _calLabel(sys)) + '</span>' +
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

// Turn the calendar's year label into a number field you can type any year
// into. Enter/blur commits, Escape restores. The field is unbounded in the
// markup; _almJumpYear does the clamping.
function _almYearEdit(e) {
  if (e) e.stopPropagation();
  var span = document.querySelector('#almanac-calendar .alm-year');
  if (!span) return;
  var input = document.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.className = 'alm-year-input';
  input.value = _almYear;
  input.setAttribute('aria-label', t('alm_tm_year'));
  input.setAttribute('inputmode', 'numeric');
  var done = false;
  function commit() { if (done) return; done = true; _almJumpYear(input.value); }
  function cancel() { if (done) return; done = true; _drawAlmanacGrid(); }
  span.replaceWith(input);
  input.focus();
  if (input.select) input.select();
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

function _almYearTitleKey(e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _almYearEdit(e); }
}

// The month name in the calendar title opens a compact month grid — the month
// counterpart of the typable year beside it. Built from _calMonthName each
// time, so a 13-month lunisolar year simply shows 13 cells and localized
// names come for free. Picking a month redraws the grid (which also removes
// the pop, since it lives inside the calendar container).
function _almMonthPick(e) {
  if (e) e.stopPropagation();
  var old = document.getElementById('alm-month-pop');
  if (old) { old.remove(); return; }
  var nav = document.querySelector('#almanac-calendar .alm-nav');
  if (!nav) return;
  var count = _calMonthCount(_almSystem, _almYear);
  var pop = document.createElement('div');
  pop.id = 'alm-month-pop';
  pop.className = 'alm-month-pop';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', _tLookup('alm_month_pick', 'Choose month'));
  for (var m = 1; m <= count; m++) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'alm-month-cell' + (m === _almMonth ? ' alm-month-cur' : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = _calMonthName(_almSystem, _almYear, m);
    b.onclick = (function (mm) { return function () { _almMonth = mm; _drawAlmanacGrid(); }; })(m);
    pop.appendChild(b);
  }
  nav.appendChild(pop);
  var cur = pop.querySelector('.alm-month-cur');
  if (cur) cur.focus();
  // Dismiss on an outside tap or Escape. The handlers detach themselves the
  // moment the pop is gone, however it went (pick, redraw, outside tap). A tap
  // on the month name itself is left to the name's own click handler, which
  // toggles.
  var detach = function () {
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  var dismiss = function (ev) {
    var p = document.getElementById('alm-month-pop');
    if (!p) { detach(); return; }
    if (ev.type === 'keydown' && ev.key !== 'Escape') return;
    if (ev.type === 'pointerdown' && ev.target && ev.target.closest &&
        (p.contains(ev.target) || ev.target.closest('.alm-month'))) return;
    p.remove();
    detach();
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
}

function _almMonthTitleKey(e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _almMonthPick(e); }
}

// Jump the browsed calendar to an arbitrary year in the current system. Clamp
// to the span where JS Date stays valid so no downstream conversion goes NaN.
function _almJumpYear(v) {
  var y = parseInt(v, 10);
  if (isNaN(y)) { _drawAlmanacGrid(); return; }
  _almYear = Math.max(_ALM_YEAR_MIN, Math.min(_ALM_YEAR_MAX, y));
  var max = _calMonthCount(_almSystem, _almYear);
  if (_almMonth > max) _almMonth = max;
  if (_almMonth < 1) _almMonth = 1;
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

  return { year: jy, month: jm, day: jd };
}

// Chinese calendar — 60-year cycle (Heavenly Stems + Earthly Branches)
function _chineseZodiac(year) {
  var stems = ['\u7532','\u4e59','\u4e19','\u4e01','\u620a','\u5df1','\u5e9a','\u8f9b','\u58ec','\u7678'];
  var branches = ['\u5b50','\u4e11','\u5bc5','\u536f','\u8fb0','\u5df3','\u5348','\u672a','\u7533','\u9149','\u620c','\u4ea5'];
  var animals = [t('alm_zodiac_rat'),t('alm_zodiac_ox'),t('alm_zodiac_tiger'),t('alm_zodiac_rabbit'),t('alm_zodiac_dragon'),t('alm_zodiac_snake'),t('alm_zodiac_horse'),t('alm_zodiac_goat'),t('alm_zodiac_monkey'),t('alm_zodiac_rooster'),t('alm_zodiac_dog'),t('alm_zodiac_pig')];
  var elements = [t('alm_element_wood'),t('alm_element_wood'),t('alm_element_fire'),t('alm_element_fire'),t('alm_element_earth'),t('alm_element_earth'),t('alm_element_metal'),t('alm_element_metal'),t('alm_element_water'),t('alm_element_water')];
  var animalKeys = ['rat','ox','tiger','rabbit','dragon','snake','horse','goat','monkey','rooster','dog','pig'];
  var offset = year - 4; // 4 CE was a Jia-Zi year
  var stemIdx = ((offset % 10) + 10) % 10;
  var branchIdx = ((offset % 12) + 12) % 12;
  var cycleYear = ((offset % 60) + 60) % 60 + 1;
  // Chinese year number (approximate — Chinese New Year is Jan/Feb)
  var chineseYear = year + 2697; // Huang Di epoch (approximate)
  return {
    stem: stems[stemIdx], branch: branches[branchIdx],
    animal: animals[branchIdx], animalKey: animalKeys[branchIdx], element: elements[stemIdx],
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

// Chronological by origin: Chinese (~2637 BCE), Hebrew (~359 CE codified),
// Buddhist (543 BCE epoch), Julian (45 BCE), Islamic (622 CE), Gregorian (1582 CE), Persian (1925 CE)
var _CAL_SYSTEMS = ['persian', 'gregorian', 'islamic', 'julian', 'buddhist', 'hebrew', 'chinese'];
var _GREGORIAN_DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function _calLabel(sys) { return t('cal_' + sys); }
function _calYearSuffix(sys) {
  if (sys === 'islamic') return ' ' + t('alm_year_ah');
  if (sys === 'persian') return ' ' + t('alm_year_sh');
  if (sys === 'buddhist') return ' ' + t('alm_year_be');
  return '';
}

// Gregorian month name — locale-aware
function _gregorianMonthName(month1based) {
  var loc = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  return new Date(2023, month1based - 1, 1).toLocaleDateString(loc, { month: 'long' });
}
var _HIJRI_MONTHS = ['Muharram','Safar','Rabi\u2019 al-Awwal','Rabi\u2019 al-Thani',
  'Jumada al-Ula','Jumada al-Thani','Rajab','Sha\u2019ban',
  'Ramadan','Shawwal','Dhu al-Qi\u2019dah','Dhu al-Hijjah'];
var _PERSIAN_MONTHS = ['Farvardin','Ordibehesht','Khordad','Tir','Mordad','Shahrivar',
  'Mehr','Aban','Azar','Dey','Bahman','Esfand'];
// _JULIAN_MONTHS removed — Julian calendar uses the same month names as Gregorian

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
    return { year: p.year, month: p.month, day: p.day };
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

// ── Chinese lunisolar calendar — real astronomy (Meeus) ──
// Month boundaries are true new moons in China Standard Time (UTC+8); leap
// months are placed by the solar-term (zhongqi) rule anchored to the winter
// solstice. Accurate against the HK Observatory civil calendar for ~1900–2100.
// Refs: Meeus, Astronomical Algorithms ch.25/27/49; Aslaksen, The Mathematics
// of the Chinese Calendar.
var _CHINESE_MONTHS = ['Zhēngyue','Eryue','Sānyue','Sìyue','Wǔyue','Liùyue',
  'Qīyue','Bāyue','Jiǔyue','Shíyue','Shíyīyue','Làyue'];
var _CN_SYN = 29.530588861;
var _CN_TZ = 8 / 24;   // China Standard Time offset (days)

// ΔT (TT−UT) in days, Espenak–Meeus piecewise — good for 1900–2150.
function _cnDeltaTdays(jde) {
  var y = _jdnToGregorian(Math.floor(jde + 0.5)).year;
  var t = y - 2000, s;
  if (y >= 2005 && y <= 2050) s = 62.92 + 0.32217 * t + 0.005589 * t * t;
  else if (y >= 1986 && y < 2005) s = 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * Math.pow(t, 3) + 0.000651814 * Math.pow(t, 4) + 0.00002373599 * Math.pow(t, 5);
  else if (y > 2050) { var u = (y - 1820) / 100; s = -20 + 32 * u * u - 0.5628 * (2150 - y); }
  else { var w = y - 1900; s = -2.79 + 1.494119 * w - 0.0598939 * w * w + 0.0061966 * Math.pow(w, 3) - 0.000197 * Math.pow(w, 4); }
  return s / 86400;
}

// New-moon instant (TT Julian Date) for integer lunation index k. Meeus ch.49,
// new-moon column of Table 49.a plus the largest planetary term A1.
function _cnNewMoonJDE(k) {
  var T = k / 1236.85;
  var JDE = 2451550.09766 + _CN_SYN * k + 0.00015437 * T * T - 0.000000150 * Math.pow(T, 3) + 0.00000000073 * Math.pow(T, 4);
  var M = (2.5534 + 29.10535670 * k - 0.0000014 * T * T - 0.00000011 * Math.pow(T, 3)) * DEG_TO_RAD;
  var Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * Math.pow(T, 3) - 0.000000058 * Math.pow(T, 4)) * DEG_TO_RAD;
  var F = (160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * Math.pow(T, 3) + 0.000000011 * Math.pow(T, 4)) * DEG_TO_RAD;
  var Om = (124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * Math.pow(T, 3)) * DEG_TO_RAD;
  var E = 1 - 0.002516 * T - 0.0000074 * T * T;
  JDE += -0.40720 * Math.sin(Mp) + 0.17241 * E * Math.sin(M) + 0.01608 * Math.sin(2 * Mp)
    + 0.01039 * Math.sin(2 * F) + 0.00739 * E * Math.sin(Mp - M) - 0.00514 * E * Math.sin(Mp + M)
    + 0.00208 * E * E * Math.sin(2 * M) - 0.00111 * Math.sin(Mp - 2 * F) - 0.00057 * Math.sin(Mp + 2 * F)
    + 0.00056 * E * Math.sin(2 * Mp + M) - 0.00042 * Math.sin(3 * Mp) + 0.00042 * E * Math.sin(M + 2 * F)
    + 0.00038 * E * Math.sin(M - 2 * F) - 0.00024 * E * Math.sin(2 * Mp - M) - 0.00017 * Math.sin(Om)
    - 0.00007 * Math.sin(Mp + 2 * M) + 0.00004 * Math.sin(2 * Mp - 2 * F) + 0.00004 * Math.sin(3 * M)
    + 0.00003 * Math.sin(Mp + M - 2 * F) + 0.00003 * Math.sin(2 * Mp + 2 * F) - 0.00003 * Math.sin(Mp + M + 2 * F)
    + 0.00003 * Math.sin(Mp - M + 2 * F) - 0.00002 * Math.sin(Mp - M - 2 * F) - 0.00002 * Math.sin(3 * Mp + M) + 0.00002 * Math.sin(4 * Mp);
  var A1 = (299.77 + 0.107408 * k - 0.009173 * T * T) * DEG_TO_RAD;
  JDE += 0.000325 * Math.sin(A1);
  return JDE;
}

// Sun's apparent ecliptic longitude (deg) for a TT Julian date. Meeus ch.25.
function _cnSolarLongitude(jde) {
  var T = (jde - 2451545.0) / 36525;
  var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  var M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG_TO_RAD;
  var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  var Om = (125.04 - 1934.136 * T) * DEG_TO_RAD;
  var lam = L0 + C - 0.00569 - 0.00478 * Math.sin(Om);
  return ((lam % 360) + 360) % 360;
}

// TT Julian date where the Sun reaches ecliptic longitude targetDeg (near approxJD).
function _cnSolarTermJDE(approxJD, targetDeg) {
  var jd = approxJD;
  for (var i = 0; i < 6; i++) {
    var d = (((targetDeg - _cnSolarLongitude(jd) + 180) % 360) + 360) % 360 - 180;
    jd += d / 0.98565;
  }
  return jd;
}

// Integer China-civil JDN of a TT instant (subtract ΔT → UT, add +8h, floor).
function _cnChinaDay(jde) { return Math.floor((jde - _cnDeltaTdays(jde)) + _CN_TZ + 0.5); }
function _cnNewMoonDay(k) { return _cnChinaDay(_cnNewMoonJDE(k)); }

// Does lunar month k contain a zhongqi (a major solar term, longitude a
// multiple of 30°), tested by the term's CIVIL DAY falling inside the month?
// The rigorous test — the cheaper longitude-at-new-moon index test misfires
// when a term and a new moon land on the same China-civil day (e.g. 2020's
// summer solstice), which is exactly when leap-month placement turns on it.
function _cnMonthHasZhongqi(k) {
  var start = _cnNewMoonDay(k), end = _cnNewMoonDay(k + 1);
  var nm = _cnNewMoonJDE(k);
  var lam0 = _cnSolarLongitude(nm);
  var nextZq = Math.ceil((lam0 - 1e-9) / 30) * 30;      // next multiple of 30° (deg)
  var zqJDE = _cnSolarTermJDE(nm + 1, ((nextZq % 360) + 360) % 360);
  var zqDay = _cnChinaDay(zqJDE);
  return zqDay >= start && zqDay < end;
}

// Lunation index k of the month-11 new moon whose December solstice it contains.
function _cnNm11(gy) {
  var ws = _cnSolarTermJDE(_gregorianToJDN(gy, 12, 21) + 0.5, 270);
  var wsD = _cnChinaDay(ws);
  var k = Math.floor((ws - 2451550.09766) / _CN_SYN);
  while (_cnNewMoonDay(k) > wsD) k--;
  while (_cnNewMoonDay(k + 1) <= wsD) k++;
  return k;
}

// Build the suì starting at month-11 lunation k11: [{k,num,leap,start,end}].
var _cnSuiCache = {};
function _cnBuildSui(k11) {
  if (_cnSuiCache[k11]) return _cnSuiCache[k11];
  var k11n = _cnNm11(_jdnToGregorian(_cnNewMoonDay(k11)).year + 1);
  var n = k11n - k11, leap = (n === 13), leapK = -1, i;
  if (leap) {
    for (i = 0; i < n; i++) {
      if (!_cnMonthHasZhongqi(k11 + i)) { leapK = k11 + i; break; }
    }
  }
  // A leap month takes the number of the month it FOLLOWS (闰二月 = leap-2), so
  // carry prevNum for it rather than the already-advanced running number.
  var months = [], num = 11, prevNum = 11;
  for (i = 0; i < n; i++) {
    var k = k11 + i, isLeap = (k === leapK);
    var thisNum = isLeap ? prevNum : num;
    months.push({ k: k, num: thisNum, leap: isLeap, start: _cnNewMoonDay(k), end: _cnNewMoonDay(k + 1) });
    if (!isLeap) { prevNum = num; num = (num % 12) + 1; }
  }
  _cnSuiCache[k11] = months;
  return months;
}

// The ordered civil-year months (position 1 = CNY … 12) for the Chinese year
// whose New Year falls in Gregorian year gyCNY.
function _cnYearMonths(gyCNY) {
  var out = [], j;
  var a = _cnBuildSui(_cnNm11(gyCNY - 1));
  var i = 0; while (i < a.length && !(a[i].num === 1 && !a[i].leap)) i++;
  for (; i < a.length; i++) out.push(a[i]);       // months 1..10 (+ any leap among them)
  var b = _cnBuildSui(_cnNm11(gyCNY));
  for (j = 0; j < b.length; j++) { if (b[j].num === 1 && !b[j].leap) break; out.push(b[j]); } // 11,12(+leap)
  return out;
}

function _cnChineseNewYearJDN(gy) { return _cnYearMonths(gy)[0].start; }

// JDN → Chinese { year (Huangdi era), month (1-based position in the civil
// year), day, monthNum, leap }.
function _jdnToChineseLunar(jdn) {
  var g = _jdnToGregorian(jdn);
  var gyCNY = g.year;
  if (jdn < _cnChineseNewYearJDN(g.year)) gyCNY = g.year - 1;
  var months = _cnYearMonths(gyCNY);
  for (var p = 0; p < months.length; p++) {
    if (jdn >= months[p].start && jdn < months[p].end) {
      return { year: gyCNY + 2697, month: p + 1, day: jdn - months[p].start + 1, monthNum: months[p].num, leap: months[p].leap };
    }
  }
  var last = months[months.length - 1];
  return { year: gyCNY + 2697, month: months.length, day: jdn - last.start + 1, monthNum: last.num, leap: last.leap };
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
    var cm = _cnYearMonths(year - 2697);
    var mi = Math.max(1, Math.min(cm.length, month)) - 1;
    return cm[mi].start;
  }
  return 0;
}

// Get number of days in a given month
function _calDaysInMonth(sys, year, month) {
  if (sys === 'gregorian') {
    if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
    return _GREGORIAN_DAYS_PER_MONTH[month - 1];
  }
  if (sys === 'hebrew') {
    var months = _hebrewMonthList(year);
    if (month >= 1 && month <= months.length) return months[month - 1].days;
    return 30;
  }
  if (sys === 'islamic') return _hijriDaysInMonth(year, month);
  if (sys === 'persian') return _persianDaysInMonth(year, month);
  if (sys === 'julian') {
    if (month === 2 && year % 4 === 0) return 29;
    return _GREGORIAN_DAYS_PER_MONTH[month - 1];
  }
  if (sys === 'buddhist') {
    var gYear = year - 543;
    if (month === 2 && ((gYear % 4 === 0 && gYear % 100 !== 0) || gYear % 400 === 0)) return 29;
    return _GREGORIAN_DAYS_PER_MONTH[month - 1];
  }
  if (sys === 'chinese') {
    var cm = _cnYearMonths(year - 2697);
    var mi = Math.max(1, Math.min(cm.length, month)) - 1;
    return cm[mi].end - cm[mi].start;
  }
  return 30;
}

// Get month name
function _calMonthName(sys, year, month) {
  if (sys === 'gregorian') return _gregorianMonthName(month);
  if (sys === 'hebrew') {
    var months = _hebrewMonthList(year);
    if (month >= 1 && month <= months.length) return months[month - 1].name;
    return '';
  }
  if (sys === 'islamic') return _HIJRI_MONTHS[month - 1] || '';
  if (sys === 'persian') return _PERSIAN_MONTHS[month - 1] || '';
  if (sys === 'julian') return _gregorianMonthName(month);
  if (sys === 'buddhist') return _gregorianMonthName(month);
  if (sys === 'chinese') {
    var cm = _cnYearMonths(year - 2697);
    var mi = Math.max(1, Math.min(cm.length, month)) - 1;
    var mo = cm[mi];
    var nm = _CHINESE_MONTHS[mo.num - 1] || t('alm_month_n', { n: mo.num });
    return (mo.leap ? '闰' : '') + nm;   // 闰 = leap-month marker
  }
  return '';
}

// Get number of months in a year
function _calMonthCount(sys, year) {
  if (sys === 'hebrew') return _hebrewMonthList(year).length;
  if (sys === 'chinese') return _cnYearMonths(year - 2697).length; // 12 or 13 (leap years)
  return 12;
}

// ── Interactive Calendar Browser ──


// ── Deep Time — facts that transcend centuries ──

function _renderDeepTime(now) {
  var el = document.getElementById('almanac-deeptime');
  if (!el) return;
  var JD = _dateToJD(now.getTime());
  var T = _jdToJulianCentury(JD);

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
  // Human-scale season direction
  var tiltDir = obliquityAS < 84381.448 ? t('alm_decreasing') : t('alm_increasing');
  var seasonImpact = obliquityAS < 84381.448 ? t('alm_seasons_milder') : t('alm_seasons_extreme');

  var html = '<div class="almanac-info-grid">';

  // Axial tilt
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + obliquityDeg.toFixed(2) + '\u00b0</div>' +
    '<div class="almanac-info-lbl">' + _lterm('axial_tilt', t('alm_dt_tilt')) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_tilt_desc', { trend: tiltDir, impact: seasonImpact, pct: tiltInCycle }) + '</div></div>';

  // North Star
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + polarisDist + '\u00b0 ' + t('alm_from_true_north') + '</div>' +
    '<div class="almanac-info-lbl">' + _alLink('star:polaris', t('alm_dt_polaris')) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_polaris_desc', { years: (14000 - now.getFullYear()).toLocaleString() }) + '</div></div>';

  // Day getting longer
  var totalExcessMs = (daySeconds - 86400) * 1000;
  var dayStr = totalExcessMs > 1 ? '+' + totalExcessMs.toFixed(1) + 'ms ' + t('alm_over_24h') :
               totalExcessMs > 0.01 ? '+' + (totalExcessMs * 1000).toFixed(0) + '\u00b5s ' + t('alm_over_24h') :
               '~24h';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + dayStr + '</div>' +
    '<div class="almanac-info-lbl">' + _lterm('tidal_acceleration', t('alm_dt_daylen')) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_daylen_desc', { ms: excessMs.toFixed(1) }) + '</div></div>';

  // Orbital eccentricity
  var eccTrendStr = parseFloat(earthEcc) < eccPrev ? t('alm_decreasing') : t('alm_increasing');
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + earthEcc + '</div>' +
    '<div class="almanac-info-lbl">' + _lterm('orbital_eccentricity', t('alm_dt_orbit')) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_orbit_desc', { trend: eccTrendStr }) + '</div></div>';

  // Julian Date
  html += '<div class="almanac-info-item"><div class="almanac-info-val">JD ' + julianDate + '</div>' +
    '<div class="almanac-info-lbl">' + _lterm('julian_day', t('alm_dt_julian')) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_julian_desc') + '</div></div>';

  // Galactic Year
  var galacticPeriod = 225;
  var sunAge = 4600 + (now.getFullYear() - 2000) / 1e6;
  var orbitsCompleted = Math.floor(sunAge / galacticPeriod);
  var currentOrbitPct = ((sunAge % galacticPeriod) / galacticPeriod * 100).toFixed(1);

  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + t('alm_galactic_orbit', { pct: currentOrbitPct, n: orbitsCompleted + 1 }) + '</div>' +
    '<div class="almanac-info-lbl">' + _lterm('galactic_year', t('alm_dt_galactic')) + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_galactic_desc', { age: (sunAge / 1000).toFixed(1), orbits: orbitsCompleted }) + '</div></div>';

  html += '</div>';
  el.innerHTML = html;
}

// ── Messages Across Time — enduring inscriptions in every language ──
// Texts loaded async from /static/rosetta/*.json (manifest + per-inscription files)
// Golden Record gallery images from /static/golden-record/ (NASA public domain)
// Future: this section could become its own ZIM — see project_zim_format.md breadcrumb

var _rosettaManifest = null;
var _rosettaCache = {};
var _rosettaLangs = [(typeof _currentLang !== 'undefined') ? _currentLang : 'en'];
var _rosettaTextIdx = 9; // Georgia Guidestones — thematically fitting default for Zimi

var _ALL_LANGS = [
  {code:'en',name:'English'},{code:'fr',name:'Français'},{code:'de',name:'Deutsch'},
  {code:'es',name:'Español'},{code:'pt',name:'Português'},{code:'ru',name:'Русский'},
  {code:'zh',name:'中文'},{code:'ar',name:'العربية'},{code:'hi',name:'हिन्दी'},{code:'he',name:'עברית'}
];
var _RTL_CODES = ['ar','he'];

// Golden Record image gallery — ordered as encoded on the record
var _GR_IMAGES = [
  'cover.jpg', 'calibration-circle.gif', 'math-definitions.gif', 'physical-units.gif',
  'solar-location-map.gif', 'solar-system-inner.gif', 'solar-system-outer.gif', 'solar-spectrum.gif',
  'mercury.gif', 'mars.gif', 'jupiter.gif', 'earth.gif', 'egypt-nile.gif',
  'chemical-definitions.gif', 'dna-structure.gif', 'dna-magnified.gif', 'structure-of-earth.gif',
  'continental-drift.gif', 'heron-island.jpg', 'vertebrate-evolution.gif', 'bushmen-sketch.gif',
  'man-guatemala.gif', 'human-anatomy.gif', 'conception.gif', 'fetus.gif', 'family-ages.gif',
  'nursing-mother.gif', 'eating-drinking.gif', 'children-globe.gif', 'schoolroom.gif',
  'fishing-boat.gif', 'house-africa.gif', 'house-construction.gif', 'house-new-mexico.gif',
  'supermarket.gif', 'un-building-day.gif', 'un-building-night.gif', 'olympians.gif',
  'microscope.gif', 'xray-hand.gif', 'street-scene.gif', 'rush-hour.gif', 'highway.gif',
  'airplane.gif', 'arecibo.gif', 'newton-book.gif', 'violin-cavatina.gif',
  'titan-launch.gif', 'astronaut.gif'
];
function _grCap(idx) { return t('gr_cap_' + idx); }

var _grLightboxIdx = -1;
var _grTouchStartX = 0;

async function _loadRosettaManifest() {
  if (_rosettaManifest) return _rosettaManifest;
  try {
    var resp = await fetch('/static/rosetta/manifest.json');
    _rosettaManifest = await resp.json();
  } catch(e) { _rosettaManifest = []; }
  return _rosettaManifest;
}

async function _loadInscription(id) {
  if (_rosettaCache[id]) return _rosettaCache[id];
  try {
    var resp = await fetch('/static/rosetta/' + id + '.json');
    _rosettaCache[id] = await resp.json();
  } catch(e) { _rosettaCache[id] = {texts:{}}; }
  return _rosettaCache[id];
}

async function _renderRosettaStone(now) {
  var el = document.getElementById('almanac-rosetta');
  if (!el) return;

  var manifest = await _loadRosettaManifest();
  if (!manifest.length) { el.innerHTML = ''; return; }

  var entry = manifest[_rosettaTextIdx] || manifest[0];
  var data = await _loadInscription(entry.id);
  var availLangs = Object.keys(data.texts || {});

  // Localized field helper — reads i18n object from manifest, falls back to English
  var _cl = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  function _rf(e, f) { return (e.i18n && e.i18n[_cl] && e.i18n[_cl][f]) || e[f]; }

  // Inscription pills (top row). The active pill doubles as the encyclopedia
  // link: a second tap on it opens the article (same closed-set Q-ID open the
  // old in-body title link used). The underline + tooltip affordance appears
  // only when the curated Q-ID actually resolved to an installed article.
  var html = '<div class="rosetta-pills">';
  for (var si = 0; si < manifest.length; si++) {
    var isSel = si === _rosettaTextIdx;
    var linkable = isSel && window.AlmanacLinks && AlmanacLinks.linkFor('rosetta:' + manifest[si].id);
    var cls = 'pill' + (isSel ? ' active' : '') + (linkable ? ' rosetta-pill-link' : '');
    var hint = linkable
      ? ' title="' + _almEsc(t('alm_open_article')) + '" aria-label="' + _almEsc(_rf(manifest[si], 'title') + '. ' + t('alm_open_article')) + '"'
      : '';
    html += '<button class="' + cls + '" aria-pressed="' + (isSel ? 'true' : 'false') + '"' + hint + ' onclick="_selectRosettaText(' + si + ')">' + _rf(manifest[si], 'title') + '</button>';
  }
  html += '</div>';

  // Metadata
  html += '<div class="rosetta-meta">' + _rf(entry, 'date') + ' \u00b7 ' + _rf(entry, 'place') + ' \u00b7 ' + _rf(entry, 'medium') + '</div>';
  html += '<div class="rosetta-context">' + _rf(entry, 'context') + '</div>';

  // Language pills + text blocks live in stable containers so a language toggle
  // can rewrite only them (via _updateRosettaLangs) without tearing down the
  // artifact's image gallery below — its ~50 <img> nodes would otherwise be
  // destroyed and re-decoded on every pill click.
  html += '<div class="rosetta-pills" id="alm-rosetta-langpills">' + _rosettaLangPillsHtml(availLangs) + '</div>';
  html += '<div id="alm-rosetta-texts">' + _rosettaTextsHtml(data) + '</div>';

  // Golden Record image gallery (only when that inscription is selected)
  if (entry.id === 'golden-record') {
    html += _renderGoldenRecordGallery();
  }

  el.innerHTML = html;
}

// Language pill row (bottom) — active state reflects the chosen language(s).
// Split out so a language toggle rebuilds only the pills, not the gallery.
function _rosettaLangPillsHtml(availLangs) {
  var html = '';
  for (var li = 0; li < _ALL_LANGS.length; li++) {
    var lc = _ALL_LANGS[li].code;
    var langLabel = t('lang_name_' + lc);
    if (langLabel === 'lang_name_' + lc) langLabel = _ALL_LANGS[li].name; // fallback to native name
    var avail = availLangs.indexOf(lc) !== -1;
    var isActive = _rosettaLangs.indexOf(lc) !== -1;
    if (avail) {
      html += '<button class="' + (isActive ? 'pill active' : 'pill') + '" onclick="_toggleRosettaLang(\'' + lc + '\')">' + langLabel + '</button>';
    } else {
      html += '<button class="pill disabled" disabled>' + langLabel + '</button>';
    }
  }
  return html;
}

// Inscription text block(s) for the chosen language(s) — one, or a two-up
// comparison. The only part that changes when languages toggle.
function _rosettaTextsHtml(data) {
  var twoUp = _rosettaLangs.length === 2;
  var html = twoUp ? '<div class="rosetta-compare">' : '';
  for (var ri = 0; ri < _rosettaLangs.length; ri++) {
    var langCode = _rosettaLangs[ri];
    var text = (data.texts || {})[langCode] || (data.texts || {})['en'] || '';
    var isRtl = _RTL_CODES.indexOf(langCode) !== -1;
    var dir = isRtl ? ' dir="rtl"' : '';
    var align = isRtl ? 'text-align:right' : '';
    var langName = langCode;
    for (var ln = 0; ln < _ALL_LANGS.length; ln++) {
      if (_ALL_LANGS[ln].code === langCode) { langName = _ALL_LANGS[ln].name; break; }
    }
    html += '<div class="alm-rosetta-block"' + dir + ' style="' + align + '">' +
      '<div class="alm-rosetta-title">' + langName + '</div>' +
      '<div class="alm-rosetta-text">' + text.replace(/\n/g, '<br>') + '</div>' +
      '</div>';
  }
  if (twoUp) html += '</div>';
  return html;
}

// Swap only the language pills + text blocks in place, leaving the artifact
// title, metadata and (expensive) image gallery untouched.
async function _updateRosettaLangs() {
  var manifest = await _loadRosettaManifest();
  if (!manifest.length) return;
  var entry = manifest[_rosettaTextIdx] || manifest[0];
  var data = await _loadInscription(entry.id);   // served from _rosettaCache
  var availLangs = Object.keys(data.texts || {});
  var pills = document.getElementById('alm-rosetta-langpills');
  if (pills) pills.innerHTML = _rosettaLangPillsHtml(availLangs);
  var texts = document.getElementById('alm-rosetta-texts');
  if (texts) texts.innerHTML = _rosettaTextsHtml(data);
}

function _renderGoldenRecordGallery() {
  var html = '<div class="gr-gallery">';
  html += '<div class="gr-gallery-title">' + t('alm_gr_title') + '</div>';
  html += '<div class="gr-gallery-sub">' + t('alm_gr_subtitle') + '</div>';
  html += '<div class="gr-grid">';
  for (var i = 0; i < _GR_IMAGES.length; i++) {
    html += '<div class="gr-thumb" onclick="_openGrLightbox(' + i + ')">' +
      '<img src="/static/golden-record/' + _GR_IMAGES[i] + '" alt="' + _grCap(i) + '" loading="lazy">' +
      '</div>';
  }
  html += '</div></div>';
  return html;
}

function _openGrLightbox(idx) {
  _grLightboxIdx = idx;
  _renderGrLightbox();
  document.addEventListener('keydown', _grKeyHandler);
}

function _closeGrLightbox() {
  _grLightboxIdx = -1;
  var lb = document.getElementById('gr-lightbox');
  if (lb) lb.remove();
  document.removeEventListener('keydown', _grKeyHandler);
}

function _grKeyHandler(e) {
  if (e.key === 'Escape') _closeGrLightbox();
  else if (e.key === 'ArrowRight') { e.preventDefault(); _grNav(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); _grNav(-1); }
}

function _grNav(dir) {
  _grLightboxIdx = (_grLightboxIdx + dir + _GR_IMAGES.length) % _GR_IMAGES.length;
  _renderGrLightbox();
}

function _renderGrLightbox() {
  var file = _GR_IMAGES[_grLightboxIdx];
  var cap = _grCap(_grLightboxIdx);
  var lb = document.getElementById('gr-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'gr-lightbox';
    lb.className = 'gr-lightbox';
    document.body.appendChild(lb);
    // Swipe support
    lb.addEventListener('touchstart', function(e) {
      _grTouchStartX = e.touches[0].clientX;
    }, {passive:true});
    lb.addEventListener('touchend', function(e) {
      var dx = e.changedTouches[0].clientX - _grTouchStartX;
      if (Math.abs(dx) > 50) _grNav(dx < 0 ? 1 : -1);
    }, {passive:true});
  }
  lb.innerHTML =
    '<div class="gr-lb-bg" onclick="_closeGrLightbox()"></div>' +
    '<button class="gr-lb-close" onclick="_closeGrLightbox()">&times;</button>' +
    '<button class="gr-lb-arrow gr-lb-prev" onclick="event.stopPropagation();_grNav(-1)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,2 4,8 10,14"/></svg></button>' +
    '<div class="gr-lb-main" onclick="event.stopPropagation()">' +
      '<img src="/static/golden-record/' + file + '" alt="' + cap + '">' +
      '<div class="gr-lb-cap">' + cap + '</div>' +
      '<div class="gr-lb-num">' + (_grLightboxIdx + 1) + ' / ' + _GR_IMAGES.length + '</div>' +
    '</div>' +
    '<button class="gr-lb-arrow gr-lb-next" onclick="event.stopPropagation();_grNav(1)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,2 12,8 6,14"/></svg></button>';
}

// Timestamp of the last selection change: a ghost/double tap landing right
// after a pill becomes active must not immediately fire the article open.
var _rosettaSelectedAt = 0;
var _ROSETTA_NAV_GUARD_MS = 350;

function _selectRosettaText(idx) {
  if (idx === _rosettaTextIdx) {
    // Second tap on the already-active pill opens the encyclopedia article,
    // through the same closed-set resolution the in-body title link used.
    // AlmanacLinks.open() is a no-op when the Q-ID did not resolve.
    if (Date.now() - _rosettaSelectedAt < _ROSETTA_NAV_GUARD_MS) return;
    var manifest = _rosettaManifest || [];
    var entry = manifest[idx];
    if (entry && window.AlmanacLinks) AlmanacLinks.open('rosetta:' + entry.id);
    return;
  }
  _rosettaTextIdx = idx;
  _rosettaSelectedAt = Date.now();
  _renderRosettaStone(new Date());
}

function _toggleRosettaLang(code) {
  var idx = _rosettaLangs.indexOf(code);
  if (idx !== -1) {
    if (_rosettaLangs.length > 1) _rosettaLangs.splice(idx, 1);
  } else {
    if (_rosettaLangs.length >= 2) _rosettaLangs.shift();
    _rosettaLangs.push(code);
  }
  // Language-only change — swap the text without rebuilding the image gallery.
  _updateRosettaLangs();
}

// Scroll to Messages Across Time and select Golden Record (called from Voyager card)
async function _scrollToGoldenRecord() {
  var manifest = _rosettaManifest || [];
  for (var i = 0; i < manifest.length; i++) {
    if (manifest[i].id === 'golden-record') { _rosettaTextIdx = i; break; }
  }
  _rosettaSelectedAt = Date.now();  // programmatic selection: same nav guard as a pill tap
  await _renderRosettaStone(new Date());
  var el = document.getElementById('almanac-rosetta');
  if (el) el.scrollIntoView({behavior:'smooth',block:'start'});
}

var _LANG_TO_CALENDAR = {
  en:'gregorian', fr:'gregorian', de:'gregorian', es:'gregorian', pt:'gregorian',
  ru:'julian', zh:'chinese', ar:'islamic', hi:'buddhist', he:'hebrew'
};

// Called from setLanguage() in index.html when the global UI language changes
function _onGlobalLanguageChanged(langCode) {
  var cal = _LANG_TO_CALENDAR[langCode] || 'gregorian';
  if (cal !== _almSystem) _almSwitchSystem(cal);
  _rosettaLangs = [langCode];
  if (_almanacOpen) _renderRosettaStone(new Date());
}

// ── Resize handler ──
var _almanacResizeTimer = null;
window.addEventListener('resize', function() {
  if (!_almanacOpen) return;
  clearTimeout(_almanacResizeTimer);
  _almanacResizeTimer = setTimeout(function() {
    _initOrrery();
    var loc = _getLocation();
    // Redraw for the CURRENTLY focused instant, not live now — resizing while
    // parked in the past/future must not snap the moon back to today. No
    // animateMoon: from == to position, so it repaints in place without a glide.
    _initSkyScene(_almFocusInstant(), loc.lat, loc.lon);
  }, 200);
});
