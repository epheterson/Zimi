"""The server's debug log: what every window does, in one rolling file.

"for debug logs, I want it to be an attribute of the server.
So everything I do is now debug log until we turn it off." While it is on, each
open window records what its person taps and what the app does (static/debuglog.js)
and posts it here; this appends it, as JSON lines, to ``debug/zimi-debug.jsonl`` in
the data folder. One file, read in one command, instead of a description and a
screenshot.

On or off: ZIMI_DEBUG_LOG (1 on, 0 off, wins over the saved choice) or the admin
switch in Manage (/manage/debuglog), which every open window hears at once
(changes.py topic "debuglog"). Off, nothing is kept and the client loads nothing.

The file rolls fast on purpose: at MAX_BYTES it becomes ``.1`` (older ones shift
to ``.2``...), KEEP files in all, so the disk holds at most KEEP * MAX_BYTES.
"""

import json
import logging
import os
import threading
import time

from zimi import changes

log = logging.getLogger("zimi")

ENV = "ZIMI_DEBUG_LOG"
PREF = "debug_log"  # the saved choice, in the app prefs file (manage._read_app_update_prefs)
MAX_BYTES = 2 * 1024 * 1024  # a file rolls at this size
KEEP = 4  # files kept: the live one and KEEP - 1 older
MAX_EVENTS = 300  # per batch
MAX_LINE = 2048  # per event, once written
FILE = "zimi-debug.jsonl"

_lock = threading.Lock()


def _env():
    """True/False when the environment decides, else None."""
    v = os.environ.get(ENV, "").strip().lower()
    if not v:
        return None
    return v not in ("0", "false", "no", "off")


def env_locked():
    return _env() is not None


def enabled():
    """Whether the server keeps a debug log now: the environment, then the saved choice."""
    env = _env()
    if env is not None:
        return env
    from zimi import manage

    return manage._read_app_update_prefs().get(PREF) is True


def set_enabled(on):
    """Save the choice and tell every open window. False when the environment owns it."""
    if env_locked():
        return False
    from zimi import manage

    manage._write_app_update_prefs(**{PREF: bool(on)})
    changes.announce("debuglog", None)
    return True


def log_dir():
    from zimi import server

    return os.path.join(server.ZIMI_DATA_DIR, "debug")


def log_path():
    return os.path.join(log_dir(), FILE)


def _roll(path):
    """``path`` becomes ``path.1``, each older one a number up, the oldest dropped."""
    for n in range(KEEP - 1, 0, -1):
        src = path if n == 1 else "%s.%d" % (path, n - 1)
        if os.path.exists(src):
            os.replace(src, "%s.%d" % (path, n))


def _clean(ev):
    """One event as a small dict of short values, or None for anything else."""
    if not isinstance(ev, dict):
        return None
    out = {}
    for k, v in list(ev.items())[:12]:
        if isinstance(k, str) and len(k) <= 24:
            out[k] = (
                v if isinstance(v, (int, float, bool)) or v is None else str(v)[:600]
            )
    return out or None


def append(user, build, client, events):
    """Write a window's events as lines stamped with who and which build.
    Returns how many were kept (0 when off)."""
    if not enabled():
        return 0
    now = time.time()
    lines = []
    for ev in (events if isinstance(events, list) else [])[:MAX_EVENTS]:
        ev = _clean(ev)
        if ev is None:
            continue
        rec = {
            "at": round(now, 3),
            "user": user,
            "build": str(build or "")[:32],
            "client": str(client or "")[:32],
        }
        rec.update(ev)
        line = json.dumps(rec, separators=(",", ":"), ensure_ascii=False)
        if len(line) > MAX_LINE:
            rec = {k: rec[k] for k in ("at", "user", "build", "client")}
            rec["note"] = "event too long, dropped"
            line = json.dumps(rec, separators=(",", ":"))
        lines.append(line)
    if not lines:
        return 0
    data = ("\n".join(lines) + "\n").encode("utf-8")
    path = log_path()
    try:
        with _lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            try:
                if os.path.getsize(path) + len(data) > MAX_BYTES:
                    _roll(path)
            except OSError:
                pass
            with open(path, "ab") as f:
                f.write(data)
    except OSError:
        log.warning("debug log: could not write %s", path)
        return 0
    return len(lines)
