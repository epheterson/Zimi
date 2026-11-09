"""The all-satellites catalogue behind the Almanac's Earth view (zimi/satcatalog.py).

Rules under test: the compact rows keep what SGP4 needs and nothing it cannot use; SATCAT's owner, launch and radar
size are joined by NORAD number and carried over to the next payload; the shipped snapshot reads, is small, and is
recent; a live fetch replaces the cache while a bad answer leaves it; a GET under Ask first or Never sends nothing out
and Automatically starts one background refresh; the route answers the catalogue at /almanac-satellites?all=1.

Run: pytest tests/test_satcatalog.py -v
"""

import gzip
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401,E402
from zimi import satcatalog as cat  # noqa: E402
from zimi import satellites  # noqa: E402
from zimi import server as srv  # noqa: E402

SNAPSHOT_MAX_BYTES = 750 * 1024
SNAPSHOT_MAX_AGE_DAYS = 30
MIN_ACTIVE = 5000


def _gp(norad, name="STARLINK-1", **over):
    rec = {
        "OBJECT_NAME": name,
        "OBJECT_ID": "2019-074B",
        "EPOCH": "2026-11-09T01:38:43.507968",
        "MEAN_MOTION": 15.7,
        "ECCENTRICITY": 0.0001,
        "INCLINATION": 53.14,
        "RA_OF_ASC_NODE": 83.5,
        "ARG_OF_PERICENTER": 337.1,
        "MEAN_ANOMALY": 22.9,
        "BSTAR": 0.0026209785,
        "NORAD_CAT_ID": norad,
        "MEAN_MOTION_DOT": 0.00337,
        "ELEMENT_SET_NO": 999,
    }
    rec.update(over)
    return rec


def _many(n=150, start=1000):
    return [_gp(start + i, "SAT-%d" % i) for i in range(n)]


SATCAT = (
    "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS\n"
    "SAT-0,2019-074B,1000,PAY,+,US,2019-11-11,AFETR,,90,53,550,540,3.5\n"
    "SAT-1,2019-074C,1001,PAY,+,PRC,2020-01-02,TSC,,90,53,550,540,\n"
)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(cat, "SNAPSHOT_PATH", str(tmp_path / "snap.json.gz"))
    monkeypatch.setattr(satellites, "_offline", lambda: False)
    cat._reset_for_tests()
    yield
    cat._reset_for_tests()


def test_compact_rows_keep_the_elements_and_round_them():
    row = cat.compact_record(_gp(44714))
    assert [row[0], row[1], row[2]] == [44714, "STARLINK-1", "2019-074B"]
    assert row[3] == pytest.approx(
        (2026 - 2000) * 365.25 + 313.07, abs=2
    )  # days since 2000-01-01
    assert row[4:10] == [15.7, 0.0001, 53.14, 83.5, 337.1, 22.9]
    assert row[10] == 0.0026210  # five significant digits
    assert row[11:] == ["", None, None]


@pytest.mark.parametrize(
    "bad",
    [
        {"MEAN_MOTION": 99},
        {"ECCENTRICITY": 1.5},
        {"EPOCH": "yesterday"},
        {"OBJECT_NAME": ""},
        {"NORAD_CAT_ID": -3},
        {"INCLINATION": "x"},
    ],
)
def test_a_bad_record_is_refused(bad):
    assert cat.compact_record(_gp(5, **bad)) is None


def test_parse_gp_refuses_a_short_or_wrong_answer_and_drops_repeats():
    with pytest.raises(ValueError):
        cat.parse_gp({"not": "a list"})
    with pytest.raises(ValueError):
        cat.parse_gp(_many(5))
    rows = cat.parse_gp(_many(150) + [_gp(1000)])
    assert len(rows) == 150 and rows == sorted(rows, key=lambda r: r[0])


def test_satcat_is_joined_by_number_and_kept_for_the_next_payload():
    rows = cat.parse_gp(_many())
    meta = cat.parse_satcat(SATCAT, {r[0] for r in rows})
    assert meta == {
        1000: ("US", (cat.datetime.date(2019, 11, 11) - cat.LAUNCH_ORIGIN).days, 3.5),
        1001: ("PRC", (cat.datetime.date(2020, 1, 2) - cat.LAUNCH_ORIGIN).days, None),
    }
    cat.join_satcat(rows, meta)
    assert rows[0][-3:] == list(meta[1000]) and rows[2][-3:] == ["", None, None]


def test_snapshot_round_trip_is_stable_bytes(tmp_path):
    rows = cat.parse_gp(_many())
    cat.join_satcat(rows, cat.parse_satcat(SATCAT, {r[0] for r in rows}))
    payload = cat.build_payload(rows, 1_800_000_000.0, 1_800_000_000.0)
    a, b = str(tmp_path / "a.gz"), str(tmp_path / "b.gz")
    cat.write_snapshot(a, payload)
    cat.write_snapshot(b, payload)
    assert open(a, "rb").read() == open(b, "rb").read()
    back = cat._read_json(a, gz=True)
    assert back["sats"] == json.loads(json.dumps(rows)) and back["cols"] == list(
        cat.COLUMNS
    )


def _stand_in(monkeypatch, gp, satcat=SATCAT, seen=None):
    def fake(url, limit):
        if seen is not None:
            seen.append(url)
        if url == cat.GP_ACTIVE_URL:
            return json.dumps(gp).encode()
        return satcat.encode()

    monkeypatch.setattr(cat, "_open", fake)


def test_refresh_replaces_the_cache_and_reads_satcat_only_for_new_satellites(
    monkeypatch,
):
    seen = []
    _stand_in(monkeypatch, _many(), seen=seen)
    first = cat.refresh()
    assert first and first["sats"][0][11] == "US"
    assert cat.GP_ACTIVE_URL in seen and cat.SATCAT_URL in seen
    assert os.path.exists(cat._cache_path())
    seen.clear()
    second = cat.refresh()
    assert second["sats"][0][11] == "US" and seen == [cat.GP_ACTIVE_URL]


def test_a_bad_answer_leaves_the_cache_as_it_was(monkeypatch):
    _stand_in(monkeypatch, _many())
    good = cat.refresh()
    _stand_in(monkeypatch, [{"junk": 1}])
    assert cat.refresh() is None
    assert cat.get(allow_refresh=False)["fetched"] == good["fetched"]


def _snapshot(age_s, tmp_path):
    rows = cat.parse_gp(_many())
    payload = cat.build_payload(rows, time.time() - age_s, time.time() - age_s)
    cat.write_snapshot(cat.SNAPSHOT_PATH, payload)


@pytest.mark.parametrize("mode", ["ask", "never"])
def test_ask_first_and_never_fetch_nothing_on_a_get(monkeypatch, tmp_path, mode):
    _snapshot(30 * 3600, tmp_path)
    monkeypatch.setattr(satellites.POLICY, "mode", lambda: (mode, None))
    monkeypatch.setattr(cat, "_open", lambda *a: pytest.fail("fetched"))
    got = cat.get()
    assert (
        got["stale"]
        and not got["refreshing"]
        and got["source"] == "snapshot"
        and len(got["sats"]) == 150
    )


def test_automatically_starts_one_background_refresh(monkeypatch, tmp_path):
    _snapshot(30 * 3600, tmp_path)
    monkeypatch.setattr(satellites.POLICY, "mode", lambda: ("auto", None))
    started = []
    monkeypatch.setattr(cat, "refresh", lambda: started.append(1))
    got = cat.get()
    assert got["refreshing"] is True
    deadline = time.time() + 5
    while not started and time.time() < deadline:
        time.sleep(0.02)
    assert started == [1]


def test_offline_forces_never_for_a_manual_refresh(monkeypatch):
    monkeypatch.setattr(satellites.POLICY, "mode", lambda: ("never", "offline"))
    assert cat.refresh_now() == (None, "never")


def test_the_shipped_snapshot_is_small_recent_and_complete():
    path = os.path.join(
        os.path.dirname(os.path.abspath(cat.__file__)),
        "assets",
        "satellites-all-snapshot.json.gz",
    )
    assert os.path.getsize(path) <= SNAPSHOT_MAX_BYTES
    with gzip.open(path, "rt", encoding="utf-8") as f:
        payload = json.load(f)
    assert payload["cols"] == list(cat.COLUMNS)
    assert len(payload["sats"]) >= MIN_ACTIVE
    assert time.time() - payload["fetched_at"] < SNAPSHOT_MAX_AGE_DAYS * 86400
    assert any(r[0] == 25544 for r in payload["sats"])


def test_the_route_answers_the_catalogue(monkeypatch, tmp_path):
    import http.client
    import threading
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    _snapshot(60, tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=20)
        c.request("GET", "/almanac-satellites?all=1")
        r = c.getresponse()
        body = json.loads(r.read())
    finally:
        httpd.shutdown()
    assert (
        r.status == 200
        and body["cols"] == list(cat.COLUMNS)
        and len(body["sats"]) == 150
        and body["stale"] is False
    )
