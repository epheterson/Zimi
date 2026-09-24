"""Zimi Tube: every video in the library, as one feed.

Eric, 2026-09-19: "make some YouTube zims and have it thread in videos from
all zims and TED zims with zim name and text and thumbnail? Nice interface?
Related videos?" The feed reads each video ZIM's own index, the way the
maps code reads each map's own place index; nothing is re-indexed and no
model is involved. Three shapes are known:

- ted2zim (Kiwix's TED and TED-Ed): ``assets/data.js`` holds ``json_data``,
  a list of talks; ted2zim 3.x (every ``ted_mul_*``) splits it by subtitle
  language, ``assets/data_<lang>.js``, the languages named in the home
  page's picker. A talk page is ``<slug>``; its thumbnail is
  ``videos/<id>/thumbnail.webp``.
- youtube2zim (Kiwix's YouTube channels, Khan Academy): ``videos.json``
  when present; older builds keep ``assets/data.js`` in ted2zim's style.
  youtube2zim 3.x (CrashCourse, Blender Studio) is a one-page app with no
  page per video: ``playlists.json`` names the playlists,
  ``playlists/<slug>.json`` lists each one's videos, ``videos/<slug>.json``
  holds a video's facts and files, ``index/<slug>`` opens it in the app.
- Zimi's own (``zimi create <video URL>``): ``videos.json`` from 1.10 on;
  before that, the index page's rows.

Each entry: ``{id, title, description, speaker, thumb, page, duration,
date}`` with ``thumb`` and ``page`` as ZIM paths. Read once per archive
file and kept for the life of the process.

Two layouts keep a video's description in a file of its own: ted2zim 3.x
(``assets/data_<lang>_<slug>.js``, 8 to 40 KB, every language's title and
description) and youtube2zim 3.x (``videos/<slug>.json``). Reading thousands
of those on the request that opens ZimiTube is what made it slow, and libzim
holds the GIL while it reads, so every other request waits too. The feed
answers from the lists alone; the rest (description, channel, date) is read
once, in the background, into ``<data dir>/tube/<name>.db``, checked against
the ZIM like the title index is, and merged in when it is there.
"""

import html as _html
import json
import logging
import os
import re
import sqlite3
import threading
import time

from zimi import server as _srv

log = logging.getLogger("zimi")

_MAX_INDEX_BYTES = 32 * 1024 * 1024
# A description is kept whole up to this, and searched whole; the feed sends
# the first _FEED_DESCRIPTION_CHARS of it, and the player asks for the rest.
_MAX_DESCRIPTION_CHARS = 5000
_FEED_DESCRIPTION_CHARS = 400
_lock = threading.Lock()
_cache = {}  # archive filename -> the rows the feed serves
_base = {}  # archive filename -> (name, rows from the lists alone)
_details = {}  # name -> (real path of the ZIM they were read from, {id: (description, speaker, date)})

# The details file: one row per video whose facts live in a file of its own.
_DETAILS_VERSION = "1"
# Past this many entries the details build runs in a process of its own (see
# search._build_index_isolated). It reads one file per video, not every
# entry, so it starts far lower than the title index's threshold.
_DETAILS_ISOLATE_MIN_ENTRIES = 5_000
# One details build at a time, as _build_all_title_lock serializes the title
# index; _queued keeps a ZIM from being asked for twice while it waits.
_build_lock = threading.Lock()
_queue_lock = threading.Lock()
_queued = set()


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


def _present(archive, path):
    """A media file that is really there: the entry exists and holds bytes.
    ted_en_technology_2023-09 carries a zero-byte video.mp4 for the climate
    talk (the scrape wrote the entry and never the file), which is as absent
    as no entry at all."""
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        return entry.get_item().size > 0
    except Exception:
        return False


def _read_json(archive, path):
    """The JSON value at ``path``, or None when it is absent or not JSON."""
    text = _read(archive, path)
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _main_text(archive):
    """The main page's HTML, or None."""
    try:
        main = archive.main_entry
        if main.is_redirect:
            main = main.get_redirect_entry()
        return bytes(main.get_item().content).decode("utf-8", "replace")
    except Exception:
        return None


def _clean(value):
    """A name with its runs of spaces made one: ted2zim writes a speaker's
    first and last name with two between (``Magda  Sayeg``), and one talk
    in two builds must still read as one speaker."""
    return " ".join(str(value or "").split())


_ISO_DURATION_RE = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$")
_SECONDS_PER = (86400, 3600, 60, 1)


def _iso_seconds(value):
    """``PT6M31S`` (youtube2zim 3.x) as 391; a number stays as it is;
    anything else None."""
    if isinstance(value, (int, float)) or value is None:
        return value
    m = _ISO_DURATION_RE.match(str(value).strip())
    if not m or not any(m.groups()):
        return None
    return int(sum(float(g or 0) * k for g, k in zip(m.groups(), _SECONDS_PER)))


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


def _json_object(text):
    """The object in ``window.json_data = {...}`` or a plain JSON file, or None."""
    if not text:
        return None
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        data = json.loads(text[a : b + 1])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


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


def _page_path(archive, path):
    """The path the page really has in the archive. A 2021 ted2zim ZIM
    still files talks under ``A/`` and its assets under ``-/``; libzim
    finds ``<slug>`` either way, but the page's own relative links
    (``../-/assets/…``) only resolve from where the page really is."""
    try:
        return archive.get_entry_by_path(path).path or path
    except Exception:
        return path


_LANG_OPTION_RE = re.compile(r"""<option\s+value=["']([A-Za-z0-9-]+)["']""")


def _ted_talks(archive):
    """ted2zim's talk list: the one ``assets/data.js`` of 2.x, else 3.x's
    ``assets/data_<lang>.js`` for every language the home page offers,
    English first. Each language lists the talks with subtitles in it, so a
    talk in no English list is still in another; the first list that has a
    talk gives its title, and its ``_lang``: the talk's own file in that
    language, ``assets/data_<lang>_<slug>.js``, holds its description."""
    talks = _json_data(_read(archive, "assets/data.js"))
    if talks:
        return talks
    langs = _LANG_OPTION_RE.findall(_main_text(archive) or "")
    out, seen = [], set()
    for lang in dict.fromkeys(["en"] + langs):
        for t in _json_data(_read(archive, f"assets/data_{lang}.js")) or ():
            key = isinstance(t, dict) and (t.get("id") or t.get("slug"))
            if key and key not in seen:
                seen.add(key)
                t["_lang"] = lang
                out.append(t)
    return out or None


def _ted(archive):
    talks = _ted_talks(archive)
    if not talks:
        return None
    out = []
    for t in talks:
        if not isinstance(t, dict) or not t.get("slug"):
            continue
        vid = str(t.get("id") or "")
        row = {
            "id": vid or t["slug"],
            "title": _lang_text(t.get("title")),
            "description": _lang_text(t.get("description"))[:_MAX_DESCRIPTION_CHARS],
            "speaker": _clean(t.get("speaker")),
            "thumb": f"videos/{vid}/thumbnail.webp" if vid else "",
            "page": _page_path(archive, t["slug"]),
            "duration": None,
            "date": "",
            "media": [f"videos/{vid}/video.webm", f"videos/{vid}/video.mp4"] if vid else [],
        }
        if not row["description"] and t.get("_lang"):
            row["_detail"] = f"assets/data_{t['_lang']}_{t['slug']}.js"
        out.append(row)
    return out


def _yt_media(vid):
    return [f"videos/{vid}/video.webm", f"videos/{vid}/video.mp4"]


def _yt_speaker(v):
    author = v.get("author")
    if isinstance(author, dict):
        return _clean(author.get("channelTitle"))
    return _clean(author or v.get("channel"))


def _yt_video_path(slug):
    return f"videos/{slug}.json"


def _yt_video(archive, slug):
    """youtube2zim 3.x's facts for one video, ``videos/<slug>.json``."""
    v = _read_json(archive, _yt_video_path(slug))
    return v if isinstance(v, dict) else None


def _youtube2zim_playlists(archive):
    """youtube2zim 3.x: every video of every playlist, once each, in the
    playlists' order. A playlist lists a video's slug, title, thumbnail
    and length, and the channel; the video's own file adds its description
    and date, read in the background (build_details), not here."""
    listing = _read_json(archive, "playlists.json")
    playlists = listing.get("playlists") if isinstance(listing, dict) else None
    if not isinstance(playlists, list):
        return None
    out, seen = [], set()
    for pl in playlists:
        slug = isinstance(pl, dict) and pl.get("slug")
        body = _read_json(archive, f"playlists/{slug}.json") if slug else None
        for v in (body.get("videos") if isinstance(body, dict) else None) or ():
            vid = isinstance(v, dict) and str(v.get("id") or "")
            if not vid or not v.get("slug") or vid in seen:
                continue
            seen.add(vid)
            out.append(
                {
                    "id": vid,
                    "title": str(v.get("title") or ""),
                    "description": "",
                    "speaker": _yt_speaker(body),
                    "thumb": v.get("thumbnailPath") or f"videos/{vid}/video.webp",
                    "page": f"index/{v['slug']}",
                    "duration": _iso_seconds(v.get("duration")),
                    "date": "",
                    # youtube2zim 3.x writes videoPath as videos/<id>/video.<ext>.
                    "media": _yt_media(vid),
                    "_detail": _yt_video_path(v["slug"]),
                }
            )
    return out or None


def _youtube2zim(archive):
    rows = _read_json(archive, "videos.json")
    if isinstance(rows, dict):
        rows = rows.get("videos")
    if not rows:
        rows = _json_data(_read(archive, "assets/data.js"))
    if not rows:
        return _youtube2zim_playlists(archive)
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
                "description": _lang_text(v.get("description"))[:_MAX_DESCRIPTION_CHARS],
                "speaker": _yt_speaker(v),
                "thumb": thumb,
                "page": page,
                "duration": _iso_seconds(v.get("duration")),
                "date": str(v.get("publicationDate") or v.get("date") or "")[:10],
                "media": _yt_media(vid),
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
    rows = _read_json(archive, "videos.json")
    if isinstance(rows, list):
        rows = [r for r in rows if isinstance(r, dict) and r.get("page")]
        for r in rows:
            # The writer stores one path; every reader's media is a list
            # of where the file may be. A string here was iterated
            # letter by letter and every video Zimi made dropped out.
            if isinstance(r.get("media"), str):
                r["media"] = [r["media"]]
        return rows
    page_html = _main_text(archive)
    if page_html is None:
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
                "media": [f"media/{_media_id}.{ext}" for _media_id in [m.group("page").rsplit("/", 1)[-1]] for ext in ("mp4", "webm", "m4a", "mp3", "mkv", "opus")],
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


def _rows_of(archive):
    """Every video the archive's index lists, by the reader its scraper names.
    Caller holds the archive's lock, or owns the archive."""
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
            log.debug("tube: %s unreadable: %s", getattr(archive, "filename", ""), e)
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
    return rows or []


def _served(rows, details):
    """The rows as the feed serves them: each video's details merged in when
    they have been read, and ``_hay``, the lowercase text a query searches
    (title, the whole description, speaker)."""
    out = []
    for r in rows:
        v = dict(r)
        d = details.get(str(v.get("id"))) if details else None
        if d:
            v["description"] = d[0] or v.get("description") or ""
            v["speaker"] = d[1] or v.get("speaker") or ""
            v["date"] = d[2] or v.get("date") or ""
        v["_hay"] = " ".join(
            str(v.get(k) or "") for k in ("title", "description", "speaker")
        ).lower()
        out.append(v)
    return out


def _details_for(name, key):
    """The details read for ``name`` when they were read from the file the
    feed has open (``key``); None when they are not read yet, or were read
    from an earlier build of the ZIM."""
    got = _details.get(name)
    if got and got[0] == os.path.realpath(key):
        return got[1]
    return None


def videos_for(name):
    """The videos in the installed ZIM ``name``, or [] when it is not a video
    ZIM Zimi can read. Cached per archive file. Answers from the ZIM's lists
    at once; the details a layout keeps in a file per video are merged in
    once the background build has read them (request_details)."""
    from zimi.search import _get_fts_archive

    entry = next(
        (z for z in (_srv._zim_list_cache or []) if z.get("name") == name), None
    )
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
        rows = _rows_of(archive)
        # A video whose file never made it into the ZIM (a talk the scrape
        # skipped) is not a video the app can offer: left out of the feed
        # (Eric: "If a zim has a video link and the source isn't there then
        # exclude it from zimitube"). Every reader names where the file would
        # be; a lookup per candidate is a dirent search, cheap even for
        # thousands of talks.
        rows = [
            v
            for v in rows
            if not v.get("media") or any(_present(archive, m) for m in v["media"])
        ]
    needs = False
    for v in rows:
        v.pop("media", None)
        needs = bool(v.pop("_detail", None)) or needs
    with _lock:
        details = _details_for(name, key)
        _base[key] = (name, rows)
        _cache[key] = served = _served(rows, details)
    if needs and details is None:
        request_details(name)
    return served


def full_description(name, page):
    """The whole description of the video at ``page`` in ``name``, as far as
    the feed knows it (the feed sends the first _FEED_DESCRIPTION_CHARS)."""
    for v in videos_for(name):
        if v.get("page") == page:
            return v.get("description") or ""
    return ""


# ── the details build ──────────────────────────────────────────────────────


def _details_dir():
    """A function, not a constant: ZIMI_DATA_DIR can be repointed after import."""
    return os.path.join(_srv.ZIMI_DATA_DIR, "tube")


def _details_path(name):
    return os.path.join(_details_dir(), f"{name}.db")


def details_current(name, zim_path):
    """Whether ``<data dir>/tube/<name>.db`` was built from this ZIM: its
    mtime, else its uuid, checked as the title index is."""
    from zimi.search import _index_is_current

    return _index_is_current(_details_path(name), zim_path, _DETAILS_VERSION)


def _detail_of(obj):
    """(description, speaker, date) from a video's own file: ted2zim 3.x's
    ``{description: [{lang, text}], speaker}`` or youtube2zim 3.x's
    ``{description, author: {channelTitle}, publicationDate}``."""
    return (
        _lang_text(obj.get("description"))[:_MAX_DESCRIPTION_CHARS],
        _yt_speaker(obj) or _clean(obj.get("speaker")),
        str(obj.get("publicationDate") or "")[:10],
    )


def build_details(zim_name, zim_path):
    """Read every video's own file once, into the details file. Opens an
    archive of its own, never the pool's, so it needs no lock; runs in a
    child process for a big ZIM (search._build_index_isolated). A ZIM whose
    index carries everything gets a file with no rows, so it is not read
    again."""
    from zimi.search import _write_index_meta

    os.makedirs(_details_dir(), exist_ok=True)
    db_path = _details_path(zim_name)
    tmp_path = db_path + ".tmp"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)  # builds are serialized by _build_lock: an orphan
    archive = _srv.open_archive(zim_path)
    rows = []
    for r in _rows_of(archive):
        obj = _json_object(_read(archive, r["_detail"])) if r.get("_detail") else None
        if obj:
            rows.append((str(r["id"]),) + _detail_of(obj))
    conn = sqlite3.connect(tmp_path)
    try:
        conn.execute(
            "CREATE TABLE videos (id TEXT PRIMARY KEY, description TEXT, speaker TEXT, date TEXT)"
        )
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany("INSERT OR REPLACE INTO videos VALUES (?, ?, ?, ?)", rows)
        _write_index_meta(conn, archive, zim_path, _DETAILS_VERSION, len(rows))
        conn.commit()
    except Exception:
        conn.close()
        os.remove(tmp_path)
        raise
    conn.close()
    os.replace(tmp_path, db_path)
    return len(rows)


def _load_details(name):
    conn = sqlite3.connect(_details_path(name), timeout=5)
    try:
        return {
            r[0]: tuple(r[1:])
            for r in conn.execute("SELECT id, description, speaker, date FROM videos")
        }
    finally:
        conn.close()


def _install(name, zim_path, details):
    """Keep ``details`` for ``name`` and serve them: the feed's cached rows
    for that ZIM are merged again, so the next /tube has them."""
    real = os.path.realpath(zim_path)
    with _lock:
        _details[name] = (real, details)
        for key, (n, rows) in list(_base.items()):
            if n == name and os.path.realpath(key) == real:
                _cache[key] = _served(rows, details)


def _build_one(name):
    """Bring ``name``'s details file up to date and serve it."""
    from zimi.search import _background_end, _background_start, _background_step, _build_index_isolated

    with _build_lock:
        path = _srv.get_zim_files().get(name)
        if not path:
            return
        try:
            if not details_current(name, path):
                t0 = time.time()
                _background_start("tube")
                _background_step("tube", name)
                try:
                    _build_index_isolated(
                        "tube",
                        name,
                        path,
                        build_details,
                        lambda _name: None,
                        min_entries=_DETAILS_ISOLATE_MIN_ENTRIES,
                    )
                finally:
                    _background_end("tube")
                log.info(
                    "ZimiTube: read the video details of %s (%.1fs)",
                    name,
                    time.time() - t0,
                )
            details = _load_details(name)
        except Exception as e:
            # Kept empty until the next start rather than rebuilt on every
            # request: a ZIM that cannot be read now will not be in a second.
            log.warning("ZimiTube: video details of %s failed: %s", name, e)
            details = {}
        _install(name, path, details)


def _claim(name):
    """True for the one caller that gets to build ``name`` now."""
    with _queue_lock:
        if name in _queued:
            return False
        _queued.add(name)
        return True


def _build_claimed(name):
    try:
        _build_one(name)
    finally:
        with _queue_lock:
            _queued.discard(name)


def request_details(name):
    """Start ``name``'s details build in the background, unless it is
    already waiting or running. Returns at once."""
    if _claim(name):
        threading.Thread(
            target=_build_claimed, args=(name,), name="tube-details", daemon=True
        ).start()


def build_all_details():
    """Every video ZIM's details, one after another. The startup worker runs
    this after the title indexes, so descriptions are usually there before
    anyone opens ZimiTube."""
    for z in list(_srv._zim_list_cache or []):
        name = z.get("name")
        if z.get("kind") == "video" and name and _claim(name):
            _build_claimed(name)
_SRC_TAG_RE = re.compile(r"<(?:source|video|audio)\b[^>]*>", re.I | re.S)
_TRACK_RE = re.compile(r"<track\b[^>]*>", re.I | re.S)
_ATTR_RE = re.compile(r"\b([a-z-]+)=['\"]([^'\"]*)['\"]", re.I)
_POSTER_RE = re.compile(r"<video\b[^>]*?\bposter=['\"]([^'\"]+)['\"]", re.I | re.S)


def _resolve_path(page, ref):
    """A path relative to the page's folder, as a ZIM path."""
    import posixpath

    ref = ref.split("#")[0].split("?")[0]
    if not ref or "://" in ref or ref.startswith("/"):
        return ""
    base = posixpath.dirname(page)
    return posixpath.normpath(posixpath.join(base, ref)) if base else posixpath.normpath(ref)


# One video, several containers: the extensions a scraper writes and what
# each is. MP4 first: every browser plays H.264 with AAC, while Safari plays
# a WebM's picture and not its Vorbis sound.
_SIBLINGS = (("mp4", "video/mp4"), ("m4v", "video/mp4"), ("webm", "video/webm"), ("ogv", "video/ogg"))
_SIBLING_TYPES = dict(_SIBLINGS)


def siblings_of(path):
    """The same file under the other extensions, mp4 first, the path itself
    included in that order. ``videos/1/video.webm`` → ``[..mp4, ..m4v, ..webm, ..ogv]``."""
    stem, dot, ext = path.rpartition(".")
    if not dot or ext.lower() not in _SIBLING_TYPES:
        return [path]
    return [stem + "." + e for e, _ in _SIBLINGS]


def mend_media(archive, media):
    """The media list a page gives, with each named file replaced by the
    siblings the ZIM actually carries, mp4 first; a file with no sibling in
    the ZIM stays as named so the caller can say it is missing. Caller holds
    the archive's lock."""
    out = []
    for m in media:
        found = [p for p in siblings_of(m["path"]) if _present(archive, p)]
        for path in found or [m["path"]]:
            if path not in [x["path"] for x in out]:
                ext = path.rpartition(".")[2].lower()
                out.append({"path": path, "type": _SIBLING_TYPES.get(ext) or m.get("type", "")})
    return out


_SOURCE_TAG_RE = re.compile(r"<source\b[^>]*>", re.IGNORECASE)
_VIDEO_ELEMENT_RE = re.compile(r"<video\b.*?</video>", re.IGNORECASE | re.DOTALL)
_MISSING_VIDEO_HTML = (
    '<p class="zimi-video-missing" data-zimi-missing="1" role="status" style="padding:1.5em 1em;'
    'border:1px dashed currentColor;border-radius:8px;opacity:.8;text-align:center">'
    "This video isn't in this ZIM.</p>"
)


def mend_sources(html, name, page):
    """A page's ``<source>`` tags, each pointed at a file the ZIM carries
    when the one it names is absent and a sibling is there; the tag's type
    follows. The page's own relative form is kept (``../I/videos/…``). For a
    page whose sources are all present, or a ZIM Zimi cannot open, the
    text comes back untouched."""
    if "<source" not in html:
        return html
    from zimi.search import _get_fts_archive

    try:
        archive, lock = _get_fts_archive(name)
    except Exception:
        return html
    if archive is None or lock is None:
        return html
    try:
        with lock:
            try:
                entry = archive.get_entry_by_path(page)
                if entry.is_redirect:
                    entry = entry.get_redirect_entry()
                page = entry.path
            except Exception:
                pass

            found = {"sources": 0, "playable": 0}

            def fix(m):
                tag = m.group(0)
                attrs = {k.lower(): _html.unescape(v) for k, v in _ATTR_RE.findall(tag)}
                src = attrs.get("src", "")
                path = _resolve_path(page, src)
                if path and tag.lower().startswith("<source"):
                    found["sources"] += 1
                if not path or _present(archive, path):
                    if path:
                        found["playable"] += 1
                    return tag
                for alt in siblings_of(path):
                    if alt != path and _present(archive, alt):
                        ext = alt.rpartition(".")[2]
                        new_src = src.rpartition(".")[0] + "." + ext
                        esc_src = _html.escape(new_src, quote=True)
                        tag = re.sub(r"""src=(["'])[^"']*\1""", lambda q: 'src=%s%s%s' % (q.group(1), esc_src, q.group(1)), tag, count=1)
                        tag = re.sub(r"""type=(["'])[^"']*\1""", lambda q: 'type=%s%s%s' % (q.group(1), _SIBLING_TYPES[ext], q.group(1)), tag, count=1)
                        found["playable"] += 1
                        return tag
                return tag

            html = _SOURCE_TAG_RE.sub(fix, html)
            if found["sources"] and not found["playable"]:
                # No file behind any source: the page says so rather than
                # offering a player that can never start. The whole element
                # goes, not a mark on it: video.js replaces the <video> on
                # load, before the reader could read a mark. The reader puts
                # the sentence in its own language (app.js, _sayMissingVideos).
                html = _VIDEO_ELEMENT_RE.sub(_MISSING_VIDEO_HTML, html)
            return html
    except Exception:
        return html


# ted2zim's player asks the browser first and the ZIM's decoder (ogv.js)
# second. An iPhone answers "maybe" to WebM and then cannot decode it, so
# the page shows "The media could not be loaded". Served through Zimi, the
# page gets one line that puts the decoder first on Apple's handhelds
# before video.js reads the player's setup; every other browser is left
# alone, so the page and its caches stay one page.
_TECH_ORDER = '"techOrder": ["html5", "ogvjs"]'
_TECH_ORDER_IOS = '"techOrder": ["ogvjs", "html5"]'
_IOS_DECODER_FIRST = (
    "<script>(function(){var u=navigator.userAgent;var a=/iPhone|iPad|iPod/.test(u)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)||(/Safari\\//.test(u)&&!/Chrome|Chromium|Edg|OPR|Android/.test(u));"
    "if(!a)return;function f(){var v=document.querySelectorAll('video[data-setup]');for(var i=0;i<v.length;i++){var s=v[i].getAttribute('data-setup')||'';"
    "if(s.indexOf(%s)>=0)v[i].setAttribute('data-setup',s.split(%s).join(%s));}}"
    "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',f);else f();})()</script>"
) % (json.dumps(_TECH_ORDER), json.dumps(_TECH_ORDER), json.dumps(_TECH_ORDER_IOS))
_VIDEOJS_SCRIPT = re.compile(r"<script\s[^>]*src=[\"'][^\"']*videojs/video(?:\.min)?\.js[\"']", re.IGNORECASE)


def decoder_first_on_ios(html):
    """A ted2zim page with the browser-first player, given the line above;
    any other page unchanged. Safari (the Mac's as well as the iPhone's)
    plays a WebM's picture and not its Vorbis sound; the decoder plays both."""
    if _TECH_ORDER not in html:
        return html
    m = _VIDEOJS_SCRIPT.search(html)
    if not m:
        return html
    return html[: m.start()] + _IOS_DECODER_FIRST + html[m.start() :]


def _page_media(html_text, page):
    """``(media, subs, poster)`` from a page's plain <video>, as ZIM paths."""
    media = []
    for tag in _SRC_TAG_RE.findall(html_text):
        attrs = {k.lower(): _html.unescape(v) for k, v in _ATTR_RE.findall(tag)}
        path = _resolve_path(page, attrs.get("src", ""))
        if path and path not in [x["path"] for x in media]:
            media.append({"path": path, "type": attrs.get("type", "")})
    subs = []
    for t in _TRACK_RE.findall(html_text):
        attrs = {k.lower(): _html.unescape(v) for k, v in _ATTR_RE.findall(t)}
        src = _resolve_path(page, attrs.get("src", ""))
        if src:
            subs.append({"path": src, "lang": attrs.get("srclang", ""), "label": attrs.get("label", "")})
    poster = _POSTER_RE.search(html_text)
    return media, subs, _resolve_path(page, _html.unescape(poster.group(1))) if poster else ""


_YT3_PAGE_PREFIX = "index/"


def _yt3_media(archive, page):
    """``(media, subs, poster)`` for a youtube2zim 3.x video, whose page
    (``index/<slug>``) only sends the browser on to the app: the facts are
    in ``videos/<slug>.json``. A subtitle's file is
    ``<subtitlePath>/video.<code>.vtt``; its name reads ``Dutch - nl``, the
    language after the dash (the code can carry YouTube's track id,
    ``nl-3qLcwtbWM-Y``)."""
    if not page.startswith(_YT3_PAGE_PREFIX):
        return [], [], ""
    v = _yt_video(archive, page[len(_YT3_PAGE_PREFIX) :])
    if not v or not v.get("videoPath"):
        return [], [], ""
    subs = []
    base = str(v.get("subtitlePath") or "").rstrip("/")
    for t in v.get("subtitleList") or ():
        code = isinstance(t, dict) and str(t.get("code") or "")
        if not code or not base:
            continue
        label, _, lang = str(t.get("name") or "").rpartition(" - ")
        subs.append({"path": f"{base}/video.{code}.vtt", "lang": lang.strip() or code, "label": label.strip() or code})
    return [{"path": v["videoPath"], "type": ""}], subs, str(v.get("thumbnailPath") or "")


def playback(name, page):
    """What ZimiTube's own player needs for one video: its media sources,
    subtitle tracks and poster, as ZIM paths. ted2zim, youtube2zim 2.x and
    Zimi's own write a plain <video> with <source> and <track> children on
    the video's page; youtube2zim 3.x has no such page and keeps the same
    facts in a JSON file per video. None when there is no media."""
    from zimi.search import _get_fts_archive

    try:
        archive, lock = _get_fts_archive(name)
    except Exception:
        return None
    if archive is None or lock is None:
        return None
    with lock:
        try:
            entry = archive.get_entry_by_path(page)
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            page = entry.path
            html_text = bytes(entry.get_item().content).decode("utf-8", "replace")
        except Exception:
            return None
        media, subs, poster = _page_media(html_text, page)
        if not media:
            media, subs, poster = _yt3_media(archive, page)
        if not media:
            return None
        # The file the page names may be absent while its sibling is there:
        # ted_en_technology_2023-09 names videos/N/video.webm for every talk and
        # carries video.mp4 for some (the climate talk). Only when nothing is
        # there is the video missing; say so then, rather than "cannot be played
        # here", which blames the browser for a file that is not there.
        media = mend_media(archive, media)
        missing = not any(_present(archive, m["path"]) for m in media)
        ogv = _OGV_BASE if _has(archive, _OGV_BASE + "/ogv.js") else ""
    return {
        "media": media,
        "missing": missing,
        "subs": subs,
        "poster": poster,
        "page": page,
        # TED's videos are WebM, which iPhones cannot decode; the ZIM ships
        # ogv.js, a decoder in JavaScript, for its own pages. ZimiTube's
        # player uses it where the browser cannot play the file.
        "ogv": ogv,
        # The feed sends a description's first lines; the player shows it whole.
        "description": full_description(name, page),
    }


_OGV_BASE = "-/assets/ogvjs"


def _matches(v, q):
    return all(w in v["_hay"] for w in q)


def _card(v):
    """A row as the feed sends it: no private fields, the description cut
    to what a card and the player's first look need."""
    out = {k: x for k, x in v.items() if not k.startswith("_")}
    d = out.get("description") or ""
    if len(d) > _FEED_DESCRIPTION_CHARS:
        out["description"] = d[:_FEED_DESCRIPTION_CHARS].rstrip() + "\u2026"
    return out


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
            per_zim.append((name, z.get("title") or name, bool(z.get("has_icon")), rows, z.get("language") or ""))
    # One card per talk. Two TED ZIMs (a playlist, a topic) carry the same
    # talks, and a feed that shows a talk once per ZIM it is in reads as
    # broken. The first source keeps the card and lists the others.
    merged = []
    seen = {}
    i = 0
    while True:
        added = False
        for name, title, has_icon, rows, _lang in per_zim:
            if i < len(rows):
                added = True
                v = _card(rows[i])
                # The talk's id first (TED's own number, a YouTube id): two
                # TED builds carry talk 56901 with the speaker spelled two
                # ways, and title + speaker made that two cards.
                keys = [k for k in (
                    ("id", str(v.get("id") or "").strip()),
                    ("ts", str(v.get("title") or "").strip().lower(), str(v.get("speaker") or "").strip().lower()),
                ) if k[1]]
                first = next((seen[k] for k in keys if k in seen), None)
                if first is not None:
                    first.setdefault("also", []).append({"zim": name, "zim_title": title, "page": v.get("page")})
                    for k in keys:
                        seen.setdefault(k, first)
                    continue
                v["zim"] = name
                v["zim_title"] = title
                v["zim_icon"] = has_icon
                merged.append(v)
                for k in keys:
                    seen[k] = v
        if not added:
            break
        i += 1
    total = len(merged)
    return {
        "items": merged[offset : offset + limit],
        "total": total,
        "sources": len(per_zim),
        "zims": [{"name": n, "title": t, "icon": ic, "count": len(r), "language": lg} for n, t, ic, r, lg in per_zim],
    }


def _reset_for_tests(timeout=30):
    """Forget what was read, once any build a test started has finished."""
    end = time.time() + timeout
    while time.time() < end:
        with _queue_lock:
            if not _queued:
                break
        time.sleep(0.02)
    with _lock:
        _cache.clear()
        _base.clear()
        _details.clear()
