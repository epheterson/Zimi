"""A zimit 1 ZIM opens on the first tap and Back leaves it.

Off the Grid (100r-off-the-grid, a zimit 1 capture) opens on A/index.html,
whose load.js registers a replay service worker and then moves on to the
capture. Under Zimi it spun forever on the first open (Zimi's own worker
already controlled the page, so load.js posted to the wrong one), and once it
did open, Back returned to index.html, which sent the page forward again: the
iPhone edge swipe did nothing. Zimi serves load.js waiting for the replay
worker and moving on with location.replace.

Run: pytest tests/test_zimit1_loader.py -v
"""

import os
import sys
import threading
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The parts of zimit 1's load.js that matter, as the real ZIM carries them.
ZIMIT1_LOAD_JS = """async function main() {
  const sw = navigator.serviceWorker;
  var prefix = window.location.href.slice(0, window.location.href.search(/[/]A[/][^/]+[.]/));
  const name = prefix.slice(prefix.lastIndexOf("/") + 1).replace(/[\\W]+/, "");
  prefix += "/A/";
  await sw.register("./sw.js?replayPrefix=&root=" + name, {scope: prefix});
  sw.addEventListener("message", (event) => {
    if (event.data.msg_type === "collAdded" && event.data.name === name) {
      prefix += window.mainUrl.slice(window.mainUrl.indexOf("//") + 2);
      window.location.href = prefix;
    }
  });
  await new Promise((resolve) => {
    if (!sw.controller) {
      sw.addEventListener("controllerchange", () => { resolve(); });
    } else {
      resolve();
    }
  });
  sw.controller.postMessage({msg_type: "addColl", name: name, topTemplateUrl: "./topFrame.html"});
}
window.addEventListener("load", main);
"""
OTHER_LOAD_JS = "window.location.href = prefix; if (!sw.controller) {}\n"


@pytest.fixture
def served(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from books_sources_fixture import build_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_zim(
        str(zdir / "grid.zim"),
        {"Title": "Off the Grid"},
        {
            "A/index.html": (
                "text/html",
                "<html><head></head><body></body></html>",
                "Off the Grid",
            ),
            "A/load.js": ("application/javascript", ZIMIT1_LOAD_JS, ""),
            "A/site/load.js": ("application/javascript", OTHER_LOAD_JS, ""),
        },
        main_path="A/index.html",
    )
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _get(url):
    req = urllib.request.Request(url, headers={"Sec-Fetch-Dest": "script"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode(), r.headers.get("ETag")


def test_loader_waits_for_the_replay_worker_and_replaces(served):
    body, _ = _get(served + "/w/grid/A/load.js")
    # Back must not land on index.html: moving on replaces it in history.
    assert "window.location.replace(prefix);" in body
    assert "window.location.href = prefix" not in body
    # Zimi's own worker is a controller too; only the replay worker counts.
    assert "sw.controller.scriptURL.indexOf('sw.js?replayPrefix') < 0" in body


def test_other_load_js_untouched(served):
    body, _ = _get(served + "/w/grid/A/site/load.js")
    assert body == OTHER_LOAD_JS


def test_mended_loader_has_its_own_etag(served):
    """A phone holding the unmended copy revalidates it; the ETag must change
    or it would be told 304 and keep the trap."""
    import hashlib

    import zimi.http as zh

    _, etag = _get(served + "/w/grid/A/load.js")
    st = os.stat(os.path.join(zh._srv.ZIM_DIR, "grid.zim"))
    plain = hashlib.md5(
        f"grid/A/load.js/{st.st_size}-{int(st.st_mtime)}".encode()
    ).hexdigest()[:16]
    assert etag != '"%s"' % plain
