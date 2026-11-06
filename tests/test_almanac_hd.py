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
    asset.write_text(json.dumps(REL), encoding="utf-8")
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


def test_the_offer_rides_on_the_satellites_answer(hd, tmp_path, monkeypatch):
    """The Earth view asks for its satellite data as it opens; the offer comes on that answer, no request of its own."""
    import threading
    import urllib.request
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    (tmp_path / "z").mkdir()
    (tmp_path / "d").mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path / "z"))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "d"))
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/almanac-satellites" % httpd.server_address[1]) as r:
            payload = json.loads(r.read())
    finally:
        httpd.shutdown()
    assert payload["hd"]["offer"] == {"file": REL["file"], "size": REL["size"]}
    assert payload["hd"]["mode"] == outbound.ASK and hd == []


def test_a_data_pack_is_neither_on_home_nor_searched(tmp_path, monkeypatch):
    """Almanac HD is the Almanac's tiles, not a book: /list leaves it out (Home, the library's grid), and search and
    the title indexes do not walk it; /w/ still serves it to the 3D view."""
    import zimi.server as srv

    files = {"wikipedia_en_test": "/z/wikipedia_en_test.zim", almanachd.NAME: "/z/zimi_almanac_hd_2026-11.zim"}
    monkeypatch.setattr(srv, "get_zim_files", lambda: files)
    assert almanachd.NAME in srv.DATA_PACKS
    assert set(srv.content_zims()) == {"wikipedia_en_test"}


def test_installed_means_on_the_server_whoever_asks(monkeypatch, tmp_path):
    """A person who may not see the data pack (an allowlist, limited public access) must not make the
    server fetch it again on every visit: installed is the server's library, not theirs."""
    import zimi.server as srv

    monkeypatch.setattr(srv, "_zim_files_cache", {almanachd.NAME: str(tmp_path / "hd.zim")})
    monkeypatch.setattr(srv, "current_allow", lambda: set())
    assert srv.get_zim_files() == {}  # what that person sees
    assert almanachd.installed()


def test_a_file_already_on_disk_is_never_fetched_over(hd, monkeypatch, tmp_path):
    import zimi.server as srv

    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    (tmp_path / REL["file"]).write_bytes(b"zim")
    assert almanachd.start() == (None, "installed") and hd == []


def test_the_release_files_checksum_is_checked_before_it_is_installed(hd, tmp_path):
    almanachd.start()
    assert hd[0]["extra"]["_sha256"] == REL["sha256"]
    f = tmp_path / "x.tmp"
    f.write_bytes(b"not the release")
    import hashlib

    assert not library._checksum_ok({"_sha256": REL["sha256"]}, str(f))
    assert library._checksum_ok({"_sha256": hashlib.sha256(b"not the release").hexdigest()}, str(f))
    assert library._checksum_ok({}, str(f))


def test_a_restart_resumes_it_still_checked_against_its_checksum(hd, tmp_path, monkeypatch):
    """The pending list keeps the checksum, and the resume goes back through Almanac HD's own start (the release, its
    checksum and the setting asked afresh), never the generic import path that drops it."""
    from zimi import server as srv

    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    rec = {"id": "9", "url": "https://github.com/x/hd.zim", "filename": REL["file"], "size_bytes": REL["size"],
           "_source": almanachd.SOURCE, "_sha256": "ab" * 32}
    monkeypatch.setattr(library, "_active_downloads", {"9": rec})
    monkeypatch.setattr(library, "_download_queue", [])
    library._persist_pending_downloads()
    saved = json.load(open(tmp_path / "downloads.json", encoding="utf-8"))["pending"]
    assert saved[0]["sha256"] == "ab" * 32
    monkeypatch.setattr(library, "_active_downloads", {})
    imported = []
    monkeypatch.setattr(library, "_start_import", lambda *a, **k: imported.append(a) or ("x", None))
    assert library.resume_pending_downloads() == 1
    assert not imported and hd and hd[-1]["extra"]["_sha256"] == REL.get("sha256")
