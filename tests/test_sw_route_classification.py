"""Service-worker route classification — the SW must NEVER cache or serve
stale the identity/auth-scoped endpoints.

Field regression (1.8.1 private-mode): the SW routed ``/whoami`` through
stale-while-revalidate and ``/list``/``/search`` through network-first (which
writes the cache). After a successful sign-in the boot gate read a STALE cached
anonymous ``/whoami`` and re-showed the login screen ("sign in twice"); and a
cached full-library ``/list`` could be served on a network blip to a
now-anonymous visitor of a private instance (library leak).

The fix makes those endpoints network-only. This test loads the REAL
``zimi/static/sw.js`` in a stubbed ServiceWorker global via ``node`` and asserts
(a) ``routeStrategy`` classifies each identity endpoint as ``networkOnly`` and
(b) dispatching a fetch for them NEVER touches the Cache API. It is a loop over
the endpoint table, not a cherry-pick, so a new identity endpoint that forgets
the network-only rule fails here.
"""

import json
import os
import shutil
import subprocess
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SW = os.path.join(_HERE, "..", "zimi", "static", "sw.js")

# Every endpoint whose response varies by authenticated identity or public-access
# mode. These MUST be network-only in the SW.
IDENTITY_ENDPOINTS = [
    "/whoami",
    "/login",
    "/logout",
    "/list",
    "/search",
    "/suggest",
    "/random",
]

# Query strings must not change the classification (the SW keys off pathname).
IDENTITY_WITH_QUERY = ["/search?q=water", "/list?layout=1", "/suggest?q=wa"]

_DRIVER = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(process.argv[1], 'utf8');

function makeEnv() {
  const cacheReads = [], cacheWrites = [];
  const fakeCache = {
    match: (r) => { cacheReads.push(r.url); return Promise.resolve(undefined); },
    put: (r) => { cacheWrites.push(r.url); return Promise.resolve(); },
    addAll: () => Promise.resolve(),
  };
  const caches = {
    open: () => Promise.resolve(fakeCache),
    match: (r) => { cacheReads.push(r.url); return Promise.resolve(undefined); },
    keys: () => Promise.resolve([]), delete: () => Promise.resolve(true),
  };
  const listeners = {};
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {}, clients: { claim: () => Promise.resolve() },
    registration: { unregister: () => Promise.resolve() },
  };
  const ctx = {
    self, caches, URL,
    fetch: () => Promise.resolve({ ok: true, clone: () => ({}) }),
    Response: class { constructor(b, o) { this.body = b; Object.assign(this, o); } },
    setInterval: () => {}, console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { self, listeners, cacheReads, cacheWrites };
}

async function probe(path, mode) {
  const env = makeEnv();
  const strategy = env.self.routeStrategy(new URL('http://x' + path).pathname, mode);
  let responded = null;
  env.listeners.fetch({ request: { url: 'http://x' + path, mode: mode || 'cors' },
                        respondWith: (p) => { responded = p; } });
  try { await responded; } catch (e) {}
  return { strategy, touchedCache: env.cacheReads.length + env.cacheWrites.length };
}

(async () => {
  const paths = JSON.parse(process.argv[2]);
  const out = {};
  for (const p of paths) out[p] = await probe(p, 'cors');
  process.stdout.write(JSON.stringify(out));
})();
"""


def _run_driver(paths):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not available")
    proc = subprocess.run(
        [node, "-e", _DRIVER, os.path.abspath(_SW), json.dumps(paths)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise AssertionError("SW driver failed: " + proc.stderr)
    return json.loads(proc.stdout)


class TestSwRouteClassification(unittest.TestCase):
    def test_identity_endpoints_are_network_only(self):
        res = _run_driver(IDENTITY_ENDPOINTS)
        for p in IDENTITY_ENDPOINTS:
            self.assertEqual(
                res[p]["strategy"], "networkOnly", f"{p} must be network-only"
            )

    def test_identity_endpoints_never_touch_cache(self):
        # Behavioural: even after dispatching the fetch event, no Cache API read
        # or write happens for an identity endpoint — so no stale response can
        # ever stand in for the live, correctly authorized one.
        res = _run_driver(IDENTITY_ENDPOINTS)
        for p in IDENTITY_ENDPOINTS:
            self.assertEqual(
                res[p]["touchedCache"], 0, f"{p} must never touch the SW cache"
            )

    def test_query_string_does_not_change_classification(self):
        res = _run_driver(IDENTITY_WITH_QUERY)
        for p in IDENTITY_WITH_QUERY:
            self.assertEqual(res[p]["strategy"], "networkOnly", p)
            self.assertEqual(res[p]["touchedCache"], 0, p)

    def test_static_assets_still_cache(self):
        # Guard the negative: static assets must remain cacheable (offline PWA),
        # so the network-only rule didn't accidentally swallow everything.
        res = _run_driver(["/static/app.js"])
        self.assertEqual(res["/static/app.js"]["strategy"], "staleWhileRevalidate")


if __name__ == "__main__":
    unittest.main()
