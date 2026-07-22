"""Handler-level routing/auth tests for the Wave C manage endpoints:
/manage/health(-check) and /manage/export-bookmarks.
"""

import os
import sys
import time
from urllib.parse import urlparse

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


class _Handler:
    def __init__(self):
        self.status = None
        self.body = None
        self.headers = {}

    def _json(self, status, body):
        self.status = status
        self.body = body

    def _is_private_client(self):
        return True


@pytest.fixture
def zim_env(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_fixture_zim(str(zdir / "survival_en_2026-06.zim"))
    ddir = tmp_path / "data"
    ddir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    server._archive_pool.clear()
    server.load_cache(force=True)
    return zdir


def _poll(get_path, until, tries=200):
    for _ in range(tries):
        h = _Handler()
        manage.handle_manage_get(h, urlparse(get_path), {})
        assert h.status == 200
        if until(h.body):
            return h.body
        time.sleep(0.02)
    raise AssertionError(f"{get_path} never reached terminal state")


def test_health_check_start_and_poll(zim_env):
    h = _Handler()
    manage.handle_manage_post(h, urlparse("/manage/health-check"), {})
    assert h.status == 200
    assert h.body["status"] in ("started", "running")
    body = _poll("/manage/health", lambda b: b.get("phase") in ("done", "error"))
    assert body["phase"] == "done"
    assert body["summary"]["total"] == 1
    assert body["report"][0]["name"] == "survival"
    assert body["report"][0]["opens"] is True


def test_export_bookmarks_empty_is_400(zim_env):
    h = _Handler()
    manage.handle_manage_post(
        h, urlparse("/manage/export-bookmarks"), {"bookmarks": []}
    )
    assert h.status == 400


def test_export_bookmarks_creates_zim(zim_env):
    h = _Handler()
    bms = [{"zim": "survival", "path": "A/Water", "title": "Water purification"}]
    manage.handle_manage_post(
        h, urlparse("/manage/export-bookmarks"), {"bookmarks": bms}
    )
    assert h.status == 200
    assert h.body["status"] in ("started", "busy")
    body = _poll(
        "/manage/export-bookmarks", lambda b: b.get("phase") in ("done", "error")
    )
    assert body["phase"] == "done"
    assert body["file"].startswith("zimi-bookmarks_")
    assert os.path.exists(os.path.join(str(zim_env), body["file"]))
