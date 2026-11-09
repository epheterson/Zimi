"""Document collections, searched and listed (#142).

A nautilus library (zimgit-water: a small search app plus PDFs) has no
full-text index of its own for its documents: the Xapian index covers the two
shell pages, and the entries' titles are bare file names. Two things here:

* ``list_entries``: a ZIM's entries by MIME type or path prefix, paged. Needs
  no index, so it works on any ZIM.
* The documents index: one sqlite FTS5 file per ZIM revision
  (``<data dir>/docs/<name>.db``), built in the background by the details
  builder (a child process, nice'd) from the listing's title, description and
  author and from each PDF's text (PyMuPDF when installed; without it the
  listing alone). Search asks it only for the ZIMs that have one, so a search
  elsewhere gains a dict lookup and nothing else.

``pdf_scan`` is the one PDF reader: search's ``extract_pdf_text``, the index
and ``scripts/pdf_text_layers.py`` all go through it.
"""

import logging
import posixpath
import re
import sqlite3
import threading
import time

from zimi import nautilus
from zimi import server as _srv
from zimi.details import DetailsBuilder
from zimi.libzimcompat import entry_by_id

log = logging.getLogger("zimi")

PDF_MIME = "application/pdf"

# Bounds of one PDF's reading, and of one ZIM's. A 3,000 page manual is
# searchable by its first pages and its title; the build never waits on one.
MAX_PDF_BYTES = 64 * 1024 * 1024
MAX_PDF_PAGES = 400
MAX_PDF_CHARS = 600_000
MAX_BUILD_SECONDS = 3600

LIST_DEFAULT = 100
LIST_MAX = 1000
# Entries looked at in one list_entries call, under the archive's lock. A
# filter that matches little pages on by cursor instead of holding the lock.
LIST_SCAN_MAX = 20_000

# bm25 weights: title, description, author, body.
_WEIGHTS = "10.0, 3.0, 2.0, 1.0"
_SNIPPET_CHARS = 200
_QUERY_WORD = re.compile(r"\w+", re.UNICODE)


# ── the one PDF reader ────────────────────────────────────────────────────


def _pymupdf():
    """PyMuPDF's module, or None when it is not installed. The current
    module name; `fitz` warns to stdout on import and is going away."""
    if not _srv.HAS_PYMUPDF:
        return None
    try:
        import pymupdf

        return pymupdf
    except ImportError:
        import fitz

        return fitz


def pdf_scan(pdf_bytes, max_pages=None, max_chars=None):
    """``(text, pages, blank_pages)`` of a PDF: its text with whitespace
    collapsed, the page count, and how many pages read had no text layer
    (scans). Stops after ``max_pages`` pages or once ``max_chars`` of text is
    read (None: no limit). ``text`` is None when PyMuPDF is not installed;
    a PDF that will not open raises."""
    fitz = _pymupdf()
    if fitz is None:
        return None, 0, 0
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        parts, size, blank = [], 0, 0
        for i, page in enumerate(doc):
            if max_pages is not None and i >= max_pages:
                break
            got = page.get_text()
            if got.strip():
                parts.append(got)
                size += len(got)
            else:
                blank += 1
            if max_chars is not None and size >= max_chars:
                break
        pages = doc.page_count
    finally:
        doc.close()
    text = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return (text[:max_chars] if max_chars is not None else text), pages, blank


# ── list_entries ──────────────────────────────────────────────────────────


def _first_at_or_after(archive, prefix):
    """The first entry id whose path sorts at or after ``prefix``: a ZIM
    stores its entries in path order, so a prefix is found by bisection, not
    by a walk of millions of entries."""
    lo, hi = 0, archive.entry_count
    while lo < hi:
        mid = (lo + hi) // 2
        if entry_by_id(archive, mid).path < prefix:
            lo = mid + 1
        else:
            hi = mid
    return lo


def list_entries(zim, mime=None, prefix=None, limit=LIST_DEFAULT, cursor=None):
    """A ZIM's entries (redirects left out), filtered by MIME type and/or path
    prefix, in path order, a page at a time.

    ``{"zim", "entries": [{path, title, mime, size}], "count", "next"}``;
    ``next`` is the cursor for the following page, None at the end. A call
    looks at no more than LIST_SCAN_MAX entries: a filter that matches little
    returns what it found with a ``next`` to go on from. {"error"} for an
    unknown ZIM or a bad cursor. The caller holds ``_zim_lock``, as for every
    read of the pooled archive."""
    archive = _srv.get_archive(zim)
    if archive is None:
        return {"error": f"ZIM '{zim}' not found"}
    try:
        limit = max(1, min(int(limit or LIST_DEFAULT), LIST_MAX))
        pos = int(cursor) if cursor not in (None, "") else None
    except (TypeError, ValueError):
        return {"error": "bad limit or cursor"}
    total = archive.entry_count
    if pos is None:
        pos = _first_at_or_after(archive, prefix) if prefix else 0
    if pos < 0 or pos > total:
        return {"error": "bad limit or cursor"}
    mime = (mime or "").strip().lower() or None
    out, scanned = [], 0
    while pos < total and len(out) < limit and scanned < LIST_SCAN_MAX:
        entry = entry_by_id(archive, pos)
        pos += 1
        scanned += 1
        path = entry.path
        if prefix and not path.startswith(prefix):
            pos = total  # path order: past the prefix, nothing more matches
            break
        if entry.is_redirect:
            continue
        item = entry.get_item()
        item_mime = (item.mimetype or "").lower()
        if (
            mime
            and item_mime != mime
            and not (mime.endswith("/") and item_mime.startswith(mime))
        ):
            continue
        out.append(
            {"path": path, "title": entry.title, "mime": item_mime, "size": item.size}
        )
    return {
        "zim": zim,
        "entries": out,
        "count": len(out),
        "next": str(pos) if pos < total else None,
    }


# ── the build ─────────────────────────────────────────────────────────────

COLUMNS = (
    "path TEXT PRIMARY KEY",
    "title TEXT",
    "description TEXT",
    "author TEXT",
    "body TEXT",
    "pages INTEGER",
    "blank_pages INTEGER",
)
_FTS = "docs_fts"


def _listing(archive):
    """The collection's listing as ``{path: (title, description, author)}``,
    every file of an item pointing at its item. Nautilus's ``database.js``
    (files under ``files/``) or Zimi's own folder listing (from the root)."""
    out = {}
    for listing, base in (
        (nautilus.DATABASE_PATH, nautilus.FILES_PREFIX),
        (nautilus.ZIMI_DATABASE_PATH, ""),
    ):
        for item in nautilus.items(archive, listing):
            facts = (
                str(item.get("ti") or ""),
                str(item.get("dsc") or ""),
                str(item.get("aut") or ""),
            )
            for path in nautilus.files_of(item, base):
                out.setdefault(path, facts)
    return out


def _is_pdf(item):
    return (item.mimetype or "").lower() == PDF_MIME


def _fts_setup(conn):
    """The full-text table over the rows, made in the same file and the
    same transaction."""
    conn.execute(
        f"CREATE VIRTUAL TABLE {_FTS} USING fts5("
        "title, description, author, body, content='docs', content_rowid='rowid',"
        " tokenize='unicode61 remove_diacritics 2')"
    )
    conn.execute(f"INSERT INTO {_FTS}({_FTS}) VALUES('rebuild')")


def build_docs(zim_name, zim_path):
    """Read a collection into its file: one row per document file (a PDF, or
    anything the listing names), with the listing's facts and the PDF's text.
    Opens an archive of its own, never the pool's, so it needs no lock; runs
    in a child process (search._build_index_isolated). Without PyMuPDF the
    rows carry the listing alone."""
    archive = _srv.open_archive(zim_path)
    listing = _listing(archive)
    deadline = time.time() + MAX_BUILD_SECONDS
    rows = []
    for entry, item in _srv.walk_entries(archive, bounded=False):
        path = entry.path
        listed_doc = path in listing and nautilus.ext_kind(path) == "document"
        if not (_is_pdf(item) or listed_doc):
            continue
        ti, dsc, aut = listing.get(path) or (nautilus.title_from_name(path), "", "")
        ti = ti or nautilus.title_from_name(path)
        body, pages, blank = "", 0, 0
        if _is_pdf(item) and time.time() < deadline and item.size <= MAX_PDF_BYTES:
            try:
                text, pages, blank = pdf_scan(
                    bytes(item.content), MAX_PDF_PAGES, MAX_PDF_CHARS
                )
                body = text or ""
            except Exception as e:  # one bad PDF costs its text, not the build
                log.debug("pdf text of %s/%s: %s", zim_name, path, e)
        rows.append((path, ti, dsc, aut, body, pages, blank))
    # Only entries the ZIM holds: a listed file it lacks is not a hit that opens.
    return _builder.write(zim_name, zim_path, archive, rows, setup=_fts_setup)


def _forget_answers():
    """A search answered before the index was read lacked the documents."""
    from zimi import search

    search._search_cache_clear()


_builder = DetailsBuilder(
    "docs",
    zims=lambda z: is_collection(z),
    label="Documents",
    what="document index",
    version="1",
    table="docs",
    columns=COLUMNS,
    # Looked up when it runs, as the child process looks it up.
    build=lambda name, path: build_docs(name, path),
    load=None,
    lock=threading.Lock(),
    on_keep=lambda name, key, details: _forget_answers(),
    # PDF text is slow per entry, not per entry count: always in a child.
    isolate_min=0,
)
build_all = _builder.build_all


def is_collection(z):
    """Whether a library entry is a document collection: a nautilus library
    or a folder of documents Zimi made (the ZIMs the Bookshelf reads
    documents from), by what the load already decided (``feeds``)."""
    return (z.get("feeds") or {}).get("books") in ("nautilus", "folder")


# ── the search ────────────────────────────────────────────────────────────


def ready(name):
    """Whether ``name`` has its document index for the ZIM installed now.
    A dict lookup for any ZIM that is not a collection; for a collection not
    read yet, asks for the read in the background and answers False, so the
    first search on a new collection starts it."""
    path = _srv.get_zim_files().get(name)
    if not path:
        return False
    got = _builder.kept(name, path)
    if got is not None:
        return bool(got)
    if any(
        z.get("name") == name and is_collection(z) for z in _srv._zim_list_cache or []
    ):
        _builder.request(name)
    return False


def settled(name):
    """False while ``name`` is a collection whose document index is not read
    yet: an answer given now is short of its documents, so it is not kept."""
    path = _srv.get_zim_files().get(name)
    return not path or _builder.kept(name, path) is not None or not _is_collection_name(name)


def _is_collection_name(name):
    return any(z.get("name") == name and is_collection(z) for z in _srv._zim_list_cache or [])


def _match(text, last_prefix=True):
    """An FTS5 query for the words of ``text``: every word, the last as a
    prefix (a name being typed). None when there is no word."""
    words = _QUERY_WORD.findall(text or "")
    if not words:
        return None
    parts = [f'"{w}"' for w in words]
    if last_prefix:
        parts[-1] += "*"
    return " ".join(parts)


def _window(text, words):
    """The stretch of ``text`` around the first of ``words`` in it, "" when
    there is none. Not FTS5's snippet(): that tokenizes the whole body of
    every match (180 ms for the 600 KB of zimgit-water's seven PDFs)."""
    low = text.lower()
    at = min((i for i in (low.find(w) for w in words) if i >= 0), default=-1)
    if at < 0:
        return ""
    start = max(0, at - _SNIPPET_CHARS // 4)
    return ("… " if start else "") + text[start : start + _SNIPPET_CHARS].strip()


def search(name, query, limit=10, body=True):
    """Documents of ``name`` matching ``query``: ``[{path, title, snippet}]``,
    best first, [] when none or the index is not there. ``body=False`` asks
    the listing's title, description and author only (the keystroke path)."""
    q = _match(query)
    if q is None or not ready(name):
        return []
    cols = "" if body else "{title description author} : "
    rank = f"bm25({_FTS}, {_WEIGHTS})"
    text_col = "d.body" if body else "''"
    sql = (
        f"SELECT d.path, d.title, d.description, {text_col} "
        f"FROM {_FTS} JOIN docs d ON d.rowid = {_FTS}.rowid "
        f"WHERE {_FTS} MATCH ? ORDER BY {rank} LIMIT ?"
    )
    conn = None
    try:
        conn = sqlite3.connect(_builder.path(name), timeout=5)
        rows = conn.execute(sql, (cols + q, limit)).fetchall()
        if not rows and " " in q:
            # Every word, found nowhere together: any of them.
            loose = " OR ".join(q.split(" "))
            rows = conn.execute(sql, (cols + loose, limit)).fetchall()
    except sqlite3.Error as e:
        log.debug("document index %s: %s", name, e)
        return []
    finally:
        if conn is not None:
            conn.close()
    words = [w.lower() for w in _QUERY_WORD.findall(query)]
    return [
        {
            "path": path,
            "title": title or posixpath.basename(path),
            "snippet": _window(text, words) or dsc[:_SNIPPET_CHARS],
        }
        for path, title, dsc, text in rows
    ]
