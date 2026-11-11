"""Other folders Zimi reads ZIMs from, without owning them.

A second program (Project NOMAD's Information Library, a Kiwix box, a shared
drive) keeps ZIMs in a folder of its own. Zimi reads them where they are: no
copy, no move, nothing written beside them. That folder stays the other
program's, so Zimi never deletes, renames or updates a file in it, and a
same-named ZIM in Zimi's own library always wins.

Folders come from ``ZIMI_EXTRA_ZIM_DIRS`` (a path list, ``os.pathsep``
separated; the file ``extra_zim_dirs`` key is the same setting) and from
``library_folders.json`` in the data folder, which is what the Storage card
edits. The environment wins the way it does everywhere: its folders are listed
but cannot be removed from the page.

Each folder is read flat: its own ``*.zim`` files, no subfolders. That is how
NOMAD (``storage/zim``) and Kiwix lay out a library.
"""

import glob
import logging
import os
import threading

import zimi.server as _srv
from zimi import zimparts

log = logging.getLogger("zimi")

ENV = "ZIMI_EXTRA_ZIM_DIRS"
STATE_FILE = "library_folders.json"
MAX_FOLDERS = 8
_LABEL_MAX = 64

NOMAD_LABEL = "Project NOMAD"
# Where a NOMAD box keeps its ZIMs on the host (install_nomad.sh), and where
# the docs mount that folder inside a container.
NOMAD_CANDIDATES = ("/opt/project-nomad/storage/zim", "/nomad")

#: How often a quiet library is looked at for ZIMs another program added or
#: removed: one directory listing per folder, nothing else.
WATCH_SECONDS = 30


class FolderError(Exception):
    """A folder that cannot be added or removed; ``key`` is the i18n key."""

    def __init__(self, key):
        super().__init__(key)
        self.key = key


def _norm(path):
    return os.path.normpath(os.path.abspath(os.path.expanduser(str(path).strip())))


def _looks_like_nomad(path):
    """NOMAD's layout, wherever its storage was put: ``storage/zim`` with
    ``kiwix-library.xml`` beside the ZIMs, or the folders NOMAD keeps next to
    ``zim`` (maps, kolibri)."""
    parent = os.path.dirname(path)
    if parent == path:
        return False
    # Zimi standing in for NOMAD's Information Library sees the folder as
    # /data (where NOMAD mounts it for Kiwix); the owner names NOMAD's admin.
    if os.environ.get("ZIMI_NOMAD_API") and os.path.isfile(
        os.path.join(path, "kiwix-library.xml")
    ):
        return True
    if os.path.basename(parent) == "storage" and (
        os.path.basename(path) == "zim"
        or os.path.isfile(os.path.join(path, "kiwix-library.xml"))
    ):
        return True
    try:
        return any(n == "maps" or n.startswith("kolibri") for n in os.listdir(parent))
    except OSError:
        return False


def _default_label(path):
    if path in NOMAD_CANDIDATES or _looks_like_nomad(path):
        return NOMAD_LABEL
    # A root folder has no name of its own; the path is the label.
    return os.path.basename(path) or path


def _state_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, STATE_FILE)


def _read_state():
    import json

    try:
        with open(_state_path(), encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return {"folders": [], "dismissed": []}
    if not isinstance(state, dict):
        return {"folders": [], "dismissed": []}
    state.setdefault("folders", [])
    state.setdefault("dismissed", [])
    return state


def _write_state(state):
    _srv._atomic_write_json(_state_path(), state)


# The saved list is read from disk when it changes (add, remove, dismiss, a
# scan, a watcher tick), never per request: /list asks who owns each ZIM and
# that must stay a string compare. The key covers what a test or a restart can
# change without going through those.
_folders_lock = threading.Lock()
_state_lock = threading.RLock()
_folders_cache = None


def _cache_key():
    return (os.environ.get(ENV, ""), _srv.ZIMI_DATA_DIR, _srv.ZIM_DIR)


def refresh():
    """Read the saved folder list again."""
    global _folders_cache
    with _folders_lock:
        _folders_cache = None


def _compute_folders():
    out, seen = [], set()

    def keep(p, label, source):
        # Zimi's own library (or its data) named as an "other" folder would
        # make its own ZIMs look like someone else's and refuse their Delete.
        if p in seen:
            return
        seen.add(p)
        if _inside(p, _srv.ZIM_DIR) or _inside(p, _srv.ZIMI_DATA_DIR):
            log.warning("Ignoring %s: it is Zimi's own library folder", p)
            return
        out.append({"path": p, "label": label, "source": source})

    for raw in os.environ.get(ENV, "").split(os.pathsep):
        if raw.strip():
            p = _norm(raw)
            keep(p, _default_label(p), "env")
    for item in _read_state()["folders"]:
        p = _norm(item.get("path", ""))
        keep(p, str(item.get("label") or _default_label(p))[:_LABEL_MAX], "saved")
    return out


def folders():
    """Every folder asked for, ``[{path, label, source}]``: the environment's
    first, then the ones saved from the page. A folder that is not there right
    now is still listed (an unplugged drive comes back), just not read."""
    global _folders_cache
    key = _cache_key()
    with _folders_lock:
        if _folders_cache is None or _folders_cache[0] != key:
            _folders_cache = (key, _compute_folders())
        return list(_folders_cache[1])


def dirs():
    """The folders that exist right now, in the order they were asked for."""
    return [f["path"] for f in folders() if os.path.isdir(f["path"])]


def labels():
    """``{folder: label}``, taken once per question so a list of a thousand
    ZIMs asks the disk nothing per ZIM."""
    return {f["path"]: f["label"] for f in folders()}


def owner(path, folder_labels=None):
    """The label of the folder ``path`` lives in, or None when it is in Zimi's
    own library. Pure string work on a path the scan already produced."""
    folder_labels = labels() if folder_labels is None else folder_labels
    return folder_labels.get(os.path.dirname(os.path.normpath(path)))


def _zims_in(folder):
    return zimparts.in_folder(folder)


def zim_paths():
    """Every book (``*.zim``, or a split book's ``.zimaa``) in the folders,
    folder by folder, name order."""
    return [p for d in dirs() for p in _zims_in(d)]


#: How NOMAD stages a download: ``<name>.zim.tmp``, renamed when whole.
STAGED = "*.zim.tmp"

# ``{folder: (files, bytes)}`` of downloads still arriving, read in the
# watcher's own pass so a page asking never touches the disk.
_incoming = {}


def _scan_incoming():
    """One listing per folder: the ZIMs the other program is still fetching."""
    found = {}
    for d in dirs():
        sizes = []
        for p in glob.glob(os.path.join(d, STAGED)):
            try:
                sizes.append(os.stat(p).st_size)
            except OSError:
                pass
        if sizes:
            found[d] = (len(sizes), sum(sizes))
    global _incoming
    _incoming = found


def summary():
    """What the home page says about these folders, no paths: ``[{label,
    incoming_files, incoming_bytes}]`` for each folder asked for. Memory only."""
    out = []
    for f in folders():
        files, size = _incoming.get(f["path"], (0, 0))
        out.append(
            {"label": f["label"], "incoming_files": files, "incoming_bytes": size}
        )
    return out


def _inside(child, parent):
    child, parent = os.path.realpath(child), os.path.realpath(parent)
    return child == parent or child.startswith(parent + os.sep)


# Files in these folders that lost a name to another file, ``{loser: winner}``,
# noted where the library is scanned or a file registered, so a list or a card
# can say so without looking at the disk.
_shadowed = {}


def set_shadowed(losers):
    global _shadowed
    _shadowed = dict(losers)


def note_shadowed(loser, winner):
    if owner(loser) is not None:
        _shadowed[os.path.normpath(loser)] = os.path.normpath(winner)


def forget(path):
    _shadowed.pop(os.path.normpath(path), None)
    _unreadable.pop(os.path.normpath(path), None)


def also_in():
    """``{winner path: label}``: Zimi's own files that a copy in another
    program's folder lost to, so the row can say a copy exists there."""
    folder_labels = labels()
    out = {}
    for loser, winner in _shadowed.items():
        label = owner(loser, folder_labels)
        if label and owner(winner, folder_labels) is None:
            out[winner] = label
    return out


# path -> its why_unreadable verdict: /list asks on every call, and the disk
# once per file is enough until the file leaves or arrives again (forget).
_unreadable = {}


def why_unreadable(path):
    """Why a ZIM will not open: nobody told Zimi's user it may be read (a
    container running as another user), or the file itself is damaged or still
    arriving."""
    key = os.path.normpath(path)
    if key not in _unreadable:
        _unreadable[key] = "permission" if not os.access(path, os.R_OK) else "corrupt"
    return _unreadable[key]


def audit(folder):
    """What a folder holds, as the library sees it: ``zims`` served and
    readable, ``shadowed`` (same name as a file that won), ``unreadable`` with
    a reason. Counted from the registry, so a number never promises more than
    the library shows."""
    held = {os.path.normpath(p): n for n, p in _srv.get_zim_files().items()}
    entries = {z.get("name"): z for z in (_srv._zim_list_cache or [])}
    out = {"zims": 0, "shadowed": [], "unreadable": []}
    for path in _zims_in(folder):
        name = held.get(os.path.normpath(path))
        base = os.path.basename(path)
        if name is None:
            out["shadowed"].append(
                {
                    "file": base,
                    "wins": os.path.basename(_shadowed.get(os.path.normpath(path), "")),
                }
            )
        elif entries.get(name, {}).get("entries", "?") == "?":
            out["unreadable"].append({"file": base, "why": why_unreadable(path)})
        else:
            out["zims"] += 1
    return out


def registered_in(folder):
    """The ZIMs the live library is serving from ``folder``: what leaves with
    it, however its files look on disk (an unplugged drive has none)."""
    folder = _norm(folder)
    return [
        p
        for p in _srv.get_zim_files().values()
        if os.path.dirname(os.path.normpath(p)) == folder
    ]


def shares():
    """What each folder contributes to the library being served, ``[{label,
    zims, size_gb}]``: counted from the registry (names to paths, sizes from
    the listing), so asking costs no disk."""
    folder_labels = labels()
    if not folder_labels:
        return []
    listed = {z.get("name"): z for z in (_srv._zim_list_cache or [])}
    sizes = {n: z.get("size_gb", 0) for n, z in listed.items()}
    out = {}
    for name, path in _srv.get_zim_files().items():
        label = owner(path, folder_labels)
        if label and listed.get(name, {}).get("entries", "?") != "?":
            row = out.setdefault(label, {"label": label, "zims": 0, "size_gb": 0})
            row["zims"] += 1
            row["size_gb"] += sizes.get(name, 0)
    return list(out.values())


def add(path, label=""):
    """Start reading ZIMs from ``path``. Raises FolderError(key) when it is
    not a readable folder, is Zimi's own, is already listed, or is one too many.
    Returns the ZIMs in it."""
    p = _norm(path)
    if not os.path.isdir(p):
        raise FolderError("folder_missing")
    if not os.access(p, os.R_OK | os.X_OK):
        raise FolderError("folder_unreadable")
    if _inside(p, _srv.ZIM_DIR) or _inside(p, _srv.ZIMI_DATA_DIR):
        raise FolderError("folder_is_library")
    with _state_lock:
        held = folders()
        if any(f["path"] == p for f in held):
            raise FolderError("folder_known")
        if len(held) >= MAX_FOLDERS:
            raise FolderError("folder_limit")
        state = _read_state()
        state["folders"].append(
            {"path": p, "label": (label.strip() or _default_label(p))[:_LABEL_MAX]}
        )
        _write_state(state)
        refresh()
    _watch.reset()
    return _zims_in(p)


def remove(path):
    """Stop reading from a saved folder and return its normalized path. Its
    files are not touched. Raises FolderError for a folder that is not listed
    (Zimi's own library among them) or that the environment names."""
    p = _norm(path)
    with _state_lock:
        listed = {f["path"]: f["source"] for f in folders()}
        if p not in listed:
            raise FolderError("folder_unknown")
        if listed[p] == "env":
            raise FolderError("folder_env")
        state = _read_state()
        state["folders"] = [
            f for f in state["folders"] if _norm(f.get("path", "")) != p
        ]
        _write_state(state)
        refresh()
    _watch.reset()
    return p


def rename(path, label):
    """Give a saved folder another name (blank goes back to the detected one).
    The environment's folders are named where they are set."""
    p = _norm(path)
    with _state_lock:
        listed = {f["path"]: f["source"] for f in folders()}
        if p not in listed:
            raise FolderError("folder_unknown")
        if listed[p] == "env":
            raise FolderError("folder_env")
        state = _read_state()
        for f in state["folders"]:
            if _norm(f.get("path", "")) == p:
                f["label"] = (label.strip() or _default_label(p))[:_LABEL_MAX]
        _write_state(state)
        refresh()


def dismiss(path):
    """Stop offering this folder."""
    p = _norm(path)
    with _state_lock:
        state = _read_state()
        if p not in state["dismissed"]:
            state["dismissed"].append(p)
            _write_state(state)


def suggestions():
    """Folders worth offering once: a Project NOMAD library found at one of its
    well-known places, not added and not turned down. Asked when the Storage
    card opens, never at boot or on a page people wait for."""
    known = {f["path"] for f in folders()}
    turned_down = set(_read_state()["dismissed"])
    out = []
    for c in NOMAD_CANDIDATES:
        if c in known or c in turned_down or not os.path.isdir(c):
            continue
        n = len(_zims_in(c))
        if n:
            out.append({"path": c, "label": NOMAD_LABEL, "zims": n, "kind": "nomad"})
    return out


# ── following the other program's downloads ────────────────────────────────


class Watch:
    """Notices ZIMs another program added to or removed from a folder.

    One directory listing per tick, with sizes. A new file is acted on only
    once its size has held for a whole tick, so a copy still arriving is not
    opened. NOMAD stages downloads as ``.zim.tmp`` and renames, which never
    shows a half file, but a sideload with ``cp`` does.

    A removal is held while a same-named file is still settling: an update
    (the new edition appears, the old one is deleted) then lands as one swap,
    never as a gap or a rescan.
    """

    def __init__(self):
        self.known = None
        self.pending = {}
        self._lock = threading.Lock()

    def reset(self):
        with self._lock:
            self.known = None
            self.pending = {}

    @staticmethod
    def _listing():
        out = {}
        for p in zim_paths():
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[p] = (st.st_size, st.st_mtime)
        return out

    def tick(self):
        """Returns ``(added, gone)`` paths acted on this tick."""
        with self._lock:
            refresh()
            now = self._listing()
            _scan_incoming()
            if self.known is None:
                self.known, self.pending = now, {}
                return [], []
            gone = [p for p in self.known if p not in now]
            changed = [p for p in now if self.known.get(p) != now[p]]
            stable = [p for p in changed if self.pending.get(p) == now[p]]
            self.pending = {p: now[p] for p in changed}
            settling = {_name(p) for p in changed if p not in stable}
            held = [p for p in gone if _name(p) in settling]
            gone = [p for p in gone if p not in held]
            if not gone and not stable:
                return [], []
            rescanned = reconcile(stable, gone)
            if rescanned:
                self.known, self.pending = now, {}
            else:
                known = dict(self.known)
                known.update({p: now[p] for p in stable})
                for p in gone:
                    known.pop(p, None)
                self.known = known
            return stable, gone


def _name(path):
    return _srv._zim_base_name(os.path.basename(path))


def reconcile(added, gone):
    """Splice ZIMs that arrived in, or left, the folders into the live library
    by their full paths, without reading the rest of it. An arrival takes over
    from a departed edition of the same name in one swap. A full rescan is the
    last resort, only for a file that cannot be read. Returns True when it ran."""
    for g in list(gone) + list(added):
        forget(g)
    swapped = set()
    readable = True
    for p in added:
        old = [g for g in gone if _name(g) == _name(p)]
        swapped.update(old)
        readable = _srv.register_zim_file(p, removed_paths=old) and readable
    left = _srv.unregister_zim_paths([g for g in gone if g not in swapped])
    # A name that left may have a copy beside it that now serves it.
    on_disk = _srv._scan_zim_files() if left else {}
    for name in left:
        if name in on_disk:
            readable = _srv.register_zim_file(on_disk[name]) and readable
    if not readable:
        with _srv._zim_lock:
            _srv.load_cache(force=True)
    _srv._search_cache_clear()
    _srv._suggest_cache_clear()
    log.info("Other library folders changed: %d added, %d gone", len(added), len(gone))
    return not readable


def settle(added=(), gone=()):
    """A change the other program just made at our request (NOMAD finished a
    download we asked for, or deleted a ZIM): splice it in now instead of
    waiting for the watcher's second look."""
    reconcile(list(added), list(gone))
    _watch.reset()


def nomad_folder():
    """The path of the folder that is Project NOMAD's, or None."""
    return next((f["path"] for f in folders() if f["label"] == NOMAD_LABEL), None)


_watch = Watch()
_watch_thread = None
_watch_start_lock = threading.Lock()


def _watch_loop():
    import time

    # The page asks what is arriving from the first minute, not the second.
    try:
        _scan_incoming()
    except Exception as e:
        log.warning("Listing the downloads under way failed: %s", e)
    from zimi import nomadapi

    while True:
        try:
            nomadapi.tick()
        except Exception as e:
            log.warning("Asking Project NOMAD's API failed: %s", e)
        time.sleep(WATCH_SECONDS)
        try:
            _watch.tick()
        except Exception as e:
            log.warning("Watching the other library folders failed: %s", e)


def ensure_watch():
    """Start the watcher once. A listing of no folders is free, so it does not
    wait for the first folder to be added."""
    global _watch_thread
    with _watch_start_lock:
        if _watch_thread is None:
            _watch_thread = threading.Thread(
                target=_watch_loop, daemon=True, name="zimi-library-folders"
            )
            _watch_thread.start()
