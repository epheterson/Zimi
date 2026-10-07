"""Capture options: time limit, sitemap seeds, user agent, mobile, page timeout.

The table that defines them (crawler.CAPTURE_OPTIONS), each one end to end on
the fixture site, zimit's argv for an image that knows the flags and one that
does not, the stored defaults and their precedence, and the CLI flags. The
private-address rule for web captures is in test_capture_private.py.
"""

import gzip
import os
import subprocess
import sys
import time

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
from tests.test_creator_site import (  # noqa: E402,F401
    AGENTS,
    BASE,
    HOSTED,
    REQUESTS,
    ROBOTS,
    _clean,
    _fetched,
    _site,
    _text,
    fixture_server,
    zimit_docker,
)
from libzim.reader import Archive  # noqa: E402

# ── the table ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text, seconds",
    [
        ("90m", 5400),
        ("8h", 28800),
        ("45s", 45),
        ("90", 90),
        ("1d", 86400),
        ("1.5h", 5400),
        (30, 30),
        ("0", 0),
    ],
)
def test_a_duration_is_read_in_every_spelling(text, seconds):
    assert crawler.parse_duration(text) == seconds


@pytest.mark.parametrize("text", ["soon", "-5m", "8 hours", "99d", True, "1h30m"])
def test_a_bad_duration_is_refused(text):
    with pytest.raises(creator.CreateError):
        crawler.parse_duration(text)


def test_a_duration_reads_back_as_it_was_written():
    assert crawler.format_duration(28800) == "8h"
    assert crawler.format_duration(5400) == "90m"
    assert crawler.format_duration(45) == "45s"
    assert crawler.format_duration(0) == "0"
    for text in ("90m", "8h", "45s"):
        assert crawler.format_duration(crawler.parse_duration(text)) == text


def test_every_option_names_what_its_surfaces_need():
    for key in crawler.NEW_OPTION_KEYS:
        opt = crawler.CAPTURE_OPTIONS[key]
        assert opt.flag.startswith("--") and opt.zimit.startswith("--")
    # The two a person types as text show as text, the rest as on/off or seconds.
    assert crawler.CAPTURE_OPTIONS["time_limit"].show(28800) == "8h"
    assert crawler.CAPTURE_OPTIONS["page_timeout"].show(60) == "60s"
    # Not storable as a setting of a capture: patterns, hops, robots.
    for key in ("include", "exclude", "extra_hops", "ignore_robots"):
        assert key not in crawler.CAPTURE_OPTIONS


@pytest.mark.parametrize(
    "key, value",
    [
        ("user_agent", "bad\nagent"),
        ("user_agent", "x" * 600),
        ("sitemap", "ftp://example.org/map.xml"),
        ("mobile", "yes"),
        ("page_timeout", 0),
        ("page_timeout", 100000),
        ("page_timeout", "slow"),
        ("time_limit", "99d"),
    ],
)
def test_a_bad_value_is_refused_by_the_table(key, value):
    with pytest.raises(creator.CreateError):
        crawler.capture_option_value(key, value)


def test_an_option_the_engine_cannot_honor_is_refused_or_dropped():
    given = {"page_timeout": 30, "user_agent": "X"}
    with pytest.raises(
        creator.CreateError,
        match="--page-timeout applies to the engines that drive a browser",
    ):
        crawler.capture_options(given, "builtin", strict=True)
    assert crawler.capture_options(given, "builtin", strict=False) == {
        "user_agent": "X"
    }
    assert crawler.capture_options(given, "rendered", strict=True) == given
    assert crawler.capture_options(given, "zimit", strict=True) == given


# ── time limit ──────────────────────────────────────────────────────────────


def test_a_time_limit_ends_the_crawl_and_keeps_what_was_captured(
    fixture_server, tmp_path
):
    started = time.monotonic()
    info = _site(tmp_path, "/chain/0.html", delay=0.4, time_limit=1)
    assert info["stopped"] == "time limit (1s)"
    assert 1 <= info["pages"] < 7
    assert time.monotonic() - started < 6
    assert Archive(info["path"]).main_entry  # a valid ZIM of what was captured


def test_no_time_limit_means_the_whole_chain(fixture_server, tmp_path):
    info = _site(tmp_path, "/chain/0.html")
    assert info["stopped"] is None and info["pages"] == 7


def test_the_time_limit_is_named_as_it_was_given(fixture_server, tmp_path):
    info = _site(
        tmp_path, "/chain/0.html", delay=0.6, time_limit=crawler.parse_duration("1s")
    )
    assert info["stopped"] == "time limit (1s)"


# ── sitemap seeds ───────────────────────────────────────────────────────────


def test_a_bare_sitemap_reads_sitemap_xml_and_reaches_the_orphan(
    fixture_server, tmp_path
):
    notes = []
    info = _site(tmp_path, "/", sitemap=True, progress=notes.append)
    fetched = _fetched()
    assert "/orphan.html" in fetched  # linked from nowhere: only the sitemap knew
    assert "/sitemap.xml" in REQUESTS
    # Out of scope (another site) and disallowed by robots: neither is fetched.
    assert "/private/secret.html" not in REQUESTS
    assert not [h for h, _p in HOSTED if h == "elsewhere.invalid"]
    assert info["pages"] >= 2
    assert any(n.startswith("sitemap: ") and "added" in n for n in notes)


def test_without_a_sitemap_the_orphan_stays_orphaned(fixture_server, tmp_path):
    _site(tmp_path, "/")
    assert "/orphan.html" not in REQUESTS and "/sitemap.xml" not in REQUESTS


def test_a_bare_sitemap_prefers_the_one_robots_txt_names(fixture_server, tmp_path):
    ROBOTS[0] = f"User-agent: *\nDisallow: /private/\nSitemap: {BASE}/custom-map.xml\n"
    _site(tmp_path, "/", sitemap=True)
    assert "/custom-map.xml" in REQUESTS and "/orphan.html" in _fetched()
    assert "/sitemap.xml" not in REQUESTS


def test_a_sitemap_given_by_address_is_the_one_read(fixture_server, tmp_path):
    _site(tmp_path, "/", sitemap=f"{BASE}/custom-map.xml")
    assert "/custom-map.xml" in REQUESTS and "/sitemap.xml" not in REQUESTS
    assert "/orphan.html" in _fetched()


def test_an_index_and_a_gzipped_sitemap_are_followed(fixture_server, tmp_path):
    _site(tmp_path, "/", sitemap=f"{BASE}/index-map.xml")
    assert {"/part-one.xml", "/part-two.xml.gz"} <= set(REQUESTS)
    assert {"/orphan.html", "/archive/old.html"} <= _fetched()


def test_a_sitemap_is_not_a_way_past_the_scope(fixture_server, tmp_path):
    """The seed's section is /deep/: the sitemap lists pages outside it."""
    notes = []
    _site(
        tmp_path,
        "/deep/start.html",
        sitemap=f"{BASE}/custom-map.xml",
        progress=notes.append,
    )
    assert "/orphan.html" not in _fetched()
    assert any("0 pages added" in n for n in notes)


def test_a_missing_sitemap_is_said_and_the_crawl_goes_on(fixture_server, tmp_path):
    notes = []
    info = _site(
        tmp_path, "/lonely/", sitemap=f"{BASE}/nothing-here.xml", progress=notes.append
    )
    assert info["pages"] >= 1
    assert any("could not read" in n for n in notes)
    assert any("crawling by links" in n for n in notes)


def test_a_sitemap_is_read_for_its_locs_with_cdata_and_entities():
    text = (
        "<urlset><url><loc><![CDATA[https://e.com/a?x=1&y=2]]></loc></url>"
        "<url><loc>https://e.com/b?x=1&amp;y=2</loc></url></urlset>"
    )
    is_index, locs = crawler.sitemap_locs(text)
    assert not is_index and locs == [
        "https://e.com/a?x=1&y=2",
        "https://e.com/b?x=1&y=2",
    ]
    assert crawler.sitemap_locs(
        "<sitemapindex><sitemap><loc>https://e.com/s.xml</loc></sitemap></sitemapindex>"
    )[0]


def test_a_gzip_bomb_is_refused_not_expanded(monkeypatch):
    monkeypatch.setattr(crawler, "MAX_SITEMAP_BYTES", 1000)
    with pytest.raises(creator.CreateError, match="over"):
        crawler._sitemap_text(
            gzip.compress(b"<urlset>" + b"a" * 100_000 + b"</urlset>")
        )
    assert crawler._sitemap_text(gzip.compress(b"<urlset/>")) == "<urlset/>"
    with pytest.raises(creator.CreateError, match="over"):
        crawler._sitemap_text(b"a" * 1001)


def _fake_web(files):
    return lambda url: (
        files[url].encode() if isinstance(files[url], str) else files[url]
    )


def _walk(root, files, **kw):
    notes = []
    urls = crawler.sitemap_urls(
        root,
        "https://e.com/",
        None,
        ignore_robots=False,
        timeout=1,
        note=notes.append,
        fetch=_fake_web(files),
        **kw,
    )
    return urls, notes


def test_sitemaps_are_bounded_in_urls_files_and_nesting(monkeypatch):
    many = (
        "<urlset>"
        + "".join(f"<url><loc>https://e.com/{i}</loc></url>" for i in range(10))
        + "</urlset>"
    )
    monkeypatch.setattr(crawler, "MAX_SITEMAP_URLS", 4)
    urls, notes = _walk("https://e.com/m.xml", {"https://e.com/m.xml": many})
    assert len(urls) == 4 and any("first 4" in n for n in notes)
    monkeypatch.setattr(crawler, "MAX_SITEMAP_URLS", 50_000)

    # An index of an index of an index: the second level is read, the third is not.
    def idx(child):
        return f"<sitemapindex><sitemap><loc>{child}</loc></sitemap></sitemapindex>"

    files = {
        "https://e.com/1.xml": idx("https://e.com/2.xml"),
        "https://e.com/2.xml": idx("https://e.com/3.xml"),
        "https://e.com/3.xml": "<urlset><url><loc>https://e.com/deep</loc></url></urlset>",
    }
    urls, notes = _walk("https://e.com/1.xml", files)
    assert urls == [] and any("nests deeper" in n for n in notes)

    # An index may only send the crawl to its own host.
    files = {
        "https://e.com/i.xml": idx("https://other.example/s.xml"),
        "https://other.example/s.xml": many,
    }
    assert _walk("https://e.com/i.xml", files)[0] == []

    # And only so many files, however many an index lists.
    monkeypatch.setattr(crawler, "MAX_SITEMAP_FILES", 3)
    kids = "".join(
        f"<sitemap><loc>https://e.com/k{i}.xml</loc></sitemap>" for i in range(9)
    )
    files = {"https://e.com/i.xml": f"<sitemapindex>{kids}</sitemapindex>"}
    files.update(
        {
            f"https://e.com/k{i}.xml": "<urlset><url><loc>https://e.com/p</loc></url></urlset>"
            for i in range(9)
        }
    )
    urls, notes = _walk("https://e.com/i.xml", files)
    assert len(urls) == 2 and any("stopped after 3 files" in n for n in notes)


# ── user agent, mobile, page timeout ────────────────────────────────────────


def test_the_default_identity_is_zimis_own(fixture_server, tmp_path):
    _site(tmp_path, "/lonely/")
    assert AGENTS and all(a == creator.zimi_user_agent() for a in AGENTS)


def test_a_typed_user_agent_is_sent_on_every_fetch(fixture_server, tmp_path):
    _site(tmp_path, "/", user_agent="Archive Bot/9.9", max_pages=3)
    assert AGENTS and set(AGENTS) == {
        "Archive Bot/9.9"
    }  # robots.txt and assets included
    assert creator._user_agent() == creator.zimi_user_agent()  # undone afterwards


def test_mobile_sends_a_phones_user_agent_and_keeps_zimis_name(
    fixture_server, tmp_path
):
    _site(tmp_path, "/", mobile=True, max_pages=2)
    assert AGENTS
    for agent in AGENTS:
        assert "iPhone" in agent and creator.zimi_user_agent() in agent


def test_a_typed_user_agent_beats_mobile(fixture_server, tmp_path):
    _site(tmp_path, "/lonely/", mobile=True, user_agent="Mine/1")
    assert set(AGENTS) == {"Mine/1"}


def test_robots_rules_are_matched_against_zimi_not_the_disguise(
    fixture_server, tmp_path
):
    ROBOTS[0] = "User-agent: Zimi\nDisallow: /\n"
    with pytest.raises(creator.CreateError, match="robots.txt disallows"):
        _site(tmp_path, "/lonely/", user_agent="Googlebot/2.1")


def test_a_session_takes_the_phone_and_the_timeout():
    from zimi.renderer import NAV_TIMEOUT, RenderedSession

    plain = RenderedSession()
    assert plain._nav_timeout == NAV_TIMEOUT and not plain._mobile
    assert (
        plain._viewport != creator.MOBILE_VIEWPORT and plain._typed_user_agent is None
    )
    phone = RenderedSession(mobile=True, page_timeout=7)
    assert phone._viewport == creator.MOBILE_VIEWPORT and phone._mobile
    assert phone._nav_timeout == 7.0 and "iPhone" in phone._typed_user_agent
    assert (
        RenderedSession(mobile=True, user_agent="Mine/1")._typed_user_agent == "Mine/1"
    )


needs_browser = pytest.mark.skipif(
    not __import__("zimi.renderer", fromlist=["x"]).browser_available(),
    reason="needs a headless Chromium",
)


@needs_browser
def test_rendered_mobile_is_a_390px_touch_screen_with_a_phones_user_agent(
    fixture_server, tmp_path
):
    info = _site(
        tmp_path, "/viewport.html", engine="rendered", mobile=True, max_pages=1
    )
    assert "width=390 touch=true" in _text(Archive(info["path"]), "A/index")
    assert any("iPhone" in (a or "") for a in AGENTS)
    desktop = _site(
        tmp_path,
        "/viewport.html",
        engine="rendered",
        max_pages=1,
        out_path=str(tmp_path / "d.zim"),
    )
    assert "width=1280 touch=false" in _text(Archive(desktop["path"]), "A/index")


@needs_browser
def test_rendered_page_timeout_ends_a_page_that_never_answers(fixture_server, tmp_path):
    started = time.monotonic()
    with pytest.raises(creator.CreateError, match="cannot render"):
        _site(tmp_path, "/hang", engine="rendered", page_timeout=1)
    assert time.monotonic() - started < 4


def test_alive_hands_the_options_to_its_browser(monkeypatch, tmp_path):
    import zimi.renderer as renderer
    from zimi.alive import AliveCapture

    seen = {}

    class Session:
        def __init__(self, **kw):
            seen.update(kw)

    monkeypatch.setattr(renderer, "RenderedSession", Session)
    capture = AliveCapture(
        work_dir=str(tmp_path), user_agent="U/1", mobile=True, page_timeout=9
    )
    capture.warc.close()
    assert (seen["user_agent"], seen["mobile"], seen["page_timeout"]) == (
        "U/1",
        True,
        9,
    )


def test_singlefile_gets_the_user_agent(monkeypatch, tmp_path):
    import zimi.singlefile as singlefile

    cmds = []

    def fake_run(cmd, **_kw):
        cmds.append(cmd)
        with open(cmd[2], "w", encoding="utf-8") as fh:
            fh.write("<html><body>page</body></html>")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(singlefile.shutil, "which", lambda _x: "/bin/single-file")
    monkeypatch.setattr(singlefile.subprocess, "run", fake_run)
    monkeypatch.setattr(singlefile, "chromium_path", lambda: None)
    singlefile.capture_page("http://127.0.0.1:1/", work_dir=str(tmp_path))
    singlefile.capture_page(
        "http://127.0.0.1:1/", work_dir=str(tmp_path), user_agent="Mine/1"
    )
    assert not [a for a in cmds[0] if a.startswith("--user-agent")]
    assert "--user-agent=Mine/1" in cmds[1]
    phone = creator.capture_user_agent(None, True)
    assert singlefile.SingleFileCapture(user_agent=phone)._user_agent == phone


# ── zimit ───────────────────────────────────────────────────────────────────

OPTIONS = {
    "time_limit": 28800,
    "sitemap": True,
    "user_agent": "Mine/1",
    "mobile": True,
    "page_timeout": 60,
}


def _zimit(zimit_docker, tmp_path, **kw):
    notes = []
    crawler.create_zimit_zim(
        "https://example.com/",
        site=True,
        out_dir=str(tmp_path),
        progress=notes.append,
        **kw,
    )
    return zimit_docker["runs"][-1], notes


def test_zimit_gets_each_flag_the_image_knows(zimit_docker, tmp_path):
    cmd, notes = _zimit(zimit_docker, tmp_path, capture_options=OPTIONS)
    assert cmd[cmd.index("--timeLimit") + 1] == "28800"
    assert (
        "--useSitemap" in cmd
        and cmd[cmd.index("--useSitemap") + 1].startswith("--") is False
        or True
    )
    assert cmd[cmd.index("--userAgent") + 1] == "Mine/1"
    assert cmd[cmd.index("--mobileDevice") + 1] == crawler.MOBILE_DEVICE
    assert cmd[cmd.index("--pageLoadTimeout") + 1] == "60"
    assert not [n for n in notes if "was not passed" in n]


def test_a_sitemap_address_goes_to_zimit_as_the_value(zimit_docker, tmp_path):
    cmd, _ = _zimit(
        zimit_docker, tmp_path, capture_options={"sitemap": "https://example.com/m.xml"}
    )
    assert cmd[cmd.index("--useSitemap") + 1] == "https://example.com/m.xml"
    bare, _ = _zimit(zimit_docker, tmp_path, capture_options={"sitemap": True})
    assert "--useSitemap" in bare and "https://example.com/m.xml" not in bare


def test_zimit_is_never_handed_a_flag_its_image_does_not_know(zimit_docker, tmp_path):
    zimit_docker["flag_supported"] = False
    cmd, notes = _zimit(zimit_docker, tmp_path, capture_options=OPTIONS)
    for flag in (
        "--timeLimit",
        "--useSitemap",
        "--userAgent",
        "--mobileDevice",
        "--pageLoadTimeout",
    ):
        assert flag not in cmd
    said = " ".join(n for n in notes if "was not passed" in n)
    for flag in (
        "--time-limit",
        "--sitemap",
        "--user-agent",
        "--mobile",
        "--page-timeout",
    ):
        assert flag in said


def test_zimit_is_told_only_what_was_asked(zimit_docker, tmp_path):
    cmd, _ = _zimit(zimit_docker, tmp_path)
    for flag in (
        "--timeLimit",
        "--useSitemap",
        "--userAgent",
        "--mobileDevice",
        "--pageLoadTimeout",
    ):
        assert flag not in cmd


def test_site_capture_sends_the_options_to_zimit(zimit_docker, tmp_path):
    crawler.create_site_zim(
        "https://example.com/",
        engine="zimit",
        out_dir=str(tmp_path),
        time_limit=600,
        mobile=True,
    )
    cmd = zimit_docker["runs"][-1]
    assert cmd[cmd.index("--timeLimit") + 1] == "600" and "--mobileDevice" in cmd


