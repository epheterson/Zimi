"""An article with no colours of its own is readable in dark mode, in the real reader.

Twice wrong in 1.12's making: first black text on black (the simulated dark
inverted text the browser had already made white), then, fixed in a test
frame, white text on white in the real reader, whose frame is white behind a
page with no background. This opens the fixture's unstyled article in the
reader itself and measures the text against what actually paints behind it.
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Readable text is at least this far from what paints behind it (luminance).
_MIN_LUM_GAP = 0.5


@pytest.fixture
def served(tmp_path, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_wiki_fixture_zim

    import zimi.server as srv
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


# The text's luminance and the luminance of the first opaque paint behind it:
# body, then the page's root, then the reader frame itself.
_MEASURE = """() => {
  const lum = c => { const p = (c.match(/[\\d.]+/g) || []).map(Number);
    return { l: (0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]) / 255, a: p.length > 3 ? p[3] : 1 }; };
  const f = document.getElementById('reader-frame'), d = f.contentDocument, w = d.defaultView;
  const p = d.querySelector('p') || d.body;
  const text = lum(w.getComputedStyle(p).color);
  const filtered = w.getComputedStyle(d.documentElement).filter;
  let behind = null;
  for (const el of [d.body, d.documentElement]) {
    const b = lum(w.getComputedStyle(el).backgroundColor);
    if (b.a >= 0.5) { behind = b.l; break; }
  }
  if (behind === null) behind = lum(getComputedStyle(f).backgroundColor).l;
  // Under the simulated dark the whole page is inverted: both flip.
  const inverted = /invert\\(1\\)/.test(filtered);
  return { text: inverted ? 1 - text.l : text.l, behind: inverted ? 1 - behind : behind };
}"""


@pytest.mark.parametrize("simulate", ["1", "0"])
def test_an_unstyled_article_reads_in_dark_mode(served, simulate):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            color_scheme="dark", viewport={"width": 1280, "height": 900}
        )
        ctx.add_init_script(
            "try { localStorage.setItem('zimi_app_theme', 'dark');"
            " localStorage.setItem('zimi_darken_articles', '"
            + simulate
            + "'); } catch (e) {}"
        )
        pg = ctx.new_page()
        pg.goto(served + "/w/wiki/A/Sol")
        pg.wait_for_function(
            "() => { var f = document.getElementById('reader-frame');"
            " return f && f.contentDocument && f.contentDocument.querySelector('p'); }",
            timeout=30000,
        )
        pg.wait_for_timeout(600)
        got = pg.evaluate(_MEASURE)
        br.close()
    assert (
        abs(got["text"] - got["behind"]) >= _MIN_LUM_GAP
    ), "unreadable: text %.2f on %.2f" % (got["text"], got["behind"])
    assert got["behind"] < 0.5, (
        "dark mode, but the page paints light (%.2f)" % got["behind"]
    )
