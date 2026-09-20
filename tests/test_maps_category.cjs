// Map ZIMs get a catalog category of their own. Kiwix ships 193 maps_en_*
// ZIMs (Maps2ZIM) with an EMPTY category, so before this they all landed in
// "Other" beside 631 unrelated leftovers, and nobody browsing the catalog
// would learn Zimi can show a map at all. Two categorizers, one rule each:
// autoCategorize (catalog items) and categorizeZim (installed ZIMs, home
// page), plus the English-name bridge between them.
//
// The catalog half runs against the shipped snapshot when it is present, so
// the rule is checked on every real name, not three we made up.
//
// Run: node tests/test_maps_category.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext([
  extract(/function _catIcon\(paths\) \{[\s\S]*?\n\}/, '_catIcon'),
  extract(/const BROWSE_CATEGORIES = \[[\s\S]*?\n\];/, 'BROWSE_CATEGORIES'),
  extract(/const _OPDS_CAT_MAP = \{[\s\S]*?\n\};/, '_OPDS_CAT_MAP'),
  extract(/function autoCategorize\(item\) \{[\s\S]*?\n\}/, 'autoCategorize'),
  extract(/const _CAT_TO_BROWSE_KEY = \{[\s\S]*?\n\};/, '_CAT_TO_BROWSE_KEY'),
  extract(/function categorizeZim\(name\) \{[\s\S]*?\n\}/, 'categorizeZim'),
].join('\n').replace(/^const /gm, 'var '), ctx);

// The category exists and sits before the catch-all.
const keys = ctx.BROWSE_CATEGORIES.map(c => c.key);
ok('maps is a browse category', keys.includes('maps'));
ok('maps is listed before other', keys.indexOf('maps') < keys.indexOf('other'), keys.join(','));

// Catalog items: Kiwix names, and the two community map builders.
for (const name of ['maps_en_samoa', 'maps_en_all', 'maps', 'MAPS_EN_FIJI', 'streetzim_sf', 'atlaszim_world']) {
  ok('catalog ' + name + ' -> maps', ctx.autoCategorize({ name }) === 'maps', ctx.autoCategorize({ name }));
}
ok('a Kiwix category of "maps" wins outright', ctx.autoCategorize({ name: 'x', category: 'maps' }) === 'maps');
ok('openstreetmap-wiki is the wiki, not a map', ctx.autoCategorize({ name: 'openstreetmap-wiki_en_all' }) === 'wikipedia');
ok('a name merely containing "maps" is not a map', ctx.autoCategorize({ name: 'sitemaps_en' }) === 'other');

// Installed ZIMs: the home page groups by English name, then localizes.
ok('installed maps_en_samoa -> Maps', ctx.categorizeZim('maps_en_samoa') === 'Maps');
ok('the world map strips to the stem maps and still files', ctx.categorizeZim('maps') === 'Maps');
ok('Maps bridges to the maps browse key', ctx._CAT_TO_BROWSE_KEY['Maps'] === 'maps');
ok('installed wikipedia untouched', ctx.categorizeZim('wikipedia_en_all') === 'Wikimedia');

// Every real map in the shipped catalog, and nothing else from the empty bucket.
const snap = path.join(__dirname, '..', 'zimi', 'assets', 'catalog-snapshot.json.gz');
if (fs.existsSync(snap)) {
  const entries = JSON.parse(zlib.gunzipSync(fs.readFileSync(snap)).toString('utf8')).entries;
  const maps = entries.filter(e => /^maps_/i.test(e.name));
  const asMaps = entries.filter(e => ctx.autoCategorize(e) === 'maps');
  ok('snapshot has the Kiwix maps', maps.length > 100, String(maps.length));
  ok('every maps_* entry categorizes as maps', maps.every(e => ctx.autoCategorize(e) === 'maps'));
  ok('nothing else does', asMaps.length === maps.length, asMaps.length + ' vs ' + maps.length);
} else {
  console.log('SKIP  no snapshot in this checkout');
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
