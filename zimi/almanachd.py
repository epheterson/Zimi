"""Almanac HD: the Almanac's sharp Earth, Moon and planets, one ZIM fetched once.

The Almanac ships with one small map per body and works with nothing more. Almanac HD is those maps as tile
pyramids, far too large for the package. It is the HD flavour of the Almanac itself: ``zimi_almanac_maxi_<month>.zim``
(Flavour ``maxi``, the same Name as the Almanac in the package), the whole Almanac with the tiles inside under
``hd/`` (scripts/build_almanac_maxi.py). Opened alone in Kiwix it is the full Almanac with sharp tiles; in Zimi it is
fetched the way any ZIM is, through the download queue (library.py), into the library, where the 3D view
(almanac-earth.js) draws from ``/w/zimi_almanac_maxi/hd/``. A data pack (server.DATA_PACKS): the library shows one
Almanac, the package's, with HD present.

Every release builds that file and attaches it with a small manifest, ``zimi_almanac_maxi.json``
(``{"file", "size", "sha256", "tag"}``). The offer is sized offline (the pinned tile source plus the Almanac in the
package: "about N MB"). Only after a yes, or under Automatically, does Zimi read the manifest of its own version's
release (``v<version>``), then download the file it names and check its sha256; a build with no release (a dev
build) finds none and fetches nothing. 1.15.3 shipped the tiles alone as
``zimi_almanac_hd``; whoever has that file keeps their tiles (``LEGACY_NAME``) and is not asked again.

Eric, 2026-11-03: "HD can download once on first use of almanac or something?" Whether it may is an Ask first /
Automatically / Never setting like every other fetch (outbound.py), Ask first by default: the Almanac offers it, with
its size, to someone who may download, and Automatically fetches it the first time the Almanac asks. ZIMI_OFFLINE is
Never. Reading the manifest is part of that setting: nothing is read before consent, and under Never nothing is.
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
#: The pinned tile source (scripts/build_almanac_maxi.py): its size is most of the flavour's, and known without the internet.
TILES_PIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "almanac-tiles.json")
ESTIMATE_STEP = 10_000_000
#: Where the queue says a download came from: also what keeps it out of
#: NOMAD's library (library._enqueue_zim_download hands only catalog ones over).
SOURCE = "almanac_hd"

POLICY = outbound.FetchPolicy(ENV, PREFS_KEY, outbound.ASK, "Almanac HD")

_manifest = {"rel": None, "tried": 0.0, "busy": False}
_manifest_lock = threading.Lock()
#: Looking for a download under way and queueing one are one step: two Almanacs asking at once fetch it once.
_start_lock = threading.Lock()


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
    """Read the manifest from this version's release, now. The good one is kept; None when there is none (a dev
    build, no network). Only ever called once the setting has said yes (``start``): Ask first reaches nothing before."""
    rel = None
    try:
        from zimi import server as _srv
        from zimi.library import USER_AGENT

        req = urllib.request.Request(manifest_url(), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=MANIFEST_TIMEOUT_S, context=_srv.SSL_CTX) as resp:
            raw = resp.read(MANIFEST_MAX_BYTES + 1)
        rel = parse_manifest(raw.decode("utf-8", "replace")) if len(raw) <= MANIFEST_MAX_BYTES else None
    except Exception as e:  # no release for this version, no network: nothing to fetch
        log.info("Almanac HD: no manifest (%s)", loggable(type(e).__name__))
    with _manifest_lock:
        _manifest.update(rel=rel, tried=time.time())
    return rel


def release(read=False):
    """The file this version of Zimi fetches, from the manifest already read, or None (not read, no manifest on the
    release, or the setting is Never). ``read=True`` reads it first, which is a connection to the internet: only after
    a yes (``start``). Without it nothing is fetched."""
    if POLICY.mode()[0] == outbound.NEVER:
        return None
    with _manifest_lock:
        if _manifest["rel"]:
            return _manifest["rel"]
    return _read_manifest() if read else None


def estimate():
    """About how big the download is, known offline: the pinned tile source's size plus the Almanac in the package
    (the flavour is the two together), to the nearest ten MB. None when either is unknown."""
    from zimi import ownzims

    try:
        with open(TILES_PIN, encoding="utf-8") as f:
            tiles = json.load(f).get("size")
        almanac = os.path.getsize(ownzims.zim_path(next(o for o in ownzims.OWN if o.name == "zimi_almanac")))
    except (OSError, ValueError, TypeError, StopIteration, AttributeError):
        return None
    if not isinstance(tiles, int) or tiles <= 0:
        return None
    return round((tiles + almanac) / ESTIMATE_STEP) * ESTIMATE_STEP


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


def _downloading():
    """The queue's record for Almanac HD, active or waiting, or None."""
    from zimi import library

    with library._download_lock:
        recs = list(library._active_downloads.values()) + list(library._download_queue)
    return next(
        (
            d
            for d in recs
            if (d.get("_source") == SOURCE or _FILE_RE.match(str(d.get("filename"))))
            and not d.get("error")
            and not d.get("done")  # a finished transfer is kept for a while: HD deleted since is to be fetched again
        ),
        None,
    )


def status():
    """What the Almanac shows: ``installed`` and ``base`` (where its tiles are read from); ``offer`` while it is not
    (``size``; ``approx`` when it is the offline estimate, before the release's own figure is known); the setting; the
    download under way. Reads no network."""
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
    if have or mode == outbound.NEVER:
        return out
    rel = release()
    size = rel["size"] if rel else estimate()
    if size:
        out["offer"] = {"file": rel["file"], "size": size} if rel else {"size": size, "approx": True}
    dl = _downloading()
    if dl:
        done = dl.get("downloaded_bytes") or 0
        out["downloading"] = {
            "id": dl.get("id"),
            "done": done,
            "size": dl.get("size_bytes") or size or 0,
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
    rel = release(read=True) or (saved_release(saved) if saved else None)
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
    from zimi import library

    link = url(rel)
    with _start_lock:
        dl = _downloading()
        if dl:
            return dl.get("id"), None
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


def _auto_start():
    try:
        start(None)
    finally:
        with _manifest_lock:
            _manifest["busy"] = False


def on_almanac_open():
    """The Almanac asked. Under Automatically the first ask fetches it, in the background (the manifest is read and
    the download queued by a thread nobody waits for); under Ask first nothing is fetched until ``start``."""
    st = status()
    if st["mode"] == outbound.AUTO and st["offer"] and not st["downloading"]:
        with _manifest_lock:
            go = not _manifest["busy"] and time.time() - _manifest["tried"] >= MANIFEST_RETRY_S
            _manifest["busy"] = go or _manifest["busy"]
        if go:
            threading.Thread(target=_auto_start, name="almanac-hd-auto", daemon=True).start()
    return st
