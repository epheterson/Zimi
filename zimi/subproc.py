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

import atexit
import ctypes
import logging
import os
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
import weakref

log = logging.getLogger(__name__)

__all__ = ["popen", "run", "external_env", "stop", "stop_all", "idle_io", "wait_for_memory", "stopping"]

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
    """The frozen app itself: its unpack folder and its executable file, as the bootloader wrote them and with symlinks
    resolved, each normalised for comparing. Not the folder the executable sits in: a portable build keeps its data
    (zims/, zimi-data/, the voices venv) beside it, and that is no part of the app (#151)."""
    raw = {getattr(sys, "_MEIPASS", None), sys.executable}
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
    """True when ``program`` is the frozen app's executable or a file inside its unpack folder. A bare name is no path (see ``_resolved``)."""
    try:
        if not os.path.dirname(os.fspath(program)):
            return False
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
        if name in env:
            kept = [e for e in env[name].split(os.pathsep) if e and not _names_bundle(e)]
            if kept:
                env[name] = os.pathsep.join(kept)   # the user's own entries stay
            else:
                env.pop(name)
    for name in [k for k in env if k.startswith(_PYI_PREFIX)]:
        del env[name]
    return env


def _resolved(program, env=None):
    """``program`` as the child would find it: a bare name ("piper", "say") is looked up on the child's own PATH, not taken
    as a file of the folder Zimi was started from."""
    try:
        program = os.fspath(program)
    except TypeError:
        return program
    if os.path.dirname(program):
        return program
    path = (os.environ if env is None else env).get("PATH")
    return shutil.which(program, path=path) or program


def _for_program(cmd, kwargs):
    """Give a child that is not part of the bundle the machine's environment."""
    if getattr(sys, "frozen", False):
        program = cmd[0] if isinstance(cmd, (list, tuple)) else cmd
        if not _in_bundle(_resolved(program, kwargs.get("env"))):
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
    proc = subprocess.Popen(cmd, **_for_program(cmd, kwargs))
    try:
        _live.add(proc)
    except TypeError:
        pass   # a test double that is no process
    return proc


# Every child popen started and nobody has reaped yet. A child lives in a group of its own, so the group the server
# belongs to going away (docker stop, systemd) does not reach it: stop_all, at exit, does.
_live = weakref.WeakSet()
# Set when the server is told to stop, so a background builder waiting on the machine gives up instead of sleeping on.
stopping = threading.Event()
_STOP_ALL_GRACE = 5.0


def stop_all(grace=_STOP_ALL_GRACE):
    """End every child still running, as one group ask and one wait, then reap each. Runs at exit (SIGTERM goes through
    sys.exit), so a stop during a cold start leaves no builder child behind. Never raises."""
    stopping.set()
    procs = [p for p in list(_live) if p.poll() is None]
    for p in procs:
        terminate(p)
    deadline = time.monotonic() + grace
    for p in procs:
        try:
            p.wait(timeout=max(0.0, deadline - time.monotonic()))
        except Exception:
            pass
    for p in procs:
        stop(p, grace=0.1)


atexit.register(stop_all)


# ---------------------------------------------------------------------------
# Being a good guest: idle disk priority and a memory floor for background builds
# ---------------------------------------------------------------------------

_IOPRIO_CLASS_IDLE = 3
_IOPRIO_CLASS_SHIFT = 13
_IOPRIO_WHO_PROCESS = 1   # with who 0: the calling thread
_IOPRIO_SET_SYSCALL = {"x86_64": 251, "aarch64": 30, "arm64": 30, "i386": 289, "i686": 289, "armv7l": 314}
_IOPOL_TYPE_DISK = 0
_IOPOL_SCOPE_THREAD = 1
_IOPOL_THROTTLE = 3


def idle_io():
    """Put the calling thread (a builder child's only thread, or the server's startup worker) at the lowest disk
    priority: on Linux the idle I/O class, on macOS the throttled disk policy. ``nice`` only orders CPU, and on a
    spinning array a nice-19 scan still queues its reads ahead of a page someone opened. True when the system took it;
    the idle class is silently ignored by an I/O scheduler that has no classes (mq-deadline, none), which is the
    kernel's answer and not ours to see."""
    try:
        if sys.platform.startswith("linux"):
            number = _IOPRIO_SET_SYSCALL.get(platform.machine())
            if number is None:
                return False
            libc = ctypes.CDLL(None, use_errno=True)
            value = _IOPRIO_CLASS_IDLE << _IOPRIO_CLASS_SHIFT
            return libc.syscall(number, _IOPRIO_WHO_PROCESS, 0, value) == 0
        if sys.platform == "darwin":
            libc = ctypes.CDLL(None, use_errno=True)
            return libc.setiopolicy_np(_IOPOL_TYPE_DISK, _IOPOL_SCOPE_THREAD, _IOPOL_THROTTLE) == 0
    except Exception:
        pass
    return False


def _read_int(path):
    try:
        with open(path) as f:
            text = f.read().strip()
        return None if text == "max" else int(text)
    except (OSError, ValueError):
        return None


def available_mb():
    """Memory this process tree may still use, in MB: what the machine reports free (reclaimable cache counted), or what
    its container limit leaves, whichever is less. None where neither can be read (macOS, Windows): no floor then."""
    found = []
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    found.append(int(line.split()[1]) // 1024)
                    break
    except (OSError, ValueError, IndexError):
        pass
    for limit_file, used_file in (
        ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
        ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    ):
        limit, used = _read_int(limit_file), _read_int(used_file)
        if limit is not None and used is not None and limit < (1 << 50):
            found.append(max(0, limit - used) // (1024 * 1024))
            break
    return min(found) if found else None


MIN_FREE_MB = 300          # a Q-ID or title build child peaks near 300 MB: do not start one below this
MEMORY_WAIT_MAX_S = 300.0  # one wait gives up after this, so a host that stays tight still gets its builds, slowly
_MEMORY_POLL_S = 2.0


def wait_for_memory(floor_mb=None, max_wait=MEMORY_WAIT_MAX_S, probe=None):
    """Sleep until at least ``floor_mb`` is free (``ZIMI_BUILD_MIN_FREE_MB``, else ``MIN_FREE_MB``), the wait is spent, or
    the server is stopping. True when memory is fine, False when it gave up. ``ZIMI_BUILD_MIN_FREE_MB=0`` turns it off."""
    if floor_mb is None:
        try:
            floor_mb = int(os.environ.get("ZIMI_BUILD_MIN_FREE_MB", MIN_FREE_MB))
        except ValueError:
            floor_mb = MIN_FREE_MB
    if floor_mb <= 0:
        return True
    probe = probe or available_mb
    deadline = time.monotonic() + max_wait
    while True:
        free = probe()
        if free is None or free >= floor_mb:
            return True
        if stopping.is_set() or time.monotonic() >= deadline:
            return False
        stopping.wait(min(_MEMORY_POLL_S, max(0.0, deadline - time.monotonic())))


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
