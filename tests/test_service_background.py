"""``zimi serve -d`` and the systemd unit's quoting: review findings on #141."""

import os
import signal
import socket
import subprocess
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from zimi import service  # noqa: E402

posix = pytest.mark.skipif(not hasattr(os, "fork"), reason="-d needs fork")


def test_a_path_with_a_space_is_one_execstart_word():
    assert (
        service._exec_quote("/var/lib/zimi/venv/bin/python")
        == "/var/lib/zimi/venv/bin/python"
    )
    assert (
        service._exec_quote("/srv/my zimi/venv/bin/python")
        == '"/srv/my zimi/venv/bin/python"'
    )
    assert service._exec_quote("/a/b%c$d") == "/a/b%%c$$d"
    text = service.unit_text("/srv/my zimi/venv/bin/python")
    assert 'ExecStart="/srv/my zimi/venv/bin/python" -m zimi serve' in text


@posix
def test_a_pid_file_nobody_holds_is_stale_even_when_the_pid_is_alive(tmp_path):
    pid_path = tmp_path / "zimi.pid"
    pid_path.write_text(
        str(os.getpid())
    )  # a reused pid: alive, but not a Zimi holding the file
    assert service._running(str(pid_path)) is None


@posix
def test_a_held_pid_file_is_a_running_server(tmp_path):
    import fcntl

    pid_path = tmp_path / "zimi.pid"
    pid_path.write_text("4242")
    with open(pid_path) as holder:
        fcntl.flock(holder, fcntl.LOCK_EX)
        assert service._running(str(pid_path)) == 4242
    assert service._running(str(pid_path)) is None


_START = """
import socket, sys, time
sys.path.insert(0, %(root)r)
from zimi import service
service.daemonize(%(data)r, '127.0.0.1', %(port)d)
if %(fail)s:
    sys.exit(3)
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', %(port)d)); s.listen(); time.sleep(30)
"""


def _start(tmp_path, port, fail=False):
    code = _START % {"root": ROOT, "data": str(tmp_path), "port": port, "fail": fail}
    return subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=30
    )


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@posix
def test_background_start_reports_ready_refuses_a_second_and_a_failed_start_says_so(
    tmp_path,
):
    port = _free_port()
    out = _start(tmp_path, port)
    pid = int((tmp_path / "zimi.pid").read_text())
    try:
        assert out.returncode == 0 and "is running in the background" in out.stdout, (
            out.stdout,
            out.stderr,
        )
        assert (os.stat(tmp_path / "zimi.pid").st_mode & 0o077) == 0
        again = _start(tmp_path, port)
        assert again.returncode != 0 and "already running" in again.stderr
    finally:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.3)
    # A server that dies before it listens is reported, not claimed to run.
    dead = _start(tmp_path, _free_port(), fail=True)
    assert dead.returncode != 0 and "did not start" in dead.stderr, (
        dead.stdout,
        dead.stderr,
    )
