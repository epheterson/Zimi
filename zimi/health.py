"""Library health report — an on-demand, per-ZIM integrity check.

Admin clicks "Check", the server walks every installed ZIM sequentially
(opening each under ``_srv._zim_lock`` since libzim is not thread-safe),
and reports: opens OK, has a main page, entry count, title-index and Q-ID
index status, size vs. the cached catalog, and last-updated age. The known
broken case (``devdocs_en_react``: 0 entries / tiny file) surfaces as a
warning row.

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
        "status": "warn",
        "issues": [],
    }

    # libzim open + main page — one ZIM at a time under the global read lock.
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
            finally:
                del archive
    except Exception as e:
        log.debug("health: open failed for %s: %s", name, e)
        row["issues"].append("does not open")

    if row["opens"] and not row["has_main"]:
        row["issues"].append("no main page")
    if row["opens"] and row["entries"] == 0:
        row["issues"].append("empty (0 entries)")

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
        _set(
            phase="done",
            report=report,
            summary={"total": total, "healthy": healthy, "warnings": warnings},
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
