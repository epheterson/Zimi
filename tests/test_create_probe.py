"""The pre-flight probe, and the two web doors that closed with folder mode.

Round 1's Create page was, in Eric's words, "a shot in the dark": you typed a
path you could not see and a language code you had to know, then waited. The
probe is the cure, so the tests are about whether it actually tells the truth
in advance. Folder mode itself — and the directory picker that fed it — left
the web in round 3 ("do remove folder I said that would be CLI only"), so the
other half of this file is about those doors refusing cleanly and pointing at
the CLI instead of half-working.
"""

import os
import sys
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402


class _Handler:
    def __init__(self, private=True, headers=None):
        self.status = None
        # A dict from the start, like the twin in test_create_routes.py: every
        # assertion below reads it as one, and a route that answered nothing
        # should fail on a missing key rather than on the shape of the recorder.
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


def _get(path, params=None, private=True):
    h = _Handler(private=private)
    manage.handle_manage_get(h, urlparse(path), params or {})
    return h


@pytest.fixture(autouse=True)
def no_job():
    manage._create_job = None
    yield
    manage._create_job = None


@pytest.fixture(autouse=True)
def create_root(tmp_path, monkeypatch):
    """Every server-path test runs on an instance whose operator has opened one
    directory — the test's own tmp_path. Without ZIMI_CREATE_ROOT the web
    cannot package a server path at all, which is the DEFAULT and has its own
    tests below; making it the ambient state here would be testing the gate
    over and over instead of what it gates."""
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(tmp_path))
    return tmp_path


@pytest.fixture
def archive(tmp_path):
    """A file shaped like a capture, inside the configured root."""
    f = tmp_path / "capture.warc.gz"
    f.write_bytes(b"\x1f\x8b")
    return f


# ── the seam to the engines ─────────────────────────────────────────────────


def test_the_probe_only_borrows_helpers_that_still_exist():
    """The probe reads the engines' own internals so a preview can never
    disagree with the run it previews. That is the right call and a real
    coupling: these helpers are private, several lanes edit those files, and a
    rename would break the preview for exactly the modes the unit tests here
    cannot reach without a network. Fail loudly at the seam instead."""
    import inspect

    from zimi import crawler, creator, video

    expected = {
        creator: [
            ("_decode_page", ["data", "ctype"]),
            ("_page_title_from_html", ["text", "fallback"]),
            ("looks_like_spa", ["page"]),
        ],
        crawler: [("_origin_of", ["url"]), ("_robots_allows", ["robots", "url"])],
        video: [("_yt_dlp", []), ("_flat_entries", ["mod", "url", "limit"])],
    }
    for module, entries in expected.items():
        for name, params in entries:
            fn = getattr(module, name, None)
            assert callable(fn), f"{module.__name__}.{name} is gone"
            got = list(inspect.signature(fn).parameters)
            assert got[: len(params)] == params, f"{module.__name__}.{name}{got}"

    # _fetch_page returns (final_url, data, ctype, content_language) — the probe
    # unpacks all four positionally, and the order is the part that bites.
    src = inspect.getsource(creator._fetch_page)
    assert "return url, data, ctype, clang" in src
    assert list(inspect.signature(crawler.load_robots).parameters)[:1] == ["origin"]


# ── language detection ──────────────────────────────────────────────────────


def test_iso3_accepts_two_letter_three_letter_and_regional_tags():
    assert manage._iso3_of("fr") == "fra"
    assert manage._iso3_of("fr-CA") == "fra"
    assert manage._iso3_of("en_GB") == "eng"
    assert manage._iso3_of("fra") == "fra"


def test_iso3_refuses_what_it_does_not_know():
    """A wrong language is worse than none: it stems the full-text index by the
    wrong rules, silently, forever."""
    for junk in ("", None, "zz", "klingon", "12", "x-pig-latin"):
        assert manage._iso3_of(junk) is None


def test_language_comes_from_the_documents_own_declaration():
    assert manage._detect_html_language('<html lang="de">x</html>') == "deu"
    assert (
        manage._detect_html_language(
            '<meta http-equiv="content-language" content="es">'
        )
        == "spa"
    )
    assert manage._detect_html_language("<html>no claim</html>") is None


# ── folder mode is CLI-only ─────────────────────────────────────────────────
#
# Eric, round 2: "The folder flow feels sketchy I don't love showing the whole
# file system there. Maybe folder is CLI only?" — and round 3: "do remove
# folder I said that would be CLI only." So the web refuses the MODE, through
# both doors, with the sentence that names the door still open. The refusal
# must not depend on the root or on who asks: it is not a permissions matter,
# the feature simply does not exist here.


def test_folder_mode_is_refused_from_the_web(tmp_path):
    (tmp_path / "docs").mkdir()
    for path in ("/manage/create", "/manage/create/probe"):
        h = _post(path, {"mode": "folder", "source": str(tmp_path / "docs")})
        assert h.status == 400, path
        assert "CLI-only" in h.body["error"], path
        assert "zimi create" in h.body["error"], path


def test_the_folder_refusal_does_not_depend_on_the_root(monkeypatch, tmp_path):
    monkeypatch.delenv(manage.CREATE_ROOT_ENV, raising=False)
    h = _post("/manage/create", {"mode": "folder", "source": str(tmp_path)})
    assert h.status == 400
    assert "CLI-only" in h.body["error"]


def test_probe_reuses_the_real_validator(tmp_path):
    """A probe that accepted what a run refuses would be a preview of a
    different job."""
    missing = _post(
        "/manage/create/probe", {"mode": "import", "source": str(tmp_path / "no.wacz")}
    )
    assert missing.status == 400
    assert missing.body["error"] == "not a file on this server"
    assert (
        _post("/manage/create/probe", {"mode": "page", "source": "file:///etc"}).status
        == 400
    )
    assert _post("/manage/create/probe", {"mode": "wat", "source": "x"}).status == 400


def test_probe_is_refused_while_a_job_runs():
    manage._create_job = manage._CreateJob("site", "https://example.org/", "")
    h = _post(
        "/manage/create/probe", {"mode": "page", "source": "https://example.org/"}
    )
    assert h.status == 409


# ── import probe ────────────────────────────────────────────────────────────


def test_import_probe_names_a_wrong_extension(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("not an archive")
    b = _post("/manage/create/probe", {"mode": "import", "source": str(f)}).body
    assert b["ok"] is False
    assert b["warning_key"] == "create_warn_not_archive"
    assert b["bytes"] == len("not an archive")


def test_import_probe_reports_sidecar_readiness(archive):
    b = _post("/manage/create/probe", {"mode": "import", "source": str(archive)}).body
    assert isinstance(b["sidecar_ready"], bool)
    assert b["warning_key"] is None or b["warning_key"] == "create_warn_sidecar_offline"


# ── unexpected failures stay generic ────────────────────────────────────────


def test_an_unexpected_probe_failure_leaks_nothing(monkeypatch, archive):
    def boom(_source):
        raise RuntimeError("/secret/internal/path exploded")

    monkeypatch.setattr(manage, "_probe_import", boom)
    b = _post("/manage/create/probe", {"mode": "import", "source": str(archive)}).body
    assert b["ok"] is False
    assert b["warning_key"] == "create_warn_probe_failed"
    assert "secret" not in repr(b)


def test_a_create_error_during_probe_reaches_the_client_verbatim(monkeypatch, archive):
    from zimi.creator import CreateError

    def refuse(_source):
        raise CreateError("this page is an empty application shell — use zimit")

    monkeypatch.setattr(manage, "_probe_import", refuse)
    b = _post("/manage/create/probe", {"mode": "import", "source": str(archive)}).body
    assert b["ok"] is False
    assert "zimit" in b["detail"]


# ── the folder picker is gone ───────────────────────────────────────────────
#
# The lister existed solely to feed folder mode's form. With the mode CLI-only
# it would be a directory-disclosure surface serving nothing, so the route
# refuses outright — cleanly, with the CLI pointer, and without listing so
# much as one entry, whoever asks and whatever the root says.


def test_browse_refuses_and_names_the_cli(tmp_path):
    (tmp_path / "alpha").mkdir()
    h = _get("/manage/create/browse", {"path": [str(tmp_path)]})
    assert h.status == 410
    assert "CLI-only" in h.body["error"]
    assert "zimi create" in h.body["error"]
    assert "entries" not in h.body
    assert "alpha" not in repr(h.body)  # nothing about the disk is disclosed


def test_browse_refuses_even_with_no_root(monkeypatch, tmp_path):
    monkeypatch.delenv(manage.CREATE_ROOT_ENV, raising=False)
    assert _get("/manage/create/browse", {"path": [str(tmp_path)]}).status == 410


def test_browse_requires_auth_at_all(monkeypatch, tmp_path):
    """The refusal sits BEHIND the auth gate: an unauthenticated caller learns
    that manage is locked, not which endpoints used to exist."""
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "")
    h = _get("/manage/create/browse", {"path": [str(tmp_path)]}, private=False)
    assert h.status == 403
    assert h.body["error"] == "public_locked"


# ── the gate ────────────────────────────────────────────────────────────────


def test_import_probe_needs_the_primary_admin(monkeypatch, tmp_path, archive):
    """Import reads a server path — that power stays with the primary admin.
    Secondary admins keep the URL modes, which read nothing local."""
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "deadbeef$cafe")
    monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: False)
    monkeypatch.setattr(manage, "_secondary_admin_authorized", lambda h: True)

    assert (
        _post("/manage/create/probe", {"mode": "import", "source": str(archive)}).status
        == 403
    )
    # A secondary admin keeps the URL modes, which read nothing local.
    assert (
        _post("/manage/create/probe", {"mode": "page", "source": "not a url"}).status
        == 400
    )


# ── the server-path root ────────────────────────────────────────────────────
#
# The door that is closed by default and opens only as wide as
# ZIMI_CREATE_ROOT says. Import is the one mode left behind it — the Create
# page never draws what a viewer may not use, but hiding a form stops nobody
# from posting the JSON by hand, so every one of these is about the server
# refusing on its own.


def _unset_root(monkeypatch):
    monkeypatch.delenv(manage.CREATE_ROOT_ENV, raising=False)


def test_with_no_root_import_is_refused_through_both_doors(monkeypatch, tmp_path):
    _unset_root(monkeypatch)
    archive = tmp_path / "cap.warc.gz"
    archive.write_bytes(b"\x1f\x8b")
    for path in ("/manage/create", "/manage/create/probe"):
        h = _post(path, {"mode": "import", "source": str(archive)})
        assert h.status == 403, path
        assert "ZIMI_CREATE_ROOT" in h.body["error"], path


def test_with_no_root_the_url_modes_are_untouched(monkeypatch):
    """The root gates SERVER PATHS. Capturing a URL reads nothing local and is
    not what Eric was uneasy about."""
    _unset_root(monkeypatch)
    h = _post("/manage/create/probe", {"mode": "page", "source": "not a url"})
    assert h.status == 400  # refused as a bad URL, never as a policy matter


def test_the_status_probe_reports_the_root(monkeypatch, tmp_path):
    body = _get("/manage/create/status", {"probe": ["1"]}).body
    assert body["create_root"] == os.path.realpath(str(tmp_path))
    _unset_root(monkeypatch)
    assert _get("/manage/create/status", {"probe": ["1"]}).body["create_root"] is None
    # Not on every poll — it is configuration, not progress.
    assert "create_root" not in _get("/manage/create/status").body


def test_a_sibling_directory_sharing_the_roots_name_is_not_inside_it(
    monkeypatch, tmp_path
):
    """The classic naive-prefix hole: /srv/library-sources-evil starts with
    /srv/library-sources and is nowhere near inside it."""
    root = tmp_path / "sources"
    root.mkdir()
    evil = tmp_path / "sources-evil"
    evil.mkdir()
    (evil / "cap.warc.gz").write_bytes(b"\x1f\x8b")
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))

    h = _post(
        "/manage/create/probe",
        {"mode": "import", "source": str(evil / "cap.warc.gz")},
    )
    assert h.status == 400
    assert "outside" in h.body["error"]


def test_a_symlink_out_of_the_root_is_resolved_before_it_is_judged(
    monkeypatch, tmp_path
):
    """Comparing the typed string would let a link planted inside the root walk
    straight out of it. Both sides are realpath'd, so it cannot."""
    root = tmp_path / "sources"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "cap.warc.gz").write_bytes(b"\x1f\x8b")
    os.symlink(str(outside), str(root / "escape"))
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))

    through_link = str(root / "escape" / "cap.warc.gz")
    h = _post("/manage/create/probe", {"mode": "import", "source": through_link})
    assert h.status == 400
    assert "outside" in h.body["error"]


def test_the_root_itself_is_inside_the_root(monkeypatch, tmp_path):
    """An operator who names /srv/sources means that directory too, not only
    the things under it."""
    root = tmp_path / "sources"
    root.mkdir()
    (root / "cap.warc.gz").write_bytes(b"\x1f\x8b")
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))
    assert (
        _post(
            "/manage/create/probe",
            {"mode": "import", "source": str(root / "cap.warc.gz")},
        ).status
        == 200
    )


# ── multi-URL page mode ─────────────────────────────────────────────────────


def test_page_mode_takes_a_list_one_address_per_line():
    _mode, source, _title, opts = manage._create_validate(
        {
            "mode": "page",
            "source": "https://a.example/1\n\n  https://b.example/2  \nhttps://a.example/1\n",
        }
    )
    # Blanks skipped, whitespace trimmed, duplicates collapsed — all three are
    # what pasting a list actually produces.
    assert opts["urls"] == ["https://a.example/1", "https://b.example/2"]
    assert source == "https://a.example/1\nhttps://b.example/2"


def test_a_single_page_still_looks_like_a_single_page():
    _mode, source, _title, opts = manage._create_validate(
        {"mode": "page", "source": "https://a.example/1"}
    )
    assert opts["urls"] == ["https://a.example/1"]
    assert source == "https://a.example/1"


def test_a_bad_line_is_named_rather_than_failing_on_page_eleven():
    with pytest.raises(ValueError) as e:
        manage._create_validate(
            {"mode": "page", "source": "https://ok.example/\nnot-a-url\n"}
        )
    assert "not-a-url" in str(e.value)


def test_the_list_is_capped_and_says_what_to_do_instead():
    many = "\n".join(
        f"https://e.example/{i}" for i in range(manage.CREATE_MAX_PAGE_URLS + 1)
    )
    with pytest.raises(ValueError) as e:
        manage._create_validate({"mode": "page", "source": many})
    assert "site crawl" in str(e.value)


def test_the_web_cap_matches_the_engines_own():
    """Two constants naming one limit drift the day someone changes the engine.
    manage.py holds its own copy so validation never imports the writer stack;
    this is the assertion that keeps the copy honest."""
    from zimi.creator import MAX_PAGE_URLS

    assert manage.CREATE_MAX_PAGE_URLS == MAX_PAGE_URLS
