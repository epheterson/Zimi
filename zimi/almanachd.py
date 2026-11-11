"""Almanac HD: the Almanac's sharp Earth, Moon and planets, one ZIM fetched once, in one of two sizes.

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

Two sizes, one installed at a time (Eric, 2026-11-10): HD, the file above (under GitHub's 2 GiB a release file), and
Maximum, ``zimi_almanac_ultra_<month>.zim`` (Flavour ``ultra``: every layer at its source's full resolution, heights
for every body), too big for one release file, so attached as zimsplit chunks (``.zimaa``, ``.zimab``...; cut
between clusters, so its index stays whole) that the library reads as one book (zimparts.py). The manifest lists
Maximum under ``max``: the book's file, size and sha256, and each chunk's. Its chunks come into a hidden folder of
the library (``STAGE_DIR``: the scan never reads it), each resumed on its own and checked against its sha256; the
whole book is checked (libzim opens it, its sha256 matches) before it is moved into the library, and only then is
HD removed. Choosing HD removes Maximum the same way. Automatically fetches HD, never Maximum unless that was the
choice. The set 1.16's development builds made (the flavour plus ``zimi_almanac_hd_<part>`` parts) is still read
where it is, and once either size replaces it, what it leaves on disk is listed with the older copies (Manage >
Storage), never deleted unasked.
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
#: Maximum: the book's name and file, and where its chunks wait until the whole book is checked.
MAX_NAME = "zimi_almanac_ultra"
_MAX_RE = re.compile(r"^zimi_almanac_ultra_\d{4}-\d{2}[a-z]?\.zim$")
STAGE_DIR = ".almanac-max"
#: GitHub's limit for a release file: every chunk is under it.
CHUNK_LIMIT = 2**31
KINDS = ("hd", "max")
#: Which size the reader chose (saved beside the setting): what Automatically fetches and what is read if both are on disk.
KIND_KEY = "almanac_hd_kind"
#: A layer too big for one release file (GitHub's limit is 2 GiB a file) is a part: a ZIM of its own,
#: ``zimi_almanac_hd_<part>_<month>.zim``, with an ``hd.json`` listing only its layers. The 3D view reads the set as one.
PARTS = ("moon", "mars", "mercury", "earth")
PART_PREFIX = "zimi_almanac_hd_"
_PART_RE = re.compile(
    r"^zimi_almanac_hd_(?:%s)_\d{4}-\d{2}[a-z]?\.zim$" % "|".join(PARTS)
)
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_TIMEOUT_S = 10
MANIFEST_MAX_BYTES = 4096
#: A manifest that could not be read (no such release, no network) is looked for again after this long.
MANIFEST_RETRY_S = 6 * 3600
#: The pinned tile source (scripts/build_almanac_maxi.py): its size is most of the flavour's, and known without the internet.
TILES_PIN = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "almanac-tiles.json"
)
ESTIMATE_STEP = 10_000_000
#: Where the queue says a download came from: also what keeps it out of
#: NOMAD's library (library._enqueue_zim_download hands only catalog ones over).
SOURCE = "almanac_hd"

POLICY = outbound.FetchPolicy(ENV, PREFS_KEY, outbound.ASK, "Almanac HD")

_manifest = {"rel": None, "tried": 0.0, "busy": False}
_manifest_lock = threading.Lock()
#: Looking for a download under way and queueing one are one step: two Almanacs asking at once fetch it once.
_start_lock = threading.Lock()
#: What this process queued in the last JUST_QUEUED_S, by file: the queue's own record may not be readable yet.
_just_queued = {}
JUST_QUEUED_S = 60
#: Checking and installing a staged Maximum: one at a time.
_finish_lock = threading.Lock()


def _version():
    from zimi import server as _srv

    return _srv.ZIMI_VERSION


def manifest_url(version=None):
    """Where the running version's release keeps its manifest."""
    return RELEASE_URL.format(tag="v" + (version or _version()), file=MANIFEST)


def part_name(part):
    """The name the server has a part's ZIM under."""
    return PART_PREFIX + part


def chunk_names(book):
    """``name.zimaa``, ``name.zimab``... for the book ``name.zim``, as zimsplit names them."""
    from zimi import zimparts

    return [book + s for s in zimparts._SUFFIXES]


def _good_file(item, pattern):
    return (
        isinstance(item, dict)
        and isinstance(item.get("file"), str)
        and pattern.match(item["file"])
        and isinstance(item.get("size"), int)
        and not isinstance(item["size"], bool)
        and item["size"] > 0
        and isinstance(item.get("sha256"), str)
        and _SHA_RE.match(item["sha256"])
    )


def _good_max(m):
    """Maximum's entry: the book's file, size and sha256, and its chunks in order, each under CHUNK_LIMIT, adding up."""
    if not _good_file(m, _MAX_RE) or not isinstance(m.get("chunks"), list) or not m["chunks"]:
        return False
    names = chunk_names(m["file"])
    chunks = m["chunks"]
    return (
        len(chunks) <= len(names)
        and all(
            isinstance(c, dict)
            and c.get("file") == names[i]
            and isinstance(c.get("size"), int)
            and not isinstance(c["size"], bool)
            and 0 < c["size"] < CHUNK_LIMIT
            and isinstance(c.get("sha256"), str)
            and _SHA_RE.match(c["sha256"])
            for i, c in enumerate(chunks)
        )
        and sum(c["size"] for c in chunks) == m["size"]
    )


def parse_manifest(raw, version=None):
    """The manifest as ``{"file", "size", "sha256", "tag"}`` (HD) and, when the release has it, ``"max"``:
    ``{"file", "size", "sha256", "chunks": [{"file", "size", "sha256"}]}``, when it is a good one for this version's
    release, else None. A bad ``max`` is left out; HD is still offered."""
    try:
        rel = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(rel, dict):
        return None
    if not _good_file(rel, _FILE_RE) or rel.get("tag") != "v" + (version or _version()):
        return None
    out = {k: rel[k] for k in ("file", "size", "sha256", "tag")}
    m = rel.get("max")
    if isinstance(m, dict) and _good_max(m):
        out["max"] = {
            "file": m["file"],
            "size": m["size"],
            "sha256": m["sha256"],
            "chunks": [{k: c[k] for k in ("file", "size", "sha256")} for c in m["chunks"]],
        }
    return out


def _read_manifest():
    """Read the manifest from this version's release, now. The good one is kept; None when there is none (a dev
    build, no network). Only ever called once the setting has said yes (``start``): Ask first reaches nothing before.
    """
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


def estimate(kind="hd"):
    """About how big a size is, known offline: the pinned tile source's size (``max_size`` for Maximum) plus the
    Almanac in the package (the flavour is the two together), to the nearest ten MB. None when either is unknown."""
    from zimi import ownzims

    try:
        with open(TILES_PIN, encoding="utf-8") as f:
            tiles = json.load(f).get("size" if kind == "hd" else "max_size")
        almanac = os.path.getsize(ownzims.zim_path(next(o for o in ownzims.OWN if o.name == "zimi_almanac")))
    except (OSError, ValueError, TypeError, StopIteration, AttributeError):
        return None
    if not isinstance(tiles, int) or tiles <= 0:
        return None
    return round((tiles + almanac) / ESTIMATE_STEP) * ESTIMATE_STEP


def url(rel):
    return RELEASE_URL.format(tag=rel["tag"], file=rel.get("url_file") or rel["file"])


def _have():
    from zimi import server as _srv

    _srv.get_zim_files()  # the startup scan, if it has not run
    return _srv._zim_files_cache or {}


def _prefs():
    from zimi import manage

    try:
        return manage._read_app_update_prefs()
    except Exception:
        return {}


def chosen():
    """The size the reader chose last ("hd" or "max"), or None."""
    k = _prefs().get(KIND_KEY)
    return k if k in KINDS else None


def _choose(kind):
    from zimi import manage

    try:
        manage._write_app_update_prefs(**{KIND_KEY: kind})
    except Exception as e:  # the choice is a preference: the download still runs
        log.info("Almanac HD: could not save the size chosen (%s)", loggable(type(e).__name__))


def present():
    """The name the server has the tiles under, or None: Maximum, else HD (the flavour, else 1.15.3's tile ZIM). Both
    sizes on disk (the moment between one arriving and the other going): the one chosen. Whoever is asking: the library
    as the server sees it, never the asking person's allowed part of it (a person who may not see it would otherwise
    fetch it again on every visit)."""
    have = _have()
    if MAX_NAME in have and (chosen() != "hd" or NAME not in have):
        return MAX_NAME
    return next((n for n in (NAME, LEGACY_NAME) if n in have), None)


def current():
    """Which size the 3D view reads: "max", "hd", or None."""
    name = present()
    if name:
        return "max" if name == MAX_NAME else "hd"
    return "hd" if installed() else None


def _date_token(path):
    m = re.search(r"_(\d{4}-\d{2}[a-z]?)\.zim", os.path.basename(str(path)))
    return m.group(1) if m else None


def parts_present():
    """``{part: name}`` of the 1.16 development set's parts that are read: beside the flavour of their own build (the
    same date in the file name), never beside Maximum or a newer HD."""
    have = _have()
    if present() != NAME:
        return {}
    core = _date_token(have[NAME])
    return {p: part_name(p) for p in PARTS if part_name(p) in have and _date_token(have[part_name(p)]) == core}


def installed():
    """Almanac HD is in the library, in either size."""
    return present() is not None


def base():
    """Where the 3D view reads tiles from, or None: /w/<name>/ and, in a flavour, the hd/ folder under it."""
    name = present()
    return None if name is None else "/w/%s/%s" % (name, "" if name == LEGACY_NAME else "hd/")


def parts_bases():
    """``{part: /w/<name>/}`` for each part read: the other folders the 3D view reads tiles from."""
    return {p: "/w/%s/" % n for p, n in parts_present().items()}


def superseded():
    """The Almanac's data on disk that the size in use replaced, for Manage's older copies: ``[{file, size_bytes,
    replaced_by}]``. The scan lists an older file of the same name itself; these are the other names (1.15.3's tile
    ZIM, the 1.16 development parts, the other size)."""
    have, name = _have(), present()
    if not name or name == LEGACY_NAME:
        return []
    from zimi import zimparts

    winner = zimparts.book_filename(have[name])
    keep = {name} | set(parts_present().values())
    out = []
    for other in (NAME, MAX_NAME, LEGACY_NAME) + tuple(part_name(p) for p in PARTS):
        path = have.get(other)
        if not path or other in keep:
            continue
        try:
            size = zimparts.size(path)
        except OSError:
            continue
        out.append({"file": zimparts.book_filename(path), "size_bytes": size, "replaced_by": winner})
    return out


def _downloading_all():
    """The queue's records for Almanac HD files (either size, a chunk of Maximum), active or waiting."""
    from zimi import library

    with library._download_lock:
        recs = list(library._active_downloads.values()) + list(library._download_queue)
    return [
        d
        for d in recs
        if (d.get("_source") == SOURCE or _FILE_RE.match(str(d.get("filename"))))
        and not d.get("error")
        and not d.get("done")  # a finished transfer is kept for a while: HD deleted since is to be fetched again
    ]


def _downloading():
    """The first of them, or None."""
    return next(iter(_downloading_all()), None)


def _kind_of_download(d):
    return "max" if d.get("_chunk") or str(d.get("filename") or "").startswith(STAGE_DIR) else "hd"


def library_row():
    """The one Manage > Library row for the Almanac's data: the size in use, its files (and the development set's parts
    read beside it), with sizes, or None. The packs are not library rows of their own (server.DATA_PACKS); the Almanac's
    gear chooses which size to have."""
    from zimi import zimparts

    have, name = _have(), present()
    if not name:
        return None
    packs = []
    for n in [name] + [part_name(p) for p in PARTS if p in parts_present()]:
        path = have.get(n)
        try:
            size = zimparts.size(path)
        except (OSError, TypeError):
            continue
        packs.append({"name": n, "file": zimparts.book_filename(path), "size_bytes": size,
                      "part": n[len(PART_PREFIX):] if n.startswith(PART_PREFIX) else ""})
    if not packs:
        return None
    return {"kind": current(), "size_bytes": sum(p["size_bytes"] for p in packs), "packs": packs}


def status():
    """What the Almanac shows: ``installed``, ``kind`` (the size in use) and ``base`` (where its tiles are read from);
    ``offers``: each size not in use, ``{"size"}`` (``approx`` when it is the offline estimate, before the release's own
    figure is known); ``offer``: HD's, while nothing is installed (the quiet line under the controls); the setting;
    the download under way and which size it is. Reads no network."""
    mode, locked = POLICY.mode()
    kind = current()
    out = {
        "installed": kind is not None,
        "kind": kind,
        "base": base(),
        "parts": parts_bases(),
        "mode": mode,
        "locked": locked,
        "offers": {},
        "offer": None,
        "downloading": None,
    }
    if mode == outbound.NEVER:
        return out
    rel = release()
    for k in KINDS:
        if k == kind:
            continue
        if rel:
            item = rel if k == "hd" else rel.get("max")
            if item:
                out["offers"][k] = {"size": item["size"]}
        else:
            size = estimate(k)
            if size:
                out["offers"][k] = {"size": size, "approx": True}
    if kind is None and "hd" in out["offers"]:
        out["offer"] = dict(out["offers"]["hd"], **({"file": rel["file"]} if rel else {}))
    dls = _downloading_all()
    if dls:  # a size's files together: one bar
        k = _kind_of_download(dls[0])
        out["downloading"] = {
            "id": dls[0].get("id"),
            "kind": k,
            "done": sum(d.get("downloaded_bytes") or 0 for d in dls),
            "size": sum(d.get("size_bytes") or 0 for d in dls) or (out["offers"].get(k) or {}).get("size") or 0,
        }
    return out


def _installed_path(name):
    from zimi import server as _srv

    return (_srv._zim_files_cache or {}).get(name) or name


def _stage_dir():
    from zimi import server as _srv

    return os.path.join(_srv.ZIM_DIR, STAGE_DIR)


def _items(rel, kind):
    """What one step fetches of a release, each ``{"file", "size", "sha256", "tag"}`` (``file`` where it lands under the
    library; ``url_file`` its name on the release): HD's file, or each chunk of Maximum not yet staged whole."""
    if kind == "hd":
        return [{k: rel[k] for k in ("file", "size", "sha256", "tag")}]
    m = rel.get("max")
    if not m:
        return []
    out = []
    for c in m["chunks"]:
        staged = os.path.join(_stage_dir(), c["file"])
        try:
            if os.path.getsize(staged) == c["size"]:
                continue
        except OSError:
            pass
        out.append({"file": STAGE_DIR + "/" + c["file"], "url_file": c["file"], "size": c["size"],
                    "sha256": c["sha256"], "tag": rel["tag"], "chunk": True})
    return out


def saved_release(item):
    """The release a pending download recorded (downloads.json: url, filename, size_bytes, sha256), if it names
    one of ours: HD's file, or a chunk of Maximum staged under STAGE_DIR. A restart resumes from this: the manifest is
    read in the background and may not be there yet.
    """
    m = re.match(
        r"^"
        + re.escape(RELEASE_URL)
        .replace(r"\{tag\}", r"(?P<tag>v[\w.\-]+)")
        .replace(r"\{file\}", r"(?P<file>[\w.\-]+)")
        + r"$",
        str(item.get("url") or ""),
    )
    size, sha, name = item.get("size_bytes"), str(item.get("sha256") or ""), str(item.get("filename") or "")
    if not (m and isinstance(size, int) and _SHA_RE.match(sha)):
        return None
    if _FILE_RE.match(m["file"]) and m["file"] == name:
        return {"file": m["file"], "size": size, "sha256": sha, "tag": m["tag"]}
    book = m["file"][:-2]
    if _MAX_RE.match(book) and m["file"] in chunk_names(book) and name == STAGE_DIR + "/" + m["file"]:
        return {"file": name, "url_file": m["file"], "size": size, "sha256": sha, "tag": m["tag"], "chunk": True}
    return None


def start(actor=None, saved=None, kind=None):
    """Queue the download of a size ("hd", the default, or "max"). ``(download id, error)``: error is "never" (the
    setting, or ZIMI_OFFLINE), "installed" (that size is the one in use) or "unavailable" (no file named for this
    version). ``saved``: a pending download to resume (saved_release). A reader's choice (``actor``) is remembered:
    it is what Automatically fetches from then on."""
    if POLICY.mode()[0] == outbound.NEVER:
        return None, "never"
    resumed = saved_release(saved) if saved else None
    kind = kind or ("max" if resumed and resumed.get("chunk") else "hd")
    if kind not in KINDS:
        return None, "unavailable"
    if kind == current():
        return None, "installed"
    if actor is not None:
        _choose(kind)
    rel = release(read=True)
    items = _items(rel, kind) if rel else ([resumed] if resumed else [])
    if rel and kind == "max" and rel.get("max") and not items:
        _finish_max_async()  # every chunk is staged whole already (a restart between the last one and the check)
        return None, None
    if not items:
        return None, "unavailable"
    from zimi import library
    from zimi import server as _srv
    from zimi.safety import join_inside

    first = None
    with _start_lock:
        now = time.time()
        recent = {f for f, t in _just_queued.items() if now - t < JUST_QUEUED_S}
        queued = {d.get("filename") for d in _downloading_all()} | recent
        for item in items:
            dest = join_inside(_srv.ZIM_DIR, item["file"])
            if dest is None or os.path.exists(dest) or item["file"] in queued:
                continue  # on disk already (a scan not yet run) or on its way: never fetched over it
            if item.get("chunk"):
                os.makedirs(os.path.dirname(dest), exist_ok=True)
            link = url(item)
            log.info("Almanac HD: fetching %s", loggable(item["file"]))
            extra = {
                "_source": SOURCE,
                "_activity": {"actor": actor},
                "_sha256": item.get("sha256") or None,
            }
            if item.get("chunk"):
                extra["_chunk"] = True
            dl_id, err = library._enqueue_zim_download(link, [link], item["file"], size_bytes=item["size"], extra=extra)
            if err:
                return dl_id, err
            _just_queued[item["file"]] = now
            first = first or dl_id
        if first is None:
            dl = _downloading()
            return (dl.get("id"), None) if dl else (None, "installed")
    return first, None


def _finish_max_async():
    threading.Thread(target=finish_max, name="almanac-max-finish", daemon=True).start()


def _book_sha256(paths):
    import hashlib

    h = hashlib.sha256()
    for p in paths:
        with open(p, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
    return h.hexdigest()


def finish_max(dl=None):
    """A chunk of Maximum came in (library.py, after its own sha256 was checked). Once every chunk is staged whole,
    the book is checked (libzim opens it; its sha256 is the manifest's) and moved into the library, the last chunk
    first and ``.zimaa`` last, so the scan never sees part of it; then the size it replaces is removed. A book that
    fails the check is removed from the staging folder and nothing installed changes. True when it was installed."""
    rel = release(read=True)
    m = rel and rel.get("max")
    if not m:
        return False
    from zimi import server as _srv

    with _finish_lock:
        stage = _stage_dir()
        staged = [os.path.join(stage, c["file"]) for c in m["chunks"]]
        try:
            if any(os.path.getsize(p) != c["size"] for p, c in zip(staged, m["chunks"])):
                return False
        except OSError:
            return False  # not all in yet
        good = False
        try:
            _srv.open_archive(staged[0])
            good = _book_sha256(staged) == m["sha256"]
        except Exception as e:
            log.error("Almanac HD: Maximum does not open (%s)", loggable(type(e).__name__))
        if not good:
            log.error("Almanac HD: Maximum failed its check; nothing installed changed")
            for p in staged:
                try:
                    os.remove(p)
                except OSError:
                    pass
            return False
        for p in reversed(staged):
            os.replace(p, os.path.join(_srv.ZIM_DIR, os.path.basename(p)))
        try:
            os.rmdir(stage)
        except OSError:
            pass
    from zimi import library

    library._post_download_finalize({
        "id": (dl or {}).get("id"),
        "filename": m["file"],
        "dest": os.path.join(_srv.ZIM_DIR, m["chunks"][0]["file"]),
        "_source": SOURCE,
        "_activity": (dl or {}).get("_activity") or {},
        "total_bytes": m["size"],
    })
    return True


def on_installed(kind):
    """A size has just come in, checked: it is the choice now, and the other size goes (HD replaces Maximum and the
    reverse). The 1.16 development set is left where it is (superseded() lists it)."""
    from zimi import server as _srv
    from zimi import zimparts

    _choose(kind)
    other = MAX_NAME if kind == "hd" else NAME
    path = _have().get(other)
    if not path or os.path.dirname(os.path.realpath(path)) != os.path.realpath(_srv.ZIM_DIR):
        return
    if other == NAME and _date_token(path) in {_date_token(_have().get(part_name(p), "")) for p in PARTS}:
        return  # the development set's own flavour: an older copy, not this choice's to remove
    try:
        _srv.release_zim_handles([other])
    except Exception as e:
        log.debug("Handle release before removing %s: %s", other, e)
    for p in zimparts.on_disk(path):
        try:
            os.remove(p)
            log.info("Almanac HD: removed %s (the other size)", loggable(os.path.basename(p)))
        except OSError as e:
            log.warning("Almanac HD: could not remove %s: %s", loggable(os.path.basename(p)), loggable(type(e).__name__))
    with _srv._zim_lock:
        _srv.load_cache(force=True)


def _auto_start():
    try:
        start(None, kind=chosen() or "hd")
    finally:
        with _manifest_lock:
            _manifest["busy"] = False


def on_almanac_open():
    """The Almanac asked. Under Automatically the first ask fetches it, in the background (the manifest is read and
    the download queued by a thread nobody waits for): HD, or Maximum if that was the reader's choice; under Ask first
    nothing is fetched until ``start``.
    """
    st = status()
    if st["mode"] == outbound.AUTO and st["offer"] and not st["downloading"]:
        with _manifest_lock:
            go = (
                not _manifest["busy"]
                and time.time() - _manifest["tried"] >= MANIFEST_RETRY_S
            )
            _manifest["busy"] = go or _manifest["busy"]
        if go:
            threading.Thread(
                target=_auto_start, name="almanac-hd-auto", daemon=True
            ).start()
    return st
