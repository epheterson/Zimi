"""The activity journal: one line per thing that happened, and who did it.

The old history recorded downloads and deletes with no actor, the create
journal recorded creation runs the Create page could read, and health checks
and exports recorded nothing that survived a restart. This is the one journal
behind the Activity view, so the tests here are about the three things that
make it trustworthy:

  the record      bounded, atomic, and soft — an unwritable journal costs a
                  log line, never the operation it was describing
  the actor       a user has a name, the primary admin is "admin", and work
                  nobody asked for in the moment belongs to the server
  the stamps      they fire from the REAL paths (download, delete, create,
                  export, health, restore), with the engines mocked out

The route-level auth contract lives in test_create_routes.py / test_auth_*;
its handler helpers are reused here rather than copied.
"""

import json
import os
import sys
import time
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402
from tests.test_create_routes import _Handler, _get, _post  # noqa: E402


@pytest.fixture(autouse=True)
def clean_journal(tmp_path, monkeypatch):
    """Every test starts with an empty journal in its own data dir. The journal
    is the one piece of this state that outlives a process, so a suite that
    wrote it to the real data dir would be scribbling on a running server's."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setattr(manage, "_activity", None)
    yield data
    manage._activity = None


def _records(**kw):
    return manage.activity_payload(**kw)["records"]


def _write_history(events):
    path = os.path.join(server.ZIMI_DATA_DIR, "history.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(events, fh)


# ── the record ──────────────────────────────────────────────────────────────


def test_record_round_trips_through_disk():
    manage.record_activity("delete", "Wikipedia", detail="gone", size_bytes=1024)
    manage._activity = None  # forget the in-process copy; read it back
    (record,) = _records()
    assert record["type"] == "delete"
    assert record["subject"] == "Wikipedia"
    assert record["outcome"] == "ok"
    assert record["detail"] == "gone"
    assert record["bytes"] == 1024
    assert record["ts"] > 0


def test_newest_first_and_bounded():
    for i in range(manage.ACTIVITY_RECORDS + 25):
        manage.record_activity("download", f"zim-{i}")
    records = _records()
    assert len(records) == manage.ACTIVITY_RECORDS
    # Newest first, and the oldest 25 fell off the front.
    assert records[0]["subject"] == f"zim-{manage.ACTIVITY_RECORDS + 24}"
    assert records[-1]["subject"] == "zim-25"


def test_oversized_journal_on_disk_is_trimmed_on_load():
    """The bound is what the file is allowed to BE, not merely what this
    process appends to it — an older build or a hand edit must not be served
    (or rewritten) at that size."""
    fat = [
        manage._activity_record("download", f"zim-{i}")
        for i in range(manage.ACTIVITY_RECORDS + 40)
    ]
    server._atomic_write_json(manage._activity_path(), fat)
    assert len(_records()) == manage.ACTIVITY_RECORDS
    with open(manage._activity_path(), encoding="utf-8") as fh:
        assert len(json.load(fh)) == manage.ACTIVITY_RECORDS


def test_unwritable_journal_never_raises(monkeypatch):
    """A journal that cannot be written costs a log line, never the operation
    that was being described."""
    monkeypatch.setattr(
        server, "ZIMI_DATA_DIR", os.path.join(server.ZIMI_DATA_DIR, "nope", "deeper")
    )
    manage._activity = None
    assert manage.record_activity("delete", "Wikipedia") is not None
    # The line survives in memory for as long as this process does, which is
    # the most an unwritable disk allows; nothing was created on it.
    assert len(_records()) == 1
    assert not os.path.exists(manage._activity_path())


def test_corrupt_journal_degrades_to_empty():
    with open(manage._activity_path(), "w", encoding="utf-8") as fh:
        fh.write("{not json")
    assert _records() == []
    manage.record_activity("delete", "Wikipedia")
    assert len(_records()) == 1


def test_long_fields_are_clamped():
    record = manage.record_activity("create", "s" * 500, detail="d" * 500)
    assert len(record["subject"]) == manage.ACTIVITY_SUBJECT_MAX
    assert len(record["detail"]) == manage.ACTIVITY_DETAIL_MAX


def test_unknown_outcome_falls_back_to_ok():
    assert manage.record_activity("delete", "x", outcome="weird")["outcome"] == "ok"


# ── the actor ───────────────────────────────────────────────────────────────


def test_actor_is_the_signed_in_user(monkeypatch):
    from zimi import users

    monkeypatch.setattr(users, "resolve_request_user", lambda handler: "priya")
    assert manage.activity_actor(_Handler()) == {"kind": "user", "name": "priya"}


def test_actor_is_admin_when_the_request_has_no_user_session(monkeypatch):
    """The primary admin authenticates with a password, not a user record, so
    there is no username to borrow — but somebody did press the button."""
    from zimi import users

    monkeypatch.setattr(users, "resolve_request_user", lambda handler: None)
    assert manage.activity_actor(_Handler()) == {"kind": "user", "name": "admin"}


def test_actor_is_the_server_when_there_is_no_request():
    assert manage.activity_actor() == {"kind": "server", "name": None}
    assert manage.activity_actor(None) == {"kind": "server", "name": None}


def test_actor_survives_an_unreadable_session_store(monkeypatch):
    from zimi import users

    def boom(handler):
        raise OSError("sessions.json is a directory")

    monkeypatch.setattr(users, "resolve_request_user", boom)
    assert manage.activity_actor(_Handler()) == {"kind": "user", "name": "admin"}


@pytest.mark.parametrize(
    "given,expected",
    [
        (None, {"kind": "server", "name": None}),
        ("eric", {"kind": "server", "name": None}),
        ({"kind": "user", "name": "  eric  "}, {"kind": "user", "name": "eric"}),
        ({"kind": "user", "name": ""}, {"kind": "user", "name": None}),
        ({"kind": "server", "name": "ignored"}, {"kind": "server", "name": None}),
        ({"kind": "unknown"}, {"kind": "unknown", "name": None}),
        ({"kind": "root"}, {"kind": "server", "name": None}),
    ],
)
def test_stored_actor_is_cleaned(given, expected):
    assert manage._activity_clean_actor(given) == expected


# ── the upgrade ─────────────────────────────────────────────────────────────


def test_journal_is_seeded_from_the_pre_19_history():
    """An upgrade must not look like data loss: everything the old history
    recorded is an activity record missing exactly one field."""
    _write_history(
        [
            {
                "event": "deleted",
                "ts": 300,
                "filename": "old_2024-01.zim",
                "title": "O",
            },
            {
                "event": "download_failed",
                "ts": 200,
                "filename": "bad_2024-01.zim",
                "error": "all mirrors failed",
            },
            {
                "event": "updated",
                "ts": 100,
                "filename": "wikipedia_en_all_2024-01.zim",
                "title": "Wikipedia",
                "size_bytes": 4096,
            },
            {"event": "searched", "ts": 50},  # not a library change — skipped
        ]
    )
    records = _records()
    assert [(r["type"], r["outcome"]) for r in records] == [
        ("delete", "ok"),
        ("download", "failed"),
        ("update", "ok"),
    ]
    assert records[0]["subject"] == "O"
    assert records[-1]["bytes"] == 4096
    # No actor was ever recorded, and a guess would be worse than saying so.
    assert {r["actor"]["kind"] for r in records} == {"unknown"}
    # Seeded once: the file now exists, so a later append does not re-seed.
    manage._activity = None
    manage.record_activity("delete", "Later")
    assert len(_records()) == 4


def test_seeding_is_capped_like_any_other_load():
    _write_history(
        [
            {"event": "download", "ts": float(i), "filename": f"z{i}.zim"}
            for i in range(manage.ACTIVITY_RECORDS + 30)
        ]
    )
    assert len(_records()) == manage.ACTIVITY_RECORDS


def test_no_history_means_an_empty_journal():
    assert _records() == []


# ── the filters ─────────────────────────────────────────────────────────────


def _seed_mixed():
    manage.record_activity("update", "Wikipedia", actor=None)  # the auto-updater
    manage.record_activity(
        "create", "Field Notes", actor={"kind": "user", "name": "eric"}
    )
    manage.record_activity("delete", "Old ZIM", actor={"kind": "user", "name": "admin"})
    manage.record_activity(
        "update", "Gutenberg", actor={"kind": "user", "name": "eric"}
    )


def test_type_and_actor_filters():
    _seed_mixed()
    assert [r["subject"] for r in _records(type_filter="update")] == [
        "Gutenberg",
        "Wikipedia",
    ]
    assert [r["subject"] for r in _records(actor_filter="eric")] == [
        "Gutenberg",
        "Field Notes",
    ]
    assert [r["subject"] for r in _records(actor_filter="server")] == ["Wikipedia"]
    assert [
        r["subject"] for r in _records(type_filter="update", actor_filter="eric")
    ] == ["Gutenberg"]


def test_the_filter_vocabulary_is_the_whole_journal_not_the_filtered_slice():
    """A filter whose own options vanish the moment you use one is a filter you
    cannot get back out of."""
    _seed_mixed()
    payload = manage.activity_payload(type_filter="create", actor_filter="eric")
    assert payload["types"] == ["create", "delete", "update"]
    assert payload["actors"] == ["admin", "eric", "server"]
    assert len(payload["records"]) == 1


def test_route_serves_the_journal():
    _seed_mixed()
    body = _get("/manage/activity-log").body
    assert [r["subject"] for r in body["records"]][0] == "Gutenberg"
    assert body["actors"] == ["admin", "eric", "server"]
    assert _get("/manage/activity-log", params={"type": "delete"}).body["records"] == [
        r for r in _records() if r["type"] == "delete"
    ]


def test_route_is_admin_gated(monkeypatch):
    """Same gate as the rest of /manage — the journal names people."""
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "pbkdf2$x$y")
    handler = _Handler(private=False)
    manage.handle_manage_get(handler, urlparse("/manage/activity-log"), {})
    assert handler.status == 401


def test_the_live_activity_poll_is_untouched():
    """/manage/activity is the topbar's "what is happening right now"; the
    journal is "what has happened". Two questions, two endpoints."""
    body = _get("/manage/activity").body
    assert set(body) >= {"indexing", "downloads", "seeding"}
    assert "records" not in body


# ── the stamps ──────────────────────────────────────────────────────────────


def test_delete_route_stamps_the_admin_who_pressed_it(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    victim = zim_dir / "old_2024-01.zim"
    victim.write_bytes(b"x" * 2048)
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "_zim_list_cache", [])
    monkeypatch.setattr(server, "unregister_zim_file", lambda name: True)
    monkeypatch.setattr(server, "_search_cache_clear", lambda: None)
    monkeypatch.setattr(server, "_suggest_cache_clear", lambda: None)
    monkeypatch.setattr(server, "_clean_stale_title_indexes", lambda: None)

    response = _post("/manage/delete", {"filename": "old_2024-01.zim"})
    assert response.status == 200
    (record,) = _records()
    assert record["type"] == "delete"
    assert record["subject"] == "old_2024-01.zim"
    assert record["bytes"] == 2048
    assert record["actor"] == {"kind": "user", "name": "admin"}


def test_download_carries_its_actor_to_the_finish_line(monkeypatch):
    """The stamp fires on a background thread minutes after the request that
    asked for it has gone, so the actor rides on the download record."""
    started = {}
    monkeypatch.setattr(library, "_enqueue_or_start", lambda dl: started.update(dl))
    monkeypatch.setattr(library, "_refuse_for_disk_space", lambda *a, **k: None)
    monkeypatch.setattr(library, "_persist_pending_downloads", lambda: None)
    library._start_download(
        "https://download.kiwix.org/zim/wikipedia_en_all_2026-01.zim",
        actor={"kind": "user", "name": "priya"},
    )
    assert started["_activity"] == {"actor": {"kind": "user", "name": "priya"}}

    library._record_download_activity(started, "ok")
    (record,) = _records()
    assert record["type"] == "download"
    assert record["actor"] == {"kind": "user", "name": "priya"}


@pytest.mark.parametrize(
    "dl,expected_type,expected_actor",
    [
        ({}, "download", {"kind": "server", "name": None}),
        ({"is_update": True}, "update", {"kind": "server", "name": None}),
        (
            {
                "is_update": True,
                "_activity": {"actor": {"kind": "user", "name": "eric"}},
            },
            "update",
            {"kind": "user", "name": "eric"},
        ),
        (
            {"_activity": {"actor": None, "type": "import"}},
            "import",
            {"kind": "server", "name": None},
        ),
    ],
)
def test_download_type_and_actor_matrix(dl, expected_type, expected_actor):
    """An auto-update and a person's update are the same transfer and different
    events — which is the whole point of the view."""
    library._record_download_activity({"filename": "wikipedia_en.zim", **dl}, "ok")
    (record,) = _records()
    assert record["type"] == expected_type
    assert record["actor"] == expected_actor


def test_finalize_stamps_from_the_real_download_path(tmp_path, monkeypatch):
    zim_dir = tmp_path / "zims"
    zim_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "_zim_list_cache", [])
    monkeypatch.setattr(server, "register_zim_file", lambda *a, **k: True)
    monkeypatch.setattr(server, "_search_cache_clear", lambda: None)
    monkeypatch.setattr(server, "_suggest_cache_clear", lambda: None)
    monkeypatch.setattr(server, "_clean_stale_title_indexes", lambda: None)
    monkeypatch.setattr(server, "_build_all_qid_indexes", lambda: None)
    monkeypatch.setattr(server, "_append_history", lambda event: None)

    library._post_download_finalize(
        {
            "filename": "wikipedia_en_all_2026-01.zim",
            "dest": str(zim_dir / "wikipedia_en_all_2026-01.zim"),
            "total_bytes": 4096,
            "is_update": True,
            "_activity": {"actor": {"kind": "user", "name": "eric"}},
        }
    )
    (record,) = _records()
    assert (record["type"], record["outcome"], record["bytes"]) == (
        "update",
        "ok",
        4096,
    )
    assert record["actor"]["name"] == "eric"
    # Privacy: subjects are library names and titles, never server paths.
    assert os.sep not in record["subject"]


def test_cancelling_a_download_is_its_own_outcome(monkeypatch):
    dl = {"id": "7", "filename": "gutenberg_en_all_2026-01.zim", "is_update": False}
    monkeypatch.setattr(library, "_active_downloads", {"7": dl})
    monkeypatch.setattr(library, "_persist_pending_downloads", lambda: None)
    assert _post("/manage/cancel", {"id": "7"}).status == 200
    (record,) = _records()
    assert record["outcome"] == "cancelled"
    assert record["actor"] == {"kind": "user", "name": "admin"}
    # Named the way a person would name it, not the way the file is spelled.
    assert record["subject"] == "Gutenberg En All"


def test_create_job_lands_in_the_journal_when_it_settles():
    job = manage._CreateJob("site", "https://example.com", "Field Notes")
    job.actor = {"kind": "user", "name": "eric"}
    manage._create_finish(
        job, ok=True, result={"name": "field_notes", "title": "Field Notes", "bytes": 9}
    )
    (record,) = _records()
    assert record["type"] == "create"
    assert record["subject"] == "Field Notes"
    assert record["outcome"] == "ok"
    assert record["detail"] == "https://example.com"
    assert record["actor"] == {"kind": "user", "name": "eric"}
    assert record["bytes"] == 9


@pytest.mark.parametrize(
    "outcome,expected",
    [
        ({"ok": True}, "ok"),
        ({"ok": False, "error": "the host never answered"}, "failed"),
        ({"cancelled": True}, "cancelled"),
        ({"stalled": True, "error": "no progress for 10 minutes"}, "failed"),
    ],
)
def test_create_outcomes_map_onto_journal_outcomes(outcome, expected):
    job = manage._CreateJob("site", "https://example.com", "Notes")
    manage._create_finish(job, **outcome)
    assert _records()[0]["outcome"] == expected


def test_a_job_the_server_lost_says_so(monkeypatch):
    """A create job still marked running at the next boot is an interrupted
    line in the activity view, not a ghost the operator has to guess about."""
    server._atomic_write_json(
        manage._create_journal_path(),
        [
            {
                "id": "abc",
                "mode": "site",
                "source": "https://example.com",
                "title": "Field Notes",
                "state": "running",
                "actor": {"kind": "user", "name": "eric"},
            }
        ],
    )
    monkeypatch.setattr(manage, "_create_journal", None)
    manage._create_history()
    (record,) = _records()
    assert record["type"] == "create"
    assert record["outcome"] == "interrupted"
    assert record["actor"] == {"kind": "user", "name": "eric"}
    # Recorded ONCE: the reconcile rewrote the state, so a reload is silent.
    manage._activity = None
    manage._create_journal = None
    manage._create_history()
    assert len(_records()) == 1


# ── the watched jobs (export, health) ───────────────────────────────────────


def _settle(state_fn, finish, tries=400):
    manage._activity_after(state_fn, finish)
    for _ in range(tries):
        if _records():
            return _records()[0]
        time.sleep(0.01)
    raise AssertionError("the watcher never filed a record")


@pytest.fixture(autouse=True)
def _fast_watch(monkeypatch):
    monkeypatch.setattr(manage, "ACTIVITY_WATCH_TICK", 0.01)


def test_export_is_journalled_when_the_writer_finishes():
    states = iter(
        [
            {"phase": "running"},
            {"phase": "running"},
            {"phase": "done", "files": ["my_bookmarks.zim"], "count": 12},
        ]
    )
    last = {"state": {"phase": "running"}}

    def state_fn():
        last["state"] = next(states, last["state"])
        return last["state"]

    record = _settle(
        state_fn, manage._activity_export_finish({"kind": "user", "name": "eric"}, 12)
    )
    assert (record["type"], record["outcome"]) == ("export", "ok")
    assert record["subject"] == "my_bookmarks"
    assert record["count"] == 12


def test_a_failed_export_is_journalled_as_failed():
    record = _settle(
        lambda: {"phase": "error", "error": "export failed", "files": []},
        manage._activity_export_finish(None, 3),
    )
    assert (record["type"], record["outcome"], record["detail"]) == (
        "export",
        "failed",
        "export failed",
    )


def test_health_check_records_what_it_found():
    record = _settle(
        lambda: {"phase": "done", "summary": {"total": 53, "healthy": 51}},
        manage._activity_health_finish({"kind": "user", "name": "admin"}),
    )
    assert (record["type"], record["outcome"], record["detail"]) == (
        "health",
        "ok",
        "51/53",
    )
    # The whole library, named on the client in the reader's language.
    assert record["subject"] == ""


def test_health_route_starts_a_watcher(monkeypatch):
    from zimi import health

    monkeypatch.setattr(health, "start_check", lambda: (True, "started"))
    monkeypatch.setattr(
        health,
        "get_state",
        lambda: {"phase": "done", "summary": {"total": 1, "healthy": 1}},
    )
    assert _post("/manage/health-check", {}).status == 200
    for _ in range(400):
        if _records():
            break
        time.sleep(0.01)
    assert _records()[0]["type"] == "health"


def test_a_refused_start_journals_nothing(monkeypatch):
    """Nothing started, so nothing happened — the running check owns that line
    and will file it when IT finishes."""
    from zimi import health

    monkeypatch.setattr(health, "start_check", lambda: (False, "already running"))
    monkeypatch.setattr(health, "get_state", lambda: {"phase": "done"})
    _post("/manage/health-check", {})
    time.sleep(0.05)
    assert _records() == []


def test_restore_is_journalled_with_what_it_applied(monkeypatch):
    monkeypatch.setattr(manage, "_persist_collections", lambda merged: None)
    response = _post(
        "/manage/backup",
        {
            "schema": manage._BACKUP_SCHEMA,
            "action": "apply",
            "collections": {"favorites": ["wikipedia"], "collections": {}},
        },
    )
    assert response.status == 200
    (record,) = _records()
    assert (record["type"], record["outcome"], record["count"]) == ("restore", "ok", 1)
    assert record["actor"] == {"kind": "user", "name": "admin"}


def test_a_rejected_restore_is_journalled_as_failed():
    response = _post("/manage/backup", {"action": "apply", "collections": "not-a-dict"})
    assert response.status == 400
    (record,) = _records()
    assert (record["type"], record["outcome"]) == ("restore", "failed")
