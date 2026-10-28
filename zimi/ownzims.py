"""Zimi's own ZIMs: real ZIM files committed in the package
(``zimi/builtin/<name>_<YYYY-MM>.zim``), served as the library's last tier, and attached
to each release so anyone can download them for Kiwix or any other reader.

Each is built from source by ``python -m zimi.ownzims``: a folder under
``zimi/builtin/<folder>/``, or a folder staged from files that live elsewhere
in the package (the Almanac's pages are the ones Zimi serves, see
almanacstage.py). A build is skipped when the source has not changed since
the committed file was made: the source's hash is committed beside it
(``<name>_<YYYY-MM>.zim.source``), so a ZIM's bytes change only when its source did.
The month in the name is when the content last changed, Kiwix style, so a
release that leaves a ZIM alone ships the same file under the same name, and
the library serves it under its name without the month (/w/zimi_games/...).
CI fails a pull request whose ZIMs are older than their source.

Nothing is built while Zimi runs: the scan finds the committed files, so
every install kind (Docker, desktop, pip, zimi-mcp) serves the same bytes a
download gets. ``ZIMI_BUILTIN_ZIMS=0`` serves none.
"""

import collections
import datetime
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import threading

#: ``folder``: its source under zimi/builtin/; ``name``: the file it becomes;
#: ``category``: its Home section (both are "Zimi": one place for what Zimi makes, a name in
#: every language, never "Gaming & Fandom" or "Education"); ``stage``: None for a plain folder, else a
#: function writing the folder to build into an empty directory. The source's
#: zimi.txt names it (title, description, language, tags, icon) and tags it
#: OWN_TAG, so the library never mistakes it for something the person made.
Own = collections.namedtuple("Own", "folder name category stage", defaults=(None,))


def _stage_almanac(dest):
    from zimi import almanacstage

    almanacstage.stage(dest)


OWN = (
    Own("games", "zimi_games", "Zimi"),
    Own("almanac", "zimi_almanac", "Zimi", _stage_almanac),
)
OWN_TAG = "zimi:own"

SOURCE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "builtin")
#: Where the built files are committed. A module global so tests build elsewhere.
OUT_DIR = SOURCE_ROOT
_STAMP_EXT = ".source"  # beside the ZIM: the hash of the source it was built from
_HASH_CHUNK = 1 << 16


def enabled():
    return os.environ.get("ZIMI_BUILTIN_ZIMS", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def zim_path(own):
    """The committed file for ``own`` (the newest month, should two be
    around), or None when none is built."""
    pat = re.compile(re.escape(own.name) + _DATED)
    try:
        names = sorted(n for n in os.listdir(OUT_DIR) if pat.match(n))
    except OSError:
        return None
    return os.path.join(OUT_DIR, names[-1]) if names else None


#: ``_2026-10.zim``, then ``_2026-10a.zim`` for a second release that month (Kiwix's letter)
_DATED = r"_\d{4}-\d{2}[a-z]?\.zim$"


def _released(path):
    """Whether a release tag already carries this file, so its name is spent."""
    try:
        rel = os.path.relpath(path, SOURCE_ROOT)
        run = lambda *a: subprocess.run(
            ("git",) + a, cwd=SOURCE_ROOT, capture_output=True, text=True, timeout=30
        ).stdout.strip()
        added = run("log", "--diff-filter=A", "--format=%H", "-1", "--", rel)
        return bool(added and run("tag", "--contains", added))
    except (OSError, subprocess.SubprocessError):
        return False


def _new_path(own, old):
    """This month's name. Within one month the name holds until a release
    has shipped it; the next change after that takes the next letter."""
    month = datetime.date.today().strftime("%Y-%m")
    tag = month
    m = old and re.search(r"_(\d{4}-\d{2})([a-z]?)\.zim$", old)
    if m and m.group(1) == month:
        letter = m.group(2)
        if not _released(old):
            tag = month + letter
        else:
            tag = month + chr(min(ord(letter or "`") + 1, ord("z")))
    return os.path.join(OUT_DIR, "%s_%s.zim" % (own.name, tag))


#: The prefs key (manage._read_app_update_prefs) holding the names an admin
#: removed from this server. The file stays in the package; the scan skips it.
#: Not the apps switch: that hides an app's tile and leaves the ZIM in search,
#: Discover and Random, and ZIMI_APPS can lock it; this takes the ZIM out of
#: the library entirely, and only the admin's own click puts it back.
REMOVED_KEY = "own_removed"


def removed():
    """The names (``zimi_games``) an admin removed from this server."""
    try:
        from zimi import manage

        saved = manage._read_app_update_prefs().get(REMOVED_KEY)
    except ImportError:  # zimi-mcp ships no Manage
        return frozenset()
    names = {o.name for o in OWN}
    return frozenset(n for n in saved if n in names) if isinstance(saved, list) else frozenset()


_removed_lock = threading.Lock()  # one read-then-write of the list at a time


def set_removed(name, gone):
    """Remove (``gone``) or add back one of these ZIMs. False for a name that
    is not one of them."""
    if name not in {o.name for o in OWN}:
        return False
    from zimi import manage

    with _removed_lock:
        now = set(removed())
        (now.add if gone else now.discard)(name)
        manage._write_app_update_prefs(**{REMOVED_KEY: [o.name for o in OWN if o.name in now]})
    return True


def is_own_path(path):
    """Whether ``path`` is one of the package's own files: it lives in the
    package's builtin folder. A file of the same name anywhere else (a copy
    someone put in their library) is an ordinary ZIM."""
    return bool(path) and os.path.dirname(os.path.abspath(path)) == os.path.abspath(OUT_DIR)


#: Folders of an own ZIM the phone does not keep ahead of time: the games' 214 puzzle files (16 MB) and their thumbnails
#: come as they are played, through the worker's usual network-first copy. Everything else is the app itself.
OFFLINE_SKIP = ("puzzles/", "thumbs/")
_offline_cache = {}  # name -> (file identity, [paths])
_offline_lock = threading.Lock()


def offline_paths(name):
    """What the phone keeps so an own ZIM opens with no signal (``GET /own-offline``): the address of each page, script,
    style and engine, less OFFLINE_SKIP. Empty when the ZIM is not in this request's library (removed, deleted, off the
    account's list), so nothing is kept for what the person took away. Read once per file, then from memory."""
    from zimi import server as _srv

    path = _srv.get_zim_files().get(name)
    if not path or not any(o.name == name for o in OWN):
        return []
    st = os.stat(path)
    ident = (path, st.st_size, st.st_mtime_ns)
    with _offline_lock:
        hit = _offline_cache.get(name)
        if hit and hit[0] == ident:
            return hit[1]
    out = []
    with _srv._zim_lock:
        archive = _srv.get_archive(name) or _srv.open_archive(path)
        for i in range(archive.all_entry_count):
            entry = archive._get_entry_by_id(i)
            # The ZIM's own metadata (Counter, Title, Illustration_48x48@1) has no extension and is no page.
            if (not entry.is_redirect and "." in entry.path and not entry.path.startswith(OFFLINE_SKIP + ("_", "-/", "Illustration"))):
                out.append("/w/%s/%s" % (name, entry.path))
    with _offline_lock:
        _offline_cache[name] = (ident, out)
    return out


def name_of_file(filename):
    """The own ZIM a file name (``zimi_games_2026-10.zim``) is, or None."""
    name = re.sub(_DATED, "", os.path.basename(filename))
    return name if any(o.name == name for o in OWN) else None


def zim_paths():
    """The committed ZIMs, for the library scan (empty while off), less the
    ones an admin removed."""
    if not enabled():
        return []
    gone = removed()
    return [p for p in (zim_path(o) for o in OWN if o.name not in gone) if p]


_rows_cache = {}  # path -> ((size, mtime), row without "installed")
_rows_lock = threading.Lock()


def _file_row(path):
    """What the package's file says of itself: title, description, icon (a
    data: URI), entries. Read once per file version, on a private handle (the
    file changes only when Zimi is upgraded), never per request."""
    import base64

    from libzim.reader import Archive

    st = os.stat(path)
    key = (st.st_size, st.st_mtime_ns)
    with _rows_lock:
        hit = _rows_cache.get(path)
        if hit and hit[0] == key:
            return hit[1]
    fname = os.path.basename(path)
    row = {"file": fname, "title": re.sub(_DATED, "", fname), "description": "", "icon": "",
           "size_bytes": st.st_size, "entries": 0,
           "date": (re.search(r"_(\d{4}-\d{2})", fname) or [""] * 2)[1]}
    try:
        a = Archive(path)
        row["title"] = a.get_metadata("Title").decode("utf-8", "replace")
        row["entries"] = a.article_count
        row["description"] = a.get_metadata("Description").decode("utf-8", "replace")
        if a.has_illustration(48):
            png = bytes(a.get_illustration_item(48).content)
            row["icon"] = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    except Exception:
        pass
    with _rows_lock:
        _rows_cache[path] = (key, row)
    return row


def catalog():
    """Each of these ZIMs as a catalog row, from the package itself (so an
    offline or air-gapped install lists them too): name, file, title,
    description, icon (a data: URI) and whether the library serves it now."""
    if not enabled():
        return []
    gone = removed()
    rows = []
    for o in OWN:
        path = zim_path(o)
        if not path:
            continue
        try:
            rows.append(dict(_file_row(path), name=o.name, installed=o.name not in gone))
        except OSError:
            continue
    return rows


def category_of(path):
    """The Home section of one of these ZIMs, by its path; None for any other."""
    if not is_own_path(path):
        return None
    name = re.sub(_DATED, "", os.path.basename(path))
    return next((o.category for o in OWN if o.name == name), None)


def source_hash(folder):
    """One hash of every file's path and bytes, in a fixed order, so the same
    folder gives the same hash on every machine."""
    h = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames.sort()
        for fn in sorted(filenames):
            fs = os.path.join(dirpath, fn)
            h.update(os.path.relpath(fs, folder).replace(os.sep, "/").encode() + b"\0")
            with open(fs, "rb") as f:
                for chunk in iter(lambda: f.read(_HASH_CHUNK), b""):
                    h.update(chunk)
            h.update(b"\0")
    return h.hexdigest()


def _stamp(path):
    try:
        with open(path + _STAMP_EXT, encoding="ascii") as f:
            return f.read().strip()
    except OSError:
        return ""


def _with_source(own, fn):
    """``fn(folder)`` on ``own``'s source folder, staged first if it is."""
    if not own.stage:
        return fn(os.path.join(SOURCE_ROOT, own.folder))
    with tempfile.TemporaryDirectory(prefix=own.name + "-") as dest:
        own.stage(dest)
        return fn(dest)


def fresh(own):
    """Whether the committed ZIM was built from the source as it is now."""
    path = zim_path(own)
    return bool(path) and _with_source(own, source_hash) == _stamp(path)


def build(own):
    """Build ``own`` when its source changed since the committed file was
    made. Returns the ZIM's path when a new file was written, else None."""

    def _build(folder):
        from zimi import creator

        old = zim_path(own)
        want = source_hash(folder)
        if old and _stamp(old) == want:
            return None
        os.makedirs(OUT_DIR, exist_ok=True)
        path = _new_path(own, old)
        # Built beside the old one, then swapped in: never half a file.
        new = path + ".new.zim"
        for stale in (new, new + ".tmp"):
            if os.path.exists(stale):
                os.remove(stale)
        creator.create_folder_zim(folder, out_path=new, register=False)
        os.replace(new, path)
        with open(path + _STAMP_EXT, "w", encoding="ascii") as f:
            f.write(want + "\n")
        if old and old != path:  # the last build's file: one file per ZIM
            for gone in (old, old + _STAMP_EXT):
                if os.path.exists(gone):
                    os.remove(gone)
        return path

    return _with_source(own, _build)


def main(argv=None):
    """``python -m zimi.ownzims [--check]``: build what changed, or (--check)
    list what is stale and exit 1."""
    argv = sys.argv[1:] if argv is None else argv
    if not all(os.path.isdir(os.path.join(SOURCE_ROOT, o.folder)) for o in OWN):
        print("the ZIMs' source folders are in a repo checkout, not an installed package")
        return 2
    if "--check" in argv:
        stale = [o.name for o in OWN if not fresh(o)]
        for name in stale:
            print("%s is older than its source: run python -m zimi.ownzims" % name)
        return 1 if stale else 0
    for own in OWN:
        path = build(own)
        print(
            "built %s (%d KB)" % (path, os.path.getsize(path) // 1024)
            if path
            else "%s is current" % os.path.basename(zim_path(own))
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
