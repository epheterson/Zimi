"""A small library's total size is not zero.

/manage/status rounded the library's total to 0.1 GB, so Settings > Library
read "Total size 0 B" for anything under about 50 MB, while each ZIM's own
size (size_gb to six places) was right.
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


def test_a_few_megabytes_of_zims_add_up_to_more_than_nothing(monkeypatch):
    monkeypatch.setattr(server, "_zim_list_cache", [{"name": "a", "size_gb": 0.012}, {"name": "b", "size_gb": 0.0009}])
    monkeypatch.setattr(server, "get_zim_files", lambda: {"a": "/a.zim", "b": "/b.zim"})
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)
    captured = {}
    h = MagicMock()
    h._json = lambda status, payload: captured.update(status=status, payload=payload)
    manage.handle_manage_get(h, SimpleNamespace(path="/manage/status"), {})
    assert captured["status"] == 200
    assert abs(captured["payload"]["total_size_gb"] - 0.0129) < 1e-6
