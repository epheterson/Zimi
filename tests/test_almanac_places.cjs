// Go to by name in the Almanac's 3D view (zimi/static/almanac-earth.js): the towns the maps offer and the Earth's
// landmarks, merged and ranked; which article of the library is about a place.
//
//   1. A name meets what was typed as exact, prefix, word start or inside, accents and case aside; nothing else.
//   2. The two lists merge best match first, a landmark before a town at an equal match, the towns in the server's
//      order (largest first), one of a name and spot once, at most AE_PLACE_MAX rows. With no town (no map installed,
//      or offline) the landmarks alone.
//   3. The article for a place: the one that says it stands near it; not Paris, Texas's from Paris, France's page; with
//      none saying where, the first, unless another says it is elsewhere.
//
// Run: node tests/test_almanac_places.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-earth.js'), 'utf8');
let failures = 0;
function check(ok, label, extra) {
  if (!ok) { console.error('FAIL: ' + label + (extra ? ' ' + JSON.stringify(extra) : '')); failures++; }
  else console.log('ok: ' + label);
}
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces extracting ' + name);
}
function extractVar(name) {
  const m = new RegExp('^var ' + name + ' = [^;]*;', 'm').exec(src);
  if (!m) throw new Error('var ' + name + ' not found');
  return m[0];
}

const code = [
  'var _aeLm = null;',
  'function _aeRad(d) { return d * Math.PI / 180; }',
  'var AE_EARTH_RADIUS_KM = 6378.137;',
  ['AE_PLACE_MAX', 'AE_PLACE_ARTICLE_KM', 'AE_PLACE_MATCH', 'AE_PLACE_ACCENTS'].map(extractVar).join('\n'),
  ['_aePlaceNorm', '_aePlaceMatch', '_aePlaceLandmarks', '_aePlaceTown', '_aePlaceMerge', '_aePlaceKm', '_aePlaceBest'].map(extractFn).join('\n'),
  'this.api = { match: _aePlaceMatch, landmarks: _aePlaceLandmarks, merge: _aePlaceMerge, km: _aePlaceKm, best: _aePlaceBest, set: function (lm) { _aeLm = lm; }, max: AE_PLACE_MAX };',
].join('\n');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const A = ctx.api;

// ── 1. How a name meets what was typed ──
check(A.match('Everest', 'Mount Everest') === 2, 'a word of the name');
check(A.match('mount ev', 'Mount Everest') === 1, 'the start of the name, any case');
check(A.match('cologne', 'Cologne') === 0, 'the whole name');
check(A.match('köln', 'Koln') === 0, 'accents folded either way');
check(A.match('est', 'Mount Everest') === 3, 'inside a word');
check(A.match('xyz', 'Mount Everest') === -1, 'nothing in common');
check(A.match('', 'Mount Everest') === -1, 'nothing typed');

// ── 2. Merge and rank ──
A.set({ earth: [
  ['Mount Everest', 27.9881, 86.925, 'mons', 'Q513', 0, 5, 10218],
  ['Mont Blanc', 45.8326, 6.8652, 'mons', 'Q583', 0, 5, 114],
  ['Giza pyramids', 29.9792, 31.1342, 'wonder', 'Q12508', 0, 5, 88],
  ['Paris Landmark', 48.86, 2.34, 'wonder', 'Q1', 0, 5, 1],
] });
const towns = [
  { label: 'Paris, Île-de-France, France', name: 'Paris', lat: 48.857, lng: 2.352 },
  { label: 'Paris, Texas, United States', name: 'Paris', lat: 33.66, lng: -95.56 },
  { label: 'Parish, New York, United States', name: 'Parish', lat: 43.4, lng: -76.1 },
];
let got = A.merge('Paris', A.landmarks('Paris'), towns);
check(got.map((p) => p.label).join('|') === 'Paris, Île-de-France, France|Paris, Texas, United States|Paris Landmark|Parish, New York, United States',
  'an exact name first (the larger town first), then a name that starts so; a landmark before a town only at an equal match', got.map((p) => p.label));
got = A.merge('Everest', A.landmarks('Everest'), []);
check(got.length === 1 && got[0].kind === 'landmark' && got[0].qid === 'Q513', 'with no town, the landmark alone, with its Q-ID');
got = A.merge('Mo', A.landmarks('Mo'), []);
check(got.map((p) => p.name).join('|') === 'Mount Everest|Mont Blanc', 'landmarks that start so, in the file\'s order', got.map((p) => p.name));
check(A.merge('zzz', A.landmarks('zzz'), []).length === 0, 'nothing matches, nothing offered');
// A town reached through where it is ("Springfield, IL") ranks as a prefix match, not dropped.
got = A.merge('Springfield, IL', [], [{ label: 'Springfield, Illinois, United States', name: 'Springfield', lat: 39.8, lng: -89.6 }]);
check(got.length === 1 && got[0].match === 1, 'a town found through its region stands');
// The same town twice (two maps) once; two of a name far apart both.
got = A.merge('Paris', [], towns.concat([{ label: 'Paris, France', name: 'Paris', lat: 48.86, lng: 2.35 }]));
check(got.filter((p) => p.name === 'Paris').length === 2, 'the same place once, another place of the name as well', got.map((p) => p.label));
const many = [];
for (let i = 0; i < 20; i++) many.push({ label: 'Town' + i + ', X', name: 'Town' + i, lat: i, lng: i });
check(A.merge('Town', [], many).length === A.max, 'no more than AE_PLACE_MAX rows');

// ── 3. Which article is about the place ──
const paris = { lat: 48.857, lon: 2.352 }, texas = { lat: 33.66, lon: -95.56 };
const fr = { title: 'Paris', position: { lat: 48.8567, lng: 2.3508 } };
const tx = { title: 'Paris (Texas)', position: { lat: 33.66, lng: -95.55 } };
const bare = { title: 'Paris', position: null };
check(A.best(paris, [tx, fr]) === fr, 'the page that stands near the place, whatever its rank');
check(A.best(texas, [fr, tx]) === tx, 'Paris, Texas gets the Texas page');
check(A.best(texas, [fr]) === null, 'the only page is of a place far away: none');
check(A.best(paris, [bare]) === bare, 'a page that says nothing of where, with no other: the first');
check(A.best(paris, [bare, tx]) === null, 'a page that says nothing, beside one that is elsewhere: none');
check(Math.abs(A.km(paris, { lat: 48.857, lon: 3.352 }) - 73.3) < 1, 'a degree of longitude at 49 degrees north is 73 km');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
