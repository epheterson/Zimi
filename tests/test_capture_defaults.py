"""Stored capture defaults and the command line.

The defaults file (create_defaults.json) is checked by the same table as a
capture's own values: precedence, validation on write and on read, the
Manage API, and `zimi create` reading the same file. The options themselves
are in test_capture_options.py.
"""

import argparse
import json
import os
import subprocess
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.server as _srv  # noqa: E402
from tests.test_create_routes import _get, _post, clean_job  # noqa: E402,F401
from tests.test_creator_site import (  # noqa: E402,F401
    AGENTS,
    BASE,
    REPO_ROOT,
    REQUESTS,
    _clean,
    fixture_server,
    zimit_docker,
)

SITE = {"mode": "site", "source": "https://www.example.org/docs/"}


# ── stored defaults ─────────────────────────────────────────────────────────


def test_the_two_ceilings_manage_mirrors_are_the_tables():
    assert manage.CREATE_MAX_DEPTH_CEILING == crawler.MAX_DEPTH_CEILING
    assert manage.CREATE_MAX_DELAY == crawler.MAX_DELAY


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    path.mkdir(exist_ok=True)
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(path))
    return path


def _store(data_dir, **values):
    (data_dir / "create_defaults.json").write_text(json.dumps(values), encoding="utf-8")


def _opts(**fields):
    return manage._create_validate(dict(SITE, **fields))[3]


def test_a_stored_default_fills_what_a_capture_leaves_unsaid(data_dir):
    _store(
        data_dir,
        time_limit=28800,
        mobile=True,
        user_agent="Stored/1",
        scope="host",
        max_pages=50,
        delay=1.5,
    )
    opts = _opts()
    assert opts["time_limit"] == 28800 and opts["mobile"] is True
    assert opts["user_agent"] == "Stored/1" and opts["scope"] == "host"
    assert opts["max_pages"] == 50 and opts["delay"] == 1.5


def test_the_captures_own_value_beats_the_stored_default(data_dir):
    _store(data_dir, time_limit=28800, mobile=True, user_agent="Stored/1", max_pages=50)
    opts = _opts(time_limit="30m", mobile=False, user_agent="Mine/2", max_pages=5)
    assert opts["time_limit"] == 1800 and opts["mobile"] is False
    assert opts["user_agent"] == "Mine/2" and opts["max_pages"] == 5


def test_no_default_and_no_value_is_the_factory(data_dir):
    opts = _opts()
    for key in crawler.NEW_OPTION_KEYS:
        assert key not in opts


def test_a_default_an_engine_cannot_honor_is_not_applied(data_dir):
    _store(data_dir, page_timeout=60, max_bytes=1000)
    assert "page_timeout" not in _opts() and "max_bytes" in _opts()
    assert _opts(engine="zimit")["page_timeout"] == 60
    assert _opts(engine="zimit")["max_bytes"] is None


def test_a_hand_edited_bad_default_falls_back(data_dir):
    _store(
        data_dir,
        time_limit="whenever",
        mobile="yes",
        page_timeout=-3,
        user_agent="ok/1",
        sitemap="http://x.org/m.xml",
    )
    stored = crawler.stored_defaults()
    assert stored == {"user_agent": "ok/1"}  # a sitemap address is not a default
    assert "time_limit" not in _opts()


def test_not_everything_can_be_stored(data_dir):
    for key in ("include", "exclude", "extra_hops", "ignore_robots", "nonsense"):
        r = _post("/manage/creator", {key: 1})
        assert r.status == 400, key
    assert not (data_dir / "create_defaults.json").exists()


@pytest.mark.parametrize(
    "update",
    [
        {"time_limit": "soon"},
        {"mobile": "yes"},
        {"user_agent": "bad\nagent"},
        {"page_timeout": 0},
        {"sitemap": "https://example.org/m.xml"},
        {"scope": "planet"},
        {"max_depth": 99},
        {"delay": 500},
        {"max_bytes": "lots"},
        {"block_ads": "yes"},
    ],
)
def test_a_bad_default_is_a_400_with_a_plain_message(data_dir, update):
    r = _post("/manage/creator", update)
    assert r.status == 400 and r.body["error"] and "Traceback" not in r.body["error"]
    assert not (data_dir / "create_defaults.json").exists()


def test_defaults_are_stored_validated_shown_and_cleared(data_dir):
    r = _post(
        "/manage/creator",
        {
            "time_limit": "8h",
            "mobile": True,
            "page_timeout": "60",
            "max_bytes": "2G",
            "sitemap": True,
            "block_ads": False,
        },
    )
    assert r.status == 200
    assert (
        r.body["defaults"]["time_limit"] == 28800
        and r.body["defaults"]["page_timeout"] == 60
    )
    assert r.body["defaults"]["max_bytes"] == 2 * 1000**3
    assert (
        r.body["defaults_text"]["time_limit"] == "8h"
        and r.body["defaults_text"]["max_bytes"] == "2.0 GB"
    )
    assert r.body["block_ads_default"] is False
    stored = json.loads((data_dir / "create_defaults.json").read_text(encoding="utf-8"))
    assert stored["time_limit"] == 28800 and stored["sitemap"] is True
    # Setting one never drops another, and "" clears.
    r = _post("/manage/creator", {"mobile": ""})
    assert (
        "mobile" not in r.body["defaults"] and r.body["defaults"]["time_limit"] == 28800
    )
    shown = _get("/manage/creator").body
    assert (
        shown["defaults"]["time_limit"] == 28800
        and shown["defaults_text"]["time_limit"] == "8h"
    )


def test_the_create_page_is_told_the_defaults_but_not_the_admins_one(
    data_dir, monkeypatch
):
    _store(data_dir, time_limit=28800, allow_private=True)
    view = manage._create_defaults_view()
    assert view["defaults"]["allow_private"] is True  # Manage shows it
    status = _get("/manage/create/status", params={"probe": "1"}).body
    assert status["defaults"]["time_limit"] == 28800
    assert (
        "allow_private" not in status["defaults"]
        and "allow_private" not in status["defaults_text"]
    )


def test_the_web_refuses_what_the_engine_cannot_honor_without_failing(data_dir):
    opts = _opts(engine="builtin", page_timeout=30, time_limit="1h")
    assert "page_timeout" not in opts and opts["time_limit"] == 3600
    for fields, said in (
        ({"time_limit": "soon"}, "not a time limit"),
        ({"user_agent": "a\nb"}, "user agent"),
        ({"sitemap": "gopher://x"}, "sitemap"),
    ):
        with pytest.raises(ValueError, match=said):
            _opts(**fields)


def test_a_job_hands_the_options_to_the_engine(monkeypatch, data_dir):
    seen = {}
    monkeypatch.setattr(
        crawler, "create_site_zim", lambda url, **kw: seen.update(kw) or {}
    )
    monkeypatch.setattr(manage, "_create_allows_private", lambda: True)
    manage._create_run(
        manage._CreateJob("site", SITE["source"], None),
        _opts(time_limit="90m", sitemap=True, user_agent="U/1", mobile=True),
    )
    assert (
        seen["time_limit"],
        seen["sitemap"],
        seen["user_agent"],
        seen["mobile"],
    ) == (5400, True, "U/1", True)


# ── the CLI ─────────────────────────────────────────────────────────────────


def _cli(tmp_path, *args, extra_env=None, offline=False, out="x.zim"):
    env = {
        **os.environ,
        "ZIMI_TORRENT": "0",
        "ZIMI_DATA_DIR": str(tmp_path / "cli-data"),
        **(extra_env or {}),
    }
    if offline:
        env["ZIMI_OFFLINE"] = "1"
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "zimi",
            "create",
            *args,
            "--out",
            str(tmp_path / out),
        ],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=180,
        env=env,
    )


def test_cli_flags_reach_the_crawl(fixture_server, tmp_path):
    done = _cli(
        tmp_path,
        BASE + "/",
        "--site",
        "--sitemap",
        "--user-agent",
        "Cli/1",
        "--delay",
        "0",
        "--time-limit",
        "10m",
        "--max-pages",
        "4",
    )
    assert done.returncode == 0, done.stderr
    assert "/sitemap.xml" in REQUESTS and set(AGENTS) == {"Cli/1"}


def test_cli_mobile_and_a_sitemap_address(fixture_server, tmp_path):
    done = _cli(
        tmp_path,
        BASE + "/",
        "--site",
        "--mobile",
        "--sitemap",
        BASE + "/custom-map.xml",
        "--delay",
        "0",
        "--max-pages",
        "3",
    )
    assert done.returncode == 0, done.stderr
    assert "/custom-map.xml" in REQUESTS and all("iPhone" in a for a in AGENTS)


def test_cli_a_time_limit_stops_the_crawl(fixture_server, tmp_path):
    done = _cli(
        tmp_path,
        BASE + "/chain/0.html",
        "--site",
        "--delay",
        "0.5",
        "--time-limit",
        "1s",
    )
    assert done.returncode == 0, done.stderr
    assert "time limit (1s)" in done.stdout


def test_cli_reads_the_stored_defaults_and_a_flag_beats_them(fixture_server, tmp_path):
    (tmp_path / "cli-data").mkdir()
    (tmp_path / "cli-data" / "create_defaults.json").write_text(
        json.dumps(
            {"user_agent": "Stored/1", "sitemap": True, "max_pages": 3, "delay": 0}
        ),
        encoding="utf-8",
    )
    done = _cli(tmp_path, BASE + "/", "--site")
    assert done.returncode == 0, done.stderr
    assert set(AGENTS) == {"Stored/1"} and "/sitemap.xml" in REQUESTS
    AGENTS.clear()
    REQUESTS.clear()
    done = _cli(
        tmp_path,
        BASE + "/",
        "--site",
        "--user-agent",
        "Flag/1",
        "--no-sitemap",
        out="y.zim",
    )
    assert done.returncode == 0, done.stderr
    assert set(AGENTS) == {"Flag/1"} and "/sitemap.xml" not in REQUESTS


def test_cli_refuses_what_the_engine_or_the_shape_cannot_take(tmp_path):
    done = _cli(
        tmp_path, "https://example.com/", "--site", "--page-timeout", "30", offline=True
    )
    assert done.returncode != 0
    assert (
        "--page-timeout applies to the engines that drive a browser"
        in done.stdout + done.stderr
    )
    for flag, value in (
        ("--time-limit", "1h"),
        ("--sitemap", None),
        ("--workers", "2"),
    ):
        done = _cli(
            tmp_path,
            "https://example.com/",
            flag,
            *([value] if value else []),
            "--engine",
            "rendered",
            offline=True,
        )
        assert done.returncode != 0
        assert f"{flag} needs --site" in done.stdout + done.stderr, flag
    done = _cli(
        tmp_path, "https://example.com/", "--site", "--time-limit", "soon", offline=True
    )
    assert done.returncode != 0 and "not a time limit" in done.stdout + done.stderr


def test_cli_options_reach_zimit(zimit_docker, tmp_path):
    args = argparse.Namespace(
        site=True,
        engine="zimit",
        title=None,
        description=None,
        language="eng",
        creator="Zimi",
        out=str(tmp_path / "x.zim"),
        max_pages=None,
        max_depth=None,
        scope=None,
        include=None,
        exclude=None,
        extra_hops=None,
        time_limit="2h",
        sitemap=True,
        user_agent=None,
        mobile=True,
        page_timeout="45",
    )
    creator._build_from_args(args, "https://example.com/", True)
    cmd = zimit_docker["runs"][0]
    assert cmd[cmd.index("--timeLimit") + 1] == "7200"
    assert cmd[cmd.index("--pageLoadTimeout") + 1] == "45"
    assert (
        "--useSitemap" in cmd and "--mobileDevice" in cmd and "--userAgent" not in cmd
    )
