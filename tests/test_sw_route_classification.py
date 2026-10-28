"""Service-worker route classification — the SW must NEVER cache or serve
stale the identity/auth-scoped endpoints.

Field regression (1.8.1 private-mode): the SW routed ``/whoami`` through
stale-while-revalidate and ``/list``/``/search`` through network-first (which
writes the cache). After a successful sign-in the boot gate read a STALE cached
anonymous ``/whoami`` and re-showed the login screen ("sign in twice"); and a
cached full-library ``/list`` could be served on a network blip to a
now-anonymous visitor of a private instance (library leak).

The fix made those endpoints network-only. Since then /whoami, /list and /search
(and the password question) may be answered from a kept copy, but only when the
network has not answered at all (no connection, or lie-fi), marked
X-Zimi-Stale, and a sign-in or sign-out empties them; the network's own answer
is never replaced by a kept one. Every other identity endpoint stays
network-only. This test loads the REAL
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
    "/login",
    "/logout",
    "/suggest",
    "/random",
    "/collections",
    # An account's own saved things (1.12's sync): stale, a second device
    # never saw what the first had saved.
    "/userdata",
    # Who may fetch a voice, and audio asked for by range.
    "/dictionary/voices",
    "/dictionary/speak",
    # The Field Guide's answers name the installed ZIMs; offline the page
    # reads its own copy (/static/fieldguide-offline.json) instead.
    "/fieldguide",
    "/fieldguide/home",
    "/fieldguide/situation",
    "/fieldguide/match",
    "/fieldguide/print",
    "/fieldguide/library",
    # Filtered by the account's ZIM allowlist and by the library: a kept copy
    # would outlive a sign-out (and answer after an account change, offline).
    "/games-links",
]

# Query strings must not change the classification (the SW keys off pathname).
IDENTITY_WITH_QUERY = ["/suggest?q=wa", "/fieldguide/situation?id=choking"]

# Answered by the network when it answers; a marked, kept copy when it does not.
KEPT_ANSWERS = [
    "/whoami",
    "/list",
    "/list?layout=1",
    "/search?q=water",
    "/manage/has-password",
]

_DRIVER = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
// A response as the kept copy, with a body the stand-in Response can carry.
function KEPT_RESPONSE() {
  return { ok: true, status: 200, statusText: 'OK', body: 'kept', headers: new Headers({ 'Content-Type': 'application/json' }) };
}

function makeEnv() {
  const cacheReads = [], cacheWrites = [];
  const fakeCache = {
    match: (r) => { cacheReads.push(r.url); return Promise.resolve(KEPT ? KEPT_RESPONSE() : undefined); },
    put: (r) => { cacheWrites.push(r.url); return Promise.resolve(); },
    addAll: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  };
  const caches = {
    open: () => Promise.resolve(fakeCache),
    match: (r) => { cacheReads.push(r.url); return Promise.resolve(KEPT ? KEPT_RESPONSE() : undefined); },
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
    fetch: FETCH_FAILS
      ? () => Promise.reject(new TypeError('Failed to fetch'))
      : () => Promise.resolve({ ok: true, status: 200, clone: () => ({}),
                                headers: { get: (k) => k.toLowerCase() === 'content-type' ? RESP_TYPE : null } }),
    Response: class { constructor(b, o) { this.body = b; Object.assign(this, o || {});
      const h = (o && o.headers) || {};
      this.headers = { get: (k) => {
        if (typeof h.get === 'function') return h.get(k);
        for (const key of Object.keys(h)) if (key.toLowerCase() === k.toLowerCase()) return h[key];
        return null;
      } };
    } },
    setInterval: () => {}, setTimeout, clearTimeout, AbortController, Headers, console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { self, listeners, cacheReads, cacheWrites };
}

async function probe(path, mode) {
  const env = makeEnv();
  const u = new URL('http://x' + path);
  const strategy = env.self.routeStrategy(u.pathname, mode, undefined, u.search);
  let responded = null;
  const reqHeaders = REQ_HEADERS;
  env.listeners.fetch({ request: { url: 'http://x' + path, method: 'GET', mode: mode || 'cors',
                                   headers: { has: (k) => Object.prototype.hasOwnProperty.call(reqHeaders, k.toLowerCase()) } },
                        respondWith: (p) => { responded = p; }, waitUntil: () => {} });
  let resp = null;
  try { resp = await responded; } catch (e) {}
  return {
    strategy,
    responded: responded !== null,
    cacheWrites: env.cacheWrites.length,
    touchedCache: env.cacheReads.length + env.cacheWrites.length,
    status: resp ? resp.status : null,
    offlineHeader: resp && resp.headers ? resp.headers.get('X-Zimi-Offline') : null,
    staleHeader: resp && resp.headers ? resp.headers.get('X-Zimi-Stale') : null,
  };
}

(async () => {
  const paths = JSON.parse(process.argv[2]);
  const out = {};
  for (const p of paths) out[p] = await probe(p, 'cors');
  process.stdout.write(JSON.stringify(out));
})();
"""


def _run_driver(
    paths, fetch_fails=False, req_headers=None, resp_type="text/css", kept=False
):
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("node not available")
    driver = (
        "const FETCH_FAILS = %s;\n" % ("true" if fetch_fails else "false")
        + "const KEPT = %s;\n" % ("true" if kept else "false")
        + "const REQ_HEADERS = %s;\n" % json.dumps(req_headers or {})
        + "const RESP_TYPE = %s;\n" % json.dumps(resp_type)
    ) + _DRIVER
    proc = subprocess.run(
        [node, "-e", driver, os.path.abspath(_SW), json.dumps(paths)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
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

    def test_kept_answers_prefer_the_network(self):
        """/whoami, /list and /search ask the server first and hand its answer
        back as it is: a kept copy is never put in place of an answer."""
        res = _run_driver(KEPT_ANSWERS, kept=True)
        for p in KEPT_ANSWERS:
            self.assertEqual(res[p]["strategy"], "networkFirst", p)
            self.assertEqual(res[p]["status"], 200, p)
            self.assertIsNone(
                res[p]["staleHeader"], f"{p}: the live answer is not stale"
            )

    def test_a_kept_answer_stands_in_only_when_the_network_does_not_answer(self):
        res = _run_driver(KEPT_ANSWERS, fetch_fails=True, kept=True)
        for p in KEPT_ANSWERS:
            self.assertEqual(res[p]["status"], 200, p)
            self.assertEqual(
                res[p]["staleHeader"], "1", f"{p} must say it is a kept copy"
            )

    def test_offline_fallback_is_labelled_as_synthetic(self):
        """A response the SW invented because the network died must announce
        itself.

        Without the ``X-Zimi-Offline`` marker the client cannot tell "the server
        answered: you have zero ZIMs" from "we never reached the server": a
        ``/list`` that resolves to the offline HTML fails ``.json()`` and lands
        in the same catch as an empty library, which is how the app came to
        claim "No knowledge sources found" during an outage. With nothing kept
        the answer is still the labelled page; a kept copy says so instead.
        """
        paths = KEPT_ANSWERS + IDENTITY_ENDPOINTS
        res = _run_driver(paths, fetch_fails=True)
        for p in paths:
            self.assertEqual(res[p]["status"], 503, p)
            self.assertEqual(
                res[p]["offlineHeader"], "1", f"{p} must be labelled offline"
            )

    def test_the_reconnect_probe_is_never_kept(self):
        """/health?ping=... is asked to learn whether the server is there; a kept
        answer to it would say yes forever, and it filled the cache per probe."""
        res = _run_driver(["/health?ping=1"], kept=True)
        self.assertEqual(res["/health?ping=1"]["strategy"], "networkOnly")
        self.assertEqual(res["/health?ping=1"]["cacheWrites"], 0)

    def test_static_assets_still_cache(self):
        # Guard the negative: static assets must remain cacheable (offline PWA),
        # so the network-only rule didn't accidentally swallow everything.
        res = _run_driver(["/static/app.js"])
        self.assertEqual(res["/static/app.js"]["strategy"], "staleWhileRevalidate")

    def test_zim_content_asks_the_network_before_the_cache(self):
        """/w/ sub-resources are network-first, never cache-first.

        A ZIM name outlives its file: auto-update replaces archives in place,
        and delete-then-recreate reuses names. Cache-first never revalidates,
        which is how a phone spent an afternoon rendering a DELETED capture's
        unstyled pages (2026-08-15). The server pairs this with a
        file-identity ETag and Cache-Control: no-cache, so online the network
        path costs a conditional GET, and the cache still answers offline."""
        res = _run_driver(["/w/apple/www.apple.com/style.css"])
        self.assertEqual(
            res["/w/apple/www.apple.com/style.css"]["strategy"], "networkFirst"
        )

    def test_ranged_requests_bypass_the_worker(self):
        """A video, ogv.js or Say asks by range; the worker stays out of it.

        Through networkFirst every 206 was cloned for a cache that refuses
        partial responses, on the phone, while the video played."""
        res = _run_driver(
            ["/w/ted/videos/1/video.webm"], req_headers={"range": "bytes=0-"}
        )
        self.assertFalse(res["/w/ted/videos/1/video.webm"]["responded"])
        self.assertEqual(res["/w/ted/videos/1/video.webm"]["touchedCache"], 0)

    def test_whole_media_is_streamed_not_cached(self):
        res = _run_driver(["/w/ted/videos/1/video.webm"], resp_type="video/webm")
        self.assertTrue(res["/w/ted/videos/1/video.webm"]["responded"])
        self.assertEqual(res["/w/ted/videos/1/video.webm"]["cacheWrites"], 0)
        res = _run_driver(["/w/apple/www.apple.com/style.css"])
        self.assertEqual(res["/w/apple/www.apple.com/style.css"]["cacheWrites"], 1)


if __name__ == "__main__":
    unittest.main()
