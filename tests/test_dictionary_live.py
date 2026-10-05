"""Dictionary in a real browser, on a phone's width.

A word opens across the Wiktionaries, the reader's language first; it can
be heard (a recording where the ZIM has one, else this device's voice for
the word's language, and a plain word where the device has none, never
another language's voice); a translation is a tap to that word, with the
trail of how you got there and Zimi's arrow walking it back; Save keeps
the word, and the front lists it with the words you looked at.

The device's voices are a Mac's, given to the page (headless Chromium has
none): English and French, no Maltese; its reader reads English and French.
The server says nothing (no Piper, say or espeak-ng) except in the test of
the server's voice, where a fake Piper on PATH writes a known WAV.

Run: pytest tests/test_dictionary_live.py -v
"""

import os
import sys
import threading
import time
import urllib.parse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dictionary_fixture as fx  # noqa: E402
import test_voices as tv  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import dictionary as dic  # noqa: E402
from zimi import voices  # noqa: E402

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
    # The server says nothing: the device's voices are the ones under test.
    mp.setenv(voices.PIPER_CMD_ENV, str(tmp / "no-piper"))
    mp.setattr(voices, "_say_voices", lambda: {})
    mp.setattr(voices, "_espeak_voices", lambda: {})
    for name in ("ZIMI_OFFLINE", voices.DOWNLOADS_ENV):
        mp.delenv(name, raising=False)
    voices._reset_for_tests()
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
        (
            "w => { const h = document.querySelector('.hw h1'); return h && h.textContent === w; }",
            "the page never went to it",
        ),
        (
            "w => { const h = document.querySelector('.hw h1'); return h && h.textContent === w && !document.querySelector('.sk'); }",
            "the lookup never answered",
        ),
    ):
        try:
            f.wait_for_function(cond, arg=w, timeout=20000)
        except Exception as e:
            raise AssertionError(
                "%r: %s; the page: %r" % (w, what, f.evaluate(STATE))
            ) from e


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
            pg.wait_for_function(
                "() => !document.body.classList.contains('chrome-away')"
            )
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
            # The word of the day is said where it stands, beside its link.
            assert f.evaluate(
                "() => { const b = document.querySelector('.wotd-box > .wotd-say [data-say]'); return !!b && !b.closest('a'); }"
            )
            heads = f.evaluate(
                "() => Array.from(document.querySelectorAll('.shelf-h h2')).map(h => h.textContent)"
            )
            assert heads[:3] == ["More words", "Recent", "Saved"]
            assert "Your dictionaries" in heads
            recent = f.evaluate(
                "() => Array.from(document.querySelectorAll('.shelf:not(.more-words)')[0].querySelectorAll('a')).map(a => a.textContent)"
            )
            assert set(recent) == {"water", "eau"}
            _shot(pg, "home-" + scheme)
            assert not errors, errors
        finally:
            br.close()


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_the_front_offers_more_words_than_one_at_390px(served, scheme):
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
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".more-words .cloud a", timeout=20000)
            got = f.evaluate(
                """() => ({ day: (document.querySelector('.wotd .w') || {}).textContent || '',
              more: Array.from(document.querySelectorAll('.more-words .cloud a')).map(a => [a.getAttribute('data-w'), (a.querySelector('.ml') || {}).textContent || '']),
              wide: document.documentElement.scrollWidth - document.documentElement.clientWidth })"""
            )
            # The word of the day, and at least six more besides it.
            assert got["day"] and len(got["more"]) >= 6, got
            assert got["day"] not in [w for w, _ in got["more"]]
            # A French word says it is French; Zimi speaks English.
            assert "French" in [lang for _, lang in got["more"]]
            assert got["wide"] <= 0
            pg.wait_for_function(
                "() => getComputedStyle(document.getElementById('reader-loading')).opacity === '0' || document.getElementById('reader-loading').offsetParent === null"
            )
            _shot(pg, "front-more-" + scheme)
            # Shuffle brings another handful, still words that open.
            f.click(".more-words .shelf-h .all")
            f.wait_for_function(
                "() => { const b = document.querySelector('.more-words .shelf-h .all'); return b && !b.disabled; }"
            )
            first = f.evaluate(
                "() => document.querySelector('.more-words .cloud a').getAttribute('data-w')"
            )
            _tap(f, ".more-words .cloud a")
            _word(f, first)
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


def test_zimis_language_opens_the_translation_and_back_returns(served):
    """Eric, 2026-10-01: switching Zimi's language with a word open opens its
    translation. 2026-10-02: freeze to Spanish "worked for freeze but not
    going back". Zimi's arrow returns to the word the switch started from."""
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
            pg.goto(served + "/?dictionary=water")
            _word(_frame(pg), "water")
            pg.evaluate("() => setLanguage('fr')")
            pg.wait_for_url("**/?dictionary=eau", timeout=10000)
            _word(_frame(pg), "eau")
            pg.wait_for_function(
                "() => !document.body.classList.contains('chrome-away')"
            )
            _still(pg)
            pg.click("#back-btn")
            pg.wait_for_url("**/?dictionary=water", timeout=10000)
            _word(_frame(pg), "water")
        finally:
            br.close()


# Every <audio> the page starts, and what it was asked to play.
PLAYED = """(() => {
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() { window.__played.push(this.src); return play.call(this); };
})();"""
OFFER = "() => { const o = document.querySelector('[data-offer=\\'fr\\']:not([hidden])'); return o ? o.textContent : ''; }"


def test_say_is_the_servers_audio_and_the_download_line_follows_the_setting(
    served, tmp_path, monkeypatch
):
    """Eric's phone on silent: Say plays the server's WAV through <audio>,
    never speechSynthesis, when the server can say the language. Without a
    clearer voice for it the device speaks, and an admin is offered one,
    unless the setting is Never or Zimi is offline."""
    from playwright.sync_api import sync_playwright

    monkeypatch.delenv(voices.PIPER_CMD_ENV, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    tv.fake_piper(tmp_path)
    voices._reset_for_tests()
    assert voices.piper_command() == [
        str(tmp_path / "piper")
    ], "the fake Piper, found on PATH"

    def fetched(tag):
        tv.install(tag)
        with voices._lock:
            voices._download.clear()

    monkeypatch.setattr(voices, "_fetch_voice", fetched)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        ctx.add_init_script(PLAYED)
        pg = ctx.new_page()
        answers = []
        pg.on(
            "response",
            lambda r: "/dictionary/speak" in r.url
            and answers.append((r.status, r.headers.get("content-type"))),
        )
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        def open_eau():
            pg.goto(served + "/?dictionary=eau")
            f = _frame(pg)
            _word(f, "eau")
            f.wait_for_function(
                "() => document.querySelector('[data-say][data-code=\"fr\"]:not([hidden])')"
            )
            pg.wait_for_timeout(300)
            return f

        try:
            # No French voice on the server: the device says it, and an
            # admin (this machine, no password) is offered a clearer one.
            f = open_eau()
            f.wait_for_function("() => (%s)() !== ''" % OFFER)
            assert f.evaluate(OFFER) == "Clearer voice for French: Download (63 MB)"
            _shot(pg, "voice-offer")
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__said.length > 0")
            assert f.evaluate("() => window.__played") == []
            # Never, and offline: no line.
            voices.POLICY.set("never")
            f = open_eau()
            assert f.evaluate(OFFER) == ""
            voices.POLICY.set("ask")
            monkeypatch.setenv("ZIMI_OFFLINE", "1")
            f = open_eau()
            assert f.evaluate(OFFER) == ""
            monkeypatch.delenv("ZIMI_OFFLINE")
            # The tap downloads it; then Say is the server's audio.
            f = open_eau()
            f.wait_for_function("() => (%s)() !== ''" % OFFER)
            _tap(f, "[data-get='fr']")
            f.wait_for_function("() => (%s)() === ''" % OFFER, timeout=10000)
            assert "fr" in voices.installed()
            _shot(pg, "voice-installed")
            pg.reload()
            f = open_eau()
            f.evaluate("() => { window.__said = []; }")
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__played.length > 0")
            played = f.evaluate("() => window.__played")
            assert "/dictionary/speak?text=eau&lang=fr&v=" in played[-1], played
            pg.wait_for_timeout(500)
            assert (
                f.evaluate("() => window.__said") == []
            ), "speechSynthesis is not called"
            # Chromium asks for it by range, as Safari does.
            assert answers and answers[-1] in (
                (200, "audio/wav"),
                (206, "audio/wav"),
            ), answers
            # Removed: the device says it again, at once.
            assert voices.remove("fr")
            f = open_eau()
            f.evaluate("() => { window.__played = []; }")
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__said.length > 0")
            assert f.evaluate("() => window.__played") == []
            assert not errors, errors
        finally:
            br.close()
            voices.remove("fr")
            voices.POLICY.set("ask")
            voices._reset_for_tests()


SAY_FR = "[data-say][data-code='fr']:not([hidden])"
SAY_EN = "[data-say][data-code='en']:not([hidden])"
LINE_FR = "() => { const o = document.querySelector('[data-offer=\\'fr\\']'); return o && !o.hidden ? o.textContent : ''; }"


@pytest.fixture
def piper_here(served, tmp_path, monkeypatch):
    """A fake Piper on PATH, and a phone to open eau on."""
    from playwright.sync_api import sync_playwright

    monkeypatch.delenv(voices.PIPER_CMD_ENV, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    tv.fake_piper(tmp_path)
    voices._reset_for_tests()
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        ctx.add_init_script(PLAYED)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        def open_eau():
            pg.goto(served + "/?dictionary=eau")
            f = _frame(pg)
            _word(f, "eau")
            f.wait_for_function("s => document.querySelector(s)", arg=SAY_FR)
            pg.wait_for_timeout(300)
            return f

        try:
            yield open_eau, errors
        finally:
            br.close()
            for tag in list(voices.installed()):
                voices.remove(tag)
            voices.POLICY.set("ask")
            voices._reset_for_tests()


def test_say_shows_it_is_working_never_stacks_and_recovers(piper_here, monkeypatch):
    """A server voice's first word takes seconds (Kokoro, about five): the
    button says so from the tap, more taps add nothing, and audio that
    fails hands the word to the device, whose voice the next tap uses at
    once (inside the tap, where iOS lets speech start)."""
    open_eau, errors = piper_here
    tv.install("fr")
    tv.install("en-US")
    real = voices.speak

    def slow(*a, **k):
        time.sleep(1.5)
        return real(*a, **k)

    monkeypatch.setattr(voices, "speak", slow)
    f = open_eau()
    f.eval_on_selector(SAY_FR, "b => { b.click(); b.click(); b.click(); }")
    assert (
        f.eval_on_selector(
            SAY_FR, "b => b.classList.contains('busy') && b.getAttribute('aria-busy')"
        )
        == "true"
    )
    f.wait_for_function(
        "s => !document.querySelector(s).classList.contains('busy')",
        arg=SAY_FR,
        timeout=10000,
    )
    f.wait_for_function(
        "s => !document.querySelector(s).classList.contains('on')",
        arg=SAY_FR,
        timeout=10000,
    )
    assert len(f.evaluate("() => window.__played")) == 1, "three taps, one word"
    assert f.evaluate("() => window.__said") == []
    # Audio that is not audio (English, not yet heard, so not in the
    # browser's cache): the server says it made it, the device says it, and
    # the button is idle.
    monkeypatch.setattr(voices, "speak", lambda *a, **k: b"RIFF not a wave")
    monkeypatch.setattr(voices, "said", lambda *a, **k: {"made": True, "failed": False})
    f.evaluate("() => { window.__played = []; }")
    f.eval_on_selector(SAY_EN, "b => b.click()")
    f.wait_for_function("() => window.__said.length === 1", timeout=10000)
    assert f.evaluate("() => window.__said[0][1]") == "Samantha"
    f.wait_for_function(
        "s => document.querySelector(s).className === 'spk'", arg=SAY_EN
    )
    f.eval_on_selector(SAY_EN, "b => b.click()")
    f.wait_for_function("() => window.__said.length === 2")
    assert (
        len(f.evaluate("() => window.__played")) == 1
    ), "the next tap went straight to the device"
    assert not errors, errors


def test_the_download_line_moves_cancels_fails_and_goes(piper_here, monkeypatch):
    """The line under the word: a bar that moves while the voice comes,
    Cancel, a failure said plainly with Retry, and gone when it is here,
    Say then the server's without a reload. A page opened mid-download
    picks the progress up. A viewer who is not an admin sees no line."""
    from zimi import users

    open_eau, errors = piper_here
    steps = {"fail": False}

    def fetch(tag):
        with voices._lock:
            total = voices._download["total"]
        for i in range(1, 9):
            time.sleep(0.5)
            with voices._lock:
                if voices._download.get("cancel"):
                    voices._download.clear()
                    return
                voices._download["done"] = total * i // 10
        with voices._lock:
            voices._download.clear()
            if steps["fail"]:
                voices._download.update({"tag": None, "error": tag})
                return
        tv.install(tag)

    monkeypatch.setattr(voices, "_fetch_voice", fetch)
    f = open_eau()
    f.wait_for_function("() => (%s)() !== ''" % LINE_FR)
    # Cancel: back to the offer.
    f.eval_on_selector("[data-get='fr']", "b => b.click()")
    assert f.evaluate(LINE_FR).startswith("Downloading the voice for French")
    f.wait_for_function("() => /[1-9][0-9]*%%/.test((%s)())" % LINE_FR, timeout=5000)
    f.eval_on_selector("[data-offer='fr'] [data-cancel]", "b => b.click()")
    f.wait_for_function(
        "() => (%s)() === 'Clearer voice for French: Download (63 MB)'" % LINE_FR,
        timeout=5000,
    )
    # A failure: said, with Retry.
    steps["fail"] = True
    f.wait_for_function(
        "() => !document.querySelector('[data-offer=fr] [data-cancel]')"
    )
    f.eval_on_selector("[data-get='fr']", "b => b.click()")
    f.wait_for_function(
        '() => (%s)() === "Couldn\'t download the voice Retry"' % LINE_FR, timeout=10000
    )
    # Retry, and leave mid-way: the page opened again picks it up, moving.
    steps["fail"] = False
    f.eval_on_selector("[data-offer='fr'] [data-get='fr']", "b => b.click()")
    f.wait_for_function("() => /Cancel$/.test((%s)())" % LINE_FR, timeout=5000)
    f = open_eau()
    seen = f.evaluate(LINE_FR)
    assert seen.startswith("Downloading"), seen
    f.wait_for_function(
        "s => { const l = (%s)(); return l !== s && l !== ''; }" % LINE_FR,
        arg=seen,
        timeout=5000,
    )
    # Done: the line goes, and Say is the server's.
    f.wait_for_function("() => (%s)() === ''" % LINE_FR, timeout=10000)
    assert "fr" in voices.installed()
    f.eval_on_selector(SAY_FR, "b => b.click()")
    f.wait_for_function("() => window.__played.length > 0")
    assert f.evaluate("() => window.__said") == []
    # Not an admin: no line, and the device still says it.
    voices.remove("fr")
    monkeypatch.setattr(users, "_request_is_admin", lambda h: False)
    f = open_eau()
    assert f.evaluate(LINE_FR) == ""
    assert not errors, errors


CARET_FR = "[data-voices='fr']"
MENU_FR = "() => [...document.querySelectorAll(\"[data-voices='fr'] + .menu .menu-item\")].map(i => [i.querySelector('.vname').textContent, i.hasAttribute('data-default'), i.getAttribute('data-engine')])"


def test_say_has_a_menu_of_every_voice_that_can_say_the_word(piper_here, monkeypatch):
    """Eric, 2026-10-03: "A lil dropdown on the say button". Say plays the
    default voice; its caret opens a menu of every voice that can say the
    word, the default ticked, each a one-off listen by its own engine. One
    voice: no caret. Arrows, Escape (focus back on the caret) and a tap
    outside work as the shell's menus do."""
    open_eau, errors = piper_here
    f = open_eau()
    assert f.eval_on_selector(CARET_FR, "c => c.hidden"), "the device alone: no caret"
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    f = open_eau()
    f.wait_for_function("s => !document.querySelector(s).hidden", arg=CARET_FR)
    caret = f.eval_on_selector(
        CARET_FR,
        "c => [c.getAttribute('aria-haspopup'), c.getAttribute('aria-expanded')]",
    )
    assert caret == ["menu", "false"]
    _shot(f.page, "say-menu-closed-light")
    _tap(f, CARET_FR)
    assert f.evaluate(MENU_FR) == [
        ["Clear", True, "piper"],
        ["Basic", False, "espeak"],
        ["Device", False, "device"],
        ["Voices…", False, None],
    ]
    assert not f.query_selector(".menu-check"), "no tick: 'default' says it"
    assert f.eval_on_selector("[data-default] .vdef", "e => e.textContent") == "default"
    assert (
        f.eval_on_selector(CARET_FR + " + .menu", "m => m.getAttribute('role')")
        == "menu"
    )
    heights = f.eval_on_selector_all(
        ".menu-item", "is => is.map(i => i.getBoundingClientRect().height)"
    )
    assert min(heights) >= 44, heights
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "piper"
    ), "the ticked voice has focus"
    assert f.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shot(f.page, "say-menu-open-light")
    f.page.emulate_media(color_scheme="dark")
    _shot(f.page, "say-menu-open-dark")
    f.page.emulate_media(color_scheme="light")
    # A voice playing: the item pulses as Say does.
    f.evaluate(
        "() => { HTMLMediaElement.prototype.play = function() { window.__played.push(this.src); return new Promise(() => {}); }; }"
    )
    f.click(".menu-item[data-engine='piper']")
    f.wait_for_selector(".menu-item.busy[data-engine='piper']")
    _shot(f.page, "say-menu-playing-light")
    f.page.emulate_media(color_scheme="dark")
    _shot(f.page, "say-menu-playing-dark")
    f.page.emulate_media(color_scheme="light")
    # A voice from the menu: its own engine's audio, the menu still open
    # (the next voice is a tap away) and the item, not Say, at work.
    f.click(".menu-item[data-engine='espeak']")
    f.wait_for_function("() => window.__played.length > 0")
    assert "&engine=espeak&" in f.evaluate("() => window.__played")[-1]
    assert (
        f.eval_on_selector(CARET_FR, "c => c.getAttribute('aria-expanded')") == "true"
    )
    f.click(".hw h1")
    # No espeak-ng here after all: the server says 404, and Basic leaves the
    # menu rather than another voice answering under its name.
    f.wait_for_function("() => !document.querySelector('.spk.busy')")
    _tap(f, CARET_FR)
    assert [e for _t, _c, e in f.evaluate(MENU_FR)] == ["piper", "device", None]
    # The device's own voice.
    f.evaluate("() => { window.__said = []; }")
    f.click(".menu-item[data-engine='device']")
    f.wait_for_function("() => window.__said.length > 0")
    assert f.evaluate("() => window.__said")[0][1] == "Thomas"
    # The last pick is Say's from now on (Settings > Voices remembers it).
    f.click(".hw h1")
    f.evaluate("() => { window.__said = []; }")
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__said.length > 0")
    # With no preference, Say plays the default, with no engine named.
    f.evaluate(
        "() => { localStorage.removeItem('zimi_voice_prefs'); window.__played = []; }"
    )
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__played.length > 0")
    assert "engine=" not in f.evaluate("() => window.__played")[-1]
    # Keys: Down opens on the ticked voice, Down moves, Escape closes and
    # gives focus back to the caret.
    f.focus(CARET_FR)
    f.page.keyboard.press("ArrowDown")
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "piper"
    )
    f.page.keyboard.press("ArrowDown")
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "device"
    )
    f.page.keyboard.press("ArrowDown")
    assert f.evaluate("() => document.activeElement.hasAttribute('data-sheet')")
    f.page.keyboard.press("ArrowDown")
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "piper"
    ), "round again"
    f.page.keyboard.press("Escape")
    assert f.evaluate("() => document.activeElement.matches(\"[data-voices='fr']\")")
    assert f.eval_on_selector(CARET_FR + " + .menu", "m => m.hidden")
    # A tap outside closes it.
    _tap(f, CARET_FR)
    f.click(".hw h1")
    assert f.eval_on_selector(CARET_FR + " + .menu", "m => m.hidden")
    # Right to left, the menu hangs from Say's other edge.
    f.evaluate("() => { document.documentElement.dir = 'rtl'; }")
    _tap(f, CARET_FR)
    edges = f.eval_on_selector(
        CARET_FR + " + .menu",
        "m => [m.getBoundingClientRect().right, m.parentNode.getBoundingClientRect().right]",
    )
    assert abs(edges[0] - edges[1]) < 1, edges
    f.click(".hw h1")
    f.evaluate("() => { document.documentElement.dir = 'ltr'; }")
    f.page.emulate_media(color_scheme="dark")
    _shot(f.page, "say-menu-closed-dark")
    assert not errors, errors


IDLE = "() => !document.querySelector('.spk.busy, .spk.on, .menu-item.busy, .menu-item.on')"


def test_a_busy_voice_stays_and_a_missing_one_goes(piper_here, monkeypatch):
    """Eric, 2026-10-03: "piper disappeared while i was using it on
    homophone". A voice the server is too busy for (503) stays in the menu,
    Say is idle again, nothing else answers under its name, and the next
    tap asks the server again. Only a voice the server cannot say the word
    in at all (404) leaves the menu."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})

    def busy(*a, **k):
        raise voices.Busy("queue full")

    monkeypatch.setattr(voices, "speak", busy)
    f = open_eau()
    f.wait_for_function("s => !document.querySelector(s).hidden", arg=CARET_FR)
    _tap(f, CARET_FR)
    for engine in ("piper", "piper", "espeak"):
        f.click(".menu-item[data-engine='%s']" % engine)
        f.wait_for_function(IDLE)
        f.wait_for_timeout(300)  # the page's question to the server, answered
    f.click(".hw h1")
    _tap(f, SAY_FR)
    f.wait_for_function(IDLE)
    f.wait_for_timeout(300)
    played = f.evaluate("() => window.__played")
    assert len(played) == 4, "every tap asked the server again: %r" % played
    assert f.evaluate("() => window.__said") == [], "no other voice under its name"
    _tap(f, CARET_FR)
    assert [e for _t, _c, e in f.evaluate(MENU_FR)] == [
        "piper",
        "espeak",
        "device",
        None,
    ]
    f.click(".hw h1")
    # The server has no Basic voice for it after all: 404, and Basic goes.
    monkeypatch.setattr(voices, "speak", lambda *a, **k: None)
    monkeypatch.setattr(
        voices,
        "said",
        lambda text, lang, accent="", engine=None, limit=None: (
            None if engine == "espeak" else {"made": False, "failed": False}
        ),
    )
    _tap(f, CARET_FR)
    f.click(".menu-item[data-engine='espeak']")
    f.wait_for_function(IDLE)
    f.wait_for_timeout(300)
    f.click(".hw h1")
    _tap(f, CARET_FR)
    assert [e for _t, _c, e in f.evaluate(MENU_FR)] == ["piper", "device", None]
    f.click(".hw h1")
    assert not errors, errors


def test_the_page_asks_the_server_to_load_its_voices(piper_here, monkeypatch):
    """The Dictionary opening asks the server to load the downloaded voices
    its languages use, once each, so the first tap is not the slow one. A
    language said only by a voice that loads nothing (espeak-ng) is not
    asked for."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"en": {"US": "en-us"}})
    asked = []
    monkeypatch.setattr(voices, "warm", lambda langs: asked.append(list(langs)) or [])
    f = open_eau()
    f.wait_for_timeout(500)
    langs = [lang for call in asked for lang in call]
    assert "fr" in langs and not [x for x in langs if x.startswith("en")], asked
    assert len(langs) == len(set(langs)), "once each: %r" % asked
    assert not errors, errors


SHEET = "#voices-sheet"
DOOR = "#ms-voices-wrap .voice-door"
ROWS = "() => [...document.querySelectorAll('#voices-sheet .voice-lang')].map(r => [r.querySelector('.share-row-title').textContent, !!r.closest('.voice-more')])"


def _sheet_from_settings(pg, served, shot=""):
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_selector(DOOR, timeout=20000)
    pg.eval_on_selector(DOOR, "b => b.scrollIntoView({ block: 'center' })")
    if shot:
        _shot(pg, shot)
    pg.click(DOOR)
    # An admin's sheet ends with the downloads setting, anyone else's with a note.
    pg.wait_for_selector(SHEET + " .voice-foot, " + SHEET + " .ms-hint", timeout=10000)


def _until(fn, what):
    for _ in range(80):
        if fn():
            return
        time.sleep(0.1)
    raise AssertionError(what)


def test_voices_sheet_opens_from_the_front_and_settings_and_shows_the_library_languages(
    piper_here, monkeypatch, served, tmp_path
):
    """Eric, 2026-10-03: the Server settings list was "a monster". The
    voices are a sheet of the Dictionary's own: from the front's speaker,
    from Say's menu (Voices…) and, for an admin, from Settings > Voices
    (Get more voices). Natural voices are
    one card; the library's languages with a voice here (English, French) are rows;
    the rest are folded; a select picks the voice, and the stamp follows."""
    open_eau, errors = piper_here
    runner = tv.fake_piper(tmp_path)
    monkeypatch.setattr(voices, "kokoro_command", lambda: [runner, "kokoro"])
    tv.install("kokoro")
    tv.install("fr")
    f = open_eau()
    pg = f.page
    # Say's menu: Voices… last.
    _tap(f, CARET_FR)
    f.click(".menu-item[data-sheet]")
    pg.wait_for_selector(SHEET + " .voice-foot", timeout=10000)
    pg.click(".voices-panel .zi-close")
    assert not pg.query_selector(SHEET)
    # The front's speaker.
    f.evaluate("() => window.__home()")
    f.wait_for_selector(".vdoor:not([hidden])", timeout=10000)
    box = f.eval_on_selector(
        ".vdoor",
        "b => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }",
    )
    assert box == [44, 44], box
    _shot(pg, "voices-front-admin")
    f.click(".vdoor")
    pg.wait_for_selector(SHEET + " .voice-foot", timeout=10000)
    natural = pg.text_content(SHEET + " .voice-natural")
    assert (
        natural.startswith("Natural voices8 languages") and "Hindi" in natural
    ), natural
    assert "On" in natural and "Apache-2.0" in natural
    # Maltese has no voice on the server at all: no row to choose in.
    assert [r for r in pg.evaluate(ROWS) if not r[1]] == [
        ["English", False],
        ["French", False],
    ]
    rest = [n for n, folded in pg.evaluate(ROWS) if folded]
    assert "Swedish" in rest and "Arabic" not in rest, rest
    assert not pg.eval_on_selector(SHEET + " .voice-more", "d => d.open")
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shot(pg, "voices-sheet-natural-on")
    sel = SHEET + " select[aria-label$='French']"
    assert pg.eval_on_selector(
        sel, "s => [...s.options].map(o => o.value + (o.selected ? '*' : ''))"
    ) == ["kokoro*", "piper", "remove:fr"]
    before = voices.page_payload()["stamp"]
    pg.select_option(sel, "piper")
    _until(lambda: voices.choices() == {"fr": "piper"}, "the choice was never saved")
    assert voices.page_payload()["stamp"] != before
    # The Dictionary heard: its Say's address carries the new stamp.
    f.wait_for_function(
        "s => _server && _server.stamp === s",
        arg=voices.page_payload()["stamp"],
        timeout=5000,
    )
    pg.wait_for_function("s => document.querySelector(s).value === 'piper'", arg=sel)
    pg.mouse.move(1, 400)
    _shot(pg, "voices-sheet-choice")
    pg.keyboard.press("Escape")
    # Settings > Voices: Natural and Clear (Piper), each with its version,
    # and the same sheet from Get more voices (in the dark, which the shell
    # takes from the system as it loads).
    _settings_voices(pg, served)
    rows = pg.evaluate(ENGINES)
    assert [r[0] for r in rows] == ["Natural", "Clear", "Device"], rows
    assert "kokoro-onnx" in rows[0][1] and voices.KOKORO_ID in rows[0][1], rows
    _shots(pg, "voices-natural-piper")
    pg.emulate_media(color_scheme="dark")
    _sheet_from_settings(pg, served, "voices-settings-row-dark")
    pg.mouse.move(1, 400)
    _shot(pg, "voices-sheet-choice-dark")
    pg.emulate_media(color_scheme="light")
    if SHOTS:
        pg.keyboard.press("Escape")
        pg.set_viewport_size({"width": 1280, "height": 800})
        pg.click(DOOR)
        pg.wait_for_selector(SHEET + " .voice-foot")
        pg.eval_on_selector(SHEET + " .voice-more", "d => d.open = true")
        _shot(pg, "voices-sheet-desktop-dark")
        pg.set_viewport_size({"width": 390, "height": 844})
    assert not pg.query_selector("#ms-voices"), "nothing left in Server settings"
    voices.set_choice("fr", None)
    assert not errors, errors


def test_voices_sheet_downloads_piper_from_the_select_cancels_and_removes_in_two_taps(
    piper_here, monkeypatch, served
):
    """Nothing downloaded: French's select ends "Clear (63 MB)…", which
    downloads it; the row gives way to the bar and Cancel. A voice here is
    removed from the same select, with a second tap on Remove?."""
    open_eau, errors = piper_here
    steps = {"go": True}

    def fetch(tag):
        with voices._lock:
            total = voices._download["total"]
        for i in range(1, 60):
            time.sleep(0.25)
            with voices._lock:
                if voices._download.get("cancel"):
                    voices._download.clear()
                    return
                voices._download["done"] = total * i // 60
            if not steps["go"]:
                break
        with voices._lock:
            voices._download.clear()
        tv.install(tag)

    monkeypatch.setattr(voices, "_fetch_voice", fetch)
    f = open_eau()
    pg = f.page
    _settings_voices(pg, served)
    assert [r[0] for r in pg.evaluate(ENGINES)] == ["Device"]
    _shots(pg, "voices-none")
    _sheet_from_settings(pg, served)
    assert not pg.query_selector(
        SHEET + " .voice-natural"
    ), "no Kokoro engine here: no card"
    sel = SHEET + " select[aria-label$='French']"
    assert pg.eval_on_selector(sel, "s => [...s.options].map(o => o.textContent)") == [
        "Device only",
        "Clear (63 MB)…",
    ]
    assert not pg.query_selector(SHEET + " .voice-lang button"), "no per-row buttons"
    _shot(pg, "voices-sheet-empty")
    pg.emulate_media(color_scheme="dark")
    _sheet_from_settings(pg, served)
    _shot(pg, "voices-sheet-empty-dark")
    pg.emulate_media(color_scheme="light")
    _sheet_from_settings(pg, served)
    pg.select_option(sel, "get:fr")
    row = SHEET + " .voice-lang[data-lang='fr']"
    pg.wait_for_selector(row + " .voice-progress", timeout=5000)
    first = pg.text_content(row + " .voice-progress")
    pg.wait_for_function(
        "([s, t]) => document.querySelector(s).textContent !== t",
        arg=[row + " .voice-progress", first],
        timeout=5000,
    )
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shot(pg, "voices-sheet-downloading")
    pg.click(row + " button:has-text('Cancel')")
    pg.wait_for_function(
        "() => !document.querySelector('#voices-sheet .voice-progress')", timeout=5000
    )
    assert voices.downloading() == {} and "fr" not in voices.installed()
    # Again, to the end: Piper says French.
    steps["go"] = False
    pg.select_option(sel, "get:fr")
    _until(lambda: "fr" in voices.installed(), "the voice never came")
    pg.wait_for_function(
        "s => { const e = document.querySelector(s); return e && e.value === 'piper'; }",
        arg=sel,
        timeout=5000,
    )
    # Remove: from the select, then a second tap.
    pg.select_option(sel, "remove:fr")
    rm = row + " button[data-confirm]"
    assert pg.text_content(rm) == "Remove?"
    assert "fr" in voices.installed()
    pg.click(rm)
    _until(lambda: "fr" not in voices.installed(), "the voice was never removed")
    pg.wait_for_selector(sel, timeout=5000)
    assert not errors, errors


def test_voices_never_offers_no_download_and_a_reader_sees_them_all_read_only(
    piper_here, monkeypatch, served
):
    """Never (or ZIMI_OFFLINE): the selects offer no Piper and the setting
    says so. Not an admin (Eric, 2026-10-03: "All users see all available
    only admins can add"): the Dictionary's doors are there and the sheet
    lists the voices, with nothing to download, remove or choose; Settings
    has no Get more voices for them."""
    from zimi import users

    open_eau, errors = piper_here
    voices.POLICY.set("never")
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    f = open_eau()
    pg = f.page
    _sheet_from_settings(pg, served)
    opts = pg.eval_on_selector_all(
        SHEET + " select.voice-select option", "os => os.map(o => o.value)"
    )
    assert not [o for o in opts if o.startswith("get:")], opts
    assert pg.eval_on_selector("#voices-mode", "s => s.value") == "never"
    voices.POLICY.set("ask")
    monkeypatch.setattr(users, "_request_is_admin", lambda h: False)
    f = open_eau()
    _tap(f, CARET_FR)
    assert f.query_selector(".menu-item[data-sheet]")
    f.click(".hw h1")
    f.evaluate("() => window.__home()")
    f.wait_for_selector(".wotd, .hint", timeout=10000)
    assert not f.eval_on_selector(".vdoor", "b => b.hidden")
    _shot(f.page, "voices-front-reader")
    f.click(".vdoor")
    pg.wait_for_selector(SHEET + " .ms-hint", timeout=10000)
    got = pg.evaluate(
        """(sel) => { const s = document.querySelector(sel);
      return { pills: s.querySelectorAll('button.pill').length, mode: !!s.querySelector('#voices-mode'),
        enabled: [...s.querySelectorAll('select.voice-select')].filter(x => !x.disabled).length,
        rows: s.querySelectorAll('.voice-lang').length }; }""",
        SHEET,
    )
    assert (
        got["rows"] and not got["pills"] and not got["mode"] and not got["enabled"]
    ), got
    assert not errors, errors
    # Settings: their own voices, and no Get more voices.
    _settings_voices(pg, served)
    assert not pg.query_selector(DOOR)
    _shots(pg, "voices-reader")


VOICES_WRAP = "#ms-voices-wrap"
# Each engine's row: [name, its languages and version, on, locked on].
ENGINES = "() => [...document.querySelectorAll('#ms-voices-wrap .voice-engine')].map(r => [r.querySelector('.share-row-title').textContent, r.querySelector('.voice-meta').textContent, r.querySelector('input').checked, r.querySelector('input').disabled])"
PREFS = "() => JSON.parse(localStorage.zimi_voice_prefs || '{}')"
HEAR = VOICES_WRAP + " .voice-engine[data-engine='%s'] .voice-hear"


def _settings_voices(pg, served):
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_function("() => window._voicesHere", timeout=20000)
    pg.eval_on_selector(VOICES_WRAP, "e => e.scrollIntoView({ block: 'center' })")


def _shots(pg, name):
    """One look at a state: phone and desktop, light and dark."""
    if not SHOTS:
        return
    size = pg.viewport_size
    for w, h, tag in ((390, 844, "390"), (1280, 860, "desktop")):
        pg.set_viewport_size({"width": w, "height": h})
        for scheme in ("light", "dark"):
            pg.emulate_media(color_scheme=scheme)
            pg.wait_for_timeout(150)
            _shot(pg, "%s-%s-%s" % (name, tag, scheme))
    pg.set_viewport_size(size)
    pg.emulate_media(color_scheme="light")


def _engine(pg, name, force=False):
    pg.click(VOICES_WRAP + " .voice-engine:has-text('%s') .switch" % name, force=force)


LANGS = "#ms-lang-pills"
YOURS = "() => JSON.parse(localStorage.zimi_pref_languages || '[]')"


def test_your_languages_are_chips_that_drive_the_apps_filters(piper_here, served):
    """Eric, 2026-10-03: "Can't I have the whole experience offered in just
    English and Spanish for example? The wording is confusing." Your
    languages are chips in plain sight (no dropdown), saying what they do;
    picked, they lead the library's language pills, filter the catalog,
    reach the apps (the Dictionary orders by them, Zimipedia opens in
    them) and key Discover's day. Language filters is the old switch, named
    for its job."""
    _open_eau, errors = piper_here
    pg = _open_eau().page
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_selector(LANGS)
    pg.eval_on_selector(LANGS, "e => e.scrollIntoView({ block: 'center' })")
    assert not pg.query_selector("#ms-lang-fold, .lang-fold"), "no dropdown"
    hint = pg.text_content(".lang-yours .share-row-desc")
    assert "catalog" in hint and "Dictionary" in hint and "Discover" in hint, hint
    assert pg.text_content("#ms-lang-summary") == "Every language"
    chips = pg.eval_on_selector_all(
        LANGS + " .set-chip[data-lang]", "cs => cs.map(c => c.dataset.lang)"
    )
    assert chips[0] == "en" and "fr" in chips and "es" in chips, chips
    assert pg.is_visible(LANGS + " .set-chip[data-lang='fr']")
    _shots(pg, "languages-chips")
    pg.click(LANGS + " .set-chip[data-lang='es']")
    pg.click(LANGS + " .set-chip[data-lang='fr']")
    assert pg.evaluate(YOURS) == ["es", "fr"]
    assert pg.text_content("#ms-lang-summary") == "Spanish, French"
    assert (
        pg.eval_on_selector(
            LANGS + " .set-chip[data-lang='fr']", "b => b.getAttribute('aria-pressed')"
        )
        == "true"
    )
    # The rest fold behind "N more", and open in place.
    more = pg.query_selector(LANGS + " .set-chip-more")
    if more:
        before = len(pg.query_selector_all(LANGS + " .set-chip[data-lang]"))
        more.click()
        assert len(pg.query_selector_all(LANGS + " .set-chip[data-lang]")) > before
    _shots(pg, "languages-picked")
    got = pg.evaluate(
        """() => ({ catalog: [_zimMatchesLang({language: 'fra'}, null), _zimMatchesLang({language: 'eng'}, null)],
      rank: [_prefLangRank('es'), _prefLangRank('fr'), _prefLangRank('en')],
      apps: JSON.parse(decodeURIComponent(_appStrings('dictionary', []))).yours })"""
    )
    assert got["catalog"] == [True, False], got
    assert got["rank"] == [0, 1, 2], got
    assert got["apps"] == ["es", "fr"], got
    # The Dictionary takes Zimi's language, then yours, not the browser's.
    pg.goto(served + "/?dictionary=eau")
    f = _frame(pg)
    _word(f, "eau")
    assert f.evaluate("() => LANGS") == ["en", "es", "fr"]
    # Discover's day is kept per your languages: choosing again, not stale.
    pg.goto(served + "/")
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=20000,
    )
    day = "Object.keys(localStorage).filter(k => /^zimi_[A-Za-z0-9.-]+_\\d{4}-\\d{2}-\\d{2}$/.test(k))"
    pg.wait_for_function("() => " + day + ".length > 0", timeout=15000)
    keys = pg.evaluate("() => " + day)
    assert all("-es.fr_" in k for k in keys), keys
    # Picked off again: every language.
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_selector(LANGS)
    pg.click(LANGS + " .set-chip[data-lang='es']")
    pg.click(LANGS + " .set-chip[data-lang='fr']")
    assert pg.evaluate("() => localStorage.zimi_pref_languages") is None
    # Language filters: the old switch, named for its job.
    assert (
        pg.text_content("label.set-row:has(#ms-lang-filters) .share-row-title")
        == "Language filters"
    )
    pg.click("label.set-row:has(#ms-lang-filters)")
    assert pg.evaluate("() => localStorage.zimi_hide_lang_chooser") == "1"
    # Zimi's own language stays a tap away (Eric, 2026-10-04: switched to
    # Hebrew from Zimipedia, "then there's no way back").
    pg.evaluate("() => updateTopbar()")
    assert pg.evaluate("() => document.getElementById('lang-selector-btn').style.display") != "none"
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    assert not errors, errors


def test_voices_are_rows_with_names_versions_and_hear(piper_here, monkeypatch, served):
    """Eric, 2026-10-03: "why do all have a nice name except Piper";
    "the playback is shit it takes a long time and has no indicator it's
    working and is one short word". Each engine here is a row with a
    friendly name, its languages and version and a switch. Hear asks the
    server for a sentence of the session's sample words in Zimi's
    language, shows it is working from the tap until the audio plays and
    playing until it ends; Piper with no English says French words."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    pg = open_eau().page
    _settings_voices(pg, served)
    rows = pg.evaluate(ENGINES)
    assert [r[0] for r in rows] == ["Clear", "Basic", "Device"], rows
    assert (
        rows[0][1].startswith("French · Piper") and voices.PIPER_REVISION in rows[0][1]
    ), rows
    assert rows[2][1] == "English, French", rows
    assert "Piper" in pg.text_content(
        VOICES_WRAP + " .voice-engine[data-engine='piper'] .share-row-desc"
    )
    assert not pg.query_selector(
        "#ms-voice-pref, #ms-voice-remember"
    ), "no preferred voice, no remember switch"
    assert pg.query_selector(DOOR), "an admin gets more voices"
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shots(pg, "voices-rows")
    # Hear, held: the audio does not start until the test lets it.
    pg.evaluate(
        """() => { window.__played = []; window.__release = null;
      HTMLMediaElement.prototype.play = function() { var a = this; window.__played.push(a.src);
        return new Promise(r => { window.__release = () => { a.onplaying && a.onplaying(); r(); }; }); }; }"""
    )
    sample = "() => JSON.parse(sessionStorage.zimi_voice_sample || '{}')"
    pg.click(HEAR % "piper")
    pg.wait_for_selector(HEAR % "piper" + ".working")
    pg.wait_for_function("() => window.__release")
    heard = pg.evaluate("() => window.__played")[-1]
    assert (
        "/dictionary/speak?sample=1&text=" in heard
        and "&lang=fr&engine=piper" in heard
    ), heard
    words = pg.evaluate(sample)["fr"]
    assert words and all(w in urllib.parse.unquote(heard) for w in words), (
        words,
        heard,
    )
    _shot(pg, "voices-hear-working")
    pg.evaluate("() => window.__release()")
    pg.wait_for_selector(HEAR % "piper" + ".playing")
    _shot(pg, "voices-hear-playing")
    # A second tap stops it.
    pg.click(HEAR % "piper")
    assert pg.eval_on_selector(
        HEAR % "piper",
        "b => !b.classList.contains('playing') && !b.classList.contains('working')",
    )
    # Zimi's language: the sentence, the same words all session.
    pg.click(HEAR % "device")
    pg.wait_for_function("() => window.__said.length > 0")
    said = pg.evaluate("() => window.__said")[-1]
    en = pg.evaluate(sample)["en"]
    assert said[0].startswith("Some dictionary words are: ") and said[2] == "en", said
    assert all(w in said[0] for w in en), (en, said)
    pg.wait_for_function(
        "s => !document.querySelector(s).classList.contains('working')",
        arg=HEAR % "device",
    )
    pg.click(HEAR % "device")
    pg.wait_for_function("() => window.__said.length > 1")
    assert (
        pg.evaluate("() => window.__said")[-1][0] == said[0]
    ), "the same words all session"
    # The server's cap lets the sentence through, and only with sample=1.
    sentence = "Some dictionary words are: water, river, ocean, island, lighthouse."
    code = pg.evaluate(
        "u => fetch(u).then(r => r.status)",
        "/dictionary/speak?lang=fr&engine=espeak&text=" + urllib.parse.quote(sentence),
    )
    assert code == 400
    assert not errors, errors


def test_say_remembers_the_last_voice_used(piper_here, monkeypatch, served):
    """Eric, 2026-10-03: "Change this (Say's menu remembers your last pick)
    to remember last used. We could actually drop both preferred and
    remember toggle by just remembering". A voice picked in Say's menu is
    Say's from then on, always; an older {remember: false} is dropped."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    pg = open_eau().page
    pg.evaluate(
        "() => { localStorage.zimi_voice_prefs = JSON.stringify({ voice: 'piper', remember: false, off: [] }); }"
    )
    f = open_eau()
    assert f.evaluate(PREFS) == {"voice": "piper", "off": []}, "the old switch is gone"
    _tap(f, CARET_FR)
    f.click("[data-voices='fr'] + .menu .menu-item[data-engine='device']")
    assert f.evaluate(PREFS)["voice"] == "device"
    f.click(".hw h1")
    _tap(f, CARET_FR)
    assert [e for _n, d, e in f.evaluate(MENU_FR) if d] == ["device"]
    f.click(".hw h1")
    f.evaluate("() => { window.__said = []; }")
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__said.length > 0")
    assert f.evaluate("() => window.__said")[0][1] == "Thomas"
    # Again, and Say keeps the newer pick.
    _tap(f, CARET_FR)
    f.click("[data-voices='fr'] + .menu .menu-item[data-engine='espeak']")
    assert f.evaluate(PREFS)["voice"] == "espeak"
    # Carried by My data.
    assert '"voice":"espeak"' in f.page.evaluate(
        "() => _collectPreferences().zimi_voice_prefs"
    )
    assert not errors, errors


def test_get_more_voices_opens_the_sheet_where_it_is_tapped(piper_here, served):
    """Eric, 2026-10-03: "Get more voices tap does not open right and
    weirdly appears when I scroll up". Tapped far down Settings, the sheet
    is on screen at once, the page behind holds its place, and closing it
    gives the page back where it was."""
    open_eau, errors = piper_here
    pg = open_eau().page
    _settings_voices(pg, served)
    pg.eval_on_selector(DOOR, "b => b.scrollIntoView({ block: 'center' })")
    before = pg.evaluate("() => scrollY")
    assert before > 0
    pg.tap(DOOR)
    pg.wait_for_selector(SHEET + " .voice-foot, " + SHEET + " .ms-hint", timeout=10000)
    got = pg.evaluate(
        """() => { var p = document.querySelector('.voices-panel').getBoundingClientRect();
      return { top: p.top, bottom: p.bottom, vh: innerHeight,
        hit: !!document.elementFromPoint(innerWidth / 2, Math.min(innerHeight - 10, p.top + 20)).closest('.voices-panel') }; }"""
    )
    assert got["top"] >= 0 and got["top"] < got["vh"] and got["hit"], got
    pg.click(".voices-panel .zi-close")
    assert not pg.query_selector(SHEET)
    assert abs(pg.evaluate("() => scrollY") - before) <= 1, "the page kept its place"
    assert not errors, errors


def test_an_engine_switched_off_is_never_asked_and_the_last_stays_on(
    piper_here, monkeypatch, served
):
    """Eric, 2026-10-03: "a voices with toggles maybe for the various ones".
    Piper off: Say's menu has no Piper and no word is asked of it, French's
    default (Piper's) falling to the next voice on, by name. The last voice
    on cannot be switched off."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    pg = open_eau().page
    pg.evaluate(
        "() => { localStorage.zimi_voice_prefs = JSON.stringify({ voice: 'piper' }); }"
    )
    _settings_voices(pg, served)
    _engine(pg, "Clear")
    assert pg.evaluate(PREFS) == {"voice": "", "off": ["piper"]}
    assert pg.eval_on_selector(
        HEAR % "piper", "b => b.disabled"
    ), "an engine off is not heard"
    _shots(pg, "voices-engine-off")
    f = open_eau()
    _tap(f, CARET_FR)
    assert [e for _n, _d, e in f.evaluate(MENU_FR)] == ["espeak", "device", None]
    f.click(".hw h1")
    f.evaluate("() => { window.__played = []; }")
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__played.length > 0", timeout=10000)
    f.wait_for_timeout(500)
    played = f.evaluate("() => window.__played")
    assert "&engine=espeak&" in played[0], played
    assert not [u for u in played if "engine=piper" in u or "engine=" not in u], played
    # Basic and Device off too: Clear, the last one on, stays on.
    _settings_voices(pg, served)
    _engine(pg, "Clear")
    _engine(pg, "Basic")
    _engine(pg, "Device")
    assert [[r[0], r[2], r[3]] for r in pg.evaluate(ENGINES)] == [
        ["Clear", True, True],
        ["Basic", False, False],
        ["Device", False, False],
    ]
    _engine(pg, "Clear", force=True)
    assert pg.evaluate(PREFS)["off"] == ["espeak", "device"]
    assert pg.eval_on_selector(VOICES_WRAP + " .voice-engine input", "i => i.checked")
    assert not errors, errors


def test_the_front_offers_more_words_even_when_the_day_brought_none(served):
    """Eric, 2026-10-04: "I still want more than one word on dictionary
    homepage". A day that answered with no other words (or failed) still
    gets a shelf, filled by chance."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page()
        pg.route("**/dictionary/today?*", lambda r: r.fulfill(status=200, content_type="application/json",
                                                              body='{"day": "x", "words": [], "more": []}'))
        try:
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".more-words .cloud a[data-w]", timeout=20000)
            assert len(f.query_selector_all(".more-words .cloud a[data-w]")) >= 2
        finally:
            br.close()
