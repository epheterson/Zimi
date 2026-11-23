// An article opened does not ask /almanac-view unless the Almanac is in the library (the /games-links answer lists its entries then).
//
// Run: node tests/test_game_play_check_almanac_ask.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(name) {
  const m = src.match(new RegExp('^function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^\\}$', 'm'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}
function constant(re) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + re);
  return m[0];
}
let failures = 0;
function ok(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }

async function run(almanac) {
  const fetched = [];
  const btn = { hidden: true, querySelector: () => ({ textContent: '', src: '' }), onclick: null };
  const ctx = {
    currentArticle: { zim: 'wikipedia_en', path: 'A/Moon' },
    _GAMES_WIKI_RE: /^(wikipedia|vikidia)/i,
    _gamesLoad: () => Promise.resolve({ games: {}, almanac, articles: {} }),
    _gamesQidOf: () => '',
    _splitPathFragment: (p) => ({ base: p }),
    _appViewFor: () => null,
    t: (k) => k, _ALMANAC_ZIM: 'zimi_almanac', _openAlmanacLink() {},
    document: { getElementById: () => btn },
    fetch: (u) => { fetched.push(u); return Promise.resolve({ ok: true, json: () => Promise.resolve({ link: 'v=moon' }) }); },
    encodeURIComponent, Object, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext([constant(/^var _ALMANAC_VIEW_URL = .*$/m), constant(/^var _ALMANAC_VIEWS_KEPT = .*$/m), 'var _almanacViews = {};',
    extract('_almanacViewLoad'), extract('_gamePlayHide'), extract('_gamePlayCheck')].join('\n'), ctx);
  vm.runInContext('_gamePlayCheck()', ctx);
  await new Promise((r) => setTimeout(r, 20));
  return fetched;
}

(async () => {
  ok('no Almanac in the library: no round trip', (await run({})).length === 0);
  ok('the Almanac in the library: one ask', (await run({ Q405: 'planet:moon' })).length === 1);
  process.exit(failures ? 1 : 0);
})();
