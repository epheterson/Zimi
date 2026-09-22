"""Manage → Creator paints now, not in four seconds.

Eric, 2026-09-11: "Creator tab is still super slow to load in manage view....
then after it loads the made here is super slow all of that blows it should be
snappy."

Two separate costs, both paid once per process — which sounds fine until you
notice that a deploy restarts the process, so every deploy the first admin to
open the pane paid them both:

  1. The capability rows. Finding out whether the rendered engine works means
     LAUNCHING a browser: measured at 2.5s here. The pane waited for it.
  2. The made-here list. "Which ZIMs did Zimi make" was answered by opening
     every archive in the library and reading three metadata fields. Memoized
     per process, and the memo dies with the process.

The answers to both are properties of the installation and of the files, not
of the moment, so neither should be recomputed on a restart and neither should
be waited for.

Run: pytest tests/test_creator_pane_speed.py -v
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import zimi.http as _http  # noqa: E402
import zimi.manage as _manage  # noqa: E402
import zimi.server as _srv  # noqa: E402


@pytest.fixture
def slow_probes(monkeypatch):
    """Capability probes that take a visible moment, like the real ones."""
    calls = {"browser": 0, "alive": 0, "sidecar": 0}

    def browser():
        calls["browser"] += 1
        time.sleep(0.4)
        return True

    def alive():
        calls["alive"] += 1
        return False

    def sidecar():
        calls["sidecar"] += 1
        return {"installed": False, "version": None, "dir": "/tmp"}

    monkeypatch.setattr(_manage, "_create_browser_ready", browser)
    monkeypatch.setattr(_manage, "_create_alive_ready", alive)
    monkeypatch.setattr(_manage, "_creator_sidecar", sidecar)
    # A probe another test started may still be in flight. Left alone it
    # finishes inside this one, publishes its answer, and every caller here
    # reads that instead of starting a probe of its own: the count is zero
    # and the test reads as broken (seen on the macOS Intel runner, which is
    # slow enough for the two to overlap). Wait it out, then start from
    # nothing, timestamp included, so nothing here can be answered by it.
    deadline = time.time() + 10
    while getattr(_manage, "_creator_probing", False) and time.time() < deadline:
        time.sleep(0.05)
    monkeypatch.setattr(_manage, "_creator_probed", None, raising=False)
    monkeypatch.setattr(_manage, "_creator_probed_at", 0.0, raising=False)
    monkeypatch.setattr(_manage, "_creator_probing", False, raising=False)
    monkeypatch.setattr(_manage, "_create_queue_view", lambda: [])
    yield calls
    _manage._creator_probed = None
    _manage._creator_probed_at = 0.0
    _manage._creator_probing = False


def _settle(seconds=10.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        payload = _manage._creator_payload()
        if not payload["probing"]:
            return payload
        time.sleep(0.05)
    raise AssertionError("the capability probe never landed")


def test_the_pane_answers_before_the_probe_does(slow_probes):
    started = time.time()
    payload = _manage._creator_payload()
    assert time.time() - started < 0.2, "the pane waited for a browser launch"
    assert payload["probing"] is True
    # None, not False. "We have not looked" is not "you cannot do this", and
    # showing the second for the first tells an admin their browser is missing
    # when it is not.
    assert payload["browser_ready"] is None
    assert payload["alive_ready"] is None
    assert payload["sidecar"] is None
    # What does not need probing is there straight away.
    assert payload["block_ads_default"] in (True, False)
    assert "queue" in payload


def test_the_answer_arrives_and_then_stays(slow_probes):
    _manage._creator_payload()
    settled = _settle()
    assert settled["browser_ready"] is True
    assert settled["alive_ready"] is False
    assert settled["sidecar"]["installed"] is False
    assert slow_probes["browser"] == 1

    started = time.time()
    again = _manage._creator_payload()
    assert time.time() - started < 0.05
    assert again["browser_ready"] is True
    assert slow_probes["browser"] == 1, "the browser was launched twice"


def test_many_callers_launch_one_browser(slow_probes):
    """Two admins, or one admin and the retry, must not each start a probe."""
    import threading

    for _ in range(8):
        threading.Thread(target=_manage._creator_payload).start()
    _settle()
    assert slow_probes["browser"] == 1


# ── the made-here walk ─────────────────────────────────────────────────────


def _library(tmp_path, monkeypatch, files):
    """A fake library: list entries and a disk cache, with no real ZIMs."""
    monkeypatch.setattr(_srv, "ZIM_DIR", str(tmp_path))
    entries = []
    disk = {}
    for name, size in files:
        entries.append(
            {
                "name": name,
                "file": name + ".zim",
                "size_bytes": size,
                "title": name,
                "size_gb": 0.001,
            }
        )
        disk[name + ".zim"] = {"name": name, "mtime": 1, "size": size}
    monkeypatch.setattr(_srv, "_zim_list_cache", entries)
    monkeypatch.setattr(_srv, "list_zims", lambda *a, **k: entries)
    monkeypatch.setattr(_srv, "_load_disk_cache", lambda: disk)
    monkeypatch.setattr(_srv, "_save_disk_cache", lambda d: disk.update(d))
    return entries, disk


def test_provenance_is_read_once_and_then_remembered(tmp_path, monkeypatch):
    """The walk that opens every archive in the library runs once, ever —
    not once per restart."""
    entries, disk = _library(
        tmp_path, monkeypatch, [("alpha", 10), ("beta", 20), ("gamma", 30)]
    )
    reads = []

    def fake_metadata(name):
        reads.append(name)
        # Only one of the three was made here; the rest are somebody else's,
        # which is the common case and the one worth caching hardest.
        if name == "alpha":
            return {"Scraper": "Zimi 1.9.3", "Tags": ""}, True
        return {"Scraper": "mwoffliner"}, True

    monkeypatch.setattr(_http, "_zim_metadata_for", fake_metadata)
    monkeypatch.setattr(_http, "_zim_kind_memo", {})
    monkeypatch.setattr(_http, "_zim_kind_pending", {})

    kinds = _http._zim_kinds()
    assert set(kinds) == {"alpha"}
    assert len(reads) == 3, "the cold pass reads each archive once"

    # Every record was written, including the Nones: "looked, not ours" has to
    # be distinguishable from "never looked", or two of the three get reopened
    # on every restart forever.
    for name in ("alpha", "beta", "gamma"):
        assert "zimi_kind" in disk[name + ".zim"], name

    # A restart: the memo is gone, the cache is not.
    monkeypatch.setattr(_http, "_zim_kind_memo", {})
    monkeypatch.setattr(_http, "_zim_kind_pending", {})
    for entry in entries:
        entry["zimi_kind"] = disk[entry["file"]]["zimi_kind"]
    reads.clear()

    kinds_again = _http._zim_kinds()
    assert kinds_again == kinds
    assert reads == [], "a restart reopened the whole library"


def test_a_changed_file_is_looked_at_again(tmp_path, monkeypatch):
    """The record is keyed to the file it was read from. Recapture a ZIM and
    its provenance is stale, so it has to be re-read."""
    entries, disk = _library(tmp_path, monkeypatch, [("alpha", 10)])
    reads = []

    def fake_metadata(name):
        reads.append(name)
        return {"Scraper": "Zimi 1.9.3", "Tags": ""}, True

    monkeypatch.setattr(_http, "_zim_metadata_for", fake_metadata)
    monkeypatch.setattr(_http, "_zim_kind_memo", {})
    monkeypatch.setattr(_http, "_zim_kind_pending", {})
    _http._zim_kinds()
    assert len(reads) == 1

    entries[0]["zimi_kind"] = disk["alpha.zim"]["zimi_kind"]
    entries[0]["size_bytes"] = 999  # recaptured
    monkeypatch.setattr(_http, "_zim_kind_memo", {})
    monkeypatch.setattr(_http, "_zim_kind_pending", {})
    reads.clear()
    _http._zim_kinds()
    assert reads == ["alpha"], "a recaptured ZIM kept its old provenance"


def test_the_walk_writes_the_cache_once(tmp_path, monkeypatch):
    """Not once per ZIM: a cold library would rewrite the cache file seventy
    times on the way through."""
    entries, disk = _library(
        tmp_path, monkeypatch, [(f"z{i}", i + 1) for i in range(20)]
    )
    saves = []
    monkeypatch.setattr(_srv, "_save_disk_cache", lambda d: saves.append(1))
    monkeypatch.setattr(
        _http, "_zim_metadata_for", lambda name: ({"Scraper": "other"}, True)
    )
    monkeypatch.setattr(_http, "_zim_kind_memo", {})
    monkeypatch.setattr(_http, "_zim_kind_pending", {})
    _http._zim_kinds()
    assert len(saves) == 1
