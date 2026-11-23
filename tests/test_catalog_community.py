"""Kiwix's community catalog (kiwix/operations#822) joins the main catalog.

Its entries are tagged source "community", follow the Kiwix entries in the
paged answer, and are read from memory, disk or the shipped snapshot: opening
the catalog never fetches. Only refresh_community (the update check and the
upkeep) does, with one conditional request and a growing wait after a failure,
and never under ZIMI_OFFLINE.
"""

import gzip
import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import catalog_snapshot, p2p  # noqa: E402

_REAL_COMMUNITY_ITEMS = lib.community_items  # before conftest's stub

# The shape the live endpoint serves: relative thumbnail, .meta4 download.
_FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <totalResults>2</totalResults>
  <entry>
    <title>The Last Codex</title>
    <summary>A wiki of the games world</summary>
    <language>eng</language>
    <name>lastcodex.org_en_all</name>
    <category>other</category>
    <articleCount>1200</articleCount>
    <link rel="http://opds-spec.org/image/thumbnail" href="/catalog/v2/illustration/abc/?size=48" type="image/png"/>
    <dc:issued>2026-10-09T00:00:00Z</dc:issued>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="https://lb.download.kiwix.org/zim/community/lastcodex.org_en_all_2026-10.zim.meta4" length="1000"/>
  </entry>
  <entry>
    <title>Le Dernier Codex</title>
    <summary>Le meme, en francais</summary>
    <language>fra</language>
    <name>lastcodex.org_fr_all</name>
    <category>other</category>
  </entry>
</feed>"""


class _Resp:
    def __init__(self, body=_FEED, etag='"v1"'):
        self._body, self.headers = body, {"ETag": etag}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def community(tmp_path, monkeypatch):
    # conftest stubs community_items for every test; this module tests the real one.
    monkeypatch.setattr(lib, "community_items", _REAL_COMMUNITY_ITEMS)
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path / "zims"))
    os.makedirs(str(tmp_path / "zims"))
    monkeypatch.setattr(lib, "_community", None)
    monkeypatch.setattr(p2p, "is_offline", lambda: False)
    monkeypatch.setattr(catalog_snapshot, "community_entries", lambda: [])
    calls = []

    def fake_open(req, timeout=None, context=None):
        calls.append(dict(req.header_items()))
        return _Resp()

    monkeypatch.setattr(lib.urllib.request, "urlopen", fake_open)
    return calls


def test_entries_are_tagged_and_complete(community):
    assert lib.refresh_community() is True
    items = lib.community_items()
    assert [i["name"] for i in items] == ["lastcodex.org_en_all", "lastcodex.org_fr_all"]
    first = items[0]
    assert first["source"] == "community"
    assert first["language"] == "en" and first["article_count"] == 1200
    assert first["download_url"].endswith(".zim.meta4") and first["size_bytes"] == 1000
    assert first["icon_url"].startswith(lib.COMMUNITY_OPDS_BASE + "/catalog/v2/illustration/")
    assert lib.is_thumb_url(first["icon_url"])
    assert not lib.is_thumb_url("https://evil.example/https://library.kiwix.org/")


def test_search_and_language_filter(community):
    lib.refresh_community()
    assert [i["name"] for i in lib.community_items("last codex")] == ["lastcodex.org_en_all"]
    assert [i["name"] for i in lib.community_items("", "fra")] == ["lastcodex.org_fr_all"]
    assert lib.community_items("no such thing") == []


def test_reading_never_fetches_and_serves_the_shipped_snapshot(community, monkeypatch):
    snap = lib.parse_community(_FEED)
    monkeypatch.setattr(catalog_snapshot, "community_entries", lambda: snap)
    assert [i["name"] for i in lib.community_items()] == ["lastcodex.org_en_all", "lastcodex.org_fr_all"]
    assert community == [], "opening the catalog made no request"


def test_the_snapshot_file_shipped_in_the_package_reads_back():
    entries = catalog_snapshot.community_entries()
    assert entries and all(e["source"] == "community" and e["name"] and e["download_url"] for e in entries)
    assert any("codex" in e["name"] for e in entries)
    with gzip.open(catalog_snapshot.COMMUNITY_PATH) as f:
        assert f.read(1)


def test_a_refresh_is_one_conditional_request_a_day(community, monkeypatch):
    assert lib.refresh_community() is True and len(community) == 1
    assert lib.refresh_community() is False and len(community) == 1, "a day has not passed"
    state = dict(lib._community)
    lib._community = {**state, "at": state["at"] - lib._COMMUNITY_TTL - 1}
    # The server says nothing changed: 304, the copy stays, nothing is re-parsed.
    def not_modified(req, timeout=None, context=None):
        community.append(dict(req.header_items()))
        raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", {}, None)

    monkeypatch.setattr(lib.urllib.request, "urlopen", not_modified)
    assert lib.refresh_community() is False
    assert len(community) == 2 and community[1]["If-none-match"] == '"v1"'
    assert len(lib.community_items()) == 2
    # >=: Windows' clock can read the same tick twice; the copy was backdated a day, so this still proves it renewed.
    assert lib._community["at"] >= state["at"], "the 304 renews the copy"
    lib._community = None  # a restart reads it back from disk with its validator
    assert lib._community_state()["etag"] == '"v1"'


def test_offline_fetches_nothing(community, monkeypatch):
    monkeypatch.setattr(p2p, "is_offline", lambda: True)
    assert lib.refresh_community() is False
    assert community == []


def test_a_failure_waits_longer_each_time(community, monkeypatch):
    def boom(*a, **k):
        raise OSError("down")

    monkeypatch.setattr(lib.urllib.request, "urlopen", boom)
    assert lib.refresh_community() is False
    first = lib._community["next_try"]
    assert lib._community["fails"] == 1
    monkeypatch.setattr(
        lib.urllib.request, "urlopen", lambda *a, **k: pytest.fail("retried during the wait")
    )
    assert lib.refresh_community() is False
    monkeypatch.setattr(lib.urllib.request, "urlopen", boom)
    lib._community = {**lib._community, "next_try": 0.0}
    lib.refresh_community()
    assert lib._community["fails"] == 2
    assert lib._community["next_try"] - lib._community["at"] >= 0
    assert lib._community["next_try"] > first + lib._COMMUNITY_BACKOFF_S / 2, "the second wait is longer"


def test_the_main_parse_is_unchanged_for_kiwix(community):
    import xml.etree.ElementTree as ET

    ns = {"atom": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/terms/"}
    items = lib._parse_opds_items(ET.fromstring(_FEED), ns, "https://library.kiwix.org")
    assert "source" not in items[0]
    assert items[0]["icon_url"].startswith("https://library.kiwix.org/catalog/v2/")


def test_community_entries_follow_the_kiwix_ones_across_pages(community, monkeypatch):
    from unittest.mock import MagicMock

    import zimi.manage as manage

    lib.refresh_community()
    kiwix = [{"name": "k%d" % i, "language": "en"} for i in range(3)]
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_check_manage_auth", lambda h: None)
    monkeypatch.setattr(
        server,
        "_fetch_kiwix_catalog",
        lambda q, lang, count, start: (3, kiwix[start : start + count], None),
    )

    def page(start, count):
        out = {}
        h = MagicMock()
        h._json = lambda status, payload: out.update(status=status, payload=payload)
        parsed = MagicMock()
        parsed.path = "/manage/catalog"
        manage.handle_manage_get(h, parsed, {"start": [str(start)], "count": [str(count)]})
        return out["payload"]

    first = page(0, 2)
    assert first["total"] == 5 and [i["name"] for i in first["items"]] == ["k0", "k1"]
    second = page(2, 2)
    assert [i["name"] for i in second["items"]] == ["k2", "lastcodex.org_en_all"]
    third = page(4, 2)
    assert [i["name"] for i in third["items"]] == ["lastcodex.org_fr_all"]
    assert [i["source"] for i in third["items"]] == ["community"]


def test_an_installed_community_zim_is_offered_its_update(community, monkeypatch, tmp_path):
    """The update check matches installed ZIMs against the community copy too, with no request of its own."""
    lib.refresh_community()
    before = len(community)
    installed = "lastcodex.org_en_all_2026-09.zim"
    (tmp_path / "zims" / installed).write_bytes(b"")
    monkeypatch.setattr(server, "get_zim_files", lambda: {"lastcodex": str(tmp_path / "zims" / installed)})
    monkeypatch.setattr(lib, "_fetch_kiwix_catalog", lambda **kw: (0, [], None))
    updates = lib._check_updates()
    assert [u["latest_date"] for u in updates] == ["2026-10"]
    assert updates[0]["download_url"].endswith("lastcodex.org_en_all_2026-10.zim.meta4")
    assert len(community) == before, "the community copy is read, not fetched"
