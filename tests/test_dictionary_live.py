"""Dictionary in a real browser, on a phone's width.

A word opens across the Wiktionaries, the reader's language first; it can
be heard (a recording where the ZIM has one, else this device's voice for
the word's language, and a plain word where the device has none, never
another language's voice); a translation is a tap to that word, with the
trail of how you got there and Zimi's arrow walking it back; Save keeps
the word, and the front lists it with the words you looked at.

The device's voices are a Mac's, given to the page (headless Chromium has
none): English and French, no Maltese; its reader reads English and French.

Run: pytest tests/test_dictionary_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dictionary_fixture as fx  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import dictionary as dic  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS", "")
VOICES = """(() => {
  const vs = [{name:'Bubbles', lang:'en-US', localService:true}, {name:'Samantha', lang:'en-US', localService:true, default:true},
    {name:'Daniel', lang:'en-GB', localService:true}, {name:'Thomas', lang:'fr-FR', localService:true}];
  window.__said = [];
  const s = { getVoices: () => vs, cancel: () => {}, addEventListener: () => {},
    speak: u => { window.__said.push([u.text, u.voice && u.voice.name, u.lang]); setTimeout(() => u.onend && u.onend(), 20); } };
  Object.defineProperty(window, 'speechSynthesis', { value: s, configurable: true });
  window.SpeechSynthesisUtterance = function(t) { this.text = t; };
  // A reader of English and French.
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'fr-FR'] });
})();"""
FRAME = "f => f.url.indexOf('dictionary.html') >= 0"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("dict")
    zdir = tmp / "zims"
    zdir.mkdir()
    fx.build_library(str(zdir))
    mp = pytest.MonkeyPatch()
    mp.delenv("ZIMI_APPS", raising=False)
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    dic._reset_for_tests()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def _frame(pg):
    for _ in range(100):
        f = next((f for f in pg.frames if "dictionary.html" in f.url), None)
        if f:
            return f
        pg.wait_for_timeout(100)
    raise AssertionError("the Dictionary page never opened")


STATE = """() => ({ h1: (document.querySelector('.hw h1') || {}).textContent || null,
  loading: !!document.querySelector('.sk'), page: location.href.split('#')[0], shell: parent.location.href })"""


def _word(f, w):
    """The word on the page, drawn: first its heading (the page took the
    step), then its entries (the lookup answered). A timeout says which of
    the two never came, and what the page showed instead."""
    for cond, what in (
        ("w => { const h = document.querySelector('.hw h1'); return h && h.textContent === w; }", "the page never went to it"),
        (
            "w => { const h = document.querySelector('.hw h1'); return h && h.textContent === w && !document.querySelector('.sk'); }",
            "the lookup never answered",
        ),
    ):
        try:
            f.wait_for_function(cond, arg=w, timeout=20000)
        except Exception as e:
            raise AssertionError("%r: %s; the page: %r" % (w, what, f.evaluate(STATE))) from e


def _still(pg):
    """Until the reader's frame holds its place for a few looks. Scrolling
    the page slides Zimi's header away (or back), and the whole frame with
    it, over 0.2s; a click in that slide pressed a link and let go over the
    line above it, so nothing opened (a slow runner, 2026-10-02)."""
    pg.evaluate("() => { window.__still = null; }")
    pg.wait_for_function(
        "() => { const v = document.getElementById('reader-frame').getBoundingClientRect();"
        " const w = window.__still || (window.__still = { y: null, n: 0 });"
        " w.n = v.top === w.y ? w.n + 1 : 0; w.y = v.top; return w.n >= 3; }",
        polling=150,
        timeout=10000,
    )


def _tap(f, sel):
    """Tap as a reader does: brought into view, then tapped once still."""
    f.eval_on_selector(sel, "e => e.scrollIntoView({ block: 'center' })")
    _still(f.page)
    f.click(sel)


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, "dictionary-" + name + ".png"))


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_a_word_heard_followed_and_kept_at_390px(served, scheme):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            color_scheme=scheme,
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(served + "/?dictionary=water")
            f = _frame(pg)
            _word(f, "water")
            _shot(pg, "water-" + scheme)
            got = f.evaluate(
                """() => ({
              first: document.querySelector('.lang .lang-h h2').textContent,
              langs: Array.from(document.querySelectorAll('.lang')).map(s => s.tagName + ':' + s.querySelector('h2').textContent),
              audio: Array.from(document.querySelectorAll('[data-audio]')).map(b => b.getAttribute('data-audio')),
              wide: document.documentElement.scrollWidth - document.documentElement.clientWidth })"""
            )
            # English first (Zimi's language), then French, both the reader's.
            assert got["first"] == "English"
            assert got["langs"] == ["SECTION:English", "SECTION:French"]
            # Simple English's US recording is in its ZIM: the word is heard from it.
            assert got["audio"] == ["/w/wiktionary_en_simple/-/En-us-water.ogg"]
            assert got["wide"] <= 0
            # A translation is a tap away: French "eau".
            _tap(f, "a[data-w='eau#French']")
            _word(f, "eau")
            pg.wait_for_url("**/?dictionary=eau", timeout=5000)
            trail = f.evaluate(
                "() => Array.from(document.querySelectorAll('#trail button, #trail .now')).map(e => e.textContent)"
            )
            assert trail == ["water", "eau"]
            # Landed on the French word, open; it is said by the French voice.
            fr = f.evaluate(
                "() => { const i = Array.from(document.querySelectorAll('.lang')).findIndex(s => s.querySelector('h2').textContent === 'French'); const s = document.querySelectorAll('.lang')[i]; return { open: s.tagName === 'SECTION' || s.open, say: !!s.querySelector('[data-say]:not([hidden])') }; }"
            )
            assert fr == {"open": True, "say": True}
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__said.length > 0")
            said = f.evaluate("() => window.__said")
            assert said[-1] == ["eau", "Thomas", "fr-FR"]
            _shot(pg, "eau-" + scheme)
            # Zimi's arrow walks the trail back (its header back in view at the top).
            f.evaluate("() => window.scrollTo(0, 0)")
            pg.wait_for_function("() => !document.body.classList.contains('chrome-away')")
            _still(pg)
            pg.click("#back-btn")
            _word(f, "water")
            assert f.evaluate("() => document.getElementById('trail').hidden")
            # Save keeps the word as a word of Dictionary.
            _tap(f, ".svbar [data-sv='save']")
            kept = pg.evaluate(
                "() => Saved.itemsFor({ app: 'dictionary' }).map(x => [x.kind, x.title])"
            )
            assert kept == [["word", "water"]]
            # The front: the words looked at, and the one kept.
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".cloud a[data-w='water']", timeout=20000)
            heads = f.evaluate(
                "() => Array.from(document.querySelectorAll('.shelf-h h2')).map(h => h.textContent)"
            )
            assert heads[:2] == ["Recent", "Saved"] and "Your dictionaries" in heads
            recent = f.evaluate(
                "() => Array.from(document.querySelectorAll('.shelf')[0].querySelectorAll('a')).map(a => a.textContent)"
            )
            assert set(recent) == {"water", "eau"}
            _shot(pg, "home-" + scheme)
            assert not errors, errors
        finally:
            br.close()


def test_a_language_the_device_cannot_speak_says_so(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        pg = ctx.new_page()
        try:
            pg.goto(served + "/?dictionary=ilma")
            f = _frame(pg)
            _word(f, "ilma")
            pg.wait_for_timeout(1500)
            got = f.evaluate(
                """() => ({ say: Array.from(document.querySelectorAll('[data-say]')).filter(b => !b.hidden).length,
              note: (document.querySelector('[data-novoice]:not([hidden])') || {}).textContent || '',
              ipa: (document.querySelector('.ipa') || {}).textContent })"""
            )
            # No Maltese voice: no button that would read it in English, and a line that says why.
            assert got == {
                "say": 0,
                "note": "No Maltese voice on this device",
                "ipa": "/ˈɪl.ma/",
            }
            _shot(pg, "ilma")
        finally:
            br.close()


def test_typing_suggests_and_enter_opens(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(
            viewport={"width": 1280, "height": 900}, locale="en-US"
        ).new_page()
        try:
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".dicts", timeout=20000)
            pg.fill("#q", "ea")
            f.wait_for_selector(".sug a[data-w='eau']", timeout=10000)
            pg.fill("#q", "eau")
            pg.press("#q", "Enter")
            _word(f, "eau")
            pg.wait_for_url("**/?dictionary=eau", timeout=5000)
            # Nobody has it: said, with the words that are near.
            pg.fill("#q", "watr")
            pg.press("#q", "Enter")
            f.wait_for_selector(".empty", timeout=10000)
            assert "No dictionary here has" in f.inner_text(".empty")
        finally:
            br.close()
