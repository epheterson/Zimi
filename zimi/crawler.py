"""Bounded same-origin site capture, and zimit as an optional engine.

``zimi create <url> --site`` walks one origin breadth-first and packages what
it finds as a single ZIM. It is deliberately NOT a browsertrix competitor: no
JavaScript runs, so it covers the server-rendered 70% — documentation sites,
wikis, blogs, forums — and refuses the rest loudly instead of producing a ZIM
full of loading spinners. The SPA check runs on the FIRST page, before a
single further request, because the alternative is spending an hour to
discover the output is worthless.

Every page goes through the SAME pipeline as single-page capture
(``creator.render_captured_page``); the crawl adds only the part that needs
crawl-wide knowledge — a link whose target this crawl captured becomes
internal ZIM navigation, and every other link stays absolute and external.
That knowledge is why the capture is two passes: only once the captured set is
final can the writer tell an internal link from an external one without
guessing at the future.

ALL the network is in the first pass. A page is fetched, rendered, and its
images and stylesheets pulled down immediately, before the crawl moves on —
so when a page is reported captured, nothing about it is still outstanding.
The rendered HTML and the asset bytes go to a spool on disk (one page in
memory at a time, never the whole site) and the write pass reads them back:
disk-bound, seconds, no requests. That ordering is not a performance trick
first and an honesty fix second, it is one change with both effects. Fetching
assets in the pass that has nothing else to do — the crawl spends most of its
time waiting out the politeness delay — is where they were always free; doing
it there is also the only way "this page is done" can be true when it is said.
Resolving links stays in the second pass, because that is the part that
genuinely needs to know the future.

Bounds are enforced as they are spent, not checked afterwards: pages, depth,
a total fetched-byte budget shared by pages and assets, and a polite MINIMUM
INTERVAL between page requests — assets fetched inside that interval ride in
the gap rather than adding to it, so the page cadence the site sees is exactly
what it was and the peak request rate is lower than it used to be (the old
write pass fetched every asset back to back with no delay at all). robots.txt
is honored — including its Crawl-delay when it asks for more patience than the
flag does. SIGINT/SIGTERM finish the page in flight and then write a valid ZIM
of everything captured so far, because a crawl that dies with nothing to show
for forty minutes of traffic is the failure mode zimit is most complained
about for.

The zimit engine (``--engine zimit``) is orchestration only: find a docker
CLI, run ``ghcr.io/openzim/zimit``, stream its progress, move the ZIM it
produced into the library. No zimit code is vendored or imported — it is
GPL-3 and pinned to a single Python minor version, and the dependency
boundary and the license boundary are the same boundary.
"""

import contextlib
import html as _html
import logging
import mimetypes
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from collections import deque

import zimi.server as _srv
from zimi.creator import (
    DEFAULT_ENGINE,
    DEFAULT_FETCH_TIMEOUT,
    DEFAULT_MAX_REDIRECTS,
    LANGUAGE_AUTO,
    SPA_REFUSAL,
    _A_TAG_RE,
    _externalize_links,
    _fetch_html,
    _finish_output,
    _fmt_bytes,
    _HREF_RE,
    _page_title_from_html,
    _try_register,
    _user_agent,
    ARCHIVE_ENGINES,
    AssetSpool,
    capture_engine,
    CreateError,
    looks_like_spa,
    report_blocked,
    resolve_language,
    scratch_dir,
    site_illustration,
    spool_target,
)
from zimi.blocklist import blocked_phrase
from zimi.zimwriter import (
    _plural,
    _slug,
    add_standard_metadata,
    atomic_zim_creator,
    history_record,
    media_tags,
    scraper_string,
    zim_name,
    zim_static_item_class,
)

log = logging.getLogger("zimi.crawler")

# ── crawl bounds ────────────────────────────────────────────────────────────
DEFAULT_MAX_PAGES = 200
DEFAULT_MAX_DEPTH = 5
DEFAULT_MAX_BYTES = 512 * 1024**2  # every byte fetched: pages AND assets
DEFAULT_DELAY = 0.5  # seconds between page requests
ROBOTS_TIMEOUT = 10.0
MAX_ROBOTS_BYTES = 512 * 1024
# The frontier holds URLs we may never capture — some 404, some turn out not
# to be HTML — so it needs slack beyond the page cap. It also needs a ceiling:
# a crawler that remembers every URL it has ever seen is how a Pi runs out of
# memory on a wiki.
FRONTIER_FACTOR = 4

# Query strings are the classic crawler trap: session ids, sort orders, and
# tracking parameters multiply one page into thousands. The rule is that a
# query is part of a page's identity ONLY when it names a page of a sequence;
# everything else is dropped before the URL is fetched or remembered, so
# ?sort=asc and ?sessionid=abc collapse back onto the bare path while
# ?page=2 stays a page in its own right.
PAGINATION_KEYS = frozenset({"page", "p", "pg", "start", "offset"})

# A link is worth fetching unless its extension already says it is not a page.
# The screen names what a page is NOT, never what it is: `.php`, `.aspx` and
# friends are pages, and a rule built on an allowlist of extensions would
# throw away half the server-rendered web on its way past.
_PAGE_MIMES = frozenset({"text/html", "application/xhtml+xml"})
_NON_PAGE_MAJORS = ("image/", "video/", "audio/", "font/")
_NON_PAGE_MIMES = frozenset(
    {
        "application/gzip",
        "application/javascript",
        "application/json",
        "application/octet-stream",
        "application/pdf",
        "application/x-bzip2",
        "application/x-tar",
        "application/xml",
        "application/zip",
        "text/css",
        "text/csv",
        "text/javascript",
        "text/markdown",
        "text/plain",
    }
)

ZIMIT_IMAGE = "ghcr.io/openzim/zimit:latest"
_DOCKER_PROBE_TIMEOUT = 20.0
# Starting a container to read `zimit --help` is slower than inspecting one.
_ZIMIT_HELP_TIMEOUT = 60.0
# warc2zim's flag for appending to the Scraper metadata; zimit forwards it.
SCRAPER_SUFFIX_FLAG = "--scraper-suffix"


def _noop(_message):
    pass


# ── URL handling ────────────────────────────────────────────────────────────


def normalize_url(url):
    """The canonical crawl key for a URL.

    Drops the fragment, lowercases scheme and host, drops a default port, and
    keeps only the pagination query parameters (sorted, so parameter order is
    not an identity). See ``PAGINATION_KEYS`` for why."""
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    port = parts.port
    default = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    if port and not default:
        host = f"{host}:{port}"
    kept = sorted(
        (k, v)
        for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() in PAGINATION_KEYS
    )
    return urllib.parse.urlunsplit(
        (scheme, host, parts.path or "/", urllib.parse.urlencode(kept), "")
    )


def _origin_of(url):
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}"


def same_origin(url, origin):
    """Strict same-origin: scheme AND host AND port. An http link on an https
    site is a different origin and stays external — the alternative is
    silently following a scheme downgrade."""
    return _origin_of(normalize_url(url)) == _origin_of(normalize_url(origin))


def looks_like_a_page(url):
    """False when the URL's own extension already says it is not a document
    (``.png``, ``.zip``, ``.css``). Extensionless and server-script URLs pass
    — the Content-Type check after the fetch is the real gate; this one only
    exists to avoid spending a request to learn what the name already said."""
    guess = mimetypes.guess_type(urllib.parse.urlsplit(url).path)[0]
    if not guess or guess in _PAGE_MIMES:
        return True
    return not (guess.startswith(_NON_PAGE_MAJORS) or guess in _NON_PAGE_MIMES)


def extract_links(page, base_url):
    """Every ``<a href>`` on the page, absolute against ``base_url``.

    A ``<base href>`` element is deliberately ignored: asset resolution
    already resolves against the fetched URL, and honoring it here alone
    would make links and assets disagree about what a relative reference
    means."""
    out = []
    for tagm in _A_TAG_RE.finditer(page):
        hrefm = _HREF_RE.search(tagm.group(0))
        if not hrefm:
            continue
        # Unescaped before it is anything else. An href is HTML text, so a
        # query arrives written `?a=1&amp;b=2`, and a crawl that skips this
        # asks the server for a URL with a literal "&amp;" in it — a 404, or
        # worse, a different page. Same bug as the one that broke every
        # rendered image with a query string; this is the crawl's copy of it.
        val = _html.unescape(hrefm.group("val").strip())
        if not val or val.startswith("#"):
            continue
        head = val.split("/", 1)[0]
        if ":" in head and not val.lower().startswith(("http:", "https:")):
            continue  # mailto:, javascript:, data:, tel:
        out.append(urllib.parse.urljoin(base_url, val))
    return out


# ── budgets and interrupts ──────────────────────────────────────────────────


class ByteBudget:
    """A running total against a ceiling. ``spend`` charges and reports
    whether the budget still holds — charging zero is the pre-flight check."""

    def __init__(self, limit):
        self.limit = limit
        self.used = 0

    def spend(self, n):
        self.used += n
        return self.used <= self.limit

    @property
    def exhausted(self):
        return self.used >= self.limit


class _StopFlag:
    def __init__(self):
        self.hit = False


@contextlib.contextmanager
def _interruptible(flag, note):
    """SIGINT/SIGTERM set ``flag`` instead of killing the process, so the
    crawl can finish the page in flight and still write a valid ZIM. A SECOND
    signal restores the default and aborts for real — a stuck capture must
    always be killable. Signal handlers only exist on the main thread; off it
    this is a no-op and the caller simply runs to completion."""
    installed = {}

    def handle(signum, _frame):
        if flag.hit:  # second signal: hand the process back to the OS
            signal.signal(signum, installed.get(signum, signal.SIG_DFL))
            raise KeyboardInterrupt
        flag.hit = True
        note(
            "interrupt received — finishing the current page, then writing "
            "a ZIM of what is captured (press again to abort)"
        )

    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGINT, signal.SIGTERM):
            try:
                installed[signum] = signal.signal(signum, handle)
            except (ValueError, OSError):  # platform without this signal
                pass
    try:
        yield
    finally:
        for signum, previous in installed.items():
            try:
                signal.signal(signum, previous)
            except (ValueError, OSError):
                pass


# ── robots.txt ──────────────────────────────────────────────────────────────


def load_robots(origin, timeout=ROBOTS_TIMEOUT, note=_noop):
    """Fetch and parse ``<origin>/robots.txt``. Returns a parser, or None when
    the file is absent or unreachable — both of which mean "no rules"."""
    url = origin + "/robots.txt"
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(MAX_ROBOTS_BYTES)
    except urllib.error.HTTPError as e:
        if e.code >= 500:
            note(f"note: {url} returned HTTP {e.code}; crawling as if it were absent")
        return None
    except OSError as e:
        note(f"note: could not read {url} ({e}); crawling as if it were absent")
        return None
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(raw.decode("utf-8", errors="replace").splitlines())
    # crawl_delay() and request_rate() return None unless the parser believes
    # it has read a file — parse() alone does not set that.
    parser.modified()
    return parser


def _robots_allows(robots, url):
    return robots is None or robots.can_fetch(_user_agent(), url)


def _robots_delay(robots, delay, note):
    """The politer of our delay and the site's Crawl-delay."""
    if robots is None:
        return delay
    try:
        asked = robots.crawl_delay(_user_agent())
    except Exception:
        return delay
    if asked and float(asked) > delay:
        note(f"robots.txt asks for a {float(asked):g}s crawl delay — honoring it")
        return float(asked)
    return delay


# ── the crawl ───────────────────────────────────────────────────────────────


def _spool_page(spool_dir, index, text):
    path = os.path.join(spool_dir, f"{index:05d}.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


def _crawl(
    seed_id,
    seed_url,
    seed_text,
    spool_dir,
    target,
    *,
    engine,
    origin,
    robots,
    budget,
    stop,
    max_pages,
    max_depth,
    delay,
    note,
):
    """Breadth-first over one origin, capturing each page COMPLETELY as it
    goes: fetched, rendered, its assets pulled down, page and assets spooled.

    Returns ``(pages, reason, mimetypes)`` where each page is a dict of
    ``keys`` (every normalized URL that should resolve to it), ``final_url``,
    ``depth``, ``title`` and ``spool``. ``reason`` names the bound that ended
    the crawl, or None when the frontier simply ran dry; ``mimetypes`` is what
    the assets turned out to be, which is the evidence behind the ZIM's
    ``_pictures:`` / ``_videos:`` tags.

    The two lines a page produces are the honest bracket around its work:
    ``fetching <id>`` when the request goes out, and ``[n/max] <id>`` when
    the page and everything it references are on disk. Nothing about a page is
    still outstanding once the second line has been printed.

    ``engine`` decides what a page IS — one HTTP fetch, or a browser that runs
    it — and that is the ONLY thing an engine decides. The frontier, the robots
    policy, the politeness interval, the budgets, the cancellation checkpoints
    and these two lines belong to the crawl, and are identical whichever engine
    is doing the walking."""
    pages = []
    seen = set()
    queue = deque()
    reason = None
    carried = engine.carried  # asset key -> in-ZIM path (or None), every page
    reported = set()  # asset keys already announced; see _report_new_assets
    # The page cadence, as a clock rather than as a sleep: the next page
    # request may go out at this time and not before. Asset traffic in the
    # meantime spends the interval instead of extending it.
    next_fetch_at = time.monotonic() + delay

    def enqueue(links, depth):
        if depth > max_depth:
            return
        for link in links:
            if len(seen) >= max_pages * FRONTIER_FACTOR:
                return
            key = normalize_url(link)
            if (
                key in seen
                or not same_origin(key, origin)
                or not looks_like_a_page(key)
            ):
                continue
            if not _robots_allows(robots, key):
                continue
            seen.add(key)
            queue.append((key, depth))

    def capture(keys, final_url, depth, text):
        """Everything one page needs before the crawl may move on."""
        page = {
            "keys": keys,
            "final_url": final_url,
            "depth": depth,
            "title": _page_title_from_html(text, _page_label(final_url)),
        }
        # Links are left absolute here on purpose: which of them are internal
        # is not known until the crawl ends, and the write pass resolves them
        # then. Everything else about the page is finished now.
        html = engine.render(target, text, final_url)
        page["spool"] = _spool_page(spool_dir, len(pages), html)
        pages.append(page)
        # keys[0], not final_url: this is the name the page was announced
        # under, and an asset that claims a parent no row answers to is an
        # asset nothing counts.
        _report_new_assets(carried, reported, keys[0], note)
        note(
            f"  [{len(pages)}/{max_pages}] {keys[0]}  "
            f"({len(queue)} queued, {_fmt_bytes(budget.used)} fetched)"
        )

    seed_keys = [seed_id]
    seed_final = normalize_url(seed_url)
    if seed_final != seed_id:
        seed_keys.append(seed_final)  # the seed redirected; both keys are it
    seen.update(seed_keys)
    enqueue(extract_links(seed_text, seed_url), 1)
    capture(seed_keys, seed_url, 0, seed_text)

    while queue:
        if stop.hit:
            reason = "interrupted"
            break
        if len(pages) >= max_pages:
            reason = f"page cap ({max_pages})"
            break
        if budget.exhausted:
            reason = f"byte budget ({_fmt_bytes(budget.limit)})"
            break
        url, depth = queue.popleft()
        waiting = next_fetch_at - time.monotonic()
        if waiting > 0:
            time.sleep(waiting)
        next_fetch_at = time.monotonic() + delay
        note(f"fetching {url}")
        try:
            final_url, text, nbytes, _clang = engine.fetch(url)
        except CreateError as e:
            log.debug("skipping %s: %s", url, e)
            note(f"skipped {url}: {str(e).splitlines()[0]}")
            continue
        budget.spend(nbytes)
        # A redirect can walk off the origin; the page it landed on is not
        # ours to capture, and its own links certainly are not.
        if not same_origin(final_url, origin):
            log.debug("skipping %s: redirected off-origin to %s", url, final_url)
            note(f"skipped {url}: redirected off-origin")
            continue
        keys = [url]
        final_key = normalize_url(final_url)
        if final_key != url:
            if final_key in seen and any(final_key in p["keys"] for p in pages):
                note(f"skipped {url}: already captured after its redirect")
                continue
            seen.add(final_key)
            keys.append(final_key)
        enqueue(extract_links(text, final_url), depth + 1)
        capture(keys, final_url, depth, text)
    return pages, reason, engine.mimetypes


def _assign_article_paths(pages):
    """Every captured page gets a FLAT article path under ``A/``.

    Flat is not laziness: the shared asset carrier rewrites every reference to
    ``../<in-ZIM path>``, which is correct exactly when an article sits one
    level deep. It also makes a link between two captured pages a bare
    sibling name. Returns the normalized-URL → in-ZIM-reference map that
    resolves links during the write."""
    taken = {"index"}
    by_key = {}
    for i, page in enumerate(pages):
        if i == 0:
            name = "index"  # the seed is the ZIM's main page
        else:
            path = urllib.parse.urlsplit(page["final_url"]).path
            base = _slug(path, "page")
            name = base
            n = 2
            while name in taken:
                name = f"{base}_{n}"
                n += 1
            taken.add(name)
        page["article"] = "A/" + name
        for key in page["keys"]:
            by_key.setdefault(key, name)
    return by_key


def _report_new_assets(carried, seen, page_url, note):
    """Report every asset this page pulled in, as a line per asset naming what
    it was and which page wanted it.

    Read off the carrier's own dedupe map rather than emitted by the carrier,
    for one hard reason: ``_AssetCarrier._carry`` wraps its add_item call in a
    bare ``except Exception``, so a cancellation raised from inside there would
    be swallowed and logged as a failed asset. Out here each line is a real
    cancellation checkpoint, and the whole page's assets are visible at once —
    including the ones that did NOT land, which the carrier records as a None
    and which no other line has ever mentioned.

    ``seen`` is the caller's running set of keys already reported; the map is
    shared across the whole crawl so a site's common stylesheet belongs to the
    first page that wanted it and is not re-reported for every page after.

    Called from the crawl, between a page's last asset landing and the line
    that reports the page captured. That position is the contract: everything
    a page dragged along is on the wire BEFORE the page is called done."""
    for key, in_zim_path in carried.items():
        if key in seen:
            continue
        seen.add(key)
        # The carrier keys by "<label>\n<resolved>", which for a site crawl is
        # the host and the asset's path — together, the asset's identity.
        label, _sep, resolved = key.partition("\n")
        state = "done" if in_zim_path else "failed"
        note(f"    asset {state} {label}/{resolved} for {page_url}")


def _link_resolver(by_key):
    """Turn an absolute link into a sibling article reference when this
    capture holds the target, else None so it stays external. The fragment
    rides along — a deep link into a captured page still lands on its
    anchor."""

    def resolve(absolute):
        target, sep, fragment = absolute.partition("#")
        name = by_key.get(normalize_url(target))
        if not name:
            return None
        return name + (sep + fragment if sep else "")

    return resolve


def create_site_zim(
    url,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    max_pages=DEFAULT_MAX_PAGES,
    max_depth=DEFAULT_MAX_DEPTH,
    max_bytes=DEFAULT_MAX_BYTES,
    delay=DEFAULT_DELAY,
    ignore_robots=False,
    timeout=DEFAULT_FETCH_TIMEOUT,
    max_redirects=DEFAULT_MAX_REDIRECTS,
    engine=DEFAULT_ENGINE,
    block_ads=None,
    capture_variants=None,
    register=False,
    progress=None,
    stop=None,
):
    """Capture a bounded same-origin crawl as one ZIM.

    Returns the ``create_*_zim`` summary dict plus ``"url"`` (the seed's final
    URL), ``"bytes"`` (everything fetched), and ``"stopped"`` (the bound that
    ended the crawl, or None). Raises ``CreateError`` for anything the user
    must fix — offline mode, a non-HTML or SPA seed, a robots.txt that
    disallows the seed, an unwritable output.

    ``stop`` is an optional caller-owned flag in the ``_StopFlag`` shape:
    setting its ``hit`` ends the crawl at the next page boundary and packages
    everything captured so far — exactly what SIGINT does on the CLI, and how
    the web's finish-early control reaches a crawl running on a worker thread,
    where signal handlers do not exist."""
    from zimi.p2p import is_offline

    note = progress or _noop
    # An alive crawl walks THIS frontier — it calls _crawl below with the same
    # bounds and the same politeness — but it ends in a WARC and a warc2zim
    # run rather than in the Creator this function opens. Handed over before
    # anything starts; see zimi.alive.
    if str(engine or "").strip().lower() in ARCHIVE_ENGINES:
        from zimi.alive import create_alive_site_zim

        return create_alive_site_zim(
            url,
            out_dir=out_dir,
            out_path=out_path,
            title=title,
            description=description,
            language=language,
            creator_name=creator_name,
            max_pages=max_pages,
            max_depth=max_depth,
            max_bytes=max_bytes,
            delay=delay,
            ignore_robots=ignore_robots,
            timeout=timeout,
            block_ads=block_ads,
            capture_variants=capture_variants,
            register=register,
            progress=progress,
            stop=stop,
        )
    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Site capture needs internet access; folder mode "
            "(zimi create <folder>) works fully offline."
        )
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")
    if max_pages < 1 or max_depth < 0 or max_bytes < 1 or delay < 0:
        raise CreateError("crawl bounds must be positive")

    origin = _origin_of(url)
    robots = None
    if ignore_robots:
        note(f"warning: ignoring robots.txt on {origin} at your instruction")
    else:
        robots = load_robots(origin, timeout=timeout, note=note)
        if not _robots_allows(robots, url):
            raise CreateError(
                f"{origin}/robots.txt disallows {url} — that is the site asking "
                "not to be crawled. Pass --ignore-robots to override it, and "
                "own that decision."
            )
        delay = _robots_delay(robots, delay, note)

    budget = ByteBudget(max_bytes)
    # Built before the seed is fetched, because the seed is a page like every
    # other one and goes through the same engine. A rendered crawl's browser
    # starts here and lives until the `finally` below, whatever happens in
    # between: one browser for the whole crawl, and never one that outlives it.
    capture = capture_engine(
        engine,
        timeout=timeout,
        max_redirects=max_redirects,
        budget=budget,
        note=note,
        work_dir=scratch_dir(out_dir, out_path),
        block_ads=block_ads,
        capture_variants=capture_variants,
    )
    spool_dir = None
    blocked = {}
    pages, reason, asset_count = [], None, 0
    seen_mimetypes = set()
    try:
        # Announced under the identity every later line will use, so the seed
        # is one row that goes amber then green rather than two rows that
        # disagree about whether "example.com" and "example.com/" are the same
        # page.
        seed_id = normalize_url(url)
        note(f"fetching {seed_id}")
        seed_url, seed_text, seed_bytes, seed_clang = capture.fetch(url)
        budget.spend(seed_bytes)
        if capture.refuses_spa and looks_like_spa(seed_text):
            raise CreateError(SPA_REFUSAL)
        if not same_origin(seed_url, origin):
            origin = _origin_of(seed_url)  # the seed redirected; that is the site
        # The seed decides the crawl's language: it is the page the person
        # named, and a same-origin crawl is overwhelmingly one site in one
        # language.
        language, language_source = resolve_language(language, seed_text, seed_clang)
        if language_source != "requested":
            note(f"content language: {language} (detected from the site)")

        parsed = urllib.parse.urlsplit(seed_url)
        zim_title = title or _page_title_from_html(seed_text, parsed.netloc)
        # What this is going to be called, said out loud while it is being made.
        # The web job lifts it into the run header; the CLI just prints it.
        note(f"title: {zim_title}")
        # The site's icon, fetched here with the rest of the seed's belongings.
        # It used to be read during the write, which made the write pass reach
        # for the network one last time after everything else had stopped — and
        # the claim this capture now makes is that packaging touches nothing.
        illustration = site_illustration(seed_url, timeout, seed_text)
        out = _finish_output(
            out_dir or _srv.ZIM_DIR, out_path, _slug(f"{parsed.netloc} site", "site")
        )
        # The spool lives beside the output so it shares that filesystem's free
        # space — never in /tmp, which is RAM on more than one of Zimi's targets.
        spool_dir = tempfile.mkdtemp(prefix=".zimi-crawl-", dir=os.path.dirname(out))
        spool = AssetSpool(os.path.join(spool_dir, "assets"))
        if stop is None:
            stop = _StopFlag()
        with _interruptible(stop, note):
            pages, reason, seen_mimetypes = _crawl(
                seed_id,
                seed_url,
                seed_text,
                spool_dir,
                spool_target(spool),
                engine=capture,
                origin=origin,
                robots=robots,
                budget=budget,
                stop=stop,
                max_pages=max_pages,
                max_depth=max_depth,
                delay=delay,
                note=note,
            )
            del seed_text  # spooled; the crawl holds one page at a time
            blocked = report_blocked(capture, note)
            by_key = _assign_article_paths(pages)
            resolve = _link_resolver(by_key)
            note(f"packaging {_plural(len(pages), 'page')}…")

            static_cls = zim_static_item_class()
            with atomic_zim_creator(out, language) as creator:
                for packaged, page in enumerate(pages, 1):
                    with open(page["spool"], encoding="utf-8") as fh:
                        html = fh.read()
                    os.remove(page["spool"])
                    # The ONE thing that could not be decided during the crawl:
                    # a link is internal exactly when this capture holds its
                    # target, and that set was not final until now. Everything
                    # else about the page was finished the moment it was
                    # fetched, which is why this loop touches no network.
                    html = _externalize_links(html, page["final_url"], resolve)
                    creator.add_item(
                        static_cls(page["article"], page["title"], html.encode("utf-8"))
                    )
                    # Still per page, and still the write pass's only
                    # cancellation checkpoint — a caller's sink is what raises.
                    # It is no longer where the time goes, though: this loop is
                    # disk and CPU, and it runs at thousands of pages a minute.
                    note(f"  packaged {packaged}/{len(pages)}  {page['article']}")
                asset_count = spool.drain(creator.add_item)
                creator.set_mainpath("A/index")
                add_standard_metadata(
                    creator,
                    title=zim_title,
                    description=description
                    or f"{_plural(len(pages), 'page')} captured from "
                    f"{parsed.netloc} by Zimi",
                    language=language,
                    creator_name=creator_name,
                    source=seed_url,
                    # The HOST alone: a re-crawl of the same site, however
                    # deep it goes this time, is a new edition of this ZIM.
                    name=zim_name(parsed.netloc, language),
                    tags=media_tags(seen_mimetypes),
                    illustration=illustration,
                    history=history_record(
                        "created",
                        "site",
                        f"captured {_plural(len(pages), 'page')} from {seed_url}"
                        + (f" — stopped early at the {reason}" if reason else "")
                        + blocked_phrase(blocked.get("blocked")),
                        counts={
                            "pages": len(pages),
                            "assets": asset_count,
                            "bytes": budget.used,
                        },
                        blocked=blocked.get("blocked"),
                    ),
                )
    finally:
        capture.close()
        if spool_dir:
            shutil.rmtree(spool_dir, ignore_errors=True)

    return {
        "path": out,
        "pages": len(pages),
        "assets": asset_count,
        "main": "A/index",
        "registered": _try_register(out) if register else False,
        "url": seed_url,
        "engine": capture.name,
        "bytes": budget.used,
        "stopped": reason,
        "language": language,
        "language_source": language_source,
        **blocked,
    }


# ── the pre-flight probe ────────────────────────────────────────────────────
#
# A shallow, hard-capped version of the crawl above, run before anybody commits
# to the real one. It answers the question the form cannot: what IS this site,
# where would a crawl go, and roughly how big is that. Every bound here is a
# HARD cap enforced in the loop, not a default a caller may raise — a preview
# that can be talked into a thousand fetches is just a crawl with a nicer name.

PROBE_MAX_FETCHES = 20  # pages the probe will fetch, ever
PROBE_MAX_DEPTH = 2  # link hops it will look down
PROBE_TIMEOUT = 8.0  # per request; a slow site must not hold the pane
PROBE_DEADLINE = 20.0  # wall clock for the whole probe
PROBE_DELAY = 0.1  # politeness between probe requests
PROBE_LINKS_PER_NODE = 12  # unfetched children listed under one page
# There is deliberately NO size estimate here. A depth-2 sample of twenty pages
# can measure documents and cannot see the asset tail behind them, which on a
# real site is most of the bytes — so any projection was a page count times a
# guess, and it was not close. The honest number is the byte counter that runs
# during the capture itself, against real responses. A count of pages IS
# defensible from a sample, and that is what this still reports.


def _probe_path(url):
    """The short label a tree row shows for a URL: its path and pagination
    query, which is all that distinguishes one page of a site from another."""
    parts = urllib.parse.urlsplit(url)
    path = parts.path or "/"
    return path + (("?" + parts.query) if parts.query else "")


def _page_label(url):
    """What to call a page that never said what it was called. Its address,
    host and all — the path alone would leave a site's front page titled "/"."""
    return (urllib.parse.urlsplit(url).netloc or "") + _probe_path(url)


def probe_site(url, *, ignore_robots=False, timeout=PROBE_TIMEOUT):
    """Look at a site the way a crawl would, for at most ``PROBE_MAX_FETCHES``
    pages and ``PROBE_DEADLINE`` seconds, and return what was found.

    The reply carries the link TREE (what the crawl would walk, with real page
    titles for everything actually fetched and bare paths for what was only
    discovered), the robots verdict, and a rough size estimate. It never writes
    anything and never runs an engine — refusing here is the point: a site that
    would fail the real capture fails the preview first, cheaply."""
    from zimi.p2p import is_offline

    if is_offline():
        raise CreateError("ZIMI_OFFLINE is set — refusing to fetch from the network.")
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")

    deadline = time.monotonic() + PROBE_DEADLINE
    origin = _origin_of(url)
    robots = None if ignore_robots else load_robots(origin, timeout=timeout)
    verdict = (
        "ignored" if ignore_robots else ("absent" if robots is None else "allowed")
    )
    if robots is not None and not _robots_allows(robots, url):
        verdict = "disallowed"

    seed_url, seed_text, seed_bytes, seed_clang = _fetch_html(
        url, timeout=timeout, max_redirects=DEFAULT_MAX_REDIRECTS
    )
    if not same_origin(seed_url, origin):
        origin = _origin_of(seed_url)
    language, language_source = resolve_language(LANGUAGE_AUTO, seed_text, seed_clang)

    root = {
        "path": _probe_path(seed_url),
        "url": seed_url,
        "title": _page_title_from_html(seed_text, _probe_path(seed_url)),
        "fetched": True,
        "children": [],
    }
    nodes = {normalize_url(seed_url): root}
    seen = {normalize_url(seed_url)}
    queue = deque()
    total_bytes = seed_bytes
    fetched = 1
    truncated = False

    def discover(node, text, base_url, depth):
        """Attach this page's same-origin links as children, queueing the ones
        the probe may still go and look at."""
        nonlocal truncated
        listed = 0
        for link in extract_links(text, base_url):
            key = normalize_url(link)
            if (
                key in seen
                or not same_origin(key, origin)
                or not looks_like_a_page(key)
            ):
                continue
            if robots is not None and not _robots_allows(robots, key):
                continue
            seen.add(key)
            if listed >= PROBE_LINKS_PER_NODE:
                truncated = True
                continue
            listed += 1
            child = {
                "path": _probe_path(key),
                "url": key,
                "title": "",
                "fetched": False,
                "children": [],
            }
            node["children"].append(child)
            nodes[key] = child
            if depth < PROBE_MAX_DEPTH:
                queue.append((key, depth + 1))

    discover(root, seed_text, seed_url, 0)
    while queue:
        if fetched >= PROBE_MAX_FETCHES or time.monotonic() >= deadline:
            truncated = True
            break
        key, depth = queue.popleft()
        time.sleep(PROBE_DELAY)
        try:
            final_url, text, nbytes, _clang = _fetch_html(
                key, timeout=timeout, max_redirects=DEFAULT_MAX_REDIRECTS
            )
        except CreateError as e:
            log.debug("probe skipping %s: %s", key, e)
            continue
        if not same_origin(final_url, origin):
            continue
        fetched += 1
        total_bytes += nbytes
        node = nodes[key]
        node["fetched"] = True
        node["title"] = _page_title_from_html(text, node["path"])
        discover(node, text, final_url, depth)

    est_pages = min(len(seen), DEFAULT_MAX_PAGES)
    return {
        "url": seed_url,
        "title": root["title"],
        "language": language,
        "language_source": language_source,
        "spa": looks_like_spa(seed_text),
        "robots": verdict,
        "crawl_delay": _robots_delay(robots, 0.0, _noop) or None,
        "fetched": fetched,
        "discovered": len(seen),
        # What this probe itself fetched — a measurement of the sample, never
        # a claim about the capture. See PROBE_LINKS_PER_NODE's neighbours for
        # why there is no projected total here.
        "bytes": total_bytes,
        "est_pages": est_pages,
        "tree": root,
        "truncated": truncated,
    }


# ── zimit as an optional engine ─────────────────────────────────────────────

_DOCKER_MISSING = (
    "zimit needs a docker CLI and this system does not have one.\n"
    "zimit (https://github.com/openzim/zimit) is openZIM's own capture "
    "engine: it drives a real browser, so it handles the JavaScript-built "
    "sites Zimi's own crawler refuses. It ships only as a container image.\n"
    "Install Docker (https://docs.docker.com/get-docker/), or capture the "
    "site with `zimi create <url> --site`, which needs nothing extra and "
    "handles server-rendered sites."
)


def _docker_cli():
    """The docker executable, or None. A seam the tests replace — nothing in
    the suite may reach a real daemon."""
    return shutil.which("docker")


def _run_streaming(cmd, note, timeout=None):
    """Run ``cmd``, streaming each output line to ``note``. Returns
    ``(returncode, tail)``; only the last lines are kept, because a failing
    browser crawl can emit megabytes and the useful part is the end."""
    tail = deque(maxlen=40)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except OSError as e:
        raise CreateError(f"could not run {cmd[0]}: {e}")
    try:
        for line in proc.stdout or ():
            line = line.rstrip("\n")
            tail.append(line)
            note("  " + line)
        proc.wait(timeout=timeout)
    except KeyboardInterrupt:
        proc.terminate()
        raise
    finally:
        if proc.stdout is not None:
            proc.stdout.close()
    return proc.returncode, list(tail)


def _probe(cmd):
    """A quiet yes/no docker probe."""
    try:
        return (
            subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=_DOCKER_PROBE_TIMEOUT,
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def _image_supports_flag(docker, image, flag):
    """Whether the zimit image knows ``flag``. zimit forwards warc2zim's own
    options, but an older image predates the one Zimi wants — so ask, rather
    than let a provenance stamp be the thing that fails a two-hour crawl. Any
    probe trouble reads as "no": the stamp is optional, the crawl is not."""
    try:
        done = subprocess.run(
            [docker, "run", "--rm", image, "zimit", "--help"],
            capture_output=True,
            text=True,
            timeout=_ZIMIT_HELP_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0 and flag in (done.stdout or "") + (done.stderr or "")


def _ensure_image(docker, image, note):
    """Make sure the image is local. A pull is a large download and is never
    started silently — it is announced first, then streamed."""
    if _probe([docker, "image", "inspect", image]):
        return
    note(
        f"{image} is not present locally — pulling it now. It is about a "
        "gigabyte (a full browser), downloaded once."
    )
    rc, tail = _run_streaming([docker, "pull", image], note)
    if rc != 0:
        raise CreateError(
            f"could not pull {image} (docker exited {rc}).\n" + "\n".join(tail[-10:])
        )


def _zimit_command(docker, image, container, tmp_dir, url, opts):
    """The full ``docker run`` argv. Split out so a test can assert the
    contract without a daemon anywhere near it."""
    cmd = [
        docker,
        "run",
        "--rm",
        "--name",
        container,
        # Chrome's default 64 MB of shared memory is the single most common
        # cause of a browser crash mid-crawl.
        "--shm-size=1g",
        "-v",
        f"{tmp_dir}:/output",
        image,
        "zimit",
        "--url",
        url,
        "--name",
        opts["name"],
        "--output",
        "/output",
        "--zim-file",
        opts["zim_file"],
    ]
    for flag, value in (
        ("--title", opts.get("title")),
        ("--description", opts.get("description")),
        ("--creator", opts.get("creator")),
        ("--lang", opts.get("language")),
        # zimit writes the ZIM itself, so the Scraper string is the one piece
        # of provenance Zimi can reach — appended to zimit's own, never
        # replacing it. Omitted entirely when the image predates the flag.
        (SCRAPER_SUFFIX_FLAG, opts.get("scraper_suffix")),
    ):
        if value:
            cmd += [flag, str(value)]
    if not opts.get("site"):
        # zimit crawls a prefix by default; a single page is a scope choice.
        cmd += ["--scopeType", "page"]
    if opts.get("max_pages"):
        # browsertrix's page cap, which zimit forwards to the crawler. Only
        # sent when the user asked for one — zimit's flag surface is ~100
        # options wide and guessing at it fails a whole run.
        cmd += ["--limit", str(opts["max_pages"])]
    cmd += list(opts.get("engine_args") or ())
    return cmd


def create_zimit_zim(
    url,
    *,
    site=False,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language="eng",
    creator_name="Zimi",
    max_pages=None,
    engine_args=(),
    image=ZIMIT_IMAGE,
    register=False,
    progress=None,
):
    """Run openZIM's zimit in a container and adopt the ZIM it produces.

    Orchestration only — Zimi never imports zimit. Returns the usual summary
    dict (``"pages"`` is None: only zimit knows what it captured, and it does
    not report a count Zimi can trust).

    Provenance is thinner here than in Zimi's own engines for the same reason:
    zimit writes the ZIM, so there is no Creator for Zimi to add metadata to
    and no honest count to record. What Zimi can do it does — its name and
    version are appended to the Scraper string the image writes."""
    from zimi.p2p import is_offline

    note = progress or _noop
    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "The zimit engine captures from the internet by definition."
        )
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")

    # "auto" is Zimi's word for "read the page and decide", and Zimi never reads
    # this page — zimit fetches it inside the container. Passing the sentiment
    # through would put `--lang auto` on the command line, where it is not a
    # language at all. Every other engine resolves this against text it has;
    # the one with no text falls back to the documented default instead.
    if str(language or "").strip().lower() in ("", LANGUAGE_AUTO):
        language = "eng"

    docker = _docker_cli()
    if not docker:
        raise CreateError(_DOCKER_MISSING)
    if not _probe([docker, "info"]):
        raise CreateError(
            "docker is installed but its daemon is not responding — start "
            "Docker (or add this user to the docker group) and try again."
        )
    _ensure_image(docker, image, note)

    parsed = urllib.parse.urlsplit(url)
    base = _slug(f"{parsed.netloc} {parsed.path}", "site")
    out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, base)
    # zimit writes into a mounted directory, so it must be a directory Zimi
    # owns and can clean up — not the library, which would briefly hold a
    # half-written ZIM under a name the scanner might pick up.
    os.makedirs(_srv.ZIMI_DATA_DIR, exist_ok=True)
    tmp_dir = tempfile.mkdtemp(prefix="zimi-zimit-", dir=_srv.ZIMI_DATA_DIR)
    container = f"zimi-zimit-{os.getpid()}"
    cmd = _zimit_command(
        docker,
        image,
        container,
        tmp_dir,
        url,
        {
            "name": base,
            "zim_file": os.path.basename(out),
            "title": title,
            "description": description,
            "creator": creator_name,
            "language": language,
            "site": site,
            "max_pages": max_pages,
            "engine_args": engine_args,
            "scraper_suffix": (
                scraper_string()
                if _image_supports_flag(docker, image, SCRAPER_SUFFIX_FLAG)
                else None
            ),
        },
    )
    note(f"running zimit: {' '.join(cmd)}")
    try:
        try:
            rc, tail = _run_streaming(cmd, note)
        except KeyboardInterrupt:
            _probe([docker, "rm", "-f", container])
            raise CreateError(
                "interrupted — the zimit container was stopped and no ZIM was "
                "written. zimit cannot resume a partial crawl."
            )
        if rc != 0:
            raise CreateError(
                f"zimit exited {rc} and produced no ZIM. Its last output:\n"
                + "\n".join(tail[-15:])
            )
        produced = sorted(f for f in os.listdir(tmp_dir) if f.endswith(".zim"))
        if not produced:
            raise CreateError(
                "zimit finished but left no .zim file behind. Its last output:\n"
                + "\n".join(tail[-15:])
            )
        shutil.move(os.path.join(tmp_dir, produced[0]), out)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "path": out,
        "pages": None,
        "assets": None,
        "main": None,
        "registered": _try_register(out) if register else False,
        "url": url,
        "engine": "zimit",
    }


def parse_size(text):
    """A byte count, plainly or with a unit suffix: ``512MiB``, ``2g``,
    ``1048576``. Raises ``CreateError`` on anything else.

    The ``i`` is respected rather than discarded: ``512MiB`` is 536,870,912 and
    ``512MB`` is 512,000,000, which is what those two spellings mean. Both used
    to be read as binary, so a budget written 500M produced a file the rest of
    Zimi then reported as 524 MB — the same units disagreement, arriving from
    the one direction where the user had actually said what they meant."""
    raw = str(text).strip().lower().replace("_", "")
    binary = "i" in raw
    base = 1024 if binary else 1000
    units = {"": 1, "b": 1, "k": base, "m": base**2, "g": base**3, "t": base**4}
    for suffix in ("ib", "b"):
        if raw.endswith(suffix) and len(raw) > len(suffix):
            raw = raw[: -len(suffix)]
    number, unit = raw, ""
    if raw and raw[-1] in units and raw[-1].isalpha():
        number, unit = raw[:-1], raw[-1]
    try:
        value = int(float(number) * units[unit])
    except (ValueError, KeyError):
        raise CreateError(f"not a byte size: {text} (try 512MiB, 2G, or 1048576)")
    if value < 1:
        raise CreateError(f"byte size must be positive: {text}")
    return value
