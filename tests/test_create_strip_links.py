"""Create a ZIM: "Remove links that lead outside the ZIM" (#99).

tripplehelix: "It can be confusing as to which links take you to the web,
having a check box when creating the zim to just remove external links would
be very helpful." Zimi's reader marks such links on every ZIM, but a ZIM
travels to readers that are not Zimi, so the capture can leave them out too.

Real end to end: a local fixture site with links out, crawled and captured
through the shipped engines, the written ZIM read back with libzim.

Run: pytest tests/test_create_strip_links.py -v
"""

import http.server
import os
import re
import sys
import threading

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from libzim.reader import Archive  # noqa: E402

import zimi.crawler as crawler  # noqa: E402
import zimi.creator as creator  # noqa: E402
import zimi.manage as manage  # noqa: E402
from zimi.zimwriter import HISTORY_METADATA_KEY, parse_history  # noqa: E402


def _page(title, body):
    return (
        f"<html><head><title>{title}</title></head><body>"
        "<p>Server-rendered prose, enough of it that the fast engine reads this "
        "as a page and not an application shell waiting on a script to run. "
        "It has sentences, and they say things, and none of them need a "
        f"browser.</p>{body}</body></html>"
    ).encode()


# Two captured pages that link to each other, and to everything else a page
# links to: other sites (plain, protocol-relative, upper-case, www and not),
# a page of this site beyond the crawl, mail, a phone, an anchor, a script.
HOME = _page(
    "Home",
    '<a href="/about.html">about</a> '
    '<a href="https://elsewhere.example/x" target="_blank" rel="noopener" class="ext">elsewhere</a> '
    '<a href="//cdn.other.example/y">protocol-relative</a> '
    "<A HREF='http://shout.example/'>shouting</A> "
    '<a href="mailto:someone@example.org">mail</a> '
    '<a href="tel:+15551234">phone</a> '
    '<a href="#top">top</a> '
    '<a href="javascript:void(0)">nothing</a>'
    '<script>var s = "<a href=https://inside.script.example>x</a>";</script>',
)
ABOUT = _page(
    "About",
    '<a href="/">home</a> '
    '<a href="https://www.elsewhere.example/about"><b>bold</b> elsewhere</a> '
    '<a href="/deep/uncaptured.html">deeper</a>',
)
ROUTES = {"/": HOME, "/about.html": ABOUT, "/deep/uncaptured.html": _page("Deep", "")}
OUTSIDE = ("elsewhere.example", "cdn.other.example", "shout.example")


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("#", 1)[0]
        if path == "/robots.txt":
            body, ctype = b"User-agent: *\nAllow: /\n", "text/plain"
        elif path in ROUTES:
            body, ctype = ROUTES[path], "text/html; charset=utf-8"
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_a):
        pass


@pytest.fixture(scope="module")
def site():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()
    srv.server_close()


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    # The fast engine takes its two pictures when a browser is installed; this
    # is about links, and a browser start would be most of the runtime.
    monkeypatch.setattr(
        creator.BuiltinCapture, "_can_take_pictures", lambda self: False
    )


def _html_entries(arc):
    out = {}
    for i in range(arc.entry_count):
        entry = arc._get_entry_by_id(i)
        if entry.is_redirect:
            continue
        item = entry.get_item()
        if item.mimetype.startswith("text/html"):
            out[entry.path] = bytes(item.content).decode("utf-8")
    return out


def _outside_links(html):
    """Every link a page still has to another site."""
    found = []
    for m in re.finditer(r"<a\b[^>]*>", html, re.I):
        href = re.search(r"""href\s*=\s*["']?([^"'\s>]+)""", m.group(0), re.I)
        if href and any(host in href.group(1) for host in OUTSIDE):
            found.append(href.group(1))
    return found


def _history(arc):
    return parse_history(bytes(arc.get_metadata(HISTORY_METADATA_KEY)))[-1]


# ── the rewrite ─────────────────────────────────────────────────────────────


def test_links_to_other_sites_become_their_own_text():
    page, n = creator.unlink_other_sites(HOME.decode(), "https://www.site.example/")
    assert n == 3
    assert _outside_links(page) == []
    # The words stay, in a span that keeps the link's other attributes.
    assert '<span class="ext">elsewhere</span>' in page
    assert "<span>protocol-relative</span>" in page
    assert "<span>shouting</span>" in page
    # What is not another site stays a link.
    for kept in (
        'href="/about.html"',
        'href="mailto:',
        'href="tel:',
        'href="#top"',
        'href="javascript:',
    ):
        assert kept in page, kept
    # A script's string is not markup.
    assert '"<a href=https://inside.script.example>x</a>"' in page


def test_the_same_site_is_the_same_with_or_without_www():
    html = '<a href="https://site.example/a">a</a><a href="http://www.site.example/b">b</a>'
    page, n = creator.unlink_other_sites(html, "https://www.site.example/")
    assert (page, n) == (html, 0)


def test_a_link_wrapping_markup_closes_on_its_own_tag():
    html = '<p><a href="https://x.example/"><b>bold</b> text</a> after <a href="/in">in</a></p>'
    page, n = creator.unlink_other_sites(html, "https://site.example/")
    assert n == 1
    assert page == '<p><span><b>bold</b> text</span> after <a href="/in">in</a></p>'


def test_off_the_option_changes_nothing_and_records_nothing():
    off = creator.OtherSiteLinks(False)
    assert off(HOME.decode(), "https://site.example/") == HOME.decode()
    assert off.count() is None and off.phrase() == ""
    on = creator.OtherSiteLinks(True)
    on(HOME.decode(), "https://site.example/")
    assert on.count() == 3
    assert on.phrase() == ", 3 links leading outside the ZIM removed"


# ── end to end ──────────────────────────────────────────────────────────────


def test_a_site_crawl_with_the_option_writes_no_link_to_another_site(site, tmp_path):
    result = crawler.create_site_zim(
        site + "/",
        out_dir=str(tmp_path),
        max_pages=2,
        delay=0,
        strip_links=True,
    )
    arc = Archive(result["path"])
    pages = _html_entries(arc)
    assert len(pages) >= 2, pages.keys()
    for path, html in pages.items():
        assert _outside_links(html) == [], path
    everything = "".join(pages.values())
    # The captured pages still reach each other, and the words of every
    # removed link are still there to read.
    assert "about" in everything and "<span>protocol-relative</span>" in everything
    assert "<span><b>bold</b> elsewhere</span>" in everything
    # A page of this site the crawl did not reach is the site, not another one.
    assert "/deep/uncaptured.html" in everything
    assert 'href="mailto:someone@example.org"' in everything
    record = _history(arc)
    assert record["links_removed"] == 4
    assert "4 links leading outside the ZIM removed" in record["detail"]


def test_without_the_option_the_links_stay(site, tmp_path):
    result = crawler.create_site_zim(
        site + "/", out_dir=str(tmp_path), max_pages=2, delay=0
    )
    arc = Archive(result["path"])
    everything = "".join(_html_entries(arc).values())
    assert len(_outside_links(everything)) == 4
    assert "links_removed" not in _history(arc)


def test_a_page_capture_with_the_option(site, tmp_path):
    result = creator.create_page_zim(
        site + "/", out_dir=str(tmp_path), strip_links=True
    )
    arc = Archive(result["path"])
    html = _html_entries(arc)["A/index"]
    assert _outside_links(html) == []
    assert "elsewhere" in html
    assert _history(arc)["links_removed"] == 3


def test_several_pages_keep_their_links_to_each_other(site, tmp_path):
    result = creator.create_pages_zim(
        [site + "/", site + "/about.html"], out_dir=str(tmp_path), strip_links=True
    )
    arc = Archive(result["path"])
    pages = _html_entries(arc)
    for path, html in pages.items():
        assert _outside_links(html) == [], path
    assert _history(arc)["links_removed"] == 4


# ── the web form's contract ─────────────────────────────────────────────────


def test_the_form_takes_it_for_page_and_site_off_by_default():
    for mode in ("page", "site"):
        _m, _s, _t, opts = manage._create_validate(
            {"mode": mode, "source": "https://site.example/"}
        )
        assert opts["strip_links"] is False, mode
        _m, _s, _t, opts = manage._create_validate(
            {"mode": mode, "source": "https://site.example/", "strip_links": True}
        )
        assert opts["strip_links"] is True, mode
    _m, _s, _t, opts = manage._create_validate(
        {
            "mode": "video",
            "source": "https://www.youtube.com/watch?v=x",
            "strip_links": True,
        }
    )
    assert "strip_links" not in opts


def test_the_form_drops_it_where_another_program_writes_the_pages(monkeypatch):
    """alive and zimit: warc2zim and zimit package the ZIM, and the pages' links
    are rewritten at replay. A stale checkbox is dropped, like block_ads."""
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: True)
    _m, _s, _t, opts = manage._create_validate(
        {
            "mode": "site",
            "source": "https://site.example/",
            "engine": "alive",
            "strip_links": True,
        }
    )
    assert "strip_links" not in opts
    assert manage._create_unlink_engine(None)
    assert manage._create_unlink_engine("rendered")
    assert manage._create_unlink_engine("singlefile")
    assert not manage._create_unlink_engine("zimit")


def test_a_job_hands_it_to_the_engine(monkeypatch):
    seen = {}

    def fake_site(url, **kw):
        seen.update(kw)
        return {}

    monkeypatch.setattr(crawler, "create_site_zim", fake_site)
    job = manage._CreateJob("site", "https://site.example/", None)
    manage._create_run(job, {"strip_links": True})
    assert seen.get("strip_links") is True
