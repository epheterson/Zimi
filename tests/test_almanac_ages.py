"""/almanac-ages: how old each piece of outside data on this machine is, for
the Almanac's "What stops being true" sheet. Every answer is a file read;
asking must never reach the network, even under "Automatically" with stale
satellite elements (the sheet would otherwise be a way to start a refresh).
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401,E402  (module init via the package proxy)
from zimi import http as _http  # noqa: E402
from zimi import library  # noqa: E402
from zimi import satellites  # noqa: E402
from zimi import server as srv  # noqa: E402


def test_ages_read_files_and_never_refresh(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        satellites, "update_mode", lambda: (satellites.UPDATE_AUTO, None)
    )

    def no_refresh():
        raise AssertionError("asking for ages started a refresh")

    monkeypatch.setattr(satellites, "_kick_refresh", no_refresh)
    ages = _http._almanac_ages()
    assert set(ages) == {"tzdata", "tz_map", "satellites", "catalog"}
    # The shipped zone map names its timezone-boundary-builder release.
    assert ages["tz_map"] and ages["tz_map"][:2] == "20"
    assert ages["satellites"]["fetched"]
    # No cached catalog here: the shipped snapshot's build date.
    assert ages["catalog"]["source"] == "snapshot"


def test_a_cached_catalog_is_dated_by_its_file(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    path = library._full_catalog_path()
    with open(path, "w") as f:
        f.write("{}")
    stamp = time.mktime((2026, 3, 4, 12, 0, 0, 0, 0, -1))
    os.utime(path, (stamp, stamp))
    assert _http._almanac_ages()["catalog"] == {
        "source": "cache",
        "as_of": "2026-03-04",
    }


def test_the_route_is_rate_limited_like_the_other_api_reads():
    limited, content = _http._rate_class("/almanac-ages")
    assert limited and not content
