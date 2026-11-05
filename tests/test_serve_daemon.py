"""`zimi serve -d` (#137): the server goes to the background with its pid and log beside its data, and the command returns."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.mark.skipif(not hasattr(os, "fork"), reason="-d is POSIX only")
def test_serve_d_detaches_and_leaves_a_pid_and_a_log(tmp_path):
    data, zims, port = tmp_path / "data", tmp_path / "zims", _free_port()
    zims.mkdir()
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_BUILTIN_ZIMS="0", PYTHONPATH=ROOT)
    started = time.monotonic()
    out = subprocess.run(
        [sys.executable, "-m", "zimi", "serve", "-d", "--host", "127.0.0.1", "--port", str(port),
         "--zim-dir", str(zims), "--data-dir", str(data)],
        env=env, capture_output=True, text=True, timeout=60, cwd=ROOT,
    )
    assert out.returncode == 0, out.stderr
    assert time.monotonic() - started < 30, "the command returns, the server stays"
    pid_path = data / "zimi.pid"
    assert pid_path.exists(), out.stdout
    pid = int(pid_path.read_text(encoding="utf-8"))
    try:
        assert "running in the background" in out.stdout, out.stdout
        health = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    health = json.load(r)
                break
            except OSError:
                time.sleep(0.3)
        assert health is not None, (data / "zimi.log").read_text(encoding="utf-8") if (data / "zimi.log").exists() else "no log"
        assert (data / "zimi.log").exists()
        # A second start while it runs says so and leaves the running one alone.
        again = subprocess.run(
            [sys.executable, "-m", "zimi", "serve", "-d", "--host", "127.0.0.1", "--port", str(port),
             "--zim-dir", str(zims), "--data-dir", str(data)],
            env=env, capture_output=True, text=True, timeout=60, cwd=ROOT,
        )
        assert again.returncode != 0 and "already running" in again.stderr, (again.stdout, again.stderr)
        assert int(pid_path.read_text(encoding="utf-8")) == pid
    finally:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except OSError:
                break
    time.sleep(0.5)
    assert not pid_path.exists(), "a stopped server takes its pid file with it"
