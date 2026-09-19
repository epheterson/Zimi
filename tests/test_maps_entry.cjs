// The door to maps. Eric: "I don't like map entry through discover that's
// not it and the discover thing you built is useless. Maps doesn't feel
// first class yet." openMaps opens the map you were last on, where you
// were, else the first installed map; /#maps calls it. No Discover card.
// What on the home page calls it is not decided (a top-bar button was
// "not the right entry either").
//
// Run: node tests/test_maps_entry.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const tpl = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'templates', 'index.html'), 'utf8');
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

let opened = null;
const ctx = {
  zimsCache: [
    { name: 'osm-hawaii', title: 'Hawaii', kind: 'map', main_path: 'index.html' },
    { name: 'samoa', title: 'Samoa', kind: 'map', main_path: 'index.html' },
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main' },
  ],
  _hist: [],
  _histLoad: () => ctx._hist,
  _createOpen: false, _almanacOpen: false, mode: 'home',
  closeCreate: () => {}, closeAlmanac: () => {}, updateTopbar: () => {},
  openArticle: (zim, p, title, opts) => { opened = { zim, p, title, opts }; },
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _lastMapVisit\(\) \{[\s\S]*?\n\}/, '_lastMapVisit'),
  extract(/function openMaps\(e\) \{[\s\S]*?\n\}/, 'openMaps'),
].join('\n'), ctx);

ctx.openMaps();
ok('no visits yet: the first installed map, at its home', opened && opened.zim === 'osm-hawaii' && opened.opts === undefined, JSON.stringify(opened));
ctx._hist = [
  { type: 'search', query: 'x' },
  { type: 'article', zim: 'wikipedia_en_all', path: 'A/Main' },
  { type: 'article', zim: 'samoa', path: 'index.html', pos: 'map=12.00/-13.80000/-171.80000' },
  { type: 'article', zim: 'osm-hawaii', path: 'index.html', pos: 'map=14.00/21.30000/-157.80000' },
];
opened = null; ctx.openMaps();
ok('after visits: the map you were last on, where you were', opened && opened.zim === 'samoa' && opened.opts && opened.opts.pos === 'map=12.00/-13.80000/-171.80000', JSON.stringify(opened));
ctx._hist = [{ type: 'article', zim: 'maps_en_gone', path: 'index.html', pos: 'map=1/2/3' }];
opened = null; ctx.openMaps();
ok('a visit to a map since removed is skipped', opened && opened.zim === 'osm-hawaii');
ctx.zimsCache = ctx.zimsCache.filter(z => z.kind !== 'map');
opened = null; ctx.openMaps();
ok('no map installed: nothing happens', opened === null);

ok('no top-bar button for it', !/id="maps-btn"/.test(tpl));
ok('/#maps is the door', /location\.hash === '#maps'[\s\S]*openMaps\(\);/.test(src));
ok('no Discover maps card', !/type: 'maps'/.test(src) && !/dc-map-card/.test(src) && !/dc-map-hero/.test(css));
ok('a cached Discover list from an older build drops its Maps card', /cached = cached\.filter\(function\(it\) \{ return !\(it && it\.type === 'maps'\); \}\);/.test(src));

process.exit(failures ? 1 : 0);
