"""The mirror probe: before an HTTP download starts, Zimi times a short fetch
from every download mirror and starts on the fastest.

Driven end to end against fake download mirrors
(tests/download_mirrors_fixture.py): a download is started the way the catalog
starts one, and the tests read the downloads status and what each mirror was
asked for. A probe is one piece-sized Range request from byte 0.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.library as lib  # noqa: E402
import zimi.mirrorrank as mirrorrank  # noqa: E402
from download_mirrors_fixture import (  # noqa: E402,F401
    PIECE,
    download_mirrors,
    download_status,
    wait_for,
)

SLOW = 0.05  # seconds between 16 KiB writes: a piece takes ~0.2 s


@pytest.fixture(autouse=True)
def _probe_every_file(monkeypatch):
    """The fake ZIMs are tiny; probe them as if they were large."""
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_FILE_BYTES", 0)


def _start(mirrors):
    dl_id, err = lib._start_download(mirrors.meta4_url, size_bytes=len(mirrors.body))
    assert err is None, err
    return dl_id


def _finish(dl_id):
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=30), "never finished"
    row = download_status(dl_id)
    assert row["error"] is None, row["error"]
    return row


def _active_host(row):
    return [r["host"] for r in row["mirrors"] if r["state"] == "active"]


def test_the_download_starts_on_the_fastest_download_mirror(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    slow_us, slow_nl, fast_fr = mirrors.mirrors
    slow_us.chunk_delay = slow_nl.chunk_delay = SLOW
    row = _finish(_start(mirrors))
    assert _active_host(row) == [fast_fr.host]


def test_a_mirror_that_hangs_does_not_hold_the_start_and_is_ranked_last(
    download_mirrors, monkeypatch
):
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 1.0)
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    hung_us, nl, fr = mirrors.mirrors
    hung_us.chunk_delay = 60  # sends 16 KiB, then nothing for a minute
    started = time.monotonic()
    row = _finish(_start(mirrors))
    assert time.monotonic() - started < 6, "the hung mirror held the start"
    assert row["mirrors"][-1]["host"] == hung_us.host


def test_when_every_probe_fails_the_download_goes_in_kiwix_order(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    us, nl, fr = mirrors.mirrors
    for m in mirrors.mirrors:
        m.fail_first = 1  # the probe is refused; the download is served
    nl.chunk_delay = fr.chunk_delay = SLOW
    row = _finish(_start(mirrors))
    assert _active_host(row) == [us.host]
    assert [r["host"] for r in row["mirrors"]] == [us.host, nl.host, fr.host]


_PROBE = f"bytes=0-{PIECE - 1}"


def _probes(mirrors):
    return [r for m in mirrors.mirrors for r in m.requests if r == _PROBE]


def test_a_file_under_the_size_threshold_is_not_probed(download_mirrors, monkeypatch):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_FILE_BYTES", len(mirrors.body) + 1)
    _finish(_start(mirrors))
    assert _probes(mirrors) == []


def test_a_file_of_unknown_size_is_not_probed(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id, err = lib._start_download(mirrors.meta4_url)
    assert err is None, err
    _finish(dl_id)
    assert _probes(mirrors) == []


def test_a_large_file_is_probed_on_every_download_mirror(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    _finish(_start(mirrors))
    assert all(_PROBE in m.requests for m in mirrors.mirrors)


def test_a_mirror_that_errors_hands_over_to_the_next_ranked_one_mid_file(
    download_mirrors,
):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    us, nl, fr = mirrors.mirrors
    us.chunk_delay = 2 * SLOW  # ranked last
    nl.chunk_delay = SLOW  # ranked second
    fr.drop_after = 3 * PIECE  # ranked first, then cuts off part-way
    row = _finish(_start(mirrors))
    resumed = [r for r in nl.requests if r and r != _PROBE]
    assert resumed and resumed[0].startswith("bytes=") and resumed[0] != "bytes=0-"
    states = {r["host"]: r["state"] for r in row["mirrors"]}
    assert states[fr.host] == "failed"
    assert row["mirrors"][-1]["host"] == fr.host
    import zimi.server as srv

    with open(os.path.join(srv.ZIM_DIR, mirrors.filename), "rb") as f:
        assert f.read() == mirrors.body


def test_nothing_is_probed_once_zimi_is_offline(download_mirrors, monkeypatch):
    # A refused start probes nothing anyway; the case that matters is going
    # offline after the download has begun and before its probe.
    real_fetch = lib._fetch_mirrors

    def fetch_then_go_offline(url):
        read = real_fetch(url)
        monkeypatch.setenv("ZIMI_OFFLINE", "1")
        return read

    monkeypatch.setattr(lib, "_fetch_mirrors", fetch_then_go_offline)
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=30)
    assert _probes(mirrors) == []


def test_a_bittorrent_attempt_that_falls_back_to_http_is_ranked_too(
    download_mirrors, monkeypatch
):
    from zimi import p2p

    attempts = []

    def bt_falls_back(*a, **k):
        attempts.append(1)
        return "fallback"

    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    # After the fixture, which turns BitTorrent off: an engine exists, finds
    # a torrent, and gives up on it.
    monkeypatch.setattr(p2p, "get_backend", lambda *a, **k: object())
    monkeypatch.setattr(lib, "_resolve_torrent_url", lambda url: "https://t/x.torrent")
    monkeypatch.setattr(lib, "_try_bt_download", bt_falls_back)
    slow_us, slow_nl, fast_fr = mirrors.mirrors
    slow_us.chunk_delay = slow_nl.chunk_delay = SLOW
    row = _finish(_start(mirrors))
    assert attempts, "the BitTorrent attempt never ran"
    assert _active_host(row) == [fast_fr.host]


def test_the_status_says_probing_while_the_probe_runs(download_mirrors, monkeypatch):
    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 2.0)
    mirrors = download_mirrors(countries=("us", "nl"))
    for m in mirrors.mirrors:
        m.chunk_delay = 1.0  # each probe outlasts the cap
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["probing"], timeout=5), (
        "the status never said it was probing"
    )
    for m in mirrors.mirrors:
        m.chunk_delay = 0
    row = _finish(dl_id)
    assert row["probing"] is False
    assert download_status(dl_id)["probing"] is False


def test_a_file_exactly_at_the_size_threshold_is_probed(download_mirrors, monkeypatch):
    mirrors = download_mirrors(countries=("us", "nl"))
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_FILE_BYTES", len(mirrors.body))
    _finish(_start(mirrors))
    assert all(_PROBE in m.requests for m in mirrors.mirrors)


def test_a_mirror_that_cuts_its_probe_short_is_not_ranked_on_it(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    us, nl, cut_fr = mirrors.mirrors
    us.chunk_delay = nl.chunk_delay = SLOW
    cut_fr.drop_after = PIECE // 2  # the fastest answer, but only half a probe
    _finish(_start(mirrors))
    assert [r for r in cut_fr.requests if r != _PROBE] == [], (
        "the download was sent to a mirror whose probe never finished"
    )
