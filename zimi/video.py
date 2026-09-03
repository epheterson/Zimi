"""Video playlists and channels → ZIM — `zimi create <video-platform URL>`.

Detection is yt-dlp's own extractor matching (never hand-rolled URL
regexes): a URL that a real extractor — anything but the catch-all
``generic`` one — claims is a video source. yt-dlp is a SOFT dependency:
import-guarded, with a clear install hint when the video path is wanted
but the module is absent. When yt-dlp is not installed, detection simply
says no and `zimi create <url>` falls through to single-page capture.

The unit is the PLAYLIST or CHANNEL: the ZIM gets an index page listing
every entry (inline thumbnail, duration, uploader) and one page per video
carrying the media file, the description, and any subtitles/auto-captions
as selectable ``<track>`` elements. A single-video URL still works and
just makes a one-entry ZIM. Media files stream into the ZIM through
libzim's FileProvider — a video is never read into memory.

Size discipline (Pi-class hardware serves these libraries, and ZIMs are
meant to be shared): ``--format`` defaults to a ~720p cap, ``--audio-only``
keeps just the sound, ``--limit N`` bounds the entry count, and
``--max-bytes`` (default 4 GiB) is a total budget — the build stops
cleanly at the first entry that would blow it and the index says exactly
what was skipped. Downloads land in a temp staging dir that is always
removed; the ZIM itself goes through the shared atomic tmp-then-rename
writer, so a partial ZIM never appears under its final name.
"""

import html as _html
import importlib
import logging
import mimetypes
import os
import re
import shutil
import sys
import tempfile

import zimi.server as _srv
from zimi.creator import (
    DEFAULT_LANGUAGE,
    LANGUAGE_AUTO,
    CreateError,
    _finish_output,
    _fmt_bytes,
    _try_register,
    _zim_file_item_class,
    language_tag_to_iso3,
)
from zimi.p2p import is_offline
from zimi.zimwriter import (
    _page_head,
    _plural,
    _slug,
    add_standard_metadata,
    atomic_zim_creator,
    history_record,
    media_tags,
    scraper_string,
    zim_name,
    zim_static_item_class,
)

log = logging.getLogger("zimi.video")

DEFAULT_MAX_ZIM_BYTES = 4 * 1024**3  # total budget: keep video ZIMs shareable
# Progressive-first ~720p: no merge step, so ffmpeg is never required.
DEFAULT_VIDEO_FORMAT = "best[height<=720][ext=mp4]/best[height<=720]/best"
DEFAULT_AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio/best"
SUBTITLE_MIME = "text/vtt"
# Per-socket ceiling for the metadata-only playlist read. Bounds the preview
# (and the build's first step) against a host that accepts a connection and
# then says nothing.
FLAT_PROBE_SOCKET_TIMEOUT = 15.0
INSTALL_HINT = (
    "yt-dlp is not installed — video capture needs it. "
    "Install it with: pip install yt-dlp"
)

_SUB_EXT = ".vtt"
_THUMB_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")
_PARTIAL_EXTS = (".part", ".ytdl", ".temp")  # yt-dlp scratch, never content
_MEDIA_MIME_FALLBACK = {
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".m4v": "video/mp4",
    ".opus": "audio/ogg",
    ".oga": "audio/ogg",
    ".weba": "audio/webm",
}

_INDEX_CSS = (
    ".zimi-vid{display:flex;gap:12px;margin:12px 0;align-items:flex-start}"
    ".zimi-vid img{width:160px;max-width:35%;border-radius:6px}"
    ".zimi-vid-meta{color:#888;font-size:.9em}"
    "video,audio{width:100%;max-width:840px}"
)


# ── yt-dlp access (soft dependency) ─────────────────────────────────────────


def _yt_dlp():
    """The yt_dlp module, or None when not installed."""
    try:
        return importlib.import_module("yt_dlp")
    except ImportError:
        return None


def video_available():
    """True when a video capture can actually run here.

    The other three engines each answer this question for themselves
    (``_create_import_ready``, ``_create_browser_ready``,
    ``_create_alive_ready``) and video did not, so the Create page offered a
    Video mode on an image with no yt-dlp in it — a form that lies, which is
    the same shape as the Pillow bug before it. See the parity test in
    tests/test_create_routes.py: every mode Zimi offers must be able to say
    whether it can run."""
    return _yt_dlp() is not None


def yt_dlp_version(mod):
    """The version yt-dlp reports for itself, or None when it reports none.
    Provenance records name the tool that did the work, and yt-dlp's release
    is dated enough that "which one" is a real question a year later."""
    version = getattr(getattr(mod, "version", None), "__version__", None) or getattr(
        mod, "__version__", None
    )
    return str(version) if version else None


def claims_url(url):
    """True when a REAL yt-dlp extractor (anything but the catch-all
    ``generic``) recognizes the URL. False when yt-dlp is absent — the
    caller falls through to single-page capture."""
    if _yt_dlp() is None:
        return False
    try:
        extractor = importlib.import_module("yt_dlp.extractor")
        classes = extractor.gen_extractor_classes()
    except Exception:
        return False
    for ie in classes:
        try:
            if not ie.suitable(url):
                continue
        except Exception:
            continue
        if str(getattr(ie, "IE_NAME", "")).lower() != "generic":
            return True
    return False


_VIDEO_FLAG_NAMES = ("format", "audio_only", "limit")


def wants_url(url, args):
    """Route decision for `zimi create <url>`: any video-only flag forces
    the video path (so a missing yt-dlp yields the install hint instead of
    a confusing page-capture failure); otherwise ask yt-dlp's extractors.
    Explicit crawl intent (--site, --engine) always wins over extractor
    matching, and --max-bytes signals nothing by itself — the site crawl
    shares it."""
    if getattr(args, "site", False) or getattr(args, "engine", "builtin") != "builtin":
        return False
    if any(getattr(args, n, None) for n in _VIDEO_FLAG_NAMES):
        return True
    return claims_url(url)


# ── small helpers ───────────────────────────────────────────────────────────

_SIZE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(i?)b?\s*$", re.IGNORECASE)


def parse_size(text):
    """'4G' / '500M' / '123' → bytes. CreateError on anything else.

    Decimal unless the spelling says otherwise: 500M is 500,000,000 and 500MiB
    is 524,288,000. Same rule as the crawler's parse_size and as every size
    Zimi prints, so a budget and the file it produces are quoted in one unit."""
    m = _SIZE_RE.match(str(text))
    if not m:
        raise CreateError(f"cannot parse size {text!r} — try e.g. 500M or 4G")
    base = 1024 if m.group(3) else 1000
    mult = {"": 1, "k": base, "m": base**2, "g": base**3, "t": base**4}
    return int(float(m.group(1)) * mult[m.group(2).lower()])


def _fmt_duration(seconds):
    try:
        s = int(seconds)
    except (TypeError, ValueError):
        return ""
    if s < 0:
        return ""
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _fmt_date(yyyymmdd):
    s = str(yyyymmdd or "")
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return ""


def _media_mime(path):
    ext = os.path.splitext(path)[1].lower()
    return (
        mimetypes.guess_type(path)[0]
        or _MEDIA_MIME_FALLBACK.get(ext)
        or "application/octet-stream"
    )


def _desc_html(text):
    if not text:
        return ""
    paras = [p for p in re.split(r"\n{2,}", str(text).strip()) if p.strip()]
    return "".join(
        "<p>" + _html.escape(p).replace("\n", "<br>") + "</p>" for p in paras
    )


def _meta_line(*bits):
    return " · ".join(b for b in bits if b)


def _unique_id(base, used):
    vid = base
    n = 2
    while vid in used:
        vid = f"{base}_{n}"
        n += 1
    used.add(vid)
    return vid


# ── yt-dlp orchestration ────────────────────────────────────────────────────


def _flat_entries(mod, url, limit):
    """Cheap flat probe: the playlist head plus its entry list (no media).
    A non-playlist URL comes back as a single-entry list.

    ``socket_timeout`` is not optional politeness. This is the one network call
    the pre-flight preview makes, and a preview that can hang forever on an
    unresponsive host is not bounded — it is just a slow job wearing a
    preview's name. yt-dlp's own default here is "wait", so the bound has to be
    stated. It applies to the real build too, which wants it for the same
    reason on a Pi."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "socket_timeout": FLAT_PROBE_SOCKET_TIMEOUT,
    }
    if limit:
        opts["playlistend"] = limit
    with mod.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise CreateError(f"yt-dlp could not read {url}")
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
    else:
        entries = [info]
    if limit:
        entries = entries[:limit]
    if not entries:
        raise CreateError("the playlist is empty — nothing to package")
    return info, entries


def _subtitle_langs(language):
    """The caption languages worth asking for: English, and the language the
    person asked the ZIM to be in. yt-dlp reads each entry as a pattern, so
    ``en.*`` takes en, en-US and en-orig alike.

    This used to be ``["all"]``, which on YouTube means auto-captions in a
    hundred-odd languages, one request each, per video. The site answered the
    Abkhazian one with 429 and the whole capture ended five seconds in."""
    langs = ["en.*"]
    if language and language != LANGUAGE_AUTO:
        code = str(language).strip().lower()
        if code and not code.startswith("en"):
            langs.append(code + ".*")
    return langs


def _download_entry(mod, entry, workdir, *, fmt, audio_only, language=None):
    """Download one entry (media + subtitles + thumbnail) into its own
    workdir. Returns the full per-video info dict.

    Captions are decoration on a video, never a condition of having it: a
    refusal that names subtitles is retried once without them."""
    url = entry.get("url") or entry.get("webpage_url") or entry.get("original_url")
    if not url:
        raise CreateError("yt-dlp returned a playlist entry with no URL")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": fmt,
        "outtmpl": os.path.join(workdir, "%(id)s.%(ext)s"),
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "vtt",
        "subtitleslangs": _subtitle_langs(language),
        "writethumbnail": not audio_only,
    }
    try:
        try:
            with mod.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except Exception as e:
            if "subtitle" not in str(e).lower():
                raise
            log.info(
                "captions refused for %s (%s) — carrying the video without them", url, e
            )
            opts.update(writesubtitles=False, writeautomaticsub=False)
            with mod.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
    except Exception as e:
        # yt-dlp raises DownloadError for everything a video site can do to
        # refuse: a 403 on the media stream, an age gate, a geo block, a video
        # taken down between the probe and the download. Unwrapped, it reached
        # the person as forty lines of Python traceback ending in a URL — which
        # is not a failure anybody can act on, and is exactly what every other
        # refusal in this module already avoids.
        log.exception("video download failed for %s", url)
        raise CreateError(_download_refusal(e, url))
    if not info:
        raise CreateError(f"yt-dlp could not download {url}")
    return info


# What a video site's refusal looks like in yt-dlp's message, and what a person
# can do about it. Ordered: the first match wins, so put the specific before
# the general.
_DOWNLOAD_REFUSALS = (
    (
        "403",
        "the site refused the download (HTTP 403). Sites throttle "
        "automated downloads; trying again later, or from a different "
        "network, often works",
    ),
    (
        "sign in",
        "the site wants an account for this video, and Zimi does not "
        "sign in on your behalf",
    ),
    (
        "age",
        "the video is age-restricted and the site will not serve it "
        "without an account",
    ),
    ("private", "the video is private"),
    ("unavailable", "the site says the video is unavailable"),
    # yt-dlp's real geo wording is "has not made this video available in your
    # country" — the word "geo" appears nowhere in it, which is why these
    # needles are taken from actual messages rather than from the category name.
    ("your country", "the video is blocked in this location"),
    ("geo", "the video is blocked in this location"),
    ("copyright", "the site removed the video"),
)


def _download_refusal(exc, url):
    """One sentence naming what the site did, or a plain fallback.

    Never the traceback and never str(exc) whole: yt-dlp's message carries its
    own formatting codes, the offending URL, and a request to report a bug to
    yt-dlp, none of which belong in front of the person who asked for a video."""
    text = str(exc or "").lower()
    for needle, explanation in _DOWNLOAD_REFUSALS:
        if needle in text:
            return f"could not download {url} — {explanation}."
    return (
        f"could not download {url} — the site refused it. The server log has "
        f"what yt-dlp reported."
    )


def _collect_downloads(workdir, info):
    """``(media_path, [(lang, sub_path)], thumb_path)`` from an entry's
    workdir. Media comes from yt-dlp's reported filepath when present, else
    the one non-subtitle non-thumbnail file in the dir."""
    media = None
    for d in info.get("requested_downloads") or []:
        fp = d.get("filepath")
        if fp and os.path.exists(fp):
            media = fp
            break
    subs = []
    thumb = None
    vid = str(info.get("id") or "")
    for fn in sorted(os.listdir(workdir)):
        path = os.path.join(workdir, fn)
        low = fn.lower()
        if low.endswith(_PARTIAL_EXTS):
            continue
        if low.endswith(_SUB_EXT):
            stem = fn[: -len(_SUB_EXT)]
            lang = stem[len(vid) + 1 :] if vid and stem.startswith(vid + ".") else ""
            subs.append((lang or "und", path))
        elif low.endswith(_THUMB_EXTS):
            thumb = thumb or path
        elif media is None:
            media = path
    if media is None:
        raise CreateError(
            f"download produced no media file for {info.get('title') or vid}"
        )
    return media, subs, thumb


# ── page rendering ──────────────────────────────────────────────────────────


def _video_page_html(v, *, audio_only):
    """One video's article: media element (+ subtitle tracks), metadata
    line, description. Paths are relative to ``videos/<id>``."""
    title = _html.escape(v["title"])
    meta = _meta_line(
        _html.escape(v["uploader"]), _fmt_duration(v["duration"]), _fmt_date(v["date"])
    )
    media_ref = "../" + v["media_path"]
    if audio_only:
        media_el = f"<audio controls preload='metadata' src='{media_ref}'></audio>"
        if v["subs"]:
            links = " · ".join(
                f"<a href='../{_html.escape(sp)}'>{_html.escape(lang)}</a>"
                for lang, sp in v["subs"]
            )
            media_el += f"<p>Transcript: {links}</p>"
    else:
        tracks = "".join(
            f"<track kind='subtitles' src='../{_html.escape(sp)}' "
            f"srclang='{_html.escape(lang)}' label='{_html.escape(lang)}'>"
            for lang, sp in v["subs"]
        )
        media_el = (
            f"<video controls preload='metadata'>"
            f"<source src='{media_ref}' type='{v['media_mime']}'>{tracks}"
            "</video>"
        )
    body = [
        "<header class='zimi-src'><a href='../index'>&#8592; Index</a></header>",
        f"<h1>{title}</h1>",
    ]
    if meta:
        body.append(f"<p class='zimi-vid-meta'>{meta}</p>")
    body.append(media_el)
    body.append(_desc_html(v["description"]))
    if v["url"]:
        body.append(f"<p><a href='{_html.escape(v['url'])}'>Watch online</a></p>")
    return (
        _page_head(title, _INDEX_CSS)
        + "<body><main>"
        + "".join(body)
        + "</main></body></html>"
    ).encode("utf-8")


def _index_html(title, subtitle, rows, skipped, max_bytes):
    """The main page: every packaged video with inline thumbnail, duration
    and uploader — plus an honest section naming anything the size budget
    kept out."""
    body = [f"<h1>{_html.escape(title)}</h1>"]
    if subtitle:
        body.append(f"<p style='color:#666'>{_html.escape(subtitle)}</p>")
    body.append("<ol class='zimi-index'>")
    for r in rows:
        page = _html.escape(r["page"])
        cell = ""
        if r["thumb"]:
            cell = (
                f"<a href='{page}'><img src='{_html.escape(r['thumb'])}' " "alt=''></a>"
            )
        meta = _meta_line(
            _html.escape(r["uploader"]),
            _fmt_duration(r["duration"]),
            _fmt_date(r["date"]),
        )
        body.append(
            f"<li class='zimi-vid'>{cell}<div>"
            f"<a href='{page}'>{_html.escape(r['title'])}</a>"
            + (f"<br><span class='zimi-vid-meta'>{meta}</span>" if meta else "")
            + "</div></li>"
        )
    body.append("</ol>")
    if skipped:
        body.append("<h2 class='zimi-section'>Not included</h2>")
        body.append(
            f"<p>{_plural(len(skipped), 'video')} skipped to stay under the "
            f"{_fmt_bytes(max_bytes)} size budget (--max-bytes):</p>"
        )
        body.append("<ol class='zimi-index'>")
        body.extend(f"<li>{_html.escape(s)}</li>" for s in skipped)
        body.append("</ol>")
    return (
        _page_head(_html.escape(title), _INDEX_CSS)
        + "<body>"
        + "".join(body)
        + "</body></html>"
    ).encode("utf-8")


# ── the pre-flight probe ────────────────────────────────────────────────────

# What the preview reads and shows. The flat probe downloads NO media — it is
# the same metadata call the real build already makes first — so the cap here
# is about the size of the answer, not about the cost of getting it.
PROBE_MAX_ENTRIES = 500
PROBE_SAMPLE = 6


def probe_video(url, limit=None):
    """Read a playlist/channel without downloading a byte of it: how many
    entries, how long in total, and the first few titles.

    This is yt-dlp's flat extraction — exactly what ``create_video_zim`` runs
    before it starts downloading — so the preview tells the truth about what
    the real job would find, and costs one metadata request to say it."""
    mod = _yt_dlp()
    if mod is None:
        raise CreateError(INSTALL_HINT)
    if is_offline():
        raise CreateError("ZIMI_OFFLINE is set — refusing to fetch from the network.")
    head, entries = _flat_entries(
        mod, url, min(limit or PROBE_MAX_ENTRIES, PROBE_MAX_ENTRIES)
    )
    total = 0
    known = 0
    sample = []
    for entry in entries:
        seconds = entry.get("duration")
        if isinstance(seconds, (int, float)) and seconds > 0:
            total += int(seconds)
            known += 1
        if len(sample) < PROBE_SAMPLE:
            sample.append(
                {
                    "title": str(entry.get("title") or entry.get("id") or "video"),
                    "duration": _fmt_duration(seconds),
                }
            )
    return {
        "url": url,
        "title": str(head.get("title") or entries[0].get("title") or "Videos"),
        "uploader": str(head.get("uploader") or head.get("channel") or ""),
        "playlist": head.get("_type") == "playlist",
        "entries": len(entries),
        # Durations come back per entry and sometimes missing; say how many of
        # them the total actually covers rather than presenting a short total
        # as if it were complete.
        "duration": _fmt_duration(total) if total else "",
        "duration_known": known,
        "sample": sample,
    }


# ── the build ───────────────────────────────────────────────────────────────


def _video_language(requested, videos):
    """The language for a video ZIM, as ``(code, how)``.

    yt-dlp reports a ``language`` per entry when the platform knows one; that
    is the only honest signal here, so auto uses it and nothing else. A
    playlist that declares nothing is English by default, exactly as before —
    guessing a language from a filename would be worse than saying so."""
    from zimi.creator import requested_language

    named = requested_language(requested)
    if named:
        return named, "requested"
    codes = []
    for v in videos:
        code = language_tag_to_iso3((v.get("info") or {}).get("language"))
        if code:
            codes.append(code)
    if not codes:
        return DEFAULT_LANGUAGE, "fallback"
    return max(set(codes), key=lambda c: (codes.count(c), -codes.index(c))), "media"


def create_video_zim(
    url,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    fmt=None,
    audio_only=False,
    limit=None,
    max_bytes=DEFAULT_MAX_ZIM_BYTES,
    register=False,
    work_dir=None,
    progress=None,
):
    """Build one ZIM from a playlist/channel (or single-video) URL. Returns
    ``{"path", "videos", "skipped", "bytes", "main", "registered", "url"}``;
    raises CreateError for anything the user must fix (yt-dlp missing,
    offline mode, empty playlist, nothing under budget)."""
    mod = _yt_dlp()
    if mod is None:
        raise CreateError(INSTALL_HINT)
    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Video capture downloads media; it cannot run offline."
        )
    if max_bytes <= 0:
        raise CreateError("--max-bytes must be positive")
    say = progress or (lambda _msg: None)
    fmt = fmt or (DEFAULT_AUDIO_FORMAT if audio_only else DEFAULT_VIDEO_FORMAT)

    head, entries = _flat_entries(mod, url, limit)
    zim_title = title or head.get("title") or "Videos"
    head_uploader = head.get("uploader") or head.get("channel") or ""

    staging = tempfile.mkdtemp(prefix="zimi-video-", dir=work_dir)
    videos = []  # per-entry dicts carrying downloaded file paths
    skipped = []  # titles the budget kept out
    used = 0
    budget_hit = False
    try:
        for i, entry in enumerate(entries, 1):
            label = str(entry.get("title") or entry.get("id") or f"video {i}")
            if budget_hit or used >= max_bytes:
                budget_hit = True
                skipped.append(label)
                continue
            say(f"[{i}/{len(entries)}] {label}")
            workdir = os.path.join(staging, str(i))
            os.makedirs(workdir)
            info = _download_entry(
                mod, entry, workdir, fmt=fmt, audio_only=audio_only, language=language
            )
            media, subs, thumb = _collect_downloads(workdir, info)
            size = (
                os.path.getsize(media)
                + sum(os.path.getsize(p) for _lang, p in subs)
                + (os.path.getsize(thumb) if thumb else 0)
            )
            # The first video always ships (a one-entry ZIM beats an empty
            # one); after that, the first entry over budget stops the build.
            if videos and used + size > max_bytes:
                budget_hit = True
                skipped.append(str(info.get("title") or label))
                continue
            used += size
            videos.append(
                {
                    "info": info,
                    "media": media,
                    "sub_files": subs,
                    "thumb": thumb,
                }
            )
        if not videos:
            raise CreateError("nothing fit under the size budget — raise --max-bytes")

        language, language_source = _video_language(language, videos)
        if language_source != "requested":
            say(f"content language: {language} (from the media metadata)")
        out = _finish_output(
            out_dir or _srv.ZIM_DIR, out_path, _slug(zim_title, "videos")
        )
        static_cls = zim_static_item_class()
        file_cls = _zim_file_item_class()
        used_ids = set()
        rows = []
        media_mimes = set()  # evidence for the _pictures:/_videos: tags
        with atomic_zim_creator(out, language) as creator:
            for v in videos:
                info = v["info"]
                v_title = str(info.get("title") or info.get("id") or "video")
                vid = _unique_id(
                    _slug(str(info.get("id") or v_title), "video"), used_ids
                )
                ext = os.path.splitext(v["media"])[1].lower()
                media_path = f"media/{vid}{ext}"
                media_mime = _media_mime(v["media"])
                media_mimes.add(media_mime)
                # Streams from disk via FileProvider — never into memory.
                creator.add_item(file_cls(media_path, v_title, v["media"], media_mime))
                sub_paths = []
                for lang, spath in v["sub_files"]:
                    sp = f"subs/{vid}.{_slug(lang, 'und')}.vtt"
                    with open(spath, "rb") as f:
                        creator.add_item(
                            static_cls(
                                sp,
                                f"{v_title} ({lang})",
                                f.read(),
                                mimetype=SUBTITLE_MIME,
                                front=False,
                            )
                        )
                    sub_paths.append((lang, sp))
                thumb_path = None
                if v["thumb"]:
                    thumb_path = (
                        f"thumbs/{vid}{os.path.splitext(v['thumb'])[1].lower()}"
                    )
                    thumb_mime = _media_mime(v["thumb"])
                    media_mimes.add(thumb_mime)
                    with open(v["thumb"], "rb") as f:
                        creator.add_item(
                            static_cls(
                                thumb_path,
                                v_title,
                                f.read(),
                                mimetype=thumb_mime,
                                front=False,
                            )
                        )
                page_path = f"videos/{vid}"
                page = _video_page_html(
                    {
                        "title": v_title,
                        "uploader": str(
                            info.get("uploader") or info.get("channel") or ""
                        ),
                        "duration": info.get("duration"),
                        "date": info.get("upload_date"),
                        "description": info.get("description"),
                        "url": str(info.get("webpage_url") or ""),
                        "media_path": media_path,
                        "media_mime": media_mime,
                        "subs": sub_paths,
                    },
                    audio_only=audio_only,
                )
                creator.add_item(static_cls(page_path, v_title, page))
                rows.append(
                    {
                        "page": page_path,
                        "thumb": thumb_path,
                        "title": v_title,
                        "uploader": str(
                            info.get("uploader") or info.get("channel") or ""
                        ),
                        "duration": info.get("duration"),
                        "date": info.get("upload_date"),
                    }
                )
            subtitle = _meta_line(
                head_uploader,
                _plural(len(rows), "video"),
                f"{_fmt_bytes(used)} of media",
                "audio only" if audio_only else "",
            )
            creator.add_item(
                static_cls(
                    "index",
                    zim_title,
                    _index_html(zim_title, subtitle, rows, skipped, max_bytes),
                )
            )
            creator.set_mainpath("index")
            tool_version = yt_dlp_version(mod)
            add_standard_metadata(
                creator,
                title=zim_title,
                description=description
                or _meta_line(
                    f"{_plural(len(rows), 'video')} packaged by Zimi",
                    head_uploader,
                ),
                language=language,
                creator_name=creator_name,
                source=url,
                # The playlist/channel URL itself: re-running it next month is
                # a new edition of this ZIM.
                name=zim_name(url, language),
                tags=media_tags(media_mimes),
                # An audio-only build of a playlist is a genuinely different
                # edition of the same source — exactly what Flavour is for.
                flavour="audio" if audio_only else None,
                scraper=scraper_string("yt-dlp", tool_version),
                history=history_record(
                    "created",
                    "video",
                    f"downloaded {_plural(len(rows), 'video')} from {url}"
                    + (" (audio only)" if audio_only else ""),
                    tools={"yt-dlp": tool_version},
                    counts={"videos": len(rows), "bytes": used},
                ),
            )
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    registered = _try_register(out) if register else False
    return {
        "path": out,
        "videos": len(videos),
        "skipped": len(skipped),
        "bytes": used,
        "main": "index",
        "registered": registered,
        "url": url,
        "language": language,
        "language_source": language_source,
    }


# ── CLI ─────────────────────────────────────────────────────────────────────


def forced_by_flags(args):
    """True when the user explicitly asked for the video path with a video-only
    flag, rather than it being auto-detected from the URL. A forced video that
    fails is a real error; an auto-detected one falls back to page capture."""
    return any(getattr(args, n, None) for n in _VIDEO_FLAG_NAMES)


def build_video(args):
    """Run `zimi create`'s video capture and return the info dict. Raises —
    CreateError for a user-fixable cause, or a yt-dlp/network error when the URL
    turned out not to be a video. Printing and exit live in the CLI wrappers so
    ``creator.cli_create`` can catch a failed auto-detection and fall back to
    page capture."""
    max_bytes = parse_size(args.max_bytes) if args.max_bytes else DEFAULT_MAX_ZIM_BYTES
    return create_video_zim(
        args.source,
        title=args.title,
        description=args.description,
        language=args.language,
        creator_name=args.creator,
        out_path=args.out,
        fmt=args.format,
        audio_only=bool(args.audio_only),
        limit=args.limit,
        max_bytes=max_bytes,
        register=not args.out,
        progress=lambda msg: print(f"  {msg}"),
    )


def print_video_summary(info, args):
    """The `zimi create` video-arm success summary."""
    print(f"ZIM written: {info['path']}")
    line = f"  {_plural(info['videos'], 'video')}, {_fmt_bytes(info['bytes'])} of media"
    if info["skipped"]:
        line += f"; {_plural(info['skipped'], 'video')} skipped (size budget)"
    print(line)
    if info["registered"]:
        print("  registered in the library — no rescan needed")
    elif not args.out:
        print(
            "  note: library registration failed; the file is in place and "
            "will appear on the next library scan"
        )


def cli_create_video(args):
    """The video arm of `zimi create` — reached from ``creator.cli_create``
    when yt-dlp claims the URL (or a video flag forces the route). Same
    exit-2 convention as the rest of the create CLI."""
    try:
        info = build_video(args)
    except CreateError as e:
        print(f"zimi: {e}", file=sys.stderr)
        sys.exit(2)
    print_video_summary(info, args)
