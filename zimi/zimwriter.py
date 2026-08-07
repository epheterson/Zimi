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

import datetime
import html as _html
import logging
import os
import posixpath
import re
import threading

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
    from libzim.writer import Blob, ContentProvider, Creator, Hint, Item

    if not bookmarks:
        raise ValueError("no bookmarks to export")

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

    class _Article(Item):
        def __init__(
            self, path, title, content, mimetype="text/html;charset=utf-8", front=True
        ):
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
            return {Hint.FRONT_ARTICLE: True} if self._front else {}

    def _make_asset(path, mimetype, data):
        return _Article(
            path, path.rsplit("/", 1)[-1], data, mimetype=mimetype, front=False
        )

    date_str = datetime.date.today().isoformat()
    base = name or f"zimi-bookmarks_{date_str}"
    heading = title or f"Zimi Bookmarks · {date_str}"
    out_path = _output_path(zim_dir, base)
    tmp_path = out_path + ".tmp"
    total = len(bookmarks)
    entries = []  # (path, title, source_zim, section) for the index

    try:
        with Creator(tmp_path).config_indexing(True, "eng") as creator:
            creator.set_mainpath("index")
            carrier = _AssetCarrier(creator.add_item, _make_asset, asset_reader)
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
            creator.add_metadata("Title", heading)
            creator.add_metadata("Language", "eng")
            creator.add_metadata(
                "Description",
                f"{_plural(len(entries), 'bookmarked article')} exported by Zimi",
            )
            creator.add_metadata("Creator", "Zimi")
            creator.add_metadata("Publisher", "Zimi")
            creator.add_metadata("Date", date_str)
        os.replace(tmp_path, out_path)
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise
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
            with _srv._zim_lock:
                _srv.load_cache(force=True)  # make the new files visible in the library
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
