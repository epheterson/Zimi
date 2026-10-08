// The world clock is the reader's own clocks (almanac.js _almClockCards).
//
// It shows the whole curated world tour (every city in _TZ_CITIES), plus the
// chosen place's zone and this device's when no card keeps that offset (the
// fractional zones too: Eucla +8:45, Chatham +12:45), plus the clocks the
// reader added, one card each, west to east by their offset at the instant.
// A stored list that is not zone names is ignored, never written into the page.
//
// Pure-helper approach, like tests/test_almanac_tz_resolution.cjs: the tables
// and functions are pulled out of almanac.js by source markers and run in a
// sandbox, so this drives the shipped code and not a copy.
//
// Run: node tests/test_tz_card_match.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ALMANAC_JS = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');
const src = fs.readFileSync(ALMANAC_JS, 'utf8');

function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from almanac.js');
  return m[0];
}

const pieces = [
  extract(/var DEG_TO_RAD = [^;]+;/, 'DEG_TO_RAD'),
  extract(/var _TZ_ANCHORS = \[[\s\S]*?\n\];/, '_TZ_ANCHORS'),
  extract(/var _TZ_CITIES = \[[\s\S]*?\n\];/, '_TZ_CITIES'),
  extract(/var _MAP_CITIES = \[[\s\S]*?\n\];/, '_MAP_CITIES'),
  extract(/function _almTzForLocation\(lat, lon\)\s*\{[\s\S]*?\n\}/, '_almTzForLocation'),
  extract(/var _tzFmtCache = [^;]+;/, '_tzFmtCache'),
  extract(/function _tzFmt\(tz, opts, lang\)\s*\{[\s\S]*?\n\}/, '_tzFmt'),
  extract(/function _tzUtcOffsetMin\([\s\S]*?\n\}/, '_tzUtcOffsetMin'),
  extract(/function _almTzCardLabel\(tz\)\s*\{[\s\S]*?\n\}/, '_almTzCardLabel'),
  extract(/function _almTzSegment\(tz\) \{[^\n]+\n/, '_almTzSegment'),
  extract(/function _almTzCityLabel\(tz\)\s*\{[\s\S]*?\n\}/, '_almTzCityLabel'),
  extract(/var _ALM_CLOCKS_KEY = [^\n]+\n/, '_ALM_CLOCKS_KEY'),
  extract(/var ALM_TZ_NAME_RE = [^\n]+\n/, 'ALM_TZ_NAME_RE'),
  extract(/function _almClocks\(\)\s*\{[\s\S]*?\n\}/, '_almClocks'),
  extract(/function _almClockCards\(targetTz, now\)\s*\{[\s\S]*?\n\}/, '_almClockCards'),
  extract(/function _almClockLit\(cards, tz, now\)\s*\{[\s\S]*?\n\}/, '_almClockLit'),
];

const store = {};
const sandbox = {
  Intl, Date, Math, String, JSON, Object, Array,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  t: (k) => k,
};
sandbox._getLocation = () => sandbox.__loc;
sandbox._almDisplayTz = () => sandbox.__home;
sandbox._almDeviceTz = () => sandbox.__device;
vm.createContext(sandbox);
vm.runInContext(pieces.join('\n'), sandbox);
const { _almTzForLocation, _almClockCards, _almClockLit, _almTzCardLabel, _TZ_CITIES, _MAP_CITIES } = sandbox;

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok: ' + name); return; }
  failed++;
  console.log('  FAIL: ' + name + (detail ? '\n        ' + detail : ''));
}
const JAN = new Date(Date.UTC(2026, 0, 15, 12));
const tzs = (cards) => cards.map((c) => c.tz).join(',');

// --- 1. the world tour is always there -------------------------------------
sandbox.__loc = { name: 'Eucla, Western Australia, Australia', lat: -31.68, lon: 128.89, stored: true };
sandbox.__home = 'Australia/Eucla';
sandbox.__device = 'America/Los_Angeles';
let cards = _almClockCards('Australia/Eucla', JAN);
const has = (tz) => cards.some((c) => c.tz === tz);
check('every curated city has a card, nothing hidden behind Add a clock', _TZ_CITIES.every((c) => has(c.tz)), tzs(cards));
check('the place\'s own zone (+8:45, on no curated card) gets one too', has('Australia/Eucla') && cards.length === _TZ_CITIES.length + 1, cards.length);
check('the place\'s card is named for the place', cards.find((c) => c.tz === 'Australia/Eucla').label === 'Eucla');
check('a curated zone is named for its city', cards.find((c) => c.tz === 'America/Los_Angeles').label === 'alm_city_los_angeles');
check('none of them can be taken away', cards.every((c) => !c.added));
let offs = cards.map((c) => c.off);
check('west to east', offs.every((o, i) => i === 0 || offs[i - 1] <= o), offs.join(','));
sandbox.__loc = { name: 'Mumbai, India', lat: 19.07, lon: 72.88, stored: true };
sandbox.__home = 'Asia/Kolkata'; sandbox.__device = 'Asia/Kolkata';
cards = _almClockCards('Asia/Kolkata', JAN);
check('a curated place adds no card of its own', cards.length === _TZ_CITIES.length, cards.length);
check('and its card is named for the place', cards.find((c) => c.tz === 'Asia/Kolkata').label === 'Mumbai');

// --- 2. every map dot lights a card keeping its time -----------------------
let missing = [];
for (const c of _MAP_CITIES) {
  const zone = _almTzForLocation(c.lat, c.lon);
  sandbox.__home = zone;
  const cs = _almClockCards(zone, JAN), lit = _almClockLit(cs, zone, JAN);
  if (lit < 0 || cs[lit].off !== sandbox._tzUtcOffsetMin(zone, JAN)) missing.push(c.name);
}
check('every place the map can pick lights a clock keeping its time', missing.length === 0, missing.join(', '));

// --- 3. added clocks, deduplicated, in offset order ------------------------
sandbox.__home = 'America/Los_Angeles'; sandbox.__device = 'America/Los_Angeles';
store.zimi_almanac_clocks = JSON.stringify(['Asia/Tokyo', 'Europe/London', 'America/Los_Angeles', 'Pacific/Chatham']);
cards = _almClockCards('America/Los_Angeles', JAN);
check('added clocks join the tour, one card per zone', cards.length === _TZ_CITIES.length + 1 && has('Pacific/Chatham'), cards.length);
check('only the added one that is not already a city can be taken away', cards.filter((c) => c.added).map((c) => c.tz).join() === 'Pacific/Chatham');
offs = cards.map((c) => c.off);
check('west to east', offs.every((o, i) => i === 0 || offs[i - 1] <= o), offs.join(','));

// --- 4. a stored list that is not zone names is ignored --------------------
store.zimi_almanac_clocks = JSON.stringify(["Asia/Tokyo", "x');alert(1);('", 42, 'Europe/Paris']);
cards = _almClockCards('America/Los_Angeles', JAN);
check('anything but a zone name is dropped', cards.length === _TZ_CITIES.length && !cards.some((c) => /alert/.test(c.tz)));
store.zimi_almanac_clocks = '{not json';
check('an unreadable list is no list', _almClockCards('America/Los_Angeles', JAN).length === _TZ_CITIES.length);

// --- 5. the card for an unnamed place --------------------------------------
sandbox.__loc = { name: '', lat: -43.95, lon: -176.56, stored: true };
check('an unnamed pick falls back to the zone\'s own city', _almTzCardLabel('Pacific/Chatham') === 'Chatham');
check('and underscores in a zone name become spaces', _almTzCardLabel('Australia/Lord_Howe') === 'Lord Howe');

console.log('');
if (failed) { console.log(failed + ' clock check(s) failed'); process.exit(1); }
console.log('all clock checks passed (' + _TZ_CITIES.length + ' cities to add, ' + _MAP_CITIES.length + ' map dots)');
