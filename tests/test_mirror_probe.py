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
    manage_post,
    wait_for,
)

SLOW = 0.05  # seconds between 16 KiB writes: a piece takes ~0.2 s


@pytest.fixture(autouse=True)
def _probe_every_file(monkeypatch):
    """The fake ZIMs are tiny; probe them as if they were large."""
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 0)


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
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", len(mirrors.body) + 1)
    _finish(_start(mirrors))
    assert _probes(mirrors) == []


def test_a_large_file_started_without_a_size_is_probed_by_its_meta4_size(
    download_mirrors,
):
    # The catalog's Download button and every update send no size; the
    # .meta4 says how big the file is.
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id, err = lib._start_download(mirrors.meta4_url)
    assert err is None, err
    _finish(dl_id)
    assert all(_PROBE in m.requests for m in mirrors.mirrors)


def test_a_file_of_unknown_size_is_not_probed(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    mirrors.set_meta4(with_size=False)
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
    us.chunk_delay = 10 * SLOW  # ranked last, far behind: no jitter swaps it
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
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", len(mirrors.body))
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


def test_cancelling_during_the_probe_ends_it_at_once(download_mirrors, monkeypatch):
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 30.0)
    mirrors = download_mirrors(countries=("us", "nl"))
    for m in mirrors.mirrors:
        m.chunk_delay = 5.0  # the probe would run the full cap
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["probing"], timeout=5)
    cancelled_at = time.monotonic()
    lib._cancel_download(dl_id)
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=10), "never ended"
    assert time.monotonic() - cancelled_at < 2, "the probe ran on after Cancel"
    assert download_status(dl_id)["error"] == "Cancelled"


def test_on_a_link_too_slow_to_finish_any_probe_the_fastest_still_wins(
    download_mirrors, monkeypatch
):
    # Seven mirrors × 4 MiB in 10 s needs about 23 Mbps; on a slower link
    # every probe is still receiving at the cap. Its rate so far ranks it.
    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 1.0)
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    us, nl, fr = mirrors.mirrors
    # A chunk now and one every delay: by the 1 s cap fr has sent 3 of the
    # probe's 4 chunks, nl 2 and us 1, and none has finished.
    us.chunk_delay, nl.chunk_delay, fr.chunk_delay = 2.0, 0.55, 0.35
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["probing"], timeout=5)
    assert wait_for(lambda: not download_status(dl_id)["probing"], timeout=5)
    for m in mirrors.mirrors:
        m.chunk_delay = 0  # the probe is over; let the download run
    row = _finish(dl_id)
    assert [r["host"] for r in row["mirrors"]] == [fr.host, nl.host, us.host]


def test_a_probe_that_breaks_never_fails_the_download_or_loses_its_bytes(
    download_mirrors, monkeypatch
):
    import zimi.server as srv

    def broken(*a, **k):
        raise StopIteration  # the shape the wait-loop race once raised

    monkeypatch.setattr(mirrorrank, "rank", broken)
    mirrors = download_mirrors(countries=("us", "nl"))
    partial = os.path.join(srv.ZIM_DIR, mirrors.filename + ".tmp")
    with open(partial, "wb") as f:
        f.write(mirrors.body[: 2 * PIECE])  # a download resuming after a restart
    _finish(_start(mirrors))
    with open(os.path.join(srv.ZIM_DIR, mirrors.filename), "rb") as f:
        assert f.read() == mirrors.body
    us = mirrors.mirrors[0]
    assert f"bytes={2 * PIECE}-" in us.requests, "the partial was not resumed"


def test_a_meta4_without_pieces_is_probed_with_the_default_probe_size(
    download_mirrors, monkeypatch
):
    monkeypatch.setattr(mirrorrank, "DEFAULT_PROBE_BYTES", 32 * 1024)
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    mirrors.set_meta4(with_pieces=False)
    slow_us, slow_nl, fast_fr = mirrors.mirrors
    slow_us.chunk_delay = slow_nl.chunk_delay = SLOW
    row = _finish(_start(mirrors))
    assert all("bytes=0-32767" in m.requests for m in mirrors.mirrors)
    assert _active_host(row) == [fast_fr.host]


def test_pausing_during_the_probe_ends_it_and_resume_probes_again(
    download_mirrors, monkeypatch
):
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 30.0)
    mirrors = download_mirrors(countries=("us", "nl"))
    us, nl = mirrors.mirrors
    for m in mirrors.mirrors:
        m.chunk_delay = 5.0
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["probing"], timeout=5)
    paused_at = time.monotonic()
    assert manage_post("/manage/pause", id=dl_id)["status"] == "paused"
    assert wait_for(lambda: not download_status(dl_id)["probing"], timeout=10)
    assert time.monotonic() - paused_at < 3, "the probe ran on after Pause"
    # Paused, nothing is fetched: neither the download nor another probe.
    asked = [len(m.requests) for m in mirrors.mirrors]
    time.sleep(1.5)
    assert [len(m.requests) for m in mirrors.mirrors] == asked, "fetched while paused"
    # The cut-short probe told nothing; Resume measures again, and nl is
    # now the fast one.
    us.chunk_delay, nl.chunk_delay = SLOW, 0
    assert manage_post("/manage/resume", id=dl_id)["status"] == "resumed"
    row = _finish(dl_id)
    assert [m.requests.count(_PROBE) for m in mirrors.mirrors] == [2, 2]
    assert _active_host(row) == [nl.host]


def test_a_probe_already_stopped_sends_nothing(download_mirrors):
    import time

    mirrors = download_mirrors(countries=("us", "nl"))
    urls = [m.url for m in mirrors.mirrors]
    got = mirrorrank.rank(urls, PIECE, bytes_left=10**12, stop=lambda: True)
    assert got == urls
    time.sleep(1.0)  # time for any request already on its way to land
    assert [m.requests for m in mirrors.mirrors] == [[], []]


def test_a_download_with_one_download_mirror_is_not_probed(download_mirrors):
    mirrors = download_mirrors(countries=("us",))
    _finish(_start(mirrors))
    assert _probes(mirrors) == []


@pytest.mark.parametrize("hang_up", [True, "reset"])
def test_a_mirror_that_dropped_a_paused_download_carries_on_after_resume(
    download_mirrors, monkeypatch, hang_up
):
    import time

    import zimi.server as srv

    # A paused download leaves its connection idle; a mirror may drop it.
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    mirrors = download_mirrors(countries=("us", "nl"))
    us, nl = mirrors.mirrors
    us.chunk_delay = 0.3
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["downloaded_bytes"] > 0, timeout=10)
    manage_post("/manage/pause", id=dl_id)
    time.sleep(0.5)  # the read in flight lands; the download sits paused
    us.hang_up = hang_up
    time.sleep(0.5)  # the mirror notices at its next write, and hangs up
    us.hang_up = False
    us.chunk_delay = 0
    manage_post("/manage/resume", id=dl_id)
    row = _finish(dl_id)
    assert nl.requests == [], "the paused download left a mirror that was fine"
    assert len(us.requests) == 2 and us.requests[1].startswith("bytes="), us.requests
    assert _active_host(row) == [us.host]
    with open(os.path.join(srv.ZIM_DIR, mirrors.filename), "rb") as f:
        assert f.read() == mirrors.body


def test_a_failed_mirror_is_tried_again_after_the_rest(download_mirrors, monkeypatch):
    # "failed" = errored this download, still retried after the rest.
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    mirrors = download_mirrors(countries=("us", "nl"))
    for m in mirrors.mirrors:
        m.fail_first = 1  # a passing hiccup on each download mirror
    mirrors.origin.fail_status = 503  # and the direct URL is down
    row = _finish(_start(mirrors))
    us, nl = mirrors.mirrors
    assert len(us.requests) == 2, "us was not tried again after the rest"
    assert _active_host(row) == [us.host]


def test_a_download_without_a_meta4_is_not_tried_again(download_mirrors):
    # Peer pulls and direct URLs keep their behaviour: one try, then fail.
    mirrors = download_mirrors(countries=("us",))
    mirrors.origin.fail_status = 503
    dl_id, err = lib._start_download(mirrors.origin.url)
    assert err is None, err
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=30)
    assert len(mirrors.origin.requests) == 1
    assert "tries" not in download_status(dl_id)["error"]  # its error as before


def test_a_resumed_download_with_little_left_is_not_probed(download_mirrors, monkeypatch):
    import zimi.server as srv

    mirrors = download_mirrors(countries=("us", "nl"))
    have = len(mirrors.body) - 2 * PIECE  # all but two pieces already on disk
    with open(os.path.join(srv.ZIM_DIR, mirrors.filename + ".tmp"), "wb") as f:
        f.write(mirrors.body[:have])
    # The file is over the threshold; what is left of it is not.
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 3 * PIECE)
    _finish(_start(mirrors))
    assert _probes(mirrors) == []


def _ranked_after_probe(dl_id):
    assert wait_for(lambda: download_status(dl_id)["probing"], timeout=5)
    assert wait_for(lambda: not download_status(dl_id)["probing"], timeout=10)
    return [r["host"] for r in download_status(dl_id)["mirrors"]]


def test_a_mirror_gone_silent_is_ranked_by_what_it_sent(download_mirrors, monkeypatch):
    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 1.0)
    mirrors = download_mirrors(countries=("us", "nl"))
    us, nl = mirrors.mirrors
    us.stall_after = 16 * 1024  # both still connected at the cap, silent;
    nl.stall_after = 48 * 1024  # nl sent three times as much first
    ranked = _ranked_after_probe(_start(mirrors))
    for m in mirrors.mirrors:
        m.stall_after = None
    assert ranked == [nl.host, us.host]


def test_a_mirror_that_ended_its_reply_early_ranks_below_one_still_sending(
    download_mirrors, monkeypatch
):
    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 1.0)
    mirrors = download_mirrors(countries=("fr", "us"))
    cut_fr, us = mirrors.mirrors
    cut_fr.drop_after = 48 * 1024  # more bytes, but the reply ended short
    us.stall_after = 16 * 1024  # fewer bytes, still sending
    dl_id = _start(mirrors)
    _ranked_after_probe(dl_id)
    for m in mirrors.mirrors:
        m.stall_after = m.drop_after = None
    _finish(dl_id)
    assert [r for r in cut_fr.requests if r != _PROBE] == [], (
        "the download went first to the mirror whose reply ended early"
    )


def test_failed_mirrors_get_exactly_one_more_try(download_mirrors, monkeypatch):
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    mirrors = download_mirrors(countries=("us", "nl"))
    for m in [mirrors.origin, *mirrors.mirrors]:
        m.fail_status = 503  # down for good
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=30), "it kept trying"
    assert download_status(dl_id)["error"]
    assert [len(m.requests) for m in mirrors.mirrors] == [2, 2]
    assert len(mirrors.origin.requests) == 1
    # Every try counts: two mirrors twice each, and the direct URL once.
    assert "after 5 tries" in download_status(dl_id)["error"]


def test_the_retry_waits_a_moment_first(download_mirrors, monkeypatch):
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    monkeypatch.setattr(lib, "MIRROR_RETRY_WAIT_SECONDS", 1.5)
    mirrors = download_mirrors(countries=("us",))
    us = mirrors.mirrors[0]
    us.fail_first = 1  # a passing hiccup
    mirrors.origin.fail_status = 503
    started = time.monotonic()
    _finish(_start(mirrors))
    assert time.monotonic() - started >= 1.5, "tried again at once"
    assert len(us.requests) == 2


def test_cancelling_during_the_wait_before_the_retry_ends_it_at_once(
    download_mirrors, monkeypatch
):
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    monkeypatch.setattr(lib, "MIRROR_RETRY_WAIT_SECONDS", 30.0)
    mirrors = download_mirrors(countries=("us",))
    for m in [mirrors.origin, *mirrors.mirrors]:
        m.fail_status = 503
    dl_id = _start(mirrors)
    # The direct URL is tried last in the first pass; then the wait.
    assert wait_for(lambda: len(mirrors.origin.requests) == 1, timeout=10)
    time.sleep(0.3)
    cancelled_at = time.monotonic()
    manage_post("/manage/cancel", id=dl_id)
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=10)
    assert time.monotonic() - cancelled_at < 3, "the wait ran on after Cancel"
    assert len(mirrors.mirrors[0].requests) == 1


def _pause_mid_file(mirrors, dl_id, seconds, hang_up=False):
    """Pause once bytes are flowing, for `seconds`; the first mirror may hang up meanwhile."""
    import time

    us = mirrors.mirrors[0]
    assert wait_for(lambda: download_status(dl_id)["downloaded_bytes"] > 0, timeout=10)
    manage_post("/manage/pause", id=dl_id)
    time.sleep(0.5)
    us.hang_up = hang_up
    time.sleep(seconds)
    us.hang_up = False
    us.chunk_delay = 0
    manage_post("/manage/resume", id=dl_id)


def test_a_long_pause_on_a_connection_still_open_reads_on(download_mirrors, monkeypatch):
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    mirrors = download_mirrors(countries=("us", "nl"))
    us, nl = mirrors.mirrors
    us.chunk_delay = 0.3
    dl_id = _start(mirrors)
    _pause_mid_file(mirrors, dl_id, 6.0)
    row = _finish(dl_id)
    assert len(us.requests) == 1, "asked again though the connection was fine"
    assert nl.requests == [] and _active_host(row) == [us.host]


@pytest.mark.parametrize("hang_up", [True, "reset"])
def test_a_mirror_that_cannot_resume_is_not_asked_again_after_a_pause(
    download_mirrors, monkeypatch, hang_up
):
    # Asked for the rest, it would send the whole file and the partial
    # would be thrown away; the next mirror takes over from the partial.
    import zimi.server as srv

    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    mirrors = download_mirrors(countries=("us", "nl"))
    us, nl = mirrors.mirrors
    us.no_range = True
    us.chunk_delay = 0.3
    dl_id = _start(mirrors)
    _pause_mid_file(mirrors, dl_id, 6.0, hang_up=hang_up)
    _finish(dl_id)
    assert len(us.requests) == 1, us.requests
    assert nl.requests and nl.requests[0].startswith("bytes=") and nl.requests[0] != "bytes=0-"
    with open(os.path.join(srv.ZIM_DIR, mirrors.filename), "rb") as f:
        assert f.read() == mirrors.body


def test_a_probe_stopped_by_pause_stays_stopped_after_resume(download_mirrors, monkeypatch):
    import threading
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_CAP_SECONDS", 30.0)
    mirrors = download_mirrors(countries=("us", "nl"))
    for m in mirrors.mirrors:
        m.chunk_delay = 0.3  # each probe is still reading when Pause comes
    urls = [m.url for m in mirrors.mirrors]
    paused = {"on": False}
    asked = []  # each time a probe asks whether to stop

    def stop():
        asked.append(1)
        return paused["on"]

    t = threading.Thread(
        target=mirrorrank.rank, args=(urls, 4 * PIECE), kwargs={"bytes_left": 10**12, "stop": stop}
    )
    t.start()
    assert wait_for(lambda: all(m.requests for m in mirrors.mirrors), timeout=5)
    time.sleep(0.5)
    paused["on"] = True  # Pause: the run ends
    t.join(5)
    assert not t.is_alive()
    paused["on"] = False  # Resume: a new run would start; this one is over
    time.sleep(0.3)
    before = len(asked)
    time.sleep(1.5)
    assert len(asked) == before, "the stopped run's probes read on after Resume"


def test_pausing_during_the_wait_before_the_retry_holds_the_retry(
    download_mirrors, monkeypatch
):
    import time

    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    monkeypatch.setattr(lib, "MIRROR_RETRY_WAIT_SECONDS", 1.0)
    mirrors = download_mirrors(countries=("us",))
    us = mirrors.mirrors[0]
    us.fail_first = 1
    mirrors.origin.fail_status = 503
    dl_id = _start(mirrors)
    assert wait_for(lambda: len(mirrors.origin.requests) == 1, timeout=10)
    manage_post("/manage/pause", id=dl_id)
    time.sleep(2.5)  # past the wait
    assert len(us.requests) == 1, "tried again while paused"
    manage_post("/manage/resume", id=dl_id)
    _finish(dl_id)
    assert len(us.requests) == 2


def test_cancelling_while_the_last_try_fails_says_cancelled(download_mirrors, monkeypatch):
    monkeypatch.setattr(mirrorrank, "PROBE_MIN_BYTES_LEFT", 10**12)  # no probe
    monkeypatch.setattr(lib, "MIRROR_RETRY_WAIT_SECONDS", 0.0)
    mirrors = download_mirrors(countries=("us",))
    us = mirrors.mirrors[0]
    us.fail_status = 503
    us.fail_delay = 1.0  # each refusal takes a second to come
    mirrors.origin.fail_status = 503
    dl_id = _start(mirrors)
    assert wait_for(lambda: len(us.requests) == 2, timeout=10)  # the last try
    manage_post("/manage/cancel", id=dl_id)
    assert wait_for(lambda: download_status(dl_id)["done"], timeout=10)
    assert download_status(dl_id)["error"] == "Cancelled"
