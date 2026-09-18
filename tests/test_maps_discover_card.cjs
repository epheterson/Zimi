// The Discover row gets a Maps card whenever a map ZIM is installed. The card
// is built from _installedMaps, which is what this pins: it trusts the
// server's `kind` (metadata, survives a rename) and not the filename, skips a
// map with no main page (nothing to open), and sorts by title so the chips
// read the same on every visit. Also pinned: the random-fill pool for the
// other cards excludes maps, whose "random entry" would be a tile.
//
// Run: node tests/test_maps_discover_card.cjs   (exit 0 = pass)

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
    { name: 'samoa', title: 'Samoa', kind: 'map', main_path: 'index.html' },
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main' },
    { name: 'hawaii', title: 'OSM - Hawaii', kind: 'map', main_path: 'index.html' },
    { name: 'broken_map', title: 'Broken', kind: 'map', main_path: '' },
    { name: 'maps_en_fiji', title: 'Fiji', main_path: 'index.html' },  // name says map, server did not
  ],
};
vm.createContext(ctx);
vm.runInContext(extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'), ctx);

const maps = ctx._installedMaps();
ok('only ZIMs the server called maps', maps.every(z => z.kind === 'map'));
ok('a map without a main page is left out', !maps.some(z => z.name === 'broken_map'));
ok('the filename alone does not make a map', !maps.some(z => z.name === 'maps_en_fiji'));
ok('sorted by title', maps.map(z => z.title).join('|') === 'OSM - Hawaii|Samoa', maps.map(z => z.title).join('|'));

// The random-fill filter in _loadDiscover must exclude maps. Pinned by text:
// the filter is a closure over locals and is not extractable on its own.
const fill = extract(/var visualZims = \(zimsCache \|\| \[\]\)\.filter\(function\(z\) \{[\s\S]*?\}\);/, 'visualZims filter');
ok('random fill skips maps', /z\.kind !== 'map'/.test(fill));

// And the card is only pushed when there is a map to show.
ok('the maps card is conditional on an installed map',
  /if \(_installedMaps\(\)\.length\) computed\.unshift\(\{ type: 'maps' \}\)/.test(src));

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
