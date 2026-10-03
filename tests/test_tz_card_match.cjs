// The world clock is the reader's own clocks (almanac.js _almClockCards).
//
// It shows the chosen place's zone (named for the place), this device's zone
// when it differs, and the clocks the reader added from the curated cities,
// one card each, west to east by their offset at the instant. Every place the
// map can pick shows its own card, the fractional zones too (Eucla +8:45,
// Chatham +12:45: a zone that matched no curated card used to leave every
// card dark, and the click read as a no-op). A stored list that is not zone
// names is ignored, never written into the page.
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
const { _almTzForLocation, _almClockCards, _almTzCardLabel, _TZ_CITIES, _MAP_CITIES } = sandbox;

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok: ' + name); return; }
  failed++;
  console.log('  FAIL: ' + name + (detail ? '\n        ' + detail : ''));
}
const JAN = new Date(Date.UTC(2026, 0, 15, 12));
const tzs = (cards) => cards.map((c) => c.tz).join(',');

// --- 1. a place, the device, nothing added ---------------------------------
sandbox.__loc = { name: 'Eucla, Western Australia, Australia', lat: -31.68, lon: 128.89, stored: true };
sandbox.__home = 'Australia/Eucla';
sandbox.__device = 'America/Los_Angeles';
let cards = _almClockCards('Australia/Eucla', JAN);
check('the place and the device, west to east', tzs(cards) === 'America/Los_Angeles,Australia/Eucla', tzs(cards));
check('the place\'s card is named for the place', cards[1].label === 'Eucla', cards[1].label);
check('a curated zone is named for its city', cards[0].label === 'alm_city_los_angeles', cards[0].label);

// --- 2. every map dot gets a card of its own -------------------------------
let missing = [];
for (const c of _MAP_CITIES) {
  const zone = _almTzForLocation(c.lat, c.lon);
  sandbox.__home = zone;
  if (!_almClockCards(zone, JAN).some((k) => k.tz === zone)) missing.push(c.name);
}
check('every place the map can pick shows its own clock', missing.length === 0, missing.join(', '));

// --- 3. added clocks, deduplicated, in offset order ------------------------
sandbox.__home = 'America/Los_Angeles';
store.zimi_almanac_clocks = JSON.stringify(['Asia/Tokyo', 'Europe/London', 'America/Los_Angeles', 'Pacific/Chatham']);
cards = _almClockCards('America/Los_Angeles', JAN);
check('added clocks join, one card per zone', tzs(cards) === 'America/Los_Angeles,Europe/London,Asia/Tokyo,Pacific/Chatham', tzs(cards));
check('only the added ones can be taken away', cards.filter((c) => c.added).length === 3);
const offs = cards.map((c) => c.off);
check('west to east', offs.every((o, i) => i === 0 || offs[i - 1] <= o), offs.join(','));

// --- 4. a stored list that is not zone names is ignored --------------------
store.zimi_almanac_clocks = JSON.stringify(["Asia/Tokyo", "x');alert(1);('", 42, 'Europe/Paris']);
cards = _almClockCards('America/Los_Angeles', JAN);
check('anything but a zone name is dropped', tzs(cards) === 'America/Los_Angeles,Europe/Paris,Asia/Tokyo', tzs(cards));
store.zimi_almanac_clocks = '{not json';
check('an unreadable list is no list', _almClockCards('America/Los_Angeles', JAN).length === 1);

// --- 5. the card for an unnamed place --------------------------------------
sandbox.__loc = { name: '', lat: -43.95, lon: -176.56, stored: true };
check('an unnamed pick falls back to the zone\'s own city', _almTzCardLabel('Pacific/Chatham') === 'Chatham');
check('and underscores in a zone name become spaces', _almTzCardLabel('Australia/Lord_Howe') === 'Lord Howe');

console.log('');
if (failed) { console.log(failed + ' clock check(s) failed'); process.exit(1); }
console.log('all clock checks passed (' + _TZ_CITIES.length + ' cities to add, ' + _MAP_CITIES.length + ' map dots)');
