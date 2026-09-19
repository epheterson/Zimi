// Zimi Maps as its own surface. Eric chose it over a home-page map and a
// search scope: "/#maps full screen with the picker and one search box
// across installed maps, entered from a Maps tile that sits with the
// sources grid like a source does."
//
// Run: node tests/test_maps_surface.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.css'), 'utf8');
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
const escf = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── the tile ─────────────────────────────────────────────────────────────
const ctx = {
  zimsCache: [
    { name: 'osm-hawaii', title: 'Hawaii', kind: 'map', main_path: 'index.html' },
    { name: 'samoa', title: 'Samoa', kind: 'map', main_path: 'index.html' },
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main' },
  ],
  esc: escf, t: k => ({ cat_maps: 'Maps' })[k] || k, _getLibraryView: () => 'list',
};
vm.createContext(ctx);
vm.runInContext([
  extract(/var _MAPS_PIN_SVG = [^\n]*\n/, '_MAPS_PIN_SVG'),
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _mapsTileHtml\(\) \{[\s\S]*?\n\}/, '_mapsTileHtml'),
].join('\n'), ctx);
const tile = ctx._mapsTileHtml();
ok('a stat-card like any source, first, named Maps, listing the maps', /class="stats-grid maps-grid"><a class="stat-card maps-tile" href="#maps"/.test(tile) && /<span class="zt">Maps<\/span>/.test(tile) && /Hawaii · Samoa/.test(tile));
ok('it opens the door', /onclick="return _spaNav\(event, openMaps\)"/.test(tile));
ctx.zimsCache = ctx.zimsCache.filter(z => z.kind !== 'map');
ok('no map installed, no tile', ctx._mapsTileHtml() === '');
ok('the tile sits before favorites on the plain home only', /if \(!homeScope && !filter && !homeRecentFilter && !homeLangFilter\.size\) \{\n\s*h \+= _mapsTileHtml\(\);/.test(src.replace(/\r\n/g, '\n')));

// ── the one box ──────────────────────────────────────────────────────────
const input = extract(/q\.addEventListener\('input', \(\) => \{[\s\S]*?\n\}\);/, 'input handler');
ok('typing on a map page finds places, not articles or history', /if \(val && val\.length >= 1 && _isMapPage\(\)\) \{[\s\S]*fetchPlaces\(val\)/.test(input) && !/_isMapPage\(\)\) \{[\s\S]*showHistoryDropdown\(val\)[\s\S]*\} else if/.test(input.split('} else if')[0]));
const fp = extract(/async function fetchPlaces\(query\) \{[\s\S]*?\n\}/, 'fetchPlaces');
ok('it asks /places and makes suggest rows that carry the place', /fetch\('\/places\?q=' \+ encodeURIComponent\(query\)/.test(fp) && /_place: true, zim: g\.zim, path: g\.main_path, title: p\.name/.test(fp) && /pos: 'map=' \+ \(p\.zoom \|\| 15\) \+ '\/' \+ p\.lat \+ '\/' \+ p\.lng/.test(fp));
ok('picking a row opens the place where it is', /openArticle\(s\.zim, s\.path, s\.title, s\.pos \? \{pos: s\.pos\} : undefined\)/.test(src));
const keys = extract(/q\.addEventListener\('keydown', e => \{[\s\S]*?\n\}\);/, 'keydown');
ok('Enter on a map takes the first place', /if \(_isMapPage\(\)\) \{\s*\r?\n\s*if \(suggestItems\.length && suggestItems\[0\]\._place\) selectSuggest\(0\);/.test(keys));
ok('the box says what it is for', /_isMapPage\(\)\) \{\n\s*q\.placeholder = t\('maps_search_placeholder'\)/.test(src.replace(/\r\n/g, '\n')));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  if (!d.maps_search_placeholder) ok('maps_search_placeholder in ' + lang, false);
}

// ── the identity ─────────────────────────────────────────────────────────
ok('the breadcrumb on a map page is Maps, linking to the door', /_isMapPage\(\)\) \{[\s\S]*?bcIcon\.title = t\('cat_maps'\);[\s\S]*?bcIcon\.setAttribute\('href', '\/#maps'\)/.test(src));
ok('a place row is marked as one', /\.suggest-item\.sg-place \.sg-title::before/.test(css));

process.exit(failures ? 1 : 0);
