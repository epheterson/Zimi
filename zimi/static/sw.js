// Zimi Service Worker
// Substituted at serve time to match the running server version (see
// http.py); the literal below is only a fallback for direct file use.
const CACHE_VERSION = 'zimi-vdev';
// The almanac's segment readout face is precached rather than left to the
// /static/ stale-while-revalidate path: it is a font, so a cold offline start
// that misses it falls back to system mono and the time machine's digits
// change face under the reader. Small enough (~6KB) to carry on install.
// Adding an entry here needs no CACHE_VERSION bump: changing these bytes makes
// the browser install a new SW, and install's addAll() adds into whatever
// cache CACHE_VERSION names (the server pins it to the asset-bundle hash).
const PRECACHE_URLS = ['/', '/favicon.png', '/apple-touch-icon.png',
                       '/static/fonts/DSEG14Classic-Bold.woff2'];

const OFFLINE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zimi</title>
<style>
  body { background: #0a0a0b; color: #e0e0e0; font-family: -apple-system, system-ui, sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .msg { text-align: center; }
  h1 { font-size: 1.4rem; font-weight: 500; margin-bottom: 0.5rem; }
  p { color: #888; font-size: 0.9rem; }
  .spinner { width: 24px; height: 24px; border: 2px solid #333; border-top-color: #e0e0e0;
             border-radius: 50%; animation: spin 0.8s linear infinite; margin: 1rem auto; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head><body><div class="msg">
  <div class="spinner"></div>
  <h1>Zimi is restarting\u2026</h1>
  <p>Retrying automatically</p>
</div>
<script>setInterval(() => fetch('/').then(r => { if (r.ok) location.reload(); }).catch(() => {}), 5000);</script>
</body></html>`;

// Install: precache essential assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches, claim clients, version check
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => checkVersion())
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
const NETWORK_ONLY_PREFIXES = ['/whoami', '/login', '/logout', '/list', '/search', '/suggest', '/random'];

// Non-identity API/data (article reads, health, manage, language lists). These
// do not expose the library index and tolerate a cached fallback when offline.
const NETWORK_FIRST_PREFIXES = ['/read', '/health', '/manage', '/article-languages', '/languages'];

function _hasPrefix(path, prefixes) {
  for (let i = 0; i < prefixes.length; i++) {
    if (path === prefixes[i] || path.startsWith(prefixes[i] + '/') ||
        path.startsWith(prefixes[i] + '?')) return true;
  }
  return false;
}

// The single source of truth for which cache strategy a request uses. Pure
// function of the pathname + request mode so it can be asserted directly.
function routeStrategy(path, requestMode) {
  if (_hasPrefix(path, NETWORK_ONLY_PREFIXES)) return 'networkOnly';
  if (_hasPrefix(path, NETWORK_FIRST_PREFIXES)) return 'networkFirst';
  // ZIM content: top-level navigation (reload/bookmark) needs the SPA shell so
  // the client-side router handles the deep link; sub-resources cache-first.
  if (path.startsWith('/w/')) {
    return requestMode === 'navigate' ? 'navigateShell' : 'cacheFirst';
  }
  if (path.startsWith('/static/')) return 'staleWhileRevalidate';
  // Root page: network-first (always serve latest after deploy).
  if (path === '/' || requestMode === 'navigate') return 'networkFirst';
  return 'staleWhileRevalidate';
}
self.routeStrategy = routeStrategy;  // test hook

// Fetch strategy router
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  switch (routeStrategy(url.pathname, event.request.mode)) {
    case 'networkOnly':
      event.respondWith(networkOnly(event.request));
      return;
    case 'networkFirst':
      event.respondWith(networkFirst(event.request));
      return;
    case 'navigateShell':
      // Fetch from network; if offline, fall back to the cached SPA shell '/'.
      event.respondWith(
        fetch(event.request).catch(() => caches.match('/').then(r => r || offlineResponse()))
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
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (e) {
    return offlineResponse();
  }
}

// Network-first: try network, fall back to cache, then offline page
async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    if (resp.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineResponse();
  }
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
