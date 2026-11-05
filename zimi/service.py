"""``zimi service``: the systemd unit that runs Zimi at boot after a pip install.

The unit ships inside the package (assets/zimi.service), so a pip user has it
without a checkout. ``print`` shows it, ``install`` writes it where systemd
looks; both point ExecStart at the Python this command runs under, which for
the documented install is /var/lib/zimi/venv/bin/python.
"""

import os
import sys

UNIT_PATH = "/etc/systemd/system/zimi.service"
_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "zimi.service")


def unit_text(python=None):
    """The unit, with ExecStart on ``python`` (this interpreter by default)."""
    with open(_TEMPLATE, encoding="utf-8") as f:
        return f.read().replace("@PYTHON@", python or sys.executable)


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
        sys.exit(f"zimi: cannot write {target}: run it with sudo (or --to a path you can write)")
    except OSError as e:
        sys.exit(f"zimi: cannot write {target}: {e.strerror}")
    print(f"Wrote {target}. Next: sudo systemctl daemon-reload && sudo systemctl enable --now zimi")


# ``zimi serve -d``: run in the background the way ``kiwix-serve -d`` does (asked on #137), for a Pi or a USB disk
# with no systemd unit. The server detaches from the terminal, writes its process id and its output beside its data,
# and the command that started it returns at once.
PID_NAME = "zimi.pid"
LOG_NAME = "zimi.log"


def _running(pid_path):
    """The pid a live Zimi wrote here, or None (no file, unreadable, or that process is gone)."""
    try:
        with open(pid_path, encoding="utf-8") as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def _port_taken(host, port):
    """Whether something already listens where this server would: a second start must say so, not claim to run.
    Asked by connecting, not by binding: a listener answers, and a port a stopped Zimi left in TIME_WAIT does not."""
    import socket

    target = "127.0.0.1" if str(host) in ("", "0.0.0.0") else "::1" if str(host) == "::" else str(host)
    try:
        socket.create_connection((target, int(port)), timeout=0.5).close()
        return True
    except OSError:
        return False


def daemonize(data_dir, host="0.0.0.0", port=8899):
    """Detach this process (POSIX double fork); the parent prints where things went and exits."""
    if not hasattr(os, "fork"):
        sys.exit("zimi: -d needs a POSIX system; on Windows run Zimi as a service or from the desktop app")
    os.makedirs(data_dir, exist_ok=True)
    pid_path, log_path = os.path.join(data_dir, PID_NAME), os.path.join(data_dir, LOG_NAME)
    other = _running(pid_path)
    if other:
        sys.exit(f"zimi: already running in the background (pid {other}); stop it with: kill {other}")
    if _port_taken(host, port):
        sys.exit(f"zimi: port {port} is already in use; stop what is on it or pass --port")
    if os.fork() > 0:
        # The first parent waits only for the pid file, so the person sees where the server is before the prompt.
        for _ in range(50):
            if os.path.exists(pid_path):
                break
            import time

            time.sleep(0.1)
        print(f"Zimi is running in the background (pid file {pid_path}, log {log_path}).")
        print(f"Stop it with: kill $(cat {pid_path})")
        sys.stdout.flush()
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir("/")
    log = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.close(null)
    os.close(log)
    sys.stdout = os.fdopen(1, "w", buffering=1)
    sys.stderr = os.fdopen(2, "w", buffering=1)
    with open(pid_path, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
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
