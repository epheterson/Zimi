// A map's tiles kept for offline are capped, oldest first, and capping them
// leaves everything else alone: a pan across a continent reads hundreds of
// tiles and must not fill the phone's storage. Searches keep their own cap.
//
// Run: node tests/test_sw_tile_cap.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (label, cond) => { console.log((cond ? '  ok: ' : '  FAIL: ') + label); if (!cond) failures++; };

const cached = new Map();
global.self = { addEventListener: () => {} };
global.importScripts = () => {};
global.caches = { keys: async () => [], open: async () => ({
  keys: async () => [...cached.keys()].map((u) => ({ url: 'http://x' + u })),
  delete: async (r) => cached.delete(new URL(r.url).pathname),
}) };
global.URL = URL;
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'sw.js'), 'utf8');
(0, eval)(src.replace(/^const /gm, 'var ').concat('\nglobalThis.__sw = { trimKept, TILE_KEPT_MAX, SEARCH_KEPT_MAX };'));
const { trimKept, TILE_KEPT_MAX } = globalThis.__sw;
const req = (p) => ({ url: 'http://x' + p });

(async () => {
  cached.set('/w/wiki/index.html', 'page');
  const extra = 25;
  for (let i = 0; i < TILE_KEPT_MAX + extra; i++) cached.set('/w/map/tiles/14/' + i + '/9.pbf', 't');
  for (let i = 0; i < 3; i++) cached.set('/w/map/tiles/2/' + i + '.mvt', 'm');
  await trimKept(req('/w/map/tiles/14/9/9.pbf'));
  const tiles = [...cached.keys()].filter((k) => /\.(pbf|mvt)$/.test(k));
  ok('tiles are cut to the cap', tiles.length === TILE_KEPT_MAX);
  ok('the oldest go first', !cached.has('/w/map/tiles/14/0/9.pbf') && cached.has('/w/map/tiles/14/' + (TILE_KEPT_MAX + extra - 1) + '/9.pbf'));
  ok('pages are left alone', cached.get('/w/wiki/index.html') === 'page');
  const before = cached.size;
  await trimKept(req('/w/wiki/index.html'));
  ok('a page request trims nothing', cached.size === before);
  process.exit(failures ? 1 : 0);
})();
