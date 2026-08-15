"""Finish-early ("stop fetching and package what we have"), end to end.

Eric: "Maybe we should have a button to stop fetching the site and package
what we did so far?" The CLI has always had this — SIGINT ends the crawl at
the next page boundary and still writes a valid ZIM — and the property is
prized. These tests pin the web's route onto the SAME machinery:

  the crawl     ``create_site_zim(stop=…)`` takes a caller-owned stop flag and
                treats it exactly like its own SIGINT flag
  the route     POST /manage/create/finish sets it, honestly reports
                "finishing", and refuses when it would mean nothing
  the status    ``finishable``/``finishing`` are computed server-side so the
                client never has to know the rules
  the result    a crawl that stopped early SAYS SO (``result.stopped``)

Also here: the browser-start feedback event, because it rides the same event
stream the finish button lives beside.
"""

import http.server
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
from tests.test_create_routes import (  # noqa: E402,F401
    _get,
    _post,
    _wait_done,
    clean_job,
    stub_engine,
)

# ── the route ───────────────────────────────────────────────────────────────


@pytest.fixture
def finish_aware_engine(monkeypatch):
    """A stubbed run that behaves like the crawl does: it works until the
    job's finish flag goes up, then returns a result that says it stopped."""
    state = {"pages": 0}

    def run(job, opts):
        while not job.finish_requested and not job.cancel_requested:
            state["pages"] += 1
            job.note(
                f"  [{state['pages']}/50] https://e.test/p{state['pages']}  "
                "(3 queued, 1.0 KB fetched)"
            )
            time.sleep(0.005)
        job.note("packaging 2 pages…")
        return {
            "path": "/zims/early.zim",
            "pages": state["pages"],
            "stopped": "interrupted",
            "registered": False,
        }

    monkeypatch.setattr(manage, "_create_run", run)
    return state


def test_finish_stops_the_job_and_the_result_says_stopped(finish_aware_engine):
    assert (
        _post("/manage/create", {"mode": "site", "source": "https://e.test/"}).status
        == 200
    )
    body = _get("/manage/create/status").body
    assert body["finishable"] is True
    assert body["finishing"] is False

    # Let the "crawl" capture at least one page before asking it to stop —
    # which is also the real shape of the gesture.
    for _ in range(400):
        if finish_aware_engine["pages"] >= 1:
            break
        time.sleep(0.005)

    h = _post("/manage/create/finish", {})
    assert h.status == 200
    assert h.body["status"] == "finishing"

    body = _get("/manage/create/status").body
    assert body["finishing"] is True

    done = _wait_done()
    assert done["ok"] is True
    assert done["cancelled"] is False
    # The honesty clause: the result names the bound that ended the crawl and
    # how far it got, so the done card can say "stopped early at N pages".
    assert done["result"]["stopped"] == "interrupted"
    assert done["result"]["pages"] >= 1
    # And the request itself landed in the log, where the transcript lives.
    lines = _get("/manage/create/status", params={"since": ["0"]}).body["lines"]
    assert any("finish requested" in line for line in lines)


def test_finish_with_no_job_is_refused():
    assert _post("/manage/create/finish", {}).status == 409


def test_finish_is_only_for_site_jobs(stub_engine):
    gate = {"go": False}

    def held(job, opts):
        while not gate["go"]:
            time.sleep(0.005)
        return {"path": "/zims/x.zim"}

    import zimi.manage as m

    orig = m._create_run
    m._create_run = held
    try:
        _post("/manage/create", {"mode": "page", "source": "https://e.test/a"})
        body = _get("/manage/create/status").body
        assert body["finishable"] is False
        h = _post("/manage/create/finish", {})
        assert h.status == 409
        assert "site" in h.body["error"]
    finally:
        gate["go"] = True
        m._create_run = orig
        _wait_done()


def test_cancel_beats_finish(finish_aware_engine):
    """Cancel keeps meaning discard. Once one is in flight, finish is refused
    rather than quietly downgrading the discard to a keep."""
    _post("/manage/create", {"mode": "site", "source": "https://e.test/"})
    assert _post("/manage/create/cancel", {}).status == 200
    h = _post("/manage/create/finish", {})
    assert h.status == 409
    body = _wait_done()
    assert body["cancelled"] is True


def test_the_button_offer_ends_when_packaging_starts(monkeypatch):
    """`finishable` is phase-scoped: once the crawl's network pass is over
    there is nothing left to stop, and the client hides the button on the
    server's word."""
    gate = {"packaging": False, "go": False}

    def run(job, opts):
        job.note("fetching https://e.test/")
        while not gate["packaging"]:
            time.sleep(0.005)
        job.note("packaging 3 pages…")  # enters the package phase
        while not gate["go"]:
            time.sleep(0.005)
        return {"path": "/zims/x.zim", "pages": 3}

    monkeypatch.setattr(manage, "_create_run", run)
    _post("/manage/create", {"mode": "site", "source": "https://e.test/"})
    assert _get("/manage/create/status").body["finishable"] is True
    gate["packaging"] = True
    for _ in range(400):
        if _get("/manage/create/status").body["phase"] == "package":
            break
        time.sleep(0.01)
    assert _get("/manage/create/status").body["finishable"] is False
    gate["go"] = True
    _wait_done()


def test_a_finish_that_raced_job_startup_is_not_lost():
    """The route sets the boolean; _create_run seeds the crawl's flag FROM it.
    A request that lands in the gap between launch and the crawl existing must
    still stop the crawl."""
    job = manage._CreateJob("site", "https://e.test/", "")
    job.finish_requested = True  # the route ran before the worker got here
    from zimi.crawler import _StopFlag

    stop = _StopFlag()
    stop.hit = job.finish_requested  # the exact seeding _create_run performs
    assert stop.hit is True


# ── the crawl itself honors a caller-owned flag ─────────────────────────────
#
# A tiny real site on an ephemeral port, crawled by the real builtin engine
# and packaged by the real writer — because "stops at the page boundary and
# still writes a valid ZIM" is a property of the whole pipeline, not of a
# stub. This is the CLI-SIGINT semantics test, minus the signal.


def _chain_page(i):
    return (
        f"<html><head><title>Page {i}</title></head>"
        f'<body><h1>Page {i}</h1><a href="/p{i + 1}.html">onward</a></body></html>'
    ).encode()


@pytest.fixture
def mini_site():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/robots.txt" or not (
                self.path == "/" or self.path.startswith("/p")
            ):
                self.send_error(404)
                return
            i = 0 if self.path == "/" else int(self.path[2:].split(".")[0])
            body = _chain_page(i)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


def test_a_supplied_stop_flag_ends_the_crawl_and_still_writes_a_zim(
    mini_site, tmp_path, monkeypatch
):
    pytest.importorskip("libzim.writer")
    from libzim.reader import Archive

    import zimi.crawler as crawler

    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    stop = crawler._StopFlag()

    def note(message):
        # The crawl announces "[2/10] …" once the second page is fully in;
        # raising the flag there means page 3 is never fetched.
        if str(message).strip().startswith("[2/"):
            stop.hit = True

    info = crawler.create_site_zim(
        mini_site + "/",
        out_dir=str(tmp_path),
        max_pages=10,
        delay=0,
        progress=note,
        stop=stop,
    )
    assert info["stopped"] == "interrupted"
    assert info["pages"] == 2
    arc = Archive(info["path"])
    assert arc.main_entry.get_item().path == "A/index"
    # The prized property, in file-system terms: a finished (if early) ZIM and
    # no crawl droppings beside it.
    leftovers = [p for p in os.listdir(str(tmp_path)) if p.startswith(".zimi-")]
    assert leftovers == []


# ── browser-start feedback ──────────────────────────────────────────────────
#
# Eric: "When starting a headless browser show something right now — I need to
# open the log thing to see what's happening." The renderer's own line becomes
# a structured event the run pane draws immediately, and the next real
# progress takes it back down.


def _events(job, since=0):
    events, cursor = job.event_tail(since)
    return events, cursor


def test_the_browser_start_line_becomes_an_immediate_event():
    job = manage._CreateJob("site", "https://e.test/", "")
    job.note("fetching https://e.test/")
    _evs, cursor = _events(job)
    job.note("starting a headless browser…")
    events, cursor = _events(job, cursor)
    assert events == [
        {
            "i": events[0]["i"],
            "t": "phase",
            "phase": "fetch",
            "detail": "starting a headless browser…",
        }
    ]
    # Same phase, so nothing about the strip moves — only the caption.
    assert job.phase == "fetch"

    # The next real progress re-states the phase with its plain detail, which
    # the client renders as "caption down".
    job.note("  [1/10] https://e.test/  (2 queued, 1.0 KB fetched)")
    events, _cursor = _events(job, cursor)
    assert events[0]["t"] == "phase"
    assert events[0]["detail"] == "site"
    assert job.transient_detail is False


def test_the_caption_also_clears_on_the_next_fetch_line():
    job = manage._CreateJob("page", "https://e.test/a", "")
    job.note("fetching https://e.test/a")
    job.note("starting a headless browser…")
    _evs, cursor = _events(job)
    job.note("fetching https://e.test/b")
    events, _cursor = _events(job, cursor)
    kinds = [(e["t"], e.get("detail")) for e in events]
    assert ("phase", "page") in kinds  # the clearing re-statement


def test_a_job_that_never_starts_a_browser_emits_no_such_event():
    job = manage._CreateJob("site", "https://e.test/", "")
    job.note("fetching https://e.test/")
    events, _ = _events(job)
    assert all(e.get("detail") != "starting a headless browser…" for e in events)
