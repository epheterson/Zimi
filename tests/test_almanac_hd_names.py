"""Almanac HD's file names: the catalog's (``zimi_almanac_hd``, Maximum ``zimi_almanac_hd_maxi``) and 1.16.0's.

1.16.0 shipped HD as ``zimi_almanac_maxi_<month>.zim`` and Maximum as ``zimi_almanac_ultra_<month>.zim`` (split), with the
manifest ``zimi_almanac_maxi.json``. Those files are on people's disks and on the v1.16.0 release, which 1.16.0 reads for
as long as it runs (it fetches only its own tag's manifest); every release after names its files as the catalog does.
Both generations are the same two sizes: found, counted, never fetched again.

Run: pytest tests/test_almanac_hd_names.py -v
"""

import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from conftest_zim import build_fixture_zim  # noqa: E402
from test_almanac_hd_sizes import lib, prefs  # noqa: E402,F401  (the fixtures: a real library folder, the saved prefs)

from zimi import almanachd  # noqa: E402

HD_OLD = "zimi_almanac_maxi_2026-11.zim"
HD_NEW = "zimi_almanac_hd_2026-12.zim"
MAX_OLD = "zimi_almanac_ultra_2026-11.zim"
MAX_NEW = "zimi_almanac_hd_maxi_2026-12.zim"


def test_both_generations_of_names_are_recognised():
    for name in (HD_OLD, HD_NEW, "zimi_almanac_hd_2026-12b.zim"):
        assert almanachd._FILE_RE.match(name) and not almanachd._MAX_RE.match(name), name
        assert almanachd.served_name(name[: -len(".zim")]) == (almanachd.LEGACY_NAME if "_hd_" in name else almanachd.NAME)
    for name in (MAX_OLD, MAX_NEW, "zimi_almanac_hd_maxi_2026-12b.zim"):
        assert almanachd._MAX_RE.match(name) and not almanachd._FILE_RE.match(name), name
        assert almanachd._MAX_FILES.match(name) and almanachd._MAX_FILES.match(name + "ab"), name
        assert almanachd.served_name(name[: -len(".zim")]) == almanachd.MAX_NAME
    for other in ("zimi_almanac_2026-11.zim", "zimi_almanac_hd_moon_2026-11.zim", "zimi_almanac_hd_mars_2026-11b.zim",
                  "zimi_almanac_maps_2026-11.zim", "zimi_almanac_maps_maxi_2026-11.zim"):
        assert not almanachd._FILE_RE.match(other) and not almanachd._MAX_RE.match(other), other
        assert almanachd.served_name(other[: -len(".zim")]) is None


def test_the_server_names_a_file_of_either_generation_the_same_way():
    import zimi.server as srv

    assert srv._zim_base_name(HD_OLD) == almanachd.NAME
    assert srv._zim_base_name(HD_NEW) == almanachd.LEGACY_NAME   # the name 1.15.3's tile ZIM has: the layout inside tells them apart
    assert srv._zim_base_name(MAX_OLD) == srv._zim_base_name(MAX_NEW) == almanachd.MAX_NAME
    assert srv._zim_base_name(MAX_NEW + "aa") == almanachd.MAX_NAME   # a chunk
    assert srv._zim_base_name("zimi_almanac_2026-11.zim") == "zimi_almanac"


def test_a_newer_file_wins_whichever_names_it_has():
    """The old name carries the ``maxi`` token the scan ranks as the richest flavour: it must not hold the name against
    the new file of a later month."""
    import zimi.server as srv

    assert srv._zim_build_rank(HD_NEW) > srv._zim_build_rank(HD_OLD)
    assert srv._zim_build_rank(MAX_NEW) > srv._zim_build_rank(MAX_OLD)
    assert srv._zim_build_rank(HD_OLD) > srv._zim_build_rank("zimi_almanac_maxi_2026-10.zim")


def _manifest(hd, tag="v1.16.1", max_book=None):
    rel = {"file": hd, "size": 2_040_872_492, "sha256": "ab" * 32, "tag": tag}
    if max_book:
        names = almanachd.chunk_names(max_book)
        rel["max"] = {
            "file": max_book,
            "size": 4_000_000_000,
            "sha256": "cd" * 32,
            "chunks": [
                {"file": names[0], "size": 2_000_000_000, "sha256": "01" * 32},
                {"file": names[1], "size": 2_000_000_000, "sha256": "02" * 32},
            ],
        }
    return json.dumps(rel)


def test_a_manifest_naming_either_generation_is_read():
    for hd, mx in ((HD_NEW, MAX_NEW), (HD_OLD, MAX_OLD)):
        m = almanachd.parse_manifest(_manifest(hd, max_book=mx), version="1.16.1")
        assert m and m["file"] == hd and m["max"]["file"] == mx and len(m["max"]["chunks"]) == 2
    for bad in ("zimi_almanac_maps_2026-12.zim", "zimi_almanac_hd_moon_2026-12.zim", "zimi_almanac_hd_2026-12.zimaa"):
        assert almanachd.parse_manifest(_manifest(bad), version="1.16.1") is None, bad


def test_the_manifest_is_the_catalog_named_one_and_a_1160_client_keeps_its_own_tags_release():
    assert almanachd.MANIFEST == "zimi_almanac_hd.json"
    assert almanachd.manifest_url("1.16.1").endswith("/v1.16.1/zimi_almanac_hd.json")
    # 1.16.0 asks its own tag for its own manifest name, which that release still carries: nothing here changes it.
    assert "/v1.16.0/" in almanachd.manifest_url("1.16.0")
    assert almanachd.parse_manifest(_manifest(HD_OLD, tag="v1.16.0", max_book=MAX_OLD), version="1.16.0")


def test_the_pins_are_the_real_1160_files():
    pin = json.load(open(os.path.join(os.path.dirname(HERE), "zimi", "assets", "almanac-tiles.json"), encoding="utf-8"))
    assert pin["hd_size"] == 2_040_872_492 and pin["max_size"] == 4_872_680_701
    assert pin["hd_size"] < almanachd.CHUNK_LIMIT   # HD stays one release file


def test_an_install_with_1160_names_is_found_and_not_fetched_again(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], HD_OLD))
    lib["scan"]()
    assert almanachd.present() == almanachd.NAME and almanachd.current() == "hd"
    assert [os.path.basename(p) for p in almanachd.files("hd")] == [HD_OLD]
    assert almanachd.base() == "/w/zimi_almanac_maxi/hd/"
    assert almanachd.start({"name": "admin"}) == (None, "installed")
    assert lib["queued"] == []


def test_a_maximum_with_1160_names_is_found_counted_and_removable(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], MAX_OLD))
    lib["scan"]()
    assert almanachd.present() == almanachd.MAX_NAME and almanachd.current() == "max"
    assert [os.path.basename(p) for p in almanachd.files("max")] == [MAX_OLD]
    assert almanachd.disk_bytes("max") == os.path.getsize(os.path.join(lib["dir"], MAX_OLD))
    assert almanachd.start({"name": "admin"}, kind="max") == (None, "installed")
    freed, err = almanachd.remove("max")
    assert err is None and freed > 0 and not os.path.exists(os.path.join(lib["dir"], MAX_OLD))


def test_a_maximum_with_the_new_names_is_found_too(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], MAX_NEW))
    lib["scan"]()
    assert almanachd.present() == almanachd.MAX_NAME
    assert [os.path.basename(p) for p in almanachd.files("max")] == [MAX_NEW]


def test_a_later_month_in_new_names_replaces_the_old_hd_as_the_one_in_use(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], HD_OLD))
    build_fixture_zim(os.path.join(lib["dir"], HD_NEW))
    lib["scan"]()
    assert [os.path.basename(p) for p in almanachd.files("hd")] == [HD_NEW]
    assert almanachd.base() == "/w/zimi_almanac_hd/hd/"
    assert almanachd.present() == almanachd.LEGACY_NAME and almanachd.current() == "hd"


LEGACY_1153 = "zimi_almanac_hd_2026-10.zim"
TILES = {"moon/albedo/0/0/0.webp": b"tile"}


def _legacy(lib):
    """1.15.3's tile ZIM: Name zimi_almanac_hd, the tiles at the top of the ZIM."""
    build_fixture_zim(os.path.join(lib["dir"], LEGACY_1153), metadata={"Name": almanachd.LEGACY_META_NAME}, files=TILES)


def _new(lib, name="zimi_almanac_hd_2026-12.zim"):
    build_fixture_zim(os.path.join(lib["dir"], name), metadata={"Name": "zimi_almanac"}, files={"hd/" + k: v for k, v in TILES.items()})


def test_a_1153_tile_zim_keeps_serving_its_tiles(lib, prefs):
    _legacy(lib)
    lib["scan"]()
    assert almanachd.present() == almanachd.LEGACY_NAME and almanachd.current() == "hd"
    assert almanachd.base() == "/w/zimi_almanac_hd/"
    assert [os.path.basename(p) for p in almanachd.files("hd")] == [LEGACY_1153]
    assert almanachd.start({"name": "admin"}) == (None, "installed")
    assert almanachd.superseded() == []


def test_a_newer_hd_replaces_the_tile_zim_and_serves_under_hd(lib, prefs):
    import zimi.server as srv

    _legacy(lib)
    lib["scan"]()
    _new(lib)
    lib["scan"]()
    assert almanachd.present() == almanachd.LEGACY_NAME
    assert almanachd.base() == "/w/zimi_almanac_hd/hd/"
    assert [os.path.basename(p) for p in almanachd.files("hd")] == ["zimi_almanac_hd_2026-12.zim"]
    # the older file is listed with the older copies, and is still on disk
    assert [o["file"] for o in srv.older_copies()] == [LEGACY_1153]
    assert os.path.exists(os.path.join(lib["dir"], LEGACY_1153))


def test_the_tile_zim_wins_only_while_it_is_the_newest(lib, prefs):
    _legacy(lib)
    _new(lib, "zimi_almanac_hd_2026-09.zim")
    lib["scan"]()
    assert almanachd.base() == "/w/zimi_almanac_hd/"
    assert [os.path.basename(p) for p in almanachd.files("hd")] == [LEGACY_1153]


def test_a_1160_hd_beside_a_newer_new_hd_counts_once(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], HD_OLD))
    _new(lib)
    lib["scan"]()
    assert almanachd.present() == almanachd.LEGACY_NAME and almanachd.base() == "/w/zimi_almanac_hd/hd/"
    assert [o["file"] for o in almanachd.superseded()] == [HD_OLD]


def test_a_maximum_in_the_new_name_removes_a_new_hd_but_not_the_tile_zim(lib, prefs):
    _legacy(lib)
    _new(lib)
    lib["scan"]()
    build_fixture_zim(os.path.join(lib["dir"], MAX_NEW))
    lib["scan"]()
    almanachd.on_installed("max")
    assert not os.path.exists(os.path.join(lib["dir"], "zimi_almanac_hd_2026-12.zim"))
    assert os.path.exists(os.path.join(lib["dir"], LEGACY_1153))


def test_dev_parts_are_not_hd_and_hd_is_not_a_part(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], "zimi_almanac_hd_moon_2026-11.zim"))
    lib["scan"]()
    assert almanachd.present() is None   # a part alone is no HD
    for part in almanachd.PARTS:
        assert not almanachd._FILE_RE.match("zimi_almanac_hd_%s_2026-11.zim" % part)
        assert not almanachd._MAX_RE.match("zimi_almanac_hd_%s_2026-11.zim" % part)
    assert not almanachd._FILE_RE.match(MAX_NEW) and not almanachd._MAX_RE.match(HD_NEW)


def test_no_new_asset_or_build_path_carries_a_retired_name():
    root = os.path.dirname(HERE)
    for rel in ("scripts/build_almanac_maxi.py", ".github/workflows/desktop-release.yml", "zimi/almanachd.py"):
        text = open(os.path.join(root, rel), encoding="utf-8").read()
        assert "almanac_maps" not in text, rel
    b = open(os.path.join(root, "scripts", "build_almanac_maxi.py"), encoding="utf-8").read()
    assert 'FILE_FMT = "zimi_almanac_hd_%s.zim"' in b and 'MAX_FILE_FMT = "zimi_almanac_hd_maxi_%s.zim"' in b
    assert 'MANIFEST = "zimi_almanac_hd.json"' in b
