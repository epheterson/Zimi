"""After a restart the server reads every ZIM once to warm up. Someone opening an app meanwhile goes first:
the warm-up waits for quiet before each ZIM (the NAS, 2026-11-04: apps opened just after a deploy crawled)."""

import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as srv  # noqa: E402
from zimi import interlang  # noqa: E402


def test_the_qid_sampling_waits_while_someone_is_using_the_server(monkeypatch):
    read = []
    monkeypatch.setattr(interlang, "_qid_has_index", lambda name: False)
    monkeypatch.setattr(interlang, "_check_one_article_for_qid", lambda path: read.append(path) or False)
    monkeypatch.setattr(srv, "_SHAPE_IDLE_SECONDS", 0.6)
    monkeypatch.setattr(srv, "_SHAPE_IDLE_POLL_SECONDS", 0.05)
    monkeypatch.setattr(srv, "LAST_REQUEST_AT", time.time())  # someone is here right now
    done = threading.Event()
    threading.Thread(target=lambda: (interlang._detect_qid_flags({"a": "/a.zim", "b": "/b.zim"}), done.set()), daemon=True).start()
    time.sleep(0.3)
    assert read == [], "nothing read while a request is fresh"
    assert done.wait(3), "and it carries on once the server is quiet"
    assert read == ["/a.zim", "/b.zim"]
