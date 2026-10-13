"""An import while anyone can manage Zimi reaches only public addresses, judged
by the address actually connected to: a name can resolve public at the check
and private at the fetch (DNS rebinding).

Run: pytest tests/test_import_public_only.py -v
"""

import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import library, netguard  # noqa: E402


@pytest.fixture()
def local_server():
    hits = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", "4")
            self.end_headers()
            self.wfile.write(b"ZIM\x04")

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/wiki.zim" % srv.server_address[1], hits
    srv.shutdown()


def test_the_name_check_passing_does_not_reach_a_private_address(
    local_server, monkeypatch, tmp_path
):
    url, hits = local_server
    # The name answered public when it was checked; the fetch lands here.
    monkeypatch.setattr(netguard.PrivateGuard, "refuses", lambda self, host: False)
    dl = {"id": "1", "filename": "wiki.zim", "_public_only": True}
    ok, err = library._download_from_url(dl, url, str(tmp_path / "wiki.zim.tmp"))
    assert not ok and "private address" in err, err
    assert hits == []


def test_without_the_rule_the_same_fetch_goes_through(local_server, tmp_path):
    url, hits = local_server
    dl = {"id": "1", "filename": "wiki.zim"}
    ok, err = library._download_from_url(dl, url, str(tmp_path / "wiki.zim.tmp"))
    assert ok, err
    assert hits == ["/wiki.zim"]
