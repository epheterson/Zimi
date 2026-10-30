// A carried ZIM replaced under the same name must not keep answering offline
// with the listing cached from the old archive: the phone's keep-changed
// message fetches each cached /catalog?zim= listing again. Only a fresh answer
// replaces one: offline, the listing a library was kept with stays, or a kept
// library would read empty (test_keep_pdf_live).
//
// Run: node tests/test_sw_catalog_replace.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (label, cond) => { console.log((cond ? '  ok: ' : '  FAIL: ') + label); if (!cond) failures++; };

const cached = new Map([['/catalog?zim=water', 'old water'], ['/catalog?zim=wiki', 'old wiki'], ['/catalog', 'list'], ['/w/water/index.html', 'page']]);
const keyOf = (u) => { const x = new URL(u, 'http://x'); return x.pathname + x.search; };
const listeners = {};
global.KeepStore = { forgetNames() { ok.forgot = true; } };
global.self = { addEventListener: (t, f) => { listeners[t] = f; }, KeepStore: global.KeepStore };
global.importScripts = () => {};
const added = [];
global.caches = { keys: async () => [], open: async () => ({
  match: async (r) => { const k = typeof r === 'string' ? r : keyOf(r.url); return cached.has(k) ? { text: async () => cached.get(k) } : undefined; },
  add: async (r) => { if (typeof r === 'string') return; added.push({ key: keyOf(r.url), keep: r.headers && r.headers.get('X-Zimi-Keep') }); cached.set(keyOf(r.url), 'page'); },
  keys: async () => [...cached.keys()].map((u) => ({ url: 'http://x' + u })),
  put: async (r, res) => { cached.set(typeof r === 'string' ? r : keyOf(r.url), res.body !== undefined ? res.body : 'marker'); },
  delete: async (r) => cached.delete(keyOf(r.url)),
}) };
global.URL = URL;
global.Request = class { constructor(u, o) { this.url = 'http://x' + u; this.headers = new Map(Object.entries((o && o.headers) || {})); } };
let online = true;
const fetched = [];
global.fetch = async (u) => {
  fetched.push(keyOf(u));
  if (!online) throw new TypeError('offline');
  if (keyOf(u).startsWith('/own-offline')) { const z = new URL(u, 'http://x').searchParams.get('zim'); return { ok: true, status: 200, headers: new Map(), json: async () => ({ version: 'v1', paths: ['/w/' + z + '/index.html'] }) }; }
  return { ok: true, body: 'new ' + new URL(u).searchParams.get('zim') };
};
// sw.js declares consts; evaluate it in a function scope so the names stay local.
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'sw.js'), 'utf8');
(0, eval)(src.replace(/^const /gm, 'var '));

const keepChanged = async () => {
  let waited = null;
  listeners.message({ data: { type: 'keep-changed' }, waitUntil: (p) => { waited = p; } });
  await waited;
};

(async () => {
  await keepChanged();
  ok('the kept names are forgotten', ok.forgot === true);
  ok('each cached catalog listing for a ZIM is fetched again and replaced', cached.get('/catalog?zim=water') === 'new water' && cached.get('/catalog?zim=wiki') === 'new wiki');
  ok('the library list and the ZIM pages are left alone', !fetched.includes('/catalog') && cached.get('/catalog') === 'list' && cached.get('/w/water/index.html') === 'page');
  online = false;
  cached.set('/catalog?zim=water', 'kept water');
  await keepChanged();
  ok('offline, the listing a library was kept with stays', cached.get('/catalog?zim=water') === 'kept water');
  // Whenever the phone keeps a ZIM, the page says keep-own-apps: the games and the Almanac are kept whole, marked as keeps.
  online = true;
  let kept = null;
  listeners.message({ data: { type: 'keep-own-apps' }, waitUntil: (p) => { kept = p; } });
  await kept;
  ok('the games and the Almanac are both kept when asked', ['zimi_games', 'zimi_almanac'].every((z) => added.some((a) => a.key === '/w/' + z + '/index.html')));
  ok('their pages are fetched as keeps', added.filter((a) => a.key.startsWith('/w/')).every((a) => a.keep === '1'));
  ok('each is marked as kept whole', cached.has('/_kept/own/zimi_games') && cached.has('/_kept/own/zimi_almanac'));
  const app = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
  ok('the page asks for it whenever any ZIM is kept', /function _keepPrimeOffline\([^)]*\) \{\s*_keepAlmanac\(\);\s*_keepOwnApps\(\);/.test(app) && /_keepNames\.size\) _keepPrimeOffline\(\)/.test(app));
  process.exit(failures ? 1 : 0);
})();
