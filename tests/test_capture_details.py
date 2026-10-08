"""Capture options, round two, first half: the ZIM's details (description,
author, publisher, tags) in every mode that writes a ZIM, the table's new
rows, and the stored defaults and web validation behind them. Cookies, what to
leave out and workers are in test_capture_round2.py.
"""

import argparse
import json
import os
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.capturegate as gate  # noqa: E402
import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as _srv  # noqa: E402
from libzim.reader import Archive  # noqa: E402
from tests.test_capture_defaults import _cli, _store, data_dir  # noqa: E402,F401
from tests.test_create_routes import clean_job  # noqa: E402,F401
from tests.test_creator_site import (  # noqa: E402,F401
    BASE,
    COOKIES,
    HOSTED,
    PORT,
    REQUESTS,
    ROUTES,
    _clean,
    _page,
    _paths,
    _site,
    _text,
    fixture_server,
    zimit_docker,
)

MANY_TAGS = ";".join(f"t{i}" for i in range(31))
SESSION = "sessionid-4f9c1e7a6b"
SITE = {"mode": "site", "source": "https://www.example.org/docs/"}


def _meta(path, key):
    return bytes(Archive(path).get_metadata(key)).decode("utf-8")


# ── the table ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "key, value, expected",
    [
        ("description", "  A  short\n line  ", "A short line"),
        ("creator", "Ada Lovelace", "Ada Lovelace"),
        ("publisher", "Analytical Press", "Analytical Press"),
        ("tags", "news; health ;news", ["news", "health"]),
        ("tags", ["a", " b "], ["a", "b"]),
        ("cookies", "Cookie: a=1;  b=2 ;", "a=1; b=2"),
        ("skip_types", "pdf, video", ["video", "pdf"]),
        ("skip_types", ["images"], ["images"]),
        ("max_file_bytes", "50M", 50_000_000),
        ("workers", "4", 4),
        ("engine", "Rendered", "rendered"),
        ("language", "ENG", "eng"),
        ("language", "auto", None),
    ],
)
def test_the_table_reads_each_new_option(key, value, expected):
    assert crawler.capture_option_value(key, value) == expected


@pytest.mark.parametrize(
    "key, value",
    [
        ("description", "x" * 81),
        ("creator", "x" * 201),
        ("publisher", "bad\x00line"),
        ("tags", MANY_TAGS),
        ("tags", "x" * 61),
        ("cookies", "no equals sign"),
        ("cookies", "a=1\nb=2"),
        ("cookies", "bad name=1"),
        ("cookies", "a=" + "x" * gate.MAX_COOKIE_CHARS),
        ("skip_types", "video,floppies"),
        ("max_file_bytes", "lots"),
        ("workers", 0),
        ("workers", 17),
        ("workers", "many"),
        ("engine", "carrier-pigeon"),
        ("language", "english-ish"),
    ],
)
def test_a_bad_value_is_refused_by_the_table(key, value):
    with pytest.raises(creator.CreateError):
        crawler.capture_option_value(key, value)


def test_a_refusal_never_carries_the_cookie():
    for bad in (
        f"sid={SESSION}\nx=1",
        f"{SESSION}",
        f"sid={SESSION}; \x01=1",
        f"sid=\u20ac{SESSION}",
    ):
        with pytest.raises(creator.CreateError) as caught:
            crawler.capture_option_value("cookies", bad)
        assert SESSION not in str(caught.value)


def test_a_long_description_is_refused_with_its_length():
    with pytest.raises(
        creator.CreateError, match="at most 80 characters and this one is 90"
    ):
        crawler.capture_option_value("description", "x" * 90)


def test_storable_and_not():
    for key in (
        "creator",
        "publisher",
        "skip_types",
        "max_file_bytes",
        "workers",
        "engine",
        "language",
    ):
        assert crawler.CAPTURE_OPTIONS[key].storable, key
    for key in ("description", "tags", "cookies"):
        assert not crawler.CAPTURE_OPTIONS[key].storable, key
    with pytest.raises(
        creator.CreateError, match="cookies are a credential and are never stored"
    ):
        crawler.validate_stored_defaults({"cookies": "a=1"})
    with pytest.raises(creator.CreateError, match="describes one ZIM"):
        crawler.validate_stored_defaults({"description": "x"})


def test_an_option_shows_as_text_and_cookies_show_as_set():
    show = lambda k, v: crawler.CAPTURE_OPTIONS[k].show(v)  # noqa: E731
    assert show("cookies", "sid=secret") == "set"
    assert show("skip_types", ["video", "pdf"]) == "video,pdf"
    assert show("tags", ["a", "b"]) == "a;b"
    assert show("max_file_bytes", 50_000_000) == "50.0 MB"
    assert show("workers", 4) == "4"


def test_engines_that_cannot_honor_an_option_say_so():
    with pytest.raises(
        creator.CreateError,
        match="--cookies applies to the fast, rendered and alive engines, which singlefile is not",
    ):
        crawler.capture_options({"cookies": "a=1"}, "singlefile", strict=True)
    with pytest.raises(
        creator.CreateError,
        match="--workers applies to the zimit engine, which builtin is not",
    ):
        crawler.capture_options({"workers": 4}, "builtin", strict=True)
    assert crawler.capture_options({"workers": 4}, "zimit", strict=True) == {
        "workers": 4
    }
    assert crawler.capture_options(
        {"cookies": "a=1", "skip_types": "pdf"}, "zimit", strict=True
    )
    assert crawler.capture_options({"workers": 4}, "builtin", strict=False) == {}


# ── the ZIM's details ───────────────────────────────────────────────────────


def test_details_reach_a_site_zim(fixture_server, tmp_path):
    info = _site(
        tmp_path,
        "/",
        max_pages=1,
        description="Docs for the fixture",
        creator_name="Ada",
        publisher="Press",
        tags=["news", "health"],
    )
    assert _meta(info["path"], "Description") == "Docs for the fixture"
    assert _meta(info["path"], "Creator") == "Ada"
    assert _meta(info["path"], "Publisher") == "Press"
    tags = _meta(info["path"], "Tags").split(";")
    assert "news" in tags and "health" in tags and "_pictures:yes" in tags


def test_details_left_alone_keep_the_factory(fixture_server, tmp_path):
    info = _site(tmp_path, "/", max_pages=1)
    assert _meta(info["path"], "Creator") == "Zimi"
    assert _meta(info["path"], "Publisher") == "Zimi"


def test_details_reach_a_page_and_several_pages(fixture_server, tmp_path):
    kw = dict(
        description="One page", creator_name="Ada", publisher="Press", tags=["t1"]
    )
    one = creator.create_page_zim(
        BASE + "/docs/intro.html", out_dir=str(tmp_path), **kw
    )
    two = creator.create_pages_zim(
        [BASE + "/docs/intro.html", BASE + "/docs/next.html"],
        out_dir=str(tmp_path),
        out_path=str(tmp_path / "two.zim"),
        **kw,
    )
    for info in (one, two):
        assert _meta(info["path"], "Description") == "One page"
        assert _meta(info["path"], "Creator") == "Ada"
        assert _meta(info["path"], "Publisher") == "Press"
        assert "t1" in _meta(info["path"], "Tags").split(";")


@pytest.fixture
def folder(tmp_path):
    root = tmp_path / "notes"
    root.mkdir()
    (root / "index.html").write_text("<html><title>Notes</title><body>hi</body></html>")
    return root


def _pack(folder, tmp_path, **kw):
    return creator.create_folder_zim(
        str(folder), out_path=str(tmp_path / "f.zim"), **kw
    )


def test_a_folder_takes_the_capture_then_zimi_txt_then_the_stored_default(
    folder, tmp_path, data_dir
):
    # Nothing anywhere: the factory.
    assert _meta(_pack(folder, tmp_path)["path"], "Creator") == "Zimi"
    _store(data_dir, creator="Stored Author", publisher="Stored Press")
    (tmp_path / "a").mkdir()
    info = _pack(folder, tmp_path / "a")
    assert _meta(info["path"], "Creator") == "Stored Author"
    assert _meta(info["path"], "Publisher") == "Stored Press"
    # zimi.txt beats the stored default.
    (folder / "zimi.txt").write_text(
        "Creator: Sidecar Author\nPublisher: Sidecar Press\nTags: from-file\n"
    )
    (tmp_path / "b").mkdir()
    info = _pack(folder, tmp_path / "b")
    assert _meta(info["path"], "Creator") == "Sidecar Author"
    assert _meta(info["path"], "Publisher") == "Sidecar Press"
    # And what the capture was given beats both; tags add to the file's.
    (tmp_path / "c").mkdir()
    info = _pack(
        folder,
        tmp_path / "c",
        creator_name="Typed",
        publisher="Typed Press",
        tags=["typed"],
    )
    assert _meta(info["path"], "Creator") == "Typed"
    assert _meta(info["path"], "Publisher") == "Typed Press"
    tags = _meta(info["path"], "Tags").split(";")
    assert "from-file" in tags and "typed" in tags


def test_a_folder_reads_the_stored_language_after_zimi_txt(folder, tmp_path, data_dir):
    _store(data_dir, language="fra")
    assert _pack(folder, tmp_path)["language"] == "fra"
    (folder / "zimi.txt").write_text("Language: deu\n")
    (tmp_path / "b").mkdir()
    assert _pack(folder, tmp_path / "b")["language"] == "deu"
    (tmp_path / "c").mkdir()
    assert _pack(folder, tmp_path / "c", language="spa")["language"] == "spa"


def test_zimit_is_handed_the_details_it_knows(zimit_docker, tmp_path):
    crawler.create_zimit_zim(
        "https://example.com/",
        out_dir=str(tmp_path / "z"),
        description="Short",
        creator_name="Ada",
        publisher="Press",
        tags=["a", "b"],
    )
    cmd = zimit_docker["runs"][0]
    assert cmd[cmd.index("--creator") + 1] == "Ada"
    assert cmd[cmd.index("--publisher") + 1] == "Press"
    assert cmd[cmd.index("--tags") + 1] == "a;b"


def test_zimit_without_the_flags_is_not_failed_by_them(zimit_docker, tmp_path):
    zimit_docker["flag_supported"] = False
    notes = []
    crawler.create_zimit_zim(
        "https://example.com/",
        out_dir=str(tmp_path / "z"),
        publisher="Press",
        tags=["a"],
        progress=notes.append,
    )
    cmd = zimit_docker["runs"][0]
    assert "--publisher" not in cmd and "--tags" not in cmd
    assert any(
        "does not know --publisher; --publisher was not passed" in n for n in notes
    )
    assert any("does not know --tags; --tags was not passed" in n for n in notes)


def test_import_hands_the_details_to_warc2zim(monkeypatch, tmp_path):
    import zimi.importer as importer

    warc = tmp_path / "a.warc.gz"
    warc.write_bytes(b"x")
    seen = {}

    def fake_convert(archive, out, **kw):
        seen.update(kw)
        return out

    monkeypatch.setattr(importer, "convert_archive", fake_convert)
    monkeypatch.setattr(importer, "ensure_sidecar", lambda sink=None: "/bin/warc2zim")
    importer.import_archive(
        str(warc),
        out_path=str(tmp_path / "x.zim"),
        description="D",
        creator_name="Ada",
        publisher="Press",
        tags=["a", "b"],
    )
    assert (
        seen["description"],
        seen["creator_name"],
        seen["publisher"],
        seen["tags"],
    ) == (
        "D",
        "Ada",
        "Press",
        "a;b",
    )


def test_the_converter_is_told_only_what_its_sidecar_knows(monkeypatch, tmp_path):
    import zimi.importer as importer

    cmds = []
    monkeypatch.setattr(importer, "ensure_sidecar", lambda sink=None: "/bin/warc2zim")
    monkeypatch.setattr(
        importer, "_supports_flag", lambda exe, flag: flag == "--publisher"
    )

    def run(cmd, say):
        cmds.append(cmd)
        out = os.path.join(
            cmd[cmd.index("--output") + 1], cmd[cmd.index("--zim-file") + 1]
        )
        open(out, "wb").write(b"z")
        return 0

    monkeypatch.setattr(importer, "_run_stream", run)
    monkeypatch.setattr(importer, "_require_front_door", lambda p: None)
    importer.convert_archive(
        str(tmp_path / "a.warc"),
        str(tmp_path / "o.zim"),
        zim_name="n",
        publisher="Press",
        creator_name="Ada",
    )
    assert "--publisher" in cmds[0] and "Press" in cmds[0] and "--creator" in cmds[0]
    cmds.clear()
    monkeypatch.setattr(importer, "_supports_flag", lambda exe, flag: False)
    importer.convert_archive(
        str(tmp_path / "a.warc"),
        str(tmp_path / "p.zim"),
        zim_name="n",
        publisher="Press",
    )
    assert "--publisher" not in cmds[0]


def test_alive_keeps_the_publisher_and_the_tags():
    import zimi.alive as alive

    assert alive._tags(["a", "b"]).endswith("zimi:alive;a;b")
    assert alive._tags() == "_ftindex:yes;_category:other;zimi:alive"


# ── the web: details, defaults, refusals ────────────────────────────────────


def _opts(mode="site", **fields):
    source = {
        "folder": ".",
        "page": "https://www.example.org/",
        "video": "https://www.example.org/v",
    }
    return manage._create_validate(
        dict(SITE, mode=mode, source=source.get(mode, SITE["source"]), **fields)
    )[3]


def test_the_web_takes_the_details_in_every_mode_that_writes_a_zim(data_dir):
    given = dict(description="D", creator="Ada", publisher="P", tags="a;b")
    for mode in ("page", "site", "video"):
        opts = _opts(mode, **given)
        assert (
            opts["description"],
            opts["creator"],
            opts["publisher"],
            opts["tags"],
        ) == (
            "D",
            "Ada",
            "P",
            ["a", "b"],
        ), mode


def test_the_web_refuses_a_long_description_before_a_job_exists(data_dir):
    for mode in ("page", "site", "video"):
        with pytest.raises(ValueError, match="at most 80 characters"):
            _opts(mode, description="x" * 81)


def test_stored_author_and_publisher_fill_what_the_web_leaves_unsaid(data_dir):
    _store(data_dir, creator="Stored", publisher="Stored Press")
    opts = _opts("site")
    assert (opts["creator"], opts["publisher"]) == ("Stored", "Stored Press")
    opts = _opts("site", creator="Typed")
    assert (opts["creator"], opts["publisher"]) == ("Typed", "Stored Press")
    # A folder reads the stored default itself, after its zimi.txt.
    assert "creator" not in manage._create_details({}, stored=False)


def test_stored_engine_and_language_are_what_silence_means(data_dir, monkeypatch):
    _store(data_dir, engine="rendered", language="fra")
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    opts = _opts("site")
    assert opts["engine"] == "rendered" and opts["language"] == "fra"
    opts = _opts("site", engine="builtin", language="deu")
    assert opts["engine"] == "builtin" and opts["language"] == "deu"
    # An engine that has gone missing since is the fast one, not a refusal.
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: False)
    assert _opts("site").get("engine") is None


def test_the_web_drops_workers_for_an_engine_without_them_and_refuses_cookies(
    data_dir, monkeypatch
):
    assert "workers" not in _opts("site", workers=4)
    monkeypatch.setattr(manage, "_create_singlefile_ready", lambda: True)
    with pytest.raises(
        ValueError, match="--cookies applies to the fast, rendered and alive engines"
    ):
        _opts("site", engine="singlefile", cookies="a=1")
    opts = _opts("site", cookies="a=1; b=2", skip_types="pdf,video", max_file_bytes="5M")
    assert opts["cookies"] == "a=1; b=2"
    assert opts["skip_types"] == ["video", "pdf"] and opts["max_file_bytes"] == 5_000_000
    for field, value in (("cookies", "nope"), ("skip_types", "floppy"), ("max_file_bytes", "lots")):
        with pytest.raises(ValueError):
            _opts("site", **{field: value})


def test_a_job_hands_the_new_options_to_the_engine(monkeypatch, data_dir):
    seen = {}
    monkeypatch.setattr(
        crawler, "create_site_zim", lambda url, **kw: seen.update(kw) or {}
    )
    monkeypatch.setattr(manage, "_create_allows_private", lambda: True)
    manage._create_run(
        manage._CreateJob("site", SITE["source"], None),
        _opts(
            "site",
            cookies="a=1",
            skip_types="video",
            max_file_bytes="1M",
            description="D",
            creator="Ada",
            publisher="P",
            tags="x;y",
        ),
    )
    assert seen["cookies"] == "a=1" and seen["skip_types"] == ["video"]
    assert seen["max_file_bytes"] == 1_000_000
    assert (
        seen["description"],
        seen["creator_name"],
        seen["publisher"],
        seen["tags"],
    ) == (
        "D",
        "Ada",
        "P",
        ["x", "y"],
    )
    assert "creator" not in seen


def test_the_stored_defaults_payload_carries_the_new_keys(data_dir):
    stored = {
        "creator": "Ada",
        "publisher": "P",
        "skip_types": ["video", "pdf"],
        "max_file_bytes": 50_000_000,
        "workers": 4,
        "engine": "zimit",
        "language": "fra",
    }
    _store(data_dir, **stored)
    view = manage._create_defaults_view()
    assert view["defaults"] == stored
    assert view["defaults_text"] == {
        "creator": "Ada",
        "publisher": "P",
        "skip_types": "video,pdf",
        "max_file_bytes": "50.0 MB",
        "workers": "4",
        "engine": "zimit",
        "language": "fra",
    }


def test_a_hand_edited_bad_stored_value_falls_back(data_dir):
    _store(
        data_dir,
        workers=99,
        skip_types=["floppy"],
        engine="pigeon",
        cookies="a=1",
        description="d",
    )
    assert crawler.stored_defaults() == {}

