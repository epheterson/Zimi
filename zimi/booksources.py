"""The Bookshelf's other shelves: the books a ZIM of each family holds, read
once in the background into the shelf's details file (books.build_sources)
and never on the way to opening the shelf.

Eric, 2026-09-27: "We should have more than Gutenberg in the book app,
support as many as we can across all the apps as well. Be sure to support
our own."

One reader per family, each from the family's own structure (the 1.12
coverage audit, docs/plans/2026-09-28-app-coverage.md):

- ``nautilus``: Kiwix's document libraries (zimgit-*, maitre_lucas,
  prunelle, youscribe...). Their ``database.js`` lists every file with a
  title, an author and a description; the PDFs, EPUBs and pages are books,
  the videos and audio ZimiTube's.
- ``folder``: Zimi's own folder of documents, the same listing at
  ``zimi-database.js`` with a date and a cover; one made before there was a
  listing is read from its files' names.
- ``libretexts``: mindtouch2zim's ``content/shared.json`` holds the page
  tree. A textbook sits at ``Bookshelves/<subject>/<book>`` or
  ``Courses/<campus>/<book>``, its chapters the pages under it, and opens at
  ``index/page_<id>``.
- ``wikisource``: a work is a page at the top of the tree, its chapters the
  pages under it (``Work/Chapter``). Its header's ``#ws-data`` names the
  title, author, translator and year. The scans (``Page:``, ``Index:``) and
  the project's own pages are not works; nor is an article of a periodical.
- ``wikibooks``: a book is a page with three or more pages under it, the
  page its contents; written together, so no author.

A book here is ``{id, title, author, path, format}`` and what else its
family says: ``description``, ``cover``, ``year``, ``date``, ``chapters``,
``subject``, ``translator``, ``publisher``, ``lang``. ``id`` is unique in
its ZIM; ``path`` is what opens in the reader (an EPUB's chapters at
``<file>.epub/``).
"""

import html as _html
import json
import logging
import posixpath
import re
from collections import Counter

from zimi import epub as _epub
from zimi import nautilus
from zimi import server as _srv

log = logging.getLogger("zimi")

MAX_JSON_BYTES = 64 * 1024 * 1024
# Authors a listing writes when it knows none.
_NO_AUTHOR = frozenset(("", "-", "?", "unknown", "inconnu", "anonyme", "n/a"))
_TAG_RE = re.compile(r"<[^>]+>")
_YEAR_RE = re.compile(r"(?<!\d)(\d{3,4})(?!\d)")

# LibreTexts: where the books are, and a trailing "(Author)" in a title.
_LT_SHELVES = ("Bookshelves", "Courses")
_LT_BOOK_DEPTH = 3
_LT_AUTHOR_RE = re.compile(r"\(([^()\d:]{2,60})\)\s*$")

# A wiki page in one of the project's namespaces (Author:Jane_Austen,
# Index:Foo.djvu, Wikibooks:Huvudsida): no space before the colon and none
# after, where a work's title has one ("Tokipono:_La_lingvo_de_bono").
_NAMESPACE_RE = re.compile(r"^[^/_:]+:[^_]")
# A scanned book's own page (Indekso:Foo,_1897.pdf).
_SCAN_RE = re.compile(r"\.(?:djvu|pdf|tiff?|jpe?g|png|gif|webp)$", re.I)
_WS_FIELD_RE = re.compile(
    r'(?:class|id)="ws-(type|title|author|translator|year|publisher)"[^>]*>(.*?)</span>',
    re.S,
)
# The header's record sits at the end of the page; this much of it is read.
_WS_BLOCK = 6000
# Wikisource types that are not a work of their own: an article of a
# periodical ("ws-title" is then the periodical's).
_WS_SKIP_TYPES = frozenset(("journal",))
# A Wikibooks book: a page with at least this many pages under it.
WIKIBOOKS_MIN_PAGES = 3


# ── reading a ZIM ──────────────────────────────────────────────────────────
#
# An entry that is not there is not there; one that will not read raises
# (server.entry_item), and the background read that met it leaves no file,
# so the next start reads the ZIM again (details.DetailsBuilder.build_one).


def _clean(fragment):
    """Text from a bit of HTML: tags out, entities read, spaces tidied."""
    return re.sub(r"\s+", " ", _html.unescape(_TAG_RE.sub("", fragment or ""))).strip()


def _author(value):
    a = str(value or "").strip()
    return "" if a.casefold() in _NO_AUTHOR else a


def _year(value):
    m = _YEAR_RE.search(value or "")
    return int(m.group(1)) if m else None


def _walk(archive):
    """The pages of a wiki: ``([(path, title)] at the top of the tree,
    {root: pages under it})``. Redirects are not pages; neither is anything
    but HTML at the top."""
    tops, subs = [], Counter()
    for e, item in _srv.walk_entries(archive, bounded=False):
        p = e.path
        if "/" in p:
            subs[p.split("/", 1)[0]] += 1
        elif item.mimetype.startswith("text/html"):
            tops.append((p, e.title))
    return tops, subs


# ── document libraries: nautilus, and Zimi's own folders ───────────────────


def _epub_facts(archive, path):
    data = _srv.entry_bytes(archive, path, _epub.MAX_BOOK_BYTES)
    if data is None:
        return {}
    try:
        return _epub.Book(data).facts()
    except _epub.EpubError:
        return {}


def _documents(archive, items, base):
    """The books among a listing's ``items``: each item whose files hold a
    PDF, an EPUB or a page, opened at its first such file."""
    out = []
    for n, item in enumerate(items):
        if nautilus.media_of(item) != "document":
            continue
        files = nautilus.files_of(item, base)
        doc = next((p for p in files if nautilus.ext_kind(p) == "document"), "")
        if not doc or not archive.has_entry_by_path(doc):
            continue
        ext = posixpath.splitext(doc)[1].lower()
        titled = bool(str(item.get("ti") or "").strip())
        book = {
            "id": str(item.get("_id") or n),
            "title": str(item.get("ti") or "").strip() or nautilus.title_from_name(doc),
            "author": _author(item.get("aut")),
            "path": doc,
            "format": "html" if ext in (".html", ".htm") else ext[1:],
        }
        if str(item.get("dsc") or "").strip():
            book["description"] = str(item["dsc"]).strip()
        if item.get("dt"):
            book["date"] = str(item["dt"])[:10]
        if item.get("cv") and _epub.split(str(item["cv"])):
            book["cover"] = str(item["cv"])
        if ext == ".epub":
            book["path"] = _epub.book_path(doc)
            # What the listing left out, from the book's own package.
            if not book.get("cover") or not book["author"] or not titled:
                facts = _epub_facts(archive, doc)
                if facts.get("title") and not titled:
                    book["title"] = facts["title"]
                if facts.get("cover") and not book.get("cover"):
                    book["cover"] = _epub.book_path(doc) + facts["cover"]
                if not book["author"] and facts.get("creators"):
                    book["author"] = " & ".join(facts["creators"])
                if facts.get("date") and not book.get("date"):
                    book["date"] = facts["date"]
                if facts.get("language"):
                    book["lang"] = facts["language"].split("-")[0].lower()
        if book.get("date") and _year(book["date"]):
            book["year"] = _year(book["date"])
        out.append(book)
    return out


def nautilus_books(archive):
    return _documents(archive, nautilus.items(archive), nautilus.FILES_PREFIX)


def _document_entries(archive):
    """Listing items for a folder ZIM packed before it had a listing: its
    PDFs and EPUBs, named by their files."""
    return [
        {"_id": e.path, "fp": [e.path]}
        for e, item in _srv.walk_entries(archive)
        if item.mimetype in _srv._DOC_MIMETYPES
    ]


def folder_books(archive):
    items = nautilus.items(archive, nautilus.ZIMI_DATABASE_PATH) or _document_entries(
        archive
    )
    return _documents(archive, items, "")


# ── LibreTexts ─────────────────────────────────────────────────────────────


def libretexts_books(archive):
    raw = _srv.entry_bytes(archive, "content/shared.json", MAX_JSON_BYTES)
    try:
        data = json.loads(raw.decode("utf-8", "replace")) if raw else {}
    except ValueError:
        data = {}
    pages = [
        p
        for p in (data.get("pages") if isinstance(data, dict) else None) or []
        if isinstance(p, dict) and isinstance(p.get("path"), str) and p.get("id")
    ]
    by_path = {p["path"]: p for p in pages}
    chapters = Counter(
        p["path"].rsplit("/", 1)[0]
        for p in pages
        if p["path"].count("/") == _LT_BOOK_DEPTH
    )
    out = []
    for p in pages:
        parts = p["path"].split("/")
        if len(parts) != _LT_BOOK_DEPTH or parts[0] not in _LT_SHELVES:
            continue
        n = chapters.get(p["path"], 0)
        page = f"index/page_{p['id']}"
        if not n or not archive.has_entry_by_path(page):
            continue
        title = str(p.get("title") or "").strip() or parts[-1].replace("_", " ")
        m = _LT_AUTHOR_RE.search(title)
        # "(Siegrist)" is its author; "(CUNY)" a campus.
        author = m.group(1).strip() if m and not m.group(1).isupper() else ""
        book = {
            "id": str(p["id"]),
            "title": title,
            "author": author,
            "path": page,
            "format": "html",
            "chapters": n,
            "subject": str((by_path.get("/".join(parts[:2])) or {}).get("title") or ""),
        }
        # The library's own shelves before the campuses' remixes of them.
        out.append(((parts[0] != _LT_SHELVES[0], title.casefold()), book))
    out.sort(key=lambda o: o[0])
    return [book for _order, book in out]


# ── Wikisource and Wikibooks ───────────────────────────────────────────────


def _ws_record(archive, path):
    """The fields of a page's ``#ws-data``, {} when it has none."""
    data = _srv.entry_bytes(archive, path, _epub.MAX_MEMBER_BYTES)
    k = data.rfind(b'id="ws-data"') if data else -1
    if k < 0:
        return {}
    block = data[k : k + _WS_BLOCK].decode("utf-8", "replace")
    fields = {}
    for key, value in _WS_FIELD_RE.findall(block):
        fields.setdefault(key, _clean(value))
    fields.setdefault("type", "")
    return fields


def wikisource_books(archive):
    tops, subs = _walk(archive)
    out = []
    for path, title in tops:
        if _NAMESPACE_RE.match(path) or _SCAN_RE.search(path):
            continue
        rec = _ws_record(archive, path)
        if not rec or rec["type"] in _WS_SKIP_TYPES:
            continue
        own = title or path.replace("_", " ")
        # A piece of a collection names the collection as its ws-title.
        book = {
            "id": path,
            "title": own if rec["type"] == "collection" else (rec.get("title") or own),
            "author": _author(rec.get("author")),
            "path": path,
            "format": "html",
            "chapters": subs.get(path, 0),
        }
        for key in ("translator", "publisher"):
            if rec.get(key):
                book[key] = rec[key]
        if _year(rec.get("year")):
            book["year"] = _year(rec.get("year"))
        out.append(book)
    # The longest works first: a shelf's front without a count of readers.
    out.sort(key=lambda b: (-b["chapters"], b["title"].casefold()))
    return out


def wikibooks_books(archive):
    tops, subs = _walk(archive)
    titles = dict(tops)
    out = [
        {
            "id": root,
            "title": titles[root] or root.replace("_", " "),
            "author": "",
            "path": root,
            "format": "html",
            "chapters": n,
        }
        for root, n in subs.items()
        if n >= WIKIBOOKS_MIN_PAGES and root in titles and not _NAMESPACE_RE.match(root)
    ]
    out.sort(key=lambda b: (-b["chapters"], b["title"].casefold()))
    return out


READERS = {
    "nautilus": nautilus_books,
    "folder": folder_books,
    "libretexts": libretexts_books,
    "wikisource": wikisource_books,
    "wikibooks": wikibooks_books,
}


def books_in(archive, reader):
    """The books a ZIM holds, by its family's ``reader``; [] for a family
    with no reader here (a whole-ZIM book needs none)."""
    fn = READERS.get(reader)
    return fn(archive) if fn else []
