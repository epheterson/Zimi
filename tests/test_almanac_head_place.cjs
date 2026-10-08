// The Almanac's header clock (almanac.js _almClockParts, _almHeadHtml's time
// line) and the way back to the device's own place (_almHereBtnHtml).
//
//   - With no place chosen, the big date and time are the device's, with no
//     place hint.
//   - With a place in another zone chosen (India, from California), they are
//     that place's local date and time, and the hint names it:
//     "3:09 PM · GMT+5:30 · Mumbai".
//   - A chosen place in the device's own zone changes nothing in the header.
//   - "Where I am" is one function's markup, used by the map's place line, the
//     header hint and the invitation shown when no place is set, and it calls
//     the geolocation action.
//
// Run: node tests/test_almanac_head_place.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label);
  return m[0];
}
const pieces = [
  extract(/var _tzFmtCache = [^;]+;/, '_tzFmtCache'),
  extract(/function _tzFmt\(tz, opts, lang\)\s*\{[\s\S]*?\n\}/, '_tzFmt'),
  extract(/var _formatTzCache = [^;]+;/, '_formatTzCache'),
  extract(/function _formatTimezone\(lang, tz, at\)\s*\{[\s\S]*?\n\}/, '_formatTimezone'),
  extract(/function _almEraOpts\(d, opts\)\s*\{[\s\S]*?\n\}/, '_almEraOpts'),
  extract(/function _almIsToday\(d\)\s*\{[\s\S]*?\n\}/, '_almIsToday'),
  extract(/function _almClockParts\(focus\)\s*\{[\s\S]*?\n\}/, '_almClockParts'),
  extract(/var ALM_LOCATE_SVG = [^\n]+\n/, 'ALM_LOCATE_SVG'),
  extract(/function _almHereBtnHtml\(cls\)\s*\{[\s\S]*?\n\}/, '_almHereBtnHtml'),
];
const sandbox = { Intl, Date, Math, String, JSON, Object, Array, _currentLang: 'en', t: (k) => k, _almEsc: (x) => String(x) };
sandbox._getLocation = () => sandbox.__loc;
sandbox._almDeviceTz = () => 'America/Los_Angeles';
sandbox._almDisplayTz = (loc) => (loc.stored ? sandbox.__placeTz : 'America/Los_Angeles');
vm.createContext(sandbox);
vm.runInContext(pieces.join('\n'), sandbox);

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('ok: ' + name); return; }
  failed++;
  console.log('FAIL: ' + name + (detail ? '\n      ' + detail : ''));
}

// 2026-01-15 09:39:00 UTC: 01:39 AM in Los Angeles, 3:09 PM in Mumbai.
const when = new Date(Date.UTC(2026, 0, 15, 9, 39));

sandbox.__loc = { lat: 34, lon: -118, name: '', stored: false };
let cp = sandbox._almClockParts(when);
check('no place chosen: the device\'s time', cp.time === '1:39 AM' && cp.place === '', cp.time + ' / ' + cp.place);

sandbox.__loc = { lat: 19.07, lon: 72.88, name: 'Mumbai, Maharashtra, India', stored: true };
sandbox.__placeTz = 'Asia/Kolkata';
cp = sandbox._almClockParts(when);
check('a place in India: its local time', cp.time === '3:09 PM', cp.time);
check('and its date (the 15th there, the 15th here)', /January 15, 2026/.test(cp.date), cp.date);
check('with its zone and its name as the hint', cp.tz === 'GMT+5:30' && cp.place === 'Mumbai', cp.tz + ' / ' + cp.place);

// Across midnight: 20:00 in Los Angeles on the 14th is the 15th in India.
const eve = new Date(Date.UTC(2026, 0, 15, 4, 0));
cp = sandbox._almClockParts(eve);
check('the place\'s date moves with its clock', /January 15, 2026/.test(cp.date) && cp.time === '9:30 AM', cp.date + ' ' + cp.time);

sandbox.__loc = { lat: 47.61, lon: -122.33, name: 'Seattle, Washington, United States', stored: true };
sandbox.__placeTz = 'America/Los_Angeles';
cp = sandbox._almClockParts(when);
check('a place in the device\'s own zone: the header is unchanged', cp.time === '1:39 AM' && cp.place === '', cp.time + ' / ' + cp.place);

const btn = sandbox._almHereBtnHtml('alm-head-here');
check('"Where I am" is the geolocation action, labelled', /onclick="_shareAlmanacLocation\(\)"/.test(btn) && /alm_place_here/.test(btn) && /aria-label/.test(btn) && /alm-head-here/.test(btn), btn);

// Every place it is wanted uses that one function.
const uses = (src.match(/_almHereBtnHtml\(/g) || []).length;
check('the map\'s place line, the header hint and the invitation share it (' + uses + ' uses, one definition)',
  uses === 4 && !/title="' \+ t\('alm_use_location'\) \+ '">\\uD83D\\uDCCD/.test(src));
check('the header shows it with the hint', /cp\.place \? [^\n]*_almHereBtnHtml\('alm-head-here'\)/.test(src));

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
