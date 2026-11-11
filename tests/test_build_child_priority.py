"""A background index build's child runs at the lowest CPU priority, so it never slows a page someone opened."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import search  # noqa: E402


def test_the_build_child_lowers_its_own_priority_first(monkeypatch, tmp_path):
    asked = []
    # The child's main sets the process's data dir to its argument, as a child process would: put the old one back afterwards.
    monkeypatch.setattr(search._srv, "ZIMI_DATA_DIR", search._srv.ZIMI_DATA_DIR)
    monkeypatch.setattr(search.os, "nice", lambda n: asked.append(n) or n, raising=False)  # Windows has no os.nice
    with pytest.raises(SystemExit):
        search._build_index_child_main("no-such-kind", str(tmp_path), "x", str(tmp_path / "x.zim"))
    assert asked == [19]
