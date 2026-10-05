"""The Almanac's tables as a real PDF.

The page builds its print document (title page, contents, every tile, the
equations already drawn as MathML, the print rules inlined) and posts it here.
Headless Chromium (renderer.py's, the one captures use) lays it out with the
page's own @page rules and running foot, and the PDF waits under the data dir
for the shell's PDF reader to open it. A phone's own print dialog took the page
before the document was ready; this hands it a finished file instead.

The document is the page's own, but it is still text a client sent: it is
loaded with JavaScript off and every request it would make aborted, so it can
reach nothing. One render at a time, each under a timeout; nothing here takes
the ZIM lock.
"""

import logging
import os
import re
import secrets
import threading
import time

from zimi import renderer

log = logging.getLogger("zimi")

# The largest print document accepted: the whole book with its equations is
# about 1.5 MB, so this is room, not a target.
MAX_PRINT_BYTES = 8 * 1024 * 1024
# How long a finished PDF is kept for the reader (and its Print and Download).
PDF_TTL_SECONDS = 600
# One render's budget, loading through laying out.
RENDER_TIMEOUT_SECONDS = 90
# How long a second request waits for the one rendering before giving up.
RENDER_QUEUE_SECONDS = 30
# Paper the client may ask for; anything else is A4.
PAPER_SIZES = ("A4", "Letter")
# A file name: its characters kept to what a download dialog takes.
MAX_NAME_CHARS = 120
_NAME_DROP = re.compile(r'[\x00-\x1f/\\:*?"<>|]+')
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

_render_lock = threading.Lock()
_files_lock = threading.Lock()
_files = {}  # id -> (path, name, made)
_swept_dir = False


class Busy(Exception):
    """Another render holds the browser."""


def available():
    """Whether Chromium can render here (cached after the first launch)."""
    return renderer.browser_available()


def _dir():
    from zimi import server as _srv

    return os.path.join(_srv.ZIMI_DATA_DIR, "almanac-pdf")


def clean_name(name):
    """A download name: no path or control characters, ends in .pdf."""
    name = _NAME_DROP.sub(" ", str(name or "")).strip(" .")
    name = re.sub(r"\s+", " ", name)[:MAX_NAME_CHARS].strip(" .") or "Almanac tables"
    return name if name.lower().endswith(".pdf") else name + ".pdf"


def sweep(now=None):
    """Remove the PDFs past their time, and on first use any a previous
    run left behind."""
    global _swept_dir
    now = time.time() if now is None else now
    with _files_lock:
        old = [k for k, v in _files.items() if now - v[2] > PDF_TTL_SECONDS]
        paths = [_files.pop(k)[0] for k in old]
        if not _swept_dir:
            _swept_dir = True
            d = _dir()
            try:
                kept = {v[0] for v in _files.values()}
                paths += [
                    os.path.join(d, f)
                    for f in os.listdir(d)
                    if f.endswith(".pdf") and os.path.join(d, f) not in kept
                ]
            except OSError:
                pass
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def lookup(pdf_id):
    """(path, name) of a kept PDF, or None when unknown or expired."""
    sweep()
    if not _ID_RE.match(pdf_id or ""):
        return None
    with _files_lock:
        got = _files.get(pdf_id)
    return (got[0], got[1]) if got and os.path.exists(got[0]) else None


# A maths font the PDF carries itself: the equations are MathML, drawn with
# a system maths font, and a server (the NAS's Docker image) may have none,
# so they would fall back to plain text glyphs. Noto Sans Math (SIL OFL 1.1)
# ships with Zimi and is laid into each document, as data, before it is
# drawn; nothing is fetched.
MATH_FONT = os.path.join(
    os.path.dirname(__file__), "static", "fonts", "NotoSansMath-Regular.ttf"
)
_math_css = None


def _math_style():
    global _math_css
    if _math_css is None:
        try:
            import base64

            with open(MATH_FONT, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            _math_css = (
                "<style>@font-face{font-family:'Zimi Math';src:url(data:font/ttf;base64,"
                + data
                + ") format('truetype')}math{font-family:'Zimi Math','STIX Two Math','Cambria Math',math}</style>"
            )
        except OSError:
            _math_css = ""
    return _math_css


def _with_math_font(html):
    style = _math_style()
    if not style or "<math" not in html:
        return html
    at = html.find("</head>")
    return html[:at] + style + html[at:] if at >= 0 else style + html


def _render(html, paper):
    sync_playwright = renderer._playwright_module()
    if sync_playwright is None:
        raise RuntimeError("playwright is not installed")
    started = sync_playwright().start()
    try:
        browser = renderer._launch(started.chromium)
        try:
            # No script, no network: the document is drawn from what it holds.
            ctx = browser.new_context(java_script_enabled=False, offline=True)
            ctx.route("**/*", lambda route: route.abort())
            page = ctx.new_page()
            page.set_default_timeout(RENDER_TIMEOUT_SECONDS * 1000)
            page.set_content(_with_math_font(html), wait_until="load")
            page.emulate_media(media="print")
            # The maths font loads only once the equations are laid out, after
            # "load": taken before it arrived, every equation was blank but
            # for its fraction bars. (Playwright's evaluate runs with the
            # document's own scripts off.)
            page.evaluate("document.fonts.ready.then(() => document.fonts.size)")
            return page.pdf(
                format=paper,
                print_background=True,
                prefer_css_page_size=True,
                # The running foot is the document's own (@page margin boxes).
                display_header_footer=False,
            )
        finally:
            browser.close()
    finally:
        started.stop()


def make(html, paper, name):
    """Render ``html`` to a kept PDF: (its id, its file name). Raises Busy
    when another render holds the browser past the wait."""
    if paper not in PAPER_SIZES:
        paper = "A4"
    if not _render_lock.acquire(timeout=RENDER_QUEUE_SECONDS):
        raise Busy()
    try:
        sweep()
        data = _render(html, paper)
    finally:
        _render_lock.release()
    d = _dir()
    os.makedirs(d, exist_ok=True)
    pdf_id = secrets.token_urlsafe(18)
    path = os.path.join(d, pdf_id + ".pdf")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    name = clean_name(name)
    with _files_lock:
        _files[pdf_id] = (path, name, time.time())
    return pdf_id, name
