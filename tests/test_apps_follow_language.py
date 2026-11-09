"""An app that is open when the language changes is drawn again in the new language (Settings > Languages used to
leave ZimiTube, Exchange and the rest in the language they were opened in until they were closed and opened again).
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402

I18N = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "i18n",
)
FRAME_HASH = """() => { const w = document.getElementById('reader-frame').contentWindow;
  try { const h = JSON.parse(decodeURIComponent(w.location.hash.slice(1))); return { lang: h.lang, title: h.title, dir: h.dir, docLang: w.document.documentElement.lang, docDir: w.document.documentElement.dir, text: w.document.body.innerText }; } catch (e) { return null; } }"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_fixture_zim

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("follow")
    zdir = tmp / "zims"
    zdir.mkdir()
    build_fixture_zim(
        str(zdir / "ted_en_all_2026-01.zim"),
        {"Scraper": "ted2zim 3.0.2", "Name": "ted_en_all", "Title": "All TED videos"},
    )
    mp = pytest.MonkeyPatch()
    mp.setenv("ZIMI_APPS", ",".join(srv.APP_NAMES))
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def _i18n(lang):
    with open(os.path.join(I18N, lang + ".json"), encoding="utf-8") as f:
        return json.load(f)


@pytest.mark.parametrize("lang", ["es", "ar"])
def test_an_open_app_takes_the_new_language(served, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            service_workers="block",
        ).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(served + "/", wait_until="load")
            pg.wait_for_function(
                "() => typeof openTube === 'function' && typeof setLanguage === 'function'",
                timeout=60000,
            )
            pg.evaluate("openTube()")
            pg.wait_for_function("(" + FRAME_HASH + ")()", timeout=30000)
            before = pg.evaluate("(" + FRAME_HASH + ")()")
            assert before["lang"] == "en" and before["docLang"] == "en", before
            pg.evaluate("(l) => setLanguage(l)", lang)
            pg.wait_for_function(
                "(l) => { const f = ("
                + FRAME_HASH
                + ")(); return f && f.lang === l && f.docLang === l; }",
                arg=lang,
                timeout=30000,
            )
            after = pg.evaluate("(" + FRAME_HASH + ")()")
            assert after["title"] == _i18n(lang)["tube"], after
            assert after["docDir"] == (
                "rtl" if lang == "ar" else after["docDir"]
            ), after
            # The page was drawn again: its own text is not the English it had.
            pg.wait_for_function(
                "(t) => (" + FRAME_HASH + ")().text !== t",
                arg=before["text"],
                timeout=30000,
            )
            assert not errors, errors
        finally:
            br.close()
