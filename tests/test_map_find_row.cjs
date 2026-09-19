// The search bar offers to run the words in a map's own search box, for
// maps that have one. Kiwix's maps2zim indexes administrative divisions
// only ("Danville" lands in Québec; Danville, CA is not in it) and has no
// box; StreetZim's box searches towns, streets and addresses. Zimi cannot
// read StreetZim's hash-bucketed shards, so it hands the query to the box
// inside the same-origin frame instead.
//
// Run: node tests/test_map_find_row.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const ctx = {
  zimsCache: [
    { name: 'osm-hawaii', title: 'OSM - Hawaii', kind: 'map', main_path: 'index.html', map_search: true },
    { name: 'maps_en_all', title: 'World', kind: 'map', main_path: 'index.html' },  // no box
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main' },
  ],
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  escAttr: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  tH: (k, v) => k === 'find_on_map' ? 'Find “' + v.q + '” on ' + v.map : k,
  _sourceIconHtml: () => '<i></i>',
  _FEAT_SVG: { map: '<svg></svg>' },
  _articleDeepLinkPath: (z, p) => '/?a=' + encodeURIComponent(z + '/' + p),
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _mapFindRowsHtml\(query\) \{[\s\S]*?\n\}/, '_mapFindRowsHtml'),
].join('\n'), ctx);

const html = ctx._mapFindRowsHtml('Danville');
ok('one row per map with a search box', (html.match(/class="result map-find"/g) || []).length === 1, html.slice(0, 80));
ok('the row names the map and the words', /Find “Danville” on OSM - Hawaii/.test(html));
ok('the words ride along for the frame', /data-find="Danville"/.test(html));
ok('the row opens the map page', /data-zim="osm-hawaii" data-path="index.html"/.test(html));
ok('a map without a box gets no row', !/maps_en_all/.test(html));
ok('no query, no rows', ctx._mapFindRowsHtml('') === '');
ok('a hostile query is escaped', !/<img/.test(ctx._mapFindRowsHtml('<img src=x onerror=1>')));

// The hand-off: only for the article that asked, only once, and gives up.
const hook = extract(/function _applyMapFind\(tries\) \{[\s\S]*?\n\}/, '_applyMapFind') +
  extract(/function _typeIntoMapBox\(doc, box, q, tries\) \{[\s\S]*?\n\}/, '_typeIntoMapBox');
ok('the hand-off checks the map on screen is the one asked for', /currentArticle\.zim !== want\.zim/.test(hook));
ok('it fires the input event the box listens for', /dispatchEvent\(new Event\('input'/.test(hook));
ok('and stops asking after a bounded wait', /_MAP_FIND_TRIES/.test(hook) && /_pendingMapFind = null; return;/.test(hook));
ok('it types again while the index has not answered, boundedly', /_MAP_TYPE_TRIES/.test(hook) && /querySelector\('\.search-result'\)/.test(hook));
ok('openArticle carries opts.find into the hand-off', /_pendingMapFind = \(opts && opts\.find\)/.test(src));
ok('the rows sit above the results on a global search', /const mapFindHtml = !scope \? _mapFindRowsHtml/.test(src));

// Places the server found on a map's own index render as rows that open the
// map at the place. Real answers, above the Find-on-map offer.
vm.runInContext(extract(/function _mapPlaceRowsHtml\(groups\) \{[\s\S]*?\n\}/, '_mapPlaceRowsHtml'), ctx);
const groups = [{ zim: 'osm-hawaii', title: 'OSM - Hawaii', main_path: 'index.html', places: [
  { name: 'Kailua', type: 'place', sub: 'city', lat: 21.402, lng: -157.74, locality: 'Honolulu', zoom: 14 },
  { name: 'Kailua High School', type: 'poi', sub: 'school', lat: 21.39, lng: -157.74, locality: '', zoom: 17 },
]}];
const rows = ctx._mapPlaceRowsHtml(groups);
ok('one row per place', (rows.match(/class="result map-place"/g) || []).length === 2);
ok('a row opens the map at the place, zoom by type', /data-pos="map=14\/21.402\/-157.74"/.test(rows) && /data-pos="map=17\/21.39\/-157.74"/.test(rows));
ok('the row says what and where', /city · Honolulu/.test(rows));
ok('the row names the map', /OSM - Hawaii/.test(rows));
ok('no groups, no rows', ctx._mapPlaceRowsHtml([]) === '');
ok('a hostile place name is escaped', !/<img/.test(ctx._mapPlaceRowsHtml([{ zim: 'z', title: 't', main_path: 'i', places: [{ name: '<img src=x onerror=1>', lat: 0, lng: 0 }] }])));
ok('places render above the Find-on-map offer', /const placesHtml = _mapPlaceRowsHtml\(data\.places \|\| \[\]\);/.test(src) && /placesHtml \+ mapFindHtml/.test(src));

// The search runs in two phases and the second's payload is merged into the
// first's; the places group must survive the merge.
vm.runInContext(extract(/function mergeSearchResults\(phase1, phase2\) \{[\s\S]*?\n\}/, 'mergeSearchResults'), ctx);
const merged = ctx.mergeSearchResults({ results: [], by_source: {} }, { results: [], by_source: {}, places: groups });
ok('the merge keeps the places from the full phase', merged.places === groups);

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
