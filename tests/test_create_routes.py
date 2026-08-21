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


def test_import_mode_is_cli_only_and_the_refusal_says_so(tmp_path):
    """Eric, this round: "remove archive as well only in cli." Import followed
    folder off the web — the refusal names the CLI door, and (like folder) does
    not depend on the file existing: the mode is gone, not misconfigured."""
    archive = tmp_path / "cap.wacz"
    archive.write_bytes(b"x")
    for source in (str(archive), str(tmp_path / "nope.wacz"), str(tmp_path)):
        h = _post("/manage/create", {"mode": "import", "source": source})
        assert h.status == 400, source
        assert "CLI-only" in h.body["error"], source
        assert "zimi import" in h.body["error"], source


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


def test_no_web_mode_reads_a_server_path(monkeypatch, tmp_path):
    """The server-path modes both left the web. There is no primary-admin gate
    to pass any more: folder and import are refused with the CLI pointer for
    everyone, primary admin or not, and the URL modes reach validation as
    before."""
    f = tmp_path / "a.wacz"
    f.write_bytes(b"x")
    for primary in (False, True):
        monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: primary)
        for mode, source in (("import", str(f)), ("folder", str(tmp_path))):
            r = _post("/manage/create", {"mode": mode, "source": source})
            assert r.status == 400, (mode, primary)
            assert "CLI-only" in r.body["error"], (mode, primary)
        # URL modes stay open to any authorized admin — invalid scheme still
        # 400s, proving the request reached validation, not a tier gate.
        r = _post("/manage/create", {"mode": "page", "source": "ftp://nope"})
        assert r.status == 400


# ── every mode Zimi offers must be able to say whether it can run ──────────


def test_every_create_mode_can_answer_whether_it_can_run():
    """The class of bug that ate a whole day of field testing.

    Pillow was absent from the Docker image, so captures got no favicon.
    yt-dlp was absent, so a Video mode the Create page cheerfully offered died
    with "yt-dlp is not installed". Both are the same shape: a capability the
    client advertises and the server cannot honour, with nothing in between
    able to notice — the server does not know it is lying and the client has
    no way to ask.

    Three modes had a readiness probe and one did not, which is exactly why
    that one was the one that shipped broken. This asserts the mapping is
    TOTAL: add a mode to CREATE_MODES and this fails until you have said how
    the server decides it can run it.

    It deliberately does not assert any probe returns True — a laptop without
    yt-dlp is a legitimate install. What must never happen is a mode with no
    answer at all."""
    probes = {
        "page": manage._create_browser_ready,  # the fast engine needs nothing;
        "site": manage._create_browser_ready,  # rendered/alive are gated below
        "video": manage._create_video_ready,
        "import": manage._create_import_ready,
        "folder": lambda: True,  # reads the server's own disk; nothing to install
    }
    missing = [m for m in manage.CREATE_MODES if m not in probes]
    assert not missing, f"these modes cannot say whether they can run: {missing}"
    for mode, probe in probes.items():
        assert isinstance(probe(), bool), f"{mode}'s readiness probe is not a bool"


def test_every_capture_engine_can_answer_whether_it_can_run():
    """Same guarantee, one level down: an ENGINE is also a thing offered."""
    probes = {
        "builtin": lambda: True,  # stdlib urllib; present wherever Python is
        "rendered": manage._create_browser_ready,
        "alive": manage._create_alive_ready,
    }
    missing = [e for e in manage.CREATE_ENGINES if e not in probes]
    assert not missing, f"these engines cannot say whether they can run: {missing}"
    for engine, probe in probes.items():
        assert isinstance(probe(), bool), f"{engine}'s readiness probe is not a bool"


def test_the_status_payload_carries_a_readiness_answer_for_every_gated_mode():
    """And the answers have to REACH the client.

    A probe nobody sends is a probe nobody can act on: video_ready existed as
    a fact about the machine long before anything put it in the payload, which
    is the window the Video mode shipped broken in."""
    payload = manage._create_status(cursor=0, probe=True)
    for key in ("import_ready", "browser_ready", "alive_ready", "video_ready"):
        assert key in payload, f"the client is never told {key}"
        assert isinstance(payload[key], bool), key
