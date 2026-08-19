"""The pre-flight probe, and the web doors that closed with the server-path modes.

Round 1's Create page was, in Eric's words, "a shot in the dark": you typed a
path you could not see and a language code you had to know, then waited. The
probe is the cure, so the tests are about whether it actually tells the truth
in advance. Both server-path modes left the web: folder in round 3 ("do remove
folder I said that would be CLI only") and archive import right after ("remove
archive as well only in cli"). So the other half of this file is about those
doors refusing cleanly and pointing at the CLI instead of half-working, and
about the directory picker that fed folder mode being gone entirely.
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
    """ZIMI_CREATE_ROOT survives only as a fact the create page reports (the
    status probe echoes it) — no web mode acts on it any more, since the two
    modes that read a server path are both CLI-only now. Set to the test's own
    tmp_path so the one test that checks the reported value has something to
    read; harmless everywhere else."""
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(tmp_path))
    return tmp_path


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
    different job. Import is CLI-only, so the probe refuses it exactly as the
    run does — the validator is the one seam."""
    refused = _post(
        "/manage/create/probe", {"mode": "import", "source": str(tmp_path / "no.wacz")}
    )
    assert refused.status == 400
    assert "CLI-only" in refused.body["error"]
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


# ── unexpected failures stay generic ────────────────────────────────────────


def test_an_unexpected_probe_failure_leaks_nothing(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("/secret/internal/path exploded")

    monkeypatch.setattr(manage, "_probe_url", boom)
    b = _post(
        "/manage/create/probe", {"mode": "site", "source": "https://example.org/"}
    ).body
    assert b["ok"] is False
    assert b["warning_key"] == "create_warn_probe_failed"
    assert "secret" not in repr(b)


def test_a_create_error_during_probe_reaches_the_client_verbatim(monkeypatch):
    from zimi.creator import CreateError

    def refuse(*_a, **_k):
        raise CreateError("this page is an empty application shell — use zimit")

    monkeypatch.setattr(manage, "_probe_url", refuse)
    b = _post(
        "/manage/create/probe", {"mode": "site", "source": "https://example.org/"}
    ).body
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


# ── import is CLI-only ───────────────────────────────────────────────────────
#
# Archive import followed folder off the web ("remove archive as well only in
# cli"). It is refused through both doors, for everyone, whatever the root —
# the mode is gone, not gated. The server no longer reads a path off its own
# disk for any create request; ZIMI_CREATE_ROOT survives only as a reported
# fact.


def _unset_root(monkeypatch):
    monkeypatch.delenv(manage.CREATE_ROOT_ENV, raising=False)


def test_import_is_refused_through_both_doors(monkeypatch, tmp_path):
    """Whether or not a root is set, and whoever asks: both doors answer with
    the CLI pointer, never with a root complaint or a tier gate."""
    archive = tmp_path / "cap.warc.gz"
    archive.write_bytes(b"\x1f\x8b")
    for rooted in (True, False):
        if rooted:
            monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(tmp_path))
        else:
            _unset_root(monkeypatch)
        for path in ("/manage/create", "/manage/create/probe"):
            h = _post(path, {"mode": "import", "source": str(archive)})
            assert h.status == 400, (path, rooted)
            assert "CLI-only" in h.body["error"], (path, rooted)
            assert "zimi import" in h.body["error"], (path, rooted)


def test_import_refusal_does_not_depend_on_the_primary_admin(monkeypatch, tmp_path):
    """There is no primary-admin gate left: no web mode reads a server path, so
    import refuses the primary admin and everyone else the same way."""
    archive = tmp_path / "cap.warc.gz"
    archive.write_bytes(b"\x1f\x8b")
    for primary in (False, True):
        monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: primary)
        h = _post("/manage/create/probe", {"mode": "import", "source": str(archive)})
        assert h.status == 400, primary
        assert "CLI-only" in h.body["error"], primary


def test_with_no_root_the_url_modes_are_untouched(monkeypatch):
    """The URL modes read nothing local, so the (now purely reported) root has
    never had anything to say about them."""
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


def test_a_bare_host_is_normalized_to_https():
    # Eric: "allow entering sites without https://". A bare host is the common
    # shorthand and captures as https; a path rides along.
    _m, source, _t, opts = manage._create_validate(
        {"mode": "page", "source": "cnn.com"}
    )
    assert opts["urls"] == ["https://cnn.com"]
    assert source == "https://cnn.com"
    _m, source, _t, _o = manage._create_validate(
        {"mode": "site", "source": "example.org/docs"}
    )
    assert source == "https://example.org/docs"
    # An explicit scheme is left exactly as given.
    _m, source, _t, _o = manage._create_validate(
        {"mode": "site", "source": "http://plain.example/"}
    )
    assert source == "http://plain.example/"


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
