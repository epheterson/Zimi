"""Details files: what a ZIM's listings leave out, read once per ZIM in the
background into ``<data dir>/<kind>/<name>.db``.

ZimiTube (a video's description, speaker and date, each in a file of its own)
and the Bookshelf (a book's writers, subjects and the day it came to
Gutenberg, from its head) answer from a ZIM's listings at once and read the
rest here. One ZIM at a time per kind; a ZIM asked for while it waits or
builds is not asked for twice; a big ZIM is read in a child process
(search._build_index_isolated: libzim holds the GIL while it reads, and a
read on a server thread stalls every search); the file is checked against
the ZIM as the title index is, so it is read once per build of the ZIM.
"""

import logging
import os
import sqlite3
import threading
import time

from zimi import server as _srv

log = logging.getLogger("zimi")

# Past this many entries a details build runs in a process of its own. It
# reads one entry per video or book, not every entry, so it starts far lower
# than the title index's threshold.
ISOLATE_MIN_ENTRIES = 5_000
_WAIT_POLL_SECONDS = 0.02


class DetailsBuilder:
    """One kind's details: the file, its build, and what was read from it.

    ``kind`` names the folder in the data dir, the background job Manage
    shows, and the build search._build_index_child_main runs in a child;
    ``zims`` is the kind of ZIM (server._zim_kind) build_all covers, or a
    test of a library entry (a ZIM that feeds the app beside its kind).
    ``build(name, path)`` reads a ZIM into its file through write();
    ``load(rows)`` turns the file's rows into what the app keeps.
    ``lock`` is the app's own: what was read is kept under it, and
    ``on_keep(name, zim_path, details)`` runs inside it. ``gone(name)``,
    when given, is told when a ZIM left the library before it was read.
    ``table`` and ``columns`` spell the file's CREATE TABLE; changing them
    means bumping ``version``, or a file an earlier release wrote is taken
    as current and read with the wrong columns."""

    def __init__(
        self,
        kind,
        *,
        zims,
        label,
        what,
        version,
        table,
        columns,
        build,
        load,
        lock,
        on_keep,
        gone=None,
    ):
        self.kind = kind
        self.zims = zims
        self.label = label
        self.what = what
        self.version = version
        self.table = table
        self.columns = tuple(columns)
        self.build = build
        self.load = load
        self.lock = lock
        self.on_keep = on_keep
        self.gone = gone
        self._kept = {}  # name -> (real path of the ZIM it was read from, details)
        # One build at a time, as _build_all_title_lock serializes the title
        # index; _queued keeps a ZIM from being asked for twice while it waits.
        self._build_lock = threading.Lock()
        self._queue_lock = threading.Lock()
        self._queued = set()

    # ── the file ───────────────────────────────────────────────────────────

    def path(self, name):
        # Read at each call, not kept: ZIMI_DATA_DIR can be repointed after
        # import (and is, in the child process).
        return os.path.join(_srv.ZIMI_DATA_DIR, self.kind, f"{name}.db")

    def current(self, name, zim_path):
        """Whether ``name``'s file was built from this ZIM at this version:
        its mtime, else its uuid, checked as the title index is."""
        from zimi.search import _index_is_current

        return _index_is_current(self.path(name), zim_path, self.version)

    def write(self, zim_name, zim_path, archive, rows):
        """``rows`` into ``zim_name``'s file with the meta current() reads
        back, whole or not at all: written beside it, then renamed over it.
        Returns how many rows."""
        from zimi.search import _write_index_meta

        db_path = self.path(zim_name)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        tmp_path = db_path + ".tmp"
        if os.path.exists(tmp_path):
            os.remove(tmp_path)  # builds are serialized by _build_lock: an orphan
        conn = sqlite3.connect(tmp_path)
        try:
            conn.execute(f"CREATE TABLE {self.table} ({', '.join(self.columns)})")
            conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
            marks = ", ".join("?" * len(self.columns))
            conn.executemany(
                f"INSERT OR REPLACE INTO {self.table} VALUES ({marks})", rows
            )
            _write_index_meta(conn, archive, zim_path, self.version, len(rows))
            conn.commit()
        except Exception:
            conn.close()
            os.remove(tmp_path)
            raise
        conn.close()
        os.replace(tmp_path, db_path)
        return len(rows)

    def read(self, name):
        """Every row of ``name``'s file, its columns in order."""
        names = ", ".join(c.split()[0] for c in self.columns)
        conn = sqlite3.connect(self.path(name), timeout=5)
        try:
            return conn.execute(f"SELECT {names} FROM {self.table}").fetchall()
        finally:
            conn.close()

    # ── what was read ──────────────────────────────────────────────────────

    def kept(self, name, key):
        """What was read for ``name`` from the file ``key``; None when it is
        not read yet, or was read from an earlier build of the ZIM. A dict
        lookup, safe with or without the lock held."""
        got = self._kept.get(name)
        if got and got[0] == os.path.realpath(key):
            return got[1]
        return None

    def keep(self, name, key, details):
        """``details`` for ``name``, read from the file ``key``: {} when there
        is nothing to read, so nothing waits for it."""
        with self.lock:
            self._kept[name] = (os.path.realpath(key), details)
            self.on_keep(name, key, details)

    def forget(self):
        with self.lock:
            self._kept.clear()

    # ── the build ──────────────────────────────────────────────────────────

    def build_one(self, name):
        """Bring ``name``'s file up to date and keep what it holds."""
        from zimi.search import (
            _background_end,
            _background_fail,
            _background_ok,
            _background_start,
            _background_step,
            _build_index_isolated,
        )

        with self._build_lock:
            path = _srv.get_zim_files().get(name)
            if not path:
                if self.gone:
                    self.gone(name)
                return
            try:
                if not self.current(name, path):
                    t0 = time.time()
                    _background_start(self.kind)
                    _background_step(self.kind, name)
                    try:
                        _build_index_isolated(
                            self.kind,
                            name,
                            path,
                            self.build,
                            lambda _name: None,
                            min_entries=ISOLATE_MIN_ENTRIES,
                        )
                    finally:
                        _background_end(self.kind)
                    log.info(
                        "%s: read the %s of %s (%.1fs)",
                        self.label,
                        self.what,
                        name,
                        time.time() - t0,
                    )
                details = self.load(self.read(name))
                _background_ok(self.kind, name)
            except Exception as e:
                _background_fail(self.kind, name)
                # Kept empty until the next start rather than built again on
                # every request: a ZIM that cannot be read now will not be in
                # a second. A failed build leaves no file (write() is whole
                # or nothing), so the next start builds it again.
                log.warning("%s: %s of %s failed: %s", self.label, self.what, name, e)
                details = {}
            self.keep(name, path, details)

    def _claim(self, name):
        """True for the one caller that gets to build ``name`` now."""
        with self._queue_lock:
            if name in self._queued:
                return False
            self._queued.add(name)
            return True

    def _build_claimed(self, name):
        try:
            self.build_one(name)
        finally:
            with self._queue_lock:
                self._queued.discard(name)

    def request(self, name):
        """Start ``name``'s build in the background, unless it is already
        waiting or running. Returns at once."""
        if self._claim(name):
            threading.Thread(
                target=self._build_claimed,
                args=(name,),
                name=f"{self.kind}-details",
                daemon=True,
            ).start()

    def build_all(self):
        """Every ZIM of this kind, one after another, on the caller's thread
        (the startup worker's)."""
        ours = self.zims if callable(self.zims) else lambda z: z.get("kind") == self.zims
        for z in list(_srv._zim_list_cache or []):
            name = z.get("name")
            if ours(z) and name and self._claim(name):
                self._build_claimed(name)

    def wait(self, timeout=30):
        """Until no build waits or runs: True, or False at ``timeout``."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._queue_lock:
                if not self._queued:
                    return True
            time.sleep(_WAIT_POLL_SECONDS)
        return False
