// Zimi Service Worker
// Substituted at serve time to match the running server version (see
// http.py); the literal below is only a fallback for direct file use.
const CACHE_VERSION = 'zimi-vdev';
// The ZIM reader and the phone's private storage (ZIMs kept on this phone),
// versioned by the server like CACHE_VERSION so a changed reader is a changed
// worker. Imports are stored with the worker, so they load with no network.
const KEEP_V = '0';
try {
  importScripts('/static/fzstd.js?v=' + KEEP_V, '/static/zimreader.js?v=' + KEEP_V, '/static/keepstore.js?v=' + KEEP_V);
} catch (e) { /* no reader: nothing kept can be read, everything else works */ }
// The almanac's segment readout face is precached rather than left to the
// /static/ stale-while-revalidate path: it is a font, so a cold offline start
// that misses it falls back to system mono and the time machine's digits
// change face under the reader. Small enough (~6KB) to carry on install.
// Adding an entry here needs no CACHE_VERSION bump: changing these bytes makes
// the browser install a new SW, and install's addAll() adds into whatever
// cache CACHE_VERSION names (the server pins it to the asset-bundle hash).
const PRECACHE_URLS = ['/', '/favicon.png', '/apple-touch-icon.png',
                       '/static/fonts/DSEG14Classic-Bold.woff2'];

// What the shell and the Field Guide need to run with no server, at the
// addresses this deploy's pages ask for (they carry a content hash, so only
// the server can list them): filled in at serve time by http.py from the
// pages themselves. Kept separately from PRECACHE_URLS: a file that fails to
// fetch is skipped rather than failing the whole install, which would leave
// the phone with no service worker at all.
const SHELL_URLS = [];
// The Almanac, its 3D Earth and the satellites' elements (~1 MB compressed),
// filled in the same way, and kept only when the page asks (keep-almanac): a
// ZIM is kept on this device, or the Almanac was opened. Not at every install,
// which a deploy makes for every visitor.
const ALMANAC_URLS = [];

// The page shown when nothing can be served at all: the shell was never kept
// (the app has not been opened with a connection since it was installed).
// It says which of three things is true, from what the browser knows, and
// uses the words the app last kept for the reader's language (localStorage is
// the app's own; this page is the same origin). English is the fallback.
const OFFLINE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zimi</title>
<style>
  body { background: #0a0a0b; color: #e0e0e0; font-family: -apple-system, system-ui, sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 0 24px; box-sizing: border-box; }
  .msg { text-align: center; max-width: 22rem; }
  h1 { font-size: 1.4rem; font-weight: 500; margin-bottom: 0.5rem; }
  p { color: #999; font-size: 0.95rem; line-height: 1.45; }
  button { margin-top: 1rem; min-height: 44px; padding: 0 20px; border-radius: 22px; border: 1px solid #444;
           background: none; color: inherit; font: inherit; }
</style>
</head><body><div class="msg">
  <h1 id="h"></h1>
  <p id="p"></p>
  <button id="b" type="button"></button>
</div>
<script>
var EN = {
  nonet: ['You\\'re offline', 'This device has no connection. Open Zimi again once you\\'re back on a network.'],
  server: ['Can\\'t reach your Zimi server', 'This device is online, but your Zimi server isn\\'t answering. It may be off, or you may be away from its network.'],
  retry: 'Retry'
};
var kept = {};
try {
  var lang = localStorage.getItem('zimi_ui_lang') || (navigator.language || 'en').split('-')[0];
  kept = JSON.parse(localStorage.getItem('zimi_i18n_kept_' + lang) || '{}') || {};
} catch (e) {}
function word(key, fallback) { return kept[key] || fallback; }
function show() {
  var offline = navigator.onLine === false;
  document.getElementById('h').textContent = offline ? word('offline_title_nonet', EN.nonet[0]) : word('offline_title_server', EN.server[0]);
  document.getElementById('p').textContent = offline ? word('offline_page_nonet_hint', EN.nonet[1]) : word('offline_page_server_hint', EN.server[1]);
  document.getElementById('b').textContent = word('conn_retry', EN.retry);
}
show();
document.getElementById('b').onclick = function() { location.reload(); };
window.addEventListener('online', function() { location.reload(); });
window.addEventListener('offline', show);
setInterval(function() { fetch('/', { cache: 'no-store' }).then(function(r) { if (r.ok) location.reload(); }).catch(function() {}); }, 5000);
</script>
</body></html>`;

// Install: precache essential assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS)
        .then(() => Promise.allSettled(SHELL_URLS.map(u => cache.add(u)))))
      .then(() => hadAlmanac())
      .then(had => had && keepAlmanac())
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches, claim clients, version check
self.addEventListener('activate', event => {
  event.waitUntil(
    ownKeptBefore().catch(() => [])
      .then(had => caches.keys()
        .then(keys => Promise.all(
          keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
        ))
        .then(() => self.clients.claim())
        .then(() => checkVersion())
        // A deploy empties the cache; what was kept whole comes again, once the new worker is in charge.
        .then(() => Promise.all(had.map(keepOwnZim))))
  );
});

// Version check: if the server's asset bundle differs from what this SW was
// built against, drop caches and unregister so the next load is fully fresh.
// Compares the content-hashed asset_version (falls back to the version string
// for older servers that don't report asset_version yet).
async function checkVersion() {
  try {
    const resp = await fetch('/health', { cache: 'no-store' });
    if (resp.ok) {
      const data = await resp.json();
      const serverVer = data.asset_version || (data.version ? 'zimi-v' + data.version : null);
      if (serverVer && serverVer !== CACHE_VERSION) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        await self.registration.unregister();
      }
    }
  } catch (e) {
    // Server unreachable, keep running
  }
}

// Identity + auth-scoped data endpoints. Their responses vary by the
// authenticated identity (anonymous vs named user vs admin) AND by the
// public-access mode, so the service worker MUST NEVER cache or serve them
// stale. Caching them leaks one identity's view to another:
//   - a stale /whoami re-shows the login gate to a just-signed-in user (they
//     "sign in twice"), or hides it from someone who logged out;
//   - a cached full-library /list (or /search) served on a network blip shows
//     the whole library to a now-anonymous visitor of a private instance.
// These fail CLOSED: on network failure they return the offline page rather
// than a wrong-identity cached response. Kept as a single source of truth so
// the classification is testable (see tests/test_sw_route_classification.mjs).
// The apps' feeds (/places, /tube, /exchange, /reddot) and a person's own
// preferences (/me) expose the library or an identity the same way, so they
// fail closed too: a cached feed served to the wrong visitor, or an old feed
// after a deploy, is the same bug twice.
// /collections too: a person's own collections and favorites, which name ZIMs
// as /list does; left to the default stale-while-revalidate, a collection
// created or deleted did not show until the next reload.
// /userdata: an account's own saved things. Served stale, a second device
// never saw what the first had saved, and the account's copy outlived a
// sign-out in the cache.
// The Dictionary's voices: /dictionary/voices says who may fetch a voice and
// what the server can say now (a download changes it), and /dictionary/speak
// is audio asked for by range, which the cache cannot hold.
// The Field Guide's answers (/fieldguide, /situation, /match, /print, /library)
// name the ZIMs installed, and a private server shows them to signed-in
// visitors only; they were once left to stale-while-revalidate and a
// signed-out phone could be shown them. Offline the page reads the guide's own
// copy instead (/static/fieldguide-offline.json: public text, kept like any
// static file), so nothing is lost by never keeping these.
const NETWORK_ONLY_PREFIXES = ['/login', '/logout', '/suggest', '/random', '/places', '/tube', '/exchange', '/reddot', '/me', '/collections', '/userdata', '/dictionary/voices', '/dictionary/speak', '/fieldguide', '/keep', '/games-links', '/own-offline'];
// /games-links is filtered per account and follows the library: never kept, so no copy outlives a sign-out or an account change.

// The answers the app cannot start without, which say who is asking and what
// the library holds: /whoami, /list, /search (the last few searches are kept
// so they read again), and the password question. The network's answer is
// always preferred and never replaced by a kept one while it answers; a kept
// copy stands in only when the network does not (no connection, or none that
// works: "lie-fi"), flagged X-Zimi-Stale so the app knows it is not live.
// A sign-in or sign-out empties them (IDENTITY_CHANGE_PATHS), so a copy never
// outlives the identity that asked for it. This replaces "never kept": a phone
// with no network used to show nothing at all for the library it carries.
const KEPT_ANSWER_PREFIXES = ['/whoami', '/list', '/search', '/manage/has-password'];
const SEARCH_KEPT_MAX = 30;

// Pages a person read are kept for offline (/w/, /read), under the identity
// that read them. A sign-in or sign-out changes who is holding the phone, so
// each one empties those copies: the next person offline is never shown what
// the last could read. The cost is that signing out forgets what was kept.
const IDENTITY_CHANGE_PATHS = ['/login', '/logout'];
const KEPT_CONTENT_PREFIXES = ['/w', '/read'].concat(KEPT_ANSWER_PREFIXES);

// How long the network gets before a kept copy answers instead: to the first
// byte of the answer, not the whole of it, so a long search still streams.
// With nothing kept there is nothing to fall back on: it waits for the server,
// and gives up after the longer one only once the network is known down.
// Probes and reads that nothing else can stand in for give up sooner.
const DEADLINE_KEPT_MS = 2500;
const DEADLINE_COLD_MS = 8000;
const DEADLINE_PROBE_MS = 4000;
// Once the network has failed to answer, the next requests do not each wait out
// their own deadline: for this long a kept copy answers at once (the request
// still goes out, so the first answer to come back ends it).
const NETWORK_DOWN_MS = 15000;
let networkDownUntil = 0;
// Zimi's own ZIMs (ownzims.OWN) are code, not articles: a page of the games and the scripts and strings it loads
// are one version, and a mix of a kept old file beside a new one is broken (labels shown as raw keys). Right after
// a deploy a busy NAS is slow, and a kept copy answering for being slow produced exactly that. These wait as long
// as a request with nothing kept would, and a kept copy answers only when the network is down or has given up.
const OWN_ZIM_PREFIXES = ['/w/zimi_games/', '/w/zimi_almanac/'];
function _isOwnZimEntry(url) {
  const path = new URL(url).pathname;
  return OWN_ZIM_PREFIXES.some(p => path.startsWith(p));
}

// Non-identity API/data (article reads, health, manage, language lists). These
// do not expose the library index and tolerate a cached fallback when offline.
// /almanac-satellites too: the freshest orbital elements when the server
// answers, the last ones seen when it does not. /catalog (a document library's
// listing) too: a ZIM carried on this phone answers it from its own database.js.
const NETWORK_FIRST_PREFIXES = ['/read', '/health', '/manage', '/article-languages', '/languages', '/almanac-satellites', '/almanac-ages', '/catalog'];

// The reconnect probe: /health with a cache-busting ping.
function _isProbe(path, search) {
  return path === '/health' && /(^|[?&])ping=/.test(search || '');
}

function _hasPrefix(path, prefixes) {
  for (let i = 0; i < prefixes.length; i++) {
    if (path === prefixes[i] || path.startsWith(prefixes[i] + '/') ||
        path.startsWith(prefixes[i] + '?')) return true;
  }
  return false;
}

// The single source of truth for which cache strategy a request uses. Pure
// function of the pathname + request mode so it can be asserted directly.
function routeStrategy(path, requestMode, destination, search) {
  // The reconnect probe asks /health with a cache-busting query: its answer
  // is the point, so it is never kept (it filled the cache on every probe).
  if (_hasPrefix(path, ['/keep-local'])) return 'keepLocal';
  if (_isProbe(path, search)) return 'networkOnly';
  // A whole .zim for a peer or a download link: the browser's own, never
  // through the worker (a navigation here once got the shell instead).
  if (path.startsWith('/dl/')) return 'passthrough';
  // The live change stream (GET /events) is open for as long as the page:
  // the browser's own, never held or kept by the worker.
  if (path === '/events') return 'passthrough';
  if (_hasPrefix(path, KEPT_ANSWER_PREFIXES)) return 'networkFirst';
  if (_hasPrefix(path, NETWORK_ONLY_PREFIXES)) return 'networkOnly';
  if (_hasPrefix(path, NETWORK_FIRST_PREFIXES)) return 'networkFirst';
  // ZIM content: top-level navigation (reload/bookmark) needs the SPA shell so
  // the client-side router handles the deep link. Sub-resources are
  // network-first, NOT cache-first: a ZIM name outlives its file (auto-update
  // replaces archives in place; delete-then-recreate reuses names), and a
  // cache-first hit never asks again — a phone spent an afternoon rendering a
  // deleted capture's pages. The server answers /w/ with an ETag keyed to the
  // file's identity and Cache-Control: no-cache, so the network path is a
  // cheap conditional GET online, and the cache still carries reads offline.
  // The reader's frame is also a navigation, but it asks for the article
  // itself: it is kept for offline like any sub-resource, and answered by the
  // shell only when the whole window is what is navigating.
  if (path.startsWith('/w/')) {
    return requestMode === 'navigate' && destination !== 'iframe' ? 'navigateShell' : 'networkFirst';
  }
  if (path.startsWith('/static/')) return 'staleWhileRevalidate';
  // The shell: the latest after a deploy; when the server cannot be reached,
  // the shell last kept, which says what is true and what still works.
  if (path === '/') return 'shell';
  // Any other page is the server's to answer (an old Kiwix link it redirects,
  // a printed PDF): asked first, a kept copy only when it does not answer.
  if (requestMode === 'navigate') return 'networkFirst';
  return 'staleWhileRevalidate';
}
self.routeStrategy = routeStrategy;  // test hook

// Fetch strategy router
self.addEventListener('fetch', event => {
  // A ranged request (a <video>, ogv.js's reader, Say's audio) goes to the
  // network untouched. Through networkFirst every 206 was cloned for a cache
  // that refuses partial responses, and a whole-file answer was teed into
  // Cache Storage: a TED talk's 65 MB copied on an iPhone while it played.
  if (event.request.headers.has('range')) return;
  const url = new URL(event.request.url);
  // The games opened (a tile, an address, a reload): the games and the Almanac are kept whole, a moment after this page has loaded.
  if (!_ownKeepAsked && url.pathname.startsWith('/w/zimi_games/')) {
    _ownKeepAsked = true;
    event.waitUntil(new Promise(r => setTimeout(r, OWN_KEEP_DELAY_MS))
      .then(() => caches.open(CACHE_VERSION)).then(c => c.match(OWN_KEEP_MARK + 'zimi_games'))
      .then(kept => { if (!kept) return keepOwnApps(); }).catch(() => {}));
  }
  switch (routeStrategy(url.pathname, event.request.mode, event.request.destination, url.search)) {
    case 'passthrough':
      return;
    case 'networkOnly':
      event.respondWith(networkOnly(event.request));
      return;
    case 'keepLocal':
      event.respondWith(keepLocal(event.request));
      return;
    case 'networkFirst':
      event.respondWith(networkFirst(event));
      return;
    case 'shell':
      event.respondWith(shellNavigation(event));
      return;
    case 'navigateShell':
      // Opening an article's address (a reload, a bookmark): the server answers
      // with the same SPA shell it gives '/', so the kept one answers at once.
      // The raw file (a PDF opened in its own tab, an EPUB) is the server's.
      event.respondWith(
        /(^|[?&])raw(=|&|$)/.test(url.search) || /\.epub$/i.test(url.pathname)
          ? fetchWithin(event.request, DEADLINE_COLD_MS).catch(() => offlineResponse())
          : caches.match('/').then(r => r || fetchWithin(event.request, DEADLINE_COLD_MS))
              .catch(() => offlineResponse())
      );
      return;
    case 'cacheFirst':
      event.respondWith(cacheFirst(event.request));
      return;
    default:
      event.respondWith(staleWhileRevalidate(event.request));
  }
});

// Network-only: never read or write the cache. Identity/auth-scoped endpoints
// use this so a stale response can never stand in for the live, correctly
// authorized one. Offline → the offline page, never a wrong-identity cache hit.
// Only the probe has a deadline: the rest have nothing to stand in for them,
// so a slow answer (a voice still speaking, a busy /random) is waited for.
async function networkOnly(request) {
  const url = new URL(request.url);
  try {
    const resp = _isProbe(url.pathname, url.search) ? await fetchWithin(request, DEADLINE_PROBE_MS) : await fetch(request);
    if (resp.ok && _hasPrefix(url.pathname, IDENTITY_CHANGE_PATHS)) {
      await purgeKeptContent();
    }
    return resp;
  } catch (e) {
    networkDownUntil = Date.now() + NETWORK_DOWN_MS;
    return offlineResponse();
  }
}

// Forget the pages kept for offline reading (see IDENTITY_CHANGE_PATHS).
async function purgeKeptContent() {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const keys = await cache.keys();
    await Promise.all(keys.filter(r => _hasPrefix(new URL(r.url).pathname, KEPT_CONTENT_PREFIXES))
      .map(r => cache.delete(r)));
    // ZIMs kept under an account go the same way; those kept with none stay.
    if (self.KeepStore && KeepStore.supported()) await KeepStore.purgeOwned();
  } catch (e) {}
}

// A proxy or tunnel in front of a server that is down or restarting answers
// for it: its own 502/503/504 page is not the server speaking, so it never
// stands in for the app or a kept page.
function _gatewayDown(resp) {
  return (resp.status === 502 || resp.status === 503 || resp.status === 504) &&
    !/json/.test(resp.headers.get('Content-Type') || '');
}

// fetch() that gives up when the first byte has not come by `ms`: a phone on
// "lie-fi" (a connection that accepts and never answers) otherwise waits for
// the operating system's timeout, a minute or more. Only reads are cut short;
// the body, once it starts, is not.
function fetchWithin(request, ms) {
  if (request.method && request.method !== 'GET' && request.method !== 'HEAD') return fetch(request);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(request, { signal: ctl.signal }).finally(() => clearTimeout(timer));
}

// A kept answer handed back in place of the server's, marked as such.
function asStale(resp) {
  const h = new Headers(resp.headers);
  h.set('X-Zimi-Stale', '1');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// A navigation: the shell as the phone last kept it, at once. The page boots
// from the device and says what is true; waiting on a server first made every
// start as slow as the worst connection. The copy is the one this worker
// installed with (the server pins CACHE_VERSION to the asset bundle), so it and
// the scripts it names are one set; a new deploy arrives as a new worker.
// Only a device that never kept the shell asks the server, and only a device
// that cannot reach it sees OFFLINE_HTML.
async function shellNavigation(event) {
  const request = event.request;
  const kept = (await caches.match(request)) || (await caches.match('/'));
  if (kept) {
    // Refresh the kept copy for next time, off the path of this start.
    event.waitUntil(fetchWithin(request, DEADLINE_COLD_MS).then(async resp => {
      if (resp.ok && resp.status !== 206 && !_gatewayDown(resp)) {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(request, resp);
      }
    }).catch(() => {}));
    return kept;
  }
  let resp = null;
  try { resp = await fetchWithin(request, DEADLINE_COLD_MS); } catch (e) { /* unreachable */ }
  if (resp && !_gatewayDown(resp)) {
    if (resp.ok && resp.status !== 206) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  }
  return offlineResponse();
}

// Sound and pictures that move are streamed, never kept: a whole video in
// Cache Storage is the phone's space and a long copy while it plays.
function _isMedia(resp) {
  return /^(video|audio)\//.test(resp.headers.get('Content-Type') || '');
}

// Network-first, with a deadline: the server's answer when it comes, the kept
// copy when it does not come in time (or at all), the offline page when there
// is neither. A copy served for that reason is marked X-Zimi-Stale. The request
// goes on after the deadline and the kept copy is refreshed by its answer.
async function networkFirst(event) {
  const request = event.request;
  const get = request.method === 'GET';
  const keptCopy = get ? await caches.match(request) : undefined;
  // A ZIM carried on this phone answers when the server does not, so a page of
  // it is as good as kept even if it was never read before.
  const carried = get && await carriedZim(request);
  const kept = keptCopy || carried;
  const net = fetch(request).then(async resp => {
    networkDownUntil = 0;
    if (get && resp.ok && resp.status !== 206 && !_isMedia(resp)) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, resp.clone()).then(trimSearches).catch(() => {});
    }
    return resp;
  });
  net.catch(() => {});
  if (!get) return net.catch(() => offlineResponse());
  event.waitUntil(net.catch(() => {}));
  // With nothing to stand in, a slow server (a busy NAS, a big picture) is
  // waited for: the offline page in its place would be wrong. Only once the
  // network is known not to answer does such a request give up.
  const down = Date.now() < networkDownUntil;
  if (!kept && !down) return net.catch(() => offlineResponse());
  let timer;
  const wait = kept && !_isOwnZimEntry(request.url) ? (down ? 0 : DEADLINE_KEPT_MS) : down && kept ? 0 : DEADLINE_COLD_MS;
  const late = new Promise(r => { timer = setTimeout(() => r(null), wait); });
  let resp = null;
  try { resp = await Promise.race([net, late]); } catch (e) { /* no answer */ }
  clearTimeout(timer);
  if (!resp) networkDownUntil = Date.now() + NETWORK_DOWN_MS;
  if (resp && !(_gatewayDown(resp) && kept)) return resp;
  // A kept ZIM answers before a kept copy, except a document library's list:
  // the server's own (sizes and all) beats the one read off the phone's copy.
  if (carried && !(keptCopy && catalogZim(new URL(request.url)))) {
    const local = await keptZimResponse(request);
    if (local) return local;
  }
  return keptCopy ? asStale(keptCopy) : offlineResponse();
}

// ── ZIMs carried on this phone ──

// /w/<zim>/<path> as (zim, path), or null.
function zimAndPath(url) {
  if (url.pathname.indexOf('/w/') !== 0) return null;
  const rest = url.pathname.slice(3), slash = rest.indexOf('/');
  if (slash < 0) return null;
  try { return [decodeURIComponent(rest.slice(0, slash)), decodeURIComponent(rest.slice(slash + 1))]; } catch (e) { return null; }
}

// /catalog?zim=<zim>: the ZIM whose document listing is asked for, or null.
function catalogZim(url) {
  return url.pathname === '/catalog' ? url.searchParams.get('zim') : null;
}

// True when the page (or listing) asked for is in a ZIM kept on this phone.
async function carriedZim(request) {
  const url = new URL(request.url), zp = zimAndPath(url);
  const zim = zp ? (zp[1] && zp[0]) : catalogZim(url);
  try { return !!(zim && self.KeepStore && await KeepStore.has(zim)); } catch (e) { return false; }
}

function wLocation(zim, path) {
  return '/w/' + encodeURIComponent(zim) + '/' + path.split('/').map(encodeURIComponent).join('/');
}

// What a ZIM that says "mp4" or labels a picture as a page means.
const MIME_BY_EXT = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', txt: 'text/plain' };
function mimeFor(mime, path) {
  const ext = (/\.([a-z0-9]+)$/i.exec(path) || [])[1];
  const byExt = ext && MIME_BY_EXT[ext.toLowerCase()];
  if (!mime || mime.indexOf('/') < 0) return byExt || 'application/octet-stream';
  if (byExt && mime === 'text/html' && !/^html?$/i.test(ext)) return byExt;   // a picture packed as a page
  return mime;
}

// The CSP the server puts on a ZIM's pages (http.py ZIM_HTML_CSP): its own
// scripts and styles run, nothing outside the page is reached, and only Zimi
// frames it.
const ZIM_HTML_CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'self'";

// What the server answers for a page that is not in the ZIM, in words.
function notInKeptZim(zim, path) {
  return new Response('<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:-apple-system,system-ui,sans-serif;padding:24px;color:#999;background:#0a0a0b">' +
    '<p id="m">This page is not in the copy of this ZIM on this device.</p>' +
    // In the reader's language, from the words the app keeps (as OFFLINE_HTML).
    '<script>try{var l=localStorage.getItem("zimi_ui_lang")||(navigator.language||"en").split("-")[0],' +
    'w=JSON.parse(localStorage.getItem("zimi_i18n_kept_"+l)||"{}").keep_not_in_copy;' +
    'if(w)document.getElementById("m").textContent=w}catch(e){}</script></body>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Zimi-Kept': '1', 'Cache-Control': 'no-store' } });
}

// An entry of a kept ZIM as the server would send it, from the phone's copy.
async function answerFromKeptZim(r, zim, path) {
  // The ZIM's icon (what the library's tile draws): its 48 px illustration.
  if (path === '-/icon') {
    const ill = await r._findKey(0x4D, new TextEncoder().encode('Illustration_48x48@1'));
    const target = ill && await r.resolve(ill);
    if (!target) return notInKeptZim(zim, path);
    return new Response(await r.read(target), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'X-Zimi-Kept': '1' } });
  }
  const e = await r.lookup(path);
  if (!e) return notInKeptZim(zim, path);
  if (e.redirect >= 0) {
    const target = await r.resolve(e);
    if (!target) return notInKeptZim(zim, path);
    return new Response(null, { status: 302, headers: { Location: wLocation(zim, r.pathOf(target)) } });
  }
  const bytes = await r.read(e);
  const mime = mimeFor(e.mime, path);
  const headers = { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Zimi-Kept': '1' };
  if (/^text\/html/.test(mime)) {
    headers['Content-Security-Policy'] = ZIM_HTML_CSP;
    const text = new TextDecoder('utf-8').decode(bytes).replace(/<base\s[^>]*>/gi, '');
    return new Response(text, { status: 200, headers: headers });
  }
  return new Response(bytes, { status: 200, headers: headers });
}

async function keptZimResponse(request) {
  const url = new URL(request.url), zp = zimAndPath(url), cat = catalogZim(url);
  if (!(zp || cat) || !self.KeepStore) return null;
  try {
    const r = await KeepStore.reader(zp ? zp[0] : cat);
    if (!r) return null;
    return zp ? await answerFromKeptZim(r, zp[0], zp[1]) : await keptCatalog(r, cat);
  } catch (e) {
    return null;   // unreadable: the kept copy or the offline page speaks instead
  }
}

// The listing /catalog answers (search.get_catalog), from a carried ZIM's
// database.js (zimi/nautilus.py). Sizes are left out: they would mean reading
// every document. null when the ZIM has no listing.
const LISTING_PATH = 'database.js';
async function keptCatalog(r, zim) {
  const e = await r.lookup(LISTING_PATH);
  const target = e && (e.redirect >= 0 ? await r.resolve(e) : e);
  if (!target) return null;
  const text = new TextDecoder('utf-8').decode(await r.read(target));
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  let items = [];
  try { items = start >= 0 && end > start ? parsePyLiteral(text.slice(start, end + 1)) : []; } catch (err) { return null; }
  const docs = (Array.isArray(items) ? items : []).filter(d => d && typeof d === 'object').map(d => {
    const fp = typeof d.fp === 'string' ? [d.fp] : (Array.isArray(d.fp) ? d.fp : []);
    return { title: d.ti || '?', description: d.dsc || '', author: d.aut || '', path: fp.length ? 'files/' + fp[0] : null, size: null };
  });
  return docs.length ? jsonResponse({ zim: zim, documents: docs, count: docs.length }) : null;
}

// A Python literal as nautilus writes its listing (repr: single-quoted strings,
// True/False/None), read the way the server's ast.literal_eval reads it.
const PY_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
function parsePyLiteral(s) {
  let i = 0;
  function ws() { while (/\s/.test(s[i] || '')) i++; if (i >= s.length) throw new Error('unterminated literal'); }
  function hex(n) { const v = parseInt(s.substr(i, n), 16); i += n; return v; }
  function str(q) {
    let out = '';
    for (i++; s[i] !== q; ) {
      if (i >= s.length) throw new Error('unterminated string');
      if (s[i] !== '\\') { out += s[i++]; continue; }
      const c = s[i + 1]; i += 2;
      if (c === 'x') out += String.fromCharCode(hex(2));
      else if (c === 'u') out += String.fromCharCode(hex(4));
      else if (c === 'U') out += String.fromCodePoint(hex(8));
      else out += c in PY_ESCAPES ? PY_ESCAPES[c] : '\\' + c;
    }
    i++;
    return out;
  }
  function seq(close, add) {
    for (i++; ; ) {
      ws();
      if (s[i] === close) { i++; return; }
      add();
      ws();
      if (s[i] === ',') i++;
    }
  }
  function val() {
    ws();
    const c = s[i];
    if (c === '[' || c === '(') { const a = []; seq(c === '[' ? ']' : ')', () => a.push(val())); return a; }
    if (c === '{') {
      const o = {};
      seq('}', () => { const k = val(); ws(); if (s[i++] !== ':') throw new Error('expected :'); o[k] = val(); });
      return o;
    }
    if (c === "'" || c === '"') return str(c);
    const m = /^(?:True|False|None|-?[0-9][0-9.eE+-]*)/.exec(s.slice(i, i + 40));
    if (!m) throw new Error('unexpected ' + c);
    i += m[0].length;
    return m[0] === 'True' ? true : m[0] === 'False' ? false : m[0] === 'None' ? null : +m[0];
  }
  return val();
}
self.parsePyLiteral = parsePyLiteral;  // test hook

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// /keep-local/list: what is on this phone. /keep-local/search?q=&zim=&limit=:
// titles that begin with the words, from the phone's copies, in the time the
// phone takes (the answer says how long, and that it is titles only).
async function keepLocal(request) {
  const url = new URL(request.url);
  if (!self.KeepStore || !KeepStore.supported()) return jsonResponse({ zims: [], results: [] });
  try {
    if (url.pathname === '/keep-local/list') {
      return jsonResponse({ zims: await KeepStore.list() });
    }
    if (url.pathname === '/keep-local/search') {
      const q = url.searchParams.get('q') || '', only = url.searchParams.get('zim');
      const limit = Math.max(1, Math.min(50, +url.searchParams.get('limit') || 20));
      const t0 = Date.now();
      const zims = (await KeepStore.kept()).filter(m => !only || m.name === only);
      const per = await Promise.all(zims.map(async m => {
        const r = await KeepStore.reader(m.name);
        const hits = r ? await r.search(q, limit) : [];
        return hits.map(h => ({ zim: m.name, zim_title: m.title, title: h.title, path: h.path }));
      }));
      // One from each ZIM in turn, so a big ZIM does not bury a small one.
      const results = [];
      for (let i = 0; results.length < limit && per.some(p => i < p.length); i++) {
        per.forEach(p => { if (i < p.length && results.length < limit) results.push(p[i]); });
      }
      return jsonResponse({ query: q, mode: 'title', results: results, took_ms: Date.now() - t0 });
    }
  } catch (e) { /* fall through */ }
  return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
}

// A carried ZIM that arrives again (an import, a re-download) is a new archive
// under the same name: a /catalog?zim= listing cached from the old one would
// outrank it offline, so each cached listing is fetched again. Only a fresh
// answer replaces one: the listing a library was just kept with is what reads
// it offline, and dropping it (as first done here) left a kept library empty.
async function refreshCachedCatalogs() {
  try {
    const cache = await caches.open(CACHE_VERSION);
    for (const req of await cache.keys()) {
      if (!catalogZim(new URL(req.url))) continue;
      try {
        const fresh = await fetch(req.url, { credentials: 'same-origin', cache: 'no-store' });
        if (fresh.ok) await cache.put(req, fresh);
      } catch (e) { /* offline: the cached listing stays */ }
    }
  } catch (e) { /* nothing cached */ }
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'keep-changed') {
    if (self.KeepStore) KeepStore.forgetNames();
    event.waitUntil(refreshCachedCatalogs());
  }
  if (event.data && event.data.type === 'keep-almanac') event.waitUntil(keepAlmanac());
  if (event.data && event.data.type === 'keep-own-apps') event.waitUntil(keepOwnApps());
  if (event.data && event.data.type === 'forget-own' && OWN_ZIM_PREFIXES.includes('/w/' + event.data.zim + '/')) event.waitUntil(forgetOwnZim(event.data.zim));
});

// A device that kept the Almanac keeps each new deploy's too, before activate
// drops the old cache: a page asking later may be gone, or gone offline.
async function hadAlmanac() {
  if (!ALMANAC_URLS.length) return false;
  for (const k of await caches.keys()) {
    if (k !== CACHE_VERSION && await (await caches.open(k)).match(ALMANAC_URLS[0], { ignoreSearch: true })) return true;
  }
  return false;
}

// Only what this cache does not have yet is fetched; one that fails is skipped.
async function keepAlmanac() {
  const cache = await caches.open(CACHE_VERSION);
  await Promise.allSettled(ALMANAC_URLS.map(async u => { if (!(await cache.match(u))) await cache.add(u); }));
}

// The games (and the Almanac beside them) open with no signal once either has been used, or the phone keeps anything
// offline: Eric, 2026-10-27, "Games and almanac should always be available offline if any app is offline unless user
// explicitly removes." The server lists what the games are made of (/own-offline: ~6.5 MB, 2.2 MB on the wire; the
// puzzle files and thumbnails come as they are played); a few at a time, only what this cache lacks, in the
// background after the page that asked has loaded. An empty list means the person removed the ZIM: what was kept of it goes.
const OWN_KEEP_PARALLEL = 4;
const OWN_KEEP_MARK = '/_kept/own/';   // a small answer saying this cache holds a ZIM's pages whole
const OWN_KEEP_DELAY_MS = 4000;
const OWN_KEEP_MAX_FAILS = 5;   // a network that went away stops the keeping; the next open asks again
const _ownKeeping = {};
let _ownKeepAsked = false;   // once per worker life: a page of the games has been asked for

async function keepOwnApps() {
  await keepAlmanac();
  await keepOwnZim('zimi_games');
}

async function keepOwnZim(zim) {
  if (_ownKeeping[zim]) return _ownKeeping[zim];
  return (_ownKeeping[zim] = (async () => {
    try {
      const cache = await caches.open(CACHE_VERSION);
      const resp = await fetch('/own-offline?zim=' + encodeURIComponent(zim), { credentials: 'same-origin' });
      if (!resp.ok || _gatewayDown(resp)) return;
      const paths = (await resp.json()).paths || [];
      if (!paths.length) { await forgetOwnZim(zim); return; }
      const todo = [];
      for (const u of paths) if (!(await cache.match(u))) todo.push(u);
      let failed = 0;
      const worker = async () => {
        while (todo.length && failed < OWN_KEEP_MAX_FAILS) {
          const u = todo.pop();
          try { await cache.add(new Request(u, { cache: 'no-cache', headers: { 'X-Zimi-Keep': '1' } })); } catch (e) { failed++; }
        }
      };
      await Promise.all(Array.from({ length: OWN_KEEP_PARALLEL }, worker));
      if (!failed) await cache.put(OWN_KEEP_MARK + zim, new Response('1'));
    } catch (e) { /* offline or busy: asked again the next time it opens */ }
    finally { delete _ownKeeping[zim]; }
  })());
}

// A ZIM the person removed: its kept pages go with it.
async function forgetOwnZim(zim) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const prefix = '/w/' + zim + '/';
    for (const r of await cache.keys()) {
      const path = new URL(r.url).pathname;
      if (path.startsWith(prefix) || path === OWN_KEEP_MARK + zim) await cache.delete(r);
    }
  } catch (e) { /* nothing kept */ }
}

// Which own ZIMs an older cache held whole, read before activate drops it: the new deploy keeps them again.
async function ownKeptBefore() {
  const had = [];
  for (const k of await caches.keys()) {
    if (k === CACHE_VERSION) continue;
    const cache = await caches.open(k);
    for (const o of OWN_ZIM_PREFIXES) {
      const zim = o.split('/')[2];
      if (!had.includes(zim) && await cache.match(OWN_KEEP_MARK + zim)) had.push(zim);
    }
  }
  return had;
}

// Only the last few searches are kept, newest first.
async function trimSearches() {
  const cache = await caches.open(CACHE_VERSION);
  const keys = (await cache.keys()).filter(r => new URL(r.url).pathname === '/search');
  await Promise.all(keys.slice(0, Math.max(0, keys.length - SEARCH_KEPT_MAX)).map(r => cache.delete(r)));
}

// Cache-first: serve from cache, fetch if missing
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (e) {
    return offlineResponse();
  }
}

// Stale-while-revalidate: serve cache immediately, update in background
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(resp => {
    if (_gatewayDown(resp)) return null;   // a proxy answering for a dead server is not an answer
    if (resp.ok) cache.put(request, resp.clone());
    return resp;
  }).catch(() => null);

  if (cached) {
    // Revalidation already running in background (initiated above), return cached immediately
    fetchPromise.catch(() => {}); // suppress unhandled rejection
    return cached;
  }
  // Nothing cached, must wait for network
  const resp = await fetchPromise;
  if (resp) return resp;
  // Not reachable, and not kept at this address: the same file kept at another
  // version (a script asked for as ?v=45 here and ?v=<hash> there) is better
  // than nothing, which is how a phone lost the Almanac's three.js.
  const otherVersion = await cache.match(request, { ignoreSearch: true });
  if (otherVersion) return otherVersion;
  return offlineResponse();
}

// Offline fallback response.
//
// The X-Zimi-Offline header is the contract with the app shell: this body was
// synthesised here because the network never answered, NOT by the server. The
// client's serverFetch() keys off it to tell "the server said you have no
// ZIMs" apart from "we could not ask" — without it a /list that resolves to
// this 503 HTML looks, after a failed .json(), exactly like an empty library.
function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Zimi-Offline': '1',
      'Cache-Control': 'no-store'
    }
  });
}
