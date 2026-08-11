"""Export to ZIM — write bookmarked articles into standalone .zim files.

Each bookmark becomes one HTML article. v2 carries the source article's real
IMAGES and STYLING into the export so the result RESEMBLES the original — not
the bare text dump v1 produced. Images (and one level of the CSS ``url()``
assets they pull) are copied into the ZIM and the references rewritten; the
article's stylesheets are inlined into its head. An auto-generated index page
(the ZIM main entry) links every entry, grouped into sections when the caller
supplies them (a folder's subfolders become sections within its ZIM).

Multiple "jobs" (one per selected top-level folder) each produce their OWN
``.zim`` — see ``build_export_jobs`` / ``start_export``.

Threading model: the libzim *writer* (``libzim.writer.Creator``) writes a NEW
file and is independent of the read-side ``Archive`` pool — safe on a worker
thread. Source READS (article HTML and asset bytes) still touch libzim
``Archive`` objects, which are NOT thread-safe, so every read goes through the
``_srv._zim_lock``-guarded path.
"""

import colorsys
import contextlib
import datetime
import hashlib
import html as _html
import io
import json
import logging
import os
import pathlib
import posixpath
import re
import struct
import threading
import time
import urllib.parse
import zlib

import zimi.server as _srv

log = logging.getLogger("zimi.zimwriter")

# Strip these whole elements (with content) from embedded article bodies — they
# either don't work standalone or are a security/nuisance risk in the export.
# Stylesheets are handled separately (inlined) BEFORE this runs.
_STRIP_TAGS_RE = re.compile(
    r"<(script|style|link|meta|noscript)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_STRIP_VOID_RE = re.compile(r"<(link|meta)\b[^>]*/?>", re.IGNORECASE)
_BODY_RE = re.compile(r"<body[^>]*>(.*)</body>", re.IGNORECASE | re.DOTALL)

# Asset carrying. `src` on media tags + `href` on stylesheet links; `url()` in
# CSS. Kept deliberately simple/bounded — a bookmark ZIM is not a full mirror.
_STYLESHEET_RE = re.compile(r"<link\b[^>]*>", re.IGNORECASE)
_HREF_RE = re.compile(r"""href\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_REL_RE = re.compile(r"""rel\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_MEDIA_TAG_RE = re.compile(r"<(img|source)\b[^>]*>", re.IGNORECASE)
_SRC_RE = re.compile(r"""(\bsrc\s*=\s*)(["'])(.*?)\2""", re.IGNORECASE | re.DOTALL)
_SRCSET_RE = re.compile(
    r"""(\bsrcset\s*=\s*)(["'])(.*?)\2""", re.IGNORECASE | re.DOTALL
)
_CSS_URL_RE = re.compile(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""", re.IGNORECASE)

# Bounds so a runaway article/ZIM can't be produced (a bookmark ZIM is small).
_MAX_ASSET_BYTES = 5 * 1024 * 1024  # per single asset
_MAX_TOTAL_ASSET_BYTES = 80 * 1024 * 1024  # per whole ZIM
_MAX_ASSETS = 1200  # per whole ZIM

# Export state for the poll endpoint. `file`/`files` surface the written ZIMs.
_export_lock = threading.Lock()
_export_state = {
    "phase": None,  # None | "running" | "done" | "error"
    "done": 0,
    "total": 0,
    "file": None,  # last output filename (back-compat with the v1 client)
    "files": [],  # every output filename (v2, one per folder)
    "count": 0,  # articles written
    "error": None,
}


def _set_export_state(**kw):
    _export_state.update(kw)


def get_export_state():
    """Copied snapshot for the status poll endpoint (never the live dict)."""
    snap = dict(_export_state)
    snap["files"] = list(snap.get("files") or [])
    return snap


def _slug(text, fallback):
    """A short, filesystem/URL-safe slug for an in-ZIM article path."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "")).strip("_")
    return (s or fallback)[:60]


def _read_source_article(zim, path):
    """Fetch a source article's HTML under the libzim read lock. Returns the
    decoded HTML string, or None if the ZIM/entry is missing or unreadable."""
    try:
        with _srv._zim_lock:
            archive = _srv.get_archive(zim)
            if archive is None:
                return None
            try:
                entry = archive.get_entry_by_path(path)
            except KeyError:
                return None
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            item = entry.get_item()
            return bytes(item.content).decode("utf-8", errors="replace")
    except Exception as e:  # missing entry, decode failure, corrupt ZIM
        log.debug("bookmark export: read failed for %s/%s: %s", zim, path, e)
        return None


def _read_source_item(zim, path):
    """Fetch a source entry's RAW bytes + mimetype (images, fonts, CSS) under
    the read lock. Returns (bytes, mimetype) or None."""
    try:
        with _srv._zim_lock:
            archive = _srv.get_archive(zim)
            if archive is None:
                return None
            try:
                entry = archive.get_entry_by_path(path)
            except KeyError:
                return None
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            item = entry.get_item()
            try:
                mime = item.mimetype
            except Exception:
                mime = "application/octet-stream"
            return bytes(item.content), mime
    except Exception as e:
        log.debug("bookmark export: asset read failed for %s/%s: %s", zim, path, e)
        return None


def _resolve_ref(base_path, ref):
    """Resolve an in-article reference (img src, css url) to a ZIM entry path,
    or None for external / data / anchor-only refs we don't carry."""
    if not ref:
        return None
    ref = ref.split("#", 1)[0].split("?", 1)[0].strip()
    if not ref or ref.startswith("data:") or ref.startswith("//") or "://" in ref:
        return None
    if ref.startswith("/"):
        return ref.lstrip("/")
    base_dir = posixpath.dirname(base_path)
    return posixpath.normpath(posixpath.join(base_dir, ref)).lstrip("/")


class _AssetCarrier:
    """Copies referenced assets from source ZIMs into the export, deduped and
    bounded. `add_item` is the Creator's, injected so the class stays testable.
    Rewrites references to the carried in-ZIM path (relative to an ``A/<slug>``
    article, i.e. ``../<path>``)."""

    def __init__(self, add_item, item_factory, asset_reader):
        self._add = add_item
        self._make = item_factory  # (path, mimetype, bytes) -> libzim Item
        self._read = asset_reader
        self._carried = {}  # resolved source path -> in-ZIM path (or None if skipped)
        self.total_bytes = 0
        self.count = 0
        # What actually went in, so the Tags metadata can claim `_pictures:` /
        # `_videos:` from evidence instead of from a guess.
        self.mimetypes = set()

    def _carry(self, zim, resolved, depth=0):
        """Ensure `resolved` (a path in `zim`) is in the export; return its
        in-ZIM path or None. Recurses one level into CSS ``url()`` refs."""
        key = zim + "\n" + resolved
        if key in self._carried:
            return self._carried[key]
        if self.count >= _MAX_ASSETS or self.total_bytes >= _MAX_TOTAL_ASSET_BYTES:
            self._carried[key] = None
            return None
        got = self._read(zim, resolved)
        if not got:
            self._carried[key] = None
            return None
        data, mime = got
        if not data or len(data) > _MAX_ASSET_BYTES:
            self._carried[key] = None
            return None
        # Namespace per source ZIM so two ZIMs' "I/x.png" can't collide.
        in_path = "_assets/" + _slug(zim, "z") + "/" + resolved
        # CSS may itself pull fonts/images — carry those one level deep first.
        if depth == 0 and (
            "css" in (mime or "").lower() or resolved.lower().endswith(".css")
        ):
            data = self._rewrite_css(zim, resolved, data)
        self._carried[key] = in_path
        self.total_bytes += len(data)
        self.count += 1
        try:
            self._add(self._make(in_path, mime or "application/octet-stream", data))
        except Exception as e:
            log.debug("asset add failed %s: %s", in_path, e)
            self._carried[key] = None
            return None
        self.mimetypes.add(mime or "application/octet-stream")
        return in_path

    def _rewrite_css(self, zim, css_path, data):
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception:
            return data

        def repl(m):
            quote, ref = m.group(1), m.group(2)
            resolved = _resolve_ref(css_path, ref)
            if not resolved:
                return m.group(0)
            in_path = self._carry(zim, resolved, depth=1)
            if not in_path:
                return m.group(0)
            # CSS lives at _assets/<zim>/<css_path>; asset at _assets/<zim>/<res>.
            rel = posixpath.relpath(
                in_path,
                posixpath.dirname("_assets/" + _slug(zim, "z") + "/" + css_path),
            )
            return "url(" + quote + rel + quote + ")"

        return _CSS_URL_RE.sub(repl, text).encode("utf-8")

    def rewrite_media(self, zim, article_path, html):
        """Carry <img>/<source> src (+ srcset) and return rewritten HTML."""

        def in_zim_ref(resolved_in_path):
            # From an A/<slug> article, an in-ZIM path P is reached via ../P.
            return "../" + resolved_in_path

        def fix_tag(tagm):
            tag = tagm.group(0)

            def fix_src(m):
                resolved = _resolve_ref(article_path, m.group(3))
                if not resolved:
                    return m.group(0)
                in_path = self._carry(zim, resolved)
                if not in_path:
                    return m.group(0)
                return m.group(1) + m.group(2) + in_zim_ref(in_path) + m.group(2)

            def fix_srcset(m):
                parts = []
                for cand in m.group(3).split(","):
                    cand = cand.strip()
                    if not cand:
                        continue
                    bits = cand.split()
                    resolved = _resolve_ref(article_path, bits[0])
                    if resolved:
                        in_path = self._carry(zim, resolved)
                        if in_path:
                            bits[0] = in_zim_ref(in_path)
                    parts.append(" ".join(bits))
                return m.group(1) + m.group(2) + ", ".join(parts) + m.group(2)

            tag = _SRC_RE.sub(fix_src, tag)
            tag = _SRCSET_RE.sub(fix_srcset, tag)
            return tag

        return _MEDIA_TAG_RE.sub(fix_tag, html)

    def collect_styles(self, zim, article_path, html):
        """Read the article's stylesheets and return their CSS text to inline
        into the export article head (url() refs already rewritten)."""
        css_chunks = []
        for linkm in _STYLESHEET_RE.finditer(html):
            tag = linkm.group(0)
            relm = _REL_RE.search(tag)
            if not relm or "stylesheet" not in relm.group(2).lower():
                continue
            hrefm = _HREF_RE.search(tag)
            if not hrefm:
                continue
            resolved = _resolve_ref(article_path, hrefm.group(2))
            if not resolved:
                continue
            got = self._read(zim, resolved)
            if not got:
                continue
            data, _mime = got
            if not data or len(data) > _MAX_ASSET_BYTES:
                continue
            css_chunks.append(
                self._rewrite_css(zim, resolved, data).decode("utf-8", errors="replace")
            )
        return "\n".join(css_chunks)


def _extract_body(raw_html):
    """Return the inner <body> HTML of a source article, scripts/styles/links
    stripped. Falls back to the whole (stripped) document when there is no
    recognizable body wrapper (fragments, zimgit docs, etc.)."""
    stripped = _STRIP_TAGS_RE.sub("", raw_html)
    stripped = _STRIP_VOID_RE.sub("", stripped)
    m = _BODY_RE.search(stripped)
    return m.group(1) if m else stripped


_PAGE_CSS = (
    "body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',"
    "Roboto,Helvetica,Arial,sans-serif;max-width:44rem;margin:0 auto;"
    "padding:1.5rem;color:#111}"
    "header.zimi-src{font-size:.85rem;color:#666;border-bottom:1px solid #ddd;"
    "padding-bottom:.5rem;margin-bottom:1rem}"
    "header.zimi-src a{color:#06c}"
    "footer.zimi-nav{margin-top:2rem;padding-top:.75rem;border-top:1px solid #ddd;"
    "font-size:.85rem}"
    "ol.zimi-index{padding-left:1.25rem}ol.zimi-index li{margin:.35rem 0}"
    "h2.zimi-section{margin:1.5rem 0 .5rem;font-size:1.1rem;color:#333}"
    "img{max-width:100%;height:auto}"
)


def _page_head(title, extra_css=""):
    """Opening markup through </head>. `title` must already be escaped. The
    carried article CSS is inlined after the base page CSS so it wins."""
    css = _PAGE_CSS + (("\n" + extra_css) if extra_css else "")
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title><style>{css}</style></head>"
    )


def _article_html(title, source_zim, source_path, body, extra_css=""):
    """Wrap a source body as a standalone export article."""
    src = _html.escape(source_zim)
    spath = _html.escape(source_path)
    return (
        _page_head(_html.escape(title), extra_css)
        + "<body><header class='zimi-src'>From <strong>"
        + src
        + "</strong>"
        f" · <code>{spath}</code> · "
        "<a href='index'>&#8592; Bookmarks index</a></header>"
        f"<main>{body}</main>"
        "<footer class='zimi-nav'><a href='index'>&#8592; Back to index</a>"
        "</footer></body></html>"
    ).encode("utf-8")


def _plural(n, singular, plural=None):
    """Grammatically correct English count phrase: "1 article", "3 articles"."""
    return f"{n} {singular if n == 1 else (plural or singular + 's')}"


def _index_html(entries, date_str, heading, sections=None):
    """Build the main-entry index. `entries` is a list of
    (path, title, source_zim, section). Grouped under section headers when any
    entry carries a non-empty section. ``sections`` (optional, ordered) names
    section headers that must render even when they hold no entries — an
    exported empty folder shows up honestly instead of vanishing."""
    sections = [s.strip() for s in (sections or []) if (s or "").strip()]
    has_sections = bool(sections) or any((e[3] or "").strip() for e in entries)
    body = ""
    if not has_sections:
        items = "".join(
            f"<li><a href='{_html.escape(p)}'>{_html.escape(tt)}</a>"
            f" <span style='color:#999'>· {_html.escape(z)}</span></li>"
            for (p, tt, z, _s) in entries
        )
        body = (
            f"<ol class='zimi-index'>{items or '<li><em>No bookmarks.</em></li>'}</ol>"
        )
    else:
        # Stable section order: the caller-provided list first, then first
        # appearance among the entries; unfiled ("") last.
        order = list(sections)
        for _p, _t, _z, s in entries:
            s = (s or "").strip()
            if s not in order:
                order.append(s)
        order = [s for s in order if s != ""] + ([""] if "" in order else [])
        for sec in order:
            group = [e for e in entries if (e[3] or "").strip() == sec]
            if not group and sec not in sections:
                continue
            label = sec if sec else "General"
            items = "".join(
                f"<li><a href='{_html.escape(p)}'>{_html.escape(tt)}</a>"
                f" <span style='color:#999'>· {_html.escape(z)}</span></li>"
                for (p, tt, z, _s) in group
            )
            if not items:
                # An explicitly exported folder that held nothing — say so
                # rather than dropping the header the user asked for.
                items = "<li><em>No bookmarks in this folder.</em></li>"
            body += f"<h2 class='zimi-section'>{_html.escape(label)}</h2><ol class='zimi-index'>{items}</ol>"
    return (
        _page_head(_html.escape(heading)) + "<body>"
        f"<h1>{_html.escape(heading)}</h1><p style='color:#666'>Exported {date_str} · "
        f"{_plural(len(entries), 'article')}</p>{body}</body></html>"
    ).encode("utf-8")


def _output_path(zim_dir, base):
    """A non-clobbering output path: <base>.zim, then <base>-2.zim, …"""
    candidate = os.path.join(zim_dir, base + ".zim")
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(zim_dir, f"{base}-{n}.zim")
        n += 1
    return candidate


# Writer plumbing shared with zimi.creator (folder/page → ZIM). libzim.writer
# is imported lazily so this module still imports where the writer is absent
# (the read-only install case) — the class pair is built once and cached.
_static_item_cls = None


def zim_static_item_class():
    """The one Item class every Zimi-written ZIM entry uses: full content in
    memory, mimetype and FRONT_ARTICLE hint per entry."""
    global _static_item_cls
    if _static_item_cls is not None:
        return _static_item_cls
    from libzim.writer import Blob, ContentProvider, Hint, Item

    class _Provider(ContentProvider):
        def __init__(self, content):
            super().__init__()
            self._content = content
            self._fed = False

        def get_size(self):
            return len(self._content)

        def feed(self):
            if self._fed:
                return Blob(b"")
            self._fed = True
            return Blob(self._content)

    class _StaticItem(Item):
        def __init__(self, path, title, content, mimetype=_HTML_MIME, front=True):
            super().__init__()
            self._path = path
            self._title = title
            self._content = content
            self._mimetype = mimetype
            self._front = front

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return self._mimetype

        def get_contentprovider(self):
            return _Provider(self._content)

        def get_hints(self):
            # libzim types hint values as int, not bool — a True here is a
            # type error against the base Item even though it runs fine.
            return {Hint.FRONT_ARTICLE: 1} if self._front else {}

    _static_item_cls = _StaticItem
    return _StaticItem


def make_asset_item(path, mimetype, data):
    """A non-front entry (image, CSS, font) — the shape _AssetCarrier feeds."""
    cls = zim_static_item_class()
    return cls(path, path.rsplit("/", 1)[-1], data, mimetype=mimetype, front=False)


@contextlib.contextmanager
def atomic_zim_creator(out_path, language="eng"):
    """Yield a libzim Creator writing to ``<out_path>.tmp``; rename over
    ``out_path`` only on clean exit, remove the tmp on any error. A partially
    written ZIM must never appear under its final name — libzim#1106 upstream
    is exactly the bug where half-written files got picked up as valid."""
    from libzim.writer import Creator

    tmp_path = out_path + ".tmp"
    try:
        # Creator takes a Path; tmp_path stays a str for os.replace below.
        with Creator(pathlib.Path(tmp_path)).config_indexing(True, language) as creator:
            yield creator
        os.replace(tmp_path, out_path)
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise


# ── provenance ──────────────────────────────────────────────────────────────
#
# Every ZIM Zimi writes carries its own paper trail IN METADATA, so the record
# travels with the file to any reader, any peer, any sneakernet copy:
#
#   Scraper         the formal openZIM field readers display: "Zimi <version>",
#                   plus the engine that did the work when one ran
#                   ("Zimi 1.9.0-dev + yt-dlp 2026.07.04").
#   Source          the standard field, kept to its openZIM meaning — a URL.
#                   Written only when the source actually IS one.
#   X-Zimi-Source   the uniform field: URL, folder name, archive name, playlist
#                   — whatever the content came from, written whenever known.
#   X-Zimi-History  a JSON array of records. Creation writes the first one;
#                   every later edit appends, so a ZIM's whole life is legible
#                   from the file alone.
#
# PRIVACY (hard rule): none of this may carry a full local path, a hostname, a
# username, or an environment value. ZIMs get shared; the paper trail must
# never leak the machine that made them. `source_label` reduces anything that
# is not a URL to its basename, and every source value goes through it.

SCRAPER_METADATA_KEY = "Scraper"
SOURCE_METADATA_KEY = "X-Zimi-Source"
HISTORY_METADATA_KEY = "X-Zimi-History"

# ── openZIM conformance ─────────────────────────────────────────────────────
#
# The spec's own enforcement tables are the authority, not prose: zim-tools'
# reservedMetadataInfoTable (src/metadata_constraints.cpp, what `zimcheck -M`
# actually applies) and python-scraperlib's zimscraperlib/zim/metadata.py.
# What they require of every ZIM:
#
#   Name                  MANDATORY. The identifier that stays STABLE across
#                         editions of the same source — how a library knows
#                         today's capture is a newer copy of last month's
#                         rather than a second unrelated file. So it is
#                         derived from the SOURCE, never from the date or a
#                         title the user may retype.
#   Title                 MANDATORY, 1–30 characters.
#   Language              MANDATORY, ISO 639-3, ^\w{3}(,\w{3})*$.
#   Creator, Publisher    MANDATORY, non-empty.
#   Date                  MANDATORY, exactly YYYY-MM-DD.
#   Description           MANDATORY, 1–80 characters.
#   Illustration_48x48@1  MANDATORY, a real 48x48 PNG.
#   LongDescription       optional, ≤4000, and never SHORTER than Description.
#   Tags/Flavour/Source/License/Relation/Scraper: optional.
#   Counter               written by libzim itself — a scraper must not.
#
# Titles and descriptions are shortened HERE and only here: the ZIM's own
# index page keeps the full heading, so the cap costs a metadata field its
# tail rather than costing the content its name.

# Bare, with no charset suffix: libzim folds entry mimetypes verbatim into the
# Counter metadata, whose spec regex admits neither ";" nor "=", so a
# "text/html;charset=utf-8" entry makes the whole ZIM fail `zimcheck -M`. Every
# page Zimi generates declares its own <meta charset>, which is where the rest
# of the ZIM world puts it too.
_HTML_MIME = "text/html"

MAX_TITLE_LENGTH = 30
MAX_DESCRIPTION_LENGTH = 80
MAX_LONG_DESCRIPTION_LENGTH = 4000
ILLUSTRATION_SIZE = 48

# Tags use the spec's semicolon convention. Only the two that a reader really
# consumes are written by default: `_category:` groups a ZIM in a library, and
# `_ftindex:yes` is true of every ZIM Zimi writes because `atomic_zim_creator`
# always turns on full-text indexing. The `_pictures:`/`_videos:`/`_details:`
# trio describes flavour VARIANTS of one source (Kiwix's maxi/nopic/mini), so
# it is written only where an engine actually knows the answer.
DEFAULT_TAGS = ("_category:other", "_ftindex:yes")

_LANGUAGE_RE = re.compile(r"^[a-z]{3}(,[a-z]{3})*$")

# Bounded so a heavily edited ZIM cannot grow an unbounded metadata entry. The
# overflow is collapsed into one honest marker record, never dropped silently.
MAX_HISTORY_RECORDS = 100
TRUNCATED_OP = "truncated"


def _is_url(value):
    return str(value or "").lower().startswith(("http://", "https://"))


def source_label(value):
    """A SHAREABLE source label: URLs verbatim, anything else reduced to its
    last path segment. This is the privacy chokepoint — a caller that hands
    over a full local path still only ever gets its basename into the file."""
    text = str(value or "").strip()
    if not text or _is_url(text):
        return text
    return text.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def fit_text(text, limit):
    """``text`` collapsed to one line and shortened to ``limit`` characters,
    cut on a word boundary with an ellipsis whenever anything was dropped. The
    spec's length caps are hard, so something has to give; a visible ellipsis
    is the honest way to say "there was more"."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rstrip()
    space = cut.rfind(" ")
    if space >= limit // 2:
        cut = cut[:space].rstrip()
    return cut + "…"


def normalize_language(value):
    """A spec-legal ``Language``: lowercase ISO 639-3, comma-joined, no spaces.
    Two-letter codes are widely typed and just as widely wrong here, so the
    well-known ones are translated (reusing the table the reader already
    keeps) rather than written out of spec. Raises ValueError on anything that
    cannot be resolved — a bad language code is a fixable mistake, and a ZIM
    that lies about its language is not."""
    two_to_three = {v: k for k, v in _srv._ISO639_3_TO_1.items()}
    codes = []
    for part in str(value or "").lower().replace(";", ",").split(","):
        code = re.sub(r"[^a-z]", "", part)
        if not code:
            continue
        code = two_to_three.get(code, code) if len(code) == 2 else code
        if len(code) != 3:
            raise ValueError(
                f"not an ISO 639-3 language code: {part.strip()!r} "
                "(the ZIM spec wants three letters, e.g. eng, fra, spa)"
            )
        if code not in codes:
            codes.append(code)
    joined = ",".join(codes) or "eng"
    if not _LANGUAGE_RE.match(joined):
        raise ValueError(f"not an ISO 639-3 language code: {value!r}")
    return joined


def zim_name(scope, language="eng"):
    """The ``Name`` metadata: ``zimi_<language>_<scope>``, following the
    ``creator_lang_scope`` convention Kiwix libraries key on. ``scope`` must
    identify the SOURCE — a URL, a hostname, a folder name — so that
    recapturing it next month produces the same Name and a library treats the
    result as a new edition rather than an unrelated file.

    A URL keeps host, path AND query, because ``/blog/post.html`` on two
    different sites (or two playlists on one host) must never collapse into
    one identity. Anything else goes through ``source_label``, so a caller
    that hands over a local path still cannot put one in the file."""
    text = str(scope or "").strip()
    if _is_url(text):
        parts = urllib.parse.urlsplit(text)
        text = " ".join(p for p in (parts.netloc, parts.path, parts.query) if p)
    else:
        text = source_label(text)
    lang = normalize_language(language).split(",")[0]
    return f"zimi_{lang}_{_slug(text, 'zim')}"


def tags_string(extra=()):
    """The ``Tags`` value: the defaults every Zimi ZIM can honestly claim,
    plus whatever the engine knows, deduped and semicolon-joined."""
    tags = []
    for tag in list(DEFAULT_TAGS) + list(extra or ()):
        tag = str(tag).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return ";".join(tags)


def media_tags(mimetypes):
    """``_pictures:``/``_videos:`` for a set of mimetypes actually written into
    the ZIM. Only claims what was seen — an engine that does not track its
    mimetypes passes nothing and the tags are simply absent."""
    kinds = {str(m).split("/", 1)[0].lower() for m in mimetypes if m}
    return [
        f"_pictures:{'yes' if 'image' in kinds else 'no'}",
        f"_videos:{'yes' if 'video' in kinds else 'no'}",
    ]


def _png(rows, width, height):
    """A minimal 8-bit RGB PNG. Written by hand because the illustration is
    MANDATORY metadata and Zimi must produce one on a machine with no image
    library at all — zlib and struct are always there."""
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def default_illustration(seed, size=ILLUSTRATION_SIZE):
    """A 48x48 identicon PNG derived from ``seed`` (the ZIM's Name): a
    mirrored 5x5 block pattern in a colour picked from the seed's hash. The
    same source always yields the same icon, and two different ZIMs almost
    never collide — which is the whole job of a shelf icon."""
    digest = hashlib.sha256(str(seed).encode("utf-8")).digest()
    hue = digest[0] / 255.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.62, 0.96)
    fg = (int(r * 255), int(g * 255), int(b * 255))
    bg = (20, 20, 22)  # the app's own surface tone, so tiles sit on the shelf
    cells, margin = 5, 4
    step = (size - 2 * margin) // cells
    on = set()
    for col in range(3):  # left half plus the middle column, then mirrored
        for row in range(cells):
            if digest[1 + col * cells + row] & 1:
                on.add((col, row))
                on.add((cells - 1 - col, row))
    rows = []
    for y in range(size):
        row = bytearray()
        cell_y = (y - margin) // step if margin <= y < margin + cells * step else -1
        for x in range(size):
            cell_x = (x - margin) // step if margin <= x < margin + cells * step else -1
            paint = fg if (cell_x, cell_y) in on else bg
            row += bytes(paint)
        rows.append(row)
    return _png(rows, size, size)


def has_image_support():
    """Whether Pillow is importable. It is a soft dependency — the only way to
    rescale an arbitrary favicon into the 48x48 the spec demands — so callers
    check before spending network on an icon they could not use anyway."""
    try:
        import PIL.Image  # noqa: F401
    except ImportError:
        return False
    return True


def illustration_from_image(data, size=ILLUSTRATION_SIZE):
    """``data`` (a favicon, any format) re-encoded as a ``size``x``size`` PNG,
    or None. Needs Pillow, which Zimi does not depend on — without it there is
    no honest way to rescale an arbitrary image, so the caller falls back to a
    generated icon rather than shipping a wrong-sized one."""
    if not data:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None
    # Pillow moved the filter constants under Image.Resampling in 9.1 and kept
    # the old aliases; Zimi does not pin Pillow, so ask for whichever is there.
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    try:
        with Image.open(io.BytesIO(data)) as img:
            square = img.convert("RGBA").resize((size, size), resample)
            flat = Image.new("RGBA", (size, size), (20, 20, 22, 255))
            flat.alpha_composite(square)
            buf = io.BytesIO()
            flat.convert("RGB").save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:  # a favicon is decoration; never fail a build for it
        log.debug("favicon could not be used as an illustration: %s", e)
        return None


def scraper_string(tool=None, version=None):
    """The formal Scraper value: Zimi, plus the engine that did the work when
    one did ("Zimi 1.9.0-dev + yt-dlp 2026.07.04")."""
    base = f"Zimi {_srv.ZIMI_VERSION}"
    if not tool:
        return base
    return f"{base} + {tool} {version}" if version else f"{base} + {tool}"


def history_record(op, mode, detail, *, tools=None, counts=None, ts=None):
    """One provenance record. ``op`` is what happened ("created"), ``mode`` how
    ("folder", "page", "site", "video", "import", "bookmarks"), ``detail`` one
    human sentence. ``tools`` names the outside engine and version when one ran;
    ``counts`` carries whichever of pages/assets/videos/bytes are known. Keys
    with nothing to say are left out rather than written empty."""
    record = {
        "ts": int(ts if ts is not None else time.time()),
        "zimi": _srv.ZIMI_VERSION,
        "op": op,
        "mode": mode,
        "detail": str(detail),
    }
    named_tools = {k: str(v) for k, v in (tools or {}).items() if v}
    if named_tools:
        record["tools"] = named_tools
    known_counts = {k: int(v) for k, v in (counts or {}).items() if v is not None}
    if known_counts:
        record["counts"] = known_counts
    return record


def parse_history(raw):
    """The records in an ``X-Zimi-History`` value — ``[]`` for anything that
    isn't a JSON array of objects. A ZIM made elsewhere, or one with a mangled
    entry, reads as "no history", never as an error."""
    if isinstance(raw, (bytes, bytearray, memoryview)):
        raw = bytes(raw).decode("utf-8", "replace")
    try:
        records = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(records, list):
        return []
    return [r for r in records if isinstance(r, dict)]


def append_history(records, record, limit=MAX_HISTORY_RECORDS):
    """``records`` plus ``record``, bounded. Overflow collapses into a single
    leading marker naming how many records it stands for — the history shrinks
    visibly instead of losing its beginning in silence."""
    out = list(records) + [record]
    if len(out) <= limit:
        return out
    dropped = 0
    if out and out[0].get("op") == TRUNCATED_OP:
        dropped = int((out[0].get("counts") or {}).get("records") or 0)
        out = out[1:]
    keep = out[-(limit - 1) :] if limit > 1 else []
    dropped += len(out) - len(keep)
    marker = history_record(
        TRUNCATED_OP,
        "history",
        f"{_plural(dropped, 'earlier record')} collapsed to keep this history bounded",
        counts={"records": dropped},
    )
    return [marker] + keep


def add_standard_metadata(
    creator,
    *,
    title,
    description,
    language="eng",
    creator_name="Zimi",
    source=None,
    date_str=None,
    scraper=None,
    history=None,
    name=None,
    tags=(),
    illustration=None,
    flavour=None,
    long_description=None,
    license=None,
    relation=None,
):
    """The full openZIM metadata block — every mandatory key, conforming — plus
    the Zimi provenance block. One chokepoint, so no engine can forget a key.

    ``name`` is the stable cross-edition identifier (see ``zim_name``); it
    falls back to one derived from the title, but an engine that knows its
    source should always pass its own. ``title`` and ``description`` are
    shortened to the spec's caps here; when the description does not fit, the
    full text is kept as ``LongDescription`` rather than lost. ``tags`` are
    extras folded in beside the defaults. ``illustration`` is PNG bytes for
    the mandatory 48x48 icon — omit it and a generated identicon is used.
    ``license`` and ``relation`` are written only when the caller actually
    knows them; nothing here invents a licence claim.

    ``source`` is where the content came from. A URL is written to BOTH the
    standard ``Source`` field (whose openZIM meaning is a URL) and
    ``X-Zimi-Source``; anything else is reduced to its basename and written to
    ``X-Zimi-Source`` alone, so the standard field keeps its meaning while the
    Zimi field stays uniform across every creation mode. ``scraper`` defaults
    to ``scraper_string()``; an engine that did the work passes an enriched
    one. ``history`` is one record from ``history_record`` (or a list of them),
    written as the ``X-Zimi-History`` array that later edits append to."""
    language = normalize_language(language)
    short_title = fit_text(title, MAX_TITLE_LENGTH)
    full_description = " ".join(str(description or "").split())
    short_description = fit_text(full_description, MAX_DESCRIPTION_LENGTH)
    long_text = fit_text(
        long_description or full_description, MAX_LONG_DESCRIPTION_LENGTH
    )

    creator.add_metadata("Name", name or zim_name(title, language))
    creator.add_metadata("Title", short_title)
    creator.add_metadata("Language", language)
    creator.add_metadata("Description", short_description)
    # The spec forbids a LongDescription shorter than the Description, so it
    # ships only when it genuinely says more than the short one already did.
    if len(long_text) > len(short_description):
        creator.add_metadata("LongDescription", long_text)
    creator.add_metadata("Creator", creator_name)
    creator.add_metadata("Publisher", "Zimi")
    creator.add_metadata("Date", date_str or datetime.date.today().isoformat())
    creator.add_metadata("Tags", tags_string(tags))
    if flavour:
        creator.add_metadata("Flavour", str(flavour))
    if license:
        creator.add_metadata("License", str(license))
    if relation:
        creator.add_metadata("Relation", str(relation))
    creator.add_illustration(
        ILLUSTRATION_SIZE,
        illustration or default_illustration(name or zim_name(title, language)),
    )
    creator.add_metadata(SCRAPER_METADATA_KEY, scraper or scraper_string())
    if _is_url(source):
        creator.add_metadata("Source", str(source))
    label = source_label(source)
    if label:
        creator.add_metadata(SOURCE_METADATA_KEY, label)
    if history:
        records = [history] if isinstance(history, dict) else list(history)
        creator.add_metadata(
            HISTORY_METADATA_KEY, json.dumps(records, separators=(",", ":"))
        )


def build_bookmarks_zim(
    bookmarks,
    zim_dir,
    reader=_read_source_article,
    asset_reader=_read_source_item,
    progress=None,
    name=None,
    title=None,
    sections=None,
):
    """Write ONE ZIM containing an article per bookmark plus an index page.

    ``bookmarks`` is a list of ``{"zim","path","title"[,"section"]}`` dicts.
    ``reader(zim, path)`` fetches source HTML; ``asset_reader(zim, path)``
    fetches raw asset bytes (both injectable for tests). ``progress(done, total)``
    is called per article. ``name`` sets the output basename (default
    ``zimi-bookmarks_<date>``); ``title`` sets the ZIM Title metadata.
    ``sections`` (optional, ordered) lists section headers the index must show
    even when empty — exported empty folders are never silently dropped.
    Returns the output file path. Raises ValueError when ``bookmarks`` is empty.
    """
    if not bookmarks:
        raise ValueError("no bookmarks to export")

    _Article = zim_static_item_class()

    date_str = datetime.date.today().isoformat()
    base = name or f"zimi-bookmarks_{date_str}"
    heading = title or f"Zimi Bookmarks · {date_str}"
    out_path = _output_path(zim_dir, base)
    total = len(bookmarks)
    entries = []  # (path, title, source_zim, section) for the index

    with atomic_zim_creator(out_path) as creator:
        creator.set_mainpath("index")
        carrier = _AssetCarrier(creator.add_item, make_asset_item, asset_reader)
        for i, bk in enumerate(bookmarks):
            if progress:
                progress(i, total)
            zim = (bk.get("zim") or "").strip()
            path = (bk.get("path") or "").strip()
            title_i = (bk.get("title") or "").strip() or path or f"Bookmark {i + 1}"
            section = (bk.get("section") or "").strip()
            art_path = f"A/{i}_{_slug(title_i, str(i))}"
            raw = reader(zim, path) if (zim and path) else None
            extra_css = ""
            if raw is None:
                body = (
                    "<p><em>The source article could not be read "
                    "(the ZIM may have been removed).</em></p>"
                )
            else:
                # Carry styling + images BEFORE stripping the raw document.
                try:
                    extra_css = carrier.collect_styles(zim, path, raw)
                    raw = carrier.rewrite_media(zim, path, raw)
                except Exception as e:  # never let one bad article kill the export
                    log.debug("asset carry failed for %s/%s: %s", zim, path, e)
                body = _extract_body(raw)
            creator.add_item(
                _Article(
                    art_path,
                    title_i,
                    _article_html(title_i, zim, path, body, extra_css),
                )
            )
            entries.append((art_path, title_i, zim, section))
        if progress:
            # Every article is in. What remains is the Creator's close
            # (full-text index build + cluster compression), the longest
            # single phase for a large export, so report N/N now instead
            # of freezing the client's counter at N-1/N while it runs.
            progress(total, total)
        creator.add_item(
            _Article(
                "index",
                heading,
                _index_html(entries, date_str, heading, sections=sections),
            )
        )
        add_standard_metadata(
            creator,
            title=heading,
            description=f"{_plural(len(entries), 'bookmarked article')} exported by Zimi",
            date_str=date_str,
            # The Name must survive re-exporting the same selection tomorrow,
            # so it drops the date the filename carries.
            name=zim_name(
                re.sub(r"^zimi[-_]|[_-]?\d{4}-\d{2}-\d{2}$", "", base) or "bookmarks"
            ),
            tags=media_tags(carrier.mimetypes),
            history=history_record(
                "created",
                "bookmarks",
                f"exported {_plural(len(entries), 'bookmarked article')} "
                "from the library",
                counts={"pages": len(entries)},
            ),
        )
    if progress:
        progress(total, total)
    return out_path


def build_export_jobs(jobs, zim_dir, progress=None, **kw):
    """Build one ZIM per job. ``jobs`` is a list of
    ``{"name","title","bookmarks":[...]}``. Progress is aggregated across all
    jobs' articles. Returns the list of written file paths."""
    grand_total = sum(len(j.get("bookmarks") or []) for j in jobs) or 1
    done_before = [0]
    out_paths = []

    def _agg(done, total, base=done_before):
        if progress:
            progress(min(base[0] + done, grand_total), grand_total)

    for job in jobs:
        bms = job.get("bookmarks") or []
        if not bms:
            continue
        out = build_bookmarks_zim(
            bms,
            zim_dir,
            progress=_agg,
            name=job.get("name"),
            title=job.get("title"),
            sections=job.get("sections"),
            **kw,
        )
        out_paths.append(out)
        done_before[0] += len(bms)
    if progress:
        progress(grand_total, grand_total)
    return out_paths


def _register_exports(out_paths):
    """Make the just-written export ZIMs visible in the library.

    The old shape here — ``load_cache(force=True)`` under ``_zim_lock`` — re-
    opened and re-scanned EVERY archive in the library while holding the lock
    that every libzim request needs. Exporting three bookmarks off a 53-ZIM
    library on a NAS mount therefore froze every reader for as long as the
    rescan took. ``register_zim_file`` extracts each new ZIM's metadata off the
    lock and holds it only for the splice; the full rescan survives as the
    fallback for a file that cannot be read incrementally.
    """
    needs_rescan = False
    for path in out_paths:
        try:
            if not _srv.register_zim_file(path):
                needs_rescan = True
        except Exception as e:
            log.warning(
                "Incremental registration of %s failed (%s) — falling back to a "
                "full library rescan",
                os.path.basename(path),
                e,
            )
            needs_rescan = True
    if needs_rescan:
        with _srv._zim_lock:
            _srv.load_cache(force=True)
    # Cached result sets predate the new ZIM and would hide it until their TTL.
    _srv._search_cache_clear()
    _srv._suggest_cache_clear()


def start_export(payload):
    """Kick off a bookmark export on a daemon worker thread.

    ``payload`` is either a flat list of bookmark dicts (v1 — one ZIM) or a
    list of job dicts ``{"name","title","bookmarks":[...]}`` (v2 — one ZIM
    each). Returns ``(started, message)``; ``started`` is False when one is
    already running or there is nothing to export."""
    jobs = _normalize_jobs(payload)
    if not jobs:
        return False, "no bookmarks"
    if not _export_lock.acquire(blocking=False):
        return False, "an export is already running"
    total = sum(len(j["bookmarks"]) for j in jobs)
    _set_export_state(
        phase="running", done=0, total=total, file=None, files=[], count=0, error=None
    )

    def _run():
        try:

            def _prog(done, total):
                _set_export_state(done=done, total=total)

            out_paths = build_export_jobs(jobs, _srv.ZIM_DIR, progress=_prog)
            _register_exports(out_paths)
            names = [os.path.basename(p) for p in out_paths]
            _set_export_state(
                phase="done",
                file=(names[-1] if names else None),
                files=names,
                count=total,
            )
        except Exception as e:
            log.error("bookmark export failed: %s", e)
            _set_export_state(phase="error", error="export failed")
        finally:
            _export_lock.release()

    threading.Thread(target=_run, daemon=True, name="bookmark-export").start()
    return True, "started"


def _normalize_jobs(payload):
    """Accept a flat bookmark list OR a list of job dicts; return clean jobs."""
    if not isinstance(payload, list) or not payload:
        return []
    # A job dict has a "bookmarks" list; a bookmark dict has "zim"/"path".
    if isinstance(payload[0], dict) and "bookmarks" in payload[0]:
        jobs = []
        for j in payload:
            if not isinstance(j, dict):
                continue
            bms = [b for b in (j.get("bookmarks") or []) if isinstance(b, dict)]
            if bms:
                jobs.append(
                    {
                        "name": j.get("name") or None,
                        "title": j.get("title") or None,
                        "sections": [
                            s for s in (j.get("sections") or []) if isinstance(s, str)
                        ],
                        "bookmarks": bms,
                    }
                )
        return jobs
    return [
        {
            "name": None,
            "title": None,
            "bookmarks": [b for b in payload if isinstance(b, dict)],
        }
    ]
