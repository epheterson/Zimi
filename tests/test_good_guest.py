"""A cold start that is a good guest: background builders queue behind the disk and the memory of whoever is using the
machine, one at a time, wait for first use where they can, and a stop in the middle leaves nothing running."""

import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
from test_serve_smoke import REPO_ROOT, _wait_for_ready  # noqa: E402

from zimi import interlang, search, subproc  # noqa: E402


# ---- memory floor -----------------------------------------------------------------------------------------------

def test_wait_for_memory_gives_up_when_the_floor_is_never_met():
    t0 = time.monotonic()
    assert subproc.wait_for_memory(floor_mb=500, max_wait=0.3, probe=lambda: 100) is False
    assert time.monotonic() - t0 >= 0.3


def test_wait_for_memory_waits_until_memory_comes_back():
    readings = iter([100, 100, 900])
    assert subproc.wait_for_memory(floor_mb=500, max_wait=30, probe=lambda: next(readings)) is True


def test_wait_for_memory_does_not_wait_when_unknown_or_switched_off(monkeypatch):
    assert subproc.wait_for_memory(floor_mb=500, max_wait=0.1, probe=lambda: None) is True
    monkeypatch.setenv("ZIMI_BUILD_MIN_FREE_MB", "0")
    assert subproc.wait_for_memory(max_wait=0.1, probe=lambda: 1) is True


def test_wait_for_memory_stops_waiting_when_the_server_stops():
    subproc.stopping.set()
    try:
        t0 = time.monotonic()
        assert subproc.wait_for_memory(floor_mb=500, max_wait=60, probe=lambda: 1) is False
        assert time.monotonic() - t0 < 5
    finally:
        subproc.stopping.clear()


def test_the_throttle_between_builds_waits_for_memory(monkeypatch):
    asked = []
    monkeypatch.setattr(subproc, "wait_for_memory", lambda *a, **k: asked.append(1) or True)
    search._loadavg_throttle()
    assert asked


# ---- idle disk priority -----------------------------------------------------------------------------------------

@pytest.mark.skipif(not (sys.platform.startswith("linux") or sys.platform == "darwin"), reason="no I/O classes here")
def test_idle_io_is_accepted_by_the_system():
    result = []
    t = threading.Thread(target=lambda: result.append(subproc.idle_io()))   # a thread: the test runner keeps its priority
    t.start()
    t.join()
    assert result == [True]


def test_a_builder_child_takes_idle_io_as_well_as_nice(monkeypatch):
    called = []
    monkeypatch.setattr(subproc, "idle_io", lambda: called.append("io"))
    monkeypatch.setattr(os, "nice", lambda n: called.append("nice"))
    search._yield_to_the_server()
    assert called == ["nice", "io"]


# ---- one builder at a time --------------------------------------------------------------------------------------

def test_builders_of_different_kinds_never_overlap(monkeypatch):
    monkeypatch.setattr(subproc, "wait_for_memory", lambda *a, **k: True)
    monkeypatch.setattr(search, "zim_entry_count", lambda name, path=None: 0)   # small: built in this process
    running, peak, lock = [0], [0], threading.Lock()

    def build(name, path):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        time.sleep(0.05)
        with lock:
            running[0] -= 1

    threads = [
        threading.Thread(target=search._build_index_isolated, args=(kind, "z", "/z", build, lambda n: None))
        for kind in ("titles", "qids", "tube", "books", "mapplaces", "docs")
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak[0] == 1


# ---- Q-ID indexes wait for first use ----------------------------------------------------------------------------

def test_first_use_asks_for_the_index_once(monkeypatch):
    built = []
    monkeypatch.setattr(interlang, "_qid_has_index", lambda name: False)
    monkeypatch.setattr(interlang, "_qid_index_is_current", lambda name, path: False)
    monkeypatch.setattr(interlang, "_zim_project_name", lambda name: "wikipedia")
    monkeypatch.setattr(interlang._srv, "get_zim_files", lambda: {"wp_x": "/wp_x.zim"})
    monkeypatch.setattr(interlang._srv, "_zim_list_cache", [{"name": "wp_x", "entries": 10}])
    monkeypatch.setattr(interlang, "_apply_qid_flags", lambda flags: None)
    monkeypatch.setattr(
        interlang, "_build_index_isolated", lambda kind, name, path, fn, close: built.append((kind, name))
    )
    monkeypatch.setattr(interlang, "_qid_requested", set())
    interlang.request_qid_index("wp_x")
    interlang.request_qid_index("wp_x")
    deadline = time.time() + 5
    while not built and time.time() < deadline:
        time.sleep(0.02)
    time.sleep(0.1)
    assert built == [("qids", "wp_x")]


def test_the_boot_pass_leaves_a_never_built_index_for_first_use(monkeypatch, tmp_path):
    built = []
    monkeypatch.setattr(interlang._srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(interlang._srv, "get_zim_files", lambda: {"wp_a": "/a.zim", "wp_b": "/b.zim"})
    monkeypatch.setattr(interlang._srv, "_zim_list_cache", [{"name": "wp_a", "entries": 5}, {"name": "wp_b", "entries": 5}])
    monkeypatch.setattr(interlang, "_detect_qid_flags", lambda zims: {})
    monkeypatch.setattr(interlang, "_apply_qid_flags", lambda flags: None)
    monkeypatch.setattr(interlang, "_zim_project_name", lambda name: "wikipedia")
    monkeypatch.setattr(interlang, "_qid_index_is_current", lambda name, path: False)
    monkeypatch.setattr(interlang, "_background_start", lambda *a: None)
    monkeypatch.setattr(interlang, "_background_step", lambda *a: None)
    monkeypatch.setattr(interlang, "_background_ok", lambda *a: None)
    monkeypatch.setattr(interlang, "_background_end", lambda *a: None)
    monkeypatch.setattr(interlang, "_loadavg_throttle", lambda: None)
    monkeypatch.setattr(
        interlang, "_build_index_isolated", lambda kind, name, path, fn, close: built.append(name)
    )
    os.makedirs(interlang._qid_index_dir(), exist_ok=True)
    open(interlang._qid_index_path("wp_b"), "w").close()   # wp_b had an index once, now stale: kept up to date
    interlang._build_all_qid_indexes_inner(first_use=True)
    assert built == ["wp_b"]
    built.clear()
    interlang._build_all_qid_indexes_inner(first_use=False)   # a download or a manual rebuild still builds everything
    assert sorted(built) == ["wp_a", "wp_b"]


# ---- a stop in the middle of a cold start -----------------------------------------------------------------------

_SERVER = textwrap.dedent(
    """
    import runpy, sys
    from zimi import search
    marker = sys.argv.pop(1)
    # every build runs in a child, and the child is a long sleep standing in for a big scan
    search._ISOLATE_BUILD_MIN_ENTRIES = 0
    search._CHILD_PYTHON = (sys.executable, "-c", "import time; time.sleep(120)  # builder-of-" + marker)
    sys.argv = ["zimi", "serve", "--port", "0"]
    runpy.run_module("zimi", run_name="__main__")
    """
)


def _pids_matching(marker):
    out = subprocess.run(["pgrep", "-f", marker], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if int(p) != os.getpid()]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_sigterm_during_a_cold_start_leaves_no_builder_behind():
    marker = "zimi-good-guest-%d" % os.getpid()
    zim_dir = tempfile.mkdtemp(prefix="zimi-gg-zims-")
    data_dir = tempfile.mkdtemp(prefix="zimi-gg-data-")
    log_fd, log_path = tempfile.mkstemp(prefix="zimi-gg-log-")
    os.close(log_fd)
    build_fixture_zim(os.path.join(zim_dir, "fixture.zim"))
    env = dict(
        os.environ, ZIM_DIR=zim_dir, ZIMI_DATA_DIR=data_dir, ZIMI_AUTO_UPDATE="0", ZIMI_TORRENT="0",
        ZIMI_OFFLINE="1", ZIMI_PEER_DISCOVERY="0", PYTHONUNBUFFERED="1",
    )
    for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_LAN_ADMIN", "ZIMI_MANAGE_OPEN", "ZIMI_HOST"):
        env.pop(var, None)
    with open(log_path, "w", encoding="utf-8") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-c", _SERVER, marker], cwd=REPO_ROOT, env=env, stdout=log_f, stderr=subprocess.STDOUT
        )
    try:
        _wait_for_ready(proc, log_path)
        deadline = time.time() + 60
        while time.time() < deadline and not _pids_matching("builder-of-" + marker):
            time.sleep(0.2)
        assert _pids_matching("builder-of-" + marker), "no builder child started: " + open(log_path).read()[-2000:]
        t0 = time.time()
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=15)
        assert time.time() - t0 < 10
        time.sleep(0.5)
        assert _pids_matching("builder-of-" + marker) == []
        # no index left half-written under its real name
        import sqlite3

        for root, _dirs, files in os.walk(data_dir):
            for f in files:
                if f.endswith(".db"):
                    con = sqlite3.connect(os.path.join(root, f))
                    try:
                        assert con.execute("PRAGMA quick_check").fetchone()[0] == "ok", f
                    finally:
                        con.close()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        for pid in _pids_matching(marker):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        import shutil

        for p in (zim_dir, data_dir):
            shutil.rmtree(p, ignore_errors=True)
        os.remove(log_path)


@pytest.mark.parametrize("path", ["docker-compose.yml", "packaging/deploy/docker-compose.yml"])
def test_example_compose_files_carry_a_memory_ceiling_and_a_stop_grace(path):
    text = open(os.path.join(REPO_ROOT, path), encoding="utf-8").read()
    assert "\n    mem_limit:" in text
    assert "\n    stop_grace_period:" in text


def test_an_unmeasured_zim_is_counted_from_its_header(monkeypatch, tmp_path):
    """A cold start lists every ZIM entries as "?" until the background measure has run; the builders must not read that
    as zero (the biggest ZIM built on a server thread) nor compare it with a number (the Q-ID pass crashed)."""
    zim = str(tmp_path / "fixture.zim")
    build_fixture_zim(zim)
    monkeypatch.setattr(search._srv, "_zim_list_cache", [{"name": "fixture", "entries": "?"}])
    monkeypatch.setattr(search, "_header_counts", {})
    assert search.zim_entry_count("fixture", zim) > 0
    assert search.zim_entry_count("nope", None) == 0
