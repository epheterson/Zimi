"""Tests for the global HTTP download-speed throttle.

The token bucket (_DownloadThrottle) is shared across every download thread so
N concurrent pulls sum to the cap, not N × the cap. The pacing math is pure
(clock injectable) so it can be verified without real sleeps.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402
import zimi.p2p as p2p  # noqa: E402


@pytest.fixture(autouse=True)
def _hermetic_throttle_state():
    """Snapshot and restore every piece of module-global state these tests
    touch, so nothing leaks in or out regardless of suite order:
      - library._rate_cache (the ~2s rate lookup cache)
      - library._download_throttle (the shared token-bucket singleton)
      - p2p._prefs_path (set by the mirrors-bt-down test)
    A dirty _rate_cache or a mid-flight bucket is exactly what produces the
    "expected 0.0, got 1.0" pacing failures under interleaved runs.
    """
    saved_cache = dict(library._rate_cache)
    saved_prefs = p2p._prefs_path
    library._rate_cache["ts"] = 0.0
    library._rate_cache["bps"] = 0
    library._download_throttle.reset()
    yield
    library._rate_cache.clear()
    library._rate_cache.update(saved_cache)
    library._download_throttle.reset()
    p2p._prefs_path = saved_prefs


class _FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


# ────────────────────────────────────────────────────────────────────────────
# Throttle math
# ────────────────────────────────────────────────────────────────────────────


def test_zero_rate_never_throttles():
    th = library._DownloadThrottle()
    assert th.consume(1_000_000, 0) == 0.0
    assert th.consume(1_000_000, -5) == 0.0


def test_first_chunk_within_budget_no_sleep():
    clk = _FakeClock()
    th = library._DownloadThrottle(clock=clk)
    # 100 KB/s = 102400 B/s. A 64 KB chunk fits in the first second's burst.
    assert th.consume(65536, 102400) == 0.0


def test_overspend_returns_proportional_sleep():
    clk = _FakeClock()
    th = library._DownloadThrottle(clock=clk)
    rate = 100_000  # bytes/sec
    # Burst allowance caps at one second (100k). First consume drains it to 0.
    assert th.consume(100_000, rate) == 0.0
    # Next consume with no elapsed time goes 50k into deficit -> 0.5s sleep.
    assert th.consume(50_000, rate) == pytest.approx(0.5, abs=1e-6)


def test_elapsed_time_refills_bucket():
    clk = _FakeClock()
    th = library._DownloadThrottle(clock=clk)
    rate = 100_000
    th.consume(100_000, rate)  # drain burst to 0
    clk.advance(0.5)  # refills 50k
    # 50k available now -> a 50k chunk is free.
    assert th.consume(50_000, rate) == pytest.approx(0.0, abs=1e-9)


def test_burst_allowance_capped_at_one_second():
    clk = _FakeClock()
    th = library._DownloadThrottle(clock=clk)
    rate = 100_000
    th.consume(1, rate)  # seed _last
    clk.advance(1000)  # huge idle — must NOT bank 1000s of credit
    # Only one second's worth (100k) is available; a 200k read pays for 100k.
    assert th.consume(200_000, rate) == pytest.approx(1.0, abs=1e-6)


def test_aggregate_rate_across_two_streams():
    """Two 'threads' sharing one bucket are paced to the aggregate rate."""
    clk = _FakeClock()
    th = library._DownloadThrottle(clock=clk)
    rate = 100_000
    th.consume(100_000, rate)  # stream A drains the burst
    # Stream B, same instant, gets no free credit -> must wait.
    assert th.consume(100_000, rate) == pytest.approx(1.0, abs=1e-6)


def test_reset_clears_state():
    clk = _FakeClock()
    th = library._DownloadThrottle(clock=clk)
    th.consume(100_000, 100_000)
    th.reset()
    # Fresh bucket: a within-budget read is free again.
    assert th.consume(100_000, 100_000) == 0.0


# ────────────────────────────────────────────────────────────────────────────
# Rate lookup + caching + global-cap wiring
# ────────────────────────────────────────────────────────────────────────────


def test_download_rate_bps_reads_global_cap(monkeypatch):
    library._rate_cache["ts"] = 0.0  # force refresh
    monkeypatch.setattr(p2p, "get_download_limit_kb", lambda: 256)
    assert library._download_rate_bps() == 256 * 1024


def test_download_rate_bps_zero_is_unlimited(monkeypatch):
    library._rate_cache["ts"] = 0.0
    monkeypatch.setattr(p2p, "get_download_limit_kb", lambda: 0)
    assert library._download_rate_bps() == 0


def test_download_limit_mirrors_bt_down(monkeypatch, tmp_path):
    """The global download cap and the BT down limit are one number."""
    prefs = tmp_path / "prefs.json"
    p2p.set_prefs_path(str(prefs))
    monkeypatch.delenv("ZIMI_BT_DOWN_KB", raising=False)
    assert p2p.set_pref("bt_down_kb", 512)
    assert p2p.get_download_limit_kb() == 512
    assert p2p.get_bt_down_limit_kb() == 512
