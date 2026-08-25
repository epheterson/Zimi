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
  * Media is carried WHOLE. Chromium streams video in ranges, so the body it
    holds for such a response is the first few kilobytes; those responses are
    asked for again in full rather than stored truncated, because a hero video
    is usually the largest thing a page is remembered for. A <video> that was
    playing — or that is muted with no controls, which is what every
    background animation on the web looks like — keeps its playback state, so
    the page does not open on an empty grey box where its hero used to be.
  * SCRIPTS ARE STRIPPED. This is a frozen snapshot: pixel-faithful where the
    page had finished painting, and inert. A carousel does not turn, a menu
    that needs JavaScript to open does not open, and a page that renders
    nothing until a fetch() resolves stays as blank as it was at capture. Full
    interactive replay is what WARC and zimit exist for (see zimi.alive); this
    engine sets its ceiling out loud rather than shipping half a browser and
    hoping.

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
import html as _html
import logging
import mimetypes
import os
import posixpath
import re
import shutil
import signal
import tempfile
import threading
import time
import urllib.parse

from zimi.blocklist import host_of as _host_of, load as _load_blocklist
from zimi.creator import (
    CreateError,
    _CSS_URL_RE,
    _fmt_bytes,
    _externalize_links,
    _normalize_charset,
    _strip_scripts,
)
from zimi.zimwriter import (
    _MAX_ASSET_BYTES,
    _MAX_ASSETS,
    _MAX_TOTAL_ASSET_BYTES,
    _slug,
    _split_srcset,
    attr_quote,
    attr_re,
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
# The lazy-load scroll pass: how long it waits at each stop for the images that
# step revealed, and the two bounds that stop it.
#
# It used to stop after a fixed twelve viewport-heights, which on any real
# front page means stopping a sixth of the way down. CNN's home page renders
# 56,000px tall; twelve steps of a 900px viewport walked 9,720 of them, so the
# engine only ever ASKED for the images in the top 17% and the archive held
# thirty entries where the fast engine's held three hundred and eighty. The
# scroll is the one thing that decides which pictures a rendered capture has,
# so it now runs until it reaches the bottom.
#
# Bounded by distance and by time rather than by step count, because those are
# the two things actually worth protecting: an infinite-scroll feed that grows
# a screen every time one is revealed would otherwise never end, and neither
# bound cares how tall a viewport happens to be.
SCROLL_PAUSE = 0.35
MAX_SCROLL_PX = 150_000
MAX_SCROLL_SECONDS = 45.0
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

# ── how much a rendered capture may carry ───────────────────────────────────
#
# Wider than the bookmark exporter's caps, which is where the shared numbers
# come from. That exporter carries the illustrations of articles already in
# somebody's library; this engine carries the whole of a page as a browser
# rendered it, and on the modern web the single most memorable thing on a page
# is often a video several megabytes long. Refusing it would leave a hole
# exactly where the fidelity was supposed to be. The peak MEMORY is still one
# asset — everything is spooled to disk as it arrives — and a site crawl is
# still bounded by its own byte budget on top of these.
MAX_ASSET_BYTES = max(_MAX_ASSET_BYTES, 32 * 1024**2)
MAX_TOTAL_ASSET_BYTES = max(_MAX_TOTAL_ASSET_BYTES, 192 * 1024**2)
# What one JOB may hold on disk between fetching a page and writing it. A crawl
# writes each page as it goes and never accumulates; a multi-page capture must
# fetch every page before it can name the ZIM, so its media waits. This is the
# ceiling on that wait — generous, and finite, which is the part that matters on
# a Pi whose ZIM directory is the same disk everything else lives on.
SPOOL_MAX_BYTES = 512 * 1024**2
# A ranged reply. Chromium asks for media this way, so what it holds for such a
# response is a slice of the file rather than the file.
PARTIAL_CONTENT = 206

# ── ad and tracker blocking ─────────────────────────────────────────────────
#
# On by default for both browser engines. See zimi.blocklist for the list, its
# provenance and how a machine overrides it; the mechanism is one route handler
# installed on the context, which is the earliest point at which a request can
# be refused — earlier than the recorder, earlier than the subresource spool, so
# neither of them ever sees a blocked request at all.
BLOCK_ADS_DEFAULT = True
# What the browser is told a blocked request failed with. Chromium's own code
# for "the client refused this", which is what an ad blocker returns and what
# the scripts on an ad-funded page already have a fallback path for. Failing
# IMMEDIATELY and with a reason is the part that matters: a script handed an
# error takes its error branch, where a request left to hang leaves the page
# that is waiting on it still waiting.
BLOCK_ABORT_CODE = "blockedbyclient"

# ── recording bounds (the alive engine; see zimi.alive) ─────────────────────
#
# A RECORDING session keeps the traffic rather than the painting, so its bounds
# are different bounds. They live here because they are properties of the
# navigation, not of the conversion that happens afterwards.

# The extra quiet time a recording pass allows after everything the snapshot
# engine waits for. A frozen snapshot only needs the pixels; a recording needs
# the deferred fetch that populates a carousel three seconds in, because the
# script that asked for it WILL ask again during replay and there has to be an
# answer. Zero is a legal setting and means "no extra wait".
ALIVE_EXTRA_WAIT = 3.0
# The largest single response that goes into an archive. Far larger than the
# snapshot engine's per-asset cap, because this is the mechanism by which a
# page works rather than a picture on it: a 4MB JavaScript bundle is over the
# snapshot cap and is the entire application. The ceiling exists so one
# hero-video autoplay cannot turn a page capture into a gigabyte.
ALIVE_MAX_RESPONSE_BYTES = 96 * 1024 * 1024
# URL schemes that are not traffic. A data: URL was never fetched, a blob: is
# something the page made out of bytes it already had, and neither has a server
# that could be replayed.
ALIVE_SKIP_SCHEMES = ("data:", "blob:", "about:", "chrome-extension:", "file:")
# How long a media re-fetch gets (see _refetch_partials). Longer than a
# subresource deserves and shorter than forever: this is a whole video file,
# and the capture is already finished waiting for everything else.
ALIVE_REFETCH_TIMEOUT = 60.0

# The RESPONSIVE VARIANTS a recording must hold and a navigation never fetches.
#
# A browser asks for exactly one image out of a `srcset` — the one that suits
# the viewport it has and the pixel ratio it renders at. A recording that keeps
# only the traffic therefore holds one candidate out of five, and the replay is
# perfect on a screen shaped like the recorder's and broken on every other one:
# apple.com on a 2x display asks for `..._large_2x.jpg`, which a 1x capture
# never saw, and the page comes up with holes in it. The DOM is the record of
# what could be asked for, so after the page settles every candidate in it is
# enumerated and the ones the navigation missed are fetched deliberately.
#
# Both caps are per navigation. The count keeps a gallery page from turning
# into a thousand small requests; the byte cap is what stops a page whose
# candidates are all 8MB from quietly tripling the archive. Neither is a
# quality knob — a capture that hits them is one that recorded the traffic and
# the first N variants, which is still strictly more than it held before.
ALIVE_MAX_VARIANTS = 240
ALIVE_VARIANT_MAX_BYTES = 64 * 1024 * 1024
# One variant is a picture on a page that has already finished loading. It gets
# less patience than a whole video and more than nothing.
ALIVE_VARIANT_TIMEOUT = 20.0
# How many elements the computed-style sweep looks at. Bounded because the
# sweep is the one part of the enumeration whose cost scales with the DOM
# rather than with the number of images, and a 50,000-node page is a real thing.
ALIVE_VARIANT_SCAN_ELEMENTS = 4000
# On by default: a recording that replays correctly on somebody else's screen
# is worth more than a smaller one that does not, and the reader's screen is
# never the recorder's. Off is a real choice rather than a penny-pinch —
# capturing for a known display, or for a bunker where the bytes are the
# binding constraint — and it costs exactly the sizes this viewport skipped.
VARIANT_SWEEP_DEFAULT = True

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

# Chromium's headless build says so in its user agent, and that one word is the
# cheapest bot signal on the web. See ``_user_agent`` for why it comes out.
_HEADLESS_TOKEN_RE = re.compile(r"HeadlessChrome", re.IGNORECASE)

# What a browser reports for something it will render as a page. Anything else
# under ``document.contentType`` means the server answered with a file, not a
# site — see ``_refused_page``.
_PAGE_CONTENT_TYPES = frozenset(
    {
        "text/html",
        "application/xhtml+xml",
        "application/xml",
        "text/xml",
        "image/svg+xml",
    }
)

_CSS_IMPORT_RE = re.compile(r"""@import\s+(["'])([^"']+)\1""", re.IGNORECASE)
# The tags whose refs are ASSETS. `<a href>` is deliberately not here: a link
# is resolved by the caller, which is the only party that knows whether this
# capture holds the far end.
_ASSET_TAG_RE = re.compile(
    r"<(?:img|source|video|audio|track|embed|link|object)\b[^>]*>", re.IGNORECASE
)
_LINK_TAG_RE = re.compile(r"<link\b", re.IGNORECASE)
_STYLE_ATTR_RE = attr_re("style")
_STYLE_ELEM_RE = re.compile(
    r"(<style\b[^>]*>)(.*?)(</style\s*>)", re.IGNORECASE | re.DOTALL
)
# Which <link rel> values name something a reader still needs offline. Anything
# else a link element points at (preload, prefetch, dns-prefetch) is an
# instruction to a live browser about a file it is about to want, and offline it
# is a dangling reference at best.
_CARRIED_LINK_RELS = ("stylesheet", "icon", "apple-touch-icon", "mask-icon")
_REL_ATTR_RE = attr_re("rel")


# Was a second, quoted-only copy of this with its own cache. It could not see
# `<img src=/a.png>` and it read `data-src` as `src`. One builder now, in
# zimwriter, where every other capture path can reach it.
_attr_re = attr_re


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

# Every image URL this document could ever ask for, absolute. Runs in the page
# after it has settled and BEFORE _PREPARE_JS, which destroys most of what this
# reads (it collapses srcset to the one chosen candidate and removes the
# <picture> sources entirely). Takes the element cap as its argument.
#
# Four sources, because that is where the web keeps its alternates: the srcset
# attributes on <img> and on <picture><source>, the imagesrcset of a preload
# link, the url() tokens of picture-bearing CSS declarations in every
# stylesheet this document is allowed to read, and the computed backgrounds
# actually applied to elements — the last of which is what catches a background
# whose stylesheet is cross-origin and therefore unreadable rule by rule.
# Splitting a srcset, in the browser, to the same spec as zimwriter's
# ``_split_srcset``. Spliced into every script below that has to read one.
#
# `srcset.split(',')` is wrong and it is wrong in a way that only shows up on
# real sites: a URL may CONTAIN commas, and CNN's image API puts three in every
# one of them (`?c=16x9&q=h_720,w_1280,c_fill/f_webp`). Split on the bare comma
# and a single candidate becomes three fragments — one truncated URL and two
# pieces of query string, of which `c_fill/f_webp` was dutifully fetched,
# 404ed, and recorded into an archive.
#
# The spec's rule is positional, not delimiter-based: skip leading whitespace
# and commas, take the run of non-whitespace as the URL, and everything up to
# the next comma after THAT is the descriptor. This is the fourth home of one
# bug — two in Python, two in JavaScript that no search for the Python function
# would ever have found — so it lives in exactly one string now.
_SRCSET_SPLIT_JS = r"""
  const splitSrcset = (value) => {
    const s = String(value || '');
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && (/\s/.test(s[i]) || s[i] === ',')) i++;
      if (i >= s.length) break;
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      const url = s.slice(start, i);
      const descStart = i;
      while (i < s.length && s[i] !== ',') i++;
      out.push({ url: url, descriptor: s.slice(descStart, i).trim() });
    }
    return out;
  };
"""

_IMAGE_CANDIDATES_JS = r"""(maxElements) => {
  SRCSET_SPLIT
  const seen = new Set();
  const out = [];
  const add = (raw, base) => {
    if (!raw) return;
    const value = String(raw).trim().replace(/^["']|["']$/g, '');
    if (!value || value.startsWith('data:') || value.startsWith('#')) return;
    let href;
    try { href = new URL(value, base || document.baseURI).href; } catch (e) { return; }
    if (!/^https?:/i.test(href) || seen.has(href)) return;
    seen.add(href);
    out.push(href);
  };
  const addSrcset = (value, base) => {
    if (!value) return;
    splitSrcset(value).forEach(c => add(c.url, base));
  };

  document.querySelectorAll('img').forEach(img => {
    add(img.getAttribute('src'));
    addSrcset(img.getAttribute('srcset'));
    if (img.currentSrc) add(img.currentSrc);
  });
  document.querySelectorAll('source[srcset]').forEach(s => addSrcset(s.getAttribute('srcset')));
  document.querySelectorAll('link[as="image"][href], link[imagesrcset]').forEach(l => {
    add(l.getAttribute('href'));
    addSrcset(l.getAttribute('imagesrcset'));
  });
  document.querySelectorAll('[poster]').forEach(el => add(el.getAttribute('poster')));

  // The CSS half. Only the properties that name a picture are read: a sweep of
  // every url() in every rule would also drag in every font weight the site
  // ships and none of them are what is missing.
  const PROPS = ['background-image', 'background', 'mask-image',
                 '-webkit-mask-image', 'border-image-source',
                 'list-style-image', 'content'];
  const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const fromValue = (value, base) => {
    if (!value || value.indexOf('url(') < 0) return;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(value)) !== null) add(m[2], base);
  };
  const walkRules = (rules, base) => {
    for (const rule of rules) {
      if (rule.style) PROPS.forEach(p => fromValue(rule.style.getPropertyValue(p), base));
      let nested = null;
      try { nested = rule.cssRules; } catch (e) { nested = null; }
      if (nested) walkRules(nested, base);
    }
  };
  Array.from(document.styleSheets).forEach(sheet => {
    let rules = null;
    // A cross-origin sheet throws here rather than answering. That is not an
    // error: the computed-style sweep below sees what it applied.
    try { rules = sheet.cssRules; } catch (e) { return; }
    if (rules) walkRules(rules, sheet.href || document.baseURI);
  });
  const elements = Array.from(document.querySelectorAll('*')).slice(0, maxElements);
  elements.forEach(el => {
    [null, '::before', '::after'].forEach(pseudo => {
      let style;
      try { style = getComputedStyle(el, pseudo); } catch (e) { return; }
      if (!style) return;
      // Computed values are already absolute.
      PROPS.forEach(p => fromValue(style.getPropertyValue(p), document.baseURI));
    });
  });
  return out;
}"""

# How much of the viewport a `position: fixed` element must cover before the
# snapshot treats it as something laid OVER the page rather than part of it.
# High on purpose: a floating share bar or a sticky footer is under this, and
# only a modal or its backdrop is over it.
_OVERLAY_VIEWPORT_SHARE = 0.55

_PREPARE_JS = r"""() => {
  SRCSET_SPLIT
  // -- what is covering the page ----------------------------------------
  //
  // A consent modal in an ARCHIVE is dead furniture. Its buttons call scripts
  // that were stripped, it sets a cookie nothing will ever read, and it sits
  // at z-index 999999 over the article the person actually captured — so a
  // ZIM that keeps it is a ZIM whose content can never be reached. CNN's is a
  // classless <div>, 1280x900, fixed: exactly what this removes.
  //
  // Removing it agrees to NOTHING. Nothing is clicked, no consent is given,
  // no cookie is set and no request is sent. This deletes an element that
  // cannot function offline, which is the same judgement already applied to
  // every <script> on the page. Auto-clicking "Agree" would be a different
  // act entirely — that one is the user's to make, and Zimi does not make it.
  //
  // `fixed` only, never `sticky`: CNN's own masthead is a sticky header at
  // z-index 9998 and belongs in the capture. And an EMPTY fixed box goes too,
  // whatever its size — that is an ad slot whose ad was blocked at capture
  // time, and it renders in the archive as a black bar over the headline.
  const covered = window.innerWidth * window.innerHeight * OVERLAY_SHARE;
  const overlays = [];
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const blocking = r.width * r.height >= covered;
    const hollow = !(el.innerText || '').trim() && !el.querySelector('img, video, canvas, svg');
    if (blocking || hollow) overlays.push(el);
  });
  // Innermost first, so removing a backdrop never orphans a child this was
  // also going to count.
  overlays.forEach(el => { if (el.isConnected) el.remove(); });

  // A modal locks the page behind it, and the lock outlives the modal: a body
  // left at `overflow: hidden` is a capture nobody can scroll.
  if (overlays.length) {
    [document.documentElement, document.body].forEach(el => {
      if (!el) return;
      el.style.removeProperty('overflow');
      el.style.removeProperty('position');
      el.style.removeProperty('height');
      el.style.setProperty('overflow', 'visible', 'important');
    });
  }

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
    el.setAttribute('srcset', splitSrcset(raw).map(c => {
      if (!c.url) return '';
      let href = c.url;
      try { href = new URL(c.url, document.baseURI).href; } catch (e) {}
      return c.descriptor ? href + ' ' + c.descriptor : href;
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

  // A video that was PLAYING when the snapshot was taken keeps playing in the
  // snapshot. Modern hero sections are a muted, looping <video> that a script
  // starts — the file is carried like any other asset, but offline nothing
  // calls play() and `preload="none"` means the browser will not even fetch
  // it, so the biggest thing on the page renders as an empty box. Copying the
  // playback state the capture actually observed is the honest fix: it says
  // "this was moving when we looked", and it says nothing about videos that
  // were sitting behind a poster waiting to be clicked.
  document.querySelectorAll('video').forEach(v => {
    if (!(v.currentSrc || v.getAttribute('src') || v.querySelector('source[src]'))) return;
    // preload="none" is a bandwidth decision about a file on the far side of
    // the internet. Inside a ZIM the file is already here, and honouring that
    // attribute would mean shipping the bytes and then refusing to show them.
    v.setAttribute('preload', 'auto');
    // Playing at capture time, or decorative by construction — muted with no
    // controls is the shape of every hero animation on the web, and nobody can
    // press play on it offline because the script that would have is gone.
    if (!v.paused || (v.muted && !v.controls)) {
      v.setAttribute('autoplay', '');
      v.setAttribute('muted', '');     // the only way autoplay is allowed
      v.muted = true;
      v.setAttribute('playsinline', '');
    }
  });

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

# The one tunable the script reads, bound here so the threshold has a single
# home in Python rather than a bare number buried in a JavaScript string. The
# srcset splitter is spliced into both scripts that read a srcset, for the same
# reason: one implementation, not one per script that happens to need it.
_PREPARE_JS = _PREPARE_JS.replace("OVERLAY_SHARE", repr(_OVERLAY_VIEWPORT_SHARE))
_PREPARE_JS = _PREPARE_JS.replace("SRCSET_SPLIT", _SRCSET_SPLIT_JS)
_IMAGE_CANDIDATES_JS = _IMAGE_CANDIDATES_JS.replace("SRCSET_SPLIT", _SRCSET_SPLIT_JS)


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
        """Delete this page's spooled resource files and report how many bytes
        that gave back. Called once the page has been rendered into the ZIM and
        its bytes are somewhere else.

        The number is what keeps the session's spool ceiling honest: it bounds
        what is held AT ONCE, and a crawl that writes each page as it goes
        should never approach it however long it runs."""
        freed = 0
        for resource in self.resources.values():
            freed += resource.size
            try:
                os.remove(resource.path)
            except OSError:
                pass
        self.resources = {}
        return freed


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

    def __init__(
        self,
        *,
        work_dir=None,
        budget=None,
        note=None,
        viewport=VIEWPORT,
        recorder=None,
        extra_wait=0.0,
        block_ads=None,
        capture_variants=None,
    ):
        self._budget = budget
        self._note = note or (lambda _m: None)
        self._viewport = viewport
        # Ad and tracker blocking. None means "the default", which lives in one
        # place (BLOCK_ADS_DEFAULT) rather than in every caller that can leave
        # the question open. The list itself is loaded at start(), not here: a
        # session that is never started must not read two megabytes of gzip.
        self._block_ads = BLOCK_ADS_DEFAULT if block_ads is None else bool(block_ads)
        self._blocklist = None
        self.blocked = 0  # requests refused, this session
        self.blocked_hosts = set()  # the distinct domains they were going to
        # A ``zimi.warc.WarcWriter``, or None. When one is here the session is
        # RECORDING: every response goes into the archive as it stands, and the
        # per-page subresource spool is not built at all — the two are
        # alternatives, and doing both would read every body twice.
        self._recorder = recorder
        # Whether to sweep up the image sizes this viewport did NOT choose.
        # None means the default, in the same one place as block_ads. Off keeps
        # only what this screen actually asked for, which is a smaller archive
        # that replays correctly at THIS width and thins out on a phone.
        self._capture_variants = (
            VARIANT_SWEEP_DEFAULT
            if capture_variants is None
            else bool(capture_variants)
        )
        self._extra_wait = max(0.0, float(extra_wait or 0.0))
        # Chromium's own version string, learned at launch and kept for the
        # provenance record. None until start() runs, and on an engine that
        # never started there is nothing to claim.
        self._browser_version = None
        # Set once behaviors actually ran, so provenance names what
        # revealed the page rather than what was merely installed.
        self._behaviors_version = None
        self.recorded = 0  # responses written to the archive, this session
        # Every URL this session has already put to the archive — recorded,
        # deduplicated, or deliberately skipped. What the variant sweep asks
        # before it fetches anything, so a page that already loaded an image at
        # one size is never asked for it a second time.
        self._archived = set()
        self._pw = None
        self._browser = None
        self._context = None
        self._spool = tempfile.mkdtemp(prefix=".zimi-render-", dir=work_dir)
        self._spooled = 0
        self._spool_bytes = 0
        self._spool_full = False
        self._driver_pid = None
        self._killed = False
        self._closed = False

    @property
    def blocklist(self):
        """The list this session is actually running, or None when it is not
        blocking. Read by the provenance record, which has to name what did the
        refusing rather than only how much it refused."""
        return self._blocklist

    @property
    def tools(self):
        """The outside programs that made this capture, ``{name: version}``.

        Empty until the browser is up, and empty forever on a session that
        never started — which is the honest answer, because a session that
        rendered nothing had no tool do anything. This is what tells a rendered
        capture apart from a builtin one after the fact: the two write
        otherwise identical metadata, so without a named engine version the
        reader is left guessing which one made the file."""
        tools = {"chromium": self._browser_version} if self._browser_version else {}
        if self._behaviors_version:
            tools["browsertrix-behaviors"] = self._behaviors_version
        return tools

    # -- lifecycle ---------------------------------------------------------
    def start(self):
        sync_playwright = _playwright_module()
        if sync_playwright is None:
            self._cleanup_spool()
            raise CreateError(RENDERER_MISSING)
        # This line is also the run pane's cue (zimi.manage derives a structured
        # event from it): Chromium can take many seconds to boot, and until the
        # first page reports, this sentence is the only sign of life there is.
        self._note("starting a headless browser…")
        try:
            # THE EFFICIENCY GUARANTEE: at most one Chromium serves creation at
            # a time. Every engine builds exactly one session per job, and the
            # create queue in zimi.manage is single-slot — a second job waits in
            # line rather than launching a second browser beside this one. (The
            # only other launch in this module is the one-shot availability
            # probe, cached for the life of the process.)
            self._pw = sync_playwright().start()
            self._browser = _launch(self._pw.chromium)
        except Exception as e:
            self._cleanup_spool()
            self._stop_playwright()
            log.debug("browser launch failed: %s", e)
            raise CreateError(
                CHROMIUM_MISSING if self._pw is not None else RENDERER_MISSING
            )
        # Ask the browser what it is, once, while it is up. Playwright reports
        # the real Chromium build rather than the pinned one Zimi asked for, and
        # a capture's provenance should name what actually rendered it. Best
        # effort: an unreadable version costs the record a field, never the run.
        try:
            self._browser_version = str(self._browser.version) or None
        except Exception as e:
            log.debug("browser version is not readable: %s", e)
        self._driver_pid = _driver_pid(self._pw)
        self._context = self._browser.new_context(
            viewport={"width": self._viewport[0], "height": self._viewport[1]},
            user_agent=self._user_agent(),
            ignore_https_errors=False,
        )
        self._context.set_default_timeout(int(NAV_TIMEOUT * 1000))
        self._install_blocking()
        with _sessions_lock:
            _sessions.append(self)
        return self

    def _install_blocking(self):
        """Refuse the ad and tracker traffic, on the CONTEXT rather than on
        each page.

        Context-level because a page is not the only thing that fetches: a
        popup the site opens, an iframe navigating itself, a page this session
        opens later in the same crawl. One handler covers all of them and
        cannot be forgotten at the one call site that makes a new page.

        A failure to install is a capture without blocking, logged — never a
        capture that does not happen. Blocking makes a capture better and it is
        not what anyone asked for when they asked for a capture."""
        if not self._block_ads or self._context is None:
            return
        self._blocklist = _load_blocklist()
        if not self._blocklist:
            log.info("ad blocking is on but the list is empty; nothing to refuse")
            return
        try:
            self._context.route("**/*", self._route)
        except Exception as e:
            log.warning("could not install the ad blocker: %s", _playwright_reason(e))
            self._blocklist = None

    def _route(self, route):
        """One request, judged. Abort what is on the list, let everything else
        through untouched.

        ``continue_`` rather than ``fallback`` because this is the only handler
        on the context, and every exception here is swallowed for a reason that
        is not laziness: a route callback that raises leaves Playwright holding
        a request nobody ever answered, and the page waits for it until the
        navigation times out. Both arms end with the request decided, and
        reading the request's own URL is inside the guard for the same reason:
        a request this cannot even ask about is one it must still answer."""
        url = ""
        try:
            if self._blocklist is not None:
                url = route.request.url or ""
                host = _host_of(url)
                if host and self._blocklist.blocks(host):
                    route.abort(BLOCK_ABORT_CODE)
                    # Counted only once the abort has actually landed. A count
                    # that included the requests it FAILED to block would be
                    # the one number nobody could check.
                    self.blocked += 1
                    self.blocked_hosts.add(host)
                    return
        except Exception as e:
            log.debug("ad blocker could not judge %s: %s", url or "a request", e)
        try:
            route.continue_()
        except Exception as e:
            log.debug("could not continue %s: %s", url, e)

    def _user_agent(self):
        """Chromium's own UA with Zimi's appended, minus the ``Headless``
        token.

        Both halves are true and both are load-bearing: the browser half is
        what makes a site serve the page it would serve a person, and the Zimi
        half — ``Zimi/<version> (+<project url>)`` — is how an operator reading
        their logs can tell exactly who this was and where to complain.

        Dropping ``Headless`` is not the engine pretending to be something it
        is not. It is the same Chromium either way, asking for the same public
        page the person who asked for this capture can open in their own
        browser, and still naming itself in the same breath. What that one word
        changes is not whether Zimi is identifiable but whether the answer is a
        web page at all: CNN's edge serves ``HeadlessChrome`` a 13-byte body
        reading "Unknown Error" under a 200 and no content type, and a capture
        engine whose archives are silently empty on a large slice of the modern
        web is the less honest of the two tools. The check in ``capture()``
        catches the sites that refuse anyway, and says so out loud."""
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
        if not base:
            return None
        return f"{_HEADLESS_TOKEN_RE.sub('Chrome', base)} {USER_AGENT}"

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

    def release(self, freed):
        """Give spool room back. See ``SPOOL_MAX_BYTES``: the ceiling is on
        what a job holds at once, not on what it has ever written, so a crawl
        that discards each page as it packages it never approaches it."""
        self._spool_bytes = max(0, self._spool_bytes - int(freed or 0))
        if self._spool_full and self._spool_bytes < SPOOL_MAX_BYTES:
            self._spool_full = False

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
            # Asked before the settling, not after: there is nothing to wait
            # for on a page the server refused, and fifteen seconds of quiet
            # timeouts and lazy-scrolling an error string is fifteen seconds
            # spent making an empty archive.
            refusal = _refused_page(page)
            if refusal:
                raise CreateError(refusal)
            self._quiet(page, QUIET_TIMEOUT)
            self._reveal(page)
            self._quiet(page, SCROLL_QUIET_TIMEOUT)
            self._image_settle(page)
            _sleep(SETTLE)
            self._settle_further(page)
            final_url = page.url or url
            # The recording happens BEFORE the page is serialized, because
            # serializing MUTATES it — dropping `loading="lazy"` alone can send
            # a browser after images the page itself had decided not to want.
            # The archive is meant to hold what this page did, not what Zimi
            # provoked it into doing on the way out.
            recorded = None
            if self._recorder is not None:
                recorded = self._record(responses)
                # And then the variants the page could have asked for and did
                # not, while the DOM still holds them: _PREPARE_JS below
                # collapses every srcset to the one candidate this viewport
                # chose and deletes the <picture> sources outright.
                self._record_variants(page)
            try:
                html = page.evaluate(_PREPARE_JS)
            except Exception as e:
                raise CreateError(
                    f"cannot read {url} after rendering it: " f"{_playwright_reason(e)}"
                )
            if recorded is None:
                resources, doc_bytes = self._collect(responses, final_url)
            else:
                resources, doc_bytes = {}, recorded
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

    def _reveal(self, page):
        """Make the page show what it is holding back.

        Webrecorder's behaviors when the operator installed them, our scroll
        otherwise. Not a wrapper for its own sake: a plain scroll only reaches
        content that lazy-loads ON SCROLL, and the behaviors catalogue knows the
        rest — feeds that load on intersection, galleries behind "show more",
        threads that expand a reply at a time, and the specific sites everybody
        archives. That knowledge is years of somebody else's archiving and is
        the thing our loop most obviously lacks.

        The fallback is load-bearing rather than polite. The bundle is AGPL and
        Zimi is MIT, so Zimi never ships it — which means a capture must work
        without it, and the scroll below is what "works without it" means."""
        from zimi.behaviors import (
            DEFAULT_RUN_SECONDS,
            RUN_JS,
            behaviors_source,
            behaviors_version,
        )

        source = behaviors_source()
        how = None
        if source:
            try:
                page.add_script_tag(content=source)
                how = page.evaluate(
                    RUN_JS,
                    {
                        "seconds": DEFAULT_RUN_SECONDS,
                        # The behaviors' autofetch pulls resources the browser
                        # never requested — the same job, and the same cost, as
                        # our own variant sweep. So it answers to the same
                        # budget. With the sweep off or its ceiling at zero,
                        # "record what the browser asked for and nothing else"
                        # has to mean that, or the setting is decoration.
                        "autofetch": bool(self._capture_variants)
                        and ALIVE_MAX_VARIANTS > 0,
                    },
                )
            except Exception as e:
                # Anything at all here is survivable: the page is already
                # loaded, and a revealed page is a bonus over a captured one,
                # never a precondition for it.
                log.debug("behaviors did not run: %s", _playwright_reason(e))
                how = None

        # ALWAYS scroll afterwards, even when the behaviors ran and said they
        # finished. They are additive, not a replacement — running them INSTEAD
        # lost a lazy image the plain scroll had always caught, which the suite
        # caught immediately and a user would have found as a missing picture.
        # The two overlap heavily and the scroll is cheap; what matters is that
        # adopting somebody else's coverage never subtracts from our own.
        self._lazy_scroll(page)

        if how is None or how == "not-loaded":
            return
        self._behaviors_version = behaviors_version()
        # "timeout" is the ordinary outcome on a page with no bottom, not a
        # failure — it means the behaviors were still finding things when their
        # time ran out, which is exactly the bound doing its job.
        self._note(
            "used browsertrix-behaviors to reveal the page"
            + (" (stopped at its time limit)" if how == "timeout" else "")
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
            deadline = time.monotonic() + MAX_SCROLL_SECONDS
            while position < (height or 0) and position < MAX_SCROLL_PX:
                if time.monotonic() > deadline:
                    # A feed that grows a screen for every screen revealed is
                    # not a page with a bottom. Say so: a capture that quietly
                    # stopped early is how the last one lost 90% of its images.
                    self._note(
                        f"still scrolling after {int(MAX_SCROLL_SECONDS)}s — "
                        f"keeping the first {position:,}px of the page"
                    )
                    log.debug("lazy-load scroll hit its time bound at %spx", position)
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

    def _settle_further(self, page):
        """The recording pass's extra wait, and the honest edge of v1.

        A snapshot is finished when the pixels stop moving. A RECORDING is
        finished when the page has stopped asking for things, and those are not
        the same moment: a script that populates a carousel on a three-second
        timer will ask again during replay, and an archive that stopped
        listening at two seconds has no answer for it.

        THE TUNING FRONTIER, stated rather than hidden. What this deliberately
        does NOT do is drive the page: no hovering the nav to pull down the
        menu images, no clicking the accordions, no dismissing the cookie
        banner, no stepping the carousel to fetch slides two through five.
        Every one of those would deepen a recording, and every one of them is
        also a way to submit a form, start a checkout or trip a rate limit on
        somebody else's site while nobody is watching. The conservative version
        ships first; interaction simulation is the next round's work, and it
        needs an opt-in and a safety model, not a wider default."""
        if self._extra_wait:
            _sleep(self._extra_wait)
            self._quiet(page, self._extra_wait)

    def _record(self, responses):
        """Every response this navigation produced, into the archive.

        Returns the byte count of the page's OWN document, for the crawl's
        budget. Nothing is filtered by resource type — that filter belongs to
        the snapshot engine, whose stored page cannot use a script and should
        not carry one. Here the script IS the page: strip the JavaScript and
        the XHR it fired and what is left replays as a spinner.

        Bodies are read here rather than in the response handler for exactly
        the reason ``_collect`` reads them here: fetching a body is a round
        trip to the browser, and making that call from inside the callback
        announcing the next response deadlocks the sync API."""
        doc_bytes = 0
        recorder = self._recorder
        if recorder is None:
            return doc_bytes
        partial = []
        for response in responses:
            try:
                url = response.url
                status = response.status
                kind = response.request.resource_type
                method = response.request.method
            except Exception:
                continue
            if url.startswith(ALIVE_SKIP_SCHEMES):
                continue
            # Already handled on an earlier page of this crawl (or earlier in
            # this very pass): the archive deduped the RECORD all along, but
            # the budget still paid for the body every time — every page of a
            # site re-announces the same JS bundles, fonts and stylesheets, so
            # a 3MB bundle billed across forty pages burned ~120MB of budget
            # on bytes stored exactly once. Skipping here also skips the body
            # round trip to the browser, which is wall-clock, not just budget.
            if url in self._archived:
                continue
            # Seen is seen, whatever happens to the body below. A response this
            # skipped for its size or its budget is not one the variant sweep
            # should go and fetch again for the same reasons.
            self._archived.add(url)
            if status == 206:
                # A RANGE. Not the resource — a slice of it, and a browser
                # fetching a video sends several: an opening probe that it
                # usually abandons with an empty body, then whichever pieces it
                # decided to play. Archiving those produces exactly one bad
                # outcome, observed on apple.com: the empty probe lands first,
                # becomes the entry for that URL, and every real slice after it
                # is discarded as a duplicate — so the video 404s on replay
                # while the archive swears it holds it.
                #
                # So no range is ever archived. The URL is remembered instead,
                # and fetched WHOLE below.
                if url not in partial:
                    partial.append(url)
                continue
            body = b""
            # A redirect and a 304 have no body by definition, and asking for
            # one costs a failed round trip per record. Everything else is
            # fetched, including the errors — a 404 that a script probes for is
            # part of how the page behaves, and a replay that answers it with
            # nothing behaves differently.
            if status not in (204, 304) and not (300 <= status < 400):
                body = _body(response) or b""
                if len(body) > ALIVE_MAX_RESPONSE_BYTES:
                    log.debug("not archiving %s: %d bytes", url, len(body))
                    continue
            if self._budget is not None and body and not self._budget.spend(len(body)):
                log.debug("byte budget spent; not archiving %s", url)
                continue
            # A 303 is archived as a 302. warc2zim keeps every other redirect
            # status but silently DROPS 303s (verified empirically against
            # 2.3.1: 301/302/307/308 become redirect entries, 303 vanishes) —
            # and apple.com's shop links answer 303, so every one of them died
            # at the missing-entry page while the crawl swore it followed
            # them. In a replay archive every request is a GET, which is
            # exactly the distinction 303 exists to force, so 302 carries the
            # identical instruction.
            if status == 303:
                status = 302
            try:
                written = recorder.write_exchange(
                    url,
                    status=status,
                    response_headers=_typed(_headers_of(response), url),
                    body=body,
                    method=method,
                    request_headers=_request_headers_of(response),
                    reason=_status_text_of(response),
                )
            except Exception as e:
                # One unwritable record must not lose the other four hundred.
                log.warning("could not archive %s: %s", url, e)
                continue
            if written is not None:
                self.recorded += 1
            if kind == "document":
                doc_bytes = max(doc_bytes, len(body))
        self._refetch_partials(partial)
        return doc_bytes

    def _refetch_partials(self, urls):
        """Fetch WHOLE the resources the browser only ever fetched in ranges.

        This is what puts video into an archive. A browser never asks for a
        media file in one piece — it opens a range, decides how much it wants,
        and asks for slices — so a recording that only listens has, at the end,
        several fragments and no file. The fix is not cleverer bookkeeping over
        the fragments (a replay would still have to serve ranges it was never
        given): it is to ask once, plainly, for the whole thing.

        Every failure here is a debug line and a missing file, never a failed
        capture: this runs after the page is finished, and nothing else depends
        on it."""
        if not urls or self._context is None or self._recorder is None:
            return
        for url in urls:
            self._fetch_into_archive(url, ALIVE_REFETCH_TIMEOUT)

    def _record_variants(self, page):
        """Archive the image variants this DOM could ask for and never did.

        The recording holds the ONE candidate this viewport and this pixel
        ratio chose out of each srcset. Every other candidate is a request the
        replay will make on a differently shaped screen and the archive cannot
        answer — which is the whole of what a person sees as "the images are
        missing", and it is why this sweep is not an optimisation.

        Bounded three ways and none of them is a failure: the count cap, the
        byte cap here, and the crawl's own byte budget underneath. Every miss
        is a debug line — the page is already captured and nothing downstream
        depends on this."""
        # Switched off means this screen only: the archive keeps the candidates
        # the navigation actually fetched and nothing else. The provenance is
        # unaffected either way — the counts have always reported what was
        # really written, not what was attempted.
        if not self._capture_variants:
            return
        if self._recorder is None or self._context is None:
            return
        try:
            candidates = page.evaluate(
                _IMAGE_CANDIDATES_JS, ALIVE_VARIANT_SCAN_ELEMENTS
            )
        except Exception as e:
            log.debug("could not enumerate image candidates: %s", _playwright_reason(e))
            return
        spent = 0
        tried = 0
        found = 0
        for url in candidates or []:
            if url in self._archived or url.startswith(ALIVE_SKIP_SCHEMES):
                continue
            # A candidate on the blocklist is not fetched and is not counted as
            # blocked either: the counters report requests the BROWSER made and
            # this one was never made at all.
            if self._blocklist is not None and self._blocklist.blocks_url(url):
                self._archived.add(url)
                continue
            # The count cap is on ATTEMPTS, not on hits: a page whose
            # candidates all 404 costs exactly as many round trips as one whose
            # candidates all exist, and it is the round trips that need the
            # ceiling.
            if tried >= ALIVE_MAX_VARIANTS or spent >= ALIVE_VARIANT_MAX_BYTES:
                # Said out loud, not just logged. A sweep that stops here has
                # left image sizes out of the archive, and the person reading
                # this ZIM on a phone is the one who finds out — an image whose
                # candidate was never fetched is a 404 at exactly the width
                # their screen picks. "archived 240 variants" with nothing after
                # it reads as completion; CNN's front page offers close to four
                # hundred candidates and this stopped at the ceiling on every
                # run, silently, which is how it stayed invisible.
                stopped = "images" if tried >= ALIVE_MAX_VARIANTS else "bytes"
                self._note(
                    f"stopped sweeping extra image sizes at its {stopped} limit "
                    f"— some sizes are not in this archive"
                )
                log.debug("variant sweep stopped at its cap on %s", page.url)
                break
            tried += 1
            written = self._fetch_into_archive(url, ALIVE_VARIANT_TIMEOUT)
            if written:
                found += 1
                spent += written
        if found:
            self._note(f"archived {found} image variant{'s' if found != 1 else ''}")

    def _fetch_into_archive(self, url, timeout):
        """GET one URL through the page's own context and write what comes
        back. Returns the body size stored, or 0.

        Through the CONTEXT rather than a fresh connection so the request
        carries the cookies and the session the page had — a video behind a
        login, or an image on a host that only answers to a warm session, is
        not something a cold client can fetch.

        Stored as the 200 it is: this asked for the whole resource plainly, and
        the whole resource under its own URL is the only form a replay can
        serve any request out of."""
        if self._context is None or self._recorder is None:
            return 0
        self._archived.add(url)
        try:
            reply = self._context.request.get(url, timeout=int(timeout * 1000))
            status = reply.status
            body = reply.body()
            headers = reply.headers or {}
        except Exception as e:
            log.debug("could not fetch %s: %s", url, _playwright_reason(e))
            return 0
        if not (200 <= status < 300) or not body:
            log.debug("fetching %s returned %s", url, status)
            return 0
        if len(body) > ALIVE_MAX_RESPONSE_BYTES:
            log.debug("not archiving %s: %d bytes", url, len(body))
            return 0
        if self._budget is not None and not self._budget.spend(len(body)):
            log.debug("byte budget spent; not archiving %s", url)
            return 0
        try:
            if self._recorder.write_exchange(
                url,
                status=200,
                response_headers=_typed(headers, url),
                body=body,
                method="GET",
            ):
                self.recorded += 1
        except Exception as e:
            log.warning("could not archive %s: %s", url, e)
            return 0
        return len(body)

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
            mime = _mimetype_of(response, url)
            body = None if status == PARTIAL_CONTENT else _body(response)
            if body is None:
                # A 206, or a body the browser will not hand back. Video is the
                # whole reason this branch exists: Chromium streams media in
                # ranges, so what it holds for that response is the first few
                # kilobytes of the file — storing THAT would put a truncated
                # video in the ZIM under a name that promises a whole one. Ask
                # again for the entire thing, through the same context, so
                # cookies and headers are the ones that worked a moment ago.
                if _declared_size(response) > MAX_ASSET_BYTES:
                    # It already said how big it is and it is over the cap.
                    # Downloading it in full to drop it would be the one
                    # request in this whole engine that buys nothing.
                    log.debug("not re-fetching %s: over the per-asset cap", url)
                    continue
                got = self._refetch(url)
                if got is None:
                    continue
                body, refetched_mime = got
                mime = refetched_mime or mime
            if not body or len(body) > MAX_ASSET_BYTES:
                continue
            if self._budget is not None and not self._budget.spend(len(body)):
                # The job's byte budget is spent. Later pages still render —
                # their text is the point — they simply stop carrying media.
                log.debug("byte budget spent; not keeping %s", url)
                continue
            if self._spool_bytes + len(body) > SPOOL_MAX_BYTES:
                # The floor under every other bound. A crawl has a byte budget
                # and a single page has the asset caps, but a MULTI-page capture
                # has neither — twenty rendered URLs would otherwise be twenty
                # pages' media sitting on disk at once, waiting for a write pass
                # that cannot start until the last one is fetched. Past this the
                # capture keeps going and stops keeping media, which is the same
                # way every other bound here degrades.
                if not self._spool_full:
                    self._spool_full = True
                    log.warning(
                        "rendered capture has spooled %s of subresources; "
                        "keeping no more media for this job",
                        _fmt_bytes(self._spool_bytes),
                    )
                continue
            self._spool_bytes += len(body)
            path = os.path.join(self._spool, f"{self._spooled:06d}.bin")
            self._spooled += 1
            try:
                with open(path, "wb") as fh:
                    fh.write(body)
            except OSError as e:
                log.warning("could not spool %s: %s", url, e)
                continue
            resources[url] = _Resource(url, mime, path, len(body))
        return resources, doc_bytes

    def _refetch(self, url):
        """The whole file, asked for again through the browser's own request
        context. ``(bytes, mimetype)`` or None."""
        if self._context is None:
            return None
        try:
            reply = self._context.request.get(url, timeout=int(NAV_TIMEOUT * 1000))
            if not (200 <= reply.status < 300):
                return None
            body = reply.body()
            mime = (reply.headers.get("content-type") or "").split(";")[0].strip()
            return body, mime.lower()
        except Exception as e:
            log.debug("could not re-fetch %s in full: %s", url, e)
            return None


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


def _refused_page(page):
    """The reason this is not a page worth archiving, or '' when it is one.

    The failure this exists for arrives dressed as a success. A site that does
    not want an automated browser is under no obligation to say 403: CNN's edge
    answers ``HeadlessChrome`` with **HTTP 200**, no content type, and thirteen
    bytes reading "Unknown Error". Every transport-level check passes — the
    navigation resolved, the status is 2xx, nothing raised — and without this
    the engine goes on to scroll, serialize, and package that string into a ZIM
    it reports as finished. The user gets a green tick and an empty archive,
    which is the worst outcome available: a silent failure they only discover
    later, by opening it.

    ``document.contentType`` is the browser's own verdict on what it received,
    after sniffing, so it catches both the server that declares a non-HTML type
    and the one that declares nothing at all. That makes this a fact rather
    than a size heuristic: a legitimately tiny page is still ``text/html`` and
    passes, while a plain-text refusal is caught however long it is."""
    try:
        kind = (page.evaluate("() => document.contentType") or "").lower()
    except Exception as e:
        # A page that cannot answer is not a page this can convict.
        log.debug("could not read the document content type: %s", e)
        return ""
    if not kind or kind in _PAGE_CONTENT_TYPES:
        return ""
    return (
        f"{page.url} did not return a web page — the server answered with "
        f"{kind}, which usually means it refused an automated browser. The "
        f"Fast engine fetches without one and often gets through."
    )


def _body(response):
    try:
        return response.body()
    except Exception as e:  # a redirect, a 204, a body already evicted
        log.debug("no body for %s: %s", getattr(response, "url", "?"), e)
        return None


def _body_length(response):
    body = _body(response)
    return len(body) if body else 0


def _declared_size(response):
    """How big the far end says the whole file is, or 0 when it did not say.

    A ranged reply reports the SLICE in Content-Length and the whole thing in
    Content-Range ("bytes 0-1023/1536130"), so the total is the part after the
    slash — which is exactly the number worth knowing before deciding to fetch
    it all over again."""
    try:
        headers = response.headers
    except Exception:
        return 0
    rng = headers.get("content-range") or ""
    total = rng.rsplit("/", 1)[-1].strip() if "/" in rng else ""
    for value in (total, headers.get("content-length") or ""):
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return 0


def _mimetype_of(response, url=""):
    """What the server said this is, or what its name says it is.

    The fallback matters more than it looks: a ZIM entry's mimetype is what the
    reader serves it as, and "application/octet-stream" on a webm is a video a
    browser will refuse to play."""
    try:
        raw = response.headers.get("content-type") or ""
    except Exception:
        raw = ""
    mime = raw.split(";")[0].strip().lower()
    return (
        mime
        or mimetypes.guess_type(urllib.parse.urlsplit(url).path)[0]
        or ("application/octet-stream")
    )


def _headers_of(response):
    """The response's headers as the browser saw them.

    ``all_headers()`` first: it is the one that reports what actually arrived
    over HTTP/2 and after any redirect, where the cheaper ``headers`` property
    reports Playwright's cached view. Falling back rather than failing, because
    a header set is not worth losing a record over."""
    for reader in ("all_headers", "headers"):
        try:
            value = getattr(response, reader)
            got = value() if callable(value) else value
            if got:
                return got
        except Exception as e:
            log.debug("could not read response headers (%s): %s", reader, e)
    return {}


def _request_headers_of(response):
    """The request's headers. Recorded because a replay is allowed to care:
    the Accept and Sec-Fetch-* set is how a server chose between the AVIF and
    the JPEG, and a record that omits the question keeps only half the
    exchange."""
    try:
        return response.request.headers or {}
    except Exception as e:
        log.debug("could not read request headers: %s", e)
        return {}


def _status_text_of(response):
    try:
        return response.status_text or ""
    except Exception:
        return ""


def _typed(headers, url):
    """The response's headers, with a Content-Type supplied when the server
    sent NONE at all.

    Recorded headers are evidence and this module does not rewrite them — an
    archive that improves on what a site said is an archive that replays
    something the site never sent. Supplying an ABSENT one is the different
    case, and apple.com is the worked example: its CDN serves the homepage's
    hero videos with no Content-Type whatsoever, because a live browser will
    sniff the container and it does not need to be told. A ZIM entry cannot
    sniff. Without this the file lands as application/octet-stream and no
    <video> element will touch it — the bytes are all there and the video is
    dead.

    So: only when the header is missing, only from the extension the site
    itself put in the URL, and never over the top of an answer the server
    actually gave."""
    for name in headers or ():
        if str(name).strip().lower() == "content-type":
            return headers
    guessed, _encoding = mimetypes.guess_type(urllib.parse.urlsplit(url).path)
    if not guessed:
        return headers
    out = dict(headers or {})
    out["Content-Type"] = guessed
    return out


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
        landed at, or None when it is not something this capture holds.

        The URL is unescaped first, and that one call is the difference between
        a rendered CNN capture whose images work and one whose images are all
        broken. References arrive here having been read back out of serialized
        HTML, where ``&`` is written ``&amp;`` — so an image at

            ...x.jpg?c=16x9&q=h_720,w_1280,c_fill/f_webp

        is looked up as ``?c=16x9&amp;q=...``, which is not the URL the browser
        fetched and therefore not a key in the resource map. carry() returns
        None, the rewriter leaves the reference alone, and the archive ships an
        image still pointed at the live internet.

        It is invisible on any URL without a query — which is exactly the shape
        of the evidence: CNN's logo and QR codes resolved into the ZIM while
        every article thumbnail stayed absolute. The fast engine unescapes at
        the same boundary (zimwriter's carry_ref) and its captures were fine,
        which is what made this look like a browser problem for a whole day.

        Done here rather than at each call site because this is the one door:
        markup refs, srcset candidates and CSS urls all come through it."""
        url = _html.unescape(url or "")
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
        if self.count >= _MAX_ASSETS or self.total_bytes >= MAX_TOTAL_ASSET_BYTES:
            self.carried[key] = None
            return None
        data = resource.read()
        if not data or len(data) > MAX_ASSET_BYTES:
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
    rels = m.group("val").lower().split()
    return any(rel in _CARRIED_LINK_RELS for rel in rels)


def _fix_ref(assets, m):
    in_path = assets.carry(m.group("val").strip())
    if not in_path:
        return m.group(0)
    # Written back quoted whatever shape it arrived in: the ref is a ZIM path
    # we chose, so quoting is correct and a bare value may not survive.
    return f'{m.group("pre")}"{_in_zim_ref(in_path)}"'


def _fix_srcset(assets, m):
    """Rewrite each candidate in a stored srcset to the asset the ZIM holds.

    Splits with ``_split_srcset`` and not ``.split(",")`` for the reason that
    cost a day: a candidate URL may contain commas — CNN's image API puts three
    in every one — so the naive split hands ``carry()`` a truncated URL that
    matches nothing, and the shredded fragments are written into the archive as
    if they were image addresses."""
    parts = []
    for url, descriptor in _split_srcset(m.group("val")):
        if not url:
            continue
        in_path = assets.carry(url)
        if in_path:
            url = _in_zim_ref(in_path)
        parts.append(f"{url} {descriptor}".strip())
    return f'{m.group("pre")}"{attr_quote(", ".join(parts))}"'


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
        css = _rewrite_css_refs(assets, m.group("val"), final_url)
        return f'{m.group("pre")}"{attr_quote(css)}"'

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

    def __init__(
        self,
        *,
        work_dir=None,
        budget=None,
        carried=None,
        note=None,
        block_ads=None,
        capture_variants=None,
    ):
        self._session = RenderedSession(
            work_dir=work_dir,
            budget=budget,
            note=note,
            block_ads=block_ads,
            capture_variants=capture_variants,
        )
        self._budget = budget
        self.carried = {} if carried is None else carried
        self.mimetypes = set()
        self.count = 0
        self._pages = {}  # final URL -> RenderedPage awaiting its render
        self._started = False

    # What the session refused, read through the engine. The callers that write
    # provenance and progress lines hold an engine, not a session, and every
    # engine answers the same three questions — see
    # ``zimi.creator.report_blocked``. ``blocklist`` is the LIST that ran, which
    # the creation record needs in order to name what did the refusing.
    @property
    def blocked(self):
        return self._session.blocked

    @property
    def blocked_hosts(self):
        return self._session.blocked_hosts

    @property
    def blocklist(self):
        return self._session.blocklist

    @property
    def tools(self):
        return self._session.tools

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
                self._session.release(page.discard())
        return out

    def close(self):
        for page in self._pages.values():
            self._session.release(page.discard())
        self._pages.clear()
        self._session.close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()
