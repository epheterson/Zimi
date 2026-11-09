"""The launch history (launches.py) and the exact sky of a past date (spacetrack.py).

  - the GCAT parse: orbital launches only, UTC minutes, the pad's coordinates, payload counts, a batch's separation time
    and first orbit, the orbit filled in from the first payload where the launch row has none;
  - the answer follows the satellite data setting: Never and ZIMI_OFFLINE fetch nothing, Automatically refreshes a stale
    answer once in the background, a bad or short answer is refused and leaves the cache;
  - the shipped snapshot is the shape the Almanac reads, with the launches the examples use in it;
  - Space-Track: the login is saved and never echoed, a fetch logs in then queries one launch's day, the cache answers
    the second time with no network, Never refuses, no login is asked for, the credentials appear in no log line and no
    answer, and the record at or before the instant is the one chosen. The recorded response is a synthetic fixture of
    the API's shape (tests/fixtures/spacetrack-gp-history.json: made-up objects, not real elements).

Run: pytest tests/test_launches.py -v
"""

import calendar
import gzip
import json
import logging
import os
import time

import pytest

from zimi import launches, spacetrack
from zimi import satellites
from zimi import server as srv

FIXTURE = os.path.join(
    os.path.dirname(__file__), "fixtures", "spacetrack-gp-history.json"
)

LAUNCH_HEAD = "#Launch_Tag\tLaunch_JD\tLaunch_Date\tLV_Type\tVariant\tFairing\tFlight_ID\tFlight\tMission\tFlightCode\tPlatform\tLaunch_Site\tLaunch_Pad\tAscent_Site\tAscent_Pad\tPerigee\tApogee\tApoflag\tInc\tAzimuth\tRange\tRangeFlag\tDest\tOrbMass\tOrbPay\tAgency\tLaunchCode\tFailCode\tGroup\tCategory\tLTCite\tCite\tNotes\n"


def _launch(tag, date, veh, mission, site, pad, peri="-", apo="-", inc="-", code="OS"):
    cols = [
        tag,
        "2459000.5",
        date,
        veh,
        "-",
        "-",
        "1",
        "-",
        mission,
        "-",
        "-",
        site,
        pad,
        "-",
        "-",
        peri,
        apo,
        "",
        inc,
        "-",
        "-",
        "",
        "-",
        "0",
        "0",
        "AGY",
        code,
        "-",
        "-",
        "Sat",
        "-",
        "-",
        "-",
    ]
    return "\t".join(cols) + "\n"


def _sat(tag, piece, typ, sep, odate, peri, apo, inc):
    cols = (
        ["S1", "1", tag, piece, typ]
        + ["N"] * 4
        + [sep]
        + ["x"] * 22
        + [odate, peri, "", apo, "", inc]
    )
    cols[9] = sep
    cols[32] = odate
    cols[33], cols[35], cols[37] = peri, apo, inc
    return "\t".join(cols) + "\n"


def _src():
    launch = LAUNCH_HEAD + "# Updated\n"
    launch += _launch(
        "2021-001",
        "2021 May  4 1901",
        "Falcon 9",
        "Starlink V1.0-L99",
        "KSC",
        "LC39A",
        "-",
        "562",
    )
    launch += _launch(
        "2021-F01",
        "2021 May  6 0100:30",
        "Electron",
        "Test flight",
        "MAHIA",
        "LC1A",
        "-",
        "-",
        "-",
        "OF",
    )
    launch += _launch(
        "1960-A01", "1960 May  6 0100", "V-2", "-", "HVP", "P7", code="MS"
    )  # suborbital: left out
    launch += _launch(
        "1960-002", "1960 May  7", "Atlas", "-", "KSC", "LC39A"
    )  # no time of day: left out
    sites = "#Site\tCode\tUCode\tType\tStateCode\tTStart\tTStop\tShortName\tName\tLocation\tLongitude\tLatitude\n"
    sites += "KSC\t-\tKSC\tLS\tUS\t1962\t*\tKennedy\tKennedy Space Center\tFlorida\t-80.6\t28.6\n"
    sites += "MAHIA\t-\tM\tLS\tNZ\t1\t*\tMahia\tMahia\tNZ\t177.8\t-39.2\n"
    pads = "#Site\tCode\tUCode\tType\tStateCode\tTStart\tTStop\tShortName\tName\tLocation\tLongitude\tLatitude\n"
    pads += "KSC\tLC39A\tx\tLP\t-\t1\t*\tLC39A\tLC-39A\tx\t-80.6043\t28.6080\n"
    psat = "#JCAT\tPiece\tName\n"
    for i in range(5):
        psat += "S%d\t2021-001%s\tStarlink-%d\n" % (i, "ABCDE"[i], i)
    satcat = "#JCAT\tSatcat\tLaunch_Tag\tPiece\tType\n"
    for i in range(5):
        satcat += _sat(
            "2021-001",
            "2021-001" + "ABCDE"[i],
            "P",
            "2021 May  4 2004",
            "2021 May  5",
            "261",
            "276",
            "53.05",
        )
    return {
        "launch": launch,
        "sites": sites,
        "pads": pads,
        "psatcat": psat,
        "satcat": satcat,
    }


def test_parse_keeps_orbital_launches_with_utc_minutes_pads_and_batches():
    p = launches.build(_src())
    assert len(p["l"]) == 2
    first = p["l"][0]
    assert first[0] * 60 == calendar.timegm((2021, 5, 4, 19, 1, 0))   # 2021-05-04 19:01 UTC
    assert p["veh"][first[1]] == "Falcon 9"
    assert p["pads"][first[2]][:5] == ["KSC", "LC39A", "Kennedy", 28.608, -80.604]
    assert first[3] == "Starlink V1.0-L99" and first[4] == 1
    assert first[9] == 5 and first[10] == ["Starlink-0", "Starlink-1", "Starlink-2"]
    assert first[11] == 63  # separation 20:04, minutes after 19:01
    assert first[13:15] == [261, 276]  # the orbit GCAT recorded
    assert (
        first[7] == 53.05 and first[6] == 562
    )  # inclination filled in from the first payload, the apogee the launch row's own
    assert first[-1] == "2021-001"
    assert p["l"][1][4] == 0  # OF: the launch failed


def test_cols_match_the_row_width_and_the_snapshot():
    snap = launches.read_snapshot()
    assert snap and snap["cols"] == launches.COLUMNS
    assert all(
        len(r) == len(launches.COLUMNS) for r in snap["l"][:50] + snap["l"][-50:]
    )
    assert 7000 < len(snap["l"]) < 9000
    assert snap["l"] == sorted(snap["l"], key=lambda r: r[0])
    assert os.path.getsize(launches.SNAPSHOT_PATH) < 400 * 1024


def test_the_snapshot_holds_the_launches_the_docs_use():
    snap = launches.read_snapshot()
    rows = {r[-1]: r for r in snap["l"]}
    r = rows["2021-038"]  # Starlink V1.0-L25
    assert snap["veh"][r[1]] == "Falcon 9" and r[3].startswith("Starlink V1.0-L25")
    assert snap["pads"][r[2]][1] == "LC39A" and r[9] == 60 and r[11] == 63
    a11 = rows["1969-059"]   # Apollo 11: deep-space launches are in too
    assert snap["veh"][a11[1]] == "Saturn V" and snap["pads"][a11[2]][1] == "LC39A" and a11[7] == 32.6


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(satellites, "_offline", lambda: False)
    launches._reset_for_tests()
    spacetrack._reset_for_tests()
    monkeypatch.setattr(spacetrack, "MIN_INTERVAL_S", 0)
    yield tmp_path
    launches._reset_for_tests()


def _mode(monkeypatch, mode):
    monkeypatch.setattr(satellites, "update_mode", lambda: (mode, None))


def _write_cache(tmp_path, age_s, monkeypatch):
    """A cache `age_s` old, newer than a shipped snapshot a year old."""
    payload = dict(launches.read_snapshot())
    monkeypatch.setattr(launches, "read_snapshot", lambda: dict(payload, fetched_at=time.time() - 365 * 86400))
    (tmp_path / launches.CACHE_FILENAME).write_text(json.dumps(dict(payload, fetched_at=time.time() - age_s)))


def test_get_answers_from_the_snapshot_and_fetches_nothing(isolated, monkeypatch):
    _mode(monkeypatch, "ask")
    monkeypatch.setattr(launches, "fetch_live", lambda: pytest.fail("fetched"))
    a = launches.get()
    assert (
        a["source"] == "snapshot"
        and a["mode"] == "ask"
        and not a["refreshing"]
        and len(a["l"]) > 7000
    )


@pytest.mark.parametrize("mode", ["ask", "never"])
def test_a_stale_answer_is_not_refreshed_unless_automatic(isolated, monkeypatch, mode):
    _mode(monkeypatch, mode)
    _write_cache(isolated, launches.CACHE_TTL_S + 100, monkeypatch)
    monkeypatch.setattr(launches, "fetch_live", lambda: pytest.fail("fetched"))
    a = launches.get()
    assert a["stale"] and not a["refreshing"]


def test_automatic_refreshes_a_stale_answer_once_in_the_background(
    isolated, monkeypatch
):
    _mode(monkeypatch, "auto")
    _write_cache(isolated, launches.CACHE_TTL_S + 100, monkeypatch)
    calls = []
    fresh = dict(launches.read_snapshot(), fetched_at=time.time())
    monkeypatch.setattr(launches, "fetch_live", lambda: calls.append(1) or fresh)
    a = launches.get()
    assert a["refreshing"]
    for _ in range(100):
        if calls and not launches._refreshing:
            break
        time.sleep(0.02)
    assert len(calls) == 1
    assert launches.get(allow_refresh=False)["source"] == "cache"


def test_offline_forces_never_and_a_short_answer_is_refused(isolated, monkeypatch):
    monkeypatch.setattr(satellites, "_offline", lambda: True)
    assert launches._kick_refresh() is False
    with pytest.raises(ValueError):
        monkeypatch.setattr(launches, "_open", lambda rel, limit: "")
        launches.fetch_live()
    _mode(monkeypatch, "never")
    assert launches.refresh_now() == (None, "never")


def _fixture():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture
def st(isolated, monkeypatch):
    prefs = {}
    monkeypatch.setattr(spacetrack.p2p, "_read_prefs", lambda: dict(prefs))
    monkeypatch.setattr(spacetrack.p2p, "set_prefs", lambda v: prefs.update(v) or True)
    monkeypatch.delenv(spacetrack.ENV_USER, raising=False)
    monkeypatch.delenv(spacetrack.ENV_PASSWORD, raising=False)
    _mode(monkeypatch, "ask")
    seen = []

    def request(opener, url, data=None):
        seen.append((url, data))
        return (
            b'{"Login":"Failed"}'
            if data and b"bad" in data
            else (b"" if data else json.dumps(_fixture()).encode())
        )

    monkeypatch.setattr(spacetrack, "_request", request)
    return seen, prefs


T = int(
    time.mktime((2099, 1, 1, 0, 0, 0, 0, 0, 0))
)  # replaced below by a fixed UTC instant
MS = 1_700_000_000_000  # 2023-11-14 22:13:20 UTC


def test_the_login_is_saved_and_never_echoed(st):
    assert spacetrack.view()["password_set"] is False
    assert spacetrack.save("me@example.invalid", "hunter2")
    v = spacetrack.view()
    assert v == {"user": "me@example.invalid", "password_set": True, "locked": False}
    assert "hunter2" not in json.dumps(v)
    assert spacetrack.save("", "x") and not spacetrack.view()["password_set"]


def test_a_fetch_logs_in_queries_one_launch_and_keeps_the_record_at_or_before_the_instant(
    st, caplog
):
    seen, _ = st
    spacetrack.save("me@example.invalid", "hunter2")
    with caplog.at_level(logging.DEBUG):
        records = spacetrack.get("9999-001", MS)
    assert [u for u, d in seen][0].endswith("/ajaxauth/login") and b"hunter2" in seen[
        0
    ][1]
    q = seen[1][0]
    assert (
        "gp_history" in q
        and "OBJECT_ID/~~9999-001" in q
        and "2023-11-10--2023-11-15" in q
        and "format/json" in q
    )
    by = {r["NORAD_CAT_ID"]: r for r in records}
    assert sorted(by) == [99001, 99002, 99003]
    assert by[99001]["EPOCH"].startswith(
        "2023-11-14T12"
    )  # the newest of the two at or before 22:13
    assert by[99003]["EPOCH"].startswith("2023-11-15")  # none before: the first after
    assert "hunter2" not in caplog.text and "me@example.invalid" not in caplog.text


def test_the_second_ask_for_a_day_is_answered_from_the_cache_with_no_network(
    st, monkeypatch
):
    seen, _ = st
    spacetrack.save("u@example.invalid", "pw")
    first = spacetrack.get("9999-001", MS)
    n = len(seen)
    _mode(monkeypatch, "never")  # a cached day needs no fetch, so Never does not matter
    assert spacetrack.get("9999-001", MS + 3_600_000) == first
    assert len(seen) == n
    assert os.path.isdir(os.path.join(srv.ZIMI_DATA_DIR, spacetrack.CACHE_DIR))


def test_refusals_say_why(st, monkeypatch):
    with pytest.raises(spacetrack.SpaceTrackError) as e:
        spacetrack.get("9999-001", MS)
    assert (e.value.status, e.value.code) == (424, "login")
    spacetrack.save("u@example.invalid", "bad")
    with pytest.raises(spacetrack.SpaceTrackError) as e:
        spacetrack.get("9999-001", MS)
    assert (e.value.status, e.value.code) == (401, "login")
    _mode(monkeypatch, "never")
    with pytest.raises(spacetrack.SpaceTrackError) as e:
        spacetrack.get("9999-001", MS)
    assert (e.value.status, e.value.code) == (409, "never")
    for bad in ("../etc", "", None, "2021-0381"):
        with pytest.raises(spacetrack.SpaceTrackError) as e:
            spacetrack.get(bad, MS)
        assert e.value.status == 400


def test_the_environment_wins_and_is_reported_locked(st, monkeypatch):
    spacetrack.save("saved@example.invalid", "x")
    monkeypatch.setenv(spacetrack.ENV_USER, "env@example.invalid")
    monkeypatch.setenv(spacetrack.ENV_PASSWORD, "y")
    assert spacetrack.credentials() == ("env@example.invalid", "y")
    assert spacetrack.view()["locked"] is True


def test_a_gzip_snapshot_roundtrips_byte_for_byte(tmp_path):
    p = launches.read_snapshot()
    a, b = str(tmp_path / "a.gz"), str(tmp_path / "b.gz")
    launches.write_snapshot(a, p)
    launches.write_snapshot(b, p)
    assert open(a, "rb").read() == open(b, "rb").read()
    assert json.loads(gzip.open(a, "rt").read())["l"][0] == p["l"][0]
