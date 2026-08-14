"""The rendered capture engine — a real browser, as a child of this process.

Zimi's fast engine reads what the server sent. That covers the server-rendered
web and nothing else, and Eric's verdict on capturing apple.com with it was the
honest one: the images that arrive by lazy-loading were missing and the pages
that build themselves in JavaScript were empty. This is the other engine. It
drives headless Chromium through Playwright, lets the page finish becoming
itself, and then keeps what the BROWSER ended up with rather than what the
server first said.

It is a CHILD PROCESS, never a sibling container. There is no docker socket in
this design and there is not going to be one: a capture engine that needs a
daemon it can talk to is a privilege escalation wearing a feature's clothes,
and Eric's instruction ("no second container it would have to run within
somehow") is also the right security answer. The dependency is soft in exactly
the way yt-dlp is — ``pip install 'zimi[browser]'`` plus one ``playwright
install chromium``; without it the engine is absent, the toggle is disabled,
and every other way of making a ZIM works as it always did.

WHAT A RENDERED CAPTURE IS, precisely, so nobody is surprised by it:

  * The page is navigated, allowed to go quiet, scrolled from top to bottom to
    trigger lazy-loaded media, and allowed to go quiet again. Every bound here
    is a constant below, because "wait for the network to stop" without a
    deadline is how one bad page eats an afternoon.
  * What is stored is the RENDERED DOM — ``document.documentElement.outerHTML``
    after all of that — plus every subresource the browser actually fetched:
    stylesheets, images, fonts, media. Cross-origin included. Offline means
    carrying it or breaking it, and a font on a CDN is not less necessary for
    living somewhere else.
  * ``<img srcset>`` and ``<picture>`` are collapsed to the one image the
    browser CHOSE at a 1280px viewport, because that is the honest answer to
    "which of these five files is the page" — the alternative is carrying all
    five or guessing at one.
  * SCRIPTS ARE STRIPPED. This is a frozen snapshot: pixel-faithful where the
    page had finished painting, and inert. A carousel does not turn, a menu
    that needs JavaScript to open does not open, and a page that renders
    nothing until a fetch() resolves stays as blank as it was at capture. Full
    interactive replay is what WARC and zimit exist for; this engine sets its
    ceiling out loud rather than shipping half a browser and hoping.

The engine object at the bottom is the same shape as the fast engine's
(``zimi.creator.BuiltinCapture``): ``fetch`` a URL, ``render`` what came back
into ZIM-ready HTML. That is what lets the bounded site crawl in
``zimi.crawler`` run either engine over the identical frontier, robots policy,
politeness interval and budgets, and lets the job stream in ``zimi.manage``
stay ignorant of which one ran.

ONE BROWSER PER JOB, one page at a time, and every subresource body written
straight to disk instead of held — a rendered crawl on a Pi must not be a
memory event. See ``RenderedSession``.
"""

import hashlib
import logging
import os
import posixpath
import re
import shutil
import signal
import tempfile
import threading
import time
import urllib.parse

from zimi.creator import (
    CreateError,
    _CSS_URL_RE,
    _externalize_links,
    _normalize_charset,
    _strip_scripts,
)
from zimi.zimwriter import (
    _MAX_ASSET_BYTES,
    _MAX_ASSETS,
    _MAX_TOTAL_ASSET_BYTES,
    _slug,
    make_asset_item,
)

log = logging.getLogger("zimi.renderer")

# ── the soft dependency ─────────────────────────────────────────────────────

INSTALL_HINT = "pip install 'zimi[browser]' && playwright install chromium"
RENDERER_MISSING = (
    "the rendered engine needs Playwright and a headless Chromium, and this "
    "system has neither installed.\n"
    f"Install them with: {INSTALL_HINT}\n"
    "(The Docker image ships with both.) Until then, capture with the fast "
    "engine — it needs nothing extra and handles server-rendered pages."
)
CHROMIUM_MISSING = (
    "Playwright is installed but its Chromium is not — the browser itself is "
    "a separate download.\n"
    "Install it with: playwright install chromium"
)

# ── bounds (every wait in this module has one) ──────────────────────────────

# The viewport a capture renders at. Desktop-width on purpose: it is what
# srcset picks the large image for, and a capture that quietly rendered a phone
# layout would look like a bug in the reader rather than a choice made here.
VIEWPORT = (1280, 900)
# Navigation. Generous — a cold CDN on a slow line is not a failure — but
# finite, because a page that never fires `load` would otherwise hold the job
# until the stall watchdog gives up on it ten minutes later.
NAV_TIMEOUT = 45.0
# How long the page may keep the network busy after the DOM is ready before we
# stop waiting for quiet and take what is there. Analytics beacons and polling
# widgets mean "networkidle" never arrives on a fair number of real sites.
QUIET_TIMEOUT = 12.0
# The pause after everything looks finished, for the paint and the last
# lazy-loading observer to fire.
SETTLE = 1.2
# The lazy-load scroll pass: how many viewport-heights it steps through, and
# how long it waits at each stop for the images that step revealed.
SCROLL_STEPS = 12
SCROLL_PAUSE = 0.35
# A second quiet wait AFTER the scroll, shorter than the first: the scroll's
# job is to start those requests, and this is what lets them land.
SCROLL_QUIET_TIMEOUT = 8.0
# Then wait for the images the DOM actually holds to finish arriving, bounded.
# Sites that stage their hero art behind an animation delay (apple.com) insert
# the <img> late and load it later still — network-quiet can win that race and
# serialize a page whose most memorable picture is a blank. Poll cheaply.
IMAGE_SETTLE_TIMEOUT = 6.0
IMAGE_SETTLE_TICK = 0.25
# Killing the child: how long a browser gets to exit politely before it is
# taken out. A wedged renderer must never outlive the job that started it.
KILL_GRACE = 3.0

# Which of the browser's requests are worth keeping. Scripts are deliberately
# absent — they are stripped from the stored page, so carrying their bytes
# would be paying for a file nothing references. XHR/fetch payloads go for the
# same reason: without the script that asked for them they are unreachable.
KEPT_RESOURCE_TYPES = frozenset(
    {"stylesheet", "image", "media", "font", "texttrack", "other"}
)
# Path components in the mirror layout, and the whole path, are capped: a URL
# can be two thousand characters long and a ZIM entry path should not be.
_MAX_PATH_SEGMENT = 72
_MAX_ASSET_PATH = 200

_CSS_IMPORT_RE = re.compile(r"""@import\s+(["'])([^"']+)\1""", re.IGNORECASE)
# The tags whose refs are ASSETS. `<a href>` is deliberately not here: a link
# is resolved by the caller, which is the only party that knows whether this
# capture holds the far end.
_ASSET_TAG_RE = re.compile(
    r"<(?:img|source|video|audio|track|embed|link|object)\b[^>]*>", re.IGNORECASE
)
_LINK_TAG_RE = re.compile(r"<link\b", re.IGNORECASE)
_ATTR_RE_CACHE = {}
_STYLE_ATTR_RE = re.compile(
    r"""(\bstyle\s*=\s*)(["'])(.*?)\2""", re.IGNORECASE | re.DOTALL
)
_STYLE_ELEM_RE = re.compile(
    r"(<style\b[^>]*>)(.*?)(</style\s*>)", re.IGNORECASE | re.DOTALL
)
# Which <link rel> values name something a reader still needs offline. Anything
# else a link element points at (preload, prefetch, dns-prefetch) is an
# instruction to a live browser about a file it is about to want, and offline it
# is a dangling reference at best.
_CARRIED_LINK_RELS = ("stylesheet", "icon", "apple-touch-icon", "mask-icon")
_REL_ATTR_RE = re.compile(r"""\brel\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)


def _attr_re(name):
    """The compiled ``attr="value"`` matcher for one attribute name."""
    rx = _ATTR_RE_CACHE.get(name)
    if rx is None:
        rx = re.compile(
            r"""(\b%s\s*=\s*)(["'])(.*?)\2""" % name, re.IGNORECASE | re.DOTALL
        )
        _ATTR_RE_CACHE[name] = rx
    return rx


# ── availability ────────────────────────────────────────────────────────────
#
# Probing this costs a browser launch, so the answer is cached for the life of
# the process. It is a fact about the INSTALL, and an install does not change
# while the server runs — except when an operator makes it change, which is
# what the explicit refresh is for.

_available_lock = threading.Lock()
_available = None  # None = never asked, else (ok, reason)


def _playwright_module():
    """Playwright's sync API, or None. The one import seam — every other
    function in here asks this rather than importing at module scope, so a Zimi
    that will never render a page never pays for it."""
    try:
        from playwright.sync_api import sync_playwright

        return sync_playwright
    except Exception as e:  # not installed, or installed against another ABI
        log.debug("playwright is not importable: %s", e)
        return None


def browser_status(refresh=False):
    """``(available, reason)`` for the rendered engine on this machine.

    ``reason`` is one of ``"ok"``, ``"no-playwright"`` or ``"no-chromium"`` —
    they are different problems with different fixes, and the toggle's hint
    says which. The answer is cached: it launches a real browser to find out,
    which is not something a status poll may do."""
    global _available
    with _available_lock:
        if _available is not None and not refresh:
            return _available
    result = _probe_browser()
    with _available_lock:
        _available = result
    return result


def browser_available(refresh=False):
    return browser_status(refresh=refresh)[0]


def _probe_browser():
    """Actually launch one. Importing playwright proves nothing — the browser
    is a separate ~150MB download and its absence is the common case."""
    sync_playwright = _playwright_module()
    if sync_playwright is None:
        return False, "no-playwright"
    started = None
    try:
        started = sync_playwright().start()
        browser = _launch(started.chromium)
        browser.close()
        return True, "ok"
    except Exception as e:
        log.debug("chromium did not launch: %s", e)
        return False, "no-chromium"
    finally:
        if started is not None:
            try:
                started.stop()
            except Exception:
                pass


# Chromium's default 64MB of shared memory is the single most common cause of a
# renderer crash inside a container, and Zimi's own container is small on
# purpose. The rest is the standard headless-in-a-container set.
_LAUNCH_ARGS = ["--disable-dev-shm-usage", "--disable-gpu", "--mute-audio"]
# The fallback, and the reason it is a FALLBACK rather than a default. Chromium
# isolates each page it renders in a sandboxed process, which is exactly the
# protection you want around arbitrary web pages someone asked you to capture.
# That sandbox needs unprivileged user namespaces, and Docker's default seccomp
# profile blocks them — so inside a container the browser refuses to start at
# all unless it is told to go without. Rather than ship "--no-sandbox" for
# everybody (which would silently drop the protection on the machines that
# HAVE it), the launch is attempted properly first and only steps down when
# that fails, saying so in the log.
_NO_SANDBOX = "--no-sandbox"


def _launch(chromium):
    """Launch with the sandbox; fall back without it, loudly, once."""
    try:
        return chromium.launch(args=_LAUNCH_ARGS)
    except Exception as e:
        log.info(
            "chromium would not start sandboxed (%s) — retrying without the "
            "sandbox, which is expected inside a container",
            _playwright_reason(e),
        )
        return chromium.launch(args=_LAUNCH_ARGS + [_NO_SANDBOX])


# ── the page preparation script ─────────────────────────────────────────────
#
# Runs INSIDE the page, once, immediately before serialization, because these
# are the three things only the browser knows: which srcset candidate it chose,
# what a relative reference resolves to under this document's <base>, and what
# the DOM looks like after the page finished building it.

_PREPARE_JS = r"""() => {
  const absolutize = (el, attr) => {
    const raw = el.getAttribute(attr);
    if (!raw) return;
    const value = raw.trim();
    if (!value || value.startsWith('#') || value.startsWith('data:')) return;
    try { el.setAttribute(attr, new URL(value, document.baseURI).href); }
    catch (e) { /* an unparseable reference stays exactly as the author wrote it */ }
  };
  const absSrcset = (el) => {
    const raw = el.getAttribute('srcset');
    if (!raw) return;
    el.setAttribute('srcset', raw.split(',').map(part => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return part.trim();
      try { bits[0] = new URL(bits[0], document.baseURI).href; } catch (e) {}
      return bits.join(' ');
    }).filter(Boolean).join(', '));
  };

  // The image the browser actually chose, frozen. currentSrc is the whole
  // point of rendering: it is srcset, sizes, <picture> and the device pixel
  // ratio already resolved into one answer.
  document.querySelectorAll('img').forEach(img => {
    if (img.currentSrc) img.setAttribute('src', img.currentSrc);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('loading');
  });
  document.querySelectorAll('picture source').forEach(s => s.remove());

  // Every reference the stored page will carry, made absolute here where
  // document.baseURI is authoritative. The <base> element itself is dropped
  // afterwards, server-side, once nothing relies on it any more.
  [['a', 'href'], ['area', 'href'], ['link', 'href'], ['img', 'src'],
   ['source', 'src'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'],
   ['track', 'src'], ['embed', 'src'], ['iframe', 'src'], ['object', 'data'],
  ].forEach(([tag, attr]) => {
    document.querySelectorAll(tag + '[' + attr + ']').forEach(el => absolutize(el, attr));
  });
  document.querySelectorAll('source[srcset], img[srcset]').forEach(absSrcset);

  // Links that only ever meant something to a live browser: a preload is a
  // request to fetch something sooner, and offline it is a dead reference.
  document.querySelectorAll('link[rel]').forEach(el => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    if (/(^|\s)(preload|modulepreload|prefetch|preconnect|dns-prefetch)(\s|$)/.test(rel)) {
      el.remove();
    }
  });

  return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
}"""


# ── what one navigation produced ────────────────────────────────────────────


class _Resource:
    """One subresource the browser fetched, spooled to disk.

    On disk rather than in memory for the same reason the crawl's page spool
    is: a rendered page can pull eighty megabytes of hero video and font
    families, the peak here is one file, and the machines Zimi targets do not
    have the difference to spare."""

    __slots__ = ("url", "mimetype", "path", "size")

    def __init__(self, url, mimetype, path, size):
        self.url = url
        self.mimetype = mimetype
        self.path = path
        self.size = size

    def read(self):
        try:
            with open(self.path, "rb") as fh:
                return fh.read()
        except OSError as e:
            log.warning("spooled resource %s is unreadable: %s", self.url, e)
            return None


class RenderedPage:
    """A navigation's whole result: where it landed, the rendered DOM, and
    every subresource that came with it."""

    __slots__ = ("final_url", "html", "bytes", "content_language", "resources")

    def __init__(self, final_url, html, nbytes, content_language, resources):
        self.final_url = final_url
        self.html = html
        self.bytes = nbytes
        self.content_language = content_language
        self.resources = resources  # absolute URL -> _Resource

    def discard(self):
        """Delete this page's spooled resource files. Called once the page has
        been rendered into the ZIM and its bytes are somewhere else."""
        for resource in self.resources.values():
            try:
                os.remove(resource.path)
            except OSError:
                pass
        self.resources = {}


# ── the browser ─────────────────────────────────────────────────────────────

_sessions = []  # live sessions, so a watchdog on another thread can kill them
_sessions_lock = threading.Lock()


class RenderedSession:
    """One headless browser, for the whole job.

    Launching Chromium costs a second and a couple of hundred megabytes of
    RSS; doing it per page would make a two-hundred-page crawl mostly browser
    startup. One browser, one context, one page at a time, closed the moment
    the job ends however it ends.

    The session registers itself so ``shutdown_sessions()`` can kill the child
    from ANOTHER thread — Playwright's sync API is bound to the thread that
    created it, so the stall watchdog cannot politely close a browser whose own
    thread is wedged inside a navigation. It signals the driver process
    instead, which is a thing any thread may do."""

    def __init__(self, *, work_dir=None, budget=None, note=None, viewport=VIEWPORT):
        self._budget = budget
        self._note = note or (lambda _m: None)
        self._viewport = viewport
        self._pw = None
        self._browser = None
        self._context = None
        self._spool = tempfile.mkdtemp(prefix=".zimi-render-", dir=work_dir)
        self._spooled = 0
        self._driver_pid = None
        self._killed = False
        self._closed = False

    # -- lifecycle ---------------------------------------------------------
    def start(self):
        sync_playwright = _playwright_module()
        if sync_playwright is None:
            self._cleanup_spool()
            raise CreateError(RENDERER_MISSING)
        self._note("starting a headless browser…")
        try:
            self._pw = sync_playwright().start()
            self._browser = _launch(self._pw.chromium)
        except Exception as e:
            self._cleanup_spool()
            self._stop_playwright()
            log.debug("browser launch failed: %s", e)
            raise CreateError(
                CHROMIUM_MISSING if self._pw is not None else RENDERER_MISSING
            )
        self._driver_pid = _driver_pid(self._pw)
        self._context = self._browser.new_context(
            viewport={"width": self._viewport[0], "height": self._viewport[1]},
            user_agent=self._user_agent(),
            ignore_https_errors=False,
        )
        self._context.set_default_timeout(int(NAV_TIMEOUT * 1000))
        with _sessions_lock:
            _sessions.append(self)
        return self

    def _user_agent(self):
        """Chromium's own UA with Zimi's appended. Both halves are true and
        both are load-bearing: the browser half is what makes a site serve the
        page it would serve a person, and the Zimi half is how an operator
        reading their logs can tell who this was. Nothing here pretends not to
        be headless — a capture engine that lies about itself to get past a
        block is a different kind of tool than this one."""
        from zimi.library import USER_AGENT

        if self._browser is None:
            return None
        try:
            page = self._browser.new_page()
            try:
                base = page.evaluate("() => navigator.userAgent")
            finally:
                page.close()
        except Exception as e:
            log.debug("could not read the browser's own user agent: %s", e)
            return None
        return f"{base} {USER_AGENT}" if base else None

    def close(self):
        """Shut the browser down. Safe to call twice, and safe to call after
        something has already gone wrong — a capture that fails must still not
        leave a Chromium behind.

        A session that was KILLED skips the polite half entirely. This is not
        an optimisation: Playwright's close() writes a request down a pipe and
        waits for the driver to answer, and a driver that has been shot answers
        nothing — the wedged job's own thread, arriving here after the watchdog
        gave up on it, would block forever on the tidy-up."""
        if self._closed:
            return
        self._closed = True
        with _sessions_lock:
            if self in _sessions:
                _sessions.remove(self)
        if not self._killed:
            for shut in (self._context, self._browser):
                try:
                    if shut is not None:
                        shut.close()
                except Exception as e:
                    log.debug("browser close: %s", e)
            self._stop_playwright()
            self.kill()  # a driver that ignored stop() does not get to survive
        self._context = self._browser = self._pw = None
        self._cleanup_spool()

    def _stop_playwright(self):
        try:
            if self._pw is not None:
                self._pw.stop()
        except Exception as e:
            log.debug("playwright stop: %s", e)
        self._pw = None

    def kill(self):
        """Take the child process out, from ANY thread.

        This is what the create watchdog reaches for: by the time a job is
        declared stalled its own thread is blocked somewhere inside the browser
        and cannot be asked to tidy up. Killing the driver kills Chromium with
        it — the browser is its child, and Playwright's driver does not outlive
        a signal."""
        # Set BEFORE the signal, and never unset: from here on, this session's
        # Playwright objects are talking to a process that is going away, and
        # close() must not try to have a conversation with them.
        self._killed = True
        pid = self._driver_pid
        self._driver_pid = None
        if not pid:
            return
        for sig, grace in ((signal.SIGTERM, KILL_GRACE), (signal.SIGKILL, KILL_GRACE)):
            if not _process_alive(pid):
                return
            try:
                os.kill(pid, sig)
            except OSError:
                return
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                if not _process_alive(pid):
                    return
                time.sleep(0.05)

    def _cleanup_spool(self):
        shutil.rmtree(self._spool, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()

    # -- capture -----------------------------------------------------------
    def capture(self, url):
        """Navigate, settle, scroll, settle, serialize. Returns a
        ``RenderedPage``; raises ``CreateError`` for anything the person who
        asked for this capture could act on."""
        if self._context is None:
            raise CreateError(RENDERER_MISSING)
        page = self._context.new_page()
        responses = []
        # A plain function, not `responses.append`: Playwright decorates the
        # handler it is given, and a builtin method has nowhere to keep the
        # attribute it wants to put there.
        page.on("response", lambda response: responses.append(response))
        try:
            try:
                page.goto(
                    url, wait_until="domcontentloaded", timeout=int(NAV_TIMEOUT * 1000)
                )
            except Exception as e:
                raise CreateError(f"cannot render {url}: {_playwright_reason(e)}")
            self._quiet(page, QUIET_TIMEOUT)
            self._lazy_scroll(page)
            self._quiet(page, SCROLL_QUIET_TIMEOUT)
            self._image_settle(page)
            _sleep(SETTLE)
            final_url = page.url or url
            try:
                html = page.evaluate(_PREPARE_JS)
            except Exception as e:
                raise CreateError(
                    f"cannot read {url} after rendering it: " f"{_playwright_reason(e)}"
                )
            resources, doc_bytes = self._collect(responses, final_url)
        finally:
            try:
                page.close()
            except Exception:
                pass
        return RenderedPage(
            final_url,
            html,
            doc_bytes or len(html.encode("utf-8", errors="replace")),
            _content_language(responses, final_url),
            resources,
        )

    def _quiet(self, page, timeout):
        """Wait for the network to go quiet, and stop waiting when it will not.

        A timeout here is NOT an error: analytics beacons, open websockets and
        polling widgets mean plenty of perfectly good pages never go idle at
        all, and refusing them would refuse a large part of the web."""
        try:
            page.wait_for_load_state("networkidle", timeout=int(timeout * 1000))
        except Exception:
            log.debug(
                "page never went quiet within %.0fs; taking what is there", timeout
            )

    def _lazy_scroll(self, page):
        """Walk the page top to bottom, pausing.

        This is the single highest-value thing the rendered engine does and it
        is also the least clever: modern pages hold their images back behind an
        IntersectionObserver, so an image that was never scrolled past was
        never requested, and a capture that skipped this would be missing
        exactly the pictures a person remembers the page for."""
        try:
            height = page.evaluate(
                "() => document.body ? document.body.scrollHeight : 0"
            )
            step = max(1, int(self._viewport[1] * 0.9))
            position = 0
            for _n in range(SCROLL_STEPS):
                if position >= (height or 0):
                    break
                position += step
                page.evaluate("(y) => window.scrollTo(0, y)", position)
                _sleep(SCROLL_PAUSE)
                height = page.evaluate(
                    "() => document.body ? document.body.scrollHeight : 0"
                )
            page.evaluate("() => window.scrollTo(0, 0)")
        except Exception as e:  # a page that refuses to scroll is still a page
            log.debug("lazy-load scroll pass failed: %s", e)

    def _image_settle(self, page):
        """Wait, bounded, until every <img> the DOM holds has finished loading.

        Network-quiet answers "are requests still flying"; this answers the
        different question "did the pictures the page decided to show actually
        arrive" — a hero staged behind an animation delay inserts its <img>
        after quiet and loads it later still. Broken images count as settled
        (complete is true for them); a page that keeps inserting images loses
        at the timeout, honestly."""
        deadline = time.time() + IMAGE_SETTLE_TIMEOUT
        try:
            while time.time() < deadline:
                pending = page.evaluate(
                    "() => Array.from(document.images)"
                    ".filter(i => i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight * 14)"
                    ".filter(i => !i.complete).length"
                )
                if not pending:
                    return
                _sleep(IMAGE_SETTLE_TICK)
        except Exception as e:  # a page that refuses the question is done asking
            log.debug("image settle poll failed: %s", e)

    def _collect(self, responses, final_url):
        """Every kept response body, spooled to disk as it is read.

        Bodies are read here rather than in the event handler because reading
        one is itself a round trip to the browser, and doing that from inside
        the callback that is announcing the next one is how the sync API
        deadlocks. They are still available: Chromium holds them until the page
        navigates again or closes, and this runs before either."""
        resources = {}
        doc_bytes = 0
        for response in responses:
            try:
                url = response.url
                status = response.status
                kind = response.request.resource_type
            except Exception:
                continue
            if not (200 <= status < 300) or url.startswith("data:"):
                continue
            if kind == "document":
                if _same_document(url, final_url):
                    doc_bytes = max(doc_bytes, _body_length(response))
                continue
            if kind not in KEPT_RESOURCE_TYPES or url in resources:
                continue
            body = _body(response)
            if body is None or not body or len(body) > _MAX_ASSET_BYTES:
                continue
            if self._budget is not None and not self._budget.spend(len(body)):
                # The job's byte budget is spent. Later pages still render —
                # their text is the point — they simply stop carrying media.
                log.debug("byte budget spent; not keeping %s", url)
                continue
            path = os.path.join(self._spool, f"{self._spooled:06d}.bin")
            self._spooled += 1
            try:
                with open(path, "wb") as fh:
                    fh.write(body)
            except OSError as e:
                log.warning("could not spool %s: %s", url, e)
                continue
            resources[url] = _Resource(url, _mimetype_of(response), path, len(body))
        return resources, doc_bytes


def shutdown_sessions():
    """Kill every live browser. Called by the create watchdog when it gives up
    on a job: the job's own thread is by definition not answering, so the
    tidy-up cannot be asked of it."""
    with _sessions_lock:
        live = list(_sessions)
        _sessions.clear()
    for session in live:
        try:
            session.kill()
        except Exception as e:
            log.debug("could not kill a rendered session: %s", e)


def _process_alive(pid):
    """Whether a pid is a process that is still RUNNING.

    The reaping half is the part that matters: a killed child of this process
    stays in the table as a zombie until somebody waits for it, and a zombie
    answers signal 0 exactly like a live process would. Asking without reaping
    is how "did the browser actually die?" gets the wrong answer forever."""
    try:
        reaped, _status = os.waitpid(pid, os.WNOHANG)
        if reaped == pid:
            return False
    except (ChildProcessError, OSError):
        # Not our child, or somebody else's watcher got there first — both mean
        # the signal check below is the whole answer.
        pass
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _driver_pid(playwright):
    """The OS pid of Playwright's driver process, or None.

    Reached through private attributes on purpose, and guarded on purpose:
    there is no public API for it, and the only thing that depends on this is
    the ability to kill a wedged browser from another thread. Without it the
    engine still works — a stalled job's browser then lives until its own
    navigation times out."""
    for chain in (
        ("_connection", "_transport", "_proc"),
        ("_impl_obj", "_connection", "_transport", "_proc"),
    ):
        node = playwright
        for name in chain:
            node = getattr(node, name, None)
            if node is None:
                break
        pid = getattr(node, "pid", None)
        if isinstance(pid, int) and pid > 0:
            return pid
    log.debug("playwright's driver pid is not reachable on this version")
    return None


def _sleep(seconds):
    time.sleep(seconds)


def _playwright_reason(exc):
    """The first line of a Playwright error, which is the part a person can
    act on. The rest is a stack of internal frames and a trace id."""
    text = str(exc or "").strip()
    first = text.splitlines()[0] if text else "the browser gave no reason"
    return first[:200]


def _body(response):
    try:
        return response.body()
    except Exception as e:  # a redirect, a 204, a body already evicted
        log.debug("no body for %s: %s", getattr(response, "url", "?"), e)
        return None


def _body_length(response):
    body = _body(response)
    return len(body) if body else 0


def _mimetype_of(response):
    try:
        raw = response.headers.get("content-type") or ""
    except Exception:
        raw = ""
    mime = raw.split(";")[0].strip().lower()
    return mime or "application/octet-stream"


def _content_language(responses, final_url):
    """The Content-Language header of the page's own response, for the same
    language detection the fast engine does."""
    for response in responses:
        try:
            if response.request.resource_type == "document" and _same_document(
                response.url, final_url
            ):
                return (response.headers.get("content-language") or "").strip()
        except Exception:
            continue
    return ""


def _same_document(url, final_url):
    return url.split("#")[0] == final_url.split("#")[0]


# ── the mirror layout ───────────────────────────────────────────────────────
#
# A rendered capture's assets are identified by URL, not by a path inside a
# source ZIM, so they get their own layout: `_assets/<host>/<path>`, mirroring
# the web. Two properties earn it. Cross-origin assets cannot collide, because
# the host is in the path. And a stylesheet's own relative `url()` refs resolve
# correctly against its stored location without being rewritten one by one —
# the mirror preserves exactly the relationship the CSS was written against.


def _asset_path(url):
    """The in-ZIM path for an absolute URL, or None when it is not a fetchable
    one. Deterministic: the same URL is the same entry, on every run."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    host = _slug(parts.netloc.lower(), "host")
    path = parts.path or "/"
    if path.endswith("/"):
        path += "index"
    segments = [
        _safe_segment(segment)
        for segment in path.lstrip("/").split("/")
        if segment not in ("", ".", "..")
    ]
    if not segments:
        segments = ["index"]
    if parts.query:
        # A query is part of an asset's identity — the same path with two
        # different query strings is two different files often enough (image
        # resizers, cache busters, font subsets) that collapsing them would
        # serve the wrong bytes. It rides as a short digest so the entry path
        # stays a path.
        digest = hashlib.sha1(parts.query.encode("utf-8")).hexdigest()[:8]
        stem, dot, ext = segments[-1].partition(".")
        segments[-1] = f"{stem}.{digest}{dot}{ext}" if dot else f"{stem}.{digest}"
    joined = "/".join(segments)[:_MAX_ASSET_PATH]
    return f"_assets/{host}/{joined}"


def _safe_segment(segment):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", urllib.parse.unquote(segment))
    return (cleaned.strip("_") or "_")[:_MAX_PATH_SEGMENT]


class RenderedAssets:
    """What one rendered page carries into the ZIM, from what the browser
    already fetched.

    The same contract as ``_AssetCarrier``: dedupe by identity, bounded by the
    same three caps, report the mimetypes that actually landed so the ZIM's
    media tags are evidence rather than a guess, and hand each item to whatever
    sink the caller gave — a live Creator for a single page, the crawl's
    ``AssetSpool`` when there is no Creator yet.

    What differs is the identity: a URL, not a path in a source ZIM. That is
    why this is its own class and not a reader plugged into the carrier — the
    carrier resolves references the way a filesystem does, relative to the
    document, and half of what makes a rendered capture worth having is the
    cross-origin third of the page that no relative path can name.

    ``carried`` is the crawl-wide dedupe map, shared across pages, and it is
    keyed exactly as the carrier's is (``"<label>\\n<resolved>"``) so the
    crawl's per-asset progress reporting reads one map whichever engine filled
    it."""

    def __init__(
        self, sink, resources, *, item_factory=None, carried=None, budget=None
    ):
        self._sink = sink
        self._make = item_factory or make_asset_item
        self._resources = resources
        self.carried = {} if carried is None else carried
        self._budget = budget
        self.total_bytes = 0
        self.count = 0
        self.mimetypes = set()

    def carry(self, url, depth=0):
        """Ensure the asset at ``url`` is in the ZIM; return the in-ZIM path it
        landed at, or None when it is not something this capture holds."""
        in_path = _asset_path(url)
        if not in_path:
            return None
        key = _carried_key(in_path)
        if key in self.carried:
            return self.carried[key]
        resource = self._resources.get(url)
        if resource is None:
            # The browser never fetched it: a reference in the markup that was
            # never used (a print stylesheet, a poster the video element
            # ignored), or something that failed. Left external, honestly.
            return None
        if self.count >= _MAX_ASSETS or self.total_bytes >= _MAX_TOTAL_ASSET_BYTES:
            self.carried[key] = None
            return None
        data = resource.read()
        if not data or len(data) > _MAX_ASSET_BYTES:
            self.carried[key] = None
            return None
        mime = resource.mimetype
        if depth == 0 and ("css" in mime or in_path.lower().endswith(".css")):
            # A stylesheet's own url() refs are assets too, and they are where
            # a page's fonts and background images live. One level deep: a
            # sheet that imports a sheet that imports a sheet is a loop waiting
            # to be found by somebody else.
            data = self._rewrite_css(url, in_path, data)
        self.carried[key] = in_path
        self.total_bytes += len(data)
        self.count += 1
        try:
            self._sink(self._make(in_path, mime, data))
        except Exception as e:
            log.debug("could not add %s: %s", in_path, e)
            self.carried[key] = None
            return None
        self.mimetypes.add(mime)
        return in_path

    def _rewrite_css(self, css_url, css_path, data):
        """Carry what a stylesheet references and point it at the carried
        copies. Refs resolve against the stylesheet's OWN url, which is what
        the browser did, and the rewritten reference is relative to the
        stylesheet's place in the mirror — so a sheet moved into the ZIM keeps
        pointing at the same neighbours it always did."""
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception:
            return data
        base_dir = posixpath.dirname(css_path)

        def rewritten(ref):
            ref = (ref or "").strip()
            if not ref or ref.startswith(("data:", "#")):
                return None
            absolute = urllib.parse.urljoin(css_url, ref)
            in_path = self.carry(absolute, depth=1)
            if not in_path:
                return None
            return posixpath.relpath(in_path, base_dir)

        def fix_url(m):
            rel = rewritten(m.group(2))
            return m.group(0) if rel is None else f"url({m.group(1)}{rel}{m.group(1)})"

        def fix_import(m):
            rel = rewritten(m.group(2))
            return (
                m.group(0) if rel is None else f"@import {m.group(1)}{rel}{m.group(1)}"
            )

        text = _CSS_URL_RE.sub(fix_url, text)
        text = _CSS_IMPORT_RE.sub(fix_import, text)
        return text.encode("utf-8")


def _carried_key(in_path):
    """The shared dedupe map's key for an in-ZIM asset path.

    ``"<label>\\n<resolved>"``, matching what ``_AssetCarrier`` writes, because
    the crawl's asset reporting reads that map directly and a second key shape
    would show up as a second dialect in the run pane."""
    rest = in_path[len("_assets/") :]
    label, _sep, resolved = rest.partition("/")
    return label + "\n" + resolved


# ── rendered page → ZIM-ready HTML ──────────────────────────────────────────


def render_rendered_page(assets, html, *, final_url, resolve_link=None):
    """``creator.render_captured_page``'s twin for a rendered capture.

    Same output contract — an HTML document whose assets live in the ZIM, whose
    links are resolved, whose scripts are gone and whose charset tells the
    truth — reached from the other direction. The fast engine resolves
    references the way a browser would have; this one rewrites the references a
    browser already resolved."""
    html = _rewrite_asset_tags(assets, html)
    html = _rewrite_style_blocks(assets, html, final_url)
    html = _rewrite_style_attrs(assets, html, final_url)
    html = _externalize_links(html, final_url, resolve_link)
    return _normalize_charset(_strip_scripts(html))


def _in_zim_ref(in_path):
    """An article lives at ``A/<name>``, so everything else is one level up."""
    return "../" + in_path


def _rewrite_asset_tags(assets, html):
    def fix_tag(m):
        tag = m.group(0)
        is_link = bool(_LINK_TAG_RE.match(tag))
        if is_link and not _carried_link(tag):
            return tag
        for attr in ("src", "poster", "data") if not is_link else ("href",):
            tag = _attr_re(attr).sub(lambda am: _fix_ref(assets, am), tag)
        tag = _attr_re("srcset").sub(lambda am: _fix_srcset(assets, am), tag)
        return tag

    return _ASSET_TAG_RE.sub(fix_tag, html)


def _carried_link(tag):
    m = _REL_ATTR_RE.search(tag)
    if not m:
        return False
    rels = m.group(2).lower().split()
    return any(rel in _CARRIED_LINK_RELS for rel in rels)


def _fix_ref(assets, m):
    in_path = assets.carry(m.group(3).strip())
    if not in_path:
        return m.group(0)
    return m.group(1) + m.group(2) + _in_zim_ref(in_path) + m.group(2)


def _fix_srcset(assets, m):
    parts = []
    for candidate in m.group(3).split(","):
        bits = candidate.strip().split()
        if not bits:
            continue
        in_path = assets.carry(bits[0])
        if in_path:
            bits[0] = _in_zim_ref(in_path)
        parts.append(" ".join(bits))
    return m.group(1) + m.group(2) + ", ".join(parts) + m.group(2)


def _rewrite_css_refs(assets, css, base_url):
    """url() refs inside CSS that lives in the ARTICLE (a <style> block, a
    style attribute) rather than in a carried file: they resolve against the
    page, and the article is one level below the assets."""

    def fix(m):
        ref = (m.group(2) or "").strip()
        if not ref or ref.startswith(("data:", "#")):
            return m.group(0)
        in_path = assets.carry(urllib.parse.urljoin(base_url, ref))
        if not in_path:
            return m.group(0)
        return f"url({m.group(1)}{_in_zim_ref(in_path)}{m.group(1)})"

    return _CSS_URL_RE.sub(fix, css)


def _rewrite_style_blocks(assets, html, final_url):
    def fix(m):
        return (
            m.group(1) + _rewrite_css_refs(assets, m.group(2), final_url) + m.group(3)
        )

    return _STYLE_ELEM_RE.sub(fix, html)


def _rewrite_style_attrs(assets, html, final_url):
    """Inline ``style="…url(…)…"``, which on a rendered page is where a lot of
    the imagery ends up: a hero a script sized and painted itself."""

    def fix(m):
        css = _rewrite_css_refs(assets, m.group(3), final_url)
        return m.group(1) + m.group(2) + css + m.group(2)

    return _STYLE_ATTR_RE.sub(fix, html)


# ── the engine ──────────────────────────────────────────────────────────────


class RenderedCapture:
    """The rendered engine, in the shape every capture engine has.

    ``fetch`` a URL and ``render`` what came back — the same two calls the fast
    engine answers, which is what lets the crawl, the single page and the
    multi-page collection all run either one without knowing which they have.
    See ``zimi.creator.BuiltinCapture`` for the other half of the contract."""

    name = "rendered"
    # A rendered capture is the ANSWER to an application shell, so it must not
    # inherit the fast engine's refusal of one.
    refuses_spa = False

    def __init__(self, *, work_dir=None, budget=None, carried=None, note=None):
        self._session = RenderedSession(work_dir=work_dir, budget=budget, note=note)
        self._budget = budget
        self.carried = {} if carried is None else carried
        self.mimetypes = set()
        self.count = 0
        self._pages = {}  # final URL -> RenderedPage awaiting its render
        self._started = False

    def start(self):
        if not self._started:
            self._session.start()
            self._started = True
        return self

    def fetch(self, url):
        """``(final_url, html, bytes, content_language)`` — the fast engine's
        tuple exactly, so the crawl reads one shape. The page's subresources
        stay spooled here until ``render`` asks for them."""
        self.start()
        page = self._session.capture(url)
        self._pages[page.final_url] = page
        return page.final_url, page.html, page.bytes, page.content_language

    def render(self, target, html, final_url, resolve_link=None):
        """Turn a fetched page into ZIM-ready HTML, carrying its assets into
        ``target`` — an ``(add_item, item_factory)`` pair, so the same call
        serves a live Creator and the crawl's on-disk spool."""
        sink, item_factory = target
        page = self._pages.pop(final_url, None)
        resources = page.resources if page is not None else {}
        assets = RenderedAssets(
            sink,
            resources,
            item_factory=item_factory,
            carried=self.carried,
            budget=self._budget,
        )
        try:
            out = render_rendered_page(
                assets, html, final_url=final_url, resolve_link=resolve_link
            )
        finally:
            self.mimetypes |= assets.mimetypes
            self.count += assets.count
            if page is not None:
                page.discard()
        return out

    def close(self):
        for page in self._pages.values():
            page.discard()
        self._pages.clear()
        self._session.close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()
