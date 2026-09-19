"""Zimi Tube: every video in the library, as one feed.

Eric, 2026-09-19: "make some YouTube zims and have it thread in videos from
all zims and TED zims with zim name and text and thumbnail? Nice interface?
Related videos?" The feed reads each video ZIM's own index, the way the
maps code reads each map's own place index; nothing is re-indexed and no
model is involved. Three shapes are known:

- ted2zim (Kiwix's TED and TED-Ed): ``assets/data.js`` holds ``json_data``,
  a list of talks; a talk page is ``<slug>``; its thumbnail is
  ``videos/<id>/thumbnail.webp``.
- youtube2zim (Kiwix's YouTube channels, Khan Academy): ``videos.json``
  when present; older builds keep ``assets/data.js`` in ted2zim's style.
- Zimi's own (``zimi create <video URL>``): ``videos.json`` from 1.10 on;
  before that, the index page's rows.

Each entry: ``{id, title, description, speaker, thumb, page, duration,
date}`` with ``thumb`` and ``page`` as ZIM paths. Read once per archive
file and kept for the life of the process.
"""

import html as _html
import json
import logging
import re
import threading

from zimi import server as _srv

log = logging.getLogger("zimi")

_MAX_INDEX_BYTES = 32 * 1024 * 1024
_lock = threading.Lock()
_cache = {}  # archive filename -> list


def _read(archive, path, max_bytes=_MAX_INDEX_BYTES):
    try:
        item = archive.get_entry_by_path(path).get_item()
        if item.size > max_bytes:
            return None
        return bytes(item.content).decode("utf-8", "replace")
    except Exception:
        return None


def _has(archive, path):
    try:
        archive.get_entry_by_path(path)
        return True
    except Exception:
        return False


def _lang_text(value):
    """ted2zim's ``[{lang, text}]`` lists, or a plain string."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        by = {}
        for v in value:
            if isinstance(v, dict) and v.get("text"):
                by[v.get("lang") or "default"] = v["text"]
        return by.get("en") or by.get("default") or (next(iter(by.values())) if by else "")
    return ""


def _json_data(text):
    """The list inside ``json_data = [...]``, or None."""
    if not text:
        return None
    a, b = text.find("["), text.rfind("]")
    if a < 0 or b <= a:
        return None
    try:
        data = json.loads(text[a : b + 1])
    except ValueError:
        return None
    return data if isinstance(data, list) else None


def _ted(archive):
    talks = _json_data(_read(archive, "assets/data.js"))
    if not talks:
        return None
    out = []
    for t in talks:
        if not isinstance(t, dict) or not t.get("slug"):
            continue
        vid = str(t.get("id") or "")
        out.append(
            {
                "id": vid or t["slug"],
                "title": _lang_text(t.get("title")),
                "description": _lang_text(t.get("description"))[:400],
                "speaker": str(t.get("speaker") or "").strip(),
                "thumb": f"videos/{vid}/thumbnail.webp" if vid else "",
                "page": t["slug"],
                "duration": None,
                "date": "",
            }
        )
    return out


def _youtube2zim(archive):
    text = _read(archive, "videos.json")
    rows = None
    if text:
        try:
            rows = json.loads(text)
        except ValueError:
            rows = None
        if isinstance(rows, dict):
            rows = rows.get("videos")
    if not rows:
        rows = _json_data(_read(archive, "assets/data.js"))
    if not rows:
        return None
    out = []
    for v in rows:
        if not isinstance(v, dict):
            continue
        vid = str(v.get("id") or v.get("slug") or "")
        if not vid:
            continue
        page = v.get("slug") or f"videos/{vid}"
        thumb = v.get("thumbnailPath") or v.get("thumbnail") or f"videos/{vid}/video.webp"
        out.append(
            {
                "id": vid,
                "title": _lang_text(v.get("title")),
                "description": _lang_text(v.get("description"))[:400],
                "speaker": str((v.get("author") or {}).get("channelTitle") if isinstance(v.get("author"), dict) else v.get("author") or v.get("channel") or "").strip(),
                "thumb": thumb,
                "page": page,
                "duration": v.get("duration"),
                "date": str(v.get("publicationDate") or v.get("date") or "")[:10],
            }
        )
    return out


_ZIMI_ROW_RE = re.compile(
    r"<li class='zimi-vid'>(?:<a href='(?P<page1>[^']+)'><img src='(?P<thumb>[^']+)' alt=''></a>)?"
    r"<div><a href='(?P<page>[^']+)'>(?P<title>.*?)</a>(?:<br><span class='zimi-vid-meta'>(?P<meta>.*?)</span>)?</div></li>",
    re.S,
)


def _zimi(archive):
    """Zimi's own video ZIMs: ``videos.json`` when the writer kept one, else
    the index page's rows."""
    text = _read(archive, "videos.json")
    if text:
        try:
            rows = json.loads(text)
            if isinstance(rows, list):
                return [r for r in rows if isinstance(r, dict) and r.get("page")]
        except ValueError:
            pass
    try:
        main = archive.main_entry
        if main.is_redirect:
            main = main.get_redirect_entry()
        page_html = bytes(main.get_item().content).decode("utf-8", "replace")
    except Exception:
        return None
    out = []
    for m in _ZIMI_ROW_RE.finditer(page_html):
        meta = [_html.unescape(x).strip() for x in (m.group("meta") or "").split("·")]
        out.append(
            {
                "id": m.group("page").rsplit("/", 1)[-1],
                "title": _html.unescape(m.group("title")),
                "description": "",
                "speaker": meta[0] if meta and meta[0] else "",
                "thumb": _html.unescape(m.group("thumb") or ""),
                "page": _html.unescape(m.group("page")),
                "duration": meta[1] if len(meta) > 1 else None,
                "date": meta[2] if len(meta) > 2 else "",
            }
        )
    return out or None


def reader_for(scraper):
    s = (scraper or "").lower()
    if s.startswith("ted2zim"):
        return _ted
    if s.startswith("youtube2zim"):
        return _youtube2zim
    if s.startswith("zimi"):
        return _zimi
    return None


def videos_for(name):
    """The videos in the installed ZIM ``name``, or [] when it is not a video
    ZIM Zimi can read. Cached per archive file."""
    from zimi.search import _get_fts_archive

    entry = next((z for z in (_srv._zim_list_cache or []) if z.get("name") == name), None)
    if not entry or entry.get("kind") != "video":
        return []
    try:
        archive, lock = _get_fts_archive(name)
    except Exception:
        return []
    if archive is None or lock is None:
        return []
    key = getattr(archive, "filename", None) or name
    with _lock:
        if key in _cache:
            return _cache[key]
    with lock:
        try:
            scraper = bytes(archive.get_metadata("Scraper")).decode("utf-8", "replace")
        except Exception:
            scraper = ""
        read = reader_for(scraper)
        rows = None
        if read is not None:
            try:
                rows = read(archive)
            except Exception as e:
                log.debug("tube: %s unreadable: %s", name, e)
        if rows is None:
            # A video ZIM by its metadata whose index Zimi could not read: try
            # every reader once, cheapest first.
            for alt in (_ted, _youtube2zim, _zimi):
                try:
                    rows = alt(archive)
                except Exception:
                    rows = None
                if rows:
                    break
    rows = rows or []
    with _lock:
        _cache[key] = rows
    return rows


def _matches(v, q):
    hay = " ".join((v.get("title") or "", v.get("description") or "", v.get("speaker") or "")).lower()
    return all(w in hay for w in q)


def feed(query="", limit=60, offset=0):
    """Videos across every installed video ZIM, interleaved by ZIM so the
    feed mixes sources rather than listing one ZIM whole; a query keeps the
    ones whose title, description or speaker carry every word."""
    q = [w for w in (query or "").lower().split() if w]
    per_zim = []
    for z in _srv._zim_list_cache or []:
        name = z.get("name")
        if z.get("kind") != "video" or not name or not _srv.zim_allowed(name):
            continue
        rows = videos_for(name)
        if q:
            rows = [v for v in rows if _matches(v, q)]
        if rows:
            per_zim.append((name, z.get("title") or name, rows))
    merged = []
    i = 0
    while True:
        added = False
        for name, title, rows in per_zim:
            if i < len(rows):
                v = dict(rows[i])
                v["zim"] = name
                v["zim_title"] = title
                merged.append(v)
                added = True
        if not added:
            break
        i += 1
    total = len(merged)
    return {"items": merged[offset : offset + limit], "total": total, "sources": len(per_zim)}


def _reset_for_tests():
    with _lock:
        _cache.clear()
