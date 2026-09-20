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
    { name: 'maps_en_islands', title: 'Islands', kind: 'map', main_path: 'index.html', map_bounds: null },
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
  extract(/function _lngIn\(lng, w, e\) \{[^\n]*\n/, '_lngIn'),
  extract(/var _MP_FOLD_FROM = [^\n]*\n/, '_MP_FOLD_FROM'),
  extract(/function _mapCovers\(z, pos\) \{[\s\S]*?\n\}/, '_mapCovers'),
  extract(/function _mpRow\(z, active\) \{[\s\S]*?\n\}/, '_mpRow'),
  extract(/function _mapSourceRowsHtml\(maps, currentName, pos, extras\) \{[\s\S]*?\n\}/, '_mapSourceRowsHtml'),
  extract(/function _switchMapSource\(name, path, title\) \{[\s\S]*?\n\}/, '_switchMapSource'),
].join('\n'), ctx);

// The rows, from Honolulu
const honolulu = { lat: 21.3069, lng: -157.8583, zoom: 14 };
const rows = ctx._mapSourceRowsHtml(ctx._installedMaps(), 'osm-hawaii', honolulu);
ok('one row per installed map, none for the encyclopedia', (rows.match(/class="mp-row/g) || []).length === 4 && !/Wikipedia/.test(rows));
ok('the open map is the checked one', /mp-row active" role="menuitemradio" aria-checked="true" data-zim="osm-hawaii"/.test(rows) && /mp-check/.test(rows));
ok('each row says whose map it is, on the same line', /<span class="mp-name">Hawaii<\/span><span class="mp-meta">StreetZim/.test(rows) && /<span class="mp-name">Hawaii \(Kiwix\)<\/span><span class="mp-meta">Kiwix<\/span>/.test(rows));
const order = Array.from(rows.matchAll(/data-zim="([^"]+)"|data-role="fold"/g)).map(m => m[1] || 'fold');
ok('four maps: nothing is folded, the maps of elsewhere simply follow', order.join(',') === 'osm-hawaii,maps_en_hawaii,maps_en_islands,samoa' && !/data-role="fold"/.test(rows), order.join(','));
const many = ctx._installedMaps().concat([1, 2, 3].map(i => ({ name: 'far' + i, title: 'Far ' + i, kind: 'map', main_path: 'index.html', map_bounds: [10, 10, 20, 20] })));
const manyRows = ctx._mapSourceRowsHtml(many, 'osm-hawaii', honolulu);
ok('seven maps: the maps of elsewhere fold behind one row that says how many', /data-role="fold"><span class="mp-name">Elsewhere<\/span><span class="mp-meta">4<\/span>/.test(manyRows) && /<div class="mp-folded" hidden>[\s\S]*data-zim="samoa"/.test(manyRows));
ok('a map with unknown ground is not ruled out', ctx._mapCovers(ctx.zimsCache[3], honolulu) === null);
ok('a box across the antimeridian still contains its inside', ctx._mapCovers({ map_bounds: [170, -20, -170, -10] }, { lat: -15, lng: 179 }) === true && ctx._mapCovers({ map_bounds: [170, -20, -170, -10] }, { lat: -15, lng: 0 }) === false);
ok('a view counts as here when the map shows any of it', ctx._mapCovers({ map_bounds: [-161, 18.5, -154.5, 22.5] }, { w: -158.5, s: 21, e: -157.5, n: 21.6 }) === true && ctx._mapCovers({ map_bounds: [-161, 18.5, -154.5, 22.5] }, { w: -170, s: 21, e: -162, n: 21.6 }) === false && ctx._mapCovers({ map_bounds: [-161, 18.5, -154.5, 22.5] }, { w: -162, s: 21, e: -160, n: 21.6 }) === true);
ok('no position known: every map is listed, nothing folded', !/data-role="fold"/.test(ctx._mapSourceRowsHtml(ctx._installedMaps(), 'osm-hawaii', null)) && (ctx._mapSourceRowsHtml(ctx._installedMaps(), 'osm-hawaii', null).match(/class="mp-row/g) || []).length === 4);
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
  /var pos = parseMapHash\(location\.hash\);\r?\n  openArticle\(zim, path, null, \{ replace: true, pos: pos \? mapPositionHash/.test(src));

// ── Get a map of here: the catalog's maps that cover the spot ────────────
ctx.t = k => ({ download: 'Download' })[k] || k;
ctx.tH = k => ({ map_source_elsewhere: 'Elsewhere', map_offer_here: 'Get a map of here', map_offer_world: 'Worldwide', map_offer_all: 'All maps in the catalog' })[k] || k;
ctx.fmtBytes = b => Math.round(b / 1e9) + ' GB';
vm.runInContext([
  extract(/var _MAP_OFFERS_HERE = [^\n]*\n/, '_MAP_OFFERS_HERE'), extract(/var _MAP_OFFERS_WORLD = [^\n]*\n/, '_MAP_OFFERS_WORLD'),
  extract(/function _mapOfferInstalled\(it\) \{[\s\S]*?\n\}/, '_mapOfferInstalled'),
  extract(/function _mapOfferGroups\(items, pos\) \{[\s\S]*?\n\}/, '_mapOfferGroups'),
  extract(/var _MP_DOWN_SVG = [^\n]*\n/, '_MP_DOWN_SVG'),
  extract(/function _mapOfferRow\(it\) \{[\s\S]*?\n\}/, '_mapOfferRow'),
  extract(/function _mapOfferRowsHtml\(groups\) \{[\s\S]*?\n\}/, '_mapOfferRowsHtml'),
].join('\n'), ctx);
const catalog = [
  { name: 'maps_en_united-states', title: 'United States', size_bytes: 22e9, bounds: [-171.8, 18.9, -66.9, 71.4], download_url: 'https://download.kiwix.org/zim/maps/us.zim' },
  { name: 'maps_en_north-america', title: 'North America', size_bytes: 40e9, bounds: [-170, 5, -50, 84], download_url: 'https://download.kiwix.org/zim/maps/na.zim' },
  { name: 'maps_en_canada', title: 'Canada', size_bytes: 9e9, bounds: [-141, 41.7, -52.6, 83.1], download_url: 'https://download.kiwix.org/zim/maps/ca.zim' },
  { name: 'maps_en_all', title: 'World', size_bytes: 77e9, bounds: [-180, -90, 180, 90], world: true, download_url: 'https://download.kiwix.org/zim/maps/all.zim' },
  { name: 'osm-hawaii', title: 'Hawaii', size_bytes: 0.25e9, bounds: [-178.5, 18.5, -154.5, 28.5], source: 'streetzim', download_url: 'https://archive.org/download/streetzim-hawaii/osm-hawaii-2026-09-08.zim' },
  { name: 'osm-pacific-islands', title: 'Pacific Islands', size_bytes: 3e9, bounds: [130, -30, -130, 25], source: 'streetzim', download_url: 'https://archive.org/download/streetzim-pacific-islands/x.zim' },
  { name: 'maps_en_samoa', title: 'Samoa', size_bytes: 0.13e9, bounds: [-172.8, -14.1, -171.4, -13.4], installed: true, download_url: 'https://download.kiwix.org/zim/maps/ws.zim' },
  { name: 'wikipedia_en_all', title: 'Wikipedia' },
];
const groups = ctx._mapOfferGroups(catalog, honolulu);
ok('the maps of here, smallest first, not the installed one (osm-hawaii is in zimsCache)', groups.here.map(m => m.name).join(',') === 'osm-pacific-islands,maps_en_united-states,maps_en_north-america', groups.here.map(m => m.name).join(','));
ok('the planet under its own heading', groups.world.map(m => m.name).join(',') === 'maps_en_all');
ok('an installed catalog map is not offered', !groups.here.concat(groups.world).some(m => m.name === 'maps_en_samoa'));
ok('no position: nothing of here, still the planet and the way to all', ctx._mapOfferGroups(catalog, null).here.length === 0 && ctx._mapOfferGroups(catalog, null).world.length === 1);
const offerParts = ctx._mapOfferRowsHtml(groups); const offers = offerParts.middle + offerParts.end;
ok('a row says whose map on the line and how big on the right, with the arrow', /Pacific Islands<span class="mp-tag">StreetZim<\/span><\/span><span class="mp-meta">3 GB <svg/.test(offers) && /United States<span class="mp-tag">Kiwix<\/span><\/span><span class="mp-meta">22 GB <svg/.test(offers) && !/Download/.test(offers), offers.slice(0, 200));
ok('the rows carry the download URL', /data-role="offer" data-url="https:\/\/archive\.org\/download\/streetzim-pacific-islands\/x\.zim"/.test(offers));
ok('one heading, the planet last in the same list, then the punch-out', /mp-head" role="separator">Get a map of here<\/div>[\s\S]*Pacific Islands[\s\S]*North America[\s\S]*World<span class="mp-tag">Kiwix/.test(offers) && !/Worldwide/.test(offers) && /data-role="all-maps"><span class="mp-name">All maps in the catalog/.test(offers));
const whole = ctx._mapSourceRowsHtml(ctx._installedMaps(), 'osm-hawaii', honolulu, offerParts);
const wholeOrder = Array.from(whole.matchAll(/data-zim="([^"]+)"|data-role="([^"]+)"|mp-head" role="separator">([^<]+)/g)).map(m => m[1] || m[2] || m[3]);
ok('a map of this ground, installed or not, comes before a map of elsewhere; the way to all maps last',
  wholeOrder.join(',') === 'osm-hawaii,maps_en_hawaii,maps_en_islands,Get a map of here,offer,offer,offer,offer,samoa,locate,all-maps', wholeOrder.join(','));
ok('the way to where you are asks the device only when tapped', /function _mapWhereIAm\(\)[\s\S]*navigator\.geolocation\.getCurrentPosition/.test(src) && !/getCurrentPosition[\s\S]*function _mapWhereIAm/.test(src.slice(0, src.indexOf('function _mapWhereIAm'))));
ok('off the open map, it says so instead of jumping to the edge', /_mapCovers\(z, \{lat: lat, lng: lng\}\) === false\) \{ _showToast\(t\('map_location_off_map'\)\)/.test(src));
ok('the picker judges here by the view on screen', /var pos = _currentMapView\(\) \|\| \(here \? parseMapHash/.test(src));
ok('the dropdown loads both catalogs once and re-renders when they arrive', /var got = await _fetchCatalogItems\(\);[\s\S]*_kiwixOffers = placed\(got\.items\);/.test(src) && /manageFetch\('\/manage\/catalog-streetzim'\)/.test(fn('_mapOfferItems')) && /_mapOfferItems\(\)\.then\(function\(\) \{\r?\n\s*if \(dd\.classList\.contains\('visible'\)\) _renderMapSourceDropdown\(dd\);/.test(src));
ok('only maps the server could place are kept, from a fresh fetch', /return _kiwixOffers\.concat\(_streetzimOffers\)/.test(src) && /extras = _mapOfferRowsHtml\(_mapOfferGroups\(_mapOfferAll\(\), pos\)\)/.test(src));
ok('an offer row starts the download through the ordinary path and says where to watch it', /await downloadZim\(url, null\);[\s\S]*_showToast\(tH\('map_offer_started', \{map: title\}\)\)/.test(fn('_mapOfferDownload')));
ok('the punch-out opens the catalog on the Maps category', /await _openCategory\('maps'\)/.test(fn('_openMapsCatalog')) && /await enterManage\(null\);\r?\n\s*switchManageTab\('browse'\);\r?\n\s*drillCategory\(key\);/.test(fn('_openCategory')));
function fn(name) { return extract(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}'), name); }

const tpl = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'templates', 'index.html'), 'utf8');
ok('the template carries the button and its menu', /id="map-source-btn"/.test(tpl) && /id="map-source-dropdown"/.test(tpl));

ok('a Kiwix map is told where to open in its own hash, which it will not override', /mz\.map_source === 'Kiwix'\) \{\r?\n\s*url \+= '#lat=' \+ mp\.lat \+ '&lon=' \+ mp\.lng \+ '&zoom=' \+ Math\.round\(mp\.zoom\)/.test(src));
ok('and a map that moves itself in its first seconds is put back, unless a person moved it', /\[700, 2000\]\.forEach/.test(fn('_restoreMapPosition')) && /if \(moved\) return;/.test(fn('_restoreMapPosition')));

process.exit(failures ? 1 : 0);
