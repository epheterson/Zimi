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

function _getLocation() {
  var stored = localStorage.getItem(_ALM_LOC_KEY);
  if (stored) {
    try { var loc = JSON.parse(stored); return { lat: loc.lat, lon: loc.lon, name: loc.name || '', stored: true }; } catch(e) {}
  }
  // Synthetic default: mid-northern latitude at the device offset's rough
  // meridian. Good enough for sun/moon shapes — but callers formatting TIMES
  // must check `stored`: resolving this made-up point to a timezone showed a
  // fresh browser Denver's clock instead of its own (the device already
  // KNOWS its zone; deriving one from invented coordinates loses that).
  return { lat: 34, lon: -new Date().getTimezoneOffset() / 60 * 15, name: '', stored: false };
}

// Timezone used to DISPLAY times for the almanac's home location: the chosen
// location's zone, or the device's own zone when nothing was ever chosen.
function _almDisplayTz(loc) {
  loc = loc || _getLocation();
  return loc.stored
    ? _almTzForLocation(loc.lat, loc.lon)
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function _saveLocation(lat, lon, name) {
  var data = { lat: lat, lon: lon };
  if (name) data.name = name;
  localStorage.setItem(_ALM_LOC_KEY, JSON.stringify(data));
  // Keep the timezone city list in sync with the new location — otherwise a
  // map click changes the sun/moon math while a stale city stays highlighted.
  _almSelectedTz = _almTzForLocation(lat, lon);
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

function _dayOfYear(date) {
  var start = new Date(date.getFullYear(), 0, 1);
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
var _moonTexImg = new Image();
var _moonTexLoaded = false;
_moonTexImg.onload = function() { _moonTexLoaded = true; };
_moonTexImg.onerror = function() { _moonTexLoaded = false; };
_moonTexImg.src = '/static/moon.png?v=1';

function _openAlmanacInner(replaceState) {
  _almanacOpen = true;
  document.body.classList.add('almanac-mode');
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
  if (qEl) qEl.placeholder = t('almanac');
  _renderAlmanacContent();
}

function closeAlmanac() {
  if (!_almanacOpen) return;
  _almanacOpen = false;
  document.body.classList.remove('almanac-mode');
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
  // Remove #almanac hash without adding history entry
  if (location.hash === '#almanac') {
    history.replaceState(history.state, '', location.pathname + location.search);
  }
  _setWindowTitle('Zimi');
  if (typeof updateTopbar === 'function') updateTopbar();
  var qEl = document.getElementById('q');
  if (qEl) qEl.placeholder = t('search_placeholder');
}

// ── Timezone formatting ──
function _formatTimezone(lang, tz) {
  try {
    var loc = lang || ((typeof _currentLang !== 'undefined') ? _currentLang : 'en');
    // Locale-aware short zone name (e.g. "PST"). An explicit tz names the
    // shown location's zone, not the device's.
    var opts = { timeZoneName: 'short' };
    if (tz) opts.timeZone = tz;
    var fmt = new Intl.DateTimeFormat(loc, opts);
    var parts = fmt.formatToParts(new Date());
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'timeZoneName') return parts[i].value;
    }
    return '';
  } catch(e) { return ''; }
}

// Curated offline "on this day" feed — space & science milestones, keyed by
// "MM-DD" (1-based month, zero-padded). Purely static data so it works forever
// with no network. Kept deliberately tight: iconic, verifiable events only.
var _ON_THIS_DAY = {
  '01-01': [{ y: 1801, t: 'Giuseppe Piazzi discovers Ceres from Palermo — the first asteroid, now a dwarf planet.' }],
  '01-02': [{ y: 1959, t: 'The Soviet Luna 1 becomes the first spacecraft to escape Earth’s gravity.' }],
  '01-03': [{ y: 2019, t: 'China’s Chang’e 4 makes the first-ever soft landing on the Moon’s far side.' }],
  '01-04': [{ y: 1643, t: 'Isaac Newton is born in Lincolnshire (New Style calendar).' }],
  '01-05': [{ y: 2005, t: 'Eris is discovered — the find that got Pluto reclassified as a dwarf planet.' }],
  '01-07': [{ y: 1610, t: 'Galileo sees four points of light beside Jupiter — the first moons found around another planet.' }],
  '01-14': [{ y: 2005, t: 'ESA’s Huygens probe lands on Titan, the most distant landing ever made.' }],
  '01-23': [{ y: 1907, t: 'Hideki Yukawa is born in Tokyo; he predicted the meson and won Japan’s first Nobel Prize.' }],
  '01-28': [{ y: 1986, t: 'Space Shuttle Challenger breaks apart 73 seconds after launch, killing all seven crew.' }],
  '01-31': [{ y: 1958, t: 'Explorer 1 launches and discovers the Van Allen radiation belts.' }],
  '02-07': [{ y: 1984, t: 'Bruce McCandless makes the first untethered spacewalk, flying free on a jetpack.' }],
  '02-08': [{ y: 1834, t: 'Dmitri Mendeleev is born; his periodic table predicted elements nobody had found yet.' },
             { y: 1865, t: 'Gregor Mendel presents his pea-plant experiments, founding genetics.' }],
  '02-11': [{ y: 2016, t: 'LIGO announces the first direct detection of gravitational waves, from two merging black holes.' }],
  '02-12': [{ y: 1809, t: 'Charles Darwin is born.' }],
  '02-14': [{ y: 1990, t: 'Voyager 1 turns around and photographs Earth as a pale blue dot, 6 billion km away.' }],
  '02-15': [{ y: 1564, t: 'Galileo Galilei is born in Pisa.' }],
  '02-18': [{ y: 1930, t: 'Clyde Tombaugh discovers Pluto.' }],
  '02-19': [{ y: 1473, t: 'Nicolaus Copernicus is born in Toruń — he moved the Sun to the centre.' }],
  '02-20': [{ y: 1986, t: 'The Soviet Union launches the core of Mir, humanity’s home in orbit for 15 years.' }],
  '02-24': [{ y: 1968, t: 'Jocelyn Bell Burnell’s discovery of pulsars is announced.' }],
  '03-13': [{ y: 1781, t: 'William Herschel discovers Uranus — the first planet found with a telescope.' }],
  '03-14': [{ y: 1879, t: 'Albert Einstein is born in Ulm.' }, { y: 2018, t: 'Stephen Hawking dies.' }],
  '03-16': [{ y: 1926, t: 'Robert Goddard launches the first liquid-fuelled rocket.' }],
  '03-18': [{ y: 1965, t: 'Alexei Leonov leaves his capsule for 12 minutes — the first spacewalk.' }],
  '03-23': [{ y: 1882, t: 'Emmy Noether is born; her theorem ties every symmetry in physics to a conservation law.' },
             { y: 2001, t: 'Mir is guided to a controlled fiery end over the Pacific.' }],
  '04-12': [{ y: 1961, t: 'Yuri Gagarin orbits the Earth — the first human in space.' },
             { y: 1981, t: 'The first Space Shuttle, Columbia, launches.' }],
  '04-13': [{ y: 1970, t: 'An oxygen tank explodes aboard Apollo 13; the crew improvise their way home.' }],
  '04-19': [{ y: 1971, t: 'The Soviet Union launches Salyut 1, the first space station.' }],
  '04-24': [{ y: 1990, t: 'The Hubble Space Telescope launches aboard Discovery.' }],
  '04-25': [{ y: 1953, t: 'Watson and Crick publish DNA’s double helix, built on Rosalind Franklin’s X-ray images.' }],
  '05-05': [{ y: 1961, t: 'Alan Shepard makes a 15-minute suborbital hop, the first American in space.' }],
  '05-08': [{ y: 1980, t: 'The WHO declares smallpox eradicated — the only human disease ever wiped out.' }],
  '05-12': [{ y: 1910, t: 'Dorothy Hodgkin is born; she mapped penicillin, vitamin B12 and insulin by X-ray.' }],
  '05-14': [{ y: 1796, t: 'Edward Jenner performs the first vaccination, against smallpox.' },
             { y: 2021, t: 'China’s Zhurong rover lands on Mars.' }],
  '05-25': [{ y: 1961, t: 'JFK challenges the U.S. to land a man on the Moon before the decade is out.' }],
  '05-30': [{ y: 1975, t: 'The European Space Agency is founded, pooling the continent’s space programmes.' }],
  '06-13': [{ y: 2010, t: 'Japan’s Hayabusa returns the first samples ever collected from an asteroid.' }],
  '06-16': [{ y: 1963, t: 'Valentina Tereshkova becomes the first woman in space, alone for three days.' }],
  '06-18': [{ y: 1983, t: 'Sally Ride becomes the first American woman in space.' }],
  '06-23': [{ y: 1912, t: 'Alan Turing is born; he defined what a computer is before one existed.' }],
  '06-26': [{ y: 2000, t: 'The first draft of the human genome is announced.' }],
  '06-30': [{ y: 1908, t: 'A meteor explodes over Tunguska, Siberia, flattening 2,000 km² of forest.' }],
  '07-04': [{ y: 1997, t: 'Mars Pathfinder lands, delivering Sojourner — the first rover on another planet.' },
             { y: 2012, t: 'CERN announces the discovery of the Higgs boson.' }],
  '07-14': [{ y: 2015, t: 'New Horizons flies past Pluto, revealing its heart-shaped plain.' }],
  '07-15': [{ y: 1965, t: 'Mariner 4 sends back the first close-up photographs of Mars.' }],
  '07-16': [{ y: 1969, t: 'Apollo 11 launches from Kennedy Space Center.' }],
  '07-17': [{ y: 1894, t: 'Georges Lemaître is born in Belgium; the priest-physicist who proposed the expanding universe.' },
             { y: 1975, t: 'Apollo and Soyuz dock in orbit — Cold War rivals shaking hands in space.' }],
  '07-18': [{ y: 1921, t: 'John Glenn, first American to orbit Earth, is born.' }],
  '07-20': [{ y: 1969, t: 'Apollo 11 lands on the Moon; Armstrong and Aldrin walk its surface.' },
             { y: 1976, t: 'Viking 1 makes the first successful landing on Mars.' }],
  '07-23': [{ y: 1995, t: 'Comet Hale–Bopp is discovered; it would dazzle the sky for 18 months.' }],
  '08-06': [{ y: 2012, t: 'NASA’s Curiosity rover lands in Gale Crater on Mars.' },
             { y: 2014, t: 'ESA’s Rosetta arrives at comet 67P after a ten-year chase.' }],
  '08-12': [{ y: 1877, t: 'Asaph Hall discovers Mars’ moon Deimos; Phobos follows six days later.' }],
  '08-23': [{ y: 2023, t: 'India’s Chandrayaan-3 lands near the lunar south pole, a first for any nation.' }],
  '08-25': [{ y: 1989, t: 'Voyager 2 flies past Neptune — humanity’s first and only close visit.' },
             { y: 2012, t: 'Voyager 1 becomes the first spacecraft to enter interstellar space.' }],
  '09-05': [{ y: 1977, t: 'Voyager 1 launches, carrying the Golden Record.' }],
  '09-10': [{ y: 2008, t: 'The Large Hadron Collider circulates its first beam beneath the Swiss–French border.' }],
  '09-12': [{ y: 1959, t: 'Luna 2 launches; two days later it becomes the first craft to reach the Moon’s surface.' }],
  '09-21': [{ y: 2003, t: 'Galileo is deliberately crashed into Jupiter, ending a 14-year mission.' }],
  '09-23': [{ y: 1846, t: 'Neptune is found within a degree of where Le Verrier’s maths said it would be.' }],
  '09-24': [{ y: 2014, t: 'India’s Mangalyaan reaches Mars orbit on its first attempt, for under $75 million.' }],
  '09-28': [{ y: 1928, t: 'Alexander Fleming notices mould killing bacteria on a forgotten dish — penicillin.' }],
  '10-04': [{ y: 1957, t: 'The Soviet Union launches Sputnik 1; the Space Age begins with a beep.' }],
  '10-06': [{ y: 1995, t: 'Michel Mayor and Didier Queloz announce 51 Pegasi b, the first exoplanet at a Sun-like star.' }],
  '10-07': [{ y: 1959, t: 'Luna 3 sends back the first photographs of the Moon’s far side.' }],
  '10-15': [{ y: 1997, t: 'Cassini launches on its journey to Saturn.' },
             { y: 2003, t: 'Yang Liwei orbits Earth aboard Shenzhou 5 — China’s first human spaceflight.' }],
  '10-19': [{ y: 1910, t: 'Subrahmanyan Chandrasekhar is born in Lahore; he found the mass limit that makes black holes.' }],
  '11-02': [{ y: 2000, t: 'The first crew moves into the ISS; humans have lived off Earth ever since.' }],
  '11-03': [{ y: 1957, t: 'Laika launches aboard Sputnik 2, the first living creature to orbit Earth.' }],
  '11-07': [{ y: 1867, t: 'Marie Skłodowska-Curie is born in Warsaw; still the only person to win Nobels in two sciences.' }],
  '11-08': [{ y: 1656, t: 'Edmond Halley is born; he predicted a comet’s return and it kept the appointment.' },
             { y: 1895, t: 'Wilhelm Röntgen discovers X-rays and photographs his wife’s hand.' }],
  '11-09': [{ y: 1934, t: 'Carl Sagan is born.' }],
  '11-12': [{ y: 2014, t: 'ESA’s Philae makes the first-ever soft landing on a comet.' }],
  '11-20': [{ y: 1998, t: 'Zarya, the first module of the International Space Station, launches from Kazakhstan.' }],
  '11-26': [{ y: 2011, t: 'The Curiosity rover launches toward Mars.' }],
  '12-06': [{ y: 2020, t: 'Japan’s Hayabusa2 drops a capsule of asteroid Ryugu into the Australian outback.' }],
  '12-10': [{ y: 1903, t: 'Marie Curie shares the Nobel Prize in Physics — the first awarded to a woman.' }],
  '12-14': [{ y: 1972, t: 'Apollo 17’s crew leave the Moon — the last humans to walk there, so far.' }],
  '12-15': [{ y: 1970, t: 'Venera 7 transmits from the surface of Venus, the first data from another planet.' }],
  '12-17': [{ y: 1903, t: 'The Wright brothers fly for 12 seconds at Kitty Hawk.' }],
  '12-21': [{ y: 1968, t: 'Apollo 8 launches, carrying the first humans to orbit the Moon.' }],
  '12-22': [{ y: 1887, t: 'Srinivasa Ramanujan is born in Erode, India — self-taught, and still ahead of us.' }],
  '12-24': [{ y: 1979, t: 'Europe’s first Ariane rocket lifts off from French Guiana.' }],
  '12-25': [{ y: 1642, t: 'Isaac Newton is born (Old Style calendar).' },
             { y: 2021, t: 'The James Webb Space Telescope launches from French Guiana.' }],
  '12-27': [{ y: 1571, t: 'Johannes Kepler is born; he replaced circles with ellipses.' },
             { y: 1831, t: 'Darwin sets sail on HMS Beagle.' }]
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
function _almFocusInstant() { return _almFocus || new Date(); }
function _almIsToday(d) {
  var n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// Header, hero moon and the eight pills for a given instant. Re-rendered in
// place when a calendar day is picked, so there's one set of numbers on the
// page rather than a duplicate panel lower down.
function _almHeadHtml(focus) {
  var m = _moonPhase(focus);
  var dist = _moonDistance(focus);
  var age = (m.phase * 29.53).toFixed(1);

  var loc = _getLocation();
  // Times follow the CHOSEN location's zone; with no choice on record, the
  // device's own zone (a synthetic default resolved to Denver and showed a
  // fresh browser an hour-off clock).
  var locTz = null;
  try { locTz = _almDisplayTz(loc); } catch (e) {}
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var _dtOpts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  var _tmOpts = { hour: 'numeric', minute: '2-digit' };
  if (locTz) { _dtOpts.timeZone = locTz; _tmOpts.timeZone = locTz; }
  var dateStr = focus.toLocaleDateString(lang, _dtOpts);
  var timeStr = focus.toLocaleTimeString(lang, _tmOpts);
  var tzName = _formatTimezone(lang, locTz);
  // "Live" means no explicit focus is set — the panel is tracking now. A
  // specific time picked for *today* is still an override, so key off the
  // focus flag, not just the calendar day.
  var live = (_almFocus === null);

  // The date/time is quietly tappable — click it and it becomes adjustable
  // (the editor lives in its own container so it survives panel repaints). The
  // affordance is deliberately understated; discover it by clicking.
  var html = '<div style="text-align:center;margin-bottom:16px">';
  html += '<div class="alm-focus-tap" onclick="_almToggleDateEdit()" title="' + _almEsc(t('alm_de_edit')) + '">';
  html += '<div class="alm-focus-date">' + dateStr + '</div>';
  html += '<div class="alm-focus-time">' + timeStr + (tzName ? ' &middot; ' + tzName : '') + '</div>';
  html += '</div>';
  if (!live) {
    html += '<div style="margin-top:6px"><button class="alm-sc-reset" onclick="_almBackToToday()">' + _almEsc(t('alm_today')) + '</button></div>';
  }
  html += '</div>';

  // Hero moon — tilted so the bright limb faces the Sun as the observer sees
  // it. brightLimb (chi − q) is the right physical quantity, but the base
  // moon art has its lit limb at 3 o'clock and CSS rotation runs opposite to
  // the position-angle sense on screen, so the screen tilt is −(chi−q) − 90.
  // Applying chi−q raw flipped the crescent to the wrong side of the disc (a
  // waxing crescent after sunset lit upper-LEFT, away from the set Sun).
  var moonPos = _moonPosition(focus, loc.lat, loc.lon);
  var _limbPA = (moonPos.brightLimb != null ? moonPos.brightLimb : moonPos.parallactic) || 0;
  var moonTilt = -_limbPA - 90;
  html += '<div class="almanac-hero">';
  html += _renderAlmanacMoon(m, moonTilt);
  html += '<div class="almanac-moon-name">' + _localMoonName(m.name) + '</div>';
  html += '</div>';

  // Sun cards render in the shown location's timezone (same locTz as the
  // header), so the clock, sun times and moon all agree.
  var _locTzOff;
  try { _locTzOff = _tzUtcOffsetMin(locTz, focus); }
  catch (e) { _locTzOff = -focus.getTimezoneOffset(); }
  var sunInfo0 = _computeSunTimes(focus, loc.lat, loc.lon, _locTzOff);

  html += '<div class="alm-cards">';
  html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_illuminated') + '</div><div class="alm-card-val">' + m.illumination + '%</div></div>';
  html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_moon_age') + '</div><div class="alm-card-val">' + age + ' ' + t('alm_days') + '</div></div>';
  html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_distance') + '</div><div class="alm-card-val">' + Math.round(dist).toLocaleString() + ' ' + t('alm_km') + '</div></div>';
  var _nfm = _nextFullMoon(focus);
  if (_nfm) {
    var _nfmStr = _nfm.date.toLocaleDateString(lang, { month: 'short', day: 'numeric' });
    html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_next_full') + '</div><div class="alm-card-val"' +
      (_nfm.isSuper ? ' style="color:#e0b060"' : '') + '>' + _nfmStr +
      (_nfm.isSuper ? ' \u00b7 ' + t('alm_supermoon') : '') + '</div></div>';
  }
  if (sunInfo0.polar) {
    html += '<div class="alm-card" style="grid-column:span 4"><div class="alm-card-val">' + sunInfo0.polar + '</div></div>';
  } else {
    html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_sunrise') + '</div><div class="alm-card-val">' + sunInfo0.sunrise + '</div></div>';
    html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_sunset') + '</div><div class="alm-card-val">' + sunInfo0.sunset + '</div></div>';
    html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_daylight') + '</div><div class="alm-card-val">' + sunInfo0.dayLength + '</div></div>';
    if (sunInfo0.goldenHour) {
      html += '<div class="alm-card"><div class="alm-card-lbl">' + t('alm_golden') + '</div><div class="alm-card-val" style="color:#d4aa64">' + sunInfo0.goldenHour + '</div></div>';
    }
  }
  html += '</div>';
  return html;
}

// Repaint every panel that describes a moment, in place, for the focused
// instant. Two things deliberately stay out of it: the world clock (it is a
// clock — it should always read now) and the orrery, which carries its own
// date and speed and operates on a completely different time scale.
function _almRepaintFocus() {
  var focus = _almFocusInstant();
  var loc = _getLocation();
  var m = _moonPhase(focus);
  var head = document.getElementById('almanac-head');
  if (head) head.innerHTML = _almHeadHtml(focus);
  _renderSunMap(focus);
  // _renderSunMap re-seeds the world-clock grid off the date it's handed. That
  // grid is a *clock* — it must keep reading now, not the focused instant.
  _initTzClock(new Date());
  _renderOnThisDay(focus);
  _renderTonightSky(focus);
  _renderStarChart(focus);
  _renderAnalemma(focus);
  _renderAstroPanel(focus);
  _renderMeteorShowers(focus, m);
  _renderCelestialEvents(focus);
  _renderDeepTime(focus);
  // Re-seeding the sky scene cancels the previous RAF, so loops don't stack.
  _initSkyScene(focus, loc.lat, loc.lon);
}

function _almBackToToday() {
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
}

function _renderAlmanacContent() {
  var now = new Date();
  var m = _moonPhase(now);

  var html = '<div class="almanac-inner">';
  html += '<div id="almanac-head">' + _almHeadHtml(now) + '</div>';
  // Date/time editor — a sibling of the head (not a child), so it isn't wiped
  // when the head repaints on every focus change; the slider keeps its grip.
  html += '<div id="almanac-dateedit" class="alm-dateedit" style="display:none"></div>';

  // Sky scene + calendar — wall calendar: art above, month grid below
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
  html += '<div class="almanac-section-title">' + t('alm_solar_system') + '</div>';
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
  // Scrub +/- 12h to watch the sky turn; tap a body to identify it.
  html += '<div class="alm-sc-controls">' +
    '<span class="alm-sc-time" id="alm-sc-time"></span>' +
    '<input id="alm-sc-slider" type="range" min="-720" max="720" step="10" value="0" class="orrery-slider"' +
      ' aria-label="' + _almEsc(t('alm_star_chart')) + '" oninput="_setStarChartTime(this.value)" />' +
    '<button class="orrery-ctrl-btn" onclick="_starChartNow()" title="' + _almEsc(t('alm_back_to_now')) + '">' + t('alm_now') + '</button>' +
    '</div>';
  html += '<div id="alm-sc-info" class="alm-sc-info"></div>';
  html += '<div id="almanac-starchart-caption" class="alm-starchart-caption"></div>';
  html += '</div>';

  // The Analemma — the Sun's yearly figure-8 (equation of time × declination)
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_analemma') + '</div>';
  html += '<div class="alm-analemma-wrap"><canvas id="almanac-analemma"></canvas></div>';
  html += '<div id="almanac-analemma-caption" class="alm-analemma-caption"></div>';
  html += '</div>';

  // Meteor showers
  html += '<div class="almanac-section">';
  html += '<div class="almanac-section-title">' + t('alm_meteor_showers') + '</div>';
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

// Almanac hero moon — delegates to shared _renderMoonHTML (defined in index.html)
// Adds the almanac-specific glow wrapper
function _renderAlmanacMoon(m, tiltDeg) {
  var illumFrac = m.illumination / 100;
  var glowOpacity = (illumFrac * 0.15 + 0.02).toFixed(2);
  return '<div class="almanac-moon-glow" style="background:radial-gradient(circle, rgba(232,224,208,' + glowOpacity + ') 0%, transparent 65%)"></div>' +
    _renderMoonHTML(m, 'almanac-moon', tiltDeg, 1.0);
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
var _VOYAGERS = [
  { name: 'Voyager 1', launch: Date.UTC(1977, 8, 5), refEpoch: Date.UTC(2025, 0, 1), refDist: 164.0, vel: 3.59, lon: 260.5 },
  { name: 'Voyager 2', launch: Date.UTC(1977, 7, 20), refEpoch: Date.UTC(2025, 0, 1), refDist: 137.0, vel: 3.25, lon: 296.2 }
];
var _voyagerPositions = []; // [{name, x, y, r, dist, idx}] in CSS pixels

function _voyagerDist(v, simTime) {
  var yearsFromRef = (simTime - v.refEpoch) / (365.25 * MS_PER_DAY);
  return Math.max(0, v.refDist + v.vel * yearsFromRef);
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

function _smoothstep(edge0, edge1, x) {
  var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}


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
      results.push({ date: dateStr, type: type });
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
  var W = south ? t('season_summer') : t('season_winter'), Sp = south ? t('season_autumn') : t('season_spring');
  var Su = south ? t('season_winter') : t('season_summer'), Au = south ? t('season_spring') : t('season_autumn');
  var _eq = t('alm_equinox'), _sol = t('alm_solstice');
  var seasonBounds = [
    { name: W, start: new Date(y - 1, 11, 21), end: new Date(y, 2, 20), next: Sp + ' ' + _eq },
    { name: Sp, start: new Date(y, 2, 20), end: new Date(y, 5, 21), next: Su + ' ' + _sol },
    { name: Su, start: new Date(y, 5, 21), end: new Date(y, 8, 22), next: Au + ' ' + _eq },
    { name: Au, start: new Date(y, 8, 22), end: new Date(y, 11, 21), next: W + ' ' + _sol },
    { name: W, start: new Date(y, 11, 21), end: new Date(y + 1, 2, 20), next: Sp + ' ' + _eq }
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

  var perihelion = new Date(y, 0, 3);
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
  var constellation = _tc(zodiac[zodiac.length - 1].name);
  for (var zi = zodiac.length - 1; zi >= 0; zi--) {
    if (sunLon >= zodiac[zi].start) { constellation = _tc(zodiac[zi].name); break; }
  }

  // Compute eclipses algorithmically — works for any date, forever
  var nextEclipses = _computeEclipses(now, 3);

  var html = '<div class="almanac-info-grid">';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + dayOfYear + ' / ' + daysInYear + '</div><div class="almanac-info-lbl">' + t('alm_day_of_year') + '</div></div>';
  if (season) {
    html += '<div class="almanac-info-item"><div class="almanac-info-val">' + season.name + '</div><div class="almanac-info-lbl">' + t('alm_days_to_next', { n: season.daysUntilNext, next: season.next }) + '</div>' +
      '<div class="almanac-progress"><div class="almanac-progress-bar" style="width:' + Math.round(season.progress * 100) + '%"></div></div></div>';
  }
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + earthSunAU + ' AU</div><div class="almanac-info-lbl">' + t('alm_earth_sun_dist') + '</div></div>';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + constellation + '</div><div class="almanac-info-lbl">' + t('alm_sun_constellation') + '</div></div>';
  html += '</div>';

  if (nextEclipses.length > 0) {
    html += '<div style="margin-top:16px">';
    html += '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">' + t('alm_upcoming_eclipses') + '</div>';
    for (var ei = 0; ei < nextEclipses.length; ei++) {
      var ec = nextEclipses[ei];
      var ecDate = new Date(ec.date + 'T00:00:00');
      var daysUntil = Math.ceil((ecDate - now) / MS_PER_DAY);
      var untilStr = daysUntil <= 0 ? t('alm_today') : daysUntil === 1 ? t('alm_tomorrow') : t('alm_n_days', { n: daysUntil });
      html += '<div class="almanac-eclipse-row">' +
        '<div><span class="almanac-eclipse-type">' + ec.type + '</span><br><span class="almanac-eclipse-date">' +
        ecDate.toLocaleDateString((typeof _currentLang !== 'undefined') ? _currentLang : undefined, { month: 'long', day: 'numeric', year: 'numeric' }) + '</span></div>' +
        '<div class="almanac-eclipse-until">' + untilStr + '</div></div>';
    }
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
  _sunMapHasLocation = !!smLoc.name;

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

      // Snap to nearby city
      var snapDist = 15 / rect.width * 360;
      var snappedName = '';
      for (var ci = 0; ci < _MAP_CITIES.length; ci++) {
        var c = _MAP_CITIES[ci];
        var dlat = lat - c.lat, dlon = (lon - c.lon) * Math.cos(lat * DEG_TO_RAD);
        if (Math.sqrt(dlat * dlat + dlon * dlon) < snapDist) {
          lat = c.lat; lon = c.lon;
          snappedName = c.name;
          break;
        }
      }
      _saveLocation(lat, lon, snappedName);
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
      var all = [];
      for (var i = 0; i < _MAP_CITIES.length; i++) {
        var name = _MAP_CITIES[i].name.toLowerCase();
        var idx = name.indexOf(q);
        if (idx === -1) continue;
        // Rank: 0 = city name starts with query, 1 = any part starts with, 2 = substring
        var rank = 2;
        if (idx === 0) rank = 0;
        else if (name.charAt(idx - 1) === ' ' || name.charAt(idx - 1) === ',') rank = 1;
        all.push({ city: _MAP_CITIES[i], rank: rank });
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
  var fmtOpts = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false };
  var enFmt = function(z) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: z }, fmtOpts)).format(now); };
  return Math.round((new Date(enFmt(tz)) - new Date(enFmt('UTC'))) / 60000);
}

// Best _TZ_CITIES match for an arbitrary lat/lon. No offline tz database, so
// approximate: geographic distance dominates (same-region cities usually
// share a zone, DST included), with the gap between the city's civil offset
// and the location's solar offset (lon/15 h) as a mild tie-break — 1 h of
// offset mismatch costs the same as 1° of distance.
// Denser anchor set for mapping a clicked location to its timezone. The
// world-clock GRID stays one-city-per-offset (_TZ_CITIES); resolution needs
// more points or wide political zones misroute — Central European Time
// spans Madrid to Warsaw, so with Paris as the only CET anchor, Germany
// landed on London (#28). Pure nearest-distance over real IANA zones — no
// solar-time term (that was what tipped eastern-CET onto UK time).
var _TZ_ANCHORS = [
  // Americas
  [21.31, -157.86, 'Pacific/Honolulu'], [61.22, -149.90, 'America/Anchorage'],
  [34.05, -118.24, 'America/Los_Angeles'], [49.28, -123.12, 'America/Vancouver'],
  [39.74, -104.99, 'America/Denver'], [33.45, -112.07, 'America/Phoenix'],
  [41.88, -87.63, 'America/Chicago'], [19.43, -99.13, 'America/Mexico_City'],
  [40.71, -74.01, 'America/New_York'], [43.65, -79.38, 'America/Toronto'],
  [4.71, -74.07, 'America/Bogota'], [-12.05, -77.04, 'America/Lima'],
  [-33.45, -70.67, 'America/Santiago'], [-23.55, -46.63, 'America/Sao_Paulo'],
  [-34.60, -58.38, 'America/Argentina/Buenos_Aires'],
  // Europe / Africa
  [64.15, -21.94, 'Atlantic/Reykjavik'], [51.51, -0.13, 'Europe/London'],
  [53.35, -6.26, 'Europe/Dublin'], [38.72, -9.14, 'Europe/Lisbon'],
  [40.42, -3.70, 'Europe/Madrid'], [48.86, 2.35, 'Europe/Paris'],
  [52.52, 13.40, 'Europe/Berlin'], [52.37, 4.90, 'Europe/Amsterdam'],
  [41.90, 12.50, 'Europe/Rome'], [47.37, 8.54, 'Europe/Zurich'],
  [52.23, 21.01, 'Europe/Warsaw'], [59.33, 18.06, 'Europe/Stockholm'],
  [37.98, 23.73, 'Europe/Athens'], [60.17, 24.94, 'Europe/Helsinki'],
  [44.43, 26.10, 'Europe/Bucharest'], [50.45, 30.52, 'Europe/Kyiv'],
  [41.01, 28.98, 'Europe/Istanbul'], [55.76, 37.62, 'Europe/Moscow'],
  [6.52, 3.38, 'Africa/Lagos'], [30.04, 31.24, 'Africa/Cairo'],
  [-1.29, 36.82, 'Africa/Nairobi'], [-26.20, 28.05, 'Africa/Johannesburg'],
  [33.57, -7.59, 'Africa/Casablanca'],
  // Asia / Middle East / Oceania
  [35.69, 51.39, 'Asia/Tehran'], [24.71, 46.68, 'Asia/Riyadh'],
  [25.20, 55.27, 'Asia/Dubai'], [24.86, 67.01, 'Asia/Karachi'],
  [19.08, 72.88, 'Asia/Kolkata'], [27.72, 85.32, 'Asia/Kathmandu'],
  [23.81, 90.41, 'Asia/Dhaka'], [13.76, 100.50, 'Asia/Bangkok'],
  [-6.21, 106.85, 'Asia/Jakarta'], [1.35, 103.82, 'Asia/Singapore'],
  [22.32, 114.17, 'Asia/Hong_Kong'], [31.23, 121.47, 'Asia/Shanghai'],
  [14.60, 120.98, 'Asia/Manila'], [-31.95, 115.86, 'Australia/Perth'],
  [37.57, 126.98, 'Asia/Seoul'], [35.68, 139.69, 'Asia/Tokyo'],
  [-34.93, 138.60, 'Australia/Adelaide'], [-27.47, 153.03, 'Australia/Brisbane'],
  [-33.87, 151.21, 'Australia/Sydney'], [-36.85, 174.76, 'Pacific/Auckland']
];

function _almTzForLocation(lat, lon) {
  var best = null, bestD = Infinity;
  for (var i = 0; i < _TZ_ANCHORS.length; i++) {
    var a = _TZ_ANCHORS[i];
    var dlat = lat - a[0];
    var dlon = (lon - a[1]) * Math.cos(lat * DEG_TO_RAD);
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
  // A world-clock card is a PREVIEW: it drives the analog clock and the card
  // highlight, nothing else. It used to also _saveLocation(city) — so peeking
  // at Tokyo's time silently re-homed the entire almanac (header clock, sun
  // times, holidays) to Tokyo, permanently, per browser. Location changes
  // belong to the sun map's picker alone.
  _almSelectedTz = tz;
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
        '<div class="alm-clock-time"><span id="alm-clock-hm">' + hm + '</span>' +
          '<span class="alm-clock-sec" id="alm-clock-sec">' + sec + '</span>' +
          '<span class="alm-clock-ampm" id="alm-clock-ampm">' + ampm + '</span></div>' +
        '<div class="alm-clock-date" id="alm-clock-date">' + dateStr + '</div>' +
        '<div class="alm-clock-sub"><span id="alm-clock-tzname">' + (tzLabel || '') + (tzAbbr ? ' \u00b7 ' + tzAbbr : '') + '</span></div>';
    } else {
      var hmEl = document.getElementById('alm-clock-hm');
      if (hmEl && hmEl.textContent !== hm) hmEl.textContent = hm;
      var apEl = document.getElementById('alm-clock-ampm');
      if (apEl && apEl.textContent !== ampm) apEl.textContent = ampm;
      var dEl = document.getElementById('alm-clock-date');
      if (dEl && dEl.textContent !== dateStr) dEl.textContent = dateStr;
      var tnEl = document.getElementById('alm-clock-tzname');
      var tzText = (tzLabel || '') + (tzAbbr ? ' \u00b7 ' + tzAbbr : '');
      if (tnEl && tnEl.textContent !== tzText) tnEl.textContent = tzText;
      var secondsEl = document.getElementById('alm-clock-sec');
      if (secondsEl && secondsEl.textContent !== sec) secondsEl.textContent = sec;
    }
  }
}

// Cached Intl.DateTimeFormat objects — avoid 180+ allocations/sec in the RAF loop
var _tzFmtCache = {};
function _tzFmt(tz, opts) {
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var key = lang + '|' + tz + '|' + Object.values(opts).join(',');
  if (!_tzFmtCache[key]) _tzFmtCache[key] = new Intl.DateTimeFormat(lang, Object.assign({ timeZone: tz }, opts));
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
  { name: 'Tashkent, Uzbekistan', lat: 41.30, lon: 69.28 },
  { name: 'Almaty, Kazakhstan', lat: 43.24, lon: 76.95 },
  { name: 'Tbilisi, Georgia', lat: 41.69, lon: 44.80 },
  { name: 'Baku, Azerbaijan', lat: 40.41, lon: 49.87 },
  // Oceania
  { name: 'Sydney, New South Wales, Australia', lat: -33.87, lon: 151.21 },
  { name: 'Melbourne, Victoria, Australia', lat: -37.81, lon: 144.96 },
  { name: 'Brisbane, Queensland, Australia', lat: -27.47, lon: 153.03 },
  { name: 'Perth, Western Australia, Australia', lat: -31.95, lon: 115.86 },
  { name: 'Auckland, New Zealand', lat: -36.85, lon: 174.76 },
  { name: 'Wellington, New Zealand', lat: -41.29, lon: 174.78 },
  { name: 'Suva, Fiji', lat: -17.77, lon: 177.97 }
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
      _renderAlmanacContent();
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
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  return d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
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
// Uses mean orbital elements to estimate the Moon's equatorial position,
// then converts to horizontal coordinates (same pipeline as the sun).
function _moonPosition(date, lat, lon) {
  var JD = _dateToJD(date.getTime());
  var T = _jdToJulianCentury(JD);

  // Mean orbital elements (degrees)
  var L0 = (218.3165 + 481267.8813 * T) % 360;         // mean longitude
  var M  = (134.9634 + 477198.8676 * T) % 360;          // mean anomaly
  var Ms = (357.5291 +  35999.0503 * T) % 360;          // sun mean anomaly
  var F  = (93.2720  + 483202.0175 * T) % 360;          // argument of latitude
  var D  = (297.8502 + 445267.1115 * T) % 360;          // mean elongation

  // Ecliptic longitude (principal terms only)
  var lng = L0
    + 6.289 * Math.sin(M * DEG_TO_RAD)
    - 1.274 * Math.sin((2*D - M) * DEG_TO_RAD)
    - 0.658 * Math.sin(2*D * DEG_TO_RAD)
    - 0.214 * Math.sin(2*M * DEG_TO_RAD)
    - 0.186 * Math.sin(Ms * DEG_TO_RAD);

  // Ecliptic latitude
  var lat_ec = 5.128 * Math.sin(F * DEG_TO_RAD)
    + 0.281 * Math.sin((M + F) * DEG_TO_RAD)
    + 0.278 * Math.sin((F - M) * DEG_TO_RAD);

  // Ecliptic to equatorial (obliquity ≈ 23.44°)
  var eps = 23.44 * DEG_TO_RAD;
  var lngR = lng * DEG_TO_RAD, latR = lat_ec * DEG_TO_RAD;
  var sinDec = Math.sin(latR) * Math.cos(eps) + Math.cos(latR) * Math.sin(eps) * Math.sin(lngR);
  var dec = Math.asin(sinDec);
  var ra = Math.atan2(
    Math.sin(lngR) * Math.cos(eps) - Math.tan(latR) * Math.sin(eps),
    Math.cos(lngR)
  );

  // Local sidereal time
  var GMST = (280.46061837 + 360.98564736629 * (JD - JD_J2000)) % 360;
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
  // Parallactic angle q: rotation from celestial north to the observer's
  // local vertical. q = atan2(sin HA, tan(lat)·cos dec − sin dec·cos HA)
  var parallactic = Math.atan2(Math.sin(HA), Math.tan(latR2) * Math.cos(dec) - Math.sin(dec) * Math.cos(HA));
  // Bright-limb position angle chi (Meeus 48.5): direction of the Sun from the
  // Moon's disc, measured from celestial north. Needs the Sun's equatorial
  // position. The terminator's tilt as the observer SEES it is chi − q — the
  // old code used q alone, tilting the crescent's horns 10-25° off.
  var Lsun = 280.4665 + 36000.7698 * T;
  var lamSun = (Lsun + 1.915 * Math.sin(Ms * DEG_TO_RAD) + 0.020 * Math.sin(2 * Ms * DEG_TO_RAD)) * DEG_TO_RAD;
  var raSun = Math.atan2(Math.cos(eps) * Math.sin(lamSun), Math.cos(lamSun));
  var decSun = Math.asin(Math.sin(eps) * Math.sin(lamSun));
  var dA = raSun - ra;
  var chi = Math.atan2(Math.cos(decSun) * Math.sin(dA),
    Math.sin(decSun) * Math.cos(dec) - Math.cos(decSun) * Math.sin(dec) * Math.cos(dA));
  return {
    altitude: altitude, azimuth: azimuth,
    parallactic: parallactic * 180 / Math.PI,
    brightLimb: (chi - parallactic) * 180 / Math.PI
  };
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
      '<div class="alm-analemma-now">' + t('alm_sun') + ': ' + mins.toFixed(1) + ' ' + t('alm_min') + ' ' + fastSlow +
      ' · ' + t('alm_declination') + ' ' + td.decl.toFixed(1) + '°</div>' +
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
    rows += '<div class="alm-otd-row">' +
      '<div class="alm-otd-year">' + String(ev.y) + '</div>' +
      '<div class="alm-otd-text">' + _almEsc(ev.t) +
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
        '<span class="almanac-eclipse-type" style="color:' + p.color + '">' + _tp(p.name) + '</span>' +
        '<br><span class="almanac-eclipse-date">' + brightness + ' &middot; mag ' + magStr + ' &middot; ' + p.elongation.toFixed(0) + '\u00b0 ' + t('alm_from_sun') + '</span>' +
        '</div>' +
        '<div class="almanac-eclipse-until" style="font-size:11px">' + p.sky + '<br>' + p.direction + '</div></div>';
    }
    if (notVisible.length > 0) {
      var names = notVisible.map(function(p) { return _tp(p.name); });
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
    var untilStr = s.daysUntil < 0 ? t('alm_peak') : s.daysUntil === 0 ? t('alm_tonight') : s.daysUntil === 1 ? t('alm_tomorrow') : s.daysUntil + ' ' + t('alm_days');
    var rateDesc = s.zhr >= 100 ? t('alm_meteor_major') : s.zhr >= 25 ? t('alm_meteor_moderate') : t('alm_meteor_minor');
    var condColor = s.moonCondition === t('alm_moon_ideal') ? 'var(--accent)' : s.moonCondition === t('alm_moon_fair') ? 'var(--text2)' : 'var(--text3)';
    html += '<div class="almanac-eclipse-row">' +
      '<div>' +
      '<span class="almanac-eclipse-type">' + t('alm_shower_' + s.key) + '</span>' +
      '<br><span class="almanac-eclipse-date">~' + s.zhr + t('alm_per_hour') + ' &middot; ' + _tc(s.radiant) + ' &middot; ' + t('alm_speed_' + s.speed.toLowerCase()) +
      ' &middot; <span style="color:' + condColor + '">' + s.moonIcon + ' ' + s.moonCondition + '</span></span>' +
      '</div>' +
      '<div class="almanac-eclipse-until">' + untilStr + '</div></div>';
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
        title = _tp(ev.planets[0]) + ' \u2013 ' + _tp(ev.planets[1]) + ' ' + t('alm_conjunction');
        detail = ev.separation.toFixed(1) + '\u00b0 ' + t('alm_apart') + ' &middot; ' + dateStr;
      } else if (ev.type === 'opposition') {
        title = _tp(ev.planet) + ' ' + t('alm_at_opposition');
        detail = t('alm_closest_brightest') + ' &middot; ' + dateStr;
      } else if (ev.type === 'elongation') {
        title = _tp(ev.planet) + ' ' + t('alm_greatest_elongation');
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
  try {
    var locData = JSON.parse(localStorage.getItem(_ALM_LOC_KEY) || 'null');
    if (locData && typeof locData.lat === 'number') {
      return _almRegionForLocation(locData.lat, locData.lon);
    }
  } catch (e) {}
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

function _applyRegionHolidays(region, year, month, add) {
  var pack = _REGION_HOLIDAYS[region];
  if (!pack) return;
  var src = _almRegionName(region);
  var i;
  for (i = 0; i < (pack.fixed || []).length; i++) {
    var fx = pack.fixed[i];
    if (fx[0] === month) add(fx[1], fx[2], 'holiday', '', src);
  }
  for (i = 0; i < (pack.nth || []).length; i++) {
    var nh = pack.nth[i];
    if (nh[0] !== month) continue;
    var day = nh[2] === -1 ? _lastWeekday(year, month, nh[1]) : _nthWeekday(year, month, nh[1], nh[2]);
    add(day, nh[3], 'holiday', '', src);
  }
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
  var south = false;
  try {
    var loc = JSON.parse(localStorage.getItem(_ALM_LOC_KEY) || 'null');
    south = !!(loc && loc.lat < 0);
  } catch (e) {}
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
  function add(day, label, type, icon, src) {
    if (day < 1 || day > 31) return;
    if (!events[day]) events[day] = [];
    // Belt-and-suspenders: base set + one region pack should never
    // collide, but a same-day duplicate label renders as noise if they do.
    for (var di = 0; di < events[day].length; di++) {
      if (events[day][di].label === label) return;
    }
    events[day].push({ label: label, type: type, icon: icon || '', src: src || '' });
  }

  if (sys === 'gregorian') {
    // International base — observed widely enough to show everywhere. Mix of
    // UN international days, cultural observances, and a few for fun.
    if (month === 1) { add(1, "New Year's Day", 'holiday'); add(4, 'World Braille Day', 'holiday'); add(6, 'Epiphany', 'holiday'); add(24, 'International Day of Education', 'holiday'); add(27, 'Holocaust Remembrance Day', 'holiday'); }
    if (month === 2) { add(4, 'World Cancer Day', 'holiday'); add(11, 'Intl. Day of Women in Science', 'holiday'); add(12, 'Darwin Day', 'holiday'); add(14, "Valentine's Day", 'holiday'); add(21, 'International Mother Language Day', 'holiday'); }
    if (month === 3) { add(3, 'World Wildlife Day', 'holiday'); add(8, "International Women's Day", 'holiday'); add(14, 'Pi Day', 'holiday'); add(17, "St. Patrick's Day", 'holiday'); add(20, 'International Day of Happiness', 'holiday'); add(21, 'World Poetry Day', 'holiday'); add(22, 'World Water Day', 'holiday'); add(27, 'World Theatre Day', 'holiday'); }
    if (month === 4) { add(1, "April Fools' Day", 'holiday'); add(7, 'World Health Day', 'holiday'); add(15, 'World Art Day', 'holiday'); add(22, 'Earth Day', 'holiday'); add(23, 'World Book Day', 'holiday'); add(29, 'International Dance Day', 'holiday'); }
    if (month === 5) { add(1, "May Day / Workers' Day", 'holiday'); add(3, 'World Press Freedom Day', 'holiday'); add(4, 'Star Wars Day', 'holiday'); add(15, 'International Day of Families', 'holiday'); add(20, 'World Bee Day', 'holiday'); add(25, 'Towel Day', 'holiday'); }
    if (month === 6) { add(5, 'World Environment Day', 'holiday'); add(8, 'World Oceans Day', 'holiday'); add(20, 'World Refugee Day', 'holiday'); add(21, 'International Yoga Day', 'holiday'); add(21, 'World Music Day', 'holiday'); }
    if (month === 7) { add(11, 'World Population Day', 'holiday'); add(17, 'World Emoji Day', 'holiday'); add(18, 'Nelson Mandela Day', 'holiday'); add(20, 'Moon Landing Day', 'holiday'); add(30, 'International Friendship Day', 'holiday'); }
    if (month === 8) { add(8, 'International Cat Day', 'holiday'); add(12, 'International Youth Day', 'holiday'); add(19, 'World Humanitarian Day', 'holiday'); add(19, 'World Photography Day', 'holiday'); add(26, 'International Dog Day', 'holiday'); }
    if (month === 9) { add(8, 'International Literacy Day', 'holiday'); add(21, 'International Day of Peace', 'holiday'); add(23, 'International Day of Sign Languages', 'holiday'); add(27, 'World Tourism Day', 'holiday'); }
    if (month === 10) { add(1, 'International Coffee Day', 'holiday'); add(4, 'World Animal Day', 'holiday'); add(5, "World Teachers' Day", 'holiday'); add(10, 'World Mental Health Day', 'holiday'); add(16, 'World Food Day', 'holiday'); add(24, 'United Nations Day', 'holiday'); add(31, 'Halloween', 'holiday'); }
    if (month === 11) { add(10, 'World Science Day', 'holiday'); add(13, 'World Kindness Day', 'holiday'); add(19, "International Men's Day", 'holiday'); add(20, "World Children's Day", 'holiday'); add(21, 'World Television Day', 'holiday'); }
    if (month === 12) { add(3, 'Intl. Day of Persons with Disabilities', 'holiday'); add(5, 'International Volunteer Day', 'holiday'); add(10, 'Human Rights Day', 'holiday'); add(11, 'International Mountain Day', 'holiday'); add(24, 'Christmas Eve', 'holiday'); add(25, 'Christmas Day', 'holiday'); add(31, "New Year's Eve", 'holiday'); }
    // Mother's/Father's Day on the US dates — the majority convention
    // (US, CA, AU, DE, IT, BR, IN, CN, JP and others)
    if (month === 5) { add(_nthWeekday(year, 5, 0, 2), "Mother's Day", 'holiday'); }
    if (month === 6) { add(_nthWeekday(year, 6, 0, 3), "Father's Day", 'holiday'); }
    // National days + clock changes for the detected region
    _applyRegionHolidays(_almRegion(), year, month, add);
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

  else if (sys === 'hebrew') {
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
      if (s.peak[0] === month) { add(s.peak[1], _showerName(s), 'meteor', '\u2604'); }
    }
  }

  return events;
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

  // Navigation
  html += '<div class="alm-nav">';
  html += '<button class="alm-arrow" onclick="_almPrev()">\u25C0</button>';
  html += '<div class="alm-title">' + monthName + ' ' + yearStr + '</div>';
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
      var srcTitle = ev.src ? ' title="' + _tLookup('alm_region_holiday', '{c} holiday').replace('{c}', ev.src).replace(/"/g, '&quot;') + '"' : '';
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

  // Selected day detail — full event list for the selected day
  var selCal = _jdnToCalendar(_almSystem, _almSelectedJDN);
  if (selCal.year === _almYear && selCal.month === _almMonth) {
    var selEvents = events[selCal.day] || [];
    if (selEvents.length > 0) {
      html += '<div class="alm-day-detail">';
      for (var ei = 0; ei < selEvents.length; ei++) {
        var ev = selEvents[ei];
        var detailLabel = _th(ev.label).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (ev.src) detailLabel += ' <span style="color:var(--text3)">\u00b7 ' + ev.src.replace(/</g,'&lt;') + '</span>';
        html += '<div class="alm-ev alm-ev-' + ev.type + (ev.src ? ' alm-ev-country' : '') + '" style="font-size:12px;padding:2px 0">' +
          (ev.icon ? ev.icon + ' ' : '') + detailLabel + '</div>';
      }
      html += '</div>';
    }
  }

  // Quiet caption saying whose national days are shown. Always present on
  // the Gregorian calendar — no pack means the worldwide set, and saying
  // so beats an unexplained absence of holidays.
  if (_almSystem === 'gregorian') {
    var regionName = _almRegionName(_almRegion());
    var capText = regionName
      ? _tLookup('alm_showing_holidays', 'Showing {c} holidays').replace('{c}', regionName.replace(/</g, '&lt;'))
      : _tLookup('alm_showing_worldwide', 'Showing worldwide holidays');
    html += '<div class="alm-cal-region" title="' +
      _tLookup('alm_holidays_follow_hint', 'Follows your location on the map').replace(/"/g, '&quot;') +
      '">' + capText + '</div>';
  }

  // Cross-reference — selected date in all calendar systems (replaces pills)
  html += _almRenderCrossRef(_almSelectedJDN);

  el.innerHTML = html;
}

function _almSwitchSystem(sys) {
  // No 'chinese' grid: the mean-lunation math behind the cross-reference row
  // is fine for a one-line "\u2248" conversion, but a browsable month grid needs
  // real astronomical new moons and leap-month intercalation — without them
  // it showed invented month lengths and no leap months, a full month off
  // for parts of leap years. Guarded HERE because every path funnels through
  // this function (crossref clicks, the zh language auto-switch); the grid
  // returns when the real calendar lands.
  if (sys === 'chinese') sys = 'gregorian';
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
  var picked = new Date(g.year, g.month - 1, g.day, nowT.getHours(), nowT.getMinutes(), 0);
  _almFocus = _almIsToday(picked) ? null : picked;
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
    var cal = _jdnToCalendar(sys, jdn);
    var monthName = _calMonthName(sys, cal.year, cal.month);
    var yearStr = cal.year + _calYearSuffix(sys);
    var dateStr = monthName + ' ' + cal.day + ', ' + yearStr;
    if (sys === 'chinese') {
      // Key the animal to the CHINESE year being displayed (era 2697), not the
      // Gregorian year \u2014 otherwise the animal flips on Jan 1 and contradicts
      // the year number beside it for the weeks before Chinese New Year.
      var chinese = _chineseZodiac(cal.year - 2697);
      // "\u2248": mean-lunation approximation without leap months \u2014 close most of
      // the time, but not the real astronomical Chinese calendar.
      dateStr = '\u2248 ' + monthName + ' ' + cal.day + ' \u00b7 ' + chinese.animal + ' \u00b7 ' + yearStr;
    }
    var isActive = sys === _almSystem ? ' alm-crossref-active' : '';
    // The Chinese row is a cross-reference only: no grid view is offered for
    // it (a browsable grid needs real leap-month math; _almSwitchSystem guards it).
    var clickable = sys !== 'chinese';
    html += '<div class="alm-crossref-row' + isActive + '"' +
      (clickable ? ' onclick="_almSwitchSystem(\'' + sys + '\')"' : ' style="cursor:default"') + '>' +
      '<span class="alm-crossref-label">' + _calLabel(sys) + '</span>' +
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

// ── Date/time editor (Option A) ──
// Tap the header date/time to reveal steppers for the date and a slider for the
// time of day. Setting a specific instant drives the whole panel — the moon,
// the sky scene, sunrise/sunset, the star chart — so the almanac becomes a
// little time machine you can point at any moment.

function _almFocusOrNow() { return _almFocus ? new Date(_almFocus.getTime()) : new Date(); }
var _almDeRaf = 0;

function _almToggleDateEdit() {
  var el = document.getElementById('almanac-dateedit');
  if (!el) return;
  if (el.style.display === 'block') { _almCloseDateEdit(); return; }
  el.innerHTML = _almDateEditHtml();
  el.style.display = 'block';
  _almDateEditRefresh();
  // Defer so the opening click itself doesn't immediately count as "outside".
  setTimeout(function () { document.addEventListener('mousedown', _almDateEditOutside, true); }, 0);
}

function _almCloseDateEdit() {
  var el = document.getElementById('almanac-dateedit');
  if (el) el.style.display = 'none';
  document.removeEventListener('mousedown', _almDateEditOutside, true);
}

function _almDateEditOutside(e) {
  var el = document.getElementById('almanac-dateedit');
  var head = document.getElementById('almanac-head');
  // The header owns the toggle; ignore clicks there so it can close cleanly.
  if (el && !el.contains(e.target) && head && !head.contains(e.target)) _almCloseDateEdit();
}

function _almDateEditHtml() {
  function field(id, cap) {
    return '<div class="alm-de-field">' +
      '<button class="alm-de-step" onclick="_almDeStep(\'' + id + '\',-1)" aria-label="−">−</button>' +
      '<span class="alm-de-val" id="alm-de-' + id + '"></span>' +
      '<button class="alm-de-step" onclick="_almDeStep(\'' + id + '\',1)" aria-label="+">+</button>' +
      '<div class="alm-de-cap">' + cap + '</div>' +
      '</div>';
  }
  var h = '<div class="alm-de-panel">';
  h += '<div class="alm-de-row alm-de-date">' +
    field('month', t('alm_de_month')) + field('day', t('alm_de_day')) + field('year', t('alm_de_year')) +
    '</div>';
  h += '<div class="alm-de-row alm-de-time">' +
    '<span class="alm-de-clock" id="alm-de-clock"></span>' +
    '<input type="range" id="alm-de-slider" min="0" max="1439" step="1" value="0"' +
    ' class="orrery-slider alm-de-slider" aria-label="' + _almEsc(t('alm_de_time')) + '"' +
    ' oninput="_almDeSlide(this.value)" onchange="_almDeSlideCommit(this.value)" />' +
    '</div>';
  h += '<div class="alm-de-row alm-de-foot">' +
    '<span class="alm-de-note" id="alm-de-note"></span>' +
    '<button class="alm-de-now orrery-ctrl-btn" onclick="_almDeNow()">' + t('alm_now') + '</button>' +
    '</div>';
  h += '</div>';
  return h;
}

// Update the editor's displayed values without rebuilding it (textContent only,
// so a slider mid-drag is never torn out from under the pointer).
function _almDateEditRefresh() {
  var el = document.getElementById('almanac-dateedit');
  if (!el || el.style.display !== 'block') return;
  var f = _almFocusOrNow();
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var set = function (id, val) { var n = document.getElementById(id); if (n) n.textContent = val; };
  set('alm-de-month', f.toLocaleDateString(lang, { month: 'short' }));
  set('alm-de-day', f.getDate());
  set('alm-de-year', f.getFullYear());
  set('alm-de-clock', f.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }));
  var sl = document.getElementById('alm-de-slider');
  if (sl && document.activeElement !== sl) sl.value = f.getHours() * 60 + f.getMinutes();
  // Astronomy degrades far from the present; say so quietly rather than hiding it.
  set('alm-de-note', Math.abs(f.getFullYear() - new Date().getFullYear()) > 3000 ? t('alm_de_far') : '');
}

// Commit a new focused instant: mirror it to the calendar grid and repaint
// every panel that describes a moment. Shared by every editor control.
function _almSetFocusInstant(d) {
  _almFocus = d;
  var jdn = _gregorianToJDN(d.getFullYear(), d.getMonth() + 1, d.getDate());
  _almSelectedJDN = jdn;
  var cal = _jdnToCalendar(_almSystem, jdn);
  _almYear = cal.year;
  _almMonth = cal.month;
  _drawAlmanacGrid();
  _almRepaintFocus();
  _almDateEditRefresh();
}

function _almDeStep(part, dir) {
  var f = _almFocusOrNow();
  if (part === 'year') {
    f.setFullYear(f.getFullYear() + dir);
  } else if (part === 'month') {
    var day = f.getDate();
    f.setDate(1);                       // avoid roll-over (Jan 31 → Mar 3)
    f.setMonth(f.getMonth() + dir);
    var maxD = new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate();
    f.setDate(Math.min(day, maxD));
  } else { // day
    f.setDate(f.getDate() + dir);
  }
  _almSetFocusInstant(f);
}

// Slider drag: keep the clock label live on every event (cheap), and throttle
// the heavy full-panel repaint to one per animation frame so scrubbing stays
// smooth on the canvas-heavy scenes.
function _almDeSlide(v) {
  var mins = parseInt(v, 10) || 0;
  var f = _almFocusOrNow();
  f.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  _almFocus = f;                        // time touched → always an explicit focus
  var lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
  var clk = document.getElementById('alm-de-clock');
  if (clk) clk.textContent = f.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
  if (!_almDeRaf) {
    _almDeRaf = requestAnimationFrame(function () { _almDeRaf = 0; _almRepaintFocus(); });
  }
}

function _almDeSlideCommit(v) {
  if (_almDeRaf) { cancelAnimationFrame(_almDeRaf); _almDeRaf = 0; }
  _almDeSlide(v);
  _almRepaintFocus();
}

function _almDeNow() {
  _almBackToToday();          // full snap-to-present, shared with the header reset
  _almDateEditRefresh();      // …then re-sync the editor's own controls
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
  if (sys === 'chinese') return 29 + (month % 2 === 1 ? 1 : 0); // alternating 30/29
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
  if (sys === 'chinese') return _CHINESE_MONTHS[month - 1] || t('alm_month_n', { n: month });
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
    '<div class="almanac-info-lbl">' + t('alm_dt_tilt') + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_tilt_desc', { trend: tiltDir, impact: seasonImpact, pct: tiltInCycle }) + '</div></div>';

  // North Star
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + polarisDist + '\u00b0 ' + t('alm_from_true_north') + '</div>' +
    '<div class="almanac-info-lbl">' + t('alm_dt_polaris') + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_polaris_desc', { years: (14000 - now.getFullYear()).toLocaleString() }) + '</div></div>';

  // Day getting longer
  var totalExcessMs = (daySeconds - 86400) * 1000;
  var dayStr = totalExcessMs > 1 ? '+' + totalExcessMs.toFixed(1) + 'ms ' + t('alm_over_24h') :
               totalExcessMs > 0.01 ? '+' + (totalExcessMs * 1000).toFixed(0) + '\u00b5s ' + t('alm_over_24h') :
               '~24h';
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + dayStr + '</div>' +
    '<div class="almanac-info-lbl">' + t('alm_dt_daylen') + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_daylen_desc', { ms: excessMs.toFixed(1) }) + '</div></div>';

  // Orbital eccentricity
  var eccTrendStr = parseFloat(earthEcc) < eccPrev ? t('alm_decreasing') : t('alm_increasing');
  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + earthEcc + '</div>' +
    '<div class="almanac-info-lbl">' + t('alm_dt_orbit') + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_orbit_desc', { trend: eccTrendStr }) + '</div></div>';

  // Julian Date
  html += '<div class="almanac-info-item"><div class="almanac-info-val">JD ' + julianDate + '</div>' +
    '<div class="almanac-info-lbl">' + t('alm_dt_julian') + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px">' +
    t('alm_dt_julian_desc') + '</div></div>';

  // Galactic Year
  var galacticPeriod = 225;
  var sunAge = 4600 + (now.getFullYear() - 2000) / 1e6;
  var orbitsCompleted = Math.floor(sunAge / galacticPeriod);
  var currentOrbitPct = ((sunAge % galacticPeriod) / galacticPeriod * 100).toFixed(1);

  html += '<div class="almanac-info-item"><div class="almanac-info-val">' + t('alm_galactic_orbit', { pct: currentOrbitPct, n: orbitsCompleted + 1 }) + '</div>' +
    '<div class="almanac-info-lbl">' + t('alm_dt_galactic') + '</div>' +
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

  // Inscription pills (top row)
  var html = '<div class="rosetta-pills">';
  for (var si = 0; si < manifest.length; si++) {
    var cls = si === _rosettaTextIdx ? 'pill active' : 'pill';
    html += '<button class="' + cls + '" onclick="_selectRosettaText(' + si + ')">' + _rf(manifest[si], 'title') + '</button>';
  }
  html += '</div>';

  // Metadata
  html += '<div class="rosetta-meta">' + _rf(entry, 'date') + ' \u00b7 ' + _rf(entry, 'place') + ' \u00b7 ' + _rf(entry, 'medium') + '</div>';
  html += '<div class="rosetta-context">' + _rf(entry, 'context') + '</div>';

  // Language pills (bottom row) — show language names in current UI language
  html += '<div class="rosetta-pills">';
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
  html += '</div>';

  // Text block(s) — one or two-up comparison
  var twoUp = _rosettaLangs.length === 2;
  if (twoUp) html += '<div class="rosetta-compare">';
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

  // Golden Record image gallery (only when that inscription is selected)
  if (entry.id === 'golden-record') {
    html += _renderGoldenRecordGallery();
  }

  el.innerHTML = html;
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

function _selectRosettaText(idx) {
  _rosettaTextIdx = idx;
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
  _renderRosettaStone(new Date());
}

// Scroll to Messages Across Time and select Golden Record (called from Voyager card)
async function _scrollToGoldenRecord() {
  var manifest = _rosettaManifest || [];
  for (var i = 0; i < manifest.length; i++) {
    if (manifest[i].id === 'golden-record') { _rosettaTextIdx = i; break; }
  }
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
    _initSkyScene(new Date(), loc.lat, loc.lon);
  }, 200);
});
