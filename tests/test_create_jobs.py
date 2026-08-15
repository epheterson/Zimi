"""The create JOB model, as opposed to the create routes.

Round 3 of the Create page came back with three questions from a real field
test — is a job server-side and stable if I close the page, can I find one that
was already in progress, and do multiple submissions queue — plus one bug: a
site capture that "got stuck on packaging forever". Everything here is the
answer to one of those:

  the queue      submitting twice files a job, it does not get refused
  the journal    jobs outlive the process that ran them, honestly
  the watchdog   a job that stops reporting is failed, not spun forever
  the events     the structured stream the progress view draws from

The route-level contract (auth, validation, cursors) lives in
test_create_routes.py; its handler helpers are reused here rather than copied.
"""

import http.server
import json
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402
from tests.test_create_routes import (  # noqa: E402,F401
    _get,
    _post,
    _wait_done,
    clean_job,
    stub_engine,
)


def _wait(predicate, tries=600, why="condition never came true"):
    for _ in range(tries):
        if predicate():
            return True
        time.sleep(0.01)
    raise AssertionError(why)


@pytest.fixture
def held_engine(monkeypatch):
    """An engine that runs until the test lets it go. Returns the gate dict:
    ``go`` releases it, ``started`` counts the jobs that reached it, and
    ``seen`` records each job's source in the order they ran.

    The gate is ALWAYS released on teardown, and the fixture waits for the
    threads to leave. A held engine that outlives its test is a thread sitting
    in a sleep loop for the rest of the session — which is invisible until some
    later test patches ``time.sleep`` and that loop turns hot inside it."""
    gate = {"go": False, "started": 0, "seen": [], "running": 0}

    def held_run(job, opts):
        gate["started"] += 1
        gate["running"] += 1
        gate["seen"].append(job.source)
        try:
            while not gate["go"]:
                time.sleep(0.005)
        finally:
            gate["running"] -= 1
        return {"path": "/zims/held.zim", "registered": False}

    monkeypatch.setattr(manage, "_create_run", held_run)
    yield gate
    gate["go"] = True
    _wait(lambda: gate["running"] == 0, why="a held engine thread never exited")


def _start_job(name):
    """File one job. Site mode with a distinct path: validation only checks
    the URL's shape, and every test here stubs the engine, so nothing touches
    the network. (These used to be folder jobs; folder mode is CLI-only now.)"""
    return _post(
        "/manage/create", {"mode": "site", "source": f"https://example.test/{name}"}
    )


# ── the queue ───────────────────────────────────────────────────────────────


def test_jobs_run_in_the_order_they_were_filed(tmp_path, held_engine):
    first = _start_job("a")
    assert first.body["status"] == "started"
    for position, name in enumerate(("b", "c"), 1):
        queued = _start_job(name)
        assert queued.status == 200
        assert queued.body["status"] == "queued"
        assert queued.body["position"] == position

    body = _get("/manage/create/status").body
    assert [entry["position"] for entry in body["queue"]] == [1, 2]
    assert [os.path.basename(e["source"]) for e in body["queue"]] == ["b", "c"]

    held_engine["go"] = True
    _wait(lambda: held_engine["started"] == 3, why="the queue never drained")
    assert [os.path.basename(p) for p in held_engine["seen"]] == ["a", "b", "c"]
    assert _get("/manage/create/status").body["queue"] == []


def test_the_queue_is_bounded_and_says_so(tmp_path, held_engine):
    _start_job("running")
    for _ in range(manage.CREATE_QUEUE_MAX):
        assert _start_job("waiting").body["status"] == "queued"
    refused = _start_job("one-too-many")
    assert refused.status == 429
    assert refused.body["queued"] == manage.CREATE_QUEUE_MAX
    assert str(manage.CREATE_QUEUE_MAX) in refused.body["error"]


def test_a_queued_job_can_be_dropped_without_touching_the_running_one(
    tmp_path, held_engine
):
    _start_job("running")
    doomed = _start_job("doomed").body["id"]
    keeper = _start_job("keeper").body["id"]

    dropped = _post("/manage/create/cancel", {"id": doomed})
    assert dropped.status == 200
    assert dropped.body["status"] == "dequeued"

    body = _get("/manage/create/status").body
    assert [entry["id"] for entry in body["queue"]] == [keeper]
    assert body["active"] is True  # the running job never noticed

    held_engine["go"] = True
    _wait(lambda: held_engine["started"] == 2, why="the keeper never ran")
    assert [os.path.basename(p) for p in held_engine["seen"]] == ["running", "keeper"]


def test_cancel_by_the_running_jobs_id_cancels_that_job(tmp_path, held_engine):
    running = _start_job("running").body["id"]
    answer = _post("/manage/create/cancel", {"id": running})
    assert answer.status == 200
    assert answer.body["status"] == "cancelling"
    assert answer.body["id"] == running
    held_engine["go"] = True


def test_cancel_with_an_unknown_id_is_refused(tmp_path, held_engine):
    _start_job("running")
    assert _post("/manage/create/cancel", {"id": "nosuchjob"}).status == 409
    held_engine["go"] = True


# ── the journal ─────────────────────────────────────────────────────────────


def _journal(tmp_path):
    with open(os.path.join(str(tmp_path / "data"), "create_jobs.json")) as fh:
        return json.load(fh)


def test_a_job_is_journalled_from_queue_through_to_its_outcome(tmp_path, held_engine):
    running = _start_job("running").body["id"]
    queued = _start_job("queued").body["id"]

    states = {r["id"]: r["state"] for r in _journal(tmp_path)}
    assert states[running] == "running"
    assert states[queued] == "queued"

    held_engine["go"] = True
    _wait(lambda: held_engine["started"] == 2, why="the queue never drained")
    _wait(
        lambda: {r["id"]: r["state"] for r in _journal(tmp_path)}.get(queued) == "ok",
        why="the second job never reached a final journal state",
    )
    finished = {r["id"]: r for r in _journal(tmp_path)}
    assert finished[running]["state"] == "ok"
    assert finished[running]["mode"] == "site"
    assert finished[running]["result"] == "held"
    assert finished[running]["finished"] >= finished[running]["started"]


def test_a_restart_turns_running_and_queued_records_into_honest_ones(tmp_path):
    """The journal is the only piece of job state that outlives the process, so
    it is where a redeploy mid-job stops being a job that runs forever."""
    path = os.path.join(str(tmp_path / "data"), "create_jobs.json")
    with open(path, "w") as fh:
        json.dump(
            [
                {"id": "one", "mode": "site", "state": "running", "phase": "package"},
                {"id": "two", "mode": "page", "state": "queued", "phase": "fetch"},
                {"id": "three", "mode": "folder", "state": "ok", "result": "kept"},
            ],
            fh,
        )
    manage._create_journal = None  # a fresh process reading the file

    history = _get("/manage/create/status", params={"history": "1"}).body["history"]
    by_id = {record["id"]: record for record in history}
    assert by_id["one"]["state"] == "interrupted"
    assert "the server restarted during this job" in by_id["one"]["error"]
    assert by_id["two"]["state"] == "interrupted"
    assert "before this job began" in by_id["two"]["error"]
    # A finished record is history, not a casualty.
    assert by_id["three"]["state"] == "ok"
    # And the reconciliation is written back, so it survives this process too.
    with open(path) as fh:
        assert {r["id"]: r["state"] for r in json.load(fh)}["one"] == "interrupted"


def test_history_is_newest_first_bounded_and_only_when_asked(tmp_path):
    path = os.path.join(str(tmp_path / "data"), "create_jobs.json")
    with open(path, "w") as fh:
        json.dump(
            [{"id": str(n), "mode": "folder", "state": "ok"} for n in range(40)], fh
        )
    manage._create_journal = None

    plain = _get("/manage/create/status").body
    assert "history" not in plain  # the poll stays cheap by default

    history = _get("/manage/create/status", params={"history": "1"}).body["history"]
    assert len(history) <= manage.CREATE_JOURNAL_RECORDS
    assert history[0]["id"] == "39"  # newest first


def test_a_journal_that_is_not_a_journal_is_ignored_not_fatal(tmp_path):
    path = os.path.join(str(tmp_path / "data"), "create_jobs.json")
    with open(path, "w") as fh:
        fh.write("{not json at all")
    manage._create_journal = None
    assert _get("/manage/create/status", params={"history": "1"}).body["history"] == []


def test_an_unwritable_data_dir_does_not_stop_a_job(tmp_path, monkeypatch, stub_engine):
    """Journalling is bookkeeping. A read-only data dir is a real deployment
    (a ZIM library on a mounted archive), and it must cost the log entry, not
    the job."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "nowhere" / "deeper"))
    manage._create_journal = None
    assert (
        _post(
            "/manage/create", {"mode": "site", "source": "https://example.test/src"}
        ).status
        == 200
    )
    assert _wait_done()["ok"] is True


# ── the atomic writer, which is what makes "interrupted" safe ───────────────


def test_an_interrupted_write_leaves_no_zim_under_its_real_name(tmp_path):
    """The journal can call an interrupted job interrupted precisely because a
    half-written ZIM cannot outlive the process that was writing it."""
    pytest.importorskip("libzim.writer")
    from zimi.zimwriter import atomic_zim_creator

    out = str(tmp_path / "half.zim")
    with pytest.raises(RuntimeError):
        with atomic_zim_creator(out, "eng"):
            raise RuntimeError("the server went away")
    assert not os.path.exists(out)
    assert not os.path.exists(out + ".tmp")


# ── the watchdog ────────────────────────────────────────────────────────────


@pytest.fixture
def quick_watchdog(monkeypatch):
    monkeypatch.setattr(manage, "CREATE_STALL_SECONDS", 0.1)
    monkeypatch.setattr(manage, "CREATE_STALL_TICK", 0.02)


def test_a_job_that_stops_reporting_is_failed_not_spun(
    tmp_path, monkeypatch, quick_watchdog
):
    release = threading.Event()

    def wedged_run(job, opts):
        job.note("started well enough")
        release.wait(10)  # the shape of a host that accepted and never answered
        return {"path": "/zims/never.zim", "registered": False}

    monkeypatch.setattr(manage, "_create_run", wedged_run)
    _start_job("wedged")
    body = _wait_done()
    assert body["done"] is True
    assert body["ok"] is False
    assert body["stalled"] is True
    assert "no progress" in body["error"]
    assert "Nothing has been added to the library" in body["error"]
    assert {r["state"] for r in _journal(tmp_path)} == {"stalled"}
    release.set()


def test_a_job_that_keeps_reporting_is_left_alone(
    tmp_path, monkeypatch, quick_watchdog
):
    def chatty_run(job, opts):
        for _ in range(20):
            job.note("still here")
            time.sleep(0.02)
        return {"path": "/zims/fine.zim", "registered": False}

    monkeypatch.setattr(manage, "_create_run", chatty_run)
    _start_job("chatty")
    body = _wait_done()
    assert body["ok"] is True
    assert body["stalled"] is False


def test_a_stalled_job_hands_the_slot_to_the_queue(
    tmp_path, monkeypatch, quick_watchdog
):
    release = threading.Event()
    ran = []

    def maybe_wedged_run(job, opts):
        ran.append(job.source)
        if job.source.endswith("wedged"):
            release.wait(10)
        return {"path": "/zims/x.zim", "registered": False}

    monkeypatch.setattr(manage, "_create_run", maybe_wedged_run)
    _start_job("wedged")
    _start_job("next")
    _wait(lambda: len(ran) == 2, why="the queue stayed stuck behind the wedged job")
    release.set()


def test_a_job_finished_twice_only_counts_once(tmp_path, held_engine):
    """The watchdog and the worker can both reach the finish line for the same
    job. If both counted, the queue would advance twice and two creations would
    run at once on a machine chosen for being able to run one."""
    _start_job("running")
    _start_job("queued")
    job = manage._create_job
    assert manage._create_finish(job, error="first") is True
    assert manage._create_finish(job, error="second") is False
    assert job.error == "first"
    held_engine["go"] = True
    _wait(lambda: held_engine["started"] == 2, why="the queued job never ran")
    assert manage._create_queue == []


# ── the structured event stream ─────────────────────────────────────────────


def _events_of(stub, lines, mode="site", source="https://example.org/"):
    """Run a job whose engine emits exactly ``lines`` and return its events."""
    stub["lines"] = lines
    _post("/manage/create", {"mode": mode, "source": source})
    _wait_done()
    return _get("/manage/create/status").body["events"]


def test_events_arrive_once_each_on_their_own_cursor(stub_engine):
    stub_engine["lines"] = [
        f"  [{n}/3] https://e.org/p{n}  (0 queued)" for n in (1, 2, 3)
    ]
    _post("/manage/create", {"mode": "site", "source": "https://e.org/"})

    seen, cursor, guard = [], 0, 0
    while guard < 400:
        guard += 1
        body = _get("/manage/create/status", params={"events_since": str(cursor)}).body
        seen.extend(body["events"])
        cursor = body["event_cursor"]
        if body["done"]:
            body = _get(
                "/manage/create/status", params={"events_since": str(cursor)}
            ).body
            seen.extend(body["events"])
            break
        time.sleep(0.005)
    assert [event["i"] for event in seen] == list(range(len(seen)))
    # The stream describes itself from event 0: the phase, before anything is
    # counted inside it.
    assert seen[0] == {"i": 0, "t": "phase", "phase": "fetch", "detail": "site"}
    assert seen[-1]["t"] == "phase" and seen[-1]["phase"] == "done"
    assert [e["id"] for e in seen if e["t"] == "node"] == [
        f"https://e.org/p{n}" for n in (1, 2, 3)
    ]


def test_the_event_buffer_is_bounded_and_the_cursor_snaps_forward(
    stub_engine, monkeypatch
):
    monkeypatch.setattr(manage, "CREATE_EVENT_BUFFER", 10)
    stub_engine["lines"] = [
        f"  [{n}/60] https://e.org/p{n}  (0 queued)" for n in range(1, 61)
    ]
    _post("/manage/create", {"mode": "site", "source": "https://e.org/"})
    _wait_done()
    body = _get("/manage/create/status", params={"events_since": "0"}).body
    assert len(body["events"]) <= 10
    # A cursor older than the buffer snaps forward rather than replaying the
    # wrong window: what it gets back is the tail, and the cursor to use next.
    assert body["events"][0]["i"] == body["event_cursor"] - len(body["events"])


def test_a_crawl_line_becomes_a_page_node_a_count_and_a_byte_total(stub_engine):
    stub_engine["lines"] = [
        "  [12/200] https://e.org/docs/a?page=2  (30 queued, 2.0 KB fetched)"
    ]
    events = _events_of(stub_engine, stub_engine["lines"])
    assert {
        "t": "node",
        "kind": "page",
        "id": "https://e.org/docs/a?page=2",
        "parent": None,
        "label": "/docs/a?page=2",
        "state": "done",
    }.items() <= events[1].items()
    assert {"t": "count", "what": "bytes", "n": 2048, "total": None}.items() <= events[
        2
    ].items()
    assert {
        "t": "count",
        "what": "entries",
        "n": 12,
        "total": 200,
    }.items() <= events[3].items()


def test_the_packaging_pass_reports_entries_of_a_known_total(stub_engine):
    stub_engine["lines"] = [
        "  [1/2] https://e.org/a  (0 queued, 1.0 KB fetched)",
        "packaging 2 pages…",
        "  packaged 1/2  A/a",
        "  packaged 2/2  A/b",
    ]
    events = _events_of(stub_engine, stub_engine["lines"])
    phases = [e["phase"] for e in events if e["t"] == "phase"]
    assert phases == ["fetch", "package", "register", "done"]
    counts = [
        (e["n"], e["total"])
        for e in events
        if e["t"] == "count" and e["what"] == "entries"
    ]
    assert counts == [(1, 2), (0, 2), (1, 2), (2, 2)]
    entries = [e for e in events if e["t"] == "node" and e["kind"] == "entry"]
    assert [e["label"] for e in entries] == ["A/a", "A/b"]


def test_a_video_step_line_becomes_an_entry_not_a_page(stub_engine):
    stub_engine["lines"] = ["[2/9] A Talk About Nothing"]
    events = _events_of(
        stub_engine, stub_engine["lines"], mode="video", source="https://e.org/list"
    )
    node = next(e for e in events if e["t"] == "node")
    assert node["kind"] == "entry"
    assert node["label"] == "A Talk About Nothing"
    assert not [e for e in events if e["t"] == "count" and e["what"] == "bytes"]


def test_page_mode_lines_mark_a_page_active_then_done_or_failed(stub_engine):
    stub_engine["lines"] = [
        "fetching https://e.org/one",
        "packaging https://e.org/one",
        "  skipped https://e.org/two: it is an empty application shell",
    ]
    events = _events_of(
        stub_engine, stub_engine["lines"], mode="page", source="https://e.org/one"
    )
    states = [(e["id"], e["state"]) for e in events if e["t"] == "node"]
    assert states == [
        ("https://e.org/one", "active"),
        ("https://e.org/one", "done"),
        ("https://e.org/two", "failed"),
    ]


def test_a_title_the_engine_read_names_the_job_unless_one_was_typed(stub_engine):
    # The run header needs a name from the first seconds, and for a site
    # capture the site declares one. It is adopted only into an empty field.
    _events_of(stub_engine, ["title: The Handbook"])
    assert _get("/manage/create/status").body["title"] == "The Handbook"

    stub_engine["lines"] = ["title: The Handbook"]
    _post(
        "/manage/create",
        {"mode": "site", "source": "https://e.org/", "title": "My Own Name"},
    )
    _wait_done()
    assert _get("/manage/create/status").body["title"] == "My Own Name"


def test_a_line_the_adapter_cannot_read_costs_no_events(stub_engine):
    stub_engine["lines"] = [
        "robots.txt asks for a 2s crawl delay — honoring it",
        "content language: eng (detected from the site)",
    ]
    events = _events_of(stub_engine, stub_engine["lines"])
    # The phases the job itself declares, and nothing invented in between: two
    # lines of engine prose produced no nodes and no counts.
    assert [(e["t"], e.get("phase")) for e in events] == [
        ("phase", "fetch"),
        ("phase", "register"),
        ("phase", "done"),
    ]


def test_a_finished_run_files_the_totals_no_line_carried(stub_engine):
    stub_engine["result"] = {
        "path": "/zims/site.zim",
        "registered": True,
        "pages": 40,
        "assets": 118,
    }
    events = _events_of(stub_engine, ["packaging 40 pages…"])
    totals = {e["what"]: e["n"] for e in events if e["t"] == "count"}
    assert totals["entries"] == 40
    assert totals["assets"] == 118
    # …and the same counts ride the result, so a done card never has to read
    # them back out of the log it just stopped showing.
    result = _get("/manage/create/status").body["result"]
    assert (result["pages"], result["assets"]) == (40, 118)
    assert [e["phase"] for e in events if e["t"] == "phase"][-2:] == [
        "register",
        "done",
    ]


def test_the_status_reports_the_phase_a_job_is_in(tmp_path, held_engine):
    _start_job("held")
    # A site job starts in fetch and stays there while the engine is held.
    assert _get("/manage/create/status").body["phase"] == "fetch"
    held_engine["go"] = True
    _wait_done()
    assert _get("/manage/create/status").body["phase"] == "done"


# ── the packaging pass, against a real crawl ────────────────────────────────
#
# The bug behind all of this: the site engine's write pass fetches every
# captured page's images and stylesheets, which on a real site makes it the
# LONGEST phase of the job — and it used to emit a single line before it began.
# The pane showed "packaging N pages…" for minutes, the cancel button had no
# checkpoint to land on, and the honest reading from the outside was "stuck
# forever". These two tests pin both halves of the fix.

pytest.importorskip("libzim.writer")

_FIXTURE_PAGES = 12


def _fixture_page(index):
    links = "".join(f'<a href="/p{n}.html">page {n}</a>' for n in range(_FIXTURE_PAGES))
    return (
        f"<html lang=en><head><title>Page {index}</title>"
        '<link rel="stylesheet" href="/site.css"></head><body>'
        f'<h1>Page {index}</h1><img src="/img/{index}.png">{links}</body></html>'
    ).encode()


class _FixtureHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # a fixture site does not narrate itself into the test output

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/img/") or path == "/site.css":
            ctype = "image/png" if path.startswith("/img/") else "text/css"
            return self._send(ctype, b"x" * 32)
        if path in ("/", "/index.html"):
            return self._send("text/html; charset=utf-8", _fixture_page(0))
        if path.startswith("/p") and path.endswith(".html"):
            try:
                index = int(path[2:-5])
            except ValueError:
                return self.send_error(404)
            if 0 <= index < _FIXTURE_PAGES:
                return self._send("text/html; charset=utf-8", _fixture_page(index))
        self.send_error(404)

    def _send(self, ctype, body):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture(scope="module")
def fixture_site():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/"
    srv.shutdown()
    srv.server_close()


def test_the_packaging_pass_reports_every_page_it_writes(fixture_site, tmp_path):
    import zimi.crawler as crawler

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    lines = []
    result = crawler.create_site_zim(
        fixture_site,
        out_dir=str(out_dir),
        max_pages=_FIXTURE_PAGES,
        delay=0,
        ignore_robots=True,
        progress=lines.append,
    )
    packaged = [line.strip() for line in lines if line.strip().startswith("packaged ")]
    assert len(packaged) == result["pages"]
    assert packaged[0].startswith(f"packaged 1/{result['pages']}")
    assert packaged[-1].startswith(f"packaged {result['pages']}/{result['pages']}")


def test_a_real_crawl_reports_its_assets_against_the_page_that_wanted_them(
    fixture_site, tmp_path, stub_engine
):
    """The per-page fill bars in the Create page are drawn from asset nodes and
    their parent. Derivation is unit-tested above; this is the end-to-end
    check that a REAL crawl actually emits lines those rules recognise — the
    half that used to be missing, so the bars never appeared on a real job."""
    import zimi.crawler as crawler

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    lines = []
    crawler.create_site_zim(
        fixture_site,
        out_dir=str(out_dir),
        max_pages=_FIXTURE_PAGES,
        delay=0,
        ignore_robots=True,
        progress=lines.append,
    )
    # Push the real crawl's own output back through the real adapter.
    events = _events_of(stub_engine, lines)

    assets = [e for e in events if e["t"] == "node" and e["kind"] == "asset"]
    assert assets, "a crawl of a site with images and a stylesheet emitted no assets"
    pages = {e["id"] for e in events if e["t"] == "node" and e["kind"] == "page"}
    for asset in assets:
        assert asset["parent"], f"asset with no page behind it: {asset}"
        assert asset["parent"] in pages, f"asset hung off an uncaptured page: {asset}"
        assert asset["state"] in ("done", "failed")
    # The fixture's stylesheet is shared by every page and stored once, so it
    # belongs to the first page that wanted it and is not re-reported after.
    assert len(assets) == len({asset["id"] for asset in assets})


def test_a_page_goes_green_only_after_every_asset_it_wanted(
    fixture_site, tmp_path, stub_engine
):
    """Eric, on the round-3 page: "why are all the dots green right away are
    the downloads done then or still more during packaging?" They were still
    more — assets were fetched in the write pass, long after the row that
    wanted them had gone green. This is the invariant that replaced that, read
    off a REAL crawl's output through the REAL adapter: for every page, the
    events go active, then its assets, then done. Nothing is outstanding behind
    a green dot."""
    import zimi.crawler as crawler

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    lines = []
    crawler.create_site_zim(
        fixture_site,
        out_dir=str(out_dir),
        max_pages=_FIXTURE_PAGES,
        delay=0,
        ignore_robots=True,
        progress=lines.append,
    )
    events = _events_of(stub_engine, lines)
    nodes = [e for e in events if e["t"] == "node"]

    def where(kind, node_id, state):
        return next(
            i
            for i, e in enumerate(nodes)
            if e["kind"] == kind and e["id"] == node_id and e["state"] == state
        )

    pages = {e["id"] for e in nodes if e["kind"] == "page" and e["state"] == "done"}
    assert len(pages) > 1
    checked = 0
    for page in pages:
        opened, closed = where("page", page, "active"), where("page", page, "done")
        assert opened < closed, f"{page} was reported done before it was started"
        for i, event in enumerate(nodes):
            if event["kind"] == "asset" and event["parent"] == page:
                assert opened < i < closed, f"{event['id']} landed outside its page"
                checked += 1
    assert checked, "no assets were attributed to any page"


def test_cancelling_during_packaging_leaves_nothing_behind(fixture_site, tmp_path):
    """Cancellation is raised out of the sink, so this is the real cancel path,
    landing where it could not land before: inside the write pass. Driven
    directly rather than through the route because the point is determinism —
    the raise happens on a named line, not whenever a poll happens to arrive."""
    import zimi.crawler as crawler

    def cancel_at_first_packaged(line):
        if line.strip().startswith("packaged "):
            raise manage._CreateCancelled()

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    with pytest.raises(manage._CreateCancelled):
        crawler.create_site_zim(
            fixture_site,
            out_dir=str(out_dir),
            max_pages=_FIXTURE_PAGES,
            delay=0,
            ignore_robots=True,
            progress=cancel_at_first_packaged,
        )
    # No ZIM under its real name, no .tmp the writer abandoned, and no crawl
    # spool: everything a cancelled capture touched is gone.
    leftovers = sorted(os.listdir(str(out_dir)))
    assert leftovers == [], f"a cancelled capture left {leftovers} behind"
