"""What an open window should hear about the moment it changes: GET /events.

Eric, 2026-10-19: "I'd in general want the site to expect server-side changes
to anything at any time and update live." A change is announced here by the
code that made it (a topic, the account it belongs to, and the window that
made it); each open window holds one server-sent-events stream and hears the
changes that are its account's, then re-reads only what a change names. The
window that made a change is told who made it, so it skips its own echo.

Announcements carry no data, only that something changed: the window asks
for it through the endpoint that already decides who may read it.
"""

import collections
import secrets
import threading

# Topics: "settings" (an account's settings, users.change_settings) and
# "saved" (its saved store, users.sync_user_data), each an account's own;
# "library" (a ZIM added, removed or replaced, server._set_listing), every
# window's (announced for owner None).
TOPICS = ("settings", "saved", "library")
_LOG_MAX = 256  # announcements kept for a stream that was busy writing

# This run of the server: a window's place in the log ("<boot>.<seq>") from
# an earlier run means nothing here.
BOOT = secrets.token_hex(4)
_cond = threading.Condition()
_seq = 0
_log = collections.deque(maxlen=_LOG_MAX)  # (seq, topic, owner, by)


def resume_from(since):
    """Where a stream starts: after ``since`` (a place this run gave out, as
    ``place()`` writes it), else now; a place from another run (the server
    restarted) or none it can read starts before everything (-1), so the
    window hears every topic once."""
    with _cond:
        if not since:
            return _seq
        boot, _, seq = str(since).partition(".")
        if boot == BOOT and seq.isdigit() and int(seq) <= _seq:
            return int(seq)
        return -1


def place(seq):
    """A stream's place, as the window keeps it."""
    return "%s.%d" % (BOOT, seq)


def announce(topic, owner, by=None):
    """``topic`` changed for ``owner`` (an account's data name, or None for
    every window), made by the window ``by`` (its own id, or None)."""
    global _seq
    with _cond:
        _seq += 1
        _log.append(
            (_seq, topic, owner, by if isinstance(by, str) and len(by) <= 64 else None)
        )
        _cond.notify_all()


def wait(after, owner, timeout):
    """Changes for ``owner`` (None: a window no one is signed in to) and for
    every window, announced after ``after``, waiting up to ``timeout`` seconds
    for one: (latest number, [{"topic", "by"}]). A stream that fell further
    behind than the log keeps is told every topic changed."""
    with _cond:
        _cond.wait_for(lambda: _seq > after, timeout)
        latest = _seq
        if latest == after:
            return latest, []
        if not _log or _log[0][0] > after + 1:
            mine = TOPICS if owner else ("library",)
            return latest, [{"topic": t, "by": None} for t in mine]
        out, seen = [], set()
        for seq, topic, who, by in _log:
            if seq > after and who in (owner, None) and (topic, by) not in seen:
                seen.add((topic, by))
                out.append({"topic": topic, "by": by})
        return latest, out
