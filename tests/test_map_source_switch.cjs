// Same place, another map. A map page with more than one map installed gets
// a topbar button listing the others; choosing one opens it at the position
// and zoom the current map is showing, through the ordinary article open, so
// Back returns to the map you left. Eric, 2026-09-18: "it uses same GPS
// position and zoom then swaps out."
//
// Run: node tests/test_map_source_switch.cjs   (exit 0 = pass)

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
const escf = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let opened = null;
let fakeMap = null;
const ctx = {
  zimsCache: [
    { name: 'osm-hawaii', title: 'Hawaii', kind: 'map', main_path: 'index.html', map_search: true,
      map_source: 'StreetZim', map_bounds: [-178.5, 18.5, -154.5, 28.5] },
    { name: 'maps_en_hawaii', title: 'Hawaii (Kiwix)', kind: 'map', main_path: 'index.html',
      map_source: 'Kiwix', map_bounds: [-161, 18.5, -154.5, 22.5] },
    { name: 'samoa', title: 'Samoa', kind: 'map', main_path: 'index.html',
      map_source: 'Kiwix', map_bounds: [-174.5, -15.9, -170.5, -11.0] },
    { name: 'maps_en_all', title: 'World', kind: 'map', main_path: 'index.html', map_bounds: null },
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main' },
  ],
  tH: k => ({ map_source_elsewhere: 'Elsewhere' })[k] || k,
  currentArticle: { zim: 'osm-hawaii', path: 'index.html' },
  location: { hash: '' },
  esc: escf, escAttr: escf,
  _readerMap: () => fakeMap,
  _closeMapSourceDropdown: () => {},
  openArticle: (zim, p, title, opts) => { opened = { zim, path: p, title, opts }; },
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function mapPositionHash\(zoom, lat, lng\) \{[\s\S]*?\n\}/, 'mapPositionHash'),
  extract(/var _MAP_HASH_RE = [^\n]*\n/, '_MAP_HASH_RE'),
  extract(/function parseMapHash\(hash\) \{[\s\S]*?\n\}/, 'parseMapHash'),
  extract(/function _isMapZim\(name\) \{[\s\S]*?\n\}/, '_isMapZim'),
  extract(/function _currentMapPositionHash\(\) \{[\s\S]*?\n\}/, '_currentMapPositionHash'),
  extract(/function _mapSourceLabel\(z\) \{[\s\S]*?\n\}/, '_mapSourceLabel'),
  extract(/function _mapCovers\(z, pos\) \{[\s\S]*?\n\}/, '_mapCovers'),
  extract(/function _mapSourceRowsHtml\(maps, currentName, pos\) \{[\s\S]*?\n\}/, '_mapSourceRowsHtml'),
  extract(/function _switchMapSource\(name, path, title\) \{[\s\S]*?\n\}/, '_switchMapSource'),
].join('\n'), ctx);

// The rows, from Honolulu
const honolulu = { lat: 21.3069, lng: -157.8583, zoom: 14 };
const rows = ctx._mapSourceRowsHtml(ctx._installedMaps(), 'osm-hawaii', honolulu);
ok('one row per installed map, none for the encyclopedia', (rows.match(/lang-dropdown-item/g) || []).length === 4 && !/Wikipedia/.test(rows));
ok('the open map is the checked one', /item active" role="menuitemradio" aria-checked="true" data-zim="osm-hawaii"/.test(rows));
ok('each row says whose map it is', /Hawaii<span class="ld-sub">StreetZim<\/span>/.test(rows) && /Hawaii \(Kiwix\)<span class="ld-sub">Kiwix<\/span>/.test(rows));
const order = Array.from(rows.matchAll(/data-zim="([^"]+)"|ld-divider/g)).map(m => m[1] || 'divider');
ok('maps that cover the spot first, then a divider, then the rest', order.join(',') === 'osm-hawaii,maps_en_hawaii,maps_en_all,divider,samoa', order.join(','));
ok('a map with unknown ground is not ruled out', ctx._mapCovers(ctx.zimsCache[3], honolulu) === null);
ok('a box across the antimeridian still contains its inside', ctx._mapCovers({ map_bounds: [170, -20, -170, -10] }, { lat: -15, lng: 179 }) === true && ctx._mapCovers({ map_bounds: [170, -20, -170, -10] }, { lat: -15, lng: 0 }) === false);
ok('no position known: every map is listed, no divider', !/ld-divider/.test(ctx._mapSourceRowsHtml(ctx._installedMaps(), 'osm-hawaii', null)));
ok('a map only a map ZIM counts', ctx._isMapZim('osm-hawaii') && !ctx._isMapZim('wikipedia_en_all') && !ctx._isMapZim('nope'));

// The position travels: from the live map first
fakeMap = { getCenter: () => ({ lat: 21.39412, lng: -157.74401 }), getZoom: () => 14.2 };
ctx._switchMapSource('maps_en_hawaii', 'index.html', 'Hawaii (Kiwix)');
ok('the other map opens where this one is', opened && opened.zim === 'maps_en_hawaii' && opened.opts && opened.opts.pos === 'map=14.20/21.39412/-157.74401', JSON.stringify(opened));

// ...from the URL when the map has not answered yet
fakeMap = null; opened = null;
ctx.location.hash = '#map=9/20.5/-157.0';
ctx._switchMapSource('maps_en_hawaii', 'index.html', 'Hawaii (Kiwix)');
ok('with no map handle yet, the hash is the position', opened && opened.opts.pos === 'map=9.00/20.50000/-157.00000', JSON.stringify(opened));

// ...and not at all when there is none: a plain open, not a hash of nothing
ctx.location.hash = ''; opened = null;
ctx._switchMapSource('maps_en_hawaii', 'index.html', 'Hawaii (Kiwix)');
ok('no position known means a plain open', opened && opened.opts === undefined, JSON.stringify(opened));

// ...and not to a map that cannot show it: Samoa opens at Samoa, and says so
fakeMap = { getCenter: () => ({ lat: 21.39412, lng: -157.74401 }), getZoom: () => 14.2 }; opened = null;
ctx._switchMapSource('samoa', 'index.html', 'Samoa');
ok('a map elsewhere opens at its own home, no position claimed', opened && opened.zim === 'samoa' && opened.opts === undefined, JSON.stringify(opened));
fakeMap = null;

// Choosing the map already open does nothing
opened = null;
ctx._switchMapSource('osm-hawaii', 'index.html', 'Hawaii');
ok('the current map is not reopened', opened === null);

// The button: a map page, with somewhere else to go, and the bookmark reads
// its position through the same helper (one way to ask where the map is).
ok('the topbar shows the button on a map page with company only',
  /_readingArticle && currentArticle && _isMapZim\(currentArticle\.zim\) && _installedMaps\(\)\.length > 1/.test(src));
ok('bookmarking a map reads the position the same way', /_bkAdd\(zim, path, title, _currentMapPositionHash\(\)\)/.test(src));
ok('the language dropdown and this one hang from the same helper', (src.match(/_placeDropdownUnder\(dd, btn\);/g) || []).length === 2);

// A shared link: the place in the hash survives the boot rewrite of the URL.
ok('a cold deep link carries its map position into the open',
  /var pos = parseMapHash\(location\.hash\);\n  openArticle\(zim, path, null, \{ replace: true, pos: pos \? mapPositionHash/.test(src));

const tpl = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'templates', 'index.html'), 'utf8');
ok('the template carries the button and its menu', /id="map-source-btn"/.test(tpl) && /id="map-source-dropdown"/.test(tpl));

process.exit(failures ? 1 : 0);
