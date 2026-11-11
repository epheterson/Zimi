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

__all__ = ["popen", "run", "external_env", "stop"]

# How long a child gets to leave politely before it is killed. Generous enough
# for warc2zim to close a ZIM it is midway through writing, short enough that
# cancelling a capture feels like cancelling it.
TERMINATE_GRACE = 10.0
# And how long the kill itself gets. If a process is unkillable it is blocked
# in the kernel, and waiting longer will not change that.
KILL_GRACE = 5.0

_WINDOWS = sys.platform == "win32"

# What a PyInstaller bootloader points at its own folder so the frozen program
# finds its own libraries. A program that is not part of the bundle (the
# machine's python3, uv, node) given these loads the bundle's older libssl
# instead of its own and cannot import ssl (issue #151). The bootloader keeps
# the original of each library path in <NAME>_ORIG.
_LOADER_PATHS = ("LD_LIBRARY_PATH", "LIBPATH", "SHLIB_PATH", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH")
_PYTHON_PATHS = ("PYTHONHOME", "PYTHONPATH")
_PYI_PREFIX = "_PYI_"


def _bundle_dirs():
    """The frozen app's folders, as the bootloader wrote them and with symlinks resolved, each normalised for comparing."""
    raw = {getattr(sys, "_MEIPASS", None), os.path.dirname(sys.executable)}
    raw = {d for d in raw if d}
    return sorted({_norm(d) for d in raw} | {_norm(os.path.realpath(d)) for d in raw})


def _norm(path, mod=os.path):
    """A path in one spelling: separators, case (on Windows) and ``..`` settled, no trailing separator."""
    return mod.normcase(mod.normpath(path))


def _under(path, root, mod=os.path):
    """True when ``path`` is ``root`` or inside it, on either platform's rules (``mod``: posixpath or ntpath)."""
    path, root = _norm(path, mod), _norm(root, mod)
    return path == root or path.startswith(root + mod.sep)


def _in_bundle(program):
    """True when ``program`` is a file inside the frozen app's folder."""
    try:
        paths = {_norm(program), _norm(os.path.realpath(program))}
    except (TypeError, ValueError, OSError):
        return False
    return any(_under(p, d) for p in paths for d in _bundle_dirs())


def _names_bundle(value):
    """True when one entry of a path list (PYTHONHOME, PYTHONPATH) is the bundle or inside it."""
    bundle = _bundle_dirs()
    return any(_under(entry, d) for entry in value.split(os.pathsep) if entry for d in bundle)


def external_env(env=None):
    """The environment for a program that is NOT part of the bundle: ``env``
    (default: ours) with the frozen app's loader and Python variables put back
    to what the user had. Unchanged when not frozen, so a source or pip install
    behaves exactly as before. Never changes ``env`` itself."""
    env = dict(os.environ if env is None else env)
    if not getattr(sys, "frozen", False):
        return env
    for name in _LOADER_PATHS:
        orig = env.pop(name + "_ORIG", None)
        if orig is None:
            env.pop(name, None)
        else:
            env[name] = orig
    for name in _PYTHON_PATHS:
        if _names_bundle(env.get(name, "")):
            env.pop(name)
    for name in [k for k in env if k.startswith(_PYI_PREFIX)]:
        del env[name]
    return env


def _for_program(cmd, kwargs):
    """Give a child that is not part of the bundle the machine's environment."""
    if getattr(sys, "frozen", False):
        program = cmd[0] if isinstance(cmd, (list, tuple)) else cmd
        if not _in_bundle(program):
            kwargs["env"] = external_env(kwargs.get("env"))
    return kwargs


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
    return subprocess.Popen(cmd, **_for_program(cmd, kwargs))


def run(cmd, **kwargs):
    """``subprocess.run`` for a short probe, with the same environment rule as
    ``popen``."""
    return subprocess.run(cmd, **_for_program(cmd, kwargs))


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
