"""`zimi create <url>` — one web page plus its same-origin assets → ZIM.

All HTTP is a local fixture server on port 8897 (the designated test port);
nothing here touches the real network. Real end-to-end: the built .zim is
read back with libzim's Archive.
"""

import http.server
import os
import sys
import threading

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from libzim.reader import Archive  # noqa: E402

import zimi.creator as creator  # noqa: E402
import zimi.zimwriter as zimwriter  # noqa: E402

PORT = 8897
HOST = "127.0.0.1"
BASE = f"http://{HOST}:{PORT}"
# _slug() of the fixture hostname — the asset namespace inside the ZIM.
NS = "_assets/127_0_0_1"

FILLER = (
    "This paragraph exists so the fixture page carries enough server-rendered "
    "text to clear the SPA shell detector by a comfortable margin. " * 3
)

PAGE = f"""<html><head><title>Test Page</title>
<link rel="stylesheet" href="/static/style.css">
<style>.hero{{background:url('img/hero.png')}}</style>
<script src="/static/app.js"></script>
<base href="{BASE}/blog/">
</head><body>
<h1>Test Page</h1>
<p>{FILLER}</p>
<img src="img/pic.png">
<img src="{BASE}/img/abs.png">
<a href="/other">another page</a>
<a href="#frag">fragment</a>
<a href="mailto:x@y.z">mail</a>
<script>trackEverything()</script>
</body></html>"""

SPA = """<html><head><title>App</title></head>
<body><div id="root"></div><script src="/bundle.js"></script></body></html>"""

ROUTES = {
    "/blog/post.html": (200, "text/html; charset=utf-8", PAGE.encode()),
    "/spa.html": (200, "text/html; charset=utf-8", SPA.encode()),
    "/static/style.css": (
        200,
        "text/css",
        b"h1{color:red;background:url('bg.png')}" b"@font-face{src:url('font.woff2')}",
    ),
    "/static/bg.png": (200, "image/png", b"BGBYTES"),
    "/static/font.woff2": (200, "font/woff2", b"FONTBYTES"),
    # The page lives at /blog/post.html, so its relative img/… refs resolve
    # under /blog/ — only abs.png is addressed from the site root.
    "/blog/img/pic.png": (200, "image/png", b"PICBYTES"),
    "/img/abs.png": (200, "image/png", b"ABSBYTES"),
    "/blog/img/hero.png": (200, "image/png", b"HEROBYTES"),
    "/data.bin": (200, "application/octet-stream", b"\x00\x01"),
    "/r1": (302, "/blog/post.html", b""),
    "/loop": (302, "/loop", b""),
}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        route = ROUTES.get(self.path.split("?", 1)[0])
        if route is None:
            self.send_response(404)
            self.end_headers()
            return
        status, meta, body = route
        self.send_response(status)
        if status in (301, 302):
            self.send_header("Location", meta)
        else:
            self.send_header("Content-Type", meta)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status == 200:
            self.wfile.write(body)

    def log_message(self, format, *args):
        pass


@pytest.fixture(scope="module")
def fixture_server():
    srv = http.server.ThreadingHTTPServer((HOST, PORT), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield BASE
    srv.shutdown()
    srv.server_close()


@pytest.fixture(autouse=True)
def _online(monkeypatch):
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)


def _entry_text(arc, path):
    return bytes(arc.get_entry_by_path(path).get_item().content).decode("utf-8")


# ── the capture, end to end ─────────────────────────────────────────────────


def test_page_capture_end_to_end(fixture_server, tmp_path):
    info = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    arc = Archive(info["path"])
    assert arc.main_entry.get_item().path == "A/index"
    art = _entry_text(arc, "A/index")

    # Relative and same-origin-absolute images both carried and rewritten.
    assert f"../{NS}/blog/img/pic.png" in art
    assert (
        bytes(arc.get_entry_by_path(f"{NS}/blog/img/pic.png").get_item().content)
        == b"PICBYTES"
    )
    assert f"../{NS}/img/abs.png" in art
    assert arc.has_entry_by_path(f"{NS}/img/abs.png")

    # The stylesheet is carried (not inlined) and the <link> points at the
    # copy; its own url() refs resolve beside it, one level deep.
    assert f"href='../{NS}/static/style.css'" in art.replace('"', "'")
    css = _entry_text(arc, f"{NS}/static/style.css")
    assert "url('bg.png')" in css and "url('font.woff2')" in css
    assert arc.has_entry_by_path(f"{NS}/static/bg.png")
    assert arc.has_entry_by_path(f"{NS}/static/font.woff2")

    # Inline <style> backgrounds carried, rewritten relative to the article.
    assert f"url('../{NS}/blog/img/hero.png')" in art
    assert arc.has_entry_by_path(f"{NS}/blog/img/hero.png")

    # No JavaScript ships, and <base> (which would re-absolutize every
    # rewritten reference) is gone.
    assert "<script" not in art and "trackEverything" not in art
    assert "<base" not in art

    # Off-page links point back at the live web; fragment/mailto untouched.
    assert f'href="{BASE}/other"' in art
    assert 'href="#frag"' in art and 'href="mailto:x@y.z"' in art

    # Provenance and standard metadata.
    assert bytes(arc.get_metadata("Source")).decode() == f"{BASE}/blog/post.html"
    assert bytes(arc.get_metadata("Title")).decode() == "Test Page"
    assert bytes(arc.get_metadata("Creator")).decode() == "Zimi"
    assert info["assets"] == 6


def test_redirect_followed_to_final_base(fixture_server, tmp_path):
    # The final URL after the hop is the base for asset resolution — the
    # relative img on the destination page must still resolve and carry.
    info = creator.create_page_zim(f"{BASE}/r1", out_dir=str(tmp_path))
    arc = Archive(info["path"])
    assert info["url"] == f"{BASE}/blog/post.html"
    assert arc.has_entry_by_path(f"{NS}/blog/img/pic.png")


# ── refusals ────────────────────────────────────────────────────────────────


def test_spa_shell_refused_with_zimit_pointer(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="zimit"):
        creator.create_page_zim(f"{BASE}/spa.html", out_dir=str(tmp_path))
    assert not list(tmp_path.glob("*.zim"))  # no spinner ZIM left behind


def test_spa_detector_heuristic():
    assert creator.looks_like_spa(SPA)
    assert not creator.looks_like_spa(PAGE)  # real text clears the threshold
    # No scripts at all → never flagged, however short.
    assert not creator.looks_like_spa("<html><body>tiny</body></html>")


def test_offline_mode_refuses_url(monkeypatch, tmp_path):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    with pytest.raises(creator.CreateError, match="ZIMI_OFFLINE"):
        creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))


def test_non_html_refused(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="not an HTML page"):
        creator.create_page_zim(f"{BASE}/data.bin", out_dir=str(tmp_path))


def test_redirect_loop_bounded(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="too many redirects"):
        creator.create_page_zim(f"{BASE}/loop", out_dir=str(tmp_path))


def test_bad_scheme_refused(tmp_path):
    with pytest.raises(creator.CreateError, match="not an http"):
        creator.create_page_zim("ftp://example.com/x", out_dir=str(tmp_path))


def test_http_error_is_a_clear_message(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="HTTP 404"):
        creator.create_page_zim(f"{BASE}/missing.html", out_dir=str(tmp_path))


# ── asset caps ──────────────────────────────────────────────────────────────


def test_oversized_asset_skipped_not_fatal(fixture_server, tmp_path, monkeypatch):
    # The carrier's per-asset byte cap is honored at fetch time: an
    # oversized asset is dropped (reference left as-is), the page still
    # packages.
    monkeypatch.setattr(zimwriter, "_MAX_ASSET_BYTES", 4)
    info = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    arc = Archive(info["path"])
    assert info["assets"] == 0
    assert not arc.has_entry_by_path(f"{NS}/blog/img/pic.png")
    art = _entry_text(arc, "A/index")
    assert 'src="img/pic.png"' in art  # untouched reference, honestly broken


def test_asset_count_cap_honored(fixture_server, tmp_path, monkeypatch):
    monkeypatch.setattr(zimwriter, "_MAX_ASSETS", 1)
    info = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    # The carrier checks the cap before counting the asset it is currently
    # carrying, so a stylesheet plus one of its url() deps lands at 2 — the
    # carrier's long-standing accounting, bounded either way. Everything
    # after the cap (the page's images) is skipped.
    assert info["assets"] == 2
    assert not Archive(info["path"]).has_entry_by_path(f"{NS}/blog/img/pic.png")
