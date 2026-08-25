"""The alive capture engine — record the traffic, replay the site.

Zimi's two existing web engines both make a page that cannot move. The fast
one keeps what the server sent and drops the JavaScript because none of it
could run offline. The rendered one keeps what the browser painted and drops
the JavaScript because the painting is already finished. Both are honest and
both have the same ceiling: a carousel does not turn, a menu does not open, a
page that renders itself out of a fetch() stays as blank as its shell.

This engine has no such ceiling, and it gets there by not trying to solve the
problem. Making JavaScript work offline is a replay problem, replay is hard,
and it is hard in ways that took Webrecorder years — URL rewriting inside
strings a script builds at runtime, `fetch` and `XMLHttpRequest` and
`WebSocket` intercepted at the prototype, `history.pushState`, `document.write`
mid-parse. That work exists, it is embedded in every ZIM warc2zim writes, and
Zimi's job is therefore NOT to rebuild it. Zimi's job is to hand warc2zim a
recording good enough to replay from.

So the pipeline is three pieces and Zimi already owned two of them:

  1. RECORD. ``zimi.renderer`` already drives a headless Chromium and already
     sees every response the page receives. Given a ``zimi.warc.WarcWriter``
     it writes them all into a WARC/1.1 file instead of spooling a filtered
     subset — the original document bytes as served, every script, every XHR
     that fired while the page settled, fonts, media, redirects.
  2. CONVERT. ``zimi.importer``'s warc2zim sidecar, unchanged, invoked
     directly rather than through the CLI's filename guessing.
  3. REGISTER. The same non-clobbering output path and incremental library
     registration every other engine finishes through.

WHAT IS DIFFERENT ABOUT THIS ENGINE, so nobody is surprised:

  * It does not write the ZIM. warc2zim does. That means no Zimi Creator, no
    ``X-Zimi-History``, and the provenance is the Scraper suffix — the same
    thinner stamp ``zimi import`` has always left, for the same reason.
  * Its output is a REPLAY, not an article. A ZIM from this engine opens into
    Webrecorder's replay shell and the page inside it behaves like the page
    did. Zimi's own reader chrome, its search index over prose, its
    accessibility rewriter — those work on Zimi-authored articles and this is
    not one. It is a site in a bottle.
  * It needs BOTH halves installed: the browser (Playwright + Chromium) to
    record and the warc2zim sidecar to convert. Either missing is a refusal
    BEFORE any capture work, because spending twenty minutes crawling a site
    and then discovering there is nothing to convert it with is the worst
    possible order to find out.
  * Service workers do not replay, and never will — warc2zim says so itself. A
    site whose content only arrives through one is a site this cannot capture,
    and there is no version of this engine that changes that.

The site crawl runs through ``zimi.crawler``'s frontier untouched: same robots
policy, same politeness interval, same budgets, same cancellation checkpoints,
same SIGINT handling. All of that belongs to the crawl and none of it belongs
to an engine. The one thing that changes is the ending — instead of packaging
spooled HTML into a Creator, the crawl's WARC goes to the sidecar.
"""

import logging
import os
import tempfile
import urllib.parse

import zimi.server as _srv
from zimi.creator import (
    CreateError,
    LANGUAGE_AUTO,
    _finish_output,
    _page_title_from_html,
    _try_register,
    report_blocked,
    resolve_language,
    scratch_dir,
)
from zimi.warc import WarcWriter
from zimi.zimwriter import _slug, scraper_string

log = logging.getLogger("zimi.alive")

ENGINE_NAME = "alive"

# What is missing, said in the form that names the fix. Two independent halves,
# so the message names whichever ones are actually absent rather than the first
# one checked.
BROWSER_HINT = "pip install 'zimi[browser]' && playwright install chromium"
SIDECAR_HINT = "zimi import --setup"
ALIVE_MISSING = (
    "the alive engine needs two things this machine does not have:\n{missing}\n"
    "Until then, capture with the rendered engine — it needs only the browser "
    "and produces a faithful frozen page — or the fast engine, which needs "
    "nothing at all."
)
_MISSING_BROWSER = f"  * a headless browser to record with: {BROWSER_HINT}"
_MISSING_SIDECAR = f"  * the warc2zim sidecar to convert with: {SIDECAR_HINT}"


def alive_status(refresh=False):
    """``(available, missing)`` for the alive engine here.

    ``missing`` is a tuple naming the absent halves — ``()`` when both are
    present, and one or both of ``"browser"`` and ``"sidecar"`` otherwise. Two
    independent facts reported independently, because "not available" with no
    reason is a dead end and the fixes are different commands."""
    missing = []
    if not _browser_here(refresh):
        missing.append("browser")
    if not _sidecar_here():
        missing.append("sidecar")
    return (not missing), tuple(missing)


def alive_available(refresh=False):
    return alive_status(refresh=refresh)[0]


def _browser_here(refresh=False):
    try:
        from zimi.renderer import browser_available

        return bool(browser_available(refresh=refresh))
    except Exception:
        log.exception("alive engine: browser probe failed")
        return False


def _sidecar_here():
    try:
        from zimi.importer import sidecar_status

        return bool(sidecar_status().get("installed"))
    except Exception:
        log.exception("alive engine: warc2zim sidecar probe failed")
        return False


def require_alive():
    """Refuse HERE, before anything is captured, when a half is missing.

    Called at the top of both entry points and nowhere else. The rule this
    enforces is the reason the check is not deferred to the conversion: an
    engine that crawls a site for twenty minutes and only then discovers it
    cannot convert the result has wasted somebody's afternoon and somebody
    else's bandwidth."""
    ok, missing = alive_status()
    if ok:
        return
    lines = []
    if "browser" in missing:
        lines.append(_MISSING_BROWSER)
    if "sidecar" in missing:
        lines.append(_MISSING_SIDECAR)
    raise CreateError(ALIVE_MISSING.format(missing="\n".join(lines)))


# ── the engine ──────────────────────────────────────────────────────────────


class AliveCapture:
    """The recording engine, in the shape every capture engine has.

    ``fetch`` and ``render`` are the same two calls the other engines answer,
    which is what lets the crawl in ``zimi.crawler`` walk a site with this one
    over the identical frontier. What they MEAN is different: the work happens
    entirely in ``fetch``, where the navigation's whole traffic lands in the
    archive, and ``render`` has nothing left to do."""

    name = ENGINE_NAME
    # Recording an application shell is the point — its scripts are what the
    # archive is for.
    refuses_spa = False
    # How the callers tell that this engine's product is a file on disk rather
    # than items in a Creator. Read by name rather than by ``isinstance`` so a
    # future engine that also records is a new attribute value, not a new
    # branch in three modules.
    writes_archive = True

    def __init__(
        self,
        *,
        work_dir=None,
        budget=None,
        carried=None,
        note=None,
        extra_wait=None,
        warc_path=None,
        block_ads=None,
        capture_variants=None,
    ):
        from zimi.renderer import ALIVE_EXTRA_WAIT, RenderedSession

        self._note = note or (lambda _m: None)
        # The archive lives beside the eventual ZIM, never in /tmp — which is
        # RAM on more than one machine Zimi runs on, and a site recording is
        # the last thing that should be held there. scratch_dir creates what it
        # picks and warns if it ever has to reach the temp fallback, so that
        # rule is enforced rather than merely written down.
        work_dir = scratch_dir(work_dir)
        made_warc = warc_path is None
        if warc_path is None:
            fd, warc_path = tempfile.mkstemp(
                prefix=".zimi-alive-", suffix=".warc.gz", dir=work_dir
            )
            os.close(fd)
        self.warc_path = warc_path
        self.warc = WarcWriter(warc_path, software=scraper_string())
        try:
            self._session = RenderedSession(
                work_dir=work_dir,
                budget=budget,
                note=note,
                recorder=self.warc,
                extra_wait=ALIVE_EXTRA_WAIT if extra_wait is None else extra_wait,
                # Blocking matters more here than to a frozen snapshot. A replay
                # cannot answer a request the recording never captured, and an ad
                # or consent endpoint is exactly the class of request a recording
                # has no answer for — so every one of them that a script fires
                # during replay is a call into nothing. Refusing them at capture
                # time means the script is refused instead of ignored, which is a
                # case its own code already handles. Measured on cnn.com: the ZIM
                # came out 41% smaller and replayed no worse.
                block_ads=block_ads,
                capture_variants=capture_variants,
            )
        except BaseException:
            # A half-constructed engine is one nobody will ever close, so the
            # archive must not outlive this frame: close it, and delete it when
            # it was ours to make (a caller-named path is the caller's file).
            try:
                self.warc.discard() if made_warc else self.warc.close()
            except Exception:
                log.exception("could not tidy up a failed alive engine")
            raise
        # The shared-with-the-crawl dedupe map. It stays EMPTY: this engine
        # carries no assets into a ZIM, because the archive already holds every
        # byte and warc2zim decides what becomes an entry. The attribute exists
        # because the crawl reads it, and an engine that answered the crawl's
        # questions with an exception would be a worse kind of honest.
        self.carried = {} if carried is None else carried
        self.mimetypes = set()
        self.count = 0
        self._started = False

    # What the recording refused, read off the session that refused it — the
    # same three attributes ``RenderedCapture`` exposes, so one reporting helper
    # serves both engines.
    @property
    def blocked(self):
        return self._session.blocked

    @property
    def blocked_hosts(self):
        return self._session.blocked_hosts

    @property
    def blocklist(self):
        return self._session.blocklist

    # -- the engine interface ---------------------------------------------
    def start(self):
        if not self._started:
            self._session.start()
            self._started = True
        return self

    def fetch(self, url):
        """Navigate, settle, and write the whole navigation to the archive.

        Returns the fast engine's tuple — ``(final_url, html, bytes,
        language)`` — where ``html`` is the RENDERED DOM. It is not what gets
        stored (the archive holds the document as served, which is what replay
        needs); it is what the crawl reads links and a title out of, and for
        that purpose the rendered DOM is strictly the better source: a
        navigation menu a script built is invisible in the served bytes and
        present here."""
        self.start()
        page = self._session.capture(url)
        # Nothing was spooled — the recorder path collects no resources — but
        # discarding is what makes that a fact rather than an assumption.
        page.discard()
        self.count = self._session.recorded
        return page.final_url, page.html, page.bytes, page.content_language

    def render(self, target, html, final_url, resolve_link=None):
        """Nothing. Deliberately, and this is the whole shape of the engine.

        The other engines turn a fetched page into ZIM-ready HTML here, pulling
        their assets into ``target`` as they go. This one has already written
        everything it will write, into the archive, during ``fetch``. warc2zim
        turns that into a ZIM later, and any HTML this returned would be HTML
        nothing ever reads.

        The signature stays because the crawl calls it, and the return value
        stays truthful — the caller spools it, and the spool is thrown away by
        the alive site path rather than packaged."""
        return html

    def close(self):
        try:
            self._session.close()
        finally:
            self.warc.close()

    def discard(self):
        """Close and delete the archive. For a capture that produced nothing
        worth converting."""
        try:
            self._session.close()
        finally:
            self.warc.discard()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()


# ── the two entry points ────────────────────────────────────────────────────


def _convert(archive, out, *, zim_name, note, **fields):
    """Hand the archive to the sidecar, streaming its output through the job's
    own progress sink so a conversion looks like every other phase rather than
    like a silence."""
    from zimi.importer import convert_archive

    note("converting the recording into a ZIM…")
    convert_archive(archive, out, zim_name=zim_name, sink=note, **fields)
    return out


# What warc2zim will accept in the two metadata fields Zimi fills, measured
# against the sidecar rather than read off its --help (which says 30 for the
# description and means 80). BOTH are hard refusals, not warnings: a title of
# 31 characters does not produce a worse ZIM, it produces no ZIM, and it
# produces it after the crawl rather than before it. "The Rust Programming
# Language — Official Documentation" is 53 characters, which is to say this is
# the common case and not an edge one.
MAX_ZIM_TITLE = 30
MAX_ZIM_DESCRIPTION = 80


def _capped(text, limit, fallback=None):
    """A metadata field cut to what the converter will take, or None when
    there is nothing to say. Cutting is the right call over refusing: an hour
    of crawling must not be lost to a long ``<title>``, and a title that stops
    a few words early still names the thing."""
    value = (str(text or "").strip()) or (str(fallback or "").strip())
    return value[:limit].strip() or None


def _tags():
    """The tag that says what kind of ZIM this is. A replay behaves unlike an
    article ZIM — it opens into a replay shell, its search is warc2zim's, and a
    reader that knows which it is holding can say so."""
    return "_ftindex:yes;_category:other;zimi:alive"


def create_alive_page_zim(
    url,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    extra_wait=None,
    block_ads=None,
    capture_variants=None,
    register=False,
    progress=None,
    **_ignored,
):
    """Record ONE page's whole session and convert it into a replayable ZIM.

    Returns the ``create_*_zim`` summary dict; raises ``CreateError`` with a
    user-facing message on refusal. ``_ignored`` swallows the fast engine's
    HTTP knobs (timeout, max_redirects) so the shared CLI and web plumbing can
    pass one option set to any engine — a browser has its own timeouts and
    follows its own redirects, and pretending otherwise would be a flag that
    does nothing."""
    from zimi.p2p import is_offline

    note = progress or (lambda _m: None)
    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Alive capture needs internet access; folder mode "
            "(zimi create <folder>) works fully offline."
        )
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")
    require_alive()

    out_dir = out_dir or _srv.ZIM_DIR
    capture = AliveCapture(
        work_dir=scratch_dir(out_dir, out_path),
        note=note,
        extra_wait=extra_wait,
        block_ads=block_ads,
        capture_variants=capture_variants,
    )
    out = None
    blocked = {}
    try:
        note(f"fetching {url}")
        final_url, html, _n, clang = capture.fetch(url)
        blocked = report_blocked(capture, note)
        language, language_source = resolve_language(language, html, clang)
        parsed = urllib.parse.urlsplit(final_url)
        zim_title = title or _page_title_from_html(html, parsed.netloc + parsed.path)
        note(f"title: {zim_title}")
        note(f"recorded {capture.count} responses")
        base = _slug(f"{parsed.netloc} {parsed.path}", "page")
        out = _finish_output(out_dir, out_path, base)
        # The browser is finished, and the conversion is about to read the
        # archive — so the archive has to be closed first. Closing the session
        # here rather than in the `finally` also means the conversion, which is
        # the long part, does not run with a Chromium sitting idle beside it.
        capture.close()
        _convert(
            capture.warc_path,
            out,
            zim_name=zim_name_for(final_url, language),
            note=note,
            title=_capped(zim_title, MAX_ZIM_TITLE),
            description=_capped(description, MAX_ZIM_DESCRIPTION, parsed.netloc),
            main_url=final_url,
            language=language,
            tags=_tags(),
            creator_name=creator_name,
            source=final_url,
        )
    except BaseException:
        capture.discard()
        raise
    finally:
        capture.close()
        _remove(capture.warc_path)

    return {
        "path": out,
        "pages": 1,
        "assets": capture.count,
        "main": None,  # warc2zim decides the main path; --url is how it is told
        "registered": _try_register(out) if register else False,
        "url": final_url,
        "engine": ENGINE_NAME,
        "language": language,
        "language_source": language_source,
        **blocked,
    }


def create_alive_site_zim(
    url,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    max_pages=None,
    max_depth=None,
    max_bytes=None,
    delay=None,
    ignore_robots=False,
    timeout=None,
    extra_wait=None,
    block_ads=None,
    capture_variants=None,
    register=False,
    progress=None,
    stop=None,
    **_ignored,
):
    """Record a bounded same-origin crawl into ONE archive and convert it.

    The crawl is ``zimi.crawler``'s crawl: its frontier, its robots policy, its
    politeness clock, its byte budget, its per-page cancellation checkpoint and
    its SIGINT handling, all of it unchanged. This function supplies the engine
    and replaces the ending.

    A crawl STOPPED EARLY still converts. That is the property the per-record
    framing in ``zimi.warc`` exists for, and it is not a nicety: the honest
    outcome of interrupting an eighty-page crawl at page thirty is thirty pages
    in a ZIM, not an error and an empty directory."""
    from zimi.crawler import (
        DEFAULT_DELAY,
        DEFAULT_MAX_BYTES,
        DEFAULT_MAX_DEPTH,
        DEFAULT_MAX_PAGES,
        AssetSpool,
        ByteBudget,
        _crawl,
        _interruptible,
        _origin_of,
        _robots_allows,
        _robots_delay,
        _StopFlag,
        load_robots,
        normalize_url,
        same_origin,
        spool_target,
    )
    from zimi.creator import DEFAULT_FETCH_TIMEOUT, _plural
    from zimi.p2p import is_offline
    import shutil

    note = progress or (lambda _m: None)
    max_pages = DEFAULT_MAX_PAGES if max_pages is None else max_pages
    max_depth = DEFAULT_MAX_DEPTH if max_depth is None else max_depth
    max_bytes = DEFAULT_MAX_BYTES if max_bytes is None else max_bytes
    delay = DEFAULT_DELAY if delay is None else delay
    timeout = DEFAULT_FETCH_TIMEOUT if timeout is None else timeout

    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Alive capture needs internet access; folder mode "
            "(zimi create <folder>) works fully offline."
        )
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")
    if max_pages < 1 or max_depth < 0 or max_bytes < 1 or delay < 0:
        raise CreateError("crawl bounds must be positive")
    require_alive()

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

    out_dir = out_dir or _srv.ZIM_DIR
    budget = ByteBudget(max_bytes)
    capture = AliveCapture(
        work_dir=scratch_dir(out_dir, out_path),
        budget=budget,
        note=note,
        extra_wait=extra_wait,
        block_ads=block_ads,
        capture_variants=capture_variants,
    )
    spool_dir = None
    out = None
    blocked = {}
    pages, reason = [], None
    try:
        seed_id = normalize_url(url)
        note(f"fetching {seed_id}")
        seed_url, seed_text, seed_bytes, seed_clang = capture.fetch(url)
        budget.spend(seed_bytes)
        if not same_origin(seed_url, origin):
            origin = _origin_of(seed_url)  # the seed redirected; that is the site
        language, language_source = resolve_language(language, seed_text, seed_clang)
        if language_source != "requested":
            note(f"content language: {language} (detected from the site)")
        parsed = urllib.parse.urlsplit(seed_url)
        zim_title = title or _page_title_from_html(seed_text, parsed.netloc)
        note(f"title: {zim_title}")
        out = _finish_output(out_dir, out_path, _slug(f"{parsed.netloc} site", "site"))
        # The crawl spools each page's HTML the way it always does. Here that
        # spool is scaffolding rather than product — every byte that will reach
        # the ZIM is already in the archive — but it is what lets this run the
        # crawl UNMODIFIED, and one frontier implementation is worth more than
        # the handful of kilobytes it writes and deletes.
        spool_dir = tempfile.mkdtemp(prefix=".zimi-crawl-", dir=os.path.dirname(out))
        # A caller-owned flag (the web's finish-early control) or our own for
        # the CLI's signals — see create_site_zim, whose contract this shares.
        if stop is None:
            stop = _StopFlag()
        with _interruptible(stop, note):
            pages, reason, _mimes = _crawl(
                seed_id,
                seed_url,
                seed_text,
                spool_dir,
                spool_target(AssetSpool(os.path.join(spool_dir, "assets"))),
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
            del seed_text
            note(
                f"recorded {_plural(len(pages), 'page')} "
                f"({capture.count} responses, {capture.warc.records} records)"
            )
            blocked = report_blocked(capture, note)
            capture.close()  # the archive must be closed before it is read
            _convert(
                capture.warc_path,
                out,
                zim_name=zim_name_for(parsed.netloc, language),
                note=note,
                title=_capped(zim_title, MAX_ZIM_TITLE),
                description=_capped(description, MAX_ZIM_DESCRIPTION, parsed.netloc),
                main_url=seed_url,
                language=language,
                tags=_tags(),
                creator_name=creator_name,
                source=seed_url,
            )
    except BaseException:
        capture.discard()
        raise
    finally:
        capture.close()
        _remove(capture.warc_path)
        if spool_dir:
            shutil.rmtree(spool_dir, ignore_errors=True)

    return {
        "path": out,
        "pages": len(pages),
        "assets": capture.count,
        "main": None,
        "registered": _try_register(out) if register else False,
        "url": seed_url,
        "engine": ENGINE_NAME,
        "bytes": budget.used,
        "stopped": reason,
        "language": language,
        "language_source": language_source,
        **blocked,
    }


def zim_name_for(what, language):
    """The ZIM Name metadata, through the same helper every other engine uses
    — so a re-capture of the same thing is recognised as a new edition of it
    rather than as a second unrelated ZIM."""
    from zimi.zimwriter import zim_name

    return zim_name(what, language)


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass
