"""The capture proxy keeps the private-address rule on the connection.

Chromium's request interception never sees a redirect's next hop: a public page
that answered 302 to a private address took the browser there (the 1.13.1
review proved it, for a page and for an image). Under the rule the browser
now goes through zimi.captureproxy, which judges every connection.

"Private" here is the name ``localhost``: the fixture server answers on
127.0.0.1 and on localhost alike, and the guard refuses only the name, so a
request that reaches the server as localhost is one the rule let through.
"""

import http.client
import http.server
import socket
import threading
import urllib.error
import urllib.request

import pytest

from zimi import creator, renderer
from zimi.captureproxy import CaptureProxy


class _NameGuard:
    """Refuses the names (or addresses) it is given."""

    def __init__(self, *refused):
        self._refused = set(refused)

    def refuses(self, host):
        return (host or "").strip("[]").lower() in self._refused


@pytest.fixture
def site():
    hits = []

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            hits.append((self.headers.get("Host", "").split(":")[0], self.path))
            if self.path in ("/start", "/img"):
                self.send_response(302)
                self.send_header(
                    "Location", f"http://localhost:{port}/secret{self.path}"
                )
                self.end_headers()
                return
            body = (
                b"<html><body>public<img src='http://127.0.0.1:%d/img'></body></html>"
                % port
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield port, hits
    server.shutdown()


def _private_hits(hits):
    return [h for h in hits if h[0] == "localhost"]


def _through(proxy_url, url):
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url})
    )
    return opener.open(url, timeout=10)


def test_the_proxy_forwards_what_the_rule_allows(site):
    port, hits = site
    proxy = CaptureProxy(_NameGuard("localhost"))
    try:
        with _through(proxy.url, f"http://127.0.0.1:{port}/page") as r:
            assert b"public" in r.read()
    finally:
        proxy.close()
    assert hits == [("127.0.0.1", "/page")]


def test_the_proxy_refuses_a_private_name(site):
    port, hits = site
    proxy = CaptureProxy(_NameGuard("localhost"))
    try:
        # No answer at all, so nothing can be taken for the page's own.
        with pytest.raises((urllib.error.URLError, ConnectionError, http.client.HTTPException)):
            _through(proxy.url, f"http://localhost:{port}/page")
        # A tunnel is judged the same way.
        s = socket.create_connection(("127.0.0.1", proxy.server_address[1]), timeout=5)
        s.sendall(
            f"CONNECT localhost:{port} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode()
        )
        assert s.recv(100).startswith(b"HTTP/1.1 403")
        s.close()
    finally:
        proxy.close()
    assert not _private_hits(hits)


def test_the_proxy_judges_the_address_it_reached(site):
    """A name that passes but lands on a refused address (DNS rebinding) is
    refused on the connected peer."""
    port, hits = site
    proxy = CaptureProxy(_NameGuard("127.0.0.1"))
    try:
        with pytest.raises((urllib.error.URLError, ConnectionError, http.client.HTTPException)):
            _through(proxy.url, f"http://localhost:{port}/page")
    finally:
        proxy.close()
    assert not hits


def test_a_redirect_from_a_public_page_to_a_private_one_is_refused(site):
    """The page and its image both redirect to localhost: neither arrives."""
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from playwright.sync_api import sync_playwright

    port, hits = site
    with creator.private_addresses_refused(_NameGuard("localhost")):
        proxy = creator.capture_proxy_url()
        with sync_playwright() as pw:
            browser = renderer._launch(pw.chromium, proxy)
            try:
                ctx = browser.new_context()
                page = ctx.new_page()
                try:
                    page.goto(f"http://127.0.0.1:{port}/start", timeout=10000)
                except Exception:
                    pass  # the refused hop fails the navigation; that is the point
                page = ctx.new_page()  # the first is still on its error page
                page.goto(f"http://127.0.0.1:{port}/page", timeout=10000)
                page.wait_for_timeout(500)
                try:
                    ctx.request.get(f"http://127.0.0.1:{port}/start", timeout=10000)
                except Exception:
                    pass
            finally:
                browser.close()
    assert ("127.0.0.1", "/start") in hits and ("127.0.0.1", "/img") in hits
    assert not _private_hits(hits), hits


def test_the_proxy_stops_with_the_capture():
    with creator.private_addresses_refused(_NameGuard()):
        url = creator.capture_proxy_url()
        assert creator.capture_proxy_url() == url  # one per capture
    port = int(url.rsplit(":", 1)[1])
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=2).close()


def test_no_rule_no_proxy():
    assert creator.capture_proxy_url() is None


def test_singlefile_goes_through_the_proxy(site, tmp_path):
    import shutil

    from zimi import singlefile

    if not shutil.which(singlefile.SINGLEFILE_BIN) or not singlefile.chromium_path():
        pytest.skip("SingleFile or its Chromium is not installed here")
    port, hits = site
    with creator.private_addresses_refused(_NameGuard("localhost")):
        try:
            singlefile.capture_page(f"http://127.0.0.1:{port}/page", work_dir=str(tmp_path), timeout=30)
        except creator.CreateError:
            pass
    assert ("127.0.0.1", "/img") in hits
    assert not _private_hits(hits), hits


def test_yt_dlp_goes_through_the_proxy(site):
    pytest.importorskip("yt_dlp")
    import yt_dlp

    from zimi import video

    port, hits = site
    with creator.private_addresses_refused(_NameGuard("localhost")):
        try:
            video._flat_entries(yt_dlp, f"http://127.0.0.1:{port}/start", 1)
        except Exception:
            pass  # the refused hop fails the probe; that is the point
    assert ("127.0.0.1", "/start") in hits
    assert not _private_hits(hits), hits


def test_a_rendered_capture_redirected_to_a_private_address_says_so(site, tmp_path):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    port, hits = site
    with creator.private_addresses_refused(_NameGuard("localhost")):
        with renderer.RenderedSession(work_dir=str(tmp_path), page_timeout=15) as session:
            with pytest.raises(creator.PrivateAddressRefused, match="localhost is a private address"):
                session.capture(f"http://127.0.0.1:{port}/start")
    assert not _private_hits(hits), hits
