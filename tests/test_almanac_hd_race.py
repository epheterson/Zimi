"""Two Almanacs asking for HD at once queue one download (review finding on #141)."""

import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import almanachd, library  # noqa: E402

REL = {
    "file": "zimi_almanac_maxi_2026-11.zim",
    "size": 312_000_000,
    "sha256": "ab" * 32,
    "tag": "v1.15.4",
}


def test_two_asks_at_once_queue_one_download(monkeypatch, tmp_path):
    import zimi.server as srv

    monkeypatch.setattr(almanachd, "release", lambda read=False: REL)
    monkeypatch.setattr(almanachd, "installed", lambda: False)
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: False)
    monkeypatch.delenv(almanachd.ENV, raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    from zimi import manage

    monkeypatch.setattr(manage, "_read_app_update_prefs", lambda: {})
    under_way, queued = [], []
    monkeypatch.setattr(
        almanachd, "_downloading", lambda: under_way[0] if under_way else None
    )

    def slow_enqueue(url, mirrors, filename, size_bytes=None, extra=None):
        time.sleep(0.2)  # the window between "none under way" and "one is"
        under_way.append({"id": "1"})
        queued.append(filename)
        return "1", None

    monkeypatch.setattr(library, "_enqueue_zim_download", slow_enqueue)
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(almanachd.start()))
        for _ in range(2)
    ]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(queued) == 1, queued
    assert len(results) == 2 and all(err is None for _id, err in results)
