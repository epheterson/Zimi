"""Filesystem hygiene and browser teardown for the creation flows.

Every creation flow spools beside its output — crawl spools
(``.zimi-crawl-*``), renderer subresource spools (``.zimi-render-*``), alive
recordings (``.zimi-alive-*.warc.gz``) — and every one of those must be gone
on success, failure AND cancel. A leak here is invisible until a Pi's ZIM
disk quietly fills with the droppings of captures nobody remembers.

The browser half: a rendered/alive job's Chromium is a child process, and the
watchdog's kill path (``RenderedSession.kill`` / ``shutdown_sessions``) is the
only thing standing between a wedged job and a zombie browser. It is pinned
here with a stand-in child process, so the test is fast, deterministic and
runs on machines with no Playwright at all.
"""

import os
import signal
import subprocess
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
from tests.test_create_finish import mini_site  # noqa: E402,F401


def _zimi_droppings(path):
    return sorted(p for p in os.listdir(path) if p.startswith(".zimi-"))


# ── the crawl spool, on the cancel path ─────────────────────────────────────


def test_a_cancelled_site_crawl_leaves_the_output_dir_exactly_as_it_was(
    mini_site, tmp_path, monkeypatch
):
    """The web's cancel raises out of the progress callback at a line
    boundary — this is that path, driven for real: the spool dir exists while
    the crawl runs and is gone the moment the exception unwinds, and no ZIM
    appears under any name."""
    pytest.importorskip("libzim.writer")
    import zimi.crawler as crawler

    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    before = sorted(os.listdir(str(tmp_path)))
    seen = {"spool": False}

    def note(message):
        if _zimi_droppings(str(tmp_path)):
            seen["spool"] = True  # the spool really was beside the output
        if str(message).strip().startswith("[1/"):
            raise manage._CreateCancelled()

    with pytest.raises(manage._CreateCancelled):
        crawler.create_site_zim(
            mini_site + "/",
            out_dir=str(tmp_path),
            max_pages=5,
            delay=0,
            progress=note,
        )
    assert seen["spool"] is True
    assert sorted(os.listdir(str(tmp_path))) == before


def test_a_failing_site_crawl_cleans_up_too(mini_site, tmp_path, monkeypatch):
    pytest.importorskip("libzim.writer")
    import zimi.crawler as crawler

    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    before = sorted(os.listdir(str(tmp_path)))

    def note(message):
        if str(message).strip().startswith("[2/"):
            raise RuntimeError("simulated engine failure mid-crawl")

    with pytest.raises(RuntimeError):
        crawler.create_site_zim(
            mini_site + "/", out_dir=str(tmp_path), max_pages=5, delay=0, progress=note
        )
    assert sorted(os.listdir(str(tmp_path))) == before


# ── the alive recording temp ────────────────────────────────────────────────


def test_a_failed_alive_engine_construction_leaves_no_warc_behind(
    tmp_path, monkeypatch
):
    """AliveCapture makes its .zimi-alive-*.warc.gz BEFORE the browser session
    exists. If the session cannot even be constructed there is no engine for
    anyone to close, so the constructor itself must take the archive back."""
    import zimi.alive as alive

    class Boom(Exception):
        pass

    def no_session(**_kw):
        raise Boom("no browser for you")

    monkeypatch.setattr(renderer, "RenderedSession", no_session)
    with pytest.raises(Boom):
        alive.AliveCapture(work_dir=str(tmp_path))
    assert _zimi_droppings(str(tmp_path)) == []


# ── the renderer spool and the kill path ────────────────────────────────────


def test_a_session_that_never_started_still_cleans_its_spool(tmp_path):
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    assert _zimi_droppings(str(tmp_path)) != []  # the spool exists…
    session.close()
    assert _zimi_droppings(str(tmp_path)) == []  # …and close() takes it back


def _fake_driver():
    """A child process standing in for Playwright's node driver."""
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _gone(pid, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not renderer._process_alive(pid):
            return True
        time.sleep(0.02)
    return False


def test_kill_takes_the_driver_out_from_any_thread(tmp_path):
    """The watchdog's path: it cannot ask a wedged thread to tidy up, so it
    signals the driver pid directly, and close() afterwards must not try to
    talk to the corpse."""
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    proc = _fake_driver()
    session._driver_pid = proc.pid
    try:
        session.kill()
        assert _gone(proc.pid), "the driver survived kill()"
        # close() after a kill skips the polite half and still cleans the spool.
        session.close()
        assert _zimi_droppings(str(tmp_path)) == []
    finally:
        try:
            os.kill(proc.pid, signal.SIGKILL)
        except OSError:
            pass


def test_shutdown_sessions_kills_every_registered_browser(tmp_path):
    """What _create_kill_browsers reaches for when a job stalls: every live
    session's driver dies, and the registry is emptied so a second sweep has
    nothing to do."""
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    proc = _fake_driver()
    session._driver_pid = proc.pid
    with renderer._sessions_lock:
        renderer._sessions.append(session)
    try:
        renderer.shutdown_sessions()
        assert _gone(proc.pid), "shutdown_sessions left the driver running"
        with renderer._sessions_lock:
            assert session not in renderer._sessions
        session.close()
        assert _zimi_droppings(str(tmp_path)) == []
    finally:
        try:
            os.kill(proc.pid, signal.SIGKILL)
        except OSError:
            pass


# ── where the working files go ──────────────────────────────────────────────


def test_the_scratch_directory_is_beside_the_output_not_in_the_library(
    tmp_path, monkeypatch
):
    """The defect: ``out_dir or _srv.ZIM_DIR``, written at eight call sites.

    Pass ``out_path`` and no ``out_dir`` — the ordinary CLI shape — and every
    one of them aimed the scratch files at a library folder the caller never
    mentioned, may not have, and may not be able to write. ``mkdtemp`` then
    raised FileNotFoundError from three frames down, which reads as a bug in
    the renderer rather than a directory nobody chose.
    """
    import zimi.creator as creator
    import zimi.server as _srv

    missing = str(tmp_path / "not-a-library")
    monkeypatch.setattr(_srv, "ZIM_DIR", missing)
    out = tmp_path / "beside" / "page.zim"
    out.parent.mkdir()

    assert creator.scratch_dir(None, str(out)) == str(out.parent)
    # And it got there without inventing the library folder on the way.
    assert not os.path.exists(missing)


def test_an_explicit_working_directory_still_wins(tmp_path, monkeypatch):
    import zimi.creator as creator
    import zimi.server as _srv

    monkeypatch.setattr(_srv, "ZIM_DIR", str(tmp_path / "library"))
    asked = tmp_path / "asked-for"
    asked.mkdir()
    out = tmp_path / "elsewhere" / "page.zim"
    out.parent.mkdir()
    assert creator.scratch_dir(str(asked), str(out)) == str(asked)


def test_a_configured_but_unmade_library_is_created_not_skipped(
    tmp_path, monkeypatch
):
    """A ZIM_DIR that is configured and does not exist yet is an ordinary state
    on a fresh install. Falling past it to the machine's temp would scatter a
    user's working files somewhere they never pointed at — and /tmp is a RAM
    disk on some of the machines Zimi runs on."""
    import zimi.creator as creator
    import zimi.server as _srv

    library = tmp_path / "library-to-be"
    monkeypatch.setattr(_srv, "ZIM_DIR", str(library))
    assert creator.scratch_dir(None, None) == str(library)
    assert library.is_dir()
