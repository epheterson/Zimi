"""The /manage/create routes: auth, validation, the single-job rule, and the
cursor contract the progress pane polls.

The engines themselves are exercised by test_creator_*.py / test_importer.py;
here they are stubbed so the tests stay about the ROUTES — who may call them,
what they refuse, and whether the job model reports honestly.
"""

import os
import sys
import time
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


class _Handler:
    """Minimal ZimHandler stand-in: privacy + captured JSON response."""

    def __init__(self, private=True, headers=None):
        self.status = None
        # A dict from the start, not None: every assertion below reads it as
        # one, and a route that answered nothing should fail on a missing key
        # rather than on the shape of the recorder.
        self.body: dict = {}
        self.headers = headers or {}
        self._private = private

    def _json(self, status, body):
        self.status = status
        self.body = body

    def _is_private_client(self):
        return self._private


def _post(path, data, private=True):
    h = _Handler(private=private)
    manage.handle_manage_post(h, urlparse(path), data)
    return h


def _get(path, private=True, params=None):
    """``params`` is written here as plain strings and wrapped the way
    ``urllib.parse.parse_qs`` delivers a real query string. The route reads
    ``params[key][0]``, so a bare string would hand it the first CHARACTER —
    a cursor of "10" would arrive as 1 and quietly replay nine events."""
    h = _Handler(private=private)
    query = {
        key: (value if isinstance(value, list) else [value])
        for key, value in (params or {}).items()
    }
    manage.handle_manage_get(h, urlparse(path), query)
    return h


def _wait_done(tries=400):
    for _ in range(tries):
        body = _get("/manage/create/status").body
        if body.get("done") or not body.get("active"):
            return body
        time.sleep(0.01)
    raise AssertionError("creation job never finished")


@pytest.fixture(autouse=True)
def clean_job(tmp_path, monkeypatch):
    """Every test starts with no job, no queue and an empty journal, and leaves
    none behind. The journal is redirected into the test's own tmp dir: it is
    the one piece of job state that outlives the process, and a test suite that
    wrote it to the real data dir would be scribbling on a running server's."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "data").mkdir()
    # The server-path mode (import) needs an operator-configured root or it is
    # refused outright (see test_create_probe.py for the gate itself). Every
    # import test here builds its source under tmp_path, so that is the root.
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(tmp_path))
    manage._create_job = None
    manage._create_queue.clear()
    manage._create_journal = None
    yield
    manage._create_queue.clear()
    job = manage._create_job
    if job is not None and not job.done:
        job.cancel_requested = True
        for _ in range(200):
            if job.done:
                break
            time.sleep(0.01)
    manage._create_job = None
    manage._create_journal = None


@pytest.fixture
def stub_engine(monkeypatch):
    """Replace the engine dispatch with something scriptable. Returns a dict
    the test fills in: ``lines`` to emit, ``result`` to return, ``raise_``."""
    script = {"lines": [], "result": {"path": "/zims/made.zim", "registered": True}}

    def fake_run(job, opts):
        script["opts"] = opts
        for line in script["lines"]:
            job.note(line)
            time.sleep(0.005)
        if script.get("raise_"):
            raise script["raise_"]
        return script["result"]

    monkeypatch.setattr(manage, "_create_run", fake_run)
    return script


# ── auth ────────────────────────────────────────────────────────────────────


def test_all_three_routes_require_admin(monkeypatch):
    """A non-private client on a passwordless instance is public_locked, and a
    wrong credential on a protected one is unauthorized — for every route."""
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "")
    for path, call in (
        ("/manage/create", lambda: _post("/manage/create", {}, private=False)),
        (
            "/manage/create/cancel",
            lambda: _post("/manage/create/cancel", {}, private=False),
        ),
        (
            "/manage/create/status",
            lambda: _get("/manage/create/status", private=False),
        ),
    ):
        h = call()
        assert h.status == 403, path
        assert h.body["error"] == "public_locked", path

    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "deadbeef$cafe")
    for path, call in (
        ("/manage/create", lambda: _post("/manage/create", {}, private=True)),
        (
            "/manage/create/cancel",
            lambda: _post("/manage/create/cancel", {}, private=True),
        ),
        (
            "/manage/create/status",
            lambda: _get("/manage/create/status", private=True),
        ),
    ):
        h = call()
        assert h.status == 401, path
        assert h.body["needs_password"] is True, path


# ── validation ──────────────────────────────────────────────────────────────


def test_unknown_mode_and_missing_source_are_refused():
    assert _post("/manage/create", {"mode": "wat", "source": "/tmp"}).status == 400
    assert _post("/manage/create", {"mode": "folder", "source": ""}).status == 400
    assert _post("/manage/create", {}).status == 400


def test_folder_mode_is_cli_only_and_the_refusal_says_so(tmp_path):
    """Round 3, Eric: "do remove folder I said that would be CLI only." The
    refusal names the door that is still open, and it does not depend on the
    directory existing — the mode is gone, not misconfigured."""
    (tmp_path / "src").mkdir()
    for source in (str(tmp_path / "src"), str(tmp_path / "nope")):
        h = _post("/manage/create", {"mode": "folder", "source": source})
        assert h.status == 400, source
        assert "CLI-only" in h.body["error"], source
        assert "zimi create" in h.body["error"], source


def test_import_mode_normalizes_the_path(tmp_path, stub_engine):
    """A traversal-shaped path is resolved before use, so what runs is the real
    file — and what the status reports is that same resolved path."""
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "cap.wacz").write_bytes(b"x")
    messy = str(tmp_path / "docs" / ".." / "docs" / "." / "cap.wacz")
    assert _post("/manage/create", {"mode": "import", "source": messy}).status == 200
    _wait_done()
    assert _get("/manage/create/status").body["source"] == os.path.realpath(
        str(tmp_path / "docs" / "cap.wacz")
    )


def test_import_mode_requires_an_existing_file(tmp_path):
    assert (
        _post("/manage/create", {"mode": "import", "source": str(tmp_path)}).status
        == 400
    )


def test_url_modes_reject_non_http_schemes():
    for bad in (
        "file:///etc/passwd",
        "ftp://example.org/x",
        "javascript:alert(1)",
        "//example.org",
    ):
        for mode in ("page", "site", "video"):
            h = _post("/manage/create", {"mode": mode, "source": bad})
            assert h.status == 400, (mode, bad)


def test_option_clamping_keeps_absurd_numbers_out_of_the_engine(stub_engine):
    _post(
        "/manage/create",
        {"mode": "site", "source": "https://example.org/", "max_pages": 10**9},
    )
    _wait_done()
    assert stub_engine["opts"]["max_pages"] == manage.CREATE_MAX_PAGES_CEILING

    manage._create_job = None
    _post(
        "/manage/create",
        {
            "mode": "video",
            "source": "https://example.org/list",
            "limit": "not a number",
            "audio_only": 1,
        },
    )
    _wait_done()
    assert stub_engine["opts"]["limit"] is None
    assert stub_engine["opts"]["audio_only"] is True


def test_an_overlong_source_is_refused():
    """Page mode's whole-field ceiling is the URL cap times a URL, so a single
    absurd line has to be caught per-address rather than by the total."""
    one_huge = _post(
        "/manage/create", {"mode": "page", "source": "https://e.org/" + "a" * 4000}
    )
    assert one_huge.status == 400
    assert (
        _post(
            "/manage/create", {"mode": "site", "source": "https://e.org/" + "a" * 4000}
        ).status
        == 400
    )
    whole_field = _post(
        "/manage/create",
        {"mode": "page", "source": "\n".join(["https://e.org/x"] * 100000)},
    )
    assert whole_field.status == 400


# ── advanced options ────────────────────────────────────────────────────────


def test_advanced_site_options_reach_the_engine(stub_engine):
    """Depth, budget, delay and the robots override are all real crawl bounds,
    so they have to arrive as the typed values the crawler expects."""
    _post(
        "/manage/create",
        {
            "mode": "site",
            "source": "https://example.org/",
            "max_depth": "2",
            "max_bytes": "2G",
            "delay": "1.5",
            "language": "FRA",
            "ignore_robots": True,
        },
    )
    _wait_done()
    opts = stub_engine["opts"]
    assert opts["max_depth"] == 2
    assert opts["max_bytes"] == 2 * 1024**3
    assert opts["delay"] == 1.5
    assert opts["ignore_robots"] is True
    # Case is the admin's business; the metadata field is lowercase.
    assert opts["language"] == "fra"


def test_a_size_budget_that_is_not_a_size_is_refused_with_the_reason():
    """The refusal names what was typed and what would work — the same sentence
    the CLI gives, because it is the same parser."""
    h = _post(
        "/manage/create",
        {"mode": "site", "source": "https://example.org/", "max_bytes": "banana"},
    )
    assert h.status == 400
    assert "banana" in h.body["error"]
    assert "512MiB" in h.body["error"]

    # And nothing absurd gets through by being long instead of malformed.
    h = _post(
        "/manage/create",
        {"mode": "site", "source": "https://example.org/", "max_bytes": "9" * 40},
    )
    assert h.status == 400


def test_a_huge_size_budget_is_clamped_not_refused(stub_engine):
    _post(
        "/manage/create",
        {"mode": "site", "source": "https://example.org/", "max_bytes": "500T"},
    )
    _wait_done()
    assert stub_engine["opts"]["max_bytes"] == manage.CREATE_MAX_BYTES_CEILING


def test_out_of_range_depth_and_delay_clamp(stub_engine):
    _post(
        "/manage/create",
        {
            "mode": "site",
            "source": "https://example.org/",
            "max_depth": 999,
            "delay": "1e9",
        },
    )
    _wait_done()
    assert stub_engine["opts"]["max_depth"] == manage.CREATE_MAX_DEPTH_CEILING
    assert stub_engine["opts"]["delay"] == manage.CREATE_MAX_DELAY


def test_the_ignore_robots_flag_is_a_bool_not_the_string_the_form_sent(stub_engine):
    for sent, expected in ((True, True), ("", False), (None, False)):
        manage._create_job = None
        _post(
            "/manage/create",
            {
                "mode": "site",
                "source": "https://example.org/",
                "ignore_robots": sent,
            },
        )
        _wait_done()
        assert stub_engine["opts"]["ignore_robots"] is expected


def test_only_named_video_presets_are_accepted(stub_engine):
    """yt-dlp's format argument is an expression language. A named preset is the
    only thing the web form may ask for — the full selector stays on the CLI,
    where the person typing it is already at a shell on this machine."""
    for arbitrary in (
        "bestvideo+bestaudio",
        "best[height<=2160]",
        "worst",
        "720P",
        "; rm -rf /",
    ):
        h = _post(
            "/manage/create",
            {"mode": "video", "source": "https://example.org/l", "format": arbitrary},
        )
        assert h.status == 400, arbitrary
        assert "yt-dlp" not in h.body["error"]

    _post(
        "/manage/create",
        {"mode": "video", "source": "https://example.org/l", "format": "1080p"},
    )
    _wait_done()
    assert stub_engine["opts"]["fmt"] == manage.CREATE_VIDEO_FORMATS["1080p"]


def test_the_default_preset_defers_to_the_engine(stub_engine):
    """720p is what the engine already does, so asking for it says nothing —
    the option is left out rather than restating the default in a second place
    that could drift from the first."""
    _post(
        "/manage/create",
        {"mode": "video", "source": "https://example.org/l", "format": "720p"},
    )
    _wait_done()
    assert stub_engine["opts"]["fmt"] is None


def test_audio_only_drops_the_quality_preset(stub_engine):
    _post(
        "/manage/create",
        {
            "mode": "video",
            "source": "https://example.org/l",
            "format": "1080p",
            "audio_only": True,
        },
    )
    _wait_done()
    assert stub_engine["opts"]["fmt"] is None
    assert stub_engine["opts"]["audio_only"] is True


def test_a_language_must_look_like_a_language_code():
    for bad in ("english", "e", "fr-FR", "../..", "eng eng"):
        h = _post(
            "/manage/create",
            {"mode": "site", "source": "https://example.org/", "language": bad},
        )
        assert h.status == 400, bad
        assert "code" in h.body["error"]


def test_an_import_name_cannot_walk_out_of_the_zim_directory(tmp_path):
    """The name becomes a filename joined onto the ZIM directory. It is checked
    against a charset rather than cleaned up, so a name that would need
    sanitising is refused and retyped instead of quietly becoming another one."""
    archive = tmp_path / "cap.wacz"
    archive.write_bytes(b"x")
    for bad in ("../../etc/passwd", "a/b", ".hidden", "name with spaces", "x" * 200):
        h = _post(
            "/manage/create",
            {"mode": "import", "source": str(archive), "name": bad},
        )
        assert h.status == 400, bad


def test_a_good_import_name_reaches_the_engine(tmp_path, stub_engine):
    archive = tmp_path / "cap.wacz"
    archive.write_bytes(b"x")
    _post(
        "/manage/create",
        {"mode": "import", "source": str(archive), "name": "field-notes_2026.v2"},
    )
    _wait_done()
    assert stub_engine["opts"]["name"] == "field-notes_2026.v2"


def test_unset_options_never_reach_the_engine_as_none(monkeypatch):
    """Every engine defaults these itself. Passing None would override a real
    default with nothing, so an option nobody set must not appear at all."""
    seen = {}

    def fake_site(url, **kwargs):
        seen.update(kwargs)
        return {"path": "/zims/x.zim", "registered": True}

    from zimi import crawler

    monkeypatch.setattr(crawler, "create_site_zim", fake_site)
    _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    _wait_done()
    assert "max_depth" not in seen
    assert "max_bytes" not in seen
    assert "language" not in seen
    # The one option that IS always sent: a False override is a real answer.
    assert seen["ignore_robots"] is False


def test_set_options_arrive_as_engine_keywords(monkeypatch):
    """The other half of the same contract: what the admin did set has to land
    under the keyword the engine actually reads."""
    seen = {}

    def fake_site(url, **kwargs):
        seen.update(kwargs)
        return {"path": "/zims/x.zim", "registered": True}

    from zimi import crawler

    monkeypatch.setattr(crawler, "create_site_zim", fake_site)
    _post(
        "/manage/create",
        {
            "mode": "site",
            "source": "https://example.org/",
            "max_pages": 12,
            "max_depth": 1,
            "max_bytes": "10M",
            "delay": 0.25,
            "language": "spa",
            "ignore_robots": True,
        },
    )
    _wait_done()
    assert seen["max_pages"] == 12
    assert seen["max_depth"] == 1
    assert seen["max_bytes"] == 10 * 1024**2
    assert seen["delay"] == 0.25
    assert seen["language"] == "spa"
    assert seen["ignore_robots"] is True


def test_the_video_preset_arrives_as_the_engines_fmt_keyword(monkeypatch):
    seen = {}

    def fake_video(url, **kwargs):
        seen.update(kwargs)
        return {"path": "/zims/v.zim", "registered": True}

    from zimi import video

    monkeypatch.setattr(video, "create_video_zim", fake_video)
    _post(
        "/manage/create",
        {
            "mode": "video",
            "source": "https://example.org/l",
            "format": "480p",
            "max_bytes": "1G",
        },
    )
    _wait_done()
    assert seen["fmt"] == manage.CREATE_VIDEO_FORMATS["480p"]
    assert seen["max_bytes"] == 1024**3


# ── one job at a time ───────────────────────────────────────────────────────


def test_a_second_job_queues_behind_the_first(monkeypatch, tmp_path):
    """Round 3 replaced the 409 with a queue: submitting twice is what people
    do, and the second submission is a plan, not a mistake."""
    gate = {"go": False}

    def slow_run(job, opts):
        while not gate["go"]:
            time.sleep(0.005)
        return {"path": str(tmp_path / "x.zim"), "registered": True}

    monkeypatch.setattr(manage, "_create_run", slow_run)
    first = _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    assert first.status == 200
    assert first.body["status"] == "started"

    second = _post("/manage/create", {"mode": "page", "source": "https://example.org/"})
    assert second.status == 200
    assert second.body["status"] == "queued"
    assert second.body["position"] == 1
    assert second.body["running"]["mode"] == "site"

    # And the queue is visible to anyone polling, not just to whoever filed it.
    status = _get("/manage/create/status").body
    assert [entry["mode"] for entry in status["queue"]] == ["page"]

    gate["go"] = True
    # The queued job takes the slot by itself, with no second submission.
    for _ in range(400):
        body = _get("/manage/create/status").body
        if body.get("mode") == "page":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("the queued job never started")
    assert _get("/manage/create/status").body["queue"] == []


# ── status + cursor contract ────────────────────────────────────────────────


def test_status_with_no_job_is_inert():
    body = _get("/manage/create/status").body
    assert body["active"] is False
    assert body["done"] is False
    assert body["lines"] == []
    assert body["cursor"] == 0
    assert "import_ready" not in body


def test_probe_adds_the_sidecar_answer_only_when_asked():
    body = _get("/manage/create/status", params={"probe": ["1"]}).body
    assert isinstance(body["import_ready"], bool)
    assert isinstance(body["offline"], bool)


def test_cursor_delivers_each_line_exactly_once(stub_engine):
    stub_engine["lines"] = ["one", "two", "three"]
    _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    _wait_done()

    first = _get("/manage/create/status", params={"since": ["0"]}).body
    # "done" is appended by the worker after a successful run.
    assert first["lines"][:3] == ["one", "two", "three"]
    assert first["cursor"] == len(first["lines"])

    again = _get("/manage/create/status", params={"since": [str(first["cursor"])]}).body
    assert again["lines"] == []
    assert again["cursor"] == first["cursor"]


def test_the_line_buffer_is_bounded(stub_engine):
    stub_engine["lines"] = [f"line {i}" for i in range(manage.CREATE_LOG_LINES + 50)]
    _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    _wait_done()
    body = _get("/manage/create/status", params={"since": ["0"]}).body
    assert len(body["lines"]) == manage.CREATE_LOG_LINES
    # A cursor older than the buffer snaps forward instead of replaying wrong.
    assert body["cursor"] > manage.CREATE_LOG_LINES
    assert body["lines"][-1] == "done"


def test_success_reports_the_new_zims_library_name(stub_engine, tmp_path):
    stub_engine["result"] = {"path": str(tmp_path / "my_notes.zim"), "registered": True}
    _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    body = _wait_done()
    assert body["ok"] is True
    assert body["result"]["name"] == "my_notes"
    assert body["result"]["registered"] is True


# ── failures ────────────────────────────────────────────────────────────────


def test_a_create_error_reaches_the_client_verbatim(stub_engine):
    """The SPA refusal and the yt-dlp hint are the whole point of CreateError:
    they name the fix, so they must not be flattened into a generic message."""
    from zimi.creator import SPA_REFUSAL, CreateError

    stub_engine["raise_"] = CreateError(SPA_REFUSAL)
    _post("/manage/create", {"mode": "page", "source": "https://example.org/app"})
    body = _wait_done()
    assert body["ok"] is False
    assert body["error"] == SPA_REFUSAL
    assert "zimit" in body["error"]


def test_an_unexpected_exception_is_generic(stub_engine):
    stub_engine["raise_"] = RuntimeError("/secret/internal/path blew up")
    _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    body = _wait_done()
    assert body["ok"] is False
    assert "secret" not in body["error"]
    assert body["error"] == "creation failed — see the server log for details"


def test_offline_refusal_from_the_engine_is_surfaced(monkeypatch, tmp_path):
    """ZIMI_OFFLINE is enforced by the engines, and the status reports it so
    the UI can stop offering what cannot work."""
    from zimi import p2p

    monkeypatch.setattr(p2p, "is_offline", lambda: True)
    assert _get("/manage/create/status").body["offline"] is True

    server_dir = tmp_path / "zims"
    server_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(server_dir))
    _post("/manage/create", {"mode": "page", "source": "https://example.org/a"})
    body = _wait_done()
    assert body["ok"] is False
    assert "ZIMI_OFFLINE" in body["error"]


# ── cancel ──────────────────────────────────────────────────────────────────


def test_cancel_with_no_job_is_409():
    h = _post("/manage/create/cancel", {})
    assert h.status == 409


def test_cancel_stops_a_streaming_job_and_says_nothing_was_added(monkeypatch):
    def long_run(job, opts):
        for i in range(10000):
            job.note(f"page {i}")  # raises once cancel is requested
            time.sleep(0.002)
        return {"path": "/never.zim"}

    monkeypatch.setattr(manage, "_create_run", long_run)
    _post("/manage/create", {"mode": "site", "source": "https://example.org/"})
    for _ in range(200):
        if _get("/manage/create/status").body["lines"]:
            break
        time.sleep(0.01)
    h = _post("/manage/create/cancel", {})
    assert h.status == 200
    assert h.body["cancellable"] is True
    body = _wait_done()
    assert body["cancelled"] is True
    assert body["ok"] is False
    assert "nothing was added" in body["error"]


def test_every_mode_with_a_progress_callback_is_cancellable(monkeypatch, tmp_path):
    """The two lists have to agree: a mode is cancellable exactly when its
    engine takes a progress sink, because that callback IS the cancel."""
    gate = {"go": False}

    def slow_run(job, opts):
        while not gate["go"]:
            time.sleep(0.005)
        return {"path": str(tmp_path / "x.zim")}

    monkeypatch.setattr(manage, "_create_run", slow_run)
    for mode, source in (
        ("page", "https://example.org/a"),
        ("site", "https://example.org/"),
        ("video", "https://example.org/list"),
    ):
        manage._create_job = None
        _post("/manage/create", {"mode": mode, "source": source})
        assert _get("/manage/create/status").body["cancellable"] is True, mode
    gate["go"] = True
    _wait_done()


def test_server_path_mode_needs_the_primary_admin(monkeypatch, tmp_path, stub_engine):
    """Import reads arbitrary server paths — that power stays with the primary
    admin. Secondary admins keep the URL modes. Folder is not a permissions
    question any more: the web refuses the mode for everyone."""
    monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: False)
    f = tmp_path / "a.wacz"
    f.write_bytes(b"x")
    r = _post("/manage/create", {"mode": "import", "source": str(f)})
    assert r.status == 403
    # Folder answers with the CLI pointer, not with the tier gate: 400 for the
    # primary admin and everyone else alike.
    r = _post("/manage/create", {"mode": "folder", "source": str(tmp_path)})
    assert r.status == 400
    assert "CLI-only" in r.body["error"]
    # URL modes stay open to any authorized admin — invalid scheme still 400s,
    # proving the request reached validation rather than the tier gate.
    r = _post("/manage/create", {"mode": "page", "source": "ftp://nope"})
    assert r.status == 400

    monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: True)
    r = _post("/manage/create", {"mode": "import", "source": str(f)})
    assert r.status == 200
