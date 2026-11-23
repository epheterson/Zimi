"""The Almanac's tables as a real PDF.

The page builds its print document (title page, contents, every tile, the
equations as MathML, the print rules inlined) and posts it here. almanacbook
sets it in type with PyMuPDF (MuPDF's own HTML layout, which Zimi already
carries for PDFs), the equations by almanacmath, and draws the page furniture,
contents numbers and bookmarks itself: no browser. The PDF waits under the
data dir for the shell's PDF reader to open it.

The document is the page's own, but it is still text a client sent: MuPDF's
layout fetches nothing (its images come only from the book's own archive),
and the maths parser refuses DOCTYPEs and entities. Nothing here takes the
ZIM lock.

A render is a process of its own (`python -m zimi.almanacbook`): ten or more
seconds of layout would otherwise hold this server's interpreter, and a render
that runs over its time is killed, not waited on. One at a time with a short
line behind it; past that the server is busy (a 503 the page retries once).
A frozen desktop build has no `python -m` and renders on the request's thread.
The same document asked again is the PDF already made, while it is kept.
"""

import hashlib
import logging
import os
import re
import secrets
import subprocess
import sys
import threading
import time

log = logging.getLogger("zimi")

# The largest print document accepted: the whole book with its equations is
# about 1.5 MB, so this is room, not a target (and a bound on what the layout's
# patterns can be made to chew on).
MAX_PRINT_BYTES = 4 * 1024 * 1024
# How long a finished PDF is kept for the reader (and its Print and Download).
PDF_TTL_SECONDS = 600
# One render's budget; past it its process is killed.
RENDER_TIMEOUT_SECONDS = 120
# Renders that may wait behind the one being set; one more is told to come back.
QUEUE_DEPTH = 2
# How long a request waits in line for its turn before it is told the same.
RENDER_QUEUE_SECONDS = 60
# When a busy server asks the page to try again (the 503's Retry-After).
RETRY_AFTER_SECONDS = 5
# Paper the client may ask for; anything else is A4.
PAPER_SIZES = ("A4", "Letter")
# A file name: its characters kept to what a download dialog takes.
MAX_NAME_CHARS = 120
_NAME_DROP = re.compile(r'[\x00-\x1f/\\:*?"<>|]+')
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
# The equations' font: Noto Sans Math (SIL OFL 1.1), shipped with Zimi.
MATH_FONT = os.path.join(
    os.path.dirname(__file__), "static", "fonts", "NotoSansMath-Regular.ttf"
)
# How a render starts: a copy of almanacbook in a process of its own (runpy's
# warning that the package already imported it is harmless).
_CHILD_PYTHON = (
    sys.executable,
    "-W",
    "ignore:'zimi.almanacbook' found in sys.modules:RuntimeWarning",
    "-m",
    "zimi.almanacbook",
)

_files_lock = threading.Lock()
_files = {}  # id -> (path, name, made)
_by_key = {}  # the document's hash -> id, while its PDF is kept
_swept_dir = False


class Busy(Exception):
    """The line is full, or this request waited its time in it."""


class RenderFailed(Exception):
    """The render broke or ran over its time; the message says which."""


def available():
    """Whether PDFs can be made here: PyMuPDF with its HTML layout (Story)."""
    try:
        import pymupdf

        return hasattr(pymupdf, "Story") and hasattr(pymupdf, "Archive")
    except ImportError:
        return False


def _dir():
    from zimi import server as _srv

    return os.path.join(_srv.ZIMI_DATA_DIR, "almanac-pdf")


def clean_name(name):
    """A download name: no path or control characters, ends in .pdf."""
    name = _NAME_DROP.sub(" ", str(name or "")).strip(" .")
    name = re.sub(r"\s+", " ", name)[:MAX_NAME_CHARS].strip(" .") or "Zimi Almanac"
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


_turn = threading.Lock()   # the one render being set
_pending_lock = threading.Lock()
_pending = 0  # renders being set or waiting


def _set_in_child(html, paper):
    """The PDF's bytes from a process of its own, killed at its time."""
    from zimi import subproc

    if paper not in PAPER_SIZES:   # make() already holds it to these; checked again where it becomes an argument
        raise ValueError("unknown paper size")
    d = _dir()
    os.makedirs(d, exist_ok=True)
    base = os.path.join(d, "render-" + secrets.token_hex(8))
    src, out = base + ".html", base + ".pdf.part"
    try:
        with open(src, "w", encoding="utf-8", errors="surrogatepass") as f:
            f.write(html)
        proc = subproc.popen(
            [*_CHILD_PYTHON, paper, src, out],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            _, err = proc.communicate(timeout=RENDER_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            subproc.stop(proc)
            raise RenderFailed("ran over %ds; its process was killed" % RENDER_TIMEOUT_SECONDS)
        if proc.returncode != 0:
            tail = (err or b"").decode("utf-8", "replace").strip().splitlines()[-1:]
            raise RenderFailed("exited %s: %s" % (proc.returncode, tail[0] if tail else ""))
        with open(out, "rb") as f:
            return f.read()
    finally:
        for p in (src, out):
            try:
                os.remove(p)
            except OSError:
                pass


def _set(html, paper):
    if getattr(sys, "frozen", False):
        from zimi import almanacbook

        return almanacbook.render(html, paper)
    return _set_in_child(html, paper)


def _render(html, paper):
    """The PDF's bytes: Busy when the line is full or this waited its time
    in it, RenderFailed when the render broke or ran over."""
    global _pending
    with _pending_lock:
        if _pending > QUEUE_DEPTH:
            raise Busy()
        _pending += 1
    try:
        if not _turn.acquire(timeout=RENDER_QUEUE_SECONDS):
            raise Busy()
        try:
            started = time.monotonic()
            try:
                return _set(html, paper)
            except RenderFailed:
                raise
            except Exception as e:
                raise RenderFailed(
                    "%s: %s after %.1fs (%d KB of HTML)"
                    % (type(e).__name__, e, time.monotonic() - started, len(html) // 1024)
                )
        finally:
            _turn.release()
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
