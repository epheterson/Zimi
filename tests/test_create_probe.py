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


def test_browse_offers_a_way_up_until_the_configured_root(tmp_path):
    """ "Up" stops at the root. A picker that offers a parent one level above
    the directory the operator opened is a picker that walks out of it."""
    (tmp_path / "inner").mkdir()
    inner = _get("/manage/create/browse", {"path": [str(tmp_path / "inner")]}).body
    assert inner["parent"] == os.path.realpath(str(tmp_path))
    at_root = _get("/manage/create/browse", {"path": [str(tmp_path)]}).body
    assert at_root["parent"] is None
    assert at_root["root"] == os.path.realpath(str(tmp_path))


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


def test_browse_opens_at_the_root_with_no_path(tmp_path, monkeypatch):
    """The picker used to open beside the ZIM library, which was a guess at
    where content lives. With a root configured there is nothing to guess: the
    operator already said which directory this is about."""
    zdir = tmp_path / "library" / "zims"
    zdir.mkdir(parents=True)
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    b = _get("/manage/create/browse").body
    assert b["path"] == os.path.realpath(str(tmp_path))
    assert b["parent"] is None


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


# ── the server-path root ────────────────────────────────────────────────────
#
# Eric on the round-2 folder flow: "The folder flow feels sketchy I don't love
# showing the whole file system there. Maybe folder is CLI only?" The answer is
# a door that is closed by default and opens only as wide as ZIMI_CREATE_ROOT
# says. The Create page hides the folder chip when no root is set, but hiding a
# chip stops nobody from posting the JSON by hand, so every one of these is
# about the server refusing on its own.


def _unset_root(monkeypatch):
    monkeypatch.delenv(manage.CREATE_ROOT_ENV, raising=False)


def test_with_no_root_the_picker_refuses_outright(monkeypatch, tmp_path):
    """403 and not an empty listing: this is the filesystem-disclosure surface
    Eric objected to, and with no root configured it should not answer."""
    _unset_root(monkeypatch)
    h = _get("/manage/create/browse", {"path": [str(tmp_path)]})
    assert h.status == 403
    assert "ZIMI_CREATE_ROOT" in h.body["error"]
    assert h.body["create_root"] is None
    assert "entries" not in h.body


def test_with_no_root_folder_and_import_are_refused_everywhere(monkeypatch, tmp_path):
    """Both server-path modes, through both doors. A hidden chip is cosmetic;
    these four refusals are the boundary."""
    _unset_root(monkeypatch)
    (tmp_path / "docs").mkdir()
    archive = tmp_path / "cap.warc.gz"
    archive.write_bytes(b"\x1f\x8b")
    for mode, source in (("folder", tmp_path / "docs"), ("import", archive)):
        for path in ("/manage/create", "/manage/create/probe"):
            h = _post(path, {"mode": mode, "source": str(source)})
            assert h.status == 403, (mode, path)
            assert "ZIMI_CREATE_ROOT" in h.body["error"], (mode, path)


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
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))

    h = _post("/manage/create/probe", {"mode": "folder", "source": str(evil)})
    assert h.status == 400
    assert "outside" in h.body["error"]
    # …and the picker lands back at the root rather than showing it.
    assert _get("/manage/create/browse", {"path": [str(evil)]}).body[
        "path"
    ] == os.path.realpath(str(root))


def test_a_symlink_out_of_the_root_is_resolved_before_it_is_judged(
    monkeypatch, tmp_path
):
    """Comparing the typed string would let a link planted inside the root walk
    straight out of it. Both sides are realpath'd, so it cannot."""
    root = tmp_path / "sources"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    (outside / "secrets").mkdir(parents=True)
    os.symlink(str(outside), str(root / "escape"))
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))

    through_link = str(root / "escape" / "secrets")
    h = _post("/manage/create/probe", {"mode": "folder", "source": through_link})
    assert h.status == 400
    assert "outside" in h.body["error"]
    assert _get("/manage/create/browse", {"path": [through_link]}).body[
        "path"
    ] == os.path.realpath(str(root))


def test_import_takes_the_same_root_as_folder(monkeypatch, tmp_path):
    """A server path is a server path. Import reads one, the server reads it,
    and it lands in the library — the same gesture with a different noun."""
    root = tmp_path / "sources"
    root.mkdir()
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))
    inside = root / "cap.warc.gz"
    inside.write_bytes(b"\x1f\x8b")
    outside = tmp_path / "cap.warc.gz"
    outside.write_bytes(b"\x1f\x8b")

    assert (
        _post("/manage/create/probe", {"mode": "import", "source": str(outside)}).status
        == 400
    )
    # The one inside gets as far as the engine's own answer about the file.
    assert (
        _post("/manage/create/probe", {"mode": "import", "source": str(inside)}).status
        == 200
    )


def test_the_root_itself_is_inside_the_root(monkeypatch, tmp_path):
    """An operator who names /srv/sources means that directory too, not only
    the things under it."""
    root = tmp_path / "sources"
    (root / "docs").mkdir(parents=True)
    (root / "index.html").write_text("<html><body>hi</body></html>")
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(root))
    assert (
        _post("/manage/create/probe", {"mode": "folder", "source": str(root)}).status
        == 200
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
