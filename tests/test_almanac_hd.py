"""Almanac HD: offered with its size, fetched once through the download queue, under its own fetch setting.

Run: pytest tests/test_almanac_hd.py -v
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import almanachd, library, outbound  # noqa: E402

REL = {
    "file": "zimi_almanac_maxi_2026-11.zim",
    "size": 312_000_000,
    "sha256": "ab" * 32,
    "tag": "v1.15.4",
}


@pytest.fixture
def hd(tmp_path, monkeypatch):
    monkeypatch.setattr(almanachd, "release", lambda read=False: REL)
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
    monkeypatch.setattr(almanachd, "_downloading", lambda: None)
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
        == "https://github.com/epheterson/Zimi/releases/download/v1.15.4/zimi_almanac_maxi_2026-11.zim"
    )
    assert q["filename"] == REL["file"] and q["size_bytes"] == REL["size"]
    # A _source keeps it out of NOMAD's library: it is Zimi's own part.
    assert q["extra"]["_source"] == almanachd.SOURCE


def test_automatically_fetches_it_the_first_time_the_almanac_asks(hd):
    almanachd.POLICY.set(outbound.AUTO)
    almanachd.on_almanac_open()
    for _ in range(100):  # the fetch is started by a thread nobody waits for
        if hd:
            break
        time.sleep(0.02)
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
    monkeypatch.setattr(almanachd, "release", lambda read=False: None)
    assert almanachd.status()["offer"].get(
        "approx"
    )  # the offline estimate, until a release says otherwise
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
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/almanac-satellites" % httpd.server_address[1]
        ) as r:
            payload = json.loads(r.read())
    finally:
        httpd.shutdown()
    assert payload["hd"]["offer"] == {"file": REL["file"], "size": REL["size"]}
    assert payload["hd"]["mode"] == outbound.ASK and hd == []


def test_a_data_pack_is_neither_on_home_nor_searched(tmp_path, monkeypatch):
    """Almanac HD is the Almanac's tiles, not a book: /list leaves it out (Home, the library's grid), and search and
    the title indexes do not walk it; /w/ still serves it to the 3D view."""
    import zimi.server as srv

    files = {
        "wikipedia_en_test": "/z/wikipedia_en_test.zim",
        almanachd.NAME: "/z/zimi_almanac_maxi_2026-11.zim",
        almanachd.LEGACY_NAME: "/z/zimi_almanac_hd_2026-11.zim",
    }
    monkeypatch.setattr(srv, "get_zim_files", lambda: files)
    assert {almanachd.NAME, almanachd.LEGACY_NAME} <= srv.DATA_PACKS
    assert set(srv.content_zims()) == {"wikipedia_en_test"}


def test_installed_means_on_the_server_whoever_asks(monkeypatch, tmp_path):
    """A person who may not see the data pack (an allowlist, limited public access) must not make the
    server fetch it again on every visit: installed is the server's library, not theirs.
    """
    import zimi.server as srv

    monkeypatch.setattr(
        srv, "_zim_files_cache", {almanachd.NAME: str(tmp_path / "hd.zim")}
    )
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
    assert library._checksum_ok(
        {"_sha256": hashlib.sha256(b"not the release").hexdigest()}, str(f)
    )
    assert library._checksum_ok({}, str(f))


def test_a_restart_resumes_it_still_checked_against_its_checksum(
    hd, tmp_path, monkeypatch
):
    """The pending list keeps the checksum, and the resume goes back through Almanac HD's own start (the release, its
    checksum and the setting asked afresh), never the generic import path that drops it.
    """
    from zimi import server as srv

    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    rec = {
        "id": "9",
        "url": "https://github.com/x/hd.zim",
        "filename": REL["file"],
        "size_bytes": REL["size"],
        "_source": almanachd.SOURCE,
        "_sha256": "ab" * 32,
    }
    monkeypatch.setattr(library, "_active_downloads", {"9": rec})
    monkeypatch.setattr(library, "_download_queue", [])
    library._persist_pending_downloads()
    saved = json.load(open(tmp_path / "downloads.json", encoding="utf-8"))["pending"]
    assert saved[0]["sha256"] == "ab" * 32
    monkeypatch.setattr(library, "_active_downloads", {})
    imported = []
    monkeypatch.setattr(
        library, "_start_import", lambda *a, **k: imported.append(a) or ("x", None)
    )
    assert library.resume_pending_downloads() == 1
    assert not imported and hd and hd[-1]["extra"]["_sha256"] == REL.get("sha256")


# ── the manifest on the running version's release ──


class _Resp:
    def __init__(self, body):
        self.body = body

    def read(self, n=-1):
        return self.body if n < 0 else self.body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def manifest(monkeypatch):
    """The real release(), reading a manifest through a stand-in for the network; the background read runs inline."""
    import zimi.server as srv

    monkeypatch.setattr(srv, "ZIMI_VERSION", "1.15.4")
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: False)
    monkeypatch.delenv(almanachd.ENV, raising=False)
    from zimi import manage

    saved = {}
    monkeypatch.setattr(manage, "_read_app_update_prefs", lambda: dict(saved))
    monkeypatch.setattr(
        manage, "_write_app_update_prefs", lambda **kw: saved.update(kw)
    )
    monkeypatch.setattr(almanachd, "installed", lambda: False)
    monkeypatch.setattr(
        almanachd, "_manifest", {"rel": None, "tried": 0.0, "busy": False}
    )
    asked = []
    box = {"body": None, "asked": asked}

    def urlopen(req, timeout=None, context=None):
        asked.append(req.full_url)
        if box["body"] is None:
            raise OSError("404")
        return _Resp(box["body"])

    monkeypatch.setattr(almanachd.urllib.request, "urlopen", urlopen)

    class Inline:
        def __init__(self, target, **kw):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(almanachd.threading, "Thread", Inline)
    return box


GOOD = json.dumps(dict(REL)).encode()


def test_under_ask_first_nothing_is_fetched_before_consent(manifest):
    manifest["body"] = GOOD
    for _ in range(3):
        st = almanachd.on_almanac_open()
        assert almanachd.status() and almanachd.release() is None
    assert (
        manifest["asked"] == []
    )  # no manifest read, no download: the person has not said yes
    # ...yet the offer is there on the very first open, sized from what is known offline.
    assert st["mode"] == outbound.ASK and st["offer"]["approx"] is True
    assert (
        st["offer"]["size"] == almanachd.estimate()
        and st["offer"]["size"] > 100_000_000
    )
    assert st["offer"]["size"] % almanachd.ESTIMATE_STEP == 0


def test_yes_reads_the_manifest_of_its_own_versions_release_then_downloads_and_checks_it(
    manifest, monkeypatch
):
    queued = []
    monkeypatch.setattr(almanachd, "_downloading", lambda: None)
    monkeypatch.setattr(
        library,
        "_enqueue_zim_download",
        lambda *a, **k: queued.append((a, k)) or ("1", None),
    )
    import zimi.server as srv

    monkeypatch.setattr(srv, "ZIM_DIR", "/nonexistent-dir")
    manifest["body"] = GOOD
    assert almanachd.start({"name": "admin"}) == ("1", None)
    assert manifest["asked"] == [
        "https://github.com/epheterson/Zimi/releases/download/v1.15.4/zimi_almanac_maxi.json"
    ]
    ((args, kw),) = queued
    assert args[2] == REL["file"] and kw["extra"]["_sha256"] == REL["sha256"]
    # The release's own figure now replaces the estimate.
    assert almanachd.status()["offer"] == {"file": REL["file"], "size": REL["size"]}
    assert len(manifest["asked"]) == 1


def test_a_dev_build_with_no_release_manifest_fetches_nothing(manifest):
    assert almanachd.start() == (None, "unavailable")
    assert almanachd.status()["offer"]["approx"] is True and len(manifest["asked"]) == 1


def test_a_manifest_for_another_version_or_a_strange_file_is_no_offer(manifest):
    for bad in (
        dict(REL, tag="v1.15.3"),
        dict(REL, file="../x.zim"),
        dict(REL, file="evil_2026-11.zim"),
        dict(REL, sha256="zz"),
        dict(REL, size="big"),
        dict(REL, size=True),
    ):
        assert almanachd.parse_manifest(json.dumps(bad)) is None, bad
    assert (
        almanachd.parse_manifest("not json") is None
        and almanachd.parse_manifest("[]") is None
    )
    assert almanachd.parse_manifest(GOOD) == REL


def test_never_and_offline_read_no_manifest(manifest, monkeypatch):
    manifest["body"] = GOOD
    almanachd.POLICY.set(outbound.NEVER)
    assert almanachd.release() is None
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: True)
    assert almanachd.release() is None
    assert manifest["asked"] == []


def test_automatically_reads_the_manifest_and_starts_the_download_in_the_background(
    manifest, monkeypatch
):
    queued = []
    monkeypatch.setattr(almanachd, "_downloading", lambda: None)
    monkeypatch.setattr(
        library,
        "_enqueue_zim_download",
        lambda *a, **k: queued.append(a) or ("1", None),
    )
    import zimi.server as srv

    monkeypatch.setattr(srv, "ZIM_DIR", "/nonexistent-dir")
    manifest["body"] = GOOD
    almanachd.POLICY.set(outbound.AUTO)
    st = almanachd.on_almanac_open()
    assert st["offer"]["approx"] is True  # answered at once, with the estimate
    assert len(queued) == 1 and queued[0][2] == REL["file"]


def test_tiles_are_read_from_the_flavour_first_then_the_1153_tile_zim(monkeypatch):
    import zimi.server as srv

    files = {}
    monkeypatch.setattr(srv, "get_zim_files", lambda: files)
    monkeypatch.setattr(srv, "_zim_files_cache", files)
    assert almanachd.base() is None and not almanachd.installed()
    files[almanachd.LEGACY_NAME] = "/z/zimi_almanac_hd_2026-11.zim"
    assert (
        almanachd.base() == "/w/zimi_almanac_hd/" and almanachd.installed()
    )  # 1.15.3's user keeps their tiles
    files[almanachd.NAME] = "/z/zimi_almanac_maxi_2026-11.zim"
    assert almanachd.base() == "/w/zimi_almanac_maxi/hd/"


def test_the_flavour_file_is_its_own_name_not_a_second_almanac():
    import zimi.server as srv

    assert srv._zim_base_name("zimi_almanac_maxi_2026-11.zim") == almanachd.NAME
    assert srv._zim_base_name("zimi_almanac_2026-11b.zim") == "zimi_almanac"


def test_a_restart_resumes_from_what_the_download_recorded_before_the_manifest_is_back():
    saved = {
        "url": almanachd.url(REL),
        "filename": REL["file"],
        "size_bytes": REL["size"],
        "sha256": REL["sha256"],
    }
    assert almanachd.saved_release(saved) == REL
    assert (
        almanachd.saved_release(dict(saved, url="https://example.com/" + REL["file"]))
        is None
    )
    assert almanachd.saved_release(dict(saved, filename="other.zim")) is None


def test_a_finished_download_is_not_the_one_under_way(monkeypatch):
    from zimi import library

    done = {"id": "d1", "filename": "zimi_almanac_maxi_2026-11.zim", "done": True}
    live = {"id": "d2", "filename": "zimi_almanac_maxi_2026-11.zim"}
    monkeypatch.setattr(library, "_download_queue", [])
    monkeypatch.setattr(library, "_active_downloads", {"d1": done})
    assert almanachd._downloading() is None
    monkeypatch.setattr(library, "_active_downloads", {"d1": done, "d2": live})
    assert almanachd._downloading() is live
def _part(name, size=900_000_000):
    return {
        "part": name,
        "file": "zimi_almanac_hd_%s_2026-11.zim" % name,
        "size": size,
        "sha256": "cd" * 32,
    }


def test_a_split_set_is_offered_whole_and_every_missing_file_is_queued(hd, monkeypatch):
    rel = dict(REL, parts=[_part("moon"), _part("mars")])
    monkeypatch.setattr(almanachd, "release", lambda read=False: rel)
    monkeypatch.setattr(almanachd, "present", lambda: None)
    monkeypatch.setattr(almanachd, "parts_present", lambda: {})
    monkeypatch.setattr(almanachd, "_downloading_all", lambda: [])
    assert almanachd.status()["offer"]["size"] == REL["size"] + 2 * 900_000_000
    almanachd.start(None)
    assert [q["filename"] for q in hd] == [
        REL["file"],
        "zimi_almanac_hd_moon_2026-11.zim",
        "zimi_almanac_hd_mars_2026-11.zim",
    ]


def test_only_the_missing_parts_of_a_set_are_fetched(hd, monkeypatch):
    rel = dict(REL, parts=[_part("moon"), _part("mars")])
    monkeypatch.setattr(almanachd, "release", lambda read=False: rel)
    monkeypatch.setattr(almanachd, "installed", lambda: False)
    monkeypatch.setattr(almanachd, "present", lambda: "zimi_almanac_maxi")
    monkeypatch.setattr(
        almanachd, "parts_present", lambda: {"moon": "zimi_almanac_hd_moon"}
    )
    monkeypatch.setattr(almanachd, "_downloading_all", lambda: [])
    almanachd.start(None)
    assert [q["filename"] for q in hd] == ["zimi_almanac_hd_mars_2026-11.zim"]


def test_a_part_must_be_a_known_one_named_for_it():
    ok = dict(REL, parts=[_part("moon")])
    assert almanachd.parse_manifest(json.dumps(ok), "1.15.4")["parts"] == [
        _part("moon")
    ]
    for bad in (
        dict(REL, parts=[dict(_part("moon"), part="venus")]),
        dict(REL, parts=[dict(_part("moon"), file="zimi_almanac_hd_mars_2026-11.zim")]),
        dict(REL, parts=[dict(_part("moon"), file="../x.zim")]),
        dict(REL, parts="moon"),
    ):
        assert almanachd.parse_manifest(json.dumps(bad), "1.15.4") is None, bad
