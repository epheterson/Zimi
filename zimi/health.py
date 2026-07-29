"""Library health report — an on-demand, per-ZIM integrity check.

Admin clicks "Check", the server walks every installed ZIM sequentially
(opening each under ``_srv._zim_lock`` since libzim is not thread-safe),
and reports: opens OK, has a main page, entry count, title-index and Q-ID
index status, size vs. the cached catalog, last-updated age, and a media
integrity sample (0-byte video/audio entries — broken/partial scrapes that
the count and size checks can't see). The known broken case
(``devdocs_en_react``: 0 entries / tiny file) surfaces as a warning row.

Runs on a daemon worker thread; the client polls ``get_state()`` — the same
progress-dict pattern as mirror sync.
"""

import logging
import os
import threading
import time

import zimi.server as _srv

log = logging.getLogger("zimi.health")

_lock = threading.Lock()
_state = {
    "phase": None,  # None | "running" | "done" | "error"
    "done": 0,
    "total": 0,
    "report": None,  # list[dict] once finished
    "summary": None,  # {"total","healthy","warnings"}
    "started_at": None,
    "finished_at": None,
}


def _set(**kw):
    _state.update(kw)


def get_state():
    """Copied snapshot for the poll endpoint (never the live dict)."""
    return dict(_state)


def _catalog_sizes():
    """basename -> catalog size_bytes, from the already-cached OPDS data only
    (no network). Empty dict when nothing is cached."""
    sizes = {}
    try:
        from zimi import library as _lib

        with _lib._opds_lock:
            snapshot = list(_lib._opds_cache.values())
        for _ts, _total, items in snapshot:
            for it in items or []:
                url = it.get("download_url") or ""
                name = os.path.basename(url.split("?")[0]) if url else ""
                sb = it.get("size_bytes")
                if name and sb:
                    sizes[name] = sb
    except Exception as e:
        log.debug("catalog sizes unavailable: %s", e)
    return sizes


def _stray_torrent_files():
    """Basenames of ``*.torrent`` companions sitting in ZIM_DIR. libtorrent
    (1.8+) keeps torrent metadata under ZIMI_DATA_DIR/bt/torrents, but the old
    aria2 downloader left ``<name>.zim.torrent`` next to the ZIM. These are
    bencoded metadata, not ZIMs — running zimcheck on one fails with "Invalid
    magic number", which looks like ZIM corruption but isn't (see #38). Surface
    them distinctly so the user knows they're leftover litter, safe to delete.
    Non-recursive listdir (never a recursive walk)."""
    out = []
    try:
        for fn in sorted(os.listdir(_srv.ZIM_DIR)):
            if fn.endswith(".torrent"):
                out.append(fn)
    except OSError:
        pass
    return out


def _age_days(entry, path):
    """Best-effort age of the ZIM in days, from updated_at/first_seen, then
    file mtime. Returns None when unknown."""
    for key in ("updated_at", "first_seen"):
        ts = entry.get(key)
        if ts:
            return max(0, int((time.time() - ts) / 86400))
    try:
        return max(0, int((time.time() - os.path.getmtime(path)) / 86400))
    except OSError:
        return None


# A media entry (video/audio) with zero bytes is always broken — a file that
# can't play — but neither the entry count nor the size-vs-catalog check sees it,
# because the count is unchanged and the missing bytes are a rounding error
# against a multi-GB ZIM. Partial breakage is the common shape: e.g.
# ted_en_technology_2023-09 ships 1184 real .webm videos alongside 26 zero-byte
# .mp4 placeholders, so browsing one of those 26 talks looks like an app bug
# (issue #38 follow-up). Sample media entries by extension and flag any empty.
_MEDIA_EXTS = (
    ".webm",
    ".mp4",
    ".m4v",
    ".mov",
    ".mkv",
    ".ogv",
    ".avi",  # video
    ".mp3",
    ".ogg",
    ".oga",
    ".m4a",
    ".opus",
    ".aac",
    ".flac",
    ".wav",
    ".weba",  # audio
)
# ZIMs up to this many entries get a full entry walk (a full walk of a
# 34k-entry video ZIM is ~0.2s, and video/audio ZIMs are rarely larger). Above
# it — almost always text corpora with little or no media — fall back to a
# strided sample so the walk stays bounded under the lock (a full walk of a
# 2.4M-entry Wikipedia is ~8s, far too slow to hold libzim's global lock).
_MEDIA_FULL_SCAN_MAX = 120_000
_MEDIA_STRIDED_PROBES = 2_000


def _all_entry_count(archive):
    """All-entries count (not just articles), the id space for
    ``_get_entry_by_id``. Prefers ``all_entry_count``, falls back."""
    for attr in ("all_entry_count", "entry_count"):
        try:
            n = getattr(archive, attr)
            if n:
                return int(n)
        except Exception:
            pass
    return 0


def _sample_media(archive):
    """Walk (or strided-sample) a ZIM for media files that carry no content.

    Returns ``{"sampled","empty","examples","full"}``: media entries examined,
    how many are 0-byte, up to 5 example paths, and whether the whole entry
    space was covered (``full``) or only sampled. ``None`` when the libzim build
    lacks id iteration or the ZIM is empty. Caller holds ``_zim_lock`` — libzim
    is single-threaded — so this stays a bounded, lock-friendly pass."""
    if not hasattr(archive, "_get_entry_by_id"):
        return None
    n = _all_entry_count(archive)
    if n <= 0:
        return None
    full = n <= _MEDIA_FULL_SCAN_MAX
    ids = range(n) if full else range(0, n, max(1, n // _MEDIA_STRIDED_PROBES))
    sampled = empty = 0
    examples = []
    for j in ids:
        try:
            e = archive._get_entry_by_id(j)
            if e.is_redirect or not e.path.lower().endswith(_MEDIA_EXTS):
                continue
            item = e.get_item()
            sampled += 1
            if item.size == 0 or (item.mimetype or "") == "application/x-empty":
                empty += 1
                if len(examples) < 5:
                    examples.append(e.path)
        except Exception:
            continue
    return {"sampled": sampled, "empty": empty, "examples": examples, "full": full}


# Universal article sanity: even a ZIM with no media can be a broken scrape
# (every article a 0-byte shell). A tiny strided probe for a few text/html
# entries confirms at least some carry content — cheap enough to run on every
# ZIM, unlike the exhaustive media walk. Metadata-only reads (size / mimetype),
# never the blob.
_TEXT_SAMPLE = 3  # html articles to size-check
_TEXT_PROBE_MAX = 60  # entries to probe to find them (bounded)


def _sample_text(archive):
    """Probe a bounded, strided set of entries for a few text/html articles and
    confirm they carry content. Returns ``{"sampled","empty"}`` (articles
    examined / of those, 0-byte); ``None`` when id iteration is unavailable or
    the ZIM is empty. Caller holds ``_zim_lock``."""
    if not hasattr(archive, "_get_entry_by_id"):
        return None
    n = _all_entry_count(archive)
    if n <= 0:
        return None
    step = max(1, n // _TEXT_PROBE_MAX)
    sampled = empty = 0
    for j in range(0, n, step):
        if sampled >= _TEXT_SAMPLE:
            break
        try:
            e = archive._get_entry_by_id(j)
            if e.is_redirect:
                continue
            item = e.get_item()
            if not (item.mimetype or "").startswith("text/html"):
                continue
            sampled += 1
            if item.size == 0 or (item.mimetype or "") == "application/x-empty":
                empty += 1
        except Exception:
            continue
    return {"sampled": sampled, "empty": empty}


def _check_one(entry, path, catalog_sizes):
    """Build a single ZIM's health row."""
    name = entry.get("name", "")
    row = {
        "name": name,
        "title": entry.get("title") or name,
        "opens": False,
        "has_main": False,
        "entries": None,
        "title_index": "absent",  # absent | current | stale
        "qid_index": "absent",  # absent | present
        "size_delta": None,  # installed - catalog bytes (None if no catalog)
        "age_days": _age_days(entry, path),
        "media_sampled": None,  # media entries examined (None = not checked)
        "media_empty": None,  # of those, how many are 0-byte
        "text_sampled": None,  # html articles examined (None = not checked)
        "text_empty": None,  # of those, how many are 0-byte
        "status": "warn",
        "issues": [],
    }

    # libzim open + main page — one ZIM at a time under the global read lock.
    media = None
    text = None
    try:
        with _srv._zim_lock:
            archive = _srv.open_archive(path)
            try:
                row["entries"] = archive.entry_count
                try:
                    me = archive.main_entry
                    if me.is_redirect:
                        me = me.get_redirect_entry()
                    row["has_main"] = bool(me.path)
                except Exception:
                    row["has_main"] = False
                row["opens"] = True
                try:
                    media = _sample_media(archive)
                except Exception as e:
                    log.debug("health: media sample failed for %s: %s", name, e)
                try:
                    text = _sample_text(archive)
                except Exception as e:
                    log.debug("health: text sample failed for %s: %s", name, e)
            finally:
                del archive
    except Exception as e:
        log.debug("health: open failed for %s: %s", name, e)
        row["issues"].append("does not open")

    if row["opens"] and not row["has_main"]:
        row["issues"].append("no main page")
    if row["opens"] and row["entries"] == 0:
        row["issues"].append("empty (0 entries)")
    if media and media["sampled"]:
        row["media_sampled"] = media["sampled"]
        row["media_empty"] = media["empty"]
        if media["examples"]:
            row["media_examples"] = media["examples"]
        if media["empty"]:
            # "sampled" qualifier when we only strided a huge ZIM — the true
            # empty count may be higher than what the sample saw.
            scope = "" if media["full"] else " in sample"
            row["issues"].append(
                f"{media['empty']} of {media['sampled']} media entries "
                f"empty / 0-byte{scope}"
            )
    if text and text["sampled"]:
        row["text_sampled"] = text["sampled"]
        row["text_empty"] = text["empty"]
        # Every sampled article empty is the fingerprint of a broken scrape even
        # when the ZIM carries no media (a media-empty flag would never fire).
        if text["empty"] == text["sampled"]:
            row["issues"].append(
                f"all {text['sampled']} sampled articles empty / 0-byte "
                f"— broken scrape?"
            )

    # Index status (sqlite reads — no libzim lock needed).
    try:
        from zimi import search as _search

        if _search._title_index_path(name) and os.path.exists(
            _search._title_index_path(name)
        ):
            row["title_index"] = (
                "current" if _search._title_index_is_current(name, path) else "stale"
            )
    except Exception as e:
        log.debug("health: title index check failed for %s: %s", name, e)
    try:
        from zimi import interlang as _interlang

        if _interlang._qid_has_index(name):
            row["qid_index"] = "present"
    except Exception as e:
        log.debug("health: qid index check failed for %s: %s", name, e)

    # Size vs catalog.
    cat = catalog_sizes.get(entry.get("file", ""))
    if cat:
        installed = entry.get("size_bytes")
        if installed:
            row["size_delta"] = installed - cat

    row["status"] = "warn" if row["issues"] else "ok"
    return row


def _run():
    try:
        zim_files = _srv.get_zim_files()
        by_name = {z.get("name"): z for z in (_srv.list_zims() or [])}
        catalog_sizes = _catalog_sizes()
        names = sorted(zim_files.keys())
        total = len(names)
        _set(phase="running", done=0, total=total, report=None, summary=None)
        report = []
        for i, name in enumerate(names):
            entry = by_name.get(name) or {"name": name}
            report.append(_check_one(entry, zim_files[name], catalog_sizes))
            _set(done=i + 1, total=total)
        healthy = sum(1 for r in report if r["status"] == "ok")
        warnings = total - healthy
        # Stray .torrent metadata companions (aria2-era leftovers) — flagged
        # distinctly as "not a ZIM", never counted as broken ZIMs (#38).
        strays = _stray_torrent_files()
        for fn in strays:
            report.append(
                {
                    "name": fn,
                    "title": fn,
                    "kind": "torrent_meta",
                    "opens": False,
                    "has_main": False,
                    "entries": None,
                    "title_index": "absent",
                    "qid_index": "absent",
                    "size_delta": None,
                    "age_days": None,
                    "status": "info",
                    "issues": ["torrent metadata, not a ZIM — safe to delete"],
                }
            )
        _set(
            phase="done",
            report=report,
            summary={
                "total": total,
                "healthy": healthy,
                "warnings": warnings,
                "torrent_files": len(strays),
            },
            finished_at=time.time(),
        )
    except Exception as e:
        log.error("health check failed: %s", e)
        _set(phase="error", report=None)
    finally:
        _lock.release()


def start_check():
    """Kick off a health check on a daemon worker thread. Returns
    ``(started, message)``; ``started`` is False when one is already running."""
    if not _lock.acquire(blocking=False):
        return False, "a health check is already running"
    _set(
        phase="running",
        done=0,
        total=0,
        report=None,
        summary=None,
        started_at=time.time(),
        finished_at=None,
    )
    threading.Thread(target=_run, daemon=True, name="library-health").start()
    return True, "started"
