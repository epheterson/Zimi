"""Making a ZIM: point Zimi at a folder and get a served source out of it."""

import os

import pytest

from fixtures_zim import build_source_folder
from conftest import quote

pytestmark = pytest.mark.gate("ZIM creation from a folder")

CREATE_TIMEOUT_SEC = 180


@pytest.fixture(scope="module")
def source_folder(tmp_path_factory):
    return build_source_folder(str(tmp_path_factory.mktemp("gate-source")))


def test_probe_describes_the_folder_before_committing(gate_server, source_folder):
    """The Create page shows you what you are about to get. If the probe lies or
    breaks, every creation becomes a leap of faith."""
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "folder", "source": source_folder}
    )
    assert status == 200, body
    assert body.get("ok") is True, f"probe refused a plain readable folder: {body}"
    assert body["mode"] == "folder"
    assert body["files"] == 3, f"probe miscounted the folder: {body}"
    assert body["bytes"] > 0
    assert body["main"] == "index.html", f"probe picked the wrong main page: {body}"


def test_probe_refuses_a_path_that_is_not_a_folder(gate_server, tmp_path):
    missing = str(tmp_path / "there-is-nothing-here")
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "folder", "source": missing}
    )
    assert status == 400, body
    assert "error" in body


def test_a_folder_becomes_a_zim_that_serves(gate_server, source_folder):
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "folder", "source": source_folder, "title": "Gate Field Notes"},
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
    gate_library, tmp_path_factory, source_folder
):
    """The default posture, booted for real. Eric's objection to the round-2
    folder flow was that it showed him the whole file system; the answer is
    that with no ZIMI_CREATE_ROOT the web cannot list a directory or package a
    server path at all. A client that hides the chip is not the boundary —
    this is, so it is checked against a server that never had one."""
    import os
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
        assert status == 403, f"the picker listed a directory with no root set: {body}"
        for mode, source in (("folder", source_folder), ("import", __file__)):
            status, body = server.post_json(
                "/manage/create", {"mode": mode, "source": source}
            )
            assert status == 403, f"{mode} capture ran with no root set: {body}"
            status, body = server.post_json(
                "/manage/create/probe", {"mode": mode, "source": source}
            )
            assert status == 403, f"{mode} probe read the filesystem: {body}"
        # …and the URL modes, which read nothing local, are unaffected.
        status, body = server.post_json(
            "/manage/create/probe", {"mode": "page", "source": "nonsense"}
        )
        assert status == 400, body


def test_a_finished_job_is_findable_after_the_fact(gate_server, source_folder):
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
    assert mine[0]["mode"] == "folder"
    assert mine[0]["result"], f"the history does not name what was created: {mine[0]}"


def test_a_second_submission_queues_and_can_be_dropped(gate_server, source_folder):
    """Two submissions are a plan, not a mistake. The queue is what makes the
    Create page usable by somebody who knows what they want to build."""
    first = gate_server.post_json(
        "/manage/create", {"mode": "folder", "source": source_folder, "title": "Q1"}
    )
    assert first[0] == 200, first
    second_status, second = gate_server.post_json(
        "/manage/create", {"mode": "folder", "source": source_folder, "title": "Q2"}
    )
    assert second_status == 200, second
    # The first job may already have finished — a folder capture this small is
    # quick — so either answer is correct, and both must be honest about which.
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


def test_the_progress_stream_carries_structured_events(gate_server, source_folder):
    """The Create page draws its progress from these, not from the log text.
    An empty or malformed stream means a progress view that cannot move."""
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "folder", "source": source_folder, "title": "Gate Events"},
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


def test_the_created_zim_carries_its_provenance(gate_server, source_folder, tmp_path):
    """Every ZIM Zimi writes says who made it. A reader that trusts a ZIM's
    origin needs that metadata present, not just intended."""
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, "run after the creation check — nothing was created"
    path = os.path.join(gate_server.zim_dir, created[0]["file"])
    assert os.path.exists(path), path

    archive = Archive(path)
    scraper = bytes(archive.get_metadata("Scraper")).decode("utf-8", "replace")
    assert "zimi" in scraper.lower(), f"no Zimi provenance in Scraper: {scraper!r}"
