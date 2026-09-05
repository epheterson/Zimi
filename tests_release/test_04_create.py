"""Making a ZIM from the web: point Zimi at a page and get a served source.

Folder capture left the web by decree (it is `zimi create <folder>` on the
server itself now), so the gate's creation journey rides the page mode: a
tiny fixture site served over local HTTP, captured with the builtin engine.
The journeys are unchanged — probe first, create, find it after the fact,
queue a second, read the event stream, check the provenance — and the
folder door is checked to be closed, not merely hidden.
"""

import http.server
import os
import threading

import pytest

from fixtures_zim import build_source_folder
from conftest import quote

pytestmark = pytest.mark.gate("ZIM creation from the web")

CREATE_TIMEOUT_SEC = 180


@pytest.fixture(scope="module")
def source_folder(tmp_path_factory):
    return build_source_folder(str(tmp_path_factory.mktemp("gate-source")))


@pytest.fixture(scope="module")
def gate_server(gate_library, tmp_path_factory):
    """This module's server boots WITHOUT ZIMI_OFFLINE, overriding the shared
    fixture: web creation is a network feature by nature, and under the
    offline switch page capture correctly refuses to fetch (that refusal is
    itself gate-checked in the offline feature). The capture target is the
    loopback fixture site, so the gate still runs on a machine with no
    internet. No ZIMI_CREATE_ROOT: the two modes that once read a server path
    (folder, archive import) are both CLI-only now, so nothing here needs one."""
    import shutil

    from conftest import boot, clean_env

    root = tmp_path_factory.mktemp("gate-create-instance")
    zim_dir = os.path.join(str(root), "zims")
    shutil.copytree(gate_library, zim_dir)
    env = clean_env()
    env.pop("ZIMI_OFFLINE", None)
    with boot(
        zim_dir=zim_dir, data_dir=os.path.join(str(root), "data"), env=env
    ) as server:
        yield server


@pytest.fixture(scope="module")
def source_site(source_folder):
    """The fixture folder, served over real HTTP on an ephemeral port —
    what the web creation flow actually points at."""

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=source_folder, **kw)

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    finally:
        httpd.shutdown()


def test_probe_describes_the_page_before_committing(gate_server, source_site):
    """The Create page shows you what you are about to get. If the probe lies
    or breaks, every creation becomes a leap of faith."""
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "page", "source": source_site}
    )
    assert status == 200, body
    assert body.get("ok") is True, f"probe refused a plain served page: {body}"
    assert body["mode"] == "page"
    assert body["title"] == "Field notes", f"probe misread the page: {body}"


def test_folder_mode_is_a_closed_door_not_a_hidden_one(gate_server, source_folder):
    """The web refuses folder capture outright and names the CLI. A client
    that no longer shows the tile is not the boundary — this is."""
    for endpoint in ("/manage/create/probe", "/manage/create"):
        status, body = gate_server.post_json(
            endpoint, {"mode": "folder", "source": source_folder}
        )
        assert status == 400, f"{endpoint} accepted folder mode: {body}"
        assert "CLI" in body.get("error", ""), body


def test_import_mode_is_a_closed_door_not_a_hidden_one(gate_server):
    """Archive import followed folder off the web ("remove archive as well only
    in cli"). Refused through both doors, naming `zimi import` — and, like
    folder, this holds even on an instance that has a root configured."""
    for endpoint in ("/manage/create/probe", "/manage/create"):
        status, body = gate_server.post_json(
            endpoint, {"mode": "import", "source": __file__}
        )
        assert status == 400, f"{endpoint} accepted import mode: {body}"
        assert "CLI" in body.get("error", ""), body
        assert "zimi import" in body.get("error", ""), body


def test_a_page_becomes_a_zim_that_serves(gate_server, source_site):
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "page", "source": source_site, "title": "Gate Field Notes"},
    )
    assert status == 200, body
    assert body.get("status") == "started", body

    state = gate_server.poll_json(
        "/manage/create/status",
        lambda s: s.get("done") is True,
        timeout=CREATE_TIMEOUT_SEC,
    )
    assert state.get("ok") is True, f"creation failed: {state}"
    assert not state.get("error"), state

    # The new ZIM must join the live library without a restart…
    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, f"the created ZIM never joined the library: {listing}"
    entry = created[0]
    assert entry["entries"] > 0

    # …and its content must actually serve.
    main_path = entry.get("main_path")
    assert main_path, f"created ZIM has no main page: {entry}"
    status, _headers, raw = gate_server.get(
        f"/w/{entry['name']}/{quote(main_path)}?raw=1"
    )
    assert status == 200, f"created ZIM will not serve its main page: {status}"
    assert b"Field notes" in raw

    # …and it must be findable.
    status, results = gate_server.get_json(
        f"/search?q=boiling&zim={quote(entry['name'])}&limit=10"
    )
    assert status == 200
    assert results["results"], f"nothing searchable in the created ZIM: {results}"


def test_without_a_configured_root_the_web_cannot_reach_the_filesystem(
    gate_library, tmp_path_factory
):
    """The default posture, booted for real. Eric's objection to the round-2
    folder flow was that it showed him the whole file system; the answer today
    is total: no web mode reads a path off the server's disk. Folder and archive
    import both refuse from the web no matter what and name their CLI door, the
    directory picker is gone, and the URL modes — which read nothing local — are
    untouched. Checked against a server that never had a ZIMI_CREATE_ROOT."""
    import shutil

    from conftest import boot, clean_env

    root = tmp_path_factory.mktemp("gate-noroot")
    zim_dir = os.path.join(str(root), "zims")
    shutil.copytree(gate_library, zim_dir)
    env = clean_env()
    env.pop("ZIMI_CREATE_ROOT", None)
    with boot(
        zim_dir=zim_dir, data_dir=os.path.join(str(root), "data"), env=env
    ) as server:
        status, body = server.get_json("/manage/create/browse?path=/")
        assert status == 410, f"the retired picker endpoint answered: {body}"
        # Both server-path modes are CLI-only: refused with the CLI pointer, not
        # a root complaint — the server never reaches the filesystem at all.
        for mode, door in (("import", "zimi import"), ("folder", "zimi create")):
            for endpoint in ("/manage/create", "/manage/create/probe"):
                status, body = server.post_json(
                    endpoint, {"mode": mode, "source": __file__}
                )
                assert status == 400, f"{endpoint} took {mode} with no root: {body}"
                assert "CLI" in body.get("error", ""), body
                assert door in body.get("error", ""), body
        # …and the URL modes, which read nothing local, are unaffected.
        status, body = server.post_json(
            "/manage/create/probe", {"mode": "page", "source": "nonsense"}
        )
        assert status == 400, body


def test_a_finished_job_is_findable_after_the_fact(gate_server):
    """An admin who closed the tab and came back must be able to find out what
    happened. The job log survives the job; if this breaks, the answer to "did
    my capture finish?" goes back to being "look at the library and guess"."""
    status, state = gate_server.get_json("/manage/create/status?history=1")
    assert status == 200, state
    history = state.get("history")
    assert isinstance(history, list) and history, f"no job history at all: {state}"
    mine = [record for record in history if record.get("title") == "Gate Field Notes"]
    assert mine, f"the finished job is missing from the history: {history}"
    assert mine[0]["state"] == "ok", mine[0]
    assert mine[0]["mode"] == "page"
    assert mine[0]["result"], f"the history does not name what was created: {mine[0]}"


def test_a_second_submission_queues_and_can_be_dropped(gate_server, source_site):
    """Two submissions are a plan, not a mistake. The queue is what makes the
    Create page usable by somebody who knows what they want to build."""
    first = gate_server.post_json(
        "/manage/create", {"mode": "page", "source": source_site, "title": "Q1"}
    )
    assert first[0] == 200, first
    second_status, second = gate_server.post_json(
        "/manage/create", {"mode": "page", "source": source_site, "title": "Q2"}
    )
    assert second_status == 200, second
    # The first job may already have finished — a one-page capture from
    # localhost is quick — so either answer is correct, and both must be
    # honest about which.
    if second.get("status") == "queued":
        assert second["position"] == 1
        dropped_status, dropped = gate_server.post_json(
            "/manage/create/cancel", {"id": second["id"]}
        )
        assert dropped_status == 200, dropped
        assert dropped["status"] == "dequeued"
    else:
        assert second["status"] == "started", second
    state = gate_server.poll_json(
        "/manage/create/status",
        lambda s: s.get("done") is True and not s.get("queue"),
        timeout=CREATE_TIMEOUT_SEC,
    )
    assert state.get("queue") == [], state


def test_the_progress_stream_carries_structured_events(gate_server, source_site):
    """The Create page draws its progress from these, not from the log text.
    An empty or malformed stream means a progress view that cannot move."""
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "page", "source": source_site, "title": "Gate Events"},
    )
    assert status == 200, body
    state = gate_server.poll_json(
        "/manage/create/status?events_since=0",
        lambda s: s.get("done") is True,
        timeout=CREATE_TIMEOUT_SEC,
    )
    events = state.get("events")
    assert isinstance(events, list) and events, f"no structured events: {state}"
    assert [event["i"] for event in events] == list(range(len(events)))
    assert all(event["t"] in ("phase", "node", "count") for event in events), events
    phases = [event["phase"] for event in events if event["t"] == "phase"]
    assert phases[-1] == "done", phases
    assert state["event_cursor"] == len(events)


def test_the_created_zim_carries_its_provenance(gate_server):
    """Every ZIM Zimi writes says who made it. A reader that trusts a ZIM's
    origin needs that metadata present, not just intended."""
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, "run after the creation check — nothing was created"
    # Web creations land on the Created shelf (<zim_dir>/created), not in the
    # library root; /list carries the bare filename either way.
    path = os.path.join(gate_server.zim_dir, "created", created[0]["file"])
    assert os.path.exists(path), path

    archive = Archive(path)
    scraper = bytes(archive.get_metadata("Scraper")).decode("utf-8", "replace")
    assert "zimi" in scraper.lower(), f"no Zimi provenance in Scraper: {scraper!r}"
