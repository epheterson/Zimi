"""The fetch options on page captures: one URL or several, not only a site.

User agent, mobile, page timeout, cookies, and what to leave out, on the engines
that capture pages, end to end on the fixture site; the web form, the stored
defaults and the CLI. The site versions are in test_capture_options.py and
test_capture_round2.py.
"""

import argparse
import json
import os
import subprocess
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.capturegate as gate  # noqa: E402
import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
from libzim.reader import Archive  # noqa: E402
from tests.test_capture_defaults import _cli, _store, data_dir  # noqa: E402,F401
from tests.test_capture_round2 import (  # noqa: E402,F401
    HEADER,
    MEDIA,
    OTHER,
    SESSION,
    _carried,
    _kept,
    needs_browser,
)
from tests.test_creator_site import (  # noqa: E402,F401
    AGENTS,
    BASE,
    COOKIES,
    REQUESTS,
    _clean,
    _paths,
    fixture_server,
    zimit_docker,
)

INTRO = BASE + "/docs/intro.html"


def _cookie_log(host):
    return {c for h, _p, c in COOKIES if h == host}


def _page(tmp_path, url=MEDIA, **kw):
    return creator.create_page_zim(url if url.startswith("http") else BASE + url, out_dir=str(tmp_path), **kw)


# ── the fast engine ─────────────────────────────────────────────────────────


def test_a_page_presents_the_user_agent_it_was_given(fixture_server, tmp_path):
    _page(tmp_path, INTRO, user_agent="Page/1")
    assert set(AGENTS) == {"Page/1"}
    AGENTS.clear()
    _page(tmp_path, INTRO, mobile=True, out_path=str(tmp_path / "m.zim"))
    assert AGENTS and all("iPhone" in (a or "") for a in AGENTS)


def test_a_page_sends_cookies_to_its_own_host_and_no_other(fixture_server, tmp_path):
    info = _page(tmp_path, MEDIA, cookies=HEADER)
    assert _kept(info, "small", "remote.png")  # the other host's picture came too
    assert _cookie_log("127.0.0.1") == {HEADER}
    assert _cookie_log("localhost") == {None}


def test_several_pages_each_send_cookies_to_their_own_host_only(fixture_server, tmp_path):
    third = "http://127.0.0.2:8894/docs/next.html"
    info = creator.create_pages_zim(
        [INTRO, OTHER + "/docs/next.html"], out_dir=str(tmp_path), cookies=HEADER
    )
    assert len(info["urls"]) == 2
    assert _cookie_log("127.0.0.1") == {HEADER} and _cookie_log("localhost") == {HEADER}
    jar = gate.CaptureCookies(HEADER, [INTRO, OTHER + "/x"])
    assert jar.header_for(third) is None


def test_a_page_leaves_out_what_it_was_told_to_and_keeps_the_page(fixture_server, tmp_path):
    notes = []
    info = _page(
        tmp_path, MEDIA, skip_types=["video", "audio"], max_file_bytes=1000, progress=notes.append
    )
    kept = _kept(info, "small", "big", "photo", "clip", "movie", "tune", "remote.png", "remote.jpg")
    assert kept == {"small", "photo", "remote.png"}
    assert "left out 5 files" in "\n".join(n for n in notes if isinstance(n, str))
    # The page is far bigger than 1000 bytes only if it is the seed; it is kept.
    assert "A/index" in _paths(Archive(info["path"]))


def test_a_page_larger_than_the_largest_file_is_still_a_page(fixture_server, tmp_path):
    info = _page(tmp_path, INTRO, max_file_bytes=10, skip_types=["images"])
    assert "A/index" in _paths(Archive(info["path"]))


def test_several_pages_leave_out_too(fixture_server, tmp_path):
    notes = []
    info = creator.create_pages_zim(
        [BASE + MEDIA, INTRO], out_dir=str(tmp_path), skip_types=["images"], progress=notes.append
    )
    assert not _kept(info, "small", "big", "photo")
    assert any(isinstance(n, str) and n.startswith("left out") for n in notes)


def test_nothing_leaks_after_a_page_capture(fixture_server, tmp_path):
    _page(tmp_path, INTRO, cookies=HEADER, skip_types=["pdf"])
    assert gate.current_cookies() is None and gate.current_leave_out() is None


def test_a_bad_cookie_on_a_page_fails_before_any_request(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="cookies are written"):
        _page(tmp_path, INTRO, cookies="nonsense")
    assert not REQUESTS


# ── a browser engine ────────────────────────────────────────────────────────


@needs_browser
def test_a_rendered_page_binds_cookies_to_its_host(fixture_server, tmp_path):
    _page(tmp_path, MEDIA, engine="rendered", cookies=HEADER)
    sent = {c for c in _cookie_log("127.0.0.1") if c}
    assert sent and all("sid=" + SESSION in c for c in sent)
    assert _cookie_log("localhost") == {None}


@needs_browser
def test_a_rendered_page_leaves_out_and_keeps_the_page(fixture_server, tmp_path):
    info = _page(
        tmp_path, MEDIA, engine="rendered", skip_types=["video", "audio"], max_file_bytes=100_000
    )
    kept = _kept(info, "small", "big", "photo", "clip", "movie", "tune", "remote.png", "remote.jpg")
    assert kept == {"small", "photo", "remote.png"}
    assert "A/index" in _paths(Archive(info["path"]))


@needs_browser
def test_a_rendered_page_takes_the_phone_and_the_agent(fixture_server, tmp_path):
    _page(tmp_path, "/viewport.html", engine="rendered", mobile=True)
    assert any("iPhone" in (a or "") for a in AGENTS)


# ── the other engines ───────────────────────────────────────────────────────


def test_the_alive_page_engine_is_handed_the_options(monkeypatch, tmp_path):
    import zimi.alive as alive

    seen = {}

    class Stop(Exception):
        pass

    class Capture:
        def __init__(self, **kw):
            seen.update(kw)
            raise creator.CreateError("stop here")

    monkeypatch.setattr(alive, "AliveCapture", Capture)
    monkeypatch.setattr(alive, "require_alive", lambda: None)
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    with pytest.raises(creator.CreateError, match="stop here"):
        creator.create_page_zim(
            BASE + "/", engine="alive", out_dir=str(tmp_path), user_agent="A/1", mobile=True, page_timeout=9
        )
    assert (seen["user_agent"], seen["mobile"], seen["page_timeout"]) == ("A/1", True, 9)


def test_a_singlefile_page_gets_the_agent(fixture_server, monkeypatch, tmp_path):
    import zimi.singlefile as singlefile

    cmds = []

    def fake_run(cmd, **_kw):
        if "--version" in cmd:
            return subprocess.CompletedProcess(cmd, 0, "1.0\n", "")
        cmds.append(cmd)
        with open(cmd[2], "w", encoding="utf-8") as fh:
            fh.write("<html><head><title>T</title></head><body>page text here</body></html>")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(singlefile.shutil, "which", lambda _x: "/bin/single-file")
    monkeypatch.setattr(singlefile.subprocess, "run", fake_run)
    monkeypatch.setattr(singlefile, "chromium_path", lambda: None)
    _page(tmp_path, INTRO, engine="singlefile", user_agent="One/1")
    assert "--user-agent=One/1" in cmds[0]


def test_zimit_is_handed_a_page_capture_s_agent_and_timeout(zimit_docker, tmp_path):
    creator.create_page_zim(
        "https://example.com/", engine="zimit", out_dir=str(tmp_path / "z"),
        user_agent="Z/1", mobile=True, page_timeout=30,
    )
    cmd = zimit_docker["runs"][0]
    assert cmd[cmd.index("--userAgent") + 1] == "Z/1"
    assert "--mobileDevice" in cmd and cmd[cmd.index("--pageLoadTimeout") + 1] == "30"


# ── the web ─────────────────────────────────────────────────────────────────

PAGE = {"mode": "page", "source": "https://www.example.org/a"}


def _opts(**fields):
    return manage._create_validate(dict(PAGE, **fields))[3]


def test_the_web_takes_the_fetch_options_for_a_page(data_dir):
    opts = _opts(
        user_agent="U/1", mobile=True, cookies="a=1", skip_types=["pdf", "video"], max_file_bytes="5M"
    )
    assert opts["user_agent"] == "U/1" and opts["mobile"] is True
    assert opts["cookies"] == "a=1" and opts["skip_types"] == ["video", "pdf"]
    assert opts["max_file_bytes"] == 5_000_000


def test_the_web_keeps_a_pages_options_to_a_pages_options(data_dir):
    opts = _opts(time_limit="1h", sitemap=True, workers=4, max_pages=5)
    for key in ("time_limit", "sitemap", "workers"):
        assert key not in opts


def test_the_web_drops_page_timeout_for_the_fast_engine_and_keeps_it_for_a_browser(
    data_dir, monkeypatch
):
    assert "page_timeout" not in _opts(page_timeout=30)
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    assert _opts(page_timeout=30, engine="rendered")["page_timeout"] == 30


def test_the_web_refuses_page_cookies_an_engine_cannot_take(data_dir, monkeypatch):
    monkeypatch.setattr(manage, "_create_singlefile_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_zimit_ready", lambda: True)
    for engine in ("singlefile", "zimit"):
        with pytest.raises(ValueError, match="which %s is not" % engine):
            _opts(engine=engine, cookies="a=1")


def test_stored_defaults_fill_a_page_capture(data_dir):
    _store(data_dir, user_agent="Stored/1", skip_types=["video"], max_file_bytes=1000,
           time_limit=60, mobile=True)
    opts = _opts()
    assert (opts["user_agent"], opts["skip_types"], opts["max_file_bytes"], opts["mobile"]) == (
        "Stored/1", ["video"], 1000, True,
    )
    assert "time_limit" not in opts
    own = _opts(user_agent="Own/1", skip_types=[])
    assert own["user_agent"] == "Own/1" and own["skip_types"] == []


def test_a_page_job_hands_the_options_to_the_engine(monkeypatch, data_dir):
    seen = {}
    monkeypatch.setattr(creator, "create_pages_zim", lambda urls, **kw: seen.update(kw) or {})
    monkeypatch.setattr(manage, "_create_allows_private", lambda: True)
    manage._create_run(
        manage._CreateJob("page", PAGE["source"], None),
        _opts(user_agent="U/1", cookies="a=1", skip_types="pdf", max_file_bytes="1M", mobile=True),
    )
    assert (seen["user_agent"], seen["cookies"], seen["skip_types"]) == ("U/1", "a=1", ["pdf"])
    assert seen["max_file_bytes"] == 1_000_000 and seen["mobile"] is True


def test_a_page_jobs_echo_never_shows_the_cookie():
    assert crawler.redacted_request(dict(PAGE, cookies=HEADER))["cookies"] == "set"


# ── the CLI ─────────────────────────────────────────────────────────────────


def test_cli_a_page_takes_cookies_and_leaves_things_out(fixture_server, tmp_path):
    done = _cli(
        tmp_path, BASE + MEDIA, "--cookies", HEADER, "--skip", "video,audio",
        "--user-agent", "Cli/1", "--max-file-size", "100k",
    )
    assert done.returncode == 0, done.stderr
    assert _cookie_log("127.0.0.1") == {HEADER} and _cookie_log("localhost") == {None}
    assert set(AGENTS) == {"Cli/1"}
    assert "left out" in done.stdout and SESSION not in done.stdout + done.stderr
    # (The live picture's own visit to the page still loads what the page asks
    # for; it is the ZIM that leaves it out.)
    arc = Archive(str(tmp_path / "x.zim"))
    assert "_assets/127_0_0_1/r2/clip.mp4" not in _paths(arc)
    assert "_assets/127_0_0_1/r2/small.png" in _paths(arc)


def test_cli_several_pages_take_them_too(fixture_server, tmp_path):
    done = _cli(tmp_path, INTRO, BASE + "/docs/next.html", "--cookies", HEADER, "--user-agent", "Cli/2")
    assert done.returncode == 0, done.stderr
    assert _cookie_log("127.0.0.1") == {HEADER} and set(AGENTS) == {"Cli/2"}


def test_cli_still_asks_for_site_where_a_walk_is_meant(tmp_path):
    for flag, value in (("--time-limit", "1h"), ("--sitemap", None), ("--workers", "2")):
        done = _cli(tmp_path, "https://example.com/", flag, *([value] if value else []), offline=True)
        assert done.returncode != 0
        assert f"{flag} needs --site" in done.stdout + done.stderr, flag


def test_cli_refuses_what_a_page_engine_cannot_take(tmp_path):
    for flags, message in (
        (("--page-timeout", "5"), "--page-timeout applies to the engines that drive a browser"),
        (("--engine", "zimit", "--cookies", "a=1"), "--cookies applies to the fast, rendered and alive"),
        (("--engine", "singlefile", "--cookies", "a=1"), "--cookies applies to the fast, rendered and alive"),
    ):
        done = _cli(tmp_path, "https://example.com/", *flags, offline=True)
        assert done.returncode != 0, flags
        assert message in done.stdout + done.stderr, flags
    done = _cli(tmp_path, "https://a.test/", "https://b.test/", "--page-timeout", "5", offline=True)
    assert "--page-timeout applies to the engines that drive a browser" in done.stdout + done.stderr


def test_cli_a_folder_still_refuses_them(tmp_path):
    folder = tmp_path / "f"
    folder.mkdir()
    (folder / "index.html").write_text("<html><body>x</body></html>", encoding="utf-8")
    done = _cli(tmp_path, str(folder), "--cookies", "a=1")
    assert done.returncode != 0 and "only applies to a URL capture" in done.stdout + done.stderr


def test_cli_a_stored_default_reaches_a_page(fixture_server, tmp_path):
    (tmp_path / "cli-data").mkdir()
    (tmp_path / "cli-data" / "create_defaults.json").write_text(
        json.dumps({"user_agent": "Stored/9"}), encoding="utf-8"
    )
    done = _cli(tmp_path, INTRO)
    assert done.returncode == 0, done.stderr
    assert set(AGENTS) == {"Stored/9"}
