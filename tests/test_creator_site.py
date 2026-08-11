"""`zimi create <url> --site` — a bounded same-origin crawl becomes one ZIM,
and `--engine zimit` orchestrates openZIM's container.

Every request goes to a local fixture site on port 8894; nothing here touches
the real network, and the zimit tests replace the docker seams outright so no
image is ever pulled. Real end-to-end otherwise: the built .zim is read back
with libzim's Archive.
"""

import http.server
import os
import signal
import subprocess
import sys
import threading
from typing import List, Optional

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from libzim.reader import Archive  # noqa: E402

import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.server as _srv  # noqa: E402

PORT = 8894
HOST = "127.0.0.1"
BASE = f"http://{HOST}:{PORT}"
NS = "_assets/127_0_0_1"  # _slug() of the fixture hostname

DEFAULT_ROBOTS = "User-agent: *\nDisallow: /private/\n"

# Every request the fixture site served, so a test can assert what the crawl
# did NOT fetch — the interesting half of a bounded crawler's behavior.
REQUESTS = []
ROBOTS: List[Optional[str]] = [DEFAULT_ROBOTS]


def _page(body, *, css=True):
    head = '<link rel="stylesheet" href="/static/site.css">' if css else ""
    return (
        f"<html><head><title>Fixture</title>{head}</head><body>"
        "<p>A paragraph of server-rendered prose, which is the whole point of "
        "the builtin engine: it exists in the HTML before any script runs.</p>"
        f"{body}</body></html>"
    ).encode()


INDEX = _page(
    '<h1>Home</h1><img src="/img/logo.png">'
    '<a href="/docs/intro.html">intro</a>'
    '<a href="/chain/0.html">chain</a>'
    '<a href="/private/secret.html">private</a>'
    '<a href="/trap?sid=1">trap</a>'
    '<a href="/list">list</a>'
    '<a href="/list?page=2">list page 2</a>'
    '<a href="/data.bin">a download</a>'
    '<a href="/img/logo.png">the logo itself</a>'
    '<a href="https://elsewhere.invalid/x">off site</a>'
    '<a href="mailto:x@y.z">mail</a>'
    '<a href="#top">top</a>'
)

INTRO = _page(
    '<h1>Intro</h1><img src="/img/logo.png">'
    '<a href="/">home</a><a href="/docs/next.html">next</a>'
    '<a href="/#top">home anchor</a>'
)

SPA = b"""<html><head><title>App</title></head>
<body><div id="root"></div><script src="/bundle.js"></script></body></html>"""

ROUTES = {
    "/": ("text/html; charset=utf-8", INDEX),
    "/docs/intro.html": ("text/html; charset=utf-8", INTRO),
    "/docs/next.html": ("text/html; charset=utf-8", _page("<h1>Next</h1>")),
    "/private/secret.html": ("text/html; charset=utf-8", _page("<h1>Secret</h1>")),
    "/trap": (
        "text/html; charset=utf-8",
        _page(
            '<a href="/trap?sid=2">a</a><a href="/trap?sid=3">b</a>'
            '<a href="/trap?sort=desc">c</a>'
        ),
    ),
    "/list": ("text/html; charset=utf-8", _page("<h1>List page 1</h1>")),
    "/list?page=2": ("text/html; charset=utf-8", _page("<h1>List page 2</h1>")),
    "/spa.html": ("text/html; charset=utf-8", SPA),
    "/data.bin": ("application/octet-stream", b"\x00\x01\x02"),
    "/img/logo.png": ("image/png", b"LOGOBYTES"),
    "/static/site.css": ("text/css", b"body{background:url('bg.png')}"),
    "/static/bg.png": ("image/png", b"BGBYTES"),
    "/away": ("redirect", b"https://elsewhere.invalid/gone"),
    "/moved": ("redirect", b"/docs/next.html"),
}
# A link chain deep enough to exercise --max-depth without the seed's other
# links muddying the count.
for _i in range(7):
    ROUTES[f"/chain/{_i}.html"] = (
        "text/html; charset=utf-8",
        _page(f'<h1>Link {_i}</h1><a href="/chain/{_i + 1}.html">onward</a>'),
    )


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        REQUESTS.append(self.path)
        if self.path == "/robots.txt":
            body = ROBOTS[0]
            if body is None:
                self.send_error(404)
                return
            self._send("text/plain", body.encode())
            return
        route = ROUTES.get(self.path) or ROUTES.get(self.path.split("?", 1)[0])
        if route is None:
            self.send_error(404)
            return
        ctype, body = route
        if ctype == "redirect":
            self.send_response(302)
            self.send_header("Location", body.decode())
            self.end_headers()
            return
        self._send(ctype, body)

    def _send(self, ctype, body):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


@pytest.fixture(scope="module")
def fixture_server():
    srv = http.server.ThreadingHTTPServer((HOST, PORT), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield BASE
    srv.shutdown()
    srv.server_close()


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    REQUESTS.clear()
    ROBOTS[0] = DEFAULT_ROBOTS
    yield


def _site(tmp_path, path="/", **kw):
    kw.setdefault("delay", 0)
    return crawler.create_site_zim(BASE + path, out_dir=str(tmp_path), **kw)


def _text(arc, path):
    return bytes(arc.get_entry_by_path(path).get_item().content).decode("utf-8")


def _paths(arc):
    return {arc._get_entry_by_id(i).path for i in range(arc.all_entry_count)}


# ── URL rules ───────────────────────────────────────────────────────────────


def test_normalize_url_collapses_traps_and_keeps_pagination():
    n = crawler.normalize_url
    # The fragment, the default port, and host case are never identity.
    assert n("HTTP://Example.COM:80/a#frag") == "http://example.com/a"
    assert n("https://example.com:443/a") == "https://example.com/a"
    # A non-default port is.
    assert n("http://example.com:8080/a") == "http://example.com:8080/a"
    # Session ids and sort orders collapse onto the bare path…
    assert n("http://e.com/x?sid=1") == n("http://e.com/x?sid=2") == "http://e.com/x"
    assert n("http://e.com/x?sort=desc&utm_source=n") == "http://e.com/x"
    # …while pagination stays part of the page's identity, order-independent.
    assert n("http://e.com/x?page=2") == "http://e.com/x?page=2"
    assert n("http://e.com/x?sort=a&page=2") == "http://e.com/x?page=2"
    assert n("http://e.com/x?p=3&page=2") == n("http://e.com/x?page=2&p=3")
    # An empty path is the root.
    assert n("http://e.com") == "http://e.com/"


def test_same_origin_is_strict():
    assert crawler.same_origin("http://e.com/a", "http://e.com/")
    assert crawler.same_origin("http://e.com:80/a", "http://e.com/")
    assert not crawler.same_origin("https://e.com/a", "http://e.com/")
    assert not crawler.same_origin("http://other.com/a", "http://e.com/")
    assert not crawler.same_origin("http://sub.e.com/a", "http://e.com/")


def test_looks_like_a_page_screens_by_extension():
    assert crawler.looks_like_a_page("http://e.com/docs/intro.html")
    assert crawler.looks_like_a_page("http://e.com/docs/")  # no extension
    assert crawler.looks_like_a_page("http://e.com/wiki/Page.php")
    assert not crawler.looks_like_a_page("http://e.com/logo.png")
    assert not crawler.looks_like_a_page("http://e.com/dump.zip")
    assert not crawler.looks_like_a_page("http://e.com/style.css")


def test_parse_size_accepts_the_usual_spellings():
    assert crawler.parse_size("1048576") == 1024**2
    assert crawler.parse_size("512MiB") == 512 * 1024**2
    assert crawler.parse_size("2G") == 2 * 1024**3
    assert crawler.parse_size("1.5k") == 1536
    with pytest.raises(creator.CreateError, match="not a byte size"):
        crawler.parse_size("lots")
    with pytest.raises(creator.CreateError, match="positive"):
        crawler.parse_size("0")


# ── the crawl, end to end ───────────────────────────────────────────────────


def test_site_capture_end_to_end(fixture_server, tmp_path):
    info = _site(tmp_path, "/", max_depth=1)
    arc = Archive(info["path"])

    assert arc.main_entry.get_item().path == "A/index"
    assert info["stopped"] is None and info["bytes"] > 0
    home = _text(arc, "A/index")

    # A link to a page this crawl captured becomes internal navigation: a bare
    # sibling name under A/, resolvable from A/index with no scheme in sight.
    assert 'href="docs_intro_html"' in home
    assert arc.has_entry_by_path("A/docs_intro_html")
    # A link this crawl did NOT capture stays absolute and points at the web.
    assert 'href="https://elsewhere.invalid/x"' in home
    assert 'href="mailto:x@y.z"' in home and 'href="#top"' in home

    # Assets are carried, deduped across pages, and their own url() refs
    # followed one level — all with the single shared namespace.
    assert bytes(arc.get_entry_by_path(f"{NS}/img/logo.png").get_item().content) == (
        b"LOGOBYTES"
    )
    assert arc.has_entry_by_path(f"{NS}/static/bg.png")
    assert f"../{NS}/img/logo.png" in home
    assert REQUESTS.count("/static/site.css") == 1, "shared CSS re-fetched per page"
    assert REQUESTS.count("/img/logo.png") == 1

    # No JavaScript ships, and provenance names the seed.
    assert "<script" not in home
    assert bytes(arc.get_metadata("Source")).decode() == f"{BASE}/"
    assert bytes(arc.get_metadata("Creator")).decode() == "Zimi"
    assert "captured from" in bytes(arc.get_metadata("Description")).decode()


def test_fragment_into_a_captured_page_keeps_its_anchor(fixture_server, tmp_path):
    info = _site(tmp_path, "/", max_depth=1)
    intro = _text(Archive(info["path"]), "A/docs_intro_html")
    # /#top targets the captured home page — internal, anchor intact.
    assert 'href="index#top"' in intro


def test_robots_disallow_is_honored(fixture_server, tmp_path):
    info = _site(tmp_path, "/", max_depth=2)
    assert "/private/secret.html" not in REQUESTS
    assert not any("secret" in p for p in _paths(Archive(info["path"])))
    # The disallowed link is still a link — it just points at the live site.
    assert f'href="{BASE}/private/secret.html"' in _text(
        Archive(info["path"]), "A/index"
    )


def test_robots_disallowing_the_seed_refuses_the_crawl(fixture_server, tmp_path):
    ROBOTS[0] = "User-agent: *\nDisallow: /\n"
    with pytest.raises(creator.CreateError, match="--ignore-robots"):
        _site(tmp_path, "/")
    assert not list(tmp_path.glob("*.zim"))


def test_ignore_robots_overrides_and_warns(fixture_server, tmp_path):
    ROBOTS[0] = "User-agent: *\nDisallow: /\n"
    said = []
    info = _site(tmp_path, "/", max_depth=1, ignore_robots=True, progress=said.append)
    assert any("ignoring robots.txt" in m for m in said)
    assert "/robots.txt" not in REQUESTS  # not even fetched when ignored
    # The override is only reached with the flag; assert it took effect.
    assert info["pages"] > 1


def test_ignore_robots_flag_captures_disallowed_pages(fixture_server, tmp_path):
    info = _site(tmp_path, "/", max_depth=1, ignore_robots=True)
    assert "/private/secret.html" in REQUESTS
    assert arc_has(info, "secret")


def arc_has(info, needle):
    return any(needle in p for p in _paths(Archive(info["path"])))


def test_missing_robots_is_no_rules(fixture_server, tmp_path):
    ROBOTS[0] = None
    info = _site(tmp_path, "/", max_depth=1, ignore_robots=False)
    assert "/private/secret.html" in REQUESTS
    assert info["pages"] > 1


def test_query_traps_collapse_but_pagination_survives(fixture_server, tmp_path):
    info = _site(tmp_path, "/", max_depth=2)
    # Three links into /trap with different session ids are one page, and the
    # page's own further ?sid= links add nothing.
    assert REQUESTS.count("/trap") == 1
    assert not [p for p in REQUESTS if "sid=" in p or "sort=" in p]
    # ?page=2 is a page in its own right, distinct from the bare path.
    assert "/list" in REQUESTS and "/list?page=2" in REQUESTS
    arc = Archive(info["path"])
    listings = [p for p in _paths(arc) if p.startswith("A/list")]
    assert len(listings) == 2, listings


def test_off_origin_and_non_page_links_are_never_fetched(fixture_server, tmp_path):
    _site(tmp_path, "/", max_depth=2)
    assert "/data.bin" not in REQUESTS  # screened by extension, before a fetch
    assert "/img/logo.png" in REQUESTS  # as an ASSET, not as a page…
    assert not arc_has_page_for(tmp_path, "logo")


def arc_has_page_for(tmp_path, needle):
    zims = sorted(tmp_path.glob("*.zim"))
    arc = Archive(zims[-1])
    return any(p.startswith("A/") and needle in p for p in _paths(arc))


def test_redirect_off_origin_is_not_captured(fixture_server, tmp_path):
    # /away redirects to another host: fetched, then dropped rather than
    # packaged, because its content is not this site's.
    info = crawler.create_site_zim(
        f"{BASE}/docs/intro.html", out_dir=str(tmp_path), delay=0, max_depth=1
    )
    assert not arc_has(info, "elsewhere")


# ── bounds ──────────────────────────────────────────────────────────────────


def test_max_pages_stops_the_crawl_and_says_so(fixture_server, tmp_path):
    info = _site(tmp_path, "/chain/0.html", max_pages=3)
    assert info["pages"] == 3
    assert "page cap (3)" == info["stopped"]
    assert Archive(info["path"]).main_entry.get_item().path == "A/index"


def test_max_depth_bounds_the_chain(fixture_server, tmp_path):
    info = _site(tmp_path, "/chain/0.html", max_depth=2)
    # seed (depth 0) + two hops, and nothing beyond.
    assert info["pages"] == 3
    assert "/chain/2.html" in REQUESTS and "/chain/3.html" not in REQUESTS
    assert info["stopped"] is None  # the frontier ran dry, no bound was hit


def test_max_depth_zero_captures_only_the_seed(fixture_server, tmp_path):
    info = _site(tmp_path, "/chain/0.html", max_depth=0)
    assert info["pages"] == 1
    assert "/chain/1.html" not in REQUESTS


def test_byte_budget_stops_the_crawl(fixture_server, tmp_path):
    info = _site(tmp_path, "/chain/0.html", max_bytes=len(INDEX) + 10)
    assert info["pages"] < 7
    assert "byte budget" in (info["stopped"] or "")
    assert info["bytes"] >= len(INDEX)


def test_byte_budget_also_stops_asset_traffic(fixture_server, tmp_path):
    # A budget the seed page alone exhausts leaves nothing for assets: the
    # ZIM is still valid, the references are honestly unrewritten.
    info = _site(tmp_path, "/", max_bytes=len(INDEX) + 1, max_depth=1)
    assert info["assets"] == 0
    assert "/static/site.css" not in REQUESTS
    assert Archive(info["path"]).has_entry_by_path("A/index")


def test_bounds_must_be_positive(tmp_path):
    with pytest.raises(creator.CreateError, match="positive"):
        _site(tmp_path, "/", max_pages=0)
    with pytest.raises(creator.CreateError, match="positive"):
        _site(tmp_path, "/", delay=-1)


# ── politeness ──────────────────────────────────────────────────────────────


def test_delay_is_applied_between_page_requests(fixture_server, tmp_path, monkeypatch):
    slept = []
    monkeypatch.setattr(crawler.time, "sleep", lambda s: slept.append(s))
    info = crawler.create_site_zim(
        f"{BASE}/chain/0.html", out_dir=str(tmp_path), delay=0.25, max_pages=3
    )
    # One wait per page fetched after the seed — never before the first.
    assert slept == [0.25] * (info["pages"] - 1)


def test_robots_crawl_delay_wins_when_it_asks_for_more(
    fixture_server, tmp_path, monkeypatch
):
    ROBOTS[0] = "User-agent: *\nCrawl-delay: 2\n"
    slept = []
    said = []
    monkeypatch.setattr(crawler.time, "sleep", lambda s: slept.append(s))
    crawler.create_site_zim(
        f"{BASE}/chain/0.html",
        out_dir=str(tmp_path),
        delay=0.1,
        max_pages=2,
        progress=said.append,
    )
    assert slept == [2.0]
    assert any("2s crawl delay" in m for m in said)


def test_our_delay_wins_when_it_is_the_politer_one(
    fixture_server, tmp_path, monkeypatch
):
    ROBOTS[0] = "User-agent: *\nCrawl-delay: 1\n"
    slept = []
    monkeypatch.setattr(crawler.time, "sleep", lambda s: slept.append(s))
    crawler.create_site_zim(
        f"{BASE}/chain/0.html", out_dir=str(tmp_path), delay=5, max_pages=2
    )
    assert slept == [5]


# ── refusals ────────────────────────────────────────────────────────────────


def test_spa_seed_refuses_the_whole_crawl_naming_zimit(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="zimit"):
        _site(tmp_path, "/spa.html")
    assert not list(tmp_path.glob("*.zim"))
    # Refused on the FIRST page: nothing beyond the seed was ever requested.
    assert [p for p in REQUESTS if p != "/robots.txt"] == ["/spa.html"]


def test_offline_refuses_before_any_request(tmp_path, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    with pytest.raises(creator.CreateError, match="ZIMI_OFFLINE"):
        _site(tmp_path, "/")
    assert REQUESTS == []


def test_bad_scheme_refused(tmp_path):
    with pytest.raises(creator.CreateError, match="not an http"):
        crawler.create_site_zim("ftp://example.com/x", out_dir=str(tmp_path))


def test_non_html_seed_refused(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="not an HTML page"):
        _site(tmp_path, "/data.bin")


def test_no_spool_directory_survives_a_refusal(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError):
        _site(tmp_path, "/spa.html")
    _site(tmp_path, "/chain/0.html", max_pages=2)
    assert [p.name for p in tmp_path.iterdir() if p.is_dir()] == []


# ── interrupt ───────────────────────────────────────────────────────────────


def test_interrupt_writes_a_valid_zim_of_what_was_captured(fixture_server, tmp_path):
    said = []
    fired = []

    def note(message):
        said.append(message)
        if not fired and message.lstrip().startswith("[1/"):
            fired.append(True)
            os.kill(os.getpid(), signal.SIGINT)

    info = crawler.create_site_zim(
        f"{BASE}/chain/0.html", out_dir=str(tmp_path), delay=0, progress=note
    )
    assert info["stopped"] == "interrupted"
    assert info["pages"] == 1
    assert any("interrupt received" in m for m in said)
    # The whole point: a readable ZIM, not a crawl that died with nothing.
    arc = Archive(info["path"])
    assert arc.main_entry.get_item().path == "A/index"
    assert "Link 0" in _text(arc, "A/index")
    # The default handler is back — the process is killable again.
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler


# ── zimit orchestration ─────────────────────────────────────────────────────


@pytest.fixture
def zimit_docker(monkeypatch, tmp_path):
    """Docker present, daemon up, image local. Returns the recorder the tests
    inspect; no subprocess is ever spawned."""
    seen = {"runs": [], "probes": []}

    def probe(cmd):
        seen["probes"].append(cmd)
        return True

    def run(cmd, note, timeout=None):
        seen["runs"].append(cmd)
        note("crawl finished")
        out_dir = cmd[cmd.index("-v") + 1].split(":")[0]
        with open(os.path.join(out_dir, "whatever.zim"), "wb") as fh:
            fh.write(b"ZIMITOUTPUT")
        return 0, ["crawl finished"]

    monkeypatch.setattr(crawler, "_docker_cli", lambda: "/usr/local/bin/docker")
    monkeypatch.setattr(crawler, "_probe", probe)
    monkeypatch.setattr(crawler, "_run_streaming", run)
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    return seen


def test_zimit_without_docker_explains_what_zimit_is(monkeypatch, tmp_path):
    monkeypatch.setattr(crawler, "_docker_cli", lambda: None)
    with pytest.raises(creator.CreateError) as e:
        crawler.create_zimit_zim("https://example.com/", out_dir=str(tmp_path))
    assert "docker" in str(e.value).lower()
    assert "--site" in str(e.value)  # points at the path that needs nothing


def test_zimit_with_a_dead_daemon_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(crawler, "_docker_cli", lambda: "/usr/local/bin/docker")
    monkeypatch.setattr(crawler, "_probe", lambda cmd: False)
    with pytest.raises(creator.CreateError, match="daemon is not responding"):
        crawler.create_zimit_zim("https://example.com/", out_dir=str(tmp_path))


def test_zimit_command_contract(zimit_docker, tmp_path):
    info = crawler.create_zimit_zim(
        "https://example.com/blog",
        out_dir=str(tmp_path / "zims"),
        title="Blog",
        description="D",
        language="fra",
        max_pages=50,
    )
    cmd = zimit_docker["runs"][0]
    assert cmd[:3] == ["/usr/local/bin/docker", "run", "--rm"]
    assert "--shm-size=1g" in cmd  # a browser crawl dies without it
    assert crawler.ZIMIT_IMAGE in cmd
    assert cmd[cmd.index("-v") + 1].endswith(":/output")
    assert cmd[cmd.index("--url") + 1] == "https://example.com/blog"
    assert cmd[cmd.index("--output") + 1] == "/output"
    assert cmd[cmd.index("--title") + 1] == "Blog"
    assert cmd[cmd.index("--lang") + 1] == "fra"
    assert cmd[cmd.index("--limit") + 1] == "50"
    # Without --site, zimit is scoped to the one page.
    assert cmd[cmd.index("--scopeType") + 1] == "page"
    # The ZIM it produced is adopted under Zimi's name, not zimit's.
    assert os.path.basename(info["path"]).startswith("example_com_blog")
    with open(info["path"], "rb") as fh:
        assert fh.read() == b"ZIMITOUTPUT"
    assert info["engine"] == "zimit" and info["pages"] is None


def test_zimit_site_scope_and_engine_arg_passthrough(zimit_docker, tmp_path):
    crawler.create_zimit_zim(
        "https://example.com/",
        site=True,
        out_dir=str(tmp_path / "zims"),
        engine_args=["--workers", "2"],
    )
    cmd = zimit_docker["runs"][0]
    assert "--scopeType" not in cmd  # zimit's own prefix default applies
    assert "--limit" not in cmd  # never guessed at when the user didn't ask
    assert cmd[-2:] == ["--workers", "2"]


def test_zimit_pull_is_announced_never_implicit(monkeypatch, tmp_path):
    said = []
    runs = []

    def probe(cmd):
        return "image" not in cmd  # daemon up, image absent

    def run(cmd, note, timeout=None):
        runs.append(cmd)
        if cmd[1] == "pull":
            note("Pulling from openzim/zimit")
            return 0, []
        out_dir = cmd[cmd.index("-v") + 1].split(":")[0]
        with open(os.path.join(out_dir, "x.zim"), "wb") as fh:
            fh.write(b"Z")
        return 0, []

    monkeypatch.setattr(crawler, "_docker_cli", lambda: "/usr/local/bin/docker")
    monkeypatch.setattr(crawler, "_probe", probe)
    monkeypatch.setattr(crawler, "_run_streaming", run)
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))

    crawler.create_zimit_zim(
        "https://example.com/", out_dir=str(tmp_path / "zims"), progress=said.append
    )
    assert runs[0][1] == "pull"
    assert any("pulling it now" in m for m in said)
    assert any("gigabyte" in m for m in said)  # the size is stated up front


def test_zimit_failure_surfaces_its_own_last_words(monkeypatch, tmp_path):
    monkeypatch.setattr(crawler, "_docker_cli", lambda: "/usr/local/bin/docker")
    monkeypatch.setattr(crawler, "_probe", lambda cmd: True)
    monkeypatch.setattr(
        crawler,
        "_run_streaming",
        lambda cmd, note, timeout=None: (1, ["Crawl status: interrupted"]),
    )
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    with pytest.raises(creator.CreateError, match="Crawl status: interrupted"):
        crawler.create_zimit_zim("https://example.com/", out_dir=str(tmp_path / "z"))


def test_zimit_producing_no_zim_is_an_error_not_a_silent_pass(monkeypatch, tmp_path):
    monkeypatch.setattr(crawler, "_docker_cli", lambda: "/usr/local/bin/docker")
    monkeypatch.setattr(crawler, "_probe", lambda cmd: True)
    monkeypatch.setattr(
        crawler, "_run_streaming", lambda cmd, note, timeout=None: (0, ["done"])
    )
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    with pytest.raises(creator.CreateError, match="left no .zim"):
        crawler.create_zimit_zim("https://example.com/", out_dir=str(tmp_path / "z"))


def test_zimit_cleans_up_its_scratch_directory(zimit_docker, tmp_path):
    crawler.create_zimit_zim("https://example.com/", out_dir=str(tmp_path / "zims"))
    data = tmp_path / "data"
    assert [p for p in data.iterdir() if p.name.startswith("zimi-zimit-")] == []


def test_zimit_offline_refuses(tmp_path, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    with pytest.raises(creator.CreateError, match="ZIMI_OFFLINE"):
        crawler.create_zimit_zim("https://example.com/", out_dir=str(tmp_path))


# ── CLI wiring, real subprocess ─────────────────────────────────────────────


def _cli(tmp_path, *args):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT
    env["ZIM_DIR"] = str(tmp_path / "zims")
    env.pop("ZIMI_OFFLINE", None)
    return subprocess.run(
        [sys.executable, "-m", "zimi", "create", *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        timeout=180,
    )


def test_cli_site_crawl_subprocess(fixture_server, tmp_path):
    out = tmp_path / "cli-site.zim"
    r = _cli(
        tmp_path,
        f"{BASE}/chain/0.html",
        "--site",
        "--max-pages",
        "3",
        "--delay",
        "0",
        "--out",
        str(out),
        "--title",
        "Chain",
    )
    assert r.returncode == 0, r.stderr
    assert "ZIM written" in r.stdout
    assert "3 pages" in r.stdout and "fetched" in r.stdout
    assert "page cap (3)" in r.stdout  # the bound that stopped it is reported
    arc = Archive(out)
    assert bytes(arc.get_metadata("Title")).decode() == "Chain"
    assert arc.main_entry.get_item().path == "A/index"


def test_cli_without_site_still_captures_one_page(fixture_server, tmp_path):
    out = tmp_path / "one.zim"
    r = _cli(tmp_path, f"{BASE}/docs/intro.html", "--out", str(out))
    assert r.returncode == 0, r.stderr
    assert "assets carried" in r.stdout  # the single-page summary, unchanged
    assert "/docs/next.html" not in REQUESTS  # no crawling without --site


def test_cli_crawl_flags_on_a_folder_are_refused(tmp_path):
    src = tmp_path / "folder"
    src.mkdir()
    (src / "a.md").write_text("# A\n")
    r = _cli(tmp_path, str(src), "--site")
    assert r.returncode == 2
    assert "--site only applies to a URL capture" in r.stderr


def test_cli_crawl_flags_without_site_are_refused(tmp_path):
    r = _cli(tmp_path, "https://example.com/x", "--max-pages", "5")
    assert r.returncode == 2
    assert "--max-pages needs --site" in r.stderr


def test_cli_builtin_crawl_flags_are_refused_by_the_zimit_engine(tmp_path):
    # zimit has its own crawl controls; silently dropping Zimi's would leave
    # the user believing a bound was applied that never was.
    r = _cli(tmp_path, "https://example.com/x", "--engine", "zimit", "--delay", "2")
    assert r.returncode == 2
    assert "--delay belongs to Zimi's own crawler" in r.stderr
    assert "--engine-arg" in r.stderr


def test_cli_engine_arg_without_zimit_is_refused(tmp_path):
    # The attached form is the only one argparse accepts for a flag-shaped
    # value, and passing engine flags is the option's whole purpose — so the
    # spelling the help documents is the spelling under test.
    r = _cli(tmp_path, "https://example.com/x", "--site", "--engine-arg=--workers=2")
    assert r.returncode == 2
    assert "--engine-arg only applies to --engine zimit" in r.stderr


def test_cli_bad_max_bytes_is_a_clear_message(tmp_path):
    r = _cli(tmp_path, "https://example.com/x", "--site", "--max-bytes", "lots")
    assert r.returncode == 2
    assert "not a byte size" in r.stderr
