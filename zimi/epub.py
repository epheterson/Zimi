"""EPUBs read in the browser: a book's spine chapters, served out of the zip
on the server as one page the reader opens like any book.

Browsers cannot show an EPUB, so it used to download. Now
``/w/<zim>/<book>.epub/`` is the book as one HTML page (its chapters in
reading order, each a ``<section>``, with Dublin Core in the head as a
Gutenberg page has), and ``/w/<zim>/<book>.epub/<member>`` a file inside it
(a picture, a font), so the chapters' own relative links resolve against
the book's address. Stdlib only: zipfile, and ElementTree for the package
file.

Nothing inside the zip is trusted. A member is found by its normalized
name, never by a path that climbs out (``../``) or starts at the root; the
number of members, each member's size and the chapters' total are bounded
before anything is read; scripts and event handlers are dropped from the
chapters. A parsed book is kept (the zip, its package and the page built
from it) for the next request, a few books and a few tens of megabytes at
most.
"""

import html as _html
import io
import logging
import os
import posixpath
import re
import threading
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from collections import OrderedDict

log = logging.getLogger("zimi")

EPUB_MIMETYPE = "application/epub+zip"
# Where a book's own address ends and a member's begins.
BOOK_SUFFIX = ".epub/"
CONTAINER = "META-INF/container.xml"
MAX_MEMBERS = 5000
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_PACKAGE_BYTES = 2 * 1024 * 1024
MAX_BOOK_BYTES = 64 * 1024 * 1024  # the chapters together, as text
MAX_SPINE = 3000
# Parsed books kept for the next request: this many, or this many bytes.
CACHE_BOOKS = 6
CACHE_BYTES = 96 * 1024 * 1024

_XHTML_TYPES = ("application/xhtml+xml", "text/html", "application/xml")
# Elements HTML has no empty form of: <a id="x"/> in XHTML is an anchor that
# ends at once, in HTML an anchor that swallows the rest of the chapter.
_NOT_VOID = "a|abbr|b|big|blockquote|cite|code|dd|div|dl|dt|em|h[1-6]|i|li|ol|p|pre|q|s|small|span|strong|sub|sup|table|tbody|td|th|thead|tr|tt|u|ul|section|article|aside|header|footer|figure|figcaption|title|iframe|script|style|textarea|video|audio|canvas|object"
_SELF_CLOSED_RE = re.compile(r"<(" + _NOT_VOID + r")(\s[^<>]*?)?\s*/>", re.I)
_BODY_RE = re.compile(r"<body\b[^>]*>(.*)</body\s*>", re.I | re.S)
_DROP_RE = re.compile(
    r"<(script|style|iframe|object|embed)\b[^>]*>.*?</\1\s*>|<(script|iframe|object|embed)\b[^>]*/?>",
    re.I | re.S,
)
_EVENT_ATTR_RE = re.compile(r"""\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)""", re.I)
_URL_ATTR_RE = re.compile(
    r"""(\s(?:src|href|xlink:href|poster)\s*=\s*)(["'])(.*?)\2""", re.I | re.S
)
_TEXT_RE = re.compile(r"<[^>]+>")


class EpubError(Exception):
    """Not an EPUB this reader will open (damaged, too big, no chapters)."""


def member_name(base_dir, href):
    """The zip member ``href`` names, read from a file in ``base_dir``: the
    URL decoded, the fragment and query dropped, the path normalized. None
    for anything that leaves the book (a scheme, the root, ``..``)."""
    if not href:
        return None
    href = href.strip()
    if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I) or href.startswith(("/", "\\")):
        return None
    path = urllib.parse.unquote(href.split("#", 1)[0].split("?", 1)[0])
    if not path:
        return None
    joined = posixpath.normpath(posixpath.join(base_dir, path))
    if joined in (".", "..") or joined.startswith(("../", "/")) or "\\" in joined:
        return None
    return joined


def _text(el):
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip() if el is not None else ""


def _local(tag):
    return tag.rsplit("}", 1)[-1]


class Book:
    """One EPUB, from its bytes: what its package says (title, creators,
    language, date, the cover picture), its spine, and its members."""

    def __init__(self, data):
        try:
            self._zip = zipfile.ZipFile(io.BytesIO(data))
            infos = self._zip.infolist()
        except (zipfile.BadZipFile, OSError, ValueError) as e:
            raise EpubError(f"not a zip: {e}") from e
        if len(infos) > MAX_MEMBERS:
            raise EpubError(f"{len(infos)} members")
        self.size = len(data)
        self._sizes = {i.filename: i.file_size for i in infos if not i.is_dir()}
        self._lock = threading.Lock()
        self._page = None
        package = self._package_path()
        root = self._xml(package, MAX_PACKAGE_BYTES)
        if root is None:
            raise EpubError("no package file")
        self._base = posixpath.dirname(package)
        self._read_package(root)

    # ── the zip ────────────────────────────────────────────────────────────

    def has(self, member):
        return member in self._sizes

    def read(self, member, limit=MAX_MEMBER_BYTES):
        """A member's bytes, or None: not in the book, or bigger than
        ``limit`` (by the size the zip declares, checked before reading,
        and again as it is read)."""
        size = self._sizes.get(member)
        if size is None or size > limit:
            return None
        with self._lock:
            try:
                with self._zip.open(member) as f:
                    data = f.read(limit + 1)
            except (zipfile.BadZipFile, OSError, KeyError, ValueError) as e:
                log.debug("EPUB member %s unreadable: %s", member, e)
                return None
        return data if len(data) <= limit else None

    def _xml(self, member, limit):
        data = self.read(member, limit)
        # A package file declares no entities; one that does is refused
        # rather than expanded (billion laughs) or followed (XXE).
        if data is None or b"<!ENTITY" in data:
            return None
        try:
            return ET.fromstring(data)
        except ET.ParseError:
            return None

    def _package_path(self):
        root = self._xml(CONTAINER, MAX_PACKAGE_BYTES)
        if root is not None:
            for el in root.iter():
                if _local(el.tag) == "rootfile":
                    path = member_name("", el.get("full-path") or "")
                    if path and self.has(path):
                        return path
        # No container (a sloppy EPUB): the one package file there is.
        opfs = sorted(m for m in self._sizes if m.lower().endswith(".opf"))
        if opfs:
            return opfs[0]
        raise EpubError("no package file")

    # ── the package ────────────────────────────────────────────────────────

    def _read_package(self, root):
        meta = next((e for e in root if _local(e.tag) == "metadata"), None)
        manifest = next((e for e in root if _local(e.tag) == "manifest"), None)
        spine = next((e for e in root if _local(e.tag) == "spine"), None)
        if manifest is None or spine is None:
            raise EpubError("no manifest or spine")
        dc = {}
        roles = {}
        cover_id = ""
        for el in meta if meta is not None else ():
            name = _local(el.tag)
            if name == "meta":
                if el.get("name") == "cover":
                    cover_id = el.get("content") or ""
                elif el.get("property") == "role" and el.get("refines"):
                    roles[el.get("refines").lstrip("#")] = _text(el)
                continue
            dc.setdefault(name, []).append(el)
        creators = []
        for el in dc.get("creator", []):
            role = (
                roles.get(el.get("id") or "")
                or el.get("{http://www.idpf.org/2007/opf}role")
                or "aut"
            )
            if role == "aut" and _text(el):
                creators.append(_text(el))
        self.title = _text((dc.get("title") or [None])[0])
        self.creators = creators
        self.language = _text((dc.get("language") or [None])[0])
        self.date = _text((dc.get("date") or [None])[0])[:10]
        self.publisher = _text((dc.get("publisher") or [None])[0])
        self.description = _TEXT_RE.sub(
            "", _html.unescape(_text((dc.get("description") or [None])[0]))
        ).strip()
        self.subjects = [_text(e) for e in dc.get("subject", []) if _text(e)]
        items = {}
        cover = ""
        for el in manifest:
            if _local(el.tag) != "item":
                continue
            member = member_name(self._base, el.get("href") or "")
            if not member:
                continue
            media = (el.get("media-type") or "").lower()
            items[el.get("id") or ""] = (member, media)
            props = (el.get("properties") or "").split()
            if "cover-image" in props and media.startswith("image/"):
                cover = member
        if not cover and cover_id in items and items[cover_id][1].startswith("image/"):
            cover = items[cover_id][0]
        self.cover = cover if cover and self.has(cover) else ""
        self.types = {m: t for m, t in items.values()}
        self.spine = []
        for el in spine:
            if _local(el.tag) != "itemref" or el.get("linear") == "no":
                continue
            member, media = items.get(el.get("idref") or "", ("", ""))
            if member and media in _XHTML_TYPES and self.has(member):
                self.spine.append(member)
            if len(self.spine) >= MAX_SPINE:
                break
        if not self.spine:
            raise EpubError("no chapters")

    # ── the book as one page ───────────────────────────────────────────────

    def page(self):
        """The whole book as one HTML page (bytes), built once."""
        if self._page is None:
            self._page = self._build_page()
        return self._page

    def _build_page(self):
        index = {m: i for i, m in enumerate(self.spine)}
        parts, total = [], 0
        for i, member in enumerate(self.spine):
            data = self.read(member)
            if data is None:
                continue
            body = _chapter_body(data.decode("utf-8", "replace"))
            body = _rewrite_urls(body, posixpath.dirname(member), index)
            # A spine item with nothing to read or see (the cover's wrapper
            # page, its picture drawn in SVG; the cover is the shelf's).
            if not _TEXT_RE.sub("", body).strip() and "<img" not in body.lower():
                continue
            total += len(body)
            if total > MAX_BOOK_BYTES:
                log.warning(
                    "EPUB %r: cut at chapter %d of %d", self.title, i, len(self.spine)
                )
                break
            parts.append(f'<section class="chapter" id="zb-c{i}">{body}</section>')
        if not parts:
            raise EpubError("no text")
        title = _html.escape(self.title or "", quote=True)
        creator = _html.escape(" & ".join(self.creators), quote=True)
        lang = _html.escape(self.language or "", quote=True)
        head = (
            f'<!DOCTYPE html><html lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>{title}</title>"
            f'<meta name="dc.title" content="{title}">'
            f'<meta name="dc.creator" content="{creator}">'
            f'<meta name="dc.language" content="{lang}">'
            '<meta name="zimi-book" content="epub"></head><body>'
        )
        return (head + "".join(parts) + "</body></html>").encode("utf-8")

    def facts(self):
        """What a listing wants of the book: title, creators, date, language
        and the cover's member name."""
        return {
            "title": self.title,
            "creators": list(self.creators),
            "date": self.date,
            "language": self.language,
            "publisher": self.publisher,
            "description": self.description,
            "subjects": list(self.subjects),
            "cover": self.cover,
        }


def _chapter_body(text):
    m = _BODY_RE.search(text)
    body = m.group(1) if m else text
    body = _DROP_RE.sub("", body)
    body = _EVENT_ATTR_RE.sub("", body)
    return _SELF_CLOSED_RE.sub(
        lambda m: f"<{m.group(1)}{m.group(2) or ''}></{m.group(1)}>", body
    )


def _rewrite_urls(body, base_dir, index):
    """A chapter's links, for the one page the chapters become: a link to
    another chapter lands on it in the page, a picture or a stylesheet on the
    member it names (relative to the book's address), anything that leaves
    the book is kept, and ``javascript:`` is dropped."""

    def one(m):
        lead, quote, value = m.group(1), m.group(2), _html.unescape(m.group(3))
        v = value.strip()
        if v.lower().startswith("javascript:"):
            return f"{lead}{quote}#{quote}"
        if not v or v.startswith("#"):
            return m.group(0)
        member = member_name(base_dir, v)
        if member is None:
            return m.group(0)
        frag = v.split("#", 1)[1] if "#" in v else ""
        if member in index:
            target = "#" + (frag or f"zb-c{index[member]}")
        else:
            target = urllib.parse.quote(member, safe="/")
        return f"{lead}{quote}{_html.escape(target, quote=True)}{quote}"

    return _URL_ATTR_RE.sub(one, body)


def facts_of_file(path):
    """``Book.facts()`` for an EPUB on disk, or None when it is not one
    this reader opens. For a folder being packed: nothing is kept."""
    try:
        size = os.path.getsize(path)
        if size > MAX_BOOK_BYTES * 2:
            return None
        with open(path, "rb") as f:
            return Book(f.read()).facts()
    except (OSError, EpubError) as e:
        log.debug("EPUB %s unreadable: %s", path, e)
        return None


# ── books in a ZIM ─────────────────────────────────────────────────────────

_cache = OrderedDict()  # (zim, path, file identity) -> Book
_cache_lock = threading.Lock()


def split(entry_path):
    """``(book, member)`` for a path inside an EPUB (``b.epub/`` is the
    book itself, member ""), None for any other path."""
    i = entry_path.lower().find(BOOK_SUFFIX)
    if i < 0:
        return None
    cut = i + len(BOOK_SUFFIX)
    return entry_path[: cut - 1], entry_path[cut:]


def book_path(epub_path):
    """The address of an EPUB entry's book: its path and a slash."""
    return epub_path + "/"


def _identity(zim):
    from zimi import server as _srv

    path = _srv.get_zim_files().get(zim) or ""
    try:
        st = os.stat(path)
        return (path, st.st_mtime, st.st_size)
    except OSError:
        return (path, 0, 0)


def _load(zim, epub_path):
    """The EPUB entry's bytes, read under the library lock; None when the
    ZIM has no such EPUB (or one too big to serve)."""
    from zimi import server as _srv

    with _srv._zim_lock:
        archive = _srv.get_archive(zim)
        if archive is None:
            return None
        try:
            entry = archive.get_entry_by_path(epub_path)
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            item = entry.get_item()
        except Exception:
            return None
        mime = (item.mimetype or "").lower()
        if mime not in (
            EPUB_MIMETYPE,
            "application/epub",
        ) and not epub_path.lower().endswith(".epub"):
            return None
        if item.size > _srv.MAX_SERVE_BYTES:
            return None
        return bytes(item.content)


def book_in_zim(zim, epub_path):
    """The parsed EPUB at ``epub_path`` in ``zim``, kept for the next
    request; None when there is none, or it will not open."""
    key = (zim, epub_path, _identity(zim))
    with _cache_lock:
        got = _cache.get(key)
        if got is not None:
            _cache.move_to_end(key)
            return got
    data = _load(zim, epub_path)
    if data is None:
        return None
    try:
        book = Book(data)
    except EpubError as e:
        log.info("EPUB %s in %s will not open: %s", epub_path, zim, e)
        return None
    with _cache_lock:
        _cache[key] = book
        while len(_cache) > CACHE_BOOKS or (
            len(_cache) > 1 and sum(b.size for b in _cache.values()) > CACHE_BYTES
        ):
            _cache.popitem(last=False)
    return book


def respond(zim, entry_path):
    """What ``/w/<zim>/<entry_path>`` answers for a path inside an EPUB:
    ``(content_type, bytes)``; ``(None, None)`` for a member the book does
    not have; None when the path is not inside an EPUB of this ZIM, so the
    ordinary entry lookup answers."""
    parts = split(entry_path)
    if parts is None:
        return None
    epub_path, member = parts
    book = book_in_zim(zim, epub_path)
    if book is None:
        return None
    if not member:
        try:
            return "text/html; charset=utf-8", book.page()
        except EpubError as e:
            log.info("EPUB %s in %s has no text: %s", epub_path, zim, e)
            return None, None
    name = member_name("", member)
    data = book.read(name) if name else None
    if data is None:
        return None, None
    from zimi import server as _srv

    mime = book.types.get(name) or _srv.MIME_FALLBACK.get(
        posixpath.splitext(name)[1].lower(), "application/octet-stream"
    )
    if mime in _XHTML_TYPES:
        # A chapter opened on its own (a link from outside the spine): as
        # HTML, its scripts dropped as the book page's are.
        return "text/html; charset=utf-8", _chapter_body(
            data.decode("utf-8", "replace")
        ).encode("utf-8")
    return mime, data


def _reset_for_tests():
    with _cache_lock:
        _cache.clear()
