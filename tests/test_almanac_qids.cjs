// The Almanac's closed set of deep links (zimi/static/almanac-links.js): every
// named thing the Almanac shows that has a Wikipedia article is a key in it, and a
// new row in any list below that is not fails here.
//
//   1. The map: every Q-ID well formed; one article per Q-ID and one Q-ID per
//      article; every entry names its article. (Whether each Q-ID is the article
//      it says is the network's to say: scripts/verify_almanac_qids.py.)
//   2. Coverage, surface by surface, from the data the Almanac draws on:
//        the Nautical Almanac's 58 stars and the Pleiades, the sky's named stars,
//        the world-clock cities, every "on this day" event (and its subject
//        phrase in its text), the meteor showers and their parent comets and
//        radiant constellations, the planets, probes, belts, zodiac animals and
//        calendar systems, the constants pages' rows and their sources, the
//        feasts a calendar page prints, the principal phases.
//      A row that cannot link is listed here with the reason.
//   3. Closed means closed: a key with no resolved Q-ID renders as its plain
//      text, an unresolved Q-ID likewise; only a resolved one is a link.
//
// The holidays the calendar can print are checked in a browser
// (tests/test_almanac_qids_browser.py), where the calendar can be run.
//
// Run: node tests/test_almanac_qids.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) { console.error('FAIL: ' + label + (detail ? '\n      ' + detail : '')); failures++; } else console.log('ok: ' + label);
};
function grab(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error('could not find ' + what);
  return m[0];
}

// ── The map ─────────────────────────────────────────────────────────────
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext('var window = this; ' + read('almanac-links.js'), ctx);
const L = ctx.window.AlmanacLinks, MAP = L.MAP;
const keys = Object.keys(MAP);
const QID = /^Q[1-9]\d*$/;
check(keys.length > 900, 'the map holds ' + keys.length + ' entries');
check(keys.every((k) => QID.test(MAP[k].q)), 'every Q-ID is well formed');
check(keys.every((k) => typeof MAP[k].en === 'string' && MAP[k].en.length > 0), 'every entry names its article');
const byQ = {}, byEn = {};
keys.forEach((k) => { (byQ[MAP[k].q] = byQ[MAP[k].q] || new Set()).add(MAP[k].en); (byEn[MAP[k].en] = byEn[MAP[k].en] || new Set()).add(MAP[k].q); });
const manyTitles = Object.keys(byQ).filter((q) => byQ[q].size > 1).map((q) => q + ': ' + [...byQ[q]].join(' | '));
const manyQs = Object.keys(byEn).filter((e) => byEn[e].size > 1).map((e) => e + ': ' + [...byEn[e]].join(' | '));
check(manyTitles.length === 0, 'one article per Q-ID', manyTitles.join('; '));
check(manyQs.length === 0, 'one Q-ID per article', manyQs.join('; '));
check(Object.keys(byQ).length <= 800, 'the batch stays small enough for four requests (' + Object.keys(byQ).length + ' Q-IDs)');
const covered = (key) => !!MAP[key];
function allCovered(label, items, keyOf, plain) {
  const missing = [];
  items.forEach((x) => { const k = keyOf(x); if (!covered(k) && !(plain && plain[x])) missing.push(String(x) + ' (' + k + ')'); });
  check(missing.length === 0, label + ' (' + items.length + ')', missing.join(', '));
}

// ── Stars ───────────────────────────────────────────────────────────────
const almSrc = read('almanac.js'), skySrc = read('almanac-sky.js');
const starKey = (name) => 'star:' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
check(grab(almSrc, /function _almStarKey\(name\) \{[^\n]+\}/, '_almStarKey').indexOf("replace(/^_|_$/g, '')") > 0, 'the star-key rule in the page is the rule this test applies');
const navCtx = {}; vm.createContext(navCtx);
vm.runInContext(grab(read('almanac-navdata.js'), /var AR_NAV_STARS = \[[\s\S]*?\n\];/, 'AR_NAV_STARS'), navCtx);
const navNames = navCtx.AR_NAV_STARS.map((s) => s[1]);
allCovered('every Nautical Almanac star links', navNames, starKey);
allCovered('the star calendar\'s Pleiades links', ['Pleiades'], starKey);
const skyCtx = {}; vm.createContext(skyCtx);
vm.runInContext(grab(skySrc, /var _STAR_NAMES = \{[\s\S]*?\n\};/, '_STAR_NAMES') + grab(skySrc, /var _STAR_LINK_OVERRIDES = [^\n]+/, 'overrides'), skyCtx);
const skyNames = Object.values(skyCtx._STAR_NAMES);
allCovered('every named star in the sky links', skyNames, (n) => skyCtx._STAR_LINK_OVERRIDES[n] || starKey(n));

// ── Cities, events, showers and the fixed lists ─────────────────────────
const alm = {}; vm.createContext(alm);
vm.runInContext(grab(almSrc, /var _TZ_CITIES = \[[\s\S]*?\n\];/, '_TZ_CITIES') + grab(almSrc, /var _ON_THIS_DAY = \{[\s\S]*?\n\};/, '_ON_THIS_DAY') +
  grab(almSrc, /var _METEOR_SHOWERS = \[[\s\S]*?\n\];/, '_METEOR_SHOWERS') + grab(almSrc, /var _CONST_KEYS = \{[^\n]+\};/, '_CONST_KEYS') +
  grab(almSrc, /var _CAL_SYSTEMS = \[[^\]]+\];/, '_CAL_SYSTEMS'), alm);
allCovered('every world-clock city links', alm._TZ_CITIES, (c) => 'city:' + c.key);
const events = [];
Object.keys(alm._ON_THIS_DAY).forEach((d) => alm._ON_THIS_DAY[d].forEach((e) => events.push(Object.assign({ d: d }, e))));
check(events.length >= 98, events.length + ' "on this day" events');
const noSubject = events.filter((e) => !e.w || !MAP[e.w] || !MAP[e.w].sub || e.t.indexOf(MAP[e.w].sub) < 0).map((e) => e.d + ' ' + e.t.slice(0, 40));
check(noSubject.length === 0, 'every "on this day" event links its subject, found in its text', noSubject.join('; '));
allCovered('every meteor shower links', alm._METEOR_SHOWERS, (s) => 'shower:' + s.key);
allCovered('every shower\'s parent body links', alm._METEOR_SHOWERS, (s) => 'parent:' + s.key);
const radiants = [...new Set(alm._METEOR_SHOWERS.map((s) => s.radiant))];
allCovered('every shower\'s radiant constellation links', radiants, (r) => 'const:' + alm._CONST_KEYS[r]);
allCovered('every calendar system links', alm._CAL_SYSTEMS, (s) => 'cal:' + s);
const ref = read('almanac-reference.js');
const refCtx = {}; vm.createContext(refCtx);
vm.runInContext(grab(ref, /var AR_CAL_SYSTEMS = \[[^\]]+\];/, 'AR_CAL_SYSTEMS') + grab(ref, /var AR_HOLIDAY_COLS = \[[^\]]+\];/, 'AR_HOLIDAY_COLS'), refCtx);
allCovered('every calendar the tables print links', refCtx.AR_CAL_SYSTEMS, (s) => 'cal:' + s);
allCovered('the orrery\'s planets link', ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'sun', 'moon'], (p) => 'planet:' + p);
allCovered('the Chinese zodiac links', ['rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake', 'horse', 'goat', 'monkey', 'rooster', 'dog', 'pig'], (z) => 'zodiac:' + z);

// ── The tables ──────────────────────────────────────────────────────────
const tbSrc = read('almanac-tables.js');
const tb = {}; vm.createContext(tb);
vm.runInContext(['TB_CONST_LINKS', 'TB_SOURCE_LINKS', 'TB_FEAST_LINKS'].map((n) => grab(tbSrc, new RegExp('var ' + n + ' = \\{[\\s\\S]*?\\n\\};'), n)).join('\n') +
  grab(tbSrc, /var TB_PHASE_LINKS = \[[^\]]+\];/, 'TB_PHASE_LINKS'), tb);
check(refCtx.AR_HOLIDAY_COLS.every((k) => tb.TB_FEAST_LINKS[k] && covered(tb.TB_FEAST_LINKS[k])), 'every feast a calendar page prints links its article');
check(tb.TB_PHASE_LINKS.length === 4 && tb.TB_PHASE_LINKS.every(covered), 'the four principal phases link');
check(Object.values(tb.TB_CONST_LINKS).every(covered), 'every constant\'s article is in the map');
check(Object.values(tb.TB_SOURCE_LINKS).every(covered), 'every cited source is in the map');
// The constants pages: every row's key is linked or listed, with the reason.
const PLAIN_ROWS = {
  day: 'a day is the plain unit the next rows are counted in',
  julian_century: 'no article of its own (a hundred Julian years)',
  moon_k: 'a ratio of two radii, not a named thing',
  light_au: 'a sum of two things (light, the AU), not one article',
  zero_c: 'a conversion of one scale into another'
};
const rowsSrc = grab(tbSrc, /var TB_CONST_ROWS = \{[\s\S]*?\n\};/, 'TB_CONST_ROWS');
const rowKeys = [...rowsSrc.matchAll(/^\s+\['([a-z0-9_]+)', /gm)].map((m) => m[1]);
check(rowKeys.length >= 50, rowKeys.length + ' constants rows read');
const loose = rowKeys.filter((k) => !tb.TB_CONST_LINKS[k] && !PLAIN_ROWS[k]);
check(loose.length === 0, 'every constants row links or is listed as plain', loose.join(', '));
check(Object.keys(PLAIN_ROWS).every((k) => rowKeys.indexOf(k) >= 0 && !tb.TB_CONST_LINKS[k]), 'and the plain list holds nothing that links or is gone');
// Sources the rows cite: every named body is linked.
const cited = new Set();
[...rowsSrc.matchAll(/, '([^']+)'\],?\s*$/gm)].forEach((m) => m[1].split(/[ ,·]+/).forEach((w) => { if (/^[A-Z]{3,}\d*$/.test(w)) cited.add(w); }));
const unlinkedSources = [...cited].filter((w) => !tb.TB_SOURCE_LINKS[w]);
check(unlinkedSources.length === 0, 'every body the Source column cites links (' + [...cited].join(', ') + ')', unlinkedSources.join(', '));

// ── Closed means closed ─────────────────────────────────────────────────
// Nothing resolved: every wrapper returns the plain text it was given. Then one
// entity resolved: it, and only it, becomes a link.
check(L.wrap('planet:mars', 'Mars') === 'Mars' && L.wrap('term:tide', 'Tide') === 'Tide', 'unresolved, a wrapped name is plain text');
check(L.wrap('star:no_such_star', 'Nowhere') === 'Nowhere' && L.wrap('', 'x') === 'x', 'a key not in the map is plain text');
check(L.wrapHoliday('Easter', 'Easter') === 'Easter' && L.wrapHoliday('Independence Day', 'Independence Day', 'IN') === 'Independence Day', 'unresolved, a holiday is plain text');
check(L.linkifyEvent('Mir is guided down.', 'ev:mir') === 'Mir is guided down.', 'unresolved, an event is plain text');
check(L.linkFor('planet:mars') === null, 'and linkFor says so');
// A regional label resolves to its own country's article, not the first one's.
check(MAP['holiday:independenceday_in'].q !== MAP['holiday:independenceday_us'].q && MAP['holiday:independenceday_in'].q !== MAP['holiday:independenceday'].q,
  'India\'s Independence Day is not the United States\'');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
