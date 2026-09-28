"""/almanac-satellites: the orbital elements behind the Almanac's Earth view.

The view draws the GPS constellation and the ISS from elements the server
hands it. The rules under test:

  - it answers at once from what is here (the shipped snapshot, or a newer
    cache) and never waits on the network;
  - a stale answer starts one background refresh, never more at a time, and
    a failed one backs off and leaves the old elements in place;
  - ZIMI_OFFLINE means no refresh at all;
  - the upstream request carries Zimi's user agent and nothing else;
  - a bad or partial answer from upstream is refused, field by field;
  - the route is rate limited like the other API reads, and the service
    worker asks the network first but keeps a copy for offline;
  - the shipped snapshot is recent enough for the view to draw it.

Run: pytest tests/test_almanac_satellites.py -v
"""

import json
import os
import re
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401,E402  (module init via the package proxy)
from zimi import http as _http  # noqa: E402
from zimi import satellites  # noqa: E402
from zimi import server as srv  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_EARTH_JS = os.path.join(_HERE, "..", "zimi", "static", "almanac-earth.js")
# The view draws elements up to AE_SAT_WINDOW_DAYS (almanac-earth.js) from
# their epoch. A machine that never goes online draws satellites only from
# the snapshot its release shipped, for whatever of that window the snapshot
# had left on the day the release was cut. So a release ships a snapshot at
# most SNAPSHOT_MAX_AGE_DAYS old, and the two together must leave an offline
# install OFFLINE_RUNWAY_DAYS of satellites: the time to the next release,
# and the months a USB copy can sit in a drawer before it is first used.
SNAPSHOT_MAX_AGE_DAYS = 30
OFFLINE_RUNWAY_DAYS = 150


def _earth_js_days(name):
    with open(_EARTH_JS, encoding="utf-8") as f:
        m = re.search(r"^var " + name + r" = (\d+);", f.read(), re.M)
    assert m, f"{name} not found in almanac-earth.js"
    return int(m.group(1))


def _omm(
    name="GPS BIII-1  (PRN 04)", norad=43873, epoch="2026-09-26T23:09:35.513568", **over
):
    rec = {
        "OBJECT_NAME": name,
        "OBJECT_ID": "2018-109A",
        "EPOCH": epoch,
        "MEAN_MOTION": 2.00561234,
        "ECCENTRICITY": 0.0021,
        "INCLINATION": 55.1,
        "RA_OF_ASC_NODE": 170.2,
        "ARG_OF_PERICENTER": 190.3,
        "MEAN_ANOMALY": 20.4,
        "EPHEMERIS_TYPE": 0,
        "CLASSIFICATION_TYPE": "U",
        "NORAD_CAT_ID": norad,
        "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 5000,
        "BSTAR": 0,
        "MEAN_MOTION_DOT": 1e-7,
        "MEAN_MOTION_DDOT": 0,
    }
    rec.update(over)
    return rec


def _iss(**over):
    base = dict(
        name="ISS (ZARYA)",
        norad=satellites.ISS_NORAD_ID,
        MEAN_MOTION=15.49,
        INCLINATION=51.63,
        BSTAR=0.00018,
    )
    base.update(over)
    return _omm(**base)


def _payload(fetched_at, marker="x"):
    return satellites.parse_payload([_omm(OBJECT_ID=marker)], [_iss()], fetched_at)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(satellites, "_offline", lambda: False)
    monkeypatch.setattr(satellites, "SNAPSHOT_PATH", str(tmp_path / "snapshot.json"))
    satellites._reset_for_tests()
    yield tmp_path
    satellites._reset_for_tests()


def _no_network(*a, **k):
    raise AssertionError("the network was asked")


# ── Answering from what is here ─────────────────────────────────────────────


def test_the_snapshot_answers_when_nothing_newer_is_here(data_dir, monkeypatch):
    satellites.write_snapshot(satellites.SNAPSHOT_PATH, _payload(time.time(), "snap"))
    monkeypatch.setattr(satellites, "fetch_live", _no_network)
    got = satellites.get()
    assert got["source"] == "snapshot"
    assert got["gps"][0]["OBJECT_ID"] == "snap"
    assert got["iss"]["NORAD_CAT_ID"] == satellites.ISS_NORAD_ID


def test_a_newer_cache_outranks_the_snapshot(data_dir, monkeypatch):
    now = time.time()
    satellites.write_snapshot(satellites.SNAPSHOT_PATH, _payload(now - 86400, "snap"))
    srv._atomic_write_json(
        os.path.join(str(data_dir), satellites.CACHE_FILENAME), _payload(now, "cache")
    )
    monkeypatch.setattr(satellites, "fetch_live", _no_network)
    got = satellites.get()
    assert got["source"] == "cache"
    assert got["gps"][0]["OBJECT_ID"] == "cache"


def test_a_newer_snapshot_outranks_an_old_cache(data_dir, monkeypatch):
    """An upgrade ships fresher elements than a machine cached a year ago."""
    now = time.time()
    satellites.write_snapshot(satellites.SNAPSHOT_PATH, _payload(now, "snap"))
    srv._atomic_write_json(
        os.path.join(str(data_dir), satellites.CACHE_FILENAME),
        _payload(now - 365 * 86400, "cache"),
    )
    monkeypatch.setattr(satellites, "_kick_refresh", lambda: None)
    assert satellites.get()["gps"][0]["OBJECT_ID"] == "snap"


def test_nothing_here_is_an_honest_empty_answer(data_dir, monkeypatch):
    monkeypatch.setattr(satellites, "_kick_refresh", lambda: None)
    got = satellites.get()
    assert got == {"source": "none", "fetched": None, "gps": [], "iss": None}


# ── Refreshing ──────────────────────────────────────────────────────────────


def test_a_stale_answer_is_served_at_once_and_refreshed_behind_it(
    data_dir, monkeypatch
):
    satellites.write_snapshot(
        satellites.SNAPSHOT_PATH,
        _payload(time.time() - satellites.CACHE_TTL_S - 60, "old"),
    )
    started = threading.Event()
    release = threading.Event()

    def slow_fetch():
        started.set()
        release.wait(5)
        return _payload(time.time(), "live")

    monkeypatch.setattr(satellites, "fetch_live", slow_fetch)
    t0 = time.time()
    got = satellites.get()
    assert time.time() - t0 < 0.5, "the answer waited on the network"
    assert got["gps"][0]["OBJECT_ID"] == "old"
    assert started.wait(2), "no background refresh started"
    # A second request while that refresh is running starts no other.
    calls = []
    monkeypatch.setattr(
        satellites,
        "fetch_live",
        lambda: calls.append(1) or _payload(time.time(), "dup"),
    )
    satellites.get()
    time.sleep(0.2)
    assert calls == []
    release.set()
    for _ in range(50):
        if satellites.read_cache():
            break
        time.sleep(0.05)
    assert satellites.get()["gps"][0]["OBJECT_ID"] == "live"


def test_a_fresh_answer_asks_nothing(data_dir, monkeypatch):
    satellites.write_snapshot(satellites.SNAPSHOT_PATH, _payload(time.time(), "fresh"))
    monkeypatch.setattr(satellites, "fetch_live", _no_network)
    monkeypatch.setattr(satellites, "_kick_refresh", _no_network)
    assert satellites.get()["gps"][0]["OBJECT_ID"] == "fresh"


def test_offline_never_reaches_out(data_dir, monkeypatch):
    satellites.write_snapshot(
        satellites.SNAPSHOT_PATH, _payload(time.time() - 30 * 86400, "old")
    )
    monkeypatch.setattr(satellites, "_offline", lambda: True)
    monkeypatch.setattr(satellites, "fetch_live", _no_network)
    monkeypatch.setattr(threading, "Thread", _no_network)
    got = satellites.get()
    assert got["gps"][0]["OBJECT_ID"] == "old"


def test_zimi_offline_is_the_switch(data_dir, monkeypatch):
    """The real switch, read where the rest of Zimi reads it."""
    monkeypatch.undo()
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert satellites._offline() is True
    monkeypatch.setenv("ZIMI_OFFLINE", "0")
    assert satellites._offline() is False


def test_a_failed_refresh_keeps_the_elements_and_backs_off(data_dir, monkeypatch):
    cache = os.path.join(str(data_dir), satellites.CACHE_FILENAME)
    srv._atomic_write_json(
        cache, _payload(time.time() - satellites.CACHE_TTL_S - 60, "kept")
    )
    before = open(cache, encoding="utf-8").read()

    def boom():
        raise OSError("no route to host")

    monkeypatch.setattr(satellites, "fetch_live", boom)
    assert satellites.refresh() is None
    assert open(cache, encoding="utf-8").read() == before
    assert satellites.get()["gps"][0]["OBJECT_ID"] == "kept"
    # Inside the cooldown a stale answer does not try again.
    monkeypatch.setattr(threading, "Thread", _no_network)
    satellites.get()


def test_a_refresh_replaces_the_cache(data_dir, monkeypatch):
    monkeypatch.setattr(satellites, "fetch_live", lambda: _payload(time.time(), "new"))
    assert satellites.refresh()["gps"][0]["OBJECT_ID"] == "new"
    assert satellites.read_cache()["gps"][0]["OBJECT_ID"] == "new"


def test_the_upstream_request_carries_nothing_about_the_viewer(data_dir, monkeypatch):
    seen = []

    class _Resp:
        def __init__(self, body):
            self.body = body

        def read(self, n=-1):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen.append(req)
        body = [_iss()] if "CATNR" in req.full_url else [_omm()]
        return _Resp(json.dumps(body).encode())

    monkeypatch.setattr(satellites.urllib.request, "urlopen", fake_urlopen)
    payload = satellites.fetch_live()
    assert (
        len(payload["gps"]) == 1
        and payload["iss"]["NORAD_CAT_ID"] == satellites.ISS_NORAD_ID
    )
    assert [r.host for r in seen] == ["celestrak.org", "celestrak.org"]
    for r in seen:
        assert {k.lower() for k, _ in r.header_items()} == {"user-agent"}
        assert r.get_header("User-agent").startswith("Zimi/")
        assert r.data is None


# ── Refusing a bad answer ───────────────────────────────────────────────────


def test_the_epoch_is_written_the_way_every_browser_parses_it():
    rec = satellites.normalize_record(_omm(epoch="2026-09-26T23:09:35.513568"))
    assert rec["EPOCH"] == "2026-09-26T23:09:35.513Z"
    assert (
        satellites.normalize_record(_omm(epoch="2026-09-26T23:09:35"))["EPOCH"]
        == "2026-09-26T23:09:35.000Z"
    )


@pytest.mark.parametrize(
    "bad",
    [
        {"MEAN_MOTION": 40},
        {"ECCENTRICITY": 1.2},
        {"INCLINATION": float("nan")},
        {"MEAN_ANOMALY": "not a number"},
        {"EPOCH": "yesterday"},
        {"OBJECT_NAME": ""},
        {"NORAD_CAT_ID": -3},
    ],
)
def test_a_record_out_of_reason_is_refused(bad):
    assert satellites.normalize_record(_omm(**bad)) is None


def test_an_answer_without_the_iss_is_refused():
    with pytest.raises(ValueError):
        satellites.parse_payload([_omm()], [_omm(norad=12345)], time.time())
    with pytest.raises(ValueError):
        satellites.parse_payload({"error": "rate limited"}, [], time.time())


def test_only_the_fields_the_view_reads_are_kept():
    rec = satellites.normalize_record(_omm(EXTRA="<script>"))
    assert "EXTRA" not in rec and "REV_AT_EPOCH" not in rec


# ── The route ───────────────────────────────────────────────────────────────


def test_the_route_is_rate_limited_like_the_other_api_reads():
    limited, content = _http._rate_class("/almanac-satellites")
    assert limited and not content


def test_the_route_answers_with_the_elements(data_dir, monkeypatch):
    """A real server: GET /almanac-satellites is the payload, at once."""
    from http.server import ThreadingHTTPServer
    import urllib.request

    satellites.write_snapshot(satellites.SNAPSHOT_PATH, _payload(time.time(), "route"))
    monkeypatch.setattr(satellites, "fetch_live", _no_network)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _http.ZimHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/almanac-satellites"
        with urllib.request.urlopen(url, timeout=10) as resp:
            assert resp.status == 200
            assert resp.headers.get("Content-Type") == "application/json"
            body = json.loads(resp.read())
    finally:
        server.shutdown()
        server.server_close()
    assert body["source"] == "snapshot"
    assert body["gps"][0]["OBJECT_ID"] == "route"
    assert body["iss"]["NORAD_CAT_ID"] == satellites.ISS_NORAD_ID


def test_the_service_worker_asks_the_network_first():
    node = __import__("shutil").which("node")
    if not node:
        pytest.skip("node not available")
    sw = os.path.join(_HERE, "..", "zimi", "static", "sw.js")
    driver = (
        "const vm=require('vm'),fs=require('fs');const self={addEventListener(){}};"
        "const ctx={self,URL,caches:{},fetch(){},Response:class{},console};vm.createContext(ctx);"
        "vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),ctx);"
        "process.stdout.write(self.routeStrategy('/almanac-satellites','cors'))"
    )
    import subprocess

    out = subprocess.run(
        [node, "-e", driver, sw], capture_output=True, text=True, timeout=30
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout == "networkFirst"


# ── What ships ──────────────────────────────────────────────────────────────


def test_the_shipped_snapshot_is_whole_and_recent():
    snap = satellites._read_json(
        os.path.join(
            os.path.dirname(satellites.__file__), "assets", "satellites-snapshot.json"
        )
    )
    assert snap, "zimi/assets/satellites-snapshot.json is missing or unreadable"
    assert len(snap["gps"]) >= 24, "fewer GPS satellites than the constellation needs"
    assert snap["iss"]["NORAD_CAT_ID"] == satellites.ISS_NORAD_ID
    for rec in snap["gps"] + [snap["iss"]]:
        assert satellites.normalize_record(rec) == rec, rec["OBJECT_NAME"]
    age_days = (time.time() - snap["fetched_at"]) / 86400
    assert age_days < SNAPSHOT_MAX_AGE_DAYS, (
        f"the satellite snapshot is {age_days:.0f} days old: "
        "run python3 scripts/build_satellite_snapshot.py before the release"
    )


def test_the_release_gate_leaves_an_offline_install_months_of_satellites():
    """Gating at the drawing window itself let a release ship a snapshot the
    view would stop drawing the next day: every GPS satellite gone, offline."""
    window = _earth_js_days("AE_SAT_WINDOW_DAYS")
    assert window - SNAPSHOT_MAX_AGE_DAYS >= OFFLINE_RUNWAY_DAYS, (
        f"a {SNAPSHOT_MAX_AGE_DAYS}-day-old snapshot leaves only "
        f"{window - SNAPSHOT_MAX_AGE_DAYS} of the view's {window} days"
    )
