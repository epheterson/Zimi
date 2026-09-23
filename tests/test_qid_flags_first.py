"""Which ZIMs carry Q-IDs is known before the full scans, not after.

has_qids drives the Q-ID badge and was set only after every small Wikipedia
had been scanned article by article. On the NAS copy that took hours, and
until then no ZIM had a badge and /search said has_qids false for Wikipedia.
"""

import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import interlang  # noqa: E402
from zimi import server  # noqa: E402


def test_flags_are_set_before_any_index_is_built(tmp_path, monkeypatch):
    zims = {"wikipedia_xx": str(tmp_path / "w.zim"), "notes": str(tmp_path / "n.zim")}
    library = [
        {"name": "wikipedia_xx", "entries": 1000},
        {"name": "notes", "entries": 50},
    ]
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "_zim_list_cache", library)
    monkeypatch.setattr(server, "get_zim_files", lambda: zims)
    monkeypatch.setattr(interlang, "_check_one_article_for_qid", lambda path: path.endswith("w.zim"))
    monkeypatch.setattr(interlang, "_qid_index_is_current", lambda name, path: False)
    monkeypatch.setattr(interlang, "_persist_qid_flags", lambda flags: None)
    monkeypatch.setattr(interlang, "_loadavg_throttle", lambda: None)
    seen_at_build = {}

    def build(kind, name, path, build_fn, close_fn):
        seen_at_build[name] = {z["name"]: z.get("has_qids") for z in library}

    with mock.patch.object(interlang, "_build_index_isolated", build):
        interlang._build_all_qid_indexes_inner()

    assert seen_at_build == {"wikipedia_xx": {"wikipedia_xx": True, "notes": False}}
    assert library[0]["has_qids"] is True and library[1]["has_qids"] is False
