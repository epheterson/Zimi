"""Answers about the person and the server's current settings are never
stored by the browser.

Chrome's Back reuses stored answers without asking the server. A stored
/whoami put back an app the admin had just turned off (CI's slow runner:
test_apps_come_back_live), so /whoami, /me/prefs and /userdata say no-store.
"""

import os
import sys
import threading
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _headers(base, path):
    try:
        with urllib.request.urlopen(base + path) as r:
            return r.status, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def test_identity_answers_are_never_stored(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    try:
        for path in ("/whoami", "/me/prefs", "/userdata"):
            status, h = _headers(base, path)
            if status == 200:
                assert h.get("Cache-Control") == "no-store", (path, dict(h))
        # Same connection handler, next request: the flag does not leak.
        status, h = _headers(base, "/health")
        assert h.get("Cache-Control") != "no-store", dict(h)
    finally:
        httpd.shutdown()
