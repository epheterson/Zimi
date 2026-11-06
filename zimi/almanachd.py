"""Almanac HD: the Almanac's sharp Earth, Moon and planets, one ZIM fetched once.

The Almanac ships with one small map per body and works with nothing more. Almanac HD is those maps as tile
pyramids, far too large for the package. It is the HD flavour of the Almanac itself: ``zimi_almanac_maxi_<month>.zim``
(Flavour ``maxi``, the same Name as the Almanac in the package), the whole Almanac with the tiles inside under
``hd/`` (scripts/build_almanac_maxi.py). Opened alone in Kiwix it is the full Almanac with sharp tiles; in Zimi it is
fetched the way any ZIM is, through the download queue (library.py), into the library, where the 3D view
(almanac-earth.js) draws from ``/w/zimi_almanac_maxi/hd/``. A data pack (server.DATA_PACKS): the library shows one
Almanac, the package's, with HD present.

Every release builds that file and attaches it with a small manifest, ``zimi_almanac_maxi.json``
(``{"file", "size", "sha256", "tag"}``). Zimi reads the manifest of its own version's release (``v<version>``) to
know what to offer, so a build with no release (a dev build) offers nothing. 1.15.3 shipped the tiles alone as
``zimi_almanac_hd``; whoever has that file keeps their tiles (``LEGACY_NAME``) and is not asked again.

Eric, 2026-11-03: "HD can download once on first use of almanac or something?" Whether it may is an Ask first /
Automatically / Never setting like every other fetch (outbound.py), Ask first by default: the Almanac offers it, with
its size, to someone who may download, and Automatically fetches it the first time the Almanac asks. ZIMI_OFFLINE is
Never. Reading the manifest is part of that setting: under Never nothing is read.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.request

from zimi import outbound
from zimi.safety import loggable

log = logging.getLogger("zimi")

NAME = "zimi_almanac_maxi"
#: The tiles-only ZIM 1.15.3 offered: read from where it is, preferred less than NAME.
LEGACY_NAME = "zimi_almanac_hd"
ENV = "ZIMI_ALMANAC_HD"
PREFS_KEY = "almanac_hd"
MANIFEST = "zimi_almanac_maxi.json"
RELEASE_URL = "https://github.com/epheterson/Zimi/releases/download/{tag}/{file}"
#: What a manifest may name: the flavour's file, nothing else (it becomes a path and a URL).
_FILE_RE = re.compile(r"^zimi_almanac_maxi_\d{4}-\d{2}[a-z]?\.zim$")
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_TIMEOUT_S = 10
MANIFEST_MAX_BYTES = 4096
#: A manifest that could not be read (no such release, no network) is looked for again after this long.
MANIFEST_RETRY_S = 6 * 3600
#: Where the queue says a download came from: also what keeps it out of
#: NOMAD's library (library._enqueue_zim_download hands only catalog ones over).
SOURCE = "almanac_hd"

POLICY = outbound.FetchPolicy(ENV, PREFS_KEY, outbound.ASK, "Almanac HD")

_manifest = {"rel": None, "tried": 0.0, "busy": False}
_manifest_lock = threading.Lock()


def _version():
    from zimi import server as _srv

    return _srv.ZIMI_VERSION


def manifest_url(version=None):
    """Where the running version's release keeps its manifest."""
    return RELEASE_URL.format(tag="v" + (version or _version()), file=MANIFEST)


def parse_manifest(raw, version=None):
    """The manifest as ``{"file", "size", "sha256", "tag"}`` when it is a good one for this version's release, else None."""
    try:
        rel = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(rel, dict):
        return None
    ok = (
        isinstance(rel.get("file"), str)
        and _FILE_RE.match(rel["file"])
        and isinstance(rel.get("size"), int)
        and not isinstance(rel["size"], bool)
        and rel["size"] > 0
        and isinstance(rel.get("sha256"), str)
        and _SHA_RE.match(rel["sha256"])
        and rel.get("tag") == "v" + (version or _version())
    )
    return {k: rel[k] for k in ("file", "size", "sha256", "tag")} if ok else None


def _read_manifest():
    """Read the manifest in the background; a good one is kept, and under Automatically starts the download."""
    rel = None
    try:
        from zimi import server as _srv
        from zimi.library import USER_AGENT

        req = urllib.request.Request(manifest_url(), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(
            req, timeout=MANIFEST_TIMEOUT_S, context=_srv.SSL_CTX
        ) as resp:
            raw = resp.read(MANIFEST_MAX_BYTES + 1)
        rel = (
            parse_manifest(raw.decode("utf-8", "replace"))
            if len(raw) <= MANIFEST_MAX_BYTES
            else None
        )
    except Exception as e:  # no release for this version, no network: no offer
        log.info("Almanac HD: no manifest (%s)", loggable(type(e).__name__))
    with _manifest_lock:
        _manifest.update(rel=rel, tried=time.time(), busy=False)
    if rel and POLICY.mode()[0] == outbound.AUTO and not installed():
        start(None)


def release():
    """The file this version of Zimi fetches, or None: no manifest on its release (a dev build), not read yet, or the
    setting is Never. The first call starts reading the manifest (nobody waits for it); the next sees it.
    """
    if POLICY.mode()[0] == outbound.NEVER:
        return None
    with _manifest_lock:
        if _manifest["rel"]:
            return _manifest["rel"]
        if _manifest["busy"] or time.time() - _manifest["tried"] < MANIFEST_RETRY_S:
            return None
        _manifest["busy"] = True
    threading.Thread(
        target=_read_manifest, name="almanac-hd-manifest", daemon=True
    ).start()
    return None


def url(rel):
    return RELEASE_URL.format(tag=rel["tag"], file=rel["file"])


def present():
    """The name the server has the tiles under (the flavour, else 1.15.3's tile ZIM), or None. Whoever is asking: the
    library as the server sees it, never the asking person's allowed part of it (a person who may not see it would
    otherwise fetch it again on every visit)."""
    from zimi import server as _srv

    _srv.get_zim_files()  # the startup scan, if it has not run
    have = _srv._zim_files_cache or {}
    return next((n for n in (NAME, LEGACY_NAME) if n in have), None)


def installed():
    return present() is not None


def base():
    """Where the 3D view reads tiles from, or None: /w/<name>/ and, in the flavour, the hd/ folder under it."""
    name = present()
    return None if name is None else "/w/%s/%s" % (name, "hd/" if name == NAME else "")


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
    """What the Almanac shows: ``installed`` and ``base`` (where its tiles are read from); ``offer`` (the file this
    version fetches, and its size) while it is not; the setting; the download under way.
    """
    mode, locked = POLICY.mode()
    have = installed()
    out = {
        "installed": have,
        "base": base() if have else None,
        "mode": mode,
        "locked": locked,
        "offer": None,
        "downloading": None,
    }
    rel = None if have else release()
    if not rel:
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


def saved_release(item):
    """The release a pending download recorded (downloads.json: url, filename, size_bytes, sha256), if it names
    one of ours. A restart resumes from this: the manifest is read in the background and may not be there yet."""
    m = re.match(
        r"^" + re.escape(RELEASE_URL).replace(r"\{tag\}", r"(?P<tag>v[\w.\-]+)").replace(r"\{file\}", r"(?P<file>[\w.\-]+)") + r"$",
        str(item.get("url") or ""),
    )
    size, sha = item.get("size_bytes"), str(item.get("sha256") or "")
    if not (m and _FILE_RE.match(m["file"]) and m["file"] == item.get("filename") and isinstance(size, int) and _SHA_RE.match(sha)):
        return None
    return {"file": m["file"], "size": size, "sha256": sha, "tag": m["tag"]}


def start(actor=None, saved=None):
    """Queue the download. ``(download id, error)``: error is "never" (the
    setting, or ZIMI_OFFLINE), "installed", or "unavailable" (no file named
    for this version). ``saved``: a pending download to resume (saved_release)."""
    if POLICY.mode()[0] == outbound.NEVER:
        return None, "never"
    if installed():
        return None, "installed"
    rel = release() or (saved_release(saved) if saved else None)
    if not rel:
        return None, "unavailable"
    from zimi import server as _srv
    from zimi.safety import join_inside

    dest = join_inside(_srv.ZIM_DIR, rel["file"])
    if dest is None or os.path.exists(dest):
        return (
            None,
            "installed",
        )  # on disk already (a scan not yet run): never fetched over it
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
        extra={
            "_source": SOURCE,
            "_activity": {"actor": actor},
            "_sha256": rel.get("sha256") or None,
        },
    )


def on_almanac_open():
    """The Almanac asked: under Automatically, the first ask fetches it."""
    st = status()
    if st["mode"] == outbound.AUTO and st["offer"] and not st["downloading"]:
        start(None)
        st = status()
    return st
