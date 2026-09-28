"""Bookshelf: every book in the library, as one shelf. Project Gutenberg
first, and beside it the other families (zimi.booksources): Kiwix's
document libraries, LibreTexts, Wikisource and Wikibooks, Zimi's own folders
of documents, and ZIMs that are one book each.

Eric, 2026-09-25: "Book app with nice browsing interface by author and date
or whatever and reading view of course."

Kiwix builds every Gutenberg ZIM with gutenberg2zim, and its own browsing UI
reads a few listing files the scraper leaves in the ZIM; the shelf reads the
same ones:

- ``full_by_popularity.js``: ``var json_data = [[title, author, formats,
  id, lcc], ...]``, most read first. ``formats`` is three flags (HTML, EPUB,
  PDF); a book whose first flag is 0 has no page to read, only its cover
  page and its EPUB.
- ``languages.js`` (``[[name, code, count]]``) and, when there are several,
  ``lang_<code>_by_title.js`` for which book is in which.
- A book's page is ``<title>.<id>`` (the title with ``/`` made ``-`` and cut
  at 230 characters), its cover page ``<title>_cover.<id>``, its picture
  ``covers/<id>_cover_image.jpg``.

gutenberg_en_all (60,366 books) parses in under a tenth of a second on the
NAS, so the shelf opens from those alone. What the listings lack is read
from each book's own head, where Project Gutenberg's Dublin Core record
survives: ``dc.creator`` ("Ewald, Carl, 1856-1908", the author's years),
``dc.subject`` (Library of Congress subject headings) and
``dcterms.created`` (the day the book came to Project Gutenberg). No
original publication date is anywhere in the ZIM, so "by date" is the
author's era and "newest" is newest to Gutenberg. Reading 60,000 heads takes
about half an hour on the NAS, so it happens once, in the background, into
``<data dir>/books/<name>.db`` (checked against the ZIM as the title index
is), and the shelf gains eras and subjects when it is there.

The other families are read the same way, but wholly: a ZIM's books are
listed by its background read (build_sources, into ``<data dir>/shelf/``)
and join the shelf when it is done, so opening the shelf never reads a ZIM
for them. A ZIM is on the shelf by what it feeds (server._zim_feeds, from
metadata the library load reads anyway); a ZIM that is one book (a textbook
captured whole) is on it by a shipped list of Names, or by hand
(set_whole). Their ids are ``<zim>/<id in the ZIM>``, Gutenberg's its book
numbers.
"""

import json
import logging
import os
import re
import threading
import unicodedata

from zimi import booksources
from zimi import epub as _epub
from zimi import server as _srv
from zimi.details import DetailsBuilder

log = logging.getLogger("zimi")

_MAX_LISTING_BYTES = 64 * 1024 * 1024
# gutenberg2zim cuts a book's title to this many characters in its path.
_PATH_TITLE_MAX = 230
# The head of a book page holds its Dublin Core record; the body can be
# megabytes. The largest head seen (a book with forty subject headings) is
# under 12 KB.
_HEAD_BYTES = 32 * 1024
LIST_LIMIT = 60
LIST_LIMIT_MAX = 200
SHELF_SIZE = 24
AUTHOR_BOOKS = 24
# The other families' books come after every Gutenberg one in "most read":
# they have no count of readers, only their own order.
SOURCE_RANK = 10_000_000

_lock = threading.Lock()
_base = {}  # archive filename -> (name, [book]) from the listings alone
_shelf = {
    "key": None,
    "books": [],
    "by_id": {},
}  # the merged shelf, rebuilt when a source changes


# ── reading a ZIM ──────────────────────────────────────────────────────────


def _read(archive, path, max_bytes=_MAX_LISTING_BYTES, head=None):
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        item = entry.get_item()
        if item.size > max_bytes and head is None:
            return None
        data = bytes(item.content)
        if head is not None:
            data = data[:head]
        return data.decode("utf-8", "replace")
    except Exception:
        return None


def _js_array(text):
    """The array a listing file assigns (``var x = [...];``), or []."""
    if not text:
        return []
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < start:
        return []
    try:
        got = json.loads(text[start : end + 1])
    except ValueError:
        return []
    return got if isinstance(got, list) else []


def page_title(title):
    """A title as gutenberg2zim writes it into a path."""
    return (title or "").replace("/", "-")[:_PATH_TITLE_MAX]


def book_path(title, book_id, cover=False):
    return f"{page_title(title)}{'_cover' if cover else ''}.{book_id}"


def cover_image(book_id):
    return f"covers/{book_id}_cover_image.jpg"


def epub_file(title, book_id):
    """Where gutenberg2zim puts a book's EPUB."""
    return f"{page_title(title)}.{book_id}.epub"


def _languages(archive):
    """[(code, count)] from ``languages.js``."""
    out = []
    for row in _js_array(_read(archive, "languages.js")):
        if isinstance(row, list) and len(row) >= 3 and isinstance(row[1], str):
            out.append((row[1], _int(row[2], 0)))
    return out


def books_of(archive):
    """Every book the ZIM lists, most read first:
    ``{id, title, author, shelf, lang, rank, html, path}``. [] for a ZIM
    without gutenberg2zim's listings."""
    rows = _js_array(_read(archive, "full_by_popularity.js"))
    if not rows:
        return []
    langs = _languages(archive)
    lang_of = {}
    if len(langs) == 1:
        only = langs[0][0]
    else:
        only = ""
        for code, _n in langs:
            for r in _js_array(_read(archive, f"lang_{code}_by_title.js")):
                book_id = _int(r[3]) if isinstance(r, list) and len(r) >= 4 else None
                if book_id is not None:
                    lang_of.setdefault(book_id, code)
    out = []
    for rank, r in enumerate(rows):
        if not isinstance(r, list) or len(r) < 5:
            continue
        title, author, formats, book_id, shelf = r[:5]
        try:
            book_id = int(book_id)
        except (TypeError, ValueError):
            continue
        html = str(formats or "1")[:1] != "0"
        title = str(title or "").strip()
        out.append(
            {
                "id": book_id,
                "title": title,
                "author": str(author or "").strip(),
                "shelf": str(shelf or "").strip().upper(),
                "lang": lang_of.get(book_id, only),
                "rank": rank,
                "html": html,
                # The second flag: an EPUB, which an EPUB-only book is read in.
                "epub": str(formats or "")[1:2] == "1",
                "path": book_path(title, book_id, cover=not html),
            }
        )
    return out


_META_RE = re.compile(r"<meta\b[^>]*>", re.I)
_ATTR_RE = re.compile(r"\b(name|content|property)\s*=\s*\"([^\"]*)\"", re.I)
# "Ewald, Carl, 1856-1908", "Virgil, 71 BCE-20 BCE", "Catullus, Gaius
# Valerius, 84? BCE-54 BCE", "Twain, Mark, 1835-1910", "Homer, 751? BCE-651? BCE",
# "Kant, Immanuel, 1724-1804", "Plato, 428? BCE-348? BCE", "Unknown, -1900".
_YEARS_RE = re.compile(
    r",\s*(?:active\s+)?(\d{1,4})?\??\s*(BCE|BC)?\s*-\s*(\d{1,4})?\??\s*(BCE|BC)?\s*$",
    re.I,
)


def _unescape(s):
    import html

    return html.unescape(s or "").strip()


def head_facts(text):
    """The Dublin Core record in a book page's head: ``{creators:
    [(name, born, died)], subjects: [...], created: "YYYY-MM-DD"}``, years
    negative before the common era and None when unknown."""
    head = text.split("<body", 1)[0] if text else ""
    creators, subjects, created = [], [], ""
    for tag in _META_RE.findall(head):
        attrs = {k.lower(): v for k, v in _ATTR_RE.findall(tag)}
        name = attrs.get("name", "").lower()
        value = _unescape(attrs.get("content", ""))
        if not value:
            continue
        if name == "dc.creator":
            creators.append(creator_years(value))
        elif name == "dc.subject":
            subjects.append(value)
        elif name == "dcterms.created" and not created:
            created = value[:10]
    return {"creators": creators, "subjects": subjects, "created": created}


def creator_years(value):
    """("Ewald, Carl", 1856, 1908) from "Ewald, Carl, 1856-1908"."""
    m = _YEARS_RE.search(value or "")
    if not m:
        return (value, None, None)
    born = int(m.group(1)) if m.group(1) else None
    died = int(m.group(3)) if m.group(3) else None
    # Each year carries its own era: "71 BCE-20 BCE".
    if born is not None and m.group(2):
        born = -born
    if died is not None and m.group(4):
        died = -died
    return (value[: m.start()].strip(), born, died)


def era_of(born, died):
    """The hundred years a writer worked in, named by the first (1800 for
    1800 to 1899; -100 for 100 to 1 BCE), or None. A life is placed by the
    year it ended (a writer's books come late), or forty years after it
    began when the end is unknown."""
    year = died if died is not None else (born + 40 if born is not None else None)
    if year is None:
        return None
    if year >= 0:
        return year // 100 * 100
    return -((-year - 1) // 100 + 1) * 100


# ── the shelf across ZIMs ──────────────────────────────────────────────────


def reader_of(z):
    """How the shelf reads the library entry ``z``: "gutenberg", a family of
    booksources ("nautilus", "wikisource"...), "whole" for a ZIM that is one
    book, or "" for a ZIM that is not on the shelf."""
    if z.get("kind") == "books":
        return "gutenberg"
    by_hand = _whole_overrides().get(z.get("name") or "")
    if by_hand is False:
        return ""
    return (z.get("feeds") or {}).get("books") or ("whole" if by_hand else "")


def _book_zims():
    return [
        z
        for z in (_srv._zim_list_cache or [])
        if z.get("name") and reader_of(z) and _srv.zim_allowed(z["name"])
    ]


def _source_zim(z):
    """A ZIM whose books the background read lists (not Gutenberg's, whose
    listings are read at once; not a whole-ZIM book, which is its entry)."""
    return reader_of(z) in booksources.READERS


def _zim_key(name):
    """What a ZIM's rows and records are kept under: the file the library
    has registered for ``name`` (a new build is another file, read afresh),
    or the name when there is none."""
    return _srv.get_zim_files().get(name) or name


def _let_go(name, keep=None):
    """Free the listed books of every build of ``name`` but ``keep``'s.
    Caller holds _lock."""
    for key in [k for k, (n, _rows) in _base.items() if n == name and k != keep]:
        del _base[key]


def _books_for(name):
    """The listed books of the installed ZIM ``name``, cached per file."""
    from zimi.search import _get_fts_archive

    key = _zim_key(name)
    try:
        archive, lock = _get_fts_archive(name)
    except Exception as e:
        archive, lock = None, None
        log.warning("Bookshelf: could not open %s: %s", name, e)
    if archive is None or lock is None:
        # Nothing to read, so nothing to wait for: the shelf is ready without
        # it. Not kept in _base, so the next look tries the file again.
        _builder.keep(name, key, {})
        return None, []
    with _lock:
        if key in _base:
            return key, _base[key][1]
    try:
        with lock:
            rows = books_of(archive)
    except Exception as e:
        # One malformed ZIM is skipped, never the whole shelf.
        log.warning("Bookshelf: the listings of %s could not be read: %s", name, e)
        rows = []
    with _lock:
        # Last month's build, read before this one, is let go.
        _let_go(name, keep=key)
        _base[key] = (name, rows)
    if not rows:
        # No books, so no records to read: the shelf stops waiting for them.
        _builder.keep(name, key, {})
    elif _builder.kept(name, key) is None:
        request_details(name)
    return key, rows


def _merge(book, zim, detail):
    b = dict(book, zim=zim)
    if detail:
        if detail.get("creators"):
            first = detail["creators"][0]
            b["born"], b["died"] = first[1], first[2]
            b["era"] = era_of(first[1], first[2])
            b["sort_author"] = first[0]
        b["subjects"] = detail.get("subjects") or []
        b["created"] = detail.get("created") or ""
        if detail.get("path"):
            b["path"] = detail["path"]
        b["cover"] = cover_image(b["id"]) if detail.get("cover") else ""
    else:
        # Not read yet: the picture is where gutenberg2zim puts it, and the
        # page falls back to a typographic cover when it is not there.
        b["cover"] = cover_image(b["id"])
    if not b["html"] and b.get("epub"):
        # No page to read: its EPUB's chapters, served from the zip.
        b["path"] = _epub.book_path(epub_file(b["title"], b["id"]))
    return b


def _whole_book(z):
    """A ZIM that is one book: its own card, its main page the contents."""
    return {
        "id": "",
        "title": z.get("title") or z["name"],
        "author": "",
        "path": z.get("main_path") or "",
        "format": "html",
        "description": z.get("description") or "",
    }


def _source_parts(z):
    """``(reader, key, books)`` for a ZIM of the other families: what its
    background read listed, or None while it is still to be read (asked for
    here, in the background, never waited for)."""
    reader = reader_of(z)
    key = _zim_key(z["name"])
    if reader == "whole":
        return reader, key, [_whole_book(z)] if z.get("main_path") else []
    got = _sources.kept(z["name"], key)
    if got is None:
        request_sources(z["name"])
    return reader, key, got


# Kiwix names a ZIM with the two-letter code of its language where there
# is one (wikisource_eo_all), which Gutenberg's listings use too; the
# metadata may carry the three-letter one (epo).
_NAME_LANG_RE = re.compile(r"^[^_]+_([a-z]{2})_")


def _shelf_lang(z):
    """A ZIM's language as the shelf files its books: two letters where
    the language has them, so Esperanto is one language whichever ZIM."""
    code = (z.get("language") or "").split(",")[0]
    if len(code) == 3:
        m = _NAME_LANG_RE.match(z.get("file") or "")
        if m:
            return m.group(1)
    return code


def _merge_source(book, z, reader):
    b = dict(book)
    b["id"] = f"{z['name']}/{book['id']}"
    b["zim"] = z["name"]
    b["source"] = reader
    b["rank"] = SOURCE_RANK + book.get("_n", 0)
    b.pop("_n", None)
    b.setdefault("author", "")
    b["shelf"] = ""
    b["html"] = True
    b["lang"] = book.get("lang") or _shelf_lang(z)
    if book.get("year") is not None:
        b["era"] = era_of(None, book["year"])
    return b


def shelf():
    """Every book on the shelf, once: a book in two ZIMs (all of English and
    one of its LCC subsets, last month's build beside this month's) comes
    from the newest build, then the fullest. The other families' books join
    as their ZIMs are read."""
    zims = sorted(_book_zims(), key=_srv.build_rank, reverse=True)
    parts, sources = [], []
    for z in zims:
        if reader_of(z) != "gutenberg":
            reader, key, got = _source_parts(z)
            if got is not None:
                sources.append((z, reader, key, got))
            continue
        key, rows = _books_for(z["name"])
        if key is None:
            continue
        parts.append((z["name"], key, rows, _builder.kept(z["name"], key)))
    stamp = tuple((n, k, len(r), d is not None) for n, k, r, d in parts) + tuple(
        (z["name"], reader, k, len(got)) for z, reader, k, got in sources
    )
    with _lock:
        if _shelf["key"] == stamp:
            return _shelf["books"], _shelf["by_id"]
    books, by_id = [], {}
    for name, _key, rows, details in parts:
        for book in rows:
            key = str(book["id"])
            if key in by_id:
                continue
            b = _merge(book, name, (details or {}).get(book["id"]))
            by_id[key] = b
            books.append(b)
    for z, reader, _key, got in sources:
        for book in got:
            b = _merge_source(book, z, reader)
            if b["id"] not in by_id:
                by_id[b["id"]] = b
                books.append(b)
    # Most read first across ZIMs: each ZIM's rank is its own order, so
    # interleave by rank (the top of every shelf before the rest of any).
    books.sort(key=lambda b: b["rank"])
    for b in books:
        b["_fold"] = fold(b["title"] + " " + b["author"])
    with _lock:
        _shelf.update(key=stamp, books=books, by_id=by_id)
    return books, by_id


def fold(s):
    """Lowercase without accents, so "Misérables" is found by "miserables"."""
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).casefold()


def surname(b):
    """What an author is filed under: the catalog's "Surname, Given" when
    the book's record has been read, else the last word of the name."""
    s = b.get("sort_author")
    if s:
        return fold(s)
    parts = (b.get("author") or "").split()
    return fold(" ".join(parts[-1:] + parts[:-1]))


def split_title(title):
    """(title, subtitle): Gutenberg's catalog keeps MARC's subfield mark
    between them ("Aztec place-names : $b Their meaning and mode of
    composition")."""
    head, sep, tail = (title or "").partition("$b")
    if not sep:
        return title, ""
    return head.strip().rstrip(":;,/ ").strip(), tail.strip()


def card(b):
    out = _card_fields(b)
    out["title"], sub = split_title(b["title"])
    if sub:
        out["subtitle"] = sub
    return out


def _card_fields(b):
    return {
        k: b.get(k)
        for k in (
            "zim",
            "id",
            "author",
            "lang",
            "shelf",
            "path",
            "cover",
            "html",
            "born",
            "died",
            "era",
            "created",
            "source",
            "format",
            "year",
        )
        if b.get(k) not in (None, "")
    }


_SORTS = {
    "popular": lambda b: b["rank"],
    "title": lambda b: fold(b["title"]),
    "author": lambda b: (surname(b), fold(b["title"])),
    # Newest to Project Gutenberg: the day it came, else its number, which
    # Gutenberg gives out in order. The other families have neither.
    "recent": lambda b: (b.get("created") or "", b["id"] if isinstance(b["id"], int) else -1),
}


def _filtered(books, q="", author="", shelf_code="", lang="", era=None, zim=""):
    words = fold(q).split()
    out = []
    for b in books:
        if author and b["author"] != author:
            continue
        if shelf_code and not b["shelf"].startswith(shelf_code):
            continue
        if lang and b["lang"] != lang:
            continue
        if era is not None and b.get("era") != era:
            continue
        if zim and b["zim"] != zim:
            continue
        if words and not all(w in b["_fold"] for w in words):
            continue
        out.append(b)
    return out


def _int(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def listing(
    q="",
    author="",
    shelf_code="",
    lang="",
    era="",
    zim="",
    sort="popular",
    offset=0,
    limit=LIST_LIMIT,
):
    books, _ = shelf()
    got = _filtered(books, q, author, (shelf_code or "").upper(), lang, _int(era), zim)
    sort = sort if sort in _SORTS else "popular"
    if sort != "popular":
        got = sorted(got, key=_SORTS[sort], reverse=(sort == "recent"))
    offset = max(0, _int(offset, 0))
    limit = min(max(1, _int(limit, LIST_LIMIT)), LIST_LIMIT_MAX)
    return {"total": len(got), "books": [card(b) for b in got[offset : offset + limit]]}


def authors(
    q="", lang="", shelf_code="", era="", sort="name", offset=0, limit=LIST_LIMIT
):
    """The writers on the shelf, each once with how many books: by surname,
    or by how read they are (their most read book's place)."""
    books, _ = shelf()
    got = _filtered(books, "", "", (shelf_code or "").upper(), lang, _int(era))
    words = fold(q).split()
    by = {}
    for b in got:
        a = b["author"]
        if not a or (words and not all(w in fold(a) for w in words)):
            continue
        cur = by.get(a)
        if cur is None:
            by[a] = {
                "name": a,
                "n": 1,
                "rank": b["rank"],
                "_sort": surname(b),
                "born": b.get("born"),
                "died": b.get("died"),
            }
        else:
            cur["n"] += 1
    rows = list(by.values())
    if sort == "books":
        rows.sort(key=lambda r: (-r["n"], r["rank"]))
    elif sort == "popular":
        rows.sort(key=lambda r: r["rank"])
    else:
        rows.sort(key=lambda r: r["_sort"])
    offset = max(0, _int(offset, 0))
    limit = min(max(1, _int(limit, LIST_LIMIT)), LIST_LIMIT_MAX)
    page = [
        {
            k: v
            for k, v in r.items()
            if not k.startswith("_") and k != "rank" and v is not None
        }
        for r in rows[offset : offset + limit]
    ]
    return {"total": len(rows), "authors": page}


def _counts(books, key):
    c = {}
    for b in books:
        v = key(b)
        if v not in (None, ""):
            c[v] = c.get(v, 0) + 1
    return c


def home():
    """The front of the shelf: the sources, what there is to browse by (a
    count per language, LCC shelf and era), and the first books of the
    popular and the newest shelves."""
    books, _ = shelf()
    zims = _book_zims()
    langs = _counts(books, lambda b: b["lang"])
    shelves = _counts(
        books, lambda b: b["shelf"][:2] if b["shelf"][:1] == "P" else b["shelf"][:1]
    )
    eras = _counts(books, lambda b: b.get("era"))
    ready = (
        all(_details_ready(z) for z in zims)
        if zims
        else False
    )
    # Newest to Project Gutenberg: its books only, the others have no such day.
    recent = (
        [
            b
            for b in sorted(books, key=_SORTS["recent"], reverse=True)[:SHELF_SIZE]
            if b.get("created")
        ]
        if ready
        else []
    )
    return {
        "total": len(books),
        "sources": [
            {
                "name": z["name"],
                "title": z.get("title") or z["name"],
                "language": (z.get("language") or "").split(",")[0],
                "date": z.get("date") or "",
                "reader": reader_of(z),
            }
            for z in zims
        ],
        "languages": sorted(
            ({"code": k, "n": v} for k, v in langs.items()), key=lambda r: -r["n"]
        ),
        "shelves": sorted(
            ({"code": k, "n": v} for k, v in shelves.items()), key=lambda r: r["code"]
        ),
        "eras": sorted(
            ({"from": k, "n": v} for k, v in eras.items()), key=lambda r: r["from"]
        ),
        "details": ready,
        "popular": [card(b) for b in books[:SHELF_SIZE]],
        "recent": [card(b) for b in recent],
    }


def _details_ready(z):
    """Whether what the background reads of ``z`` has been read, from the
    build of it the library has now."""
    reader = reader_of(z)
    if reader == "gutenberg":
        builder = _builder
    elif reader in booksources.READERS:
        builder = _sources
    else:
        return True
    return builder.kept(z["name"], _zim_key(z["name"])) is not None


def book(zim, book_id):
    """One book with everything known of it, and more by its author."""
    if zim and not _srv.zim_allowed(zim):
        return None
    books, by_id = shelf()
    b = by_id.get(str(book_id))
    if not b:
        return None
    out = card(b)
    if b.get("source"):
        if zim and b["zim"] != zim:
            return None
        for k in ("description", "chapters", "subject", "translator", "publisher", "date"):
            if b.get(k) not in (None, ""):
                out[k] = b[k]
        if b.get("format") == "epub":
            # The file itself, to download.
            out["epub"] = b["path"].rstrip("/")
    else:
        if zim and b["zim"] != zim and not _has_book(zim, b["id"]):
            return None
        out["subjects"] = b.get("subjects") or []
        out["cover_page"] = book_path(b["title"], b["id"], cover=True)
        out["epub"] = epub_file(b["title"], b["id"])
    more = (
        [card(x) for x in books if x["author"] == b["author"] and x["id"] != b["id"]][
            :AUTHOR_BOOKS
        ]
        if b["author"]
        else []
    )
    out["more"] = more
    return out


def _has_book(zim, book_id):
    _key, rows = _books_for(zim)
    return any(r["id"] == book_id for r in rows)


def is_books(name):
    return any(z["name"] == name for z in _book_zims())


# ── the details build ──────────────────────────────────────────────────────


def _exists(archive, path):
    try:
        return archive.has_entry_by_path(path)
    except Exception:
        return False


def build_details(zim_name, zim_path):
    """Read each book's head once, into the details file: its writers and
    their years, its subjects, the day it came to Gutenberg, whether it has
    a picture, and its page when the listing's title does not lead to it.
    Opens an archive of its own, never the pool's; runs in a child process
    for a big ZIM."""
    archive = _srv.open_archive(zim_path)
    rows = []
    for b in books_of(archive):
        path = b["path"]
        if not _exists(archive, path):
            cover_page = book_path(b["title"], b["id"], cover=True)
            path = cover_page if _exists(archive, cover_page) else ""
        facts = (
            head_facts(_read(archive, path, head=_HEAD_BYTES) or "")
            if path and b["html"] and path == b["path"]
            else {}
        )
        rows.append(
            (
                b["id"],
                json.dumps(facts.get("creators") or []),
                json.dumps(facts.get("subjects") or []),
                facts.get("created") or "",
                1 if _exists(archive, cover_image(b["id"])) else 0,
                "" if path == b["path"] else path,
            )
        )
    return _builder.write(zim_name, zim_path, archive, rows)


def _records_of(rows):
    return {
        i: {
            "creators": [tuple(c) for c in json.loads(creators or "[]")],
            "subjects": json.loads(subjects or "[]"),
            "created": created,
            "cover": bool(cover),
            "path": path,
        }
        for i, creators, subjects, created, cover, path in rows
    }


def _shelf_changed(_name, _key, _records):
    _shelf["key"] = None


def _gone(name):
    """A ZIM taken out of the library before its records were read: nothing
    left to wait for."""
    log.warning("Bookshelf: %s is no longer in the library", name)
    with _lock:
        _let_go(name)
    _builder.keep(name, _zim_key(name), {})


_builder = DetailsBuilder(
    "books",
    zims="books",
    label="Bookshelf",
    what="book records",
    version="1",
    table="books",
    columns=(
        "id INTEGER PRIMARY KEY",
        "creators TEXT",
        "subjects TEXT",
        "created TEXT",
        "cover INTEGER",
        "path TEXT",
    ),
    # Looked up when it runs, as the child process looks it up.
    build=lambda name, path: build_details(name, path),
    load=_records_of,
    lock=_lock,
    on_keep=_shelf_changed,
    gone=_gone,
)
# One Gutenberg ZIM's book records, in the background.
request_details = _builder.request


# ── the other families: each ZIM's books, read once in the background ────


def build_sources(zim_name, zim_path):
    """List a ZIM's books into its file (zimi.booksources), by the family
    its own metadata names. Opens an archive of its own; runs in a child
    process for a big ZIM, which has no library to ask."""
    archive = _srv.open_archive(zim_path)
    reader = _srv.archive_feeds(archive).get("books") or ""
    rows = []
    for n, book in enumerate(booksources.books_in(archive, reader)):
        book = dict(book, _n=n)
        rows.append((str(book["id"]), json.dumps(book, ensure_ascii=False)))
    return _sources.write(zim_name, zim_path, archive, rows)


def _sources_of(rows):
    got = [json.loads(book) for _id, book in rows]
    got.sort(key=lambda b: b.get("_n", 0))
    return got


def _gone_source(name):
    log.warning("Bookshelf: %s is no longer in the library", name)
    _sources.keep(name, name, [])


_sources = DetailsBuilder(
    "shelf",
    zims=_source_zim,
    label="Bookshelf",
    what="books",
    version="1",
    table="books",
    columns=("id TEXT PRIMARY KEY", "book TEXT"),
    # Looked up when it runs, as the child process looks it up.
    build=lambda name, path: build_sources(name, path),
    load=_sources_of,
    lock=_lock,
    on_keep=_shelf_changed,
    gone=_gone_source,
)
request_sources = _sources.request


def build_all_details():
    """Every Gutenberg ZIM's book records, then every other family's books,
    one ZIM after another (the startup worker's phase after ZimiTube's)."""
    _whole_overrides()
    _builder.build_all()
    _sources.build_all()


# ── a ZIM that is one book, by hand ────────────────────────────────────────

_whole = {"loaded": False, "names": {}}


def _whole_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "books", "whole.json")


def _whole_overrides():
    """``{zim name: True|False}``: ZIMs put on the shelf as one book, or
    taken off it, by hand. Read once (the startup worker reads it first)."""
    if not _whole["loaded"]:
        names = {}
        try:
            with open(_whole_path(), encoding="utf-8") as f:
                got = json.load(f)
            if isinstance(got, dict):
                names = {str(k): bool(v) for k, v in got.items()}
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            log.warning("Bookshelf: %s unreadable: %s", _whole_path(), e)
        _whole.update(loaded=True, names=names)
    return _whole["names"]


def set_whole(name, whole):
    """Put the ZIM ``name`` on the shelf as one book (True), take it off
    the shelf (False), or leave it to what it is (None)."""
    names = dict(_whole_overrides())
    if whole is None:
        names.pop(name, None)
    else:
        names[name] = bool(whole)
    os.makedirs(os.path.dirname(_whole_path()), exist_ok=True)
    _srv._atomic_write_json(_whole_path(), names, indent=1)
    with _lock:
        _whole["names"] = names
        _shelf["key"] = None
    return reader_of(next((z for z in _srv._zim_list_cache or [] if z.get("name") == name), {"name": name}))


def _reset_for_tests(timeout=30):
    _builder.wait(timeout)
    _builder.forget()
    _sources.wait(timeout)
    _sources.forget()
    with _lock:
        _base.clear()
        _shelf.update(key=None, books=[], by_id={})
        _whole.update(loaded=False, names={})
