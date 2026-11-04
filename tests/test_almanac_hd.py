"""Almanac HD: offered with its size, fetched once through the download queue, under its own fetch setting.

Run: pytest tests/test_almanac_hd.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import almanachd, library, outbound  # noqa: E402

REL = {
    "file": "zimi_almanac_hd_2026-11.zim",
    "size": 312_000_000,
    "sha256": "ab" * 32,
    "tag": "almanac-hd-2026-11",
}


@pytest.fixture
def hd(tmp_path, monkeypatch):
    asset = tmp_path / "almanac-hd.json"
    asset.write_text(json.dumps(REL))
    monkeypatch.setattr(almanachd, "ASSET", str(asset))
    monkeypatch.setattr(almanachd, "installed", lambda: False)
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: False)
    monkeypatch.delenv(almanachd.ENV, raising=False)
    saved = {}
    from zimi import manage

    monkeypatch.setattr(manage, "_read_app_update_prefs", lambda: dict(saved))
    monkeypatch.setattr(
        manage, "_write_app_update_prefs", lambda **kw: saved.update(kw)
    )
    queued = []

    def enqueue(url, mirrors, filename, size_bytes=None, extra=None):
        queued.append(
            {
                "url": url,
                "mirrors": mirrors,
                "filename": filename,
                "size_bytes": size_bytes,
                "extra": extra,
            }
        )
        return str(len(queued)), None

    monkeypatch.setattr(library, "_enqueue_zim_download", enqueue)
    monkeypatch.setattr(almanachd, "_downloading", lambda rel: None)
    return queued


def test_it_is_offered_with_its_size_and_asked_first_by_default(hd):
    st = almanachd.status()
    assert st["mode"] == outbound.ASK
    assert st["offer"] == {"file": REL["file"], "size": REL["size"]}
    assert not st["installed"] and not st["downloading"]
    # Asking does not fetch it.
    assert almanachd.on_almanac_open()["offer"] and hd == []


def test_yes_queues_one_download_from_the_release_into_zimis_own_library(hd):
    dl_id, err = almanachd.start({"name": "admin"})
    assert err is None and dl_id == "1"
    (q,) = hd
    assert (
        q["url"]
        == "https://github.com/epheterson/Zimi/releases/download/almanac-hd-2026-11/zimi_almanac_hd_2026-11.zim"
    )
    assert q["filename"] == REL["file"] and q["size_bytes"] == REL["size"]
    # A _source keeps it out of NOMAD's library: it is Zimi's own part.
    assert q["extra"]["_source"] == almanachd.SOURCE


def test_automatically_fetches_it_the_first_time_the_almanac_asks(hd):
    almanachd.POLICY.set(outbound.AUTO)
    almanachd.on_almanac_open()
    assert len(hd) == 1


def test_never_and_offline_fetch_nothing(hd, monkeypatch):
    almanachd.POLICY.set(outbound.NEVER)
    assert almanachd.start() == (None, "never")
    almanachd.POLICY.set(outbound.AUTO)
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: True)
    assert almanachd.on_almanac_open()["mode"] == outbound.NEVER
    assert almanachd.start() == (None, "never")
    assert hd == []


def test_installed_is_neither_offered_nor_fetched(hd, monkeypatch):
    monkeypatch.setattr(almanachd, "installed", lambda: True)
    st = almanachd.status()
    assert st["installed"] and st["offer"] is None
    assert almanachd.start() == (None, "installed") and hd == []


def test_a_version_without_a_file_named_offers_nothing(hd, monkeypatch, tmp_path):
    monkeypatch.setattr(almanachd, "ASSET", str(tmp_path / "missing.json"))
    assert almanachd.status()["offer"] is None
    assert almanachd.start() == (None, "unavailable")


def test_the_fetch_is_listed_with_what_zimi_fetches(hd):
    rows = {r["id"]: r for r in outbound.inventory()["rows"]}
    assert rows["almanac_hd"]["hosts"] == ["github.com"]
    assert rows["almanac_hd"]["state"] == outbound.STATE_ASK
