"""End-to-end smoke test: launch the server as a subprocess, wait for the
READY <port> line, hit a few endpoints, shut down.

This is the same contract the desktop-release CI workflow uses — by running
it as a regular pytest, we catch a missing READY emit (or a crash on cold
boot) on the PR rather than during the post-merge release pipeline.

The previous failure mode (caught against v1.6.4): server printed
"ZIM Reader API starting on port 0" but never emitted READY, so the
release smoke test timed out at 30s and no DMG/AppImage/Snap got attached
to the draft. Now this test fails loudly on the PR before merge.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
READY_RE = re.compile(rb"^READY (\d+)\s*$", re.MULTILINE)
READY_TIMEOUT_SEC = 30


def _wait_for_ready(proc: subprocess.Popen, log_path: str) -> int:
    """Poll the server's stdout file for `READY <port>`. Return the port
    or raise pytest.fail() with the captured stdout for debugging."""
    deadline = time.time() + READY_TIMEOUT_SEC
    while time.time() < deadline:
        if proc.poll() is not None:
            with open(log_path, "rb") as f:
                output = f.read().decode(errors="replace")
            pytest.fail(
                f"server exited early with code {proc.returncode}\n--- output ---\n{output}"
            )
        try:
            with open(log_path, "rb") as f:
                contents = f.read()
        except OSError:
            time.sleep(0.2)
            continue
        m = READY_RE.search(contents)
        if m:
            return int(m.group(1))
        time.sleep(0.2)
    proc.kill()
    with open(log_path, "rb") as f:
        output = f.read().decode(errors="replace")
    pytest.fail(
        f"server did not emit `READY <port>` within {READY_TIMEOUT_SEC}s\n"
        f"--- output ---\n{output}"
    )


@pytest.fixture
def serve_subprocess():
    """Start `python -m zimi serve --port 0` with an empty ZIM dir, yield
    (port, log_path), and clean up on teardown."""
    tmp_zim_dir = tempfile.mkdtemp(prefix="zimi-smoke-zims-")
    tmp_data_dir = tempfile.mkdtemp(prefix="zimi-smoke-data-")
    log_fd, log_path = tempfile.mkstemp(prefix="zimi-smoke-log-")
    os.close(log_fd)

    env = os.environ.copy()
    env["ZIM_DIR"] = tmp_zim_dir
    env["ZIMI_DATA_DIR"] = tmp_data_dir
    # Disable optional features that would pull network calls in CI.
    env["ZIMI_AUTO_UPDATE"] = "0"
    env["ZIMI_TORRENT"] = "0"
    env["ZIMI_PEER_DISCOVERY"] = "0"
    # PYTHONUNBUFFERED ensures the READY print isn't held in stdio buffers
    # — without flush=True or this env var, CI runners can stall.
    env["PYTHONUNBUFFERED"] = "1"

    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", "--port", "0"],
            cwd=REPO_ROOT,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )

    try:
        port = _wait_for_ready(proc, log_path)
        yield port, log_path
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        for p in (tmp_zim_dir, tmp_data_dir):
            shutil.rmtree(p, ignore_errors=True)
        try:
            os.remove(log_path)
        except OSError:
            pass


def _http_get_json(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _http_status(url: str, timeout: float = 5.0) -> int:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def test_serve_emits_ready_with_port(serve_subprocess):
    """READY <port> must be printed to stdout once the server has bound a
    port. CI smoke + the desktop launcher both depend on this contract."""
    port, _log = serve_subprocess
    assert 1 <= port <= 65535


def test_serve_health_endpoint_responds(serve_subprocess):
    port, _ = serve_subprocess
    data = _http_get_json(f"http://127.0.0.1:{port}/health")
    assert data["status"] == "ok"
    assert "version" in data
    assert isinstance(data.get("zim_count"), int)


def test_serve_list_endpoint_responds(serve_subprocess):
    """Empty ZIM dir → empty list, but the endpoint must still 200."""
    port, _ = serve_subprocess
    data = _http_get_json(f"http://127.0.0.1:{port}/list")
    assert isinstance(data, list)


def test_serve_search_endpoint_responds(serve_subprocess):
    port, _ = serve_subprocess
    data = _http_get_json(f"http://127.0.0.1:{port}/search?q=test&limit=1&fast=1")
    assert "results" in data
    assert "total" in data


def test_serve_web_ui_responds(serve_subprocess):
    """The `/` SPA shell must serve a 200, otherwise users see a blank screen."""
    port, _ = serve_subprocess
    assert _http_status(f"http://127.0.0.1:{port}/") == 200
