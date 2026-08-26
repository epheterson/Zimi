"""The variant sweep's bounds, and whether it says where it is inside them.

The sweep fetches the image sizes a `srcset` offers and this viewport did not
pick, so the archive can answer a phone as well as the screen that recorded it.
It had two limits — 240 attempts, 20 seconds each — and neither of them is
wrong. Multiplied they are eighty minutes, which nobody chose and nothing said
out loud, and that is what a real capture of apple.com did: the CDN throttled a
headless client, every fetch rode its timeout out, and the sweep sat mute long
enough that the stall watchdog concluded the job was dead. It was not dead. It
was inside a bound that had never been added up.

Two things are pinned here, and they are the same thing twice:

  * the sweep ends on a clock, so no combination of the other limits can
    multiply into a duration nobody set;
  * the sweep speaks while it works, so "still going" and "wedged" stop looking
    identical — to the operator watching, and to the watchdog, which decides a
    job is dead purely from the absence of progress lines.

No browser is launched. The sweep's contract is with the candidate list and
with `_fetch_into_archive`, both of which stub cleanly, and a bound worth
testing should not need a Chromium to demonstrate.
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.renderer as renderer  # noqa: E402


class _Page:
    """Just enough page: the candidate list and a URL for the log line."""

    def __init__(self, candidates):
        self._candidates = candidates
        self.url = "https://example.test/"

    def evaluate(self, _js, *_args):
        return list(self._candidates)


def _sweeper(tmp_path, candidates, fetch):
    """A session wired for the sweep and nothing else.

    ``_recorder``/``_context`` only have to be non-None — the sweep checks that
    it is recording and then talks exclusively to ``_fetch_into_archive``, which
    the caller supplies."""
    session = renderer.RenderedSession(work_dir=str(tmp_path), capture_variants=True)
    session._recorder = object()
    session._context = object()
    session._fetch_into_archive = fetch
    notes = []
    session._note = notes.append
    return session, _Page(candidates), notes


def _urls(n, prefix="https://cdn.test/img"):
    return [f"{prefix}/{i}.jpg" for i in range(n)]


# ── the clock ───────────────────────────────────────────────────────────────


def test_a_host_that_hangs_ends_the_sweep_on_the_clock(tmp_path, monkeypatch):
    """The apple.com shape: every candidate rides its timeout out.

    Before the budget this ran ALIVE_MAX_VARIANTS times regardless — 240 hangs,
    one after another, for as long as that took."""
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_BUDGET", 0.30)
    monkeypatch.setattr(renderer, "ALIVE_SWEEP_HEARTBEAT", 999.0)  # clock only
    tried = []

    def hangs(url, _timeout):
        tried.append(url)
        time.sleep(0.05)  # a fetch that will not answer, in miniature
        return 0

    session, page, notes = _sweeper(tmp_path, _urls(240), hangs)
    began = time.monotonic()
    session._record_variants(page)
    spent = time.monotonic() - began

    # It stopped on time, not on the count: nowhere near 240 attempts.
    assert 0 < len(tried) < 240, len(tried)
    assert spent < 2.0, f"the sweep ran {spent:.1f}s against a 0.3s budget"
    assert any("time limit" in n for n in notes), notes
    assert any("not in this archive" in n for n in notes), notes


def test_a_host_that_answers_is_not_cut_short_by_the_clock(tmp_path, monkeypatch):
    """The budget must not become a quality knob for hosts that behave. CNN's
    front page offers close to four hundred candidates and answers all of them
    inside a few seconds; a budget that clipped that would trade a real bug for
    a quieter one."""
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_BUDGET", 5.0)
    session, page, notes = _sweeper(tmp_path, _urls(60), lambda _u, _t: 1024)
    session._record_variants(page)

    assert not any("limit" in n for n in notes), notes
    assert notes[-1] == "archived 60 image variants"


def test_the_count_cap_still_ends_a_sweep_the_clock_would_allow(tmp_path, monkeypatch):
    """Instant answers plus a generous clock is exactly when the count cap is
    the only thing standing between a gallery page and a thousand requests."""
    monkeypatch.setattr(renderer, "ALIVE_MAX_VARIANTS", 12)
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_BUDGET", 30.0)
    calls = []
    session, page, notes = _sweeper(
        tmp_path, _urls(400), lambda u, _t: calls.append(u) or 8
    )
    session._record_variants(page)

    assert len(calls) == 12
    assert any("images limit" in n for n in notes), notes


def test_the_byte_cap_still_ends_a_sweep_the_clock_would_allow(tmp_path, monkeypatch):
    """And the one that stops a page whose candidates are all enormous."""
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_MAX_BYTES", 4096)
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_BUDGET", 30.0)
    session, page, notes = _sweeper(tmp_path, _urls(50), lambda _u, _t: 1024)
    session._record_variants(page)

    assert any("bytes limit" in n for n in notes), notes


def test_each_limit_names_itself(tmp_path, monkeypatch):
    """Three ways to stop and three different sentences. An operator who reads
    "stopped at its time limit" knows the host was slow; one who reads "images"
    knows the page was big. One shared message would hide the difference that
    matters."""
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_BUDGET", 0.2)
    session, page, notes = _sweeper(
        tmp_path, _urls(90), lambda _u, _t: time.sleep(0.03) or 0
    )
    session._record_variants(page)
    stops = [n for n in notes if "stopped sweeping" in n]
    assert len(stops) == 1 and "time limit" in stops[0], notes


# ── saying where it is ──────────────────────────────────────────────────────


def test_a_long_sweep_reports_while_it_runs(tmp_path, monkeypatch):
    """The silence is the bug, not the duration.

    A sweep may legitimately take minutes. What it may not do is take minutes
    without a word, because the stall watchdog reads exactly one signal — the
    time since the last progress line — and cannot tell patient work from a
    dead thread. Every heartbeat here is also a `job.progressed` update at the
    other end of that callback."""
    monkeypatch.setattr(renderer, "ALIVE_SWEEP_HEARTBEAT", 0.05)
    monkeypatch.setattr(renderer, "ALIVE_VARIANT_BUDGET", 30.0)
    session, page, notes = _sweeper(
        tmp_path, _urls(20), lambda _u, _t: time.sleep(0.02) or 512
    )
    session._record_variants(page)

    beats = [n for n in notes if n.startswith("fetching extra image sizes")]
    assert len(beats) >= 3, notes
    assert "of 20 checked" in beats[0], beats[0]


def test_a_quick_sweep_stays_quiet(tmp_path, monkeypatch):
    """The heartbeat is on a clock and not on a counter, so a page whose
    variants answer instantly costs one closing line rather than 240 — the log
    is read by a person."""
    monkeypatch.setattr(renderer, "ALIVE_SWEEP_HEARTBEAT", 30.0)
    session, page, notes = _sweeper(tmp_path, _urls(200), lambda _u, _t: 64)
    session._record_variants(page)

    assert notes == ["archived 200 image variants"], notes


def test_a_cancel_during_a_sweep_now_has_something_to_land_on(tmp_path, monkeypatch):
    """The sink raises on a pending cancel, which is how cancellation reaches
    an engine at all — at a progress line. A step that emitted none was a step
    Cancel could not interrupt for its whole run; the heartbeat gives the sweep
    the checkpoints it never had."""
    monkeypatch.setattr(renderer, "ALIVE_SWEEP_HEARTBEAT", 0.05)

    class _Cancelled(Exception):
        pass

    def cancelling_sink(_message):
        raise _Cancelled()

    session, page, _notes = _sweeper(
        tmp_path, _urls(50), lambda _u, _t: time.sleep(0.02) or 32
    )
    session._note = cancelling_sink
    with pytest.raises(_Cancelled):
        session._record_variants(page)


# ── the shape of the bug itself ─────────────────────────────────────────────


def test_the_shipped_bounds_cannot_multiply_into_an_unbounded_wait(tmp_path):
    """The regression test for the arithmetic.

    240 attempts × 20s = 80 minutes was not a limit anybody set; it was two
    limits nobody multiplied. Whatever the count and per-item timeout become,
    the sweep's worst case is the budget plus the one fetch that was already in
    flight when it expired."""
    worst = renderer.ALIVE_VARIANT_BUDGET + renderer.ALIVE_VARIANT_TIMEOUT
    assert worst < 300, (
        f"a single page's variant sweep can take {worst:.0f}s. The stall "
        f"watchdog gives up at {300}s of silence and a capture is many pages."
    )
    # And the naive product is still enormous, which is the point: the budget
    # is what stands between the two, not a smaller count.
    assert renderer.ALIVE_MAX_VARIANTS * renderer.ALIVE_VARIANT_TIMEOUT > worst
