"""The rendered capture engine — `--engine rendered`, and the Rendered toggle.

Two layers, deliberately:

  * Everything above the browser runs ALWAYS. The mirror layout, the asset
    carrying and its caps, the CSS and HTML rewriting, the engine selection and
    its refusals, the toggle's server-side gate, and the kill path a stalled
    job depends on — all driven with a fake resource map, no Chromium anywhere
    near them. This is most of the engine, and it is the half where a bug is
    silent rather than loud.

  * The browser tests SKIP when Playwright and its Chromium are not installed,
    which is the state of any CI that has not asked for them. They are marked
    so a machine that HAS a browser proves the real thing end to end: a page
    whose content only exists after JavaScript runs, an image only a scroll
    reveals, a cross-origin asset, and a crawl that follows links a script
    wrote.

Nothing here reaches the real network. The browser tests drive two local
fixture servers — one "site", one "CDN" on a second port the OS chooses, which
is a different origin by every rule that matters.
"""

import http.server
import json
import os
import sys
import threading
import urllib.parse

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.renderer as renderer  # noqa: E402

HOST = "127.0.0.1"
# EPHEMERAL ports, always: the fixture servers bind port 0 and the tests read
# back what the OS gave them. A fixed port is a name shared with every other
# test module in the repo AND with any other copy of this suite running at the
# same moment — both of which turn into "address already in use" at setup, and
# neither of which is about the code under test.


# ── the fake resource map ───────────────────────────────────────────────────
#
# What a navigation left behind, without a navigation: the same shape
# RenderedSession._collect produces, so everything downstream of the browser is
# exercised by the same code path the browser feeds.


def _resources(tmp_path, entries):
    """``{url: _Resource}`` from ``{url: (mimetype, bytes)}``."""
    out = {}
    for i, (url, (mime, data)) in enumerate(entries.items()):
        path = tmp_path / f"res{i}.bin"
        path.write_bytes(data)
        out[url] = renderer._Resource(url, mime, str(path), len(data))
    return out


class _Sink:
    """A Creator's add_item, without a Creator."""

    def __init__(self):
        self.items = []

    def __call__(self, item):
        self.items.append(item)

    def paths(self):
        return [path for path, _mime, _data in self.items]

    def body(self, path):
        """The bytes stored at an in-ZIM path. Asserts rather than returns None
        for a path nothing wrote: every caller is checking what landed, and
        "nothing did" is worth failing on by name."""
        for got, _mime, data in self.items:
            if got == path:
                return data
        raise AssertionError(f"nothing was stored at {path}")


def _tuple_item(path, mimetype, data):
    """The crawl's item factory: three facts, no libzim."""
    return (path, mimetype, data)


def _assets(tmp_path, entries, **kw):
    sink = _Sink()
    return sink, renderer.RenderedAssets(
        sink, _resources(tmp_path, entries), item_factory=_tuple_item, **kw
    )


# ── the mirror layout ───────────────────────────────────────────────────────


def asset_path(url):
    """``_asset_path`` for a URL that is supposed to have one. The assertion
    belongs here rather than at each call site: every test below is about WHAT
    the path is, and "it was None" is a different failure worth naming once."""
    got = renderer._asset_path(url)
    assert got is not None, f"no asset path for {url}"
    return got


def test_an_asset_path_mirrors_host_and_path():
    assert (
        renderer._asset_path("https://example.com/img/logo.png")
        == "_assets/example_com/img/logo.png"
    )


def test_two_hosts_with_the_same_path_are_two_entries():
    one = asset_path("https://a.example/s/app.css")
    two = asset_path("https://b.example/s/app.css")
    assert one != two and one.endswith("/s/app.css") and two.endswith("/s/app.css")


def test_a_query_is_part_of_an_assets_identity():
    plain = asset_path("https://e.com/i.png")
    small = asset_path("https://e.com/i.png?w=100")
    large = asset_path("https://e.com/i.png?w=900")
    assert len({plain, small, large}) == 3
    # …and it stays a path with an extension, not a query pretending to be one.
    assert small.endswith(".png") and "?" not in small


def test_the_same_url_always_lands_at_the_same_path():
    url = "https://e.com/a/b/c.png?v=2"
    assert renderer._asset_path(url) == renderer._asset_path(url)


def test_a_directory_url_gets_a_name():
    assert asset_path("https://e.com/dir/").endswith("/dir/index")
    assert asset_path("https://e.com").endswith("/index")


def test_path_traversal_and_junk_never_reach_the_entry_path():
    got = asset_path("https://e.com/../../etc/passwd")
    assert ".." not in got and got.startswith("_assets/e_com/")
    assert " " not in asset_path("https://e.com/a b/c d.png")


def test_an_absurd_url_is_capped_not_carried_whole():
    got = asset_path("https://e.com/" + "x" * 4000 + ".png")
    assert len(got) < 300


def test_only_http_urls_have_an_asset_path():
    for url in ("data:image/png;base64,AAAA", "about:blank", "ftp://e.com/x"):
        assert renderer._asset_path(url) is None


def test_the_dedupe_key_matches_the_fast_engines():
    # The crawl reports assets by reading ONE shared map whichever engine
    # filled it, so the two engines must key it identically: "<label>\n<path>".
    key = renderer._carried_key("_assets/example_com/img/logo.png")
    assert key == "example_com\nimg/logo.png"
    label, _sep, resolved = key.partition("\n")
    assert label and resolved  # what _report_new_assets splits it back into


# ── carrying ────────────────────────────────────────────────────────────────


def test_an_asset_the_browser_fetched_is_carried(tmp_path):
    sink, assets = _assets(
        tmp_path, {"https://e.com/logo.png": ("image/png", b"PNGDATA")}
    )
    path = assets.carry("https://e.com/logo.png")
    assert path == "_assets/e_com/logo.png"
    assert sink.body(path) == b"PNGDATA"
    assert assets.count == 1 and assets.mimetypes == {"image/png"}


def test_an_asset_the_browser_never_fetched_stays_external(tmp_path):
    _sink, assets = _assets(tmp_path, {})
    assert assets.carry("https://e.com/never-loaded.png") is None
    assert assets.count == 0


def test_a_cross_origin_asset_is_carried_too(tmp_path):
    # The whole reason the rendered engine keeps a resource map instead of
    # resolving paths: offline, a font on a CDN is not optional.
    sink, assets = _assets(
        tmp_path, {"https://cdn.other/f/x.woff2": ("font/woff2", b"FONT")}
    )
    assert assets.carry("https://cdn.other/f/x.woff2")
    assert sink.body("_assets/cdn_other/f/x.woff2") == b"FONT"


def test_the_same_asset_on_two_pages_is_stored_once(tmp_path):
    carried = {}
    urls = {"https://e.com/app.css": ("text/css", b"body{color:red}")}
    sink_one, one = _assets(tmp_path, urls, carried=carried)
    sink_two, two = _assets(tmp_path, urls, carried=carried)
    assert one.carry("https://e.com/app.css") == two.carry("https://e.com/app.css")
    assert len(sink_one.items) == 1 and len(sink_two.items) == 0


def test_an_oversized_asset_is_dropped(tmp_path):
    big = b"x" * (renderer.MAX_ASSET_BYTES + 1)
    _sink, assets = _assets(tmp_path, {"https://e.com/huge.bin": ("video/mp4", big)})
    assert assets.carry("https://e.com/huge.bin") is None


def test_the_asset_count_cap_holds(tmp_path, monkeypatch):
    monkeypatch.setattr(renderer, "_MAX_ASSETS", 2)
    urls = {f"https://e.com/{n}.png": ("image/png", b"P") for n in range(5)}
    _sink, assets = _assets(tmp_path, urls)
    got = [assets.carry(url) for url in urls]
    assert sum(1 for path in got if path) == 2


def test_the_byte_budget_is_charged_and_obeyed(tmp_path):
    from zimi.crawler import ByteBudget

    # The budget is the crawl's, spent by the browser as it fetches; the
    # carrier's job is only to stop when it is gone.
    budget = ByteBudget(1)
    budget.spend(2)
    _sink, assets = _assets(
        tmp_path, {"https://e.com/a.png": ("image/png", b"P")}, budget=budget
    )
    assert assets.carry("https://e.com/a.png")  # already fetched; storing is free


# ── stylesheets ─────────────────────────────────────────────────────────────


def test_a_stylesheets_own_refs_are_carried_and_rewritten(tmp_path):
    sink, assets = _assets(
        tmp_path,
        {
            "https://e.com/s/app.css": (
                "text/css",
                b"@font-face{src:url(../f/z.woff2)}"
                b"body{background:url('img/hero.jpg')}",
            ),
            "https://e.com/f/z.woff2": ("font/woff2", b"FONT"),
            "https://e.com/s/img/hero.jpg": ("image/jpeg", b"JPEG"),
        },
    )
    assets.carry("https://e.com/s/app.css")
    css = sink.body("_assets/e_com/s/app.css").decode()
    # Rewritten RELATIVE to the stylesheet's own place in the mirror, which is
    # exactly the relationship it was authored against.
    assert "url(../f/z.woff2)" in css
    assert "url('img/hero.jpg')" in css
    assert sink.body("_assets/e_com/f/z.woff2") == b"FONT"
    assert sink.body("_assets/e_com/s/img/hero.jpg") == b"JPEG"


def test_a_stylesheet_reaching_across_origins_is_followed(tmp_path):
    sink, assets = _assets(
        tmp_path,
        {
            "https://e.com/app.css": (
                "text/css",
                b"@font-face{src:url(https://cdn.other/f/x.woff2)}",
            ),
            "https://cdn.other/f/x.woff2": ("font/woff2", b"FONT"),
        },
    )
    assets.carry("https://e.com/app.css")
    css = sink.body("_assets/e_com/app.css").decode()
    assert "url(../cdn_other/f/x.woff2)" in css
    assert sink.body("_assets/cdn_other/f/x.woff2") == b"FONT"


def test_an_import_is_followed_in_its_bare_string_form(tmp_path):
    sink, assets = _assets(
        tmp_path,
        {
            "https://e.com/a.css": ("text/css", b'@import "b.css";'),
            "https://e.com/b.css": ("text/css", b"p{margin:0}"),
        },
    )
    assets.carry("https://e.com/a.css")
    assert '@import "b.css"' in sink.body("_assets/e_com/a.css").decode()
    assert sink.body("_assets/e_com/b.css") == b"p{margin:0}"


def test_a_data_url_inside_css_is_left_exactly_alone(tmp_path):
    sink, assets = _assets(
        tmp_path,
        {
            "https://e.com/a.css": (
                "text/css",
                b"i{background:url(data:image/gif;base64,R0l)}",
            )
        },
    )
    assets.carry("https://e.com/a.css")
    assert "url(data:image/gif;base64,R0l)" in sink.body("_assets/e_com/a.css").decode()


# ── the page ────────────────────────────────────────────────────────────────

# Double-quoted attributes and absolute refs throughout, because that is what
# the browser's own outerHTML produces after the preparation script has run —
# this is the shape the rewriter actually meets, not a hand-written page.
PAGE = (
    '<!DOCTYPE html><html lang="en"><head><title>T</title>'
    '<link rel="stylesheet" href="https://e.com/app.css">'
    '<link rel="preload" as="script" href="https://e.com/big.js">'
    "<style>.hero{background:url(https://e.com/bg.png)}</style>"
    '<script src="https://e.com/app.js"></script></head>'
    '<body><img src="https://e.com/logo.png" alt="logo">'
    "<div style=\"background-image:url('https://e.com/inline.png')\"></div>"
    '<a href="https://e.com/other">other</a>'
    '<a href="https://elsewhere.invalid/x">away</a>'
    "<script>console.log(1)</script></body></html>"
)

PAGE_RESOURCES = {
    "https://e.com/app.css": ("text/css", b"body{color:red}"),
    "https://e.com/logo.png": ("image/png", b"PNG"),
    "https://e.com/bg.png": ("image/png", b"BG"),
    "https://e.com/inline.png": ("image/png", b"IN"),
}


def _rendered(tmp_path, **kw):
    sink, assets = _assets(tmp_path, PAGE_RESOURCES)
    html = renderer.render_rendered_page(
        assets, PAGE, final_url="https://e.com/page", **kw
    )
    return sink, html


def test_the_page_points_at_the_assets_it_carried(tmp_path):
    _sink, html = _rendered(tmp_path)
    assert 'src="../_assets/e_com/logo.png"' in html
    assert 'href="../_assets/e_com/app.css"' in html


def test_inline_css_and_style_attributes_are_rewritten_too(tmp_path):
    _sink, html = _rendered(tmp_path)
    assert "url(../_assets/e_com/bg.png)" in html
    assert "url('../_assets/e_com/inline.png')" in html


def test_a_preload_link_is_not_carried(tmp_path):
    sink, _html = _rendered(tmp_path)
    assert not any("big" in path for path in sink.paths())


def test_scripts_do_not_ship(tmp_path):
    _sink, html = _rendered(tmp_path)
    assert "<script" not in html.lower() and "console.log" not in html


def test_the_stored_page_declares_utf8(tmp_path):
    _sink, html = _rendered(tmp_path)
    assert "charset='utf-8'" in html or 'charset="utf-8"' in html.lower()


def test_links_resolve_into_the_zim_when_the_capture_holds_them(tmp_path):
    _sink, html = _rendered(
        tmp_path, resolve_link=lambda url: "other" if url.endswith("/other") else None
    )
    assert 'href="other"' in html
    assert "https://elsewhere.invalid/x" in html  # everything else stays external


def test_an_asset_that_never_loaded_leaves_its_reference_alone(tmp_path):
    sink, assets = _assets(tmp_path, {})
    html = renderer.render_rendered_page(assets, PAGE, final_url="https://e.com/page")
    assert 'src="https://e.com/logo.png"' in html
    assert sink.items == []


# ── engine selection ────────────────────────────────────────────────────────


def test_the_default_engine_is_the_fast_one():
    engine = creator.capture_engine()
    assert isinstance(engine, creator.BuiltinCapture)
    assert engine.name == "builtin" and engine.refuses_spa


def test_a_named_engine_nothing_answers_to_is_refused():
    with pytest.raises(creator.CreateError, match="unknown capture engine"):
        creator.capture_engine("chrome")


def test_the_rendered_engine_says_how_to_install_itself(monkeypatch, tmp_path):
    monkeypatch.setattr(renderer, "_playwright_module", lambda: None)
    engine = creator.capture_engine("rendered", work_dir=str(tmp_path))
    with pytest.raises(creator.CreateError) as caught:
        engine.fetch("https://e.com/")
    assert "playwright install chromium" in str(caught.value)
    engine.close()


def test_a_rendered_capture_does_not_refuse_an_application_shell(tmp_path):
    # The fast engine refuses one; the rendered engine exists FOR one. A shell
    # reaching the rendered engine and being turned away would be the single
    # most confusing outcome this feature could have.
    engine = creator.capture_engine("rendered", work_dir=str(tmp_path))
    assert engine.refuses_spa is False
    engine.close()


def test_the_web_and_the_engines_agree_on_the_engine_names():
    assert manage.CREATE_ENGINES == creator.CAPTURE_ENGINES


def test_the_spa_refusal_names_the_engine_that_can_do_it():
    assert "rendered" in creator.SPA_REFUSAL
    assert "zimit" in creator.SPA_REFUSAL  # still the pointer for full replay


# ── the toggle's server side ────────────────────────────────────────────────


def test_the_form_accepts_the_engine_only_when_the_browser_is_here(monkeypatch):
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    _mode, _src, _title, opts = manage._create_validate(
        {"mode": "site", "source": "https://e.com/", "engine": "rendered"}
    )
    assert opts["engine"] == "rendered"

    monkeypatch.setattr(manage, "_create_browser_ready", lambda: False)
    with pytest.raises(ValueError, match="browser"):
        manage._create_validate(
            {"mode": "page", "source": "https://e.com/", "engine": "rendered"}
        )


def test_saying_nothing_means_the_default_engine():
    _mode, _src, _title, opts = manage._create_validate(
        {"mode": "page", "source": "https://e.com/"}
    )
    assert opts["engine"] is None  # not sent on to the engine at all


def test_an_engine_the_web_does_not_offer_is_refused():
    # zimit is a real engine and deliberately not one of these: it wants a
    # docker daemon, and a web form is the wrong place to find that out.
    for name in ("zimit", "chrome", "../etc"):
        with pytest.raises(ValueError, match="unknown capture engine"):
            manage._create_validate(
                {"mode": "site", "source": "https://e.com/", "engine": name}
            )


def test_the_probe_reports_the_browser_without_launching_one(monkeypatch):
    calls = []

    def fake():
        calls.append(1)
        return True

    monkeypatch.setattr(manage, "_create_browser_ready", fake)
    payload = manage._create_status(0, probe=True)
    assert payload["browser_ready"] is True
    # And a plain poll never asks: the answer costs a browser launch the first
    # time, and a status poll runs every second.
    assert "browser_ready" not in manage._create_status(0)
    assert len(calls) == 1


def test_an_application_shell_is_a_refusal_or_the_point_depending_on_the_engine(
    monkeypatch,
):
    shell = b"<html><head><title>App</title></head><body><div id=root></div>"
    shell += b"<script src='/b.js'></script></body></html>"
    monkeypatch.setattr(
        manage,
        "_fetch_page_for_probe",
        None,
        raising=False,
    )
    monkeypatch.setattr(
        "zimi.creator._fetch_page",
        lambda url, **kw: (url, shell, "text/html", ""),
    )
    fast = manage._probe_url("https://e.com/app")
    assert fast["ok"] is False and fast["warning_key"] == "create_warn_spa"

    rendered = manage._probe_url("https://e.com/app", engine="rendered")
    assert rendered["ok"] is True and rendered["warning_key"] is None
    assert rendered["note_key"] == "create_note_spa_rendered"
    assert rendered["spa"] is True


# ── the kill path ───────────────────────────────────────────────────────────


class _FakeSession:
    def __init__(self):
        self.killed = False

    def kill(self):
        self.killed = True


def test_a_stalled_job_can_have_its_browser_killed_from_another_thread():
    # The watchdog cannot ask the job's own thread to tidy up — it is wedged,
    # which is why the job is being abandoned. Killing the child process is the
    # one thing that works from out here, so this path must not depend on the
    # session's thread at all.
    session = _FakeSession()
    with renderer._sessions_lock:
        renderer._sessions.append(session)
    try:
        renderer.shutdown_sessions()
        assert session.killed
        with renderer._sessions_lock:
            assert session not in renderer._sessions
    finally:
        with renderer._sessions_lock:
            if session in renderer._sessions:
                renderer._sessions.remove(session)


def test_the_watchdog_reaches_for_the_browser_only_when_one_was_loaded(monkeypatch):
    hit = []
    monkeypatch.setitem(
        sys.modules,
        "zimi.renderer",
        type("M", (), {"shutdown_sessions": staticmethod(lambda: hit.append(1))}),
    )
    manage._create_kill_browsers()
    assert hit == [1]
    monkeypatch.delitem(sys.modules, "zimi.renderer")
    manage._create_kill_browsers()  # nothing loaded, nothing to kill, no import
    assert hit == [1]


def test_a_session_that_never_started_still_cleans_up_after_itself(tmp_path):
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    spool = session._spool
    assert os.path.isdir(spool)
    session.close()
    assert not os.path.exists(spool)


# ── with a real browser ─────────────────────────────────────────────────────

browser = pytest.mark.skipif(
    not renderer.browser_available(),
    reason="playwright + chromium are not installed here",
)


# A page that is EMPTY until JavaScript runs, holds an image only a scroll
# reveals, pulls a stylesheet from another origin, and writes its own links.
def site_index(cdn):
    """The seed page. Takes the CDN's address because a cross-origin
    stylesheet cannot be written down before the OS has said where the other
    server lives."""
    return SITE_INDEX_TEMPLATE % (cdn,)


SITE_INDEX_TEMPLATE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Rendered fixture</title>
<link rel="stylesheet" href="%s/style.css">
</head><body><div id="app"></div>
<script>
  document.getElementById('app').innerHTML =
    '<h1>Built by JavaScript</h1>' +
    '<p>This sentence exists only after a script ran.</p>' +
    '<a href="/second.html">second</a>' +
    '<div style="height:4000px"></div>' +
    '<img id="lazy" data-src="/img/late.png" alt="late">';
  var img = document.getElementById('lazy');
  new IntersectionObserver(function(entries, obs) {
    entries.forEach(function(e) {
      if (e.isIntersecting) { img.src = img.dataset.src; obs.unobserve(img); }
    });
  }).observe(img);
</script></body></html>"""

SITE_SECOND = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Second</title></head><body><h1>Second page</h1>
<p>Server-rendered, and reached only by a link a script wrote.</p>
</body></html>"""

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def site_routes(cdn):
    return {
        "/": ("text/html; charset=utf-8", site_index(cdn).encode()),
        "/second.html": ("text/html; charset=utf-8", SITE_SECOND.encode()),
        "/img/late.png": ("image/png", PNG),
        "/robots.txt": ("text/plain", b"User-agent: *\nAllow: /\n"),
    }


CDN_ROUTES = {
    "/style.css": ("text/css", b"body{font-family:sans-serif;background:#fff}"),
}


def _server(routes):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            route = routes.get(self.path.split("?", 1)[0])
            if route is None:
                self.send_error(404)
                return
            ctype, body = route
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A002 (the base's name)
            pass

    srv = http.server.ThreadingHTTPServer((HOST, 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://{HOST}:{srv.server_port}"


@pytest.fixture(scope="module")
def fixture_servers():
    """``(site_url, cdn_url)`` — two origins, both on ports the OS chose.

    The CDN comes up first because the site's markup has to name it."""
    cdn, cdn_url = _server(CDN_ROUTES)
    site, site_url = _server(site_routes(cdn_url))
    yield site_url, cdn_url
    for srv in (site, cdn):
        srv.shutdown()
        srv.server_close()


def _host_slug(url):
    """How an in-ZIM asset path spells this server's origin."""
    from zimi.zimwriter import _slug

    return _slug(urllib.parse.urlsplit(url).netloc, "host")


@pytest.fixture(autouse=True)
def _online(monkeypatch):
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)


def _zim_text(path, entry):
    from libzim.reader import Archive

    return bytes(Archive(path).get_entry_by_path(entry).get_item().content).decode()


def _zim_paths(path):
    from libzim.reader import Archive

    arc = Archive(path)
    return {arc._get_entry_by_id(i).path for i in range(arc.all_entry_count)}


@browser
def test_a_rendered_page_capture_keeps_what_the_browser_drew(fixture_servers, tmp_path):
    pytest.importorskip("libzim.writer")
    site, cdn = fixture_servers
    info = creator.create_page_zim(site + "/", out_dir=str(tmp_path), engine="rendered")
    assert info["engine"] == "rendered"
    html = _zim_text(info["path"], "A/index")
    # The whole point: a page the fast engine would have refused as an empty
    # shell arrives with its content in it.
    assert "Built by JavaScript" in html
    assert "only after a script ran" in html
    # The image that only exists once something scrolled past it.
    paths = _zim_paths(info["path"])
    assert any(path.endswith("img/late.png") for path in paths)
    # The stylesheet from the OTHER origin, which no same-origin rule would
    # have carried.
    assert any(_host_slug(cdn) in path for path in paths)
    # And no JavaScript ships, however much of it built the page.
    assert "<script" not in html.lower()


@browser
def test_a_rendered_crawl_follows_links_a_script_wrote(fixture_servers, tmp_path):
    pytest.importorskip("libzim.writer")
    from zimi import crawler

    site, _cdn = fixture_servers
    info = crawler.create_site_zim(
        site + "/",
        out_dir=str(tmp_path),
        engine="rendered",
        delay=0,
        max_pages=5,
    )
    # /second.html is reachable ONLY through a link the index's script created,
    # so the fast engine's crawl of this site captures exactly one page.
    assert info["pages"] == 2
    assert "Second page" in _zim_text(info["path"], "A/second_html")


@browser
def test_the_same_crawl_with_the_fast_engine_finds_one_page(fixture_servers, tmp_path):
    pytest.importorskip("libzim.writer")
    from zimi import crawler

    site, _cdn = fixture_servers
    with pytest.raises(creator.CreateError, match="application shell"):
        crawler.create_site_zim(site + "/", out_dir=str(tmp_path), delay=0)


@browser
def test_cancelling_a_rendered_crawl_takes_its_browser_with_it(
    fixture_servers, tmp_path, monkeypatch
):
    """The ordinary cancel, as the Create page's button produces it.

    A cancel is raised out of the engine's progress callback and unwinds the
    whole crawl; what this asserts is that the browser goes with it rather than
    surviving as an orphan holding a couple of hundred megabytes. The watchdog
    kill is the OTHER path (see above) and only exists for a job whose thread
    never reaches another line."""
    pytest.importorskip("libzim.writer")
    from zimi import crawler

    # The pid is recorded at START, not read back afterwards: closing a session
    # forgets its child on purpose, so asking later would ask nothing.
    sessions = []
    real_start = renderer.RenderedCapture.start

    def remember(self):
        out = real_start(self)
        if not sessions:
            sessions.append((self._session, self._session._driver_pid))
        return out

    monkeypatch.setattr(renderer.RenderedCapture, "start", remember)

    class Cancelled(Exception):
        pass

    def sink(_message):
        # The web job's sink raises out of the engine exactly like this.
        if sessions:
            raise Cancelled()

    site, _cdn = fixture_servers
    with pytest.raises(Cancelled):
        crawler.create_site_zim(
            site + "/",
            out_dir=str(tmp_path),
            engine="rendered",
            delay=0,
            progress=sink,
        )
    assert sessions, "the crawl never started a browser, so this proved nothing"
    session, pid = sessions[0]
    assert pid, "no driver pid to check"
    assert not _alive(pid)
    # And nothing of the capture is left on disk either.
    assert not os.path.exists(session._spool)


@browser
def test_closing_a_session_leaves_no_browser_behind(tmp_path):
    session = renderer.RenderedSession(work_dir=str(tmp_path)).start()
    pid = session._driver_pid
    assert pid, "the driver pid is what a stalled job's kill depends on"
    assert _alive(pid)
    session.close()
    assert not _alive(pid)


@browser
def test_a_browser_can_be_killed_from_another_thread(tmp_path):
    # What the create watchdog does to a wedged job, exactly: reach in from
    # outside and stop the child. The session lives in a scratch thread the
    # way a real job does, because an abrupt driver kill leaves THAT thread's
    # asyncio loop flagged running forever — Playwright's sync API then
    # refuses the next start on the same thread. Production never reuses the
    # thread (each job is a fresh worker); a test that ran the session on the
    # pytest thread would poison every rendered test after it.
    holder = {}
    started = threading.Event()

    def job_thread():
        try:
            holder["session"] = renderer.RenderedSession(work_dir=str(tmp_path)).start()
        finally:
            started.set()
        # Park like a wedged job; the kill unblocks us by breaking the session.
        holder["dead"].wait(30)

    holder["dead"] = threading.Event()
    worker = threading.Thread(target=job_thread, daemon=True)
    worker.start()
    assert started.wait(30) and "session" in holder
    pid = holder["session"]._driver_pid
    done = threading.Event()
    threading.Thread(
        target=lambda: (renderer.shutdown_sessions(), done.set()), daemon=True
    ).start()
    assert done.wait(20)
    assert not _alive(pid)
    holder["dead"].set()


def test_a_fresh_thread_can_render_after_a_kill(tmp_path):
    # The production guarantee behind the watchdog: killing a wedged job's
    # browser must not cost the NEXT job its browser. Each web job runs in a
    # fresh worker thread, so a fresh thread starting cleanly is the contract.
    scratch = {}

    def sacrifice():
        (tmp_path / "a").mkdir(exist_ok=True)
        s = renderer.RenderedSession(work_dir=str(tmp_path / "a")).start()
        scratch["pid"] = s._driver_pid
        renderer.shutdown_sessions()

    t1 = threading.Thread(target=sacrifice, daemon=True)
    t1.start()
    t1.join(30)
    assert not _alive(scratch["pid"])
    result = {}

    def next_job():
        try:
            (tmp_path / "b").mkdir(exist_ok=True)
            s = renderer.RenderedSession(work_dir=str(tmp_path / "b")).start()
            result["ok"] = True
            s.close()
        except Exception as e:  # pragma: no cover - the failure IS the report
            result["ok"] = False
            result["err"] = str(e)

    t2 = threading.Thread(target=next_job, daemon=True)
    t2.start()
    t2.join(60)
    assert result.get("ok"), result.get("err")


def _alive(pid):
    # The renderer's own check, deliberately: a killed child is a zombie until
    # it is reaped, and a test that asked a different question than the kill
    # path asks would pass while the browser was still there.
    return renderer._process_alive(pid)


@browser
def test_a_rendered_capture_reports_its_memory_honestly(fixture_servers, tmp_path):
    # Earlier tests in the same process mock availability and leave the cached
    # verdict poisoned; this one runs a REAL browser, so re-ask reality first.
    renderer.browser_status(refresh=True)
    """Not an assertion about a number, a guard against an order of magnitude.

    One browser for the whole job and one page at a time is the design; what
    would break it is holding every page's subresources in memory, and that
    shows up here as growth per page rather than as a constant."""
    resource = pytest.importorskip("resource")
    pytest.importorskip("libzim.writer")
    from zimi import crawler

    site, _cdn = fixture_servers
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    crawler.create_site_zim(
        site + "/", out_dir=str(tmp_path), engine="rendered", delay=0, max_pages=5
    )
    after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # ru_maxrss is KB on Linux and bytes on macOS; normalise to MB either way.
    scale = 1024 if sys.platform == "darwin" else 1
    grew_mb = (after - before) / (1024.0 * scale)
    print(json.dumps({"rss_growth_mb": round(grew_mb, 1)}))
    # A generous ceiling, and deliberately so: ru_maxrss is a high-water MARK,
    # so what it measures depends on what ran before it in this process. A
    # tight bound here would be a test that fails for the order the suite
    # happened to run in. The claim being guarded is an order of magnitude —
    # the browser is a child process and is not in this number at all, and the
    # engine holds one asset at a time rather than a site's worth.
    assert grew_mb < 400
    # The structural half of the same claim, which does NOT depend on what else
    # ran: nothing is still held when the capture is over.
    engine = renderer.RenderedCapture(work_dir=str(tmp_path))
    try:
        assert engine._pages == {}
    finally:
        engine.close()


def test_the_spool_ceiling_counts_what_is_held_not_what_has_passed_through(tmp_path):
    """A crawl writes each page as it goes, so its spool never grows.

    The ceiling exists for a MULTI-page capture, which must hold every page's
    media until the last URL is fetched. Measuring the lifetime total instead
    would make a long crawl trip a bound it never actually approached — which
    is a capture that silently stops keeping images two hundred pages in."""
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    try:
        session._spool_bytes = renderer.SPOOL_MAX_BYTES
        session._spool_full = True
        page = renderer.RenderedPage(
            "https://e.com/",
            "<html></html>",
            10,
            "",
            _resources(tmp_path, {"https://e.com/a.png": ("image/png", b"P" * 100)}),
        )
        session.release(page.discard())
        assert session._spool_bytes == renderer.SPOOL_MAX_BYTES - 100
        assert session._spool_full is False
        # And it never goes negative, however many times it is handed back.
        session.release(10**12)
        assert session._spool_bytes == 0
    finally:
        session.close()


# ── refusals that arrive dressed as successes ──────────────────────────────
#
# The bug these exist for: CNN's edge answers a headless browser with HTTP 200,
# no content type, and thirteen bytes reading "Unknown Error". Nothing raises,
# the status is 2xx, and the engine used to package that string into a ZIM it
# reported as finished — a green tick over an empty archive.


class _FakePage:
    """Just enough page to ask the one question ``_refused_page`` asks."""

    def __init__(self, content_type, url="https://e.com/"):
        self._content_type = content_type
        self.url = url

    def evaluate(self, _script):
        if self._content_type is _FakePage:  # sentinel: the page cannot answer
            raise RuntimeError("execution context was destroyed")
        return self._content_type


def test_a_plain_text_refusal_is_not_packaged_as_a_page():
    refusal = renderer._refused_page(_FakePage("text/plain"))
    assert refusal, "a text/plain body is not a web page"
    assert "text/plain" in refusal
    # The message has to leave the person somewhere to go, and the fast engine
    # is where: it fetches without a browser and got this exact page.
    assert "Fast engine" in refusal


def test_a_real_page_is_not_convicted():
    assert renderer._refused_page(_FakePage("text/html")) == ""
    assert renderer._refused_page(_FakePage("application/xhtml+xml")) == ""
    # Case is the browser's business, not a reason to fail a capture.
    assert renderer._refused_page(_FakePage("TEXT/HTML")) == ""


def test_a_tiny_page_is_still_a_page():
    """The check is a fact about the content type, not a size heuristic.

    A one-line site is a legitimate capture — example.com is 1.2KB and real.
    Any threshold on bytes would eventually refuse one of those, which is why
    this asks the browser what it received instead of how much."""
    assert renderer._refused_page(_FakePage("text/html")) == ""


def test_a_page_that_cannot_answer_is_not_convicted():
    """Absence of evidence convicts nothing: a page whose context is gone gets
    the benefit of the doubt and the capture proceeds as it did before."""
    assert renderer._refused_page(_FakePage(_FakePage)) == ""
    assert renderer._refused_page(_FakePage("")) == ""


def test_the_browser_does_not_announce_itself_as_headless(monkeypatch):
    """The one token that decides whether the answer is a web page at all.

    Zimi still names itself in the same string — what comes out is the word
    ``Headless``, not the attribution. See ``_user_agent``."""
    from zimi.library import USER_AGENT

    session = renderer.RenderedSession()
    real = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "HeadlessChrome/151.0.7922.34 Safari/537.36"
    )

    class _Browser:
        def new_page(self):
            return _UAPage()

    class _UAPage:
        def evaluate(self, _script):
            return real

        def close(self):
            pass

    session._browser = _Browser()
    try:
        ua = session._user_agent()
    finally:
        session._browser = None
        session.close()
    assert "Headless" not in ua
    assert "Chrome/151.0.7922.34" in ua
    assert USER_AGENT in ua, "an operator reading logs must still see who this was"


# ── the furniture a page puts OVER itself ──────────────────────────────────

CONSENT_PAGE = b"""<!doctype html><html><head><style>
  body { overflow: hidden; margin: 0; }
  .veil { position: fixed; inset: 0; z-index: 999999; background: #fff; }
  .masthead { position: sticky; top: 0; z-index: 9998; background: #eee; }
  .slot { position: fixed; top: 0; left: 0; width: 100%; height: 200px; background: #000; }
</style></head><body>
  <header class="masthead">THE MASTHEAD</header>
  <div class="slot"></div>
  <div class="veil"><h1>Legal Terms and Privacy</h1>
    <p>By clicking "Agree", you agree to the Terms of Use.</p>
    <button>Agree</button></div>
  <article><h2>THE ARTICLE</h2><p>The reason anyone captured this page.</p></article>
</body></html>"""


@browser
def test_a_consent_wall_does_not_go_into_the_archive(tmp_path):
    """A modal in a ZIM is furniture nobody can move.

    Its button calls a script that was stripped, so the article behind it is
    unreachable for as long as the archive exists. Removing it agrees to
    nothing — nothing is clicked and no cookie is set; this deletes an element
    that cannot function offline, the same judgement already applied to every
    script on the page."""
    srv, url = _server({"/": ("text/html", CONSENT_PAGE)})
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    try:
        session.start()
        page = session.capture(url)
    finally:
        session.close()
        srv.shutdown()
        srv.server_close()
    html = page.html
    assert "THE ARTICLE" in html, "the page itself has to survive the cleaning"
    assert "THE MASTHEAD" in html, "a sticky header is part of the page, not over it"
    # The wall and the blocked ad slot are both gone from the stored markup.
    assert 'class="veil"' not in html
    assert 'class="slot"' not in html, "an empty fixed box is an ad slot, not content"
    # And the lock the modal left behind is released, or the capture is a page
    # that renders correctly and still cannot be scrolled.
    assert "overflow: visible" in html or "overflow:visible" in html


# ── the comma bug, in the browser ──────────────────────────────────────────

COMMA_SRCSET_PAGE = b"""<!doctype html><html><body>
<img src="https://media.example.com/a.jpg?c=16x9&q=h_720,w_1280,c_fill/f_webp"
     srcset="https://media.example.com/a.jpg?c=16x9&q=h_270,w_480,c_fill/f_webp 480w,
             https://media.example.com/a.jpg?c=16x9&q=h_720,w_1280,c_fill/f_webp 1280w"
     sizes="100vw" alt="commas">
</body></html>"""


@browser
def test_a_comma_inside_an_image_url_does_not_shred_the_srcset(tmp_path):
    """CNN's image API puts three commas in every URL it serves.

    Splitting a srcset on the bare comma turns one candidate into three
    fragments — a truncated URL and two pieces of query string — and the
    engine then goes and FETCHES `c_fill/f_webp`, 404s, and records the 404
    into the archive. The spec's rule is positional: skip separators, take the
    run of non-whitespace as the URL, and the rest up to the next comma is the
    descriptor."""
    srv, url = _server({"/": ("text/html", COMMA_SRCSET_PAGE)})
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    try:
        session.start()
        page = session._context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        candidates = page.evaluate(renderer._IMAGE_CANDIDATES_JS, 50)
        page.close()
    finally:
        session.close()
        srv.shutdown()
        srv.server_close()
    # Every candidate is a whole URL on the original host. Not one of them is a
    # fragment of somebody's query string.
    for got in candidates:
        assert got.startswith("https://media.example.com/a.jpg?"), got
        assert "c_fill/f_webp" in got, f"a candidate lost its tail: {got}"
    # And both real sizes survived as distinct candidates.
    assert any("w_480" in c for c in candidates), candidates
    assert any("w_1280" in c for c in candidates), candidates


TALL_PAGE = (
    "<!doctype html><html><body style='margin:0'>"
    + "".join(f"<div style='height:900px'>block {i}</div>" for i in range(40))
    + "<div id='floor'>THE BOTTOM</div></body></html>"
).encode()


@browser
def test_the_lazy_scroll_reaches_the_bottom_of_a_tall_page(tmp_path):
    """The scroll decides which pictures a rendered capture has.

    It used to stop after a fixed twelve viewport-heights, which on CNN's
    56,000px front page walked 9,720 of them — so the engine only ever ASKED
    for the images in the top sixth, and the archive held 30 entries where the
    fast engine's held 380. This page is 36,000px tall; a step-capped scroll
    stops a third of the way down it."""
    srv, url = _server({"/": ("text/html", TALL_PAGE)})
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    try:
        session.start()
        page = session._context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # Record the high-water mark BEFORE scrolling: the pass returns to the
        # top on purpose (the snapshot is taken from there), so reading
        # scrollY afterwards would always be zero and assert nothing.
        page.evaluate("""() => {
          window.__maxY = 0;
          addEventListener('scroll', () => {
            window.__maxY = Math.max(window.__maxY, window.scrollY);
          });
        }""")
        session._lazy_scroll(page)
        reached = page.evaluate("() => window.__maxY || 0")
        page.close()
    finally:
        session.close()
        srv.shutdown()
        srv.server_close()
    # The page is 36,000px tall. Twelve viewport-heights would have stopped
    # around 9,700 — the number that cost CNN 90% of its images.
    assert reached >= 30000, f"the scroll stopped {reached}px down a 36,000px page"


@browser
def test_a_page_that_grows_forever_still_ends(tmp_path):
    """An infinite feed has no bottom, so the bounds are what stop it.

    Without them the loop's exit condition — position past the page height —
    is one a growing page never satisfies."""
    srv, url = _server({"/": ("text/html", TALL_PAGE)})
    session = renderer.RenderedSession(work_dir=str(tmp_path))
    notes = []
    session._note = notes.append
    try:
        session.start()
        page = session._context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # Every scroll adds another screen: the page outruns the scroller.
        page.evaluate("""() => {
          addEventListener('scroll', () => {
            const d = document.createElement('div');
            d.style.height = '2000px';
            document.body.appendChild(d);
          });
        }""")
        import time as _t

        started = _t.monotonic()
        session._lazy_scroll(page)
        elapsed = _t.monotonic() - started
        page.close()
    finally:
        session.close()
        srv.shutdown()
        srv.server_close()
    # It stops, and it says why rather than quietly truncating the capture.
    assert elapsed < renderer.MAX_SCROLL_SECONDS + 20, elapsed
    assert any("still scrolling" in n for n in notes), notes


def test_the_stored_srcset_keeps_urls_that_contain_commas(tmp_path):
    """The fifth home of the comma bug: the server-side rewriter.

    This one runs over the STORED page, turning each srcset candidate into the
    asset the ZIM holds. Split on the bare comma and `carry()` is handed a
    truncated URL that matches nothing — so the image stays pointed at the live
    internet, and the shredded remains of its query string are written into the
    archive as if they were image addresses."""
    url = "https://e.com/a.jpg?c=16x9&q=h_720,w_1280,c_fill/f_webp"
    sink, assets = _assets(tmp_path, {url: ("image/webp", b"WEBP")})
    html = f'<img src="x.png" srcset="{url} 1280w, https://e.com/b.jpg 480w">'
    out = assets.rewrite(html) if hasattr(assets, "rewrite") else None
    if out is None:  # the rewriter is reached through the module function
        out = renderer._attr_re("srcset").sub(
            lambda m: renderer._fix_srcset(assets, m), html
        )
    # The comma-bearing candidate was recognised and carried: it resolves into
    # the ZIM (the query is hashed into the name, which is how a query becomes
    # part of an asset's identity) rather than staying pointed at the internet.
    assert "_assets/e_com/a." in out and ".jpg 1280w" in out, out
    # The one that was never carried keeps its own address, whole.
    assert "https://e.com/b.jpg 480w" in out, out
    # And nothing in the result is a fragment of somebody's query string
    # masquerading as an image address — the shape of the original bug.
    for candidate in out.split('srcset="')[1].rstrip('">').split(", "):
        url = candidate.split()[0]
        assert url.startswith(("http", "../_assets/")), f"shredded candidate: {url}"
    assert len(sink.items) == 1, "the comma URL was carried exactly once"
