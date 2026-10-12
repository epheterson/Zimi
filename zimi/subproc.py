"""Starting and stopping the children Zimi shells out to.

Zimi runs three long-lived subprocesses — warc2zim's sidecar, the zimit
container, yt-dlp — and every one of them is a process TREE, not a process. The
sidecar starts Chrome, which starts a renderer per tab, a GPU process and a
zygote. Terminating the one PID Python holds leaves the rest running, adopted
by init.

That would be untidy and little else, except that none of it was being reaped
either. Both streaming runners collected the child only on the happy path, so
every cancel, timeout, or exception out of the progress sink — which is the
cancellation checkpoint and therefore RAISES by design — skipped both the kill
and the reap. On Eric's NAS, where the container runs without an init process
and PID 1 is `python3 -m zimi serve` (which reaps nothing), that left 20
zombies in 21 hours: 12 chrome-headless, 7 python3, 1 wget.

The zombies were the symptom worth noticing, not the cost. A zombie is a few
bytes and a PID slot. What preceded each one is a browser that should have
stopped and did not, still reading from a saturated disk, for a capture whose
result had already been thrown away.

So: start every child in a group of its own, and stop the group. Two functions,
used by both runners, so there is one answer to "how does a child die here".
"""

import logging
import os
import signal
import subprocess
import sys

log = logging.getLogger(__name__)

__all__ = ["popen", "stop"]

# How long a child gets to leave politely before it is killed. Generous enough
# for warc2zim to close a ZIM it is midway through writing, short enough that
# cancelling a capture feels like cancelling it.
TERMINATE_GRACE = 10.0
# And how long the kill itself gets. If a process is unkillable it is blocked
# in the kernel, and waiting longer will not change that.
KILL_GRACE = 5.0

_WINDOWS = sys.platform == "win32"


def popen(cmd, **kwargs):
    """``subprocess.Popen``, with the child in a process group of its own.

    That group is the whole point: it is what makes ``stop`` able to reach
    Chrome's renderers rather than only the process Python is holding.

    On POSIX ``start_new_session`` gives the child a new session and so a new
    process group. On Windows the equivalent is a creation flag, and the group
    is torn down by ``taskkill /T`` rather than by a signal — see ``stop``.
    """
    if _WINDOWS:
        kwargs.setdefault(
            "creationflags",
            kwargs.pop("creationflags", 0) | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    else:
        kwargs.setdefault("start_new_session", True)
    return subprocess.Popen(cmd, **kwargs)


def stop(proc, grace=TERMINATE_GRACE):
    """End ``proc`` and everything it started, then reap it.

    Safe to call on a child that has already exited, which is the common case:
    this belongs in a ``finally``, where most of the time the command simply
    finished. Then it is one ``poll()`` and a ``wait()`` that returns at once.

    Never raises. It runs on the way out of a capture, often while another
    exception is already travelling, and a failure to kill something must not
    replace the reason the caller was leaving.

    Returns the exit status, or None if it could not be collected.
    """
    if proc is None:
        return None
    try:
        if proc.poll() is None:
            _signal_group(proc, hard=False)
            try:
                proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                log.debug("pid %s ignored the polite ask; killing", proc.pid)
                _signal_group(proc, hard=True)
                try:
                    proc.wait(timeout=KILL_GRACE)
                except subprocess.TimeoutExpired:
                    # Blocked in the kernel. Waiting longer will not help, and
                    # holding the caller here would be worse than a stray PID.
                    log.warning("pid %s did not die; leaving it", proc.pid)
                    return None
        # Always: a child that exited on its own is still holding a slot in the
        # process table until somebody collects it. This is the call the old
        # code skipped on every path but the happy one.
        return proc.wait(timeout=KILL_GRACE)
    except Exception as e:
        log.debug("could not stop pid %s: %s", getattr(proc, "pid", "?"), e)
        return None
    finally:
        _close_pipes(proc)


def terminate(proc):
    """Ask the child's whole group to stop, from any thread, without reaping it
    or closing its pipes: the thread that owns them (its ``finally`` calls
    ``stop``) does that. Never raises."""
    try:
        if proc is not None and proc.poll() is None:
            _signal_group(proc, False)
    except Exception:
        pass


def _signal_group(proc, hard):
    """Ask the child's whole group to stop, or make it.

    Falls back to the single process whenever the group cannot be addressed —
    it may have exited between the poll and here, and on some platforms it was
    never in a group of its own to begin with. Half a kill beats none.
    """
    if _WINDOWS:
        # TerminateProcess does not touch children, so the tree is walked by
        # taskkill. /T is the tree, /F is the force; there is no polite form
        # that reaches descendants, so both passes use it.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=KILL_GRACE,
            )
            return
        except Exception as e:
            log.debug("taskkill did not reach pid %s: %s", proc.pid, e)
    else:
        sig = signal.SIGKILL if hard else signal.SIGTERM
        try:
            os.killpg(os.getpgid(proc.pid), sig)
            return
        except (ProcessLookupError, PermissionError, OSError) as e:
            log.debug("could not signal the group of pid %s: %s", proc.pid, e)
    try:
        proc.kill() if hard else proc.terminate()
    except Exception as e:
        log.debug("could not signal pid %s: %s", getattr(proc, "pid", "?"), e)


def _close_pipes(proc):
    """Let go of the child's pipes. An open read end keeps a file descriptor
    for a process that has finished talking."""
    for pipe in (proc.stdout, proc.stderr, proc.stdin):
        if pipe is None:
            continue
        try:
            pipe.close()
        except Exception:
            pass
