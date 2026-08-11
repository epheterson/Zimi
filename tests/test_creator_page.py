"""`zimi create <url>` — one web page plus its same-origin assets → ZIM.

All HTTP is a local fixture server on port 8897 (the designated test port);
nothing here touches the real network. Real end-to-end: the built .zim is
read back with libzim's Archive.
"""

import http.server
import os
import struct
import sys
import threading

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from libzim.reader import Archive  # noqa: E402

import zimi.creator as creator  # noqa: E402
import zimi.server as _srv  # noqa: E402
import zimi.zimwriter as zimwriter  # noqa: E402
from zimi.zimwriter import parse_history  # noqa: E402

PORT = 8897
HOST = "127.0.0.1"
BASE = f"http://{HOST}:{PORT}"
# _slug() of the fixture hostname — the asset namespace inside the ZIM.
NS = "_assets/127_0_0_1"
# The flat article paths a multi-page capture assigns, derived the same way the
# engine derives them (host and path, slugged) so a port change moves both.
def _article_path(url_path):
    return "A/" + creator._slug(f"{HOST}:{PORT} {url_path}", "page")


POST_ART = _article_path("/blog/post.html")
FR_ART = _article_path("/fr/page.html")

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

# A page that is NOT UTF-8 and says so, the way plenty of the older web does.
LEGACY = (
    "<html><head><title>Legacy</title>"
    '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'
    f"</head><body><h1>Legacy</h1><p>£20 café</p><p>{FILLER}</p></body></html>"
)

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
    "/legacy.html": (
        200,
        "text/html; charset=windows-1252",
        LEGACY.encode("windows-1252"),
    ),
    "/data.bin": (200, "application/octet-stream", b"\x00\x01"),
    # A real (decodable) site icon, so the capture can prove it prefers the
    # site's own over a generated one. Built by Zimi's own PNG writer.
    "/apple-touch-icon.png": (
        200,
        "image/png",
        zimwriter.default_illustration("f", 64),
    ),
    "/r1": (302, "/blog/post.html", b""),
    "/loop": (302, "/loop", b""),
    # Language declarations, one per place a document can make them, plus a
    # page that links back to /blog/post.html so a multi-page capture has a
    # cross-link to resolve.
    "/fr/page.html": (
        200,
        "text/html; charset=utf-8",
        (
            '<html lang="fr-FR"><head><title>Le Titre</title></head><body>'
            f"<h1>Le Titre</h1><p>{FILLER}</p>"
            f'<a href="{BASE}/blog/post.html">the other page</a>'
            "</body></html>"
        ).encode(),
    ),
    "/de/page.html": (
        200,
        "text/html; charset=utf-8",
        (
            "<html><head><title>Der Titel</title>"
            '<meta http-equiv="content-language" content="de">'
            f"</head><body><h1>Der Titel</h1><p>{FILLER}</p></body></html>"
        ).encode(),
    ),
    "/hdr.html": (
        200,
        "text/html; charset=utf-8",
        f"<html><head><title>Header</title></head><body><p>{FILLER}</p></body></html>".encode(),
    ),
}

# Paths whose RESPONSE carries a Content-Language header — the last-resort
# signal, and the only one that cannot be expressed in the document body.
LANG_HEADERS = {"/hdr.html": "ja"}


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
            lang = LANG_HEADERS.get(self.path.split("?", 1)[0])
            if lang:
                self.send_header("Content-Language", lang)
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


def test_page_zim_records_its_birth(fixture_server, tmp_path):
    info = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    arc = Archive(info["path"])
    url = f"{BASE}/blog/post.html"
    # A URL source is BOTH the standard Source and the uniform Zimi one.
    assert bytes(arc.get_metadata("Source")).decode() == url
    assert bytes(arc.get_metadata("X-Zimi-Source")).decode() == url
    assert bytes(arc.get_metadata("Scraper")).decode() == f"Zimi {_srv.ZIMI_VERSION}"

    records = parse_history(arc.get_metadata(zimwriter.HISTORY_METADATA_KEY))
    assert len(records) == 1, "creation writes exactly one record"
    rec = records[0]
    assert rec["op"] == "created" and rec["mode"] == "page"
    assert rec["zimi"] == _srv.ZIMI_VERSION
    assert url in rec["detail"]
    assert rec["counts"] == {"pages": 1, "assets": info["assets"]}


def test_page_zim_conforms_and_wears_the_site_icon(fixture_server, tmp_path):
    info = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    arc = Archive(info["path"])
    # The Name keeps host AND path: another site's /blog/post.html is a
    # different ZIM, not another edition of this one.
    name = bytes(arc.get_metadata("Name")).decode()
    assert name == "zimi_eng_127_0_0_1_8897_blog_post_html"
    assert bytes(arc.get_metadata("Tags")).decode().startswith("_category:other;")

    png = bytes(arc.get_metadata("Illustration_48x48@1"))
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", png[16:24]) == (48, 48)
    if zimwriter.has_image_support():
        # The site's own icon was fetched and rescaled, not the generated one.
        assert png != zimwriter.default_illustration(name)
    else:
        assert png == zimwriter.default_illustration(name)


def test_captured_page_declares_utf8_whatever_the_original_said(
    fixture_server, tmp_path
):
    info = creator.create_page_zim(f"{BASE}/legacy.html", out_dir=str(tmp_path))
    art = _entry_text(Archive(info["path"]), "A/index")
    # The capture was decoded and re-encoded as UTF-8, so the original
    # windows-1252 declaration would now be a lie — and with entries carrying
    # a bare text/html mimetype, this tag is what a browser believes.
    assert "windows-1252" not in art.lower()
    assert art.lower().count("charset") == 1
    assert "charset='utf-8'" in art
    assert "£20 café" in art  # the bytes still say what they said


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


# ── content language ────────────────────────────────────────────────────────
#
# What language a capture is in is read off the document, in the three places a
# document can say it. Each test pins ONE of those places, because the value of
# the ladder is that a page which declares nothing in the first rung still gets
# the right answer from the second.


def test_language_from_html_lang_attribute(fixture_server, tmp_path):
    info = creator.create_page_zim(f"{BASE}/fr/page.html", out_dir=str(tmp_path))
    assert (info["language"], info["language_source"]) == ("fra", "html-lang")
    assert bytes(Archive(info["path"]).get_metadata("Language")).decode() == "fra"


def test_language_from_meta_content_language(fixture_server, tmp_path):
    info = creator.create_page_zim(f"{BASE}/de/page.html", out_dir=str(tmp_path))
    assert (info["language"], info["language_source"]) == ("deu", "meta")


def test_language_from_http_header(fixture_server, tmp_path):
    info = creator.create_page_zim(f"{BASE}/hdr.html", out_dir=str(tmp_path))
    assert (info["language"], info["language_source"]) == ("jpn", "http-header")


def test_language_falls_back_to_english_when_nothing_declared(
    fixture_server, tmp_path
):
    info = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    assert (info["language"], info["language_source"]) == ("eng", "fallback")


def test_an_explicit_language_beats_the_document(fixture_server, tmp_path):
    # The French page, captured as Spanish because the admin said so. A stated
    # preference is not a detection to be overruled.
    info = creator.create_page_zim(
        f"{BASE}/fr/page.html", language="spa", out_dir=str(tmp_path)
    )
    assert (info["language"], info["language_source"]) == ("spa", "requested")


def test_two_letter_tags_resolve_and_unknown_ones_do_not():
    assert creator.language_tag_to_iso3("en-GB") == "eng"
    assert creator.language_tag_to_iso3("pt_BR") == "por"
    # Three letters are taken at their word: ISO 639-3 has thousands of valid
    # codes and Zimi's display table knows thirty-odd of them.
    assert creator.language_tag_to_iso3("swa") == "swa"
    # Two letters we cannot resolve must NOT be invented into three.
    assert creator.language_tag_to_iso3("zz") is None
    assert creator.language_tag_to_iso3("") is None
    assert creator.language_tag_to_iso3("123") is None


# ── several pages, one ZIM ──────────────────────────────────────────────────


def _multi(tmp_path, *paths, **kw):
    return creator.create_pages_zim(
        [f"{BASE}{p}" for p in paths], out_dir=str(tmp_path), **kw
    )


def test_multi_page_capture_builds_an_index_of_its_pages(fixture_server, tmp_path):
    info = _multi(tmp_path, "/blog/post.html", "/fr/page.html")
    assert info["pages"] == 2 and info["skipped"] == []
    arc = Archive(info["path"])

    # The generated cover is the main page and names every captured page.
    assert arc.main_entry.get_item().path == "A/index"
    index = _entry_text(arc, "A/index")
    assert "Test Page" in index and "Le Titre" in index
    assert "2 pages captured by Zimi" in index

    # Both pages are really in there, as their own articles.
    for path in (POST_ART, FR_ART):
        assert arc.has_entry_by_path(path), path
    assert "Test Page" in _entry_text(arc, POST_ART)


def test_multi_page_capture_resolves_links_between_its_pages(
    fixture_server, tmp_path
):
    # The French page links to the other captured page. Inside the ZIM that
    # link must land on the sibling article, not back out at the live web.
    info = _multi(tmp_path, "/blog/post.html", "/fr/page.html")
    art = _entry_text(Archive(info["path"]), FR_ART)
    assert f'href="{POST_ART[2:]}"' in art
    assert f"{BASE}/blog/post.html" not in art


def test_multi_page_capture_shares_one_copy_of_a_shared_asset(
    fixture_server, tmp_path
):
    # Two captures of the same page: the shared dedupe map means the stylesheet
    # and its dependencies are stored once, not once per page.
    one = creator.create_page_zim(f"{BASE}/blog/post.html", out_dir=str(tmp_path))
    both = _multi(tmp_path, "/blog/post.html", "/fr/page.html")
    assert both["assets"] == one["assets"]


def test_multi_page_language_is_the_majority_of_what_the_pages_declare(
    fixture_server, tmp_path
):
    # One page declares French, the other declares nothing at all. A single
    # vote still beats silence — a ZIM carries one Language and "eng because
    # one page said nothing" would be the wrong one.
    info = _multi(tmp_path, "/blog/post.html", "/fr/page.html")
    assert (info["language"], info["language_source"]) == ("fra", "html-lang")


def test_one_url_is_still_exactly_a_single_page_capture(fixture_server, tmp_path):
    info = _multi(tmp_path, "/blog/post.html")
    # No index wrapper, no urls list — one page is one page.
    assert info["pages"] == 1 and "urls" not in info
    assert "Test Page" in _entry_text(Archive(info["path"]), "A/index")


def test_multi_page_names_what_it_could_not_capture(fixture_server, tmp_path):
    info = _multi(tmp_path, "/blog/post.html", "/missing.html", "/spa.html")
    assert info["pages"] == 1
    assert sorted(info["skipped"]) == [f"{BASE}/missing.html", f"{BASE}/spa.html"]
    # And says so IN THE ZIM: a collection that silently dropped two of three
    # URLs would be lying about itself to whoever opens it later.
    index = _entry_text(Archive(info["path"]), "A/index")
    assert "Not captured" in index
    assert "missing.html" in index and "spa.html" in index


def test_multi_page_fails_only_when_nothing_survived(fixture_server, tmp_path):
    with pytest.raises(creator.CreateError, match="none of those pages"):
        _multi(tmp_path, "/missing.html", "/data.bin")


def test_multi_page_url_cap_is_refused_not_silently_truncated(tmp_path):
    urls = [f"{BASE}/p{i}" for i in range(creator.MAX_PAGE_URLS + 1)]
    with pytest.raises(creator.CreateError, match="the limit is"):
        creator.create_pages_zim(urls, out_dir=str(tmp_path))


def test_multi_page_refuses_a_non_url(tmp_path):
    with pytest.raises(creator.CreateError, match="not an http"):
        creator.create_pages_zim(
            [f"{BASE}/blog/post.html", "/etc/passwd"], out_dir=str(tmp_path)
        )


def test_multi_page_identity_is_the_set_not_the_order(fixture_server, tmp_path):
    # Same two URLs typed in either order are the same collection, so they are
    # editions of one ZIM and carry one Name.
    a = _multi(tmp_path / "a", "/blog/post.html", "/fr/page.html")
    b = _multi(tmp_path / "b", "/fr/page.html", "/blog/post.html")
    name = lambda info: bytes(Archive(info["path"]).get_metadata("Name")).decode()
    assert name(a) == name(b)
    # …and adding a page makes it a different collection, not a new edition.
    c = _multi(tmp_path / "c", "/blog/post.html", "/fr/page.html", "/de/page.html")
    assert name(c) != name(a)


# ── the pre-flight probes ───────────────────────────────────────────────────


def test_page_probe_reports_what_a_capture_would_find(fixture_server):
    got = creator.probe_page(f"{BASE}/fr/page.html")
    assert got["title"] == "Le Titre"
    assert got["language"] == "fra" and got["language_source"] == "html-lang"
    assert got["spa"] is False
    assert got["bytes"] > 0


def test_page_probe_says_so_instead_of_refusing_an_spa(fixture_server):
    # The capture REFUSES an app shell; the probe REPORTS it. That is the
    # difference between the two: a preview that raised would tell you less.
    got = creator.probe_page(f"{BASE}/spa.html")
    assert got["spa"] is True


def test_page_probe_counts_assets_without_fetching_them(fixture_server):
    got = creator.probe_page(f"{BASE}/blog/post.html")
    # style.css, app.js, pic.png, abs.png — same-origin refs a capture would
    # try to carry. The probe never requests any of them.
    assert got["assets"] == 4


def test_folder_probe_counts_two_levels_and_never_follows_a_symlink(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "deep").mkdir()
    (tmp_path / "docs" / "a.html").write_text("<html></html>")
    (tmp_path / "docs" / "b.md").write_text("# b")
    (tmp_path / "docs" / "deep" / "c.pdf").write_bytes(b"%PDF-")
    (tmp_path / "pic.png").write_bytes(b"\x89PNG")
    (tmp_path / ".hidden").write_text("x")
    outside = tmp_path.parent / "outside"
    outside.mkdir()
    (tmp_path / "link").symlink_to(outside)

    got = creator.probe_folder(str(tmp_path))
    assert got["totals"] == {
        "pages": 2,
        "documents": 1,
        "media": 1,
        "other": 0,
    }
    names = [child["name"] for child in got["tree"]["children"]]
    assert names == ["docs"]  # the symlink is not a directory we will walk
    assert got["truncated"] is False


def test_folder_probe_stops_at_its_entry_budget(tmp_path):
    for i in range(30):
        (tmp_path / f"f{i}.html").write_text("<html></html>")
    got = creator.probe_folder(str(tmp_path), max_entries=10)
    assert got["truncated"] is True
    assert got["totals"]["pages"] < 30  # a partial answer, and it says so


def test_folder_probe_refuses_a_path_that_is_not_a_folder(tmp_path):
    with pytest.raises(creator.CreateError, match="not a folder"):
        creator.probe_folder(str(tmp_path / "nope"))


def test_cli_hands_the_video_arm_a_string_not_a_list(monkeypatch):
    # argparse collects `source` with nargs="+", so it is ALWAYS a list. The
    # video and zimit arms both read args.source directly and have always been
    # handed a string; one source must keep meaning exactly that.
    import argparse

    seen = {}
    monkeypatch.setattr("zimi.video.wants_url", lambda url, args: True)
    monkeypatch.setattr(
        "zimi.video.cli_create_video", lambda args: seen.update(src=args.source)
    )
    creator.cli_create(
        argparse.Namespace(source=["https://example.invalid/v"], title=None)
    )
    assert seen["src"] == "https://example.invalid/v"


def test_folder_language_is_read_from_the_html_inside_it(tmp_path):
    (tmp_path / "a.html").write_text('<html lang="fr"><body>bonjour</body></html>')
    (tmp_path / "b.html").write_text('<html lang="fr-CA"><body>salut</body></html>')
    info = creator.create_folder_zim(str(tmp_path), out_dir=str(tmp_path / "out"))
    assert (info["language"], info["language_source"]) == ("fra", "html-lang")


def test_folder_with_nothing_to_read_is_english(tmp_path):
    (tmp_path / "notes.md").write_text("# just markdown")
    info = creator.create_folder_zim(str(tmp_path), out_dir=str(tmp_path / "out"))
    assert (info["language"], info["language_source"]) == ("eng", "fallback")


def test_folder_language_stops_after_a_bounded_number_of_files(tmp_path):
    # The budget counts files OPENED, not answers found. Here only the 40th
    # file declares a language: a scan that stopped at its 20-file budget
    # cannot have seen it, so the honest answer is the fallback. A budget that
    # counted ANSWERS would read every file in the folder looking for one —
    # on a Pi that is also serving the library.
    files = []
    for i in range(50):
        name = f"p{i:02d}.html"
        declares = ' lang="fr"' if i == 40 else ""
        (tmp_path / name).write_text(f"<html{declares}><body>x</body></html>")
        files.append((str(tmp_path / name), name))
    assert creator._FOLDER_LANG_SAMPLE_FILES < 40  # the premise of this test
    assert creator.folder_language(None, files) == ("eng", "fallback")
    # …and the same folder, scanned with a budget that does reach it, finds it.
    assert creator.folder_language(None, files[39:]) == ("fra", "html-lang")


def test_a_language_code_nobody_can_resolve_is_a_clean_refusal(tmp_path):
    (tmp_path / "a.html").write_text("<html><body>x</body></html>")
    with pytest.raises(creator.CreateError, match="not an ISO 639-3 language code"):
        creator.create_folder_zim(
            str(tmp_path), language="zz", out_dir=str(tmp_path / "out")
        )


# ── progress, which is what makes cancelling possible ───────────────────────


def test_single_page_capture_reports_progress(fixture_server, tmp_path):
    lines = []
    creator.create_page_zim(
        f"{BASE}/blog/post.html", out_dir=str(tmp_path), progress=lines.append
    )
    # Two phase boundaries, both naming the page — a live log, and the two
    # points a cancel can land.
    assert len(lines) >= 2
    assert any("fetching" in line for line in lines)
    assert any("packaging" in line for line in lines)


def test_a_single_url_capture_can_be_cancelled_through_its_progress_sink(
    fixture_server, tmp_path
):
    # This is the whole contract the web job's cancel button rests on: the sink
    # raises, and that has to unwind out of the engine. A page capture with no
    # reachable checkpoint would make the button a lie.
    class Cancelled(Exception):
        pass

    def sink(_message):
        raise Cancelled()

    with pytest.raises(Cancelled):
        creator.create_page_zim(
            f"{BASE}/blog/post.html", out_dir=str(tmp_path), progress=sink
        )
    # And nothing half-written is left behind under a real name.
    assert not [p for p in os.listdir(tmp_path) if p.endswith(".zim")]


def test_multi_page_delegation_keeps_the_progress_sink(fixture_server, tmp_path):
    # ONE url goes through create_page_zim; the callback must survive that hop,
    # because a single address is the common case and the case whose cancel
    # button would otherwise do nothing.
    lines = []
    creator.create_pages_zim(
        [f"{BASE}/blog/post.html"], out_dir=str(tmp_path), progress=lines.append
    )
    assert any("fetching" in line for line in lines)
