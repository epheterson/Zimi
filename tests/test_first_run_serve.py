"""The first-run page, decided by a real `zimi serve` start.

Whether an install ran before is asked of the metadata cache, which the
start's own first scan writes. So it has to be asked before that scan, or a
fresh install that already has a ZIM would read as one that ran before and
never show its page (the 1.13.1 pre-ship review).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
from test_serve_smoke import REPO_ROOT, _wait_for_ready  # noqa: E402


def _setup_state(seed_cache):
    zim_dir = tempfile.mkdtemp(prefix="zimi-firstrun-zims-")
    data_dir = tempfile.mkdtemp(prefix="zimi-firstrun-data-")
    log_fd, log_path = tempfile.mkstemp(prefix="zimi-firstrun-log-")
    os.close(log_fd)
    build_fixture_zim(os.path.join(zim_dir, "fixture.zim"))
    if seed_cache:
        with open(os.path.join(data_dir, "cache.json"), "w", encoding="utf-8") as fh:
            fh.write("{}")
    env = dict(
        os.environ,
        ZIM_DIR=zim_dir,
        ZIMI_DATA_DIR=data_dir,
        ZIMI_AUTO_UPDATE="0",
        ZIMI_TORRENT="0",
        ZIMI_OFFLINE="1",
        ZIMI_PEER_DISCOVERY="0",
        PYTHONUNBUFFERED="1",
    )
    for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_LAN_ADMIN", "ZIMI_MANAGE_OPEN", "ZIMI_HOST"):
        env.pop(var, None)
    with open(log_path, "w", encoding="utf-8") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", "--port", "0"],
            cwd=REPO_ROOT, env=env, stdout=log_f, stderr=subprocess.STDOUT,
        )
    try:
        port = _wait_for_ready(proc, log_path)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/manage/has-password", timeout=10) as r:
            return json.loads(r.read().decode()).get("setup")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        for p in (zim_dir, data_dir):
            shutil.rmtree(p, ignore_errors=True)
        os.remove(log_path)


@pytest.mark.parametrize("seed_cache, waits", [(False, True), (True, False)])
def test_a_fresh_install_with_a_zim_still_shows_its_page(seed_cache, waits):
    assert _setup_state(seed_cache) is waits
