"""The catalog build of the Almanac (zimi_mul_almanac), read the way Kiwix serves it, opens in the browser's language.

The ZIM is built with scripts/build_almanac_kiwix.py and served from /content/<name>/ by the kiwix-serve stand-in
(tests/kiwix_stub.py): no Zimi server, no ``#lang`` in the address, nothing but the browser's own languages to go on.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_almanac_catalog_zim_lang_browser.py -v
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
pytest.importorskip("libzim")
from test_games_persist_browser import browser  # noqa: E402,F401

pytestmark = pytest.mark.browser

#: locale -> (html lang, dir, a word of that language that is on the page, the English word that must not be)
CASES = [
    ("fr-FR", "fr", "", "Ma position", "My location"),
    ("fr-CA", "fr", "", "Ma position", "My location"),
    ("de-DE", "de", "", "Mein Standort", "My location"),
    ("he-IL", "he", "rtl", "המיקום שלי", "My location"),
    ("sv-SE", "en", "", "My location", "Ma position"),
]


@pytest.fixture(scope="module")
def book(tmp_path_factory):
    import build_almanac_kiwix
    from kiwix_stub import serve

    zims = tmp_path_factory.mktemp("catalog")
    build_almanac_kiwix.build(str(zims))
    srv, base = serve(str(zims), str(zims))
    yield "%s/content/%s/index.html" % (base, build_almanac_kiwix.DEFAULT_NAME)
    srv.shutdown()


@pytest.mark.parametrize("locale,lang,direction,own,english", CASES)
def test_the_catalog_almanac_follows_the_browsers_language(browser, book, locale, lang, direction, own, english):
    ctx = browser.new_context(locale=locale, service_workers="block")
    try:
        page = ctx.new_page()
        page.goto(book)
        page.wait_for_function(
            "() => document.body.innerText.length > 200 && !document.getElementById('alm-veil')", timeout=120000
        )
        s = page.evaluate(
            "() => ({lang: document.documentElement.lang, dir: document.documentElement.dir || '', text: document.body.innerText})"
        )
    finally:
        ctx.close()
    assert s["lang"] == lang
    assert s["dir"] == direction
    assert own in s["text"]
    if english != own:
        assert english not in s["text"]
