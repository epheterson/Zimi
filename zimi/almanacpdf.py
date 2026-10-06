"""The Almanac's tables as a real PDF.

The page builds its print document (title page, contents, every tile, the
equations already drawn as MathML, the print rules inlined) and posts it here.
Headless Chromium (renderer.py's, the one captures use) lays it out with the
page's own @page rules and running foot, and the PDF waits under the data dir
for the shell's PDF reader to open it. A phone's own print dialog took the page
before the document was ready; this hands it a finished file instead.

The document is the page's own, but it is still text a client sent: it is
loaded with JavaScript off and every request it would make aborted, so it can
reach nothing. Nothing here takes the ZIM lock.

One Chromium draws them all, on a thread of its own (Playwright's sync API
belongs to the thread that started it), kept warm a few minutes after a
render so the next one skips the launch. One render at a time with a short
line behind it; past that the server is busy (a 503 the page retries once).
A render that runs over its time has its browser killed, and the next one
starts a fresh browser. The same document asked again is the PDF already
made, while it is kept.
"""

import atexit
import hashlib
import logging
import os
import queue
import re
import secrets
import signal
import threading
import time
from html import unescape

from zimi import renderer

log = logging.getLogger("zimi")

# The largest print document accepted: the whole book with its equations is
# about 1.5 MB, so this is room, not a target.
MAX_PRINT_BYTES = 8 * 1024 * 1024
# How long a finished PDF is kept for the reader (and its Print and Download).
PDF_TTL_SECONDS = 600
# One render's budget, loading through laying out; past it the browser is
# killed and the next render launches another.
RENDER_TIMEOUT_SECONDS = 90
# Renders that may wait behind the one drawing; one more is told to come back.
QUEUE_DEPTH = 2
# How long a request waits in line for its turn before it is told the same.
RENDER_QUEUE_SECONDS = 30
# When a busy server asks the page to try again (the 503's Retry-After).
RETRY_AFTER_SECONDS = 5
# The warm browser: kept this long after its last render (the launch is a
# second or two of every PDF otherwise), then closed...
BROWSER_IDLE_SECONDS = 180
# ...and launched afresh after this many renders, so what Chromium holds on
# to between documents is given back.
RENDERS_PER_BROWSER = 20
# How often a waiting request looks at the clock.
WAIT_TICK_SECONDS = 0.25
# Paper the client may ask for; anything else is A4.
PAPER_SIZES = ("A4", "Letter")
# A file name: its characters kept to what a download dialog takes.
MAX_NAME_CHARS = 120
_NAME_DROP = re.compile(r'[\x00-\x1f/\\:*?"<>|]+')
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

_files_lock = threading.Lock()
_files = {}  # id -> (path, name, made)
_by_key = {}  # the document's hash -> id, while its PDF is kept
_swept_dir = False


class Busy(Exception):
    """The line is full, or this request waited its time in it."""


class RenderFailed(Exception):
    """The render broke or ran over its time; the message says which."""


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
        for key in [k for k, v in _by_key.items() if v not in _files]:
            del _by_key[key]
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


# The contents' page numbers: the book marks each with the chapter it is for
# (data-pdf-page="tb-ch-1-3", the id its entry links to). A first, plain PDF
# of the laid-out page says where each chapter fell (the named destinations
# Chromium writes for every link target); the numbers are written into the
# same page and the final PDF taken from it. The page is not loaded again.
# Each mark keeps its width either way, so the pages do not move.
_PAGE_MARK_ATTR = 'data-pdf-page="'
_FILL_PAGES_JS = (
    "(p) => document.querySelectorAll('[data-pdf-page]').forEach((e) => {"
    " e.textContent = p[e.dataset.pdfPage] || ''; })"
)
# The maths font loads only once the equations are laid out, after "load":
# taken before it arrived, every equation was blank but for its fraction
# bars. (Playwright's evaluate runs with the document's own scripts off.)
_FONTS_READY_JS = "document.fonts.ready.then(() => document.fonts.size)"
_OBJ_RE = re.compile(rb"(?<![0-9])(\d+) 0 obj\b")
_REF_RE = re.compile(rb"(\d+) 0 R")
_CATALOG_RE = re.compile(rb"/Type\s*/Catalog\b")


def _dict_at(data, pos):
    """The dictionary that starts at ``pos`` (after whitespace), or b''."""
    while pos < len(data) and data[pos : pos + 1] in b" \r\n\t":
        pos += 1
    if data[pos : pos + 2] != b"<<":
        return b""
    depth, i = 0, pos
    while i < len(data) - 1:
        two = data[i : i + 2]
        if two == b"<<":
            depth += 1
            i += 2
        elif two == b">>":
            depth -= 1
            i += 2
            if not depth:
                return data[pos:i]
        else:
            i += 1
    return b""


def _page_order(obj, pages_root):
    """The page objects' numbers in reading order: the page tree walked
    from ``pages_root`` (Pages nodes nest), ``obj(n)`` giving a dict."""
    order, todo, seen = [], [pages_root], set()
    while todo:
        n = todo.pop(0)
        if n in seen:
            raise ValueError("the page tree loops")
        seen.add(n)
        d = obj(n)
        if re.search(rb"/Type\s*/Pages\b", d):
            kids = re.search(rb"/Kids\s*\[([^\]]*)\]", d)
            todo = [
                int(k) for k in _REF_RE.findall(kids.group(1) if kids else b"")
            ] + todo
        else:
            order.append(n)
    return order


def dest_pages(data):
    """{destination name: page number} from a PDF Chromium wrote; {} when
    it has none or reads otherwise. Only the catalog, the page tree and the
    destinations are read."""
    try:
        offs = {int(m.group(1)): m.end() for m in _OBJ_RE.finditer(data)}

        def obj(n):
            return _dict_at(data, offs[n]) if n in offs else b""

        # The newest catalog (an update appends another), and the newest
        # copy of each object: the object whose header comes last before
        # the catalog's /Type is it.
        at_cat = None
        for at_cat in _CATALOG_RE.finditer(data):
            pass
        if not at_cat:
            return {}
        cat = obj(
            max((n for n, o in offs.items() if o <= at_cat.start()), key=offs.get)
        )
        root, dests = re.search(rb"/Pages\s+(\d+) 0 R", cat), re.search(
            rb"/Dests\s+(\d+) 0 R", cat
        )
        if not root or not dests:
            return {}
        at = {n: i + 1 for i, n in enumerate(_page_order(obj, int(root.group(1))))}
        out = {}
        for name, ref in re.findall(
            rb"/([^\s/\[\]<>()]+)\s*\[\s*(\d+) 0 R", obj(int(dests.group(1)))
        ):
            name = re.sub(
                rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), name
            ).decode("utf-8", "replace")
            if int(ref) in at:
                out[name] = at[int(ref)]
        return out
    except (ValueError, KeyError, IndexError):
        return {}


# The PDF's bookmarks. Chromium writes an outline only into a tagged PDF,
# and tagged, the whole book was six times the size and a second and a half
# slower (Eric, 2026-10-05: small and fast, "a better balance"). So the PDF
# is drawn untagged and its outline written here: the contents, then each
# part with its chapters, each going to the page the first pass found it on.
# It is a PDF incremental update appended to Chromium's file: the outline's
# objects, a new version of the catalog naming them, and a cross-reference
# section for those alone. (The on-screen tables and Copy as Markdown are
# the accessible copies.)
#
# The contents' heading is no link's target, so Chromium names no
# destination for it: it is given an id and a hidden link to it.
_CONTENTS_ID = "zimi-pdf-contents"
_MARK_ID_RE = re.compile(r"""\bid=["'](tb-part-(\d+)|tb-ch-(\d+)-\d+)["']""")
_HEADING_RE = re.compile(r"<(h[12])\b[^>]*>(.*?)</\1>", re.S)
_TAG_RE = re.compile(r"<[^>]*>")
_STARTXREF_RE = re.compile(rb"startxref\s+(\d+)\s+%%EOF\s*$")
_XREF_HEAD_RE = re.compile(rb"\s*(\d+)\s+(\d+)[ \t]*\r?\n")
_XREF_ROW_RE = re.compile(rb"\s*(\d{10}) (\d{5}) ([nf])")
_TRAILER_RE = re.compile(rb"\s*trailer")


def _mark_contents(html):
    """``html`` with the contents' heading (the last h1 before the first
    page mark) a link target, so the plain pass says its page."""
    at = html.find(_PAGE_MARK_ATTR)
    h = html.rfind("<h1", 0, at) if at >= 0 else -1
    end = html.find(">", h) if h >= 0 else -1
    if end < 0 or "id=" in html[h:end]:
        return html
    return (
        html[:h]
        + '<h1 id="%s"' % _CONTENTS_ID
        + html[h + 3 : end + 1]
        + '<a href="#%s" style="display:none"></a>' % _CONTENTS_ID
        + html[end + 1 :]
    )


def _heading_text(html, start, stop):
    m = _HEADING_RE.search(html, start, stop)
    if not m:
        return ""
    return re.sub(r"\s+", " ", unescape(_TAG_RE.sub("", m.group(2)))).strip()


def outline_marks(html, pages):
    """The bookmarks, [[title, page, children], ...]: the contents, then
    each part (id="tb-part-N") with its chapters (id="tb-ch-N-M") under it,
    each titled by its first heading; only those the first pass placed."""
    top, parts = [], {}
    at = html.find('<h1 id="%s"' % _CONTENTS_ID)
    if _CONTENTS_ID in pages and at >= 0:
        title = _heading_text(html, at, len(html))
        if title:
            top.append([title, pages[_CONTENTS_ID], []])
    found = list(_MARK_ID_RE.finditer(html))
    for i, m in enumerate(found):
        if m.group(1) not in pages:
            continue
        stop = found[i + 1].start() if i + 1 < len(found) else len(html)
        title = _heading_text(html, m.end(), stop)
        if not title:
            continue
        item = [title, pages[m.group(1)], []]
        if m.group(2):
            parts[m.group(2)] = item
            top.append(item)
        elif m.group(3) in parts:
            parts[m.group(3)][2].append(item)
        else:
            top.append(item)
    return top


def _pdf_text(s):
    """A PDF text string: literal when plain ASCII, else UTF-16BE with its
    byte order mark (place names, other languages)."""
    if all(32 <= ord(c) < 127 for c in s):
        esc = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        return b"(" + esc.encode("ascii") + b")"
    return b"<FEFF" + s.encode("utf-16-be").hex().upper().encode("ascii") + b">"


def _xref(data):
    """The file's cross-reference tables, followed along /Prev: ({object:
    (offset, generation)}, the newest trailer, its offset). Classic tables
    only: a cross-reference stream is a ValueError."""
    m = _STARTXREF_RE.search(data, max(0, len(data) - 1024))
    if not m:
        raise ValueError("no startxref")
    start = at = int(m.group(1))
    rows, trailer, seen = {}, None, set()
    while at is not None:
        if at in seen or data[at : at + 4] != b"xref":
            raise ValueError("not a classic cross-reference table")
        seen.add(at)
        pos = at + 4
        while True:
            head = _XREF_HEAD_RE.match(data, pos)
            if not head:
                break
            first, count = int(head.group(1)), int(head.group(2))
            pos = head.end()
            for n in range(first, first + count):
                row = _XREF_ROW_RE.match(data, pos)
                if not row:
                    raise ValueError("a short cross-reference table")
                pos = row.end()
                if row.group(3) == b"n":
                    rows.setdefault(n, (int(row.group(1)), int(row.group(2))))
        t = _TRAILER_RE.match(data, pos)
        tdict = _dict_at(data, t.end()) if t else b""
        if not tdict or b"/XRefStm" in tdict:
            raise ValueError("no plain trailer")
        trailer = trailer or tdict
        prev = re.search(rb"/Prev\s+(\d+)", tdict)
        at = int(prev.group(1)) if prev else None
    return rows, trailer, start


def _object(data, rows, n):
    """Object ``n``'s dictionary, found by its cross-reference row."""
    off, gen = rows[n]
    head = re.compile(rb"%d\s+%d\s+obj" % (n, gen)).match(data, off)
    d = _dict_at(data, head.end()) if head else b""
    if not d:
        raise ValueError("object %d is not a dictionary" % n)
    return d


def _xref_section(at, gens):
    """A cross-reference section for the objects at ``at`` ({n: offset}),
    in runs of consecutive numbers, after the free list's head (object 0,
    as every section of Chromium's own begins; some readers expect it)."""
    out, nums = bytearray(b"xref\n0 1\n0000000000 65535 f \n"), sorted(at)
    while nums:
        run = 1
        while run < len(nums) and nums[run] == nums[0] + run:
            run += 1
        out += b"%d %d\n" % (nums[0], run)
        for n in nums[:run]:
            out += b"%010d %05d n \n" % (at[n], gens.get(n, 0))
        nums = nums[run:]
    return bytes(out)


def with_outline(data, marks):
    """``data`` with ``marks`` (outline_marks) as its outline, appended as
    an incremental update. ValueError (KeyError, IndexError) when the file
    is not one it can read: the caller keeps the file as it was."""
    if not marks:
        raise ValueError("no bookmarks")
    rows, trailer, prev = _xref(data)

    def obj(n):
        return _object(data, rows, n)

    root = re.search(rb"/Root\s+(\d+)\s+(\d+)\s+R", trailer)
    size = re.search(rb"/Size\s+(\d+)", trailer)
    if not root or not size:
        raise ValueError("no /Root or /Size")
    cat_n = int(root.group(1))
    cat = obj(cat_n)
    tree = re.search(rb"/Pages\s+(\d+)\s+\d+\s+R", cat)
    if not tree:
        raise ValueError("no page tree")
    order = _page_order(obj, int(tree.group(1)))
    objs, nxt = {}, [max(int(size.group(1)), max(rows) + 1)]

    def alloc():
        nxt[0] += 1
        return nxt[0] - 1

    def place(items, parent):
        """Outline items for ``items`` under ``parent``: (their numbers,
        how many items they and theirs make)."""
        nums, count = [alloc() for _ in items], 0
        for i, (title, page, kids) in enumerate(items):
            if not 1 <= page <= len(order):
                raise ValueError("no page %d" % page)
            n = order[page - 1]
            d = [
                b"/Title " + _pdf_text(title),
                b"/Parent %d 0 R" % parent,
                b"/Dest [%d %d R /XYZ null null null]" % (n, rows[n][1]),
            ]
            if i:
                d.append(b"/Prev %d 0 R" % nums[i - 1])
            if i + 1 < len(nums):
                d.append(b"/Next %d 0 R" % nums[i + 1])
            if kids:
                firsts, below = place(kids, nums[i])
                d.append(
                    b"/First %d 0 R /Last %d 0 R /Count %d"
                    % (firsts[0], firsts[-1], below)
                )
                count += below
            objs[nums[i]] = b"<<" + b"\n".join(d) + b">>"
            count += 1
        return nums, count

    outlines = alloc()
    top, total = place(marks, outlines)
    objs[outlines] = b"<</Type /Outlines /First %d 0 R /Last %d 0 R /Count %d>>" % (
        top[0],
        top[-1],
        total,
    )
    # The catalog again, naming the outline and opening with it shown.
    cat = re.sub(rb"/(?:Outlines\s+\d+\s+\d+\s+R|PageMode\s*/\w+)", b"", cat)
    objs[cat_n] = cat[:-2] + b"\n/Outlines %d 0 R\n/PageMode /UseOutlines>>" % outlines
    gens = {cat_n: rows[cat_n][1]}

    out = bytearray(data if data.endswith(b"\n") else data + b"\n")
    at = {}
    for n in sorted(objs):
        at[n] = len(out)
        out += b"%d %d obj\n" % (n, gens.get(n, 0)) + objs[n] + b"\nendobj\n"
    xref_at = len(out)
    out += _xref_section(at, gens)
    keep = b"".join(
        b"\n" + m.group(0)
        for m in (
            re.search(rb"/Info\s+\d+\s+\d+\s+R", trailer),
            re.search(rb"/ID\s*\[[^\]]*\]", trailer),
        )
        if m
    )
    out += (
        b"trailer\n<</Size %d\n/Root %d %d R%s\n/Prev %d>>\nstartxref\n%d\n%%%%EOF\n"
        % (
            nxt[0],
            cat_n,
            gens[cat_n],
            keep,
            prev,
            xref_at,
        )
    )
    return bytes(out)


def _bookmarked(data, html, pages):
    """The PDF with its outline, or as it was when that cannot be written
    (one line in the log: a PDF is never failed for its bookmarks)."""
    try:
        return with_outline(data, outline_marks(html, pages))
    except Exception as e:  # noqa: BLE001 - the bookmarks are a nicety
        log.warning("almanac pdf: no bookmarks (%s: %s)", type(e).__name__, e)
        return data


def _draw(browser, html, paper):
    """The PDF of ``html``, in a context of its own, closed with its page.
    On an error nothing more is asked of the browser: after its driver has
    gone, the first call says so and the next waits forever."""
    # No script, no network: the document is drawn from what it holds.
    ctx = browser.new_context(java_script_enabled=False, offline=True)
    ctx.route("**/*", lambda route: route.abort())
    page = ctx.new_page()
    page.set_default_timeout(RENDER_TIMEOUT_SECONDS * 1000)
    chaptered = _PAGE_MARK_ATTR in html
    html = _with_math_font(_mark_contents(html) if chaptered else html)
    page.set_content(html, wait_until="load")
    page.emulate_media(media="print")
    page.evaluate(_FONTS_READY_JS)
    opts = dict(
        format=paper,
        print_background=True,
        prefer_css_page_size=True,
        # The running head and foot are the document's own (@page
        # margin boxes).
        display_header_footer=False,
    )
    pages = {}
    if chaptered:
        pages = dest_pages(page.pdf(**opts))
        if pages:
            page.evaluate(_FILL_PAGES_JS, pages)
    # Untagged, and no outline of Chromium's: the bookmarks are ours.
    data = page.pdf(**opts)
    ctx.close()
    return _bookmarked(data, html, pages) if pages else data


def _kill(pid):
    """Kill a Playwright driver from any thread; Chromium goes with it. Not
    waited for or reaped here: the driver is asyncio's child, and its own
    watcher reaps it (taking that from it is a warning in the log)."""
    if pid:
        try:
            os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
        except OSError:
            pass


class _Job:
    def __init__(self, html, paper):
        self.html, self.paper = html, paper
        self.done = threading.Event()
        self.worker = None  # the one drawing it
        self.started = None  # monotonic, set as it starts
        self.cancelled = False
        self.retried = False
        self.data = self.error = None


_jobs = queue.Queue()
_worker_lock = threading.Lock()
_worker = None  # the thread taking renders now
_launches = 0  # browsers started, for the tests
_atexit_set = False


class _Worker(threading.Thread):
    """One thread, one Playwright, one browser: it takes renders off the
    queue until its browser is idle, has done its share, or breaks, and
    then it ends; the next render starts another. A browser that breaks
    is killed, never asked to close (it would not answer)."""

    def __init__(self):
        super().__init__(name="almanac-pdf", daemon=True)
        self.pw = self.browser = self.pid = None
        self.renders = 0
        self.retired = False  # takes no more renders

    def run(self):
        try:
            while not self.retired:
                try:
                    job = _jobs.get(
                        timeout=BROWSER_IDLE_SECONDS if self.browser else None
                    )
                except queue.Empty:
                    with _worker_lock:
                        if _jobs.empty():  # else one came in just now
                            self.retired = True
                    continue
                if job is None:
                    self.retired = True
                elif self.retired:  # killed while it waited: the next takes it
                    _jobs.put(job)
                elif not job.cancelled:
                    self._take(job)
                    if self.renders >= RENDERS_PER_BROWSER:
                        self.retired = True
        finally:
            self.close()
            _ensure_worker()  # renders still in line get the next browser

    def _take(self, job):
        job.worker, job.started = self, time.monotonic()
        warm = self.browser is not None
        try:
            if not warm:
                self._open()
            job.data = _draw(self.browser, job.html, job.paper)
            self.renders += 1
        except Exception as e:
            self.kill()
            if warm and not (job.retried or job.cancelled):
                # Its browser died while it waited (a crash, the OOM
                # killer): the render goes to a new one, once.
                job.retried = True
                _jobs.put(job)
                return
            job.error = e
        job.done.set()

    def _open(self):
        global _launches
        sync_playwright = renderer._playwright_module()
        if sync_playwright is None:
            raise RuntimeError("playwright is not installed")
        self.pw = sync_playwright().start()
        self.pid = renderer._driver_pid(self.pw)
        self.browser = renderer._launch(self.pw.chromium)
        _launches += 1

    def close(self):
        """Close politely (on this thread), then make sure."""
        if self.pid:  # not killed
            try:
                if self.browser is not None:
                    self.browser.close()
                if self.pw is not None:
                    self.pw.stop()
                self.pid = None  # gone, and its number may be reused
            except Exception as e:
                log.debug("almanac pdf: browser close: %s", e)
        self.kill()

    def kill(self):
        """From any thread: the browser killed, this thread retired."""
        self.retired = True
        pid, self.pid = self.pid, None
        self.browser = self.pw = None
        _kill(pid)


def _ensure_worker():
    """A live thread to take what is in line (started on first use)."""
    global _worker, _atexit_set
    with _worker_lock:
        if _worker is not None and _worker.is_alive() and not _worker.retired:
            return
        if _jobs.empty():
            return
        _worker = _Worker()
        _worker.start()
        if not _atexit_set:
            _atexit_set = True
            atexit.register(shutdown)


def shutdown():
    """Close the warm browser (the server is leaving)."""
    w = _worker
    if w is None or not w.is_alive():
        return
    _jobs.put(None)
    w.join(renderer.KILL_GRACE)
    if w.is_alive():
        w.kill()


_pending_lock = threading.Lock()
_pending = 0  # renders drawing or waiting


def _render(html, paper):
    """The PDF's bytes: Busy when the line is full or this waited its time
    in it, RenderFailed when the render broke or ran over (its browser
    killed, its thread left behind, and another started for what waits)."""
    global _pending
    with _pending_lock:
        if _pending > QUEUE_DEPTH:
            raise Busy()
        _pending += 1
    try:
        job = _Job(html, paper)
        _jobs.put(job)
        _ensure_worker()
        queued = time.monotonic()
        while not job.done.wait(WAIT_TICK_SECONDS):
            now, started = time.monotonic(), job.started
            if started is None and now - queued > RENDER_QUEUE_SECONDS:
                job.cancelled = True
                raise Busy()
            if started is not None and now - started > RENDER_TIMEOUT_SECONDS:
                job.cancelled = True
                job.worker.kill()
                _ensure_worker()
                raise RenderFailed(
                    "ran over %ds; its browser was killed" % RENDER_TIMEOUT_SECONDS
                )
        if job.error is not None:
            raise RenderFailed(
                "%s: %s after %.1fs (%d KB of HTML); the next render starts a new browser"
                % (
                    type(job.error).__name__,
                    job.error,
                    time.monotonic() - job.started,
                    len(html) // 1024,
                )
            )
        return job.data
    finally:
        with _pending_lock:
            _pending -= 1


def _key(html, paper, name):
    h = hashlib.sha256()
    for part in (paper, name, html):
        h.update(part.encode("utf-8", "surrogatepass") + b"\0")
    return h.hexdigest()


def make(html, paper, name):
    """Render ``html`` to a kept PDF: (its id, its file name). The same
    document again is the same file, its time renewed. Raises Busy or
    RenderFailed (see _render)."""
    if paper not in PAPER_SIZES:
        paper = "A4"
    name = clean_name(name)
    key = _key(html, paper, name)
    sweep()
    with _files_lock:
        pdf_id = _by_key.get(key)
        got = _files.get(pdf_id)
        if got and os.path.exists(got[0]):
            _files[pdf_id] = (got[0], got[1], time.time())
            return pdf_id, got[1]
    data = _render(html, paper)
    d = _dir()
    os.makedirs(d, exist_ok=True)
    pdf_id = secrets.token_urlsafe(18)
    path = os.path.join(d, pdf_id + ".pdf")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    with _files_lock:
        _files[pdf_id] = (path, name, time.time())
        _by_key[key] = pdf_id
    return pdf_id, name
