"""A dot explains itself, and About keeps the record: zimi.server.zim_updates reads how a ZIM came to be
what it is from what Zimi already keeps (the event history for the library, the release record and the
shipped CHANGELOG highlights for its own ZIMs). Eric, 2026-11-04: "maybe if I hover on a dot show the
updates that lead to it existing and or show on about for apps and ZIMs"."""

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as server  # noqa: E402
from test_new_zim import _own_rebuild, _setup  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_a_library_zims_arrival_and_updates_newest_first(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    t0 = time.time() - 86400 * 30
    server._append_history({"event": "download", "ts": t0, "filename": "survival_en_2026-06.zim", "size_bytes": 1000, "name": "survival"})
    server._append_history({"event": "download_failed", "ts": t0 + 5, "filename": "x.zim", "name": "survival"})
    server._append_history({"event": "updated", "ts": t0 + 86400 * 29, "filename": "survival_en_2026-10.zim", "size_bytes": 2000, "name": "survival"})
    server._append_history({"event": "updated", "ts": t0, "filename": "other_2026-10.zim", "name": "other"})
    got = server.zim_updates("survival")
    assert [(u["event"], u["file"], u["size_bytes"]) for u in got] == [
        ("updated", "survival_en_2026-10.zim", 2000), ("download", "survival_en_2026-06.zim", 1000)]


def test_zimis_own_zim_says_which_release_changed_it_and_what_came_with_it(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "_whatsnew", {"1.15.3": {"zimi_games": ["ZimCity: a city builder."]}})
    _own_rebuild(tmp_path, monkeypatch, "1.15.2", "aaa", "1.15.3", "bbb")
    got = server.zim_updates("zimi_games")
    assert len(got) == 1 and got[0]["version"] == "1.15.3" and got[0]["notes"] == ["ZimCity: a city builder."]


def test_the_shipped_whatsnew_is_the_changelogs():
    """zimi/assets/whatsnew.json is CHANGELOG.md's own-ZIM highlights, regenerated when they change."""
    r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "whatsnew.py"), "--check"])
    assert r.returncode == 0, "run: python scripts/whatsnew.py"
    with open(os.path.join(ROOT, "zimi", "assets", "whatsnew.json"), encoding="utf-8") as f:
        assert any("ZimCity" in line for line in json.load(f)["1.15.3"]["zimi_games"])


def test_asking_for_many_dots_reads_the_history_once_and_is_rate_limited(tmp_path, monkeypatch):
    from zimi import http as zhttp

    _setup(tmp_path, monkeypatch)
    server.load_cache(force=True)
    server._append_history({"event": "download", "ts": time.time(), "filename": "survival_en_2026-06.zim", "size_bytes": 1, "name": "survival"})
    reads = []
    real = server._load_history
    monkeypatch.setattr(server, "_load_history", lambda: reads.append(1) or real())
    history = server._load_history()
    reads.clear()
    got = {n: server.zim_updates(n, history) for n in ["survival"] * 20}
    assert reads == [] and got["survival"][0]["file"] == "survival_en_2026-06.zim"
    assert "/zim-updates" in zhttp._RATE_LIMITED_API_PATHS and "/games/board" in zhttp._RATE_LIMITED_API_PATHS
