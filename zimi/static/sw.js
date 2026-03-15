// Zimi Service Worker
const CACHE_VERSION = 'zimi-v1.6.1';
const PRECACHE_URLS = ['/', '/favicon.png', '/apple-touch-icon.png'];

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

// Version check: unregister if server reports a different version
async function checkVersion() {
  try {
    const resp = await fetch('/health', { cache: 'no-store' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.version && 'zimi-v' + data.version !== CACHE_VERSION) {
        self.registration.unregister();
      }
    }
  } catch (e) {
    // Server unreachable, keep running
  }
}

// Fetch strategy router
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const path = url.pathname;

  // API calls: network-first
  if (path.startsWith('/search') || path.startsWith('/read') ||
      path.startsWith('/list') || path.startsWith('/suggest') ||
      path.startsWith('/random') || path.startsWith('/health') ||
      path.startsWith('/manage') || path.startsWith('/article-languages') ||
      path.startsWith('/languages')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // ZIM content: top-level navigation (reload/bookmark) needs the SPA shell
  // so the client-side router handles the deep link. Fetch from network; if
  // offline, fall back to the cached root '/' (same SPA shell).
  // Sub-resource requests (iframe, images, CSS) use cache-first for speed.
  if (path.startsWith('/w/')) {
    if (event.request.mode === 'navigate') {
      event.respondWith(
        fetch(event.request).catch(() => caches.match('/').then(r => r || offlineResponse()))
      );
    } else {
      event.respondWith(cacheFirst(event.request));
    }
    return;
  }

  // Static assets: stale-while-revalidate
  if (path.startsWith('/static/')) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Root page: network-first (always serve latest after deploy)
  // Favicons/other assets: stale-while-revalidate
  if (path === '/' || event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

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

// Offline fallback response
function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
