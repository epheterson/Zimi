"""The pre-flight probe and the folder picker.

Round 1's Create page was, in Eric's words, "a shot in the dark": you typed a
path you could not see and a language code you had to know, then waited. These
two endpoints are the cure, so the tests are about whether they actually tell
the truth in advance — and, for the picker, about how little it gives up.
"""

import os
import sys
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402


class _Handler:
    def __init__(self, private=True, headers=None):
        self.status = None
        self.body = None
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


@pytest.fixture
def tree(tmp_path):
    """A small folder that looks like real content."""
    root = tmp_path / "docs"
    (root / "notes").mkdir(parents=True)
    (root / "index.html").write_text(
        '<html lang="fr-CA"><head><title>Guide</title></head>'
        "<body><h1>Guide</h1><p>Bonjour</p></body></html>"
    )
    (root / "notes" / "water.md").write_text("# Water\n\nBoil it.\n")
    (root / ".hidden").write_text("skip me")
    return root


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
            ("_scan_folder", ["root"]),
            ("_pick_main", ["zim_paths"]),
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


# ── folder probe ────────────────────────────────────────────────────────────


def test_folder_probe_counts_what_the_run_would_package(tree):
    h = _post("/manage/create/probe", {"mode": "folder", "source": str(tree)})
    assert h.status == 200
    b = h.body
    assert b["ok"] is True
    assert b["files"] == 2  # the dotfile is not packaged, so it is not counted
    assert b["bytes"] > 0
    assert b["main"] == "index.html"
    assert b["language"] == "fra"  # read from <html lang="fr-CA">
    assert b["warning_key"] is None
    assert "water.md" in " ".join(b["examples"])


def test_folder_probe_writes_nothing(tree, tmp_path):
    before = sorted(p.name for p in tmp_path.rglob("*"))
    _post("/manage/create/probe", {"mode": "folder", "source": str(tree)})
    assert sorted(p.name for p in tmp_path.rglob("*")) == before


def test_an_empty_folder_says_so_instead_of_running(tmp_path):
    empty = tmp_path / "nothing"
    empty.mkdir()
    b = _post("/manage/create/probe", {"mode": "folder", "source": str(empty)}).body
    assert b["ok"] is False
    assert b["warning_key"] == "create_warn_empty_folder"


def test_probe_reuses_the_real_validator(tmp_path):
    """A probe that accepted what a run refuses would be a preview of a
    different job."""
    missing = _post(
        "/manage/create/probe", {"mode": "folder", "source": str(tmp_path / "nope")}
    )
    assert missing.status == 400
    assert missing.body["error"] == "not a folder on this server"
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


def test_import_probe_reports_sidecar_readiness(tmp_path):
    f = tmp_path / "capture.warc.gz"
    f.write_bytes(b"\x1f\x8b")
    b = _post("/manage/create/probe", {"mode": "import", "source": str(f)}).body
    assert isinstance(b["sidecar_ready"], bool)
    assert b["warning_key"] is None or b["warning_key"] == "create_warn_sidecar_offline"


# ── unexpected failures stay generic ────────────────────────────────────────


def test_an_unexpected_probe_failure_leaks_nothing(monkeypatch, tree):
    def boom(_source):
        raise RuntimeError("/secret/internal/path exploded")

    monkeypatch.setattr(manage, "_probe_folder", boom)
    b = _post("/manage/create/probe", {"mode": "folder", "source": str(tree)}).body
    assert b["ok"] is False
    assert b["warning_key"] == "create_warn_probe_failed"
    assert "secret" not in repr(b)


def test_a_create_error_during_probe_reaches_the_client_verbatim(monkeypatch, tree):
    from zimi.creator import CreateError

    def refuse(_source):
        raise CreateError("this page is an empty application shell — use zimit")

    monkeypatch.setattr(manage, "_probe_folder", refuse)
    b = _post("/manage/create/probe", {"mode": "folder", "source": str(tree)}).body
    assert b["ok"] is False
    assert "zimit" in b["detail"]


# ── the folder picker ───────────────────────────────────────────────────────


def test_browse_lists_directories_and_never_files(tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "beta").mkdir()
    (tmp_path / ".git").mkdir()
    (tmp_path / "secrets.txt").write_text("password=hunter2")
    b = _get("/manage/create/browse", {"path": [str(tmp_path)]}).body
    assert b["entries"] == ["alpha", "beta"]
    assert "secrets.txt" not in repr(b)  # file names are never disclosed
    assert ".git" not in b["entries"]  # nor dotted directories


def test_browse_does_not_follow_symlinks(tmp_path):
    """`_scan_folder` refuses to package through a symlink, so the picker must
    not offer to walk through one either."""
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "here").mkdir()
    os.symlink(str(real), str(tmp_path / "here" / "escape"))
    b = _get("/manage/create/browse", {"path": [str(tmp_path / "here")]}).body
    assert b["entries"] == []


def test_browse_offers_a_way_up_until_the_root(tmp_path):
    b = _get("/manage/create/browse", {"path": [str(tmp_path)]}).body
    assert b["parent"] == os.path.realpath(str(tmp_path.parent))
    root = _get("/manage/create/browse", {"path": [os.sep]}).body
    assert root["parent"] is None


def test_browse_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(manage, "CREATE_BROWSE_MAX_ENTRIES", 5)
    for i in range(12):
        (tmp_path / f"d{i:02d}").mkdir()
    b = _get("/manage/create/browse", {"path": [str(tmp_path)]}).body
    assert len(b["entries"]) == 5
    assert b["truncated"] is True


def test_browse_refuses_a_path_that_is_not_a_folder(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("x")
    h = _get("/manage/create/browse", {"path": [str(f)]})
    assert h.status == 400


def test_browse_opens_somewhere_sensible_with_no_path(tmp_path, monkeypatch):
    zdir = tmp_path / "library" / "zims"
    zdir.mkdir(parents=True)
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    b = _get("/manage/create/browse").body
    assert b["path"] == os.path.realpath(str(tmp_path / "library"))


# ── the gate ────────────────────────────────────────────────────────────────


def test_browse_and_probe_need_the_primary_admin_for_server_paths(
    monkeypatch, tmp_path
):
    """The picker exists to feed folder mode, which is primary-admin-only. A
    discovery surface that outranks what it discovers for is a hole."""
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "deadbeef$cafe")
    monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: False)
    monkeypatch.setattr(manage, "_secondary_admin_authorized", lambda h: True)

    assert _get("/manage/create/browse", {"path": [str(tmp_path)]}).status == 403
    assert (
        _post(
            "/manage/create/probe", {"mode": "folder", "source": str(tmp_path)}
        ).status
        == 403
    )
    # A secondary admin keeps the URL modes, which read nothing local.
    assert (
        _post("/manage/create/probe", {"mode": "page", "source": "not a url"}).status
        == 400
    )


def test_browse_requires_auth_at_all(monkeypatch, tmp_path):
    monkeypatch.setattr(manage, "_get_manage_password_hash", lambda: "")
    h = _get("/manage/create/browse", {"path": [str(tmp_path)]}, private=False)
    assert h.status == 403
    assert h.body["error"] == "public_locked"


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
    many = "\n".join(f"https://e.example/{i}" for i in range(manage.CREATE_MAX_PAGE_URLS + 1))
    with pytest.raises(ValueError) as e:
        manage._create_validate({"mode": "page", "source": many})
    assert "site crawl" in str(e.value)


def test_the_web_cap_matches_the_engines_own():
    """Two constants naming one limit drift the day someone changes the engine.
    manage.py holds its own copy so validation never imports the writer stack;
    this is the assertion that keeps the copy honest."""
    from zimi.creator import MAX_PAGE_URLS

    assert manage.CREATE_MAX_PAGE_URLS == MAX_PAGE_URLS
