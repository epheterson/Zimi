"""``zimi service``: the systemd unit that runs Zimi at boot after a pip install.

The unit ships inside the package (assets/zimi.service), so a pip user has it
without a checkout. ``print`` shows it, ``install`` writes it where systemd
looks; both point ExecStart at the Python this command runs under, which for
the documented install is /var/lib/zimi/venv/bin/python.
"""

import os
import sys

UNIT_PATH = "/etc/systemd/system/zimi.service"
_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
_TEMPLATE = os.path.join(_ASSETS, "zimi.service")
_PORTABLE_TEMPLATE = os.path.join(_ASSETS, "zimi-portable.service")


def _owner(path):
    """The account that owns this folder: the one that should run a service kept in it."""
    try:
        import pwd

        return pwd.getpwuid(os.stat(path).st_uid).pw_name
    except (ImportError, KeyError, OSError):
        return "root"


def _unit_word(path):
    """``path`` as one word of a systemd list directive: a folder with a space would otherwise split in two, and
    systemd reads % in a unit itself."""
    path = path.replace("%", "%%")
    if not any(c.isspace() or c in "\"'\\" for c in path):
        return path
    return '"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _exec_quote(path):
    """``path`` as one ExecStart word (which also reads $ in a unit)."""
    return _unit_word(path.replace("$", "$$"))


def unit_text(python=None, exe=None):
    """The unit, with ExecStart on ``python`` (this interpreter by default).

    A frozen portable build has no Python to point at: ``exe`` (the executable itself, the default when
    frozen) selects the portable unit, which runs that file as the folder's owner with its state beside it.
    """
    exe = exe or (
        os.path.realpath(sys.executable) if getattr(sys, "frozen", False) else None
    )
    if exe and not python:
        folder = os.path.dirname(exe)
        with open(_PORTABLE_TEMPLATE, encoding="utf-8") as f:
            text = f.read()
        for key, value in (
            ("@EXE@", _exec_quote(exe)),
            ("@DIR@", folder.replace("%", "%%")),  # WorkingDirectory takes one path, spaces and all
            ("@DIRQ@", _unit_word(folder)),  # RequiresMountsFor takes a list, so a space must be quoted
            ("@USER@", _owner(folder)),
        ):
            text = text.replace(key, value)
        return text
    with open(_TEMPLATE, encoding="utf-8") as f:
        return f.read().replace("@PYTHON@", _exec_quote(python or sys.executable))


def cli_service(args):
    text = unit_text()
    if args.action == "print":
        sys.stdout.write(text)
        return
    target = args.to or UNIT_PATH
    try:
        with open(target, "w", encoding="utf-8") as f:
            f.write(text)
    except PermissionError:
        sys.exit(
            f"zimi: cannot write {target}: run it with sudo (or --to a path you can write)"
        )
    except OSError as e:
        sys.exit(f"zimi: cannot write {target}: {e.strerror}")
    print(
        f"Wrote {target}. Next: sudo systemctl daemon-reload && sudo systemctl enable --now zimi"
    )


# ``zimi serve -d``: run in the background the way ``kiwix-serve -d`` does (asked on #137), for a Pi or a USB disk
# with no systemd unit. The server detaches from the terminal, writes its process id and its output beside its data,
# and the command that started it returns at once.
PID_NAME = "zimi.pid"
LOG_NAME = "zimi.log"
READY_WAIT_TICKS = (
    100  # tenths of a second the starting command waits to see the server listen
)


def _running(pid_path):
    """The pid a live Zimi wrote here, or None. The running server holds a lock on this file for as long as it
    lives, so a stale file (a crash, a reused pid) is told from a live one by the lock, never by the pid alone.
    """
    import fcntl

    try:
        with open(pid_path, "r", encoding="utf-8") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except OSError:
                return int(f.read().strip())  # someone holds it: that is the server
            return None  # nobody does: left behind
    except (OSError, ValueError):
        return None


def _wait_ready(pid_path, host, port, log_path):
    """The first parent's wait: until the server is listening, or has died, or a few seconds have passed (a big
    library takes longer to load, and the person is told where the log is). Returns a line to print.
    """
    import time

    gone = 0
    for _ in range(READY_WAIT_TICKS):
        pid = _running(pid_path)
        if pid and (int(port) == 0 or _port_taken(host, port)):  # port 0: the system picks, so the pid is the signal
            return f"Zimi is running in the background (pid {pid}, log {log_path})."
        # The file exists but nothing holds it: the server started and is gone (a few ticks, since it locks the
        # file a moment before it writes its pid).
        gone = gone + 1 if os.path.exists(pid_path) and not pid else 0
        if gone >= 3:
            break
        time.sleep(0.1)
    pid = _running(pid_path)
    if pid:
        return f"Zimi is starting in the background (pid {pid}); watch {log_path} for when it is ready."
    sys.exit(f"zimi: the background server did not start; the reason is in {log_path}")


def _port_taken(host, port):
    """Whether something already listens where this server would: a second start must say so, not claim to run.
    It binds as the server does (SO_REUSEADDR), so a port a stopped Zimi left in TIME_WAIT counts as free. It never
    connects anywhere."""
    import socket

    probe = socket.socket(
        socket.AF_INET6 if ":" in str(host) else socket.AF_INET, socket.SOCK_STREAM
    )
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((host, int(port)))
        return False
    except OSError:
        return True
    finally:
        probe.close()


def daemonize(data_dir, host="0.0.0.0", port=8899):
    """Detach this process (POSIX double fork); the parent prints where things went and exits."""
    if not hasattr(os, "fork"):
        sys.exit(
            "zimi: -d needs a POSIX system; on Windows run Zimi as a service or from the desktop app"
        )
    data_dir = os.path.abspath(data_dir)
    os.makedirs(data_dir, exist_ok=True)
    pid_path, log_path = os.path.join(data_dir, PID_NAME), os.path.join(
        data_dir, LOG_NAME
    )
    other = _running(pid_path)
    if other:
        sys.exit(
            f"zimi: already running in the background (pid {other}); stop it with: kill {other}"
        )
    if os.path.exists(pid_path):
        os.remove(pid_path)  # left behind by a server that is gone
    if _port_taken(host, port):
        sys.exit(
            f"zimi: port {port} is already in use; stop what is on it or pass --port"
        )
    if os.fork() > 0:
        print(_wait_ready(pid_path, host, port, log_path))
        print(f"Stop it with: kill $(cat {pid_path})")
        sys.stdout.flush()
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    # The working directory stays: a relative --zim-dir or --data-dir (zimi serve -d --zim-dir ./zims, on a USB disk) is
    # read after this, and the server holds files on that disk anyway.
    log = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.close(null)
    os.close(log)
    sys.stdout = os.fdopen(1, "w", buffering=1)
    sys.stderr = os.fdopen(2, "w", buffering=1)
    # The lock is the claim: two starts racing over the file cannot both hold it, and the loser leaves the winner's
    # file alone. The descriptor stays open (and so locked) for the life of the server.
    import fcntl

    fd = os.open(pid_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit("zimi: another background start got there first")
    os.ftruncate(fd, 0)
    os.write(fd, str(os.getpid()).encode())
    import atexit

    mine = str(os.getpid())

    def _forget():
        try:
            with open(pid_path, encoding="utf-8") as f:
                if f.read().strip() == mine:
                    os.remove(pid_path)
        except OSError:
            pass

    atexit.register(_forget)
