"""Capture options, round two, second half: cookies, what to leave out and
workers, each end to end on the fixture site where it applies, zimit's argv for
an image that knows the flags and one that does not, and the CLI. The ZIM's
details and the table's new rows are in test_capture_details.py; the first five
options are in test_capture_options.py.
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
from tests.test_capture_details import MANY_TAGS, SITE, _meta  # noqa: E402
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

SESSION = "sessionid-4f9c1e7a6b"
HEADER = f"theme=dark; sid={SESSION}"
OTHER = f"http://localhost:{PORT}"

# A page and the files it carries, of every kind a capture may be told to leave
# out, on this host and on another (the remote reader's road).
MEDIA = "/r2/media.html"
ROUTES.update(
    {
        MEDIA: (
            "text/html; charset=utf-8",
            _page(
                '<img src="/r2/small.png"><img src="/r2/big.png">'
                '<img src="/r2/photo"><img src="/r2/clip.mp4">'
                '<video><source src="/r2/movie.mp4"></video>'
                '<audio><source src="/r2/tune.mp3"></audio>'
                f'<img src="{OTHER}/r2/remote.png"><img src="{OTHER}/r2/remote.jpg">',
                css=False,
            ),
        ),
        "/r2/small.png": ("image/png", b"S" * 100),
        "/r2/big.png": ("image/png", b"B" * 200_000),
        "/r2/photo": ("image/jpeg", b"J" * 300),
        "/r2/clip.mp4": ("video/mp4", b"V" * 400),
        "/r2/movie.mp4": ("video/mp4", b"M" * 400),
        "/r2/tune.mp3": ("audio/mpeg", b"A" * 400),
        "/r2/remote.png": ("image/png", b"R" * 100),
        "/r2/remote.jpg": ("image/jpeg", b"R" * 150_000),
    }
)


def _carried(info):
    return {p for p in _paths(Archive(info["path"])) if p.startswith("_assets/")}


def _kept(info, *needles):
    """Which of the named files the ZIM carries. ``remote.png`` is the picture
    of that type that came from the other host (the fast engine stores those
    under a hash of their address, the rendered one under the host's name)."""
    carried = _carried(info)

    def has(needle):
        if needle.startswith("remote."):
            ext = needle.rsplit(".", 1)[1]
            return any(
                ("_remote/" in p or "localhost" in p) and p.endswith("." + ext)
                for p in carried
            )
        return any(needle in p for p in carried if "_remote/" not in p and "localhost" not in p)

    return {n for n in needles if has(n)}



# ── cookies ─────────────────────────────────────────────────────────────────


def _cookie_log(host):
    return [(path, cookie) for h, path, cookie in COOKIES if h == host]


def test_cookies_go_to_the_seeds_host_and_to_no_other_origin(fixture_server, tmp_path):
    # scope=any walks to the other site, and its pages pull their own
    # stylesheet: every request there is a chance to leak.
    info = _site(tmp_path, "/deep/start.html", scope="any", max_depth=2, cookies=HEADER)
    assert info["pages"] >= 3
    here, there = _cookie_log("127.0.0.1"), _cookie_log("localhost")
    assert there, "the crawl never reached the second origin"
    assert {c for _p, c in here} == {"theme=dark; sid=" + SESSION}
    assert {c for _p, c in there} == {None}
    assert ("/robots.txt", HEADER) in here  # robots.txt of the seed's host too


def test_cookies_do_not_follow_a_redirect_to_another_host(fixture_server, tmp_path):
    _site(tmp_path, "/to-localhost", cookies=HEADER, max_pages=1)
    assert _cookie_log("127.0.0.1")[0:1] and all(
        c == HEADER for _p, c in _cookie_log("127.0.0.1")
    )
    assert _cookie_log("localhost") and {c for _p, c in _cookie_log("localhost")} == {
        None
    }


def test_cookies_are_not_sent_when_none_were_given(fixture_server, tmp_path):
    _site(tmp_path, "/", max_pages=2)
    assert {c for _h, _p, c in COOKIES} == {None}


def test_the_cookie_scope_is_the_seeds_host_and_its_subdomains():
    jar = gate.CaptureCookies("a=1", "https://docs.example.org/x")
    assert jar.header_for("https://docs.example.org/y") == "a=1"
    assert jar.header_for("https://a.docs.example.org/") == "a=1"
    for other in (
        "https://example.org/",
        "https://docs.example.org.evil.test/",
        "https://evildocs.example.org/",
        "ftp://docs.example.org/",
    ):
        assert jar.header_for(other) is None, other
    ip = gate.CaptureCookies("a=1", "http://10.0.0.1/x")
    assert ip.header_for("http://10.0.0.1/") == "a=1"
    assert ip.header_for("http://x.10.0.0.1/") is None
    assert SESSION not in repr(gate.CaptureCookies(f"s={SESSION}", "http://h/")) + str(
        gate.CaptureCookies(f"s={SESSION}", "http://h/")
    )


def test_a_browser_gets_the_cookies_bound_to_the_seeds_host():
    named = gate.CaptureCookies("a=1; b=2", "https://docs.example.org/x").for_browser()
    assert named == [
        {"name": n, "value": v, "domain": ".docs.example.org", "path": "/", "secure": True}
        for n, v in (("a", "1"), ("b", "2"))
    ]
    local = gate.CaptureCookies("a=1", "http://127.0.0.1:8894/x").for_browser()
    assert local == [
        {"name": "a", "value": "1", "domain": "127.0.0.1", "path": "/", "secure": False}
    ]


def _files_under(root):
    for base, _dirs, names in os.walk(root):
        for name in names:
            yield os.path.join(base, name)


def test_the_cookie_is_written_nowhere(fixture_server, tmp_path, data_dir, caplog):
    import logging

    caplog.set_level(logging.DEBUG)
    notes = []
    out = tmp_path / "zims"
    out.mkdir()
    info = _site(
        tmp_path / "zims",
        "/deep/start.html",
        scope="any",
        max_depth=2,
        cookies=HEADER,
        progress=notes.append,
    )
    # Not in the progress log, the server log, the ZIM (metadata, history, any
    # entry) or anything under the data directory.
    assert SESSION not in "\n".join(map(str, notes))
    assert SESSION not in caplog.text
    arc = Archive(info["path"])
    for key in arc.metadata_keys:
        assert SESSION.encode() not in bytes(arc.get_metadata(key)), key
    for path in _files_under(str(tmp_path)):
        assert SESSION.encode() not in open(path, "rb").read(), path
    assert (
        not os.path.exists(crawler.create_defaults_path())
        or SESSION not in open(crawler.create_defaults_path()).read()
    )


def test_a_job_never_shows_or_keeps_the_cookie(monkeypatch, data_dir, clean_job):
    seen = {}
    monkeypatch.setattr(
        crawler, "create_site_zim", lambda url, **kw: seen.update(kw) or {}
    )
    monkeypatch.setattr(manage, "_create_allows_private", lambda: True)
    payload, status = manage._create_start(dict(SITE, cookies=HEADER, title="t"))
    assert status == 200, payload
    job = manage._create_job
    job.settled.wait(10)
    assert seen["cookies"] == HEADER  # the engine got it
    shown = json.dumps(
        [
            job.request,
            manage._create_job_record(job),
            manage._create_status(0),
            manage._create_status(0, history=True),
        ],
        default=str,
    )
    assert SESSION not in shown
    assert job.request["cookies"] == "set"
    assert SESSION not in "\n".join(job.lines)
    for path in _files_under(str(data_dir)):
        assert SESSION.encode() not in open(path, "rb").read(), path


def test_a_rerun_of_a_redacted_request_sends_no_cookies_rather_than_the_word():
    redacted = crawler.redacted_request({"mode": "site", "cookies": HEADER, "title": "t"})
    assert redacted == {"mode": "site", "cookies": "set", "title": "t"}
    assert crawler.capture_option_value("cookies", redacted["cookies"]) is None
    assert "cookies" not in crawler.capture_options(redacted, "builtin", strict=True)


def test_cookies_are_not_passed_to_zimit_and_the_note_does_not_carry_them(
    zimit_docker, tmp_path
):
    notes = []
    crawler.create_site_zim(
        "https://example.com/",
        engine="zimit",
        out_dir=str(tmp_path / "z"),
        cookies=HEADER,
        skip_types=["video"],
        max_file_bytes=1000,
        workers=4,
        progress=notes.append,
    )
    cmd = zimit_docker["runs"][0]
    assert SESSION not in " ".join(cmd) and SESSION not in "\n".join(notes)
    assert any(
        "zimit has no equivalent of --cookies; it was not passed" in n for n in notes
    )
    assert any("no equivalent of --skip" in n for n in notes)
    assert any("no equivalent of --max-file-size" in n for n in notes)
    assert cmd[cmd.index("--workers") + 1] == "4"


def test_zimit_without_the_workers_flag_says_so(zimit_docker, tmp_path):
    zimit_docker["flag_supported"] = False
    notes = []
    crawler.create_site_zim(
        "https://example.com/",
        engine="zimit",
        out_dir=str(tmp_path / "z"),
        workers=4,
        progress=notes.append,
    )
    assert "--workers" not in zimit_docker["runs"][0]
    assert any("does not know --workers; --workers was not passed" in n for n in notes)


# ── leave out ───────────────────────────────────────────────────────────────


def test_nothing_is_left_out_unless_asked(fixture_server, tmp_path):
    info = _site(tmp_path, MEDIA, max_pages=1)
    everything = {"small", "big", "photo", "clip", "movie", "tune", "remote.png", "remote.jpg"}
    assert _kept(info, *everything) == everything


def test_each_kind_is_left_out_by_extension_and_by_content_type(
    fixture_server, tmp_path
):
    notes = []
    info = _site(
        tmp_path,
        MEDIA,
        max_pages=1,
        skip_types=["video", "audio"],
        progress=notes.append,
    )
    kept = _kept(info, "small", "photo", "clip", "movie", "tune", "remote.png")
    assert "clip" not in kept and "movie" not in kept and "tune" not in kept
    assert {"small", "photo", "remote.png"} <= kept
    assert "left out 3 files: 2 video, 1 audio" in "\n".join(notes)
    # A skipped file was never asked for.
    assert "/r2/clip.mp4" not in REQUESTS and "/r2/tune.mp3" not in REQUESTS
    # The page still points where it did.
    assert 'src="/r2/clip.mp4"' in _text(
        Archive(info["path"]), "A/index"
    ) or "clip" in _text(Archive(info["path"]), "A/index")


def test_images_are_left_out_whatever_their_name_says(fixture_server, tmp_path):
    notes = []
    info = _site(
        tmp_path, MEDIA, max_pages=1, skip_types=["images"], progress=notes.append
    )
    kept = _kept(info, "small", "big", "photo", "remote.png", "remote.jpg", "clip")
    assert kept == {"clip"}
    # "photo" has no extension: only its content type says it is a picture. It
    # was fetched to find out, and kept out.
    assert "/r2/photo" in REQUESTS
    assert "left out 5 files: 5 images" in "\n".join(notes)


def test_the_largest_file_leaves_out_what_is_bigger(fixture_server, tmp_path):
    notes = []
    info = _site(
        tmp_path, MEDIA, max_pages=1, max_file_bytes=1000, progress=notes.append
    )
    assert not _kept(info, "big", "remote.jpg")
    assert {"small", "photo", "clip", "tune", "remote.png"} <= _kept(
        info, "small", "photo", "clip", "tune", "remote.png"
    )
    line = [n for n in notes if n.startswith("left out")]
    assert line and "2 over 1.0 KB" in line[0]


def test_a_zero_largest_file_is_no_limit(fixture_server, tmp_path):
    info = _site(tmp_path, MEDIA, max_pages=1, max_file_bytes=0)
    assert "big" in "".join(_carried(info))


def test_leave_out_is_counted_once_per_file():
    rule = gate.LeaveOut(["pdf"])
    for _ in range(3):
        assert rule.skips_url("https://h/a.pdf?x=1")
    assert rule.counts == {"pdf": 1}
    assert not rule.skips_url("https://h/a.html")
    assert rule.skips_response("application/pdf", None, "https://h/b")
    assert rule.summary() == "left out 2 files: 2 pdf"


def test_the_leave_out_rule_is_gone_when_the_capture_ends(fixture_server, tmp_path):
    _site(tmp_path, MEDIA, max_pages=1, skip_types=["images"], cookies=HEADER)
    assert gate.current_leave_out() is None and gate.current_cookies() is None


def test_a_bad_cookie_is_refused_before_anything_is_fetched(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError):
        _site(tmp_path, "/", cookies="not a cookie")
    assert not REQUESTS and gate.current_cookies() is None


needs_browser = pytest.mark.skipif(
    not __import__("zimi.renderer", fromlist=["x"]).browser_available(),
    reason="needs a headless Chromium",
)


@needs_browser
def test_a_rendered_capture_sends_cookies_to_the_seed_only(fixture_server, tmp_path):
    _site(
        tmp_path,
        "/deep/start.html",
        engine="rendered",
        scope="any",
        max_depth=2,
        cookies=HEADER,
    )
    here, there = _cookie_log("127.0.0.1"), _cookie_log("localhost")
    assert there, "the crawl never reached the second origin"
    assert any(c and "sid=" + SESSION in c for _p, c in here)
    assert {c for _p, c in there} == {None}


@needs_browser
def test_a_rendered_capture_leaves_out_what_it_was_told_to(fixture_server, tmp_path):
    notes = []
    info = _site(
        tmp_path,
        MEDIA,
        engine="rendered",
        max_pages=1,
        skip_types=["video", "audio"],
        max_file_bytes=100_000,
        progress=notes.append,
    )
    kept = _kept(
        info,
        "small",
        "big",
        "photo",
        "clip",
        "movie",
        "tune",
        "remote.png",
        "remote.jpg",
    )
    assert kept == {"small", "photo", "remote.png"}
    assert any(isinstance(n, str) and n.startswith("left out") for n in notes)


@needs_browser
def test_a_recording_keeps_no_cookie_in_its_request_headers():
    import zimi.renderer as renderer

    class Request:
        headers = {
            "Accept": "*/*",
            "Cookie": "sid=" + SESSION,
            "cookie": "x=" + SESSION,
        }

    class Response:
        request = Request()

    kept = renderer._request_headers_of(Response())
    assert kept == {"Accept": "*/*"}


def test_the_alive_engine_reads_the_rules_from_the_capture(monkeypatch):
    import zimi.renderer as renderer

    token = gate.set_cookies(HEADER, "http://127.0.0.1/")
    leave = gate.set_leave_out(["pdf"], 10)
    try:
        session = renderer.RenderedSession.__new__(renderer.RenderedSession)
        renderer.RenderedSession.__init__(session)
        assert session._cookies is gate.current_cookies()
        assert session._leave_out is gate.current_leave_out()

        class Response:
            headers = {"content-type": "application/pdf"}

        assert session._left_out(Response(), "https://h/x")

        class Fine:
            headers = {"content-type": "text/css", "content-length": "5"}

        assert not session._left_out(Fine(), "https://h/x.css")

        class Big:
            headers = {"content-type": "text/css", "content-length": "500"}

        assert session._left_out(Big(), "https://h/y.css")
        session._cleanup_spool()
    finally:
        gate.reset_leave_out(leave)
        gate.reset_cookies(token)


# ── workers ─────────────────────────────────────────────────────────────────


def test_workers_are_zimits_and_the_crawl_stays_one_polite_walk(zimit_docker, tmp_path):
    assert crawler.CAPTURE_OPTIONS["workers"].engines == ("zimit",)
    crawler.create_site_zim(
        "https://example.com/", engine="zimit", out_dir=str(tmp_path / "z"), workers=3
    )
    cmd = zimit_docker["runs"][0]
    assert cmd[cmd.index("--workers") + 1] == "3"


# ── the CLI ─────────────────────────────────────────────────────────────────


def test_cli_cookies_skip_and_largest_file(fixture_server, tmp_path):
    done = _cli(
        tmp_path,
        BASE + MEDIA,
        "--site",
        "--cookies",
        HEADER,
        "--skip",
        "video,audio",
        "--max-file-size",
        "100k",
        "--delay",
        "0",
        "--max-pages",
        "1",
    )
    assert done.returncode == 0, done.stderr
    assert {c for h, _p, c in COOKIES if h == "127.0.0.1"} == {HEADER}
    assert "left out" in done.stdout
    assert SESSION not in done.stdout + done.stderr
    assert "/r2/clip.mp4" not in REQUESTS
    arc = Archive(str(tmp_path / "x.zim"))
    assert "_assets/127_0_0_1/r2/big.png" not in _paths(arc)
    assert "_assets/127_0_0_1/r2/small.png" in _paths(arc)


def test_cli_details_reach_the_zim(fixture_server, tmp_path):
    done = _cli(
        tmp_path,
        BASE + "/",
        "--site",
        "--description",
        "Fixture docs",
        "--creator",
        "Ada",
        "--publisher",
        "Press",
        "--tags",
        "one;two",
        "--delay",
        "0",
        "--max-pages",
        "1",
    )
    assert done.returncode == 0, done.stderr
    path = str(tmp_path / "x.zim")
    assert (
        _meta(path, "Description") == "Fixture docs" and _meta(path, "Creator") == "Ada"
    )
    assert _meta(path, "Publisher") == "Press"
    assert {"one", "two"} <= set(_meta(path, "Tags").split(";"))


def test_cli_reads_the_stored_details_and_a_flag_beats_them(fixture_server, tmp_path):
    (tmp_path / "cli-data").mkdir()
    (tmp_path / "cli-data" / "create_defaults.json").write_text(
        json.dumps({"creator": "Stored", "publisher": "Stored Press", "delay": 0}),
        encoding="utf-8",
    )
    done = _cli(tmp_path, BASE + "/", "--site", "--max-pages", "1")
    assert done.returncode == 0, done.stderr
    assert _meta(str(tmp_path / "x.zim"), "Creator") == "Stored"
    done = _cli(
        tmp_path,
        BASE + "/",
        "--site",
        "--max-pages",
        "1",
        "--creator",
        "Flag",
        out="y.zim",
    )
    assert _meta(str(tmp_path / "y.zim"), "Creator") == "Flag"
    assert _meta(str(tmp_path / "y.zim"), "Publisher") == "Stored Press"


def test_a_stored_engine_is_the_engine_unless_a_flag_says_otherwise(data_dir):
    _store(data_dir, engine="rendered")

    def engine_of(typed, sources=("https://example.com/",)):
        args = argparse.Namespace(engine=typed)
        creator._apply_engine_default(args, list(sources))
        return args.engine

    assert engine_of(None) == "rendered"
    assert engine_of("builtin") == "builtin"
    # Several pages cannot go to zimit, so a stored zimit is not theirs.
    _store(data_dir, engine="zimit")
    assert engine_of(None) == "zimit"
    assert engine_of(None, ["https://a.test/", "https://b.test/"]) == "builtin"


def test_a_stored_engine_does_not_beat_a_video_address(monkeypatch):
    import zimi.video as video

    monkeypatch.setattr(video, "claims_url", lambda url: True)
    args = argparse.Namespace(engine=None, site=False, format=None, audio_only=False, limit=None)
    # No --engine typed: the video extractor has its say, whatever is stored.
    assert video.wants_url("https://example.com/v", args)
    args.engine = "rendered"
    assert not video.wants_url("https://example.com/v", args)


def test_cli_refuses_what_it_cannot_do(tmp_path):
    cases = [
        (("--description", "x" * 81), "at most 80 characters"),
        (("--tags", MANY_TAGS), "at most 30 tags"),
        (
            ("--site", "--workers", "4"),
            "--workers applies to the zimit engine, which builtin is not",
        ),
        (("--site", "--workers", "40", "--engine", "zimit"), "from 1 to 16"),
        (
            ("--site", "--cookies", "nonsense"),
            "cookies are written as a Cookie header is",
        ),
        (
            ("--site", "--engine", "singlefile", "--cookies", "a=1"),
            "--cookies applies to the fast, rendered and alive engines",
        ),
        (("--skip", "video"), "--skip needs --site"),
        (("--site", "--skip", "floppies"), "cannot leave out"),
        (("--max-file-size", "5M"), "--max-file-size needs --site"),
        (("--cookies", "a=1"), "--cookies needs --site"),
    ]
    for flags, message in cases:
        done = _cli(tmp_path, "https://example.com/", *flags, offline=True)
        assert done.returncode != 0, flags
        assert message in done.stdout + done.stderr, (flags, done.stdout + done.stderr)
        assert (
            "a=1" not in done.stdout.replace("a=1; b=2", "")
            or "--cookies" in done.stdout
        )


def test_cli_flags_reach_zimit(zimit_docker, tmp_path):
    args = argparse.Namespace(
        site=True,
        engine="zimit",
        title=None,
        description="Short",
        language="eng",
        creator="Ada",
        publisher="Press",
        tags=["x"],
        out=str(tmp_path / "x.zim"),
        max_pages=None,
        max_depth=None,
        scope=None,
        include=None,
        exclude=None,
        extra_hops=None,
        time_limit=None,
        sitemap=None,
        user_agent=None,
        mobile=None,
        page_timeout=None,
        cookies=None,
        skip_types="pdf",
        max_file_bytes="5M",
        workers="2",
    )
    creator._build_from_args(args, "https://example.com/", True)
    cmd = zimit_docker["runs"][0]
    assert cmd[cmd.index("--workers") + 1] == "2"
    assert (
        cmd[cmd.index("--publisher") + 1] == "Press"
        and cmd[cmd.index("--tags") + 1] == "x"
    )
    assert SESSION not in " ".join(cmd)


def test_zimit_refuses_cookies_rather_than_run_signed_out(zimit_docker, tmp_path):
    with pytest.raises(
        creator.CreateError,
        match="--cookies applies to the fast, rendered and alive engines, which zimit is not",
    ):
        crawler.capture_options({"cookies": HEADER}, "zimit", strict=True)
    args = argparse.Namespace(
        site=True, engine="zimit", title=None, description=None, language="eng",
        creator=None, out=str(tmp_path / "x.zim"), max_pages=None, max_depth=None,
        scope=None, include=None, exclude=None, extra_hops=None, time_limit=None,
        sitemap=None, user_agent=None, mobile=None, page_timeout=None, cookies=HEADER,
        skip_types=None, max_file_bytes=None, workers=None,
    )
    with pytest.raises(creator.CreateError, match="which zimit is not") as caught:
        creator._build_from_args(args, "https://example.com/", True)
    assert SESSION not in str(caught.value) and not zimit_docker["runs"]
    with pytest.raises(ValueError, match="which zimit is not"):
        manage._create_capture_options({"cookies": HEADER}, "zimit")


def test_cookies_do_not_go_down_from_https_to_http():
    jar = gate.CaptureCookies("a=1", "https://docs.example.org/")
    assert jar.header_for("https://docs.example.org/x") == "a=1"
    assert jar.header_for("http://docs.example.org/x") is None
    assert jar.header_for("http://a.docs.example.org/x") is None
    plain = gate.CaptureCookies("a=1", "http://docs.example.org/")
    assert plain.header_for("http://docs.example.org/") == "a=1"
    assert plain.header_for("https://docs.example.org/") == "a=1"


def test_a_browser_gets_prefixed_cookies_in_the_form_it_demands():
    jar = gate.CaptureCookies(
        "__Host-id=1; __Secure-tok=2; plain=3", "https://docs.example.org/x/y"
    )
    host, secure, plain = jar.for_browser()
    assert host == {
        "name": "__Host-id", "value": "1", "url": "https://docs.example.org/", "secure": True,
    }
    assert secure["secure"] is True and secure["domain"] == ".docs.example.org"
    assert plain == {
        "name": "plain", "value": "3", "domain": ".docs.example.org", "path": "/", "secure": True,
    }
    http = gate.CaptureCookies("__Secure-t=2; p=3", "http://127.0.0.1:8894/").for_browser()
    assert http[0]["secure"] is True and http[1]["secure"] is False


@needs_browser
def test_a_browser_that_refuses_one_cookie_still_captures(fixture_server, tmp_path):
    notes = []
    # __Host- cookies cannot be set on a plain-http seed; the rest still go.
    info = _site(
        tmp_path, "/deep/start.html", engine="rendered", max_pages=1,
        cookies="__Host-id=1; ok=" + SESSION, progress=notes.append,
    )
    assert info["pages"] == 1
    assert any(isinstance(n, str) and "took 1 of 2 cookies" in n for n in notes)
    assert SESSION not in "\n".join(map(str, notes))
    assert any(c and "ok=" + SESSION in c for h, _p, c in COOKIES if h == "127.0.0.1")


def _alive_session(**rules):
    from zimi.renderer import RenderedSession

    written = []

    class _Recorder:
        def write_exchange(self, url, **kw):
            written.append(url)
            return "response"

    session = RenderedSession.__new__(RenderedSession)
    session._recorder = _Recorder()
    session._context = None
    session._budget = None
    session.recorded = 0
    session._archived = set()
    session._landed = None
    session._note = lambda _m: None
    session._leave_out = gate.LeaveOut(**rules)
    return session, written


def _response(url, kind, ctype, size, body=b"x" * 50):
    class _Request:
        resource_type = kind
        method = "GET"
        headers = {}

    class _Response:
        status = 200
        request = _Request()
        headers = {"content-type": ctype, "content-length": str(size)}

        def __init__(self):
            self.url = url

        def body(self):
            return body

        def all_headers(self):
            return self.headers

    return _Response()


def test_the_alive_recording_never_leaves_a_page_out():
    session, written = _alive_session(kinds=["pdf", "images"], max_bytes=1000)
    session._record(
        [
            _response("https://h/", "document", "text/html", 5_000_000),
            _response("https://h/guide.pdf", "document", "text/html", 10),
            _response("https://h/big.js", "script", "text/javascript", 5_000_000),
            _response("https://h/pic.png", "image", "image/png", 10),
        ]
    )
    assert written == ["https://h/", "https://h/guide.pdf"]
    assert session._leave_out.counts == {"too big": 1, "images": 1}


def test_the_alive_body_size_check_spares_the_page_too():
    session, written = _alive_session(max_bytes=100)
    big = b"x" * 5000
    session._record(
        [
            _response("https://h/", "document", "text/html", 0, body=big),
            _response("https://h/a.js", "script", "text/javascript", 0, body=big),
        ]
    )
    assert written == ["https://h/"]
