"""Updates for maps from both sources.

Kiwix's maps are named like every other Kiwix ZIM and ride the normal
updater. StreetZim's are not: osm-hawaii-2026-09-08.zim carries its date to
the day, with dashes, and the Kiwix catalog knows nothing of it. Eric,
2026-09-18: "We should handle updates for the maps from both sources too."

Run: pytest tests/test_map_updates.py -v
"""

import os
import sys

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

import zimi.library as lib  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import streetzim  # noqa: E402

# ── the name and the date ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "filename,base,date",
    [
        ("wikipedia_en_all_maxi_2026-02.zim", "wikipedia_en_all_maxi", "2026-02"),
        ("osm-hawaii-2026-09-08.zim", "osm-hawaii", "2026-09-08"),
        ("osm-silicon-valley-2026-09-06.zim", "osm-silicon-valley", "2026-09-06"),
        ("samoa.zim", "samoa", None),
        ("maps_en_samoa_2026-06.zim", "maps_en_samoa", "2026-06"),
    ],
)
def test_the_date_is_read_from_either_shape(filename, base, date):
    assert srv._extract_zim_date(filename) == (base, date)


def test_a_streetzim_file_takes_a_name_that_survives_an_update():
    assert srv._zim_short_name("osm-hawaii-2026-09-08.zim") == "osm-hawaii"
    assert srv._zim_short_name("osm-hawaii-2026-10-01.zim") == "osm-hawaii"
    assert srv._zim_short_name("maps_en_samoa_2026-06.zim") == "maps_en_samoa"


# ── the previous version, for delta reuse and for retiring ────────────────


def test_the_previous_streetzim_build_is_found(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    for f in (
        "osm-hawaii-2026-09-06.zim",
        "osm-hawaii-2026-09-08.zim",
        "osm-alaska-2026-09-10.zim",
    ):
        (tmp_path / f).write_bytes(b"x")
    assert (
        lib._find_previous_version("osm-hawaii-2026-10-01.zim")
        == "osm-hawaii-2026-09-08.zim"
    )
    assert lib._find_previous_version("osm-alaska-2026-09-10.zim") is None
    assert lib._find_previous_version("wikipedia_en_all_2026-03.zim") is None


def test_kiwix_previous_versions_still_match(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    (tmp_path / "wikipedia_en_all_maxi_2026-02.zim").write_bytes(b"x")
    assert (
        lib._find_previous_version("wikipedia_en_all_maxi_2026-03.zim")
        == "wikipedia_en_all_maxi_2026-02.zim"
    )


# ── the check ──────────────────────────────────────────────────────────────


def _listing(*items):
    return lambda allow_refresh=True: (list(items), "cache", "2026-09-19", False)


def test_a_newer_streetzim_build_is_an_update(monkeypatch):
    monkeypatch.setattr(
        streetzim,
        "get",
        _listing(
            {
                "name": "osm-hawaii",
                "date": "2026-10-01",
                "title": "Hawaii",
                "size_bytes": 10,
                "download_url": "https://archive.org/download/streetzim-hawaii/osm-hawaii-2026-10-01.zim",
            },
            {
                "name": "osm-alaska",
                "date": "2026-09-10",
                "title": "Alaska",
                "size_bytes": 5,
                "download_url": "https://archive.org/download/streetzim-alaska/osm-alaska-2026-09-10.zim",
            },
        ),
    )
    installed = [
        {
            "name": "osm-hawaii",
            "date": "2026-09-08",
            "filename": "osm-hawaii-2026-09-08.zim",
            "filebase": "osm-hawaii-2026-09-08",
        },
        {
            "name": "osm-alaska",
            "date": "2026-09-10",
            "filename": "osm-alaska-2026-09-10.zim",
            "filebase": "osm-alaska-2026-09-10",
        },
        {
            "name": "wikipedia",
            "date": "2026-02",
            "filename": "wikipedia_en_all_2026-02.zim",
            "filebase": "wikipedia_en_all_2026-02",
        },
    ]
    ups = lib._check_streetzim_updates(installed)
    assert [(u["name"], u["installed_date"], u["latest_date"]) for u in ups] == [
        ("osm-hawaii", "2026-09-08", "2026-10-01")
    ]
    assert ups[0]["download_url"].startswith(
        "https://archive.org/download/streetzim-hawaii/"
    )


def test_no_streetzim_maps_means_the_listing_is_not_even_read(monkeypatch):
    called = []
    monkeypatch.setattr(
        streetzim,
        "get",
        lambda allow_refresh=True: called.append(1) or ([], "none", "", False),
    )
    assert (
        lib._check_streetzim_updates(
            [
                {
                    "name": "w",
                    "date": "2026-02",
                    "filename": "w_en_all_2026-02.zim",
                    "filebase": "w_en_all_2026-02",
                }
            ]
        )
        == []
    )
    assert called == []


def test_check_updates_carries_streetzim_updates_even_without_the_kiwix_catalog(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    (tmp_path / "osm-hawaii-2026-09-08.zim").write_bytes(b"x")
    monkeypatch.setattr(
        srv,
        "get_zim_files",
        lambda: {"osm-hawaii": str(tmp_path / "osm-hawaii-2026-09-08.zim")},
    )
    monkeypatch.setattr(lib, "_full_catalog", lambda: [])
    monkeypatch.setattr(
        streetzim,
        "get",
        _listing(
            {
                "name": "osm-hawaii",
                "date": "2026-10-01",
                "title": "Hawaii",
                "size_bytes": 10,
                "download_url": "https://archive.org/download/x/osm-hawaii-2026-10-01.zim",
            }
        ),
    )
    ups = lib._check_updates()
    assert [u["latest_date"] for u in ups] == ["2026-10-01"]


# ── the shipped listing ────────────────────────────────────────────────────


def test_a_machine_that_never_reached_the_archive_gets_the_shipped_listing(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"))
    snap = tmp_path / "snap.json.gz"
    streetzim.write_snapshot(
        str(snap), [{"name": "osm-hawaii", "title": "Hawaii"}], "2026-09-19"
    )
    monkeypatch.setattr(streetzim, "SNAPSHOT_PATH", str(snap))
    monkeypatch.setattr(streetzim, "_offline", lambda: True)
    streetzim._reset_for_tests()
    items, source, as_of, _ = streetzim.get()
    assert (source, as_of, [i["name"] for i in items]) == (
        "snapshot",
        "2026-09-19",
        ["osm-hawaii"],
    )


def test_the_shipped_snapshot_writes_the_same_bytes_twice(tmp_path):
    import time

    a, b = tmp_path / "a.gz", tmp_path / "b.gz"
    streetzim.write_snapshot(str(a), [{"name": "osm-x"}], "2026-09-19")
    time.sleep(1.1)
    streetzim.write_snapshot(str(b), [{"name": "osm-x"}], "2026-09-19")
    assert a.read_bytes() == b.read_bytes()


def test_the_shipped_streetzim_snapshot_is_present_and_fresh():
    import datetime

    if not os.path.exists(streetzim.SNAPSHOT_PATH):
        pytest.skip("no StreetZim snapshot built in this checkout")
    items, built = streetzim._read_snapshot()
    assert items and len(items) > 20
    assert all(
        i.get("name", "").startswith("osm-") and i.get("download_url") for i in items
    )
    age = (datetime.date.today() - datetime.date.fromisoformat(built)).days
    assert age < 180, "run scripts/build_catalog_snapshot.py"
