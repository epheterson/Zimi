r"""A book whose chapters are pages of its ZIM, as one page the e-reader opens.

Eric, 2026-09-30: Wikisource works, LibreTexts textbooks and whole-ZIM books
open in the e-reader (contents, place kept, sync) as Gutenberg's do, not as
plain article pages.

The e-reader reads one document: a Gutenberg book's page, or an EPUB's
chapters served as one page (zimi.epub). These families keep a book as many
pages, so ``/w/<zim>/_zimi_book_/<root>`` is the book at ``<root>`` as one
page, built here on the first open and kept for the next: each chapter a
``<section>`` headed by its name, in reading order, its links to another
chapter landing on it in the page and every other address made absolute.
The chapters of each family (zimi.booksources has where its books are):

- ``wikisource``, ``wikibooks``: the pages under the work (``Work/...``),
  found by the ZIM's own path order (a range, never a walk), in the order
  the work's page and each chapter link them, the rest after in path order.
- ``libretexts``: the pages under the book in ``content/shared.json``,
  which lists the tree in reading order; their bodies are
  ``content/page_content_<id>.json``. Front and back matter are left out.
- ``whole``: the ZIM is the book and its main page the contents; the pages
  it links, and the pages those link, in link order.

The page carries ``<meta name="zimi-book" content="pages">`` and the book's
Dublin Core, as an EPUB's does, and answers under the same CSP: nothing of
the ZIM's runs in it.

Math: a LibreTexts page writes its formulas as TeX (``\(..\)``, ``\[..\]``,
``$$..$$``) for the MathJax its ZIM ships (``mathjax/es5/tex-svg.js``),
which cannot run in this page. When the ZIM has one and the book has TeX,
each formula is marked (``<span class="zb-tex">``) and the page names the
ZIM's MathJax (``<meta name="zimi-math">``); the reader renders the marked
formulas with it as they come into view (static/bookmath.js). A book with
no TeX, or a ZIM with no MathJax, gets not a byte of this.

Read with the search pool's archive and lock, never
the library's, so a long book does not stall every other request.
"""

import html as _html
import json
import logging
import posixpath
import re
import threading
import urllib.parse
from collections import OrderedDict

from zimi import epub as _epub
from zimi import server as _srv

log = logging.getLogger("zimi")

# Where a book's address starts: never a path a scraper writes.
PREFIX = "_zimi_book_/"
# The families whose books are read here.
READERS = ("wikisource", "wikibooks", "libretexts", "whole")
MAX_CHAPTERS = 600
MAX_PAGE_BYTES = 8 * 1024 * 1024  # one chapter's page
MAX_BOOK_BYTES = 32 * 1024 * 1024  # the chapters together
MAX_JSON_BYTES = 64 * 1024 * 1024
# A whole-ZIM book: its main page's links, and theirs, this deep.
WHOLE_DEPTH = 2
# Built books kept for the next request.
CACHE_BOOKS = 4
CACHE_BYTES = 64 * 1024 * 1024

_HREF_RE = re.compile(r"""<a\b[^>]*?\shref\s*=\s*("[^"]*"|'[^']*')""", re.I)
_H1_RE = re.compile(r"<h1\b[^>]*>.*?</h1\s*>", re.I | re.S)
_HEADING_RE = re.compile(r"<(/?)h([1-6])\b", re.I)
# What an export of a Wikisource work leaves out: its header's navigation
# and the hidden record (#ws-data), which Reader View would show.
_NOEXPORT_RE = re.compile(
    r"""<([a-z][a-z0-9]*)\b[^>]*?\s(?:class\s*=\s*["'][^"']*\bws-noexport\b|id\s*=\s*["']ws-data["'])[^>]*>""",
    re.I,
)
# LibreTexts' links between pages are routes of its own app: #/<path>?anchor=x
_LT_ROUTE_RE = re.compile(
    r"""(\shref\s*=\s*)(["'])#/([^"'?]*)(?:\?anchor=([^"']*))?\2""", re.I
)
_LT_MATTER_RE = re.compile(r"/(?:00|zz):_(?:Front|Back)_Matter(?:/|$)", re.I)
# The macros a LibreTexts page defines for its formulas: a block at its head
# (a paragraph of \newcommand each) that its own site hides. Kept for the
# formulas, out of sight.
_LT_PREAMBLE_RE = re.compile(
    r"""(<div\b[^>]*?\sclass\s*=\s*["'][^"']*\bHeadertext\b[^"']*["'][^>]*?)(/?>)""",
    re.I,
)
# "Example \(\PageIndex{2}\)": the page's number before the example's
# (mindtouch2zim's zimui defines the macro per page, from its title).
_LT_PAGEINDEX_RE = re.compile(r"\\PageIndex\s*\{\s*([^{}]*?)\s*\}")

# ── math ──
# Where a ZIM keeps the MathJax its own pages load (mindtouch2zim's zimui).
MATHJAX_PATHS = ("mathjax/es5/tex-svg.js", "mathjax/es5/tex-mml-svg.js")
MATH_CLASS = "zb-tex"
# A formula as MathJax finds one in text: \(..\) inline, \[..\] or $$..$$
# on a line of its own. Never across a tag: a formula is one run of text.
_TEX_RE = re.compile(
    r"\\\((?:(?!\\\)).)+?\\\)|\\\[(?:(?!\\\]).)+?\\\]|\$\$(?:(?!\$\$).)+?\$\$", re.S
)
# A tag (never the "< b" of "a < b" in a formula), and the elements whose
# text is not prose, where TeX is shown as written.
_TAG_RE = re.compile(r"(<[a-z/!?][^>]*>)", re.I)
_TAG_NAME_RE = re.compile(r"<(/?)([a-z][a-z0-9]*)", re.I)
_VERBATIM = frozenset(("pre", "code", "kbd", "samp", "textarea", "script", "style"))


def address(root):
    """The e-reader's address of the book at ``root``, under /w/<zim>/."""
    return PREFIX + root


def split(entry_path):
    """The root of the book at ``entry_path``, or None when it is no
    book's address."""
    if entry_path.startswith(PREFIX) and len(entry_path) > len(PREFIX):
        return entry_path[len(PREFIX) :]
    return None


# ── one chapter's HTML ─────────────────────────────────────────────────────


def _drop_elements(body, start_re):
    """``body`` without each element whose opening tag ``start_re`` matches,
    what it holds with it (counted by its own tag name, so a <div> in the
    <div> goes too)."""
    out, pos = [], 0
    while True:
        m = start_re.search(body, pos)
        if not m:
            out.append(body[pos:])
            return "".join(out)
        out.append(body[pos : m.start()])
        tag = m.group(1).lower()
        tag_re = re.compile(r"<(/?)%s\b[^>]*>" % re.escape(tag), re.I)
        depth, end = 1, len(body)
        for t in tag_re.finditer(body, m.end()):
            depth += -1 if t.group(1) else 1
            if depth == 0:
                end = t.end()
                break
        pos = end


def _demote(m):
    return f"<{m.group(1)}h{min(6, int(m.group(2)) + 3)}"


def chapter_html(body):
    """A page's body as a chapter: its scripts, handlers and hidden record
    out, its own title (the page's first <h1>) out for the chapter's heading,
    and its headings three levels down so the chapters are the book's
    contents."""
    body = _epub._chapter_body(body)
    body = _drop_elements(body, _NOEXPORT_RE)
    body = _H1_RE.sub("", body, count=1)
    return _HEADING_RE.sub(_demote, body)


def mark_tex(body):
    """``(body, n)``: ``body`` with each TeX formula in its text wrapped in
    ``<span class="zb-tex">``, and how many there were. Text inside <pre>,
    <code> and their like is left as written."""
    if "\\" not in body and "$$" not in body:
        return body, 0
    out, n, verbatim = [], 0, 0
    for i, part in enumerate(_TAG_RE.split(body)):
        if i % 2:  # a tag
            m = _TAG_NAME_RE.match(part)
            if m and m.group(2).lower() in _VERBATIM and not part.endswith("/>"):
                verbatim = max(0, verbatim + (-1 if m.group(1) else 1))
        elif part and not verbatim:
            part, k = _TEX_RE.subn(
                lambda t: f'<span class="{MATH_CLASS}">{t.group(0)}</span>', part
            )
            n += k
        out.append(part)
    return "".join(out), n


def _lt_front(title):
    """What \\PageIndex puts before an example's number on the page titled
    ``title``: "1.2." for "1.02: Sets", as mindtouch2zim's zimui has it."""
    if ":" not in title:
        return ""
    parts = title.split(":", 1)[0].strip().split(".")
    return ".".join(str(int(p)) if p.isdigit() else p for p in parts) + "."


def _lt_math(body, title):
    """A LibreTexts page's TeX as its site shows it: its block of macros
    out of sight, \\PageIndex the page's number."""
    body = _LT_PREAMBLE_RE.sub(lambda m: m.group(1) + " hidden" + m.group(2), body)
    front = _lt_front(title)
    return _LT_PAGEINDEX_RE.sub(lambda m: front + m.group(1), body)


def math_src(archive):
    """The ZIM path of the MathJax the ZIM ships, or None."""
    for p in MATHJAX_PATHS:
        item = _srv.entry_item(archive, p)
        if item is not None and item.size:
            return p
    return None


def _links(body, base_dir):
    """The ZIM paths a page links, in order, each once."""
    out, seen = [], set()
    for m in _HREF_RE.finditer(body or ""):
        p = _epub.member_name(base_dir, _html.unescape(m.group(1)[1:-1]))
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ── the chapters of each family ────────────────────────────────────────────


def _html_page(archive, path):
    """``(title, text)`` of the HTML page at ``path``, or None."""
    item = _srv.entry_item(archive, path)
    if item is None or not item.mimetype.startswith("text/html"):
        return None
    if item.size > MAX_PAGE_BYTES:
        return None
    return item.title, bytes(item.content).decode("utf-8", "replace")


def _under(archive, root):
    """The paths under ``root/`` in the ZIM's own order (by path): found by
    halving, so a Wikisource of millions of pages is not walked."""
    want = (root + "/").encode("utf-8")
    lo, hi = 0, archive.entry_count
    while lo < hi:
        mid = (lo + hi) // 2
        if archive._get_entry_by_id(mid).path.encode("utf-8") < want:
            lo = mid + 1
        else:
            hi = mid
    out = []
    for i in range(lo, archive.entry_count):
        e = archive._get_entry_by_id(i)
        if not e.path.startswith(root + "/"):
            break
        if not e.is_redirect:
            out.append(e.path)
        if len(out) > MAX_CHAPTERS * 4:
            break
    return out


def _link_order(archive, root, allowed, depth=None):
    """``[(path, title, text, level)]``: the page at ``root``, then the
    pages ``allowed`` it links, each followed by the ones it links first
    (a chapter's sections after it), each page once."""
    first = _html_page(archive, root)
    if first is None:
        return []
    seen, out = {root}, []

    def visit(path, got, level):
        out.append((path, got[0], got[1], level))
        if len(out) >= MAX_CHAPTERS or (depth is not None and level >= depth):
            return
        kids = []
        for p in _links(got[1], posixpath.dirname(path)):
            if p in seen or not allowed(p):
                continue
            seen.add(p)
            kids.append(p)
        for p in kids:
            if len(out) >= MAX_CHAPTERS:
                return
            page = _html_page(archive, p)
            if page is not None:
                visit(p, page, level + 1)

    visit(root, first, 0)
    return out


def _wiki_chapters(archive, root):
    under = _under(archive, root)
    inside = set(under)
    got = _link_order(archive, root, inside.__contains__)
    had = {p for p, *_rest in got}
    for p in under:
        if len(got) >= MAX_CHAPTERS:
            break
        if p not in had:
            page = _html_page(archive, p)
            if page is not None:
                got.append((p, page[0], page[1], p.count("/") - root.count("/")))
    return [
        {
            "key": p,
            # "Adjuvilo/Ĉapitro I" is "Ĉapitro I" in its book.
            "title": (title or p).rsplit("/", 1)[-1].replace("_", " "),
            "body": text,
            "base": posixpath.dirname(p),
            "sub": level > 1,
        }
        for p, title, text, level in got
    ]


def _whole_chapters(archive, root):
    def allowed(p):
        return bool(p)

    return [
        {
            "key": p,
            "title": title or p,
            "body": text,
            "base": posixpath.dirname(p),
            "sub": level > 1,
        }
        for p, title, text, level in _link_order(archive, root, allowed, WHOLE_DEPTH)
    ]


def _libretexts_chapters(archive, root):
    m = re.match(r"^index/page_(\d+)$", root)
    raw = (
        _srv.entry_bytes(archive, "content/shared.json", MAX_JSON_BYTES) if m else None
    )
    try:
        pages = json.loads(raw.decode("utf-8", "replace")).get("pages") if raw else []
    except (ValueError, AttributeError):
        pages = []
    pages = [
        p
        for p in pages or []
        if isinstance(p, dict) and isinstance(p.get("path"), str) and p.get("id")
    ]
    book = next((p for p in pages if str(p["id"]) == m.group(1)), None) if m else None
    if book is None:
        return [], {}
    top = book["path"] + "/"
    chosen = [book] + [
        p
        for p in pages
        if p["path"].startswith(top)
        and not _LT_MATTER_RE.search("/" + p["path"][len(top) :])
    ][: MAX_CHAPTERS - 1]
    ids = {p["path"]: str(p["id"]) for p in pages}
    out = []
    for p in chosen:
        data = _srv.entry_bytes(
            archive, f"content/page_content_{p['id']}.json", MAX_PAGE_BYTES
        )
        try:
            body = (
                json.loads(data.decode("utf-8", "replace")).get("htmlBody")
                if data
                else ""
            )
        except (ValueError, AttributeError):
            body = ""
        out.append(
            {
                "key": f"index/page_{p['id']}",
                "title": str(p.get("title") or ""),
                "body": body if isinstance(body, str) else "",
                # Its pictures are named from the ZIM's root, where its app is.
                "base": "",
                "sub": p["path"].count("/") - book["path"].count("/") > 1,
                "route": p["path"],
            }
        )
    return out, ids


# ── the book as one page ───────────────────────────────────────────────────


def _lt_routes(body, zim, index, ids):
    """LibreTexts' own routes (``#/<path>``): to a chapter in the page, or to
    the page's address in the ZIM."""

    def one(m):
        lead, q, path, anchor = m.group(1), m.group(2), m.group(3), m.group(4)
        path = urllib.parse.unquote(path)
        key = f"index/page_{ids[path]}" if path in ids else None
        if key in index:
            target = "#" + (anchor or f"zb-p{index[key]}")
        elif key:
            target = f"/w/{urllib.parse.quote(zim)}/{key}"
        else:
            target = "#"
        return f"{lead}{q}{_html.escape(target, quote=True)}{q}"

    return _LT_ROUTE_RE.sub(one, body)


def build(zim, archive, reader, root, meta):
    """The book at ``root`` as one page (bytes), or None when there is no
    such book. ``meta``: {title, author, lang} for its head."""
    ids = {}
    if reader in ("wikisource", "wikibooks"):
        chapters = _wiki_chapters(archive, root)
    elif reader == "libretexts":
        chapters, ids = _libretexts_chapters(archive, root)
    elif reader == "whole":
        chapters = _whole_chapters(archive, root)
    else:
        return None
    if not chapters:
        return None
    index = {c["key"]: i for i, c in enumerate(chapters)}
    base = f"/w/{urllib.parse.quote(zim)}/"
    mathjax = math_src(archive)
    formulas = 0

    def outside(member, frag):
        return (
            base + urllib.parse.quote(member, safe="/") + (f"#{frag}" if frag else "")
        )

    parts, total = [], 0
    for i, c in enumerate(chapters):
        body = chapter_html(c["body"])
        if ids:
            body = _lt_routes(body, zim, index, ids)
            body = _lt_math(body, c["title"])
        if mathjax:
            body, k = mark_tex(body)
            formulas += k
        body = _epub._rewrite_urls(body, c["base"], index, outside, prefix="zb-p")
        total += len(body)
        if total > MAX_BOOK_BYTES:
            log.warning(
                "Book %s in %s: cut at chapter %d of %d", root, zim, i, len(chapters)
            )
            break
        # The first page is the book's own (its title page, its contents):
        # the reader's title heads it. Every other is a chapter, by name.
        head = ""
        if i:
            sub = ' data-zb-sub=""' if c["sub"] else ""
            head = f"<h2{sub}>{_html.escape(c['title'])}</h2>"
        parts.append(f'<section class="chapter" id="zb-p{i}">{head}{body}</section>')
    title = _html.escape(meta.get("title") or chapters[0]["title"] or root, quote=True)
    creator = _html.escape(meta.get("author") or "", quote=True)
    lang = _html.escape(meta.get("lang") or "", quote=True)
    math = ""
    if formulas:
        src = _html.escape(base + urllib.parse.quote(mathjax), quote=True)
        math = f'<meta name="zimi-math" content="{src}">'
    head = (
        f'<!DOCTYPE html><html lang="{lang}"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{title}</title>"
        f'<meta name="dc.title" content="{title}">'
        f'<meta name="dc.creator" content="{creator}">'
        f'<meta name="dc.language" content="{lang}">'
        f'<meta name="zimi-book" content="pages">{math}</head><body>'
    )
    return (head + "".join(parts) + "</body></html>").encode("utf-8")


_cache = OrderedDict()  # (zim, root, file identity) -> bytes
_cache_lock = threading.Lock()


def _zim_entry(zim):
    return next((z for z in _srv._zim_list_cache or [] if z.get("name") == zim), None)


def _meta(zim, z, reader, root):
    """The book's title, author and language, as the shelf has them."""
    from zimi import books

    key = f"{zim}/" + ("" if reader == "whole" else root)
    if reader == "libretexts":
        key = f"{zim}/" + root.rsplit("_", 1)[-1]
    try:
        _books, by_id = books.shelf()
        b = by_id.get(key) or {}
    except Exception:
        b = {}
    return {
        "title": b.get("title") or (z.get("title") if reader == "whole" else ""),
        "author": b.get("author") or "",
        "lang": b.get("lang") or books._shelf_lang(z),
    }


def respond(zim, entry_path):
    """What ``/w/<zim>/<entry_path>`` answers for a book's address:
    ``(content_type, bytes)``; ``(None, None)`` when the ZIM has no such
    book; None when the path is no book's address, so the ordinary lookup
    answers."""
    root = split(entry_path)
    if root is None:
        return None
    from zimi import books
    from zimi.search import _get_fts_archive

    z = _zim_entry(zim)
    if z is None or not _srv.zim_allowed(zim):
        return None, None
    reader = books.reader_of(z)
    if reader not in READERS:
        return None, None
    key = (zim, root, _epub._identity(zim))
    with _cache_lock:
        got = _cache.get(key)
        if got is not None:
            _cache.move_to_end(key)
            return "text/html; charset=utf-8", got
    meta = _meta(zim, z, reader, root)
    archive, lock = _get_fts_archive(zim)
    if archive is None or lock is None:
        return None, None
    try:
        with lock:
            page = build(zim, archive, reader, root, meta)
    except Exception as e:
        log.warning("Book %s in %s could not be read: %s", root, zim, e)
        page = None
    if page is None:
        return None, None
    with _cache_lock:
        _cache[key] = page
        while len(_cache) > CACHE_BOOKS or (
            len(_cache) > 1 and sum(len(v) for v in _cache.values()) > CACHE_BYTES
        ):
            _cache.popitem(last=False)
    return "text/html; charset=utf-8", page


def _reset_for_tests():
    with _cache_lock:
        _cache.clear()
