// One thing once. Eric, 2026-09-19: "We should probably also handle
// deduplication if we're merging multiple Zims." Two builds of one map, a
// nopic beside a maxi of one Q&A site: the newest build is the one an app
// lists, and a tile names a source once.
//
// Run: node tests/test_apps_dedupe.cjs   (exit 0 = pass)

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

const ctx = {
  zimsCache: [
    { name: 'hawaii', title: 'OSM - Hawaii', kind: 'map', main_path: 'index.html', map_source: 'StreetZim', date: '2026-09-01', size_bytes: 10 },
    { name: 'osm-hawaii', title: 'OSM - Hawaii', kind: 'map', main_path: 'index.html', map_source: 'StreetZim', date: '2026-09-08', size_bytes: 10 },
    { name: 'maps_en_hawaii', title: 'Hawaii', kind: 'map', main_path: 'index.html', map_source: 'Kiwix', date: '2026-06', size_bytes: 5 },
    { name: 'cooking_nopic', title: 'Cooking', kind: 'qa', main_path: 'index', date: '2026-07', size_bytes: 100 },
    { name: 'cooking_maxi', title: 'Cooking', kind: 'qa', main_path: 'index', date: '2026-07', size_bytes: 900 },
    { name: 'ted_a', title: 'TED', kind: 'video', main_path: 'index', date: '2026-01' },
    { name: 'ted_b', title: 'TED', kind: 'video', main_path: 'index', date: '2026-02' },
  ],
  esc: escf, t: k => k, _getLibraryView: () => 'list', _spaNav: () => false,
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _newestPer\(list, key\) \{[\s\S]*?\n\}/, '_newestPer'),
  extract(/function _installedOfKind\(kind, key\) \{[\s\S]*?\n\}/, '_installedOfKind'),
  extract(/function _mapSourceLabel\(z\) \{[\s\S]*?\n\}/, '_mapSourceLabel'),
  extract(/function _mapName\(z\) \{[\s\S]*?\n\}/, '_mapName'),
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _installedQaZims\(\) \{[\s\S]*?\n\}/, '_installedQaZims'),
  extract(/function _installedVideoZims\(\) \{[\s\S]*?\n\}/, '_installedVideoZims'),
  extract(/var _APP_CATEGORY = [^\n]*\n/, '_APP_CATEGORY'),
  extract(/function _appTileHtml\(app, title, icon, names, openFn\) \{[\s\S]*?\n\}/, '_appTileHtml'),
  extract(/var _TUBE_PLAY_SVG = [^\n]*\n/, '_TUBE_PLAY_SVG'),
  extract(/function _tubeTileHtml\(\) \{[\s\S]*?\n\}/, '_tubeTileHtml'),
].join('\n'), ctx);

// ── one map per region and source, the newest build ─────────────────────
const maps = vm.runInContext('_installedMaps().map(function(z) { return z.name; })', ctx);
ok('two StreetZim builds of Hawaii list once, the newest', JSON.stringify(maps) === JSON.stringify(['maps_en_hawaii', 'osm-hawaii']), JSON.stringify(maps));
ok('a StreetZim map is named by its region', vm.runInContext('_mapName(zimsCache[1])', ctx) === 'Hawaii');
ok('a Kiwix map keeps its title', vm.runInContext('_mapName(zimsCache[2])', ctx) === 'Hawaii');

// ── one site, the fullest build of the month ─────────────────────────────
const qa = vm.runInContext('_installedQaZims().map(function(z) { return z.name; })', ctx);
ok('a nopic beside a maxi of one site is the maxi', JSON.stringify(qa) === JSON.stringify(['cooking_maxi']), JSON.stringify(qa));

// ── sources stay apart; a tile names one once ───────────────────────────
ok('two video ZIMs with one title both feed ZimiTube', vm.runInContext('_installedVideoZims().length', ctx) === 2);
const tile = vm.runInContext('_tubeTileHtml()', ctx);
ok('the tile names TED once', (tile.match(/TED/g) || []).length === 1, tile);

// ── the rule itself ──────────────────────────────────────────────────────
const kept = vm.runInContext(`_newestPer([
  { id: 'a', date: '2026-01', size_bytes: 1 }, { id: 'b', date: '2026-03', size_bytes: 1 }, { id: 'c', date: '2026-03', size_bytes: 9 }, { id: 'd', date: '' }
], function(z) { return z.id === 'd' ? '' : 'k'; }).map(function(z) { return z.id; })`, ctx);
ok('the newest, then the fullest, wins; a keyless entry is dropped from the ranked list', JSON.stringify(kept) === JSON.stringify(['c']), JSON.stringify(kept));

process.exit(failures ? 1 : 0);
