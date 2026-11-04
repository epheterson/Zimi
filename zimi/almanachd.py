"""Almanac HD: the Almanac's sharp Earth and Moon, one ZIM fetched once.

The Almanac ships with one small map per body and works with nothing more.
Almanac HD is those maps as tile pyramids (scripts/build_almanac_hd.py), far
too large for the package, so it is attached to a release and fetched the way
any ZIM is: through the download queue (library.py), into the library, where
it is served at /w/zimi_almanac_hd/... and the 3D view (almanac-earth.js)
draws from it.

Eric, 2026-11-03: "HD can download once on first use of almanac or
something?" Whether it may is an Ask first / Automatically / Never setting
like every other fetch (outbound.py), Ask first by default: the Almanac offers
it, with its size, to someone who may download, and Automatically fetches it
the first time the Almanac asks. ZIMI_OFFLINE is Never.

``zimi/assets/almanac-hd.json`` names the release file (written by the build
script when a new one is made): ``{"file", "size", "sha256", "tag"}``.
"""

import json
import logging
import os

from zimi import outbound
from zimi.safety import loggable

log = logging.getLogger("zimi")

NAME = "zimi_almanac_hd"
ENV = "ZIMI_ALMANAC_HD"
PREFS_KEY = "almanac_hd"
ASSET = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "almanac-hd.json"
)
RELEASE_URL = "https://github.com/epheterson/Zimi/releases/download/{tag}/{file}"
#: Where the queue says a download came from: also what keeps it out of
#: NOMAD's library (library._enqueue_zim_download hands only catalog ones over).
SOURCE = "almanac_hd"

POLICY = outbound.FetchPolicy(ENV, PREFS_KEY, outbound.ASK, "Almanac HD")


def release():
    """The release file this version of Zimi fetches, or None when none is named."""
    try:
        with open(ASSET, encoding="utf-8") as f:
            rel = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(rel, dict) or not all(
        isinstance(rel.get(k), str) and rel.get(k) for k in ("file", "tag")
    ):
        return None
    if not isinstance(rel.get("size"), int):
        return None
    return rel


def url(rel):
    return RELEASE_URL.format(tag=rel["tag"], file=rel["file"])


def installed():
    from zimi import server as _srv

    return NAME in _srv.get_zim_files()


def _downloading(rel):
    """The queue's record for the file, active or waiting, or None."""
    from zimi import library

    with library._download_lock:
        recs = list(library._active_downloads.values()) + list(library._download_queue)
    return next(
        (d for d in recs if d.get("filename") == rel["file"] and not d.get("error")),
        None,
    )


def status():
    """What the Almanac shows: ``installed``; ``offer`` (the file this version
    fetches, and its size) while it is not; the setting; the download under way."""
    mode, locked = POLICY.mode()
    rel = release()
    have = installed()
    out = {
        "installed": have,
        "mode": mode,
        "locked": locked,
        "offer": None,
        "downloading": None,
    }
    if have or not rel:
        return out
    out["offer"] = {"file": rel["file"], "size": rel["size"]}
    dl = _downloading(rel)
    if dl:
        done = dl.get("downloaded_bytes") or 0
        out["downloading"] = {
            "id": dl.get("id"),
            "done": done,
            "size": dl.get("size_bytes") or rel["size"],
        }
    return out


def start(actor=None):
    """Queue the download. ``(download id, error)``: error is "never" (the
    setting, or ZIMI_OFFLINE), "installed", or "unavailable" (no file named
    for this version)."""
    if POLICY.mode()[0] == outbound.NEVER:
        return None, "never"
    if installed():
        return None, "installed"
    rel = release()
    if not rel:
        return None, "unavailable"
    dl = _downloading(rel)
    if dl:
        return dl.get("id"), None
    from zimi import library

    link = url(rel)
    log.info("Almanac HD: fetching %s", loggable(rel["file"]))
    return library._enqueue_zim_download(
        link,
        [link],
        rel["file"],
        size_bytes=rel["size"],
        extra={"_source": SOURCE, "_activity": {"actor": actor}},
    )


def on_almanac_open():
    """The Almanac asked: under Automatically, the first ask fetches it."""
    st = status()
    if st["mode"] == outbound.AUTO and st["offer"] and not st["downloading"]:
        start(None)
        st = status()
    return st
