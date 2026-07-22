"""Save to ZIM v1 — export bookmarked articles to a standalone .zim file.

Each bookmark becomes one HTML article embedded standalone: the source
article's body wrapped with a small provenance header noting where it came
from. An auto-generated index page (the ZIM main entry) links every entry.
The result lands in ZIM_DIR and shows up in the library like any other ZIM
after a cache rescan.

Threading model: the libzim *writer* (``libzim.writer.Creator``) writes a
NEW file and is independent of the read-side ``Archive`` pool — safe to run
on a worker thread. Source-article READS, however, still touch libzim
``Archive`` objects, which are NOT thread-safe, so every read goes through
the normal ``_srv._zim_lock``-guarded path.
"""

import datetime
import html as _html
import logging
import os
import re
import threading

import zimi.server as _srv

log = logging.getLogger("zimi.zimwriter")

# Strip these whole elements (with content) from embedded article bodies — they
# either don't work standalone or are a security/nuisance risk in the export.
_STRIP_TAGS_RE = re.compile(
    r"<(script|style|link|meta|noscript)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_STRIP_VOID_RE = re.compile(r"<(link|meta)\b[^>]*/?>", re.IGNORECASE)
_BODY_RE = re.compile(r"<body[^>]*>(.*)</body>", re.IGNORECASE | re.DOTALL)

# Export state for the poll endpoint. Mirrors the _mirror_progress shape.
_export_lock = threading.Lock()
_export_state = {
    "phase": None,  # None | "running" | "done" | "error"
    "done": 0,
    "total": 0,
    "file": None,  # output filename once written
    "count": 0,  # articles written
    "error": None,
}


def _set_export_state(**kw):
    _export_state.update(kw)


def get_export_state():
    """Copied snapshot for the status poll endpoint (never the live dict)."""
    return dict(_export_state)


def _slug(text, fallback):
    """A short, filesystem/URL-safe slug for an in-ZIM article path."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "")).strip("_")
    return (s or fallback)[:60]


def _extract_body(raw_html):
    """Return the inner <body> HTML of a source article, scripts/styles/links
    stripped. Falls back to the whole (stripped) document if there is no
    recognizable body wrapper (fragments, zimgit docs, etc.)."""
    stripped = _STRIP_TAGS_RE.sub("", raw_html)
    stripped = _STRIP_VOID_RE.sub("", stripped)
    m = _BODY_RE.search(stripped)
    return m.group(1) if m else stripped


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
    "img{max-width:100%;height:auto}"
)


def _article_html(title, source_zim, source_path, body):
    """Wrap a source body as a standalone export article."""
    src = _html.escape(source_zim)
    spath = _html.escape(source_path)
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{_html.escape(title)}</title><style>{_PAGE_CSS}</style></head>"
        "<body><header class='zimi-src'>From <strong>" + src + "</strong>"
        f" · <code>{spath}</code> · "
        "<a href='index'>&#8592; Bookmarks index</a></header>"
        f"<main>{body}</main>"
        "<footer class='zimi-nav'><a href='index'>&#8592; Back to index</a>"
        "</footer></body></html>"
    ).encode("utf-8")


def _index_html(entries, date_str):
    """Build the main-entry index page listing every exported article."""
    items = []
    for path, title, zim in entries:
        items.append(
            f"<li><a href='{_html.escape(path)}'>{_html.escape(title)}</a>"
            f" <span style='color:#999'>· {_html.escape(zim)}</span></li>"
        )
    body = "".join(items) or "<li><em>No bookmarks.</em></li>"
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>Zimi Bookmarks · {date_str}</title>"
        f"<style>{_PAGE_CSS}</style></head><body>"
        f"<h1>Zimi Bookmarks</h1><p style='color:#666'>Exported {date_str} · "
        f"{len(entries)} article(s)</p>"
        f"<ol class='zimi-index'>{body}</ol></body></html>"
    ).encode("utf-8")


def _output_path(zim_dir, date_str):
    """A non-clobbering output path: zimi-bookmarks_<date>[-N].zim."""
    base = f"zimi-bookmarks_{date_str}"
    candidate = os.path.join(zim_dir, base + ".zim")
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(zim_dir, f"{base}-{n}.zim")
        n += 1
    return candidate


def build_bookmarks_zim(bookmarks, zim_dir, reader=_read_source_article, progress=None):
    """Write a ZIM containing one article per bookmark plus an index page.

    ``bookmarks`` is a list of ``{"zim","path","title"}`` dicts. ``reader`` is
    the source-article fetcher (injectable for tests). ``progress(done, total)``
    is called as each article is processed. Returns the output file path.

    Raises ValueError when ``bookmarks`` is empty.
    """
    from libzim.writer import Creator, Item, ContentProvider, Hint, Blob

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
        def __init__(self, path, title, content):
            super().__init__()
            self._path = path
            self._title = title
            self._content = content

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return "text/html;charset=utf-8"

        def get_contentprovider(self):
            return _Provider(self._content)

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: True}

    date_str = datetime.date.today().isoformat()
    out_path = _output_path(zim_dir, date_str)
    tmp_path = out_path + ".tmp"
    total = len(bookmarks)
    entries = []  # (path, title, source_zim) for the index

    try:
        with Creator(tmp_path).config_indexing(True, "eng") as creator:
            creator.set_mainpath("index")
            for i, bk in enumerate(bookmarks):
                if progress:
                    progress(i, total)
                zim = (bk.get("zim") or "").strip()
                path = (bk.get("path") or "").strip()
                title = (bk.get("title") or "").strip() or path or f"Bookmark {i + 1}"
                art_path = f"A/{i}_{_slug(title, str(i))}"
                raw = reader(zim, path) if (zim and path) else None
                if raw is None:
                    body = (
                        "<p><em>The source article could not be read "
                        "(the ZIM may have been removed).</em></p>"
                    )
                else:
                    body = _extract_body(raw)
                creator.add_item(
                    _Article(art_path, title, _article_html(title, zim, path, body))
                )
                entries.append((art_path, title, zim))
            creator.add_item(
                _Article(
                    "index",
                    f"Zimi Bookmarks · {date_str}",
                    _index_html(entries, date_str),
                )
            )
            creator.add_metadata("Title", f"Zimi Bookmarks {date_str}")
            creator.add_metadata("Language", "eng")
            creator.add_metadata(
                "Description",
                f"{len(entries)} bookmarked article(s) exported by Zimi",
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


def start_export(bookmarks):
    """Kick off a bookmark export on a daemon worker thread. Returns a
    ``(started, message)`` tuple; ``started`` is False if one is already
    running or there is nothing to export."""
    if not bookmarks:
        return False, "no bookmarks"
    if not _export_lock.acquire(blocking=False):
        return False, "an export is already running"
    _set_export_state(
        phase="running",
        done=0,
        total=len(bookmarks),
        file=None,
        count=0,
        error=None,
    )

    def _run():
        try:

            def _prog(done, total):
                _set_export_state(done=done, total=total)

            out_path = build_bookmarks_zim(bookmarks, _srv.ZIM_DIR, progress=_prog)
            # New file on disk → make it visible in the library.
            with _srv._zim_lock:
                _srv.load_cache(force=True)
            _set_export_state(
                phase="done",
                file=os.path.basename(out_path),
                count=len(bookmarks),
            )
        except Exception as e:
            log.error("bookmark export failed: %s", e)
            _set_export_state(phase="error", error="export failed")
        finally:
            _export_lock.release()

    threading.Thread(target=_run, daemon=True, name="bookmark-export").start()
    return True, "started"
